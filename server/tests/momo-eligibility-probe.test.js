import assert from "node:assert/strict";
import test from "node:test";
import {
  amountDueFromOpenAiCheckout,
  amountDueFromStripeInit,
  MOMO_CHECK_EVIDENCE,
  MOMO_OPENAI_CHECK_EVIDENCE,
  paymentMethodsFromOpenAiCheckout,
  paymentMethodsFromStripeInit,
  probeMomoEligibility,
} from "../momo-eligibility-probe.js";

function response(statusCode, payload) {
  return {
    statusCode,
    body: {
      async text() {
        return typeof payload === "string" ? payload : JSON.stringify(payload);
      },
    },
  };
}

function checkoutPayload() {
  return {
    checkout_session_id: "cs_live_private-value",
    stripe_publishable_key: "pk_live_private-value",
    processor_entity: "openai_llc",
  };
}

function flowRequest({ initialMethods = ["card", "momo"], finalMethods = ["card", "momo"], due = 0 } = {}) {
  const calls = [];
  let initCount = 0;
  const requestFn = async (url, options) => {
    calls.push({ url, options });
    if (url === "https://chatgpt.com/backend-api/payments/checkout") {
      return response(200, checkoutPayload());
    }
    if (url === "https://chatgpt.com/backend-api/payments/checkout/update") {
      return response(200, { success: true });
    }
    if (url.endsWith("/init")) {
      initCount += 1;
      return response(200, {
        payment_method_types: initCount === 1 ? initialMethods : finalMethods,
        total_summary: { due },
      });
    }
    if (url.endsWith("/payment_pages/cs_live_private-value")) {
      return response(200, { tax_region: { country: "VN" } });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return { calls, requestFn };
}

test("MoMo probe follows the zero-due VN free-trial checkout contract through one dispatcher", async () => {
  const dispatcher = {
    closed: false,
    async close() { this.closed = true; },
  };
  const { calls, requestFn } = flowRequest();
  const result = await probeMomoEligibility({
    accessToken: "test-access-token",
    proxy: "http://vn-proxy.example:8080",
    proxyAgentFactory(proxy) {
      assert.equal(proxy, "http://vn-proxy.example:8080");
      return dispatcher;
    },
    requestFn,
    retryDelayMs: 0,
  });

  assert.deepEqual(result, {
    eligible: true,
    methods: ["card", "momo"],
    amountDue: 0,
    evidence: MOMO_CHECK_EVIDENCE,
  });
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => call.options.dispatcher === dispatcher));
  assert.equal(calls[0].options.headers.authorization, "Bearer test-access-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    entry_point: "all_plans_pricing_modal",
    plan_name: "chatgptplusplan",
    billing_details: { country: "VN", currency: "VND" },
    checkout_ui_mode: "custom",
    cancel_url: "https://chatgpt.com/#pricing",
    promo_campaign: {
      promo_campaign_id: "plus-1-month-free",
      is_coupon_from_query_param: false,
    },
  });
  const update = JSON.parse(calls[1].options.body);
  assert.equal(update.checkout_session_id, "cs_live_private-value");
  assert.equal(update.promo_campaign.promo_campaign_id, "plus-1-month-free");
  assert.match(calls[2].url, /payment_pages\/cs_live_private-value\/init$/);
  assert.match(calls[3].url, /payment_pages\/cs_live_private-value$/);
  const taxBody = new URLSearchParams(calls[3].options.body);
  assert.equal(taxBody.get("tax_region[country]"), "VN");
  assert.equal(taxBody.get("tax_region[postal_code]"), "70000");
  assert.match(calls[4].url, /payment_pages\/cs_live_private-value\/init$/);
  assert.equal(dispatcher.closed, true);
});

test("MoMo probe uses the post-address final method list instead of an earlier candidate list", async () => {
  const { requestFn } = flowRequest({
    initialMethods: ["card", "momo", "apple_pay", "google_pay"],
    finalMethods: ["card", "link", "apple_pay", "google_pay"],
  });
  const result = await probeMomoEligibility({
    accessToken: "test-access-token",
    proxy: "http://vn-proxy.example:8080",
    proxyAgentFactory: () => ({ close: async () => {} }),
    requestFn,
    retryDelayMs: 0,
  });

  assert.deepEqual(result, {
    eligible: false,
    methods: ["card", "link", "apple_pay", "google_pay"],
    amountDue: 0,
    evidence: MOMO_CHECK_EVIDENCE,
  });
});

test("MoMo probe refuses to classify a paid checkout as the free-trial page", async () => {
  const { requestFn } = flowRequest({ due: 475000 });
  await assert.rejects(
    probeMomoEligibility({
      accessToken: "test-access-token",
      proxy: "http://vn-proxy.example:8080",
      proxyAgentFactory: () => ({ close: async () => {} }),
      requestFn,
      retryDelayMs: 0,
    }),
    (error) => error.status === 502 && /金额不是 0 VND/.test(error.message),
  );
});

test("MoMo probe classifies an OAICS checkout from the OpenAI response without Stripe requests", async () => {
  const calls = [];
  const requestFn = async (url, options) => {
    calls.push({ url, options });
    return response(200, {
      checkout_session_id: "oaics_private-value",
      checkout_provider: "open_ai",
      payment_method_types: ["card", "link"],
      checkout_state: {
        total: { total: { minorUnitsAmount: 0 } },
      },
    });
  };
  const result = await probeMomoEligibility({
    accessToken: "test-access-token",
    proxy: "http://vn-proxy.example:8080",
    proxyAgentFactory: () => ({ close: async () => {} }),
    requestFn,
    retryDelayMs: 0,
  });

  assert.deepEqual(result, {
    eligible: false,
    methods: ["card", "link"],
    amountDue: 0,
    evidence: MOMO_OPENAI_CHECK_EVIDENCE,
  });
  assert.equal(calls.length, 1);
});

test("MoMo probe detects MoMo in an OAICS checkout custom method list", async () => {
  const result = await probeMomoEligibility({
    accessToken: "test-access-token",
    proxy: "http://vn-proxy.example:8080",
    proxyAgentFactory: () => ({ close: async () => {} }),
    requestFn: async () => response(200, {
      checkout_session_id: "oaics_private-value",
      payment_method_types: ["card"],
      custom_payment_methods: [{ type: "momo" }],
      checkout_state: {
        total: { total: { minorUnitsAmount: "0" } },
      },
    }),
    retryDelayMs: 0,
  });

  assert.equal(result.eligible, true);
  assert.deepEqual(result.methods, ["card", "momo"]);
  assert.equal(result.evidence, MOMO_OPENAI_CHECK_EVIDENCE);
});

test("MoMo probe refuses to classify a paid OAICS checkout as the free-trial page", async () => {
  await assert.rejects(
    probeMomoEligibility({
      accessToken: "test-access-token",
      proxy: "http://vn-proxy.example:8080",
      proxyAgentFactory: () => ({ close: async () => {} }),
      requestFn: async () => response(200, {
        checkout_session_id: "oaics_private-value",
        payment_method_types: ["card", "momo"],
        checkout_state: {
          total: { total: { minorUnitsAmount: 475000 } },
        },
      }),
      retryDelayMs: 0,
    }),
    (error) => error.status === 502 && /金额不是 0 VND/.test(error.message),
  );
});

test("Stripe method and amount parsers handle observed response containers", () => {
  assert.deepEqual(paymentMethodsFromStripeInit({
    payment_method_types: ["card", "MOMO"],
    ordered_payment_method_types: ["momo", "paypal"],
    payment_method_specs: [{ type: "link" }],
  }), ["card", "momo", "paypal", "link"]);
  assert.equal(amountDueFromStripeInit({ total_summary: { due: 0 } }), 0);
  assert.equal(amountDueFromStripeInit({ invoice: { amount_due: "475000" } }), 475000);
  assert.equal(amountDueFromStripeInit({ payment_method_types: ["card"] }), null);
});

test("OpenAI method and amount parsers handle observed OAICS response containers", () => {
  assert.deepEqual(paymentMethodsFromOpenAiCheckout({
    payment_method_types: ["card", "MOMO"],
    custom_payment_methods: [{ type: "momo" }, { payment_method_type: "link" }],
  }), ["card", "momo", "link"]);
  assert.equal(amountDueFromOpenAiCheckout({
    checkout_state: { total: { total: { minorUnitsAmount: "0" } } },
  }), 0);
  assert.equal(amountDueFromOpenAiCheckout({ payment_method_types: ["card"] }), null);
});

test("MoMo probe retries transient Stripe init 404 and closes the dispatcher", async () => {
  const dispatcher = {
    closed: false,
    async close() { this.closed = true; },
  };
  let initialAttempt = 0;
  let successfulInit = 0;
  const requestFn = async (url) => {
    if (url === "https://chatgpt.com/backend-api/payments/checkout") return response(200, checkoutPayload());
    if (url === "https://chatgpt.com/backend-api/payments/checkout/update") return response(200, { success: true });
    if (url.endsWith("/init")) {
      initialAttempt += 1;
      if (initialAttempt === 1) return response(404, { error: "not ready" });
      successfulInit += 1;
      return response(200, { payment_method_types: ["card", "momo"], total_summary: { due: 0 } });
    }
    return response(200, { tax_region: { country: "VN" } });
  };
  const result = await probeMomoEligibility({
    accessToken: "test-access-token",
    proxy: "http://vn-proxy.example:8080",
    proxyAgentFactory: () => dispatcher,
    requestFn,
    retryDelayMs: 0,
  });
  assert.equal(result.eligible, true);
  assert.equal(successfulInit, 2);
  assert.equal(dispatcher.closed, true);
});

test("MoMo probe preserves checkout rate-limit classification", async () => {
  await assert.rejects(
    probeMomoEligibility({
      accessToken: "test-access-token",
      proxy: "http://vn-proxy.example:8080",
      proxyAgentFactory: () => ({ close: async () => {} }),
      requestFn: async () => response(429, {
        detail: { code: "checkout_creation_rate_limited" },
      }),
      retryDelayMs: 0,
    }),
    (error) => error.status === 429 && error.code === "checkout_creation_rate_limited",
  );
});
