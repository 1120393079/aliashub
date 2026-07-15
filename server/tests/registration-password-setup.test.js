import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase, createSourceAccount, nowIso, setSetting } from "../db.js";
import { RegistrationService } from "../registration-service.js";

const TARGET_EMAIL = "source+gpt-existing@outlook.com";
const MAILBOX_BASE_URL = "https://mailbox.alias.test";
const CONNECTOR_KEY = "password-setup-connector-secret";

class FakePasswordSetupClient {
  constructor() {
    this.account = {
      id: 71,
      platform: "chatgpt",
      email: TARGET_EMAIL,
      password: "",
      overview: { password_status: "not_configured", password_source: "none" },
    };
    this.actions = [];
    this.providerSettingUpserts = [];
    this.callOrder = [];
    this.registerCalls = 0;
    this.createError = null;
    this.providerSettingError = null;
    this.task = {
      task_id: "password-task-1",
      type: "platform_action",
      platform: "chatgpt",
      status: "pending",
      progress_current: 0,
      progress_total: 1,
    };
    this.events = [];
  }

  async createTask() {
    this.registerCalls += 1;
    throw new Error("补设密码不得创建注册任务");
  }

  async getAccount(accountId) {
    return Number(accountId) === Number(this.account.id) ? structuredClone(this.account) : null;
  }

  async listAccounts({ email = "" } = {}) {
    const account = structuredClone(this.account);
    return {
      total: !email || email === account.email ? 1 : 0,
      items: !email || email === account.email ? [account] : [],
    };
  }

  async createAccountAction(accountId, actionId, params) {
    this.callOrder.push("action");
    if (this.createError) throw this.createError;
    this.actions.push({ accountId, actionId, params: structuredClone(params) });
    return structuredClone(this.task);
  }

  async upsertOutlookEmailProviderSetting(input) {
    this.callOrder.push("provider-setting");
    this.providerSettingUpserts.push(structuredClone(input));
    if (this.providerSettingError) throw this.providerSettingError;
    return { ok: true };
  }

  async getActionTask() {
    return structuredClone(this.task);
  }

  async getActionTaskEvents() {
    return { items: structuredClone(this.events) };
  }

  async cancelActionTask() {
    this.task.status = "cancel_requested";
    return structuredClone(this.task);
  }
}

function fixture(t, { proxyLabel = "直连", proxyPool = [] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-password-setup-test-"));
  const filename = path.join(directory, "test.db");
  const db = createDatabase({ filename, seedDemo: false });
  setSetting(db, "registration_connector_key", CONNECTOR_KEY);
  const source = createSourceAccount(db, { email: "source@outlook.com" });
  const now = nowIso();
  db.prepare("UPDATE source_accounts SET status = 'connected', updated_at = ? WHERE id = ?")
    .run(now, source.id);
  const primary = db.prepare("SELECT * FROM addresses WHERE account_id = ? AND kind = 'primary'").get(source.id);
  const addressResult = db.prepare(`
    INSERT INTO addresses (
      account_id, parent_address_id, address, kind, status, strategy, label, purpose,
      remote_confirmed, created_at, updated_at
    ) VALUES (?, ?, ?, 'split', 'active', 'test', 'GPT 注册', 'ChatGPT 注册', 1, ?, ?)
  `).run(source.id, primary.id, TARGET_EMAIL, now, now);
  const addressId = Number(addressResult.lastInsertRowid);
  const jobResult = db.prepare(`
    INSERT INTO registration_jobs (
      account_id, address_id, email, external_task_id, external_account_id, status,
      stage, browser_mode, proxy_label, message, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, 'registration-task', '71', 'completed', 'register', 'headed', ?,
      '注册成功', ?, ?, ?)
  `).run(source.id, addressId, TARGET_EMAIL, proxyLabel, now, now, now);
  setSetting(db, "registration_proxy_pool", JSON.stringify(proxyPool));
  const client = new FakePasswordSetupClient();
  const service = new RegistrationService({
    db,
    client,
    publicBaseUrl: "https://alias.test",
    mailboxBaseUrl: `${MAILBOX_BASE_URL}/`,
  });
  t.after(() => {
    if (db.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { db, filename, source, addressId, jobId: Number(jobResult.lastInsertRowid), client, service };
}

test("uses the original completed account and proxy without creating a registration or alias", async (t) => {
  const candidate = "ExactCandidate#42";
  const proxy = "http://proxy-user:proxy-password@proxy.example:8080";
  const context = fixture(t, { proxyLabel: "http://***@proxy.example:8080", proxyPool: [proxy] });
  const addressCount = context.db.prepare("SELECT COUNT(*) AS count FROM addresses").get().count;

  const started = await context.service.startPasswordSetup(71, { password: candidate });

  assert.deepEqual(context.client.callOrder, ["provider-setting", "action"]);
  assert.deepEqual(context.client.providerSettingUpserts, [{
    apiUrl: MAILBOX_BASE_URL,
    apiKey: CONNECTOR_KEY,
  }]);
  assert.deepEqual(context.client.actions, [{
    accountId: 71,
    actionId: "set_password",
    params: { password: candidate, proxy },
  }]);
  assert.equal(context.client.registerCalls, 0);
  assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM addresses").get().count, addressCount);
  assert.deepEqual(started, {
    account_id: 71,
    task_id: "password-task-1",
    status: "queued",
    terminal: false,
    cancellable: true,
    progress_current: 0,
    progress_total: 1,
  });
  assert.doesNotMatch(JSON.stringify(started), /ExactCandidate|proxy-user|proxy-password|proxy\.example/i);
  assert.ok(!JSON.stringify(started).includes(CONNECTOR_KEY));
  assert.ok(!JSON.stringify(started).includes(MAILBOX_BASE_URL));
  await assert.rejects(
    () => context.service.startPasswordSetup(71, { password: "SecondCandidate#42" }),
    /已有设置密码任务正在进行/,
  );
  assert.equal(context.client.actions.length, 1);

  context.client.task.status = "running";
  context.client.events = [
    { id: 1, type: "log", level: "info", message: `开始设置密码 ${candidate}` },
    { id: 2, type: "log", level: "info", message: `使用代理 ${proxy}` },
    { id: 3, type: "log", level: "info", message: "等待设置密码邮箱验证码" },
  ];
  const running = await context.service.passwordSetupStatus(71, started.task_id);
  assert.equal(running.status, "running");
  assert.deepEqual(running.events.map((item) => item.message), [
    "设置密码任务已启动",
    "设置密码任务处理中",
    "等待设置密码邮箱验证码",
  ]);
  assert.doesNotMatch(JSON.stringify(running), /ExactCandidate|proxy-user|proxy-password|proxy\.example/i);

  const cancelled = await context.service.cancelPasswordSetup(71, started.task_id);
  assert.equal(cancelled.status, "cancel_requested");
  assert.doesNotMatch(JSON.stringify(cancelled), /ExactCandidate|proxy-user|proxy-password|proxy\.example/i);

  context.client.task.status = "succeeded";
  context.client.task.progress_current = 1;
  context.client.account.password = candidate;
  context.client.account.overview = { password_status: "configured", password_source: "settings" };
  const completed = await context.service.passwordSetupStatus(71, started.task_id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.password_status, "configured");
  assert.equal(completed.password_available, true);
  assert.doesNotMatch(JSON.stringify(completed), /ExactCandidate|proxy-user|proxy-password|proxy\.example/i);
});

test("persists only non-sensitive task mapping and recovers status and cancellation after restart", async (t) => {
  const candidate = "RestartCandidate#42";
  const proxy = "http://restart-user:restart-password@restart-proxy.example:8080";
  const context = fixture(t, {
    proxyLabel: "http://***@restart-proxy.example:8080",
    proxyPool: [proxy],
  });

  const started = await context.service.startPasswordSetup(71, { password: candidate });
  const columns = context.db.pragma("table_info(registration_password_setup_tasks)")
    .map((column) => column.name);
  assert.deepEqual(columns, ["task_id", "external_account_id", "status", "created_at", "updated_at"]);
  const persisted = context.db.prepare("SELECT * FROM registration_password_setup_tasks WHERE task_id = ?")
    .get(started.task_id);
  assert.equal(persisted.external_account_id, 71);
  assert.equal(persisted.status, "queued");
  assert.doesNotMatch(JSON.stringify(persisted), /RestartCandidate|restart-user|restart-password|restart-proxy/i);
  assert.ok(!JSON.stringify(persisted).includes(CONNECTOR_KEY));
  assert.ok(!JSON.stringify(persisted).includes(MAILBOX_BASE_URL));

  context.db.close();
  const reopenedDb = createDatabase({ filename: context.filename, seedDemo: false });
  try {
    const restarted = new RegistrationService({
      db: reopenedDb,
      client: context.client,
      publicBaseUrl: "https://alias.test",
    });
    context.client.task.status = "running";
    const running = await restarted.passwordSetupStatus(71, started.task_id);
    assert.equal(running.status, "running");
    assert.equal(reopenedDb.prepare(`
      SELECT status FROM registration_password_setup_tasks WHERE task_id = ?
    `).get(started.task_id).status, "running");
    await assert.rejects(
      () => restarted.startPasswordSetup(71, { password: "AnotherCandidate#42" }),
      /已有设置密码任务正在进行/,
    );

    const cancelled = await restarted.cancelPasswordSetup(71, started.task_id);
    assert.equal(cancelled.status, "cancel_requested");
    assert.equal(reopenedDb.prepare(`
      SELECT status FROM registration_password_setup_tasks WHERE task_id = ?
    `).get(started.task_id).status, "cancel_requested");
    assert.doesNotMatch(JSON.stringify(cancelled), /RestartCandidate|restart-user|restart-password|restart-proxy/i);
  } finally {
    reopenedDb.close();
  }
});

test("publishes a fail-closed password setup capability for each registered account", async (t) => {
  const context = fixture(t);

  const available = await context.service.listRegisteredAccounts();
  assert.equal(available.items.length, 1);
  assert.equal(available.items[0].password_setup_available, true);
  assert.equal(available.items[0].password_setup_reason, "");

  await context.service.startPasswordSetup(71);
  const running = await context.service.listRegisteredAccounts();
  assert.equal(running.items[0].password_setup_available, false);
  assert.equal(running.items[0].password_setup_reason, "设置密码任务正在进行");

  context.client.task.status = "failed";
  await context.service.passwordSetupStatus(71, "password-task-1");
  const retryable = await context.service.listRegisteredAccounts();
  assert.equal(retryable.items[0].password_setup_available, true);
  assert.equal(retryable.items[0].password_setup_reason, "");

  context.db.prepare("UPDATE registration_jobs SET address_id = NULL WHERE id = ?").run(context.jobId);
  const missingAddress = await context.service.listRegisteredAccounts();
  assert.equal(missingAddress.items[0].password_setup_available, false);
  assert.equal(missingAddress.items[0].password_setup_reason, "缺少原邮箱地址映射");
  context.db.prepare("UPDATE registration_jobs SET address_id = ? WHERE id = ?")
    .run(context.addressId, context.jobId);

  context.db.prepare("UPDATE source_accounts SET status = 'disconnected' WHERE id = ?").run(context.source.id);
  const disconnected = await context.service.listRegisteredAccounts();
  assert.equal(disconnected.items[0].password_setup_available, false);
  assert.equal(disconnected.items[0].password_setup_reason, "原源头邮箱未连接");
  context.db.prepare("UPDATE source_accounts SET status = 'connected' WHERE id = ?").run(context.source.id);

  context.db.prepare("UPDATE registration_jobs SET proxy_label = 'http://***@missing.example:8080' WHERE id = ?")
    .run(context.jobId);
  const missingProxy = await context.service.listRegisteredAccounts();
  assert.equal(missingProxy.items[0].password_setup_available, false);
  assert.equal(missingProxy.items[0].password_setup_reason, "原代理无法唯一恢复");
  context.db.prepare("UPDATE registration_jobs SET proxy_label = '直连' WHERE id = ?").run(context.jobId);

  context.client.account.password = "ConfiguredPassword#42";
  context.client.account.overview = { password_status: "configured", password_source: "settings" };
  const configured = await context.service.listRegisteredAccounts();
  assert.equal(configured.items[0].password_setup_available, false);
  assert.equal(configured.items[0].password_setup_reason, "密码已配置");
});

test("fails closed when the completed job, mailbox, account, or original proxy mapping is invalid", async (t) => {
  await t.test("requires a completed job", async (subtest) => {
    const context = fixture(subtest);
    context.db.prepare("UPDATE registration_jobs SET status = 'failed' WHERE id = ?").run(context.jobId);
    await assert.rejects(() => context.service.startPasswordSetup(71), /已完成注册映射/);
    assert.equal(context.client.actions.length, 0);
  });

  await t.test("requires an existing address mapping", async (subtest) => {
    const context = fixture(subtest);
    context.db.prepare("UPDATE registration_jobs SET address_id = NULL WHERE id = ?").run(context.jobId);
    await assert.rejects(() => context.service.startPasswordSetup(71), /原邮箱地址映射/);
    assert.equal(context.client.actions.length, 0);
  });

  await t.test("requires the remote account email to equal the mapped address", async (subtest) => {
    const context = fixture(subtest);
    context.client.account.email = "different@example.com";
    await assert.rejects(() => context.service.startPasswordSetup(71), /远端账号与原邮箱地址映射不一致/);
    assert.equal(context.client.actions.length, 0);
  });

  await t.test("requires the original source mailbox to remain connected", async (subtest) => {
    const context = fixture(subtest);
    context.db.prepare("UPDATE source_accounts SET status = 'disconnected' WHERE id = ?").run(context.source.id);
    await assert.rejects(() => context.service.startPasswordSetup(71), /源头邮箱当前未连接/);
    assert.equal(context.client.actions.length, 0);
  });

  await t.test("never silently falls back to direct when the original proxy is missing", async (subtest) => {
    const context = fixture(subtest, { proxyLabel: "http://***@proxy.example:8080" });
    await assert.rejects(() => context.service.startPasswordSetup(71), /无法唯一还原注册时使用的代理/);
    assert.equal(context.client.actions.length, 0);
  });

  await t.test("rejects ambiguous original proxy matches", async (subtest) => {
    const context = fixture(subtest, {
      proxyLabel: "http://***@proxy.example:8080",
      proxyPool: [
        "http://first:secret@proxy.example:8080",
        "http://second:secret@proxy.example:8080",
      ],
    });
    await assert.rejects(() => context.service.startPasswordSetup(71), /无法唯一还原注册时使用的代理/);
    assert.equal(context.client.actions.length, 0);
  });

  await t.test("rejects an account that is already configured", async (subtest) => {
    const context = fixture(subtest);
    context.client.account.password = "ExistingPassword#42";
    context.client.account.overview = { password_status: "configured", password_source: "settings" };
    await assert.rejects(() => context.service.startPasswordSetup(71), /已经配置密码/);
    assert.equal(context.client.actions.length, 0);
  });
});

test("rejects task success until the remote account confirms a usable configured password", async (t) => {
  const context = fixture(t);
  const started = await context.service.startPasswordSetup(71, { password: "CandidateNeverSaved#42" });
  context.client.task.status = "succeeded";
  context.client.task.progress_current = 1;
  context.client.events = [{ id: 1, message: "password_status=configured CandidateNeverSaved#42" }];

  let failure;
  try {
    await context.service.passwordSetupStatus(71, started.task_id);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.status, 502);
  assert.match(failure.message, /伪成功/);
  assert.doesNotMatch(failure.message, /CandidateNeverSaved/);
});

test("validates an optional password and redacts an upstream creation error", async (t) => {
  const context = fixture(t);
  const invalid = [
    [42, /必须是字符串/],
    ["ShortPass#1", /12 到 128/],
    [" CandidatePassword#42", /首尾空白/],
    ["Candidate\tPassword#42", /控制字符/],
  ];
  for (const [password, pattern] of invalid) {
    await assert.rejects(() => context.service.startPasswordSetup(71, { password }), pattern);
  }
  assert.equal(context.client.actions.length, 0);

  const candidate = "RemoteEchoCandidate#42";
  context.client.createError = new Error(`upstream echoed ${candidate}`);
  let failure;
  try {
    await context.service.startPasswordSetup(71, { password: candidate });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.status, 502);
  assert.equal(failure.message, "设置密码任务创建失败");
  assert.doesNotMatch(failure.message, /RemoteEchoCandidate/);
});

test("fails closed without creating an action when mailbox connector sync fails", async (t) => {
  const context = fixture(t);
  const addressCount = context.db.prepare("SELECT COUNT(*) AS count FROM addresses").get().count;
  context.client.providerSettingError = new Error(
    `sync rejected ${CONNECTOR_KEY} at ${MAILBOX_BASE_URL}`,
  );

  let failure;
  try {
    await context.service.startPasswordSetup(71, { password: "SyncFailureCandidate#42" });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  assert.equal(failure.status, 502);
  assert.equal(failure.message, "邮箱连接配置同步失败");
  assert.deepEqual(context.client.callOrder, ["provider-setting"]);
  assert.equal(context.client.actions.length, 0);
  assert.equal(context.client.registerCalls, 0);
  assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM addresses").get().count, addressCount);
  assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM registration_password_setup_tasks").get().count, 0);
  assert.ok(!failure.message.includes(CONNECTOR_KEY));
  assert.ok(!failure.message.includes(MAILBOX_BASE_URL));
});
