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
const DEFAULT_BROWSER_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function failure(message, status = 502, code = "MAILCOM_ALIAS_BROWSER_FAILED", options = {}) {
  return Object.assign(new Error(message, options), { status, code });
}

function positiveInteger(value, fallback, maximum = 100) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
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
  const graceful = (async () => {
    try { await context?.close?.(); } catch { /* Force-close below if needed. */ }
    try { await browser?.close?.(); } catch { /* Force-close below if needed. */ }
    try { await browserServer?.close?.(); } catch { /* Force-close below if needed. */ }
  })();
  let timedOut = false;
  await promiseDeadline(graceful, boundedTimeout).catch(() => { timedOut = true; });
  if (timedOut && browserServer) {
    let killed = false;
    try {
      await promiseDeadline(Promise.resolve(browserServer.kill?.()), Math.min(3_000, boundedTimeout));
      killed = true;
    } catch {
      // Fall through to the process-level SIGKILL below.
    }
    if (!killed) {
      try { browserServer.process?.()?.kill?.("SIGKILL"); } catch { /* Process may already be gone. */ }
    }
  }
  if (sessionRoot) {
    try {
      await promiseDeadline(
        fs.promises.rm(sessionRoot, { recursive: true, force: true }),
        Math.min(5_000, boundedTimeout),
      );
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

async function firstVisibleAcrossFrames(page, selector, timeout = 1_500) {
  for (const frame of page.frames()) {
    try {
      const locator = frame.locator(selector).first();
      if (await locator.isVisible({ timeout })) return locator;
    } catch {
      // Consent surfaces differ by region and are optional.
    }
  }
  return null;
}

async function acceptConsent(page) {
  const selectors = [
    'button:has-text("Continue to Mail.com")',
    'button:has-text("Accept all")',
    'button:has-text("Agree and continue")',
  ];
  for (const selector of selectors) {
    const button = await firstVisibleAcrossFrames(page, selector);
    if (!button) continue;
    try { await button.click({ timeout: 3_000 }); } catch { /* Optional consent prompt. */ }
    return;
  }
}

async function waitForFrame(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find((item) => {
      try { return predicate(new URL(item.url())); } catch { return false; }
    });
    if (frame) return frame;
    await Promise.race([page.waitForTimeout(250), deadlinePromise(Math.max(1, deadline - Date.now()))]);
  }
  return null;
}

async function waitForCapturedAuthorization(page, captured, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (captured.authorization.startsWith("Bearer ") && captured.xUiApp) return;
    await Promise.race([page.waitForTimeout(200), deadlinePromise(Math.max(1, deadline - Date.now()))]);
  }
  throw failure(
    "Mail.com 设置页未返回可用授权，请重新登录后再试",
    409,
    "MAILCOM_ALIAS_SETTINGS_AUTH_MISSING",
  );
}

function apiFailure(status, operation) {
  if ([401, 403].includes(status)) {
    return failure("Mail.com 网页授权已失效，请重新连接母号后再试", 409, "MAILCOM_ALIAS_SESSION_EXPIRED");
  }
  if (status === 409) {
    return failure(`Mail.com 拒绝${operation}，地址数量可能已达到上限`, 409, "MAILCOM_ALIAS_CONFLICT");
  }
  if (status === 429) {
    return failure("Mail.com 请求过于频繁，请稍后重试", 429, "MAILCOM_ALIAS_RATE_LIMITED");
  }
  if (status >= 500) {
    return failure("Mail.com 设置服务暂时不可用，请稍后重试", 503, "MAILCOM_ALIAS_SETTINGS_UNAVAILABLE");
  }
  return failure(`Mail.com ${operation}失败`, 502, "MAILCOM_ALIAS_SETTINGS_REQUEST_FAILED");
}

async function jsonResponse(response, operation, ignoreBody = false) {
  const status = response.status();
  if (!response.ok()) throw apiFailure(status, operation);
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
    return jsonResponse(response, operation || "请求", ignoreBody);
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
  } = {}) {
    this.chromium = chromiumLauncher;
    this.browserExecutable = String(browserExecutable || defaultBrowserExecutable());
    this.headless = Boolean(headless);
    this.loginTimeoutMs = Math.max(10_000, Number(loginTimeoutMs) || 90_000);
    this.requestTimeoutMs = Math.max(1_000, Number(requestTimeoutMs) || 30_000);
    this.cleanupTimeoutMs = positiveInteger(cleanupTimeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS, 60_000);
    this.browserSemaphore = browserSemaphore;
    this.maxConcurrentBrowsers = positiveInteger(maxConcurrentBrowsers, DEFAULT_BROWSER_LIMIT, 10);
    this.browserWaitTimeoutMs = positiveInteger(
      browserWaitTimeoutMs,
      DEFAULT_BROWSER_WAIT_TIMEOUT_MS,
      300_000,
    );
  }

  async open({ username, password } = {}) {
    if (!fs.existsSync(this.browserExecutable)) {
      throw failure(
        "服务器未安装 Mail.com 自动创建所需的 Chrome",
        503,
        "MAILCOM_ALIAS_BROWSER_UNAVAILABLE",
      );
    }
    const semaphoreRelease = await this.browserSemaphore.acquire({
      limit: this.maxConcurrentBrowsers,
      timeoutMs: this.browserWaitTimeoutMs,
    });
    let browserServer;
    let browser;
    let context;
    let directories;
    const captured = { authorization: "", xUiApp: "" };
    try {
      directories = await createSessionDirectories();
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
        timeout: this.loginTimeoutMs,
      });
      browser = await this.chromium.connect(browserServer.wsEndpoint(), { timeout: this.loginTimeoutMs });
      context = await browser.newContext({
        locale: "en-US",
        viewport: { width: 1440, height: 900 },
      });
      const page = await context.newPage();
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

      await page.goto("https://www.mail.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      await acceptConsent(page);
      await page.goto(MAILCOM_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await acceptConsent(page);
      await page.locator("#login-email").fill(String(username || ""));
      await page.locator("#login-password").fill(String(password || ""));
      await page.locator("button.login-submit").click();
      try {
        await page.waitForURL(/navigator-lxa\.mail\.com\/(?:.*\/)?mail\/?/i, { timeout: this.loginTimeoutMs });
      } catch (error) {
        const body = String(await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).toLowerCase();
        if (body.includes("invalid email address / password combination") || body.includes("recover password")) {
          throw failure("Mail.com 网页拒绝了母号或密码，请检查后重新连接", 409, "MAILCOM_WEB_AUTH_FAILED");
        }
        if (/captcha|not a robot|unusual activity|verify your identity/.test(body)) {
          throw failure("Mail.com 要求额外的人机或身份验证，请先在官网完成验证", 409, "MAILCOM_WEB_CHALLENGE_REQUIRED");
        }
        throw failure("Mail.com 网页登录超时，请稍后重试", 504, "MAILCOM_WEB_LOGIN_TIMEOUT");
      }

      const webmailer = await waitForFrame(page, (url) => url.hostname === "webmailer.mail.com", 45_000);
      if (!webmailer) {
        throw failure("Mail.com 邮箱页面没有完成加载", 502, "MAILCOM_WEBMAIL_FRAME_MISSING");
      }
      await webmailer.locator('button[title="Settings for your mail.com account"]').click({ timeout: 45_000 });
      const settings = await waitForFrame(page, (url) => url.hostname === "mailset-root.mail.com", 45_000);
      if (!settings) {
        throw failure("Mail.com 设置页面没有完成加载", 502, "MAILCOM_SETTINGS_FRAME_MISSING");
      }
      await settings.locator('lux-sidebar-item[data-action="sender-addresses"]').click({ timeout: 30_000 });
      await waitForCapturedAuthorization(page, captured, 45_000);

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
      semaphoreRelease();
      if (String(error?.code || "").startsWith("MAILCOM_")) throw error;
      throw failure("Mail.com 网页自动创建组件运行失败，请稍后重试", 502, "MAILCOM_ALIAS_BROWSER_FAILED");
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
