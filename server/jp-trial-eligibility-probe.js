import crypto from "node:crypto";
import { Agent, ProxyAgent, request } from "undici";

const CHECKOUT_URL = "https://chatgpt.com/backend-api/payments/checkout";
const CHECKOUT_UPDATE_URL = "https://chatgpt.com/backend-api/payments/checkout/update";
const STRIPE_INIT_BASE_URL = "https://api.stripe.com/v1/payment_pages";
const DIRECT_TRACE_URL = "https://chatgpt.com/cdn-cgi/trace";
const STRIPE_VERSION = "2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1";
const PROMO_ID = "plus-1-month-free";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";
const INIT_ATTEMPTS = 4;
const INIT_RETRY_DELAY_MS = 2_000;

export const JP_ZERO_TRIAL_EVIDENCE = "checkout.jp.plus.final_amount_due.v1";
export const GB_ZERO_TRIAL_EVIDENCE = "checkout.gb.plus.final_amount_due.v1";
export const US_ZERO_TRIAL_EVIDENCE = "checkout.us.plus.final_amount_due.v1";
export const DIRECT_TRIAL_ROUTE = "direct";

const TRIAL_REGIONS = Object.freeze({
  JP: Object.freeze({
    country: "JP",
    currency: "JPY",
    locale: "ja-JP",
    elementsLocale: "ja",
    timezone: "Asia/Tokyo",
    acceptLanguage: "ja-JP,ja;q=0.9,en;q=0.8",
    label: "日本",
    evidence: JP_ZERO_TRIAL_EVIDENCE,
  }),
  GB: Object.freeze({
    country: "GB",
    currency: "GBP",
    locale: "en-GB",
    elementsLocale: "en-GB",
    timezone: "Europe/London",
    acceptLanguage: "en-GB,en;q=0.9",
    label: "英国",
    evidence: GB_ZERO_TRIAL_EVIDENCE,
  }),
  US: Object.freeze({
    country: "US",
    currency: "USD",
    locale: "en-US",
    elementsLocale: "en",
    timezone: "America/New_York",
    acceptLanguage: "en-US,en;q=0.9",
    label: "美国",
    evidence: US_ZERO_TRIAL_EVIDENCE,
    allowDirect: true,
  }),
});

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

export function amountDueFromCheckout(payload) {
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

export function amountDueFromJpCheckout(payload) {
  return amountDueFromCheckout(payload);
}

export function amountDueFromGbCheckout(payload) {
  return amountDueFromCheckout(payload);
}

export function amountDueFromUsCheckout(payload) {
  return amountDueFromCheckout(payload);
}

function currenciesFromCheckout(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const containers = [
    payload,
    payload?.checkout_state,
    payload?.checkout_state?.total,
    payload?.checkout_state?.total?.total,
    payload?.checkout_state?.total_summary,
    payload?.total_summary,
    payload?.invoice,
  ];
  const currencies = [];
  for (const container of containers) {
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    for (const key of ["currency", "currency_code", "currencyCode"]) {
      if (typeof container[key] !== "string") continue;
      const currency = container[key].trim().toUpperCase();
      if (/^[A-Z]{3}$/.test(currency) && !currencies.includes(currency)) currencies.push(currency);
    }
  }
  return currencies;
}

function verifiedCheckoutCurrency(payload, region, provider) {
  const currencies = currenciesFromCheckout(payload);
  const mismatch = currencies.find((currency) => currency !== region.currency);
  if (mismatch) {
    throw Object.assign(
      new Error(`${region.label} ${provider} Checkout 返回币种 ${mismatch}，与预期 ${region.currency} 不符`),
      { status: 502 },
    );
  }
  return currencies[0] || region.currency;
}

function chatgptHeaders(token, path, region) {
  return {
    authorization: `Bearer ${token}`,
    origin: "https://chatgpt.com",
    referer: path === "/backend-api/payments/checkout"
      ? `https://chatgpt.com/?promo_campaign=${PROMO_ID}#pricing`
      : "https://chatgpt.com/",
    "x-openai-target-path": path,
    "x-openai-target-route": path,
    "oai-device-id": crypto.randomUUID(),
    "oai-language": region.locale,
    "accept-language": region.acceptLanguage,
    "user-agent": USER_AGENT,
    accept: "application/json",
    "content-type": "application/json",
  };
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function stripeInit({ requestFn, dispatcher, sessionId, publishableKey, retryDelayMs, region }) {
  const stripeJsId = crypto.randomUUID();
  const body = new URLSearchParams({
    browser_locale: region.locale,
    browser_timezone: region.timezone,
    "elements_session_client[client_betas][0]": "custom_checkout_server_updates_1",
    "elements_session_client[client_betas][1]": "custom_checkout_manual_approval_1",
    "elements_session_client[elements_init_source]": "custom_checkout",
    "elements_session_client[referrer_host]": "chatgpt.com",
    "elements_session_client[stripe_js_id]": stripeJsId,
    "elements_session_client[locale]": region.elementsLocale,
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
      ...(dispatcher ? { dispatcher } : {}),
      headers: {
        origin: "https://checkout.stripe.com",
        referer: "https://checkout.stripe.com/",
        "user-agent": USER_AGENT,
        "accept-language": region.acceptLanguage,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      headersTimeout: 45_000,
      bodyTimeout: 45_000,
    });
    const text = await response.body.text();
    if (response.statusCode === 200) return parseJson(text, `${region.label} 0 元 Checkout /init`);
    const status = Number(response.statusCode) || 502;
    lastError = Object.assign(
      new Error(`${region.label} 0 元 Checkout /init 失败 HTTP ${status}${text ? `: ${boundedErrorText(text)}` : ""}`),
      { status: status === 429 ? 429 : 502 },
    );
    if (status !== 404 || attempt === INIT_ATTEMPTS) throw lastError;
  }
  throw lastError || Object.assign(new Error(`${region.label} 0 元 Checkout /init 未返回有效结果`), { status: 502 });
}

async function closeDispatcher(dispatcher) {
  try {
    await dispatcher.close?.();
  } catch {
    dispatcher.destroy?.();
  }
}

export async function probeDirectTrialCountry({ requestFn = request, directAgentFactory } = {}) {
  const dispatcher = directAgentFactory ? directAgentFactory() : new Agent();
  try {
    const response = await requestFn(DIRECT_TRACE_URL, {
      method: "GET",
      dispatcher,
      headers: {
        accept: "text/plain",
        "user-agent": USER_AGENT,
      },
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
    });
    const text = await response.body.text();
    if (response.statusCode !== 200) {
      throw Object.assign(new Error(`服务器直连出口检测失败 HTTP ${response.statusCode}`), { status: 503 });
    }
    const countryCode = text.match(/^loc=([a-z]{2})\r?$/im)?.[1]?.toUpperCase() || "";
    if (!countryCode) {
      throw Object.assign(new Error("服务器直连出口检测未返回国家代码"), { status: 503 });
    }
    return { countryCode };
  } finally {
    await closeDispatcher(dispatcher);
  }
}

async function probeTrialEligibility(region, {
  accessToken,
  proxy,
  requestFn = request,
  proxyAgentFactory,
  directAgentFactory,
  retryDelayMs = INIT_RETRY_DELAY_MS,
} = {}) {
  const token = String(accessToken || "").trim();
  const proxyUrl = String(proxy || "").trim();
  const direct = region.allowDirect === true && proxyUrl === DIRECT_TRIAL_ROUTE;
  if (!token) throw Object.assign(new Error("账号缺少 AT"), { status: 409 });
  if (!proxyUrl || (proxyUrl === DIRECT_TRIAL_ROUTE && !direct)) {
    throw Object.assign(new Error(`未配置 ${region.country} 0 元检测代理`), { status: 503 });
  }

  const dispatcher = direct
    ? (directAgentFactory ? directAgentFactory() : new Agent())
    : (proxyAgentFactory ? proxyAgentFactory(proxyUrl) : new ProxyAgent(proxyUrl));
  try {
    const checkoutResponse = await requestFn(CHECKOUT_URL, {
      method: "POST",
      ...(dispatcher ? { dispatcher } : {}),
      headers: chatgptHeaders(token, "/backend-api/payments/checkout", region),
      body: JSON.stringify({
        entry_point: "all_plans_pricing_modal",
        plan_name: "chatgptplusplan",
        billing_details: { country: region.country, currency: region.currency },
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
      throw Object.assign(new Error(`${region.label} 0 元 Checkout 创建失败 HTTP ${status}`), {
        status: status === 429 ? 429 : 502,
        code: checkoutErrorCode(checkoutText),
      });
    }
    const checkout = parseJson(checkoutText, `${region.label} 0 元 Checkout 服务`);
    const sessionId = findString(
      checkout,
      ["checkout_session_id", "session_id", "id", "stripe_session_id"],
      (value) => value.startsWith("cs_") || value.startsWith("oaics_"),
    );
    if (!sessionId) {
      throw Object.assign(new Error(`${region.label} 0 元 Checkout 未返回受支持的 session id`), { status: 502 });
    }

    if (sessionId.startsWith("oaics_")) {
      const currency = verifiedCheckoutCurrency(checkout, region, "OAICS");
      const amountDue = amountDueFromCheckout(checkout);
      if (amountDue === null) {
        throw Object.assign(new Error(`${region.label} OAICS Checkout 未返回最终应付金额`), { status: 502 });
      }
      return {
        eligible: amountDue === 0,
        amountDue,
        currency,
        evidence: region.evidence,
      };
    }

    const publishableKey = findString(
      checkout,
      ["stripe_publishable_key", "publishable_key", "publishableKey", "stripePublishableKey", "key"],
      (value) => value.startsWith("pk_"),
    );
    const processorEntity = findString(checkout, ["processor_entity", "processorEntity"]);
    if (!publishableKey) {
      throw Object.assign(new Error(`${region.label} Checkout 未返回 Stripe publishable key`), { status: 502 });
    }
    if (!processorEntity) {
      throw Object.assign(new Error(`${region.label} Checkout 未返回 processor entity`), { status: 502 });
    }

    const updateResponse = await requestFn(CHECKOUT_UPDATE_URL, {
      method: "POST",
      ...(dispatcher ? { dispatcher } : {}),
      headers: chatgptHeaders(token, "/backend-api/payments/checkout/update", region),
      body: JSON.stringify({
        checkout_session_id: sessionId,
        processor_entity: processorEntity,
        plan_name: "chatgptplusplan",
        price_interval: "month",
        seat_quantity: 1,
        billing_details: { country: region.country, currency: region.currency },
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
      throw Object.assign(new Error(`${region.label} 0 元优惠更新失败 HTTP ${status}`), {
        status: status === 429 ? 429 : 502,
      });
    }
    parseJson(updateText, `${region.label} 0 元优惠更新`);

    const initialized = await stripeInit({
      requestFn, dispatcher, sessionId, publishableKey, retryDelayMs, region,
    });
    const currency = verifiedCheckoutCurrency(initialized, region, "Stripe");
    const amountDue = amountDueFromCheckout(initialized);
    if (amountDue === null) {
      throw Object.assign(new Error(`${region.label} Stripe Checkout 未返回最终应付金额`), { status: 502 });
    }
    return {
      eligible: amountDue === 0,
      amountDue,
      currency,
      evidence: region.evidence,
    };
  } finally {
    if (dispatcher) await closeDispatcher(dispatcher);
  }
}

export async function probeJpTrialEligibility(options = {}) {
  return probeTrialEligibility(TRIAL_REGIONS.JP, options);
}

export async function probeGbTrialEligibility(options = {}) {
  return probeTrialEligibility(TRIAL_REGIONS.GB, options);
}

export async function probeUsTrialEligibility(options = {}) {
  return probeTrialEligibility(TRIAL_REGIONS.US, options);
}
