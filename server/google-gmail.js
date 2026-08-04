import crypto from "node:crypto";
import { publicAccount } from "./account-service.js";
import { codeFromText, normalizeGoogleEmail } from "./address-generator.js";
import { audit, createSourceAccount, getSetting, nowIso, setSetting } from "./db.js";

const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const GMAIL_ENDPOINT = "https://gmail.googleapis.com/gmail/v1";
const BUILTIN_CLIENT_ID = "406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com";
const BUILTIN_CLIENT_SECRET = "kSmqreRr0qwBWJgbf5Y-PjSU";
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:12142/";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const SCAN_OVERLAP_MS = 10 * 60_000;
const SCOPES = "openid email profile https://www.googleapis.com/auth/gmail.readonly";
const MAIL_BODY_LIMIT = 100_000;
const EMAIL_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/gi;

function errorWithStatus(message, status = 502, code = "GOOGLE_ERROR") {
  return Object.assign(new Error(message), { status, code });
}

function googleError(data, fallback) {
  return data?.error_description || data?.error?.message || (typeof data?.error === "string" ? data.error : "") || fallback;
}

function googleErrorReasons(data) {
  const values = [data?.error?.status];
  for (const item of [
    ...(Array.isArray(data?.error?.errors) ? data.error.errors : []),
    ...(Array.isArray(data?.error?.details) ? data.error.details : []),
  ]) {
    values.push(item?.reason, item?.status);
  }
  return new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
}

function safeEqual(left, right) {
  const first = Buffer.from(String(left || ""));
  const second = Buffer.from(String(right || ""));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function decodeBody(value) {
  if (!value) return "";
  try {
    return Buffer.from(String(value), "base64url").toString("utf8");
  } catch {
    return "";
  }
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
    .replace(/&#(\d+);/g, (match, code) => {
      const point = Number(code);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function headerValues(payload, name) {
  const target = String(name).toLowerCase();
  return (Array.isArray(payload?.headers) ? payload.headers : [])
    .filter((header) => String(header?.name || "").toLowerCase() === target)
    .map((header) => String(header?.value || "").trim())
    .filter(Boolean);
}

function firstHeader(payload, name) {
  return headerValues(payload, name)[0] || "";
}

function parseAddresses(values) {
  const items = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const input = String(value || "");
    const matches = input.match(EMAIL_PATTERN) || [];
    for (const match of matches) {
      const address = normalizeGoogleEmail(match);
      if (!address || items.some((item) => item.address === address)) continue;
      const marker = input.toLowerCase().indexOf(`<${address}>`);
      const name = marker >= 0
        ? input.slice(0, marker).split(",").at(-1).trim().replace(/^['"]|['"]$/g, "")
        : "";
      items.push({ name, address });
    }
  }
  return items;
}

function collectMime(part, output) {
  if (!part || typeof part !== "object") return;
  const mimeType = String(part.mimeType || "").toLowerCase();
  const filename = String(part.filename || "").trim();
  const attachmentId = String(part.body?.attachmentId || "");
  const children = Array.isArray(part.parts) ? part.parts : [];
  if (filename) {
    output.hasAttachments = true;
    return;
  }
  const content = decodeBody(part.body?.data);
  if (content && mimeType === "text/plain") output.plain.push(content);
  else if (content && mimeType === "text/html") output.html.push(content);
  else if (!content && attachmentId && ["text/plain", "text/html"].includes(mimeType)) {
    output.externalText.push({ attachmentId, mimeType });
  } else if (attachmentId && !mimeType.startsWith("text/")) {
    output.hasAttachments = true;
  }
  children.forEach((child) => collectMime(child, output));
}

function messageBodyParts(payload) {
  const output = { plain: [], html: [], externalText: [], hasAttachments: false };
  collectMime(payload, output);
  return output;
}

function finalizeMessageBody(output) {
  const raw = output.plain.join("\n").trim() || htmlToText(output.html.join("\n"));
  return { raw, hasAttachments: output.hasAttachments };
}

function receivedAt(message, payload) {
  const internal = Number(message?.internalDate);
  if (Number.isFinite(internal) && internal > 0) return new Date(internal).toISOString();
  const parsed = Date.parse(firstHeader(payload, "Date"));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : nowIso();
}

async function mapLimit(values, limit, mapper) {
  const output = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

export class GoogleGmailClient {
  constructor({
    db,
    encryptionKey,
    fetchFn = fetch,
    clientId,
    clientSecret,
    redirectUri,
    requestTimeoutMs,
  } = {}) {
    this.db = db;
    this.fetch = fetchFn;
    this.clientIdOverride = clientId || process.env.GOOGLE_OAUTH_CLIENT_ID || "";
    this.clientSecretOverride = clientSecret || process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
    this.redirectUriOverride = redirectUri || process.env.GOOGLE_OAUTH_REDIRECT_URI || "";
    const configuredTimeout = Number(requestTimeoutMs ?? process.env.GOOGLE_REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.requestTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.floor(configuredTimeout)
      : DEFAULT_REQUEST_TIMEOUT_MS;
    this.encryptionKey = crypto.createHash("sha256")
      .update(String(encryptionKey || process.env.DATA_ENCRYPTION_KEY || "aliashub-development-key"))
      .digest();
  }

  get clientId() {
    return this.configuredClientId || BUILTIN_CLIENT_ID;
  }

  get configuredClientId() {
    return this.clientIdOverride || getSetting(this.db, "google_oauth_client_id", "").trim();
  }

  get configuredClientSecret() {
    if (this.clientSecretOverride) return this.clientSecretOverride;
    const encrypted = getSetting(this.db, "google_oauth_client_secret_encrypted", "");
    if (!encrypted) return "";
    try {
      return this.decrypt(encrypted);
    } catch {
      return "";
    }
  }

  clientSecretFor(clientId) {
    const targetClientId = String(clientId || "").trim();
    const configuredClientId = this.configuredClientId;
    if (targetClientId && configuredClientId && targetClientId === configuredClientId) {
      const configuredSecret = this.configuredClientSecret;
      if (configuredSecret) return configuredSecret;
    }
    return targetClientId === BUILTIN_CLIENT_ID ? BUILTIN_CLIENT_SECRET : "";
  }

  get clientSecret() {
    return this.clientSecretFor(this.clientId);
  }

  get redirectUri() {
    if (this.clientId === BUILTIN_CLIENT_ID) return DEFAULT_REDIRECT_URI;
    return this.redirectUriOverride || getSetting(this.db, "google_oauth_redirect_uri", DEFAULT_REDIRECT_URI) || DEFAULT_REDIRECT_URI;
  }

  configuration() {
    const clientId = this.clientId;
    const clientSecretConfigured = Boolean(this.clientSecret);
    const redirectUri = this.redirectUri;
    const mode = clientId === BUILTIN_CLIENT_ID ? "builtin" : "custom";
    return {
      google_oauth_client_id: clientId,
      google_oauth_client_secret_configured: clientSecretConfigured,
      google_oauth_redirect_uri: redirectUri,
      google_oauth_configured: Boolean(clientId && clientSecretConfigured && redirectUri),
      google_oauth_client_mode: mode,
      google_oauth_client: mode === "builtin" ? "内置邮件公共客户端" : "自定义 OAuth 客户端",
    };
  }

  updateConfiguration(input = {}) {
    const previousClientId = getSetting(this.db, "google_oauth_client_id", "").trim();
    const secret = String(input.google_oauth_client_secret || "").trim();
    if (Object.hasOwn(input, "google_oauth_client_id")) {
      const nextClientId = String(input.google_oauth_client_id || "").trim();
      setSetting(this.db, "google_oauth_client_id", nextClientId);
      if (nextClientId !== previousClientId && !secret) {
        setSetting(this.db, "google_oauth_client_secret_encrypted", "");
      }
    }
    if (secret) setSetting(this.db, "google_oauth_client_secret_encrypted", this.encrypt(secret));
    return this.configuration();
  }

  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  decrypt(value) {
    const [version, iv, tag, encrypted] = String(value || "").split(".");
    if (version !== "v1" || !iv || !tag || !encrypted) {
      throw errorWithStatus("Google OAuth Token 无法解密", 500, "TOKEN_DECRYPT_FAILED");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  }

  async jsonRequest(url, options = {}) {
    const controller = new AbortController();
    let timedOut = false;
    let timer;
    const timeoutError = errorWithStatus(
      `Google 请求超时（${this.requestTimeoutMs}ms）`,
      504,
      "GOOGLE_REQUEST_TIMEOUT",
    );
    const request = (async () => {
      try {
        const response = await this.fetch(url, { ...options, signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        return { response, data };
      } catch (error) {
        if (timedOut) throw timeoutError;
        throw error;
      }
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError);
      }, this.requestTimeoutMs);
    });
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async tokenRequest(values) {
    return this.jsonRequest(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values),
    });
  }

  ensureConfigured() {
    if (!this.clientId || !this.clientSecret) {
      throw errorWithStatus("Google OAuth 自定义客户端缺少对应的 Client Secret", 409, "GOOGLE_OAUTH_NOT_CONFIGURED");
    }
  }

  async startAuthorization({ accountId } = {}) {
    this.ensureConfigured();
    const expectedAccount = accountId
      ? this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(accountId))
      : null;
    if (accountId && !expectedAccount) throw errorWithStatus("源头邮箱不存在", 404, "ACCOUNT_NOT_FOUND");
    if (expectedAccount && expectedAccount.provider !== "google") {
      throw errorWithStatus("这个源头邮箱不是 Google 账号", 409, "OAUTH_PROVIDER_MISMATCH");
    }

    let redirectUri;
    try {
      redirectUri = new URL(this.redirectUri).toString();
    } catch {
      throw errorWithStatus("Google OAuth 回调地址配置无效", 409, "INVALID_REDIRECT_URI");
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
      VALUES (?, ?, 'google', ?, ?, ?, ?, ?, ?)
    `).run(id, expectedAccount?.id || null, this.clientId, this.encrypt(codeVerifier), state, redirectUri, expiresAt, nowIso());

    const authorizationUrl = new URL(AUTHORIZE_ENDPOINT);
    authorizationUrl.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
      ...(expectedAccount ? { login_hint: expectedAccount.email } : {}),
    }).toString();
    return { sessionId: id, authorizationUrl: authorizationUrl.toString(), redirectUri, expiresAt };
  }

  async completeAuthorization(sessionId, callbackValue) {
    const session = this.db.prepare("SELECT * FROM oauth_code_sessions WHERE id = ? AND provider = 'google'")
      .get(String(sessionId || ""));
    if (!session) throw errorWithStatus("Google 授权会话不存在或已过期", 404, "OAUTH_SESSION_NOT_FOUND");
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      throw errorWithStatus("Google 授权会话已过期，请重新开始", 410, "OAUTH_SESSION_EXPIRED");
    }

    let callbackUrl;
    try {
      callbackUrl = new URL(String(callbackValue || "").trim());
    } catch {
      throw errorWithStatus("请粘贴浏览器地址栏里的完整 Google 回调地址", 400, "INVALID_CALLBACK_URL");
    }
    const expectedRedirect = new URL(session.redirect_uri);
    if (callbackUrl.origin !== expectedRedirect.origin || callbackUrl.pathname !== expectedRedirect.pathname) {
      throw errorWithStatus("回调地址不是本次 Google 授权返回的地址", 400, "INVALID_CALLBACK_URL");
    }
    if (!safeEqual(callbackUrl.searchParams.get("state"), session.state)) {
      throw errorWithStatus("Google 授权状态不匹配，请重新开始", 409, "OAUTH_STATE_MISMATCH");
    }
    if (callbackUrl.searchParams.get("error")) {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      throw errorWithStatus(
        callbackUrl.searchParams.get("error_description") || "Google 授权已取消",
        409,
        callbackUrl.searchParams.get("error"),
      );
    }
    const code = callbackUrl.searchParams.get("code");
    if (!code) throw errorWithStatus("回调地址中没有 Google 授权码", 400, "MISSING_AUTHORIZATION_CODE");

    const sessionClientId = session.client_id || this.clientId;
    const sessionClientSecret = this.clientSecretFor(sessionClientId);
    if (!sessionClientSecret) {
      throw errorWithStatus("本次 Google 授权使用的 OAuth 客户端已不可用，请重新开始", 409, "GOOGLE_OAUTH_CLIENT_UNAVAILABLE");
    }
    const tokenResult = await this.tokenRequest({
      client_id: sessionClientId,
      client_secret: sessionClientSecret,
      redirect_uri: session.redirect_uri,
      grant_type: "authorization_code",
      code,
      code_verifier: this.decrypt(session.code_verifier_encrypted),
    });
    const { response, data } = tokenResult;
    if (!response.ok || !data.access_token) {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      throw errorWithStatus(googleError(data, "Google 授权码兑换失败"), 400, data.error || "TOKEN_EXCHANGE_FAILED");
    }

    const profileResult = await this.jsonRequest(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (!profileResult.response.ok || profileResult.data.error) {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      throw errorWithStatus(googleError(profileResult.data, "无法读取 Google 账号资料"), 502, "PROFILE_READ_FAILED");
    }
    const profile = profileResult.data;
    const identityEmail = normalizeGoogleEmail(profile.email);
    if (!identityEmail || profile.email_verified === false) {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      throw errorWithStatus("Google 没有返回已验证的邮箱地址", 422, "UNSUPPORTED_GOOGLE_ACCOUNT");
    }
    const gmailProfileResult = await this.jsonRequest(`${GMAIL_ENDPOINT}/users/me/profile`, {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    const gmailEmail = normalizeGoogleEmail(gmailProfileResult.data?.emailAddress);
    if (!gmailProfileResult.response.ok || gmailProfileResult.data.error || !gmailEmail) {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      const status = gmailProfileResult.response.status === 400
        ? 422
        : [401, 403].includes(gmailProfileResult.response.status) ? 409 : 502;
      throw errorWithStatus(
        googleError(gmailProfileResult.data, "这个 Google 账号没有可读取的 Gmail 邮箱"),
        status,
        "GMAIL_MAILBOX_UNAVAILABLE",
      );
    }
    if (gmailEmail !== identityEmail) {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      throw errorWithStatus("Google 身份邮箱与 Gmail 主邮箱不匹配", 409, "GMAIL_ACCOUNT_MISMATCH");
    }
    const email = gmailEmail;
    const expected = session.expected_account_id
      ? this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(session.expected_account_id)
      : null;
    if (session.expected_account_id && !expected) {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      throw errorWithStatus("要重新授权的源头邮箱已不存在", 404, "ACCOUNT_NOT_FOUND");
    }
    if (expected && (expected.provider !== "google" || email !== expected.email.toLowerCase())) {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      throw errorWithStatus(`请使用 ${expected.email} 完成重新授权`, 409, "OAUTH_ACCOUNT_MISMATCH");
    }

    let account = this.db.prepare("SELECT * FROM source_accounts WHERE email = ? COLLATE NOCASE").get(email);
    if (account && account.provider !== "google") {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      throw errorWithStatus("这个邮箱已绑定到其他认证提供商", 409, "OAUTH_PROVIDER_MISMATCH");
    }
    const existingToken = account
      ? this.db.prepare("SELECT * FROM google_tokens WHERE account_id = ?").get(account.id)
      : null;
    if (!data.refresh_token && (!existingToken || existingToken.client_id !== sessionClientId)) {
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      throw errorWithStatus("Google 没有返回长期授权 Token，请重新授权并允许离线访问", 409, "MISSING_REFRESH_TOKEN");
    }
    if (!account) {
      account = createSourceAccount(this.db, {
        email,
        displayName: profile.name || email.split("@")[0],
        provider: "google",
        officialLimit: 1,
      });
    }

    const now = nowIso();
    const scope = String(data.scope || SCOPES);
    this.db.transaction(() => {
      if (data.refresh_token) {
        this.db.prepare(`
          INSERT INTO google_tokens
            (account_id, client_id, google_user_id, refresh_token_encrypted, scope, token_updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id) DO UPDATE SET
            client_id = excluded.client_id,
            google_user_id = excluded.google_user_id,
            refresh_token_encrypted = excluded.refresh_token_encrypted,
            scope = excluded.scope,
            token_updated_at = excluded.token_updated_at
        `).run(account.id, sessionClientId, profile.sub || "", this.encrypt(data.refresh_token), scope, now);
      } else {
        this.db.prepare(`
          UPDATE google_tokens SET client_id = ?, google_user_id = ?, scope = ?, token_updated_at = ?
          WHERE account_id = ?
        `).run(sessionClientId, profile.sub || existingToken.google_user_id || "", scope, now, account.id);
      }
      this.db.prepare(`
        UPDATE source_accounts SET
          display_name = CASE WHEN display_name = '' OR display_name = email THEN ? ELSE display_name END,
          status = 'connected', updated_at = ?
        WHERE id = ?
      `).run(profile.name || email.split("@")[0], now, account.id);
      this.db.prepare("DELETE FROM oauth_code_sessions WHERE id = ?").run(session.id);
      audit(this.db, account.id, "account", "Google OAuth 授权完成", email, {
        client: sessionClientId === BUILTIN_CLIENT_ID ? "内置邮件公共客户端" : "自定义 Google OAuth 客户端",
        flow: "authorization_code_pkce",
        scope,
      });
    })();
    account = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id);
    return { status: "connected", account: publicAccount(this.db, account) };
  }

  async accessToken(account) {
    if (account.provider !== "google") {
      throw errorWithStatus("这个源头邮箱不是 Google 账号", 409, "OAUTH_PROVIDER_MISMATCH");
    }
    const token = this.db.prepare("SELECT * FROM google_tokens WHERE account_id = ?").get(account.id);
    if (!token) throw errorWithStatus("这个邮箱还没有完成 Google OAuth 授权", 409, "OAUTH_REQUIRED");
    const tokenClientId = token.client_id || this.clientId;
    const tokenClientSecret = this.clientSecretFor(tokenClientId);
    if (!tokenClientSecret) {
      this.db.prepare("UPDATE source_accounts SET status = 'action_required', updated_at = ? WHERE id = ?")
        .run(nowIso(), account.id);
      throw errorWithStatus("此邮箱原先使用的 Google OAuth 客户端已不可用，请重新授权", 409, "GOOGLE_OAUTH_CLIENT_UNAVAILABLE");
    }
    const { response, data } = await this.tokenRequest({
      client_id: tokenClientId,
      client_secret: tokenClientSecret,
      grant_type: "refresh_token",
      refresh_token: this.decrypt(token.refresh_token_encrypted),
    });
    if (!response.ok || !data.access_token) {
      const requiresAction = [400, 401, 403].includes(response.status)
        && ["invalid_grant", "invalid_client", "unauthorized_client", "access_denied"].includes(String(data.error || ""));
      if (requiresAction) {
        this.db.prepare("UPDATE source_accounts SET status = 'action_required', updated_at = ? WHERE id = ?")
          .run(nowIso(), account.id);
      }
      throw errorWithStatus(
        googleError(data, "Google OAuth 授权刷新失败"),
        requiresAction ? 409 : 502,
        data.error || "REFRESH_FAILED",
      );
    }
    if (data.refresh_token) {
      this.db.prepare("UPDATE google_tokens SET refresh_token_encrypted = ?, scope = ?, token_updated_at = ? WHERE account_id = ?")
        .run(this.encrypt(data.refresh_token), String(data.scope || token.scope || SCOPES), nowIso(), account.id);
    }
    return data.access_token;
  }

  mailReadError(account, response, data, fallback = "无法读取 Gmail 收件箱") {
    const reasons = googleErrorReasons(data);
    const authenticationReasons = new Set([
      "autherror",
      "invalidcredentials",
      "insufficientpermissions",
      "insufficientauthenticationscopes",
      "access_token_scope_insufficient",
      "unauthenticated",
    ]);
    const transientReasons = new Set([
      "userratelimitexceeded",
      "ratelimitexceeded",
      "quotaexceeded",
      "dailylimitexceeded",
      "backenderror",
      "internalerror",
      "serviceunavailable",
      "resource_exhausted",
      "unavailable",
      "internal",
      "deadline_exceeded",
    ]);
    const requiresAction = response.status === 401
      || (response.status === 403 && [...reasons].some((reason) => authenticationReasons.has(reason)));
    const transient = response.status === 429
      || response.status >= 500
      || [...reasons].some((reason) => transientReasons.has(reason));
    if (requiresAction) {
      this.db.prepare("UPDATE source_accounts SET status = 'action_required', updated_at = ? WHERE id = ?")
        .run(nowIso(), account.id);
    }
    const status = requiresAction ? 409 : (transient || response.status === 403 ? 503 : 502);
    return errorWithStatus(googleError(data, fallback), status, "MAIL_READ_FAILED");
  }

  async messageBody(account, messageId, payload, accessToken) {
    const output = messageBodyParts(payload);
    const externalBodies = await mapLimit(output.externalText, 3, async (part) => {
      const attachmentUrl = new URL(
        `${GMAIL_ENDPOINT}/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.attachmentId)}`,
      );
      const result = await this.jsonRequest(attachmentUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!result.response.ok || result.data.error) {
        throw this.mailReadError(account, result.response, result.data, "无法读取 Gmail 邮件正文");
      }
      return { mimeType: part.mimeType, content: decodeBody(result.data.data) };
    });
    externalBodies.forEach(({ mimeType, content }) => {
      if (!content) return;
      if (mimeType === "text/html") output.html.push(content);
      else output.plain.push(content);
    });
    return finalizeMessageBody(output);
  }

  async scanInbox(account) {
    const accessToken = await this.accessToken(account);
    const listUrl = new URL(`${GMAIL_ENDPOINT}/users/me/messages`);
    listUrl.searchParams.set("labelIds", "INBOX");
    listUrl.searchParams.set("maxResults", "75");
    const lastScan = Date.parse(account.last_inbox_scan_at || "");
    if (Number.isFinite(lastScan)) {
      const after = Math.max(0, Math.floor((lastScan - SCAN_OVERLAP_MS) / 1_000));
      listUrl.searchParams.set("q", `after:${after}`);
    }
    const listResult = await this.jsonRequest(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listResult.response.ok || listResult.data.error) {
      throw this.mailReadError(account, listResult.response, listResult.data);
    }
    const refs = Array.isArray(listResult.data.messages)
      ? listResult.data.messages.filter((item) => item?.id).slice(0, 75)
      : [];
    const knownIds = refs.length
      ? new Set(this.db.prepare(`
        SELECT graph_message_id FROM mail_messages
        WHERE account_id = ? AND graph_message_id IN (${refs.map(() => "?").join(", ")})
      `).all(account.id, ...refs.map((item) => String(item.id))).map((item) => item.graph_message_id))
      : new Set();
    const pendingRefs = refs.filter((item) => !knownIds.has(String(item.id)));
    const rawMessages = await mapLimit(pendingRefs, 5, async (reference) => {
      const detailUrl = new URL(`${GMAIL_ENDPOINT}/users/me/messages/${encodeURIComponent(reference.id)}`);
      detailUrl.searchParams.set("format", "full");
      const result = await this.jsonRequest(detailUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (result.response.status === 404) return null;
      if (!result.response.ok || result.data.error) throw this.mailReadError(account, result.response, result.data);
      return result.data;
    });

    const items = [];
    const messages = [];
    for (const message of rawMessages.filter(Boolean)) {
      const payload = message.payload || {};
      const graphMessageId = String(message.id || "");
      if (!graphMessageId) continue;
      const content = await this.messageBody(account, graphMessageId, payload, accessToken);
      const rawBody = content.raw;
      const body = rawBody.slice(0, MAIL_BODY_LIMIT);
      const subject = firstHeader(payload, "Subject") || "(无主题)";
      const preview = String(message.snippet || body).replace(/\s+/g, " ").trim().slice(0, 500);
      const code = codeFromText(`${subject}\n${preview}\n${body}`);
      const from = parseAddresses(headerValues(payload, "From"))[0] || { name: "", address: "" };
      const toRecipients = parseAddresses(headerValues(payload, "To"));
      const ccRecipients = parseAddresses(headerValues(payload, "Cc"));
      const deliveredRecipients = parseAddresses([
        ...headerValues(payload, "Delivered-To"),
        ...headerValues(payload, "X-Original-To"),
      ]);
      const recipients = [...new Set([
        ...deliveredRecipients,
        ...toRecipients,
        ...ccRecipients,
      ].map((item) => item.address).filter(Boolean))];
      const recipient = recipients[0] || "";
      const received = receivedAt(message, payload);
      messages.push({
        fingerprint: crypto.createHash("sha256").update(`${account.id}:${graphMessageId}`).digest("hex"),
        graphMessageId,
        internetMessageId: firstHeader(payload, "Message-ID"),
        senderName: from.name,
        senderAddress: from.address,
        toRecipients,
        ccRecipients,
        recipients,
        recipient,
        subject,
        preview,
        body,
        bodyContentType: "text",
        bodyTruncated: rawBody.length > MAIL_BODY_LIMIT,
        verificationCode: code,
        webLink: `https://mail.google.com/mail/u/0/#inbox/${message.threadId || graphMessageId}`,
        isRead: !(Array.isArray(message.labelIds) ? message.labelIds : []).includes("UNREAD"),
        hasAttachments: content.hasAttachments,
        receivedAt: received,
      });
      if (!code) continue;
      items.push({
        fingerprint: crypto.createHash("sha256").update(`${account.id}:${graphMessageId}:${code}`).digest("hex"),
        code,
        sender: from.name || from.address || "未知发件人",
        subject,
        preview: preview.slice(0, 360),
        recipient,
        recipients,
        receivedAt: received,
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
