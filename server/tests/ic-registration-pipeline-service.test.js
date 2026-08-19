import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase, nowIso } from "../db.js";
import { IcRegistrationPipelineService } from "../ic-registration-pipeline-service.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function insertIcloudFixture(db, count = 2) {
  const at = nowIso();
  const accountId = Number(db.prepare(`
    INSERT INTO source_accounts (
      provider, email, display_name, status, profile_key, official_limit, created_at, updated_at
    ) VALUES ('icloud', 'owner@icloud.com', 'Owner', 'connected', 'icloud-pipeline-test', 10, ?, ?)
  `).run(at, at).lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO addresses (
      account_id, address, kind, status, strategy, remote_confirmed, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', ?, 1, ?, ?)
  `);
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(Number(insert.run(
      accountId,
      index ? `alias-${index}@icloud.com` : "owner@icloud.com",
      index ? "official" : "primary",
      index ? "icloud_mail_alias" : "",
      at,
      at,
    ).lastInsertRowid));
  }
  return { accountId, addressIds: ids };
}

class FakeRegistration {
  constructor(db, timeline, outcomes = {}) {
    this.db = db;
    this.timeline = timeline;
    this.outcomes = outcomes;
    this.createCalls = [];
    this.client = { health: async () => ({ ok: true, configured: true }) };
  }

  async options() {
    const account = this.db.prepare("SELECT * FROM source_accounts WHERE provider = 'icloud' LIMIT 1").get();
    const bases = this.db.prepare(`
      SELECT id, address FROM addresses
      WHERE account_id = ? AND status = 'active'
      ORDER BY kind = 'primary' DESC, created_at, id
    `).all(account.id).map((item) => ({
      ...item,
      registration_disabled: false,
      registration_hint: "",
    }));
    return { accounts: [{ id: account.id, provider: "icloud", bases }] };
  }

  async registrationQueueControl() {
    return { paused: false };
  }

  async createJobs(input) {
    this.createCalls.push(input);
    this.timeline.push("registration:create");
    let addresses;
    const addressIds = Array.isArray(input.addressIds)
      ? input.addressIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
      : [];
    if (addressIds.length) {
      const rows = this.db.prepare(`
        SELECT * FROM addresses
        WHERE account_id = ? AND id IN (${addressIds.map(() => "?").join(",")})
      `).all(input.accountId, ...addressIds);
      const byId = new Map(rows.map((row) => [Number(row.id), row]));
      addresses = addressIds.map((id) => byId.get(id)).filter(Boolean);
    } else {
      addresses = this.db.prepare(`
        SELECT * FROM addresses
        WHERE account_id = ? AND id >= ?
        ORDER BY kind = 'primary' DESC, created_at, id
      `).all(input.accountId, input.baseAddressId).slice(0, input.count);
    }
    return addresses.map((address, index) => {
      const outcome = this.outcomes[address.address] || "completed";
      const at = nowIso();
      const id = Number(this.db.prepare(`
        INSERT INTO registration_jobs (
          account_id, address_id, base_address_id, email, external_account_id,
          status, stage, message, created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.accountId,
        address.id,
        address.id,
        address.address,
        outcome === "completed" ? String(1000 + index) : "",
        outcome,
        outcome,
        outcome === "failed" ? "fixture registration failed" : "done",
        at,
        at,
        at,
      ).lastInsertRowid);
      return this.getJob(id);
    });
  }

  getJob(id) {
    return this.db.prepare("SELECT * FROM registration_jobs WHERE id = ?").get(Number(id));
  }

  async syncJob(job) {
    this.timeline.push(`registration:sync:${job.email}`);
    return this.getJob(job.id);
  }

  async cancelJob() {}
}

class FakeIcloudPrivacy {
  constructor(db, timeline, {
    privacyAccountId = "privacy-account-1",
    create = null,
  } = {}) {
    this.db = db;
    this.timeline = timeline;
    this.privacyAccountId = privacyAccountId;
    this.createHandler = create;
    this.createCalls = [];
    this.listCalls = 0;
    this.mailboxes = [];
    this.sequence = 0;
  }

  configured() {
    return true;
  }

  async status() {
    this.timeline.push("mailbox:status");
    const source = this.db.prepare(`
      SELECT * FROM source_accounts WHERE provider = 'icloud' ORDER BY id LIMIT 1
    `).get();
    return {
      success: true,
      sessions: [{
        account_id: this.privacyAccountId,
        apple_id: source.email,
        apple_account_login_saved: true,
        apple_account_manage_ready: true,
      }],
    };
  }

  async listMailboxes() {
    this.listCalls += 1;
    this.timeline.push("mailbox:list");
    return { success: true, mailboxes: this.mailboxes.map((mailbox) => ({ ...mailbox })) };
  }

  addMailbox(input, { insertAddress = true } = {}) {
    this.sequence += 1;
    const row = {
      id: String(input.id || `privacy-mailbox-${this.sequence}`),
      email: String(input.email || `auto-${this.sequence}@icloud.com`).toLowerCase(),
      label: String(input.label || ""),
      account_id: String(input.account_id || this.privacyAccountId),
      alias_hub_source_account_id: Number(input.alias_hub_source_account_id),
      alias_hub_synced: input.alias_hub_synced !== false,
    };
    if (insertAddress) {
      const at = nowIso();
      this.db.prepare(`
        INSERT OR IGNORE INTO addresses (
          account_id, address, kind, status, strategy, remote_confirmed, created_at, updated_at
        ) VALUES (?, ?, 'official', 'active', 'icloud_hide_my_email', 1, ?, ?)
      `).run(row.alias_hub_source_account_id, row.email, at, at);
    }
    this.mailboxes.push(row);
    this.timeline.push(`mailbox:import:${row.email}`);
    return { ...row };
  }

  async createMailboxes(input) {
    this.createCalls.push({ ...input });
    this.timeline.push("mailbox:create");
    if (this.createHandler) return this.createHandler(input, this);
    const mailboxes = Array.from({ length: input.count }, () => this.addMailbox({
      label: input.label,
      account_id: input.accountId,
      alias_hub_source_account_id: input.sourceAccountId,
      alias_hub_synced: true,
    }));
    return { success: true, created: mailboxes.length, mailboxes, failures: [] };
  }
}

class FakePaymentLinks {
  constructor(timeline, outcomes = {}) {
    this.timeline = timeline;
    this.outcomes = outcomes;
    this.rows = new Map();
    this.startCalls = [];
  }

  configuration() {
    return {
      configured: true,
      checkout_proxy_count: 1,
      update_proxy_count: 1,
      apply_checkout_update: true,
    };
  }

  async start(input) {
    this.startCalls.push(input);
    const accountId = String(input.ids[0]);
    this.timeline.push(`link:start:${accountId}`);
    const failed = this.outcomes[accountId] === "failed";
    const row = {
      external_account_id: accountId,
      task_id: `link-${accountId}`,
      status: failed ? "failed" : "succeeded",
      provider_url: failed ? "" : `https://www.paypal.com/agreements/approve?ba_token=BA-${accountId}`,
      error: failed ? "fixture link failed" : "",
      accepted: true,
      started_at: nowIso(),
      updated_at: nowIso(),
    };
    this.rows.set(accountId, row);
    return { items: [row] };
  }

  row(accountId) {
    return this.rows.get(String(accountId)) || null;
  }

  async track(accountId) {
    this.timeline.push(`link:track:${accountId}`);
    return this.row(accountId);
  }

  async request() {}
}

class FakePaymentAgreements {
  constructor(timeline, outcomes = {}) {
    this.timeline = timeline;
    this.outcomes = outcomes;
    this.contexts = new Map();
    this.startCalls = [];
    this.cancelCalls = [];
    this.releaseCalls = [];
  }

  settings() {
    return { protocol_configured: true, configured: true, api_key_configured: true };
  }

  runtime() {
    return { configured: true, country: "DE", proxies: ["fixture-proxy"] };
  }

  async start(input) {
    this.startCalls.push(input);
    const accountId = String(input.paypal_url).match(/BA-(\d+)/)?.[1] || "unknown";
    this.timeline.push(`agreement:start:${accountId}`);
    const id = `agreement-${accountId}`;
    const configured = this.outcomes[accountId] || "completed";
    const outcome = typeof configured === "string" ? { status: configured } : configured;
    if (outcome.submitGate) await outcome.submitGate.promise;
    const status = outcome.status || "completed";
    this.contexts.set(id, {
      jobId: id,
      lastSnapshot: {
        id,
        status,
        error: outcome.error || (status === "failed" ? "fixture agreement failed" : ""),
      },
      lastError: "",
      stopped: false,
      terminal: new Set(["completed", "failed", "cancelled"]).has(status),
    });
    return { job: { id, status } };
  }

  context(id) {
    return this.contexts.get(String(id)) || null;
  }

  async cancelJob(id) {
    const key = String(id || "");
    this.cancelCalls.push(key);
    const context = this.context(key);
    if (context) {
      context.stopped = true;
      context.terminal = true;
      context.lastSnapshot = { id: key, status: "cancelled", error: "fixture agreement cancelled" };
    }
  }

  async releaseContext(id, options = {}) {
    const key = String(id || "");
    this.releaseCalls.push({ jobId: key, ...options });
    if (!this.context(key)) return false;
    this.contexts.delete(key);
    return true;
  }
}

function createHarness(t, {
  count = 2,
  registrationOutcomes,
  linkOutcomes,
  agreementOutcomes,
  privacyOptions,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-ic-pipeline-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const fixture = insertIcloudFixture(db, count);
  const timeline = [];
  const registration = new FakeRegistration(db, timeline, registrationOutcomes);
  const paymentLinks = new FakePaymentLinks(timeline, linkOutcomes);
  const paymentAgreements = new FakePaymentAgreements(timeline, agreementOutcomes);
  const icloudPrivacy = new FakeIcloudPrivacy(db, timeline, privacyOptions);
  const service = new IcRegistrationPipelineService({
    db,
    registration,
    paymentLinks,
    paymentAgreements,
    icloudPrivacy,
    pollIntervalMs: 20,
    sleepFn: async () => undefined,
  });
  const mapCreatedMailboxes = service.mapCreatedMailboxes.bind(service);
  service.mapCreatedMailboxes = (taskId, rows) => {
    const before = service.items(taskId).filter((item) => item.address_id).length;
    const result = mapCreatedMailboxes(taskId, rows);
    if (result.mapped > before) timeline.push("mailbox:mapped");
    return result;
  };
  t.after(async () => {
    await service.close();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    service,
    registration,
    paymentLinks,
    paymentAgreements,
    icloudPrivacy,
    timeline,
    ...fixture,
  };
}

async function waitForTerminal(service, id) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const task = service.get(id);
    if (task.terminal) return task;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("pipeline did not become terminal");
}

async function waitFor(read, predicate, message = "condition") {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${message}`);
}

function startInput(context, overrides = {}) {
  return {
    accountId: context.accountId,
    baseAddressId: context.addressIds[0],
    count: context.addressIds.length,
    concurrency: Math.min(context.addressIds.length, 2),
    browserMode: "headless",
    proxySelection: "auto",
    paymentLinkCountry: "DE",
    requestId: "fixture-request-001",
    ...overrides,
  };
}

function autoCreateInput(context, overrides = {}) {
  return {
    accountId: context.accountId,
    mailboxMode: "auto_create",
    count: 1,
    concurrency: 1,
    browserMode: "headless",
    proxySelection: "auto",
    paymentLinkCountry: "DE",
    requestId: "fixture-auto-create-001",
    ...overrides,
  };
}

test("runs registration, payment-link extraction, and agreement strictly in order", async (t) => {
  const context = createHarness(t, { count: 2 });
  const started = await context.service.start(startInput(context));
  const final = await waitForTerminal(context.service, started.id);

  assert.equal(final.status, "completed");
  assert.equal(final.success_count, 2);
  assert.deepEqual(Object.keys(final.phase_progress), ["mailbox", "registration", "link", "agreement"]);
  for (const phase of Object.values(final.phase_progress)) {
    assert.equal(phase.succeeded, 2);
    assert.equal(phase.failed, 0);
    assert.equal(phase.retrying, 0);
  }
  assert.equal(final.phase_progress.recycle, undefined);
  assert.equal(context.registration.createCalls.length, 1);
  assert.equal(context.registration.createCalls[0].concurrency, 2);
  assert.equal(context.paymentLinks.startCalls.length, 2);
  assert.equal(context.paymentAgreements.startCalls.length, 2);
  for (const item of final.items) {
    const accountId = String(item.external_account_id);
    const registrationIndex = context.timeline.indexOf(`registration:sync:${item.email}`);
    const linkIndex = context.timeline.indexOf(`link:start:${accountId}`);
    const agreementIndex = context.timeline.indexOf(`agreement:start:${accountId}`);
    assert.ok(registrationIndex >= 0 && registrationIndex < linkIndex);
    assert.ok(linkIndex < agreementIndex);
  }
  assert.equal(context.paymentAgreements.contexts.size, 0);
  assert.equal(context.paymentAgreements.releaseCalls.length, 2);
  assert.ok(context.paymentAgreements.releaseCalls.every((call) => (
    call.force === true && call.successful === true
  )));
});

test("registration failure never starts link extraction and does not block another item", async (t) => {
  const context = createHarness(t, {
    count: 2,
    registrationOutcomes: { "owner@icloud.com": "failed" },
  });
  const started = await context.service.start(startInput(context));
  const final = await waitForTerminal(context.service, started.id);

  assert.equal(final.status, "partial_failed");
  assert.equal(final.success_count, 1);
  assert.equal(final.failure_count, 1);
  const failed = final.items.find((item) => item.email === "owner@icloud.com");
  const succeeded = final.items.find((item) => item.email !== "owner@icloud.com");
  assert.equal(failed.stage, "failed");
  assert.equal(failed.failure_stage, "registration_wait");
  assert.match(failed.error, /fixture registration failed/);
  assert.equal(final.phase_progress.mailbox.succeeded, 2);
  assert.equal(final.phase_progress.registration.succeeded, 1);
  assert.equal(final.phase_progress.registration.failed, 1);
  assert.equal(final.phase_progress.link.succeeded, 1);
  assert.equal(final.phase_progress.agreement.succeeded, 1);
  assert.equal(context.paymentLinks.startCalls.some((call) => String(call.ids[0]) === String(failed.external_account_id)), false);
  assert.ok(succeeded.external_account_id);
  assert.equal(context.paymentAgreements.startCalls.length, 1);
});

test("payment-link failure never starts agreement", async (t) => {
  const context = createHarness(t, { count: 1, linkOutcomes: { 1000: "failed" } });
  const started = await context.service.start(startInput(context));
  const final = await waitForTerminal(context.service, started.id);

  assert.equal(final.status, "failed");
  assert.match(final.items[0].error, /fixture link failed/);
  assert.equal(final.items[0].failure_stage, "link_wait");
  assert.equal(final.phase_progress.registration.succeeded, 1);
  assert.equal(final.phase_progress.link.succeeded, 0);
  assert.equal(final.phase_progress.link.failed, 1);
  assert.equal(final.phase_progress.agreement.failed, 0);
  assert.equal(context.paymentLinks.startCalls.length, 1);
  assert.equal(context.paymentAgreements.startCalls.length, 0);
});

for (const agreementStatus of ["failed", "cancelled"]) {
  test(`terminal ${agreementStatus} agreement releases its context`, async (t) => {
    const context = createHarness(t, {
      count: 1,
      agreementOutcomes: {
        1000: {
          status: agreementStatus,
          error: `fixture agreement ${agreementStatus}`,
        },
      },
    });
    const started = await context.service.start(startInput(context, {
      requestId: `fixture-agreement-${agreementStatus}-001`,
    }));
    const final = await waitForTerminal(context.service, started.id);
    const item = final.items[0];

    assert.equal(final.status, agreementStatus === "failed" ? "failed" : "cancelled");
    assert.equal(item.status, agreementStatus === "failed" ? "failed" : "cancelled");
    assert.match(item.error, new RegExp(`agreement ${agreementStatus}`));
    assert.equal(final.phase_progress.link.succeeded, 1);
    assert.equal(final.phase_progress.agreement.failed, agreementStatus === "failed" ? 1 : 0);
    if (agreementStatus === "failed") assert.equal(item.failure_stage, "agreement_wait");
    assert.equal(context.paymentAgreements.contexts.size, 0);
    assert.deepEqual(context.paymentAgreements.releaseCalls, [{
      jobId: item.agreement_job_id,
      force: true,
      successful: false,
    }]);
  });
}

test("late agreement start after pipeline cancellation is cancelled and released", async (t) => {
  const submitGate = deferred();
  const context = createHarness(t, {
    count: 1,
    agreementOutcomes: {
      1000: { status: "running", submitGate },
    },
  });
  const started = await context.service.start(startInput(context, {
    requestId: "fixture-agreement-late-cancel-001",
  }));
  const submitting = await waitFor(
    () => context.service.get(started.id).items[0],
    (item) => item.stage === "agreement_submitting"
      && context.paymentAgreements.startCalls.length === 1,
    "late agreement submission",
  );
  const active = context.service.get(started.id);
  assert.equal(active.phase_progress.link.succeeded, 1);
  assert.equal(active.phase_progress.agreement.running, 1);
  const cancelled = await context.service.cancel(started.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(context.paymentAgreements.contexts.size, 0);
  assert.equal(context.paymentAgreements.cancelCalls.length, 0);

  submitGate.resolve();
  await waitFor(
    () => context.paymentAgreements.releaseCalls.length,
    (count) => count === 1,
    "late agreement release",
  );
  const stored = context.service.get(started.id).items.find((item) => item.id === submitting.id);
  assert.ok(stored.agreement_job_id);
  assert.deepEqual(context.paymentAgreements.cancelCalls, [stored.agreement_job_id]);
  assert.deepEqual(context.paymentAgreements.releaseCalls, [{
    jobId: stored.agreement_job_id,
    force: true,
    successful: false,
  }]);
  assert.equal(context.paymentAgreements.contexts.size, 0);
});

test("request id is idempotent, rejects conflicting reuse, and enforces concurrency limit", async (t) => {
  const context = createHarness(t, { count: 1 });
  const input = startInput(context);
  const first = await context.service.start(input);
  const second = await context.service.start(input);

  assert.equal(second.id, first.id);
  await waitForTerminal(context.service, first.id);
  assert.equal(context.registration.createCalls.length, 1);
  await assert.rejects(
    context.service.start({ ...input, paymentLinkCountry: "US" }),
    (error) => error.status === 409 && error.code === "IC_PIPELINE_IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    context.service.start({ ...input, requestId: "fixture-request-002", concurrency: 6 }),
    /并发数必须是 1 到 5/,
  );
});

test("auto-create maps newly imported mailboxes before registration, link, and agreement", async (t) => {
  const context = createHarness(t, { count: 1 });
  const started = await context.service.start(autoCreateInput(context, {
    count: 2,
    concurrency: 2,
    requestId: "fixture-auto-order-001",
  }));
  const final = await waitForTerminal(context.service, started.id);

  assert.equal(final.status, "completed");
  assert.equal(final.mailbox_mode, "auto_create");
  assert.equal(final.success_count, 2);
  assert.equal(context.icloudPrivacy.createCalls.length, 1);
  assert.deepEqual(context.icloudPrivacy.createCalls[0], {
    accountId: "privacy-account-1",
    sourceAccountId: context.accountId,
    count: 2,
    label: `ic-pipeline:${started.id}`,
    note: "AliasHub ChatGPT 一键注册流水线",
  });
  assert.equal(context.registration.createCalls.length, 1);
  const registrationCall = context.registration.createCalls[0];
  assert.equal(registrationCall.count, 2);
  assert.equal(registrationCall.concurrency, 2);
  assert.deepEqual(
    registrationCall.addressIds,
    final.items.map((item) => item.address_id),
  );
  assert.ok(final.items.every((item) => item.address_id && item.email && item.mailbox_id));
  assert.ok(final.items.every((item) => !context.addressIds.includes(item.address_id)));

  const createIndex = context.timeline.indexOf("mailbox:create");
  const mappedIndex = context.timeline.indexOf("mailbox:mapped");
  const registrationCreateIndex = context.timeline.indexOf("registration:create");
  assert.ok(createIndex >= 0 && createIndex < mappedIndex);
  assert.ok(mappedIndex < registrationCreateIndex);
  for (const item of final.items) {
    const accountId = String(item.external_account_id);
    const registrationIndex = context.timeline.indexOf(`registration:sync:${item.email}`);
    const linkIndex = context.timeline.indexOf(`link:start:${accountId}`);
    const agreementIndex = context.timeline.indexOf(`agreement:start:${accountId}`);
    assert.ok(registrationCreateIndex < registrationIndex);
    assert.ok(registrationIndex < linkIndex);
    assert.ok(linkIndex < agreementIndex);
  }
});

test("auto-create partial mailbox failure continues successful items only", async (t) => {
  const context = createHarness(t, {
    count: 1,
    privacyOptions: {
      create: (input, privacy) => {
        const mailbox = privacy.addMailbox({
          id: "privacy-partial-success",
          email: "partial-success@icloud.com",
          label: input.label,
          account_id: input.accountId,
          alias_hub_source_account_id: input.sourceAccountId,
          alias_hub_synced: true,
        });
        return {
          success: true,
          created: 1,
          mailboxes: [mailbox],
          failures: [{ error: "fixture mailbox creation failed" }],
        };
      },
    },
  });
  const started = await context.service.start(autoCreateInput(context, {
    count: 2,
    concurrency: 2,
    requestId: "fixture-auto-partial-001",
  }));
  const final = await waitForTerminal(context.service, started.id);

  assert.equal(final.status, "partial_failed");
  assert.equal(final.success_count, 1);
  assert.equal(final.failure_count, 1);
  const succeeded = final.items.find((item) => item.status === "completed");
  const failed = final.items.find((item) => item.status === "failed");
  assert.equal(succeeded.email, "partial-success@icloud.com");
  assert.ok(succeeded.address_id);
  assert.equal(failed.address_id, null);
  assert.equal(failed.failure_stage, "mailbox_submitting");
  assert.match(failed.error, /fixture mailbox creation failed/);
  assert.equal(final.phase_progress.mailbox.succeeded, 1);
  assert.equal(final.phase_progress.mailbox.failed, 1);
  assert.equal(final.phase_progress.registration.succeeded, 1);
  assert.equal(final.phase_progress.link.succeeded, 1);
  assert.equal(final.phase_progress.agreement.succeeded, 1);
  assert.equal(context.registration.createCalls.length, 1);
  assert.deepEqual(context.registration.createCalls[0].addressIds, [succeeded.address_id]);
  assert.equal(context.paymentLinks.startCalls.length, 1);
  assert.equal(context.paymentAgreements.startCalls.length, 1);
});

test("auto-create never registers a mailbox that AliasHub did not sync", async (t) => {
  const context = createHarness(t, {
    count: 1,
    privacyOptions: {
      create: (input, privacy) => {
        const mailbox = privacy.addMailbox({
          id: "privacy-unsynced",
          email: "unsynced@icloud.com",
          label: input.label,
          account_id: input.accountId,
          alias_hub_source_account_id: input.sourceAccountId,
          alias_hub_synced: false,
        }, { insertAddress: true });
        return { success: true, created: 1, mailboxes: [mailbox], failures: [] };
      },
    },
  });
  const started = await context.service.start(autoCreateInput(context, {
    requestId: "fixture-auto-unsynced-001",
  }));
  const final = await waitForTerminal(context.service, started.id);

  assert.equal(final.status, "failed");
  assert.equal(final.failure_count, 1);
  assert.equal(final.items[0].address_id, null);
  assert.equal(context.db.prepare(`
    SELECT COUNT(*) AS count FROM addresses
    WHERE account_id = ? AND address = 'unsynced@icloud.com' COLLATE NOCASE
  `).get(context.accountId).count, 1);
  assert.equal(context.registration.createCalls.length, 0);
  assert.equal(context.paymentLinks.startCalls.length, 0);
  assert.equal(context.paymentAgreements.startCalls.length, 0);
});

test("auto-create request id is idempotent and never creates mailboxes twice", async (t) => {
  const context = createHarness(t, { count: 1 });
  const input = autoCreateInput(context, { requestId: "fixture-auto-idempotent-001" });
  const first = await context.service.start(input);
  const second = await context.service.start(input);

  assert.equal(second.id, first.id);
  await waitForTerminal(context.service, first.id);
  const third = await context.service.start(input);
  assert.equal(third.id, first.id);
  assert.equal(context.icloudPrivacy.createCalls.length, 1);
  assert.equal(context.registration.createCalls.length, 1);
});

test("recovery reconciles an exact mailbox-submitting label without creating again", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-ic-pipeline-recovery-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const fixture = insertIcloudFixture(db, 1);
  const timeline = [];
  const registration = new FakeRegistration(db, timeline);
  const paymentLinks = new FakePaymentLinks(timeline);
  const paymentAgreements = new FakePaymentAgreements(timeline);
  const icloudPrivacy = new FakeIcloudPrivacy(db, timeline);
  const taskId = "fixture-recover-mailbox-001";
  const label = `ic-pipeline:${taskId}`;
  const at = nowIso();
  db.prepare(`
    INSERT INTO ic_registration_pipelines (
      id, request_id, request_fingerprint, account_id, base_address_id,
      mailbox_mode, privacy_account_id, status, stage, requested_count,
      concurrency, browser_mode, proxy_selection, payment_link_country,
      progress_total, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, 'auto_create', ?, 'running', 'mailbox_submitting',
      1, 1, 'headless', 'auto', 'DE', 1, ?, ?)
  `).run(
    taskId,
    "fixture-recover-request-001",
    "fixture-recovery-fingerprint",
    fixture.accountId,
    icloudPrivacy.privacyAccountId,
    at,
    at,
  );
  db.prepare(`
    INSERT INTO ic_registration_pipeline_items (
      pipeline_id, address_id, email, mailbox_id, status, stage, created_at, updated_at
    ) VALUES (?, NULL, '', '', 'running', 'mailbox_submitting', ?, ?)
  `).run(taskId, at, at);

  icloudPrivacy.addMailbox({
    id: "distractor-wrong-label",
    email: "wrong-label@icloud.com",
    label: "ic-pipeline:another-task",
    account_id: icloudPrivacy.privacyAccountId,
    alias_hub_source_account_id: fixture.accountId,
    alias_hub_synced: true,
  });
  icloudPrivacy.addMailbox({
    id: "distractor-wrong-account",
    email: "wrong-account@icloud.com",
    label,
    account_id: "another-privacy-account",
    alias_hub_source_account_id: fixture.accountId,
    alias_hub_synced: true,
  });
  icloudPrivacy.addMailbox({
    id: "distractor-wrong-source",
    email: "wrong-source@icloud.com",
    label,
    account_id: icloudPrivacy.privacyAccountId,
    alias_hub_source_account_id: fixture.accountId + 999,
    alias_hub_synced: true,
  }, { insertAddress: false });
  const recoveredMailbox = icloudPrivacy.addMailbox({
    id: "recovered-mailbox",
    email: "recovered@icloud.com",
    label,
    account_id: icloudPrivacy.privacyAccountId,
    alias_hub_source_account_id: fixture.accountId,
    alias_hub_synced: true,
  });
  const recoveredAddress = db.prepare(`
    SELECT * FROM addresses WHERE account_id = ? AND address = ? COLLATE NOCASE
  `).get(fixture.accountId, recoveredMailbox.email);

  const service = new IcRegistrationPipelineService({
    db,
    registration,
    paymentLinks,
    paymentAgreements,
    icloudPrivacy,
    pollIntervalMs: 20,
    sleepFn: async () => undefined,
  });
  t.after(async () => {
    await service.close();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const final = await waitForTerminal(service, taskId);
  assert.equal(final.status, "completed");
  assert.equal(final.items[0].mailbox_id, recoveredMailbox.id);
  assert.equal(final.items[0].email, recoveredMailbox.email);
  assert.equal(final.items[0].address_id, recoveredAddress.id);
  assert.equal(icloudPrivacy.createCalls.length, 0);
  assert.equal(registration.createCalls.length, 1);
  assert.deepEqual(registration.createCalls[0].addressIds, [recoveredAddress.id]);
});

test("auto-create rejects more than twenty mailboxes before any remote creation", async (t) => {
  const context = createHarness(t, { count: 1 });
  await assert.rejects(
    context.service.start(autoCreateInput(context, {
      count: 21,
      requestId: "fixture-auto-too-many-001",
    })),
    (error) => error.status === 400 && /1 到 20/.test(error.message),
  );
  assert.equal(context.icloudPrivacy.createCalls.length, 0);
  assert.equal(context.registration.createCalls.length, 0);
});

test("auto-create reports and blocks an explicitly expired Apple login", async (t) => {
  const context = createHarness(t, { count: 1 });
  context.icloudPrivacy.status = async () => ({
    success: true,
    sessions: [{
      account_id: context.icloudPrivacy.privacyAccountId,
      apple_id: "owner@icloud.com",
      apple_account_login_saved: true,
      apple_account_login_checked: true,
      apple_account_login_ok: false,
      apple_account_manage_ready: true,
    }],
  });

  const status = await context.service.mailboxStatus();
  assert.equal(status.sessions[0].ready, false);
  assert.equal(status.sessions[0].status, "login_expired");
  await assert.rejects(
    context.service.start(autoCreateInput(context, {
      requestId: "fixture-auto-expired-001",
    })),
    (error) => error.status === 409 && /登录态已失效/.test(error.message),
  );
  assert.equal(context.icloudPrivacy.createCalls.length, 0);
  assert.equal(context.registration.createCalls.length, 0);
});

test("database migration restores phase ownership for legacy iCloud failures", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-ic-phase-migration-test-"));
  const filename = path.join(directory, "test.db");
  let db = createDatabase({ filename, seedDemo: false });
  t.after(() => {
    if (db?.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const fixture = insertIcloudFixture(db, 4);
  const at = nowIso();
  const taskId = "fixture-legacy-phase-migration";
  db.prepare(`
    INSERT INTO ic_registration_pipelines (
      id, request_id, request_fingerprint, account_id, base_address_id, status, stage,
      requested_count, concurrency, browser_mode, proxy_selection, payment_link_country,
      progress_total, created_at, updated_at, finished_at
    ) VALUES (?, 'fixture-legacy-phase-request', 'fixture-legacy-phase-fingerprint', ?, ?,
      'failed', 'failed', 4, 1, 'headless', 'auto', 'DE', 4, ?, ?, ?)
  `).run(taskId, fixture.accountId, fixture.addressIds[0], at, at, at);
  db.prepare(`
    INSERT INTO registered_account_payment_links (
      external_account_id, email, task_id, status, stage, progress, provider_url,
      created_at, updated_at, finished_at
    ) VALUES ('2002', 'alias-2@icloud.com', 'legacy-link-succeeded', 'succeeded',
      'completed', 100, 'https://www.paypal.com/agreements/approve?ba_token=legacy', ?, ?, ?)
  `).run(at, at, at);
  const insertItem = db.prepare(`
    INSERT INTO ic_registration_pipeline_items (
      pipeline_id, address_id, email, external_account_id, payment_link_task_id,
      status, stage, error, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, 'failed', 'failed', 'legacy failure', ?, ?, ?)
  `);
  insertItem.run(taskId, null, "", "", "", at, at, at);
  insertItem.run(taskId, fixture.addressIds[0], "owner@icloud.com", "", "", at, at, at);
  insertItem.run(taskId, fixture.addressIds[1], "alias-1@icloud.com", "2001", "legacy-link-failed", at, at, at);
  insertItem.run(taskId, fixture.addressIds[2], "alias-2@icloud.com", "2002", "legacy-link-succeeded", at, at, at);
  db.exec("ALTER TABLE ic_registration_pipeline_items DROP COLUMN failure_stage");
  db.close();

  db = createDatabase({ filename, seedDemo: false });
  const column = db.pragma("table_info(ic_registration_pipeline_items)")
    .find((entry) => entry.name === "failure_stage");
  assert.ok(column);
  const rows = db.prepare(`
    SELECT failure_stage FROM ic_registration_pipeline_items WHERE pipeline_id = ? ORDER BY id
  `).all(taskId);
  assert.deepEqual(rows.map((row) => row.failure_stage), [
    "mailbox_submitting",
    "registration_wait",
    "link_wait",
    "agreement_submitting",
  ]);
});
