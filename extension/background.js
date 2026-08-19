const DEFAULTS = {
  baseUrl: "__ALIAS_HUB_BASE_URL__",
  apiKey: "__ALIAS_HUB_EXTENSION_KEY__",
};

async function config() {
  const stored = await chrome.storage.local.get(["baseUrl", "apiKey"]);
  return {
    baseUrl: String(stored.baseUrl || DEFAULTS.baseUrl).replace(/\/$/, ""),
    apiKey: stored.apiKey || (DEFAULTS.apiKey.startsWith("__") ? "" : DEFAULTS.apiKey),
  };
}

async function api(path, options = {}) {
  const current = await config();
  if (!current.apiKey) throw new Error("请先填写扩展配对密钥");
  const response = await fetch(`${current.baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      "X-AliasHub-Extension-Key": current.apiKey,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `注册工作站 HTTP ${response.status}`);
  return data;
}

async function clearMicrosoftWebSession() {
  const cookies = await chrome.cookies.getAll({ domain: "live.com" });
  const removed = await Promise.all(cookies.map((cookie) => {
    const details = {
      url: `https://${cookie.domain.replace(/^\./, "")}${cookie.path || "/"}`,
      name: cookie.name,
      storeId: cookie.storeId,
    };
    if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
    return chrome.cookies.remove(details);
  }));
  return removed.filter(Boolean).length;
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["baseUrl", "apiKey"]);
  const next = {};
  if (!stored.baseUrl) next.baseUrl = DEFAULTS.baseUrl;
  if (!stored.apiKey && !DEFAULTS.apiKey.startsWith("__")) next.apiKey = DEFAULTS.apiKey;
  if (Object.keys(next).length) await chrome.storage.local.set(next);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "api") return api(message.path, { method: message.method, body: message.body });
    if (message.type === "getConfig") return config();
    if (message.type === "saveConfig") {
      await chrome.storage.local.set({ baseUrl: message.baseUrl.replace(/\/$/, ""), apiKey: message.apiKey.trim() });
      return { ok: true };
    }
    if (message.type === "switchMicrosoftAccount") {
      return { removedCookies: await clearMicrosoftWebSession() };
    }
    if (message.type === "openAliases") {
      const accounts = await api("/api/extension/accounts");
      const target = accounts.items[0];
      if (!target) throw new Error("请先在注册工作站选择一个源头邮箱");
      await chrome.tabs.create({ url: target.officialUrl });
      return { ok: true };
    }
    throw new Error("未知扩展操作");
  })().then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
