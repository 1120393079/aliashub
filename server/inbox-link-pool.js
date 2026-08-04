import crypto from "node:crypto";
import { createSourceAccount, nowIso } from "./db.js";

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DEFAULT_DISPOSE_API_BASE = "https://dispose.lol/api/inbox-link";
const MAIL_BODY_LIMIT = 120_000;
const LINK_LIMIT = 4_096;
const PUBLIC_LINK_PATHS = new Set(["ib", "inbox", "mail", "mailbox", "p", "pickup", "view"]);

function htmlToText(value) {
  return String(value || "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function senderParts(value) {
  const text = String(value || "").trim();
  const bracketed = text.match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/);
  if (!bracketed) {
    return text.includes("@")
      ? { name: "", address: text.toLowerCase() }
      : { name: text, address: "" };
  }
  return {
    name: bracketed[1].replace(/^['\"]|['\"]$/g, "").trim(),
    address: bracketed[2].toLowerCase(),
  };
}

function verificationCode(value) {
  return String(value || "").match(/(?<!#)(?<!\d)(\d{6})(?!\d)/)?.[1] || "";
}

function parseInboxLink(value, lineNumber) {
  const text = String(value || "").trim();
  if (!text || text.length > LINK_LIMIT) {
    throw Object.assign(new Error(`第 ${lineNumber} 行取件链接无效`), { status: 400 });
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw Object.assign(new Error(`第 ${lineNumber} 行取件链接无效`), { status: 400 });
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) {
    throw Object.assign(new Error(`第 ${lineNumber} 行必须使用不含登录凭据的 HTTPS 取件链接`), { status: 400 });
  }
  return parsed.toString();
}

export function maskInboxLinkKey(value) {
  const key = String(value || "");
  return key.length <= 8 ? "*".repeat(key.length) : `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export function maskInboxLink(value) {
  const text = String(value || "").trim();
  if (!/^https:\/\//i.test(text)) {
    return `https://dispose.lol/ib/${maskInboxLinkKey(text)}`;
  }
  try {
    const parsed = new URL(text);
    const masked = new URL(parsed.origin);
    masked.pathname = parsed.pathname.split("/").map((part) => {
      if (!part) return "";
      return PUBLIC_LINK_PATHS.has(part.toLowerCase()) ? part : maskInboxLinkKey(part);
    }).join("/");
    const params = new URLSearchParams();
    for (const [key, item] of parsed.searchParams) params.append(key, maskInboxLinkKey(item));
    masked.search = params.toString();
    masked.hash = parsed.hash ? `#${maskInboxLinkKey(parsed.hash.slice(1))}` : "";
    return masked.toString();
  } catch {
    return maskInboxLinkKey(text);
  }
}

function storedInboxLink(value) {
  const text = String(value || "").trim();
  return /^https:\/\//i.test(text) ? text : `https://dispose.lol/ib/${text}`;
}

export function parseInboxLinkPool(input, { maximum = 200 } = {}) {
  if (typeof input !== "string") {
    throw Object.assign(new Error("链接取件邮箱池必须是文本"), { status: 400 });
  }
  const entries = [];
  const pairs = new Set();
  const emails = new Map();
  const inboxLinks = new Map();
  const lines = input.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].replace(/^\uFEFF/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 2) {
      throw Object.assign(new Error(`第 ${lineNumber} 行格式错误，应为：邮箱 空格 取件链接`), { status: 400 });
    }
    const email = parts[0].trim();
    if (!EMAIL_PATTERN.test(email)) {
      throw Object.assign(new Error(`第 ${lineNumber} 行邮箱格式无效`), { status: 400 });
    }
    const inboxLink = parseInboxLink(parts[1], lineNumber);
    const emailKey = email.toLowerCase();
    const pairKey = `${emailKey}\n${inboxLink}`;
    if (pairs.has(pairKey)) continue;
    if (emails.has(emailKey)) {
      throw Object.assign(new Error(`第 ${lineNumber} 行邮箱与第 ${emails.get(emailKey)} 行重复，但取件链接不同`), { status: 400 });
    }
    if (inboxLinks.has(inboxLink)) {
      throw Object.assign(new Error(`第 ${lineNumber} 行取件链接与第 ${inboxLinks.get(inboxLink)} 行重复，但邮箱不同`), { status: 400 });
    }
    pairs.add(pairKey);
    emails.set(emailKey, lineNumber);
    inboxLinks.set(inboxLink, lineNumber);
    entries.push({
      email,
      inboxLink,
      inboxKey: inboxLink,
      maskedLink: maskInboxLink(inboxLink),
    });
    if (entries.length > maximum) {
      throw Object.assign(new Error(`链接取件邮箱池单次最多 ${maximum} 条`), { status: 400 });
    }
  }
  if (!entries.length) {
    throw Object.assign(new Error("链接取件邮箱池为空，请按“邮箱 空格 取件链接”每行填写一组"), { status: 400 });
  }
  return entries;
}

export function serializeInboxLinkEntry(entry) {
  return `${entry.email} ${storedInboxLink(entry.inboxLink || entry.inboxKey)}`;
}

function serviceError(message, status = 400, code = "") {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

export class InboxLinkMailboxService {
  constructor({ db, encryptionKey, fetchFn = globalThis.fetch, apiBase = DEFAULT_DISPOSE_API_BASE } = {}) {
    this.db = db;
    this.fetch = fetchFn;
    this.apiBase = String(apiBase || DEFAULT_DISPOSE_API_BASE).replace(/\/+$/, "");
    this.encryptionKey = encryptionKey
      ? crypto.createHash("sha256").update(String(encryptionKey)).digest()
      : null;
    this.reconcileSourceAccounts();
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
            AND status IN ('queued', 'pending', 'claimed', 'running', 'paused', 'cancel_requested')
          )
        )
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(email);
    if (!job) return "available";
    return job.status === "completed" ? "used" : "in_progress";
  }

  ensureSourceAccount(row) {
    if (!row) return null;
    let account = row.source_account_id
      ? this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(row.source_account_id))
      : null;
    if (account && (account.provider !== "inbox_link" || account.email.toLowerCase() !== row.email.toLowerCase())) {
      account = null;
    }
    if (!account) {
      const existing = this.db.prepare("SELECT * FROM source_accounts WHERE email = ? COLLATE NOCASE").get(row.email);
      if (existing && existing.provider !== "inbox_link") {
        throw serviceError(`${row.email} 已作为源头邮箱存在，不能重复绑定到邮件中心`, 409, "INBOX_LINK_SOURCE_CONFLICT");
      }
      account = existing || createSourceAccount(this.db, {
        email: row.email,
        displayName: "链接取件",
        provider: "inbox_link",
        officialLimit: 1,
      });
    }
    const now = nowIso();
    this.db.prepare(`
      UPDATE source_accounts
      SET provider = 'inbox_link', status = 'connected', display_name = '链接取件',
        limit_reason = '', next_retry_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, account.id);
    const primary = this.db.prepare("SELECT id FROM addresses WHERE account_id = ? AND kind = 'primary' LIMIT 1").get(account.id);
    const addressId = Number(primary?.id || 0);
    this.db.prepare("UPDATE inbox_link_mailboxes SET source_account_id = ?, updated_at = ? WHERE id = ?")
      .run(account.id, now, row.id);
    this.db.prepare(`
      UPDATE registration_jobs
      SET account_id = ?, address_id = COALESCE(address_id, ?), base_address_id = COALESCE(base_address_id, ?), updated_at = ?
      WHERE lower(email) = lower(?) AND account_id IS NULL
    `).run(account.id, addressId || null, addressId || null, now, row.email);
    return this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id);
  }

  reconcileSourceAccounts() {
    const rows = this.db.prepare("SELECT * FROM inbox_link_mailboxes ORDER BY id").all();
    if (!rows.length) return { bound: 0, skipped: 0 };
    let bound = 0;
    let skipped = 0;
    this.db.transaction(() => {
      for (const row of rows) {
        try {
          this.ensureSourceAccount(row);
          bound += 1;
        } catch (error) {
          if (error?.code !== "INBOX_LINK_SOURCE_CONFLICT") throw error;
          skipped += 1;
        }
      }
    })();
    return { bound, skipped };
  }

  publicItem(row) {
    const registrationState = this.registrationState(row.email);
    const preview = String(row.inbox_key_preview || "");
    return {
      id: Number(row.id),
      email: row.email,
      masked_link: /^https:\/\//i.test(preview) ? preview : `https://dispose.lol/ib/${preview}`,
      status: row.status,
      registration_state: registrationState,
      available: row.status === "active" && registrationState === "available",
      source_account_id: Number(row.source_account_id) || null,
      mail_center_bound: Boolean(row.source_account_id),
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
    const storedRows = this.db.prepare("SELECT * FROM inbox_link_mailboxes ORDER BY id").all();
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
        const hash = this.keyHash(entry.inboxLink);
        const sameEmail = selectEmail.get(entry.email);
        const sameLink = storedRows.find((row) => {
          try {
            return storedInboxLink(this.decrypt(row.inbox_key_encrypted)) === entry.inboxLink;
          } catch {
            return false;
          }
        });
        if (sameLink && Number(sameLink.id) !== Number(sameEmail?.id || 0)) {
          throw serviceError(`取件链接已绑定到其他邮箱：${sameLink.email}`, 409, "INBOX_LINK_ALREADY_BOUND");
        }
        const encrypted = this.encrypt(entry.inboxLink);
        const preview = entry.maskedLink;
        const now = nowIso();
        let stored;
        if (sameEmail) {
          update.run(hash, encrypted, preview, now, sameEmail.id);
          stored = selectEmail.get(entry.email);
          updated += 1;
        } else {
          const result = insert.run(entry.email, hash, encrypted, preview, now, now);
          stored = this.db.prepare("SELECT * FROM inbox_link_mailboxes WHERE id = ?").get(Number(result.lastInsertRowid));
          created += 1;
        }
        this.ensureSourceAccount(stored);
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
    return available.slice(0, requested).map((row) => {
      const account = Number(row.source_account_id)
        ? this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(row.source_account_id))
        : this.ensureSourceAccount(row);
      const address = account
        ? this.db.prepare("SELECT id FROM addresses WHERE account_id = ? AND kind = 'primary' LIMIT 1").get(account.id)
        : null;
      return {
        id: Number(row.id),
        email: row.email,
        inboxLink: storedInboxLink(this.decrypt(row.inbox_key_encrypted)),
        sourceAccountId: Number(account?.id) || null,
        sourceAddressId: Number(address?.id) || null,
      };
    });
  }

  requestUrls(row, path, params = {}) {
    const inboxLink = storedInboxLink(this.decrypt(row.inbox_key_encrypted));
    const link = new URL(inboxLink);
    const urls = [];
    const add = (value) => {
      const url = value instanceof URL ? value : new URL(value);
      url.hash = "";
      const serialized = url.toString();
      if (!urls.some((item) => item.toString() === serialized)) urls.push(url);
    };
    const segments = link.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    const hashParams = new URLSearchParams(link.hash.replace(/^#\??/, ""));
    const token = link.searchParams.get("token") || hashParams.get("token")
      || (segments[0] === "p" && segments.length >= 2 ? segments.slice(1).join("/") : "");
    if (token) {
      const publicMailbox = new URL(`/api/public/mailbox/${encodeURIComponent(token)}`, link.origin);
      if (path === "message" && params.id !== undefined) {
        publicMailbox.pathname += `/messages/${encodeURIComponent(String(params.id))}`;
      }
      add(publicMailbox);
    }
    if (segments[0] === "ib" && segments.length === 2) {
      const compatible = new URL(`/api/inbox-link/${encodeURIComponent(segments[1])}/${path}`, link.origin);
      Object.entries(params).forEach(([key, value]) => compatible.searchParams.set(key, String(value)));
      add(compatible);
    }
    if (link.hostname === "dispose.lol" && segments[0] === "ib" && segments.length === 2) {
      const legacy = new URL(`${this.apiBase}/${encodeURIComponent(segments[1])}/${path}`);
      Object.entries(params).forEach(([key, value]) => legacy.searchParams.set(key, String(value)));
      add(legacy);
    }
    const direct = new URL(link);
    Object.entries(params).forEach(([key, value]) => direct.searchParams.set(key, String(value)));
    add(direct);
    const suffix = new URL(link);
    suffix.pathname = `${suffix.pathname.replace(/\/$/, "")}/${path}`;
    Object.entries(params).forEach(([key, value]) => suffix.searchParams.set(key, String(value)));
    add(suffix);
    return urls;
  }

  async requestJson(row, path, { params } = {}) {
    if (!this.fetch) throw serviceError("链接取件服务不可用", 503, "INBOX_LINK_FETCH_UNAVAILABLE");
    const originalUrl = new URL(storedInboxLink(this.decrypt(row.inbox_key_encrypted)));
    originalUrl.hash = "";
    const originalLink = originalUrl.toString();
    let lastStatus = 0;
    let reached = false;
    for (const url of this.requestUrls(row, String(path || "").replace(/^\/+/, ""), params || {})) {
      let response;
      try {
        response = await this.fetch(url, { headers: { Accept: "application/json" } });
      } catch {
        continue;
      }
      reached = true;
      lastStatus = response.status;
      if (response.status === 410) throw serviceError("链接取件地址已过期", 409, "INBOX_LINK_EXPIRED");
      if (response.status === 429) throw serviceError("链接取件服务请求过于频繁", 429, "INBOX_LINK_RATE_LIMITED");
      if (!response.ok) continue;
      let body = "";
      try {
        body = await response.text();
        const payload = JSON.parse(body);
        if (Array.isArray(payload) && path === "messages") return { messages: payload };
        if (payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
          return payload.data;
        }
        if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload;
      } catch {
        if (path === "messages" && url.toString() === originalLink && body.trim()) {
          return {
            messages: [{
              id: `page-${crypto.createHash("sha256").update(body).digest("hex").slice(0, 24)}`,
              subject: "取件页面",
              htmlBody: body,
            }],
          };
        }
      }
    }
    if (!reached) throw serviceError("链接取件服务请求失败", 502, "INBOX_LINK_REQUEST_FAILED");
    if (lastStatus === 404) throw serviceError("链接取件地址不存在或已失效", 409, "INBOX_LINK_NOT_FOUND");
    throw serviceError("取件链接没有返回兼容的邮件数据", 502, "INBOX_LINK_INVALID_RESPONSE");
  }

  async scanInbox(account) {
    const row = this.db.prepare(`
      SELECT * FROM inbox_link_mailboxes
      WHERE source_account_id = ? AND status = 'active'
    `).get(Number(account?.id));
    if (!row) throw serviceError("这个链接取件邮箱尚未绑定", 409, "INBOX_LINK_NOT_BOUND");
    const payload = await this.requestJson(row, "messages");
    if (payload.syncOk === false) throw serviceError("链接取件服务同步邮箱失败", 502, "INBOX_LINK_SYNC_FAILED");
    const payloadAddress = payload.address || payload.email;
    if (payloadAddress && String(payloadAddress).trim().toLowerCase() !== row.email.toLowerCase()) {
      throw serviceError("取件链接返回的邮箱与绑定邮箱不一致", 409, "INBOX_LINK_ADDRESS_MISMATCH");
    }
    const summaries = Array.isArray(payload.messages) ? payload.messages.filter((item) => item && typeof item === "object").slice(0, 100) : [];
    const messages = [];
    const items = [];
    for (const summary of summaries) {
      const messageId = String(summary.id || "").trim();
      if (!messageId) continue;
      let message = summary;
      const hasBody = [summary.textBody, summary.text_body, summary.htmlBody, summary.html_body, summary.body]
        .some((value) => typeof value === "string" && value.trim());
      if (summary.hasDetail || !hasBody) {
        const detail = await this.requestJson(row, "message", { params: { id: messageId } });
        if (detail.message && typeof detail.message === "object" && !Array.isArray(detail.message)) {
          message = { ...summary, ...detail.message };
        } else if (detail.id !== undefined || detail.subject !== undefined || detail.text_body !== undefined) {
          message = { ...summary, ...detail };
        }
      }
      const subject = String(message.subject || "(无主题)");
      const textBody = message.textBody ?? message.text_body ?? message.body;
      const htmlBody = message.htmlBody ?? message.html_body;
      const rawBody = typeof textBody === "string" && textBody.trim()
        ? textBody : htmlToText(htmlBody);
      const body = String(rawBody || "").slice(0, MAIL_BODY_LIMIT);
      const preview = `${subject}\n${body}`.replace(/\s+/g, " ").trim().slice(0, 500);
      const code = verificationCode(`${subject}\n${body}`);
      const senderValue = message.from || message.sender
        || (message.sender_name && message.sender_address ? `${message.sender_name} <${message.sender_address}>` : message.sender_address);
      const sender = senderParts(senderValue);
      const recipient = String(message.to || message.recipient || row.email).trim().toLowerCase() || row.email.toLowerCase();
      const receivedValue = message.receivedAt || message.received_at || message.date;
      const receivedAt = Number.isFinite(Date.parse(receivedValue)) ? receivedValue : nowIso();
      const graphMessageId = `dispose:${messageId}`;
      messages.push({
        fingerprint: crypto.createHash("sha256").update(`${account.id}:${graphMessageId}`).digest("hex"),
        graphMessageId,
        internetMessageId: String(message.externalMessageId || message.external_message_id || ""),
        senderName: sender.name,
        senderAddress: sender.address,
        recipient,
        recipients: [recipient],
        toRecipients: [{ name: "", address: recipient }],
        ccRecipients: [],
        subject,
        preview,
        body,
        bodyContentType: "text",
        bodyTruncated: String(rawBody || "").length > MAIL_BODY_LIMIT,
        verificationCode: code,
        webLink: "",
        isRead: false,
        hasAttachments: false,
        receivedAt,
      });
      if (code) {
        items.push({
          fingerprint: crypto.createHash("sha256").update(`${account.id}:${graphMessageId}:${code}`).digest("hex"),
          code,
          sender: sender.name || sender.address || "未知发件人",
          subject,
          preview: preview.slice(0, 360),
          recipient,
          recipients: [recipient],
          receivedAt,
        });
      }
    }
    return {
      stage: "completed",
      message: `发现 ${messages.length} 封链接取件邮件，其中 ${items.length} 条验证码`,
      messages,
      items,
    };
  }

  delete(id) {
    const mailboxId = Number(id);
    if (!Number.isSafeInteger(mailboxId) || mailboxId <= 0) throw serviceError("链接邮箱不存在", 404);
    const item = this.db.prepare("SELECT * FROM inbox_link_mailboxes WHERE id = ?").get(mailboxId);
    if (!item) throw serviceError("链接邮箱不存在", 404);
    if (this.registrationState(item.email) === "in_progress") {
      throw serviceError("这个链接邮箱正在注册，暂时不能解除绑定", 409);
    }
    const result = this.bulkDelete({ ids: [mailboxId] });
    return result.items[0];
  }

  bulkDelete(input = {}) {
    const rows = this.validateBulkDelete(input);
    const removeMailbox = this.db.prepare("DELETE FROM inbox_link_mailboxes WHERE id = ?");
    const removeSource = this.db.prepare("DELETE FROM source_accounts WHERE id = ? AND provider = 'inbox_link'");
    let deleted = 0;
    this.db.transaction(() => {
      for (const row of rows) {
        deleted += removeMailbox.run(row.id).changes;
        const sourceAccountId = Number(row.source_account_id) || 0;
        if (sourceAccountId) removeSource.run(sourceAccountId);
      }
    })();
    return {
      deleted,
      items: rows.map((row) => ({
        deleted: 1,
        id: Number(row.id),
        email: row.email,
        source_account_id: Number(row.source_account_id) || null,
      })),
    };
  }

  validateBulkDelete(input = {}) {
    if (!Array.isArray(input.ids)) throw serviceError("请选择要解除绑定的链接邮箱", 400);
    const ids = [...new Set(input.ids.map(Number))];
    if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw serviceError("请选择有效的链接邮箱", 400);
    }
    if (ids.length > 500) throw serviceError("单次最多解除绑定 500 个链接邮箱", 400);
    const rows = this.db.prepare(`
      SELECT * FROM inbox_link_mailboxes
      WHERE id IN (${ids.map(() => "?").join(",")})
      ORDER BY id
    `).all(...ids);
    if (rows.length !== ids.length) throw serviceError("部分链接邮箱不存在，请刷新列表后重试", 409);
    const blocked = rows.find((row) => this.registrationState(row.email) === "in_progress");
    if (blocked) throw serviceError(`${blocked.email} 正在注册，暂时不能解除绑定`, 409);
    return rows;
  }
}
