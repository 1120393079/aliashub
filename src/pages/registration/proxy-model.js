export function normalizeProxyDraft(text) {
  const proxies = [];
  const errors = [];
  const duplicateLines = [];
  const sourceLines = [];
  const seen = new Map();

  String(text || "").split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const source = raw.trim();
    if (!source || source.startsWith("#")) return;
    const reject = (reason) => errors.push({ line, reason });
    if (/[\u0000-\u001f\u007f-\u009f]/.test(source) || /\s|\\/.test(source)) {
      reject("地址中不能包含空格、换行或反斜杠");
      return;
    }

    let proxy = source;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(proxy)) {
      const providerParts = proxy.match(/^([^:/?#@]+):(\d{1,5}):([^:]+):(.+)$/);
      if (providerParts) {
        const [, host, rawPort] = providerParts;
        const port = Number(rawPort);
        let parsedHost;
        try { parsedHost = new URL(`http://${host}:${rawPort}`); } catch {
          reject("四段式代理的主机名无效");
          return;
        }
        if (!parsedHost.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
          reject("四段式代理必须使用 host:port:user:password，端口范围为 1-65535");
          return;
        }
        if (seen.has(proxy)) {
          duplicateLines.push({ line, originalLine: seen.get(proxy) });
          return;
        }
        seen.set(proxy, line);
        proxies.push(proxy);
        sourceLines.push(line);
        return;
      } else {
        proxy = `http://${proxy}`;
      }
    }

    let parsed;
    try { parsed = new URL(proxy); } catch {
      reject("无法解析；请使用 URL 或 host:port:user:password 格式");
      return;
    }
    if (!new Set(["http:", "https:", "socks5:"]).has(parsed.protocol)) {
      reject("仅支持 http、https 和无认证 socks5");
      return;
    }
    const authority = proxy.slice(proxy.indexOf("://") + 3);
    if (!parsed.hostname || authority.search(/[/?#]/) >= 0) {
      reject("代理地址不能包含路径、查询参数或片段");
      return;
    }
    const atCount = [...authority].filter((char) => char === "@").length;
    if (atCount > 1) {
      reject("认证信息包含未转义的 @");
      return;
    }
    const userInfo = atCount === 1 ? authority.slice(0, authority.indexOf("@")) : "";
    const hostPort = atCount === 1 ? authority.slice(authority.indexOf("@") + 1) : authority;
    const portMatch = hostPort.startsWith("[")
      ? hostPort.match(/^\[[^\]]+\]:(\d+)$/)
      : hostPort.match(/^[^:]+:(\d+)$/);
    const port = Number(portMatch?.[1]);
    if (!portMatch || !Number.isInteger(port) || port < 1 || port > 65535) {
      reject("必须包含 1-65535 范围内的端口");
      return;
    }
    const parsedHostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
    const domain = parsedHostname.endsWith(".") ? parsedHostname.slice(0, -1) : parsedHostname;
    if (!domain || parsedHostname.includes("%") || domain.split(".").some((label) => !label)) {
      reject("主机名或 IP 地址无效");
      return;
    }
    if (atCount === 1) {
      if (parsed.protocol === "socks5:") {
        reject("socks5 暂不支持用户名密码认证");
        return;
      }
      const separator = userInfo.indexOf(":");
      if (separator <= 0 || separator === userInfo.length - 1) {
        reject("用户名和密码必须同时填写");
        return;
      }
      try {
        const credentials = `${decodeURIComponent(userInfo.slice(0, separator))}${decodeURIComponent(userInfo.slice(separator + 1))}`;
        if (/[\u0000-\u001f\u007f-\u009f]/.test(credentials)) throw new Error("invalid credentials");
      } catch {
        reject("用户名或密码包含无效转义字符");
        return;
      }
    }

    const normalized = `${parsed.protocol}//${authority}`;
    if (seen.has(normalized)) {
      duplicateLines.push({ line, originalLine: seen.get(normalized) });
      return;
    }
    seen.set(normalized, line);
    proxies.push(normalized);
    sourceLines.push(line);
  });

  return { proxies, errors, duplicateLines, sourceLines };
}

export function normalizeProxySample(item = {}) {
  return {
    ip: String(item.ip || item.exit_ip || item.query || "").trim(),
    country_name: String(item.country_name || item.country || item.region_name || "").trim(),
    country_code: String(item.country_code || item.countryCode || item.country_code2 || "").trim().toUpperCase(),
    locale: String(item.locale || "").trim(),
    timezone: String(item.timezone || item.time_zone || "").trim(),
  };
}

export function proxyMetadataLabel(metadata = {}) {
  const details = metadata || {};
  const countryCode = String(details.country_code || "").trim().toUpperCase();
  const mode = String(details.dynamic_mode || "").toLowerCase();
  const route = mode === "sticky_session"
    ? `动态 · ${details.session_ttl || "会话"} 粘性`
    : mode ? "动态出口" : "";
  return [countryCode, route].filter(Boolean).join(" · ");
}

export function proxySelectLabel(masked, metadata) {
  const detail = proxyMetadataLabel(metadata);
  return detail ? `${masked}（${detail}）` : masked;
}
