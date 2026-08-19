import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../db.js";
import { OpenAiSmsService } from "../openai-sms-service.js";
import { PaymentAgreementService } from "../payment-agreement-service.js";

const HERO_KEY = "hero-openai-super-secret";
const PHONE = "+66812345678";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body, status = 200) {
  return new Response(String(body), { status });
}

function blockedSleep() {
  const pending = [];
  const sleep = () => new Promise((resolve) => pending.push(resolve));
  sleep.releaseAll = () => pending.splice(0).forEach((resolve) => resolve());
  return sleep;
}

async function waitUntil(predicate, message = "condition was not reached") {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(message);
}

class FakeRegistration {
  constructor(accounts = [{ id: 71, email: "sms-one@example.com" }]) {
    this.accounts = accounts;
  }

  async listRegisteredAccounts() {
    return { items: this.accounts, total: this.accounts.length };
  }
}

class FakeRegistrationClient {
  constructor({ statusFactory, eventsFactory } = {}) {
    this.statusFactory = statusFactory || (() => ({ status: "succeeded", result: { data: { failure_count: 0 } } }));
    this.eventsFactory = eventsFactory || (() => ({ items: [] }));
    this.created = [];
    this.cancelled = [];
    this.taskReads = [];
    this.eventReads = [];
  }

  async createPhoneBindTask(payload) {
    const taskId = payload.task_id || `worker-phone-${this.created.length + 1}`;
    this.created.push({ taskId, payload });
    return { id: taskId, task_id: taskId, type: "phone_bind", status: "pending" };
  }

  async getTask(taskId) {
    this.taskReads.push(taskId);
    return this.statusFactory(taskId, this.taskReads.filter((item) => item === taskId).length);
  }

  async cancelTask(taskId) {
    this.cancelled.push(taskId);
    return { id: taskId, status: "cancel_requested" };
  }

  async getTaskEvents(taskId, since) {
    this.eventReads.push({ taskId, since });
    return this.eventsFactory(taskId, since);
  }
}

function createHarness(t, {
  heroHandler,
  accounts,
  client,
  sleepFn = async () => undefined,
  nowFn = Date.now,
  createService = true,
  relayRateLimit,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-openai-sms-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const heroCalls = [];
  const fetchFn = async (url) => {
    const parsed = new URL(String(url));
    const call = {
      action: parsed.searchParams.get("action"),
      params: Object.fromEntries(parsed.searchParams),
    };
    heroCalls.push(call);
    if (heroHandler) return heroHandler(call, heroCalls.length);
    if (call.action === "getNumberV2") {
      return jsonResponse({
        activationId: "activation-default",
        phoneNumber: PHONE.slice(1),
        countryCode: 52,
        countryPhoneCode: "66",
        activationCost: 0.2,
      });
    }
    if (call.action === "getStatus") return textResponse("STATUS_WAIT_CODE");
    if (call.action === "setStatus") return textResponse("ACCESS_READY");
    throw new Error(`unexpected HeroSMS action ${call.action}`);
  };
  const paymentAgreements = new PaymentAgreementService({
    db,
    encryptionKey: "openai-sms-test-encryption-key",
    fetchFn,
    requestTimeoutMs: 1_000,
  });
  paymentAgreements.updateSettings({ api_key: HERO_KEY, max_price: 9.75 });
  const registration = new FakeRegistration(accounts);
  const registrationClient = client || new FakeRegistrationClient();
  const services = [];
  const makeService = (overrides = {}) => {
    const service = new OpenAiSmsService({
      db,
      registration,
      client: registrationClient,
      paymentAgreements,
      publicBaseUrl: "https://alias.test/alias-hub",
      sleepFn,
      nowFn,
      remotePollIntervalMs: 10,
      relayRateLimit,
      ...overrides,
    });
    services.push(service);
    return service;
  };
  const service = createService ? makeService() : null;
  t.after(async () => {
    sleepFn.releaseAll?.();
    await Promise.allSettled(services.map((item) => item.close()));
    await paymentAgreements.close();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    directory,
    heroCalls,
    paymentAgreements,
    registration,
    client: registrationClient,
    makeService,
    service,
  };
}

function paidTask(ids = [71], overrides = {}) {
  return {
    ids,
    country: "TH",
    max_price: 0.25,
    claim_timeout_seconds: 30,
    wait_seconds: 90,
    concurrency: 1,
    browser_mode: "camoufox_headed",
    payment_confirmed: true,
    ...overrides,
  };
}

function taskJson(value) {
  return JSON.stringify(value);
}

test("keeps OpenAI settings independent while sharing only the encrypted HeroSMS key", async (t) => {
  const context = createHarness(t);
  const originalPaymentSettings = context.paymentAgreements.settings();

  const initial = context.service.settings();
  assert.equal(initial.api_key_configured, true);
  assert.equal(initial.service_code, "dr");
  assert.equal(initial.country, "TH");
  assert.equal(Object.hasOwn(initial, "api_key"), false);

  const saved = context.service.updateSettings({
    country: "US",
    max_price: 0.333,
    claim_timeout_seconds: 90,
    claim_interval_seconds: 3,
    wait_seconds: 240,
    concurrency: 3,
    browser_mode: "camoufox_headless",
  });
  assert.equal(saved.country, "US");
  assert.equal(saved.hero_sms_country_id, 187);
  assert.equal(saved.max_price, 0.333);
  assert.equal(saved.concurrency, 3);
  assert.equal(context.paymentAgreements.settings().max_price, originalPaymentSettings.max_price);
  assert.equal(context.paymentAgreements.heroSmsApiKey(), HERO_KEY);
  assert.doesNotMatch(taskJson(saved), new RegExp(HERO_KEY));

  assert.throws(() => context.service.updateSettings({ max_price: 0 }), /最高价格/);
  assert.throws(() => context.service.updateSettings({ claim_timeout_seconds: 29 }), /抢号超时/);
  assert.throws(() => context.service.updateSettings({ concurrency: 4 }), /并发数/);
});

test("loads HeroSMS real-time countries in upstream quality order and caches the result", async (t) => {
  const context = createHarness(t, { createService: false });
  const requests = [];
  const service = context.makeService({
    countryFetchFn: async (url, options) => {
      const parsed = new URL(String(url));
      requests.push(parsed);
      assert.equal(parsed.pathname, "/api/v1/left-menu/services/dr/countries");
      assert.equal(parsed.searchParams.get("page"), "1");
      assert.equal(parsed.searchParams.get("size"), "25");
      assert.equal(parsed.searchParams.get("sort[deliverability]"), "desc");
      assert.equal(options?.headers?.["Accept-Language"], "zh-CN");
      return jsonResponse({
        data: [
          { id: 163, name: "芬兰", priceDefault: 0.75, priceMinAvailable: 0.5163, countPhysical: 1673, deliverability: 62.47 },
          { id: 135, name: "利比里亚", priceDefault: 0.1, priceMinAvailable: 0.1, countPhysical: 78, deliverability: 54.44 },
          { id: 52, name: "泰国", priceDefault: 0.3, priceMinAvailable: 0.09, countPhysical: 6052, deliverability: 39.48 },
        ],
      });
    },
    countryCacheTtlMs: 60_000,
  });

  const first = await service.topCountries();
  const second = await service.topCountries();

  assert.equal(requests.length, 1);
  assert.equal(first.sort, "deliverability_desc");
  assert.equal(first.sort_label, "按质量排序");
  assert.deepEqual(first.countries.map((item) => item.id), [163, 135, 52]);
  assert.equal(first.countries[0].name, "芬兰");
  assert.equal(first.countries[0].min_price, 0.5163);
  assert.equal(first.countries[0].stock, 1673);
  assert.equal(first.countries[0].flag_url, "https://cdn.hero-sms.com/assets/img/country/163.svg");
  assert.equal(first.recommended_country_id, 52);
  assert.deepEqual(second.countries, first.countries);
});

test("fills ten ranked countries from the expanded upstream window after invalid rows", async (t) => {
  const context = createHarness(t);
  const rows = [
    { id: 99, name: "无库存", priceMinAvailable: 0.1, countPhysical: 0, deliverability: 99 },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: 100 + index,
      name: `国家 ${index + 1}`,
      priceDefault: 0.2,
      priceMinAvailable: 0.1 + index / 100,
      countPhysical: 10 + index,
      deliverability: 90 - index,
    })),
  ];

  const countries = context.service.parseRankedCountries({ data: rows });

  assert.equal(countries.length, 10);
  assert.deepEqual(countries.map((item) => item.id), Array.from({ length: 10 }, (_, index) => 100 + index));
  assert.deepEqual(countries.map((item) => item.rank), Array.from({ length: 10 }, (_, index) => index + 1));
  assert.deepEqual(countries.map((item) => item.source_rank), Array.from({ length: 10 }, (_, index) => index + 2));
});

test("returns a bounded stale country snapshot when a refresh fails", async (t) => {
  let now = 10_000;
  let requests = 0;
  const context = createHarness(t, { createService: false, nowFn: () => now });
  const service = context.makeService({
    countryFetchFn: async () => {
      requests += 1;
      if (requests > 1) throw new Error("upstream unavailable with secret-like-value");
      return jsonResponse({
        data: [
          { id: 52, name: "泰国", priceDefault: 0.3, priceMinAvailable: 0.09, countPhysical: 6000, deliverability: 39.48 },
        ],
      });
    },
    countryCacheTtlMs: 1_000,
    countryStaleTtlMs: 10_000,
  });

  const fresh = await service.topCountries();
  now += 2_000;
  const stale = await service.topCountries({ force: true });

  assert.equal(fresh.stale, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.countries[0].id, 52);
  assert.match(stale.error, /实时国家网络请求失败/);
  assert.doesNotMatch(JSON.stringify(stale), /secret-like-value/);
});

test("accepts a real-time numeric country and buys only that HeroSMS country", async (t) => {
  const context = createHarness(t, {
    heroHandler(call) {
      if (call.action === "getNumberV2") {
        return jsonResponse({
          activationId: "activation-finland",
          phoneNumber: "401234567",
          countryCode: 163,
          countryPhoneCode: "358",
          activationCost: 0.6,
        });
      }
      if (call.action === "getStatus") return textResponse("STATUS_WAIT_CODE");
      if (call.action === "setStatus") return textResponse("ACCESS_READY");
      throw new Error(`unexpected HeroSMS action ${call.action}`);
    },
  });

  const started = await context.service.start(paidTask([71], {
    country: "163",
    max_price: 0.75,
  }));
  const final = await context.service.waitForTask(started.task_id);
  const claim = context.heroCalls.find((item) => item.action === "getNumberV2");

  assert.equal(final.status, "completed");
  assert.equal(final.country, "163");
  assert.equal(final.hero_sms_country_id, 163);
  assert.equal(claim.params.country, "163");
  assert.equal(context.service.settings().country, "163");
  assert.equal(context.service.settings().hero_sms_country_id, 163);
});

test("rejects and releases a number when HeroSMS returns a different country id", async (t) => {
  let releaseAttempts = 0;
  const context = createHarness(t, {
    heroHandler(call) {
      if (call.action === "getNumberV2") {
        return jsonResponse({
          activationId: "activation-wrong-country",
          phoneNumber: "2025550147",
          countryCode: 187,
          countryPhoneCode: "1",
          activationCost: 0.2,
        });
      }
      if (call.action === "setStatus") {
        releaseAttempts += 1;
        return releaseAttempts === 1 ? textResponse("temporary cleanup failure", 500) : textResponse("ACCESS_CANCEL");
      }
      throw new Error(`unexpected HeroSMS action ${call.action}`);
    },
  });

  const started = await context.service.start(paidTask([71], {
    country: "163",
    max_price: 0.75,
  }));
  const final = await context.service.waitForTask(started.task_id);

  assert.equal(final.status, "failed");
  assert.equal(final.items[0].error, "HeroSMS 返回的号码国家与所选国家不一致");
  assert.equal(context.client.created.length, 0);
  assert.equal(releaseAttempts, 2);
  const persisted = context.db.prepare(`
    SELECT activation_id_encrypted, activation_released_at, cleanup_error
    FROM openai_sms_task_items WHERE task_id = ?
  `).get(started.task_id);
  assert.match(persisted.activation_id_encrypted, /^v1\./);
  assert.ok(persisted.activation_released_at);
  assert.equal(persisted.cleanup_error, "");
});

test("maps automatic country to TH and sends strict dr/country/maxPrice to HeroSMS", async (t) => {
  const context = createHarness(t);

  const started = await context.service.start(paidTask([71], { country: "auto" }));
  const final = await context.service.waitForTask(started.task_id);

  assert.equal(final.status, "completed");
  const claim = context.heroCalls.find((item) => item.action === "getNumberV2");
  assert.ok(claim);
  assert.equal(claim.params.service, "dr");
  assert.equal(claim.params.country, "52");
  assert.equal(claim.params.maxPrice, "0.25");
});

test("creates one worker phone-bind task without ever forwarding the HeroSMS key", async (t) => {
  const context = createHarness(t);

  const started = await context.service.start(paidTask());
  const final = await context.service.waitForTask(started.task_id);

  assert.equal(final.status, "completed");
  assert.equal(context.client.created.length, 1);
  const payload = context.client.created[0].payload;
  assert.deepEqual(payload.ids, [71]);
  assert.deepEqual(payload.fallback_ids, []);
  assert.equal(payload.platform, "chatgpt");
  assert.equal(payload.browser_mode, "camoufox_headed");
  assert.equal(payload.concurrency, 1);
  assert.equal(payload.sms_wait_seconds, 90);
  assert.match(payload.phone_lines, /^\+66812345678----https:\/\/alias\.test\/alias-hub\/api\/registration\/openai-sms\/relay\/[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(taskJson(payload), new RegExp(HERO_KEY));
  for (const forbidden of ["herosms_api_key", "api_key", "sms_provider", "max_price", "country"]) {
    assert.equal(Object.hasOwn(payload, forbidden), false);
  }
  assert.equal(final.items[0].phone.endsWith("5678"), true);
  assert.equal(final.items[0].phone.includes("6681234"), false);
  assert.doesNotMatch(taskJson(final), new RegExp(`${HERO_KEY}|66812345678`));

  const persisted = context.db.prepare(`
    SELECT activation_id_encrypted, phone_mask, relay_token_hash
    FROM openai_sms_task_items WHERE task_id = ?
  `).get(started.task_id);
  assert.match(persisted.activation_id_encrypted, /^v1\./);
  assert.equal(persisted.activation_id_encrypted.includes("activation-default"), false);
  assert.equal(persisted.phone_mask.includes("6681234"), false);
  assert.match(persisted.relay_token_hash, /^[a-f0-9]{64}$/);
});

test("retries bounded no-number responses and succeeds without relaxing the price cap", async (t) => {
  let claims = 0;
  const context = createHarness(t, {
    heroHandler(call) {
      if (call.action === "getNumberV2") {
        claims += 1;
        if (claims === 1) return textResponse("NO_NUMBERS");
        return jsonResponse({
          activationId: "activation-after-retry",
          phoneNumber: PHONE.slice(1),
          countryCode: 52,
          countryPhoneCode: "66",
          activationCost: 0.24,
        });
      }
      if (call.action === "setStatus") return textResponse("ACCESS_READY");
      if (call.action === "getStatus") return textResponse("STATUS_WAIT_CODE");
      throw new Error(`unexpected action ${call.action}`);
    },
  });

  const started = await context.service.start(paidTask());
  const final = await context.service.waitForTask(started.task_id);

  assert.equal(final.status, "completed");
  assert.equal(claims, 2);
  const claimCalls = context.heroCalls.filter((item) => item.action === "getNumberV2");
  assert.deepEqual(claimCalls.map((item) => item.params.maxPrice), ["0.25", "0.25"]);
  assert.equal(final.items[0].claim_attempts, 2);
});

test("fails closed and cancels an activation when HeroSMS omits or exceeds activationCost", async (t) => {
  await t.test("missing price", async (subtest) => {
    const context = createHarness(subtest, {
      heroHandler(call) {
        if (call.action === "getNumberV2") {
          return jsonResponse({
            activationId: "activation-no-price",
            phoneNumber: PHONE.slice(1),
            countryCode: 52,
            countryPhoneCode: "66",
          });
        }
        if (call.action === "setStatus") return textResponse("ACCESS_CANCEL");
        throw new Error(`unexpected action ${call.action}`);
      },
    });

    const started = await context.service.start(paidTask());
    const final = await context.service.waitForTask(started.task_id);

    assert.equal(final.status, "failed");
    assert.equal(context.client.created.length, 0);
    assert.equal(context.heroCalls.some((call) => call.action === "setStatus" && call.params.status === "8"), true);
  });

  await t.test("over price", async (subtest) => {
    const context = createHarness(subtest, {
      heroHandler(call) {
        if (call.action === "getNumberV2") {
          return jsonResponse({
            activationId: "activation-over-price",
            phoneNumber: PHONE.slice(1),
            countryCode: 52,
            countryPhoneCode: "66",
            activationCost: 0.251,
          });
        }
        if (call.action === "setStatus") return textResponse("ACCESS_CANCEL");
        throw new Error(`unexpected action ${call.action}`);
      },
    });

    const started = await context.service.start(paidTask());
    const final = await context.service.waitForTask(started.task_id);

    assert.equal(final.status, "failed");
    assert.equal(context.client.created.length, 0);
    assert.equal(context.heroCalls.some((call) => call.action === "setStatus" && call.params.status === "8"), true);
  });
});

test("releases a just-claimed activation if persistence fails before worker creation", async (t) => {
  const context = createHarness(t);
  const originalEncrypt = context.paymentAgreements.encrypt.bind(context.paymentAgreements);
  context.paymentAgreements.encrypt = () => { throw new Error("fixture encryption failure"); };

  const started = await context.service.start(paidTask());
  const final = await context.service.waitForTask(started.task_id);

  context.paymentAgreements.encrypt = originalEncrypt;
  assert.equal(final.status, "failed");
  assert.equal(context.client.created.length, 0);
  assert.equal(context.heroCalls.some((call) => call.action === "setStatus" && call.params.status === "8"), true);
});

test("serves HeroSMS OTP through a hashed relay token and rate-limits polling", async (t) => {
  const sleep = blockedSleep();
  const client = new FakeRegistrationClient({ statusFactory: () => ({ status: "running" }) });
  const context = createHarness(t, {
    client,
    sleepFn: sleep,
    relayRateLimit: 2,
    heroHandler(call) {
      if (call.action === "getNumberV2") {
        return jsonResponse({
          activationId: "activation-relay",
          phoneNumber: PHONE.slice(1),
          countryCode: 52,
          countryPhoneCode: "66",
          activationCost: 0.2,
        });
      }
      if (call.action === "getStatus") return textResponse("STATUS_OK:123456");
      if (call.action === "setStatus") return textResponse("ACCESS_READY");
      throw new Error(`unexpected action ${call.action}`);
    },
  });

  const started = await context.service.start(paidTask());
  await waitUntil(() => context.client.created[0], "worker phone-bind was not created");
  const relayUrl = context.client.created[0].payload.phone_lines.split("----", 2)[1];
  const token = new URL(relayUrl).pathname.split("/").pop();
  const relay = await context.service.relay(token);

  assert.deepEqual(relay, { code: "123456" });
  assert.equal(context.heroCalls.some((call) => call.action === "setStatus" && call.params.status === "1"), true);
  const stored = context.db.prepare(`
    SELECT relay_token_hash, code_hash FROM openai_sms_task_items WHERE task_id = ?
  `).get(started.task_id);
  assert.equal(stored.relay_token_hash.includes(token), false);
  assert.match(stored.code_hash, /^[a-f0-9]{64}$/);
  assert.equal(taskJson(stored).includes("123456"), false);

  await context.service.relay(token);
  await assert.rejects(
    context.service.relay(token),
    (error) => error.status === 429 && error.code === "OPENAI_SMS_RELAY_RATE_LIMITED",
  );
  await assert.rejects(
    context.service.relay(crypto.randomBytes(32).toString("base64url")),
    (error) => error.status === 404,
  );
  await context.service.cancel(started.task_id);
  sleep.releaseAll();
});

test("retries HeroSMS ready state and requests resend only when the worker asks", async (t) => {
  const sleep = blockedSleep();
  const client = new FakeRegistrationClient({ statusFactory: () => ({ status: "running" }) });
  let readyAttempts = 0;
  let statusReads = 0;
  const context = createHarness(t, {
    client,
    sleepFn: sleep,
    heroHandler(call) {
      if (call.action === "getNumberV2") {
        return jsonResponse({
          activationId: "activation-relay-retry",
          phoneNumber: PHONE.slice(1),
          countryCode: 52,
          countryPhoneCode: "66",
          activationCost: 0.2,
        });
      }
      if (call.action === "setStatus" && call.params.status === "1") {
        readyAttempts += 1;
        return readyAttempts === 1 ? textResponse("temporary failure", 500) : textResponse("ACCESS_READY");
      }
      if (call.action === "setStatus") return textResponse("ACCESS_READY");
      if (call.action === "getStatus") {
        statusReads += 1;
        return textResponse(statusReads < 3 ? "STATUS_OK:123456" : "STATUS_OK:654321");
      }
      throw new Error(`unexpected action ${call.action}`);
    },
  });

  const started = await context.service.start(paidTask());
  await waitUntil(() => client.created[0]);
  const relayUrl = client.created[0].payload.phone_lines.split("----", 2)[1];
  const token = new URL(relayUrl).pathname.split("/").pop();

  await assert.rejects(context.service.relay(token), (error) => error.status === 502);
  let persisted = context.db.prepare(`
    SELECT relay_started_at FROM openai_sms_task_items WHERE task_id = ?
  `).get(started.task_id);
  assert.equal(persisted.relay_started_at, null);

  assert.deepEqual(await context.service.relay(token), { code: "123456" });
  assert.deepEqual(await context.service.relay(token), { code: "123456" });
  assert.equal(context.heroCalls.some((call) => call.action === "setStatus" && call.params.status === "3"), false);
  assert.deepEqual(await context.service.relay(token, { requestResend: true }), { code: "654321" });
  assert.equal(context.heroCalls.filter((call) => call.action === "setStatus" && call.params.status === "3").length, 1);
  persisted = context.db.prepare(`
    SELECT relay_started_at, code_hash, resend_requested_at
    FROM openai_sms_task_items WHERE task_id = ?
  `).get(started.task_id);
  assert.ok(persisted.relay_started_at);
  assert.match(persisted.code_hash, /^[a-f0-9]{64}$/);
  assert.equal(persisted.resend_requested_at, null);

  await context.service.cancel(started.task_id);
  await context.service.waitForTask(started.task_id);
  sleep.releaseAll();
});

test("marks HeroSMS 6 only after worker success and 8 on worker failure or cancellation", async (t) => {
  await t.test("success", async (subtest) => {
    const context = createHarness(subtest);
    const started = await context.service.start(paidTask());
    const final = await context.service.waitForTask(started.task_id);
    assert.equal(final.status, "completed");
    assert.equal(context.heroCalls.some((call) => call.action === "setStatus" && call.params.status === "6"), true);
    assert.equal(context.heroCalls.some((call) => call.action === "setStatus" && call.params.status === "8"), false);
  });

  await t.test("failure", async (subtest) => {
    const client = new FakeRegistrationClient({
      statusFactory: () => ({ status: "failed", error: "binding failed +66812345678" }),
    });
    const context = createHarness(subtest, { client });
    const started = await context.service.start(paidTask());
    const final = await context.service.waitForTask(started.task_id);
    assert.equal(final.status, "failed");
    assert.equal(context.heroCalls.some((call) => call.action === "setStatus" && call.params.status === "8"), true);
    assert.doesNotMatch(taskJson(final), /66812345678/);
  });

  await t.test("cancellation", async (subtest) => {
    const sleep = blockedSleep();
    const client = new FakeRegistrationClient({ statusFactory: () => ({ status: "running" }) });
    const context = createHarness(subtest, { client, sleepFn: sleep });
    const started = await context.service.start(paidTask());
    await waitUntil(() => client.created.length === 1);
    const cancelled = await context.service.cancel(started.task_id);
    assert.equal(new Set(["cancel_requested", "cancelled"]).has(cancelled.status), true);
    const final = await context.service.waitForTask(started.task_id);
    sleep.releaseAll();
    assert.equal(final.status, "cancelled");
    assert.deepEqual(client.cancelled, [client.created[0].taskId]);
    assert.equal(context.heroCalls.some((call) => call.action === "setStatus" && call.params.status === "8"), true);
  });
});

test("shows the specific nested worker phone submission failure", async (t) => {
  const client = new FakeRegistrationClient({
    statusFactory: () => ({
      status: "failed",
      error: "OpenAI 手机号绑定失败",
      result: {
        data: {
          failure_count: 1,
          results: [{
            ok: false,
            error: `OpenAI 手机号验证失败: 手机号 UI 提交失败（同一号码已自动尝试 3 次）: Page.evaluate: select is not defined ${PHONE}`,
          }],
        },
      },
    }),
  });
  const context = createHarness(t, { client });
  const started = await context.service.start(paidTask());
  const final = await context.service.waitForTask(started.task_id);

  assert.equal(final.status, "failed");
  assert.match(final.items[0].error, /手机号 UI 提交失败/);
  assert.match(final.items[0].error, /select is not defined/);
  assert.doesNotMatch(taskJson(final), new RegExp(PHONE.slice(1)));
  assert.notEqual(final.items[0].error, "OpenAI 手机号绑定失败");
});

test("rejects a second active paid task for the same explicitly selected account", async (t) => {
  const sleep = blockedSleep();
  const client = new FakeRegistrationClient({ statusFactory: () => ({ status: "running" }) });
  const context = createHarness(t, { client, sleepFn: sleep });
  const first = await context.service.start(paidTask());
  await waitUntil(() => client.created.length === 1);

  await assert.rejects(
    context.service.start(paidTask()),
    (error) => error.status === 409 && error.code === "OPENAI_SMS_ACCOUNT_BUSY",
  );
  await context.service.cancel(first.task_id);
  sleep.releaseAll();
});

test("restart compensates every unreleased encrypted activation, retries cleanup, and persists the outcome", async (t) => {
  let releaseAttempts = 0;
  const context = createHarness(t, {
    createService: false,
    heroHandler(call) {
      if (call.action === "setStatus") {
        releaseAttempts += 1;
        return releaseAttempts === 1 ? textResponse("fixture failure", 500) : textResponse("ACCESS_CANCEL");
      }
      throw new Error(`unexpected action ${call.action}`);
    },
  });
  const taskId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  context.db.prepare(`
    INSERT INTO openai_sms_tasks (
      id, status, stage, country, hero_sms_country_id, max_price,
      claim_timeout_seconds, claim_interval_seconds, wait_seconds, concurrency,
      browser_mode, progress_total, created_at, updated_at
    ) VALUES (?, 'running', 'running', 'TH', 52, 0.25, 30, 2, 90, 1,
      'camoufox_headed', 1, ?, ?)
  `).run(taskId, createdAt, createdAt);
  context.db.prepare(`
    INSERT INTO openai_sms_task_items (
      task_id, external_account_id, email, remote_task_id, status, stage,
      activation_id_encrypted, relay_token_hash, phone_mask, price, created_at, updated_at
    ) VALUES (?, '71', 'restart@example.com', 'remote-restart', 'running', 'waiting_otp',
      ?, ?, '*******5678', 0.2, ?, ?)
  `).run(
    taskId,
    context.paymentAgreements.encrypt("activation-restart"),
    crypto.createHash("sha256").update("fixture-relay-token").digest("hex"),
    createdAt,
    createdAt,
  );

  const firstRestart = context.makeService();
  await firstRestart.recoveryPromise;
  assert.equal(releaseAttempts, 2);
  let item = context.db.prepare(`
    SELECT status, activation_released_at, cleanup_error
    FROM openai_sms_task_items WHERE task_id = ?
  `).get(taskId);
  assert.equal(item.status, "interrupted");
  assert.ok(item.activation_released_at);
  assert.equal(item.cleanup_error, "");
  assert.deepEqual(context.client.cancelled, ["remote-restart"]);

  await firstRestart.close();
  const secondRestart = context.makeService();
  await secondRestart.recoveryPromise;
  item = context.db.prepare(`
    SELECT activation_released_at, activation_outcome, cleanup_error
    FROM openai_sms_task_items WHERE task_id = ?
  `).get(taskId);
  assert.equal(releaseAttempts, 2);
  assert.ok(item.activation_released_at);
  assert.equal(item.activation_outcome, "cancelled");
  assert.equal(item.cleanup_error, "");
});

test("sanitizes worker events, phone numbers, relay tokens, and HeroSMS key", async (t) => {
  const sleep = blockedSleep();
  let relayToken = "";
  const client = new FakeRegistrationClient({
    statusFactory: () => ({ status: "running" }),
    eventsFactory: () => ({
      items: [{
        id: 1,
        type: "log",
        level: "info",
        message: `HeroSMS api_key=${HERO_KEY} phone=${PHONE} relay=/relay/${relayToken} 验证码: 123456`,
      }],
    }),
  });
  const context = createHarness(t, { client, sleepFn: sleep });
  const started = await context.service.start(paidTask());
  await waitUntil(() => client.created[0]);
  const relayUrl = client.created[0].payload.phone_lines.split("----", 2)[1];
  relayToken = new URL(relayUrl).pathname.split("/").pop();

  const response = await context.service.events(started.task_id);
  const serialized = taskJson(response);
  assert.doesNotMatch(serialized, new RegExp(HERO_KEY));
  assert.doesNotMatch(serialized, /66812345678/);
  assert.doesNotMatch(serialized, new RegExp(relayToken));
  assert.doesNotMatch(serialized, /123456/);
  assert.match(serialized, /REDACTED|\*{3,}/);
  await context.service.cancel(started.task_id);
  sleep.releaseAll();
});

test("late worker creation after cancellation is recorded and immediately cancelled without completing HeroSMS", async (t) => {
  let releaseCreate;
  let notifyCreateStarted;
  const createStarted = new Promise((resolve) => { notifyCreateStarted = resolve; });
  const createResult = new Promise((resolve) => { releaseCreate = resolve; });
  const client = new FakeRegistrationClient({ statusFactory: () => ({ status: "running" }) });
  client.createPhoneBindTask = async function createPhoneBindTask(payload) {
    this.created.push({ taskId: payload.task_id, payload });
    notifyCreateStarted();
    return createResult;
  };
  const context = createHarness(t, { client });

  const started = await context.service.start(paidTask());
  await createStarted;
  const beforeCancel = context.db.prepare(`
    SELECT remote_task_id, activation_id_encrypted, status
    FROM openai_sms_task_items WHERE task_id = ?
  `).get(started.task_id);
  assert.match(beforeCancel.remote_task_id, /^ahpb_[A-Za-z0-9_-]{32}$/);
  assert.match(beforeCancel.activation_id_encrypted, /^v1\./);
  assert.equal(beforeCancel.status, "running");

  const cancelled = await context.service.cancel(started.task_id);
  assert.equal(cancelled.status, "cancel_requested");
  assert.equal(cancelled.items[0].status, "cancel_requested");
  assert.equal(context.heroCalls.filter((call) => call.action === "setStatus" && call.params.status === "8").length, 1);
  await assert.rejects(
    context.service.start(paidTask()),
    (error) => error.status === 409 && error.code === "OPENAI_SMS_ACCOUNT_BUSY",
  );

  releaseCreate({
    id: beforeCancel.remote_task_id,
    task_id: beforeCancel.remote_task_id,
    type: "phone_bind",
    status: "pending",
  });
  const final = await context.service.waitForTask(started.task_id);
  const persisted = context.db.prepare(`
    SELECT remote_task_id, status, activation_outcome
    FROM openai_sms_task_items WHERE task_id = ?
  `).get(started.task_id);

  assert.equal(final.status, "cancelled");
  assert.equal(final.items[0].status, "cancelled");
  assert.equal(persisted.remote_task_id, beforeCancel.remote_task_id);
  assert.equal(persisted.status, "cancelled");
  assert.equal(persisted.activation_outcome, "cancelled");
  assert.deepEqual(client.cancelled, [beforeCancel.remote_task_id]);
  assert.equal(context.heroCalls.filter((call) => call.action === "setStatus" && call.params.status === "8").length, 1);
  assert.equal(context.heroCalls.some((call) => call.action === "setStatus" && call.params.status === "6"), false);
});

test("completion committed before HeroSMS status 6 wins a concurrent cancellation race", async (t) => {
  let releaseCompletion;
  let notifyCompletionStarted;
  const completionStarted = new Promise((resolve) => { notifyCompletionStarted = resolve; });
  const completionResponse = new Promise((resolve) => { releaseCompletion = resolve; });
  const context = createHarness(t, {
    heroHandler(call) {
      if (call.action === "getNumberV2") {
        return jsonResponse({
          activationId: "activation-completion-race",
          phoneNumber: PHONE.slice(1),
          countryCode: 52,
          countryPhoneCode: "66",
          activationCost: 0.2,
        });
      }
      if (call.action === "setStatus" && call.params.status === "6") {
        notifyCompletionStarted();
        return completionResponse;
      }
      if (call.action === "setStatus") return textResponse("ACCESS_READY");
      if (call.action === "getStatus") return textResponse("STATUS_WAIT_CODE");
      throw new Error(`unexpected action ${call.action}`);
    },
  });

  const started = await context.service.start(paidTask());
  await completionStarted;
  const committed = context.service.publicTask(started.task_id);
  assert.equal(committed.status, "completed");
  assert.equal(committed.items[0].status, "completed");
  assert.equal(committed.terminal, true);

  const cancelResult = await context.service.cancel(started.task_id);
  assert.equal(cancelResult.status, "completed");
  assert.equal(cancelResult.items[0].status, "completed");
  assert.deepEqual(context.client.cancelled, []);
  assert.equal(context.heroCalls.some((call) => call.action === "setStatus" && call.params.status === "8"), false);

  releaseCompletion(textResponse("ACCESS_ACTIVATION"));
  const final = await context.service.waitForTask(started.task_id);
  const statusCalls = context.heroCalls.filter((call) => call.action === "setStatus");
  const completedEvents = context.db.prepare(`
    SELECT COUNT(*) AS count FROM openai_sms_events
    WHERE task_id = ? AND message LIKE '%自动接码完成%'
  `).get(started.task_id).count;

  assert.equal(final.status, "completed");
  assert.equal(final.items[0].status, "completed");
  assert.deepEqual(statusCalls.map((call) => call.params.status), ["6"]);
  assert.equal(final.items[0].cleanup_error, "");
  assert.equal(completedEvents, 1);
});
