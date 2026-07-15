import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase, createSourceAccount, nowIso } from "../db.js";
import { MicrosoftGraphClient } from "../microsoft-graph.js";

const CLIENT_ID = "8787a430-6eee-41e1-b914-681d90d35625";
const REDIRECT_URI = "http://localhost:12141/desktop";

function json(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function jwt(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${encoded}.signature`;
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-graph-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  return {
    db,
    close() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function callbackUrl(authorizationUrl, code = "authorization-code") {
  const state = new URL(authorizationUrl).searchParams.get("state");
  const callback = new URL(REDIRECT_URI);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", state);
  return callback.toString();
}

test("starts Authorization Code OAuth with an encrypted PKCE verifier", async () => {
  const current = fixture();
  const graph = new MicrosoftGraphClient({
    db: current.db,
    encryptionKey: "test-encryption-key",
    clientId: CLIENT_ID,
  });
  try {
    const result = await graph.startAuthorization();
    const authorizationUrl = new URL(result.authorizationUrl);
    assert.equal(authorizationUrl.origin, "https://login.microsoftonline.com");
    assert.equal(authorizationUrl.pathname, "/common/oauth2/v2.0/authorize");
    assert.equal(authorizationUrl.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(authorizationUrl.searchParams.get("redirect_uri"), REDIRECT_URI);
    assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
    assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
    assert.match(authorizationUrl.searchParams.get("scope"), /Mail\.Read/);
    assert.match(authorizationUrl.searchParams.get("scope"), /User\.Read/);
    assert.doesNotMatch(authorizationUrl.searchParams.get("scope"), /IMAP/);

    const session = current.db.prepare("SELECT * FROM oauth_code_sessions WHERE id = ?").get(result.sessionId);
    assert.equal(session.client_id, CLIENT_ID);
    assert.equal(session.redirect_uri, REDIRECT_URI);
    assert.equal(session.state, authorizationUrl.searchParams.get("state"));
    const verifier = graph.decrypt(session.code_verifier_encrypted);
    const expectedChallenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    assert.equal(authorizationUrl.searchParams.get("code_challenge"), expectedChallenge);
    assert.notEqual(session.code_verifier_encrypted, verifier);
    assert.notEqual(graph.encrypt("same-value"), graph.encrypt("same-value"));
  } finally {
    current.close();
  }
});

test("rejects callback paths and states that do not belong to the OAuth session", async () => {
  const current = fixture();
  const graph = new MicrosoftGraphClient({
    db: current.db,
    encryptionKey: "test-encryption-key",
    clientId: CLIENT_ID,
    fetchFn: async () => { throw new Error("Token exchange must not run"); },
  });
  try {
    const session = await graph.startAuthorization();
    await assert.rejects(
      () => graph.completeAuthorization(session.sessionId, "https://example.com/desktop?code=x&state=y"),
      (error) => error.code === "INVALID_CALLBACK_URL" && error.status === 400,
    );
    await assert.rejects(
      () => graph.completeAuthorization(session.sessionId, `${REDIRECT_URI}?code=x&state=wrong-state`),
      (error) => error.code === "OAUTH_STATE_MISMATCH" && error.status === 409,
    );
    assert.equal(current.db.prepare("SELECT COUNT(*) AS count FROM oauth_code_sessions").get().count, 1);
  } finally {
    current.close();
  }
});

test("exchanges the authorization code and stores an encrypted refresh token", async () => {
  const current = fixture();
  const calls = [];
  const graph = new MicrosoftGraphClient({
    db: current.db,
    encryptionKey: "test-encryption-key",
    clientId: CLIENT_ID,
    fetchFn: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/token")) {
        return json({
          access_token: "access-token",
          refresh_token: "refresh-token",
          id_token: jwt({ preferred_username: "source@outlook.com", name: "Source User", sub: "consumer-id" }),
        });
      }
      if (String(url).includes("/me?$select=")) {
        return json({ id: "microsoft-user-id", displayName: "Source User", mail: null, userPrincipalName: "source@outlook.com" });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  try {
    const session = await graph.startAuthorization();
    const storedSession = current.db.prepare("SELECT * FROM oauth_code_sessions WHERE id = ?").get(session.sessionId);
    const verifier = graph.decrypt(storedSession.code_verifier_encrypted);
    const result = await graph.completeAuthorization(session.sessionId, callbackUrl(session.authorizationUrl));

    assert.equal(result.status, "connected");
    assert.equal(result.account.email, "source@outlook.com");
    assert.equal(result.account.oauth_connected, true);
    const tokenBody = calls[0].options.body;
    assert.equal(tokenBody.get("client_id"), CLIENT_ID);
    assert.equal(tokenBody.get("redirect_uri"), REDIRECT_URI);
    assert.equal(tokenBody.get("grant_type"), "authorization_code");
    assert.equal(tokenBody.get("code"), "authorization-code");
    assert.equal(tokenBody.get("code_verifier"), verifier);

    const token = current.db.prepare("SELECT * FROM microsoft_tokens WHERE account_id = ?").get(result.account.id);
    assert.equal(token.client_id, CLIENT_ID);
    assert.equal(token.microsoft_user_id, "microsoft-user-id");
    assert.notEqual(token.refresh_token_encrypted, "refresh-token");
    assert.equal(graph.decrypt(token.refresh_token_encrypted), "refresh-token");
    assert.match(token.scope, /Mail\.Read/);
    assert.equal(current.db.prepare("SELECT COUNT(*) AS count FROM oauth_code_sessions").get().count, 0);
    assert.equal(current.db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE account_id = ? AND kind = 'primary'").get(result.account.id).count, 1);
  } finally {
    current.close();
  }
});

test("rejects a different Microsoft account during reauthorization", async () => {
  const current = fixture();
  const expected = createSourceAccount(current.db, { email: "expected@outlook.com" });
  const graph = new MicrosoftGraphClient({
    db: current.db,
    encryptionKey: "test-encryption-key",
    clientId: CLIENT_ID,
    fetchFn: async (url) => {
      if (String(url).endsWith("/token")) {
        return json({ access_token: "access-token", refresh_token: "refresh-token", id_token: jwt({ preferred_username: "other@hotmail.com" }) });
      }
      if (String(url).includes("/me?$select=")) {
        return json({ id: "other-id", displayName: "Other", mail: "other@hotmail.com", userPrincipalName: "other@hotmail.com" });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  try {
    const session = await graph.startAuthorization({ accountId: expected.id });
    await assert.rejects(
      () => graph.completeAuthorization(session.sessionId, callbackUrl(session.authorizationUrl)),
      (error) => error.code === "OAUTH_ACCOUNT_MISMATCH" && error.status === 409,
    );
    assert.equal(current.db.prepare("SELECT COUNT(*) AS count FROM microsoft_tokens").get().count, 0);
    assert.equal(current.db.prepare("SELECT COUNT(*) AS count FROM source_accounts").get().count, 1);
  } finally {
    current.close();
  }
});

test("refreshes OAuth and extracts verification codes through Microsoft Graph", async () => {
  const current = fixture();
  const account = createSourceAccount(current.db, { email: "source@hotmail.com" });
  let tokenBody;
  let messageRequest;
  const graph = new MicrosoftGraphClient({
    db: current.db,
    encryptionKey: "test-encryption-key",
    clientId: CLIENT_ID,
    fetchFn: async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith("/token")) {
        tokenBody = options.body;
        return json({ access_token: "fresh-access-token", refresh_token: "rotated-refresh-token" });
      }
      if (target.includes("/me/mailFolders/inbox/messages")) {
        messageRequest = { target, options };
        return json({
          value: [
            {
              id: "message-1",
              internetMessageId: "<message-1@example.com>",
              subject: "Your verification code is 482913",
              bodyPreview: "Enter code 482913 to continue.",
              body: { contentType: "text", content: "Enter code 482913 to continue." },
              receivedDateTime: "2026-07-12T06:00:00.000Z",
              from: { emailAddress: { name: "Example", address: "no-reply@example.com" } },
              toRecipients: [{ emailAddress: { address: "source+shop@hotmail.com" } }],
              ccRecipients: [],
              isRead: true,
              hasAttachments: true,
              webLink: "https://outlook.live.com/mail/0/inbox/id/message-1",
            },
            {
              id: "message-2",
              subject: "Security code 731055",
              bodyPreview: "Use this one-time code to sign in.",
              body: { content: "Security code: 731055" },
              receivedDateTime: "2026-07-12T05:00:00.000Z",
              from: { emailAddress: { address: "security@example.net" } },
              toRecipients: [],
              ccRecipients: [{ emailAddress: { address: "source@hotmail.com" } }],
            },
            {
              id: "message-3",
              subject: "Weekly newsletter",
              bodyPreview: "No verification value here.",
              body: { contentType: "text", content: "N".repeat(100_001) },
              receivedDateTime: "2026-07-12T04:00:00.000Z",
              from: { emailAddress: { address: "news@example.net" } },
              toRecipients: [{ emailAddress: { address: "source@hotmail.com" } }],
              ccRecipients: [],
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  current.db.prepare(`
    INSERT INTO microsoft_tokens (account_id, client_id, microsoft_user_id, refresh_token_encrypted, scope, token_updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(account.id, CLIENT_ID, "microsoft-id", graph.encrypt("old-refresh-token"), "Mail.Read", nowIso());
  try {
    const result = await graph.scanInbox(account);
    assert.equal(tokenBody.get("grant_type"), "refresh_token");
    assert.equal(tokenBody.get("refresh_token"), "old-refresh-token");
    assert.match(tokenBody.get("scope"), /Mail\.Read/);
    assert.equal(messageRequest.options.headers.Authorization, "Bearer fresh-access-token");
    assert.equal(messageRequest.options.headers.Prefer, 'outlook.body-content-type="text"');
    const query = new URL(messageRequest.target).searchParams;
    assert.equal(query.get("$top"), "75");
    assert.match(query.get("$select"), /bodyPreview/);
    assert.match(query.get("$select"), /internetMessageId/);
    assert.match(query.get("$select"), /hasAttachments/);

    assert.equal(result.stage, "completed");
    assert.equal(result.messages.length, 3);
    assert.equal(result.messages[0].graphMessageId, "message-1");
    assert.equal(result.messages[0].internetMessageId, "<message-1@example.com>");
    assert.equal(result.messages[0].senderName, "Example");
    assert.equal(result.messages[0].senderAddress, "no-reply@example.com");
    assert.equal(result.messages[0].recipient, "source+shop@hotmail.com");
    assert.equal(result.messages[0].verificationCode, "482913");
    assert.equal(result.messages[0].isRead, true);
    assert.equal(result.messages[0].hasAttachments, true);
    assert.equal(result.messages[0].webLink, "https://outlook.live.com/mail/0/inbox/id/message-1");
    assert.deepEqual(result.messages[0].toRecipients, [{ name: "", address: "source+shop@hotmail.com" }]);
    assert.equal(result.messages[2].verificationCode, "");
    assert.equal(result.messages[2].body.length, 100_000);
    assert.equal(result.messages[2].bodyTruncated, true);
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items.map((item) => item.code), ["482913", "731055"]);
    assert.equal(result.items[0].recipient, "source+shop@hotmail.com");
    assert.equal(result.items[1].sender, "security@example.net");
    const token = current.db.prepare("SELECT refresh_token_encrypted FROM microsoft_tokens WHERE account_id = ?").get(account.id);
    assert.equal(graph.decrypt(token.refresh_token_encrypted), "rotated-refresh-token");
  } finally {
    current.close();
  }
});
