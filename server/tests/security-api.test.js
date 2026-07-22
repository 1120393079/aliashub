import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../db.js";
import { createApp } from "../index.js";
import { jsonRequest } from "./http-harness.js";

test("anonymous diagnostics stay minimal and protected downloads require admin auth", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-security-api-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const previousPassword = process.env.ADMIN_PASSWORD;
  const previousSecret = process.env.SESSION_SECRET;
  process.env.ADMIN_PASSWORD = "test-admin-password";
  process.env.SESSION_SECRET = "test-session-secret";
  const runtime = createApp({ db, seedDemo: false, publicBaseUrl: "https://alias.test/alias-hub" });
  await new Promise((resolve) => setImmediate(resolve));
  if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = previousPassword;
  if (previousSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSecret;
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const health = await jsonRequest(runtime.app, "/api/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, "ok");
  assert.equal(Object.hasOwn(health.body, "accounts"), false);

  const authStatus = await jsonRequest(runtime.app, "/api/auth/status");
  assert.deepEqual(authStatus.body, { authenticated: false, authEnabled: true });

  const authCheck = await jsonRequest(runtime.app, "/api/auth/check");
  assert.equal(authCheck.response.status, 401);

  const extension = await jsonRequest(runtime.app, "/api/extension/download");
  assert.equal(extension.response.status, 401);
  assert.equal(extension.body.code, "AUTH_REQUIRED");
});
