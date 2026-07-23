import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { audit, nowIso } from "./db.js";

const ACTIVE_STATUSES = new Set(["starting", "running", "stopping"]);
const FINISHED_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const MAX_PROXY_LINES = 10_000;
const MAX_PROXY_TEXT = 2_000_000;
const CALLBACK_TTL_MS = 24 * 60 * 60 * 1000;
const AUTH_PORT = 8081;

function failure(message, status = 400, code = "MICROSOFT_RUNNER_ERROR") {
  return Object.assign(new Error(message), { status, code });
}

function trimText(value, maximum = 8_000) {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, maximum);
}

function integer(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw failure(`数值必须在 ${minimum} 到 ${maximum} 之间`);
  }
  return parsed;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function toml(value) {
  return JSON.stringify(String(value ?? ""));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function publicRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    phase: row.phase,
    account_format: row.account_format,
    quantity: Number(row.quantity) || 0,
    concurrency: Number(row.concurrency) || 0,
    proxy_mode: row.proxy_mode,
    proxy_count: Number(row.proxy_count) || 0,
    received_count: Number(row.received_count) || 0,
    stop_requested: Boolean(row.stop_requested),
    message: row.message || "",
    exit_code: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
    started_at: row.started_at || "",
    finished_at: row.finished_at || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function activeStatus(value) {
  return ACTIVE_STATUSES.has(String(value || ""));
}

function splitLines(value) {
  return String(value || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function validProxyLine(value) {
  const at = value.lastIndexOf("@");
  const colon = value.lastIndexOf(":");
  return at > 1 && colon > at + 1 && colon < value.length - 1 && !/\s/.test(value);
}

function validFormat(value, label) {
  const text = trimText(value, 80);
  if (!/^[aA1]{4,64}$/.test(text)) {
    throw failure(`${label}只支持 a、A、1 组成的 4-64 位格式`);
  }
  return text;
}

function redact(value, secrets = []) {
  let output = String(value || "");
  for (const secret of secrets) {
    const text = String(secret || "").trim();
    if (text.length >= 3) output = output.replaceAll(text, "[已隐藏]");
  }
  output = output
    .replace(/((?:"?)(?:challenge(?:Details|Metadata|Url)?)(?:"?)\s*[:=]\s*)[^\r\n]*/gi, "$1[已隐藏]")
    .replace(/((?:"?)(?:captcha|px|api|access|refresh|auth|password|passwd|pwd|token|continuationToken|session(?:[_-]?id)?|uuid|vid|login|username|developer)(?:"?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|[^\s,;}\]]+)/gi, "$1[已隐藏]")
    .replace(/([?&](?:access_token|auth(?:entication)?|continuationToken|session(?:[_-]?id)?|token)=)[^&#\s]+/gi, "$1[已隐藏]")
    .replace(/((?:captcha|px|api|access|refresh|auth)[^\s=:]{0,40}[=:]\s*)[^\s,;]+/gi, "$1[已隐藏]")
    .replace(/\b[^\s:@]{1,100}:[^\s@]{1,100}@[^\s/:]+:\d{1,5}\b/g, "[代理已隐藏]");
  return output.slice(0, 4_000);
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replaceAll("\r", "");
}

const SENSITIVE_LOG_PAYLOAD_START = /(^|[,{[\s])"?(?:challenge(?:[_\s-]?(?:details|metadata|url|type))?|human[_\s-]?captcha|(?:request|response)(?:[_\s-]?(?:body|payload|data|details|metadata))?|payload|continuation[_\s-]?token|(?:access|refresh|id)?[_\s-]?token|session(?:[_\s-]?id)?|uuid|vid|captcha(?:[_\s-]?(?:token|data|response))?)"?\s*[:=]\s*/i;

function sensitivePayloadStart(text, offset = 0) {
  const match = SENSITIVE_LOG_PAYLOAD_START.exec(text.slice(offset));
  if (!match) return null;
  const index = offset + match.index;
  return {
    index,
    valueStart: index + match[0].length,
  };
}

function structuredPayloadStart(text, offset = 0) {
  const source = text.slice(offset);
  const match = /^\s*\{/.exec(source) || /^\s*\[(?=\s*(?:[\[{"\d-]|\]))/.exec(source);
  if (!match) return null;
  const index = offset + match[0].length - 1;
  return { index, valueStart: index };
}

function safeLogText(value, secrets) {
  const text = redact(stripAnsi(value), secrets).trim();
  return /^[\[\]{}(),;:\s]*$/.test(text) ? "" : text;
}

function clearlySafeStatus(value) {
  const text = stripAnsi(value).trim();
  return /^(?:应用启动成功|当前版本|请输入|请选择|正在|授权服务|程序(?:执行结果汇总|运行时长)|注册(?:成功|失败|机)|重试次数达到上限|按压验证失败|打码平台|已(?:完成|停止|接收)|(?:\[auth\]\s*)?Listening(?:\s+and\s+serving)?\b|Error\b|错误|失败|成功)/i.test(text);
}

function payloadState(text, valueStart) {
  let index = valueStart;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  const initial = text[index];
  if (initial === "{" || initial === "[") {
    return { kind: "structured", depth: 0, quote: "", escaped: false };
  }
  if (initial === '"' || initial === "'") {
    return { kind: "quoted", quote: initial, escaped: false };
  }
  if (initial) return { kind: "opaque" };
  return { kind: "awaiting" };
}

function consumePayload(text, offset, state) {
  let index = offset;
  if (state.kind === "awaiting") {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (index === text.length) return null;
    Object.assign(state, payloadState(text, index));
  }
  if (state.kind === "opaque") return null;

  for (; index < text.length; index += 1) {
    const character = text[index];
    if (state.escaped) {
      state.escaped = false;
      continue;
    }
    if (character === "\\") {
      state.escaped = true;
      continue;
    }
    if (state.quote) {
      if (character === state.quote) {
        state.quote = "";
        if (state.kind === "quoted") return index + 1;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      state.quote = character;
      continue;
    }
    if (state.kind === "structured") {
      if (character === "{" || character === "[") state.depth += 1;
      if (character === "}" || character === "]") {
        state.depth -= 1;
        if (state.depth === 0) return index + 1;
      }
    }
  }
  return null;
}

function createPayloadLogFilter(secrets) {
  let state = null;
  return {
    filter(value) {
      const text = stripAnsi(value);
      const output = [];
      let offset = 0;
      while (offset < text.length) {
        if (state) {
          if (state.kind === "opaque" && clearlySafeStatus(text.slice(offset))) state = null;
          else {
            const next = consumePayload(text, offset, state);
            if (next === null) return output.join(" ").trim();
            state = null;
            offset = next;
            continue;
          }
        }

        const sensitive = sensitivePayloadStart(text, offset);
        const structured = structuredPayloadStart(text, offset);
        const start = !sensitive || (structured && structured.index < sensitive.index) ? structured : sensitive;
        if (!start) {
          const safe = safeLogText(text.slice(offset), secrets);
          if (safe) output.push(safe);
          break;
        }
        const prefix = safeLogText(text.slice(offset, start.index), secrets);
        if (prefix) output.push(prefix);
        output.push("[敏感挑战/请求载荷已隐藏]");
        state = payloadState(text, start.valueStart);
        const next = consumePayload(text, start.valueStart, state);
        if (next === null) return output.join(" ").trim();
        state = null;
        offset = next;
      }
      return output.join(" ").trim();
    },
  };
}

function callbackUrl(publicBaseUrl, runId, token) {
  const root = String(publicBaseUrl || "").replace(/\/+$/, "");
  return `${root}/api/integrations/microsoft-register/v1/runner/${runId}/${token}`;
}

function defaultConfig() {
  return {
    captcha_type: "3",
    captcha_key: "",
    proxy_mode: "list",
    proxy_value: "",
    account_format: "aaaaa11111111",
    password_format: "aaaaa11111111",
    quantity: 1,
    concurrency: 1,
    oauth_mode: "3",
    chrome_version: "143",
  };
}

export class MicrosoftRegistrationRunnerService {
  constructor({
    db,
    encryptionKey,
    dataDir,
    toolDir,
    wineBinary = process.env.MICROSOFT_REGISTRATION_WINE_BINARY || "wine",
    xvfbBinary = process.env.MICROSOFT_REGISTRATION_XVFB_BINARY || "xvfb-run",
    scriptBinary = process.env.MICROSOFT_REGISTRATION_SCRIPT_BINARY || "script",
    spawnFn = nodeSpawn,
    waitForPort,
  } = {}) {
    this.db = db;
    this.encryptionKey = encryptionKey
      ? crypto.createHash("sha256").update(String(encryptionKey)).digest()
      : null;
    this.dataDir = path.resolve(dataDir || path.join(process.cwd(), "data"));
    this.rootDir = path.join(this.dataDir, "microsoft-registration-runner");
    this.toolDir = path.resolve(toolDir || process.env.MICROSOFT_REGISTRATION_RUNNER_DIR || path.join(process.cwd(), "release", "microsoft-registration-runner"));
    this.wineBinary = wineBinary;
    this.xvfbBinary = xvfbBinary;
    this.scriptBinary = scriptBinary;
    this.spawn = spawnFn;
    this.waitForPort = waitForPort || this.waitForLocalPort.bind(this);
    this.processes = new Map();
    this.recoverInterruptedRuns();
  }

  get encryptionReady() {
    return Boolean(this.encryptionKey);
  }

  get authExecutable() {
    return path.join(this.toolDir, "go授权服务-v1.0.5.exe");
  }

  get registrarExecutable() {
    return path.join(this.toolDir, "go-ms-v9.2.8.exe");
  }

  requireEncryption() {
    if (!this.encryptionKey) throw failure("服务器未配置 DATA_ENCRYPTION_KEY，不能保存注册配置", 409, "MICROSOFT_RUNNER_ENCRYPTION_REQUIRED");
  }

  encrypt(value) {
    this.requireEncryption();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
  }

  decrypt(value) {
    this.requireEncryption();
    const [version, iv, tag, body] = String(value || "").split(".");
    if (version !== "v1" || !iv || !tag || !body) throw failure("服务器注册配置无法解密", 500, "MICROSOFT_RUNNER_DECRYPT_FAILED");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8"));
  }

  toolReady() {
    return fs.existsSync(this.authExecutable) && fs.existsSync(this.registrarExecutable);
  }

  currentRun() {
    return this.db.prepare(`
      SELECT * FROM microsoft_registration_runner_runs
      WHERE status IN ('starting', 'running', 'stopping')
      ORDER BY id DESC LIMIT 1
    `).get();
  }

  recoverInterruptedRuns() {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE microsoft_registration_runner_runs
      SET status = 'interrupted', phase = 'interrupted', message = 'AliasHub 服务重启，注册任务已停止',
          finished_at = ?, updated_at = ?
      WHERE status IN ('starting', 'running', 'stopping')
    `).run(timestamp, timestamp);
  }

  configuration() {
    const row = this.db.prepare("SELECT * FROM microsoft_registration_runner_config WHERE id = 1").get();
    const latest = this.db.prepare("SELECT * FROM microsoft_registration_runner_runs ORDER BY id DESC LIMIT 1").get();
    const current = this.currentRun();
    const toolReady = this.toolReady();
    return {
      available: this.encryptionReady && toolReady,
      encryption_ready: this.encryptionReady,
      tool_ready: toolReady,
      configured: Boolean(row?.secret_payload_encrypted && row?.captcha_key_configured && row?.proxy_count),
      captcha_key_configured: Boolean(row?.captcha_key_configured),
      proxy: {
        configured: Boolean(row?.proxy_count),
        mode: row?.proxy_mode || "list",
        count: Number(row?.proxy_count) || 0,
      },
      account_format: row?.account_format || defaultConfig().account_format,
      password_format: row?.password_format || defaultConfig().password_format,
      quantity: Number(row?.quantity) || 1,
      concurrency: Number(row?.concurrency) || 1,
      captcha_type: row?.captcha_type || defaultConfig().captcha_type,
      oauth_mode: row?.oauth_mode || defaultConfig().oauth_mode,
      chrome_version: row?.chrome_version || defaultConfig().chrome_version,
      updated_at: row?.updated_at || "",
      run: publicRun(current || latest),
      current_run: publicRun(current),
    };
  }

  configSecrets(row) {
    if (!row?.secret_payload_encrypted) return {};
    return this.decrypt(row.secret_payload_encrypted);
  }

  storedConfiguration(row) {
    const stored = row ? {
      captcha_type: row.captcha_type,
      proxy_mode: row.proxy_mode,
      proxy_count: Number(row.proxy_count),
      account_format: row.account_format,
      password_format: row.password_format,
      quantity: Number(row.quantity),
      concurrency: Number(row.concurrency),
      oauth_mode: row.oauth_mode,
      chrome_version: row.chrome_version,
    } : {};
    return { ...defaultConfig(), ...stored, ...this.configSecrets(row) };
  }

  normalizeConfiguration(input = {}, existing = defaultConfig()) {
    const has = (key) => Object.hasOwn(input, key);
    const captchaType = has("captcha_type") ? trimText(input.captcha_type, 1) : existing.captcha_type;
    if (!["1", "2", "3"].includes(captchaType)) throw failure("打码平台类型无效");
    const captchaKey = has("captcha_key") ? trimText(input.captcha_key, 2_000) : existing.captcha_key;
    if (!captchaKey) throw failure("请填写打码平台 Key");
    const proxyMode = has("proxy_mode") ? trimText(input.proxy_mode, 10) : existing.proxy_mode;
    if (!["list", "api"].includes(proxyMode)) throw failure("代理类型无效");
    const proxyValue = has("proxy_value") ? trimText(input.proxy_value, MAX_PROXY_TEXT) : existing.proxy_value;
    if (!proxyValue) throw failure(proxyMode === "list" ? "请粘贴账号密码代理列表" : "请填写动态代理 API 地址");
    let proxyCount = 0;
    if (proxyMode === "list") {
      const proxies = splitLines(proxyValue);
      if (!proxies.length || proxies.length > MAX_PROXY_LINES || proxies.some((item) => !validProxyLine(item))) {
        throw failure("代理列表格式错误，请使用 username:password@host:port，每行一个");
      }
      proxyCount = proxies.length;
    } else {
      try {
        const parsed = new URL(proxyValue);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported");
      } catch {
        throw failure("动态代理 API 必须是有效的 http 或 https 地址");
      }
      proxyCount = 1;
    }
    const accountFormat = validFormat(has("account_format") ? input.account_format : existing.account_format, "账号格式");
    const passwordFormat = validFormat(has("password_format") ? input.password_format : existing.password_format, "密码格式");
    const quantity = integer(has("quantity") ? input.quantity : existing.quantity, 1, 1, 10_000);
    const concurrency = integer(has("concurrency") ? input.concurrency : existing.concurrency, 1, 1, 100);
    const oauthMode = has("oauth_mode") ? trimText(input.oauth_mode, 1) : existing.oauth_mode;
    if (!["1", "2", "3"].includes(oauthMode)) throw failure("注册后处理模式无效");
    const chromeVersion = integer(has("chrome_version") ? input.chrome_version : existing.chrome_version, 143, 128, 144);
    return {
      captcha_type: captchaType,
      captcha_key: captchaKey,
      proxy_mode: proxyMode,
      proxy_value: proxyValue,
      proxy_count: proxyCount,
      account_format: accountFormat,
      password_format: passwordFormat,
      quantity,
      concurrency,
      oauth_mode: oauthMode,
      chrome_version: String(chromeVersion),
    };
  }

  saveConfiguration(input = {}) {
    this.requireEncryption();
    const current = this.db.prepare("SELECT * FROM microsoft_registration_runner_config WHERE id = 1").get();
    const normalized = this.normalizeConfiguration(input, this.storedConfiguration(current));
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO microsoft_registration_runner_config (
        id, secret_payload_encrypted, captcha_key_configured, proxy_mode, proxy_count, account_format,
        password_format, quantity, concurrency, captcha_type, oauth_mode, chrome_version, updated_at
      ) VALUES (1, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        secret_payload_encrypted = excluded.secret_payload_encrypted,
        captcha_key_configured = excluded.captcha_key_configured,
        proxy_mode = excluded.proxy_mode,
        proxy_count = excluded.proxy_count,
        account_format = excluded.account_format,
        password_format = excluded.password_format,
        quantity = excluded.quantity,
        concurrency = excluded.concurrency,
        captcha_type = excluded.captcha_type,
        oauth_mode = excluded.oauth_mode,
        chrome_version = excluded.chrome_version,
        updated_at = excluded.updated_at
    `).run(
      this.encrypt({ captcha_key: normalized.captcha_key, proxy_value: normalized.proxy_value }),
      normalized.proxy_mode,
      normalized.proxy_count,
      normalized.account_format,
      normalized.password_format,
      normalized.quantity,
      normalized.concurrency,
      normalized.captcha_type,
      normalized.oauth_mode,
      normalized.chrome_version,
      timestamp,
    );
    audit(this.db, null, "microsoft_registration_runner", "保存服务器注册机配置", "注册配置已加密保存", {
      proxyMode: normalized.proxy_mode,
      proxyCount: normalized.proxy_count,
      quantity: normalized.quantity,
      concurrency: normalized.concurrency,
    });
    return this.configuration();
  }

  requireTool() {
    if (!this.toolReady()) throw failure("服务器注册机文件未就绪", 409, "MICROSOFT_RUNNER_TOOL_NOT_READY");
  }

  requireSavedConfiguration() {
    this.requireEncryption();
    const row = this.db.prepare("SELECT * FROM microsoft_registration_runner_config WHERE id = 1").get();
    if (!row?.secret_payload_encrypted || !row.captcha_key_configured || !row.proxy_count) {
      throw failure("请先填写并保存打码 Key 与代理配置", 409, "MICROSOFT_RUNNER_CONFIG_REQUIRED");
    }
    return { row, config: this.storedConfiguration(row) };
  }

  ensureRunDirectory(runId) {
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    const runDir = fs.mkdtempSync(path.join(this.rootDir, `run-${runId}-`));
    fs.chmodSync(runDir, 0o700);
    return runDir;
  }

  writeRunFiles(runDir, config, runId, callback) {
    const proxyType = config.proxy_mode === "list" ? "1" : "2";
    const scopeProxyType = proxyType;
    const captchaProxyType = config.proxy_mode === "list" ? "2" : "1";
    const contents = [
      `px_captcha_type = ${toml(config.captcha_type)}`,
      `px_captcha_key = ${toml(config.captcha_key)}`,
      `captcharun_need_proxy_type = ${toml(captchaProxyType)}`,
      `proxy_type = ${toml(proxyType)}`,
      `proxy_url = ${toml(config.proxy_mode === "api" ? config.proxy_value : "")}`,
      `scope_proxy_type = ${toml(scopeProxyType)}`,
      `scope_proxy_url = ${toml(config.proxy_mode === "api" ? config.proxy_value : "")}`,
      'soft_key = ""',
      'random_status = "3"',
      `random_account_format = ${toml(config.account_format)}`,
      'first_name_type = "1"',
      'first_name = ""',
      'last_name = ""',
      'password_type = "2"',
      `password_string = ${toml(config.password_format)}`,
      `concurrency_num = ${toml(config.concurrency)}`,
      `register_max_num = ${toml(config.quantity)}`,
      'captcha_error_num = "100000"',
      `imap_and_oauth_enabled = ${toml(config.oauth_mode)}`,
      `chrome_version = ${toml(config.chrome_version)}`,
      'auth_service_url = "http://127.0.0.1:8081/api/scope"',
      `server_upload_url = ${toml(callback)}`,
      "",
      "[server_upload_other]",
      'source = "aliashub-server-runner"',
      `runner_run_id = ${toml(runId)}`,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(runDir, "mail.toml"), contents, { mode: 0o600 });
    fs.writeFileSync(path.join(runDir, "proxyList.txt"), config.proxy_mode === "list" ? `${config.proxy_value}\n` : "", { mode: 0o600 });
    fs.writeFileSync(path.join(runDir, "mail.txt"), "", { mode: 0o600 });
  }

  runnerEnvironment(runDir) {
    const home = path.join(runDir, "home");
    const prefix = path.join(this.rootDir, "wine-prefix");
    const cache = path.join(runDir, "cache");
    const config = path.join(runDir, "config");
    const data = path.join(runDir, "data");
    const runtime = path.join(runDir, "runtime");
    [home, prefix, cache, config, data, runtime].forEach((directory) => fs.mkdirSync(directory, { recursive: true, mode: 0o700 }));
    return {
      ...process.env,
      HOME: home,
      WINEPREFIX: prefix,
      WINEARCH: "win64",
      WINEDEBUG: "-all",
      WINEDLLOVERRIDES: "mscoree,mshtml=;winemenubuilder.exe=d",
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_RUNTIME_DIR: runtime,
    };
  }

  appendLog(runId, stream, message, level = "info", secrets = []) {
    const line = redact(message, secrets).trim();
    if (!line) return;
    this.db.prepare(`
      INSERT INTO microsoft_registration_runner_logs (run_id, stream, level, message, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, stream, level, line, nowIso());
  }

  captureOutput(child, runId, stream, secrets) {
    const read = (source, level) => {
      if (!source?.on) return;
      const decoder = new StringDecoder("utf8");
      const filter = createPayloadLogFilter(secrets);
      let pending = "";
      source.on("data", (chunk) => {
        pending += decoder.write(chunk);
        const lines = pending.split(/\r\n|[\r\n]/);
        pending = lines.pop() || "";
        lines.forEach((line) => {
          const safe = filter.filter(line);
          if (safe) this.appendLog(runId, stream, safe, level, secrets);
        });
      });
      source.on("end", () => {
        pending += decoder.end();
        const safe = filter.filter(pending);
        if (safe) this.appendLog(runId, stream, safe, level, secrets);
      });
    };
    read(child.stdout, "info");
    read(child.stderr, "error");
  }

  driveInteractivePrompts(child, config, runId) {
    if (!child?.stdout?.on || !child?.stdin?.write) return;
    const answered = new Set();
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let terminalFailure = false;
    const answer = (name, value) => {
      if (answered.has(name)) return;
      answered.add(name);
      try { child.stdin.write(`${value}\n`); } catch { /* the registrar already exited */ }
    };
    const processChunk = (chunk) => {
      const text = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk || "");
      pending = stripAnsi(`${pending}${text}`).slice(-8_000);
      if (/请输入并发数\s*:/.test(pending)) answer("concurrency", config.concurrency);
      if (/请输入注册最大数量\s*:/.test(pending)) answer("quantity", config.quantity);
      if (/请选择国家\s*:/.test(pending)) answer("country", "");
      if (/请选择.*邮箱后缀\s*:/.test(pending)) answer("domain", "");
      if (/按压验证失败|打码平台\s*打码失败|重试次数达到上限/.test(pending)) terminalFailure = true;
      if (/程序执行结果汇总/.test(pending) && /程序运行时长/.test(pending)) {
        this.scheduleTerminalFinish(
          runId,
          terminalFailure ? "failed" : "completed",
          terminalFailure ? "注册机打码失败，重试次数达到上限" : "注册机已完成",
        );
      }
    };
    child.stdout.on("data", processChunk);
    child.stdout.once("end", () => processChunk(decoder.end()));
  }

  spawnWindowsProcess(executable, runDir, environment, { interactive = false } = {}) {
    const xvfbArguments = ["-a", "-f", path.join(runDir, "Xauthority"), "-e", path.join(runDir, "xvfb.log")];
    if (interactive) {
      const command = [
        shellQuote(this.xvfbBinary),
        ...xvfbArguments.map(shellQuote),
        shellQuote(this.wineBinary),
        shellQuote(executable),
      ].join(" ");
      return this.spawn(this.scriptBinary, ["-q", "-e", "-c", command, "/dev/null"], {
        cwd: runDir,
        env: environment,
        detached: process.platform !== "win32",
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
    return this.spawn(this.xvfbBinary, [...xvfbArguments, this.wineBinary, executable], {
      cwd: runDir,
      env: environment,
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  async portInUse(port = AUTH_PORT) {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      const finish = (value) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(500);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    });
  }

  async waitForLocalPort(port = AUTH_PORT, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.portInUse(port)) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  updateRun(runId, values = {}) {
    const entries = Object.entries(values);
    if (!entries.length) return this.run(runId);
    const timestamp = nowIso();
    const columns = entries.map(([key]) => `${key} = ?`).join(", ");
    this.db.prepare(`UPDATE microsoft_registration_runner_runs SET ${columns}, updated_at = ? WHERE id = ?`)
      .run(...entries.map(([, value]) => value), timestamp, runId);
    return this.run(runId);
  }

  run(id) {
    const runId = Number(id);
    if (!Number.isSafeInteger(runId) || runId <= 0) throw failure("注册任务 ID 无效");
    const row = this.db.prepare("SELECT * FROM microsoft_registration_runner_runs WHERE id = ?").get(runId);
    if (!row) throw failure("服务器注册任务不存在", 404, "MICROSOFT_RUNNER_NOT_FOUND");
    return row;
  }

  finish(runId, status, { message = "", exitCode = null } = {}) {
    const row = this.run(runId);
    if (FINISHED_STATUSES.has(row.status)) return row;
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE microsoft_registration_runner_runs
      SET status = ?, phase = ?, message = ?, exit_code = ?, finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, status, message, exitCode, timestamp, timestamp, runId);
    const processInfo = this.processes.get(runId);
    this.processes.delete(runId);
    if (processInfo?.terminalTimer) clearTimeout(processInfo.terminalTimer);
    this.killChild(processInfo?.registrar);
    this.killChild(processInfo?.auth);
    if (processInfo?.runDir) {
      const cleanup = () => fs.rmSync(processInfo.runDir, { recursive: true, force: true });
      const timer = setTimeout(cleanup, 60_000);
      timer.unref?.();
    }
    return this.run(runId);
  }

  killChild(child) {
    if (!child?.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch { /* process already stopped */ }
    }
  }

  scheduleTerminalFinish(runId, status, message) {
    const processInfo = this.processes.get(runId);
    if (!processInfo?.registrar || processInfo.terminalTimer) return;
    const timer = setTimeout(() => {
      const active = this.processes.get(runId);
      if (active?.terminalTimer === timer) active.terminalTimer = null;
      const row = this.run(runId);
      if (activeStatus(row.status)) this.finish(runId, status, { message });
    }, 2_000);
    timer.unref?.();
    processInfo.terminalTimer = timer;
  }

  watchChild(runId, child, kind, secrets) {
    if (!child?.on) throw failure("无法启动服务器注册机进程", 500, "MICROSOFT_RUNNER_START_FAILED");
    this.captureOutput(child, runId, kind, secrets);
    child.once("error", (error) => {
      this.appendLog(runId, kind, error.message, "error", secrets);
      const row = this.run(runId);
      if (activeStatus(row.status)) this.finish(runId, "failed", { message: "注册机进程启动失败" });
    });
    child.once("exit", (code, signal) => {
      const row = this.run(runId);
      if (!activeStatus(row.status)) return;
      if (kind === "auth") {
        const info = this.processes.get(runId);
        this.killChild(info?.registrar);
        this.finish(runId, "failed", { message: `授权服务已退出${signal ? ` (${signal})` : ""}`, exitCode: code });
        return;
      }
      if (row.stop_requested) {
        this.finish(runId, "cancelled", { message: "已停止服务器注册任务", exitCode: code });
      } else if (code === 0) {
        this.finish(runId, "completed", { message: "注册机已完成", exitCode: code });
      } else {
        this.finish(runId, "failed", { message: `注册机已退出${signal ? ` (${signal})` : ""}`, exitCode: code });
      }
    });
  }

  async start(publicBaseUrl) {
    this.requireTool();
    if (this.currentRun()) throw failure("已有服务器注册任务正在运行", 409, "MICROSOFT_RUNNER_ALREADY_ACTIVE");
    if (await this.portInUse()) throw failure("服务器本地 8081 端口正在被占用，请先停止其他注册机", 409, "MICROSOFT_RUNNER_PORT_BUSY");
    const { config } = this.requireSavedConfiguration();
    const timestamp = nowIso();
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + CALLBACK_TTL_MS).toISOString();
    const inserted = this.db.prepare(`
      INSERT INTO microsoft_registration_runner_runs (
        status, phase, account_format, quantity, concurrency, proxy_mode, proxy_count,
        callback_token_hash, callback_expires_at, created_at, updated_at
      ) VALUES ('starting', 'authorization', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(config.account_format, config.quantity, config.concurrency, config.proxy_mode, config.proxy_count, sha256(token), expiresAt, timestamp, timestamp);
    const runId = Number(inserted.lastInsertRowid);
    const runDir = this.ensureRunDirectory(runId);
    const callback = callbackUrl(publicBaseUrl, runId, token);
    const secrets = [config.captcha_key, config.proxy_value, token, callback];
    try {
      this.writeRunFiles(runDir, config, runId, callback);
      const environment = this.runnerEnvironment(runDir);
      this.appendLog(runId, "system", "正在启动服务器授权服务", "info", secrets);
      const auth = this.spawnWindowsProcess(this.authExecutable, runDir, environment);
      this.processes.set(runId, { runDir, auth, registrar: null, secrets, terminalTimer: null });
      this.watchChild(runId, auth, "auth", secrets);
      this.updateRun(runId, { auth_pid: Number(auth.pid) || null });
      const ready = await this.waitForPort(AUTH_PORT, 20_000);
      const active = this.run(runId);
      if (!activeStatus(active.status)) return publicRun(active);
      if (!ready) throw failure("授权服务启动超时", 500, "MICROSOFT_RUNNER_AUTH_TIMEOUT");
      this.appendLog(runId, "system", "授权服务已就绪，正在启动注册机", "info", secrets);
      const registrar = this.spawnWindowsProcess(this.registrarExecutable, runDir, environment, { interactive: true });
      const info = this.processes.get(runId);
      if (info) info.registrar = registrar;
      this.watchChild(runId, registrar, "registrar", secrets);
      this.driveInteractivePrompts(registrar, config, runId);
      this.updateRun(runId, {
        status: "running",
        phase: "registrar",
        runner_pid: Number(registrar.pid) || null,
        started_at: nowIso(),
        message: "服务器注册机正在运行",
      });
      audit(this.db, null, "microsoft_registration_runner", "启动服务器微软注册机", `任务 #${runId}`, {
        quantity: config.quantity,
        concurrency: config.concurrency,
        proxyMode: config.proxy_mode,
        proxyCount: config.proxy_count,
      });
      return publicRun(this.run(runId));
    } catch (error) {
      const info = this.processes.get(runId);
      this.killChild(info?.registrar);
      this.killChild(info?.auth);
      this.appendLog(runId, "system", error.message, "error", secrets);
      this.finish(runId, "failed", { message: error.message });
      throw error;
    }
  }

  stop() {
    const row = this.currentRun();
    if (!row) return { stopped: false, run: null };
    const info = this.processes.get(row.id);
    this.updateRun(row.id, { status: "stopping", phase: "stopping", stop_requested: 1, message: "正在停止服务器注册机" });
    this.killChild(info?.registrar);
    this.killChild(info?.auth);
    const finished = this.finish(row.id, "cancelled", { message: "已停止服务器注册任务" });
    audit(this.db, null, "microsoft_registration_runner", "停止服务器微软注册机", `任务 #${row.id}`, {});
    return { stopped: true, run: publicRun(finished) };
  }

  async stopForShutdown() {
    if (!this.currentRun()) return;
    this.stop();
  }

  authorizeCallback(runId, token) {
    const row = this.run(runId);
    if (!activeStatus(row.status) || !row.callback_expires_at || new Date(row.callback_expires_at).getTime() < Date.now()) {
      throw failure("注册任务回传地址已失效", 401, "MICROSOFT_RUNNER_CALLBACK_EXPIRED");
    }
    if (!safeEqual(sha256(token), row.callback_token_hash)) {
      throw failure("注册任务回传地址无效", 401, "MICROSOFT_RUNNER_CALLBACK_UNAUTHORIZED");
    }
    return row;
  }

  ingest(runId, token, body, registrationService) {
    const row = this.authorizeCallback(runId, token);
    if (!registrationService?.ingestTrusted) throw failure("微软注册回传服务不可用", 500, "MICROSOFT_RUNNER_INGEST_UNAVAILABLE");
    const result = registrationService.ingestTrusted(body);
    const received = Number(result.accepted || 0) + Number(result.updated || 0);
    this.updateRun(row.id, {
      received_count: Number(row.received_count || 0) + received,
      last_received_at: nowIso(),
      message: received ? `已接收 ${Number(row.received_count || 0) + received} 条注册结果` : row.message,
    });
    this.appendLog(row.id, "system", received ? `已接收 ${received} 条注册结果` : "收到重复或无效的注册回传", "info");
    return result;
  }

  logs({ runId, afterId, limit } = {}) {
    const resolvedRunId = runId === undefined || runId === null || runId === ""
      ? this.db.prepare("SELECT id FROM microsoft_registration_runner_runs ORDER BY id DESC LIMIT 1").get()?.id
      : Number(runId);
    if (!resolvedRunId) return { run_id: null, items: [] };
    this.run(resolvedRunId);
    const after = Number(afterId) || 0;
    const count = Math.max(1, Math.min(500, Number(limit) || 200));
    const items = this.db.prepare(`
      SELECT id, run_id, stream, level, message, created_at
      FROM microsoft_registration_runner_logs
      WHERE run_id = ? AND id > ?
      ORDER BY id ASC LIMIT ?
    `).all(resolvedRunId, after, count);
    return { run_id: resolvedRunId, items };
  }
}
