import process from "node:process";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import { InboxLinkMailboxService } from "../server/inbox-link-pool.js";

dotenv.config({ path: "/opt/alias-hub/.env" });

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error("backup database path is required");
const current = new Database(process.env.DATABASE_PATH || "/var/lib/alias-hub/outlook-alias-hub.db", { timeout: 30_000 });
const source = new Database(sourcePath, { readonly: true });
const service = new InboxLinkMailboxService({ db: current, encryptionKey: process.env.DATA_ENCRYPTION_KEY });

function decrypt(value) {
  const [version, iv, tag, encrypted] = String(value || "").split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("invalid legacy inbox credential");
  const key = crypto.createHash("sha256").update(String(process.env.DATA_ENCRYPTION_KEY || "")).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

const emails = process.argv.slice(3);
const lines = [];
for (const email of emails) {
  const row = source.prepare("SELECT * FROM inbox_link_mailboxes WHERE lower(email) = lower(?)").get(email);
  if (!row) continue;
  const decrypted = decrypt(row.inbox_key_encrypted);
  const link = /^https:\/\//i.test(decrypted) ? decrypted : `https://dispose.lol/ib/${decrypted}`;
  lines.push(`${row.email} ${link}`);
}
if (!lines.length) throw new Error("no legacy inbox links found");
const result = service.import({ poolText: lines.join("\n") });
console.log(JSON.stringify({ restored: lines.length, created: result.created, updated: result.updated }));
source.close();
current.close();
