import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase, nowIso, setSetting } from "../db.js";
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
  assert.equal(plus.availability_source, "overview.valid:confirmed");
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
  assert.equal(disabled.availability, "available");
  assert.equal(disabled.available, true);
  assert.equal(disabled.availability_source, "overview.valid:confirmed");
  assert.equal(disabled.status_confirmation, "confirmed");
  assert.equal(disabled.status_conflict, false);
  assert.equal(disabled.account_status, "active");
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

test("registered account list exposes only completed NFapi imports", async (t) => {
  const db = testDatabase(t);
  const now = nowIso();
  const fixtures = [
    { id: 601, email: "nfapi-imported@example.com", status: "imported", nfapiId: 9601 },
    { id: 602, email: "nfapi-failed@example.com", status: "failed", nfapiId: 0 },
    { id: 603, email: "nfapi-pending@example.com", status: "pending", nfapiId: 0 },
  ];
  setSetting(db, "nfapi_base_url", "https://nfapi.test");
  for (const fixture of fixtures) {
    addCompletedRegistration(db, fixture.id, fixture.email);
    db.prepare(`
      INSERT INTO registered_account_nfapi_links
        (external_account_id, email, nfapi_base_url, nfapi_account_id, status,
         last_error, created_at, updated_at)
      VALUES (?, ?, 'https://nfapi.test', ?, ?, ?, ?, ?)
    `).run(
      String(fixture.id), fixture.email, fixture.nfapiId, fixture.status,
      fixture.status === "imported" ? "" : "internal attempt detail", now, now,
    );
  }

  const service = new RegistrationService({
    db,
    graph: {},
    client: {
      async listAccounts() {
        return {
          items: fixtures.map((fixture) => ({
            id: fixture.id,
            platform: "chatgpt",
            email: fixture.email,
            lifecycle_status: "registered",
            validity_status: "valid",
            display_status: "registered",
            plan_state: "free",
            plan_name: "free",
            overview: {
              valid: true,
              checked_at: now,
              check_source: "fixture",
              password_status: "not_configured",
            },
            credentials: [],
            created_at: now,
          })),
        };
      },
    },
  });

  const result = await service.listRegisteredAccounts({ refreshUnchecked: false });
  const byId = new Map(result.items.map((item) => [item.id, item]));
  assert.equal(byId.get(601).nfapi.linked, true);
  assert.equal(byId.get(601).nfapi.status, "imported");
  assert.equal(byId.get(601).nfapi.account_id, 9601);
  assert.deepEqual(byId.get(602).nfapi, { linked: false, status: "not_imported" });
  assert.deepEqual(byId.get(603).nfapi, { linked: false, status: "not_imported" });
  assert.equal(JSON.stringify(result).includes("internal attempt detail"), false);
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
        return {
          updated: 1,
          items: [{
            account_id: 77,
            ok: true,
            valid: true,
            account_type: "free",
            account_type_raw: "free",
            account_type_source: "backend-api/accounts/check+subscriptions",
            type_observed: true,
            plan_detection_result: "confirmed",
            plan_authority: "authoritative",
            status_source: "backend-api/accounts/check+subscriptions",
            status_checked_at: detectedAt,
          }],
          timed_out: 0,
        };
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
  assert.equal(account.availability_source, "overview.valid:confirmed");
  assert.equal(account.status_check_required, false);
  assert.equal(account.status_checked_at, detectedAt);
  assert.equal(account.status_source, "backend-api/accounts/check+subscriptions");
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

test("only authoritative API checks can mark an account unavailable", async (t) => {
  const db = testDatabase(t);
  addCompletedRegistration(db, 301, "recovered@example.com");
  addCompletedRegistration(db, 302, "unconfirmed@example.com");
  addCompletedRegistration(db, 303, "revoked@example.com");
  addCompletedRegistration(db, 304, "session-confirmed@example.com");
  const checkedAt = new Date().toISOString();
  const common = {
    platform: "chatgpt",
    lifecycle_status: "invalid",
    validity_status: "invalid",
    display_status: "invalid",
    plan_state: "free",
    plan_name: "free",
    credentials: [{ key: "access_token", value: "private-token" }],
  };
  const service = new RegistrationService({
    db,
    graph: {},
    client: {
      async listAccounts() {
        return { items: [
          {
            ...common,
            id: 301,
            email: "recovered@example.com",
            overview: { valid: true, checked_at: checkedAt, check_source: "backend-api/wham/usage" },
          },
          {
            ...common,
            id: 302,
            email: "unconfirmed@example.com",
            overview: { valid: false, checked_at: checkedAt },
          },
          {
            ...common,
            id: 303,
            email: "revoked@example.com",
            overview: {
              valid: false,
              checked_at: checkedAt,
              check_source: "backend-api/me",
              validity_code: "account_disabled",
              validity_reason: "This account has been disabled",
            },
          },
          {
            ...common,
            id: 304,
            email: "session-confirmed@example.com",
            overview: { valid: true, checked_at: checkedAt, check_source: "api/auth/session+jwt" },
          },
        ] };
      },
    },
  });

  const result = await service.listRegisteredAccounts();
  const recovered = result.items.find((item) => item.id === 301);
  const unconfirmed = result.items.find((item) => item.id === 302);
  const revoked = result.items.find((item) => item.id === 303);
  const sessionConfirmed = result.items.find((item) => item.id === 304);

  assert.equal(recovered.availability, "available");
  assert.equal(recovered.status_confirmation, "confirmed");
  assert.equal(recovered.status_confirmed_at, checkedAt);
  assert.equal(unconfirmed.availability, "unchecked");
  assert.equal(unconfirmed.status_confirmation, "unconfirmed");
  assert.equal(unconfirmed.status_confirmed_at, "");
  assert.equal(revoked.availability, "unavailable");
  assert.equal(revoked.availability_source, "code:account_disabled:confirmed");
  assert.equal(revoked.account_status, "disabled");
  assert.equal(revoked.status_code, "account_disabled");
  assert.equal(revoked.status_confirmation, "confirmed");
  assert.equal(sessionConfirmed.availability, "available");
  assert.equal(sessionConfirmed.status_confirmation, "confirmed");
  assert.equal(sessionConfirmed.status_source, "api/auth/session+jwt");
});

test("manual status refresh checks only selected registered accounts and preserves state on transient failures", async (t) => {
  const db = testDatabase(t);
  addCompletedRegistration(db, 7, "plus@example.com");
  addCompletedRegistration(db, 8, "free@example.com");
  addCompletedRegistration(db, 9, "not-selected@example.com");
  const originalProxy = "http://proxy-user:proxy-password@proxy.example:8080";
  setSetting(db, "registration_proxy_pool", JSON.stringify([originalProxy]));
  db.prepare("UPDATE registration_jobs SET proxy_label = ? WHERE external_account_id = ?")
    .run("http://***@proxy.example:8080", "7");
  db.prepare("UPDATE registration_jobs SET proxy_label = '直连' WHERE external_account_id = ?")
    .run("8");
  const checkedAt = new Date().toISOString();
  let refreshed = false;
  let refreshCalls = 0;
  const account = (id, email, plan, valid = true) => ({
    id,
    platform: "chatgpt",
    email,
    lifecycle_status: valid ? "registered" : "invalid",
    validity_status: valid ? "valid" : "unknown",
    display_status: valid ? "registered" : "invalid",
    plan_state: plan === "plus" ? "subscribed" : "free",
    plan_name: plan,
    overview: valid
      ? { valid: true, checked_at: checkedAt, check_source: "backend-api/wham/usage", password_status: "not_configured" }
      : { password_status: "not_configured" },
    credentials: [{ key: "access_token", value: `private-${id}` }],
  });
  const service = new RegistrationService({
    db,
    graph: {},
    client: {
      async listAccounts() {
        return { items: [
          account(7, "plus@example.com", refreshed ? "plus" : "free", refreshed),
          account(8, "free@example.com", "free"),
          account(9, "not-selected@example.com", "free"),
        ] };
      },
      async refreshAccountPlans(ids, proxiesById) {
        refreshCalls += 1;
        assert.deepEqual(ids, [7, 8]);
        assert.deepEqual(proxiesById, { 7: originalProxy });
        refreshed = true;
        return {
          updated: 1,
          timed_out: 1,
          items: [
            {
              account_id: 7,
              ok: true,
              valid: true,
              account_type: "plus",
              account_type_raw: "plus",
              account_type_source: "backend-api/wham/usage",
              type_observed: true,
              plan_detection_result: "confirmed",
            },
            { account_id: 8, ok: false, error: "proxy-user:proxy-password network timeout" },
          ],
        };
      },
    },
  });

  const result = await service.refreshRegisteredAccountSignals({ ids: [7, "8", 7] });

  assert.equal(refreshCalls, 1);
  assert.equal(result.requested, 2);
  assert.equal(result.checked, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.timed_out, 1);
  assert.equal(result.available, 2);
  assert.equal(result.unavailable, 0);
  assert.equal(result.unchecked, 0);
  assert.deepEqual(result.types, { plus: 1, free: 1 });
  const plusResult = result.items.find((item) => item.id === 7);
  const transientResult = result.items.find((item) => item.id === 8);
  assert.equal(plusResult.detection_status, "confirmed");
  assert.equal(plusResult.code, "check_completed");
  assert.equal(plusResult.type, "plus");
  assert.equal(plusResult.status, "active");
  assert.equal(plusResult.retryable, false);
  assert.equal(plusResult.source, "registration-refresh");
  assert.ok(Date.parse(plusResult.time));
  assert.equal(transientResult.detection_status, "inconclusive");
  assert.equal(transientResult.code, "check_timeout");
  assert.equal(transientResult.retryable, true);
  assert.equal(transientResult.type, "free");
  assert.equal(transientResult.status, "active");
  assert.equal(result.accounts.items.find((item) => item.id === 7).status_check_state, "checked");
  assert.equal(result.accounts.items.find((item) => item.id === 8).status_check_state, "failed");
  assert.equal(result.accounts.items.find((item) => item.id === 8).availability, "available");
  assert.match(result.accounts.items.find((item) => item.id === 8).status_check_error, /网络|超时/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM registered_account_status_checks").get().count, 2);
  assert.doesNotMatch(JSON.stringify(result), /proxy-user|proxy-password/);
});

test("manual refresh checks the saved dynamic proxy before a new session and paid evidence wins", async (t) => {
  const db = testDatabase(t);
  addCompletedRegistration(db, 44, "upgraded@example.com");
  const originalProxy = "http://pool-user:pool-secret-US-12345678-30m@gate-us.kookeey.info:1000";
  setSetting(db, "registration_proxy_pool", JSON.stringify([originalProxy]));
  db.prepare("UPDATE registration_jobs SET proxy_label = ? WHERE external_account_id = ?")
    .run("http://***@gate-us.kookeey.info:1000", "44");
  const checkedAt = new Date().toISOString();
  let currentPlan = "free";
  const calls = [];
  const service = new RegistrationService({
    db,
    graph: {},
    client: {
      async listAccounts() {
        return { items: [{
          id: 44,
          platform: "chatgpt",
          email: "upgraded@example.com",
          lifecycle_status: currentPlan === "plus" ? "subscribed" : "registered",
          validity_status: "valid",
          display_status: "registered",
          plan_state: currentPlan === "plus" ? "subscribed" : "free",
          plan_name: currentPlan,
          overview: {
            valid: true,
            checked_at: checkedAt,
            check_source: "backend-api/wham/usage",
            password_status: "not_configured",
          },
          credentials: [{ key: "access_token", value: "private-upgraded-token" }],
        }] };
      },
      async refreshAccountPlans(ids, proxiesById) {
        calls.push({ ids, proxiesById });
        if (calls.length === 1) {
          return { items: [{
            account_id: 44,
            ok: true,
            valid: true,
            account_type: "free",
            account_type_raw: "free",
            account_type_source: "backend-api/wham/usage",
            type_observed: true,
            plan_detection_result: "confirmed",
            plan_authority: "verified",
            account_type_confidence: "medium",
          }] };
        }
        currentPlan = "plus";
        return { items: [{
          account_id: 44,
          ok: true,
          valid: true,
          account_type: "plus",
          account_type_raw: "plus",
          account_type_source: "backend-api/wham/usage",
          type_observed: true,
          plan_detection_result: "confirmed",
          plan_authority: "verified",
          account_type_confidence: "medium",
        }] };
      },
    },
  });

  const result = await service.refreshRegisteredAccountSignals({ ids: [44] });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { ids: [44], proxiesById: { 44: originalProxy } });
  assert.notEqual(calls[1].proxiesById[44], originalProxy);
  assert.equal(new URL(calls[1].proxiesById[44]).host, new URL(originalProxy).host);
  assert.equal(result.items[0].detection_status, "confirmed");
  assert.equal(result.items[0].type, "plus");
  assert.deepEqual(result.types, { plus: 1 });
  assert.equal(result.accounts.items[0].account_type, "plus");
  assert.doesNotMatch(JSON.stringify(result), /pool-user|pool-secret|private-upgraded-token/);
});

test("two independent observed Free results confirm Free without a direct third request", async (t) => {
  const db = testDatabase(t);
  addCompletedRegistration(db, 48, "confirmed-free@example.com");
  const originalProxy = "http://free-user:free-secret-US-44332211-30m@gate-us.kookeey.info:1000";
  setSetting(db, "registration_proxy_pool", JSON.stringify([originalProxy]));
  db.prepare("UPDATE registration_jobs SET proxy_label = ? WHERE external_account_id = ?")
    .run("http://***@gate-us.kookeey.info:1000", "48");
  const calls = [];
  const checkedAt = new Date().toISOString();
  const service = new RegistrationService({
    db,
    graph: {},
    client: {
      async listAccounts() {
        return { items: [{
          id: 48,
          platform: "chatgpt",
          email: "confirmed-free@example.com",
          lifecycle_status: "registered",
          validity_status: "valid",
          display_status: "registered",
          plan_state: "free",
          plan_name: "free",
          overview: {
            valid: true,
            checked_at: checkedAt,
            check_source: "backend-api/wham/usage",
            password_status: "not_configured",
          },
          credentials: [{ key: "access_token", value: "private-confirmed-free-token" }],
        }] };
      },
      async refreshAccountPlans(ids, proxiesById) {
        calls.push({ ids, proxiesById });
        return { items: [{
          account_id: 48,
          ok: true,
          valid: true,
          account_type: "free",
          account_type_raw: "free",
          account_type_source: "backend-api/wham/usage",
          type_observed: true,
          plan_detection_result: "confirmed",
          plan_authority: "verified",
          account_type_confidence: "medium",
        }] };
      },
    },
  });

  const result = await service.refreshRegisteredAccountSignals({ ids: [48] });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { ids: [48], proxiesById: { 48: originalProxy } });
  assert.notEqual(calls[1].proxiesById[48], originalProxy);
  assert.equal(result.items[0].type, "free");
  assert.equal(result.items[0].detection_status, "confirmed");
  assert.equal(result.items[0].checked, true);
  assert.doesNotMatch(JSON.stringify(result), /free-user|free-secret|private-confirmed-free-token/);
});

test("manual refresh uses direct review when dynamic sessions disagree and never confirms weak old Free", async (t) => {
  const db = testDatabase(t);
  addCompletedRegistration(db, 45, "direct-review@example.com");
  addCompletedRegistration(db, 46, "weak-free@example.com");
  const originalProxy = "http://review-user:review-secret-US-87654321-30m@gate-us.kookeey.info:1000";
  setSetting(db, "registration_proxy_pool", JSON.stringify([originalProxy]));
  db.prepare("UPDATE registration_jobs SET proxy_label = ? WHERE external_account_id IN (?, ?)")
    .run("http://***@gate-us.kookeey.info:1000", "45", "46");
  const checkedAt = new Date().toISOString();
  const plans = new Map([[45, "free"], [46, "free"]]);
  const calls = new Map([[45, []], [46, []]]);
  const account = (id, email) => ({
    id,
    platform: "chatgpt",
    email,
    lifecycle_status: plans.get(id) === "plus" ? "subscribed" : "registered",
    validity_status: "valid",
    display_status: "registered",
    plan_state: plans.get(id) === "plus" ? "subscribed" : "free",
    plan_name: plans.get(id),
    overview: {
      valid: true,
      checked_at: checkedAt,
      check_source: "backend-api/me",
      password_status: "not_configured",
    },
    credentials: [{ key: "access_token", value: `private-review-${id}` }],
  });
  const service = new RegistrationService({
    db,
    graph: {},
    client: {
      async listAccounts() {
        return { items: [
          account(45, "direct-review@example.com"),
          account(46, "weak-free@example.com"),
        ] };
      },
      async refreshAccountPlans(ids, proxiesById) {
        const id = ids[0];
        calls.get(id).push(proxiesById);
        const attempt = calls.get(id).length;
        if (id === 45 && attempt === 1) {
          return { items: [{
            account_id: id,
            ok: true,
            valid: true,
            account_type: "free",
            account_type_raw: "free",
            account_type_source: "backend-api/wham/usage",
            type_observed: true,
            plan_detection_result: "confirmed",
            plan_authority: "verified",
            account_type_confidence: "medium",
          }] };
        }
        if (id === 45 && attempt === 3) {
          plans.set(id, "plus");
          return { items: [{
            account_id: id,
            ok: true,
            valid: true,
            account_type: "plus",
            account_type_raw: "plus",
            account_type_source: "backend-api/accounts/check",
            type_observed: true,
            plan_detection_result: "confirmed",
            plan_authority: "verified",
          }] };
        }
        if (id === 46 && attempt === 1) {
          return { items: [{
            account_id: id,
            ok: true,
            valid: true,
            account_type: "free",
            account_type_raw: "free",
            account_type_source: "last_confirmed_plan",
            type_observed: true,
            plan_detection_result: "confirmed",
          }] };
        }
        return { items: [{ account_id: id, ok: false, error: "temporary network timeout" }] };
      },
    },
  });

  const paid = await service.refreshRegisteredAccountSignals({ ids: [45] });
  const weak = await service.refreshRegisteredAccountSignals({ ids: [46] });

  assert.equal(calls.get(45).length, 3);
  assert.deepEqual(calls.get(45)[2], {});
  assert.equal(paid.items[0].type, "plus");
  assert.equal(paid.items[0].detection_status, "confirmed");
  assert.equal(calls.get(46).length, 3);
  assert.deepEqual(calls.get(46)[2], {});
  assert.equal(weak.items[0].type, "free");
  assert.equal(weak.items[0].detection_status, "inconclusive");
  assert.equal(weak.items[0].checked, false);
  assert.equal(weak.accounts.items.find((item) => item.id === 46).status_check_state, "failed");
  assert.doesNotMatch(JSON.stringify({ paid, weak }), /review-user|review-secret|private-review/);
});

test("automatic unchecked refresh also uses the saved dynamic proxy before rotating", async (t) => {
  const db = testDatabase(t);
  addCompletedRegistration(db, 47, "automatic-proxy@example.com");
  const originalProxy = "http://auto-user:auto-secret-US-11223344-30m@gate-us.kookeey.info:1000";
  setSetting(db, "registration_proxy_pool", JSON.stringify([originalProxy]));
  db.prepare("UPDATE registration_jobs SET proxy_label = ? WHERE external_account_id = ?")
    .run("http://***@gate-us.kookeey.info:1000", "47");
  let detected = false;
  const calls = [];
  const service = new RegistrationService({
    db,
    graph: {},
    client: {
      async listAccounts() {
        return { items: [{
          id: 47,
          platform: "chatgpt",
          email: "automatic-proxy@example.com",
          lifecycle_status: detected ? "subscribed" : "registered",
          validity_status: detected ? "valid" : "unknown",
          display_status: "registered",
          plan_state: detected ? "subscribed" : "unknown",
          plan_name: detected ? "plus" : "",
          overview: detected ? {
            valid: true,
            checked_at: new Date().toISOString(),
            check_source: "backend-api/wham/usage",
            password_status: "not_configured",
          } : { password_status: "not_configured" },
          credentials: [{ key: "access_token", value: "private-auto-token" }],
        }] };
      },
      async refreshAccountPlans(ids, proxiesById) {
        calls.push({ ids, proxiesById });
        detected = true;
        return { items: [{
          account_id: 47,
          ok: true,
          valid: true,
          account_type: "plus",
          account_type_raw: "plus",
          account_type_source: "backend-api/wham/usage",
          type_observed: true,
          plan_detection_result: "confirmed",
        }] };
      },
    },
  });

  const result = await service.listRegisteredAccounts();

  assert.deepEqual(calls, [{ ids: [47], proxiesById: { 47: originalProxy } }]);
  assert.equal(result.items[0].account_type, "plus");
  assert.equal(result.items[0].detection_status, "confirmed");
  assert.doesNotMatch(JSON.stringify(result), /auto-user|auto-secret|private-auto-token/);
});

test("normalizes every supported plan family with exact aliases and preserves unknown raw types", async (t) => {
  const db = testDatabase(t);
  const checkedAt = new Date().toISOString();
  const cases = [
    [101, "ChatGPT Free Plan", "free", "free"],
    [102, "chatgpt_go_plan", "go", "subscribed"],
    [103, "ChatGPT Plus Plan", "plus", "subscribed"],
    [104, "chatgpt_pro_plan", "pro", "subscribed"],
    [105, "chatgptteamplan", "team", "subscribed"],
    [106, "chatgpt_business_plan", "business", "subscribed"],
    [107, "Corporate", "enterprise", "subscribed"],
    [108, "chatgpt_edu_plan", "edu", "subscribed"],
    [109, "future_ultra", "unknown", "subscribed"],
    [110, "unpaid", "unknown", "subscribed"],
    [111, "professional", "unknown", "subscribed"],
    [112, "student", "unknown", "subscribed"],
    [113, "free_trial", "trial", "trial"],
    [114, "free", "plus", "subscribed", "plus", "plus"],
  ];
  for (const [id] of cases) addCompletedRegistration(db, id, `plan-${id}@example.com`);
  const service = new RegistrationService({
    db,
    graph: {},
    client: {
      async listAccounts() {
        return {
          items: cases.map(([id, planName, _expected, planState, declaredType]) => ({
            id,
            platform: "chatgpt",
            email: `plan-${id}@example.com`,
            ...(declaredType ? { account_type: declaredType, account_type_raw: planName } : {}),
            lifecycle_status: planState === "free" ? "registered" : "subscribed",
            validity_status: "valid",
            display_status: planState === "free" ? "registered" : "subscribed",
            plan_state: planState,
            plan_name: planName,
            overview: {
              valid: true,
              checked_at: checkedAt,
              check_source: "backend-api/me",
              password_status: "not_configured",
            },
          })),
        };
      },
    },
  });

  const result = await service.listRegisteredAccounts({ refreshUnchecked: false });
  const groupByType = {
    free: "Free 套餐", go: "Go 套餐", plus: "Plus 套餐", pro: "Pro 套餐",
    team: "Team 套餐", business: "Business 套餐", enterprise: "Enterprise 套餐",
    edu: "Edu 套餐", trial: "Trial 套餐", unknown: "Other 套餐",
  };
  for (const [id, raw, expected, _planState, _declaredType, expectedRaw = raw] of cases) {
    const account = result.items.find((item) => item.id === id);
    assert.equal(account.account_type, expected, `${raw} type`);
    assert.equal(account.account_type_raw, expectedRaw, `${raw} raw`);
    assert.equal(account.account_type_known, expected !== "unknown", `${raw} known`);
    assert.equal(account.account_status, "active", `${raw} account status`);
    assert.equal(account.group_name, groupByType[expected], `${raw} default group`);
    assert.equal(account.default_group_name, groupByType[expected], `${raw} default group name`);
    assert.equal(account.custom_group_name, "", `${raw} custom group`);
    assert.equal(account.group_source, "plan", `${raw} group source`);
  }
  assert.equal(result.items.find((item) => item.id === 109).plan_name, "future_ultra");
  assert.equal(result.items.find((item) => item.id === 110).account_type, "unknown");
  assert.equal(result.items.find((item) => item.id === 111).account_type, "unknown");
  assert.equal(result.items.find((item) => item.id === 112).account_type, "unknown");
  assert.equal(result.items.find((item) => item.id === 113).subscription_status, "trialing");
});

test("separates terminal account evidence from credential and subscription expiry", async (t) => {
  const db = testDatabase(t);
  const checkedAt = new Date().toISOString();
  const definitions = [
    [201, "disabled", "backend-api/me", "account_disabled"],
    [202, "subscription", "backend-api/me", "subscription_expired"],
    [203, "credential", "credential/access-token-jwt", "access_token_expired"],
    [204, "generic", "backend-api/me", ""],
    [205, "session", "api/auth/session+jwt", "account_disabled"],
    [206, "revoked", "backend-api/me", "token_revoked"],
  ];
  for (const [id, label] of definitions) addCompletedRegistration(db, id, `${label}@example.com`);
  const service = new RegistrationService({
    db,
    graph: {},
    client: {
      async listAccounts() {
        return {
          items: definitions.map(([id, label, source, code]) => ({
            id,
            platform: "chatgpt",
            email: `${label}@example.com`,
            lifecycle_status: "invalid",
            validity_status: "invalid",
            display_status: "invalid",
            plan_state: code === "subscription_expired" ? "expired" : "free",
            plan_name: "free",
            overview: {
              valid: false,
              status_checked_at: checkedAt,
              status_source: source,
              status_code: code,
              status_reason: code ? `reason:${code}` : "generic invalid",
              status_retryable: false,
              status_http: code ? 401 : 0,
              status_evidence_path: code ? "error.code" : "",
              password_status: "not_configured",
            },
            credentials: [{ key: "access_token", value: `private-${id}` }],
          })),
        };
      },
    },
  });

  const result = await service.listRegisteredAccounts({ refreshUnchecked: false });
  const disabled = result.items.find((item) => item.id === 201);
  const subscription = result.items.find((item) => item.id === 202);
  const credential = result.items.find((item) => item.id === 203);
  const generic = result.items.find((item) => item.id === 204);
  const session = result.items.find((item) => item.id === 205);
  const revoked = result.items.find((item) => item.id === 206);

  assert.equal(disabled.availability, "unavailable");
  assert.equal(disabled.account_status, "disabled");
  assert.equal(disabled.status_code, "account_disabled");
  assert.equal(disabled.status_http, 401);
  assert.equal(disabled.status_evidence_path, "error.code");
  assert.equal(subscription.availability, "available");
  assert.equal(subscription.available, true);
  assert.equal(subscription.account_status, "active");
  assert.equal(subscription.subscription_status, "expired");
  assert.equal(subscription.detection_status, "confirmed");
  assert.equal(credential.availability, "unavailable");
  assert.equal(credential.available, false);
  assert.equal(credential.credential_status, "expired");
  assert.equal(credential.account_status, "unknown");
  assert.equal(credential.status_source, "credential/access-token-jwt");
  assert.equal(generic.availability, "unchecked");
  assert.equal(generic.status_code, "");
  assert.equal(session.availability, "unchecked");
  assert.equal(session.account_status, "unknown");
  assert.equal(session.status_confirmation, "unconfirmed");
  assert.equal(revoked.availability, "unavailable");
  assert.equal(revoked.account_status, "unknown");
  assert.equal(revoked.credential_status, "revoked");
});

test("manual refresh returns structured evidence and persists sanitized outcomes across restart", async (t) => {
  const db = testDatabase(t);
  addCompletedRegistration(db, 301, "terminal@example.com");
  addCompletedRegistration(db, 302, "expired-plan@example.com");
  addCompletedRegistration(db, 303, "transient@example.com");
  const checkedAt = new Date(Date.now() - 60_000).toISOString();
  const remoteAccounts = [
    [301, "terminal@example.com", "plus"],
    [302, "expired-plan@example.com", "plus"],
    [303, "transient@example.com", "free"],
  ];
  const client = {
    async listAccounts() {
      return {
        items: remoteAccounts.map(([id, email, plan]) => ({
          id,
          platform: "chatgpt",
          email,
          lifecycle_status: plan === "free" ? "registered" : "subscribed",
          validity_status: "valid",
          display_status: plan === "free" ? "registered" : "subscribed",
          plan_state: plan === "free" ? "free" : "subscribed",
          plan_name: plan,
          overview: {
            valid: true,
            checked_at: checkedAt,
            check_source: "backend-api/me",
            password_status: "not_configured",
          },
          credentials: [{ key: "access_token", value: `private-${id}` }],
        })),
      };
    },
    async refreshAccountPlans() {
      return {
        timed_out: 1,
        items: [
          {
            account_id: 301,
            ok: true,
            valid: false,
            status_code: "account_disabled",
            status_reason: "Account disabled by provider",
            status_retryable: false,
            status_source: "backend-api/me",
            status_checked_at: new Date().toISOString(),
            status_http: 403,
            status_evidence_path: "error.code",
            account_type_raw: "chatgpt_plus_plan",
          },
          {
            account_id: 302,
            ok: true,
            valid: false,
            status_code: "subscription_expired",
            status_reason: "Paid subscription expired",
            status_retryable: false,
            status_source: "backend-api/subscription",
            status_checked_at: new Date().toISOString(),
            status_http: 200,
            status_evidence_path: "subscription.status",
            account_type_raw: "future_ultra",
          },
          {
            account_id: 303,
            ok: false,
            status_code: "check_timeout",
            status_reason: "proxy-user:proxy-password TLS timeout Bearer eyJhbGciOiJIUzI1NiJ9.secret.value",
            status_retryable: true,
            status_source: "registration-refresh",
          },
        ],
      };
    },
  };
  const service = new RegistrationService({ db, graph: {}, client });

  const result = await service.refreshRegisteredAccountSignals({ ids: [301, 302, 303] });
  const terminal = result.items.find((item) => item.id === 301);
  const subscription = result.items.find((item) => item.id === 302);
  const transient = result.items.find((item) => item.id === 303);

  assert.equal(terminal.checked, true);
  assert.equal(terminal.code, "account_disabled");
  assert.equal(terminal.status, "disabled");
  assert.equal(terminal.type, "plus");
  assert.equal(terminal.retryable, false);
  assert.equal(terminal.http_status, 403);
  assert.equal(terminal.evidence_path, "error.code");
  assert.ok(Date.parse(terminal.checked_at));
  assert.equal(subscription.checked, true);
  assert.equal(subscription.status, "active");
  assert.equal(subscription.subscription_status, "expired");
  assert.equal(subscription.type, "unknown");
  assert.equal(subscription.type_raw, "future_ultra");
  assert.equal(result.accounts.items.find((item) => item.id === 302).availability, "available");
  assert.equal(transient.checked, false);
  assert.equal(transient.detection_status, "inconclusive");
  assert.equal(transient.code, "check_timeout");
  assert.equal(transient.retryable, true);
  assert.equal(transient.status, "active");
  assert.ok(Date.parse(transient.time));
  assert.doesNotMatch(JSON.stringify(result), /proxy-user|proxy-password|eyJhbGci|secret\.value/i);
  const persistedUnknown = db.prepare(`
    SELECT * FROM registered_account_status_checks WHERE external_account_id = '302'
  `).get();
  assert.equal(persistedUnknown.account_type, "unknown");
  assert.equal(persistedUnknown.account_type_raw, "future_ultra");
  assert.equal(persistedUnknown.http_status, 200);
  assert.equal(persistedUnknown.evidence_path, "subscription.status");

  const restarted = new RegistrationService({ db, graph: {}, client });
  const afterRestart = await restarted.listRegisteredAccounts({ refreshUnchecked: false });
  const persistedTerminal = afterRestart.items.find((item) => item.id === 301);
  const persistedTransient = afterRestart.items.find((item) => item.id === 303);
  assert.equal(persistedTerminal.availability, "unavailable");
  assert.equal(persistedTerminal.status_code, "account_disabled");
  assert.equal(persistedTransient.availability, "available");
  assert.equal(persistedTransient.detection_status, "inconclusive");
  assert.equal(persistedTransient.status_code, "check_timeout");
  assert.equal(persistedTransient.status_retryable, true);
  assert.equal(persistedTransient.status_check_state, "failed");
  assert.ok(Date.parse(persistedTransient.status_check_attempted_at));
});

test("transient refresh failures use stable public codes without leaking upstream secrets", async (t) => {
  const db = testDatabase(t);
  const failures = [
    [401, "request timed out", "check_timeout", true],
    [402, "HTTP 429 rate limit exceeded", "rate_limited", true],
    [403, "<html>Cloudflare challenge</html>", "upstream_challenge", true],
    [404, "getaddrinfo ENOTFOUND api.example", "dns_failure", true],
    [405, "TLS certificate handshake failed", "tls_failure", true],
    [406, "proxy-user:proxy-password proxy unavailable", "proxy_unavailable", true],
    [407, "HTTP 503 service unavailable", "upstream_unavailable", true],
    [408, "HTTP 401 unauthorized", "authentication_unconfirmed", true],
    [409, "HTTP 403 forbidden", "access_forbidden", true],
    [410, "socket ECONNRESET", "network_error", true],
    [411, "unexpected detector failure", "check_failed", true],
  ];
  for (const [id] of failures) addCompletedRegistration(db, id, `failure-${id}@example.com`);
  const checkedAt = new Date(Date.now() - 60_000).toISOString();
  const service = new RegistrationService({
    db,
    graph: {},
    client: {
      async listAccounts() {
        return {
          items: failures.map(([id]) => ({
            id,
            platform: "chatgpt",
            email: `failure-${id}@example.com`,
            lifecycle_status: "registered",
            validity_status: "valid",
            display_status: "registered",
            plan_state: "free",
            plan_name: "free",
            overview: {
              valid: true,
              checked_at: checkedAt,
              check_source: "backend-api/me",
              password_status: "not_configured",
            },
            credentials: [{ key: "access_token", value: `private-${id}` }],
          })),
        };
      },
      async refreshAccountPlans() {
        return {
          items: failures.map(([id, error]) => ({ account_id: id, ok: false, error })),
          timed_out: 0,
        };
      },
    },
  });

  const result = await service.refreshRegisteredAccountSignals({
    ids: failures.map(([id]) => id),
  });
  for (const [id, _error, expectedCode, retryable] of failures) {
    const item = result.items.find((candidate) => candidate.id === id);
    assert.equal(item.detection_status, "inconclusive", String(id));
    assert.equal(item.code, expectedCode, String(id));
    assert.equal(item.retryable, retryable, String(id));
    assert.equal(item.availability, "available", String(id));
  }
  assert.doesNotMatch(JSON.stringify(result), /proxy-user|proxy-password|private-40/i);
});
