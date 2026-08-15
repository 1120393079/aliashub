import crypto from "node:crypto";
import { getSetting, nowIso, setSetting } from "./db.js";
import { materializeProxySession, maskProxy, parseProxyPool, redactProxySecrets } from "./registration-proxy.js";

const ACTIVE_STATUSES = new Set(["queued", "running", "cancel_requested"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const DEFAULT_TIMEOUT_MS = 12 * 60 * 1_000;
const PAYMENT_COUNTRY_CURRENCIES = Object.freeze({ DE: "EUR", TR: "USD", GB: "GBP" });

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function booleanSetting(db, key, fallback = true) {
  const value = String(getSetting(db, key, fallback ? "true" : "false")).trim().toLowerCase();
  return new Set(["1", "true", "yes", "on"]).has(value);
}

function normalizePaymentCountry(value) {
  const country = String(value ?? "DE").trim().toUpperCase();
  if (!Object.hasOwn(PAYMENT_COUNTRY_CURRENCIES, country)) {
    throw Object.assign(new Error("提链账单国家仅支持 DE、TR 或 GB"), { status: 400 });
  }
  return country;
}

function rotatePaymentProxySession(value) {
  const proxy = String(value || "");
  const match = proxy.match(/^([a-z][a-z\d+.-]*:\/\/)([^/@]+)(@.*)$/i);
  if (!match) return proxy;
  const sidMatch = match[2].match(/(^|-)sid-([A-Za-z0-9]+)(?=-|:)/i);
  if (sidMatch) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let token = "";
    for (let index = 0; index < sidMatch[2].length; index += 1) {
      token += alphabet[crypto.randomInt(0, alphabet.length)];
    }
    const prefix = sidMatch[0].slice(0, -sidMatch[2].length);
    return `${match[1]}${match[2].replace(sidMatch[0], `${prefix}${token}`)}${match[3]}`;
  }
  const sessionMatch = match[2].match(/-(\d+)$/);
  if (!sessionMatch || sessionMatch[1].length > 15) return proxy;
  let sessionId = String(crypto.randomInt(1, 10));
  while (sessionId.length < sessionMatch[1].length) sessionId += String(crypto.randomInt(0, 10));
  return `${match[1]}${match[2].slice(0, -sessionMatch[1].length)}${sessionId}${match[3]}`;
}

function selectedIds(input = {}) {
  const values = Array.isArray(input.ids) ? input.ids : [];
  const ids = [...new Set(values.map(Number))];
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw Object.assign(new Error("请选择要提链的注册账号"), { status: 400 });
  }
  if (ids.length > 50) {
    throw Object.assign(new Error("单次最多选择 50 个账号提链"), { status: 400 });
  }
  return ids;
}

function safeText(value, maximum = 500) {
  return redactProxySecrets(value instanceof Error ? value.message : String(value || ""))
    .replace(/\beyj[a-z0-9_-]{10,}(?:\.[a-z0-9_-]{4,}){1,2}\b/gi, "[REDACTED_TOKEN]")
    .slice(0, maximum);
}

function safeProviderUrl(value) {
  const source = String(value || "").trim();
  if (!source || source.length > 4_096) return "";
  try {
    const parsed = new URL(source);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return "";
    return hostname === "paypal.com" || hostname.endsWith(".paypal.com") ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function publicPaymentLink(row) {
  if (!row) return null;
  return {
    ...row,
    external_account_id: Number(row.external_account_id) || row.external_account_id,
    progress: Math.max(0, Math.min(100, Number(row.progress) || 0)),
    amount_due: row.amount_due === null || row.amount_due === undefined ? null : Number(row.amount_due),
  };
}

export class PaymentLinkService {
  constructor({
    db,
    registration,
    baseUrl = "",
    password = "",
    fetchFn = globalThis.fetch,
    pollIntervalMs = 1_500,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    this.db = db;
    this.registration = registration;
    this.baseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
    this.password = String(password || "");
    this.fetchFn = fetchFn;
    this.pollIntervalMs = Math.max(100, Number(pollIntervalMs) || 1_500);
    this.timeoutMs = Math.max(10_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.tracked = new Map();
    queueMicrotask(() => this.resumeActiveTasks());
  }

  configuration() {
    const { checkout, update } = this.proxyPools();
    const country = normalizePaymentCountry(getSetting(this.db, "payment_link_country", "DE"));
    return {
      configured: Boolean(this.baseUrl),
      proxy_count: checkout.length + update.length,
      checkout_proxy_count: checkout.length,
      update_proxy_count: update.length,
      checkout_proxies: checkout,
      update_proxies: update,
      masked_checkout_proxies: checkout.map(maskProxy),
      masked_update_proxies: update.map(maskProxy),
      proxy_source_url: getSetting(this.db, "payment_link_proxy_source_url", ""),
      country,
      currency: PAYMENT_COUNTRY_CURRENCIES[country],
      countries: Object.entries(PAYMENT_COUNTRY_CURRENCIES)
        .map(([code, currency]) => ({ code, currency })),
      force_country: "",
      payment_method: "paypal",
      rotate_checkout_proxy: booleanSetting(this.db, "payment_link_rotate_checkout_proxy", true),
      rotate_update_proxy: booleanSetting(this.db, "payment_link_rotate_update_proxy", true),
      apply_checkout_update: booleanSetting(this.db, "payment_link_apply_checkout_update", true),
    };
  }

  proxyPools() {
    const legacy = parseProxyPool(getSetting(this.db, "payment_link_proxy_pool", "[]"));
    const checkout = parseProxyPool(getSetting(this.db, "payment_link_checkout_proxy_pool", "[]"));
    const update = parseProxyPool(getSetting(this.db, "payment_link_update_proxy_pool", "[]"));
    return {
      checkout: checkout.length ? checkout : legacy,
      update: update.length ? update : legacy,
    };
  }

  saveProxyPool(input) {
    const legacyInput = Array.isArray(input) || typeof input === "string";
    const checkout = parseProxyPool(legacyInput ? input : input?.checkout_proxies);
    const update = parseProxyPool(legacyInput ? input : input?.update_proxies);
    const country = input?.country === undefined ? null : normalizePaymentCountry(input.country);
    const switches = [
      ["payment_link_rotate_checkout_proxy", input?.rotate_checkout_proxy],
      ["payment_link_rotate_update_proxy", input?.rotate_update_proxy],
      ["payment_link_apply_checkout_update", input?.apply_checkout_update],
    ];
    for (const [, value] of switches) {
      if (value !== undefined && typeof value !== "boolean") {
        throw Object.assign(new Error("提链开关参数必须为布尔值"), { status: 400 });
      }
    }
    setSetting(this.db, "payment_link_checkout_proxy_pool", JSON.stringify(checkout));
    setSetting(this.db, "payment_link_update_proxy_pool", JSON.stringify(update));
    if (country) setSetting(this.db, "payment_link_country", country);
    for (const [key, value] of switches) {
      if (typeof value === "boolean") setSetting(this.db, key, String(value));
    }
    const pools = [
      ["payment_link_checkout_proxy_cursor", checkout],
      ["payment_link_update_proxy_cursor", update],
    ];
    for (const [key, proxies] of pools) {
      const cursor = Number(getSetting(this.db, key, "0"));
      if (!proxies.length || !Number.isSafeInteger(cursor) || cursor >= proxies.length) {
        setSetting(this.db, key, "0");
      }
    }
    return this.configuration();
  }

  async refreshProxySource(input = {}) {
    const sourceUrl = String(input.url || "").trim();
    let parsed;
    try { parsed = new URL(sourceUrl); } catch {
      throw Object.assign(new Error("请填写有效的 IPRocket 代理订阅地址"), { status: 400 });
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "app.iprocket.io" || sourceUrl.length > 2_048) {
      throw Object.assign(new Error("仅支持 IPRocket HTTPS 代理订阅地址"), { status: 400 });
    }
    const result = await this.request(`/api/proxy/source?url=${encodeURIComponent(sourceUrl)}`);
    const proxies = parseProxyPool(Array.isArray(result?.proxies) ? result.proxies : []);
    if (!proxies.length) throw Object.assign(new Error("IPRocket 代理订阅没有返回代理"), { status: 502 });
    const saved = this.saveProxyPool({
      checkout_proxies: proxies,
      update_proxies: proxies,
    });
    setSetting(this.db, "payment_link_proxy_source_url", sourceUrl);
    return {
      ...saved,
      proxy_source_url: sourceUrl,
      imported: proxies.length,
      unique_count: new Set(proxies).size,
    };
  }

  list() {
    const items = this.db.prepare(`
      SELECT * FROM registered_account_payment_links
      ORDER BY updated_at DESC
    `).all().map(publicPaymentLink);
    return { ...this.configuration(), items };
  }

  row(accountId) {
    return this.db.prepare(`
      SELECT * FROM registered_account_payment_links WHERE external_account_id = ?
    `).get(String(accountId));
  }

  persist(accountId, values = {}) {
    const existing = this.row(accountId);
    const timestamp = nowIso();
    const row = {
      external_account_id: String(accountId),
      email: String(values.email ?? existing?.email ?? "").trim().toLowerCase(),
      task_id: String(values.task_id ?? existing?.task_id ?? ""),
      status: String(values.status ?? existing?.status ?? "queued"),
      stage: String(values.stage ?? existing?.stage ?? "queued").slice(0, 100),
      progress: Math.max(0, Math.min(100, Number(values.progress ?? existing?.progress) || 0)),
      provider_url: String(values.provider_url ?? existing?.provider_url ?? "").slice(0, 4_096),
      proxy_label: String(values.proxy_label ?? existing?.proxy_label ?? "").slice(0, 240),
      checkout_proxy_label: String(values.checkout_proxy_label ?? existing?.checkout_proxy_label ?? "").slice(0, 240),
      update_proxy_label: String(values.update_proxy_label ?? existing?.update_proxy_label ?? "").slice(0, 240),
      session_kind: String(values.session_kind ?? existing?.session_kind ?? "").slice(0, 120),
      billing_country: String(values.billing_country ?? existing?.billing_country ?? "").slice(0, 12),
      currency: String(values.currency ?? existing?.currency ?? "").slice(0, 12),
      amount_due: values.amount_due === null ? null : Number(values.amount_due ?? existing?.amount_due),
      error: safeText(values.error ?? existing?.error ?? ""),
      started_at: values.started_at ?? existing?.started_at ?? null,
      finished_at: values.finished_at ?? existing?.finished_at ?? null,
      created_at: existing?.created_at || timestamp,
      updated_at: timestamp,
    };
    if (!row.email) row.email = `account-${accountId}`;
    if (!Number.isFinite(row.amount_due)) row.amount_due = null;
    this.db.prepare(`
      INSERT INTO registered_account_payment_links (
        external_account_id, email, task_id, status, stage, progress, provider_url,
        proxy_label, checkout_proxy_label, update_proxy_label,
        session_kind, billing_country, currency, amount_due, error,
        started_at, finished_at, created_at, updated_at
      ) VALUES (
        @external_account_id, @email, @task_id, @status, @stage, @progress, @provider_url,
        @proxy_label, @checkout_proxy_label, @update_proxy_label,
        @session_kind, @billing_country, @currency, @amount_due, @error,
        @started_at, @finished_at, @created_at, @updated_at
      )
      ON CONFLICT(external_account_id) DO UPDATE SET
        email = excluded.email,
        task_id = excluded.task_id,
        status = excluded.status,
        stage = excluded.stage,
        progress = excluded.progress,
        provider_url = excluded.provider_url,
        proxy_label = excluded.proxy_label,
        checkout_proxy_label = excluded.checkout_proxy_label,
        update_proxy_label = excluded.update_proxy_label,
        session_kind = excluded.session_kind,
        billing_country = excluded.billing_country,
        currency = excluded.currency,
        amount_due = excluded.amount_due,
        error = excluded.error,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        updated_at = excluded.updated_at
    `).run(row);
    return publicPaymentLink(this.row(accountId));
  }

  async request(path, options = {}) {
    if (!this.baseUrl) {
      throw Object.assign(new Error("提链服务尚未配置"), { status: 503 });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    timer.unref?.();
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(this.password ? { "X-Workbench-Password": this.password } : {}),
          ...options.headers,
        },
      });
      const contentType = response.headers?.get?.("content-type") || "";
      const data = contentType.includes("application/json") ? await response.json() : await response.text();
      if (!response.ok) {
        const error = new Error(safeText(data?.error || data || `提链服务返回 HTTP ${response.status}`));
        error.status = response.status === 404 ? 404 : 502;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw Object.assign(new Error("提链服务请求超时"), { status: 504 });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  applySnapshot(accountId, snapshot = {}) {
    const current = this.row(accountId);
    if (!current || (current.task_id && snapshot.task_id && current.task_id !== snapshot.task_id)) {
      return publicPaymentLink(current);
    }
    const remoteStatus = String(snapshot.status || "running").toLowerCase();
    const status = TERMINAL_STATUSES.has(remoteStatus) || ACTIVE_STATUSES.has(remoteStatus)
      ? remoteStatus : "running";
    const result = snapshot.result && typeof snapshot.result === "object" ? snapshot.result : {};
    let providerUrl = current.provider_url;
    let error = snapshot.error || "";
    if (status === "succeeded") {
      providerUrl = safeProviderUrl(result.paypal_url || result.provider_url);
      if (!providerUrl) error = "提链服务已完成，但没有返回有效 PayPal 链接";
    }
    const effectiveStatus = status === "succeeded" && !providerUrl ? "failed" : status;
    return this.persist(accountId, {
      status: effectiveStatus,
      stage: effectiveStatus === "failed" && status === "succeeded" ? "invalid_result" : snapshot.stage,
      progress: snapshot.progress,
      provider_url: effectiveStatus === "succeeded" ? providerUrl : "",
      session_kind: result.session_kind || snapshot.session_kind,
      billing_country: result.billing_country || snapshot.billing_country,
      currency: result.currency,
      amount_due: result.amount_due ?? null,
      error: effectiveStatus === "succeeded" ? "" : error,
      started_at: snapshot.started_at || current.started_at,
      finished_at: TERMINAL_STATUSES.has(effectiveStatus) ? (snapshot.finished_at || nowIso()) : null,
    });
  }

  track(accountId, taskId) {
    const key = String(accountId);
    if (this.tracked.has(key)) return this.tracked.get(key);
    const promise = (async () => {
      const deadline = Date.now() + this.timeoutMs;
      let failures = 0;
      while (Date.now() < deadline) {
        try {
          const snapshot = await this.request(`/api/tasks/${encodeURIComponent(taskId)}`);
          failures = 0;
          const item = this.applySnapshot(accountId, snapshot);
          if (TERMINAL_STATUSES.has(item?.status)) return item;
        } catch (error) {
          failures += 1;
          if (Number(error.status) === 404 || failures >= 5) {
            return this.persist(accountId, {
              status: "failed",
              stage: "service_error",
              error: Number(error.status) === 404
                ? "提链任务已从服务端过期或不存在"
                : safeText(error, 300) || "提链任务状态读取失败",
              finished_at: nowIso(),
            });
          }
        }
        await delay(this.pollIntervalMs);
      }
      try {
        await this.request(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
      } catch {
        // The local timeout remains authoritative when cancellation cannot be confirmed.
      }
      return this.persist(accountId, {
        status: "failed",
        stage: "timeout",
        error: "提链任务执行超时",
        finished_at: nowIso(),
      });
    })().finally(() => this.tracked.delete(key));
    this.tracked.set(key, promise);
    return promise;
  }

  resumeActiveTasks() {
    const rows = this.db.prepare(`
      SELECT external_account_id, task_id FROM registered_account_payment_links
      WHERE status IN ('queued', 'running', 'cancel_requested') AND task_id <> ''
    `).all();
    rows.forEach((row) => this.track(row.external_account_id, row.task_id));
  }

  async start(input = {}) {
    const ids = selectedIds(input);
    if (!this.baseUrl) throw Object.assign(new Error("提链服务尚未配置"), { status: 503 });
    const country = normalizePaymentCountry(
      input.country ?? getSetting(this.db, "payment_link_country", "DE"),
    );
    const currency = PAYMENT_COUNTRY_CURRENCIES[country];
    const { checkout: checkoutProxies, update: updateProxies } = this.proxyPools();
    const rotateCheckout = booleanSetting(this.db, "payment_link_rotate_checkout_proxy", true);
    const rotateUpdate = booleanSetting(this.db, "payment_link_rotate_update_proxy", true);
    const applyCheckoutUpdate = booleanSetting(this.db, "payment_link_apply_checkout_update", true);
    if (!checkoutProxies.length) {
      throw Object.assign(new Error("Checkout Proxy 池为空，请先保存代理"), { status: 409 });
    }
    if (applyCheckoutUpdate && !updateProxies.length) {
      throw Object.assign(new Error("Update Proxy 池为空，请先保存代理"), { status: 409 });
    }
    let checkoutCursor = Number(getSetting(this.db, "payment_link_checkout_proxy_cursor", "0"));
    let updateCursor = Number(getSetting(this.db, "payment_link_update_proxy_cursor", "0"));
    if (!Number.isSafeInteger(checkoutCursor) || checkoutCursor < 0) checkoutCursor = 0;
    if (!Number.isSafeInteger(updateCursor) || updateCursor < 0) updateCursor = 0;
    const usedSessions = new Set();
    const items = [];
    let started = 0;

    for (const accountId of ids) {
      const existing = this.row(accountId);
      if (existing && ACTIVE_STATUSES.has(existing.status)) {
        items.push({ ...publicPaymentLink(existing), accepted: false, error: "这个账号正在提链" });
        continue;
      }
      let credentials;
      try {
        credentials = await this.registration.registeredAccountAccessToken(accountId);
      } catch (error) {
        const item = this.persist(accountId, {
          email: existing?.email || "",
          task_id: "",
          status: "failed",
          stage: "credentials",
          progress: 0,
          provider_url: "",
          proxy_label: "",
          checkout_proxy_label: "",
          update_proxy_label: "",
          error: safeText(error) || "账号 AT 读取失败",
          started_at: nowIso(),
          finished_at: nowIso(),
        });
        items.push({ ...item, accepted: false });
        continue;
      }

      const checkoutSelected = checkoutProxies[checkoutCursor % checkoutProxies.length];
      const updateSelected = applyCheckoutUpdate
        ? updateProxies[updateCursor % updateProxies.length]
        : "";
      const checkoutProxy = rotateCheckout
        ? rotatePaymentProxySession(materializeProxySession(checkoutSelected, usedSessions))
        : checkoutSelected;
      const updateProxy = rotateUpdate && updateSelected
        ? rotatePaymentProxySession(materializeProxySession(updateSelected, usedSessions))
        : updateSelected;
      checkoutCursor += 1;
      if (applyCheckoutUpdate) updateCursor += 1;
      try {
        const snapshot = await this.request("/api/tasks", {
          method: "POST",
          body: JSON.stringify({
            access_token: credentials.access_token,
            checkout_proxy: checkoutProxy,
            update_proxy: updateProxy,
            country,
            payment_method: "paypal",
            apply_checkout_update: applyCheckoutUpdate,
          }),
        });
        if (!snapshot?.task_id) throw Object.assign(new Error("提链服务未返回任务 ID"), { status: 502 });
        const item = this.persist(accountId, {
          email: credentials.email,
          task_id: snapshot.task_id,
          status: ACTIVE_STATUSES.has(snapshot.status) ? snapshot.status : "queued",
          stage: snapshot.stage || "queued",
          progress: snapshot.progress,
          provider_url: "",
          proxy_label: maskProxy(checkoutProxy),
          checkout_proxy_label: maskProxy(checkoutProxy),
          update_proxy_label: maskProxy(updateProxy),
          session_kind: "",
          billing_country: snapshot.billing_country || country,
          currency,
          amount_due: null,
          error: "",
          started_at: snapshot.started_at || nowIso(),
          finished_at: null,
        });
        started += 1;
        items.push({ ...item, accepted: true });
        this.track(accountId, snapshot.task_id);
      } catch (error) {
        const item = this.persist(accountId, {
          email: credentials.email,
          task_id: "",
          status: "failed",
          stage: "submit",
          progress: 0,
          provider_url: "",
          proxy_label: maskProxy(checkoutProxy),
          checkout_proxy_label: maskProxy(checkoutProxy),
          update_proxy_label: maskProxy(updateProxy),
          error: safeText(error) || "提链任务提交失败",
          started_at: nowIso(),
          finished_at: nowIso(),
        });
        items.push({ ...item, accepted: false });
      }
    }
    setSetting(this.db, "payment_link_checkout_proxy_cursor", String(checkoutCursor % checkoutProxies.length));
    if (updateProxies.length) {
      setSetting(this.db, "payment_link_update_proxy_cursor", String(updateCursor % updateProxies.length));
    }
    return { requested: ids.length, started, failed: items.length - started, country, currency, items };
  }
}
