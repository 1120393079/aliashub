import assert from "node:assert/strict";
import test from "node:test";
import {
  amountDueFromJpCheckout,
  JP_ZERO_TRIAL_EVIDENCE,
  probeJpTrialEligibility,
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

function stripeFlowRequest(due) {
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
      return response(200, { total_summary: { due } });
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
