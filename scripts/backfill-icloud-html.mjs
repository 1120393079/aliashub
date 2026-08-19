import crypto from "node:crypto";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(projectRoot, ".env") });

const configuredDatabasePath = process.env.DATABASE_PATH || path.join("data", "outlook-alias-hub.db");
const databasePath = path.isAbsolute(configuredDatabasePath)
  ? configuredDatabasePath
  : path.resolve(projectRoot, configuredDatabasePath);
const sourceLimit = 10 * 1024 * 1024;
const bodyLimit = 1_000_000;
const db = new Database(databasePath, { timeout: 30_000 });
db.pragma("busy_timeout = 30000");

function decrypt(value) {
  const [version, iv, tag, encrypted] = String(value || "").split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("invalid encrypted credential");
  const key = crypto.createHash("sha256").update(String(process.env.DATA_ENCRYPTION_KEY || "")).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function uidFromGraphId(value, uidValidity) {
  const match = /^icloud:([^:]+):(\d+)$/.exec(String(value || ""));
  if (!match || match[1] !== uidValidity) return 0;
  const uid = Number(match[2]);
  return Number.isSafeInteger(uid) && uid > 0 ? uid : 0;
}

const accounts = db.prepare(`
  SELECT s.id, s.email, c.username, c.app_password_encrypted
  FROM source_accounts s
  JOIN icloud_credentials c ON c.account_id = s.id
  WHERE s.provider = 'icloud' AND s.status = 'connected'
  ORDER BY s.id
`).all();
const update = db.prepare(`
  UPDATE mail_messages
  SET body = ?, body_content_type = 'html', body_truncated = ?, updated_at = ?
  WHERE id = ? AND (body_content_type != 'html' OR body != ?)
`);

let checked = 0;
let recovered = 0;
let unavailable = 0;
const chunkSize = 75;
for (const account of accounts) {
  const client = new ImapFlow({
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    auth: { user: account.username, pass: decrypt(account.app_password_encrypted) },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    const opened = await client.mailboxOpen("INBOX", { readOnly: true });
    const uidValidity = String(opened?.uidValidity || client.mailbox?.uidValidity || "0");
    const rows = db.prepare(`
      SELECT id, graph_message_id
      FROM mail_messages
      WHERE account_id = ? AND graph_message_id LIKE 'icloud:%'
        AND lower(body_content_type) != 'html'
      ORDER BY id
    `).all(account.id);
    const rowsByUid = new Map();
    for (const row of rows) {
      const uid = uidFromGraphId(row.graph_message_id, uidValidity);
      if (uid) rowsByUid.set(uid, row);
      else unavailable += 1;
    }
    const uids = [...rowsByUid.keys()].sort((left, right) => left - right);
    for (let offset = 0; offset < uids.length; offset += chunkSize) {
      const chunk = uids.slice(offset, offset + chunkSize);
      const received = new Set();
      for await (const message of client.fetch(chunk.join(","), {
        uid: true,
        size: true,
        source: { start: 0, maxLength: sourceLimit + 1 },
      }, { uid: true })) {
        const row = rowsByUid.get(Number(message?.uid));
        if (!row || !message?.source) continue;
        received.add(Number(message.uid));
        checked += 1;
        let parsed;
        try {
          parsed = await PostalMime.parse(Buffer.from(message.source).subarray(0, sourceLimit), {
            attachmentEncoding: "base64",
            maxNestingDepth: 64,
            maxHeadersSize: 256 * 1024,
          });
        } catch {
          unavailable += 1;
          continue;
        }
        const html = String(parsed?.html || "").trim();
        if (!html) continue;
        const body = html.slice(0, bodyLimit);
        recovered += update.run(
          body,
          Number(message.size || 0) > sourceLimit || html.length > bodyLimit ? 1 : 0,
          new Date().toISOString(),
          row.id,
          body,
        ).changes;
      }
      unavailable += chunk.length - received.size;
      console.log(JSON.stringify({
        account: account.email,
        processed: Math.min(offset + chunk.length, uids.length),
        total: uids.length,
        checked,
        recovered,
        unavailable,
      }));
    }
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
}

console.log(JSON.stringify({ complete: true, accounts: accounts.length, checked, recovered, unavailable }));
db.close();
