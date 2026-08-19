import crypto from "node:crypto";
import { isIP } from "node:net";

const KOOKEEY_GATEWAY_HOST = /^gate-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.kookeey\.info$/i;
const KOOKEEY_STICKY_PASSWORD = /^(.+)-([a-z]{2})-(\d{4,32})-([1-9]\d{0,3})m$/i;
const KOOKEEY_MAX_SESSION_TTL_MINUTES = 1_440;

export function parseProxyPool(value) {
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

export function maskProxy(value) {
  if (!value) return "直连";
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.username ? "***@" : ""}${parsed.hostname}:${parsed.port}`;
  } catch { return "已配置代理"; }
}

export function redactProxySecrets(value) {
  return String(value ?? "")
    .replace(/\b([a-z][a-z0-9+.-]*:(?:\\?\/){2})([^\s/?#@]+)@/gi, "$1***@")
    .replace(/((?:\[[0-9a-f:.]+\]|localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+|\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}):[^\s:]+:[^\s,;，]+/gi, "$1:***:***")
    .replace(/(?<![a-z0-9])(?:[a-z0-9._~!$&'()*+,;=%-]+)-[a-z]{2}-\d{4,32}-[1-9]\d{0,3}m(?![a-z0-9])/gi, "[REDACTED]")
    .replace(/((?:proxy(?:[\s_.-]*(?:url|uri|address|server|username|user|password|pass|auth(?:orization)?|credentials?|session(?:[\s_.-]*id)?))?|代理(?:地址|服务器|用户名|用户|密码|认证|凭据|会话(?:编号)?)?)\s*[:=：]\s*)(?:(?:basic|bearer)\s+[^\s,;]+|"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;，]+)/gi, "$1[REDACTED]");
}

export function sanitizeRegistrationRemoteValue(value, proxyContext = false) {
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

export function kookeeyStickyTemplate(value) {
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

export function proxyMetadata(value) {
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

export function materializeProxySession(value, usedSessions = new Set()) {
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

export function statusCheckProxyRoute(proxyLabel, proxyPool, usedSessions = new Set()) {
  const label = String(proxyLabel || "").trim();
  if (!label || label === "直连") return { primary: "", fallback: "" };
  const matches = proxyPool.filter((proxy) => maskProxy(proxy) === label);
  if (matches.length !== 1) return { primary: "", fallback: "" };
  const primary = matches[0];
  const materialized = materializeProxySession(primary, usedSessions);
  return {
    primary,
    fallback: materialized && materialized !== primary ? materialized : "",
  };
}

export function safeProxySamples(result, maximum) {
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

export function resolveJobProxies(input, savedProxies) {
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

export function resolveJobProxyPlan(input, savedProxies, cursor, count) {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError("注册代理分配数量无效");
  }
  const proxies = resolveJobProxies(input, savedProxies);
  const choice = String(input.proxySelection || "auto").trim().toLowerCase();
  const rotatesSavedPool = input.proxies === undefined && choice === "auto";
  const numericCursor = Number(cursor);
  const startIndex = rotatesSavedPool && proxies.length
    && Number.isSafeInteger(numericCursor) && numericCursor >= 0
    ? numericCursor % proxies.length
    : 0;
  const templates = Array.from({ length: count }, (_item, index) => (
    proxies.length ? proxies[(startIndex + index) % proxies.length] : ""
  ));
  return {
    templates,
    nextCursor: rotatesSavedPool && proxies.length
      ? (startIndex + count) % proxies.length
      : rotatesSavedPool ? 0 : null,
  };
}
