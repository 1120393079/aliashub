import assert from "node:assert/strict";
import test from "node:test";
import { NfapiClient, unwrapNfapiPayload } from "../nfapi-client.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("NFapi client sends the API key only as a header and unwraps response envelopes", async () => {
  const calls = [];
  const secret = "nfapi-admin-secret";
  const client = new NfapiClient({
    baseUrl: "https://nfapi.test/",
    apiKey: secret,
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { code: 0, message: "success", data: [{ id: 27, name: "OpenAI" }] });
    },
  });

  const groups = await client.listGroups();

  assert.deepEqual(groups, [{ id: 27, name: "OpenAI" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://nfapi.test/api/v1/admin/groups/all?platform=openai");
  assert.equal(calls[0].options.headers["x-api-key"], secret);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].url.includes(secret), false);
  assert.equal(String(calls[0].options.body || "").includes(secret), false);
  assert.equal(JSON.stringify(groups).includes(secret), false);
});

test("NFapi client uses the native OpenAI OAuth endpoints", async () => {
  const calls = [];
  const client = new NfapiClient({
    baseUrl: "https://nfapi.test",
    apiKey: "secret",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/generate-auth-url")) return jsonResponse(200, { data: { auth_url: "https://auth.openai.com/oauth/authorize?state=s", session_id: "upstream" } });
      return jsonResponse(200, { data: { access_token: "token" } });
    },
  });

  await client.generateOpenAiOAuthUrl({ proxy_id: 9 });
  await client.exchangeOpenAiOAuthCode({ session_id: "upstream", code: "code", state: "state", proxy_id: 9 });

  assert.equal(calls[0].url, "https://nfapi.test/api/v1/admin/openai/generate-auth-url");
  assert.deepEqual(JSON.parse(calls[0].options.body), { proxy_id: 9 });
  assert.equal(calls[1].url, "https://nfapi.test/api/v1/admin/openai/exchange-code");
  assert.deepEqual(JSON.parse(calls[1].options.body), { session_id: "upstream", code: "code", state: "state", proxy_id: 9 });
  assert.equal(Object.hasOwn(JSON.parse(calls[1].options.body), "redirect_uri"), false);
});

test("NFapi client imports Agent Identity auth.json with a stable idempotency key", async () => {
  const calls = [];
  const client = new NfapiClient({
    baseUrl: "https://nfapi.test",
    apiKey: "secret",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { data: {
        total: 1, created: 1, updated: 0, skipped: 0, failed: 0,
        items: [{ index: 1, action: "created", account_id: 902 }],
      } });
    },
  });
  const payload = { content: JSON.stringify({
    auth_mode: "agentIdentity",
    agent_identity: { agent_runtime_id: "runtime", agent_private_key: "private" },
  }) };

  const result = await client.importCodexSession(payload, "aliashub-agent-stable-key");

  assert.equal(result.items[0].account_id, 902);
  assert.equal(calls[0].url, "https://nfapi.test/api/v1/admin/accounts/import/codex-session");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Idempotency-Key"], "aliashub-agent-stable-key");
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);
  assert.throws(
    () => client.importCodexSession(payload, ""),
    (error) => error.status === 500 && /幂等键/.test(error.message),
  );
});

test("NFapi client gives Agent Identity imports a 120 second request timeout", async () => {
  const client = new NfapiClient({ baseUrl: "https://nfapi.test", apiKey: "secret" });
  let request;
  client.request = async (path, options) => {
    request = { path, options };
    return {};
  };

  await client.importCodexSession({ content: "{}" }, "stable-agent-key");

  assert.equal(request.path, "/api/v1/admin/accounts/import/codex-session");
  assert.equal(request.options.timeoutMs, 120_000);
});

test("NFapi client creates OAuth accounts with an explicit idempotency key", async () => {
  const calls = [];
  const client = new NfapiClient({
    baseUrl: "https://nfapi.test",
    apiKey: "secret",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { data: { id: 901 } });
    },
  });

  const result = await client.createAccount({ platform: "openai", type: "oauth", credentials: { access_token: "token" } }, "aliashub-stable-oauth-key");

  assert.equal(result.id, 901);
  assert.equal(calls[0].url, "https://nfapi.test/api/v1/admin/accounts");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Idempotency-Key"], "aliashub-stable-oauth-key");
});

test("NFapi client reads every OpenAI OAuth account page", async () => {
  const pages = [];
  const client = new NfapiClient({
    baseUrl: "https://nfapi.test",
    apiKey: "secret",
    fetchFn: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      pages.push(page);
      const items = page === 1
        ? Array.from({ length: 500 }, (_, index) => ({ id: index + 1 }))
        : [{ id: 501 }];
      return jsonResponse(200, { data: { items, total: 501, page, page_size: 500, pages: 2 } });
    },
  });

  const accounts = await client.listOpenAiOauthAccounts();

  assert.equal(accounts.length, 501);
  assert.equal(accounts.at(-1).id, 501);
  assert.deepEqual(pages, [1, 2]);
});

test("NFapi client keeps paginating when the server caps the requested page size", async () => {
  const pages = [];
  const client = new NfapiClient({
    baseUrl: "https://nfapi.test",
    apiKey: "secret",
    fetchFn: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      pages.push(page);
      const items = page === 1
        ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }))
        : [{ id: 101 }];
      return jsonResponse(200, { data: { items, total: 101, page, page_size: 100, pages: 2 } });
    },
  });

  const accounts = await client.listOpenAiOauthAccounts();

  assert.equal(accounts.length, 101);
  assert.equal(accounts.at(-1).id, 101);
  assert.deepEqual(pages, [1, 2]);
});

test("NFapi client fails closed when the account list exceeds its pagination safety bound", async () => {
  let calls = 0;
  const client = new NfapiClient({
    baseUrl: "https://nfapi.test",
    apiKey: "secret",
    fetchFn: async (url) => {
      calls += 1;
      const page = Number(new URL(url).searchParams.get("page"));
      return jsonResponse(200, { data: {
        items: [{ id: page }],
        total: 101,
        page,
        page_size: 1,
        pages: 101,
      } });
    },
  });

  await assert.rejects(
    () => client.listOpenAiOauthAccounts(),
    (error) => error.status === 502 && /分页超过安全上限/.test(error.message),
  );
  assert.equal(calls, 100);
});

test("NFapi client normalizes upstream failures without exposing its API key", async () => {
  const secret = "never-return-this-key";
  const client = new NfapiClient({
    baseUrl: "https://nfapi.test",
    apiKey: secret,
    fetchFn: async () => jsonResponse(503, { code: 503, message: `upstream unavailable: api_key=${secret}` }),
  });

  await assert.rejects(
    () => client.listProxies(),
    (error) => {
      assert.equal(error.message, "upstream unavailable: api_key=[REDACTED]");
      assert.equal(error.status, 502);
      assert.equal(error.upstreamStatus, 503);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test("NFapi client redacts request tokens and proxy credentials echoed by upstream", async () => {
  const accessToken = "eyJhbGciOiJIUzI1NiJ9.payload.signature";
  const refreshToken = "refresh-token-private-value";
  const client = new NfapiClient({
    baseUrl: "https://nfapi.test",
    apiKey: "admin-key-private-value",
    fetchFn: async () => jsonResponse(400, {
      message: `content rejected: access_token=${accessToken} refresh_token=${refreshToken} via http://proxy-user:proxy-pass@proxy.example:8080`,
    }),
  });

  await assert.rejects(
    () => client.createAccount({
      credentials: { access_token: accessToken, refresh_token: refreshToken },
    }, "stable-key"),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /access_token=\[REDACTED\]/);
      assert.match(error.message, /refresh_token=\[REDACTED\]/);
      assert.match(error.message, /http:\/\/\[REDACTED\]@proxy\.example:8080/);
      assert.equal(error.message.includes(accessToken), false);
      assert.equal(error.message.includes(refreshToken), false);
      assert.equal(error.message.includes("proxy-user"), false);
      assert.equal(error.message.includes("proxy-pass"), false);
      return true;
    },
  );
});

test("NFapi client redacts Agent Identity keys and assertions echoed by upstream", async () => {
  const privateKey = "private-key-pkcs8-sensitive-value";
  const runtimeId = "runtime-sensitive-value";
  const taskId = "task-sensitive-value";
  const assertion = "assertion-sensitive-value";
  const client = new NfapiClient({
    baseUrl: "https://nfapi.test",
    apiKey: "admin-secret",
    fetchFn: async () => jsonResponse(400, {
      message: `agent_private_key=${privateKey} agent_runtime_id=${runtimeId} task_id=${taskId} AgentAssertion ${assertion}`,
    }),
  });

  await assert.rejects(
    () => client.importCodexSession({ content: JSON.stringify({
      auth_mode: "agentIdentity",
      agent_identity: {
        agent_private_key: privateKey,
        agent_runtime_id: runtimeId,
        task_id: taskId,
      },
    }) }, "agent-key"),
    (error) => {
      for (const secret of [privateKey, runtimeId, taskId, assertion]) {
        assert.equal(error.message.includes(secret), false);
      }
      assert.match(error.message, /AgentAssertion \[REDACTED\]/);
      return true;
    },
  );
});

test("NFapi client converts aborted requests into gateway timeouts", async () => {
  const keepAlive = setTimeout(() => {}, 1_500);
  const client = new NfapiClient({
    baseUrl: "https://nfapi.test",
    apiKey: "secret",
    timeoutMs: 1_000,
    fetchFn: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  });

  try {
    await assert.rejects(
      () => client.listGroups(),
      (error) => {
        assert.equal(error.message, "SUB2 兼容服务请求超时");
        assert.equal(error.status, 504);
        return true;
      },
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test("unwrapNfapiPayload preserves non-envelope payloads", () => {
  assert.deepEqual(unwrapNfapiPayload({ items: [1] }), { items: [1] });
  assert.deepEqual(unwrapNfapiPayload([1, 2]), [1, 2]);
  assert.equal(unwrapNfapiPayload("plain"), "plain");
});
