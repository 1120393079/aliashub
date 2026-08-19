import crypto from "node:crypto";
import { getSetting, setSetting } from "./db.js";
import { parsePaymentProxyPool } from "./payment-link-service.js";
import { maskProxy } from "./registration-proxy.js";

const HERO_SMS_ENDPOINT = "https://hero-sms.com/stubs/handler_api.php";
const HERO_SMS_SERVICE = "ts";
const DEFAULT_PROTOCOL_BASE_URL = "http://127.0.0.1:18083/paypal-pay";
const DEFAULT_CONTEXT_RETENTION_MS = 10 * 60_000;

const API_KEY_SETTING = "payment_agreement_herosms_api_key_encrypted";
const MAX_PRICE_SETTING = "payment_agreement_herosms_max_price";
const CHANGE_RETRIES_SETTING = "payment_agreement_herosms_change_retries";
const WAIT_SECONDS_SETTING = "payment_agreement_herosms_wait_seconds";
const RUNTIME_COUNTRY_SETTING = "payment_agreement_country";
const RUNTIME_PROXY_POOL_SETTING = "payment_agreement_proxy_pool";

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "user-agent",
]);
const FORWARDED_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-security-policy",
  "content-disposition",
  "content-type",
  "etag",
  "last-modified",
  "location",
]);

export const PAYMENT_AGREEMENT_HERO_COUNTRIES = Object.freeze({
  AE: Object.freeze({ id: 95, name: "United Arab Emirates", callingCode: "971" }),
  AU: Object.freeze({ id: 175, name: "Australia", callingCode: "61" }),
  BR: Object.freeze({ id: 73, name: "Brazil", callingCode: "55" }),
  CA: Object.freeze({ id: 36, name: "Canada", callingCode: "1" }),
  DE: Object.freeze({ id: 43, name: "Germany", callingCode: "49" }),
  GB: Object.freeze({ id: 16, name: "United Kingdom", callingCode: "44" }),
  ID: Object.freeze({ id: 6, name: "Indonesia", callingCode: "62" }),
  JP: Object.freeze({ id: 182, name: "Japan", callingCode: "81" }),
  MX: Object.freeze({ id: 54, name: "Mexico", callingCode: "52" }),
  PH: Object.freeze({ id: 4, name: "Philippines", callingCode: "63" }),
  TH: Object.freeze({ id: 52, name: "Thailand", callingCode: "66" }),
  TR: Object.freeze({ id: 62, name: "Turkey", callingCode: "90" }),
  TW: Object.freeze({ id: 55, name: "Taiwan", callingCode: "886" }),
  US: Object.freeze({ id: 187, name: "United States", callingCode: "1" }),
});

function failure(message, status = 500, code = "PAYMENT_AGREEMENT_ERROR") {
  return Object.assign(new Error(message), { status, code });
}

function firstDefined(input, keys) {
  for (const key of keys) {
    if (Object.hasOwn(input || {}, key)) return input[key];
  }
  return undefined;
}

function boundedNumber(value, fallback, minimum, maximum, label, integer = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum || (integer && !Number.isInteger(parsed))) {
    throw failure(`${label}参数无效`, 400, "PAYMENT_AGREEMENT_SETTINGS_INVALID");
  }
  return parsed;
}

function normalizedCountry(value) {
  const country = String(value || "").trim().toUpperCase();
  if (!Object.hasOwn(PAYMENT_AGREEMENT_HERO_COUNTRIES, country)) {
    throw failure(
      `协议支付国家仅支持 ${Object.keys(PAYMENT_AGREEMENT_HERO_COUNTRIES).join("、")}`,
      400,
      "PAYMENT_AGREEMENT_COUNTRY_UNSUPPORTED",
    );
  }
  return country;
}

function paymentLinkBaToken(input = {}) {
  const source = String(
    firstDefined(input, ["paypal_url", "provider_url", "ba_token", "baToken", "paypalUrl"]) || "",
  );
  return source.match(/\b(BA-[A-Za-z0-9]{8,80})\b/i)?.[1] || "";
}

function normalizedBaseUrl(value) {
  const source = String(value || DEFAULT_PROTOCOL_BASE_URL).trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw failure("PayPal 协议服务地址无效", 500, "PAYMENT_AGREEMENT_URL_INVALID");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw failure("PayPal 协议服务地址无效", 500, "PAYMENT_AGREEMENT_URL_INVALID");
  }
  return source;
}

function requestHeaders(input) {
  const source = input?.headers || {};
  const headers = {};
  if (typeof source.forEach === "function") {
    source.forEach((value, key) => { headers[String(key).toLowerCase()] = String(value); });
  } else {
    Object.entries(source).forEach(([key, value]) => {
      if (value !== undefined && value !== null) headers[String(key).toLowerCase()] = String(value);
    });
  }
  return headers;
}

function paypalDeviceId(cookieHeader) {
  const match = String(cookieHeader || "").match(/(?:^|;\s*)paypal_web_device_id=([a-f0-9]{32})(?:;|$)/i);
  return match ? match[1].toLowerCase() : "";
}

function deviceCookie(deviceId) {
  return `paypal_web_device_id=${deviceId}`;
}

function publicDeviceCookie(deviceId) {
  return `${deviceCookie(deviceId)}; Path=/alias-hub/paypal-pay/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
}

function normalizeBody(input, headers) {
  const body = input?.body;
  if (body === undefined || body === null || input?.method === "GET" || input?.method === "HEAD") return undefined;
  if (Buffer.isBuffer(body) || typeof body === "string" || body instanceof Uint8Array) return body;
  if (!headers["content-type"]) headers["content-type"] = "application/json";
  return JSON.stringify(body);
}

function parseInputJson(input) {
  if (input?.body && typeof input.body === "object" && !Buffer.isBuffer(input.body) && !(input.body instanceof Uint8Array)) {
    return input.body;
  }
  const source = Buffer.isBuffer(input?.body) || input?.body instanceof Uint8Array
    ? Buffer.from(input.body).toString("utf8")
    : String(input?.body || "");
  try {
    return source ? JSON.parse(source) : {};
  } catch {
    throw failure("请求 JSON 格式无效", 400, "PAYMENT_AGREEMENT_JSON_INVALID");
  }
}

function pathAndQuery(value) {
  const source = String(value || "/");
  try {
    const parsed = new URL(source, "http://aliashub.local");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return source.startsWith("/") ? source : `/${source}`;
  }
}

function inputPath(input) {
  return pathAndQuery(
    input?.upstreamPath
      ?? input?.originalUrl
      ?? input?.url
      ?? input?.path
      ?? input?.params?.path
      ?? input?.params?.[0]
      ?? "/",
  );
}

function normalizeWorkbenchPath(input) {
  let source = inputPath(input);
  source = source.replace(/^\/alias-hub\/paypal-pay(?=\/|\?|$)/, "");
  source = source.replace(/^\/paypal-pay(?=\/|\?|$)/, "");
  return source && source !== "?" ? (source.startsWith("/") ? source : `/${source}`) : "/";
}

function normalizeApiPath(input) {
  let source = inputPath(input);
  const prefixes = [
    "/api/registration/paypal-agreement/proxy",
    "/api/registration/payment-agreement/proxy",
    "/api/registration/paypal-agreement",
    "/api/registration/payment-agreement",
    "/alias-hub/paypal-pay",
    "/paypal-pay",
  ];
  for (const prefix of prefixes) {
    if (source === prefix || source.startsWith(`${prefix}/`) || source.startsWith(`${prefix}?`)) {
      source = source.slice(prefix.length) || "/";
      break;
    }
  }
  if (!source.startsWith("/")) source = `/${source}`;
  if (!source.startsWith("/api/") && source !== "/api") source = `/api${source === "/" ? "" : source}`;
  return source;
}

function jobIdFromPath(pathname) {
  const path = String(pathname || "").split("?", 1)[0];
  return path.match(/^\/api\/jobs\/([^/]+)/)?.[1] || "";
}

function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

function responseHeaders(response) {
  const headers = {};
  response.headers?.forEach?.((value, key) => {
    if (FORWARDED_RESPONSE_HEADERS.has(String(key).toLowerCase())) headers[String(key).toLowerCase()] = value;
  });
  const setCookies = response.headers?.getSetCookie?.() || [];
  if (setCookies.length) headers["set-cookie"] = setCookies;
  else if (response.headers?.get?.("set-cookie")) headers["set-cookie"] = response.headers.get("set-cookie");
  return headers;
}

function errorMessage(data, fallback) {
  if (data && typeof data === "object") {
    const detail = data.detail && typeof data.detail === "object" ? data.detail.message || data.detail.error : data.detail;
    return String(data.error || data.message || detail || fallback);
  }
  return String(data || fallback);
}

function jsonProxyResponse(data, status = 200, headers = {}) {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
    body: Buffer.from(JSON.stringify(data)),
  };
}

function isTextResponse(contentType, path) {
  const type = String(contentType || "").toLowerCase();
  return type.startsWith("text/")
    || type.includes("javascript")
    || type.includes("json")
    || /\.(?:css|html?|js)(?:\?|$)/i.test(path);
}

function sameOriginCsp(value) {
  const source = String(value || "").trim();
  if (!source) return "frame-ancestors 'self'";
  if (/frame-ancestors\s+[^;]+/i.test(source)) {
    return source.replace(/frame-ancestors\s+[^;]+/i, "frame-ancestors 'self'");
  }
  return `${source.replace(/;+$/, "")}; frame-ancestors 'self'`;
}

function embeddedWorkbenchStyle(path, contentType) {
  if (!String(contentType || "").toLowerCase().includes("text/html")) return "";
  try {
    const query = new URL(path, "http://aliashub.local").searchParams;
    if (query.get("embedded") !== "1") return "";
  } catch {
    return "";
  }
  return `<style id="aliashub-embedded-workbench">
    body > .topbar, body > footer { display: none !important; }
    body > .shell { padding-top: 18px !important; padding-bottom: 32px !important; }
    @media (max-width: 780px) { body > .shell { padding: 14px !important; } }
  </style>`;
}

function sleep(context, milliseconds) {
  return new Promise((resolve) => {
    const finish = () => {
      if (context.wake === finish) context.wake = null;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    context.wake = finish;
  });
}

export class PaymentAgreementService {
  constructor({
    db,
    encryptionKey,
    baseUrl = DEFAULT_PROTOCOL_BASE_URL,
    heroSmsEndpoint = HERO_SMS_ENDPOINT,
    fetchFn = globalThis.fetch,
    pollIntervalMs = 3_000,
    requestTimeoutMs = 30_000,
    contextRetentionMs = DEFAULT_CONTEXT_RETENTION_MS,
    cancelRetryLimit = 20,
  } = {}) {
    if (!db) throw new TypeError("PaymentAgreementService requires db");
    if (typeof fetchFn !== "function") throw new TypeError("PaymentAgreementService requires fetch");
    this.db = db;
    this.baseUrl = normalizedBaseUrl(baseUrl);
    this.heroSmsEndpoint = String(heroSmsEndpoint || HERO_SMS_ENDPOINT);
    this.fetchFn = fetchFn;
    this.pollIntervalMs = Math.max(10, Number(pollIntervalMs) || 3_000);
    this.requestTimeoutMs = Math.max(1_000, Number(requestTimeoutMs) || 30_000);
    this.contextRetentionMs = Math.max(10, Number(contextRetentionMs) || DEFAULT_CONTEXT_RETENTION_MS);
    this.cancelRetryLimit = Math.max(3, Math.min(100, Number(cancelRetryLimit) || 20));
    this.encryptionKey = String(encryptionKey || "").trim()
      ? crypto.createHash("sha256").update(String(encryptionKey)).digest()
      : null;
    this.contexts = new Map();
    this.trackers = new Map();
    this.closed = false;
  }

  get encryptionReady() {
    return Boolean(this.encryptionKey);
  }

  encrypt(value) {
    if (!this.encryptionKey) {
      throw failure(
        "保存 HeroSMS API Key 前必须配置 DATA_ENCRYPTION_KEY",
        409,
        "PAYMENT_AGREEMENT_ENCRYPTION_REQUIRED",
      );
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  decrypt(value) {
    if (!this.encryptionKey) {
      throw failure("服务器无法解密 HeroSMS API Key", 500, "PAYMENT_AGREEMENT_DECRYPT_FAILED");
    }
    const [version, iv, tag, encrypted] = String(value || "").split(".");
    if (version !== "v1" || !iv || !tag || !encrypted) {
      throw failure("HeroSMS API Key 加密数据无效", 500, "PAYMENT_AGREEMENT_DECRYPT_FAILED");
    }
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch (error) {
      throw failure("HeroSMS API Key 解密失败", 500, "PAYMENT_AGREEMENT_DECRYPT_FAILED", { cause: error });
    }
  }

  heroSmsApiKey({ required = false } = {}) {
    const encrypted = getSetting(this.db, API_KEY_SETTING, "");
    const apiKey = encrypted ? this.decrypt(encrypted).trim() : "";
    if (required && !apiKey) {
      throw failure("HeroSMS API Key 未配置", 422, "HEROSMS_API_KEY_MISSING");
    }
    return apiKey;
  }

  countries() {
    return Object.entries(PAYMENT_AGREEMENT_HERO_COUNTRIES).map(([code, item]) => ({
      code,
      hero_sms_country_id: item.id,
      name: item.name,
      calling_code: `+${item.callingCode}`,
    }));
  }

  runtime({ required = false } = {}) {
    const storedCountry = String(getSetting(this.db, RUNTIME_COUNTRY_SETTING, "")).trim();
    const country = storedCountry ? normalizedCountry(storedCountry) : "";
    const proxies = parsePaymentProxyPool(getSetting(this.db, RUNTIME_PROXY_POOL_SETTING, "[]"));
    if (required && !country) {
      throw failure("请先配置协议国家", 422, "PAYMENT_AGREEMENT_RUNTIME_COUNTRY_MISSING");
    }
    if (required && !proxies.length) {
      throw failure("请先配置协议代理池", 422, "PAYMENT_AGREEMENT_RUNTIME_PROXY_POOL_MISSING");
    }
    return {
      configured: Boolean(country && proxies.length),
      country,
      proxy_count: proxies.length,
      proxies,
      masked_proxies: proxies.map(maskProxy),
      countries: this.countries(),
    };
  }

  updateRuntime(input = {}) {
    const country = normalizedCountry(input.country);
    const proxies = parsePaymentProxyPool(input.proxies);
    if (!proxies.length) {
      throw failure("协议代理池不能为空", 422, "PAYMENT_AGREEMENT_RUNTIME_PROXY_POOL_EMPTY");
    }
    this.db.transaction(() => {
      setSetting(this.db, RUNTIME_COUNTRY_SETTING, country);
      setSetting(this.db, RUNTIME_PROXY_POOL_SETTING, JSON.stringify(proxies));
    })();
    return this.runtime();
  }

  settings() {
    let apiKeyConfigured = false;
    let apiKeyError = "";
    try {
      apiKeyConfigured = Boolean(this.heroSmsApiKey());
    } catch (error) {
      apiKeyError = error.message;
    }
    return {
      configured: apiKeyConfigured && this.encryptionReady,
      protocol_configured: Boolean(this.baseUrl),
      service_url: this.baseUrl,
      service: "PayPal",
      service_code: HERO_SMS_SERVICE,
      encryption_ready: this.encryptionReady,
      api_key_configured: apiKeyConfigured,
      api_key_error: apiKeyError,
      max_price: boundedNumber(
        getSetting(this.db, MAX_PRICE_SETTING, "1"), 1, 0.0001, 100, "HeroSMS 最高价格",
      ),
      change_retries: boundedNumber(
        getSetting(this.db, CHANGE_RETRIES_SETTING, "2"), 2, 0, 10, "HeroSMS 换号次数", true,
      ),
      wait_seconds: boundedNumber(
        getSetting(this.db, WAIT_SECONDS_SETTING, "120"), 120, 30, 1_800, "HeroSMS 等码时间", true,
      ),
      countries: this.countries(),
      active_jobs: [...this.contexts.values()].filter((item) => !item.terminal && !item.stopped).length,
    };
  }

  updateSettings(input = {}) {
    const apiKey = firstDefined(input, ["apiKey", "api_key", "heroSmsApiKey", "herosms_api_key"]);
    const clearApiKey = firstDefined(input, ["clearApiKey", "clear_api_key"]);
    if (clearApiKey !== undefined && typeof clearApiKey !== "boolean") {
      throw failure("clear_api_key 必须是布尔值", 400, "PAYMENT_AGREEMENT_SETTINGS_INVALID");
    }
    if (clearApiKey) setSetting(this.db, API_KEY_SETTING, "");
    if (apiKey !== undefined && String(apiKey).trim()) {
      setSetting(this.db, API_KEY_SETTING, this.encrypt(String(apiKey).trim()));
    }

    const current = this.settings();
    const maxPrice = boundedNumber(
      firstDefined(input, ["maxPrice", "max_price"]),
      current.max_price, 0.0001, 100, "HeroSMS 最高价格",
    );
    const changeRetries = boundedNumber(
      firstDefined(input, ["changeRetries", "change_retries", "change_number_retries"]),
      current.change_retries, 0, 10, "HeroSMS 换号次数", true,
    );
    const waitSeconds = boundedNumber(
      firstDefined(input, ["waitSeconds", "wait_seconds", "number_wait_seconds"]),
      current.wait_seconds, 30, 1_800, "HeroSMS 等码时间", true,
    );
    setSetting(this.db, MAX_PRICE_SETTING, maxPrice);
    setSetting(this.db, CHANGE_RETRIES_SETTING, changeRetries);
    setSetting(this.db, WAIT_SECONDS_SETTING, waitSeconds);
    return this.settings();
  }

  async fetchWithTimeout(url, options = {}, timeoutMs = this.requestTimeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      return await this.fetchFn(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw failure("支付协议服务请求超时", 504, "PAYMENT_AGREEMENT_TIMEOUT");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async heroRequest(action, params = {}) {
    const apiKey = this.heroSmsApiKey({ required: true });
    const url = new URL(this.heroSmsEndpoint);
    Object.entries({ api_key: apiKey, action, ...params }).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    });
    let response;
    try {
      response = await this.fetchWithTimeout(url, { headers: { Accept: "application/json,text/plain" } }, 20_000);
    } catch (error) {
      if (error?.code === "PAYMENT_AGREEMENT_TIMEOUT") throw error;
      throw failure("HeroSMS 网络请求失败", 502, "HEROSMS_NETWORK_ERROR");
    }
    const text = (await response.text()).trim();
    let data = null;
    try { data = JSON.parse(text); } catch { /* HeroSMS also returns colon-delimited text. */ }
    if (!response.ok) {
      throw failure("HeroSMS 请求失败", 502, "HEROSMS_HTTP_ERROR");
    }
    const business = this.heroBusinessError(text, data);
    if (business) throw business;
    return { text, data };
  }

  heroBusinessError(text, data) {
    const marker = String(
      (data && typeof data === "object" && (data.error || data.code || data.message)) || text || "",
    ).toUpperCase();
    const known = [
      ["BAD_KEY", "HeroSMS API Key 无效", 401, "HEROSMS_BAD_KEY"],
      ["NO_BALANCE", "HeroSMS 余额不足", 409, "HEROSMS_NO_BALANCE"],
      ["NO_NUMBERS", "HeroSMS 暂无对应国家的 PayPal 号码", 409, "HEROSMS_NO_NUMBERS"],
      ["BAD_SERVICE", "HeroSMS 不支持 PayPal 服务", 502, "HEROSMS_BAD_SERVICE"],
      ["BAD_COUNTRY", "HeroSMS 不支持所选国家", 409, "HEROSMS_BAD_COUNTRY"],
      ["MAX_PRICE", "HeroSMS 号码价格超过最高价格", 409, "HEROSMS_MAX_PRICE"],
    ];
    const found = known.find(([item]) => marker.includes(item));
    if (found) return failure(found[1], found[2], found[3]);
    if (/^(?:ERROR|BAD_|NO_)/.test(marker)) return failure("HeroSMS 请求失败", 502, "HEROSMS_API_ERROR");
    return null;
  }

  async heroBalance() {
    const { text, data } = await this.heroRequest("getBalance");
    const source = data && typeof data === "object" ? data.balance : text.startsWith("ACCESS_BALANCE:") ? text.slice(15) : "";
    const balance = Number(source);
    if (!Number.isFinite(balance)) throw failure("HeroSMS 返回了无效余额", 502, "HEROSMS_INVALID_BALANCE");
    return { ok: true, service: "PayPal", service_code: HERO_SMS_SERVICE, balance };
  }

  async acquireHeroNumber(country, settings = this.settings()) {
    const code = normalizedCountry(country);
    const countryInfo = PAYMENT_AGREEMENT_HERO_COUNTRIES[code];
    const maxPrice = Number(settings.max_price);
    const { text, data } = await this.heroRequest("getNumberV2", {
      service: HERO_SMS_SERVICE,
      country: countryInfo.id,
      maxPrice: String(maxPrice).replace(/(?:\.0+|(?:(\.\d*?)0+))$/, "$1"),
    });
    let activationId = "";
    let phone = "";
    let price = null;
    if (data && typeof data === "object") {
      activationId = String(data.activationId || data.activation_id || data.id || "");
      phone = String(data.phoneNumber || data.phone || "");
      const countryPhoneCode = String(data.countryPhoneCode || "").replace(/\D/g, "");
      const digits = phone.replace(/\D/g, "");
      phone = `+${countryPhoneCode && !digits.startsWith(countryPhoneCode) ? countryPhoneCode : ""}${digits}`;
      const parsedPrice = Number(data.activationCost ?? data.activation_cost ?? data.price);
      price = Number.isFinite(parsedPrice) ? parsedPrice : null;
    } else if (text.startsWith("ACCESS_NUMBER:")) {
      const parts = text.split(":");
      activationId = String(parts[1] || "");
      phone = `+${String(parts[2] || "").replace(/\D/g, "")}`;
    }
    const digits = phone.replace(/\D/g, "");
    if (!activationId || digits.length < 7 || digits.length > 15 || !digits.startsWith(countryInfo.callingCode)) {
      throw failure("HeroSMS 未返回对应国家的有效手机号", 502, "HEROSMS_INVALID_NUMBER");
    }
    if (price !== null && price > maxPrice + 0.000001) {
      throw failure("HeroSMS 返回价格超过设置的最高价格", 409, "HEROSMS_PRICE_EXCEEDED");
    }
    return { activationId, phone: `+${digits}`, price, country: code, countryId: countryInfo.id };
  }

  async heroStatus(activationId) {
    const { text, data } = await this.heroRequest("getStatus", { id: activationId });
    const raw = String(data && typeof data === "string" ? data : text).trim();
    if (raw.startsWith("STATUS_OK:")) return { state: "received", code: raw.slice(10).trim(), raw };
    if (new Set(["STATUS_WAIT_CODE", "STATUS_WAIT_RETRY", "STATUS_WAIT_RESEND"]).has(raw)) {
      return { state: "waiting", code: "", raw };
    }
    if (raw === "STATUS_CANCEL") return { state: "cancelled", code: "", raw };
    return { state: "unknown", code: "", raw: raw.slice(0, 80) };
  }

  async setHeroStatus(activationId, status) {
    const { text } = await this.heroRequest("setStatus", { id: activationId, status });
    return text.slice(0, 120);
  }

  async requestProtocolRaw(path, { method = "GET", headers = {}, body, cookie = "" } = {}) {
    const outgoingHeaders = {};
    Object.entries(headers).forEach(([key, value]) => {
      if (FORWARDED_REQUEST_HEADERS.has(String(key).toLowerCase())) outgoingHeaders[String(key).toLowerCase()] = String(value);
    });
    if (cookie) outgoingHeaders.cookie = cookie;
    const response = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method,
      headers: outgoingHeaders,
      ...(body === undefined ? {} : { body }),
    });
    const result = {
      status: response.status,
      ok: response.ok,
      headers: responseHeaders(response),
      body: Buffer.from(await response.arrayBuffer()),
    };
    return result;
  }

  async requestProtocolJson(path, { method = "GET", cookie = "", body } = {}) {
    const rawBody = body === undefined ? undefined : JSON.stringify(body);
    const result = await this.requestProtocolRaw(path, {
      method,
      cookie,
      body: rawBody,
      headers: { accept: "application/json", ...(rawBody ? { "content-type": "application/json" } : {}) },
    });
    let data;
    try {
      data = JSON.parse(result.body.toString("utf8") || "{}");
    } catch {
      throw failure("PayPal 协议服务返回了无效响应", 502, "PAYMENT_AGREEMENT_INVALID_RESPONSE");
    }
    if (!result.ok) {
      throw failure(
        errorMessage(data, `PayPal 协议服务返回 HTTP ${result.status}`).slice(0, 500),
        result.status >= 500 ? 502 : result.status,
        "PAYMENT_AGREEMENT_UPSTREAM_ERROR",
      );
    }
    return data;
  }

  async createJob(input = {}, options = {}) {
    const created = await this.createManagedJob(input, options);
    return created.data;
  }

  async start(input = {}, options = {}) {
    return this.createJob(input, options);
  }

  async createManagedJob(input = {}, { cookie = "", deviceId = "" } = {}) {
    if (this.closed) throw failure("协议支付服务正在关闭", 503, "PAYMENT_AGREEMENT_CLOSED");
    const baToken = paymentLinkBaToken(input);
    const paymentLink = baToken ? this.db.prepare(`
      SELECT request_country
      FROM registered_account_payment_links
      WHERE status = 'succeeded' AND provider_url <> ''
        AND lower(provider_url) LIKE '%' || lower(?) || '%'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(baToken) : null;
    const requestCountry = String(paymentLink?.request_country || "").trim().toUpperCase();
    const useSavedProtocolConfig = input.use_saved_protocol_config === true;
    const savedRuntime = useSavedProtocolConfig ? this.runtime({ required: true }) : null;
    const country = savedRuntime?.country || normalizedCountry(input.country || input.paypal_country);
    const countrySource = savedRuntime ? "saved_protocol_config" : "workbench_request";
    const settings = this.settings();
    let activation = null;
    let phone = useSavedProtocolConfig ? "" : String(input.phone || "").trim();
    if (!phone) {
      activation = await this.acquireHeroNumber(country, settings);
      phone = activation.phone;
    }
    const existingDeviceId = deviceId || paypalDeviceId(cookie);
    const ownerDeviceId = existingDeviceId || crypto.randomBytes(16).toString("hex");
    const ownerCookie = deviceCookie(ownerDeviceId);
    let response;
    try {
      response = await this.requestProtocolJson("/api/jobs", {
        method: "POST",
        cookie: ownerCookie,
        body: {
          ...input,
          country,
          paypal_country: country,
          ...(savedRuntime ? { proxies: savedRuntime.proxies } : {}),
          phone,
        },
      });
    } catch (error) {
      if (activation) await this.releaseActivationObject(activation, false);
      try { error.protocolSubmissionStarted = true; } catch { /* Preserve the original upstream error. */ }
      throw error;
    }
    const job = response?.job && typeof response.job === "object" ? response.job : response;
    const jobId = String(job?.id || "");
    if (!jobId) {
      if (activation) await this.releaseActivationObject(activation, false);
      const error = failure("PayPal 协议服务未返回任务 ID", 502, "PAYMENT_AGREEMENT_JOB_ID_MISSING");
      error.protocolSubmissionStarted = true;
      throw error;
    }
    const context = {
      jobId,
      cookie: ownerCookie,
      deviceId: ownerDeviceId,
      country,
      countrySource,
      requestCountry,
      countryId: PAYMENT_AGREEMENT_HERO_COUNTRIES[country].id,
      activation,
      attempts: activation ? 1 : 0,
      settings,
      deadline: Date.now() + settings.wait_seconds * 1_000,
      codeSubmittedAt: 0,
      stopped: false,
      terminal: false,
      cancelRequested: false,
      cancelPromise: null,
      cancelError: "",
      cancelAttempts: 0,
      wake: null,
      lastSnapshot: job,
      lastError: "",
      releaseTimer: null,
    };
    this.contexts.set(jobId, context);
    this.startTracker(context);
    return {
      data: {
        ...(response && typeof response === "object" ? response : { job }),
        hero_sms: activation ? {
          managed: true,
          country,
          country_source: countrySource,
          request_country: requestCountry,
          country_id: context.countryId,
          phone: maskPhone(phone),
          price: activation.price,
        } : { managed: false, country, country_source: countrySource, request_country: requestCountry },
      },
      deviceId: ownerDeviceId,
      cookie: ownerCookie,
      setCookie: existingDeviceId ? "" : publicDeviceCookie(ownerDeviceId),
      context,
    };
  }

  startTracker(context) {
    if (this.trackers.has(context.jobId)) return this.trackers.get(context.jobId);
    const tracker = this.trackJob(context)
      .catch(async (error) => {
        context.lastError = String(error?.message || "协议支付后台跟踪失败").slice(0, 500);
        context.stopped = true;
        await this.releaseContextActivation(context, false);
        return context.lastSnapshot;
      })
      .finally(() => {
        context.wake?.();
        this.trackers.delete(context.jobId);
        this.scheduleContextRelease(context);
      });
    this.trackers.set(context.jobId, tracker);
    return tracker;
  }

  async trackJob(context) {
    let consecutiveFailures = 0;
    while (!this.closed && !context.stopped) {
      if (context.cancelRequested) {
        try {
          await this.requestContextCancellation(context);
          return context.lastSnapshot;
        } catch (error) {
          context.lastError = String(error?.message || "协议支付取消失败，等待重试").slice(0, 500);
          if (Number(context.cancelAttempts || 0) >= this.cancelRetryLimit) {
            context.stopped = true;
            await this.releaseContextActivation(context, false);
            return context.lastSnapshot;
          }
          if (!this.closed && !context.stopped) await sleep(context, this.pollIntervalMs);
          continue;
        }
      }
      try {
        const snapshot = await this.requestProtocolJson(`/api/jobs/${encodeURIComponent(context.jobId)}`, {
          cookie: context.cookie,
        });
        if (context.stopped) return context.lastSnapshot;
        context.lastSnapshot = snapshot?.job && typeof snapshot.job === "object" ? snapshot.job : snapshot;
        consecutiveFailures = 0;
        const status = String(context.lastSnapshot?.status || "").toLowerCase();
        if (TERMINAL_JOB_STATUSES.has(status)) {
          context.terminal = true;
          await this.releaseContextActivation(context, status === "completed");
          return context.lastSnapshot;
        }
        if (!context.cancelRequested && status === "awaiting_otp") await this.reconcileHeroSms(context);
      } catch (error) {
        consecutiveFailures += 1;
        context.lastError = String(error?.message || "协议支付状态读取失败").slice(0, 500);
        if (consecutiveFailures >= 5) {
          await this.releaseContextActivation(context, false);
          try {
            await this.requestProtocolJson(`/api/jobs/${encodeURIComponent(context.jobId)}/cancel`, {
              method: "POST",
              cookie: context.cookie,
              body: {},
            });
          } catch { /* The activation release remains authoritative. */ }
          context.stopped = true;
          return context.lastSnapshot;
        }
      }
      if (!context.stopped) await sleep(context, this.pollIntervalMs);
    }
    if (!context.terminal) await this.releaseContextActivation(context, false);
    return context.lastSnapshot;
  }

  async reconcileHeroSms(context) {
    if (context.activation) {
      const status = await this.heroStatus(context.activation.activationId);
      if (status.state === "received" && status.code) {
        await this.requestProtocolJson(`/api/jobs/${encodeURIComponent(context.jobId)}/otp`, {
          method: "POST",
          cookie: context.cookie,
          body: { value: status.code },
        });
        await this.releaseContextActivation(context, true);
        context.codeSubmittedAt = Date.now();
        return;
      }
      if (status.state === "cancelled" || Date.now() >= context.deadline) {
        await this.rotateHeroNumber(context);
      }
      return;
    }
    if (context.codeSubmittedAt && Date.now() - context.codeSubmittedAt >= 8_000) {
      await this.rotateHeroNumber(context);
    }
  }

  async rotateHeroNumber(context) {
    await this.releaseContextActivation(context, false);
    if (context.attempts >= 1 + context.settings.change_retries) {
      try {
        context.lastSnapshot = await this.requestProtocolJson(
          `/api/jobs/${encodeURIComponent(context.jobId)}/cancel`,
          { method: "POST", cookie: context.cookie, body: {} },
        );
      } finally {
        context.stopped = true;
      }
      return;
    }
    const activation = await this.acquireHeroNumber(context.country, context.settings);
    context.activation = activation;
    context.attempts += 1;
    try {
      await this.requestProtocolJson(`/api/jobs/${encodeURIComponent(context.jobId)}/otp`, {
        method: "POST",
        cookie: context.cookie,
        body: { value: activation.phone },
      });
    } catch (error) {
      await this.releaseContextActivation(context, false);
      throw error;
    }
    context.deadline = Date.now() + context.settings.wait_seconds * 1_000;
    context.codeSubmittedAt = 0;
  }

  async releaseActivationObject(activation, successful) {
    if (!activation?.activationId) return;
    try { await this.setHeroStatus(activation.activationId, successful ? 6 : 8); } catch { /* Best effort. */ }
  }

  async releaseContextActivation(context, successful) {
    const activation = context.activation;
    context.activation = null;
    await this.releaseActivationObject(activation, successful);
  }

  context(jobId) {
    return this.contexts.get(String(jobId || "")) || null;
  }

  scheduleContextRelease(context) {
    if (!context || this.contexts.get(context.jobId) !== context || context.releaseTimer) return;
    context.releaseTimer = setTimeout(() => {
      const successful = String(context.lastSnapshot?.status || "").toLowerCase() === "completed";
      this.releaseContext(context.jobId, { successful }).catch(() => undefined);
    }, this.contextRetentionMs);
    context.releaseTimer.unref?.();
  }

  async releaseContext(jobId, { force = false, successful = false } = {}) {
    const key = String(jobId || "");
    const context = this.context(key);
    if (!context) return false;
    const tracker = this.trackers.get(key);
    if (tracker && !force) return false;
    if (force && !context.terminal) {
      context.stopped = true;
      context.wake?.();
    }
    if (tracker) await tracker.catch(() => undefined);
    if (!context.terminal && !context.stopped) return false;
    if (context.activation) await this.releaseContextActivation(context, Boolean(successful));
    if (context.releaseTimer) clearTimeout(context.releaseTimer);
    context.releaseTimer = null;
    context.cookie = "";
    context.deviceId = "";
    context.settings = null;
    context.lastSnapshot = null;
    context.lastError = "";
    context.cancelRequested = false;
    context.cancelPromise = null;
    context.cancelError = "";
    context.cancelAttempts = 0;
    if (this.contexts.get(key) === context) this.contexts.delete(key);
    return true;
  }

  async waitForJob(jobId) {
    const tracker = this.trackers.get(String(jobId || ""));
    if (tracker) return tracker;
    return this.context(jobId)?.lastSnapshot || null;
  }

  async getJob(jobId) {
    const context = this.context(jobId);
    if (!context) throw failure("协议支付任务不存在", 404, "PAYMENT_AGREEMENT_JOB_NOT_FOUND");
    const data = await this.requestProtocolJson(`/api/jobs/${encodeURIComponent(jobId)}`, { cookie: context.cookie });
    context.lastSnapshot = data?.job && typeof data.job === "object" ? data.job : data;
    return { ...data, hero_sms: this.publicTracking(context) };
  }

  publicTracking(context) {
    return {
      managed: Boolean(context.attempts),
      country: context.country,
      country_source: context.countrySource,
      request_country: context.requestCountry,
      country_id: context.countryId,
      attempts: context.attempts,
      phone: context.activation ? maskPhone(context.activation.phone) : "",
      error: context.lastError,
    };
  }

  async submitOtp(jobId, value) {
    const context = this.context(jobId);
    if (!context) throw failure("协议支付任务不存在", 404, "PAYMENT_AGREEMENT_JOB_NOT_FOUND");
    return this.requestProtocolJson(`/api/jobs/${encodeURIComponent(jobId)}/otp`, {
      method: "POST", cookie: context.cookie, body: { value: String(value || "").trim() },
    });
  }

  async submitCaptcha(jobId, value) {
    const context = this.context(jobId);
    if (!context) throw failure("协议支付任务不存在", 404, "PAYMENT_AGREEMENT_JOB_NOT_FOUND");
    return this.requestProtocolJson(`/api/jobs/${encodeURIComponent(jobId)}/captcha`, {
      method: "POST", cookie: context.cookie, body: { value: String(value || "").trim() },
    });
  }

  async browserAction(jobId, input = {}) {
    const context = this.context(jobId);
    if (!context) throw failure("协议支付任务不存在", 404, "PAYMENT_AGREEMENT_JOB_NOT_FOUND");
    return this.requestProtocolJson(`/api/jobs/${encodeURIComponent(jobId)}/browser/action`, {
      method: "POST", cookie: context.cookie, body: input,
    });
  }

  requestContextCancellation(context) {
    if (context.cancelPromise) return context.cancelPromise;
    let cancellation;
    cancellation = (async () => {
      context.cancelAttempts = Number(context.cancelAttempts || 0) + 1;
      const result = await this.requestProtocolJson(`/api/jobs/${encodeURIComponent(context.jobId)}/cancel`, {
        method: "POST", cookie: context.cookie, body: {},
      });
      context.lastSnapshot = result?.job && typeof result.job === "object" ? result.job : result;
      context.cancelError = "";
      context.stopped = true;
      const status = String(context.lastSnapshot?.status || "").toLowerCase();
      if (TERMINAL_JOB_STATUSES.has(status)) context.terminal = true;
      context.wake?.();
      await this.releaseContextActivation(context, false);
      return result;
    })().catch((error) => {
      context.cancelError = String(error?.message || "协议支付取消失败").slice(0, 500);
      throw error;
    }).finally(() => {
      if (context.cancelPromise === cancellation) context.cancelPromise = null;
    });
    context.cancelPromise = cancellation;
    return cancellation;
  }

  async cancelJob(jobId) {
    const context = this.context(jobId);
    if (!context) throw failure("协议支付任务不存在", 404, "PAYMENT_AGREEMENT_JOB_NOT_FOUND");
    context.cancelRequested = true;
    context.wake?.();
    if (context.stopped && !context.cancelError) return context.lastSnapshot || { status: "cancelled" };
    return this.requestContextCancellation(context);
  }

  async proxyApi(input = {}) {
    const method = String(input.method || "GET").toUpperCase();
    const path = normalizeApiPath(input);
    const headers = requestHeaders(input);
    if (method === "POST" && path.split("?", 1)[0] === "/api/jobs") {
      const created = await this.createManagedJob(parseInputJson(input), { cookie: headers.cookie || "" });
      return jsonProxyResponse(created.data, 201, created.setCookie ? { "set-cookie": created.setCookie } : {});
    }
    const jobId = jobIdFromPath(path);
    const context = jobId ? this.context(decodeURIComponent(jobId)) : null;
    const incomingDeviceId = paypalDeviceId(headers.cookie);
    const cookie = context?.cookie || (incomingDeviceId ? deviceCookie(incomingDeviceId) : "");
    const outgoingHeaders = Object.fromEntries(
      Object.entries(headers).filter(([key]) => FORWARDED_REQUEST_HEADERS.has(key)),
    );
    const body = normalizeBody({ ...input, method }, outgoingHeaders);
    const result = await this.requestProtocolRaw(path, { method, headers: outgoingHeaders, body, cookie });
    if (method === "POST" && /\/cancel(?:\?|$)/.test(path) && context) {
      context.stopped = true;
      context.wake?.();
      await this.releaseContextActivation(context, false);
    }
    return result;
  }

  async proxyWorkbench(input = {}) {
    const path = normalizeWorkbenchPath(input);
    if (path.split("?", 1)[0].startsWith("/api/")) {
      return this.proxyApi({ ...input, upstreamPath: path });
    }
    const method = String(input.method || "GET").toUpperCase();
    const headers = requestHeaders(input);
    const incomingDeviceId = paypalDeviceId(headers.cookie);
    const outgoingHeaders = Object.fromEntries(
      Object.entries(headers).filter(([key]) => FORWARDED_REQUEST_HEADERS.has(key)),
    );
    const body = normalizeBody({ ...input, method }, outgoingHeaders);
    const result = await this.requestProtocolRaw(path, {
      method,
      headers: outgoingHeaders,
      body,
      cookie: incomingDeviceId ? deviceCookie(incomingDeviceId) : "",
    });
    const contentType = result.headers["content-type"] || "";
    if (isTextResponse(contentType, path)) {
      let rewritten = result.body.toString("utf8").replaceAll("/paypal-pay/", "/alias-hub/paypal-pay/");
      const embeddedStyle = embeddedWorkbenchStyle(path, contentType);
      if (embeddedStyle) rewritten = rewritten.replace(/<\/head>/i, `${embeddedStyle}</head>`);
      result.body = Buffer.from(rewritten);
      delete result.headers["content-length"];
      delete result.headers["content-encoding"];
    }
    if (result.headers.location) {
      result.headers.location = String(result.headers.location)
        .replaceAll("/paypal-pay/", "/alias-hub/paypal-pay/");
    }
    result.headers["x-frame-options"] = "SAMEORIGIN";
    result.headers["content-security-policy"] = sameOriginCsp(result.headers["content-security-policy"]);
    return result;
  }

  async close() {
    this.closed = true;
    const activeContexts = [...this.contexts.values()].filter((context) => (
      !context.terminal && !context.stopped
    ));
    await Promise.allSettled(activeContexts.map(async (context) => {
      context.cancelRequested = true;
      context.wake?.();
      try {
        await this.requestContextCancellation(context);
      } catch {
        context.stopped = true;
        context.wake?.();
      }
    }));
    for (const context of this.contexts.values()) {
      if (!context.terminal) context.stopped = true;
      context.wake?.();
    }
    await Promise.allSettled([...this.trackers.values()]);
    for (const context of [...this.contexts.values()]) {
      const successful = String(context.lastSnapshot?.status || "").toLowerCase() === "completed";
      await this.releaseContext(context.jobId, { force: true, successful });
    }
  }
}
