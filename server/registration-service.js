import crypto from "node:crypto";
import { generateSplits, parseJson, persistInboxScanResult } from "./account-service.js";
import { isIcloudImportedStrategy, isMailcomAliasStrategy, isNeteaseAliasStrategy } from "./address-generator.js";
import {
  getSetting,
  listRegisteredAccountStatusChecks,
  nowIso,
  setSetting,
  upsertRegisteredAccountStatusCheck,
} from "./db.js";
import {
  knownRegistrationFailureReason,
  OCCUPIED_ALIAS_FAILURE_REASON,
  occupiedAliasHistory,
  publicRegistrationJob,
  registrationFailureReason,
  remoteRegistrationFailureReason,
} from "./registration-failure.js";
import {
  kookeeyStickyTemplate,
  maskProxy,
  materializeProxySession,
  parseProxyPool,
  proxyMetadata,
  redactProxySecrets,
  resolveJobProxyPlan,
  resolveJobProxies,
  safeProxySamples,
  sanitizeRegistrationRemoteValue,
  statusCheckProxyRoute,
} from "./registration-proxy.js";
import { parseLocalAccountImport } from "./registration-import.js";
import { serializeInboxLinkEntry } from "./inbox-link-pool.js";
import { checkoutTypeFromAccount, probeCheckoutType } from "./checkout-type-probe.js";
import {
  DIRECT_TRIAL_ROUTE,
  GB_FAST_INELIGIBLE_EVIDENCE,
  GB_ZERO_TRIAL_EVIDENCE,
  JP_FAST_INELIGIBLE_EVIDENCE,
  JP_ZERO_TRIAL_EVIDENCE,
  US_FAST_INELIGIBLE_EVIDENCE,
  US_ZERO_TRIAL_EVIDENCE,
  probeDirectTrialCountry,
  probeGbTrialEligibility,
  probeJpTrialEligibility,
  probeUsTrialEligibility,
} from "./jp-trial-eligibility-probe.js";
import { MOMO_CHECK_EVIDENCES, probeMomoEligibility } from "./momo-eligibility-probe.js";
import {
  mailcomRecyclingReservation,
  mailcomRecyclingReservations,
} from "./mailcom-recycle-reservation.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const ACTIVE_STATUSES = new Set(["pending", "claimed", "running", "paused", "cancel_requested"]);
const RELEASABLE_JOB_STATUSES = new Set(["queued", "pending", "claimed", "running", "paused", "cancel_requested"]);
const ACCOUNT_STATUS_REFRESH_COOLDOWN_MS = 15 * 60 * 1000;
const ACCOUNT_STATUS_REFRESH_BATCH_SIZE = 20;
const REGISTERED_ACCOUNT_PAGE_SIZE = 500;
const MAX_REGISTERED_ACCOUNT_PAGES = 100;
const CHECKOUT_CHECK_CONCURRENCY = 2;
const CHECKOUT_ACCOUNT_COOLDOWN_MS = 30 * 60 * 1000;
const TRIAL_CHECK_CONCURRENCY = 5;
const MOMO_CHECK_CONCURRENCY = 2;
const MAX_REGISTRATION_CONCURRENCY = 20;
const ACCOUNT_DELETE_SQL_BATCH_SIZE = 500;
const ACCOUNT_DELETE_LOOKUP_CONCURRENCY = 20;
const ACCOUNT_DELETE_REQUEST_CONCURRENCY = 4;
const PICKUP_REGISTRATION_BLOCKED_STATUSES = new Set(["ready", "sold", "disabled"]);
const DIRECT_MAILBOX_PROVIDERS = new Set(["icloud", "mailcom", "netease"]);

function pickupInventoryByEmail(items = []) {
  const inventory = new Map();
  for (const item of items) {
    const email = String(item?.email || "").trim().toLowerCase();
    const status = String(item?.status || "").trim().toLowerCase();
    if (email && PICKUP_REGISTRATION_BLOCKED_STATUSES.has(status)) inventory.set(email, status);
  }
  return inventory;
}

function directMailboxRegistrationState(jobs = []) {
  const occupied = occupiedAliasHistory(jobs);
  const active = jobs.some((job) => RELEASABLE_JOB_STATUSES.has(String(job.status || "")));
  const completed = jobs.some((job) => job.status === "completed");
  const disabled = active || completed || occupied.count > 0;
  return {
    active,
    completed,
    disabled,
    occupied,
    state: active ? "in_progress"
      : occupied.count > 0 ? "occupied"
        : completed ? "used" : "available",
  };
}

function isDirectMailboxAddress(account, address) {
  if (address?.kind === "primary") return true;
  if (address?.kind !== "official") return false;
  if (account?.provider === "icloud") return isIcloudImportedStrategy(address.strategy);
  if (account?.provider === "mailcom") return isMailcomAliasStrategy(address.strategy);
  if (account?.provider === "netease") return isNeteaseAliasStrategy(address.strategy);
  return false;
}

function directMailboxLabel(account) {
  if (account?.provider === "mailcom") return "Mail.com 地址";
  if (account?.provider === "netease") return "网易邮箱地址";
  return "iCloud 地址";
}

function normalizeSelectedIds(input, label, maximum = Number.POSITIVE_INFINITY) {
  if (!Array.isArray(input?.ids)) {
    throw Object.assign(new Error(`请选择要删除的${label}`), { status: 400 });
  }
  const ids = [...new Set(input.ids.map((value) => Number(value)))];
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw Object.assign(new Error(`请选择有效的${label}`), { status: 400 });
  }
  if (Number.isFinite(maximum) && ids.length > maximum) {
    throw Object.assign(new Error(`单次最多删除 ${maximum} 个${label}`), { status: 400 });
  }
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

function normalizeAccountGroupIds(input, maximum = 500) {
  if (!Array.isArray(input?.ids)) {
    throw Object.assign(new Error("请选择要编辑分组的注册账号"), { status: 400 });
  }
  const ids = [...new Set(input.ids.map((value) => Number(value)))];
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw Object.assign(new Error("请选择有效的注册账号"), { status: 400 });
  }
  if (ids.length > maximum) throw Object.assign(new Error(`单次最多编辑 ${maximum} 个注册账号`), { status: 400 });
  return ids;
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function registrationMailboxBindings(email, apiUrl) {
  const normalizedEmail = safeRemoteText(email, 320).toLowerCase();
  const normalizedApiUrl = String(apiUrl || "").trim().replace(/\/+$/, "");
  return {
    providerAccounts: [
      {
        provider_type: "mailbox",
        provider_name: "outlook_email",
        login_identifier: normalizedEmail,
        display_name: normalizedEmail,
        credentials: {},
        metadata: { email: normalizedEmail, api_url: normalizedApiUrl, source: "fixed" },
      },
      {
        provider_type: "mailbox",
        provider_name: "outlook_email_api",
        login_identifier: normalizedEmail,
        display_name: normalizedEmail,
        credentials: {},
        metadata: { account_id: normalizedEmail },
      },
    ],
    providerResources: [
      {
        provider_type: "mailbox",
        provider_name: "outlook_email",
        resource_type: "mailbox",
        resource_identifier: normalizedEmail,
        handle: normalizedEmail,
        display_name: normalizedEmail,
        metadata: { email: normalizedEmail, api_url: normalizedApiUrl, source: "fixed" },
      },
      {
        provider_type: "mailbox",
        provider_name: "outlook_email_api",
        resource_type: "mailbox",
        resource_identifier: normalizedEmail,
        handle: normalizedEmail,
        display_name: normalizedEmail,
        metadata: { account_id: normalizedEmail, email: normalizedEmail },
      },
    ],
  };
}

function accessTokenFromAccount(item = {}) {
  return accountCredential(item, ["access_token", "accessToken"])
    || String(item.primary_token || "");
}

function refreshTokenFromAccount(item = {}) {
  return accountCredential(item, ["refresh_token", "refreshToken"]);
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

function plusDateFromAccount(item = {}, plusMail = null) {
  const overview = item.overview && typeof item.overview === "object" && !Array.isArray(item.overview)
    ? item.overview : {};
  const candidates = [
    item.plus_at,
    item.plusAt,
    item.plus_started_at,
    item.plusStartedAt,
    item.subscription_started_at,
    item.subscriptionStartedAt,
    item.subscription_start_at,
    item.subscriptionStartAt,
    item.plan_started_at,
    item.planStartedAt,
    overview.plus_at,
    overview.plus_started_at,
    overview.subscription_started_at,
    overview.subscription_start_at,
    overview.plan_started_at,
    plusMail?.received_at,
  ];
  return candidates
    .map((value) => safeRemoteText(value, 80))
    .find((value) => Number.isFinite(Date.parse(value))) || "";
}

const PLUS_MAIL_CONFIRMATION_MAX_AGE_MS = 35 * 24 * 60 * 60 * 1_000;

function plusConfirmationAccountId(message = {}) {
  const text = [message.subject, message.preview, message.body].map((value) => String(value || "")).join(" ");
  const match = text.match(/chatgpt\.com\/account\/manage\?[^\s<>"']*\baccount_id=([a-z0-9-]{8,})/i);
  return match?.[1] || "";
}

function plusMailEvidenceByEmail(db) {
  const rows = db.prepare(`
    SELECT lower(recipient_address) AS email, subject, preview, body, received_at
    FROM mail_messages
    WHERE recipient_address <> ''
      AND lower(subject || ' ' || preview || ' ' || body) LIKE '%chatgpt plus%'
      AND (
        lower(subject || ' ' || preview || ' ' || body) LIKE '%successfully subscribed%'
        OR lower(subject || ' ' || preview || ' ' || body) LIKE '%successfully registered%'
        OR subject || ' ' || preview || ' ' || body LIKE '%正常に登録%'
        OR subject || ' ' || preview || ' ' || body LIKE '%구독했습니다%'
        OR subject || ' ' || preview || ' ' || body LIKE '%成功订阅%'
        OR subject || ' ' || preview || ' ' || body LIKE '%订阅成功%'
      )
    ORDER BY received_at DESC
  `).all();
  const evidence = new Map();
  for (const row of rows) {
    if (row.email && !evidence.has(row.email)) {
      evidence.set(row.email, {
        email: row.email,
        subject: row.subject,
        received_at: row.received_at,
        account_id: plusConfirmationAccountId(row),
      });
    }
  }
  return evidence;
}

function plusMailMatchesAccount(mail, account = {}) {
  const mailAccountId = safeRemoteText(mail?.account_id, 100);
  if (!mailAccountId) return false;
  const accountIds = new Set([
    account?.user_id,
    accountCredential(account, ["account_id", "accountId", "chatgpt_account_id", "chatgptAccountId"]),
  ].map((value) => safeRemoteText(value, 100)).filter(Boolean));
  return accountIds.has(mailAccountId);
}

function isAccountDeletionMail(message = {}) {
  const subject = String(message.subject || "");
  const preview = String(message.preview || "");
  const body = String(message.body || "");
  const text = `${subject} ${preview} ${body}`.replace(/\s+/g, " ").trim();
  if (!text) return false;
  const sender = String(message.sender_address || "").trim().toLowerCase();
  const trustedSender = /(?:^|@)(?:[a-z0-9-]+\.)*(?:openai|chatgpt)\.(?:com|net)(?:$|>)/i.test(sender);
  if (!trustedSender) return false;
  const accountWord = "(?:account|user|账号|账户|用户)";
  const deletionWord = "(?:deleted|deactivated|disabled|suspended|banned|terminated|removed|删除|停用|禁用|暂停|封禁)";
  return new RegExp(`${accountWord}.{0,120}${deletionWord}|${deletionWord}.{0,120}${accountWord}`, "i").test(text);
}

function accountDeletionMailEvidenceByEmail(db, sourceIds = [], emails = []) {
  if (!sourceIds.length || !emails.length) return new Map();
  const sourcePlaceholders = sourceIds.map(() => "?").join(",");
  const emailPlaceholders = emails.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT mail_messages.recipient_address, mail_messages.sender_address,
      mail_messages.subject, mail_messages.preview, mail_messages.body,
      mail_messages.received_at,
      lower(CASE WHEN trim(mail_messages.recipient_address) <> ''
        THEN mail_messages.recipient_address ELSE COALESCE(addresses.address, '') END) AS matched_email
    FROM mail_messages
    LEFT JOIN addresses ON addresses.id = mail_messages.address_id
    WHERE mail_messages.account_id IN (${sourcePlaceholders})
      AND lower(CASE WHEN trim(mail_messages.recipient_address) <> ''
        THEN mail_messages.recipient_address ELSE COALESCE(addresses.address, '') END) IN (${emailPlaceholders})
    ORDER BY mail_messages.received_at DESC, mail_messages.id DESC
  `).all(...sourceIds, ...emails);
  const evidence = new Map();
  for (const row of rows) {
    const email = String(row.matched_email || "").trim().toLowerCase();
    if (email && !evidence.has(email) && isAccountDeletionMail(row)) evidence.set(email, row);
  }
  return evidence;
}

function recentPlusMailConfirmation(mail, now = Date.now()) {
  const receivedAt = Date.parse(String(mail?.received_at || ""));
  return Number.isFinite(receivedAt)
    && receivedAt <= now + 5 * 60 * 1_000
    && now - receivedAt <= PLUS_MAIL_CONFIRMATION_MAX_AGE_MS;
}

function shouldPromotePlusMail(mail, account, signals) {
  if (!mail || signals.account_type === "plus") return false;
  const code = normalizeCheckCode(signals.status_code);
  if (SUBSCRIPTION_STATUS_CODES.has(code)) return false;
  if (signals.detection_status !== "confirmed") return true;
  return recentPlusMailConfirmation(mail) && plusMailMatchesAccount(mail, account);
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
  if (/cloudflare|challenge|captcha|<!doctype|<html|网页验证|验证页面/.test(lower)) {
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
  if (terminal && normalized === "mail/account-deletion") return true;
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

function terminalAccountRefreshFailure(status, code, { ambiguous = false } = {}) {
  const labels = {
    banned: "封禁",
    disabled: "禁用",
    deactivated: "停用",
    deleted: "删除",
    suspended: "暂停使用",
  };
  const state = normalizeAccountStatus(status);
  if (state === "unknown") return null;
  const normalizedCode = ACCOUNT_UNAVAILABLE_CODES.has(normalizeCheckCode(code))
    ? normalizeCheckCode(code) : `account_${state}`;
  const stateLabel = ambiguous ? "删除或停用" : labels[state];
  return {
    code: normalizedCode,
    accountStatus: state,
    reason: `OpenAI 已确认账号已${stateLabel}，AT 已失效`,
  };
}

function accessTokenRefreshTerminalFailure(value, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined || depth > 7) return null;
  if (typeof value === "string" || typeof value === "number") {
    const text = safeAccountCheckText(value, 1_000);
    const code = normalizeCheckCode(text);
    if (ACCOUNT_UNAVAILABLE_CODES.has(code)) {
      return terminalAccountRefreshFailure(ACCOUNT_UNAVAILABLE_CODES.get(code), code);
    }
    const lower = text.toLowerCase();
    const accountContext = /\b(?:account|user)\b|账号|帐号|账户/.test(lower);
    if (!accountContext) return null;
    const combined = /deleted\s+or\s+deactivated|删除或停用|删除或已停用/.test(lower);
    if (/\bdeleted\b|删除|注销/.test(lower)) {
      return terminalAccountRefreshFailure("deleted", "account_deleted", { ambiguous: combined });
    }
    if (/\bdeactivat(?:ed|ion)\b|停用/.test(lower)) {
      return terminalAccountRefreshFailure("deactivated", "account_deactivated");
    }
    if (/\bdisabled\b|禁用/.test(lower)) {
      return terminalAccountRefreshFailure("disabled", "account_disabled");
    }
    if (/\bbanned\b|封禁/.test(lower)) {
      return terminalAccountRefreshFailure("banned", "account_banned");
    }
    if (/\bsuspended\b|暂停使用/.test(lower)) {
      return terminalAccountRefreshFailure("suspended", "account_suspended");
    }
    return null;
  }
  if (typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const failure = accessTokenRefreshTerminalFailure(item, seen, depth + 1);
      if (failure) return failure;
    }
    return null;
  }
  for (const key of ["account_status", "accountStatus", "account_state", "accountState", "lifecycle_status", "lifecycleStatus"]) {
    const status = normalizeAccountStatus(value[key]);
    if (status !== "unknown") return terminalAccountRefreshFailure(status, `account_${status}`);
  }
  for (const key of ["error_code", "errorCode", "code", "reason_code", "reasonCode", "status_code", "statusCode"]) {
    const code = normalizeCheckCode(value[key]);
    if (ACCOUNT_UNAVAILABLE_CODES.has(code)) {
      return terminalAccountRefreshFailure(ACCOUNT_UNAVAILABLE_CODES.get(code), code);
    }
  }
  for (const key of ["message", "error", "detail", "reason", "description"]) {
    const failure = accessTokenRefreshTerminalFailure(value[key], seen, depth + 1);
    if (failure) return failure;
  }
  for (const item of Object.values(value)) {
    const failure = accessTokenRefreshTerminalFailure(item, seen, depth + 1);
    if (failure) return failure;
  }
  return null;
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
  }

  const directIds = ids.filter((id) => primaryProxies[id]
    && !planRefreshAttemptsResolved(attemptsById.get(id)));
  if (directIds.length) {
    const direct = await requestPlanRefreshChannel(client, directIds, {});
    appendPlanRefreshAttempts(attemptsById, directIds, direct);
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
  const refreshTokenAvailable = Boolean(refreshTokenFromAccount(item));
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
  if (terminalEvidence) credentialStatus = "revoked";
  else if (credentialEvidence && CREDENTIAL_EXPIRED_CODES.has(credentialEvidence.code)) credentialStatus = "expired";
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
      detectionStatus = "inconclusive";
      if (!requestFailure && result?.ok === true && rawCode && rawCode !== "ok") {
        code = rawCode;
        reason = rawReason || "状态检测暂未得出最终结论";
        retryable = typeof result?.status_retryable === "boolean"
          ? result.status_retryable : true;
      } else {
        const failure = requestFailure || classifyAccountCheckError(
          `${rawCode} ${rawReason}`,
          rawCode || (!result ? "missing_result" : "check_failed"),
        );
        code = failure.code;
        reason = failure.reason;
        retryable = failure.retryable;
        accountStatus = "unknown";
        credentialStatus = "unknown";
        subscriptionStatus = "unknown";
      }
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

function assertAccessTokenRefreshTask(task, expectedTaskId = "") {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw Object.assign(new Error("AT 刷新服务返回了无效任务"), { status: 502 });
  }
  const taskId = String(task.task_id || task.id || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskId) || (expectedTaskId && taskId !== expectedTaskId)) {
    throw Object.assign(new Error("AT 刷新任务标识不匹配"), { status: 502 });
  }
  if (String(task.type || "").toLowerCase() !== "platform_action"
    || String(task.platform || "").toLowerCase() !== "chatgpt") {
    throw Object.assign(new Error("AT 刷新任务类型不匹配"), { status: 502 });
  }
  const status = statusFromExternal(task.status);
  if (!new Set([
    "queued", "running", "cancel_requested", "completed", "failed", "cancelled", "interrupted",
  ]).has(status)) {
    throw Object.assign(new Error("AT 刷新任务状态无效"), { status: 502 });
  }
  return { taskId, status };
}

function checkoutCheckError(value) {
  const source = value?.message || value?.error || value || "Checkout 检测失败";
  return safeRemoteText(redactProxySecrets(source)
    .replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\b(?:cs_live|oaics)_[A-Za-z0-9_-]+/gi, "[REDACTED]"), 180)
    || "Checkout 检测失败";
}

function trialCheckError(value) {
  const source = value?.message || value?.error || value || "日本 0 元 Checkout 检测失败";
  return safeRemoteText(redactProxySecrets(source)
    .replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\b(?:cs_(?:live|test)|oaics)_[A-Za-z0-9_-]+/gi, "[REDACTED]"), 180)
    || "日本 0 元 Checkout 检测失败";
}

function gbTrialCheckError(value) {
  const source = value?.message || value?.error || value || "英国 0 元 Checkout 检测失败";
  return safeRemoteText(redactProxySecrets(source)
    .replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\b(?:cs_(?:live|test)|oaics)_[A-Za-z0-9_-]+/gi, "[REDACTED]"), 180)
    || "英国 0 元 Checkout 检测失败";
}

function usTrialCheckError(value) {
  const source = value?.message || value?.error || value || "美国 0 元 Checkout 检测失败";
  return safeRemoteText(redactProxySecrets(source)
    .replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\b(?:cs_(?:live|test)|oaics)_[A-Za-z0-9_-]+/gi, "[REDACTED]"), 180)
    || "美国 0 元 Checkout 检测失败";
}

function trialCheckErrorMetadata(value) {
  const status = Number(
    value?.status
      ?? value?.http_status
      ?? value?.status_http
      ?? value?.statusCode
      ?? 0,
  );
  const code = safeRemoteText(
    value?.code ?? value?.error_code ?? value?.errorCode ?? "",
    120,
  );
  return {
    httpStatus: Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : 0,
    errorCode: code,
  };
}

function momoCheckError(value) {
  const source = value?.message || value?.error || value || "MoMo 资格检测失败";
  return safeRemoteText(redactProxySecrets(source)
    .replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\b(?:cs_(?:live|test)|pk_(?:live|test))_[A-Za-z0-9_-]+/gi, "[REDACTED]"), 180)
    || "MoMo 资格检测失败";
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
  if (status === "failure" || status === "error") return "failed";
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
  constructor({ db, graph, client, publicBaseUrl, mailboxBaseUrl, browserUrl, inboxLinkMailboxes = null, pickup = null, nfapiCredentialSync = null, checkoutProbe = probeCheckoutType, checkoutProxyResolver = null, trialProbe = probeJpTrialEligibility, trialProxyResolver = null, gbTrialProbe = probeGbTrialEligibility, gbTrialProxyResolver = null, usTrialProbe = probeUsTrialEligibility, usTrialProxyResolver = null, usDirectCountryProbe = probeDirectTrialCountry, momoProbe = probeMomoEligibility, momoProxyResolver = null } = {}) {
    this.db = db;
    this.graph = graph;
    this.client = client;
    this.connectorKey = getSetting(db, "registration_connector_key", "");
    this.mailboxBaseUrl = String(mailboxBaseUrl || publicBaseUrl || "").replace(/\/$/, "");
    this.browserUrl = browserUrl || "/alias-hub/browser/vnc.html?autoconnect=true&resize=scale&path=websockify";
    this.inboxLinkMailboxes = inboxLinkMailboxes;
    this.pickup = pickup;
    this.scanPromises = new Map();
    this.accountAccessTokenRefreshes = new Map();
    this.accountCheckoutChecks = new Map();
    this.accountCheckoutCooldowns = new Map();
    this.checkoutProbe = checkoutProbe;
    this.checkoutProxyResolver = checkoutProxyResolver;
    this.checkoutProxyCache = { proxy: "", expiresAt: 0 };
    this.accountTrialChecks = new Map();
    this.trialProbe = trialProbe;
    this.trialProxyResolver = trialProxyResolver;
    this.trialProxyCache = { proxy: "", expiresAt: 0 };
    this.accountGbTrialChecks = new Map();
    this.gbTrialProbe = gbTrialProbe;
    this.gbTrialProxyResolver = gbTrialProxyResolver;
    this.gbTrialProxyCache = { proxy: "", expiresAt: 0 };
    this.accountUsTrialChecks = new Map();
    this.usTrialProbe = usTrialProbe;
    this.usTrialProxyResolver = usTrialProxyResolver;
    this.usDirectCountryProbe = usDirectCountryProbe;
    this.usTrialProxyCache = { proxy: "", expiresAt: 0 };
    this.accountMomoChecks = new Map();
    this.momoProbe = momoProbe;
    this.momoProxyResolver = momoProxyResolver;
    this.momoProxyCache = { proxy: "", expiresAt: 0 };
    this.accountStatusRefreshAttempts = new Map();
    this.accountStatusCheckOutcomes = new Map();
    this.localAccountImportEmails = new Set();
    this.nfapiCredentialSync = nfapiCredentialSync;
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

  pickupRegistrationProtectionEnabled() {
    return Boolean(this.pickup?.registrationProtectionEnabled?.());
  }

  async listAllRemoteAccounts() {
    const items = [];
    const accountIds = new Set();

    for (let page = 1; page <= MAX_REGISTERED_ACCOUNT_PAGES; page += 1) {
      const response = await this.client.listAccounts({ page, pageSize: REGISTERED_ACCOUNT_PAGE_SIZE });
      if (!Array.isArray(response?.items)) {
        throw Object.assign(new Error("注册服务账号列表格式无效"), { status: 502 });
      }

      const pageItems = response.items;
      let newItems = 0;
      for (const item of pageItems) {
        const accountId = String(item?.id ?? "").trim();
        if (accountId && accountIds.has(accountId)) continue;
        if (accountId) accountIds.add(accountId);
        items.push(item);
        newItems += 1;
      }
      if (pageItems.length && newItems === 0) {
        throw Object.assign(new Error("注册服务返回了无进展的账号分页"), { status: 502 });
      }
      if (pageItems.length < REGISTERED_ACCOUNT_PAGE_SIZE) {
        return { total: items.length, items };
      }
    }

    throw Object.assign(new Error("注册服务账号分页数量异常"), { status: 502 });
  }

  async pickupRegistrationInventory({ required = false } = {}) {
    if (!this.pickupRegistrationProtectionEnabled()) return new Map();
    try {
      const result = await this.pickup.listStatuses();
      return pickupInventoryByEmail(result?.items);
    } catch (error) {
      if (!required) return null;
      throw Object.assign(new Error("取件站库存状态读取失败，为避免误用售卖邮箱，已停止创建注册任务"), {
        status: 409,
        code: "PICKUP_REGISTRATION_STATUS_UNAVAILABLE",
        cause: error,
      });
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

  async syncLatestNfapiCredentials(accounts) {
    if (!this.nfapiCredentialSync) return { attempted: 0, synced: 0, failed: 0, items: [] };
    try {
      const result = await this.nfapiCredentialSync.syncAccounts(accounts);
      return result && typeof result === "object" ? result : {
        attempted: accounts.length,
        synced: 0,
        failed: accounts.length,
        items: [],
      };
    } catch (error) {
      return {
        attempted: accounts.length,
        synced: 0,
        failed: accounts.length,
        items: [],
        error: safeAccountCheckText(error, 180) || "NFapi 最新凭据同步失败",
      };
    }
  }

  requireConnectorKey(req, res, next) {
    if (!timingSafeEqual(req.get("X-API-Key"), this.connectorKey)) return res.status(401).json({ success: false, error: "API Key 无效" });
    return next();
  }

  getProxyPool() {
    return parseProxyPool(getSetting(this.db, "registration_proxy_pool", "[]"));
  }

  reserveJobProxyTemplates(input, count) {
    const plan = resolveJobProxyPlan(
      input,
      this.getProxyPool(),
      getSetting(this.db, "registration_proxy_cursor", "0"),
      count,
    );
    if (plan.nextCursor !== null) {
      setSetting(this.db, "registration_proxy_cursor", String(plan.nextCursor));
    }
    return plan.templates;
  }

  saveProxyPool(input) {
    const proxies = parseProxyPool(input);
    this.db.transaction(() => {
      setSetting(this.db, "registration_proxy_pool", JSON.stringify(proxies));
      const cursor = Number(getSetting(this.db, "registration_proxy_cursor", "0"));
      const normalizedCursor = proxies.length && Number.isSafeInteger(cursor) && cursor >= 0
        ? cursor % proxies.length
        : 0;
      setSetting(this.db, "registration_proxy_cursor", String(normalizedCursor));
    }).immediate();
    this.checkoutProxyCache = { proxy: "", expiresAt: 0 };
    this.trialProxyCache = { proxy: "", expiresAt: 0 };
    this.gbTrialProxyCache = { proxy: "", expiresAt: 0 };
    this.usTrialProxyCache = { proxy: "", expiresAt: 0 };
    this.momoProxyCache = { proxy: "", expiresAt: 0 };
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
    const pickupInventory = await this.pickupRegistrationInventory();
    const pickupStatusUnavailable = this.pickupRegistrationProtectionEnabled() && pickupInventory === null;
    const baseJobs = this.db.prepare(`
      SELECT registration_jobs.id, registration_jobs.email, registration_jobs.status, registration_jobs.stage,
        registration_jobs.message, registration_jobs.failure_reason, registration_jobs.created_at,
        registration_jobs.updated_at, registration_jobs.finished_at, registration_jobs.deleted_at
      FROM registration_jobs
      LEFT JOIN addresses job_address ON job_address.id = registration_jobs.address_id
      WHERE registration_jobs.base_address_id = ?
        OR (
          (registration_jobs.base_address_id IS NULL OR registration_jobs.base_address_id = 0)
          AND (job_address.parent_address_id = ? OR job_address.id = ?)
        )
        OR registration_jobs.email = ? COLLATE NOCASE
      ORDER BY COALESCE(registration_jobs.finished_at, registration_jobs.updated_at, registration_jobs.created_at) DESC,
        registration_jobs.id DESC
    `);
    const accounts = this.db.prepare("SELECT * FROM source_accounts WHERE status = 'connected' AND provider IN ('microsoft', 'google', 'icloud', 'mailcom', 'netease') ORDER BY updated_at DESC").all().map((account) => {
      const direct = DIRECT_MAILBOX_PROVIDERS.has(account.provider);
      const addressLabel = directMailboxLabel(account);
      const bases = this.db.prepare("SELECT id, address, kind, label, strategy FROM addresses WHERE account_id = ? AND kind IN ('primary', 'official') AND status = 'active' ORDER BY kind = 'primary' DESC, created_at, id")
        .all(account.id)
        .filter((base) => !direct || isDirectMailboxAddress(account, base));
      const optionBases = bases.map((base) => {
        const jobs = baseJobs.all(base.id, base.id, base.id, base.address);
        const latest = jobs[0];
        const failedJobs = jobs.filter((job) => job.status === "failed");
        const directState = direct ? directMailboxRegistrationState(jobs) : null;
        const occupied = directState?.occupied || occupiedAliasHistory(jobs);
        const conflictCount = occupied.count;
        const pickupStatus = pickupInventory?.get(String(base.address || "").toLowerCase()) || "";
        const pickupBlocked = direct && (pickupStatusUnavailable || Boolean(pickupStatus));
        const recyclingReserved = account.provider === "mailcom"
          && Boolean(mailcomRecyclingReservation(this.db, base.address));
        const registrationState = recyclingReserved
          ? "mailcom_recycling"
          : pickupBlocked
          ? (pickupStatusUnavailable ? "pickup_unknown" : "pickup_listed")
          : directState?.state
          || (conflictCount >= 2 ? "likely_exhausted" : (conflictCount === 1 ? "warning" : "available"));
        return {
          ...base,
          registration_state: registrationState,
          registration_disabled: recyclingReserved || pickupBlocked || Boolean(directState?.disabled),
          mailcom_recycling_reserved: recyclingReserved,
          pickup_status: pickupStatus,
          pickup_registration_blocked: pickupBlocked,
          already_exists_count: conflictCount,
          occupied_alias_count: conflictCount,
          occupied_aliases: occupied.aliases,
          occupied_alias_last_seen_at: occupied.lastSeenAt,
          last_occupied_alias_at: occupied.lastSeenAt,
          registration_success_count: jobs.filter((job) => job.status === "completed").length,
          registration_failure_count: failedJobs.length,
          last_registration_failure_at: failedJobs[0]?.finished_at
            || failedJobs[0]?.updated_at
            || failedJobs[0]?.created_at
            || "",
          last_registration_status: latest?.status || "",
          registration_hint: recyclingReserved
            ? "这个 Mail.com 地址正在轮换，当前不能创建注册任务。"
            : pickupStatusUnavailable && direct
            ? "取件站库存状态暂时无法确认，为避免误用售卖邮箱，当前禁止注册。"
            : pickupStatus && direct
              ? "这个邮箱已在取件站库存中，必须先从取件站删除后才能用于注册。"
              : directState?.active
            ? `这个 ${addressLabel} 已有进行中的注册任务，请等待任务结束。`
            : conflictCount > 0 && direct
              ? `这个 ${addressLabel} 已被目标站占用，不能重复注册；请导入新的地址。`
              : directState?.completed
                ? `这个 ${addressLabel} 已经用于成功注册；请导入新的地址继续注册。`
                : direct
                  ? `${addressLabel}会直接用于注册，不会生成 +tag 分裂地址。`
                  : registrationState === "likely_exhausted"
                    ? "这个基础地址已标记多个目标站占用别名，建议更换基础地址。"
                    : (registrationState === "warning" ? "这个基础地址已标记目标站占用别名；再次注册请优先更换后缀。" : ""),
        };
      });
      return {
        id: account.id,
        email: account.email,
        display_name: account.display_name,
        provider: account.provider,
        registration_mode: direct ? "direct" : "split",
        max_registration_count: direct ? optionBases.filter((base) => !base.registration_disabled).length : 20,
        bases: optionBases,
      };
    });
    const proxies = this.getProxyPool();
    return {
      accounts,
      proxies,
      maskedProxies: proxies.map(maskProxy),
      proxyMetadata: proxies.map(proxyMetadata),
      inboxLinkMailboxes: this.inboxLinkMailboxes?.list() || {
        total: 0, available: 0, used: 0, in_progress: 0, items: [],
      },
      browserUrl: this.browserUrl,
      service: await this.client.health(),
    };
  }

  async createJobs(input = {}) {
    const mailboxMode = String(input.mailboxMode || "source").trim().toLowerCase();
    if (!new Set(["source", "inbox_link"]).has(mailboxMode)) {
      throw Object.assign(new Error("注册邮箱来源无效"), { status: 400 });
    }
    const requestedCount = input.count === undefined || input.count === null || input.count === ""
      ? 1
      : Number(input.count);
    if (mailboxMode === "inbox_link" && (!Number.isSafeInteger(requestedCount) || requestedCount < 1 || requestedCount > 200)) {
      throw Object.assign(new Error("链接取件注册数量必须是 1 到 200 的整数"), { status: 400 });
    }
    if (mailboxMode === "source" && (!Number.isSafeInteger(requestedCount) || requestedCount < 1)) {
      throw Object.assign(new Error("注册数量必须是正整数"), { status: 400 });
    }
    const requestedConcurrency = input.concurrency === undefined || input.concurrency === null || input.concurrency === ""
      ? 1
      : Number(input.concurrency);
    if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > MAX_REGISTRATION_CONCURRENCY) {
      throw Object.assign(new Error(`注册并发数必须是 1 到 ${MAX_REGISTRATION_CONCURRENCY} 的整数`), { status: 400 });
    }
    let count = requestedCount;
    const addressMode = String(input.addressMode || "split").trim().toLowerCase();
    if (!new Set(["split", "base"]).has(addressMode)) {
      throw Object.assign(new Error("注册邮箱模式无效"), { status: 400 });
    }
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
    const browserMode = requestedBrowserMode;
    if (mailboxMode === "inbox_link") {
      if (!this.inboxLinkMailboxes) {
        throw Object.assign(new Error("链接取件邮箱服务尚未配置"), { status: 503 });
      }
      return this.createInboxLinkJobs({
        input,
        entries: this.inboxLinkMailboxes.availableEntries(count),
        browserMode,
        requestedPassword,
        setPasswordAfterRegistration,
        autoContinuePostSignup,
        requestedConcurrency,
      });
    }
    const account = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(input.accountId));
    if (!account) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
    if (account.status !== "connected") throw Object.assign(new Error("请先完成这个源头邮箱的连接验证"), { status: 409 });
    if (!["microsoft", "google", "icloud", "mailcom", "netease"].includes(account.provider)) {
      throw Object.assign(new Error("这个邮箱提供商不支持注册地址"), { status: 409 });
    }
    const directMailbox = DIRECT_MAILBOX_PROVIDERS.has(account.provider);
    const addressLabel = directMailboxLabel(account);
    let exactAddressIds = null;
    let exactAddresses = null;
    if (Object.hasOwn(input, "addressIds")) {
      if (!Array.isArray(input.addressIds)) {
        throw Object.assign(new Error("指定注册地址必须是数组"), { status: 400 });
      }
      exactAddressIds = input.addressIds.map((value) => Number(value));
      const uniqueIds = new Set(exactAddressIds);
      if (!exactAddressIds.length || exactAddressIds.length > 200
        || exactAddressIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
        || uniqueIds.size !== exactAddressIds.length) {
        throw Object.assign(new Error("指定注册地址无效或重复"), { status: 400 });
      }
      if (exactAddressIds.length !== count) {
        throw Object.assign(new Error("指定注册地址数量与注册数量不一致"), { status: 400 });
      }
      if (!directMailbox) {
        throw Object.assign(new Error("只有 iCloud、Mail.com 或网易直连邮箱支持指定注册地址"), { status: 409 });
      }
      const placeholders = exactAddressIds.map(() => "?").join(",");
      const rows = this.db.prepare(`
        SELECT * FROM addresses
        WHERE account_id = ? AND id IN (${placeholders})
          AND kind IN ('primary', 'official') AND status = 'active'
      `).all(account.id, ...exactAddressIds);
      const byId = new Map(rows.map((row) => [Number(row.id), row]));
      exactAddresses = exactAddressIds.map((id) => byId.get(id));
      if (exactAddresses.some((address) => !address || !isDirectMailboxAddress(account, address))) {
        throw Object.assign(new Error(`指定列表中包含不可用的 ${addressLabel}`), { status: 409 });
      }
    }
    const base = exactAddresses?.[0] || this.db.prepare("SELECT * FROM addresses WHERE id = ? AND account_id = ? AND kind IN ('primary', 'official') AND status = 'active'").get(Number(input.baseAddressId), account.id);
    if (!base) throw Object.assign(new Error("请选择可用的基础地址"), { status: 400 });
    if (!directMailbox) count = Math.min(20, count);
    if (directMailbox && !isDirectMailboxAddress(account, base)) {
      throw Object.assign(new Error(`请选择已导入的 ${addressLabel}`), { status: 400 });
    }
    if (directMailbox && customSuffix) {
      throw Object.assign(new Error(`${addressLabel}不支持 Plus 分裂后缀，请直接选择已导入的地址`), { status: 400 });
    }
    if (!directMailbox && addressMode === "base" && count !== 1) {
      throw Object.assign(new Error("基础地址直注册每次只能提交 1 个任务"), { status: 400 });
    }
    if (!directMailbox && addressMode === "base" && customSuffix) {
      throw Object.assign(new Error("基础地址直注册不能同时设置 Plus 分裂后缀"), { status: 400 });
    }
    resolveJobProxies(input, this.getProxyPool());
    let addresses;
    if (directMailbox) {
      const pickupInventory = await this.pickupRegistrationInventory({ required: true });
      const directBases = this.db.prepare(`
        SELECT * FROM addresses
        WHERE account_id = ? AND kind IN ('primary', 'official') AND status = 'active'
        ORDER BY kind = 'primary' DESC, created_at, id
      `).all(account.id).filter((item) => isDirectMailboxAddress(account, item));
      const directBaseJobs = this.db.prepare(`
        SELECT email, status, stage, message, failure_reason, created_at, updated_at, finished_at
        FROM registration_jobs
        WHERE base_address_id = ?
          OR (
            (base_address_id IS NULL OR base_address_id = 0)
            AND address_id = ?
          )
          OR email = ? COLLATE NOCASE
        ORDER BY created_at DESC, id DESC
      `);
      const assertDirectAddressAvailable = (address) => {
        if (account.provider === "mailcom" && mailcomRecyclingReservation(this.db, address.address)) {
          throw Object.assign(new Error("这个 Mail.com 地址正在轮换，不能创建注册任务"), {
            status: 409,
            code: "MAILCOM_ALIAS_RECYCLING_RESERVED",
          });
        }
        if (pickupInventory.has(String(address.address || "").toLowerCase())) {
          throw Object.assign(new Error("这个邮箱已在取件站售卖库存中，不能用于注册；请先从取件站删除"), {
            status: 409,
            code: "PICKUP_EMAIL_REGISTRATION_BLOCKED",
          });
        }
        const state = directMailboxRegistrationState(directBaseJobs.all(
          address.id,
          address.id,
          address.address,
        ));
        if (state.occupied.count > 0) {
          throw Object.assign(new Error(`这个 ${addressLabel} 已被目标站占用，不能重复注册，请导入新的地址`), { status: 409 });
        }
        if (state.active || state.completed) {
          const message = state.completed
            ? `这个 ${addressLabel} 已经用于成功注册，请导入新的地址`
            : `这个 ${addressLabel} 已有进行中的注册任务`;
          throw Object.assign(new Error(message), { status: 409 });
        }
      };
      if (exactAddresses) {
        exactAddresses.forEach(assertDirectAddressAvailable);
        addresses = exactAddresses;
      } else {
        const selectedIndex = directBases.findIndex((item) => item.id === base.id);
        if (selectedIndex < 0) throw Object.assign(new Error(`请选择已导入的 ${addressLabel}`), { status: 400 });
        assertDirectAddressAvailable(base);
        const available = directBases.slice(selectedIndex).filter((item) => (
          !pickupInventory.has(String(item.address || "").toLowerCase())
            && !(account.provider === "mailcom" && mailcomRecyclingReservation(this.db, item.address))
            && !directMailboxRegistrationState(directBaseJobs.all(
              item.id,
              item.id,
              item.address,
            )).disabled
        ));
        if (count > available.length) {
          throw Object.assign(new Error(`从所选 ${addressLabel} 往下仅有 ${available.length} 个可用地址，最多可注册 ${available.length} 个`), { status: 409 });
        }
        addresses = available.slice(0, count);
      }
    } else if (addressMode === "base") {
      const existing = this.db.prepare(`
        SELECT status, stage, message, failure_reason
        FROM registration_jobs
        WHERE lower(email) = lower(?)
        ORDER BY created_at DESC, id DESC
      `).all(base.address);
      const occupied = existing.find((job) => registrationFailureReason(job) === OCCUPIED_ALIAS_FAILURE_REASON);
      if (occupied) {
        throw Object.assign(new Error("这个基础地址已被目标站占用，请选择新的官方别名"), { status: 409 });
      }
      const activeOrCompleted = existing.find((job) => (
        RELEASABLE_JOB_STATUSES.has(String(job.status || "")) || job.status === "completed"
      ));
      if (activeOrCompleted) {
        const message = activeOrCompleted.status === "completed"
          ? "这个基础地址已经用于成功注册，请选择新的官方别名"
          : "这个基础地址已有进行中的注册任务";
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
    const pendingJobs = this.db.transaction(() => {
      if (account.provider === "mailcom") {
        const reservations = mailcomRecyclingReservations(this.db, addresses.map((address) => address.address));
        if (reservations.size) {
          throw Object.assign(new Error("所选 Mail.com 地址正在轮换，不能创建注册任务"), {
            status: 409,
            code: "MAILCOM_ALIAS_RECYCLING_RESERVED",
          });
        }
      }
      const proxyTemplates = this.reserveJobProxyTemplates(input, addresses.length);
      return addresses.map((address, index) => {
        const proxyTemplate = proxyTemplates[index];
        const proxy = materializeProxySession(proxyTemplate, usedProxySessions);
        const now = nowIso();
        const result = this.db.prepare(`
          INSERT INTO registration_jobs (
            account_id, address_id, base_address_id, email, status, stage, browser_mode, proxy_label, fingerprint_id,
            message, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, '正在提交注册任务', ?, ?)
        `).run(account.id, address.id, directMailbox ? address.id : base.id, address.address, browserMode, maskProxy(proxy), crypto.randomUUID().slice(0, 12), now, now);
        const jobId = Number(result.lastInsertRowid);
        return { address, jobId, proxy };
      });
    }).immediate();
    const registrationBatchId = crypto.randomUUID();
    const registrationBatchConcurrency = Math.min(requestedConcurrency, pendingJobs.length);
    for (const { address, jobId, proxy } of pendingJobs) {
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
            registration_batch_id: registrationBatchId,
            registration_batch_concurrency: registrationBatchConcurrency,
          },
        });
        const taskId = String(task.task_id || task.id || "");
        this.db.prepare("UPDATE registration_jobs SET external_task_id = ?, message = ?, updated_at = ? WHERE id = ?")
          .run(taskId, "任务已提交，等待执行", nowIso(), jobId);
      } catch (error) {
        const failureReason = remoteRegistrationFailureReason(error);
        const finishedAt = nowIso();
        this.db.prepare(`
          UPDATE registration_jobs
          SET status = 'failed', stage = 'submit', message = ?, failure_reason = ?, finished_at = ?, updated_at = ?
          WHERE id = ?
        `).run("注册任务提交失败", failureReason, finishedAt, finishedAt, jobId);
      }
      jobs.push(publicRegistrationJob(this.getJob(jobId)));
    }
    return jobs;
  }

  async createInboxLinkJobs({
    input,
    entries,
    browserMode,
    requestedPassword,
    setPasswordAfterRegistration,
    autoContinuePostSignup,
    requestedConcurrency,
  }) {
    for (const entry of entries) {
      const existing = this.db.prepare(`
        SELECT status FROM registration_jobs
        WHERE lower(email) = lower(?) AND deleted_at IS NULL
          AND status IN ('queued', 'pending', 'claimed', 'running', 'paused', 'cancel_requested', 'completed')
        ORDER BY created_at DESC LIMIT 1
      `).get(entry.email);
      if (existing) {
        const message = existing.status === "completed"
          ? `${entry.email} 已经用于成功注册`
          : `${entry.email} 已有进行中的注册任务`;
        throw Object.assign(new Error(message), { status: 409 });
      }
    }

    resolveJobProxies(input, this.getProxyPool());
    const jobs = [];
    const usedProxySessions = new Set();
    const registrationBatchId = crypto.randomUUID();
    const registrationBatchConcurrency = Math.min(requestedConcurrency, entries.length);
    const pendingJobs = this.db.transaction(() => {
      const proxyTemplates = this.reserveJobProxyTemplates(input, entries.length);
      return entries.map((entry, index) => {
        const proxy = materializeProxySession(proxyTemplates[index], usedProxySessions);
        const now = nowIso();
        const result = this.db.prepare(`
          INSERT INTO registration_jobs (
            account_id, address_id, base_address_id, email, status, stage, browser_mode, proxy_label, fingerprint_id,
            message, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, '正在提交链接取件注册任务', ?, ?)
        `).run(
          entry.sourceAccountId || null,
          entry.sourceAddressId || null,
          entry.sourceAddressId || null,
          entry.email,
          browserMode,
          maskProxy(proxy),
          crypto.randomUUID().slice(0, 12),
          now,
          now,
        );
        return { entry, jobId: Number(result.lastInsertRowid), proxy };
      });
    }).immediate();
    for (const { entry, jobId, proxy } of pendingJobs) {
      try {
        const task = await this.client.createTask({
          platform: "chatgpt",
          email: entry.email,
          password: requestedPassword || null,
          count: 1,
          concurrency: 1,
          proxy: proxy || null,
          executor_type: browserMode,
          captcha_solver: "auto",
          extra: {
            identity_provider: "mailbox",
            mail_provider: "dispose_inbox_link",
            mail_source_provider: "dispose_inbox_link",
            dispose_inbox_link_pool_text: serializeInboxLinkEntry(entry),
            dispose_inbox_link_poll_interval: "3",
            fresh_browser_context: true,
            random_fingerprint: true,
            email_only_registration: true,
            disable_phone_verification: true,
            phone_verification_policy: "forbid",
            allow_chatgpt_registration_proxy: true,
            set_password_after_registration: setPasswordAfterRegistration,
            auto_continue_post_signup: autoContinuePostSignup,
            registration_batch_id: registrationBatchId,
            registration_batch_concurrency: registrationBatchConcurrency,
          },
        });
        const taskId = String(task.task_id || task.id || "");
        this.db.prepare("UPDATE registration_jobs SET external_task_id = ?, message = ?, updated_at = ? WHERE id = ?")
          .run(taskId, "链接取件任务已提交，等待执行", nowIso(), jobId);
      } catch (error) {
        const failureReason = remoteRegistrationFailureReason(error);
        const finishedAt = nowIso();
        this.db.prepare(`
          UPDATE registration_jobs
          SET status = 'failed', stage = 'submit', message = ?, failure_reason = ?, finished_at = ?, updated_at = ?
          WHERE id = ?
        `).run("链接取件注册任务提交失败", failureReason, finishedAt, finishedAt, jobId);
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
      const status = statusFromExternal(task.status);
      let events = [];
      let eventReadError = "";
      if (!row.display_name || ACTIVE_STATUSES.has(String(task.status || "")) || status === "failed") {
        try {
          const response = await this.client.getTaskEvents(row.external_task_id);
          const remoteEvents = Array.isArray(response) ? response : response.items || response.events || [];
          events = sanitizeRegistrationRemoteValue(remoteEvents);
        } catch (error) {
          eventReadError = redactProxySecrets(error?.message) || "读取注册任务事件失败";
        }
      }
      const identity = identityFromEvents(events);
      const lastMessage = events.length ? eventMessage(events[events.length - 1]) : "";
      const priorFailureReason = knownRegistrationFailureReason(row.failure_reason);
      const detectedFailureReason = status === "failed"
        ? remoteRegistrationFailureReason(task, task?.errors, task?.result, events)
        : "";
      const failureReason = priorFailureReason || detectedFailureReason || String(row.failure_reason || "");
      const taskError = typeof task.error === "string"
        ? task.error
        : (typeof task?.error?.message === "string" ? task.error.message : "");
      const message = priorFailureReason && row.message
        ? row.message
        : (taskError || lastMessage || eventReadError || row.message || "");
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
          message = ?, failure_reason = ?, finished_at = ?, updated_at = ? WHERE id = ?
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
        redactProxySecrets(message),
        failureReason,
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

  jobCounts() {
    const counts = { total: 0 };
    this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM registration_jobs
      WHERE deleted_at IS NULL
      GROUP BY status
    `).all().forEach((row) => {
      const count = Number(row.count) || 0;
      counts[String(row.status || "unknown")] = count;
      counts.total += count;
    });
    return counts;
  }

  registrationQueueControl() {
    return this.client.getRegistrationQueueControl();
  }

  pauseRegistrationQueue() {
    return this.client.pauseRegistrationQueue();
  }

  resumeRegistrationQueue() {
    return this.client.resumeRegistrationQueue();
  }

  cancelRegistrationQueue() {
    return this.client.cancelRegistrationQueue();
  }

  async pauseJob(id) {
    const row = this.getJob(id);
    if (!row) throw Object.assign(new Error("注册任务不存在"), { status: 404 });
    if (TERMINAL_STATUSES.has(row.status)) return publicRegistrationJob(row);
    if (!row.external_task_id) {
      throw Object.assign(new Error("任务尚未提交到注册服务，请稍后重试"), { status: 409 });
    }
    await this.client.pauseTask(row.external_task_id);
    return publicRegistrationJob(await this.syncJob(this.getJob(row.id)));
  }

  async resumeJob(id) {
    const row = this.getJob(id);
    if (!row) throw Object.assign(new Error("注册任务不存在"), { status: 404 });
    if (TERMINAL_STATUSES.has(row.status)) return publicRegistrationJob(row);
    if (!row.external_task_id) {
      throw Object.assign(new Error("任务尚未提交到注册服务，请稍后重试"), { status: 409 });
    }
    await this.client.resumeTask(row.external_task_id);
    return publicRegistrationJob(await this.syncJob(this.getJob(row.id)));
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
        AND status IN ('queued', 'pending', 'claimed', 'running', 'paused', 'cancel_requested')
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
    const ids = normalizeSelectedIds(input, "注册记录", 500);
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
    const publicJob = publicRegistrationJob(row);
    const localFailureEvent = {
      id: `local-failure-${row.id}`,
      level: "error",
      created_at: row.finished_at || row.updated_at || row.created_at,
      message: `注册失败：${publicJob.display_message || publicJob.message || "未返回失败原因"}`,
      detail: {
        source: "alias_hub",
        email: row.email,
        stage: row.stage || "unknown",
        failure_reason: publicJob.failure_reason || "",
      },
    };
    if (!row.external_task_id) return row.status === "failed" ? [localFailureEvent] : [];
    try {
      const response = await this.client.getTaskEvents(row.external_task_id);
      const events = Array.isArray(response) ? response : response.items || response.events || [];
      const sanitized = sanitizeRegistrationRemoteValue(events);
      return row.status === "failed" ? [...sanitized, localFailureEvent] : sanitized;
    } catch (error) {
      if (row.status === "failed") {
        return [localFailureEvent, {
          id: `remote-log-error-${row.id}`,
          level: "error",
          created_at: nowIso(),
          message: `远程日志读取失败：${redactProxySecrets(error?.message) || "注册服务暂时不可用"}`,
        }];
      }
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

  registeredAccountOriginalProxy(job, operationLabel) {
    const proxyLabel = String(job?.proxy_label || "").trim();
    if (proxyLabel === "直连") return "";
    if (!proxyLabel) {
      throw Object.assign(new Error(`注册记录缺少原代理信息，拒绝${operationLabel}`), { status: 409 });
    }
    const matches = this.getProxyPool().filter((proxy) => maskProxy(proxy) === proxyLabel);
    if (matches.length !== 1) {
      throw Object.assign(new Error(`无法唯一还原注册时使用的代理，拒绝${operationLabel}`), { status: 409 });
    }
    return matches[0];
  }

  registeredAccountRefreshProxy(job, proxySelection) {
    const selection = String(proxySelection || "original").trim().toLowerCase();
    if (selection === "original") return this.registeredAccountOriginalProxy(job, "刷新 AT");
    const match = selection.match(/^proxy:(\d+)$/);
    if (!match) {
      throw Object.assign(new Error("AT 刷新代理选择无效"), { status: 400 });
    }
    const proxies = this.getProxyPool();
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index < 0 || index >= proxies.length) {
      throw Object.assign(new Error("选择的 AT 刷新代理已不存在，请刷新页面后重试"), { status: 409 });
    }
    return proxies[index];
  }

  passwordSetupProxy(job) {
    return this.registeredAccountOriginalProxy(job, "补设密码");
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
      await this.syncLatestNfapiCredentials(candidates);
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
    let response = await this.listAllRemoteAccounts();
    const jobs = this.db.prepare(`
      SELECT * FROM registration_jobs
      WHERE external_account_id <> '' AND status = 'completed'
      ORDER BY created_at DESC
    `).all();
    const metadataByAccountId = new Map(this.db.prepare("SELECT * FROM registered_account_metadata").all()
      .map((item) => [String(item.external_account_id), item]));
    let checkoutByAccountId = new Map();
    try {
      checkoutByAccountId = new Map(this.db.prepare("SELECT * FROM registered_account_checkout_checks").all()
        .map((item) => [String(item.external_account_id), item]));
    } catch {
      // Older test databases can still list accounts before running the latest schema.
    }
    let trialByAccountId = new Map();
    try {
      trialByAccountId = new Map(this.db.prepare("SELECT * FROM registered_account_trial_checks").all()
        .map((item) => [String(item.external_account_id), item]));
    } catch {
      // Older test databases can still list accounts before running the latest schema.
    }
    let gbTrialByAccountId = new Map();
    try {
      gbTrialByAccountId = new Map(this.db.prepare("SELECT * FROM registered_account_gb_trial_checks").all()
        .map((item) => [String(item.external_account_id), item]));
    } catch {
      // Older test databases can still list accounts before running the latest schema.
    }
    let usTrialByAccountId = new Map();
    try {
      usTrialByAccountId = new Map(this.db.prepare("SELECT * FROM registered_account_us_trial_checks").all()
        .map((item) => [String(item.external_account_id), item]));
    } catch {
      // Older test databases can still list accounts before running the latest schema.
    }
    let momoByAccountId = new Map();
    try {
      momoByAccountId = new Map(this.db.prepare("SELECT * FROM registered_account_momo_checks").all()
        .map((item) => [String(item.external_account_id), item]));
    } catch {
      // Older test databases can still list accounts before running the latest schema.
    }
    const plusMailByEmail = plusMailEvidenceByEmail(this.db);
    const nfapiByAccountId = new Map();
    const nfapiBaseUrl = String(getSetting(this.db, "nfapi_base_url", "")).replace(/\/+$/, "");
    this.db.prepare(`
      SELECT * FROM registered_account_nfapi_links
      WHERE nfapi_base_url = ? AND status = 'imported'
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
        response = await this.listAllRemoteAccounts();
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
        const checkoutCheck = checkoutByAccountId.get(String(item.id || ""));
        const trialCheck = trialByAccountId.get(String(item.id || ""));
        const gbTrialCheck = gbTrialByAccountId.get(String(item.id || ""));
        const usTrialCheck = usTrialByAccountId.get(String(item.id || ""));
        const momoCheck = momoByAccountId.get(String(item.id || ""));
        const nfapiLink = nfapiByAccountId.get(String(item.id || ""));
        const checkOutcome = this.accountStatusCheckOutcomes.get(String(item.id || ""));
        const checkOutcomeMatches = checkOutcome
          && String(checkOutcome.email || "").toLowerCase() === String(item.email || "").toLowerCase();
        const accountSignals = accountStatusSignals(item, checkOutcomeMatches ? checkOutcome : null);
        const plusMail = plusMailByEmail.get(String(item.email || "").toLowerCase());
        const mailPromoted = shouldPromotePlusMail(plusMail, item, accountSignals);
        const preserveNonPlanStatus = ACCOUNT_UNAVAILABLE_CODES.has(normalizeCheckCode(accountSignals.status_code))
          || CREDENTIAL_EXPIRED_CODES.has(normalizeCheckCode(accountSignals.status_code))
          || CREDENTIAL_REVOKED_CODES.has(normalizeCheckCode(accountSignals.status_code));
        const effectiveSignals = mailPromoted ? {
          ...accountSignals,
          account_type: "plus",
          account_type_raw: "chatgptplusplan",
          account_type_known: true,
          account_type_source: "mail_confirmation",
          subscription_status: "active",
          detection_status: "confirmed",
          status_code: preserveNonPlanStatus ? accountSignals.status_code : "subscription_active",
          status_reason: preserveNonPlanStatus
            ? accountSignals.status_reason : "检测到与当前 workspace 匹配的 ChatGPT Plus 开通确认邮件",
          status_retryable: preserveNonPlanStatus ? accountSignals.status_retryable : false,
          status_evidence_path: preserveNonPlanStatus
            ? accountSignals.status_evidence_path : "mail_messages.account_manage_link+subject+body",
          status_checked_at: plusMail.received_at,
          status_confirmed_at: plusMail.received_at,
          status_source: preserveNonPlanStatus
            ? accountSignals.status_source : "mail/plus-confirmation",
          plan_state: "subscribed",
          plan_name: "chatgptplusplan",
          display_status: "subscribed",
        } : accountSignals;
        const plusAt = (effectiveSignals.account_type === "plus" || mailPromoted)
          ? plusDateFromAccount(item, plusMailMatchesAccount(plusMail, item) ? plusMail : null)
          : "";
        const checkState = mailPromoted ? "checked" : checkOutcomeMatches
          ? (checkOutcome.detection_status === "confirmed" ? "checked" : "failed")
          : "";
        const checkError = !mailPromoted && checkOutcomeMatches && checkOutcome.detection_status !== "confirmed"
          ? checkOutcome.reason : "";
        const metadataMatches = metadata
          && String(metadata.email || "").toLowerCase() === String(item.email || "").toLowerCase();
        const checkoutMatches = checkoutCheck
          && String(checkoutCheck.email || "").toLowerCase() === String(item.email || "").toLowerCase();
        const trialMatches = trialCheck
          && String(trialCheck.email || "").toLowerCase() === String(item.email || "").toLowerCase()
          && (String(trialCheck.evidence || "") === JP_ZERO_TRIAL_EVIDENCE
            || String(trialCheck.evidence || "") === JP_FAST_INELIGIBLE_EVIDENCE
            || (String(trialCheck.status || "") === "failed" && !trialCheck.evidence));
        const gbTrialMatches = gbTrialCheck
          && String(gbTrialCheck.email || "").toLowerCase() === String(item.email || "").toLowerCase()
          && (String(gbTrialCheck.evidence || "") === GB_ZERO_TRIAL_EVIDENCE
            || String(gbTrialCheck.evidence || "") === GB_FAST_INELIGIBLE_EVIDENCE
            || (String(gbTrialCheck.status || "") === "failed" && !gbTrialCheck.evidence));
        const usTrialMatches = usTrialCheck
          && String(usTrialCheck.email || "").toLowerCase() === String(item.email || "").toLowerCase()
          && (String(usTrialCheck.evidence || "") === US_ZERO_TRIAL_EVIDENCE
            || String(usTrialCheck.evidence || "") === US_FAST_INELIGIBLE_EVIDENCE
            || (String(usTrialCheck.status || "") === "failed" && !usTrialCheck.evidence));
        const momoMatches = momoCheck
          && String(momoCheck.email || "").toLowerCase() === String(item.email || "").toLowerCase()
          && MOMO_CHECK_EVIDENCES.includes(String(momoCheck.evidence || ""));
        const nfapiMatches = nfapiLink
          && String(nfapiLink.email || "").toLowerCase() === String(item.email || "").toLowerCase();
        const storedGroupName = metadataMatches ? String(metadata.group_name || "") : "";
        const customGroupName = isPlanManagedGroupName(storedGroupName) ? "" : storedGroupName;
        const defaultGroupName = defaultPlanGroupName(effectiveSignals);
        return {
          id: item.id,
          email: item.email,
          ...passwordMetadata,
          password_setup_available: passwordSetup.available,
          password_setup_reason: passwordSetup.reason,
          user_id: item.user_id,
          ...effectiveSignals,
          mail_plus_confirmed: Boolean(plusMail),
          mail_plus_confirmed_at: plusMail?.received_at || "",
          plus_at: plusAt,
          mail_plus_subject: plusMail?.subject || "",
          mail_plus_account_id: plusMail?.account_id || "",
          status_check_state: checkState,
          status_check_error: checkError,
          status_check_attempted_at: checkOutcomeMatches ? checkOutcome.attempted_at : "",
          status: effectiveSignals.display_status !== "unknown"
            ? effectiveSignals.display_status : effectiveSignals.lifecycle_status,
          plan: effectiveSignals.account_type !== "unknown"
            ? effectiveSignals.account_type : effectiveSignals.plan_state,
          display_name: job?.display_name || "",
          birth_date: job?.birth_date || "",
          exit_ip: job?.exit_ip || "",
          custom_name: metadataMatches ? metadata.custom_name : "",
          group_name: customGroupName || defaultGroupName,
          custom_group_name: customGroupName,
          default_group_name: defaultGroupName,
          group_source: customGroupName ? "custom" : "plan",
          checkout_status: checkoutMatches ? String(checkoutCheck.status || "unchecked") : "unchecked",
          checkout_type: checkoutMatches ? String(checkoutCheck.checkout_type || "") : "",
          checkout_error: checkoutMatches ? String(checkoutCheck.error || "") : "",
          checkout_checked_at: checkoutMatches ? String(checkoutCheck.checked_at || "") : "",
          trial_status: trialMatches ? String(trialCheck.status || "unchecked") : "unchecked",
          trial_eligible: trialMatches && trialCheck.eligible !== null
            ? Boolean(trialCheck.eligible) : null,
          trial_evidence: trialMatches ? String(trialCheck.evidence || "") : "",
          trial_error: trialMatches ? String(trialCheck.error || "") : "",
          trial_checked_at: trialMatches ? String(trialCheck.checked_at || "") : "",
          gb_trial_status: gbTrialMatches ? String(gbTrialCheck.status || "unchecked") : "unchecked",
          gb_trial_eligible: gbTrialMatches && gbTrialCheck.eligible !== null
            ? Boolean(gbTrialCheck.eligible) : null,
          gb_trial_evidence: gbTrialMatches ? String(gbTrialCheck.evidence || "") : "",
          gb_trial_error: gbTrialMatches ? String(gbTrialCheck.error || "") : "",
          gb_trial_checked_at: gbTrialMatches ? String(gbTrialCheck.checked_at || "") : "",
          us_trial_status: usTrialMatches ? String(usTrialCheck.status || "unchecked") : "unchecked",
          us_trial_eligible: usTrialMatches && usTrialCheck.eligible !== null
            ? Boolean(usTrialCheck.eligible) : null,
          us_trial_evidence: usTrialMatches ? String(usTrialCheck.evidence || "") : "",
          us_trial_error: usTrialMatches ? String(usTrialCheck.error || "") : "",
          us_trial_checked_at: usTrialMatches ? String(usTrialCheck.checked_at || "") : "",
          momo_status: momoMatches ? String(momoCheck.status || "unchecked") : "unchecked",
          momo_eligible: momoMatches && momoCheck.eligible !== null
            ? Boolean(momoCheck.eligible) : null,
          momo_methods: momoMatches ? parseJson(momoCheck.methods, []) : [],
          momo_evidence: momoMatches ? String(momoCheck.evidence || "") : "",
          momo_error: momoMatches ? String(momoCheck.error || "") : "",
          momo_checked_at: momoMatches ? String(momoCheck.checked_at || "") : "",
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

  async importLocalAccounts(input = {}) {
    const imports = parseLocalAccountImport(input);
    const emails = imports.map((item) => item.payload.email);
    const busyEmails = emails.filter((email) => this.localAccountImportEmails.has(email));
    if (busyEmails.length) {
      throw Object.assign(new Error(`以下邮箱正在导入，请等待当前请求完成：${busyEmails.join("、")}`), { status: 409 });
    }
    emails.forEach((email) => this.localAccountImportEmails.add(email));
    try {
    const placeholders = emails.map(() => "?").join(",");
    const history = this.db.prepare(`
      SELECT * FROM registration_jobs
      WHERE email IN (${placeholders}) COLLATE NOCASE
        AND status = 'completed' AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC
    `).all(...emails);
    const historyByEmail = new Map();
    for (const row of history) {
      const email = String(row.email || "").trim().toLowerCase();
      if (!historyByEmail.has(email)) historyByEmail.set(email, []);
      historyByEmail.get(email).push(row);
    }

    const missingMailbox = imports
      .filter((item) => !historyByEmail.has(item.payload.email) && !item.inboxLink)
      .map((item) => item.payload.email);
    if (missingMailbox.length) {
      throw Object.assign(new Error(`以下邮箱没有可关联的已完成注册记录，请同时提供 HTTPS 取件链接：${missingMailbox.join("、")}`), { status: 409 });
    }
    const externalImports = imports.filter((item) => !historyByEmail.has(item.payload.email));
    const inboxLinkImports = imports.filter((item) => item.inboxLink);
    if (externalImports.length || inboxLinkImports.length) {
      if (!this.inboxLinkMailboxes
        || typeof this.inboxLinkMailboxes.import !== "function"
        || typeof this.inboxLinkMailboxes.preflightImport !== "function") {
        throw Object.assign(new Error("外部账号邮件取件服务尚未配置"), { status: 503 });
      }
    }
    if (inboxLinkImports.length) {
      this.inboxLinkMailboxes.preflightImport({
        poolText: inboxLinkImports.map((item) => serializeInboxLinkEntry({
          email: item.payload.email,
          inboxLink: item.inboxLink,
        })).join("\n"),
        replaceExisting: false,
      });
    }

    const remote = await this.client.listAccounts({ pageSize: 10_000 });
    const remoteItems = Array.isArray(remote?.items) ? remote.items : [];
    const remoteByEmail = new Map(remoteItems.map((item) => [String(item?.email || "").trim().toLowerCase(), item]));
    const existing = emails.filter((email) => remoteByEmail.has(email));
    if (existing.length) {
      throw Object.assign(new Error(`以下邮箱已在本地账号池中：${existing.join("、")}`), { status: 409 });
    }

    const targets = imports.map((item) => {
      const candidates = historyByEmail.get(item.payload.email) || [];
      const job = item.originalId && candidates.length
        ? candidates.find((candidate) => Number(candidate.external_account_id) === item.originalId) || candidates[0]
        : candidates[0] || null;
      const mailbox = registrationMailboxBindings(item.payload.email, this.mailboxBaseUrl);
      return {
        ...item,
        job,
        importSource: job ? "restored" : "external",
        payload: {
          ...item.payload,
          provider_accounts: [...mailbox.providerAccounts, ...(item.payload.provider_accounts || [])],
          provider_resources: [...mailbox.providerResources, ...(item.payload.provider_resources || [])],
        },
      };
    });
    const created = [];
    const remoteCreatedIds = [];
    const uncertainEmails = new Set();
    const rollbackRemote = async () => {
      const ids = new Set(remoteCreatedIds);
      const failures = [];
      for (const email of uncertainEmails) {
        try {
          const response = await this.client.listAccounts({ email, pageSize: 100 });
          for (const account of Array.isArray(response?.items) ? response.items : []) {
            const id = Number(account?.id);
            if (Number.isSafeInteger(id) && id > 0
              && String(account?.platform || "chatgpt").toLowerCase() === "chatgpt"
              && String(account?.email || "").trim().toLowerCase() === email
              && !remoteByEmail.has(email)) {
              ids.add(id);
            }
          }
        } catch (error) {
          failures.push({ email, error: error?.message || "远端账号对账失败" });
        }
      }
      const rollbackIds = [...ids];
      const settled = await Promise.allSettled(rollbackIds.map((id) => this.client.deleteAccount(id)));
      settled.forEach((result, index) => {
        if (result.status === "rejected" || result.value?.ok === false) {
          failures.push({
            id: rollbackIds[index],
            error: result.status === "rejected" ? result.reason?.message || "远端删除失败" : "远端拒绝删除",
          });
        }
      });
      return { attempted: rollbackIds.length, failed: failures };
    };

    try {
      for (const target of targets) {
        uncertainEmails.add(target.payload.email);
        const account = await this.client.createAccount(target.payload);
        const id = Number(account?.id);
        const email = String(account?.email || "").trim().toLowerCase();
        const duplicateRemoteId = remoteCreatedIds.includes(id);
        if (Number.isSafeInteger(id) && id > 0 && !duplicateRemoteId) remoteCreatedIds.push(id);
        if (!Number.isSafeInteger(id) || id <= 0 || email !== target.payload.email
          || String(account?.platform || "chatgpt").toLowerCase() !== "chatgpt"
          || duplicateRemoteId) {
          throw Object.assign(new Error(`注册机没有确认导入 ${target.payload.email}`), { status: 502 });
        }
        created.push({
          id,
          email,
          target,
          previousAccountId: Number(target.job?.external_account_id) || 0,
          registrationJobId: Number(target.job?.id) || 0,
        });
        uncertainEmails.delete(target.payload.email);
      }
    } catch (error) {
      const rollback = await rollbackRemote();
      const rollbackIncomplete = rollback.failed.length > 0;
      const rollbackFailures = rollback.failed.map((item) => ({
        ...(item.id ? { id: Number(item.id) } : {}),
        ...(item.email ? { email: safeRemoteText(item.email, 320).toLowerCase() } : {}),
        error: safeRemoteText(redactProxySecrets(item.error), 180) || "远端回滚失败",
      }));
      throw Object.assign(new Error(rollbackIncomplete
        ? `本地账号导入失败，且有 ${rollback.failed.length} 项远端回滚未完成`
        : `本地账号导入失败：${error?.message || "注册机请求失败"}`), {
        status: rollbackIncomplete ? 502 : Number(error?.status) || 502,
        ...(rollbackIncomplete ? {
          code: "LOCAL_ACCOUNT_IMPORT_ROLLBACK_INCOMPLETE",
          rollback_failures: rollbackFailures,
        } : {}),
      });
    }

    try {
      this.db.transaction(() => {
        const linkedEntries = created.filter((item) => item.target.inboxLink);
        if (linkedEntries.length) {
          this.inboxLinkMailboxes.import({
            poolText: linkedEntries.map((item) => serializeInboxLinkEntry({
              email: item.email,
              inboxLink: item.target.inboxLink,
            })).join("\n"),
            replaceExisting: false,
          });
        }
        const updateJob = this.db.prepare(`
          UPDATE registration_jobs
          SET external_account_id = ?,
            account_id = COALESCE(?, account_id),
            address_id = COALESCE(?, address_id),
            base_address_id = COALESCE(?, base_address_id),
            updated_at = ?
          WHERE id = ? AND status = 'completed' AND deleted_at IS NULL
        `);
        const importedMailbox = this.db.prepare(`
          SELECT inbox_link_mailboxes.source_account_id AS account_id, addresses.id AS address_id
          FROM inbox_link_mailboxes
          JOIN source_accounts ON source_accounts.id = inbox_link_mailboxes.source_account_id
          JOIN addresses ON addresses.account_id = source_accounts.id
            AND addresses.kind = 'primary'
            AND addresses.address = inbox_link_mailboxes.email COLLATE NOCASE
          WHERE inbox_link_mailboxes.email = ? COLLATE NOCASE
            AND inbox_link_mailboxes.status = 'active'
            AND source_accounts.provider = 'inbox_link'
            AND source_accounts.status = 'connected'
          ORDER BY addresses.id LIMIT 1
        `);
        const insertImportedJob = this.db.prepare(`
          INSERT INTO registration_jobs (
            account_id, address_id, base_address_id, email, external_task_id, external_account_id,
            status, stage, browser_mode, proxy_label, progress_current, progress_total,
            message, created_at, updated_at, finished_at
          ) VALUES (?, ?, ?, ?, '', ?, 'completed', 'external_import', 'imported', '直连', 1, 1, ?, ?, ?, ?)
        `);
        const migrateMetadata = this.db.prepare(`
          UPDATE registered_account_metadata SET external_account_id = ?, updated_at = ?
          WHERE external_account_id = ? AND email = ? COLLATE NOCASE
        `);
        const migrateStatus = this.db.prepare(`
          UPDATE registered_account_status_checks SET external_account_id = ?, updated_at = ?
          WHERE external_account_id = ? AND email = ? COLLATE NOCASE
        `);
        const migrateCheckout = this.db.prepare(`
          UPDATE registered_account_checkout_checks SET external_account_id = ?, updated_at = ?
          WHERE external_account_id = ? AND email = ? COLLATE NOCASE
        `);
        const migrateTrial = this.db.prepare(`
          UPDATE registered_account_trial_checks SET external_account_id = ?, updated_at = ?
          WHERE external_account_id = ? AND email = ? COLLATE NOCASE
        `);
        const migrateGbTrial = this.db.prepare(`
          UPDATE registered_account_gb_trial_checks SET external_account_id = ?, updated_at = ?
          WHERE external_account_id = ? AND email = ? COLLATE NOCASE
        `);
        const migrateUsTrial = this.db.prepare(`
          UPDATE registered_account_us_trial_checks SET external_account_id = ?, updated_at = ?
          WHERE external_account_id = ? AND email = ? COLLATE NOCASE
        `);
        const migrateNfapi = this.db.prepare(`
          UPDATE registered_account_nfapi_links SET external_account_id = ?, updated_at = ?
          WHERE external_account_id = ? AND email = ? COLLATE NOCASE
        `);
        const migratePasswordTasks = this.db.prepare(`
          UPDATE registration_password_setup_tasks SET external_account_id = ?, updated_at = ?
          WHERE external_account_id = ?
        `);
        const updatedAt = nowIso();
        for (const item of created) {
          let accountId = 0;
          let addressId = 0;
          if (item.target.inboxLink) {
            const binding = importedMailbox.get(item.email);
            accountId = Number(binding?.account_id);
            addressId = Number(binding?.address_id);
            if (!Number.isSafeInteger(accountId) || accountId <= 0
              || !Number.isSafeInteger(addressId) || addressId <= 0) {
              throw new Error(`${item.email} 的邮件取件资源绑定失败`);
            }
          }
          if (item.target.importSource === "external") {
            const result = insertImportedJob.run(
              accountId,
              addressId,
              addressId,
              item.email,
              String(item.id),
              "外部账号已导入，邮件取件链接已绑定",
              updatedAt,
              updatedAt,
              updatedAt,
            );
            item.registrationJobId = Number(result.lastInsertRowid);
            continue;
          }
          const previousId = String(item.target.job.external_account_id || "");
          const result = updateJob.run(
            String(item.id),
            accountId || null,
            addressId || null,
            addressId || null,
            updatedAt,
            item.target.job.id,
          );
          if (result.changes !== 1) throw new Error(`注册记录 ${item.target.job.id} 关联失败`);
          if (previousId) {
            migrateMetadata.run(String(item.id), updatedAt, previousId, item.email);
            migrateStatus.run(String(item.id), updatedAt, previousId, item.email);
            migrateCheckout.run(String(item.id), updatedAt, previousId, item.email);
            migrateTrial.run(String(item.id), updatedAt, previousId, item.email);
            migrateGbTrial.run(String(item.id), updatedAt, previousId, item.email);
            migrateUsTrial.run(String(item.id), updatedAt, previousId, item.email);
            migrateNfapi.run(String(item.id), updatedAt, previousId, item.email);
            migratePasswordTasks.run(item.id, updatedAt, Number(previousId));
          }
        }
      })();
    } catch (error) {
      const rollback = await rollbackRemote();
      const rollbackIncomplete = rollback.failed.length > 0;
      const rollbackFailures = rollback.failed.map((item) => ({
        ...(item.id ? { id: Number(item.id) } : {}),
        ...(item.email ? { email: safeRemoteText(item.email, 320).toLowerCase() } : {}),
        error: safeRemoteText(redactProxySecrets(item.error), 180) || "远端回滚失败",
      }));
      const status = Number(error?.status);
      throw Object.assign(new Error(rollbackIncomplete
        ? `本地账号关联失败，且有 ${rollback.failed.length} 项远端回滚未完成`
        : `本地账号已回滚：${error?.message || "注册记录关联失败"}`), {
        status: rollbackIncomplete ? 502
          : Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
        ...(rollbackIncomplete
          ? {
            code: "LOCAL_ACCOUNT_IMPORT_ROLLBACK_INCOMPLETE",
            rollback_failures: rollbackFailures,
          }
          : error?.code ? { code: error.code } : {}),
      });
    }

    for (const item of created) {
      const previousId = String(item.target.job?.external_account_id || "");
      if (!previousId) continue;
      const status = this.accountStatusCheckOutcomes.get(previousId);
      this.accountStatusCheckOutcomes.delete(previousId);
      if (status) {
        this.accountStatusCheckOutcomes.set(String(item.id), {
          ...status,
          external_account_id: String(item.id),
          email: item.email,
        });
      }
    }

    return {
      imported: created.length,
      restored: created.filter((item) => item.target.importSource === "restored").length,
      external_imported: created.filter((item) => item.target.importSource === "external").length,
      items: created.map((item) => ({
        id: item.id,
        email: item.email,
        import_source: item.target.importSource,
        previous_account_id: item.previousAccountId,
        registration_job_id: item.registrationJobId,
      })),
    };
    } finally {
      emails.forEach((email) => this.localAccountImportEmails.delete(email));
    }
  }

  async refreshRegisteredAccountSignals(input = {}, { skipNfapiSync = false } = {}) {
    const ids = normalizeAccountCheckIds(input);
    if (typeof this.client.refreshAccountPlans !== "function") {
      throw Object.assign(new Error("注册账号状态检测服务尚未配置"), { status: 503 });
    }

    let before = await this.listRegisteredAccounts({ refreshUnchecked: false });
    let selected = before.items.filter((item) => ids.includes(Number(item.id)));
    if (selected.length !== ids.length) {
      throw Object.assign(new Error("选择中包含不属于本注册页面的账号"), { status: 409 });
    }
    if (await this.scanRegisteredAccountMailEvidence(selected)) {
      before = await this.listRegisteredAccounts({ refreshUnchecked: false });
      selected = before.items.filter((item) => ids.includes(Number(item.id)));
    }
    const emailById = new Map(selected.map((item) => [Number(item.id), String(item.email || "")]));
    const nfapiSync = skipNfapiSync
      ? { attempted: 0, synced: 0, failed: 0, items: [] }
      : await this.syncLatestNfapiCredentials(selected);
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

    await this.scanRegisteredAccountMailEvidence(selected);
    const accounts = await this.listRegisteredAccounts({ refreshUnchecked: false });
    const selectedAfter = accounts.items.filter((item) => ids.includes(Number(item.id)));
    const accountById = new Map(selectedAfter.map((item) => [Number(item.id), item]));
    const publicResults = preliminaryResults.map((outcome) => {
      const account = accountById.get(Number(outcome.id)) || {};
      const credentialTerminal = CREDENTIAL_EXPIRED_CODES.has(outcome.code)
        || CREDENTIAL_REVOKED_CODES.has(outcome.code);
      const mailPlanOverride = account.mail_plus_confirmed === true
        && account.account_type === "plus"
        && outcome.account_type !== "plus";
      const mailAccountInvalid = account.availability === "unavailable"
        && normalizeCheckCode(account.status_code) === "account_deleted"
        && String(account.status_source || "").toLowerCase() === "mail/account-deletion";
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
      if (mailPlanOverride) {
        merged.subscription_status = "active";
        merged.account_type = "plus";
        merged.account_type_raw = String(account.account_type_raw || "chatgptplusplan");
        merged.type_observed = true;
        merged.detection_status = "confirmed";
        merged.code = String(account.status_code || "subscription_active");
        merged.reason = String(account.status_reason || "检测到与当前 workspace 匹配的 ChatGPT Plus 开通确认邮件");
        merged.retryable = Boolean(account.status_retryable);
        merged.source = "mail/plus-confirmation";
        merged.evidence_path = "mail_messages.account_manage_link+subject+body";
        merged.checked_at = String(account.mail_plus_confirmed_at || outcome.checked_at);
      }
      if (mailAccountInvalid) {
        merged.checked = true;
        merged.detection_status = "confirmed";
        merged.account_status = "deleted";
        merged.credential_status = "revoked";
        merged.code = "account_deleted";
        merged.reason = String(account.status_reason || "对应邮箱收到 OpenAI 账号删除通知，判定账户被封禁");
        merged.retryable = false;
        merged.source = "mail/account-deletion";
        merged.evidence_path = "mail_messages.sender+subject+preview+body";
        merged.checked_at = String(account.status_checked_at || outcome.checked_at);
        merged.error = "";
      }
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
      nfapi_sync: {
        attempted: Math.max(0, Number(nfapiSync?.attempted) || 0),
        synced: Math.max(0, Number(nfapiSync?.synced) || 0),
        failed: Math.max(0, Number(nfapiSync?.failed) || 0),
      },
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
    const email = String(job.email || "").trim().toLowerCase();

    const existing = this.db.prepare(`
      SELECT * FROM registered_account_metadata
      WHERE external_account_id = ? AND email = ? COLLATE NOCASE
    `).get(String(accountId), email);
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
      `).run(String(accountId), email, nextCustomName, nextGroupName, now, now);
    }
    return {
      item: {
        id: accountId,
        email,
        custom_name: nextCustomName,
        group_name: nextGroupName,
      },
    };
  }

  async updateRegisteredAccountGroups(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw Object.assign(new Error("账号分组格式无效"), { status: 400 });
    }
    const ids = normalizeAccountGroupIds(input);
    const groupName = accountMetadataValue(input, "group_name", "分组名称", 40);
    if (groupName === undefined) {
      throw Object.assign(new Error("请填写目标分组"), { status: 400 });
    }

    const placeholders = ids.map(() => "?").join(",");
    const jobs = this.db.prepare(`
      SELECT * FROM registration_jobs
      WHERE external_account_id IN (${placeholders}) AND status = 'completed'
      ORDER BY created_at DESC
    `).all(...ids.map(String));
    const jobByAccountId = new Map();
    for (const job of jobs) {
      if (!jobByAccountId.has(String(job.external_account_id))) {
        jobByAccountId.set(String(job.external_account_id), job);
      }
    }
    if (ids.some((id) => !jobByAccountId.has(String(id)))) {
      throw Object.assign(new Error("选择中包含不属于本注册页面的账号"), { status: 409 });
    }

    const accounts = ids.map((id) => {
      const job = jobByAccountId.get(String(id));
      return { id, email: String(job.email || "").trim().toLowerCase() };
    });

    const existingByAccountId = new Map(this.db.prepare(`
      SELECT * FROM registered_account_metadata
      WHERE external_account_id IN (${placeholders})
    `).all(...ids.map(String)).map((row) => [String(row.external_account_id), row]));
    const now = nowIso();
    const removeMetadata = this.db.prepare(
      "DELETE FROM registered_account_metadata WHERE external_account_id = ?",
    );
    const upsertMetadata = this.db.prepare(`
      INSERT INTO registered_account_metadata
        (external_account_id, email, custom_name, group_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_account_id) DO UPDATE SET
        email = excluded.email,
        custom_name = excluded.custom_name,
        group_name = excluded.group_name,
        updated_at = excluded.updated_at
    `);
    this.db.transaction(() => {
      for (const account of accounts) {
        const existing = existingByAccountId.get(String(account.id));
        const customName = String(existing?.custom_name || "");
        if (!customName && !groupName) {
          removeMetadata.run(String(account.id));
        } else {
          upsertMetadata.run(
            String(account.id),
            account.email,
            customName,
            groupName,
            existing?.created_at || now,
            now,
          );
        }
      }
    })();

    return {
      updated: accounts.length,
      ids,
      group_name: groupName,
      items: accounts.map((account) => ({ ...account, group_name: groupName })),
    };
  }

  persistRegisteredAccountCheckoutCheck({ id, email, checkoutType = "", status, error = "", checkedAt }) {
    const accountId = String(id || "");
    const normalizedEmail = safeRemoteText(email, 320).toLowerCase();
    const normalizedType = new Set(["cs_live", "oaics"]).has(checkoutType) ? checkoutType : "";
    const normalizedStatus = status === "completed" && normalizedType ? "completed" : "failed";
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO registered_account_checkout_checks
        (external_account_id, email, checkout_type, status, error, checked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_account_id) DO UPDATE SET
        email = excluded.email,
        checkout_type = excluded.checkout_type,
        status = excluded.status,
        error = excluded.error,
        checked_at = excluded.checked_at,
        updated_at = excluded.updated_at
    `).run(
      accountId,
      normalizedEmail,
      normalizedType,
      normalizedStatus,
      normalizedStatus === "failed" ? checkoutCheckError(error) : "",
      checkedAt || now,
      now,
      now,
    );
    return {
      id: Number(accountId),
      checkout_status: normalizedStatus,
      checkout_type: normalizedType,
      checkout_error: normalizedStatus === "failed" ? checkoutCheckError(error) : "",
      checkout_checked_at: checkedAt || now,
    };
  }

  async resolveGermanCheckoutProxy() {
    if (typeof this.checkoutProxyResolver === "function") {
      const resolved = String(await this.checkoutProxyResolver() || "").trim();
      if (!resolved) throw Object.assign(new Error("未配置 DE Checkout 代理"), { status: 409 });
      return resolved;
    }
    if (this.checkoutProxyCache.proxy && this.checkoutProxyCache.expiresAt > Date.now()) {
      return this.checkoutProxyCache.proxy;
    }
    if (typeof this.client.inspectProxy !== "function") {
      throw Object.assign(new Error("DE Checkout 代理检测服务不可用"), { status: 503 });
    }
    const proxies = this.getProxyPool();
    if (!proxies.length) {
      throw Object.assign(new Error("代理池为空，请先添加 DE 代理"), { status: 409 });
    }
    const usedSessions = new Set();
    for (const source of proxies) {
      const proxy = materializeProxySession(source, usedSessions);
      try {
        const inspection = await this.client.inspectProxy({ url: proxy, samples: 1, delay_ms: 0 });
        const sample = Array.isArray(inspection?.samples) ? inspection.samples[0] : null;
        if (String(sample?.country_code || "").toUpperCase() !== "DE") continue;
        this.checkoutProxyCache = { proxy, expiresAt: Date.now() + 5 * 60 * 1000 };
        return proxy;
      } catch {
        // Continue until a saved proxy is positively identified as a DE exit.
      }
    }
    throw Object.assign(new Error("代理池中没有检测到 DE 出口，请先添加德国代理"), { status: 409 });
  }

  checkRegisteredAccountCheckout(account, proxy) {
    const accountId = Number(account.id);
    const existing = this.accountCheckoutChecks.get(accountId);
    if (existing) return existing;
    const promise = this.runRegisteredAccountCheckoutCheck(account, proxy)
      .then((checkoutType) => this.persistRegisteredAccountCheckoutCheck({
        id: accountId,
        email: account.email,
        checkoutType,
        status: "completed",
        checkedAt: nowIso(),
      }))
      .catch((error) => {
        if (Number(error?.status) === 429) {
          if (error?.code === "checkout_creation_rate_limited") {
            this.accountCheckoutCooldowns.set(accountId, Date.now() + CHECKOUT_ACCOUNT_COOLDOWN_MS);
          }
          throw error;
        }
        if (Number(error?.status) === 504) {
          throw Object.assign(error, { status: 408 });
        }
        return this.persistRegisteredAccountCheckoutCheck({
          id: accountId,
          email: account.email,
          status: "failed",
          error,
          checkedAt: nowIso(),
        });
      })
      .finally(() => this.accountCheckoutChecks.delete(accountId));
    this.accountCheckoutChecks.set(accountId, promise);
    return promise;
  }

  async runRegisteredAccountCheckoutCheck(account, proxy) {
    const remote = await this.client.getAccount(account.id);
    if (!remote
      || String(remote.platform || "chatgpt").toLowerCase() !== "chatgpt"
      || String(remote.email || "").toLowerCase() !== String(account.email || "").toLowerCase()) {
      throw Object.assign(new Error("注册账号与远端账号不匹配"), { status: 409 });
    }
    const existingCheckoutType = checkoutTypeFromAccount(remote);
    if (existingCheckoutType) {
      this.accountCheckoutCooldowns.delete(Number(account.id));
      return existingCheckoutType;
    }
    const cooldownUntil = Number(this.accountCheckoutCooldowns.get(Number(account.id)) || 0);
    if (cooldownUntil > Date.now()) {
      throw Object.assign(new Error("Checkout 创建限流冷却中，请稍后重试"), {
        status: 429,
        code: "checkout_creation_rate_limited",
        retryAt: new Date(cooldownUntil).toISOString(),
      });
    }
    this.accountCheckoutCooldowns.delete(Number(account.id));
    const accessToken = accessTokenFromAccount(remote);
    if (!accessToken) throw Object.assign(new Error("这个账号尚未获取到 AT"), { status: 409 });
    return this.checkoutProbe({ accessToken, proxy });
  }

  async checkRegisteredAccountCheckouts(input = {}) {
    const ids = normalizeAccountCheckIds(input, 100);
    const before = await this.listRegisteredAccounts({ refreshUnchecked: false });
    const accountById = new Map(before.items.map((item) => [Number(item.id), item]));
    if (ids.some((id) => !accountById.has(id))) {
      throw Object.assign(new Error("选择中包含不属于本注册页面的账号"), { status: 409 });
    }

    const proxy = await this.resolveGermanCheckoutProxy();
    const selected = ids.map((id) => accountById.get(id));
    const items = new Array(selected.length);
    let cursor = 1;
    let globalRateLimited = false;
    const checkOne = async (index) => {
      try {
        items[index] = await this.checkRegisteredAccountCheckout(selected[index], proxy);
      } catch (error) {
        if (Number(error?.status) !== 429) throw error;
        if (error?.code !== "checkout_creation_rate_limited") globalRateLimited = true;
        items[index] = {
          id: Number(selected[index].id),
          checkout_status: "rate_limited",
          checkout_type: "",
          checkout_error: "Checkout 检测触发 HTTP 429 限流，请稍后重试",
          checkout_checked_at: "",
          checkout_retry_at: error?.retryAt || new Date(Date.now() + CHECKOUT_ACCOUNT_COOLDOWN_MS).toISOString(),
        };
      }
    };

    // A single preflight prevents a rate-limited exit from failing an entire selected page.
    await checkOne(0);
    if (!globalRateLimited && selected.length > 1) {
      const workers = Array.from(
        { length: Math.min(CHECKOUT_CHECK_CONCURRENCY, selected.length - 1) },
        async () => {
          while (!globalRateLimited && cursor < selected.length) {
            const index = cursor;
            cursor += 1;
            await checkOne(index);
          }
        },
      );
      await Promise.all(workers);
    }
    for (let index = 0; index < items.length; index += 1) {
      if (items[index]) continue;
      items[index] = {
        id: Number(selected[index].id),
        checkout_status: "skipped",
        checkout_type: "",
        checkout_error: "本批次触发限流，未继续检测",
        checkout_checked_at: "",
      };
    }
    const types = items.reduce((summary, item) => {
      if (item.checkout_type) summary[item.checkout_type] = (summary[item.checkout_type] || 0) + 1;
      return summary;
    }, {});
    return {
      requested: ids.length,
      checked: items.filter((item) => item.checkout_status === "completed").length,
      failed: items.filter((item) => item.checkout_status === "failed").length,
      rate_limited: items.filter((item) => item.checkout_status === "rate_limited").length,
      skipped: items.filter((item) => item.checkout_status === "skipped").length,
      types,
      items,
      accounts: await this.listRegisteredAccounts({ refreshUnchecked: false }),
    };
  }

  persistRegisteredAccountTrialCheck({ id, email, eligible = null, evidence = "", status, error = "", checkedAt }) {
    const accountId = String(id || "");
    const normalizedEmail = safeRemoteText(email, 320).toLowerCase();
    const normalizedEligible = typeof eligible === "boolean" ? eligible : null;
    const normalizedStatus = status === "eligible" && normalizedEligible === true
      ? "eligible"
      : status === "ineligible" && normalizedEligible === false
        ? "ineligible"
        : "failed";
    const normalizedEvidence = normalizedStatus === "failed" ? "" : safeRemoteText(evidence, 120);
    const normalizedError = normalizedStatus === "failed" ? trialCheckError(error) : "";
    const errorMetadata = normalizedStatus === "failed"
      ? trialCheckErrorMetadata(error) : { httpStatus: 0, errorCode: "" };
    const now = nowIso();
    const effectiveCheckedAt = checkedAt || now;
    this.db.prepare(`
      INSERT INTO registered_account_trial_checks
        (external_account_id, email, status, eligible, evidence, error, checked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_account_id) DO UPDATE SET
        email = excluded.email,
        status = excluded.status,
        eligible = excluded.eligible,
        evidence = excluded.evidence,
        error = excluded.error,
        checked_at = excluded.checked_at,
        updated_at = excluded.updated_at
    `).run(
      accountId,
      normalizedEmail,
      normalizedStatus,
      normalizedEligible === null ? null : Number(normalizedEligible),
      normalizedEvidence,
      normalizedError,
      effectiveCheckedAt,
      now,
      now,
    );
    return {
      id: Number(accountId),
      trial_status: normalizedStatus,
      trial_eligible: normalizedEligible,
      trial_evidence: normalizedEvidence,
      trial_error: normalizedError,
      trial_checked_at: effectiveCheckedAt,
      trial_http_status: errorMetadata.httpStatus,
      trial_error_code: errorMetadata.errorCode,
    };
  }

  async resolveJapaneseTrialProxy() {
    if (typeof this.trialProxyResolver === "function") {
      const resolved = String(await this.trialProxyResolver() || "").trim();
      if (!resolved) throw Object.assign(new Error("未配置 JP 资格检测代理"), { status: 409 });
      return resolved;
    }
    if (this.trialProxyCache.proxy && this.trialProxyCache.expiresAt > Date.now()) {
      return this.trialProxyCache.proxy;
    }
    if (typeof this.client.inspectProxy !== "function") {
      throw Object.assign(new Error("JP 资格检测代理服务不可用"), { status: 503 });
    }
    const proxies = this.getProxyPool();
    if (!proxies.length) {
      throw Object.assign(new Error("代理池为空，请先添加日本代理"), { status: 409 });
    }
    const usedSessions = new Set();
    for (const source of proxies) {
      const proxy = materializeProxySession(source, usedSessions);
      try {
        const inspection = await this.client.inspectProxy({ url: proxy, samples: 1, delay_ms: 0 });
        const sample = Array.isArray(inspection?.samples) ? inspection.samples[0] : null;
        if (String(sample?.country_code || "").toUpperCase() !== "JP") continue;
        this.trialProxyCache = { proxy, expiresAt: Date.now() + 5 * 60 * 1000 };
        return proxy;
      } catch {
        // Continue until a saved proxy is positively identified as a JP exit.
      }
    }
    throw Object.assign(new Error("代理池中没有检测到 JP 出口，请先添加日本代理"), { status: 409 });
  }

  checkRegisteredAccountTrial(account, proxy) {
    const accountId = Number(account.id);
    const existing = this.accountTrialChecks.get(accountId);
    if (existing) return existing;
    const promise = this.runRegisteredAccountTrialCheck(account, proxy)
      .then((result) => this.persistRegisteredAccountTrialCheck({
        id: accountId,
        email: account.email,
        eligible: result.eligible,
        evidence: result.evidence,
        status: result.eligible ? "eligible" : "ineligible",
        checkedAt: nowIso(),
      }))
      .catch((error) => {
        if (Number(error?.status) === 429) throw error;
        return this.persistRegisteredAccountTrialCheck({
          id: accountId,
          email: account.email,
          status: "failed",
          error,
          checkedAt: nowIso(),
        });
      })
      .finally(() => this.accountTrialChecks.delete(accountId));
    this.accountTrialChecks.set(accountId, promise);
    return promise;
  }

  async registeredAccountTrialCredential(account) {
    let remote;
    try {
      remote = await this.client.getAccount(account.id);
    } catch (error) {
      if (Number(error?.status || 0) === 404) {
        throw Object.assign(new Error("注册账号不存在"), {
          status: 404,
          code: "registered_account_not_found",
        });
      }
      throw error;
    }
    if (!remote) {
      throw Object.assign(new Error("注册账号不存在"), {
        status: 404,
        code: "registered_account_not_found",
      });
    }
    if (String(remote.platform || "chatgpt").toLowerCase() !== "chatgpt"
      || String(remote.email || "").toLowerCase() !== String(account.email || "").toLowerCase()) {
      throw Object.assign(new Error("注册账号与远端账号不匹配"), {
        status: 409,
        code: "registered_account_mismatch",
      });
    }
    const accessToken = accessTokenFromAccount(remote);
    if (!accessToken) throw Object.assign(new Error("这个账号尚未获取到 AT"), { status: 409 });
    return { remote, accessToken };
  }

  async runRegisteredAccountTrialCheck(account, proxy) {
    const { accessToken } = await this.registeredAccountTrialCredential(account);
    const result = await this.trialProbe({ accessToken, proxy, fastIneligible: true });
    const finalAmountVerdict = result && typeof result === "object"
      && typeof result.eligible === "boolean" && Number.isFinite(result.amountDue)
      && result.eligible === (result.amountDue === 0)
      && String(result.currency || "") === "JPY"
      && String(result.evidence || "") === JP_ZERO_TRIAL_EVIDENCE;
    const fastIneligibleVerdict = result?.eligible === false && result?.amountDue === null
      && String(result.state || "") === "not_eligible"
      && String(result.currency || "") === "JPY"
      && String(result.evidence || "") === JP_FAST_INELIGIBLE_EVIDENCE;
    if (!finalAmountVerdict && !fastIneligibleVerdict) {
      throw Object.assign(new Error("日本 0 元 Checkout 探针返回了无效结果"), { status: 502 });
    }
    return {
      eligible: result.eligible,
      evidence: safeRemoteText(result.evidence, 120),
    };
  }

  registeredAccountTrialStrategy(country) {
    const normalizedCountry = String(country || "").trim().toUpperCase();
    const strategies = {
      JP: ["resolveJapaneseTrialProxy", "checkRegisteredAccountTrial"],
      GB: ["resolveBritishTrialProxy", "checkRegisteredAccountGbTrial"],
      US: ["resolveAmericanTrialProxy", "checkRegisteredAccountUsTrial"],
    };
    const strategy = strategies[normalizedCountry];
    if (!strategy) {
      throw Object.assign(new Error(`暂不支持 ${normalizedCountry || "当前国家"} 的 0 元试用资格预检`), {
        status: 409,
        code: "TRIAL_CHECK_COUNTRY_UNSUPPORTED",
      });
    }
    return { country: normalizedCountry, resolveProxy: strategy[0], checkTrial: strategy[1] };
  }

  async resolveRegisteredAccountTrialRoute(country) {
    const strategy = this.registeredAccountTrialStrategy(country);
    return this[strategy.resolveProxy]();
  }

  async checkRegisteredAccountTrialForCountry(account, country) {
    const strategy = this.registeredAccountTrialStrategy(country);
    const proxy = await this[strategy.resolveProxy]();
    return this[strategy.checkTrial](account, proxy);
  }

  async checkRegisteredAccountTrials(input = {}) {
    const ids = normalizeAccountCheckIds(input, 100);
    const before = await this.listRegisteredAccounts({ refreshUnchecked: false });
    const accountById = new Map(before.items.map((item) => [Number(item.id), item]));
    if (ids.some((id) => !accountById.has(id))) {
      throw Object.assign(new Error("选择中包含不属于本注册页面的账号"), { status: 409 });
    }

    const proxy = await this.resolveJapaneseTrialProxy();
    const selected = ids.map((id) => accountById.get(id));
    const items = new Array(selected.length);
    let cursor = 1;
    let rateLimited = false;
    const checkOne = async (index) => {
      try {
        items[index] = await this.checkRegisteredAccountTrial(selected[index], proxy);
      } catch (error) {
        if (Number(error?.status) !== 429) throw error;
        rateLimited = true;
        items[index] = {
          id: Number(selected[index].id),
          trial_status: "rate_limited",
          trial_eligible: null,
          trial_evidence: "",
          trial_error: "日本 0 元 Checkout 检测触发 HTTP 429 限流，请稍后重试",
          trial_checked_at: "",
        };
      }
    };

    await checkOne(0);
    if (!rateLimited && selected.length > 1) {
      const workers = Array.from(
        { length: Math.min(TRIAL_CHECK_CONCURRENCY, selected.length - 1) },
        async () => {
          while (!rateLimited && cursor < selected.length) {
            const index = cursor;
            cursor += 1;
            await checkOne(index);
          }
        },
      );
      await Promise.all(workers);
    }
    for (let index = 0; index < items.length; index += 1) {
      if (items[index]) continue;
      items[index] = {
        id: Number(selected[index].id),
        trial_status: "skipped",
        trial_eligible: null,
        trial_evidence: "",
        trial_error: "本批次触发限流，未继续检测",
        trial_checked_at: "",
      };
    }
    return {
      requested: ids.length,
      checked: items.filter((item) => new Set(["eligible", "ineligible"]).has(item.trial_status)).length,
      eligible: items.filter((item) => item.trial_status === "eligible").length,
      ineligible: items.filter((item) => item.trial_status === "ineligible").length,
      failed: items.filter((item) => item.trial_status === "failed").length,
      rate_limited: items.filter((item) => item.trial_status === "rate_limited").length,
      skipped: items.filter((item) => item.trial_status === "skipped").length,
      items,
      accounts: await this.listRegisteredAccounts({ refreshUnchecked: false }),
    };
  }

  persistRegisteredAccountGbTrialCheck({ id, email, eligible = null, evidence = "", status, error = "", checkedAt }) {
    const accountId = String(id || "");
    const normalizedEmail = safeRemoteText(email, 320).toLowerCase();
    const normalizedEligible = typeof eligible === "boolean" ? eligible : null;
    const normalizedStatus = status === "eligible" && normalizedEligible === true
      ? "eligible"
      : status === "ineligible" && normalizedEligible === false
        ? "ineligible"
        : "failed";
    const normalizedEvidence = normalizedStatus === "failed" ? "" : safeRemoteText(evidence, 120);
    const normalizedError = normalizedStatus === "failed" ? gbTrialCheckError(error) : "";
    const errorMetadata = normalizedStatus === "failed"
      ? trialCheckErrorMetadata(error) : { httpStatus: 0, errorCode: "" };
    const now = nowIso();
    const effectiveCheckedAt = checkedAt || now;
    this.db.prepare(`
      INSERT INTO registered_account_gb_trial_checks
        (external_account_id, email, status, eligible, evidence, error, checked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_account_id) DO UPDATE SET
        email = excluded.email,
        status = excluded.status,
        eligible = excluded.eligible,
        evidence = excluded.evidence,
        error = excluded.error,
        checked_at = excluded.checked_at,
        updated_at = excluded.updated_at
    `).run(
      accountId,
      normalizedEmail,
      normalizedStatus,
      normalizedEligible === null ? null : Number(normalizedEligible),
      normalizedEvidence,
      normalizedError,
      effectiveCheckedAt,
      now,
      now,
    );
    return {
      id: Number(accountId),
      gb_trial_status: normalizedStatus,
      gb_trial_eligible: normalizedEligible,
      gb_trial_evidence: normalizedEvidence,
      gb_trial_error: normalizedError,
      gb_trial_checked_at: effectiveCheckedAt,
      gb_trial_http_status: errorMetadata.httpStatus,
      gb_trial_error_code: errorMetadata.errorCode,
    };
  }

  async resolveBritishTrialProxy() {
    if (typeof this.gbTrialProxyResolver === "function") {
      const resolved = String(await this.gbTrialProxyResolver() || "").trim();
      if (!resolved) throw Object.assign(new Error("未配置 GB 资格检测代理"), { status: 409 });
      return resolved;
    }
    if (this.gbTrialProxyCache.proxy && this.gbTrialProxyCache.expiresAt > Date.now()) {
      return this.gbTrialProxyCache.proxy;
    }
    if (typeof this.client.inspectProxy !== "function") {
      throw Object.assign(new Error("GB 资格检测代理服务不可用"), { status: 503 });
    }
    const proxies = this.getProxyPool();
    if (!proxies.length) {
      throw Object.assign(new Error("代理池为空，请先添加英国代理"), { status: 409 });
    }
    const usedSessions = new Set();
    for (const source of proxies) {
      const proxy = materializeProxySession(source, usedSessions);
      try {
        const inspection = await this.client.inspectProxy({ url: proxy, samples: 1, delay_ms: 0 });
        const sample = Array.isArray(inspection?.samples) ? inspection.samples[0] : null;
        if (String(sample?.country_code || "").toUpperCase() !== "GB") continue;
        this.gbTrialProxyCache = { proxy, expiresAt: Date.now() + 5 * 60 * 1000 };
        return proxy;
      } catch {
        // Continue until a saved proxy is positively identified as a GB exit.
      }
    }
    throw Object.assign(new Error("代理池中没有检测到 GB 出口，请先添加英国代理"), { status: 409 });
  }

  checkRegisteredAccountGbTrial(account, proxy) {
    const accountId = Number(account.id);
    const existing = this.accountGbTrialChecks.get(accountId);
    if (existing) return existing;
    const promise = this.runRegisteredAccountGbTrialCheck(account, proxy)
      .then((result) => this.persistRegisteredAccountGbTrialCheck({
        id: accountId,
        email: account.email,
        eligible: result.eligible,
        evidence: result.evidence,
        status: result.eligible ? "eligible" : "ineligible",
        checkedAt: nowIso(),
      }))
      .catch((error) => {
        if (Number(error?.status) === 429) throw error;
        return this.persistRegisteredAccountGbTrialCheck({
          id: accountId,
          email: account.email,
          status: "failed",
          error,
          checkedAt: nowIso(),
        });
      })
      .finally(() => this.accountGbTrialChecks.delete(accountId));
    this.accountGbTrialChecks.set(accountId, promise);
    return promise;
  }

  async runRegisteredAccountGbTrialCheck(account, proxy) {
    const { accessToken } = await this.registeredAccountTrialCredential(account);
    const result = await this.gbTrialProbe({ accessToken, proxy, fastIneligible: true });
    const finalAmountVerdict = result && typeof result === "object"
      && typeof result.eligible === "boolean" && Number.isFinite(result.amountDue)
      && result.eligible === (result.amountDue === 0)
      && String(result.currency || "") === "GBP"
      && String(result.evidence || "") === GB_ZERO_TRIAL_EVIDENCE;
    const fastIneligibleVerdict = result?.eligible === false && result?.amountDue === null
      && String(result.state || "") === "not_eligible"
      && String(result.currency || "") === "GBP"
      && String(result.evidence || "") === GB_FAST_INELIGIBLE_EVIDENCE;
    if (!finalAmountVerdict && !fastIneligibleVerdict) {
      throw Object.assign(new Error("英国 0 元 Checkout 探针返回了无效结果"), { status: 502 });
    }
    return {
      eligible: result.eligible,
      evidence: safeRemoteText(result.evidence, 120),
    };
  }

  async checkRegisteredAccountGbTrials(input = {}) {
    const ids = normalizeAccountCheckIds(input, 100);
    const before = await this.listRegisteredAccounts({ refreshUnchecked: false });
    const accountById = new Map(before.items.map((item) => [Number(item.id), item]));
    if (ids.some((id) => !accountById.has(id))) {
      throw Object.assign(new Error("选择中包含不属于本注册页面的账号"), { status: 409 });
    }

    const proxy = await this.resolveBritishTrialProxy();
    const selected = ids.map((id) => accountById.get(id));
    const items = new Array(selected.length);
    let cursor = 1;
    let rateLimited = false;
    const checkOne = async (index) => {
      try {
        items[index] = await this.checkRegisteredAccountGbTrial(selected[index], proxy);
      } catch (error) {
        if (Number(error?.status) !== 429) throw error;
        rateLimited = true;
        items[index] = {
          id: Number(selected[index].id),
          gb_trial_status: "rate_limited",
          gb_trial_eligible: null,
          gb_trial_evidence: "",
          gb_trial_error: "英国 0 元 Checkout 检测触发 HTTP 429 限流，请稍后重试",
          gb_trial_checked_at: "",
        };
      }
    };

    await checkOne(0);
    if (!rateLimited && selected.length > 1) {
      const workers = Array.from(
        { length: Math.min(TRIAL_CHECK_CONCURRENCY, selected.length - 1) },
        async () => {
          while (!rateLimited && cursor < selected.length) {
            const index = cursor;
            cursor += 1;
            await checkOne(index);
          }
        },
      );
      await Promise.all(workers);
    }
    for (let index = 0; index < items.length; index += 1) {
      if (items[index]) continue;
      items[index] = {
        id: Number(selected[index].id),
        gb_trial_status: "skipped",
        gb_trial_eligible: null,
        gb_trial_evidence: "",
        gb_trial_error: "本批次触发限流，未继续检测",
        gb_trial_checked_at: "",
      };
    }
    return {
      requested: ids.length,
      checked: items.filter((item) => new Set(["eligible", "ineligible"]).has(item.gb_trial_status)).length,
      eligible: items.filter((item) => item.gb_trial_status === "eligible").length,
      ineligible: items.filter((item) => item.gb_trial_status === "ineligible").length,
      failed: items.filter((item) => item.gb_trial_status === "failed").length,
      rate_limited: items.filter((item) => item.gb_trial_status === "rate_limited").length,
      skipped: items.filter((item) => item.gb_trial_status === "skipped").length,
      items,
      accounts: await this.listRegisteredAccounts({ refreshUnchecked: false }),
    };
  }

  persistRegisteredAccountUsTrialCheck({ id, email, eligible = null, evidence = "", status, error = "", checkedAt }) {
    const accountId = String(id || "");
    const normalizedEmail = safeRemoteText(email, 320).toLowerCase();
    const normalizedEligible = typeof eligible === "boolean" ? eligible : null;
    const normalizedStatus = status === "eligible" && normalizedEligible === true
      ? "eligible"
      : status === "ineligible" && normalizedEligible === false
        ? "ineligible"
        : "failed";
    const normalizedEvidence = normalizedStatus === "failed" ? "" : safeRemoteText(evidence, 120);
    const normalizedError = normalizedStatus === "failed" ? usTrialCheckError(error) : "";
    const errorMetadata = normalizedStatus === "failed"
      ? trialCheckErrorMetadata(error) : { httpStatus: 0, errorCode: "" };
    const now = nowIso();
    const effectiveCheckedAt = checkedAt || now;
    this.db.prepare(`
      INSERT INTO registered_account_us_trial_checks
        (external_account_id, email, status, eligible, evidence, error, checked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_account_id) DO UPDATE SET
        email = excluded.email,
        status = excluded.status,
        eligible = excluded.eligible,
        evidence = excluded.evidence,
        error = excluded.error,
        checked_at = excluded.checked_at,
        updated_at = excluded.updated_at
    `).run(
      accountId,
      normalizedEmail,
      normalizedStatus,
      normalizedEligible === null ? null : Number(normalizedEligible),
      normalizedEvidence,
      normalizedError,
      effectiveCheckedAt,
      now,
      now,
    );
    return {
      id: Number(accountId),
      us_trial_status: normalizedStatus,
      us_trial_eligible: normalizedEligible,
      us_trial_evidence: normalizedEvidence,
      us_trial_error: normalizedError,
      us_trial_checked_at: effectiveCheckedAt,
      us_trial_http_status: errorMetadata.httpStatus,
      us_trial_error_code: errorMetadata.errorCode,
    };
  }

  async resolveAmericanTrialProxy() {
    if (typeof this.usTrialProxyResolver === "function") {
      const resolved = String(await this.usTrialProxyResolver() || "").trim();
      if (!resolved) throw Object.assign(new Error("未配置 US 资格检测代理"), { status: 409 });
      if (resolved === DIRECT_TRIAL_ROUTE) return this.resolveAmericanDirectTrialRoute();
      return resolved;
    }
    if (this.usTrialProxyCache.proxy && this.usTrialProxyCache.expiresAt > Date.now()) {
      return this.usTrialProxyCache.proxy;
    }
    const proxies = this.getProxyPool();
    if (proxies.length && typeof this.client.inspectProxy === "function") {
      const usedSessions = new Set();
      for (const source of proxies) {
        const proxy = materializeProxySession(source, usedSessions);
        try {
          const inspection = await this.client.inspectProxy({ url: proxy, samples: 1, delay_ms: 0 });
          const sample = Array.isArray(inspection?.samples) ? inspection.samples[0] : null;
          if (String(sample?.country_code || "").toUpperCase() !== "US") continue;
          this.usTrialProxyCache = { proxy, expiresAt: Date.now() + 5 * 60 * 1000 };
          return proxy;
        } catch {
          // Continue until a saved proxy is positively identified as a US exit.
        }
      }
    }
    return this.resolveAmericanDirectTrialRoute();
  }

  async resolveAmericanDirectTrialRoute() {
    let directCountry;
    try {
      const inspection = await this.usDirectCountryProbe();
      directCountry = String(inspection?.countryCode || inspection?.country_code || inspection || "").trim().toUpperCase();
    } catch (error) {
      throw Object.assign(new Error(error?.message || "服务器直连出口检测失败"), { status: 503 });
    }
    if (directCountry !== "US") {
      throw Object.assign(new Error(`服务器直连出口不是 US（当前检测为 ${directCountry || "未知"}）`), { status: 409 });
    }
    this.usTrialProxyCache = { proxy: DIRECT_TRIAL_ROUTE, expiresAt: Date.now() + 5 * 60 * 1000 };
    return DIRECT_TRIAL_ROUTE;
  }

  checkRegisteredAccountUsTrial(account, proxy) {
    const accountId = Number(account.id);
    const existing = this.accountUsTrialChecks.get(accountId);
    if (existing) return existing;
    const promise = this.runRegisteredAccountUsTrialCheck(account, proxy)
      .then((result) => this.persistRegisteredAccountUsTrialCheck({
        id: accountId,
        email: account.email,
        eligible: result.eligible,
        evidence: result.evidence,
        status: result.eligible ? "eligible" : "ineligible",
        checkedAt: nowIso(),
      }))
      .catch((error) => {
        if (Number(error?.status) === 429) throw error;
        return this.persistRegisteredAccountUsTrialCheck({
          id: accountId,
          email: account.email,
          status: "failed",
          error,
          checkedAt: nowIso(),
        });
      })
      .finally(() => this.accountUsTrialChecks.delete(accountId));
    this.accountUsTrialChecks.set(accountId, promise);
    return promise;
  }

  async runRegisteredAccountUsTrialCheck(account, proxy) {
    const { accessToken } = await this.registeredAccountTrialCredential(account);
    const result = await this.usTrialProbe({ accessToken, proxy, fastIneligible: true });
    const finalAmountVerdict = result && typeof result === "object"
      && typeof result.eligible === "boolean" && Number.isFinite(result.amountDue)
      && result.eligible === (result.amountDue === 0)
      && String(result.currency || "") === "USD"
      && String(result.evidence || "") === US_ZERO_TRIAL_EVIDENCE;
    const fastIneligibleVerdict = result?.eligible === false && result?.amountDue === null
      && String(result.state || "") === "not_eligible"
      && String(result.currency || "") === "USD"
      && String(result.evidence || "") === US_FAST_INELIGIBLE_EVIDENCE;
    if (!finalAmountVerdict && !fastIneligibleVerdict) {
      throw Object.assign(new Error("美国 0 元 Checkout 探针返回了无效结果"), { status: 502 });
    }
    return {
      eligible: result.eligible,
      evidence: safeRemoteText(result.evidence, 120),
    };
  }

  async checkRegisteredAccountUsTrials(input = {}) {
    const ids = normalizeAccountCheckIds(input, 100);
    const before = await this.listRegisteredAccounts({ refreshUnchecked: false });
    const accountById = new Map(before.items.map((item) => [Number(item.id), item]));
    if (ids.some((id) => !accountById.has(id))) {
      throw Object.assign(new Error("选择中包含不属于本注册页面的账号"), { status: 409 });
    }

    const proxy = await this.resolveAmericanTrialProxy();
    const selected = ids.map((id) => accountById.get(id));
    const items = new Array(selected.length);
    let cursor = 1;
    let rateLimited = false;
    const checkOne = async (index) => {
      try {
        items[index] = await this.checkRegisteredAccountUsTrial(selected[index], proxy);
      } catch (error) {
        if (Number(error?.status) !== 429) throw error;
        rateLimited = true;
        items[index] = {
          id: Number(selected[index].id),
          us_trial_status: "rate_limited",
          us_trial_eligible: null,
          us_trial_evidence: "",
          us_trial_error: "美国 0 元 Checkout 检测触发 HTTP 429 限流，请稍后重试",
          us_trial_checked_at: "",
        };
      }
    };

    await checkOne(0);
    if (!rateLimited && selected.length > 1) {
      const workers = Array.from(
        { length: Math.min(TRIAL_CHECK_CONCURRENCY, selected.length - 1) },
        async () => {
          while (!rateLimited && cursor < selected.length) {
            const index = cursor;
            cursor += 1;
            await checkOne(index);
          }
        },
      );
      await Promise.all(workers);
    }
    for (let index = 0; index < items.length; index += 1) {
      if (items[index]) continue;
      items[index] = {
        id: Number(selected[index].id),
        us_trial_status: "skipped",
        us_trial_eligible: null,
        us_trial_evidence: "",
        us_trial_error: "本批次触发限流，未继续检测",
        us_trial_checked_at: "",
      };
    }
    return {
      requested: ids.length,
      checked: items.filter((item) => new Set(["eligible", "ineligible"]).has(item.us_trial_status)).length,
      eligible: items.filter((item) => item.us_trial_status === "eligible").length,
      ineligible: items.filter((item) => item.us_trial_status === "ineligible").length,
      failed: items.filter((item) => item.us_trial_status === "failed").length,
      rate_limited: items.filter((item) => item.us_trial_status === "rate_limited").length,
      skipped: items.filter((item) => item.us_trial_status === "skipped").length,
      items,
      accounts: await this.listRegisteredAccounts({ refreshUnchecked: false }),
    };
  }

  persistRegisteredAccountMomoCheck({ id, email, eligible = null, methods = [], evidence = "", status, error = "", checkedAt }) {
    const accountId = String(id || "");
    const normalizedEmail = safeRemoteText(email, 320).toLowerCase();
    const normalizedEligible = typeof eligible === "boolean" ? eligible : null;
    const normalizedStatus = status === "eligible" && normalizedEligible === true
      ? "eligible"
      : status === "ineligible" && normalizedEligible === false
        ? "ineligible"
        : "failed";
    const normalizedMethods = [...new Set((Array.isArray(methods) ? methods : [])
      .map((method) => String(method || "").trim().toLowerCase())
      .filter((method) => /^[a-z0-9_]{1,80}$/.test(method)))];
    const normalizedEvidence = normalizedStatus === "failed" ? "" : safeRemoteText(evidence, 120);
    const normalizedError = normalizedStatus === "failed" ? momoCheckError(error) : "";
    const now = nowIso();
    const effectiveCheckedAt = checkedAt || now;
    this.db.prepare(`
      INSERT INTO registered_account_momo_checks
        (external_account_id, email, status, eligible, methods, evidence, error, checked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_account_id) DO UPDATE SET
        email = excluded.email,
        status = excluded.status,
        eligible = excluded.eligible,
        methods = excluded.methods,
        evidence = excluded.evidence,
        error = excluded.error,
        checked_at = excluded.checked_at,
        updated_at = excluded.updated_at
    `).run(
      accountId,
      normalizedEmail,
      normalizedStatus,
      normalizedEligible === null ? null : Number(normalizedEligible),
      JSON.stringify(normalizedMethods),
      normalizedEvidence,
      normalizedError,
      effectiveCheckedAt,
      now,
      now,
    );
    return {
      id: Number(accountId),
      momo_status: normalizedStatus,
      momo_eligible: normalizedEligible,
      momo_methods: normalizedMethods,
      momo_evidence: normalizedEvidence,
      momo_error: normalizedError,
      momo_checked_at: effectiveCheckedAt,
    };
  }

  async resolveVietnameseMomoProxy() {
    if (typeof this.momoProxyResolver === "function") {
      const resolved = String(await this.momoProxyResolver() || "").trim();
      if (!resolved) throw Object.assign(new Error("未配置 VN MoMo 检测代理"), { status: 409 });
      return resolved;
    }
    if (this.momoProxyCache.proxy && this.momoProxyCache.expiresAt > Date.now()) {
      return this.momoProxyCache.proxy;
    }
    if (typeof this.client.inspectProxy !== "function") {
      throw Object.assign(new Error("VN MoMo 检测代理服务不可用"), { status: 503 });
    }
    const proxies = this.getProxyPool();
    if (!proxies.length) {
      throw Object.assign(new Error("代理池为空，请先添加越南代理"), { status: 409 });
    }
    const usedSessions = new Set();
    for (const source of proxies) {
      const proxy = materializeProxySession(source, usedSessions);
      try {
        const inspection = await this.client.inspectProxy({ url: proxy, samples: 1, delay_ms: 0 });
        const sample = Array.isArray(inspection?.samples) ? inspection.samples[0] : null;
        if (String(sample?.country_code || "").toUpperCase() !== "VN") continue;
        this.momoProxyCache = { proxy, expiresAt: Date.now() + 5 * 60 * 1000 };
        return proxy;
      } catch {
        // Continue until a saved proxy is positively identified as a VN exit.
      }
    }
    throw Object.assign(new Error("代理池中没有检测到 VN 出口，请先添加越南代理"), { status: 409 });
  }

  checkRegisteredAccountMomo(account, proxy) {
    const accountId = Number(account.id);
    const existing = this.accountMomoChecks.get(accountId);
    if (existing) return existing;
    const promise = this.runRegisteredAccountMomoCheck(account, proxy)
      .then((result) => this.persistRegisteredAccountMomoCheck({
        id: accountId,
        email: account.email,
        eligible: result.eligible,
        methods: result.methods,
        evidence: result.evidence,
        status: result.eligible ? "eligible" : "ineligible",
        checkedAt: nowIso(),
      }))
      .catch((error) => {
        if (Number(error?.status) === 429) throw error;
        return this.persistRegisteredAccountMomoCheck({
          id: accountId,
          email: account.email,
          status: "failed",
          error,
          checkedAt: nowIso(),
        });
      })
      .finally(() => this.accountMomoChecks.delete(accountId));
    this.accountMomoChecks.set(accountId, promise);
    return promise;
  }

  async runRegisteredAccountMomoCheck(account, proxy) {
    const remote = await this.client.getAccount(account.id);
    if (!remote
      || String(remote.platform || "chatgpt").toLowerCase() !== "chatgpt"
      || String(remote.email || "").toLowerCase() !== String(account.email || "").toLowerCase()) {
      throw Object.assign(new Error("注册账号与远端账号不匹配"), { status: 409 });
    }
    const accessToken = accessTokenFromAccount(remote);
    if (!accessToken) throw Object.assign(new Error("这个账号尚未获取到 AT"), { status: 409 });
    const result = await this.momoProbe({ accessToken, proxy });
    if (!result || typeof result !== "object" || typeof result.eligible !== "boolean"
      || !Array.isArray(result.methods) || !result.methods.length) {
      throw Object.assign(new Error("MoMo 资格探针返回了无效结果"), { status: 502 });
    }
    return {
      eligible: result.eligible,
      methods: result.methods,
      evidence: safeRemoteText(result.evidence, 120),
    };
  }

  async checkRegisteredAccountMomoEligibility(input = {}) {
    const ids = normalizeAccountCheckIds(input, 100);
    const before = await this.listRegisteredAccounts({ refreshUnchecked: false });
    const accountById = new Map(before.items.map((item) => [Number(item.id), item]));
    if (ids.some((id) => !accountById.has(id))) {
      throw Object.assign(new Error("选择中包含不属于本注册页面的账号"), { status: 409 });
    }

    const proxy = await this.resolveVietnameseMomoProxy();
    const selected = ids.map((id) => accountById.get(id));
    const items = new Array(selected.length);
    let cursor = 1;
    let rateLimited = false;
    const checkOne = async (index) => {
      try {
        items[index] = await this.checkRegisteredAccountMomo(selected[index], proxy);
      } catch (error) {
        if (Number(error?.status) !== 429) throw error;
        rateLimited = true;
        items[index] = {
          id: Number(selected[index].id),
          momo_status: "rate_limited",
          momo_eligible: null,
          momo_methods: [],
          momo_evidence: "",
          momo_error: "MoMo 资格检测触发 HTTP 429 限流，请稍后重试",
          momo_checked_at: "",
        };
      }
    };

    await checkOne(0);
    if (!rateLimited && selected.length > 1) {
      const workers = Array.from(
        { length: Math.min(MOMO_CHECK_CONCURRENCY, selected.length - 1) },
        async () => {
          while (!rateLimited && cursor < selected.length) {
            const index = cursor;
            cursor += 1;
            await checkOne(index);
          }
        },
      );
      await Promise.all(workers);
    }
    for (let index = 0; index < items.length; index += 1) {
      if (items[index]) continue;
      items[index] = {
        id: Number(selected[index].id),
        momo_status: "skipped",
        momo_eligible: null,
        momo_methods: [],
        momo_evidence: "",
        momo_error: "本批次触发限流，未继续检测",
        momo_checked_at: "",
      };
    }
    return {
      requested: ids.length,
      checked: items.filter((item) => new Set(["eligible", "ineligible"]).has(item.momo_status)).length,
      eligible: items.filter((item) => item.momo_status === "eligible").length,
      ineligible: items.filter((item) => item.momo_status === "ineligible").length,
      failed: items.filter((item) => item.momo_status === "failed").length,
      rate_limited: items.filter((item) => item.momo_status === "rate_limited").length,
      skipped: items.filter((item) => item.momo_status === "skipped").length,
      items,
      accounts: await this.listRegisteredAccounts({ refreshUnchecked: false }),
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

  async registeredAccountRefreshToken(id) {
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
    const refreshToken = refreshTokenFromAccount(account);
    if (!refreshToken) throw Object.assign(new Error("这个账号尚未获取到 Refresh Token"), { status: 404 });
    return { id: accountId, email: account.email, refresh_token: refreshToken };
  }

  async registeredAccountSub2Export(id) {
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
    const refreshToken = refreshTokenFromAccount(account);
    if (!accessToken) throw Object.assign(new Error("这个账号尚未获取到 AT"), { status: 404 });
    if (!refreshToken) throw Object.assign(new Error("这个账号尚未获取到 Refresh Token"), { status: 404 });
    const credentials = {
      email: String(account.email || "").trim().toLowerCase(),
      access_token: accessToken,
      refresh_token: refreshToken,
    };
    for (const [target, keys] of [
      ["id_token", ["id_token", "idToken"]],
      ["client_id", ["client_id", "clientId", "oauth_client_id"]],
      ["chatgpt_account_id", ["chatgpt_account_id", "account_id", "workspace_id"]],
      ["chatgpt_user_id", ["chatgpt_user_id", "user_id"]],
      ["organization_id", ["organization_id"]],
      ["expires_at", ["expires_at"]],
      ["plan_type", ["plan_type"]],
      ["subscription_expires_at", ["subscription_expires_at"]],
    ]) {
      const value = accountCredential(account, keys);
      if (value) credentials[target] = value;
    }
    if (!credentials.chatgpt_account_id && account.user_id) {
      credentials.chatgpt_account_id = String(account.user_id);
    }
    if (!credentials.plan_type && (account.plan_name || account.plan_state)) {
      credentials.plan_type = String(account.plan_name || account.plan_state);
    }
    return { id: accountId, email: credentials.email, credentials };
  }

  refreshRegisteredAccountAccessToken(id, input = {}) {
    const accountId = positiveAccountId(id);
    const existing = this.accountAccessTokenRefreshes.get(accountId);
    if (existing) return existing;
    const promise = this.runRegisteredAccountAccessTokenRefresh(accountId, input)
      .finally(() => this.accountAccessTokenRefreshes.delete(accountId));
    this.accountAccessTokenRefreshes.set(accountId, promise);
    return promise;
  }

  async runRegisteredAccountAccessTokenRefresh(accountId, input = {}) {
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

    const terminalRefreshError = (failure, evidencePath) => {
      const observedAt = nowIso();
      const previous = this.accountStatusCheckOutcomes.get(String(accountId));
      const previousMatches = previous
        && String(previous.email || "").toLowerCase() === String(account.email || "").toLowerCase();
      const signals = accountStatusSignals(account, previousMatches ? previous : null);
      this.persistAccountStatusOutcome({
        external_account_id: String(accountId),
        email: String(account.email || job.email).toLowerCase(),
        detection_status: "confirmed",
        account_status: failure.accountStatus,
        credential_status: "revoked",
        subscription_status: signals.subscription_status,
        account_type: signals.account_type,
        account_type_raw: signals.account_type_raw,
        code: failure.code,
        reason: failure.reason,
        retryable: false,
        source: "registration-refresh",
        http_status: 0,
        evidence_path: evidencePath,
        checked_at: observedAt,
        attempted_at: observedAt,
      });
      return Object.assign(new Error(failure.reason), {
        status: 409,
        code: failure.code.toUpperCase(),
      });
    };

    const proxy = this.registeredAccountRefreshProxy(job, input?.proxy_selection);
    try {
      await this.client.upsertOutlookEmailProviderSetting({
        apiUrl: this.mailboxBaseUrl,
        apiKey: this.connectorKey,
      });
    } catch {
      throw Object.assign(new Error("邮箱连接配置同步失败"), { status: 502 });
    }
    const actionParams = { browser_mode: "camoufox_headless" };
    if (proxy) actionParams.proxy = proxy;

    let task;
    try {
      task = await this.client.createAccountAction(accountId, "refresh_access_token", actionParams);
    } catch (error) {
      const terminalFailure = accessTokenRefreshTerminalFailure(error);
      if (terminalFailure) throw terminalRefreshError(terminalFailure, "refresh_access_token/create_error");
      throw Object.assign(new Error("AT 刷新任务创建失败"), { status: 502 });
    }
    const started = assertAccessTokenRefreshTask(task);
    const deadline = Date.now() + 240_000;
    let current = task;
    let state = started;
    while (!TERMINAL_STATUSES.has(state.status)) {
      if (Date.now() >= deadline) {
        try {
          await this.client.cancelActionTask(started.taskId);
        } catch {
          // Preserve the timeout result even if remote cancellation cannot be confirmed.
        }
        throw Object.assign(new Error("AT 刷新超时，请稍后重试"), { status: 504 });
      }
      await wait(500);
      try {
        current = await this.client.getActionTask(started.taskId);
      } catch {
        throw Object.assign(new Error("AT 刷新任务状态读取失败"), { status: 502 });
      }
      state = assertAccessTokenRefreshTask(current, started.taskId);
    }
    if (state.status !== "completed") {
      let terminalFailure = accessTokenRefreshTerminalFailure(current);
      if (!terminalFailure && typeof this.client.getActionTaskEvents === "function") {
        try {
          const eventResponse = await this.client.getActionTaskEvents(started.taskId);
          terminalFailure = accessTokenRefreshTerminalFailure(eventResponse);
        } catch {
          // The task result remains sufficient for the generic failure path below.
        }
      }
      if (terminalFailure) {
        throw terminalRefreshError(terminalFailure, "refresh_access_token/task_error");
      }
      const taskError = String(current?.error || "").toLowerCase();
      const message = taskError.includes("session 未返回 accesstoken")
        ? "邮箱验证码已通过，但 ChatGPT 登录回调未完成，暂时没有生成新的 AT"
        : "AT 刷新失败；网页登录 Session 可能已失效";
      throw Object.assign(new Error(message), {
        status: 409,
        code: "WEB_SESSION_REFRESH_FAILED",
      });
    }

    const refreshedAccount = await this.client.getAccount(accountId);
    const refreshedTerminalFailure = accessTokenRefreshTerminalFailure(refreshedAccount);
    if (refreshedTerminalFailure) {
      throw terminalRefreshError(refreshedTerminalFailure, "refresh_access_token/account_state");
    }
    if (!refreshedAccount
      || String(refreshedAccount.email || "").toLowerCase() !== String(job.email || "").toLowerCase()
      || !accessTokenFromAccount(refreshedAccount)) {
      throw Object.assign(new Error("AT 刷新任务完成，但账号未保存有效 AT"), { status: 502 });
    }
    const result = await this.refreshRegisteredAccountSignals(
      { ids: [accountId] },
      { skipNfapiSync: true },
    );
    return { ...result, access_token_refreshed: true };
  }

  cleanupRegisteredAccountArtifacts(accountId) {
    const id = String(accountId);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM registered_account_metadata WHERE external_account_id = ?").run(id);
      this.db.prepare("DELETE FROM registered_account_checkout_checks WHERE external_account_id = ?").run(id);
      this.db.prepare("DELETE FROM registered_account_trial_checks WHERE external_account_id = ?").run(id);
      this.db.prepare("DELETE FROM registered_account_gb_trial_checks WHERE external_account_id = ?").run(id);
      this.db.prepare("DELETE FROM registered_account_us_trial_checks WHERE external_account_id = ?").run(id);
      this.db.prepare("DELETE FROM registered_account_momo_checks WHERE external_account_id = ?").run(id);
      this.db.prepare("DELETE FROM registered_account_payment_links WHERE external_account_id = ?").run(id);
      this.db.prepare("DELETE FROM registered_account_nfapi_links WHERE external_account_id = ?").run(id);
    })();
  }

  pipelineRegisteredAccountProtection(accountId, email, remoteAccount = null) {
    const id = String(accountId || "").trim();
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const protectedAttempt = this.db.prepare(`
      SELECT 1
      FROM mailcom_registration_pipeline_attempts
      WHERE external_account_id = ? AND email = ? COLLATE NOCASE
        AND (
          (outcome = 'link_blocked' AND stage <> 'link_blocked_released')
          OR link_status = 'succeeded'
          OR agreement_status IN ('succeeded', 'uncertain')
        )
      LIMIT 1
    `).get(id, normalizedEmail);
    if (protectedAttempt) return "blocked、已提链或协议受保护账号";

    const persisted = this.db.prepare(`
      SELECT * FROM registered_account_status_checks
      WHERE external_account_id = ? OR email = ? COLLATE NOCASE
      ORDER BY external_account_id = ? DESC, updated_at DESC
      LIMIT 1
    `).get(id, normalizedEmail, id);
    const persistedPlus = String(persisted?.account_type || "").toLowerCase() === "plus"
      || String(persisted?.account_type_raw || "").toLowerCase().includes("plus")
      || new Set(["active", "subscribed"])
        .has(String(persisted?.subscription_status || "").toLowerCase());
    if (persistedPlus) return "Plus 账号";

    if (remoteAccount) {
      const signals = accountStatusSignals(remoteAccount, persisted || null);
      const remotePlus = signals.account_type === "plus"
        || new Set(["active", "subscribed"]).has(String(signals.subscription_status || "").toLowerCase());
      if (remotePlus) return "远端确认的 Plus 账号";
    }
    return "";
  }

  assertPipelineRegisteredAccountDeletable(accountId, email, remoteAccount = null) {
    const protection = this.pipelineRegisteredAccountProtection(accountId, email, remoteAccount);
    if (!protection) return;
    throw Object.assign(new Error(`${protection}禁止流水线自动删除`), {
      status: 409,
      code: "PIPELINE_REGISTERED_ACCOUNT_PROTECTED",
    });
  }

  async deleteRegisteredAccountForPipeline(input = {}) {
    const id = Number(input.id);
    const registrationJobId = Number(input.registrationJobId);
    const expectedEmail = String(input.email || "").trim().toLowerCase();
    if (!Number.isSafeInteger(id) || id <= 0
      || !Number.isSafeInteger(registrationJobId) || registrationJobId <= 0 || !expectedEmail) {
      throw Object.assign(new Error("流水线注册账号删除参数无效"), { status: 400 });
    }
    const job = this.db.prepare(`
      SELECT * FROM registration_jobs
      WHERE id = ? AND external_account_id = ? AND status = 'completed' AND email = ? COLLATE NOCASE
      LIMIT 1
    `).get(registrationJobId, String(id), expectedEmail);
    if (!job) {
      throw Object.assign(new Error("注册账号与流水线记录不匹配，拒绝删除"), {
        status: 409,
        code: "PIPELINE_REGISTERED_ACCOUNT_MISMATCH",
      });
    }
    this.assertPipelineRegisteredAccountDeletable(id, expectedEmail);

    let releasePaymentReservation = () => {};
    if (this.paymentLinks?.reserveForAccountDeletion) {
      releasePaymentReservation = this.paymentLinks.reserveForAccountDeletion([id]);
    } else {
      const activePaymentLink = this.db.prepare(`
        SELECT external_account_id FROM registered_account_payment_links
        WHERE external_account_id = ? AND status IN ('queued', 'running', 'cancel_requested')
        LIMIT 1
      `).get(String(id));
      if (activePaymentLink) {
        throw Object.assign(new Error(`账号 #${id} 正在提链，请等待任务结束`), { status: 409 });
      }
    }

    try {
      let account = null;
      let alreadyAbsent = false;
      try {
        account = await this.client.getAccount(id);
        if (!account) alreadyAbsent = true;
      } catch (error) {
        if (Number(error?.status || 0) === 404) alreadyAbsent = true;
        else throw error;
      }
      if (account) {
        if (String(account.platform || "chatgpt").toLowerCase() !== "chatgpt"
          || String(account.email || "").trim().toLowerCase() !== expectedEmail) {
          throw Object.assign(new Error(`账号 #${id} 与流水线注册记录不匹配，拒绝删除`), {
            status: 409,
            code: "PIPELINE_REGISTERED_ACCOUNT_MISMATCH",
          });
        }
        // Re-check after the awaited remote read and immediately before the
        // destructive call.  A concurrent status refresh may have identified
        // this account as Plus/blocked while deletion was waiting on I/O.
        this.assertPipelineRegisteredAccountDeletable(id, expectedEmail, account);
        try {
          await this.client.deleteAccount(id);
        } catch (error) {
          if (Number(error?.status || 0) === 404) alreadyAbsent = true;
          else throw error;
        }
      }
      this.cleanupRegisteredAccountArtifacts(id);
      return {
        id,
        email: expectedEmail,
        deleted: !alreadyAbsent,
        already_absent: alreadyAbsent,
      };
    } finally {
      releasePaymentReservation();
    }
  }

  async deleteRegisteredAccounts(input = {}) {
    const ids = normalizeSelectedIds(input, "注册账号");
    let releasePaymentReservations = () => {};
    if (this.paymentLinks?.reserveForAccountDeletion) {
      releasePaymentReservations = this.paymentLinks.reserveForAccountDeletion(ids);
    } else {
      for (let offset = 0; offset < ids.length; offset += ACCOUNT_DELETE_SQL_BATCH_SIZE) {
        const batch = ids.slice(offset, offset + ACCOUNT_DELETE_SQL_BATCH_SIZE).map(String);
        const placeholders = batch.map(() => "?").join(",");
        const activePaymentLink = this.db.prepare(`
          SELECT external_account_id FROM registered_account_payment_links
          WHERE external_account_id IN (${placeholders})
            AND status IN ('queued', 'running', 'cancel_requested')
          LIMIT 1
        `).get(...batch);
        if (activePaymentLink) {
          throw Object.assign(new Error(`账号 #${activePaymentLink.external_account_id} 正在提链，请等待任务结束`), { status: 409 });
        }
      }
    }
    try {
    const jobByAccountId = new Map();
    for (let offset = 0; offset < ids.length; offset += ACCOUNT_DELETE_SQL_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + ACCOUNT_DELETE_SQL_BATCH_SIZE).map(String);
      const placeholders = batch.map(() => "?").join(",");
      const jobs = this.db.prepare(`
        SELECT * FROM registration_jobs
        WHERE external_account_id IN (${placeholders}) AND status = 'completed'
        ORDER BY created_at DESC
      `).all(...batch);
      jobs.forEach((job) => {
        if (!jobByAccountId.has(String(job.external_account_id))) {
          jobByAccountId.set(String(job.external_account_id), job);
        }
      });
    }
    if (ids.some((id) => !jobByAccountId.has(String(id)))) {
      throw Object.assign(new Error("选择中包含不属于本注册页面的账号"), { status: 409 });
    }

    const accounts = [];
    for (let offset = 0; offset < ids.length; offset += ACCOUNT_DELETE_LOOKUP_CONCURRENCY) {
      const batch = ids.slice(offset, offset + ACCOUNT_DELETE_LOOKUP_CONCURRENCY);
      accounts.push(...await Promise.all(batch.map(async (id) => {
        const account = await this.client.getAccount(id);
        if (!account) throw Object.assign(new Error(`账号 #${id} 已不存在`), { status: 404 });
        const job = jobByAccountId.get(String(id));
        if (String(account.platform || "chatgpt").toLowerCase() !== "chatgpt"
          || String(account.email || "").toLowerCase() !== String(job.email || "").toLowerCase()) {
          throw Object.assign(new Error(`账号 #${id} 与注册记录不匹配`), { status: 409 });
        }
        return { id, email: account.email };
      })));
    }

    const settled = [];
    for (let offset = 0; offset < accounts.length; offset += ACCOUNT_DELETE_REQUEST_CONCURRENCY) {
      const batch = accounts.slice(offset, offset + ACCOUNT_DELETE_REQUEST_CONCURRENCY);
      settled.push(...await Promise.allSettled(batch.map((account) => this.client.deleteAccount(account.id))));
    }
    const failed = [];
    const deletedIds = [];
    const deletedAccounts = [];
    let deleted = 0;
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        deleted += 1;
        deletedIds.push(String(accounts[index].id));
        deletedAccounts.push({
          id: Number(accounts[index].id),
          email: String(accounts[index].email || "").trim().toLowerCase(),
        });
      }
      else failed.push({ id: accounts[index].id, error: result.reason?.message || String(result.reason || "删除失败") });
    });
    if (deletedIds.length) {
      this.db.transaction(() => {
        for (let offset = 0; offset < deletedIds.length; offset += ACCOUNT_DELETE_SQL_BATCH_SIZE) {
          const batch = deletedIds.slice(offset, offset + ACCOUNT_DELETE_SQL_BATCH_SIZE);
          const placeholders = batch.map(() => "?").join(",");
          this.db.prepare(`DELETE FROM registered_account_metadata WHERE external_account_id IN (${placeholders})`).run(...batch);
          this.db.prepare(`DELETE FROM registered_account_checkout_checks WHERE external_account_id IN (${placeholders})`).run(...batch);
          this.db.prepare(`DELETE FROM registered_account_trial_checks WHERE external_account_id IN (${placeholders})`).run(...batch);
          this.db.prepare(`DELETE FROM registered_account_gb_trial_checks WHERE external_account_id IN (${placeholders})`).run(...batch);
          this.db.prepare(`DELETE FROM registered_account_us_trial_checks WHERE external_account_id IN (${placeholders})`).run(...batch);
          this.db.prepare(`DELETE FROM registered_account_momo_checks WHERE external_account_id IN (${placeholders})`).run(...batch);
          this.db.prepare(`DELETE FROM registered_account_payment_links WHERE external_account_id IN (${placeholders})`).run(...batch);
          this.db.prepare(`DELETE FROM registered_account_nfapi_links WHERE external_account_id IN (${placeholders})`).run(...batch);
        }
      })();
    }
    return {
      requested: ids.length,
      deleted,
      deleted_ids: deletedIds.map(Number),
      deleted_accounts: deletedAccounts,
      failed,
    };
    } finally {
      releasePaymentReservations();
    }
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

  async scanRegisteredAccountMailEvidence(accounts = []) {
    const candidates = accounts.filter((item) => (
      Number.isSafeInteger(Number(item?.id)) && String(item?.email || "").trim()
    ));
    if (!candidates.length) return false;

    const ids = candidates.map((item) => Number(item.id));
    const emailById = new Map(candidates.map((item) => [
      Number(item.id), String(item.email || "").toLowerCase(),
    ]));
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT source_accounts.*, registration_jobs.external_account_id, registration_jobs.email AS job_email
      FROM registration_jobs
      JOIN source_accounts ON source_accounts.id = registration_jobs.account_id
      WHERE registration_jobs.external_account_id IN (${placeholders})
        AND registration_jobs.status = 'completed'
        AND source_accounts.status = 'connected'
      ORDER BY registration_jobs.created_at DESC, registration_jobs.id DESC
    `).all(...ids.map(String));
    const sourceById = new Map();
    for (const row of rows) {
      const accountId = Number(row.external_account_id);
      if (String(row.job_email || "").toLowerCase() !== emailById.get(accountId)) continue;
      if (!sourceById.has(Number(row.id))) sourceById.set(Number(row.id), row);
    }

    const sources = [...sourceById.values()];
    const sourcesToScan = sources.filter((account) => ["icloud", "mailcom", "netease", "inbox_link"]
      .includes(String(account.provider || "").toLowerCase()));
    for (let offset = 0; offset < sourcesToScan.length; offset += 8) {
      await Promise.allSettled(sourcesToScan.slice(offset, offset + 8).map((account) => this.scanAccount(account)));
    }
    const deletionEvidence = accountDeletionMailEvidenceByEmail(
      this.db,
      sources.map((item) => Number(item.id)),
      [...emailById.values()],
    );
    const accountIdByEmail = new Map([...emailById.entries()].map(([id, email]) => [email, id]));
    for (const [email, message] of deletionEvidence) {
      const accountId = accountIdByEmail.get(email);
      if (!accountId) continue;
      const checkedAt = nowIso();
      this.persistAccountStatusOutcome({
        external_account_id: String(accountId),
        email,
        detection_status: "confirmed",
        account_status: "deleted",
        credential_status: "revoked",
        subscription_status: "unknown",
        account_type: "unknown",
        account_type_raw: "",
        code: "account_deleted",
        reason: "对应邮箱收到 OpenAI 账号删除通知，判定账户被封禁",
        retryable: false,
        source: "mail/account-deletion",
        http_status: 0,
        evidence_path: "mail_messages.sender+subject+preview+body",
        checked_at: checkedAt,
        attempted_at: nowIso(),
      });
    }
    return sources.length > 0;
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
        source_accounts.last_inbox_scan_at, source_accounts.provider AS source_provider
      FROM addresses JOIN source_accounts ON source_accounts.id = addresses.account_id
      WHERE addresses.address = ? COLLATE NOCASE
      ORDER BY CASE WHEN source_accounts.provider = 'inbox_link' THEN 0 ELSE 1 END,
        addresses.id DESC
      LIMIT 1
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
        body_content_type, verification_code
      FROM mail_messages WHERE ${conditions.join(" AND ")}
      ORDER BY received_at DESC LIMIT ?
    `).all(...params, top).map((item) => {
      const storedContentType = String(item.body_content_type || "text").toLowerCase();
      const bodyContentType = storedContentType === "html"
        || /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(String(item.body || ""))
        ? "html"
        : "text";
      return { ...item, body_content_type: bodyContentType, folder: "inbox", text: item.body || item.preview };
    });
    return { success: true, emails };
  }
}
