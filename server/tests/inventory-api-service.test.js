import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase, getSetting, setSetting } from "../db.js";
import { InventoryApiService, inventoryResultSummary } from "../inventory-api-service.js";

function fixtureDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-inventory-"));
  const db = createDatabase({ filename: path.join(dir, "test.db"), seedDemo: false });
  return { db, dir };
}

test("inventory API stores the key encrypted and never exposes it in configuration", async () => {
  const { db, dir } = fixtureDb();
  const calls = [];
  const service = new InventoryApiService({
    db,
    encryptionKey: "fixture-encryption-key",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ accepted: [], rejected: [{ reason: key }] }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const key = "fixture-inventory-api-key-123";
  service.updateConfiguration({ api_key: key });
  const config = service.configuration();
  assert.equal(config.api_key_configured, true);
  assert.equal(config.auth_header, "x-api-key");
  assert.equal(getSetting(db, "inventory_api_key_encrypted").includes(key), false);
  assert.equal(JSON.stringify(config).includes(key), false);
  const connected = await service.testConnection();
  assert.equal(JSON.stringify(connected).includes(key), false);
  assert.equal(calls[0].url, "https://nvtokens.com/api/inventory/cards/import");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body, "{}");
  assert.equal(calls[0].options.headers["content-type"], "application/json");
  assert.equal(calls[0].options.headers["x-api-key"], key);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("inventory API forwards JSON and redacts upstream credential errors from summaries", async () => {
  const { db, dir } = fixtureDb();
  const key = "fixture-inventory-api-key-456";
  let captured;
  const service = new InventoryApiService({
    db,
    encryptionKey: "fixture-encryption-key",
    apiKey: key,
    fetchFn: async (_url, options) => {
      captured = options;
      return new Response(JSON.stringify({ accepted: [], rejected: [{ reason: `token=${key}` }], summary: { accepted: 0, rejected: 1 } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const requestPayload = { data: { email: "user@example.com", access_token: "at", refresh_token: "rt", type: "codex" } };
  const result = await service.importCards(requestPayload);
  assert.equal(result.summary.rejected, 1);
  assert.equal(captured.headers["x-api-key"], key);
  assert.match(captured.body, /user@example\.com/);
  const summary = service.resultSummary(result, requestPayload);
  assert.equal(JSON.stringify(summary).includes(key), false);
  assert.equal(summary.failures[0].reason.includes(key), false);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("inventory API rejects insecure URLs unless explicitly enabled", () => {
  const { db, dir } = fixtureDb();
  assert.throws(
    () => new InventoryApiService({ db, cardsUrl: "http://inventory.test/cards/import" }),
    /必须使用 HTTPS/,
  );
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("inventory API ignores stored endpoint settings and locks ordinary configuration", () => {
  const { db, dir } = fixtureDb();
  setSetting(db, "inventory_api_cards_url", "https://attacker.invalid/collect");
  const service = new InventoryApiService({ db });
  assert.equal(service.cardsUrl(), "https://nvtokens.com/api/inventory/cards/import");
  assert.throws(
    () => service.updateConfiguration({ cards_url: "https://attacker.invalid/collect" }),
    (error) => error?.status === 400 && error?.code === "INVENTORY_ENDPOINT_LOCKED",
  );
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("inventory API clears stale connected state when the authenticated probe fails", async () => {
  const { db, dir } = fixtureDb();
  const service = new InventoryApiService({
    db,
    apiKey: "fixture-invalid-inventory-key",
    fetchFn: async () => new Response(JSON.stringify({ error: "invalid api key" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  });
  setSetting(db, "inventory_api_last_connected_at", "2026-08-20T00:00:00.000Z");
  assert.equal(service.configuration().connected, true);
  await assert.rejects(
    service.testConnection(),
    (error) => error?.status === 401 && error?.code === "INVENTORY_UPSTREAM_ERROR",
  );
  assert.equal(getSetting(db, "inventory_api_last_connected_at", "missing"), "");
  assert.equal(service.configuration().connected, false);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("inventory API allows custom server endpoints only with explicit environment opt-in", () => {
  const { db, dir } = fixtureDb();
  const previous = process.env.NVTOKENS_ALLOW_CUSTOM_ENDPOINTS;
  try {
    delete process.env.NVTOKENS_ALLOW_CUSTOM_ENDPOINTS;
    assert.throws(
      () => new InventoryApiService({ db, cardsUrl: "https://inventory.test/cards/import" }),
      (error) => error?.status === 500 && error?.code === "INVENTORY_CUSTOM_ENDPOINTS_DISABLED",
    );

    process.env.NVTOKENS_ALLOW_CUSTOM_ENDPOINTS = "true";
    const service = new InventoryApiService({ db, cardsUrl: "https://inventory.test/cards/import" });
    assert.equal(service.cardsUrl(), "https://inventory.test/cards/import");
    assert.equal(service.configuration().endpoint_source, "server");
    assert.throws(
      () => service.updateConfiguration({ cards_url: "https://other.test/cards/import" }),
      (error) => error?.status === 400 && error?.code === "INVENTORY_ENDPOINT_LOCKED",
    );
  } finally {
    if (previous === undefined) delete process.env.NVTOKENS_ALLOW_CUSTOM_ENDPOINTS;
    else process.env.NVTOKENS_ALLOW_CUSTOM_ENDPOINTS = previous;
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inventory API summaries expose counts instead of upstream objects", () => {
  const marker = "fixture-sensitive-upstream-marker";
  const summary = inventoryResultSummary({
    ok: { access_token: marker },
    total: { refresh_token: marker },
    matched: [{ access_token: marker }, { access_token: marker }],
    updated: [{ refresh_token: marker }],
    created: { api_key: marker },
    accepted: [{ email: "accepted@example.com", access_token: marker }],
    rejected: [{
      email: "rejected@example.com",
      reason: `token=${marker}`,
      line: { access_token: marker },
    }],
    summary: {
      accepted: [{ access_token: marker }],
      rejected: "0",
      unsafe: { token: marker },
    },
  }, [marker]);
  assert.equal(JSON.stringify(summary).includes(marker), false);
  assert.equal(Object.hasOwn(summary, "ok"), false);
  assert.equal(Object.hasOwn(summary, "total"), false);
  assert.equal(Object.hasOwn(summary, "created"), false);
  assert.equal(summary.matched, 2);
  assert.equal(summary.updated, 1);
  assert.equal(summary.accepted, 1);
  assert.equal(summary.rejected, 1);
  assert.equal(Object.hasOwn(summary.failures[0], "line"), false);
  assert.equal(summary.failures[0].reason.includes(marker), false);
  assert.deepEqual(summary.summary, { accepted: 1, rejected: 0 });
});
