import assert from "node:assert/strict";
import test from "node:test";
import {
  amountDueFromJpCheckout,
  DIRECT_TRIAL_ROUTE,
  GB_ZERO_TRIAL_EVIDENCE,
  JP_ZERO_TRIAL_EVIDENCE,
  US_ZERO_TRIAL_EVIDENCE,
  probeDirectTrialCountry,
  probeGbTrialEligibility,
  probeJpTrialEligibility,
  probeUsTrialEligibility,
} from "../jp-trial-eligibility-probe.js";

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

function stripeCheckoutPayload() {
  return {
    checkout_session_id: "cs_live_private-value",
    stripe_publishable_key: "pk_live_private-value",
    processor_entity: "openai_llc",
  };
}

function stripeFlowRequest(due, currency = "") {
  const calls = [];
  const requestFn = async (url, options) => {
    calls.push({ url, options });
    if (url === "https://chatgpt.com/backend-api/payments/checkout") {
      return response(200, stripeCheckoutPayload());
    }
    if (url === "https://chatgpt.com/backend-api/payments/checkout/update") {
      return response(200, { success: true });
    }
    if (url.endsWith("/payment_pages/cs_live_private-value/init")) {
      return response(200, {
        total_summary: { due, ...(currency ? { currency } : {}) },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return { calls, requestFn };
}

test("JP zero-price probe classifies a Stripe Checkout only from its final amount", async () => {
  const dispatcher = {
    closed: false,
    async close() { this.closed = true; },
  };
  const { calls, requestFn } = stripeFlowRequest(0);
  const result = await probeJpTrialEligibility({
    accessToken: "test-access-token",
    proxy: "http://jp-proxy.example:8080",
    proxyAgentFactory(proxy) {
      assert.equal(proxy, "http://jp-proxy.example:8080");
      return dispatcher;
    },
    requestFn,
    retryDelayMs: 0,
  });

  assert.deepEqual(result, {
    eligible: true,
    amountDue: 0,
    currency: "JPY",
    evidence: JP_ZERO_TRIAL_EVIDENCE,
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.options.dispatcher === dispatcher));
  const create = JSON.parse(calls[0].options.body);
  assert.deepEqual(create.billing_details, { country: "JP", currency: "JPY" });
  assert.equal(create.promo_campaign.promo_campaign_id, "plus-1-month-free");
  const update = JSON.parse(calls[1].options.body);
  assert.equal(update.checkout_session_id, "cs_live_private-value");
  assert.equal(update.promo_campaign.promo_campaign_id, "plus-1-month-free");
  assert.match(calls[2].url, /payment_pages\/cs_live_private-value\/init$/);
  assert.equal(dispatcher.closed, true);
});

test("JP zero-price probe classifies discounted Stripe Checkouts as non-zero", async () => {
  for (const due of [500, 1_500]) {
    const { requestFn } = stripeFlowRequest(due);
    const result = await probeJpTrialEligibility({
      accessToken: "test-access-token",
      proxy: "http://jp-proxy.example:8080",
      proxyAgentFactory: () => ({ close: async () => {} }),
      requestFn,
      retryDelayMs: 0,
    });
    assert.equal(result.eligible, false);
    assert.equal(result.amountDue, due);
    assert.equal(result.evidence, JP_ZERO_TRIAL_EVIDENCE);
  }
});

test("GB zero-price probe uses GB checkout, locale, timezone, and evidence", async () => {
  const dispatcher = {
    closed: false,
    async close() { this.closed = true; },
  };
  const { calls, requestFn } = stripeFlowRequest(0);
  const result = await probeGbTrialEligibility({
    accessToken: "test-access-token",
    proxy: "http://gb-proxy.example:8080",
    proxyAgentFactory(proxy) {
      assert.equal(proxy, "http://gb-proxy.example:8080");
      return dispatcher;
    },
    requestFn,
    retryDelayMs: 0,
  });

  assert.deepEqual(result, {
    eligible: true,
    amountDue: 0,
    currency: "GBP",
    evidence: GB_ZERO_TRIAL_EVIDENCE,
  });
  const create = JSON.parse(calls[0].options.body);
  assert.deepEqual(create.billing_details, { country: "GB", currency: "GBP" });
  assert.equal(calls[0].options.headers["oai-language"], "en-GB");
  assert.equal(calls[0].options.headers["accept-language"], "en-GB,en;q=0.9");

  const update = JSON.parse(calls[1].options.body);
  assert.deepEqual(update.billing_details, { country: "GB", currency: "GBP" });
  assert.equal(calls[1].options.headers["oai-language"], "en-GB");

  const init = new URLSearchParams(calls[2].options.body);
  assert.equal(init.get("browser_locale"), "en-GB");
  assert.equal(init.get("browser_timezone"), "Europe/London");
  assert.equal(init.get("elements_session_client[locale]"), "en-GB");
  assert.equal(calls[2].options.headers["accept-language"], "en-GB,en;q=0.9");
  assert.equal(dispatcher.closed, true);
});

test("US zero-price probe uses US checkout, locale, timezone, and evidence", async () => {
  const dispatcher = {
    closed: false,
    async close() { this.closed = true; },
  };
  const { calls, requestFn } = stripeFlowRequest(0);
  const result = await probeUsTrialEligibility({
    accessToken: "test-access-token",
    proxy: "http://us-proxy.example:8080",
    proxyAgentFactory(proxy) {
      assert.equal(proxy, "http://us-proxy.example:8080");
      return dispatcher;
    },
    requestFn,
    retryDelayMs: 0,
  });

  assert.deepEqual(result, {
    eligible: true,
    amountDue: 0,
    currency: "USD",
    evidence: US_ZERO_TRIAL_EVIDENCE,
  });
  const create = JSON.parse(calls[0].options.body);
  assert.deepEqual(create.billing_details, { country: "US", currency: "USD" });
  assert.equal(calls[0].options.headers["oai-language"], "en-US");
  assert.equal(calls[0].options.headers["accept-language"], "en-US,en;q=0.9");

  const update = JSON.parse(calls[1].options.body);
  assert.deepEqual(update.billing_details, { country: "US", currency: "USD" });
  assert.equal(calls[1].options.headers["oai-language"], "en-US");

  const init = new URLSearchParams(calls[2].options.body);
  assert.equal(init.get("browser_locale"), "en-US");
  assert.equal(init.get("browser_timezone"), "America/New_York");
  assert.equal(init.get("elements_session_client[locale]"), "en");
  assert.equal(calls[2].options.headers["accept-language"], "en-US,en;q=0.9");
  assert.equal(dispatcher.closed, true);
});

test("direct country probe verifies the AliasHub process egress and closes its dispatcher", async () => {
  const dispatcher = {
    closed: false,
    async close() { this.closed = true; },
  };
  const result = await probeDirectTrialCountry({
    directAgentFactory: () => dispatcher,
    requestFn: async (url, options) => {
      assert.equal(url, "https://chatgpt.com/cdn-cgi/trace");
      assert.equal(options.dispatcher, dispatcher);
      return response(200, "fl=test\nip=203.0.113.8\nloc=us\n");
    },
  });

  assert.deepEqual(result, { countryCode: "US" });
  assert.equal(dispatcher.closed, true);
});

test("direct country probe refuses an unverifiable egress and still closes its dispatcher", async () => {
  const dispatcher = {
    closed: false,
    async close() { this.closed = true; },
  };
  await assert.rejects(
    probeDirectTrialCountry({
      directAgentFactory: () => dispatcher,
      requestFn: async () => response(200, "fl=test\nip=203.0.113.8\n"),
    }),
    (error) => error.status === 503 && /未返回国家代码/.test(error.message),
  );
  assert.equal(dispatcher.closed, true);
});

test("US zero-price probe supports the server direct connection with a non-proxy dispatcher", async () => {
  const { calls, requestFn } = stripeFlowRequest(0);
  const directDispatcher = {
    closed: false,
    async close() { this.closed = true; },
  };
  let proxyFactoryCalls = 0;
  let directFactoryCalls = 0;
  const result = await probeUsTrialEligibility({
    accessToken: "test-access-token",
    proxy: DIRECT_TRIAL_ROUTE,
    proxyAgentFactory() {
      proxyFactoryCalls += 1;
      return { close: async () => {} };
    },
    directAgentFactory() {
      directFactoryCalls += 1;
      return directDispatcher;
    },
    requestFn,
    retryDelayMs: 0,
  });

  assert.equal(result.eligible, true);
  assert.equal(result.currency, "USD");
  assert.equal(result.evidence, US_ZERO_TRIAL_EVIDENCE);
  assert.equal(proxyFactoryCalls, 0);
  assert.equal(directFactoryCalls, 1);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.options.dispatcher === directDispatcher));
  assert.equal(directDispatcher.closed, true);
});

test("US zero-price probe rejects a mismatched Checkout currency", async () => {
  const { requestFn } = stripeFlowRequest(0, "GBP");
  await assert.rejects(
    probeUsTrialEligibility({
      accessToken: "test-access-token",
      proxy: "http://us-proxy.example:8080",
      proxyAgentFactory: () => ({ close: async () => {} }),
      requestFn,
      retryDelayMs: 0,
    }),
    (error) => error.status === 502
      && /美国 Stripe Checkout 返回币种 GBP，与预期 USD 不符/.test(error.message),
  );
});

test("GB zero-price probe handles OAICS totals with GB evidence", async () => {
  const result = await probeGbTrialEligibility({
    accessToken: "test-access-token",
    proxy: "http://gb-proxy.example:8080",
    proxyAgentFactory: () => ({ close: async () => {} }),
    requestFn: async () => response(200, {
      checkout_session_id: "oaics_private-value",
      checkout_state: { total: { total: { minorUnitsAmount: 1_000 } } },
    }),
    retryDelayMs: 0,
  });

  assert.deepEqual(result, {
    eligible: false,
    amountDue: 1_000,
    currency: "GBP",
    evidence: GB_ZERO_TRIAL_EVIDENCE,
  });
});

test("GB zero-price probe rejects a mismatched Stripe currency", async () => {
  const { requestFn } = stripeFlowRequest(0, "USD");
  await assert.rejects(
    probeGbTrialEligibility({
      accessToken: "test-access-token",
      proxy: "http://gb-proxy.example:8080",
      proxyAgentFactory: () => ({ close: async () => {} }),
      requestFn,
      retryDelayMs: 0,
    }),
    (error) => error.status === 502
      && /英国 Stripe Checkout 返回币种 USD，与预期 GBP 不符/.test(error.message),
  );
});

test("GB zero-price probe rejects a mismatched OAICS currency", async () => {
  await assert.rejects(
    probeGbTrialEligibility({
      accessToken: "test-access-token",
      proxy: "http://gb-proxy.example:8080",
      proxyAgentFactory: () => ({ close: async () => {} }),
      requestFn: async () => response(200, {
        checkout_session_id: "oaics_private-value",
        checkout_state: {
          total: { total: { minorUnitsAmount: 0, currencyCode: "usd" } },
        },
      }),
      retryDelayMs: 0,
    }),
    (error) => error.status === 502
      && /英国 OAICS Checkout 返回币种 USD，与预期 GBP 不符/.test(error.message),
  );
});

test("JP zero-price probe handles zero and discounted OAICS totals", async () => {
  for (const [amountDue, eligible] of [[0, true], [1_000, false]]) {
    const calls = [];
    const result = await probeJpTrialEligibility({
      accessToken: "test-access-token",
      proxy: "http://jp-proxy.example:8080",
      proxyAgentFactory: () => ({ close: async () => {} }),
      requestFn: async (url, options) => {
        calls.push({ url, options });
        return response(200, {
          checkout_session_id: "oaics_private-value",
          checkout_provider: "open_ai",
          checkout_state: {
            total: { total: { minorUnitsAmount: amountDue } },
          },
        });
      },
      retryDelayMs: 0,
    });
    assert.deepEqual(result, {
      eligible,
      amountDue,
      currency: "JPY",
      evidence: JP_ZERO_TRIAL_EVIDENCE,
    });
    assert.equal(calls.length, 1);
  }
});

test("JP zero-price probe refuses a verdict when the final amount is absent", async () => {
  await assert.rejects(
    probeJpTrialEligibility({
      accessToken: "test-access-token",
      proxy: "http://jp-proxy.example:8080",
      proxyAgentFactory: () => ({ close: async () => {} }),
      requestFn: async () => response(200, {
        checkout_session_id: "oaics_private-value",
        eligible_promo_campaigns: { plus: { discount_percent: 75 } },
        one_click_trial_eligible: true,
      }),
      retryDelayMs: 0,
    }),
    (error) => error.status === 502 && /未返回最终应付金额/.test(error.message),
  );
});

test("JP amount parser handles observed Checkout amount containers", () => {
  assert.equal(amountDueFromJpCheckout({
    checkout_state: { total: { total: { minorUnitsAmount: "0" } } },
  }), 0);
  assert.equal(amountDueFromJpCheckout({ total_summary: { due: 1_500 } }), 1_500);
  assert.equal(amountDueFromJpCheckout({ invoice: { amount_due: "500" } }), 500);
  assert.equal(amountDueFromJpCheckout({ eligible_promo_campaigns: { plus: {} } }), null);
});

test("JP zero-price probe reports bounded checkout errors", async (t) => {
  const fixtures = [
    {
      name: "rate limit",
      requestFn: async () => response(429, { detail: { code: "checkout_creation_rate_limited" } }),
      status: 429,
      message: /HTTP 429/,
    },
    {
      name: "deterministic invalid request",
      requestFn: async () => response(400, { detail: { code: "invalid_request" } }),
      status: 400,
      message: /HTTP 400/,
    },
    {
      name: "invalid json",
      requestFn: async () => response(200, "not-json"),
      status: 502,
      message: /无效 JSON/,
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      await assert.rejects(
        probeJpTrialEligibility({
          accessToken: "test-access-token",
          proxy: "http://jp-proxy.example:8080",
          proxyAgentFactory: () => ({ close: async () => {} }),
          requestFn: fixture.requestFn,
          retryDelayMs: 0,
        }),
        (error) => error.status === fixture.status && fixture.message.test(error.message),
      );
    });
  }
});

test("regional zero-price probes report errors for the requested country", async () => {
  const probeOptions = {
    accessToken: "test-access-token",
    proxy: "http://regional-proxy.example:8080",
    proxyAgentFactory: () => ({ close: async () => {} }),
    requestFn: async () => response(502, { detail: "upstream failure" }),
    retryDelayMs: 0,
  };

  await assert.rejects(
    probeJpTrialEligibility(probeOptions),
    (error) => error.status === 502 && /日本 0 元 Checkout 创建失败/.test(error.message),
  );
  await assert.rejects(
    probeGbTrialEligibility(probeOptions),
    (error) => error.status === 502 && /英国 0 元 Checkout 创建失败/.test(error.message),
  );
  await assert.rejects(
    probeUsTrialEligibility(probeOptions),
    (error) => error.status === 502 && /美国 0 元 Checkout 创建失败/.test(error.message),
  );
});
