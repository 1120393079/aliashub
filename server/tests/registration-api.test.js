import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createDatabase, createSourceAccount, getSetting, nowIso, setSetting } from "../db.js";
import { createApp } from "../index.js";
import { RegistrationService } from "../registration-service.js";
import { jsonRequest } from "./http-harness.js";

class FakeRegistrationClient {
  constructor() {
    this.created = [];
    this.cancelled = [];
    this.released = [];
    this.deletedAccounts = new Set();
    this.importedAccounts = [];
    this.proxyInspections = [];
    this.proxyInspectionError = null;
    this.proxyInspectionHandler = null;
    this.createError = null;
    this.accountCreateError = null;
    this.accountActions = [];
    this.actionTasks = new Map();
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
      credentials: [
        { key: "access_token", value: `session-access-token-${index + 1}` },
        { key: "refresh_token", value: `session-refresh-token-${index + 1}` },
        { key: "id_token", value: `session-id-token-${index + 1}` },
        { key: "client_id", value: "codex-client-fixture" },
      ],
      display_status: "registered",
      plan_state: "free",
      created_at: nowIso(),
    })), ...this.importedAccounts, {
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

  async createAccount(payload) {
    if (this.accountCreateError) {
      throw typeof this.accountCreateError === "function"
        ? this.accountCreateError(payload)
        : this.accountCreateError;
    }
    const account = {
      id: 2_000 + this.importedAccounts.length,
      ...payload,
      overview: payload.overview || {},
      display_status: payload.overview?.display_status || payload.lifecycle_status || "registered",
      plan_state: payload.overview?.plan_state || "unknown",
      created_at: nowIso(),
    };
    this.importedAccounts.push(account);
    return account;
  }

  async deleteAccount(accountId) {
    const account = await this.getAccount(accountId);
    if (!account) throw Object.assign(new Error("账号不存在"), { status: 404 });
    this.deletedAccounts.add(Number(accountId));
    return { ok: true };
  }

  async createAccountAction(accountId, actionId, params) {
    const id = Number(accountId);
    const taskId = `checkout-${id}-${this.accountActions.length + 1}`;
    const checkoutType = id % 2 === 0 ? "cs_live" : "oaics";
    this.accountActions.push({ accountId: id, actionId, params });
    this.actionTasks.set(taskId, {
      task_id: taskId,
      type: "platform_action",
      platform: "chatgpt",
      status: "succeeded",
      result: {
        data: {
          checkout_url: `https://chatgpt.com/checkout/openai_llc/${checkoutType}_private_${id}`,
        },
      },
    });
    return {
      task_id: taskId,
      type: "platform_action",
      platform: "chatgpt",
      status: "pending",
    };
  }

  async getActionTask(taskId) {
    return this.actionTasks.get(taskId);
  }

  async cancelActionTask(taskId) {
    return { ...this.actionTasks.get(taskId), status: "cancel_requested" };
  }
}

test("registration job migration preserves legacy occupied alias history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-registration-legacy-test-"));
  const filename = path.join(directory, "legacy.db");
  let db;
  try {
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE source_accounts (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'connected'
      );
      CREATE TABLE addresses (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL,
        parent_address_id INTEGER,
        address TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE registration_jobs (
        id INTEGER PRIMARY KEY,
        account_id INTEGER,
        address_id INTEGER,
        email TEXT NOT NULL,
        external_task_id TEXT NOT NULL DEFAULT '',
        external_account_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued',
        stage TEXT NOT NULL DEFAULT 'queued',
        browser_mode TEXT NOT NULL DEFAULT 'headed',
        proxy_label TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL DEFAULT '',
        birth_date TEXT NOT NULL DEFAULT '',
        progress_current INTEGER NOT NULL DEFAULT 0,
        progress_total INTEGER NOT NULL DEFAULT 1,
        message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
    `);
    legacy.prepare("INSERT INTO source_accounts (id, email, status) VALUES (1, 'source@outlook.com', 'connected')").run();
    legacy.prepare(`
      INSERT INTO addresses (id, account_id, address, kind, status, created_at, updated_at)
      VALUES (10, 1, 'source@outlook.com', 'primary', 'active', ?, ?)
    `).run("2026-07-20T12:00:00.000Z", "2026-07-20T12:00:00.000Z");
    legacy.prepare(`
      INSERT INTO registration_jobs (id, account_id, address_id, email, status, stage, message, created_at, updated_at, finished_at)
      VALUES (100, 1, NULL, 'source+legacy-occupied@outlook.com', 'failed', 'register', '可能已在 OpenAI 注册过', ?, ?, ?)
    `).run("2026-07-20T12:00:00.000Z", "2026-07-20T12:00:00.000Z", "2026-07-20T12:00:00.000Z");
    legacy.close();

    db = createDatabase({ filename, seedDemo: false });
    const migrated = db.prepare("SELECT base_address_id, failure_reason FROM registration_jobs WHERE id = 100").get();
    assert.deepEqual(migrated, {
      base_address_id: 10,
      failure_reason: "user_already_exists",
    });
  } finally {
    db?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("RegistrationService createJobs preserves exact addressIds and rejects invalid selections", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-registration-address-ids-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const client = new FakeRegistrationClient();
  const registration = new RegistrationService({
    db,
    graph: {},
    client,
    publicBaseUrl: "https://alias.test/alias-hub",
    pickup: { registrationProtectionEnabled: () => false },
  });

  try {
    const account = createSourceAccount(db, { email: "exact-owner@icloud.com", provider: "icloud" });
    const otherAccount = createSourceAccount(db, { email: "other-owner@icloud.com", provider: "icloud" });
    db.prepare("UPDATE source_accounts SET status = 'connected', updated_at = ? WHERE id IN (?, ?)")
      .run(nowIso(), account.id, otherAccount.id);
    const insertAddress = db.prepare(`
      INSERT INTO addresses (
        account_id, address, kind, status, strategy, label, purpose, remote_confirmed, created_at, updated_at
      ) VALUES (?, ?, 'official', ?, 'icloud_hide_my_email', '精确注册地址测试', 'ChatGPT 注册', 1, ?, ?)
    `);
    const addAddress = (ownerId, email, status = "active") => Number(insertAddress.run(
      ownerId,
      email,
      status,
      nowIso(),
      nowIso(),
    ).lastInsertRowid);
    const firstId = addAddress(account.id, "exact-first@icloud.com");
    const secondId = addAddress(account.id, "exact-second@icloud.com");
    const thirdId = addAddress(account.id, "exact-third@icloud.com");
    const foreignId = addAddress(otherAccount.id, "exact-foreign@icloud.com");
    const disabledId = addAddress(account.id, "exact-disabled@icloud.com", "disabled");
    const requestedIds = [thirdId, firstId, secondId];

    const jobs = await registration.createJobs({
      accountId: account.id,
      addressIds: requestedIds,
      count: requestedIds.length,
      concurrency: 20,
      browserMode: "headless",
      proxySelection: "direct",
    });

    assert.deepEqual(jobs.map((item) => item.address_id), requestedIds);
    assert.deepEqual(jobs.map((item) => item.email), [
      "exact-third@icloud.com",
      "exact-first@icloud.com",
      "exact-second@icloud.com",
    ]);
    assert.deepEqual(client.created.map((item) => item.email), jobs.map((item) => item.email));
    assert.ok(client.created.every((item) => item.extra.registration_batch_concurrency === 3));

    const createdBeforeRejections = client.created.length;
    await assert.rejects(
      registration.createJobs({
        accountId: account.id,
        addressIds: [firstId],
        count: 1,
        concurrency: 21,
      }),
      (error) => error?.status === 400 && /1 到 20/.test(error.message),
    );
    await assert.rejects(
      registration.createJobs({ accountId: account.id, addressIds: [firstId, firstId], count: 2 }),
      (error) => error?.status === 400 && /无效或重复/.test(error.message),
    );
    await assert.rejects(
      registration.createJobs({ accountId: account.id, addressIds: [foreignId], count: 1 }),
      (error) => error?.status === 409 && /不可用/.test(error.message),
    );
    await assert.rejects(
      registration.createJobs({ accountId: account.id, addressIds: [disabledId], count: 1 }),
      (error) => error?.status === 409 && /不可用/.test(error.message),
    );
    assert.equal(client.created.length, createdBeforeRejections);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("registered account deletion accepts more than 500 accounts", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-registration-bulk-delete-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const deletedIds = new Set();

  try {
    const source = createSourceAccount(db, { email: "bulk-delete-owner@outlook.com" });
    const base = db.prepare("SELECT * FROM addresses WHERE account_id = ? AND kind = 'primary'").get(source.id);
    const timestamp = nowIso();
    const accounts = new Map();
    const accountIds = Array.from({ length: 802 }, (_, index) => 50_000 + index);
    const jobIds = [];
    const insertJob = db.prepare(`
      INSERT INTO registration_jobs (
        account_id, address_id, base_address_id, email, external_account_id, status, stage,
        browser_mode, proxy_label, progress_current, progress_total, message,
        created_at, updated_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, 'completed', 'completed', 'headless', '直连', 1, 1,
        '批量删除测试', ?, ?, ?)
    `);
    const insertMetadata = db.prepare(`
      INSERT INTO registered_account_metadata (
        external_account_id, email, custom_name, group_name, created_at, updated_at
      ) VALUES (?, ?, '', '批量删除测试', ?, ?)
    `);
    db.transaction(() => {
      accountIds.forEach((id, index) => {
        const email = `bulk-delete-${index + 1}@example.com`;
        accounts.set(id, { id, email, platform: "chatgpt" });
        jobIds.push(Number(insertJob.run(
          source.id,
          base.id,
          base.id,
          email,
          String(id),
          timestamp,
          timestamp,
          timestamp,
        ).lastInsertRowid));
        insertMetadata.run(String(id), email, timestamp, timestamp);
      });
    })();

    const registration = new RegistrationService({
      db,
      graph: {},
      client: {
        async getAccount(id) {
          return accounts.get(Number(id)) || null;
        },
        async deleteAccount(id) {
          deletedIds.add(Number(id));
          return { ok: true };
        },
      },
      pickup: { registrationProtectionEnabled: () => false },
    });

    assert.throws(
      () => registration.deleteJobs({ ids: jobIds.slice(0, 501) }),
      (error) => error?.status === 400 && /单次最多删除 500 个注册记录/.test(error.message),
    );

    const result = await registration.deleteRegisteredAccounts({ ids: accountIds });
    assert.equal(result.requested, 802);
    assert.equal(result.deleted, 802);
    assert.deepEqual(result.deleted_ids, accountIds);
    assert.deepEqual(result.failed, []);
    assert.equal(deletedIds.size, 802);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM registered_account_metadata").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM registration_jobs").get().count, 802);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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
  const inboxLinkFetchUrls = [];
  const checkoutProbeCalls = [];
  const checkoutProxy = "http://de-user:de-password@de-proxy.example:8080";
  const trialProbeCalls = [];
  const trialProxy = "http://jp-user:jp-password@jp-proxy.example:8080";
  const momoProbeCalls = [];
  const momoProxy = "http://vn-user:vn-password@vn-proxy.example:8080";
  const runtime = createApp({
    db,
    graph,
    registrationClient: client,
    publicBaseUrl: "https://alias.test/alias-hub",
    dataEncryptionKey: "registration-api-test-encryption-key",
    inboxLinkFetchFn: async (input) => {
      inboxLinkFetchUrls.push(String(input));
      return new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    checkoutProxyResolver: async () => checkoutProxy,
    checkoutProbe: async ({ accessToken, proxy }) => {
      checkoutProbeCalls.push({ accessToken, proxy });
      const accountNumber = Number(String(accessToken).match(/(\d+)$/)?.[1]);
      return accountNumber % 2 === 1 ? "cs_live" : "oaics";
    },
    trialProxyResolver: async () => trialProxy,
    trialProbe: async ({ accessToken, proxy }) => {
      trialProbeCalls.push({ accessToken, proxy });
      const accountNumber = Number(String(accessToken).match(/(\d+)$/)?.[1]);
      const eligible = accountNumber % 2 === 1;
      return {
        eligible,
        amountDue: eligible ? 0 : 1_500,
        currency: "JPY",
        evidence: "checkout.jp.plus.final_amount_due.v1",
      };
    },
    momoProxyResolver: async () => momoProxy,
    momoProbe: async ({ accessToken, proxy }) => {
      momoProbeCalls.push({ accessToken, proxy });
      const accountNumber = Number(String(accessToken).match(/(\d+)$/)?.[1]);
      const eligible = accountNumber % 2 === 1;
      return {
        eligible,
        methods: eligible ? ["card", "momo"] : ["card", "paypal"],
        evidence: eligible
          ? "stripe.free_trial.tax_refreshed_methods.v2"
          : "openai.free_trial.checkout_methods.v2",
      };
    },
  });
  let configuredPasswordEmail = "";
  let legacyPasswordEmail = "";
  let proxyFailureLogs = [];
  let deletedLocalAccountFixtures = [];

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
        new Error("upstream rejected http://kookeey-user:base-secret-TR-84726351-30m@gate-us.kookeey.info:1000"),
        { status: 502 },
      );
      const originalConsoleError = console.error;
      console.error = (...args) => { proxyFailureLogs.push(args.map(String).join(" ")); };
      let response;
      try {
        response = await jsonRequest(runtime.app, "/api/registration/proxies/inspect", {
          method: "POST",
          body: JSON.stringify({
            url: "gate-us.kookeey.info:1000:kookeey-user:base-secret-TR-50663419-30m",
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
      assert.doesNotMatch(JSON.stringify(response.body), /kookeey-user|base-secret|50663419|84726351|gate-us/i);
    });

    await t.test("redacts proxy credentials from remote failure logs", () => {
      assert.doesNotMatch(proxyFailureLogs.join("\n"), /kookeey-user|base-secret|50663419|84726351|gate-us/i);
    });

    await t.test("accepts only proxy forms supported consistently by requests and Playwright", async () => {
      const accepted = [
        "http://user%40team:p%3Aword@[2001:db8::1]:8080",
        "https://proxy.example:8443",
        "socks5://127.0.0.1:1080",
        "plain-proxy.example:3128",
        "gate-us.kookeey.info:1000:kookeey-user:base-secret-TR-50663419-30m",
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
        "http://kookeey-user:base-secret-TR-50663419-30m@gate-us.kookeey.info:1000",
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
      assert.doesNotMatch(serializedMetadata, /kookeey-user|base-secret|50663419|gate-us/i);

      const options = await jsonRequest(runtime.app, "/api/registration/options");
      assert.equal(options.response.status, 200);
      assert.deepEqual(options.body.proxyMetadata, saved.body.proxyMetadata);
      assert.doesNotMatch(JSON.stringify(options.body.proxyMetadata), /kookeey-user|base-secret|50663419|gate-us/i);
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
      const template = "gate-us.kookeey.info:1000:kookeey-user:base-secret-TR-50663419-30m";
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
      assert.equal(sampledSessions.includes("50663419"), false);
      const calls = client.proxyInspections.slice(previousCalls);
      assert.equal(calls.length, 3);
      assert.ok(calls.every((item) => item.samples === 1 && item.delay_ms === 0));
      const serialized = JSON.stringify(response.body);
      assert.doesNotMatch(serialized, /kookeey-user|base-secret|50663419|gate-us\.kookeey\.info/i);
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
            url: "gate-us.kookeey.info:1000:user:base-secret-TR-50663419-30m",
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
        "http://user:base-secret-TR-50663419-30m@gate-us.kookeey.info.evil:1000",
        "http://user:base-secret-TR-not-numeric-30m@gate-us.kookeey.info:1000",
        "http://user:base-secret-TR-50663419-0m@gate-us.kookeey.info:1000",
        "http://user:base-secret-TR-50663419-9999m@gate-us.kookeey.info:1000",
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
      const normalizedTemplate = "http://kookeey-user:base-secret-TR-50663419-30m@gate-us.kookeey.info:1000";
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
        assert.notEqual(password, "base-secret-TR-50663419-30m");
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
      assert.doesNotMatch(serializedJobs, /kookeey-user|base-secret|50663419/i);
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
      assert.doesNotMatch(JSON.stringify(response.body), /kookeey-user|base-secret|50663419/i);
      const stored = db.prepare("SELECT message FROM registration_jobs WHERE id = ?").get(response.body.items[0].id);
      assert.deepEqual(stored, { message: "注册任务提交失败" });
      const failedEvents = await jsonRequest(runtime.app, `/api/registration/jobs/${response.body.items[0].id}/events`);
      assert.equal(failedEvents.response.status, 200);
      assert.equal(failedEvents.body.items.length, 1);
      assert.match(failedEvents.body.items[0].message, /注册失败：注册任务提交失败/);
      assert.equal(failedEvents.body.items[0].detail.email, response.body.items[0].email);
      const listed = await jsonRequest(runtime.app, "/api/registration/jobs?limit=500");
      assert.equal(listed.body.counts.failed >= 1, true);
      assert.equal(listed.body.counts.total >= listed.body.items.length, true);
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
        message: "upstream rejected http://private-user:base-secret-TR-84726351-30m@gate-us.kookeey.info:1000",
        password: "root-password",
        session_id: "84726351",
        proxy: "gate-us.kookeey.info:1000:private-user:base-secret-TR-84726351-30m",
        detail: { proxy: { username: "private-user", password: "base-secret", session_id: "84726351" } },
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
        assert.doesNotMatch(JSON.stringify({ job, stored, events: events.body }), /private-user|base-secret|84726351/i);
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
      assert.equal(client.created.at(-1).executor_type, "headless");
      assert.equal(enabled.body.items[0].browser_mode, "headless");
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

    await t.test("registers one Microsoft base address directly without creating a plus alias", async () => {
      const directAccount = createSourceAccount(db, { email: "direct-base@outlook.com" });
      db.prepare("UPDATE source_accounts SET status = 'connected', updated_at = ? WHERE id = ?")
        .run(nowIso(), directAccount.id);
      const directBase = db.prepare("SELECT * FROM addresses WHERE account_id = ? AND kind = 'primary'")
        .get(directAccount.id);

      const created = await jsonRequest(runtime.app, "/api/registration/jobs", {
        method: "POST",
        body: JSON.stringify({
          accountId: directAccount.id,
          baseAddressId: directBase.id,
          addressMode: "base",
          count: 1,
          browserMode: "headed",
          proxySelection: "direct",
        }),
      });
      assert.equal(created.response.status, 202);
      assert.equal(created.body.items[0].email, "direct-base@outlook.com");
      assert.equal(client.created.at(-1).email, "direct-base@outlook.com");
      assert.doesNotMatch(client.created.at(-1).email, /\+/);

      const invalidCount = await jsonRequest(runtime.app, "/api/registration/jobs", {
        method: "POST",
        body: JSON.stringify({
          accountId: directAccount.id,
          baseAddressId: directBase.id,
          addressMode: "base",
          count: 2,
        }),
      });
      assert.equal(invalidCount.response.status, 400);
      assert.equal(invalidCount.body.error, "基础地址直注册每次只能提交 1 个任务");

      const duplicate = await jsonRequest(runtime.app, "/api/registration/jobs", {
        method: "POST",
        body: JSON.stringify({
          accountId: directAccount.id,
          baseAddressId: directBase.id,
          addressMode: "base",
          count: 1,
        }),
      });
      assert.equal(duplicate.response.status, 409);
      assert.equal(duplicate.body.error, "这个基础地址已有进行中的注册任务");

      db.prepare("DELETE FROM registration_jobs WHERE account_id = ?").run(directAccount.id);
      db.prepare("DELETE FROM addresses WHERE account_id = ?").run(directAccount.id);
      db.prepare("DELETE FROM source_accounts WHERE id = ?").run(directAccount.id);
      client.created.pop();
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

      const refreshToken = await jsonRequest(runtime.app, `/api/registration/accounts/${accounts.body.items[0].id}/refresh-token`);
      assert.equal(refreshToken.response.status, 200);
      assert.match(refreshToken.body.refresh_token, /^session-refresh-token-/);

      const sub2Export = await jsonRequest(runtime.app, `/api/registration/accounts/${accounts.body.items[0].id}/sub2api-export`);
      assert.equal(sub2Export.response.status, 200);
      assert.equal(sub2Export.body.email, accounts.body.items[0].email);
      assert.match(sub2Export.body.credentials.access_token, /^session-access-token-/);
      assert.match(sub2Export.body.credentials.refresh_token, /^session-refresh-token-/);
      assert.match(sub2Export.body.credentials.id_token, /^session-id-token-/);
      assert.equal(sub2Export.body.credentials.client_id, "codex-client-fixture");
      assert.equal(Object.hasOwn(sub2Export.body, "password"), false);
      assert.equal(Object.hasOwn(sub2Export.body.credentials, "session_token"), false);
    });

    await t.test("refreshes status and type for selected registered accounts only", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const ids = before.body.items.slice(0, 2).map((item) => Number(item.id));
      const calls = [];
      client.refreshAccountPlans = async (selectedIds) => {
        calls.push(selectedIds);
        return {
          updated: 1,
          timed_out: 1,
          items: [
            {
              account_id: selectedIds[0],
              ok: true,
              valid: true,
              account_type: "free",
              account_type_raw: "free",
              account_type_source: "backend-api/accounts/check+subscriptions",
              type_observed: true,
              plan_detection_result: "confirmed",
              plan_authority: "authoritative",
            },
            { account_id: selectedIds[1], ok: false, error: "proxy-user:proxy-password timeout" },
          ],
        };
      };
      try {
        const response = await jsonRequest(runtime.app, "/api/registration/accounts/refresh-status", {
          method: "POST",
          body: JSON.stringify({ ids: [ids[0], String(ids[1]), ids[0]] }),
        });
        assert.equal(response.response.status, 200);
        assert.deepEqual(calls, [ids]);
        assert.equal(response.body.requested, 2);
        assert.equal(response.body.checked, 1);
        assert.equal(response.body.failed, 1);
        const checkedItem = response.body.items.find((item) => item.id === ids[0]);
        const failedItem = response.body.items.find((item) => item.id === ids[1]);
        assert.equal(checkedItem.detection_status, "confirmed");
        assert.equal(checkedItem.code, "check_completed");
        assert.equal(checkedItem.type, "free");
        assert.equal(checkedItem.status, "active");
        assert.equal(checkedItem.retryable, false);
        assert.equal(checkedItem.source, "registration-refresh");
        assert.ok(Date.parse(checkedItem.time));
        assert.equal(failedItem.detection_status, "inconclusive");
        assert.equal(failedItem.code, "check_timeout");
        assert.equal(failedItem.retryable, true);
        assert.ok(failedItem.reason);
        assert.equal(response.body.accounts.items.length, before.body.items.length);
        assert.equal(response.body.accounts.items.find((item) => Number(item.id) === ids[0]).status_check_state, "checked");
        assert.equal(response.body.accounts.items.find((item) => Number(item.id) === ids[1]).status_check_state, "failed");
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM registered_account_status_checks").get().count, 2);
        assert.doesNotMatch(JSON.stringify(response.body), /proxy-user|proxy-password/);

        const unrelated = await jsonRequest(runtime.app, "/api/registration/accounts/refresh-status", {
          method: "POST",
          body: JSON.stringify({ ids: [999] }),
        });
        assert.equal(unrelated.response.status, 409);
        assert.deepEqual(calls, [ids]);
      } finally {
        delete client.refreshAccountPlans;
      }
    });

    await t.test("detects and persists cs_live versus oaics without exposing checkout ids", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const ids = before.body.items.slice(0, 2).map((item) => Number(item.id));
      const previousProbeCalls = checkoutProbeCalls.length;
      const response = await jsonRequest(runtime.app, "/api/registration/accounts/check-checkout", {
        method: "POST",
        body: JSON.stringify({ ids: [ids[0], String(ids[1]), ids[0]] }),
      });

      assert.equal(response.response.status, 200);
      assert.equal(response.body.requested, 2);
      assert.equal(response.body.checked, 2);
      assert.equal(response.body.failed, 0);
      assert.equal(response.body.types.cs_live, 1);
      assert.equal(response.body.types.oaics, 1);
      assert.deepEqual(checkoutProbeCalls.slice(previousProbeCalls), [
        { accessToken: "session-access-token-1", proxy: checkoutProxy },
        { accessToken: "session-access-token-2", proxy: checkoutProxy },
      ]);
      assert.doesNotMatch(JSON.stringify(response.body), /session-access-token|de-password|de-proxy\.example/i);
      const stored = db.prepare(`
        SELECT external_account_id, checkout_type, status, error
        FROM registered_account_checkout_checks
        WHERE external_account_id IN (?, ?)
        ORDER BY external_account_id
      `).all(...ids.map(String));
      assert.equal(stored.length, 2);
      assert.ok(stored.every((item) => item.status === "completed" && item.error === ""));
      for (const item of response.body.accounts.items.filter((account) => ids.includes(Number(account.id)))) {
        assert.equal(item.checkout_status, "completed");
        assert.equal(item.checkout_type, Number(item.id) === ids[0] ? "cs_live" : "oaics");
        assert.ok(Date.parse(item.checkout_checked_at));
      }

      const unrelated = await jsonRequest(runtime.app, "/api/registration/accounts/check-checkout", {
        method: "POST",
        body: JSON.stringify({ ids: [999] }),
      });
      assert.equal(unrelated.response.status, 409);
    });

    await t.test("reuses an existing cashier URL without creating another checkout", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const target = before.body.items[0];
      const previousGetAccount = client.getAccount.bind(client);
      const previousProbeCalls = checkoutProbeCalls.length;
      db.prepare("DELETE FROM registered_account_checkout_checks WHERE external_account_id = ?").run(String(target.id));
      client.getAccount = async (accountId) => {
        const account = await previousGetAccount(accountId);
        return Number(accountId) === Number(target.id)
          ? { ...account, cashier_url: "https://chatgpt.com/checkout/openai_llc/oaics_cached-value" }
          : account;
      };
      try {
        const response = await jsonRequest(runtime.app, "/api/registration/accounts/check-checkout", {
          method: "POST",
          body: JSON.stringify({ ids: [target.id] }),
        });
        assert.equal(response.response.status, 200);
        assert.equal(response.body.checked, 1);
        assert.equal(response.body.types.oaics, 1);
        assert.equal(checkoutProbeCalls.length, previousProbeCalls);
      } finally {
        client.getAccount = previousGetAccount;
      }
    });

    await t.test("refuses checkout detection before writing results when the proxy pool has no DE exit", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const targetId = Number(before.body.items[0].id);
      const previousResolver = runtime.registration.checkoutProxyResolver;
      const previousProxyPool = getSetting(db, "registration_proxy_pool", "[]");
      const previousInspectionHandler = client.proxyInspectionHandler;
      const previousProbeCalls = checkoutProbeCalls.length;
      db.prepare("DELETE FROM registered_account_checkout_checks WHERE external_account_id = ?").run(String(targetId));
      try {
        runtime.registration.checkoutProxyResolver = null;
        runtime.registration.checkoutProxyCache = { proxy: "", expiresAt: 0 };
        setSetting(db, "registration_proxy_pool", JSON.stringify(["http://jp-proxy.example:8080"]));
        client.proxyInspectionHandler = () => ({
          samples: [{ ip: "203.0.113.10", country_code: "JP" }],
        });

        const response = await jsonRequest(runtime.app, "/api/registration/accounts/check-checkout", {
          method: "POST",
          body: JSON.stringify({ ids: [targetId] }),
        });

        assert.equal(response.response.status, 409);
        assert.match(response.body.error, /没有检测到 DE 出口/);
        assert.equal(checkoutProbeCalls.length, previousProbeCalls);
        assert.equal(db.prepare(`
          SELECT COUNT(*) AS count FROM registered_account_checkout_checks
          WHERE external_account_id = ?
        `).get(String(targetId)).count, 0);
      } finally {
        runtime.registration.checkoutProxyResolver = previousResolver;
        runtime.registration.checkoutProxyCache = { proxy: "", expiresAt: 0 };
        client.proxyInspectionHandler = previousInspectionHandler;
        setSetting(db, "registration_proxy_pool", previousProxyPool);
      }
    });

    await t.test("continues checkout detection after an account-scoped creation rate limit", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const ids = before.body.items.slice(0, 2).map((item) => Number(item.id));
      const previousProbe = runtime.registration.checkoutProbe;
      const calls = [];
      runtime.registration.accountCheckoutCooldowns.clear();
      db.prepare(`
        DELETE FROM registered_account_checkout_checks
        WHERE external_account_id IN (?, ?)
      `).run(...ids.map(String));
      try {
        runtime.registration.checkoutProbe = async ({ accessToken }) => {
          calls.push(accessToken);
          if (accessToken.endsWith("-1")) {
            throw Object.assign(new Error("Checkout 创建失败 HTTP 429"), {
              status: 429,
              code: "checkout_creation_rate_limited",
            });
          }
          return "oaics";
        };
        const response = await jsonRequest(runtime.app, "/api/registration/accounts/check-checkout", {
          method: "POST",
          body: JSON.stringify({ ids }),
        });

        assert.equal(response.response.status, 200);
        assert.equal(response.body.checked, 1);
        assert.equal(response.body.rate_limited, 1);
        assert.equal(response.body.skipped, 0);
        assert.equal(response.body.types.oaics, 1);
        assert.equal(calls.length, 2);
        assert.equal(db.prepare(`
          SELECT COUNT(*) AS count FROM registered_account_checkout_checks
          WHERE external_account_id IN (?, ?)
        `).get(...ids.map(String)).count, 1);

        const retry = await jsonRequest(runtime.app, "/api/registration/accounts/check-checkout", {
          method: "POST",
          body: JSON.stringify({ ids: [ids[0]] }),
        });
        assert.equal(retry.response.status, 200);
        assert.equal(retry.body.rate_limited, 1);
        assert.equal(calls.length, 2);
        assert.ok(Date.parse(retry.body.items[0].checkout_retry_at));
      } finally {
        runtime.registration.checkoutProbe = previousProbe;
        runtime.registration.accountCheckoutCooldowns.clear();
      }
    });

    await t.test("stops a checkout batch after a rate-limited preflight without persisting transient failures", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const ids = before.body.items.slice(0, 2).map((item) => Number(item.id));
      const previousProbe = runtime.registration.checkoutProbe;
      let rateLimitedCalls = 0;
      db.prepare(`
        DELETE FROM registered_account_checkout_checks
        WHERE external_account_id IN (?, ?)
      `).run(...ids.map(String));
      try {
        runtime.registration.checkoutProbe = async () => {
          rateLimitedCalls += 1;
          throw Object.assign(new Error("Checkout 创建失败 HTTP 429"), { status: 429 });
        };
        const response = await jsonRequest(runtime.app, "/api/registration/accounts/check-checkout", {
          method: "POST",
          body: JSON.stringify({ ids }),
        });

        assert.equal(response.response.status, 200);
        assert.equal(response.body.requested, 2);
        assert.equal(response.body.checked, 0);
        assert.equal(response.body.failed, 0);
        assert.equal(response.body.rate_limited, 1);
        assert.equal(response.body.skipped, 1);
        assert.equal(rateLimitedCalls, 1);
        assert.equal(db.prepare(`
          SELECT COUNT(*) AS count FROM registered_account_checkout_checks
          WHERE external_account_id IN (?, ?)
        `).get(...ids.map(String)).count, 0);

      } finally {
        runtime.registration.checkoutProbe = previousProbe;
      }
    });

    await t.test("ends a checkout batch when an account read times out without persisting a failure", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const target = before.body.items[0];
      const previousGetAccount = client.getAccount;
      db.prepare("DELETE FROM registered_account_checkout_checks WHERE external_account_id = ?").run(String(target.id));
      client.getAccount = async () => {
        throw Object.assign(new Error("注册服务请求超时"), { status: 504 });
      };
      try {
        const response = await jsonRequest(runtime.app, "/api/registration/accounts/check-checkout", {
          method: "POST",
          body: JSON.stringify({ ids: [target.id] }),
        });
        assert.equal(response.response.status, 408);
        assert.match(response.body.error, /请求超时/);
        assert.equal(db.prepare(`
          SELECT COUNT(*) AS count FROM registered_account_checkout_checks
          WHERE external_account_id = ?
        `).get(String(target.id)).count, 0);
      } finally {
        client.getAccount = previousGetAccount;
      }
    });

    await t.test("detects and persists JP Plus one-month trial eligibility without exposing credentials", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const ids = before.body.items.slice(0, 2).map((item) => Number(item.id));
      const previousProbeCalls = trialProbeCalls.length;
      const response = await jsonRequest(runtime.app, "/api/registration/accounts/check-jp-trial", {
        method: "POST",
        body: JSON.stringify({ ids: [ids[0], String(ids[1]), ids[0]] }),
      });

      assert.equal(response.response.status, 200);
      assert.equal(response.body.requested, 2);
      assert.equal(response.body.checked, 2);
      assert.equal(response.body.eligible, 1);
      assert.equal(response.body.ineligible, 1);
      assert.equal(response.body.failed, 0);
      assert.deepEqual(trialProbeCalls.slice(previousProbeCalls), [
        { accessToken: "session-access-token-1", proxy: trialProxy },
        { accessToken: "session-access-token-2", proxy: trialProxy },
      ]);
      assert.doesNotMatch(JSON.stringify(response.body), /session-access-token|jp-password|jp-proxy\.example/i);
      const stored = db.prepare(`
        SELECT external_account_id, status, eligible, evidence, error
        FROM registered_account_trial_checks
        WHERE external_account_id IN (?, ?)
        ORDER BY external_account_id
      `).all(...ids.map(String));
      assert.equal(stored.length, 2);
      assert.deepEqual(stored.map((item) => item.status), ["eligible", "ineligible"]);
      assert.deepEqual(stored.map((item) => item.eligible), [1, 0]);
      assert.ok(stored.every((item) => item.evidence === "checkout.jp.plus.final_amount_due.v1" && item.error === ""));
      for (const item of response.body.accounts.items.filter((account) => ids.includes(Number(account.id)))) {
        assert.equal(item.trial_status, Number(item.id) === ids[0] ? "eligible" : "ineligible");
        assert.equal(item.trial_eligible, Number(item.id) === ids[0]);
        assert.ok(Date.parse(item.trial_checked_at));
      }

      const unrelated = await jsonRequest(runtime.app, "/api/registration/accounts/check-jp-trial", {
        method: "POST",
        body: JSON.stringify({ ids: [999] }),
      });
      assert.equal(unrelated.response.status, 409);
    });

    await t.test("refuses JP trial detection before writing results when the proxy pool has no JP exit", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const targetId = Number(before.body.items[0].id);
      const previousResolver = runtime.registration.trialProxyResolver;
      const previousProxyPool = getSetting(db, "registration_proxy_pool", "[]");
      const previousInspectionHandler = client.proxyInspectionHandler;
      const previousProbeCalls = trialProbeCalls.length;
      db.prepare("DELETE FROM registered_account_trial_checks WHERE external_account_id = ?").run(String(targetId));
      try {
        runtime.registration.trialProxyResolver = null;
        runtime.registration.trialProxyCache = { proxy: "", expiresAt: 0 };
        setSetting(db, "registration_proxy_pool", JSON.stringify(["http://de-proxy.example:8080"]));
        client.proxyInspectionHandler = () => ({
          samples: [{ ip: "203.0.113.20", country_code: "DE" }],
        });

        const response = await jsonRequest(runtime.app, "/api/registration/accounts/check-jp-trial", {
          method: "POST",
          body: JSON.stringify({ ids: [targetId] }),
        });

        assert.equal(response.response.status, 409);
        assert.match(response.body.error, /没有检测到 JP 出口/);
        assert.equal(trialProbeCalls.length, previousProbeCalls);
        assert.equal(db.prepare(`
          SELECT COUNT(*) AS count FROM registered_account_trial_checks
          WHERE external_account_id = ?
        `).get(String(targetId)).count, 0);
      } finally {
        runtime.registration.trialProxyResolver = previousResolver;
        runtime.registration.trialProxyCache = { proxy: "", expiresAt: 0 };
        client.proxyInspectionHandler = previousInspectionHandler;
        setSetting(db, "registration_proxy_pool", previousProxyPool);
      }
    });

    await t.test("stops a JP trial batch after a rate-limited preflight without persisting transient failures", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const ids = before.body.items.slice(0, 2).map((item) => Number(item.id));
      const previousProbe = runtime.registration.trialProbe;
      let rateLimitedCalls = 0;
      db.prepare(`
        DELETE FROM registered_account_trial_checks
        WHERE external_account_id IN (?, ?)
      `).run(...ids.map(String));
      try {
        runtime.registration.trialProbe = async () => {
          rateLimitedCalls += 1;
          throw Object.assign(new Error("账号资格检测失败 HTTP 429"), { status: 429 });
        };
        const response = await jsonRequest(runtime.app, "/api/registration/accounts/check-jp-trial", {
          method: "POST",
          body: JSON.stringify({ ids }),
        });

        assert.equal(response.response.status, 200);
        assert.equal(response.body.requested, 2);
        assert.equal(response.body.checked, 0);
        assert.equal(response.body.failed, 0);
        assert.equal(response.body.rate_limited, 1);
        assert.equal(response.body.skipped, 1);
        assert.equal(rateLimitedCalls, 1);
        assert.equal(db.prepare(`
          SELECT COUNT(*) AS count FROM registered_account_trial_checks
          WHERE external_account_id IN (?, ?)
        `).get(...ids.map(String)).count, 0);
      } finally {
        runtime.registration.trialProbe = previousProbe;
      }
    });

    await t.test("deduplicates concurrent JP trial checks for the same account", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const targetId = Number(before.body.items[0].id);
      const previousProbe = runtime.registration.trialProbe;
      let probeCalls = 0;
      let releaseProbe;
      let markStarted;
      const gate = new Promise((resolve) => { releaseProbe = resolve; });
      const started = new Promise((resolve) => { markStarted = resolve; });
      try {
        runtime.registration.trialProbe = async () => {
          probeCalls += 1;
          markStarted();
          await gate;
          return {
            eligible: true,
            amountDue: 0,
            currency: "JPY",
            evidence: "checkout.jp.plus.final_amount_due.v1",
          };
        };
        const first = runtime.registration.checkRegisteredAccountTrials({ ids: [targetId] });
        await started;
        const second = runtime.registration.checkRegisteredAccountTrials({ ids: [targetId] });
        await new Promise((resolve) => setImmediate(resolve));
        releaseProbe();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        assert.equal(probeCalls, 1);
        assert.equal(firstResult.items[0].trial_status, "eligible");
        assert.equal(secondResult.items[0].trial_status, "eligible");
      } finally {
        releaseProbe?.();
        runtime.registration.trialProbe = previousProbe;
      }
    });

    await t.test("detects and persists MoMo eligibility without exposing credentials", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const ids = before.body.items.slice(0, 2).map((item) => Number(item.id));
      const previousProbeCalls = momoProbeCalls.length;
      const response = await jsonRequest(runtime.app, "/api/registration/accounts/check-momo", {
        method: "POST",
        body: JSON.stringify({ ids: [ids[0], String(ids[1]), ids[0]] }),
      });

      assert.equal(response.response.status, 200);
      assert.equal(response.body.requested, 2);
      assert.equal(response.body.checked, 2);
      assert.equal(response.body.eligible, 1);
      assert.equal(response.body.ineligible, 1);
      assert.equal(response.body.failed, 0);
      assert.deepEqual(momoProbeCalls.slice(previousProbeCalls), [
        { accessToken: "session-access-token-1", proxy: momoProxy },
        { accessToken: "session-access-token-2", proxy: momoProxy },
      ]);
      assert.doesNotMatch(JSON.stringify(response.body), /session-access-token|vn-password|vn-proxy\.example/i);
      const stored = db.prepare(`
        SELECT external_account_id, status, eligible, methods, evidence, error
        FROM registered_account_momo_checks
        WHERE external_account_id IN (?, ?)
        ORDER BY external_account_id
      `).all(...ids.map(String));
      assert.equal(stored.length, 2);
      assert.deepEqual(stored.map((item) => item.status), ["eligible", "ineligible"]);
      assert.deepEqual(stored.map((item) => item.eligible), [1, 0]);
      assert.deepEqual(JSON.parse(stored[0].methods), ["card", "momo"]);
      assert.deepEqual(JSON.parse(stored[1].methods), ["card", "paypal"]);
      assert.deepEqual(stored.map((item) => item.evidence), [
        "stripe.free_trial.tax_refreshed_methods.v2",
        "openai.free_trial.checkout_methods.v2",
      ]);
      assert.ok(stored.every((item) => item.error === ""));
      for (const item of response.body.accounts.items.filter((account) => ids.includes(Number(account.id)))) {
        assert.equal(item.momo_status, Number(item.id) === ids[0] ? "eligible" : "ineligible");
        assert.equal(item.momo_eligible, Number(item.id) === ids[0]);
        assert.ok(Array.isArray(item.momo_methods) && item.momo_methods.length > 0);
        assert.ok(Date.parse(item.momo_checked_at));
      }

      const unrelated = await jsonRequest(runtime.app, "/api/registration/accounts/check-momo", {
        method: "POST",
        body: JSON.stringify({ ids: [999] }),
      });
      assert.equal(unrelated.response.status, 409);
    });

    await t.test("refuses MoMo detection before writing results when the proxy pool has no VN exit", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const targetId = Number(before.body.items[0].id);
      const previousResolver = runtime.registration.momoProxyResolver;
      const previousProxyPool = getSetting(db, "registration_proxy_pool", "[]");
      const previousInspectionHandler = client.proxyInspectionHandler;
      const previousProbeCalls = momoProbeCalls.length;
      db.prepare("DELETE FROM registered_account_momo_checks WHERE external_account_id = ?").run(String(targetId));
      try {
        runtime.registration.momoProxyResolver = null;
        runtime.registration.momoProxyCache = { proxy: "", expiresAt: 0 };
        setSetting(db, "registration_proxy_pool", JSON.stringify(["http://jp-proxy.example:8080"]));
        client.proxyInspectionHandler = () => ({
          samples: [{ ip: "203.0.113.30", country_code: "JP" }],
        });

        const response = await jsonRequest(runtime.app, "/api/registration/accounts/check-momo", {
          method: "POST",
          body: JSON.stringify({ ids: [targetId] }),
        });

        assert.equal(response.response.status, 409);
        assert.match(response.body.error, /没有检测到 VN 出口/);
        assert.equal(momoProbeCalls.length, previousProbeCalls);
        assert.equal(db.prepare(`
          SELECT COUNT(*) AS count FROM registered_account_momo_checks
          WHERE external_account_id = ?
        `).get(String(targetId)).count, 0);
      } finally {
        runtime.registration.momoProxyResolver = previousResolver;
        runtime.registration.momoProxyCache = { proxy: "", expiresAt: 0 };
        client.proxyInspectionHandler = previousInspectionHandler;
        setSetting(db, "registration_proxy_pool", previousProxyPool);
      }
    });

    await t.test("stops a MoMo batch after a rate-limited preflight without persisting a verdict", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const ids = before.body.items.slice(0, 2).map((item) => Number(item.id));
      const previousProbe = runtime.registration.momoProbe;
      let rateLimitedCalls = 0;
      db.prepare(`
        DELETE FROM registered_account_momo_checks
        WHERE external_account_id IN (?, ?)
      `).run(...ids.map(String));
      try {
        runtime.registration.momoProbe = async () => {
          rateLimitedCalls += 1;
          throw Object.assign(new Error("MoMo Checkout 创建失败 HTTP 429"), { status: 429 });
        };
        const response = await jsonRequest(runtime.app, "/api/registration/accounts/check-momo", {
          method: "POST",
          body: JSON.stringify({ ids }),
        });

        assert.equal(response.response.status, 200);
        assert.equal(response.body.requested, 2);
        assert.equal(response.body.checked, 0);
        assert.equal(response.body.failed, 0);
        assert.equal(response.body.rate_limited, 1);
        assert.equal(response.body.skipped, 1);
        assert.equal(rateLimitedCalls, 1);
        assert.equal(db.prepare(`
          SELECT COUNT(*) AS count FROM registered_account_momo_checks
          WHERE external_account_id IN (?, ?)
        `).get(...ids.map(String)).count, 0);
      } finally {
        runtime.registration.momoProbe = previousProbe;
      }
    });

    await t.test("edits registered account names and groups locally", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const target = before.body.items[0];
      assert.equal(target.custom_name, "");
      assert.equal(target.group_name, "Free 套餐");
      assert.equal(target.custom_group_name, "");
      assert.equal(target.default_group_name, "Free 套餐");
      assert.equal(target.group_source, "plan");

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
      assert.equal(updated.custom_group_name, "长期使用");
      assert.equal(updated.default_group_name, "Free 套餐");
      assert.equal(updated.group_source, "custom");

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
      const regrouped = await jsonRequest(runtime.app, "/api/registration/accounts");
      const autoGrouped = regrouped.body.items.find((item) => Number(item.id) === Number(target.id));
      assert.equal(autoGrouped.group_name, "Free 套餐");
      assert.equal(autoGrouped.custom_group_name, "");
      assert.equal(autoGrouped.group_source, "plan");

      await jsonRequest(runtime.app, `/api/registration/accounts/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({ group_name: "free" }),
      });
      const legacyPlanGroup = await jsonRequest(runtime.app, "/api/registration/accounts");
      const normalizedPlanGroup = legacyPlanGroup.body.items
        .find((item) => Number(item.id) === Number(target.id));
      assert.equal(normalizedPlanGroup.group_name, "Free 套餐");
      assert.equal(normalizedPlanGroup.custom_group_name, "");
      assert.equal(normalizedPlanGroup.group_source, "plan");

      await jsonRequest(runtime.app, `/api/registration/accounts/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({ custom_name: "待删除账号", group_name: "清理测试" }),
      });
    });

    await t.test("bulk edits groups for selected registered accounts", async () => {
      const before = await jsonRequest(runtime.app, "/api/registration/accounts");
      const targets = before.body.items.slice(0, 2);
      const ids = targets.map((item) => Number(item.id));
      const saved = await jsonRequest(runtime.app, "/api/registration/accounts/bulk-group", {
        method: "PATCH",
        body: JSON.stringify({ ids: [ids[0], ids[1], ids[0]], group_name: "  批量运营组  " }),
      });
      assert.equal(saved.response.status, 200);
      assert.equal(saved.body.updated, 2);
      assert.deepEqual(saved.body.ids, ids);
      assert.equal(saved.body.group_name, "批量运营组");
      assert.deepEqual(
        db.prepare(`
          SELECT external_account_id, group_name FROM registered_account_metadata
          WHERE external_account_id IN (?, ?) ORDER BY external_account_id
        `).all(...ids.map(String)),
        ids.map(String).sort().map((id) => ({ external_account_id: id, group_name: "批量运营组" })),
      );

      const listed = await jsonRequest(runtime.app, "/api/registration/accounts");
      for (const id of ids) {
        const item = listed.body.items.find((candidate) => Number(candidate.id) === id);
        assert.equal(item.group_name, "批量运营组");
        assert.equal(item.custom_group_name, "批量运营组");
        assert.equal(item.group_source, "custom");
      }

      const cleared = await jsonRequest(runtime.app, "/api/registration/accounts/bulk-group", {
        method: "PATCH",
        body: JSON.stringify({ ids, group_name: "" }),
      });
      assert.equal(cleared.response.status, 200);
      assert.equal(cleared.body.updated, 2);
      const automatic = await jsonRequest(runtime.app, "/api/registration/accounts");
      for (const id of ids) {
        const item = automatic.body.items.find((candidate) => Number(candidate.id) === id);
        assert.equal(item.custom_group_name, "");
        assert.equal(item.group_source, "plan");
      }

      const invalidInputs = [
        [{ group_name: "运营组" }, "请选择要编辑分组的注册账号"],
        [{ ids: [], group_name: "运营组" }, "请选择有效的注册账号"],
        [{ ids, group_name: "第一行\n第二行" }, "分组名称不能包含控制字符"],
        [{ ids }, "请填写目标分组"],
      ];
      for (const [body, error] of invalidInputs) {
        const invalid = await jsonRequest(runtime.app, "/api/registration/accounts/bulk-group", {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        assert.equal(invalid.response.status, 400);
        assert.equal(invalid.body.error, error);
      }
      const unrelated = await jsonRequest(runtime.app, "/api/registration/accounts/bulk-group", {
        method: "PATCH",
        body: JSON.stringify({ ids: [999], group_name: "运营组" }),
      });
      assert.equal(unrelated.response.status, 409);
    });

    await t.test("persists structured occupied error codes without replacing them with later generic failures", async () => {
      const mappedAddress = db.prepare(`
        SELECT id FROM addresses
        WHERE account_id = ? AND parent_address_id = ? AND kind = 'split'
        ORDER BY id LIMIT 1
      `).get(account.id, base.id);
      assert.ok(mappedAddress);
      const cases = [
        {
          name: "task error_code",
          task: { type: "register", status: "failed", error_code: "email_already_registered_on_openai" },
          events: [{ message: "注册失败" }],
        },
        {
          name: "task errors",
          task: { type: "register", status: "failed", errors: [{ code: "user_already_exists" }] },
          events: [{ message: "注册失败" }],
        },
        {
          name: "task result",
          task: {
            type: "register",
            status: "failed",
            result: { register_failed_reason: "email_already_registered_on_openai" },
          },
          events: [{ message: "注册失败" }],
        },
        {
          name: "task events",
          task: { type: "register", status: "failed" },
          events: [{ message: "注册失败", detail: { errors: [{ error_code: "user_already_exists" }] } }],
        },
      ];
      const insert = db.prepare(`
        INSERT INTO registration_jobs (
          account_id, address_id, base_address_id, email, external_task_id, status, stage, browser_mode,
          proxy_label, fingerprint_id, message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'running', 'register', 'headed', '直连', 'structured-error', '等待同步', ?, ?)
      `);
      const remote = new Map();
      const ids = [];
      const originalGetTask = client.getTask;
      const originalGetTaskEvents = client.getTaskEvents;
      try {
        cases.forEach((item, index) => {
          const taskId = `structured-occupied-${index + 1}`;
          const createdAt = `2099-01-02T00:00:0${index}.000Z`;
          const jobId = Number(insert.run(
            account.id,
            mappedAddress.id,
            base.id,
            `source+structured-occupied-${index + 1}@outlook.com`,
            taskId,
            createdAt,
            createdAt,
          ).lastInsertRowid);
          ids.push(jobId);
          remote.set(taskId, item);
        });
        client.getTask = async (taskId) => ({ task_id: taskId, ...remote.get(taskId).task });
        client.getTaskEvents = async (taskId) => remote.get(taskId).events;

        for (const jobId of ids) {
          const job = await runtime.registration.syncJob(runtime.registration.getJob(jobId));
          assert.equal(job.status, "failed");
          assert.equal(job.failure_reason, "user_already_exists");
          assert.equal(db.prepare("SELECT failure_reason FROM registration_jobs WHERE id = ?").get(jobId).failure_reason, "user_already_exists");
        }

        const preservedId = ids[0];
        const preservedTaskId = "structured-occupied-1";
        db.prepare(`
          UPDATE registration_jobs
          SET status = 'running', message = '已识别结构化占用错误', finished_at = NULL
          WHERE id = ?
        `).run(preservedId);
        remote.set(preservedTaskId, {
          task: { type: "register", status: "failed", error: "generic registration failed" },
          events: [{ message: "generic registration failed" }],
        });
        await runtime.registration.syncJob(runtime.registration.getJob(preservedId));
        assert.deepEqual(
          db.prepare("SELECT failure_reason, message FROM registration_jobs WHERE id = ?").get(preservedId),
          { failure_reason: "user_already_exists", message: "已识别结构化占用错误" },
        );
      } finally {
        client.getTask = originalGetTask;
        client.getTaskEvents = originalGetTaskEvents;
        if (ids.length) db.prepare(`DELETE FROM registration_jobs WHERE id IN (${ids.map(() => "?").join(", ")})`).run(...ids);
      }
    });

    await t.test("classifies registration_disallowed policy failures and preserves the public message", async () => {
      const mappedAddress = db.prepare(`
        SELECT id FROM addresses
        WHERE account_id = ? AND parent_address_id = ? AND kind = 'split'
        ORDER BY id LIMIT 1
      `).get(account.id, base.id);
      const taskId = "structured-policy-block";
      const createdAt = "2099-01-03T00:00:00.000Z";
      const jobId = Number(db.prepare(`
        INSERT INTO registration_jobs (
          account_id, address_id, base_address_id, email, external_task_id, status, stage, browser_mode,
          proxy_label, fingerprint_id, message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'running', 'about_you', 'headed', '直连', 'policy-error', '等待同步', ?, ?)
      `).run(
        account.id,
        mappedAddress.id,
        base.id,
        "source+structured-policy@outlook.com",
        taskId,
        createdAt,
        createdAt,
      ).lastInsertRowid);
      const originalGetTask = client.getTask;
      const originalGetTaskEvents = client.getTaskEvents;
      try {
        client.getTask = async () => ({
          task_id: taskId,
          type: "register",
          status: "failed",
          error_code: "registration_disallowed",
          error: { message: "Sorry, we cannot create your account with the given information." },
        });
        client.getTaskEvents = async () => [{
          message: "利用規約のため、お客様のアカウントを作成できません。",
        }];

        const synced = await runtime.registration.syncJob(runtime.registration.getJob(jobId));
        assert.equal(synced.failure_reason, "account_creation_policy_blocked");
        assert.equal(
          db.prepare("SELECT failure_reason FROM registration_jobs WHERE id = ?").get(jobId).failure_reason,
          "account_creation_policy_blocked",
        );
        const [publicJob] = await runtime.registration.listJobs({ limit: 1 });
        assert.equal(publicJob.id, jobId);
        assert.equal(publicJob.failure_reason, "account_creation_policy_blocked");
        assert.equal(publicJob.display_message, "目标站按注册策略拒绝创建账号，请更换网络出口或邮箱后重试");

        db.prepare(`
          UPDATE registration_jobs
          SET status = 'running', message = '已识别注册策略拒绝', finished_at = NULL
          WHERE id = ?
        `).run(jobId);
        client.getTask = async () => ({ task_id: taskId, type: "register", status: "failed", error: "generic failure" });
        client.getTaskEvents = async () => [{ message: "generic failure" }];
        await runtime.registration.syncJob(runtime.registration.getJob(jobId));
        assert.deepEqual(
          db.prepare("SELECT failure_reason, message FROM registration_jobs WHERE id = ?").get(jobId),
          { failure_reason: "account_creation_policy_blocked", message: "已识别注册策略拒绝" },
        );
      } finally {
        client.getTask = originalGetTask;
        client.getTaskEvents = originalGetTaskEvents;
        db.prepare("DELETE FROM registration_jobs WHERE id = ?").run(jobId);
      }
    });

    await t.test("keeps occupied alias markers after completed jobs, soft deletes, and split deletion", async () => {
      const splitAddresses = db.prepare(`
        SELECT id, address FROM addresses
        WHERE parent_address_id = ? AND kind = 'split'
        ORDER BY id LIMIT 2
      `).all(base.id);
      assert.equal(splitAddresses.length, 2);
      const insert = db.prepare(`
        INSERT INTO registration_jobs (
          account_id, address_id, base_address_id, email, status, stage, browser_mode, proxy_label, fingerprint_id,
          message, failure_reason, created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, 'register', 'headed', '直连', 'synthetic123', ?, ?, ?, ?, ?)
      `);
      const syntheticIds = [];
      const addJob = (address, status, message, createdAt, failureReason = "") => {
        const result = insert.run(
          account.id,
          address.id,
          base.id,
          address.address,
          status,
          message,
          failureReason,
          createdAt,
          createdAt,
          createdAt,
        );
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
      let baseOption = options.body.accounts.find((item) => item.id === account.id).bases.find((item) => item.id === base.id);
      assert.equal(baseOption.registration_state, "warning");
      assert.equal(baseOption.already_exists_count, 1);
      assert.equal(baseOption.occupied_alias_count, 1);
      assert.equal(baseOption.occupied_aliases[0].email, splitAddresses[0].address);
      assert.equal(baseOption.occupied_alias_last_seen_at, "2099-01-01T00:00:01.000Z");

      addJob(splitAddresses[1], "failed", "ACCOUNT_ALREADY_EXISTS", "2099-01-01T00:00:02.000Z");
      addJob(splitAddresses[1], "failed", "task already running", "2099-01-01T00:00:03.000Z");
      options = await jsonRequest(runtime.app, "/api/registration/options");
      baseOption = options.body.accounts.find((item) => item.id === account.id).bases.find((item) => item.id === base.id);
      assert.equal(baseOption.registration_state, "likely_exhausted");
      assert.equal(baseOption.already_exists_count, 2);
      assert.match(baseOption.registration_hint, /建议更换基础地址/);

      addJob(splitAddresses[0], "completed", "注册成功", "2099-01-01T00:00:04.000Z");
      options = await jsonRequest(runtime.app, "/api/registration/options");
      baseOption = options.body.accounts.find((item) => item.id === account.id).bases.find((item) => item.id === base.id);
      assert.equal(baseOption.registration_state, "likely_exhausted");
      assert.equal(baseOption.already_exists_count, 2);
      assert.equal(baseOption.occupied_alias_count, 2);

      const deletedSplitAddress = "source+gpt-occupied-history@outlook.com";
      const createdAt = "2099-01-01T00:00:05.000Z";
      const deletedSplitId = Number(db.prepare(`
        INSERT INTO addresses (
          account_id, parent_address_id, address, kind, status, strategy, label, purpose, remote_confirmed, created_at, updated_at
        ) VALUES (?, ?, ?, 'split', 'active', 'plus', 'GPT 注册', 'ChatGPT 注册', 0, ?, ?)
      `).run(account.id, base.id, deletedSplitAddress, createdAt, createdAt).lastInsertRowid);
      const deletedSplit = db.prepare("SELECT id, address FROM addresses WHERE id = ?").get(deletedSplitId);
      const deletedJobId = addJob(
        deletedSplit,
        "failed",
        "邮箱已被占用",
        "2099-01-01T00:00:06.000Z",
        "user_already_exists",
      );
      const addressList = await jsonRequest(runtime.app, `/api/addresses?accountId=${account.id}&kind=split&q=occupied-history`);
      assert.equal(addressList.response.status, 200);
      assert.equal(addressList.body.items.find((item) => item.id === deletedSplitId).registration_occupied, true);

      const removedSplit = await jsonRequest(runtime.app, "/api/addresses/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ accountId: account.id, ids: [deletedSplitId] }),
      });
      assert.equal(removedSplit.response.status, 200);
      assert.equal(removedSplit.body.deleted, 1);
      assert.equal(db.prepare("SELECT address_id, base_address_id FROM registration_jobs WHERE id = ?").get(deletedJobId).address_id, null);
      assert.equal(db.prepare("SELECT address_id, base_address_id FROM registration_jobs WHERE id = ?").get(deletedJobId).base_address_id, base.id);

      options = await jsonRequest(runtime.app, "/api/registration/options");
      baseOption = options.body.accounts.find((item) => item.id === account.id).bases.find((item) => item.id === base.id);
      assert.equal(baseOption.occupied_alias_count, 3);
      assert.equal(baseOption.occupied_aliases.length, 3);
      assert.ok(baseOption.occupied_aliases.some((item) => item.email === deletedSplitAddress));

      db.prepare(`DELETE FROM registration_jobs WHERE id IN (${syntheticIds.map(() => "?").join(", ")})`).run(...syntheticIds);
    });

    await t.test("blocks direct iCloud retries after a definite occupied alias failure", async () => {
      const icloud = createSourceAccount(db, { email: "occupied-alias@icloud.com", provider: "icloud" });
      db.prepare("UPDATE source_accounts SET status = 'connected', updated_at = ? WHERE id = ?").run(nowIso(), icloud.id);
      const icloudBase = db.prepare("SELECT * FROM addresses WHERE account_id = ? AND kind = 'primary'").get(icloud.id);
      const occupiedAt = "2099-01-03T00:00:00.000Z";
      const jobId = Number(db.prepare(`
        INSERT INTO registration_jobs (
          account_id, address_id, base_address_id, email, status, stage, browser_mode,
          message, failure_reason, created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, 'failed', 'register', 'headed', '邮箱已占用', 'user_already_exists', ?, ?, ?)
      `).run(icloud.id, icloudBase.id, icloudBase.id, icloudBase.address, occupiedAt, occupiedAt, occupiedAt).lastInsertRowid);
      try {
        const options = await jsonRequest(runtime.app, "/api/registration/options");
        const option = options.body.accounts.find((item) => item.id === icloud.id).bases.find((item) => item.id === icloudBase.id);
        assert.equal(option.registration_state, "occupied");
        assert.equal(option.registration_disabled, true);
        assert.equal(option.occupied_alias_count, 1);

        const repeated = await jsonRequest(runtime.app, "/api/registration/jobs", {
          method: "POST",
          body: JSON.stringify({ accountId: icloud.id, baseAddressId: icloudBase.id, count: 1 }),
        });
        assert.equal(repeated.response.status, 409);
        assert.match(repeated.body.error, /已被目标站占用/);
      } finally {
        db.prepare("DELETE FROM registration_jobs WHERE id = ?").run(jobId);
        db.prepare("DELETE FROM source_accounts WHERE id = ?").run(icloud.id);
      }
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
          body: "<html><body><strong>Your verification code is 654321</strong></body></html>",
          bodyContentType: "html",
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
      assert.equal(registeredMailbox.body.emails[0].body_content_type, "html");
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
      deletedLocalAccountFixtures = targets.map((item) => ({ id: item.id, email: item.email, password: item.password || "" }));
      const jobCount = db.prepare("SELECT COUNT(*) AS count FROM registration_jobs").get().count;
      const addressCount = db.prepare("SELECT COUNT(*) AS count FROM addresses").get().count;

      const removed = await jsonRequest(runtime.app, "/api/registration/accounts/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ ids: [targets[0].id, targets[1].id, targets[0].id] }),
      });
      assert.equal(removed.response.status, 200);
      assert.equal(removed.body.requested, 2);
      assert.equal(removed.body.deleted, 2);
      assert.deepEqual(removed.body.deleted_ids, targets.map((item) => Number(item.id)));
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

    await t.test("imports deleted local accounts and relinks their completed registration history", async () => {
      const content = JSON.stringify(deletedLocalAccountFixtures.map((item, index) => ({
        id: item.id,
        email: item.email,
        password: item.password,
        account_id: `restored-user-${index + 1}`,
        access_token: `restored-access-${index + 1}`,
        refresh_token: `restored-refresh-${index + 1}`,
        status: "active",
        plan_state: "plus",
      })));
      const restored = await jsonRequest(runtime.app, "/api/registration/accounts/import-local", {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      assert.equal(restored.response.status, 201);
      assert.equal(restored.body.imported, 2);
      assert.equal(restored.body.items.length, 2);
      assert.ok(restored.body.items.every((item) => Number(item.id) >= 2_000));
      assert.ok(client.importedAccounts.every((item) => item.provider_accounts
        .some((provider) => provider.provider_name === "outlook_email_api" && provider.login_identifier === item.email)));
      assert.ok(client.importedAccounts.every((item) => item.provider_resources
        .some((resource) => resource.provider_name === "outlook_email_api" && resource.handle === item.email)));
      assert.deepEqual(
        restored.body.items.map((item) => item.previous_account_id),
        deletedLocalAccountFixtures.map((item) => Number(item.id)),
      );

      const accounts = await jsonRequest(runtime.app, "/api/registration/accounts");
      for (const item of restored.body.items) {
        const account = accounts.body.items.find((candidate) => Number(candidate.id) === Number(item.id));
        assert.equal(account.email, item.email);
        assert.equal(account.access_token_available, true);
        assert.equal(
          db.prepare("SELECT external_account_id FROM registration_jobs WHERE id = ?").get(item.registration_job_id).external_account_id,
          String(item.id),
        );
      }

      const duplicate = await jsonRequest(runtime.app, "/api/registration/accounts/import-local", {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      assert.equal(duplicate.response.status, 409);
      assert.match(duplicate.body.error, /已在本地账号池/);

      const unrelated = await jsonRequest(runtime.app, "/api/registration/accounts/import-local", {
        method: "POST",
        body: JSON.stringify({ content: JSON.stringify([{ email: "no-history@example.com", password: "Password123" }]) }),
      });
      assert.equal(unrelated.response.status, 409);
      assert.match(unrelated.body.error, /没有可关联的已完成注册记录/);
    });

    await t.test("imports external accounts with encrypted inbox links and rolls back partial failures", async () => {
      const email = "external-owner@example.com";
      const inboxLink = "https://dispose.lol/ib/ExternalCaseSensitiveKey";
      const imported = await jsonRequest(runtime.app, "/api/registration/accounts/import-local", {
        method: "POST",
        body: JSON.stringify({ content: `${email}----${inboxLink}` }),
      });
      assert.equal(imported.response.status, 201);
      assert.equal(imported.body.imported, 1);
      assert.equal(imported.body.restored, 0);
      assert.equal(imported.body.external_imported, 1);
      assert.equal(imported.body.items[0].import_source, "external");
      assert.equal(imported.body.items[0].previous_account_id, 0);

      const remote = client.importedAccounts.find((item) => item.email === email);
      assert.ok(remote);
      assert.equal(remote.password, "");
      assert.ok(remote.provider_accounts.some((item) => (
        item.provider_name === "outlook_email_api" && item.login_identifier === email
      )));
      assert.ok(remote.provider_resources.some((item) => (
        item.provider_name === "outlook_email_api" && item.handle === email
      )));
      assert.doesNotMatch(JSON.stringify(remote), /ExternalCaseSensitiveKey/);

      const job = db.prepare("SELECT * FROM registration_jobs WHERE id = ?")
        .get(imported.body.items[0].registration_job_id);
      assert.equal(job.email, email);
      assert.equal(job.external_account_id, String(imported.body.items[0].id));
      assert.equal(job.status, "completed");
      assert.equal(job.stage, "external_import");
      assert.equal(job.proxy_label, "直连");
      assert.ok(job.account_id && job.address_id && job.base_address_id);

      const mailbox = db.prepare(`
        SELECT inbox_link_mailboxes.*, source_accounts.provider, source_accounts.status AS source_status,
          addresses.address, addresses.kind
        FROM inbox_link_mailboxes
        JOIN source_accounts ON source_accounts.id = inbox_link_mailboxes.source_account_id
        JOIN addresses ON addresses.id = ?
        WHERE inbox_link_mailboxes.email = ? COLLATE NOCASE
      `).get(job.address_id, email);
      assert.equal(mailbox.provider, "inbox_link");
      assert.equal(mailbox.source_status, "connected");
      assert.equal(mailbox.address, email);
      assert.equal(mailbox.kind, "primary");
      assert.match(mailbox.inbox_key_encrypted, /^v1\./);
      assert.doesNotMatch(mailbox.inbox_key_encrypted, /ExternalCaseSensitiveKey/);

      const accounts = await jsonRequest(runtime.app, "/api/registration/accounts");
      assert.equal(accounts.body.items.some((item) => (
        Number(item.id) === Number(imported.body.items[0].id) && item.email === email
      )), true);

      const duplicate = await jsonRequest(runtime.app, "/api/registration/accounts/import-local", {
        method: "POST",
        body: JSON.stringify({ content: `${email}----${inboxLink}` }),
      });
      assert.equal(duplicate.response.status, 409);
      assert.match(duplicate.body.error, /已在本地账号池/);

      const conflictingEmail = "conflicting-owner@example.com";
      const remoteCountBeforeConflict = client.importedAccounts.length;
      const conflict = await jsonRequest(runtime.app, "/api/registration/accounts/import-local", {
        method: "POST",
        body: JSON.stringify({ content: `${conflictingEmail}----${inboxLink}` }),
      });
      assert.equal(conflict.response.status, 409);
      assert.match(conflict.body.error, /取件链接已绑定到其他邮箱/);
      assert.equal(client.importedAccounts.length, remoteCountBeforeConflict);
      assert.equal(client.importedAccounts.some((item) => item.email === conflictingEmail), false);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM registration_jobs WHERE email = ? COLLATE NOCASE")
        .get(conflictingEmail).count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM inbox_link_mailboxes WHERE email = ? COLLATE NOCASE")
        .get(conflictingEmail).count, 0);

      const restoredLinkEmail = "restored-with-link@example.com";
      const mappedAt = nowIso();
      const legacyAddress = db.prepare(`
        INSERT INTO addresses (
          account_id, parent_address_id, address, kind, status, strategy, created_at, updated_at
        ) VALUES (?, ?, ?, 'split', 'active', 'manual', ?, ?)
      `).run(account.id, base.id, restoredLinkEmail, mappedAt, mappedAt);
      const legacyJob = db.prepare(`
        INSERT INTO registration_jobs (
          account_id, address_id, base_address_id, email, external_account_id, status, stage,
          browser_mode, proxy_label, progress_current, progress_total, message,
          created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, '1888', 'completed', 'completed', 'headless', '直连', 1, 1,
          '历史注册完成', ?, ?, ?)
      `).run(
        account.id,
        Number(legacyAddress.lastInsertRowid),
        base.id,
        restoredLinkEmail,
        mappedAt,
        mappedAt,
        mappedAt,
      );
      const restoredWithLink = await jsonRequest(runtime.app, "/api/registration/accounts/import-local", {
        method: "POST",
        body: JSON.stringify({
          content: `${restoredLinkEmail}----https://dispose.lol/ib/RestoredLinkKey`,
        }),
      });
      assert.equal(restoredWithLink.response.status, 201);
      assert.equal(restoredWithLink.body.restored, 1);
      assert.equal(restoredWithLink.body.external_imported, 0);
      assert.equal(restoredWithLink.body.items[0].registration_job_id, Number(legacyJob.lastInsertRowid));
      const remappedJob = db.prepare(`
        SELECT registration_jobs.*, source_accounts.provider, addresses.address AS mapped_address
        FROM registration_jobs
        JOIN source_accounts ON source_accounts.id = registration_jobs.account_id
        JOIN addresses ON addresses.id = registration_jobs.address_id
        WHERE registration_jobs.id = ?
      `).get(Number(legacyJob.lastInsertRowid));
      assert.equal(remappedJob.provider, "inbox_link");
      assert.equal(remappedJob.mapped_address, restoredLinkEmail);
      assert.notEqual(remappedJob.address_id, Number(legacyAddress.lastInsertRowid));
      assert.equal(remappedJob.address_id, remappedJob.base_address_id);
      const fetchCountBeforeMailboxRead = inboxLinkFetchUrls.length;
      const restoredMailbox = await jsonRequest(
        runtime.app,
        `/api/registration/accounts/${restoredWithLink.body.items[0].id}/emails`,
      );
      assert.equal(restoredMailbox.response.status, 200);
      assert.equal(restoredMailbox.body.email, restoredLinkEmail);
      assert.equal(inboxLinkFetchUrls.slice(fetchCountBeforeMailboxRead)
        .some((url) => url.includes("RestoredLinkKey")), true);

      const failedEmail = "remote-failure@example.com";
      client.accountCreateError = Object.assign(new Error("remote create failed"), { status: 502 });
      const failed = await jsonRequest(runtime.app, "/api/registration/accounts/import-local", {
        method: "POST",
        body: JSON.stringify({
          content: `${failedEmail}----https://dispose.lol/ib/RemoteFailureKey`,
        }),
      });
      client.accountCreateError = null;
      assert.equal(failed.response.status, 502);
      assert.equal(failed.body.error, "服务器处理请求失败");
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM registration_jobs WHERE email = ? COLLATE NOCASE")
        .get(failedEmail).count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM inbox_link_mailboxes WHERE email = ? COLLATE NOCASE")
        .get(failedEmail).count, 0);

      const concurrentEmail = "concurrent-external@example.com";
      const concurrentLink = "https://dispose.lol/ib/ConcurrentExternalKey";
      const originalCreateAccount = client.createAccount.bind(client);
      let signalCreateStarted;
      let releaseCreate;
      const createStarted = new Promise((resolve) => { signalCreateStarted = resolve; });
      const createGate = new Promise((resolve) => { releaseCreate = resolve; });
      client.createAccount = async (payload) => {
        if (payload.email === concurrentEmail) {
          signalCreateStarted();
          await createGate;
        }
        return originalCreateAccount(payload);
      };
      const firstImportPromise = jsonRequest(runtime.app, "/api/registration/accounts/import-local", {
        method: "POST",
        body: JSON.stringify({ content: `${concurrentEmail}----${concurrentLink}` }),
      });
      await createStarted;
      const busyImport = await jsonRequest(runtime.app, "/api/registration/accounts/import-local", {
        method: "POST",
        body: JSON.stringify({ content: `${concurrentEmail}----${concurrentLink}` }),
      });
      releaseCreate();
      const firstImport = await firstImportPromise;
      client.createAccount = originalCreateAccount;
      assert.equal(firstImport.response.status, 201);
      assert.equal(busyImport.response.status, 409);
      assert.match(busyImport.body.error, /正在导入/);
      assert.equal(client.importedAccounts.filter((item) => item.email === concurrentEmail).length, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM registration_jobs WHERE email = ? COLLATE NOCASE")
        .get(concurrentEmail).count, 1);
    });
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    runtime.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
