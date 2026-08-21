import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAILCOM_ALIAS_STRATEGY, mailcomDomains } from "../address-generator.js";
import { createDatabase, createSourceAccount, nowIso } from "../db.js";
import { createApp } from "../index.js";
import { mailcomRecyclingReservation } from "../mailcom-recycle-reservation.js";
import { MailcomRegistrationPipelineService } from "../mailcom-registration-pipeline-service.js";
import { jsonRequest } from "./http-harness.js";

const MAILCOM_ALIAS_AUTHORIZATION_BLOCK_PREFIX = "Mail.com 网页授权需要处理：";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function addMailcomAccount(db, email, aliases = [], {
  limitReason = "",
  savedCredentials = false,
} = {}) {
  const account = createSourceAccount(db, { email, provider: "mailcom", officialLimit: 10 });
  db.prepare(`
    UPDATE source_accounts SET status = 'connected', limit_reason = ?, updated_at = ? WHERE id = ?
  `).run(limitReason, nowIso(), account.id);
  if (savedCredentials) {
    db.prepare(`
      INSERT INTO mailcom_credentials (account_id, username, password_encrypted, credential_updated_at)
      VALUES (?, ?, 'fixture-encrypted-web-password', ?)
    `).run(account.id, email, nowIso());
  }
  const insert = db.prepare(`
    INSERT INTO addresses (
      account_id, address, kind, status, strategy, label, purpose,
      remote_confirmed, created_at, updated_at
    ) VALUES (?, ?, 'official', 'active', ?, 'Mail.com 官方别名', '测试', 1, ?, ?)
  `);
  const rows = aliases.map((address) => {
    const at = nowIso();
    const result = insert.run(account.id, address, MAILCOM_ALIAS_STRATEGY, at, at);
    return db.prepare("SELECT * FROM addresses WHERE id = ?").get(Number(result.lastInsertRowid));
  });
  return { account: db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id), aliases: rows };
}

class FakeRegistration {
  constructor(db, outcomes = {}, timeline = [], trialOutcomes = {}) {
    this.db = db;
    this.timeline = timeline;
    this.outcomes = new Map(Object.entries(outcomes).map(([email, values]) => [
      email.toLowerCase(), Array.isArray(values) ? [...values] : [values],
    ]));
    this.trialOutcomes = new Map(Object.entries(trialOutcomes).map(([email, values]) => [
      email.toLowerCase(), Array.isArray(values) ? [...values] : [values],
    ]));
    this.jobOutcomes = new Map();
    this.createCalls = [];
    this.cancelCalls = [];
    this.deleteCalls = [];
    this.deletedAccountIds = new Set();
    this.trialCalls = [];
    this.trialActive = 0;
    this.maxTrialActive = 0;
    this.nextAccountId = 10_000;
    this.emailByExternalId = new Map();
    this.client = { health: async () => ({ ok: true, configured: true }) };
  }

  registrationQueueControl() {
    return Promise.resolve({ paused: false });
  }

  getProxyPool() {
    return ["http://fixture-proxy.example:8080"];
  }

  async resolveRegisteredAccountTrialRoute() {
    return "fixture-trial-route";
  }

  nextOutcome(email) {
    const key = String(email).toLowerCase();
    const queue = this.outcomes.get(key);
    if (!queue?.length) return { status: "completed" };
    const outcome = queue.shift();
    return typeof outcome === "string" ? { status: outcome } : { ...outcome };
  }

  nextTrialOutcome(email) {
    const queue = this.trialOutcomes.get(String(email || "").toLowerCase())
      || this.trialOutcomes.get("*");
    if (!queue?.length) return { status: "eligible", eligible: true };
    const outcome = queue.shift();
    return typeof outcome === "string" ? { status: outcome } : { ...outcome };
  }

  async checkRegisteredAccountTrialForCountry(account, country) {
    const email = String(account?.email || this.emailByExternalId.get(String(account?.id)) || "")
      .toLowerCase();
    const normalizedCountry = String(country || "").toUpperCase();
    const outcome = this.nextTrialOutcome(email);
    this.trialCalls.push({ id: Number(account?.id), email, country: normalizedCountry });
    this.timeline.push(`trial:check:${email}:${normalizedCountry}`);
    this.trialActive += 1;
    this.maxTrialActive = Math.max(this.maxTrialActive, this.trialActive);
    try {
      if (outcome.gate) await outcome.gate.promise;
      if (outcome.error instanceof Error && outcome.throw === true) throw outcome.error;
      const prefix = normalizedCountry === "GB" ? "gb_trial"
        : normalizedCountry === "US" ? "us_trial" : "trial";
      const status = String(outcome.status || "eligible").toLowerCase();
      const eligible = typeof outcome.eligible === "boolean"
        ? outcome.eligible : status === "eligible" ? true : status === "ineligible" ? false : null;
      return {
        id: Number(account?.id),
        [`${prefix}_status`]: status,
        [`${prefix}_eligible`]: eligible,
        [`${prefix}_error`]: outcome.message || (status === "failed" ? "fixture trial check failure" : ""),
        [`${prefix}_checked_at`]: outcome.checkedAt || nowIso(),
      };
    } finally {
      this.trialActive -= 1;
    }
  }

  async createJobs(input) {
    this.createCalls.push(structuredClone(input));
    assert.equal(input.count, 1);
    assert.equal(input.concurrency, 1);
    assert.equal(input.addressIds.length, 1);
    const address = this.db.prepare("SELECT * FROM addresses WHERE id = ?").get(input.addressIds[0]);
    assert.ok(address);
    const at = nowIso();
    const result = this.db.prepare(`
      INSERT INTO registration_jobs (
        account_id, address_id, base_address_id, email, external_task_id,
        status, stage, browser_mode, message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'running', 'register', ?, '正在注册', ?, ?)
    `).run(
      input.accountId,
      address.id,
      address.id,
      address.address,
      `registration-${this.createCalls.length}`,
      input.browserMode,
      at,
      at,
    );
    const id = Number(result.lastInsertRowid);
    this.jobOutcomes.set(id, this.nextOutcome(address.address));
    return [this.getJob(id)];
  }

  getJob(id) {
    return this.db.prepare("SELECT * FROM registration_jobs WHERE id = ? AND deleted_at IS NULL")
      .get(Number(id));
  }

  async syncJob(row) {
    const current = this.getJob(row.id);
    if (!current || new Set(["completed", "failed", "cancelled", "interrupted"]).has(current.status)) return current;
    this.timeline.push(`registration:sync:${current.email}`);
    const outcome = this.jobOutcomes.get(current.id) || { status: "completed" };
    if (outcome.status === "pending" || outcome.status === "running") return current;
    const at = nowIso();
    if (outcome.status === "completed") {
      const externalId = String(this.nextAccountId++);
      this.emailByExternalId.set(externalId, current.email);
      this.db.prepare(`
        UPDATE registration_jobs
        SET status = 'completed', stage = 'completed', external_account_id = ?,
          message = '注册成功', finished_at = ?, updated_at = ? WHERE id = ?
      `).run(externalId, at, at, current.id);
    } else {
      this.db.prepare(`
        UPDATE registration_jobs
        SET status = ?, stage = ?, failure_reason = ?, message = ?,
          finished_at = ?, updated_at = ? WHERE id = ?
      `).run(
        outcome.status || "failed",
        outcome.status || "failed",
        outcome.failure_reason || "fixture_failure",
        outcome.message || "fixture registration failed",
        at,
        at,
        current.id,
      );
    }
    return this.getJob(current.id);
  }

  async cancelJob(id) {
    this.cancelCalls.push(Number(id));
    const row = this.getJob(id);
    if (!row || new Set(["completed", "failed", "cancelled", "interrupted"]).has(row.status)) return row;
    const at = nowIso();
    this.db.prepare(`
      UPDATE registration_jobs SET status = 'cancelled', stage = 'cancelled',
        message = '任务已取消', finished_at = ?, updated_at = ? WHERE id = ?
    `).run(at, at, row.id);
    return this.getJob(row.id);
  }

  async deleteRegisteredAccountForPipeline(input = {}) {
    const id = Number(input.id);
    const email = String(input.email || "").trim().toLowerCase();
    const registrationJobId = Number(input.registrationJobId);
    assert.equal(Number.isSafeInteger(id) && id > 0, true);
    assert.equal(Number.isSafeInteger(registrationJobId) && registrationJobId > 0, true);
    assert.equal(email, String(this.emailByExternalId.get(String(id)) || "").toLowerCase());
    const registrationJob = this.getJob(registrationJobId);
    assert.ok(registrationJob);
    assert.equal(String(registrationJob.email || "").toLowerCase(), email);
    assert.equal(String(registrationJob.external_account_id || ""), String(id));
    const alreadyAbsent = this.deletedAccountIds.has(id);
    this.deleteCalls.push({ id, email, registrationJobId });
    this.deletedAccountIds.add(id);
    return { id, email, deleted: !alreadyAbsent, already_absent: alreadyAbsent };
  }
}

class FakePaymentLinks {
  constructor(registration, outcomes = {}, timeline = []) {
    this.registration = registration;
    this.timeline = timeline;
    this.outcomes = new Map(Object.entries(outcomes).map(([email, values]) => [
      email.toLowerCase(), Array.isArray(values) ? [...values] : [values],
    ]));
    this.rows = new Map();
    this.startCalls = [];
    this.cancelCalls = [];
    this.afterStart = null;
  }

  configuration() {
    return {
      configured: true,
      checkout_proxy_count: 2,
      update_proxy_count: 2,
      apply_checkout_update: true,
    };
  }

  nextOutcome(email) {
    const queue = this.outcomes.get(String(email).toLowerCase());
    if (!queue?.length) return "succeeded";
    const value = queue.shift();
    return typeof value === "string" ? value : value.status;
  }

  async start(input) {
    this.startCalls.push(structuredClone(input));
    const accountId = String(input.ids[0]);
    const email = this.registration.emailByExternalId.get(accountId) || `account-${accountId}@example.com`;
    this.timeline.push(`link:start:${email}`);
    const outcome = this.nextOutcome(email);
    const row = {
      external_account_id: accountId,
      email,
      task_id: `link-${this.startCalls.length}`,
      status: outcome,
      stage: outcome,
      provider_url: outcome === "succeeded"
        ? `https://www.paypal.com/agreements/approve?ba_token=BA-${accountId}` : "",
      error: outcome === "failed" ? "fixture link failure" : "",
      started_at: nowIso(),
      updated_at: nowIso(),
      accepted: true,
    };
    this.rows.set(accountId, row);
    this.afterStart?.(row);
    return { items: [row], started: 1, failed: 0 };
  }

  row(accountId) {
    return this.rows.get(String(accountId));
  }

  track() {
    return Promise.resolve();
  }

  persistTracked(accountId, taskId, values) {
    const row = this.row(accountId);
    if (!row || row.task_id !== taskId) return row;
    Object.assign(row, values, { updated_at: nowIso() });
    return row;
  }

  async request(url) {
    this.cancelCalls.push(url);
    const taskId = url.split("/").at(-2);
    const row = [...this.rows.values()].find((entry) => entry.task_id === taskId);
    if (row) Object.assign(row, { status: "cancelled", stage: "cancelled", updated_at: nowIso() });
    return row || { task_id: taskId, status: "cancelled" };
  }

  applySnapshot(accountId, snapshot) {
    const row = this.row(accountId);
    if (row) Object.assign(row, snapshot);
    return row;
  }
}

class FakePaymentAgreements {
  constructor(registration, timeline = [], {
    outcomes = {},
    runtimeReadySequence = [],
    settingsError = null,
    runtimeError = null,
  } = {}) {
    this.registration = registration;
    this.timeline = timeline;
    this.outcomes = new Map(Object.entries(outcomes).map(([email, values]) => [
      email.toLowerCase(), Array.isArray(values) ? [...values] : [values],
    ]));
    this.runtimeReadySequence = [...runtimeReadySequence];
    this.settingsError = settingsError;
    this.runtimeError = runtimeError;
    this.runtimeReady = true;
    this.contexts = new Map();
    this.trackers = new Map();
    this.startCalls = [];
    this.cancelCalls = [];
    this.releaseCalls = [];
    this.maxContexts = 0;
  }

  settings() {
    if (this.settingsError) throw this.settingsError;
    return {
      protocol_configured: true,
      configured: true,
      api_key_configured: true,
      encryption_ready: true,
    };
  }

  runtime({ required = false } = {}) {
    if (this.runtimeError) throw this.runtimeError;
    const ready = this.runtimeReadySequence.length
      ? this.runtimeReadySequence.shift()
      : this.runtimeReady;
    if (required && !ready) {
      throw Object.assign(new Error("fixture agreement runtime unavailable"), {
        status: 503,
        code: "PAYMENT_AGREEMENT_RUNTIME_PROXY_POOL_MISSING",
      });
    }
    return {
      configured: ready,
      country: ready ? "DE" : "",
      proxy_count: ready ? 1 : 0,
      proxies: ready ? ["http://fixture-agreement-proxy.example:8080"] : [],
      masked_proxies: ready ? ["http://fixture-agreement-proxy.example:8080"] : [],
    };
  }

  setRuntimeReady(value) {
    this.runtimeReadySequence.length = 0;
    this.runtimeReady = Boolean(value);
    this.runtimeError = null;
  }

  nextOutcome(email) {
    const queue = this.outcomes.get(String(email || "").toLowerCase());
    if (!queue?.length) return { status: "completed" };
    const value = queue.shift();
    return typeof value === "string" ? { status: value } : { ...value };
  }

  async start(input) {
    const paypalUrl = String(input?.paypal_url || "");
    const accountId = paypalUrl.match(/\bBA-([A-Za-z0-9_-]+)/i)?.[1] || "unknown";
    const email = this.registration.emailByExternalId.get(String(accountId)) || `account-${accountId}@example.com`;
    const outcome = this.nextOutcome(email);
    const jobId = String(outcome.jobId || `agreement-${accountId}-${this.startCalls.length + 1}`);
    this.startCalls.push(structuredClone(input));
    this.timeline.push(`agreement:start:${email}`);
    if (outcome.submitGate) await outcome.submitGate.promise;
    const terminal = new Set(["completed", "failed", "cancelled"]).has(outcome.status);
    const context = {
      jobId,
      lastSnapshot: {
        id: jobId,
        status: outcome.status || "completed",
        error: outcome.error || (outcome.status === "failed" ? "fixture agreement failure" : ""),
      },
      lastError: outcome.lastError || "",
      stopped: false,
      terminal,
    };
    this.contexts.set(jobId, context);
    this.maxContexts = Math.max(this.maxContexts, this.contexts.size);
    if (outcome.gate) {
      context.terminal = false;
      const tracker = outcome.gate.promise.then((result = {}) => {
        const resolved = typeof result === "string" ? { status: result } : result;
        context.lastSnapshot = {
          id: jobId,
          status: resolved.status || "completed",
          error: resolved.error || "",
        };
        context.terminal = true;
        return context.lastSnapshot;
      }).finally(() => this.trackers.delete(jobId));
      this.trackers.set(jobId, tracker);
    }
    return { job: { id: jobId, status: context.lastSnapshot.status } };
  }

  context(jobId) {
    return this.contexts.get(String(jobId || "")) || null;
  }

  async cancelJob(jobId) {
    const key = String(jobId || "");
    this.cancelCalls.push(key);
    const context = this.context(key);
    if (context) {
      context.stopped = true;
      context.terminal = true;
      context.lastSnapshot = { id: key, status: "cancelled", error: "fixture agreement cancelled" };
    }
    return context?.lastSnapshot || { id: key, status: "cancelled" };
  }

  async releaseContext(jobId, options = {}) {
    const key = String(jobId || "");
    this.releaseCalls.push({ jobId: key, ...options });
    const context = this.context(key);
    if (!context) return false;
    if (options.force && !context.terminal) context.stopped = true;
    if (!context.terminal && !context.stopped) return false;
    context.lastSnapshot = null;
    context.lastError = "";
    this.contexts.delete(key);
    return true;
  }
}

class FakeMailcomAliases {
  constructor(db, {
    prepareCreated = 0,
    prepareFailures = [],
    authorizationFailures = [],
    authorizationGate = null,
    recycleFailures = [],
    recycleFailuresAfterGate = [],
    recycleGate = null,
    prepareGate = null,
    prepareGates = [],
  } = {}) {
    this.db = db;
    this.prepareCreated = prepareCreated;
    this.prepareFailures = [...prepareFailures];
    this.authorizationFailures = [...authorizationFailures];
    this.authorizationGate = authorizationGate;
    this.recycleFailures = [...recycleFailures];
    this.recycleFailuresAfterGate = [...recycleFailuresAfterGate];
    this.recycleGate = recycleGate;
    this.prepareGate = prepareGate;
    this.prepareGates = [...prepareGates];
    this.prepareCalls = [];
    this.authorizationCalls = [];
    this.createReplacementCalls = [];
    this.recycleCalls = [];
    this.operationLog = [];
    this.prepareActive = 0;
    this.maxPrepareActive = 0;
  }

  async prepareAccount(accountId, { domain }) {
    const callIndex = this.prepareCalls.length;
    this.prepareCalls.push({ accountId, domain });
    this.operationLog.push(`prepare:${accountId}`);
    this.prepareActive += 1;
    this.maxPrepareActive = Math.max(this.maxPrepareActive, this.prepareActive);
    await Promise.resolve();
    const gate = callIndex < this.prepareGates.length
      ? this.prepareGates[callIndex]
      : this.prepareGate;
    if (gate) await gate.promise;
    this.prepareActive -= 1;
    const failure = this.prepareFailures.shift();
    if (failure) throw failure;
    return { counts: { created: this.prepareCreated }, items: [] };
  }

  async verifyAuthorization(accountId) {
    this.authorizationCalls.push({ accountId });
    this.operationLog.push(`verify:${accountId}`);
    if (this.authorizationGate) await this.authorizationGate.promise;
    const failure = this.authorizationFailures.shift();
    if (failure) throw failure;
    const account = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(accountId);
    return {
      account,
      addresses: account ? [String(account.email).toLowerCase()] : [],
      domains: ["mail.com"],
    };
  }

  async recycleAlias(accountId, options) {
    this.recycleCalls.push({ accountId, ...options });
    this.operationLog.push(`recycle:${accountId}:${options.address}`);
    const configuredFailure = this.recycleFailures.shift();
    if (configuredFailure) throw configuredFailure;
    if (this.recycleGate) await this.recycleGate.promise;
    const afterGateFailure = this.recycleFailuresAfterGate.shift();
    if (afterGateFailure) throw afterGateFailure;
    const existing = this.db.prepare(`
      SELECT * FROM addresses WHERE account_id = ? AND address = ? COLLATE NOCASE
    `).get(accountId, options.replacementAddress);
    this.db.prepare(`
      UPDATE addresses SET status = 'disabled', updated_at = ?
      WHERE account_id = ? AND address = ? COLLATE NOCASE AND kind = 'official'
    `).run(nowIso(), accountId, options.address);
    let item = existing;
    if (item) {
      this.db.prepare("UPDATE addresses SET status = 'active', updated_at = ? WHERE id = ?")
        .run(nowIso(), item.id);
      item = this.db.prepare("SELECT * FROM addresses WHERE id = ?").get(item.id);
    } else {
      const at = nowIso();
      const result = this.db.prepare(`
        INSERT INTO addresses (
          account_id, address, kind, status, strategy, label, purpose,
          remote_confirmed, created_at, updated_at
        ) VALUES (?, ?, 'official', 'active', ?, 'Mail.com 轮换别名', '流水线', 1, ?, ?)
      `).run(accountId, options.replacementAddress, MAILCOM_ALIAS_STRATEGY, at, at);
      item = this.db.prepare("SELECT * FROM addresses WHERE id = ?").get(Number(result.lastInsertRowid));
    }
    return { removed: options.address, created: item.address, item, account: { id: accountId } };
  }

  async createReplacementAlias(accountId, options) {
    this.createReplacementCalls.push({ accountId, ...options });
    this.operationLog.push(`create-replacement:${accountId}:${options.replacementAddress}`);
    const configuredFailure = this.recycleFailures.shift();
    if (configuredFailure) throw configuredFailure;
    if (this.recycleGate) await this.recycleGate.promise;
    const afterGateFailure = this.recycleFailuresAfterGate.shift();
    if (afterGateFailure) throw afterGateFailure;
    if (options.recycleAddress) {
      this.db.prepare(`
        UPDATE addresses SET status = 'disabled', remote_confirmed = 0, updated_at = ?
        WHERE account_id = ? AND address = ? COLLATE NOCASE AND kind = 'official'
      `).run(nowIso(), accountId, options.recycleAddress);
    }
    let item = this.db.prepare(`
      SELECT * FROM addresses WHERE account_id = ? AND address = ? COLLATE NOCASE
    `).get(accountId, options.replacementAddress);
    if (item) {
      this.db.prepare("UPDATE addresses SET status = 'active', updated_at = ? WHERE id = ?")
        .run(nowIso(), item.id);
      item = this.db.prepare("SELECT * FROM addresses WHERE id = ?").get(item.id);
    } else {
      const at = nowIso();
      const result = this.db.prepare(`
        INSERT INTO addresses (
          account_id, address, kind, status, strategy, label, purpose,
          remote_confirmed, created_at, updated_at
        ) VALUES (?, ?, 'official', 'active', ?, 'Mail.com 母号替代别名', '流水线', 1, ?, ?)
      `).run(accountId, options.replacementAddress, MAILCOM_ALIAS_STRATEGY, at, at);
      item = this.db.prepare("SELECT * FROM addresses WHERE id = ?")
        .get(Number(result.lastInsertRowid));
    }
    return { created: item.address, item, account: { id: accountId } };
  }
}

function input(overrides = {}) {
  return {
    domain: "mail.com",
    concurrency: 2,
    browserMode: "headless",
    proxySelection: "auto",
    paymentLinkCountry: "GB",
    recycleSucceeded: false,
    requestId: "mailcom-pipeline-fixture-001",
    ...overrides,
  };
}

function harness(t, {
  accounts = [{ email: "owner@mail.com", aliases: ["first@email.com"] }],
  registrationOutcomes = {},
  trialOutcomes = {},
  paymentOutcomes = {},
  agreementOptions = {},
  aliasOptions = {},
  serviceOptions = {},
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-mailcom-pipeline-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const fixtures = accounts.map((account) => addMailcomAccount(
    db,
    account.email,
    account.aliases || [],
    {
      limitReason: account.limitReason || "",
      savedCredentials: account.savedCredentials === true,
    },
  ));
  const timeline = [];
  const registration = new FakeRegistration(db, registrationOutcomes, timeline, trialOutcomes);
  const paymentLinks = new FakePaymentLinks(registration, paymentOutcomes, timeline);
  const paymentAgreements = new FakePaymentAgreements(registration, timeline, agreementOptions);
  const mailcomAliases = new FakeMailcomAliases(db, aliasOptions);
  const service = new MailcomRegistrationPipelineService({
    db,
    registration,
    paymentLinks,
    paymentAgreements,
    mailcomAliases,
    pollIntervalMs: 20,
    retryBaseMs: 20,
    retryMaximumMs: 40,
    sleepFn: () => new Promise((resolve) => setTimeout(resolve, 1)),
    ...serviceOptions,
  });
  t.after(async () => {
    await service.close();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    db,
    fixtures,
    registration,
    paymentLinks,
    paymentAgreements,
    mailcomAliases,
    service,
    timeline,
  };
}

async function waitFor(read, predicate, message = "condition", timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${message}`);
}

function attempts(db, pipelineId) {
  return db.prepare(`
    SELECT * FROM mailcom_registration_pipeline_attempts WHERE pipeline_id = ? ORDER BY id
  `).all(pipelineId);
}

function insertHistoricalAliasAttempt(context, {
  pipelineId,
  alias,
  outcome = "registration_failed",
  stage = outcome,
  externalAccountId = "",
  linkStatus = "skipped",
  agreementStatus = "skipped",
  recycleStatus = "failed",
} = {}) {
  const fixture = context.fixtures[0];
  const at = nowIso();
  context.db.prepare(`
    INSERT INTO mailcom_registration_pipelines (
      id, request_id, request_fingerprint, domain, status, stage, concurrency,
      browser_mode, proxy_selection, payment_link_country, recycle_succeeded,
      account_count, slot_count, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, 'mail.com', 'completed', 'completed', 1,
      'headless', 'auto', 'GB', 0, 1, 1, ?, ?, ?)
  `).run(pipelineId, `${pipelineId}-request`, `${pipelineId}-fingerprint`, at, at, at);
  const itemId = Number(context.db.prepare(`
    INSERT INTO mailcom_registration_pipeline_items (
      pipeline_id, account_id, source_email, slot_key, slot_kind,
      initial_address_id, initial_email, current_address_id, current_email,
      status, stage, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, 'official', ?, ?, ?, ?,
      'failed', ?, ?, ?, ?)
  `).run(
    pipelineId,
    fixture.account.id,
    fixture.account.email,
    `official:${alias.id}`,
    alias.id,
    alias.address,
    alias.id,
    alias.address,
    stage,
    at,
    at,
    at,
  ).lastInsertRowid);
  const attemptId = Number(context.db.prepare(`
    INSERT INTO mailcom_registration_pipeline_attempts (
      pipeline_id, item_id, attempt_number, address_id, email, external_account_id,
      status, stage, outcome, registration_status, trial_status, link_status,
      agreement_status, recycle_status, finished_at, created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, ?, 'failed', ?, ?, 'failed', 'skipped', ?, ?, ?, ?, ?, ?)
  `).run(
    pipelineId,
    itemId,
    alias.id,
    alias.address,
    externalAccountId,
    stage,
    outcome,
    linkStatus,
    agreementStatus,
    recycleStatus,
    at,
    at,
    at,
  ).lastInsertRowid);
  context.db.prepare(`
    UPDATE mailcom_registration_pipeline_items SET current_attempt_id = ? WHERE id = ?
  `).run(attemptId, itemId);
  return { pipelineId, itemId, attemptId };
}

function insertPrimaryRecycleAttempt(context, {
  pipelineId = "mailcom-primary-safe-capacity-pipeline",
} = {}) {
  const fixture = context.fixtures[0];
  const primary = context.db.prepare(`
    SELECT * FROM addresses WHERE account_id = ? AND kind = 'primary'
  `).get(fixture.account.id);
  const at = nowIso();
  context.db.prepare(`
    INSERT INTO mailcom_registration_pipelines (
      id, request_id, request_fingerprint, domain, status, stage, concurrency,
      browser_mode, proxy_selection, payment_link_country, recycle_succeeded,
      account_count, slot_count, created_at, updated_at
    ) VALUES (?, ?, ?, 'mail.com', 'running', 'recycling', 1,
      'headless', 'auto', 'GB', 0, 1, 1, ?, ?)
  `).run(pipelineId, `${pipelineId}-request`, `${pipelineId}-fingerprint`, at, at);
  const itemId = Number(context.db.prepare(`
    INSERT INTO mailcom_registration_pipeline_items (
      pipeline_id, account_id, source_email, slot_key, slot_kind,
      initial_address_id, initial_email, current_address_id, current_email,
      status, stage, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'primary', ?, ?, ?, ?, 'running', 'recycle_queued', ?, ?)
  `).run(
    pipelineId,
    fixture.account.id,
    fixture.account.email,
    `primary:${fixture.account.id}`,
    primary.id,
    primary.address,
    primary.id,
    primary.address,
    at,
    at,
  ).lastInsertRowid);
  const attemptId = Number(context.db.prepare(`
    INSERT INTO mailcom_registration_pipeline_attempts (
      pipeline_id, item_id, attempt_number, address_id, email, status, stage,
      outcome, registration_status, trial_status, link_status, agreement_status,
      recycle_status, finished_at, created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, 'failed', 'registration_failed',
      'registration_failed', 'failed', 'skipped', 'skipped', 'skipped',
      'pending', ?, ?, ?)
  `).run(pipelineId, itemId, primary.id, primary.address, at, at, at).lastInsertRowid);
  context.db.prepare(`
    UPDATE mailcom_registration_pipeline_items SET current_attempt_id = ? WHERE id = ?
  `).run(attemptId, itemId);
  return { pipelineId, itemId, attemptId, primary };
}

function insertCancelledRecycleOrphan(context, {
  pipelineId = "mailcom-cancelled-orphan-pipeline",
  replacementEmail = "ahcancelrecover@mail.com",
  stage = "recycle_remote_started",
} = {}) {
  const fixture = context.fixtures[0];
  const primary = context.db.prepare(`
    SELECT * FROM addresses WHERE account_id = ? AND kind = 'primary'
  `).get(fixture.account.id);
  const oldAlias = fixture.aliases[0];
  const at = nowIso();
  context.db.prepare(`
    INSERT INTO mailcom_registration_pipelines (
      id, request_id, request_fingerprint, domain, status, stage, concurrency,
      browser_mode, proxy_selection, payment_link_country, recycle_succeeded,
      account_count, slot_count, created_at, updated_at, finished_at
    ) VALUES (?, ?, 'fixture-orphan-fingerprint', 'mail.com', 'cancelled', 'cancelled',
      1, 'headless', 'auto', 'DE', 1, 1, 2, ?, ?, ?)
  `).run(pipelineId, `${pipelineId}-request`, at, at, at);
  context.db.prepare(`
    INSERT INTO mailcom_registration_pipeline_items (
      pipeline_id, account_id, source_email, slot_key, slot_kind,
      initial_address_id, initial_email, current_address_id, current_email,
      status, stage, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, 'primary', ?, ?, ?, ?, 'completed', 'completed', ?, ?, ?)
  `).run(
    pipelineId,
    fixture.account.id,
    fixture.account.email,
    `primary:${fixture.account.id}`,
    primary.id,
    primary.address,
    primary.id,
    primary.address,
    at,
    at,
    at,
  );
  const itemResult = context.db.prepare(`
    INSERT INTO mailcom_registration_pipeline_items (
      pipeline_id, account_id, source_email, slot_key, slot_kind,
      initial_address_id, initial_email, current_address_id, current_email,
      replacement_email, current_attempt_id, status, stage, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, 'official', ?, ?, ?, ?, ?, NULL, 'cancelled', 'cancelled', ?, ?, ?)
  `).run(
    pipelineId,
    fixture.account.id,
    fixture.account.email,
    `official:${oldAlias.id}`,
    oldAlias.id,
    oldAlias.address,
    oldAlias.id,
    oldAlias.address,
    replacementEmail,
    at,
    at,
    at,
  );
  const itemId = Number(itemResult.lastInsertRowid);
  const attemptResult = context.db.prepare(`
    INSERT INTO mailcom_registration_pipeline_attempts (
      pipeline_id, item_id, attempt_number, address_id, email, status, stage,
      outcome, registration_status, link_status, recycle_status, recycle_attempts,
      registration_finished_at, link_finished_at, finished_at, created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, 'failed', ?, 'link_failed',
      'succeeded', 'failed', 'running', 1, ?, ?, ?, ?, ?)
  `).run(pipelineId, itemId, oldAlias.id, oldAlias.address, stage, at, at, at, at, at);
  const attemptId = Number(attemptResult.lastInsertRowid);
  context.db.prepare(`
    UPDATE mailcom_registration_pipeline_items SET current_attempt_id = ? WHERE id = ?
  `).run(attemptId, itemId);
  return { pipelineId, itemId, attemptId, oldAlias, replacementEmail };
}

test("start automatically verifies saved Mail.com web credentials and re-admits only recovered accounts", async (t) => {
  const blockedReason = `${MAILCOM_ALIAS_AUTHORIZATION_BLOCK_PREFIX}fixture session expired`;
  const context = harness(t, {
    accounts: [
      {
        email: "saved-password@mail.com",
        aliases: [],
        limitReason: blockedReason,
        savedCredentials: true,
      },
      {
        email: "missing-password@mail.com",
        aliases: [],
        limitReason: blockedReason,
      },
      { email: "already-ready@mail.com", aliases: [] },
    ],
  });

  const started = await context.service.start(input({
    requestId: "mailcom-auto-authorization-before-start",
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "pipeline after saved authorization recovery",
  );

  const recovered = context.db.prepare("SELECT * FROM source_accounts WHERE id = ?")
    .get(context.fixtures[0].account.id);
  const stillBlocked = context.db.prepare("SELECT * FROM source_accounts WHERE id = ?")
    .get(context.fixtures[1].account.id);
  assert.equal(final.status, "completed");
  assert.equal(final.account_count, 2);
  assert.equal(recovered.status, "connected");
  assert.equal(recovered.limit_reason, "");
  assert.equal(stillBlocked.status, "connected");
  assert.equal(stillBlocked.limit_reason, blockedReason);
  assert.deepEqual(
    context.mailcomAliases.authorizationCalls.map((call) => Number(call.accountId)),
    [Number(context.fixtures[0].account.id)],
  );
  assert.deepEqual(
    context.mailcomAliases.prepareCalls.map((call) => Number(call.accountId)),
    [Number(context.fixtures[0].account.id), Number(context.fixtures[2].account.id)],
  );
  assert.ok(final.items.every((item) => (
    Number(item.account_id) !== Number(context.fixtures[1].account.id)
  )));
});

test("transient Mail.com browser failures never create or overwrite an authorization block", async (t) => {
  const blockedReason = `${MAILCOM_ALIAS_AUTHORIZATION_BLOCK_PREFIX}fixture session expired`;
  const transientFailure = () => Object.assign(new Error("Mail.com 网页连接暂时不稳定，请稍后再试"), {
    status: 503,
    code: "MAILCOM_ALIAS_OPEN_TRANSIENT",
  });
  const context = harness(t, {
    accounts: [
      {
        email: "ready-transient@mail.com",
        aliases: [],
        savedCredentials: true,
      },
      {
        email: "blocked-transient@mail.com",
        aliases: [],
        savedCredentials: true,
      },
    ],
    aliasOptions: {
      authorizationFailures: [transientFailure(), transientFailure()],
    },
  });
  await context.service.recoveryPromise;
  context.db.prepare("UPDATE source_accounts SET limit_reason = ?, updated_at = ? WHERE id = ?")
    .run(blockedReason, nowIso(), context.fixtures[1].account.id);

  assert.equal(context.service.aliasAccountActionRequired(transientFailure()), false);
  assert.equal(context.service.aliasAccountActionRequired(Object.assign(
    new Error("Mail.com 网页登录超时"),
    { status: 504, code: "MAILCOM_WEB_LOGIN_TIMEOUT" },
  )), false);
  assert.equal(context.service.aliasAccountActionRequired(Object.assign(
    new Error("saved login rejected"),
    { status: 409, code: "MAILCOM_WEB_AUTH_FAILED" },
  )), true);

  const recovered = await context.service.recoverSavedAuthorizations({
    accountIds: context.fixtures.map((fixture) => fixture.account.id),
    force: true,
  });
  assert.deepEqual(recovered, { total: 2, recovered: 0, failed: 2 });
  const ready = context.db.prepare("SELECT status, limit_reason FROM source_accounts WHERE id = ?")
    .get(context.fixtures[0].account.id);
  const blocked = context.db.prepare("SELECT status, limit_reason FROM source_accounts WHERE id = ?")
    .get(context.fixtures[1].account.id);
  assert.deepEqual(ready, { status: "connected", limit_reason: "" });
  assert.deepEqual(blocked, { status: "connected", limit_reason: blockedReason });

  context.mailcomAliases.authorizationFailures.push(Object.assign(
    new Error("saved login rejected"),
    { status: 409, code: "MAILCOM_WEB_AUTH_FAILED" },
  ));
  const deterministic = await context.service.recoverSavedAuthorizations({
    accountIds: [context.fixtures[0].account.id],
    force: true,
  });
  assert.deepEqual(deterministic, { total: 1, recovered: 0, failed: 1 });
  assert.match(
    context.db.prepare("SELECT limit_reason FROM source_accounts WHERE id = ?")
      .get(context.fixtures[0].account.id).limit_reason,
    /网页授权需要处理：saved login rejected/,
  );
});

test("aggregates every connected Mail.com account and exact official alias with the selected domain", async (t) => {
  const context = harness(t, {
    accounts: [
      { email: "one@mail.com", aliases: ["one-alias@email.com"] },
      { email: "two@mail.com", aliases: ["two-alias@consultant.com"] },
    ],
  });
  const started = await context.service.start(input({ requestId: "mailcom-cross-account-001" }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "cross-account pipeline completion",
  );

  assert.equal(final.status, "completed");
  assert.equal(final.account_count, 2);
  assert.equal(final.slot_count, 4);
  assert.equal(final.attempt_count, 4);
  assert.equal(final.registration_success_count, 4);
  assert.equal(final.link_success_count, 4);
  assert.equal(context.mailcomAliases.prepareCalls.length, 2);
  assert.ok(context.mailcomAliases.prepareCalls.every((call) => call.domain === "mail.com"));
  assert.equal(context.mailcomAliases.maxPrepareActive, 1);
  assert.equal(context.registration.createCalls.length, 4);
  assert.ok(context.registration.createCalls.every((call) => (
    call.addressIds.length === 1 && call.addressIds[0] === call.baseAddressId
  )));
  assert.ok(context.paymentLinks.startCalls.every((call) => call.country === "GB"));

  const status = await context.service.status();
  assert.equal(status.connected_account_count, 2);
  assert.equal(status.active_alias_count, 2);
  assert.equal(status.connected_address_count, 4);
  assert.ok(status.mailcom_domains.includes("mail.com"));
  assert.equal(status.ready, true);
});

test("starts a prepared account before the next account finishes preparation", async (t) => {
  const secondPrepareGate = deferred();
  const context = harness(t, {
    accounts: [
      { email: "stream-one@mail.com", aliases: [] },
      { email: "stream-two@mail.com", aliases: [] },
    ],
    aliasOptions: { prepareGates: [null, secondPrepareGate] },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-stream-prepare-001",
    concurrency: 2,
  }));

  try {
    await waitFor(
      () => ({
        prepareCalls: context.mailcomAliases.prepareCalls.length,
        timeline: [...context.timeline],
      }),
      (state) => state.prepareCalls === 2
        && state.timeline.includes("link:start:stream-one@mail.com"),
      "first account link extraction while second preparation is blocked",
    );
    assert.equal(context.mailcomAliases.prepareActive, 1);
    assert.equal(context.mailcomAliases.maxPrepareActive, 1);
    assert.ok(context.timeline.includes("registration:sync:stream-one@mail.com"));
    assert.ok(context.timeline.includes("link:start:stream-one@mail.com"));
    assert.ok(context.registration.createCalls.some((call) => (
      Number(call.accountId) === Number(context.fixtures[0].account.id)
    )));
    assert.ok(context.registration.createCalls.every((call) => (
      Number(call.accountId) !== Number(context.fixtures[1].account.id)
    )));
    assert.equal(context.service.get(started.id).terminal, false);
  } finally {
    secondPrepareGate.resolve();
  }

  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "streaming preparation completion",
  );
  assert.equal(final.status, "completed");
  assert.equal(final.account_count, 2);
  assert.equal(final.attempt_count, 2);
  assert.equal(final.link_success_count, 2);
  assert.equal(final.agreement_success_count, 2);
  assert.deepEqual(
    new Set(context.registration.createCalls.map((call) => Number(call.accountId))),
    new Set(context.fixtures.map((fixture) => Number(fixture.account.id))),
  );
});

test("queues every mother preparation before an early registration failure can enqueue recycling", async (t) => {
  const first = "prepare-priority-one@mail.com";
  const second = "prepare-priority-two@mail.com";
  const context = harness(t, {
    accounts: [{ email: first, aliases: [] }, { email: second, aliases: [] }],
    registrationOutcomes: {
      [first]: [{ status: "failed", message: "fixture first mother failure" }],
    },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-prepare-priority-001",
    concurrency: 2,
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "preparation priority pipeline completion",
  );
  const firstAccountId = context.fixtures[0].account.id;
  const secondAccountId = context.fixtures[1].account.id;
  const secondPrepare = context.mailcomAliases.operationLog.indexOf(`prepare:${secondAccountId}`);
  const firstRecycle = context.mailcomAliases.operationLog.findIndex((entry) => (
    entry.startsWith(`create-replacement:${firstAccountId}:`)
  ));

  assert.equal(final.status, "completed");
  assert.ok(secondPrepare >= 0);
  assert.ok(firstRecycle > secondPrepare);
  assert.equal(context.mailcomAliases.maxPrepareActive, 1);
});

test("configured alias concurrency prepares different mothers in parallel", async (t) => {
  const firstGate = deferred();
  const secondGate = deferred();
  const context = harness(t, {
    accounts: [
      { email: "parallel-prepare-one@mail.com", aliases: [] },
      { email: "parallel-prepare-two@mail.com", aliases: [] },
    ],
    aliasOptions: { prepareGates: [firstGate, secondGate] },
    serviceOptions: { aliasOperationConcurrency: 2 },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-parallel-prepare-001",
    concurrency: 2,
  }));

  try {
    await waitFor(
      () => context.mailcomAliases.prepareActive,
      (active) => active === 2,
      "two parallel mother preparations",
    );
    assert.equal(context.mailcomAliases.maxPrepareActive, 2);
  } finally {
    firstGate.resolve();
    secondGate.resolve();
  }

  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "parallel preparation completion",
  );
  assert.equal(final.status, "completed");
});

test("a full mother account ends only the failed primary slot without poisoning official recycling", async (t) => {
  const primary = "full-primary@mail.com";
  const aliases = Array.from({ length: 9 }, (_, index) => `full-alias-${index}@mail.com`);
  const context = harness(t, {
    accounts: [{ email: primary, aliases }],
    registrationOutcomes: {
      [primary]: [{ status: "failed", message: "fixture primary registration failure" }],
    },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-primary-capacity-full-001",
    concurrency: 10,
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "full primary capacity completion",
  );
  const primaryItem = final.items.find((item) => item.slot_kind === "primary");
  const primaryAttempt = attempts(context.db, started.id).find((attempt) => attempt.email === primary);

  assert.equal(final.status, "partial_failed");
  assert.equal(final.registration_success_count, aliases.length);
  assert.equal(primaryItem.status, "failed");
  assert.equal(primaryItem.prepare_error, "");
  assert.equal(primaryAttempt.recycle_status, "failed");
  assert.match(primaryAttempt.recycle_error, /已占满|第 11 个替代别名/);
  assert.equal(context.mailcomAliases.createReplacementCalls.length, 0);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  assert.ok(final.items.filter((item) => item.slot_kind === "official")
    .every((item) => item.status === "completed"));
});

test("a full primary recycles only a historical safe failure and never selects Plus or blocked aliases", async (t) => {
  const primary = "safe-capacity-owner@mail.com";
  const aliases = [
    "safe-capacity-failed@mail.com",
    "safe-capacity-plus@mail.com",
    "safe-capacity-blocked@mail.com",
    ...Array.from({ length: 6 }, (_, index) => `safe-capacity-unknown-${index}@mail.com`),
  ];
  const context = harness(t, { accounts: [{ email: primary, aliases }] });
  const address = (email) => context.db.prepare(`
    SELECT * FROM addresses WHERE account_id = ? AND address = ? COLLATE NOCASE
  `).get(context.fixtures[0].account.id, email);
  const safeAlias = address(aliases[0]);
  const plusAlias = address(aliases[1]);
  const blockedAlias = address(aliases[2]);

  insertHistoricalAliasAttempt(context, {
    pipelineId: "mailcom-safe-capacity-history",
    alias: safeAlias,
  });
  insertHistoricalAliasAttempt(context, {
    pipelineId: "mailcom-plus-capacity-history",
    alias: plusAlias,
  });
  insertHistoricalAliasAttempt(context, {
    pipelineId: "mailcom-blocked-capacity-history",
    alias: blockedAlias,
    outcome: "link_blocked",
    stage: "link_blocked",
    externalAccountId: "blocked-capacity-account",
    linkStatus: "failed",
    recycleStatus: "skipped",
  });
  const at = nowIso();
  context.db.prepare(`
    INSERT INTO registered_account_status_checks (
      external_account_id, email, detection_status, subscription_status,
      account_type, checked_at, created_at, updated_at
    ) VALUES ('plus-capacity-account', ?, 'completed', 'active', 'plus', ?, ?, ?)
  `).run(plusAlias.address, at, at, at);
  const primaryRecycle = insertPrimaryRecycleAttempt(context);
  const primaryItem = context.db.prepare(`
    SELECT * FROM mailcom_registration_pipeline_items WHERE id = ?
  `).get(primaryRecycle.itemId);

  assert.deepEqual(
    context.service.motherAliasCandidates(primaryItem).map((candidate) => candidate.address),
    [safeAlias.address],
  );

  await context.service.recycleAttempt(primaryRecycle.attemptId);

  assert.equal(context.mailcomAliases.createReplacementCalls.length, 1);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  const call = context.mailcomAliases.createReplacementCalls[0];
  assert.equal(call.accountId, context.fixtures[0].account.id);
  assert.equal(call.recycleAddress, safeAlias.address);
  assert.match(call.replacementAddress, /^ah[a-z0-9]+@mail\.com$/);
  assert.equal(address(safeAlias.address).status, "disabled");
  assert.equal(address(plusAlias.address).status, "active");
  assert.equal(address(blockedAlias.address).status, "active");
  assert.equal(context.db.prepare(`
    SELECT COUNT(*) AS count FROM addresses
    WHERE account_id = ? AND status = 'active'
      AND (kind = 'primary' OR (kind = 'official' AND strategy = ?))
  `).get(context.fixtures[0].account.id, MAILCOM_ALIAS_STRATEGY).count, 10);
  assert.deepEqual(
    context.db.prepare(`
      SELECT recycle_status, replacement_email
      FROM mailcom_registration_pipeline_attempts WHERE id = ?
    `).get(primaryRecycle.attemptId),
    { recycle_status: "succeeded", replacement_email: call.replacementAddress },
  );
});

test("a full primary waits while an official slot is still being checked instead of failing or creating an eleventh address", async (t) => {
  const primary = "pending-capacity-owner@mail.com";
  const aliases = Array.from({ length: 9 }, (_, index) => `pending-capacity-${index}@mail.com`);
  const context = harness(t, { accounts: [{ email: primary, aliases }] });
  const primaryRecycle = insertPrimaryRecycleAttempt(context, {
    pipelineId: "mailcom-primary-pending-capacity-pipeline",
  });
  const pendingAlias = context.db.prepare(`
    SELECT * FROM addresses WHERE account_id = ? AND address = ? COLLATE NOCASE
  `).get(context.fixtures[0].account.id, aliases[0]);
  const at = nowIso();
  context.db.prepare(`
    INSERT INTO mailcom_registration_pipeline_items (
      pipeline_id, account_id, source_email, slot_key, slot_kind,
      initial_address_id, initial_email, current_address_id, current_email,
      status, stage, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'official', ?, ?, ?, ?,
      'running', 'trial_running', ?, ?)
  `).run(
    primaryRecycle.pipelineId,
    context.fixtures[0].account.id,
    primary,
    `official:${pendingAlias.id}`,
    pendingAlias.id,
    pendingAlias.address,
    pendingAlias.id,
    pendingAlias.address,
    at,
    at,
  );

  await context.service.recycleAttempt(primaryRecycle.attemptId);

  const storedAttempt = context.db.prepare(`
    SELECT recycle_status, stage, recycle_error, next_retry_at
    FROM mailcom_registration_pipeline_attempts WHERE id = ?
  `).get(primaryRecycle.attemptId);
  const storedItem = context.db.prepare(`
    SELECT status, stage, error FROM mailcom_registration_pipeline_items WHERE id = ?
  `).get(primaryRecycle.itemId);
  assert.equal(storedAttempt.recycle_status, "retry_wait");
  assert.equal(storedAttempt.stage, "recycle_retry_wait");
  assert.match(storedAttempt.recycle_error, /等待普通官方别名.*不会创建第 11 个地址/);
  assert.ok(storedAttempt.next_retry_at);
  assert.equal(storedItem.status, "retry_wait");
  assert.equal(storedItem.stage, "recycle_retry_wait");
  assert.match(storedItem.error, /等待普通官方别名/);
  assert.equal(context.mailcomAliases.createReplacementCalls.length, 0);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
});

test("registration failure is retained before an official alias is recycled and succeeds", async (t) => {
  const alias = "occupied@email.com";
  const context = harness(t, {
    registrationOutcomes: {
      [alias]: [{ status: "failed", failure_reason: "user_already_exists", message: "user_already_exists" }],
    },
  });
  context.db.prepare("UPDATE addresses SET address = ? WHERE kind = 'official'").run(alias);
  const started = await context.service.start(input({ requestId: "mailcom-failure-rotate-001" }));
  const final = await waitFor(() => context.service.get(started.id), (task) => task.terminal, "failure rotation");

  assert.equal(final.status, "completed");
  const official = final.items.find((item) => item.slot_kind === "official");
  assert.equal(official.attempt_count, 2);
  assert.equal(official.failure_count, 1);
  assert.equal(official.registration_success_count, 1);
  assert.equal(official.link_success_count, 1);
  assert.equal(official.recycled_count, 1);
  assert.equal(context.mailcomAliases.recycleCalls.length, 1);
  assert.equal(context.mailcomAliases.recycleCalls[0].address, alias);
  assert.equal(context.mailcomAliases.recycleCalls[0].domain, "mail.com");
  assert.match(context.mailcomAliases.recycleCalls[0].replacementAddress, /^ah[a-z0-9]+@mail\.com$/);
  const history = attempts(context.db, started.id).filter((attempt) => attempt.item_id === official.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].outcome, "unavailable");
  assert.equal(history[0].recycle_status, "succeeded");
  assert.equal(history[1].outcome, "succeeded");
});

test("recycleSucceeded true cannot recycle accounts with successful agreements", async (t) => {
  const context = harness(t);
  const started = await context.service.start(input({
    requestId: "mailcom-infinite-success-001",
    recycleSucceeded: true,
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "successful agreement preservation",
  );
  assert.equal(final.status, "completed");
  assert.equal(final.link_success_count, 2);
  assert.equal(final.agreement_success_count, 2);
  assert.equal(final.recycled_count, 0);
  assert.equal(final.recycle_succeeded, false);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  assert.ok(attempts(context.db, started.id).every((attempt) => (
    attempt.agreement_status === "succeeded" && attempt.recycle_status === "skipped"
  )));
  assert.equal(context.paymentAgreements.contexts.size, 0);
  assert.equal(context.paymentAgreements.releaseCalls.length, context.paymentAgreements.startCalls.length);
  assert.ok(context.paymentAgreements.maxContexts <= 2);
});

test("recycleSucceeded false completes every slot after the first successful agreement", async (t) => {
  const context = harness(t);
  const started = await context.service.start(input({ requestId: "mailcom-no-success-recycle-001" }));
  const final = await waitFor(() => context.service.get(started.id), (task) => task.terminal, "finite pipeline");
  assert.equal(final.status, "completed");
  assert.equal(final.attempt_count, 2);
  assert.equal(final.recycled_count, 0);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  assert.ok(attempts(context.db, started.id).every((attempt) => attempt.recycle_status === "skipped"));
  assert.equal(context.paymentAgreements.contexts.size, 0);
  assert.equal(context.paymentAgreements.releaseCalls.length, 2);
  assert.ok(context.paymentAgreements.releaseCalls.every((call) => (
    call.force === true && call.successful === true
  )));
});

test("runs registration, link extraction, and agreement in order without recycling a live agreement", async (t) => {
  const agreementGate = deferred();
  const alias = "first@email.com";
  const context = harness(t, {
    agreementOptions: {
      outcomes: { [alias]: { status: "running", gate: agreementGate } },
    },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-agreement-order-001",
    concurrency: 1,
    recycleSucceeded: true,
  }));
  const waiting = await waitFor(
    () => attempts(context.db, started.id).find((attempt) => attempt.email === alias),
    (attempt) => Boolean(attempt?.agreement_job_id),
    "official alias agreement wait",
  );

  assert.equal(waiting.registration_status, "succeeded");
  assert.equal(waiting.link_status, "succeeded");
  assert.ok(new Set(["submitting", "running"]).has(waiting.agreement_status));
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  const registrationIndex = context.timeline.indexOf(`registration:sync:${alias}`);
  const linkIndex = context.timeline.indexOf(`link:start:${alias}`);
  const agreementIndex = context.timeline.indexOf(`agreement:start:${alias}`);
  assert.ok(registrationIndex >= 0 && registrationIndex < linkIndex);
  assert.ok(linkIndex < agreementIndex);
  const agreementCall = context.paymentAgreements.startCalls.find((call) => (
    String(call.paypal_url || "").includes(`BA-${waiting.external_account_id}`)
  ));
  assert.ok(agreementCall);
  assert.equal(agreementCall.use_saved_protocol_config, true);

  agreementGate.resolve({ status: "completed" });
  await waitFor(
    () => context.db.prepare(`
      SELECT agreement_status, agreement_finished_at, recycle_status
      FROM mailcom_registration_pipeline_attempts WHERE id = ?
    `).get(waiting.id),
    (attempt) => attempt?.agreement_status === "succeeded" && attempt.recycle_status === "skipped",
    "post-agreement alias preservation",
  );
  const completed = context.db.prepare(`
    SELECT * FROM mailcom_registration_pipeline_attempts WHERE id = ?
  `).get(waiting.id);
  assert.equal(completed.agreement_status, "succeeded");
  assert.ok(completed.agreement_finished_at);
  assert.equal(completed.recycle_status, "skipped");
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "ordered agreement completion",
  );
  assert.equal(final.status, "completed");
  assert.equal(final.items.find((item) => item.slot_kind === "official").current_email, alias);
});

test("GB trial eligibility is checked once per attempt before link extraction", async (t) => {
  const context = harness(t);
  const started = await context.service.start(input({
    requestId: "mailcom-gb-trial-before-link-001",
    paymentLinkCountry: "GB",
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "GB trial-gated pipeline completion",
  );
  const rows = attempts(context.db, started.id);

  assert.equal(final.status, "completed");
  assert.equal(context.registration.trialCalls.length, rows.length);
  assert.equal(context.registration.maxTrialActive <= 2, true);
  assert.ok(context.registration.trialCalls.every((call) => call.country === "GB"));
  assert.ok(rows.every((attempt) => (
    attempt.trial_country === "GB"
      && attempt.trial_status === "eligible"
      && Boolean(attempt.trial_checked_at)
  )));
  for (const attempt of rows) {
    const matchingCalls = context.registration.trialCalls.filter((call) => (
      call.email === attempt.email && call.id === Number(attempt.external_account_id)
    ));
    assert.equal(matchingCalls.length, 1);
    const registrationIndex = context.timeline.indexOf(`registration:sync:${attempt.email}`);
    const trialIndex = context.timeline.indexOf(`trial:check:${attempt.email}:GB`);
    const linkIndex = context.timeline.indexOf(`link:start:${attempt.email}`);
    assert.ok(registrationIndex >= 0 && registrationIndex < trialIndex);
    assert.ok(trialIndex < linkIndex);
  }
});

test("an ineligible official alias skips link and agreement then recycles to an eligible replacement", async (t) => {
  const alias = "no-trial@email.com";
  const context = harness(t, {
    accounts: [{ email: "trial-owner@mail.com", aliases: [alias] }],
    trialOutcomes: {
      [alias]: { status: "ineligible", eligible: false },
    },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-trial-ineligible-recycle-001",
    paymentLinkCountry: "GB",
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "ineligible alias replacement completion",
  );
  const rows = attempts(context.db, started.id);
  const rejected = rows.find((attempt) => attempt.email === alias);
  const replacementEmail = context.mailcomAliases.recycleCalls[0]?.replacementAddress;
  const replacement = rows.find((attempt) => attempt.email === replacementEmail);

  assert.equal(final.status, "completed");
  assert.equal(rows.length, 3);
  assert.ok(rejected);
  assert.equal(rejected.trial_status, "ineligible");
  assert.equal(rejected.outcome, "trial_ineligible");
  assert.equal(rejected.link_status, "skipped");
  assert.equal(rejected.agreement_status, "skipped");
  assert.equal(rejected.recycle_status, "succeeded");
  assert.equal(context.timeline.includes(`link:start:${alias}`), false);
  assert.equal(context.timeline.includes(`agreement:start:${alias}`), false);
  assert.equal(context.mailcomAliases.recycleCalls.length, 1);
  assert.equal(context.mailcomAliases.recycleCalls[0].address, alias);
  assert.match(replacementEmail, /^ah[a-z0-9]+@mail\.com$/);
  assert.ok(replacement);
  assert.equal(replacement.trial_status, "eligible");
  assert.equal(replacement.link_status, "succeeded");
  assert.equal(replacement.agreement_status, "succeeded");
  assert.equal(context.registration.trialCalls.filter((call) => call.email === alias).length, 1);
  assert.equal(context.registration.trialCalls.filter((call) => call.email === replacementEmail).length, 1);
  assert.ok(context.timeline.includes(`link:start:${replacementEmail}`));
  assert.ok(context.timeline.includes(`agreement:start:${replacementEmail}`));
});

test("an ineligible primary address keeps the mother and switches to an official alias", async (t) => {
  const primary = "primary-no-trial@mail.com";
  const context = harness(t, {
    accounts: [{ email: primary, aliases: [] }],
    trialOutcomes: {
      [primary]: { status: "ineligible", eligible: false },
    },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-primary-trial-ineligible-001",
    paymentLinkCountry: "GB",
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "ineligible primary alias replacement",
  );
  const rows = attempts(context.db, started.id);
  const row = rows.find((attempt) => attempt.email === primary);
  const replacement = rows.find((attempt) => attempt.email !== primary);
  const storedPrimary = context.db.prepare(`
    SELECT status FROM addresses WHERE address = ? COLLATE NOCASE AND kind = 'primary'
  `).get(primary);

  assert.equal(final.status, "completed");
  assert.equal(final.attempt_count, 2);
  assert.equal(final.items[0].status, "completed");
  assert.equal(row.outcome, "trial_ineligible");
  assert.equal(row.trial_status, "ineligible");
  assert.equal(row.link_status, "skipped");
  assert.equal(row.agreement_status, "skipped");
  assert.equal(row.recycle_status, "succeeded");
  assert.ok(replacement);
  assert.match(replacement.email, /^ah[a-z0-9]+@mail\.com$/);
  assert.equal(replacement.trial_status, "eligible");
  assert.equal(replacement.link_status, "succeeded");
  assert.equal(replacement.agreement_status, "succeeded");
  assert.equal(storedPrimary.status, "active");
  assert.equal(context.registration.createCalls.length, 2);
  assert.equal(context.registration.trialCalls.length, 2);
  assert.equal(context.paymentLinks.startCalls.length, 1);
  assert.equal(context.paymentAgreements.startCalls.length, 1);
  assert.equal(context.registration.deleteCalls.length, 1);
  assert.deepEqual(context.registration.deleteCalls[0], {
    id: Number(row.external_account_id),
    email: primary,
    registrationJobId: Number(row.registration_job_id),
  });
  assert.equal(context.mailcomAliases.createReplacementCalls.length, 1);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
});

test("a failed trial check retries the same attempt and only links after eligibility", async (t) => {
  const primary = "trial-retry@mail.com";
  const context = harness(t, {
    accounts: [{ email: primary, aliases: [] }],
    trialOutcomes: {
      [primary]: [
        { status: "failed", message: "fixture transient trial failure" },
        { status: "eligible", eligible: true },
      ],
    },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-trial-retry-same-attempt-001",
    paymentLinkCountry: "GB",
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "trial retry completion",
  );
  const rows = attempts(context.db, started.id);

  assert.equal(final.status, "completed");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trial_status, "eligible");
  assert.equal(rows[0].trial_error, "");
  assert.equal(rows[0].link_status, "succeeded");
  assert.equal(rows[0].agreement_status, "succeeded");
  assert.equal(context.registration.createCalls.length, 1);
  assert.equal(context.registration.trialCalls.length, 2);
  assert.equal(context.paymentLinks.startCalls.length, 1);
  assert.equal(context.paymentAgreements.startCalls.length, 1);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  assert.equal(final.items[0].attempt_count, 1);
  assert.equal(final.items[0].retry_count, 1);
  const trialIndexes = context.timeline.reduce((indexes, entry, index) => (
    entry === `trial:check:${primary}:GB` ? [...indexes, index] : indexes
  ), []);
  const linkIndex = context.timeline.indexOf(`link:start:${primary}`);
  assert.equal(trialIndexes.length, 2);
  assert.ok(trialIndexes[0] < trialIndexes[1] && trialIndexes[1] < linkIndex);
});

test("a deterministic trial HTTP 400 stops immediately and preserves the account and mailbox", async (t) => {
  const primary = "trial-deterministic-400@mail.com";
  const error = Object.assign(new Error("英国 0 元 Checkout 创建失败 HTTP 400"), {
    status: 400,
    code: "invalid_request",
  });
  const context = harness(t, {
    accounts: [{ email: primary, aliases: [] }],
    trialOutcomes: {
      [primary]: [{ error, throw: true }],
    },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-trial-deterministic-400",
    paymentLinkCountry: "GB",
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "deterministic trial failure completion",
  );
  const row = attempts(context.db, started.id)[0];

  assert.equal(final.status, "failed");
  assert.equal(row.outcome, "trial_check_failed");
  assert.equal(row.trial_status, "failed");
  assert.equal(row.link_status, "skipped");
  assert.equal(row.recycle_status, "skipped");
  assert.equal(final.items[0].retry_count, 0);
  assert.equal(context.registration.trialCalls.length, 1);
  assert.equal(context.registration.deleteCalls.length, 0);
  assert.equal(context.mailcomAliases.createReplacementCalls.length, 0);
  assert.match(final.items[0].error, /账号池和邮箱均已保留/);
});

test("transient trial failures stop after the configured attempt limit instead of looping forever", async (t) => {
  const primary = "trial-retry-limit@mail.com";
  const failures = Array.from({ length: 3 }, () => ({
    error: Object.assign(new Error("fixture trial service unavailable"), {
      status: 502,
      code: "TRIAL_SERVICE_UNAVAILABLE",
    }),
    throw: true,
  }));
  const context = harness(t, {
    accounts: [{ email: primary, aliases: [] }],
    trialOutcomes: { [primary]: failures },
    serviceOptions: { trialCheckAttemptLimit: 3 },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-trial-retry-limit-001",
    paymentLinkCountry: "GB",
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "bounded trial retry completion",
  );
  const row = attempts(context.db, started.id)[0];

  assert.equal(final.status, "failed");
  assert.equal(row.outcome, "trial_check_failed");
  assert.equal(row.recycle_status, "skipped");
  assert.equal(context.registration.trialCalls.length, 3);
  assert.equal(final.items[0].retry_count, 2);
  assert.equal(context.paymentLinks.startCalls.length, 0);
  assert.equal(context.mailcomAliases.createReplacementCalls.length, 0);
});

test("successful agreements are preserved for every recycleSucceeded input", async (t) => {
  const finite = harness(t);
  const finiteStarted = await finite.service.start(input({ requestId: "mailcom-agreement-finite-001" }));
  const finiteFinal = await waitFor(
    () => finite.service.get(finiteStarted.id),
    (task) => task.terminal,
    "finite agreement completion",
  );
  assert.equal(finiteFinal.status, "completed");
  assert.equal(finiteFinal.agreement_success_count, 2);
  assert.equal(finite.mailcomAliases.recycleCalls.length, 0);
  assert.equal(finite.paymentAgreements.contexts.size, 0);
  assert.ok(attempts(finite.db, finiteStarted.id).every((attempt) => (
    attempt.agreement_status === "succeeded" && attempt.agreement_finished_at
  )));

  const gate = deferred();
  const requestedRecycle = harness(t, {
    accounts: [{ email: "requested@mail.com", aliases: ["requested@email.com"] }],
    agreementOptions: {
      outcomes: { "requested@email.com": { status: "running", gate } },
    },
  });
  const requestedStarted = await requestedRecycle.service.start(input({
    requestId: "mailcom-agreement-infinite-001",
    recycleSucceeded: true,
  }));
  await waitFor(
    () => attempts(requestedRecycle.db, requestedStarted.id)
      .find((attempt) => attempt.email === "requested@email.com"),
    (attempt) => Boolean(attempt?.agreement_job_id),
    "requested-recycle agreement wait",
  );
  assert.equal(requestedRecycle.mailcomAliases.recycleCalls.length, 0);
  gate.resolve({ status: "completed" });
  const requestedFinal = await waitFor(
    () => requestedRecycle.service.get(requestedStarted.id),
    (task) => task.terminal,
    "requested-recycle agreement completion",
  );
  assert.equal(requestedFinal.status, "completed");
  assert.equal(requestedFinal.recycle_succeeded, false);
  assert.equal(requestedFinal.agreement_success_count, 2);
  assert.equal(requestedFinal.recycled_count, 0);
  assert.equal(requestedRecycle.mailcomAliases.recycleCalls.length, 0);
  assert.ok(attempts(requestedRecycle.db, requestedStarted.id).every((attempt) => (
    attempt.agreement_status === "succeeded" && attempt.recycle_status === "skipped"
  )));
});

test("new pipelines do not reuse completed registration jobs from earlier attempts", async (t) => {
  const context = harness(t);
  const alias = context.fixtures[0].aliases[0];
  const historicalExternalId = "20000";
  const historicalAt = "2020-01-01T00:00:00.000Z";
  const historical = context.db.prepare(`
    INSERT INTO registration_jobs (
      account_id, address_id, base_address_id, email, external_task_id, external_account_id,
      status, stage, browser_mode, message, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, 'historical-registration', ?, 'completed', 'completed',
      'headless', '任务结束: succeeded', ?, ?, ?)
  `).run(
    context.fixtures[0].account.id,
    alias.id,
    alias.id,
    alias.address,
    historicalExternalId,
    historicalAt,
    historicalAt,
    historicalAt,
  );
  context.registration.emailByExternalId.set(historicalExternalId, alias.address);

  const started = await context.service.start(input({
    requestId: "mailcom-ignore-historical-completed-registration-001",
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "historical completed registration replacement",
  );
  const rows = attempts(context.db, started.id);
  const rejected = rows.find((attempt) => attempt.email === alias.address);
  assert.ok(rejected);
  const replacement = rows.find((attempt) => (
    attempt.item_id === rejected.item_id && attempt.id !== rejected.id
  ));

  assert.equal(final.status, "completed");
  assert.equal(rejected.registration_job_id, null);
  assert.equal(rejected.external_account_id, "");
  assert.equal(rejected.registration_status, "failed");
  assert.equal(rejected.failure_reason, "already_completed");
  assert.equal(rejected.link_status, "skipped");
  assert.equal(rejected.recycle_status, "succeeded");
  assert.notEqual(rejected.registration_job_id, Number(historical.lastInsertRowid));
  assert.ok(replacement);
  assert.equal(replacement.registration_status, "succeeded");
  assert.equal(replacement.link_status, "succeeded");
  assert.equal(replacement.agreement_status, "succeeded");
  assert.equal(context.registration.createCalls.length, 2);
  assert.equal(context.paymentLinks.startCalls.length, 2);
  assert.equal(context.paymentAgreements.startCalls.length, 2);
  assert.equal(context.timeline.includes(`link:start:${alias.address}`), false);
  assert.equal(context.mailcomAliases.recycleCalls.length, 1);
  assert.equal(context.mailcomAliases.recycleCalls[0].address, alias.address);
});

test("completed registration without an account id uses a canonical unavailable message", (t) => {
  const context = harness(t);
  const address = context.db.prepare(`
    SELECT * FROM addresses WHERE account_id = ? AND kind = 'primary'
  `).get(context.fixtures[0].account.id);
  const at = nowIso();
  context.db.prepare(`
    INSERT INTO registration_jobs (
      account_id, address_id, base_address_id, email, status, stage, browser_mode,
      message, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, 'completed', 'completed', 'headless', '任务结束: succeeded', ?, ?, ?)
  `).run(context.fixtures[0].account.id, address.id, address.id, address.address, at, at, at);

  assert.deepEqual(context.service.unavailableAddressState({
    current_address_id: address.id,
    current_email: address.address,
  }), {
    reason: "already_completed",
    message: "这个 Mail.com 地址已经用于成功注册",
  });
});

test("later pipelines preserve every email that already completed an agreement", async (t) => {
  const context = harness(t);
  const first = await context.service.start(input({ requestId: "mailcom-preserve-history-first-001" }));
  const firstFinal = await waitFor(
    () => context.service.get(first.id),
    (task) => task.terminal,
    "first agreement pipeline",
  );
  assert.equal(firstFinal.status, "completed");
  assert.equal(firstFinal.agreement_success_count, 2);
  assert.equal(context.registration.createCalls.length, 2);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);

  const second = await context.service.start(input({
    requestId: "mailcom-preserve-history-second-001",
    recycleSucceeded: true,
  }));
  const secondFinal = await waitFor(
    () => context.service.get(second.id),
    (task) => task.terminal,
    "historical agreement preservation",
  );
  assert.equal(secondFinal.status, "completed");
  assert.equal(secondFinal.attempt_count, 0);
  assert.equal(secondFinal.recycled_count, 0);
  assert.equal(secondFinal.items.length, 2);
  assert.ok(secondFinal.items.every((item) => (
    item.status === "completed" && item.stage === "agreement_preserved"
  )));
  assert.equal(context.registration.createCalls.length, 2);
  assert.equal(context.paymentLinks.startCalls.length, 2);
  assert.equal(context.paymentAgreements.startCalls.length, 2);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
});

test("historical link-blocked aliases stay protected until the registered account is deleted", async (t) => {
  const alias = "historical-blocked@email.com";
  const context = harness(t, {
    accounts: [{ email: "historical-blocked-owner@mail.com", aliases: [alias] }],
  });
  context.registration.resolveRegisteredAccountTrialRoute = async () => "fixture-trial-route";
  const first = await context.service.start(input({
    requestId: "mailcom-preserve-blocked-first-001",
  }));
  const firstFinal = await waitFor(
    () => context.service.get(first.id),
    (task) => task.terminal,
    "initial blocked preservation fixture",
  );
  assert.equal(firstFinal.status, "completed");
  const firstAttempt = attempts(context.db, first.id).find((attempt) => attempt.email === alias);
  assert.ok(firstAttempt);
  const at = nowIso();
  context.db.prepare(`
    UPDATE mailcom_registration_pipeline_attempts
    SET status = 'failed', stage = 'link_blocked', outcome = 'link_blocked',
      link_status = 'failed', agreement_status = 'skipped', recycle_status = 'skipped',
      error = 'ChatGPT manual approval blocked', failure_reason = 'link_blocked',
      updated_at = ? WHERE id = ?
  `).run(at, firstAttempt.id);

  const callsBefore = {
    registrations: context.registration.createCalls.length,
    deletes: context.registration.deleteCalls.length,
    links: context.paymentLinks.startCalls.length,
    agreements: context.paymentAgreements.startCalls.length,
    recycles: context.mailcomAliases.recycleCalls.length,
  };
  const second = await context.service.start(input({
    requestId: "mailcom-preserve-blocked-second-001",
  }));
  const secondFinal = await waitFor(
    () => context.service.get(second.id),
    (task) => task.terminal,
    "historical blocked preservation",
  );
  const blockedItem = secondFinal.items.find((item) => item.current_email === alias);

  assert.equal(secondFinal.status, "completed");
  assert.equal(secondFinal.attempt_count, 0);
  assert.equal(blockedItem.status, "completed");
  assert.equal(blockedItem.stage, "link_blocked_preserved");
  assert.match(blockedItem.error, /blocked/);
  assert.equal(context.registration.createCalls.length, callsBefore.registrations);
  assert.equal(context.registration.deleteCalls.length, callsBefore.deletes);
  assert.equal(context.paymentLinks.startCalls.length, callsBefore.links);
  assert.equal(context.paymentAgreements.startCalls.length, callsBefore.agreements);
  assert.equal(context.mailcomAliases.recycleCalls.length, callsBefore.recycles);

  const released = context.service.releaseBlockedAccounts([{
    id: Number(firstAttempt.external_account_id),
    email: alias,
  }]);
  assert.deepEqual(released, { released: 1, resumed: 0, pipeline_ids: [] });
  assert.deepEqual(
    context.db.prepare(`
      SELECT stage, external_account_id, outcome, recycle_status
      FROM mailcom_registration_pipeline_attempts WHERE id = ?
    `).get(firstAttempt.id),
    {
      stage: "link_blocked_released",
      external_account_id: "",
      outcome: "link_blocked",
      recycle_status: "skipped",
    },
  );
  assert.deepEqual(
    context.service.releaseBlockedAccounts([{
      id: Number(firstAttempt.external_account_id),
      email: alias,
    }]),
    { released: 0, resumed: 0, pipeline_ids: [] },
  );

  const third = await context.service.start(input({
    requestId: "mailcom-released-blocked-third-001",
  }));
  const thirdFinal = await waitFor(
    () => context.service.get(third.id),
    (task) => task.terminal,
    "released blocked alias replacement",
  );
  assert.equal(thirdFinal.status, "completed");
  assert.equal(context.mailcomAliases.recycleCalls.length, callsBefore.recycles + 1);
  assert.equal(context.mailcomAliases.recycleCalls.at(-1).address, alias);
  assert.equal(
    context.db.prepare("SELECT status FROM addresses WHERE address = ? COLLATE NOCASE").get(alias).status,
    "disabled",
  );
});

test("deleting a blocked account revives its preserved slot while the pipeline is still active", async (t) => {
  const alias = "active-release-blocked@email.com";
  const context = harness(t, {
    accounts: [{ email: "active-release-owner@mail.com", aliases: [alias] }],
  });
  const first = await context.service.start(input({
    requestId: "mailcom-active-release-first-001",
  }));
  await waitFor(
    () => context.service.get(first.id),
    (task) => task.terminal,
    "active release fixture",
  );
  const blockedAttempt = attempts(context.db, first.id).find((attempt) => attempt.email === alias);
  assert.ok(blockedAttempt?.external_account_id);
  context.db.prepare(`
    UPDATE mailcom_registration_pipeline_attempts
    SET status = 'failed', stage = 'link_blocked', outcome = 'link_blocked',
      link_status = 'failed', agreement_status = 'skipped', recycle_status = 'skipped',
      error = 'ChatGPT manual approval blocked', failure_reason = 'link_blocked',
      updated_at = ? WHERE id = ?
  `).run(nowIso(), blockedAttempt.id);

  const prepareGate = deferred();
  const added = addMailcomAccount(context.db, "active-release-waiting@mail.com", []);
  context.fixtures.push(added);
  context.mailcomAliases.prepareGates = [null, null, prepareGate];
  const second = await context.service.start(input({
    requestId: "mailcom-active-release-second-001",
  }));

  try {
    await waitFor(
      () => context.service.get(second.id),
      (task) => task.items.some((item) => item.current_email === alias
        && item.stage === "link_blocked_preserved")
        && task.items.some((item) => item.source_email === added.account.email
          && item.stage === "prepare_running"),
      "active pipeline blocked preservation",
    );
    const released = context.service.releaseBlockedAccounts([{
      id: Number(blockedAttempt.external_account_id),
      email: alias,
    }]);
    assert.equal(released.released, 1);
    assert.equal(released.resumed, 1);
    assert.deepEqual(released.pipeline_ids, [second.id]);
    const revived = context.service.get(second.id).items.find((item) => item.current_email === alias);
    assert.equal(revived.status, "queued");
    assert.equal(revived.stage, "registration_queued");
  } finally {
    prepareGate.resolve();
  }

  const final = await waitFor(
    () => context.service.get(second.id),
    (task) => task.terminal,
    "active released slot completion",
  );
  assert.equal(final.status, "completed");
  assert.equal(context.mailcomAliases.recycleCalls.filter((call) => call.address === alias).length, 1);
  assert.equal(
    context.db.prepare("SELECT status FROM addresses WHERE address = ? COLLATE NOCASE").get(alias).status,
    "disabled",
  );
});

test("agreement success remains permanently protected when the stored attempt status is no longer succeeded", async (t) => {
  const context = harness(t);
  const first = await context.service.start(input({
    requestId: "mailcom-non-success-attempt-protection-first-001",
  }));
  await waitFor(
    () => context.service.get(first.id),
    (task) => task.terminal,
    "initial agreement completion",
  );
  const protectedEmails = attempts(context.db, first.id).map((attempt) => attempt.email);
  assert.equal(protectedEmails.length, 2);
  context.db.prepare(`
    UPDATE mailcom_registration_pipeline_attempts
    SET status = 'cancelled', stage = 'cancelled', outcome = 'cancelled', updated_at = ?
    WHERE pipeline_id = ? AND agreement_status = 'succeeded'
  `).run(nowIso(), first.id);
  assert.ok(attempts(context.db, first.id).every((attempt) => (
    attempt.status === "cancelled" && attempt.agreement_status === "succeeded"
  )));

  const callsBefore = {
    registrations: context.registration.createCalls.length,
    links: context.paymentLinks.startCalls.length,
    agreements: context.paymentAgreements.startCalls.length,
    recycles: context.mailcomAliases.recycleCalls.length,
  };
  const second = await context.service.start(input({
    requestId: "mailcom-non-success-attempt-protection-second-001",
    recycleSucceeded: true,
  }));
  const final = await waitFor(
    () => context.service.get(second.id),
    (task) => task.terminal,
    "non-succeeded attempt agreement preservation",
  );

  assert.equal(final.status, "completed");
  assert.equal(final.attempt_count, 0);
  assert.ok(final.items.every((item) => item.stage === "agreement_preserved"));
  assert.equal(context.registration.createCalls.length, callsBefore.registrations);
  assert.equal(context.paymentLinks.startCalls.length, callsBefore.links);
  assert.equal(context.paymentAgreements.startCalls.length, callsBefore.agreements);
  assert.equal(context.mailcomAliases.recycleCalls.length, callsBefore.recycles);
  const active = context.db.prepare(`
    SELECT address FROM addresses WHERE status = 'active' AND address IN (?, ?)
  `).all(...protectedEmails).map((row) => row.address.toLowerCase());
  assert.deepEqual(new Set(active), new Set(protectedEmails.map((email) => email.toLowerCase())));
});

test("agreement failure preserves an eligible official alias without recycling", async (t) => {
  const primary = "owner@mail.com";
  const alias = "first@email.com";
  const context = harness(t, {
    agreementOptions: {
      outcomes: {
        [alias]: { status: "failed", error: "fixture alias agreement failure" },
      },
    },
  });
  const started = await context.service.start(input({ requestId: "mailcom-agreement-failure-001" }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "eligible agreement failure preservation",
  );
  const rows = attempts(context.db, started.id);
  const primaryAttempt = rows.find((attempt) => attempt.email === primary);
  const failedAlias = rows.find((attempt) => attempt.email === alias);
  const storedAlias = context.db.prepare("SELECT status FROM addresses WHERE address = ? COLLATE NOCASE")
    .get(alias);

  assert.equal(final.status, "partial_failed");
  assert.equal(final.attempt_count, 2);
  assert.equal(final.registration_success_count, 2);
  assert.equal(final.phase_progress.registration.succeeded, 2);
  assert.equal(final.phase_progress.registration.failed, 0);
  assert.equal(final.link_success_count, 2);
  assert.equal(final.agreement_success_count, 1);
  assert.equal(final.agreement_failure_count, 1);
  assert.equal(final.failure_count, 1);
  assert.equal(primaryAttempt.status, "succeeded");
  assert.equal(primaryAttempt.agreement_status, "succeeded");
  assert.equal(failedAlias.trial_status, "eligible");
  assert.equal(failedAlias.outcome, "agreement_failed");
  assert.equal(failedAlias.link_status, "succeeded");
  assert.equal(failedAlias.agreement_status, "failed");
  assert.match(failedAlias.agreement_error, /alias agreement failure/);
  assert.equal(failedAlias.recycle_status, "skipped");
  assert.equal(storedAlias.status, "active");
  assert.equal(context.registration.deleteCalls.length, 0);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  assert.equal(rows.filter((attempt) => attempt.agreement_status === "succeeded").length, 1);
  assert.equal(context.paymentAgreements.contexts.size, 0);
  assert.equal(context.paymentAgreements.releaseCalls.length, 2);
  assert.equal(context.paymentAgreements.releaseCalls.filter((call) => call.successful === false).length, 1);
  assert.equal(context.paymentAgreements.releaseCalls.filter((call) => call.successful === true).length, 1);
});

test("runtime agreement dependency loss retries the same attempt without registration, link, or recycle churn", async (t) => {
  const context = harness(t, {
    accounts: [{ email: "runtime@mail.com", aliases: [] }],
  });
  context.paymentLinks.afterStart = () => context.paymentAgreements.setRuntimeReady(false);
  const started = await context.service.start(input({ requestId: "mailcom-agreement-runtime-retry-001" }));
  const waiting = await waitFor(
    () => attempts(context.db, started.id)[0],
    (attempt) => attempt?.stage === "agreement_runtime_retry_wait",
    "agreement runtime retry",
  );
  assert.equal(waiting.link_status, "succeeded");
  assert.equal(context.registration.createCalls.length, 1);
  assert.equal(context.paymentLinks.startCalls.length, 1);
  assert.equal(context.paymentAgreements.startCalls.length, 0);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);

  context.paymentLinks.afterStart = null;
  context.paymentAgreements.setRuntimeReady(true);
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "agreement runtime recovery",
  );
  const recovered = attempts(context.db, started.id);
  assert.equal(final.status, "completed");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, waiting.id);
  assert.equal(recovered[0].agreement_status, "succeeded");
  assert.equal(context.registration.createCalls.length, 1);
  assert.equal(context.paymentLinks.startCalls.length, 1);
  assert.equal(context.paymentAgreements.startCalls.length, 1);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
});

test("an uncertain agreement submission is never repeated and preserves every current alias", async (t) => {
  const context = harness(t);
  context.paymentAgreements.start = async (agreementInput) => {
    context.paymentAgreements.startCalls.push(structuredClone(agreementInput));
    throw Object.assign(new Error("fixture protocol POST timed out after submission"), {
      status: 504,
      code: "PAYMENT_AGREEMENT_TIMEOUT",
      protocolSubmissionStarted: true,
    });
  };

  const started = await context.service.start(input({
    requestId: "mailcom-agreement-submit-unknown-001",
    recycleSucceeded: true,
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "uncertain agreement submission",
  );
  const rows = attempts(context.db, started.id);
  assert.equal(final.status, "failed");
  assert.equal(context.paymentAgreements.startCalls.length, 2);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  assert.ok(rows.every((attempt) => (
    attempt.link_status === "succeeded"
      && attempt.agreement_status === "uncertain"
      && attempt.recycle_status === "skipped"
  )));
  assert.equal(context.paymentAgreements.contexts.size, 0);
  assert.equal(context.paymentAgreements.releaseCalls.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(context.paymentAgreements.startCalls.length, 2);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
});

test("a stopped agreement tracker becomes uncertain and force-releases its retained context", async (t) => {
  const email = "uncertain-context@mail.com";
  const context = harness(t, {
    accounts: [{ email, aliases: [] }],
    agreementOptions: {
      outcomes: { [email]: { status: "running" } },
    },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-agreement-context-release-001",
    recycleSucceeded: true,
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "uncertain agreement context release",
  );
  const attempt = attempts(context.db, started.id)[0];

  assert.equal(final.status, "failed");
  assert.equal(attempt.agreement_status, "uncertain");
  assert.equal(attempt.recycle_status, "skipped");
  assert.equal(context.paymentAgreements.contexts.size, 0);
  assert.deepEqual(context.paymentAgreements.releaseCalls, [{
    jobId: attempt.agreement_job_id,
    force: true,
    successful: false,
  }]);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
});

for (const scenario of [
  { stage: "agreement_submitting", agreementStatus: "running", jobId: "" },
  { stage: "agreement_wait", agreementStatus: "running", jobId: "lost-agreement-job" },
]) {
  test(`restart from ${scenario.stage} never submits or recycles after agreement context loss`, async (t) => {
    const context = harness(t);
    context.paymentLinks.afterStart = () => context.paymentAgreements.setRuntimeReady(false);
    const started = await context.service.start(input({
      requestId: `mailcom-${scenario.stage}-lost-001`,
    }));
    const waiting = await waitFor(
      () => attempts(context.db, started.id),
      (rows) => rows.length === 2 && rows.every((attempt) => attempt.stage === "agreement_runtime_retry_wait"),
      `${scenario.stage} seed attempts`,
    );
    await context.service.close();

    const at = nowIso();
    const primaryAttempt = waiting.find((attempt) => attempt.email === "owner@mail.com");
    const officialAttempt = waiting.find((attempt) => attempt.email === "first@email.com");
    context.db.transaction(() => {
      context.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET status = 'succeeded', stage = 'succeeded', outcome = 'succeeded',
          agreement_status = 'succeeded', agreement_error = '', agreement_finished_at = ?,
          recycle_status = 'skipped', next_retry_at = NULL, finished_at = ?, updated_at = ?
        WHERE id = ?
      `).run(at, at, at, primaryAttempt.id);
      context.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET status = 'completed', stage = 'completed', next_retry_at = NULL,
          error = '', finished_at = ?, updated_at = ? WHERE id = ?
      `).run(at, at, primaryAttempt.item_id);
      context.db.prepare(`
        UPDATE mailcom_registration_pipeline_attempts
        SET status = 'running', stage = ?, outcome = '', agreement_job_id = ?,
          agreement_status = ?, agreement_error = '', agreement_finished_at = NULL,
          recycle_status = 'pending', next_retry_at = NULL, finished_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(scenario.stage, scenario.jobId, scenario.agreementStatus, at, officialAttempt.id);
      context.db.prepare(`
        UPDATE mailcom_registration_pipeline_items
        SET status = 'running', stage = ?, next_retry_at = NULL,
          error = '', finished_at = NULL, updated_at = ? WHERE id = ?
      `).run(scenario.stage, at, officialAttempt.item_id);
    })();

    const recoveredAgreements = new FakePaymentAgreements(context.registration, context.timeline);
    const recovered = new MailcomRegistrationPipelineService({
      db: context.db,
      registration: context.registration,
      paymentLinks: context.paymentLinks,
      paymentAgreements: recoveredAgreements,
      mailcomAliases: context.mailcomAliases,
      pollIntervalMs: 20,
      retryBaseMs: 20,
      retryMaximumMs: 40,
      sleepFn: () => new Promise((resolve) => setTimeout(resolve, 1)),
    });
    try {
      const lost = await waitFor(
        () => context.db.prepare(`
          SELECT * FROM mailcom_registration_pipeline_attempts WHERE id = ?
        `).get(officialAttempt.id),
        (attempt) => /context|上下文|丢失/i.test(`${attempt?.agreement_error || ""} ${attempt?.error || ""}`),
        `${scenario.stage} context-loss result`,
      );
      assert.equal(lost.link_status, "succeeded");
      assert.equal(lost.agreement_status, "uncertain");
      assert.equal(lost.recycle_status, "skipped");
      assert.equal(recoveredAgreements.startCalls.length, 0);
      assert.equal(context.mailcomAliases.recycleCalls.length, 0);
    } finally {
      await recovered.close();
    }
  });
}

test("cancelling an in-flight agreement cancels its job and never recycles the alias", async (t) => {
  const gate = deferred();
  const context = harness(t, {
    accounts: [{ email: "cancel-agreement@mail.com", aliases: [] }],
    agreementOptions: {
      outcomes: { "cancel-agreement@mail.com": { status: "running", gate } },
    },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-agreement-cancel-001",
    recycleSucceeded: true,
  }));
  const running = await waitFor(
    () => attempts(context.db, started.id)[0],
    (attempt) => Boolean(attempt?.agreement_job_id),
    "in-flight agreement",
  );
  const cancelled = await context.service.cancel(started.id);
  const stored = context.db.prepare(`
    SELECT * FROM mailcom_registration_pipeline_attempts WHERE id = ?
  `).get(running.id);

  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(context.paymentAgreements.cancelCalls, [running.agreement_job_id]);
  assert.equal(stored.link_status, "succeeded");
  assert.equal(stored.agreement_status, "cancelled");
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  assert.equal(context.paymentAgreements.contexts.size, 0);
  assert.deepEqual(context.paymentAgreements.releaseCalls, [{
    jobId: running.agreement_job_id,
    force: true,
    successful: false,
  }]);
  gate.resolve({ status: "cancelled", error: "fixture agreement cancelled" });
});

test("agreement success committed during cancellation is not overwritten by the cancelling writer", async (t) => {
  const agreementGate = deferred();
  const cancelEntered = deferred();
  const releaseCancel = deferred();
  const email = "cancel-success-race@mail.com";
  const context = harness(t, {
    accounts: [{ email, aliases: [] }],
    agreementOptions: {
      outcomes: { [email]: { status: "running", gate: agreementGate } },
    },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-agreement-success-cancel-race-001",
    recycleSucceeded: true,
  }));
  const running = await waitFor(
    () => attempts(context.db, started.id)[0],
    (attempt) => Boolean(attempt?.agreement_job_id),
    "agreement cancellation race setup",
  );
  context.paymentAgreements.cancelJob = async (jobId) => {
    context.paymentAgreements.cancelCalls.push(String(jobId));
    cancelEntered.resolve();
    await releaseCancel.promise;
    return { id: String(jobId), status: "cancelled" };
  };

  const cancelling = context.service.cancel(started.id);
  await cancelEntered.promise;
  const succeeded = context.service.finishAttempt(running.id, "succeeded", "succeeded", "", {
    failureReason: "",
    registrationStatus: "succeeded",
    linkStatus: "succeeded",
    agreementStatus: "succeeded",
  });
  assert.equal(succeeded.status, "succeeded");
  assert.equal(succeeded.agreement_status, "succeeded");
  releaseCancel.resolve();

  const cancelled = await cancelling;
  const stored = context.db.prepare(`
    SELECT * FROM mailcom_registration_pipeline_attempts WHERE id = ?
  `).get(running.id);
  const address = context.db.prepare("SELECT * FROM addresses WHERE id = ?").get(stored.address_id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(stored.status, "succeeded");
  assert.equal(stored.agreement_status, "succeeded");
  assert.notEqual(stored.recycle_status, "succeeded");
  assert.equal(address.status, "active");
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  agreementGate.resolve({ status: "completed" });
});

test("cancelling while agreement submission is in flight releases the context returned after cancellation", async (t) => {
  const submitGate = deferred();
  const email = "cancel-submitting@mail.com";
  const context = harness(t, {
    accounts: [{ email, aliases: [] }],
    agreementOptions: {
      outcomes: { [email]: { status: "running", submitGate } },
    },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-agreement-submitting-cancel-001",
    recycleSucceeded: true,
  }));
  const submitting = await waitFor(
    () => attempts(context.db, started.id)[0],
    (attempt) => attempt?.stage === "agreement_submitting"
      && context.paymentAgreements.startCalls.length === 1,
    "agreement submission race",
  );
  const cancelled = await context.service.cancel(started.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(context.paymentAgreements.contexts.size, 0);
  assert.equal(context.paymentAgreements.cancelCalls.length, 0);

  submitGate.resolve();
  await waitFor(
    () => context.paymentAgreements.releaseCalls.length,
    (count) => count === 1,
    "late agreement context release",
  );
  const stored = context.db.prepare(`
    SELECT * FROM mailcom_registration_pipeline_attempts WHERE id = ?
  `).get(submitting.id);
  assert.ok(stored.agreement_job_id);
  assert.deepEqual(context.paymentAgreements.cancelCalls, [stored.agreement_job_id]);
  assert.deepEqual(context.paymentAgreements.releaseCalls, [{
    jobId: stored.agreement_job_id,
    force: true,
    successful: false,
  }]);
  assert.equal(context.paymentAgreements.contexts.size, 0);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
});

test("successfulAccounts paginates link successes, isolates pipelines, and returns only public fields", async (t) => {
  const context = harness(t);
  const first = await context.service.start(input({ requestId: "mailcom-success-accounts-first-001" }));
  await waitFor(() => context.service.get(first.id), (task) => task.terminal, "first success account pipeline");
  const firstRows = attempts(context.db, first.id).filter((attempt) => attempt.link_status === "succeeded");
  assert.equal(firstRows.length, 2);

  const proxySecret = "pipeline-proxy-password-must-not-leak";
  const messageSecret = "pipeline-account-password-must-not-leak";
  const providerSecret = "BA-PIPELINESECRETTOKEN123";
  context.db.prepare(`
    UPDATE registration_jobs SET proxy_label = ?, message = ? WHERE id = ?
  `).run(
    `http://fixture:${proxySecret}@proxy.example:8080`,
    `password=${messageSecret}`,
    firstRows[0].registration_job_id,
  );
  context.db.prepare(`
    INSERT INTO registered_account_payment_links (
      external_account_id, email, task_id, status, stage, provider_url, created_at, updated_at
    ) VALUES (?, ?, ?, 'succeeded', 'succeeded', ?, ?, ?)
    ON CONFLICT(external_account_id) DO UPDATE SET provider_url = excluded.provider_url, updated_at = excluded.updated_at
  `).run(
    String(firstRows[0].external_account_id),
    firstRows[0].email,
    firstRows[0].payment_link_task_id,
    `https://www.paypal.com/agreements/approve?ba_token=${providerSecret}`,
    nowIso(),
    nowIso(),
  );
  const phoneSecret = "+447700900123";
  const activationSecret = "hero-activation-secret-123";
  const passwordSecret = "agreement-password-secret";
  const authorizationSecret = "agreement-bearer-secret";
  const jsonActivationSecret = "json-activation-secret";
  const jsonPasswordSecret = "json-password-secret";
  const basicAuthorizationSecret = "dXNlcjpwYXNz";
  const cookieTailSecret = "csrf-cookie-secret";
  const escapedJsonSecret = "escaped-json-secret";
  const genericTokenSecret = "generic-token-secret";
  const privateKeySecret = "private-key-secret";
  context.db.prepare(`
    UPDATE mailcom_registration_pipeline_attempts SET agreement_error = ? WHERE id = ?
  `).run(
    `provider ${providerSecret}; phone ${phoneSecret}; activationId=${activationSecret}; password=${passwordSecret}; authorization=Bearer ${authorizationSecret}; json={"activationId":"${jsonActivationSecret}","password":"${jsonPasswordSecret}"}; basic={"authorization":"Basic ${basicAuthorizationSecret}"}; cookie={"cookie":"sid=abc; csrf=${cookieTailSecret}"}; escaped={\\"password\\":\\"${escapedJsonSecret}\\"}`,
    firstRows[0].id,
  );
  const hugeExternalAccountId = "900719925474099312345";
  context.db.prepare(`
    UPDATE mailcom_registration_pipeline_attempts SET external_account_id = ? WHERE id = ?
  `).run(hugeExternalAccountId, firstRows[1].id);

  addMailcomAccount(context.db, "second@mail.com", ["second@email.com"]);
  const second = await context.service.start(input({
    requestId: "mailcom-success-accounts-second-001",
  }));
  await waitFor(() => context.service.get(second.id), (task) => task.terminal, "second success account pipeline");

  const firstPage = await context.service.successfulAccounts(first.id, { limit: 1 });
  const nextPage = await context.service.successfulAccounts(first.id, {
    limit: 1,
    before_id: firstPage.next_cursor,
  });
  const secondPage = await context.service.successfulAccounts(second.id, { limit: 20, offset: 0 });
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.limit, 1);
  assert.equal(firstPage.offset, 0);
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.has_more, true);
  assert.match(firstPage.next_cursor, /^\d+$/);
  assert.equal(nextPage.total, 2);
  assert.equal(nextPage.items.length, 1);
  assert.equal(nextPage.before_id, firstPage.next_cursor);
  assert.equal(nextPage.has_more, false);
  assert.equal(nextPage.next_cursor, "");
  const firstIds = new Set([...firstPage.items, ...nextPage.items].map((item) => String(item.external_account_id)));
  const secondIds = new Set(secondPage.items.map((item) => String(item.external_account_id)));
  assert.equal(firstIds.size, 2);
  assert.ok([...firstIds].every((id) => !secondIds.has(id)));
  assert.ok([...firstPage.items, ...nextPage.items].every((item) => (
    item.email && item.external_account_id && Object.hasOwn(item, "agreement_status")
  )));
  const hugeAccount = [...firstPage.items, ...nextPage.items]
    .find((item) => item.external_account_id === hugeExternalAccountId);
  assert.ok(hugeAccount);
  assert.equal(typeof hugeAccount.external_account_id, "string");
  assert.equal(hugeAccount.payment_link_country, "GB");

  const publicAccountFields = [
    "agreement_country", "agreement_error", "agreement_finished_at", "agreement_job_id",
    "agreement_started_at", "agreement_status", "cycle", "email",
    "external_account_id", "id", "link_finished_at", "payment_link_country", "registration_finished_at",
    "slot_kind", "source_email", "stage", "status",
  ].sort();
  for (const item of [...firstPage.items, ...nextPage.items]) {
    assert.deepEqual(Object.keys(item).sort(), publicAccountFields);
  }

  const serialized = JSON.stringify([firstPage, nextPage]);
  assert.doesNotMatch(serialized, new RegExp(proxySecret));
  assert.doesNotMatch(serialized, new RegExp(messageSecret));
  assert.doesNotMatch(serialized, new RegExp(providerSecret));
  assert.doesNotMatch(serialized, new RegExp(phoneSecret.replace(/[+]/g, "\\+")));
  assert.doesNotMatch(serialized, new RegExp(activationSecret));
  assert.doesNotMatch(serialized, new RegExp(passwordSecret));
  assert.doesNotMatch(serialized, new RegExp(authorizationSecret));
  assert.doesNotMatch(serialized, new RegExp(jsonActivationSecret));
  assert.doesNotMatch(serialized, new RegExp(jsonPasswordSecret));
  assert.doesNotMatch(serialized, new RegExp(basicAuthorizationSecret));
  assert.doesNotMatch(serialized, new RegExp(cookieTailSecret));
  assert.doesNotMatch(serialized, new RegExp(escapedJsonSecret));
  assert.match(serialized, /REDACTED_BA_TOKEN/);
  assert.match(serialized, /REDACTED_NUMBER/);
  for (const [rawError, secret] of [
    [`{"authorization":"Basic ${basicAuthorizationSecret}"}`, basicAuthorizationSecret],
    [`{"cookie":"sid=abc; csrf=${cookieTailSecret}"}`, cookieTailSecret],
    [`cookie=sid=abc; csrf=${cookieTailSecret}\nupstream failed`, cookieTailSecret],
    [`{\\"password\\":\\"${escapedJsonSecret}\\"}`, escapedJsonSecret],
    [`token=${genericTokenSecret}`, genericTokenSecret],
    [`private_key=${privateKeySecret}`, privateKeySecret],
  ]) {
    context.db.prepare(`
      UPDATE mailcom_registration_pipeline_attempts SET agreement_error = ? WHERE id = ?
    `).run(rawError, firstRows[0].id);
    const response = context.service.successfulAccounts(first.id, { limit: 100 });
    assert.doesNotMatch(JSON.stringify(response), new RegExp(secret));
  }
  for (const item of [...firstPage.items, ...nextPage.items]) {
    for (const forbidden of [
      "password", "access_token", "refresh_token", "provider_url", "payment_link_url",
      "proxy", "proxy_label", "cookie", "device_id", "phone", "api_key",
    ]) {
      assert.equal(Object.hasOwn(item, forbidden), false, `successful account leaked ${forbidden}`);
    }
  }
});

test("successfulAccounts cursor remains stable while new successes are inserted", async (t) => {
  const context = harness(t);
  const started = await context.service.start(input({ requestId: "mailcom-success-cursor-stable-001" }));
  await waitFor(() => context.service.get(started.id), (task) => task.terminal, "cursor fixture pipeline");

  const firstPage = context.service.successfulAccounts(started.id, { limit: 1 });
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.has_more, true);
  const base = attempts(context.db, started.id)[0];
  const inserted = context.db.prepare(`
    INSERT INTO mailcom_registration_pipeline_attempts (
      pipeline_id, item_id, attempt_number, email, external_account_id,
      status, stage, registration_status, link_status, agreement_status,
      created_at, updated_at
    ) VALUES (?, ?, 999, ?, ?, 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', ?, ?)
  `).run(
    started.id,
    base.item_id,
    "late-success@email.com",
    "late-success-account",
    nowIso(),
    nowIso(),
  );

  const continuation = context.service.successfulAccounts(started.id, {
    limit: 1,
    before_id: firstPage.next_cursor,
  });
  const refreshed = context.service.successfulAccounts(started.id, { limit: 1 });
  assert.equal(continuation.total, 3);
  assert.equal(continuation.items.length, 1);
  assert.ok(Number(continuation.items[0].id) < Number(firstPage.next_cursor));
  assert.notEqual(continuation.items[0].id, firstPage.items[0].id);
  assert.equal(refreshed.items[0].id, Number(inserted.lastInsertRowid));
});

test("request id is idempotent and only one pipeline may be globally active", async (t) => {
  const context = harness(t);
  const request = input({ requestId: "mailcom-idempotent-active-001", recycleSucceeded: true });
  const first = await context.service.start(request);
  const second = await context.service.start(request);
  assert.equal(second.id, first.id);
  await assert.rejects(
    context.service.start({ ...request, domain: "email.com" }),
    (error) => error.code === "MAILCOM_PIPELINE_IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    context.service.start({ ...request, requestId: "mailcom-other-active-001" }),
    (error) => error.code === "MAILCOM_PIPELINE_ACTIVE",
  );
  await context.service.cancel(first.id);
});

test("registration concurrency accepts twenty and rejects values above the worker limit", async (t) => {
  const context = harness(t, {
    accounts: [{ email: "concurrency-limit@mail.com", aliases: [] }],
  });
  await assert.rejects(
    context.service.start(input({
      requestId: "mailcom-concurrency-limit-invalid-001",
      concurrency: 21,
    })),
    (error) => error.code === "MAILCOM_PIPELINE_INVALID" && /1.*20/.test(error.message),
  );

  const started = await context.service.start(input({
    requestId: "mailcom-concurrency-limit-valid-001",
    concurrency: 20,
  }));
  assert.equal(started.concurrency, 20);
  assert.equal(context.db.prepare(`
    SELECT concurrency FROM mailcom_registration_pipelines WHERE id = ?
  `).get(started.id).concurrency, 20);
  await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "twenty-worker concurrency pipeline",
  );
});

test("new pipelines reject countries without an independent zero-trial precheck", async (t) => {
  const context = harness(t, {
    accounts: [{ email: "unsupported-trial-country@mail.com", aliases: [] }],
  });
  for (const [index, paymentLinkCountry] of ["DE", "TR", "BR", "TH"].entries()) {
    await assert.rejects(
      context.service.start(input({
        requestId: `mailcom-trial-country-invalid-${index}`,
        paymentLinkCountry,
      })),
      (error) => error.code === "MAILCOM_PIPELINE_INVALID"
        && /JP、GB 或 US/.test(error.message),
    );
  }
  assert.equal(context.db.prepare(`
    SELECT COUNT(*) AS count FROM mailcom_registration_pipelines
  `).get().count, 0);
});

test("link attempt limit defaults to three and accepts only integers from one through ten", async (t) => {
  const context = harness(t, {
    accounts: [{ email: "link-limit@mail.com", aliases: [] }],
  });
  for (const [index, linkAttempts] of [0, 11, -1, 1.5, "many"].entries()) {
    await assert.rejects(
      context.service.start(input({
        requestId: `mailcom-link-limit-invalid-${index}`,
        linkAttempts,
      })),
      (error) => error.code === "MAILCOM_PIPELINE_INVALID"
        && /1.*10/.test(error.message),
    );
  }
  assert.equal(context.db.prepare(`
    SELECT COUNT(*) AS count FROM mailcom_registration_pipelines
  `).get().count, 0);

  const minimum = await context.service.start(input({
    requestId: "mailcom-link-limit-minimum-001",
    linkAttempts: 1,
  }));
  assert.equal(minimum.link_attempts, 1);
  await waitFor(
    () => context.service.get(minimum.id),
    (task) => task.terminal,
    "minimum link-attempt pipeline",
  );

  const maximum = await context.service.start(input({
    requestId: "mailcom-link-limit-maximum-001",
    linkAttempts: 10,
  }));
  assert.equal(maximum.link_attempts, 10);
  assert.equal(context.db.prepare(`
    SELECT link_attempts FROM mailcom_registration_pipelines WHERE id = ?
  `).get(maximum.id).link_attempts, 10);
  await assert.rejects(
    context.service.start(input({
      requestId: "mailcom-link-limit-maximum-001",
      linkAttempts: 9,
    })),
    (error) => error.code === "MAILCOM_PIPELINE_IDEMPOTENCY_CONFLICT",
  );
});

test("default link-attempt limit retries one registered account three times without recycling", async (t) => {
  const email = "default-link-retries@mail.com";
  const context = harness(t, {
    accounts: [{ email, aliases: [] }],
    paymentOutcomes: { [email]: ["failed", "failed", "succeeded"] },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-default-link-retries-001",
  }));
  assert.equal(started.link_attempts, 3);

  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "default link retries",
  );
  const history = attempts(context.db, started.id);
  assert.equal(final.status, "completed");
  assert.equal(final.link_attempts, 3);
  assert.equal(history.length, 1);
  assert.equal(history[0].registration_status, "succeeded");
  assert.equal(history[0].link_status, "succeeded");
  assert.equal(history[0].link_attempt_count, 3);
  assert.equal(context.timeline.filter((event) => event === `link:start:${email}`).length, 3);
  assert.equal(context.db.prepare(`
    SELECT COUNT(*) AS count FROM registration_jobs WHERE email = ? COLLATE NOCASE
  `).get(email).count, 1);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
});

test("configured link attempts are exhausted on the same account before an official alias rotates", async (t) => {
  const alias = "configured-link-retries@email.com";
  const linkAttempts = 4;
  const context = harness(t, {
    accounts: [{ email: "configured-link-owner@mail.com", aliases: [alias] }],
    paymentOutcomes: { [alias]: Array.from({ length: linkAttempts }, () => "failed") },
  });
  const recycleAlias = context.mailcomAliases.recycleAlias.bind(context.mailcomAliases);
  context.mailcomAliases.recycleAlias = async (accountId, options) => {
    if (options.address === alias) {
      assert.equal(
        context.timeline.filter((event) => event === `link:start:${alias}`).length,
        linkAttempts,
      );
      assert.equal(context.db.prepare(`
        SELECT COUNT(*) AS count FROM registration_jobs WHERE email = ? COLLATE NOCASE
      `).get(alias).count, 1);
    }
    return recycleAlias(accountId, options);
  };

  const started = await context.service.start(input({
    requestId: "mailcom-configured-link-retries-001",
    linkAttempts,
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "configured link retries before rotation",
  );
  const official = final.items.find((item) => item.slot_kind === "official");
  const history = attempts(context.db, started.id).filter((attempt) => attempt.item_id === official.id);
  assert.equal(final.status, "completed");
  assert.equal(final.link_attempts, linkAttempts);
  assert.equal(history.length, 2);
  assert.equal(history[0].email, alias);
  assert.equal(history[0].registration_status, "succeeded");
  assert.equal(history[0].link_status, "failed");
  assert.equal(history[0].link_attempt_count, linkAttempts);
  assert.equal(history[0].recycle_status, "succeeded");
  assert.equal(history[1].link_status, "succeeded");
  assert.equal(history[1].link_attempt_count, 1);
  assert.equal(context.timeline.filter((event) => event === `link:start:${alias}`).length, linkAttempts);
  assert.equal(context.db.prepare(`
    SELECT COUNT(*) AS count FROM registration_jobs WHERE email = ? COLLATE NOCASE
  `).get(alias).count, 1);
  assert.equal(context.mailcomAliases.recycleCalls.length, 1);
  assert.equal(context.mailcomAliases.recycleCalls[0].address, alias);
});

test("a Plus account discovered before link failure keeps both the account-pool record and official alias", async (t) => {
  const alias = "plus-link-failure@email.com";
  const context = harness(t, {
    accounts: [{ email: "plus-link-owner@mail.com", aliases: [alias] }],
    paymentOutcomes: { [alias]: ["failed"] },
  });
  context.paymentLinks.afterStart = (row) => {
    if (row.email !== alias) return;
    const at = nowIso();
    context.db.prepare(`
      INSERT INTO registered_account_status_checks (
        external_account_id, email, detection_status, subscription_status,
        account_type, checked_at, created_at, updated_at
      ) VALUES (?, ?, 'completed', 'active', 'plus', ?, ?, ?)
    `).run(row.external_account_id, row.email, at, at, at);
  };

  const started = await context.service.start(input({
    requestId: "mailcom-plus-link-failure-001",
    linkAttempts: 1,
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "Plus link failure preservation",
  );
  const plusAttempt = attempts(context.db, started.id)
    .find((attempt) => attempt.email === alias);
  const plusItem = final.items.find((item) => item.current_email === alias);

  assert.equal(final.status, "partial_failed");
  assert.ok(plusAttempt?.external_account_id);
  assert.equal(plusAttempt.outcome, "link_failed");
  assert.equal(plusAttempt.link_status, "failed");
  assert.equal(plusAttempt.recycle_status, "skipped");
  assert.equal(plusItem.status, "failed");
  assert.match(plusItem.error, /fixture link failure/);
  assert.equal(context.registration.deleteCalls.length, 0);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  assert.equal(context.mailcomAliases.createReplacementCalls.length, 0);
  assert.equal(
    context.db.prepare("SELECT status FROM addresses WHERE address = ? COLLATE NOCASE")
      .get(alias).status,
    "active",
  );
});

test("a successful payment link stops the configured retries immediately", async (t) => {
  const email = "early-link-success@mail.com";
  const context = harness(t, {
    accounts: [{ email, aliases: [] }],
    paymentOutcomes: { [email]: ["failed", "succeeded", "failed"] },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-early-link-success-001",
    linkAttempts: 8,
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "early link success",
  );
  const history = attempts(context.db, started.id);
  assert.equal(final.status, "completed");
  assert.equal(final.link_attempts, 8);
  assert.equal(history.length, 1);
  assert.equal(history[0].link_status, "succeeded");
  assert.equal(history[0].link_attempt_count, 2);
  assert.equal(history[0].agreement_status, "succeeded");
  assert.equal(context.timeline.filter((event) => event === `link:start:${email}`).length, 2);
  assert.equal(context.registration.createCalls.length, 1);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
});

test("service restart preserves the persisted payment-link attempt count", async (t) => {
  const email = "restart-link-retries@mail.com";
  const context = harness(t, {
    accounts: [{ email, aliases: [] }],
    paymentOutcomes: { [email]: ["running", "failed", "succeeded"] },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-restart-link-retries-001",
    linkAttempts: 3,
  }));
  const waiting = await waitFor(
    () => attempts(context.db, started.id)[0],
    (attempt) => attempt?.link_status === "running"
      && attempt.link_attempt_count === 1
      && Boolean(attempt.payment_link_task_id),
    "first persisted link attempt",
  );
  assert.equal(context.timeline.filter((event) => event === `link:start:${email}`).length, 1);
  assert.equal(context.registration.createCalls.length, 1);

  await context.service.close();
  context.paymentLinks.persistTracked(waiting.external_account_id, waiting.payment_link_task_id, {
    status: "failed",
    stage: "failed",
    error: "fixture failure observed after restart",
  });
  const recovered = new MailcomRegistrationPipelineService({
    db: context.db,
    registration: context.registration,
    paymentLinks: context.paymentLinks,
    paymentAgreements: context.paymentAgreements,
    mailcomAliases: context.mailcomAliases,
    pollIntervalMs: 20,
    retryBaseMs: 20,
    retryMaximumMs: 40,
    sleepFn: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  t.after(() => recovered.close());
  const final = await waitFor(
    () => recovered.get(started.id),
    (task) => task.terminal,
    "restarted link retries",
  );
  const history = attempts(context.db, started.id);
  assert.equal(final.status, "completed");
  assert.equal(final.link_attempts, 3);
  assert.equal(history.length, 1);
  assert.equal(history[0].link_status, "succeeded");
  assert.equal(history[0].link_attempt_count, 3);
  assert.equal(context.timeline.filter((event) => event === `link:start:${email}`).length, 3);
  assert.equal(context.registration.createCalls.length, 1);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
});

test("payment-link failure remains in attempt history after alias replacement", async (t) => {
  const alias = "link-failure@email.com";
  const context = harness(t, {
    accounts: [{ email: "owner@mail.com", aliases: [alias] }],
    paymentOutcomes: { [alias]: ["failed"] },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-link-history-001",
    linkAttempts: 1,
  }));
  const final = await waitFor(() => context.service.get(started.id), (task) => task.terminal, "link failure replacement");
  const official = final.items.find((item) => item.slot_kind === "official");
  const history = attempts(context.db, started.id).filter((attempt) => attempt.item_id === official.id);
  assert.equal(final.status, "completed");
  assert.equal(history.length, 2);
  assert.equal(history[0].registration_status, "succeeded");
  assert.equal(history[0].link_status, "failed");
  assert.equal(history[0].outcome, "link_failed");
  assert.equal(history[0].recycle_status, "succeeded");
  assert.equal(history[1].link_status, "succeeded");
  assert.equal(final.recent_errors[0].id, history[0].id);
});

test("active pipeline resumes after service restart and can be cancelled", async (t) => {
  const alias = "first@email.com";
  const context = harness(t, {
    registrationOutcomes: {
      [alias]: [{
        status: "failed",
        failure_reason: "user_already_exists",
        message: "user_already_exists",
      }],
    },
  });
  const configuredOutcome = context.registration.nextOutcome.bind(context.registration);
  context.registration.nextOutcome = (email) => (
    String(email).startsWith("ah") ? { status: "pending" } : configuredOutcome(email)
  );
  const started = await context.service.start(input({
    requestId: "mailcom-recovery-cancel-001",
    recycleSucceeded: true,
  }));
  await waitFor(
    () => context.service.get(started.id),
    (task) => task.recycled_count >= 1 && task.items.some((item) => (
      item.slot_kind === "official" && item.stage === "registration_wait"
    )),
    "failed-alias recycle and replacement registration",
  );
  const attemptsBefore = attempts(context.db, started.id).length;
  await context.service.close();
  const pendingJob = context.db.prepare(`
    SELECT id FROM registration_jobs WHERE status = 'running' ORDER BY id DESC LIMIT 1
  `).get();
  assert.ok(pendingJob);
  context.registration.jobOutcomes.set(pendingJob.id, {
    status: "failed",
    failure_reason: "user_already_exists",
    message: "user_already_exists",
  });

  const recovered = new MailcomRegistrationPipelineService({
    db: context.db,
    registration: context.registration,
    paymentLinks: context.paymentLinks,
    paymentAgreements: context.paymentAgreements,
    mailcomAliases: context.mailcomAliases,
    pollIntervalMs: 20,
    retryBaseMs: 20,
    sleepFn: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  t.after(() => recovered.close());
  await waitFor(
    () => recovered.get(started.id),
    (task) => task.attempt_count > attemptsBefore,
    "recovered pipeline progress",
  );
  const cancelled = await recovered.cancel(started.id);
  assert.equal(cancelled.status, "cancelled");
});

test("recovery adopts a synced planned replacement without creating a duplicate slot", async (t) => {
  const context = harness(t);
  await context.service.close();
  const fixture = context.fixtures[0];
  const primary = context.db.prepare(`
    SELECT * FROM addresses WHERE account_id = ? AND kind = 'primary'
  `).get(fixture.account.id);
  const oldAlias = fixture.aliases[0];
  const replacementEmail = "ahrecover123@mail.com";
  const at = nowIso();
  const replacementResult = context.db.prepare(`
    INSERT INTO addresses (
      account_id, address, kind, status, strategy, label, purpose,
      remote_confirmed, created_at, updated_at
    ) VALUES (?, ?, 'official', 'active', ?, 'Recovered replacement', '流水线', 1, ?, ?)
  `).run(fixture.account.id, replacementEmail, MAILCOM_ALIAS_STRATEGY, at, at);
  const replacementId = Number(replacementResult.lastInsertRowid);
  const pipelineId = "mailcom-replacement-recovery-pipeline";
  context.db.prepare(`
    INSERT INTO mailcom_registration_pipelines (
      id, request_id, request_fingerprint, domain, status, stage, concurrency,
      browser_mode, proxy_selection, payment_link_country, recycle_succeeded,
      account_count, slot_count, created_at, updated_at
    ) VALUES (?, 'mailcom-replacement-recovery-request', 'fixture-fingerprint', 'mail.com',
      'running', 'processing', 1, 'headless', 'auto', 'GB', 0, 1, 2, ?, ?)
  `).run(pipelineId, at, at);
  context.db.prepare(`
    INSERT INTO mailcom_registration_pipeline_items (
      pipeline_id, account_id, source_email, slot_key, slot_kind,
      initial_address_id, initial_email, current_address_id, current_email,
      status, stage, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, 'primary', ?, ?, ?, ?, 'completed', 'completed', ?, ?, ?)
  `).run(
    pipelineId,
    fixture.account.id,
    fixture.account.email,
    `primary:${fixture.account.id}`,
    primary.id,
    primary.address,
    primary.id,
    primary.address,
    at,
    at,
    at,
  );
  const itemResult = context.db.prepare(`
    INSERT INTO mailcom_registration_pipeline_items (
      pipeline_id, account_id, source_email, slot_key, slot_kind,
      initial_address_id, initial_email, current_address_id, current_email,
      replacement_email, status, stage, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'official', ?, ?, ?, ?, ?, 'running', 'recycling', ?, ?)
  `).run(
    pipelineId,
    fixture.account.id,
    fixture.account.email,
    `official:${oldAlias.id}`,
    oldAlias.id,
    oldAlias.address,
    oldAlias.id,
    oldAlias.address,
    replacementEmail,
    at,
    at,
  );
  const itemId = Number(itemResult.lastInsertRowid);
  const attemptResult = context.db.prepare(`
    INSERT INTO mailcom_registration_pipeline_attempts (
      pipeline_id, item_id, attempt_number, address_id, email, status, stage,
      outcome, registration_status, link_status, recycle_status, recycle_attempts,
      registration_finished_at, link_finished_at, finished_at, created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, 'failed', 'recycling', 'link_failed', 'succeeded',
      'failed', 'running', 1, ?, ?, ?, ?, ?)
  `).run(pipelineId, itemId, oldAlias.id, oldAlias.address, at, at, at, at, at);
  context.db.prepare(`
    UPDATE mailcom_registration_pipeline_items SET current_attempt_id = ? WHERE id = ?
  `).run(Number(attemptResult.lastInsertRowid), itemId);

  const recovered = new MailcomRegistrationPipelineService({
    db: context.db,
    registration: context.registration,
    paymentLinks: context.paymentLinks,
    paymentAgreements: context.paymentAgreements,
    mailcomAliases: context.mailcomAliases,
    pollIntervalMs: 20,
    retryBaseMs: 20,
    sleepFn: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  t.after(() => recovered.close());
  const final = await waitFor(() => recovered.get(pipelineId), (task) => task.terminal, "planned replacement recovery");
  assert.equal(final.status, "completed");
  assert.equal(final.slot_count, 2);
  assert.equal(context.db.prepare(`
    SELECT COUNT(*) AS count FROM mailcom_registration_pipeline_items WHERE pipeline_id = ?
  `).get(pipelineId).count, 2);
  const official = final.items.find((item) => item.slot_kind === "official");
  assert.equal(official.current_address_id, replacementId);
  assert.equal(official.current_email, replacementEmail);
  assert.equal(context.mailcomAliases.recycleCalls[0].replacementAddress, replacementEmail);
});

test("restart replays a cancelled in-flight recycle until its reservation is safely cleared", async (t) => {
  const context = harness(t);
  await context.service.close();
  const transient = Object.assign(new Error("fixture orphan recovery unavailable"), {
    status: 503,
    code: "MAILCOM_ALIAS_AUTOMATION_FAILED",
  });
  const gate = deferred();
  context.mailcomAliases.recycleFailures.push(transient);
  context.mailcomAliases.recycleGate = gate;
  const orphan = insertCancelledRecycleOrphan(context);
  assert.ok(mailcomRecyclingReservation(context.db, orphan.oldAlias.address));

  const recovered = new MailcomRegistrationPipelineService({
    db: context.db,
    registration: context.registration,
    paymentLinks: context.paymentLinks,
    paymentAgreements: context.paymentAgreements,
    mailcomAliases: context.mailcomAliases,
    pollIntervalMs: 20,
    retryBaseMs: 20,
    retryMaximumMs: 40,
    sleepFn: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  t.after(() => recovered.close());
  await waitFor(
    () => context.mailcomAliases.recycleCalls.length,
    (count) => count >= 2,
    "orphan recycle retry entering the remote gate",
  );
  assert.equal(context.db.prepare(`
    SELECT recycle_status FROM mailcom_registration_pipeline_attempts WHERE id = ?
  `).get(orphan.attemptId).recycle_status, "running");
  assert.ok(mailcomRecyclingReservation(context.db, orphan.oldAlias.address));
  await assert.rejects(
    recovered.start(input({
      requestId: "mailcom-orphan-recovery-blocks-start",
      recycleSucceeded: false,
    })),
    (error) => error.code === "MAILCOM_PIPELINE_RECOVERY_ACTIVE" && error.status === 409,
  );
  assert.equal(context.registration.createCalls.length, 0);
  assert.equal(context.paymentLinks.startCalls.length, 0);
  assert.equal(context.db.prepare(`
    SELECT COUNT(*) AS count FROM mailcom_registration_pipeline_items WHERE pipeline_id = ?
  `).get(orphan.pipelineId).count, 2);

  gate.resolve();
  await waitFor(
    () => context.db.prepare(`
      SELECT recycle_status FROM mailcom_registration_pipeline_attempts WHERE id = ?
    `).get(orphan.attemptId).recycle_status,
    (status) => status === "succeeded",
    "orphan recycle recovery completion",
  );
  const task = recovered.get(orphan.pipelineId);
  const official = task.items.find((item) => item.id === orphan.itemId);
  assert.equal(task.status, "cancelled");
  assert.equal(official.status, "cancelled");
  assert.equal(official.current_email, orphan.replacementEmail);
  assert.equal(official.recycled_count, 1);
  assert.equal(task.slot_count, 2);
  assert.equal(context.registration.createCalls.length, 0);
  assert.equal(context.paymentLinks.startCalls.length, 0);
  assert.equal(mailcomRecyclingReservation(context.db, orphan.oldAlias.address), null);
});

test("orphan recovery retries saved web authorization before resuming the reserved recycle", async (t) => {
  const context = harness(t, {
    accounts: [{
      email: "orphan-saved-password@mail.com",
      aliases: ["orphan-old@email.com"],
      savedCredentials: true,
    }],
  });
  await context.service.close();
  const orphan = insertCancelledRecycleOrphan(context, {
    pipelineId: "mailcom-authorized-orphan-recovery",
    replacementEmail: "ahauthorizedorphan@mail.com",
  });
  context.db.prepare(`
    UPDATE source_accounts SET status = 'connected', limit_reason = ?, updated_at = ? WHERE id = ?
  `).run(
    `${MAILCOM_ALIAS_AUTHORIZATION_BLOCK_PREFIX}fixture authorization expired before restart`,
    nowIso(),
    context.fixtures[0].account.id,
  );
  assert.ok(mailcomRecyclingReservation(context.db, orphan.oldAlias.address));

  const recovered = new MailcomRegistrationPipelineService({
    db: context.db,
    registration: context.registration,
    paymentLinks: context.paymentLinks,
    paymentAgreements: context.paymentAgreements,
    mailcomAliases: context.mailcomAliases,
    pollIntervalMs: 20,
    retryBaseMs: 20,
    retryMaximumMs: 40,
    sleepFn: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  t.after(() => recovered.close());

  await waitFor(
    () => context.db.prepare(`
      SELECT recycle_status FROM mailcom_registration_pipeline_attempts WHERE id = ?
    `).get(orphan.attemptId).recycle_status,
    (status) => status === "succeeded",
    "authorized orphan recycle completion",
  );

  const source = context.db.prepare("SELECT * FROM source_accounts WHERE id = ?")
    .get(context.fixtures[0].account.id);
  assert.equal(source.status, "connected");
  assert.equal(source.limit_reason, "");
  assert.deepEqual(context.mailcomAliases.authorizationCalls, [{
    accountId: context.fixtures[0].account.id,
  }]);
  assert.equal(context.mailcomAliases.recycleCalls.length, 1);
  assert.ok(
    context.mailcomAliases.operationLog.indexOf(`verify:${context.fixtures[0].account.id}`)
      < context.mailcomAliases.operationLog.indexOf(
        `recycle:${context.fixtures[0].account.id}:${orphan.oldAlias.address}`,
      ),
  );
  assert.equal(
    context.mailcomAliases.recycleCalls[0].replacementAddress,
    orphan.replacementEmail,
  );
  assert.equal(mailcomRecyclingReservation(context.db, orphan.oldAlias.address), null);
});

test("restart does not resurrect a web-authorization error older than the imported password", async (t) => {
  const context = harness(t, {
    accounts: [{
      email: "newer-password@mail.com",
      aliases: ["stale-authorization-error@email.com"],
      savedCredentials: true,
    }],
  });
  await context.service.close();
  const orphan = insertCancelledRecycleOrphan(context, {
    pipelineId: "mailcom-stale-authorization-marker",
    replacementEmail: "ahnewerpassword@mail.com",
  });
  context.db.prepare(`
    UPDATE mailcom_registration_pipeline_attempts
    SET stage = 'orphan_recycle_retry_wait', recycle_error = ?, updated_at = ?
    WHERE id = ?
  `).run(
    `${MAILCOM_ALIAS_AUTHORIZATION_BLOCK_PREFIX}fixture stale session error`,
    "2026-08-18T10:00:00.000Z",
    orphan.attemptId,
  );
  context.db.prepare(`
    UPDATE mailcom_credentials SET credential_updated_at = ? WHERE account_id = ?
  `).run("2026-08-18T10:01:00.000Z", context.fixtures[0].account.id);
  context.db.prepare(`
    UPDATE source_accounts SET status = 'connected', limit_reason = '', updated_at = ? WHERE id = ?
  `).run("2026-08-18T10:01:00.000Z", context.fixtures[0].account.id);

  assert.equal(context.service.restoreAliasAccountBlocks(), 0);
  assert.equal(
    context.db.prepare("SELECT limit_reason FROM source_accounts WHERE id = ?")
      .get(context.fixtures[0].account.id).limit_reason,
    "",
  );
  assert.equal(context.mailcomAliases.authorizationCalls.length, 0);
});

test("orphan recovery skips remote recycle when a successful agreement was recorded after cancellation", async (t) => {
  const context = harness(t);
  await context.service.close();
  const orphan = insertCancelledRecycleOrphan(context, {
    pipelineId: "mailcom-successful-agreement-orphan",
    replacementEmail: "ahmustnotreplace@mail.com",
  });
  context.db.prepare(`
    UPDATE mailcom_registration_pipeline_attempts
    SET status = 'cancelled', agreement_status = 'succeeded', agreement_finished_at = ?, updated_at = ?
    WHERE id = ?
  `).run(nowIso(), nowIso(), orphan.attemptId);
  assert.ok(mailcomRecyclingReservation(context.db, orphan.oldAlias.address));

  const recovered = new MailcomRegistrationPipelineService({
    db: context.db,
    registration: context.registration,
    paymentLinks: context.paymentLinks,
    paymentAgreements: context.paymentAgreements,
    mailcomAliases: context.mailcomAliases,
    pollIntervalMs: 20,
    retryBaseMs: 20,
    retryMaximumMs: 40,
    sleepFn: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  t.after(() => recovered.close());
  await waitFor(
    () => context.db.prepare(`
      SELECT * FROM mailcom_registration_pipeline_attempts WHERE id = ?
    `).get(orphan.attemptId),
    (attempt) => attempt.recycle_status === "skipped",
    "successful agreement orphan preservation",
  );
  await waitFor(
    () => recovered.orphanTrackers.size,
    (count) => count === 0,
    "successful agreement orphan tracker release",
  );

  const attempt = context.db.prepare(`
    SELECT * FROM mailcom_registration_pipeline_attempts WHERE id = ?
  `).get(orphan.attemptId);
  const item = context.db.prepare(`
    SELECT * FROM mailcom_registration_pipeline_items WHERE id = ?
  `).get(orphan.itemId);
  const address = context.db.prepare("SELECT * FROM addresses WHERE id = ?").get(orphan.oldAlias.id);
  assert.equal(attempt.status, "cancelled");
  assert.equal(attempt.agreement_status, "succeeded");
  assert.equal(attempt.recycle_status, "skipped");
  assert.equal(item.current_email, orphan.oldAlias.address);
  assert.equal(item.replacement_email, "");
  assert.equal(address.status, "active");
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  assert.equal(mailcomRecyclingReservation(context.db, orphan.oldAlias.address), null);
});

test("orphan recovery quarantines credential failures while keeping its reservation", async (t) => {
  const context = harness(t);
  await context.service.close();
  const credentialError = Object.assign(new Error("Mail.com login credentials are unavailable"), {
    status: 409,
    code: "MAILCOM_CREDENTIAL_REQUIRED",
  });
  context.mailcomAliases.recycleFailures.push(credentialError);
  const orphan = insertCancelledRecycleOrphan(context, {
    pipelineId: "mailcom-credential-orphan-pipeline",
    replacementEmail: "ahcredentialretry@mail.com",
  });
  const recovered = new MailcomRegistrationPipelineService({
    db: context.db,
    registration: context.registration,
    paymentLinks: context.paymentLinks,
    paymentAgreements: context.paymentAgreements,
    mailcomAliases: context.mailcomAliases,
    pollIntervalMs: 20,
    retryBaseMs: 10_000,
    retryMaximumMs: 10_000,
    sleepFn: () => new Promise(() => {}),
  });
  t.after(() => recovered.close());
  const waiting = await waitFor(
    () => context.db.prepare(`
      SELECT * FROM mailcom_registration_pipeline_attempts WHERE id = ?
    `).get(orphan.attemptId),
    (attempt) => attempt.stage === "orphan_recycle_retry_wait",
    "credential orphan retry state",
  );
  assert.equal(waiting.recycle_status, "running");
  assert.match(waiting.recycle_error, /网页授权需要处理|已隔离/);
  assert.ok(mailcomRecyclingReservation(context.db, orphan.oldAlias.address));
  assert.equal(context.mailcomAliases.recycleCalls.length, 1);
  assert.equal(context.registration.createCalls.length, 0);
  const source = context.db.prepare("SELECT * FROM source_accounts WHERE id = ?")
    .get(context.fixtures[0].account.id);
  assert.equal(source.status, "connected");
  assert.match(source.limit_reason, /login credentials are unavailable/);

  const listed = recovered.list({ limit: 1 });
  assert.equal(listed.active, null);
  assert.equal(listed.recovery_active, true);
  assert.equal(listed.recovering_recycle_count, 1);
  assert.equal(listed.recovery_error, waiting.recycle_error);
  assert.equal(listed.recovering_recycles.length, 1);
  assert.deepEqual({
    attempt_id: listed.recovering_recycles[0].attempt_id,
    pipeline_id: listed.recovering_recycles[0].pipeline_id,
    account_id: listed.recovering_recycles[0].account_id,
    source_email: listed.recovering_recycles[0].source_email,
    alias_email: listed.recovering_recycles[0].alias_email,
    stage: listed.recovering_recycles[0].stage,
  }, {
    attempt_id: orphan.attemptId,
    pipeline_id: orphan.pipelineId,
    account_id: context.fixtures[0].account.id,
    source_email: context.fixtures[0].account.email,
    alias_email: orphan.oldAlias.address,
    stage: "orphan_recycle_retry_wait",
  });
  assert.equal(listed.recovering_recycles[0].recycle_attempts, 2);
  assert.equal(listed.recovering_recycles[0].error, waiting.recycle_error);
  assert.ok(listed.recovering_recycles[0].next_retry_at);
  const status = await recovered.status();
  assert.equal(status.ready, false);
  assert.equal(status.active, null);
  assert.equal(status.recovery_active, true);
  assert.equal(status.recovering_recycle_count, 1);
  assert.equal(status.recovery_error, waiting.recycle_error);
  assert.equal(status.recovering_recycles.length, 1);
  assert.equal(status.recovering_recycles[0].source_email, context.fixtures[0].account.email);
  assert.equal(status.recovering_recycles[0].alias_email, orphan.oldAlias.address);
  assert.equal(status.dependency.ready, false);
  assert.equal(status.dependency.code, "MAILCOM_PIPELINE_RECOVERY_ACTIVE");
  assert.equal(
    status.dependency.error,
    `上次取消的 Mail.com 别名轮换正在恢复：母号 ${context.fixtures[0].account.email}，待轮换别名 ${orphan.oldAlias.address}`,
  );
  assert.doesNotMatch(status.dependency.error, /credentials/i);

  await recovered.close();
  assert.ok(mailcomRecyclingReservation(context.db, orphan.oldAlias.address));
});

test("abandonRecoveries releases a terminal orphan and ignores its late remote completion", async (t) => {
  const context = harness(t);
  await context.service.close();
  const gate = deferred();
  context.mailcomAliases.recycleGate = gate;
  const orphan = insertCancelledRecycleOrphan(context, {
    pipelineId: "mailcom-abandoned-orphan-pipeline",
    replacementEmail: "ahabandonedlate@mail.com",
  });
  const recovered = new MailcomRegistrationPipelineService({
    db: context.db,
    registration: context.registration,
    paymentLinks: context.paymentLinks,
    paymentAgreements: context.paymentAgreements,
    mailcomAliases: context.mailcomAliases,
    pollIntervalMs: 20,
    retryBaseMs: 20,
    retryMaximumMs: 40,
    sleepFn: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  t.after(() => recovered.close());
  await waitFor(
    () => context.mailcomAliases.recycleCalls.length,
    (count) => count === 1,
    "terminal orphan remote recycle start",
  );

  const reason = "fixture account was explicitly removed";
  const abandoned = recovered.abandonRecoveries({
    accountId: context.fixtures[0].account.id,
    reason,
  });
  assert.deepEqual(abandoned, {
    abandoned_count: 1,
    item_ids: [orphan.itemId],
  });
  let attempt = context.db.prepare(`
    SELECT * FROM mailcom_registration_pipeline_attempts WHERE id = ?
  `).get(orphan.attemptId);
  let item = context.db.prepare(`
    SELECT * FROM mailcom_registration_pipeline_items WHERE id = ?
  `).get(orphan.itemId);
  assert.equal(attempt.recycle_status, "skipped");
  assert.equal(attempt.stage, "recycle_abandoned");
  assert.equal(attempt.recycle_error, reason);
  assert.equal(attempt.next_retry_at, null);
  assert.equal(item.replacement_email, "");
  assert.equal(item.next_retry_at, null);
  assert.equal(recovered.list({ limit: 1 }).recovery_active, false);
  assert.equal(mailcomRecyclingReservation(context.db, orphan.oldAlias.address), null);

  gate.resolve();
  await waitFor(
    () => recovered.orphanTrackers.size,
    (count) => count === 0,
    "abandoned orphan tracker completion",
  );
  attempt = context.db.prepare(`
    SELECT * FROM mailcom_registration_pipeline_attempts WHERE id = ?
  `).get(orphan.attemptId);
  item = context.db.prepare(`
    SELECT * FROM mailcom_registration_pipeline_items WHERE id = ?
  `).get(orphan.itemId);
  assert.equal(attempt.recycle_status, "skipped");
  assert.equal(attempt.stage, "recycle_abandoned");
  assert.equal(item.current_email, orphan.oldAlias.address);
  assert.equal(item.replacement_email, "");
  assert.equal(item.recycled_count, 0);
  assert.equal(recovered.list({ limit: 1 }).recovery_active, false);
});

test("restart safely releases a cancelled recycle that never reached the remote adapter", async (t) => {
  const context = harness(t);
  await context.service.close();
  const orphan = insertCancelledRecycleOrphan(context, {
    pipelineId: "mailcom-cancelled-queued-orphan",
    replacementEmail: "ahqueuedcancel@mail.com",
    stage: "recycling",
  });
  assert.ok(mailcomRecyclingReservation(context.db, orphan.oldAlias.address));
  const recovered = new MailcomRegistrationPipelineService({
    db: context.db,
    registration: context.registration,
    paymentLinks: context.paymentLinks,
    paymentAgreements: context.paymentAgreements,
    mailcomAliases: context.mailcomAliases,
    pollIntervalMs: 20,
    retryBaseMs: 20,
    sleepFn: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  t.after(() => recovered.close());
  await recovered.recoveryPromise;
  const attempt = context.db.prepare(`
    SELECT * FROM mailcom_registration_pipeline_attempts WHERE id = ?
  `).get(orphan.attemptId);
  const item = recovered.get(orphan.pipelineId).items.find((entry) => entry.id === orphan.itemId);
  assert.equal(attempt.recycle_status, "skipped");
  assert.equal(item.status, "cancelled");
  assert.equal(item.current_email, orphan.oldAlias.address);
  assert.equal(item.replacement_email, "");
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  assert.equal(context.registration.createCalls.length, 0);
  assert.equal(mailcomRecyclingReservation(context.db, orphan.oldAlias.address), null);
});

test("cancelling during remote recycle records the replacement without requeueing the slot", async (t) => {
  const gate = deferred();
  const context = harness(t, {
    paymentOutcomes: { "first@email.com": ["failed"] },
    aliasOptions: { recycleGate: gate },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-recycle-cancel-race-001",
    recycleSucceeded: true,
    linkAttempts: 1,
  }));
  await waitFor(
    () => context.mailcomAliases.recycleCalls.length,
    (count) => count >= 1,
    "remote recycle start",
  );
  const cancellation = await context.service.cancel(started.id);
  assert.equal(cancellation.status, "cancelled");
  assert.ok(attempts(context.db, started.id).some((attempt) => attempt.recycle_status === "running"));
  gate.resolve();
  await waitFor(
    () => attempts(context.db, started.id),
    (rows) => rows.some((attempt) => attempt.recycle_status === "succeeded"),
    "late recycle completion",
  );
  const final = context.service.get(started.id);
  const official = final.items.find((item) => item.slot_kind === "official");
  assert.equal(final.status, "cancelled");
  assert.equal(official.status, "cancelled");
  assert.notEqual(official.current_email, official.initial_email);
  assert.equal(official.recycled_count, 1);
});

test("cancel plus a remote-started transient error stays reserved for orphan retry", async (t) => {
  const gate = deferred();
  const transient = Object.assign(new Error("remote response lost after delete"), {
    status: 503,
    code: "MAILCOM_ALIAS_AUTOMATION_FAILED",
  });
  const context = harness(t, {
    paymentOutcomes: { "first@email.com": ["failed"] },
    aliasOptions: { recycleGate: gate, recycleFailuresAfterGate: [transient] },
  });
  context.service.retryBaseMs = 10_000;
  context.service.retryMaximumMs = 10_000;
  context.service.sleepFn = () => new Promise(() => {});
  const started = await context.service.start(input({
    requestId: "mailcom-cancel-remote-error-001",
    recycleSucceeded: true,
    linkAttempts: 1,
  }));
  await waitFor(
    () => context.mailcomAliases.recycleCalls.length,
    (count) => count === 1,
    "remote-started recycle",
  );
  const cancelled = await context.service.cancel(started.id);
  assert.equal(cancelled.status, "cancelled");
  gate.resolve();
  const waiting = await waitFor(
    () => attempts(context.db, started.id).find((attempt) => attempt.recycle_status === "running"),
    (attempt) => attempt?.stage === "orphan_recycle_retry_wait",
    "cancelled remote error orphan retry",
  );
  assert.match(waiting.recycle_error, /response lost after delete/);
  assert.ok(mailcomRecyclingReservation(context.db, waiting.email));
  assert.equal(context.mailcomAliases.recycleCalls.length, 1);
  context.service.wake(waiting.item_id);
  await waitFor(
    () => context.db.prepare(`
      SELECT recycle_status FROM mailcom_registration_pipeline_attempts WHERE id = ?
    `).get(waiting.id).recycle_status,
    (status) => status === "succeeded",
    "same-process orphan retry completion",
  );
  const final = context.service.get(started.id);
  const official = final.items.find((item) => item.id === waiting.item_id);
  assert.equal(final.status, "cancelled");
  assert.equal(official.status, "cancelled");
  assert.equal(official.recycled_count, 1);
  assert.equal(context.mailcomAliases.recycleCalls.length, 2);
  assert.equal(mailcomRecyclingReservation(context.db, waiting.email), null);
});

test("temporary recycle errors are visible and retry the same persisted replacement", async (t) => {
  const transient = Object.assign(new Error("temporary browser failure"), {
    status: 503,
    code: "MAILCOM_ALIAS_AUTOMATION_FAILED",
  });
  const context = harness(t, {
    paymentOutcomes: { "first@email.com": ["failed"] },
    aliasOptions: { recycleFailures: [transient] },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-recycle-retry-001",
    linkAttempts: 1,
  }));
  const final = await waitFor(() => context.service.get(started.id), (task) => task.terminal, "recycle retry");
  assert.equal(final.status, "completed");
  assert.equal(context.mailcomAliases.recycleCalls.length, 2);
  assert.equal(
    context.mailcomAliases.recycleCalls[0].replacementAddress,
    context.mailcomAliases.recycleCalls[1].replacementAddress,
  );
  const official = final.items.find((item) => item.slot_kind === "official");
  assert.equal(official.recycle_retry_count, 0);
  assert.equal(official.recycled_count, 1);
  const first = attempts(context.db, started.id).find((attempt) => attempt.item_id === official.id);
  assert.equal(first.recycle_attempts, 2);
  assert.equal(first.recycle_status, "succeeded");
});

test("random suffix persists one concrete recycle replacement across transient retries", async (t) => {
  const selectedDomain = "dutchmail.com";
  const transient = Object.assign(new Error("temporary random-domain browser failure"), {
    status: 503,
    code: "MAILCOM_ALIAS_AUTOMATION_FAILED",
  });
  const context = harness(t, {
    paymentOutcomes: { "first@email.com": ["failed"] },
    aliasOptions: { recycleFailures: [transient] },
    serviceOptions: { randomIntFn: () => mailcomDomains.indexOf(selectedDomain) },
  });
  const started = await context.service.start(input({
    domain: "random",
    requestId: "mailcom-random-suffix-retry-001",
    linkAttempts: 1,
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "random suffix recycle retry",
  );

  assert.equal(final.status, "completed");
  assert.equal(final.domain, "random");
  assert.ok(context.mailcomAliases.prepareCalls.every((call) => call.domain === "random"));
  assert.equal(context.mailcomAliases.recycleCalls.length, 2);
  const [first, second] = context.mailcomAliases.recycleCalls;
  assert.equal(first.replacementAddress, second.replacementAddress);
  assert.equal(first.domain, second.domain);
  assert.equal(first.domain, selectedDomain);
  assert.equal(first.replacementAddress.split("@").at(-1), first.domain);
});

test("random suffix discards an unsupported-domain replacement before drawing the retry suffix", async (t) => {
  const firstDomain = "mail.com";
  const retryDomain = "dutchmail.com";
  const domainUnavailable = Object.assign(new Error("suffix is not active for this account"), {
    status: 409,
    code: "MAILCOM_ALIAS_DOMAIN_UNAVAILABLE",
    remote_mutation_possible: false,
  });
  const samples = [
    mailcomDomains.indexOf(firstDomain),
    mailcomDomains.indexOf(retryDomain),
  ];
  const context = harness(t, {
    paymentOutcomes: { "first@email.com": ["failed"] },
    aliasOptions: { recycleFailures: [domainUnavailable] },
    serviceOptions: { randomIntFn: () => samples.shift() },
  });
  const started = await context.service.start(input({
    domain: "random",
    requestId: "mailcom-random-suffix-redraw-001",
    linkAttempts: 1,
  }));
  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "random suffix redraw after unavailable domain",
  );

  assert.equal(final.status, "completed");
  assert.equal(context.mailcomAliases.recycleCalls.length, 2);
  const [first, second] = context.mailcomAliases.recycleCalls;
  assert.equal(first.domain, firstDomain);
  assert.equal(second.domain, retryDomain);
  assert.notEqual(first.replacementAddress, second.replacementAddress);
  assert.equal(second.replacementAddress.split("@").at(-1), retryDomain);
});

test("a Mail.com session expiry waits for saved-password authorization recovery instead of failing aliases", async (t) => {
  const recycleGate = deferred();
  const authorizationGate = deferred();
  const sessionExpired = Object.assign(
    new Error("Mail.com 网页授权已失效，请重新连接母号后再试"),
    { status: 409, code: "MAILCOM_ALIAS_SESSION_EXPIRED" },
  );
  const aAliases = ["a-first@email.com", "a-second@email.com"];
  const context = harness(t, {
    accounts: [
      { email: "source-b@mail.com", aliases: ["b-only@email.com"] },
      {
        email: "source-a@mail.com",
        aliases: aAliases,
        savedCredentials: true,
      },
    ],
    paymentOutcomes: {
      [aAliases[0]]: ["failed"],
      [aAliases[1]]: ["failed"],
    },
    trialOutcomes: {
      [aAliases[0]]: { status: "failed", message: "账号不存在" },
      [aAliases[1]]: { status: "failed", message: "账号不存在" },
    },
    aliasOptions: {
      authorizationGate,
      recycleGate,
      recycleFailuresAfterGate: [sessionExpired],
    },
  });
  const sourceB = context.fixtures[0];
  const sourceA = context.fixtures[1];
  const started = await context.service.start(input({
    requestId: "mailcom-account-recycle-quarantine-001",
    concurrency: 5,
    linkAttempts: 1,
  }));

  try {
    await waitFor(
      () => ({
        calls: context.mailcomAliases.recycleCalls.length,
        recycling: context.db.prepare(`
          SELECT COUNT(*) AS count FROM mailcom_registration_pipeline_items
          WHERE pipeline_id = ? AND account_id = ? AND slot_kind = 'official'
            AND stage = 'recycling'
        `).get(started.id, sourceA.account.id).count,
      }),
      (state) => state.calls === 1 && state.recycling === 2,
      "one active and one queued recycle for the expiring account",
    );
  } finally {
    recycleGate.resolve();
  }

  try {
    const waiting = await waitFor(
      () => {
        const task = context.service.get(started.id);
        const itemIds = new Set(task.items.filter((item) => (
          Number(item.account_id) === Number(sourceA.account.id) && item.slot_kind === "official"
        )).map((item) => Number(item.id)));
        return {
          task,
          source: context.db.prepare("SELECT * FROM source_accounts WHERE id = ?")
            .get(sourceA.account.id),
          attempts: attempts(context.db, started.id).filter((attempt) => (
            itemIds.has(Number(attempt.item_id))
          )),
          authorizationCalls: context.mailcomAliases.authorizationCalls.length,
        };
      },
      (state) => state.authorizationCalls > 0
        && state.attempts.some((attempt) => (
          attempt.recycle_status === "running" && attempt.stage === "recycle_retry_wait"
        )),
      "saved-password authorization retry wait",
    );
    assert.equal(waiting.task.terminal, false);
    assert.equal(waiting.source.status, "connected");
    assert.match(waiting.source.limit_reason, /网页授权需要处理/);
    assert.ok(waiting.attempts.every((attempt) => attempt.recycle_status !== "failed"));
    assert.ok(waiting.task.items.filter((item) => (
      Number(item.account_id) === Number(sourceA.account.id) && item.slot_kind === "official"
    )).every((item) => item.status !== "failed"));
    assert.equal(context.mailcomAliases.recycleCalls.length, 1);
    assert.ok(aAliases.includes(context.mailcomAliases.recycleCalls[0].address));
    assert.ok(sourceA.aliases.every((alias) => (
      context.db.prepare("SELECT status FROM addresses WHERE id = ?").get(alias.id).status === "active"
    )));
  } finally {
    authorizationGate.resolve();
  }

  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "account-scoped authorization recovery completion",
  );
  const storedSourceA = context.db.prepare("SELECT * FROM source_accounts WHERE id = ?")
    .get(sourceA.account.id);
  const storedSourceB = context.db.prepare("SELECT * FROM source_accounts WHERE id = ?")
    .get(sourceB.account.id);
  const aOfficialItems = final.items.filter((item) => (
    Number(item.account_id) === Number(sourceA.account.id) && item.slot_kind === "official"
  ));
  const bItems = final.items.filter((item) => (
    Number(item.account_id) === Number(sourceB.account.id)
  ));
  const aOfficialItemIds = new Set(aOfficialItems.map((item) => Number(item.id)));
  const recoveredAttempts = attempts(context.db, started.id).filter((attempt) => (
    aOfficialItemIds.has(Number(attempt.item_id)) && attempt.recycle_status === "succeeded"
  ));

  assert.equal(final.status, "completed");
  assert.equal(storedSourceA.status, "connected");
  assert.equal(storedSourceA.limit_reason, "");
  assert.equal(storedSourceB.status, "connected");
  assert.ok(context.mailcomAliases.authorizationCalls.length >= 1);
  assert.ok(context.mailcomAliases.authorizationCalls.every((call) => (
    Number(call.accountId) === Number(sourceA.account.id)
  )));
  assert.equal(context.mailcomAliases.recycleCalls.length, 3);
  assert.ok(context.mailcomAliases.recycleCalls.every((call) => (
    Number(call.accountId) === Number(sourceA.account.id)
  )));
  assert.equal(aOfficialItems.length, 2);
  assert.ok(aOfficialItems.every((item) => item.status === "completed" && item.recycled_count === 1));
  assert.equal(recoveredAttempts.length, 2);
  assert.equal(bItems.length, 2);
  assert.ok(bItems.every((item) => item.status === "completed"));
  assert.equal(bItems.reduce((sum, item) => sum + Number(item.agreement_success_count), 0), 2);
});

test("a queued recycle callback rechecks agreement success before calling the remote adapter", async (t) => {
  const gate = deferred();
  const aliases = ["queued-first@email.com", "queued-second@email.com"];
  const context = harness(t, {
    accounts: [{ email: "queued-owner@mail.com", aliases }],
    trialOutcomes: {
      [aliases[0]]: { status: "failed", message: "账号不存在" },
      [aliases[1]]: { status: "failed", message: "账号不存在" },
    },
    agreementOptions: {
      outcomes: {
        [aliases[0]]: { status: "failed", error: "fixture agreement failure" },
        [aliases[1]]: { status: "failed", error: "fixture agreement failure" },
      },
    },
    aliasOptions: { recycleGate: gate },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-queued-recycle-agreement-race-001",
    concurrency: 5,
  }));
  await waitFor(
    () => ({
      calls: context.mailcomAliases.recycleCalls.length,
      recycling: context.db.prepare(`
        SELECT COUNT(*) AS count FROM mailcom_registration_pipeline_attempts
        WHERE pipeline_id = ? AND email IN (?, ?) AND recycle_status = 'running'
      `).get(started.id, ...aliases).count,
    }),
    (state) => state.calls === 1 && state.recycling === 2,
    "one active and one queued recycle before agreement correction",
  );

  const activeEmail = context.mailcomAliases.recycleCalls[0].address;
  const protectedAttempt = attempts(context.db, started.id).find((attempt) => (
    aliases.includes(attempt.email) && attempt.email !== activeEmail && attempt.recycle_status === "running"
  ));
  assert.ok(protectedAttempt);
  assert.notEqual(protectedAttempt.status, "succeeded");
  context.db.prepare(`
    UPDATE mailcom_registration_pipeline_attempts
    SET agreement_status = 'succeeded', agreement_error = '', agreement_finished_at = ?, updated_at = ?
    WHERE id = ?
  `).run(nowIso(), nowIso(), protectedAttempt.id);
  gate.resolve();

  const final = await waitFor(
    () => context.service.get(started.id),
    (task) => task.terminal,
    "queued recycle agreement preservation",
  );
  const stored = context.db.prepare(`
    SELECT * FROM mailcom_registration_pipeline_attempts WHERE id = ?
  `).get(protectedAttempt.id);
  const address = context.db.prepare("SELECT * FROM addresses WHERE id = ?").get(protectedAttempt.address_id);
  assert.equal(final.status, "partial_failed");
  assert.notEqual(stored.status, "succeeded");
  assert.equal(stored.agreement_status, "succeeded");
  assert.equal(stored.recycle_status, "skipped");
  assert.equal(address.status, "active");
  assert.equal(context.mailcomAliases.recycleCalls.length, 1);
  assert.ok(context.mailcomAliases.recycleCalls.every((call) => call.address !== protectedAttempt.email));
});

test("queued cleanup recycles still replace deleted-account aliases after pipeline cancellation", async (t) => {
  const gate = deferred();
  const context = harness(t, {
    accounts: [{ email: "owner@mail.com", aliases: ["first@email.com", "second@email.com"] }],
    paymentOutcomes: {
      "first@email.com": ["failed"],
      "second@email.com": ["failed"],
    },
    trialOutcomes: {
      "first@email.com": { status: "failed", message: "账号不存在" },
      "second@email.com": { status: "failed", message: "账号不存在" },
    },
    aliasOptions: { recycleGate: gate },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-queued-recycle-cancel-001",
    recycleSucceeded: true,
    linkAttempts: 1,
  }));
  await waitFor(
    () => ({
      calls: context.mailcomAliases.recycleCalls.length,
      recycling: context.db.prepare(`
        SELECT COUNT(*) AS count FROM mailcom_registration_pipeline_items
        WHERE pipeline_id = ? AND stage = 'recycling'
      `).get(started.id).count,
    }),
    (state) => state.calls === 1 && state.recycling === 2,
    "one active and one queued recycle",
  );
  const cancelled = await context.service.cancel(started.id);
  assert.equal(cancelled.status, "cancelled");
  gate.resolve();
  await waitFor(
    () => context.mailcomAliases.recycleCalls.length,
    (count) => count === 2,
    "cancelled cleanup recycle completion",
  );
  assert.equal(context.mailcomAliases.recycleCalls.length, 2);
  assert.deepEqual(
    new Set(context.mailcomAliases.recycleCalls.map((call) => call.address)),
    new Set(["first@email.com", "second@email.com"]),
  );
  assert.equal(context.service.get(started.id).status, "cancelled");
});

test("invalid registration proxy selection is rejected before task creation or alias preparation", async (t) => {
  const context = harness(t);
  context.registration.getProxyPool = () => [];
  await assert.rejects(
    context.service.start(input({ requestId: "mailcom-empty-proxy-pool-001" })),
    (error) => error.code === "MAILCOM_PIPELINE_PROXY_EMPTY" && error.status === 409,
  );
  await assert.rejects(
    context.service.start(input({
      requestId: "mailcom-missing-proxy-index-001",
      proxySelection: "proxy:3",
    })),
    (error) => error.code === "MAILCOM_PIPELINE_PROXY_NOT_FOUND" && error.status === 409,
  );
  assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM mailcom_registration_pipelines").get().count, 0);
  assert.equal(context.mailcomAliases.prepareCalls.length, 0);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
});

test("runtime proxy disappearance pauses the same attempt without recycling its alias", async (t) => {
  const context = harness(t);
  let reads = 0;
  context.registration.getProxyPool = () => (reads++ === 0 ? ["http://fixture-proxy.example:8080"] : []);
  const started = await context.service.start(input({
    requestId: "mailcom-runtime-proxy-change-001",
    recycleSucceeded: true,
  }));
  const waiting = await waitFor(
    () => context.service.get(started.id),
    (task) => task.items.some((item) => item.stage === "registration_runtime_retry_wait"),
    "runtime proxy retry state",
  );
  assert.equal(waiting.recycled_count, 0);
  assert.equal(context.registration.createCalls.length, 0);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  assert.ok(waiting.items.some((item) => /注册代理池为空/.test(item.error)));
  await context.service.cancel(started.id);
});

test("runtime registration queue pause is retried without consuming an official alias", async (t) => {
  const context = harness(t);
  let checks = 0;
  context.registration.registrationQueueControl = async () => ({ paused: checks++ > 0 });
  const started = await context.service.start(input({
    requestId: "mailcom-runtime-queue-pause-001",
    recycleSucceeded: true,
  }));
  const waiting = await waitFor(
    () => context.service.get(started.id),
    (task) => task.items.some((item) => item.stage === "registration_runtime_retry_wait"),
    "runtime queue retry state",
  );
  assert.equal(waiting.recycled_count, 0);
  assert.equal(context.registration.createCalls.length, 0);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  assert.ok(waiting.items.some((item) => /注册队列当前已暂停/.test(item.error)));
  await context.service.cancel(started.id);
});

test("an account disconnected after start pauses the same attempts before registration submission", async (t) => {
  const prepareGate = deferred();
  const context = harness(t, {
    aliasOptions: { prepareGate },
    serviceOptions: { sleepFn: () => new Promise(() => {}) },
  });
  const started = await context.service.start(input({
    requestId: "mailcom-runtime-account-disconnected-001",
    recycleSucceeded: true,
  }));
  context.db.prepare("UPDATE source_accounts SET status = 'disconnected', updated_at = ? WHERE id = ?")
    .run(nowIso(), context.fixtures[0].account.id);
  prepareGate.resolve();

  const waiting = await waitFor(
    () => context.service.get(started.id),
    (task) => task.items.some((item) => item.stage === "registration_runtime_retry_wait"),
    "disconnected account retry state",
  );
  assert.equal(context.registration.createCalls.length, 0);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  assert.ok(waiting.items.some((item) => /母号当前未连接/.test(item.error)));
  assert.ok(attempts(context.db, started.id).every((attempt) => (
    new Set(["queued", "running"]).has(attempt.status) && attempt.registration_status === "queued"
  )));
  await context.service.cancel(started.id);
});

test("an account disconnect racing createJobs pauses the submitted attempt without recycling", async (t) => {
  const context = harness(t, {
    serviceOptions: { sleepFn: () => new Promise(() => {}) },
  });
  context.registration.createJobs = async (jobInput) => {
    context.registration.createCalls.push(structuredClone(jobInput));
    context.db.prepare("UPDATE source_accounts SET status = 'disconnected', updated_at = ? WHERE id = ?")
      .run(nowIso(), jobInput.accountId);
    throw Object.assign(new Error("请先完成这个源头邮箱的连接验证"), { status: 409 });
  };

  const started = await context.service.start(input({
    requestId: "mailcom-runtime-account-race-001",
    recycleSucceeded: true,
  }));
  const waiting = await waitFor(
    () => context.service.get(started.id),
    (task) => task.items.some((item) => item.stage === "registration_runtime_retry_wait"),
    "racing account disconnect retry state",
  );
  const blocked = waiting.items.find((item) => item.stage === "registration_runtime_retry_wait");
  const history = attempts(context.db, started.id).filter((attempt) => attempt.item_id === blocked.id);
  assert.equal(context.registration.createCalls.length, 1);
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  assert.equal(history.length, 1);
  assert.equal(history[0].email, blocked.current_email);
  assert.ok(new Set(["queued", "running"]).has(history[0].status));
  assert.equal(history[0].registration_status, "queued");
  assert.equal(history[0].recycle_status, "pending");
  await context.service.cancel(started.id);
});

test("pickup protection rejection pauses the same attempt without recycling", async (t) => {
  const alias = "pickup-protected@email.com";
  const context = harness(t, {
    accounts: [{ email: "owner@mail.com", aliases: [alias] }],
    serviceOptions: { sleepFn: () => new Promise(() => {}) },
  });
  context.registration.createJobs = async (jobInput) => {
    context.registration.createCalls.push(structuredClone(jobInput));
    throw Object.assign(new Error("这个邮箱 already registered in 取件站售卖库存，不能用于注册"), {
      status: 409,
      code: "PICKUP_EMAIL_REGISTRATION_BLOCKED",
    });
  };

  const started = await context.service.start(input({
    requestId: "mailcom-pickup-protection-retry-001",
    recycleSucceeded: true,
  }));
  const waiting = await waitFor(
    () => context.service.get(started.id),
    (task) => task.items.some((item) => item.stage === "registration_runtime_retry_wait"),
    "pickup protection retry state",
  );
  const blocked = waiting.items.find((item) => item.stage === "registration_runtime_retry_wait");
  const history = attempts(context.db, started.id).filter((attempt) => attempt.item_id === blocked.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].email, blocked.current_email);
  assert.ok(new Set(["queued", "running"]).has(history[0].status));
  assert.equal(history[0].registration_status, "queued");
  assert.equal(history[0].recycle_status, "pending");
  assert.equal(blocked.current_attempt_id, history[0].id);
  assert.ok(context.registration.createCalls.some((call) => call.addressIds[0] === history[0].address_id));
  assert.equal(context.mailcomAliases.recycleCalls.length, 0);
  await context.service.cancel(started.id);
});

test("prepare failures remain in bounded recent errors while existing slots continue", async (t) => {
  const prepareFailure = Object.assign(new Error("fixture prepare unavailable"), {
    status: 503,
    code: "MAILCOM_ALIAS_AUTOMATION_FAILED",
  });
  const context = harness(t, { aliasOptions: { prepareFailures: [prepareFailure] } });
  const started = await context.service.start(input({ requestId: "mailcom-prepare-error-history-001" }));
  const final = await waitFor(() => context.service.get(started.id), (task) => task.terminal, "prepare error continuation");
  assert.equal(final.status, "completed");
  const prepareError = final.recent_errors.find((entry) => entry.stage === "prepare_failed");
  assert.ok(prepareError);
  assert.match(prepareError.error, /fixture prepare unavailable/);
  assert.equal(final.items.find((item) => item.slot_kind === "primary").prepare_error, "fixture prepare unavailable");
});

test("createApp exposes Mail.com pipeline routes and public pipeline errors", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-mailcom-pipeline-api-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const calls = [];
  const pipelines = {
    status: async () => ({
      route: "status",
      ready: false,
      recovery_active: true,
      recovering_recycle_count: 2,
      dependency: {
        ready: false,
        code: "MAILCOM_PIPELINE_RECOVERY_ACTIVE",
        error: "上次取消的 Mail.com 别名轮换正在恢复，请稍后重试",
      },
    }),
    list: (query) => ({
      route: "list",
      limit: query.limit,
      recovery_active: true,
      recovering_recycle_count: 2,
    }),
    start: async (body) => {
      calls.push({ method: "start", body });
      if (body.fail) {
        throw Object.assign(new Error("fixture pipeline conflict"), {
          status: 409,
          code: "MAILCOM_PIPELINE_FIXTURE_CONFLICT",
        });
      }
      return { route: "start", domain: body.domain };
    },
    get: (id) => ({ route: "get", id }),
    successfulAccounts: (id, query) => ({
      route: "successful-accounts", id, limit: query.limit, before_id: query.before_id,
    }),
    cancel: async (id) => ({ route: "cancel", id }),
    close: async () => undefined,
  };
  const originalPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = "";
  const runtime = createApp({ db, mailcomRegistrationPipelines: pipelines });
  if (originalPassword === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = originalPassword;
  await new Promise((resolve) => setImmediate(resolve));
  t.after(async () => {
    await runtime.microsoftRegistrationRunner.stopForShutdown();
    await runtime.icRegistrationPipelines.close();
    await runtime.openAiSms.close();
    await runtime.paymentAgreements.close();
    await runtime.nfapiCredentialSync?.close?.();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const status = await jsonRequest(runtime.app, "/api/registration/mailcom-pipelines/status");
  assert.equal(status.response.status, 200);
  assert.equal(status.body.route, "status");
  assert.equal(status.body.ready, false);
  assert.equal(status.body.recovery_active, true);
  assert.equal(status.body.recovering_recycle_count, 2);
  assert.equal(status.body.dependency.code, "MAILCOM_PIPELINE_RECOVERY_ACTIVE");
  const listed = await jsonRequest(runtime.app, "/api/registration/mailcom-pipelines?limit=3");
  assert.equal(listed.body.limit, "3");
  assert.equal(listed.body.recovery_active, true);
  assert.equal(listed.body.recovering_recycle_count, 2);
  const started = await jsonRequest(runtime.app, "/api/registration/mailcom-pipelines", {
    method: "POST",
    body: JSON.stringify({ domain: "mail.com" }),
  });
  assert.equal(started.response.status, 202);
  assert.equal(started.body.domain, "mail.com");
  assert.deepEqual(calls[0].body, { domain: "mail.com" });
  const fetched = await jsonRequest(runtime.app, "/api/registration/mailcom-pipelines/pipeline-1");
  assert.equal(fetched.body.id, "pipeline-1");
  const successful = await jsonRequest(
    runtime.app,
    "/api/registration/mailcom-pipelines/pipeline-1/successful-accounts?limit=12&before_id=44",
  );
  assert.equal(successful.response.status, 200);
  assert.deepEqual(successful.body, {
    route: "successful-accounts", id: "pipeline-1", limit: "12", before_id: "44",
  });
  const cancelled = await jsonRequest(runtime.app, "/api/registration/mailcom-pipelines/pipeline-1/cancel", {
    method: "POST",
  });
  assert.equal(cancelled.body.route, "cancel");
  const conflict = await jsonRequest(runtime.app, "/api/registration/mailcom-pipelines", {
    method: "POST",
    body: JSON.stringify({ fail: true }),
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error, "fixture pipeline conflict");
  assert.equal(conflict.body.code, "MAILCOM_PIPELINE_FIXTURE_CONFLICT");
});
