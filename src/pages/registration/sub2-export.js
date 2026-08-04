function clean(value) {
  return String(value ?? "").trim();
}

export function buildSub2ExportEntry(account, accessToken) {
  const email = clean(account?.email).toLowerCase();
  const token = clean(accessToken);
  if (!email) throw new Error("账号邮箱为空");
  if (!token) throw new Error("账号 AT 为空");
  return {
    name: clean(account?.custom_name) || email,
    email,
    access_token: token,
  };
}

export function serializeSub2Export(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("没有可导出的 Sub2 账号");
  return `${JSON.stringify(entries, null, 2)}\n`;
}

export function sub2ExportFilename(count, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `sub2-openai-${Math.max(1, Number(count) || 1)}-${stamp}.json`;
}

export function buildRefreshTokenExportEntry(account, sourceCredentials) {
  const email = clean(account?.email).toLowerCase();
  const credentials = sourceCredentials && typeof sourceCredentials === "object"
    ? Object.fromEntries(Object.entries(sourceCredentials)
      .map(([key, value]) => [key, typeof value === "string" ? clean(value) : value])
      .filter(([, value]) => value !== "" && value !== null && value !== undefined))
    : {};
  if (!email) throw new Error("账号邮箱为空");
  if (!clean(credentials.access_token)) throw new Error("账号 AT 为空");
  if (!clean(credentials.refresh_token)) throw new Error("账号 Refresh Token 为空");
  return {
    name: clean(account?.custom_name) || email,
    platform: "openai",
    type: "oauth",
    credentials: { ...credentials, email },
    extra: { email },
    concurrency: 1,
    priority: 0,
    rate_multiplier: 1,
    auto_pause_on_expired: false,
  };
}

export function serializeRefreshTokens(entries, now = new Date()) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("没有可导出的 Refresh Token");
  return `${JSON.stringify({
    exported_at: now.toISOString(),
    proxies: [],
    accounts: entries,
  }, null, 2)}\n`;
}

export function refreshTokenExportFilename(_count, now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `sub2api-account-${stamp}.json`;
}
