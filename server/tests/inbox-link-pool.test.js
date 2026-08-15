import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../db.js";
import { parseInboxLinkPool } from "../inbox-link-pool.js";
import { createApp, inboxLinkChatgptStatus } from "../index.js";
import { jsonRequest } from "./http-harness.js";

const poolText = [
  "fixture-one@icloud.com https://dispose.lol/ib/test-mailbox-key-0001",
  "fixture-two@icloud.com https://dispose.lol/ib/test-mailbox-key-0002",
  "fixture-three@icloud.com https://dispose.lol/ib/test-mailbox-key-0003",
].join("\r\n");

test("parses arbitrary HTTPS inbox links and deduplicates exact rows", () => {
  const entries = parseInboxLinkPool(`${poolText}\n${poolText.split(/\r?\n/)[0]}`);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].email, "fixture-one@icloud.com");
  assert.equal(entries[0].inboxLink, "https://dispose.lol/ib/test-mailbox-key-0001");
  assert.equal(entries[0].maskedLink, "https://dispose.lol/ib/test...0001");

  const generic = parseInboxLinkPool(
    "buyer@custom-domain.example https://pickup.example.net/p/signed-token-1234?view=mail#latest",
  )[0];
  assert.equal(generic.email, "buyer@custom-domain.example");
  assert.equal(generic.inboxLink, "https://pickup.example.net/p/signed-token-1234?view=mail#latest");
  assert.doesNotMatch(generic.maskedLink, /signed-token-1234|latest/);
});

test("rejects invalid or conflicting inbox-link rows without echoing the key", () => {
  const invalidRows = [
    "not-an-email https://dispose.lol/ib/test-mailbox-key-0001",
    "one@example.com http://dispose.lol/ib/test-mailbox-key-0001",
    "one@example.com ftp://example.com/mailbox/test-mailbox-key-0001",
    "one@example.com https://user:password@example.com/mailbox/test-mailbox-key-0001",
  ];
  for (const row of invalidRows) {
    assert.throws(() => parseInboxLinkPool(row), (error) => {
      assert.equal(error.status, 400);
      assert.doesNotMatch(error.message, /test-mailbox-key-0001/);
      return true;
    });
  }
  assert.throws(() => parseInboxLinkPool([
    "same@example.com https://dispose.lol/ib/test-mailbox-key-0001",
    "same@example.com https://dispose.lol/ib/test-mailbox-key-0002",
  ].join("\n")), /邮箱.*重复/);
});

test("binds links encrypted and creates registration tasks from the saved mailbox pool", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-inbox-link-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const client = {
    created: [],
    async health() { return { ok: true, configured: true }; },
    async createTask(payload) {
      this.created.push(payload);
      return { task_id: `link-task-${this.created.length}` };
    },
  };
  const runtime = createApp({
    db,
    registrationClient: client,
    publicBaseUrl: "https://alias.test/alias-hub",
    dataEncryptionKey: "inbox-link-test-encryption-key",
  });
  try {
    const imported = await jsonRequest(runtime.app, "/api/inbox-link-mailboxes/import", {
      method: "POST",
      body: JSON.stringify({ poolText }),
    });
    assert.equal(imported.response.status, 201);
    assert.equal(imported.body.created, 3);
    assert.equal(imported.body.available, 3);
    assert.equal(imported.body.items.every((item) => item.mail_center_bound && item.source_account_id), true);
    assert.doesNotMatch(JSON.stringify(imported.body), /test-mailbox-key-0001|test-mailbox-key-0002/);
    assert.equal(imported.body.items[0].masked_link.includes("..."), true);

    const storedBindings = db.prepare(`
      SELECT email, inbox_key_hash, inbox_key_encrypted, inbox_key_preview
      FROM inbox_link_mailboxes ORDER BY id
    `).all();
    assert.equal(storedBindings.length, 3);
    assert.match(storedBindings[0].inbox_key_encrypted, /^v1\./);
    assert.equal(storedBindings[0].inbox_key_encrypted.includes("test-mailbox-key-0001"), false);
    assert.equal(storedBindings[0].inbox_key_hash.includes("test-mailbox-key-0001"), false);
    assert.equal(storedBindings[0].inbox_key_preview, "https://dispose.lol/ib/test...0001");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM source_accounts WHERE provider = 'inbox_link'").get().count, 3);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM addresses
      JOIN source_accounts ON source_accounts.id = addresses.account_id
      WHERE source_accounts.provider = 'inbox_link' AND addresses.kind = 'primary'
    `).get().count, 3);

    const defaultAccounts = await jsonRequest(runtime.app, "/api/accounts");
    const mailCenterAccounts = await jsonRequest(runtime.app, "/api/accounts?includeInboxLinks=true");
    assert.equal(defaultAccounts.body.items.length, 0);
    assert.equal(mailCenterAccounts.body.items.length, 3);
    assert.equal(mailCenterAccounts.body.items.every((item) => item.provider === "inbox_link"), true);

    const options = await jsonRequest(runtime.app, "/api/registration/options");
    assert.equal(options.response.status, 200);
    assert.equal(options.body.inboxLinkMailboxes.available, 3);

    const response = await jsonRequest(runtime.app, "/api/registration/jobs", {
      method: "POST",
      body: JSON.stringify({
        mailboxMode: "inbox_link",
        count: 2,
        browserMode: "headless",
        proxySelection: "direct",
        autoContinuePostSignup: true,
        setPasswordAfterRegistration: false,
        password: "",
      }),
    });

    assert.equal(response.response.status, 202);
    assert.equal(response.body.items.length, 2);
    assert.deepEqual(response.body.items.map((item) => item.email), [
      "fixture-one@icloud.com",
      "fixture-two@icloud.com",
    ]);
    assert.equal(client.created.length, 2);
    assert.equal(client.created[0].email, "fixture-one@icloud.com");
    assert.equal(client.created[0].extra.mail_provider, "dispose_inbox_link");
    assert.equal(
      client.created[0].extra.dispose_inbox_link_pool_text,
      "fixture-one@icloud.com https://dispose.lol/ib/test-mailbox-key-0001",
    );
    assert.equal(client.created[1].extra.dispose_inbox_link_pool_text.includes("test-mailbox-key-0001"), false);
    assert.doesNotMatch(JSON.stringify(response.body), /test-mailbox-key-0001|test-mailbox-key-0002/);

    const boundAfterSubmit = await jsonRequest(runtime.app, "/api/inbox-link-mailboxes");
    assert.equal(boundAfterSubmit.body.available, 1);
    assert.equal(boundAfterSubmit.body.in_progress, 2);
    const activeBinding = boundAfterSubmit.body.items.find((item) => item.registration_state === "in_progress");
    const blockedDelete = await jsonRequest(runtime.app, `/api/inbox-link-mailboxes/${activeBinding.id}`, { method: "DELETE" });
    assert.equal(blockedDelete.response.status, 409);
    assert.match(blockedDelete.body.error, /正在注册，暂时不能解除绑定/);
    const availableBinding = boundAfterSubmit.body.items.find((item) => item.registration_state === "available");
    const blockedBulk = await jsonRequest(runtime.app, "/api/inbox-link-mailboxes/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids: [availableBinding.id, activeBinding.id] }),
    });
    assert.equal(blockedBulk.response.status, 409);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM inbox_link_mailboxes").get().count, 3);
    const deletedBulk = await jsonRequest(runtime.app, "/api/inbox-link-mailboxes/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids: [availableBinding.id] }),
    });
    assert.equal(deletedBulk.response.status, 200);
    assert.equal(deletedBulk.body.deleted, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM inbox_link_mailboxes").get().count, 2);

    const stored = db.prepare("SELECT account_id, address_id, base_address_id, email FROM registration_jobs ORDER BY id").all();
    assert.deepEqual(stored.map((item) => ({
      ...item,
      bound: Boolean(item.account_id && item.address_id && item.base_address_id),
    })), [
      { account_id: 1, address_id: 1, base_address_id: 1, email: "fixture-one@icloud.com", bound: true },
      { account_id: 2, address_id: 2, base_address_id: 2, email: "fixture-two@icloud.com", bound: true },
    ]);

    const completedAt = new Date().toISOString();
    db.prepare(`
      UPDATE registration_jobs
      SET status = 'completed', deleted_at = ?, finished_at = ?, updated_at = ?
      WHERE email = ? COLLATE NOCASE
    `).run(completedAt, completedAt, completedAt, "fixture-one@icloud.com");
    const afterHistoryDeletion = await jsonRequest(runtime.app, "/api/inbox-link-mailboxes");
    assert.equal(afterHistoryDeletion.body.available, 0);
    assert.equal(afterHistoryDeletion.body.used, 1);
    assert.equal(afterHistoryDeletion.body.in_progress, 1);
    assert.equal(
      afterHistoryDeletion.body.items.find((item) => item.email === "fixture-one@icloud.com").registration_state,
      "used",
    );
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("marks GPT Free mailboxes with revoked access tokens for one-click bulk unbinding", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-inbox-link-free-invalid-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const email = "fixture-one@icloud.com";
  const client = {
    deleted: [],
    deleteFails: false,
    async health() { return { ok: true, configured: true }; },
    async listAccounts() {
      return {
        items: [{
          id: 155,
          platform: "chatgpt",
          email,
          lifecycle_status: "invalid",
          account_type: "free",
          credentials: [{ key: "access_token", value: "expired-test-token" }],
          overview: {
            plan: "free",
            plan_name: "free",
            plan_state: "free",
            display_status: "invalid",
            validity_status: "invalid",
            credential_status: "revoked",
            status_code: "token_revoked",
            status_reason: "Access Token 已撤销",
            status_source: "backend-api/accounts/check",
            checked_at: "2026-08-04T04:00:00.000Z",
            valid: false,
          },
        }],
      };
    },
    async getAccount(id) {
      if (Number(id) !== 155 || this.deleted.includes(155)) return null;
      return { id: 155, platform: "chatgpt", email };
    },
    async deleteAccount(id) {
      if (this.deleteFails) throw new Error("remote delete failed");
      this.deleted.push(Number(id));
      return { ok: true };
    },
  };
  const runtime = createApp({
    db,
    registrationClient: client,
    dataEncryptionKey: "inbox-link-free-invalid-test-key",
  });
  try {
    const imported = await jsonRequest(runtime.app, "/api/inbox-link-mailboxes/import", {
      method: "POST",
      body: JSON.stringify({ poolText: poolText.split(/\r?\n/)[0] }),
    });
    const mailbox = imported.body.items[0];
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO registration_jobs (
        account_id, address_id, base_address_id, email, external_task_id, external_account_id,
        status, stage, browser_mode, message, created_at, updated_at, finished_at
      ) VALUES (?, NULL, NULL, ?, 'task-155', '155', 'completed', 'completed', 'headless', '注册完成', ?, ?, ?)
    `).run(mailbox.source_account_id, email, now, now, now);

    const listed = await jsonRequest(runtime.app, "/api/inbox-link-mailboxes");
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.free_invalid_at, 1);
    assert.equal(listed.body.items[0].chatgpt.plan, "free");
    assert.equal(listed.body.items[0].chatgpt.at_invalid, true);
    assert.equal(listed.body.items[0].unlink_recommended, true);

    client.deleteFails = true;
    const failedDelete = await jsonRequest(runtime.app, "/api/inbox-link-mailboxes/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids: [mailbox.id] }),
    });
    assert.equal(failedDelete.response.status, 200);
    assert.equal(failedDelete.body.deleted, 0);
    assert.equal(failedDelete.body.gpt_deleted, 0);
    assert.equal(failedDelete.body.gpt_failed.length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM inbox_link_mailboxes").get().count, 1);

    client.deleteFails = false;
    db.prepare("UPDATE registration_jobs SET deleted_at = ? WHERE external_account_id = '155'")
      .run(new Date().toISOString());
    const deleted = await jsonRequest(runtime.app, "/api/inbox-link-mailboxes/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids: [mailbox.id] }),
    });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.body.deleted, 1);
    assert.equal(deleted.body.gpt_deleted, 1);
    assert.deepEqual(client.deleted, [155]);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM inbox_link_mailboxes").get().count, 0);
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("marks Free accounts that require an access-token refresh for bulk unbinding", () => {
  for (const status_code of [
    "access_token_refresh_required",
    "auth_unauthorized_unconfirmed",
    "authentication_unconfirmed",
  ]) {
    const result = inboxLinkChatgptStatus({
      id: 155,
      account_type: "free",
      credential_status: "valid",
      validity_status: "valid",
      status_code,
    });
    assert.equal(result.at_invalid, true, status_code);
    assert.equal(result.unlink_recommended, true, status_code);
  }

  assert.equal(inboxLinkChatgptStatus({
    id: 156,
    account_type: "plus",
    credential_status: "valid",
    validity_status: "valid",
    status_code: "access_token_refresh_required",
  }).unlink_recommended, false);
});

test("scans a bound inbox-link mailbox into the independent mail center account", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-inbox-link-scan-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const fetchFn = async (input) => {
    const url = new URL(input);
    const payload = !url.pathname.includes("/messages/")
      ? {
          email: "fixture-one@icloud.com",
          messages: [{ id: "message-1", sender_name: "OpenAI", sender_address: "noreply@openai.com", subject: "Your code", received_at: "2026-08-03T08:00:00.000Z" }],
        }
      : {
          id: "message-1",
          external_message_id: "external-1",
          sender_name: "OpenAI",
          sender_address: "noreply@openai.com",
          recipient: "fixture-one@icloud.com",
          subject: "Your code",
          text_body: "Use 804219 to continue.",
          received_at: "2026-08-03T08:00:00.000Z",
        };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  const runtime = createApp({
    db,
    dataEncryptionKey: "inbox-link-scan-test-key",
    inboxLinkFetchFn: fetchFn,
  });
  try {
    const imported = await jsonRequest(runtime.app, "/api/inbox-link-mailboxes/import", {
      method: "POST",
      body: JSON.stringify({
        poolText: "fixture-one@icloud.com https://pickup.example.test/?token=signed-mailbox-token",
      }),
    });
    const accountId = imported.body.items[0].source_account_id;
    const queued = await jsonRequest(runtime.app, `/api/accounts/${accountId}/scan-inbox`, { method: "POST" });
    assert.equal(queued.response.status, 202);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = db.prepare("SELECT status FROM automation_jobs WHERE id = ?").get(queued.body.job.id)?.status;
      if (status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const message = db.prepare("SELECT * FROM mail_messages WHERE account_id = ?").get(accountId);
    const code = db.prepare("SELECT * FROM verification_codes WHERE account_id = ?").get(accountId);
    assert.equal(message.subject, "Your code");
    assert.equal(message.recipient_address, "fixture-one@icloud.com");
    assert.equal(message.body, "Use 804219 to continue.");
    assert.equal(code.code, "804219");
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects inbox-link counts larger than the available pool", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-inbox-link-count-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const client = {
    created: [],
    async health() { return { ok: true, configured: true }; },
    async createTask(payload) { this.created.push(payload); return { task_id: "unexpected" }; },
  };
  const runtime = createApp({ db, registrationClient: client, dataEncryptionKey: "" });
  try {
    const noEncryption = await jsonRequest(runtime.app, "/api/inbox-link-mailboxes/import", {
      method: "POST",
      body: JSON.stringify({ poolText }),
    });
    assert.equal(noEncryption.response.status, 503);
    assert.equal(client.created.length, 0);

    const encryptedRuntime = createApp({
      db,
      registrationClient: client,
      dataEncryptionKey: "inbox-link-count-test-key",
    });
    const imported = await jsonRequest(encryptedRuntime.app, "/api/inbox-link-mailboxes/import", {
      method: "POST",
      body: JSON.stringify({ poolText }),
    });
    assert.equal(imported.response.status, 201);
    const encryptedResponse = await jsonRequest(encryptedRuntime.app, "/api/registration/jobs", {
      method: "POST",
      body: JSON.stringify({ mailboxMode: "inbox_link", count: 4 }),
    });
    assert.equal(encryptedResponse.response.status, 400);
    assert.equal(encryptedResponse.body.error, "已绑定链接邮箱数量不足：注册数量 4，当前可用 3 个");
    assert.equal(client.created.length, 0);
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
