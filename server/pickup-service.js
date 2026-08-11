function publicError(message, status = 500, code = "PICKUP_SERVICE_ERROR") {
  return Object.assign(new Error(message), { status, code });
}

function normalizeBaseUrl(value) {
  const text = String(value || "http://127.0.0.1:4190").trim().replace(/\/+$/, "");
  let parsed;
  try { parsed = new URL(text); } catch {
    throw publicError("取件站服务地址无效", 500, "PICKUP_CONFIG_INVALID");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw publicError("取件站服务地址无效", 500, "PICKUP_CONFIG_INVALID");
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

function normalizeAddressIds(input, maximum = 500) {
  if (!Array.isArray(input?.ids)) {
    throw publicError("请选择要上架的源头邮箱地址", 400, "PICKUP_ADDRESS_IDS_REQUIRED");
  }
  const ids = [...new Set(input.ids.map(Number))];
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw publicError("请选择有效的源头邮箱地址", 400, "PICKUP_ADDRESS_IDS_INVALID");
  }
  if (ids.length > maximum) {
    throw publicError(`单次最多上架 ${maximum} 个邮箱`, 400, "PICKUP_ADDRESS_IDS_LIMIT");
  }
  return ids;
}

function accountLabel(account) {
  const type = String(account.account_type || account.plan || "").trim();
  const group = String(account.group_name || "").trim();
  return [...new Set([type && `ChatGPT ${type.toUpperCase()}`, group].filter(Boolean))].join(" · ").slice(0, 200);
}

const addressTypeLabels = {
  icloud_mail_alias: "iCloud 邮箱别名",
  icloud_hide_my_email: "iCloud 隐藏邮箱",
  icloud_custom_domain: "iCloud 自定义域名",
  official: "官方邮箱别名",
};

function addressTypeLabel(item) {
  return addressTypeLabels[String(item?.strategy || "")] || "邮箱别名";
}

function publicSourceAddress(item) {
  const chatgptRegistered = Boolean(item.chatgpt_registered);
  const sourceConnected = item.source_status === "connected";
  return {
    id: Number(item.id),
    email: String(item.email || "").trim().toLowerCase(),
    label: String(item.label || ""),
    purpose: String(item.purpose || ""),
    strategy: String(item.strategy || ""),
    type_label: addressTypeLabel(item),
    source_account_id: Number(item.source_account_id),
    source_email: String(item.source_email || "").trim().toLowerCase(),
    source_provider: String(item.source_provider || ""),
    source_status: String(item.source_status || ""),
    chatgpt_registered: chatgptRegistered,
    chatgpt_registration_completed: Boolean(item.chatgpt_registration_completed),
    chatgpt_registration_occupied: Boolean(item.chatgpt_registration_occupied),
    eligible: sourceConnected && !chatgptRegistered,
    blocked_reason: chatgptRegistered
      ? "已注册 ChatGPT，禁止上架"
      : sourceConnected ? "" : "源头邮箱未连接",
    created_at: String(item.created_at || ""),
  };
}

const pickupStatuses = new Set(["ready", "sold", "disabled"]);

function publicPickupStatus(item) {
  const email = String(item?.email || "").trim().toLowerCase();
  const status = String(item?.status || "").trim().toLowerCase();
  if (!email || !pickupStatuses.has(status)) return null;
  return {
    id: Number(item.id) || null,
    email,
    status,
    pickup_url: String(item.pickup_url || ""),
    created_at: String(item.created_at || ""),
    updated_at: String(item.updated_at || ""),
  };
}

export class PickupService {
  constructor({
    db,
    registration,
    baseUrl,
    publicUrl,
    username,
    password,
    fetchFn = globalThis.fetch,
  } = {}) {
    this.db = db;
    this.registration = registration;
    this.serviceConfigured = Boolean(String(baseUrl || "").trim());
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.publicUrl = String(publicUrl || baseUrl || "http://127.0.0.1:4190").trim().replace(/\/+$/, "");
    this.username = String(username || "admin");
    this.password = String(password || "");
    this.fetch = fetchFn;
  }

  configuration() {
    return {
      enabled: Boolean(this.serviceConfigured && this.password && this.registration && this.fetch),
      public_url: this.publicUrl,
      admin_url: `${this.publicUrl}/admin`,
    };
  }

  sourceAddresses() {
    if (!this.db) throw publicError("源头邮箱库存未配置", 503, "PICKUP_SOURCE_NOT_CONFIGURED");
    return this.db.prepare(`
      SELECT
        addresses.id,
        addresses.address AS email,
        addresses.label,
        addresses.purpose,
        addresses.strategy,
        addresses.created_at,
        source_accounts.id AS source_account_id,
        source_accounts.email AS source_email,
        source_accounts.provider AS source_provider,
        source_accounts.status AS source_status,
        EXISTS (
          SELECT 1 FROM registration_jobs
          WHERE lower(registration_jobs.email) = lower(addresses.address)
            AND lower(registration_jobs.status) = 'completed'
        ) AS chatgpt_registration_completed,
        EXISTS (
          SELECT 1 FROM registration_jobs
          WHERE lower(registration_jobs.email) = lower(addresses.address)
            AND registration_jobs.failure_reason = 'user_already_exists'
        ) AS chatgpt_registration_occupied,
        EXISTS (
          SELECT 1 FROM registration_jobs
          WHERE lower(registration_jobs.email) = lower(addresses.address)
            AND (
              lower(registration_jobs.status) = 'completed'
              OR registration_jobs.failure_reason = 'user_already_exists'
            )
        ) AS chatgpt_registered
      FROM addresses
      JOIN source_accounts ON source_accounts.id = addresses.account_id
      WHERE source_accounts.provider <> 'inbox_link'
        AND addresses.kind = 'official'
        AND addresses.status = 'active'
      ORDER BY addresses.created_at DESC, addresses.id DESC
    `).all().map(publicSourceAddress);
  }

  listSourceAddresses() {
    const items = this.sourceAddresses();
    return {
      items,
      total: items.length,
      eligible: items.filter((item) => item.eligible).length,
      blocked: items.filter((item) => !item.eligible).length,
    };
  }

  async importSourceAddresses(input = {}) {
    const ids = normalizeAddressIds(input);
    const inventory = this.sourceAddresses();
    const selected = inventory.filter((item) => ids.includes(Number(item.id)));
    if (selected.length !== ids.length) {
      throw publicError("选择中包含不属于源头邮箱导入库存的地址", 409, "PICKUP_ADDRESS_MISMATCH");
    }
    const blocked = selected.filter((item) => !item.eligible);
    if (blocked.length) {
      const detail = blocked.slice(0, 3).map((item) => `${item.email}（${item.blocked_reason}）`).join("、");
      throw publicError(`以下邮箱不能上架：${detail}`, 409, "PICKUP_ADDRESS_BLOCKED");
    }
    const payload = {
      upsert: true,
      clear_credentials: true,
      items: selected.map((item) => ({
        email: item.email,
        label: item.type_label,
        extra: [`源头邮箱 ${item.source_email}`, item.label, item.purpose].filter(Boolean).join(" · ").slice(0, 2000),
      })),
    };
    const result = await this.request("/api/admin/mailboxes", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const items = Array.isArray(result?.items) ? result.items : [];
    if (items.length !== selected.length) {
      throw publicError("取件站返回的邮箱数量不完整", 502, "PICKUP_RESULT_INCOMPLETE");
    }
    return {
      imported: items.length,
      items: items.map((item) => ({
        id: item.id,
        email: item.email,
        pickup_url: item.pickup_url,
        delivery_line: item.delivery_line,
      })),
      delivery_text: items.map((item) => item.delivery_line).join("\n"),
      admin_url: `${this.publicUrl}/admin`,
    };
  }

  async request(path, options = {}) {
    if (!this.serviceConfigured || !this.password) {
      throw publicError("取件站服务地址或管理员密码未配置", 503, "PICKUP_NOT_CONFIGURED");
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
      clear_credentials: false,
      items: selected.map((item) => ({
        email: String(item.email || "").trim().toLowerCase(),
        ...(item.password_available && item.password
          ? { password: String(item.password).slice(0, 500) }
          : {}),
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
      items: items.map((item) => ({
        id: item.id,
        email: item.email,
        pickup_url: item.pickup_url,
        delivery_line: item.delivery_line,
      })),
      delivery_text: items.map((item) => item.delivery_line).join("\n"),
      admin_url: `${this.publicUrl}/admin`,
    };
  }

  async listStatuses() {
    const result = await this.request("/api/admin/mailboxes");
    const items = (Array.isArray(result?.items) ? result.items : [])
      .map(publicPickupStatus)
      .filter(Boolean);
    return {
      enabled: true,
      admin_url: `${this.publicUrl}/admin`,
      items,
    };
  }
}

export const pickupInternals = {
  normalizeIds,
  normalizeAddressIds,
  accountLabel,
  addressTypeLabel,
  publicSourceAddress,
  publicPickupStatus,
};
