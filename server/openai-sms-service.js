import crypto from "node:crypto";
import { getSetting, nowIso, setSetting } from "./db.js";
import { PAYMENT_AGREEMENT_HERO_COUNTRIES } from "./payment-agreement-service.js";

const HERO_SERVICE = "dr";
const HERO_COUNTRY_RANK_URL = "https://hero-sms.com/api/v1/left-menu/services/dr/countries";
const HERO_COUNTRY_FLAG_BASE_URL = "https://cdn.hero-sms.com/assets/img/country";
const HERO_COUNTRY_CACHE_TTL_MS = 15_000;
const HERO_COUNTRY_STALE_TTL_MS = 5 * 60_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const ACTIVE_STATUSES = new Set(["queued", "running", "cancel_requested"]);
const REMOTE_SUCCESS_STATUSES = new Set(["succeeded", "completed", "success"]);
const REMOTE_FAILURE_STATUSES = new Set(["failed", "error", "interrupted"]);
const REMOTE_CANCELLED_STATUSES = new Set(["cancelled", "canceled"]);
const BROWSER_MODES = new Set([
  "camoufox_headed",
  "camoufox_headless",
  "bitbrowser_headed",
  "bitbrowser_hidden",
  "bitbrowser_headless",
]);

const COUNTRY_SETTING = "openai_sms_country";
const MAX_PRICE_SETTING = "openai_sms_max_price";
const CLAIM_TIMEOUT_SETTING = "openai_sms_claim_timeout_seconds";
const CLAIM_INTERVAL_SETTING = "openai_sms_claim_interval_seconds";
const WAIT_SECONDS_SETTING = "openai_sms_wait_seconds";
const CONCURRENCY_SETTING = "openai_sms_concurrency";
const BROWSER_MODE_SETTING = "openai_sms_browser_mode";

function failure(message, status = 500, code = "OPENAI_SMS_ERROR") {
  return Object.assign(new Error(message), { status, code });
}

function boundedNumber(value, fallback, minimum, maximum, label, integer = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum || (integer && !Number.isInteger(parsed))) {
    throw failure(`${label}参数无效`, 400, "OPENAI_SMS_SETTINGS_INVALID");
  }
  return parsed;
}

function normalizeCountry(value) {
  const requested = String(value || "").trim().toUpperCase();
  const country = requested === "AUTO" ? "TH" : requested;
  const dynamicCountryId = /^(?:0|[1-9]\d{0,3})$/.test(country) ? Number(country) : NaN;
  if (!Object.hasOwn(PAYMENT_AGREEMENT_HERO_COUNTRIES, country)
    && (!Number.isSafeInteger(dynamicCountryId) || dynamicCountryId < 0 || dynamicCountryId > 999)) {
    throw failure(
      "OpenAI 接码国家无效，请从 HeroSMS 实时国家列表选择",
      400,
      "OPENAI_SMS_COUNTRY_UNSUPPORTED",
    );
  }
  return Number.isSafeInteger(dynamicCountryId) ? String(dynamicCountryId) : country;
}

const HERO_COUNTRY_BY_ID = new Map(
  Object.entries(PAYMENT_AGREEMENT_HERO_COUNTRIES)
    .map(([code, item]) => [Number(item.id), { code, ...item }]),
);

function heroCountryInfo(value) {
  const country = normalizeCountry(value);
  return PAYMENT_AGREEMENT_HERO_COUNTRIES[country]
    || HERO_COUNTRY_BY_ID.get(Number(country))
    || null;
}

function heroCountryId(value) {
  const country = normalizeCountry(value);
  return Number(PAYMENT_AGREEMENT_HERO_COUNTRIES[country]?.id ?? country);
}

function normalizeBrowserMode(value) {
  const mode = String(value || "").trim();
  if (!BROWSER_MODES.has(mode)) {
    throw failure("OpenAI 接码浏览器模式无效", 400, "OPENAI_SMS_BROWSER_MODE_INVALID");
  }
  return mode;
}

function normalizeIds(value) {
  if (!Array.isArray(value) || !value.length) {
    throw failure("请明确选择至少一个注册账号", 400, "OPENAI_SMS_IDS_REQUIRED");
  }
  if (value.length > 100) {
    throw failure("每次最多选择 100 个注册账号", 400, "OPENAI_SMS_IDS_LIMIT");
  }
  const ids = value.map((item) => {
    const id = typeof item === "number" ? item : (/^[1-9]\d*$/.test(String(item || "")) ? Number(item) : NaN);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw failure("选择中包含无效注册账号 ID", 400, "OPENAI_SMS_ID_INVALID");
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    throw failure("选择中包含重复注册账号", 400, "OPENAI_SMS_ID_DUPLICATE");
  }
  return ids;
}

function normalizedPrice(value) {
  return String(Number(value).toFixed(6)).replace(/(?:\.0+|(\.\d*?)0+)$/, "$1");
}

function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return `${"*".repeat(Math.max(3, digits.length - 4))}${digits.slice(-4)}`;
}

function maskPhonesInText(value) {
  return String(value || "").replace(/(^|[^\w])\+?\d[\d ()-]{5,}\d(?![\w])/g, (match, prefix) => {
    const candidate = match.slice(prefix.length);
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) return match;
    return `${prefix}${maskPhone(candidate)}`;
  });
}

function redactText(value, secrets = []) {
  let text = maskPhonesInText(value)
    .replace(/([?&](?:api[_-]?key|key)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(\/relay\/)[A-Za-z0-9_-]{20,}/g, "$1[REDACTED]")
    .replace(/((?:验证码|OTP|code)\s*[:=：]?\s*)\d{6}\b/gi, "$1******");
  for (const secret of secrets) {
    if (secret) text = text.split(String(secret)).join("[REDACTED]");
  }
  return text.slice(0, 1_000);
}

function safeError(error, fallback, secrets = []) {
  return redactText(error?.message || error?.detail || fallback, secrets) || fallback;
}

function remoteTaskId(value) {
  return String(value?.task_id || value?.id || value?.task?.task_id || value?.task?.id || "").trim();
}

function remoteStatus(value) {
  return String(value?.status || value?.task?.status || "").trim().toLowerCase();
}

function remoteResultData(value) {
  const source = value?.result?.data ?? value?.task?.result?.data ?? value?.data ?? value?.result ?? {};
  return source && typeof source === "object" && !Array.isArray(source) ? source : {};
}

function remoteFailureMessage(value, fallback = "OpenAI 手机号绑定失败") {
  const data = remoteResultData(value);
  const results = Array.isArray(data.results) ? data.results : [];
  const failed = results.find((item) => item && (item.ok === false || item.success === false))
    || results.find((item) => item?.error || item?.detail);
  const candidates = [
    failed?.error,
    failed?.detail,
    data?.error,
    data?.detail,
    value?.error,
    value?.detail,
    value?.task?.error,
    value?.task?.detail,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object") {
      const nested = candidate.message || candidate.detail || candidate.error;
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
  }
  return fallback;
}

function remoteSucceeded(value) {
  const data = remoteResultData(value);
  if (Number(data.failure_count || 0) > 0) return false;
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.some((item) => item && item.ok === false)) return false;
  return REMOTE_SUCCESS_STATUSES.has(remoteStatus(value));
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function isoFromMilliseconds(value) {
  return new Date(value).toISOString();
}

export class OpenAiSmsService {
  constructor({
    db,
    registration,
    client,
    paymentAgreements,
    publicBaseUrl,
    sleepFn = defaultSleep,
    nowFn = Date.now,
    remotePollIntervalMs = 2_000,
    remoteFailureLimit = 3,
    relayRateLimit = 60,
    relayRateWindowMs = 60_000,
    countryFetchFn,
    countryRankUrl = HERO_COUNTRY_RANK_URL,
    countryCacheTtlMs = HERO_COUNTRY_CACHE_TTL_MS,
    countryStaleTtlMs = HERO_COUNTRY_STALE_TTL_MS,
    countryRequestTimeoutMs = 10_000,
  } = {}) {
    if (!db) throw new TypeError("OpenAiSmsService requires db");
    if (!registration) throw new TypeError("OpenAiSmsService requires registration");
    if (!client) throw new TypeError("OpenAiSmsService requires registration client");
    if (!paymentAgreements) throw new TypeError("OpenAiSmsService requires PaymentAgreementService");
    this.db = db;
    this.registration = registration;
    this.client = client;
    this.paymentAgreements = paymentAgreements;
    this.publicBaseUrl = String(publicBaseUrl || "").trim().replace(/\/+$/, "");
    this.sleepFn = sleepFn;
    this.nowFn = nowFn;
    this.remotePollIntervalMs = Math.max(10, Number(remotePollIntervalMs) || 2_000);
    this.remoteFailureLimit = Math.max(1, Number(remoteFailureLimit) || 3);
    this.relayRateLimit = Math.max(1, Number(relayRateLimit) || 60);
    this.relayRateWindowMs = Math.max(1_000, Number(relayRateWindowMs) || 60_000);
    this.countryFetchFn = countryFetchFn || globalThis.fetch;
    if (typeof this.countryFetchFn !== "function") throw new TypeError("OpenAiSmsService requires country fetch");
    this.countryRankUrl = String(countryRankUrl || HERO_COUNTRY_RANK_URL);
    this.countryCacheTtlMs = Math.max(1_000, Number(countryCacheTtlMs) || HERO_COUNTRY_CACHE_TTL_MS);
    this.countryStaleTtlMs = Math.max(
      this.countryCacheTtlMs,
      Number(countryStaleTtlMs) || HERO_COUNTRY_STALE_TTL_MS,
    );
    this.countryRequestTimeoutMs = Math.max(1_000, Number(countryRequestTimeoutMs) || 10_000);
    this.countryCache = null;
    this.countryFetchPromise = null;
    this.trackers = new Map();
    this.cancelTrackers = new Map();
    this.wakes = new Map();
    this.releasePromises = new Map();
    this.releaseRetryTimers = new Map();
    this.releaseRetryAttempts = new Map();
    this.itemOperations = new Map();
    this.relayRates = new Map();
    this.closed = false;
    this.recovering = true;
    this.recoveryError = "";
    this.recoveryPromise = this.recoverInterruptedTasks().catch((error) => {
      this.recoveryError = safeError(error, "OpenAI 自动接码恢复失败", this.secretValues());
      console.error("OpenAI SMS recovery failed:", this.recoveryError);
    }).finally(() => { this.recovering = false; });
  }

  countries() {
    return Object.entries(PAYMENT_AGREEMENT_HERO_COUNTRIES).map(([code, item]) => ({
      code,
      value: String(item.id),
      hero_sms_country_id: item.id,
      name: item.name,
      calling_code: `+${item.callingCode}`,
    }));
  }

  parseRankedCountries(payload) {
    const source = Array.isArray(payload?.data)
      ? payload.data
      : Object.values(payload?.data && typeof payload.data === "object" ? payload.data : {});
    const countries = [];
    for (const [sourceIndex, item] of source.entries()) {
      if (!item || typeof item !== "object") continue;
      const id = Number(item.id ?? item.country_id ?? item.countryId);
      const minPrice = Number(item.priceMinAvailable ?? item.min_price ?? item.priceDefault);
      const physicalCount = Math.max(0, Math.trunc(Number(item.countPhysical ?? item.physical_count ?? 0) || 0));
      const deliverability = Number(item.deliverability);
      const name = String(item.name || "").trim().slice(0, 80);
      if (!Number.isSafeInteger(id) || id < 0 || id > 999 || !name
        || !Number.isFinite(minPrice) || minPrice <= 0 || physicalCount <= 0) continue;
      countries.push({
        rank: countries.length + 1,
        source_rank: sourceIndex + 1,
        id,
        value: String(id),
        hero_sms_country_id: id,
        name,
        min_price: Number(minPrice.toFixed(6)),
        price_default: Number.isFinite(Number(item.priceDefault))
          ? Number(Number(item.priceDefault).toFixed(6))
          : null,
        stock: physicalCount,
        physical_count: physicalCount,
        deliverability: Number.isFinite(deliverability)
          ? Math.min(Math.max(Number(deliverability.toFixed(2)), 0), 100)
          : null,
        flag_url: `${HERO_COUNTRY_FLAG_BASE_URL}/${id}.svg`,
      });
      if (countries.length >= 10) break;
    }
    if (!countries.length) {
      throw failure("HeroSMS 未返回可用的 OpenAI 实时国家", 502, "OPENAI_SMS_COUNTRIES_INVALID");
    }
    return countries;
  }

  async fetchRankedCountries() {
    let url;
    try {
      url = new URL(this.countryRankUrl);
    } catch {
      throw failure("HeroSMS 实时国家接口配置无效", 500, "OPENAI_SMS_COUNTRIES_URL_INVALID");
    }
    url.searchParams.set("page", "1");
    url.searchParams.set("size", "25");
    url.searchParams.set("sort[deliverability]", "desc");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.countryRequestTimeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await this.countryFetchFn(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Accept-Language": "zh-CN",
        },
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw failure("HeroSMS 实时国家请求超时", 504, "OPENAI_SMS_COUNTRIES_TIMEOUT");
      }
      throw failure("HeroSMS 实时国家网络请求失败", 502, "OPENAI_SMS_COUNTRIES_NETWORK_ERROR");
    } finally {
      clearTimeout(timer);
    }
    if (!response?.ok) {
      throw failure("HeroSMS 实时国家请求失败", 502, "OPENAI_SMS_COUNTRIES_HTTP_ERROR");
    }
    let payload;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      throw failure("HeroSMS 实时国家响应无效", 502, "OPENAI_SMS_COUNTRIES_INVALID");
    }
    return this.parseRankedCountries(payload);
  }

  rankedCountriesPayload(cache, { stale = false, error = "" } = {}) {
    const maxPrice = boundedNumber(
      getSetting(this.db, MAX_PRICE_SETTING, "1"), 1, 0.0001, 100, "单号最高价格",
    );
    const savedCountryId = heroCountryId(getSetting(this.db, COUNTRY_SETTING, "TH"));
    const affordable = cache.countries.filter((item) => item.min_price <= maxPrice + 0.000001);
    const recommended = affordable.find((item) => item.id === savedCountryId)
      || affordable[0]
      || cache.countries[0];
    return {
      service: "OpenAI",
      service_code: HERO_SERVICE,
      source: "hero_sms_quality",
      sort: "deliverability_desc",
      sort_label: "按质量排序",
      countries: cache.countries.map((item) => ({ ...item })),
      recommended_country_id: recommended?.id ?? null,
      updated_at: isoFromMilliseconds(cache.fetchedAt),
      expires_at: isoFromMilliseconds(cache.fetchedAt + this.countryCacheTtlMs),
      cache_ttl_seconds: Math.ceil(this.countryCacheTtlMs / 1_000),
      stale,
      error: stale ? redactText(error, this.secretValues()) : "",
    };
  }

  async topCountries({ force = false } = {}) {
    const now = this.nowFn();
    if (!force && this.countryCache && now - this.countryCache.fetchedAt < this.countryCacheTtlMs) {
      return this.rankedCountriesPayload(this.countryCache);
    }
    if (this.countryFetchPromise) return this.countryFetchPromise;
    const previous = this.countryCache;
    this.countryFetchPromise = this.fetchRankedCountries()
      .then((countries) => {
        this.countryCache = { countries, fetchedAt: this.nowFn() };
        return this.rankedCountriesPayload(this.countryCache);
      })
      .catch((error) => {
        const age = previous ? this.nowFn() - previous.fetchedAt : Number.POSITIVE_INFINITY;
        if (previous && age <= this.countryStaleTtlMs) {
          return this.rankedCountriesPayload(previous, {
            stale: true,
            error: safeError(error, "HeroSMS 实时国家刷新失败", this.secretValues()),
          });
        }
        throw error;
      })
      .finally(() => { this.countryFetchPromise = null; });
    return this.countryFetchPromise;
  }

  apiKey({ required = false } = {}) {
    return this.paymentAgreements.heroSmsApiKey({ required });
  }

  settings() {
    let apiKeyConfigured = false;
    let apiKeyError = "";
    try {
      apiKeyConfigured = Boolean(this.apiKey());
    } catch (error) {
      apiKeyError = safeError(error, "HeroSMS API Key 无法读取");
    }
    const country = normalizeCountry(getSetting(this.db, COUNTRY_SETTING, "TH"));
    const browserMode = normalizeBrowserMode(getSetting(this.db, BROWSER_MODE_SETTING, "camoufox_headed"));
    return {
      configured: apiKeyConfigured,
      ready: apiKeyConfigured && !this.recoveryError && !this.closed,
      recovering: this.recovering,
      api_key_configured: apiKeyConfigured,
      api_key_error: apiKeyError,
      recovery_error: this.recoveryError,
      service: "OpenAI",
      service_code: HERO_SERVICE,
      country,
      hero_sms_country_id: heroCountryId(country),
      countries: this.countries(),
      max_price: boundedNumber(getSetting(this.db, MAX_PRICE_SETTING, "1"), 1, 0.0001, 100, "单号最高价格"),
      claim_timeout_seconds: boundedNumber(
        getSetting(this.db, CLAIM_TIMEOUT_SETTING, "120"), 120, 30, 3_600, "抢号超时", true,
      ),
      claim_interval_seconds: boundedNumber(
        getSetting(this.db, CLAIM_INTERVAL_SETTING, "2"), 2, 1, 60, "抢号间隔", true,
      ),
      wait_seconds: boundedNumber(
        getSetting(this.db, WAIT_SECONDS_SETTING, "180"), 180, 30, 1_800, "等码时间", true,
      ),
      concurrency: boundedNumber(
        getSetting(this.db, CONCURRENCY_SETTING, "1"), 1, 1, 3, "并发数", true,
      ),
      browser_mode: browserMode,
      active_tasks: Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM openai_sms_tasks
        WHERE status IN ('queued', 'running', 'cancel_requested')
      `).get()?.count || 0),
    };
  }

  updateSettings(input = {}) {
    const current = this.settings();
    const country = normalizeCountry(
      input.country_id ?? input.hero_sms_country_id ?? input.country ?? current.country,
    );
    const maxPrice = boundedNumber(input.max_price, current.max_price, 0.0001, 100, "单号最高价格");
    const claimTimeoutSeconds = boundedNumber(
      input.claim_timeout_seconds, current.claim_timeout_seconds, 30, 3_600, "抢号超时", true,
    );
    const claimIntervalSeconds = boundedNumber(
      input.claim_interval_seconds, current.claim_interval_seconds, 1, 60, "抢号间隔", true,
    );
    const waitSeconds = boundedNumber(input.wait_seconds, current.wait_seconds, 30, 1_800, "等码时间", true);
    const concurrency = boundedNumber(input.concurrency, current.concurrency, 1, 3, "并发数", true);
    const browserMode = normalizeBrowserMode(input.browser_mode ?? current.browser_mode);
    if (claimIntervalSeconds >= claimTimeoutSeconds) {
      throw failure("抢号间隔必须小于抢号超时", 400, "OPENAI_SMS_SETTINGS_INVALID");
    }
    this.db.transaction(() => {
      setSetting(this.db, COUNTRY_SETTING, country);
      setSetting(this.db, MAX_PRICE_SETTING, maxPrice);
      setSetting(this.db, CLAIM_TIMEOUT_SETTING, claimTimeoutSeconds);
      setSetting(this.db, CLAIM_INTERVAL_SETTING, claimIntervalSeconds);
      setSetting(this.db, WAIT_SECONDS_SETTING, waitSeconds);
      setSetting(this.db, CONCURRENCY_SETTING, concurrency);
      setSetting(this.db, BROWSER_MODE_SETTING, browserMode);
    })();
    return this.settings();
  }

  taskOptions(input = {}) {
    const settings = this.settings();
    const country = normalizeCountry(
      input.country_id ?? input.hero_sms_country_id ?? input.country ?? settings.country,
    );
    const maxPrice = boundedNumber(input.max_price, settings.max_price, 0.0001, 100, "单号最高价格");
    const claimTimeoutSeconds = boundedNumber(
      input.claim_timeout_seconds, settings.claim_timeout_seconds, 30, 3_600, "抢号超时", true,
    );
    const claimIntervalSeconds = settings.claim_interval_seconds;
    const waitSeconds = boundedNumber(input.wait_seconds, settings.wait_seconds, 30, 1_800, "等码时间", true);
    const concurrency = boundedNumber(input.concurrency, settings.concurrency, 1, 3, "并发数", true);
    const browserMode = normalizeBrowserMode(input.browser_mode ?? settings.browser_mode);
    return {
      country,
      countryId: heroCountryId(country),
      maxPrice,
      claimTimeoutSeconds,
      claimIntervalSeconds,
      waitSeconds,
      concurrency,
      browserMode,
    };
  }

  async start(input = {}) {
    await this.recoveryPromise;
    if (this.closed) throw failure("OpenAI 自动接码服务正在关闭", 503, "OPENAI_SMS_CLOSED");
    if (this.recoveryError) {
      throw failure("OpenAI 自动接码恢复未完成，请先检查服务日志", 503, "OPENAI_SMS_RECOVERY_FAILED");
    }
    if (input.payment_confirmed !== true) {
      throw failure("请确认 HeroSMS 号码会产生费用", 400, "OPENAI_SMS_PAYMENT_CONFIRMATION_REQUIRED");
    }
    const ids = normalizeIds(input.ids);
    const options = this.taskOptions(input);
    this.apiKey({ required: true });

    const response = await this.registration.listRegisteredAccounts({ refreshUnchecked: false });
    const accountById = new Map((response?.items || []).map((item) => [Number(item.id), item]));
    if (ids.some((id) => !accountById.has(id))) {
      throw failure("选择中包含不属于本注册页面的账号", 409, "OPENAI_SMS_ACCOUNT_NOT_FOUND");
    }
    const accounts = ids.map((id) => accountById.get(id));
    this.updateSettings({
      country: options.country,
      max_price: options.maxPrice,
      claim_timeout_seconds: options.claimTimeoutSeconds,
      wait_seconds: options.waitSeconds,
      concurrency: options.concurrency,
      browser_mode: options.browserMode,
    });
    const taskId = crypto.randomUUID();
    const createdAt = nowIso();
    try {
      this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO openai_sms_tasks (
            id, status, stage, country, hero_sms_country_id, max_price,
            claim_timeout_seconds, claim_interval_seconds, wait_seconds, concurrency,
            browser_mode, progress_total, created_at, updated_at
          ) VALUES (?, 'queued', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          taskId,
          options.country,
          options.countryId,
          options.maxPrice,
          options.claimTimeoutSeconds,
          options.claimIntervalSeconds,
          options.waitSeconds,
          Math.min(options.concurrency, accounts.length),
          options.browserMode,
          accounts.length,
          createdAt,
          createdAt,
        );
        const insertItem = this.db.prepare(`
          INSERT INTO openai_sms_task_items (
            task_id, external_account_id, email, status, stage, created_at, updated_at
          ) VALUES (?, ?, ?, 'queued', 'queued', ?, ?)
        `);
        for (const account of accounts) {
          insertItem.run(taskId, String(account.id), String(account.email || ""), createdAt, createdAt);
        }
      })();
    } catch (error) {
      if (String(error?.message || "").includes("idx_openai_sms_items_active_account")) {
        throw failure("所选账号已有自动接码任务正在进行", 409, "OPENAI_SMS_ACCOUNT_BUSY");
      }
      if (String(error?.message || "").includes("UNIQUE constraint")) {
        throw failure("所选账号已有自动接码任务正在进行", 409, "OPENAI_SMS_ACCOUNT_BUSY");
      }
      throw error;
    }
    this.addEvent(taskId, null, "已创建 OpenAI 自动接码任务", "summary");
    this.startTracker(taskId);
    return this.publicTask(taskId);
  }

  startTracker(taskId) {
    if (this.trackers.has(taskId)) return this.trackers.get(taskId);
    const tracker = this.runTask(taskId)
      .catch(async (error) => {
        const message = safeError(error, "OpenAI 自动接码任务失败", this.secretValues());
        const activeItems = this.items(taskId).filter((item) => ACTIVE_STATUSES.has(item.status));
        await Promise.allSettled(activeItems.map(async (item) => {
          if (item.remote_task_id) await this.client.cancelTask(item.remote_task_id).catch(() => undefined);
          await this.finishItem(item.id, "failed", message);
        }));
        this.db.prepare(`
          UPDATE openai_sms_tasks
          SET status = 'failed', stage = 'failed', error = ?, finished_at = ?, updated_at = ?
          WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
        `).run(message, nowIso(), nowIso(), taskId);
        this.addEvent(taskId, null, message, "error", "error");
      })
      .finally(() => this.trackers.delete(taskId));
    this.trackers.set(taskId, tracker);
    return tracker;
  }

  async runTask(taskId) {
    const task = this.taskRow(taskId);
    if (!task || TERMINAL_STATUSES.has(task.status)) return;
    this.db.prepare(`
      UPDATE openai_sms_tasks SET status = 'running', stage = 'running', updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(nowIso(), taskId);
    const itemIds = this.items(taskId).map((item) => item.id);
    let cursor = 0;
    const workerCount = Math.min(Math.max(Number(task.concurrency) || 1, 1), itemIds.length || 1);
    const worker = async () => {
      while (!this.closed) {
        const currentTask = this.taskRow(taskId);
        if (!currentTask || currentTask.status === "cancel_requested" || TERMINAL_STATUSES.has(currentTask.status)) return;
        const index = cursor;
        cursor += 1;
        if (index >= itemIds.length) return;
        const item = this.itemRow(itemIds[index]);
        if (!item || item.status !== "queued") continue;
        try {
          await this.runItem(item.id);
        } catch (error) {
          const message = safeError(error, "OpenAI 自动接码失败", this.secretValues());
          if (this.itemWasCancelled(item.id)) {
            const current = this.itemRow(item.id);
            if (current?.remote_task_id && current.stage !== "starting_worker") {
              await this.startRemoteCancellation(item.id, current.remote_task_id);
            } else {
              if (current?.remote_task_id) {
                await this.client.cancelTask(current.remote_task_id).catch(() => undefined);
              }
              await this.finishItem(item.id, "cancelled", "任务已取消");
            }
          } else {
            const current = this.itemRow(item.id);
            if (current?.remote_task_id) {
              await this.client.cancelTask(current.remote_task_id).catch(() => undefined);
            }
            await this.finishItem(item.id, "failed", message);
          }
        }
        this.recomputeTask(taskId);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, worker));
    this.recomputeTask(taskId);
  }

  async runItem(itemId) {
    const item = this.itemRow(itemId);
    if (!item || item.status !== "queued") return;
    this.updateItem(itemId, { status: "running", stage: "acquiring_number" });
    this.addEvent(item.task_id, itemId, `开始为 ${item.email} 抢取 OpenAI 接码号码`);
    const task = this.taskRow(item.task_id);
    const activation = await this.claimNumber(itemId, task);
    const relayToken = crypto.randomBytes(32).toString("base64url");
    const relayTokenHash = crypto.createHash("sha256").update(relayToken).digest("hex");
    const phoneMask = maskPhone(activation.phone);
    try {
      const persisted = this.db.prepare(`
        UPDATE openai_sms_task_items
        SET relay_token_hash = ?, phone_mask = ?, price = ?,
          stage = 'number_acquired', updated_at = ?
        WHERE id = ? AND activation_id_encrypted <> ''
      `).run(relayTokenHash, phoneMask, activation.price, nowIso(), itemId);
      if (!persisted.changes) {
        throw failure("HeroSMS 号码持久化状态丢失", 500, "OPENAI_SMS_ACTIVATION_PERSIST_FAILED");
      }
    } catch (error) {
      await this.releaseActivation(itemId, false);
      throw error;
    }
    this.addEvent(item.task_id, itemId, `已抢到号码 ${phoneMask}${activation.price === null ? "" : `，价格 $${activation.price}`}`);

    if (this.closed || this.itemWasCancelled(itemId)) {
      await this.releaseActivation(itemId, false);
      await this.finishItem(itemId, "cancelled", "任务已取消");
      return;
    }

    const relayUrl = this.relayUrl(relayToken);
    const requestedWorkerTaskId = item.remote_task_id
      || `ahpb_${crypto.randomBytes(24).toString("base64url")}`;
    this.db.prepare(`
      UPDATE openai_sms_task_items
      SET remote_task_id = ?, stage = 'starting_worker', updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(requestedWorkerTaskId, nowIso(), itemId);
    let remote;
    try {
      remote = await this.client.createPhoneBindTask({
        task_id: requestedWorkerTaskId,
        platform: "chatgpt",
        ids: [Number(item.external_account_id)],
        fallback_ids: [],
        phone_lines: `${activation.phone}----${relayUrl}`,
        browser_mode: task.browser_mode,
        concurrency: 1,
        sms_wait_seconds: task.wait_seconds,
      });
    } catch (error) {
      try {
        remote = await this.client.getTask(requestedWorkerTaskId);
      } catch {
        await this.client.cancelTask(requestedWorkerTaskId).catch(() => undefined);
        if (this.itemWasCancelled(itemId)) {
          await this.finishItem(itemId, "cancelled", "任务已取消");
          return;
        }
        throw failure(
          safeError(error, "注册服务未能创建手机号绑定任务", this.secretValues()),
          Number(error?.status) === 409 ? 409 : 502,
          "OPENAI_SMS_WORKER_CREATE_FAILED",
        );
      }
    }
    const returnedWorkerTaskId = remoteTaskId(remote);
    if (returnedWorkerTaskId && returnedWorkerTaskId !== requestedWorkerTaskId) {
      await this.client.cancelTask(returnedWorkerTaskId).catch(() => undefined);
      if (this.itemWasCancelled(itemId)) {
        await this.finishItem(itemId, "cancelled", "任务已取消");
        return;
      }
      throw failure(
        "注册服务返回了不匹配的手机号绑定任务 ID",
        502,
        "OPENAI_SMS_WORKER_TASK_ID_MISMATCH",
      );
    }
    const workerTaskId = requestedWorkerTaskId;
    this.db.prepare(`
      UPDATE openai_sms_task_items
      SET remote_task_id = ?,
        stage = CASE WHEN status = 'running' THEN 'worker_queued' ELSE stage END,
        updated_at = ?
      WHERE id = ?
    `).run(workerTaskId, nowIso(), itemId);
    if (this.closed || this.itemWasCancelled(itemId)) {
      await this.startRemoteCancellation(itemId, workerTaskId);
      return;
    }
    this.addEvent(item.task_id, itemId, "OpenAI 手机号绑定任务已启动");

    let failures = 0;
    while (!this.closed && !this.itemWasCancelled(itemId)) {
      let snapshot;
      try {
        snapshot = await this.client.getTask(workerTaskId);
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= this.remoteFailureLimit) {
          throw failure(
            safeError(error, "注册服务任务状态读取失败", this.secretValues()),
            502,
            "OPENAI_SMS_WORKER_STATUS_FAILED",
          );
        }
        await this.wait(itemId, this.remotePollIntervalMs);
        continue;
      }
      if (this.closed || this.itemWasCancelled(itemId)) {
        await this.startRemoteCancellation(itemId, workerTaskId);
        return;
      }
      const status = remoteStatus(snapshot);
      this.updateItem(itemId, { stage: `worker_${status || "running"}` });
      if (remoteSucceeded(snapshot)) {
        await this.finishItem(itemId, "completed", "");
        return;
      }
      if (REMOTE_FAILURE_STATUSES.has(status)) {
        throw failure(
          redactText(remoteFailureMessage(snapshot), this.secretValues()),
          502,
          "OPENAI_SMS_WORKER_FAILED",
        );
      }
      if (REMOTE_CANCELLED_STATUSES.has(status)) {
        await this.finishItem(itemId, "cancelled", "任务已取消");
        return;
      }
      await this.wait(itemId, this.remotePollIntervalMs);
    }
    await this.startRemoteCancellation(itemId, workerTaskId);
  }

  async claimNumber(itemId, task) {
    const countryId = Number(task.hero_sms_country_id);
    if (!Number.isSafeInteger(countryId) || countryId < 0 || countryId > 999) {
      throw failure("OpenAI 接码国家 ID 无效", 500, "OPENAI_SMS_COUNTRY_INVALID");
    }
    const deadline = this.nowFn() + Number(task.claim_timeout_seconds) * 1_000;
    let attempts = 0;
    let lastError = null;
    while (!this.closed && !this.itemWasCancelled(itemId) && this.nowFn() <= deadline) {
      attempts += 1;
      this.db.prepare(`
        UPDATE openai_sms_task_items
        SET claim_attempts = ?, stage = 'acquiring_number', updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(attempts, nowIso(), itemId);
      try {
        const response = await this.paymentAgreements.heroRequest("getNumberV2", {
          service: HERO_SERVICE,
          country: countryId,
          maxPrice: normalizedPrice(task.max_price),
        });
        const activation = await this.parseActivation(response, task.country, Number(task.max_price), itemId);
        if (activation.price !== null && activation.price > Number(task.max_price) + 0.000001) {
          await this.releaseActivation(itemId, false);
          throw failure("HeroSMS 返回价格超过本任务上限", 409, "OPENAI_SMS_PRICE_EXCEEDED");
        }
        return activation;
      } catch (error) {
        lastError = error;
        if (!new Set(["HEROSMS_NO_NUMBERS", "HEROSMS_MAX_PRICE"]).has(error?.code)) throw error;
        this.updateItem(itemId, { stage: error.code === "HEROSMS_MAX_PRICE" ? "waiting_price" : "waiting_inventory" });
        if (this.nowFn() + Number(task.claim_interval_seconds) * 1_000 > deadline) break;
        await this.wait(itemId, Number(task.claim_interval_seconds) * 1_000);
      }
    }
    if (this.itemWasCancelled(itemId)) throw failure("任务已取消", 409, "OPENAI_SMS_CANCELLED");
    throw failure(
      lastError?.code === "HEROSMS_MAX_PRICE" ? "价格上限内未抢到 OpenAI 号码" : "抢取 OpenAI 号码超时",
      409,
      "OPENAI_SMS_CLAIM_TIMEOUT",
    );
  }

  async persistClaimedActivation(itemId, activationId) {
    const value = String(activationId || "").trim();
    if (!value) return;
    try {
      const encrypted = this.paymentAgreements.encrypt(value);
      const persisted = this.db.prepare(`
        UPDATE openai_sms_task_items
        SET activation_id_encrypted = ?, updated_at = ?
        WHERE id = ? AND activation_id_encrypted = ''
      `).run(encrypted, nowIso(), itemId);
      if (persisted.changes) return;
      const item = this.itemRow(itemId);
      if (item?.activation_id_encrypted
        && this.paymentAgreements.decrypt(item.activation_id_encrypted) === value) return;
      throw failure("HeroSMS 号码无法关联到当前任务", 500, "OPENAI_SMS_ACTIVATION_PERSIST_FAILED");
    } catch (error) {
      let cleanupError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await this.paymentAgreements.setHeroStatus(value, 8);
          cleanupError = null;
          break;
        } catch (releaseError) {
          cleanupError = releaseError;
        }
      }
      if (cleanupError) {
        console.error(
          "OpenAI SMS unpersisted activation cleanup failed:",
          safeError(cleanupError, "HeroSMS 未持久化号码释放失败", [value, ...this.secretValues()]),
        );
      }
      throw error;
    }
  }

  async parseActivation(response, country, maxPrice, itemId) {
    const data = response?.data;
    const text = String(response?.text || "").trim();
    let activationId = "";
    let phone = "";
    let price = null;
    let responseCallingCode = "";
    let responseCountryId = null;
    let structuredResponse = false;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      structuredResponse = true;
      activationId = String(data.activationId || data.activation_id || data.id || "").trim();
      const rawPhone = String(data.phoneNumber || data.phone || "");
      const digits = rawPhone.replace(/\D/g, "");
      responseCallingCode = String(data.countryPhoneCode || "").replace(/\D/g, "");
      const parsedCountryId = Number(data.countryCode ?? data.country_id);
      responseCountryId = Number.isSafeInteger(parsedCountryId) ? parsedCountryId : null;
      phone = `+${responseCallingCode && !digits.startsWith(responseCallingCode) ? responseCallingCode : ""}${digits}`;
      const parsedPrice = Number(data.activationCost ?? data.activation_cost ?? data.price);
      price = Number.isFinite(parsedPrice) ? parsedPrice : null;
    } else if (text.startsWith("ACCESS_NUMBER:")) {
      const parts = text.split(":");
      activationId = String(parts[1] || "").trim();
      phone = `+${String(parts[2] || "").replace(/\D/g, "")}`;
    }
    if (activationId) await this.persistClaimedActivation(itemId, activationId);
    const expectedCountryId = heroCountryId(country);
    if (structuredResponse && responseCountryId !== expectedCountryId) {
      await this.releaseActivation(itemId, false);
      throw failure("HeroSMS 返回的号码国家与所选国家不一致", 502, "OPENAI_SMS_COUNTRY_MISMATCH");
    }
    const digits = phone.replace(/\D/g, "");
    const callingCode = heroCountryInfo(country)?.callingCode || responseCallingCode;
    if (!activationId || !callingCode || digits.length < 7 || digits.length > 15 || !digits.startsWith(callingCode)) {
      await this.releaseActivation(itemId, false);
      throw failure("HeroSMS 未返回所选国家的有效 OpenAI 号码", 502, "OPENAI_SMS_INVALID_NUMBER");
    }
    if (!Number.isFinite(price) || price <= 0) {
      await this.releaseActivation(itemId, false);
      throw failure("HeroSMS getNumberV2 未返回可校验的号码价格", 502, "OPENAI_SMS_PRICE_MISSING");
    }
    if (price !== null && price > maxPrice + 0.000001) {
      return { activationId, phone: `+${digits}`, price };
    }
    return { activationId, phone: `+${digits}`, price };
  }

  relayUrl(token) {
    if (!/^https?:\/\//i.test(this.publicBaseUrl)) {
      throw failure("公开服务地址未配置，无法创建接码中转地址", 503, "OPENAI_SMS_PUBLIC_URL_MISSING");
    }
    return `${this.publicBaseUrl}/api/registration/openai-sms/relay/${encodeURIComponent(token)}`;
  }

  checkRelayRate(hash) {
    const now = this.nowFn();
    const current = this.relayRates.get(hash);
    if (!current || now - current.startedAt >= this.relayRateWindowMs) {
      this.relayRates.set(hash, { startedAt: now, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > this.relayRateLimit) {
      throw failure("接码轮询过于频繁", 429, "OPENAI_SMS_RELAY_RATE_LIMITED");
    }
  }

  async withItemOperation(itemId, operation) {
    const key = Number(itemId);
    const previous = this.itemOperations.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.itemOperations.set(key, current);
    try {
      return await current;
    } finally {
      if (this.itemOperations.get(key) === current) this.itemOperations.delete(key);
    }
  }

  async relay(token, { requestResend = false } = {}) {
    const value = String(token || "");
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(value)) {
      throw failure("接码中转不存在", 404, "OPENAI_SMS_RELAY_NOT_FOUND");
    }
    const hash = crypto.createHash("sha256").update(value).digest("hex");
    const item = this.db.prepare(`
      SELECT * FROM openai_sms_task_items
      WHERE relay_token_hash = ? AND status = 'running'
      LIMIT 1
    `).get(hash);
    if (!item || !item.activation_id_encrypted || item.activation_released_at) {
      throw failure("接码中转不存在", 404, "OPENAI_SMS_RELAY_NOT_FOUND");
    }
    this.checkRelayRate(hash);
    return this.withItemOperation(item.id, async () => {
      let current = this.itemRow(item.id);
      const activeTask = current ? this.taskRow(current.task_id) : null;
      if (!current || current.status !== "running" || current.activation_released_at
        || !activeTask || activeTask.status === "cancel_requested" || TERMINAL_STATUSES.has(activeTask.status)) {
        throw failure("接码任务已结束", 410, "OPENAI_SMS_RELAY_CLOSED");
      }
      const activationId = this.paymentAgreements.decrypt(current.activation_id_encrypted);
      if (!current.relay_started_at) {
        await this.paymentAgreements.setHeroStatus(activationId, 1);
        current = this.itemRow(item.id);
        if (!current || current.status !== "running" || current.activation_released_at) {
          throw failure("接码任务已结束", 410, "OPENAI_SMS_RELAY_CLOSED");
        }
        const at = nowIso();
        const updated = this.db.prepare(`
          UPDATE openai_sms_task_items
          SET relay_started_at = ?, stage = 'waiting_otp', updated_at = ?
          WHERE id = ? AND status = 'running' AND relay_started_at IS NULL
            AND activation_released_at IS NULL
        `).run(at, at, item.id);
        if (updated.changes) this.addEvent(item.task_id, item.id, "OpenAI 已请求发送短信，正在等待验证码");
      } else if (requestResend && current.code_delivered_at && !current.resend_requested_at) {
        await this.paymentAgreements.setHeroStatus(activationId, 3);
        current = this.itemRow(item.id);
        if (!current || current.status !== "running" || current.activation_released_at) {
          throw failure("接码任务已结束", 410, "OPENAI_SMS_RELAY_CLOSED");
        }
        const at = nowIso();
        const updated = this.db.prepare(`
          UPDATE openai_sms_task_items
          SET resend_requested_at = ?, stage = 'waiting_otp', updated_at = ?
          WHERE id = ? AND status = 'running' AND resend_requested_at IS NULL
            AND activation_released_at IS NULL
        `).run(at, at, item.id);
        if (updated.changes) this.addEvent(item.task_id, item.id, "正在等待 OpenAI 重发后的新验证码");
      }
      const status = await this.paymentAgreements.heroStatus(activationId);
      current = this.itemRow(item.id);
      if (!current || current.status !== "running" || current.activation_released_at) {
        throw failure("接码任务已结束", 410, "OPENAI_SMS_RELAY_CLOSED");
      }
      if (status.state !== "received" || !/^\d{6}$/.test(String(status.code || ""))) {
        if (status.state === "cancelled") this.updateItem(item.id, { stage: "activation_cancelled" });
        return { code: "" };
      }
      const codeHash = crypto.createHash("sha256").update(String(status.code)).digest("hex");
      if (current.code_hash === codeHash) return { code: String(status.code) };
      this.db.prepare(`
        UPDATE openai_sms_task_items
        SET code_delivered_at = ?, code_hash = ?, resend_requested_at = NULL,
          stage = 'code_received', updated_at = ?
        WHERE id = ? AND status = 'running' AND activation_released_at IS NULL
      `).run(nowIso(), codeHash, nowIso(), item.id);
      this.addEvent(item.task_id, item.id, "已收到并转交 OpenAI 验证码");
      return { code: String(status.code) };
    });
  }

  async finishItem(itemId, status, error = "") {
    const item = this.itemRow(itemId);
    if (!item || TERMINAL_STATUSES.has(item.status)) return item;
    let normalizedStatus = new Set(["completed", "failed", "cancelled", "interrupted"]).has(status)
      ? status : "failed";
    if (item.status === "cancel_requested" && normalizedStatus !== "interrupted") {
      normalizedStatus = "cancelled";
    }
    const message = normalizedStatus === "completed" ? "" : redactText(error || "OpenAI 自动接码失败", this.secretValues());
    const at = nowIso();
    const updated = this.db.prepare(`
      UPDATE openai_sms_task_items
      SET status = ?, stage = ?, error = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
    `).run(normalizedStatus, normalizedStatus, message, at, at, itemId);
    if (!updated.changes) return this.itemRow(itemId);
    if (item.relay_token_hash) this.relayRates.delete(item.relay_token_hash);
    this.wake(itemId);
    this.addEvent(
      item.task_id,
      itemId,
      normalizedStatus === "completed" ? `账号 ${item.email} 自动接码完成` : message,
      normalizedStatus === "completed" ? "summary" : "error",
      normalizedStatus === "completed" ? "info" : "error",
    );
    this.recomputeTask(item.task_id);
    await this.releaseActivation(itemId, normalizedStatus === "completed");
    return this.itemRow(itemId);
  }

  async releaseActivation(itemId, successful) {
    if (this.releasePromises.has(itemId)) return this.releasePromises.get(itemId);
    const release = this.withItemOperation(itemId, async () => {
      const item = this.itemRow(itemId);
      if (!item?.activation_id_encrypted || item.activation_released_at) return;
      let activationId = "";
      try {
        activationId = this.paymentAgreements.decrypt(item.activation_id_encrypted);
        await this.paymentAgreements.setHeroStatus(activationId, successful ? 6 : 8);
        this.db.prepare(`
          UPDATE openai_sms_task_items
          SET activation_released_at = ?, activation_outcome = ?, cleanup_error = '', updated_at = ?
          WHERE id = ? AND activation_released_at IS NULL
        `).run(nowIso(), successful ? "completed" : "cancelled", nowIso(), itemId);
        this.clearReleaseRetry(itemId);
      } catch (error) {
        const message = safeError(error, "HeroSMS 号码释放失败", [activationId, ...this.secretValues()]);
        this.db.prepare(`
          UPDATE openai_sms_task_items SET cleanup_error = ?, updated_at = ? WHERE id = ?
        `).run(message, nowIso(), itemId);
        this.addEvent(item.task_id, itemId, message, "error", "error");
        this.scheduleReleaseRetry(itemId);
      }
    }).finally(() => this.releasePromises.delete(itemId));
    this.releasePromises.set(itemId, release);
    return release;
  }

  clearReleaseRetry(itemId) {
    const timer = this.releaseRetryTimers.get(itemId);
    if (timer) clearTimeout(timer);
    this.releaseRetryTimers.delete(itemId);
    this.releaseRetryAttempts.delete(itemId);
  }

  scheduleReleaseRetry(itemId) {
    if (this.closed || this.releaseRetryTimers.has(itemId)) return;
    const attempt = (this.releaseRetryAttempts.get(itemId) || 0) + 1;
    this.releaseRetryAttempts.set(itemId, attempt);
    const delay = Math.min(5_000 * (2 ** Math.min(attempt - 1, 6)), 300_000);
    const timer = setTimeout(async () => {
      try {
        this.releaseRetryTimers.delete(itemId);
        if (this.closed) return;
        const item = this.itemRow(itemId);
        if (!item?.activation_id_encrypted || item.activation_released_at) {
          this.clearReleaseRetry(itemId);
          return;
        }
        await this.releaseActivation(itemId, item.status === "completed");
      } catch (error) {
        if (!this.closed) {
          console.error("OpenAI SMS release retry failed:", safeError(error, "cleanup retry failed"));
          this.scheduleReleaseRetry(itemId);
        }
      }
    }, delay);
    timer.unref?.();
    this.releaseRetryTimers.set(itemId, timer);
  }

  startRemoteCancellation(itemId, remoteId = "") {
    if (this.cancelTrackers.has(itemId)) return this.cancelTrackers.get(itemId);
    const cancellation = (async () => {
      let attempts = 0;
      while (true) {
        const item = this.itemRow(itemId);
        if (!item || TERMINAL_STATUSES.has(item.status)) return item;
        const workerTaskId = String(remoteId || item.remote_task_id || "").trim();
        if (!workerTaskId) return this.finishItem(itemId, "cancelled", "任务已取消");
        attempts += 1;
        try {
          await this.client.cancelTask(workerTaskId);
          return this.finishItem(itemId, "cancelled", "任务已取消");
        } catch (error) {
          const message = safeError(error, "注册服务任务取消失败", this.secretValues());
          this.updateItem(itemId, { stage: "worker_cancel_retry" });
          if (attempts === 1 || attempts % 10 === 0) {
            this.addEvent(item.task_id, itemId, `${message}；正在重试`, "error", "warning");
          }
          if (this.closed) return this.itemRow(itemId);
          await this.wait(itemId, Math.min(this.remotePollIntervalMs * Math.max(attempts, 1), 30_000));
        }
      }
    })().catch((error) => {
      const item = this.itemRow(itemId);
      if (item && !TERMINAL_STATUSES.has(item.status)) {
        this.addEvent(
          item.task_id,
          itemId,
          safeError(error, "注册服务任务取消失败", this.secretValues()),
          "error",
          "error",
        );
      }
      return this.itemRow(itemId);
    }).finally(() => this.cancelTrackers.delete(itemId));
    this.cancelTrackers.set(itemId, cancellation);
    return cancellation;
  }

  async cancel(taskId) {
    await this.recoveryPromise;
    const task = this.taskRow(taskId);
    if (!task) throw failure("OpenAI 自动接码任务不存在", 404, "OPENAI_SMS_TASK_NOT_FOUND");
    if (TERMINAL_STATUSES.has(task.status)) return this.publicTask(taskId);
    const previousItems = this.items(taskId);
    const at = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE openai_sms_tasks SET status = 'cancel_requested', stage = 'cancel_requested', updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running', 'cancel_requested')
      `).run(at, taskId);
      this.db.prepare(`
        UPDATE openai_sms_task_items SET status = 'cancel_requested', stage = 'cancel_requested', updated_at = ?
        WHERE task_id = ? AND status IN ('queued', 'running', 'cancel_requested')
      `).run(at, taskId);
    })();
    this.addEvent(taskId, null, "已请求取消 OpenAI 自动接码任务", "summary", "warning");
    const items = this.items(taskId).filter((item) => item.status === "cancel_requested");
    items.forEach((item) => this.wake(item.id));
    await Promise.allSettled(items.map((item) => this.releaseActivation(item.id, false)));
    const queuedIds = new Set(previousItems.filter((item) => item.status === "queued").map((item) => item.id));
    await Promise.allSettled(items
      .filter((item) => queuedIds.has(item.id))
      .map((item) => this.finishItem(item.id, "cancelled", "任务已取消")));
    const previousById = new Map(previousItems.map((item) => [item.id, item]));
    items
      .filter((item) => !queuedIds.has(item.id) && item.remote_task_id
        && previousById.get(item.id)?.stage !== "starting_worker")
      .forEach((item) => { this.startRemoteCancellation(item.id, item.remote_task_id); });
    this.recomputeTask(taskId);
    return this.publicTask(taskId);
  }

  async getTask(taskId, { refresh = true } = {}) {
    await this.recoveryPromise;
    const task = this.taskRow(taskId);
    if (!task) throw failure("OpenAI 自动接码任务不存在", 404, "OPENAI_SMS_TASK_NOT_FOUND");
    if (refresh && !TERMINAL_STATUSES.has(task.status)) {
      const remoteItems = this.items(taskId)
        .filter((item) => item.remote_task_id && ACTIVE_STATUSES.has(item.status));
      await Promise.allSettled(remoteItems.map((item) => this.refreshRemoteItem(item)));
      this.recomputeTask(taskId);
    }
    return this.publicTask(taskId);
  }

  list({ limit = 50 } = {}) {
    const normalizedLimit = boundedNumber(limit, 50, 1, 200, "任务数量", true);
    return {
      items: this.db.prepare(`
        SELECT id FROM openai_sms_tasks ORDER BY created_at DESC LIMIT ?
      `).all(normalizedLimit).map((row) => this.publicTask(row.id)),
    };
  }

  async refreshRemoteItem(item) {
    let snapshot;
    try {
      snapshot = await this.client.getTask(item.remote_task_id);
    } catch {
      return;
    }
    const status = remoteStatus(snapshot);
    if (remoteSucceeded(snapshot)) {
      await this.finishItem(item.id, "completed", "");
    } else if (REMOTE_FAILURE_STATUSES.has(status)) {
      await this.finishItem(item.id, "failed", remoteFailureMessage(snapshot));
    } else if (REMOTE_CANCELLED_STATUSES.has(status)) {
      await this.finishItem(item.id, "cancelled", "任务已取消");
    } else {
      this.updateItem(item.id, { stage: `worker_${status || "running"}` });
    }
  }

  async events(taskId, { since = 0, limit = 300 } = {}) {
    await this.recoveryPromise;
    if (!this.taskRow(taskId)) throw failure("OpenAI 自动接码任务不存在", 404, "OPENAI_SMS_TASK_NOT_FOUND");
    const remoteItems = this.items(taskId).filter((item) => item.remote_task_id);
    await Promise.allSettled(remoteItems.map((item) => this.syncRemoteEvents(item)));
    const normalizedSince = boundedNumber(since, 0, 0, Number.MAX_SAFE_INTEGER, "事件游标", true);
    const normalizedLimit = boundedNumber(limit, 300, 1, 500, "事件数量", true);
    const rows = this.db.prepare(`
      SELECT events.*, items.external_account_id, items.email
      FROM openai_sms_events AS events
      LEFT JOIN openai_sms_task_items AS items ON items.id = events.item_id
      WHERE events.task_id = ? AND events.id > ?
      ORDER BY events.id ASC
      LIMIT ?
    `).all(taskId, normalizedSince, normalizedLimit);
    return {
      items: rows.map((row) => ({
        id: row.id,
        item_id: row.item_id,
        account_id: row.external_account_id ? Number(row.external_account_id) : null,
        email: row.email || "",
        type: row.event_type,
        level: row.level,
        message: redactText(row.message, this.secretValues()),
        created_at: row.created_at,
      })),
    };
  }

  async syncRemoteEvents(item) {
    let response;
    try {
      response = await this.client.getTaskEvents(item.remote_task_id, item.remote_event_cursor || 0);
    } catch {
      return;
    }
    const events = Array.isArray(response?.items) ? response.items : [];
    let cursor = Number(item.remote_event_cursor) || 0;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO openai_sms_events (
        task_id, item_id, source_event_id, event_type, level, message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      events.forEach((event, index) => {
        const sourceId = String(event?.id ?? `${cursor + index + 1}`);
        const numericId = Number(event?.id);
        if (Number.isSafeInteger(numericId) && numericId > cursor) cursor = numericId;
        insert.run(
          item.task_id,
          item.id,
          sourceId,
          String(event?.type || "log").slice(0, 40),
          String(event?.level || "info").slice(0, 20),
          redactText(event?.message || event?.detail || "", this.secretValues()),
          String(event?.created_at || event?.timestamp || nowIso()),
        );
      });
      this.db.prepare(`
        UPDATE openai_sms_task_items SET remote_event_cursor = ?, updated_at = ? WHERE id = ?
      `).run(cursor, nowIso(), item.id);
    })();
  }

  secretValues() {
    try {
      return [this.apiKey()];
    } catch {
      return [];
    }
  }

  publicTask(taskId) {
    const task = this.taskRow(taskId);
    if (!task) return null;
    const items = this.items(taskId);
    const counts = {
      queued: items.filter((item) => item.status === "queued").length,
      running: items.filter((item) => item.status === "running").length,
      cancel_requested: items.filter((item) => item.status === "cancel_requested").length,
      completed: items.filter((item) => item.status === "completed").length,
      failed: items.filter((item) => item.status === "failed").length,
      cancelled: items.filter((item) => item.status === "cancelled").length,
      interrupted: items.filter((item) => item.status === "interrupted").length,
    };
    const terminal = TERMINAL_STATUSES.has(task.status);
    const publicItems = items.map((item) => ({
      id: item.id,
      account_id: Number(item.external_account_id),
      email: item.email,
      remote_task_id: item.remote_task_id,
      status: item.status,
      stage: item.stage,
      terminal: TERMINAL_STATUSES.has(item.status),
      phone: item.phone_mask,
      price: item.price,
      claim_attempts: item.claim_attempts,
      error: redactText(item.error, this.secretValues()),
      cleanup_error: redactText(item.cleanup_error, this.secretValues()),
      created_at: item.created_at,
      updated_at: item.updated_at,
      finished_at: item.finished_at,
    }));
    return {
      id: task.id,
      task_id: task.id,
      type: "openai_sms",
      status: task.status,
      stage: task.stage,
      terminal,
      cancellable: !terminal,
      progress_current: task.progress_current,
      progress_total: task.progress_total,
      progress: task.progress_total ? Math.floor((task.progress_current / task.progress_total) * 100) : 0,
      progress_detail: counts,
      country: task.country,
      hero_sms_country_id: task.hero_sms_country_id,
      service: "OpenAI",
      service_code: HERO_SERVICE,
      max_price: task.max_price,
      claim_timeout_seconds: task.claim_timeout_seconds,
      claim_interval_seconds: task.claim_interval_seconds,
      wait_seconds: task.wait_seconds,
      concurrency: task.concurrency,
      browser_mode: task.browser_mode,
      success_count: task.success_count,
      failure_count: task.failure_count,
      cancelled_count: task.cancelled_count,
      error: redactText(task.error, this.secretValues()),
      items: publicItems,
      result: terminal ? {
        total: items.length,
        success_count: counts.completed,
        failure_count: counts.failed + counts.interrupted,
        cancelled_count: counts.cancelled,
        items: publicItems,
      } : null,
      created_at: task.created_at,
      updated_at: task.updated_at,
      finished_at: task.finished_at,
    };
  }

  recomputeTask(taskId) {
    const task = this.taskRow(taskId);
    if (!task) return;
    const items = this.items(taskId);
    const successCount = items.filter((item) => item.status === "completed").length;
    const failureCount = items.filter((item) => new Set(["failed", "interrupted"]).has(item.status)).length;
    const cancelledCount = items.filter((item) => item.status === "cancelled").length;
    const progressCurrent = successCount + failureCount + cancelledCount;
    let status = task.status;
    let stage = task.stage;
    let finishedAt = null;
    if (progressCurrent >= items.length && items.length) {
      if (task.status === "interrupted") {
        status = "interrupted";
      } else if (task.status === "cancel_requested" || (cancelledCount && successCount === 0 && failureCount === 0)) {
        status = "cancelled";
      } else if (failureCount || cancelledCount) {
        status = "failed";
      } else {
        status = "completed";
      }
      stage = status;
      finishedAt = nowIso();
    } else if (task.status !== "cancel_requested" && !TERMINAL_STATUSES.has(task.status)) {
      status = "running";
      stage = "running";
    }
    const error = failureCount
      ? String(items.find((item) => item.status === "failed" || item.status === "interrupted")?.error || "")
      : "";
    this.db.prepare(`
      UPDATE openai_sms_tasks
      SET status = ?, stage = ?, progress_current = ?, success_count = ?, failure_count = ?,
        cancelled_count = ?, error = ?, finished_at = COALESCE(?, finished_at), updated_at = ?
      WHERE id = ?
    `).run(
      status,
      stage,
      progressCurrent,
      successCount,
      failureCount,
      cancelledCount,
      error,
      finishedAt,
      nowIso(),
      taskId,
    );
  }

  addEvent(taskId, itemId, message, eventType = "log", level = "info") {
    this.db.prepare(`
      INSERT INTO openai_sms_events (task_id, item_id, event_type, level, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskId, itemId || null, eventType, level, redactText(message, this.secretValues()), nowIso());
  }

  taskRow(taskId) {
    return this.db.prepare("SELECT * FROM openai_sms_tasks WHERE id = ?").get(String(taskId || "")) || null;
  }

  itemRow(itemId) {
    return this.db.prepare("SELECT * FROM openai_sms_task_items WHERE id = ?").get(Number(itemId)) || null;
  }

  items(taskId) {
    return this.db.prepare(`
      SELECT * FROM openai_sms_task_items WHERE task_id = ? ORDER BY id ASC
    `).all(String(taskId || ""));
  }

  updateItem(itemId, fields = {}) {
    const allowed = new Set(["status", "stage"]);
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    this.db.prepare(`
      UPDATE openai_sms_task_items SET ${assignments}, updated_at = ? WHERE id = ?
    `).run(...entries.map(([, value]) => value), nowIso(), itemId);
  }

  itemWasCancelled(itemId) {
    const item = this.itemRow(itemId);
    if (!item || item.status === "cancel_requested" || item.status === "cancelled") return true;
    const task = this.taskRow(item.task_id);
    return !task || task.status === "cancel_requested" || task.status === "cancelled";
  }

  async wait(itemId, milliseconds) {
    let wake;
    const interrupted = new Promise((resolve) => { wake = resolve; });
    this.wakes.set(itemId, wake);
    try {
      await Promise.race([this.sleepFn(milliseconds), interrupted]);
    } finally {
      if (this.wakes.get(itemId) === wake) this.wakes.delete(itemId);
    }
  }

  wake(itemId) {
    this.wakes.get(itemId)?.();
    this.wakes.delete(itemId);
  }

  async waitForTask(taskId) {
    const tracker = this.trackers.get(String(taskId || ""));
    if (tracker) await tracker;
    return this.publicTask(taskId);
  }

  async recoverInterruptedTasks() {
    const tasks = this.db.prepare(`
      SELECT id FROM openai_sms_tasks WHERE status IN ('queued', 'running', 'cancel_requested')
    `).all();
    for (const task of tasks) {
      const items = this.items(task.id).filter((item) => ACTIVE_STATUSES.has(item.status));
      const at = nowIso();
      this.db.transaction(() => {
        this.db.prepare(`
          UPDATE openai_sms_tasks
          SET status = 'interrupted', stage = 'interrupted', error = '服务重启，任务已中断并释放号码',
            finished_at = ?, updated_at = ? WHERE id = ?
        `).run(at, at, task.id);
        this.db.prepare(`
          UPDATE openai_sms_task_items
          SET status = 'interrupted', stage = 'interrupted', error = '服务重启，任务已中断',
            finished_at = ?, updated_at = ?
          WHERE task_id = ? AND status IN ('queued', 'running', 'cancel_requested')
        `).run(at, at, task.id);
      })();
      await Promise.allSettled(items.map(async (item) => {
        if (item.remote_task_id) await this.client.cancelTask(item.remote_task_id).catch(() => undefined);
        await this.releaseActivation(item.id, false);
      }));
      this.recomputeTask(task.id);
    }
    await this.retryPendingReleases();
  }

  async retryPendingReleases() {
    const pending = this.db.prepare(`
      SELECT id, status FROM openai_sms_task_items
      WHERE activation_id_encrypted <> '' AND activation_released_at IS NULL
    `).all();
    await Promise.allSettled(pending.map((item) => (
      this.releaseActivation(item.id, item.status === "completed")
    )));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.releaseRetryTimers.forEach((timer) => clearTimeout(timer));
    this.releaseRetryTimers.clear();
    this.releaseRetryAttempts.clear();
    const activeTasks = this.db.prepare(`
      SELECT id FROM openai_sms_tasks WHERE status IN ('queued', 'running', 'cancel_requested')
    `).all();
    await Promise.allSettled(activeTasks.map((task) => this.cancel(task.id)));
    this.wakes.forEach((wake) => wake());
    this.wakes.clear();
    await Promise.allSettled([...this.trackers.values()]);
    await Promise.allSettled([...this.cancelTrackers.values()]);
    await this.retryPendingReleases();
    await Promise.allSettled([...this.itemOperations.values()]);
  }
}
