import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../db.js";
import { PaymentLinkService } from "../payment-link-service.js";

const TEST_CURRENCIES = Object.freeze({
  DE: "EUR",
  TR: "USD",
  GB: "GBP",
  US: "USD",
  BR: "BRL",
  TH: "USD",
  JP: "JPY",
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("payment-link integration rotates its own proxy pool and persists PayPal results", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-payment-link-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const submissions = [];
  const registration = {
    async registeredAccountAccessToken(id) {
      return { id, email: `account-${id}@example.com`, access_token: `secret-access-token-${id}` };
    },
  };
  const fetchFn = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/tasks" && options.method === "POST") {
      const payload = JSON.parse(options.body);
      submissions.push({ payload, password: options.headers["X-Workbench-Password"] });
      return jsonResponse({
        ok: true,
        task_id: `task-${submissions.length}`,
        status: "queued",
        stage: "queued",
        progress: 0,
        billing_country: payload.country,
      }, 202);
    }
    const taskId = parsed.pathname.split("/").at(-1);
    const accountId = Number(taskId.split("-").at(-1));
    return jsonResponse({
      ok: true,
      task_id: taskId,
      status: "succeeded",
      stage: "completed",
      progress: 100,
      started_at: "2026-08-15T00:00:00.000Z",
      finished_at: "2026-08-15T00:00:10.000Z",
      result: {
        paypal_url: `https://www.paypal.com/agreements/approve?ba_token=BA-fixture-${accountId}`,
        session_kind: "stripe_checkout",
        billing_country: submissions[accountId - 1].payload.country,
        currency: TEST_CURRENCIES[submissions[accountId - 1].payload.country],
        amount_due: 20,
      },
    });
  };
  const service = new PaymentLinkService({
    db,
    registration,
    baseUrl: "http://127.0.0.1:8891",
    password: "workbench-secret",
    fetchFn,
    pollIntervalMs: 100,
  });

  try {
    const saved = service.saveProxyPool({
      checkout_proxies: [
        "http://first-user:first-password@first-proxy.example:8001",
        "http://second-user:second-password@second-proxy.example:8002",
      ],
      update_proxies: [
        "http://update-one:update-password-one@update-one.example:9001",
        "http://update-two:update-password-two@update-two.example:9002",
      ],
      country: "GB",
    });
    assert.equal(saved.checkout_proxy_count, 2);
    assert.equal(saved.update_proxy_count, 2);
    assert.equal(saved.country, "GB");
    assert.equal(saved.currency, "GBP");
    assert.deepEqual(saved.countries, [
      { code: "DE", currency: "EUR" },
      { code: "TR", currency: "USD" },
      { code: "GB", currency: "GBP" },
      { code: "US", currency: "USD" },
      { code: "BR", currency: "BRL" },
      { code: "TH", currency: "USD" },
      { code: "JP", currency: "JPY" },
    ]);
    const started = await service.start({ ids: [1, 2] });
    assert.equal(started.started, 2);
    assert.equal(started.failed, 0);
    assert.equal(started.country, "GB");
    assert.equal(started.currency, "GBP");

    await new Promise((resolve) => setTimeout(resolve, 200));
    const overview = service.list();
    assert.equal(overview.items.length, 2);
    assert.ok(overview.items.every((item) => item.status === "succeeded"));
    assert.ok(overview.items.every((item) => item.provider_url.startsWith("https://www.paypal.com/")));
    assert.ok(overview.items.every((item) => item.request_country === "GB"));
    assert.ok(overview.items.every((item) => item.billing_country === "GB"));
    assert.ok(overview.items.every((item) => item.currency === "GBP"));
    assert.ok(submissions.every((item) => item.payload.country === "GB"));
    assert.equal(submissions[0].payload.checkout_proxy, "http://first-user:first-password@first-proxy.example:8001");
    assert.equal(submissions[1].payload.checkout_proxy, "http://second-user:second-password@second-proxy.example:8002");
    assert.equal(submissions[0].payload.update_proxy, "http://update-one:update-password-one@update-one.example:9001");
    assert.equal(submissions[1].payload.update_proxy, "http://update-two:update-password-two@update-two.example:9002");
    assert.equal(submissions[0].password, "workbench-secret");
    assert.equal(submissions[0].payload.access_token, "secret-access-token-1");
    const publicJson = JSON.stringify({ started, items: overview.items });
    assert.doesNotMatch(publicJson, /secret-access-token|first-password|second-password|workbench-secret/);
    const usStarted = await service.start({ ids: [3], country: "US" });
    assert.equal(usStarted.started, 1);
    assert.equal(usStarted.country, "US");
    assert.equal(usStarted.currency, "USD");
    assert.equal(submissions[2].payload.country, "US");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const usItem = service.list().items.find((item) => item.external_account_id === 3);
    assert.equal(usItem.request_country, "US");
    assert.equal(usItem.billing_country, "US");
    assert.equal(usItem.currency, "USD");
    const brStarted = await service.start({ ids: [4], country: "BR" });
    assert.equal(brStarted.started, 1);
    assert.equal(brStarted.country, "BR");
    assert.equal(brStarted.currency, "BRL");
    assert.equal(submissions[3].payload.country, "BR");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const brItem = service.list().items.find((item) => item.external_account_id === 4);
    assert.equal(brItem.request_country, "BR");
    assert.equal(brItem.billing_country, "BR");
    assert.equal(brItem.currency, "BRL");
    const thStarted = await service.start({ ids: [5], country: "TH" });
    assert.equal(thStarted.started, 1);
    assert.equal(thStarted.country, "TH");
    assert.equal(thStarted.currency, "USD");
    assert.equal(submissions[4].payload.country, "TH");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const thItem = service.list().items.find((item) => item.external_account_id === 5);
    assert.equal(thItem.request_country, "TH");
    assert.equal(thItem.billing_country, "TH");
    assert.equal(thItem.currency, "USD");
    const jpStarted = await service.start({ ids: [6], country: "JP" });
    assert.equal(jpStarted.started, 1);
    assert.equal(jpStarted.country, "JP");
    assert.equal(jpStarted.currency, "JPY");
    assert.equal(submissions[5].payload.country, "JP");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const jpItem = service.list().items.find((item) => item.external_account_id === 6);
    assert.equal(jpItem.request_country, "JP");
    assert.equal(jpItem.billing_country, "JP");
    assert.equal(jpItem.currency, "JPY");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("payment-link request country remains authoritative when the remote billing country differs", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-payment-link-country-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const service = new PaymentLinkService({ db, registration: {} });
  try {
    service.persist(10, {
      email: "country-binding@example.com",
      task_id: "country-binding-task",
      status: "running",
      request_country: "GB",
      billing_country: "US",
    });
    const item = service.applySnapshot(10, {
      task_id: "country-binding-task",
      status: "succeeded",
      result: {
        paypal_url: "https://www.paypal.com/agreements/approve?ba_token=BA-country-binding",
        billing_country: "BR",
        currency: "BRL",
      },
    });
    assert.equal(item.request_country, "GB");
    assert.equal(item.billing_country, "BR");
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("payment-link integration requires selected accounts and a dedicated proxy pool", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-payment-link-validation-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const service = new PaymentLinkService({
    db,
    registration: { registeredAccountAccessToken: async () => ({}) },
    baseUrl: "http://127.0.0.1:8891",
    fetchFn: async () => jsonResponse({ ok: true }),
  });
  try {
    await assert.rejects(() => service.start({ ids: [] }), /请选择要提链的注册账号/);
    await assert.rejects(() => service.start({ ids: [1], country: "CA" }), /仅支持 DE、TR、GB、US、BR、TH 或 JP/);
    await assert.rejects(() => service.start({ ids: [1] }), /Checkout Proxy 池为空/);
    service.saveProxyPool({ checkout_proxies: ["http://proxy.example:8000"], update_proxies: [] });
    await assert.rejects(() => service.start({ ids: [1] }), /Update Proxy 池为空/);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("payment-link integration imports IPRocket into both pools and persists task switches", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-payment-link-source-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const requested = [];
  const service = new PaymentLinkService({
    db,
    registration: { registeredAccountAccessToken: async () => ({}) },
    baseUrl: "http://127.0.0.1:8891",
    password: "fixture-password",
    fetchFn: async (url) => {
      requested.push(url);
      return jsonResponse({
        ok: true,
        proxies: [
          "http://source-one.example:8001",
          "http://source-two.example:8002",
        ],
        count: 2,
        unique_count: 2,
      });
    },
  });
  try {
    const imported = await service.refreshProxySource({
      url: "https://app.iprocket.io/api/getLink?fixture=1",
    });
    assert.equal(imported.checkout_proxy_count, 2);
    assert.equal(imported.update_proxy_count, 2);
    assert.equal(imported.proxy_source_url, "https://app.iprocket.io/api/getLink?fixture=1");
    assert.match(requested[0], /\/api\/proxy\/source\?url=/);

    const saved = service.saveProxyPool({
      checkout_proxies: imported.checkout_proxies,
      update_proxies: imported.update_proxies,
      rotate_checkout_proxy: false,
      rotate_update_proxy: true,
      apply_checkout_update: false,
    });
    assert.equal(saved.rotate_checkout_proxy, false);
    assert.equal(saved.rotate_update_proxy, true);
    assert.equal(saved.apply_checkout_update, false);
    const compatible = service.saveProxyPool({
      checkout_proxies: ["gate.iprocket.io|5959|fixture-user|fixture-password"],
      update_proxies: ["socks5://fixture-user:fixture-password@proxy.iproyal.net:9595"],
    });
    assert.deepEqual(compatible.checkout_proxies, ["gate.iprocket.io|5959|fixture-user|fixture-password"]);
    assert.deepEqual(compatible.update_proxies, ["socks5://fixture-user:fixture-password@proxy.iproyal.net:9595"]);
    await assert.rejects(
      () => service.refreshProxySource({ url: "https://example.com/proxies" }),
      /仅支持 IPRocket/,
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("payment-link integration reserves an account before awaiting credentials", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-payment-link-concurrency-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  let releaseCredentials;
  const credentialsReady = new Promise((resolve) => { releaseCredentials = resolve; });
  let credentialReads = 0;
  let submissions = 0;
  const service = new PaymentLinkService({
    db,
    registration: {
      async registeredAccountAccessToken(id) {
        credentialReads += 1;
        await credentialsReady;
        return { id, email: "reserved@example.com", access_token: "fixture-access-token" };
      },
    },
    baseUrl: "http://127.0.0.1:8891",
    fetchFn: async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/tasks" && options.method === "POST") {
        submissions += 1;
        return jsonResponse({ task_id: "reserved-task", status: "queued", stage: "queued", progress: 0 }, 202);
      }
      return jsonResponse({
        task_id: "reserved-task",
        status: "succeeded",
        stage: "completed",
        progress: 100,
        result: {
          paypal_url: "https://www.paypal.com/agreements/approve?ba_token=BA-reserved-fixture",
          billing_country: "DE",
          currency: "EUR",
        },
      });
    },
    pollIntervalMs: 100,
  });
  service.saveProxyPool({
    checkout_proxies: ["http://checkout.example:8000"],
    update_proxies: ["http://update.example:8000"],
  });
  try {
    const first = service.start({ ids: [7] });
    await new Promise((resolve) => setImmediate(resolve));
    const duplicateRequest = service.start({ ids: [7] });
    releaseCredentials();
    const [started, duplicate] = await Promise.all([first, duplicateRequest]);
    assert.equal(duplicate.started, 0);
    assert.match(duplicate.items[0].error, /正在提链/);
    assert.equal(started.started, 1);
    assert.equal(credentialReads, 1);
    assert.equal(submissions, 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(service.list().items[0].status, "succeeded");
  } finally {
    releaseCredentials();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("payment-link integration rejects a non-agreement PayPal URL", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-payment-link-url-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const service = new PaymentLinkService({ db, registration: {} });
  try {
    service.persist(9, { email: "url-check@example.com", task_id: "url-task", status: "failed" });
    const result = service.applySnapshot(9, {
      task_id: "url-task",
      status: "succeeded",
      result: { paypal_url: "https://www.paypal.com/billing/subscriptions/approve?ba_token=BA-wrong-path" },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.stage, "invalid_result");
    assert.equal(result.provider_url, "");
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("account deletion reservation checks every SQL batch", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-payment-link-delete-reservation-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const service = new PaymentLinkService({ db, registration: {} });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    service.persist(802, {
      email: "active-payment-link@example.com",
      task_id: "active-payment-link-task",
      status: "running",
    });
    assert.throws(
      () => service.reserveForAccountDeletion(Array.from({ length: 802 }, (_, index) => index + 1)),
      (error) => error?.status === 409 && /账号 #802 正在提链/.test(error.message),
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
