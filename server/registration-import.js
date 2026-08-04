const MAX_IMPORT_ACCOUNTS = 100;
const MAX_IMPORT_CONTENT_BYTES = 900_000;

const FLAT_CREDENTIAL_KEYS = [
  "access_token",
  "refresh_token",
  "id_token",
  "session_token",
  "cookies",
  "cookie",
  "client_id",
  "workspace_id",
  "account_id",
  "chatgpt_account_id",
];

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCsvRow(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw badRequest("CSV 中存在未闭合的双引号");
  values.push(value);
  return values;
}

function readPlainToken(line, start) {
  let cursor = start;
  while (/\s/.test(line[cursor] || "")) cursor += 1;
  if (cursor >= line.length) return null;
  const quote = line[cursor] === '"' || line[cursor] === "'" ? line[cursor] : "";
  if (!quote) {
    const end = line.slice(cursor).search(/\s/);
    return end < 0
      ? { value: line.slice(cursor), end: line.length }
      : { value: line.slice(cursor, cursor + end), end: cursor + end };
  }
  cursor += 1;
  let value = "";
  let escaped = false;
  for (; cursor < line.length; cursor += 1) {
    const character = line[cursor];
    if (escaped) {
      value += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === quote) {
      return { value, end: cursor + 1 };
    } else {
      value += character;
    }
  }
  throw badRequest("账号行中存在未闭合的引号");
}

function credentialsFrom(value) {
  const credentials = {};
  if (Array.isArray(value)) {
    value.forEach((item) => {
      const key = String(item?.key || "").trim();
      const credentialValue = item?.value;
      if (key && credentialValue !== undefined && credentialValue !== null && credentialValue !== "") {
        credentials[key] = String(credentialValue);
      }
    });
  } else if (isObject(value)) {
    Object.entries(value).forEach(([key, raw]) => {
      const credentialValue = isObject(raw) && Object.hasOwn(raw, "value") ? raw.value : raw;
      if (credentialValue !== undefined && credentialValue !== null && credentialValue !== "") {
        credentials[key] = String(credentialValue);
      }
    });
  }
  return credentials;
}

function normalizedImportAccount(raw, lineNumber) {
  if (!isObject(raw)) throw badRequest(`第 ${lineNumber} 条账号不是对象`);
  const platform = String(raw.platform || "chatgpt").trim().toLowerCase();
  if (platform !== "chatgpt") throw badRequest(`第 ${lineNumber} 条账号只支持 chatgpt 平台`);
  const email = String(raw.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 320) {
    throw badRequest(`第 ${lineNumber} 条账号邮箱无效`);
  }
  if (raw.password !== undefined && raw.password !== null && typeof raw.password !== "string") {
    throw badRequest(`第 ${lineNumber} 条账号密码必须是字符串`);
  }
  const password = String(raw.password || "");
  const credentials = credentialsFrom(raw.credentials);
  FLAT_CREDENTIAL_KEYS.forEach((key) => {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "" && !credentials[key]) {
      credentials[key] = String(raw[key]);
    }
  });
  const overview = isObject(raw.overview) ? { ...raw.overview } : {};
  for (const key of ["validity_status", "plan_state", "plan_name", "display_status", "remote_email", "checked_at"]) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "" && overview[key] === undefined) {
      overview[key] = raw[key];
    }
  }
  const originalId = Number(raw.id || raw.original_account_id || 0);
  return {
    originalId: Number.isSafeInteger(originalId) && originalId > 0 ? originalId : 0,
    payload: {
      platform: "chatgpt",
      email,
      password,
      user_id: String(raw.user_id || raw.account_id || ""),
      lifecycle_status: String(raw.lifecycle_status || raw.status || "registered"),
      overview,
      credentials,
      provider_accounts: Array.isArray(raw.provider_accounts) ? raw.provider_accounts : [],
      provider_resources: Array.isArray(raw.provider_resources) ? raw.provider_resources : [],
      primary_token: String(raw.primary_token || raw.token || ""),
      cashier_url: String(raw.cashier_url || ""),
      region: String(raw.region || ""),
      trial_end_time: Math.max(0, Number(raw.trial_end_time) || 0),
    },
  };
}

function parsePlainLines(content) {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw badRequest("请粘贴或选择要导入的账号文件");
  let csvHeader = null;
  let start = 0;
  if (lines[0].includes(",")) {
    const candidate = parseCsvRow(lines[0]).map((value) => value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, ""));
    if (candidate.includes("email")) {
      csvHeader = candidate;
      start = 1;
    }
  }
  const accounts = [];
  for (let index = start; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    if (csvHeader) {
      const values = parseCsvRow(lines[index]);
      const raw = {};
      csvHeader.forEach((key, column) => { raw[key] = values[column] ?? ""; });
      accounts.push(normalizedImportAccount(raw, lineNumber));
      continue;
    }
    const email = readPlainToken(lines[index], 0);
    const password = email && readPlainToken(lines[index], email.end);
    if (!email) throw badRequest(`第 ${lineNumber} 行需要邮箱`);
    if (!password) {
      accounts.push(normalizedImportAccount({ email: email.value, password: "" }, lineNumber));
      continue;
    }
    const remainder = lines[index].slice(password.end).trim();
    let extra = {};
    if (remainder) {
      try {
        extra = JSON.parse(remainder);
      } catch {
        extra = { cashier_url: remainder };
      }
      if (!isObject(extra)) throw badRequest(`第 ${lineNumber} 行附加数据必须是 JSON 对象`);
    }
    accounts.push(normalizedImportAccount({ ...extra, email: email.value, password: password.value }, lineNumber));
  }
  return accounts;
}

export function parseLocalAccountImport(input = {}) {
  const suppliedAccounts = Array.isArray(input?.accounts) ? input.accounts : null;
  const content = typeof input?.content === "string" ? input.content.trim() : "";
  if (!suppliedAccounts && Buffer.byteLength(content, "utf8") > MAX_IMPORT_CONTENT_BYTES) {
    throw badRequest("单次导入内容不能超过 900 KB");
  }

  let accounts;
  if (suppliedAccounts) {
    accounts = suppliedAccounts.map((item, index) => normalizedImportAccount(item, index + 1));
  } else if (content.startsWith("[") || content.startsWith("{")) {
    let decoded;
    try {
      decoded = JSON.parse(content);
    } catch {
      const jsonLines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (jsonLines.length < 2) throw badRequest("账号 JSON 格式无效");
      try {
        decoded = jsonLines.map((line) => JSON.parse(line));
      } catch {
        throw badRequest("账号 JSON 格式无效");
      }
    }
    const items = Array.isArray(decoded)
      ? decoded
      : Array.isArray(decoded?.items)
        ? decoded.items
        : Array.isArray(decoded?.accounts)
          ? decoded.accounts
          : [decoded];
    accounts = items.map((item, index) => normalizedImportAccount(item, index + 1));
  } else {
    accounts = parsePlainLines(content);
  }

  if (!accounts.length) throw badRequest("没有可导入的账号");
  if (accounts.length > MAX_IMPORT_ACCOUNTS) throw badRequest(`单次最多导入 ${MAX_IMPORT_ACCOUNTS} 个账号`);
  const emails = accounts.map((item) => item.payload.email);
  if (new Set(emails).size !== emails.length) throw badRequest("导入内容中存在重复邮箱");
  return accounts;
}
