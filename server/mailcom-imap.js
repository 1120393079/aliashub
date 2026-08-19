import crypto from "node:crypto";
import { publicAccount } from "./account-service.js";
import { normalizeMailcomLoginEmail } from "./address-generator.js";
import { audit, createSourceAccount, nowIso } from "./db.js";
import { ICloudImapClient } from "./icloud-imap.js";

const MAILCOM_IMAP_HOST = "imap.mail.com";
const MAILCOM_IMAP_PORT = 993;

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
      "Mail.com IMAP 验证失败，本次未新增账号，也未保存或覆盖密码。请先用同一母号和密码登录 mail.com 网页：若网页也失败，请检查账号或密码；若网页能登录，则该账号未开通 Premium 或未启用 POP3/IMAP，无法用于自动收件",
      409,
      "MAILCOM_AUTH_FAILED",
    );
  }
  const code = String(error?.code || "").toUpperCase();
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "TIMEOUT"].includes(code)) {
    return errorWithStatus("连接 Mail.com 超时，请稍后重试", 504, "MAILCOM_IMAP_TIMEOUT");
  }
  if (["ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "ENETUNREACH", "ENOTFOUND"].includes(code)) {
    return errorWithStatus("Mail.com 暂时无法连接，请稍后重试", 503, "MAILCOM_IMAP_UNAVAILABLE");
  }
  return errorWithStatus("读取 Mail.com 邮箱失败，请稍后重试", 502, "MAILCOM_IMAP_ERROR");
}

export class MailComImapClient extends ICloudImapClient {
  constructor(options = {}) {
    super(options);
    this.imapHost = MAILCOM_IMAP_HOST;
    this.imapPort = MAILCOM_IMAP_PORT;
    this.messageProvider = "mailcom";
    this.mailDisplayName = "Mail.com";
    this.webLink = "https://navigator-lxa.mail.com/mail/";
    this.authFailureCodes = new Set([
      "MAILCOM_AUTH_FAILED",
      "MAILCOM_CREDENTIAL_DECRYPT_FAILED",
      "MAILCOM_CREDENTIAL_REQUIRED",
    ]);
  }

  mapError(error) {
    return publicImapError(error);
  }

  requireEncryptionKey() {
    if (!this.encryptionKey) {
      throw errorWithStatus(
        "连接 Mail.com 前必须在服务端设置 DATA_ENCRYPTION_KEY",
        503,
        "MAILCOM_ENCRYPTION_KEY_REQUIRED",
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
      throw errorWithStatus("Mail.com 凭据无法解密，请重新连接", 409, "MAILCOM_CREDENTIAL_DECRYPT_FAILED");
    }
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.requireEncryptionKey(), Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      throw errorWithStatus("Mail.com 凭据无法解密，请重新连接", 409, "MAILCOM_CREDENTIAL_DECRYPT_FAILED");
    }
  }

  async verifyCredentials(email, password) {
    const client = this.createClient(email, password);
    try {
      await client.connect();
      await client.mailboxOpen("INBOX", { readOnly: true });
      return email;
    } catch (error) {
      throw this.mapError(error);
    } finally {
      await this.closeClient(client);
    }
  }

  async connectAccount({ accountId, email, displayName, password } = {}) {
    this.requireEncryptionKey();
    const normalizedEmail = normalizeMailcomLoginEmail(email);
    if (!normalizedEmail) {
      throw errorWithStatus("请输入有效的 Mail.com 登录邮箱地址", 400, "INVALID_MAILCOM_EMAIL");
    }
    const suppliedPassword = typeof password === "string" ? password : "";
    if (!suppliedPassword || suppliedPassword.length > 256
      || /[\u0000-\u001f\u007f-\u009f]/.test(suppliedPassword)) {
      throw errorWithStatus("请输入有效的 Mail.com 邮箱密码", 400, "INVALID_MAILCOM_PASSWORD");
    }

    const expected = accountId
      ? this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(accountId))
      : null;
    if (accountId && !expected) throw errorWithStatus("源头邮箱不存在", 404, "ACCOUNT_NOT_FOUND");
    if (expected && expected.provider !== "mailcom") {
      throw errorWithStatus("这个源头邮箱不是 Mail.com 账号", 409, "MAILCOM_PROVIDER_MISMATCH");
    }
    if (expected && expected.email.toLowerCase() !== normalizedEmail) {
      throw errorWithStatus(`请使用 ${expected.email} 更新 Mail.com 凭据`, 409, "MAILCOM_ACCOUNT_MISMATCH");
    }
    const duplicate = this.db.prepare("SELECT * FROM source_accounts WHERE email = ? COLLATE NOCASE").get(normalizedEmail);
    if (!expected && duplicate) throw errorWithStatus("这个源头邮箱已经添加", 409, "ACCOUNT_ALREADY_EXISTS");
    if (expected && duplicate && duplicate.id !== expected.id) {
      throw errorWithStatus("这个源头邮箱已经绑定到其他账号", 409, "ACCOUNT_ALREADY_EXISTS");
    }

    const username = await this.verifyCredentials(normalizedEmail, suppliedPassword);
    let savedAccount;
    this.db.transaction(() => {
      savedAccount = expected || createSourceAccount(this.db, {
        email: normalizedEmail,
        displayName: String(displayName || "").trim() || normalizedEmail.split("@")[0],
        provider: "mailcom",
        officialLimit: 10,
      });
      const now = nowIso();
      this.db.prepare(`
        INSERT INTO mailcom_credentials
          (account_id, username, password_encrypted, credential_updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          username = excluded.username,
          password_encrypted = excluded.password_encrypted,
          credential_updated_at = excluded.credential_updated_at
      `).run(savedAccount.id, username, this.encrypt(suppliedPassword), now);
      this.db.prepare(`
        UPDATE source_accounts SET
          display_name = CASE WHEN ? != '' THEN ? ELSE display_name END,
          status = 'connected', official_limit = 10, limit_reason = '', updated_at = ?
        WHERE id = ?
      `).run(String(displayName || "").trim(), String(displayName || "").trim(), now, savedAccount.id);
      audit(this.db, savedAccount.id, "account", expected ? "更新 Mail.com 密码" : "Mail.com IMAP 连接完成", normalizedEmail, {
        auth_mode: "password",
        server: `${MAILCOM_IMAP_HOST}:${MAILCOM_IMAP_PORT}`,
      });
    })();
    savedAccount = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(savedAccount.id);
    return { status: "connected", account: publicAccount(this.db, savedAccount) };
  }

  credentials(account) {
    if (account?.provider !== "mailcom") {
      throw errorWithStatus("这个源头邮箱不是 Mail.com 账号", 409, "MAILCOM_PROVIDER_MISMATCH");
    }
    const row = this.db.prepare("SELECT * FROM mailcom_credentials WHERE account_id = ?").get(account.id);
    if (!row) throw errorWithStatus("这个邮箱还没有配置 Mail.com 密码", 409, "MAILCOM_CREDENTIAL_REQUIRED");
    return { username: row.username, password: this.decrypt(row.password_encrypted) };
  }
}

export const mailcomImapConfiguration = Object.freeze({
  host: MAILCOM_IMAP_HOST,
  port: MAILCOM_IMAP_PORT,
  secure: true,
});
