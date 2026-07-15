import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase, createSourceAccount, nowIso } from "../db.js";
import { ExtensionService } from "../extension-service.js";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-extension-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const account = createSourceAccount(db, { email: "source@outlook.com" });
  db.prepare("UPDATE source_accounts SET status = 'connected' WHERE id = ?").run(account.id);
  return {
    db,
    account: db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id),
    service: new ExtensionService(db, { apiKey: "test-key" }),
    close() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function createOfficialJob(db, accountId, target = 2) {
  const now = nowIso();
  return Number(db.prepare(`
    INSERT INTO automation_jobs (account_id, type, status, progress_target, config, created_at, updated_at)
    VALUES (?, 'official_fill', 'queued', ?, ?, ?, ?)
  `).run(accountId, target, JSON.stringify({ prefix: "case", mode: "sequence", label: "Test alias" }), now, now).lastInsertRowid);
}

test("runs an official alias task through taken and created results", () => {
  const current = fixture();
  try {
    const jobId = createOfficialJob(current.db, current.account.id, 2);
    const first = current.service.claimTask(current.account.email);
    assert.equal(first.id, jobId);
    current.service.report(jobId, { status: "taken" });

    const second = current.service.claimTask(current.account.email);
    assert.notEqual(second.address, first.address);
    let job = current.service.report(jobId, { status: "created", address: second.address });
    assert.equal(job.status, "running");
    assert.equal(job.progress_current, 1);

    const third = current.service.claimTask(current.account.email);
    job = current.service.report(jobId, { status: "created", address: third.address });
    assert.equal(job.status, "completed");
    assert.equal(job.progress_current, 2);
    const aliases = current.db.prepare("SELECT address FROM addresses WHERE account_id = ? AND kind = 'official' ORDER BY address").all(current.account.id);
    assert.deepEqual(aliases.map((item) => item.address), [second.address, third.address].sort());
  } finally {
    current.close();
  }
});

test("records provider limits and synchronizes aliases from Microsoft", () => {
  const current = fixture();
  try {
    const jobId = createOfficialJob(current.db, current.account.id, 3);
    current.service.claimTask(current.account.email);
    const limited = current.service.report(jobId, { status: "limited", message: "Try again next week" });
    assert.equal(limited.status, "limited");
    assert.equal(limited.stop_reason, "provider_limit");

    const result = current.service.syncAliases(current.account.email, ["source@outlook.com", "source.work@outlook.com"]);
    assert.equal(result.items.length, 2);
    assert.equal(result.account.official_aliases, 1);
    assert.equal(result.account.official_used, 2);
    assert.equal(result.items.find((item) => item.address === "source.work@outlook.com").remote_confirmed, 1);
  } finally {
    current.close();
  }
});

test("recalculates an active fill target after existing aliases are imported", () => {
  const current = fixture();
  try {
    const jobId = createOfficialJob(current.db, current.account.id, 9);
    current.service.syncAliases(current.account.email, [current.account.email, "source.work@outlook.com"]);
    const job = current.db.prepare("SELECT * FROM automation_jobs WHERE id = ?").get(jobId);
    assert.equal(job.progress_target, 8);
    assert.equal(job.status, "queued");
  } finally {
    current.close();
  }
});

test("exposes only the selected connector target with a prefilled Microsoft login URL", () => {
  const current = fixture();
  try {
    const second = createSourceAccount(current.db, { email: "second@hotmail.com" });
    const now = nowIso();
    current.db.prepare(`
      INSERT INTO addresses (account_id, address, kind, status, strategy, label, remote_confirmed, created_at, updated_at)
      VALUES (?, ?, 'official', 'active', 'official', 'Work', 1, ?, ?)
    `).run(current.account.id, "source.work@outlook.com", now, now);

    const launch = current.service.setTarget(current.account.id);
    const login = new URL(launch.officialUrl);
    assert.equal(login.origin, "https://login.live.com");
    assert.equal(login.pathname, "/login.srf");
    assert.equal(login.searchParams.get("id"), "38936");
    assert.equal(login.searchParams.get("wa"), "wsignin1.0");
    assert.equal(login.searchParams.get("wreply"), "https://account.live.com/names/manage");
    assert.equal(login.searchParams.get("username"), current.account.email);

    const accounts = current.service.accounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].id, current.account.id);
    assert.deepEqual(accounts[0].aliases, [current.account.email, "source.work@outlook.com"]);
    assert.equal(accounts.some((account) => account.id === second.id), false);
  } finally {
    current.close();
  }
});

test("falls back to the latest active official job when no connector target is selected", () => {
  const current = fixture();
  try {
    const second = createSourceAccount(current.db, { email: "latest@live.com" });
    createOfficialJob(current.db, current.account.id, 2);
    const latestJobId = createOfficialJob(current.db, second.id, 3);

    const accounts = current.service.accounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].id, second.id);
    assert.equal(accounts[0].jobId, latestJobId);
  } finally {
    current.close();
  }
});

test("rejects alias synchronization from a different Microsoft account", () => {
  const current = fixture();
  try {
    const second = createSourceAccount(current.db, { email: "other@msn.com" });
    assert.throws(
      () => current.service.syncAliases(current.account.email, [second.email, "other.alias@outlook.com"]),
      (error) => error.status === 409 && error.message.includes(current.account.email),
    );
    assert.equal(current.db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE account_id = ?").get(current.account.id).count, 1);
  } finally {
    current.close();
  }
});

test("claims only the job selected by the connector target", () => {
  const current = fixture();
  try {
    const other = createSourceAccount(current.db, { email: "other@outlook.com" });
    const olderJobId = createOfficialJob(current.db, current.account.id, 1);
    const selectedJobId = createOfficialJob(current.db, current.account.id, 2);
    createOfficialJob(current.db, other.id, 3);
    current.service.setTarget(current.account.id, selectedJobId);

    assert.equal(current.service.claimTask(other.email), null);
    const claimed = current.service.claimTask(current.account.email);
    assert.equal(claimed.id, selectedJobId);
    assert.notEqual(claimed.id, olderJobId);
  } finally {
    current.close();
  }
});

test("a cancelled or replaced connector job cannot be revived by a stale report", () => {
  const current = fixture();
  try {
    const oldJobId = createOfficialJob(current.db, current.account.id, 2);
    current.service.setTarget(current.account.id, oldJobId);
    current.service.claimTask(current.account.email);
    const now = nowIso();
    current.db.prepare("UPDATE automation_jobs SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, oldJobId);

    const newJobId = createOfficialJob(current.db, current.account.id, 2);
    current.service.setTarget(current.account.id, newJobId);
    assert.throws(
      () => current.service.report(oldJobId, { status: "taken" }),
      (error) => error.status === 409 && error.message.includes("已结束"),
    );
    assert.equal(current.db.prepare("SELECT status FROM automation_jobs WHERE id = ?").get(oldJobId).status, "cancelled");
    assert.equal(current.service.accounts()[0].jobId, newJobId);
  } finally {
    current.close();
  }
});
