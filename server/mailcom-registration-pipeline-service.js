import crypto from "node:crypto";
import { MAILCOM_ALIAS_STRATEGY, mailcomDomains } from "./address-generator.js";
import {
  MAILCOM_RANDOM_DOMAIN,
  MAILCOM_WEB_AUTH_REASON_PREFIX,
  mailcomAliasHistoryLimit,
  mailcomAliasPreparedAddressTarget,
} from "./mailcom-alias-service.js";
import { nowIso } from "./db.js";
import { redactProxySecrets } from "./registration-proxy.js";

const ACTIVE_PIPELINE_STATUSES = new Set(["queued", "running", "cancel_requested"]);
const TERMINAL_PIPELINE_STATUSES = new Set([
  "completed", "partial_failed", "failed", "cancelled", "interrupted",
]);
const ACTIVE_ITEM_STATUSES = new Set(["queued", "running", "retry_wait", "cancel_requested"]);
const TERMINAL_ITEM_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const TERMINAL_ATTEMPT_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const PAYMENT_LINK_COUNTRIES = new Set(["DE", "TR", "GB", "US", "BR", "TH", "JP"]);
const ACCOUNT_POOL_DELETE_PENDING_STAGES = new Set([
  "account_pool_delete_started",
  "account_pool_delete_retry_wait",
]);
const TRIAL_CHECKS = Object.freeze({
  JP: Object.freeze({
    table: "registered_account_trial_checks",
    statusField: "trial_status",
    eligibleField: "trial_eligible",
    errorField: "trial_error",
    httpStatusField: "trial_http_status",
    errorCodeField: "trial_error_code",
    label: "日本 0 元",
  }),
  GB: Object.freeze({
    table: "registered_account_gb_trial_checks",
    statusField: "gb_trial_status",
    eligibleField: "gb_trial_eligible",
    errorField: "gb_trial_error",
    httpStatusField: "gb_trial_http_status",
    errorCodeField: "gb_trial_error_code",
    label: "英国 0 元",
  }),
  US: Object.freeze({
    table: "registered_account_us_trial_checks",
    statusField: "us_trial_status",
    eligibleField: "us_trial_eligible",
    errorField: "us_trial_error",
    httpStatusField: "us_trial_http_status",
    errorCodeField: "us_trial_error_code",
    label: "美国 0 元",
  }),
});
const BROWSER_MODES = new Set(["headed", "headless"]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const UNAVAILABLE_REGISTRATION_REASONS = new Set([
  "user_already_exists",
  "user_exists",
  "account_already_exists",
  "email_already_exists",
  "email_already_registered",
  "email_already_used",
  "email_in_use",
]);
const RETRYABLE_LOCAL_SUBMISSION_CODES = new Set([
  "PICKUP_REGISTRATION_STATUS_UNAVAILABLE",
  "PICKUP_EMAIL_REGISTRATION_BLOCKED",
  "MAILCOM_ALIAS_RECYCLING_RESERVED",
  "MAILCOM_PIPELINE_ACCOUNT_NOT_FOUND",
  "MAILCOM_PIPELINE_ACCOUNT_PROVIDER_INVALID",
  "MAILCOM_PIPELINE_ACCOUNT_DISCONNECTED",
]);
const ALIAS_ACCOUNT_ACTION_REQUIRED_CODES = new Set([
  "MAILCOM_ALIAS_SESSION_EXPIRED",
  "MAILCOM_ALIAS_SETTINGS_AUTH_MISSING",
  "MAILCOM_WEB_AUTH_FAILED",
  "MAILCOM_WEB_CHALLENGE_REQUIRED",
  "MAILCOM_CREDENTIAL_REQUIRED",
  "MAILCOM_CREDENTIAL_DECRYPT_FAILED",
  "MAILCOM_ALIAS_ACCOUNT_MISMATCH",
]);
const ALIAS_ACCOUNT_TRANSIENT_CODES = new Set([
  "MAILCOM_ALIAS_OPEN_TRANSIENT",
  "MAILCOM_ALIAS_OPEN_TIMEOUT",
  "MAILCOM_ALIAS_NAVIGATION_TIMEOUT",
  "MAILCOM_ALIAS_NAVIGATION_FAILED",
  "MAILCOM_ALIAS_PAGE_NOT_READY",
  "MAILCOM_ALIAS_BROWSER_BUSY",
  "MAILCOM_ALIAS_BROWSER_DISCONNECTED",
  "MAILCOM_ALIAS_BROWSER_FAILED",
  "MAILCOM_WEB_LOGIN_TIMEOUT",
]);
const ALIAS_ACTION_REQUIRED_REASON_PREFIX = MAILCOM_WEB_AUTH_REASON_PREFIX;
const ALIAS_CREATE_CONFLICT_ERROR = "Mail.com 拒绝创建官方别名，请求与当前官网地址状态冲突";
const ALIAS_CREATE_CONFLICT_CODES = new Set([
  "MAILCOM_ALIAS_CONFLICT",
  "MAILCOM_ALIAS_CREATE_CONFLICT",
]);
const ALIAS_CREATE_CONFLICT_RECONCILE_STAGE = "alias_conflict_reconcile_wait";
const ORPHAN_ALIAS_CREATE_CONFLICT_RECONCILE_STAGE = "orphan_alias_conflict_reconcile_wait";
const DEFAULT_TRIAL_CHECK_ATTEMPT_LIMIT = 3;
const DELETABLE_MOTHER_ALIAS_OUTCOMES = new Set([
  "trial_ineligible",
  "trial_account_not_found",
  "account_not_found",
  "link_failed",
  "registration_failed",
  "unavailable",
]);
const MOTHER_ALIAS_CANDIDATE_PROTECTION_CODES = new Set([
  "MAILCOM_ALIAS_REMOTE_PROTECTED",
  "MAILCOM_ALIAS_REGISTERED_ACCOUNT_PROTECTED",
  "MAILCOM_ALIAS_AGREEMENT_PROTECTED",
  "MAILCOM_ALIAS_RECYCLE_PROTECTED",
  "MAILCOM_ALIAS_NOT_FOUND",
  "MAILCOM_ALIAS_REPLACEMENT_CAPACITY_FULL",
]);

function failure(message, status = 400, code = "MAILCOM_PIPELINE_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

function safeError(value, fallback = "Mail.com 流水线执行失败") {
  const source = value instanceof Error ? value.message : String(value || "");
  return redactProxySecrets(source || fallback)
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/\bBA-[A-Za-z0-9_-]{8,80}\b/gi, "[REDACTED_BA_TOKEN]")
    .replace(/(activation(?:[_ -]?id)?["']?\s*[:=]\s*["']?)[A-Za-z0-9_-]{6,}/gi, "$1[REDACTED]")
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|(?:auth|id|csrf)?[_ -]?token|(?:secret|private)?[_ -]?key|cookie|device[_ -]?id|password|pass|secret|client[_ -]?secret|authorization|session(?:[_ -]?id)?)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',;}]+/gi, "$1[REDACTED]")
    .replace(/(?:\\?["'])?(activation(?:[_ -]?id)?|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|(?:auth|id|csrf)?[_ -]?token|(?:secret|private)?[_ -]?key|cookie|device[_ -]?id|password|pass|secret|client[_ -]?secret|authorization|session(?:[_ -]?id)?)(?:\\?["'])?\s*[:=]\s*[\s\S]*$/gi, "$1=[REDACTED]")
    .replace(/\beyj[a-z0-9_-]{10,}(?:\.[a-z0-9_-]{4,}){1,2}\b/gi, "[REDACTED_TOKEN]")
    .replace(/(?<![\w])\+?\d(?:[\s().-]*\d){6,14}(?![\w])/g, "[REDACTED_NUMBER]")
    .replace(/\b\d{6}\b/g, "******")
    .slice(0, 500);
}

function positiveInteger(value, label, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw failure(`${label}必须是 1 到 ${maximum} 的整数`);
  }
  return number;
}

function publicExternalAccountId(value) {
  const source = String(value ?? "");
  if (!/^(?:0|[1-9]\d*)$/.test(source)) return source;
  const parsed = Number(source);
  return Number.isSafeInteger(parsed) && String(parsed) === source ? parsed : source;
}

function normalizeBoolean(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "boolean") throw failure(`${label}必须是布尔值`);
  return value;
}

function normalizeInput(input = {}) {
  const domain = String(input.domain || "").trim().toLowerCase().replace(/^@/, "");
  if (!domain || (domain !== MAILCOM_RANDOM_DOMAIN && !mailcomDomains.includes(domain))) {
    throw failure("请选择有效的 Mail.com 域名后缀");
  }
  const concurrency = positiveInteger(input.concurrency ?? 1, "流水线并发数", 20);
  const browserMode = String(input.browserMode || "headed").trim().toLowerCase();
  if (!BROWSER_MODES.has(browserMode)) throw failure("浏览器模式无效");
  const proxySelection = String(input.proxySelection || "auto").trim().toLowerCase();
  if (!new Set(["auto", "direct"]).has(proxySelection) && !/^proxy:\d+$/.test(proxySelection)) {
    throw failure("注册代理选择无效");
  }
  const paymentLinkCountry = String(input.paymentLinkCountry || "GB").trim().toUpperCase();
  if (!PAYMENT_LINK_COUNTRIES.has(paymentLinkCountry)) throw failure("提链国家无效");
  if (!TRIAL_CHECKS[paymentLinkCountry]) {
    throw failure("Mail.com 流水线仅支持 JP、GB 或 US：这三个国家可在提链前独立检测 0 元试用资格");
  }
  const linkAttempts = positiveInteger(
    input.linkAttempts ?? input.paymentLinkAttempts ?? 3,
    "提链次数",
    10,
  );
  normalizeBoolean(input.recycleSucceeded, false, "成功后轮换开关");
  const recycleSucceeded = false;
  const requestId = String(input.requestId || "").trim();
  if (!REQUEST_ID_PATTERN.test(requestId)) throw failure("requestId 必须是 8 到 128 位安全字符");
  return {
    domain,
    concurrency,
    browserMode,
    proxySelection,
    paymentLinkCountry,
    linkAttempts,
    recycleSucceeded,
    requestId,
  };
}

function requestFingerprint(input) {
  return crypto.createHash("sha256").update(JSON.stringify({
    domain: input.domain,
    concurrency: input.concurrency,
    browserMode: input.browserMode,
    proxySelection: input.proxySelection,
    paymentLinkCountry: input.paymentLinkCountry,
    linkAttempts: input.linkAttempts,
    recycleSucceeded: input.recycleSucceeded,
  })).digest("hex");
}

function unavailableRegistration(value = {}) {
  const reason = String(value?.failure_reason || value?.failureReason || value?.code || "")
    .trim().toLowerCase();
  if (UNAVAILABLE_REGISTRATION_REASONS.has(reason)) return reason || "user_already_exists";
  const text = `${reason} ${value?.message || ""} ${value?.error || ""}`.toLowerCase();
  if (/user_already_exists|already (?:exists|registered|used)|(?:邮箱|电子邮箱).*(?:占用|注册|使用)/i.test(text)) {
    return "user_already_exists";
  }
  return "";
}

function registeredAccountUnavailable(value = {}) {
  const code = String(value?.code || value?.failure_reason || value?.failureReason || "")
    .trim().toLowerCase();
  if (new Set([
    "account_not_found", "account_deleted", "account_deactivated",
    "registered_account_not_found", "registered_account_deleted",
    "remote_account_not_found",
  ]).has(code)) {
    return true;
  }
  const details = [
    typeof value === "string" ? value : "",
    value?.message,
    value?.error,
  ].map((entry) => String(entry || "").trim()).filter(Boolean);
  const exactMessages = new Set([
    "账号不存在", "账户不存在", "注册账号不存在",
    "账号已删除", "账户已删除", "账号已停用", "账户已停用",
    "账号已从本地账号池删除",
  ]);
  return details.some((detail) => {
    const normalized = detail.replace(/^Error:\s*/i, "").replace(/[。.!?；;]+$/g, "").trim();
    if (exactMessages.has(normalized)) return true;
    return /^(?:you do not have an account(?: because it has been deleted or deactivated)?|(?:your |remote )?account (?:(?:has been|was|is) )?(?:not found|does not exist|deleted|deactivated|deleted or deactivated))$/i
      .test(normalized);
  });
}

function trialRegisteredAccountUnavailable(value = {}) {
  if (registeredAccountUnavailable(value)) return true;
  if (Number(value?.status || 0) === 401) return true;
  const details = [
    typeof value === "string" ? value : "",
    value?.message,
    value?.error,
  ].map((entry) => String(entry || "").trim()).filter(Boolean);
  return details.some((detail) => /\bHTTP\s*401\b/i.test(detail));
}

function registeredAccountMismatch(value = {}) {
  const code = String(value?.code || value?.failure_reason || value?.failureReason || "")
    .trim().toLowerCase();
  if (code === "registered_account_mismatch") return true;
  const details = [
    typeof value === "string" ? value : "",
    value?.message,
    value?.error,
  ].map((entry) => String(entry || "").replace(/^Error:\s*/i, "").trim()).filter(Boolean);
  return details.some((detail) => new Set([
    "注册账号与远端账号不匹配",
    "注册账号与任务记录不匹配",
  ]).has(detail.replace(/[。.!?；;]+$/g, "").trim()));
}

function paymentLinkFailureText(value, fallback = "提链失败") {
  if (value && typeof value === "object" && !(value instanceof Error)) {
    return safeError(value.error || value.message || fallback, fallback);
  }
  return safeError(value, fallback);
}

function paymentLinkBlocked(value = {}) {
  const category = String(value?.error_category || "").trim().toLowerCase();
  const stage = String(value?.stage || "").trim().toLowerCase();
  if (category === "blocked" || stage === "error_blocked") return true;
  const message = paymentLinkFailureText(value, "").replace(/[。.!?；;]+$/g, "").trim();
  return /^(?:ChatGPT manual approval blocked(?:\s*:\s*HTTP \d{3})?|manual_approval approve blocked:\s*result=blocked(?:\b.*)?|oaics (?:checkout|confirm) blocked(?:\b.*)?)$/i
    .test(message);
}

function paymentLinkRuntimeFailure(value = {}) {
  const category = String(value?.error_category || "").trim().toLowerCase();
  const stage = String(value?.stage || "").trim().toLowerCase();
  const status = Number(
    value?.http_status
      || value?.status_code
      || value?.statusCode
      || value?.error?.status
      || value?.status
      || 0,
  );
  if (new Set([
    "network", "network_error", "timeout", "queue_timeout", "account_busy",
    "service_unavailable", "service_error", "error_service", "task_context_lost",
  ]).has(category)) return true;
  if (new Set([
    "error_network", "error_network_error", "error_timeout", "error_queue_timeout",
    "error_account_busy", "timeout", "queue_timeout",
    "service_error", "error_service", "error_service_error", "error_error_service",
    "error_service_unavailable", "error_task_context_lost",
  ]).has(stage)) return true;
  if (status === 408 || status === 429 || status >= 500) return true;
  const message = paymentLinkFailureText(value, "");
  const normalized = message.trim();
  return /^(?:fetch failed|network (?:error|request failed)|提链服务请求超时|提链任务(?:执行|排队)超时)$/i
    .test(normalized)
    || /\bHTTP\s*5\d\d\b/i.test(normalized);
}

function generatedReplacement(domain) {
  const token = crypto.randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `ah${token}`.slice(0, 14) + `@${domain}`;
}

function agreementJob(response) {
  return response?.job && typeof response.job === "object" ? response.job : response;
}

function agreementStatus(snapshot) {
  const status = String(snapshot?.status || "").trim().toLowerCase();
  return status === "succeeded" ? "completed" : status;
}

class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.active = 0;
    this.waiters = [];
  }

  acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }
}

export class MailcomRegistrationPipelineService {
  constructor({
    db,
    registration,
    paymentLinks,
    paymentAgreements,
    mailcomAliases,
    pollIntervalMs = 2_000,
    retryBaseMs = 2_000,
    retryMaximumMs = 60_000,
    trialCheckConcurrency = 5,
    trialCheckAttemptLimit = DEFAULT_TRIAL_CHECK_ATTEMPT_LIMIT,
    aliasOperationConcurrency = 1,
    sleepFn = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    randomIntFn = crypto.randomInt,
  } = {}) {
    if (!db || !registration || !paymentLinks || !paymentAgreements || !mailcomAliases
      || typeof mailcomAliases.prepareAccount !== "function"
      || typeof mailcomAliases.recycleAlias !== "function") {
      throw new TypeError("MailcomRegistrationPipelineService dependencies are required");
    }
    this.db = db;
    this.registration = registration;
    this.paymentLinks = paymentLinks;
    this.paymentAgreements = paymentAgreements;
    this.mailcomAliases = mailcomAliases;
    this.pollIntervalMs = Math.max(20, Number(pollIntervalMs) || 2_000);
    this.retryBaseMs = Math.max(20, Number(retryBaseMs) || 2_000);
    this.retryMaximumMs = Math.max(this.retryBaseMs, Number(retryMaximumMs) || 60_000);
    this.trialCheckSemaphore = new Semaphore(Math.max(1, Math.min(20, Number(trialCheckConcurrency) || 5)));
    this.trialCheckAttemptLimit = Math.max(
      1,
      Math.min(20, Number(trialCheckAttemptLimit) || DEFAULT_TRIAL_CHECK_ATTEMPT_LIMIT),
    );
    this.aliasOperationSemaphore = new Semaphore(
      Math.max(1, Math.min(5, Number(aliasOperationConcurrency) || 1)),
    );
    this.sleepFn = sleepFn;
    this.randomIntFn = typeof randomIntFn === "function" ? randomIntFn : crypto.randomInt;
    this.trackers = new Map();
    this.trackerRestarts = new Set();
    this.orphanTrackers = new Map();
    this.authorizationRecoveries = new Map();
    this.authorizationBatches = new Set();
    this.cancellations = new Map();
    this.accountPoolDeletions = new Map();
    this.wakes = new Map();
    this.aliasQueues = new Map();
    this.aliasOperations = new Set();
    this.closed = false;
    this.recoveryPromise = this.recoverActivePipelines();
  }

  taskRow(id) {
    return this.db.prepare("SELECT * FROM mailcom_registration_pipelines WHERE id = ?")
      .get(String(id || ""));
  }

  requestRow(requestId) {
    return this.db.prepare("SELECT * FROM mailcom_registration_pipelines WHERE request_id = ?")
      .get(String(requestId || ""));
  }

  itemRow(id) {
    return this.db.prepare("SELECT * FROM mailcom_registration_pipeline_items WHERE id = ?")
      .get(Number(id));
  }

  attemptRow(id) {
    return this.db.prepare("SELECT * FROM mailcom_registration_pipeline_attempts WHERE id = ?")
      .get(Number(id));
  }

  items(id) {
    return this.db.prepare(`
      SELECT * FROM mailcom_registration_pipeline_items WHERE pipeline_id = ? ORDER BY id
    `).all(String(id || ""));
  }

  attemptsForItem(itemId) {
    return this.db.prepare(`
      SELECT * FROM mailcom_registration_pipeline_attempts WHERE item_id = ? ORDER BY id
    `).all(Number(itemId));
  }

  publicAttempt(row) {
    if (!row) return null;
    return {
      id: row.id,
      cycle: row.attempt_number,
      pipeline_id: row.pipeline_id,
      item_id: row.item_id,
      attempt_number: row.attempt_number,
      address_id: row.address_id,
      email: row.email,
      registration_job_id: row.registration_job_id,
      external_account_id: publicExternalAccountId(row.external_account_id),
      payment_link_task_id: row.payment_link_task_id,
      agreement_job_id: row.agreement_job_id,
      status: row.status,
      stage: row.stage,
      outcome: row.outcome,
      registration_status: row.registration_status,
      trial_country: row.trial_country,
      trial_status: row.trial_status,
      trial_error: safeError(row.trial_error, ""),
      trial_checked_at: row.trial_checked_at,
      link_status: row.link_status,
      link_attempt_count: Math.max(0, Number(row.link_attempt_count || 0)),
      agreement_status: row.agreement_status,
      agreement_country: row.agreement_country,
      agreement_error: safeError(row.agreement_error, ""),
      failure_reason: row.failure_reason,
      error: safeError(row.recycle_error || row.error, ""),
      recycle_status: row.recycle_status,
      recycle_attempts: row.recycle_attempts,
      recycle_error: safeError(row.recycle_error, ""),
      replacement_address_id: row.replacement_address_id,
      replacement_email: row.replacement_email,
      next_retry_at: row.next_retry_at,
      registration_finished_at: row.registration_finished_at,
      link_finished_at: row.link_finished_at,
      agreement_started_at: row.agreement_started_at,
      agreement_finished_at: row.agreement_finished_at,
      finished_at: row.finished_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  publicItem(row, { includeAttempts = false } = {}) {
    if (!row) return null;
    const attempts = includeAttempts ? this.attemptsForItem(row.id) : [];
    const latest = includeAttempts
      ? attempts[attempts.length - 1]
      : this.db.prepare(`
        SELECT * FROM mailcom_registration_pipeline_attempts WHERE item_id = ? ORDER BY id DESC LIMIT 1
      `).get(row.id);
    return {
      id: row.id,
      pipeline_id: row.pipeline_id,
      account_id: row.account_id,
      source_email: row.source_email,
      slot_key: row.slot_key,
      slot_kind: row.slot_kind,
      primary: row.slot_kind === "primary",
      initial_address_id: row.initial_address_id,
      initial_email: row.initial_email,
      current_address_id: row.current_address_id,
      current_email: row.current_email,
      replacement_email: row.replacement_email,
      current_attempt_id: row.current_attempt_id,
      status: row.status,
      stage: row.stage,
      terminal: TERMINAL_ITEM_STATUSES.has(row.status),
      attempt_count: row.attempt_count,
      registration_success_count: row.registration_success_count,
      link_success_count: row.link_success_count,
      agreement_success_count: row.agreement_success_count,
      agreement_failure_count: row.agreement_failure_count,
      failure_count: row.failure_count,
      recycled_count: row.recycled_count,
      created_count: row.created_count,
      retry_count: row.retry_count,
      recycle_retry_count: row.recycle_retry_count,
      next_retry_at: row.next_retry_at,
      prepare_error: safeError(row.prepare_error, ""),
      error: safeError(row.error, ""),
      created_at: row.created_at,
      updated_at: row.updated_at,
      finished_at: row.finished_at,
      latest_attempt: this.publicAttempt(latest),
      ...(includeAttempts ? { attempts: attempts.map((attempt) => this.publicAttempt(attempt)) } : {}),
    };
  }

  phaseProgress(taskId, items = this.items(taskId)) {
    const attempts = this.db.prepare(`
      SELECT attempts.registration_status, attempts.trial_status, attempts.link_status, attempts.agreement_status,
        attempts.recycle_status, attempts.status, attempts.outcome, items.slot_kind
      FROM mailcom_registration_pipeline_attempts AS attempts
      JOIN mailcom_registration_pipeline_items AS items ON items.id = attempts.item_id
      WHERE attempts.pipeline_id = ?
    `).all(taskId);
    const activeItems = items.filter((item) => ACTIVE_ITEM_STATUSES.has(item.status));
    const stageCount = (...patterns) => activeItems.filter((item) => patterns.some((pattern) => (
      pattern.endsWith("*")
        ? String(item.stage || "").startsWith(pattern.slice(0, -1))
        : String(item.stage || "") === pattern
    ))).length;
    const attemptCount = (field, value, predicate = () => true) => attempts
      .filter((attempt) => attempt[field] === value && predicate(attempt)).length;
    const primaries = items.filter((item) => item.slot_kind === "primary");
    const preparing = primaries.filter((item) => String(item.stage || "").startsWith("prepare_"));
    const preparationFailures = primaries.filter((item) => (
      !String(item.stage || "").startsWith("prepare_") && String(item.prepare_error || "").trim()
    ));
    const progress = {
      preparation: {
        unit: "account",
        waiting: preparing.filter((item) => item.stage === "prepare_queued").length,
        running: preparing.filter((item) => item.stage === "prepare_running").length,
        retrying: 0,
        succeeded: Math.max(0, primaries.length - preparing.length - preparationFailures.length),
        failed: preparationFailures.length,
        total: primaries.length,
      },
      registration: {
        unit: "slot_attempt",
        waiting: stageCount("registration_queued"),
        running: stageCount("registration_submitting", "registration_wait", "registering"),
        retrying: stageCount("registration_runtime_retry_wait", "registration_retry_wait"),
        succeeded: attemptCount("registration_status", "succeeded"),
        failed: attemptCount("registration_status", "failed"),
      },
      trial: {
        unit: "slot_attempt",
        waiting: stageCount("trial_check_queued"),
        running: stageCount("trial_checking"),
        retrying: stageCount("trial_runtime_retry_wait"),
        succeeded: attemptCount("trial_status", "eligible"),
        ineligible: attemptCount("trial_status", "ineligible"),
        failed: attemptCount("trial_status", "failed"),
        skipped: attemptCount("trial_status", "skipped"),
      },
      link: {
        unit: "slot_attempt",
        waiting: stageCount("link_queued"),
        running: stageCount("link_submitting", "link_wait", "extracting_link", "extracting_links"),
        retrying: stageCount("link_runtime_retry_wait", "link_retry_wait"),
        succeeded: attemptCount("link_status", "succeeded"),
        failed: attemptCount("link_status", "failed"),
      },
      agreement: {
        unit: "slot_attempt",
        waiting: stageCount("agreement_ready", "agreement_queued"),
        running: stageCount("agreement_submitting", "agreement_wait", "agreement_running"),
        retrying: stageCount("agreement_runtime_retry_wait"),
        succeeded: attemptCount("agreement_status", "succeeded"),
        failed: attemptCount("agreement_status", "failed"),
        uncertain: attemptCount("agreement_status", "uncertain"),
      },
      recycle: {
        unit: "slot_attempt",
        waiting: 0,
        running: stageCount(
          "account_pool_delete_started",
          "account_pool_deleted",
          "recycling",
          "recycle_remote_started",
        ),
        retrying: stageCount(
          "account_pool_delete_retry_wait",
          "recycle_retry_wait",
          "account_action_required_remote_uncertain",
        ),
        succeeded: attemptCount("recycle_status", "succeeded"),
        failed: attemptCount("recycle_status", "failed"),
        preserved: attempts.filter((attempt) => attempt.recycle_status === "skipped"
          && attempt.stage !== "link_blocked_released"
          && (attempt.outcome === "link_blocked" || attempt.link_status === "succeeded"
            || attempt.agreement_status === "succeeded" || this.registeredAccountIsPlus(attempt))).length
          + items.filter((item) => ["link_blocked_preserved", "plus_preserved"].includes(item.stage)).length,
      },
    };
    const registrationActive = progress.registration.waiting + progress.registration.running
      + progress.registration.retrying;
    const trialActive = progress.trial.waiting + progress.trial.running + progress.trial.retrying;
    const linkActive = progress.link.waiting + progress.link.running + progress.link.retrying;
    const agreementActive = progress.agreement.waiting + progress.agreement.running
      + progress.agreement.retrying;
    const recycleActive = progress.recycle.running + progress.recycle.retrying;
    const active = [];
    if (preparing.length) active.push(`${preparing.length} 个母号正在准备`);
    if (registrationActive) active.push(`${registrationActive} 个地址正在注册或等待注册`);
    if (trialActive) active.push(`${trialActive} 个账号正在检测 0 元试用资格`);
    if (linkActive) active.push(`${linkActive} 个账号正在提链或等待提链`);
    if (agreementActive) active.push(`${agreementActive} 个账号正在协议授权`);
    if (recycleActive) active.push(`${recycleActive} 个失败别名正在轮换或等待恢复`);
    return {
      ...progress,
      message: active.length
        ? `${linkActive ? "" : "当前没有账号在提链；"}${active.join("，")}。注册成功后先检测试用资格，仅有试用的账号会提链并协议授权。`
        : "当前没有进行中的地址槽。",
    };
  }

  actionRequiredAccounts(taskId) {
    return this.db.prepare(`
      SELECT accounts.id AS account_id, accounts.email AS source_email, accounts.limit_reason,
        COUNT(items.id) AS affected_count,
        SUM(CASE WHEN items.status IN ('queued', 'running', 'retry_wait', 'cancel_requested') THEN 1 ELSE 0 END)
          AS active_count,
        MAX(CASE WHEN items.status IN ('queued', 'running', 'retry_wait', 'cancel_requested')
          THEN items.current_email ELSE '' END) AS current_email
      FROM mailcom_registration_pipeline_items AS items
      JOIN source_accounts AS accounts ON accounts.id = items.account_id
      WHERE items.pipeline_id = ? AND accounts.provider = 'mailcom'
        AND (accounts.status = 'action_required' OR accounts.limit_reason LIKE ?)
      GROUP BY accounts.id, accounts.email, accounts.limit_reason
      ORDER BY accounts.id
    `).all(taskId, `${ALIAS_ACTION_REQUIRED_REASON_PREFIX}%`).map((row) => ({
      account_id: row.account_id,
      source_email: row.source_email,
      current_email: row.current_email || "",
      affected_count: Math.max(0, Number(row.affected_count || 0)),
      active_count: Math.max(0, Number(row.active_count || 0)),
      code: "MAILCOM_ALIAS_ACTION_REQUIRED",
      error: safeError(row.limit_reason, "Mail.com 母号需要重新连接"),
    }));
  }

  publicTask(value, { includeAttempts = false } = {}) {
    const row = typeof value === "object" ? value : this.taskRow(value);
    if (!row) return null;
    const items = this.items(row.id);
    const attemptErrors = this.db.prepare(`
      SELECT attempts.*, items.source_email, items.slot_kind
      FROM mailcom_registration_pipeline_attempts AS attempts
      JOIN mailcom_registration_pipeline_items AS items ON items.id = attempts.item_id
      WHERE attempts.pipeline_id = ? AND (
        attempts.status = 'failed' OR trim(attempts.recycle_error) <> ''
          OR trim(attempts.agreement_error) <> ''
          OR (trim(attempts.error) <> '' AND attempts.stage LIKE '%retry_wait')
      )
      ORDER BY attempts.updated_at DESC, attempts.id DESC LIMIT 10
    `).all(row.id).map((attempt) => ({
      ...this.publicAttempt(attempt),
      source_email: attempt.source_email,
      slot_kind: attempt.slot_kind,
      stage: attempt.recycle_error ? `recycle_${attempt.recycle_status}` : attempt.stage,
      error: safeError(attempt.recycle_error || attempt.agreement_error || attempt.error, ""),
      _updated_at: attempt.updated_at,
    }));
    const prepareErrors = this.db.prepare(`
      SELECT id, source_email, current_email, slot_kind, prepare_error, updated_at
      FROM mailcom_registration_pipeline_items
      WHERE pipeline_id = ? AND trim(prepare_error) <> ''
      ORDER BY updated_at DESC, id DESC LIMIT 10
    `).all(row.id).map((item) => ({
      id: `prepare:${item.id}`,
      cycle: 0,
      attempt_number: 0,
      item_id: item.id,
      email: item.current_email || item.source_email,
      source_email: item.source_email,
      slot_kind: item.slot_kind,
      stage: "prepare_failed",
      status: "failed",
      error: safeError(item.prepare_error, "Mail.com 别名准备失败"),
      updated_at: item.updated_at,
      _updated_at: item.updated_at,
    }));
    const recentErrors = [...attemptErrors, ...prepareErrors]
      .sort((left, right) => String(right._updated_at).localeCompare(String(left._updated_at)))
      .slice(0, 10)
      .map(({ _updated_at, ...entry }) => entry);
    const phaseProgress = this.phaseProgress(row.id, items);
    const actionRequiredAccounts = this.actionRequiredAccounts(row.id);
    return {
      id: row.id,
      pipeline_id: row.id,
      request_id: row.request_id,
      domain: row.domain,
      status: row.status,
      stage: row.stage,
      terminal: TERMINAL_PIPELINE_STATUSES.has(row.status),
      cancellable: ACTIVE_PIPELINE_STATUSES.has(row.status),
      concurrency: row.concurrency,
      browser_mode: row.browser_mode,
      proxy_selection: row.proxy_selection,
      payment_link_country: row.payment_link_country,
      link_attempts: Math.max(1, Number(row.link_attempts || 3)),
      recycle_succeeded: Boolean(row.recycle_succeeded),
      account_count: row.account_count,
      slot_count: row.slot_count,
      attempt_count: row.attempt_count,
      registration_success_count: row.registration_success_count,
      link_success_count: row.link_success_count,
      agreement_success_count: row.agreement_success_count,
      agreement_failure_count: row.agreement_failure_count,
      agreement_active_count: Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM mailcom_registration_pipeline_attempts
        WHERE pipeline_id = ? AND link_status = 'succeeded'
          AND agreement_status IN ('pending', 'running', 'uncertain')
          AND status IN ('queued', 'running')
      `).get(row.id)?.count || 0),
      failure_count: row.failure_count,
      recycled_count: row.recycled_count,
      created_count: row.created_count,
      cancelled_count: row.cancelled_count,
      message: `母号 ${row.account_count} · 地址槽 ${row.slot_count} · 注册成功 ${row.registration_success_count} · 提链成功 ${row.link_success_count} · 协议成功 ${row.agreement_success_count} · 已轮换 ${row.recycled_count}`,
      activity_message: phaseProgress.message,
      phase_progress: phaseProgress,
      action_required_accounts: actionRequiredAccounts,
      error: safeError(row.error, ""),
      created_at: row.created_at,
      updated_at: row.updated_at,
      finished_at: row.finished_at,
      items: items.map((item) => this.publicItem(item, { includeAttempts })),
      recent_errors: recentErrors,
    };
  }

  inventoryCounts() {
    const connectedAccountCount = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM source_accounts
      WHERE provider = 'mailcom' AND status = 'connected'
    `).get()?.count || 0);
    const activeAliasCount = Number(this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM addresses JOIN source_accounts ON source_accounts.id = addresses.account_id
      WHERE source_accounts.provider = 'mailcom' AND source_accounts.status = 'connected'
        AND addresses.kind = 'official' AND addresses.strategy = ? AND addresses.status = 'active'
    `).get(MAILCOM_ALIAS_STRATEGY)?.count || 0);
    return {
      connected_account_count: connectedAccountCount,
      active_alias_count: activeAliasCount,
      connected_address_count: connectedAccountCount + activeAliasCount,
    };
  }

  recoveryStatus() {
    const rows = this.db.prepare(`
      SELECT attempts.id, attempts.pipeline_id, attempts.email,
        attempts.stage, attempts.recycle_attempts, attempts.recycle_error,
        attempts.next_retry_at, attempts.updated_at,
        items.account_id, items.source_email
      FROM mailcom_registration_pipeline_attempts AS attempts
      JOIN mailcom_registration_pipeline_items AS items ON items.id = attempts.item_id
      JOIN mailcom_registration_pipelines AS pipelines ON pipelines.id = attempts.pipeline_id
      WHERE attempts.recycle_status = 'running'
        AND pipelines.status IN ('completed', 'partial_failed', 'failed', 'cancelled', 'interrupted')
      ORDER BY attempts.updated_at DESC, attempts.id DESC
    `).all();
    const recoveringRecycles = rows.map((row) => ({
      attempt_id: row.id,
      pipeline_id: row.pipeline_id,
      account_id: row.account_id,
      source_email: row.source_email,
      alias_email: row.email,
      stage: row.stage,
      recycle_attempts: Math.max(0, Number(row.recycle_attempts || 0)),
      error: safeError(row.recycle_error, ""),
      next_retry_at: row.next_retry_at,
      updated_at: row.updated_at,
    }));
    const count = recoveringRecycles.length;
    return {
      recovery_active: count > 0,
      recovering_recycle_count: Math.max(0, count),
      recovery_error: recoveringRecycles[0]?.error || "",
      recovering_recycles: recoveringRecycles,
    };
  }

  abandonRecoveries({ accountId = null, email = "", reason = "Mail.com 邮箱已从系统移除，不再恢复别名轮换" } = {}) {
    const normalizedAccountId = Number(accountId);
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const conditions = [];
    const params = [];
    if (Number.isSafeInteger(normalizedAccountId) && normalizedAccountId > 0) {
      conditions.push("items.account_id = ?");
      params.push(normalizedAccountId);
    }
    if (normalizedEmail) {
      conditions.push(`(
        attempts.email = ? COLLATE NOCASE
        OR items.current_email = ? COLLATE NOCASE
        OR items.source_email = ? COLLATE NOCASE
      )`);
      params.push(normalizedEmail, normalizedEmail, normalizedEmail);
    }
    if (!conditions.length) return { abandoned_count: 0, item_ids: [] };
    const rows = this.db.prepare(`
      SELECT attempts.id, attempts.item_id
      FROM mailcom_registration_pipeline_attempts AS attempts
      JOIN mailcom_registration_pipeline_items AS items ON items.id = attempts.item_id
      JOIN mailcom_registration_pipelines AS pipelines ON pipelines.id = attempts.pipeline_id
      WHERE attempts.recycle_status = 'running'
        AND pipelines.status IN ('completed', 'partial_failed', 'failed', 'cancelled', 'interrupted')
        AND (${conditions.join(" OR ")})
      ORDER BY attempts.id
    `).all(...params);
    if (!rows.length) return { abandoned_count: 0, item_ids: [] };
    const message = safeError(reason, "Mail.com 邮箱已从系统移除，不再恢复别名轮换");
    const at = nowIso();
    this.db.transaction(() => {
      const abandonAttempt = this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'skipped', stage = 'recycle_abandoned', recycle_error = ?,
          next_retry_at = NULL, updated_at = ?
        WHERE id = ? AND recycle_status = 'running'
      `);
      const clearItem = this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET replacement_email = '', next_retry_at = NULL, updated_at = ? WHERE id = ?
      `);
      rows.forEach((row) => {
        abandonAttempt.run(message, at, row.id);
        clearItem.run(at, row.item_id);
      });
    })();
    const itemIds = [...new Set(rows.map((row) => Number(row.item_id)).filter(Number.isSafeInteger))];
    itemIds.forEach((itemId) => {
      this.wake(itemId);
      this.recomputeItem(itemId);
    });
    return { abandoned_count: rows.length, item_ids: itemIds };
  }

  list({ limit = 20 } = {}) {
    const bounded = Math.max(1, Math.min(100, Number(limit) || 20));
    const rows = this.db.prepare(`
      SELECT * FROM mailcom_registration_pipelines ORDER BY created_at DESC LIMIT ?
    `).all(bounded);
    const activeRow = rows.find((row) => ACTIVE_PIPELINE_STATUSES.has(row.status))
      || this.db.prepare(`
        SELECT * FROM mailcom_registration_pipelines
        WHERE status IN ('queued', 'running', 'cancel_requested')
        ORDER BY created_at DESC LIMIT 1
      `).get();
    const activeCount = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM mailcom_registration_pipelines
      WHERE status IN ('queued', 'running', 'cancel_requested')
    `).get()?.count || 0);
    const latest = rows[0] || null;
    return {
      items: rows.map((row) => this.publicTask(row, { includeAttempts: false })),
      active: activeRow ? this.publicTask(activeRow, { includeAttempts: false }) : null,
      latest: latest ? this.publicTask(latest, { includeAttempts: false }) : null,
      active_count: activeCount,
      ...this.recoveryStatus(),
      ...this.inventoryCounts(),
      mailcom_domains: [...mailcomDomains],
    };
  }

  async dependencyStatus() {
    const result = {
      ready: true,
      queue_paused: false,
      registration_ready: true,
      payment_links_configured: false,
      checkout_proxy_count: 0,
      update_proxy_count: 0,
      apply_checkout_update: false,
      payment_agreements_configured: false,
      agreement_runtime_configured: false,
      agreement_api_key_configured: false,
      agreement_country: "",
      agreement_proxy_count: 0,
      error: "",
      code: "",
    };
    try {
      const queue = await this.registration.registrationQueueControl?.();
      result.queue_paused = Boolean(queue?.paused);
      if (result.queue_paused) {
        result.ready = false;
        result.error = "注册队列当前已暂停，请先恢复队列";
        result.code = "MAILCOM_PIPELINE_QUEUE_PAUSED";
      }
    } catch (error) {
      result.ready = false;
      result.registration_ready = false;
      result.error = `注册队列状态读取失败：${safeError(error, "注册服务当前不可用")}`;
      result.code = "MAILCOM_PIPELINE_REGISTRATION_UNAVAILABLE";
    }
    try {
      const health = await this.registration.client?.health?.();
      if (health && (health.configured === false || health.ok === false)) {
        result.ready = false;
        result.registration_ready = false;
        result.error ||= "注册服务当前不可用";
        result.code ||= "MAILCOM_PIPELINE_REGISTRATION_UNAVAILABLE";
      }
    } catch (error) {
      result.ready = false;
      result.registration_ready = false;
      result.error ||= `注册服务健康检查失败：${safeError(error, "注册服务当前不可用")}`;
      result.code ||= "MAILCOM_PIPELINE_REGISTRATION_UNAVAILABLE";
    }
    try {
      const config = this.paymentLinks.configuration();
      result.payment_links_configured = Boolean(config?.configured);
      result.checkout_proxy_count = Number(config?.checkout_proxy_count || 0);
      result.update_proxy_count = Number(config?.update_proxy_count || 0);
      result.apply_checkout_update = Boolean(config?.apply_checkout_update);
      if (!result.payment_links_configured) {
        result.ready = false;
        result.error ||= "提链服务尚未配置";
        result.code ||= "MAILCOM_PIPELINE_LINK_UNAVAILABLE";
      } else if (!result.checkout_proxy_count) {
        result.ready = false;
        result.error ||= "Checkout Proxy 池为空";
        result.code ||= "MAILCOM_PIPELINE_CHECKOUT_PROXY_EMPTY";
      } else if (result.apply_checkout_update && !result.update_proxy_count) {
        result.ready = false;
        result.error ||= "Update Proxy 池为空";
        result.code ||= "MAILCOM_PIPELINE_UPDATE_PROXY_EMPTY";
      }
    } catch (error) {
      result.ready = false;
      result.error ||= `提链服务状态读取失败：${safeError(error, "提链服务当前不可用")}`;
      result.code ||= "MAILCOM_PIPELINE_LINK_UNAVAILABLE";
    }
    try {
      const settings = this.paymentAgreements.settings();
      result.payment_agreements_configured = Boolean(settings?.protocol_configured);
      result.agreement_api_key_configured = Boolean(settings?.configured && settings?.api_key_configured);
      if (!result.payment_agreements_configured) {
        result.ready = false;
        result.error ||= "协议授权服务尚未配置";
        result.code ||= "MAILCOM_PIPELINE_AGREEMENT_UNAVAILABLE";
      } else if (!result.agreement_api_key_configured) {
        result.ready = false;
        result.error ||= "HeroSMS 尚未配置";
        result.code ||= "MAILCOM_PIPELINE_AGREEMENT_UNAVAILABLE";
      }
      const runtime = this.paymentAgreements.runtime({ required: true });
      result.agreement_runtime_configured = Boolean(runtime?.configured);
      result.agreement_country = String(runtime?.country || "").toUpperCase();
      result.agreement_proxy_count = Number(runtime?.proxy_count ?? runtime?.proxies?.length ?? 0);
      if (!result.agreement_runtime_configured || !result.agreement_country || !result.agreement_proxy_count) {
        result.ready = false;
        result.error ||= "协议授权国家或代理池尚未配置";
        result.code ||= "MAILCOM_PIPELINE_AGREEMENT_UNAVAILABLE";
      }
    } catch (error) {
      result.ready = false;
      result.error ||= `协议授权运行配置不可用：${safeError(error, "协议授权服务当前不可用")}`;
      result.code ||= "MAILCOM_PIPELINE_AGREEMENT_UNAVAILABLE";
    }
    return result;
  }

  async status() {
    const listed = this.list({ limit: 1 });
    const dependency = await this.dependencyStatus();
    if (listed.recovery_active) {
      const target = listed.recovering_recycles[0];
      const targetLabel = target
        ? `：母号 ${target.source_email}${target.account_id ? "" : "（已从系统删除）"}，待轮换别名 ${target.alias_email}`
        : "";
      dependency.ready = false;
      dependency.error = `上次取消的 Mail.com 别名轮换正在恢复${targetLabel}`;
      dependency.code = "MAILCOM_PIPELINE_RECOVERY_ACTIVE";
    }
    return {
      ready: dependency.ready,
      ...this.inventoryCounts(),
      mailcom_domains: [...mailcomDomains],
      dependency,
      active: listed.active,
      latest: listed.latest,
      active_count: listed.active_count,
      recovery_active: listed.recovery_active,
      recovering_recycle_count: listed.recovering_recycle_count,
      recovery_error: listed.recovery_error,
      recovering_recycles: listed.recovering_recycles,
    };
  }

  async validateDependencies() {
    const dependency = await this.dependencyStatus();
    if (!dependency.ready) {
      const statuses = new Set([
        "MAILCOM_PIPELINE_QUEUE_PAUSED",
        "MAILCOM_PIPELINE_CHECKOUT_PROXY_EMPTY",
        "MAILCOM_PIPELINE_UPDATE_PROXY_EMPTY",
        "MAILCOM_PIPELINE_AGREEMENT_UNAVAILABLE",
      ]);
      throw failure(dependency.error || "Mail.com 流水线依赖当前不可用", statuses.has(dependency.code) ? 409 : 503,
        dependency.code || "MAILCOM_PIPELINE_DEPENDENCY_UNAVAILABLE");
    }
  }

  validateProxySelection(proxySelection) {
    if (proxySelection === "direct") return;
    let proxies;
    try {
      proxies = typeof this.registration.getProxyPool === "function"
        ? this.registration.getProxyPool() : [];
    } catch (error) {
      throw failure(
        `注册代理池读取失败：${safeError(error, "代理配置无效")}`,
        409,
        "MAILCOM_PIPELINE_PROXY_INVALID",
      );
    }
    if (!Array.isArray(proxies)) proxies = [];
    if (proxySelection === "auto") {
      if (!proxies.length) {
        throw failure("注册代理池为空，请先保存代理或选择直连", 409, "MAILCOM_PIPELINE_PROXY_EMPTY");
      }
      return;
    }
    const match = String(proxySelection).match(/^proxy:(\d+)$/);
    const index = match ? Number(match[1]) : -1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= proxies.length) {
      throw failure("选择的注册代理已不存在，请刷新后重试", 409, "MAILCOM_PIPELINE_PROXY_NOT_FOUND");
    }
  }

  validateRegistrationAccount(item) {
    const account = this.db.prepare("SELECT id, provider, status, limit_reason FROM source_accounts WHERE id = ?")
      .get(Number(item?.account_id));
    if (!account) {
      throw failure("Mail.com 母号已不存在，等待恢复", 409, "MAILCOM_PIPELINE_ACCOUNT_NOT_FOUND");
    }
    if (account.provider !== "mailcom") {
      throw failure("流水线母号不再是 Mail.com，等待恢复", 409, "MAILCOM_PIPELINE_ACCOUNT_PROVIDER_INVALID");
    }
    if (String(account.limit_reason || "").startsWith(ALIAS_ACTION_REQUIRED_REASON_PREFIX)
      || account.status === "action_required") {
      throw failure(
        account.limit_reason || "Mail.com 母号需要重新连接后才能继续",
        409,
        "MAILCOM_PIPELINE_ACCOUNT_ACTION_REQUIRED",
      );
    }
    if (account.status !== "connected") {
      throw failure("Mail.com 母号当前未连接，等待重新连接", 409, "MAILCOM_PIPELINE_ACCOUNT_DISCONNECTED");
    }
    return account;
  }

  async validateRegistrationRuntime(task, item = null) {
    const dependency = await this.dependencyStatus();
    if (!dependency.ready) {
      throw failure(
        dependency.error || "Mail.com 流水线依赖当前不可用",
        409,
        dependency.code || "MAILCOM_PIPELINE_DEPENDENCY_UNAVAILABLE",
      );
    }
    this.validateProxySelection(task.proxy_selection);
    if (item && this.aliasAccountBlock(item)) {
      try {
        await this.ensureAliasWebAuthorization(item);
      } catch {
        throw this.accountAliasBlockedError(item);
      }
    }
    if (item) this.validateRegistrationAccount(item);
  }

  async validateTrialRuntime(country) {
    const normalizedCountry = String(country || "").trim().toUpperCase();
    const config = TRIAL_CHECKS[normalizedCountry];
    if (!config || typeof this.registration.resolveRegisteredAccountTrialRoute !== "function") {
      throw failure(
        `${normalizedCountry || "当前国家"} 试用资格检测服务不可用`,
        503,
        "MAILCOM_PIPELINE_TRIAL_ROUTE_UNAVAILABLE",
      );
    }
    try {
      const route = await this.registration.resolveRegisteredAccountTrialRoute(normalizedCountry);
      if (!String(route || "").trim()) throw new Error("试用资格检测出口为空");
    } catch (error) {
      throw failure(
        `${config.label}试用资格检测出口不可用：${safeError(error, "请先配置对应国家的检测代理")}`,
        409,
        "MAILCOM_PIPELINE_TRIAL_ROUTE_UNAVAILABLE",
      );
    }
  }

  validatePaymentLinkRuntime() {
    let config;
    try {
      config = this.paymentLinks.configuration();
    } catch (error) {
      throw failure(
        `提链服务状态读取失败：${safeError(error, "提链服务当前不可用")}`,
        503,
        "MAILCOM_PIPELINE_LINK_UNAVAILABLE",
      );
    }
    if (!config?.configured) throw failure("提链服务尚未配置", 503, "MAILCOM_PIPELINE_LINK_UNAVAILABLE");
    if (!Number(config.checkout_proxy_count || 0)) {
      throw failure("Checkout Proxy 池为空", 409, "MAILCOM_PIPELINE_CHECKOUT_PROXY_EMPTY");
    }
    if (config.apply_checkout_update && !Number(config.update_proxy_count || 0)) {
      throw failure("Update Proxy 池为空", 409, "MAILCOM_PIPELINE_UPDATE_PROXY_EMPTY");
    }
  }

  validateAgreementRuntime() {
    let settings;
    try {
      settings = this.paymentAgreements.settings();
    } catch (error) {
      throw failure(
        `协议授权配置读取失败：${safeError(error, "协议授权服务当前不可用")}`,
        503,
        "MAILCOM_PIPELINE_AGREEMENT_UNAVAILABLE",
      );
    }
    if (!settings?.protocol_configured) {
      throw failure("协议授权服务尚未配置", 409, "MAILCOM_PIPELINE_AGREEMENT_UNAVAILABLE");
    }
    if (!settings?.configured || !settings?.api_key_configured) {
      throw failure("HeroSMS 尚未配置", 409, "MAILCOM_PIPELINE_AGREEMENT_UNAVAILABLE");
    }
    let runtime;
    try {
      runtime = this.paymentAgreements.runtime({ required: true });
    } catch (error) {
      throw failure(
        `协议授权运行配置不可用：${safeError(error, "协议授权国家或代理池尚未配置")}`,
        409,
        "MAILCOM_PIPELINE_AGREEMENT_UNAVAILABLE",
      );
    }
    if (!runtime?.configured || !String(runtime.country || "").trim()
      || !Number(runtime.proxy_count ?? runtime.proxies?.length ?? 0)) {
      throw failure("协议授权国家或代理池尚未配置", 409, "MAILCOM_PIPELINE_AGREEMENT_UNAVAILABLE");
    }
    return runtime;
  }

  connectedAccounts() {
    return this.db.prepare(`
      SELECT * FROM source_accounts
      WHERE provider = 'mailcom' AND status = 'connected'
        AND limit_reason NOT LIKE ?
      ORDER BY id
    `).all(`${ALIAS_ACTION_REQUIRED_REASON_PREFIX}%`);
  }

  primaryAddress(account) {
    return this.db.prepare(`
      SELECT * FROM addresses
      WHERE account_id = ? AND kind = 'primary' AND status = 'active'
      ORDER BY address = ? COLLATE NOCASE DESC, id LIMIT 1
    `).get(account.id, account.email);
  }

  isMotherPrimaryItem(item) {
    if (!item || item.slot_kind !== "primary") return false;
    const current = item.current_address_id ? this.db.prepare(`
      SELECT kind, address FROM addresses WHERE id = ? AND account_id = ?
    `).get(item.current_address_id, item.account_id) : null;
    if (current) return current.kind === "primary";
    const email = String(item.current_email || "").trim().toLowerCase();
    return Boolean(email) && new Set([
      String(item.source_email || "").trim().toLowerCase(),
      String(item.initial_email || "").trim().toLowerCase(),
    ]).has(email);
  }

  localMailcomAliasHistoryCount(accountId) {
    return Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM addresses
      WHERE account_id = ? AND kind = 'official' AND strategy = ?
        AND status IN ('active', 'disabled')
    `).get(Number(accountId), MAILCOM_ALIAS_STRATEGY)?.count || 0);
  }

  localMailcomActiveAddressCount(accountId) {
    return Number(this.db.prepare(`
      SELECT COUNT(DISTINCT lower(address)) AS count FROM addresses
      WHERE account_id = ? AND status = 'active'
        AND (kind = 'primary' OR (kind = 'official' AND strategy = ?))
    `).get(Number(accountId), MAILCOM_ALIAS_STRATEGY)?.count || 0);
  }

  replacementCapacityError(item, { deletableAliasCount = 0 } = {}) {
    const historyCount = this.localMailcomAliasHistoryCount(item?.account_id);
    if (historyCount >= mailcomAliasHistoryLimit) {
      return failure(
        `Mail.com 历史别名创建额度已耗尽（本地已记录 ${historyCount} 个官方别名），已停止补建以免删除后无法恢复`,
        409,
        "MAILCOM_ALIAS_LIFETIME_QUOTA_EXHAUSTED",
      );
    }
    if (this.isMotherPrimaryItem(item)) {
      const activeCount = this.localMailcomActiveAddressCount(item.account_id);
      if (activeCount >= mailcomAliasPreparedAddressTarget && Number(deletableAliasCount) < 1) {
        return failure(
          `母号主地址已保留；当前 ${activeCount} 个 Mail.com 地址已占满，且其余地址均为 Plus、blocked、已提链或其他受保护账号，没有可安全删除的官方别名`,
          409,
          "MAILCOM_ALIAS_REPLACEMENT_CAPACITY_FULL",
        );
      }
    }
    return null;
  }

  hasSuccessfulAgreement(email) {
    const normalized = String(email || "").trim().toLowerCase();
    if (!normalized) return false;
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM mailcom_registration_pipeline_attempts
      WHERE email = ? COLLATE NOCASE
        AND agreement_status = 'succeeded'
      LIMIT 1
    `).get(normalized));
  }

  latestAttemptForAddress(accountId, email) {
    const normalizedAccountId = Number(accountId);
    const normalizedEmail = String(email || "").trim();
    if (!Number.isSafeInteger(normalizedAccountId) || normalizedAccountId <= 0 || !normalizedEmail) {
      return null;
    }
    return this.db.prepare(`
      SELECT attempts.*
      FROM mailcom_registration_pipeline_attempts AS attempts
      JOIN mailcom_registration_pipeline_items AS items ON items.id = attempts.item_id
      WHERE items.account_id = ?
        AND attempts.email = ? COLLATE NOCASE
      ORDER BY attempts.id DESC
      LIMIT 1
    `).get(normalizedAccountId, normalizedEmail);
  }

  historicalAddressPreservation(accountId, email) {
    const blocked = this.latestAttemptForAddress(accountId, email);
    if (blocked
      && blocked.outcome === "link_blocked"
      && blocked.stage !== "link_blocked_released"
      && blocked.recycle_status === "skipped"
      && String(blocked.external_account_id || "").trim()) {
      return {
        stage: "link_blocked_preserved",
        error: "历史提链 blocked，账号池和邮箱均已保留",
      };
    }
    const latest = this.latestAttemptForAnyAddress(accountId, email);
    if (this.registeredAccountIsPlus(latest || { email })) {
      return {
        stage: "plus_preserved",
        error: "历史 Plus 账号，账号池和邮箱均已保留",
      };
    }
    if (this.hasSuccessfulAgreement(email)) {
      return { stage: "agreement_preserved", error: "" };
    }
    return null;
  }

  releaseBlockedAccounts(deletedAccounts = []) {
    const normalized = [...new Map((Array.isArray(deletedAccounts) ? deletedAccounts : [])
      .map((value) => ({
        id: Number(value?.id ?? value),
        email: String(value?.email || "").trim().toLowerCase(),
      }))
      .filter((value) => Number.isSafeInteger(value.id) && value.id > 0 && value.email)
      .map((value) => [`${value.id}:${value.email}`, value])).values()];
    if (!normalized.length) return { released: 0, resumed: 0, pipeline_ids: [] };

    const releasedAttempts = [];
    const pipelineIds = new Set();
    let resumed = 0;
    const at = nowIso();
    this.db.transaction(() => {
      const find = this.db.prepare(`
        SELECT attempts.id, attempts.item_id, attempts.pipeline_id, attempts.email,
          items.account_id, pipelines.status AS pipeline_status
        FROM mailcom_registration_pipeline_attempts AS attempts
        JOIN mailcom_registration_pipeline_items AS items ON items.id = attempts.item_id
        JOIN mailcom_registration_pipelines AS pipelines ON pipelines.id = attempts.pipeline_id
        WHERE attempts.external_account_id = ?
          AND attempts.email = ? COLLATE NOCASE
          AND attempts.outcome = 'link_blocked'
          AND attempts.recycle_status = 'skipped'
      `);
      const releaseAttempt = this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET external_account_id = '', stage = 'link_blocked_released', updated_at = ?
        WHERE id = ? AND external_account_id = ? AND email = ? COLLATE NOCASE
          AND outcome = 'link_blocked' AND recycle_status = 'skipped'
      `);
      const resumeCurrent = this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET current_attempt_id = NULL, status = 'queued', stage = 'registration_queued',
          error = '', next_retry_at = NULL, finished_at = NULL, updated_at = ?
        WHERE id = ? AND current_attempt_id = ?
          AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
      `);
      const findPreserved = this.db.prepare(`
        SELECT items.id, items.pipeline_id
        FROM mailcom_registration_pipeline_items AS items
        JOIN mailcom_registration_pipelines AS pipelines ON pipelines.id = items.pipeline_id
        WHERE items.account_id = ? AND items.current_email = ? COLLATE NOCASE
          AND items.stage = 'link_blocked_preserved'
          AND items.status IN ('completed', 'failed', 'cancelled', 'interrupted')
          AND pipelines.status IN ('queued', 'running')
      `);
      const resumePreserved = this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET current_attempt_id = NULL, status = 'queued', stage = 'registration_queued',
          error = '', next_retry_at = NULL, finished_at = NULL, updated_at = ?
        WHERE id = ? AND stage = 'link_blocked_preserved'
          AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
      `);

      for (const account of normalized) {
        for (const attempt of find.all(String(account.id), account.email)) {
          const changed = releaseAttempt.run(
            at,
            attempt.id,
            String(account.id),
            account.email,
          ).changes;
          if (!changed) continue;
          releasedAttempts.push(attempt);
          if (new Set(["queued", "running"]).has(attempt.pipeline_status)) {
            pipelineIds.add(String(attempt.pipeline_id));
            resumed += resumeCurrent.run(at, attempt.item_id, attempt.id).changes;
          }
          for (const item of findPreserved.all(attempt.account_id, attempt.email)) {
            pipelineIds.add(String(item.pipeline_id));
            resumed += resumePreserved.run(at, item.id).changes;
          }
        }
      }
    })();

    for (const pipelineId of pipelineIds) {
      this.recompute(pipelineId);
      if (this.trackers.has(pipelineId)) this.trackerRestarts.add(pipelineId);
      else this.startTracker(pipelineId);
    }
    return {
      released: releasedAttempts.length,
      resumed,
      pipeline_ids: [...pipelineIds],
    };
  }

  registeredAccountIsPlus(attempt) {
    if (!attempt) return false;
    const externalId = String(attempt.external_account_id || "").trim();
    const email = String(attempt.email || "").trim().toLowerCase();
    if (!externalId && !email) return false;
    try {
      const row = this.db.prepare(`
        SELECT 1
        FROM registered_account_status_checks
        WHERE (
          (? <> '' AND external_account_id = ?)
          OR (? <> '' AND email = ? COLLATE NOCASE)
        )
          AND (
            lower(account_type) = 'plus'
            OR lower(account_type_raw) LIKE '%plus%'
            OR lower(subscription_status) IN ('active', 'subscribed')
          )
        LIMIT 1
      `).get(externalId, externalId, email, email);
      return Boolean(row);
    } catch (error) {
      throw Object.assign(
        failure(
          "无法确认注册账号是否为 Plus，已停止账号池删除和邮箱轮换",
          503,
          "MAILCOM_PIPELINE_ACCOUNT_PROTECTION_UNAVAILABLE",
        ),
        { cause: error },
      );
    }
  }

  protectedRegisteredAccount(attempt) {
    if (!attempt) return false;
    const blockedReleased = attempt.outcome === "link_blocked"
      && String(attempt.stage || "") === "link_blocked_released"
      && !String(attempt.external_account_id || "").trim();
    return (attempt.outcome === "link_blocked" && !blockedReleased)
      || attempt.link_status === "succeeded"
      || new Set(["succeeded", "uncertain"]).has(String(attempt.agreement_status || ""))
      || this.registeredAccountIsPlus(attempt);
  }

  registeredAccountRemovalOutcome(attempt) {
    if (!attempt?.external_account_id) return false;
    return new Set([
      "trial_ineligible", "trial_account_not_found", "account_not_found", "link_failed",
    ]).has(String(attempt.outcome || ""));
  }

  registeredAccountRemovalRequired(attempt) {
    return this.registeredAccountRemovalOutcome(attempt) && !this.protectedRegisteredAccount(attempt);
  }

  latestAttemptForAnyAddress(accountId, email) {
    const normalizedAccountId = Number(accountId);
    const normalizedEmail = String(email || "").trim();
    if (!Number.isSafeInteger(normalizedAccountId) || normalizedAccountId <= 0 || !normalizedEmail) {
      return null;
    }
    return this.db.prepare(`
      SELECT attempts.*
      FROM mailcom_registration_pipeline_attempts AS attempts
      JOIN mailcom_registration_pipeline_items AS items ON items.id = attempts.item_id
      WHERE items.account_id = ?
        AND attempts.email = ? COLLATE NOCASE
      ORDER BY attempts.id DESC
      LIMIT 1
    `).get(normalizedAccountId, normalizedEmail);
  }

  addressHasProtectedHistory(accountId, email) {
    const normalizedAccountId = Number(accountId);
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!Number.isSafeInteger(normalizedAccountId) || normalizedAccountId <= 0 || !normalizedEmail) {
      return false;
    }
    if (this.hasSuccessfulAgreement(normalizedEmail)) return true;
    try {
      return Boolean(this.db.prepare(`
        SELECT 1
        FROM mailcom_registration_pipeline_attempts AS attempts
        JOIN mailcom_registration_pipeline_items AS items ON items.id = attempts.item_id
        WHERE items.account_id = ?
          AND attempts.email = ? COLLATE NOCASE
          AND (
            (attempts.outcome = 'link_blocked'
              AND trim(attempts.external_account_id) <> ''
              AND attempts.stage <> 'link_blocked_released')
            OR attempts.link_status = 'succeeded'
            OR attempts.agreement_status IN ('succeeded', 'uncertain')
          )
        LIMIT 1
      `).get(normalizedAccountId, normalizedEmail));
    } catch (error) {
      throw Object.assign(
        failure(
          "无法确认 Mail.com 地址的历史保护状态，已停止自动删除",
          503,
          "MAILCOM_PIPELINE_ACCOUNT_PROTECTION_UNAVAILABLE",
        ),
        { cause: error },
      );
    }
  }

  hasActiveRegistrationForAddress(accountId, addressId, email) {
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM registration_jobs
      WHERE deleted_at IS NULL
        AND (
          (account_id = ? AND (address_id = ? OR base_address_id = ?))
          OR email = ? COLLATE NOCASE
        )
        AND lower(status) IN ('queued', 'pending', 'claimed', 'running', 'paused', 'cancel_requested')
      LIMIT 1
    `).get(accountId, addressId, addressId, email));
  }

  motherAliasCandidates(item) {
    if (!item || !this.isMotherPrimaryItem(item)) return [];
    const aliases = this.db.prepare(`
      SELECT * FROM addresses
      WHERE account_id = ? AND kind = 'official' AND strategy = ? AND status = 'active'
      ORDER BY created_at, id
    `).all(item.account_id, MAILCOM_ALIAS_STRATEGY);
    const activeAssignments = this.db.prepare(`
      SELECT current_address_id, current_email, replacement_email
      FROM mailcom_registration_pipeline_items AS items
      JOIN mailcom_registration_pipelines AS pipelines ON pipelines.id = items.pipeline_id
      WHERE items.account_id = ?
        AND items.status IN ('queued', 'running', 'retry_wait', 'cancel_requested')
        AND pipelines.status IN ('queued', 'running', 'cancel_requested')
    `).all(item.account_id);
    const assignedIds = new Set(activeAssignments.map((row) => Number(row.current_address_id)).filter(Boolean));
    const assignedEmails = new Set(activeAssignments.flatMap((row) => [
      String(row.current_email || "").trim().toLowerCase(),
      String(row.replacement_email || "").trim().toLowerCase(),
    ]).filter(Boolean));
    const candidates = [];
    for (const alias of aliases) {
      const email = String(alias.address || "").trim().toLowerCase();
      if (!email || assignedIds.has(Number(alias.id)) || assignedEmails.has(email)) continue;
      if (this.hasActiveRegistrationForAddress(item.account_id, alias.id, email)) continue;
      if (this.addressHasProtectedHistory(item.account_id, email)) continue;
      const latest = this.latestAttemptForAnyAddress(item.account_id, email);
      if (!latest || !TERMINAL_ATTEMPT_STATUSES.has(String(latest.status || ""))) continue;
      if (this.protectedRegisteredAccount(latest)) continue;
      if (!DELETABLE_MOTHER_ALIAS_OUTCOMES.has(String(latest.outcome || ""))) continue;
      if (String(latest.recycle_status || "") === "running"
        || String(latest.recycle_status || "") === "retry_wait") continue;
      // An external account is only safe after the account-pool cleanup has
      // completed.  In practice such an attempt usually points at a disabled
      // old alias, but retaining this guard prevents deleting a live account
      // if local state is mid-recovery.
      if (String(latest.external_account_id || "").trim()
        && String(latest.stage || "") !== "account_pool_deleted"
        && String(latest.recycle_status || "") !== "succeeded") continue;
      candidates.push({ ...alias, latest_attempt: latest });
    }
    const rank = new Map([
      ["trial_ineligible", 0],
      ["trial_account_not_found", 1],
      ["account_not_found", 1],
      ["unavailable", 2],
      ["registration_failed", 3],
      ["link_failed", 4],
    ]);
    return candidates.sort((left, right) => (
      (rank.get(String(left.latest_attempt?.outcome || "")) ?? 99)
      - (rank.get(String(right.latest_attempt?.outcome || "")) ?? 99)
    ) || Number(left.id) - Number(right.id));
  }

  motherAliasCandidatePending(item) {
    if (!item || !this.isMotherPrimaryItem(item)) return false;
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM mailcom_registration_pipeline_items
      WHERE pipeline_id = ? AND account_id = ? AND slot_kind = 'official'
        AND status IN ('queued', 'running', 'retry_wait', 'cancel_requested')
      LIMIT 1
    `).get(item.pipeline_id, item.account_id));
  }

  motherAliasCandidateWaitingError(item) {
    return failure(
      `母号 ${String(item?.source_email || "").trim()} 当前已有 10 个 Mail.com 地址；正在等待普通官方别名完成检测，确认不是 Plus/blocked 后再安全释放，不会创建第 11 个地址`,
      409,
      "MAILCOM_ALIAS_REPLACEMENT_CANDIDATE_PENDING",
    );
  }

  candidateProtectionError(error) {
    return MOTHER_ALIAS_CANDIDATE_PROTECTION_CODES.has(String(error?.code || ""));
  }

  registeredAccountCleanupCommitted(attempt) {
    return this.registeredAccountRemovalOutcome(attempt)
      && attempt.recycle_status === "running"
      && !this.protectedRegisteredAccount(attempt);
  }

  async deleteRegisteredAccountForReplacement(attempt) {
    if (!this.registeredAccountRemovalOutcome(attempt)) return false;
    const accountId = Number(attempt.external_account_id);
    if (typeof this.registration.deleteRegisteredAccountForPipeline !== "function") {
      throw failure(
        "注册账号池删除服务不可用",
        503,
        "MAILCOM_PIPELINE_ACCOUNT_DELETE_UNAVAILABLE",
      );
    }
      await this.registration.deleteRegisteredAccountForPipeline({
        id: accountId,
        email: attempt.email,
        registrationJobId: attempt.registration_job_id,
      });
    return true;
  }

  beginRegisteredAccountDelete(attemptId) {
    let attempt = this.attemptRow(attemptId);
    if (!attempt || !this.registeredAccountRemovalRequired(attempt)) return null;
    if (this.registeredAccountCleanupCommitted(attempt)) return attempt;
    if (attempt.recycle_status !== "pending") return null;
    const at = nowIso();
    let changed = 0;
    this.db.transaction(() => {
      changed = this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'running', stage = 'account_pool_delete_started',
          recycle_error = '', next_retry_at = NULL, updated_at = ?
        WHERE id = ? AND recycle_status = 'pending'
          AND EXISTS (
            SELECT 1
            FROM mailcom_registration_pipeline_items AS items
            JOIN mailcom_registration_pipelines AS pipelines ON pipelines.id = items.pipeline_id
            WHERE items.id = mailcom_registration_pipeline_attempts.item_id
              AND items.status IN ('queued', 'running', 'retry_wait')
              AND pipelines.status IN ('queued', 'running')
          )
      `).run(at, attempt.id).changes;
      if (changed) {
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_items
          SET status = 'running', stage = 'account_pool_delete_started',
            error = '', next_retry_at = NULL, updated_at = ?
          WHERE id = ? AND status IN ('queued', 'running', 'retry_wait')
        `).run(at, attempt.item_id);
      }
    })();
    if (!changed) return null;
    this.recomputeItem(attempt.item_id);
    return this.attemptRow(attempt.id);
  }

  markRegisteredAccountDeleteMismatch(attempt, error) {
    const message = safeError(error, "账号池记录与流水线不匹配，未删除邮箱");
    this.db.prepare(`
      UPDATE mailcom_registration_pipeline_attempts
      SET recycle_status = 'failed', stage = 'account_pool_delete_failed',
        recycle_error = ?, next_retry_at = NULL, updated_at = ?
      WHERE id = ? AND recycle_status = 'running'
        AND stage IN ('account_pool_delete_started', 'account_pool_delete_retry_wait')
    `).run(message, nowIso(), attempt.id);
    return message;
  }

  markRegisteredAccountDeleted(attempt) {
    const at = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET stage = 'account_pool_deleted', recycle_error = '', next_retry_at = NULL, updated_at = ?
        WHERE id = ? AND recycle_status = 'running'
          AND stage IN ('account_pool_delete_started', 'account_pool_delete_retry_wait', 'account_pool_deleted')
      `).run(at, attempt.id);
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET stage = 'account_pool_deleted', error = '', next_retry_at = NULL, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running', 'retry_wait')
      `).run(at, attempt.item_id);
    })();
    this.recomputeItem(attempt.item_id);
  }

  async ensureRegisteredAccountDeleted(attemptId, { allowStart = true } = {}) {
    const key = Number(attemptId);
    if (this.accountPoolDeletions.has(key)) return this.accountPoolDeletions.get(key);
    const operation = (async () => {
      let attempt = this.attemptRow(key);
      if (!attempt || !this.registeredAccountRemovalOutcome(attempt)) {
        return { status: "not_required", attempt };
      }
      if (this.protectedRegisteredAccount(attempt)) {
        const item = this.itemRow(attempt.item_id);
        if (item) this.preserveProtectedRecycle(attempt, item);
        return { status: "protected", attempt: this.attemptRow(key) };
      }
      if (attempt.stage === "account_pool_delete_failed" || attempt.recycle_status === "failed") {
        return { status: "mismatch", attempt, error: attempt.recycle_error || attempt.error };
      }
      if (!ACCOUNT_POOL_DELETE_PENDING_STAGES.has(String(attempt.stage || ""))) {
        if (this.registeredAccountCleanupCommitted(attempt)) {
          return { status: "deleted", attempt };
        }
        if (!allowStart) return { status: "not_started", attempt };
        attempt = this.beginRegisteredAccountDelete(attempt.id);
        if (!attempt) return { status: "cancelled", attempt: this.attemptRow(key) };
      }
      const retryAt = Date.parse(attempt.next_retry_at || "");
      if (Number.isFinite(retryAt) && retryAt > Date.now()) {
        return { status: "retry_wait", attempt };
      }
      try {
        await this.deleteRegisteredAccountForReplacement(attempt);
      } catch (error) {
        if (String(error?.code || "") === "PIPELINE_REGISTERED_ACCOUNT_PROTECTED") {
          attempt = this.attemptRow(key);
          const item = attempt ? this.itemRow(attempt.item_id) : null;
          if (attempt && item) this.preserveProtectedRecycle(attempt, item);
          return { status: "protected", attempt: this.attemptRow(key), error: safeError(error) };
        }
        if (String(error?.code || "") === "PIPELINE_REGISTERED_ACCOUNT_MISMATCH") {
          const message = this.markRegisteredAccountDeleteMismatch(attempt, error);
          return { status: "mismatch", attempt: this.attemptRow(key), error: message };
        }
        const item = this.itemRow(attempt.item_id);
        this.scheduleRegisteredAccountDeleteRetry(attempt, item, error);
        return { status: "retry_wait", attempt: this.attemptRow(key), error: safeError(error) };
      }
      this.markRegisteredAccountDeleted(attempt);
      return { status: "deleted", attempt: this.attemptRow(key) };
    })().finally(() => this.accountPoolDeletions.delete(key));
    this.accountPoolDeletions.set(key, operation);
    return operation;
  }

  scheduleRegisteredAccountDeleteRetry(attempt, item, error) {
    if (!attempt || !item) return;
    const retryCount = Number(item.retry_count || 0) + 1;
    const next = new Date(Date.now() + this.retryDelay(retryCount)).toISOString();
    const message = safeError(error, "账号池删除失败，等待重试");
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET stage = 'account_pool_delete_retry_wait', recycle_error = ?, next_retry_at = ?, updated_at = ?
        WHERE id = ? AND recycle_status = 'running'
          AND stage IN ('account_pool_delete_started', 'account_pool_delete_retry_wait')
      `).run(message, next, nowIso(), attempt.id);
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET status = 'retry_wait', stage = 'account_pool_delete_retry_wait', retry_count = ?,
          next_retry_at = ?, error = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running', 'retry_wait')
      `).run(retryCount, next, message, nowIso(), item.id);
    })();
    this.recomputeItem(item.id);
  }

  async start(raw = {}) {
    await this.recoveryPromise;
    if (this.closed) throw failure("Mail.com 流水线服务正在关闭", 503, "MAILCOM_PIPELINE_CLOSED");
    const input = normalizeInput(raw);
    const fingerprint = requestFingerprint(input);
    const existing = this.requestRow(input.requestId);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) {
        throw failure("requestId 已被不同请求使用", 409, "MAILCOM_PIPELINE_IDEMPOTENCY_CONFLICT");
      }
      return this.publicTask(existing);
    }
    const active = this.db.prepare(`
      SELECT id FROM mailcom_registration_pipelines
      WHERE status IN ('queued', 'running', 'cancel_requested') LIMIT 1
    `).get();
    if (active) throw failure("已有 Mail.com 无限注册提链流水线正在运行", 409, "MAILCOM_PIPELINE_ACTIVE");
    const orphanRecycle = this.db.prepare(`
      SELECT attempts.id
      FROM mailcom_registration_pipeline_attempts AS attempts
      JOIN mailcom_registration_pipelines AS pipelines ON pipelines.id = attempts.pipeline_id
      WHERE attempts.recycle_status = 'running'
        AND pipelines.status IN ('completed', 'partial_failed', 'failed', 'cancelled', 'interrupted')
      LIMIT 1
    `).get();
    if (orphanRecycle) {
      throw failure(
        "上次取消的 Mail.com 别名轮换正在恢复，请稍后重试",
        409,
        "MAILCOM_PIPELINE_RECOVERY_ACTIVE",
      );
    }
    await this.recoverSavedAuthorizations();
    const accounts = this.connectedAccounts();
    if (!accounts.length) throw failure("没有已连接的 Mail.com 母号", 409, "MAILCOM_PIPELINE_ACCOUNTS_EMPTY");
    await this.validateDependencies();
    this.validateProxySelection(input.proxySelection);
    await this.validateTrialRuntime(input.paymentLinkCountry);
    const taskId = crypto.randomUUID();
    const at = nowIso();
    try {
      this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO mailcom_registration_pipelines (
            id, request_id, request_fingerprint, domain, status, stage, concurrency,
            browser_mode, proxy_selection, payment_link_country, link_attempts, recycle_succeeded,
            account_count, slot_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'queued', 'preparation_queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          taskId,
          input.requestId,
          fingerprint,
          input.domain,
          input.concurrency,
          input.browserMode,
          input.proxySelection,
          input.paymentLinkCountry,
          input.linkAttempts,
          input.recycleSucceeded ? 1 : 0,
          accounts.length,
          accounts.length,
          at,
          at,
        );
        const insert = this.db.prepare(`
          INSERT INTO mailcom_registration_pipeline_items (
            pipeline_id, account_id, source_email, slot_key, slot_kind,
            initial_address_id, initial_email, current_address_id, current_email,
            status, stage, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'primary', ?, ?, ?, ?, 'queued', 'prepare_queued', ?, ?)
        `);
        accounts.forEach((account) => {
          const address = this.primaryAddress(account);
          insert.run(
            taskId,
            account.id,
            account.email,
            `primary:${account.id}`,
            address?.id || null,
            address?.address || account.email,
            address?.id || null,
            address?.address || account.email,
            at,
            at,
          );
        });
      })();
    } catch (error) {
      const winner = this.requestRow(input.requestId);
      if (winner) {
        if (winner.request_fingerprint !== fingerprint) {
          throw failure("requestId 已被不同请求使用", 409, "MAILCOM_PIPELINE_IDEMPOTENCY_CONFLICT");
        }
        return this.publicTask(winner);
      }
      if (String(error?.message || "").includes("idx_mailcom_registration_pipeline_active")
        || String(error?.message || "").includes("UNIQUE constraint")) {
        throw failure("已有 Mail.com 无限注册提链流水线正在运行", 409, "MAILCOM_PIPELINE_ACTIVE");
      }
      throw error;
    }
    this.startTracker(taskId);
    return this.publicTask(taskId);
  }

  get(id) {
    const task = this.publicTask(id);
    if (!task) throw failure("Mail.com 流水线不存在", 404, "MAILCOM_PIPELINE_NOT_FOUND");
    return task;
  }

  successfulAccounts(id, query = {}) {
    const task = this.taskRow(id);
    if (!task) throw failure("Mail.com 流水线不存在", 404, "MAILCOM_PIPELINE_NOT_FOUND");
    const { limit = 50, offset = 0 } = query;
    const rawBeforeId = query.before_id ?? query.beforeId ?? "";
    const parsedLimit = Number(limit);
    const parsedOffset = Number(offset);
    const hasCursor = rawBeforeId !== "" && rawBeforeId !== undefined && rawBeforeId !== null;
    const beforeId = hasCursor ? Number(rawBeforeId) : null;
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw failure("limit 必须是 1 到 100 的整数");
    }
    if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0 || parsedOffset > 1_000_000) {
      throw failure("offset 必须是 0 到 1000000 的整数");
    }
    if (hasCursor && (!Number.isSafeInteger(beforeId) || beforeId < 1)) {
      throw failure("before_id 必须是正整数");
    }
    const select = `
      SELECT attempts.id, attempts.attempt_number, attempts.email,
        attempts.external_account_id, attempts.status, attempts.stage,
        attempts.registration_finished_at,
        attempts.link_finished_at, attempts.agreement_job_id,
        attempts.agreement_status, attempts.agreement_country,
        attempts.agreement_error, attempts.agreement_started_at,
        attempts.agreement_finished_at, items.source_email, items.slot_kind,
        links.request_country AS payment_link_country
      FROM mailcom_registration_pipeline_attempts AS attempts
      JOIN mailcom_registration_pipeline_items AS items ON items.id = attempts.item_id
      LEFT JOIN registered_account_payment_links AS links
        ON links.external_account_id = attempts.external_account_id
        AND links.task_id = attempts.payment_link_task_id
    `;
    const { total, rows } = this.db.transaction(() => ({
      total: Number(this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM mailcom_registration_pipeline_attempts
        WHERE pipeline_id = ? AND link_status = 'succeeded'
      `).get(task.id)?.count || 0),
      rows: hasCursor ? this.db.prepare(`${select}
        WHERE attempts.pipeline_id = ? AND attempts.link_status = 'succeeded'
          AND attempts.id < ?
        ORDER BY attempts.id DESC
        LIMIT ?
      `).all(task.id, beforeId, parsedLimit + 1) : this.db.prepare(`${select}
        WHERE attempts.pipeline_id = ? AND attempts.link_status = 'succeeded'
        ORDER BY attempts.id DESC
        LIMIT ? OFFSET ?
      `).all(task.id, parsedLimit + 1, parsedOffset),
    }))();
    const hasMore = rows.length > parsedLimit;
    const page = hasMore ? rows.slice(0, parsedLimit) : rows;
    return {
      pipeline_id: task.id,
      total,
      limit: parsedLimit,
      offset: parsedOffset,
      before_id: hasCursor ? String(beforeId) : "",
      has_more: hasMore,
      next_cursor: hasMore && page.length ? String(page[page.length - 1].id) : "",
      items: page.map((row) => ({
        id: row.id,
        cycle: row.attempt_number,
        email: row.email,
        external_account_id: publicExternalAccountId(row.external_account_id),
        source_email: row.source_email,
        slot_kind: row.slot_kind,
        payment_link_country: row.payment_link_country || task.payment_link_country || "",
        registration_finished_at: row.registration_finished_at,
        link_finished_at: row.link_finished_at,
        agreement_job_id: row.agreement_job_id,
        agreement_status: row.agreement_status,
        agreement_country: row.agreement_country,
        agreement_error: safeError(row.agreement_error, ""),
        agreement_started_at: row.agreement_started_at,
        agreement_finished_at: row.agreement_finished_at,
        status: row.status,
        stage: row.stage,
      })),
    };
  }

  startTracker(taskId) {
    const key = String(taskId);
    if (this.trackers.has(key)) return this.trackers.get(key);
    let tracker;
    tracker = this.runTask(key)
      .catch((error) => this.failActiveItems(key, error))
      .finally(() => {
        if (this.trackers.get(key) === tracker) this.trackers.delete(key);
        const restart = this.trackerRestarts.delete(key);
        if (!restart || this.closed) return;
        queueMicrotask(() => {
          const task = this.taskRow(key);
          if (!task || !new Set(["queued", "running"]).has(task.status)) return;
          if (this.items(key).some((item) => ACTIVE_ITEM_STATUSES.has(item.status))) {
            this.startTracker(key);
          }
        });
      });
    this.trackers.set(key, tracker);
    return tracker;
  }

  async failActiveItems(taskId, error) {
    const message = safeError(error);
    for (const item of this.items(taskId).filter((entry) => ACTIVE_ITEM_STATUSES.has(entry.status))) {
      this.finishItem(item.id, "failed", message);
    }
    this.recompute(taskId);
  }

  async preparePipeline(taskId, onAccountPrepared = () => undefined) {
    const task = this.taskRow(taskId);
    if (!task || TERMINAL_PIPELINE_STATUSES.has(task.status) || task.status === "cancel_requested") return;
    const primaries = this.items(taskId).filter((item) => item.slot_kind === "primary"
      && String(item.stage).startsWith("prepare_"));
    if (!primaries.length) return;
    this.db.prepare(`
      UPDATE mailcom_registration_pipelines
      SET status = 'running', stage = 'preparing_accounts', updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(nowIso(), taskId);
    const prepareOne = async (primary) => {
      if (this.closed) return;
      const parent = this.taskRow(taskId);
      if (!parent || parent.status === "cancel_requested" || TERMINAL_PIPELINE_STATUSES.has(parent.status)) return;
      try {
        await this.prepareAccountItem(primary.id, parent.domain);
      } catch (error) {
        try {
          this.persistPrepareFailure(primary.id, error);
        } catch (persistError) {
          // A bookkeeping/sync error must not escape the mother loop and fail every other account.
          try {
            await this.isolateSlotFailure(primary.id, persistError);
          } catch {
            // Keep advancing even if the isolated failure cannot be persisted right now.
          }
        }
      }
      const ready = this.itemRow(primary.id);
      const current = this.taskRow(taskId);
      if (ready && current && !this.closed
        && !String(ready.stage).startsWith("prepare_")
        && current.status !== "cancel_requested"
        && !TERMINAL_PIPELINE_STATUSES.has(current.status)) {
        try {
          await onAccountPrepared(ready.account_id);
        } catch (error) {
          // launchPreparedAccount is intentionally account-scoped; a synchronous setup error
          // must not reject preparePipeline and trigger the global failActiveItems fallback.
          try {
            await this.isolateSlotFailure(ready.id, error);
          } catch {
            // The next mother still gets a chance even when this item's audit write fails.
          }
        }
      }
    };
    // Queue every mother before the first account can start recycling aliases.
    // Remote operations remain serialized, but preparation can no longer be
    // starved behind failures produced by an earlier prepared account.
    await Promise.allSettled(primaries.map((primary) => prepareOne(primary)));
    this.recompute(taskId);
  }

  persistPrepareFailure(itemId, error) {
    if (this.closed) return;
    let item = this.itemRow(itemId);
    if (!item || this.itemWasCancelled(itemId)) return;
    const createConflict = this.tripAliasCreateConflict(item, error);
    const message = createConflict
      ? ALIAS_CREATE_CONFLICT_ERROR
      : safeError(error, "Mail.com 别名准备失败");
    if (this.aliasAccountActionRequired(error)) this.tripAliasAccount(item, error);
    this.db.prepare(`
      UPDATE mailcom_registration_pipeline_items
      SET status = 'queued', stage = 'registration_queued', prepare_error = ?,
        updated_at = ? WHERE id = ? AND stage LIKE 'prepare_%'
    `).run(message, nowIso(), itemId);
    item = this.itemRow(itemId);
    if (!item) return;
    try {
      this.syncOfficialSlots(item.pipeline_id, item.account_id);
    } catch (syncError) {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET prepare_error = ?, updated_at = ? WHERE id = ?
      `).run(safeError(syncError, message), nowIso(), itemId);
    }
    this.recompute(item.pipeline_id);
  }

  async prepareAccountItem(itemId, domain) {
    let item = this.itemRow(itemId);
    if (!item || !String(item.stage).startsWith("prepare_")) return;
    let result = null;
    let prepareError = "";
    let created = 0;
    try {
      result = await this.serializeAliasRemote(item.account_id, async () => {
        item = this.itemRow(itemId);
        if (this.closed || !item || this.itemWasCancelled(item.id)) {
          throw failure("Mail.com 别名准备已取消", 409, "MAILCOM_PIPELINE_CANCELLED");
        }
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_items
          SET status = 'running', stage = 'prepare_running', updated_at = ?
          WHERE id = ? AND stage IN ('prepare_queued', 'prepare_running')
        `).run(nowIso(), itemId);
        return this.mailcomAliases.prepareAccount(item.account_id, { domain });
      });
      created = Math.max(0, Number(result?.counts?.created ?? result?.created ?? 0) || 0);
    } catch (error) {
      const createConflict = this.tripAliasCreateConflict(item, error);
      prepareError = createConflict
        ? ALIAS_CREATE_CONFLICT_ERROR
        : safeError(error, "Mail.com 别名准备失败");
      created = Math.max(0, Number(error?.partial?.created || 0) || 0);
      if (this.aliasAccountActionRequired(error)) this.tripAliasAccount(item, error);
    }
    if (this.closed) return;
    item = this.itemRow(itemId);
    if (!item || this.itemWasCancelled(itemId)) return;
    const preservation = this.historicalAddressPreservation(
      item.account_id,
      item.current_email || item.source_email,
    );
    const preservePrimary = Boolean(preservation);
    const finishedAt = preservePrimary ? nowIso() : null;
    this.db.prepare(`
      UPDATE mailcom_registration_pipeline_items
      SET status = ?, stage = ?, prepare_error = ?,
        created_count = created_count + ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND stage = 'prepare_running'
    `).run(
      preservePrimary ? "completed" : "queued",
      preservePrimary ? preservation.stage : "registration_queued",
      prepareError,
      created,
      finishedAt,
      nowIso(),
      itemId,
    );
    this.syncOfficialSlots(item.pipeline_id, item.account_id);
    this.recompute(item.pipeline_id);
  }

  syncOfficialSlots(taskId, accountId) {
    const account = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(accountId));
    if (!account) return;
    const aliases = this.db.prepare(`
      SELECT * FROM addresses
      WHERE account_id = ? AND kind = 'official' AND strategy = ? AND status = 'active'
      ORDER BY created_at, id
    `).all(account.id, MAILCOM_ALIAS_STRATEGY);
    const existing = this.items(taskId).filter((item) => Number(item.account_id) === Number(account.id));
    const assignedIds = new Set(existing.map((item) => Number(item.current_address_id)).filter(Boolean));
    const assignedEmails = new Set(existing.flatMap((item) => [
      String(item.current_email || "").toLowerCase(),
      String(item.replacement_email || "").toLowerCase(),
    ]).filter(Boolean));
    const at = nowIso();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO mailcom_registration_pipeline_items (
        pipeline_id, account_id, source_email, slot_key, slot_kind,
        initial_address_id, initial_email, current_address_id, current_email,
        status, stage, error, created_at, updated_at, finished_at
      ) VALUES (?, ?, ?, ?, 'official', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      aliases.forEach((alias) => {
        if (assignedIds.has(Number(alias.id)) || assignedEmails.has(String(alias.address).toLowerCase())) return;
        const preservation = this.historicalAddressPreservation(account.id, alias.address);
        const preserved = Boolean(preservation);
        insert.run(
          taskId,
          account.id,
          account.email,
          `official:${alias.id}`,
          alias.id,
          alias.address,
          alias.id,
          alias.address,
          preserved ? "completed" : "queued",
          preserved ? preservation.stage : "registration_queued",
          preserved ? preservation.error : "",
          at,
          at,
          preserved ? at : null,
        );
      });
      this.db.prepare(`
        UPDATE mailcom_registration_pipelines SET slot_count = (
          SELECT COUNT(*) FROM mailcom_registration_pipeline_items WHERE pipeline_id = ?
        ), updated_at = ? WHERE id = ?
      `).run(taskId, at, taskId);
    })();
  }

  async runTask(taskId) {
    const initial = this.taskRow(taskId);
    if (!initial || initial.status === "cancel_requested"
      || TERMINAL_PIPELINE_STATUSES.has(initial.status) || this.closed) return;
    const registrationSemaphore = new Semaphore(initial.concurrency);
    const slotRuns = new Map();
    const launchPreparedAccount = (accountId) => {
      const task = this.taskRow(taskId);
      if (!task || this.closed || task.status === "cancel_requested"
        || TERMINAL_PIPELINE_STATUSES.has(task.status)) return;
      let accountItems = this.items(taskId)
        .filter((item) => Number(item.account_id) === Number(accountId));
      const primary = accountItems.find((item) => item.slot_kind === "primary");
      if (!primary || String(primary.stage).startsWith("prepare_")) return;
      this.syncOfficialSlots(taskId, accountId);
      accountItems = this.items(taskId)
        .filter((item) => Number(item.account_id) === Number(accountId));
      accountItems.forEach((item) => {
        if (TERMINAL_ITEM_STATUSES.has(item.status)
          || String(item.stage).startsWith("prepare_") || slotRuns.has(item.id)) return;
        let run;
        run = this.runSlot(item.id, registrationSemaphore)
          .catch(async (error) => {
            await this.isolateSlotFailure(item.id, error);
          })
          .finally(() => {
            if (slotRuns.get(item.id) === run) slotRuns.delete(item.id);
          });
        slotRuns.set(item.id, run);
      });
    };
    const launchAllPrepared = () => {
      this.items(taskId)
        .filter((item) => item.slot_kind === "primary" && !String(item.stage).startsWith("prepare_"))
        .forEach((item) => launchPreparedAccount(item.account_id));
    };

    this.db.prepare(`
      UPDATE mailcom_registration_pipelines SET status = 'running', updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(nowIso(), taskId);
    launchAllPrepared();
    await this.preparePipeline(taskId, launchPreparedAccount);
    launchAllPrepared();
    while (slotRuns.size) {
      await Promise.race([...slotRuns.values()]);
      launchAllPrepared();
    }
    this.recompute(taskId);
  }

  async isolateSlotFailure(itemId, error) {
    let item = this.itemRow(itemId);
    if (!item || TERMINAL_ITEM_STATUSES.has(item.status)) return;
    const message = safeError(error, "Mail.com 母号 slot 执行失败，已切换到下一个母号");
    const attempt = item.current_attempt_id ? this.attemptRow(item.current_attempt_id) : null;
    if (attempt && !TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
      const linkStage = String(attempt.stage).startsWith("link_")
        || String(attempt.stage).startsWith("trial_");
      const agreementStage = String(attempt.stage).startsWith("agreement_");
      try {
        this.finishAttempt(attempt.id, "failed",
          agreementStage ? "agreement_failed" : linkStage ? "link_failed" : "registration_failed",
          message, {
            failureReason: "slot_worker_failed",
            registrationStatus: agreementStage || linkStage ? "succeeded" : "failed",
            linkStatus: agreementStage ? "succeeded" : linkStage ? "failed" : "skipped",
            agreementStatus: agreementStage ? "failed" : "skipped",
          });
      } catch {
        // The item-level terminal state below still isolates this worker from other mothers.
      }
    }
    const currentAttempt = item.current_attempt_id ? this.attemptRow(item.current_attempt_id) : null;
    if (currentAttempt?.recycle_status === "pending") {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'skipped', recycle_error = ?, updated_at = ?
        WHERE id = ? AND recycle_status = 'pending'
      `).run(message, nowIso(), currentAttempt.id);
    }
    item = this.itemRow(itemId);
    if (item && !TERMINAL_ITEM_STATUSES.has(item.status)) this.finishItem(item.id, "failed", message);
  }

  async runSlot(itemId, registrationSemaphore) {
    while (!this.closed) {
      let item = this.itemRow(itemId);
      const parent = item ? this.taskRow(item.pipeline_id) : null;
      if (!item || !parent || TERMINAL_ITEM_STATUSES.has(item.status)
        || TERMINAL_PIPELINE_STATUSES.has(parent.status)) return;
      if (this.itemWasCancelled(itemId)) {
        await this.cancelItem(itemId);
        return;
      }
      if (item.status === "retry_wait") {
        const delay = Math.max(0, Date.parse(item.next_retry_at || "") - Date.now()) || this.retryBaseMs;
        await this.wait(itemId, delay);
        item = this.itemRow(itemId);
        if (!item || this.itemWasCancelled(itemId) || this.closed) continue;
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_items
          SET status = 'queued', next_retry_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'retry_wait'
        `).run(nowIso(), itemId);
      }
      try {
        await this.processCycle(itemId, registrationSemaphore);
      } catch (error) {
        await this.handleCycleError(itemId, error);
      }
      const latest = this.itemRow(itemId);
      if (latest) this.recompute(latest.pipeline_id);
      if (latest && !TERMINAL_ITEM_STATUSES.has(latest.status)) await this.wait(itemId, 0);
    }
  }

  unavailableAddressState(item) {
    const rows = this.db.prepare(`
      SELECT status, failure_reason, message
      FROM registration_jobs
      WHERE (address_id = ? OR base_address_id = ? OR email = ? COLLATE NOCASE)
        AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC
    `).all(item.current_address_id, item.current_address_id, item.current_email);
    const unavailable = rows.find((row) => unavailableRegistration(row));
    if (unavailable) return { reason: unavailableRegistration(unavailable), message: unavailable.message };
    const completed = rows.find((row) => row.status === "completed");
    if (completed) return { reason: "already_completed", message: "这个 Mail.com 地址已经用于成功注册" };
    const active = rows.find((row) => new Set([
      "queued", "pending", "claimed", "running", "paused", "cancel_requested",
    ]).has(String(row.status || "")));
    if (active) return { reason: "registration_in_progress", message: "这个 Mail.com 地址已有进行中的注册任务" };
    return null;
  }

  resumableRegistrationJob(item, attempt = null) {
    if (!item?.current_address_id && !item?.current_email) return null;
    const attemptCreatedAt = String(attempt?.created_at || "");
    return this.db.prepare(`
      SELECT * FROM registration_jobs
      WHERE (address_id = ? OR base_address_id = ? OR email = ? COLLATE NOCASE)
        AND deleted_at IS NULL
        AND (
          status IN ('queued', 'pending', 'claimed', 'running', 'paused', 'cancel_requested')
          OR (
            status = 'completed' AND trim(external_account_id) <> ''
            AND ? <> '' AND created_at >= ?
          )
        )
      ORDER BY CASE
        WHEN status = 'completed' THEN 0 ELSE 1 END,
        COALESCE(finished_at, updated_at, created_at) DESC, id DESC
      LIMIT 1
    `).get(
      item.current_address_id,
      item.current_address_id,
      item.current_email,
      attemptCreatedAt,
      attemptCreatedAt,
    );
  }

  resumeRegistrationJob(attemptId, job) {
    const attempt = this.attemptRow(attemptId);
    if (!attempt || !job) return attempt;
    if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
      const at = nowIso();
      this.db.transaction(() => {
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_attempts
          SET registration_job_id = NULL, external_account_id = '', status = 'queued',
            stage = 'registration_queued', outcome = '', registration_status = 'queued',
            trial_country = '', trial_status = 'pending', trial_error = '', trial_checked_at = NULL,
            payment_link_task_id = '', payment_link_url = '', link_status = 'pending',
            link_attempt_count = 0, agreement_job_id = '', agreement_status = 'pending',
            agreement_country = '', agreement_error = '', failure_reason = '', error = '',
            recycle_status = 'pending', recycle_attempts = 0, recycle_error = '',
            replacement_address_id = NULL, replacement_email = '', next_retry_at = NULL,
            registration_finished_at = NULL, link_finished_at = NULL,
            agreement_started_at = NULL, agreement_finished_at = NULL, finished_at = NULL,
            updated_at = ? WHERE id = ?
        `).run(at, attempt.id);
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_items
          SET status = 'running', stage = 'registration_queued', replacement_email = '', error = '',
            next_retry_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?
        `).run(at, attempt.item_id);
      })();
    }
    this.persistRegistrationJob(attempt.id, job.id);
    this.recomputeItem(attempt.item_id);
    return this.attemptRow(attempt.id);
  }

  recoverMisclassifiedCompletedRegistrations(taskId) {
    const rows = this.db.prepare(`
      SELECT attempts.id AS attempt_id, items.*
      FROM mailcom_registration_pipeline_attempts AS attempts
      JOIN mailcom_registration_pipeline_items AS items ON items.id = attempts.item_id
      WHERE attempts.pipeline_id = ? AND items.slot_kind = 'primary'
        AND items.current_attempt_id = attempts.id
        AND attempts.status = 'failed' AND attempts.outcome = 'unavailable'
        AND attempts.failure_reason = 'already_completed'
        AND attempts.recycle_status = 'skipped'
    `).all(String(taskId || ""));
    let recovered = 0;
    for (const item of rows) {
      const attempt = this.attemptRow(item.attempt_id);
      const job = this.resumableRegistrationJob(item, attempt);
      if (job?.status !== "completed" || !String(job.external_account_id || "").trim()) continue;
      this.resumeRegistrationJob(item.attempt_id, job);
      recovered += 1;
    }
    if (recovered) this.recompute(taskId);
    return recovered;
  }

  recoverCapacityFailedPrimarySlots(taskId) {
    const rows = this.db.prepare(`
      SELECT items.id AS item_id, items.account_id, attempts.id AS attempt_id
      FROM mailcom_registration_pipeline_items AS items
      JOIN mailcom_registration_pipeline_attempts AS attempts
        ON attempts.id = items.current_attempt_id AND attempts.item_id = items.id
      WHERE items.pipeline_id = ? AND items.slot_kind = 'primary'
        AND items.status IN ('failed', 'interrupted')
        AND attempts.recycle_status = 'failed'
        AND attempts.stage IN ('recycle_failed', 'orphan_recycle_failed')
        AND (
          attempts.recycle_error LIKE '%不能创建第 %个替代别名%'
          OR attempts.recycle_error LIKE '%母号保留时没有空位创建替代别名%'
        )
      ORDER BY items.id
    `).all(String(taskId || ""));
    const recoverable = rows.filter((row) => (
      this.localMailcomAliasHistoryCount(row.account_id) < mailcomAliasHistoryLimit
    ));
    if (!recoverable.length) return 0;
    const at = nowIso();
    this.db.transaction(() => {
      const resetAttempt = this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'pending', stage = CASE
            WHEN trim(outcome) <> '' THEN outcome ELSE 'registration_failed' END,
          recycle_error = '', next_retry_at = NULL, updated_at = ?
        WHERE id = ? AND recycle_status = 'failed'
      `);
      const resetItem = this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET status = 'queued', stage = 'recycle_retry_wait', replacement_email = '',
          recycle_retry_count = 0, next_retry_at = NULL, error = '',
          finished_at = NULL, updated_at = ?
        WHERE id = ? AND status IN ('failed', 'interrupted')
      `);
      for (const row of recoverable) {
        if (!resetAttempt.run(at, row.attempt_id).changes) continue;
        resetItem.run(at, row.item_id);
      }
    })();
    recoverable.forEach((row) => this.recomputeItem(row.item_id));
    return recoverable.length;
  }

  ensureCurrentAddress(item) {
    const row = item.current_address_id ? this.db.prepare(`
      SELECT * FROM addresses WHERE id = ? AND account_id = ? AND status = 'active'
    `).get(item.current_address_id, item.account_id) : null;
    if (row && String(row.address).toLowerCase() === String(item.current_email).toLowerCase()) return row;
    if (this.isMotherPrimaryItem(item)) return null;
    const replacement = this.unassignedReplacement(item, "");
    if (!replacement) return null;
    this.db.prepare(`
      UPDATE mailcom_registration_pipeline_items
      SET current_address_id = ?, current_email = ?, replacement_email = '', updated_at = ?
      WHERE id = ?
    `).run(replacement.id, replacement.address, nowIso(), item.id);
    return replacement;
  }

  createAttempt(itemId) {
    let item = this.itemRow(itemId);
    const address = item ? this.ensureCurrentAddress(item) : null;
    item = this.itemRow(itemId);
    if (!item || !address) {
      this.finishItem(itemId, "failed", "Mail.com slot 当前地址不存在或已停用");
      return null;
    }
    const at = nowIso();
    let attemptId;
    this.db.transaction(() => {
      const number = Number(this.db.prepare(`
        SELECT COALESCE(MAX(attempt_number), 0) + 1 AS number
        FROM mailcom_registration_pipeline_attempts WHERE item_id = ?
      `).get(item.id)?.number || 1);
      const result = this.db.prepare(`
        INSERT INTO mailcom_registration_pipeline_attempts (
          pipeline_id, item_id, attempt_number, address_id, email, status, stage,
          registration_status, link_status, recycle_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', 'registration_queued', 'queued', 'pending', 'pending', ?, ?)
      `).run(item.pipeline_id, item.id, number, address.id, address.address, at, at);
      attemptId = Number(result.lastInsertRowid);
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET current_attempt_id = ?, status = 'running', stage = 'registration_queued',
          next_retry_at = NULL, error = '', updated_at = ? WHERE id = ?
      `).run(attemptId, at, item.id);
    })();
    const resumable = this.resumableRegistrationJob(item, this.attemptRow(attemptId));
    if (resumable && (resumable.status !== "completed" || String(resumable.external_account_id || "").trim())) {
      this.resumeRegistrationJob(attemptId, resumable);
    } else {
      const unavailable = this.unavailableAddressState(item);
      if (!unavailable) {
        this.recomputeItem(item.id);
        return this.attemptRow(attemptId);
      }
      this.finishAttempt(attemptId, "failed", "unavailable", unavailable.message || "Mail.com 地址不可重复注册", {
        failureReason: unavailable.reason,
        registrationStatus: "failed",
        linkStatus: "skipped",
      });
    }
    this.recomputeItem(item.id);
    return this.attemptRow(attemptId);
  }

  async processCycle(itemId, registrationSemaphore) {
    let item = this.itemRow(itemId);
    if (!item || TERMINAL_ITEM_STATUSES.has(item.status) || this.itemWasCancelled(itemId)) return;
    let attempt = item.current_attempt_id ? this.attemptRow(item.current_attempt_id) : null;
    if (!attempt) attempt = this.createAttempt(itemId);
    if (!attempt) return;
    if (!TERMINAL_ATTEMPT_STATUSES.has(attempt.status)
      && attempt.registration_status !== "succeeded") {
      await registrationSemaphore.acquire();
      try {
        attempt = this.attemptRow(attempt.id);
        if (!this.closed && !this.itemWasCancelled(itemId)
          && attempt && !TERMINAL_ATTEMPT_STATUSES.has(attempt.status)
          && attempt.registration_status !== "succeeded") {
          await this.ensureRegistration(attempt.id);
        }
        attempt = this.attemptRow(attempt?.id);
      } finally {
        registrationSemaphore.release();
      }
    }
    if (!attempt || this.closed || this.itemWasCancelled(itemId)) return;
    if (!TERMINAL_ATTEMPT_STATUSES.has(attempt.status) && attempt.registration_status === "succeeded"
      && attempt.link_status !== "succeeded" && attempt.trial_status !== "eligible") {
      await this.ensureTrialEligibility(attempt.id);
      attempt = this.attemptRow(attempt.id);
    }
    if (!attempt || this.closed || this.itemWasCancelled(itemId)) return;
    if (!TERMINAL_ATTEMPT_STATUSES.has(attempt.status) && attempt.registration_status === "succeeded"
      && attempt.trial_status === "eligible"
      && attempt.link_status !== "succeeded") {
      await this.ensurePaymentLink(attempt.id);
      attempt = this.attemptRow(attempt.id);
    }
    if (!attempt || this.closed || this.itemWasCancelled(itemId)) return;
    if (!TERMINAL_ATTEMPT_STATUSES.has(attempt.status) && attempt.link_status === "succeeded"
      && attempt.agreement_status !== "succeeded") {
      await this.ensureAgreement(attempt.id);
      attempt = this.attemptRow(attempt.id);
    }
    if (!attempt || this.closed || this.itemWasCancelled(itemId)) return;
    if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) await this.afterAttempt(attempt.id);
  }

  discoverRegistrationJob(attempt) {
    return this.db.prepare(`
      SELECT * FROM registration_jobs
      WHERE address_id = ? AND lower(email) = lower(?) AND created_at >= ?
        AND deleted_at IS NULL
      ORDER BY id ASC LIMIT 1
    `).get(attempt.address_id, attempt.email, attempt.created_at);
  }

  persistRegistrationJob(attemptId, jobId) {
    this.db.prepare(`
      UPDATE mailcom_registration_pipeline_attempts
      SET registration_job_id = ?, status = 'running', stage = 'registration_wait',
        registration_status = 'running', updated_at = ?
      WHERE id = ? AND (registration_job_id IS NULL OR registration_job_id = 0)
    `).run(Number(jobId), nowIso(), attemptId);
    const attempt = this.attemptRow(attemptId);
    if (attempt) {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items SET status = 'running', stage = 'registration_wait', updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `).run(nowIso(), attempt.item_id);
    }
  }

  async ensureRegistration(attemptId) {
    let attempt = this.attemptRow(attemptId);
    if (!attempt || TERMINAL_ATTEMPT_STATUSES.has(attempt.status) || attempt.registration_status === "succeeded") return;
    const item = this.itemRow(attempt.item_id);
    const task = item ? this.taskRow(item.pipeline_id) : null;
    if (!item || !task) return;
    if (!attempt.registration_job_id) {
      let job = this.discoverRegistrationJob(attempt);
      if (!job) {
        try {
          await this.validateRegistrationRuntime(task, item);
        } catch (error) {
          if (String(error?.code || "") === "MAILCOM_PIPELINE_ACCOUNT_ACTION_REQUIRED") {
            this.finishAttempt(attempt.id, "failed", "account_action_required", error, {
              failureReason: "account_action_required",
              registrationStatus: "failed",
              linkStatus: "skipped",
            });
            return;
          }
          this.scheduleAttemptRetry(attempt.id, "registration_runtime_retry_wait", error);
          return;
        }
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_attempts
          SET status = 'running', stage = 'registration_submitting', registration_status = 'submitting',
            next_retry_at = NULL, updated_at = ?
          WHERE id = ? AND status IN ('queued', 'running')
        `).run(nowIso(), attempt.id);
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_items SET status = 'running', stage = 'registration_submitting', updated_at = ?
          WHERE id = ? AND status IN ('queued', 'running')
        `).run(nowIso(), item.id);
        let jobs = [];
        let submitError = null;
        try {
          if (this.closed || this.itemWasCancelled(item.id)) return;
          this.validateRegistrationAccount(item);
          jobs = await this.registration.createJobs({
            accountId: item.account_id,
            baseAddressId: attempt.address_id,
            addressIds: [Number(attempt.address_id)],
            count: 1,
            concurrency: 1,
            browserMode: task.browser_mode,
            proxySelection: task.proxy_selection,
            mailboxMode: "source",
          });
        } catch (error) {
          submitError = error;
        }
        job = (Array.isArray(jobs) ? jobs : []).find((entry) => (
          String(entry.email || "").toLowerCase() === String(attempt.email).toLowerCase()
        )) || this.discoverRegistrationJob(attempt);
        if (!job?.id) {
          if (this.infrastructureSubmissionError(submitError, item)) {
            this.scheduleAttemptRetry(attempt.id, "registration_runtime_retry_wait", submitError);
            return;
          }
          const reason = unavailableRegistration(submitError);
          this.finishAttempt(attempt.id, "failed", reason ? "unavailable" : "registration_failed",
            safeError(submitError, "注册任务提交失败"), {
              failureReason: reason || String(submitError?.code || "submit_failed"),
              registrationStatus: "failed",
              linkStatus: "skipped",
            });
          return;
        }
      }
      this.persistRegistrationJob(attempt.id, job.id);
    }
    while (!this.closed) {
      attempt = this.attemptRow(attemptId);
      if (!attempt || TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) return;
      if (this.itemWasCancelled(attempt.item_id)) return this.cancelItem(attempt.item_id);
      const local = this.registration.getJob(attempt.registration_job_id);
      if (!local) {
        this.finishAttempt(attempt.id, "failed", "registration_failed", "注册任务不存在", {
          failureReason: "job_missing", registrationStatus: "failed", linkStatus: "skipped",
        });
        return;
      }
      const job = await this.registration.syncJob(local);
      if (job.status === "completed") {
        if (!job.external_account_id) {
          this.finishAttempt(attempt.id, "failed", "registration_failed", "注册成功但未找到账号 ID", {
            failureReason: "account_id_missing", registrationStatus: "failed", linkStatus: "skipped",
          });
          return;
        }
        const at = nowIso();
        const trialCheck = TRIAL_CHECKS[task.payment_link_country] || null;
        const nextStage = trialCheck ? "trial_check_queued" : "link_queued";
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_attempts
          SET external_account_id = ?, status = 'running', stage = ?,
            registration_status = 'succeeded', trial_country = ?, trial_status = ?,
            trial_error = '', trial_checked_at = CASE WHEN ? = 'skipped' THEN ? ELSE NULL END,
            registration_finished_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('queued', 'running')
        `).run(
          String(job.external_account_id),
          nextStage,
          task.payment_link_country,
          trialCheck ? "pending" : "skipped",
          trialCheck ? "pending" : "skipped",
          at,
          at,
          at,
          attempt.id,
        );
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_items SET stage = ?, updated_at = ?
          WHERE id = ? AND status = 'running'
        `).run(nextStage, at, attempt.item_id);
        this.recomputeItem(attempt.item_id);
        return;
      }
      if (job.status === "failed") {
        const unavailableReason = unavailableRegistration(job);
        const reason = unavailableReason || String(job.failure_reason || "registration_failed");
        this.finishAttempt(attempt.id, "failed", unavailableReason ? "unavailable" : "registration_failed",
          job.message || "注册失败", {
            failureReason: reason,
            registrationStatus: "failed",
            linkStatus: "skipped",
          });
        return;
      }
      if (new Set(["cancelled", "interrupted"]).has(job.status)) {
        this.finishAttempt(attempt.id, job.status, job.status, job.message || "注册任务已结束", {
          failureReason: job.status,
          registrationStatus: job.status,
          linkStatus: "skipped",
        });
        return;
      }
      await this.wait(attempt.item_id, this.pollIntervalMs);
    }
  }

  persistTrialCheckState(attemptId, {
    country,
    status,
    error = "",
    checkedAt = null,
    stage = null,
  }) {
    const attempt = this.attemptRow(attemptId);
    if (!attempt || TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) return attempt;
    const at = nowIso();
    const nextStage = stage || attempt.stage;
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET trial_country = ?, trial_status = ?, trial_error = ?, trial_checked_at = ?,
          stage = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `).run(
        String(country || "").toUpperCase(),
        status,
        safeError(error, ""),
        checkedAt,
        nextStage,
        at,
        attempt.id,
      );
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET status = 'running', stage = ?, error = ?, next_retry_at = NULL, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running', 'retry_wait')
      `).run(nextStage, status === "failed" ? safeError(error, "") : "", at, attempt.item_id);
    })();
    this.recomputeItem(attempt.item_id);
    return this.attemptRow(attempt.id);
  }

  finishTrialIneligible(attempt, item, config) {
    if (!attempt || !item || !config) return null;
    return this.finishAttempt(
      attempt.id,
      "failed",
      "trial_ineligible",
      this.isMotherPrimaryItem(item)
        ? `${config.label}试用资格检测结果：没有试用；账号池记录将删除，母号主地址保留并切换到新官方别名继续`
        : `${config.label}试用资格检测结果：没有试用，账号池记录及官方别名将直接删除并补建`,
      {
        failureReason: "trial_ineligible",
        registrationStatus: "succeeded",
        linkStatus: "skipped",
        agreementStatus: "skipped",
      },
    );
  }

  finishTrialAccountUnavailable(attempt, item, config, error) {
    if (!attempt || !item || !config) return null;
    const detail = safeError(error, "账号不存在");
    return this.finishAttempt(
      attempt.id,
      "failed",
      "trial_account_not_found",
      this.isMotherPrimaryItem(item)
        ? `${config.label}检测确认账号不存在：${detail}；账号池残留将清理，母号主地址保留并切换到新官方别名继续`
        : `${config.label}检测确认账号不存在：${detail}；账号池残留及官方别名将直接删除并补建`,
      {
        failureReason: "account_not_found",
        registrationStatus: "succeeded",
        linkStatus: "skipped",
        agreementStatus: "skipped",
      },
    );
  }

  finishTrialAccountMismatch(attempt, item, config, error) {
    if (!attempt || !item || !config) return null;
    const detail = safeError(error, "注册账号与远端记录不匹配");
    return this.finishAttempt(
      attempt.id,
      "failed",
      "trial_account_mismatch",
      `${config.label}检测拒绝不匹配的账号记录：${detail}；为避免误删，账号池和邮箱均已保留`,
      {
        failureReason: "registered_account_mismatch",
        registrationStatus: "succeeded",
        linkStatus: "skipped",
        agreementStatus: "skipped",
      },
    );
  }

  recordedTrialCheck(attempt, config) {
    if (!attempt?.external_account_id || !attempt.registration_finished_at || !config?.table) return null;
    const row = this.db.prepare(`
      SELECT status, eligible, error, checked_at
      FROM ${config.table}
      WHERE external_account_id = ? AND email = ? COLLATE NOCASE
        AND checked_at >= ?
      LIMIT 1
    `).get(String(attempt.external_account_id), attempt.email, attempt.registration_finished_at);
    if (row?.status === "eligible" && Number(row.eligible) === 1) return { ...row, eligible: true };
    if (row?.status === "ineligible" && Number(row.eligible) === 0) return { ...row, eligible: false };
    return null;
  }

  adoptRecordedTrialCheck(attempt, item, country, config) {
    const recorded = this.recordedTrialCheck(attempt, config);
    if (!recorded) return null;
    this.persistTrialCheckState(attempt.id, {
      country,
      status: recorded.eligible ? "eligible" : "ineligible",
      checkedAt: recorded.checked_at || nowIso(),
      stage: recorded.eligible ? "link_queued" : "trial_ineligible",
    });
    if (recorded.eligible) return true;
    this.finishTrialIneligible(this.attemptRow(attempt.id), item, config);
    return false;
  }

  finishTrialCheckFailure(attempt, item, country, config, error) {
    if (!attempt || !item || !config) return false;
    const detail = safeError(error, `${config.label}试用资格检测失败`);
    const message = `${detail}；已停止重复检测，账号池和邮箱均已保留`;
    this.persistTrialCheckState(attempt.id, {
      country,
      status: "failed",
      error: message,
      checkedAt: nowIso(),
      stage: "trial_check_failed",
    });
    this.finishAttempt(attempt.id, "failed", "trial_check_failed", message, {
      failureReason: "trial_check_failed",
      registrationStatus: "succeeded",
      linkStatus: "skipped",
      agreementStatus: "skipped",
    });
    return false;
  }

  retryOrFinishTrialCheck(attempt, item, country, config, error) {
    const status = Number(error?.status || 0);
    const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
    const checksUsed = Number(item?.retry_count || 0) + 1;
    if (!retryable || checksUsed >= this.trialCheckAttemptLimit) {
      return this.finishTrialCheckFailure(attempt, item, country, config, error);
    }
    this.persistTrialCheckState(attempt.id, {
      country,
      status: "failed",
      error,
      checkedAt: nowIso(),
      stage: "trial_runtime_retry_wait",
    });
    this.scheduleAttemptRetry(attempt.id, "trial_runtime_retry_wait", error);
    return false;
  }

  async ensureTrialEligibility(attemptId) {
    let attempt = this.attemptRow(attemptId);
    if (!attempt || TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) return false;
    let item = this.itemRow(attempt.item_id);
    const task = item ? this.taskRow(item.pipeline_id) : null;
    if (!item || !task) return false;
    const country = String(task.payment_link_country || "").toUpperCase();
    const config = TRIAL_CHECKS[country] || null;
    if (!config) {
      if (attempt.trial_status !== "skipped") {
        this.persistTrialCheckState(attempt.id, {
          country,
          status: "skipped",
          checkedAt: nowIso(),
          stage: "link_queued",
        });
      }
      return true;
    }
    if (attempt.trial_country === country && attempt.trial_status === "eligible") return true;
    if (attempt.trial_country === country && attempt.trial_status === "ineligible") {
      this.finishTrialIneligible(attempt, item, config);
      return false;
    }
    const recorded = this.adoptRecordedTrialCheck(attempt, item, country, config);
    if (recorded !== null) return recorded;

    await this.trialCheckSemaphore.acquire();
    try {
      attempt = this.attemptRow(attempt.id);
      item = attempt ? this.itemRow(attempt.item_id) : null;
      if (!attempt || !item || TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) return false;
      if (this.closed) return false;
      if (this.itemWasCancelled(item.id)) {
        await this.cancelItem(item.id);
        return false;
      }
      if (attempt.trial_country === country && attempt.trial_status === "eligible") return true;
      if (attempt.trial_country === country && attempt.trial_status === "ineligible") {
        this.finishTrialIneligible(attempt, item, config);
        return false;
      }
      const recordedAfterWait = this.adoptRecordedTrialCheck(attempt, item, country, config);
      if (recordedAfterWait !== null) return recordedAfterWait;
      if (typeof this.registration.checkRegisteredAccountTrialForCountry !== "function") {
        const unavailable = failure(
          "注册服务尚未提供流水线试用资格检测",
          503,
          "MAILCOM_PIPELINE_TRIAL_CHECK_UNAVAILABLE",
        );
        return this.retryOrFinishTrialCheck(attempt, item, country, config, unavailable);
      }

      attempt = this.persistTrialCheckState(attempt.id, {
        country,
        status: "running",
        stage: "trial_checking",
      });
      let result;
      try {
        result = await this.registration.checkRegisteredAccountTrialForCountry({
          id: Number(attempt.external_account_id),
          email: attempt.email,
        }, country);
      } catch (error) {
        if (this.closed) return false;
        if (this.itemWasCancelled(item.id)) {
          await this.cancelItem(item.id);
          return false;
        }
        if (trialRegisteredAccountUnavailable(error)) {
          this.persistTrialCheckState(attempt.id, {
            country,
            status: "failed",
            error,
            checkedAt: nowIso(),
            stage: "trial_account_not_found",
          });
          this.finishTrialAccountUnavailable(this.attemptRow(attempt.id), item, config, error);
          return false;
        }
        if (registeredAccountMismatch(error)) {
          this.persistTrialCheckState(attempt.id, {
            country,
            status: "failed",
            error,
            checkedAt: nowIso(),
            stage: "trial_account_mismatch",
          });
          this.finishTrialAccountMismatch(this.attemptRow(attempt.id), item, config, error);
          return false;
        }
        return this.retryOrFinishTrialCheck(attempt, item, country, config, error);
      }
      if (this.closed) return false;
      if (this.itemWasCancelled(item.id)) {
        await this.cancelItem(item.id);
        return false;
      }

      const status = String(result?.[config.statusField] || "").toLowerCase();
      const eligible = result?.[config.eligibleField];
      if (status === "eligible" && eligible === true) {
        this.persistTrialCheckState(attempt.id, {
          country,
          status: "eligible",
          checkedAt: result?.trial_checked_at
            || result?.gb_trial_checked_at
            || result?.us_trial_checked_at
            || nowIso(),
          stage: "link_queued",
        });
        return true;
      }
      if (status === "ineligible" && eligible === false) {
        const checkedAt = result?.trial_checked_at
          || result?.gb_trial_checked_at
          || result?.us_trial_checked_at
          || nowIso();
        this.persistTrialCheckState(attempt.id, {
          country,
          status: "ineligible",
          checkedAt,
          stage: "trial_ineligible",
        });
        this.finishTrialIneligible(this.attemptRow(attempt.id), item, config);
        return false;
      }

      const resultHttpStatus = Number(result?.[config.httpStatusField] || 0);
      const resultErrorCode = String(result?.[config.errorCodeField] || "").trim();
      const error = failure(
        result?.[config.errorField] || `${config.label}试用资格检测没有返回明确结果`,
        status === "rate_limited" ? 429 : resultHttpStatus || 502,
        status === "rate_limited"
          ? "MAILCOM_PIPELINE_TRIAL_RATE_LIMITED"
          : resultErrorCode || "MAILCOM_PIPELINE_TRIAL_CHECK_FAILED",
      );
      if (trialRegisteredAccountUnavailable(error)) {
        this.persistTrialCheckState(attempt.id, {
          country,
          status: "failed",
          error,
          checkedAt: nowIso(),
          stage: "trial_account_not_found",
        });
        this.finishTrialAccountUnavailable(this.attemptRow(attempt.id), item, config, error);
        return false;
      }
      if (registeredAccountMismatch(error)) {
        this.persistTrialCheckState(attempt.id, {
          country,
          status: "failed",
          error,
          checkedAt: nowIso(),
          stage: "trial_account_mismatch",
        });
        this.finishTrialAccountMismatch(this.attemptRow(attempt.id), item, config, error);
        return false;
      }
      return this.retryOrFinishTrialCheck(attempt, item, country, config, error);
    } finally {
      this.trialCheckSemaphore.release();
    }
  }

  recentPaymentLink(attempt) {
    if (!attempt.external_account_id) return null;
    const row = this.paymentLinks.row(attempt.external_account_id);
    const resumable = new Set(["queued", "running", "cancel_requested", "succeeded"]).has(row?.status)
      || (row?.status === "failed" && paymentLinkBlocked(row));
    if (!row?.task_id || !resumable) return null;
    return String(row.started_at || row.updated_at || "") >= String(attempt.registration_finished_at || attempt.created_at)
      ? row : null;
  }

  persistPaymentLinkTask(attemptId, taskId) {
    const at = nowIso();
    let changed = 0;
    this.db.transaction(() => {
      changed = this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET payment_link_task_id = ?, status = 'running', stage = 'link_wait',
          link_status = 'running', link_attempt_count = CASE
            WHEN link_attempt_count < 1 THEN 1 ELSE link_attempt_count END,
          updated_at = ? WHERE id = ? AND status IN ('queued', 'running')
      `).run(String(taskId), at, attemptId).changes;
      if (!changed) return;
      const attempt = this.attemptRow(attemptId);
      if (!attempt) return;
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items SET status = 'running', stage = 'link_wait', updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `).run(at, attempt.item_id);
    })();
    return changed ? this.attemptRow(attemptId) : null;
  }

  beginPaymentLinkSubmission(attemptId) {
    const at = nowIso();
    this.db.prepare(`
      UPDATE mailcom_registration_pipeline_attempts
      SET stage = 'link_submitting', link_status = 'submitting',
        link_attempt_count = link_attempt_count + 1,
        payment_link_task_id = '', payment_link_url = '', link_finished_at = NULL,
        next_retry_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(at, attemptId);
    const attempt = this.attemptRow(attemptId);
    if (attempt) {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET status = 'running', stage = 'link_submitting', next_retry_at = NULL, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running', 'retry_wait')
      `).run(at, attempt.item_id);
    }
    return attempt;
  }

  paymentLinkAttemptLimit(task) {
    return Math.max(1, Math.min(10, Number(task?.link_attempts || 3)));
  }

  schedulePaymentLinkRetry(attempt, task, error) {
    const current = this.attemptRow(attempt?.id);
    const item = current ? this.itemRow(current.item_id) : null;
    if (!current || !item || TERMINAL_ATTEMPT_STATUSES.has(current.status)
      || TERMINAL_ITEM_STATUSES.has(item.status)) return false;
    const limit = this.paymentLinkAttemptLimit(task);
    const used = Math.max(0, Number(current.link_attempt_count || 0));
    if (used >= limit) return false;
    const next = new Date(Date.now() + this.retryDelay(Math.max(1, used))).toISOString();
    const detail = safeError(error, "提链失败");
    const message = `提链第 ${used}/${limit} 次失败：${detail}`.slice(0, 500);
    const retryCount = Number(item.retry_count || 0) + 1;
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET payment_link_task_id = '', payment_link_url = '', stage = 'link_retry_wait',
          link_status = 'pending', error = ?, next_retry_at = ?, link_finished_at = NULL,
          updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(message, next, nowIso(), current.id);
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET status = 'retry_wait', stage = 'link_retry_wait', retry_count = ?,
          error = ?, next_retry_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running', 'retry_wait')
      `).run(retryCount, message, next, nowIso(), item.id);
    })();
    this.recomputeItem(item.id);
    return true;
  }

  schedulePaymentLinkRuntimeRetry(attempt, error) {
    const current = this.attemptRow(attempt?.id);
    const item = current ? this.itemRow(current.item_id) : null;
    if (!current || !item || TERMINAL_ATTEMPT_STATUSES.has(current.status)
      || TERMINAL_ITEM_STATUSES.has(item.status)) return false;
    const retryCount = Number(item.retry_count || 0) + 1;
    const next = new Date(Date.now() + this.retryDelay(retryCount)).toISOString();
    const message = `提链运行依赖异常：${paymentLinkFailureText(error, "等待重试")}`.slice(0, 500);
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET payment_link_task_id = '', payment_link_url = '', stage = 'link_runtime_retry_wait',
          link_status = 'pending', link_attempt_count = CASE
            WHEN link_attempt_count > 0 THEN link_attempt_count - 1 ELSE 0 END,
          error = ?, next_retry_at = ?, link_finished_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(message, next, nowIso(), current.id);
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET status = 'retry_wait', stage = 'link_runtime_retry_wait', retry_count = ?,
          error = ?, next_retry_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running', 'retry_wait')
      `).run(retryCount, message, next, nowIso(), item.id);
    })();
    this.recomputeItem(item.id);
    return true;
  }

  finishOrRetryPaymentLink(attempt, task, error, failureReason = "link_failed") {
    if (!attempt) return false;
    if (registeredAccountUnavailable(error)) {
      this.finishAttempt(attempt.id, "failed", "account_not_found", paymentLinkFailureText(error, "账号不存在"), {
        failureReason: "account_not_found",
        registrationStatus: "succeeded",
        linkStatus: "failed",
      });
      return false;
    }
    if (paymentLinkBlocked(error)) {
      this.finishAttempt(attempt.id, "failed", "link_blocked", paymentLinkFailureText(error, "提链返回 blocked"), {
        failureReason: "link_blocked",
        registrationStatus: "succeeded",
        linkStatus: "failed",
      });
      return false;
    }
    if (paymentLinkRuntimeFailure(error)) {
      this.schedulePaymentLinkRuntimeRetry(attempt, error);
      return true;
    }
    if (this.schedulePaymentLinkRetry(attempt, task, error)) return true;
    this.finishAttempt(attempt.id, "failed", "link_failed", paymentLinkFailureText(error, "提链失败"), {
      failureReason,
      registrationStatus: "succeeded",
      linkStatus: "failed",
    });
    return false;
  }

  async cancelPaymentLinkTask(accountId, taskId) {
    const normalizedTaskId = String(taskId || "");
    if (!normalizedTaskId) return false;
    const paymentLink = this.paymentLinks.row(accountId);
    if (!paymentLink || String(paymentLink.task_id) !== normalizedTaskId
      || !new Set(["queued", "running", "cancel_requested"]).has(paymentLink.status)) return false;
    this.paymentLinks.persistTracked?.(accountId, normalizedTaskId, {
      status: "cancel_requested",
      stage: "cancel_requested",
      error: "任务已取消",
    });
    try {
      const snapshot = await this.paymentLinks.request(
        `/api/tasks/${encodeURIComponent(normalizedTaskId)}/cancel`,
        { method: "POST" },
      );
      this.paymentLinks.applySnapshot?.(accountId, snapshot);
    } catch {
      // The persisted cancellation remains visible for PaymentLinkService reconciliation.
    }
    return true;
  }

  async ensurePaymentLink(attemptId) {
    let attempt = this.attemptRow(attemptId);
    if (!attempt || TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) return;
    const item = this.itemRow(attempt.item_id);
    const task = item ? this.taskRow(item.pipeline_id) : null;
    if (!item || !task) return;
    if (!attempt.payment_link_task_id) {
      let row = this.recentPaymentLink(attempt);
      if (!row) {
        if (Number(attempt.link_attempt_count || 0) >= this.paymentLinkAttemptLimit(task)) {
          this.finishOrRetryPaymentLink(
            attempt,
            task,
            attempt.error || "提链任务未持久化且已达到提链次数上限",
            "link_submit_context_lost",
          );
          return;
        }
        try {
          this.validatePaymentLinkRuntime();
        } catch (error) {
          this.scheduleAttemptRetry(attempt.id, "link_runtime_retry_wait", error);
          return;
        }
        attempt = this.beginPaymentLinkSubmission(attempt.id);
        if (!attempt || TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) return;
        let started;
        try {
          started = await this.paymentLinks.start({
            ids: [Number(attempt.external_account_id)],
            country: task.payment_link_country,
          });
        } catch (error) {
          this.finishOrRetryPaymentLink(
            this.attemptRow(attempt.id),
            task,
            error,
            "link_submit_failed",
          );
          return;
        }
        row = (started?.items || []).find((candidate) => (
          String(candidate.external_account_id) === String(attempt.external_account_id)
        )) || this.paymentLinks.row(attempt.external_account_id);
        const current = this.attemptRow(attempt.id);
        if (!current || TERMINAL_ATTEMPT_STATUSES.has(current.status)
          || this.itemWasCancelled(current.item_id)) {
          if (row?.task_id) {
            await this.cancelPaymentLinkTask(attempt.external_account_id, row.task_id);
          }
          return;
        }
        if (!row?.task_id || row.accepted === false) {
          this.finishOrRetryPaymentLink(
            current,
            task,
            row || "提链任务未启动",
            "link_not_started",
          );
          return;
        }
      }
      const persisted = this.persistPaymentLinkTask(attempt.id, row.task_id);
      if (!persisted) {
        await this.cancelPaymentLinkTask(attempt.external_account_id, row.task_id);
        return;
      }
    }
    attempt = this.attemptRow(attempt.id);
    if (!attempt || TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) return;
    this.paymentLinks.track(attempt.external_account_id, attempt.payment_link_task_id).catch(() => undefined);
    while (!this.closed) {
      attempt = this.attemptRow(attemptId);
      if (!attempt || TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) return;
      if (this.itemWasCancelled(attempt.item_id)) return this.cancelItem(attempt.item_id);
      const row = this.paymentLinks.row(attempt.external_account_id);
      if (!row || String(row.task_id) !== String(attempt.payment_link_task_id)) {
        this.schedulePaymentLinkRuntimeRetry(
          attempt,
          Object.assign(new Error("提链任务映射已变化"), { status: 503 }),
        );
        return;
      }
      if (row.status === "succeeded") {
        if (!row.provider_url) {
          this.finishOrRetryPaymentLink(
            attempt,
            task,
            "提链完成但未返回支付链接",
            "link_missing",
          );
          return;
        }
        const at = nowIso();
        this.db.transaction(() => {
          this.db.prepare(`
            UPDATE mailcom_registration_pipeline_attempts
            SET status = 'running', stage = 'agreement_ready', link_status = 'succeeded',
              payment_link_url = ?, link_finished_at = COALESCE(link_finished_at, ?),
              agreement_status = CASE WHEN agreement_status = 'skipped' THEN 'pending' ELSE agreement_status END,
              agreement_finished_at = CASE
                WHEN agreement_status = 'skipped' THEN NULL ELSE agreement_finished_at END,
              error = '', next_retry_at = NULL, updated_at = ?
            WHERE id = ? AND status IN ('queued', 'running')
          `).run(String(row.provider_url), at, at, attempt.id);
          this.db.prepare(`
            UPDATE mailcom_registration_pipeline_items
            SET status = 'running', stage = 'agreement_ready', error = '',
              next_retry_at = NULL, updated_at = ?
            WHERE id = ? AND status IN ('queued', 'running', 'retry_wait')
          `).run(at, attempt.item_id);
        })();
        this.recomputeItem(attempt.item_id);
        return;
      }
      if (row.status === "failed") {
        this.finishOrRetryPaymentLink(attempt, task, row, "link_failed");
        return;
      }
      if (row.status === "cancelled") {
        if (this.itemWasCancelled(attempt.item_id)) {
          await this.cancelItem(attempt.item_id);
          return;
        }
        this.finishOrRetryPaymentLink(attempt, task, row, "link_cancelled");
        return;
      }
      await this.wait(attempt.item_id, this.pollIntervalMs);
    }
  }

  persistAgreementJob(attemptId, jobId, country = "") {
    const at = nowIso();
    this.db.prepare(`
      UPDATE mailcom_registration_pipeline_attempts
      SET agreement_job_id = ?,
        agreement_status = CASE WHEN status IN ('queued', 'running') THEN 'running' ELSE agreement_status END,
        agreement_country = CASE WHEN trim(?) <> '' THEN ? ELSE agreement_country END,
        stage = CASE WHEN status IN ('queued', 'running') THEN 'agreement_wait' ELSE stage END,
        agreement_started_at = COALESCE(agreement_started_at, ?), updated_at = ?
      WHERE id = ?
    `).run(String(jobId), String(country), String(country), at, at, attemptId);
    const attempt = this.attemptRow(attemptId);
    if (attempt && !TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET status = 'running', stage = 'agreement_wait', updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running', 'retry_wait')
      `).run(at, attempt.item_id);
      this.recomputeItem(attempt.item_id);
    }
  }

  markAgreementUncertain(attemptId, error, stage = "agreement_submission_unknown") {
    const attempt = this.attemptRow(attemptId);
    if (!attempt || TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) return attempt;
    const at = nowIso();
    const message = safeError(error, "协议授权提交结果无法确认，已保留当前别名");
    this.db.prepare(`
      UPDATE mailcom_registration_pipeline_attempts
      SET status = 'failed', stage = ?, outcome = 'agreement_unknown',
        agreement_status = 'uncertain', agreement_error = ?, error = ?,
        recycle_status = 'skipped', failure_reason = 'agreement_unknown',
        agreement_finished_at = ?, finished_at = ?, next_retry_at = NULL, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(stage, message, message, at, at, at, attemptId);
    this.recomputeItem(attempt.item_id);
    return this.attemptRow(attemptId);
  }

  async ensureAgreement(attemptId) {
    let attempt = this.attemptRow(attemptId);
    if (!attempt || TERMINAL_ATTEMPT_STATUSES.has(attempt.status)
      || attempt.agreement_status === "succeeded") return;
    if (attempt.link_status !== "succeeded") {
      throw failure("协议授权前没有成功的提链结果", 409, "MAILCOM_PIPELINE_AGREEMENT_LINK_REQUIRED");
    }
    if (!attempt.agreement_job_id && new Set([
      "agreement_submitting", "agreement_submission_unknown", "agreement_context_lost",
    ]).has(String(attempt.stage || ""))) {
      this.markAgreementUncertain(
        attempt.id,
        failure("协议授权上下文在重启后已丢失，未重复提交并已保留当前别名", 409,
          "MAILCOM_PIPELINE_AGREEMENT_CONTEXT_LOST"),
        "agreement_context_lost",
      );
      return;
    }
    if (!attempt.agreement_job_id) {
      let runtime;
      try {
        runtime = this.validateAgreementRuntime();
      } catch (error) {
        this.scheduleAttemptRetry(attempt.id, "agreement_runtime_retry_wait", error);
        return;
      }
      const paymentLink = String(attempt.payment_link_url || "").trim();
      if (!paymentLink) {
        this.markAgreementUncertain(
          attempt.id,
          failure("提链成功记录缺少 PayPal 链接快照，未启动协议授权并已保留当前别名", 409,
            "MAILCOM_PIPELINE_AGREEMENT_LINK_MISSING"),
          "agreement_context_lost",
        );
        return;
      }
      const at = nowIso();
      this.db.transaction(() => {
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_attempts
          SET stage = 'agreement_submitting', agreement_status = 'running',
            agreement_country = ?, agreement_error = '',
            agreement_started_at = COALESCE(agreement_started_at, ?), updated_at = ?
          WHERE id = ? AND status IN ('queued', 'running')
        `).run(String(runtime.country || "").toUpperCase(), at, at, attempt.id);
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_items
          SET status = 'running', stage = 'agreement_submitting', error = '', updated_at = ?
          WHERE id = ? AND status IN ('queued', 'running', 'retry_wait')
        `).run(at, attempt.item_id);
      })();
      let response;
      try {
        response = await this.paymentAgreements.start({
          paypal_url: paymentLink,
          use_saved_protocol_config: true,
        });
      } catch (error) {
        if (error?.protocolSubmissionStarted === true) {
          this.markAgreementUncertain(attempt.id, error, "agreement_submission_unknown");
        } else {
          this.scheduleAttemptRetry(attempt.id, "agreement_runtime_retry_wait", error);
        }
        return;
      }
      const job = agreementJob(response);
      const jobId = String(job?.id || "");
      if (!jobId) {
        this.markAgreementUncertain(
          attempt.id,
          failure("协议授权服务未返回任务 ID，提交结果无法确认并已保留当前别名", 502,
            "MAILCOM_PIPELINE_AGREEMENT_JOB_ID_MISSING"),
          "agreement_submission_unknown",
        );
        return;
      }
      this.persistAgreementJob(attempt.id, jobId, runtime.country);
      attempt = this.attemptRow(attempt.id);
      if (this.itemWasCancelled(attempt.item_id)) {
        try {
          await this.paymentAgreements.cancelJob(jobId);
          await this.paymentAgreements.releaseContext?.(jobId, {
            force: true,
            successful: false,
          }).catch(() => undefined);
        } catch { /* Retain the context while its tracker retries remote cancellation. */ }
        return;
      }
    }
    attempt = this.attemptRow(attempt.id);
    const context = this.paymentAgreements.context?.(attempt.agreement_job_id);
    if (!context) {
      this.markAgreementUncertain(
        attempt.id,
        failure("协议授权上下文在重启后已丢失，未重复提交并已保留当前别名", 409,
          "MAILCOM_PIPELINE_AGREEMENT_CONTEXT_LOST"),
        "agreement_context_lost",
      );
      return;
    }
    while (!this.closed) {
      attempt = this.attemptRow(attemptId);
      if (!attempt || TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) return;
      if (this.itemWasCancelled(attempt.item_id)) return this.cancelItem(attempt.item_id);
      const snapshot = context.lastSnapshot || {};
      const status = agreementStatus(snapshot);
      if (status === "completed") {
        this.finishAttempt(attempt.id, "succeeded", "succeeded", "", {
          failureReason: "",
          registrationStatus: "succeeded",
          linkStatus: "succeeded",
          agreementStatus: "succeeded",
        });
        await this.paymentAgreements.releaseContext?.(attempt.agreement_job_id, {
          force: true,
          successful: true,
        }).catch(() => undefined);
        return;
      }
      if (status === "failed" || status === "cancelled") {
        this.finishAttempt(attempt.id, "failed", "agreement_failed",
          snapshot.error || context.lastError || (status === "cancelled" ? "协议授权已取消" : "协议授权失败"), {
            failureReason: status === "cancelled" ? "agreement_cancelled" : "agreement_failed",
            registrationStatus: "succeeded",
            linkStatus: "succeeded",
            agreementStatus: status === "cancelled" ? "cancelled" : "failed",
          });
        await this.paymentAgreements.releaseContext?.(attempt.agreement_job_id, {
          force: true,
          successful: false,
        }).catch(() => undefined);
        return;
      }
      const agreementTrackers = this.paymentAgreements.trackers;
      if ((context.stopped && !context.terminal)
        || (!context.terminal && !context.stopped
          && agreementTrackers && typeof agreementTrackers.has === "function"
          && !agreementTrackers.has(String(attempt.agreement_job_id)))) {
        this.markAgreementUncertain(
          attempt.id,
          context.lastError || "协议授权后台跟踪已停止，结果无法确认并已保留当前别名",
          "agreement_context_lost",
        );
        await this.paymentAgreements.releaseContext?.(attempt.agreement_job_id, {
          force: true,
          successful: false,
        }).catch(() => undefined);
        return;
      }
      await this.wait(attempt.item_id, this.pollIntervalMs);
    }
  }

  finishAttempt(attemptId, status, outcome, error = "", {
    failureReason = "",
    registrationStatus,
    linkStatus,
    agreementStatus,
  } = {}) {
    const attempt = this.attemptRow(attemptId);
    if (!attempt || TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) return attempt;
    const normalized = TERMINAL_ATTEMPT_STATUSES.has(status) ? status : "failed";
    const resolvedAgreementStatus = agreementStatus
      ?? (linkStatus && linkStatus !== "succeeded" ? "skipped" : null);
    const resolvedAgreementError = new Set(["failed", "cancelled", "uncertain"])
      .has(String(resolvedAgreementStatus || "")) ? safeError(error) : "";
    const at = nowIso();
    this.db.prepare(`
      UPDATE mailcom_registration_pipeline_attempts
      SET status = @status, stage = @stage, outcome = @outcome,
        registration_status = COALESCE(@registration_status, registration_status),
        trial_status = CASE
          WHEN COALESCE(@registration_status, registration_status) IN ('failed', 'cancelled', 'interrupted')
            AND trial_status IN ('pending', 'running', 'failed') THEN 'skipped'
          ELSE trial_status END,
        trial_checked_at = CASE
          WHEN COALESCE(@registration_status, registration_status) IN ('failed', 'cancelled', 'interrupted')
            AND trial_status IN ('pending', 'running', 'failed') THEN COALESCE(trial_checked_at, @at)
          ELSE trial_checked_at END,
        link_status = COALESCE(@link_status, link_status),
        agreement_status = COALESCE(@agreement_status, agreement_status),
        agreement_error = CASE
          WHEN @agreement_status IS NULL THEN agreement_error
          ELSE @agreement_error END,
        failure_reason = @failure_reason, error = @error,
        registration_finished_at = CASE
          WHEN COALESCE(@registration_status, registration_status) IN ('failed', 'cancelled', 'interrupted')
            THEN COALESCE(registration_finished_at, @at)
          ELSE registration_finished_at END,
        link_finished_at = CASE
          WHEN COALESCE(@link_status, link_status) IN ('succeeded', 'failed', 'cancelled', 'interrupted', 'skipped')
            THEN COALESCE(link_finished_at, @at)
          ELSE link_finished_at END,
        agreement_finished_at = CASE
          WHEN COALESCE(@agreement_status, agreement_status)
            IN ('succeeded', 'failed', 'cancelled', 'skipped', 'uncertain')
            THEN COALESCE(agreement_finished_at, @at)
          ELSE agreement_finished_at END,
        finished_at = @at, updated_at = @at
      WHERE id = @id AND status IN ('queued', 'running')
    `).run({
      status: normalized,
      stage: outcome || normalized,
      outcome: outcome || normalized,
      registration_status: registrationStatus ?? null,
      link_status: linkStatus ?? null,
      agreement_status: resolvedAgreementStatus,
      agreement_error: resolvedAgreementError,
      failure_reason: String(failureReason || "").slice(0, 120),
      error: normalized === "succeeded" ? "" : safeError(error),
      at,
      id: attemptId,
    });
    this.recomputeItem(attempt.item_id);
    return this.attemptRow(attemptId);
  }

  finishPrimaryAfterRegisteredAccountDelete(attempt, item, { cancelled = false } = {}) {
    if (!attempt || !item) return;
    this.db.prepare(`
      UPDATE mailcom_registration_pipeline_attempts
      SET recycle_status = 'skipped', stage = 'account_pool_deleted',
        recycle_error = '', next_retry_at = NULL, updated_at = ?
      WHERE id = ? AND recycle_status = 'running'
    `).run(nowIso(), attempt.id);
    if (cancelled) {
      this.finishItem(item.id, "cancelled", "任务已取消；账号池记录已清理，母号主地址未轮换");
    } else if (attempt.status === "succeeded") {
      this.finishItem(item.id, "completed", "");
    } else {
      this.finishItem(item.id, "failed", attempt.error
        || "Mail.com 母号未完成试用检测、提链或协议授权");
    }
  }

  async finishCancelledRegisteredAccountCleanup(attemptId) {
    let attempt = this.attemptRow(attemptId);
    let item = attempt ? this.itemRow(attempt.item_id) : null;
    if (!attempt || !item || !this.registeredAccountRemovalOutcome(attempt)) return false;
    if (attempt.stage === "account_pool_delete_failed" || attempt.recycle_status === "failed") {
      this.finishItem(item.id, "cancelled", attempt.recycle_error
        || "账号池记录与流水线不匹配，已保留账号池和邮箱");
      return true;
    }
    if (!this.registeredAccountCleanupCommitted(attempt)) return false;
    if (ACCOUNT_POOL_DELETE_PENDING_STAGES.has(String(attempt.stage || ""))) {
      const deletion = await this.ensureRegisteredAccountDeleted(attempt.id, { allowStart: false });
      attempt = this.attemptRow(attempt.id);
      item = attempt ? this.itemRow(attempt.item_id) : null;
      if (!attempt || !item) return true;
      if (deletion.status === "protected") return true;
    }
    if (attempt.stage === "account_pool_delete_failed" || attempt.recycle_status === "failed") {
      this.finishItem(item.id, "cancelled", attempt.recycle_error
        || "账号池记录与流水线不匹配，已保留账号池和邮箱");
      return true;
    }
    if (this.isMotherPrimaryItem(item) && attempt.stage === "account_pool_deleted") {
      this.finishPrimaryAfterRegisteredAccountDelete(attempt, item, { cancelled: true });
      return true;
    }
    this.finishItem(item.id, "cancelled", "任务已取消；正在完成已启动的账号池与邮箱清理");
    const current = this.attemptRow(attempt.id);
    if (current?.recycle_status === "running"
      && !new Set(["recycling", "recycle_remote_started"]).has(String(current.stage || ""))) {
      this.startOrphanRecycleRecovery(attempt.id);
    }
    return true;
  }

  async afterAttempt(attemptId) {
    let attempt = this.attemptRow(attemptId);
    let item = attempt ? this.itemRow(attempt.item_id) : null;
    let task = item ? this.taskRow(item.pipeline_id) : null;
    if (!attempt || !item || !task) return;
    if (this.itemWasCancelled(item.id) || new Set(["cancelled", "interrupted"]).has(attempt.status)) {
      if (this.registeredAccountCleanupCommitted(attempt)) {
        await this.finishCancelledRegisteredAccountCleanup(attempt.id);
        return;
      }
      await this.cancelItem(item.id);
      return;
    }
    if (this.registeredAccountCleanupCommitted(attempt)) {
      const deletion = await this.ensureRegisteredAccountDeleted(attempt.id, { allowStart: false });
      attempt = this.attemptRow(attempt.id);
      item = attempt ? this.itemRow(attempt.item_id) : null;
      task = item ? this.taskRow(item.pipeline_id) : null;
      if (!attempt || !item || !task) return;
      if (deletion.status === "mismatch" || attempt.stage === "account_pool_delete_failed") {
        this.finishItem(item.id, "failed", deletion.error || attempt.recycle_error
          || "账号池记录与流水线不匹配，未删除邮箱");
        return;
      }
      if (deletion.status === "retry_wait") return;
      if (deletion.status === "protected") return;
      if (this.itemWasCancelled(item.id)) {
        await this.finishCancelledRegisteredAccountCleanup(attempt.id);
        return;
      }
      await this.recycleAttempt(attempt.id);
      return;
    }
    if (attempt.agreement_status === "uncertain" || attempt.outcome === "agreement_unknown") {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'skipped', updated_at = ? WHERE id = ?
      `).run(nowIso(), attempt.id);
      this.finishItem(item.id, "failed", attempt.agreement_error || attempt.error
        || "协议授权结果无法确认，已保留当前别名");
      return;
    }
    if (attempt.outcome === "account_action_required") {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'skipped', updated_at = ? WHERE id = ?
      `).run(nowIso(), attempt.id);
      this.finishItem(item.id, "failed", attempt.error || "Mail.com 母号需要重新连接后才能继续");
      return;
    }
    if (attempt.outcome === "trial_account_mismatch") {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'skipped', updated_at = ? WHERE id = ?
      `).run(nowIso(), attempt.id);
      this.finishItem(item.id, "failed", attempt.error || "注册账号记录不匹配，已保留账号池和邮箱");
      return;
    }
    if (attempt.outcome === "trial_check_failed") {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'skipped', next_retry_at = NULL, updated_at = ? WHERE id = ?
      `).run(nowIso(), attempt.id);
      this.finishItem(item.id, "failed", attempt.error
        || "试用资格检测连续失败，账号池和邮箱均已保留");
      return;
    }
    if (this.protectedRegisteredAccount(attempt)) {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'skipped', updated_at = ? WHERE id = ?
      `).run(nowIso(), attempt.id);
      if (attempt.status === "succeeded") this.finishItem(item.id, "completed", "");
      else this.finishItem(
        item.id,
        "failed",
        attempt.error || (attempt.outcome === "link_blocked"
          ? "提链返回 blocked，账号池和邮箱均已保留"
          : "账号已提链，后续授权未完成；账号池和邮箱均已保留"),
      );
      return;
    }
    if (this.registeredAccountRemovalRequired(attempt)) {
      const deletion = await this.ensureRegisteredAccountDeleted(attempt.id);
      attempt = this.attemptRow(attempt.id);
      item = attempt ? this.itemRow(attempt.item_id) : null;
      task = item ? this.taskRow(item.pipeline_id) : null;
      if (!attempt || !item || !task) return;
      if (deletion.status === "mismatch" || attempt.stage === "account_pool_delete_failed") {
        this.finishItem(item.id, "failed", deletion.error || attempt.recycle_error
          || "账号池记录与流水线不匹配，未删除邮箱");
        return;
      }
      if (deletion.status === "retry_wait") return;
      if (deletion.status === "protected") return;
      if (deletion.status === "cancelled" || deletion.status === "not_started") {
        await this.cancelItem(item.id);
        return;
      }
      if (this.closed) return;
      if (this.itemWasCancelled(item.id)) {
        await this.finishCancelledRegisteredAccountCleanup(attempt.id);
        return;
      }
      await this.recycleAttempt(attempt.id);
      return;
    }
    if (attempt.status === "succeeded") {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'skipped', updated_at = ? WHERE id = ? AND recycle_status = 'pending'
      `).run(nowIso(), attempt.id);
      this.finishItem(item.id, "completed", "");
      return;
    }
    await this.recycleAttempt(attempt.id);
  }

  retryDelay(count) {
    return Math.min(this.retryMaximumMs, this.retryBaseMs * (2 ** Math.min(10, Math.max(0, Number(count) - 1))));
  }

  infrastructureSubmissionError(error, item = null) {
    const code = String(error?.code || "");
    if (RETRYABLE_LOCAL_SUBMISSION_CODES.has(code)) return true;
    if (unavailableRegistration(error)) return false;
    const message = safeError(error, "").toLowerCase();
    const account = item ? this.db.prepare("SELECT provider, status FROM source_accounts WHERE id = ?")
      .get(Number(item.account_id)) : null;
    return (item && (!account || account.provider !== "mailcom" || account.status !== "connected"))
      || /^(?:源头邮箱不存在|请先完成这个源头邮箱的连接验证|这个邮箱提供商不支持注册地址)$/.test(message)
      || /(?:注册)?代理(?:池)?(?:为空|已不存在|配置无效)|队列.*暂停|注册服务.*(?:不可用|连接失败|超时)/i.test(message);
  }

  scheduleAttemptRetry(attemptId, stage, error) {
    const attempt = this.attemptRow(attemptId);
    const item = attempt ? this.itemRow(attempt.item_id) : null;
    if (!attempt || !item || TERMINAL_ATTEMPT_STATUSES.has(attempt.status)
      || TERMINAL_ITEM_STATUSES.has(item.status)) return;
    const retryCount = item.retry_count + 1;
    const next = new Date(Date.now() + this.retryDelay(retryCount)).toISOString();
    const message = safeError(error, "流水线依赖当前不可用，等待重试");
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET stage = ?, error = ?, next_retry_at = ?,
          registration_status = CASE
            WHEN ? = 'registration_runtime_retry_wait' THEN 'queued'
            ELSE registration_status END,
          link_status = CASE WHEN ? = 'link_runtime_retry_wait' THEN 'pending' ELSE link_status END,
          agreement_status = CASE
            WHEN ? = 'agreement_runtime_retry_wait' THEN 'pending'
            ELSE agreement_status END,
          agreement_error = CASE
            WHEN ? = 'agreement_runtime_retry_wait' THEN ''
            ELSE agreement_error END,
          updated_at = ? WHERE id = ? AND status IN ('queued', 'running')
      `).run(stage, message, next, stage, stage, stage, stage, nowIso(), attempt.id);
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET status = 'retry_wait', stage = ?, retry_count = ?, next_retry_at = ?,
          error = ?, updated_at = ? WHERE id = ?
          AND status IN ('queued', 'running', 'retry_wait')
      `).run(stage, retryCount, next, message, nowIso(), item.id);
    })();
  }

  scheduleItemRetry(itemId, stage, error) {
    const item = this.itemRow(itemId);
    if (!item || TERMINAL_ITEM_STATUSES.has(item.status)) return;
    const retryCount = item.retry_count + 1;
    const next = new Date(Date.now() + this.retryDelay(retryCount)).toISOString();
    this.db.prepare(`
      UPDATE mailcom_registration_pipeline_items
      SET current_attempt_id = NULL, status = 'retry_wait', stage = ?, retry_count = ?,
        next_retry_at = ?, error = ?, updated_at = ? WHERE id = ?
    `).run(stage, retryCount, next, safeError(error), nowIso(), itemId);
  }

  aliasAccountActionRequired(value) {
    const code = String(value?.code || "");
    if (ALIAS_ACCOUNT_TRANSIENT_CODES.has(code)) return false;
    if (ALIAS_ACCOUNT_ACTION_REQUIRED_CODES.has(code)) return true;
    return /Mail\.com.*(?:网页授权已失效|网页授权.*缺失|网页登录.*失败|人机验证|账号.*不一致)|重新连接母号/i
      .test(String(value?.message || value || ""));
  }

  tripAliasAccount(item, error) {
    if (!item?.account_id) return null;
    const detail = safeError(error, "Mail.com 网页授权需要重新连接");
    const reason = `${ALIAS_ACTION_REQUIRED_REASON_PREFIX}${detail}`.slice(0, 500);
    this.db.prepare(`
      UPDATE source_accounts
      SET status = CASE
          WHEN status = 'action_required'
            AND (limit_reason = '' OR limit_reason LIKE ?) THEN 'connected'
          ELSE status END,
        limit_reason = ?, updated_at = ?
      WHERE id = ? AND provider = 'mailcom'
        AND status IN ('connected', 'action_required', 'error')
    `).run(`${ALIAS_ACTION_REQUIRED_REASON_PREFIX}%`, reason, nowIso(), item.account_id);
    return reason;
  }

  aliasAuthorizationAccount(value) {
    const accountId = Number(value?.account_id ?? value?.id ?? value);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) return null;
    return this.db.prepare(`
      SELECT accounts.id, accounts.email, accounts.status, accounts.limit_reason,
        credentials.credential_updated_at
      FROM source_accounts AS accounts
      LEFT JOIN mailcom_credentials AS credentials ON credentials.account_id = accounts.id
      WHERE accounts.id = ? AND accounts.provider = 'mailcom'
    `).get(accountId) || null;
  }

  async ensureAliasWebAuthorization(value, { force = false } = {}) {
    const account = this.aliasAuthorizationAccount(value);
    if (!account) {
      throw failure("Mail.com 母号已不存在", 409, "MAILCOM_PIPELINE_ACCOUNT_NOT_FOUND");
    }
    const blocked = String(account.limit_reason || "").startsWith(ALIAS_ACTION_REQUIRED_REASON_PREFIX);
    if (!force && !blocked) return { recovered: false, account_id: account.id };
    if (!account.credential_updated_at) {
      throw failure(
        `母号 ${account.email} 还没有保存 Mail.com 密码`,
        409,
        "MAILCOM_CREDENTIAL_REQUIRED",
      );
    }
    if (typeof this.mailcomAliases.verifyAuthorization !== "function") {
      throw failure(
        "Mail.com 网页授权自动恢复组件不可用",
        503,
        "MAILCOM_ALIAS_ADAPTER_UNAVAILABLE",
      );
    }

    const key = Number(account.id);
    if (this.authorizationRecoveries.has(key)) return this.authorizationRecoveries.get(key);
    const recovery = this.serializeAliasRemote(key, async () => {
      if (this.closed) throw failure("Mail.com 流水线服务正在关闭", 503, "MAILCOM_PIPELINE_CLOSED");
      const current = this.aliasAuthorizationAccount(key);
      if (!current) {
        throw failure("Mail.com 母号已不存在", 409, "MAILCOM_PIPELINE_ACCOUNT_NOT_FOUND");
      }
      const currentBlocked = String(current.limit_reason || "")
        .startsWith(ALIAS_ACTION_REQUIRED_REASON_PREFIX);
      if (!force && !currentBlocked) return { recovered: false, account_id: key };
      if (!current.credential_updated_at) {
        throw failure(
          `母号 ${current.email} 还没有保存 Mail.com 密码`,
          409,
          "MAILCOM_CREDENTIAL_REQUIRED",
        );
      }
      const expectedReason = String(current.limit_reason || "");
      const expectedCredentialUpdatedAt = current.credential_updated_at;
      try {
        const result = await this.mailcomAliases.verifyAuthorization(key);
        const at = nowIso();
        this.db.prepare(`
          UPDATE source_accounts
          SET status = CASE
              WHEN status = 'action_required' THEN 'connected'
              ELSE status END,
            limit_reason = '', updated_at = ?
          WHERE id = ? AND provider = 'mailcom' AND limit_reason = ?
            AND EXISTS (
              SELECT 1 FROM mailcom_credentials
              WHERE account_id = source_accounts.id AND credential_updated_at = ?
            )
        `).run(at, key, expectedReason, expectedCredentialUpdatedAt);
        return { recovered: true, account_id: key, result };
      } catch (error) {
        if (this.aliasAccountActionRequired(error)) {
          const reason = `${ALIAS_ACTION_REQUIRED_REASON_PREFIX}${safeError(
            error,
            "Mail.com 网页授权自动恢复失败",
          )}`.slice(0, 500);
          this.db.prepare(`
            UPDATE source_accounts
            SET status = CASE
                WHEN status = 'action_required' THEN 'connected'
                ELSE status END,
              limit_reason = ?, updated_at = ?
            WHERE id = ? AND provider = 'mailcom' AND limit_reason = ?
              AND EXISTS (
                SELECT 1 FROM mailcom_credentials
                WHERE account_id = source_accounts.id AND credential_updated_at = ?
              )
          `).run(reason, nowIso(), key, expectedReason, expectedCredentialUpdatedAt);
        }
        throw error;
      }
    }).finally(() => this.authorizationRecoveries.delete(key));
    this.authorizationRecoveries.set(key, recovery);
    return recovery;
  }

  authorizationRecoveryCandidates(accountIds = null, { force = false } = {}) {
    const ids = Array.isArray(accountIds)
      ? [...new Set(accountIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]
      : [];
    const conditions = [
      "accounts.provider = 'mailcom'",
      "accounts.status IN ('connected', 'action_required')",
      "credentials.account_id IS NOT NULL",
    ];
    const params = [];
    if (!force) {
      conditions.push("accounts.limit_reason LIKE ?");
      params.push(`${ALIAS_ACTION_REQUIRED_REASON_PREFIX}%`);
    }
    if (ids.length) {
      conditions.push(`accounts.id IN (${ids.map(() => "?").join(", ")})`);
      params.push(...ids);
    }
    return this.db.prepare(`
      SELECT accounts.id AS account_id, accounts.email AS source_email
      FROM source_accounts AS accounts
      JOIN mailcom_credentials AS credentials ON credentials.account_id = accounts.id
      WHERE ${conditions.join(" AND ")}
      ORDER BY accounts.id
    `).all(...params);
  }

  async recoverSavedAuthorizations({ accountIds = null, force = false } = {}) {
    const candidates = this.authorizationRecoveryCandidates(accountIds, { force });
    let recovered = 0;
    let failed = 0;
    for (const candidate of candidates) {
      if (this.closed) break;
      try {
        const result = await this.ensureAliasWebAuthorization(candidate, { force });
        if (result?.recovered) recovered += 1;
      } catch {
        failed += 1;
      }
    }
    return { total: candidates.length, recovered, failed };
  }

  scheduleSavedAuthorizationRecovery(accountIds, { force = true } = {}) {
    const ids = [...new Set((Array.isArray(accountIds) ? accountIds : [accountIds])
      .map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (!ids.length || this.closed) return { scheduled: 0 };
    const batch = this.recoverSavedAuthorizations({ accountIds: ids, force })
      .catch(() => ({ total: ids.length, recovered: 0, failed: ids.length }))
      .finally(() => this.authorizationBatches.delete(batch));
    this.authorizationBatches.add(batch);
    return { scheduled: ids.length };
  }

  restoreAliasAccountBlocks() {
    const rows = this.db.prepare(`
      SELECT items.account_id, items.source_email, attempts.recycle_error
      FROM mailcom_registration_pipeline_items AS items
      JOIN mailcom_registration_pipeline_attempts AS attempts ON attempts.item_id = items.id
      LEFT JOIN mailcom_credentials AS credentials ON credentials.account_id = items.account_id
      WHERE attempts.recycle_status = 'running'
        AND attempts.stage IN ('account_action_required_remote_uncertain', 'orphan_recycle_retry_wait')
        AND trim(attempts.recycle_error) <> ''
        AND (credentials.credential_updated_at IS NULL
          OR attempts.updated_at >= credentials.credential_updated_at)
      ORDER BY attempts.updated_at DESC
    `).all();
    const restored = new Set();
    rows.forEach((row) => {
      if (restored.has(Number(row.account_id))) return;
      const error = this.aliasAccountActionRequired(row.recycle_error) ? row.recycle_error : "";
      if (!error) return;
      this.tripAliasAccount(row, error);
      restored.add(Number(row.account_id));
    });
    return restored.size;
  }

  aliasCreateConflict(error) {
    const code = String(error?.code || "");
    if (Number(error?.status || 0) !== 409 || !ALIAS_CREATE_CONFLICT_CODES.has(code)) return false;
    return String(error?.mutation_phase || "") === "create_submitting";
  }

  tripAliasCreateConflict(item, error) {
    if (!item || !this.aliasCreateConflict(error)) return false;
    this.db.prepare(`
      UPDATE mailcom_registration_pipeline_items
      SET prepare_error = ?, updated_at = ?
      WHERE pipeline_id = ? AND account_id = ? AND slot_kind = 'primary'
    `).run(ALIAS_CREATE_CONFLICT_ERROR, nowIso(), item.pipeline_id, item.account_id);
    return true;
  }

  aliasCreateConflictForAccount(item) {
    if (!item) return false;
    return Boolean(this.db.prepare(`
      SELECT 1 FROM mailcom_registration_pipeline_items
      WHERE pipeline_id = ? AND account_id = ? AND slot_kind = 'primary'
        AND prepare_error = ?
      LIMIT 1
    `).get(item.pipeline_id, item.account_id, ALIAS_CREATE_CONFLICT_ERROR));
  }

  accountAliasCreateConflictError(item) {
    const source = String(item?.source_email || "").trim();
    return failure(
      `${source ? `母号 ${source} ` : ""}已收到官网确定性创建冲突；本次流水线不再删除该母号的其他官方别名`,
      409,
      "MAILCOM_PIPELINE_ACCOUNT_ALIAS_CREATE_CONFLICT",
    );
  }

  finishDeterministicRecycleFailure(attempt, item, error, { orphan = false } = {}) {
    if (!attempt || !item) return;
    const message = safeError(error, ALIAS_CREATE_CONFLICT_ERROR);
    const at = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'failed', stage = ?, recycle_error = ?,
          next_retry_at = NULL, updated_at = ?
        WHERE id = ? AND recycle_status <> 'succeeded'
      `).run(orphan ? "orphan_recycle_failed" : "recycle_failed", message, at, attempt.id);
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET replacement_email = '', next_retry_at = NULL, updated_at = ? WHERE id = ?
      `).run(at, item.id);
    })();
    if (TERMINAL_ITEM_STATUSES.has(item.status)) this.recomputeItem(item.id);
    else this.finishItem(item.id, "failed", message);
  }

  scheduleAliasConflictReconciliation(attempt, item, error, { orphan = false } = {}) {
    if (!attempt || !item) return;
    if (orphan) {
      this.persistOrphanRecycleRetry(attempt, item, error);
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts SET stage = ?, updated_at = ?
        WHERE id = ? AND recycle_status = 'running'
      `).run(ORPHAN_ALIAS_CREATE_CONFLICT_RECONCILE_STAGE, nowIso(), attempt.id);
      return;
    }
    const retries = Math.max(1, Number(attempt.recycle_attempts || 1));
    const next = new Date(Date.now() + this.retryDelay(retries)).toISOString();
    const message = safeError(error, "Mail.com 创建冲突后的官网状态尚未确认");
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'running', stage = ?, recycle_error = ?,
          next_retry_at = ?, updated_at = ?
        WHERE id = ? AND recycle_status <> 'succeeded'
      `).run(ALIAS_CREATE_CONFLICT_RECONCILE_STAGE, message, next, nowIso(), attempt.id);
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET status = 'retry_wait', stage = 'recycle_retry_wait',
          recycle_retry_count = recycle_retry_count + 1,
          next_retry_at = ?, error = ?, updated_at = ?
        WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
      `).run(next, message, nowIso(), item.id);
    })();
  }

  async reconcileAliasCreateConflict(attempt, item, { orphan = false } = {}) {
    if (!attempt || !item) return false;
    let result;
    try {
      if (typeof this.mailcomAliases.reconcileAccount !== "function") {
        throw failure(
          "Mail.com 官网状态恢复组件不可用",
          503,
          "MAILCOM_PIPELINE_ALIAS_RECONCILE_UNAVAILABLE",
        );
      }
      result = await this.serializeAliasRemote(item.account_id, () => {
        if (this.closed) {
          throw failure("Mail.com 流水线服务正在关闭", 503, "MAILCOM_PIPELINE_CLOSED");
        }
        return this.mailcomAliases.reconcileAccount(
          item.account_id,
          { purpose: "Mail.com 流水线创建冲突恢复" },
        );
      });
    } catch (error) {
      attempt = this.attemptRow(attempt.id);
      item = this.itemRow(item.id);
      if (!attempt || !item) return false;
      if (this.closed) return false;
      if (this.aliasAccountActionRequired(error)) this.tripAliasAccount(item, error);
      const currentOrphan = orphan || this.itemWasCancelled(item.id);
      this.scheduleAliasConflictReconciliation(attempt, item, error, { orphan: currentOrphan });
      if (currentOrphan) this.startOrphanRecycleRecovery(attempt.id);
      return false;
    }
    attempt = this.attemptRow(attempt.id);
    item = this.itemRow(item.id);
    if (!attempt || !item) return false;
    const replacement = this.replacementFromResult(item, result);
    if (replacement) {
      this.activateReplacement(item, attempt, replacement);
    } else {
      this.finishDeterministicRecycleFailure(
        attempt,
        item,
        this.accountAliasCreateConflictError(item),
        { orphan: orphan || this.itemWasCancelled(item.id) },
      );
    }
    return true;
  }

  aliasAccountBlock(item) {
    if (!item) return null;
    const account = this.db.prepare(`
      SELECT status, limit_reason FROM source_accounts WHERE id = ? AND provider = 'mailcom'
    `).get(item.account_id);
    return account?.status === "action_required"
      || String(account?.limit_reason || "").startsWith(ALIAS_ACTION_REQUIRED_REASON_PREFIX)
      ? account.limit_reason || "Mail.com 母号需要重新连接" : null;
  }

  accountAliasBlockedError(item) {
    const source = String(item?.source_email || "").trim();
    return failure(
      `母号 ${source || item?.account_id || ""} 的 Mail.com 网页授权需要处理，本母号已隔离；请更新密码或先在官网完成人机验证`,
      409,
      "MAILCOM_PIPELINE_ACCOUNT_ALIAS_QUARANTINED",
    );
  }

  finishBlockedRecycle(attempt, item, error) {
    if (!attempt || !item) return;
    const message = safeError(error, "Mail.com 母号网页授权已失效，请重新连接母号");
    this.db.prepare(`
      UPDATE mailcom_registration_pipeline_attempts
      SET recycle_status = 'failed', stage = 'recycle_account_blocked', recycle_error = ?,
        next_retry_at = NULL, updated_at = ?
      WHERE id = ? AND recycle_status <> 'succeeded'
    `).run(message, nowIso(), attempt.id);
    this.finishItem(item.id, "failed", message);
  }

  preserveSuccessfulRecycle(attempt, item, { completeItem = false } = {}) {
    if (!attempt || !item) return;
    const at = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'skipped', stage = CASE
            WHEN agreement_status = 'succeeded' THEN 'succeeded' ELSE stage END,
          recycle_error = '', next_retry_at = NULL, updated_at = ?
        WHERE id = ? AND recycle_status <> 'succeeded'
      `).run(at, attempt.id);
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET replacement_email = '', next_retry_at = NULL, updated_at = ? WHERE id = ?
      `).run(at, item.id);
    })();
    if (completeItem && !TERMINAL_ITEM_STATUSES.has(item.status)) this.finishItem(item.id, "completed", "");
    else this.recomputeItem(item.id);
  }

  preserveProtectedRecycle(attempt, item) {
    if (!attempt || !item) return;
    const at = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'skipped', recycle_error = '', next_retry_at = NULL, updated_at = ?
        WHERE id = ? AND recycle_status <> 'succeeded'
      `).run(at, attempt.id);
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET replacement_email = '', next_retry_at = NULL, updated_at = ? WHERE id = ?
      `).run(at, item.id);
    })();
    if (TERMINAL_ITEM_STATUSES.has(item.status)) {
      this.recomputeItem(item.id);
      return;
    }
    const detail = safeError(attempt.error, "提链或协议授权结果要求保留账号");
    this.finishItem(item.id, "failed", `${detail}；账号池和邮箱均已保留`);
  }

  waitForBlockedRecycle(attempt, item, error) {
    if (!attempt || !item) return;
    const message = safeError(error, "Mail.com 远端轮换结果待确认，请重新连接母号");
    const next = new Date(Date.now() + this.retryMaximumMs).toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'running', stage = 'account_action_required_remote_uncertain',
          recycle_error = ?, next_retry_at = ?, updated_at = ? WHERE id = ?
      `).run(message, next, nowIso(), attempt.id);
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET status = 'retry_wait', stage = 'account_action_required_remote_uncertain',
          recycle_retry_count = recycle_retry_count + 1, next_retry_at = ?, error = ?, updated_at = ?
        WHERE id = ?
      `).run(next, message, nowIso(), item.id);
    })();
  }

  scheduleRecycleRetry(attempt, item, error, { clearReplacement = false } = {}) {
    if (!attempt || !item) return;
    const retries = Math.max(
      1,
      Number(attempt.recycle_attempts || 0),
      Number(item.recycle_retry_count || 0) + 1,
    );
    const next = new Date(Date.now() + this.retryDelay(retries)).toISOString();
    const message = safeError(error, "Mail.com 网页授权正在自动恢复");
    const recycleStatus = this.registeredAccountRemovalOutcome(attempt) ? "running" : "retry_wait";
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = ?, stage = 'recycle_retry_wait', recycle_error = ?,
          next_retry_at = ?, updated_at = ?
        WHERE id = ? AND recycle_status <> 'succeeded'
      `).run(recycleStatus, message, next, nowIso(), attempt.id);
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET replacement_email = CASE WHEN ? THEN '' ELSE replacement_email END,
          status = 'retry_wait', stage = 'recycle_retry_wait',
          recycle_retry_count = recycle_retry_count + 1,
          next_retry_at = ?, error = ?, updated_at = ?
        WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
      `).run(clearReplacement ? 1 : 0, next, message, nowIso(), item.id);
    })();
  }

  resumeRecycleAfterAuthorization(attempt, item, { orphan = false } = {}) {
    if (!attempt || !item) return;
    const at = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET next_retry_at = NULL, recycle_error = '', updated_at = ?
        WHERE id = ? AND recycle_status IN ('running', 'retry_wait')
      `).run(at, attempt.id);
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET status = CASE
            WHEN ? THEN status
            WHEN status = 'retry_wait' THEN 'queued'
            ELSE status END,
          next_retry_at = NULL, error = '', updated_at = ?
        WHERE id = ?
      `).run(orphan ? 1 : 0, at, item.id);
    })();
    this.wake(item.id);
  }

  stableReplacement(item, domain) {
    if (item.replacement_email) return item.replacement_email;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const selectedDomain = domain === MAILCOM_RANDOM_DOMAIN
        ? this.randomReplacementDomain() : domain;
      const address = generatedReplacement(selectedDomain);
      const occupied = this.db.prepare("SELECT 1 FROM addresses WHERE address = ? COLLATE NOCASE LIMIT 1").get(address)
        || this.db.prepare(`
          SELECT 1 FROM mailcom_registration_pipeline_items
          WHERE replacement_email = ? COLLATE NOCASE LIMIT 1
        `).get(address);
      if (!occupied) {
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_items SET replacement_email = ?, updated_at = ?
          WHERE id = ? AND replacement_email = ''
        `).run(address, nowIso(), item.id);
        return this.itemRow(item.id).replacement_email;
      }
    }
    throw failure("无法生成不重复的 Mail.com 轮换地址", 409, "MAILCOM_PIPELINE_REPLACEMENT_EXHAUSTED");
  }

  randomReplacementDomain() {
    const sampled = Number(this.randomIntFn(mailcomDomains.length));
    const index = Number.isSafeInteger(sampled) && sampled >= 0 && sampled < mailcomDomains.length
      ? sampled : Math.abs(Math.trunc(sampled || 0)) % mailcomDomains.length;
    return mailcomDomains[index];
  }

  recycleDomain(taskDomain, replacementAddress) {
    if (taskDomain !== MAILCOM_RANDOM_DOMAIN) return taskDomain;
    const domain = String(replacementAddress || "").trim().toLowerCase().split("@")[1] || "";
    if (!mailcomDomains.includes(domain)) {
      throw failure(
        "随机 Mail.com 轮换地址的域名后缀无效",
        409,
        "MAILCOM_ALIAS_REPLACEMENT_INVALID",
      );
    }
    return domain;
  }

  async replaceAliasRemote(item, attempt, task, replacementAddress, recycleAddress = "") {
    const domain = this.recycleDomain(task.domain, replacementAddress);
    if (this.isMotherPrimaryItem(item)) {
      if (typeof this.mailcomAliases.createReplacementAlias !== "function") {
        throw failure(
          "Mail.com 母号替代别名创建服务不可用",
          503,
          "MAILCOM_ALIAS_CREATE_REPLACEMENT_UNAVAILABLE",
        );
      }
      return this.mailcomAliases.createReplacementAlias(item.account_id, {
        domain,
        replacementAddress,
        ...(recycleAddress ? { recycleAddress } : {}),
      });
    }
    return this.mailcomAliases.recycleAlias(item.account_id, {
      address: attempt.email,
      domain,
      replacementAddress,
    });
  }

  serializeAliasRemote(accountId, operation) {
    const key = Number(accountId);
    const queueKey = Number.isSafeInteger(key) && key > 0 ? key : String(accountId || "global");
    const previous = this.aliasQueues.get(queueKey) || Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      await this.aliasOperationSemaphore.acquire();
      try {
        return await operation();
      } finally {
        this.aliasOperationSemaphore.release();
      }
    });
    const settled = current.catch(() => undefined);
    this.aliasQueues.set(queueKey, settled);
    this.aliasOperations.add(current);
    return current.finally(() => {
      this.aliasOperations.delete(current);
      if (this.aliasQueues.get(queueKey) === settled) this.aliasQueues.delete(queueKey);
    });
  }

  unassignedReplacement(item, preferred = "") {
    const normalized = String(preferred || "").trim().toLowerCase();
    const assigned = this.db.prepare(`
      SELECT current_address_id, current_email
      FROM mailcom_registration_pipeline_items
      WHERE pipeline_id = ? AND account_id = ? AND id <> ?
    `).all(item.pipeline_id, item.account_id, item.id);
    const assignedIds = new Set(assigned.map((entry) => Number(entry.current_address_id)).filter(Boolean));
    const assignedEmails = new Set(assigned.map((entry) => String(entry.current_email || "").toLowerCase()));
    const candidates = this.db.prepare(`
      SELECT * FROM addresses
      WHERE account_id = ? AND kind = 'official' AND strategy = ? AND status = 'active'
      ORDER BY id DESC
    `).all(item.account_id, MAILCOM_ALIAS_STRATEGY);
    return candidates.find((candidate) => {
      const email = String(candidate.address || "").toLowerCase();
      return (!normalized || email === normalized)
        && !assignedIds.has(Number(candidate.id)) && !assignedEmails.has(email)
        && email !== String(item.current_email || "").toLowerCase();
    }) || (!normalized ? candidates.find((candidate) => {
      const email = String(candidate.address || "").toLowerCase();
      return !assignedIds.has(Number(candidate.id)) && !assignedEmails.has(email)
        && email !== String(item.current_email || "").toLowerCase();
    }) : null);
  }

  replacementFromResult(item, result) {
    const preferred = String(
      result?.item?.address
      || (typeof result?.created === "object" ? result.created?.address : result?.created)
      || item.replacement_email
      || "",
    ).trim().toLowerCase();
    if (result?.item?.id && String(result.item.address || "").toLowerCase() === preferred) {
      const stored = this.db.prepare(`
        SELECT * FROM addresses WHERE id = ? AND account_id = ? AND status = 'active'
      `).get(Number(result.item.id), item.account_id);
      if (stored) return stored;
    }
    return this.unassignedReplacement(item, preferred) || this.unassignedReplacement(item, "");
  }

  transientRecycleError(error) {
    const status = Number(error?.status || 0);
    const code = String(error?.code || "");
    return status === 408 || status === 429 || status >= 500
      || /(?:UNAVAILABLE|TIMEOUT|AUTOMATION_FAILED|CONFIRMATION_FAILED|RECYCLE_PROTECTED|RECONCILE_CONFLICT|BROWSER_BUSY|CREATION_IN_PROGRESS)$/.test(code);
  }

  orphanRecycleSafeToRelease(error) {
    return error?.remote_mutation_possible === false
      || String(error?.code || "") === "MAILCOM_ALIAS_REMOTE_PROTECTED"
      || (String(error?.code || "") === "MAILCOM_ALIAS_CONFLICT"
        && error?.remote_state_reconciled === true);
  }

  async recycleAttempt(attemptId) {
    let attempt = this.attemptRow(attemptId);
    let item = attempt ? this.itemRow(attempt.item_id) : null;
    const task = item ? this.taskRow(item.pipeline_id) : null;
    if (!attempt || !item || !task) return;
    if (this.protectedRegisteredAccount(attempt)) {
      this.preserveProtectedRecycle(attempt, item);
      return;
    }
    if (this.hasSuccessfulAgreement(attempt.email)) {
      this.preserveSuccessfulRecycle(attempt, item, { completeItem: true });
      return;
    }
    if (attempt.recycle_status === "succeeded") {
      const replacement = this.replacementFromResult(item, { created: attempt.replacement_email });
      if (replacement) this.activateReplacement(item, attempt, replacement);
      return;
    }
    if (this.itemWasCancelled(item.id) || this.closed) {
      if (!this.closed && this.registeredAccountCleanupCommitted(attempt)) {
        this.startOrphanRecycleRecovery(attempt.id);
      }
      return;
    }
    const plannedReplacement = item.replacement_email
      ? this.unassignedReplacement(item, item.replacement_email) : null;
    // A primary slot is the only path that needs an extra official address.
    // At the ten-address remote limit it may proceed only with a candidate
    // that the account/alias history proves safe to remove.
    const initialMotherCandidates = this.isMotherPrimaryItem(item)
      ? this.motherAliasCandidates(item) : [];
    const capacityError = plannedReplacement ? null : this.replacementCapacityError(item, {
      deletableAliasCount: initialMotherCandidates.length,
    });
    if (capacityError) {
      if (this.motherAliasCandidatePending(item)) {
        this.scheduleRecycleRetry(attempt, item, this.motherAliasCandidateWaitingError(item));
        return;
      }
      const finalCandidates = this.motherAliasCandidates(item);
      const finalCapacityError = this.replacementCapacityError(item, {
        deletableAliasCount: finalCandidates.length,
      });
      if (finalCapacityError) {
        this.finishDeterministicRecycleFailure(attempt, item, finalCapacityError);
        return;
      }
    }
    if (this.aliasAccountBlock(item)) {
      try {
        await this.ensureAliasWebAuthorization(item);
      } catch (error) {
        const blocked = this.accountAliasBlockedError(item);
        if (attempt.stage === "account_action_required_remote_uncertain") {
          this.waitForBlockedRecycle(attempt, item, blocked);
        } else {
          this.scheduleRecycleRetry(attempt, item, blocked);
        }
        return;
      }
      attempt = this.attemptRow(attempt.id);
      item = this.itemRow(item.id);
      if (!attempt || !item || this.itemWasCancelled(item.id) || this.closed) return;
      if (this.aliasAccountBlock(item)) {
        this.scheduleRecycleRetry(attempt, item, this.accountAliasBlockedError(item));
        return;
      }
    }
    if (attempt.stage === ALIAS_CREATE_CONFLICT_RECONCILE_STAGE) {
      await this.reconcileAliasCreateConflict(attempt, item);
      return;
    }
    if (this.aliasCreateConflictForAccount(item)) {
      this.finishDeterministicRecycleFailure(
        attempt,
        item,
        this.accountAliasCreateConflictError(item),
      );
      return;
    }
    const replacementAddress = this.stableReplacement(item, task.domain);
    const at = nowIso();
    this.db.prepare(`
      UPDATE mailcom_registration_pipeline_attempts
      SET recycle_status = 'running', recycle_attempts = recycle_attempts + 1,
        stage = 'recycling', next_retry_at = NULL, updated_at = ?
      WHERE id = ? AND recycle_status IN ('pending', 'running', 'retry_wait')
    `).run(at, attempt.id);
    this.db.prepare(`
      UPDATE mailcom_registration_pipeline_items
      SET status = 'running', stage = 'recycling', next_retry_at = NULL, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running', 'retry_wait')
    `).run(at, item.id);
    attempt = this.attemptRow(attempt.id);
    item = this.itemRow(item.id);
    let motherCandidates = this.isMotherPrimaryItem(item) && !plannedReplacement
      ? this.motherAliasCandidates(item) : [];
    const refreshedCapacityError = !plannedReplacement && this.isMotherPrimaryItem(item)
      ? this.replacementCapacityError(item, { deletableAliasCount: motherCandidates.length }) : null;
    if (refreshedCapacityError) {
      if (this.motherAliasCandidatePending(item)) {
        this.scheduleRecycleRetry(attempt, item, this.motherAliasCandidateWaitingError(item));
        return;
      }
      motherCandidates = this.motherAliasCandidates(item);
      const finalCapacityError = this.replacementCapacityError(item, {
        deletableAliasCount: motherCandidates.length,
      });
      if (finalCapacityError) {
        this.finishDeterministicRecycleFailure(attempt, item, finalCapacityError);
        return;
      }
    }
    let result;
    let candidateIndex = 0;
    const attemptedMotherCandidates = new Set();
    while (true) {
      const recycleAddress = motherCandidates[candidateIndex]?.address || "";
      if (recycleAddress) attemptedMotherCandidates.add(String(recycleAddress).toLowerCase());
      try {
        result = await this.serializeAliasRemote(item.account_id, async () => {
        const latestItem = this.itemRow(item.id);
        const latestTask = latestItem ? this.taskRow(latestItem.pipeline_id) : null;
        const latestAttempt = this.attemptRow(attempt.id);
        if (this.closed || !latestItem || !latestTask || this.itemWasCancelled(latestItem.id)
          || TERMINAL_PIPELINE_STATUSES.has(latestTask.status)) {
          throw failure("Mail.com 别名轮换已取消", 409, "MAILCOM_PIPELINE_CANCELLED");
        }
        if (this.protectedRegisteredAccount(latestAttempt)) {
          throw failure(
            "blocked 或已提链账号必须保留，禁止轮换邮箱",
            409,
            "MAILCOM_ALIAS_REGISTERED_ACCOUNT_PROTECTED",
          );
        }
        if (this.hasSuccessfulAgreement(attempt.email)) {
          throw failure(
            "协议授权成功账号永久保留，禁止轮换邮箱",
            409,
            "MAILCOM_ALIAS_AGREEMENT_PROTECTED",
          );
        }
        const queuedAccountBlock = this.aliasAccountBlock(latestItem);
        if (queuedAccountBlock) {
          throw this.accountAliasBlockedError(latestItem);
        }
        if (this.aliasCreateConflictForAccount(latestItem)) {
          throw this.accountAliasCreateConflictError(latestItem);
        }
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_attempts
          SET stage = 'recycle_remote_started', updated_at = ?
          WHERE id = ? AND recycle_status = 'running'
        `).run(nowIso(), attempt.id);
        try {
          return await this.replaceAliasRemote(
            latestItem,
            latestAttempt,
            latestTask,
            replacementAddress,
            recycleAddress,
          );
        } catch (error) {
          this.tripAliasCreateConflict(latestItem, error);
          if (this.aliasAccountActionRequired(error)) this.tripAliasAccount(latestItem, error);
          throw error;
        }
        });
        break;
      } catch (error) {
        const guardedAttempt = this.attemptRow(attempt.id);
        if (this.protectedRegisteredAccount(guardedAttempt)) {
          this.preserveProtectedRecycle(guardedAttempt, this.itemRow(item.id));
          return;
        }
        if (this.hasSuccessfulAgreement(guardedAttempt?.email)) {
          this.preserveSuccessfulRecycle(guardedAttempt, this.itemRow(item.id), { completeItem: true });
          return;
        }
        if (this.isMotherPrimaryItem(item)
          && !plannedReplacement
          && this.candidateProtectionError(error)) {
          const refreshed = this.motherAliasCandidates(item);
          const nextIndex = refreshed.findIndex((candidate) => (
            !attemptedMotherCandidates.has(String(candidate.address || "").toLowerCase())
          ));
          if (nextIndex >= 0) {
            motherCandidates = refreshed;
            candidateIndex = nextIndex;
            continue;
          }
          const exhausted = this.replacementCapacityError(item, { deletableAliasCount: 0 });
          if (exhausted) {
            this.finishDeterministicRecycleFailure(
              this.attemptRow(attempt.id),
              this.itemRow(item.id),
              exhausted,
            );
            return;
          }
          motherCandidates = [];
          candidateIndex = 0;
          continue;
        }
      item = this.itemRow(item.id);
      if (String(error?.code || "") === "MAILCOM_ALIAS_REGISTERED_ACCOUNT_PROTECTED"
        || this.protectedRegisteredAccount(this.attemptRow(attempt.id))) {
        this.preserveProtectedRecycle(this.attemptRow(attempt.id), item);
        return;
      }
      if (String(error?.code || "") === "MAILCOM_ALIAS_AGREEMENT_PROTECTED"
        || this.hasSuccessfulAgreement(attempt.email)) {
        this.preserveSuccessfulRecycle(this.attemptRow(attempt.id), item, { completeItem: true });
        return;
      }
      const recovered = this.unassignedReplacement(item, replacementAddress);
      if (recovered) {
        this.activateReplacement(item, this.attemptRow(attempt.id), recovered);
        return;
      }
      const createConflict = this.tripAliasCreateConflict(item, error);
      if (createConflict) {
        const currentAttempt = this.attemptRow(attempt.id);
        const orphan = this.itemWasCancelled(item.id);
        if (this.orphanRecycleSafeToRelease(error)) {
          this.finishDeterministicRecycleFailure(currentAttempt, item, error, { orphan });
        } else {
          this.scheduleAliasConflictReconciliation(currentAttempt, item, error, { orphan });
          if (orphan) this.startOrphanRecycleRecovery(attempt.id);
        }
        return;
      }
      if (String(error?.code || "") === "MAILCOM_PIPELINE_ACCOUNT_ALIAS_CREATE_CONFLICT") {
        this.finishDeterministicRecycleFailure(
          this.attemptRow(attempt.id),
          item,
          this.accountAliasCreateConflictError(item),
          { orphan: this.itemWasCancelled(item.id) },
        );
        return;
      }
      if (this.itemWasCancelled(item.id)) {
        const currentAttempt = this.attemptRow(attempt.id);
        if (this.registeredAccountRemovalOutcome(currentAttempt)) {
          if (this.orphanRecycleSafeToRelease(error)) {
            this.finishDeterministicRecycleFailure(currentAttempt, item, error, { orphan: true });
            return;
          }
          this.persistOrphanRecycleRetry(currentAttempt, item, error, {
            clearReplacement: String(error?.code || "") === "MAILCOM_ALIAS_REPLACEMENT_UNAVAILABLE",
          });
          this.startOrphanRecycleRecovery(attempt.id);
          return;
        }
        const remoteStarted = new Set([
          "recycle_remote_started", "orphan_recycle_retry_wait",
        ]).has(String(currentAttempt?.stage || ""));
        if (remoteStarted && !this.orphanRecycleSafeToRelease(error)) {
          this.persistOrphanRecycleRetry(currentAttempt, item, error, {
            clearReplacement: String(error?.code || "") === "MAILCOM_ALIAS_REPLACEMENT_UNAVAILABLE",
          });
          this.startOrphanRecycleRecovery(attempt.id);
        } else {
          this.db.prepare(`
            UPDATE mailcom_registration_pipeline_attempts
            SET recycle_status = 'skipped', stage = 'recycle_cancelled', recycle_error = ?,
              next_retry_at = NULL, updated_at = ? WHERE id = ? AND recycle_status = 'running'
          `).run(safeError(error, "任务已取消"), nowIso(), attempt.id);
        }
        return;
      }
      if (this.closed) return;
      if (this.aliasAccountActionRequired(error)
        || String(error?.code || "") === "MAILCOM_PIPELINE_ACCOUNT_ALIAS_QUARANTINED") {
        if (String(error?.code || "") !== "MAILCOM_PIPELINE_ACCOUNT_ALIAS_QUARANTINED") {
          this.tripAliasAccount(item, error);
        }
        const blocked = this.accountAliasBlockedError(item);
        if (error?.remote_mutation_possible === true) {
          this.waitForBlockedRecycle(this.attemptRow(attempt.id), item, blocked);
        } else {
          this.scheduleRecycleRetry(this.attemptRow(attempt.id), item, blocked);
        }
        const authorizationRecovered = await this.ensureAliasWebAuthorization(item)
          .then(() => true, () => false);
        if (authorizationRecovered) {
          this.resumeRecycleAfterAuthorization(this.attemptRow(attempt.id), this.itemRow(item.id));
        }
        return;
      }
      const replacementUnavailable = String(error?.code || "") === "MAILCOM_ALIAS_REPLACEMENT_UNAVAILABLE";
      const randomDomainUnavailable = task.domain === MAILCOM_RANDOM_DOMAIN
        && String(error?.code || "") === "MAILCOM_ALIAS_DOMAIN_UNAVAILABLE";
      if (replacementUnavailable || randomDomainUnavailable) {
        this.scheduleRecycleRetry(this.attemptRow(attempt.id), item, error, { clearReplacement: true });
        return;
      }
      if (this.transientRecycleError(error)) {
        this.scheduleRecycleRetry(this.attemptRow(attempt.id), item, error);
        return;
      }
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'failed', stage = 'recycle_failed', recycle_error = ?, updated_at = ? WHERE id = ?
      `).run(safeError(error), nowIso(), attempt.id);
      this.finishItem(item.id, "failed", safeError(error, "Mail.com 别名轮换失败"));
      return;
      }
    }
    item = this.itemRow(item.id);
    if (this.protectedRegisteredAccount(this.attemptRow(attempt.id))) {
      this.preserveProtectedRecycle(this.attemptRow(attempt.id), item);
      return;
    }
    if (this.hasSuccessfulAgreement(attempt.email)) {
      this.preserveSuccessfulRecycle(this.attemptRow(attempt.id), item, { completeItem: true });
      return;
    }
    const replacement = this.replacementFromResult(item, result);
    if (!replacement) {
      const missing = failure("Mail.com 别名已轮换但本地未找到新地址", 502, "MAILCOM_PIPELINE_REPLACEMENT_NOT_FOUND");
      this.scheduleRecycleRetry(this.attemptRow(attempt.id), item, missing);
      return;
    }
    this.activateReplacement(item, this.attemptRow(attempt.id), replacement);
  }

  activateReplacement(item, attempt, replacement) {
    if (this.protectedRegisteredAccount(attempt)) {
      this.preserveProtectedRecycle(attempt, this.itemRow(item.id));
      return;
    }
    if (this.hasSuccessfulAgreement(attempt?.email)) {
      this.preserveSuccessfulRecycle(attempt, this.itemRow(item.id), { completeItem: true });
      return;
    }
    const at = nowIso();
    this.db.transaction(() => {
      const currentItem = this.itemRow(item.id);
      const parent = currentItem ? this.taskRow(currentItem.pipeline_id) : null;
      if (!currentItem || !parent) return;
      const confirmedPlannedReplacement = Boolean(currentItem.replacement_email)
        && String(currentItem.replacement_email).toLowerCase()
          === String(replacement.address || "").toLowerCase();
      const changed = this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'succeeded', stage = 'recycled',
          replacement_address_id = ?, replacement_email = ?, next_retry_at = NULL, updated_at = ?
        WHERE id = ? AND recycle_status <> 'succeeded'
      `).run(replacement.id, replacement.address, at, attempt.id);
      const cancellationWon = new Set(["cancel_requested", "cancelled"]).has(currentItem.status)
        || parent.status === "cancel_requested" || TERMINAL_PIPELINE_STATUSES.has(parent.status);
      if (cancellationWon) {
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_items
          SET current_address_id = ?, current_email = ?, replacement_email = '',
            recycled_count = recycled_count + ?, created_count = created_count + ?,
            recycle_retry_count = 0, next_retry_at = NULL, updated_at = ?
          WHERE id = ?
        `).run(
          replacement.id,
          replacement.address,
          changed.changes ? 1 : 0,
          changed.changes ? 1 : 0,
          at,
          item.id,
        );
      } else {
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_items
          SET current_address_id = ?, current_email = ?, replacement_email = '', current_attempt_id = NULL,
            status = 'queued', stage = 'registration_queued', recycled_count = recycled_count + ?,
            created_count = created_count + ?, recycle_retry_count = 0, next_retry_at = NULL,
            error = '', updated_at = ? WHERE id = ?
        `).run(
          replacement.id,
          replacement.address,
          changed.changes ? 1 : 0,
          changed.changes ? 1 : 0,
          at,
          item.id,
        );
      }
      if (confirmedPlannedReplacement) {
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_items
          SET prepare_error = '', updated_at = ?
          WHERE pipeline_id = ? AND account_id = ? AND slot_kind = 'primary'
            AND prepare_error = ?
        `).run(at, currentItem.pipeline_id, currentItem.account_id, ALIAS_CREATE_CONFLICT_ERROR);
      }
    })();
    this.recomputeItem(item.id);
  }

  async handleCycleError(itemId, error) {
    const item = this.itemRow(itemId);
    if (!item || TERMINAL_ITEM_STATUSES.has(item.status)) return;
    if (this.itemWasCancelled(itemId)) return this.cancelItem(itemId);
    const attempt = item.current_attempt_id ? this.attemptRow(item.current_attempt_id) : null;
    if (attempt && !TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
      const linkStage = String(attempt.stage).startsWith("link_")
        || String(attempt.stage).startsWith("trial_");
      const agreementStage = String(attempt.stage).startsWith("agreement_");
      this.finishAttempt(attempt.id, "failed",
        agreementStage ? "agreement_failed" : linkStage ? "link_failed" : "registration_failed",
        safeError(error), {
        failureReason: String(error?.code || "pipeline_error"),
        registrationStatus: agreementStage || linkStage ? "succeeded" : "failed",
        linkStatus: agreementStage ? "succeeded" : linkStage ? "failed" : "skipped",
        agreementStatus: agreementStage ? "failed" : "skipped",
      });
      await this.afterAttempt(attempt.id);
      return;
    }
    if (item.slot_kind === "primary") this.scheduleItemRetry(item.id, "registration_retry_wait", error);
    else this.finishItem(item.id, "failed", safeError(error));
  }

  recomputeItem(itemId) {
    const item = this.itemRow(itemId);
    if (!item) return;
    const counts = this.db.prepare(`
      SELECT COUNT(*) AS attempts,
        SUM(CASE WHEN registration_status = 'succeeded' THEN 1 ELSE 0 END) AS registrations,
        SUM(CASE WHEN link_status = 'succeeded' THEN 1 ELSE 0 END) AS links,
        SUM(CASE WHEN agreement_status = 'succeeded' THEN 1 ELSE 0 END) AS agreements,
        SUM(CASE WHEN agreement_status = 'failed' THEN 1 ELSE 0 END) AS agreement_failures,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
        SUM(CASE WHEN recycle_status = 'succeeded' THEN 1 ELSE 0 END) AS recycled
      FROM mailcom_registration_pipeline_attempts WHERE item_id = ?
    `).get(item.id);
    this.db.prepare(`
      UPDATE mailcom_registration_pipeline_items
      SET attempt_count = ?, registration_success_count = ?, link_success_count = ?,
        agreement_success_count = ?, agreement_failure_count = ?,
        failure_count = ?, recycled_count = ?, updated_at = ? WHERE id = ?
    `).run(
      Number(counts?.attempts || 0),
      Number(counts?.registrations || 0),
      Number(counts?.links || 0),
      Number(counts?.agreements || 0),
      Number(counts?.agreement_failures || 0),
      Number(counts?.failures || 0),
      Number(counts?.recycled || 0),
      nowIso(),
      item.id,
    );
    this.recompute(item.pipeline_id);
  }

  finishItem(itemId, status, error = "") {
    const item = this.itemRow(itemId);
    if (!item || TERMINAL_ITEM_STATUSES.has(item.status)) return item;
    let normalized = TERMINAL_ITEM_STATUSES.has(status) ? status : "failed";
    if (item.status === "cancel_requested" && normalized !== "completed") normalized = "cancelled";
    const at = nowIso();
    this.db.prepare(`
      UPDATE mailcom_registration_pipeline_items
      SET status = ?, stage = ?, error = ?, next_retry_at = NULL,
        finished_at = ?, updated_at = ? WHERE id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
    `).run(normalized, normalized, normalized === "completed" ? "" : safeError(error), at, at, itemId);
    this.wake(itemId);
    this.recompute(item.pipeline_id);
    return this.itemRow(itemId);
  }

  recompute(taskId) {
    const task = this.taskRow(taskId);
    if (!task) return;
    const items = this.items(taskId);
    const sums = items.reduce((result, item) => ({
      attempts: result.attempts + Number(item.attempt_count || 0),
      registrations: result.registrations + Number(item.registration_success_count || 0),
      links: result.links + Number(item.link_success_count || 0),
      agreements: result.agreements + Number(item.agreement_success_count || 0),
      agreementFailures: result.agreementFailures + Number(item.agreement_failure_count || 0),
      failures: result.failures + Number(item.failure_count || 0),
      recycled: result.recycled + Number(item.recycled_count || 0),
      created: result.created + Number(item.created_count || 0),
    }), {
      attempts: 0,
      registrations: 0,
      links: 0,
      agreements: 0,
      agreementFailures: 0,
      failures: 0,
      recycled: 0,
      created: 0,
    });
    const completed = items.filter((item) => item.status === "completed").length;
    const failedItems = items.filter((item) => new Set(["failed", "interrupted"]).has(item.status)).length;
    const cancelled = items.filter((item) => item.status === "cancelled").length;
    const terminal = completed + failedItems + cancelled;
    let status = task.status === "cancel_requested" ? "cancel_requested" : "running";
    let stage = task.status === "cancel_requested" ? "cancel_requested" : "processing";
    let finishedAt = null;
    let error = task.error || "";
    if (items.length && terminal === items.length) {
      finishedAt = task.finished_at || nowIso();
      if (new Set(["cancel_requested", "cancelled"]).has(task.status) && failedItems === 0) {
        status = "cancelled";
        stage = "cancelled";
        error = "任务已取消";
      } else if (completed === items.length) {
        status = "completed";
        stage = "completed";
        error = "";
      } else if (completed > 0) {
        status = "partial_failed";
        stage = "partial_failed";
        error = "部分 Mail.com slot 未完成";
      } else if (failedItems > 0) {
        status = "failed";
        stage = "failed";
        error = "Mail.com 流水线执行失败";
      } else {
        status = "cancelled";
        stage = "cancelled";
        error = "任务已取消";
      }
    } else if (task.status !== "cancel_requested") {
      const active = items.find((item) => ACTIVE_ITEM_STATUSES.has(item.status));
      stage = active?.stage || stage;
      const prepareErrors = items.map((item) => item.prepare_error).filter(Boolean);
      if (prepareErrors.length) error = `${prepareErrors.length} 个母号别名准备失败，已继续处理现有地址`;
    }
    this.db.prepare(`
      UPDATE mailcom_registration_pipelines
      SET status = ?, stage = ?, slot_count = ?, attempt_count = ?,
        registration_success_count = ?, link_success_count = ?,
        agreement_success_count = ?, agreement_failure_count = ?, failure_count = ?,
        recycled_count = ?, created_count = ?, cancelled_count = ?, error = ?,
        finished_at = ?, updated_at = ? WHERE id = ?
    `).run(
      status,
      stage,
      items.length,
      sums.attempts,
      sums.registrations,
      sums.links,
      sums.agreements,
      sums.agreementFailures,
      sums.failures,
      sums.recycled,
      sums.created,
      cancelled,
      error,
      finishedAt,
      nowIso(),
      taskId,
    );
  }

  itemWasCancelled(itemId) {
    const item = this.itemRow(itemId);
    const task = item ? this.taskRow(item.pipeline_id) : null;
    return !item || !task
      || new Set(["cancel_requested", "cancelled"]).has(item.status)
      || new Set(["cancel_requested", "cancelled"]).has(task.status);
  }

  async cancelKnownChildren(attempt) {
    if (!attempt) return;
    const registrationJob = attempt.registration_job_id
      ? this.registration.getJob(attempt.registration_job_id) : null;
    if (registrationJob && !new Set(["completed", "failed", "cancelled", "interrupted"]).has(registrationJob.status)) {
      await this.registration.cancelJob(attempt.registration_job_id).catch(() => undefined);
    }
    const paymentLink = this.paymentLinks.row(attempt.external_account_id);
    const submittedTaskId = String(attempt.payment_link_task_id || "");
    const inFlightTaskId = !submittedTaskId && attempt.stage === "link_submitting"
      && paymentLink?.task_id
      && String(paymentLink.started_at || paymentLink.updated_at || "")
        >= String(attempt.registration_finished_at || attempt.created_at || "")
      ? String(paymentLink.task_id) : "";
    await this.cancelPaymentLinkTask(
      attempt.external_account_id,
      submittedTaskId || inFlightTaskId,
    );
    if (attempt.agreement_job_id && this.paymentAgreements.context?.(attempt.agreement_job_id)) {
      try {
        await this.paymentAgreements.cancelJob(attempt.agreement_job_id);
        await this.paymentAgreements.releaseContext?.(attempt.agreement_job_id, {
          force: true,
          successful: false,
        }).catch(() => undefined);
      } catch { /* Retain the context while its tracker retries remote cancellation. */ }
    }
  }

  async cancelItem(itemId) {
    const key = Number(itemId);
    if (this.cancellations.has(key)) return this.cancellations.get(key);
    const cancellation = (async () => {
      let item = this.itemRow(key);
      if (!item || TERMINAL_ITEM_STATUSES.has(item.status)) return item;
      let attempt = item.current_attempt_id ? this.attemptRow(item.current_attempt_id) : null;
      await this.cancelKnownChildren(attempt);
      item = this.itemRow(key);
      attempt = item?.current_attempt_id ? this.attemptRow(item.current_attempt_id) : null;
      if (!item) return item;
      if (attempt && this.registeredAccountCleanupCommitted(attempt)) {
        await this.finishCancelledRegisteredAccountCleanup(attempt.id);
        return this.itemRow(key);
      }
      if (attempt?.stage === "account_pool_delete_failed") {
        this.finishItem(item.id, "cancelled", attempt.recycle_error
          || "账号池记录与流水线不匹配，已保留账号池和邮箱");
        return this.itemRow(key);
      }
      if (attempt && new Set([
        ALIAS_CREATE_CONFLICT_RECONCILE_STAGE,
        ORPHAN_ALIAS_CREATE_CONFLICT_RECONCILE_STAGE,
      ]).has(String(attempt.stage || "")) && attempt.recycle_status === "running") {
        this.scheduleAliasConflictReconciliation(
          attempt,
          item,
          failure(
            attempt.recycle_error || "Mail.com 创建冲突后的官网状态尚未确认",
            503,
            "MAILCOM_PIPELINE_ALIAS_RECONCILE_PENDING",
          ),
          { orphan: true },
        );
        const cancelled = this.finishItem(item.id, "cancelled", "任务已取消；正在确认 Mail.com 官网地址状态");
        this.startOrphanRecycleRecovery(attempt.id);
        return cancelled;
      }
      const at = nowIso();
      if (attempt && !TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_attempts
          SET status = 'cancelled', stage = 'cancelled', outcome = 'cancelled',
            registration_status = CASE WHEN registration_status = 'succeeded' THEN registration_status ELSE 'cancelled' END,
            trial_status = CASE
              WHEN trial_status IN ('eligible', 'ineligible', 'skipped') THEN trial_status
              ELSE 'skipped' END,
            trial_checked_at = COALESCE(trial_checked_at, ?),
            link_status = CASE WHEN link_status = 'succeeded' THEN link_status ELSE 'cancelled' END,
            agreement_status = CASE
              WHEN agreement_status = 'succeeded' THEN agreement_status
              WHEN link_status <> 'succeeded' THEN 'skipped'
              ELSE 'cancelled' END,
            agreement_error = CASE WHEN agreement_status = 'succeeded' THEN '' ELSE '任务已取消' END,
            recycle_status = CASE WHEN recycle_status = 'succeeded' THEN recycle_status ELSE 'skipped' END,
            error = '任务已取消', agreement_finished_at = COALESCE(agreement_finished_at, ?),
            finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')
        `).run(at, at, at, at, attempt.id);
      } else if (attempt && attempt.recycle_status === "running" && attempt.stage === "recycling") {
        this.db.transaction(() => {
          this.db.prepare(`
            UPDATE mailcom_registration_pipeline_attempts
            SET recycle_status = 'skipped', stage = 'recycle_cancelled',
              recycle_error = '任务取消前远端轮换尚未开始', next_retry_at = NULL, updated_at = ?
            WHERE id = ? AND recycle_status = 'running' AND stage = 'recycling'
          `).run(at, attempt.id);
          this.db.prepare(`
            UPDATE mailcom_registration_pipeline_items
            SET replacement_email = '', next_retry_at = NULL, updated_at = ? WHERE id = ?
          `).run(at, item.id);
        })();
      } else if (attempt && !new Set(["running", "succeeded"]).has(attempt.recycle_status)) {
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_attempts
          SET recycle_status = 'skipped', recycle_error = '任务已取消', updated_at = ? WHERE id = ?
        `).run(at, attempt.id);
      }
      this.recomputeItem(item.id);
      return this.finishItem(item.id, "cancelled", "任务已取消");
    })().finally(() => this.cancellations.delete(key));
    this.cancellations.set(key, cancellation);
    return cancellation;
  }

  async cancel(id, { skipRecovery = false } = {}) {
    if (!skipRecovery) await this.recoveryPromise;
    const task = this.taskRow(id);
    if (!task) throw failure("Mail.com 流水线不存在", 404, "MAILCOM_PIPELINE_NOT_FOUND");
    if (TERMINAL_PIPELINE_STATUSES.has(task.status)) return this.publicTask(task);
    const at = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mailcom_registration_pipelines
        SET status = 'cancel_requested', stage = 'cancel_requested', updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running', 'cancel_requested')
      `).run(at, task.id);
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET status = 'cancel_requested', stage = 'cancel_requested', updated_at = ?
        WHERE pipeline_id = ? AND status IN ('queued', 'running', 'retry_wait', 'cancel_requested')
      `).run(at, task.id);
    })();
    const active = this.items(task.id).filter((item) => item.status === "cancel_requested");
    active.forEach((item) => this.wake(item.id));
    await Promise.allSettled(active.map((item) => this.cancelItem(item.id)));
    this.recompute(task.id);
    return this.publicTask(task.id);
  }

  async wait(itemId, milliseconds = this.pollIntervalMs) {
    let wake;
    const interrupted = new Promise((resolve) => { wake = resolve; });
    this.wakes.set(Number(itemId), wake);
    try {
      await Promise.race([this.sleepFn(Math.max(0, Number(milliseconds) || 0)), interrupted]);
    } finally {
      if (this.wakes.get(Number(itemId)) === wake) this.wakes.delete(Number(itemId));
    }
  }

  wake(itemId) {
    this.wakes.get(Number(itemId))?.();
    this.wakes.delete(Number(itemId));
  }

  startOrphanRecycleRecovery(attemptId) {
    const key = Number(attemptId);
    if (this.orphanTrackers.has(key)) return this.orphanTrackers.get(key);
    const tracker = this.runOrphanRecycleRecovery(key)
      .catch((error) => {
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_attempts
          SET recycle_error = ?, updated_at = ?
          WHERE id = ? AND recycle_status = 'running'
        `).run(safeError(error, "取消后的 Mail.com 别名轮换恢复失败"), nowIso(), key);
      })
      .finally(() => this.orphanTrackers.delete(key));
    this.orphanTrackers.set(key, tracker);
    return tracker;
  }

  persistOrphanRecycleRetry(attempt, item, error, { clearReplacement = false } = {}) {
    const retries = Math.max(1, Number(attempt.recycle_attempts || 1));
    const next = new Date(Date.now() + this.retryDelay(retries)).toISOString();
    const message = safeError(error, "取消后的 Mail.com 别名轮换恢复失败");
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET recycle_status = 'running', stage = 'orphan_recycle_retry_wait',
          recycle_error = ?, next_retry_at = ?, updated_at = ? WHERE id = ?
      `).run(message, next, nowIso(), attempt.id);
      this.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET replacement_email = CASE WHEN ? THEN '' ELSE replacement_email END,
          next_retry_at = ?, updated_at = ? WHERE id = ?
      `).run(clearReplacement ? 1 : 0, next, nowIso(), item.id);
    })();
  }

  async runOrphanRecycleRecovery(attemptId) {
    recoveryLoop: while (!this.closed) {
      let attempt = this.attemptRow(attemptId);
      let item = attempt ? this.itemRow(attempt.item_id) : null;
      let task = item ? this.taskRow(item.pipeline_id) : null;
      if (!attempt || !item || !task || attempt.recycle_status !== "running"
        || !(task.status === "cancel_requested" || TERMINAL_PIPELINE_STATUSES.has(task.status))) return;
      const retryDelay = Date.parse(attempt.next_retry_at || "") - Date.now();
      if (retryDelay > 0) {
        await this.wait(item.id, retryDelay);
        if (this.closed) return;
        attempt = this.attemptRow(attemptId);
        item = attempt ? this.itemRow(attempt.item_id) : null;
        task = item ? this.taskRow(item.pipeline_id) : null;
        if (!attempt || !item || !task || attempt.recycle_status !== "running"
          || !(task.status === "cancel_requested" || TERMINAL_PIPELINE_STATUSES.has(task.status))) return;
      }
      if (ACCOUNT_POOL_DELETE_PENDING_STAGES.has(String(attempt.stage || ""))) {
        const deletion = await this.ensureRegisteredAccountDeleted(attempt.id, { allowStart: false });
        attempt = this.attemptRow(attempt.id);
        item = attempt ? this.itemRow(attempt.item_id) : null;
        task = item ? this.taskRow(item.pipeline_id) : null;
        if (!attempt || !item || !task) return;
        if (deletion.status === "mismatch" || attempt.stage === "account_pool_delete_failed") return;
        if (deletion.status === "retry_wait") continue;
        if (deletion.status === "protected") return;
      }
      if (this.isMotherPrimaryItem(item) && attempt.stage === "account_pool_deleted"
        && this.registeredAccountRemovalOutcome(attempt)) {
        this.finishPrimaryAfterRegisteredAccountDelete(attempt, item, { cancelled: true });
        return;
      }
      if (this.protectedRegisteredAccount(attempt)) {
        this.preserveProtectedRecycle(attempt, item);
        return;
      }
      if (this.hasSuccessfulAgreement(attempt.email)) {
        this.preserveSuccessfulRecycle(attempt, item);
        return;
      }
      if (new Set([
        ALIAS_CREATE_CONFLICT_RECONCILE_STAGE,
        ORPHAN_ALIAS_CREATE_CONFLICT_RECONCILE_STAGE,
      ]).has(String(attempt.stage || ""))) {
        const resolved = await this.reconcileAliasCreateConflict(attempt, item, { orphan: true });
        if (resolved) return;
        continue;
      }
      const accountBlock = this.aliasAccountBlock(item);
      if (accountBlock) {
        try {
          await this.ensureAliasWebAuthorization(item);
          attempt = this.attemptRow(attempt.id);
          item = this.itemRow(item.id);
          task = item ? this.taskRow(item.pipeline_id) : null;
          if (!attempt || !item || !task || attempt.recycle_status !== "running") return;
        } catch {
          this.persistOrphanRecycleRetry(attempt, item, this.accountAliasBlockedError(item));
          continue;
        }
        if (this.aliasAccountBlock(item)) {
          this.persistOrphanRecycleRetry(attempt, item, this.accountAliasBlockedError(item));
          continue;
        }
      }
      if (this.aliasCreateConflictForAccount(item)) {
        this.finishDeterministicRecycleFailure(
          attempt,
          item,
          this.accountAliasCreateConflictError(item),
          { orphan: true },
        );
        return;
      }
      let replacementAddress;
      try {
        replacementAddress = this.stableReplacement(item, task.domain);
      } catch (error) {
        this.persistOrphanRecycleRetry(attempt, item, error);
        continue;
      }

      const plannedReplacement = item.replacement_email
        ? this.unassignedReplacement(item, item.replacement_email) : null;
      let motherCandidates = this.isMotherPrimaryItem(item) && !plannedReplacement
        ? this.motherAliasCandidates(item) : [];
      const orphanCapacityError = !plannedReplacement && this.isMotherPrimaryItem(item)
        ? this.replacementCapacityError(item, { deletableAliasCount: motherCandidates.length }) : null;
      if (orphanCapacityError) {
        this.finishDeterministicRecycleFailure(attempt, item, orphanCapacityError, { orphan: true });
        return;
      }

      let result;
      let candidateIndex = 0;
      const attemptedMotherCandidates = new Set();
      while (true) {
        const recycleAddress = motherCandidates[candidateIndex]?.address || "";
        if (recycleAddress) attemptedMotherCandidates.add(String(recycleAddress).toLowerCase());
        try {
          result = await this.serializeAliasRemote(item.account_id, async () => {
          if (this.closed) throw failure("Mail.com 流水线服务正在关闭", 503, "MAILCOM_PIPELINE_CLOSED");
          const latestAttempt = this.attemptRow(attempt.id);
          if (this.protectedRegisteredAccount(latestAttempt)) {
            throw failure(
              "blocked 或已提链账号必须保留，禁止恢复轮换邮箱",
              409,
              "MAILCOM_ALIAS_REGISTERED_ACCOUNT_PROTECTED",
            );
          }
          if (this.hasSuccessfulAgreement(attempt.email)) {
            throw failure(
              "协议授权成功账号永久保留，禁止恢复轮换邮箱",
              409,
              "MAILCOM_ALIAS_AGREEMENT_PROTECTED",
            );
          }
          if (this.aliasAccountBlock(item)) throw this.accountAliasBlockedError(item);
          if (this.aliasCreateConflictForAccount(item)) {
            throw this.accountAliasCreateConflictError(item);
          }
          this.db.prepare(`
            UPDATE mailcom_registration_pipeline_attempts
            SET stage = 'recycle_remote_started', recycle_attempts = recycle_attempts + 1,
              next_retry_at = NULL, updated_at = ?
            WHERE id = ? AND recycle_status = 'running'
          `).run(nowIso(), attempt.id);
          try {
            return await this.replaceAliasRemote(
              item,
              attempt,
              task,
              replacementAddress,
              recycleAddress,
            );
          } catch (error) {
            this.tripAliasCreateConflict(item, error);
            if (this.aliasAccountActionRequired(error)) this.tripAliasAccount(item, error);
            throw error;
          }
          });
          break;
        } catch (error) {
          const guardedAttempt = this.attemptRow(attempt.id);
          if (this.protectedRegisteredAccount(guardedAttempt)) {
            this.preserveProtectedRecycle(guardedAttempt, this.itemRow(item.id));
            return;
          }
          if (this.hasSuccessfulAgreement(guardedAttempt?.email)) {
            this.preserveSuccessfulRecycle(guardedAttempt, this.itemRow(item.id));
            return;
          }
          if (this.isMotherPrimaryItem(item)
            && !plannedReplacement
            && this.candidateProtectionError(error)) {
            const refreshed = this.motherAliasCandidates(item);
            const nextIndex = refreshed.findIndex((candidate) => (
              !attemptedMotherCandidates.has(String(candidate.address || "").toLowerCase())
            ));
            if (nextIndex >= 0) {
              motherCandidates = refreshed;
              candidateIndex = nextIndex;
              continue;
            }
            const exhausted = this.replacementCapacityError(item, { deletableAliasCount: 0 });
            if (exhausted) {
              this.finishDeterministicRecycleFailure(
                this.attemptRow(attempt.id),
                this.itemRow(item.id),
                exhausted,
                { orphan: true },
              );
              return;
            }
            motherCandidates = [];
            candidateIndex = 0;
            continue;
          }
        attempt = this.attemptRow(attempt.id);
        item = this.itemRow(item.id);
        if (!attempt || !item || attempt.recycle_status !== "running") return;
        if (String(error?.code || "") === "MAILCOM_ALIAS_REGISTERED_ACCOUNT_PROTECTED"
          || this.protectedRegisteredAccount(attempt)) {
          this.preserveProtectedRecycle(attempt, item);
          return;
        }
        if (String(error?.code || "") === "MAILCOM_ALIAS_AGREEMENT_PROTECTED"
          || this.hasSuccessfulAgreement(attempt.email)) {
          this.preserveSuccessfulRecycle(attempt, item);
          return;
        }
        const recovered = this.unassignedReplacement(item, replacementAddress);
        if (recovered) {
          this.activateReplacement(item, attempt, recovered);
          return;
        }
        const createConflict = this.tripAliasCreateConflict(item, error);
        if (createConflict) {
          if (this.orphanRecycleSafeToRelease(error)) {
            this.finishDeterministicRecycleFailure(attempt, item, error, { orphan: true });
            return;
          }
          this.scheduleAliasConflictReconciliation(attempt, item, error, { orphan: true });
          continue recoveryLoop;
        }
        if (String(error?.code || "") === "MAILCOM_PIPELINE_ACCOUNT_ALIAS_CREATE_CONFLICT") {
          this.finishDeterministicRecycleFailure(
            attempt,
            item,
            this.accountAliasCreateConflictError(item),
            { orphan: true },
          );
          return;
        }
        if (this.closed) return;
        if (this.aliasAccountActionRequired(error)
          || String(error?.code || "") === "MAILCOM_PIPELINE_ACCOUNT_ALIAS_QUARANTINED") {
          if (String(error?.code || "") !== "MAILCOM_PIPELINE_ACCOUNT_ALIAS_QUARANTINED") {
            this.tripAliasAccount(item, error);
          }
          this.persistOrphanRecycleRetry(attempt, item, this.accountAliasBlockedError(item));
          const authorizationRecovered = await this.ensureAliasWebAuthorization(item)
            .then(() => true, () => false);
          if (authorizationRecovered) {
            this.resumeRecycleAfterAuthorization(
              this.attemptRow(attempt.id),
              this.itemRow(item.id),
              { orphan: true },
            );
          }
          continue recoveryLoop;
        }
        const replacementUnavailable = String(error?.code || "") === "MAILCOM_ALIAS_REPLACEMENT_UNAVAILABLE";
        const randomDomainUnavailable = task.domain === MAILCOM_RANDOM_DOMAIN
          && String(error?.code || "") === "MAILCOM_ALIAS_DOMAIN_UNAVAILABLE";
        if (replacementUnavailable || randomDomainUnavailable || !this.orphanRecycleSafeToRelease(error)) {
          this.persistOrphanRecycleRetry(attempt, item, error, {
            clearReplacement: replacementUnavailable || randomDomainUnavailable,
          });
          continue recoveryLoop;
        }
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_attempts
          SET recycle_status = 'failed', stage = 'orphan_recycle_failed', recycle_error = ?,
            next_retry_at = NULL, updated_at = ? WHERE id = ? AND recycle_status = 'running'
        `).run(safeError(error), nowIso(), attempt.id);
        this.db.prepare(`
          UPDATE mailcom_registration_pipeline_items SET next_retry_at = NULL, updated_at = ? WHERE id = ?
        `).run(nowIso(), item.id);
        this.recomputeItem(item.id);
        return;
        }
      }

      attempt = this.attemptRow(attempt.id);
      item = this.itemRow(item.id);
      if (!attempt || !item || attempt.recycle_status !== "running") return;
      if (this.protectedRegisteredAccount(attempt)) {
        this.preserveProtectedRecycle(attempt, item);
        return;
      }
      if (this.hasSuccessfulAgreement(attempt.email)) {
        this.preserveSuccessfulRecycle(attempt, item);
        return;
      }
      const replacement = this.replacementFromResult(item, result);
      if (replacement) {
        this.activateReplacement(item, attempt, replacement);
        return;
      }
      const missing = failure(
        "Mail.com 别名已轮换但本地未找到新地址",
        502,
        "MAILCOM_PIPELINE_REPLACEMENT_NOT_FOUND",
      );
      this.persistOrphanRecycleRetry(attempt, item, missing);
    }
  }

  recoverOrphanedRecycles() {
    const rows = this.db.prepare(`
      SELECT attempts.id, attempts.stage, attempts.item_id, attempts.outcome,
        attempts.external_account_id, attempts.link_status, attempts.agreement_status,
        items.account_id, items.source_email
      FROM mailcom_registration_pipeline_attempts AS attempts
      JOIN mailcom_registration_pipeline_items AS items ON items.id = attempts.item_id
      JOIN mailcom_registration_pipelines AS pipelines ON pipelines.id = attempts.pipeline_id
      WHERE attempts.recycle_status = 'running'
        AND pipelines.status IN ('completed', 'partial_failed', 'failed', 'cancelled', 'interrupted')
      ORDER BY attempts.id
    `).all();
    for (const row of rows) {
      if (!row.account_id) {
        this.abandonRecoveries({
          email: row.source_email,
          reason: "Mail.com 母号已从系统删除，已停止恢复别名轮换",
        });
        continue;
      }
      if (row.stage === "recycling" && !this.registeredAccountRemovalOutcome(row)) {
        const at = nowIso();
        this.db.transaction(() => {
          this.db.prepare(`
            UPDATE mailcom_registration_pipeline_attempts
            SET recycle_status = 'skipped', stage = 'recycle_cancelled',
              recycle_error = '任务取消前远端轮换尚未开始', next_retry_at = NULL, updated_at = ?
            WHERE id = ? AND recycle_status = 'running' AND stage = 'recycling'
          `).run(at, row.id);
          this.db.prepare(`
            UPDATE mailcom_registration_pipeline_items
            SET replacement_email = '', next_retry_at = NULL, updated_at = ? WHERE id = ?
          `).run(at, row.item_id);
        })();
        this.recomputeItem(row.item_id);
      } else {
        this.startOrphanRecycleRecovery(row.id);
      }
    }
  }

  async recoverActivePipelines() {
    this.restoreAliasAccountBlocks();
    const authorizationAccountIds = this.authorizationRecoveryCandidates()
      .map((item) => item.account_id);
    this.scheduleSavedAuthorizationRecovery(authorizationAccountIds, { force: false });
    const tasks = this.db.prepare(`
      SELECT id, status FROM mailcom_registration_pipelines
      WHERE status IN ('queued', 'running', 'cancel_requested') ORDER BY created_at
    `).all();
    for (const task of tasks) {
      if (task.status === "cancel_requested") {
        await this.cancel(task.id, { skipRecovery: true }).catch(() => undefined);
      } else {
        this.recoverMisclassifiedCompletedRegistrations(task.id);
        this.recoverCapacityFailedPrimarySlots(task.id);
        this.startTracker(task.id);
      }
    }
    this.recoverOrphanedRecycles();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.wakes.forEach((wake) => wake());
    this.wakes.clear();
    await Promise.allSettled([...this.trackers.values()]);
    await Promise.allSettled([...this.cancellations.values()]);
    await Promise.allSettled([...this.accountPoolDeletions.values()]);
    await Promise.allSettled([...this.orphanTrackers.values()]);
    await Promise.allSettled([...this.authorizationBatches]);
    await Promise.allSettled([...this.authorizationRecoveries.values()]);
    await Promise.allSettled([...this.aliasOperations]);
  }
}
