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

function identityJwt({
  email,
  accountId,
  userId = `user-${accountId}`,
  subject = `auth0|${userId}`,
  exp = Math.floor(Date.now() / 1000) + 3_600,
}) {
  return jwt({
    sub: subject,
    exp,
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

function createService({
  db,
  accounts,
  nfapiClient,
  apiKey = "nfapi-secret",
  oauthSessionTtlMs,
  agentIdentityPendingTtlMs,
  agentIdentityRegistrar,
  nowFn,
}) {
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
    agentIdentityPendingTtlMs,
    agentIdentityRegistrar,
    nowFn,
  });
  service.client = () => nfapiClient;
  return service;
}

function registeredAgentIdentity({ email, accountId, userId, runtimeId, privateKey }) {
  return {
    authJson: {
      auth_mode: "agentIdentity",
      agent_identity: {
        agent_runtime_id: runtimeId,
        agent_private_key: privateKey,
        account_id: accountId,
        chatgpt_user_id: userId,
        email,
        plan_type: "free",
        chatgpt_account_is_fedramp: false,
      },
    },
    runtimeId,
    secrets: [privateKey, runtimeId],
  };
}

function nfapiAgentAccount({
  id, email, accountId, userId, runtimeId, credentialStatus = {}, credentialExtras = {}, expiresAt = null, autoPauseOnExpired = false,
}) {
  return {
    id,
    expires_at: expiresAt,
    auto_pause_on_expired: autoPauseOnExpired,
    credentials: {
      auth_mode: "agentIdentity",
      agent_runtime_id: runtimeId,
      email,
      chatgpt_account_id: accountId,
      chatgpt_user_id: userId,
      ...credentialExtras,
    },
    credentials_status: {
      has_agent_private_key: true,
      has_access_token: false,
      has_refresh_token: false,
      has_id_token: false,
      ...credentialStatus,
    },
  };
}

function agentImportResult(action, accountId) {
  return {
    total: 1,
    created: action === "created" ? 1 : 0,
    updated: action === "updated" ? 1 : 0,
    skipped: action === "skipped" ? 1 : 0,
    failed: 0,
    items: [{ index: 1, action, account_id: accountId }],
  };
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

test("Agent Identity rejects importer ambiguity despite an AliasHub link before registration or mutation", async (t) => {
  const db = testDatabase(t);
  const id = 70;
  const email = "agent-duplicate@example.com";
  const accountId = "workspace-agent-duplicate";
  const userId = `user-${accountId}`;
  const local = registrationAccount({ id, email, accountId });
  addRegisteredSource(db, { id, email });
  const now = nowIso();
  db.prepare(`
    INSERT INTO registered_account_nfapi_links
      (external_account_id, email, nfapi_base_url, nfapi_account_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'imported', ?, ?)
  `).run(String(id), email, "https://nfapi.test", 9712, now, now);
  const duplicate = (accountIdValue) => ({
    id: accountIdValue,
    credentials: {
      email,
      chatgpt_account_id: accountId,
      chatgpt_user_id: userId,
    },
  });
  let registrations = 0;
  let imports = 0;
  let mutations = 0;
  const service = createService({
    db,
    accounts: [local],
    nfapiClient: {
      async listOpenAiOauthAccounts() { return [duplicate(9711), duplicate(9712)]; },
      async importCodexSession() { imports += 1; throw new Error("must not import"); },
      async getAccount() { mutations += 1; throw new Error("must not read a target"); },
      async updateAccount() { mutations += 1; },
      async bulkUpdateAccounts() { mutations += 1; },
    },
    agentIdentityRegistrar: async () => {
      registrations += 1;
      throw new Error("must not register");
    },
  });

  await assert.rejects(
    () => service.importAgentIdentity({ id }),
    (error) => error.status === 409 && /多个会被 Agent Identity 导入器匹配/.test(error.message),
  );

  assert.equal(registrations, 0);
  assert.equal(imports, 0);
  assert.equal(mutations, 0);
  assert.equal(service.pendingAgentIdentities.size, 0);
  const link = db.prepare("SELECT * FROM registered_account_nfapi_links WHERE external_account_id = ?").get(String(id));
  assert.equal(link.nfapi_account_id, 9712);
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

test("OAuth fallback strips Agent Identity state and verifies the cleaned target", async (t) => {
  const db = testDatabase(t);
  const id = 631;
  const email = "agent-to-oauth@example.com";
  const accountId = "workspace-agent-to-oauth";
  const local = registrationAccount({ id, email, accountId });
  addRegisteredSource(db, { id, email });
  const existing = {
    id: 9631,
    credentials: {
      auth_mode: "agentIdentity",
      openai_auth_mode: "personal_access_token",
      agent_runtime_id: "runtime-old-private",
      agent_private_key: "agent-private-key-old",
      task_id: "task-old-private",
      email,
      chatgpt_account_id: accountId,
      chatgpt_user_id: `user-${accountId}`,
      custom_routing_key: "keep-routing",
    },
    credentials_status: { has_agent_private_key: true },
  };
  const token = oauthTokenInfo({ email, accountId, refreshToken: "oauth-refresh-new" });
  let appliedPayload = null;
  const client = {
    async listOpenAiOauthAccounts() { return [existing]; },
    async generateOpenAiOAuthUrl() { return { auth_url: oauthAuthUrl(), session_id: "agent-fallback-upstream" }; },
    async exchangeOpenAiOAuthCode() { return token; },
    async getAccount() { return existing; },
    async applyOAuthCredentials(_targetId, payload) {
      appliedPayload = payload;
      return {
        id: existing.id,
        credentials: { ...payload.credentials },
        credentials_status: {
          has_access_token: true,
          has_refresh_token: true,
          has_id_token: true,
        },
      };
    },
    async updateAccount() { return { id: existing.id }; },
    async bulkUpdateAccounts() { return { updated: 1, failed: 0 }; },
  };
  const service = createService({ db, accounts: [local], nfapiClient: client });

  const started = await service.startOAuthImport({ id });
  const completed = await service.completeOAuthImport(started.oauth_session_id, callbackUrl());

  assert.equal(completed.action, "updated_credentials");
  assert.equal(completed.nfapi_account_id, existing.id);
  assert.equal(appliedPayload.credentials.custom_routing_key, "keep-routing");
  assert.equal(appliedPayload.credentials.refresh_token, "oauth-refresh-new");
  for (const key of ["auth_mode", "openai_auth_mode", "agent_runtime_id", "agent_private_key", "task_id"]) {
    assert.equal(Object.hasOwn(appliedPayload.credentials, key), false);
  }
  for (const secret of ["runtime-old-private", "agent-private-key-old", "task-old-private"]) {
    assert.equal(JSON.stringify(appliedPayload).includes(secret), false);
    assert.equal(JSON.stringify(completed).includes(secret), false);
  }
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

test("Agent Identity import is concurrent-safe, token-free, long-lived, and returns only the public contract", async (t) => {
  const db = testDatabase(t);
  const id = 201;
  const email = "agent-success@example.com";
  const accountId = "workspace-agent-success";
  const userId = `user-${accountId}`;
  const runtimeId = "runtime-agent-success-private";
  const privateKey = "pkcs8-agent-success-private";
  const local = registrationAccount({ id, email, accountId });
  const accessToken = local.credentials.find((item) => item.key === "access_token").value;
  const refreshToken = "source-refresh-token-private";
  const idToken = "source-id-token-private";
  const clientId = "source-client-id-private";
  local.credentials.push(
    { key: "refresh_token", value: refreshToken },
    { key: "id_token", value: idToken },
    { key: "client_id", value: clientId },
  );
  addRegisteredSource(db, { id, email, customName: "Agent account" });

  let releaseRegistration;
  const registrationGate = new Promise((resolve) => { releaseRegistration = resolve; });
  let registrations = 0;
  let lists = 0;
  const imports = [];
  let updatePayload;
  let bulkPayload;
  const client = {
    async listOpenAiOauthAccounts() { lists += 1; return []; },
    async importCodexSession(payload, idempotencyKey) {
      imports.push({ payload, idempotencyKey });
      return agentImportResult("created", 9201);
    },
    async getAccount(idValue) {
      assert.equal(idValue, 9201);
      return nfapiAgentAccount({ id: idValue, email, accountId, userId, runtimeId });
    },
    async updateAccount(idValue, payload) {
      assert.equal(idValue, 9201);
      updatePayload = payload;
      return { id: idValue };
    },
    async bulkUpdateAccounts(payload) {
      bulkPayload = payload;
      return { updated: 1, failed: 0 };
    },
  };
  const service = createService({
    db,
    accounts: [local],
    nfapiClient: client,
    agentIdentityRegistrar: async (input) => {
      registrations += 1;
      assert.equal(input.accessToken, accessToken);
      assert.equal(input.accountId, accountId);
      assert.equal(input.userId, userId);
      assert.equal(input.agentVersion, "0.144.0");
      await registrationGate;
      return registeredAgentIdentity({ email, accountId, userId, runtimeId, privateKey });
    },
  });
  const future = Math.floor(Date.now() / 1_000) + 86_400;
  const input = {
    id,
    options: {
      expires_at: future,
      auto_pause_on_expired: true,
      concurrency: 23,
      group_ids: [27],
    },
    save_defaults: true,
  };

  const first = service.importAgentIdentity(input);
  const second = service.importAgentIdentity(input);
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registrations, 1);
  releaseRegistration();
  const result = await first;

  assert.equal(lists, 1);
  assert.equal(imports.length, 1);
  assert.match(imports[0].idempotencyKey, /^aliashub-agent-[a-f0-9]{64}$/);
  assert.equal(imports[0].payload.expires_at, 0);
  assert.equal(imports[0].payload.auto_pause_on_expired, false);
  assert.equal(imports[0].payload.extra.access_token_sha256, null);
  assert.equal(imports[0].payload.extra.session_token_present, null);
  assert.equal(imports[0].payload.extra.session_expires_at, null);
  assert.equal(imports[0].payload.extra.auth_provider, null);
  const authJson = JSON.parse(imports[0].payload.content);
  assert.deepEqual(authJson, registeredAgentIdentity({
    email, accountId, userId, runtimeId, privateKey,
  }).authJson);
  for (const oauthSecret of [accessToken, refreshToken, idToken, clientId]) {
    assert.equal(JSON.stringify(imports[0].payload).includes(oauthSecret), false);
  }
  assert.equal(Object.hasOwn(authJson, "tokens"), false);
  assert.equal(updatePayload.expires_at, 0);
  assert.equal(updatePayload.auto_pause_on_expired, false);
  assert.equal(Object.hasOwn(updatePayload, "credentials"), false);
  assert.equal(JSON.stringify(bulkPayload).includes(privateKey), false);
  assert.equal(JSON.stringify(bulkPayload).includes(runtimeId), false);
  assert.deepEqual(Object.keys(result).sort(), ["action", "auth_mode", "nfapi_account_id", "short_lived"]);
  assert.deepEqual(result, {
    auth_mode: "agentIdentity",
    action: "created",
    nfapi_account_id: 9201,
    short_lived: false,
  });

  const link = db.prepare("SELECT * FROM registered_account_nfapi_links WHERE external_account_id = ?")
    .get(String(id));
  assert.equal(link.status, "imported");
  assert.equal(link.short_lived, 0);
  assert.equal(link.last_action, "agent_identity_created");
  for (const secret of [accessToken, refreshToken, idToken, clientId, privateKey, runtimeId]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(link).includes(secret), false);
    assert.equal(JSON.stringify(updatePayload).includes(secret), false);
    assert.equal(JSON.stringify(bulkPayload).includes(secret), false);
  }
  const savedDefaults = service.storedDefaults();
  assert.equal(savedDefaults.expires_at, future);
  assert.equal(savedDefaults.auto_pause_on_expired, true);
  assert.equal(service.pendingAgentIdentities.size, 0);
});

test("Agent Identity applies long-lived settings before requiring the target to be durable", async (t) => {
  const db = testDatabase(t);
  const id = 203;
  const email = "agent-long-lived@example.com";
  const accountId = "workspace-agent-long-lived";
  const userId = `user-${accountId}`;
  const runtimeId = "runtime-agent-long-lived";
  const privateKey = "pkcs8-agent-long-lived";
  const local = registrationAccount({ id, email, accountId });
  addRegisteredSource(db, { id, email });

  let getCalls = 0;
  let target = nfapiAgentAccount({
    id: 9203,
    email,
    accountId,
    userId,
    runtimeId,
    autoPauseOnExpired: true,
  });
  const client = {
    async listOpenAiOauthAccounts() { return []; },
    async importCodexSession() { return agentImportResult("created", 9203); },
    async getAccount(idValue) {
      assert.equal(idValue, 9203);
      getCalls += 1;
      return target;
    },
    async updateAccount(idValue, payload) {
      assert.equal(idValue, 9203);
      assert.equal(payload.expires_at, 0);
      assert.equal(payload.auto_pause_on_expired, false);
      target = { ...target, expires_at: null, auto_pause_on_expired: false };
      return target;
    },
    async bulkUpdateAccounts() { return { updated: 1, failed: 0 }; },
  };
  const service = createService({
    db,
    accounts: [local],
    nfapiClient: client,
    agentIdentityRegistrar: async () => registeredAgentIdentity({ email, accountId, userId, runtimeId, privateKey }),
  });

  const result = await service.importAgentIdentity({ id, options: { update_existing: true } });
  assert.equal(getCalls, 3);
  assert.deepEqual(result, {
    auth_mode: "agentIdentity",
    action: "created",
    nfapi_account_id: 9203,
    short_lived: false,
  });
});

test("Agent Identity rejects expired, missing-exp, and conflicting JWT identities before any upstream call", async (t) => {
  const db = testDatabase(t);
  const now = Math.floor(Date.now() / 1_000);
  const cases = [{
    id: 202,
    email: "agent-expired@example.com",
    accountId: "workspace-agent-expired",
    token(email, accountId) {
      return identityJwt({ email, accountId, exp: now - 1 });
    },
    message: /已过期或即将过期/,
  }, {
    id: 203,
    email: "agent-missing-exp@example.com",
    accountId: "workspace-agent-missing-exp",
    token(email, accountId) {
      return jwt({
        sub: `auth0|user-${accountId}`,
        "https://api.openai.com/profile": { email },
        "https://api.openai.com/auth": {
          chatgpt_account_id: accountId,
          chatgpt_user_id: `user-${accountId}`,
        },
      });
    },
    message: /缺少有效 exp/,
  }, {
    id: 204,
    email: "agent-conflict@example.com",
    accountId: "workspace-agent-conflict",
    token(_email, accountId) {
      return identityJwt({ email: "other-agent@example.com", accountId });
    },
    message: /身份字段不一致/,
  }];
  const accounts = cases.map((item) => {
    const account = registrationAccount(item);
    account.credentials.find((credential) => credential.key === "access_token").value = item.token(item.email, item.accountId);
    addRegisteredSource(db, item);
    return account;
  });
  let nfapiCalls = 0;
  let registrations = 0;
  const service = createService({
    db,
    accounts,
    nfapiClient: {
      async listOpenAiOauthAccounts() { nfapiCalls += 1; return []; },
      async importCodexSession() { nfapiCalls += 1; return {}; },
    },
    agentIdentityRegistrar: async () => {
      registrations += 1;
      throw new Error("must not register");
    },
  });

  for (const invalidOptions of [null, [], new Date()]) {
    await assert.rejects(
      () => service.importAgentIdentity({ id: cases[0].id, options: invalidOptions }),
      (error) => error.status === 400 && /设置格式无效/.test(error.message),
    );
  }
  for (const item of cases) {
    await assert.rejects(
      () => service.importAgentIdentity({ id: item.id }),
      (error) => error.status === 409 && item.message.test(error.message),
    );
  }
  assert.equal(registrations, 0);
  assert.equal(nfapiCalls, 0);
});

test("Agent Identity confirmed business failures reuse identity but rotate the idempotency key", async (t) => {
  const db = testDatabase(t);
  const id = 205;
  const email = "agent-retry@example.com";
  const accountId = "workspace-agent-retry";
  const userId = `user-${accountId}`;
  const runtimeId = "runtime-agent-retry-private";
  const privateKey = "pkcs8-agent-retry-private";
  const local = registrationAccount({ id, email, accountId });
  const accessToken = local.credentials.find((item) => item.key === "access_token").value;
  addRegisteredSource(db, { id, email });
  let registrations = 0;
  const imports = [];
  const client = {
    async listOpenAiOauthAccounts() { return []; },
    async importCodexSession(payload, idempotencyKey) {
      imports.push({ payload, idempotencyKey });
      if (imports.length === 1) {
        return {
          total: 1,
          created: 0,
          updated: 0,
          skipped: 0,
          failed: 1,
          items: [{ index: 1, action: "failed", message: `failed ${privateKey} ${runtimeId} ${accessToken}` }],
          errors: [{ index: 1, message: `failed ${privateKey} ${runtimeId} ${accessToken}` }],
        };
      }
      return agentImportResult("created", 9205);
    },
    async getAccount(idValue) {
      return nfapiAgentAccount({ id: idValue, email, accountId, userId, runtimeId });
    },
    async updateAccount() { return { id: 9205 }; },
    async bulkUpdateAccounts() { return { updated: 1, failed: 0 }; },
  };
  const service = createService({
    db,
    accounts: [local],
    nfapiClient: client,
    agentIdentityRegistrar: async () => {
      registrations += 1;
      return registeredAgentIdentity({ email, accountId, userId, runtimeId, privateKey });
    },
  });

  let firstError;
  try {
    await service.importAgentIdentity({
      id,
      options: {
        expires_at: Math.floor(Date.now() / 1_000) - 3_600,
        auto_pause_on_expired: true,
        concurrency: 10,
      },
    });
    assert.fail("expected the first business result to fail");
  } catch (error) {
    firstError = error;
  }
  assert.equal(firstError.status, 502);
  assert.match(firstError.message, /内存中保留/);
  for (const secret of [privateKey, runtimeId, accessToken]) {
    assert.equal(firstError.message.includes(secret), false);
  }
  const failedLink = db.prepare("SELECT * FROM registered_account_nfapi_links WHERE external_account_id = ?")
    .get(String(id));
  assert.equal(failedLink.status, "failed");
  for (const secret of [privateKey, runtimeId, accessToken]) {
    assert.equal(JSON.stringify(failedLink).includes(secret), false);
  }
  assert.equal(service.pendingAgentIdentities.size, 1);

  const result = await service.importAgentIdentity({
    id,
    options: { concurrency: 10 },
  });

  assert.equal(registrations, 1);
  assert.equal(imports.length, 2);
  assert.notEqual(imports[0].idempotencyKey, imports[1].idempotencyKey);
  assert.equal(imports[0].payload.expires_at, 0);
  assert.equal(imports[0].payload.auto_pause_on_expired, false);
  assert.equal(imports[0].payload.concurrency, 10);
  assert.equal(imports[1].payload.concurrency, 10);
  const firstIdentity = JSON.parse(imports[0].payload.content).agent_identity;
  const secondIdentity = JSON.parse(imports[1].payload.content).agent_identity;
  assert.equal(firstIdentity.agent_runtime_id, runtimeId);
  assert.equal(secondIdentity.agent_runtime_id, runtimeId);
  assert.equal(firstIdentity.agent_private_key, privateKey);
  assert.equal(secondIdentity.agent_private_key, privateKey);
  assert.deepEqual(result, {
    auth_mode: "agentIdentity",
    action: "created",
    nfapi_account_id: 9205,
    short_lived: false,
  });
  assert.equal(service.pendingAgentIdentities.size, 0);
});

test("Agent Identity replays the same payload and key when the committed response is lost", async (t) => {
  const db = testDatabase(t);
  const id = 2051;
  const email = "agent-lost-response@example.com";
  const accountId = "workspace-agent-lost-response";
  const userId = `user-${accountId}`;
  const runtimeId = "runtime-agent-lost-response-private";
  const privateKey = "pkcs8-agent-lost-response-private";
  const local = registrationAccount({ id, email, accountId });
  addRegisteredSource(db, { id, email });
  let registrations = 0;
  let lists = 0;
  const imports = [];
  const committed = new Map();
  const client = {
    async listOpenAiOauthAccounts() { lists += 1; return []; },
    async importCodexSession(payload, idempotencyKey) {
      imports.push({ payload: structuredClone(payload), idempotencyKey });
      if (!committed.has(idempotencyKey)) {
        committed.set(idempotencyKey, agentImportResult("created", 9251));
        throw new TypeError("socket closed after commit");
      }
      return committed.get(idempotencyKey);
    },
    async getAccount(targetId) {
      return nfapiAgentAccount({ id: targetId, email, accountId, userId, runtimeId });
    },
    async updateAccount() { return { id: 9251 }; },
    async bulkUpdateAccounts() { return { updated: 1, failed: 0 }; },
  };
  const service = createService({
    db,
    accounts: [local],
    nfapiClient: client,
    agentIdentityRegistrar: async () => {
      registrations += 1;
      return registeredAgentIdentity({ email, accountId, userId, runtimeId, privateKey });
    },
  });
  const input = { id, options: { concurrency: 14, group_ids: [27] } };

  await assert.rejects(
    () => service.importAgentIdentity(input),
    (error) => error.status === 502 && /内存中保留/.test(error.message),
  );
  assert.equal(service.pendingAgentIdentities.get(id).importOperation.state, "unknown");
  await assert.rejects(
    () => service.importAgentIdentity({ id, options: { concurrency: 15, group_ids: [27] } }),
    (error) => error.status === 409 && /使用相同设置重试/.test(error.message),
  );
  assert.equal(imports.length, 1);

  const result = await service.importAgentIdentity(input);

  assert.equal(registrations, 1);
  assert.equal(lists, 2);
  assert.equal(imports.length, 2);
  assert.equal(imports[0].idempotencyKey, imports[1].idempotencyKey);
  assert.deepEqual(imports[0].payload, imports[1].payload);
  assert.deepEqual(result, {
    auth_mode: "agentIdentity",
    action: "created",
    nfapi_account_id: 9251,
    short_lived: false,
  });
  assert.equal(service.pendingAgentIdentities.size, 0);
});

test("Agent Identity unknown retries recheck importer ambiguity before replay", async (t) => {
  const db = testDatabase(t);
  const id = 2054;
  const email = "agent-replay-duplicate@example.com";
  const accountId = "workspace-agent-replay-duplicate";
  const userId = `user-${accountId}`;
  const runtimeId = "runtime-agent-replay-duplicate-private";
  const local = registrationAccount({ id, email, accountId });
  addRegisteredSource(db, { id, email });
  let lists = 0;
  let imports = 0;
  const duplicate = (targetId, storedUserId = userId) => ({
    id: targetId,
    credentials: {
      email,
      chatgpt_account_id: accountId,
      ...(storedUserId ? { chatgpt_user_id: storedUserId } : {}),
    },
  });
  const service = createService({
    db,
    accounts: [local],
    nfapiClient: {
      async listOpenAiOauthAccounts() {
        lists += 1;
        return lists === 1 ? [] : [duplicate(9254), duplicate(9255, "")];
      },
      async importCodexSession() {
        imports += 1;
        throw new TypeError("connection reset");
      },
    },
    agentIdentityRegistrar: async () => registeredAgentIdentity({
      email,
      accountId,
      userId,
      runtimeId,
      privateKey: "pkcs8-agent-replay-duplicate-private",
    }),
  });

  await assert.rejects(() => service.importAgentIdentity({ id }), /connection reset/);
  await assert.rejects(
    () => service.importAgentIdentity({ id }),
    (error) => error.status === 409 && /多个会被 Agent Identity 导入器匹配/.test(error.message),
  );

  assert.equal(lists, 2);
  assert.equal(imports, 1);
  assert.equal(service.pendingAgentIdentities.get(id).importOperation.state, "unknown");
});

test("Agent Identity resumes target settings without another import after a confirmed import", async (t) => {
  const db = testDatabase(t);
  const id = 2052;
  const email = "agent-settings-retry@example.com";
  const accountId = "workspace-agent-settings-retry";
  const userId = `user-${accountId}`;
  const runtimeId = "runtime-agent-settings-retry-private";
  const privateKey = "pkcs8-agent-settings-retry-private";
  const local = registrationAccount({ id, email, accountId });
  addRegisteredSource(db, { id, email });
  let registrations = 0;
  let lists = 0;
  let imports = 0;
  let updates = 0;
  let bulkUpdates = 0;
  const client = {
    async listOpenAiOauthAccounts() { lists += 1; return []; },
    async importCodexSession() {
      imports += 1;
      if (imports > 1) throw new Error("must not import twice");
      return agentImportResult("created", 9252);
    },
    async getAccount(targetId) {
      return nfapiAgentAccount({ id: targetId, email, accountId, userId, runtimeId });
    },
    async updateAccount() { updates += 1; return { id: 9252 }; },
    async bulkUpdateAccounts() {
      bulkUpdates += 1;
      return bulkUpdates === 1
        ? { updated: 0, failed: 1, results: [{ success: false, error: "settings write failed" }] }
        : { updated: 1, failed: 0 };
    },
  };
  const service = createService({
    db,
    accounts: [local],
    nfapiClient: client,
    agentIdentityRegistrar: async () => {
      registrations += 1;
      return registeredAgentIdentity({ email, accountId, userId, runtimeId, privateKey });
    },
  });

  await assert.rejects(
    () => service.importAgentIdentity({ id, options: { concurrency: 17 } }),
    (error) => error.status === 502 && /settings write failed/.test(error.message),
  );
  assert.equal(service.pendingAgentIdentities.get(id).importOperation.state, "imported");
  local.credentials.find((credential) => credential.key === "access_token").value = identityJwt({
    email,
    accountId,
    userId,
    exp: Math.floor(Date.now() / 1_000) - 60,
  });

  const result = await service.importAgentIdentity({ id, options: { concurrency: 18 } });

  assert.equal(registrations, 1);
  assert.equal(lists, 1);
  assert.equal(imports, 1);
  assert.equal(updates, 2);
  assert.equal(bulkUpdates, 2);
  assert.deepEqual(result, {
    auth_mode: "agentIdentity",
    action: "created",
    nfapi_account_id: 9252,
    short_lived: false,
  });
  assert.equal(service.pendingAgentIdentities.size, 0);
});

test("Agent Identity transient target verification failures keep the confirmed import result", async (t) => {
  const db = testDatabase(t);
  const id = 2053;
  const email = "agent-target-retry@example.com";
  const accountId = "workspace-agent-target-retry";
  const userId = `user-${accountId}`;
  const runtimeId = "runtime-agent-target-retry-private";
  const local = registrationAccount({ id, email, accountId });
  addRegisteredSource(db, { id, email });
  let imports = 0;
  let targetReads = 0;
  const client = {
    async listOpenAiOauthAccounts() { return []; },
    async importCodexSession() { imports += 1; return agentImportResult("created", 9253); },
    async getAccount(targetId) {
      targetReads += 1;
      const account = nfapiAgentAccount({ id: targetId, email, accountId, userId, runtimeId });
      if (targetReads === 1) account.credentials_status = {};
      return account;
    },
    async updateAccount() { return { id: 9253 }; },
    async bulkUpdateAccounts() { return { updated: 1, failed: 0 }; },
  };
  const service = createService({
    db,
    accounts: [local],
    nfapiClient: client,
    agentIdentityRegistrar: async () => registeredAgentIdentity({
      email, accountId, userId, runtimeId, privateKey: "pkcs8-agent-target-retry-private",
    }),
  });

  await assert.rejects(
    () => service.importAgentIdentity({ id }),
    (error) => error.status === 502 && /未保存签名密钥/.test(error.message),
  );
  assert.equal(service.pendingAgentIdentities.get(id).importOperation.state, "imported");

  const result = await service.importAgentIdentity({ id });

  assert.equal(imports, 1);
  assert.equal(targetReads, 4);
  assert.equal(result.nfapi_account_id, 9253);
  assert.equal(service.pendingAgentIdentities.size, 0);
});

test("Agent Identity remediation is pinned to the original target and rotates only its import key", async (t) => {
  const db = testDatabase(t);
  const id = 2055;
  const email = "agent-remediation-target@example.com";
  const accountId = "workspace-agent-remediation-target";
  const userId = `user-${accountId}`;
  const runtimeId = "runtime-agent-remediation-target-private";
  const local = registrationAccount({ id, email, accountId });
  addRegisteredSource(db, { id, email });
  let listedAccounts = [];
  let targetReads = 0;
  const imports = [];
  const client = {
    async listOpenAiOauthAccounts() { return listedAccounts; },
    async importCodexSession(payload, idempotencyKey) {
      imports.push({ payload, idempotencyKey });
      if (imports.length === 1) return agentImportResult("created", 9255);
      if (imports.length === 2) {
        return {
          total: 1,
          created: 0,
          updated: 0,
          skipped: 0,
          failed: 1,
          items: [{ index: 1, action: "failed", message: "cleanup failed" }],
          errors: [{ index: 1, message: "cleanup failed" }],
        };
      }
      return agentImportResult("updated", 9255);
    },
    async getAccount(targetId) {
      targetReads += 1;
      const account = nfapiAgentAccount({
        id: targetId,
        email,
        accountId,
        userId,
        runtimeId,
        credentialStatus: {},
      });
      if (targetReads === 1) {
        account.auth_mode = "oauth";
        account.credentials.auth_mode = "oauth";
      }
      return account;
    },
    async updateAccount() { return { id: 9255 }; },
    async bulkUpdateAccounts() { return { updated: 1, failed: 0 }; },
  };
  const service = createService({
    db,
    accounts: [local],
    nfapiClient: client,
    agentIdentityRegistrar: async () => registeredAgentIdentity({
      email,
      accountId,
      userId,
      runtimeId,
      privateKey: "pkcs8-agent-remediation-target-private",
    }),
  });

  await assert.rejects(() => service.importAgentIdentity({ id }), /未切换为 Agent Identity/);
  const pending = service.pendingAgentIdentities.get(id);
  assert.equal(pending.importOperation.state, "remediation_required");
  assert.equal(pending.importOperation.result.accountId, 9255);

  listedAccounts = [nfapiAgentAccount({ id: 9255, email, accountId, userId, runtimeId })];
  await assert.rejects(() => service.importAgentIdentity({ id }), /cleanup failed/);
  assert.equal(imports.length, 2);
  assert.equal(pending.importOperation.state, "failed_confirmed");
  assert.equal(pending.remediationTargetId, 9255);

  listedAccounts = [nfapiAgentAccount({ id: 9256, email, accountId, userId, runtimeId })];
  await assert.rejects(
    () => service.importAgentIdentity({ id }),
    (error) => error.status === 409 && /修复目标已变化/.test(error.message),
  );
  assert.equal(imports.length, 2);

  listedAccounts = [nfapiAgentAccount({ id: 9255, email, accountId, userId, runtimeId })];
  const result = await service.importAgentIdentity({ id });

  assert.equal(imports.length, 3);
  assert.notEqual(imports[0].idempotencyKey, imports[1].idempotencyKey);
  assert.notEqual(imports[1].idempotencyKey, imports[2].idempotencyKey);
  assert.equal(JSON.parse(imports[0].payload.content).agent_identity.agent_runtime_id, runtimeId);
  assert.equal(JSON.parse(imports[1].payload.content).agent_identity.agent_runtime_id, runtimeId);
  assert.equal(JSON.parse(imports[2].payload.content).agent_identity.agent_runtime_id, runtimeId);
  assert.deepEqual(result, {
    auth_mode: "agentIdentity",
    action: "updated",
    nfapi_account_id: 9255,
    short_lived: false,
  });
});

test("Agent Identity clears verified OAuth residue before applying durable settings", async (t) => {
  const db = testDatabase(t);
  const id = 206;
  const email = "agent-residue@example.com";
  const accountId = "workspace-agent-residue";
  const userId = `user-${accountId}`;
  const runtimeId = "runtime-agent-residue-private";
  const privateKey = "pkcs8-agent-residue-private";
  const local = registrationAccount({ id, email, accountId });
  const accessToken = local.credentials.find((item) => item.key === "access_token").value;
  addRegisteredSource(db, { id, email });
  let target = nfapiAgentAccount({
    id: 9206,
    email,
    accountId,
    userId,
    runtimeId,
    credentialStatus: {
      has_access_token: true,
      has_refresh_token: true,
      has_id_token: true,
    },
    credentialExtras: {
      client_id: "old-oauth-client",
      expires_at: "2026-07-22T17:00:00Z",
      model_mapping: { "gpt-5": "gpt-5" },
    },
  });
  let cleanupPayload;
  let settingsWrites = 0;
  let bulkWrites = 0;
  let targetReads = 0;
  const service = createService({
    db,
    accounts: [local],
    nfapiClient: {
      async listOpenAiOauthAccounts() { return []; },
      async importCodexSession() { return agentImportResult("created", 9206); },
      async getAccount(idValue) {
        assert.equal(idValue, 9206);
        targetReads += 1;
        return structuredClone(target);
      },
      async updateAccount(idValue, payload) {
        assert.equal(idValue, 9206);
        if (payload.credentials) {
          cleanupPayload = structuredClone(payload);
          target = {
            ...target,
            credentials: { ...payload.credentials },
            credentials_status: {
              has_agent_private_key: true,
              has_access_token: false,
              has_refresh_token: false,
              has_id_token: false,
            },
          };
          return structuredClone(target);
        }
        settingsWrites += 1;
        return structuredClone(target);
      },
      async bulkUpdateAccounts() { bulkWrites += 1; return { updated: 1, failed: 0 }; },
    },
    agentIdentityRegistrar: async () => registeredAgentIdentity({
      email, accountId, userId, runtimeId, privateKey,
    }),
  });
  const result = await service.importAgentIdentity({ id });

  assert.deepEqual(result, {
    auth_mode: "agentIdentity",
    action: "created",
    nfapi_account_id: 9206,
    short_lived: false,
  });
  assert.equal(targetReads, 3);
  assert.equal(settingsWrites, 1);
  assert.equal(bulkWrites, 1);
  assert.deepEqual(cleanupPayload.credentials.access_token, null);
  assert.deepEqual(cleanupPayload.credentials.refresh_token, null);
  assert.deepEqual(cleanupPayload.credentials.id_token, null);
  assert.equal(Object.hasOwn(cleanupPayload.credentials, "client_id"), false);
  assert.equal(Object.hasOwn(cleanupPayload.credentials, "expires_at"), false);
  assert.equal(cleanupPayload.credentials.auth_mode, "agentIdentity");
  assert.equal(cleanupPayload.credentials.agent_runtime_id, runtimeId);
  assert.deepEqual(cleanupPayload.credentials.model_mapping, { "gpt-5": "gpt-5" });
  assert.equal(JSON.stringify(cleanupPayload).includes(accessToken), false);
  assert.equal(JSON.stringify(cleanupPayload).includes(privateKey), false);
  assert.equal(service.pendingAgentIdentities.size, 0);
  const link = db.prepare("SELECT * FROM registered_account_nfapi_links WHERE external_account_id = ?")
    .get(String(id));
  assert.equal(link.status, "imported");
  assert.equal(link.last_action, "agent_identity_created");
  for (const secret of [accessToken, privateKey]) assert.equal(JSON.stringify(link).includes(secret), false);
});

test("Agent Identity skip rejects OAuth accounts and only accepts an already durable Agent Identity", async (t) => {
  const db = testDatabase(t);
  const oauthId = 207;
  const agentId = 208;
  const oauthEmail = "agent-skip-oauth@example.com";
  const agentEmail = "agent-skip-durable@example.com";
  const oauthAccountId = "workspace-agent-skip-oauth";
  const agentAccountId = "workspace-agent-skip-durable";
  const oauthLocal = registrationAccount({ id: oauthId, email: oauthEmail, accountId: oauthAccountId });
  const agentLocal = registrationAccount({ id: agentId, email: agentEmail, accountId: agentAccountId });
  addRegisteredSource(db, { id: oauthId, email: oauthEmail });
  addRegisteredSource(db, { id: agentId, email: agentEmail });
  let registrations = 0;
  let imports = 0;
  const oauthExisting = {
    id: 9307,
    credentials: {
      auth_mode: "oauth",
      email: oauthEmail,
      chatgpt_account_id: oauthAccountId,
      chatgpt_user_id: `user-${oauthAccountId}`,
    },
    credentials_status: { has_refresh_token: true },
  };
  const durableExisting = nfapiAgentAccount({
    id: 9308,
    email: agentEmail,
    accountId: agentAccountId,
    userId: `user-${agentAccountId}`,
    runtimeId: "existing-runtime",
  });
  const service = createService({
    db,
    accounts: [oauthLocal, agentLocal],
    nfapiClient: {
      async listOpenAiOauthAccounts() { return [oauthExisting, durableExisting]; },
      async importCodexSession() { imports += 1; return {}; },
    },
    agentIdentityRegistrar: async () => {
      registrations += 1;
      throw new Error("must not register while skipping");
    },
  });

  await assert.rejects(
    () => service.importAgentIdentity({ id: oauthId, options: { update_existing: false } }),
    (error) => error.status === 409 && /开启“更新已有账号”/.test(error.message),
  );
  const skipped = await service.importAgentIdentity({ id: agentId, options: { update_existing: false } });

  assert.deepEqual(skipped, {
    auth_mode: "agentIdentity",
    action: "skipped",
    nfapi_account_id: 9308,
    short_lived: false,
  });
  assert.equal(registrations, 0);
  assert.equal(imports, 0);
});
