import { Pool } from "pg";

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g;
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

function clean(value) {
  return String(value ?? "").trim();
}

function normalizedEmail(value) {
  return clean(value).toLowerCase();
}

function safeErrorMessage(error) {
  return clean(error?.message || "NFapi 最新凭据同步失败")
    .replace(JWT_PATTERN, "[REDACTED-JWT]")
    .replace(/((?:access|refresh|id)[_-]?token\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .slice(0, 300);
}

function credentialMap(account = {}) {
  if (!Array.isArray(account.credentials)) return { ...(account.credentials || {}) };
  return Object.fromEntries(account.credentials
    .filter((item) => clean(item?.key))
    .map((item) => [clean(item.key), item.value]));
}

function decodeJwtPayload(token, label) {
  const parts = clean(token).split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw Object.assign(new Error(`NFapi ${label} 格式无效`), { status: 502 });
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid payload");
    return payload;
  } catch {
    throw Object.assign(new Error(`NFapi ${label} 内容无效`), { status: 502 });
  }
}

function authClaims(payload = {}) {
  const nested = payload[OPENAI_AUTH_CLAIM];
  return nested && typeof nested === "object" && !Array.isArray(nested) ? nested : {};
}

function distinct(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function assertSingleIdentity(values, label) {
  const identities = distinct(values);
  if (identities.length > 1) {
    throw Object.assign(new Error(`NFapi ${label}不一致，已停止同步`), { status: 409 });
  }
  return identities[0] || "";
}

function currentJwtIdentity(credentials = {}) {
  const token = clean(credentials.access_token || credentials.accessToken);
  if (!token) return {};
  try {
    const payload = decodeJwtPayload(token, "现有 Access Token");
    const auth = authClaims(payload);
    return {
      email: clean(payload.email || auth.email),
      accountId: clean(auth.chatgpt_account_id || payload.chatgpt_account_id),
      userId: clean(auth.chatgpt_user_id || payload.chatgpt_user_id),
    };
  } catch {
    return {};
  }
}

export function validateNfapiOauthCredentials(raw, account, {
  now = new Date(),
  requireUnexpired = true,
} = {}) {
  const expectedEmail = normalizedEmail(account?.email);
  const credentials = credentialMap(account);
  const accessToken = clean(raw?.access_token);
  if (!expectedEmail || !accessToken) {
    throw Object.assign(new Error("NFapi OAuth 凭据不完整"), { status: 502 });
  }

  const accessPayload = decodeJwtPayload(accessToken, "Access Token");
  const accessAuth = authClaims(accessPayload);
  const idPayload = clean(raw?.id_token) ? decodeJwtPayload(raw.id_token, "ID Token") : {};
  const idAuth = authClaims(idPayload);
  const tokenExpiry = Number(accessPayload.exp || 0);
  if (requireUnexpired && (!Number.isFinite(tokenExpiry) || tokenExpiry * 1000 <= now.getTime() + 30_000)) {
    throw Object.assign(new Error("NFapi 刷新后的 Access Token 已过期"), { status: 409 });
  }

  const email = assertSingleIdentity([
    raw?.email,
    accessPayload.email,
    accessAuth.email,
    idPayload.email,
    idAuth.email,
  ].map(normalizedEmail), "邮箱");
  if (!email || email !== expectedEmail) {
    throw Object.assign(new Error("NFapi 凭据邮箱与注册账号不匹配，已停止同步"), { status: 409 });
  }

  const existingJwt = currentJwtIdentity(credentials);
  const accountId = assertSingleIdentity([
    raw?.chatgpt_account_id,
    accessAuth.chatgpt_account_id,
    accessPayload.chatgpt_account_id,
    idAuth.chatgpt_account_id,
    idPayload.chatgpt_account_id,
  ], "workspace");
  const existingAccountIds = distinct([
    credentials.account_id,
    credentials.chatgpt_account_id,
    existingJwt.accountId,
  ]);
  if (!accountId || (existingAccountIds.length && !existingAccountIds.includes(accountId))) {
    throw Object.assign(new Error("NFapi 凭据 workspace 与注册账号不匹配，已停止同步"), { status: 409 });
  }

  const userId = assertSingleIdentity([
    raw?.chatgpt_user_id,
    accessAuth.chatgpt_user_id,
    accessPayload.chatgpt_user_id,
    idAuth.chatgpt_user_id,
    idPayload.chatgpt_user_id,
  ], "用户身份");
  const existingUserIds = distinct([credentials.chatgpt_user_id, existingJwt.userId]);
  if (userId && existingUserIds.length && !existingUserIds.includes(userId)) {
    throw Object.assign(new Error("NFapi 凭据用户身份与注册账号不匹配，已停止同步"), { status: 409 });
  }

  const patch = {
    access_token: accessToken,
    account_id: accountId,
    chatgpt_account_id: accountId,
    email,
  };
  for (const key of ["refresh_token", "id_token", "expires_at", "plan_type"]) {
    const value = clean(raw?.[key]);
    if (value) patch[key] = value;
  }
  if (userId) patch.chatgpt_user_id = userId;
  return { patch, accountId, userId, email, tokenExpiry };
}

export class NfapiCredentialStore {
  constructor({ pool, host, database, user } = {}) {
    this.ownsPool = !pool;
    this.pool = pool || new Pool({
      host: host || process.env.NFAPI_CREDENTIAL_DB_HOST || "/var/run/postgresql",
      database: database || process.env.NFAPI_CREDENTIAL_DB_NAME || "sub2api",
      user: user || process.env.NFAPI_CREDENTIAL_DB_USER || "alias-hub",
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      allowExitOnIdle: true,
    });
  }

  async getOpenAiOauthCredentials(accountId) {
    const id = Number(accountId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw Object.assign(new Error("NFapi 账号 ID 无效"), { status: 400 });
    }
    const result = await this.pool.query(
      "SELECT * FROM public.alias_hub_openai_oauth_credentials($1::bigint)",
      [id],
    );
    if (result.rows.length !== 1) {
      throw Object.assign(new Error("NFapi OAuth 账号不存在或不可用"), { status: 404 });
    }
    return result.rows[0];
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}

export class NfapiCredentialSync {
  constructor({ db, store, nfapiClientFactory, registrationClient, nfapiBaseUrl, nowFn = () => new Date() } = {}) {
    this.db = db;
    this.store = store;
    this.nfapiClientFactory = nfapiClientFactory;
    this.registrationClient = registrationClient;
    this.nfapiBaseUrl = nfapiBaseUrl;
    this.nowFn = nowFn;
  }

  links(accounts) {
    const ids = [...new Set((accounts || []).map((item) => Number(item?.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    const baseUrl = clean(typeof this.nfapiBaseUrl === "function" ? this.nfapiBaseUrl() : this.nfapiBaseUrl)
      .replace(/\/+$/, "");
    return this.db.prepare(`
      SELECT external_account_id, email, nfapi_base_url, nfapi_account_id
      FROM registered_account_nfapi_links
      WHERE external_account_id IN (${placeholders}) AND status = 'imported'
      ORDER BY updated_at DESC
    `).all(...ids.map(String)).filter((link) => !baseUrl
      || clean(link.nfapi_base_url).replace(/\/+$/, "") === baseUrl);
  }

  async syncAccounts(accounts = []) {
    const byId = new Map(accounts.map((item) => [Number(item?.id), item]));
    const links = this.links(accounts);
    if (!links.length) return { attempted: 0, synced: 0, failed: 0, items: [] };
    const nfapiClient = this.nfapiClientFactory();
    const items = [];
    for (const link of links) {
      const externalId = Number(link.external_account_id);
      const nfapiId = Number(link.nfapi_account_id);
      try {
        if (!Number.isSafeInteger(nfapiId) || nfapiId <= 0) {
          throw Object.assign(new Error("NFapi 绑定账号 ID 无效"), { status: 409 });
        }
        const account = await this.registrationClient.getAccount(externalId);
        if (!account || String(account.platform || "chatgpt").toLowerCase() !== "chatgpt"
          || normalizedEmail(account.email) !== normalizedEmail(link.email)
          || normalizedEmail(account.email) !== normalizedEmail(byId.get(externalId)?.email)) {
          throw Object.assign(new Error("NFapi 绑定记录与注册账号不匹配，已停止同步"), { status: 409 });
        }

        const before = await this.store.getOpenAiOauthCredentials(nfapiId);
        if (Number(before.nfapi_account_id) !== nfapiId) {
          throw Object.assign(new Error("NFapi 数据库返回了错误账号，已停止同步"), { status: 409 });
        }
        validateNfapiOauthCredentials(before, account, { now: this.nowFn(), requireUnexpired: false });
        await nfapiClient.refreshAccountCredentials(nfapiId);
        const latest = await this.store.getOpenAiOauthCredentials(nfapiId);
        const validated = validateNfapiOauthCredentials(latest, account, { now: this.nowFn() });
        await this.registrationClient.updateAccount(externalId, { credentials: validated.patch });
        items.push({ account_id: externalId, nfapi_account_id: nfapiId, ok: true });
      } catch (error) {
        items.push({
          account_id: externalId,
          nfapi_account_id: Number.isSafeInteger(nfapiId) ? nfapiId : 0,
          ok: false,
          error: safeErrorMessage(error),
        });
      }
    }
    const synced = items.filter((item) => item.ok).length;
    return { attempted: items.length, synced, failed: items.length - synced, items };
  }

  close() {
    return this.store?.close?.();
  }
}
