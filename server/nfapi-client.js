import crypto from "node:crypto";

const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|secret|session|token|api[_-]?key)/i;

function collectSensitiveStrings(value, key = "", output = new Set(), seen = new Set()) {
  if (typeof value === "string") {
    if (SENSITIVE_KEY.test(key) && value.length >= 3) output.add(value);
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length <= 100_000) {
      try { collectSensitiveStrings(JSON.parse(trimmed), key, output, seen); } catch { /* not JSON */ }
    }
    return output;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectSensitiveStrings(item, key, output, seen));
  } else {
    Object.entries(value).forEach(([childKey, item]) => collectSensitiveStrings(item, childKey, output, seen));
  }
  return output;
}

export function redactNfapiMessage(value, secrets = []) {
  let message = String(value || "").trim();
  const known = new Set(secrets.filter((item) => typeof item === "string" && item.length >= 3));
  [...known].sort((left, right) => right.length - left.length).forEach((secret) => {
    message = message.split(secret).join("[REDACTED]");
  });
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g, "[REDACTED-JWT]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED-KEY]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, "$1[REDACTED]@")
    .replace(/((?:(?:access|refresh|id)[_-]?token|authorization|cookie|password|secret|api[_-]?key)\s*[:=]\s*["']?)[^"'\s,;}]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

function responseMessage(payload, status, secrets = []) {
  if (typeof payload === "string" && payload.trim()) return redactNfapiMessage(payload, secrets);
  if (payload && typeof payload === "object") {
    for (const key of ["message", "detail", "error", "reason"]) {
      if (typeof payload[key] === "string" && payload[key].trim()) return redactNfapiMessage(payload[key], secrets);
    }
  }
  return `SUB2 兼容服务请求失败 (HTTP ${status})`;
}

export function unwrapNfapiPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (Object.hasOwn(payload, "data")) return payload.data;
  return payload;
}

export class NfapiClient {
  constructor({ baseUrl, apiKey, fetchFn = globalThis.fetch, timeoutMs = 20_000 } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.apiKey = String(apiKey || "");
    this.fetchFn = fetchFn;
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || 20_000);
  }

  get configured() {
    return Boolean(this.baseUrl && this.apiKey && this.fetchFn);
  }

  async request(path, { method = "GET", body, idempotent = false, idempotencyKey = "" } = {}) {
    if (!this.configured) throw Object.assign(new Error("SUB2 兼容服务连接尚未配置"), { status: 503 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        // A cross-origin redirect keeps custom headers in Node's fetch. Never
        // allow a SUB2-compatible endpoint to forward the administrator API key.
        redirect: "error",
        headers: {
          Accept: "application/json",
          "x-api-key": this.apiKey,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(idempotent || idempotencyKey ? { "Idempotency-Key": idempotencyKey || crypto.randomUUID() } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const contentType = response.headers?.get?.("content-type") || "";
      let payload;
      if (contentType.includes("application/json")) payload = await response.json();
      else payload = await response.text();
      if (!response.ok) {
        const secrets = [...collectSensitiveStrings(body)];
        if (this.apiKey) secrets.push(this.apiKey);
        throw Object.assign(new Error(responseMessage(payload, response.status, secrets)), {
          status: response.status >= 500 ? 502 : response.status,
          upstreamStatus: response.status,
        });
      }
      return unwrapNfapiPayload(payload);
    } catch (error) {
      if (error?.name === "AbortError") {
        throw Object.assign(new Error("SUB2 兼容服务请求超时"), { status: 504 });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  listGroups() {
    return this.request("/api/v1/admin/groups/all?platform=openai");
  }

  listProxies() {
    return this.request("/api/v1/admin/proxies/all?with_count=true");
  }

  async listOpenAiOauthAccounts() {
    const pageSize = 500;
    const accounts = [];
    for (let page = 1; page <= 100; page += 1) {
      const data = await this.request(`/api/v1/admin/accounts?page=${page}&page_size=${pageSize}&platform=openai&type=oauth`);
      if (Array.isArray(data)) return data;
      const items = [data?.items, data?.records, data?.list, data?.data?.items]
        .find((candidate) => Array.isArray(candidate)) || [];
      accounts.push(...items);
      const pages = Number(data?.pages || data?.data?.pages || 0);
      const total = Number(data?.total || data?.data?.total || 0);
      const reportedPageSize = Number(data?.page_size || data?.data?.page_size || pageSize);
      if (!items.length
        || (pages > 0 && page >= pages)
        || (total > 0 && accounts.length >= total)
        || (pages <= 0 && total <= 0 && items.length < Math.max(1, reportedPageSize))) break;
    }
    return accounts;
  }

  getAccount(id) {
    return this.request(`/api/v1/admin/accounts/${encodeURIComponent(id)}`);
  }

  generateOpenAiOAuthUrl(payload = {}) {
    return this.request("/api/v1/admin/openai/generate-auth-url", {
      method: "POST",
      body: payload,
    });
  }

  exchangeOpenAiOAuthCode(payload) {
    return this.request("/api/v1/admin/openai/exchange-code", {
      method: "POST",
      body: payload,
    });
  }

  createAccount(payload, idempotencyKey = "") {
    return this.request("/api/v1/admin/accounts", {
      method: "POST",
      body: payload,
      idempotent: true,
      idempotencyKey,
    });
  }

  updateAccount(id, payload) {
    return this.request(`/api/v1/admin/accounts/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: payload,
    });
  }

  applyOAuthCredentials(id, payload) {
    return this.request(`/api/v1/admin/accounts/${encodeURIComponent(id)}/apply-oauth-credentials`, {
      method: "POST",
      body: payload,
    });
  }

  bulkUpdateAccounts(payload) {
    return this.request("/api/v1/admin/accounts/bulk-update", {
      method: "POST",
      body: payload,
    });
  }
}
