import crypto from "node:crypto";
import { ProxyAgent, request } from "undici";

const ACCOUNTS_CHECK_URL = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";
const PROMO_ID = "plus-1-month-free";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";

function eligibilityContainers(payload) {
  const containers = [payload];
  const accounts = payload?.accounts;
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return containers;
  if (Array.isArray(payload.account_ordering)) {
    for (const key of payload.account_ordering) {
      const account = typeof key === "string" ? accounts[key] : null;
      if (account && typeof account === "object" && !Array.isArray(account)) containers.push(account);
    }
  }
  if (accounts.default && typeof accounts.default === "object" && !Array.isArray(accounts.default)) {
    containers.push(accounts.default);
  }
  for (const account of Object.values(accounts)) {
    if (account && typeof account === "object" && !Array.isArray(account)) containers.push(account);
  }
  return containers;
}

function explicitEligibility(payload) {
  const stack = [{ value: payload, path: "" }];
  while (stack.length) {
    const { value, path } = stack.pop();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (new Set(["one_click_trial_eligible", "plus_trial_eligible"]).has(key)
        && typeof child === "boolean") {
        return { eligible: child, evidence: childPath };
      }
      if (child && typeof child === "object") stack.push({ value: child, path: childPath });
    }
  }
  return null;
}

export function classifyJpTrialEligibility(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw Object.assign(new Error("账号资格接口返回了无效数据"), { status: 502 });
  }
  for (const container of eligibilityContainers(payload)) {
    const campaigns = container.eligible_promo_campaigns;
    if (!campaigns || typeof campaigns !== "object" || Array.isArray(campaigns)
      || !Object.hasOwn(campaigns, "plus")) {
      continue;
    }
    const plus = campaigns.plus;
    const eligible = plus === true
      || (typeof plus === "string" && plus.trim() === PROMO_ID)
      || (plus && typeof plus === "object" && !Array.isArray(plus)
        && (Object.keys(plus).length > 0));
    return {
      eligible: Boolean(eligible),
      evidence: "eligible_promo_campaigns.plus",
    };
  }
  const explicit = explicitEligibility(payload);
  if (explicit) return explicit;
  return {
    eligible: false,
    evidence: "eligible_promo_campaigns.plus absent",
  };
}

export async function probeJpTrialEligibility({ accessToken, proxy, requestFn = request, proxyAgentFactory } = {}) {
  const token = String(accessToken || "").trim();
  const proxyUrl = String(proxy || "").trim();
  if (!token) throw Object.assign(new Error("账号缺少 AT"), { status: 409 });
  if (!proxyUrl) throw Object.assign(new Error("未配置 JP 资格检测代理"), { status: 503 });

  const dispatcher = proxyAgentFactory
    ? proxyAgentFactory(proxyUrl)
    : new ProxyAgent(proxyUrl);
  try {
    const response = await requestFn(ACCOUNTS_CHECK_URL, {
      method: "GET",
      dispatcher,
      headers: {
        authorization: `Bearer ${token}`,
        origin: "https://chatgpt.com",
        referer: `https://chatgpt.com/?promo_campaign=${PROMO_ID}#pricing`,
        "x-openai-target-path": "/backend-api/accounts/check/v4-2023-04-27",
        "x-openai-target-route": "/backend-api/accounts/check/v4-2023-04-27",
        "oai-device-id": crypto.randomUUID(),
        "oai-language": "ja-JP",
        "accept-language": "ja-JP,ja;q=0.9,en;q=0.8",
        "user-agent": USER_AGENT,
        accept: "application/json",
      },
      headersTimeout: 45_000,
      bodyTimeout: 45_000,
    });
    const text = await response.body.text();
    if (response.statusCode !== 200) {
      const status = Number(response.statusCode) || 502;
      throw Object.assign(new Error(`账号资格检测失败 HTTP ${status}`), {
        status: status === 429 ? 429 : 502,
      });
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw Object.assign(new Error("账号资格接口返回了无效 JSON"), { status: 502 });
    }
    return classifyJpTrialEligibility(payload);
  } finally {
    try {
      await dispatcher.close?.();
    } catch {
      dispatcher.destroy?.();
    }
  }
}
