import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deleteSplitAddresses, generateSplits } from "../account-service.js";
import { createDatabase, createSourceAccount, nowIso } from "../db.js";

test("generates splits for every selected base address", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  try {
    const account = createSourceAccount(db, { email: "source@hotmail.com" });
    const now = nowIso();
    db.prepare(`INSERT INTO addresses (account_id, address, kind, status, strategy, label, remote_confirmed, created_at, updated_at) VALUES (?, ?, 'official', 'active', 'official', '官方别名', 1, ?, ?)`)
      .run(account.id, "source.work@outlook.com", now, now);
    const bases = db.prepare("SELECT id FROM addresses WHERE account_id = ? AND kind IN ('primary', 'official')").all(account.id);
    const created = generateSplits(db, account, { baseAddressIds: bases.map((item) => item.id), countPerBase: 3, prefix: "case", mode: "sequence" });
    assert.equal(created.length, 6);
    assert.equal(new Set(created.map((item) => item.parent_address)).size, 2);
    assert.ok(created.every((item) => item.address.includes("+case-")));
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("bulk deletes only split addresses and is idempotent", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-delete-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  try {
    const account = createSourceAccount(db, { email: "source@outlook.com" });
    const created = generateSplits(db, account, { countPerBase: 4, prefix: "remove", mode: "sequence" });
    const selected = deleteSplitAddresses(db, { ids: created.slice(0, 2).map((item) => item.id), accountId: account.id });
    assert.equal(selected.deleted, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE account_id = ? AND kind = 'split'").get(account.id).count, 2);
    assert.equal(deleteSplitAddresses(db, { ids: created.slice(0, 2).map((item) => item.id), accountId: account.id }).deleted, 0);

    const remaining = deleteSplitAddresses(db, { accountId: account.id, all: true });
    assert.equal(remaining.deleted, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE account_id = ?").get(account.id).count, 1);
    assert.equal(db.prepare("SELECT kind FROM addresses WHERE account_id = ?").get(account.id).kind, "primary");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("custom split suffixes are exact for one address and numbered for batches", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-custom-split-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  try {
    const account = createSourceAccount(db, { email: "source@outlook.com" });
    const single = generateSplits(db, account, { countPerBase: 1, prefix: "gpt", customSuffix: "Campaign" });
    assert.equal(single[0].address, "source+gpt-campaign@outlook.com");

    const batch = generateSplits(db, account, { countPerBase: 3, prefix: "gpt", customSuffix: "batch" });
    assert.deepEqual(batch.map((item) => item.address), [
      "source+gpt-batch-01@outlook.com",
      "source+gpt-batch-02@outlook.com",
      "source+gpt-batch-03@outlook.com",
    ]);
    assert.throws(
      () => generateSplits(db, account, { countPerBase: 1, prefix: "gpt", customSuffix: "Campaign" }),
      (error) => error.status === 409 && /已存在/.test(error.message),
    );
    assert.throws(
      () => generateSplits(db, account, { countPerBase: 1, prefix: "gpt", customSuffix: "中文" }),
      (error) => error.status === 400 && /自定义后缀/.test(error.message),
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
