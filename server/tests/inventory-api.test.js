import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase, getSetting, nowIso } from "../db.js";
import { createApp } from "../index.js";
import { jsonRequest } from "./http-harness.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createTestRuntime(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-inventory-api-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const previousPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = "";
  let runtime;
  try {
    runtime = createApp({
      db,
      seedDemo: false,
      publicBaseUrl: "https://alias.test/alias-hub",
      dataEncryptionKey: "inventory-route-test-encryption-key",
      ...options,
    });
  } finally {
    if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previousPassword;
  }
  t.after(async () => {
    // createApp schedules one initial queue drain with setImmediate.
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { ...runtime, directory };
}

test("inventory config routes encrypt the API key and authenticate the connection probe", async (t) => {
  const calls = [];
  const runtime = createTestRuntime(t, {
    inventoryFetchFn: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ ok: true, operations: 3 });
    },
  });

  const initial = await jsonRequest(runtime.app, "/api/inventory/config");
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.api_key_configured, false);
  assert.equal(initial.body.cards_url, "https://nvtokens.com/api/inventory/cards/import");
  assert.equal(initial.body.mailboxes_url, "https://nvtokens.com/api/inventory/mailboxes/import");
  assert.equal(initial.body.pool_url, "https://nvtokens.com/api/inventory/cards/pool");

  const apiKey = "fixture-inventory-route-key-123";
  const saved = await jsonRequest(runtime.app, "/api/inventory/config", {
    method: "PATCH",
    body: JSON.stringify({
      api_key: apiKey,
    }),
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.api_key_configured, true);
  assert.equal(saved.body.cards_url, "https://nvtokens.com/api/inventory/cards/import");
  assert.equal(saved.body.cards_schema_url, "https://nvtokens.com/api/inventory/cards/import/schema");
  assert.equal(saved.body.mailboxes_url, "https://nvtokens.com/api/inventory/mailboxes/import");
  assert.equal(saved.body.pool_url, "https://nvtokens.com/api/inventory/cards/pool");
  assert.equal(JSON.stringify(saved.body).includes(apiKey), false);

  const encrypted = getSetting(runtime.db, "inventory_api_key_encrypted", "");
  assert.match(encrypted, /^v1\./);
  assert.equal(encrypted.includes(apiKey), false);

  const connected = await jsonRequest(runtime.app, "/api/inventory/test", { method: "POST" });
  assert.equal(connected.response.status, 200);
  assert.equal(connected.body.connected, true);
  assert.match(connected.body.last_connected_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://nvtokens.com/api/inventory/cards/import");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body, "{}");
  assert.equal(calls[0].options.headers["content-type"], "application/json");
  assert.equal(calls[0].options.headers["x-api-key"], apiKey);

  const reloaded = await jsonRequest(runtime.app, "/api/inventory/config");
  assert.equal(reloaded.body.connected, true);
  assert.equal(reloaded.body.last_connected_at, connected.body.last_connected_at);
  assert.equal(JSON.stringify(reloaded.body).includes(apiKey), false);
});

test("inventory routes submit direct cards, selected account IDs, normalized mailboxes, and pool data", async (t) => {
  const now = nowIso();
  const accounts = new Map([
    [101, {
      id: 101,
      email: "FIRST@EXAMPLE.COM",
      user_id: "chatgpt-account-101",
      credentials: [
        { key: "access_token", value: "generated-at-101" },
        { key: "refresh_token", value: "generated-rt-101" },
        { key: "client_id", value: "generated-client-101" },
      ],
    }],
    [102, {
      id: 102,
      email: "second@example.com",
      primary_token: "generated-at-102",
      credentials: [],
    }],
  ]);
  const registrationClient = {
    async getAccount(id) { return accounts.get(Number(id)) || null; },
  };
  const calls = [];
  const apiKey = "fixture-inventory-route-key-456";
  const runtime = createTestRuntime(t, {
    registrationClient,
    inventoryApiKey: apiKey,
    inventoryFetchFn: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ url: String(url), options, body });
      if (String(url).endsWith("/mailboxes/import")) {
        return jsonResponse({ matched: 2, updated: 2, unchanged: 0, invalid: 0, unmatched: 0 });
      }
      const cards = Array.isArray(body?.data) ? body.data : [body?.data].filter(Boolean);
      return jsonResponse({
        accepted: cards.map((card) => ({ email: card.email })),
        rejected: [],
        summary: { accepted: cards.length, rejected: 0 },
      }, 201);
    },
  });

  for (const [id, account] of accounts) {
    runtime.db.prepare(`
      INSERT INTO registration_jobs
        (email, external_account_id, status, stage, created_at, updated_at, finished_at)
      VALUES (?, ?, 'completed', 'completed', ?, ?, ?)
    `).run(account.email.toLowerCase(), String(id), now, now, now);
  }
  runtime.db.prepare(`
    INSERT INTO registration_jobs
      (email, external_account_id, status, stage, created_at, updated_at, finished_at)
    VALUES (?, ?, 'completed', 'completed', ?, ?, ?)
  `).run("missing@example.com", "103", now, now, now);

  const directCredential = {
    email: "direct@example.com",
    access_token: "direct-at",
    refresh_token: "direct-rt",
    type: "codex",
  };
  const direct = await jsonRequest(runtime.app, "/api/inventory/cards/import", {
    method: "POST",
    headers: { "idempotency-key": "cards-direct-fixture" },
    body: JSON.stringify({ data: directCredential }),
  });
  assert.equal(direct.response.status, 201);
  assert.equal(direct.body.accepted, 1);
  assert.deepEqual(direct.body.credential_failures, []);
  assert.equal(Object.hasOwn(direct.body, "source_count"), false);
  assert.deepEqual(calls[0].body, { data: directCredential });
  assert.equal(calls[0].url, "https://nvtokens.com/api/inventory/cards/import");
  assert.equal(calls[0].options.headers["x-api-key"], apiKey);
  assert.equal(calls[0].options.headers["Idempotency-Key"], "cards-direct-fixture");

  const selected = await jsonRequest(runtime.app, "/api/inventory/cards/import", {
    method: "POST",
    headers: { "idempotency-key": "cards-ids-fixture" },
    body: JSON.stringify({ ids: [101, 102, 103, 101] }),
  });
  assert.equal(selected.response.status, 201);
  assert.equal(selected.body.requested_count, 3);
  assert.equal(selected.body.source_count, 2);
  assert.equal(selected.body.local_failed_count, 1);
  assert.equal(selected.body.accepted, 2);
  assert.equal(selected.body.credential_failures.length, 1);
  assert.equal(selected.body.credential_failures[0].id, 103);
  assert.match(selected.body.credential_failures[0].error, /本地账号池删除/);
  assert.equal(calls[1].options.headers["Idempotency-Key"], "cards-ids-fixture");
  assert.deepEqual(calls[1].body.data.map((item) => item.email), [
    "first@example.com",
    "second@example.com",
  ]);
  assert.deepEqual(calls[1].body.data[0], {
    email: "first@example.com",
    access_token: "generated-at-101",
    refresh_token: "generated-rt-101",
    client_id: "generated-client-101",
    chatgpt_account_id: "chatgpt-account-101",
    type: "codex",
  });
  assert.deepEqual(calls[1].body.data[1], {
    email: "second@example.com",
    access_token: "generated-at-102",
    type: "codex",
  });

  const selectedAudit = runtime.db.prepare(`
    SELECT metadata FROM audit_log
    WHERE title = '提交账号到库存 API'
    ORDER BY id DESC LIMIT 1
  `).get();
  assert.deepEqual(JSON.parse(selectedAudit.metadata), {
    requested_count: 3,
    source_count: 2,
    local_failed_count: 1,
    accepted: 2,
    rejected: 0,
  });

  const allLocallyFailed = await jsonRequest(runtime.app, "/api/inventory/cards/import", {
    method: "POST",
    body: JSON.stringify({ ids: [103] }),
  });
  assert.equal(allLocallyFailed.response.status, 409);
  assert.equal(allLocallyFailed.body.code, "INVENTORY_LOCAL_CREDENTIALS_UNAVAILABLE");
  assert.equal(allLocallyFailed.body.requested_count, 1);
  assert.equal(allLocallyFailed.body.source_count, 0);
  assert.equal(allLocallyFailed.body.local_failed_count, 1);
  assert.equal(allLocallyFailed.body.credential_failures[0].id, 103);
  assert.equal(calls.length, 2);

  const mailboxText = [
    "link@example.com https://pickup.example.test/?token=mailbox-token-fixture",
    "oauth@example.com----password----client-id----refresh-token",
  ].join("\n");
  const mailboxes = await jsonRequest(runtime.app, "/api/inventory/mailboxes/import", {
    method: "POST",
    headers: { "idempotency-key": "mailboxes-fixture" },
    body: JSON.stringify({ text: mailboxText }),
  });
  assert.equal(mailboxes.response.status, 201);
  assert.equal(mailboxes.body.source, "text");
  assert.equal(mailboxes.body.source_count, 2);
  assert.equal(mailboxes.body.matched, 2);
  assert.deepEqual(mailboxes.body.missing_emails, []);
  assert.equal(calls[2].url, "https://nvtokens.com/api/inventory/mailboxes/import");
  assert.equal(calls[2].options.headers["Idempotency-Key"], "mailboxes-fixture");
  assert.deepEqual(calls[2].body, {
    text: [
      "link@example.com----https://pickup.example.test/?token=mailbox-token-fixture",
      "oauth@example.com----password----client-id----refresh-token",
    ].join("\n"),
  });

  runtime.inboxLinkMailboxes.import({ poolText: [
    "all-one@example.com https://pickup.example.test/?token=all-one-token",
    "all-two@example.com https://pickup.example.test/?token=all-two-token",
    "disabled@example.com https://pickup.example.test/?token=disabled-token",
  ].join("\n") });
  runtime.db.prepare("UPDATE inbox_link_mailboxes SET status = 'disabled' WHERE email = ? COLLATE NOCASE")
    .run("disabled@example.com");
  const allLinked = await jsonRequest(runtime.app, "/api/inventory/mailboxes/import", {
    method: "POST",
    headers: { "idempotency-key": "all-linked-fixture" },
    body: JSON.stringify({ all_linked: true }),
  });
  assert.equal(allLinked.response.status, 201);
  assert.equal(allLinked.body.source, "all_linked");
  assert.equal(allLinked.body.source_count, 2);
  assert.equal(allLinked.body.matched, 2);
  assert.equal(calls[3].url, "https://nvtokens.com/api/inventory/mailboxes/import");
  assert.equal(calls[3].options.headers["Idempotency-Key"], "all-linked-fixture");
  assert.deepEqual(calls[3].body, {
    text: [
      "all-one@example.com----https://pickup.example.test/?token=all-one-token",
      "all-two@example.com----https://pickup.example.test/?token=all-two-token",
    ].join("\n"),
  });

  const poolCredential = {
    email: "pool@example.com",
    access_token: "pool-at",
    refresh_token: "pool-rt",
    type: "codex",
  };
  const pooled = await jsonRequest(runtime.app, "/api/inventory/cards/pool", {
    method: "POST",
    headers: { "idempotency-key": "pool-fixture" },
    body: JSON.stringify({
      data: poolCredential,
      price_yuan: "10.00",
      warranty_channel_id: 7,
      warranty_name: "七天",
    }),
  });
  assert.equal(pooled.response.status, 201);
  assert.equal(pooled.body.accepted, 1);
  assert.equal(calls[4].url, "https://nvtokens.com/api/inventory/cards/pool");
  assert.equal(calls[4].options.headers["Idempotency-Key"], "pool-fixture");
  assert.deepEqual(calls[4].body, {
    data: poolCredential,
    price_yuan: "10.00",
    warranty_channel_id: 7,
    warranty_name: "七天",
  });

  const selectedPool = await jsonRequest(runtime.app, "/api/inventory/cards/pool", {
    method: "POST",
    body: JSON.stringify({ ids: [101, 103], price_yuan: "8.50" }),
  });
  assert.equal(selectedPool.response.status, 201);
  assert.equal(selectedPool.body.requested_count, 2);
  assert.equal(selectedPool.body.source_count, 1);
  assert.equal(selectedPool.body.local_failed_count, 1);
  assert.equal(selectedPool.body.credential_failures[0].id, 103);
  assert.deepEqual(calls[5].body, {
    data: [{
      email: "first@example.com",
      access_token: "generated-at-101",
      refresh_token: "generated-rt-101",
      client_id: "generated-client-101",
      chatgpt_account_id: "chatgpt-account-101",
      type: "codex",
    }],
    price_yuan: "8.50",
  });

  const insertLimitMailbox = runtime.db.prepare(`
    INSERT INTO inbox_link_mailboxes
      (email, inbox_key_hash, inbox_key_encrypted, inbox_key_preview, status, created_at, updated_at)
    VALUES (?, ?, ?, '', 'active', ?, ?)
  `);
  runtime.db.transaction(() => {
    for (let index = 0; index < 999; index += 1) {
      insertLimitMailbox.run(
        `limit-${index}@example.com`,
        `limit-hash-${index}`,
        "fixture-not-decrypted-because-limit-is-checked-first",
        now,
        now,
      );
    }
  })();
  const overLimit = await jsonRequest(runtime.app, "/api/inventory/mailboxes/import", {
    method: "POST",
    body: JSON.stringify({ all_linked: true }),
  });
  assert.equal(overLimit.response.status, 400);
  assert.match(overLimit.body.error, /1001.*最多导入 1000/);
  assert.equal(calls.length, 6);

  const overLimitText = await jsonRequest(runtime.app, "/api/inventory/mailboxes/import", {
    method: "POST",
    body: JSON.stringify({
      text: Array.from({ length: 1_001 }, (_, index) => `mail-${index}@example.com----https://pickup.example.test/?token=${index}`).join("\n"),
    }),
  });
  assert.equal(overLimitText.response.status, 400);
  assert.match(overLimitText.body.error, /最多导入 1000/);
  assert.equal(calls.length, 6);
});

test("inventory routes never echo API keys or submitted account credentials", async (t) => {
  const apiKey = "fixture-route-redaction-api-key";
  const accessToken = "fixture-route-redaction-access-token";
  const refreshToken = "fixture-route-redaction-refresh-token";
  const runtime = createTestRuntime(t, {
    inventoryApiKey: apiKey,
    inventoryFetchFn: async () => jsonResponse({
      matched: [{ access_token: accessToken }],
      updated: [{ refresh_token: refreshToken }],
      accepted: [],
      rejected: [{
        email: "rejected@example.com",
        reason: `token=${apiKey}; at=${accessToken}; rt=${refreshToken}`,
        line: { access_token: accessToken },
      }],
      summary: {
        accepted: 0,
        rejected: 1,
        unsafe: { api_key: apiKey },
      },
    }, 201),
  });
  const response = await jsonRequest(runtime.app, "/api/inventory/cards/import", {
    method: "POST",
    body: JSON.stringify({
      data: {
        email: "redaction@example.com",
        access_token: accessToken,
        refresh_token: refreshToken,
        type: "codex",
      },
    }),
  });
  assert.equal(response.response.status, 201);
  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes(apiKey), false);
  assert.equal(serialized.includes(accessToken), false);
  assert.equal(serialized.includes(refreshToken), false);
  assert.equal(response.body.matched, 1);
  assert.equal(response.body.updated, 1);
  assert.equal(response.body.rejected, 1);
  assert.equal(Object.hasOwn(response.body.failures[0], "line"), false);
  assert.deepEqual(response.body.summary, { accepted: 0, rejected: 1 });
});
