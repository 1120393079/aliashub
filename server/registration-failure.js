import { redactProxySecrets } from "./registration-proxy.js";

export const OCCUPIED_ALIAS_FAILURE_REASON = "user_already_exists";
export const ACCOUNT_CREATION_POLICY_BLOCKED_REASON = "account_creation_policy_blocked";

const EMAIL_UNAVAILABLE_MESSAGE = "目标站已存在此邮箱账号，建议更换基础地址";
const ACCOUNT_CREATION_POLICY_BLOCKED_MESSAGE = "目标站按注册策略拒绝创建账号，请更换网络出口或邮箱后重试";
const OCCUPIED_ALIAS_SAMPLE_LIMIT = 20;
const OCCUPIED_ALIAS_ERROR_CODES = new Set([
  "user_exists",
  "account_already_exists",
  "email_already_exists",
  "email_already_registered",
  "email_already_registered_on_openai",
  "email_already_used",
  "email_in_use",
  "email_taken",
]);
const ACCOUNT_CREATION_POLICY_ERROR_CODES = new Set([
  "registration_disallowed",
  "signup_disallowed",
  "signup_not_allowed",
  "registration_not_allowed",
  "registration_blocked",
  "account_creation_not_allowed",
  "account_creation_blocked",
  "account_creation_policy_blocked",
  "policy_violation",
  "terms_of_use",
  "terms_of_use_violation",
]);
const POLICY_BLOCKED_TEXT_PATTERNS = [
  /\b(?:registration_disallowed|signup_disallowed|signup_not_allowed|registration_not_allowed|registration_blocked|account_creation_not_allowed|account_creation_blocked|account_creation_policy_blocked|policy_violation|terms_of_use_violation)\b/i,
  /\b(?:cannot|can't|unable to|not allowed to)\s+create\s+(?:(?:your|an?|this)\s+)?account\b/i,
  /(?:利用規約|サービス規約|ポリシー).{0,80}アカウント.{0,40}(?:作成できません|作成することができません|作成不可)/i,
  /(?:无法|不能|不允许).{0,30}(?:创建|建立).{0,20}(?:账户|帐号|账号)/i,
  /(?:条款|政策|策略).{0,50}(?:拒绝|禁止|不允许|无法|不能).{0,30}(?:创建|注册)/i,
  /(?:이용약관|정책).{0,80}계정.{0,30}(?:만들 수 없|생성할 수 없)/i,
  /(?:conditions d'utilisation|politique).{0,80}(?:impossible|ne pouvons pas).{0,30}cr[ée]er.{0,20}compte/i,
  /(?:t[ée]rminos de uso|pol[ií]tica).{0,80}(?:no podemos|no se puede).{0,30}crear.{0,20}cuenta/i,
  /(?:termos de uso|pol[ií]tica).{0,80}(?:n[ãa]o podemos|n[ãa]o [ée] poss[ií]vel).{0,30}criar.{0,20}conta/i,
  /(?:nutzungsbedingungen|richtlinie).{0,80}konto.{0,30}(?:nicht erstellen|kann nicht erstellt)/i,
];

export function normalizeRegistrationErrorCode(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
}

export function isOccupiedAliasErrorCode(value) {
  const code = normalizeRegistrationErrorCode(value);
  return code === OCCUPIED_ALIAS_FAILURE_REASON
    || OCCUPIED_ALIAS_ERROR_CODES.has(code)
    || /(?:^|_)(?:user|account|email)_?already_?(?:exists|registered|used)(?:_|$)/.test(code)
    || /(?:^|_)email_(?:in_)?use(?:_|$)/.test(code);
}

export function isAccountCreationPolicyErrorCode(value) {
  return ACCOUNT_CREATION_POLICY_ERROR_CODES.has(normalizeRegistrationErrorCode(value));
}

export function knownRegistrationFailureReason(value) {
  if (isOccupiedAliasErrorCode(value)) return OCCUPIED_ALIAS_FAILURE_REASON;
  if (isAccountCreationPolicyErrorCode(value)) return ACCOUNT_CREATION_POLICY_BLOCKED_REASON;
  return "";
}

function registrationFailureReasonFromText(value) {
  const text = String(value || "");
  if (!text) return "";
  if (/user_already_exists|user_exists|account_already_exists|email_already_exists|email_already_registered(?:_on_openai)?|email_already_used|email_in_use|(?:user|account|email)\s+already\s+(?:exists|registered|used)|(?:邮箱|电子邮箱)\s*(?:(?:已|已经)\s*(?:被)?|被)\s*(?:占用|注册|使用|存在)|(?:可能|疑似)?\s*已在\s*openai\s*(?:上)?注册过/i.test(text)) {
    return OCCUPIED_ALIAS_FAILURE_REASON;
  }
  return POLICY_BLOCKED_TEXT_PATTERNS.some((pattern) => pattern.test(text))
    ? ACCOUNT_CREATION_POLICY_BLOCKED_REASON
    : "";
}

function structuredRegistrationFailureReason(value, seen = new WeakSet(), depth = 0) {
  if (!value || depth > 6 || typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = structuredRegistrationFailureReason(item, seen, depth + 1);
      if (reason) return reason;
    }
    return "";
  }
  const directCodes = [
    value.error_code,
    value.errorCode,
    value.code,
    value.reason_code,
    value.reasonCode,
    value.failure_code,
    value.failureCode,
    value.failure_reason,
    value.failureReason,
    value.register_failed_reason,
    value.registerFailedReason,
  ];
  for (const code of directCodes) {
    const reason = knownRegistrationFailureReason(code);
    if (reason) return reason;
  }
  for (const item of Object.values(value)) {
    const reason = structuredRegistrationFailureReason(item, seen, depth + 1);
    if (reason) return reason;
  }
  return "";
}

function textRegistrationFailureReason(value, seen = new WeakSet(), depth = 0) {
  if (depth > 6 || value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return registrationFailureReasonFromText(value);
  if (typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  const directText = [value.message, value.error, value.detail, value.reason, value.description];
  for (const item of directText) {
    if (typeof item !== "string") continue;
    const reason = registrationFailureReasonFromText(item);
    if (reason) return reason;
  }
  for (const item of Object.values(value)) {
    const reason = textRegistrationFailureReason(item, seen, depth + 1);
    if (reason) return reason;
  }
  return "";
}

export function remoteRegistrationFailureReason(...values) {
  for (const value of values) {
    const reason = structuredRegistrationFailureReason(value);
    if (reason) return reason;
  }
  for (const value of values) {
    const reason = textRegistrationFailureReason(value);
    if (reason) return reason;
  }
  return "";
}

export function registrationFailureReason(row = {}) {
  if (String(row.status || "").toLowerCase() !== "failed") return "";
  return knownRegistrationFailureReason(row.failure_reason)
    || registrationFailureReasonFromText(`${row.stage || ""} ${row.message || ""}`);
}

function registrationObservationAt(row = {}) {
  return String(row.finished_at || row.updated_at || row.created_at || "");
}

export function occupiedAliasHistory(rows = []) {
  const aliases = new Map();
  for (const row of rows) {
    if (registrationFailureReason(row) !== OCCUPIED_ALIAS_FAILURE_REASON) continue;
    const email = String(row.email || "").trim();
    if (!email) continue;
    const key = email.toLowerCase();
    const lastSeenAt = registrationObservationAt(row);
    const current = aliases.get(key);
    if (!current || lastSeenAt > current.last_seen_at) {
      aliases.set(key, { email, last_seen_at: lastSeenAt });
    }
  }
  const all = [...aliases.values()].sort((left, right) => right.last_seen_at.localeCompare(left.last_seen_at));
  return {
    count: all.length,
    aliases: all.slice(0, OCCUPIED_ALIAS_SAMPLE_LIMIT),
    lastSeenAt: all[0]?.last_seen_at || "",
  };
}

export function publicRegistrationJob(row) {
  if (!row) return row;
  const failureReason = registrationFailureReason(row);
  const message = redactProxySecrets(row.message);
  const displayMessages = {
    [OCCUPIED_ALIAS_FAILURE_REASON]: EMAIL_UNAVAILABLE_MESSAGE,
    [ACCOUNT_CREATION_POLICY_BLOCKED_REASON]: ACCOUNT_CREATION_POLICY_BLOCKED_MESSAGE,
  };
  return {
    ...row,
    message,
    failure_reason: failureReason,
    display_message: displayMessages[failureReason] || message,
  };
}
