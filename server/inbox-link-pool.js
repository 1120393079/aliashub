import crypto from "node:crypto";
import { nowIso } from "./db.js";

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const INBOX_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function serviceError(message, status = 400, code = "") {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

function parseInboxLink(value, lineNumber) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw serviceError(`第 ${lineNumber} 行取件链接无效`);
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "dispose.lol" || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw serviceError(`第 ${lineNumber} 行必须使用 https://dispose.lol/ib/... 取件链接`);
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "ib" || !INBOX_KEY_PATTERN.test(parts[1])) {
    throw serviceError(`第 ${lineNumber} 行取件链接格式无效`);
  }
  return parts[1];
}

export function maskInboxLinkKey(value) {
  const key = String(value || "");
  return key.length <= 8 ? "*".repeat(key.length) : `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export function parseInboxLinkPool(input, { maximum = 200 } = {}) {
  if (typeof input !== "string") throw serviceError("链接取件邮箱池必须是文本");
  const entries = [];
  const pairs = new Set();
  const emails = new Map();
  const inboxKeys = new Map();
  const lines = input.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].replace(/^\uFEFF/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 2) {
      throw serviceError(`第 ${lineNumber} 行格式错误，应为：邮箱 空格 取件链接`);
    }
    const email = parts[0].trim();
    if (!EMAIL_PATTERN.test(email)) throw serviceError(`第 ${lineNumber} 行邮箱格式无效`);
    const inboxKey = parseInboxLink(parts[1], lineNumber);
    const emailKey = email.toLowerCase();
    const pairKey = `${emailKey}\n${inboxKey}`;
    if (pairs.has(pairKey)) continue;
    if (emails.has(emailKey)) {
      throw serviceError(`第 ${lineNumber} 行邮箱与第 ${emails.get(emailKey)} 行重复，但取件链接不同`);
    }
    if (inboxKeys.has(inboxKey)) {
      throw serviceError(`第 ${lineNumber} 行取件链接与第 ${inboxKeys.get(inboxKey)} 行重复，但邮箱不同`);
    }
    pairs.add(pairKey);
    emails.set(emailKey, lineNumber);
    inboxKeys.set(inboxKey, lineNumber);
    entries.push({
      email,
      inboxKey,
      maskedLink: `https://dispose.lol/ib/${maskInboxLinkKey(inboxKey)}`,
    });
    if (entries.length > maximum) throw serviceError(`链接取件邮箱池单次最多 ${maximum} 条`);
  }
  if (!entries.length) {
    throw serviceError("链接取件邮箱池为空，请按“邮箱 空格 取件链接”每行填写一组");
  }
  return entries;
}

export function serializeInboxLinkEntry(entry) {
  return `${entry.email} https://dispose.lol/ib/${entry.inboxKey}`;
}

export class InboxLinkMailboxService {
  constructor({ db, encryptionKey } = {}) {
    this.db = db;
    this.encryptionKey = encryptionKey
      ? crypto.createHash("sha256").update(String(encryptionKey)).digest()
      : null;
  }

  requireEncryption() {
    if (!this.encryptionKey) {
      throw serviceError("绑定链接取件邮箱前必须配置 DATA_ENCRYPTION_KEY", 503, "INBOX_LINK_ENCRYPTION_REQUIRED");
    }
    return this.encryptionKey;
  }

  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.requireEncryption(), iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  decrypt(value) {
    const [version, iv, tag, encrypted] = String(value || "").split(".");
    if (version !== "v1" || !iv || !tag || !encrypted) {
      throw serviceError("链接取件凭据无法解密，请重新绑定", 409, "INBOX_LINK_DECRYPT_FAILED");
    }
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.requireEncryption(), Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      throw serviceError("链接取件凭据无法解密，请重新绑定", 409, "INBOX_LINK_DECRYPT_FAILED");
    }
  }

  keyHash(inboxKey) {
    return crypto.createHash("sha256").update(String(inboxKey)).digest("hex");
  }

  registrationState(email) {
    const job = this.db.prepare(`
      SELECT status FROM registration_jobs
      WHERE lower(email) = lower(?)
        AND (
          status = 'completed'
          OR (
            deleted_at IS NULL
            AND status IN ('queued', 'pending', 'claimed', 'running', 'cancel_requested')
          )
        )
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(email);
    if (!job) return "available";
    return job.status === "completed" ? "used" : "in_progress";
  }

  publicItem(row) {
    const registrationState = this.registrationState(row.email);
    return {
      id: Number(row.id),
      email: row.email,
      masked_link: `https://dispose.lol/ib/${row.inbox_key_preview}`,
      status: row.status,
      registration_state: registrationState,
      available: row.status === "active" && registrationState === "available",
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  list() {
    const items = this.db.prepare(`
      SELECT * FROM inbox_link_mailboxes ORDER BY created_at DESC, id DESC
    `).all().map((row) => this.publicItem(row));
    return {
      total: items.length,
      available: items.filter((item) => item.available).length,
      used: items.filter((item) => item.registration_state === "used").length,
      in_progress: items.filter((item) => item.registration_state === "in_progress").length,
      encryption_ready: Boolean(this.encryptionKey),
      items,
    };
  }

  import(input) {
    const entries = parseInboxLinkPool(input?.poolText);
    this.requireEncryption();
    const selectEmail = this.db.prepare("SELECT * FROM inbox_link_mailboxes WHERE lower(email) = lower(?)");
    const selectHash = this.db.prepare("SELECT * FROM inbox_link_mailboxes WHERE inbox_key_hash = ?");
    const insert = this.db.prepare(`
      INSERT INTO inbox_link_mailboxes (
        email, inbox_key_hash, inbox_key_encrypted, inbox_key_preview, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?)
    `);
    const update = this.db.prepare(`
      UPDATE inbox_link_mailboxes
      SET inbox_key_hash = ?, inbox_key_encrypted = ?, inbox_key_preview = ?, status = 'active', updated_at = ?
      WHERE id = ?
    `);
    let created = 0;
    let updated = 0;
    this.db.transaction(() => {
      for (const entry of entries) {
        const hash = this.keyHash(entry.inboxKey);
        const sameEmail = selectEmail.get(entry.email);
        const sameKey = selectHash.get(hash);
        if (sameKey && Number(sameKey.id) !== Number(sameEmail?.id || 0)) {
          throw serviceError(`取件链接已绑定到其他邮箱：${sameKey.email}`, 409, "INBOX_LINK_ALREADY_BOUND");
        }
        const encrypted = this.encrypt(entry.inboxKey);
        const preview = maskInboxLinkKey(entry.inboxKey);
        const now = nowIso();
        if (sameEmail) {
          update.run(hash, encrypted, preview, now, sameEmail.id);
          updated += 1;
        } else {
          insert.run(entry.email, hash, encrypted, preview, now, now);
          created += 1;
        }
      }
    })();
    return { created, updated, imported: entries.length, ...this.list() };
  }

  availableEntries(count) {
    const requested = Number(count);
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > 200) {
      throw serviceError("链接取件注册数量必须是 1 到 200 的整数");
    }
    const available = this.db.prepare(`
      SELECT * FROM inbox_link_mailboxes
      WHERE status = 'active'
      ORDER BY created_at, id
    `).all().filter((row) => this.registrationState(row.email) === "available");
    if (requested > available.length) {
      throw serviceError(`已绑定链接邮箱数量不足：注册数量 ${requested}，当前可用 ${available.length} 个`);
    }
    return available.slice(0, requested).map((row) => ({
      id: Number(row.id),
      email: row.email,
      inboxKey: this.decrypt(row.inbox_key_encrypted),
    }));
  }

  delete(id) {
    const mailboxId = Number(id);
    if (!Number.isSafeInteger(mailboxId) || mailboxId <= 0) throw serviceError("链接邮箱不存在", 404);
    const item = this.db.prepare("SELECT * FROM inbox_link_mailboxes WHERE id = ?").get(mailboxId);
    if (!item) throw serviceError("链接邮箱不存在", 404);
    if (this.registrationState(item.email) === "in_progress") {
      throw serviceError("这个链接邮箱正在注册，暂时不能解除绑定", 409);
    }
    const result = this.db.prepare("DELETE FROM inbox_link_mailboxes WHERE id = ?").run(mailboxId);
    return { deleted: result.changes, id: mailboxId, email: item.email };
  }
}
