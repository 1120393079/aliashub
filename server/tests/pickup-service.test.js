import assert from "node:assert/strict";
import test from "node:test";
import { PickupService } from "../pickup-service.js";

function accounts() {
  return {
    total: 2,
    items: [
      {
        id: 101,
        email: "base+gpt-one@outlook.com",
        password: "password-one",
        password_available: true,
        account_type: "plus",
        group_name: "Plus 套餐",
        custom_name: "商品一",
      },
      {
        id: 102,
        email: "alias-two@icloud.com",
        password: "",
        password_available: false,
        account_type: "free",
        group_name: "Free 套餐",
      },
    ],
  };
}

test("imports selected registered accounts into Mail Pickup", async () => {
  let request;
  const service = new PickupService({
    registration: { listRegisteredAccounts: async () => accounts() },
    baseUrl: "http://127.0.0.1:4190",
    publicUrl: "https://pickup.example.com",
    username: "admin",
    password: "secret-password",
    fetchFn: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      const items = request.body.items.map((item, index) => ({
        id: index + 1,
        email: item.email,
        pickup_url: `https://pickup.example.com/?token=token-${index + 1}`,
        delivery_line: `账号：${item.email}----取件链接：token-${index + 1}`,
      }));
      return new Response(JSON.stringify({ items }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await service.importRegisteredAccounts({ ids: [101, 102] });
  assert.equal(request.url, "http://127.0.0.1:4190/api/admin/mailboxes");
  assert.match(request.options.headers.Authorization, /^Basic /);
  assert.equal(request.body.upsert, true);
  assert.deepEqual(request.body.items.map((item) => item.email), [
    "base+gpt-one@outlook.com",
    "alias-two@icloud.com",
  ]);
  assert.equal(request.body.items[0].password, "password-one");
  assert.equal(request.body.items[1].password, "");
  assert.equal(result.imported, 2);
  assert.equal(result.with_password, 1);
  assert.equal(result.without_password, 1);
  assert.match(result.delivery_text, /base\+gpt-one@outlook\.com/);
});

test("rejects accounts outside the current registration list", async () => {
  const service = new PickupService({
    registration: { listRegisteredAccounts: async () => accounts() },
    password: "secret-password",
    fetchFn: async () => { throw new Error("should not fetch"); },
  });
  await assert.rejects(
    service.importRegisteredAccounts({ ids: [999] }),
    (error) => error.status === 409 && /不属于/.test(error.message),
  );
});

test("requires at least one account id", async () => {
  const service = new PickupService({
    registration: { listRegisteredAccounts: async () => accounts() },
    password: "secret-password",
  });
  await assert.rejects(
    service.importRegisteredAccounts({ ids: [] }),
    (error) => error.status === 400 && /请选择/.test(error.message),
  );
});

test("stays disabled until a service URL is explicitly configured", async () => {
  const service = new PickupService({
    registration: { listRegisteredAccounts: async () => accounts() },
    password: "secret-password",
  });
  assert.deepEqual(service.configuration(), {
    enabled: false,
    public_url: "",
    admin_url: "",
  });
  await assert.rejects(
    service.importRegisteredAccounts({ ids: [101] }),
    (error) => error.status === 503 && error.code === "PICKUP_NOT_CONFIGURED",
  );

  const missingCredentials = new PickupService({
    registration: { listRegisteredAccounts: async () => accounts() },
    baseUrl: "http://127.0.0.1:4190",
  });
  assert.equal(missingCredentials.configuration().enabled, false);
  await assert.rejects(
    missingCredentials.importRegisteredAccounts({ ids: [101] }),
    (error) => error.status === 503 && error.code === "PICKUP_NOT_CONFIGURED",
  );
});
