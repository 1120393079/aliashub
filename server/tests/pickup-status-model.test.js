import assert from "node:assert/strict";
import test from "node:test";
import { indexPickupStatuses, pickupAccountState } from "../../src/pages/registration/pickup-model.js";

test("pickup status model distinguishes inventory states from unlisted accounts", () => {
  const byEmail = indexPickupStatuses([
    { email: "Ready@Example.com", status: "ready", pickup_url: "https://pickup.example/ready" },
    { email: "sold@example.com", status: "sold" },
    { email: "disabled@example.com", status: "disabled" },
    { email: "ignored@example.com", status: "archived" },
  ]);
  const inventory = { loaded: true, byEmail, error: "" };

  assert.equal(pickupAccountState(inventory, "ready@example.com").label, "待销售");
  assert.equal(pickupAccountState(inventory, "SOLD@example.com").label, "已售出");
  assert.equal(pickupAccountState(inventory, "disabled@example.com").label, "已停用");
  assert.deepEqual(pickupAccountState(inventory, "missing@example.com"), {
    badge: "inactive",
    label: "未上架",
    item: null,
  });
  assert.equal(Object.hasOwn(byEmail, "ignored@example.com"), false);
});

test("pickup status model does not report unlisted while status lookup is unavailable", () => {
  assert.equal(pickupAccountState({ loaded: false, byEmail: {}, error: "" }, "mail@example.com").label, "读取中");
  assert.equal(pickupAccountState({ loaded: true, byEmail: {}, error: "offline" }, "mail@example.com").label, "状态未知");
});
