const DEFAULT_BASE_URL = "http://127.0.0.1:8793/api/alias-hub";
const INTERNAL_KEY_HEADER = "X-Alias-Hub-Internal-Key";

function clientFailure(message, status = 502, code = "IC_PIPELINE_MAILBOX_SERVICE_UNAVAILABLE") {
  return Object.assign(new Error(message), { status, code });
}

function normalizedBaseUrl(value) {
  const source = String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(source);
  } catch {
    throw clientFailure("iCloud 隐藏邮箱服务地址无效", 503);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw clientFailure("iCloud 隐藏邮箱服务地址无效", 503);
  }
  return source;
}

function responseMessage(data, fallback) {
  if (!data || typeof data !== "object") return fallback;
  return String(data.message || data.error || fallback).trim().slice(0, 300);
}

export class IcloudPrivacyClient {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    internalKey = "",
    fetchFn = globalThis.fetch,
    requestTimeoutMs = 15_000,
    createTimeoutMs = 180_000,
  } = {}) {
    this.baseUrl = normalizedBaseUrl(baseUrl);
    this.internalKey = String(internalKey || "").trim();
    this.fetch = fetchFn;
    this.requestTimeoutMs = Math.max(1_000, Number(requestTimeoutMs) || 15_000);
    this.createTimeoutMs = Math.max(this.requestTimeoutMs, Number(createTimeoutMs) || 180_000);
  }

  configured() {
    return Boolean(this.internalKey && typeof this.fetch === "function");
  }

  async request(path, { method = "GET", body, timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.configured()) {
      throw clientFailure("iCloud 隐藏邮箱服务尚未配置", 503, "IC_PIPELINE_MAILBOX_SERVICE_UNCONFIGURED");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          [INTERNAL_KEY_HEADER]: this.internalKey,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          throw clientFailure("iCloud 隐藏邮箱服务返回了无效响应");
        }
      }
      if (!response.ok) {
        const status = response.status >= 400 && response.status < 500 ? 409 : 502;
        throw clientFailure(responseMessage(data, "iCloud 隐藏邮箱服务请求失败"), status);
      }
      return data;
    } catch (error) {
      if (String(error?.code || "").startsWith("IC_PIPELINE_")) throw error;
      if (error?.name === "AbortError") {
        throw clientFailure("iCloud 隐藏邮箱服务请求超时", 504, "IC_PIPELINE_MAILBOX_SERVICE_TIMEOUT");
      }
      throw clientFailure("iCloud 隐藏邮箱服务当前不可用", 503);
    } finally {
      clearTimeout(timer);
    }
  }

  status() {
    return this.request("/status");
  }

  listMailboxes() {
    return this.request("/mailboxes");
  }

  createMailboxes({ accountId, sourceAccountId, count, label, note = "" } = {}) {
    return this.request("/mailboxes/create", {
      method: "POST",
      timeoutMs: this.createTimeoutMs,
      body: {
        account_id: String(accountId || ""),
        source_account_id: Number(sourceAccountId),
        count: Number(count),
        label: String(label || ""),
        note: String(note || ""),
      },
    });
  }
}

export { DEFAULT_BASE_URL as DEFAULT_ICLOUD_PRIVACY_BASE_URL };
