import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importMailcomAliases, persistInboxScanResult } from "../account-service.js";
import {
  mailcomDomains,
  normalizeMailcomEmail,
  normalizeMailcomLoginEmail,
} from "../address-generator.js";
import { createDatabase, createSourceAccount, nowIso, setSetting } from "../db.js";
import { createApp } from "../index.js";
import { parseMailcomAccountImport } from "../mailcom-import.js";
import { MailComImapClient } from "../mailcom-imap.js";
import { jsonRequest } from "./http-harness.js";

const PASSWORD = "mail----password-123";

function context(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-mailcom-test-"));
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

test("parses Mail.com registration-machine rows and accepts legacy login domains", () => {
  assert.equal(mailcomDomains.length, 138);
  assert.equal(normalizeMailcomEmail("Owner@GalaxyHit.com"), "owner@galaxyhit.com");
  assert.equal(normalizeMailcomEmail("Legacy@PlanetMail.com"), "");
  assert.equal(normalizeMailcomEmail("owner@gmail.com"), "");
  assert.equal(normalizeMailcomLoginEmail("Legacy@PlanetMail.com"), "legacy@planetmail.com");
  assert.equal(normalizeMailcomLoginEmail("Ocean@Pacific-Ocean.com"), "ocean@pacific-ocean.com");
  assert.deepEqual(parseMailcomAccountImport({
    content: `Legacy@PlanetMail.com----${PASSWORD}\nOcean@Pacific-Ocean.com----ocean-password`,
  }), [
    { email: "legacy@planetmail.com", password: PASSWORD },
    { email: "ocean@pacific-ocean.com", password: "ocean-password" },
  ]);
  assert.throws(
    () => parseMailcomAccountImport({ content: "not-an-email----secret-value" }),
    (error) => error.status === 400 && !String(error.message).includes("secret-value"),
  );
});

test("connects and scans Mail.com over fixed TLS while keeping the password encrypted", async (t) => {
  const { db } = context(t);
  let mode = "connect";
  let fetches = 0;
  const configurations = [];
  const rawMessage = Buffer.from([
    "From: OpenAI <noreply@openai.com>",
    "To: Alias <worker@email.com>",
    "Delivered-To: owner@planetmail.com",
    "Envelope-To: worker@email.com",
    "Subject: Your verification code is 482913",
    "Message-ID: <mailcom-test-1@example.com>",
    "Date: Tue, 22 Jul 2026 12:30:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Use 482913 to verify your account.",
  ].join("\r\n"));
  const client = new MailComImapClient({
    db,
    encryptionKey: "mailcom-test-key",
    imapFactory(config) {
      configurations.push(config);
      return {
        usable: false,
        mailbox: { uidValidity: 17n },
        async connect() {
          if (mode === "auth_failure") throw authError();
          this.usable = true;
        },
        async mailboxOpen(pathname, options) {
          assert.equal(pathname, "INBOX");
          assert.equal(options.readOnly, true);
          return { uidValidity: 17n };
        },
        async search() { return mode === "scan" ? [91] : []; },
        async fetchOne() {
          fetches += 1;
          return {
            uid: 91,
            flags: new Set(),
            internalDate: new Date("2026-07-22T12:30:00.000Z"),
            size: rawMessage.length,
            source: rawMessage,
          };
        },
        async logout() { this.usable = false; },
        close() {},
      };
    },
  });

  const connected = await client.connectAccount({ email: "owner@planetmail.com", password: PASSWORD });
  assert.equal(configurations.length, 1);
  assert.equal(configurations[0].host, "imap.mail.com");
  assert.equal(configurations[0].port, 993);
  assert.equal(configurations[0].secure, true);
  assert.equal(configurations[0].auth.user, "owner@planetmail.com");
  assert.equal(configurations[0].tls.servername, "imap.mail.com");
  assert.equal(connected.account.provider, "mailcom");
  assert.equal(connected.account.auth_mode, "password");
  assert.equal(connected.account.supports_plus_aliases, false);
  assert.equal(connected.account.supports_direct_registration, true);
  assert.equal(connected.account.supports_mailcom_aliases, true);
  assert.equal(connected.account.official_limit, 10);
  assert.equal(connected.account.oauth_connected, false);
  assert.doesNotMatch(JSON.stringify(connected), new RegExp(PASSWORD.replaceAll("-", "\\-")));

  const stored = db.prepare("SELECT * FROM mailcom_credentials WHERE account_id = ?").get(connected.account.id);
  assert.notEqual(stored.password_encrypted, PASSWORD);
  assert.equal(client.decrypt(stored.password_encrypted), PASSWORD);
  const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(connected.account.id);
  const [alias] = importMailcomAliases(db, account, ["worker@email.com"])
    .filter((item) => item.strategy === "mailcom_alias");

  mode = "scan";
  const result = await client.scanInbox(account);
  assert.equal(result.messages[0].graphMessageId, "mailcom:17:91");
  assert.deepEqual(result.messages[0].recipients, ["owner@planetmail.com", "worker@email.com"]);
  assert.equal(result.items[0].code, "482913");
  const persisted = persistInboxScanResult(db, account, result);
  assert.equal(persisted.codes.added, 1);
  const storedMessage = db.prepare("SELECT address_id, recipient_address FROM mail_messages LIMIT 1").get();
  assert.equal(storedMessage.address_id, alias.id);
  assert.equal(storedMessage.recipient_address, alias.address);
  assert.equal(db.prepare("SELECT address_id FROM verification_codes LIMIT 1").get().address_id, alias.id);
  await client.scanInbox(account);
  assert.equal(fetches, 1);

  const encryptedBeforeFailure = stored.password_encrypted;
  mode = "auth_failure";
  await assert.rejects(
    () => client.connectAccount({ accountId: account.id, email: account.email, password: "replacement-password" }),
    (error) => error.code === "MAILCOM_AUTH_FAILED" && !error.message.includes("replacement-password"),
  );
  assert.equal(db.prepare("SELECT password_encrypted FROM mailcom_credentials WHERE account_id = ?").get(account.id).password_encrypted, encryptedBeforeFailure);
});

test("explains Mail.com IMAP authentication failures without persisting the attempted account", async (t) => {
  const { db } = context(t);
  const attemptedPassword = "not-persisted-password";
  const client = new MailComImapClient({
    db,
    encryptionKey: "mailcom-test-key",
    imapFactory() {
      return {
        usable: false,
        async connect() { throw authError(); },
        close() {},
      };
    },
  });

  await assert.rejects(
    () => client.connectAccount({ email: "new-mother@techie.com", password: attemptedPassword }),
    (error) => error.code === "MAILCOM_AUTH_FAILED"
      && error.status === 409
      && error.message.includes("未新增账号")
      && error.message.includes("未保存或覆盖密码")
      && error.message.includes("若网页能登录")
      && error.message.includes("Premium")
      && !error.message.includes(attemptedPassword),
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM source_accounts").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mailcom_credentials").get().count, 0);
});

test("Mail.com APIs redact bulk passwords, allow address growth, and register aliases directly", async (t) => {
  const { db } = context(t);
  const connectedInputs = [];
  const scanCalls = [];
  const mailcom = {
    db,
    async connectAccount(input) {
      connectedInputs.push(input);
      if (input.email === "failed@pacific-ocean.com") {
        throw Object.assign(new Error(`upstream echoed ${input.password}`), { status: 409 });
      }
      return { account: { id: connectedInputs.length, email: input.email, provider: "mailcom" } };
    },
    async scanInbox(account) {
      scanCalls.push(account);
      return { stage: "completed", messages: [], items: [] };
    },
  };
  const createdTasks = [];
  const registrationClient = {
    async health() { return { ok: true, configured: true }; },
    async createTask(payload) {
      createdTasks.push(payload);
      return { task_id: `mailcom-task-${createdTasks.length}` };
    },
  };
  const pickup = {
    registrationProtectionEnabled() { return false; },
    async listStatuses() { return { items: [] }; },
  };
  const runtime = createApp({ db, mailcom, registrationClient, pickup });
  await runtime.inbox.scanInbox({ id: 17, provider: "mailcom" });
  assert.equal(scanCalls[0].id, 17);

  const imported = await jsonRequest(runtime.app, "/api/mailcom/import", {
    method: "POST",
    body: JSON.stringify({ content: `good@planetmail.com----good----secret\nfailed@pacific-ocean.com----failed-secret` }),
  });
  assert.equal(imported.response.status, 201);
  assert.equal(imported.body.imported, 1);
  assert.equal(imported.body.failed, 1);
  assert.equal(connectedInputs[0].password, "good----secret");
  assert.doesNotMatch(JSON.stringify(imported.body), /good----secret|failed-secret/);

  const rejectedHost = await jsonRequest(runtime.app, "/api/mailcom/connect", {
    method: "POST",
    body: JSON.stringify({ email: "other@email.com", password: "not-returned", host: "example.invalid" }),
  });
  assert.equal(rejectedHost.response.status, 400);
  assert.equal(connectedInputs.length, 2);

  const account = createSourceAccount(db, {
    email: "mother@galaxyhit.com",
    provider: "mailcom",
    officialLimit: 10,
  });
  db.prepare("UPDATE source_accounts SET status = 'connected', updated_at = ? WHERE id = ?")
    .run(nowIso(), account.id);
  setSetting(db, "registration_connector_key", "mailcom-connector-key");
  const aliases = Array.from({ length: 9 }, (_, index) => `alias${index + 1}@email.com`);
  const aliasImport = await jsonRequest(runtime.app, `/api/accounts/${account.id}/mailcom-aliases/import`, {
    method: "POST",
    body: JSON.stringify({ aliases }),
  });
  assert.equal(aliasImport.response.status, 200);
  assert.equal(aliasImport.body.account.mailcom_aliases, 9);
  assert.equal(aliasImport.body.account.official_used, 10);
  assert.equal(aliasImport.body.account.supports_plus_aliases, false);
  assert.ok(aliasImport.body.items.slice(1).every((item) => item.strategy === "mailcom_alias"));

  const overflow = await jsonRequest(runtime.app, `/api/accounts/${account.id}/mailcom-aliases/import`, {
    method: "POST",
    body: JSON.stringify({ aliases: ["overflow@post.com"] }),
  });
  assert.equal(overflow.response.status, 200);
  assert.equal(overflow.body.account.mailcom_aliases, 10);
  assert.equal(overflow.body.account.official_used, 11);

  const oversizedBatch = await jsonRequest(runtime.app, `/api/accounts/${account.id}/mailcom-aliases/import`, {
    method: "POST",
    body: JSON.stringify({
      aliases: Array.from({ length: 101 }, (_, index) => `manual-bulk${index}@mail.com`),
    }),
  });
  assert.equal(oversizedBatch.response.status, 400);
  assert.match(oversizedBatch.body.error, /单次最多提交 100 个/);

  const split = await jsonRequest(runtime.app, `/api/accounts/${account.id}/splits`, {
    method: "POST",
    body: JSON.stringify({ countPerBase: 1 }),
  });
  assert.equal(split.response.status, 409);

  const options = await jsonRequest(runtime.app, "/api/registration/options");
  const direct = options.body.accounts.find((item) => item.id === account.id);
  assert.equal(direct.registration_mode, "direct");
  assert.equal(direct.bases.length, 11);
  const registered = await jsonRequest(runtime.app, "/api/registration/jobs", {
    method: "POST",
    body: JSON.stringify({
      accountId: account.id,
      baseAddressId: direct.bases[0].id,
      count: 2,
      browserMode: "headed",
    }),
  });
  assert.equal(registered.response.status, 202);
  assert.deepEqual(registered.body.items.map((item) => item.email), direct.bases.slice(0, 2).map((item) => item.address));
  assert.ok(createdTasks.every((item) => item.extra.mail_source_provider === "mailcom"));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE account_id = ? AND kind = 'split'").get(account.id).count, 0);

  const removable = direct.bases.at(-1);
  const removed = await jsonRequest(runtime.app, `/api/addresses/${removable.id}`, { method: "DELETE" });
  assert.equal(removed.response.status, 204);
});
