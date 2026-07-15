import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase, nowIso } from "../db.js";
import { RegistrationService } from "../registration-service.js";

function testDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-account-signals-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

function addCompletedRegistration(db, id, email) {
  const now = nowIso();
  db.prepare(`
    INSERT INTO registration_jobs
      (email, external_account_id, status, stage, created_at, updated_at, finished_at)
    VALUES (?, ?, 'completed', 'completed', ?, ?, ?)
  `).run(email, String(id), now, now, now);
}

test("registered accounts require the same remote id and email and expose normalized Frcibly signals", async (t) => {
  const db = testDatabase(t);
  addCompletedRegistration(db, 101, "plus@example.com");
  addCompletedRegistration(db, 202, "free-disabled@example.com");
  addCompletedRegistration(db, 203, "team@example.com");
  addCompletedRegistration(db, 303, "expected@example.com");
  addCompletedRegistration(db, 505, "wrong-platform@example.com");
  const checkedAt = new Date().toISOString();
  const items = [
    {
      id: 101,
      platform: "chatgpt",
      email: "PLUS@EXAMPLE.COM",
      lifecycle_status: "SUBSCRIBED",
      validity_status: "VALID",
      display_status: "SUBSCRIBED",
      plan_state: "SUBSCRIBED",
      plan_name: "ChatGPT Plus Plan",
      overview: {
        valid: true,
        checked_at: checkedAt,
        check_source: "backend-api/me",
        password_status: "not_configured",
      },
      credentials: [
        { key: "access_token", value: "private-access-token" },
        { key: "session_token", value: "private-session-token" },
      ],
      created_at: nowIso(),
    },
    {
      id: 202,
      platform: "chatgpt",
      email: "free-disabled@example.com",
      lifecycle_status: "invalid",
      validity_status: "invalid",
      display_status: "invalid",
      plan_state: "free",
      plan_name: "FREE",
      overview: {
        valid: true,
        checked_at: checkedAt,
        check_source: "backend-api/me",
        password_status: "not_configured",
      },
      credentials: [{ key: "access_token", value: "private-disabled-token" }],
      created_at: nowIso(),
    },
    {
      id: 203,
      platform: "chatgpt",
      email: "team@example.com",
      lifecycle_status: "subscribed",
      validity_status: "valid",
      display_status: "subscribed",
      plan_state: "subscribed",
      overview: {
        plan_name: "chatgptteamplan",
        valid: true,
        check_source: "backend-api/me",
        password_status: "not_configured",
      },
      display_summary: { status: { checked_at: checkedAt } },
      credentials: [{ key: "refresh_token", value: "private-refresh-token" }],
      created_at: nowIso(),
    },
    {
      id: 303,
      platform: "chatgpt",
      email: "wrong@example.com",
      display_status: "registered",
      plan_state: "free",
      overview: { password_status: "not_configured" },
    },
    {
      id: 404,
      platform: "chatgpt",
      email: "expected@example.com",
      display_status: "registered",
      plan_state: "free",
      overview: { password_status: "not_configured" },
    },
    {
      id: 505,
      platform: "cursor",
      email: "wrong-platform@example.com",
      display_status: "registered",
      plan_state: "free",
      overview: { password_status: "not_configured" },
    },
  ];
  let refreshCalls = 0;
  const service = new RegistrationService({
    db,
    graph: {},
    client: {
      async listAccounts(options) {
        assert.deepEqual(options, { pageSize: 500 });
        return { total: items.length, items };
      },
      async refreshAccountPlans() {
        refreshCalls += 1;
        throw new Error("already checked accounts must not be refreshed");
      },
    },
  });

  const result = await service.listRegisteredAccounts();

  assert.equal(result.total, 3);
  assert.equal(refreshCalls, 0);
  assert.deepEqual(result.items.map((item) => item.id), [101, 202, 203]);
  const plus = result.items.find((item) => item.id === 101);
  assert.equal(plus.account_type, "plus");
  assert.equal(plus.account_type_source, "plan_name");
  assert.equal(plus.availability, "available");
  assert.equal(plus.available, true);
  assert.equal(plus.availability_source, "validity_status:valid");
  assert.equal(plus.lifecycle_status, "subscribed");
  assert.equal(plus.validity_status, "valid");
  assert.equal(plus.display_status, "subscribed");
  assert.equal(plus.plan_state, "subscribed");
  assert.equal(plus.plan_name, "chatgpt_plus_plan");
  assert.equal(plus.status_checked_at, checkedAt);
  assert.equal(plus.status_source, "backend-api/me");
  assert.equal(plus.source, "backend-api/me");
  assert.equal(plus.status_check_required, false);
  assert.equal(plus.status, "subscribed");
  assert.equal(plus.plan, "plus");
  assert.equal(plus.access_token_available, true);
  assert.equal(plus.session_token_available, true);
  assert.equal(plus.refresh_token_available, false);
  assert.equal(plus.credentials_available, true);

  const disabled = result.items.find((item) => item.id === 202);
  assert.equal(disabled.account_type, "free");
  assert.equal(disabled.availability, "unavailable");
  assert.equal(disabled.available, false);
  assert.equal(disabled.availability_source, "validity_status:invalid");
  assert.equal(disabled.plan_name, "free");
  assert.equal(disabled.status, "invalid");

  const team = result.items.find((item) => item.id === 203);
  assert.equal(team.account_type, "team");
  assert.equal(team.plan_name, "chatgptteamplan");
  assert.equal(team.status_checked_at, checkedAt);
  assert.equal(team.refresh_token_available, true);
  assert.equal(team.access_token_available, false);

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private-(?:access|session|disabled|refresh)-token/);
  assert.equal(serialized.includes('"credentials"'), false);
});

test("unchecked matched accounts refresh once, re-list, and never send mismatched ids", async (t) => {
  const db = testDatabase(t);
  addCompletedRegistration(db, 77, "unchecked@example.com");
  addCompletedRegistration(db, 88, "expected@example.com");
  let listCalls = 0;
  let refreshCalls = 0;
  let detected = false;
  const detectedAt = new Date().toISOString();
  const service = new RegistrationService({
    db,
    graph: {},
    client: {
      async listAccounts() {
        listCalls += 1;
        return {
          total: 3,
          items: [{
            id: 77,
            platform: "chatgpt",
            email: "unchecked@example.com",
            lifecycle_status: "registered",
            validity_status: detected ? "valid" : "unknown",
            display_status: "registered",
            plan_state: detected ? "free" : "unknown",
            plan_name: detected ? "free" : "",
            overview: {
              password_status: "not_configured",
              ...(detected ? {
                valid: true,
                checked_at: detectedAt,
                check_source: "backend-api/me",
              } : {}),
            },
            credentials: { access_token: { value: "private-object-token" } },
            created_at: nowIso(),
          }, {
            id: 88,
            platform: "chatgpt",
            email: "wrong@example.com",
            lifecycle_status: "registered",
            validity_status: "unknown",
            display_status: "registered",
            plan_state: "unknown",
            overview: { password_status: "not_configured" },
            credentials: { access_token: "must-not-refresh-by-id" },
          }, {
            id: 99,
            platform: "chatgpt",
            email: "expected@example.com",
            lifecycle_status: "registered",
            validity_status: "unknown",
            display_status: "registered",
            plan_state: "unknown",
            overview: { password_status: "not_configured" },
            credentials: { access_token: "must-not-refresh-by-email" },
          }],
        };
      },
      async refreshAccountPlans(ids) {
        refreshCalls += 1;
        assert.deepEqual(ids, [77]);
        detected = true;
        return { updated: 1, items: [{ account_id: 77, ok: true }], timed_out: 0 };
      },
    },
  });

  const result = await service.listRegisteredAccounts();
  const [account] = result.items;

  assert.equal(listCalls, 2);
  assert.equal(refreshCalls, 1);
  assert.equal(result.total, 1);
  assert.equal(account.account_type, "free");
  assert.equal(account.account_type_source, "plan_name");
  assert.equal(account.availability, "available");
  assert.equal(account.available, true);
  assert.equal(account.availability_source, "validity_status:valid");
  assert.equal(account.status_check_required, false);
  assert.equal(account.status_checked_at, detectedAt);
  assert.equal(account.status_source, "backend-api/me");
  assert.equal(account.status, "registered");
  assert.equal(account.plan, "free");
  assert.equal(account.access_token_available, true);
  assert.equal(account.credentials_available, true);
  assert.doesNotMatch(JSON.stringify(result), /private-object-token/);

  await service.listRegisteredAccounts();
  assert.equal(listCalls, 3);
  assert.equal(refreshCalls, 1);
});

test("failed automatic status refresh leaves unchecked state and is cooled down", async (t) => {
  const db = testDatabase(t);
  addCompletedRegistration(db, 91, "retry-later@example.com");
  let listCalls = 0;
  let refreshCalls = 0;
  const service = new RegistrationService({
    db,
    graph: {},
    client: {
      async listAccounts() {
        listCalls += 1;
        return {
          total: 1,
          items: [{
            id: 91,
            platform: "chatgpt",
            email: "retry-later@example.com",
            lifecycle_status: "registered",
            validity_status: "unknown",
            display_status: "registered",
            plan_state: "unknown",
            overview: { password_status: "not_configured" },
            credentials: [{ key: "access_token", value: "private-retry-token" }],
          }],
        };
      },
      async refreshAccountPlans(ids) {
        refreshCalls += 1;
        assert.deepEqual(ids, [91]);
        throw new Error("temporary refresh failure");
      },
    },
  });

  const first = await service.listRegisteredAccounts();
  const second = await service.listRegisteredAccounts();

  assert.equal(listCalls, 2);
  assert.equal(refreshCalls, 1);
  assert.equal(first.items[0].availability, "unchecked");
  assert.equal(first.items[0].available, null);
  assert.equal(first.items[0].status_check_required, true);
  assert.equal(second.items[0].availability, "unchecked");
});
