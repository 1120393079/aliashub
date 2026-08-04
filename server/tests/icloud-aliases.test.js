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
  setSetting(db, "registration_connector_key", "test-connector-key");
  const runtime = createApp({
    db,
    registrationClient: client,
    graph: { async scanInbox() { return { stage: "completed", messages: [], items: [] }; } },
    publicBaseUrl: "https://alias.test/alias-hub",
  });
  t.after(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const account = createConnectedAccount(db, "apple-account@qq.com");
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
    aliases: ["Life-Corers-77@icloud.com", "relay-abc@privaterelay.appleid.com"],
    type: "hide_my_email",
  });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.body.account.icloud_hide_my_emails, 2);
  const mailAlias = imported.body.items.find((item) => item.address === "work@me.com");
  const hidden = imported.body.items.find((item) => item.address === "life-corers-77@icloud.com");
  const relay = imported.body.items.find((item) => item.address === "relay-abc@privaterelay.appleid.com");
  assert.equal(mailAlias.strategy, "icloud_mail_alias");
  assert.equal(hidden.strategy, "icloud_hide_my_email");
  assert.equal(relay.strategy, "icloud_hide_my_email");

  const customDomains = await request(runtime.app, `/api/accounts/${account.id}/icloud-aliases/import`, {
    aliases: ["Apple@Ningdabbs.cn"],
    type: "custom_domain",
  });
  assert.equal(customDomains.response.status, 200);
  assert.equal(customDomains.body.account.icloud_custom_domain_emails, 1);
  const customDomain = customDomains.body.items.find((item) => item.address === "apple@ningdabbs.cn");
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

  const options = await jsonRequest(runtime.app, "/api/registration/options");
  assert.equal(options.response.status, 200);
  const optionAccount = options.body.accounts.find((item) => item.id === account.id);
  assert.equal(optionAccount.registration_mode, "direct");
  assert.equal(optionAccount.max_registration_count, 1);
  assert.equal(optionAccount.bases.find((item) => item.id === hidden.id).registration_state, "available");
  assert.equal(optionAccount.bases.find((item) => item.id === customDomain.id).registration_state, "available");

  const registered = await request(runtime.app, "/api/registration/jobs", {
    accountId: account.id,
    baseAddressId: customDomain.id,
    count: 1,
    suffix: "",
    browserMode: "headed",
  });
  assert.equal(registered.response.status, 202);
  assert.equal(registered.body.items.length, 1);
  assert.equal(registered.body.items[0].email, customDomain.address);
  assert.equal(client.created.length, 1);
  assert.equal(client.created[0].email, customDomain.address);
  assert.equal(client.created[0].extra.outlook_email_fixed_email, customDomain.address);
  assert.equal(client.created[0].extra.mail_source_provider, "icloud");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE account_id = ? AND kind = 'split'").get(account.id).count, 0);

  const batched = await request(runtime.app, "/api/registration/jobs", {
    accountId: account.id,
    baseAddressId: mailAlias.id,
    count: 2,
  });
  assert.equal(batched.response.status, 400);
  const suffixed = await request(runtime.app, "/api/registration/jobs", {
    accountId: account.id,
    baseAddressId: mailAlias.id,
    count: 1,
    suffix: "gpt",
  });
  assert.equal(suffixed.response.status, 400);
  const repeated = await request(runtime.app, "/api/registration/jobs", {
    accountId: account.id,
    baseAddressId: customDomain.id,
    count: 1,
  });
  assert.equal(repeated.response.status, 409);

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
