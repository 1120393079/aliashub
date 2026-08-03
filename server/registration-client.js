export class RegistrationClient {
  constructor({ baseUrl, token, fetchFn = globalThis.fetch } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/$/, "");
    this.token = String(token || "");
    this.fetchFn = fetchFn;
  }

  get configured() {
    return Boolean(this.baseUrl && this.token && this.fetchFn);
  }

  async request(path, options = {}) {
    if (!this.configured) throw Object.assign(new Error("注册服务尚未配置"), { status: 503 });
    const { timeoutMs = 0, ...fetchOptions } = options;
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    timer?.unref?.();
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...fetchOptions,
        ...(controller ? { signal: controller.signal } : {}),
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
        body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
      });
      const contentType = response.headers?.get?.("content-type") || "";
      const data = contentType.includes("application/json") ? await response.json() : await response.text();
      if (!response.ok) {
        const message = data?.detail || data?.error || data || `注册服务请求失败 (HTTP ${response.status})`;
        throw Object.assign(new Error(String(message)), { status: response.status >= 500 ? 502 : response.status });
      }
      return data;
    } catch (error) {
      if (error?.name === "AbortError") throw Object.assign(new Error("注册服务请求超时"), { status: 504 });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  health() {
    if (!this.baseUrl || !this.fetchFn) return Promise.resolve({ ok: false, configured: false });
    return this.fetchFn(`${this.baseUrl}/api/health`, { headers: { Accept: "application/json" } })
      .then(async (response) => ({ ok: response.ok, configured: this.configured, ...(response.ok ? await response.json() : {}) }))
      .catch(() => ({ ok: false, configured: this.configured }));
  }

  createTask(payload) {
    return this.request("/api/tasks/register", { method: "POST", body: payload });
  }

  getRegistrationQueueControl() {
    return this.request("/api/tasks/register/control");
  }

  pauseRegistrationQueue() {
    return this.request("/api/tasks/register/pause-all", { method: "POST" });
  }

  resumeRegistrationQueue() {
    return this.request("/api/tasks/register/resume-all", { method: "POST" });
  }

  cancelRegistrationQueue() {
    return this.request("/api/tasks/register/cancel-all", { method: "POST" });
  }

  createAccountAction(accountId, actionId, params = {}) {
    return this.request(
      `/api/actions/chatgpt/${encodeURIComponent(accountId)}/${encodeURIComponent(actionId)}`,
      { method: "POST", body: { params } },
    );
  }

  async upsertOutlookEmailProviderSetting({ apiUrl, apiKey } = {}) {
    const normalizedApiUrl = String(apiUrl || "").trim().replace(/\/+$/, "");
    const normalizedApiKey = String(apiKey || "");
    if (!normalizedApiUrl || !normalizedApiKey) {
      throw Object.assign(new Error("邮箱连接配置不完整"), { status: 503 });
    }
    const response = await this.request("/api/provider-settings", {
      method: "POST",
      body: {
        provider_type: "mailbox",
        provider_key: "outlook_email_api",
        display_name: "AliasHub Outlook 邮箱",
        auth_mode: "apikey",
        enabled: true,
        is_default: false,
        config: { outlook_email_api_url: normalizedApiUrl },
        auth: { outlook_email_api_key: normalizedApiKey },
        metadata: { managed_by: "aliashub" },
      },
    });
    if (response?.ok !== true) {
      throw Object.assign(new Error("邮箱连接配置同步失败"), { status: 502 });
    }
    return { ok: true };
  }

  getTask(taskId) {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}`);
  }

  getTaskEvents(taskId, since = 0) {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}/events?since=${Number(since) || 0}&limit=300`);
  }

  getActionTask(taskId) {
    return this.getTask(taskId);
  }

  getActionTaskEvents(taskId, since = 0) {
    return this.getTaskEvents(taskId, since);
  }

  cancelTask(taskId) {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
  }

  pauseTask(taskId) {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}/pause`, { method: "POST" });
  }

  resumeTask(taskId) {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}/resume`, { method: "POST" });
  }

  cancelActionTask(taskId) {
    return this.cancelTask(taskId);
  }

  async releaseTask(taskId) {
    const encoded = encodeURIComponent(taskId);
    try {
      const result = await this.request(`/api/tasks/${encoded}/release`, {
        method: "POST",
        body: { force: true, reason: "aliashub_stuck_registration" },
      });
      return { ...(result && typeof result === "object" ? result : {}), release_mode: "force_release" };
    } catch (error) {
      if (error.status === 404 || error.status === 405) {
        throw Object.assign(new Error("注册服务尚未部署强制释放接口，请先更新兼容注册服务"), {
          status: 503,
          cause: error,
        });
      }
      throw error;
    }
  }

  inspectProxy(payload) {
    return this.request("/api/proxies/inspect", { method: "POST", body: payload, timeoutMs: 120_000 });
  }

  listAccounts({ email = "", page = 1, pageSize = 100 } = {}) {
    const params = new URLSearchParams({ platform: "chatgpt", page: String(page), page_size: String(pageSize) });
    if (email) params.set("email", email);
    return this.request(`/api/accounts?${params}`);
  }

  refreshAccountPlans(accountIds = [], proxiesById = {}) {
    const ids = [...new Set(accountIds.map(Number))]
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    if (!ids.length) return Promise.resolve({ updated: 0, items: [], timed_out: 0 });
    const normalizedProxies = {};
    for (const id of ids) {
      const proxy = typeof proxiesById?.[id] === "string" ? proxiesById[id].trim() : "";
      if (proxy) normalizedProxies[id] = proxy;
    }
    return this.request("/api/accounts/refresh-plan?platform=chatgpt", {
      method: "POST",
      body: { ids, proxies_by_id: normalizedProxies },
      timeoutMs: 120_000,
    });
  }

  getAccount(accountId) {
    return this.request(`/api/accounts/${encodeURIComponent(accountId)}`);
  }

  deleteAccount(accountId) {
    return this.request(`/api/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
  }
}
