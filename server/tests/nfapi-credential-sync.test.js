import assert from "node:assert/strict";
import test from "node:test";
import { NfapiCredentialSync, validateNfapiOauthCredentials } from "../nfapi-credential-sync.js";

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

function oauthCredentials({ email = "plus@example.com", accountId = "workspace-1", userId = "user-1" } = {}) {
  const auth = {
    email,
    chatgpt_account_id: accountId,
    chatgpt_user_id: userId,
    chatgpt_plan_type: "plus",
  };
  return {
    nfapi_account_id: 1871,
    email,
    access_token: jwt({ exp: 4_102_444_800, "https://api.openai.com/auth": auth }),
    refresh_token: "refresh-value",
    id_token: jwt({ exp: 4_102_444_800, email, "https://api.openai.com/auth": auth }),
    chatgpt_account_id: accountId,
    chatgpt_user_id: userId,
    expires_at: "2100-01-01T00:00:00Z",
    plan_type: "plus",
  };
}

test("NFapi OAuth validation accepts only the matching email and workspace", () => {
  const credentials = oauthCredentials();
  const result = validateNfapiOauthCredentials(credentials, {
    email: "PLUS@example.com",
    credentials: [
      { key: "account_id", value: "workspace-1" },
      { key: "chatgpt_user_id", value: "user-1" },
    ],
  }, { now: new Date("2026-08-02T00:00:00Z") });

  assert.equal(result.email, "plus@example.com");
  assert.equal(result.accountId, "workspace-1");
  assert.equal(result.patch.plan_type, "plus");
  assert.equal(result.patch.access_token, credentials.access_token);
  assert.throws(
    () => validateNfapiOauthCredentials({ ...credentials, email: "other@example.com" }, {
      email: "plus@example.com",
      credentials: { account_id: "workspace-1" },
    }),
    /邮箱不一致|邮箱与注册账号不匹配/,
  );
});

test("NFapi credential sync refreshes, validates and patches the linked Frcibly account", async () => {
  const calls = [];
  const credentials = oauthCredentials();
  const db = {
    prepare() {
      return { all: () => [{
        external_account_id: "134",
        email: "plus@example.com",
        nfapi_base_url: "https://nfapi.test",
        nfapi_account_id: 1871,
      }] };
    },
  };
  const registrationClient = {
    async getAccount(id) {
      calls.push(["get", id]);
      return {
        id,
        platform: "chatgpt",
        email: "plus@example.com",
        credentials: [{ key: "account_id", value: "workspace-1" }],
      };
    },
    async updateAccount(id, payload) {
      calls.push(["patch", id, payload]);
      return { id };
    },
  };
  const sync = new NfapiCredentialSync({
    db,
    store: {
      async getOpenAiOauthCredentials(id) {
        calls.push(["read", id]);
        return credentials;
      },
    },
    registrationClient,
    nfapiBaseUrl: "https://nfapi.test/",
    nfapiClientFactory: () => ({
      async refreshAccountCredentials(id) { calls.push(["refresh", id]); },
    }),
    nowFn: () => new Date("2026-08-02T00:00:00Z"),
  });

  const result = await sync.syncAccounts([{ id: 134, email: "plus@example.com" }]);

  assert.deepEqual(result, {
    attempted: 1,
    synced: 1,
    failed: 0,
    items: [{ account_id: 134, nfapi_account_id: 1871, ok: true }],
  });
  assert.deepEqual(calls.map((item) => item.slice(0, 2)), [
    ["get", 134], ["read", 1871], ["refresh", 1871], ["read", 1871], ["patch", 134],
  ]);
  const patch = calls.at(-1)[2].credentials;
  assert.equal(patch.account_id, "workspace-1");
  assert.equal(patch.chatgpt_user_id, "user-1");
  assert.equal(patch.plan_type, "plus");
});

test("NFapi credential sync never refreshes or patches an identity mismatch", async () => {
  const calls = [];
  const sync = new NfapiCredentialSync({
    db: {
      prepare() {
        return { all: () => [{
          external_account_id: "134",
          email: "plus@example.com",
          nfapi_base_url: "https://nfapi.test",
          nfapi_account_id: 1871,
        }] };
      },
    },
    store: {
      async getOpenAiOauthCredentials() {
        calls.push("read");
        return oauthCredentials({ email: "different@example.com" });
      },
    },
    registrationClient: {
      async getAccount() {
        return { platform: "chatgpt", email: "plus@example.com", credentials: {} };
      },
      async updateAccount() { calls.push("patch"); },
    },
    nfapiBaseUrl: "https://nfapi.test",
    nfapiClientFactory: () => ({
      async refreshAccountCredentials() { calls.push("refresh"); },
    }),
  });

  const result = await sync.syncAccounts([{ id: 134, email: "plus@example.com" }]);

  assert.equal(result.failed, 1);
  assert.deepEqual(calls, ["read"]);
  assert.match(result.items[0].error, /邮箱/);
});
