import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { PickupService } from "../pickup-service.js";

function sourceInventoryDatabase() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE source_accounts (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE addresses (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      address TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      strategy TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE registration_jobs (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_reason TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE mailcom_registration_pipeline_items (
      id INTEGER PRIMARY KEY,
      pipeline_id TEXT NOT NULL,
      account_id INTEGER,
      current_address_id INTEGER,
      current_email TEXT NOT NULL COLLATE NOCASE,
      replacement_email TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
      current_attempt_id INTEGER,
      status TEXT NOT NULL,
      stage TEXT NOT NULL
    );
    CREATE TABLE mailcom_registration_pipeline_attempts (
      id INTEGER PRIMARY KEY,
      item_id INTEGER NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE,
      recycle_status TEXT NOT NULL
    );
    INSERT INTO source_accounts VALUES
      (1, 'icloud', 'source@icloud.com', 'connected'),
      (2, 'microsoft', 'offline@outlook.com', 'action_required');
    INSERT INTO addresses VALUES
      (10, 1, 'available@icloud.com', 'official', 'active', 'icloud_hide_my_email', '商店', '手工导入', '2026-08-07T01:00:00Z'),
      (11, 1, 'registered@icloud.com', 'official', 'active', 'icloud_mail_alias', '', '', '2026-08-07T02:00:00Z'),
      (12, 1, 'occupied@icloud.com', 'official', 'active', 'icloud_hide_my_email', '', '', '2026-08-07T03:00:00Z'),
      (13, 2, 'offline-alias@outlook.com', 'official', 'active', 'official', '', '', '2026-08-07T04:00:00Z'),
      (14, 1, 'generated+tag@icloud.com', 'split', 'active', 'plus', '', '', '2026-08-07T05:00:00Z');
    INSERT INTO registration_jobs VALUES
      (100, 'registered@icloud.com', 'completed', ''),
      (101, 'occupied@icloud.com', 'failed', 'user_already_exists');
  `);
  return db;
}

test("pickup publishing sends an available password but never sends the access token", async () => {
  const requests = [];
  const registration = {
    async listRegisteredAccounts() {
      return {
        items: [{
          id: 101,
          email: "Buyer.Mailbox@Example.com",
          password: "configured-password",
          password_available: true,
          account_type: "plus",
          group_name: "成品",
          custom_name: "账号 101",
        }],
      };
    },
    async registeredAccountAccessToken() {
      throw new Error("AT must not be requested while publishing pickup links");
    },
  };
  const fetchFn = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 201,
      headers: { get: () => "application/json" },
      async json() {
        return {
          items: [{
            id: 7,
            email: "buyer.mailbox@example.com",
            pickup_url: "https://pickup.example/?token=signed",
            delivery_line: "账号：buyer.mailbox@example.com----密码：configured-password----取件链接：https://pickup.example/?token=signed",
          }],
        };
      },
    };
  };
  const service = new PickupService({
    registration,
    baseUrl: "http://127.0.0.1:4190",
    publicUrl: "https://pickup.example",
    username: "admin",
    password: "secret",
    fetchFn,
  });

  const result = await service.importRegisteredAccounts({ ids: [101] });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:4190/api/admin/mailboxes");
  assert.equal(requests[0].body.upsert, true);
  assert.equal(requests[0].body.clear_credentials, false);
  assert.equal(requests[0].body.relist, true);
  assert.deepEqual(requests[0].body.items, [{
    email: "buyer.mailbox@example.com",
    password: "configured-password",
    label: "ChatGPT PLUS · 成品",
    extra: "账号 101",
  }]);
  assert.equal(Object.hasOwn(requests[0].body.items[0], "access_token"), false);
  assert.equal(requests[0].body.items[0].password, "configured-password");
  assert.equal(
    result.delivery_text,
    "账号：buyer.mailbox@example.com----密码：configured-password----取件链接：https://pickup.example/?token=signed",
  );
});


test("pickup status listing exposes inventory state without credentials", async () => {
  const requests = [];
  const fetchFn = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      async json() {
        return {
          items: [{
            id: 8,
            email: "Listed.Mailbox@Example.com",
            status: "ready",
            pickup_url: "https://pickup.example/?token=signed",
            created_at: "2026-08-07T09:00:00Z",
            updated_at: "2026-08-07T09:05:00Z",
            account_password: "must-not-leak",
            access_token: "must-not-leak",
            delivery_line: "must-not-leak",
          }, {
            id: 9,
            email: "invalid@example.com",
            status: "archived",
          }],
        };
      },
    };
  };
  const service = new PickupService({
    registration: {},
    baseUrl: "http://127.0.0.1:4190",
    publicUrl: "https://pickup.example",
    username: "admin",
    password: "secret",
    fetchFn,
  });

  const result = await service.listStatuses();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:4190/api/admin/mailboxes");
  assert.equal(requests[0].options.method, undefined);
  assert.deepEqual(result, {
    enabled: true,
    admin_url: "https://pickup.example/admin",
    items: [{
      id: 8,
      email: "listed.mailbox@example.com",
      status: "ready",
      pickup_url: "https://pickup.example/?token=signed",
      created_at: "2026-08-07T09:00:00Z",
      updated_at: "2026-08-07T09:05:00Z",
    }],
  });
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
});

test("source mailbox inventory excludes generated addresses and blocks every ChatGPT-used email", () => {
  const db = sourceInventoryDatabase();
  const service = new PickupService({
    db,
    registration: {},
    password: "secret",
    fetchFn: async () => { throw new Error("not used"); },
  });

  const result = service.listSourceAddresses();

  assert.equal(result.total, 4);
  assert.equal(result.eligible, 1);
  assert.equal(result.blocked, 3);
  assert.equal(result.items.some((item) => item.email === "generated+tag@icloud.com"), false);
  assert.equal(result.items.find((item) => item.email === "available@icloud.com").eligible, true);
  assert.equal(result.items.find((item) => item.email === "registered@icloud.com").blocked_reason, "已注册 ChatGPT，禁止上架");
  assert.equal(result.items.find((item) => item.email === "occupied@icloud.com").chatgpt_registration_occupied, true);
  assert.equal(result.items.find((item) => item.email === "offline-alias@outlook.com").blocked_reason, "源头邮箱未连接");
  db.close();
});

test("pickup source availability and publishing reject a Mail.com recycling reservation", async () => {
  const db = sourceInventoryDatabase();
  db.exec(`
    INSERT INTO source_accounts VALUES
      (3, 'mailcom', 'mother@email.com', 'connected');
    INSERT INTO addresses VALUES
      (15, 3, 'reserved@email.com', 'official', 'active', 'mailcom_alias', '', '', '2026-08-07T06:00:00Z');
    INSERT INTO mailcom_registration_pipeline_items (
      id, pipeline_id, account_id, current_address_id, current_email,
      replacement_email, status, stage
    ) VALUES (
      1, 'pipeline-1', 3, 15, 'old-reserved@email.com',
      'reserved@email.com', 'queued', 'recycle_retry_wait'
    );
  `);
  const requests = [];
  const service = new PickupService({
    db,
    registration: {},
    password: "secret",
    fetchFn: async (...args) => {
      requests.push(args);
      throw new Error("reserved address must not reach pickup");
    },
  });

  const result = service.listSourceAddresses();
  const item = result.items.find((entry) => entry.email === "reserved@email.com");
  assert.equal(item.mailcom_recycling_reserved, true);
  assert.equal(item.eligible, false);
  assert.match(item.blocked_reason, /正在轮换/);
  await assert.rejects(
    service.importSourceAddresses({ ids: [15] }),
    (error) => error.code === "PICKUP_MAILCOM_RECYCLING_RESERVED" && error.status === 409,
  );
  assert.equal(requests.length, 0);
  db.close();
});

test("registered-account pickup publishing keeps an in-flight recycle reserved after cancellation", async () => {
  const db = sourceInventoryDatabase();
  const requests = [];
  const registration = {
    async listRegisteredAccounts() {
      db.prepare(`
        INSERT INTO mailcom_registration_pipeline_items (
          id, pipeline_id, account_id, current_address_id, current_email,
          current_attempt_id, status, stage
        ) VALUES (2, 'pipeline-2', 3, 15, 'late-reserved@email.com', 20, 'cancel_requested', 'cancel_requested')
      `).run();
      db.prepare(`
        INSERT INTO mailcom_registration_pipeline_attempts (id, item_id, email, recycle_status)
        VALUES (20, 2, 'late-reserved@email.com', 'running')
      `).run();
      return {
        items: [{ id: 201, email: "late-reserved@email.com", password_available: false }],
      };
    },
  };
  const service = new PickupService({
    db,
    registration,
    password: "secret",
    fetchFn: async (...args) => {
      requests.push(args);
      throw new Error("reserved account must not reach pickup");
    },
  });

  await assert.rejects(
    service.importRegisteredAccounts({ ids: [201] }),
    (error) => error.code === "PICKUP_MAILCOM_RECYCLING_RESERVED" && error.status === 409,
  );
  assert.equal(requests.length, 0);
  db.close();
});

test("source mailbox publishing sends no credentials and rejects ChatGPT-used addresses", async () => {
  const db = sourceInventoryDatabase();
  const requests = [];
  const service = new PickupService({
    db,
    registration: {},
    baseUrl: "http://127.0.0.1:4190",
    publicUrl: "https://pickup.example",
    password: "secret",
    fetchFn: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      return {
        ok: true,
        status: 201,
        headers: { get: () => "application/json" },
        async json() {
          return {
            items: body.items.map((item, index) => ({
              id: index + 1,
              email: item.email,
              pickup_url: `https://pickup.example/?token=${index + 1}`,
              delivery_line: `${item.email} https://pickup.example/?token=${index + 1}`,
            })),
          };
        },
      };
    },
  });

  await assert.rejects(
    service.importSourceAddresses({ ids: [11] }),
    (error) => error.code === "PICKUP_ADDRESS_BLOCKED" && error.status === 409,
  );
  assert.equal(requests.length, 0);

  const result = await service.importSourceAddresses({ ids: [10] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.clear_credentials, true);
  assert.equal(Object.hasOwn(requests[0].body, "relist"), false);
  assert.deepEqual(requests[0].body.items, [{
    email: "available@icloud.com",
    label: "iCloud 隐藏邮箱",
    extra: "源头邮箱 source@icloud.com · 商店 · 手工导入",
  }]);
  assert.equal(JSON.stringify(requests[0].body).includes("password"), false);
  assert.equal(result.imported, 1);
  db.close();
});
