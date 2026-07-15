import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase, createSourceAccount, nowIso } from "../db.js";
import { createApp } from "../index.js";
import { jsonRequest } from "./http-harness.js";

function insertCode(db, accountId, addressId, { fingerprint, code, isUsed = false, isHidden = false }) {
  const now = nowIso();
  const result = db.prepare(`
    INSERT INTO verification_codes (
      account_id, address_id, fingerprint, code, sender, subject, preview,
      received_at, is_used, is_hidden, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accountId,
    addressId,
    fingerprint,
    code,
    "security@example.com",
    `Verification code ${code}`,
    `Use ${code} to continue`,
    now,
    isUsed ? 1 : 0,
    isHidden ? 1 : 0,
    now,
  );
  return Number(result.lastInsertRowid);
}

test("marking a verification code used recycles it and restoring resets it to unused", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-codes-state-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const account = createSourceAccount(db, { email: "state@outlook.com" });
  const addressId = db.prepare("SELECT id FROM addresses WHERE account_id = ? AND kind = 'primary'").get(account.id).id;
  const codeId = insertCode(db, account.id, addressId, {
    fingerprint: "state-code",
    code: "654321",
  });
  const previousAdminPassword = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  const runtime = createApp({ db, seedDemo: false, publicBaseUrl: "http://127.0.0.1" });
  if (previousAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = previousAdminPassword;
  await new Promise((resolve) => setImmediate(resolve));

  try {
    const marked = await jsonRequest(runtime.app, `/api/codes/${codeId}`, {
      method: "PATCH",
      body: JSON.stringify({ isUsed: true }),
    });
    assert.equal(marked.response.status, 200);
    assert.equal(marked.body.item.is_used, true);
    assert.equal(marked.body.item.is_hidden, true);
    assert.deepEqual(
      db.prepare("SELECT is_used, is_hidden FROM verification_codes WHERE id = ?").get(codeId),
      { is_used: 1, is_hidden: 1 },
    );

    const visible = await jsonRequest(runtime.app, "/api/codes");
    assert.deepEqual(visible.body.items, []);
    assert.equal(visible.body.total, 0);
    assert.equal(visible.body.used, 0);
    assert.equal(visible.body.hidden, 1);

    const recycleBin = await jsonRequest(runtime.app, "/api/codes?hidden=true");
    assert.deepEqual(recycleBin.body.items.map((item) => item.id), [codeId]);

    const restored = await jsonRequest(runtime.app, `/api/codes/${codeId}`, {
      method: "PATCH",
      body: JSON.stringify({ isHidden: false }),
    });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.body.item.is_used, false);
    assert.equal(restored.body.item.is_hidden, false);
    assert.deepEqual(
      db.prepare("SELECT is_used, is_hidden FROM verification_codes WHERE id = ?").get(codeId),
      { is_used: 0, is_hidden: 0 },
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("verification codes support hiding, restoring, bulk hiding, and permanent deletion", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-codes-api-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const firstAccount = createSourceAccount(db, { email: "first@outlook.com" });
  const secondAccount = createSourceAccount(db, { email: "second@hotmail.com" });
  const primaryAddress = db.prepare("SELECT id FROM addresses WHERE account_id = ? AND kind = 'primary'");
  const firstAddressId = primaryAddress.get(firstAccount.id).id;
  const secondAddressId = primaryAddress.get(secondAccount.id).id;
  const usedId = insertCode(db, firstAccount.id, firstAddressId, {
    fingerprint: "first-used",
    code: "111111",
    isUsed: true,
  });
  const unusedId = insertCode(db, firstAccount.id, firstAddressId, {
    fingerprint: "first-unused",
    code: "222222",
  });
  const otherUsedId = insertCode(db, secondAccount.id, secondAddressId, {
    fingerprint: "second-used",
    code: "333333",
    isUsed: true,
  });

  const previousAdminPassword = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  const runtime = createApp({ db, seedDemo: false, publicBaseUrl: "http://127.0.0.1" });
  if (previousAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = previousAdminPassword;
  const baseUrl = runtime.app;
  await new Promise((resolve) => setImmediate(resolve));

  try {
    await t.test("hiding a used code removes it from the default list", async () => {
      const hidden = await jsonRequest(baseUrl, `/api/codes/${usedId}`, {
        method: "PATCH",
        body: JSON.stringify({ isHidden: true }),
      });
      assert.equal(hidden.response.status, 200);
      assert.equal(hidden.body.item.is_hidden, true);

      const visible = await jsonRequest(baseUrl, "/api/codes");
      assert.equal(visible.response.status, 200);
      assert.deepEqual(visible.body.items.map((item) => item.id).sort((a, b) => a - b), [unusedId, otherUsedId].sort((a, b) => a - b));
      assert.equal(visible.body.total, 2);
      assert.equal(visible.body.hidden, 1);
    });

    await t.test("hidden=true returns the hidden code", async () => {
      const hidden = await jsonRequest(baseUrl, "/api/codes?hidden=true");
      assert.equal(hidden.response.status, 200);
      assert.deepEqual(hidden.body.items.map((item) => item.id), [usedId]);
      assert.equal(hidden.body.items[0].is_hidden, true);
    });

    await t.test("restoring a code makes it unused and visible again", async () => {
      const restored = await jsonRequest(baseUrl, `/api/codes/${usedId}`, {
        method: "PATCH",
        body: JSON.stringify({ isHidden: false }),
      });
      assert.equal(restored.response.status, 200);
      assert.equal(restored.body.item.is_used, false);
      assert.equal(restored.body.item.is_hidden, false);

      const visible = await jsonRequest(baseUrl, "/api/codes");
      assert.equal(visible.body.items.some((item) => item.id === usedId), true);
      assert.equal(visible.body.total, 3);
      assert.equal(visible.body.hidden, 0);
    });

    await t.test("an unused code cannot be hidden", async () => {
      const originalConsoleError = console.error;
      let result;
      try {
        console.error = () => {};
        result = await jsonRequest(baseUrl, `/api/codes/${unusedId}`, {
          method: "PATCH",
          body: JSON.stringify({ isHidden: true }),
        });
      } finally {
        console.error = originalConsoleError;
      }
      assert.equal(result.response.status, 409);
      assert.equal(result.body.error, "请先将验证码标记为已用");
      const stored = db.prepare("SELECT is_used, is_hidden FROM verification_codes WHERE id = ?").get(unusedId);
      assert.deepEqual(stored, { is_used: 0, is_hidden: 0 });
    });

    await t.test("code state updates require JSON booleans", async () => {
      const originalConsoleError = console.error;
      try {
        console.error = () => {};
        const invalidUsed = await jsonRequest(baseUrl, `/api/codes/${unusedId}`, {
          method: "PATCH",
          body: JSON.stringify({ isUsed: "true" }),
        });
        assert.equal(invalidUsed.response.status, 400);
        assert.equal(invalidUsed.body.error, "isUsed 必须是布尔值");

        const invalidHidden = await jsonRequest(baseUrl, `/api/codes/${usedId}`, {
          method: "PATCH",
          body: JSON.stringify({ isHidden: 1 }),
        });
        assert.equal(invalidHidden.response.status, 400);
        assert.equal(invalidHidden.body.error, "isHidden 必须是布尔值");
      } finally {
        console.error = originalConsoleError;
      }

      const rows = db.prepare("SELECT id, is_used, is_hidden FROM verification_codes WHERE id IN (?, ?) ORDER BY id").all(unusedId, usedId);
      assert.deepEqual(rows, [
        { id: usedId, is_used: 0, is_hidden: 0 },
        { id: unusedId, is_used: 0, is_hidden: 0 },
      ]);
    });

    await t.test("conflicting used filters are rejected", async () => {
      const originalConsoleError = console.error;
      let result;
      try {
        console.error = () => {};
        result = await jsonRequest(baseUrl, "/api/codes?unused=true&used=true");
      } finally {
        console.error = originalConsoleError;
      }
      assert.equal(result.response.status, 400);
      assert.equal(result.body.error, "不能同时筛选未使用和已使用验证码");
    });

    await t.test("bulk hiding rejects missing and invalid account scopes", async () => {
      const cases = [undefined, "", "0", "invalid", true];
      const originalConsoleError = console.error;
      try {
        console.error = () => {};
        for (const accountId of cases) {
          const result = await jsonRequest(baseUrl, "/api/codes/hide-used", {
            method: "POST",
            ...(accountId === undefined ? {} : { body: JSON.stringify({ accountId }) }),
          });
          assert.equal(result.response.status, 400);
          assert.equal(result.body.error, "请选择有效的源头邮箱");
        }

        const missingAccount = await jsonRequest(baseUrl, "/api/codes/hide-used", {
          method: "POST",
          body: JSON.stringify({ accountId: 999_999 }),
        });
        assert.equal(missingAccount.response.status, 404);
        assert.equal(missingAccount.body.error, "源头邮箱不存在");
      } finally {
        console.error = originalConsoleError;
      }

      const hiddenCount = db.prepare("SELECT COUNT(*) AS count FROM verification_codes WHERE is_hidden = 1").get().count;
      assert.equal(hiddenCount, 0);
    });

    await t.test("bulk hiding affects only used codes in the selected account", async () => {
      db.prepare("UPDATE verification_codes SET is_used = 1, is_hidden = 0 WHERE id = ?").run(usedId);
      const result = await jsonRequest(baseUrl, "/api/codes/hide-used", {
        method: "POST",
        body: JSON.stringify({ accountId: firstAccount.id }),
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.hidden, 1);

      const rows = db.prepare("SELECT id, is_hidden FROM verification_codes ORDER BY id").all();
      assert.deepEqual(rows, [
        { id: usedId, is_hidden: 1 },
        { id: unusedId, is_hidden: 0 },
        { id: otherUsedId, is_hidden: 0 },
      ]);
      const visible = await jsonRequest(baseUrl, `/api/codes?accountId=${firstAccount.id}`);
      assert.deepEqual(visible.body.items.map((item) => item.id), [unusedId]);
      assert.equal(visible.body.used, 0);
      assert.equal(visible.body.unused, 1);
      assert.equal(visible.body.hidden, 1);
    });

    await t.test("bulk hiding reports actual changes and audits each affected account", async () => {
      const repeated = await jsonRequest(baseUrl, "/api/codes/hide-used", {
        method: "POST",
        body: JSON.stringify({ accountId: String(firstAccount.id) }),
      });
      assert.equal(repeated.response.status, 200);
      assert.equal(repeated.body.hidden, 0);

      const global = await jsonRequest(baseUrl, "/api/codes/hide-used", {
        method: "POST",
        body: JSON.stringify({ accountId: "all" }),
      });
      assert.equal(global.response.status, 200);
      assert.equal(global.body.hidden, 1);

      const rows = db.prepare("SELECT id, is_hidden FROM verification_codes ORDER BY id").all();
      assert.deepEqual(rows, [
        { id: usedId, is_hidden: 1 },
        { id: unusedId, is_hidden: 0 },
        { id: otherUsedId, is_hidden: 1 },
      ]);
      const audits = db.prepare(`
        SELECT account_id, COUNT(*) AS count
        FROM audit_log
        WHERE title = '隐藏已用验证码'
        GROUP BY account_id
        ORDER BY account_id
      `).all();
      assert.deepEqual(audits, [
        { account_id: firstAccount.id, count: 1 },
        { account_id: secondAccount.id, count: 1 },
      ]);
    });

    await t.test("permanent deletion rejects invalid, missing, and visible codes", async () => {
      const originalConsoleError = console.error;
      try {
        console.error = () => {};
        const invalid = await jsonRequest(baseUrl, "/api/codes/not-an-id", { method: "DELETE" });
        assert.equal(invalid.response.status, 400);
        assert.equal(invalid.body.error, "请选择有效的验证码");

        const missing = await jsonRequest(baseUrl, "/api/codes/999999", { method: "DELETE" });
        assert.equal(missing.response.status, 404);
        assert.equal(missing.body.error, "验证码不存在");

        const visible = await jsonRequest(baseUrl, `/api/codes/${unusedId}`, { method: "DELETE" });
        assert.equal(visible.response.status, 409);
        assert.equal(visible.body.error, "只能永久删除回收站中的验证码");
      } finally {
        console.error = originalConsoleError;
      }
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM verification_codes").get().count, 3);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM verification_code_tombstones").get().count, 0);
    });

    await t.test("permanent deletion removes content and prevents the same fingerprint from returning", async () => {
      const deleted = await jsonRequest(baseUrl, `/api/codes/${usedId}`, { method: "DELETE" });
      assert.equal(deleted.response.status, 200);
      assert.deepEqual(deleted.body, { deleted: 1 });
      assert.equal(db.prepare("SELECT 1 FROM verification_codes WHERE id = ?").get(usedId), undefined);
      assert.deepEqual(
        db.prepare("SELECT fingerprint, account_id FROM verification_code_tombstones WHERE fingerprint = ?").get("first-used"),
        { fingerprint: "first-used", account_id: firstAccount.id },
      );

      insertCode(db, firstAccount.id, firstAddressId, {
        fingerprint: "first-used",
        code: "111111",
        isUsed: true,
      });
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM verification_codes WHERE fingerprint = ?").get("first-used").count, 0);

      const deletionAudit = db.prepare("SELECT detail, metadata FROM audit_log WHERE title = '永久删除验证码' ORDER BY id DESC LIMIT 1").get();
      assert.equal(deletionAudit.detail.includes("111111"), false);
      assert.deepEqual(JSON.parse(deletionAudit.metadata), { count: 1, codeId: usedId });

      const originalConsoleError = console.error;
      let repeated;
      try {
        console.error = () => {};
        repeated = await jsonRequest(baseUrl, `/api/codes/${usedId}`, { method: "DELETE" });
      } finally {
        console.error = originalConsoleError;
      }
      assert.equal(repeated.response.status, 404);
    });

    await t.test("purging the recycle bin validates account and search scopes", async () => {
      const originalConsoleError = console.error;
      try {
        console.error = () => {};
        for (const accountId of [undefined, "", "0", "invalid", true]) {
          const result = await jsonRequest(baseUrl, "/api/codes/purge-hidden", {
            method: "POST",
            ...(accountId === undefined ? {} : { body: JSON.stringify({ accountId }) }),
          });
          assert.equal(result.response.status, 400);
          assert.equal(result.body.error, "请选择有效的源头邮箱");
        }

        const missingAccount = await jsonRequest(baseUrl, "/api/codes/purge-hidden", {
          method: "POST",
          body: JSON.stringify({ accountId: 999_999 }),
        });
        assert.equal(missingAccount.response.status, 404);
        assert.equal(missingAccount.body.error, "源头邮箱不存在");

        const invalidQuery = await jsonRequest(baseUrl, "/api/codes/purge-hidden", {
          method: "POST",
          body: JSON.stringify({ accountId: "all", q: true }),
        });
        assert.equal(invalidQuery.response.status, 400);
        assert.equal(invalidQuery.body.error, "q 必须是字符串");

        const longQuery = await jsonRequest(baseUrl, "/api/codes/purge-hidden", {
          method: "POST",
          body: JSON.stringify({ accountId: "all", q: "x".repeat(201) }),
        });
        assert.equal(longQuery.response.status, 400);
        assert.equal(longQuery.body.error, "搜索关键词最多 200 个字符");
      } finally {
        console.error = originalConsoleError;
      }
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM verification_codes WHERE is_hidden = 1").get().count, 1);
    });

    await t.test("purging respects account and search filters and audits actual deletions", async () => {
      const matchingId = insertCode(db, firstAccount.id, firstAddressId, {
        fingerprint: "first-bulk-matching",
        code: "444444",
        isUsed: true,
      });
      const otherFirstId = insertCode(db, firstAccount.id, firstAddressId, {
        fingerprint: "first-bulk-other",
        code: "555555",
        isUsed: true,
      });
      db.prepare("UPDATE verification_codes SET is_hidden = 1 WHERE id IN (?, ?)").run(matchingId, otherFirstId);

      const filtered = await jsonRequest(baseUrl, "/api/codes/purge-hidden", {
        method: "POST",
        body: JSON.stringify({ accountId: firstAccount.id, q: "444444" }),
      });
      assert.equal(filtered.response.status, 200);
      assert.deepEqual(filtered.body, { deleted: 1 });
      assert.equal(db.prepare("SELECT 1 FROM verification_codes WHERE id = ?").get(matchingId), undefined);
      assert.equal(db.prepare("SELECT is_hidden FROM verification_codes WHERE id = ?").get(otherFirstId).is_hidden, 1);
      assert.equal(db.prepare("SELECT is_hidden FROM verification_codes WHERE id = ?").get(otherUsedId).is_hidden, 1);
      assert.equal(db.prepare("SELECT is_hidden FROM verification_codes WHERE id = ?").get(unusedId).is_hidden, 0);

      const currentAccount = await jsonRequest(baseUrl, `/api/codes?hidden=true&accountId=${firstAccount.id}&q=444444`);
      assert.equal(currentAccount.response.status, 200);
      assert.deepEqual(currentAccount.body.items, []);
      assert.equal(currentAccount.body.hidden, 0);

      const firstOnly = await jsonRequest(baseUrl, "/api/codes/purge-hidden", {
        method: "POST",
        body: JSON.stringify({ accountId: String(firstAccount.id), q: "" }),
      });
      assert.deepEqual(firstOnly.body, { deleted: 1 });
      assert.equal(db.prepare("SELECT is_hidden FROM verification_codes WHERE id = ?").get(otherUsedId).is_hidden, 1);

      const remaining = await jsonRequest(baseUrl, "/api/codes/purge-hidden", {
        method: "POST",
        body: JSON.stringify({ accountId: "all" }),
      });
      assert.deepEqual(remaining.body, { deleted: 1 });
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM verification_codes WHERE is_hidden = 1").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM verification_codes WHERE id = ?").get(unusedId).count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM verification_code_tombstones").get().count, 4);

      const auditsBeforeEmptyPurge = db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE title = '清空验证码回收站'").get().count;
      const empty = await jsonRequest(baseUrl, "/api/codes/purge-hidden", {
        method: "POST",
        body: JSON.stringify({ accountId: "all" }),
      });
      assert.deepEqual(empty.body, { deleted: 0 });
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE title = '清空验证码回收站'").get().count, auditsBeforeEmptyPurge);

      const purgeAudits = db.prepare(`
        SELECT account_id, COUNT(*) AS entries, SUM(json_extract(metadata, '$.count')) AS deleted
        FROM audit_log
        WHERE title = '清空验证码回收站'
        GROUP BY account_id
        ORDER BY account_id
      `).all();
      assert.deepEqual(purgeAudits, [
        { account_id: firstAccount.id, entries: 2, deleted: 2 },
        { account_id: secondAccount.id, entries: 1, deleted: 1 },
      ]);
    });
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("bulk marking verification codes used respects account and search scopes", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-codes-mark-used-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const firstAccount = createSourceAccount(db, { email: "first@outlook.com" });
  const secondAccount = createSourceAccount(db, { email: "second@hotmail.com" });
  const primaryAddress = db.prepare("SELECT id FROM addresses WHERE account_id = ? AND kind = 'primary'");
  const firstAddressId = primaryAddress.get(firstAccount.id).id;
  const secondAddressId = primaryAddress.get(secondAccount.id).id;
  const firstMatchingId = insertCode(db, firstAccount.id, firstAddressId, {
    fingerprint: "first-matching",
    code: "111111",
  });
  const firstOtherId = insertCode(db, firstAccount.id, firstAddressId, {
    fingerprint: "first-other",
    code: "222222",
  });
  const secondId = insertCode(db, secondAccount.id, secondAddressId, {
    fingerprint: "second-matching",
    code: "333333",
  });
  const hiddenId = insertCode(db, secondAccount.id, secondAddressId, {
    fingerprint: "second-hidden",
    code: "444444",
    isHidden: true,
  });
  const alreadyUsedId = insertCode(db, secondAccount.id, secondAddressId, {
    fingerprint: "second-used",
    code: "555555",
    isUsed: true,
    isHidden: true,
  });

  const previousAdminPassword = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  const runtime = createApp({ db, seedDemo: false, publicBaseUrl: "http://127.0.0.1" });
  if (previousAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = previousAdminPassword;
  const baseUrl = runtime.app;
  await new Promise((resolve) => setImmediate(resolve));

  try {
    await t.test("validates account and search scopes", async () => {
      const originalConsoleError = console.error;
      try {
        console.error = () => {};
        for (const accountId of [undefined, "", "0", "invalid", true]) {
          const result = await jsonRequest(baseUrl, "/api/codes/mark-used", {
            method: "POST",
            ...(accountId === undefined ? {} : { body: JSON.stringify({ accountId }) }),
          });
          assert.equal(result.response.status, 400);
          assert.equal(result.body.error, "请选择有效的源头邮箱");
        }

        const missingAccount = await jsonRequest(baseUrl, "/api/codes/mark-used", {
          method: "POST",
          body: JSON.stringify({ accountId: 999_999 }),
        });
        assert.equal(missingAccount.response.status, 404);
        assert.equal(missingAccount.body.error, "源头邮箱不存在");

        const invalidQuery = await jsonRequest(baseUrl, "/api/codes/mark-used", {
          method: "POST",
          body: JSON.stringify({ accountId: "all", q: true }),
        });
        assert.equal(invalidQuery.response.status, 400);
        assert.equal(invalidQuery.body.error, "q 必须是字符串");

        const longQuery = await jsonRequest(baseUrl, "/api/codes/mark-used", {
          method: "POST",
          body: JSON.stringify({ accountId: "all", q: "x".repeat(201) }),
        });
        assert.equal(longQuery.response.status, 400);
        assert.equal(longQuery.body.error, "搜索关键词最多 200 个字符");
      } finally {
        console.error = originalConsoleError;
      }
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM verification_codes WHERE is_used = 1").get().count, 1);
    });

    await t.test("marks only unused visible codes in the current filtered account", async () => {
      const filtered = await jsonRequest(baseUrl, "/api/codes/mark-used", {
        method: "POST",
        body: JSON.stringify({ accountId: firstAccount.id, q: "111111" }),
      });
      assert.equal(filtered.response.status, 200);
      assert.deepEqual(filtered.body, { marked: 1 });

      const rows = db.prepare("SELECT id, is_used, is_hidden FROM verification_codes ORDER BY id").all();
      assert.deepEqual(rows, [
        { id: firstMatchingId, is_used: 1, is_hidden: 1 },
        { id: firstOtherId, is_used: 0, is_hidden: 0 },
        { id: secondId, is_used: 0, is_hidden: 0 },
        { id: hiddenId, is_used: 0, is_hidden: 1 },
        { id: alreadyUsedId, is_used: 1, is_hidden: 1 },
      ]);

      const visible = await jsonRequest(baseUrl, "/api/codes");
      assert.deepEqual(visible.body.items.map((item) => item.id).sort((a, b) => a - b), [firstOtherId, secondId].sort((a, b) => a - b));
      assert.equal(visible.body.used, 0);

      const auditRow = db.prepare("SELECT account_id, detail, metadata FROM audit_log WHERE title = '批量标记验证码已用'").get();
      assert.equal(auditRow.account_id, firstAccount.id);
      assert.equal(auditRow.detail, "共标记 1 条");
      assert.deepEqual(JSON.parse(auditRow.metadata), { count: 1, filtered: true });

      const repeated = await jsonRequest(baseUrl, "/api/codes/mark-used", {
        method: "POST",
        body: JSON.stringify({ accountId: String(firstAccount.id), q: "111111" }),
      });
      assert.deepEqual(repeated.body, { marked: 0 });
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE title = '批量标记验证码已用'").get().count, 1);
    });

    await t.test("marks all remaining visible unused codes and audits each account", async () => {
      const global = await jsonRequest(baseUrl, "/api/codes/mark-used", {
        method: "POST",
        body: JSON.stringify({ accountId: "all" }),
      });
      assert.equal(global.response.status, 200);
      assert.deepEqual(global.body, { marked: 2 });

      const rows = db.prepare("SELECT id, is_used, is_hidden FROM verification_codes ORDER BY id").all();
      assert.deepEqual(rows, [
        { id: firstMatchingId, is_used: 1, is_hidden: 1 },
        { id: firstOtherId, is_used: 1, is_hidden: 1 },
        { id: secondId, is_used: 1, is_hidden: 1 },
        { id: hiddenId, is_used: 0, is_hidden: 1 },
        { id: alreadyUsedId, is_used: 1, is_hidden: 1 },
      ]);

      const visible = await jsonRequest(baseUrl, "/api/codes");
      assert.deepEqual(visible.body.items, []);
      assert.equal(visible.body.total, 0);
      assert.equal(visible.body.hidden, 5);

      const audits = db.prepare(`
        SELECT account_id, SUM(json_extract(metadata, '$.count')) AS marked
        FROM audit_log
        WHERE title = '批量标记验证码已用'
        GROUP BY account_id
        ORDER BY account_id
      `).all();
      assert.deepEqual(audits, [
        { account_id: firstAccount.id, marked: 2 },
        { account_id: secondAccount.id, marked: 1 },
      ]);
    });
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
