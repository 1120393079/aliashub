import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const MAILCOM_LOGIN_URL = "https://www.mail.com/#navlogin";
const SETTINGS_API_ROOT = "https://settings-cats.mail.com";
const ADDRESSES_PATH = "/mailaccount/primary/emailAddresses?absoluteURI=false&q.state.in=ACTIVE&q.type.in=MANAGED,DOMAIN_HOSTING";
const DOMAINS_PATH = "/domains?absoluteURI=false&q.state.eq=ACTIVE&q.owner.eq=gmx_MAILCOM";
const VALIDATIONS_PATH = "/mailaccount/emailAddressValidations?absoluteURI=false";
const CREATE_PATH = "/mailaccount/primary/emailAddresses?absoluteURI=false";
const addressRemovalPath = (address) => `/mailaccount/primary/emailAddressesRemovals/${encodeURIComponent(String(address || ""))}/removals?absoluteURI=false`;
const ADDRESS_LIST_MEDIA_TYPE = "application/vnd.ui.trinity.mailaddress.list-v5+json";
const VALIDATION_REQUEST_MEDIA_TYPE = "application/vnd.ui.trinity.email-address-validation-request+json";
const VALIDATION_RESPONSE_MEDIA_TYPE = "application/vnd.ui.trinity.email-address-validation-response+json";
const MINIMAL_ADDRESS_MEDIA_TYPE = "application/vnd.ui.trinity.minimalmailaddress-v3+json";
const DEFAULT_BROWSER_EXECUTABLES = ["/usr/bin/google-chrome", "/usr/bin/chromium"];
const DEFAULT_BROWSER_LIMIT = 1;
const DEFAULT_BROWSER_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const DEFAULT_OPEN_ATTEMPTS = 2;
const DEFAULT_OPEN_TIMEOUT_MS = 200_000;
const DEFAULT_RETRY_DELAY_MS = 1_500;
const MINIMUM_RETRY_BUDGET_MS = 10_000;
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const UPSTREAM_DETAIL_FIELDS = Object.freeze(["code", "reason", "message"]);
const UPSTREAM_CONTEXT_FIELDS = Object.freeze([...UPSTREAM_DETAIL_FIELDS, "request_id"]);
const UPSTREAM_DETAIL_MAX_LENGTH = 160;
const UPSTREAM_SUMMARY_MAX_LENGTH = 260;
const UPSTREAM_JSON_MAX_BYTES = 64 * 1024;

const RETRYABLE_OPEN_CODES = new Set([
  "MAILCOM_WEB_LOGIN_TIMEOUT",
  "MAILCOM_WEBMAIL_FRAME_MISSING",
  "MAILCOM_SETTINGS_BUTTON_MISSING",
  "MAILCOM_SETTINGS_FRAME_MISSING",
  "MAILCOM_SENDER_ADDRESSES_MISSING",
  "MAILCOM_ALIAS_SETTINGS_AUTH_MISSING",
  "MAILCOM_ALIAS_NAVIGATION_TIMEOUT",
  "MAILCOM_ALIAS_NAVIGATION_FAILED",
  "MAILCOM_ALIAS_PAGE_NOT_READY",
  "MAILCOM_ALIAS_BROWSER_DISCONNECTED",
  "MAILCOM_ALIAS_BROWSER_FAILED",
  "MAILCOM_ALIAS_OPEN_TIMEOUT",
]);

function failure(message, status = 502, code = "MAILCOM_ALIAS_BROWSER_FAILED", options = {}) {
  return Object.assign(new Error(message, options), { status, code });
}

function positiveInteger(value, fallback, maximum = 100) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function nonNegativeInteger(value, fallback, maximum = 300_000) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}

function annotateStage(error, stage) {
  if (error && typeof error === "object" && !error.mailcomStage) {
    try { error.mailcomStage = stage; } catch { /* Frozen errors are still safely mapped below. */ }
  }
  return error;
}

function sanitizedDiagnostic(error, secrets = []) {
  const chain = [];
  let current = error;
  for (let depth = 0; current && depth < 3; depth += 1) {
    chain.push(String(current?.stack || current?.message || current));
    current = current?.cause;
  }
  let message = chain.length ? chain.join("\nCaused by: ") : "unknown browser error";
  for (const secret of secrets.filter(Boolean)) message = message.split(String(secret)).join("[REDACTED]");
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "Bearer [REDACTED]")
    .replace(/([?&#](?:sid|navsid|iac_token|access_token|token)=)[^&#\s"']+/gi, "$1[REDACTED]")
    .slice(0, 2_000);
}

function retryableOpenError(error) {
  const code = String(error?.code || "").toUpperCase();
  if (code.startsWith("MAILCOM_")) return RETRYABLE_OPEN_CODES.has(code);
  return true;
}

function openDeadlineFailure() {
  return failure(
    "Mail.com 网页连接处理超过总时限，请稍后再试",
    504,
    "MAILCOM_ALIAS_OPEN_TIMEOUT",
  );
}

function remainingOpenTime(deadline, maximum = Number.POSITIVE_INFINITY) {
  const remaining = Math.floor(Number(deadline) - Date.now());
  if (!Number.isFinite(remaining) || remaining <= 0) throw openDeadlineFailure();
  return Math.max(1, Math.min(remaining, maximum));
}

function withOpenDeadline(promise, deadline) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(openDeadlineFailure()), remainingOpenTime(deadline));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function exhaustedBrowserOpenFailure(mapped, { requestId, attempts } = {}) {
  if (!mapped?.retryable) return mapped;
  const retried = Number(attempts) > 1;
  const result = failure(
    `Mail.com 网页连接暂时不稳定，${retried ? "系统已自动重试仍未恢复" : "当前请求未能恢复"}，请稍后再试（故障编号 ${String(requestId).slice(0, 8)}）`,
    503,
    "MAILCOM_ALIAS_OPEN_TRANSIENT",
    { cause: mapped },
  );
  result.stage = mapped.stage;
  result.retryable = true;
  result.requestId = requestId;
  result.attempts = attempts;
  return result;
}

function mappedBrowserOpenFailure(error, {
  stage,
  attempt,
  maxAttempts,
  requestId,
} = {}) {
  const sourceCode = String(error?.code || "").toUpperCase();
  const rawMessage = String(error?.message || "");
  const timeout = String(error?.name || "").toLowerCase() === "timeouterror"
    || /timeout|timed out/i.test(rawMessage);
  const navigationFailure = /net::err_|econnreset|eai_again|enetunreach|enotfound/i.test(rawMessage);
  const disconnected = /target (?:page|context|browser).*closed|browser.*disconnected|connection closed/i.test(rawMessage);
  let mapped;

  if (sourceCode.startsWith("MAILCOM_")) {
    mapped = failure(error.message, Number(error.status) || 502, sourceCode, { cause: error.cause });
  } else if (String(stage || "").startsWith("navigate_") && timeout) {
    mapped = failure("Mail.com 登录页面加载超时", 504, "MAILCOM_ALIAS_NAVIGATION_TIMEOUT", { cause: error });
  } else if (navigationFailure) {
    mapped = failure("Mail.com 登录页面暂时无法连接", 503, "MAILCOM_ALIAS_NAVIGATION_FAILED", { cause: error });
  } else if (disconnected) {
    mapped = failure("Mail.com 自动化浏览器连接意外中断", 503, "MAILCOM_ALIAS_BROWSER_DISCONNECTED", { cause: error });
  } else if (timeout) {
    mapped = failure("Mail.com 页面控件未按预期加载", 504, "MAILCOM_ALIAS_PAGE_NOT_READY", { cause: error });
  } else {
    mapped = failure("Mail.com 网页自动创建组件运行失败", 502, "MAILCOM_ALIAS_BROWSER_FAILED", { cause: error });
  }

  mapped.stage = String(stage || error?.mailcomStage || "unknown");
  mapped.retryable = retryableOpenError(mapped);
  mapped.requestId = requestId;
  mapped.attempts = attempt;
  return mapped;
}

function defaultBrowserExecutable() {
  return DEFAULT_BROWSER_EXECUTABLES.find((candidate) => fs.existsSync(candidate))
    || DEFAULT_BROWSER_EXECUTABLES[0];
}

export class MailcomBrowserSemaphore {
  constructor() {
    this.active = 0;
    this.queue = [];
  }

  acquire({ limit = DEFAULT_BROWSER_LIMIT, timeoutMs = DEFAULT_BROWSER_WAIT_TIMEOUT_MS } = {}) {
    const normalizedLimit = positiveInteger(limit, DEFAULT_BROWSER_LIMIT, 10);
    const normalizedTimeout = positiveInteger(timeoutMs, DEFAULT_BROWSER_WAIT_TIMEOUT_MS, 300_000);
    if (this.active < normalizedLimit) {
      this.active += 1;
      return Promise.resolve(this.releaseHandle());
    }
    return new Promise((resolve, reject) => {
      const waiter = { limit: normalizedLimit, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(failure(
          "Mail.com 自动创建浏览器正忙，请稍后重试",
          429,
          "MAILCOM_ALIAS_BROWSER_BUSY",
        ));
      }, normalizedTimeout);
      this.queue.push(waiter);
    });
  }

  releaseHandle() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  drain() {
    while (this.queue.length) {
      const waiter = this.queue[0];
      if (this.active >= waiter.limit) return;
      this.queue.shift();
      clearTimeout(waiter.timer);
      this.active += 1;
      waiter.resolve(this.releaseHandle());
    }
  }
}

export const globalMailcomBrowserSemaphore = new MailcomBrowserSemaphore();

function promiseDeadline(promise, milliseconds) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(failure(
      "Mail.com 浏览器清理超时",
      504,
      "MAILCOM_ALIAS_BROWSER_CLEANUP_TIMEOUT",
    )), Math.max(1, milliseconds));
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function createSessionDirectories() {
  let root = "";
  try {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "aliashub-mailcom-"));
    await fs.promises.chmod(root, 0o700);
    const directories = {
      root,
      home: path.join(root, "home"),
      config: path.join(root, "config"),
      cache: path.join(root, "cache"),
      runtime: path.join(root, "runtime"),
    };
    await Promise.all(Object.values(directories).slice(1)
      .map((directory) => fs.promises.mkdir(directory, { mode: 0o700 })));
    return directories;
  } catch (error) {
    if (root) {
      try { await fs.promises.rm(root, { recursive: true, force: true }); } catch { /* Best effort. */ }
    }
    throw error;
  }
}

function minimalBrowserEnvironment(directories, { headless = true } = {}) {
  const environment = {
    PATH: process.env.PATH || DEFAULT_PATH,
    HOME: directories.home,
    XDG_CONFIG_HOME: directories.config,
    XDG_CACHE_HOME: directories.cache,
    XDG_RUNTIME_DIR: directories.runtime,
    LANG: process.env.LANG || "C.UTF-8",
  };
  if (process.env.TZ) environment.TZ = process.env.TZ;
  if (!headless && process.env.DISPLAY) environment.DISPLAY = process.env.DISPLAY;
  if (!headless && process.env.XAUTHORITY) environment.XAUTHORITY = process.env.XAUTHORITY;
  return environment;
}

async function cleanupBrowserResources({
  context,
  browser,
  browserServer,
  sessionRoot,
  timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
} = {}) {
  const boundedTimeout = positiveInteger(timeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS, 60_000);
  const cleanupDeadline = Date.now() + boundedTimeout;
  const remainingCleanupTime = (maximum = boundedTimeout) => Math.max(
    0,
    Math.min(maximum, cleanupDeadline - Date.now()),
  );
  const graceful = (async () => {
    try { await context?.close?.(); } catch { /* Force-close below if needed. */ }
    try { await browser?.close?.(); } catch { /* Force-close below if needed. */ }
    try { await browserServer?.close?.(); } catch { /* Force-close below if needed. */ }
  })();
  let timedOut = false;
  const gracefulBudget = Math.max(1, Math.floor(boundedTimeout * 0.6));
  await promiseDeadline(graceful, gracefulBudget).catch(() => { timedOut = true; });
  if (timedOut && browserServer) {
    let killed = false;
    const killBudget = remainingCleanupTime(3_000);
    try {
      if (killBudget > 0) {
        await promiseDeadline(Promise.resolve(browserServer.kill?.()), killBudget);
        killed = true;
      }
    } catch {
      // Fall through to the process-level SIGKILL below.
    }
    if (!killed) {
      try { browserServer.process?.()?.kill?.("SIGKILL"); } catch { /* Process may already be gone. */ }
    }
  }
  if (sessionRoot) {
    try {
      const removalBudget = remainingCleanupTime(5_000);
      if (removalBudget <= 0) throw new Error("cleanup deadline exhausted");
      await promiseDeadline(fs.promises.rm(sessionRoot, { recursive: true, force: true }), removalBudget);
    } catch {
      try { fs.rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* Already removed. */ }
    }
  }
}

function deadlinePromise(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function retryDelayPromise(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

async function firstVisibleAcrossFrames(page, selector, timeout = 1_500, openDeadline) {
  const visibilityTimeout = remainingOpenTime(
    openDeadline,
    Math.max(1, Number(timeout) || 1),
  );
  const visibleLocators = await withOpenDeadline(Promise.all(page.frames().map(async (frame) => {
    try {
      const locator = frame.locator(selector).first();
      return await locator.isVisible({ timeout: visibilityTimeout }) ? locator : null;
    } catch (error) {
      if (String(error?.code || "") === "MAILCOM_ALIAS_OPEN_TIMEOUT") throw error;
      // Consent surfaces differ by region and are optional.
      return null;
    }
  })), openDeadline);
  return visibleLocators.find(Boolean) || null;
}

async function acceptConsent(page, openDeadline) {
  const selectors = [
    'button:has-text("Continue to Mail.com")',
    'button:has-text("Accept all")',
    'button:has-text("Agree and continue")',
  ];
  for (const selector of selectors) {
    const button = await firstVisibleAcrossFrames(page, selector, 1_500, openDeadline);
    if (!button) continue;
    try {
      await button.click({ timeout: remainingOpenTime(openDeadline, 3_000) });
    } catch (error) {
      if (String(error?.code || "") === "MAILCOM_ALIAS_OPEN_TIMEOUT"
          || Date.now() >= Number(openDeadline)) throw openDeadlineFailure();
      // Optional consent prompts can disappear while they are being clicked.
    }
    return;
  }
}

async function clickFirstAvailable(frame, selectors, {
  timeoutMs,
  openDeadline,
  message,
  code,
} = {}) {
  const deadline = Math.min(
    Date.now() + Math.max(1, Number(timeoutMs) || 1),
    Number(openDeadline),
  );
  let lastError;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const locator = frame.locator(selector).first();
        if (!await locator.isVisible({ timeout: Math.min(500, Math.max(1, deadline - Date.now())) })) continue;
        await locator.click({ timeout: Math.min(5_000, Math.max(1, deadline - Date.now())) });
        return;
      } catch (error) {
        if (String(error?.code || "") === "MAILCOM_ALIAS_OPEN_TIMEOUT"
            || Date.now() >= Number(openDeadline)) throw openDeadlineFailure();
        lastError = error;
      }
    }
    await deadlinePromise(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  if (Date.now() >= Number(openDeadline)) throw openDeadlineFailure();
  throw failure(message, 502, code, { cause: lastError });
}

async function waitForFrame(page, predicate, timeoutMs, openDeadline) {
  const deadline = Math.min(Date.now() + timeoutMs, Number(openDeadline));
  while (Date.now() < deadline) {
    const frame = page.frames().find((item) => {
      try { return predicate(new URL(item.url())); } catch { return false; }
    });
    if (frame) return frame;
    await Promise.race([page.waitForTimeout(250), deadlinePromise(Math.max(1, deadline - Date.now()))]);
  }
  if (Date.now() >= Number(openDeadline)) throw openDeadlineFailure();
  return null;
}

async function waitForCapturedAuthorization(page, captured, timeoutMs, openDeadline) {
  const deadline = Math.min(Date.now() + timeoutMs, Number(openDeadline));
  while (Date.now() < deadline) {
    if (captured.authorization.startsWith("Bearer ") && captured.xUiApp) return;
    await Promise.race([page.waitForTimeout(200), deadlinePromise(Math.max(1, deadline - Date.now()))]);
  }
  if (Date.now() >= Number(openDeadline)) throw openDeadlineFailure();
  throw failure(
    "Mail.com 设置页未返回可用授权，请重新登录后再试",
    409,
    "MAILCOM_ALIAS_SETTINGS_AUTH_MISSING",
  );
}

function safeUpstreamDetail(value, secrets = []) {
  let result = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  for (const secret of [...new Set(secrets.map((item) => String(item || "")).filter(Boolean))]
    .sort((left, right) => right.length - left.length)) {
    result = result.split(secret).join("[REDACTED]");
  }
  result = result
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, "https://***@")
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "Bearer [REDACTED]")
    .replace(/\beyj[a-z0-9_-]{10,}(?:\.[a-z0-9_-]{4,}){1,2}\b/gi, "[REDACTED_TOKEN]")
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|(?:auth|id|csrf)?[_ -]?token|cookie|password|pass|secret|authorization|session(?:[_ -]?id)?)['"]?\s*[:=]\s*['"]?)(?:Bearer\s+)?[^\s'",;}]+/gi, "$1[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi, "[REDACTED_EMAIL]");
  if (result.length <= UPSTREAM_DETAIL_MAX_LENGTH) return result;
  return `${result.slice(0, UPSTREAM_DETAIL_MAX_LENGTH - 1)}…`;
}

function upstreamResponseDetails(payload, secrets = []) {
  const details = {};
  let visited = 0;
  const visit = (value, depth = 0) => {
    if (value === null || typeof value !== "object" || depth > 4 || visited >= 64) return;
    visited += 1;
    const entries = Array.isArray(value)
      ? value.slice(0, 16).map((entry, index) => [String(index), entry])
      : Object.entries(value).slice(0, 32);
    for (const [rawKey, entry] of entries) {
      const key = String(rawKey).trim().toLowerCase();
      if (UPSTREAM_DETAIL_FIELDS.includes(key) && details[key] === undefined
        && ["string", "number", "boolean"].includes(typeof entry)) {
        const safe = safeUpstreamDetail(entry, secrets);
        if (safe) details[key] = safe;
      }
      if (entry && typeof entry === "object") visit(entry, depth + 1);
      if (UPSTREAM_DETAIL_FIELDS.every((field) => details[field] !== undefined)) return;
    }
  };
  visit(payload);
  return details;
}

async function readUpstreamResponseDetails(response, secrets = []) {
  const details = {};
  let parseJson = true;
  try {
    const headers = response.headers();
    const requestId = String(headers?.["x-request-id"] || headers?.["X-Request-ID"] || "").trim();
    if (requestId.length <= 64
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      details.request_id = requestId;
    }
    const contentType = String(headers?.["content-type"] || headers?.["Content-Type"] || "").trim();
    if (contentType && !/json/i.test(contentType)) parseJson = false;
    const contentLength = Number(headers?.["content-length"] || headers?.["Content-Length"] || 0);
    if (Number.isFinite(contentLength) && contentLength > UPSTREAM_JSON_MAX_BYTES) parseJson = false;
  } catch {
    // Missing or non-standard response headers are not diagnostic failures.
  }
  if (!parseJson) return details;
  try {
    const rawBody = await response.body();
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || "");
    if (body.length > UPSTREAM_JSON_MAX_BYTES) return details;
    return { ...details, ...upstreamResponseDetails(JSON.parse(body.toString("utf8")), secrets) };
  } catch {
    // HTML, plain text, and malformed bodies are intentionally never persisted.
    return details;
  }
}

function upstreamResponseSummary(details = {}) {
  const summary = UPSTREAM_CONTEXT_FIELDS
    .filter((field) => details[field])
    .map((field) => `${field}=${details[field]}`)
    .join("；");
  if (!summary) return "";
  return summary.length <= UPSTREAM_SUMMARY_MAX_LENGTH
    ? summary
    : `${summary.slice(0, UPSTREAM_SUMMARY_MAX_LENGTH - 1)}…`;
}

function apiFailure(status, operation, upstream = {}) {
  let result;
  if ([401, 403].includes(status)) {
    result = failure("Mail.com 网页授权已失效，请重新连接母号后再试", 409, "MAILCOM_ALIAS_SESSION_EXPIRED");
  } else if (status === 409) {
    result = failure(`Mail.com 拒绝${operation}，请求与当前官网地址状态冲突`, 409, "MAILCOM_ALIAS_CONFLICT");
  } else if (status === 429) {
    result = failure("Mail.com 请求过于频繁，请稍后重试", 429, "MAILCOM_ALIAS_RATE_LIMITED");
  } else if (status >= 500) {
    result = failure("Mail.com 设置服务暂时不可用，请稍后重试", 503, "MAILCOM_ALIAS_SETTINGS_UNAVAILABLE");
  } else {
    result = failure(`Mail.com ${operation}失败`, 502, "MAILCOM_ALIAS_SETTINGS_REQUEST_FAILED");
  }
  const summary = upstreamResponseSummary(upstream);
  if (summary) result.message = `${result.message}（官网响应：${summary}）`;
  result.upstream_status = status;
  for (const field of UPSTREAM_CONTEXT_FIELDS) {
    if (upstream[field]) result[`upstream_${field}`] = upstream[field];
  }
  return result;
}

async function jsonResponse(response, operation, ignoreBody = false, secrets = []) {
  const status = response.status();
  if (!response.ok()) {
    const upstream = await readUpstreamResponseDetails(response, secrets);
    throw apiFailure(status, operation, upstream);
  }
  if (ignoreBody || status === 204) return null;
  try {
    return await response.json();
  } catch (error) {
    throw failure(`Mail.com ${operation}返回了无效数据`, 502, "MAILCOM_ALIAS_SETTINGS_INVALID_RESPONSE");
  }
}

export class MailcomSettingsApiSession {
  constructor({
    browser,
    browserServer,
    context,
    authorization,
    xUiApp,
    sessionRoot,
    semaphoreRelease,
    requestTimeoutMs = 30_000,
    cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
  } = {}) {
    this.browser = browser;
    this.browserServer = browserServer;
    this.context = context;
    this.authorization = String(authorization || "");
    this.xUiApp = String(xUiApp || "");
    this.sessionRoot = String(sessionRoot || "");
    this.semaphoreRelease = semaphoreRelease;
    this.requestTimeoutMs = Math.max(1_000, Number(requestTimeoutMs) || 30_000);
    this.cleanupTimeoutMs = positiveInteger(cleanupTimeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS, 60_000);
    this.closed = false;
  }

  headers(accept, contentType = "") {
    if (this.closed || !this.authorization.startsWith("Bearer ") || !this.xUiApp) {
      throw failure("Mail.com 网页授权已关闭", 409, "MAILCOM_ALIAS_SESSION_CLOSED");
    }
    return {
      Authorization: this.authorization,
      Accept: accept,
      ...(contentType ? { "Content-Type": contentType } : {}),
      "X-UI-APP": this.xUiApp,
      "X-Request-ID": crypto.randomUUID(),
    };
  }

  async request(pathname, {
    method = "GET",
    accept = "application/json",
    contentType = "",
    data,
    operation,
    ignoreBody = false,
  } = {}) {
    let response;
    try {
      const headers = this.headers(accept, contentType);
      response = await this.context.request.fetch(`${SETTINGS_API_ROOT}${pathname}`, {
        method,
        headers,
        ...(data === undefined ? {} : { data }),
        timeout: this.requestTimeoutMs,
        failOnStatusCode: false,
      });
    } catch (error) {
      if (String(error?.code || "").startsWith("MAILCOM_")) throw error;
      if (String(error?.message || "").toLowerCase().includes("timeout")) {
        throw failure("连接 Mail.com 设置服务超时，请稍后重试", 504, "MAILCOM_ALIAS_TIMEOUT");
      }
      throw failure("无法连接 Mail.com 设置服务，请稍后重试", 503, "MAILCOM_ALIAS_SETTINGS_UNAVAILABLE");
    }
    const authorizationToken = this.authorization.replace(/^Bearer\s+/i, "");
    return jsonResponse(response, operation || "请求", ignoreBody, [this.authorization, authorizationToken]);
  }

  listAddresses() {
    return this.request(ADDRESSES_PATH, {
      accept: ADDRESS_LIST_MEDIA_TYPE,
      operation: "读取官方别名",
    });
  }

  listDomains() {
    return this.request(DOMAINS_PATH, {
      accept: "application/json",
      operation: "读取可用域名",
    });
  }

  async validateAlias({ address } = {}) {
    const result = await this.request(VALIDATIONS_PATH, {
      method: "POST",
      accept: VALIDATION_RESPONSE_MEDIA_TYPE,
      contentType: VALIDATION_REQUEST_MEDIA_TYPE,
      data: [address],
      operation: "验证别名",
    });
    return Boolean(result && typeof result === "object" && !Array.isArray(result) && !Object.keys(result).length);
  }

  async createAlias({ address } = {}) {
    await this.request(CREATE_PATH, {
      method: "POST",
      accept: MINIMAL_ADDRESS_MEDIA_TYPE,
      contentType: MINIMAL_ADDRESS_MEDIA_TYPE,
      data: {
        address,
        deletable: true,
        pgpEnabled: false,
        defaultSenderAddress: false,
        defaultReceiverAddress: false,
        state: "ACTIVE",
      },
      operation: "创建官方别名",
      ignoreBody: true,
    });
    return { address };
  }

  async deleteAlias({ address } = {}) {
    await this.request(addressRemovalPath(address), {
      method: "POST",
      accept: "text/plain;charset=UTF-8",
      contentType: "text/plain;charset=UTF-8",
      operation: "删除官方别名",
      ignoreBody: true,
    });
    return { address };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.authorization = "";
    this.xUiApp = "";
    const resources = {
      context: this.context,
      browser: this.browser,
      browserServer: this.browserServer,
      sessionRoot: this.sessionRoot,
      timeoutMs: this.cleanupTimeoutMs,
    };
    const release = this.semaphoreRelease;
    this.context = null;
    this.browser = null;
    this.browserServer = null;
    this.sessionRoot = "";
    this.semaphoreRelease = null;
    try {
      await cleanupBrowserResources(resources);
    } finally {
      release?.();
    }
  }
}

export class MailcomAliasPlaywrightAdapter {
  constructor({
    chromiumLauncher = chromium,
    browserExecutable = process.env.MAILCOM_BROWSER_EXECUTABLE || defaultBrowserExecutable(),
    headless = process.env.MAILCOM_ALIAS_HEADLESS !== "false",
    loginTimeoutMs = 90_000,
    requestTimeoutMs = 30_000,
    cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
    browserSemaphore = globalMailcomBrowserSemaphore,
    maxConcurrentBrowsers = process.env.MAILCOM_ALIAS_MAX_BROWSERS || DEFAULT_BROWSER_LIMIT,
    browserWaitTimeoutMs = process.env.MAILCOM_ALIAS_BROWSER_WAIT_TIMEOUT_MS || DEFAULT_BROWSER_WAIT_TIMEOUT_MS,
    openTimeoutMs = process.env.MAILCOM_ALIAS_OPEN_TIMEOUT_MS || DEFAULT_OPEN_TIMEOUT_MS,
    openAttempts = process.env.MAILCOM_ALIAS_OPEN_ATTEMPTS || DEFAULT_OPEN_ATTEMPTS,
    retryDelayMs = process.env.MAILCOM_ALIAS_RETRY_DELAY_MS || DEFAULT_RETRY_DELAY_MS,
    sleepFn = retryDelayPromise,
    randomFn = Math.random,
    logger = console,
  } = {}) {
    this.chromium = chromiumLauncher;
    this.browserExecutable = String(browserExecutable || defaultBrowserExecutable());
    this.headless = Boolean(headless);
    this.loginTimeoutMs = Math.max(10_000, Number(loginTimeoutMs) || 90_000);
    this.requestTimeoutMs = Math.max(1_000, Number(requestTimeoutMs) || 30_000);
    this.cleanupTimeoutMs = positiveInteger(cleanupTimeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS, 30_000);
    this.browserSemaphore = browserSemaphore;
    this.maxConcurrentBrowsers = positiveInteger(maxConcurrentBrowsers, DEFAULT_BROWSER_LIMIT, 10);
    this.browserWaitTimeoutMs = positiveInteger(
      browserWaitTimeoutMs,
      DEFAULT_BROWSER_WAIT_TIMEOUT_MS,
      300_000,
    );
    this.openTimeoutMs = positiveInteger(
      openTimeoutMs,
      DEFAULT_OPEN_TIMEOUT_MS,
      DEFAULT_OPEN_TIMEOUT_MS,
    );
    this.openAttempts = positiveInteger(openAttempts, DEFAULT_OPEN_ATTEMPTS, 3);
    this.retryDelayMs = nonNegativeInteger(retryDelayMs, DEFAULT_RETRY_DELAY_MS, 30_000);
    this.sleepFn = typeof sleepFn === "function" ? sleepFn : retryDelayPromise;
    this.randomFn = typeof randomFn === "function" ? randomFn : Math.random;
    this.logger = logger;
  }

  async openAttempt({ username, password, semaphoreRelease, deadline } = {}) {
    let browserServer;
    let browser;
    let context;
    let directories;
    let stage = "create_session_directories";
    const captured = { authorization: "", xUiApp: "" };
    const networkFailures = [];
    try {
      remainingOpenTime(deadline);
      directories = await createSessionDirectories();
      remainingOpenTime(deadline);
      stage = "launch_browser";
      browserServer = await this.chromium.launchServer({
        executablePath: this.browserExecutable,
        headless: this.headless,
        chromiumSandbox: true,
        env: minimalBrowserEnvironment(directories, { headless: this.headless }),
        args: [
          "--disable-dev-shm-usage",
          "--disable-breakpad",
          "--disable-crash-reporter",
          "--noerrdialogs",
        ],
        timeout: remainingOpenTime(deadline, this.loginTimeoutMs),
      });
      stage = "connect_browser";
      browser = await this.chromium.connect(browserServer.wsEndpoint(), {
        timeout: remainingOpenTime(deadline, this.loginTimeoutMs),
      });
      stage = "create_browser_context";
      context = await withOpenDeadline(browser.newContext({
        locale: "en-US",
        viewport: { width: 1440, height: 900 },
      }), deadline);
      stage = "create_page";
      const page = await withOpenDeadline(context.newPage(), deadline);
      page.on?.("requestfailed", (request) => {
        let hostname = "";
        let errorText = "request failed";
        try { hostname = new URL(request.url()).hostname; } catch { /* Ignore malformed browser URLs. */ }
        try { errorText = String(request.failure?.()?.errorText || errorText).slice(0, 160); } catch { /* Best effort. */ }
        networkFailures.push({ hostname, error: errorText });
        if (networkFailures.length > 8) networkFailures.shift();
      });
      context.on("request", (request) => {
        let url;
        try { url = new URL(request.url()); } catch { return; }
        if (url.hostname !== "settings-cats.mail.com") return;
        const headers = request.headers();
        const authorization = String(headers.authorization || "");
        const xUiApp = String(headers["x-ui-app"] || "");
        if (authorization.startsWith("Bearer ") && xUiApp) {
          captured.authorization = authorization;
          captured.xUiApp = xUiApp;
        }
      });

      stage = "navigate_home";
      await page.goto("https://www.mail.com/", {
        waitUntil: "domcontentloaded",
        timeout: remainingOpenTime(deadline, 60_000),
      });
      stage = "accept_home_consent";
      await acceptConsent(page, deadline);
      stage = "navigate_login";
      await page.goto(MAILCOM_LOGIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: remainingOpenTime(deadline, 60_000),
      });
      stage = "accept_login_consent";
      await acceptConsent(page, deadline);
      stage = "fill_login_email";
      await page.locator("#login-email").fill(String(username || ""), {
        timeout: remainingOpenTime(deadline, 30_000),
      });
      stage = "fill_login_password";
      await page.locator("#login-password").fill(String(password || ""), {
        timeout: remainingOpenTime(deadline, 30_000),
      });
      stage = "submit_login";
      await page.locator("button.login-submit").click({
        timeout: remainingOpenTime(deadline, 30_000),
      });
      stage = "wait_login";
      try {
        await page.waitForURL(/navigator-lxa\.mail\.com\/(?:.*\/)?mail\/?/i, {
          timeout: remainingOpenTime(deadline, this.loginTimeoutMs),
        });
      } catch (error) {
        if (String(error?.code || "") === "MAILCOM_ALIAS_OPEN_TIMEOUT") throw error;
        stage = "inspect_login_failure";
        const body = String(await page.locator("body").innerText({
          timeout: remainingOpenTime(deadline, 5_000),
        }).catch((inspectionError) => {
          if (String(inspectionError?.code || "") === "MAILCOM_ALIAS_OPEN_TIMEOUT"
              || Date.now() >= Number(deadline)) throw openDeadlineFailure();
          return "";
        })).toLowerCase();
        if (body.includes("invalid email address / password combination") || body.includes("recover password")) {
          throw failure("Mail.com 网页拒绝了母号或密码，请检查后重新连接", 409, "MAILCOM_WEB_AUTH_FAILED", { cause: error });
        }
        if (/captcha|not a robot|unusual activity|verify your identity/.test(body)) {
          throw failure("Mail.com 要求额外的人机或身份验证，请先在官网完成验证", 409, "MAILCOM_WEB_CHALLENGE_REQUIRED", { cause: error });
        }
        throw failure("Mail.com 网页登录超时", 504, "MAILCOM_WEB_LOGIN_TIMEOUT", { cause: error });
      }

      stage = "wait_webmailer_frame";
      const webmailer = await waitForFrame(
        page,
        (url) => url.hostname === "webmailer.mail.com",
        45_000,
        deadline,
      );
      if (!webmailer) {
        throw failure("Mail.com 邮箱页面没有完成加载", 502, "MAILCOM_WEBMAIL_FRAME_MISSING");
      }
      stage = "open_settings";
      await clickFirstAvailable(webmailer, [
        'button[title="Settings for your mail.com account"]',
        'button[aria-label="Settings for your mail.com account"]',
        'button[title*="Settings"]',
        'button[aria-label*="Settings"]',
      ], {
        timeoutMs: 45_000,
        openDeadline: deadline,
        message: "Mail.com 邮箱设置入口没有完成加载",
        code: "MAILCOM_SETTINGS_BUTTON_MISSING",
      });
      stage = "wait_settings_frame";
      const settings = await waitForFrame(
        page,
        (url) => url.hostname === "mailset-root.mail.com",
        45_000,
        deadline,
      );
      if (!settings) {
        throw failure("Mail.com 设置页面没有完成加载", 502, "MAILCOM_SETTINGS_FRAME_MISSING");
      }
      stage = "open_sender_addresses";
      await clickFirstAvailable(settings, [
        'lux-sidebar-item[data-action="sender-addresses"]',
        '[data-action="sender-addresses"]',
        'a[href*="sender-address"]',
        'button:has-text("Sender addresses")',
      ], {
        timeoutMs: 30_000,
        openDeadline: deadline,
        message: "Mail.com 发件地址设置没有完成加载",
        code: "MAILCOM_SENDER_ADDRESSES_MISSING",
      });
      stage = "capture_settings_authorization";
      await waitForCapturedAuthorization(page, captured, 45_000, deadline);

      remainingOpenTime(deadline);

      const session = new MailcomSettingsApiSession({
        browser,
        browserServer,
        context,
        authorization: captured.authorization,
        xUiApp: captured.xUiApp,
        sessionRoot: directories.root,
        semaphoreRelease,
        requestTimeoutMs: this.requestTimeoutMs,
        cleanupTimeoutMs: this.cleanupTimeoutMs,
      });
      captured.authorization = "";
      captured.xUiApp = "";
      browser = null;
      browserServer = null;
      context = null;
      directories = null;
      return session;
    } catch (error) {
      captured.authorization = "";
      captured.xUiApp = "";
      await cleanupBrowserResources({
        context,
        browser,
        browserServer,
        sessionRoot: directories?.root,
        timeoutMs: this.cleanupTimeoutMs,
      });
      const annotated = annotateStage(error, stage);
      if (annotated && typeof annotated === "object" && !annotated.mailcomNetworkFailures) {
        try { annotated.mailcomNetworkFailures = networkFailures; } catch { /* Best effort diagnostics. */ }
      }
      throw annotated;
    }
  }

  async open({ username, password, accountId } = {}) {
    if (!fs.existsSync(this.browserExecutable)) {
      throw failure(
        "服务器未安装 Mail.com 自动创建所需的 Chrome",
        503,
        "MAILCOM_ALIAS_BROWSER_UNAVAILABLE",
      );
    }
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const deadline = startedAt + this.openTimeoutMs;
    let semaphoreRelease;
    let handedOff = false;
    try {
      semaphoreRelease = await this.browserSemaphore.acquire({
        limit: this.maxConcurrentBrowsers,
        timeoutMs: remainingOpenTime(deadline, this.browserWaitTimeoutMs),
      });
      for (let attempt = 1; attempt <= this.openAttempts; attempt += 1) {
        try {
          const session = await this.openAttempt({
            username,
            password,
            semaphoreRelease,
            deadline,
          });
          handedOff = true;
          if (attempt > 1) {
            try {
              this.logger?.info?.(`[mailcom-alias-browser] ${JSON.stringify({
                event: "open_recovered",
                account_id: Number(accountId) || null,
                request_id: requestId,
                attempts: attempt,
                elapsed_ms: Date.now() - startedAt,
              })}`);
            } catch { /* Diagnostics must never break a recovered browser session. */ }
          }
          return session;
        } catch (error) {
          const stage = String(error?.mailcomStage || "unknown");
          const mapped = mappedBrowserOpenFailure(error, {
            stage,
            attempt,
            maxAttempts: this.openAttempts,
            requestId,
          });
          const exponential = this.retryDelayMs * (2 ** (attempt - 1));
          const jitter = Math.floor(
            Math.max(0, Number(this.randomFn()) || 0) * Math.min(500, exponential),
          );
          const retryDelayMs = exponential + jitter;
          const remainingMs = Math.max(0, deadline - Date.now());
          const hasRetryAttempt = attempt < this.openAttempts;
          const hasRetryBudget = remainingMs >= retryDelayMs + MINIMUM_RETRY_BUDGET_MS;
          const willRetry = mapped.retryable && hasRetryAttempt && hasRetryBudget;
          const publicError = willRetry
            ? mapped
            : exhaustedBrowserOpenFailure(mapped, { requestId, attempts: attempt });
          try {
            const method = willRetry ? "warn" : "error";
            this.logger?.[method]?.(`[mailcom-alias-browser] ${JSON.stringify({
              event: "open_failed",
              account_id: Number(accountId) || null,
              request_id: requestId,
              stage,
              attempt,
              max_attempts: this.openAttempts,
              retrying: willRetry,
              retry_delay_ms: willRetry ? retryDelayMs : 0,
              retry_skipped_reason: willRetry || !mapped.retryable ? ""
                : (!hasRetryAttempt ? "attempts_exhausted" : "deadline_budget_exhausted"),
              deadline_remaining_ms: remainingMs,
              elapsed_ms: Date.now() - startedAt,
              error_name: String(error?.name || "Error"),
              raw_error_code: String(error?.code || ""),
              mapped_error_code: String(mapped.code || ""),
              public_error_code: String(publicError.code || ""),
              network_failures: Array.isArray(error?.mailcomNetworkFailures)
                ? error.mailcomNetworkFailures : [],
              error: sanitizedDiagnostic(error, [password]),
            })}`);
          } catch { /* Diagnostics must never replace the public error. */ }
          if (!willRetry) throw publicError;
          try {
            await withOpenDeadline(Promise.resolve(this.sleepFn(retryDelayMs)), deadline);
          } catch (delayError) {
            const delayFailure = mappedBrowserOpenFailure(delayError, {
              stage: "retry_delay",
              attempt,
              maxAttempts: this.openAttempts,
              requestId,
            });
            throw exhaustedBrowserOpenFailure(delayFailure, { requestId, attempts: attempt });
          }
        }
      }
      throw failure("Mail.com 网页自动创建组件运行失败", 502, "MAILCOM_ALIAS_BROWSER_FAILED");
    } finally {
      if (!handedOff) semaphoreRelease?.();
    }
  }
}

export const mailcomAliasSettingsEndpoints = Object.freeze({
  addresses: `${SETTINGS_API_ROOT}${ADDRESSES_PATH}`,
  domains: `${SETTINGS_API_ROOT}${DOMAINS_PATH}`,
  validations: `${SETTINGS_API_ROOT}${VALIDATIONS_PATH}`,
  create: `${SETTINGS_API_ROOT}${CREATE_PATH}`,
  deleteAlias: (address) => `${SETTINGS_API_ROOT}${addressRemovalPath(address)}`,
});
