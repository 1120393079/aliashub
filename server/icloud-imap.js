import crypto from "node:crypto";
import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";
import { publicAccount } from "./account-service.js";
import { codeFromText, normalizeEmail, normalizeIcloudEmail } from "./address-generator.js";
import { audit, createSourceAccount, nowIso } from "./db.js";

const ICLOUD_IMAP_HOST = "imap.mail.me.com";
const ICLOUD_IMAP_PORT = 993;
const SCAN_OVERLAP_MS = 10 * 60_000;
const INITIAL_SCAN_DAYS = 14;
const MESSAGE_LIMIT = 75;
const SOURCE_LIMIT = 1024 * 1024;
const MAIL_BODY_LIMIT = 1_000_000;

function errorWithStatus(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function isAuthenticationError(error) {
  const code = String(error?.serverResponseCode || error?.code || "").toUpperCase();
  return Boolean(error?.authenticationFailed)
    || ["AUTHENTICATIONFAILED", "AUTHORIZATIONFAILED", "INVALIDCREDENTIALS"].includes(code);
}

function publicImapError(error) {
  if (isAuthenticationError(error)) {
    return errorWithStatus(
      "iCloud 验证失败，请确认邮箱和 App 专用密码是否正确",
      409,
      "ICLOUD_AUTH_FAILED",
    );
  }
  const code = String(error?.code || "").toUpperCase();
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "TIMEOUT"].includes(code)) {
    return errorWithStatus("连接 iCloud Mail 超时，请稍后重试", 504, "ICLOUD_IMAP_TIMEOUT");
  }
  if (["ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "ENETUNREACH", "ENOTFOUND"].includes(code)) {
    return errorWithStatus("iCloud Mail 暂时无法连接，请稍后重试", 503, "ICLOUD_IMAP_UNAVAILABLE");
  }
  return errorWithStatus("读取 iCloud Mail 失败，请稍后重试", 502, "ICLOUD_IMAP_ERROR");
}

function htmlToText(value) {
  return String(value || "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeHtml(value) {
  return /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(String(value || ""));
}

function mailboxList(value) {
  const output = [];
  const visit = (item) => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item.group)) return item.group.forEach(visit);
    const address = normalizeEmail(item.address);
    if (!address || output.some((entry) => entry.address === address)) return;
    output.push({ name: String(item.name || "").trim(), address });
  };
  (Array.isArray(value) ? value : [value]).forEach(visit);
  return output;
}

function headerValue(parsed, name) {
  const key = String(name || "").toLowerCase();
  return String((parsed?.headers || []).find((item) => item?.key === key)?.value || "").trim();
}

function parsedDate(...values) {
  for (const value of values) {
    const timestamp = Date.parse(value || "");
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return nowIso();
}

function candidateUsernames(email) {
  const local = String(email).split("@")[0];
  return [...new Set([local, email].filter(Boolean))];
}

export class ICloudImapClient {
  constructor({ db, encryptionKey, imapFactory, parseMessage } = {}) {
    this.db = db;
    this.imapHost = ICLOUD_IMAP_HOST;
    this.imapPort = ICLOUD_IMAP_PORT;
    this.messageProvider = "icloud";
    this.mailDisplayName = "iCloud";
    this.webLink = "https://www.icloud.com/mail/";
    this.authFailureCodes = new Set(["ICLOUD_AUTH_FAILED", "ICLOUD_CREDENTIAL_DECRYPT_FAILED"]);
    this.imapFactory = imapFactory || ((config) => new ImapFlow(config));
    this.parseMessage = parseMessage || ((source) => PostalMime.parse(source, {
      attachmentEncoding: "base64",
      maxNestingDepth: 64,
      maxHeadersSize: 256 * 1024,
    }));
    const configuredEncryptionKey = String(
      encryptionKey === undefined ? process.env.DATA_ENCRYPTION_KEY || "" : encryptionKey || "",
    ).trim();
    this.encryptionKey = configuredEncryptionKey
      ? crypto.createHash("sha256").update(configuredEncryptionKey).digest()
      : null;
  }

  mapError(error) {
    return publicImapError(error);
  }

  requireEncryptionKey() {
    if (!this.encryptionKey) {
      throw errorWithStatus(
        "连接 iCloud Mail 前必须在服务端设置 DATA_ENCRYPTION_KEY",
        503,
        "ICLOUD_ENCRYPTION_KEY_REQUIRED",
      );
    }
    return this.encryptionKey;
  }

  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.requireEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  decrypt(value) {
    const [version, iv, tag, encrypted] = String(value || "").split(".");
    if (version !== "v1" || !iv || !tag || !encrypted) {
      throw errorWithStatus("iCloud 凭据无法解密，请重新连接", 409, "ICLOUD_CREDENTIAL_DECRYPT_FAILED");
    }
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.requireEncryptionKey(), Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      throw errorWithStatus("iCloud 凭据无法解密，请重新连接", 409, "ICLOUD_CREDENTIAL_DECRYPT_FAILED");
    }
  }

  createClient(username, password) {
    const client = this.imapFactory({
      host: this.imapHost,
      port: this.imapPort,
      secure: true,
      auth: { user: username, pass: password },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      tls: {
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
        servername: this.imapHost,
      },
    });
    // ImapFlow also reports socket failures through EventEmitter. Keep an
    // error listener attached so a disconnected mailbox cannot terminate Node.
    client?.on?.("error", () => {});
    return client;
  }

  async closeClient(client) {
    if (!client) return;
    try {
      if (client.usable && typeof client.logout === "function") await client.logout();
      else if (typeof client.close === "function") client.close();
    } catch {
      try { client.close?.(); } catch { /* Best-effort cleanup. */ }
    }
  }

  async verifyCredentials(email, password) {
    let lastAuthenticationError = null;
    for (const username of candidateUsernames(email)) {
      const client = this.createClient(username, password);
      try {
        await client.connect();
        await client.mailboxOpen("INBOX", { readOnly: true });
        return username;
      } catch (error) {
        if (!isAuthenticationError(error)) throw this.mapError(error);
        lastAuthenticationError = error;
      } finally {
        await this.closeClient(client);
      }
    }
    throw this.mapError(lastAuthenticationError);
  }

  async connectAccount({ accountId, email, displayName, appSpecificPassword } = {}) {
    this.requireEncryptionKey();
    const normalizedEmail = normalizeIcloudEmail(email);
    if (!normalizedEmail) {
      throw errorWithStatus("请输入有效的 Apple 账户邮箱", 400, "INVALID_ICLOUD_EMAIL");
    }
    const password = String(appSpecificPassword || "").replace(/\s+/g, "");
    if (password.length < 8 || password.length > 128) {
      throw errorWithStatus("请输入 Apple 账户生成的 App 专用密码", 400, "INVALID_ICLOUD_APP_PASSWORD");
    }

    const expected = accountId
      ? this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(accountId))
      : null;
    if (accountId && !expected) throw errorWithStatus("源头邮箱不存在", 404, "ACCOUNT_NOT_FOUND");
    if (expected && expected.provider !== "icloud") {
      throw errorWithStatus("这个源头邮箱不是 iCloud 账号", 409, "OAUTH_PROVIDER_MISMATCH");
    }
    if (expected && expected.email.toLowerCase() !== normalizedEmail) {
      throw errorWithStatus(`请使用 ${expected.email} 更新 iCloud 凭据`, 409, "ICLOUD_ACCOUNT_MISMATCH");
    }
    const duplicate = this.db.prepare("SELECT * FROM source_accounts WHERE email = ? COLLATE NOCASE").get(normalizedEmail);
    if (!expected && duplicate) throw errorWithStatus("这个源头邮箱已经添加", 409, "ACCOUNT_ALREADY_EXISTS");
    if (expected && duplicate && duplicate.id !== expected.id) {
      throw errorWithStatus("这个源头邮箱已经绑定到其他账号", 409, "ACCOUNT_ALREADY_EXISTS");
    }

    const username = await this.verifyCredentials(normalizedEmail, password);
    let savedAccount;
    this.db.transaction(() => {
      savedAccount = expected || createSourceAccount(this.db, {
        email: normalizedEmail,
        displayName: String(displayName || "").trim() || normalizedEmail.split("@")[0],
        provider: "icloud",
        officialLimit: 1,
      });
      const now = nowIso();
      this.db.prepare(`
        INSERT INTO icloud_credentials
          (account_id, username, app_password_encrypted, credential_updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          username = excluded.username,
          app_password_encrypted = excluded.app_password_encrypted,
          credential_updated_at = excluded.credential_updated_at
      `).run(savedAccount.id, username, this.encrypt(password), now);
      this.db.prepare(`
        UPDATE source_accounts SET
          display_name = CASE WHEN ? != '' THEN ? ELSE display_name END,
          status = 'connected', limit_reason = '', updated_at = ?
        WHERE id = ?
      `).run(String(displayName || "").trim(), String(displayName || "").trim(), now, savedAccount.id);
      audit(this.db, savedAccount.id, "account", expected ? "更新 iCloud App 专用密码" : "iCloud IMAP 连接完成", normalizedEmail, {
        auth_mode: "app_password",
        server: `${ICLOUD_IMAP_HOST}:${ICLOUD_IMAP_PORT}`,
      });
    })();
    savedAccount = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(savedAccount.id);
    return { status: "connected", account: publicAccount(this.db, savedAccount) };
  }

  credentials(account) {
    if (account?.provider !== "icloud") {
      throw errorWithStatus("这个源头邮箱不是 iCloud 账号", 409, "OAUTH_PROVIDER_MISMATCH");
    }
    const row = this.db.prepare("SELECT * FROM icloud_credentials WHERE account_id = ?").get(account.id);
    if (!row) throw errorWithStatus("这个邮箱还没有配置 iCloud App 专用密码", 409, "ICLOUD_CREDENTIAL_REQUIRED");
    return { username: row.username, password: this.decrypt(row.app_password_encrypted) };
  }

  async parseFetchedMessage(account, message, uidValidity) {
    const uid = Number(message?.uid);
    if (!Number.isSafeInteger(uid) || uid <= 0 || !message?.source) return null;
    const source = Buffer.from(message.source);
    const sourceTruncated = Number(message.size || 0) > SOURCE_LIMIT || source.length > SOURCE_LIMIT;
    const parseSource = source.subarray(0, SOURCE_LIMIT);
    let parsed;
    try {
      parsed = await this.parseMessage(parseSource);
    } catch {
      parsed = {};
    }
    const envelope = message.envelope || {};
    const from = mailboxList(parsed.from || envelope.from)[0] || { name: "", address: "" };
    const toRecipients = mailboxList(parsed.to || envelope.to);
    const ccRecipients = mailboxList(parsed.cc || envelope.cc);
    const deliveredRecipients = [
      parsed.deliveredTo,
      headerValue(parsed, "delivered-to"),
      headerValue(parsed, "x-original-to"),
      headerValue(parsed, "envelope-to"),
      headerValue(parsed, "x-envelope-to"),
    ]
      .map(normalizeEmail)
      .filter(Boolean);
    const recipients = [...new Set([
      ...deliveredRecipients,
      ...toRecipients.map((item) => item.address),
      ...ccRecipients.map((item) => item.address),
    ])];
    const recipient = recipients[0] || account.email;
    const subject = String(parsed.subject || envelope.subject || "(无主题)").trim() || "(无主题)";
    const parsedText = String(parsed.text || "").trim();
    const parsedHtml = String(parsed.html || "").trim();
    const htmlBody = parsedHtml || (looksLikeHtml(parsedText) ? parsedText : "");
    const fallbackBody = parseSource.toString("utf8");
    const rawBody = htmlBody || parsedText || fallbackBody;
    const readableBody = htmlBody ? htmlToText(htmlBody) : (parsedText || fallbackBody);
    const body = rawBody.slice(0, MAIL_BODY_LIMIT);
    const preview = readableBody.replace(/\s+/g, " ").trim().slice(0, 500);
    const code = codeFromText(`${subject}\n${preview}\n${readableBody}`);
    const graphMessageId = `${this.messageProvider}:${uidValidity}:${uid}`;
    const receivedAt = parsedDate(parsed.date, message.internalDate, envelope.date);
    const isRead = message.flags instanceof Set
      ? message.flags.has("\\Seen")
      : (Array.isArray(message.flags) && message.flags.includes("\\Seen"));
    return {
      message: {
        fingerprint: crypto.createHash("sha256").update(`${account.id}:${graphMessageId}`).digest("hex"),
        graphMessageId,
        internetMessageId: String(parsed.messageId || envelope.messageId || ""),
        senderName: from.name,
        senderAddress: from.address,
        toRecipients,
        ccRecipients,
        recipients,
        recipient,
        subject,
        preview,
        body,
        bodyContentType: htmlBody ? "html" : "text",
        bodyTruncated: sourceTruncated || rawBody.length > MAIL_BODY_LIMIT,
        verificationCode: code,
        webLink: this.webLink,
        isRead,
        hasAttachments: Boolean(parsed.attachments?.length),
        receivedAt,
      },
      code: code ? {
        fingerprint: crypto.createHash("sha256").update(`${account.id}:${graphMessageId}:${code}`).digest("hex"),
        code,
        sender: from.name || from.address || "未知发件人",
        subject,
        preview: preview.slice(0, 360),
        recipient,
        recipients,
        receivedAt,
      } : null,
    };
  }

  async scanInbox(account) {
    let client;
    try {
      const credentials = this.credentials(account);
      client = this.createClient(credentials.username, credentials.password);
      await client.connect();
      const opened = await client.mailboxOpen("INBOX", { readOnly: true });
      const uidValidity = String(opened?.uidValidity || client.mailbox?.uidValidity || "0");
      const lastScan = Date.parse(account.last_inbox_scan_at || "");
      const since = new Date(Number.isFinite(lastScan)
        ? Math.max(0, lastScan - SCAN_OVERLAP_MS)
        : Date.now() - INITIAL_SCAN_DAYS * 24 * 60 * 60_000);
      const found = await client.search({ since }, { uid: true });
      const uids = [...new Set((Array.isArray(found) ? found : [])
        .map(Number)
        .filter((uid) => Number.isSafeInteger(uid) && uid > 0))]
        .sort((left, right) => left - right)
        .slice(-MESSAGE_LIMIT);
      if (!uids.length) return { stage: "completed", message: `${this.mailDisplayName} 收件箱没有新邮件`, messages: [], items: [] };

      const graphIds = uids.map((uid) => `${this.messageProvider}:${uidValidity}:${uid}`);
      const known = new Set(this.db.prepare(`
        SELECT graph_message_id FROM mail_messages
        WHERE account_id = ? AND graph_message_id IN (${graphIds.map(() => "?").join(",")})
      `).all(account.id, ...graphIds).map((row) => row.graph_message_id));
      const messages = [];
      const items = [];
      for (const uid of uids) {
        if (known.has(`${this.messageProvider}:${uidValidity}:${uid}`)) continue;
        const message = await client.fetchOne(uid, {
          uid: true,
          flags: true,
          envelope: true,
          internalDate: true,
          size: true,
          source: { start: 0, maxLength: SOURCE_LIMIT + 1 },
        }, { uid: true });
        const mapped = await this.parseFetchedMessage(account, message, uidValidity);
        if (!mapped) continue;
        messages.push(mapped.message);
        if (mapped.code) items.push(mapped.code);
      }
      return {
        stage: "completed",
        message: `发现 ${messages.length} 封 ${this.mailDisplayName} 邮件，其中 ${items.length} 条验证码`,
        messages,
        items,
      };
    } catch (error) {
      const publicError = error?.status ? error : this.mapError(error);
      if (this.authFailureCodes.has(publicError.code)) {
        this.db.prepare("UPDATE source_accounts SET status = 'action_required', updated_at = ? WHERE id = ?")
          .run(nowIso(), account.id);
      }
      throw publicError;
    } finally {
      await this.closeClient(client);
    }
  }
}

export const icloudImapConfiguration = Object.freeze({
  host: ICLOUD_IMAP_HOST,
  port: ICLOUD_IMAP_PORT,
  secure: true,
});
