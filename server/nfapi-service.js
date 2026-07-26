import crypto from "node:crypto";
import { getSetting, nowIso, setSetting } from "./db.js";
import { NfapiClient, redactNfapiMessage } from "./nfapi-client.js";
import { registerOpenAiAgentIdentity } from "./openai-agent-identity.js";

const DEFAULT_BASE_URL = "";
const NFAPI_OAUTH_CALLBACK = "http://localhost:1455/auth/callback";
const DEFAULT_OAUTH_SESSION_TTL_MS = 25 * 60_000;
const DEFAULT_AGENT_IDENTITY_PENDING_TTL_MS = 30 * 60_000;
const MAX_CALLBACK_URL_LENGTH = 16_384;
const OAUTH_SESSION_PAYLOAD_VERSION = 2;
export const PUBLIC_AGENT_IDENTITY_ERROR_CODES = new Set([
  "OPENAI_AGENT_IDENTITY_UNAUTHORIZED",
  "OPENAI_AGENT_IDENTITY_FORBIDDEN",
  "OPENAI_AGENT_IDENTITY_UPSTREAM_CHALLENGE",
]);
const DEFAULT_MODEL_MAPPING = {
  "gpt-5.5": "gpt-5.5",
  "gpt-5.6-sol": "gpt-5.6-sol",
  "gpt-5.6-terra": "gpt-5.6-terra",
  "gpt-5.6-luna": "gpt-5.6-luna",
};
const DEFAULT_TEMP_RULES = [
  { error_code: 429, keywords: ["rate limit", "too many requests", "quota"], duration_minutes: 60, description: "rate limit" },
  { error_code: 529, keywords: ["overloaded", "too many"], duration_minutes: 60, description: "overloaded" },
  { error_code: 503, keywords: ["unavailable", "overloaded"], duration_minutes: 30, description: "unavailable" },
];
export const DEFAULT_NFAPI_IMPORT_OPTIONS = Object.freeze({
  name_prefix: "",
  account_name: "",
  notes: "AliasHub 注册账号导入",
  status: "active",
  model_mapping: DEFAULT_MODEL_MAPPING,
  compact_model_mapping: {},
  proxy_id: 0,
  concurrency: 10,
  load_factor: 1,
  priority: 1,
  rate_multiplier: 1,
  expires_at: null,
  auto_pause_on_expired: true,
  temp_unschedulable_enabled: false,
  temp_unschedulable_rules: DEFAULT_TEMP_RULES,
  ws_mode: "ctx_pool",
  openai_passthrough: true,
  codex_cli_only: true,
  allow_app_server: true,
  compact_mode: "auto",
  image_bridge_mode: "inherit",
  auto_pause_5h_disabled: false,
  auto_pause_5h_threshold: null,
  auto_pause_7d_disabled: false,
  auto_pause_7d_threshold: null,
  group_ids: [],
  update_existing: true,
  skip_default_group_bind: false,
  confirm_mixed_channel_risk: false,
});

function errorWithStatus(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function text(value, maximum, label) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw errorWithStatus(`${label}必须是字符串`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw errorWithStatus(`${label}不能超过 ${maximum} 个字符`);
  return normalized;
}

function integer(value, fallback, minimum, maximum, label) {
  if (value === "" || value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw errorWithStatus(`${label}必须是 ${minimum} 到 ${maximum} 的整数`);
  }
  return number;
}

function decimal(value, fallback, minimum, maximum, label) {
  if (value === "" || value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw errorWithStatus(`${label}必须在 ${minimum} 到 ${maximum} 之间`);
  }
  return number;
}

function boolean(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw errorWithStatus(`${label}必须是布尔值`);
  return value;
}

export function normalizeNfapiBaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let parsed;
  try { parsed = new URL(raw); } catch { throw errorWithStatus("SUB2 兼容服务地址格式无效"); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw errorWithStatus("SUB2 兼容服务地址必须是 http 或 https 地址，且不能包含账号密码");
  }
  parsed.search = "";
  parsed.hash = "";
  const pathname = parsed.pathname.replace(/\/+$/, "").replace(/\/(?:admin|api)(?:\/.*)?$/i, "");
  return `${parsed.origin}${pathname}`;
}

function mappingFrom(value, label) {
  if (value === undefined || value === null || value === "") return {};
  let source = value;
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return {};
    if (raw.startsWith("{")) {
      try { source = JSON.parse(raw); } catch { throw errorWithStatus(`${label} JSON 格式无效`); }
    } else {
      source = {};
      raw.split(/\r?\n/).forEach((line) => {
        const match = line.trim().match(/^(.+?)(?:=>|=|:)(.+)$/);
        if (match) source[match[1].trim()] = match[2].trim();
      });
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) throw errorWithStatus(`${label}格式无效`);
  const result = {};
  for (const [from, to] of Object.entries(source)) {
    const cleanFrom = String(from || "").trim();
    const cleanTo = String(to || "").trim();
    if (cleanFrom && cleanTo) result[cleanFrom] = cleanTo;
  }
  if (Object.keys(result).length > 100) throw errorWithStatus(`${label}最多 100 条`);
  return result;
}

function tempRulesFrom(value) {
  let source = value;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { throw errorWithStatus("临时不可调度规则 JSON 格式无效"); }
  }
  if (!Array.isArray(source)) throw errorWithStatus("临时不可调度规则必须是数组");
  if (source.length > 30) throw errorWithStatus("临时不可调度规则最多 30 条");
  return source.map((item) => {
    const errorCode = integer(item?.error_code, null, 100, 599, "错误码");
    const duration = integer(item?.duration_minutes, null, 1, 10_080, "暂停分钟数");
    const keywords = (Array.isArray(item?.keywords) ? item.keywords : String(item?.keywords || "").split(/[,;，；]/))
      .map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 30);
    if (!keywords.length) throw errorWithStatus("每条临时不可调度规则至少需要一个关键词");
    return { error_code: errorCode, keywords, duration_minutes: duration, description: text(item?.description || "", 120, "规则说明") };
  });
}

function expirationFrom(value) {
  if (value === "" || value === undefined || value === null) return null;
  const numeric = Number(value);
  const seconds = Number.isSafeInteger(numeric) && numeric > 0
    ? numeric
    : Math.floor(Date.parse(String(value)) / 1000);
  if (!Number.isFinite(seconds)) throw errorWithStatus("过期时间格式无效");
  if (seconds <= Math.floor(Date.now() / 1000)) throw errorWithStatus("过期时间必须晚于当前时间");
  return seconds;
}

function percentFrom(value, label) {
  if (value === "" || value === undefined || value === null) return null;
  return decimal(value, null, 0.01, 100, label);
}

export function normalizeNfapiImportOptions(input = {}, stored = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw errorWithStatus("SUB2 兼容服务导入设置格式无效");
  const merged = { ...DEFAULT_NFAPI_IMPORT_OPTIONS, ...(stored || {}), ...input };
  const status = String(merged.status || "active").trim().toLowerCase();
  if (!["active", "inactive", "error"].includes(status)) throw errorWithStatus("账号状态无效");
  const wsMode = String(merged.ws_mode || "ctx_pool").trim().toLowerCase();
  if (!["off", "ctx_pool", "passthrough", "http_bridge"].includes(wsMode)) throw errorWithStatus("WS 模式无效");
  const compactMode = String(merged.compact_mode || "auto").trim().toLowerCase();
  if (!["auto", "force_on", "force_off"].includes(compactMode)) throw errorWithStatus("Compact 模式无效");
  const imageBridgeMode = String(merged.image_bridge_mode || "inherit").trim().toLowerCase();
  if (!["inherit", "enabled", "disabled"].includes(imageBridgeMode)) throw errorWithStatus("图片桥接模式无效");
  const groupIds = [...new Set((Array.isArray(merged.group_ids) ? merged.group_ids : []).map(Number))];
  if (groupIds.some((id) => !Number.isSafeInteger(id) || id <= 0) || groupIds.length > 100) {
    throw errorWithStatus("SUB2 兼容服务分组选择无效");
  }
  return {
    name_prefix: text(merged.name_prefix || "", 80, "名称前缀"),
    account_name: text(merged.account_name || "", 120, "账号名称"),
    notes: text(merged.notes || "", 2_000, "备注"),
    status,
    model_mapping: mappingFrom(merged.model_mapping, "模型映射"),
    compact_model_mapping: mappingFrom(merged.compact_model_mapping, "Compact 模型映射"),
    proxy_id: integer(merged.proxy_id, 0, 0, 1_000_000, "代理 ID"),
    concurrency: integer(merged.concurrency, 10, 1, 1_000, "并发数"),
    load_factor: integer(merged.load_factor, 1, 0, 10_000, "负载因子"),
    priority: integer(merged.priority, 1, 0, 10_000, "优先级"),
    rate_multiplier: decimal(merged.rate_multiplier, 1, 0, 1_000, "账号计费倍率"),
    expires_at: expirationFrom(merged.expires_at),
    auto_pause_on_expired: boolean(merged.auto_pause_on_expired, true, "过期自动暂停"),
    temp_unschedulable_enabled: boolean(merged.temp_unschedulable_enabled, false, "临时不可调度"),
    temp_unschedulable_rules: tempRulesFrom(merged.temp_unschedulable_rules || DEFAULT_TEMP_RULES),
    ws_mode: wsMode,
    openai_passthrough: boolean(merged.openai_passthrough, true, "API 上下文透传"),
    codex_cli_only: boolean(merged.codex_cli_only, true, "仅 Codex 客户端"),
    allow_app_server: boolean(merged.allow_app_server, true, "允许 Codex App Server"),
    compact_mode: compactMode,
    image_bridge_mode: imageBridgeMode,
    auto_pause_5h_disabled: boolean(merged.auto_pause_5h_disabled, false, "5 小时自动暂停禁用"),
    auto_pause_5h_threshold: percentFrom(merged.auto_pause_5h_threshold, "5 小时阈值"),
    auto_pause_7d_disabled: boolean(merged.auto_pause_7d_disabled, false, "7 天自动暂停禁用"),
    auto_pause_7d_threshold: percentFrom(merged.auto_pause_7d_threshold, "7 天阈值"),
    group_ids: groupIds,
    update_existing: boolean(merged.update_existing, true, "更新已有账号"),
    skip_default_group_bind: boolean(merged.skip_default_group_bind, false, "跳过默认分组"),
    confirm_mixed_channel_risk: boolean(merged.confirm_mixed_channel_risk, false, "确认混合渠道风险"),
  };
}

function parseJwtClaims(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!header || typeof header !== "object" || Array.isArray(header)
      || !claims || typeof claims !== "object" || Array.isArray(claims)) return null;
    return claims;
  } catch {
    return null;
  }
}

function decodeJwt(value) {
  return parseJwtClaims(value) || {};
}

function identityText(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim();
}

function consistentIdentity(values, label, { caseInsensitive = false, status = 409 } = {}) {
  const present = values.map(identityText).filter(Boolean);
  const normalized = present.map((value) => (caseInsensitive ? value.toLowerCase() : value));
  if (new Set(normalized).size > 1) {
    throw errorWithStatus(`${label}身份字段不一致`, status);
  }
  return present[0] || "";
}

function jwtIdentitySources(claims = {}) {
  const auth = claims["https://api.openai.com/auth"] && typeof claims["https://api.openai.com/auth"] === "object"
    ? claims["https://api.openai.com/auth"] : {};
  const profile = claims["https://api.openai.com/profile"] && typeof claims["https://api.openai.com/profile"] === "object"
    ? claims["https://api.openai.com/profile"] : {};
  return {
    emails: [claims.email, profile.email],
    accountIds: [auth.chatgpt_account_id, auth.account_id],
    userIds: [auth.chatgpt_user_id, auth.user_id],
    subjects: [claims.sub],
    fedRamp: auth.chatgpt_account_is_fedramp,
  };
}

function singleSourceId(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw errorWithStatus("SUB2 兼容服务 OAuth 导入请求格式无效");
  const supplied = input.id === undefined ? input.ids : [input.id];
  if (!Array.isArray(supplied) || supplied.length !== 1) throw errorWithStatus("SUB2 兼容服务 OAuth 每次只能授权一个账号");
  const id = Number(supplied[0]);
  if (!Number.isSafeInteger(id) || id <= 0) throw errorWithStatus("SUB2 兼容服务 OAuth 账号选择无效");
  return id;
}

function singleAgentIdentitySourceId(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw errorWithStatus("NFapi Agent Identity 导入请求格式无效");
  const supplied = input.id === undefined ? input.ids : [input.id];
  if (!Array.isArray(supplied) || supplied.length !== 1) throw errorWithStatus("NFapi Agent Identity 每次只能导入一个账号");
  const id = Number(supplied[0]);
  if (!Number.isSafeInteger(id) || id <= 0) throw errorWithStatus("NFapi Agent Identity 账号选择无效");
  return id;
}

function parseAuthorizationStart(result) {
  const authUrl = String(result?.auth_url || "").trim();
  const upstreamSessionId = String(result?.session_id || "").trim();
  if (!authUrl || !upstreamSessionId || upstreamSessionId.length > 1_024) {
    throw errorWithStatus("SUB2 兼容服务没有返回有效的 OAuth 会话", 502);
  }
  let parsed;
  try { parsed = new URL(authUrl); } catch { throw errorWithStatus("SUB2 兼容服务返回的 OAuth 授权地址无效", 502); }
  const states = parsed.searchParams.getAll("state").filter(Boolean);
  const redirectUris = parsed.searchParams.getAll("redirect_uri").filter(Boolean);
  if (parsed.protocol !== "https:" || parsed.hostname !== "auth.openai.com" || parsed.pathname !== "/oauth/authorize"
    || parsed.username || parsed.password
    || states.length !== 1 || states[0].length > 2_048
    || redirectUris.length !== 1 || redirectUris[0] !== NFAPI_OAUTH_CALLBACK) {
    throw errorWithStatus("SUB2 兼容服务返回的 OAuth 授权地址不符合预期", 502);
  }
  return { authUrl: parsed.toString(), upstreamSessionId, expectedState: states[0] };
}

function authorizationForEmail(authorization, email) {
  const parsed = new URL(authorization.authUrl);
  parsed.searchParams.set("login_hint", String(email || "").trim());
  return parseAuthorizationStart({
    auth_url: parsed.toString(),
    session_id: authorization.upstreamSessionId,
  });
}

function parseOAuthCallback(callbackUrl) {
  if (typeof callbackUrl !== "string" || !callbackUrl.trim() || callbackUrl.length > MAX_CALLBACK_URL_LENGTH) {
    throw errorWithStatus("OAuth 回调地址无效");
  }
  let parsed;
  try { parsed = new URL(callbackUrl.trim()); } catch { throw errorWithStatus("OAuth 回调地址无效"); }
  const codes = parsed.searchParams.getAll("code").filter(Boolean);
  const states = parsed.searchParams.getAll("state").filter(Boolean);
  if (parsed.protocol !== "http:" || parsed.hostname !== "localhost" || parsed.port !== "1455"
    || parsed.pathname !== "/auth/callback" || parsed.username || parsed.password || parsed.hash
    || codes.length !== 1 || states.length !== 1 || codes[0].length > 12_000 || states[0].length > 2_048) {
    throw errorWithStatus("OAuth 回调地址无效");
  }
  return { code: codes[0], state: states[0] };
}

function equalSecret(left, right) {
  const first = Buffer.from(String(left || ""));
  const second = Buffer.from(String(right || ""));
  return first.length === second.length && first.length > 0 && crypto.timingSafeEqual(first, second);
}

function tokenInfoFrom(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw errorWithStatus("SUB2 兼容服务 OAuth Token 响应无效", 502);
  const accessToken = String(value.access_token || "").trim();
  const refreshToken = String(value.refresh_token || "").trim();
  const idToken = String(value.id_token || "").trim();
  if (!accessToken) throw errorWithStatus("SUB2 兼容服务 OAuth 未返回可用凭据", 502);
  const accessClaims = decodeJwt(accessToken);
  const idClaims = decodeJwt(idToken);
  const accessIdentity = jwtIdentitySources(accessClaims);
  const idIdentity = jwtIdentitySources(idClaims);
  const expiresAt = Number(value.expires_at || accessClaims.exp || 0);
  const identity = {
    email: consistentIdentity(
      [value.email, ...accessIdentity.emails, ...idIdentity.emails],
      "SUB2 兼容服务 OAuth Token 邮箱",
      { caseInsensitive: true },
    ),
    accountId: consistentIdentity(
      [value.chatgpt_account_id, value.account_id, ...accessIdentity.accountIds, ...idIdentity.accountIds],
      "SUB2 兼容服务 OAuth Token workspace",
    ),
    userId: consistentIdentity(
      [value.chatgpt_user_id, value.user_id, ...accessIdentity.userIds, ...idIdentity.userIds],
      "SUB2 兼容服务 OAuth Token 用户",
    ),
  };
  consistentIdentity([...accessIdentity.subjects, ...idIdentity.subjects], "SUB2 兼容服务 OAuth Token subject");
  const credentials = { access_token: accessToken, email: identity.email, chatgpt_account_id: identity.accountId };
  if (refreshToken) credentials.refresh_token = refreshToken;
  if (idToken) credentials.id_token = idToken;
  if (identity.userId) credentials.chatgpt_user_id = identity.userId;
  if (expiresAt > 0) credentials.expires_at = expiresAt;
  for (const [sourceKey, targetKey] of [
    ["organization_id", "organization_id"], ["plan_type", "plan_type"],
    ["client_id", "client_id"], ["subscription_expires_at", "subscription_expires_at"],
  ]) {
    const item = String(value[sourceKey] || "").trim();
    if (item) credentials[targetKey] = item;
  }
  return {
    credentials,
    identity,
    longLived: Boolean(refreshToken),
    secrets: [accessToken, refreshToken, idToken].filter(Boolean),
  };
}

function oauthCredentialsForUpdate(existingAccount, token) {
  const current = existingAccount?.credentials;
  const preserved = {};
  const agentOnlyKeys = new Set([
    "auth_mode",
    "openai_auth_mode",
    "agent_runtime_id",
    "agent_private_key",
    "task_id",
  ]);
  if (current && typeof current === "object" && !Array.isArray(current)) {
    for (const [key, value] of Object.entries(current)) {
      const normalizedKey = String(key)
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .toLowerCase();
      if (agentOnlyKeys.has(normalizedKey)
        || /(?:token|secret|password|cookie|session|authorization|credential)/.test(normalizedKey)) continue;
      preserved[key] = value;
    }
  }
  return { ...preserved, ...token.credentials };
}

function validateTokenIdentity(expected, actual) {
  const expectedEmail = String(expected?.email || "").trim().toLowerCase();
  const expectedAccountId = String(expected?.accountId || "").trim();
  const actualEmail = String(actual?.email || "").trim().toLowerCase();
  const actualAccountId = String(actual?.accountId || "").trim();
  const expectedUserId = String(expected?.userId || "").trim();
  const actualUserId = String(actual?.userId || "").trim();
  if (!expectedEmail || !expectedAccountId || !actualEmail || !actualAccountId
    || expectedEmail !== actualEmail || expectedAccountId !== actualAccountId
    || (expectedUserId && (!actualUserId || expectedUserId !== actualUserId))) {
    throw errorWithStatus("OAuth 登录账号与所选注册账号不匹配", 409);
  }
}

function registrationCredentials(account = {}) {
  const values = {};
  if (Array.isArray(account.credentials)) {
    account.credentials.forEach((item) => {
      if (item?.key && item?.value !== undefined && item?.value !== null && item.value !== "") values[item.key] = String(item.value);
    });
  } else if (account.credentials && typeof account.credentials === "object") {
    Object.assign(values, account.credentials);
  }
  const accessToken = String(values.access_token || values.accessToken || account.primary_token || "").trim();
  const refreshToken = String(values.refresh_token || values.refreshToken || "").trim();
  const idToken = String(values.id_token || values.idToken || "").trim();
  const clientId = String(values.client_id || values.clientId || values.oauth_client_id || "").trim();
  const accessClaims = decodeJwt(accessToken);
  const idClaims = decodeJwt(idToken);
  const accessIdentity = jwtIdentitySources(accessClaims);
  const idIdentity = jwtIdentitySources(idClaims);
  const explicitTopAccountId = identityText(account.account_id || account.workspace_id || account.chatgpt_account_id);
  // Frcibly's ChatGPT adapter stores the workspace/account UUID in its legacy
  // top-level user_id field when no explicit account-id field is available.
  const legacyTopAccountId = explicitTopAccountId ? "" : identityText(account.user_id);
  const topUserId = explicitTopAccountId
    ? identityText(account.chatgpt_user_id || account.user_id)
    : identityText(account.chatgpt_user_id);
  const expiresAt = Number(accessClaims.exp || 0);
  const email = consistentIdentity(
    [account.email, values.email, ...accessIdentity.emails, ...idIdentity.emails],
    "注册账号邮箱",
    { caseInsensitive: true },
  );
  const accountId = consistentIdentity([
    explicitTopAccountId,
    legacyTopAccountId,
    values.chatgpt_account_id,
    values.account_id,
    values.workspace_id,
    ...accessIdentity.accountIds,
    ...idIdentity.accountIds,
  ], "注册账号 workspace");
  const userId = consistentIdentity([
    topUserId,
    values.chatgpt_user_id,
    values.user_id,
    ...accessIdentity.userIds,
    ...idIdentity.userIds,
  ], "注册账号用户");
  consistentIdentity([...accessIdentity.subjects, ...idIdentity.subjects], "注册账号 subject");
  const explicitFedRamp = values.chatgpt_account_is_fedramp ?? values.chatgptAccountIsFedramp;
  const fedRamp = explicitFedRamp === true || String(explicitFedRamp || "").toLowerCase() === "true"
    || accessIdentity.fedRamp === true || idIdentity.fedRamp === true;
  return {
    accessToken,
    refreshToken,
    idToken,
    clientId,
    email,
    accountId,
    userId,
    planType: String(values.plan_type || accessClaims["https://api.openai.com/auth"]?.chatgpt_plan_type || account.plan_name || account.plan_state || "free").trim(),
    expiresAt: expiresAt > 0 ? expiresAt : null,
    fedRamp,
  };
}

function assertCurrentSourceMatchesSnapshot(current, snapshot) {
  const currentId = Number(current?.id || 0);
  const snapshotId = Number(snapshot?.id || 0);
  const currentEmail = identityText(current?.credentials?.email || current?.account?.email).toLowerCase();
  const snapshotEmail = identityText(snapshot?.credentials?.email || snapshot?.account?.email).toLowerCase();
  const currentAccountId = identityText(current?.credentials?.accountId);
  const snapshotAccountId = identityText(snapshot?.credentials?.accountId);
  const currentUserId = identityText(current?.credentials?.userId);
  const snapshotUserId = identityText(snapshot?.credentials?.userId);
  if (!Number.isSafeInteger(currentId) || currentId <= 0 || currentId !== snapshotId
    || !currentEmail || currentEmail !== snapshotEmail
    || !currentAccountId || currentAccountId !== snapshotAccountId
    || currentUserId !== snapshotUserId) {
    throw errorWithStatus("注册账号身份在 OAuth 授权期间已变化，请重新开始", 409);
  }
}

function nfapiIdentity(account = {}) {
  const credentials = account.credentials || {};
  const extra = account.extra || {};
  return {
    id: Number(account.id || 0),
    accountId: String(credentials.chatgpt_account_id || credentials.account_id || extra.chatgpt_account_id || extra.account_id || "").trim(),
    userId: String(credentials.chatgpt_user_id || credentials.user_id || extra.chatgpt_user_id || extra.user_id || "").trim(),
    email: String(credentials.email || credentials.authorized_account_email || extra.email || extra.authorized_account_email || "").trim().toLowerCase(),
  };
}

function identityCompatible(expected = {}, actual = {}) {
  const email = String(expected.email || "").trim().toLowerCase();
  const accountId = String(expected.accountId || "").trim();
  const userId = String(expected.userId || "").trim();
  if (!email || actual.email !== email) return false;
  if (accountId && actual.accountId && actual.accountId !== accountId) return false;
  if (userId && actual.userId && actual.userId !== userId) return false;
  return Boolean(
    (accountId && actual.accountId === accountId)
    || (userId && actual.userId === userId),
  );
}

function identityComplete(expected = {}, actual = {}) {
  const email = String(expected.email || "").trim().toLowerCase();
  const accountId = String(expected.accountId || "").trim();
  const userId = String(expected.userId || "").trim();
  return Boolean(email && accountId && userId
    && actual.email === email
    && actual.accountId === accountId
    && actual.userId === userId);
}

function controlledExtra(options, source, { includeResets = false } = {}) {
  const extra = {};
  extra.import_source = "aliashub_registration";
  extra.aliashub_external_account_id = String(source.id);
  extra.aliashub_email = source.account.email;
  if (source.custom_name) extra.aliashub_custom_name = source.custom_name;
  if (source.group_name) extra.aliashub_group_name = source.group_name;
  extra.openai_passthrough = options.openai_passthrough;
  extra.openai_oauth_passthrough = options.openai_passthrough;
  const forceHttp = options.ws_mode === "http_bridge";
  extra.openai_oauth_responses_websockets_v2_mode = forceHttp ? "off" : options.ws_mode;
  extra.openai_oauth_responses_websockets_v2_enabled = !["off", "http_bridge"].includes(options.ws_mode);
  extra.openai_ws_force_http = forceHttp;
  extra.codex_cli_only = options.codex_cli_only;
  extra.codex_cli_only_allow_app_server = options.codex_cli_only && options.allow_app_server;
  if (options.compact_mode !== "auto") extra.openai_compact_mode = options.compact_mode;
  else if (includeResets) extra.openai_compact_mode = null;
  if (options.image_bridge_mode === "enabled") extra.codex_image_generation_bridge = true;
  if (options.image_bridge_mode === "disabled") extra.codex_image_generation_bridge = false;
  if (options.image_bridge_mode === "inherit" && includeResets) extra.codex_image_generation_bridge = null;
  if (includeResets) extra.codex_image_generation_explicit_tool_policy = null;
  extra.auto_pause_5h_disabled = options.auto_pause_5h_disabled;
  if (options.auto_pause_5h_threshold !== null) extra.auto_pause_5h_threshold = options.auto_pause_5h_threshold / 100;
  else if (includeResets) extra.auto_pause_5h_threshold = null;
  extra.auto_pause_7d_disabled = options.auto_pause_7d_disabled;
  if (options.auto_pause_7d_threshold !== null) extra.auto_pause_7d_threshold = options.auto_pause_7d_threshold / 100;
  else if (includeResets) extra.auto_pause_7d_threshold = null;
  return extra;
}

function controlledCredentials(options) {
  return {
    model_mapping: options.model_mapping,
    compact_model_mapping: options.compact_model_mapping,
    temp_unschedulable_enabled: options.temp_unschedulable_enabled,
    temp_unschedulable_rules: options.temp_unschedulable_enabled ? options.temp_unschedulable_rules : [],
  };
}

function validateAgentIdentitySource(source, now) {
  const credentials = source?.credentials || {};
  if (!credentials.accessToken) throw errorWithStatus("注册账号缺少 access token，请改用 OAuth 导入", 409);
  const claims = parseJwtClaims(credentials.accessToken);
  if (!claims) throw errorWithStatus("注册账号 access token 不是可解析 JWT，请改用 OAuth 导入", 409);
  if (!Number.isSafeInteger(claims.exp) || claims.exp <= 0) {
    throw errorWithStatus("注册账号 access token 缺少有效 exp，请改用 OAuth 导入", 409);
  }
  if (!credentials.email || !credentials.accountId || !credentials.userId) {
    throw errorWithStatus("注册账号缺少可核验的邮箱、workspace ID 或用户 ID，无法创建 Agent Identity", 409);
  }
  if (claims.exp <= Math.floor(now.getTime() / 1_000) + 120) {
    throw errorWithStatus("注册账号 access token 已过期或即将过期，请改用 OAuth 导入", 409);
  }
  return credentials;
}

function agentIdentityImportPayload(authJson, source, name, options) {
  return {
    content: JSON.stringify(authJson),
    name,
    notes: options.notes || null,
    group_ids: options.group_ids,
    proxy_id: options.proxy_id > 0 ? options.proxy_id : null,
    concurrency: options.concurrency,
    priority: options.priority,
    rate_multiplier: options.rate_multiplier,
    load_factor: options.load_factor,
    expires_at: 0,
    auto_pause_on_expired: false,
    credential_extras: controlledCredentials(options),
    extra: {
      ...controlledExtra(options, source),
      access_token_sha256: null,
      session_token_present: null,
      session_expires_at: null,
      auth_provider: null,
    },
    update_existing: options.update_existing,
    skip_default_group_bind: options.skip_default_group_bind,
    confirm_mixed_channel_risk: options.confirm_mixed_channel_risk,
  };
}

function parseAgentIdentityImportResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw errorWithStatus("NFapi Agent Identity 导入响应无效", 502);
  }
  const counts = Object.fromEntries(["created", "updated", "skipped", "failed"].map((key) => [key, value[key]]));
  const total = value.total;
  const items = Array.isArray(value.items) ? value.items : [];
  if (!Number.isSafeInteger(total) || total !== 1
    || Object.values(counts).some((count) => !Number.isSafeInteger(count) || count < 0)
    || Object.values(counts).reduce((sum, count) => sum + count, 0) !== 1
    || items.length !== 1) {
    throw errorWithStatus("NFapi Agent Identity 导入统计无效", 502);
  }
  if (counts.failed === 1) {
    const failedItem = items[0];
    if (String(failedItem?.action || "") !== "failed") {
      throw errorWithStatus("NFapi Agent Identity 导入响应无效", 502);
    }
    const detail = value.errors?.[0]?.message || failedItem?.message;
    const error = errorWithStatus(String(detail || "NFapi Agent Identity 导入失败"), 502);
    Object.defineProperty(error, "agentImportOutcome", { value: "failed_confirmed" });
    throw error;
  }
  const item = items[0];
  const action = String(item?.action || "");
  const accountId = item?.account_id;
  if (!item
    || !["created", "updated", "skipped"].includes(action)
    || counts[action] !== 1
    || !Number.isSafeInteger(accountId) || accountId <= 0) {
    throw errorWithStatus("NFapi Agent Identity 导入未返回唯一的账号结果", 502);
  }
  return { action, accountId };
}

function durableAgentIdentityStatus(account, source) {
  const credentials = account?.credentials && typeof account.credentials === "object" && !Array.isArray(account.credentials)
    ? account.credentials : {};
  const mode = String(account?.auth_mode || credentials.auth_mode || "").trim().toLowerCase();
  const status = account?.credentials_status;
  return mode === "agentidentity"
    && identityComplete(source?.credentials, nfapiIdentity(account))
    && status?.has_agent_private_key === true
    && status.has_access_token !== true
    && status.has_refresh_token !== true
    && status.has_id_token !== true
    && !["client_id", "expires_at", "expires_in", "scope", "token_type", "openai_auth_mode"]
      .some((key) => Object.hasOwn(credentials, key))
    && [undefined, null, 0].includes(account?.expires_at)
    && account?.auto_pause_on_expired === false;
}

const AGENT_IDENTITY_OAUTH_TOKEN_KEYS = ["access_token", "refresh_token", "id_token"];
const AGENT_IDENTITY_OAUTH_METADATA_KEYS = [
  "client_id",
  "expires_at",
  "expires_in",
  "scope",
  "token_type",
  "openai_auth_mode",
];

function agentIdentityHasOAuthResidue(account) {
  const credentials = account?.credentials && typeof account.credentials === "object" && !Array.isArray(account.credentials)
    ? account.credentials : {};
  const status = account?.credentials_status || {};
  return status.has_access_token === true
    || status.has_refresh_token === true
    || status.has_id_token === true
    || AGENT_IDENTITY_OAUTH_METADATA_KEYS.some((key) => Object.hasOwn(credentials, key));
}

function agentIdentityOAuthCleanupCredentials(account) {
  const current = account?.credentials && typeof account.credentials === "object" && !Array.isArray(account.credentials)
    ? account.credentials : {};
  const credentials = { ...current };
  for (const key of AGENT_IDENTITY_OAUTH_METADATA_KEYS) delete credentials[key];
  for (const key of AGENT_IDENTITY_OAUTH_TOKEN_KEYS) credentials[key] = null;
  credentials.auth_mode = "agentIdentity";
  return credentials;
}

function validateAgentIdentityTarget(account, source, runtimeId, {
  requireLongLived = true,
  allowOAuthResidue = false,
} = {}) {
  const invalidTarget = (message, status = 502, { remediationRequired = false } = {}) => {
    const error = errorWithStatus(message, status);
    if (remediationRequired) {
      Object.defineProperty(error, "agentTargetRemediationRequired", { value: true });
    }
    return error;
  };
  const credentials = account?.credentials && typeof account.credentials === "object" && !Array.isArray(account.credentials)
    ? account.credentials : {};
  const mode = String(account?.auth_mode || credentials.auth_mode || "").trim().toLowerCase();
  if (mode !== "agentidentity") {
    throw invalidTarget("NFapi 目标账号未切换为 Agent Identity", 502, { remediationRequired: Boolean(mode) });
  }
  if (!identityComplete(source?.credentials, nfapiIdentity(account))) {
    throw invalidTarget("NFapi Agent Identity 目标账号身份不匹配", 409);
  }
  if (String(credentials.agent_runtime_id || "").trim() !== String(runtimeId || "").trim()) {
    throw invalidTarget("NFapi Agent Identity 目标账号 runtime 不匹配");
  }
  const status = account?.credentials_status;
  if (!status || status.has_agent_private_key !== true) {
    throw invalidTarget("NFapi Agent Identity 目标账号未保存签名密钥");
  }
  if (!allowOAuthResidue
    && (status.has_access_token === true || status.has_refresh_token === true || status.has_id_token === true)) {
    throw invalidTarget("NFapi Agent Identity 目标账号仍残留 OAuth Token", 502, { remediationRequired: true });
  }
  if (!allowOAuthResidue && AGENT_IDENTITY_OAUTH_METADATA_KEYS.some((key) => Object.hasOwn(credentials, key))) {
    throw invalidTarget("NFapi Agent Identity 目标账号仍残留 OAuth 元数据", 502, { remediationRequired: true });
  }
  if (requireLongLived
    && (![undefined, null, 0].includes(account?.expires_at)
      || account?.auto_pause_on_expired !== false)) {
    throw invalidTarget("NFapi Agent Identity 目标账号未设置为长期有效");
  }
}

function validateOAuthTarget(account) {
  const credentials = account?.credentials && typeof account.credentials === "object" && !Array.isArray(account.credentials)
    ? account.credentials : {};
  const mode = String(account?.auth_mode || credentials.auth_mode || credentials.openai_auth_mode || "")
    .trim().toLowerCase();
  if (mode === "agentidentity"
    || ["auth_mode", "openai_auth_mode", "agent_runtime_id", "agent_private_key", "task_id"]
      .some((key) => Object.hasOwn(credentials, key))
    || account?.credentials_status?.has_agent_private_key === true) {
    throw errorWithStatus("NFapi OAuth 目标账号仍残留 Agent Identity 凭据", 502);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function agentIdentityPayloadFingerprint(payload) {
  return crypto.createHash("sha256").update(stableJson(payload)).digest("hex");
}

function importFailureIsConfirmed(error) {
  if (error?.agentImportOutcome === "failed_confirmed") return true;
  const status = Number(error?.upstreamStatus || error?.status || 0);
  return Number.isInteger(status) && status >= 400 && status < 500
    && ![408, 409, 425, 429].includes(status);
}

function agentIdentityOperationKey(baseUrl, sourceId, accountId, runtimeId, importAttempt) {
  return `aliashub-agent-${crypto.createHash("sha256")
    .update(`${baseUrl}\0${sourceId}\0${accountId}\0${runtimeId}\0${importAttempt}`)
    .digest("hex")}`;
}

function safeNfapiMessage(client, value, source) {
  const sourceSecrets = Object.values(source?.credentials || {}).filter((item) => typeof item === "string");
  return redactNfapiMessage(value, [client?.apiKey, ...sourceSecrets]);
}

function nfapiHasDurableAuth(account = {}) {
  return Boolean(
    account?.credentials_status?.has_refresh_token
    || account?.credentials?.refresh_token
    || String(account?.credentials?.auth_mode || "").trim().toLowerCase() === "agentidentity",
  );
}

function publicGroup(item = {}) {
  return {
    id: Number(item.id),
    name: String(item.name || `分组 ${item.id || ""}`),
    platform: String(item.platform || ""),
    status: String(item.status || ""),
    account_count: Number(item.account_count || 0),
  };
}

function publicProxy(item = {}) {
  return {
    id: Number(item.id),
    name: String(item.name || `代理 ${item.id || ""}`),
    status: String(item.status || ""),
    protocol: String(item.protocol || ""),
    ip_address: String(item.ip_address || item.ipAddress || ""),
    country: String(item.country || ""),
    country_code: String(item.country_code || item.countryCode || ""),
    latency_ms: item.latency_ms ?? item.latencyMs ?? null,
  };
}

export class NfapiService {
  constructor({
    db,
    registrationClient,
    encryptionKey,
    fetchFn,
    baseUrl,
    apiKey,
    oauthSessionTtlMs = DEFAULT_OAUTH_SESSION_TTL_MS,
    agentIdentityPendingTtlMs = DEFAULT_AGENT_IDENTITY_PENDING_TTL_MS,
    agentIdentityFetchFn,
    agentIdentityRegistrar = registerOpenAiAgentIdentity,
    agentIdentityVersion,
    nowFn = () => new Date(),
  } = {}) {
    this.db = db;
    this.registrationClient = registrationClient;
    this.fetchFn = fetchFn || globalThis.fetch;
    this.baseUrlOverride = baseUrl ? normalizeNfapiBaseUrl(baseUrl) : "";
    this.apiKeyOverride = String(apiKey || "").trim();
    this.encryptionKey = crypto.createHash("sha256")
      .update(String(encryptionKey || process.env.DATA_ENCRYPTION_KEY || "aliashub-development-key"))
      .digest();
    this.oauthSessionTtlMs = Math.max(1_000, Math.min(30 * 60_000, Number(oauthSessionTtlMs) || DEFAULT_OAUTH_SESSION_TTL_MS));
    this.agentIdentityPendingTtlMs = Math.max(5 * 60_000, Math.min(2 * 60 * 60_000,
      Number(agentIdentityPendingTtlMs) || DEFAULT_AGENT_IDENTITY_PENDING_TTL_MS));
    this.agentIdentityFetchFn = agentIdentityFetchFn || globalThis.fetch;
    this.agentIdentityRegistrar = agentIdentityRegistrar;
    this.agentIdentityVersion = String(agentIdentityVersion || process.env.CODEX_AGENT_VERSION || "0.144.0");
    this.nowFn = nowFn;
    this.oauthStartLocks = new Map();
    this.agentIdentityImportLocks = new Map();
    // Registration succeeds before NFapi import. Keep the generated identity and
    // the current import operation in process for bounded, replay-safe recovery.
    // Private material and idempotency state are never persisted.
    this.pendingAgentIdentities = new Map();
  }

  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  decrypt(value) {
    const [version, iv, tag, encrypted] = String(value || "").split(".");
    if (version !== "v1" || !iv || !tag || !encrypted) throw errorWithStatus("SUB2 兼容服务加密数据无法解密", 500);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  }

  baseUrl() {
    return this.baseUrlOverride || normalizeNfapiBaseUrl(getSetting(this.db, "nfapi_base_url", DEFAULT_BASE_URL));
  }

  apiKey() {
    if (this.apiKeyOverride) return this.apiKeyOverride;
    const encrypted = getSetting(this.db, "nfapi_admin_api_key_encrypted", "");
    return encrypted ? this.decrypt(encrypted) : "";
  }

  configuration() {
    const configured = Boolean(this.baseUrl() && this.apiKey());
    return {
      base_url: this.baseUrl(),
      api_key_configured: Boolean(this.apiKey()),
      configured,
      connected: configured && Boolean(getSetting(this.db, "nfapi_last_connected_at", "")),
      last_connected_at: getSetting(this.db, "nfapi_last_connected_at", ""),
    };
  }

  updateConfiguration(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw errorWithStatus("SUB2 兼容服务连接设置格式无效");
    if (input.base_url !== undefined) setSetting(this.db, "nfapi_base_url", normalizeNfapiBaseUrl(input.base_url));
    if (input.clear_api_key === true) setSetting(this.db, "nfapi_admin_api_key_encrypted", "");
    if (input.admin_api_key !== undefined && input.admin_api_key !== "") {
      const apiKey = text(input.admin_api_key, 1_024, "SUB2 兼容服务 API Key");
      if (!apiKey) throw errorWithStatus("SUB2 兼容服务 API Key 不能为空");
      setSetting(this.db, "nfapi_admin_api_key_encrypted", this.encrypt(apiKey));
    }
    setSetting(this.db, "nfapi_last_connected_at", "");
    return this.configuration();
  }

  client() {
    return new NfapiClient({ baseUrl: this.baseUrl(), apiKey: this.apiKey(), fetchFn: this.fetchFn });
  }

  currentDate() {
    const value = this.nowFn();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw errorWithStatus("系统时间无效", 500);
    return date;
  }

  expireOAuthSessions(now = this.currentDate()) {
    this.db.prepare(`
      UPDATE nfapi_oauth_import_sessions
      SET status = 'expired', payload_encrypted = '', finished_at = ?, last_error = ''
      WHERE status IN ('pending', 'processing') AND expires_at <= ?
    `).run(now.toISOString(), now.toISOString());
  }

  finishOAuthSession(id, status, error = "") {
    const now = this.currentDate().toISOString();
    this.db.prepare(`
      UPDATE nfapi_oauth_import_sessions
      SET status = ?, payload_encrypted = '', finished_at = ?, last_error = ?
      WHERE id = ?
    `).run(status, now, String(error || "").slice(0, 1_000), id);
  }

  readOAuthSessionPayload(row, expectedSourceId) {
    let payload;
    try { payload = JSON.parse(this.decrypt(row?.payload_encrypted)); }
    catch { throw errorWithStatus("SUB2 兼容服务 OAuth 会话无法读取，请重新开始", 409); }
    const sourceId = Number(expectedSourceId || 0);
    if (!payload || payload.version !== OAUTH_SESSION_PAYLOAD_VERSION
      || payload.nfapiBaseUrl !== this.baseUrl()
      || !Number.isSafeInteger(sourceId) || sourceId <= 0
      || Number(row.external_account_id || 0) !== sourceId
      || Number(payload.source?.id || 0) !== sourceId
      || typeof payload.authUrl !== "string" || payload.authUrl !== payload.authUrl.trim()
      || typeof payload.upstreamSessionId !== "string" || payload.upstreamSessionId !== payload.upstreamSessionId.trim()
      || typeof payload.expectedState !== "string" || !payload.expectedState) {
      throw errorWithStatus("SUB2 兼容服务 OAuth 会话数据无效，请重新开始", 409);
    }
    let authorization;
    try {
      authorization = parseAuthorizationStart({
        auth_url: payload.authUrl,
        session_id: payload.upstreamSessionId,
      });
    } catch {
      throw errorWithStatus("SUB2 兼容服务 OAuth 会话数据无效，请重新开始", 409);
    }
    if (authorization.authUrl !== payload.authUrl
      || authorization.upstreamSessionId !== payload.upstreamSessionId
      || !equalSecret(authorization.expectedState, payload.expectedState)) {
      throw errorWithStatus("SUB2 兼容服务 OAuth 会话数据无效，请重新开始", 409);
    }
    return payload;
  }

  resumeOAuthSession(row, sourceId) {
    if (!row) return null;
    if (row.status === "processing") {
      throw errorWithStatus("这个账号的 SUB2 兼容服务 OAuth 回调正在处理，请等待处理完成", 409);
    }
    if (row.status !== "pending") return null;
    const expiresAt = new Date(row.expires_at);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= this.currentDate()) {
      throw errorWithStatus("SUB2 兼容服务 OAuth 会话已过期，请重新开始", 410);
    }
    const payload = this.readOAuthSessionPayload(row, sourceId);
    const existingAccountId = Number(payload.existingAccountId || 0);
    if (!Number.isSafeInteger(existingAccountId) || existingAccountId < 0) {
      throw errorWithStatus("SUB2 兼容服务 OAuth 会话数据无效，请重新开始", 409);
    }
    return {
      authorization_required: true,
      status: "pending",
      action: existingAccountId > 0 ? "reauthorize" : "create",
      oauth_session_id: row.id,
      auth_url: payload.authUrl,
      expires_at: row.expires_at,
      nfapi_account_id: existingAccountId,
    };
  }

  storedDefaults() {
    try {
      const parsed = JSON.parse(getSetting(this.db, "nfapi_import_defaults", "{}"));
      if (Number(parsed?.expires_at || 0) <= Math.floor(Date.now() / 1000)) parsed.expires_at = null;
      return normalizeNfapiImportOptions({}, parsed);
    } catch {
      return normalizeNfapiImportOptions();
    }
  }

  saveDefaults(options) {
    const value = { ...options, account_name: "" };
    setSetting(this.db, "nfapi_import_defaults", JSON.stringify(value));
  }

  async testConnection() {
    const client = this.client();
    const [groups, proxies, accounts] = await Promise.all([
      client.listGroups(), client.listProxies(), client.listOpenAiOauthAccounts(),
    ]);
    const result = {
      ...this.configuration(),
      connected: true,
      groups: Array.isArray(groups) ? groups.length : 0,
      proxies: Array.isArray(proxies) ? proxies.length : 0,
      accounts: Array.isArray(accounts) ? accounts.length : 0,
    };
    setSetting(this.db, "nfapi_last_connected_at", nowIso());
    result.last_connected_at = getSetting(this.db, "nfapi_last_connected_at", "");
    return result;
  }

  async options() {
    const connection = this.configuration();
    const result = { connection, defaults: this.storedDefaults(), groups: [], proxies: [] };
    if (!connection.configured) return result;
    try {
      const client = this.client();
      const [groups, proxies] = await Promise.all([client.listGroups(), client.listProxies()]);
      result.groups = (Array.isArray(groups) ? groups : []).map(publicGroup).filter((item) => item.id > 0);
      result.proxies = (Array.isArray(proxies) ? proxies : []).map(publicProxy).filter((item) => item.id > 0);
      result.connection = { ...connection, connected: true };
      setSetting(this.db, "nfapi_last_connected_at", nowIso());
    } catch (error) {
      result.error = error.message;
      result.connection = { ...connection, connected: false };
    }
    return result;
  }

  sourceRows(ids) {
    const placeholders = ids.map(() => "?").join(",");
    const jobs = this.db.prepare(`
      SELECT * FROM registration_jobs
      WHERE external_account_id IN (${placeholders}) AND status = 'completed'
      ORDER BY created_at DESC
    `).all(...ids.map(String));
    const metadata = new Map(this.db.prepare(`
      SELECT * FROM registered_account_metadata WHERE external_account_id IN (${placeholders})
    `).all(...ids.map(String)).map((item) => [String(item.external_account_id), item]));
    const rows = new Map();
    jobs.forEach((job) => {
      const id = String(job.external_account_id);
      if (!rows.has(id)) rows.set(id, { id: Number(id), job, ...(metadata.get(id) || {}) });
    });
    if (ids.some((id) => !rows.has(String(id)))) throw errorWithStatus("选择中包含不属于注册页面的账号", 409);
    return ids.map((id) => rows.get(String(id)));
  }

  async loadSources(ids) {
    const rows = this.sourceRows(ids);
    const sources = [];
    for (const row of rows) {
      const account = await this.registrationClient.getAccount(row.id);
      if (!account) throw errorWithStatus(`注册账号 #${row.id} 已不存在`, 404);
      if (Number(account.id) !== row.id
        || String(account.platform || "chatgpt").toLowerCase() !== "chatgpt"
        || String(account.email || "").toLowerCase() !== String(row.job.email || "").toLowerCase()) {
        throw errorWithStatus(`注册账号 #${row.id} 与任务记录不匹配`, 409);
      }
      sources.push({ ...row, account, credentials: registrationCredentials(account) });
    }
    return sources;
  }

  findExisting(accounts, source, preferredAccountId = 0) {
    const expected = source?.credentials || {};
    const candidates = (Array.isArray(accounts) ? accounts : [])
      .map((account) => ({ account, identity: nfapiIdentity(account) }))
      .filter((item) => item.identity.id > 0);
    const preferredId = Number(preferredAccountId || 0);
    if (preferredId > 0) {
      const preferred = candidates.find((item) => item.identity.id === preferredId);
      if (preferred) {
        if (!identityCompatible(expected, preferred.identity)) {
          throw errorWithStatus("AliasHub 已绑定的 SUB2 兼容服务账号身份不匹配，已停止以免更新错误账号", 409);
        }
        return preferred.account;
      }
    }

    const email = String(expected.email || "").trim().toLowerCase();
    const sameEmail = candidates.filter((item) => Boolean(email && item.identity.email === email));
    if (!sameEmail.length) return null;
    const complete = sameEmail.filter((item) => identityComplete(expected, item.identity));
    if (complete.length === 1) return complete[0].account;
    if (complete.length > 1) {
      throw errorWithStatus("SUB2 兼容服务中存在多个完全相同身份的 OAuth 账号，无法确定更新目标", 409);
    }
    const accountId = String(expected.accountId || "").trim();
    const samePair = sameEmail.filter((item) => Boolean(accountId && item.identity.accountId === accountId));
    if (samePair.length === 1 && !samePair[0].identity.userId) return samePair[0].account;
    if (samePair.length > 1) {
      throw errorWithStatus("SUB2 兼容服务中同一邮箱和 workspace 存在多个 OAuth 账号，无法确定更新目标", 409);
    }
    throw errorWithStatus("SUB2 兼容服务中存在同邮箱但用户、workspace 或身份字段不完整的账号，已停止以免更新错误账号", 409);
  }

  findAgentIdentityExisting(accounts, source, preferredAccountId = 0) {
    const expected = source?.credentials || {};
    const expectedAccountId = String(expected.accountId || "").trim();
    const expectedUserId = String(expected.userId || "").trim();
    const candidates = (Array.isArray(accounts) ? accounts : []).filter((account) => {
      const credentials = account?.credentials && typeof account.credentials === "object"
        && !Array.isArray(account.credentials) ? account.credentials : {};
      const id = Number(account?.id || 0);
      const accountId = String(credentials.chatgpt_account_id || "").trim();
      const userId = String(credentials.chatgpt_user_id || "").trim();
      return Number.isSafeInteger(id) && id > 0
        && accountId === expectedAccountId
        && (!userId || userId === expectedUserId);
    });
    if (candidates.length > 1) {
      throw errorWithStatus("NFapi 中存在多个会被 Agent Identity 导入器匹配的账号，无法安全确定更新目标", 409);
    }

    const importerTarget = candidates[0] || null;
    const existing = this.findExisting(accounts, source, preferredAccountId);
    if (Number(importerTarget?.id || 0) !== Number(existing?.id || 0)) {
      throw errorWithStatus("NFapi Agent Identity 导入器的目标账号与已核验账号不一致，已停止以免更新错误账号", 409);
    }
    return importerTarget;
  }

  linkedAccount(source) {
    const row = this.db.prepare(`
      SELECT email, nfapi_account_id
      FROM registered_account_nfapi_links
      WHERE external_account_id = ? AND nfapi_base_url = ?
    `).get(String(source.id), this.baseUrl());
    if (!row) return null;
    if (String(row.email || "").trim().toLowerCase() !== String(source.account.email || "").trim().toLowerCase()) {
      throw errorWithStatus("AliasHub 的 SUB2 兼容服务账号链接与原注册邮箱不匹配", 409);
    }
    return row;
  }

  desiredName(source, options, count) {
    if (count === 1 && options.account_name) return options.account_name;
    const base = String(source.custom_name || source.account.email || `ChatGPT ${source.id}`).trim();
    return `${options.name_prefix}${base}`.slice(0, 120);
  }

  async applyAllSettings(client, targetId, source, name, options, { longLived = false } = {}) {
    const payload = {
      name,
      notes: options.notes,
      type: "oauth",
      proxy_id: options.proxy_id,
      concurrency: options.concurrency,
      load_factor: options.load_factor,
      priority: options.priority,
      rate_multiplier: options.rate_multiplier,
      status: options.status,
      confirm_mixed_channel_risk: options.confirm_mixed_channel_risk,
      auto_pause_on_expired: longLived ? false : options.auto_pause_on_expired,
    };
    if (options.group_ids.length || options.skip_default_group_bind) payload.group_ids = options.group_ids;
    if (longLived) payload.expires_at = 0;
    else if (options.expires_at !== null) payload.expires_at = options.expires_at;
    await client.updateAccount(targetId, payload);
    const merged = await client.bulkUpdateAccounts({
      account_ids: [targetId],
      credentials: controlledCredentials(options),
      extra: controlledExtra(options, source, { includeResets: true }),
    });
    if (Number(merged?.failed || 0) > 0) {
      const rawMessage = merged?.results?.find((item) => !item.success)?.error || "SUB2 兼容服务账号配置合并失败";
      const message = safeNfapiMessage(client, rawMessage, source);
      throw errorWithStatus(message, 502);
    }
    return merged;
  }

  saveLink(source, { accountId = 0, status, shortLived, action = "", error = "", options }) {
    if (status !== "imported") {
      throw errorWithStatus("NFapi 绑定表只允许保存已完成的导入", 500);
    }
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO registered_account_nfapi_links
        (external_account_id, email, nfapi_base_url, nfapi_account_id, status, short_lived,
         last_action, last_error, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_account_id, nfapi_base_url) DO UPDATE SET
        email = excluded.email,
        nfapi_account_id = CASE
          WHEN excluded.nfapi_account_id > 0 THEN excluded.nfapi_account_id
          ELSE registered_account_nfapi_links.nfapi_account_id
        END,
        status = excluded.status,
        short_lived = excluded.short_lived,
        last_action = excluded.last_action,
        last_error = excluded.last_error,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `).run(
      String(source.id), source.account.email, this.baseUrl(), Number(accountId) || 0, status,
      shortLived ? 1 : 0, action, String(error || "").slice(0, 1_000), JSON.stringify(options || {}), now, now,
    );
  }

  clearPendingAgentIdentity(sourceId, expected = null) {
    const id = Number(sourceId || 0);
    const pending = this.pendingAgentIdentities.get(id);
    if (!pending || (expected && pending !== expected)) return false;
    clearTimeout(pending.expiryTimer);
    this.pendingAgentIdentities.delete(id);
    return true;
  }

  touchPendingAgentIdentity(sourceId, pending) {
    const id = Number(sourceId || 0);
    if (!pending || this.pendingAgentIdentities.get(id) !== pending) return false;
    clearTimeout(pending.expiryTimer);
    pending.expiresAtMs = Date.now() + this.agentIdentityPendingTtlMs;
    const expire = () => {
      if (this.pendingAgentIdentities.get(id) !== pending) return;
      if (this.agentIdentityImportLocks.has(id)) {
        pending.expiryTimer = setTimeout(expire, Math.min(1_000, Math.max(10, this.agentIdentityPendingTtlMs)));
        pending.expiryTimer.unref?.();
        return;
      }
      this.clearPendingAgentIdentity(id, pending);
    };
    pending.expiryTimer = setTimeout(expire, this.agentIdentityPendingTtlMs);
    pending.expiryTimer.unref?.();
    return true;
  }

  storePendingAgentIdentity(sourceId, pending) {
    const id = Number(sourceId || 0);
    this.clearPendingAgentIdentity(id);
    this.pendingAgentIdentities.set(id, pending);
    this.touchPendingAgentIdentity(id, pending);
    return pending;
  }

  reusablePendingAgentIdentity(source) {
    const pending = this.pendingAgentIdentities.get(Number(source?.id || 0));
    if (!pending) return null;
    const credentials = source?.credentials || {};
    const expired = !Number.isFinite(pending.expiresAtMs) || Date.now() >= pending.expiresAtMs;
    const matches = pending.nfapiBaseUrl === this.baseUrl()
      && pending.accountId === String(credentials.accountId || "")
      && pending.userId === String(credentials.userId || "")
      && pending.email === String(credentials.email || "").toLowerCase();
    if (expired || !matches) {
      this.clearPendingAgentIdentity(source?.id, pending);
      return null;
    }
    return pending;
  }

  importAgentIdentity(input = {}) {
    const sourceId = singleAgentIdentitySourceId(input);
    const active = this.agentIdentityImportLocks.get(sourceId);
    if (active) return active;
    const operation = this.importAgentIdentityLocked(input, sourceId)
      .finally(() => {
        if (this.agentIdentityImportLocks.get(sourceId) === operation) {
          this.agentIdentityImportLocks.delete(sourceId);
        }
      });
    this.agentIdentityImportLocks.set(sourceId, operation);
    return operation;
  }

  async importAgentIdentityLocked(input, sourceId) {
    if (input.save_defaults !== undefined && typeof input.save_defaults !== "boolean") {
      throw errorWithStatus("保存默认设置必须是布尔值");
    }
    const rawOptions = input.options === undefined ? {} : input.options;
    if (!rawOptions || typeof rawOptions !== "object" || Array.isArray(rawOptions)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(rawOptions))) {
      throw errorWithStatus("NFapi Agent Identity 导入设置格式无效");
    }
    const storedOptions = this.storedDefaults();
    const options = normalizeNfapiImportOptions({
      ...rawOptions,
      expires_at: null,
      auto_pause_on_expired: false,
    }, storedOptions);
    let requestedOptions = options;
    if (input.save_defaults) {
      const defaultsInput = { ...rawOptions };
      if (Object.hasOwn(defaultsInput, "expires_at")) {
        try { expirationFrom(defaultsInput.expires_at); }
        catch { defaultsInput.expires_at = null; }
      }
      requestedOptions = normalizeNfapiImportOptions(defaultsInput, storedOptions);
    }
    let source = null;
    let pending = null;
    let targetId = 0;
    let action = "agent_identity_import";
    try {
      [source] = await this.loadSources([sourceId]);
      pending = this.reusablePendingAgentIdentity(source);
      const credentials = pending
        ? source.credentials
        : validateAgentIdentitySource(source, this.currentDate());
      const client = this.client();
      const name = this.desiredName(source, options, 1);
      let importOperation = pending?.importOperation || null;
      let imported = null;

      if (importOperation?.state === "imported") {
        imported = importOperation.result;
      } else {
        const replayingUnknown = importOperation
          && ["ready", "in_flight", "unknown"].includes(importOperation.state);
        if (replayingUnknown) {
          const candidatePayload = agentIdentityImportPayload(pending.authJson, source, name, options);
          if (agentIdentityPayloadFingerprint(candidatePayload) !== importOperation.payloadFingerprint) {
            throw errorWithStatus("上一次 NFapi Agent Identity 导入结果尚未确认，请使用相同设置重试", 409);
          }
          const accounts = await client.listOpenAiOauthAccounts();
          const link = this.linkedAccount(source);
          const replayTarget = this.findAgentIdentityExisting(accounts, source, Number(link?.nfapi_account_id || 0));
          if (importOperation.expectedTargetId > 0
            && Number(replayTarget?.id || 0) !== importOperation.expectedTargetId) {
            throw errorWithStatus("NFapi Agent Identity 重试目标与首次预检不一致，已停止以免更新错误账号", 409);
          }
        } else {
          const accounts = await client.listOpenAiOauthAccounts();
          const link = this.linkedAccount(source);
          const existing = this.findAgentIdentityExisting(accounts, source, Number(link?.nfapi_account_id || 0));
          const remediationTargetId = Number(pending?.remediationTargetId || 0);
          if (remediationTargetId > 0 && Number(existing?.id || 0) !== remediationTargetId) {
            throw errorWithStatus("NFapi Agent Identity 修复目标已变化，已停止以免更新错误账号", 409);
          }
          if (remediationTargetId > 0 && !options.update_existing) {
            throw errorWithStatus("修复 NFapi Agent Identity 目标必须开启“更新已有账号”", 409);
          }
          if (existing && !options.update_existing && remediationTargetId === 0) {
            if (!durableAgentIdentityStatus(existing, source)) {
              throw errorWithStatus("NFapi 已有账号尚未迁移为耐久 Agent Identity，请开启“更新已有账号”后重试", 409);
            }
            targetId = Number(existing.id);
            this.db.transaction(() => {
              if (input.save_defaults) this.saveDefaults(requestedOptions);
              this.saveLink(source, {
                accountId: targetId,
                status: "imported",
                shortLived: false,
                action: "agent_identity_skipped",
                options: { ...options, import_mode: "agent_identity" },
              });
            })();
            this.clearPendingAgentIdentity(sourceId, pending);
            return {
              auth_mode: "agentIdentity",
              action: "skipped",
              nfapi_account_id: targetId,
              short_lived: false,
            };
          }

          if (!pending) {
            const registered = await this.agentIdentityRegistrar({
              accessToken: credentials.accessToken,
              accountId: credentials.accountId,
              userId: credentials.userId,
              email: credentials.email,
              planType: credentials.planType,
              fedRamp: credentials.fedRamp,
              fetchFn: this.agentIdentityFetchFn,
              agentVersion: this.agentIdentityVersion,
            });
            const identity = registered?.authJson?.agent_identity;
            if (registered?.authJson?.auth_mode !== "agentIdentity" || !identity
              || String(identity.account_id || "") !== credentials.accountId
              || String(identity.chatgpt_user_id || "") !== credentials.userId
              || !String(identity.agent_runtime_id || "").trim()
              || !String(identity.agent_private_key || "").trim()) {
              throw errorWithStatus("OpenAI Agent Identity 注册结果无效", 502);
            }
            pending = {
              authJson: registered.authJson,
              runtimeId: String(identity.agent_runtime_id),
              secrets: [String(identity.agent_private_key), String(identity.agent_runtime_id)],
              nfapiBaseUrl: this.baseUrl(),
              accountId: credentials.accountId,
              userId: credentials.userId,
              email: credentials.email.toLowerCase(),
              createdAt: this.currentDate().getTime(),
              importAttempt: 0,
              importOperation: null,
              remediationTargetId: 0,
            };
            this.storePendingAgentIdentity(sourceId, pending);
          }

          const payload = agentIdentityImportPayload(pending.authJson, source, name, options);
          pending.importAttempt += 1;
          importOperation = {
            state: "ready",
            payload,
            payloadFingerprint: agentIdentityPayloadFingerprint(payload),
            idempotencyKey: agentIdentityOperationKey(
              this.baseUrl(), sourceId, credentials.accountId, pending.runtimeId, pending.importAttempt,
            ),
            expectedTargetId: remediationTargetId || Number(existing?.id || 0),
            result: null,
          };
          pending.importOperation = importOperation;
        }

        importOperation.state = "in_flight";
        try {
          imported = parseAgentIdentityImportResult(await client.importCodexSession(
            importOperation.payload,
            importOperation.idempotencyKey,
          ));
          importOperation.state = "imported";
          importOperation.result = imported;
        } catch (error) {
          importOperation.state = importFailureIsConfirmed(error) ? "failed_confirmed" : "unknown";
          throw error;
        }
      }

      targetId = imported.accountId;
      action = imported.action;
      if ((importOperation.expectedTargetId > 0 && importOperation.expectedTargetId !== targetId)
        || (importOperation.expectedTargetId === 0 && action !== "created")) {
        throw errorWithStatus("NFapi Agent Identity 导入更新了非预期账号", 409);
      }

      const target = await client.getAccount(targetId);
      try {
        // Some SUB2-compatible services protect sensitive OAuth keys during
        // ordinary credential merges. Clear residue only on the verified,
        // just-imported target before applying its normal AliasHub settings.
        validateAgentIdentityTarget(target, source, pending.runtimeId, {
          requireLongLived: false,
          allowOAuthResidue: true,
        });
      } catch (error) {
        if (error?.agentTargetRemediationRequired === true) {
          pending.remediationTargetId = targetId;
          importOperation.state = "remediation_required";
        }
        throw error;
      }
      if (agentIdentityHasOAuthResidue(target)) {
        await client.updateAccount(targetId, {
          credentials: agentIdentityOAuthCleanupCredentials(target),
        });
      }
      const tokenFreeTarget = await client.getAccount(targetId);
      validateAgentIdentityTarget(tokenFreeTarget, source, pending.runtimeId, { requireLongLived: false });
      await this.applyAllSettings(client, targetId, source, name, options, { longLived: true });
      const configuredTarget = await client.getAccount(targetId);
      validateAgentIdentityTarget(configuredTarget, source, pending.runtimeId);
      this.db.transaction(() => {
        if (input.save_defaults) this.saveDefaults(requestedOptions);
        this.saveLink(source, {
          accountId: targetId,
          status: "imported",
          shortLived: false,
          action: `agent_identity_${action}`,
          options: { ...options, import_mode: "agent_identity" },
        });
      })();
      this.clearPendingAgentIdentity(sourceId, pending);
      return {
        auth_mode: "agentIdentity",
        action,
        nfapi_account_id: targetId,
        short_lived: false,
      };
    } catch (error) {
      const secrets = [
        this.apiKey(),
        ...Object.values(source?.credentials || {}).filter((value) => typeof value === "string"),
        ...(pending?.secrets || []),
      ];
      const baseMessage = redactNfapiMessage(error?.message || "NFapi Agent Identity 导入失败", secrets)
        || "NFapi Agent Identity 导入失败";
      if (!pending) this.clearPendingAgentIdentity(sourceId);
      else this.touchPendingAgentIdentity(sourceId, pending);
      const retained = pending && this.pendingAgentIdentities.get(sourceId) === pending;
      const remainingMinutes = retained
        ? Math.max(1, Math.ceil((pending.expiresAtMs - Date.now()) / 60_000))
        : 0;
      const message = retained
        ? `${baseMessage}；已在内存中保留本次 Agent Identity，${remainingMinutes} 分钟内重试会复用`
        : baseMessage;
      const status = Number(error?.status);
      const publicError = errorWithStatus(
        message,
        Number.isInteger(status) && status >= 400 && status <= 504 ? status : 502,
      );
      if (PUBLIC_AGENT_IDENTITY_ERROR_CODES.has(error?.code)) publicError.code = error.code;
      throw publicError;
    }
  }

  async startOAuthImport(input = {}) {
    const sourceId = singleSourceId(input);
    const queuedBehindAnotherStart = this.oauthStartLocks.has(sourceId);
    const previous = this.oauthStartLocks.get(sourceId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.oauthStartLocks.set(sourceId, current);
    await previous;
    try {
      return await this.startOAuthImportLocked(
        queuedBehindAnotherStart && input.force_restart === true
          ? { ...input, force_restart: false }
          : input,
        sourceId,
      );
    } finally {
      release();
      if (this.oauthStartLocks.get(sourceId) === current) this.oauthStartLocks.delete(sourceId);
    }
  }

  async startOAuthImportLocked(input, sourceId) {
    if (input.save_defaults !== undefined && typeof input.save_defaults !== "boolean") {
      throw errorWithStatus("保存默认设置必须是布尔值");
    }
    if (input.force_restart !== undefined && typeof input.force_restart !== "boolean") {
      throw errorWithStatus("重新生成 OAuth 链接标记必须是布尔值");
    }
    const forceRestart = input.force_restart === true;
    this.expireOAuthSessions();
    const activeSession = this.db.prepare(`
      SELECT * FROM nfapi_oauth_import_sessions
      WHERE external_account_id = ? AND status IN ('pending', 'processing')
      LIMIT 1
    `).get(sourceId);
    let restartedPayload = null;
    let restartedSession = null;
    if (activeSession) {
      try {
        if (!forceRestart || activeSession.status === "processing") {
          return this.resumeOAuthSession(activeSession, sourceId);
        }
        restartedPayload = this.readOAuthSessionPayload(activeSession, sourceId);
        restartedSession = activeSession;
      }
      catch (error) {
        if (activeSession.status === "pending" && error.status !== 410) {
          this.finishOAuthSession(activeSession.id, "failed");
        }
        throw error;
      }
    }
    const options = restartedPayload?.options
      ? normalizeNfapiImportOptions(restartedPayload.options)
      : normalizeNfapiImportOptions(input.options || {}, this.storedDefaults());

    const [source] = await this.loadSources([sourceId]);
    if (restartedPayload) assertCurrentSourceMatchesSnapshot(source, restartedPayload.source);
    const expectedIdentity = {
      email: String(source.credentials.email || source.account.email || "").trim(),
      accountId: String(source.credentials.accountId || "").trim(),
    };
    if (!expectedIdentity.email || !expectedIdentity.accountId) {
      throw errorWithStatus("注册账号缺少可核验的邮箱或 workspace ID，无法启动 SUB2 兼容服务 OAuth", 409);
    }

    const client = this.client();
    const existingAccounts = await client.listOpenAiOauthAccounts();
    const link = this.linkedAccount(source);
    const existing = this.findExisting(existingAccounts, source, Number(link?.nfapi_account_id || 0));
    const name = restartedPayload
      ? text(restartedPayload.name, 120, "账号名称") || this.desiredName(source, options, 1)
      : this.desiredName(source, options, 1);
    if (existing && !options.update_existing) {
      const shortLived = !nfapiHasDurableAuth(existing);
      this.db.transaction(() => {
        if (input.save_defaults) this.saveDefaults(options);
        this.saveLink(source, {
          accountId: Number(existing.id), status: "imported", shortLived, action: "skipped", options,
        });
      })();
      return {
        authorization_required: false,
        status: "completed",
        action: "skipped",
        nfapi_account_id: Number(existing.id),
        short_lived: shortLived,
      };
    }

    const generated = await client.generateOpenAiOAuthUrl({
      ...(options.proxy_id > 0 ? { proxy_id: options.proxy_id } : {}),
    });
    const authorization = authorizationForEmail(parseAuthorizationStart(generated), expectedIdentity.email);
    const localSessionId = crypto.randomUUID();
    const createdAt = this.currentDate();
    const expiresAt = new Date(createdAt.getTime() + this.oauthSessionTtlMs);
    const safeSource = {
      id: source.id,
      account: { email: source.account.email },
      credentials: {
        email: expectedIdentity.email,
        accountId: expectedIdentity.accountId,
        userId: source.credentials.userId,
        planType: source.credentials.planType,
      },
      custom_name: source.custom_name || "",
      group_name: source.group_name || "",
    };
    const encryptedPayload = this.encrypt(JSON.stringify({
      version: OAUTH_SESSION_PAYLOAD_VERSION,
      nfapiBaseUrl: this.baseUrl(),
      authUrl: authorization.authUrl,
      upstreamSessionId: authorization.upstreamSessionId,
      expectedState: authorization.expectedState,
      source: safeSource,
      options,
      name,
      existingAccountId: Number(existing?.id || 0),
    }));
    const persistSession = this.db.transaction(() => {
      if (restartedSession) {
        const retired = this.db.prepare(`
          UPDATE nfapi_oauth_import_sessions
          SET status = 'expired', payload_encrypted = '', finished_at = ?, last_error = ''
          WHERE id = ? AND external_account_id = ? AND status = 'pending'
        `).run(createdAt.toISOString(), restartedSession.id, sourceId);
        if (retired.changes !== 1) {
          throw errorWithStatus("这个账号的 SUB2 兼容服务 OAuth 会话状态已变化，请重新开始", 409);
        }
      }
      this.db.prepare(`
        INSERT INTO nfapi_oauth_import_sessions
          (id, external_account_id, payload_encrypted, status, expires_at, created_at)
        VALUES (?, ?, ?, 'pending', ?, ?)
      `).run(localSessionId, sourceId, encryptedPayload, expiresAt.toISOString(), createdAt.toISOString());
    });
    try {
      persistSession();
    } catch (error) {
      if (error.status === 409 || String(error?.code || "").startsWith("SQLITE_CONSTRAINT")) {
        const winner = this.db.prepare(`
          SELECT * FROM nfapi_oauth_import_sessions
          WHERE external_account_id = ? AND status IN ('pending', 'processing')
          LIMIT 1
        `).get(sourceId);
        if (winner) return this.resumeOAuthSession(winner, sourceId);
        throw errorWithStatus("这个账号的 SUB2 兼容服务 OAuth 会话状态已变化，请重新开始", 409);
      }
      throw error;
    }
    if (input.save_defaults) this.saveDefaults(options);
    return {
      authorization_required: true,
      status: "pending",
      action: existing ? "reauthorize" : "create",
      oauth_session_id: localSessionId,
      auth_url: authorization.authUrl,
      expires_at: expiresAt.toISOString(),
      nfapi_account_id: Number(existing?.id || 0),
    };
  }

  async completeOAuthImport(localSessionId, callbackUrl, expectedSourceId = 0) {
    const sessionId = String(localSessionId || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
      throw errorWithStatus("SUB2 兼容服务 OAuth 会话不存在", 404);
    }
    this.expireOAuthSessions();
    const row = this.db.prepare("SELECT * FROM nfapi_oauth_import_sessions WHERE id = ?").get(sessionId);
    if (!row) throw errorWithStatus("SUB2 兼容服务 OAuth 会话不存在", 404);
    if (row.status === "expired") throw errorWithStatus("SUB2 兼容服务 OAuth 会话已过期，请重新开始", 410);
    if (row.status !== "pending") throw errorWithStatus("SUB2 兼容服务 OAuth 会话已使用，请重新开始", 409);

    const routeSourceId = Number(expectedSourceId || 0);
    const boundSourceId = Number(row.external_account_id || 0);
    if (routeSourceId > 0 && boundSourceId !== routeSourceId) throw errorWithStatus("SUB2 兼容服务 OAuth 会话与所选账号不匹配", 409);
    const payload = this.readOAuthSessionPayload(row, boundSourceId);
    const callback = parseOAuthCallback(callbackUrl);
    if (!equalSecret(callback.state, payload.expectedState)) throw errorWithStatus("OAuth state 校验失败", 409);

    const consumedAt = this.currentDate().toISOString();
    const consumed = this.db.prepare(`
      UPDATE nfapi_oauth_import_sessions
      SET status = 'processing', consumed_at = ?
      WHERE id = ? AND status = 'pending' AND expires_at > ?
    `).run(consumedAt, sessionId, consumedAt);
    if (consumed.changes !== 1) throw errorWithStatus("SUB2 兼容服务 OAuth 会话已使用或过期，请重新开始", 409);

    const client = this.client();
    const source = payload.source;
    const options = payload.options;
    let targetId = Number(payload.existingAccountId || 0);
    let action = targetId > 0 ? "updated_credentials" : "created";
    let token = null;
    try {
      const [currentSource] = await this.loadSources([boundSourceId]);
      assertCurrentSourceMatchesSnapshot(currentSource, source);
      const tokenResult = await client.exchangeOpenAiOAuthCode({
        session_id: payload.upstreamSessionId,
        code: callback.code,
        state: callback.state,
        ...(options.proxy_id > 0 ? { proxy_id: options.proxy_id } : {}),
      });
      token = tokenInfoFrom(tokenResult);
      validateTokenIdentity(source.credentials, token.identity);

      const currentAccounts = await client.listOpenAiOauthAccounts();
      const currentExisting = this.findExisting(currentAccounts, source, Number(payload.existingAccountId || 0));
      if (currentExisting && !options.update_existing) {
        targetId = Number(currentExisting.id);
        action = "skipped";
      } else if (currentExisting) {
        targetId = Number(currentExisting.id);
        const existingTarget = await client.getAccount(targetId);
        if (!existingTarget) throw errorWithStatus("SUB2 兼容服务目标账号已不存在", 404);
        const applied = await client.applyOAuthCredentials(targetId, {
          type: "oauth",
          credentials: oauthCredentialsForUpdate(existingTarget, token),
        });
        validateOAuthTarget(applied);
        action = "updated_credentials";
      } else {
        const createPayload = {
          name: payload.name,
          notes: options.notes,
          platform: "openai",
          type: "oauth",
          credentials: { ...token.credentials, ...controlledCredentials(options) },
          extra: controlledExtra(options, source),
          proxy_id: options.proxy_id || null,
          concurrency: options.concurrency,
          load_factor: options.load_factor,
          priority: options.priority,
          rate_multiplier: options.rate_multiplier,
          group_ids: options.group_ids,
          auto_pause_on_expired: options.auto_pause_on_expired,
          confirm_mixed_channel_risk: options.confirm_mixed_channel_risk,
          ...(options.expires_at !== null ? { expires_at: options.expires_at } : {}),
        };
        const idempotencyKey = `aliashub-oauth-${crypto.createHash("sha256")
          .update(`${payload.nfapiBaseUrl}\0${sessionId}\0${source.credentials.accountId}`)
          .digest("hex")}`;
        const created = await client.createAccount(createPayload, idempotencyKey);
        targetId = Number(created?.id || 0);
        if (!targetId) throw errorWithStatus("SUB2 兼容服务没有返回新账号 ID", 502);
        action = "created";
      }

      if (action !== "skipped") {
        await this.applyAllSettings(client, targetId, source, payload.name, options, { longLived: token.longLived });
      }
      const shortLived = action === "skipped"
        ? !nfapiHasDurableAuth(currentExisting)
        : !token.longLived;
      this.db.transaction(() => {
        this.saveLink(source, {
          accountId: targetId, status: "imported", shortLived, action, options,
        });
        this.finishOAuthSession(sessionId, "completed");
      })();
      return {
        status: "completed",
        action,
        nfapi_account_id: targetId,
        short_lived: shortLived,
      };
    } catch (error) {
      const secrets = [
        callback.code, callback.state, payload.upstreamSessionId,
        ...(token?.secrets || []), this.apiKey(),
      ];
      const message = redactNfapiMessage(error?.message || "SUB2 兼容服务 OAuth 导入失败", secrets)
        || "SUB2 兼容服务 OAuth 导入失败";
      this.finishOAuthSession(sessionId, "failed", message);
      const status = Number(error?.status);
      throw errorWithStatus(message, Number.isInteger(status) && status >= 400 && status <= 504 ? status : 502);
    }
  }

  importAccounts(input = {}) {
    return this.startOAuthImport(input);
  }
}
