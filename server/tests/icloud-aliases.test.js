import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistInboxScanResult } from "../account-service.js";
import { createDatabase, createSourceAccount, nowIso, setSetting } from "../db.js";
import { createApp } from "../index.js";
import { jsonRequest } from "./http-harness.js";

class RegistrationClientStub {
  constructor() {
    this.created = [];
  }

  async health() { return { ok: true, configured: true }; }

  async createTask(payload) {
    this.created.push(payload);
    return { task_id: `icloud-task-${this.created.length}` };
  }
}

function createConnectedAccount(db, email, provider = "icloud") {
  const account = createSourceAccount(db, { email, provider });
  db.prepare("UPDATE source_accounts SET status = 'connected', updated_at = ? WHERE id = ?")
    .run(nowIso(), account.id);
  return db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id);
}

function request(app, pathname, body) {
  return jsonRequest(app, pathname, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

test("iCloud aliases, Hide My Email, and custom-domain addresses import, receive mail, and register directly", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-icloud-aliases-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const client = new RegistrationClientStub();
  let pickupItems = [];
  let pickupFailure = false;
  const pickup = {
    registrationProtectionEnabled() { return true; },
    async listStatuses() {
      if (pickupFailure) throw new Error("pickup unavailable");
      return { items: pickupItems };
    },
  };
  setSetting(db, "registration_connector_key", "test-connector-key");
  const runtime = createApp({
    db,
    registrationClient: client,
    pickup,
    graph: { async scanInbox() { return { stage: "completed", messages: [], items: [] }; } },
    publicBaseUrl: "https://alias.test/alias-hub",
  });
  t.after(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const account = createConnectedAccount(db, "icloud-owner@example.com");
  const wrongType = await request(runtime.app, `/api/accounts/${account.id}/icloud-aliases/import`, {
    aliases: ["relay-abc@privaterelay.appleid.com"],
    type: "mail_alias",
  });
  assert.equal(wrongType.response.status, 400);
  const mailAliases = await request(runtime.app, `/api/accounts/${account.id}/icloud-aliases/import`, {
    aliases: ["Work@Me.com"],
    type: "mail_alias",
  });
  assert.equal(mailAliases.response.status, 200);
  assert.equal(mailAliases.body.account.icloud_mail_aliases, 1);
  const imported = await request(runtime.app, `/api/accounts/${account.id}/icloud-aliases/import`, {
    aliases: ["fixture-hidden@icloud.com", "fixture-relay@privaterelay.appleid.com"],
    type: "hide_my_email",
  });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.body.account.icloud_hide_my_emails, 2);
  const mailAlias = imported.body.items.find((item) => item.address === "work@me.com");
  const hidden = imported.body.items.find((item) => item.address === "fixture-hidden@icloud.com");
  const relay = imported.body.items.find((item) => item.address === "fixture-relay@privaterelay.appleid.com");
  assert.equal(mailAlias.strategy, "icloud_mail_alias");
  assert.equal(hidden.strategy, "icloud_hide_my_email");
  assert.equal(relay.strategy, "icloud_hide_my_email");

  const customDomains = await request(runtime.app, `/api/accounts/${account.id}/icloud-aliases/import`, {
    aliases: ["Alias@Custom.Example"],
    type: "custom_domain",
  });
  assert.equal(customDomains.response.status, 200);
  assert.equal(customDomains.body.account.icloud_custom_domain_emails, 1);
  const customDomain = customDomains.body.items.find((item) => item.address === "alias@custom.example");
  assert.equal(customDomain.strategy, "icloud_custom_domain");

  const wrongCustomType = await request(runtime.app, `/api/accounts/${account.id}/icloud-aliases/import`, {
    aliases: ["not-custom@icloud.com"],
    type: "custom_domain",
  });
  assert.equal(wrongCustomType.response.status, 400);

  const wrongHiddenType = await request(runtime.app, `/api/accounts/${account.id}/icloud-aliases/import`, {
    aliases: ["not-hidden@me.com"],
    type: "hide_my_email",
  });
  assert.equal(wrongHiddenType.response.status, 400);

  const invalid = await request(runtime.app, `/api/accounts/${account.id}/icloud-aliases/import`, {
    aliases: ["would-not-be-written@icloud.com", "invalid@example.com"],
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE account_id = ? AND address = ?").get(account.id, "would-not-be-written@icloud.com").count, 0);

  const otherIcloud = createConnectedAccount(db, "other@icloud.com");
  const duplicate = await request(runtime.app, `/api/accounts/${otherIcloud.id}/icloud-aliases/import`, {
    aliases: [hidden.address],
    type: "hide_my_email",
  });
  assert.equal(duplicate.response.status, 409);
  const microsoft = createConnectedAccount(db, "source@outlook.com", "microsoft");
  const wrongProvider = await request(runtime.app, `/api/accounts/${microsoft.id}/icloud-aliases/import`, {
    aliases: ["other@icloud.com"],
  });
  assert.equal(wrongProvider.response.status, 409);

  const persisted = persistInboxScanResult(db, account, {
    messages: [{
      fingerprint: "relay-message-fingerprint",
      graphMessageId: "icloud:1:501",
      recipient: account.email,
      recipients: [account.email, hidden.address],
      senderName: "OpenAI",
      senderAddress: "noreply@example.com",
      subject: "Verification code 482913",
      preview: "Your verification code is 482913",
      body: "Your verification code is 482913",
      verificationCode: "482913",
      receivedAt: "2026-07-22T12:00:00.000Z",
    }],
    items: [{
      fingerprint: "relay-code-fingerprint",
      code: "482913",
      sender: "OpenAI",
      subject: "Verification code 482913",
      preview: "Your verification code is 482913",
      recipient: account.email,
      recipients: [account.email, hidden.address],
      receivedAt: "2026-07-22T12:00:00.000Z",
    }],
  });
  assert.equal(persisted.messages.added, 1);
  assert.equal(db.prepare("SELECT address_id, recipient_address FROM mail_messages WHERE graph_message_id = ?").get("icloud:1:501").address_id, hidden.id);
  assert.equal(db.prepare("SELECT recipient_address FROM mail_messages WHERE graph_message_id = ?").get("icloud:1:501").recipient_address, hidden.address);
  assert.equal(db.prepare("SELECT address_id FROM verification_codes WHERE fingerprint = ?").get("relay-code-fingerprint").address_id, hidden.id);
  const relayEmails = await jsonRequest(runtime.app, `/api/external/emails?email=${encodeURIComponent(hidden.address)}`, {
    headers: { "x-api-key": "test-connector-key" },
  });
  assert.equal(relayEmails.response.status, 200);
  assert.equal(relayEmails.body.emails[0].verification_code, "482913");

  persistInboxScanResult(db, account, {
    messages: [{
      fingerprint: "custom-domain-message-fingerprint",
      graphMessageId: "icloud:1:502",
      recipient: customDomain.address,
      recipients: [customDomain.address],
      senderName: "OpenAI",
      senderAddress: "noreply@example.com",
      subject: "Verification code 739251",
      preview: "Your verification code is 739251",
      body: "Your verification code is 739251",
      verificationCode: "739251",
      receivedAt: "2026-07-22T12:01:00.000Z",
    }],
    items: [{
      fingerprint: "custom-domain-code-fingerprint",
      code: "739251",
      sender: "OpenAI",
      subject: "Verification code 739251",
      preview: "Your verification code is 739251",
      recipient: customDomain.address,
      recipients: [customDomain.address],
      receivedAt: "2026-07-22T12:01:00.000Z",
    }],
  });
  assert.equal(db.prepare("SELECT address_id FROM mail_messages WHERE graph_message_id = ?").get("icloud:1:502").address_id, customDomain.id);
  const customDomainEmails = await jsonRequest(runtime.app, `/api/external/emails?email=${encodeURIComponent(customDomain.address)}`, {
    headers: { "x-api-key": "test-connector-key" },
  });
  assert.equal(customDomainEmails.response.status, 200);
  assert.equal(customDomainEmails.body.emails[0].verification_code, "739251");

  const failedAt = "2026-07-22T12:01:30.000Z";
  db.prepare(`
    INSERT INTO registration_jobs (
      account_id, address_id, base_address_id, email, status, stage, browser_mode,
      message, failure_reason, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, 'failed', 'about_you', 'headed', '注册失败',
      'registration_disallowed', ?, ?, ?)
  `).run(account.id, hidden.id, hidden.id, hidden.address, failedAt, failedAt, failedAt);

  const options = await jsonRequest(runtime.app, "/api/registration/options");
  assert.equal(options.response.status, 200);
  const optionAccount = options.body.accounts.find((item) => item.id === account.id);
  assert.equal(optionAccount.registration_mode, "direct");
  assert.equal(optionAccount.max_registration_count, 5);
  const failedOption = optionAccount.bases.find((item) => item.id === hidden.id);
  assert.equal(failedOption.registration_state, "available");
  assert.equal(failedOption.registration_failure_count, 1);
  assert.equal(failedOption.last_registration_failure_at, failedAt);
  assert.equal(failedOption.registration_disabled, false);
  assert.equal(optionAccount.bases.find((item) => item.id === customDomain.id).registration_state, "available");

  const listedAddress = optionAccount.bases[3];
  pickupItems = [{ email: listedAddress.address, status: "ready" }];
  const protectedOptions = await jsonRequest(runtime.app, "/api/registration/options");
  const protectedAccount = protectedOptions.body.accounts.find((item) => item.id === account.id);
  const protectedAddress = protectedAccount.bases.find((item) => item.id === listedAddress.id);
  assert.equal(protectedAddress.registration_state, "pickup_listed");
  assert.equal(protectedAddress.registration_disabled, true);
  assert.equal(protectedAddress.pickup_status, "ready");
  assert.match(protectedAddress.registration_hint, /必须先从取件站删除/);
  assert.equal(protectedAccount.max_registration_count, 4);

  const listedRegistration = await request(runtime.app, "/api/registration/jobs", {
    accountId: account.id,
    baseAddressId: listedAddress.id,
    count: 1,
  });
  assert.equal(listedRegistration.response.status, 409);
  assert.match(listedRegistration.body.error, /取件站售卖库存/);
  assert.equal(client.created.length, 0);

  pickupFailure = true;
  const unavailableRegistration = await request(runtime.app, "/api/registration/jobs", {
    accountId: account.id,
    baseAddressId: optionAccount.bases[1].id,
    count: 1,
  });
  assert.equal(unavailableRegistration.response.status, 409);
  assert.match(unavailableRegistration.body.error, /为避免误用售卖邮箱/);
  assert.equal(client.created.length, 0);
  pickupFailure = false;

  const skippedAddress = optionAccount.bases[2];
  const skippedAt = "2026-07-22T12:02:00.000Z";
  const skippedJobId = Number(db.prepare(`
    INSERT INTO registration_jobs (
      account_id, address_id, base_address_id, email, status, stage, browser_mode,
      message, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, 'completed', 'completed', 'headed', '注册完成', ?, ?, ?)
  `).run(account.id, skippedAddress.id, skippedAddress.id, skippedAddress.address, skippedAt, skippedAt, skippedAt).lastInsertRowid);

  const orderedOptions = await jsonRequest(runtime.app, "/api/registration/options");
  const orderedBases = orderedOptions.body.accounts.find((item) => item.id === account.id).bases;
  const batchStart = orderedBases[1];
  const expectedBatch = orderedBases.slice(1).filter((item) => !item.registration_disabled).slice(0, 3);
  assert.equal(orderedBases[2].registration_state, "used");
  assert.equal(orderedOptions.body.accounts.find((item) => item.id === account.id).max_registration_count, 3);

  const registered = await request(runtime.app, "/api/registration/jobs", {
    accountId: account.id,
    baseAddressId: batchStart.id,
    count: expectedBatch.length,
    suffix: "",
    browserMode: "headed",
  });
  assert.equal(registered.response.status, 202);
  assert.deepEqual(registered.body.items.map((item) => item.email), expectedBatch.map((item) => item.address));
  assert.deepEqual(client.created.map((item) => item.email), expectedBatch.map((item) => item.address));
  assert.deepEqual(client.created.map((item) => item.extra.outlook_email_fixed_email), expectedBatch.map((item) => item.address));
  assert.ok(client.created.every((item) => item.extra.mail_source_provider === "icloud"));
  assert.deepEqual(
    db.prepare("SELECT email, address_id, base_address_id FROM registration_jobs WHERE id > ? ORDER BY id").all(skippedJobId),
    expectedBatch.map((item) => ({ email: item.address, address_id: item.id, base_address_id: item.id })),
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE account_id = ? AND kind = 'split'").get(account.id).count, 0);

  const overflowStart = orderedBases.find((item) => !item.registration_disabled && !expectedBatch.some((selected) => selected.id === item.id));
  const overflow = await request(runtime.app, "/api/registration/jobs", {
    accountId: account.id,
    baseAddressId: overflowStart.id,
    count: 2,
  });
  assert.equal(overflow.response.status, 409);
  assert.match(overflow.body.error, /仅有 1 个可用地址/);
  const suffixed = await request(runtime.app, "/api/registration/jobs", {
    accountId: account.id,
    baseAddressId: overflowStart.id,
    count: 1,
    suffix: "gpt",
  });
  assert.equal(suffixed.response.status, 400);
  const repeated = await request(runtime.app, "/api/registration/jobs", {
    accountId: account.id,
    baseAddressId: batchStart.id,
    count: 1,
  });
  assert.equal(repeated.response.status, 409);

  db.prepare("DELETE FROM registration_jobs WHERE id = ?").run(skippedJobId);

  const clearedCustomDomains = await request(runtime.app, `/api/accounts/${account.id}/icloud-aliases/import`, {
    aliases: [],
    type: "custom_domain",
    replace: true,
  });
  assert.equal(clearedCustomDomains.response.status, 200);
  assert.equal(clearedCustomDomains.body.account.icloud_custom_domain_emails, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE id = ?").get(customDomain.id).count, 0);

  const removed = await jsonRequest(runtime.app, `/api/addresses/${mailAlias.id}`, { method: "DELETE" });
  assert.equal(removed.response.status, 204);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE id = ?").get(mailAlias.id).count, 0);
  const primary = db.prepare("SELECT id FROM addresses WHERE account_id = ? AND kind = 'primary'").get(account.id);
  const primaryDelete = await jsonRequest(runtime.app, `/api/addresses/${primary.id}`, { method: "DELETE" });
  assert.equal(primaryDelete.response.status, 409);
});

test("address warehouse selects current registration failures and bulk deletes local iCloud mappings", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-failed-addresses-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  let pickupItems = [];
  const runtime = createApp({
    db,
    registrationClient: new RegistrationClientStub(),
    graph: { async scanInbox() { return { stage: "completed", messages: [], items: [] }; } },
    pickup: {
      registrationProtectionEnabled() { return true; },
      async listStatuses() { return { items: pickupItems }; },
    },
  });
  t.after(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const account = createConnectedAccount(db, "warehouse-owner@icloud.com");
  const imported = await request(runtime.app, `/api/accounts/${account.id}/icloud-aliases/import`, {
    aliases: [
      "failed-delete@icloud.com",
      "recovered-keep@icloud.com",
      "listed-keep@icloud.com",
      "active-keep@icloud.com",
    ],
    type: "hide_my_email",
  });
  assert.equal(imported.response.status, 200);
  const byAddress = new Map(imported.body.items.map((item) => [item.address, item]));
  const insertJob = db.prepare(`
    INSERT INTO registration_jobs (
      account_id, address_id, base_address_id, email, status, stage, browser_mode,
      message, failure_reason, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, 'register', 'headed', ?, ?, ?, ?, ?)
  `);
  const addJob = (address, status, createdAt) => insertJob.run(
    account.id,
    address.id,
    address.id,
    address.address,
    status,
    status,
    status === "failed" ? "registration_disallowed" : "",
    createdAt,
    createdAt,
    ["queued", "running"].includes(status) ? null : createdAt,
  );
  const failed = byAddress.get("failed-delete@icloud.com");
  const recovered = byAddress.get("recovered-keep@icloud.com");
  const listed = byAddress.get("listed-keep@icloud.com");
  const active = byAddress.get("active-keep@icloud.com");
  addJob(failed, "failed", "2026-08-15T01:00:00.000Z");
  addJob(recovered, "failed", "2026-08-15T01:00:01.000Z");
  addJob(recovered, "completed", "2026-08-15T01:00:02.000Z");
  addJob(listed, "failed", "2026-08-15T01:00:03.000Z");
  addJob(active, "failed", "2026-08-15T01:00:04.000Z");
  addJob(active, "running", "2026-08-15T01:00:05.000Z");

  const addresses = await jsonRequest(
    runtime.app,
    `/api/addresses?accountId=${account.id}&kind=official&strategy=icloud_hide_my_email`,
  );
  assert.equal(addresses.response.status, 200);
  const listedByAddress = new Map(addresses.body.items.map((item) => [item.address, item]));
  assert.equal(listedByAddress.get(failed.address).registration_failed, true);
  assert.equal(listedByAddress.get(failed.address).registration_failure_count, 1);
  assert.equal(listedByAddress.get(recovered.address).registration_failed, false);
  assert.equal(listedByAddress.get(recovered.address).registration_failure_count, 1);
  assert.equal(listedByAddress.get(active.address).registration_failed, false);

  const selectable = await jsonRequest(
    runtime.app,
    `/api/addresses/registration-failures?accountId=${account.id}&kind=official&strategy=icloud_hide_my_email`,
  );
  assert.equal(selectable.response.status, 200);
  assert.equal(selectable.body.count, 2);
  assert.deepEqual(new Set(selectable.body.ids), new Set([failed.id, listed.id]));

  const activeDelete = await jsonRequest(runtime.app, "/api/addresses/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ ids: [active.id], accountId: account.id }),
  });
  assert.equal(activeDelete.response.status, 409);
  assert.match(activeDelete.body.error, /正在注册/);

  pickupItems = [{ email: listed.address, status: "ready" }];
  const blocked = await jsonRequest(runtime.app, "/api/addresses/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ ids: selectable.body.ids, accountId: account.id }),
  });
  assert.equal(blocked.response.status, 409);
  assert.match(blocked.body.error, /售卖库存/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE id IN (?, ?)").get(failed.id, listed.id).count, 2);

  pickupItems = [];
  const removed = await jsonRequest(runtime.app, "/api/addresses/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ ids: selectable.body.ids, accountId: account.id }),
  });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.body.deleted, 2);
  assert.equal(removed.body.imported_icloud_deleted, 2);
  assert.equal(removed.body.split_deleted, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE id IN (?, ?)").get(failed.id, listed.id).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE id IN (?, ?)").get(recovered.id, active.id).count, 2);

  const primary = db.prepare("SELECT id FROM addresses WHERE account_id = ? AND kind = 'primary'").get(account.id);
  const invalid = await jsonRequest(runtime.app, "/api/addresses/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ ids: [primary.id], accountId: account.id }),
  });
  assert.equal(invalid.response.status, 409);
  assert.match(invalid.body.error, /不能从本地删除/);
});

test("iCloud privacy internal API imports and removes generated hidden mailboxes", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-icloud-privacy-internal-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const runtime = createApp({
    db,
    icloudPrivacyInternalKey: "internal-secret",
    registrationClient: new RegistrationClientStub(),
    graph: { async scanInbox() { return { stage: "completed", messages: [], items: [] }; } },
    pickup: { registrationProtectionEnabled() { return false; } },
  });
  t.after(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const account = createConnectedAccount(db, "owner@icloud.com");
  const unauthorized = await jsonRequest(runtime.app, "/api/internal/icloud-privacy/import", {
    method: "POST",
    body: JSON.stringify({ source_account_id: account.id, emails: ["generated@icloud.com"] }),
  });
  assert.equal(unauthorized.response.status, 401);

  const headers = { "x-alias-hub-internal-key": "internal-secret" };
  const imported = await jsonRequest(runtime.app, "/api/internal/icloud-privacy/import", {
    method: "POST",
    headers,
    body: JSON.stringify({
      source_account_id: account.id,
      source_apple_id: account.email,
      emails: ["Generated@icloud.com"],
    }),
  });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.body.imported, 1);
  assert.equal(imported.body.items[0].strategy, "icloud_hide_my_email");
  assert.equal(imported.body.items[0].purpose, "Apple 新接口创建");
  const filtered = await jsonRequest(runtime.app, `/api/addresses?accountId=${account.id}&strategy=icloud_hide_my_email`);
  assert.equal(filtered.response.status, 200);
  assert.equal(filtered.body.total, 1);
  assert.equal(filtered.body.items[0].address, "generated@icloud.com");

  const removed = await jsonRequest(runtime.app, "/api/internal/icloud-privacy/address", {
    method: "DELETE",
    headers,
    body: JSON.stringify({ source_account_id: account.id, email: "generated@icloud.com" }),
  });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.body.deleted, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE account_id = ? AND address = ?").get(account.id, "generated@icloud.com").count, 0);
});
