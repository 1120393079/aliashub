import crypto from "node:crypto";
import { publicAccount } from "./account-service.js";
import { codeFromText, normalizeMicrosoftEmail } from "./address-generator.js";
import { audit, createSourceAccount, getSetting, nowIso } from "./db.js";

const AUTHORIZE_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_ENDPOINT = "https://graph.microsoft.com/v1.0";
const DEFAULT_CLIENT_ID = "8787a430-6eee-41e1-b914-681d90d35625";
const REDIRECT_URI = "http://localhost:12141/desktop";
const SCOPES = "openid profile email offline_access User.Read Mail.Read";
const MAIL_BODY_LIMIT = 1_000_000;

function errorWithStatus(message, status = 502, code = "MICROSOFT_ERROR") {
  return Object.assign(new Error(message), { status, code });
}

function jwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function safeEqual(left, right) {
  const first = Buffer.from(String(left || ""));
  const second = Buffer.from(String(right || ""));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function microsoftError(data, fallback) {
  return data?.error_description || data?.error?.message || fallback;
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

export class MicrosoftGraphClient {
  constructor({ db, encryptionKey, fetchFn = fetch, clientId } = {}) {
    this.db = db;
    this.fetch = fetchFn;
    this.clientIdOverride = clientId
      || process.env.MICROSOFT_OAUTH_CLIENT_ID
      || process.env.MICROSOFT_PUBLIC_CLIENT_ID
      || "";
    this.encryptionKey = crypto.createHash("sha256")
      .update(String(encryptionKey || process.env.DATA_ENCRYPTION_KEY || "aliashub-development-key"))
      .digest();
  }

  get clientId() {
    return this.clientIdOverride || getSetting(this.db, "microsoft_public_client_id", DEFAULT_CLIENT_ID);
  }

  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  decrypt(value) {
    const [version, iv, tag, encrypted] = String(value || "").split(".");
    if (version !== "v1" || !iv || !tag || !encrypted) throw errorWithStatus("OAuth Token 无法解密", 500, "TOKEN_DECRYPT_FAILED");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  }

  async jsonRequest(url, options = {}) {
    const response = await this.fetch(url, options);
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }

  async tokenRequest(values) {
    return this.jsonRequest(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values),
    });
  }

  async startAuthorization({ accountId } = {}) {
    const expectedAccount = accountId
      ? this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(accountId))
      : null;
    if (accountId && !expectedAccount) throw errorWithStatus("源头邮箱不存在", 404, "ACCOUNT_NOT_FOUND");
    if (expectedAccount && expectedAccount.provider !== "microsoft") {
      throw errorWithStatus("这个源头邮箱不是 Microsoft 账号", 409, "OAUTH_PROVIDER_MISMATCH");
    }

    this.db.prepare("DELETE FROM oauth_code_sessions WHERE expires_at <= ?").run(nowIso());
    const id = crypto.randomUUID();
    const state = crypto.randomBytes(32).toString("base64url");
    const codeVerifier = crypto.randomBytes(64).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const expiresAt = new Date(Date.now() + 20 * 60_000).toISOString();

    this.db.prepare(`
      INSERT INTO oauth_code_sessions
        (id, expected_account_id, provider, client_id, code_verifier_encrypted, state, redirect_uri, expires_at, created_at)
      VALUES (?, ?, 'microsoft', ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      expectedAccount?.id || null,
      this.clientId,
      this.encrypt(codeVerifier),
      state,
      REDIRECT_URI,
      expiresAt,
      nowIso(),
    );

    const authorizationUrl = new URL(AUTHORIZE_ENDPOINT);
    authorizationUrl.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      response_mode: "query",
      scope: SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      prompt: expectedAccount ? "consent" : "select_account",
      ...(expectedAccount ? { login_hint: expectedAccount.email } : {}),
    }).toString();

    return {
      sessionId: id,
      authorizationUrl: authorizationUrl.toString(),
      redirectUri: REDIRECT_URI,
      expiresAt,
    };
  }

  async completeAuthorization(sessionId, callbackValue) {
    const session = this.db.prepare("SELECT * FROM oauth_code_sessions WHERE id = ? AND provider = 'microsoft'").get(String(sessionId || ""));
    if (!session) throw errorWithStatus("授权会话不存在或已过期", 404, "OAUTH_SESSION_NOT_FOUND");
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      throw errorWithStatus("Microsoft 授权会话已过期，请重新开始", 410, "OAUTH_SESSION_EXPIRED");
    }

    let callbackUrl;
    try {
      callbackUrl = new URL(String(callbackValue || "").trim());
    } catch {
      throw errorWithStatus("请粘贴浏览器地址栏里的完整 localhost 回调地址", 400, "INVALID_CALLBACK_URL");
    }
    const expectedRedirect = new URL(session.redirect_uri);
    if (callbackUrl.origin !== expectedRedirect.origin || callbackUrl.pathname !== expectedRedirect.pathname) {
      throw errorWithStatus("回调地址不是本次 Microsoft 授权返回的地址", 400, "INVALID_CALLBACK_URL");
    }
    if (!safeEqual(callbackUrl.searchParams.get("state"), session.state)) {
      throw errorWithStatus("Microsoft 授权状态不匹配，请重新开始", 409, "OAUTH_STATE_MISMATCH");
    }
    if (callbackUrl.searchParams.get("error")) {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      throw errorWithStatus(
        callbackUrl.searchParams.get("error_description") || "Microsoft 授权已取消",
        409,
        callbackUrl.searchParams.get("error"),
      );
    }
    const code = callbackUrl.searchParams.get("code");
    if (!code) throw errorWithStatus("回调地址中没有 Microsoft 授权码", 400, "MISSING_AUTHORIZATION_CODE");

    const { response, data } = await this.tokenRequest({
      client_id: session.client_id || this.clientId,
      redirect_uri: session.redirect_uri,
      grant_type: "authorization_code",
      code,
      code_verifier: this.decrypt(session.code_verifier_encrypted),
      scope: SCOPES,
    });
    if (!response.ok || !data.access_token || !data.refresh_token) {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      throw errorWithStatus(microsoftError(data, "Microsoft 没有返回长期授权 Token"), 400, data.error || "TOKEN_EXCHANGE_FAILED");
    }

    const profileResult = await this.jsonRequest(`${GRAPH_ENDPOINT}/me?$select=id,displayName,mail,userPrincipalName`, {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (!profileResult.response.ok || profileResult.data.error) {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      throw errorWithStatus(microsoftError(profileResult.data, "无法读取 Microsoft 账号资料"), 502, "PROFILE_READ_FAILED");
    }

    const profile = profileResult.data;
    const claims = jwtPayload(data.id_token);
    const email = [profile.mail, profile.userPrincipalName, claims.preferred_username, claims.email]
      .map(normalizeMicrosoftEmail)
      .find(Boolean) || "";
    const expected = session.expected_account_id
      ? this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(session.expected_account_id)
      : null;
    if (!email) {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      throw errorWithStatus("授权账号不是支持的 Outlook、Hotmail、Live 或 MSN 邮箱", 422, "UNSUPPORTED_MICROSOFT_ACCOUNT");
    }
    if (expected && email !== expected.email.toLowerCase()) {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      throw errorWithStatus(`请使用 ${expected.email} 完成重新授权`, 409, "OAUTH_ACCOUNT_MISMATCH");
    }

    let account = this.db.prepare("SELECT * FROM source_accounts WHERE email = ? COLLATE NOCASE").get(email);
    if (account && account.provider !== "microsoft") {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      throw errorWithStatus("这个邮箱已绑定到其他认证提供商", 409, "OAUTH_PROVIDER_MISMATCH");
    }
    if (!account) account = createSourceAccount(this.db, { email, displayName: profile.displayName || claims.name || "" });
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO microsoft_tokens (account_id, client_id, microsoft_user_id, refresh_token_encrypted, scope, token_updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          client_id = excluded.client_id,
          microsoft_user_id = excluded.microsoft_user_id,
          refresh_token_encrypted = excluded.refresh_token_encrypted,
          scope = excluded.scope,
          token_updated_at = excluded.token_updated_at
      `).run(account.id, session.client_id || this.clientId, profile.id || claims.sub || "", this.encrypt(data.refresh_token), SCOPES, now);
      this.db.prepare(`
        UPDATE source_accounts SET
          display_name = CASE WHEN display_name = '' OR display_name = email THEN ? ELSE display_name END,
          status = 'connected', updated_at = ?
        WHERE id = ?
      `).run(profile.displayName || claims.name || email.split("@")[0], now, account.id);
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      audit(this.db, account.id, "account", "Microsoft OAuth 授权完成", email, { client: "Mailspring", flow: "authorization_code_pkce" });
    })();
    account = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id);
    return { status: "connected", account: publicAccount(this.db, account) };
  }

  async accessToken(account) {
    if (account.provider !== "microsoft") {
      throw errorWithStatus("这个源头邮箱不是 Microsoft 账号", 409, "OAUTH_PROVIDER_MISMATCH");
    }
    const token = this.db.prepare("SELECT * FROM microsoft_tokens WHERE account_id = ?").get(account.id);
    if (!token) throw errorWithStatus("这个邮箱还没有完成 Microsoft OAuth 授权", 409, "OAUTH_REQUIRED");
    const { response, data } = await this.tokenRequest({
      client_id: token.client_id || this.clientId,
      grant_type: "refresh_token",
      refresh_token: this.decrypt(token.refresh_token_encrypted),
      scope: SCOPES,
    });
    if (!response.ok || !data.access_token) {
      this.db.prepare("UPDATE source_accounts SET status = 'action_required', updated_at = ? WHERE id = ?").run(nowIso(), account.id);
      throw errorWithStatus(microsoftError(data, "Microsoft OAuth 授权已失效"), 409, data.error || "REFRESH_FAILED");
    }
    if (data.refresh_token) {
      this.db.prepare("UPDATE microsoft_tokens SET refresh_token_encrypted = ?, scope = ?, token_updated_at = ? WHERE account_id = ?")
        .run(this.encrypt(data.refresh_token), SCOPES, nowIso(), account.id);
    }
    return data.access_token;
  }

  async scanInbox(account) {
    const accessToken = await this.accessToken(account);
    const messagesUrl = new URL(`${GRAPH_ENDPOINT}/me/mailFolders/inbox/messages`);
    messagesUrl.searchParams.set("$top", "75");
    messagesUrl.searchParams.set("$orderby", "receivedDateTime desc");
    messagesUrl.searchParams.set(
      "$select",
      "id,internetMessageId,subject,bodyPreview,body,receivedDateTime,from,toRecipients,ccRecipients,isRead,hasAttachments,webLink",
    );
    const { response, data } = await this.jsonRequest(messagesUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.body-content-type="html"',
      },
    });
    if (!response.ok || data.error || !Array.isArray(data.value)) {
      if ([401, 403].includes(response.status)) {
        this.db.prepare("UPDATE source_accounts SET status = 'action_required', updated_at = ? WHERE id = ?").run(nowIso(), account.id);
      }
      throw errorWithStatus(microsoftError(data, "无法读取 Outlook 收件箱"), response.status === 403 ? 409 : 502, "MAIL_READ_FAILED");
    }

    const items = [];
    const messages = [];
    for (const message of data.value) {
      const rawBody = String(message.body?.content || "");
      const body = rawBody.slice(0, MAIL_BODY_LIMIT);
      const readableBody = String(message.body?.contentType || "").toLowerCase() === "html"
        ? htmlToText(body) : body;
      const text = `${message.subject || ""}\n${message.bodyPreview || ""}\n${readableBody}`;
      const code = codeFromText(text);
      const normalizeRecipients = (values) => (Array.isArray(values) ? values : [])
        .map((item) => ({
          name: String(item.emailAddress?.name || "").trim(),
          address: String(item.emailAddress?.address || "").trim().toLowerCase(),
        }))
        .filter((item) => item.address);
      const toRecipients = normalizeRecipients(message.toRecipients);
      const ccRecipients = normalizeRecipients(message.ccRecipients);
      const recipients = [...toRecipients, ...ccRecipients].map((item) => item.address);
      const recipient = recipients.find((value) => normalizeMicrosoftEmail(value)) || "";
      const senderName = String(message.from?.emailAddress?.name || "").trim();
      const senderAddress = String(message.from?.emailAddress?.address || "").trim().toLowerCase();
      const sender = senderName || senderAddress || "未知发件人";
      const graphMessageId = String(message.id || "");
      const messageFingerprint = crypto.createHash("sha256").update(`${account.id}:${graphMessageId}`).digest("hex");
      const preview = String(message.bodyPreview || body).replace(/\s+/g, " ").slice(0, 500);
      const receivedAt = message.receivedDateTime || nowIso();
      messages.push({
        fingerprint: messageFingerprint,
        graphMessageId,
        internetMessageId: String(message.internetMessageId || ""),
        senderName,
        senderAddress,
        toRecipients,
        ccRecipients,
        recipients,
        recipient,
        subject: String(message.subject || "(无主题)"),
        preview,
        body,
        bodyContentType: String(message.body?.contentType || "text").toLowerCase(),
        bodyTruncated: rawBody.length > MAIL_BODY_LIMIT,
        verificationCode: code,
        webLink: String(message.webLink || ""),
        isRead: Boolean(message.isRead),
        hasAttachments: Boolean(message.hasAttachments),
        receivedAt,
      });
      if (!code) continue;
      items.push({
        fingerprint: crypto.createHash("sha256").update(`${account.id}:${message.id}:${code}`).digest("hex"),
        code,
        sender,
        subject: message.subject || "验证码邮件",
        preview: preview.slice(0, 360),
        recipient,
        recipients,
        receivedAt,
      });
    }
    return {
      stage: "completed",
      message: `发现 ${messages.length} 封邮件，其中 ${items.length} 条验证码`,
      messages,
      items,
    };
  }
}
