import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JobRunner } from "../account-service.js";
import { createDatabase, createSourceAccount, nowIso } from "../db.js";
import { GoogleGmailClient } from "../google-gmail.js";
import { createApp } from "../index.js";
import { jsonRequest } from "./http-harness.js";

const CLIENT_ID = "google-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "google-client-secret";
const BUILTIN_CLIENT_ID = "406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com";
const BUILTIN_CLIENT_SECRET = "kSmqreRr0qwBWJgbf5Y-PjSU";
const REDIRECT_URI = "http://127.0.0.1:12142/";

function json(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-google-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  return {
    db,
    close() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function callbackUrl(authorizationUrl, code = "google-authorization-code") {
  const authorization = new URL(authorizationUrl);
  const callback = new URL(authorization.searchParams.get("redirect_uri"));
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", authorization.searchParams.get("state"));
  return callback.toString();
}

function encoded(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

test("starts Google PKCE authorization with the built-in loopback client by default", async () => {
  const current = fixture();
  const gmail = new GoogleGmailClient({
    db: current.db,
    encryptionKey: "test-key",
    redirectUri: "http://localhost:9999/wrong-callback",
  });
  try {
    assert.deepEqual(gmail.configuration(), {
      google_oauth_client_id: BUILTIN_CLIENT_ID,
      google_oauth_client_secret_configured: true,
      google_oauth_redirect_uri: REDIRECT_URI,
      google_oauth_configured: true,
      google_oauth_client_mode: "builtin",
      google_oauth_client: "内置邮件公共客户端",
    });
    const result = await gmail.startAuthorization();
    const authorizationUrl = new URL(result.authorizationUrl);
    assert.equal(authorizationUrl.searchParams.get("client_id"), BUILTIN_CLIENT_ID);
    assert.equal(authorizationUrl.searchParams.get("redirect_uri"), REDIRECT_URI);
    assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
    assert.match(authorizationUrl.searchParams.get("scope"), /gmail\.readonly/);
  } finally {
    current.close();
  }
});

test("stores custom Google OAuth configuration safely and starts PKCE authorization", async () => {
  const current = fixture();
  const gmail = new GoogleGmailClient({ db: current.db, encryptionKey: "test-key" });
  try {
    gmail.updateConfiguration({
      google_oauth_client_id: CLIENT_ID,
      google_oauth_client_secret: CLIENT_SECRET,
    });
    const storedSecret = current.db.prepare("SELECT value FROM settings WHERE key = 'google_oauth_client_secret_encrypted'").get().value;
    assert.notEqual(storedSecret, CLIENT_SECRET);
    assert.equal(gmail.decrypt(storedSecret), CLIENT_SECRET);
    assert.deepEqual(gmail.configuration(), {
      google_oauth_client_id: CLIENT_ID,
      google_oauth_client_secret_configured: true,
      google_oauth_redirect_uri: REDIRECT_URI,
      google_oauth_configured: true,
      google_oauth_client_mode: "custom",
      google_oauth_client: "自定义 OAuth 客户端",
    });

    const result = await gmail.startAuthorization();
    const authorizationUrl = new URL(result.authorizationUrl);
    assert.equal(authorizationUrl.origin, "https://accounts.google.com");
    assert.equal(authorizationUrl.pathname, "/o/oauth2/v2/auth");
    assert.equal(authorizationUrl.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(authorizationUrl.searchParams.get("redirect_uri"), REDIRECT_URI);
    assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
    assert.equal(authorizationUrl.searchParams.get("access_type"), "offline");
    assert.equal(authorizationUrl.searchParams.get("prompt"), "consent");
    assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
    assert.match(authorizationUrl.searchParams.get("scope"), /gmail\.readonly/);

    const session = current.db.prepare("SELECT * FROM oauth_code_sessions WHERE id = ?").get(result.sessionId);
    assert.equal(session.provider, "google");
    assert.equal(session.client_id, CLIENT_ID);
    const verifier = gmail.decrypt(session.code_verifier_encrypted);
    assert.equal(
      authorizationUrl.searchParams.get("code_challenge"),
      crypto.createHash("sha256").update(verifier).digest("base64url"),
    );
  } finally {
    current.close();
  }
});

test("does not pair the built-in Google secret with a custom client ID", async () => {
  const current = fixture();
  const gmail = new GoogleGmailClient({ db: current.db, encryptionKey: "test-key" });
  try {
    gmail.updateConfiguration({ google_oauth_client_id: CLIENT_ID });
    assert.equal(gmail.configuration().google_oauth_configured, false);
    assert.equal(gmail.configuration().google_oauth_client_secret_configured, false);
    await assert.rejects(
      () => gmail.startAuthorization(),
      (error) => error.code === "GOOGLE_OAUTH_NOT_CONFIGURED" && error.status === 409,
    );
  } finally {
    current.close();
  }
});

test("completes built-in Google OAuth and stores an encrypted refresh token", async () => {
  const current = fixture();
  const calls = [];
  const gmail = new GoogleGmailClient({
    db: current.db,
    encryptionKey: "test-key",
    fetchFn: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/token")) {
        return json({
          access_token: "google-access-token",
          refresh_token: "google-refresh-token",
          scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly",
        });
      }
      if (String(url) === "https://openidconnect.googleapis.com/v1/userinfo") {
        return json({ sub: "google-user-id", email: "source@gmail.com", email_verified: true, name: "Google User" });
      }
      if (String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
        return json({ emailAddress: "source@gmail.com", messagesTotal: 10, threadsTotal: 8 });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  try {
    const session = await gmail.startAuthorization();
    await assert.rejects(
      () => gmail.completeAuthorization(session.sessionId, `${REDIRECT_URI}?code=x&state=wrong`),
      (error) => error.code === "OAUTH_STATE_MISMATCH" && error.status === 409,
    );
    const result = await gmail.completeAuthorization(session.sessionId, callbackUrl(session.authorizationUrl));
    assert.equal(result.status, "connected");
    assert.equal(result.account.email, "source@gmail.com");
    assert.equal(result.account.provider, "google");
    assert.equal(result.account.official_limit, 1);
    assert.equal(result.account.oauth_connected, true);
    assert.equal(result.account.supports_official_aliases, false);
    assert.equal(result.account.supports_plus_aliases, true);

    const tokenBody = calls[0].options.body;
    assert.equal(tokenBody.get("client_id"), BUILTIN_CLIENT_ID);
    assert.equal(tokenBody.get("client_secret"), BUILTIN_CLIENT_SECRET);
    assert.equal(tokenBody.get("grant_type"), "authorization_code");
    assert.ok(tokenBody.get("code_verifier"));
    const token = current.db.prepare("SELECT * FROM google_tokens WHERE account_id = ?").get(result.account.id);
    assert.equal(token.google_user_id, "google-user-id");
    assert.notEqual(token.refresh_token_encrypted, "google-refresh-token");
    assert.equal(gmail.decrypt(token.refresh_token_encrypted), "google-refresh-token");
    assert.equal(current.db.prepare("SELECT COUNT(*) AS count FROM oauth_code_sessions").get().count, 0);
  } finally {
    current.close();
  }
});

test("preserves an existing Google refresh token when reauthorization does not rotate it", async () => {
  const current = fixture();
  const account = createSourceAccount(current.db, {
    email: "workspace@example.com",
    displayName: "Workspace",
    provider: "google",
    officialLimit: 1,
  });
  const gmail = new GoogleGmailClient({
    db: current.db,
    encryptionKey: "test-key",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    fetchFn: async (url) => {
      if (String(url).endsWith("/token")) return json({ access_token: "new-access-token" });
      if (String(url) === "https://openidconnect.googleapis.com/v1/userinfo") {
        return json({ sub: "workspace-id", email: account.email, email_verified: true, name: "Workspace" });
      }
      if (String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
        return json({ emailAddress: account.email });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  current.db.prepare(`
    INSERT INTO google_tokens
      (account_id, client_id, google_user_id, refresh_token_encrypted, scope, token_updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(account.id, CLIENT_ID, "old-id", gmail.encrypt("existing-refresh-token"), "gmail.readonly", nowIso());
  try {
    const session = await gmail.startAuthorization({ accountId: account.id });
    await gmail.completeAuthorization(session.sessionId, callbackUrl(session.authorizationUrl));
    const stored = current.db.prepare("SELECT * FROM google_tokens WHERE account_id = ?").get(account.id);
    assert.equal(gmail.decrypt(stored.refresh_token_encrypted), "existing-refresh-token");
    assert.equal(stored.google_user_id, "workspace-id");
  } finally {
    current.close();
  }
});

test("requires a new refresh token when the Google OAuth client ID changes", async () => {
  const current = fixture();
  const account = createSourceAccount(current.db, {
    email: "client-change@gmail.com",
    provider: "google",
    officialLimit: 1,
  });
  const previousClient = new GoogleGmailClient({ db: current.db, encryptionKey: "test-key" });
  current.db.prepare(`
    INSERT INTO google_tokens
      (account_id, client_id, google_user_id, refresh_token_encrypted, scope, token_updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(account.id, CLIENT_ID, "google-id", previousClient.encrypt("old-client-refresh-token"), "gmail.readonly", nowIso());
  const newClientId = `new-${CLIENT_ID}`;
  const gmail = new GoogleGmailClient({
    db: current.db,
    encryptionKey: "test-key",
    clientId: newClientId,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    fetchFn: async (url) => {
      if (String(url).endsWith("/token")) return json({ access_token: "new-access-token" });
      if (String(url) === "https://openidconnect.googleapis.com/v1/userinfo") {
        return json({ sub: "google-id", email: account.email, email_verified: true });
      }
      if (String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
        return json({ emailAddress: account.email });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  try {
    const session = await gmail.startAuthorization({ accountId: account.id });
    await assert.rejects(
      () => gmail.completeAuthorization(session.sessionId, callbackUrl(session.authorizationUrl)),
      (error) => error.code === "MISSING_REFRESH_TOKEN" && error.status === 409,
    );
    const stored = current.db.prepare("SELECT * FROM google_tokens WHERE account_id = ?").get(account.id);
    assert.equal(stored.client_id, CLIENT_ID);
    assert.equal(previousClient.decrypt(stored.refresh_token_encrypted), "old-client-refresh-token");
  } finally {
    current.close();
  }
});

test("rejects a Google identity that does not expose a Gmail mailbox", async () => {
  const current = fixture();
  const gmail = new GoogleGmailClient({
    db: current.db,
    encryptionKey: "test-key",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    fetchFn: async (url) => {
      if (String(url).endsWith("/token")) {
        return json({ access_token: "google-access-token", refresh_token: "google-refresh-token" });
      }
      if (String(url) === "https://openidconnect.googleapis.com/v1/userinfo") {
        return json({ sub: "no-mailbox-id", email: "no-mailbox@example.com", email_verified: true });
      }
      if (String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
        return json({ error: { message: "Gmail mailbox is not enabled" } }, 400);
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  try {
    const session = await gmail.startAuthorization();
    await assert.rejects(
      () => gmail.completeAuthorization(session.sessionId, callbackUrl(session.authorizationUrl)),
      (error) => error.code === "GMAIL_MAILBOX_UNAVAILABLE" && error.status === 422,
    );
    assert.equal(current.db.prepare("SELECT COUNT(*) AS count FROM source_accounts").get().count, 0);
    assert.equal(current.db.prepare("SELECT COUNT(*) AS count FROM google_tokens").get().count, 0);
  } finally {
    current.close();
  }
});

test("refreshes Google OAuth and scans full Gmail MIME messages", async () => {
  const current = fixture();
  const account = createSourceAccount(current.db, {
    email: "source@gmail.com",
    provider: "google",
    officialLimit: 1,
  });
  let refreshBody;
  const detailRequests = [];
  const attachmentRequests = [];
  const gmail = new GoogleGmailClient({
    db: current.db,
    encryptionKey: "test-key",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    fetchFn: async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith("/token")) {
        refreshBody = options.body;
        return json({ access_token: "fresh-google-token" });
      }
      if (target.includes("/users/me/messages?") && !target.includes("format=")) {
        return json({ messages: [{ id: "gmail-1" }, { id: "gmail-2" }] });
      }
      if (target.includes("/users/me/messages/gmail-2/attachments/body-2")) {
        attachmentRequests.push({ target, options });
        return json({ data: encoded("<div>Security code: <strong>731055</strong></div>") });
      }
      if (target.includes("/attachments/")) throw new Error(`File attachment must not be fetched: ${target}`);
      if (target.includes("/users/me/messages/gmail-1")) {
        detailRequests.push({ target, options });
        return json({
          id: "gmail-1",
          threadId: "thread-1",
          labelIds: ["INBOX", "UNREAD"],
          internalDate: "1783836000000",
          snippet: "Enter verification code 482913",
          payload: {
            mimeType: "multipart/mixed",
            headers: [
              { name: "Subject", value: "Your verification code is 482913" },
              { name: "From", value: 'Example Team <no-reply@example.com>' },
              { name: "To", value: "Source <source@gmail.com>" },
              { name: "Delivered-To", value: "source+shop@gmail.com" },
              { name: "Message-ID", value: "<gmail-1@example.com>" },
            ],
            parts: [
              {
                mimeType: "multipart/alternative",
                parts: [
                  { mimeType: "text/plain", body: { data: encoded("Enter verification code 482913 to continue.") } },
                  { mimeType: "text/html", body: { data: encoded("<p>Enter <b>482913</b></p>") } },
                ],
              },
              { mimeType: "application/pdf", filename: "receipt.pdf", body: { attachmentId: "attachment-1" } },
            ],
          },
        });
      }
      if (target.includes("/users/me/messages/gmail-2")) {
        detailRequests.push({ target, options });
        return json({
          id: "gmail-2",
          labelIds: ["INBOX"],
          internalDate: "1783832400000",
          snippet: "Security code",
          payload: {
            mimeType: "multipart/mixed",
            headers: [
              { name: "Subject", value: "Security code" },
              { name: "From", value: "security@example.net" },
              { name: "Cc", value: "source@gmail.com" },
            ],
            parts: [
              { mimeType: "text/html", body: { attachmentId: "body-2" } },
              { mimeType: "text/plain", filename: "codes.txt", body: { attachmentId: "file-2" } },
            ],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  current.db.prepare(`
    INSERT INTO google_tokens
      (account_id, client_id, google_user_id, refresh_token_encrypted, scope, token_updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(account.id, CLIENT_ID, "google-id", gmail.encrypt("old-refresh-token"), "gmail.readonly", nowIso());
  try {
    const result = await gmail.scanInbox(account);
    assert.equal(refreshBody.get("grant_type"), "refresh_token");
    assert.equal(refreshBody.get("refresh_token"), "old-refresh-token");
    assert.equal(refreshBody.get("client_secret"), CLIENT_SECRET);
    assert.equal(detailRequests.length, 2);
    assert.equal(attachmentRequests.length, 1);
    assert.equal(attachmentRequests[0].options.headers.Authorization, "Bearer fresh-google-token");
    assert.ok(detailRequests.every((request) => new URL(request.target).searchParams.get("format") === "full"));
    assert.ok(detailRequests.every((request) => request.options.headers.Authorization === "Bearer fresh-google-token"));

    assert.equal(result.stage, "completed");
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].graphMessageId, "gmail-1");
    assert.equal(result.messages[0].internetMessageId, "<gmail-1@example.com>");
    assert.equal(result.messages[0].senderName, "Example Team");
    assert.equal(result.messages[0].senderAddress, "no-reply@example.com");
    assert.equal(result.messages[0].recipient, "source+shop@gmail.com");
    assert.deepEqual(result.messages[0].recipients, ["source+shop@gmail.com", "source@gmail.com"]);
    assert.equal(result.messages[0].verificationCode, "482913");
    assert.equal(result.messages[0].isRead, false);
    assert.equal(result.messages[0].hasAttachments, true);
    assert.equal(result.messages[0].webLink, "https://mail.google.com/mail/u/0/#inbox/thread-1");
    assert.match(result.messages[1].body, /731055/);
    assert.equal(result.messages[1].isRead, true);
    assert.equal(result.messages[1].hasAttachments, true);
    assert.deepEqual(result.items.map((item) => item.code), ["482913", "731055"]);
  } finally {
    current.close();
  }
});

test("times out a stalled Google request and lets JobRunner continue with the next account", async () => {
  const current = fixture();
  const googleAccount = createSourceAccount(current.db, {
    email: "timeout@gmail.com",
    provider: "google",
    officialLimit: 1,
  });
  const microsoftAccount = createSourceAccount(current.db, { email: "next@outlook.com" });
  current.db.prepare("UPDATE source_accounts SET status = 'connected' WHERE id IN (?, ?)")
    .run(googleAccount.id, microsoftAccount.id);
  const gmail = new GoogleGmailClient({
    db: current.db,
    encryptionKey: "test-key",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    requestTimeoutMs: 20,
    fetchFn: async () => new Promise(() => {}),
  });
  current.db.prepare(`
    INSERT INTO google_tokens
      (account_id, client_id, google_user_id, refresh_token_encrypted, scope, token_updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(googleAccount.id, CLIENT_ID, "timeout-id", gmail.encrypt("refresh-token"), "gmail.readonly", nowIso());
  const processed = [];
  const graph = {
    scanInbox: async (account) => {
      processed.push(account.id);
      return { stage: "completed", messages: [], items: [] };
    },
  };
  const inbox = {
    scanInbox(account) {
      return account.provider === "google" ? gmail.scanInbox(account) : graph.scanInbox(account);
    },
  };
  const jobs = new JobRunner(current.db, inbox);
  try {
    const stalled = jobs.createJob(googleAccount.id, "inbox_scan");
    const next = jobs.createJob(microsoftAccount.id, "inbox_scan");
    let stalledResult = jobs.getJob(stalled.id);
    let nextResult = jobs.getJob(next.id);
    for (let attempt = 0; attempt < 100 && !["failed", "completed"].includes(nextResult.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      stalledResult = jobs.getJob(stalled.id);
      nextResult = jobs.getJob(next.id);
    }
    assert.equal(stalledResult.status, "failed");
    assert.match(stalledResult.message, /Google 请求超时/);
    assert.equal(nextResult.status, "completed");
    assert.deepEqual(processed, [microsoftAccount.id]);
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    current.close();
  }
});

test("keeps a Google account connected when Gmail returns a rate-limit 403", async () => {
  const current = fixture();
  const created = createSourceAccount(current.db, {
    email: "rate-limit@gmail.com",
    provider: "google",
    officialLimit: 1,
  });
  current.db.prepare("UPDATE source_accounts SET status = 'connected' WHERE id = ?").run(created.id);
  const account = current.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(created.id);
  const gmail = new GoogleGmailClient({
    db: current.db,
    encryptionKey: "test-key",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetchFn: async (url) => {
      if (String(url).endsWith("/token")) return json({ access_token: "fresh-token" });
      if (String(url).includes("/users/me/messages?")) {
        return json({
          error: {
            code: 403,
            message: "User-rate limit exceeded",
            status: "RESOURCE_EXHAUSTED",
            errors: [{ reason: "userRateLimitExceeded", status: "RESOURCE_EXHAUSTED" }],
          },
        }, 403);
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  current.db.prepare(`
    INSERT INTO google_tokens
      (account_id, client_id, google_user_id, refresh_token_encrypted, scope, token_updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(account.id, CLIENT_ID, "rate-id", gmail.encrypt("refresh-token"), "gmail.readonly", nowIso());
  try {
    await assert.rejects(
      () => gmail.scanInbox(account),
      (error) => error.code === "MAIL_READ_FAILED" && error.status === 503,
    );
    assert.equal(current.db.prepare("SELECT status FROM source_accounts WHERE id = ?").get(account.id).status, "connected");
  } finally {
    current.close();
  }
});

test("uses an overlap after query and skips Gmail message IDs already stored locally", async () => {
  const current = fixture();
  const lastScan = "2026-07-14T06:00:00.000Z";
  const created = createSourceAccount(current.db, {
    email: "incremental@gmail.com",
    provider: "google",
    officialLimit: 1,
  });
  current.db.prepare("UPDATE source_accounts SET status = 'connected', last_inbox_scan_at = ? WHERE id = ?")
    .run(lastScan, created.id);
  current.db.prepare(`
    INSERT INTO mail_messages
      (account_id, fingerprint, graph_message_id, received_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(created.id, "known-fingerprint", "known-id", lastScan, lastScan, lastScan);
  const account = current.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(created.id);
  let listRequest;
  const detailIds = [];
  const gmail = new GoogleGmailClient({
    db: current.db,
    encryptionKey: "test-key",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetchFn: async (url) => {
      const target = String(url);
      if (target.endsWith("/token")) return json({ access_token: "fresh-token" });
      if (target.includes("/users/me/messages?")) {
        listRequest = new URL(target);
        return json({ messages: [{ id: "known-id" }, { id: "new-id" }] });
      }
      if (target.includes("/users/me/messages/known-id")) throw new Error("Known message must not be fetched");
      if (target.includes("/users/me/messages/new-id")) {
        detailIds.push("new-id");
        return json({
          id: "new-id",
          labelIds: ["INBOX"],
          internalDate: String(Date.parse("2026-07-14T06:01:00.000Z")),
          snippet: "New mail",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "Subject", value: "New mail" },
              { name: "To", value: account.email },
            ],
            body: { data: encoded("New message body") },
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  current.db.prepare(`
    INSERT INTO google_tokens
      (account_id, client_id, google_user_id, refresh_token_encrypted, scope, token_updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(account.id, CLIENT_ID, "incremental-id", gmail.encrypt("refresh-token"), "gmail.readonly", nowIso());
  try {
    const result = await gmail.scanInbox(account);
    const expectedAfter = Math.floor((Date.parse(lastScan) - 10 * 60_000) / 1_000);
    assert.equal(listRequest.searchParams.get("q"), `after:${expectedAfter}`);
    assert.equal(listRequest.searchParams.get("maxResults"), "75");
    assert.deepEqual(detailIds, ["new-id"]);
    assert.deepEqual(result.messages.map((item) => item.graphMessageId), ["new-id"]);
  } finally {
    current.close();
  }
});

test("API hides the Google secret, preserves an empty secret update, dispatches providers, and rejects Google official aliases", async () => {
  const current = fixture();
  const calls = [];
  const graph = { scanInbox: async (account) => { calls.push(`microsoft:${account.id}`); return { stage: "completed", messages: [], items: [] }; } };
  const gmail = new GoogleGmailClient({ db: current.db, encryptionKey: "test-key" });
  gmail.updateConfiguration({ google_oauth_client_id: CLIENT_ID, google_oauth_client_secret: CLIENT_SECRET });
  const originalGoogleScan = gmail.scanInbox.bind(gmail);
  gmail.scanInbox = async (account) => {
    calls.push(`google:${account.id}`);
    return { stage: "completed", messages: [], items: [] };
  };
  const runtime = createApp({ db: current.db, graph, gmail, publicBaseUrl: "http://127.0.0.1" });
  const microsoft = createSourceAccount(current.db, { email: "source@outlook.com" });
  const google = createSourceAccount(current.db, { email: "source@gmail.com", provider: "google", officialLimit: 1 });
  current.db.prepare("UPDATE source_accounts SET status = 'connected' WHERE id = ?").run(google.id);
  try {
    const settings = await jsonRequest(runtime.app, "/api/settings");
    assert.equal(settings.response.status, 200);
    assert.equal(settings.body.google_oauth_client_id, CLIENT_ID);
    assert.equal(settings.body.google_oauth_client_secret_configured, true);
    assert.equal(settings.body.google_oauth_configured, true);
    assert.equal("google_oauth_client_secret" in settings.body, false);
    assert.equal("google_oauth_client_secret_encrypted" in settings.body, false);
    const encryptedBefore = current.db.prepare("SELECT value FROM settings WHERE key = 'google_oauth_client_secret_encrypted'").get().value;
    const update = await jsonRequest(runtime.app, "/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ google_oauth_client_id: CLIENT_ID, google_oauth_client_secret: "" }),
    });
    assert.equal(update.response.status, 200);
    assert.equal(current.db.prepare("SELECT value FROM settings WHERE key = 'google_oauth_client_secret_encrypted'").get().value, encryptedBefore);

    await runtime.inbox.scanInbox(microsoft);
    await runtime.inbox.scanInbox(google);
    await runtime.registration.externalEmails({ email: google.email });
    const queuedJob = runtime.jobs.createJob(google.id, "inbox_scan");
    let finishedJob = runtime.jobs.getJob(queuedJob.id);
    for (let attempt = 0; attempt < 50 && finishedJob.status !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finishedJob = runtime.jobs.getJob(queuedJob.id);
    }
    assert.equal(finishedJob.status, "completed");
    assert.deepEqual(calls, [
      `microsoft:${microsoft.id}`,
      `google:${google.id}`,
      `google:${google.id}`,
      `google:${google.id}`,
    ]);

    const officialRequests = [
      [`/api/accounts/${google.id}/sync`, {}],
      [`/api/accounts/${google.id}/official-launch`, {}],
      [`/api/accounts/${google.id}/official-aliases/import`, { aliases: [google.email] }],
      [`/api/accounts/${google.id}/official-fill`, {}],
    ];
    for (const [pathname, body] of officialRequests) {
      const unsupported = await jsonRequest(runtime.app, pathname, {
        method: "POST",
        body: JSON.stringify(body),
      });
      assert.equal(unsupported.response.status, 409, pathname);
      assert.match(unsupported.body.error, /不支持 Microsoft 官方别名/);
    }
    assert.throws(() => runtime.extension.setTarget(google.id), (error) => error.status === 409);
  } finally {
    gmail.scanInbox = originalGoogleScan;
    await new Promise((resolve) => setImmediate(resolve));
    current.close();
  }
});
