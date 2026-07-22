import assert from "node:assert/strict";
import test from "node:test";
import { planAgentIdentityBulk, runAgentIdentityBulk } from "../../src/agent-identity-bulk.js";

test("bulk planner queues every safe token account and blocks incomplete selections", () => {
  const accounts = [
    { id: 1, email: "durable@example.com", access_token_available: true, nfapi_status: "imported" },
    { id: 6, email: "linked@example.com", access_token_available: true, nfapi: { linked: true } },
    { id: 2, email: "short@example.com", access_token_available: true, nfapi_status: "imported", nfapi_short_lived: true },
    { id: 3, email: "failed@example.com", access_token_available: true, nfapi_status: "failed", nfapi_error: "retry" },
    { id: 4, email: "missing-at@example.com", access_token_available: false, nfapi_status: "not_imported" },
    { id: 5, email: "oauth@example.com", access_token_available: true, nfapi_status: "pending" },
  ];

  const plan = planAgentIdentityBulk(accounts, [1, 6, 2, 3, 4, 5, 5, 99]);

  assert.equal(plan.total, 7);
  assert.deepEqual(plan.ids, ["1", "6", "2", "3", "4", "5", "99"]);
  assert.deepEqual(plan.actionable.map((item) => item.id), [1, 6, 2, 3]);
  assert.deepEqual(plan.blocked.map((item) => String(item.id)), ["4", "5", "99"]);
  assert.match(plan.blocked[0].reason, /没有可用 AT/);
  assert.match(plan.blocked[1].reason, /正在进行 OAuth/);
  assert.match(plan.blocked[2].reason, /已不存在/);
});

test("bulk runner is serial, continues after failures, and reports every result", async () => {
  const items = [{ id: 11 }, { id: 12 }, { id: 13 }, { id: 14 }];
  const order = [];
  const snapshots = [];
  let active = 0;
  let maximumActive = 0;

  const result = await runAgentIdentityBulk(items, {
    async importAccount(item) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(item.id);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (item.id === 12) throw new Error("upstream rejected");
      if (item.id === 13) return { action: "skipped" };
      if (item.id === 11) return { action: "created" };
      return { action: "updated" };
    },
    onProgress(progress) { snapshots.push(progress); },
  });

  assert.equal(maximumActive, 1);
  assert.deepEqual(order, [11, 12, 13, 14]);
  assert.deepEqual({
    total: result.total,
    current: result.current,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    failed: result.failed,
  }, { total: 4, current: 4, created: 1, updated: 1, skipped: 1, failed: 1 });
  assert.deepEqual(result.completedIds, ["11", "13", "14"]);
  assert.deepEqual(result.failedIds, ["12"]);
  assert.equal(result.errors[0].message, "upstream rejected");
  assert.deepEqual(snapshots.map((item) => item.current), [0, 1, 2, 3, 4]);
  assert.equal(Object.hasOwn(snapshots.at(-1), "errors"), false);
});

test("bulk runner fails closed when NFapi returns an unknown action", async () => {
  const result = await runAgentIdentityBulk([{ id: 21 }, { id: 22 }, { id: 23 }], {
    async importAccount(item) {
      if (item.id === 21) return {};
      if (item.id === 22) return { action: "imported" };
      return { action: "created" };
    },
  });

  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.failed, 2);
  assert.deepEqual(result.completedIds, ["23"]);
  assert.deepEqual(result.failedIds, ["21", "22"]);
  assert.match(result.errors[0].message, /未知操作结果：empty/);
  assert.match(result.errors[1].message, /未知操作结果：imported/);
});
