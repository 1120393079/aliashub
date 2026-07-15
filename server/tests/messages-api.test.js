import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistInboxScanResult } from "../account-service.js";
import { createDatabase, createSourceAccount, nowIso } from "../db.js";
import { createApp } from "../index.js";
import { jsonRequest } from "./http-harness.js";

function insertMessage(db, accountId, addressId, input = {}) {
  const now = input.receivedAt || nowIso();
  const graphMessageId = input.graphMessageId || `graph-${crypto.randomUUID()}`;
  const result = db.prepare(`
    INSERT INTO mail_messages (
      account_id, address_id, fingerprint, graph_message_id, internet_message_id,
      sender_name, sender_address, recipient_address, to_recipients, cc_recipients,
      subject, preview, body, body_content_type, body_truncated, verification_code,
      web_link, is_read, has_attachments, received_at, is_hidden, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'text', 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accountId,
    addressId,
    input.fingerprint || `fingerprint-${graphMessageId}`,
    graphMessageId,
    input.internetMessageId || `<${graphMessageId}@example.com>`,
    input.senderName || "Example Sender",
    input.senderAddress || "sender@example.com",
    input.recipientAddress || "",
    JSON.stringify(input.toRecipients || []),
    JSON.stringify(input.ccRecipients || []),
    input.subject || "Test message",
    input.preview || "Message preview",
    input.body || "Full message body",
    input.verificationCode || "",
    input.webLink || "",
    input.isRead ? 1 : 0,
    input.hasAttachments ? 1 : 0,
    now,
    input.isHidden ? 1 : 0,
    now,
    now,
  );
  return Number(result.lastInsertRowid);
}

function createRuntime(db, options = {}) {
  const previousAdminPassword = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  const runtime = createApp({ db, seedDemo: false, publicBaseUrl: "http://127.0.0.1", ...options });
  if (previousAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = previousAdminPassword;
  return runtime;
}

async function listen(runtime) {
  await new Promise((resolve) => setImmediate(resolve));
  return { server: null, baseUrl: runtime.app };
}

async function close(server) {
  if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function suppressErrors(callback) {
  const original = console.error;
  console.error = () => {};
  try { return await callback(); } finally { console.error = original; }
}

async function waitForJob(baseUrl, jobId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await jsonRequest(baseUrl, `/api/jobs/${jobId}`);
    if (["completed", "failed"].includes(result.body.job?.status)) return result.body.job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${jobId} did not finish`);
}

test("mail messages support listing, details, soft deletion, and strict bulk scopes", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-messages-api-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const first = createSourceAccount(db, { email: "first@outlook.com" });
  const second = createSourceAccount(db, { email: "second@hotmail.com" });
  const primary = db.prepare("SELECT id, address FROM addresses WHERE account_id = ? AND kind = 'primary'");
  const firstAddress = primary.get(first.id);
  const secondAddress = primary.get(second.id);
  const visibleId = insertMessage(db, first.id, firstAddress.id, {
    graphMessageId: "visible-first",
    senderName: "Billing Team",
    senderAddress: "billing@example.com",
    recipientAddress: firstAddress.address,
    toRecipients: [{ name: "First", address: firstAddress.address }],
    subject: "Your July invoice",
    body: "The full invoice message body",
    isRead: true,
    hasAttachments: true,
    receivedAt: "2026-07-12T06:00:00.000Z",
  });
  const hiddenId = insertMessage(db, first.id, firstAddress.id, {
    graphMessageId: "hidden-first",
    recipientAddress: firstAddress.address,
    subject: "Already hidden",
    isHidden: true,
    receivedAt: "2026-07-12T05:00:00.000Z",
  });
  const secondId = insertMessage(db, second.id, secondAddress.id, {
    graphMessageId: "visible-second",
    recipientAddress: secondAddress.address,
    subject: "Second account message",
    receivedAt: "2026-07-12T04:00:00.000Z",
  });
  const runtime = createRuntime(db);
  const { server, baseUrl } = await listen(runtime);

  try {
    await t.test("default lists omit hidden messages and details include the body", async () => {
      const list = await jsonRequest(baseUrl, `/api/messages?accountId=${first.id}`);
      assert.equal(list.response.status, 200);
      assert.equal(list.body.total, 1);
      assert.equal(list.body.visible, 1);
      assert.equal(list.body.hidden, 1);
      assert.equal(list.body.currentTotal, 1);
      assert.deepEqual(list.body.items.map((item) => item.id), [visibleId]);
      assert.equal(list.body.items[0].body, undefined);
      assert.equal(list.body.items[0].source_email, first.email);
      assert.equal(list.body.items[0].address, firstAddress.address);
      assert.equal(list.body.items[0].is_read, true);
      assert.equal(list.body.items[0].has_attachments, true);
      assert.deepEqual(list.body.items[0].to_recipients, [{ name: "First", address: firstAddress.address }]);

      const detail = await jsonRequest(baseUrl, `/api/messages/${visibleId}`);
      assert.equal(detail.response.status, 200);
      assert.equal(detail.body.item.body, "The full invoice message body");
      assert.equal(detail.body.item.is_hidden, false);

      const search = await jsonRequest(baseUrl, "/api/messages?q=Billing");
      assert.deepEqual(search.body.items.map((item) => item.id), [visibleId]);

      const bodySearch = await jsonRequest(baseUrl, "/api/messages?q=full%20invoice");
      assert.deepEqual(bodySearch.body.items.map((item) => item.id), [visibleId]);

      const secondPage = await jsonRequest(baseUrl, "/api/messages?limit=1&page=2");
      assert.equal(secondPage.body.currentTotal, 2);
      assert.equal(secondPage.body.pages, 2);
      assert.deepEqual(secondPage.body.items.map((item) => item.id), [secondId]);
    });

    await t.test("selected messages can be hidden and restored", async () => {
      const hidden = await jsonRequest(baseUrl, "/api/messages/hide", {
        method: "POST",
        body: JSON.stringify({ ids: [visibleId] }),
      });
      assert.equal(hidden.response.status, 200);
      assert.equal(hidden.body.hidden, 1);

      const recycleBin = await jsonRequest(baseUrl, `/api/messages?accountId=${first.id}&hidden=true`);
      assert.equal(recycleBin.body.currentTotal, 2);
      assert.deepEqual(recycleBin.body.items.map((item) => item.id), [visibleId, hiddenId]);

      const restored = await jsonRequest(baseUrl, "/api/messages/restore", {
        method: "POST",
        body: JSON.stringify({ ids: [hiddenId] }),
      });
      assert.equal(restored.response.status, 200);
      assert.equal(restored.body.restored, 1);
      const visible = await jsonRequest(baseUrl, `/api/messages?accountId=${first.id}`);
      assert.deepEqual(visible.body.items.map((item) => item.id), [hiddenId]);
    });

    await t.test("single-message visibility updates require a boolean", async () => {
      const patched = await jsonRequest(baseUrl, `/api/messages/${hiddenId}`, {
        method: "PATCH",
        body: JSON.stringify({ isHidden: true }),
      });
      assert.equal(patched.response.status, 200);
      assert.equal(patched.body.item.is_hidden, true);

      const invalid = await suppressErrors(() => jsonRequest(baseUrl, `/api/messages/${hiddenId}`, {
        method: "PATCH",
        body: JSON.stringify({ isHidden: "false" }),
      }));
      assert.equal(invalid.response.status, 400);
      assert.equal(invalid.body.error, "isHidden 必须是布尔值");
    });

    await t.test("all-message operations require an explicit valid account scope", async () => {
      const missingScope = await suppressErrors(() => jsonRequest(baseUrl, "/api/messages/hide", {
        method: "POST",
        body: JSON.stringify({ all: true }),
      }));
      assert.equal(missingScope.response.status, 400);
      assert.equal(missingScope.body.error, "请选择有效的源头邮箱");

      const missingAccount = await suppressErrors(() => jsonRequest(baseUrl, "/api/messages/hide", {
        method: "POST",
        body: JSON.stringify({ all: true, accountId: 999999 }),
      }));
      assert.equal(missingAccount.response.status, 404);

      const crossScope = await suppressErrors(() => jsonRequest(baseUrl, "/api/messages/hide", {
        method: "POST",
        body: JSON.stringify({ ids: [secondId], accountId: first.id }),
      }));
      assert.equal(crossScope.response.status, 409);
      assert.equal(crossScope.body.error, "所选邮件不属于指定的源头邮箱");

      const scoped = await jsonRequest(baseUrl, "/api/messages/hide", {
        method: "POST",
        body: JSON.stringify({ all: true, accountId: second.id }),
      });
      assert.equal(scoped.body.hidden, 1);

      const restored = await jsonRequest(baseUrl, "/api/messages/restore", {
        method: "POST",
        body: JSON.stringify({ all: true, accountId: "all" }),
      });
      assert.equal(restored.body.restored, 3);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mail_messages WHERE is_hidden = 1").get().count, 0);
    });

    await t.test("selected recycle-bin messages can be permanently deleted without returning on scan", async () => {
      const visibleDelete = await suppressErrors(() => jsonRequest(baseUrl, "/api/messages/purge-hidden", {
        method: "POST",
        body: JSON.stringify({ ids: [visibleId], accountId: first.id }),
      }));
      assert.equal(visibleDelete.response.status, 409);

      const hidden = await jsonRequest(baseUrl, "/api/messages/hide", {
        method: "POST",
        body: JSON.stringify({ ids: [visibleId, hiddenId], accountId: first.id }),
      });
      assert.equal(hidden.body.hidden, 2);

      const crossScope = await suppressErrors(() => jsonRequest(baseUrl, "/api/messages/purge-hidden", {
        method: "POST",
        body: JSON.stringify({ ids: [visibleId], accountId: second.id }),
      }));
      assert.equal(crossScope.response.status, 409);
      assert.equal(crossScope.body.error, "所选邮件不属于指定的源头邮箱");

      const purged = await jsonRequest(baseUrl, "/api/messages/purge-hidden", {
        method: "POST",
        body: JSON.stringify({ ids: [visibleId, hiddenId, visibleId], accountId: first.id }),
      });
      assert.equal(purged.response.status, 200);
      assert.equal(purged.body.deleted, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mail_messages WHERE id IN (?, ?)").get(visibleId, hiddenId).count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mail_message_tombstones WHERE account_id = ?").get(first.id).count, 2);

      const scan = persistInboxScanResult(db, first, {
        messages: [{
          fingerprint: "fingerprint-visible-first",
          graphMessageId: "visible-first",
          senderName: "Billing Team",
          senderAddress: "billing@example.com",
          recipient: firstAddress.address,
          recipients: [firstAddress.address],
          subject: "Your July invoice",
          preview: "Message preview",
          body: "The full invoice message body",
          receivedAt: "2026-07-12T06:00:00.000Z",
        }],
        items: [],
      });
      assert.equal(scan.messages.added, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mail_messages WHERE graph_message_id = 'visible-first'").get().count, 0);
    });
  } finally {
    await close(server);
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("inbox scans persist all mail, keep verification codes, and preserve local hidden state", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-message-scan-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const account = createSourceAccount(db, { email: "source@hotmail.com" });
  db.prepare("UPDATE source_accounts SET status = 'connected', updated_at = ? WHERE id = ?").run(nowIso(), account.id);
  const primary = db.prepare("SELECT id FROM addresses WHERE account_id = ? AND kind = 'primary'").get(account.id);
  const now = nowIso();
  const split = db.prepare(`
    INSERT INTO addresses (
      account_id, parent_address_id, address, kind, status, strategy, label,
      remote_confirmed, created_at, updated_at
    ) VALUES (?, ?, ?, 'split', 'active', 'plus', 'Shop', 0, ?, ?)
  `).run(account.id, primary.id, "source+shop@hotmail.com", now, now);
  const splitId = Number(split.lastInsertRowid);
  let scanCount = 0;
  const graph = {
    async scanInbox() {
      scanCount += 1;
      const updated = scanCount > 1;
      return {
        stage: "completed",
        messages: [
          {
            fingerprint: "mail-fingerprint-1",
            graphMessageId: "graph-message-1",
            internetMessageId: "<message-1@example.com>",
            senderName: "News",
            senderAddress: "news@example.com",
            recipient: "source+shop@hotmail.com",
            recipients: ["source+shop@hotmail.com"],
            toRecipients: [{ name: "Shop", address: "source+shop@hotmail.com" }],
            ccRecipients: [],
            subject: updated ? "Updated newsletter" : "Newsletter",
            preview: "Latest news",
            body: "Full newsletter",
            bodyContentType: "text",
            bodyTruncated: false,
            verificationCode: "",
            webLink: "https://outlook.live.com/mail/0/inbox/id/graph-message-1",
            isRead: updated,
            hasAttachments: false,
            receivedAt: "2026-07-12T06:00:00.000Z",
          },
          {
            fingerprint: "mail-fingerprint-2",
            graphMessageId: "graph-message-2",
            internetMessageId: "<message-2@example.com>",
            senderName: "Security",
            senderAddress: "security@example.com",
            recipient: account.email,
            recipients: [account.email],
            toRecipients: [{ name: "Source", address: account.email }],
            ccRecipients: [],
            subject: "Security code 482913",
            preview: "Use 482913 to continue",
            body: "Security code: 482913",
            bodyContentType: "text",
            bodyTruncated: false,
            verificationCode: "482913",
            webLink: "",
            isRead: false,
            hasAttachments: false,
            receivedAt: "2026-07-12T05:00:00.000Z",
          },
        ],
        items: [{
          fingerprint: "code-fingerprint-1",
          code: "482913",
          sender: "Security",
          subject: "Security code 482913",
          preview: "Use 482913 to continue",
          recipient: account.email,
          recipients: [account.email],
          receivedAt: "2026-07-12T05:00:00.000Z",
        }],
      };
    },
  };
  const runtime = createRuntime(db, { graph });
  const { server, baseUrl } = await listen(runtime);

  try {
    const invalidScan = await suppressErrors(() => jsonRequest(baseUrl, "/api/messages/scan", {
      method: "POST",
      body: JSON.stringify({}),
    }));
    assert.equal(invalidScan.response.status, 400);

    const queued = await jsonRequest(baseUrl, `/api/accounts/${account.id}/scan-inbox`, { method: "POST" });
    assert.equal(queued.response.status, 202);
    const firstJob = await waitForJob(baseUrl, queued.body.job.id);
    assert.equal(firstJob.status, "completed");
    assert.equal(firstJob.message, "新增 2 封邮件，新增 1 条验证码");
    assert.deepEqual(firstJob.result.messages, { found: 2, added: 2 });
    assert.deepEqual(firstJob.result.codes, { found: 1, added: 1 });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mail_messages").get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM verification_codes").get().count, 1);
    assert.equal(db.prepare("SELECT address_id FROM mail_messages WHERE graph_message_id = 'graph-message-1'").get().address_id, splitId);

    const newsletter = db.prepare("SELECT id FROM mail_messages WHERE graph_message_id = 'graph-message-1'").get();
    const hidden = await jsonRequest(baseUrl, `/api/messages/${newsletter.id}`, {
      method: "PATCH",
      body: JSON.stringify({ isHidden: true }),
    });
    assert.equal(hidden.body.item.is_hidden, true);

    const rescanned = await jsonRequest(baseUrl, `/api/accounts/${account.id}/scan-codes`, { method: "POST" });
    assert.equal(rescanned.response.status, 202);
    const secondJob = await waitForJob(baseUrl, rescanned.body.job.id);
    assert.equal(secondJob.status, "completed");
    assert.equal(secondJob.message, "新增 0 封邮件，新增 0 条验证码");
    assert.deepEqual(secondJob.result.messages, { found: 2, added: 0 });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mail_messages").get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM verification_codes").get().count, 1);
    const stored = db.prepare("SELECT subject, is_read, is_hidden FROM mail_messages WHERE id = ?").get(newsletter.id);
    assert.deepEqual(stored, { subject: "Updated newsletter", is_read: 1, is_hidden: 1 });
  } finally {
    await close(server);
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
