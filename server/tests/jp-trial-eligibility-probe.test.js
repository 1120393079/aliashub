import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyJpTrialEligibility,
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

test("JP trial probe reads accounts/check through its proxy and closes the dispatcher", async () => {
  const calls = [];
  const dispatcher = {
    closed: false,
    async close() { this.closed = true; },
  };
  const result = await probeJpTrialEligibility({
    accessToken: "test-access-token",
    proxy: "http://jp-proxy.example:8080",
    proxyAgentFactory(proxy) {
      assert.equal(proxy, "http://jp-proxy.example:8080");
      return dispatcher;
    },
    async requestFn(url, options) {
      calls.push({ url, options });
      return response(200, {
        accounts: {
          account_1: {
            eligible_promo_campaigns: {
              plus: { id: "plus-1-month-free" },
            },
          },
        },
        account_ordering: ["account_1"],
      });
    },
  });

  assert.deepEqual(result, {
    eligible: true,
    evidence: "eligible_promo_campaigns.plus",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.dispatcher, dispatcher);
  assert.equal(calls[0].options.headers.authorization, "Bearer test-access-token");
  assert.equal(calls[0].options.headers["oai-language"], "ja-JP");
  assert.match(calls[0].options.headers.referer, /plus-1-month-free/);
  assert.equal(dispatcher.closed, true);
});

test("JP trial eligibility classifier handles positive, negative, and explicit boolean evidence", async (t) => {
  const fixtures = [
    {
      name: "top-level campaign",
      payload: { eligible_promo_campaigns: { plus: { id: "plus-1-month-free" } } },
      expected: { eligible: true, evidence: "eligible_promo_campaigns.plus" },
    },
    {
      name: "explicit empty campaign",
      payload: { eligible_promo_campaigns: { plus: null } },
      expected: { eligible: false, evidence: "eligible_promo_campaigns.plus" },
    },
    {
      name: "campaign absent",
      payload: { accounts: { default: { eligible_promo_campaigns: {} } } },
      expected: { eligible: false, evidence: "eligible_promo_campaigns.plus absent" },
    },
    {
      name: "explicit current field",
      payload: { account: { one_click_trial_eligible: true } },
      expected: { eligible: true, evidence: "account.one_click_trial_eligible" },
    },
  ];
  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      assert.deepEqual(classifyJpTrialEligibility(fixture.payload), fixture.expected);
    });
  }
});

test("JP trial probe reports bounded errors for upstream failures", async (t) => {
  const fixtures = [
    {
      name: "rate limit",
      requestFn: async () => response(429, { error: "rate limited" }),
      status: 429,
      message: /HTTP 429/,
    },
    {
      name: "invalid json",
      requestFn: async () => response(200, "not-json"),
      status: 502,
      message: /无效 JSON/,
    },
    {
      name: "invalid payload",
      requestFn: async () => response(200, []),
      status: 502,
      message: /无效数据/,
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
        }),
        (error) => error.status === fixture.status && fixture.message.test(error.message),
      );
    });
  }
});
