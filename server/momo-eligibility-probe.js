import crypto from "node:crypto";
import { ProxyAgent, request } from "undici";

const CHECKOUT_URL = "https://chatgpt.com/backend-api/payments/checkout";
const CHECKOUT_UPDATE_URL = "https://chatgpt.com/backend-api/payments/checkout/update";
const STRIPE_INIT_BASE_URL = "https://api.stripe.com/v1/payment_pages";
const STRIPE_VERSION = "2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const PROMO_CAMPAIGN_ID = "plus-1-month-free";
const INIT_ATTEMPTS = 4;
const INIT_RETRY_DELAY_MS = 2_000;

export const MOMO_CHECK_EVIDENCE = "stripe.free_trial.tax_refreshed_methods.v2";
export const MOMO_OPENAI_CHECK_EVIDENCE = "openai.free_trial.checkout_methods.v2";
export const MOMO_CHECK_EVIDENCES = Object.freeze([
  MOMO_CHECK_EVIDENCE,
  MOMO_OPENAI_CHECK_EVIDENCE,
]);

const VN_BILLING = {
  name: "Nguyen Van An",
  line1: "72 Le Thanh Ton",
  line2: "Ben Nghe Ward, District 1",
  city: "Ho Chi Minh City",
  state: "Ho Chi Minh City",
  postalCode: "70000",
  country: "VN",
};

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

export function paymentMethodsFromStripeInit(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const methods = [];
  const add = (value) => {
    const method = String(value || "").trim().toLowerCase();
    if (method && !methods.includes(method)) methods.push(method);
  };
  for (const key of ["payment_method_types", "ordered_payment_method_types", "available_payment_method_types"]) {
    if (Array.isArray(payload[key])) payload[key].forEach(add);
  }
  if (Array.isArray(payload.payment_method_specs)) {
    payload.payment_method_specs.forEach((spec) => add(spec?.type));
  }
  return methods;
}

export function amountDueFromStripeInit(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidates = [payload?.total_summary?.due, payload?.invoice?.amount_due];
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

export function paymentMethodsFromOpenAiCheckout(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const methods = [];
  const add = (value) => {
    const candidate = value && typeof value === "object"
      ? value.type || value.payment_method_type || value.id
      : value;
    const method = String(candidate || "").trim().toLowerCase();
    if (method && !methods.includes(method)) methods.push(method);
  };
  for (const key of ["payment_method_types", "custom_payment_methods"]) {
    if (Array.isArray(payload[key])) payload[key].forEach(add);
  }
  return methods;
}

export function amountDueFromOpenAiCheckout(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidates = [
    payload?.checkout_state?.total?.total?.minorUnitsAmount,
    payload?.checkout_state?.total?.total?.minor_units_amount,
  ];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === "") continue;
    const amount = Number(candidate);
    if (Number.isFinite(amount)) return amount;
  }
  return null;
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

async function closeDispatcher(dispatcher) {
  try {
    await dispatcher.close?.();
  } catch {
    dispatcher.destroy?.();
  }
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function chatgptHeaders(token, path) {
  return {
    authorization: `Bearer ${token}`,
    origin: "https://chatgpt.com",
    referer: path === "/backend-api/payments/checkout"
      ? "https://chatgpt.com/?promo_campaign=plus-1-month-free#pricing"
      : "https://chatgpt.com/",
    "x-openai-target-path": path,
    "x-openai-target-route": path,
    "oai-device-id": crypto.randomUUID(),
    "oai-language": "vi-VN",
    "accept-language": "vi-VN,vi;q=0.9,en;q=0.8",
    "user-agent": USER_AGENT,
    accept: "application/json",
    "content-type": "application/json",
  };
}

async function stripeInit({ requestFn, dispatcher, sessionId, publishableKey, stripeJsId, retryDelayMs }) {
  const initBody = new URLSearchParams({
    browser_locale: "vi-VN",
    browser_timezone: "Asia/Ho_Chi_Minh",
    "elements_session_client[client_betas][0]": "custom_checkout_server_updates_1",
    "elements_session_client[client_betas][1]": "custom_checkout_manual_approval_1",
    "elements_session_client[elements_init_source]": "custom_checkout",
    "elements_session_client[referrer_host]": "chatgpt.com",
    "elements_session_client[stripe_js_id]": stripeJsId,
    "elements_session_client[locale]": "vi",
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
        "accept-language": "vi-VN,vi;q=0.9,en;q=0.8",
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: initBody,
      headersTimeout: 45_000,
      bodyTimeout: 45_000,
    });
    const text = await response.body.text();
    if (response.statusCode === 200) return parseJson(text, "Stripe MoMo /init");
    const status = Number(response.statusCode) || 502;
    lastError = Object.assign(
      new Error(`Stripe MoMo /init 失败 HTTP ${status}${text ? `: ${boundedErrorText(text)}` : ""}`),
      { status: status === 429 ? 429 : 502 },
    );
    if (status !== 404 || attempt === INIT_ATTEMPTS) throw lastError;
  }
  throw lastError || Object.assign(new Error("Stripe MoMo /init 未返回有效结果"), { status: 502 });
}

async function updateStripeTaxRegion({ requestFn, dispatcher, sessionId, publishableKey, stripeJsId, elementsSessionId }) {
  const body = new URLSearchParams({
    "tax_region[country]": VN_BILLING.country,
    "tax_region[postal_code]": VN_BILLING.postalCode,
    "tax_region[line1]": VN_BILLING.line1,
    "tax_region[line2]": VN_BILLING.line2,
    "tax_region[city]": VN_BILLING.city,
    "tax_region[state]": VN_BILLING.state,
    browser_locale: "vi-VN",
    browser_timezone: "Asia/Ho_Chi_Minh",
    "elements_session_client[client_betas][0]": "custom_checkout_server_updates_1",
    "elements_session_client[client_betas][1]": "custom_checkout_manual_approval_1",
    "elements_session_client[elements_init_source]": "custom_checkout",
    "elements_session_client[referrer_host]": "chatgpt.com",
    "elements_session_client[stripe_js_id]": stripeJsId,
    "elements_session_client[session_id]": elementsSessionId,
    "elements_session_client[locale]": "vi",
    "elements_session_client[is_aggregation_expected]": "false",
    "elements_options_client[saved_payment_method][enable_save]": "never",
    "elements_options_client[saved_payment_method][enable_redisplay]": "never",
    key: publishableKey,
    _stripe_version: STRIPE_VERSION,
  });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await requestFn(`${STRIPE_INIT_BASE_URL}/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      dispatcher,
      headers: {
        origin: "https://checkout.stripe.com",
        referer: "https://checkout.stripe.com/",
        "user-agent": USER_AGENT,
        "accept-language": "vi-VN,vi;q=0.9,en;q=0.8",
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      headersTimeout: 45_000,
      bodyTimeout: 45_000,
    });
    const text = await response.body.text();
    if (response.statusCode === 200) return parseJson(text, "Stripe 越南地址刷新");
    let errorPayload = {};
    try { errorPayload = JSON.parse(text)?.error || {}; } catch { /* Use the bounded HTTP error below. */ }
    const unknown = errorPayload?.code === "parameter_unknown" ? String(errorPayload.param || "") : "";
    if (unknown && body.has(unknown)) {
      body.delete(unknown);
      continue;
    }
    const status = Number(response.statusCode) || 502;
    throw Object.assign(
      new Error(`Stripe 越南地址刷新失败 HTTP ${status}${text ? `: ${boundedErrorText(text)}` : ""}`),
      { status: status === 429 ? 429 : 502 },
    );
  }
  throw Object.assign(new Error("Stripe 越南地址刷新未返回有效结果"), { status: 502 });
}

export async function probeMomoEligibility({
  accessToken,
  proxy,
  requestFn = request,
  proxyAgentFactory,
  retryDelayMs = INIT_RETRY_DELAY_MS,
} = {}) {
  const token = String(accessToken || "").trim();
  const proxyUrl = String(proxy || "").trim();
  if (!token) throw Object.assign(new Error("账号缺少 AT"), { status: 409 });
  if (!proxyUrl) throw Object.assign(new Error("未配置 VN MoMo 检测代理"), { status: 503 });

  const dispatcher = proxyAgentFactory ? proxyAgentFactory(proxyUrl) : new ProxyAgent(proxyUrl);
  try {
    const checkoutResponse = await requestFn(CHECKOUT_URL, {
      method: "POST",
      dispatcher,
      headers: chatgptHeaders(token, "/backend-api/payments/checkout"),
      body: JSON.stringify({
        entry_point: "all_plans_pricing_modal",
        plan_name: "chatgptplusplan",
        billing_details: { country: "VN", currency: "VND" },
        checkout_ui_mode: "custom",
        cancel_url: "https://chatgpt.com/#pricing",
        promo_campaign: {
          promo_campaign_id: PROMO_CAMPAIGN_ID,
          is_coupon_from_query_param: false,
        },
      }),
      headersTimeout: 45_000,
      bodyTimeout: 45_000,
    });
    const checkoutText = await checkoutResponse.body.text();
    if (checkoutResponse.statusCode !== 200) {
      const status = Number(checkoutResponse.statusCode) || 502;
      throw Object.assign(new Error(`MoMo Checkout 创建失败 HTTP ${status}`), {
        status: status === 429 ? 429 : 502,
        code: checkoutErrorCode(checkoutText),
      });
    }
    const checkout = parseJson(checkoutText, "MoMo Checkout 服务");
    const sessionId = findString(
      checkout,
      ["checkout_session_id", "session_id", "id", "stripe_session_id"],
      (value) => value.startsWith("cs_") || value.startsWith("oaics_"),
    );
    if (!sessionId) {
      throw Object.assign(new Error("MoMo Checkout 响应未包含受支持的 checkout session id"), { status: 502 });
    }
    if (sessionId.startsWith("oaics_")) {
      const amountDue = amountDueFromOpenAiCheckout(checkout);
      if (amountDue !== 0) {
        throw Object.assign(
          new Error(`MoMo 免费试用结账金额不是 0 VND（due=${amountDue ?? "missing"}）`),
          { status: 502 },
        );
      }
      const methods = paymentMethodsFromOpenAiCheckout(checkout);
      if (!methods.length) {
        throw Object.assign(new Error("OpenAI MoMo 结账未返回 payment_method_types"), { status: 502 });
      }
      return {
        eligible: methods.includes("momo"),
        methods,
        amountDue,
        evidence: MOMO_OPENAI_CHECK_EVIDENCE,
      };
    }
    const publishableKey = findString(
      checkout,
      ["stripe_publishable_key", "publishable_key", "publishableKey", "stripePublishableKey", "key"],
      (value) => value.startsWith("pk_"),
    );
    const processorEntity = findString(checkout, ["processor_entity", "processorEntity"]);
    if (!publishableKey) throw Object.assign(new Error("MoMo Checkout 响应未包含 Stripe publishable key"), { status: 502 });
    if (!processorEntity) throw Object.assign(new Error("MoMo Checkout 响应未包含 processor entity"), { status: 502 });

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
        billing_details: { country: "VN", currency: "VND" },
        checkout_ui_mode: "custom",
        promo_campaign: {
          promo_campaign_id: PROMO_CAMPAIGN_ID,
          is_coupon_from_query_param: false,
        },
      }),
      headersTimeout: 45_000,
      bodyTimeout: 45_000,
    });
    const updateText = await updateResponse.body.text();
    if (updateResponse.statusCode !== 200) {
      const status = Number(updateResponse.statusCode) || 502;
      throw Object.assign(new Error(`MoMo 免费试用优惠更新失败 HTTP ${status}`), {
        status: status === 429 ? 429 : 502,
      });
    }
    const update = parseJson(updateText, "MoMo 免费试用优惠更新");
    if (update.success === false) {
      throw Object.assign(new Error("MoMo 免费试用优惠未生效"), { status: 502 });
    }

    const stripeJsId = crypto.randomUUID();
    const elementsSessionId = `elements_session_${crypto.randomUUID().replaceAll("-", "").slice(0, 11)}`;
    const initial = await stripeInit({
      requestFn, dispatcher, sessionId, publishableKey, stripeJsId, retryDelayMs,
    });
    const initialDue = amountDueFromStripeInit(initial);
    if (initialDue !== 0) {
      throw Object.assign(new Error(`MoMo 免费试用结账金额不是 0 VND（due=${initialDue ?? "missing"}）`), { status: 502 });
    }

    await updateStripeTaxRegion({
      requestFn, dispatcher, sessionId, publishableKey, stripeJsId, elementsSessionId,
    });
    const finalInit = await stripeInit({
      requestFn, dispatcher, sessionId, publishableKey, stripeJsId, retryDelayMs,
    });
    const finalDue = amountDueFromStripeInit(finalInit);
    if (finalDue !== 0) {
      throw Object.assign(new Error(`MoMo 免费试用最终结账金额不是 0 VND（due=${finalDue ?? "missing"}）`), { status: 502 });
    }
    const methods = paymentMethodsFromStripeInit(finalInit);
    if (!methods.length) {
      throw Object.assign(new Error("Stripe MoMo 最终结账未返回 payment_method_types"), { status: 502 });
    }
    return {
      eligible: methods.includes("momo"),
      methods,
      amountDue: finalDue,
      evidence: MOMO_CHECK_EVIDENCE,
    };
  } finally {
    await closeDispatcher(dispatcher);
  }
}
