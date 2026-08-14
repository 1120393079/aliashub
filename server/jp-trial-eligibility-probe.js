import crypto from "node:crypto";
import { ProxyAgent, request } from "undici";

const CHECKOUT_URL = "https://chatgpt.com/backend-api/payments/checkout";
const CHECKOUT_UPDATE_URL = "https://chatgpt.com/backend-api/payments/checkout/update";
const STRIPE_INIT_BASE_URL = "https://api.stripe.com/v1/payment_pages";
const STRIPE_VERSION = "2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1";
const PROMO_ID = "plus-1-month-free";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";
const INIT_ATTEMPTS = 4;
const INIT_RETRY_DELAY_MS = 2_000;

export const JP_ZERO_TRIAL_EVIDENCE = "checkout.jp.plus.final_amount_due.v1";

function boundedErrorText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
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

function findString(payload, keys, predicate = () => true) {
  const stack = [payload];
  while (stack.length) {
    const value = stack.shift();
    if (!value || typeof value !== "object") continue;
    if (!Array.isArray(value)) {
      for (const key of keys) {
        const candidate = String(value[key] || "").trim();
        if (candidate && predicate(candidate)) return candidate;
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return "";
}

function parseJson(text, label) {
  try {
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
    return payload;
  } catch {
    throw Object.assign(new Error(`${label}返回了无效 JSON`), { status: 502 });
  }
}

export function amountDueFromJpCheckout(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidates = [
    payload?.checkout_state?.total?.total?.minorUnitsAmount,
    payload?.checkout_state?.total?.total?.minor_units_amount,
    payload?.checkout_state?.total?.amount_due,
    payload?.total_summary?.due,
    payload?.invoice?.amount_due,
  ];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === "") continue;
    const amount = Number(candidate);
    if (Number.isFinite(amount)) return amount;
  }
  if (Array.isArray(payload.line_items) && payload.line_items.length) {
    let total = 0;
    for (const item of payload.line_items) {
      const amount = Number(item?.amount);
      if (!Number.isFinite(amount)) return null;
      total += amount;
    }
    return total;
  }
  return null;
}

function chatgptHeaders(token, path) {
  return {
    authorization: `Bearer ${token}`,
    origin: "https://chatgpt.com",
    referer: path === "/backend-api/payments/checkout"
      ? `https://chatgpt.com/?promo_campaign=${PROMO_ID}#pricing`
      : "https://chatgpt.com/",
    "x-openai-target-path": path,
    "x-openai-target-route": path,
    "oai-device-id": crypto.randomUUID(),
    "oai-language": "ja-JP",
    "accept-language": "ja-JP,ja;q=0.9,en;q=0.8",
    "user-agent": USER_AGENT,
    accept: "application/json",
    "content-type": "application/json",
  };
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function stripeInit({ requestFn, dispatcher, sessionId, publishableKey, retryDelayMs }) {
  const stripeJsId = crypto.randomUUID();
  const body = new URLSearchParams({
    browser_locale: "ja-JP",
    browser_timezone: "Asia/Tokyo",
    "elements_session_client[client_betas][0]": "custom_checkout_server_updates_1",
    "elements_session_client[client_betas][1]": "custom_checkout_manual_approval_1",
    "elements_session_client[elements_init_source]": "custom_checkout",
    "elements_session_client[referrer_host]": "chatgpt.com",
    "elements_session_client[stripe_js_id]": stripeJsId,
    "elements_session_client[locale]": "ja",
    "elements_session_client[is_aggregation_expected]": "false",
    "elements_options_client[saved_payment_method][enable_save]": "never",
    "elements_options_client[saved_payment_method][enable_redisplay]": "never",
    key: publishableKey,
    _stripe_version: STRIPE_VERSION,
  }).toString();

  let lastError;
  for (let attempt = 1; attempt <= INIT_ATTEMPTS; attempt += 1) {
    if (attempt > 1 && retryDelayMs > 0) await sleep(retryDelayMs);
    const response = await requestFn(`${STRIPE_INIT_BASE_URL}/${encodeURIComponent(sessionId)}/init`, {
      method: "POST",
      dispatcher,
      headers: {
        origin: "https://checkout.stripe.com",
        referer: "https://checkout.stripe.com/",
        "user-agent": USER_AGENT,
        "accept-language": "ja-JP,ja;q=0.9,en;q=0.8",
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      headersTimeout: 45_000,
      bodyTimeout: 45_000,
    });
    const text = await response.body.text();
    if (response.statusCode === 200) return parseJson(text, "日本 0 元 Checkout /init");
    const status = Number(response.statusCode) || 502;
    lastError = Object.assign(
      new Error(`日本 0 元 Checkout /init 失败 HTTP ${status}${text ? `: ${boundedErrorText(text)}` : ""}`),
      { status: status === 429 ? 429 : 502 },
    );
    if (status !== 404 || attempt === INIT_ATTEMPTS) throw lastError;
  }
  throw lastError || Object.assign(new Error("日本 0 元 Checkout /init 未返回有效结果"), { status: 502 });
}

async function closeDispatcher(dispatcher) {
  try {
    await dispatcher.close?.();
  } catch {
    dispatcher.destroy?.();
  }
}

export async function probeJpTrialEligibility({
  accessToken,
  proxy,
  requestFn = request,
  proxyAgentFactory,
  retryDelayMs = INIT_RETRY_DELAY_MS,
} = {}) {
  const token = String(accessToken || "").trim();
  const proxyUrl = String(proxy || "").trim();
  if (!token) throw Object.assign(new Error("账号缺少 AT"), { status: 409 });
  if (!proxyUrl) throw Object.assign(new Error("未配置 JP 0 元检测代理"), { status: 503 });

  const dispatcher = proxyAgentFactory ? proxyAgentFactory(proxyUrl) : new ProxyAgent(proxyUrl);
  try {
    const checkoutResponse = await requestFn(CHECKOUT_URL, {
      method: "POST",
      dispatcher,
      headers: chatgptHeaders(token, "/backend-api/payments/checkout"),
      body: JSON.stringify({
        entry_point: "all_plans_pricing_modal",
        plan_name: "chatgptplusplan",
        billing_details: { country: "JP", currency: "JPY" },
        checkout_ui_mode: "custom",
        cancel_url: "https://chatgpt.com/#pricing",
        promo_campaign: {
          promo_campaign_id: PROMO_ID,
          is_coupon_from_query_param: false,
        },
      }),
      headersTimeout: 45_000,
      bodyTimeout: 45_000,
    });
    const checkoutText = await checkoutResponse.body.text();
    if (checkoutResponse.statusCode !== 200) {
      const status = Number(checkoutResponse.statusCode) || 502;
      throw Object.assign(new Error(`日本 0 元 Checkout 创建失败 HTTP ${status}`), {
        status: status === 429 ? 429 : 502,
        code: checkoutErrorCode(checkoutText),
      });
    }
    const checkout = parseJson(checkoutText, "日本 0 元 Checkout 服务");
    const sessionId = findString(
      checkout,
      ["checkout_session_id", "session_id", "id", "stripe_session_id"],
      (value) => value.startsWith("cs_") || value.startsWith("oaics_"),
    );
    if (!sessionId) {
      throw Object.assign(new Error("日本 0 元 Checkout 未返回受支持的 session id"), { status: 502 });
    }

    if (sessionId.startsWith("oaics_")) {
      const amountDue = amountDueFromJpCheckout(checkout);
      if (amountDue === null) {
        throw Object.assign(new Error("日本 OAICS Checkout 未返回最终应付金额"), { status: 502 });
      }
      return {
        eligible: amountDue === 0,
        amountDue,
        currency: "JPY",
        evidence: JP_ZERO_TRIAL_EVIDENCE,
      };
    }

    const publishableKey = findString(
      checkout,
      ["stripe_publishable_key", "publishable_key", "publishableKey", "stripePublishableKey", "key"],
      (value) => value.startsWith("pk_"),
    );
    const processorEntity = findString(checkout, ["processor_entity", "processorEntity"]);
    if (!publishableKey) {
      throw Object.assign(new Error("日本 Checkout 未返回 Stripe publishable key"), { status: 502 });
    }
    if (!processorEntity) {
      throw Object.assign(new Error("日本 Checkout 未返回 processor entity"), { status: 502 });
    }

    const updateResponse = await requestFn(CHECKOUT_UPDATE_URL, {
      method: "POST",
      dispatcher,
      headers: chatgptHeaders(token, "/backend-api/payments/checkout/update"),
      body: JSON.stringify({
        checkout_session_id: sessionId,
        processor_entity: processorEntity,
        plan_name: "chatgptplusplan",
        price_interval: "month",
        seat_quantity: 1,
        billing_details: { country: "JP", currency: "JPY" },
        checkout_ui_mode: "custom",
        promo_campaign: {
          promo_campaign_id: PROMO_ID,
          is_coupon_from_query_param: false,
        },
      }),
      headersTimeout: 45_000,
      bodyTimeout: 45_000,
    });
    const updateText = await updateResponse.body.text();
    if (updateResponse.statusCode !== 200) {
      const status = Number(updateResponse.statusCode) || 502;
      throw Object.assign(new Error(`日本 0 元优惠更新失败 HTTP ${status}`), {
        status: status === 429 ? 429 : 502,
      });
    }
    parseJson(updateText, "日本 0 元优惠更新");

    const initialized = await stripeInit({
      requestFn, dispatcher, sessionId, publishableKey, retryDelayMs,
    });
    const amountDue = amountDueFromJpCheckout(initialized);
    if (amountDue === null) {
      throw Object.assign(new Error("日本 Stripe Checkout 未返回最终应付金额"), { status: 502 });
    }
    return {
      eligible: amountDue === 0,
      amountDue,
      currency: "JPY",
      evidence: JP_ZERO_TRIAL_EVIDENCE,
    };
  } finally {
    await closeDispatcher(dispatcher);
  }
}
