import crypto from "node:crypto";
import { publicAccount } from "./account-service.js";
import {
  NETEASE_ALIAS_STRATEGY,
  normalizeNeteaseAliasEmail,
  normalizeNeteaseEmail,
} from "./address-generator.js";
import { audit, createSourceAccount, nowIso } from "./db.js";
import { ICloudImapClient } from "./icloud-imap.js";
import { importNeteaseAliases } from "./netease-aliases.js";

const NETEASE_IMAP_PORT = 993;
const NETEASE_SCAN_OVERLAP_MS = 10 * 60_000;
const NETEASE_INITIAL_SCAN_DAYS = 14;
const NETEASE_MESSAGE_LIMIT = 75;
const NETEASE_MAX_SCAN_FOLDERS = 128;
const HOST_BY_DOMAIN = Object.freeze({
  "163.com": "imap.163.com",
  "126.com": "imap.126.com",
  "yeah.net": "imap.yeah.net",
});

function errorWithStatus(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function isAuthenticationError(error) {
  const code = String(error?.serverResponseCode || error?.code || "").toUpperCase();
  return Boolean(error?.authenticationFailed)
    || ["AUTHENTICATIONFAILED", "AUTHORIZATIONFAILED", "INVALIDCREDENTIALS", "EAUTH", "ELOGIN"].includes(code);
}

function publicImapError(error) {
  if (isAuthenticationError(error)) {
    return errorWithStatus(
      "网易邮箱 IMAP 验证失败，请确认母号、客户端授权码以及 IMAP/SMTP 服务是否已开启",
      409,
      "NETEASE_AUTH_FAILED",
    );
  }
  const code = String(error?.code || "").toUpperCase();
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "TIMEOUT"].includes(code)) {
    return errorWithStatus("连接网易邮箱超时，请稍后重试", 504, "NETEASE_IMAP_TIMEOUT");
  }
  if (["ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "ENETUNREACH", "ENOTFOUND"].includes(code)) {
    return errorWithStatus("网易邮箱暂时无法连接，请稍后重试", 503, "NETEASE_IMAP_UNAVAILABLE");
  }
  return errorWithStatus("读取网易邮箱失败，请稍后重试", 502, "NETEASE_IMAP_ERROR");
}

function mailboxFlags(entry) {
  const flags = entry?.flags;
  if (flags instanceof Set) return [...flags].map((value) => String(value || ""));
  if (Array.isArray(flags)) return flags.map((value) => String(value || ""));
  return [];
}

function mailboxGraphSuffix(path) {
  return crypto.createHash("sha256").update(String(path), "utf8").digest("hex").slice(0, 32);
}

function normalizedMessageId(value) {
  return String(value || "").trim().toLowerCase();
}

function isRecoverableMailboxError(error) {
  if (isAuthenticationError(error)) return false;
  const code = String(error?.serverResponseCode || error?.code || "").toUpperCase();
  if (["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "ENOTFOUND",
    "ETIMEDOUT", "ESOCKETTIMEDOUT", "TIMEOUT"].includes(code)) return false;
  if (["NONEXISTENT", "NOMAILBOX", "MAILBOXNOTFOUND"].includes(code)) return true;
  return /(?:no such mailbox|mailbox[^\n]*(?:not found|does not exist))/i.test(
    String(error?.message || ""),
  );
}

function normalizeAliases(values) {
  if (values === undefined) return null;
  if (!Array.isArray(values)) {
    throw errorWithStatus("网易替身邮箱必须是数组", 400, "INVALID_NETEASE_ALIASES");
  }
  if (values.length > 5_000) {
    throw errorWithStatus("单次最多提交 5000 个网易替身邮箱", 400, "NETEASE_ALIAS_LIMIT");
  }
  const invalid = values
    .map((value) => String(value || "").trim())
    .find((value) => value && !normalizeNeteaseAliasEmail(value));
  if (invalid) {
    throw errorWithStatus(
      `网易替身邮箱必须使用 @aka.yeah.net 后缀：${invalid}`,
      400,
      "INVALID_NETEASE_ALIAS",
    );
  }
  return [...new Set(values.map(normalizeNeteaseAliasEmail).filter(Boolean))];
}

export function neteaseImapHostForEmail(value) {
  const email = normalizeNeteaseEmail(value);
  return email ? HOST_BY_DOMAIN[email.split("@")[1]] || "" : "";
}

export function neteaseImapConfiguration(value) {
  const host = neteaseImapHostForEmail(value);
  if (!host) {
    throw errorWithStatus(
      "网易母号仅支持 @163.com、@126.com 或 @yeah.net",
      400,
      "INVALID_NETEASE_EMAIL",
    );
  }
  return Object.freeze({ host, port: NETEASE_IMAP_PORT, secure: true });
}

export class NeteaseImapClient extends ICloudImapClient {
  constructor(options = {}) {
    super(options);
    this.imapPort = NETEASE_IMAP_PORT;
    this.messageProvider = "netease";
    this.mailDisplayName = "网易邮箱";
    this.webLink = "https://mail.163.com/";
    this.authFailureCodes = new Set([
      "NETEASE_AUTH_FAILED",
      "NETEASE_CREDENTIAL_DECRYPT_FAILED",
      "NETEASE_CREDENTIAL_REQUIRED",
    ]);
  }

  mapError(error) {
    return publicImapError(error);
  }

  requireEncryptionKey() {
    if (!this.encryptionKey) {
      throw errorWithStatus(
        "连接网易邮箱前必须在服务端设置 DATA_ENCRYPTION_KEY",
        503,
        "NETEASE_ENCRYPTION_KEY_REQUIRED",
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
      throw errorWithStatus(
        "网易邮箱凭据无法解密，请重新连接",
        409,
        "NETEASE_CREDENTIAL_DECRYPT_FAILED",
      );
    }
    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.requireEncryptionKey(),
        Buffer.from(iv, "base64url"),
      );
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch (error) {
      if (error?.code === "NETEASE_ENCRYPTION_KEY_REQUIRED") throw error;
      throw errorWithStatus(
        "网易邮箱凭据无法解密，请重新连接",
        409,
        "NETEASE_CREDENTIAL_DECRYPT_FAILED",
      );
    }
  }

  createClient(username, authCode) {
    const { host, port } = neteaseImapConfiguration(username);
    const client = this.imapFactory({
      host,
      port,
      secure: true,
      auth: { user: username, pass: authCode },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      tls: {
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
        servername: host,
      },
    });
    client?.on?.("error", () => {});
    return client;
  }

  async verifyCredentials(email, authCode) {
    const client = this.createClient(email, authCode);
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

  async connectAccount({
    accountId,
    email,
    displayName,
    authCode,
    aliases,
  } = {}) {
    this.requireEncryptionKey();
    const normalizedEmail = normalizeNeteaseEmail(email);
    if (!normalizedEmail) {
      throw errorWithStatus(
        "网易母号仅支持 @163.com、@126.com 或 @yeah.net",
        400,
        "INVALID_NETEASE_EMAIL",
      );
    }
    const suppliedAuthCode = typeof authCode === "string" ? authCode.trim() : "";
    if (!suppliedAuthCode || suppliedAuthCode.length > 256
      || /[\u0000-\u001f\u007f-\u009f]/.test(suppliedAuthCode)) {
      throw errorWithStatus("请输入有效的网易邮箱客户端授权码", 400, "INVALID_NETEASE_AUTH_CODE");
    }
    const normalizedAliases = normalizeAliases(aliases);

    const expected = accountId
      ? this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(accountId))
      : null;
    if (accountId && !expected) throw errorWithStatus("源头邮箱不存在", 404, "ACCOUNT_NOT_FOUND");
    if (expected && expected.provider !== "netease") {
      throw errorWithStatus("这个源头邮箱不是网易邮箱账号", 409, "NETEASE_PROVIDER_MISMATCH");
    }
    if (expected && expected.email.toLowerCase() !== normalizedEmail) {
      throw errorWithStatus(
        `请使用 ${expected.email} 更新网易邮箱凭据`,
        409,
        "NETEASE_ACCOUNT_MISMATCH",
      );
    }
    const duplicate = this.db.prepare(
      "SELECT * FROM source_accounts WHERE email = ? COLLATE NOCASE",
    ).get(normalizedEmail);
    if (!expected && duplicate) {
      throw errorWithStatus("这个源头邮箱已经添加", 409, "ACCOUNT_ALREADY_EXISTS");
    }
    if (expected && duplicate && duplicate.id !== expected.id) {
      throw errorWithStatus("这个源头邮箱已经绑定到其他账号", 409, "ACCOUNT_ALREADY_EXISTS");
    }

    const username = await this.verifyCredentials(normalizedEmail, suppliedAuthCode);
    let savedAccount;
    let activeAddresses = [];
    this.db.transaction(() => {
      savedAccount = expected || createSourceAccount(this.db, {
        email: normalizedEmail,
        displayName: String(displayName || "").trim() || normalizedEmail.split("@")[0],
        provider: "netease",
        officialLimit: Math.max(1, (normalizedAliases?.length || 0) + 1),
      });
      const now = nowIso();
      this.db.prepare(`
        INSERT INTO netease_credentials
          (account_id, username, auth_code_encrypted, credential_updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          username = excluded.username,
          auth_code_encrypted = excluded.auth_code_encrypted,
          credential_updated_at = excluded.credential_updated_at
      `).run(savedAccount.id, username, this.encrypt(suppliedAuthCode), now);
      this.db.prepare(`
        UPDATE source_accounts SET
          display_name = CASE WHEN ? != '' THEN ? ELSE display_name END,
          status = 'connected', limit_reason = '', updated_at = ?
        WHERE id = ?
      `).run(String(displayName || "").trim(), String(displayName || "").trim(), now, savedAccount.id);
      if (normalizedAliases?.length) {
        // Connecting or re-importing credentials is additive. Full replacement
        // goes through the dedicated alias endpoint, which performs removal
        // guards for active registrations and pickup inventory first.
        importNeteaseAliases(
          this.db,
          savedAccount,
          normalizedAliases,
          { replace: false, purpose: "连接网易母号时导入" },
        );
      }
      audit(
        this.db,
        savedAccount.id,
        "account",
        expected ? "更新网易邮箱客户端授权码" : "网易邮箱 IMAP 连接完成",
        normalizedEmail,
        {
          auth_mode: "imap_auth_code",
          server: `${neteaseImapHostForEmail(normalizedEmail)}:${NETEASE_IMAP_PORT}`,
          alias_count: normalizedAliases?.length || 0,
        },
      );
    })();

    savedAccount = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(savedAccount.id);
    activeAddresses = this.db.prepare(`
      SELECT * FROM addresses
      WHERE account_id = ? AND kind IN ('primary', 'official') AND status = 'active'
      ORDER BY kind = 'primary' DESC, created_at
    `).all(savedAccount.id);
    return {
      status: "connected",
      account: publicAccount(this.db, savedAccount),
      aliases: activeAddresses
        .filter((row) => row.strategy === NETEASE_ALIAS_STRATEGY)
        .map((row) => row.address),
    };
  }

  scanMailboxes(list) {
    const entries = Array.isArray(list) ? list : [];
    const seen = new Set();
    const mailboxes = [];
    let inboxAssigned = false;
    const add = (path, entry = {}) => {
      const mailboxPath = String(path ?? "");
      if (!mailboxPath) return;
      const flags = mailboxFlags(entry);
      if (flags.some((flag) => /\\(?:noselect|nonexistent)/i.test(flag))) return;
      // IMAP mailbox paths are case-sensitive except for the reserved
      // INBOX name. Preserve custom-folder casing so `Foo` and `foo` are not
      // accidentally collapsed.
      const key = mailboxPath.toLowerCase() === "inbox" ? "inbox" : mailboxPath;
      if (seen.has(key)) return;
      seen.add(key);
      const specialUse = String(entry.specialUse || "");
      const specialValues = [specialUse, ...flags].map((value) => value.toLowerCase());
      if (specialValues.some((value) => ["\\all", "\\flagged", "\\sent", "\\drafts"].includes(value))) return;
      const isInbox = key === "inbox" || (!inboxAssigned && /\\inbox/i.test(specialUse));
      if (isInbox) inboxAssigned = true;
      mailboxes.push({
        path: mailboxPath,
        isInbox,
      });
    };

    // Keep INBOX first for compatibility with existing message ids. The
    // remaining folders use their own UIDVALIDITY/path scope below.
    add("INBOX", { specialUse: "\\Inbox" });
    for (const entry of entries) add(entry?.path || entry?.pathAsListed, entry);
    return mailboxes.slice(0, NETEASE_MAX_SCAN_FOLDERS);
  }

  scanErrorMessage(error) {
    try {
      const mapped = error?.status ? error : this.mapError(error);
      return String(mapped?.message || "读取网易邮箱失败，请稍后重试").slice(0, 180);
    } catch {
      return "读取网易邮箱失败，请稍后重试";
    }
  }

  async scanInbox(account) {
    let client;
    try {
      const credentials = this.credentials(account);
      client = this.createClient(credentials.username, credentials.password);
      await client.connect();

      // ImapFlow exposes LIST. Test doubles/older adapters without LIST use
      // the safe legacy INBOX-only fallback; a real LIST failure must bubble
      // up instead of advancing the scan watermark with a partial result.
      const listed = typeof client.list === "function" ? await client.list() : [];
      const mailboxes = this.scanMailboxes(listed);
      const lastScan = Date.parse(account.last_inbox_scan_at || "");
      const since = new Date(Number.isFinite(lastScan)
        ? Math.max(0, lastScan - NETEASE_SCAN_OVERLAP_MS)
        : Date.now() - NETEASE_INITIAL_SCAN_DAYS * 24 * 60 * 60_000);
      // Do not reuse the account cursor for custom folders: before this
      // change only INBOX advanced the cursor, so a message already sitting
      // in a user folder could otherwise be skipped forever. Keep the
      // backfill bounded to the same recent window as a first scan.
      const folderSince = new Date(Date.now() - NETEASE_INITIAL_SCAN_DAYS * 24 * 60 * 60_000);

      // Load existing ids once. UID values are only unique inside one
      // mailbox, so custom-folder ids are scoped with a path hash below.
      const knownRows = this.db.prepare(
        "SELECT graph_message_id, internet_message_id FROM mail_messages WHERE account_id = ?",
      ).all(account.id);
      const knownGraphIds = new Set(knownRows.map((row) => String(row.graph_message_id || "")));
      const knownInternetIds = new Set(knownRows
        .map((row) => normalizedMessageId(row.internet_message_id))
        .filter(Boolean));
      const seenInternetIds = new Set();
      const seenSourceHashes = new Set();
      const messages = [];
      const items = [];
      const folderErrors = [];
      let openedCount = 0;

      for (const mailbox of mailboxes) {
        try {
          const opened = await client.mailboxOpen(mailbox.path, { readOnly: true });
          openedCount += 1;
          const uidValidity = String(opened?.uidValidity || client.mailbox?.uidValidity || "0");
          // The account-level scan timestamp is sufficient for INBOX. For
          // user folders, use a bounded backfill window so a message that
          // arrived before the previous INBOX-only scan (for example in
          // “接收账单”) is recovered without downloading an unbounded UID set.
          const found = await client.search(
            mailbox.isInbox ? { since } : { since: folderSince },
            { uid: true },
          );
          if (found === false || found == null) {
            throw Object.assign(new Error("网易邮箱 IMAP SEARCH 失败"), { code: "NETEASE_SEARCH_FAILED" });
          }
          const uids = [...new Set((Array.isArray(found) ? found : [])
            .map(Number)
            .filter((uid) => Number.isSafeInteger(uid) && uid > 0))]
            .sort((left, right) => left - right)
            .slice(-NETEASE_MESSAGE_LIMIT);
          const scopedUidValidity = mailbox.isInbox
            ? uidValidity
            : `${uidValidity}-${mailboxGraphSuffix(mailbox.path)}`;

          for (const uid of uids) {
            const graphMessageId = `netease:${scopedUidValidity}:${uid}`;
            if (knownGraphIds.has(graphMessageId)) continue;
            let message;
            try {
              message = await client.fetchOne(uid, {
                uid: true,
                flags: true,
                envelope: true,
                internalDate: true,
                size: true,
                source: { start: 0, maxLength: 1024 * 1024 + 1 },
              }, { uid: true });
            } catch (error) {
              // A UID can disappear between SEARCH and FETCH after a user
              // moves/deletes a message. Treat that narrow race as a miss;
              // all transport/authentication failures are retried by the
              // outer job instead of being silently acknowledged.
              if (!isRecoverableMailboxError(error)) throw error;
              continue;
            }
            const source = message?.source;
            const sourceHash = source
              ? crypto.createHash("sha256").update(Buffer.from(source)).digest("hex")
              : "";
            let mapped;
            try {
              mapped = await this.parseFetchedMessage(account, message, scopedUidValidity);
            } catch {
              continue;
            }
            if (!mapped) continue;
            const internetId = normalizedMessageId(mapped.message.internetMessageId);
            if (internetId && (knownInternetIds.has(internetId) || seenInternetIds.has(internetId))) continue;
            if (!internetId && sourceHash && seenSourceHashes.has(sourceHash)) continue;
            if (internetId) seenInternetIds.add(internetId);
            else if (sourceHash) seenSourceHashes.add(sourceHash);
            messages.push(mapped.message);
            if (mapped.code) items.push(mapped.code);
          }
        } catch (error) {
          if (!isRecoverableMailboxError(error)) throw error;
          folderErrors.push({
            folder: mailbox.path.replace(/[\r\n]/g, " ").slice(0, 160),
            error: this.scanErrorMessage(error),
          });
        }
      }

      const summary = `发现 ${messages.length} 封网易邮箱邮件，其中 ${items.length} 条验证码，扫描 ${openedCount}/${mailboxes.length} 个文件夹`;
      return {
        stage: "completed",
        message: folderErrors.length ? `${summary}，${folderErrors.length} 个文件夹读取失败` : summary,
        messages,
        items,
        foldersScanned: openedCount,
        foldersTotal: mailboxes.length,
        folderErrors,
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

  credentials(account) {
    if (account?.provider !== "netease") {
      throw errorWithStatus("这个源头邮箱不是网易邮箱账号", 409, "NETEASE_PROVIDER_MISMATCH");
    }
    const row = this.db.prepare(
      "SELECT * FROM netease_credentials WHERE account_id = ?",
    ).get(account.id);
    if (!row) {
      throw errorWithStatus(
        "这个邮箱还没有配置网易邮箱客户端授权码",
        409,
        "NETEASE_CREDENTIAL_REQUIRED",
      );
    }
    return { username: row.username, password: this.decrypt(row.auth_code_encrypted) };
  }
}

export const neteaseImapHosts = HOST_BY_DOMAIN;
