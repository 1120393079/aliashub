import process from "node:process";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import { persistInboxScanResult } from "../server/account-service.js";
import { InboxLinkMailboxService } from "../server/inbox-link-pool.js";

dotenv.config({ path: "/opt/alias-hub/.env" });

const db = new Database(process.env.DATABASE_PATH || "/var/lib/alias-hub/outlook-alias-hub.db", { timeout: 30_000 });
db.pragma("busy_timeout = 30000");
const service = new InboxLinkMailboxService({
  db,
  encryptionKey: process.env.DATA_ENCRYPTION_KEY,
});
const requested = process.argv.slice(2).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0);
const accounts = db.prepare(`
  SELECT * FROM source_accounts
  WHERE provider = 'inbox_link' AND status = 'connected'
    ${requested.length ? `AND id IN (${requested.map(() => "?").join(",")})` : ""}
  ORDER BY id
`).all(...requested);

let scanned = 0;
let messages = 0;
let html = 0;
const failed = [];
for (const account of accounts) {
  try {
    const result = await service.scanInbox(account);
    const persisted = persistInboxScanResult(db, account, result);
    const found = Array.isArray(result.messages) ? result.messages : [];
    scanned += 1;
    messages += found.length;
    html += found.filter((item) => item.bodyContentType === "html").length;
    console.log(JSON.stringify({
      account_id: account.id,
      email: account.email,
      messages: found.length,
      html: found.filter((item) => item.bodyContentType === "html").length,
      persisted: persisted.messages,
    }));
  } catch (error) {
    failed.push({ account_id: account.id, email: account.email, error: error.message, code: error.code || "" });
    console.log(JSON.stringify(failed.at(-1)));
  }
}

console.log(JSON.stringify({ complete: true, scanned, messages, html, failed }));
db.close();
