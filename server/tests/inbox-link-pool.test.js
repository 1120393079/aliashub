import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../db.js";
import { parseInboxLinkPool } from "../inbox-link-pool.js";
import { createApp } from "../index.js";
import { jsonRequest } from "./http-harness.js";

const poolText = [
  "alpha@example.com https://dispose.lol/ib/testInboxKeyAlpha001",
  "beta@example.com https://dispose.lol/ib/testInboxKeyBeta0002",
  "gamma@example.com https://dispose.lol/ib/testInboxKeyGamma003",
].join("\r\n");

function temporaryDatabase(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  return {
    db,
    close() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("parses, validates, and deduplicates dispose inbox-link rows", () => {
  const entries = parseInboxLinkPool(`${poolText}\n${poolText.split(/\r?\n/)[0]}`);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].email, "alpha@example.com");
  assert.equal(entries[0].inboxKey, "testInboxKeyAlpha001");
  assert.equal(entries[0].maskedLink, "https://dispose.lol/ib/test...a001");
});

test("rejects invalid or conflicting inbox-link rows without echoing the key", () => {
  const secret = "testInboxKeyAlpha001";
  const invalidRows = [
    `not-an-email https://dispose.lol/ib/${secret}`,
    `one@example.com http://dispose.lol/ib/${secret}`,
    `one@example.com https://example.com/ib/${secret}`,
    `one@example.com https://dispose.lol/not-ib/${secret}`,
  ];
  for (const row of invalidRows) {
    assert.throws(() => parseInboxLinkPool(row), (error) => {
      assert.equal(error.status, 400);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  }
  assert.throws(() => parseInboxLinkPool([
    `same@example.com https://dispose.lol/ib/${secret}`,
    "same@example.com https://dispose.lol/ib/testInboxKeyOther004",
  ].join("\n")), /邮箱.*重复/);
});

test("binds links encrypted and creates registration tasks from the saved mailbox pool", async () => {
  const fixture = temporaryDatabase("aliashub-inbox-link-test-");
  const client = {
    created: [],
    async health() { return { ok: true, configured: true }; },
    async createTask(payload) {
      this.created.push(payload);
      return { task_id: `link-task-${this.created.length}` };
    },
  };
  const runtime = createApp({
    db: fixture.db,
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
    assert.doesNotMatch(JSON.stringify(imported.body), /testInboxKeyAlpha001|testInboxKeyBeta0002/);
    assert.equal(imported.body.items[0].masked_link.includes("..."), true);

    const storedBindings = fixture.db.prepare(`
      SELECT email, inbox_key_hash, inbox_key_encrypted, inbox_key_preview
      FROM inbox_link_mailboxes ORDER BY id
    `).all();
    assert.equal(storedBindings.length, 3);
    assert.match(storedBindings[0].inbox_key_encrypted, /^v1\./);
    assert.equal(storedBindings[0].inbox_key_encrypted.includes("testInboxKeyAlpha001"), false);
    assert.equal(storedBindings[0].inbox_key_hash.includes("testInboxKeyAlpha001"), false);
    assert.equal(storedBindings[0].inbox_key_preview, "test...a001");

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
    assert.deepEqual(response.body.items.map((item) => item.email), [
      "alpha@example.com",
      "beta@example.com",
    ]);
    assert.equal(client.created.length, 2);
    assert.equal(client.created[0].extra.mail_provider, "dispose_inbox_link");
    assert.equal(
      client.created[0].extra.dispose_inbox_link_pool_text,
      "alpha@example.com https://dispose.lol/ib/testInboxKeyAlpha001",
    );
    assert.doesNotMatch(JSON.stringify(response.body), /testInboxKeyAlpha001|testInboxKeyBeta0002/);

    const boundAfterSubmit = await jsonRequest(runtime.app, "/api/inbox-link-mailboxes");
    assert.equal(boundAfterSubmit.body.available, 1);
    assert.equal(boundAfterSubmit.body.in_progress, 2);
    const activeBinding = boundAfterSubmit.body.items.find((item) => item.registration_state === "in_progress");
    const blockedDelete = await jsonRequest(runtime.app, `/api/inbox-link-mailboxes/${activeBinding.id}`, { method: "DELETE" });
    assert.equal(blockedDelete.response.status, 409);

    fixture.db.prepare(`
      UPDATE registration_jobs SET status = 'completed', deleted_at = ? WHERE lower(email) = lower(?)
    `).run("2026-01-01T00:00:00.000Z", "alpha@example.com");
    const afterRecordDeletion = await jsonRequest(runtime.app, "/api/inbox-link-mailboxes");
    assert.equal(afterRecordDeletion.body.used, 1);
    assert.equal(
      afterRecordDeletion.body.items.find((item) => item.email === "alpha@example.com").available,
      false,
    );

    const stored = fixture.db.prepare("SELECT account_id, address_id, base_address_id, email FROM registration_jobs ORDER BY id").all();
    assert.deepEqual(stored, [
      { account_id: null, address_id: null, base_address_id: null, email: "alpha@example.com" },
      { account_id: null, address_id: null, base_address_id: null, email: "beta@example.com" },
    ]);
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    fixture.close();
  }
});

test("rejects counts larger than the available pool and reserves a batch atomically", async () => {
  const fixture = temporaryDatabase("aliashub-inbox-link-count-test-");
  let releaseFirstTask;
  const firstTaskGate = new Promise((resolve) => { releaseFirstTask = resolve; });
  const client = {
    calls: 0,
    async health() { return { ok: true, configured: true }; },
    async createTask() {
      this.calls += 1;
      if (this.calls === 1) await firstTaskGate;
      return { task_id: `link-task-${this.calls}` };
    },
  };
  const runtime = createApp({
    db: fixture.db,
    registrationClient: client,
    dataEncryptionKey: "inbox-link-count-test-key",
  });
  try {
    const imported = await jsonRequest(runtime.app, "/api/inbox-link-mailboxes/import", {
      method: "POST",
      body: JSON.stringify({ poolText }),
    });
    assert.equal(imported.response.status, 201);

    const firstBatch = runtime.registration.createJobs({
      mailboxMode: "inbox_link",
      count: 2,
      proxySelection: "direct",
    });
    await new Promise((resolve) => setImmediate(resolve));

    await assert.rejects(
      runtime.registration.createJobs({ mailboxMode: "inbox_link", count: 2 }),
      /当前可用 1 个/,
    );
    releaseFirstTask();
    const firstJobs = await firstBatch;
    assert.equal(firstJobs.length, 2);
  } finally {
    releaseFirstTask();
    await new Promise((resolve) => setImmediate(resolve));
    fixture.close();
  }
});

test("requires DATA_ENCRYPTION_KEY before binding links", async () => {
  const fixture = temporaryDatabase("aliashub-inbox-link-encryption-test-");
  const client = {
    async health() { return { ok: true, configured: true }; },
    async createTask() { return { task_id: "unexpected" }; },
  };
  const runtime = createApp({ db: fixture.db, registrationClient: client, dataEncryptionKey: "" });
  try {
    const response = await jsonRequest(runtime.app, "/api/inbox-link-mailboxes/import", {
      method: "POST",
      body: JSON.stringify({ poolText }),
    });
    assert.equal(response.response.status, 503);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM inbox_link_mailboxes").get().count, 0);
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    fixture.close();
  }
});
