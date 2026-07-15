import crypto from "node:crypto";
import { isIP } from "node:net";
import { generateSplits, persistInboxScanResult } from "./account-service.js";
import { getSetting, nowIso, setSetting } from "./db.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const ACTIVE_STATUSES = new Set(["pending", "claimed", "running", "cancel_requested"]);
const RELEASABLE_JOB_STATUSES = new Set(["queued", "pending", "claimed", "running", "cancel_requested"]);
const EMAIL_UNAVAILABLE_MESSAGE = "目标站已存在此邮箱账号，建议更换基础地址";
const ACCOUNT_STATUS_REFRESH_COOLDOWN_MS = 15 * 60 * 1000;
const ACCOUNT_STATUS_REFRESH_BATCH_SIZE = 20;
const KOOKEEY_GATEWAY_HOST = /^gate-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.kookeey\.info$/i;
const KOOKEEY_STICKY_PASSWORD = /^(.+)-([a-z]{2})-(\d{4,32})-([1-9]\d{0,3})m$/i;
const KOOKEEY_MAX_SESSION_TTL_MINUTES = 1_440;

function registrationFailureReason(row = {}) {
  if (String(row.status || "").toLowerCase() !== "failed") return "";
  const text = `${row.stage || ""} ${row.message || ""}`;
  return /user_already_exists|user_exists|account_already_exists|email_already_exists|(?:user|account|email)\s+already\s+exists/i.test(text)
    ? "user_already_exists"
    : "";
}

function publicRegistrationJob(row) {
  if (!row) return row;
  const failureReason = registrationFailureReason(row);
  const message = redactProxySecrets(row.message);
  return {
    ...row,
    message,
    failure_reason: failureReason,
    display_message: failureReason === "user_already_exists" ? EMAIL_UNAVAILABLE_MESSAGE : message,
  };
}

function normalizeSelectedIds(input, label, maximum = 500) {
  if (!Array.isArray(input?.ids)) {
    throw Object.assign(new Error(`请选择要删除的${label}`), { status: 400 });
  }
  const ids = [...new Set(input.ids.map((value) => Number(value)))];
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw Object.assign(new Error(`请选择有效的${label}`), { status: 400 });
  }
  if (ids.length > maximum) throw Object.assign(new Error(`单次最多删除 ${maximum} 个${label}`), { status: 400 });
  return ids;
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseProxyPool(value) {
  let items = value;
  if (typeof items === "string") {
    try { items = JSON.parse(items); } catch { items = items.split(/\r?\n/); }
  }
  if (!Array.isArray(items)) return [];
  const normalized = [];
  for (const [index, raw] of items.entries()) {
    const source = String(raw || "");
    let proxy = source.trim();
    if (!proxy || proxy.startsWith("#")) continue;
    const invalid = () => {
      throw Object.assign(new Error(`第 ${index + 1} 条代理地址无效`), { status: 400 });
    };
    if (/[\u0000-\u001f\u007f-\u009f]/.test(source) || /\s|\\/.test(proxy)) invalid();
    if (!proxy.includes("://")) {
      const legacy = proxy.match(/^(\[[^\]]+\]|[^:]+):(\d+):([^:]+):([^:]+)$/);
      if (legacy) {
        const [, host, port, username, password] = legacy;
        try {
          proxy = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
        } catch {
          invalid();
        }
      }
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(proxy)) proxy = `http://${proxy}`;
    let parsed;
    try { parsed = new URL(proxy); } catch { invalid(); }
    if (!new Set(["http:", "https:", "socks5:"]).has(parsed.protocol) || !parsed.hostname) invalid();

    const authorityStart = proxy.indexOf("://") + 3;
    if (authorityStart < 3 || proxy.slice(authorityStart).search(/[/?#]/) >= 0) invalid();
    const authority = proxy.slice(authorityStart);
    const atCount = [...authority].filter((char) => char === "@").length;
    if (atCount > 1) invalid();
    const userInfo = atCount === 1 ? authority.slice(0, authority.indexOf("@")) : "";
    const hostPort = atCount === 1 ? authority.slice(authority.indexOf("@") + 1) : authority;
    const portMatch = hostPort.startsWith("[")
      ? hostPort.match(/^\[[^\]]+\]:(\d+)$/)
      : hostPort.match(/^[^:]+:(\d+)$/);
    const port = Number(portMatch?.[1]);
    if (!portMatch || !Number.isInteger(port) || port < 1 || port > 65535 || parsed.hostname.includes("%")) invalid();
    const rawHostname = hostPort.startsWith("[")
      ? hostPort.slice(1, hostPort.lastIndexOf("]"))
      : hostPort.slice(0, hostPort.lastIndexOf(":"));
    if (!rawHostname || rawHostname.includes("%")) invalid();
    const parsedHostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
    if (!isIP(parsedHostname)) {
      const domain = parsedHostname.endsWith(".") ? parsedHostname.slice(0, -1) : parsedHostname;
      if (!domain || domain.split(".").some((label) => !label)) invalid();
    }

    if (atCount === 1) {
      if (parsed.protocol === "socks5:") invalid();
      const separator = userInfo.indexOf(":");
      if (separator <= 0 || separator === userInfo.length - 1) invalid();
      try {
        const username = decodeURIComponent(userInfo.slice(0, separator));
        const password = decodeURIComponent(userInfo.slice(separator + 1));
        if (!username || !password || /[\u0000-\u001f\u007f-\u009f]/.test(`${username}${password}`)) invalid();
      } catch {
        invalid();
      }
    } else if (parsed.username || parsed.password) {
      invalid();
    }
    const result = `${parsed.protocol}//${authority}`;
    if (!normalized.includes(result)) normalized.push(result);
  }
  if (normalized.length > 200) throw Object.assign(new Error("代理池最多保存 200 条"), { status: 400 });
  return normalized;
}

function maskProxy(value) {
  if (!value) return "直连";
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.username ? "***@" : ""}${parsed.hostname}:${parsed.port}`;
  } catch { return "已配置代理"; }
}

function redactProxySecrets(value) {
  return String(value ?? "")
    .replace(/\b([a-z][a-z0-9+.-]*:(?:\\?\/){2})([^\s/?#@]+)@/gi, "$1***@")
    .replace(/((?:\[[0-9a-f:.]+\]|localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+|\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}):[^\s:]+:[^\s,;，]+/gi, "$1:***:***")
    .replace(/(?<![a-z0-9])(?:[a-z0-9._~!$&'()*+,;=%-]+)-[a-z]{2}-\d{4,32}-[1-9]\d{0,3}m(?![a-z0-9])/gi, "[REDACTED]")
    .replace(/((?:proxy(?:[\s_.-]*(?:url|uri|address|server|username|user|password|pass|auth(?:orization)?|credentials?|session(?:[\s_.-]*id)?))?|代理(?:地址|服务器|用户名|用户|密码|认证|凭据|会话(?:编号)?)?)\s*[:=：]\s*)(?:(?:basic|bearer)\s+[^\s,;]+|"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;，]+)/gi, "$1[REDACTED]");
}

function sanitizeRegistrationRemoteValue(value, proxyContext = false) {
  if (typeof value === "string") return redactProxySecrets(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeRegistrationRemoteValue(item, proxyContext));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const keyIsProxy = /proxy|代理/i.test(key);
    const explicitSecretKey = /^(?:user(?:name)?|pass(?:word)?|auth(?:orization)?|credentials?|session(?:_?id)?|token|密码|用户名|认证|凭据|会话)$/i.test(key);
    const contextualSecretKey = /(?:user(?:name)?|pass(?:word)?|auth(?:orization)?|credentials?|session(?:_?id)?|token|密码|用户名|认证|凭据|会话)/i.test(key);
    if (explicitSecretKey || ((proxyContext || keyIsProxy) && contextualSecretKey)) result[key] = "[REDACTED]";
    else result[key] = sanitizeRegistrationRemoteValue(item, proxyContext || keyIsProxy);
  }
  return result;
}

function kookeeyStickyTemplate(value) {
  try {
    const parsed = new URL(value);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)
      || !parsed.username || !parsed.password
      || !KOOKEEY_GATEWAY_HOST.test(parsed.hostname)) {
      return null;
    }
    const password = decodeURIComponent(parsed.password);
    const match = password.match(KOOKEEY_STICKY_PASSWORD);
    if (!match) return null;
    const ttlMinutes = Number(match[4]);
    if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > KOOKEEY_MAX_SESSION_TTL_MINUTES) {
      return null;
    }
    return {
      protocol: parsed.protocol,
      encodedUsername: parsed.username,
      host: parsed.host,
      passwordPrefix: match[1],
      countryCode: match[2].toUpperCase(),
      sessionId: match[3],
      sessionTtl: `${ttlMinutes}m`,
    };
  } catch {
    return null;
  }
}

function proxyMetadata(value) {
  const template = kookeeyStickyTemplate(value);
  if (!template) return null;
  return {
    provider: "Kookeey",
    dynamic_mode: "sticky_session",
    country_code: template.countryCode,
    session_ttl: template.sessionTtl,
  };
}

function randomNumericSession(length) {
  let value = String(crypto.randomInt(1, 10));
  while (value.length < length) value += String(crypto.randomInt(0, 10));
  return value;
}

function materializeProxySession(value, usedSessions = new Set()) {
  const template = kookeeyStickyTemplate(value);
  if (!template) return value;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const sessionId = randomNumericSession(template.sessionId.length);
    const sessionKey = `${template.host}\n${template.encodedUsername}\n${sessionId}`;
    if (sessionId === template.sessionId || usedSessions.has(sessionKey)) continue;
    usedSessions.add(sessionKey);
    const ttlMinutes = template.sessionTtl.slice(0, -1);
    const password = `${template.passwordPrefix}-${template.countryCode}-${sessionId}-${ttlMinutes}m`;
    return `${template.protocol}//${template.encodedUsername}:${encodeURIComponent(password)}@${template.host}`;
  }
  throw new Error("动态代理会话生成失败");
}

function safeProxySamples(result, maximum) {
  const sourceSamples = Array.isArray(result?.samples) ? result.samples : [];
  return sourceSamples.slice(0, maximum).map((item) => {
    const ip = String(item?.ip || "").trim();
    if (!isIP(ip)) throw new Error("代理检测服务返回了无效 IP");
    const latitude = Number(item?.latitude);
    const longitude = Number(item?.longitude);
    return {
      ip,
      country_code: String(item?.country_code || "").slice(0, 8),
      country_name: String(item?.country_name || "").slice(0, 80),
      locale: String(item?.locale || "").slice(0, 40),
      timezone: String(item?.timezone || "").slice(0, 80),
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
    };
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolveJobProxies(input, savedProxies) {
  if (input.proxies !== undefined) return parseProxyPool(input.proxies);
  const choice = String(input.proxySelection || "auto").trim().toLowerCase();
  if (choice === "direct") return [];
  if (choice === "auto") return savedProxies;
  const match = choice.match(/^proxy:(\d+)$/);
  if (!match) throw Object.assign(new Error("代理选择无效"), { status: 400 });
  const index = Number(match[1]);
  if (!Number.isInteger(index) || index < 0 || index >= savedProxies.length) {
    throw Object.assign(new Error("选择的代理已不存在，请刷新后重试"), { status: 409 });
  }
  return [savedProxies[index]];
}

function accountCredentials(item = {}) {
  if (Array.isArray(item.credentials)) return item.credentials;
  if (!item.credentials || typeof item.credentials !== "object") return [];
  return Object.entries(item.credentials).map(([key, raw]) => ({
    key,
    value: raw && typeof raw === "object" && Object.hasOwn(raw, "value") ? raw.value : raw,
  }));
}

function accountCredential(item, keys) {
  const wanted = new Set(keys);
  const match = accountCredentials(item)
    .find((credential) => wanted.has(String(credential?.key || "")) && credential?.value);
  return match ? String(match.value) : "";
}

function accessTokenFromAccount(item = {}) {
  return accountCredential(item, ["access_token", "accessToken"])
    || String(item.primary_token || "");
}

function safeRemoteText(value, maximum = 120) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, maximum);
}

function normalizeRemoteSignal(value, fallback = "") {
  const normalized = safeRemoteText(value, 80)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized || fallback;
}

function firstRemoteText(...values) {
  for (const value of values) {
    const text = safeRemoteText(value);
    if (text) return text;
  }
  return "";
}

function accountTypeFromPlan(planName, planState) {
  const compact = String(planName || "").replace(/[^a-z0-9]/g, "");
  if (compact === "free" || compact === "chatgptfreeplan") return "free";
  if (compact === "plus" || compact === "chatgptplusplan") return "plus";
  if (compact === "team" || compact === "chatgptteamplan") return "team";
  if (planName && !new Set(["unknown", "none", "invalid", "expired", "banned", "disabled", "inactive"]).has(planName)) {
    return planName;
  }
  if (new Set(["free", "trial", "eligible", "subscribed"]).has(planState)) return planState;
  return "unknown";
}

function accountStatusSignals(item = {}) {
  const overview = item.overview && typeof item.overview === "object" && !Array.isArray(item.overview)
    ? item.overview : {};
  const summaryStatus = item.display_summary?.status && typeof item.display_summary.status === "object"
    ? item.display_summary.status : {};
  const lifecycleStatus = normalizeRemoteSignal(
    firstRemoteText(item.lifecycle_status, overview.lifecycle_status, summaryStatus.lifecycle),
    "unknown",
  );
  const validityStatus = normalizeRemoteSignal(
    firstRemoteText(item.validity_status, overview.validity_status, summaryStatus.validity),
    "unknown",
  );
  const planState = normalizeRemoteSignal(
    firstRemoteText(item.plan_state, overview.plan_state, summaryStatus.plan_state),
    "unknown",
  );
  const rawPlanName = firstRemoteText(
    item.plan_name,
    overview.plan_name,
    overview.plan,
    overview.membership_type,
    overview.individual_membership_type,
    summaryStatus.plan_name,
  );
  const planName = normalizeRemoteSignal(rawPlanName);
  const displayStatus = normalizeRemoteSignal(
    firstRemoteText(item.display_status, overview.display_status, summaryStatus.display),
    lifecycleStatus,
  );
  const statusCheckedAt = safeRemoteText(
    firstRemoteText(overview.checked_at, summaryStatus.checked_at),
    80,
  );
  const statusCheckedAtMs = Date.parse(statusCheckedAt);
  const statusStale = !Number.isFinite(statusCheckedAtMs)
    || Date.now() - statusCheckedAtMs >= ACCOUNT_STATUS_REFRESH_COOLDOWN_MS;
  const source = safeRemoteText(firstRemoteText(overview.check_source, overview.status_source), 100);
  const unavailableStatuses = new Set(["invalid", "expired", "banned", "disabled", "deactivated", "deleted", "inactive"]);
  const unavailableSignal = [
    ["validity_status", validityStatus],
    ["lifecycle_status", lifecycleStatus],
    ["display_status", displayStatus],
    ["plan_state", planState],
  ].find(([, value]) => unavailableStatuses.has(value));

  let availability = "unchecked";
  let available = null;
  let availabilitySource = "not_checked";
  if (unavailableSignal || overview.disabled === true || overview.valid === false) {
    availability = "unavailable";
    available = false;
    availabilitySource = unavailableSignal
      ? `${unavailableSignal[0]}:${unavailableSignal[1]}`
      : (overview.disabled === true ? "overview.disabled" : "overview.valid");
  } else if (validityStatus === "valid" || overview.valid === true) {
    availability = "available";
    available = true;
    availabilitySource = validityStatus === "valid" ? "validity_status:valid" : "overview.valid";
  }

  const accountType = accountTypeFromPlan(planName, planState);
  const accountTypeSource = planName && accountType !== "unknown" ? "plan_name"
    : (accountType !== "unknown" ? "plan_state" : "not_detected");
  const accessTokenAvailable = Boolean(accessTokenFromAccount(item));
  const sessionTokenAvailable = Boolean(accountCredential(item, ["session_token", "sessionToken"]));
  const refreshTokenAvailable = Boolean(accountCredential(item, ["refresh_token", "refreshToken"]));
  const idTokenAvailable = Boolean(accountCredential(item, ["id_token", "idToken"]));
  return {
    account_type: accountType,
    account_type_source: accountTypeSource,
    availability,
    available,
    availability_source: availabilitySource,
    lifecycle_status: lifecycleStatus,
    validity_status: validityStatus,
    display_status: displayStatus,
    plan_state: planState,
    plan_name: planName,
    status_checked_at: statusCheckedAt,
    status_source: source,
    source,
    status_check_required: availability === "unchecked" || accountType === "unknown" || statusStale,
    access_token_available: accessTokenAvailable,
    session_token_available: sessionTokenAvailable,
    refresh_token_available: refreshTokenAvailable,
    id_token_available: idTokenAvailable,
    credentials_available: accessTokenAvailable || sessionTokenAvailable || refreshTokenAvailable || idTokenAvailable,
  };
}

function passwordMetadataFromAccount(item = {}) {
  const overview = item.overview && typeof item.overview === "object" ? item.overview : {};
  const allowed = new Set(["configured", "not_configured", "failed", "unknown"]);
  const status = allowed.has(overview.password_status) ? overview.password_status : "unknown";
  const source = String(overview.password_source || (status === "not_configured" ? "none" : ""));
  const password = status === "configured" ? String(item.password || "") : "";
  const error = status === "failed" ? String(overview.password_error || "").slice(0, 500) : "";
  return {
    password,
    password_status: status,
    password_source: source,
    password_error: error,
    password_available: Boolean(password),
  };
}

function normalizeOptionalPassword(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") {
    throw Object.assign(new Error("指定密码必须是字符串"), { status: 400 });
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw Object.assign(new Error("指定密码不能包含控制字符"), { status: 400 });
  }
  if (value !== value.trim()) {
    throw Object.assign(new Error("指定密码不能包含首尾空白"), { status: 400 });
  }
  const length = [...value].length;
  if (length < 12 || length > 128) {
    throw Object.assign(new Error("指定密码长度必须为 12 到 128 个字符"), { status: 400 });
  }
  return value;
}

function positiveAccountId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw Object.assign(new Error("注册账号 ID 无效"), { status: 400 });
  }
  return id;
}

function normalizedActionTaskId(value) {
  const id = String(value || "").trim();
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw Object.assign(new Error("设置密码任务 ID 无效"), { status: 400 });
  }
  return id;
}

function assertPasswordSetupTask(task, expectedTaskId = "") {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw Object.assign(new Error("设置密码服务返回了无效任务"), { status: 502 });
  }
  const taskId = String(task.task_id || task.id || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskId) || (expectedTaskId && taskId !== expectedTaskId)) {
    throw Object.assign(new Error("设置密码任务标识不匹配"), { status: 502 });
  }
  if (String(task.type || "").toLowerCase() !== "platform_action"
    || String(task.platform || "").toLowerCase() !== "chatgpt") {
    throw Object.assign(new Error("设置密码任务类型不匹配"), { status: 502 });
  }
  const status = String(task.status || "").toLowerCase();
  if (!new Set([
    "pending", "claimed", "queued", "running", "cancel_requested",
    "succeeded", "completed", "failed", "cancelled", "interrupted",
  ]).has(status)) {
    throw Object.assign(new Error("设置密码任务状态无效"), { status: 502 });
  }
  return taskId;
}

function publicPasswordSetupTask(task) {
  const taskId = String(task.task_id || task.id || "");
  const mappedStatus = statusFromExternal(task.status);
  const status = new Set(["queued", "running", "cancel_requested", "completed", "failed", "cancelled", "interrupted"])
    .has(mappedStatus) ? mappedStatus : "failed";
  const progressCurrent = Math.max(0, Number(task.progress_current ?? task.progress_detail?.current ?? 0) || 0);
  const progressTotal = Math.max(0, Number(task.progress_total ?? task.progress_detail?.total ?? 1) || 0);
  const terminal = TERMINAL_STATUSES.has(status);
  const result = {
    task_id: taskId,
    status,
    terminal,
    cancellable: !terminal && new Set(["queued", "running", "cancel_requested"]).has(status),
    progress_current: progressCurrent,
    progress_total: progressTotal,
  };
  if (status === "failed" || status === "interrupted") result.error = "设置密码任务失败";
  if (status === "cancelled") result.error = "设置密码任务已取消";
  return result;
}

function safePasswordSetupEventMessage(value) {
  const message = String(value || "").toLowerCase();
  if (/基线/.test(message) && /刷新/.test(message)) return "已刷新邮箱验证码基线";
  if (/等待/.test(message) && /验证码/.test(message)) return "等待设置密码邮箱验证码";
  if (/验证码/.test(message) && /(通过|验证|提交|成功)/.test(message)) return "设置密码邮箱验证码已验证";
  if (/(新密码|新增密码)/.test(message) && /提交/.test(message)) return "新密码已提交";
  if (/(成功页|password_status)/.test(message) && /(确认|configured)/.test(message)) return "设置密码成功页已确认";
  if (/(取消|cancel)/.test(message)) return "设置密码任务已取消";
  if (/(失败|错误|异常|failed|error)/.test(message)) return "设置密码任务失败";
  if (/(完成|成功|configured)/.test(message)) return "设置密码任务已完成";
  if (/(创建|开始|启动|running|claimed)/.test(message)) return "设置密码任务已启动";
  return "设置密码任务处理中";
}

function publicPasswordSetupEvents(response) {
  const events = Array.isArray(response) ? response : (response?.items || response?.events || []);
  return events.slice(-300).map((item) => {
    const type = String(item?.type || "log").toLowerCase();
    const level = String(item?.level || "info").toLowerCase();
    const createdAt = String(item?.created_at || "");
    return {
      id: Number(item?.id) || 0,
      type: new Set(["log", "state", "summary", "progress"]).has(type) ? type : "log",
      level: new Set(["info", "warning", "error", "success"]).has(level) ? level : "info",
      message: safePasswordSetupEventMessage(eventMessage(item)),
      created_at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(createdAt) ? createdAt.slice(0, 40) : "",
    };
  });
}

function accountMetadataValue(input, key, label, maximum) {
  if (!Object.hasOwn(input, key)) return undefined;
  if (typeof input[key] !== "string") {
    throw Object.assign(new Error(`${label}必须是字符串`), { status: 400 });
  }
  const value = input[key].trim();
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw Object.assign(new Error(`${label}不能包含控制字符`), { status: 400 });
  }
  if ([...value].length > maximum) {
    throw Object.assign(new Error(`${label}最多 ${maximum} 个字符`), { status: 400 });
  }
  return value;
}

function statusFromExternal(value) {
  const status = String(value || "").toLowerCase();
  if (status === "succeeded") return "completed";
  if (status === "pending" || status === "claimed") return "queued";
  if (status === "cancel_requested") return "cancel_requested";
  return status || "queued";
}

function eventMessage(item) {
  return String(item?.message || item?.detail?.message || "");
}

function identityFromEvents(events = []) {
  let exitIp = "";
  let displayName = "";
  let birthDate = "";
  let fingerprintId = "";
  for (const item of [...events].reverse()) {
    const text = eventMessage(item);
    if (!exitIp) exitIp = text.match(/(?:浏览器代理出口|代理出口|出口)\s*IP[:：]\s*([0-9a-f:.]+)/i)?.[1] || "";
    if (!fingerprintId) fingerprintId = text.match(/随机指纹会话[:：]\s*([a-f0-9]{12,64})/i)?.[1]?.slice(0, 12) || "";
    let match = text.match(/生成用户信息:\s*([^,，]+)[,，]\s*生日:\s*(\d{4}-\d{2}-\d{2})/i);
    if (!match) match = text.match(/about_you[^:：]*[:：].*?name=([^,，]+)[,，]\s*birthdate=(\d{4}-\d{2}-\d{2})/i);
    if (match && !displayName) {
      displayName = match[1].trim();
      birthDate = match[2];
    }
    if (displayName && exitIp && fingerprintId) break;
  }
  return { displayName, birthDate, exitIp, fingerprintId };
}

export class RegistrationService {
  constructor({ db, graph, client, publicBaseUrl, mailboxBaseUrl, browserUrl } = {}) {
    this.db = db;
    this.graph = graph;
    this.client = client;
    this.connectorKey = getSetting(db, "registration_connector_key", "");
    this.mailboxBaseUrl = String(mailboxBaseUrl || publicBaseUrl || "").replace(/\/$/, "");
    this.browserUrl = browserUrl || "/alias-hub/browser/vnc.html?autoconnect=true&resize=scale&path=websockify";
    this.scanPromises = new Map();
    this.accountStatusRefreshAttempts = new Map();
  }

  requireConnectorKey(req, res, next) {
    if (!timingSafeEqual(req.get("X-API-Key"), this.connectorKey)) return res.status(401).json({ success: false, error: "API Key 无效" });
    return next();
  }

  getProxyPool() {
    return parseProxyPool(getSetting(this.db, "registration_proxy_pool", "[]"));
  }

  saveProxyPool(input) {
    const proxies = parseProxyPool(input);
    setSetting(this.db, "registration_proxy_pool", JSON.stringify(proxies));
    return {
      count: proxies.length,
      proxies,
      masked: proxies.map(maskProxy),
      proxyMetadata: proxies.map(proxyMetadata),
    };
  }

  async inspectProxy(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw Object.assign(new Error("代理检测参数无效"), { status: 400 });
    }
    const [url] = parseProxyPool([input.url]);
    if (!url) throw Object.assign(new Error("请选择要检测的代理"), { status: 400 });
    const samples = Number(input.samples ?? 3);
    const delayMs = Number(input.delay_ms ?? 350);
    if (!Number.isSafeInteger(samples) || samples < 1 || samples > 5) {
      throw Object.assign(new Error("动态 IP 检测次数必须是 1 到 5"), { status: 400 });
    }
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 2_000) {
      throw Object.assign(new Error("动态 IP 检测间隔必须是 0 到 2000 毫秒"), { status: 400 });
    }
    try {
      const stickyTemplate = kookeeyStickyTemplate(url);
      let safeSamples;
      let upstreamDynamic;
      if (stickyTemplate) {
        safeSamples = [];
        const usedSessions = new Set();
        for (let index = 0; index < samples; index += 1) {
          const sampleUrl = materializeProxySession(url, usedSessions);
          const result = await this.client.inspectProxy({ url: sampleUrl, samples: 1, delay_ms: 0 });
          const [sample] = safeProxySamples(result, 1);
          if (!sample) throw new Error("代理检测服务未返回出口 IP");
          safeSamples.push(sample);
          if (index + 1 < samples && delayMs) await wait(delayMs);
        }
      } else {
        const result = await this.client.inspectProxy({ url, samples, delay_ms: delayMs });
        safeSamples = safeProxySamples(result, samples);
        upstreamDynamic = typeof result?.dynamic === "boolean"
          ? result.dynamic
          : (typeof result?.is_dynamic === "boolean" ? result.is_dynamic : undefined);
      }
      if (!safeSamples.length) throw new Error("代理检测服务未返回出口 IP");
      const distinctIps = [...new Set(safeSamples.map((item) => item.ip))];
      const rotationVerified = distinctIps.length > 1;
      const response = {
        dynamic: stickyTemplate ? true : (upstreamDynamic ?? rotationVerified),
        rotation_verified: rotationVerified,
        distinct_ips: distinctIps,
        samples: safeSamples,
      };
      if (stickyTemplate) {
        Object.assign(response, {
          dynamic_mode: "sticky_session",
          provider: "Kookeey",
          session_ttl: stickyTemplate.sessionTtl,
        });
      }
      return response;
    } catch (error) {
      const status = Number(error?.status);
      throw Object.assign(new Error("代理检测失败，请检查代理地址和可用性"), {
        status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502,
      });
    }
  }

  async options() {
    const baseJobs = this.db.prepare(`
      SELECT registration_jobs.email, registration_jobs.status, registration_jobs.stage, registration_jobs.message
      FROM registration_jobs
      JOIN addresses split_address ON split_address.id = registration_jobs.address_id
      WHERE split_address.parent_address_id = ?
      ORDER BY registration_jobs.created_at DESC, registration_jobs.id DESC
    `);
    const accounts = this.db.prepare("SELECT * FROM source_accounts WHERE status = 'connected' ORDER BY updated_at DESC").all().map((account) => ({
      id: account.id,
      email: account.email,
      display_name: account.display_name,
      bases: this.db.prepare("SELECT id, address, kind, label FROM addresses WHERE account_id = ? AND kind IN ('primary', 'official') AND status = 'active' ORDER BY kind = 'primary' DESC, created_at").all(account.id).map((base) => {
        const jobs = baseJobs.all(base.id);
        const latest = jobs[0];
        const conflicts = new Set();
        for (const job of jobs) {
          if (job.status === "completed") break;
          if (registrationFailureReason(job) === "user_already_exists") conflicts.add(String(job.email || "").toLowerCase());
        }
        const conflictCount = conflicts.size;
        const registrationState = conflictCount >= 2 ? "likely_exhausted" : (conflictCount === 1 ? "warning" : "available");
        return {
          ...base,
          registration_state: registrationState,
          already_exists_count: conflictCount,
          registration_success_count: jobs.filter((job) => job.status === "completed").length,
          last_registration_status: latest?.status || "",
          registration_hint: registrationState === "likely_exhausted"
            ? "这个基础地址已有多次邮箱占用冲突，疑似不再适合继续分裂注册，建议更换基础地址。"
            : (registrationState === "warning" ? "这个基础地址最近出现邮箱占用冲突，再次失败时请更换基础地址。" : ""),
        };
      }),
    }));
    const proxies = this.getProxyPool();
    return {
      accounts,
      proxies,
      maskedProxies: proxies.map(maskProxy),
      proxyMetadata: proxies.map(proxyMetadata),
      browserUrl: this.browserUrl,
      service: await this.client.health(),
    };
  }

  async createJobs(input = {}) {
    const count = Math.max(1, Math.min(20, Number(input.count) || 1));
    const requestedBrowserMode = new Set(["headed", "headless"]).has(input.browserMode) ? input.browserMode : "headed";
    const customSuffix = String(input.suffix || "").trim();
    const setPasswordAfterRegistration = input.setPasswordAfterRegistration ?? false;
    if (typeof setPasswordAfterRegistration !== "boolean") {
      throw Object.assign(new Error("注册后设置密码必须是布尔值"), { status: 400 });
    }
    const autoContinuePostSignup = input.autoContinuePostSignup ?? true;
    if (typeof autoContinuePostSignup !== "boolean") {
      throw Object.assign(new Error("注册后自动完成准备页面必须是布尔值"), { status: 400 });
    }
    const requestedPassword = input.password ?? "";
    if (typeof requestedPassword !== "string") {
      throw Object.assign(new Error("指定密码必须是字符串"), { status: 400 });
    }
    if (requestedPassword && !setPasswordAfterRegistration) {
      throw Object.assign(new Error("请先勾选注册后设置密码再填写指定密码"), { status: 400 });
    }
    if (/[\u0000-\u001f\u007f-\u009f]/.test(requestedPassword)) {
      throw Object.assign(new Error("指定密码不能包含控制字符"), { status: 400 });
    }
    if (requestedPassword && requestedPassword !== requestedPassword.trim()) {
      throw Object.assign(new Error("指定密码不能包含首尾空白"), { status: 400 });
    }
    const passwordLength = [...requestedPassword].length;
    if (requestedPassword && (passwordLength < 12 || passwordLength > 128)) {
      throw Object.assign(new Error("指定密码长度必须为 12 到 128 个字符"), { status: 400 });
    }
    const browserMode = autoContinuePostSignup ? requestedBrowserMode : "headed";
    const account = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(input.accountId));
    if (!account) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
    if (account.status !== "connected") throw Object.assign(new Error("请先完成这个源头邮箱的微软登录"), { status: 409 });
    const base = this.db.prepare("SELECT * FROM addresses WHERE id = ? AND account_id = ? AND kind IN ('primary', 'official') AND status = 'active'").get(Number(input.baseAddressId), account.id);
    if (!base) throw Object.assign(new Error("请选择可用的基础地址"), { status: 400 });
    const proxies = resolveJobProxies(input, this.getProxyPool());
    const addresses = generateSplits(this.db, account, {
      baseAddressIds: [base.id],
      countPerBase: count,
      prefix: "gpt",
      mode: "random",
      randomLength: 10,
      customSuffix,
      label: "GPT 注册",
      purpose: "ChatGPT 注册",
    });
    const jobs = [];
    const usedProxySessions = new Set();
    for (let index = 0; index < addresses.length; index += 1) {
      const address = addresses[index];
      const proxyTemplate = proxies.length ? proxies[index % proxies.length] : "";
      const proxy = materializeProxySession(proxyTemplate, usedProxySessions);
      const now = nowIso();
      const result = this.db.prepare(`
        INSERT INTO registration_jobs (
          account_id, address_id, email, status, stage, browser_mode, proxy_label, fingerprint_id,
          message, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', 'queued', ?, ?, ?, '正在提交注册任务', ?, ?)
      `).run(account.id, address.id, address.address, browserMode, maskProxy(proxy), crypto.randomUUID().slice(0, 12), now, now);
      const jobId = Number(result.lastInsertRowid);
      try {
        const task = await this.client.createTask({
          platform: "chatgpt",
          email: address.address,
          password: requestedPassword || null,
          count: 1,
          concurrency: 1,
          proxy: proxy || null,
          executor_type: browserMode,
          captcha_solver: "auto",
          extra: {
            identity_provider: "mailbox",
            mail_provider: "outlook_email_api",
            outlook_email_api_url: this.mailboxBaseUrl,
            outlook_email_api_key: this.connectorKey,
            outlook_email_fixed_email: address.address,
            outlook_email_folder: "all",
            outlook_email_top: "20",
            outlook_email_poll_interval: "3",
            fresh_browser_context: true,
            random_fingerprint: true,
            email_only_registration: true,
            disable_phone_verification: true,
            phone_verification_policy: "forbid",
            allow_chatgpt_registration_proxy: true,
            set_password_after_registration: setPasswordAfterRegistration,
            auto_continue_post_signup: autoContinuePostSignup,
          },
        });
        const taskId = String(task.task_id || task.id || "");
        this.db.prepare("UPDATE registration_jobs SET external_task_id = ?, message = ?, updated_at = ? WHERE id = ?")
          .run(taskId, "任务已提交，等待执行", nowIso(), jobId);
      } catch {
        this.db.prepare("UPDATE registration_jobs SET status = 'failed', stage = 'submit', message = ?, finished_at = ?, updated_at = ? WHERE id = ?")
          .run("注册任务提交失败", nowIso(), nowIso(), jobId);
      }
      jobs.push(publicRegistrationJob(this.getJob(jobId)));
    }
    return jobs;
  }

  getJob(id) {
    return this.db.prepare(`
      SELECT registration_jobs.*, source_accounts.email AS source_email
      FROM registration_jobs LEFT JOIN source_accounts ON source_accounts.id = registration_jobs.account_id
      WHERE registration_jobs.id = ? AND registration_jobs.deleted_at IS NULL
    `).get(Number(id));
  }

  async syncJob(row) {
    if (!row?.external_task_id || TERMINAL_STATUSES.has(row.status)) return row;
    try {
      const task = await this.client.getTask(row.external_task_id);
      let events = [];
      if (!row.display_name || ACTIVE_STATUSES.has(String(task.status || ""))) {
        const response = await this.client.getTaskEvents(row.external_task_id);
        const remoteEvents = Array.isArray(response) ? response : response.items || response.events || [];
        events = sanitizeRegistrationRemoteValue(remoteEvents);
      }
      const identity = identityFromEvents(events);
      const status = statusFromExternal(task.status);
      const lastMessage = events.length ? eventMessage(events[events.length - 1]) : "";
      let externalAccountId = row.external_account_id;
      if (status === "completed") {
        const accounts = await this.client.listAccounts({ email: row.email, pageSize: 10 });
        const match = (accounts.items || []).find((item) => String(item.email).toLowerCase() === row.email.toLowerCase());
        externalAccountId = String(match?.id || externalAccountId || "");
      }
      const finishedAt = TERMINAL_STATUSES.has(status) ? (row.finished_at || nowIso()) : null;
      this.db.prepare(`
        UPDATE registration_jobs SET external_account_id = ?, status = ?, stage = ?,
          display_name = ?, birth_date = ?, exit_ip = ?, fingerprint_id = ?, progress_current = ?, progress_total = ?,
          message = ?, finished_at = ?, updated_at = ? WHERE id = ?
      `).run(
        externalAccountId,
        status,
        redactProxySecrets(task.type || task.status || status),
        identity.displayName || row.display_name,
        identity.birthDate || row.birth_date,
        identity.exitIp || row.exit_ip,
        identity.fingerprintId || row.fingerprint_id,
        Number(task.progress_current ?? task.success ?? row.progress_current ?? 0),
        Math.max(1, Number(task.progress_total ?? row.progress_total ?? 1)),
        redactProxySecrets(task.error || lastMessage || row.message || ""),
        finishedAt,
        nowIso(),
        row.id,
      );
      if (status === "completed" && row.address_id) {
        this.db.prepare(`
          UPDATE verification_codes SET is_used = 1, is_hidden = 1
          WHERE address_id = ? AND received_at >= ?
        `).run(row.address_id, row.created_at);
      }
    } catch (error) {
      const message = redactProxySecrets(error?.message) || "同步注册任务状态失败";
      this.db.prepare("UPDATE registration_jobs SET message = ?, updated_at = ? WHERE id = ?").run(message, nowIso(), row.id);
    }
    return this.getJob(row.id);
  }

  async listJobs({ limit = 100 } = {}) {
    const rows = this.db.prepare(`
      SELECT registration_jobs.*, source_accounts.email AS source_email
      FROM registration_jobs LEFT JOIN source_accounts ON source_accounts.id = registration_jobs.account_id
      WHERE registration_jobs.deleted_at IS NULL
      ORDER BY registration_jobs.created_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(500, Number(limit) || 100)));
    const synced = await Promise.all(rows.map((row) => this.syncJob(row)));
    return synced.map(publicRegistrationJob);
  }

  async cancelJob(id) {
    const row = this.getJob(id);
    if (!row) throw Object.assign(new Error("注册任务不存在"), { status: 404 });
    if (TERMINAL_STATUSES.has(row.status)) return publicRegistrationJob(row);
    if (!row.external_task_id) {
      const finishedAt = nowIso();
      this.db.prepare("UPDATE registration_jobs SET status = 'cancelled', message = '任务已取消', finished_at = ?, updated_at = ? WHERE id = ?")
        .run(finishedAt, finishedAt, row.id);
      return publicRegistrationJob(this.getJob(row.id));
    }

    const cancelledTask = await this.client.cancelTask(row.external_task_id);
    const remoteStatus = statusFromExternal(cancelledTask?.status);
    if (TERMINAL_STATUSES.has(remoteStatus)) {
      const finishedAt = nowIso();
      const message = remoteStatus === "cancelled" ? "任务已取消" : redactProxySecrets(cancelledTask?.error || "任务已结束");
      this.db.prepare("UPDATE registration_jobs SET status = ?, message = ?, finished_at = ?, updated_at = ? WHERE id = ?")
        .run(remoteStatus, message, finishedAt, finishedAt, row.id);
    } else {
      const updatedAt = nowIso();
      this.db.prepare("UPDATE registration_jobs SET status = 'cancel_requested', message = '已请求取消；任务未退出时可强制释放', finished_at = NULL, updated_at = ? WHERE id = ?")
        .run(updatedAt, row.id);
    }
    return publicRegistrationJob(this.getJob(row.id));
  }

  async releaseJob(id) {
    const jobId = Number(id);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      throw Object.assign(new Error("注册任务 ID 无效"), { status: 400 });
    }
    const row = this.getJob(jobId);
    if (!row) throw Object.assign(new Error("注册任务不存在"), { status: 404 });
    if (!RELEASABLE_JOB_STATUSES.has(String(row.status || ""))) {
      const message = row.status === "completed" ? "注册成功的任务不能释放" : "任务已经结束，无需释放";
      throw Object.assign(new Error(message), { status: 409 });
    }

    let releaseResult = { release_mode: "local_only", status: "interrupted" };
    if (row.external_task_id) {
      releaseResult = await this.client.releaseTask(row.external_task_id);
    }
    const remoteStatus = statusFromExternal(releaseResult?.status);
    if (remoteStatus === "completed") {
      await this.syncJob(row);
      throw Object.assign(new Error("远端任务已经注册成功，不能释放"), { status: 409 });
    }

    const nextStatus = remoteStatus === "cancelled" ? "cancelled" : "interrupted";
    const releaseMode = String(releaseResult?.release_mode || (row.external_task_id ? "force_release" : "local_only"));
    const message = nextStatus === "cancelled" ? "远端任务已取消并释放" : "任务已强制释放并标记为中断";
    const finishedAt = nowIso();
    const result = this.db.prepare(`
      UPDATE registration_jobs SET status = ?, stage = 'released', message = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
        AND status IN ('queued', 'pending', 'claimed', 'running', 'cancel_requested')
    `).run(nextStatus, message, finishedAt, finishedAt, row.id);
    if (!result.changes) {
      const latest = this.getJob(row.id);
      const reason = latest?.status === "completed" ? "注册任务已成功，不能释放" : "注册任务状态已变化，请刷新后重试";
      throw Object.assign(new Error(reason), { status: 409 });
    }
    return {
      item: publicRegistrationJob(this.getJob(row.id)),
      release_mode: releaseMode,
      remote_status: String(releaseResult?.status || ""),
    };
  }

  deleteJob(id) {
    const jobId = Number(id);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      throw Object.assign(new Error("注册记录 ID 无效"), { status: 400 });
    }
    const row = this.getJob(jobId);
    if (!row) throw Object.assign(new Error("注册记录不存在"), { status: 404 });
    if (!TERMINAL_STATUSES.has(row.status)) {
      throw Object.assign(new Error("运行中的任务不能删除，请先取消任务"), { status: 409 });
    }
    const deletedAt = nowIso();
    const result = this.db.prepare(`
      UPDATE registration_jobs SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
    `).run(deletedAt, deletedAt, row.id);
    if (!result.changes) throw Object.assign(new Error("注册记录状态已变化，请刷新后重试"), { status: 409 });
    return { deleted: 1, id: row.id };
  }

  deleteJobs(input = {}) {
    const ids = normalizeSelectedIds(input, "注册记录");
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT id, status FROM registration_jobs
      WHERE id IN (${placeholders}) AND deleted_at IS NULL
    `).all(...ids);
    if (rows.length !== ids.length) {
      throw Object.assign(new Error("部分注册记录不存在，请刷新后重试"), { status: 404 });
    }
    if (rows.some((row) => !TERMINAL_STATUSES.has(row.status))) {
      throw Object.assign(new Error("选择中包含运行中的任务，请先取消任务"), { status: 409 });
    }
    const deletedAt = nowIso();
    const result = this.db.transaction(() => this.db.prepare(`
      UPDATE registration_jobs SET deleted_at = ?, updated_at = ?
      WHERE id IN (${placeholders}) AND deleted_at IS NULL
        AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
    `).run(deletedAt, deletedAt, ...ids))();
    if (result.changes !== ids.length) {
      throw Object.assign(new Error("注册记录状态已变化，请刷新后重试"), { status: 409 });
    }
    return { deleted: result.changes, ids };
  }

  async taskEvents(id) {
    const row = this.getJob(id);
    if (!row) throw Object.assign(new Error("注册任务不存在"), { status: 404 });
    if (!row.external_task_id) return [];
    try {
      const response = await this.client.getTaskEvents(row.external_task_id);
      const events = Array.isArray(response) ? response : response.items || response.events || [];
      return sanitizeRegistrationRemoteValue(events);
    } catch (error) {
      throw Object.assign(new Error(redactProxySecrets(error?.message) || "读取注册任务事件失败"), {
        status: Number.isInteger(Number(error?.status)) ? Number(error.status) : 502,
      });
    }
  }

  async passwordSetupTarget(id, { allowConfigured = false } = {}) {
    const accountId = positiveAccountId(id);
    const job = this.db.prepare(`
      SELECT registration_jobs.*, addresses.address AS mapped_address,
        addresses.account_id AS mapped_account_id, source_accounts.status AS source_status
      FROM registration_jobs
      LEFT JOIN addresses ON addresses.id = registration_jobs.address_id
      LEFT JOIN source_accounts ON source_accounts.id = registration_jobs.account_id
      WHERE registration_jobs.external_account_id = ?
      ORDER BY registration_jobs.created_at DESC, registration_jobs.id DESC
      LIMIT 1
    `).get(String(accountId));
    if (!job || String(job.status || "") !== "completed") {
      throw Object.assign(new Error("账号缺少已完成注册映射，拒绝补设密码"), { status: 409 });
    }
    if (!Number.isSafeInteger(Number(job.address_id)) || Number(job.address_id) <= 0 || !job.mapped_address) {
      throw Object.assign(new Error("注册记录缺少原邮箱地址映射，拒绝补设密码"), { status: 409 });
    }
    if (Number(job.account_id) <= 0 || Number(job.mapped_account_id) !== Number(job.account_id)) {
      throw Object.assign(new Error("注册记录的源邮箱映射不一致，拒绝补设密码"), { status: 409 });
    }
    if (String(job.source_status || "") !== "connected") {
      throw Object.assign(new Error("原源头邮箱当前未连接，拒绝补设密码"), { status: 409 });
    }

    const mappedEmail = String(job.mapped_address || "").trim().toLowerCase();
    if (!mappedEmail || mappedEmail !== String(job.email || "").trim().toLowerCase()) {
      throw Object.assign(new Error("注册记录与原邮箱地址不一致，拒绝补设密码"), { status: 409 });
    }
    const account = await this.client.getAccount(accountId);
    if (!account) throw Object.assign(new Error("账号已从本地账号池删除"), { status: 404 });
    if (Number(account.id) !== accountId
      || String(account.platform || "").toLowerCase() !== "chatgpt"
      || String(account.email || "").trim().toLowerCase() !== mappedEmail) {
      throw Object.assign(new Error("远端账号与原邮箱地址映射不一致，拒绝补设密码"), { status: 409 });
    }
    const password = passwordMetadataFromAccount(account);
    if (!allowConfigured && password.password_status === "configured") {
      throw Object.assign(new Error("这个账号已经配置密码"), { status: 409 });
    }
    return { accountId, job, account, password };
  }

  passwordSetupProxy(job) {
    const proxyLabel = String(job?.proxy_label || "").trim();
    if (proxyLabel === "直连") return "";
    if (!proxyLabel) {
      throw Object.assign(new Error("注册记录缺少原代理信息，拒绝补设密码"), { status: 409 });
    }
    const matches = this.getProxyPool().filter((proxy) => maskProxy(proxy) === proxyLabel);
    if (matches.length !== 1) {
      throw Object.assign(new Error("无法唯一还原注册时使用的代理，拒绝补设密码"), { status: 409 });
    }
    return matches[0];
  }

  passwordSetupTaskMapping(id, taskId) {
    const accountId = positiveAccountId(id);
    const normalizedTaskId = normalizedActionTaskId(taskId);
    const mapping = this.db.prepare(`
      SELECT task_id, external_account_id, status
      FROM registration_password_setup_tasks
      WHERE task_id = ? AND external_account_id = ?
    `).get(normalizedTaskId, accountId);
    if (!mapping) {
      throw Object.assign(new Error("设置密码任务映射不存在或已失效"), { status: 409 });
    }
    return { accountId, taskId: normalizedTaskId };
  }

  activePasswordSetupTask(accountId) {
    return this.db.prepare(`
      SELECT task_id, external_account_id, status
      FROM registration_password_setup_tasks
      WHERE external_account_id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(accountId);
  }

  updatePasswordSetupTaskStatus(taskId, status) {
    const updatedAt = nowIso();
    this.db.prepare(`
      UPDATE registration_password_setup_tasks
      SET status = ?, updated_at = ?
      WHERE task_id = ?
    `).run(status, updatedAt, taskId);
  }

  passwordSetupAvailability(job, account, password) {
    if (password.password_status === "configured") {
      return { available: false, reason: "密码已配置" };
    }
    const accountId = Number(account?.id);
    if (!Number.isSafeInteger(accountId) || accountId <= 0
      || !job || String(job.status || "") !== "completed"
      || String(job.external_account_id || "") !== String(accountId)) {
      return { available: false, reason: "缺少已完成注册映射" };
    }
    if (this.activePasswordSetupTask(accountId)) {
      return { available: false, reason: "设置密码任务正在进行" };
    }
    const addressId = Number(job.address_id);
    if (!Number.isSafeInteger(addressId) || addressId <= 0) {
      return { available: false, reason: "缺少原邮箱地址映射" };
    }
    const address = this.db.prepare(`
      SELECT addresses.address, addresses.account_id, source_accounts.status AS source_status
      FROM addresses
      LEFT JOIN source_accounts ON source_accounts.id = addresses.account_id
      WHERE addresses.id = ?
    `).get(addressId);
    if (!address || Number(address.account_id) !== Number(job.account_id)) {
      return { available: false, reason: "原邮箱地址映射不一致" };
    }
    const mappedEmail = String(address.address || "").trim().toLowerCase();
    if (!mappedEmail
      || mappedEmail !== String(job.email || "").trim().toLowerCase()
      || mappedEmail !== String(account.email || "").trim().toLowerCase()) {
      return { available: false, reason: "原邮箱地址映射不一致" };
    }
    if (String(address.source_status || "") !== "connected") {
      return { available: false, reason: "原源头邮箱未连接" };
    }
    try {
      this.passwordSetupProxy(job);
    } catch {
      return { available: false, reason: "原代理无法唯一恢复" };
    }
    return { available: true, reason: "" };
  }

  async startPasswordSetup(id, input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw Object.assign(new Error("设置密码参数无效"), { status: 400 });
    }
    const accountId = positiveAccountId(id);
    if (this.activePasswordSetupTask(accountId)) {
      throw Object.assign(new Error("这个账号已有设置密码任务正在进行"), { status: 409 });
    }
    const target = await this.passwordSetupTarget(accountId);
    const password = normalizeOptionalPassword(input.password);
    const proxy = this.passwordSetupProxy(target.job);
    const params = {};
    if (password) params.password = password;
    if (proxy) params.proxy = proxy;

    try {
      await this.client.upsertOutlookEmailProviderSetting({
        apiUrl: this.mailboxBaseUrl,
        apiKey: this.connectorKey,
      });
    } catch {
      throw Object.assign(new Error("邮箱连接配置同步失败"), { status: 502 });
    }

    let task;
    try {
      task = await this.client.createAccountAction(target.accountId, "set_password", params);
    } catch {
      throw Object.assign(new Error("设置密码任务创建失败"), { status: 502 });
    }
    const taskId = assertPasswordSetupTask(task);
    const publicTask = publicPasswordSetupTask(task);
    const createdAt = nowIso();
    try {
      this.db.prepare(`
        INSERT INTO registration_password_setup_tasks (
          task_id, external_account_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(taskId, target.accountId, publicTask.status, createdAt, createdAt);
    } catch {
      throw Object.assign(new Error("设置密码任务映射保存失败"), { status: 502 });
    }
    const result = { account_id: target.accountId, ...publicTask };
    if (result.status === "completed") {
      const confirmed = await this.passwordSetupTarget(target.accountId, { allowConfigured: true });
      if (confirmed.password.password_status !== "configured" || !confirmed.password.password_available) {
        throw Object.assign(new Error("设置密码任务伪成功：账号密码状态未确认"), { status: 502 });
      }
      result.password_status = "configured";
      result.password_available = true;
    }
    return result;
  }

  async passwordSetupStatus(id, taskId) {
    const mapping = this.passwordSetupTaskMapping(id, taskId);
    await this.passwordSetupTarget(mapping.accountId, { allowConfigured: true });
    let task;
    let eventResponse;
    try {
      task = await this.client.getActionTask(mapping.taskId);
      eventResponse = await this.client.getActionTaskEvents(mapping.taskId);
    } catch {
      throw Object.assign(new Error("设置密码任务状态读取失败"), { status: 502 });
    }
    assertPasswordSetupTask(task, mapping.taskId);
    const result = {
      account_id: mapping.accountId,
      ...publicPasswordSetupTask(task),
      events: publicPasswordSetupEvents(eventResponse),
    };
    this.updatePasswordSetupTaskStatus(mapping.taskId, result.status);

    if (result.status === "completed") {
      const confirmed = await this.passwordSetupTarget(mapping.accountId, { allowConfigured: true });
      if (confirmed.password.password_status !== "configured" || !confirmed.password.password_available) {
        throw Object.assign(new Error("设置密码任务伪成功：账号密码状态未确认"), { status: 502 });
      }
      result.password_status = "configured";
      result.password_available = true;
    }
    return result;
  }

  async cancelPasswordSetup(id, taskId) {
    const mapping = this.passwordSetupTaskMapping(id, taskId);
    await this.passwordSetupTarget(mapping.accountId, { allowConfigured: true });
    let task;
    try {
      task = await this.client.cancelActionTask(mapping.taskId);
    } catch {
      throw Object.assign(new Error("设置密码任务取消失败"), { status: 502 });
    }
    assertPasswordSetupTask(task, mapping.taskId);
    const result = { account_id: mapping.accountId, ...publicPasswordSetupTask(task) };
    this.updatePasswordSetupTaskStatus(mapping.taskId, result.status);
    return result;
  }

  async refreshUncheckedAccountSignals(matched = []) {
    if (typeof this.client.refreshAccountPlans !== "function") return false;
    const now = Date.now();
    for (const [key, attemptedAt] of this.accountStatusRefreshAttempts) {
      if (now - attemptedAt >= ACCOUNT_STATUS_REFRESH_COOLDOWN_MS) {
        this.accountStatusRefreshAttempts.delete(key);
      }
    }
    const candidates = [];
    for (const { item } of matched) {
      const signals = accountStatusSignals(item);
      const id = Number(item?.id);
      const email = safeRemoteText(item?.email, 320).toLowerCase();
      const key = Number.isSafeInteger(id) && id > 0 && email ? `${id}\n${email}` : "";
      if (!key || !signals.status_check_required || !signals.access_token_available
        || this.accountStatusRefreshAttempts.has(key)) {
        continue;
      }
      candidates.push({ id, key });
      if (candidates.length >= ACCOUNT_STATUS_REFRESH_BATCH_SIZE) break;
    }
    if (!candidates.length) return false;
    candidates.forEach(({ key }) => this.accountStatusRefreshAttempts.set(key, now));
    try {
      await this.client.refreshAccountPlans(candidates.map(({ id }) => id));
      return true;
    } catch {
      return false;
    }
  }

  async listRegisteredAccounts() {
    let response = await this.client.listAccounts({ pageSize: 500 });
    const jobs = this.db.prepare(`
      SELECT * FROM registration_jobs
      WHERE external_account_id <> '' AND status = 'completed'
      ORDER BY created_at DESC
    `).all();
    const metadataByAccountId = new Map(this.db.prepare("SELECT * FROM registered_account_metadata").all()
      .map((item) => [String(item.external_account_id), item]));
    const nfapiByAccountId = new Map();
    const nfapiBaseUrl = String(getSetting(this.db, "nfapi_base_url", "")).replace(/\/+$/, "");
    this.db.prepare(`
      SELECT * FROM registered_account_nfapi_links
      WHERE nfapi_base_url = ?
      ORDER BY updated_at DESC
    `).all(nfapiBaseUrl).forEach((item) => {
      const id = String(item.external_account_id);
      if (!nfapiByAccountId.has(id)) nfapiByAccountId.set(id, item);
    });
    const identityKey = (accountId, email) => {
      const id = safeRemoteText(accountId, 80);
      const normalizedEmail = safeRemoteText(email, 320).toLowerCase();
      return id && normalizedEmail ? `${id}\n${normalizedEmail}` : "";
    };
    const byIdentity = new Map();
    jobs.forEach((job) => {
      const key = identityKey(job.external_account_id, job.email);
      if (key && !byIdentity.has(key)) byIdentity.set(key, job);
    });
    const matchRemoteItems = (items) => (items || []).map((item) => {
      const platform = normalizeRemoteSignal(item?.platform, "chatgpt");
      const job = platform === "chatgpt"
        ? byIdentity.get(identityKey(item?.id, item?.email))
        : null;
      return { item, job };
    }).filter(({ job }) => Boolean(job));
    let matched = matchRemoteItems(response.items);
    if (await this.refreshUncheckedAccountSignals(matched)) {
      try {
        response = await this.client.listAccounts({ pageSize: 500 });
        matched = matchRemoteItems(response.items);
      } catch {
        // The first list is still authoritative enough to render unchecked state.
      }
    }
    return {
      total: matched.length,
      items: matched.map(({ item, job }) => {
        const passwordMetadata = passwordMetadataFromAccount(item);
        const passwordSetup = this.passwordSetupAvailability(job, item, passwordMetadata);
        const accountSignals = accountStatusSignals(item);
        const metadata = metadataByAccountId.get(String(item.id || ""));
        const nfapiLink = nfapiByAccountId.get(String(item.id || ""));
        const metadataMatches = metadata
          && String(metadata.email || "").toLowerCase() === String(item.email || "").toLowerCase();
        const nfapiMatches = nfapiLink
          && String(nfapiLink.email || "").toLowerCase() === String(item.email || "").toLowerCase();
        return {
          id: item.id,
          email: item.email,
          ...passwordMetadata,
          password_setup_available: passwordSetup.available,
          password_setup_reason: passwordSetup.reason,
          user_id: item.user_id,
          ...accountSignals,
          status: accountSignals.display_status !== "unknown"
            ? accountSignals.display_status : accountSignals.lifecycle_status,
          plan: accountSignals.account_type !== "unknown"
            ? accountSignals.account_type : accountSignals.plan_state,
          display_name: job?.display_name || "",
          birth_date: job?.birth_date || "",
          exit_ip: job?.exit_ip || "",
          custom_name: metadataMatches ? metadata.custom_name : "",
          group_name: metadataMatches ? metadata.group_name : "",
          nfapi: nfapiMatches ? {
            linked: nfapiLink.status === "imported",
            base_url: nfapiLink.nfapi_base_url,
            account_id: Number(nfapiLink.nfapi_account_id) || 0,
            status: nfapiLink.status,
            short_lived: Boolean(nfapiLink.short_lived),
            last_action: nfapiLink.last_action,
            last_error: nfapiLink.last_error,
            updated_at: nfapiLink.updated_at,
          } : { linked: false, status: "not_imported" },
          created_at: item.created_at,
        };
      }),
    };
  }

  async updateRegisteredAccountMetadata(id, input = {}) {
    const accountId = Number(id);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      throw Object.assign(new Error("注册账号 ID 无效"), { status: 400 });
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw Object.assign(new Error("账号资料格式无效"), { status: 400 });
    }
    const customName = accountMetadataValue(input, "custom_name", "账号名称", 60);
    const groupName = accountMetadataValue(input, "group_name", "分组名称", 40);
    if (customName === undefined && groupName === undefined) {
      throw Object.assign(new Error("请填写要修改的账号名称或分组"), { status: 400 });
    }

    const job = this.db.prepare(`
      SELECT * FROM registration_jobs
      WHERE external_account_id = ? AND status = 'completed'
      ORDER BY created_at DESC LIMIT 1
    `).get(String(accountId));
    if (!job) throw Object.assign(new Error("注册账号不存在"), { status: 404 });
    const account = await this.client.getAccount(accountId);
    if (!account) throw Object.assign(new Error("账号已从本地账号池删除"), { status: 404 });
    if (String(account.platform || "chatgpt").toLowerCase() !== "chatgpt"
      || String(account.email || "").toLowerCase() !== String(job.email || "").toLowerCase()) {
      throw Object.assign(new Error("注册账号与任务记录不匹配"), { status: 409 });
    }

    const existing = this.db.prepare(`
      SELECT * FROM registered_account_metadata
      WHERE external_account_id = ? AND email = ? COLLATE NOCASE
    `).get(String(accountId), account.email);
    const nextCustomName = customName === undefined ? String(existing?.custom_name || "") : customName;
    const nextGroupName = groupName === undefined ? String(existing?.group_name || "") : groupName;
    if (!nextCustomName && !nextGroupName) {
      this.db.prepare("DELETE FROM registered_account_metadata WHERE external_account_id = ?")
        .run(String(accountId));
    } else {
      const now = nowIso();
      this.db.prepare(`
        INSERT INTO registered_account_metadata
          (external_account_id, email, custom_name, group_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(external_account_id) DO UPDATE SET
          email = excluded.email,
          custom_name = excluded.custom_name,
          group_name = excluded.group_name,
          updated_at = excluded.updated_at
      `).run(String(accountId), account.email, nextCustomName, nextGroupName, now, now);
    }
    return {
      item: {
        id: accountId,
        email: account.email,
        custom_name: nextCustomName,
        group_name: nextGroupName,
      },
    };
  }

  async registeredAccountAccessToken(id) {
    const accountId = Number(id);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      throw Object.assign(new Error("注册账号 ID 无效"), { status: 400 });
    }
    const job = this.db.prepare(`
      SELECT * FROM registration_jobs
      WHERE external_account_id = ? AND status = 'completed'
      ORDER BY created_at DESC LIMIT 1
    `).get(String(accountId));
    if (!job) throw Object.assign(new Error("注册账号不存在"), { status: 404 });
    const account = await this.client.getAccount(accountId);
    if (!account) throw Object.assign(new Error("账号已从本地账号池删除"), { status: 404 });
    if (String(account.email || "").toLowerCase() !== String(job.email || "").toLowerCase()) {
      throw Object.assign(new Error("注册账号与任务记录不匹配"), { status: 409 });
    }
    const accessToken = accessTokenFromAccount(account);
    if (!accessToken) throw Object.assign(new Error("这个账号尚未获取到 AT"), { status: 404 });
    return { id: accountId, email: account.email, access_token: accessToken };
  }

  async deleteRegisteredAccounts(input = {}) {
    const ids = normalizeSelectedIds(input, "注册账号");
    const placeholders = ids.map(() => "?").join(",");
    const jobs = this.db.prepare(`
      SELECT * FROM registration_jobs
      WHERE external_account_id IN (${placeholders}) AND status = 'completed'
      ORDER BY created_at DESC
    `).all(...ids.map(String));
    const jobByAccountId = new Map();
    jobs.forEach((job) => {
      if (!jobByAccountId.has(String(job.external_account_id))) jobByAccountId.set(String(job.external_account_id), job);
    });
    if (ids.some((id) => !jobByAccountId.has(String(id)))) {
      throw Object.assign(new Error("选择中包含不属于本注册页面的账号"), { status: 409 });
    }

    const accounts = await Promise.all(ids.map(async (id) => {
      const account = await this.client.getAccount(id);
      if (!account) throw Object.assign(new Error(`账号 #${id} 已不存在`), { status: 404 });
      const job = jobByAccountId.get(String(id));
      if (String(account.platform || "chatgpt").toLowerCase() !== "chatgpt"
        || String(account.email || "").toLowerCase() !== String(job.email || "").toLowerCase()) {
        throw Object.assign(new Error(`账号 #${id} 与注册记录不匹配`), { status: 409 });
      }
      return { id, email: account.email };
    }));

    const settled = await Promise.allSettled(accounts.map((account) => this.client.deleteAccount(account.id)));
    const failed = [];
    const deletedIds = [];
    let deleted = 0;
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        deleted += 1;
        deletedIds.push(String(accounts[index].id));
      }
      else failed.push({ id: accounts[index].id, error: result.reason?.message || String(result.reason || "删除失败") });
    });
    if (deletedIds.length) {
      const placeholders = deletedIds.map(() => "?").join(",");
      this.db.transaction(() => {
        this.db.prepare(`DELETE FROM registered_account_metadata WHERE external_account_id IN (${placeholders})`).run(...deletedIds);
        this.db.prepare(`DELETE FROM registered_account_nfapi_links WHERE external_account_id IN (${placeholders})`).run(...deletedIds);
      })();
    }
    return { requested: ids.length, deleted, failed };
  }

  externalAccounts({ limit = 100, offset = 0 } = {}) {
    const boundedLimit = Math.max(1, Math.min(10_000, Number(limit) || 100));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const accounts = this.db.prepare(`
      SELECT addresses.id, addresses.address AS email, addresses.kind AS account_type,
        addresses.status, source_accounts.email AS source_email
      FROM addresses JOIN source_accounts ON source_accounts.id = addresses.account_id
      WHERE addresses.status = 'active' AND source_accounts.status = 'connected'
      ORDER BY addresses.created_at DESC LIMIT ? OFFSET ?
    `).all(boundedLimit, boundedOffset);
    return { success: true, accounts };
  }

  async scanAccount(account) {
    const existing = this.scanPromises.get(account.id);
    if (existing) return existing;
    const lastScan = account.last_inbox_scan_at ? new Date(account.last_inbox_scan_at).getTime() : 0;
    if (Date.now() - lastScan < 2_500) return null;
    const promise = this.graph.scanInbox(account).then((result) => {
      if (result?.stage !== "completed") {
        throw Object.assign(new Error(result?.message || "邮箱扫描尚未完成"), { status: 409 });
      }
      return persistInboxScanResult(this.db, account, result);
    }).finally(() => this.scanPromises.delete(account.id));
    this.scanPromises.set(account.id, promise);
    return promise;
  }

  async registeredAccountEmails(id, query = {}) {
    const accountId = positiveAccountId(id);
    const account = await this.client.getAccount(accountId);
    if (!account) throw Object.assign(new Error("注册账号不存在"), { status: 404 });
    if (String(account.platform || "chatgpt").toLowerCase() !== "chatgpt") {
      throw Object.assign(new Error("账号类型不是 ChatGPT"), { status: 409 });
    }
    const email = String(account.email || "").trim().toLowerCase();
    const job = this.db.prepare(`
      SELECT * FROM registration_jobs
      WHERE external_account_id = ? AND status = 'completed' AND email = ? COLLATE NOCASE
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(String(accountId), email);
    if (!email || !job) {
      throw Object.assign(new Error("注册账号与原邮箱记录不匹配"), { status: 409 });
    }
    const result = await this.externalEmails({ email, top: query.top });
    return { ...result, account_id: accountId, email };
  }

  async externalEmails(query = {}) {
    const email = String(query.email || "").trim().toLowerCase();
    if (!email) throw Object.assign(new Error("缺少 email"), { status: 400 });
    const top = query.top === undefined || query.top === "" ? 20 : Number(query.top);
    if (!Number.isSafeInteger(top) || top < 1 || top > 50) {
      throw Object.assign(new Error("top 必须是 1 到 50 的整数"), { status: 400 });
    }
    const address = this.db.prepare(`
      SELECT addresses.*, source_accounts.status AS account_status, source_accounts.email AS source_email,
        source_accounts.last_inbox_scan_at
      FROM addresses JOIN source_accounts ON source_accounts.id = addresses.account_id
      WHERE addresses.address = ? COLLATE NOCASE
    `).get(email);
    if (!address) throw Object.assign(new Error("邮箱地址不存在"), { status: 404 });
    if (address.account_status === "connected") {
      const account = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(address.account_id);
      await this.scanAccount(account);
    }
    const conditions = ["(mail_messages.address_id = ? OR mail_messages.recipient_address = ? COLLATE NOCASE)"];
    const params = [address.id, email];
    if (query.subject_contains) { conditions.push("mail_messages.subject LIKE ?"); params.push(`%${query.subject_contains}%`); }
    if (query.from_contains) { conditions.push("mail_messages.sender_address LIKE ?"); params.push(`%${query.from_contains}%`); }
    if (query.keyword) {
      conditions.push("(mail_messages.subject LIKE ? OR mail_messages.preview LIKE ? OR mail_messages.body LIKE ?)");
      params.push(`%${query.keyword}%`, `%${query.keyword}%`, `%${query.keyword}%`);
    }
    const emails = this.db.prepare(`
      SELECT id, graph_message_id AS message_id, internet_message_id, received_at AS date,
        sender_address AS "from", subject, preview AS body_preview, preview, body,
        verification_code
      FROM mail_messages WHERE ${conditions.join(" AND ")}
      ORDER BY received_at DESC LIMIT ?
    `).all(...params, top).map((item) => ({ ...item, folder: "inbox", text: item.body || item.preview }));
    return { success: true, emails };
  }
}
