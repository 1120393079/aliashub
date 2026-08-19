import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../db.js";
import { PaymentAgreementService } from "../payment-agreement-service.js";

function testDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-payment-agreement-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test("stores the HeroSMS API key encrypted and exposes only configuration state", async (t) => {
  const db = testDatabase(t);
  const service = new PaymentAgreementService({
    db,
    encryptionKey: "payment-agreement-test-encryption-key",
    fetchFn: async () => jsonResponse({}),
  });
  t.after(() => service.close());

  const saved = service.updateSettings({
    api_key: "hero-secret-for-payment-agreement",
    max_price: 1.25,
    change_number_retries: 3,
    number_wait_seconds: 90,
  });

  assert.equal(saved.configured, true);
  assert.equal(saved.protocol_configured, true);
  assert.equal(saved.api_key_configured, true);
  assert.equal(saved.max_price, 1.25);
  assert.equal(saved.change_retries, 3);
  assert.equal(saved.wait_seconds, 90);
  assert.equal(Object.hasOwn(saved, "api_key"), false);
  const stored = db.prepare(`
    SELECT value FROM settings WHERE key = 'payment_agreement_herosms_api_key_encrypted'
  `).get().value;
  assert.match(stored, /^v1\./);
  assert.equal(stored.includes("hero-secret-for-payment-agreement"), false);
  assert.equal(service.heroSmsApiKey(), "hero-secret-for-payment-agreement");

  const cleared = service.updateSettings({ clear_api_key: true });
  assert.equal(cleared.configured, false);
  assert.equal(cleared.api_key_configured, false);
});

test("requires an explicit encryption key before saving HeroSMS credentials", async (t) => {
  const db = testDatabase(t);
  const service = new PaymentAgreementService({ db, fetchFn: async () => jsonResponse({}) });
  t.after(() => service.close());

  assert.throws(
    () => service.updateSettings({ apiKey: "must-not-be-plaintext" }),
    (error) => error.status === 409 && error.code === "PAYMENT_AGREEMENT_ENCRYPTION_REQUIRED",
  );
  assert.equal(service.settings().configured, false);
});

test("persists a country and masked protocol proxy pool for automatic jobs", async (t) => {
  const db = testDatabase(t);
  const service = new PaymentAgreementService({
    db,
    encryptionKey: "saved-runtime-test-key",
    fetchFn: async () => jsonResponse({}),
  });
  t.after(() => service.close());

  await assert.rejects(
    service.createManagedJob({ country: "US", use_saved_protocol_config: true }),
    (error) => error.status === 422 && error.code === "PAYMENT_AGREEMENT_RUNTIME_COUNTRY_MISSING",
  );
  assert.throws(
    () => service.updateRuntime({ country: "TR", proxies: [] }),
    (error) => error.status === 422 && error.code === "PAYMENT_AGREEMENT_RUNTIME_PROXY_POOL_EMPTY",
  );

  const proxy = "http://saved-user:saved-password@protocol-proxy.example:8080";
  const saved = service.updateRuntime({ country: "tr", proxies: [proxy] });

  assert.equal(saved.configured, true);
  assert.equal(saved.country, "TR");
  assert.equal(saved.proxy_count, 1);
  assert.deepEqual(saved.proxies, [proxy]);
  assert.deepEqual(saved.masked_proxies, ["http://***@protocol-proxy.example:8080"]);
  assert.equal(saved.countries.some((item) => item.code === "TR" && item.hero_sms_country_id === 62), true);
  assert.deepEqual(service.runtime(), saved);
});

test("marks protocol job submission failures as unsafe to retry", async (t) => {
  const db = testDatabase(t);
  const heroStatuses = [];
  const service = new PaymentAgreementService({
    db,
    encryptionKey: "submission-boundary-test-key",
    fetchFn: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === "hero-sms.com") {
        const action = parsed.searchParams.get("action");
        if (action === "getNumberV2") {
          return jsonResponse({
            activationId: "hero-submission-boundary",
            phoneNumber: "4915112345678",
            activationCost: 0.2,
          });
        }
        if (action === "setStatus") {
          heroStatuses.push(parsed.searchParams.get("status"));
          return new Response("ACCESS_CANCEL");
        }
      }
      throw Object.assign(new Error("fixture protocol transport failure"), { code: "ECONNRESET" });
    },
  });
  service.updateSettings({ apiKey: "hero-api-key", waitSeconds: 30 });
  service.updateRuntime({ country: "DE", proxies: ["http://protocol-proxy.example:8080"] });
  t.after(() => service.close());

  await assert.rejects(
    service.createManagedJob({
      paypal_url: "https://www.paypal.com/agreements/approve?ba_token=BA-submission-boundary",
      use_saved_protocol_config: true,
    }),
    (error) => error.code === "ECONNRESET" && error.protocolSubmissionStarted === true,
  );
  assert.deepEqual(heroStatuses, ["8"]);
});

test("buys a country-matched PayPal number, submits its OTP, and completes the activation", async (t) => {
  const db = testDatabase(t);
  const protocolSubmissions = [];
  const otpSubmissions = [];
  const heroStatuses = [];
  let protocolReads = 0;
  const fetchFn = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "hero-sms.com") {
      const action = parsed.searchParams.get("action");
      if (action === "getNumberV2") {
        assert.equal(parsed.searchParams.get("service"), "ts");
        assert.equal(parsed.searchParams.get("country"), "16");
        return jsonResponse({
          activationId: "hero-activation-gb",
          phoneNumber: "447700900123",
          countryPhoneCode: "44",
          activationCost: 0.42,
        });
      }
      if (action === "getStatus") return new Response("STATUS_OK:123456");
      if (action === "setStatus") {
        heroStatuses.push({
          id: parsed.searchParams.get("id"),
          status: parsed.searchParams.get("status"),
        });
        return new Response("ACCESS_ACTIVATION");
      }
      throw new Error(`unexpected HeroSMS action ${action}`);
    }

    assert.equal(parsed.origin, "http://127.0.0.1:18083");
    assert.match(String(options.headers?.cookie || ""), /^paypal_web_device_id=[a-f0-9]{32}$/);
    if (parsed.pathname === "/paypal-pay/api/jobs" && options.method === "POST") {
      const payload = JSON.parse(options.body);
      protocolSubmissions.push(payload);
      return jsonResponse({ job: { id: "protocol-job-gb", status: "queued", country: "GB" } }, 201);
    }
    if (parsed.pathname === "/paypal-pay/api/jobs/protocol-job-gb/otp" && options.method === "POST") {
      otpSubmissions.push(JSON.parse(options.body));
      return jsonResponse({ ok: true, job: { id: "protocol-job-gb", status: "running" } });
    }
    if (parsed.pathname === "/paypal-pay/api/jobs/protocol-job-gb") {
      protocolReads += 1;
      return jsonResponse(protocolReads === 1
        ? { id: "protocol-job-gb", status: "awaiting_otp", country: "GB" }
        : { id: "protocol-job-gb", status: "completed", country: "GB", result: { status: "success" } });
    }
    throw new Error(`unexpected protocol request ${options.method || "GET"} ${parsed.pathname}`);
  };
  const service = new PaymentAgreementService({
    db,
    encryptionKey: "auto-otp-test-key",
    fetchFn,
    pollIntervalMs: 10,
  });
  service.updateSettings({ apiKey: "hero-api-key", maxPrice: 1, changeRetries: 1, waitSeconds: 30 });
  t.after(() => service.close());

  const created = await service.createJob({
    paypal_url: "https://www.paypal.com/agreements/approve?ba_token=BA-test-gb-token",
    phone: "",
    country: "GB",
    proxies: ["http://proxy-user:proxy-password@proxy.example:8080"],
  });
  const retainedContext = service.context("protocol-job-gb");
  assert.ok(retainedContext?.cookie);
  assert.ok(retainedContext?.deviceId);
  const final = await service.waitForJob("protocol-job-gb");

  assert.equal(created.hero_sms.managed, true);
  assert.equal(created.hero_sms.country_id, 16);
  assert.equal(created.hero_sms.phone.endsWith("0123"), true);
  assert.equal(protocolSubmissions.length, 1);
  assert.equal(protocolSubmissions[0].phone, "+447700900123");
  assert.equal(protocolSubmissions[0].country, "GB");
  assert.deepEqual(otpSubmissions, [{ value: "123456" }]);
  assert.deepEqual(heroStatuses, [{ id: "hero-activation-gb", status: "6" }]);
  assert.equal(final.status, "completed");
  assert.equal(retainedContext.terminal, true);
  assert.ok(retainedContext.releaseTimer);
  assert.equal(await service.releaseContext("protocol-job-gb"), true);
  assert.equal(service.context("protocol-job-gb"), null);
  assert.equal(service.contexts.size, 0);
  assert.equal(retainedContext.cookie, "");
  assert.equal(retainedContext.deviceId, "");
  assert.equal(retainedContext.settings, null);
  assert.equal(retainedContext.lastSnapshot, null);
  assert.equal(retainedContext.lastError, "");
  assert.equal(retainedContext.releaseTimer, null);
  assert.equal(await service.releaseContext("protocol-job-gb"), false);
});

test("cancels the HeroSMS activation when the protocol job fails", async (t) => {
  const db = testDatabase(t);
  const heroStatuses = [];
  const fetchFn = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "hero-sms.com") {
      const action = parsed.searchParams.get("action");
      if (action === "getNumberV2") {
        return jsonResponse({ activationId: "hero-failed", phoneNumber: "5511999999999", activationCost: 0.2 });
      }
      if (action === "setStatus") {
        heroStatuses.push(parsed.searchParams.get("status"));
        return new Response("ACCESS_CANCEL");
      }
      throw new Error(`unexpected HeroSMS action ${action}`);
    }
    if (parsed.pathname === "/paypal-pay/api/jobs" && options.method === "POST") {
      return jsonResponse({ job: { id: "protocol-job-failed", status: "queued" } }, 201);
    }
    if (parsed.pathname === "/paypal-pay/api/jobs/protocol-job-failed") {
      return jsonResponse({ id: "protocol-job-failed", status: "failed", error: "fixture failure" });
    }
    throw new Error(`unexpected protocol request ${parsed.pathname}`);
  };
  const service = new PaymentAgreementService({
    db,
    encryptionKey: "failed-job-test-key",
    fetchFn,
    pollIntervalMs: 10,
  });
  service.updateSettings({ apiKey: "hero-api-key", waitSeconds: 30 });
  t.after(() => service.close());

  await service.createJob({
    ba_token: "BA-test-br-token",
    country: "BR",
    proxies: ["http://proxy.example:8080"],
  });
  const retainedContext = service.context("protocol-job-failed");
  const final = await service.waitForJob("protocol-job-failed");

  assert.equal(final.status, "failed");
  assert.deepEqual(heroStatuses, ["8"]);
  assert.equal(retainedContext.terminal, true);
  assert.ok(retainedContext.releaseTimer);
  assert.equal(await service.releaseContext("protocol-job-failed"), true);
  assert.equal(service.context("protocol-job-failed"), null);
  assert.equal(service.contexts.size, 0);
  assert.equal(retainedContext.cookie, "");
  assert.equal(retainedContext.deviceId, "");
  assert.equal(retainedContext.settings, null);
  assert.equal(retainedContext.lastSnapshot, null);
  assert.equal(retainedContext.releaseTimer, null);
});

test("terminal contexts expire after the retention window and scrub retained secrets", async (t) => {
  const db = testDatabase(t);
  const service = new PaymentAgreementService({
    db,
    encryptionKey: "retention-expiry-test-key",
    fetchFn: async () => jsonResponse({}),
    contextRetentionMs: 20,
  });
  t.after(() => service.close());
  const context = {
    jobId: "retention-expiry-job",
    cookie: "paypal_web_device_id=retention-secret",
    deviceId: "retention-device-secret",
    settings: { wait_seconds: 30 },
    activation: null,
    lastSnapshot: { id: "retention-expiry-job", status: "completed" },
    lastError: "retention-error",
    terminal: true,
    stopped: false,
    releaseTimer: null,
    wake: null,
  };
  service.contexts.set(context.jobId, context);
  service.scheduleContextRelease(context);
  assert.ok(context.releaseTimer);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(service.context(context.jobId), null);
  assert.equal(context.releaseTimer, null);
  assert.equal(context.cookie, "");
  assert.equal(context.deviceId, "");
  assert.equal(context.settings, null);
  assert.equal(context.lastSnapshot, null);
  assert.equal(context.lastError, "");
});

test("releaseContext keeps live jobs unless forced, then stops, scrubs, and removes the context", async (t) => {
  const db = testDatabase(t);
  const heroStatuses = [];
  const fetchFn = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "hero-sms.com") {
      const action = parsed.searchParams.get("action");
      if (action === "getNumberV2") {
        return jsonResponse({
          activationId: "hero-force-release",
          phoneNumber: "4915112345678",
          activationCost: 0.2,
        });
      }
      if (action === "setStatus") {
        heroStatuses.push({
          id: parsed.searchParams.get("id"),
          status: parsed.searchParams.get("status"),
        });
        return new Response("ACCESS_CANCEL");
      }
      throw new Error(`unexpected HeroSMS action ${action}`);
    }
    if (parsed.pathname === "/paypal-pay/api/jobs" && options.method === "POST") {
      return jsonResponse({ job: { id: "protocol-job-force-release", status: "queued" } }, 201);
    }
    if (parsed.pathname === "/paypal-pay/api/jobs/protocol-job-force-release") {
      return jsonResponse({ id: "protocol-job-force-release", status: "running" });
    }
    throw new Error(`unexpected protocol request ${options.method || "GET"} ${parsed.pathname}`);
  };
  const service = new PaymentAgreementService({
    db,
    encryptionKey: "force-release-test-key",
    fetchFn,
    pollIntervalMs: 10,
  });
  service.updateSettings({ apiKey: "hero-api-key", waitSeconds: 30 });
  t.after(() => service.close());

  const created = await service.createManagedJob({
    paypal_url: "https://www.paypal.com/agreements/approve?ba_token=BA-force-release-token",
    country: "DE",
    proxies: ["http://proxy.example:8080"],
  });
  const context = created.context;
  const tracker = service.trackers.get(context.jobId);
  assert.ok(tracker);
  assert.equal(context.terminal, false);
  assert.equal(context.stopped, false);
  assert.equal(await service.releaseContext(context.jobId), false);
  assert.equal(service.context(context.jobId), context);
  assert.ok(context.cookie);
  assert.ok(context.deviceId);
  assert.ok(context.activation);

  assert.equal(await service.releaseContext(context.jobId, { force: true, successful: false }), true);
  assert.equal(context.stopped, true);
  assert.equal(context.terminal, false);
  assert.equal(service.context(context.jobId), null);
  assert.equal(service.contexts.size, 0);
  assert.equal(context.activation, null);
  assert.equal(context.cookie, "");
  assert.equal(context.deviceId, "");
  assert.equal(context.settings, null);
  assert.equal(context.lastSnapshot, null);
  assert.equal(context.lastError, "");
  assert.deepEqual(heroStatuses, [{ id: "hero-force-release", status: "8" }]);
  assert.equal(service.trackers.has(context.jobId), false);
  await tracker;
  assert.equal(service.trackers.size, 0);
  assert.equal(await service.releaseContext(context.jobId, { force: true }), false);
});

test("forced release waits for the active tracker before resolving and clearing context state", async (t) => {
  const db = testDatabase(t);
  const service = new PaymentAgreementService({
    db,
    encryptionKey: "controlled-release-test-key",
    fetchFn: async () => jsonResponse({}),
  });
  t.after(() => service.close());
  const jobId = "controlled-release-job";
  let wakeCalls = 0;
  const context = {
    jobId,
    cookie: "paypal_web_device_id=controlled-secret",
    deviceId: "controlled-device-secret",
    settings: { wait_seconds: 30 },
    activation: null,
    lastSnapshot: { id: jobId, status: "running" },
    lastError: "controlled-error",
    terminal: false,
    stopped: false,
    releaseTimer: null,
    wake: () => { wakeCalls += 1; },
  };
  service.contexts.set(jobId, context);
  const gate = deferred();
  const tracker = gate.promise.finally(() => service.trackers.delete(jobId));
  service.trackers.set(jobId, tracker);

  assert.equal(await service.releaseContext(jobId), false);
  assert.equal(service.context(jobId), context);
  let settled = false;
  const release = service.releaseContext(jobId, { force: true, successful: false })
    .then((result) => {
      settled = true;
      return result;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(context.stopped, true);
  assert.equal(wakeCalls, 1);
  assert.equal(service.context(jobId), context);

  gate.resolve({ id: jobId, status: "cancelled" });
  assert.equal(await release, true);
  assert.equal(settled, true);
  assert.equal(service.trackers.has(jobId), false);
  assert.equal(service.context(jobId), null);
  assert.equal(context.cookie, "");
  assert.equal(context.deviceId, "");
  assert.equal(context.settings, null);
  assert.equal(context.lastSnapshot, null);
  assert.equal(context.lastError, "");
});

test("failed remote cancellation retains context and the tracker retries until cancellation is confirmed", async (t) => {
  const db = testDatabase(t);
  const service = new PaymentAgreementService({
    db,
    encryptionKey: "cancel-retry-test-key",
    fetchFn: async () => jsonResponse({}),
    pollIntervalMs: 10,
  });
  t.after(() => service.close());
  const jobId = "cancel-retry-job";
  const context = {
    jobId,
    cookie: "paypal_web_device_id=cancel-retry-secret",
    deviceId: "cancel-retry-device",
    settings: { wait_seconds: 30 },
    activation: null,
    lastSnapshot: { id: jobId, status: "running" },
    lastError: "",
    terminal: false,
    stopped: false,
    cancelRequested: false,
    cancelPromise: null,
    cancelError: "",
    cancelAttempts: 0,
    releaseTimer: null,
    wake: null,
  };
  service.contexts.set(jobId, context);
  let cancelAttempts = 0;
  service.requestProtocolJson = async (requestPath) => {
    assert.match(requestPath, /\/cancel$/);
    cancelAttempts += 1;
    if (cancelAttempts === 1) throw new Error("fixture cancel failure 1");
    return { job: { id: jobId, status: "cancelled" } };
  };

  await assert.rejects(service.cancelJob(jobId), /fixture cancel failure 1/);
  assert.equal(cancelAttempts, 1);
  assert.equal(service.context(jobId), context);
  assert.equal(context.cancelRequested, true);
  assert.equal(context.stopped, false);
  assert.match(context.cancelError, /fixture cancel failure 1/);
  assert.ok(context.cookie);

  await service.startTracker(context);
  assert.equal(cancelAttempts, 2);
  assert.equal(context.stopped, true);
  assert.equal(context.terminal, true);
  assert.equal(context.cancelError, "");
  assert.ok(context.releaseTimer);
  assert.equal(await service.releaseContext(jobId, { force: true }), true);
  assert.equal(service.context(jobId), null);
});

test("remote cancellation retries are bounded before the retained context enters expiry", async (t) => {
  const db = testDatabase(t);
  const service = new PaymentAgreementService({
    db,
    encryptionKey: "cancel-retry-bound-test-key",
    fetchFn: async () => jsonResponse({}),
    pollIntervalMs: 10,
    cancelRetryLimit: 3,
  });
  t.after(() => service.close());
  const jobId = "cancel-retry-bound-job";
  const context = {
    jobId,
    cookie: "paypal_web_device_id=cancel-bound-secret",
    deviceId: "cancel-bound-device",
    settings: { wait_seconds: 30 },
    activation: null,
    lastSnapshot: { id: jobId, status: "running" },
    lastError: "",
    terminal: false,
    stopped: false,
    cancelRequested: false,
    cancelPromise: null,
    cancelError: "",
    cancelAttempts: 0,
    releaseTimer: null,
    wake: null,
  };
  service.contexts.set(jobId, context);
  service.requestProtocolJson = async () => {
    throw new Error("fixture permanent cancel failure");
  };

  await assert.rejects(service.cancelJob(jobId), /fixture permanent cancel failure/);
  await service.startTracker(context);
  assert.equal(context.cancelAttempts, 3);
  assert.equal(context.cancelRequested, true);
  assert.equal(context.stopped, true);
  assert.match(context.cancelError, /fixture permanent cancel failure/);
  assert.ok(context.releaseTimer);
  assert.equal(service.context(jobId), context);
  assert.equal(await service.releaseContext(jobId, { force: true }), true);
});

test("close best-effort cancels active protocol jobs before scrubbing their contexts", async (t) => {
  const db = testDatabase(t);
  const service = new PaymentAgreementService({
    db,
    encryptionKey: "close-cancel-test-key",
    fetchFn: async () => jsonResponse({}),
  });
  const jobId = "close-cancel-job";
  const context = {
    jobId,
    cookie: "paypal_web_device_id=close-cancel-secret",
    deviceId: "close-cancel-device",
    settings: { wait_seconds: 30 },
    activation: null,
    lastSnapshot: { id: jobId, status: "running" },
    lastError: "",
    terminal: false,
    stopped: false,
    cancelRequested: false,
    cancelPromise: null,
    cancelError: "",
    cancelAttempts: 0,
    releaseTimer: null,
    wake: null,
  };
  service.contexts.set(jobId, context);
  const requests = [];
  service.requestProtocolJson = async (requestPath, options) => {
    requests.push({ requestPath, options });
    return { job: { id: jobId, status: "cancelled" } };
  };

  await service.close();
  assert.equal(requests.length, 1);
  assert.match(requests[0].requestPath, /\/close-cancel-job\/cancel$/);
  assert.equal(requests[0].options.method, "POST");
  assert.equal(service.contexts.size, 0);
  assert.equal(context.cookie, "");
  assert.equal(context.deviceId, "");
  assert.equal(context.settings, null);
  assert.equal(context.lastSnapshot, null);
});

test("rewrites the embedded workbench base path and permits same-origin framing", async (t) => {
  const db = testDatabase(t);
  const requests = [];
  const service = new PaymentAgreementService({
    db,
    encryptionKey: "workbench-proxy-test-key",
    fetchFn: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      return new Response(`<!doctype html>
        <head>
        <link href="/paypal-pay/static/styles.css">
        <script>const API_BASE = '/paypal-pay/api';</script>
        </head>`, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
          "X-Frame-Options": "DENY",
        },
      });
    },
  });
  t.after(() => service.close());

  const result = await service.proxyWorkbench({
    method: "GET",
    originalUrl: "/alias-hub/paypal-pay/?embedded=1",
    params: { 0: "" },
    headers: { accept: "text/html", cookie: "aliashub_session=must-not-leak" },
  });
  const body = result.body.toString("utf8");

  assert.equal(new URL(requests[0].url).pathname, "/paypal-pay/");
  assert.equal(requests[0].options.headers.cookie, undefined);
  assert.match(body, /\/alias-hub\/paypal-pay\/static\/styles\.css/);
  assert.match(body, /API_BASE = '\/alias-hub\/paypal-pay\/api'/);
  assert.match(body, /id="aliashub-embedded-workbench"/);
  assert.equal(result.headers["x-frame-options"], "SAMEORIGIN");
  assert.match(result.headers["content-security-policy"], /frame-ancestors 'self'/);
  assert.doesNotMatch(result.headers["content-security-policy"], /frame-ancestors 'none'/);
});

test("proxyApi keeps the workbench country authoritative for protocol and HeroSMS", async (t) => {
  const db = testDatabase(t);
  const providerUrl = "https://www.paypal.com/agreements/approve?ba_token=BA-BOUNDCOUNTRY123456";
  db.prepare(`
    INSERT INTO registered_account_payment_links (
      external_account_id, email, status, provider_url, request_country, billing_country, created_at, updated_at
    ) VALUES (?, ?, 'succeeded', ?, 'GB', 'DE', ?, ?)
  `).run("42", "bound-country@example.com", providerUrl, "2026-08-17T00:00:00.000Z", "2026-08-17T00:00:00.000Z");
  let protocolPayload = null;
  const fetchFn = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "hero-sms.com") {
      const action = parsed.searchParams.get("action");
      if (action === "getNumberV2") {
        assert.equal(parsed.searchParams.get("country"), "62");
        return jsonResponse({ activationId: "hero-tr", phoneNumber: "905551234567", activationCost: 0.3 });
      }
      if (action === "setStatus") return new Response("ACCESS_CANCEL");
      throw new Error(`unexpected HeroSMS action ${action}`);
    }
    if (parsed.pathname === "/paypal-pay/api/jobs" && options.method === "POST") {
      protocolPayload = JSON.parse(options.body);
      return jsonResponse({ job: { id: "proxy-owned-job", status: "queued" } }, 201);
    }
    if (parsed.pathname === "/paypal-pay/api/jobs/proxy-owned-job") {
      return jsonResponse({ id: "proxy-owned-job", status: "failed" });
    }
    throw new Error(`unexpected protocol request ${parsed.pathname}`);
  };
  const service = new PaymentAgreementService({
    db,
    encryptionKey: "proxy-api-test-key",
    fetchFn,
    pollIntervalMs: 10,
  });
  service.updateSettings({ apiKey: "hero-api-key" });
  t.after(() => service.close());

  const response = await service.proxyApi({
    method: "POST",
    upstreamPath: "/api/jobs",
    headers: { "content-type": "application/json", cookie: "aliashub_session=do-not-forward" },
    body: { paypal_url: providerUrl, country: "TR", proxies: ["http://proxy.example:8080"] },
  });
  const payload = JSON.parse(response.body.toString("utf8"));

  assert.equal(response.status, 201);
  assert.equal(payload.job.id, "proxy-owned-job");
  assert.equal(payload.hero_sms.country, "TR");
  assert.equal(payload.hero_sms.country_source, "workbench_request");
  assert.equal(payload.hero_sms.request_country, "GB");
  assert.equal(protocolPayload.country, "TR");
  assert.equal(protocolPayload.paypal_country, "TR");
  assert.equal(protocolPayload.phone, "+905551234567");
  assert.deepEqual(protocolPayload.proxies, ["http://proxy.example:8080"]);
  assert.match(String(response.headers["set-cookie"]), /^paypal_web_device_id=[a-f0-9]{32}; Path=\/alias-hub\/paypal-pay\//);
  await service.waitForJob("proxy-owned-job");
});

test("saved protocol configuration overrides forged workbench country and proxies", async (t) => {
  const db = testDatabase(t);
  const providerUrl = "https://www.paypal.com/agreements/approve?ba_token=BA-SAVEDRUNTIME123456";
  db.prepare(`
    INSERT INTO registered_account_payment_links (
      external_account_id, email, status, provider_url, request_country, billing_country, created_at, updated_at
    ) VALUES (?, ?, 'succeeded', ?, 'GB', 'DE', ?, ?)
  `).run("84", "saved-runtime@example.com", providerUrl, "2026-08-17T00:00:00.000Z", "2026-08-17T00:00:00.000Z");
  const savedProxy = "http://saved-user:saved-password@protocol-proxy.example:8080";
  let protocolPayload = null;
  const fetchFn = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "hero-sms.com") {
      const action = parsed.searchParams.get("action");
      if (action === "getNumberV2") {
        assert.equal(parsed.searchParams.get("country"), "62");
        return jsonResponse({
          activationId: "hero-saved-tr",
          phoneNumber: "905551112233",
          countryPhoneCode: "90",
          activationCost: 0.3,
        });
      }
      if (action === "setStatus") return new Response("ACCESS_CANCEL");
      throw new Error(`unexpected HeroSMS action ${action}`);
    }
    if (parsed.pathname === "/paypal-pay/api/jobs" && options.method === "POST") {
      protocolPayload = JSON.parse(options.body);
      return jsonResponse({ job: { id: "saved-runtime-job", status: "queued" } }, 201);
    }
    if (parsed.pathname === "/paypal-pay/api/jobs/saved-runtime-job") {
      return jsonResponse({ id: "saved-runtime-job", status: "failed" });
    }
    throw new Error(`unexpected protocol request ${parsed.pathname}`);
  };
  const service = new PaymentAgreementService({
    db,
    encryptionKey: "saved-runtime-managed-job-key",
    fetchFn,
    pollIntervalMs: 10,
  });
  service.updateSettings({ apiKey: "hero-api-key" });
  service.updateRuntime({ country: "TR", proxies: [savedProxy] });
  t.after(() => service.close());

  const response = await service.proxyApi({
    method: "POST",
    upstreamPath: "/api/jobs",
    headers: { "content-type": "application/json" },
    body: {
      paypal_url: providerUrl,
      country: "US",
      paypal_country: "US",
      phone: "+12025550123",
      proxies: ["http://forged-user:forged-password@forged-proxy.example:9000"],
      use_saved_protocol_config: true,
    },
  });
  const payload = JSON.parse(response.body.toString("utf8"));

  assert.equal(response.status, 201);
  assert.equal(payload.hero_sms.country, "TR");
  assert.equal(payload.hero_sms.country_id, 62);
  assert.equal(payload.hero_sms.country_source, "saved_protocol_config");
  assert.equal(payload.hero_sms.request_country, "GB");
  assert.equal(payload.hero_sms.phone.endsWith("2233"), true);
  assert.equal(protocolPayload.country, "TR");
  assert.equal(protocolPayload.paypal_country, "TR");
  assert.equal(protocolPayload.phone, "+905551112233");
  assert.deepEqual(protocolPayload.proxies, [savedProxy]);
  await service.waitForJob("saved-runtime-job");
});
