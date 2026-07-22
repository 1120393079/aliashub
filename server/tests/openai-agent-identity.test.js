import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  generateAgentIdentityKeyMaterial,
  redactAgentIdentityMessage,
  registerOpenAiAgentIdentity,
} from "../openai-agent-identity.js";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("generates PKCS#8 Ed25519 material and the matching OpenSSH public key", () => {
  const material = generateAgentIdentityKeyMaterial();
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(material.privateKeyPkcs8Base64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  assert.equal(privateKey.asymmetricKeyType, "ed25519");
  assert.match(material.publicKeyOpenSsh, /^ssh-ed25519 [A-Za-z0-9+/]+=*$/);

  const blob = Buffer.from(material.publicKeyOpenSsh.split(" ")[1], "base64");
  assert.equal(blob.readUInt32BE(0), 11);
  assert.equal(blob.subarray(4, 15).toString(), "ssh-ed25519");
  assert.equal(blob.readUInt32BE(15), 32);
  assert.equal(blob.length, 51);
  const publicJwk = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  assert.deepEqual(blob.subarray(19), Buffer.from(publicJwk.x, "base64url"));
});

test("registers an Agent Identity without returning OAuth tokens", async () => {
  const accessToken = "source-access-token-private";
  let request;
  const result = await registerOpenAiAgentIdentity({
    accessToken,
    accountId: "workspace-1",
    userId: "user-1",
    email: "person@example.com",
    fedRamp: true,
    runtimePlatform: "linux",
    fetchFn: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return jsonResponse({ agent_runtime_id: "runtime-1" });
    },
  });

  assert.equal(request.url, "https://auth.openai.com/api/accounts/v1/agent/register");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers.Authorization, `Bearer ${accessToken}`);
  assert.equal(request.options.headers["X-OpenAI-Fedramp"], "true");
  assert.deepEqual(request.body.abom, {
    agent_version: "0.144.0",
    agent_harness_id: "codex-cli",
    running_location: "cli-linux",
  });
  assert.match(request.body.agent_public_key, /^ssh-ed25519 /);
  assert.deepEqual(request.body.capabilities, ["responsesapi"]);
  assert.equal(request.body.ttl, null);

  assert.equal(result.authJson.auth_mode, "agentIdentity");
  assert.deepEqual({ ...result.authJson.agent_identity, agent_private_key: "[private]" }, {
    agent_runtime_id: "runtime-1",
    agent_private_key: "[private]",
    account_id: "workspace-1",
    chatgpt_user_id: "user-1",
    email: "person@example.com",
    plan_type: "free",
    chatgpt_account_is_fedramp: true,
  });
  assert.doesNotThrow(() => crypto.createPrivateKey({
    key: Buffer.from(result.authJson.agent_identity.agent_private_key, "base64"),
    format: "der",
    type: "pkcs8",
  }));
  assert.equal(JSON.stringify(result).includes(accessToken), false);
  assert.equal(Object.hasOwn(result.authJson, "tokens"), false);
});

test("does not expose upstream response bodies in Agent Identity registration errors", async () => {
  const accessToken = "source-access-token-private";
  await assert.rejects(
    () => registerOpenAiAgentIdentity({
      accessToken,
      accountId: "workspace-1",
      userId: "user-1",
      fetchFn: async () => jsonResponse({
        detail: `authorization=Bearer ${accessToken} agent_private_key=server-echo`,
      }, 401),
    }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.message.includes(accessToken), false);
      assert.equal(error.message.includes("server-echo"), false);
      assert.equal(error.message, "OpenAI Agent Identity 注册失败 (HTTP 401)");
      return true;
    },
  );
  assert.equal(
    redactAgentIdentityMessage("AgentAssertion abc agent_runtime_id=runtime task_id=task"),
    "AgentAssertion [REDACTED] agent_runtime_id=[REDACTED] task_id=[REDACTED]",
  );
});

test("retries HTTP 429 at most three times with the same Agent Identity key", async () => {
  const calls = [];
  const delays = [];
  await assert.rejects(
    () => registerOpenAiAgentIdentity({
      accessToken: "source-access-token-private",
      accountId: "workspace-1",
      userId: "user-1",
      fetchFn: async (_url, options) => {
        calls.push(JSON.parse(options.body));
        return jsonResponse({ detail: "rate limited secret response" }, 429);
      },
      sleepFn: async (milliseconds) => { delays.push(milliseconds); },
    }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.message, "OpenAI Agent Identity 注册失败 (HTTP 429)");
      assert.equal(error.message.includes("secret response"), false);
      return true;
    },
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [250, 500]);
  assert.equal(new Set(calls.map((body) => body.agent_public_key)).size, 1);
  assert.deepEqual(calls.map((body) => body.abom.agent_version), ["0.144.0", "0.144.0", "0.144.0"]);
});

test("aborts a stalled Agent Identity registration", async () => {
  const keepAlive = setTimeout(() => {}, 1_500);
  try {
    await assert.rejects(
      () => registerOpenAiAgentIdentity({
        accessToken: "source-access-token-private",
        accountId: "workspace-1",
        userId: "user-1",
        timeoutMs: 1_000,
        fetchFn: async (_url, options) => new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
      }),
      (error) => error.status === 504 && /超时/.test(error.message),
    );
  } finally {
    clearTimeout(keepAlive);
  }
});
