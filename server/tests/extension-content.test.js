import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { microsoftDomains } from "../address-generator.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("connector guard text is never treated as a Microsoft account address", async () => {
  const source = fs.readFileSync(path.join(projectRoot, "extension/content.js"), "utf8");
  const guardText = [
    "AliasHub 已停止：微软账号不匹配",
    "任务账号：target@outlook.com。当前页面检测到：wrong@outlook.com。切换正确账号前不会同步或创建别名。",
    "切换到任务账号",
  ].join("\n");
  const supportedAddresses = microsoftDomains.map((domain, index) => `supported${index}@${domain}`);
  const bodyText = [
    "Microsoft account",
    ...supportedAddresses,
    "fake@outlook.example",
    "suffix@outlook.com.evil",
    guardText,
  ].join("\n");
  const session = new Map();
  const context = vm.createContext({
    console,
    setInterval: () => 0,
    chrome: {
      runtime: { sendMessage() {}, lastError: null },
      storage: { local: { remove: async () => {} } },
    },
    document: {
      body: { innerText: bodyText },
      getElementById: (id) => (id === "aliashub-account-guard" ? { innerText: guardText } : null),
    },
    sessionStorage: {
      getItem: (key) => session.get(key) || null,
      setItem: (key, value) => session.set(key, value),
      removeItem: (key) => session.delete(key),
    },
    window: { location: { pathname: "/unrelated" } },
  });

  vm.runInContext(source, context, { filename: "extension/content.js" });
  await new Promise((resolve) => setImmediate(resolve));

  const firstPass = vm.runInContext("pageEmails()", context);
  const secondPass = vm.runInContext("pageEmails()", context);
  assert.deepEqual([...firstPass], supportedAddresses);
  assert.deepEqual([...secondPass], supportedAddresses);
  assert.equal(vm.runInContext("pendingMatchesTarget({ accountId: 1, id: 9 }, { id: 1, jobId: 10 })", context), false);
  assert.equal(vm.runInContext("pendingMatchesTarget({ accountId: 1, id: 10 }, { id: 1, jobId: 10 })", context), true);
});
