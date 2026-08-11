import assert from "node:assert/strict";
import test from "node:test";
import { RegistrationClient } from "../registration-client.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("registration client uses the compatible Frcibly force-release endpoint", async () => {
  const calls = [];
  const client = new RegistrationClient({
    baseUrl: "https://registration.test",
    token: "secret-token",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { task_id: "task/one", status: "interrupted" });
    },
  });

  const result = await client.releaseTask("task/one");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://registration.test/api/tasks/task%2Fone/release");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    force: true,
    reason: "aliashub_stuck_registration",
  });
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-token");
  assert.equal(result.release_mode, "force_release");
  assert.equal(result.status, "interrupted");
});

test("registration client refuses to fake a release when the endpoint is unavailable", async () => {
  const calls = [];
  const client = new RegistrationClient({
    baseUrl: "https://registration.test",
    token: "secret-token",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(404, { detail: "接口不存在" });
    },
  });

  await assert.rejects(
    () => client.releaseTask("task-2"),
    /注册服务尚未部署强制释放接口/,
  );

  assert.deepEqual(calls.map((item) => item.url), [
    "https://registration.test/api/tasks/task-2/release",
  ]);
});

test("registration client does not hide force-release server failures", async () => {
  const client = new RegistrationClient({
    baseUrl: "https://registration.test",
    token: "secret-token",
    fetchFn: async () => jsonResponse(500, { detail: "release failed" }),
  });

  await assert.rejects(() => client.releaseTask("task-3"), /release failed/);
});

test("registration client forwards proxy inspection parameters exactly", async () => {
  const calls = [];
  const expected = {
    dynamic: true,
    distinct_ips: ["203.0.113.10", "203.0.113.11"],
    samples: [
      {
        ip: "203.0.113.10",
        country_code: "JP",
        country_name: "Japan",
        locale: "ja-JP",
        timezone: "Asia/Tokyo",
        latitude: 35.68,
        longitude: 139.76,
      },
    ],
  };
  const client = new RegistrationClient({
    baseUrl: "https://registration.test/",
    token: "secret-token",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, expected);
    },
  });
  const payload = {
    url: "http://proxy-user:proxy-password@proxy.example:8080",
    samples: 4,
    delay_ms: 725,
  };

  const result = await client.inspectProxy(payload);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://registration.test/api/proxies/inspect");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-token");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);
  assert.deepEqual(result, expected);
});

test("registration client refreshes only normalized ChatGPT account ids in one batch", async () => {
  const calls = [];
  const client = new RegistrationClient({
    baseUrl: "https://registration.test",
    token: "secret-token",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { updated: 2, items: [], timed_out: 0 });
    },
  });

  const result = await client.refreshAccountPlans(
    [7, "8", 7, 0, -1, "invalid"],
    { 7: "http://proxy-user:proxy-password@proxy.example:8080", 99: "http://unused.example:8080" },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://registration.test/api/accounts/refresh-plan?platform=chatgpt");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    ids: [7, 8],
    proxies_by_id: { 7: "http://proxy-user:proxy-password@proxy.example:8080" },
  });
  assert.equal(result.updated, 2);

  const empty = await client.refreshAccountPlans([0, "invalid"]);
  assert.deepEqual(empty, { updated: 0, items: [], timed_out: 0 });
  assert.equal(calls.length, 1);
});

test("registration client upserts the AliasHub mailbox connector as a service-level provider setting", async () => {
  const calls = [];
  const connectorKey = "connector-secret-that-must-not-be-returned";
  const mailboxUrl = "https://mailbox.alias.test";
  const client = new RegistrationClient({
    baseUrl: "https://registration.test",
    token: "secret-token",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, {
        ok: true,
        item: {
          config: { outlook_email_api_url: mailboxUrl },
          auth: { outlook_email_api_key: connectorKey },
        },
      });
    },
  });

  const result = await client.upsertOutlookEmailProviderSetting({
    apiUrl: `${mailboxUrl}/`,
    apiKey: connectorKey,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://registration.test/api/provider-settings");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    provider_type: "mailbox",
    provider_key: "outlook_email_api",
    display_name: "AliasHub Outlook 邮箱",
    auth_mode: "apikey",
    enabled: true,
    is_default: false,
    config: { outlook_email_api_url: mailboxUrl },
    auth: { outlook_email_api_key: connectorKey },
    metadata: { managed_by: "aliashub" },
  });
  assert.deepEqual(result, { ok: true });
  assert.ok(!JSON.stringify(result).includes(connectorKey));
  assert.ok(!JSON.stringify(result).includes(mailboxUrl));
});

test("registration client rejects a provider-setting response that does not confirm the upsert", async () => {
  const client = new RegistrationClient({
    baseUrl: "https://registration.test",
    token: "secret-token",
    fetchFn: async () => jsonResponse(200, { ok: false }),
  });

  await assert.rejects(
    () => client.upsertOutlookEmailProviderSetting({
      apiUrl: "https://mailbox.alias.test",
      apiKey: "connector-secret",
    }),
    /邮箱连接配置同步失败/,
  );
});

test("registration client creates and manages an existing-account action task", async () => {
  const calls = [];
  const client = new RegistrationClient({
    baseUrl: "https://registration.test",
    token: "secret-token",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/cancel")) {
        return jsonResponse(200, {
          task_id: "action/task",
          type: "platform_action",
          platform: "chatgpt",
          status: "cancel_requested",
        });
      }
      if (url.includes("/events?")) return jsonResponse(200, { items: [] });
      return jsonResponse(200, {
        task_id: "action/task",
        type: "platform_action",
        platform: "chatgpt",
        status: "pending",
      });
    },
  });

  await client.createAccountAction("71/2", "set/password", {
    password: "CandidatePassword#42",
    proxy: "http://proxy.example:8080",
  });
  await client.getActionTask("action/task");
  await client.getActionTaskEvents("action/task", 9);
  await client.cancelActionTask("action/task");

  assert.equal(calls[0].url, "https://registration.test/api/actions/chatgpt/71%2F2/set%2Fpassword");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    params: {
      password: "CandidatePassword#42",
      proxy: "http://proxy.example:8080",
    },
  });
  assert.equal(calls[1].url, "https://registration.test/api/tasks/action%2Ftask");
  assert.equal(calls[2].url, "https://registration.test/api/tasks/action%2Ftask/events?since=9&limit=300");
  assert.equal(calls[3].url, "https://registration.test/api/tasks/action%2Ftask/cancel");
  assert.equal(calls[3].options.method, "POST");
});

test("registration client patches account credentials server-side", async () => {
  const calls = [];
  const client = new RegistrationClient({
    baseUrl: "https://registration.test",
    token: "secret-token",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { id: 134, email: "plus@example.com" });
    },
  });

  const result = await client.updateAccount(134, { credentials: { access_token: "latest-token" } });

  assert.equal(calls[0].url, "https://registration.test/api/accounts/134");
  assert.equal(calls[0].options.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    credentials: { access_token: "latest-token" },
  });
  assert.deepEqual(result, { id: 134, email: "plus@example.com" });
});

test("registration client bounds a stalled account read", async () => {
  const client = new RegistrationClient({
    baseUrl: "https://registration.test",
    token: "secret-token",
    accountTimeoutMs: 5,
    fetchFn: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    }),
  });

  await assert.rejects(
    () => client.getAccount(134),
    (error) => error.status === 504 && /请求超时/.test(error.message),
  );
});
