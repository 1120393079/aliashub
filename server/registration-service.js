import crypto from "node:crypto";
import { isIP } from "node:net";
import { generateSplits, persistInboxScanResult } from "./account-service.js";
import { isIcloudImportedStrategy } from "./address-generator.js";
import {
  getSetting,
  listRegisteredAccountStatusChecks,
  nowIso,
  setSetting,
  upsertRegisteredAccountStatusCheck,
} from "./db.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const ACTIVE_STATUSES = new Set(["pending", "claimed", "running", "cancel_requested"]);
const RELEASABLE_JOB_STATUSES = new Set(["queued", "pending", "claimed", "running", "cancel_requested"]);
const EMAIL_UNAVAILABLE_MESSAGE = "目标站已存在此邮箱账号，建议更换基础地址";
const ACCOUNT_STATUS_REFRESH_COOLDOWN_MS = 15 * 60 * 1000;
const ACCOUNT_STATUS_REFRESH_BATCH_SIZE = 20;
const KOOKEEY_GATEWAY_HOST = /^gate-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.kookeey\.info$/i;
const KOOKEEY_STICKY_PASSWORD = /^(.+)-([a-z]{2})-(\d{4,32})-([1-9]\d{0,3})m$/i;
const KOOKEEY_MAX_SESSION_TTL_MINUTES = 1_440;

function registrationFailureReason(row = {}) {
  if (String(row.status || "").toLowerCase() !== "failed") return "";
  const text = `${row.stage || ""} ${row.message || ""}`;
  return /user_already_exists|user_exists|account_already_exists|email_already_exists|(?:user|account|email)\s+already\s+exists/i.test(text)
    ? "user_already_exists"
    : "";
}

function publicRegistrationJob(row) {
  if (!row) return row;
  const failureReason = registrationFailureReason(row);
  const message = redactProxySecrets(row.message);
  return {
    ...row,
    message,
    failure_reason: failureReason,
    display_message: failureReason === "user_already_exists" ? EMAIL_UNAVAILABLE_MESSAGE : message,
  };
}

function normalizeSelectedIds(input, label, maximum = 500) {
  if (!Array.isArray(input?.ids)) {
    throw Object.assign(new Error(`请选择要删除的${label}`), { status: 400 });
  }
  const ids = [...new Set(input.ids.map((value) => Number(value)))];
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw Object.assign(new Error(`请选择有效的${label}`), { status: 400 });
  }
  if (ids.length > maximum) throw Object.assign(new Error(`单次最多删除 ${maximum} 个${label}`), { status: 400 });
  return ids;
}

function normalizeAccountCheckIds(input, maximum = 500) {
  if (!Array.isArray(input?.ids)) {
    throw Object.assign(new Error("请选择要检测的注册账号"), { status: 400 });
  }
  const ids = [...new Set(input.ids.map((value) => Number(value)))];
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw Object.assign(new Error("请选择有效的注册账号"), { status: 400 });
  }
  if (ids.length > maximum) throw Object.assign(new Error(`单次最多检测 ${maximum} 个注册账号`), { status: 400 });
  return ids;
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseProxyPool(value) {
  let items = value;
  if (typeof items === "string") {
    try { items = JSON.parse(items); } catch { items = items.split(/\r?\n/); }
  }
  if (!Array.isArray(items)) return [];
  const normalized = [];
  for (const [index, raw] of items.entries()) {
    const source = String(raw || "");
    let proxy = source.trim();
    if (!proxy || proxy.startsWith("#")) continue;
    const invalid = () => {
      throw Object.assign(new Error(`第 ${index + 1} 条代理地址无效`), { status: 400 });
    };
    if (/[\u0000-\u001f\u007f-\u009f]/.test(source) || /\s|\\/.test(proxy)) invalid();
    if (!proxy.includes("://")) {
      const legacy = proxy.match(/^(\[[^\]]+\]|[^:]+):(\d+):([^:]+):([^:]+)$/);
      if (legacy) {
        const [, host, port, username, password] = legacy;
        try {
          proxy = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
        } catch {
          invalid();
        }
      }
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(proxy)) proxy = `http://${proxy}`;
    let parsed;
    try { parsed = new URL(proxy); } catch { invalid(); }
    if (!new Set(["http:", "https:", "socks5:"]).has(parsed.protocol) || !parsed.hostname) invalid();

    const authorityStart = proxy.indexOf("://") + 3;
    if (authorityStart < 3 || proxy.slice(authorityStart).search(/[/?#]/) >= 0) invalid();
    const authority = proxy.slice(authorityStart);
    const atCount = [...authority].filter((char) => char === "@").length;
    if (atCount > 1) invalid();
    const userInfo = atCount === 1 ? authority.slice(0, authority.indexOf("@")) : "";
    const hostPort = atCount === 1 ? authority.slice(authority.indexOf("@") + 1) : authority;
    const portMatch = hostPort.startsWith("[")
      ? hostPort.match(/^\[[^\]]+\]:(\d+)$/)
      : hostPort.match(/^[^:]+:(\d+)$/);
    const port = Number(portMatch?.[1]);
    if (!portMatch || !Number.isInteger(port) || port < 1 || port > 65535 || parsed.hostname.includes("%")) invalid();
    const rawHostname = hostPort.startsWith("[")
      ? hostPort.slice(1, hostPort.lastIndexOf("]"))
      : hostPort.slice(0, hostPort.lastIndexOf(":"));
    if (!rawHostname || rawHostname.includes("%")) invalid();
    const parsedHostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
    if (!isIP(parsedHostname)) {
      const domain = parsedHostname.endsWith(".") ? parsedHostname.slice(0, -1) : parsedHostname;
      if (!domain || domain.split(".").some((label) => !label)) invalid();
    }

    if (atCount === 1) {
      if (parsed.protocol === "socks5:") invalid();
      const separator = userInfo.indexOf(":");
      if (separator <= 0 || separator === userInfo.length - 1) invalid();
      try {
        const username = decodeURIComponent(userInfo.slice(0, separator));
        const password = decodeURIComponent(userInfo.slice(separator + 1));
        if (!username || !password || /[\u0000-\u001f\u007f-\u009f]/.test(`${username}${password}`)) invalid();
      } catch {
        invalid();
      }
    } else if (parsed.username || parsed.password) {
      invalid();
    }
    const result = `${parsed.protocol}//${authority}`;
    if (!normalized.includes(result)) normalized.push(result);
  }
  if (normalized.length > 200) throw Object.assign(new Error("代理池最多保存 200 条"), { status: 400 });
  return normalized;
}

function maskProxy(value) {
  if (!value) return "直连";
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.username ? "***@" : ""}${parsed.hostname}:${parsed.port}`;
  } catch { return "已配置代理"; }
}

function redactProxySecrets(value) {
  return String(value ?? "")
    .replace(/\b([a-z][a-z0-9+.-]*:(?:\\?\/){2})([^\s/?#@]+)@/gi, "$1***@")
    .replace(/((?:\[[0-9a-f:.]+\]|localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+|\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}):[^\s:]+:[^\s,;，]+/gi, "$1:***:***")
    .replace(/(?<![a-z0-9])(?:[a-z0-9._~!$&'()*+,;=%-]+)-[a-z]{2}-\d{4,32}-[1-9]\d{0,3}m(?![a-z0-9])/gi, "[REDACTED]")
    .replace(/((?:proxy(?:[\s_.-]*(?:url|uri|address|server|username|user|password|pass|auth(?:orization)?|credentials?|session(?:[\s_.-]*id)?))?|代理(?:地址|服务器|用户名|用户|密码|认证|凭据|会话(?:编号)?)?)\s*[:=：]\s*)(?:(?:basic|bearer)\s+[^\s,;]+|"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;，]+)/gi, "$1[REDACTED]");
}

function sanitizeRegistrationRemoteValue(value, proxyContext = false) {
  if (typeof value === "string") return redactProxySecrets(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeRegistrationRemoteValue(item, proxyContext));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const keyIsProxy = /proxy|代理/i.test(key);
    const explicitSecretKey = /^(?:user(?:name)?|pass(?:word)?|auth(?:orization)?|credentials?|session(?:_?id)?|token|密码|用户名|认证|凭据|会话)$/i.test(key);
    const contextualSecretKey = /(?:user(?:name)?|pass(?:word)?|auth(?:orization)?|credentials?|session(?:_?id)?|token|密码|用户名|认证|凭据|会话)/i.test(key);
    if (explicitSecretKey || ((proxyContext || keyIsProxy) && contextualSecretKey)) result[key] = "[REDACTED]";
    else result[key] = sanitizeRegistrationRemoteValue(item, proxyContext || keyIsProxy);
  }
  return result;
}

function kookeeyStickyTemplate(value) {
  try {
    const parsed = new URL(value);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)
      || !parsed.username || !parsed.password
      || !KOOKEEY_GATEWAY_HOST.test(parsed.hostname)) {
      return null;
    }
    const password = decodeURIComponent(parsed.password);
    const match = password.match(KOOKEEY_STICKY_PASSWORD);
    if (!match) return null;
    const ttlMinutes = Number(match[4]);
    if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > KOOKEEY_MAX_SESSION_TTL_MINUTES) {
      return null;
    }
    return {
      protocol: parsed.protocol,
      encodedUsername: parsed.username,
      host: parsed.host,
      passwordPrefix: match[1],
      countryCode: match[2].toUpperCase(),
      sessionId: match[3],
      sessionTtl: `${ttlMinutes}m`,
    };
  } catch {
    return null;
  }
}

function proxyMetadata(value) {
  const template = kookeeyStickyTemplate(value);
  if (!template) return null;
  return {
    provider: "Kookeey",
    dynamic_mode: "sticky_session",
    country_code: template.countryCode,
    session_ttl: template.sessionTtl,
  };
}

function randomNumericSession(length) {
  let value = String(crypto.randomInt(1, 10));
  while (value.length < length) value += String(crypto.randomInt(0, 10));
  return value;
}

function materializeProxySession(value, usedSessions = new Set()) {
  const template = kookeeyStickyTemplate(value);
  if (!template) return value;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const sessionId = randomNumericSession(template.sessionId.length);
    const sessionKey = `${template.host}\n${template.encodedUsername}\n${sessionId}`;
    if (sessionId === template.sessionId || usedSessions.has(sessionKey)) continue;
    usedSessions.add(sessionKey);
    const ttlMinutes = template.sessionTtl.slice(0, -1);
    const password = `${template.passwordPrefix}-${template.countryCode}-${sessionId}-${ttlMinutes}m`;
    return `${template.protocol}//${template.encodedUsername}:${encodeURIComponent(password)}@${template.host}`;
  }
  throw new Error("动态代理会话生成失败");
}

function statusCheckProxyRoute(proxyLabel, proxyPool, usedSessions = new Set()) {
  const label = String(proxyLabel || "").trim();
  if (!label || label === "直连") return { primary: "", fallback: "" };
  const matches = proxyPool.filter((proxy) => maskProxy(proxy) === label);
  if (matches.length !== 1) return { primary: "", fallback: "" };
  const primary = matches[0];
  const materialized = materializeProxySession(primary, usedSessions);
  return {
    primary,
    fallback: materialized && materialized !== primary ? materialized : "",
  };
}

function safeProxySamples(result, maximum) {
  const sourceSamples = Array.isArray(result?.samples) ? result.samples : [];
  return sourceSamples.slice(0, maximum).map((item) => {
    const ip = String(item?.ip || "").trim();
    if (!isIP(ip)) throw new Error("代理检测服务返回了无效 IP");
    const latitude = Number(item?.latitude);
    const longitude = Number(item?.longitude);
    return {
      ip,
      country_code: String(item?.country_code || "").slice(0, 8),
      country_name: String(item?.country_name || "").slice(0, 80),
      locale: String(item?.locale || "").slice(0, 40),
      timezone: String(item?.timezone || "").slice(0, 80),
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
    };
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolveJobProxies(input, savedProxies) {
  if (input.proxies !== undefined) return parseProxyPool(input.proxies);
  const choice = String(input.proxySelection || "auto").trim().toLowerCase();
  if (choice === "direct") return [];
  if (choice === "auto") return savedProxies;
  const match = choice.match(/^proxy:(\d+)$/);
  if (!match) throw Object.assign(new Error("代理选择无效"), { status: 400 });
  const index = Number(match[1]);
  if (!Number.isInteger(index) || index < 0 || index >= savedProxies.length) {
    throw Object.assign(new Error("选择的代理已不存在，请刷新后重试"), { status: 409 });
  }
  return [savedProxies[index]];
}

function accountCredentials(item = {}) {
  if (Array.isArray(item.credentials)) return item.credentials;
  if (!item.credentials || typeof item.credentials !== "object") return [];
  return Object.entries(item.credentials).map(([key, raw]) => ({
    key,
    value: raw && typeof raw === "object" && Object.hasOwn(raw, "value") ? raw.value : raw,
  }));
}

function accountCredential(item, keys) {
  const wanted = new Set(keys);
  const match = accountCredentials(item)
    .find((credential) => wanted.has(String(credential?.key || "")) && credential?.value);
  return match ? String(match.value) : "";
}

function accessTokenFromAccount(item = {}) {
  return accountCredential(item, ["access_token", "accessToken"])
    || String(item.primary_token || "");
}

function safeRemoteText(value, maximum = 120) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, maximum);
}

function normalizeRemoteSignal(value, fallback = "") {
  const normalized = safeRemoteText(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function firstRemoteText(...values) {
  for (const value of values) {
    const text = safeRemoteText(value);
    if (text) return text;
  }
  return "";
}

const PLAN_TYPE_ALIASES = new Map([
  ["free", "free"], ["basic", "free"], ["starter", "free"], ["hobby", "free"],
  ["chatgptfree", "free"], ["chatgptfreeplan", "free"],
  ["go", "go"], ["goplan", "go"], ["chatgptgo", "go"], ["chatgptgoplan", "go"],
  ["plus", "plus"], ["premium", "plus"], ["chatgptplus", "plus"], ["chatgptplusplan", "plus"],
  ["pro", "pro"], ["chatgptpro", "pro"], ["chatgptproplan", "pro"],
  ["team", "team"], ["chatgptteam", "team"], ["chatgptteamplan", "team"],
  ["business", "business"], ["chatgptbusiness", "business"], ["chatgptbusinessplan", "business"],
  ["enterprise", "enterprise"], ["corporate", "enterprise"],
  ["chatgptenterprise", "enterprise"], ["chatgptenterpriseplan", "enterprise"],
  ["edu", "edu"], ["education", "edu"], ["chatgptedu", "edu"], ["chatgpteduplan", "edu"],
  ["trial", "trial"], ["trialing", "trial"], ["freetrial", "trial"],
  ["chatgpttrial", "trial"], ["chatgpttrialplan", "trial"],
  ["chatgptfreetrial", "trial"], ["chatgptfreetrialplan", "trial"],
]);

const PLAN_GROUP_LABELS = new Map([
  ["free", "Free 套餐"],
  ["go", "Go 套餐"],
  ["plus", "Plus 套餐"],
  ["pro", "Pro 套餐"],
  ["team", "Team 套餐"],
  ["business", "Business 套餐"],
  ["enterprise", "Enterprise 套餐"],
  ["edu", "Edu 套餐"],
  ["trial", "Trial 套餐"],
]);

function defaultPlanGroupName(accountSignals = {}) {
  const type = normalizeRemoteSignal(accountSignals.account_type, "unknown");
  if (PLAN_GROUP_LABELS.has(type)) return PLAN_GROUP_LABELS.get(type);
  return safeAccountCheckText(accountSignals.account_type_raw, 120)
    && !new Set(["unknown", "none", "null"]).has(normalizeRemoteSignal(accountSignals.account_type_raw))
    ? "Other 套餐"
    : "待识别套餐";
}

function isPlanManagedGroupName(value) {
  const text = safeAccountCheckText(value, 80);
  if (!text) return false;
  if (new Set(["Other 套餐", "待识别套餐"]).has(text)) return true;
  const normalized = normalizeRemoteSignal(text);
  if (new Set(["other", "unknown", "pending", "unrecognized"]).has(normalized)) return true;
  return normalizePlanType(text).known;
}

const ACCOUNT_UNAVAILABLE_CODES = new Map([
  ["account_banned", "banned"], ["user_banned", "banned"],
  ["account_disabled", "disabled"], ["user_disabled", "disabled"],
  ["account_deactivated", "deactivated"], ["user_deactivated", "deactivated"],
  ["account_deleted", "deleted"], ["user_deleted", "deleted"],
  ["account_suspended", "suspended"], ["user_suspended", "suspended"],
]);

const CREDENTIAL_EXPIRED_CODES = new Set([
  "access_token_expired", "authentication_expired", "jwt_expired", "session_expired", "token_expired",
]);
const CREDENTIAL_REVOKED_CODES = new Set([
  "auth_revoked", "authentication_revoked", "credentials_revoked", "invalid_token",
  "session_revoked", "token_revoked",
]);
const SUBSCRIPTION_STATUS_CODES = new Map([
  ["subscription_expired", "expired"], ["subscription_canceled", "canceled"],
  ["subscription_cancelled", "canceled"], ["subscription_past_due", "past_due"],
]);

function normalizeCheckCode(value, fallback = "") {
  return normalizeRemoteSignal(value, fallback).slice(0, 80);
}

function safeAccountCheckText(value, maximum = 240) {
  const raw = value instanceof Error ? value.message : value;
  return safeRemoteText(redactProxySecrets(raw), maximum)
    .replace(/\b((?:bearer|basic)\s+)[a-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]")
    .replace(/\beyj[a-z0-9_-]{10,}(?:\.[a-z0-9_-]{4,}){1,2}\b/gi, "[REDACTED_TOKEN]")
    .replace(/((?:access[_ -]?token|refresh[_ -]?token|session[_ -]?token|authorization|cookie|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, maximum);
}

function classifyAccountCheckError(value, fallbackCode = "check_failed") {
  const text = safeAccountCheckText(value);
  const lower = text.toLowerCase();
  if (/timeout|timed out|\bdecode.*abort|aborted|超时/.test(lower)) {
    return { code: "check_timeout", reason: "状态检测超时，请稍后重试", retryable: true };
  }
  if (/\b429\b|rate.?limit|too many|请求过多|限流/.test(lower)) {
    return { code: "rate_limited", reason: "状态检测请求过多，请稍后重试", retryable: true };
  }
  if (/cloudflare|challenge|captcha|<!doctype|<html|网页/.test(lower)) {
    return { code: "upstream_challenge", reason: "状态检测被上游网页验证拦截，请稍后重试", retryable: true };
  }
  if (/\bdns\b|enotfound|eai_again|getaddrinfo/.test(lower)) {
    return { code: "dns_failure", reason: "状态检测域名解析暂时失败，请稍后重试", retryable: true };
  }
  if (/\btls\b|ssl|certificate|handshake/.test(lower)) {
    return { code: "tls_failure", reason: "状态检测安全连接暂时失败，请稍后重试", retryable: true };
  }
  if (/proxy|代理/.test(lower)) {
    return { code: "proxy_unavailable", reason: "状态检测代理暂时不可用，请稍后重试", retryable: true };
  }
  if (/\b5\d\d\b|service unavailable|bad gateway|gateway timeout/.test(lower)) {
    return { code: "upstream_unavailable", reason: "状态检测上游服务暂时不可用，请稍后重试", retryable: true };
  }
  if (/\b401\b|unauthori[sz]ed/.test(lower)) {
    return {
      code: "authentication_unconfirmed",
      reason: "登录凭据未通过本次检测，但证据不足，已保留上次结果",
      retryable: true,
    };
  }
  if (/\b403\b|forbidden/.test(lower)) {
    return { code: "access_forbidden", reason: "本次状态检测被上游拒绝，账号状态未改变", retryable: true };
  }
  if (/network|connect|socket|fetch failed|econn|网页/.test(lower)) {
    return { code: "network_error", reason: "状态检测网络暂时不可用，请稍后重试", retryable: true };
  }
  return {
    code: normalizeCheckCode(fallbackCode, "check_failed"),
    reason: "状态检测暂时失败，请稍后重试",
    retryable: true,
  };
}

function normalizePlanType(rawPlanName, planState = "unknown") {
  const raw = safeAccountCheckText(rawPlanName, 120);
  const normalized = normalizeRemoteSignal(raw);
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  let type = PLAN_TYPE_ALIASES.get(compact) || "unknown";
  let source = raw ? "plan_name" : "not_detected";
  if (type === "unknown" && !raw && planState === "free") {
    type = "free";
    source = "plan_state";
  } else if (type === "unknown" && !raw && new Set(["trial", "trialing"]).has(planState)) {
    type = "trial";
    source = "plan_state";
  }
  return {
    type,
    raw,
    normalized: normalized || "unknown",
    known: type !== "unknown",
    source,
  };
}

function isAuthoritativeStatusSource(source, { terminal = false } = {}) {
  const normalized = safeAccountCheckText(source, 120).toLowerCase();
  if (/^(?:backend[-_]?api)(?:[/:_-]|$)/.test(normalized)) return true;
  if (normalized === "registration-refresh") return true;
  return !terminal && normalized === "api/auth/session+jwt";
}

function isAuthoritativeCredentialSource(source) {
  const normalized = safeAccountCheckText(source, 120).toLowerCase();
  return /^(?:backend[-_]?api)(?:[/:_-]|$)/.test(normalized)
    || normalized === "registration-refresh"
    || normalized === "credential/access-token-jwt"
    || normalized === "credential/session-jwt";
}

function normalizeAccountStatus(value) {
  const status = normalizeRemoteSignal(value, "unknown");
  return new Set(["active", "banned", "disabled", "deactivated", "deleted", "suspended"]).has(status)
    ? status : "unknown";
}

function normalizeCredentialStatus(value) {
  const status = normalizeRemoteSignal(value, "unknown");
  return new Set(["valid", "expired", "revoked", "missing"]).has(status) ? status : "unknown";
}

function normalizeSubscriptionStatus(value, planState = "unknown") {
  const status = normalizeRemoteSignal(value);
  const aliases = new Map([
    ["active", "active"], ["subscribed", "active"],
    ["trial", "trialing"], ["trialing", "trialing"],
    ["free", "free"], ["eligible", "free"],
    ["past_due", "past_due"], ["canceled", "canceled"], ["cancelled", "canceled"],
    ["expired", "expired"],
  ]);
  return aliases.get(status) || aliases.get(planState) || "unknown";
}

function refreshPlanEvidence(result = {}) {
  const raw = firstRemoteText(
    result?.account_type_raw,
    result?.type_raw,
    result?.plan_code_raw,
    result?.plan_type_raw,
    result?.account_type,
    result?.type,
    result?.plan_name,
    result?.plan,
  );
  const normalizedRaw = normalizeRemoteSignal(raw);
  const meaningful = Boolean(raw)
    && !new Set(["unknown", "none", "null", "not_detected", "unavailable"]).has(normalizedRaw);
  const planSource = safeAccountCheckText(firstRemoteText(
    result?.account_type_source,
    result?.type_source,
    result?.plan_type_source,
    result?.plan_source,
  ), 120).toLowerCase();
  const statusSource = safeAccountCheckText(firstRemoteText(
    result?.status_source,
    result?.source,
    result?.check_source,
  ), 120).toLowerCase();
  let explicitlyObserved;
  for (const value of [
    result?.type_observed,
    result?.account_type_observed,
    result?.plan_observed,
  ]) {
    if (typeof value === "boolean") {
      explicitlyObserved = value;
      break;
    }
  }
  const planDetection = normalizeRemoteSignal(result?.plan_detection_result);
  const planDetectionInconclusive = new Set([
    "error", "failed", "inconclusive", "timeout", "transient", "unconfirmed", "not_detected",
  ]).has(planDetection);
  const authority = normalizeRemoteSignal(result?.plan_authority);
  const confidence = normalizeRemoteSignal(result?.account_type_confidence || result?.plan_confidence);
  const weakSource = /(?:last[_ /.-]*confirmed|persisted|cached|fallback|session|jwt|token|unconfirmed|not[_ /.-]*detected)/i
    .test(`${planSource} ${statusSource}`);
  const authoritativeSource = /^(?:backend[-_]?api)(?:[/:_.-]|$)/i.test(planSource)
    || /^(?:backend[-_]?api)(?:[/:_.-]|$)/i.test(statusSource);
  const observed = result?.ok === true && meaningful && !planDetectionInconclusive && !weakSource
    && (explicitlyObserved === true
      || (explicitlyObserved !== false && (authoritativeSource || (!planSource && !statusSource))));
  const normalizedPlan = normalizePlanType(raw);
  return {
    raw,
    observed,
    type: normalizedPlan.type,
    known: normalizedPlan.known,
    high_authority: observed && (new Set(["authoritative", "high"]).has(authority)
      || confidence === "high"
      || /backend[-_]?api\/accounts?\/check\+subscriptions?/i.test(planSource)),
    explicitly_observed: explicitlyObserved,
    weak_source: weakSource,
  };
}

function refreshResultHasConclusiveNonPlanEvidence(result = {}) {
  const code = normalizeCheckCode(firstRemoteText(
    result?.status_code,
    result?.code,
    result?.validity_code,
    result?.error_code,
  ));
  const source = safeAccountCheckText(firstRemoteText(
    result?.status_source,
    result?.source,
    result?.check_source,
  ), 120);
  return (ACCOUNT_UNAVAILABLE_CODES.has(code) && isAuthoritativeStatusSource(source, { terminal: true }))
    || ((CREDENTIAL_EXPIRED_CODES.has(code) || CREDENTIAL_REVOKED_CODES.has(code))
      && isAuthoritativeCredentialSource(source))
    || (SUBSCRIPTION_STATUS_CODES.has(code) && isAuthoritativeStatusSource(source, { terminal: true }));
}

function refreshResultNeedsProxyReview(result) {
  if (!result || result.ok !== true) return true;
  const detection = normalizeRemoteSignal(result.detection_status || result.detection_result);
  if (new Set(["error", "failed", "inconclusive", "timeout", "transient"]).has(detection)) return true;
  if (refreshResultHasConclusiveNonPlanEvidence(result)) return false;
  const evidence = refreshPlanEvidence(result);
  return !evidence.observed || evidence.type === "free";
}

function refreshResultMap(response, allowedIds) {
  const result = new Map();
  for (const item of Array.isArray(response?.items) ? response.items : []) {
    const id = Number(item?.account_id ?? item?.id);
    if (allowedIds.has(id) && !result.has(id)) result.set(id, item);
  }
  return result;
}

async function requestPlanRefreshChannel(client, ids, proxiesById) {
  let response = { items: [], timed_out: 0 };
  let failure = null;
  try {
    response = await client.refreshAccountPlans(ids, proxiesById);
  } catch (error) {
    failure = classifyAccountCheckError(error);
  }
  return {
    resultById: refreshResultMap(response, new Set(ids)),
    failure,
    timedOut: Number(response?.timed_out) > 0,
  };
}

function appendPlanRefreshAttempts(attemptsById, ids, channel) {
  for (const id of ids) {
    const result = channel.resultById.get(id);
    let failure = null;
    if (!result) {
      failure = channel.failure || (channel.timedOut
        ? classifyAccountCheckError("timeout", "check_timeout")
        : classifyAccountCheckError("missing result", "missing_result"));
    }
    attemptsById.get(id).push({ result, failure });
  }
}

function conclusivePlanRefreshResults(attempts) {
  return attempts.filter(({ result }) => {
    if (!result || result.ok !== true) return false;
    const detection = normalizeRemoteSignal(result.detection_status || result.detection_result);
    return !new Set(["error", "failed", "inconclusive", "timeout", "transient"]).has(detection)
      && refreshPlanEvidence(result).observed;
  });
}

function planRefreshAttemptsResolved(attempts) {
  if (attempts.some(({ result }) => refreshResultHasConclusiveNonPlanEvidence(result))) return true;
  const conclusive = conclusivePlanRefreshResults(attempts);
  if (conclusive.some(({ result }) => refreshPlanEvidence(result).type !== "free")) return true;
  const free = conclusive.filter(({ result }) => refreshPlanEvidence(result).type === "free");
  return free.length >= 2 || free.some(({ result }) => refreshPlanEvidence(result).high_authority);
}

function selectPlanRefreshAttempt(attempts) {
  const terminal = attempts.filter(({ result }) => refreshResultHasConclusiveNonPlanEvidence(result));
  if (terminal.length) return terminal.at(-1);
  const conclusive = conclusivePlanRefreshResults(attempts);
  const nonFree = conclusive.filter(({ result }) => refreshPlanEvidence(result).type !== "free");
  if (nonFree.length) return nonFree.at(-1);
  const free = conclusive.filter(({ result }) => refreshPlanEvidence(result).type === "free");
  if (free.length >= 2) return free.at(-1);
  const highAuthorityFree = free.filter(({ result }) => refreshPlanEvidence(result).high_authority);
  if (highAuthorityFree.length) return highAuthorityFree.at(-1);
  if (free.length) {
    const result = free.at(-1).result;
    const latestFailure = [...attempts].reverse().find(({ failure }) => Boolean(failure))?.failure || null;
    return {
      result: {
        ...result,
        type_observed: false,
        plan_detection_result: "inconclusive",
        detection_result: "inconclusive",
        status_code: "plan_confirmation_inconclusive",
        status_reason: "检测通道未能共同确认 Free，已保留上次套餐",
        status_retryable: true,
      },
      failure: latestFailure,
    };
  }
  const latestResult = [...attempts].reverse().find(({ result }) => Boolean(result))?.result || null;
  const latestFailure = [...attempts].reverse().find(({ failure }) => Boolean(failure))?.failure || null;
  return { result: latestResult, failure: latestFailure };
}

async function refreshPlansWithProxyReview(client, ids, proxyRoutesById = new Map()) {
  const attemptsById = new Map(ids.map((id) => [id, []]));
  const primaryProxies = Object.fromEntries(ids
    .map((id) => [id, proxyRoutesById.get(id)?.primary || ""])
    .filter(([, proxy]) => Boolean(proxy)));
  const primary = await requestPlanRefreshChannel(client, ids, primaryProxies);
  appendPlanRefreshAttempts(attemptsById, ids, primary);

  const fallbackIds = ids.filter((id) => proxyRoutesById.get(id)?.fallback
    && refreshResultNeedsProxyReview(primary.resultById.get(id)));
  if (fallbackIds.length) {
    const fallbackProxies = Object.fromEntries(fallbackIds.map((id) => [
      id,
      proxyRoutesById.get(id).fallback,
    ]));
    const fallback = await requestPlanRefreshChannel(client, fallbackIds, fallbackProxies);
    appendPlanRefreshAttempts(attemptsById, fallbackIds, fallback);

    const directIds = fallbackIds.filter((id) => !planRefreshAttemptsResolved(attemptsById.get(id)));
    if (directIds.length) {
      const direct = await requestPlanRefreshChannel(client, directIds, {});
      appendPlanRefreshAttempts(attemptsById, directIds, direct);
    }
  }

  const resultById = new Map();
  const failureById = new Map();
  for (const id of ids) {
    const selected = selectPlanRefreshAttempt(attemptsById.get(id));
    if (selected.result) resultById.set(id, selected.result);
    if (selected.failure) failureById.set(id, selected.failure);
    if (selected.result && !refreshResultNeedsProxyReview(selected.result)) {
      failureById.delete(id);
    }
  }

  return {
    resultById,
    failureById,
    received_results: [...attemptsById.values()].some((attempts) => attempts.some(({ result }) => result)),
  };
}

function outcomeTimestamp(outcome = {}) {
  const parsed = Date.parse(outcome.checked_at || outcome.attempted_at || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function accountStatusSignals(item = {}, persistedOutcome = null) {
  const overview = item.overview && typeof item.overview === "object" && !Array.isArray(item.overview)
    ? item.overview : {};
  const summaryStatus = item.display_summary?.status && typeof item.display_summary.status === "object"
    ? item.display_summary.status : {};
  const lifecycleStatus = normalizeRemoteSignal(
    firstRemoteText(item.lifecycle_status, overview.lifecycle_status, summaryStatus.lifecycle),
    "unknown",
  );
  const validityStatus = normalizeRemoteSignal(
    firstRemoteText(item.validity_status, overview.validity_status, summaryStatus.validity),
    "unknown",
  );
  const planState = normalizeRemoteSignal(
    firstRemoteText(item.plan_state, overview.plan_state, summaryStatus.plan_state),
    "unknown",
  );
  const declaredAccountType = firstRemoteText(
    overview.account_type,
    item.account_type,
  );
  const rawPlanName = firstRemoteText(
    overview.account_type_raw,
    item.account_type_raw,
    overview.plan_code_raw,
    overview.plan_type_raw,
    item.plan_name,
    overview.plan_name,
    overview.plan,
    overview.membership_type,
    overview.individual_membership_type,
    summaryStatus.plan_name,
  );
  const planName = normalizeRemoteSignal(rawPlanName);
  const declaredPlan = normalizePlanType(declaredAccountType);
  const rawDetectedPlan = normalizePlanType(rawPlanName, planState);
  const rawConflictsWithDeclared = declaredPlan.known && rawDetectedPlan.known
    && declaredPlan.type !== rawDetectedPlan.type;
  const detectedPlan = declaredPlan.known ? {
    ...declaredPlan,
    raw: rawConflictsWithDeclared ? declaredPlan.raw : (rawDetectedPlan.raw || declaredPlan.raw),
    source: "account_type",
  } : rawDetectedPlan;
  const displayStatus = normalizeRemoteSignal(
    firstRemoteText(item.display_status, overview.display_status, summaryStatus.display),
    lifecycleStatus,
  );
  const statusCheckedAt = safeRemoteText(
    firstRemoteText(
      overview.status_checked_at,
      item.status_checked_at,
      overview.checked_at,
      summaryStatus.checked_at,
    ),
    80,
  );
  const statusCheckedAtMs = Date.parse(statusCheckedAt);
  let statusStale = !Number.isFinite(statusCheckedAtMs)
    || Date.now() - statusCheckedAtMs >= ACCOUNT_STATUS_REFRESH_COOLDOWN_MS;
  const source = safeAccountCheckText(firstRemoteText(
    overview.status_source,
    item.status_source,
    overview.check_source,
    item.source,
  ), 100);
  const authoritativeCheck = Number.isFinite(statusCheckedAtMs)
    && isAuthoritativeStatusSource(source);
  const remoteCode = normalizeCheckCode(firstRemoteText(
    overview.status_code,
    item.status_code,
    overview.validity_code,
    item.validity_code,
    overview.detection_code,
    overview.error_code,
  ));
  const remoteReason = safeAccountCheckText(firstRemoteText(
    overview.status_reason,
    item.status_reason,
    overview.validity_reason,
    item.validity_reason,
    overview.detection_reason,
    overview.check_error,
  ));
  const persisted = persistedOutcome && typeof persistedOutcome === "object" ? persistedOutcome : null;
  const persistedSource = safeAccountCheckText(persisted?.source, 100);
  const persistedCode = normalizeCheckCode(persisted?.code);
  const remoteRetryable = typeof overview.status_retryable === "boolean"
    ? overview.status_retryable : Boolean(item.status_retryable);
  const remoteHttpStatus = Math.max(0, Number(
    overview.status_http ?? item.status_http ?? overview.http_status ?? item.http_status,
  ) || 0);
  const remoteEvidencePath = safeAccountCheckText(firstRemoteText(
    overview.status_evidence_path,
    item.status_evidence_path,
    overview.evidence_path,
    item.evidence_path,
  ), 160);
  const persistedAt = outcomeTimestamp(persisted || {});
  const remoteAt = Number.isFinite(statusCheckedAtMs) ? statusCheckedAtMs : 0;
  const persistedHasStateEvidence = normalizeAccountStatus(persisted?.account_status) !== "unknown"
    || normalizeCredentialStatus(persisted?.credential_status) !== "unknown"
    || Boolean(persistedCode && persistedCode !== "check_completed");
  const latestIsPersisted = Boolean(persisted && persistedAt >= remoteAt
    && (!authoritativeCheck
      || persisted?.detection_status === "inconclusive"
      || persistedHasStateEvidence));
  const remoteExplicitEvidence = Number.isFinite(statusCheckedAtMs)
    && ((ACCOUNT_UNAVAILABLE_CODES.has(remoteCode)
      && isAuthoritativeStatusSource(source, { terminal: true }))
      || ((CREDENTIAL_EXPIRED_CODES.has(remoteCode) || CREDENTIAL_REVOKED_CODES.has(remoteCode))
        && isAuthoritativeCredentialSource(source))
      || (SUBSCRIPTION_STATUS_CODES.has(remoteCode)
        && isAuthoritativeStatusSource(source, { terminal: true })));
  const latestDetection = latestIsPersisted
    ? normalizeRemoteSignal(persisted.detection_status, "unchecked")
    : ((authoritativeCheck && overview.valid === true) || remoteExplicitEvidence ? "confirmed" : "unchecked");
  const latestCode = latestIsPersisted ? persistedCode : remoteCode;
  const latestReason = latestIsPersisted ? safeAccountCheckText(persisted.reason) : remoteReason;
  const latestSource = latestIsPersisted ? persistedSource : source;
  const latestHttpStatus = latestIsPersisted
    ? Math.max(0, Number(persisted.http_status) || 0) : remoteHttpStatus;
  const latestEvidencePath = latestIsPersisted
    ? safeAccountCheckText(persisted.evidence_path, 160) : remoteEvidencePath;
  const latestCheckedAt = latestIsPersisted
    ? safeRemoteText(persisted.checked_at, 80)
    : statusCheckedAt;
  const latestAttemptedAt = persisted && persistedAt >= remoteAt
    ? safeRemoteText(persisted.attempted_at, 80)
    : statusCheckedAt;
  const latestCheckedAtMs = Date.parse(latestCheckedAt);
  statusStale = !Number.isFinite(latestCheckedAtMs)
    || Date.now() - latestCheckedAtMs >= ACCOUNT_STATUS_REFRESH_COOLDOWN_MS;

  const terminalCandidates = [
    remoteCode && ACCOUNT_UNAVAILABLE_CODES.has(remoteCode)
      && Number.isFinite(statusCheckedAtMs)
      && isAuthoritativeStatusSource(source, { terminal: true })
      ? { code: remoteCode, source, at: remoteAt, origin: "remote" } : null,
    persistedCode && ACCOUNT_UNAVAILABLE_CODES.has(persistedCode)
      && isAuthoritativeStatusSource(persistedSource, { terminal: true })
      ? { code: persistedCode, source: persistedSource, at: persistedAt, origin: "persisted" } : null,
  ].filter(Boolean).sort((left, right) => right.at - left.at);
  const terminalCandidate = terminalCandidates[0] || null;
  const credentialCandidates = [
    remoteCode && (CREDENTIAL_EXPIRED_CODES.has(remoteCode) || CREDENTIAL_REVOKED_CODES.has(remoteCode))
      && Number.isFinite(statusCheckedAtMs)
      && isAuthoritativeCredentialSource(source)
      ? { code: remoteCode, source, at: remoteAt, origin: "remote" } : null,
    persistedCode && (CREDENTIAL_EXPIRED_CODES.has(persistedCode) || CREDENTIAL_REVOKED_CODES.has(persistedCode))
      && persisted?.detection_status === "confirmed"
      && isAuthoritativeCredentialSource(persistedSource)
      ? { code: persistedCode, source: persistedSource, at: persistedAt, origin: "persisted" } : null,
  ].filter(Boolean).sort((left, right) => right.at - left.at);
  const credentialCandidate = credentialCandidates[0] || null;
  const subscriptionCandidates = [
    remoteCode && SUBSCRIPTION_STATUS_CODES.has(remoteCode)
      && Number.isFinite(statusCheckedAtMs)
      && isAuthoritativeStatusSource(source, { terminal: true })
      ? { code: remoteCode, source, at: remoteAt, origin: "remote" } : null,
    persistedCode && SUBSCRIPTION_STATUS_CODES.has(persistedCode)
      && persisted?.detection_status === "confirmed"
      && isAuthoritativeStatusSource(persistedSource, { terminal: true })
      ? { code: persistedCode, source: persistedSource, at: persistedAt, origin: "persisted" } : null,
  ].filter(Boolean).sort((left, right) => right.at - left.at);
  const subscriptionCandidate = subscriptionCandidates[0] || null;
  const confirmedRemoteActive = (authoritativeCheck
    && (overview.valid === true || (typeof overview.valid !== "boolean" && validityStatus === "valid")))
    || subscriptionCandidate?.origin === "remote";
  const confirmedPersistedActive = persisted?.detection_status === "confirmed"
    && ((normalizeAccountStatus(persisted.account_status) === "active"
      && isAuthoritativeStatusSource(persistedSource))
      || subscriptionCandidate?.origin === "persisted");
  const confirmedActive = confirmedRemoteActive || confirmedPersistedActive;
  const activeAt = Math.max(
    confirmedRemoteActive ? remoteAt : 0,
    confirmedPersistedActive ? persistedAt : 0,
  );
  const terminalEvidence = terminalCandidate && terminalCandidate.at >= activeAt
    ? terminalCandidate : null;
  const credentialEvidence = credentialCandidate && credentialCandidate.at >= activeAt
    ? credentialCandidate : null;
  const subscriptionEvidence = subscriptionCandidate && subscriptionCandidate.at >= activeAt
    ? subscriptionCandidate : null;

  let availability = "unchecked";
  let available = null;
  let availabilitySource = "not_checked";
  const conflictingRemoteStatus = Boolean(terminalCandidate && confirmedActive);
  if (terminalEvidence) {
    availability = "unavailable";
    available = false;
    availabilitySource = `code:${terminalEvidence.code}:confirmed`;
  } else if (credentialEvidence) {
    availability = "unavailable";
    available = false;
    availabilitySource = `code:${credentialEvidence.code}:credential`;
  } else if (confirmedActive) {
    availability = "available";
    available = true;
    availabilitySource = confirmedRemoteActive
      ? (overview.valid === true ? "overview.valid:confirmed" : "validity_status:valid:confirmed")
      : "persisted.account_status:active";
  }

  const accessTokenAvailable = Boolean(accessTokenFromAccount(item));
  const sessionTokenAvailable = Boolean(accountCredential(item, ["session_token", "sessionToken"]));
  const refreshTokenAvailable = Boolean(accountCredential(item, ["refresh_token", "refreshToken"]));
  const idTokenAvailable = Boolean(accountCredential(item, ["id_token", "idToken"]));
  const anyCredentialAvailable = accessTokenAvailable || sessionTokenAvailable || refreshTokenAvailable || idTokenAvailable;
  const evidenceCode = terminalEvidence?.code || credentialEvidence?.code
    || subscriptionEvidence?.code || latestCode;
  let accountStatus = terminalEvidence
    ? ACCOUNT_UNAVAILABLE_CODES.get(terminalEvidence.code)
    : (credentialEvidence ? "unknown" : (confirmedActive ? "active" : "unknown"));
  if (accountStatus === "unknown" && latestIsPersisted) {
    accountStatus = normalizeAccountStatus(persisted.account_status);
  }
  let credentialStatus = normalizeCredentialStatus(firstRemoteText(
    overview.credential_status,
    overview.credential_state,
  ));
  if (credentialEvidence && CREDENTIAL_EXPIRED_CODES.has(credentialEvidence.code)) credentialStatus = "expired";
  else if (credentialEvidence && CREDENTIAL_REVOKED_CODES.has(credentialEvidence.code)) credentialStatus = "revoked";
  else if (credentialStatus === "unknown" && confirmedActive) credentialStatus = "valid";
  else if (credentialStatus === "unknown" && !anyCredentialAvailable) credentialStatus = "missing";
  else if (credentialStatus === "unknown" && latestIsPersisted) {
    credentialStatus = normalizeCredentialStatus(persisted.credential_status);
  }
  let subscriptionStatus = normalizeSubscriptionStatus(
    firstRemoteText(overview.subscription_status, overview.subscription_state),
    planState,
  );
  if (subscriptionEvidence) {
    subscriptionStatus = SUBSCRIPTION_STATUS_CODES.get(subscriptionEvidence.code);
  } else if (subscriptionStatus === "unknown" && latestIsPersisted) {
    subscriptionStatus = normalizeSubscriptionStatus(persisted.subscription_status);
  }
  const persistedType = normalizePlanType(persisted?.account_type_raw || persisted?.account_type || "");
  const accountType = detectedPlan.known ? detectedPlan.type : (persistedType.known ? persistedType.type : "unknown");
  const accountTypeRaw = detectedPlan.raw || safeAccountCheckText(persisted?.account_type_raw, 120);
  const accountTypeSource = detectedPlan.known ? detectedPlan.source
    : (persistedType.known ? "persisted" : (detectedPlan.raw ? "raw_plan_name" : "not_detected"));
  const confirmation = terminalEvidence || credentialEvidence || subscriptionEvidence || confirmedActive
    ? "confirmed" : "unconfirmed";
  const confirmedAt = confirmation === "confirmed"
    ? (terminalEvidence || credentialEvidence || subscriptionEvidence
      ? ((terminalEvidence || credentialEvidence || subscriptionEvidence).origin === "persisted"
        ? safeRemoteText(persisted?.checked_at, 80) : statusCheckedAt)
      : (confirmedPersistedActive && persistedAt >= remoteAt
        ? safeRemoteText(persisted?.checked_at, 80) : statusCheckedAt))
    : "";
  return {
    account_type: accountType,
    account_type_raw: accountTypeRaw,
    account_type_known: accountType !== "unknown",
    account_type_source: accountTypeSource,
    account_status: accountStatus,
    credential_status: credentialStatus,
    subscription_status: subscriptionStatus,
    detection_status: latestDetection,
    status_code: evidenceCode,
    status_reason: latestReason,
    status_retryable: latestIsPersisted ? Boolean(persisted.retryable) : remoteRetryable,
    status_http: latestHttpStatus,
    status_evidence_path: latestEvidencePath,
    status_attempted_at: latestAttemptedAt,
    availability,
    available,
    availability_source: availabilitySource,
    lifecycle_status: lifecycleStatus,
    validity_status: validityStatus,
    display_status: displayStatus,
    plan_state: planState,
    plan_name: planName,
    status_checked_at: latestCheckedAt,
    status_confirmed_at: confirmedAt,
    status_source: latestSource,
    source: latestSource,
    status_confirmation: conflictingRemoteStatus ? "conflict" : confirmation,
    status_conflict: conflictingRemoteStatus,
    status_check_required: availability === "unchecked" || accountType === "unknown"
      || latestDetection === "inconclusive" || statusStale,
    access_token_available: accessTokenAvailable,
    session_token_available: sessionTokenAvailable,
    refresh_token_available: refreshTokenAvailable,
    id_token_available: idTokenAvailable,
    credentials_available: anyCredentialAvailable,
  };
}

function refreshOutcomeFromResult(result, {
  id,
  email,
  attemptedAt,
  fallbackSignals = {},
  requestFailure = null,
} = {}) {
  const source = safeAccountCheckText(firstRemoteText(
    result?.status_source,
    result?.source,
    result?.check_source,
  ), 100) || "registration-refresh";
  const checkedAt = safeRemoteText(firstRemoteText(
    result?.status_checked_at,
    result?.checked_at,
    result?.time,
    result?.attempted_at,
  ), 80) || attemptedAt;
  const rawCode = normalizeCheckCode(firstRemoteText(
    result?.status_code,
    result?.code,
    result?.validity_code,
    result?.error_code,
    result?.detection_code,
    result?.error?.code,
  ));
  const rawReason = safeAccountCheckText(firstRemoteText(
    result?.status_reason,
    result?.reason,
    result?.validity_reason,
    result?.detection_reason,
    result?.error?.message,
    result?.error,
  ));
  const planEvidence = refreshPlanEvidence(result);
  const observedRawPlan = planEvidence.observed ? planEvidence.raw : "";
  const rawPlan = firstRemoteText(
    observedRawPlan,
    fallbackSignals.account_type_raw,
    fallbackSignals.account_type,
  );
  const plan = normalizePlanType(rawPlan, fallbackSignals.plan_state);
  const explicitAccountStatus = normalizeAccountStatus(result?.account_status || result?.account_state);
  const explicitCredentialStatus = normalizeCredentialStatus(
    result?.credential_status || result?.credential_state,
  );
  const explicitSubscriptionStatus = normalizeSubscriptionStatus(
    result?.subscription_status || result?.subscription_state,
    fallbackSignals.plan_state,
  );
  const terminalStatus = ACCOUNT_UNAVAILABLE_CODES.get(rawCode) || "";
  const authoritativeTerminal = Boolean(terminalStatus)
    && isAuthoritativeStatusSource(source, { terminal: true });
  const rawCredentialCodeStatus = CREDENTIAL_EXPIRED_CODES.has(rawCode) ? "expired"
    : (CREDENTIAL_REVOKED_CODES.has(rawCode) ? "revoked" : "");
  const credentialCodeStatus = rawCredentialCodeStatus && isAuthoritativeCredentialSource(source)
    ? rawCredentialCodeStatus : "";
  const rawSubscriptionCodeStatus = SUBSCRIPTION_STATUS_CODES.get(rawCode) || "";
  const subscriptionCodeStatus = rawSubscriptionCodeStatus
    && isAuthoritativeStatusSource(source, { terminal: true })
    ? rawSubscriptionCodeStatus : "";
  const rawDetection = normalizeRemoteSignal(result?.detection_status || result?.detection_result);
  const transientDetection = new Set(["error", "failed", "inconclusive", "timeout", "transient"])
    .has(rawDetection);

  let detectionStatus = "confirmed";
  let code = rawCode;
  let reason = rawReason;
  let retryable = typeof result?.status_retryable === "boolean"
    ? result.status_retryable : Boolean(result?.retryable);
  let accountStatus = authoritativeTerminal ? terminalStatus : explicitAccountStatus;
  let credentialStatus = credentialCodeStatus || explicitCredentialStatus;
  let subscriptionStatus = subscriptionCodeStatus || explicitSubscriptionStatus;

  if (requestFailure || !result || result.ok !== true || transientDetection) {
    if (!authoritativeTerminal && !credentialCodeStatus && !subscriptionCodeStatus) {
      const failure = requestFailure || classifyAccountCheckError(
        `${rawCode} ${rawReason}`,
        rawCode || (!result ? "missing_result" : "check_failed"),
      );
      detectionStatus = "inconclusive";
      code = failure.code;
      reason = failure.reason;
      retryable = failure.retryable;
      accountStatus = "unknown";
      credentialStatus = "unknown";
      subscriptionStatus = "unknown";
    }
  }
  if (result?.ok === true && result?.valid === false
    && !authoritativeTerminal && !credentialCodeStatus && !subscriptionCodeStatus) {
    detectionStatus = "inconclusive";
    code = "invalidity_unconfirmed";
    reason = "上游未返回明确失效代码，账号状态保持不变";
    retryable = false;
    accountStatus = "unknown";
  }
  if (!requestFailure && result?.ok === true && result?.valid !== false && !transientDetection
    && !authoritativeTerminal && !credentialCodeStatus && !subscriptionCodeStatus
    && !planEvidence.observed) {
    detectionStatus = "inconclusive";
    code = rawCode && !new Set(["ok", "check_completed"]).has(rawCode)
      ? rawCode : "plan_not_detected";
    reason = rawReason && code !== "plan_not_detected"
      ? rawReason : "本次未从权威套餐接口取得类型，已保留上次套餐";
    retryable = true;
    accountStatus = "unknown";
    credentialStatus = "unknown";
    subscriptionStatus = "unknown";
  }
  if (detectionStatus === "confirmed") {
    if (authoritativeTerminal) {
      accountStatus = terminalStatus;
    } else if (result?.valid === true) {
      accountStatus = "active";
      if (credentialStatus === "unknown") credentialStatus = "valid";
    }
    if (!code) code = "check_completed";
    if (!reason) reason = "账号状态检测完成";
    retryable = false;
  }
  if (subscriptionStatus === "unknown") {
    subscriptionStatus = normalizeSubscriptionStatus("", fallbackSignals.plan_state);
  }
  const accountType = plan.known ? plan.type : "unknown";
  const outcome = {
    external_account_id: String(id),
    id: Number(id),
    account_id: Number(id),
    email: safeRemoteText(email, 320).toLowerCase(),
    checked: detectionStatus === "confirmed",
    detection_status: detectionStatus,
    account_status: accountStatus,
    credential_status: credentialStatus,
    subscription_status: subscriptionStatus,
    account_type: accountType,
    account_type_raw: plan.raw,
    type_observed: planEvidence.observed,
    type: accountType,
    type_raw: plan.raw,
    status: accountStatus,
    code,
    reason,
    retryable,
    source,
    http_status: Math.max(0, Number(result?.status_http ?? result?.http_status) || 0),
    evidence_path: safeAccountCheckText(
      result?.status_evidence_path ?? result?.evidence_path,
      160,
    ),
    checked_at: checkedAt,
    attempted_at: attemptedAt,
    time: checkedAt,
  };
  return {
    ...outcome,
    status_http: outcome.http_status,
    status_evidence_path: outcome.evidence_path,
    error: outcome.checked ? "" : outcome.reason,
  };
}

function normalizeStoredStatusOutcome(row = {}) {
  return {
    external_account_id: String(row.external_account_id || row.id || ""),
    email: safeRemoteText(row.email, 320).toLowerCase(),
    detection_status: normalizeRemoteSignal(row.detection_status, "unchecked"),
    account_status: normalizeAccountStatus(row.account_status),
    credential_status: normalizeCredentialStatus(row.credential_status),
    subscription_status: normalizeSubscriptionStatus(row.subscription_status),
    account_type: normalizePlanType(row.account_type).type,
    account_type_raw: safeAccountCheckText(row.account_type_raw, 120),
    code: normalizeCheckCode(row.code),
    reason: safeAccountCheckText(row.reason),
    retryable: Boolean(row.retryable),
    source: safeAccountCheckText(row.source, 100),
    http_status: Math.max(0, Number(row.http_status || row.status_http) || 0),
    evidence_path: safeAccountCheckText(row.evidence_path || row.status_evidence_path, 160),
    checked_at: safeRemoteText(row.checked_at, 80),
    attempted_at: safeRemoteText(row.attempted_at, 80),
  };
}

function passwordMetadataFromAccount(item = {}) {
  const overview = item.overview && typeof item.overview === "object" ? item.overview : {};
  const allowed = new Set(["configured", "not_configured", "failed", "unknown"]);
  const status = allowed.has(overview.password_status) ? overview.password_status : "unknown";
  const source = String(overview.password_source || (status === "not_configured" ? "none" : ""));
  const password = status === "configured" ? String(item.password || "") : "";
  const error = status === "failed" ? String(overview.password_error || "").slice(0, 500) : "";
  return {
    password,
    password_status: status,
    password_source: source,
    password_error: error,
    password_available: Boolean(password),
  };
}

function normalizeOptionalPassword(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") {
    throw Object.assign(new Error("指定密码必须是字符串"), { status: 400 });
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw Object.assign(new Error("指定密码不能包含控制字符"), { status: 400 });
  }
  if (value !== value.trim()) {
    throw Object.assign(new Error("指定密码不能包含首尾空白"), { status: 400 });
  }
  const length = [...value].length;
  if (length < 12 || length > 128) {
    throw Object.assign(new Error("指定密码长度必须为 12 到 128 个字符"), { status: 400 });
  }
  return value;
}

function positiveAccountId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw Object.assign(new Error("注册账号 ID 无效"), { status: 400 });
  }
  return id;
}

function normalizedActionTaskId(value) {
  const id = String(value || "").trim();
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw Object.assign(new Error("设置密码任务 ID 无效"), { status: 400 });
  }
  return id;
}

function assertPasswordSetupTask(task, expectedTaskId = "") {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw Object.assign(new Error("设置密码服务返回了无效任务"), { status: 502 });
  }
  const taskId = String(task.task_id || task.id || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskId) || (expectedTaskId && taskId !== expectedTaskId)) {
    throw Object.assign(new Error("设置密码任务标识不匹配"), { status: 502 });
  }
  if (String(task.type || "").toLowerCase() !== "platform_action"
    || String(task.platform || "").toLowerCase() !== "chatgpt") {
    throw Object.assign(new Error("设置密码任务类型不匹配"), { status: 502 });
  }
  const status = String(task.status || "").toLowerCase();
  if (!new Set([
    "pending", "claimed", "queued", "running", "cancel_requested",
    "succeeded", "completed", "failed", "cancelled", "interrupted",
  ]).has(status)) {
    throw Object.assign(new Error("设置密码任务状态无效"), { status: 502 });
  }
  return taskId;
}

function publicPasswordSetupTask(task) {
  const taskId = String(task.task_id || task.id || "");
  const mappedStatus = statusFromExternal(task.status);
  const status = new Set(["queued", "running", "cancel_requested", "completed", "failed", "cancelled", "interrupted"])
    .has(mappedStatus) ? mappedStatus : "failed";
  const progressCurrent = Math.max(0, Number(task.progress_current ?? task.progress_detail?.current ?? 0) || 0);
  const progressTotal = Math.max(0, Number(task.progress_total ?? task.progress_detail?.total ?? 1) || 0);
  const terminal = TERMINAL_STATUSES.has(status);
  const result = {
    task_id: taskId,
    status,
    terminal,
    cancellable: !terminal && new Set(["queued", "running", "cancel_requested"]).has(status),
    progress_current: progressCurrent,
    progress_total: progressTotal,
  };
  if (status === "failed" || status === "interrupted") result.error = "设置密码任务失败";
  if (status === "cancelled") result.error = "设置密码任务已取消";
  return result;
}

function safePasswordSetupEventMessage(value) {
  const message = String(value || "").toLowerCase();
  if (/基线/.test(message) && /刷新/.test(message)) return "已刷新邮箱验证码基线";
  if (/等待/.test(message) && /验证码/.test(message)) return "等待设置密码邮箱验证码";
  if (/验证码/.test(message) && /(通过|验证|提交|成功)/.test(message)) return "设置密码邮箱验证码已验证";
  if (/(新密码|新增密码)/.test(message) && /提交/.test(message)) return "新密码已提交";
  if (/(成功页|password_status)/.test(message) && /(确认|configured)/.test(message)) return "设置密码成功页已确认";
  if (/(取消|cancel)/.test(message)) return "设置密码任务已取消";
  if (/(失败|错误|异常|failed|error)/.test(message)) return "设置密码任务失败";
  if (/(完成|成功|configured)/.test(message)) return "设置密码任务已完成";
  if (/(创建|开始|启动|running|claimed)/.test(message)) return "设置密码任务已启动";
  return "设置密码任务处理中";
}

function publicPasswordSetupEvents(response) {
  const events = Array.isArray(response) ? response : (response?.items || response?.events || []);
  return events.slice(-300).map((item) => {
    const type = String(item?.type || "log").toLowerCase();
    const level = String(item?.level || "info").toLowerCase();
    const createdAt = String(item?.created_at || "");
    return {
      id: Number(item?.id) || 0,
      type: new Set(["log", "state", "summary", "progress"]).has(type) ? type : "log",
      level: new Set(["info", "warning", "error", "success"]).has(level) ? level : "info",
      message: safePasswordSetupEventMessage(eventMessage(item)),
      created_at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(createdAt) ? createdAt.slice(0, 40) : "",
    };
  });
}

function accountMetadataValue(input, key, label, maximum) {
  if (!Object.hasOwn(input, key)) return undefined;
  if (typeof input[key] !== "string") {
    throw Object.assign(new Error(`${label}必须是字符串`), { status: 400 });
  }
  const value = input[key].trim();
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw Object.assign(new Error(`${label}不能包含控制字符`), { status: 400 });
  }
  if ([...value].length > maximum) {
    throw Object.assign(new Error(`${label}最多 ${maximum} 个字符`), { status: 400 });
  }
  return value;
}

function statusFromExternal(value) {
  const status = String(value || "").toLowerCase();
  if (status === "succeeded") return "completed";
  if (status === "pending" || status === "claimed") return "queued";
  if (status === "cancel_requested") return "cancel_requested";
  return status || "queued";
}

function eventMessage(item) {
  return String(item?.message || item?.detail?.message || "");
}

function identityFromEvents(events = []) {
  let exitIp = "";
  let displayName = "";
  let birthDate = "";
  let fingerprintId = "";
  for (const item of [...events].reverse()) {
    const text = eventMessage(item);
    if (!exitIp) exitIp = text.match(/(?:浏览器代理出口|代理出口|出口)\s*IP[:：]\s*([0-9a-f:.]+)/i)?.[1] || "";
    if (!fingerprintId) fingerprintId = text.match(/随机指纹会话[:：]\s*([a-f0-9]{12,64})/i)?.[1]?.slice(0, 12) || "";
    let match = text.match(/生成用户信息:\s*([^,，]+)[,，]\s*生日:\s*(\d{4}-\d{2}-\d{2})/i);
    if (!match) match = text.match(/about_you[^:：]*[:：].*?name=([^,，]+)[,，]\s*birthdate=(\d{4}-\d{2}-\d{2})/i);
    if (match && !displayName) {
      displayName = match[1].trim();
      birthDate = match[2];
    }
    if (displayName && exitIp && fingerprintId) break;
  }
  return { displayName, birthDate, exitIp, fingerprintId };
}

export class RegistrationService {
  constructor({ db, graph, client, publicBaseUrl, mailboxBaseUrl, browserUrl } = {}) {
    this.db = db;
    this.graph = graph;
    this.client = client;
    this.connectorKey = getSetting(db, "registration_connector_key", "");
    this.mailboxBaseUrl = String(mailboxBaseUrl || publicBaseUrl || "").replace(/\/$/, "");
    this.browserUrl = browserUrl || "/alias-hub/browser/vnc.html?autoconnect=true&resize=scale&path=websockify";
    this.scanPromises = new Map();
    this.accountStatusRefreshAttempts = new Map();
    this.accountStatusCheckOutcomes = new Map();
    try {
      for (const row of listRegisteredAccountStatusChecks(db)) {
        const outcome = normalizeStoredStatusOutcome(row);
        if (outcome.external_account_id) {
          this.accountStatusCheckOutcomes.set(outcome.external_account_id, outcome);
        }
      }
    } catch {
      // Keep the in-memory Map fallback for callers using an older test database.
    }
  }

  persistAccountStatusOutcome(outcome) {
    const normalized = normalizeStoredStatusOutcome(outcome);
    if (!normalized.external_account_id || !normalized.email) return normalized;
    this.accountStatusCheckOutcomes.set(normalized.external_account_id, normalized);
    try {
      upsertRegisteredAccountStatusCheck(this.db, normalized);
    } catch {
      // Existing in-memory behavior remains available if SQLite cannot be upgraded.
    }
    return normalized;
  }

  requireConnectorKey(req, res, next) {
    if (!timingSafeEqual(req.get("X-API-Key"), this.connectorKey)) return res.status(401).json({ success: false, error: "API Key 无效" });
    return next();
  }

  getProxyPool() {
    return parseProxyPool(getSetting(this.db, "registration_proxy_pool", "[]"));
  }

  saveProxyPool(input) {
    const proxies = parseProxyPool(input);
    setSetting(this.db, "registration_proxy_pool", JSON.stringify(proxies));
    return {
      count: proxies.length,
      proxies,
      masked: proxies.map(maskProxy),
      proxyMetadata: proxies.map(proxyMetadata),
    };
  }

  async inspectProxy(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw Object.assign(new Error("代理检测参数无效"), { status: 400 });
    }
    const [url] = parseProxyPool([input.url]);
    if (!url) throw Object.assign(new Error("请选择要检测的代理"), { status: 400 });
    const samples = Number(input.samples ?? 3);
    const delayMs = Number(input.delay_ms ?? 350);
    if (!Number.isSafeInteger(samples) || samples < 1 || samples > 5) {
      throw Object.assign(new Error("动态 IP 检测次数必须是 1 到 5"), { status: 400 });
    }
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 2_000) {
      throw Object.assign(new Error("动态 IP 检测间隔必须是 0 到 2000 毫秒"), { status: 400 });
    }
    try {
      const stickyTemplate = kookeeyStickyTemplate(url);
      let safeSamples;
      let upstreamDynamic;
      if (stickyTemplate) {
        safeSamples = [];
        const usedSessions = new Set();
        for (let index = 0; index < samples; index += 1) {
          const sampleUrl = materializeProxySession(url, usedSessions);
          const result = await this.client.inspectProxy({ url: sampleUrl, samples: 1, delay_ms: 0 });
          const [sample] = safeProxySamples(result, 1);
          if (!sample) throw new Error("代理检测服务未返回出口 IP");
          safeSamples.push(sample);
          if (index + 1 < samples && delayMs) await wait(delayMs);
        }
      } else {
        const result = await this.client.inspectProxy({ url, samples, delay_ms: delayMs });
        safeSamples = safeProxySamples(result, samples);
        upstreamDynamic = typeof result?.dynamic === "boolean"
          ? result.dynamic
          : (typeof result?.is_dynamic === "boolean" ? result.is_dynamic : undefined);
      }
      if (!safeSamples.length) throw new Error("代理检测服务未返回出口 IP");
      const distinctIps = [...new Set(safeSamples.map((item) => item.ip))];
      const rotationVerified = distinctIps.length > 1;
      const response = {
        dynamic: stickyTemplate ? true : (upstreamDynamic ?? rotationVerified),
        rotation_verified: rotationVerified,
        distinct_ips: distinctIps,
        samples: safeSamples,
      };
      if (stickyTemplate) {
        Object.assign(response, {
          dynamic_mode: "sticky_session",
          provider: "Kookeey",
          session_ttl: stickyTemplate.sessionTtl,
        });
      }
      return response;
    } catch (error) {
      const status = Number(error?.status);
      throw Object.assign(new Error("代理检测失败，请检查代理地址和可用性"), {
        status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502,
      });
    }
  }

  async options() {
    const baseJobs = this.db.prepare(`
      SELECT registration_jobs.email, registration_jobs.status, registration_jobs.stage, registration_jobs.message
      FROM registration_jobs
      JOIN addresses job_address ON job_address.id = registration_jobs.address_id
      WHERE job_address.parent_address_id = ? OR job_address.id = ?
      ORDER BY registration_jobs.created_at DESC, registration_jobs.id DESC
    `);
    const accounts = this.db.prepare("SELECT * FROM source_accounts WHERE status = 'connected' AND provider IN ('microsoft', 'google', 'icloud') ORDER BY updated_at DESC").all().map((account) => {
      const direct = account.provider === "icloud";
      const bases = this.db.prepare("SELECT id, address, kind, label, strategy FROM addresses WHERE account_id = ? AND kind IN ('primary', 'official') AND status = 'active' ORDER BY kind = 'primary' DESC, created_at")
        .all(account.id)
        .filter((base) => !direct || base.kind === "primary" || isIcloudImportedStrategy(base.strategy));
      return {
        id: account.id,
        email: account.email,
        display_name: account.display_name,
        provider: account.provider,
        registration_mode: direct ? "direct" : "split",
        max_registration_count: direct ? 1 : 20,
        bases: bases.map((base) => {
        const jobs = baseJobs.all(base.id, base.id);
        const latest = jobs[0];
        const conflicts = new Set();
        for (const job of jobs) {
          if (job.status === "completed") break;
          if (registrationFailureReason(job) === "user_already_exists") conflicts.add(String(job.email || "").toLowerCase());
        }
        const conflictCount = conflicts.size;
        const activeDirectJob = direct && jobs.some((job) => RELEASABLE_JOB_STATUSES.has(String(job.status || "")));
        const completedDirectJob = direct && jobs.some((job) => job.status === "completed");
        const registrationState = activeDirectJob ? "in_progress"
          : completedDirectJob ? "used"
            : conflictCount >= 2 ? "likely_exhausted" : (conflictCount === 1 ? "warning" : "available");
        return {
          ...base,
          registration_state: registrationState,
          registration_disabled: activeDirectJob || completedDirectJob,
          already_exists_count: conflictCount,
          registration_success_count: jobs.filter((job) => job.status === "completed").length,
          last_registration_status: latest?.status || "",
          registration_hint: activeDirectJob
            ? "这个 iCloud 地址已有进行中的注册任务，请等待任务结束。"
            : completedDirectJob
              ? "这个 iCloud 地址已经用于成功注册；请导入新的隐藏邮箱反代地址继续注册。"
              : direct
                ? "iCloud 地址会直接用于注册，不会生成 +tag 分裂地址。"
                : registrationState === "likely_exhausted"
            ? "这个基础地址已有多次邮箱占用冲突，疑似不再适合继续分裂注册，建议更换基础地址。"
            : (registrationState === "warning" ? "这个基础地址最近出现邮箱占用冲突，再次失败时请更换基础地址。" : ""),
        };
      }),
      };
    });
    const proxies = this.getProxyPool();
    return {
      accounts,
      proxies,
      maskedProxies: proxies.map(maskProxy),
      proxyMetadata: proxies.map(proxyMetadata),
      browserUrl: this.browserUrl,
      service: await this.client.health(),
    };
  }

  async createJobs(input = {}) {
    const count = Math.max(1, Math.min(20, Number(input.count) || 1));
    const requestedBrowserMode = new Set(["headed", "headless"]).has(input.browserMode) ? input.browserMode : "headed";
    const customSuffix = String(input.suffix || "").trim();
    const setPasswordAfterRegistration = input.setPasswordAfterRegistration ?? false;
    if (typeof setPasswordAfterRegistration !== "boolean") {
      throw Object.assign(new Error("注册后设置密码必须是布尔值"), { status: 400 });
    }
    const autoContinuePostSignup = input.autoContinuePostSignup ?? true;
    if (typeof autoContinuePostSignup !== "boolean") {
      throw Object.assign(new Error("注册后自动完成准备页面必须是布尔值"), { status: 400 });
    }
    const requestedPassword = input.password ?? "";
    if (typeof requestedPassword !== "string") {
      throw Object.assign(new Error("指定密码必须是字符串"), { status: 400 });
    }
    if (requestedPassword && !setPasswordAfterRegistration) {
      throw Object.assign(new Error("请先勾选注册后设置密码再填写指定密码"), { status: 400 });
    }
    if (/[\u0000-\u001f\u007f-\u009f]/.test(requestedPassword)) {
      throw Object.assign(new Error("指定密码不能包含控制字符"), { status: 400 });
    }
    if (requestedPassword && requestedPassword !== requestedPassword.trim()) {
      throw Object.assign(new Error("指定密码不能包含首尾空白"), { status: 400 });
    }
    const passwordLength = [...requestedPassword].length;
    if (requestedPassword && (passwordLength < 12 || passwordLength > 128)) {
      throw Object.assign(new Error("指定密码长度必须为 12 到 128 个字符"), { status: 400 });
    }
    const browserMode = autoContinuePostSignup ? requestedBrowserMode : "headed";
    const account = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(input.accountId));
    if (!account) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
    if (account.status !== "connected") throw Object.assign(new Error("请先完成这个源头邮箱的连接验证"), { status: 409 });
    if (!["microsoft", "google", "icloud"].includes(account.provider)) {
      throw Object.assign(new Error("这个邮箱提供商不支持注册地址"), { status: 409 });
    }
    const base = this.db.prepare("SELECT * FROM addresses WHERE id = ? AND account_id = ? AND kind IN ('primary', 'official') AND status = 'active'").get(Number(input.baseAddressId), account.id);
    if (!base) throw Object.assign(new Error("请选择可用的基础地址"), { status: 400 });
    const directIcloud = account.provider === "icloud";
    if (directIcloud && base.kind === "official" && !isIcloudImportedStrategy(base.strategy)) {
      throw Object.assign(new Error("请选择已导入的 iCloud 邮箱别名或隐藏邮箱反代地址"), { status: 400 });
    }
    if (directIcloud && count !== 1) {
      throw Object.assign(new Error("iCloud 别名和隐藏邮箱反代地址每次只能提交 1 个注册任务"), { status: 400 });
    }
    if (directIcloud && customSuffix) {
      throw Object.assign(new Error("iCloud 地址不支持 Plus 分裂后缀，请直接选择已导入的别名或隐藏邮箱反代地址"), { status: 400 });
    }
    const proxies = resolveJobProxies(input, this.getProxyPool());
    let addresses;
    if (directIcloud) {
      const existing = this.db.prepare(`
        SELECT status FROM registration_jobs
        WHERE address_id = ?
          AND status IN ('queued', 'pending', 'claimed', 'running', 'cancel_requested', 'completed')
        ORDER BY created_at DESC, id DESC LIMIT 1
      `).get(base.id);
      if (existing) {
        const message = existing.status === "completed"
          ? "这个 iCloud 地址已经用于成功注册，请导入新的隐藏邮箱反代地址"
          : "这个 iCloud 地址已有进行中的注册任务";
        throw Object.assign(new Error(message), { status: 409 });
      }
      addresses = [base];
    } else {
      addresses = generateSplits(this.db, account, {
        baseAddressIds: [base.id],
        countPerBase: count,
        prefix: "gpt",
        mode: "random",
        randomLength: 10,
        customSuffix,
        label: "GPT 注册",
        purpose: "ChatGPT 注册",
      });
    }
    const jobs = [];
    const usedProxySessions = new Set();
    for (let index = 0; index < addresses.length; index += 1) {
      const address = addresses[index];
      const proxyTemplate = proxies.length ? proxies[index % proxies.length] : "";
      const proxy = materializeProxySession(proxyTemplate, usedProxySessions);
      const now = nowIso();
      const result = this.db.prepare(`
        INSERT INTO registration_jobs (
          account_id, address_id, email, status, stage, browser_mode, proxy_label, fingerprint_id,
          message, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', 'queued', ?, ?, ?, '正在提交注册任务', ?, ?)
      `).run(account.id, address.id, address.address, browserMode, maskProxy(proxy), crypto.randomUUID().slice(0, 12), now, now);
      const jobId = Number(result.lastInsertRowid);
      try {
        const task = await this.client.createTask({
          platform: "chatgpt",
          email: address.address,
          password: requestedPassword || null,
          count: 1,
          concurrency: 1,
          proxy: proxy || null,
          executor_type: browserMode,
          captcha_solver: "auto",
          extra: {
            identity_provider: "mailbox",
            mail_provider: "outlook_email_api",
            mail_source_provider: account.provider,
            outlook_email_api_url: this.mailboxBaseUrl,
            outlook_email_api_key: this.connectorKey,
            outlook_email_fixed_email: address.address,
            outlook_email_folder: "all",
            outlook_email_top: "20",
            outlook_email_poll_interval: "3",
            fresh_browser_context: true,
            random_fingerprint: true,
            email_only_registration: true,
            disable_phone_verification: true,
            phone_verification_policy: "forbid",
            allow_chatgpt_registration_proxy: true,
            set_password_after_registration: setPasswordAfterRegistration,
            auto_continue_post_signup: autoContinuePostSignup,
          },
        });
        const taskId = String(task.task_id || task.id || "");
        this.db.prepare("UPDATE registration_jobs SET external_task_id = ?, message = ?, updated_at = ? WHERE id = ?")
          .run(taskId, "任务已提交，等待执行", nowIso(), jobId);
      } catch {
        this.db.prepare("UPDATE registration_jobs SET status = 'failed', stage = 'submit', message = ?, finished_at = ?, updated_at = ? WHERE id = ?")
          .run("注册任务提交失败", nowIso(), nowIso(), jobId);
      }
      jobs.push(publicRegistrationJob(this.getJob(jobId)));
    }
    return jobs;
  }

  getJob(id) {
    return this.db.prepare(`
      SELECT registration_jobs.*, source_accounts.email AS source_email
      FROM registration_jobs LEFT JOIN source_accounts ON source_accounts.id = registration_jobs.account_id
      WHERE registration_jobs.id = ? AND registration_jobs.deleted_at IS NULL
    `).get(Number(id));
  }

  async syncJob(row) {
    if (!row?.external_task_id || TERMINAL_STATUSES.has(row.status)) return row;
    try {
      const task = await this.client.getTask(row.external_task_id);
      let events = [];
      if (!row.display_name || ACTIVE_STATUSES.has(String(task.status || ""))) {
        const response = await this.client.getTaskEvents(row.external_task_id);
        const remoteEvents = Array.isArray(response) ? response : response.items || response.events || [];
        events = sanitizeRegistrationRemoteValue(remoteEvents);
      }
      const identity = identityFromEvents(events);
      const status = statusFromExternal(task.status);
      const lastMessage = events.length ? eventMessage(events[events.length - 1]) : "";
      let externalAccountId = row.external_account_id;
      if (status === "completed") {
        const accounts = await this.client.listAccounts({ email: row.email, pageSize: 10 });
        const match = (accounts.items || []).find((item) => String(item.email).toLowerCase() === row.email.toLowerCase());
        externalAccountId = String(match?.id || externalAccountId || "");
      }
      const finishedAt = TERMINAL_STATUSES.has(status) ? (row.finished_at || nowIso()) : null;
      this.db.prepare(`
        UPDATE registration_jobs SET external_account_id = ?, status = ?, stage = ?,
          display_name = ?, birth_date = ?, exit_ip = ?, fingerprint_id = ?, progress_current = ?, progress_total = ?,
          message = ?, finished_at = ?, updated_at = ? WHERE id = ?
      `).run(
        externalAccountId,
        status,
        redactProxySecrets(task.type || task.status || status),
        identity.displayName || row.display_name,
        identity.birthDate || row.birth_date,
        identity.exitIp || row.exit_ip,
        identity.fingerprintId || row.fingerprint_id,
        Number(task.progress_current ?? task.success ?? row.progress_current ?? 0),
        Math.max(1, Number(task.progress_total ?? row.progress_total ?? 1)),
        redactProxySecrets(task.error || lastMessage || row.message || ""),
        finishedAt,
        nowIso(),
        row.id,
      );
      if (status === "completed" && row.address_id) {
        this.db.prepare(`
          UPDATE verification_codes SET is_used = 1, is_hidden = 1
          WHERE address_id = ? AND received_at >= ?
        `).run(row.address_id, row.created_at);
      }
    } catch (error) {
      const message = redactProxySecrets(error?.message) || "同步注册任务状态失败";
      this.db.prepare("UPDATE registration_jobs SET message = ?, updated_at = ? WHERE id = ?").run(message, nowIso(), row.id);
    }
    return this.getJob(row.id);
  }

  async listJobs({ limit = 100 } = {}) {
    const rows = this.db.prepare(`
      SELECT registration_jobs.*, source_accounts.email AS source_email
      FROM registration_jobs LEFT JOIN source_accounts ON source_accounts.id = registration_jobs.account_id
      WHERE registration_jobs.deleted_at IS NULL
      ORDER BY registration_jobs.created_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(500, Number(limit) || 100)));
    const synced = await Promise.all(rows.map((row) => this.syncJob(row)));
    return synced.map(publicRegistrationJob);
  }

  async cancelJob(id) {
    const row = this.getJob(id);
    if (!row) throw Object.assign(new Error("注册任务不存在"), { status: 404 });
    if (TERMINAL_STATUSES.has(row.status)) return publicRegistrationJob(row);
    if (!row.external_task_id) {
      const finishedAt = nowIso();
      this.db.prepare("UPDATE registration_jobs SET status = 'cancelled', message = '任务已取消', finished_at = ?, updated_at = ? WHERE id = ?")
        .run(finishedAt, finishedAt, row.id);
      return publicRegistrationJob(this.getJob(row.id));
    }

    const cancelledTask = await this.client.cancelTask(row.external_task_id);
    const remoteStatus = statusFromExternal(cancelledTask?.status);
    if (TERMINAL_STATUSES.has(remoteStatus)) {
      const finishedAt = nowIso();
      const message = remoteStatus === "cancelled" ? "任务已取消" : redactProxySecrets(cancelledTask?.error || "任务已结束");
      this.db.prepare("UPDATE registration_jobs SET status = ?, message = ?, finished_at = ?, updated_at = ? WHERE id = ?")
        .run(remoteStatus, message, finishedAt, finishedAt, row.id);
    } else {
      const updatedAt = nowIso();
      this.db.prepare("UPDATE registration_jobs SET status = 'cancel_requested', message = '已请求取消；任务未退出时可强制释放', finished_at = NULL, updated_at = ? WHERE id = ?")
        .run(updatedAt, row.id);
    }
    return publicRegistrationJob(this.getJob(row.id));
  }

  async releaseJob(id) {
    const jobId = Number(id);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      throw Object.assign(new Error("注册任务 ID 无效"), { status: 400 });
    }
    const row = this.getJob(jobId);
    if (!row) throw Object.assign(new Error("注册任务不存在"), { status: 404 });
    if (!RELEASABLE_JOB_STATUSES.has(String(row.status || ""))) {
      const message = row.status === "completed" ? "注册成功的任务不能释放" : "任务已经结束，无需释放";
      throw Object.assign(new Error(message), { status: 409 });
    }

    let releaseResult = { release_mode: "local_only", status: "interrupted" };
    if (row.external_task_id) {
      releaseResult = await this.client.releaseTask(row.external_task_id);
    }
    const remoteStatus = statusFromExternal(releaseResult?.status);
    if (remoteStatus === "completed") {
      await this.syncJob(row);
      throw Object.assign(new Error("远端任务已经注册成功，不能释放"), { status: 409 });
    }

    const nextStatus = remoteStatus === "cancelled" ? "cancelled" : "interrupted";
    const releaseMode = String(releaseResult?.release_mode || (row.external_task_id ? "force_release" : "local_only"));
    const message = nextStatus === "cancelled" ? "远端任务已取消并释放" : "任务已强制释放并标记为中断";
    const finishedAt = nowIso();
    const result = this.db.prepare(`
      UPDATE registration_jobs SET status = ?, stage = 'released', message = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
        AND status IN ('queued', 'pending', 'claimed', 'running', 'cancel_requested')
    `).run(nextStatus, message, finishedAt, finishedAt, row.id);
    if (!result.changes) {
      const latest = this.getJob(row.id);
      const reason = latest?.status === "completed" ? "注册任务已成功，不能释放" : "注册任务状态已变化，请刷新后重试";
      throw Object.assign(new Error(reason), { status: 409 });
    }
    return {
      item: publicRegistrationJob(this.getJob(row.id)),
      release_mode: releaseMode,
      remote_status: String(releaseResult?.status || ""),
    };
  }

  deleteJob(id) {
    const jobId = Number(id);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      throw Object.assign(new Error("注册记录 ID 无效"), { status: 400 });
    }
    const row = this.getJob(jobId);
    if (!row) throw Object.assign(new Error("注册记录不存在"), { status: 404 });
    if (!TERMINAL_STATUSES.has(row.status)) {
      throw Object.assign(new Error("运行中的任务不能删除，请先取消任务"), { status: 409 });
    }
    const deletedAt = nowIso();
    const result = this.db.prepare(`
      UPDATE registration_jobs SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
    `).run(deletedAt, deletedAt, row.id);
    if (!result.changes) throw Object.assign(new Error("注册记录状态已变化，请刷新后重试"), { status: 409 });
    return { deleted: 1, id: row.id };
  }

  deleteJobs(input = {}) {
    const ids = normalizeSelectedIds(input, "注册记录");
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT id, status FROM registration_jobs
      WHERE id IN (${placeholders}) AND deleted_at IS NULL
    `).all(...ids);
    if (rows.length !== ids.length) {
      throw Object.assign(new Error("部分注册记录不存在，请刷新后重试"), { status: 404 });
    }
    if (rows.some((row) => !TERMINAL_STATUSES.has(row.status))) {
      throw Object.assign(new Error("选择中包含运行中的任务，请先取消任务"), { status: 409 });
    }
    const deletedAt = nowIso();
    const result = this.db.transaction(() => this.db.prepare(`
      UPDATE registration_jobs SET deleted_at = ?, updated_at = ?
      WHERE id IN (${placeholders}) AND deleted_at IS NULL
        AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
    `).run(deletedAt, deletedAt, ...ids))();
    if (result.changes !== ids.length) {
      throw Object.assign(new Error("注册记录状态已变化，请刷新后重试"), { status: 409 });
    }
    return { deleted: result.changes, ids };
  }

  async taskEvents(id) {
    const row = this.getJob(id);
    if (!row) throw Object.assign(new Error("注册任务不存在"), { status: 404 });
    if (!row.external_task_id) return [];
    try {
      const response = await this.client.getTaskEvents(row.external_task_id);
      const events = Array.isArray(response) ? response : response.items || response.events || [];
      return sanitizeRegistrationRemoteValue(events);
    } catch (error) {
      throw Object.assign(new Error(redactProxySecrets(error?.message) || "读取注册任务事件失败"), {
        status: Number.isInteger(Number(error?.status)) ? Number(error.status) : 502,
      });
    }
  }

  async passwordSetupTarget(id, { allowConfigured = false } = {}) {
    const accountId = positiveAccountId(id);
    const job = this.db.prepare(`
      SELECT registration_jobs.*, addresses.address AS mapped_address,
        addresses.account_id AS mapped_account_id, source_accounts.status AS source_status
      FROM registration_jobs
      LEFT JOIN addresses ON addresses.id = registration_jobs.address_id
      LEFT JOIN source_accounts ON source_accounts.id = registration_jobs.account_id
      WHERE registration_jobs.external_account_id = ?
      ORDER BY registration_jobs.created_at DESC, registration_jobs.id DESC
      LIMIT 1
    `).get(String(accountId));
    if (!job || String(job.status || "") !== "completed") {
      throw Object.assign(new Error("账号缺少已完成注册映射，拒绝补设密码"), { status: 409 });
    }
    if (!Number.isSafeInteger(Number(job.address_id)) || Number(job.address_id) <= 0 || !job.mapped_address) {
      throw Object.assign(new Error("注册记录缺少原邮箱地址映射，拒绝补设密码"), { status: 409 });
    }
    if (Number(job.account_id) <= 0 || Number(job.mapped_account_id) !== Number(job.account_id)) {
      throw Object.assign(new Error("注册记录的源邮箱映射不一致，拒绝补设密码"), { status: 409 });
    }
    if (String(job.source_status || "") !== "connected") {
      throw Object.assign(new Error("原源头邮箱当前未连接，拒绝补设密码"), { status: 409 });
    }

    const mappedEmail = String(job.mapped_address || "").trim().toLowerCase();
    if (!mappedEmail || mappedEmail !== String(job.email || "").trim().toLowerCase()) {
      throw Object.assign(new Error("注册记录与原邮箱地址不一致，拒绝补设密码"), { status: 409 });
    }
    const account = await this.client.getAccount(accountId);
    if (!account) throw Object.assign(new Error("账号已从本地账号池删除"), { status: 404 });
    if (Number(account.id) !== accountId
      || String(account.platform || "").toLowerCase() !== "chatgpt"
      || String(account.email || "").trim().toLowerCase() !== mappedEmail) {
      throw Object.assign(new Error("远端账号与原邮箱地址映射不一致，拒绝补设密码"), { status: 409 });
    }
    const password = passwordMetadataFromAccount(account);
    if (!allowConfigured && password.password_status === "configured") {
      throw Object.assign(new Error("这个账号已经配置密码"), { status: 409 });
    }
    return { accountId, job, account, password };
  }

  passwordSetupProxy(job) {
    const proxyLabel = String(job?.proxy_label || "").trim();
    if (proxyLabel === "直连") return "";
    if (!proxyLabel) {
      throw Object.assign(new Error("注册记录缺少原代理信息，拒绝补设密码"), { status: 409 });
    }
    const matches = this.getProxyPool().filter((proxy) => maskProxy(proxy) === proxyLabel);
    if (matches.length !== 1) {
      throw Object.assign(new Error("无法唯一还原注册时使用的代理，拒绝补设密码"), { status: 409 });
    }
    return matches[0];
  }

  passwordSetupTaskMapping(id, taskId) {
    const accountId = positiveAccountId(id);
    const normalizedTaskId = normalizedActionTaskId(taskId);
    const mapping = this.db.prepare(`
      SELECT task_id, external_account_id, status
      FROM registration_password_setup_tasks
      WHERE task_id = ? AND external_account_id = ?
    `).get(normalizedTaskId, accountId);
    if (!mapping) {
      throw Object.assign(new Error("设置密码任务映射不存在或已失效"), { status: 409 });
    }
    return { accountId, taskId: normalizedTaskId };
  }

  activePasswordSetupTask(accountId) {
    return this.db.prepare(`
      SELECT task_id, external_account_id, status
      FROM registration_password_setup_tasks
      WHERE external_account_id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(accountId);
  }

  updatePasswordSetupTaskStatus(taskId, status) {
    const updatedAt = nowIso();
    this.db.prepare(`
      UPDATE registration_password_setup_tasks
      SET status = ?, updated_at = ?
      WHERE task_id = ?
    `).run(status, updatedAt, taskId);
  }

  passwordSetupAvailability(job, account, password) {
    if (password.password_status === "configured") {
      return { available: false, reason: "密码已配置" };
    }
    const accountId = Number(account?.id);
    if (!Number.isSafeInteger(accountId) || accountId <= 0
      || !job || String(job.status || "") !== "completed"
      || String(job.external_account_id || "") !== String(accountId)) {
      return { available: false, reason: "缺少已完成注册映射" };
    }
    if (this.activePasswordSetupTask(accountId)) {
      return { available: false, reason: "设置密码任务正在进行" };
    }
    const addressId = Number(job.address_id);
    if (!Number.isSafeInteger(addressId) || addressId <= 0) {
      return { available: false, reason: "缺少原邮箱地址映射" };
    }
    const address = this.db.prepare(`
      SELECT addresses.address, addresses.account_id, source_accounts.status AS source_status
      FROM addresses
      LEFT JOIN source_accounts ON source_accounts.id = addresses.account_id
      WHERE addresses.id = ?
    `).get(addressId);
    if (!address || Number(address.account_id) !== Number(job.account_id)) {
      return { available: false, reason: "原邮箱地址映射不一致" };
    }
    const mappedEmail = String(address.address || "").trim().toLowerCase();
    if (!mappedEmail
      || mappedEmail !== String(job.email || "").trim().toLowerCase()
      || mappedEmail !== String(account.email || "").trim().toLowerCase()) {
      return { available: false, reason: "原邮箱地址映射不一致" };
    }
    if (String(address.source_status || "") !== "connected") {
      return { available: false, reason: "原源头邮箱未连接" };
    }
    try {
      this.passwordSetupProxy(job);
    } catch {
      return { available: false, reason: "原代理无法唯一恢复" };
    }
    return { available: true, reason: "" };
  }

  async startPasswordSetup(id, input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw Object.assign(new Error("设置密码参数无效"), { status: 400 });
    }
    const accountId = positiveAccountId(id);
    if (this.activePasswordSetupTask(accountId)) {
      throw Object.assign(new Error("这个账号已有设置密码任务正在进行"), { status: 409 });
    }
    const target = await this.passwordSetupTarget(accountId);
    const password = normalizeOptionalPassword(input.password);
    const proxy = this.passwordSetupProxy(target.job);
    const params = {};
    if (password) params.password = password;
    if (proxy) params.proxy = proxy;

    try {
      await this.client.upsertOutlookEmailProviderSetting({
        apiUrl: this.mailboxBaseUrl,
        apiKey: this.connectorKey,
      });
    } catch {
      throw Object.assign(new Error("邮箱连接配置同步失败"), { status: 502 });
    }

    let task;
    try {
      task = await this.client.createAccountAction(target.accountId, "set_password", params);
    } catch {
      throw Object.assign(new Error("设置密码任务创建失败"), { status: 502 });
    }
    const taskId = assertPasswordSetupTask(task);
    const publicTask = publicPasswordSetupTask(task);
    const createdAt = nowIso();
    try {
      this.db.prepare(`
        INSERT INTO registration_password_setup_tasks (
          task_id, external_account_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(taskId, target.accountId, publicTask.status, createdAt, createdAt);
    } catch {
      throw Object.assign(new Error("设置密码任务映射保存失败"), { status: 502 });
    }
    const result = { account_id: target.accountId, ...publicTask };
    if (result.status === "completed") {
      const confirmed = await this.passwordSetupTarget(target.accountId, { allowConfigured: true });
      if (confirmed.password.password_status !== "configured" || !confirmed.password.password_available) {
        throw Object.assign(new Error("设置密码任务伪成功：账号密码状态未确认"), { status: 502 });
      }
      result.password_status = "configured";
      result.password_available = true;
    }
    return result;
  }

  async passwordSetupStatus(id, taskId) {
    const mapping = this.passwordSetupTaskMapping(id, taskId);
    await this.passwordSetupTarget(mapping.accountId, { allowConfigured: true });
    let task;
    let eventResponse;
    try {
      task = await this.client.getActionTask(mapping.taskId);
      eventResponse = await this.client.getActionTaskEvents(mapping.taskId);
    } catch {
      throw Object.assign(new Error("设置密码任务状态读取失败"), { status: 502 });
    }
    assertPasswordSetupTask(task, mapping.taskId);
    const result = {
      account_id: mapping.accountId,
      ...publicPasswordSetupTask(task),
      events: publicPasswordSetupEvents(eventResponse),
    };
    this.updatePasswordSetupTaskStatus(mapping.taskId, result.status);

    if (result.status === "completed") {
      const confirmed = await this.passwordSetupTarget(mapping.accountId, { allowConfigured: true });
      if (confirmed.password.password_status !== "configured" || !confirmed.password.password_available) {
        throw Object.assign(new Error("设置密码任务伪成功：账号密码状态未确认"), { status: 502 });
      }
      result.password_status = "configured";
      result.password_available = true;
    }
    return result;
  }

  async cancelPasswordSetup(id, taskId) {
    const mapping = this.passwordSetupTaskMapping(id, taskId);
    await this.passwordSetupTarget(mapping.accountId, { allowConfigured: true });
    let task;
    try {
      task = await this.client.cancelActionTask(mapping.taskId);
    } catch {
      throw Object.assign(new Error("设置密码任务取消失败"), { status: 502 });
    }
    assertPasswordSetupTask(task, mapping.taskId);
    const result = { account_id: mapping.accountId, ...publicPasswordSetupTask(task) };
    this.updatePasswordSetupTaskStatus(mapping.taskId, result.status);
    return result;
  }

  async refreshUncheckedAccountSignals(matched = []) {
    if (typeof this.client.refreshAccountPlans !== "function") return false;
    const now = Date.now();
    const proxyPool = this.getProxyPool();
    const usedProxySessions = new Set();
    for (const [key, attemptedAt] of this.accountStatusRefreshAttempts) {
      if (now - attemptedAt >= ACCOUNT_STATUS_REFRESH_COOLDOWN_MS) {
        this.accountStatusRefreshAttempts.delete(key);
      }
    }
    const candidates = [];
    for (const { item, job } of matched) {
      const id = Number(item?.id);
      const email = safeRemoteText(item?.email, 320).toLowerCase();
      const persisted = this.accountStatusCheckOutcomes.get(String(id));
      const persistedMatches = persisted
        && String(persisted.email || "").toLowerCase() === email;
      const signals = accountStatusSignals(item, persistedMatches ? persisted : null);
      const key = Number.isSafeInteger(id) && id > 0 && email ? `${id}\n${email}` : "";
      if (!key || !signals.status_check_required || !signals.access_token_available
        || this.accountStatusRefreshAttempts.has(key)) {
        continue;
      }
      const proxyRoute = statusCheckProxyRoute(job?.proxy_label, proxyPool, usedProxySessions);
      candidates.push({ id, email, key, proxyRoute, signals });
      if (candidates.length >= ACCOUNT_STATUS_REFRESH_BATCH_SIZE) break;
    }
    if (!candidates.length) return false;
    candidates.forEach(({ key }) => this.accountStatusRefreshAttempts.set(key, now));
    const proxyRoutesById = new Map(candidates.map(({ id, proxyRoute }) => [id, proxyRoute]));
    const attemptedAt = nowIso();
    try {
      const refresh = await refreshPlansWithProxyReview(
        this.client,
        candidates.map(({ id }) => id),
        proxyRoutesById,
      );
      for (const candidate of candidates) {
        const outcome = refreshOutcomeFromResult(refresh.resultById.get(candidate.id), {
          id: candidate.id,
          email: candidate.email,
          attemptedAt,
          fallbackSignals: candidate.signals,
          requestFailure: refresh.failureById.get(candidate.id) || null,
        });
        this.persistAccountStatusOutcome(outcome);
      }
      return refresh.received_results;
    } catch (error) {
      const requestFailure = classifyAccountCheckError(error);
      for (const candidate of candidates) {
        const outcome = refreshOutcomeFromResult(null, {
          id: candidate.id,
          email: candidate.email,
          attemptedAt,
          fallbackSignals: candidate.signals,
          requestFailure,
        });
        this.persistAccountStatusOutcome(outcome);
      }
      return false;
    }
  }

  async listRegisteredAccounts({ refreshUnchecked = true } = {}) {
    let response = await this.client.listAccounts({ pageSize: 500 });
    const jobs = this.db.prepare(`
      SELECT * FROM registration_jobs
      WHERE external_account_id <> '' AND status = 'completed'
      ORDER BY created_at DESC
    `).all();
    const metadataByAccountId = new Map(this.db.prepare("SELECT * FROM registered_account_metadata").all()
      .map((item) => [String(item.external_account_id), item]));
    const nfapiByAccountId = new Map();
    const nfapiBaseUrl = String(getSetting(this.db, "nfapi_base_url", "")).replace(/\/+$/, "");
    this.db.prepare(`
      SELECT * FROM registered_account_nfapi_links
      WHERE nfapi_base_url = ?
      ORDER BY updated_at DESC
    `).all(nfapiBaseUrl).forEach((item) => {
      const id = String(item.external_account_id);
      if (!nfapiByAccountId.has(id)) nfapiByAccountId.set(id, item);
    });
    const identityKey = (accountId, email) => {
      const id = safeRemoteText(accountId, 80);
      const normalizedEmail = safeRemoteText(email, 320).toLowerCase();
      return id && normalizedEmail ? `${id}\n${normalizedEmail}` : "";
    };
    const byIdentity = new Map();
    jobs.forEach((job) => {
      const key = identityKey(job.external_account_id, job.email);
      if (key && !byIdentity.has(key)) byIdentity.set(key, job);
    });
    const matchRemoteItems = (items) => (items || []).map((item) => {
      const platform = normalizeRemoteSignal(item?.platform, "chatgpt");
      const job = platform === "chatgpt"
        ? byIdentity.get(identityKey(item?.id, item?.email))
        : null;
      return { item, job };
    }).filter(({ job }) => Boolean(job));
    let matched = matchRemoteItems(response.items);
    if (refreshUnchecked && await this.refreshUncheckedAccountSignals(matched)) {
      try {
        response = await this.client.listAccounts({ pageSize: 500 });
        matched = matchRemoteItems(response.items);
      } catch {
        // The first list is still authoritative enough to render unchecked state.
      }
    }
    return {
      total: matched.length,
      items: matched.map(({ item, job }) => {
        const passwordMetadata = passwordMetadataFromAccount(item);
        const passwordSetup = this.passwordSetupAvailability(job, item, passwordMetadata);
        const metadata = metadataByAccountId.get(String(item.id || ""));
        const nfapiLink = nfapiByAccountId.get(String(item.id || ""));
        const checkOutcome = this.accountStatusCheckOutcomes.get(String(item.id || ""));
        const checkOutcomeMatches = checkOutcome
          && String(checkOutcome.email || "").toLowerCase() === String(item.email || "").toLowerCase();
        const accountSignals = accountStatusSignals(item, checkOutcomeMatches ? checkOutcome : null);
        const checkState = checkOutcomeMatches
          ? (checkOutcome.detection_status === "confirmed" ? "checked" : "failed")
          : "";
        const checkError = checkOutcomeMatches && checkOutcome.detection_status !== "confirmed"
          ? checkOutcome.reason : "";
        const metadataMatches = metadata
          && String(metadata.email || "").toLowerCase() === String(item.email || "").toLowerCase();
        const nfapiMatches = nfapiLink
          && String(nfapiLink.email || "").toLowerCase() === String(item.email || "").toLowerCase();
        const storedGroupName = metadataMatches ? String(metadata.group_name || "") : "";
        const customGroupName = isPlanManagedGroupName(storedGroupName) ? "" : storedGroupName;
        const defaultGroupName = defaultPlanGroupName(accountSignals);
        return {
          id: item.id,
          email: item.email,
          ...passwordMetadata,
          password_setup_available: passwordSetup.available,
          password_setup_reason: passwordSetup.reason,
          user_id: item.user_id,
          ...accountSignals,
          status_check_state: checkState,
          status_check_error: checkError,
          status_check_attempted_at: checkOutcomeMatches ? checkOutcome.attempted_at : "",
          status: accountSignals.display_status !== "unknown"
            ? accountSignals.display_status : accountSignals.lifecycle_status,
          plan: accountSignals.account_type !== "unknown"
            ? accountSignals.account_type : accountSignals.plan_state,
          display_name: job?.display_name || "",
          birth_date: job?.birth_date || "",
          exit_ip: job?.exit_ip || "",
          custom_name: metadataMatches ? metadata.custom_name : "",
          group_name: customGroupName || defaultGroupName,
          custom_group_name: customGroupName,
          default_group_name: defaultGroupName,
          group_source: customGroupName ? "custom" : "plan",
          nfapi: nfapiMatches ? {
            linked: nfapiLink.status === "imported",
            base_url: nfapiLink.nfapi_base_url,
            account_id: Number(nfapiLink.nfapi_account_id) || 0,
            status: nfapiLink.status,
            short_lived: Boolean(nfapiLink.short_lived),
            last_action: nfapiLink.last_action,
            last_error: nfapiLink.last_error,
            updated_at: nfapiLink.updated_at,
          } : { linked: false, status: "not_imported" },
          created_at: item.created_at,
        };
      }),
    };
  }

  async refreshRegisteredAccountSignals(input = {}) {
    const ids = normalizeAccountCheckIds(input);
    if (typeof this.client.refreshAccountPlans !== "function") {
      throw Object.assign(new Error("注册账号状态检测服务尚未配置"), { status: 503 });
    }

    const before = await this.listRegisteredAccounts({ refreshUnchecked: false });
    const selected = before.items.filter((item) => ids.includes(Number(item.id)));
    if (selected.length !== ids.length) {
      throw Object.assign(new Error("选择中包含不属于本注册页面的账号"), { status: 409 });
    }
    const emailById = new Map(selected.map((item) => [Number(item.id), String(item.email || "")]));
    const placeholders = ids.map(() => "?").join(",");
    const jobs = this.db.prepare(`
      SELECT external_account_id, email, proxy_label
      FROM registration_jobs
      WHERE external_account_id IN (${placeholders}) AND status = 'completed'
      ORDER BY created_at DESC, id DESC
    `).all(...ids.map(String));
    const jobById = new Map();
    for (const job of jobs) {
      const id = Number(job.external_account_id);
      if (!jobById.has(id)
        && String(job.email || "").toLowerCase() === String(emailById.get(id) || "").toLowerCase()) {
        jobById.set(id, job);
      }
    }
    const proxyPool = this.getProxyPool();
    const usedProxySessions = new Set();
    const proxyRoutesById = new Map();
    for (const id of ids) {
      proxyRoutesById.set(id, statusCheckProxyRoute(
        jobById.get(id)?.proxy_label,
        proxyPool,
        usedProxySessions,
      ));
    }
    const refresh = await refreshPlansWithProxyReview(this.client, ids, proxyRoutesById);
    const attemptedAt = nowIso();
    const preliminaryResults = ids.map((id) => {
      const result = refresh.resultById.get(id);
      const fallbackSignals = selected.find((item) => Number(item.id) === id) || {};
      const outcome = refreshOutcomeFromResult(result, {
        id,
        email: emailById.get(id),
        attemptedAt,
        fallbackSignals,
        requestFailure: refresh.failureById.get(id) || null,
      });
      this.persistAccountStatusOutcome(outcome);
      const email = emailById.get(id).toLowerCase();
      this.accountStatusRefreshAttempts.delete(`${id}\n${email}`);
      return outcome;
    });

    const accounts = await this.listRegisteredAccounts({ refreshUnchecked: false });
    const selectedAfter = accounts.items.filter((item) => ids.includes(Number(item.id)));
    const accountById = new Map(selectedAfter.map((item) => [Number(item.id), item]));
    const publicResults = preliminaryResults.map((outcome) => {
      const account = accountById.get(Number(outcome.id)) || {};
      const credentialTerminal = CREDENTIAL_EXPIRED_CODES.has(outcome.code)
        || CREDENTIAL_REVOKED_CODES.has(outcome.code);
      const merged = {
        ...outcome,
        account_status: outcome.account_status !== "unknown" || credentialTerminal
          ? outcome.account_status : String(account.account_status || "unknown"),
        credential_status: outcome.credential_status !== "unknown"
          ? outcome.credential_status : String(account.credential_status || "unknown"),
        subscription_status: outcome.subscription_status !== "unknown"
          ? outcome.subscription_status : String(account.subscription_status || "unknown"),
        account_type: outcome.type_observed
          ? outcome.account_type : String(account.account_type || "unknown"),
        account_type_raw: outcome.type_observed
          ? outcome.account_type_raw : String(account.account_type_raw || outcome.account_type_raw || ""),
        availability: String(account.availability || "unchecked"),
        available: typeof account.available === "boolean" ? account.available : null,
      };
      merged.type = merged.account_type;
      merged.type_raw = merged.account_type_raw;
      merged.status = merged.account_status;
      this.persistAccountStatusOutcome(merged);
      if (account && account.id) {
        account.detection_status = merged.detection_status;
        account.status_code = merged.code;
        account.status_reason = merged.reason;
        account.status_retryable = merged.retryable;
        account.status_source = merged.source;
        account.status_check_state = merged.checked ? "checked" : "failed";
        account.status_check_error = merged.error;
        account.status_check_attempted_at = merged.attempted_at;
      }
      return merged;
    });
    const typeCounts = {};
    for (const item of selectedAfter) {
      const type = String(item.account_type || "unknown");
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    }
    const checked = publicResults.filter((item) => item.checked).length;
    return {
      requested: ids.length,
      checked,
      failed: ids.length - checked,
      inconclusive: publicResults.filter((item) => item.detection_status === "inconclusive").length,
      timed_out: publicResults.filter((item) => item.code === "check_timeout").length,
      available: selectedAfter.filter((item) => item.availability === "available").length,
      unavailable: selectedAfter.filter((item) => item.availability === "unavailable").length,
      unchecked: selectedAfter.filter((item) => item.availability === "unchecked").length,
      types: typeCounts,
      items: publicResults,
      accounts,
    };
  }

  async updateRegisteredAccountMetadata(id, input = {}) {
    const accountId = Number(id);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      throw Object.assign(new Error("注册账号 ID 无效"), { status: 400 });
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw Object.assign(new Error("账号资料格式无效"), { status: 400 });
    }
    const customName = accountMetadataValue(input, "custom_name", "账号名称", 60);
    const groupName = accountMetadataValue(input, "group_name", "分组名称", 40);
    if (customName === undefined && groupName === undefined) {
      throw Object.assign(new Error("请填写要修改的账号名称或分组"), { status: 400 });
    }

    const job = this.db.prepare(`
      SELECT * FROM registration_jobs
      WHERE external_account_id = ? AND status = 'completed'
      ORDER BY created_at DESC LIMIT 1
    `).get(String(accountId));
    if (!job) throw Object.assign(new Error("注册账号不存在"), { status: 404 });
    const account = await this.client.getAccount(accountId);
    if (!account) throw Object.assign(new Error("账号已从本地账号池删除"), { status: 404 });
    if (String(account.platform || "chatgpt").toLowerCase() !== "chatgpt"
      || String(account.email || "").toLowerCase() !== String(job.email || "").toLowerCase()) {
      throw Object.assign(new Error("注册账号与任务记录不匹配"), { status: 409 });
    }

    const existing = this.db.prepare(`
      SELECT * FROM registered_account_metadata
      WHERE external_account_id = ? AND email = ? COLLATE NOCASE
    `).get(String(accountId), account.email);
    const nextCustomName = customName === undefined ? String(existing?.custom_name || "") : customName;
    const nextGroupName = groupName === undefined ? String(existing?.group_name || "") : groupName;
    if (!nextCustomName && !nextGroupName) {
      this.db.prepare("DELETE FROM registered_account_metadata WHERE external_account_id = ?")
        .run(String(accountId));
    } else {
      const now = nowIso();
      this.db.prepare(`
        INSERT INTO registered_account_metadata
          (external_account_id, email, custom_name, group_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(external_account_id) DO UPDATE SET
          email = excluded.email,
          custom_name = excluded.custom_name,
          group_name = excluded.group_name,
          updated_at = excluded.updated_at
      `).run(String(accountId), account.email, nextCustomName, nextGroupName, now, now);
    }
    return {
      item: {
        id: accountId,
        email: account.email,
        custom_name: nextCustomName,
        group_name: nextGroupName,
      },
    };
  }

  async registeredAccountAccessToken(id) {
    const accountId = Number(id);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      throw Object.assign(new Error("注册账号 ID 无效"), { status: 400 });
    }
    const job = this.db.prepare(`
      SELECT * FROM registration_jobs
      WHERE external_account_id = ? AND status = 'completed'
      ORDER BY created_at DESC LIMIT 1
    `).get(String(accountId));
    if (!job) throw Object.assign(new Error("注册账号不存在"), { status: 404 });
    const account = await this.client.getAccount(accountId);
    if (!account) throw Object.assign(new Error("账号已从本地账号池删除"), { status: 404 });
    if (String(account.email || "").toLowerCase() !== String(job.email || "").toLowerCase()) {
      throw Object.assign(new Error("注册账号与任务记录不匹配"), { status: 409 });
    }
    const accessToken = accessTokenFromAccount(account);
    if (!accessToken) throw Object.assign(new Error("这个账号尚未获取到 AT"), { status: 404 });
    return { id: accountId, email: account.email, access_token: accessToken };
  }

  async deleteRegisteredAccounts(input = {}) {
    const ids = normalizeSelectedIds(input, "注册账号");
    const placeholders = ids.map(() => "?").join(",");
    const jobs = this.db.prepare(`
      SELECT * FROM registration_jobs
      WHERE external_account_id IN (${placeholders}) AND status = 'completed'
      ORDER BY created_at DESC
    `).all(...ids.map(String));
    const jobByAccountId = new Map();
    jobs.forEach((job) => {
      if (!jobByAccountId.has(String(job.external_account_id))) jobByAccountId.set(String(job.external_account_id), job);
    });
    if (ids.some((id) => !jobByAccountId.has(String(id)))) {
      throw Object.assign(new Error("选择中包含不属于本注册页面的账号"), { status: 409 });
    }

    const accounts = await Promise.all(ids.map(async (id) => {
      const account = await this.client.getAccount(id);
      if (!account) throw Object.assign(new Error(`账号 #${id} 已不存在`), { status: 404 });
      const job = jobByAccountId.get(String(id));
      if (String(account.platform || "chatgpt").toLowerCase() !== "chatgpt"
        || String(account.email || "").toLowerCase() !== String(job.email || "").toLowerCase()) {
        throw Object.assign(new Error(`账号 #${id} 与注册记录不匹配`), { status: 409 });
      }
      return { id, email: account.email };
    }));

    const settled = await Promise.allSettled(accounts.map((account) => this.client.deleteAccount(account.id)));
    const failed = [];
    const deletedIds = [];
    let deleted = 0;
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        deleted += 1;
        deletedIds.push(String(accounts[index].id));
      }
      else failed.push({ id: accounts[index].id, error: result.reason?.message || String(result.reason || "删除失败") });
    });
    if (deletedIds.length) {
      const placeholders = deletedIds.map(() => "?").join(",");
      this.db.transaction(() => {
        this.db.prepare(`DELETE FROM registered_account_metadata WHERE external_account_id IN (${placeholders})`).run(...deletedIds);
        this.db.prepare(`DELETE FROM registered_account_nfapi_links WHERE external_account_id IN (${placeholders})`).run(...deletedIds);
      })();
    }
    return { requested: ids.length, deleted, failed };
  }

  externalAccounts({ limit = 100, offset = 0 } = {}) {
    const boundedLimit = Math.max(1, Math.min(10_000, Number(limit) || 100));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const accounts = this.db.prepare(`
      SELECT addresses.id, addresses.address AS email, addresses.kind AS account_type,
        addresses.status, source_accounts.email AS source_email
      FROM addresses JOIN source_accounts ON source_accounts.id = addresses.account_id
      WHERE addresses.status = 'active' AND source_accounts.status = 'connected'
      ORDER BY addresses.created_at DESC LIMIT ? OFFSET ?
    `).all(boundedLimit, boundedOffset);
    return { success: true, accounts };
  }

  async scanAccount(account) {
    const existing = this.scanPromises.get(account.id);
    if (existing) return existing;
    const lastScan = account.last_inbox_scan_at ? new Date(account.last_inbox_scan_at).getTime() : 0;
    if (Date.now() - lastScan < 2_500) return null;
    const promise = this.graph.scanInbox(account).then((result) => {
      if (result?.stage !== "completed") {
        throw Object.assign(new Error(result?.message || "邮箱扫描尚未完成"), { status: 409 });
      }
      return persistInboxScanResult(this.db, account, result);
    }).finally(() => this.scanPromises.delete(account.id));
    this.scanPromises.set(account.id, promise);
    return promise;
  }

  async registeredAccountEmails(id, query = {}) {
    const accountId = positiveAccountId(id);
    const account = await this.client.getAccount(accountId);
    if (!account) throw Object.assign(new Error("注册账号不存在"), { status: 404 });
    if (String(account.platform || "chatgpt").toLowerCase() !== "chatgpt") {
      throw Object.assign(new Error("账号类型不是 ChatGPT"), { status: 409 });
    }
    const email = String(account.email || "").trim().toLowerCase();
    const job = this.db.prepare(`
      SELECT * FROM registration_jobs
      WHERE external_account_id = ? AND status = 'completed' AND email = ? COLLATE NOCASE
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(String(accountId), email);
    if (!email || !job) {
      throw Object.assign(new Error("注册账号与原邮箱记录不匹配"), { status: 409 });
    }
    const result = await this.externalEmails({ email, top: query.top });
    return { ...result, account_id: accountId, email };
  }

  async externalEmails(query = {}) {
    const email = String(query.email || "").trim().toLowerCase();
    if (!email) throw Object.assign(new Error("缺少 email"), { status: 400 });
    const top = query.top === undefined || query.top === "" ? 20 : Number(query.top);
    if (!Number.isSafeInteger(top) || top < 1 || top > 50) {
      throw Object.assign(new Error("top 必须是 1 到 50 的整数"), { status: 400 });
    }
    const address = this.db.prepare(`
      SELECT addresses.*, source_accounts.status AS account_status, source_accounts.email AS source_email,
        source_accounts.last_inbox_scan_at
      FROM addresses JOIN source_accounts ON source_accounts.id = addresses.account_id
      WHERE addresses.address = ? COLLATE NOCASE
    `).get(email);
    if (!address) throw Object.assign(new Error("邮箱地址不存在"), { status: 404 });
    if (address.account_status === "connected") {
      const account = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(address.account_id);
      await this.scanAccount(account);
    }
    const conditions = ["(mail_messages.address_id = ? OR mail_messages.recipient_address = ? COLLATE NOCASE)"];
    const params = [address.id, email];
    if (query.subject_contains) { conditions.push("mail_messages.subject LIKE ?"); params.push(`%${query.subject_contains}%`); }
    if (query.from_contains) { conditions.push("mail_messages.sender_address LIKE ?"); params.push(`%${query.from_contains}%`); }
    if (query.keyword) {
      conditions.push("(mail_messages.subject LIKE ? OR mail_messages.preview LIKE ? OR mail_messages.body LIKE ?)");
      params.push(`%${query.keyword}%`, `%${query.keyword}%`, `%${query.keyword}%`);
    }
    const emails = this.db.prepare(`
      SELECT id, graph_message_id AS message_id, internet_message_id, received_at AS date,
        sender_address AS "from", subject, preview AS body_preview, preview, body,
        verification_code
      FROM mail_messages WHERE ${conditions.join(" AND ")}
      ORDER BY received_at DESC LIMIT ?
    `).all(...params, top).map((item) => ({ ...item, folder: "inbox", text: item.body || item.preview }));
    return { success: true, emails };
  }
}
