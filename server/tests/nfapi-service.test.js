import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase, nowIso } from "../db.js";
import { NfapiService, normalizeNfapiBaseUrl, normalizeNfapiImportOptions } from "../nfapi-service.js";

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

function identityJwt({ email, accountId, userId = `user-${accountId}`, subject = `auth0|${userId}` }) {
  return jwt({
    sub: subject,
    "https://api.openai.com/profile": { email },
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_user_id: userId,
      user_id: userId,
    },
  });
}

function setRegistrationIdentity(account, {
  email = account.email,
  accountId = account.user_id,
  userId = `user-${accountId}`,
  responseId = account.id,
} = {}) {
  account.id = responseId;
  account.email = email;
  account.user_id = accountId;
  account.credentials = [
    { key: "account_id", value: accountId },
    { key: "access_token", value: identityJwt({ email, accountId, userId }) },
  ];
  return account;
}

function testDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-nfapi-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

function addRegisteredSource(db, { id, email, customName = "", groupName = "" }) {
  const now = nowIso();
  db.prepare(`
    INSERT INTO registration_jobs
      (email, external_account_id, status, stage, created_at, updated_at, finished_at)
    VALUES (?, ?, 'completed', 'completed', ?, ?, ?)
  `).run(email, String(id), now, now, now);
  if (customName || groupName) {
    db.prepare(`
      INSERT INTO registered_account_metadata
        (external_account_id, email, custom_name, group_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(String(id), email, customName, groupName, now, now);
  }
}

function registrationAccount({ id, email, accountId = `workspace-${id}`, passwordConfigured = true }) {
  return setRegistrationIdentity({
    id,
    platform: "chatgpt",
    email,
    password: passwordConfigured ? "LoginPassword123!" : "",
    overview: { password_status: passwordConfigured ? "configured" : "not_configured" },
    // Frcibly's ChatGPT adapter keeps the workspace UUID in this legacy field.
    user_id: accountId,
    plan_name: "free",
    credentials: [],
  }, { email, accountId });
}

function oauthTokenInfo({ email, accountId, accessToken = "", refreshToken = "oauth-refresh", idToken = "oauth-id" }) {
  return {
    access_token: accessToken || jwt({
      email,
      exp: Math.floor(Date.now() / 1000) + 3_600,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_user_id: `user-${accountId}` },
    }),
    refresh_token: refreshToken,
    id_token: idToken,
    email,
    chatgpt_account_id: accountId,
    chatgpt_user_id: `user-${accountId}`,
    client_id: "codex-client",
    expires_at: Math.floor(Date.now() / 1000) + 3_600,
  };
}

function oauthAuthUrl(state = "expected-state") {
  const params = new URLSearchParams({
    response_type: "code",
    state,
    redirect_uri: "http://localhost:1455/auth/callback",
  });
  return `https://auth.openai.com/oauth/authorize?${params}`;
}

function callbackUrl(state = "expected-state", code = "authorization-code") {
  return `http://localhost:1455/auth/callback?${new URLSearchParams({ code, state })}`;
}

function createService({ db, accounts, nfapiClient, apiKey = "nfapi-secret", oauthSessionTtlMs, nowFn }) {
  const byId = new Map(accounts.map((account) => [Number(account.id), account]));
  const service = new NfapiService({
    db,
    registrationClient: {
      async getAccount(id) { return byId.get(Number(id)) || null; },
    },
    encryptionKey: "test-encryption-key",
    baseUrl: "https://nfapi.test",
    apiKey,
    oauthSessionTtlMs,
    nowFn,
  });
  service.client = () => nfapiClient;
  return service;
}

test("SUB2 compatible service is disabled by default without making requests", async (t) => {
  const db = testDatabase(t);
  const service = new NfapiService({
    db,
    registrationClient: {},
    encryptionKey: "test-encryption-key",
    fetchFn: async () => { throw new Error("unconfigured service must not make a request"); },
  });

  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'nfapi_base_url'").get().value, "");
  assert.deepEqual(service.configuration(), {
    base_url: "",
    api_key_configured: false,
    configured: false,
    connected: false,
    last_connected_at: "",
  });
  const options = await service.options();
  assert.equal(options.connection.configured, false);
  assert.deepEqual(options.groups, []);
  assert.deepEqual(options.proxies, []);
  assert.equal(normalizeNfapiBaseUrl(""), "");
});

test("SUB2 compatible service configuration and options never return configured secrets", async (t) => {
  const db = testDatabase(t);
  const secret = "top-secret-admin-api-key";
  const service = new NfapiService({
    db,
    registrationClient: {},
    encryptionKey: "test-encryption-key",
    fetchFn: async (url) => {
      if (String(url).includes("/groups/")) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      if (String(url).includes("/proxies/")) return new Response(JSON.stringify({ data: [{ id: 9, name: "JP", password: "proxy-password", username: "proxy-user", host: "private.proxy" }] }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`unexpected URL: ${url}`);
    },
  });

  const configuration = service.updateConfiguration({
    base_url: "https://nfapi.test/admin/accounts",
    admin_api_key: secret,
  });
  const options = await service.options();

  assert.equal(configuration.base_url, "https://nfapi.test");
  assert.equal(configuration.api_key_configured, true);
  assert.equal(JSON.stringify(configuration).includes(secret), false);
  assert.equal(JSON.stringify(options).includes(secret), false);
  assert.equal(JSON.stringify(options).includes("proxy-password"), false);
  assert.equal(JSON.stringify(options).includes("proxy-user"), false);
  assert.equal(JSON.stringify(options).includes("private.proxy"), false);
});

test("normalizes every NFapi import option and preserves explicit false and zero values", () => {
  const future = Math.floor(Date.now() / 1000) + 86_400;
  const options = normalizeNfapiImportOptions({
    name_prefix: "NF-",
    account_name: "Primary",
    notes: "full settings",
    status: "inactive",
    model_mapping: { "gpt-5.6": "gpt-5.6" },
    compact_model_mapping: { "gpt-5.6": "gpt-5.4-mini" },
    proxy_id: 9,
    concurrency: 17,
    load_factor: 0,
    priority: 4,
    rate_multiplier: 0,
    expires_at: future,
    auto_pause_on_expired: false,
    temp_unschedulable_enabled: true,
    temp_unschedulable_rules: [{ error_code: 429, keywords: "rate limit, quota", duration_minutes: 45, description: "busy" }],
    ws_mode: "http_bridge",
    openai_passthrough: false,
    codex_cli_only: false,
    allow_app_server: false,
    compact_mode: "force_on",
    image_bridge_mode: "disabled",
    auto_pause_5h_disabled: true,
    auto_pause_5h_threshold: 95,
    auto_pause_7d_disabled: true,
    auto_pause_7d_threshold: 88,
    group_ids: [27, 28, 27],
    update_existing: false,
    skip_default_group_bind: true,
    confirm_mixed_channel_risk: true,
  });

  assert.equal(options.load_factor, 0);
  assert.equal(options.rate_multiplier, 0);
  assert.equal(options.auto_pause_on_expired, false);
  assert.equal(options.openai_passthrough, false);
  assert.deepEqual(options.group_ids, [27, 28]);
  assert.deepEqual(options.temp_unschedulable_rules[0].keywords, ["rate limit", "quota"]);
});

test("rejects invalid expiration and unsupported image policy", () => {
  assert.throws(
    () => normalizeNfapiImportOptions({ expires_at: Math.floor(Date.now() / 1000) - 1 }),
    /过期时间必须晚于当前时间/,
  );
  assert.throws(() => normalizeNfapiImportOptions({ image_bridge_mode: "block" }), /图片桥接模式无效/);
});

test("matches a unique complete identity, allows one missing-user pair, and never matches workspace alone", (t) => {
  const db = testDatabase(t);
  const service = new NfapiService({ db, registrationClient: {}, encryptionKey: "test", apiKey: "key" });
  const source = { credentials: { accountId: "shared-workspace", userId: "user-right", email: "same@example.com" } };
  const otherEmail = { id: 1, credentials: { chatgpt_account_id: "shared-workspace", chatgpt_user_id: "user-other", email: "other@example.com" } };
  const wrongUser = { id: 2, credentials: { chatgpt_account_id: "shared-workspace", chatgpt_user_id: "user-wrong", email: "same@example.com" } };
  const right = { id: 3, credentials: { chatgpt_account_id: "shared-workspace", chatgpt_user_id: "user-right", email: "same@example.com" } };
  const incomplete = { id: 4, credentials: { chatgpt_account_id: "shared-workspace", email: "same@example.com" } };

  assert.equal(service.findExisting([otherEmail, wrongUser, right], source).id, 3);
  assert.equal(service.findExisting([otherEmail], source), null);
  assert.throws(() => service.findExisting([wrongUser], source), /同邮箱但用户/);
  assert.equal(service.findExisting([incomplete], source).id, 4);
});

test("rejects an ambiguous email-workspace fallback even when only one candidate lacks a user ID", (t) => {
  const db = testDatabase(t);
  const service = new NfapiService({ db, registrationClient: {}, encryptionKey: "test", apiKey: "key" });
  const source = { credentials: { accountId: "workspace", userId: "expected-user", email: "same@example.com" } };
  const incomplete = { id: 5, credentials: { chatgpt_account_id: "workspace", email: "same@example.com" } };
  const wrongUser = { id: 6, credentials: { chatgpt_account_id: "workspace", chatgpt_user_id: "wrong-user", email: "same@example.com" } };

  assert.throws(
    () => service.findExisting([incomplete, wrongUser], source),
    /同一邮箱和 workspace 存在多个/,
  );
});

test("uses a validated AliasHub link to disambiguate duplicates and rejects a mismatched link", (t) => {
  const db = testDatabase(t);
  const service = new NfapiService({ db, registrationClient: {}, encryptionKey: "test", apiKey: "key", baseUrl: "https://nfapi.test" });
  const source = { credentials: { accountId: "workspace", userId: "user", email: "same@example.com" } };
  const first = { id: 11, credentials: { chatgpt_account_id: "workspace", chatgpt_user_id: "user", email: "same@example.com" } };
  const second = { id: 12, credentials: { chatgpt_account_id: "workspace", chatgpt_user_id: "user", email: "same@example.com" } };

  assert.throws(() => service.findExisting([first, second], source), /多个完全相同身份/);
  assert.equal(service.findExisting([first, second], source, 12).id, 12);
  assert.throws(
    () => service.findExisting([{ ...second, credentials: { ...second.credentials, email: "other@example.com" } }], source, 12),
    /已绑定的 SUB2 兼容服务账号身份不匹配/,
  );
});

test("start rejects inconsistent Frcibly top-level, credential, and JWT identities before contacting NFapi", async (t) => {
  const db = testDatabase(t);
  const cases = [];

  const credentialEmail = registrationAccount({ id: 71, email: "source-email@example.com", accountId: "workspace-71" });
  credentialEmail.credentials.push({ key: "email", value: "other-email@example.com" });
  cases.push(credentialEmail);

  const topWorkspace = registrationAccount({ id: 72, email: "top-workspace@example.com", accountId: "workspace-72" });
  topWorkspace.user_id = "other-workspace";
  cases.push(topWorkspace);

  const accessWorkspace = registrationAccount({ id: 73, email: "access-workspace@example.com", accountId: "workspace-73" });
  accessWorkspace.credentials.find((item) => item.key === "access_token").value = identityJwt({
    email: accessWorkspace.email,
    accountId: "other-workspace",
    userId: "user-other-workspace",
  });
  cases.push(accessWorkspace);

  const credentialUser = registrationAccount({ id: 74, email: "credential-user@example.com", accountId: "workspace-74" });
  credentialUser.credentials.push({ key: "chatgpt_user_id", value: "other-user" });
  cases.push(credentialUser);

  const idTokenSubject = registrationAccount({ id: 75, email: "id-subject@example.com", accountId: "workspace-75" });
  idTokenSubject.credentials.push({
    key: "id_token",
    value: identityJwt({
      email: idTokenSubject.email,
      accountId: "workspace-75",
      userId: "user-workspace-75",
      subject: "auth0|different-subject",
    }),
  });
  cases.push(idTokenSubject);

  cases.forEach((account) => addRegisteredSource(db, { id: account.id, email: account.email }));
  let upstreamCalls = 0;
  const service = createService({
    db,
    accounts: cases,
    nfapiClient: {
      async listOpenAiOauthAccounts() { upstreamCalls += 1; return []; },
      async generateOpenAiOAuthUrl() { upstreamCalls += 1; return { auth_url: oauthAuthUrl(), session_id: "must-not-generate" }; },
    },
  });

  for (const account of cases) {
    await assert.rejects(
      () => service.startOAuthImport({ id: account.id }),
      (error) => error.status === 409 && /身份字段不一致/.test(error.message),
    );
  }
  assert.equal(upstreamCalls, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nfapi_oauth_import_sessions").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM registered_account_nfapi_links").get().count, 0);
});

test("complete rejects contradictory NFapi top-level, access JWT, and id JWT identities", async (t) => {
  const db = testDatabase(t);
  const cases = [{
    id: 76,
    email: "token-email@example.com",
    accountId: "workspace-token-email",
    token(email, accountId) {
      return {
        ...oauthTokenInfo({ email, accountId }),
        access_token: identityJwt({ email: "other-token-email@example.com", accountId }),
        id_token: "",
      };
    },
  }, {
    id: 77,
    email: "token-workspace@example.com",
    accountId: "workspace-token-workspace",
    token(email, accountId) {
      return {
        ...oauthTokenInfo({ email, accountId, accessToken: identityJwt({ email, accountId }) }),
        id_token: identityJwt({ email, accountId: "other-token-workspace", userId: `user-${accountId}` }),
      };
    },
  }, {
    id: 78,
    email: "token-user@example.com",
    accountId: "workspace-token-user",
    token(email, accountId) {
      return {
        ...oauthTokenInfo({ email, accountId, accessToken: identityJwt({ email, accountId }) }),
        id_token: identityJwt({ email, accountId, userId: "other-token-user" }),
      };
    },
  }];

  for (const item of cases) {
    const local = registrationAccount(item);
    addRegisteredSource(db, item);
    let exchanges = 0;
    let mutations = 0;
    const service = createService({
      db,
      accounts: [local],
      nfapiClient: {
        async listOpenAiOauthAccounts() { return []; },
        async generateOpenAiOAuthUrl() { return { auth_url: oauthAuthUrl(), session_id: `upstream-${item.id}` }; },
        async exchangeOpenAiOAuthCode() { exchanges += 1; return item.token(item.email, item.accountId); },
        async createAccount() { mutations += 1; return { id: 1_000 + item.id }; },
        async applyOAuthCredentials() { mutations += 1; },
      },
    });
    const started = await service.startOAuthImport({ id: item.id });

    await assert.rejects(
      () => service.completeOAuthImport(started.oauth_session_id, callbackUrl()),
      (error) => error.status === 409 && /Token .*身份字段不一致/.test(error.message),
    );
    assert.equal(exchanges, 1);
    assert.equal(mutations, 0);
    const row = db.prepare("SELECT status, payload_encrypted FROM nfapi_oauth_import_sessions WHERE id = ?")
      .get(started.oauth_session_id);
    assert.equal(row.status, "failed");
    assert.equal(row.payload_encrypted, "");
  }
});

test("complete revalidates id, email, workspace, and user snapshots before exchanging a code", async (t) => {
  const db = testDatabase(t);
  const cases = [{
    id: 79,
    email: "changed-id@example.com",
    accountId: "workspace-79",
    mutate(account) { account.id = 1_079; },
  }, {
    id: 80,
    email: "changed-email@example.com",
    accountId: "workspace-80",
    mutate(account) { setRegistrationIdentity(account, { email: "other-current-email@example.com" }); },
  }, {
    id: 81,
    email: "changed-workspace@example.com",
    accountId: "workspace-81",
    mutate(account) { setRegistrationIdentity(account, { accountId: "other-current-workspace" }); },
  }, {
    id: 82,
    email: "changed-user@example.com",
    accountId: "workspace-82",
    mutate(account) { setRegistrationIdentity(account, { userId: "other-current-user" }); },
  }];

  for (const item of cases) {
    const local = registrationAccount(item);
    addRegisteredSource(db, item);
    let exchanges = 0;
    const service = createService({
      db,
      accounts: [local],
      nfapiClient: {
        async listOpenAiOauthAccounts() { return []; },
        async generateOpenAiOAuthUrl() { return { auth_url: oauthAuthUrl(), session_id: `snapshot-${item.id}` }; },
        async exchangeOpenAiOAuthCode() { exchanges += 1; return oauthTokenInfo(item); },
      },
    });
    const started = await service.startOAuthImport({ id: item.id });
    item.mutate(local);

    await assert.rejects(
      () => service.completeOAuthImport(started.oauth_session_id, callbackUrl()),
      (error) => error.status === 409,
    );
    assert.equal(exchanges, 0);
    const row = db.prepare(`
      SELECT status, payload_encrypted, consumed_at FROM nfapi_oauth_import_sessions WHERE id = ?
    `).get(started.oauth_session_id);
    assert.equal(row.status, "failed");
    assert.equal(row.payload_encrypted, "");
    assert.ok(row.consumed_at);
  }
});

test("new accounts use NFapi OAuth then standard create and preserve every advanced setting", async (t) => {
  const db = testDatabase(t);
  const id = 51;
  const email = "oauth-create@example.com";
  const accountId = "workspace-create";
  const localAccount = registrationAccount({ id, email, accountId });
  addRegisteredSource(db, { id, email, customName: "Create account", groupName: "OAuth" });
  const tokenInfo = oauthTokenInfo({ email, accountId });
  const calls = [];
  let directImports = 0;
  const nfapiClient = {
    async listOpenAiOauthAccounts() { calls.push("list"); return []; },
    async generateOpenAiOAuthUrl(payload) {
      calls.push("generate");
      assert.deepEqual(payload, { proxy_id: 9 });
      return { auth_url: oauthAuthUrl(), session_id: "upstream-session-private" };
    },
    async exchangeOpenAiOAuthCode(payload) {
      calls.push("exchange");
      assert.deepEqual(payload, {
        session_id: "upstream-session-private",
        code: "authorization-code-private",
        state: "expected-state",
        proxy_id: 9,
      });
      return tokenInfo;
    },
    async createAccount(payload, idempotencyKey) {
      calls.push("create");
      assert.match(idempotencyKey, /^aliashub-oauth-[a-f0-9]{64}$/);
      assert.equal(payload.platform, "openai");
      assert.equal(payload.type, "oauth");
      assert.equal(payload.credentials.access_token, tokenInfo.access_token);
      assert.equal(payload.credentials.refresh_token, tokenInfo.refresh_token);
      assert.deepEqual(payload.credentials.model_mapping, { "gpt-5.6": "gpt-5.6" });
      assert.equal(payload.extra.import_source, "aliashub_registration");
      assert.equal(payload.extra.openai_ws_force_http, true);
      assert.equal(payload.proxy_id, 9);
      assert.deepEqual(payload.group_ids, [27, 28]);
      assert.equal(payload.concurrency, 17);
      assert.equal(payload.load_factor, 13);
      assert.equal(payload.priority, 4);
      assert.equal(payload.rate_multiplier, 1.25);
      assert.equal(payload.confirm_mixed_channel_risk, true);
      return { id: 801 };
    },
    async updateAccount(idValue, payload) {
      calls.push("update");
      assert.equal(idValue, 801);
      assert.equal(payload.status, "inactive");
      assert.equal(payload.proxy_id, 9);
      assert.deepEqual(payload.group_ids, [27, 28]);
      assert.equal(Object.hasOwn(payload, "credentials"), false);
      assert.equal(Object.hasOwn(payload, "extra"), false);
      return { id: 801 };
    },
    async bulkUpdateAccounts(payload) {
      calls.push("bulk");
      assert.deepEqual(payload.account_ids, [801]);
      assert.equal(payload.credentials.temp_unschedulable_enabled, true);
      assert.equal(payload.extra.openai_compact_mode, "force_on");
      assert.equal(payload.extra.codex_image_generation_bridge, false);
      assert.equal(JSON.stringify(payload).includes(tokenInfo.access_token), false);
      return { updated: 1, failed: 0 };
    },
    async importCodexSession() { directImports += 1; throw new Error("direct import must not run"); },
  };
  const service = createService({ db, accounts: [localAccount], nfapiClient });
  const future = Math.floor(Date.now() / 1000) + 86_400;
  const options = {
    name_prefix: "NF-",
    notes: "all settings",
    status: "inactive",
    model_mapping: { "gpt-5.6": "gpt-5.6" },
    compact_model_mapping: { "gpt-5.6": "gpt-5.4-mini" },
    proxy_id: 9,
    concurrency: 17,
    load_factor: 13,
    priority: 4,
    rate_multiplier: 1.25,
    expires_at: future,
    auto_pause_on_expired: false,
    temp_unschedulable_enabled: true,
    temp_unschedulable_rules: [{ error_code: 429, keywords: ["quota"], duration_minutes: 45, description: "busy" }],
    ws_mode: "http_bridge",
    openai_passthrough: false,
    codex_cli_only: false,
    allow_app_server: false,
    compact_mode: "force_on",
    image_bridge_mode: "disabled",
    auto_pause_5h_disabled: true,
    auto_pause_5h_threshold: 95,
    auto_pause_7d_disabled: true,
    auto_pause_7d_threshold: 88,
    group_ids: [27, 28],
    update_existing: true,
    skip_default_group_bind: true,
    confirm_mixed_channel_risk: true,
  };

  const started = await service.startOAuthImport({ ids: [id], options, save_defaults: true });
  assert.equal(started.authorization_required, true);
  assert.equal(started.action, "create");
  const startedUrl = new URL(started.auth_url);
  assert.equal(startedUrl.searchParams.get("state"), "expected-state");
  assert.equal(startedUrl.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(startedUrl.searchParams.get("login_hint"), email);
  const stored = db.prepare("SELECT * FROM nfapi_oauth_import_sessions WHERE id = ?").get(started.oauth_session_id);
  assert.equal(stored.external_account_id, id);
  assert.match(stored.payload_encrypted, /^v1\./);
  for (const secret of ["upstream-session-private", "expected-state", email, "LoginPassword123!"]) {
    assert.equal(stored.payload_encrypted.includes(secret), false);
  }
  const decrypted = JSON.parse(service.decrypt(stored.payload_encrypted));
  assert.equal(decrypted.upstreamSessionId, "upstream-session-private");
  assert.equal(Object.hasOwn(decrypted.source.account, "password"), false);

  const completed = await service.completeOAuthImport(
    started.oauth_session_id,
    callbackUrl("expected-state", "authorization-code-private"),
  );

  assert.deepEqual(calls, ["list", "generate", "exchange", "list", "create", "update", "bulk"]);
  assert.equal(directImports, 0);
  assert.equal(completed.action, "created");
  assert.equal(completed.nfapi_account_id, 801);
  assert.equal(completed.short_lived, false);
  const publicResult = JSON.stringify(completed);
  for (const secret of [tokenInfo.access_token, tokenInfo.refresh_token, "authorization-code-private", "nfapi-secret", "LoginPassword123!"]) {
    assert.equal(publicResult.includes(secret), false);
  }
  const finished = db.prepare("SELECT * FROM nfapi_oauth_import_sessions WHERE id = ?").get(started.oauth_session_id);
  assert.equal(finished.status, "completed");
  assert.equal(finished.payload_encrypted, "");
  const link = db.prepare("SELECT * FROM registered_account_nfapi_links WHERE external_account_id = ?").get(String(id));
  assert.equal(link.status, "imported");
  assert.equal(link.nfapi_account_id, 801);
});

test("start allows passwordless accounts and skips an existing account before OAuth", async (t) => {
  const db = testDatabase(t);
  const noPassword = registrationAccount({ id: 61, email: "no-password@example.com", accountId: "workspace-no-password", passwordConfigured: false });
  addRegisteredSource(db, { id: 61, email: noPassword.email });
  let passwordlessGenerated = 0;
  const service = createService({
    db,
    accounts: [noPassword],
    nfapiClient: {
      async listOpenAiOauthAccounts() { return []; },
      async generateOpenAiOAuthUrl() {
        passwordlessGenerated += 1;
        return { auth_url: oauthAuthUrl(), session_id: "passwordless-upstream" };
      },
    },
  });
  const started = await service.startOAuthImport({ ids: [61] });
  assert.equal(started.authorization_required, true);
  assert.equal(started.action, "create");
  assert.equal(passwordlessGenerated, 1);

  const withPassword = registrationAccount({ id: 62, email: "existing@example.com", accountId: "workspace-existing" });
  addRegisteredSource(db, { id: 62, email: withPassword.email });
  let generated = 0;
  const skipService = createService({
    db,
    accounts: [withPassword],
    nfapiClient: {
      async listOpenAiOauthAccounts() {
        return [{ id: 901, credentials: { email: withPassword.email, chatgpt_account_id: "workspace-existing", chatgpt_user_id: "user-workspace-existing", refresh_token: "present" } }];
      },
      async generateOpenAiOAuthUrl() { generated += 1; throw new Error("must not generate"); },
    },
  });
  const skipped = await skipService.startOAuthImport({ ids: [62], options: { update_existing: false } });
  assert.equal(skipped.authorization_required, false);
  assert.equal(skipped.action, "skipped");
  assert.equal(skipped.nfapi_account_id, 901);
  assert.equal(generated, 0);
});

test("existing accounts are reauthorized through OAuth before incremental settings merge", async (t) => {
  const db = testDatabase(t);
  const id = 63;
  const email = "reauthorize@example.com";
  const accountId = "workspace-reauthorize";
  const local = registrationAccount({ id, email, accountId });
  addRegisteredSource(db, { id, email });
  const existing = {
    id: 902,
    credentials: {
      email,
      chatgpt_account_id: accountId,
      chatgpt_user_id: `user-${accountId}`,
      access_token: "old-access",
      refresh_token: "old-refresh",
      id_token: "old-id",
      session_token: "old-session",
      cookie: "old-cookie",
      auth_token: "old-auth-token",
      client_secret: "old-secret",
      custom_routing_key: "keep-existing-value",
      model_mapping: { "gpt-5.6": "existing-model-alias" },
    },
    extra: { existing_advanced_flag: true },
  };
  const token = oauthTokenInfo({ email, accountId, refreshToken: "new-refresh" });
  const calls = [];
  const client = {
    async listOpenAiOauthAccounts() { calls.push("list"); return [existing]; },
    async generateOpenAiOAuthUrl() { calls.push("generate"); return { auth_url: oauthAuthUrl(), session_id: "upstream-existing" }; },
    async exchangeOpenAiOAuthCode() { calls.push("exchange"); return token; },
    async getAccount(targetId) { calls.push("get"); assert.equal(targetId, 902); return existing; },
    async applyOAuthCredentials(targetId, payload) {
      calls.push("apply");
      assert.equal(targetId, 902);
      assert.equal(payload.credentials.access_token, token.access_token);
      assert.equal(payload.credentials.refresh_token, "new-refresh");
      assert.equal(payload.credentials.id_token, token.id_token);
      assert.equal(payload.credentials.custom_routing_key, "keep-existing-value");
      assert.deepEqual(payload.credentials.model_mapping, { "gpt-5.6": "existing-model-alias" });
      for (const staleSecret of ["old-access", "old-refresh", "old-id", "old-secret", "old-session", "old-cookie", "old-auth-token"]) {
        assert.equal(JSON.stringify(payload).includes(staleSecret), false);
      }
      return existing;
    },
    async updateAccount() { calls.push("update"); return existing; },
    async bulkUpdateAccounts() { calls.push("bulk"); return { updated: 1, failed: 0 }; },
    async createAccount() { throw new Error("must not create"); },
  };
  const service = createService({ db, accounts: [local], nfapiClient: client });
  const started = await service.startOAuthImport({ ids: [id], options: { update_existing: true } });
  const result = await service.completeOAuthImport(started.oauth_session_id, callbackUrl());

  assert.deepEqual(calls, ["list", "generate", "exchange", "list", "get", "apply", "update", "bulk"]);
  assert.equal(result.action, "updated_credentials");
  assert.equal(result.nfapi_account_id, 902);
});

test("pending starts resume unchanged, processing starts reject, and callbacks remain strict", async (t) => {
  const db = testDatabase(t);
  const id = 64;
  const email = "callback@example.com";
  const accountId = "workspace-callback";
  const local = registrationAccount({ id, email, accountId });
  addRegisteredSource(db, { id, email });
  let exchanges = 0;
  let generated = 0;
  const client = {
    async listOpenAiOauthAccounts() { return []; },
    async generateOpenAiOAuthUrl() { generated += 1; return { auth_url: oauthAuthUrl(), session_id: "callback-upstream" }; },
    async exchangeOpenAiOAuthCode() { exchanges += 1; return oauthTokenInfo({ email, accountId }); },
    async createAccount() { return { id: 903 }; },
    async updateAccount(_id, payload) {
      assert.equal(Object.hasOwn(payload, "group_ids"), false);
      return { id: 903 };
    },
    async bulkUpdateAccounts() { return { updated: 1, failed: 0 }; },
  };
  const service = createService({ db, accounts: [local], nfapiClient: client });
  const started = await service.startOAuthImport({ ids: [id] });
  const defaultsBefore = db.prepare("SELECT value FROM settings WHERE key = 'nfapi_import_defaults'").get().value;
  const resumed = await service.startOAuthImport({ ids: [id], options: { concurrency: 99 }, save_defaults: true });
  assert.equal(resumed.oauth_session_id, started.oauth_session_id);
  assert.equal(resumed.auth_url, started.auth_url);
  assert.equal(resumed.expires_at, started.expires_at);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'nfapi_import_defaults'").get().value, defaultsBefore);
  assert.equal(generated, 1);

  db.prepare("UPDATE nfapi_oauth_import_sessions SET status = 'processing' WHERE id = ?").run(started.oauth_session_id);
  await assert.rejects(
    () => service.startOAuthImport({ ids: [id] }),
    (error) => error.status === 409 && /正在处理/.test(error.message),
  );
  db.prepare("UPDATE nfapi_oauth_import_sessions SET status = 'pending' WHERE id = ?").run(started.oauth_session_id);
  assert.equal(generated, 1);

  await assert.rejects(
    () => service.completeOAuthImport(started.oauth_session_id, "https://localhost:1455/auth/callback?code=hidden-code&state=expected-state"),
    (error) => error.status === 400 && !error.message.includes("hidden-code"),
  );
  await assert.rejects(
    () => service.completeOAuthImport(started.oauth_session_id, callbackUrl("wrong-state", "hidden-code")),
    (error) => error.status === 409 && !error.message.includes("hidden-code"),
  );
  assert.equal(exchanges, 0);
  assert.equal(db.prepare("SELECT status FROM nfapi_oauth_import_sessions WHERE id = ?").get(started.oauth_session_id).status, "pending");

  await service.completeOAuthImport(started.oauth_session_id, callbackUrl());
  assert.equal(exchanges, 1);
  await assert.rejects(
    () => service.completeOAuthImport(started.oauth_session_id, callbackUrl()),
    (error) => error.status === 409 && /已使用/.test(error.message),
  );
  assert.equal(exchanges, 1);
});

test("forced restart expires the pending session, reuses its settings, and hints the original email", async (t) => {
  const db = testDatabase(t);
  const id = 70;
  const email = "restart+alias@example.com";
  const accountId = "workspace-restart";
  const local = registrationAccount({ id, email, accountId });
  addRegisteredSource(db, { id, email });
  const generatedPayloads = [];
  const client = {
    async listOpenAiOauthAccounts() { return []; },
    async generateOpenAiOAuthUrl(payload) {
      generatedPayloads.push(payload);
      const sequence = generatedPayloads.length;
      return { auth_url: oauthAuthUrl(`restart-state-${sequence}`), session_id: `restart-upstream-${sequence}` };
    },
  };
  const service = createService({ db, accounts: [local], nfapiClient: client });
  const started = await service.startOAuthImport({
    ids: [id],
    options: { proxy_id: 7, concurrency: 17 },
  });
  const restarted = await service.startOAuthImport({
    ids: [id],
    force_restart: true,
    options: { proxy_id: 9, concurrency: 99 },
  });

  assert.notEqual(restarted.oauth_session_id, started.oauth_session_id);
  assert.notEqual(restarted.auth_url, started.auth_url);
  assert.equal(new URL(started.auth_url).searchParams.get("login_hint"), email);
  assert.equal(new URL(restarted.auth_url).searchParams.get("login_hint"), email);
  assert.deepEqual(generatedPayloads, [{ proxy_id: 7 }, { proxy_id: 7 }]);
  const previous = db.prepare("SELECT status, payload_encrypted FROM nfapi_oauth_import_sessions WHERE id = ?")
    .get(started.oauth_session_id);
  assert.equal(previous.status, "expired");
  assert.equal(previous.payload_encrypted, "");
  assert.equal(db.prepare("SELECT status FROM nfapi_oauth_import_sessions WHERE id = ?").get(restarted.oauth_session_id).status, "pending");
});

test("forced restart rejects invalid flags and never interrupts a processing callback", async (t) => {
  const db = testDatabase(t);
  const id = 71;
  const email = "processing@example.com";
  const local = registrationAccount({ id, email, accountId: "workspace-processing" });
  addRegisteredSource(db, { id, email });
  let generated = 0;
  const service = createService({
    db,
    accounts: [local],
    nfapiClient: {
      async listOpenAiOauthAccounts() { return []; },
      async generateOpenAiOAuthUrl() {
        generated += 1;
        return { auth_url: oauthAuthUrl(), session_id: "processing-upstream" };
      },
    },
  });

  await assert.rejects(
    () => service.startOAuthImport({ ids: [id], force_restart: "yes" }),
    (error) => error.status === 400 && /必须是布尔值/.test(error.message),
  );
  const started = await service.startOAuthImport({ ids: [id] });
  db.prepare("UPDATE nfapi_oauth_import_sessions SET status = 'processing' WHERE id = ?").run(started.oauth_session_id);
  await assert.rejects(
    () => service.startOAuthImport({ ids: [id], force_restart: true }),
    (error) => error.status === 409 && /正在处理/.test(error.message),
  );
  assert.equal(generated, 1);
  assert.equal(db.prepare("SELECT status FROM nfapi_oauth_import_sessions WHERE id = ?").get(started.oauth_session_id).status, "processing");
});

test("forced restart keeps the previous session when replacement generation fails", async (t) => {
  const db = testDatabase(t);
  const id = 72;
  const email = "restart-failure@example.com";
  const local = registrationAccount({ id, email, accountId: "workspace-restart-failure" });
  addRegisteredSource(db, { id, email });
  let generated = 0;
  const service = createService({
    db,
    accounts: [local],
    nfapiClient: {
      async listOpenAiOauthAccounts() { return []; },
      async generateOpenAiOAuthUrl() {
        generated += 1;
        if (generated === 2) throw Object.assign(new Error("upstream unavailable"), { status: 503 });
        return { auth_url: oauthAuthUrl(), session_id: "preserved-upstream" };
      },
    },
  });
  const started = await service.startOAuthImport({ ids: [id], options: { proxy_id: 4 } });

  await assert.rejects(
    () => service.startOAuthImport({ ids: [id], force_restart: true }),
    /upstream unavailable/,
  );
  const stored = db.prepare("SELECT status, payload_encrypted FROM nfapi_oauth_import_sessions WHERE id = ?")
    .get(started.oauth_session_id);
  assert.equal(stored.status, "pending");
  assert.match(stored.payload_encrypted, /^v1\./);
  const resumed = await service.startOAuthImport({ ids: [id] });
  assert.equal(resumed.oauth_session_id, started.oauth_session_id);
});

test("concurrent forced restarts converge without replacing the locked settings twice", async (t) => {
  const db = testDatabase(t);
  const id = 73;
  const email = "restart-concurrent@example.com";
  const local = registrationAccount({ id, email, accountId: "workspace-restart-concurrent" });
  addRegisteredSource(db, { id, email });
  const generatedPayloads = [];
  let releaseReplacement;
  const replacementStarted = new Promise((resolve) => { releaseReplacement = resolve; });
  let allowReplacement;
  const replacementAllowed = new Promise((resolve) => { allowReplacement = resolve; });
  const service = createService({
    db,
    accounts: [local],
    nfapiClient: {
      async listOpenAiOauthAccounts() { return []; },
      async generateOpenAiOAuthUrl(payload) {
        generatedPayloads.push(payload);
        const sequence = generatedPayloads.length;
        if (sequence === 2) {
          releaseReplacement();
          await replacementAllowed;
        }
        return { auth_url: oauthAuthUrl(`concurrent-restart-${sequence}`), session_id: `concurrent-restart-${sequence}` };
      },
    },
  });
  const started = await service.startOAuthImport({ ids: [id], options: { proxy_id: 6, concurrency: 12 } });
  const firstRestart = service.startOAuthImport({ ids: [id], force_restart: true, options: { proxy_id: 7 } });
  await replacementStarted;
  const secondRestart = service.startOAuthImport({ ids: [id], force_restart: true, options: { proxy_id: 8 } });
  allowReplacement();
  const [first, second] = await Promise.all([firstRestart, secondRestart]);

  assert.notEqual(first.oauth_session_id, started.oauth_session_id);
  assert.equal(second.oauth_session_id, first.oauth_session_id);
  assert.deepEqual(generatedPayloads, [{ proxy_id: 6 }, { proxy_id: 6 }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nfapi_oauth_import_sessions WHERE status IN ('pending', 'processing')").get().count, 1);
});

test("concurrent starts share one generated and persisted OAuth session", async (t) => {
  const db = testDatabase(t);
  const id = 69;
  const email = "concurrent@example.com";
  const accountId = "workspace-concurrent";
  const local = registrationAccount({ id, email, accountId });
  addRegisteredSource(db, { id, email });
  let generated = 0;
  let signalGenerateStarted;
  const generateStarted = new Promise((resolve) => { signalGenerateStarted = resolve; });
  let allowGenerate;
  const generateAllowed = new Promise((resolve) => { allowGenerate = resolve; });
  const waiting = [];
  const client = {
    async listOpenAiOauthAccounts() { return []; },
    async generateOpenAiOAuthUrl() {
      generated += 1;
      signalGenerateStarted();
      await generateAllowed;
      return { auth_url: oauthAuthUrl("state-1"), session_id: "upstream-1" };
    },
  };
  const service = createService({ db, accounts: [local], nfapiClient: client });
  waiting.push(service.startOAuthImport({ ids: [id] }));
  await generateStarted;
  waiting.push(service.startOAuthImport({ ids: [id] }));
  allowGenerate();
  const [first, second] = await Promise.all(waiting);

  assert.equal(generated, 1);
  assert.equal(first.oauth_session_id, second.oauth_session_id);
  assert.equal(first.auth_url, second.auth_url);
  assert.equal(first.expires_at, second.expires_at);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nfapi_oauth_import_sessions WHERE status = 'pending'").get().count, 1);
});

test("expired OAuth sessions are cleared and never exchange a code", async (t) => {
  const db = testDatabase(t);
  const id = 65;
  const email = "expired@example.com";
  const accountId = "workspace-expired";
  const local = registrationAccount({ id, email, accountId });
  addRegisteredSource(db, { id, email });
  let now = new Date("2026-07-14T12:00:00.000Z");
  let exchanges = 0;
  const client = {
    async listOpenAiOauthAccounts() { return []; },
    async generateOpenAiOAuthUrl() { return { auth_url: oauthAuthUrl(), session_id: "expired-upstream" }; },
    async exchangeOpenAiOAuthCode() { exchanges += 1; throw new Error("must not exchange"); },
  };
  const service = createService({
    db,
    accounts: [local],
    nfapiClient: client,
    oauthSessionTtlMs: 1_000,
    nowFn: () => now,
  });
  const started = await service.startOAuthImport({ ids: [id] });
  db.prepare("UPDATE nfapi_oauth_import_sessions SET status = 'processing' WHERE id = ?")
    .run(started.oauth_session_id);
  now = new Date(now.getTime() + 1_001);

  await assert.rejects(
    () => service.completeOAuthImport(started.oauth_session_id, callbackUrl()),
    (error) => error.status === 410 && /已过期/.test(error.message),
  );
  assert.equal(exchanges, 0);
  const stored = db.prepare("SELECT status, payload_encrypted FROM nfapi_oauth_import_sessions WHERE id = ?").get(started.oauth_session_id);
  assert.equal(stored.status, "expired");
  assert.equal(stored.payload_encrypted, "");
});

test("passwordless token identity mismatch consumes the session, creates nothing, and returns no secrets", async (t) => {
  const db = testDatabase(t);
  const id = 66;
  const email = "identity@example.com";
  const accountId = "workspace-identity";
  const local = registrationAccount({ id, email, accountId, passwordConfigured: false });
  addRegisteredSource(db, { id, email });
  const privateAccessToken = "private-access-token-value";
  let created = 0;
  const client = {
    async listOpenAiOauthAccounts() { return []; },
    async generateOpenAiOAuthUrl() { return { auth_url: oauthAuthUrl(), session_id: "identity-upstream-private" }; },
    async exchangeOpenAiOAuthCode() {
      return oauthTokenInfo({
        email: "different@example.com",
        accountId: "different-workspace",
        accessToken: privateAccessToken,
      });
    },
    async createAccount() { created += 1; throw new Error("must not create"); },
  };
  const service = createService({ db, accounts: [local], nfapiClient: client });
  const started = await service.startOAuthImport({ ids: [id] });

  await assert.rejects(
    () => service.completeOAuthImport(started.oauth_session_id, callbackUrl("expected-state", "private-callback-code")),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /账号.*不匹配/);
      for (const secret of [privateAccessToken, "private-callback-code", "identity-upstream-private", "nfapi-secret"]) {
        assert.equal(error.message.includes(secret), false);
      }
      return true;
    },
  );
  assert.equal(created, 0);
  const stored = db.prepare("SELECT status, payload_encrypted, last_error FROM nfapi_oauth_import_sessions WHERE id = ?").get(started.oauth_session_id);
  assert.equal(stored.status, "failed");
  assert.equal(stored.payload_encrypted, "");
  assert.equal(stored.last_error.includes(privateAccessToken), false);
});

test("upstream failures are redacted before persistence and response", async (t) => {
  const db = testDatabase(t);
  const id = 67;
  const email = "redaction@example.com";
  const accountId = "workspace-redaction";
  const local = registrationAccount({ id, email, accountId });
  addRegisteredSource(db, { id, email });
  const client = {
    async listOpenAiOauthAccounts() { return []; },
    async generateOpenAiOAuthUrl() { return { auth_url: oauthAuthUrl(), session_id: "upstream-sensitive" }; },
    async exchangeOpenAiOAuthCode(payload) {
      throw Object.assign(new Error(`exchange rejected code=${payload.code} state=${payload.state} session=${payload.session_id} key=nfapi-secret`), { status: 502 });
    },
  };
  const service = createService({ db, accounts: [local], nfapiClient: client });
  const started = await service.startOAuthImport({ ids: [id] });
  await assert.rejects(
    () => service.completeOAuthImport(started.oauth_session_id, callbackUrl("expected-state", "callback-sensitive")),
    (error) => {
      for (const secret of ["callback-sensitive", "expected-state", "upstream-sensitive", "nfapi-secret"]) {
        assert.equal(error.message.includes(secret), false);
      }
      return true;
    },
  );
  const row = db.prepare("SELECT last_error FROM nfapi_oauth_import_sessions WHERE id = ?").get(started.oauth_session_id);
  for (const secret of ["callback-sensitive", "expected-state", "upstream-sensitive", "nfapi-secret"]) {
    assert.equal(row.last_error.includes(secret), false);
  }
});

test("start rejects untrusted NFapi authorization URLs without persisting a session", async (t) => {
  const db = testDatabase(t);
  const id = 68;
  const email = "untrusted-url@example.com";
  const local = registrationAccount({ id, email, accountId: "workspace-untrusted" });
  addRegisteredSource(db, { id, email });
  const service = createService({
    db,
    accounts: [local],
    nfapiClient: {
      async listOpenAiOauthAccounts() { return []; },
      async generateOpenAiOAuthUrl() {
        return {
          auth_url: oauthAuthUrl().replace("https://auth.openai.com", "https://user@auth.openai.com"),
          session_id: "must-not-persist",
        };
      },
    },
  });
  await assert.rejects(() => service.startOAuthImport({ ids: [id] }), /不符合预期/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nfapi_oauth_import_sessions").get().count, 0);
});
