import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("Microsoft account switching clears the current Live web session", async () => {
  const source = fs.readFileSync(path.join(projectRoot, "extension/background.js"), "utf8");
  const removals = [];
  const context = vm.createContext({
    console,
    fetch: async () => { throw new Error("unexpected fetch"); },
    chrome: {
      cookies: {
        getAll: async ({ domain }) => {
          assert.equal(domain, "live.com");
          return [
            { domain: ".live.com", path: "/", name: "MSPAuth", storeId: "0" },
            { domain: "account.live.com", path: "/names", name: "Account", storeId: "0", partitionKey: { topLevelSite: "https://live.com" } },
          ];
        },
        remove: async (details) => { removals.push(details); return details; },
      },
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} },
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      tabs: { create: async () => {} },
    },
  });

  vm.runInContext(source, context, { filename: "extension/background.js" });
  const removed = await vm.runInContext("clearMicrosoftWebSession()", context);
  assert.equal(removed, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(removals)), [
    { url: "https://live.com/", name: "MSPAuth", storeId: "0" },
    {
      url: "https://account.live.com/names",
      name: "Account",
      storeId: "0",
      partitionKey: { topLevelSite: "https://live.com" },
    },
  ]);
});
