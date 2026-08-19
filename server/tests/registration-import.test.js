import assert from "node:assert/strict";
import test from "node:test";
import { parseLocalAccountImport } from "../registration-import.js";

test("parses Frcibly JSON account exports with flat credentials", () => {
  const [account] = parseLocalAccountImport({
    content: JSON.stringify([{
      id: 123,
      email: "Plus.User@Example.com",
      password: "",
      account_id: "workspace-user",
      access_token: "access-value",
      refresh_token: "refresh-value",
      status: "active",
    }]),
  });
  assert.equal(account.originalId, 123);
  assert.equal(account.payload.email, "plus.user@example.com");
  assert.equal(account.payload.user_id, "workspace-user");
  assert.equal(account.payload.credentials.access_token, "access-value");
  assert.equal(account.payload.credentials.refresh_token, "refresh-value");
});

test("parses CSV and JSONL local account imports", () => {
  const csv = parseLocalAccountImport({
    content: 'Email,Password,Access Token,Refresh Token\nfirst@example.com,,access-1,refresh-1',
  });
  assert.equal(csv[0].payload.credentials.access_token, "access-1");
  assert.equal(csv[0].payload.credentials.refresh_token, "refresh-1");

  const jsonl = parseLocalAccountImport({
    content: [
      JSON.stringify({ email: "one@example.com", password: "Password1" }),
      JSON.stringify({ email: "two@example.com", password: "Password2" }),
    ].join("\n"),
  });
  assert.deepEqual(jsonl.map((item) => item.payload.email), ["one@example.com", "two@example.com"]);
});

test("parses quoted text rows and rejects duplicate emails", () => {
  const [account] = parseLocalAccountImport({
    content: 'plain@example.com "password with spaces" {"access_token":"access-value"}',
  });
  assert.equal(account.payload.password, "password with spaces");
  assert.equal(account.payload.credentials.access_token, "access-value");

  assert.throws(
    () => parseLocalAccountImport({
      content: "dup@example.com Password1\ndup@example.com Password2",
    }),
    /重复邮箱/,
  );
});

test("accepts email-only accounts for mailbox OTP recovery", () => {
  const accounts = parseLocalAccountImport({
    content: "first@example.com\nsecond@example.com",
  });
  assert.deepEqual(
    accounts.map((item) => ({ email: item.payload.email, password: item.payload.password })),
    [
      { email: "first@example.com", password: "" },
      { email: "second@example.com", password: "" },
    ],
  );

  const [csv] = parseLocalAccountImport({ content: "email,password\ncsv@example.com," });
  assert.equal(csv.payload.email, "csv@example.com");
  assert.equal(csv.payload.password, "");
});

test("parses external accounts with four-dash or bare HTTPS inbox links", () => {
  const accounts = parseLocalAccountImport({
    content: [
      "Coding-Owl9A@icloud.com----https://dispose.lol/ib/ffVHmbNVuhin2DuP",
      "second@example.com https://pickup.example.test/p/CaseSensitiveKey?view=Inbox",
    ].join("\n"),
  });

  assert.deepEqual(accounts.map((item) => ({
    email: item.payload.email,
    password: item.payload.password,
    inboxLink: item.inboxLink,
  })), [
    {
      email: "coding-owl9a@icloud.com",
      password: "",
      inboxLink: "https://dispose.lol/ib/ffVHmbNVuhin2DuP",
    },
    {
      email: "second@example.com",
      password: "",
      inboxLink: "https://pickup.example.test/p/CaseSensitiveKey?view=Inbox",
    },
  ]);
});

test("parses explicit inbox-link fields without changing legacy cashier rows", () => {
  const [json] = parseLocalAccountImport({
    content: JSON.stringify({
      email: "json@example.com",
      mail_link: "https://pickup.example.test/mail/JsonKey",
    }),
  });
  assert.equal(json.inboxLink, "https://pickup.example.test/mail/JsonKey");

  const [csv] = parseLocalAccountImport({
    content: "email,inbox link\ncsv@example.com,https://pickup.example.test/mail/CsvKey",
  });
  assert.equal(csv.inboxLink, "https://pickup.example.test/mail/CsvKey");

  const [legacy] = parseLocalAccountImport({
    content: "legacy@example.com Password123 https://cashier.example.test/session/CaseKey",
  });
  assert.equal(legacy.payload.password, "Password123");
  assert.equal(legacy.payload.cashier_url, "https://cashier.example.test/session/CaseKey");
  assert.equal(legacy.inboxLink, "");

  const [dashedPassword] = parseLocalAccountImport({
    content: "dashed@example.com password----with----dashes",
  });
  assert.equal(dashedPassword.payload.password, "password----with----dashes");
  assert.equal(dashedPassword.inboxLink, "");
});

test("rejects unsafe, malformed, or multiply assigned inbox links", () => {
  for (const content of [
    "one@example.com----http://dispose.lol/ib/plain-http",
    "one@example.com----https://user:password@dispose.lol/ib/credentialed",
    "one@example.com----not-a-link",
  ]) {
    assert.throws(() => parseLocalAccountImport({ content }), (error) => {
      assert.equal(error.status, 400);
      assert.doesNotMatch(error.message, /plain-http|credentialed|not-a-link/);
      return true;
    });
  }

  assert.throws(() => parseLocalAccountImport({
    content: [
      "one@example.com----https://dispose.lol/ib/shared-key",
      "two@example.com----https://dispose.lol/ib/shared-key",
    ].join("\n"),
  }), /重复取件链接/);
});
