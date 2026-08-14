import assert from "node:assert/strict";
import test from "node:test";
import { indexPickupStatuses, pickupAccountState } from "../../src/pages/registration/pickup-model.js";
import { baseOptionLabel, directRegistrationBases } from "../../src/pages/registration/registration-model.js";

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

test("registration options exclude and label every mailbox still present in pickup inventory", () => {
  const account = {
    registration_mode: "direct",
    bases: [
      { id: 1, address: "available@icloud.com", strategy: "icloud_hide_my_email", registration_disabled: false },
      { id: 2, address: "ready@icloud.com", strategy: "icloud_hide_my_email", pickup_status: "ready", registration_state: "pickup_listed", registration_disabled: true },
      { id: 3, address: "sold@icloud.com", strategy: "icloud_hide_my_email", pickup_status: "sold", registration_state: "pickup_listed", registration_disabled: true },
      { id: 4, address: "disabled@icloud.com", strategy: "icloud_hide_my_email", pickup_status: "disabled", registration_state: "pickup_listed", registration_disabled: true },
      { id: 5, address: "later@icloud.com", strategy: "icloud_hide_my_email", registration_disabled: false },
    ],
  };

  assert.deepEqual(directRegistrationBases(account, 1).map((item) => item.id), [1, 5]);
  assert.match(baseOptionLabel(account.bases[1]), /取件站待销售 · 禁止注册/);
  assert.match(baseOptionLabel(account.bases[2]), /取件站已售出 · 禁止注册/);
  assert.match(baseOptionLabel(account.bases[3]), /取件站已停用 · 禁止注册/);
});
