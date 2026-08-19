import assert from "node:assert/strict";
import test from "node:test";
import { indexPickupStatuses, pickupAccountState } from "../../src/pages/registration/pickup-model.js";
import {
  baseOptionLabel,
  directRegistrationBases,
  preferredBase,
  registrationBaseOptions,
  accountPlusDate,
  sortRegisteredAccounts,
} from "../../src/pages/registration/registration-model.js";

test("registered account list sorts Plus accounts by Plus confirmation time", () => {
  const items = sortRegisteredAccounts([
    { id: 1, account_type: "plus", plus_at: "2026-08-13T10:00:00Z", created_at: "2026-08-14T10:00:00Z" },
    { id: 2, account_type: "plus", plus_at: "2026-08-14T09:00:00Z", created_at: "2026-08-12T10:00:00Z" },
    { id: 3, account_type: "free", created_at: "2026-08-14T11:00:00Z" },
  ]);
  assert.deepEqual(items.map((item) => item.id), [2, 1, 3]);
  assert.equal(accountPlusDate(items[0]), "2026-08-14T09:00:00Z");
});

test("registered account sorting never substitutes detection, mail, or creation time for Plus time", () => {
  const items = sortRegisteredAccounts([
    { id: 1, account_type: "plus", plus_at: "2026-08-13T10:00:00Z", created_at: "2026-08-14T10:00:00Z" },
    { id: 2, account_type: "plus", mail_plus_confirmed_at: "2026-08-15T10:00:00Z", status_checked_at: "2026-08-15T11:00:00Z", created_at: "2026-08-15T12:00:00Z" },
    { id: 3, account_type: "plus", plus_at: "2026-08-14T09:00:00Z", created_at: "2026-08-12T10:00:00Z" },
  ]);
  assert.deepEqual(items.map((item) => item.id), [3, 1, 2]);
  assert.equal(accountPlusDate(items[2]), "");
});

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
      { id: 2, address: "ready@icloud.com", strategy: "icloud_hide_my_email", pickup_status: "ready", registration_state: "pickup_listed", registration_disabled: true },
      { id: 1, address: "available@icloud.com", strategy: "icloud_hide_my_email", registration_disabled: false },
      { id: 3, address: "sold@icloud.com", strategy: "icloud_hide_my_email", pickup_status: "sold", registration_state: "pickup_listed", registration_disabled: true },
      { id: 4, address: "disabled@icloud.com", strategy: "icloud_hide_my_email", pickup_status: "disabled", registration_state: "pickup_listed", registration_disabled: true },
      { id: 6, address: "used@icloud.com", strategy: "icloud_hide_my_email", registration_state: "used", registration_disabled: true },
      { id: 5, address: "later@icloud.com", strategy: "icloud_hide_my_email", registration_disabled: false },
    ],
  };

  assert.deepEqual(registrationBaseOptions(account).map((item) => item.id), [1, 5]);
  assert.equal(preferredBase(account).id, 1);
  assert.deepEqual(directRegistrationBases(account, 1).map((item) => item.id), [1, 5]);
  assert.match(baseOptionLabel(account.bases[0]), /取件站待销售 · 禁止注册/);
  assert.match(baseOptionLabel(account.bases[2]), /取件站已售出 · 禁止注册/);
  assert.match(baseOptionLabel(account.bases[3]), /取件站已停用 · 禁止注册/);
  assert.match(baseOptionLabel(account.bases[4]), /已用于注册/);
});

test("registration option labels mark addresses with failed registration history", () => {
  assert.equal(baseOptionLabel({
    address: "failed@icloud.com",
    strategy: "icloud_hide_my_email",
    registration_failure_count: 1,
  }), "failed@icloud.com（隐藏邮箱 · 注册失败）");
  assert.equal(baseOptionLabel({
    address: "retried@icloud.com",
    strategy: "icloud_hide_my_email",
    registration_failure_count: 3,
  }), "retried@icloud.com（隐藏邮箱 · 注册失败 3 次）");
});
