import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importMailcomAliases } from "../account-service.js";
import { MAILCOM_ALIAS_STRATEGY } from "../address-generator.js";
import { createDatabase, createSourceAccount, nowIso } from "../db.js";
import { createApp } from "../index.js";
import {
  MailcomAliasAutomationService,
  normalizeRemoteMailcomAddresses,
  normalizeRemoteMailcomDomains,
} from "../mailcom-alias-service.js";
import {
  MailcomAliasPlaywrightAdapter,
  MailcomBrowserSemaphore,
  MailcomSettingsApiSession,
  mailcomAliasSettingsEndpoints,
} from "../mailcom-alias-playwright.js";
import { MailComImapClient } from "../mailcom-imap.js";
import { PickupService } from "../pickup-service.js";
import { jsonRequest } from "./http-harness.js";

const PASSWORD = "web-login-secret";
const ENCRYPTION_KEY = "mailcom-alias-service-test-key";

function context(t, email = "mother@techie.com") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-mailcom-alias-service-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const account = createSourceAccount(db, { email, provider: "mailcom", officialLimit: 10 });
  db.prepare("UPDATE source_accounts SET status = 'connected', updated_at = ? WHERE id = ?")
    .run(nowIso(), account.id);
  const mailcom = new MailComImapClient({ db, encryptionKey: ENCRYPTION_KEY });
  db.prepare(`
    INSERT INTO mailcom_credentials (account_id, username, password_encrypted, credential_updated_at)
    VALUES (?, ?, ?, ?)
  `).run(account.id, email, mailcom.encrypt(PASSWORD), nowIso());
  t.after(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    mailcom,
    account: db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id),
  };
}

function randomSequence() {
  let value = 0;
  return (size) => {
    value += 1;
    return Buffer.alloc(size, value);
  };
}

function fakeAdapter({
  initial = ["mother@techie.com"],
  domains = ["mail.com", "techie.com"],
  openGate,
  failCreateAt = 0,
  confirmationLagReads = 0,
  addressMetadata = {},
  stringAddresses = false,
  unavailableAddresses = [],
} = {}) {
  const unavailable = new Set(unavailableAddresses);
  const state = {
    remote: [...initial],
    created: [],
    deleted: [],
    validations: [],
    opens: [],
    closed: 0,
    pending: null,
  };
  return {
    state,
    async open(credentials) {
      state.opens.push({ ...credentials });
      await openGate?.();
      return {
        async listAddresses() {
          if (state.pending) {
            state.pending.remaining -= 1;
            if (state.pending.remaining <= 0) {
              state.remote.push(state.pending.address);
              state.pending = null;
            }
          }
          if (stringAddresses) return [...state.remote];
          return {
            emailAddresses: state.remote.map((address) => ({
              emailAddress: address,
              state: "ACTIVE",
              ...(addressMetadata[address] || {}),
            })),
          };
        },
        async listDomains() {
          return { domains: domains.map((domain) => ({ name: domain, state: "ACTIVE" })) };
        },
        async validateAlias(candidate) {
          state.validations.push(candidate);
          return { available: !state.remote.includes(candidate.address) && !unavailable.has(candidate.address) };
        },
        async createAlias(candidate) {
          if (failCreateAt && state.created.length + 1 === failCreateAt) {
            throw new Error(`upstream echoed ${credentials.password}`);
          }
          state.created.push(candidate);
          if (confirmationLagReads) {
            state.pending = { address: candidate.address, remaining: confirmationLagReads };
          } else {
            state.remote.push(candidate.address);
          }
          return { emailAddress: candidate.address };
        },
        async deleteAlias({ address }) {
          state.deleted.push(address);
          state.remote = state.remote.filter((candidate) => candidate !== address);
          return { address };
        },
        async close() { state.closed += 1; },
      };
    },
  };
}

test("normalizes active Mail.com settings API address and domain collections", () => {
  assert.deepEqual(normalizeRemoteMailcomAddresses({ mailaddresslist: [
    { localPart: "Owner", domain: { name: "techie.com" }, state: "ACTIVE" },
    { emailAddress: "Worker@Mail.com", status: "ENABLED" },
    { address: "disabled@email.com", state: "DISABLED" },
  ] }), ["owner@techie.com", "worker@mail.com"]);
  assert.deepEqual(normalizeRemoteMailcomDomains({ content: [
    { name: "MAIL.COM", state: "ACTIVE" },
    { domain: "techie.com", status: "ENABLED" },
    { name: "gmail.com", state: "ACTIVE" },
  ] }), ["mail.com", "techie.com"]);
});

test("polls the official address list after create without submitting the same alias twice", async (t) => {
  const { db, mailcom, account } = context(t);
  const adapter = fakeAdapter({
    initial: [account.email, ...Array.from({ length: 8 }, (_, index) => `existing${index}@mail.com`)],
    confirmationLagReads: 3,
  });
  const waits = [];
  const service = new MailcomAliasAutomationService({
    db,
    mailcom,
    adapter,
    randomBytesFn: randomSequence(),
    confirmationAttempts: 4,
    confirmationIntervalMs: 5,
    sleepFn: async (milliseconds) => { waits.push(milliseconds); },
  });
  const result = await service.autoCreate(account.id);
  assert.equal(result.created, 1);
  assert.equal(result.total, 10);
  assert.equal(adapter.state.created.length, 1);
  assert.deepEqual(waits, [5, 5]);
});

function apiResponse(status, data, { invalidJson = false } = {}) {
  return {
    status() { return status; },
    ok() { return status >= 200 && status < 300; },
    async json() {
      if (invalidJson) throw new SyntaxError("invalid json");
      return data;
    },
  };
}

test("Mail.com settings session sends the captured in-memory authorization with exact official API payloads", async () => {
  const calls = [];
  const responses = [
    apiResponse(200, { mailaddresslist: [{ address: "mother@techie.com", state: "ACTIVE" }] }),
    apiResponse(200, { domains: [{ domain: "techie.com", categories: ["MAILCOM"] }] }),
    apiResponse(200, {}),
    apiResponse(200, { "taken@techie.com": "ILLEGAL_LOCALPART" }),
    apiResponse(201, undefined, { invalidJson: true }),
    apiResponse(204, null),
  ];
  let contextClosed = 0;
  let browserClosed = 0;
  const context = {
    request: {
      async fetch(url, options) {
        calls.push({ url, options });
        return responses.shift();
      },
    },
    async close() { contextClosed += 1; },
  };
  const browser = { async close() { browserClosed += 1; } };
  const session = new MailcomSettingsApiSession({
    browser,
    context,
    authorization: "Bearer memory-only-token",
    xUiApp: "mailcom.mailset-compose/1.0.5-build.335",
  });

  assert.equal((await session.listAddresses()).mailaddresslist.length, 1);
  assert.equal((await session.listDomains()).domains[0].domain, "techie.com");
  assert.equal(await session.validateAlias({ address: "free@techie.com" }), true);
  assert.equal(await session.validateAlias({ address: "taken@techie.com" }), false);
  await session.createAlias({ address: "free@techie.com" });
  await session.deleteAlias({ address: "free+tag@techie.com" });

  assert.equal(calls[0].url, mailcomAliasSettingsEndpoints.addresses);
  assert.equal(calls[0].options.headers.Accept, "application/vnd.ui.trinity.mailaddress.list-v5+json");
  assert.equal(calls[1].url, mailcomAliasSettingsEndpoints.domains);
  assert.equal(calls[1].options.headers.Accept, "application/json");
  assert.equal(calls[2].url, mailcomAliasSettingsEndpoints.validations);
  assert.deepEqual(calls[2].options.data, ["free@techie.com"]);
  assert.equal(calls[2].options.headers["Content-Type"], "application/vnd.ui.trinity.email-address-validation-request+json");
  assert.equal(calls[2].options.headers.Accept, "application/vnd.ui.trinity.email-address-validation-response+json");
  assert.equal(calls[4].url, mailcomAliasSettingsEndpoints.create);
  assert.deepEqual(calls[4].options.data, {
    address: "free@techie.com",
    deletable: true,
    pgpEnabled: false,
    defaultSenderAddress: false,
    defaultReceiverAddress: false,
    state: "ACTIVE",
  });
  assert.equal(calls[4].options.headers.Accept, "application/vnd.ui.trinity.minimalmailaddress-v3+json");
  assert.equal(calls[4].options.headers["Content-Type"], "application/vnd.ui.trinity.minimalmailaddress-v3+json");
  assert.equal(calls[5].url, mailcomAliasSettingsEndpoints.deleteAlias("free+tag@techie.com"));
  assert.equal(
    calls[5].url,
    "https://settings-cats.mail.com/mailaccount/primary/emailAddressesRemovals/free%2Btag%40techie.com/removals?absoluteURI=false",
  );
  assert.equal(calls[5].options.method, "POST");
  assert.equal(calls[5].options.headers.Accept, "text/plain;charset=UTF-8");
  assert.equal(calls[5].options.headers["Content-Type"], "text/plain;charset=UTF-8");
  assert.equal(Object.hasOwn(calls[5].options, "data"), false);
  assert.ok(calls.every((call) => call.options.headers.Authorization === "Bearer memory-only-token"));
  assert.ok(calls.every((call) => call.options.headers["X-UI-APP"] === "mailcom.mailset-compose/1.0.5-build.335"));
  assert.equal(new Set(calls.map((call) => call.options.headers["X-Request-ID"])).size, calls.length);

  await session.close();
  assert.equal(contextClosed, 1);
  assert.equal(browserClosed, 1);
  await assert.rejects(
    () => session.listAddresses(),
    (error) => error.code === "MAILCOM_ALIAS_SESSION_CLOSED" && !error.message.includes("memory-only-token"),
  );
});

test("Playwright adapter uses a minimal isolated environment and cleans launch failures", async () => {
  const semaphore = new MailcomBrowserSemaphore();
  let launchOptions;
  let directoryModes;
  let serverClosed = 0;
  const browserServer = {
    wsEndpoint() { return "ws://127.0.0.1/fake"; },
    async close() { serverClosed += 1; },
    async kill() {},
    process() { return { kill() {} }; },
  };
  const chromiumLauncher = {
    async launchServer(options) {
      launchOptions = options;
      directoryModes = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"]
        .map((key) => fs.statSync(options.env[key]).mode & 0o777);
      return browserServer;
    },
    async connect() { throw new Error("connect failed"); },
  };
  const adapter = new MailcomAliasPlaywrightAdapter({
    chromiumLauncher,
    browserSemaphore: semaphore,
    browserExecutable: "/usr/bin/google-chrome",
    cleanupTimeoutMs: 100,
  });
  await assert.rejects(
    () => adapter.open({ username: "mother@techie.com", password: PASSWORD }),
    (error) => error.code === "MAILCOM_ALIAS_BROWSER_FAILED"
      && !error.message.includes(PASSWORD),
  );
  assert.equal(launchOptions.args.includes("--no-sandbox"), false);
  assert.equal(launchOptions.chromiumSandbox, true);
  assert.ok(launchOptions.args.includes("--disable-breakpad"));
  assert.ok(launchOptions.args.includes("--disable-crash-reporter"));
  assert.deepEqual(directoryModes, [0o700, 0o700, 0o700, 0o700]);
  assert.equal(Object.hasOwn(launchOptions.env, "DATA_ENCRYPTION_KEY"), false);
  assert.ok(Object.keys(launchOptions.env).every((key) => [
    "PATH", "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "LANG", "TZ",
  ].includes(key)));
  assert.equal(fs.existsSync(path.dirname(launchOptions.env.HOME)), false);
  assert.equal(serverClosed, 1);
  assert.equal(semaphore.active, 0);
});

test("browser cleanup has a deadline, force-kills a stuck process, clears secrets, and releases the semaphore", async () => {
  const semaphore = new MailcomBrowserSemaphore();
  const release = await semaphore.acquire({ limit: 1, timeoutMs: 100 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-mailcom-close-test-"));
  let killed = 0;
  const session = new MailcomSettingsApiSession({
    context: { request: {}, close: () => new Promise(() => {}) },
    browser: { close: async () => {} },
    browserServer: {
      close: async () => {},
      async kill() { killed += 1; },
      process() { return { kill() { killed += 1; } }; },
    },
    authorization: "Bearer must-be-cleared",
    xUiApp: "mailcom.test",
    sessionRoot: root,
    semaphoreRelease: release,
    cleanupTimeoutMs: 10,
  });
  await session.close();
  assert.equal(killed, 1);
  assert.equal(session.authorization, "");
  assert.equal(session.xUiApp, "");
  assert.equal(session.context, null);
  assert.equal(session.browser, null);
  assert.equal(session.browserServer, null);
  assert.equal(fs.existsSync(root), false);
  assert.equal(semaphore.active, 0);
  await session.close();
  assert.equal(killed, 1);
});

test("global browser semaphore waits or returns one stable busy error", async () => {
  const semaphore = new MailcomBrowserSemaphore();
  const firstRelease = await semaphore.acquire({ limit: 1, timeoutMs: 100 });
  const waiting = semaphore.acquire({ limit: 1, timeoutMs: 100 });
  assert.equal(semaphore.queue.length, 1);
  firstRelease();
  const waitedRelease = await waiting;
  assert.equal(semaphore.active, 1);
  waitedRelease();

  const busyRelease = await semaphore.acquire({ limit: 1, timeoutMs: 100 });
  await assert.rejects(
    () => semaphore.acquire({ limit: 1, timeoutMs: 10 }),
    (error) => error.status === 429 && error.code === "MAILCOM_ALIAS_BROWSER_BUSY",
  );
  busyRelease();
  const secondRelease = await semaphore.acquire({ limit: 1, timeoutMs: 100 });
  assert.equal(semaphore.active, 1);
  secondRelease();
  assert.equal(semaphore.active, 0);
});

test("decrypts saved credentials, fills the official account to ten, syncs each alias, and is idempotent", async (t) => {
  const { db, mailcom, account } = context(t);
  const adapter = fakeAdapter({ initial: [account.email, "existing@mail.com"] });
  const service = new MailcomAliasAutomationService({
    db,
    mailcom,
    adapter,
    randomBytesFn: randomSequence(),
  });

  const result = await service.autoCreate(account.id);
  assert.equal(result.status, "completed");
  assert.equal(result.existing, 1);
  assert.equal(result.created, 8);
  assert.equal(result.total, 10);
  assert.equal(result.account.mailcom_aliases, 9);
  assert.equal(result.account.official_used, 10);
  assert.equal(adapter.state.opens.length, 1);
  assert.equal(adapter.state.opens[0].username, account.email);
  assert.equal(adapter.state.opens[0].password, PASSWORD);
  assert.equal(adapter.state.closed, 1);
  assert.equal(adapter.state.created.length, 8);
  assert.ok(adapter.state.created.every((item) => item.domain === "techie.com"));
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM addresses
    WHERE account_id = ? AND kind = 'official' AND status = 'active'
      AND strategy = ? AND remote_confirmed = 1
  `).get(account.id, MAILCOM_ALIAS_STRATEGY).count, 9);

  const second = await service.autoCreate(account.id);
  assert.equal(second.status, "already_full");
  assert.equal(second.created, 0);
  assert.equal(second.existing, 9);
  assert.equal(second.total, 10);
  assert.equal(adapter.state.created.length, 8);
  assert.equal(adapter.state.closed, 2);
  assert.doesNotMatch(JSON.stringify(second), new RegExp(PASSWORD));
});

test("verifyAuthorization uses saved credentials for a read-only address and domain check", async (t) => {
  const { db, mailcom, account } = context(t);
  const localAlias = importMailcomAliases(db, account, ["kept-local@mail.com"])
    .find((item) => item.address === "kept-local@mail.com");
  const calls = {
    opens: [],
    addressReads: 0,
    domainReads: 0,
    mutations: [],
    closed: 0,
  };
  const adapter = {
    async open(credentials) {
      calls.opens.push({ ...credentials });
      return {
        async listAddresses() {
          calls.addressReads += 1;
          return {
            emailAddresses: [
              { emailAddress: account.email.toUpperCase(), state: "ACTIVE" },
              { emailAddress: "ReadOnly@Mail.com", state: "ACTIVE" },
            ],
          };
        },
        async listDomains() {
          calls.domainReads += 1;
          return { domains: [
            { name: "MAIL.COM", state: "ACTIVE" },
            { name: "techie.com", state: "ACTIVE" },
          ] };
        },
        async validateAlias(candidate) {
          calls.mutations.push(["validate", candidate]);
          throw new Error("verifyAuthorization must not validate an alias");
        },
        async createAlias(candidate) {
          calls.mutations.push(["create", candidate]);
          throw new Error("verifyAuthorization must not create an alias");
        },
        async deleteAlias(candidate) {
          calls.mutations.push(["delete", candidate]);
          throw new Error("verifyAuthorization must not delete an alias");
        },
        async close() { calls.closed += 1; },
      };
    },
  };
  const service = new MailcomAliasAutomationService({ db, mailcom, adapter });

  const result = await service.verifyAuthorization(account.id);

  assert.deepEqual(calls.opens, [{
    username: account.email,
    password: PASSWORD,
    accountId: account.id,
  }]);
  assert.equal(calls.addressReads, 1);
  assert.equal(calls.domainReads, 1);
  assert.deepEqual(calls.mutations, []);
  assert.equal(calls.closed, 1);
  assert.deepEqual(result.addresses, [account.email, "readonly@mail.com"]);
  assert.deepEqual(result.domains, ["mail.com", "techie.com"]);
  assert.equal(result.account.id, account.id);
  assert.deepEqual(
    db.prepare("SELECT status, remote_confirmed FROM addresses WHERE id = ?").get(localAlias.id),
    { status: "active", remote_confirmed: 1 },
  );
});

test("verifyAuthorization closes a failed read-only session and never leaks the saved password", async (t) => {
  const { db, mailcom, account } = context(t);
  let closed = 0;
  const adapter = {
    async open(credentials) {
      return {
        async listAddresses() {
          throw Object.assign(
            new Error(`upstream rejected ${credentials.password} with Bearer private-web-token`),
            { status: 409, code: "MAILCOM_ALIAS_SESSION_EXPIRED" },
          );
        },
        async listDomains() {
          return { domains: [{ name: "mail.com", state: "ACTIVE" }] };
        },
        async close() { closed += 1; },
      };
    },
  };
  const service = new MailcomAliasAutomationService({ db, mailcom, adapter });
  let received;

  await assert.rejects(
    () => service.verifyAuthorization(account.id),
    (error) => {
      received = error;
      return error.code === "MAILCOM_ALIAS_SESSION_EXPIRED"
        && error.message.includes("[REDACTED]")
        && !error.message.includes(PASSWORD)
        && !error.message.includes("private-web-token");
    },
  );

  assert.equal(closed, 1);
  assert.doesNotMatch(JSON.stringify(received), new RegExp(`${PASSWORD}|private-web-token`, "i"));
  assert.doesNotMatch(
    JSON.stringify(db.prepare("SELECT detail, metadata FROM audit_log WHERE account_id = ?").all(account.id)),
    new RegExp(`${PASSWORD}|private-web-token`, "i"),
  );
});

test("prepareAccount validates the requested active suffix and fills every missing slot with it", async (t) => {
  const { db, mailcom, account } = context(t);
  const existing = Array.from({ length: 8 }, (_, index) => `prepared${index}@mail.com`);
  const adapter = fakeAdapter({
    initial: [account.email, ...existing],
    domains: ["mail.com", "email.com", "techie.com"],
  });
  const service = new MailcomAliasAutomationService({
    db,
    mailcom,
    adapter,
    randomBytesFn: randomSequence(),
  });

  const result = await service.prepareAccount(account.id, { domain: "@EMAIL.COM" });
  assert.equal(result.domain, "email.com");
  assert.deepEqual(result.domains, ["mail.com", "email.com", "techie.com"]);
  assert.deepEqual(result.counts, {
    existing: 8,
    created: 1,
    aliases: 9,
    total: 10,
    remaining: 0,
    limit: 10,
  });
  assert.equal(result.items.length, 10);
  assert.equal(result.account.mailcom_aliases, 9);
  assert.equal(adapter.state.created.length, 1);
  assert.equal(adapter.state.created[0].domain, "email.com");
  assert.match(adapter.state.created[0].address, /@email\.com$/);
  const autoResult = await service.autoCreate(account.id, { domain: "email.com" });
  assert.equal(autoResult.status, "already_full");
  assert.equal(autoResult.domain, "email.com");
  assert.equal(adapter.state.closed, 2);
});

test("prepareAccount accepts random and chooses every new alias from the remote active domains", async (t) => {
  const { db, mailcom, account } = context(t);
  const existing = Array.from({ length: 6 }, (_, index) => `random-existing${index}@mail.com`);
  const activeDomains = ["dutchmail.com", "email.com", "techie.com"];
  const adapter = fakeAdapter({
    initial: [account.email, ...existing],
    domains: activeDomains,
  });
  let domainSample = 0;
  const service = new MailcomAliasAutomationService({
    db,
    mailcom,
    adapter,
    randomBytesFn: randomSequence(),
    randomIntFn: (maximum) => domainSample++ % maximum,
  });

  const result = await service.prepareAccount(account.id, { domain: "random" });

  assert.equal(result.counts.created, 3);
  assert.equal(adapter.state.created.length, 3);
  assert.ok(adapter.state.created.every((candidate) => activeDomains.includes(candidate.domain)));
  assert.ok(adapter.state.created.every((candidate) => (
    candidate.address.endsWith(`@${candidate.domain}`) && candidate.domain !== "random"
  )));
  assert.ok(new Set(adapter.state.created.map((candidate) => candidate.domain)).size > 1);
  assert.deepEqual(result.domains, activeDomains);
});

test("prepareAccount recognizes a verified Mail.com login domain outside the alias-domain catalog", async (t) => {
  const { db, mailcom, account } = context(t, "mother@legacy-login.example");
  const existing = Array.from({ length: 8 }, (_, index) => `legacy${index}@mail.com`);
  const adapter = fakeAdapter({
    initial: [account.email, ...existing],
    domains: ["mail.com", "email.com"],
  });
  const service = new MailcomAliasAutomationService({
    db,
    mailcom,
    adapter,
    randomBytesFn: randomSequence(),
  });

  const result = await service.prepareAccount(account.id, { domain: "email.com" });
  assert.equal(result.counts.total, 10);
  assert.equal(result.counts.aliases, 9);
  assert.equal(result.account.mailcom_aliases, 9);
  assert.equal(adapter.state.created[0].domain, "email.com");
});

test("recycleAlias removes one remote alias and creates a confirmed replacement on the requested suffix", async (t) => {
  const { db, mailcom, account } = context(t);
  const removed = "replace-me@mail.com";
  const aliases = [
    removed,
    ...Array.from({ length: 8 }, (_, index) => `keep${index}@mail.com`),
  ];
  importMailcomAliases(db, account, aliases);
  const adapter = fakeAdapter({
    initial: [account.email, ...aliases],
    domains: ["mail.com", "email.com", "techie.com"],
    stringAddresses: true,
  });
  const service = new MailcomAliasAutomationService({
    db,
    mailcom,
    adapter,
    randomBytesFn: randomSequence(),
  });

  const replacementAddress = "stable-replacement@email.com";
  const result = await service.recycleAlias(account.id, {
    address: removed,
    domain: "email.com",
    replacementAddress,
  });
  assert.equal(result.removed, removed);
  assert.equal(result.created, replacementAddress);
  assert.equal(result.item.address, result.created);
  assert.equal(result.item.status, "active");
  assert.equal(result.account.mailcom_aliases, 9);
  assert.equal(result.removed_remote, true);
  assert.equal(result.created_remote, true);
  assert.deepEqual(adapter.state.deleted, [removed]);
  assert.equal(adapter.state.created.length, 1);
  assert.equal(adapter.state.validations[0].address, replacementAddress);
  assert.equal(adapter.state.created[0].domain, "email.com");
  assert.equal(adapter.state.remote.length, 10);
  assert.equal(adapter.state.closed, 1);
  assert.deepEqual(
    db.prepare("SELECT status, remote_confirmed FROM addresses WHERE account_id = ? AND address = ? COLLATE NOCASE")
      .get(account.id, removed),
    { status: "disabled", remote_confirmed: 0 },
  );
});

test("recycleAlias accepts random with a persisted replacement on an active remote suffix", async (t) => {
  const { db, mailcom, account } = context(t);
  const removed = "random-replace-me@mail.com";
  const aliases = [
    removed,
    ...Array.from({ length: 8 }, (_, index) => `random-keep${index}@mail.com`),
  ];
  importMailcomAliases(db, account, aliases);
  const adapter = fakeAdapter({
    initial: [account.email, ...aliases],
    domains: ["dutchmail.com", "email.com", "techie.com"],
  });
  const service = new MailcomAliasAutomationService({ db, mailcom, adapter });
  const replacementAddress = "persisted-random-replacement@email.com";

  const result = await service.recycleAlias(account.id, {
    address: removed,
    domain: "random",
    replacementAddress,
  });

  assert.equal(result.created, replacementAddress);
  assert.deepEqual(adapter.state.validations.map((candidate) => candidate.address), [replacementAddress]);
  assert.equal(adapter.state.created[0].domain, "email.com");
  assert.deepEqual(adapter.state.deleted, [removed]);
});

test("recycleAlias validates a stable replacement before deleting the old alias", async (t) => {
  const { db, mailcom, account } = context(t);
  const removed = "keep-when-unavailable@mail.com";
  const replacementAddress = "unavailable@email.com";
  const aliases = [
    removed,
    ...Array.from({ length: 8 }, (_, index) => `unchanged${index}@mail.com`),
  ];
  importMailcomAliases(db, account, aliases);
  const adapter = fakeAdapter({
    initial: [account.email, ...aliases],
    domains: ["mail.com", "email.com", "techie.com"],
    unavailableAddresses: [replacementAddress],
  });
  const service = new MailcomAliasAutomationService({ db, mailcom, adapter });

  await assert.rejects(
    () => service.recycleAlias(account.id, {
      address: removed,
      domain: "email.com",
      replacementAddress,
    }),
    (error) => error.status === 409 && error.code === "MAILCOM_ALIAS_REPLACEMENT_UNAVAILABLE",
  );
  assert.deepEqual(adapter.state.validations.map((item) => item.address), [replacementAddress]);
  assert.deepEqual(adapter.state.deleted, []);
  assert.deepEqual(adapter.state.created, []);
  assert.equal(adapter.state.remote.includes(removed), true);
  assert.equal(adapter.state.closed, 1);
  assert.deepEqual(
    db.prepare("SELECT status, remote_confirmed FROM addresses WHERE account_id = ? AND address = ? COLLATE NOCASE")
      .get(account.id, removed),
    { status: "active", remote_confirmed: 1 },
  );
});

test("recycleAlias idempotently replenishes an alias that is already absent remotely", async (t) => {
  const { db, mailcom, account } = context(t);
  const removed = "already-gone@mail.com";
  const retained = Array.from({ length: 8 }, (_, index) => `retained${index}@mail.com`);
  importMailcomAliases(db, account, [removed, ...retained]);
  const adapter = fakeAdapter({
    initial: [account.email, ...retained],
    domains: ["mail.com", "email.com", "techie.com"],
  });
  const service = new MailcomAliasAutomationService({
    db,
    mailcom,
    adapter,
    randomBytesFn: randomSequence(),
  });

  const result = await service.recycleAlias(account.id, { address: removed, domain: "email.com" });
  assert.equal(result.removed, removed);
  assert.equal(result.removed_remote, false);
  assert.match(result.created, /@email\.com$/);
  assert.deepEqual(adapter.state.deleted, []);
  assert.equal(adapter.state.remote.length, 10);
  assert.deepEqual(
    db.prepare("SELECT status, remote_confirmed FROM addresses WHERE account_id = ? AND address = ? COLLATE NOCASE")
      .get(account.id, removed),
    { status: "disabled", remote_confirmed: 0 },
  );
});

test("recycleAlias adopts a persisted replacement after a crash without consuming another slot", async (t) => {
  const { db, mailcom, account } = context(t);
  const removed = "crashed-old@mail.com";
  const replacementAddress = "crash-stable@email.com";
  const retained = Array.from({ length: 8 }, (_, index) => `crash-retained${index}@mail.com`);
  importMailcomAliases(db, account, [removed, ...retained]);
  const adapter = fakeAdapter({
    initial: [account.email, replacementAddress, ...retained],
    domains: ["mail.com", "email.com", "techie.com"],
  });
  const service = new MailcomAliasAutomationService({ db, mailcom, adapter });

  const result = await service.recycleAlias(account.id, {
    address: removed,
    domain: "email.com",
    replacementAddress,
  });
  assert.equal(result.removed, removed);
  assert.equal(result.created, replacementAddress);
  assert.equal(result.removed_remote, false);
  assert.equal(result.created_remote, false);
  assert.equal(result.item.address, replacementAddress);
  assert.equal(result.account.mailcom_aliases, 9);
  assert.deepEqual(adapter.state.deleted, []);
  assert.deepEqual(adapter.state.created, []);
  assert.deepEqual(adapter.state.validations, []);
  assert.equal(adapter.state.remote.length, 10);
  assert.deepEqual(
    db.prepare("SELECT status, remote_confirmed FROM addresses WHERE account_id = ? AND address = ? COLLATE NOCASE")
      .get(account.id, removed),
    { status: "disabled", remote_confirmed: 0 },
  );
});

test("recycleAlias refuses remote aliases marked non-deletable, default, or primary", async (t) => {
  const cases = [
    ["deletable false", { deletable: false }],
    ["default sender", { defaultSenderAddress: true }],
    ["default receiver", { defaultReceiverAddress: true }],
    ["primary type", { type: "PRIMARY" }],
    ["default type", { addressType: "DEFAULT" }],
  ];
  for (const [name, metadata] of cases) {
    await t.test(name, async (subtest) => {
      const { db, mailcom, account } = context(subtest);
      const address = "remote-protected@mail.com";
      importMailcomAliases(db, account, [address]);
      const adapter = fakeAdapter({
        initial: [account.email, address],
        domains: ["mail.com", "email.com", "techie.com"],
        addressMetadata: { [address]: metadata },
      });
      const service = new MailcomAliasAutomationService({ db, mailcom, adapter });

      await assert.rejects(
        () => service.recycleAlias(account.id, { address, domain: "email.com" }),
        (error) => error.status === 409 && error.code === "MAILCOM_ALIAS_REMOTE_PROTECTED",
      );
      assert.deepEqual(adapter.state.deleted, []);
      assert.deepEqual(adapter.state.created, []);
      assert.equal(adapter.state.closed, 1);
    });
  }
});

test("recycleAlias protects the mother address, active registrations, and pickup inventory", async (t) => {
  const { db, mailcom, account } = context(t);
  const protectedAddress = "protected-recycle@mail.com";
  const target = importMailcomAliases(db, account, [protectedAddress])
    .find((item) => item.address === protectedAddress);
  const now = nowIso();
  const jobId = Number(db.prepare(`
    INSERT INTO registration_jobs (
      account_id, address_id, base_address_id, email, status, stage, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'running', 'running', ?, ?)
  `).run(account.id, target.id, target.id, target.address, now, now).lastInsertRowid);
  const pickupItems = [];
  const pickup = {
    registrationProtectionEnabled() { return true; },
    async listStatuses() { return { items: [...pickupItems] }; },
  };
  const adapter = fakeAdapter({ initial: [account.email, protectedAddress] });
  const service = new MailcomAliasAutomationService({ db, mailcom, adapter, pickup });

  await assert.rejects(
    () => service.recycleAlias(account.id, { address: account.email, domain: "mail.com" }),
    (error) => error.status === 409 && error.code === "MAILCOM_ALIAS_PRIMARY_PROTECTED",
  );
  await assert.rejects(
    () => service.recycleAlias(account.id, { address: protectedAddress, domain: "mail.com" }),
    (error) => error.status === 409 && error.code === "MAILCOM_ALIAS_RECYCLE_PROTECTED",
  );
  db.prepare("UPDATE registration_jobs SET status = 'cancelled', updated_at = ? WHERE id = ?")
    .run(nowIso(), jobId);
  pickupItems.push({ email: protectedAddress, status: "SOLD" });
  await assert.rejects(
    () => service.recycleAlias(account.id, { address: protectedAddress, domain: "mail.com" }),
    (error) => error.status === 409 && error.code === "MAILCOM_ALIAS_RECYCLE_PROTECTED",
  );
  assert.equal(adapter.state.opens.length, 0);
  assert.deepEqual(adapter.state.deleted, []);
});

test("recycleAlias directly rejects an alias with a successful agreement even after its attempt was cancelled", async (t) => {
  const { db, mailcom, account } = context(t);
  const protectedAddress = "agreement-protected@mail.com";
  const target = importMailcomAliases(db, account, [protectedAddress])
    .find((item) => item.address === protectedAddress);
  const at = nowIso();
  const pipelineId = "mailcom-alias-agreement-protection";
  db.prepare(`
    INSERT INTO mailcom_registration_pipelines (
      id, request_id, request_fingerprint, domain, status, stage, concurrency,
      browser_mode, proxy_selection, payment_link_country, recycle_succeeded,
      account_count, slot_count, created_at, updated_at, finished_at
    ) VALUES (?, ?, 'fixture-agreement-protection', 'mail.com', 'completed', 'completed', 1,
      'headless', 'auto', 'DE', 0, 1, 1, ?, ?, ?)
  `).run(pipelineId, `${pipelineId}-request`, at, at, at);
  const itemId = Number(db.prepare(`
    INSERT INTO mailcom_registration_pipeline_items (
      pipeline_id, account_id, source_email, slot_key, slot_kind,
      initial_address_id, initial_email, current_address_id, current_email,
      status, stage, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, 'official', ?, ?, ?, ?, 'completed', 'completed', ?, ?, ?)
  `).run(
    pipelineId,
    account.id,
    account.email,
    `official:${target.id}`,
    target.id,
    target.address,
    target.id,
    target.address,
    at,
    at,
    at,
  ).lastInsertRowid);
  db.prepare(`
    INSERT INTO mailcom_registration_pipeline_attempts (
      pipeline_id, item_id, attempt_number, address_id, email, status, stage,
      outcome, registration_status, link_status, agreement_status, recycle_status,
      agreement_finished_at, finished_at, created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, 'cancelled', 'cancelled', 'cancelled',
      'succeeded', 'succeeded', 'succeeded', 'pending', ?, ?, ?, ?)
  `).run(pipelineId, itemId, target.id, target.address, at, at, at, at);

  const adapter = fakeAdapter({ initial: [account.email, protectedAddress] });
  const service = new MailcomAliasAutomationService({ db, mailcom, adapter });
  await assert.rejects(
    () => service.recycleAlias(account.id, {
      address: protectedAddress,
      domain: "mail.com",
      replacementAddress: "must-not-be-created@mail.com",
    }),
    (error) => error.status === 409 && error.code === "MAILCOM_ALIAS_AGREEMENT_PROTECTED",
  );

  assert.equal(adapter.state.opens.length, 0);
  assert.deepEqual(adapter.state.deleted, []);
  assert.deepEqual(adapter.state.created, []);
  assert.equal(db.prepare("SELECT status FROM addresses WHERE id = ?").get(target.id).status, "active");
});

test("recycleAlias rejects a pickup publish that completes during its inventory check", async (t) => {
  const { db, mailcom, account } = context(t);
  const address = "pickup-race@mail.com";
  const target = importMailcomAliases(db, account, [address])
    .find((item) => item.address === address);
  const adapter = fakeAdapter({ initial: [account.email, address] });
  let pickup;
  let publishCount = 0;
  const response = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    async json() { return data; },
  });
  const fetchFn = async (_url, options = {}) => {
    if (options.method === "POST") {
      publishCount += 1;
      const body = JSON.parse(options.body);
      return response({
        items: body.items.map((item, index) => ({
          id: index + 1,
          email: item.email,
          pickup_url: `https://pickup.example.test/${index + 1}`,
          delivery_line: `${item.email} https://pickup.example.test/${index + 1}`,
        })),
      }, 201);
    }
    const staleSnapshot = { items: [] };
    if (!publishCount) await pickup.importSourceAddresses({ ids: [target.id] });
    return response(staleSnapshot);
  };
  pickup = new PickupService({
    db,
    registration: {},
    password: "secret",
    fetchFn,
  });
  const service = new MailcomAliasAutomationService({ db, mailcom, adapter, pickup });

  await assert.rejects(
    () => service.recycleAlias(account.id, { address, domain: "mail.com" }),
    (error) => error.status === 409 && error.code === "MAILCOM_ALIAS_RECYCLE_PROTECTED",
  );
  assert.equal(publishCount, 1);
  assert.deepEqual(pickup.publishingState(address), { active: false, version: 2 });
  assert.equal(adapter.state.opens.length, 0);
  assert.deepEqual(adapter.state.deleted, []);
});

test("recycleAlias synchronizes the confirmed deletion when replacement creation fails", async (t) => {
  const { db, mailcom, account } = context(t);
  const removed = "failed-replacement@mail.com";
  const aliases = [
    removed,
    ...Array.from({ length: 8 }, (_, index) => `survivor${index}@mail.com`),
  ];
  importMailcomAliases(db, account, aliases);
  const adapter = fakeAdapter({
    initial: [account.email, ...aliases],
    domains: ["mail.com", "email.com", "techie.com"],
    failCreateAt: 1,
  });
  const service = new MailcomAliasAutomationService({
    db,
    mailcom,
    adapter,
    randomBytesFn: randomSequence(),
  });

  await assert.rejects(
    () => service.recycleAlias(account.id, { address: removed, domain: "email.com" }),
    (error) => error.code === "MAILCOM_ALIAS_AUTOMATION_FAILED"
      && error.message.includes("[REDACTED]")
      && !error.message.includes(PASSWORD),
  );
  assert.deepEqual(adapter.state.deleted, [removed]);
  assert.equal(adapter.state.created.length, 0);
  assert.equal(adapter.state.remote.length, 9);
  assert.equal(adapter.state.closed, 1);
  assert.deepEqual(
    db.prepare("SELECT status, remote_confirmed FROM addresses WHERE account_id = ? AND address = ? COLLATE NOCASE")
      .get(account.id, removed),
    { status: "disabled", remote_confirmed: 0 },
  );
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM addresses
    WHERE account_id = ? AND strategy = ? AND status = 'active' AND remote_confirmed = 1
  `).get(account.id, MAILCOM_ALIAS_STRATEGY).count, 8);
});

test("uses an account lock and returns a stable public error code for concurrent requests", async (t) => {
  const { db, mailcom, account } = context(t);
  let release;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = fakeAdapter({
    initial: [account.email, ...Array.from({ length: 9 }, (_, index) => `full${index}@mail.com`)],
    openGate: async () => { entered(); await gate; },
  });
  const service = new MailcomAliasAutomationService({ db, mailcom, adapter });
  const first = service.autoCreate(account.id);
  await enteredPromise;
  await assert.rejects(
    () => service.autoCreate(account.id),
    (error) => error.status === 409 && error.code === "MAILCOM_ALIAS_CREATION_IN_PROGRESS",
  );
  release();
  assert.equal((await first).status, "already_full");
});

test("keeps a remotely-created alias after a later failure and redacts the saved password", async (t) => {
  const { db, mailcom, account } = context(t);
  const adapter = fakeAdapter({ initial: [account.email], failCreateAt: 2 });
  const service = new MailcomAliasAutomationService({
    db,
    mailcom,
    adapter,
    randomBytesFn: randomSequence(),
  });
  await assert.rejects(
    () => service.autoCreate(account.id),
    (error) => error.code === "MAILCOM_ALIAS_AUTOMATION_FAILED"
      && !error.message.includes(PASSWORD)
      && error.message.includes("[REDACTED]")
      && error.partial?.created === 1
      && error.partial?.total === 2
      && error.partial?.existing === 0
      && error.account?.mailcom_aliases === 1
      && error.items?.length === 2,
  );
  assert.equal(adapter.state.created.length, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM addresses
    WHERE account_id = ? AND strategy = ? AND status = 'active' AND remote_confirmed = 1
  `).get(account.id, MAILCOM_ALIAS_STRATEGY).count, 1);
  const audits = db.prepare("SELECT detail, metadata FROM audit_log WHERE account_id = ?").all(account.id);
  assert.doesNotMatch(JSON.stringify(audits), new RegExp(PASSWORD));
  assert.equal(adapter.state.closed, 1);
});

test("reconciles harmless stale local aliases before remote creation without hitting the local quota", async (t) => {
  const { db, mailcom, account } = context(t);
  const stale = Array.from({ length: 9 }, (_, index) => `stale${index}@mail.com`);
  importMailcomAliases(db, account, stale);
  const remote = Array.from({ length: 9 }, (_, index) => `remote${index}@techie.com`);
  const adapter = fakeAdapter({ initial: [account.email, ...remote] });
  const service = new MailcomAliasAutomationService({ db, mailcom, adapter });

  const result = await service.autoCreate(account.id);
  assert.equal(result.status, "already_full");
  assert.equal(result.created, 0);
  assert.equal(result.total, 10);
  assert.equal(adapter.state.created.length, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM addresses
    WHERE account_id = ? AND strategy = ? AND status = 'active'
  `).get(account.id, MAILCOM_ALIAS_STRATEGY).count, 9);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM addresses
    WHERE account_id = ? AND strategy = ? AND status = 'disabled' AND remote_confirmed = 0
  `).get(account.id, MAILCOM_ALIAS_STRATEGY).count, 9);
  assert.ok(db.prepare(`
    SELECT 1 FROM audit_log
    WHERE account_id = ? AND title = '清理过期 Mail.com 本地别名映射'
  `).get(account.id));
});

test("blocks stale-local reconciliation before create when an alias has an active registration", async (t) => {
  const { db, mailcom, account } = context(t);
  const stale = importMailcomAliases(db, account, ["protected@mail.com"])
    .find((item) => item.address === "protected@mail.com");
  const now = nowIso();
  db.prepare(`
    INSERT INTO registration_jobs (
      account_id, address_id, base_address_id, email, status, stage, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'running', 'running', ?, ?)
  `).run(account.id, stale.id, stale.id, stale.address, now, now);
  const adapter = fakeAdapter({ initial: [account.email, "official@techie.com"] });
  const service = new MailcomAliasAutomationService({ db, mailcom, adapter });

  await assert.rejects(
    () => service.autoCreate(account.id),
    (error) => error.status === 409 && error.code === "MAILCOM_ALIAS_RECONCILE_CONFLICT",
  );
  assert.equal(adapter.state.created.length, 0);
  assert.deepEqual(
    db.prepare("SELECT status, remote_confirmed FROM addresses WHERE id = ?").get(stale.id),
    { status: "active", remote_confirmed: 1 },
  );
});

test("blocks stale-local reconciliation before create when an alias remains in pickup inventory", async (t) => {
  const { db, mailcom, account } = context(t);
  const stale = importMailcomAliases(db, account, ["listed@mail.com"])
    .find((item) => item.address === "listed@mail.com");
  const adapter = fakeAdapter({ initial: [account.email, "official@techie.com"] });
  const pickup = {
    registrationProtectionEnabled() { return true; },
    async listStatuses() { return { items: [{ email: stale.address, status: "SOLD" }] }; },
  };
  const service = new MailcomAliasAutomationService({ db, mailcom, adapter, pickup });

  await assert.rejects(
    () => service.autoCreate(account.id),
    (error) => error.status === 409 && error.code === "MAILCOM_ALIAS_RECONCILE_CONFLICT",
  );
  assert.equal(adapter.state.created.length, 0);
  assert.equal(db.prepare("SELECT status FROM addresses WHERE id = ?").get(stale.id).status, "active");
});

test("HTTP partial failure response exposes only safe progress, account, and address fields", async (t) => {
  const { db, mailcom, account } = context(t);
  const adapter = fakeAdapter({ initial: [account.email], failCreateAt: 2 });
  const mailcomAliases = new MailcomAliasAutomationService({
    db,
    mailcom,
    adapter,
    randomBytesFn: randomSequence(),
  });
  const runtime = createApp({ db, mailcom, mailcomAliases });
  const originalConsoleError = console.error;
  let response;
  try {
    console.error = () => {};
    response = await jsonRequest(runtime.app, `/api/accounts/${account.id}/mailcom-aliases/auto-create`, {
      method: "POST",
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(response.response.status, 502);
  assert.equal(response.body.code, "MAILCOM_ALIAS_AUTOMATION_FAILED");
  assert.deepEqual(response.body.partial, { created: 1, total: 2, existing: 0 });
  assert.equal(response.body.account.mailcom_aliases, 1);
  assert.equal(response.body.items.length, 2);
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(`${PASSWORD}|Bearer|password|token`, "i"));
});

test("HTTP auto-create route exposes result counts and Mail.com error codes", async (t) => {
  const { db, mailcom, account } = context(t);
  const adapter = fakeAdapter({
    initial: [account.email, ...Array.from({ length: 9 }, (_, index) => `ready${index}@mail.com`)],
    domains: ["mail.com", "email.com"],
  });
  const mailcomAliases = new MailcomAliasAutomationService({ db, mailcom, adapter });
  const runtime = createApp({ db, mailcom, mailcomAliases });

  const success = await jsonRequest(runtime.app, `/api/accounts/${account.id}/mailcom-aliases/auto-create`, {
    method: "POST",
    body: JSON.stringify({ domain: "email.com" }),
  });
  assert.equal(success.response.status, 200);
  assert.deepEqual({
    existing: success.body.existing,
    created: success.body.created,
    total: success.body.total,
  }, { existing: 9, created: 0, total: 10 });
  assert.equal(success.body.domain, "email.com");

  const unavailableDomain = await jsonRequest(runtime.app, `/api/accounts/${account.id}/mailcom-aliases/auto-create`, {
    method: "POST",
    body: JSON.stringify({ domain: "programmer.net" }),
  });
  assert.equal(unavailableDomain.response.status, 409);
  assert.equal(unavailableDomain.body.code, "MAILCOM_ALIAS_DOMAIN_UNAVAILABLE");

  const wrongProvider = createSourceAccount(db, { email: "other@outlook.com", provider: "microsoft" });
  const rejected = await jsonRequest(runtime.app, `/api/accounts/${wrongProvider.id}/mailcom-aliases/auto-create`, {
    method: "POST",
  });
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.code, "MAILCOM_ACCOUNT_REQUIRED");
});
