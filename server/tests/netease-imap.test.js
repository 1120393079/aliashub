import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistInboxScanResult, publicAccount } from "../account-service.js";
import { createDatabase, createSourceAccount } from "../db.js";
import { createApp } from "../index.js";
import { importNeteaseAliases } from "../netease-aliases.js";
import {
  importNeteaseAccounts,
  parseNeteaseAccountImport,
} from "../netease-import.js";
import {
  NeteaseImapClient,
  neteaseImapConfiguration,
  neteaseImapHostForEmail,
} from "../netease-imap.js";
import { jsonRequest } from "./http-harness.js";

const AUTH_CODE = "netease-client-auth-code";

function context(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-netease-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db") });
  t.after(async () => {
    await new Promise((resolve) => setImmediate(resolve));
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

function adminSessionCookie({ username = "admin", secret }) {
  const timestamp = Date.now();
  const signature = crypto.createHmac("sha256", secret)
    .update(`${username}:${timestamp}`)
    .digest("base64url");
  const token = Buffer.from(`${timestamp}.${signature}`).toString("base64url");
  return `aliashub_session=${token}`;
}

test("parses网易母号 rows and maps following @aka.yeah.net aliases", () => {
  const parsed = parseNeteaseAccountImport({
    content: [
      `Owner@163.com----${AUTH_CODE}----first@aka.yeah.net`,
      "second@aka.yeah.net",
      "third@aka.yeah.net, fourth@aka.yeah.net",
      "other@126.com----other-auth-code",
      "other-alias@aka.yeah.net",
    ].join("\n"),
  });
  assert.deepEqual(parsed, [
    {
      email: "owner@163.com",
      authCode: AUTH_CODE,
      aliases: [
        "first@aka.yeah.net",
        "second@aka.yeah.net",
        "third@aka.yeah.net",
        "fourth@aka.yeah.net",
      ],
    },
    {
      email: "other@126.com",
      authCode: "other-auth-code",
      aliases: ["other-alias@aka.yeah.net"],
    },
  ]);
  assert.deepEqual(parseNeteaseAccountImport({
    accounts: [{
      email: "member@yeah.net",
      authCode: "structured-code",
      aliases: ["structured@aka.yeah.net"],
    }],
  }), [{
    email: "member@yeah.net",
    authCode: "structured-code",
    aliases: ["structured@aka.yeah.net"],
  }]);
  assert.deepEqual(parseNeteaseAccountImport({
    content: `dedupe@163.com----${AUTH_CODE}----Same@AKA.YEAH.NET----same@aka.yeah.net`,
  }), [{
    email: "dedupe@163.com",
    authCode: AUTH_CODE,
    aliases: ["same@aka.yeah.net"],
  }]);
  assert.throws(
    () => parseNeteaseAccountImport({
      content: `owner@163.com----${AUTH_CODE}----not-netease@example.com`,
    }),
    (error) => error.status === 400
      && error.code === "NETEASE_IMPORT_INVALID"
      && !error.message.includes(AUTH_CODE),
  );
  assert.throws(
    () => parseNeteaseAccountImport({ content: "orphan@aka.yeah.net" }),
    (error) => error.status === 400,
  );
  for (const invalid of [
    "alias@yeah.net",
    "alias@sub.aka.yeah.net",
    "alias@aka.yeah.net.example.com",
  ]) {
    assert.throws(
      () => parseNeteaseAccountImport({
        content: `owner@163.com----${AUTH_CODE}----${invalid}`,
      }),
      (error) => error.code === "NETEASE_IMPORT_INVALID"
        && !error.message.includes(AUTH_CODE),
    );
  }
  assert.throws(
    () => parseNeteaseAccountImport({
      content: [
        `first@163.com----${AUTH_CODE}----shared@aka.yeah.net`,
        "second@126.com----second-auth-code----SHARED@AKA.YEAH.NET",
      ].join("\n"),
    }),
    (error) => error.code === "NETEASE_IMPORT_INVALID" && /多个/.test(error.message),
  );
});

test("selects a fixed TLS IMAP endpoint from each网易母号 domain", () => {
  assert.equal(neteaseImapHostForEmail("owner@163.com"), "imap.163.com");
  assert.equal(neteaseImapHostForEmail("owner@126.com"), "imap.126.com");
  assert.equal(neteaseImapHostForEmail("owner@yeah.net"), "imap.yeah.net");
  assert.equal(neteaseImapHostForEmail("alias@aka.yeah.net"), "");
  assert.deepEqual(neteaseImapConfiguration("owner@126.com"), {
    host: "imap.126.com",
    port: 993,
    secure: true,
  });
  assert.throws(
    () => neteaseImapConfiguration("owner@example.com"),
    (error) => error.code === "INVALID_NETEASE_EMAIL",
  );
});

test("connects and scans网易邮箱 while keeping the auth code encrypted", async (t) => {
  const { db } = context(t);
  let mode = "connect";
  let fetches = 0;
  const configurations = [];
  const rawMessage = Buffer.from([
    "From: OpenAI <noreply@openai.com>",
    "To: NetEase Alias <inbox-one@aka.yeah.net>",
    "Delivered-To: mother@163.com",
    "X-Original-To: inbox-one@aka.yeah.net",
    "Subject: Your verification code is 482913",
    "Message-ID: <netease-test-1@example.com>",
    "Date: Tue, 18 Aug 2026 12:30:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Use 482913 to verify your account.",
  ].join("\r\n"));
  const client = new NeteaseImapClient({
    db,
    encryptionKey: "netease-test-encryption-key",
    imapFactory(config) {
      configurations.push(config);
      return {
        usable: false,
        mailbox: { uidValidity: 27n },
        async connect() {
          if (mode === "auth_failure") throw authError();
          this.usable = true;
        },
        async mailboxOpen(pathname, options) {
          assert.equal(pathname, "INBOX");
          assert.equal(options.readOnly, true);
          return { uidValidity: 27n };
        },
        async search() { return mode === "scan" ? [91] : []; },
        async fetchOne() {
          fetches += 1;
          return {
            uid: 91,
            flags: new Set(),
            internalDate: new Date("2026-08-18T12:30:00.000Z"),
            size: rawMessage.length,
            source: rawMessage,
          };
        },
        async logout() { this.usable = false; },
        close() {},
      };
    },
  });

  const connected = await client.connectAccount({
    email: "Mother@163.com",
    authCode: AUTH_CODE,
    aliases: ["Inbox-One@aka.yeah.net", "inbox-two@aka.yeah.net"],
  });
  assert.equal(configurations[0].host, "imap.163.com");
  assert.equal(configurations[0].port, 993);
  assert.equal(configurations[0].secure, true);
  assert.equal(configurations[0].auth.user, "mother@163.com");
  assert.equal(configurations[0].tls.servername, "imap.163.com");
  assert.equal(connected.account.provider, "netease");
  assert.equal(connected.account.auth_mode, "imap_auth_code");
  assert.equal(connected.account.netease_aliases, 2);
  assert.deepEqual(connected.aliases, ["inbox-one@aka.yeah.net", "inbox-two@aka.yeah.net"]);
  assert.equal(JSON.stringify(connected).includes(AUTH_CODE), false);

  const stored = db.prepare(
    "SELECT * FROM netease_credentials WHERE account_id = ?",
  ).get(connected.account.id);
  assert.notEqual(stored.auth_code_encrypted, AUTH_CODE);
  assert.equal(client.decrypt(stored.auth_code_encrypted), AUTH_CODE);

  const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(connected.account.id);
  mode = "scan";
  const scan = await client.scanInbox(account);
  assert.equal(scan.messages[0].graphMessageId, "netease:27:91");
  assert.deepEqual(scan.messages[0].recipients, [
    "mother@163.com",
    "inbox-one@aka.yeah.net",
  ]);
  assert.equal(scan.items[0].code, "482913");
  const persisted = persistInboxScanResult(db, account, scan);
  assert.equal(persisted.codes.added, 1);
  const alias = db.prepare(
    "SELECT id FROM addresses WHERE account_id = ? AND address = ?",
  ).get(account.id, "inbox-one@aka.yeah.net");
  assert.equal(db.prepare("SELECT address_id FROM mail_messages LIMIT 1").get().address_id, alias.id);
  assert.equal(db.prepare("SELECT address_id FROM verification_codes LIMIT 1").get().address_id, alias.id);
  await client.scanInbox(account);
  assert.equal(fetches, 1);

  mode = "connect";
  const appended = await client.connectAccount({
    accountId: account.id,
    email: account.email,
    authCode: "rotated-auth-code",
    aliases: ["inbox-three@aka.yeah.net"],
  });
  assert.deepEqual(appended.aliases, [
    "inbox-one@aka.yeah.net",
    "inbox-two@aka.yeah.net",
    "inbox-three@aka.yeah.net",
  ]);
  const preserved = await client.connectAccount({
    accountId: account.id,
    email: account.email,
    authCode: "rotated-auth-code-again",
    aliases: [],
  });
  assert.deepEqual(preserved.aliases, appended.aliases);
  const encryptedBeforeFailure = db.prepare(
    "SELECT auth_code_encrypted FROM netease_credentials WHERE account_id = ?",
  ).get(account.id).auth_code_encrypted;
  mode = "auth_failure";
  await assert.rejects(
    () => client.connectAccount({
      accountId: account.id,
      email: account.email,
      authCode: "replacement-secret",
    }),
    (error) => error.code === "NETEASE_AUTH_FAILED"
      && !error.message.includes("replacement-secret"),
  );
  assert.equal(
    db.prepare("SELECT auth_code_encrypted FROM netease_credentials WHERE account_id = ?").get(account.id).auth_code_encrypted,
    encryptedBeforeFailure,
  );
});

test("scans every selectable网易文件夹 and recovers messages missed by INBOX-only scans", async (t) => {
  const { db } = context(t);
  const rawMessage = ({ id, subject, code, to = "alias@aka.yeah.net" }) => Buffer.from([
    "From: OpenAI <noreply@tm.openai.com>",
    `To: Alias <${to}>`,
    `Subject: ${subject}`,
    `Message-ID: <${id}@example.com>`,
    "Date: Tue, 19 Aug 2026 15:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Use ${code} to verify your account.`,
  ].join("\r\n"));
  const messages = {
    INBOX: {
      11: rawMessage({ id: "same", subject: "Your verification code is 111111", code: "111111" }),
    },
    "接收账单": {
      21: rawMessage({ id: "same", subject: "Your verification code is 111111", code: "111111" }),
      22: rawMessage({ id: "custom", subject: "Your verification code is 222222", code: "222222" }),
    },
    "注册steam帐号": {
      31: rawMessage({ id: "steam", subject: "Your verification code is 333333", code: "333333" }),
    },
  };
  const uidValidity = { INBOX: 1n, "接收账单": 1023n, "注册steam帐号": 1022n };
  const openedPaths = [];
  const searchQueries = [];
  let fetches = 0;
  const client = new NeteaseImapClient({
    db,
    encryptionKey: "netease-test-encryption-key",
    imapFactory() {
      return {
        usable: false,
        mailbox: { uidValidity: 1n },
        async connect() { this.usable = true; },
        async list() {
          return [
            { path: "INBOX", specialUse: "\\Inbox", flags: new Set() },
            { path: "接收账单", flags: new Set() },
            { path: "注册steam帐号", flags: new Set() },
            { path: "系统父文件夹", flags: new Set(["\\Noselect"]) },
            { path: "已发送", specialUse: "\\Sent", flags: new Set(["\\Sent"]) },
            { path: "草稿箱", specialUse: "\\Drafts", flags: new Set(["\\Drafts"]) },
            { path: "全部邮件", specialUse: "\\All", flags: new Set(["\\All"]) },
          ];
        },
        async mailboxOpen(pathname, options) {
          assert.equal(options.readOnly, true);
          openedPaths.push(pathname);
          this.currentPath = pathname;
          return { uidValidity: uidValidity[pathname] || 0n };
        },
        async search(query, options) {
          assert.equal(options.uid, true);
          searchQueries.push({ path: this.currentPath, query });
          return Object.keys(messages[this.currentPath] || {}).map(Number);
        },
        async fetchOne(uid) {
          fetches += 1;
          return {
            uid,
            flags: new Set(),
            internalDate: new Date("2026-08-19T15:00:00.000Z"),
            size: messages[this.currentPath][uid].length,
            source: messages[this.currentPath][uid],
          };
        },
        async logout() { this.usable = false; },
        close() {},
      };
    },
  });

  const connected = await client.connectAccount({
    email: "owner@163.com",
    authCode: AUTH_CODE,
    aliases: ["alias@aka.yeah.net"],
  });
  openedPaths.length = 0;
  searchQueries.length = 0;
  // Simulate an earlier INBOX-only scan. The custom folders must still be
  // searched in the bounded backfill window so their messages are not hidden
  // by the INBOX cursor.
  db.prepare("UPDATE source_accounts SET last_inbox_scan_at = ? WHERE id = ?")
    .run("2026-08-19T16:00:00.000Z", connected.account.id);
  const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(connected.account.id);
  const result = await client.scanInbox(account);

  assert.deepEqual(openedPaths, ["INBOX", "接收账单", "注册steam帐号"]);
  assert.equal(searchQueries[0].path, "INBOX");
  assert.ok(searchQueries[0].query.since instanceof Date);
  assert.deepEqual(searchQueries.slice(1).map((item) => item.path), ["接收账单", "注册steam帐号"]);
  searchQueries.slice(1).forEach((item) => {
    assert.ok(item.query.since instanceof Date);
    assert.ok(item.query.since.getTime() < Date.now() - 24 * 60 * 60_000);
  });
  assert.equal(result.foldersScanned, 3);
  assert.equal(result.foldersTotal, 3);
  assert.equal(result.messages.length, 3);
  assert.deepEqual(result.items.map((item) => item.code), ["111111", "222222", "333333"]);
  assert.equal(result.messages.filter((item) => item.internetMessageId.includes("same@")).length, 1);
  assert.equal(result.messages.some((item) => item.graphMessageId.startsWith("netease:1023-")), true);
  assert.equal(result.folderErrors.length, 0);

  persistInboxScanResult(db, account, result);
  const repeated = await client.scanInbox(
    db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(connected.account.id),
  );
  assert.equal(repeated.messages.length, 0);
  assert.equal(repeated.items.length, 0);
  // The duplicate copy is fetched once to inspect its Message-ID, then is
  // removed from the returned result; persisted graph ids remain idempotent.
  assert.equal(fetches, 5);
});

test("does not acknowledge a网易 LIST transport failure", async (t) => {
  const { db } = context(t);
  let closed = 0;
  const client = new NeteaseImapClient({
    db,
    encryptionKey: "netease-test-encryption-key",
    imapFactory() {
      return {
        usable: false,
        async connect() { this.usable = true; },
        async mailboxOpen() { return { uidValidity: 1n }; },
        async list() { throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" }); },
        async logout() { this.usable = false; closed += 1; },
        close() { closed += 1; },
      };
    },
  });
  const connected = await client.connectAccount({ email: "owner@163.com", authCode: AUTH_CODE });
  const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(connected.account.id);
  await assert.rejects(
    () => client.scanInbox(account),
    (error) => error.status === 503 && error.code === "NETEASE_IMAP_UNAVAILABLE",
  );
  assert.equal(db.prepare("SELECT status FROM source_accounts WHERE id = ?").get(account.id).status, "connected");
  assert.ok(closed >= 1);
});

test("replaces网易 aliases and rejects mapping one alias to two母号", async (t) => {
  const { db } = context(t);
  const first = createSourceAccount(db, {
    email: "first@163.com",
    provider: "netease",
  });
  const second = createSourceAccount(db, {
    email: "second@126.com",
    provider: "netease",
  });
  importNeteaseAliases(db, first, [
    "old@aka.yeah.net",
    "kept@aka.yeah.net",
  ]);
  const replaced = importNeteaseAliases(db, first, [
    "Kept@AKA.YEAH.NET",
    "kept@aka.yeah.net",
    "new@aka.yeah.net",
  ], { replace: true });
  assert.deepEqual(
    replaced.filter((item) => item.strategy === "netease_alias").map((item) => item.address),
    ["kept@aka.yeah.net", "new@aka.yeah.net"],
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE account_id = ? AND address = ?").get(first.id, "old@aka.yeah.net").count,
    0,
  );
  assert.throws(
    () => importNeteaseAliases(db, second, ["kept@aka.yeah.net"]),
    (error) => error.code === "NETEASE_ALIAS_ALREADY_ASSIGNED",
  );
  assert.throws(
    () => importNeteaseAliases(db, first, ["not-an-alias@yeah.net"]),
    (error) => error.code === "INVALID_NETEASE_ALIAS",
  );

  let credentialOnlyInput;
  const credentialOnly = await importNeteaseAccounts({
    db,
    async connectAccount(input) {
      credentialOnlyInput = input;
      return { account: { id: first.id, email: first.email, provider: "netease" } };
    },
  }, { content: "first@163.com----new-client-code" });
  assert.equal(credentialOnly.updated, 1);
  assert.equal(Object.hasOwn(credentialOnlyInput, "aliases"), false);

  const failedSecret = "must-never-be-returned";
  const imported = await importNeteaseAccounts({
    db,
    async connectAccount(input) {
      throw Object.assign(new Error(`upstream echoed ${input.authCode}`), { status: 409 });
    },
  }, {
    content: `third@yeah.net----${failedSecret}----third@aka.yeah.net`,
  });
  assert.equal(imported.failed, 1);
  assert.equal(JSON.stringify(imported).includes(failedSecret), false);
  assert.match(imported.items[0].error, /\[REDACTED\]/);
});

test("advertises网易 capabilities and submits替身邮箱 as a direct registration mailbox", async (t) => {
  const { db } = context(t);
  const account = createSourceAccount(db, {
    email: "registration-owner@yeah.net",
    provider: "netease",
  });
  db.prepare("UPDATE source_accounts SET status = 'connected' WHERE id = ?").run(account.id);
  const addresses = importNeteaseAliases(db, account, ["register-me@aka.yeah.net"]);
  const alias = addresses.find((item) => item.address === "register-me@aka.yeah.net");
  const exposedAccount = publicAccount(
    db,
    db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id),
  );
  assert.equal(exposedAccount.auth_mode, "imap_auth_code");
  assert.equal(exposedAccount.supports_imported_aliases, true);
  assert.equal(exposedAccount.supports_direct_registration, true);
  assert.equal(exposedAccount.supports_netease_aliases, true);
  assert.equal(exposedAccount.supports_plus_aliases, false);

  const created = [];
  const registrationClient = {
    async health() { return { ok: true, configured: true }; },
    async createTask(payload) {
      created.push(payload);
      return { task_id: `netease-task-${created.length}` };
    },
  };
  const pickup = { registrationProtectionEnabled: () => false };
  const adminPassword = "netease-api-admin-password";
  const sessionSecret = "netease-api-session-secret";
  const previousAdminPassword = process.env.ADMIN_PASSWORD;
  const previousSessionSecret = process.env.SESSION_SECRET;
  const previousMailboxUrl = process.env.REGISTRATION_MAILBOX_URL;
  process.env.ADMIN_PASSWORD = adminPassword;
  process.env.SESSION_SECRET = sessionSecret;
  delete process.env.REGISTRATION_MAILBOX_URL;
  let runtime;
  try {
    runtime = createApp({
      db,
      netease: { async scanInbox() { return { stage: "completed", messages: [], items: [] }; } },
      registrationClient,
      pickup,
      publicBaseUrl: "https://alias.test/alias-hub",
    });
  } finally {
    if (previousAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previousAdminPassword;
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
    if (previousMailboxUrl === undefined) delete process.env.REGISTRATION_MAILBOX_URL;
    else process.env.REGISTRATION_MAILBOX_URL = previousMailboxUrl;
  }

  const anonymousResponse = await jsonRequest(runtime.app, "/api/accounts");
  assert.equal(anonymousResponse.response.status, 401);
  const accountsResponse = await jsonRequest(runtime.app, "/api/accounts", {
    headers: { cookie: adminSessionCookie({ secret: sessionSecret }) },
  });
  assert.equal(accountsResponse.response.status, 200);
  assert.deepEqual(accountsResponse.body.neteaseDomains, ["163.com", "126.com", "yeah.net"]);
  assert.equal(accountsResponse.body.neteaseAliasDomain, "aka.yeah.net");
  assert.deepEqual(accountsResponse.body.providers.netease, {
    authMode: "imap_auth_code",
    supportsOfficialAliases: false,
    supportsPlusAliases: false,
    supportsImportedAliases: true,
    supportsDirectRegistration: true,
    supportsNeteaseAliases: true,
    aliasDomain: "aka.yeah.net",
  });

  const jobs = await runtime.registration.createJobs({
    accountId: account.id,
    addressIds: [alias.id],
    count: 1,
    browserMode: "headless",
    proxySelection: "direct",
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].email, "register-me@aka.yeah.net");
  assert.equal(jobs[0].address_id, alias.id);
  assert.equal(jobs[0].base_address_id, alias.id);
  assert.equal(created.length, 1);
  assert.equal(created[0].email, "register-me@aka.yeah.net");
  assert.equal(created[0].extra.mail_source_provider, "netease");
  assert.equal(created[0].extra.outlook_email_fixed_email, "register-me@aka.yeah.net");
  assert.equal(created[0].extra.outlook_email_api_url, "https://alias.test/alias-hub");
  assert.equal(created[0].extra.email_only_registration, true);
});
