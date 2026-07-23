import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../db.js";
import { createApp } from "../index.js";
import { jsonRequest } from "./http-harness.js";

function createRuntime(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-microsoft-registration-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const runtime = createApp({
    db,
    publicBaseUrl: "https://aliashub.test",
    dataEncryptionKey: "microsoft-registration-test-key",
    ...options,
  });
  t.after(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return runtime;
}

test("Microsoft registration webhook keeps credentials encrypted and exposes only explicit reveal data", async (t) => {
  const runtime = createRuntime(t);
  const initial = await jsonRequest(runtime.app, "/api/microsoft-registration/config");
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.webhook_configured, false);
  assert.equal(initial.body.encryption_ready, true);

  const created = await jsonRequest(runtime.app, "/api/microsoft-registration/webhook-token", { method: "POST" });
  assert.equal(created.response.status, 201);
  assert.match(created.body.ingest_url, /^https:\/\/aliashub\.test\/api\/integrations\/microsoft-register\/v1\/ingest\//);
  assert.match(created.body.config_snippet, /server_upload_url/);
  const ingestPath = new URL(created.body.ingest_url).pathname;
  const payload = {
    data: {
      task_id: "go-ms-task-1",
      email: "worker@outlook.com",
      password: "Pass-For-Test-Only",
      refresh_token: "refresh-token-for-test-only",
      access_token: "access-token-for-test-only",
      status: "success",
      proxy: "proxy-user:proxy-password@198.51.100.24:9000",
    },
    server_upload_other: { source: "go-ms-v9.2.8", batch: "batch-a" },
  };
  const invalid = await jsonRequest(runtime.app, `${ingestPath}-invalid`, { method: "POST", body: JSON.stringify(payload) });
  assert.equal(invalid.response.status, 401);

  const ingested = await jsonRequest(runtime.app, ingestPath, { method: "POST", body: JSON.stringify(payload) });
  assert.equal(ingested.response.status, 202);
  assert.deepEqual(ingested.body, { success: true, accepted: 1, updated: 0, ignored: 0, duplicates: 0, import_id: 1 });

  const duplicate = await jsonRequest(runtime.app, ingestPath, { method: "POST", body: JSON.stringify(payload) });
  assert.equal(duplicate.response.status, 202);
  assert.equal(duplicate.body.duplicates, 1);

  const listed = await jsonRequest(runtime.app, "/api/microsoft-registration/accounts");
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.total, 1);
  const record = listed.body.items[0];
  assert.deepEqual(
    {
      email: record.email,
      status: record.status,
      proxy_label: record.proxy_label,
      has_password: record.has_password,
      has_refresh_token: record.has_refresh_token,
      has_access_token: record.has_access_token,
    },
    {
      email: "worker@outlook.com",
      status: "success",
      proxy_label: "198.51.100.24:9000",
      has_password: true,
      has_refresh_token: true,
      has_access_token: true,
    },
  );
  const listedText = JSON.stringify(listed.body);
  assert.equal(listedText.includes("Pass-For-Test-Only"), false);
  assert.equal(listedText.includes("refresh-token-for-test-only"), false);
  assert.equal(listedText.includes("proxy-password"), false);

  const stored = runtime.db.prepare("SELECT raw_payload_encrypted FROM microsoft_registration_imports WHERE id = 1").get();
  assert.equal(stored.raw_payload_encrypted.includes("Pass-For-Test-Only"), false);
  const revealed = await jsonRequest(runtime.app, `/api/microsoft-registration/accounts/${record.id}/credentials`);
  assert.deepEqual(revealed.body, {
    id: record.id,
    email: "worker@outlook.com",
    password: "Pass-For-Test-Only",
    refresh_token: "refresh-token-for-test-only",
    access_token: "access-token-for-test-only",
    scope: "",
  });

  const update = await jsonRequest(runtime.app, ingestPath, {
    method: "POST",
    body: JSON.stringify({
      data: JSON.stringify({ task_id: "go-ms-task-2", email: "worker@outlook.com", status: "failed", message: "retry later" }),
      server_upload_other: { source: "go-ms-v9.2.8", batch: "batch-b" },
    }),
  });
  assert.equal(update.response.status, 202);
  assert.deepEqual(update.body, { success: true, accepted: 0, updated: 1, ignored: 0, duplicates: 0, import_id: 2 });
  const retained = await jsonRequest(runtime.app, `/api/microsoft-registration/accounts/${record.id}/credentials`);
  assert.equal(retained.body.password, "Pass-For-Test-Only");
  assert.equal(retained.body.refresh_token, "refresh-token-for-test-only");

  const attached = await jsonRequest(runtime.app, `/api/microsoft-registration/accounts/${record.id}/add-source`, { method: "POST" });
  assert.equal(attached.response.status, 200);
  assert.equal(attached.body.existing, false);
  assert.equal(attached.body.account.email, "worker@outlook.com");
  assert.equal(attached.body.account.provider, "microsoft");
  const refreshedList = await jsonRequest(runtime.app, "/api/microsoft-registration/accounts");
  assert.equal(refreshedList.body.items[0].source_account_id, attached.body.account.id);

  const settings = await jsonRequest(runtime.app, "/api/settings");
  assert.equal(settings.body.microsoft_registration_webhook_token_hash, undefined);
  const rotated = await jsonRequest(runtime.app, "/api/microsoft-registration/webhook-token", { method: "POST" });
  const newIngestPath = new URL(rotated.body.ingest_url).pathname;
  const oldToken = await jsonRequest(runtime.app, ingestPath, { method: "POST", body: JSON.stringify({ data: { email: "old-token@outlook.com" } }) });
  assert.equal(oldToken.response.status, 401);
  const newToken = await jsonRequest(runtime.app, newIngestPath, { method: "POST", body: JSON.stringify({ data: { email: "new-token@outlook.com", status: "success" } }) });
  assert.equal(newToken.response.status, 202);
});

test("Microsoft registration integration fails closed without an encryption key", async (t) => {
  const runtime = createRuntime(t, { dataEncryptionKey: "" });
  const response = await jsonRequest(runtime.app, "/api/microsoft-registration/webhook-token", { method: "POST" });
  assert.equal(response.response.status, 409);
});
