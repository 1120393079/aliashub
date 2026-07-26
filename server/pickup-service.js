function publicError(message, status = 500, code = "PICKUP_SERVICE_ERROR") {
  return Object.assign(new Error(message), { status, code });
}

function normalizeBaseUrl(value, label = "取件站服务") {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!text) return "";
  let parsed;
  try { parsed = new URL(text); } catch {
    throw publicError(`${label}地址无效`, 500, "PICKUP_CONFIG_INVALID");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw publicError(`${label}地址无效`, 500, "PICKUP_CONFIG_INVALID");
  }
  return text;
}

function normalizeIds(input, maximum = 500) {
  if (!Array.isArray(input?.ids)) {
    throw publicError("请选择要上架的 ChatGPT 账号", 400, "PICKUP_IDS_REQUIRED");
  }
  const ids = [...new Set(input.ids.map(Number))];
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw publicError("请选择有效的 ChatGPT 账号", 400, "PICKUP_IDS_INVALID");
  }
  if (ids.length > maximum) {
    throw publicError(`单次最多上架 ${maximum} 个账号`, 400, "PICKUP_IDS_LIMIT");
  }
  return ids;
}

function accountLabel(account) {
  const type = String(account.account_type || account.plan || "").trim();
  const group = String(account.group_name || "").trim();
  return [...new Set([type && `ChatGPT ${type.toUpperCase()}`, group].filter(Boolean))].join(" · ").slice(0, 200);
}

export class PickupService {
  constructor({
    registration,
    baseUrl,
    publicUrl,
    username,
    password,
    fetchFn = globalThis.fetch,
  } = {}) {
    this.registration = registration;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.publicUrl = normalizeBaseUrl(publicUrl, "取件站公开") || this.baseUrl;
    this.username = String(username || "admin");
    this.password = String(password || "");
    this.fetch = fetchFn;
  }

  configuration() {
    const enabled = Boolean(this.baseUrl && this.password && this.registration && this.fetch);
    return {
      enabled,
      public_url: enabled ? this.publicUrl : "",
      admin_url: enabled ? `${this.publicUrl}/admin` : "",
    };
  }

  async request(path, options = {}) {
    if (!this.configuration().enabled) {
      throw publicError("取件站尚未配置", 503, "PICKUP_NOT_CONFIGURED");
    }
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    const contentType = response.headers?.get?.("content-type") || "";
    const result = contentType.includes("application/json")
      ? await response.json()
      : { error: await response.text() };
    if (!response.ok) {
      const status = response.status >= 400 && response.status < 500 ? response.status : 502;
      throw publicError(result?.error || `取件站返回 HTTP ${response.status}`, status, "PICKUP_UPSTREAM_ERROR");
    }
    return result;
  }

  async importRegisteredAccounts(input = {}) {
    const ids = normalizeIds(input);
    const accounts = await this.registration.listRegisteredAccounts({ refreshUnchecked: false });
    const selected = accounts.items.filter((item) => ids.includes(Number(item.id)));
    if (selected.length !== ids.length) {
      throw publicError("选择中包含不属于当前注册账号列表的账号", 409, "PICKUP_ACCOUNT_MISMATCH");
    }
    const payload = {
      upsert: true,
      items: selected.map((item) => ({
        email: String(item.email || "").trim().toLowerCase(),
        password: item.password_available ? String(item.password || "") : "",
        label: accountLabel(item),
        extra: String(item.custom_name || item.display_name || "").trim().slice(0, 2000),
      })),
    };
    const result = await this.request("/api/admin/mailboxes", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const items = Array.isArray(result?.items) ? result.items : [];
    if (items.length !== selected.length) {
      throw publicError("取件站返回的账号数量不完整", 502, "PICKUP_RESULT_INCOMPLETE");
    }
    return {
      imported: items.length,
      with_password: selected.filter((item) => item.password_available).length,
      without_password: selected.filter((item) => !item.password_available).length,
      items: items.map((item) => ({
        id: item.id,
        email: item.email,
        pickup_url: item.pickup_url,
        delivery_line: item.delivery_line,
      })),
      delivery_text: items.map((item) => item.delivery_line).join("\n"),
      admin_url: this.publicUrl ? `${this.publicUrl}/admin` : "",
    };
  }
}

export const pickupInternals = { normalizeIds, accountLabel };
