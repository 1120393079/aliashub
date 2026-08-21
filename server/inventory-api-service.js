import crypto from "node:crypto";
import { getSetting, nowIso, setSetting } from "./db.js";

/**
 * Small server-side client for the member inventory API.
 *
 * The API key never leaves this process.  It is kept in the settings table in
 * an AES-GCM envelope and is only attached to an upstream request.  Keeping
 * this integration on the server also avoids putting credentials in browser
 * history, devtools or reverse-proxy access logs.
 */

export const DEFAULT_INVENTORY_CARDS_URL = "https://nvtokens.com/api/inventory/cards/import";
export const DEFAULT_INVENTORY_MAILBOXES_URL = "https://nvtokens.com/api/inventory/mailboxes/import";
export const DEFAULT_INVENTORY_POOL_URL = "https://nvtokens.com/api/inventory/cards/pool";

const KEY_SETTING = "inventory_api_key_encrypted";
const LAST_CONNECTED_SETTING = "inventory_api_last_connected_at";
const CUSTOM_ENDPOINTS_ENV = "NVTOKENS_ALLOW_CUSTOM_ENDPOINTS";
const MAX_URL_LENGTH = 2_048;
const MAX_BODY_BYTES = 900_000;
const MAX_REDACTION_SECRETS = 5_000;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g;
const SENSITIVE_FIELD_PATTERN = /(?:token|password|secret|authorization|cookie|credential|api[_-]?key|inbox[_-]?link|private[_-]?key)/i;
const SUMMARY_COUNT_KEYS = [
  "total", "parsed", "matched", "updated", "unchanged", "unmatched", "invalid",
  "duplicates", "published", "created",
];
const NESTED_SUMMARY_COUNT_KEYS = [
  "accepted", "rejected", "total", "parsed", "matched", "updated", "unchanged",
  "unmatched", "invalid", "duplicates", "published", "created",
];

function clean(value) {
  return String(value ?? "").trim();
}

function errorWithStatus(message, status = 400, code = "") {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

function environmentFlag(value) {
  return /^(?:1|true|yes|on)$/i.test(clean(value));
}

function normalizeUrl(value, fallback, label, { allowHttp = false } = {}) {
  const raw = clean(value) || fallback;
  if (!raw || raw.length > MAX_URL_LENGTH) throw errorWithStatus(`${label}格式无效`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw errorWithStatus(`${label}格式无效`);
  }
  const allowedProtocols = allowHttp ? new Set(["http:", "https:"]) : new Set(["https:"]);
  if (!allowedProtocols.has(parsed.protocol) || parsed.username || parsed.password) {
    throw errorWithStatus(`${label}必须使用 HTTPS，且不能包含账号密码`);
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function normalizeServerEndpoint(value, fallback, label, { allowCustomEndpoints, allowHttp }) {
  if (!clean(value)) return "";
  const normalized = normalizeUrl(value, fallback, label, { allowHttp });
  if (!allowCustomEndpoints && normalized !== fallback) {
    throw errorWithStatus(
      `${label}已锁定；如需服务端自定义，请显式设置 ${CUSTOM_ENDPOINTS_ENV}=true`,
      500,
      "INVENTORY_CUSTOM_ENDPOINTS_DISABLED",
    );
  }
  return normalized;
}

function assertLockedEndpoint(value, expected, label, { allowHttp }) {
  const normalized = normalizeUrl(value, expected, label, { allowHttp });
  if (normalized !== expected) {
    throw errorWithStatus(
      `${label}由服务端锁定，不能通过普通配置修改`,
      400,
      "INVENTORY_ENDPOINT_LOCKED",
    );
  }
}

function redact(value, secrets = []) {
  let message = clean(value);
  const known = [...new Set(secrets.map(clean).filter((item) => item.length >= 3))]
    .sort((left, right) => right.length - left.length);
  known.forEach((secret) => { message = message.split(secret).join("[REDACTED]"); });
  return message
    .replace(JWT_PATTERN, "[REDACTED-JWT]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\bAgentAssertion\s+[^\s,;]+/gi, "AgentAssertion [REDACTED]")
    .replace(/((?:authorization|cookie|password|secret)\s*[:=]\s*)[^\s,;}]+/gi, "$1[REDACTED]")
    .replace(/((?:access|refresh|id)[_-]?token\s*[:=]\s*)[^\s,;}]+/gi, "$1[REDACTED]")
    .replace(/(x-api-key\s*[:=]\s*)[^\s,;}]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

function parseResponsePayload(text, contentType) {
  if (contentType.includes("application/json")) {
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }
  return text;
}

function responseMessage(payload, status, secrets) {
  if (payload && typeof payload === "object") {
    for (const key of ["message", "detail", "error", "reason"]) {
      if (typeof payload[key] === "string" && payload[key].trim()) return redact(payload[key], secrets);
    }
  }
  if (typeof payload === "string" && payload.trim()) return redact(payload, secrets);
  return `库存 API 请求失败 (HTTP ${status})`;
}

function payloadSize(payload) {
  try { return Buffer.byteLength(JSON.stringify(payload), "utf8"); } catch { return MAX_BODY_BYTES + 1; }
}

function addSecret(output, value) {
  const secret = clean(value);
  if (secret.length >= 3 && output.length < MAX_REDACTION_SECRETS) output.push(secret);
}

function requestSecrets(value, field = "", output = [], depth = 0) {
  if (output.length >= MAX_REDACTION_SECRETS || depth > 12 || value === null || value === undefined) return output;
  if (typeof value === "string") {
    if (SENSITIVE_FIELD_PATTERN.test(field) || field === "text" || field === "tokens") {
      if (field === "text" || field === "tokens") {
        for (const line of value.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          addSecret(output, trimmed);
          const parts = trimmed.split(/-{2,4}|\s+(?=https?:\/\/)/i);
          parts.slice(1).forEach((part) => addSecret(output, part));
        }
      } else {
        addSecret(output, value);
      }
    }
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => requestSecrets(item, field, output, depth + 1));
    return output;
  }
  if (typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => requestSecrets(item, key, output, depth + 1));
  }
  return output;
}

function safeSummary(payload, secrets = []) {
  if (!payload || typeof payload !== "object") return {};
  const summary = {};
  const count = (value) => {
    if (Array.isArray(value)) return value.length;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
    return undefined;
  };
  if (typeof payload.ok === "boolean") summary.ok = payload.ok;
  for (const key of SUMMARY_COUNT_KEYS) {
    const normalized = count(payload[key]);
    if (normalized !== undefined) summary[key] = normalized;
  }
  if (payload.cards !== undefined) summary.cards = count(payload.cards) ?? 0;
  for (const key of ["accepted", "rejected"]) {
    if (payload[key] !== undefined) summary[key] = count(payload[key]);
  }
  if (payload.summary && typeof payload.summary === "object") {
    summary.summary = {};
    for (const key of NESTED_SUMMARY_COUNT_KEYS) {
      const normalized = count(payload.summary[key]);
      if (normalized !== undefined) summary.summary[key] = normalized;
    }
  }
  const failures = [
    ...(Array.isArray(payload.rejected) ? payload.rejected : []),
    ...(Array.isArray(payload.unmatched_details) ? payload.unmatched_details : []),
    ...(Array.isArray(payload.invalid_details) ? payload.invalid_details : []),
  ].slice(0, 50).map((item) => ({
    email: redact(clean(item?.email).slice(0, 180), secrets),
    ...(Number.isSafeInteger(Number(item?.line)) && Number(item.line) >= 1 ? { line: Number(item.line) } : {}),
    file: redact(clean(item?.file).slice(0, 120), secrets),
    reason: redact(item?.reason || item?.error || "未通过上游校验", secrets),
  }));
  if (failures.length) summary.failures = failures;
  return summary;
}

export class InventoryApiService {
  constructor({
    db,
    encryptionKey,
    fetchFn = globalThis.fetch,
    cardsUrl,
    mailboxesUrl,
    poolUrl,
    apiKey,
    timeoutMs = 120_000,
    allowHttp = false,
  } = {}) {
    this.db = db;
    this.fetchFn = fetchFn;
    this.allowCustomEndpoints = environmentFlag(process.env[CUSTOM_ENDPOINTS_ENV]);
    this.cardsUrlOverride = normalizeServerEndpoint(cardsUrl, DEFAULT_INVENTORY_CARDS_URL, "账号入库地址", {
      allowCustomEndpoints: this.allowCustomEndpoints,
      allowHttp,
    });
    this.mailboxesUrlOverride = normalizeServerEndpoint(mailboxesUrl, DEFAULT_INVENTORY_MAILBOXES_URL, "邮箱凭证地址", {
      allowCustomEndpoints: this.allowCustomEndpoints,
      allowHttp,
    });
    this.poolUrlOverride = normalizeServerEndpoint(poolUrl, DEFAULT_INVENTORY_POOL_URL, "直接入池地址", {
      allowCustomEndpoints: this.allowCustomEndpoints,
      allowHttp,
    });
    this.apiKeyOverride = clean(apiKey);
    this.timeoutMs = Math.max(1_000, Math.min(120_000, Number(timeoutMs) || 120_000));
    this.allowHttp = Boolean(allowHttp);
    const suppliedEncryptionKey = clean(encryptionKey || process.env.DATA_ENCRYPTION_KEY);
    this.encryptionReady = Boolean(suppliedEncryptionKey);
    this.encryptionKey = crypto.createHash("sha256")
      .update(suppliedEncryptionKey || crypto.randomBytes(32))
      .digest();
  }

  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  decrypt(value) {
    const [version, iv, tag, encrypted] = String(value || "").split(".");
    if (version !== "v1" || !iv || !tag || !encrypted) throw errorWithStatus("库存 API Key 无法解密", 500, "INVENTORY_KEY_DECRYPT_FAILED");
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      throw errorWithStatus("库存 API Key 无法解密，请重新保存", 500, "INVENTORY_KEY_DECRYPT_FAILED");
    }
  }

  cardsUrl() {
    return this.cardsUrlOverride || DEFAULT_INVENTORY_CARDS_URL;
  }

  mailboxesUrl() {
    return this.mailboxesUrlOverride || DEFAULT_INVENTORY_MAILBOXES_URL;
  }

  poolUrl() {
    return this.poolUrlOverride || DEFAULT_INVENTORY_POOL_URL;
  }

  apiKey() {
    if (this.apiKeyOverride) return this.apiKeyOverride;
    if (!this.encryptionReady) return "";
    const encrypted = getSetting(this.db, KEY_SETTING, "");
    return encrypted ? this.decrypt(encrypted) : "";
  }

  configuration() {
    const apiKey = this.apiKey();
    const cards = this.cardsUrl();
    const mailboxes = this.mailboxesUrl();
    const pool = this.poolUrl();
    return {
      cards_url: cards,
      mailboxes_url: mailboxes,
      pool_url: pool,
      cards_schema_url: `${cards}/schema`,
      mailboxes_schema_url: `${mailboxes}/schema`,
      pool_schema_url: `${pool}/schema`,
      api_key_configured: Boolean(apiKey),
      encryption_ready: this.encryptionReady,
      configured: Boolean(apiKey && cards && mailboxes && pool),
      connected: Boolean(apiKey && getSetting(this.db, LAST_CONNECTED_SETTING, "")),
      last_connected_at: getSetting(this.db, LAST_CONNECTED_SETTING, ""),
      auth_header: "x-api-key",
      operations: 3,
      endpoints_locked: true,
      custom_endpoints_enabled: this.allowCustomEndpoints,
      endpoint_source: this.cardsUrlOverride || this.mailboxesUrlOverride || this.poolUrlOverride ? "server" : "fixed",
    };
  }

  updateConfiguration(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw errorWithStatus("库存 API 设置格式无效");
    if (input.cards_url !== undefined) assertLockedEndpoint(input.cards_url, this.cardsUrl(), "账号入库地址", { allowHttp: this.allowHttp });
    if (input.mailboxes_url !== undefined) assertLockedEndpoint(input.mailboxes_url, this.mailboxesUrl(), "邮箱凭证地址", { allowHttp: this.allowHttp });
    if (input.pool_url !== undefined) assertLockedEndpoint(input.pool_url, this.poolUrl(), "直接入池地址", { allowHttp: this.allowHttp });
    if (input.clear_api_key === true) setSetting(this.db, KEY_SETTING, "");
    if (input.api_key !== undefined && input.api_key !== "") {
      if (!this.encryptionReady) throw errorWithStatus("服务器未配置 DATA_ENCRYPTION_KEY，不能保存库存 API Key", 503, "INVENTORY_ENCRYPTION_REQUIRED");
      const key = clean(input.api_key);
      if (key.length < 8 || key.length > 2_048) throw errorWithStatus("库存 API Key 长度无效");
      setSetting(this.db, KEY_SETTING, this.encrypt(key));
    }
    setSetting(this.db, LAST_CONNECTED_SETTING, "");
    return this.configuration();
  }

  async request(url, body, { method = "POST", timeoutMs = this.timeoutMs, idempotencyKey = "" } = {}) {
    const apiKey = this.apiKey();
    if (!apiKey) throw errorWithStatus("库存 API Key 尚未配置", 503, "INVENTORY_API_KEY_MISSING");
    if (!this.fetchFn) throw errorWithStatus("库存 API 请求服务不可用", 503);
    if (body !== undefined && payloadSize(body) > MAX_BODY_BYTES) throw errorWithStatus("库存 API 请求内容超过 900 KB", 413);
    const secrets = [apiKey, ...requestSecrets(body)];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || this.timeoutMs));
    timer.unref?.();
    try {
      const response = await this.fetchFn(url, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "x-api-key": apiKey,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
      const raw = await response.text();
      const payload = parseResponsePayload(raw, contentType);
      if (!response.ok) {
        throw errorWithStatus(responseMessage(payload, response.status, secrets), response.status >= 500 ? 502 : response.status, "INVENTORY_UPSTREAM_ERROR");
      }
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") throw errorWithStatus("库存 API 请求超时", 504, "INVENTORY_UPSTREAM_TIMEOUT");
      if (!error?.status && error instanceof TypeError) {
        throw errorWithStatus("库存 API 网络请求失败", 502, "INVENTORY_UPSTREAM_UNREACHABLE");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async testConnection() {
    setSetting(this.db, LAST_CONNECTED_SETTING, "");
    await this.request(this.cardsUrl(), {}, { method: "POST" });
    const connectedAt = nowIso();
    setSetting(this.db, LAST_CONNECTED_SETTING, connectedAt);
    return { connected: true, message: "库存 API 连接正常", last_connected_at: connectedAt };
  }

  async importCards(payload, { pool = false, idempotencyKey = "" } = {}) {
    const url = pool ? this.poolUrl() : this.cardsUrl();
    return this.request(url, payload, { idempotencyKey });
  }

  async importMailboxes(payload, { idempotencyKey = "" } = {}) {
    return this.request(this.mailboxesUrl(), payload, { idempotencyKey });
  }

  resultSummary(payload, requestPayload) {
    return safeSummary(payload, [this.apiKey(), ...requestSecrets(requestPayload)]);
  }
}

export function inventoryResultSummary(payload, secrets = []) {
  return safeSummary(payload, secrets);
}
