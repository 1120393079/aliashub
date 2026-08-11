import { ProxyAgent, request } from "undici";

const CHECKOUT_URL = "https://chatgpt.com/backend-api/payments/checkout";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";

export function checkoutTypeFromValue(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const classify = (candidate) => {
    const normalized = String(candidate || "").trim();
    if (normalized.startsWith("oaics_")) return "oaics";
    if (normalized.startsWith("cs_")) return "cs_live";
    return "";
  };
  const direct = classify(text);
  if (direct) return direct;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || !/(^|\.)chatgpt\.com$/i.test(url.hostname)) return "";
    for (const segment of url.pathname.split("/").filter(Boolean).reverse()) {
      const result = classify(decodeURIComponent(segment));
      if (result) return result;
    }
  } catch {
    return "";
  }
  return "";
}

export function checkoutTypeFromAccount(account = {}) {
  const candidates = [
    account.cashier_url,
    account.checkout_url,
    account.overview?.cashier_url,
    account.overview?.checkout_url,
  ];
  for (const candidate of candidates) {
    const result = checkoutTypeFromValue(candidate);
    if (result) return result;
  }
  return "";
}

function checkoutErrorCode(text) {
  try {
    const payload = JSON.parse(text);
    let detail = payload?.detail;
    if (typeof detail === "string") {
      try { detail = JSON.parse(detail); } catch { /* Keep the plain detail string. */ }
    }
    const code = String(detail?.code || payload?.code || "").trim();
    return /^[a-z0-9_]{1,80}$/i.test(code) ? code : "";
  } catch {
    return "";
  }
}

export async function probeCheckoutType({ accessToken, proxy, requestFn = request, proxyAgentFactory } = {}) {
  const token = String(accessToken || "").trim();
  const proxyUrl = String(proxy || "").trim();
  if (!token) throw Object.assign(new Error("账号缺少 AT"), { status: 409 });
  if (!proxyUrl) throw Object.assign(new Error("未配置 DE Checkout 代理"), { status: 503 });

  const dispatcher = proxyAgentFactory
    ? proxyAgentFactory(proxyUrl)
    : new ProxyAgent(proxyUrl);
  try {
    const response = await requestFn(CHECKOUT_URL, {
      method: "POST",
      dispatcher,
      headers: {
        authorization: `Bearer ${token}`,
        referer: "https://chatgpt.com/",
        "x-openai-target-path": "/backend-api/payments/checkout",
        "x-openai-target-route": "/backend-api/payments/checkout",
        "user-agent": USER_AGENT,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        entry_point: "all_plans_pricing_modal",
        plan_name: "chatgptplusplan",
        billing_details: { country: "DE", currency: "EUR" },
        checkout_ui_mode: "custom",
      }),
      headersTimeout: 45_000,
      bodyTimeout: 45_000,
    });
    const text = await response.body.text();
    if (response.statusCode !== 200) {
      throw Object.assign(new Error(`Checkout 创建失败 HTTP ${response.statusCode}`), {
        status: response.statusCode === 429 ? 429 : 502,
        code: checkoutErrorCode(text),
      });
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw Object.assign(new Error("Checkout 服务返回了无效 JSON"), { status: 502 });
    }
    const checkoutId = String(
      payload?.checkout_session_id || payload?.session_id || payload?.id || "",
    ).trim();
    const checkoutType = checkoutTypeFromValue(checkoutId);
    if (checkoutType) return checkoutType;
    throw Object.assign(new Error("Checkout 响应未包含 cs_live 或 oaics"), { status: 502 });
  } finally {
    try {
      await dispatcher.close?.();
    } catch {
      dispatcher.destroy?.();
    }
  }
}
