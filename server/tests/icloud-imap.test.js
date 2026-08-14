import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistInboxScanResult } from "../account-service.js";
import { normalizeIcloudEmail } from "../address-generator.js";
import { createDatabase, createSourceAccount } from "../db.js";
import { ICloudImapClient } from "../icloud-imap.js";
import { createApp } from "../index.js";
import { accountSupportsPlusAliases, normalizeProvider, providerMeta } from "../../src/providers.js";

const APP_PASSWORD = "abcd-efgh-ijkl-mnop";

function context(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-icloud-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db") });
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { db };
}

function authError() {
  return Object.assign(new Error("authentication failed"), {
    authenticationFailed: true,
    serverResponseCode: "AUTHENTICATIONFAILED",
  });
}

test("accepts any valid Apple account email and exposes provider capabilities", () => {
  assert.equal(normalizeIcloudEmail(" User@iCloud.com "), "user@icloud.com");
  assert.equal(normalizeIcloudEmail("user@me.com"), "user@me.com");
  assert.equal(normalizeIcloudEmail("user@mac.com"), "user@mac.com");
  assert.equal(normalizeIcloudEmail("Apple.User@QQ.com"), "apple.user@qq.com");
  assert.equal(normalizeIcloudEmail("user@custom.example"), "user@custom.example");
  assert.equal(normalizeIcloudEmail("not-an-email"), "");
  assert.equal(normalizeProvider("icloud"), "icloud");
  assert.equal(providerMeta("icloud").authMode, "app_password");
  assert.equal(accountSupportsPlusAliases({ provider: "icloud" }), false);
});

test("requires an explicit server encryption key before accepting iCloud credentials", async (t) => {
  const { db } = context(t);
  const client = new ICloudImapClient({
    db,
    encryptionKey: "",
    imapFactory() {
      throw new Error("IMAP must not be contacted without an encryption key");
    },
  });

  await assert.rejects(
    () => client.connectAccount({ email: "source@icloud.com", appSpecificPassword: APP_PASSWORD }),
    (error) => error.status === 503 && error.code === "ICLOUD_ENCRYPTION_KEY_REQUIRED",
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM source_accounts").get().count, 0);
});

test("keeps an IMAP error listener attached so socket errors cannot terminate Node", (t) => {
  const { db } = context(t);
  const rawClient = new EventEmitter();
  const client = new ICloudImapClient({ db, encryptionKey: "test-encryption-key", imapFactory: () => rawClient });
  assert.equal(client.createClient("source", APP_PASSWORD), rawClient);
  assert.equal(rawClient.listenerCount("error"), 1);
  assert.doesNotThrow(() => rawClient.emit("error", new Error("socket closed")));
});

test("connects iCloud with fixed TLS settings and stores only encrypted credentials", async (t) => {
  const { db } = context(t);
  const configurations = [];
  let closed = 0;
  const client = new ICloudImapClient({
    db,
    encryptionKey: "test-encryption-key",
    imapFactory(config) {
      configurations.push(config);
      return {
        usable: false,
        async connect() {
          if (!config.auth.user.includes("@")) throw authError();
          this.usable = true;
        },
        async mailboxOpen(pathname, options) {
          assert.equal(pathname, "INBOX");
          assert.equal(options.readOnly, true);
          return { uidValidity: 77n };
        },
        async logout() { this.usable = false; closed += 1; },
        close() { closed += 1; },
      };
    },
  });

  const result = await client.connectAccount({
    email: "apple-source@qq.com",
    displayName: "iCloud Source",
    appSpecificPassword: APP_PASSWORD,
  });

  assert.equal(configurations.length, 2);
  assert.deepEqual(configurations.map((item) => item.auth.user), ["apple-source", "apple-source@qq.com"]);
  configurations.forEach((config) => {
    assert.equal(config.host, "imap.mail.me.com");
    assert.equal(config.port, 993);
    assert.equal(config.secure, true);
    assert.equal(config.logger, false);
    assert.equal(config.tls.rejectUnauthorized, true);
    assert.equal(config.tls.minVersion, "TLSv1.2");
  });
  assert.equal(closed, 2);
  assert.equal(result.account.provider, "icloud");
  assert.equal(result.account.status, "connected");
  assert.equal(result.account.official_limit, 1);
  assert.equal(result.account.supports_official_aliases, false);
  assert.equal(result.account.supports_plus_aliases, false);
  assert.equal(result.account.connection_connected, true);
  assert.equal(result.account.oauth_connected, false);
  assert.equal(result.account.auth_mode, "app_password");
  assert.equal(JSON.stringify(result).includes(APP_PASSWORD), false);

  const stored = db.prepare("SELECT * FROM icloud_credentials WHERE account_id = ?").get(result.account.id);
  assert.equal(stored.username, "apple-source@qq.com");
  assert.notEqual(stored.app_password_encrypted, APP_PASSWORD);
  assert.equal(client.decrypt(stored.app_password_encrypted), APP_PASSWORD);
  assert.equal(db.prepare("SELECT address FROM addresses WHERE account_id = ? AND kind = 'primary'").get(result.account.id).address, "apple-source@qq.com");

  const before = stored.app_password_encrypted;
  client.imapFactory = (config) => ({
    usable: false,
    async connect() { throw authError(); },
    close() {},
  });
  await assert.rejects(
    () => client.connectAccount({ accountId: result.account.id, email: result.account.email, appSpecificPassword: "wrong-password" }),
    (error) => error.status === 409 && error.code === "ICLOUD_AUTH_FAILED",
  );
  assert.equal(db.prepare("SELECT app_password_encrypted FROM icloud_credentials WHERE account_id = ?").get(result.account.id).app_password_encrypted, before);
  assert.equal(db.prepare("SELECT status FROM source_accounts WHERE id = ?").get(result.account.id).status, "connected");

  db.prepare("DELETE FROM source_accounts WHERE id = ?").run(result.account.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM icloud_credentials").get().count, 0);
});

test("scans bounded iCloud MIME, extracts codes, and skips persisted UIDs", async (t) => {
  const { db } = context(t);
  let mode = "connect";
  let fetches = 0;
  let logouts = 0;
  const rawMessage = Buffer.from([
    "From: Example Security <security@example.com>",
    "To: Source <source@icloud.com>",
    "Delivered-To: source@icloud.com",
    "Subject: Your verification code is 482913",
    "Message-ID: <icloud-test-1@example.com>",
    "Date: Tue, 22 Jul 2026 12:30:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Use <strong>482913</strong> to verify your account.</p>",
  ].join("\r\n"));
  const configurations = [];
  const client = new ICloudImapClient({
    db,
    encryptionKey: "test-encryption-key",
    imapFactory(config) {
      configurations.push(config);
      return {
        usable: false,
        mailbox: { uidValidity: 991n },
        async connect() {
          if (mode === "auth_failure") throw authError();
          if (mode === "transient_failure") throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
          this.usable = true;
        },
        async mailboxOpen() { return { uidValidity: 991n }; },
        async search(query, options) {
          assert.ok(query.since instanceof Date);
          assert.equal(options.uid, true);
          return [501];
        },
        async fetchOne(uid, query, options) {
          fetches += 1;
          assert.equal(uid, 501);
          assert.equal(query.source.maxLength, 1024 * 1024 + 1);
          assert.equal(options.uid, true);
          return {
            uid,
            flags: new Set(["\\Seen"]),
            internalDate: new Date("2026-07-22T12:30:00.000Z"),
            size: rawMessage.length,
            source: rawMessage,
          };
        },
        async logout() { this.usable = false; logouts += 1; },
        close() { logouts += 1; },
      };
    },
  });
  const connected = await client.connectAccount({ email: "source@icloud.com", appSpecificPassword: APP_PASSWORD });
  mode = "scan";
  const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(connected.account.id);
  const result = await client.scanInbox(account);

  assert.equal(result.stage, "completed");
  assert.equal(result.messages.length, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].code, "482913");
  assert.equal(result.messages[0].graphMessageId, "icloud:991:501");
  assert.equal(result.messages[0].senderAddress, "security@example.com");
  assert.deepEqual(result.messages[0].recipients, ["source@icloud.com"]);
  assert.equal(result.messages[0].isRead, true);
  assert.equal(result.messages[0].bodyContentType, "html");
  assert.match(result.messages[0].body, /482913/);
  assert.equal(JSON.stringify(result).includes(APP_PASSWORD), false);
  assert.equal(configurations.at(-1).auth.user, "source");
  assert.ok(logouts >= 2);

  const persisted = persistInboxScanResult(db, account, result);
  assert.equal(persisted.messages.added, 1);
  assert.equal(persisted.codes.added, 1);
  const repeated = await client.scanInbox(db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id));
  assert.equal(repeated.messages.length, 0);
  assert.equal(fetches, 1);

  mode = "auth_failure";
  await assert.rejects(() => client.scanInbox(account), (error) => error.code === "ICLOUD_AUTH_FAILED");
  assert.equal(db.prepare("SELECT status FROM source_accounts WHERE id = ?").get(account.id).status, "action_required");

  db.prepare("UPDATE source_accounts SET status = 'connected' WHERE id = ?").run(account.id);
  mode = "transient_failure";
  await assert.rejects(
    () => client.scanInbox(account),
    (error) => error.status === 503 && error.code === "ICLOUD_IMAP_UNAVAILABLE",
  );
  assert.equal(db.prepare("SELECT status FROM source_accounts WHERE id = ?").get(account.id).status, "connected");
});

test("iCloud API rejects custom IMAP endpoints and dispatcher routes all providers", async (t) => {
  const { db } = context(t);
  const calls = [];
  const graph = { async scanInbox(account) { calls.push(`microsoft:${account.id}`); return { stage: "completed", messages: [], items: [] }; } };
  const gmail = {
    configuration() { return {}; },
    updateConfiguration() { return {}; },
    async scanInbox(account) { calls.push(`google:${account.id}`); return { stage: "completed", messages: [], items: [] }; },
  };
  const icloud = {
    async connectAccount(input) {
      calls.push(`connect:${input.email}`);
      return { status: "connected", account: { id: 3, email: input.email, provider: "icloud" } };
    },
    async scanInbox(account) { calls.push(`icloud:${account.id}`); return { stage: "completed", messages: [], items: [] }; },
  };
  const runtime = createApp({ db, graph, gmail, icloud });
  await runtime.inbox.scanInbox({ id: 1, provider: "microsoft" });
  await runtime.inbox.scanInbox({ id: 2, provider: "google" });
  await runtime.inbox.scanInbox({ id: 3, provider: "icloud" });
  assert.deepEqual(calls, ["microsoft:1", "google:2", "icloud:3"]);

  const server = runtime.app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const rejected = await fetch(`${baseUrl}/api/icloud/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "source@icloud.com", appSpecificPassword: APP_PASSWORD, host: "example.invalid" }),
  });
  assert.equal(rejected.status, 400);
  const accepted = await fetch(`${baseUrl}/api/icloud/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "source@icloud.com", appSpecificPassword: APP_PASSWORD }),
  });
  assert.equal(accepted.status, 201);
  const body = await accepted.json();
  assert.equal(body.account.provider, "icloud");
  assert.equal(JSON.stringify(body).includes(APP_PASSWORD), false);
  assert.equal(calls.at(-1), "connect:source@icloud.com");

  const icloudAccount = createSourceAccount(db, { email: "second@icloud.com", provider: "icloud" });
  db.prepare("UPDATE source_accounts SET status = 'connected' WHERE id = ?").run(icloudAccount.id);
  const split = await fetch(`${baseUrl}/api/accounts/${icloudAccount.id}/splits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ countPerBase: 1 }),
  });
  assert.equal(split.status, 409);
  assert.match((await split.json()).error, /不支持 Plus/);

  const accounts = await (await fetch(`${baseUrl}/api/accounts`)).json();
  assert.equal(accounts.providers.icloud.authMode, "app_password");
  assert.equal(accounts.providers.icloud.supportsPlusAliases, false);
});
