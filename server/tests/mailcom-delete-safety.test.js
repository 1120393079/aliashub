import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importMailcomAliases } from "../account-service.js";
import { MAILCOM_ALIAS_STRATEGY } from "../address-generator.js";
import { createDatabase, createSourceAccount, nowIso, setSetting } from "../db.js";
import { createApp } from "../index.js";
import { jsonRequest } from "./http-harness.js";

function context(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-mailcom-delete-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db") });
  const pickupState = { items: [], beforeReturn: null };
  const createdTasks = [];
  const pickup = {
    registrationProtectionEnabled() { return true; },
    async listStatuses() {
      await pickupState.beforeReturn?.();
      return { items: [...pickupState.items] };
    },
  };
  const registrationClient = {
    async health() { return { ok: true, configured: true }; },
    async createTask(payload) {
      createdTasks.push(payload);
      return { task_id: `mailcom-delete-task-${createdTasks.length}` };
    },
  };
  const runtime = createApp({ db, pickup, registrationClient });
  t.after(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { db, app: runtime.app, pickupState, createdTasks };
}

function connectedMailcomAccount(db, email = "mother@galaxyhit.com") {
  const account = createSourceAccount(db, {
    email,
    provider: "mailcom",
    officialLimit: 10,
  });
  db.prepare("UPDATE source_accounts SET status = 'connected', updated_at = ? WHERE id = ?")
    .run(nowIso(), account.id);
  setSetting(db, "registration_connector_key", "mailcom-delete-test-key");
  return db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id);
}

function mailcomAlias(db, account, email) {
  importMailcomAliases(db, account, [email]);
  return db.prepare(`
    SELECT * FROM addresses
    WHERE account_id = ? AND address = ? COLLATE NOCASE AND strategy = ?
  `).get(account.id, email, MAILCOM_ALIAS_STRATEGY);
}

function insertRegistrationJob(db, {
  accountId,
  addressId = null,
  email,
  status,
  failureReason = "",
}) {
  const now = nowIso();
  return Number(db.prepare(`
    INSERT INTO registration_jobs (
      account_id, address_id, base_address_id, email, status, stage,
      failure_reason, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accountId,
    addressId,
    addressId,
    email,
    status,
    status,
    failureReason,
    now,
    now,
    ["completed", "failed", "cancelled"].includes(status) ? now : null,
  ).lastInsertRowid);
}

function insertPipelineItem(db, account, address) {
  const at = nowIso();
  db.prepare(`
    INSERT INTO mailcom_registration_pipelines (
      id, request_id, request_fingerprint, domain, status, stage, concurrency,
      browser_mode, proxy_selection, payment_link_country, created_at, updated_at
    ) VALUES (?, ?, ?, 'email.com', 'running', 'registration', 1, 'headless', 'direct', 'US', ?, ?)
  `).run("reservation-pipeline", "reservation-request", "reservation-fingerprint", at, at);
  return Number(db.prepare(`
    INSERT INTO mailcom_registration_pipeline_items (
      pipeline_id, account_id, source_email, slot_key, slot_kind,
      initial_address_id, initial_email, current_address_id, current_email,
      status, stage, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'official', ?, ?, ?, ?, 'running', 'registration_queued', ?, ?)
  `).run(
    "reservation-pipeline",
    account.id,
    account.email,
    `official:${address.id}`,
    address.id,
    address.address,
    address.id,
    address.address,
    at,
    at,
  ).lastInsertRowid);
}

function insertTerminalRecycleRecovery(db, account, address, suffix = "terminal") {
  const at = nowIso();
  const pipelineId = `delete-recovery-${suffix}`;
  db.prepare(`
    INSERT INTO mailcom_registration_pipelines (
      id, request_id, request_fingerprint, domain, status, stage, concurrency,
      browser_mode, proxy_selection, payment_link_country, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, 'email.com', 'cancelled', 'cancelled', 1,
      'headless', 'direct', 'US', ?, ?, ?)
  `).run(pipelineId, `${pipelineId}-request`, `${pipelineId}-fingerprint`, at, at, at);
  const itemId = Number(db.prepare(`
    INSERT INTO mailcom_registration_pipeline_items (
      pipeline_id, account_id, source_email, slot_key, slot_kind,
      initial_address_id, initial_email, current_address_id, current_email,
      replacement_email, status, stage, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, 'official', ?, ?, ?, ?, ?, 'cancelled', 'cancelled', ?, ?, ?)
  `).run(
    pipelineId,
    account.id,
    account.email,
    `official:${address.id}`,
    address.id,
    address.address,
    address.id,
    address.address,
    `replacement-${suffix}@email.com`,
    at,
    at,
    at,
  ).lastInsertRowid);
  const attemptId = Number(db.prepare(`
    INSERT INTO mailcom_registration_pipeline_attempts (
      pipeline_id, item_id, attempt_number, address_id, email, status, stage,
      registration_status, link_status, recycle_status, recycle_attempts,
      recycle_error, next_retry_at, created_at, updated_at, finished_at
    ) VALUES (?, ?, 1, ?, ?, 'failed', 'orphan_recycle_retry_wait',
      'failed', 'skipped', 'running', 2, 'fixture recovery', ?, ?, ?, ?)
  `).run(pipelineId, itemId, address.id, address.address, at, at, at, at).lastInsertRowid);
  db.prepare(`
    UPDATE mailcom_registration_pipeline_items
    SET current_attempt_id = ? WHERE id = ?
  `).run(attemptId, itemId);
  return { pipelineId, itemId, attemptId };
}

test("Mail.com recycling reservation closes the createJobs pickup-wait race", async (t) => {
  const { db, app, pickupState, createdTasks } = context(t);
  const account = connectedMailcomAccount(db);
  const alias = mailcomAlias(db, account, "reservation@email.com");
  const itemId = insertPipelineItem(db, account, alias);
  pickupState.beforeReturn = () => {
    db.prepare(`
      UPDATE mailcom_registration_pipeline_items
      SET stage = 'recycling', status = 'running', updated_at = ? WHERE id = ?
    `).run(nowIso(), itemId);
    pickupState.beforeReturn = null;
  };

  const created = await jsonRequest(app, "/api/registration/jobs", {
    method: "POST",
    body: JSON.stringify({
      accountId: account.id,
      baseAddressId: alias.id,
      addressIds: [alias.id],
      count: 1,
      browserMode: "headless",
      proxySelection: "direct",
    }),
  });

  assert.equal(created.response.status, 409);
  assert.equal(created.body.code, "MAILCOM_ALIAS_RECYCLING_RESERVED");
  assert.equal(createdTasks.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM registration_jobs").get().count, 0);

  const at = nowIso();
  const attemptId = Number(db.prepare(`
    INSERT INTO mailcom_registration_pipeline_attempts (
      pipeline_id, item_id, attempt_number, address_id, email, status, stage,
      registration_status, link_status, recycle_status, created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, 'succeeded', 'recycling', 'succeeded', 'succeeded', 'running', ?, ?)
  `).run("reservation-pipeline", itemId, alias.id, alias.address, at, at).lastInsertRowid);
  db.prepare(`
    UPDATE mailcom_registration_pipeline_items
    SET current_attempt_id = ?, status = 'cancel_requested', stage = 'cancel_requested', updated_at = ?
    WHERE id = ?
  `).run(attemptId, nowIso(), itemId);
  const cancelledDuringRecycle = await jsonRequest(app, "/api/registration/jobs", {
    method: "POST",
    body: JSON.stringify({
      accountId: account.id,
      baseAddressId: alias.id,
      addressIds: [alias.id],
      count: 1,
      browserMode: "headless",
      proxySelection: "direct",
    }),
  });
  assert.equal(cancelledDuringRecycle.response.status, 409);
  assert.equal(cancelledDuringRecycle.body.code, "MAILCOM_ALIAS_RECYCLING_RESERVED");
  assert.equal(createdTasks.length, 0);

  const options = await jsonRequest(app, "/api/registration/options");
  assert.equal(options.response.status, 200);
  const direct = options.body.accounts.find((entry) => entry.id === account.id);
  const reserved = direct.bases.find((entry) => entry.id === alias.id);
  assert.equal(reserved.registration_state, "mailcom_recycling");
  assert.equal(reserved.registration_disabled, true);
  assert.equal(reserved.mailcom_recycling_reserved, true);
});

test("Mail.com alias removal paths reject active registrations and pickup inventory", async (t) => {
  const { db, app, pickupState } = context(t);
  const account = connectedMailcomAccount(db);
  const alias = mailcomAlias(db, account, "active@email.com");
  const jobId = insertRegistrationJob(db, {
    accountId: account.id,
    addressId: alias.id,
    email: alias.address,
    status: "running",
  });

  const single = await jsonRequest(app, `/api/addresses/${alias.id}`, { method: "DELETE" });
  assert.equal(single.response.status, 409);

  const bulk = await jsonRequest(app, "/api/addresses/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ accountId: account.id, ids: [alias.id] }),
  });
  assert.equal(bulk.response.status, 409);

  const activeReplace = await jsonRequest(app, `/api/accounts/${account.id}/mailcom-aliases/import`, {
    method: "POST",
    body: JSON.stringify({ aliases: [], replace: true }),
  });
  assert.equal(activeReplace.response.status, 409);
  assert.equal(db.prepare("SELECT status FROM addresses WHERE id = ?").get(alias.id).status, "active");

  db.prepare("UPDATE registration_jobs SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?")
    .run(nowIso(), nowIso(), jobId);
  pickupState.items.push({ email: alias.address, status: "SOLD" });
  const listedReplace = await jsonRequest(app, `/api/accounts/${account.id}/mailcom-aliases/import`, {
    method: "POST",
    body: JSON.stringify({ aliases: [], replace: true }),
  });
  assert.equal(listedReplace.response.status, 409);
  assert.equal(db.prepare("SELECT status FROM addresses WHERE id = ?").get(alias.id).status, "active");

  pickupState.items.length = 0;
  let lateAlias;
  let lateJobId;
  pickupState.beforeReturn = () => {
    lateAlias = mailcomAlias(db, account, "late@email.com");
    lateJobId = insertRegistrationJob(db, {
      accountId: account.id,
      addressId: lateAlias.id,
      email: lateAlias.address,
      status: "running",
    });
    pickupState.beforeReturn = null;
  };
  const racedReplace = await jsonRequest(app, `/api/accounts/${account.id}/mailcom-aliases/import`, {
    method: "POST",
    body: JSON.stringify({ aliases: [], replace: true }),
  });
  assert.equal(racedReplace.response.status, 409);
  assert.equal(db.prepare("SELECT status FROM addresses WHERE id = ?").get(alias.id).status, "active");
  assert.equal(db.prepare("SELECT status FROM addresses WHERE id = ?").get(lateAlias.id).status, "active");

  db.prepare(`
    UPDATE registration_jobs
    SET status = 'cancelled', finished_at = ?, updated_at = ?
    WHERE id IN (?, ?)
  `).run(nowIso(), nowIso(), jobId, lateJobId);
  const archived = await jsonRequest(app, `/api/accounts/${account.id}/mailcom-aliases/import`, {
    method: "POST",
    body: JSON.stringify({ aliases: [], replace: true }),
  });
  assert.equal(archived.response.status, 200);
  assert.deepEqual(
    db.prepare("SELECT status, remote_confirmed FROM addresses WHERE id = ?").get(alias.id),
    { status: "disabled", remote_confirmed: 0 },
  );
  assert.deepEqual(
    db.prepare("SELECT status, remote_confirmed FROM addresses WHERE id = ?").get(lateAlias.id),
    { status: "disabled", remote_confirmed: 0 },
  );
  const warehouse = await jsonRequest(app, `/api/addresses?accountId=${account.id}`);
  assert.equal(warehouse.response.status, 200);
  assert.equal(warehouse.body.items.some((item) => item.id === alias.id), false);
});

test("Mail.com deletion abandons terminal recovery but still blocks active pipeline items", async (t) => {
  const active = context(t);
  const activeAccount = connectedMailcomAccount(active.db, "active-delete@galaxyhit.com");
  const activeAlias = mailcomAlias(active.db, activeAccount, "active-delete@email.com");
  insertPipelineItem(active.db, activeAccount, activeAlias);
  const activeAliasDelete = await jsonRequest(active.app, `/api/addresses/${activeAlias.id}`, { method: "DELETE" });
  assert.equal(activeAliasDelete.response.status, 409);
  assert.equal(activeAliasDelete.body.code, "MAILCOM_PIPELINE_DELETE_CONFLICT");
  const activeAccountDelete = await jsonRequest(active.app, `/api/accounts/${activeAccount.id}`, { method: "DELETE" });
  assert.equal(activeAccountDelete.response.status, 409);
  assert.ok(active.db.prepare("SELECT 1 FROM source_accounts WHERE id = ?").get(activeAccount.id));

  const terminalAlias = context(t);
  const aliasAccount = connectedMailcomAccount(terminalAlias.db, "alias-delete@galaxyhit.com");
  const alias = mailcomAlias(terminalAlias.db, aliasAccount, "terminal-delete@email.com");
  const aliasRecovery = insertTerminalRecycleRecovery(terminalAlias.db, aliasAccount, alias, "alias");
  const aliasDelete = await jsonRequest(terminalAlias.app, `/api/addresses/${alias.id}`, { method: "DELETE" });
  assert.equal(aliasDelete.response.status, 204);
  assert.deepEqual(
    terminalAlias.db.prepare("SELECT recycle_status, stage, next_retry_at FROM mailcom_registration_pipeline_attempts WHERE id = ?")
      .get(aliasRecovery.attemptId),
    { recycle_status: "skipped", stage: "recycle_abandoned", next_retry_at: null },
  );
  assert.deepEqual(
    terminalAlias.db.prepare("SELECT replacement_email, next_retry_at FROM mailcom_registration_pipeline_items WHERE id = ?")
      .get(aliasRecovery.itemId),
    { replacement_email: "", next_retry_at: null },
  );

  const terminalAccount = context(t);
  const account = connectedMailcomAccount(terminalAccount.db, "mother-delete@galaxyhit.com");
  const accountAlias = mailcomAlias(terminalAccount.db, account, "mother-terminal@email.com");
  const accountRecovery = insertTerminalRecycleRecovery(terminalAccount.db, account, accountAlias, "account");
  const accountDelete = await jsonRequest(terminalAccount.app, `/api/accounts/${account.id}`, { method: "DELETE" });
  assert.equal(accountDelete.response.status, 204);
  assert.equal(terminalAccount.db.prepare("SELECT 1 FROM source_accounts WHERE id = ?").get(account.id), undefined);
  assert.deepEqual(
    terminalAccount.db.prepare("SELECT recycle_status, stage FROM mailcom_registration_pipeline_attempts WHERE id = ?")
      .get(accountRecovery.attemptId),
    { recycle_status: "skipped", stage: "recycle_abandoned" },
  );
  assert.equal(
    terminalAccount.db.prepare("SELECT account_id FROM mailcom_registration_pipeline_items WHERE id = ?")
      .get(accountRecovery.itemId).account_id,
    null,
  );
});

test("Mail.com alias reimport preserves completed and occupied registration history", async (t) => {
  const { db, app, createdTasks } = context(t);
  const account = connectedMailcomAccount(db);
  const completedAlias = mailcomAlias(db, account, "completed@email.com");
  const completedJobId = insertRegistrationJob(db, {
    accountId: account.id,
    addressId: completedAlias.id,
    email: completedAlias.address,
    status: "completed",
  });

  const removed = await jsonRequest(app, `/api/addresses/${completedAlias.id}`, { method: "DELETE" });
  assert.equal(removed.response.status, 204);
  assert.equal(db.prepare("SELECT status FROM addresses WHERE id = ?").get(completedAlias.id).status, "disabled");
  assert.deepEqual(
    db.prepare("SELECT address_id, base_address_id FROM registration_jobs WHERE id = ?").get(completedJobId),
    { address_id: completedAlias.id, base_address_id: completedAlias.id },
  );

  const restored = await jsonRequest(app, `/api/accounts/${account.id}/mailcom-aliases/import`, {
    method: "POST",
    body: JSON.stringify({ aliases: [completedAlias.address], replace: true }),
  });
  assert.equal(restored.response.status, 200);
  const restoredAlias = db.prepare("SELECT * FROM addresses WHERE id = ?").get(completedAlias.id);
  assert.equal(restoredAlias.status, "active");
  assert.equal(restoredAlias.remote_confirmed, 1);

  let options = await jsonRequest(app, "/api/registration/options");
  let direct = options.body.accounts.find((item) => item.id === account.id);
  let restoredOption = direct.bases.find((item) => item.id === completedAlias.id);
  assert.equal(restoredOption.registration_state, "used");
  assert.equal(restoredOption.registration_disabled, true);

  const completedRetry = await jsonRequest(app, "/api/registration/jobs", {
    method: "POST",
    body: JSON.stringify({ accountId: account.id, baseAddressId: completedAlias.id, count: 1 }),
  });
  assert.equal(completedRetry.response.status, 409);

  const occupiedAlias = mailcomAlias(db, account, "occupied@email.com");
  const occupiedJobId = insertRegistrationJob(db, {
    accountId: account.id,
    addressId: occupiedAlias.id,
    email: occupiedAlias.address,
    status: "failed",
    failureReason: "user_already_exists",
  });
  db.prepare("DELETE FROM addresses WHERE id = ?").run(occupiedAlias.id);
  assert.deepEqual(
    db.prepare("SELECT address_id, base_address_id FROM registration_jobs WHERE id = ?").get(occupiedJobId),
    { address_id: null, base_address_id: null },
  );

  const legacyRestored = await jsonRequest(app, `/api/accounts/${account.id}/mailcom-aliases/import`, {
    method: "POST",
    body: JSON.stringify({ aliases: [completedAlias.address, occupiedAlias.address], replace: true }),
  });
  assert.equal(legacyRestored.response.status, 200);
  const newOccupiedAlias = db.prepare("SELECT * FROM addresses WHERE account_id = ? AND address = ? COLLATE NOCASE")
    .get(account.id, occupiedAlias.address);
  assert.notEqual(newOccupiedAlias.id, occupiedAlias.id);
  assert.deepEqual(
    db.prepare("SELECT address_id, base_address_id FROM registration_jobs WHERE id = ?").get(occupiedJobId),
    { address_id: newOccupiedAlias.id, base_address_id: newOccupiedAlias.id },
  );

  db.prepare("UPDATE registration_jobs SET account_id = NULL, address_id = NULL, base_address_id = NULL WHERE id = ?")
    .run(occupiedJobId);
  options = await jsonRequest(app, "/api/registration/options");
  direct = options.body.accounts.find((item) => item.id === account.id);
  restoredOption = direct.bases.find((item) => item.id === newOccupiedAlias.id);
  assert.equal(restoredOption.registration_state, "occupied");
  assert.equal(restoredOption.registration_disabled, true);

  const occupiedRetry = await jsonRequest(app, "/api/registration/jobs", {
    method: "POST",
    body: JSON.stringify({ accountId: account.id, baseAddressId: newOccupiedAlias.id, count: 1 }),
  });
  assert.equal(occupiedRetry.response.status, 409);
  assert.equal(createdTasks.length, 0);
});

test("Mail.com mother removal protects active and listed addresses without losing email history", async (t) => {
  const { db, app, pickupState, createdTasks } = context(t);
  const account = connectedMailcomAccount(db);
  const primary = db.prepare("SELECT * FROM addresses WHERE account_id = ? AND kind = 'primary'")
    .get(account.id);
  const jobId = insertRegistrationJob(db, {
    accountId: account.id,
    addressId: primary.id,
    email: primary.address,
    status: "running",
  });

  const activeRemoval = await jsonRequest(app, `/api/accounts/${account.id}`, { method: "DELETE" });
  assert.equal(activeRemoval.response.status, 409);
  assert.ok(db.prepare("SELECT 1 FROM source_accounts WHERE id = ?").get(account.id));

  db.prepare(`
    UPDATE registration_jobs
    SET status = 'completed', stage = 'completed', finished_at = ?, updated_at = ?
    WHERE id = ?
  `).run(nowIso(), nowIso(), jobId);

  let lateAlias;
  let lateJobId;
  pickupState.beforeReturn = () => {
    lateAlias = mailcomAlias(db, account, "late-mother@email.com");
    lateJobId = insertRegistrationJob(db, {
      accountId: account.id,
      addressId: lateAlias.id,
      email: lateAlias.address,
      status: "running",
    });
    pickupState.beforeReturn = null;
  };
  const racedRemoval = await jsonRequest(app, `/api/accounts/${account.id}`, { method: "DELETE" });
  assert.equal(racedRemoval.response.status, 409);
  assert.ok(db.prepare("SELECT 1 FROM source_accounts WHERE id = ?").get(account.id));
  assert.equal(db.prepare("SELECT status FROM addresses WHERE id = ?").get(lateAlias.id).status, "active");
  db.prepare("UPDATE registration_jobs SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?")
    .run(nowIso(), nowIso(), lateJobId);

  pickupState.items.push({ email: primary.address, status: "ready" });
  const listedRemoval = await jsonRequest(app, `/api/accounts/${account.id}`, { method: "DELETE" });
  assert.equal(listedRemoval.response.status, 409);
  assert.ok(db.prepare("SELECT 1 FROM source_accounts WHERE id = ?").get(account.id));

  pickupState.items.length = 0;
  const removed = await jsonRequest(app, `/api/accounts/${account.id}`, { method: "DELETE" });
  assert.equal(removed.response.status, 204);
  assert.equal(db.prepare("SELECT 1 FROM source_accounts WHERE id = ?").get(account.id), undefined);
  assert.deepEqual(
    db.prepare("SELECT account_id, address_id, base_address_id FROM registration_jobs WHERE id = ?").get(jobId),
    { account_id: null, address_id: null, base_address_id: null },
  );

  const restoredAccount = connectedMailcomAccount(db);
  assert.notEqual(restoredAccount.id, account.id);
  const restoredPrimary = db.prepare("SELECT * FROM addresses WHERE account_id = ? AND kind = 'primary'")
    .get(restoredAccount.id);
  const options = await jsonRequest(app, "/api/registration/options");
  const direct = options.body.accounts.find((item) => item.id === restoredAccount.id);
  const restoredOption = direct.bases.find((item) => item.id === restoredPrimary.id);
  assert.equal(restoredOption.registration_state, "used");
  assert.equal(restoredOption.registration_disabled, true);

  const retry = await jsonRequest(app, "/api/registration/jobs", {
    method: "POST",
    body: JSON.stringify({ accountId: restoredAccount.id, baseAddressId: restoredPrimary.id, count: 1 }),
  });
  assert.equal(retry.response.status, 409);
  assert.equal(createdTasks.length, 0);
});
