import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase, nowIso } from "../db.js";
import { createApp } from "../index.js";
import { jsonRequest } from "./http-harness.js";

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createTestApp(options) {
  const previousPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = "";
  try {
    return createApp(options);
  } finally {
    if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previousPassword;
  }
}

test("SUB2 environment variables take priority while legacy NFAPI variables remain compatible", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-sub2-env-test-"));
  const keys = ["SUB2_BASE_URL", "SUB2_ADMIN_API_KEY", "NFAPI_BASE_URL", "NFAPI_ADMIN_API_KEY"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const runtimes = [];
  t.after(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    runtimes.forEach((runtime) => runtime.db.close());
    keys.forEach((key) => {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    });
    fs.rmSync(directory, { recursive: true, force: true });
  });

  process.env.SUB2_BASE_URL = "https://preferred-sub2.test/api/v1";
  process.env.SUB2_ADMIN_API_KEY = "preferred-sub2-key";
  process.env.NFAPI_BASE_URL = "https://legacy-nfapi.test";
  process.env.NFAPI_ADMIN_API_KEY = "legacy-nfapi-key";
  const preferred = createTestApp({
    db: createDatabase({ filename: path.join(directory, "preferred.db"), seedDemo: false }),
  });
  runtimes.push(preferred);
  assert.equal(preferred.nfapi.baseUrl(), "https://preferred-sub2.test");
  assert.equal(preferred.nfapi.apiKey(), "preferred-sub2-key");

  delete process.env.SUB2_BASE_URL;
  delete process.env.SUB2_ADMIN_API_KEY;
  const legacy = createTestApp({
    db: createDatabase({ filename: path.join(directory, "legacy.db"), seedDemo: false }),
  });
  runtimes.push(legacy);
  assert.equal(legacy.nfapi.baseUrl(), "https://legacy-nfapi.test");
  assert.equal(legacy.nfapi.apiKey(), "legacy-nfapi-key");
});

test("NFapi admin routes keep secrets server-side and complete native OAuth account creation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-nfapi-api-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const now = nowIso();
  db.prepare(`
    INSERT INTO registration_jobs
      (account_id, address_id, email, status, stage, external_account_id, message, created_at, updated_at, finished_at)
    VALUES (NULL, NULL, ?, 'completed', 'completed', '42', 'done', ?, ?, ?)
  `).run("registered@example.com", now, now, now);

  const accessToken = jwt({
    email: "registered@example.com",
    sub: "user-42",
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-42", chatgpt_plan_type: "free" },
  });
  const oauthAccessToken = jwt({
    email: "registered@example.com",
    sub: "user-42",
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-42", chatgpt_user_id: "user-42" },
  });
  const accountPassword = "RegisteredPassword123!";
  const oauthState = "nfapi-state-fixture";
  const upstreamSessionId = "nfapi-upstream-session-fixture";
  const callbackCode = "nfapi-callback-code-fixture";
  let generatedOAuthSessions = 0;
  const registrationClient = {
    async getAccount(id) {
      if (Number(id) !== 42) return null;
      return {
        id: 42,
        platform: "chatgpt",
        email: "registered@example.com",
        password: accountPassword,
        password_status: "configured",
        password_available: true,
        credentials: [
          { key: "access_token", value: accessToken },
          { key: "account_id", value: "acct-42" },
        ],
      };
    },
  };
  const calls = [];
  const nfapiFetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: parsed.pathname, method: options.method || "GET", headers: options.headers, body });
    assert.equal(options.headers["x-api-key"], "nfapi-admin-secret");
    if (parsed.pathname.endsWith("/groups/all")) return jsonResponse({ data: [{ id: 3, name: "Codex", platform: "openai" }] });
    if (parsed.pathname.endsWith("/proxies/all")) {
      return jsonResponse({ data: [{ id: 7, name: "Tokyo", protocol: "http", ip_address: "203.0.113.8", password: "must-not-leak", url: "http://user:pass@proxy.test:8080" }] });
    }
    if (parsed.pathname.endsWith("/accounts") && (options.method || "GET") === "GET") return jsonResponse({ data: { items: [] } });
    if (parsed.pathname.endsWith("/openai/generate-auth-url")) {
      generatedOAuthSessions += 1;
      const params = new URLSearchParams({
        response_type: "code",
        state: `${oauthState}-${generatedOAuthSessions}`,
        redirect_uri: "http://localhost:1455/auth/callback",
      });
      return jsonResponse({ data: { auth_url: `https://auth.openai.com/oauth/authorize?${params}`, session_id: `${upstreamSessionId}-${generatedOAuthSessions}` } });
    }
    if (parsed.pathname.endsWith("/openai/exchange-code")) {
      return jsonResponse({ data: {
        access_token: oauthAccessToken,
        refresh_token: "oauth-refresh-fixture",
        id_token: "oauth-id-fixture",
        email: "registered@example.com",
        chatgpt_account_id: "acct-42",
        chatgpt_user_id: "user-42",
      } });
    }
    if (parsed.pathname.endsWith("/accounts") && options.method === "POST") return jsonResponse({ data: { id: 77 } });
    if (parsed.pathname.endsWith("/accounts/77") && options.method === "PUT") return jsonResponse({ data: { id: 77 } });
    if (parsed.pathname.endsWith("/accounts/bulk-update")) return jsonResponse({ data: { success: 1, failed: 0 } });
    return jsonResponse({ message: "unexpected request" }, 404);
  };
  const runtime = createTestApp({
    db,
    graph: { async scanInbox() { return { stage: "completed", messages: [], items: [] }; } },
    registrationClient,
    nfapiFetchFn: nfapiFetch,
    dataEncryptionKey: "test-encryption-key",
    publicBaseUrl: "https://alias.test/alias-hub",
  });

  try {
    const saved = await jsonRequest(runtime.app, "/api/nfapi/config", {
      method: "PATCH",
      body: JSON.stringify({ base_url: "https://nfapi.test/api/v1", admin_api_key: "nfapi-admin-secret" }),
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.base_url, "https://nfapi.test");
    assert.equal(saved.body.api_key_configured, true);
    assert.equal(JSON.stringify(saved.body).includes("nfapi-admin-secret"), false);

    const connected = await jsonRequest(runtime.app, "/api/nfapi/test", { method: "POST" });
    assert.equal(connected.response.status, 200);
    assert.equal(connected.body.connected, true);

    const options = await jsonRequest(runtime.app, "/api/nfapi/options");
    assert.equal(options.response.status, 200);
    assert.equal(options.body.groups[0].name, "Codex");
    assert.equal(options.body.proxies[0].name, "Tokyo");
    assert.equal(JSON.stringify(options.body).includes("must-not-leak"), false);
    assert.equal(JSON.stringify(options.body).includes("proxy.test"), false);

    const started = await jsonRequest(runtime.app, "/api/registration/accounts/42/nfapi-oauth/start", {
      method: "POST",
      body: JSON.stringify({
        options: { group_ids: [3], proxy_id: 7, concurrency: 6, name_prefix: "Local-" },
        save_defaults: true,
      }),
    });
    assert.equal(started.response.status, 201);
    assert.equal(started.body.authorization_required, true);
    assert.equal(started.body.status, "pending");
    assert.match(started.body.oauth_session_id, /^[0-9a-f-]{36}$/i);
    const publicAuthUrl = new URL(started.body.auth_url);
    assert.equal(publicAuthUrl.origin, "https://auth.openai.com");
    assert.equal(publicAuthUrl.pathname, "/oauth/authorize");
    assert.equal(publicAuthUrl.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
    assert.equal(publicAuthUrl.searchParams.get("login_hint"), "registered@example.com");
    for (const secret of [accessToken, oauthAccessToken, accountPassword, upstreamSessionId, "nfapi-admin-secret"]) {
      assert.equal(JSON.stringify(started.body).includes(secret), false);
    }
    const generateCall = calls.find((call) => call.path.endsWith("/openai/generate-auth-url"));
    assert.deepEqual(generateCall.body, { proxy_id: 7 });

    const restarted = await jsonRequest(runtime.app, "/api/registration/accounts/42/nfapi-oauth/start", {
      method: "POST",
      body: JSON.stringify({
        force_restart: true,
        options: { proxy_id: 999, concurrency: 99 },
      }),
    });
    assert.equal(restarted.response.status, 201);
    assert.notEqual(restarted.body.oauth_session_id, started.body.oauth_session_id);
    assert.equal(new URL(restarted.body.auth_url).searchParams.get("login_hint"), "registered@example.com");
    assert.deepEqual(
      calls.filter((call) => call.path.endsWith("/openai/generate-auth-url")).map((call) => call.body),
      [{ proxy_id: 7 }, { proxy_id: 7 }],
    );
    const retired = db.prepare("SELECT status, payload_encrypted FROM nfapi_oauth_import_sessions WHERE id = ?")
      .get(started.body.oauth_session_id);
    assert.equal(retired.status, "expired");
    assert.equal(retired.payload_encrypted, "");
    const activeOAuthState = new URL(restarted.body.auth_url).searchParams.get("state");

    const retiredCallback = await jsonRequest(
      runtime.app,
      `/api/registration/accounts/42/nfapi-oauth/${encodeURIComponent(started.body.oauth_session_id)}/complete`,
      {
        method: "POST",
        body: JSON.stringify({
          callback_url: `http://localhost:1455/auth/callback?${new URLSearchParams({ code: callbackCode, state: `${oauthState}-1` })}`,
        }),
      },
    );
    assert.equal(retiredCallback.response.status, 410);
    assert.equal(calls.some((call) => call.path.endsWith("/openai/exchange-code")), false);

    const mismatchedRoute = await jsonRequest(
      runtime.app,
      `/api/registration/accounts/43/nfapi-oauth/${encodeURIComponent(restarted.body.oauth_session_id)}/complete`,
      {
        method: "POST",
        body: JSON.stringify({
          callback_url: `http://localhost:1455/auth/callback?${new URLSearchParams({ code: callbackCode, state: activeOAuthState })}`,
        }),
      },
    );
    assert.equal(mismatchedRoute.response.status, 409);
    assert.match(mismatchedRoute.body.error, /会话与所选账号不匹配/);
    assert.equal(calls.some((call) => call.path.endsWith("/openai/exchange-code")), false);
    assert.equal(
      db.prepare("SELECT status FROM nfapi_oauth_import_sessions WHERE id = ?").get(restarted.body.oauth_session_id).status,
      "pending",
    );

    const completed = await jsonRequest(
      runtime.app,
      `/api/registration/accounts/42/nfapi-oauth/${encodeURIComponent(restarted.body.oauth_session_id)}/complete`,
      {
        method: "POST",
        body: JSON.stringify({
          callback_url: `http://localhost:1455/auth/callback?${new URLSearchParams({ code: callbackCode, state: activeOAuthState })}`,
        }),
      },
    );
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.status, "completed");
    assert.equal(completed.body.action, "created");
    assert.equal(completed.body.nfapi_account_id, 77);
    assert.equal(completed.body.short_lived, false);
    for (const secret of [accessToken, oauthAccessToken, accountPassword, upstreamSessionId, callbackCode, "nfapi-admin-secret"]) {
      assert.equal(JSON.stringify(completed.body).includes(secret), false);
    }

    const exchangeCall = calls.find((call) => call.path.endsWith("/openai/exchange-code"));
    assert.deepEqual(exchangeCall.body, {
      session_id: `${upstreamSessionId}-2`,
      code: callbackCode,
      state: activeOAuthState,
      proxy_id: 7,
    });
    const createCall = calls.find((call) => call.path.endsWith("/accounts") && call.method === "POST");
    assert.equal(createCall.body.credentials.access_token, oauthAccessToken);
    assert.equal(createCall.body.credentials.refresh_token, "oauth-refresh-fixture");
    assert.deepEqual(createCall.body.group_ids, [3]);
    assert.equal(createCall.body.proxy_id, 7);
    assert.equal(createCall.body.concurrency, 6);
    assert.equal(createCall.body.auto_pause_on_expired, true);
    assert.match(createCall.headers["Idempotency-Key"], /^aliashub-oauth-[a-f0-9]{64}$/);
    const updateCall = calls.find((call) => call.path.endsWith("/accounts/77") && call.method === "PUT");
    assert.equal(Object.hasOwn(updateCall.body, "credentials"), false);
    assert.equal(Object.hasOwn(updateCall.body, "extra"), false);
    const bulkCall = calls.find((call) => call.path.endsWith("/accounts/bulk-update"));
    assert.deepEqual(bulkCall.body.account_ids, [77]);
    assert.equal(Object.hasOwn(bulkCall.body.credentials, "access_token"), false);
    assert.equal(bulkCall.body.extra.import_source, "aliashub_registration");
    assert.equal(bulkCall.body.extra.codex_image_generation_bridge, null);
    assert.equal(calls.some((call) => call.path.endsWith("/accounts/import/codex-session")), false);

    const deprecated = await jsonRequest(runtime.app, "/api/registration/accounts/import-nfapi", {
      method: "POST",
      body: JSON.stringify({ ids: [42] }),
    });
    assert.equal(deprecated.response.status, 410);

    const config = await jsonRequest(runtime.app, "/api/nfapi/config");
    const settings = await jsonRequest(runtime.app, "/api/settings");
    assert.equal(JSON.stringify(config.body).includes("nfapi-admin-secret"), false);
    assert.equal(Object.hasOwn(settings.body, "nfapi_admin_api_key_encrypted"), false);
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    runtime.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
