import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase, createSourceAccount, getSetting, nowIso, setSetting } from "../db.js";
import { createApp } from "../index.js";
import { jsonRequest } from "./http-harness.js";

class FakeRegistrationClient {
  constructor() {
    this.created = [];
    this.cancelled = [];
    this.released = [];
    this.deletedAccounts = new Set();
    this.proxyInspections = [];
    this.proxyInspectionError = null;
    this.proxyInspectionHandler = null;
    this.createError = null;
  }

  async health() { return { ok: true, configured: true }; }

  async createTask(payload) {
    if (this.createError) {
      throw typeof this.createError === "function" ? this.createError(payload) : this.createError;
    }
    this.created.push(payload);
    return { task_id: `task-${this.created.length}` };
  }

  async getTask(taskId) {
    return { task_id: taskId, type: "register", status: "succeeded", progress_current: 1, progress_total: 1 };
  }

  async getTaskEvents() {
    return [
      { id: 1, message: "浏览器代理出口 IP: 203.0.113.24" },
      { id: 2, message: "已创建全新 Camoufox 随机指纹会话: abcdef123456，Cookie 已清空" },
      { id: 3, message: "about_you 表单: name=Alex Morgan, birthdate=1994-06-18" },
    ];
  }

  async cancelTask(taskId) {
    this.cancelled.push(taskId);
    return { task_id: taskId, status: "cancel_requested" };
  }

  async releaseTask(taskId) {
    this.released.push(taskId);
    return { task_id: taskId, status: "cancelled", release_mode: "force_release" };
  }

  async inspectProxy(payload) {
    this.proxyInspections.push(payload);
    if (this.proxyInspectionError) throw this.proxyInspectionError;
    if (this.proxyInspectionHandler) return this.proxyInspectionHandler(payload);
    return {
      dynamic: true,
      distinct_ips: ["203.0.113.10", "203.0.113.11"],
      samples: [
        {
          ip: "203.0.113.10",
          country_code: "JP",
          country_name: "Japan",
          locale: "ja-JP",
          timezone: "Asia/Tokyo",
          latitude: 35.68,
          longitude: 139.76,
        },
        {
          ip: "203.0.113.11",
          country_code: "JP",
          country_name: "Japan",
          locale: "ja-JP",
          timezone: "Asia/Tokyo",
          latitude: 35.69,
          longitude: 139.77,
        },
      ],
    };
  }

  async listAccounts({ email } = {}) {
    const items = [...this.created.map((item, index) => ({
      id: index + 10,
      email: item.email,
      password: `Password-${index + 1}`,
      overview: item.passwordOverview ?? {
        password_status: item.extra?.set_password_after_registration ? "configured" : "not_configured",
        password_source: item.extra?.set_password_after_registration ? "settings" : "none",
      },
      user_id: `user-${index + 1}`,
      primary_token: `primary-token-${index + 1}`,
      credentials: [{ key: "access_token", value: `session-access-token-${index + 1}` }],
      display_status: "registered",
      plan_state: "free",
      created_at: nowIso(),
    })), {
      id: 999,
      email: "unrelated@example.com",
      password: "UnrelatedPassword",
      user_id: "unrelated-user",
      display_status: "registered",
      plan_state: "free",
      created_at: nowIso(),
    }].filter((item) => !this.deletedAccounts.has(Number(item.id)) && (!email || item.email === email));
    return { total: items.length, items };
  }

  async getAccount(accountId) {
    const response = await this.listAccounts();
    return response.items.find((item) => Number(item.id) === Number(accountId)) || null;
  }

  async deleteAccount(accountId) {
    const account = await this.getAccount(accountId);
    if (!account) throw Object.assign(new Error("账号不存在"), { status: 404 });
    this.deletedAccounts.add(Number(accountId));
    return { ok: true };
  }
}

test("registration integration generates isolated addresses and exposes mailbox messages", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-registration-api-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const account = createSourceAccount(db, { email: "source@outlook.com" });
  db.prepare("UPDATE source_accounts SET status = 'connected', updated_at = ? WHERE id = ?").run(nowIso(), account.id);
  const base = db.prepare("SELECT * FROM addresses WHERE account_id = ? AND kind = 'primary'").get(account.id);
  setSetting(db, "registration_connector_key", "test-connector-key");
  const client = new FakeRegistrationClient();
  let scanResult = { stage: "completed", messages: [], items: [] };
  const graph = {
    scanCalls: 0,
    async scanInbox() {
      this.scanCalls += 1;
      return scanResult;
    },
  };
  const runtime = createApp({ db, graph, registrationClient: client, publicBaseUrl: "https://alias.test/alias-hub" });
  let configuredPasswordEmail = "";
  let legacyPasswordEmail = "";
  let proxyFailureLogs = [];

  try {
    await t.test("forwards exact dynamic proxy inspection parameters and returns only detected geography", async () => {
      const secretUrl = "http://proxy-user:proxy-password@proxy.example:8080";
      const response = await jsonRequest(runtime.app, "/api/registration/proxies/inspect", {
        method: "POST",
        body: JSON.stringify({ url: secretUrl, samples: 4, delay_ms: 725 }),
      });

      assert.equal(response.response.status, 200);
      assert.deepEqual(client.proxyInspections.at(-1), {
        url: secretUrl,
        samples: 4,
        delay_ms: 725,
      });
      assert.equal(response.body.dynamic, true);
      assert.deepEqual(response.body.distinct_ips, ["203.0.113.10", "203.0.113.11"]);
      assert.equal(response.body.samples.length, 2);
      const serialized = JSON.stringify(response.body);
      assert.doesNotMatch(serialized, /proxy-user|proxy-password|proxy\.example/i);
    });

    await t.test("preserves safe upstream dynamic flags separately from observed rotation", async () => {
      client.proxyInspectionHandler = () => ({
        dynamic: false,
        is_dynamic: true,
        samples: [{ ip: "203.0.113.40" }, { ip: "203.0.113.41" }],
      });
      let response = await jsonRequest(runtime.app, "/api/registration/proxies/inspect", {
        method: "POST",
        body: JSON.stringify({ url: "http://proxy.example:8080", samples: 2, delay_ms: 0 }),
      });
      assert.equal(response.body.dynamic, false);
      assert.equal(response.body.rotation_verified, true);

      client.proxyInspectionHandler = () => ({ is_dynamic: true, samples: [{ ip: "203.0.113.42" }] });
      response = await jsonRequest(runtime.app, "/api/registration/proxies/inspect", {
        method: "POST",
        body: JSON.stringify({ url: "http://proxy.example:8080", samples: 1, delay_ms: 0 }),
      });
      client.proxyInspectionHandler = null;
      assert.equal(response.body.dynamic, true);
      assert.equal(response.body.rotation_verified, false);
    });

    await t.test("rejects proxy inspection sample and delay boundaries before calling Frcibly", async () => {
      const previousCalls = client.proxyInspections.length;
      const invalid = [
        { samples: 0, delay_ms: 0 },
        { samples: 6, delay_ms: 0 },
        { samples: 1, delay_ms: -1 },
        { samples: 1, delay_ms: 2_001 },
      ];

      for (const values of invalid) {
        const response = await jsonRequest(runtime.app, "/api/registration/proxies/inspect", {
          method: "POST",
          body: JSON.stringify({ url: "http://proxy.example:8080", ...values }),
        });
        assert.equal(response.response.status, 400);
      }
      assert.equal(client.proxyInspections.length, previousCalls);
    });

    await t.test("does not expose credentials in a remote proxy inspection failure response", async () => {
      client.proxyInspectionError = Object.assign(
        new Error("upstream rejected http://kookeey-user:base-secret-TR-87654321-30m@gate-us.kookeey.info:1000"),
        { status: 502 },
      );
      const originalConsoleError = console.error;
      console.error = (...args) => { proxyFailureLogs.push(args.map(String).join(" ")); };
      let response;
      try {
        response = await jsonRequest(runtime.app, "/api/registration/proxies/inspect", {
          method: "POST",
          body: JSON.stringify({
            url: "gate-us.kookeey.info:1000:kookeey-user:base-secret-TR-12345678-30m",
            samples: 1,
            delay_ms: 0,
          }),
        });
      } finally {
        console.error = originalConsoleError;
        client.proxyInspectionError = null;
      }

      assert.equal(response.response.status, 502);
      assert.deepEqual(response.body, { error: "服务器处理请求失败" });
      assert.doesNotMatch(JSON.stringify(response.body), /kookeey-user|base-secret|12345678|87654321|gate-us/i);
    });

    await t.test("redacts proxy credentials from remote failure logs", () => {
      assert.doesNotMatch(proxyFailureLogs.join("\n"), /kookeey-user|base-secret|12345678|87654321|gate-us/i);
    });

    await t.test("accepts only proxy forms supported consistently by requests and Playwright", async () => {
      const accepted = [
        "http://user%40team:p%3Aword@[2001:db8::1]:8080",
        "https://proxy.example:8443",
        "socks5://127.0.0.1:1080",
        "plain-proxy.example:3128",
        "gate-us.kookeey.info:1000:sample-user:base-secret-TR-12345678-30m",
        "[2001:db8::2]:8081:ipv6-user:ipv6-password",
      ];
      const saved = await jsonRequest(runtime.app, "/api/registration/proxies", {
        method: "PUT",
        body: JSON.stringify({ proxies: accepted }),
      });

      assert.equal(saved.response.status, 200);
      assert.deepEqual(saved.body.proxies, [
        accepted[0],
        accepted[1],
        accepted[2],
        "http://plain-proxy.example:3128",
        "http://sample-user:base-secret-TR-12345678-30m@gate-us.kookeey.info:1000",
        "http://ipv6-user:ipv6-password@[2001:db8::2]:8081",
      ]);
      assert.deepEqual(saved.body.proxyMetadata, [
        null,
        null,
        null,
        null,
        {
          provider: "Kookeey",
          dynamic_mode: "sticky_session",
          country_code: "TR",
          session_ttl: "30m",
        },
        null,
      ]);
      const serializedMetadata = JSON.stringify(saved.body.proxyMetadata);
      assert.doesNotMatch(serializedMetadata, /sample-user|base-secret|12345678|gate-us/i);

      const options = await jsonRequest(runtime.app, "/api/registration/options");
      assert.equal(options.response.status, 200);
      assert.deepEqual(options.body.proxyMetadata, saved.body.proxyMetadata);
      assert.doesNotMatch(JSON.stringify(options.body.proxyMetadata), /sample-user|base-secret|12345678|gate-us/i);
    });

    await t.test("encodes credentials from host-port-user-password proxy syntax before forwarding", async () => {
      const legacyProxy = "rotate.example:443:user@team:p/ass?#word";
      const expected = "http://user%40team:p%2Fass%3F%23word@rotate.example:443";
      const saved = await jsonRequest(runtime.app, "/api/registration/proxies", {
        method: "PUT",
        body: JSON.stringify({ proxies: [legacyProxy] }),
      });
      assert.equal(saved.response.status, 200);
      assert.deepEqual(saved.body.proxies, [expected]);

      const inspected = await jsonRequest(runtime.app, "/api/registration/proxies/inspect", {
        method: "POST",
        body: JSON.stringify({ url: legacyProxy, samples: 3, delay_ms: 0 }),
      });
      assert.equal(inspected.response.status, 200);
      assert.equal(client.proxyInspections.at(-1).url, expected);
      assert.doesNotMatch(JSON.stringify(inspected.body), /user%40team|p%2Fass|rotate\.example/i);
    });

    await t.test("rotates a Kookeey sticky session for every inspection sample", async () => {
      const template = "gate-us.kookeey.info:1000:kookeey-user:base-secret-TR-12345678-30m";
      const previousCalls = client.proxyInspections.length;
      const sampledSessions = [];
      client.proxyInspectionHandler = (payload) => {
        const parsed = new URL(payload.url);
        const password = decodeURIComponent(parsed.password);
        const match = password.match(/^base-secret-TR-(\d{8})-30m$/);
        assert.ok(match);
        sampledSessions.push(match[1]);
        const suffix = 20 + sampledSessions.length;
        return {
          dynamic: false,
          distinct_ips: [`203.0.113.${suffix}`],
          samples: [{
            ip: `203.0.113.${suffix}`,
            country_code: "TR",
            country_name: "Türkiye",
            locale: "tr-TR",
            timezone: "Europe/Istanbul",
            latitude: 41.01,
            longitude: 28.97,
          }],
        };
      };
      let response;
      try {
        response = await jsonRequest(runtime.app, "/api/registration/proxies/inspect", {
          method: "POST",
          body: JSON.stringify({ url: template, samples: 3, delay_ms: 0 }),
        });
      } finally {
        client.proxyInspectionHandler = null;
      }

      assert.equal(response.response.status, 200);
      assert.equal(response.body.dynamic, true);
      assert.equal(response.body.dynamic_mode, "sticky_session");
      assert.equal(response.body.provider, "Kookeey");
      assert.equal(response.body.session_ttl, "30m");
      assert.equal(response.body.rotation_verified, true);
      assert.deepEqual(response.body.distinct_ips, ["203.0.113.21", "203.0.113.22", "203.0.113.23"]);
      assert.equal(new Set(sampledSessions).size, 3);
      assert.equal(sampledSessions.includes("12345678"), false);
      const calls = client.proxyInspections.slice(previousCalls);
      assert.equal(calls.length, 3);
      assert.ok(calls.every((item) => item.samples === 1 && item.delay_ms === 0));
      const serialized = JSON.stringify(response.body);
      assert.doesNotMatch(serialized, /kookeey-user|base-secret|12345678|gate-us\.kookeey\.info/i);
      sampledSessions.forEach((sessionId) => assert.equal(serialized.includes(sessionId), false));
    });

    await t.test("reports sticky proxies as dynamic even when sampled exits do not rotate", async () => {
      const sampledUrls = [];
      client.proxyInspectionHandler = (payload) => {
        sampledUrls.push(payload.url);
        return {
          samples: [{
            ip: "203.0.113.30",
            country_code: "TR",
            country_name: "Türkiye",
            locale: "tr-TR",
            timezone: "Europe/Istanbul",
          }],
        };
      };
      let response;
      try {
        response = await jsonRequest(runtime.app, "/api/registration/proxies/inspect", {
          method: "POST",
          body: JSON.stringify({
            url: "gate-us.kookeey.info:1000:user:base-secret-TR-12345678-30m",
            samples: 2,
            delay_ms: 0,
          }),
        });
      } finally {
        client.proxyInspectionHandler = null;
      }

      assert.equal(response.response.status, 200);
      assert.equal(response.body.dynamic, true);
      assert.equal(response.body.dynamic_mode, "sticky_session");
      assert.equal(response.body.rotation_verified, false);
      assert.deepEqual(response.body.distinct_ips, ["203.0.113.30"]);
      assert.equal(sampledUrls.length, 2);
      assert.equal(new Set(sampledUrls).size, 2);
    });

    await t.test("does not classify Kookeey lookalikes or malformed sticky passwords", async () => {
      const inputs = [
        "http://user:base-secret-TR-12345678-30m@gate-us.kookeey.info.evil:1000",
        "http://user:base-secret-TR-not-numeric-30m@gate-us.kookeey.info:1000",
        "http://user:base-secret-TR-12345678-0m@gate-us.kookeey.info:1000",
        "http://user:base-secret-TR-12345678-9999m@gate-us.kookeey.info:1000",
      ];
      for (const url of inputs) {
        const previousCalls = client.proxyInspections.length;
        const response = await jsonRequest(runtime.app, "/api/registration/proxies/inspect", {
          method: "POST",
          body: JSON.stringify({ url, samples: 3, delay_ms: 0 }),
        });
        assert.equal(response.response.status, 200);
        assert.equal("dynamic_mode" in response.body, false);
        assert.equal("provider" in response.body, false);
        assert.deepEqual(client.proxyInspections.slice(previousCalls), [{ url, samples: 3, delay_ms: 0 }]);
      }
    });

    await t.test("rejects ambiguous or unsupported proxy URLs before forwarding them", async () => {
      const invalid = [
        "socks5h://proxy.example:1080",
        "socks5://user:secret@proxy.example:1080",
        "http://user@proxy.example:8080",
        "http://user:@proxy.example:8080",
        "http://proxy.example:8080/path",
        "http://proxy.example:8080?mode=rotate",
        "http://proxy.example:8080#fragment",
        "http://proxy%2eexample:8080",
        "http://example..:8080",
        "http://user:%0Asecret@proxy.example:8080",
        "proxy.example:8080:user:",
        "proxy.example:8080::password",
        "proxy.example:0:user:password",
        "proxy.example:65536:user:password",
        "proxy.example:not-a-port:user:password",
        "proxy.example:8080:user:password:extra",
      ];
      const previousCalls = client.proxyInspections.length;

      for (const url of invalid) {
        const saved = await jsonRequest(runtime.app, "/api/registration/proxies", {
          method: "PUT",
          body: JSON.stringify({ proxies: [url] }),
        });
        assert.equal(saved.response.status, 400, url);

        const inspected = await jsonRequest(runtime.app, "/api/registration/proxies/inspect", {
          method: "POST",
          body: JSON.stringify({ url, samples: 1, delay_ms: 0 }),
        });
        assert.equal(inspected.response.status, 400, url);
      }
      assert.equal(client.proxyInspections.length, previousCalls);
    });

    await t.test("rejects ambiguous four-field proxy input without echoing credentials", async () => {
      const secret = "proxy.example:8080:private-user:private-password:extra";
      const response = await jsonRequest(runtime.app, "/api/registration/proxies", {
        method: "PUT",
        body: JSON.stringify({ proxies: [secret] }),
      });
      assert.equal(response.response.status, 400);
      assert.deepEqual(response.body, { error: "第 1 条代理地址无效" });
      assert.doesNotMatch(JSON.stringify(response.body), /private-user|private-password|proxy\.example/i);
    });

    await t.test("creates one fresh-browser task per generated split address", async () => {
      const normalizedTemplate = "http://kookeey-user:base-secret-TR-12345678-30m@gate-us.kookeey.info:1000";
      setSetting(db, "registration_proxy_pool", JSON.stringify([normalizedTemplate]));
      const response = await jsonRequest(runtime.app, "/api/registration/jobs", {
        method: "POST",
        body: JSON.stringify({
          accountId: account.id,
          baseAddressId: base.id,
          count: 2,
          browserMode: "headed",
          proxySelection: "auto",
        }),
      });
      assert.equal(response.response.status, 202);
      assert.equal(response.body.items.length, 2);
      assert.equal(client.created.length, 2);
      assert.match(client.created[0].email, /^source\+gpt-[a-z0-9]+@outlook\.com$/);
      assert.notEqual(client.created[0].email, client.created[1].email);
      assert.equal(client.created[0].executor_type, "headed");
      assert.equal(getSetting(db, "registration_proxy_pool"), JSON.stringify([normalizedTemplate]));
      const materializedPasswords = client.created.slice(0, 2).map((item) => {
        const parsed = new URL(item.proxy);
        assert.equal(parsed.hostname, "gate-us.kookeey.info");
        assert.equal(parsed.port, "1000");
        assert.equal(parsed.username, "kookeey-user");
        const password = decodeURIComponent(parsed.password);
        assert.match(password, /^base-secret-TR-\d{8}-30m$/);
        assert.notEqual(password, "base-secret-TR-12345678-30m");
        return password;
      });
      assert.equal(new Set(materializedPasswords).size, 2);
      assert.equal(client.created[0].password, null);
      assert.equal(client.created[0].extra.outlook_email_fixed_email, client.created[0].email);
      assert.equal(client.created[0].extra.fresh_browser_context, true);
      assert.equal(client.created[0].extra.random_fingerprint, true);
      assert.equal(client.created[0].extra.email_only_registration, true);
      assert.equal(client.created[0].extra.disable_phone_verification, true);
      assert.equal(client.created[0].extra.phone_verification_policy, "forbid");
      assert.equal(client.created[0].extra.allow_chatgpt_registration_proxy, true);
      assert.equal(client.created[0].extra.set_password_after_registration, false);
      assert.equal(client.created[0].extra.auto_continue_post_signup, true);
      assert.equal(response.body.items[0].proxy_label, "http://***@gate-us.kookeey.info:1000");
      const serializedJobs = JSON.stringify(response.body);
      assert.doesNotMatch(serializedJobs, /kookeey-user|base-secret|12345678/i);
      materializedPasswords.forEach((password) => assert.equal(serializedJobs.includes(password), false));
      assert.ok(response.body.items[0].fingerprint_id);
    });

    await t.test("does not persist or return a materialized proxy echoed by task submission", async () => {
      const createdBeforeFailure = client.created.length;
      client.createError = (payload) => new Error(`upstream rejected ${payload.proxy}`);
      let response;
      try {
        response = await jsonRequest(runtime.app, "/api/registration/jobs", {
          method: "POST",
          body: JSON.stringify({
            accountId: account.id,
            baseAddressId: base.id,
            count: 1,
            suffix: "safe-submit-failure",
            browserMode: "headed",
            proxySelection: "auto",
          }),
        });
      } finally {
        client.createError = null;
      }

      assert.equal(response.response.status, 202);
      assert.equal(client.created.length, createdBeforeFailure);
      assert.equal(response.body.items[0].status, "failed");
      assert.equal(response.body.items[0].message, "注册任务提交失败");
      assert.doesNotMatch(JSON.stringify(response.body), /kookeey-user|base-secret|12345678/i);
      const stored = db.prepare("SELECT message FROM registration_jobs WHERE id = ?").get(response.body.items[0].id);
      assert.deepEqual(stored, { message: "注册任务提交失败" });
    });

    await t.test("redacts proxy credentials and sessions from synced jobs and remote events", async () => {
      const createdAt = nowIso();
      const inserted = db.prepare(`
        INSERT INTO registration_jobs (
          account_id, address_id, email, external_task_id, status, stage, browser_mode,
          proxy_label, fingerprint_id, message, created_at, updated_at
        ) VALUES (?, ?, ?, 'redaction-task', 'queued', 'queued', 'headed',
          'http://***@gate-us.kookeey.info:1000', 'safe-fingerprint', '等待同步', ?, ?)
      `).run(account.id, base.id, "redaction-test@outlook.com", createdAt, createdAt);
      const jobId = Number(inserted.lastInsertRowid);
      const originalGetTask = client.getTask;
      const originalGetTaskEvents = client.getTaskEvents;
      client.getTask = async () => ({ task_id: "redaction-task", type: "register", status: "failed" });
      client.getTaskEvents = async () => [{
        id: 1,
        message: "浏览器代理出口 IP: 203.0.113.24",
        detail: { fingerprint_session_id: "abcdef123456" },
      }, {
        id: 2,
        message: "upstream rejected http://private-user:base-secret-TR-87654321-30m@gate-us.kookeey.info:1000",
        password: "root-password",
        session_id: "87654321",
        proxy: "gate-us.kookeey.info:1000:private-user:base-secret-TR-87654321-30m",
        detail: { proxy: { username: "private-user", password: "base-secret", session_id: "87654321" } },
      }];
      try {
        const job = await runtime.registration.syncJob(runtime.registration.getJob(jobId));
        assert.equal(job.message, "upstream rejected http://***@gate-us.kookeey.info:1000");
        const stored = db.prepare("SELECT message FROM registration_jobs WHERE id = ?").get(jobId).message;
        assert.equal(stored, job.message);

        const events = await jsonRequest(runtime.app, `/api/registration/jobs/${jobId}/events`);
        assert.equal(events.body.items[0].message, "浏览器代理出口 IP: 203.0.113.24");
        assert.equal(events.body.items[0].detail.fingerprint_session_id, "abcdef123456");
        assert.equal(events.body.items[1].password, "[REDACTED]");
        assert.equal(events.body.items[1].session_id, "[REDACTED]");
        assert.equal(events.body.items[1].proxy, "gate-us.kookeey.info:1000:***:***");
        assert.deepEqual(events.body.items[1].detail.proxy, {
          username: "[REDACTED]",
          password: "[REDACTED]",
          session_id: "[REDACTED]",
        });
        assert.doesNotMatch(JSON.stringify({ job, stored, events: events.body }), /private-user|base-secret|87654321/i);
      } finally {
        client.getTask = originalGetTask;
        client.getTaskEvents = originalGetTaskEvents;
        db.prepare("DELETE FROM registration_jobs WHERE id = ?").run(jobId);
      }
    });

    await t.test("force releases an active registration without deleting account data", async () => {
      const created = await jsonRequest(runtime.app, "/api/registration/jobs", {
        method: "POST",
        body: JSON.stringify({
          accountId: account.id,
          baseAddressId: base.id,
          count: 1,
          suffix: "release-me",
          browserMode: "headed",
          proxies: [],
        }),
      });
      const job = created.body.items[0];
      const taskId = client.created.at(-1) && `task-${client.created.length}`;

      const released = await jsonRequest(runtime.app, `/api/registration/jobs/${job.id}/release`, {
        method: "POST",
      });

      assert.equal(released.response.status, 200);
      assert.equal(released.body.item.status, "cancelled");
      assert.equal(released.body.release_mode, "force_release");
      assert.equal(client.released.at(-1), taskId);
      assert.equal(client.deletedAccounts.size, 0);
    });

    await t.test("keeps a cancel-requested registration releasable until the remote worker exits", async () => {
      const created = await jsonRequest(runtime.app, "/api/registration/jobs", {
        method: "POST",
        body: JSON.stringify({
          accountId: account.id,
          baseAddressId: base.id,
          count: 1,
          suffix: "cancel-then-release",
          browserMode: "headed",
          proxies: [],
        }),
      });
      const job = created.body.items[0];
      const taskId = `task-${client.created.length}`;

      const cancelled = await jsonRequest(runtime.app, `/api/registration/jobs/${job.id}/cancel`, {
        method: "POST",
      });

      assert.equal(cancelled.response.status, 200);
      assert.equal(cancelled.body.item.status, "cancel_requested");
      assert.equal(cancelled.body.item.finished_at, null);
      assert.equal(client.cancelled.at(-1), taskId);

      const released = await jsonRequest(runtime.app, `/api/registration/jobs/${job.id}/release`, {
        method: "POST",
      });

      assert.equal(released.response.status, 200);
      assert.equal(released.body.item.status, "cancelled");
      assert.equal(released.body.release_mode, "force_release");
      assert.equal(client.released.at(-1), taskId);

      db.prepare("DELETE FROM registration_jobs WHERE id = ?").run(job.id);
    });

    await t.test("optionally sets a password after registration and validates the checkbox", async () => {
      const enabled = await jsonRequest(runtime.app, "/api/registration/jobs", {
        method: "POST",
        body: JSON.stringify({
          accountId: account.id,
          baseAddressId: base.id,
          count: 1,
          suffix: "with-password",
          browserMode: "headless",
          proxies: [],
          setPasswordAfterRegistration: true,
          autoContinuePostSignup: false,
          password: "ExactPassword#42",
        }),
      });
      assert.equal(enabled.response.status, 202);
      assert.equal(client.created.at(-1).password, "ExactPassword#42");
      assert.equal(client.created.at(-1).extra.set_password_after_registration, true);
      assert.equal(client.created.at(-1).extra.auto_continue_post_signup, false);
      assert.equal(client.created.at(-1).executor_type, "headed");
      assert.equal(enabled.body.items[0].browser_mode, "headed");
      configuredPasswordEmail = enabled.body.items[0].email;

      const createdBeforeInvalid = client.created.length;
      const invalid = await jsonRequest(runtime.app, "/api/registration/jobs", {
        method: "POST",
        body: JSON.stringify({
          accountId: account.id,
          baseAddressId: base.id,
          count: 1,
          setPasswordAfterRegistration: "true",
        }),
      });
      assert.equal(invalid.response.status, 400);
      assert.equal(invalid.body.error, "注册后设置密码必须是布尔值");
      assert.equal(client.created.length, createdBeforeInvalid);

      const invalidContinue = await jsonRequest(runtime.app, "/api/registration/jobs", {
        method: "POST",
        body: JSON.stringify({
          accountId: account.id,
          baseAddressId: base.id,
          count: 1,
          autoContinuePostSignup: "true",
        }),
      });
      assert.equal(invalidContinue.response.status, 400);
      assert.equal(invalidContinue.body.error, "注册后自动完成准备页面必须是布尔值");
      assert.equal(client.created.length, createdBeforeInvalid);

      const passwordWithoutOption = await jsonRequest(runtime.app, "/api/registration/jobs", {
        method: "POST",
        body: JSON.stringify({
          accountId: account.id,
          baseAddressId: base.id,
          count: 1,
          setPasswordAfterRegistration: false,
          password: "ExactPassword#42",
        }),
      });
      assert.equal(passwordWithoutOption.response.status, 400);
      assert.equal(passwordWithoutOption.body.error, "请先勾选注册后设置密码再填写指定密码");
      assert.equal(client.created.length, createdBeforeInvalid);

      const invalidPasswords = [
        { value: 123456789012, error: "指定密码必须是字符串" },
        { value: "ShortPass#1", error: "指定密码长度必须为 12 到 128 个字符" },
        { value: "x".repeat(129), error: "指定密码长度必须为 12 到 128 个字符" },
        { value: " ExactPassword#42", error: "指定密码不能包含首尾空白" },
        { value: "ExactPass\tword#42", error: "指定密码不能包含控制字符" },
      ];
      for (const entry of invalidPasswords) {
        const invalidPassword = await jsonRequest(runtime.app, "/api/registration/jobs", {
          method: "POST",
          body: JSON.stringify({
            accountId: account.id,
            baseAddressId: base.id,
            count: 1,
            setPasswordAfterRegistration: true,
            password: entry.value,
          }),
        });
        assert.equal(invalidPassword.response.status, 400);
        assert.equal(invalidPassword.body.error, entry.error);
        assert.equal(client.created.length, createdBeforeInvalid);
      }
    });

    await t.test("uses an exact custom suffix when provided", async () => {
      const response = await jsonRequest(runtime.app, "/api/registration/jobs", {
        method: "POST",
        body: JSON.stringify({
          accountId: account.id,
          baseAddressId: base.id,
          count: 1,
          suffix: "My Campaign",
          browserMode: "headed",
          proxies: [],
        }),
      });
      assert.equal(response.response.status, 202);
      assert.equal(response.body.items[0].email, "source+gpt-my-campaign@outlook.com");
      assert.equal(client.created.at(-1).email, "source+gpt-my-campaign@outlook.com");
      legacyPasswordEmail = client.created.at(-1).email;
      client.created.at(-1).passwordOverview = {};
    });

    await t.test("selects one exact saved proxy or direct mode from the registration form", async () => {
      setSetting(db, "registration_proxy_pool", JSON.stringify([
        "http://first:secret@proxy-one.example:8001",
        "http://second:secret@proxy-two.example:8002",
      ]));
      const selected = await jsonRequest(runtime.app, "/api/registration/jobs", {
        method: "POST",
        body: JSON.stringify({
          accountId: account.id,
          baseAddressId: base.id,
          count: 1,
          suffix: "selected-proxy",
          browserMode: "headed",
          proxySelection: "proxy:1",
        }),
      });
      assert.equal(selected.response.status, 202);
      assert.equal(client.created.at(-1).proxy, "http://second:secret@proxy-two.example:8002");
      assert.equal(selected.body.items[0].proxy_label, "http://***@proxy-two.example:8002");

      const direct = await jsonRequest(runtime.app, "/api/registration/jobs", {
        method: "POST",
        body: JSON.stringify({
          accountId: account.id,
          baseAddressId: base.id,
          count: 1,
          suffix: "direct-mode",
          browserMode: "headed",
          proxySelection: "direct",
        }),
      });
      assert.equal(direct.response.status, 202);
      assert.equal(client.created.at(-1).proxy, null);
      assert.equal(direct.body.items[0].proxy_label, "直连");
    });

    await t.test("rejects deleting a running or queued registration record", async () => {
      const target = db.prepare("SELECT * FROM registration_jobs WHERE status = 'queued' ORDER BY id DESC LIMIT 1").get();
      const response = await jsonRequest(runtime.app, `/api/registration/jobs/${target.id}`, { method: "DELETE" });
      assert.equal(response.response.status, 409);
      assert.equal(db.prepare("SELECT deleted_at FROM registration_jobs WHERE id = ?").get(target.id).deleted_at, null);
    });

    await t.test("syncs success, generated identity, exit IP, and registered credentials", async () => {
      const jobs = await jsonRequest(runtime.app, "/api/registration/jobs");
      assert.equal(jobs.response.status, 200);
      assert.equal(jobs.body.items[0].status, "completed");
      assert.equal(jobs.body.items[0].display_name, "Alex Morgan");
      assert.equal(jobs.body.items[0].birth_date, "1994-06-18");
      assert.equal(jobs.body.items[0].exit_ip, "203.0.113.24");
      assert.equal(jobs.body.items[0].fingerprint_id, "abcdef123456");

      const accounts = await jsonRequest(runtime.app, "/api/registration/accounts");
      assert.equal(accounts.response.status, 200);
      assert.equal(accounts.body.items.length, 6);
      assert.equal(accounts.body.items.some((item) => item.email === "unrelated@example.com"), false);
      assert.equal(accounts.body.items[0].display_name, "Alex Morgan");
      assert.equal(accounts.body.items[0].exit_ip, "203.0.113.24");
      const passwordless = accounts.body.items.find((item) => item.email === client.created[0].email);
      assert.equal(passwordless.password, "");
      assert.equal(passwordless.password_status, "not_configured");
      assert.equal(passwordless.password_source, "none");
      assert.equal(passwordless.password_error, "");
      assert.equal(passwordless.password_available, false);
      const configured = accounts.body.items.find((item) => item.email === configuredPasswordEmail);
      assert.match(configured.password, /^Password-/);
      assert.equal(configured.password_status, "configured");
      assert.equal(configured.password_source, "settings");
      assert.equal(configured.password_available, true);
      const legacy = accounts.body.items.find((item) => item.email === legacyPasswordEmail);
      assert.equal(legacy.password, "");
      assert.equal(legacy.password_status, "unknown");
      assert.equal(legacy.password_available, false);
      assert.equal(accounts.body.items[0].access_token_available, true);
      assert.equal("credentials" in accounts.body.items[0], false);
      assert.equal("access_token" in accounts.body.items[0], false);

      const token = await jsonRequest(runtime.app, `/api/registration/accounts/${accounts.body.items[0].id}/access-token`);
      assert.equal(token.response.status, 200);
      assert.match(token.body.access_token, /^session-access-token-/);
      assert.equal(token.body.access_token.startsWith("primary-token-"), false);
    });

    await t.test("edits registered account names and groups locally", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const target = before.body.items[0];
      assert.equal(target.custom_name, "");
      assert.equal(target.group_name, "");

      const saved = await jsonRequest(runtime.app, `/api/registration/accounts/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({ custom_name: "  主账号  ", group_name: "  运营组  " }),
      });
      assert.equal(saved.response.status, 200);
      assert.equal(saved.body.item.custom_name, "主账号");
      assert.equal(saved.body.item.group_name, "运营组");
      assert.deepEqual(
        db.prepare("SELECT email, custom_name, group_name FROM registered_account_metadata WHERE external_account_id = ?").get(String(target.id)),
        { email: target.email, custom_name: "主账号", group_name: "运营组" },
      );

      const partial = await jsonRequest(runtime.app, `/api/registration/accounts/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({ group_name: "长期使用" }),
      });
      assert.equal(partial.body.item.custom_name, "主账号");
      assert.equal(partial.body.item.group_name, "长期使用");
      const listed = await jsonRequest(runtime.app, "/api/registration/accounts");
      const updated = listed.body.items.find((item) => Number(item.id) === Number(target.id));
      assert.equal(updated.custom_name, "主账号");
      assert.equal(updated.group_name, "长期使用");

      const invalidInputs = [
        [{}, "请填写要修改的账号名称或分组"],
        [{ custom_name: 42 }, "账号名称必须是字符串"],
        [{ custom_name: "x".repeat(61) }, "账号名称最多 60 个字符"],
        [{ group_name: "第一行\n第二行" }, "分组名称不能包含控制字符"],
      ];
      for (const [body, error] of invalidInputs) {
        const invalid = await jsonRequest(runtime.app, `/api/registration/accounts/${target.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        assert.equal(invalid.response.status, 400);
        assert.equal(invalid.body.error, error);
      }
      const invalidId = await jsonRequest(runtime.app, "/api/registration/accounts/not-an-id", {
        method: "PATCH",
        body: JSON.stringify({ custom_name: "无效" }),
      });
      assert.equal(invalidId.response.status, 400);
      const unrelated = await jsonRequest(runtime.app, "/api/registration/accounts/999", {
        method: "PATCH",
        body: JSON.stringify({ custom_name: "不应保存" }),
      });
      assert.equal(unrelated.response.status, 404);

      const cleared = await jsonRequest(runtime.app, `/api/registration/accounts/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({ custom_name: "", group_name: "" }),
      });
      assert.equal(cleared.response.status, 200);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM registered_account_metadata WHERE external_account_id = ?").get(String(target.id)).count, 0);

      await jsonRequest(runtime.app, `/api/registration/accounts/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({ custom_name: "待删除账号", group_name: "清理测试" }),
      });
    });

    await t.test("classifies occupied emails and warns only after recent distinct conflicts", async () => {
      const splitAddresses = db.prepare(`
        SELECT id, address FROM addresses
        WHERE parent_address_id = ? AND kind = 'split'
        ORDER BY id LIMIT 2
      `).all(base.id);
      assert.equal(splitAddresses.length, 2);
      const insert = db.prepare(`
        INSERT INTO registration_jobs (
          account_id, address_id, email, status, stage, browser_mode, proxy_label, fingerprint_id,
          message, created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, 'register', 'headed', '直连', 'synthetic123', ?, ?, ?, ?)
      `);
      const syntheticIds = [];
      const addJob = (address, status, message, createdAt) => {
        const result = insert.run(account.id, address.id, address.address, status, message, createdAt, createdAt, createdAt);
        syntheticIds.push(Number(result.lastInsertRowid));
        return Number(result.lastInsertRowid);
      };

      const firstId = addJob(
        splitAddresses[0],
        "failed",
        "about_you 提交失败: error_code: user_already_existsrequest_id: test-request",
        "2099-01-01T00:00:01.000Z",
      );
      const jobsAfterFirstConflict = await jsonRequest(runtime.app, "/api/registration/jobs?limit=500");
      const failedJob = jobsAfterFirstConflict.body.items.find((item) => item.id === firstId);
      assert.equal(failedJob.failure_reason, "user_already_exists");
      assert.equal(failedJob.display_message, "目标站已存在此邮箱账号，建议更换基础地址");

      db.prepare("UPDATE registration_jobs SET deleted_at = ? WHERE id = ?").run("2099-01-01T00:00:01.500Z", firstId);
      let options = await jsonRequest(runtime.app, "/api/registration/options");
      let baseOption = options.body.accounts[0].bases.find((item) => item.id === base.id);
      assert.equal(baseOption.registration_state, "warning");
      assert.equal(baseOption.already_exists_count, 1);

      addJob(splitAddresses[1], "failed", "ACCOUNT_ALREADY_EXISTS", "2099-01-01T00:00:02.000Z");
      addJob(splitAddresses[1], "failed", "task already running", "2099-01-01T00:00:03.000Z");
      options = await jsonRequest(runtime.app, "/api/registration/options");
      baseOption = options.body.accounts[0].bases.find((item) => item.id === base.id);
      assert.equal(baseOption.registration_state, "likely_exhausted");
      assert.equal(baseOption.already_exists_count, 2);
      assert.match(baseOption.registration_hint, /建议更换基础地址/);

      addJob(splitAddresses[0], "completed", "注册成功", "2099-01-01T00:00:04.000Z");
      options = await jsonRequest(runtime.app, "/api/registration/options");
      baseOption = options.body.accounts[0].bases.find((item) => item.id === base.id);
      assert.equal(baseOption.registration_state, "available");
      assert.equal(baseOption.already_exists_count, 0);

      db.prepare(`DELETE FROM registration_jobs WHERE id IN (${syntheticIds.map(() => "?").join(", ")})`).run(...syntheticIds);
    });

    await t.test("bulk deletes terminal registration records atomically", async () => {
      const splitAddresses = db.prepare(`
        SELECT id, address FROM addresses
        WHERE parent_address_id = ? AND kind = 'split'
        ORDER BY id LIMIT 3
      `).all(base.id);
      const insert = db.prepare(`
        INSERT INTO registration_jobs (
          account_id, address_id, email, status, stage, browser_mode, proxy_label, fingerprint_id,
          message, created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, 'register', 'headed', '直连', 'bulk-delete', ?, ?, ?, ?)
      `);
      const addJob = (address, status, createdAt) => Number(insert.run(
        account.id,
        address.id,
        address.address,
        status,
        status,
        createdAt,
        createdAt,
        status === "queued" ? null : createdAt,
      ).lastInsertRowid);
      const failedId = addJob(splitAddresses[0], "failed", "2099-02-01T00:00:01.000Z");
      const completedId = addJob(splitAddresses[1], "completed", "2099-02-01T00:00:02.000Z");
      const queuedId = addJob(splitAddresses[2], "queued", "2099-02-01T00:00:03.000Z");

      const mixed = await jsonRequest(runtime.app, "/api/registration/jobs/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ ids: [failedId, queuedId] }),
      });
      assert.equal(mixed.response.status, 409);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM registration_jobs WHERE id IN (?, ?) AND deleted_at IS NULL").get(failedId, queuedId).count, 2);

      const empty = await jsonRequest(runtime.app, "/api/registration/jobs/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ ids: [] }),
      });
      assert.equal(empty.response.status, 400);

      const removed = await jsonRequest(runtime.app, "/api/registration/jobs/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ ids: [failedId, completedId, failedId] }),
      });
      assert.equal(removed.response.status, 200);
      assert.equal(removed.body.deleted, 2);
      assert.deepEqual(removed.body.ids, [failedId, completedId]);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM registration_jobs WHERE id IN (?, ?) AND deleted_at IS NOT NULL").get(failedId, completedId).count, 2);

      db.prepare("DELETE FROM registration_jobs WHERE id = ?").run(queuedId);
    });

    await t.test("deletes a completed record without removing its registered account", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/jobs");
      const target = before.body.items[0];
      const targetAddressId = db.prepare("SELECT address_id FROM registration_jobs WHERE id = ?").get(target.id).address_id;
      const removed = await jsonRequest(runtime.app, `/api/registration/jobs/${target.id}`, { method: "DELETE" });
      assert.equal(removed.response.status, 200);
      assert.equal(removed.body.deleted, 1);

      const jobs = await jsonRequest(runtime.app, "/api/registration/jobs");
      assert.equal(jobs.body.items.some((item) => item.id === target.id), false);
      assert.ok(db.prepare("SELECT deleted_at FROM registration_jobs WHERE id = ?").get(target.id).deleted_at);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE id = ?").get(targetAddressId).count, 1);
      const accounts = await jsonRequest(runtime.app, "/api/registration/accounts");
      assert.equal(accounts.body.total, 6);
      assert.equal(accounts.body.items.some((item) => item.email === target.email), true);
      const events = await jsonRequest(runtime.app, `/api/registration/jobs/${target.id}/events`);
      assert.equal(events.response.status, 404);
    });

    await t.test("automatically scans and returns mail for the exact split address", async () => {
      const job = db.prepare("SELECT * FROM registration_jobs WHERE deleted_at IS NULL ORDER BY id LIMIT 1").get();
      const receivedAt = nowIso();
      scanResult = {
        stage: "completed",
        messages: [{
          fingerprint: "registration-message",
          graphMessageId: "graph-registration-message",
          senderAddress: "noreply@openai.com",
          recipient: job.email,
          recipients: [job.email],
          subject: "Your verification code",
          preview: "Use 654321 to continue",
          body: "Your verification code is 654321",
          verificationCode: "654321",
          receivedAt,
        }, {
          fingerprint: "unrelated-registration-message",
          graphMessageId: "graph-unrelated-registration-message",
          senderAddress: "noreply@openai.com",
          recipient: base.address,
          recipients: [base.address],
          subject: "Other address verification code",
          preview: "Use 111222 to continue",
          body: "Your verification code is 111222",
          verificationCode: "111222",
          receivedAt,
        }],
        items: [{
          fingerprint: "registration-code",
          code: "654321",
          sender: "OpenAI",
          subject: "Your verification code",
          preview: "Use 654321 to continue",
          recipient: job.email,
          recipients: [job.email],
          receivedAt,
        }],
      };

      const denied = await jsonRequest(runtime.app, `/api/external/emails?email=${encodeURIComponent(job.email)}`);
      assert.equal(denied.response.status, 401);

      const allowed = await jsonRequest(runtime.app, `/api/external/emails?email=${encodeURIComponent(job.email)}`, {
        headers: { "x-api-key": "test-connector-key" },
      });
      assert.equal(allowed.response.status, 200);
      assert.equal(allowed.body.emails.length, 1);
      assert.equal(allowed.body.emails[0].verification_code, "654321");
      assert.equal(graph.scanCalls, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM verification_codes WHERE address_id = ?").get(job.address_id).count, 1);

      const registeredMailbox = await jsonRequest(
        runtime.app,
        `/api/registration/accounts/${job.external_account_id}/emails?top=5`,
      );
      assert.equal(registeredMailbox.response.status, 200);
      assert.equal(registeredMailbox.body.account_id, Number(job.external_account_id));
      assert.equal(registeredMailbox.body.email, job.email.toLowerCase());
      assert.equal(registeredMailbox.body.emails.length, 1);
      assert.equal(registeredMailbox.body.emails[0].verification_code, "654321");
      assert.equal(registeredMailbox.body.emails[0].body_preview, "Use 654321 to continue");
      assert.equal(graph.scanCalls, 1);

      for (const top of ["0", "1.5", "51", "not-a-number"]) {
        const invalidTop = await jsonRequest(
          runtime.app,
          `/api/registration/accounts/${job.external_account_id}/emails?top=${encodeURIComponent(top)}`,
        );
        assert.equal(invalidTop.response.status, 400, top);
        assert.match(invalidTop.body.error, /top.*整数/);
      }
      assert.equal(graph.scanCalls, 1);

      const originalGetAccount = client.getAccount.bind(client);
      const remoteAccount = await originalGetAccount(job.external_account_id);
      client.getAccount = async (id) => Number(id) === Number(job.external_account_id)
        ? { ...remoteAccount, email: "different@example.com" }
        : originalGetAccount(id);
      const mismatchedEmail = await jsonRequest(
        runtime.app,
        `/api/registration/accounts/${job.external_account_id}/emails`,
      );
      assert.equal(mismatchedEmail.response.status, 409);
      assert.equal(graph.scanCalls, 1);

      client.getAccount = async (id) => Number(id) === Number(job.external_account_id)
        ? { ...remoteAccount, platform: "cursor" }
        : originalGetAccount(id);
      const wrongPlatform = await jsonRequest(
        runtime.app,
        `/api/registration/accounts/${job.external_account_id}/emails`,
      );
      assert.equal(wrongPlatform.response.status, 409);
      assert.equal(graph.scanCalls, 1);

      const failedOnlyId = 777;
      const failedOnlyEmail = "failed-only@example.com";
      db.prepare(`
        INSERT INTO registration_jobs
          (account_id, address_id, email, status, stage, external_account_id, message, created_at, updated_at, finished_at)
        VALUES (?, ?, ?, 'failed', 'failed', ?, 'failed', ?, ?, ?)
      `).run(account.id, base.id, failedOnlyEmail, String(failedOnlyId), receivedAt, receivedAt, receivedAt);
      client.getAccount = async (id) => Number(id) === failedOnlyId
        ? { id: failedOnlyId, platform: "chatgpt", email: failedOnlyEmail }
        : originalGetAccount(id);
      const failedOnly = await jsonRequest(runtime.app, `/api/registration/accounts/${failedOnlyId}/emails`);
      assert.equal(failedOnly.response.status, 409);
      assert.equal(graph.scanCalls, 1);
      db.prepare("DELETE FROM registration_jobs WHERE external_account_id = ?").run(String(failedOnlyId));
      client.getAccount = originalGetAccount;

      const unrelatedMailbox = await jsonRequest(runtime.app, "/api/registration/accounts/999/emails");
      assert.equal(unrelatedMailbox.response.status, 409);
      assert.match(unrelatedMailbox.body.error, /原邮箱记录不匹配/);

      db.prepare(`
        INSERT INTO verification_codes (
          account_id, address_id, fingerprint, code, sender, subject, preview,
          received_at, is_used, is_hidden, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
      `).run(
        job.account_id,
        job.address_id,
        "registration-code-settings",
        "123456",
        "OpenAI",
        "Set your password",
        "Use 123456 to set your password",
        receivedAt,
        receivedAt,
      );

      db.prepare("UPDATE registration_jobs SET status = 'running', finished_at = NULL WHERE id = ?").run(job.id);
      const synced = await jsonRequest(runtime.app, "/api/registration/jobs");
      assert.equal(synced.response.status, 200);
      assert.deepEqual(
        db.prepare("SELECT is_used, is_hidden FROM verification_codes WHERE address_id = ? ORDER BY id").all(job.address_id),
        [{ is_used: 1, is_hidden: 1 }, { is_used: 1, is_hidden: 1 }],
      );
      const visibleCodes = await jsonRequest(runtime.app, `/api/codes?accountId=${account.id}`);
      assert.equal(visibleCodes.body.items.some((item) => item.address_id === job.address_id), false);
      const recycledCodes = await jsonRequest(runtime.app, `/api/codes?hidden=true&accountId=${account.id}`);
      assert.equal(recycledCodes.body.items.filter((item) => item.address_id === job.address_id).length, 2);
    });

    await t.test("bulk deletes only locally registered accounts and their credentials", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const targets = before.body.items.slice(0, 2);
      const jobCount = db.prepare("SELECT COUNT(*) AS count FROM registration_jobs").get().count;
      const addressCount = db.prepare("SELECT COUNT(*) AS count FROM addresses").get().count;

      const removed = await jsonRequest(runtime.app, "/api/registration/accounts/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ ids: [targets[0].id, targets[1].id, targets[0].id] }),
      });
      assert.equal(removed.response.status, 200);
      assert.equal(removed.body.requested, 2);
      assert.equal(removed.body.deleted, 2);
      assert.deepEqual(removed.body.failed, []);

      const after = await jsonRequest(runtime.app, "/api/registration/accounts");
      assert.equal(after.body.total, before.body.total - 2);
      assert.equal(client.deletedAccounts.size, 2);
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS count FROM registered_account_metadata WHERE external_account_id IN (?, ?)`)
          .get(String(targets[0].id), String(targets[1].id)).count,
        0,
      );
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM registration_jobs").get().count, jobCount);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM addresses").get().count, addressCount);

      const token = await jsonRequest(runtime.app, `/api/registration/accounts/${targets[0].id}/access-token`);
      assert.equal(token.response.status, 404);

      const unrelated = await jsonRequest(runtime.app, "/api/registration/accounts/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ ids: [999] }),
      });
      assert.equal(unrelated.response.status, 409);
    });
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    runtime.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
