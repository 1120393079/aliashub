import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase, createSourceAccount, nowIso } from "../db.js";
import { createApp } from "../index.js";
import { jsonRequest } from "./http-harness.js";

test("manual official alias imports merge existing aliases, enforce quota, and finish a filled job", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-official-import-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const account = createSourceAccount(db, { email: "source@outlook.com" });
  db.prepare("UPDATE source_accounts SET status = 'connected', official_limit = 3 WHERE id = ?").run(account.id);
  const now = nowIso();
  const jobId = Number(db.prepare(`
    INSERT INTO automation_jobs (account_id, type, status, progress_target, config, created_at, updated_at)
    VALUES (?, 'official_fill', 'queued', 2, '{}', ?, ?)
  `).run(account.id, now, now).lastInsertRowid);

  const previousAdminPassword = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  const runtime = createApp({ db, seedDemo: false, publicBaseUrl: "http://127.0.0.1" });
  if (previousAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = previousAdminPassword;
  await new Promise((resolve) => setImmediate(resolve));

  try {
    const first = await jsonRequest(runtime.app, `/api/accounts/${account.id}/official-aliases/import`, {
      method: "POST",
      body: JSON.stringify({ aliases: ["first@outlook.com"] }),
    });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.account.official_aliases, 1);
    assert.equal(first.body.account.official_remaining, 1);
    assert.deepEqual(db.prepare("SELECT status, progress_target FROM automation_jobs WHERE id = ?").get(jobId), {
      status: "waiting_user",
      progress_target: 1,
    });

    const second = await jsonRequest(runtime.app, `/api/accounts/${account.id}/official-aliases/import`, {
      method: "POST",
      body: JSON.stringify({ aliases: ["second@outlook.jp"] }),
    });
    assert.equal(second.response.status, 200);
    assert.equal(second.body.account.official_aliases, 2);
    assert.equal(second.body.account.official_remaining, 0);
    assert.deepEqual(second.body.items.map((item) => item.address).sort(), [
      "first@outlook.com",
      "second@outlook.jp",
      "source@outlook.com",
    ]);
    const completed = db.prepare("SELECT status, progress_current, progress_target, message, finished_at FROM automation_jobs WHERE id = ?").get(jobId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.progress_target, completed.progress_current);
    assert.equal(completed.message, "官方别名已经达到上限");
    assert.ok(completed.finished_at);

    const originalConsoleError = console.error;
    let overflow;
    try {
      console.error = () => {};
      overflow = await jsonRequest(runtime.app, `/api/accounts/${account.id}/official-aliases/import`, {
        method: "POST",
        body: JSON.stringify({ aliases: ["third@outlook.com"] }),
      });
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(overflow.response.status, 400);
    assert.equal(overflow.body.error, "这个账号最多登记 3 个基础地址");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE account_id = ? AND kind = 'official'").get(account.id).count, 2);
  } finally {
    runtime.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
