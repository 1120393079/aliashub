import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../db.js";
import { createApp } from "../index.js";
import { MicrosoftRegistrationRunnerService } from "../microsoft-registration-runner-service.js";
import { jsonRequest } from "./http-harness.js";

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = {
      text: "",
      closed: false,
      write: (value) => { this.stdin.text += String(value); },
      end: () => { this.stdin.closed = true; },
    };
    this.killed = false;
  }

  kill() {
    this.killed = true;
    return true;
  }
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-microsoft-runner-test-"));
  const toolDir = path.join(directory, "tool");
  fs.mkdirSync(toolDir, { recursive: true });
  fs.writeFileSync(path.join(toolDir, "go授权服务-v1.0.5.exe"), "fixture");
  fs.writeFileSync(path.join(toolDir, "go-ms-v9.2.8.exe"), "fixture");
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const calls = [];
  const children = [];
  const savedResultImports = [];
  const runner = new MicrosoftRegistrationRunnerService({
    db,
    dataDir: path.join(directory, "data"),
    toolDir,
    encryptionKey: "runner-test-encryption-key",
    waitForPort: async () => true,
    registrationService: {
      ingestTrusted(payload) {
        savedResultImports.push(payload);
        return { accepted: payload.data.length, updated: 0 };
      },
    },
    spawnFn(command, args, options) {
      const child = new FakeChild(70_000 + children.length);
      children.push(child);
      calls.push({ command, args, options, child });
      return child;
    },
  });
  runner.portInUse = async () => false;
  t.after(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, db, runner, calls, children, savedResultImports };
}

test("server Microsoft registrar stores config encrypted, starts both Wine processes, and keeps callback credentials private", async (t) => {
  const { db, runner, calls, children } = fixture(t);
  const captchaKey = "captcha-runner-test-secret";
  const proxy = "runner-user:runner-password:198.51.100.22:9000";
  const normalizedProxy = "runner-user:runner-password@198.51.100.22:9000";
  const saved = runner.saveConfiguration({
    captcha_key: captchaKey,
    proxy_mode: "list",
    proxy_value: proxy,
    account_format: "aaaaa11111111",
    password_format: "aaaaa11111111",
    quantity: 3,
    concurrency: 1,
  });
  assert.equal(saved.configured, true);
  assert.equal(saved.captcha_key_configured, true);
  assert.equal(saved.proxy.count, 1);
  assert.equal(JSON.stringify(saved).includes(captchaKey), false);
  assert.equal(JSON.stringify(saved).includes("runner-password"), false);
  const stored = db.prepare("SELECT secret_payload_encrypted FROM microsoft_registration_runner_config WHERE id = 1").get();
  assert.equal(stored.secret_payload_encrypted.includes(captchaKey), false);
  assert.equal(stored.secret_payload_encrypted.includes("runner-password"), false);

  const terminalFinishes = [];
  runner.scheduleTerminalFinish = (...args) => terminalFinishes.push(args);

  const started = await runner.start("https://aliashub.test/alias-hub");
  assert.equal(started.status, "running");
  assert.equal(calls.length, 2);
  assert.match(calls[0].args.at(-1), /go授权服务-v1\.0\.5\.exe$/);
  assert.equal(calls[1].command, "script");
  assert.match(calls[1].args[3], /go-ms-v9\.2\.8\.exe/);
  const prompts = Buffer.from("请输入并发数: (1)\n请输入注册最大数量: (3)\n请选择国家:\n请选择US的邮箱后缀:\n");
  children[1].stdout.emit("data", prompts.subarray(0, 5));
  children[1].stdout.emit("data", prompts.subarray(5));
  assert.equal(children[1].stdin.text, "1\n3\n\n\n");
  children[1].stdout.emit("data", Buffer.from("重试次数达到上限，停止注册\n程序执行结果汇总\n程序运行时长：33 秒\n"));
  assert.deepEqual(terminalFinishes, [[started.id, "failed", "注册机失败：注册重试次数达到上限"]]);
  assert.equal(runner.logs({ runId: started.id }).items.some((item) => item.message === "注册机失败阶段：注册重试次数达到上限"), true);
  const runDir = calls[0].options.cwd;
  const mailToml = fs.readFileSync(path.join(runDir, "mail.toml"), "utf8");
  assert.match(mailToml, /server_upload_url = "http:\/\/127\.0\.0\.1:4180\/api\/integrations\/microsoft-register\/v1\/runner\//);
  assert.match(mailToml, /imap_and_oauth_enabled = "1"/);
  assert.equal(fs.readFileSync(path.join(runDir, "proxyList.txt"), "utf8").trim(), normalizedProxy);
  const continuationPrefix = "runner-continuation-token-prefix";
  const continuationSuffix = "runner-continuation-token-suffix";
  const requestPrefix = "runner-request-payload-prefix";
  const requestSuffix = "runner-request-payload-suffix";
  children[0].stdout.emit("data", Buffer.from(`captcha=${captchaKey}\nlogin:runner-inline-user password:runner-inline-password\n\x1b[?25l{"challengeDetails":{"challengeType":"HumanCaptcha","continuationToken":"${continuationPrefix}\n`));
  children[0].stderr.emit("data", Buffer.from(`${continuationSuffix}","uuid":"runner-challenge-uuid","requestPayload":{"body":"${requestPrefix}\n${requestSuffix}"}}}\n请求状态: requestPayload: {"body":"${requestPrefix}\n${requestSuffix}"}\n`));
  children[0].stdout.emit("data", Buffer.from("[auth] Listening and serving HTTP on :8081\n授权服务已就绪\n"));
  const logs = runner.logs({ runId: started.id });
  assert.equal(JSON.stringify(logs).includes(captchaKey), false);
  assert.equal(JSON.stringify(logs).includes("runner-inline-user"), false);
  assert.equal(JSON.stringify(logs).includes("runner-inline-password"), false);
  assert.equal(JSON.stringify(logs).includes(continuationPrefix), false);
  assert.equal(JSON.stringify(logs).includes(continuationSuffix), false);
  assert.equal(JSON.stringify(logs).includes("runner-challenge-uuid"), false);
  assert.equal(JSON.stringify(logs).includes(requestPrefix), false);
  assert.equal(JSON.stringify(logs).includes(requestSuffix), false);
  assert.equal(logs.items.some((item) => item.message.includes("敏感挑战/请求载荷已隐藏")), true);
  assert.equal(logs.items.some((item) => item.message.includes("Listening and serving HTTP on :8081")), true);
  assert.equal(logs.items.some((item) => item.message.includes("授权服务已就绪")), true);

  const callback = new URL(mailToml.match(/server_upload_url = "([^"]+)"/)[1]);
  const parts = callback.pathname.split("/");
  const result = runner.ingest(parts.at(-2), parts.at(-1), { data: { email: "runner@outlook.com", status: "success" } }, {
    ingestTrusted() { return { success: true, accepted: 1, updated: 0, ignored: 0, duplicates: 0, import_id: 1 }; },
  });
  assert.equal(result.accepted, 1);
  assert.equal(runner.run(started.id).received_count, 1);
  const stopped = runner.stop();
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.run.status, "cancelled");
  assert.equal(children[0].killed, true);
  assert.equal(children[1].killed, true);
});

test("runner APIs require a complete saved config and expose only masked configuration", async (t) => {
  const { db, runner } = fixture(t);
  const runtime = createApp({
    db,
    dataEncryptionKey: "runner-api-test-encryption-key",
    publicBaseUrl: "https://aliashub.test/alias-hub",
    microsoftRegistrationRunner: runner,
  });
  const initial = await jsonRequest(runtime.app, "/api/microsoft-registration/runner");
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.captcha_key_configured, false);
  const missing = await jsonRequest(runtime.app, "/api/microsoft-registration/runner/start", { method: "POST" });
  assert.equal(missing.response.status, 409);
  const captchaKey = "api-runner-secret";
  const proxy = "api-user:api-password@198.51.100.23:9100";
  const configured = await jsonRequest(runtime.app, "/api/microsoft-registration/runner/config", {
    method: "PUT",
    body: JSON.stringify({ captcha_key: captchaKey, proxy_mode: "list", proxy_value: proxy, quantity: 2 }),
  });
  assert.equal(configured.response.status, 200);
  assert.equal(configured.body.configured, true);
  assert.equal(JSON.stringify(configured.body).includes(captchaKey), false);
  assert.equal(JSON.stringify(configured.body).includes("api-password"), false);
  const started = await jsonRequest(runtime.app, "/api/microsoft-registration/runner/start", { method: "POST" });
  assert.equal(started.response.status, 202);
  assert.equal(started.body.run.status, "running");
  const duplicate = await jsonRequest(runtime.app, "/api/microsoft-registration/runner/start", { method: "POST" });
  assert.equal(duplicate.response.status, 409);
  const stopped = await jsonRequest(runtime.app, "/api/microsoft-registration/runner/stop", { method: "POST" });
  assert.equal(stopped.response.status, 200);
  assert.equal(stopped.body.run.status, "cancelled");
});

test("runner imports saved successful registrations when the executable misses its callback", async (t) => {
  const { runner, calls, savedResultImports } = fixture(t);
  runner.saveConfiguration({
    captcha_key: "runner-file-import-key",
    proxy_mode: "list",
    proxy_value: "runner-user:runner-password@198.51.100.25:9200",
  });
  const started = await runner.start("https://aliashub.test/alias-hub");
  fs.writeFileSync(path.join(calls[0].options.cwd, "注册成功(总).txt"), "saved-result@outlook.com----saved-result-password\n");
  const completed = runner.finish(started.id, "completed", { message: "注册机已完成" });
  assert.equal(completed.received_count, 1);
  assert.match(completed.message, /已从结果文件导入 1 条注册邮箱/);
  assert.deepEqual(savedResultImports, [{
    data: [{ email: "saved-result@outlook.com", password: "saved-result-password", status: "success", runner_run_id: String(started.id) }],
    server_upload_other: { source: "go-ms-server-runner-file", runner_run_id: String(started.id) },
  }]);
});

test("runner does not turn an unclassified zero-result summary into a captcha failure", async (t) => {
  const { runner, children } = fixture(t);
  runner.saveConfiguration({
    captcha_key: "runner-zero-result-key",
    proxy_mode: "list",
    proxy_value: "runner-user:runner-password@198.51.100.26:9300",
  });
  const terminalFinishes = [];
  runner.scheduleTerminalFinish = (...args) => terminalFinishes.push(args);
  const started = await runner.start("https://aliashub.test/alias-hub");
  children[1].stdout.emit("data", Buffer.from("[ERROR] hidden challenge payload marker\n程序执行结果汇总\n注册成功次数   :      0 次\n程序运行时长：4 秒\n"));
  assert.deepEqual(terminalFinishes, [[started.id, "completed", "注册机已完成（未产生成功账号）"]]);
  assert.equal(runner.logs({ runId: started.id }).items.some((item) => item.message.startsWith("注册机失败阶段：")), false);
  runner.stop();
});
