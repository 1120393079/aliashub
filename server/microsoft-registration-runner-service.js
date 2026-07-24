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
const PROXY_SOURCE_MANUAL = "manual";
const PROXY_SOURCE_SAVED_POOL = "saved_pool";
const COUNTRY_PROMPT_LABELS = {
  JP: "日本",
  US: "美国",
};

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

function normalizeProxySource(value) {
  const source = trimText(value, 32).toLowerCase() || PROXY_SOURCE_MANUAL;
  if (![PROXY_SOURCE_MANUAL, PROXY_SOURCE_SAVED_POOL].includes(source)) {
    throw failure("代理来源无效");
  }
  return source;
}

function normalizeSavedProxySelection(value) {
  const selection = trimText(value, 80).toLowerCase() || "auto";
  if (selection === "auto") return selection;
  if (!/^saved:[a-f0-9]{64}$/.test(selection)) {
    throw failure("已保存 IP 选择无效");
  }
  return selection;
}

function savedProxyId(value, referenceKey) {
  return `saved:${crypto.createHmac("sha256", referenceKey).update(String(value || "")).digest("hex")}`;
}

function maskSavedProxy(parsed) {
  const host = String(parsed.hostname || "").replace(/^\[|\]$/g, "");
  const authority = parsed.username ? "***@" : "";
  return `${parsed.protocol}//${authority}${host}${parsed.port ? `:${parsed.port}` : ""}`;
}

function savedProxyRunnerLine(value, index, referenceKey) {
  const id = savedProxyId(value, referenceKey);
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return { id, index, label: `已保存代理 ${index + 1}`, line: "", reason: "地址格式无效" };
  }
  const label = maskSavedProxy(parsed);
  if (parsed.protocol !== "http:") {
    return { id, index, label, line: "", reason: "服务器注册机仅支持 HTTP 账号密码代理" };
  }
  if (!parsed.username || !parsed.password || !parsed.port) {
    return { id, index, label, line: "", reason: "缺少账号、密码或端口" };
  }
  const hostname = String(parsed.hostname || "").replace(/^\[|\]$/g, "");
  if (!hostname || hostname.includes(":")) {
    return { id, index, label, line: "", reason: "不支持 IPv6 代理地址" };
  }
  let username;
  let password;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    return { id, index, label, line: "", reason: "账号或密码编码无效" };
  }
  if (!username || !password || /[\s:@]/.test(username) || /[\s@]/.test(password)) {
    return { id, index, label, line: "", reason: "账号或密码包含注册机不支持的字符" };
  }
  return {
    id,
    index,
    label,
    line: `${username}:${password}@${hostname}:${parsed.port}`,
    reason: "",
  };
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
    proxy_source: row.proxy_source || PROXY_SOURCE_MANUAL,
    proxy_selection: row.proxy_selection || "",
    proxy_label: row.proxy_label || "",
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

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function withRunMetadata(body, row, source) {
  const payload = plainObject(body) ? body : { data: body };
  const uploaded = plainObject(payload.server_upload_other) ? payload.server_upload_other : {};
  return {
    ...payload,
    server_upload_other: {
      ...uploaded,
      source: trimText(uploaded.source, 120) || source,
      runner_run_id: String(row.id),
      runner_proxy_label: trimText(row.proxy_label, 255),
      runner_proxy_source: trimText(row.proxy_source, 32) || PROXY_SOURCE_MANUAL,
    },
  };
}

function normalizeProxyLine(value) {
  const text = trimText(value, 1_000);
  if (!text || /\s/.test(text)) return "";
  const existing = /^([^:@\s]+):([^@\s]+)@([^:@\s]+):(\d{1,5})$/.exec(text);
  const colonSeparated = /^([^:@\s]+):([^:@\s]+):([^:@\s]+):(\d{1,5})$/.exec(text);
  const match = existing || colonSeparated;
  if (!match || Number(match[4]) < 1 || Number(match[4]) > 65_535) return "";
  return `${match[1]}:${match[2]}@${match[3]}:${match[4]}`;
}

function normalizeCountryCode(value) {
  const code = trimText(value, 8).toUpperCase();
  if (!code || code === "AUTO") return "auto";
  if (!Object.hasOwn(COUNTRY_PROMPT_LABELS, code)) {
    throw failure("注册地区只支持自动、日本或美国");
  }
  return code;
}

function proxyRegionCode(value) {
  const username = /^([^:@\s]+):/.exec(String(value || ""))?.[1] || "";
  const match = /(?:^|[-_])(?:region|country)[-_]?([A-Za-z]{2})(?=$|[-_])/i.exec(username);
  const code = String(match?.[1] || "").toUpperCase();
  return Object.hasOwn(COUNTRY_PROMPT_LABELS, code) ? code : "";
}

function detectedProxyRegion(config) {
  if (config?.proxy_mode !== "list") return "";
  const codes = splitLines(config.proxy_value).map(proxyRegionCode);
  if (!codes.length || codes.some((code) => !code)) return "";
  return new Set(codes).size === 1 ? codes[0] : "";
}

function countryPromptValue(config) {
  const configured = normalizeCountryCode(config?.country_code);
  const code = configured === "auto" ? detectedProxyRegion(config) : configured;
  return COUNTRY_PROMPT_LABELS[code] || "";
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
    .replace(/\b[^\s:@]{1,100}:[^\s@]{1,100}@[^\s/:]+:\d{1,5}\b/g, "[代理已隐藏]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[已隐藏]");
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

const REGISTRAR_FAILURE_TYPES = [
  { expression: /按压验证失败/gi, message: "按压验证失败" },
  { expression: /打码平台\s*打码失败/gi, message: "打码平台处理失败" },
  { expression: /无感验证提交失败/gi, message: "无感验证提交失败" },
  { expression: /(?:微软风控初始化失败|微软(?:入口网页地址|请求)[^\r\n]{0,120}请求失败)/gi, message: "Microsoft 注册请求失败" },
  { expression: /获取代理失败|代理.*?(?:解析|连接|认证).*?失败|Invalid format/gi, message: "代理不可用或格式无效" },
  { expression: /注册失败/gi, message: "Microsoft 注册失败" },
  { expression: /重试次数达到上限/gi, message: "注册重试次数达到上限" },
];

function classifyRegistrarFailure(value) {
  const text = stripAnsi(value);
  let latest = null;
  for (const item of REGISTRAR_FAILURE_TYPES) {
    const expression = new RegExp(item.expression.source, item.expression.flags);
    let match;
    while ((match = expression.exec(text))) {
      if (!latest || match.index >= latest.index) latest = { index: match.index, message: item.message };
      if (!match[0]) expression.lastIndex += 1;
    }
  }
  return latest?.message || "";
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

function runnerCallbackBaseUrl(publicBaseUrl) {
  const configured = trimText(process.env.MICROSOFT_REGISTRATION_CALLBACK_BASE_URL, 2_000);
  if (configured) return configured;
  const port = integer(process.env.PORT, 4180, 1, 65_535);
  return `http://127.0.0.1:${port}`;
}

function defaultConfig() {
  return {
    captcha_type: "3",
    captcha_key: "",
    proxy_mode: "list",
    proxy_source: PROXY_SOURCE_MANUAL,
    saved_proxy_selection: "auto",
    proxy_value: "",
    account_format: "aaaaa11111111",
    password_format: "aaaaa11111111",
    quantity: 1,
    concurrency: 1,
    oauth_mode: "1",
    chrome_version: "143",
    country_code: "auto",
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
    registrationService,
    proxyProvider,
    spawnFn = nodeSpawn,
    waitForPort,
  } = {}) {
    this.db = db;
    this.encryptionKey = encryptionKey
      ? crypto.createHash("sha256").update(String(encryptionKey)).digest()
      : null;
    this.proxyReferenceKey = this.encryptionKey || crypto.randomBytes(32);
    this.dataDir = path.resolve(dataDir || path.join(process.cwd(), "data"));
    this.rootDir = path.join(this.dataDir, "microsoft-registration-runner");
    this.toolDir = path.resolve(toolDir || process.env.MICROSOFT_REGISTRATION_RUNNER_DIR || path.join(process.cwd(), "release", "microsoft-registration-runner"));
    this.wineBinary = wineBinary;
    this.xvfbBinary = xvfbBinary;
    this.scriptBinary = scriptBinary;
    this.registrationService = registrationService || null;
    this.proxyProvider = typeof proxyProvider === "function" ? proxyProvider : null;
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

  setProxyProvider(proxyProvider) {
    this.proxyProvider = typeof proxyProvider === "function" ? proxyProvider : null;
  }

  savedProxyEntries() {
    let values = [];
    try {
      values = this.proxyProvider ? this.proxyProvider() : [];
    } catch {
      values = [];
    }
    if (!Array.isArray(values)) values = [];
    return values.map((value, index) => savedProxyRunnerLine(value, index, this.proxyReferenceKey));
  }

  publicSavedProxyPool() {
    const entries = this.savedProxyEntries();
    const usable = entries.filter((item) => item.line);
    return {
      total: entries.length,
      compatible_count: usable.length,
      options: entries.map(({ id, index, label, line, reason }) => ({
        id,
        index,
        label,
        compatible: Boolean(line),
        reason: line ? "" : reason,
      })),
    };
  }

  resolveSavedProxySelection(selection) {
    const normalizedSelection = normalizeSavedProxySelection(selection);
    const entries = this.savedProxyEntries();
    const selected = normalizedSelection === "auto"
      ? entries.filter((item) => item.line)
      : entries.filter((item) => item.id === normalizedSelection);
    if (!selected.length) {
      throw failure(normalizedSelection === "auto"
        ? "已保存 IP/代理池中没有可用于服务器注册机的 HTTP 账号密码代理"
        : "所选保存 IP 已不存在，请重新选择");
    }
    const unsupported = selected.find((item) => !item.line);
    if (unsupported) {
      throw failure(`所选保存 IP 不可用于服务器注册机：${unsupported.reason}`);
    }
    return {
      selection: normalizedSelection,
      entries: selected,
      proxy_value: selected.map((item) => item.line).join("\n"),
      proxy_count: selected.length,
      proxy_label: normalizedSelection === "auto"
        ? `已保存 IP池自动轮换（${selected.length} 条）`
        : `已保存 IP：${selected[0].label}`,
    };
  }

  effectiveConfiguration(config) {
    if (config.proxy_source !== PROXY_SOURCE_SAVED_POOL) {
      return {
        ...config,
        proxy_label: config.proxy_mode === "api"
          ? "手动动态代理 API"
          : `手动代理列表（${config.proxy_count} 条）`,
      };
    }
    const saved = this.resolveSavedProxySelection(config.saved_proxy_selection);
    return {
      ...config,
      proxy_mode: "list",
      proxy_value: saved.proxy_value,
      proxy_count: saved.proxy_count,
      saved_proxy_selection: saved.selection,
      proxy_label: saved.proxy_label,
    };
  }

  ensureCountryMatchesProxy(config) {
    const configuredCountry = normalizeCountryCode(config?.country_code);
    const detectedCountry = detectedProxyRegion(config);
    if (configuredCountry !== "auto" && detectedCountry && configuredCountry !== detectedCountry) {
      throw failure(`所选代理统一为${COUNTRY_PROMPT_LABELS[detectedCountry] || detectedCountry}，请把注册地区改为自动或${COUNTRY_PROMPT_LABELS[detectedCountry] || detectedCountry}`);
    }
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
    let config = defaultConfig();
    let effective = config;
    let configurationError = "";
    let detectedCountryCode = "";
    if (row?.secret_payload_encrypted) {
      try {
        config = this.storedConfiguration(row);
        effective = this.effectiveConfiguration(config);
        this.ensureCountryMatchesProxy(effective);
        detectedCountryCode = detectedProxyRegion(effective);
      } catch (error) {
        configurationError = error.message || "服务器注册配置不可用";
      }
    }
    const savedProxyPool = this.publicSavedProxyPool();
    const proxyCount = Number(effective.proxy_count) || 0;
    const proxyConfigured = Boolean(row?.secret_payload_encrypted && row?.captcha_key_configured && proxyCount && !configurationError);
    return {
      available: this.encryptionReady && toolReady,
      encryption_ready: this.encryptionReady,
      tool_ready: toolReady,
      configured: proxyConfigured,
      captcha_key_configured: Boolean(row?.captcha_key_configured),
      proxy: {
        configured: proxyConfigured,
        mode: effective.proxy_mode || row?.proxy_mode || "list",
        count: proxyCount,
        source: config.proxy_source,
        selection: config.proxy_source === PROXY_SOURCE_SAVED_POOL ? config.saved_proxy_selection : "",
        label: effective.proxy_label || "",
        error: configurationError,
      },
      saved_proxy_pool: savedProxyPool,
      account_format: row?.account_format || defaultConfig().account_format,
      password_format: row?.password_format || defaultConfig().password_format,
      quantity: Number(row?.quantity) || 1,
      concurrency: Number(row?.concurrency) || 1,
      captcha_type: row?.captcha_type || defaultConfig().captcha_type,
      oauth_mode: row?.oauth_mode || defaultConfig().oauth_mode,
      chrome_version: row?.chrome_version || defaultConfig().chrome_version,
      country_code: config.country_code,
      detected_country_code: detectedCountryCode,
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
    const secrets = this.configSecrets(row);
    const legacyProxySource = secrets.proxy_source || (row ? PROXY_SOURCE_MANUAL : defaultConfig().proxy_source);
    return {
      ...defaultConfig(),
      ...stored,
      ...secrets,
      proxy_source: normalizeProxySource(legacyProxySource),
      saved_proxy_selection: normalizeSavedProxySelection(secrets.saved_proxy_selection),
    };
  }

  normalizeConfiguration(input = {}, existing = defaultConfig()) {
    const has = (key) => Object.hasOwn(input, key);
    const captchaType = has("captcha_type") ? trimText(input.captcha_type, 1) : existing.captcha_type;
    if (!["1", "2", "3"].includes(captchaType)) throw failure("打码平台类型无效");
    const captchaKey = has("captcha_key") ? trimText(input.captcha_key, 2_000) : existing.captcha_key;
    if (!captchaKey) throw failure("请填写打码平台 Key");
    const proxySource = normalizeProxySource(has("proxy_source") ? input.proxy_source : existing.proxy_source);
    let proxyMode = has("proxy_mode") ? trimText(input.proxy_mode, 10) : existing.proxy_mode;
    if (!["list", "api"].includes(proxyMode)) throw failure("代理类型无效");
    const savedProxySelection = proxySource === PROXY_SOURCE_SAVED_POOL
      ? normalizeSavedProxySelection(has("saved_proxy_selection") ? input.saved_proxy_selection : existing.saved_proxy_selection)
      : "auto";
    let proxyValue = has("proxy_value") ? trimText(input.proxy_value, MAX_PROXY_TEXT) : existing.proxy_value;
    let proxyCount = 0;
    let effectiveProxyValue = proxyValue;
    if (proxySource === PROXY_SOURCE_SAVED_POOL) {
      if (proxyMode !== "list") throw failure("已保存 IP/代理池只支持账号密码代理列表");
      const saved = this.resolveSavedProxySelection(savedProxySelection);
      proxyMode = "list";
      effectiveProxyValue = saved.proxy_value;
      proxyCount = saved.proxy_count;
    } else if (!proxyValue) {
      throw failure(proxyMode === "list" ? "请粘贴账号密码代理列表" : "请填写动态代理 API 地址");
    } else if (proxyMode === "list") {
      const proxies = splitLines(proxyValue).map(normalizeProxyLine);
      if (!proxies.length || proxies.length > MAX_PROXY_LINES || proxies.some((item) => !item)) {
        throw failure("代理列表格式错误，请使用 username:password@host:port 或 username:password:host:port，每行一个");
      }
      proxyValue = proxies.join("\n");
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
    if (captchaType === "3" && proxyMode !== "list") {
      throw failure("CaptchaRun Two 只支持账号密码代理列表，请使用 username:password@host:port");
    }
    const chromeVersion = integer(has("chrome_version") ? input.chrome_version : existing.chrome_version, 143, 128, 144);
    const countryCode = normalizeCountryCode(has("country_code") ? input.country_code : existing.country_code);
    const normalized = {
      captcha_type: captchaType,
      captcha_key: captchaKey,
      proxy_mode: proxyMode,
      proxy_source: proxySource,
      saved_proxy_selection: savedProxySelection,
      proxy_value: proxyValue,
      proxy_count: proxyCount,
      account_format: accountFormat,
      password_format: passwordFormat,
      quantity,
      concurrency,
      oauth_mode: oauthMode,
      chrome_version: String(chromeVersion),
      country_code: countryCode,
    };
    this.ensureCountryMatchesProxy({ ...normalized, proxy_value: effectiveProxyValue });
    return normalized;
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
      this.encrypt({
        captcha_key: normalized.captcha_key,
        proxy_value: normalized.proxy_value,
        proxy_source: normalized.proxy_source,
        saved_proxy_selection: normalized.saved_proxy_selection,
        country_code: normalized.country_code,
      }),
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
      proxySource: normalized.proxy_source,
      savedProxySelection: normalized.proxy_source === PROXY_SOURCE_SAVED_POOL ? normalized.saved_proxy_selection : "",
      proxyCount: normalized.proxy_count,
      quantity: normalized.quantity,
      concurrency: normalized.concurrency,
      countryCode: normalized.country_code,
    });
    return this.configuration();
  }

  requireTool() {
    if (!this.toolReady()) throw failure("服务器注册机文件未就绪", 409, "MICROSOFT_RUNNER_TOOL_NOT_READY");
  }

  requireSavedConfiguration() {
    this.requireEncryption();
    const row = this.db.prepare("SELECT * FROM microsoft_registration_runner_config WHERE id = 1").get();
    if (!row?.secret_payload_encrypted || !row.captcha_key_configured) {
      throw failure("请先填写并保存打码 Key 与代理配置", 409, "MICROSOFT_RUNNER_CONFIG_REQUIRED");
    }
    const config = this.effectiveConfiguration(this.storedConfiguration(row));
    if (!config.proxy_count || !config.proxy_value) {
      throw failure("请先填写并保存打码 Key 与代理配置", 409, "MICROSOFT_RUNNER_CONFIG_REQUIRED");
    }
    if (config.captcha_type === "3" && config.proxy_mode !== "list") {
      throw failure("CaptchaRun Two 只支持账号密码代理列表，请使用 username:password@host:port", 409, "MICROSOFT_RUNNER_PROXY_MODE_REQUIRED");
    }
    this.ensureCountryMatchesProxy(config);
    return { row, config };
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
      `runner_proxy_label = ${toml(config.proxy_label)}`,
      `runner_proxy_source = ${toml(config.proxy_source)}`,
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
    const filter = createPayloadLogFilter(secrets);
    const read = (source, level) => {
      if (!source?.on) return;
      const decoder = new StringDecoder("utf8");
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
    let failureReason = "";
    let loggedFailureReason = "";
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
      if (/请选择国家\s*:/.test(pending)) answer("country", countryPromptValue(config));
      if (/请选择.*邮箱后缀\s*:/.test(pending)) answer("domain", "");
      const classifiedFailure = classifyRegistrarFailure(pending);
      if (classifiedFailure) failureReason = classifiedFailure;
      if (failureReason && failureReason !== loggedFailureReason) {
        loggedFailureReason = failureReason;
        this.appendLog(runId, "system", `注册机失败阶段：${failureReason}`, "error");
      }
      if (/程序执行结果汇总/.test(pending) && /程序运行时长/.test(pending)) {
        const successes = Number(/注册成功次数\s*[:：]\s*(\d+)/.exec(pending)?.[1] || 0);
        const failed = successes === 0 && Boolean(failureReason);
        this.scheduleTerminalFinish(
          runId,
          failed ? "failed" : "completed",
          failed ? `注册机失败：${failureReason}` : successes > 0 ? "注册机已完成" : "注册机已完成（未产生成功账号）",
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

  importSavedResults(runId, runDir) {
    if (!this.registrationService?.ingestTrusted || !runDir) return { received: 0 };
    try {
      const row = this.run(runId);
      const file = path.join(runDir, "注册成功(总).txt");
      if (!fs.existsSync(file)) return { received: 0 };
      const items = splitLines(fs.readFileSync(file, "utf8"))
        .map((line) => {
          const separator = line.indexOf("----");
          if (separator < 1) return null;
          const email = line.slice(0, separator).trim();
          const password = line.slice(separator + 4).trim();
          if (!/^[^\s@]+@(outlook|hotmail|live)\.[a-z]{2,}$/i.test(email) || !password) return null;
          return { email, password, status: "success", runner_run_id: String(runId) };
        })
        .filter(Boolean)
        .slice(0, 100);
      if (!items.length) return { received: 0 };
      const payload = withRunMetadata({
        data: items,
        server_upload_other: { source: "go-ms-server-runner-file", runner_run_id: String(runId) },
      }, row, "go-ms-server-runner-file");
      const result = this.registrationService.ingestTrusted(payload, {
        fallbackProxyLabel: row.proxy_label,
      });
      const received = Number(result.accepted || 0) + Number(result.updated || 0);
      if (received) this.appendLog(runId, "system", `已从注册机结果文件导入 ${received} 条注册邮箱`, "info");
      return { received };
    } catch (error) {
      this.appendLog(runId, "system", `注册结果文件导入失败: ${error.message}`, "error");
      return { received: 0 };
    }
  }

  finish(runId, status, { message = "", exitCode = null } = {}) {
    const row = this.run(runId);
    if (FINISHED_STATUSES.has(row.status)) return row;
    const processInfo = this.processes.get(runId);
    const recovered = row.received_count || ["cancelled", "interrupted"].includes(status)
      ? { received: 0 }
      : this.importSavedResults(runId, processInfo?.runDir);
    const receivedCount = Number(row.received_count || 0) + recovered.received;
    const finalMessage = recovered.received ? `${message || "注册机已完成"}；已从结果文件导入 ${recovered.received} 条注册邮箱` : message;
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE microsoft_registration_runner_runs
      SET status = ?, phase = ?, message = ?, exit_code = ?, received_count = ?, finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, status, finalMessage, exitCode, receivedCount, timestamp, timestamp, runId);
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
        proxy_source, proxy_selection, proxy_label,
        callback_token_hash, callback_expires_at, created_at, updated_at
      ) VALUES ('starting', 'authorization', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      config.account_format,
      config.quantity,
      config.concurrency,
      config.proxy_mode,
      config.proxy_count,
      config.proxy_source,
      config.proxy_source === PROXY_SOURCE_SAVED_POOL ? config.saved_proxy_selection : "",
      config.proxy_label,
      sha256(token),
      expiresAt,
      timestamp,
      timestamp,
    );
    const runId = Number(inserted.lastInsertRowid);
    const runDir = this.ensureRunDirectory(runId);
    const callback = callbackUrl(runnerCallbackBaseUrl(publicBaseUrl), runId, token);
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
        proxySource: config.proxy_source,
        proxySelection: config.proxy_source === PROXY_SOURCE_SAVED_POOL ? config.saved_proxy_selection : "",
        proxyLabel: config.proxy_label,
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
    const result = registrationService.ingestTrusted(
      withRunMetadata(body, row, "aliashub-server-runner"),
      { fallbackProxyLabel: row.proxy_label },
    );
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
