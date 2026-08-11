import assert from "node:assert/strict";
import test from "node:test";
import { checkoutTypeFromAccount, checkoutTypeFromValue, probeCheckoutType } from "../checkout-type-probe.js";

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

test("checkout probe sends the exact DE custom-checkout contract through its proxy dispatcher", async () => {
  const calls = [];
  const dispatcher = {
    closed: false,
    async close() { this.closed = true; },
  };
  const result = await probeCheckoutType({
    accessToken: "test-access-token",
    proxy: "http://de-proxy.example:8080",
    proxyAgentFactory(proxy) {
      assert.equal(proxy, "http://de-proxy.example:8080");
      return dispatcher;
    },
    async requestFn(url, options) {
      calls.push({ url, options });
      return response(200, { checkout_session_id: "cs_live_private-value" });
    },
  });

  assert.equal(result, "cs_live");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://chatgpt.com/backend-api/payments/checkout");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.dispatcher, dispatcher);
  assert.equal(calls[0].options.headers.authorization, "Bearer test-access-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    entry_point: "all_plans_pricing_modal",
    plan_name: "chatgptplusplan",
    billing_details: { country: "DE", currency: "EUR" },
    checkout_ui_mode: "custom",
  });
  assert.equal(dispatcher.closed, true);
});

test("checkout type parser accepts only trusted ChatGPT checkout ids and URLs", () => {
  assert.equal(checkoutTypeFromValue("cs_live_private-value"), "cs_live");
  assert.equal(checkoutTypeFromValue("oaics_private-value"), "oaics");
  assert.equal(checkoutTypeFromValue("https://chatgpt.com/checkout/openai_llc/cs_live_private-value"), "cs_live");
  assert.equal(checkoutTypeFromValue("https://chatgpt.com/checkout/openai_llc/oaics_private-value"), "oaics");
  assert.equal(checkoutTypeFromValue("https://example.com/checkout/cs_live_private-value"), "");
  assert.equal(checkoutTypeFromValue("prefix-cs_live_private-value"), "");
  assert.equal(checkoutTypeFromAccount({ overview: { cashier_url: "https://chatgpt.com/checkout/openai_llc/cs_live_cached" } }), "cs_live");
});

test("checkout probe classifies oaics and generic cs session prefixes", async (t) => {
  for (const fixture of [
    { id: "oaics_private-value", expected: "oaics" },
    { id: "cs_test_private-value", expected: "cs_live" },
  ]) {
    await t.test(fixture.expected, async () => {
      const result = await probeCheckoutType({
        accessToken: "test-access-token",
        proxy: "http://de-proxy.example:8080",
        proxyAgentFactory: () => ({ close: async () => {} }),
        requestFn: async () => response(200, { checkout_session_id: fixture.id }),
      });
      assert.equal(result, fixture.expected);
    });
  }
});

test("checkout probe reports bounded errors for upstream failures", async (t) => {
  const fixtures = [
    {
      name: "rate limit",
      requestFn: async () => response(429, {
        detail: { code: "checkout_creation_rate_limited", message: "Too many checkout attempts." },
      }),
      status: 429,
      message: /HTTP 429/,
      code: "checkout_creation_rate_limited",
    },
    {
      name: "invalid json",
      requestFn: async () => response(200, "not-json"),
      status: 502,
      message: /无效 JSON/,
    },
    {
      name: "unknown session prefix",
      requestFn: async () => response(200, { checkout_session_id: "unknown_private-value" }),
      status: 502,
      message: /未包含 cs_live 或 oaics/,
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      await assert.rejects(
        probeCheckoutType({
          accessToken: "test-access-token",
          proxy: "http://de-proxy.example:8080",
          proxyAgentFactory: () => ({ close: async () => {} }),
          requestFn: fixture.requestFn,
        }),
        (error) => error.status === fixture.status
          && fixture.message.test(error.message)
          && (!fixture.code || error.code === fixture.code),
      );
    });
  }
});
