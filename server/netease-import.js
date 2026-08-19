import {
  normalizeNeteaseAliasEmail,
  normalizeNeteaseEmail,
} from "./address-generator.js";

const MAX_IMPORT_ACCOUNTS = 100;
const MAX_IMPORT_ALIASES = 5_000;
const MAX_IMPORT_CONTENT_BYTES = 900_000;
const MAX_AUTH_CODE_LENGTH = 256;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, code: "NETEASE_IMPORT_INVALID" });
}

function normalizeAuthCode(value, lineNumber) {
  const authCode = typeof value === "string" ? value.trim() : "";
  if (!authCode) throw badRequest(`第 ${lineNumber} 行缺少客户端授权码`);
  if (authCode.length > MAX_AUTH_CODE_LENGTH || /[\u0000-\u001f\u007f-\u009f]/.test(authCode)) {
    throw badRequest(`第 ${lineNumber} 行客户端授权码格式无效`);
  }
  return authCode;
}

function aliasValues(value) {
  if (Array.isArray(value)) return value.flatMap(aliasValues);
  return String(value || "")
    .split(/[\s,;，；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeAliases(values, lineNumber) {
  const supplied = aliasValues(values);
  const invalid = supplied.find((value) => !normalizeNeteaseAliasEmail(value));
  if (invalid) {
    throw badRequest(`第 ${lineNumber} 行替身邮箱后缀无效，仅支持 @aka.yeah.net`);
  }
  return [...new Set(supplied.map(normalizeNeteaseAliasEmail))];
}

function normalizeEntry(emailValue, authCodeValue, aliasesValue, lineNumber) {
  const email = normalizeNeteaseEmail(emailValue);
  if (!email) {
    throw badRequest(`第 ${lineNumber} 行母号必须使用 @163.com、@126.com 或 @yeah.net 后缀`);
  }
  return {
    email,
    authCode: normalizeAuthCode(authCodeValue, lineNumber),
    aliases: normalizeAliases(aliasesValue, lineNumber),
    lineNumber,
  };
}

function validateImportSet(accounts) {
  if (!accounts.length) throw badRequest("没有可导入的网易邮箱账号");
  if (accounts.length > MAX_IMPORT_ACCOUNTS) {
    throw badRequest(`单次最多导入 ${MAX_IMPORT_ACCOUNTS} 个网易邮箱母号`);
  }
  const emails = accounts.map((item) => item.email);
  if (new Set(emails).size !== emails.length) throw badRequest("导入内容中存在重复母号");

  const ownerByAlias = new Map();
  let aliasCount = 0;
  for (const account of accounts) {
    account.aliases = [...new Set(account.aliases)];
    aliasCount += account.aliases.length;
    for (const alias of account.aliases) {
      const owner = ownerByAlias.get(alias);
      if (owner && owner !== account.email) {
        throw badRequest(`${alias} 同时映射到了多个网易邮箱母号`);
      }
      ownerByAlias.set(alias, account.email);
    }
  }
  if (aliasCount > MAX_IMPORT_ALIASES) {
    throw badRequest(`单次最多导入 ${MAX_IMPORT_ALIASES} 个网易替身邮箱`);
  }
  return accounts.map(({ lineNumber: _lineNumber, ...account }) => account);
}

function parseTextContent(content) {
  const accounts = [];
  let current = null;
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (!line) continue;

    if (line.includes("----")) {
      const fields = line.split("----");
      const email = fields.shift();
      const authCode = fields.shift();
      current = normalizeEntry(email, authCode, fields, lineNumber);
      accounts.push(current);
      continue;
    }

    const aliases = normalizeAliases(line, lineNumber);
    if (!aliases.length) throw badRequest(`第 ${lineNumber} 行格式无效`);
    if (!current) {
      throw badRequest(`第 ${lineNumber} 行替身邮箱前缺少“母号----客户端授权码”行`);
    }
    current.aliases.push(...aliases);
  }
  return accounts;
}

export function parseNeteaseAccountImport(input = {}) {
  const supplied = Array.isArray(input?.accounts) ? input.accounts : null;
  const content = typeof input?.content === "string" ? input.content : "";
  if (!supplied && Buffer.byteLength(content, "utf8") > MAX_IMPORT_CONTENT_BYTES) {
    throw badRequest("单次导入内容不能超过 900 KB");
  }

  const accounts = supplied
    ? supplied.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw badRequest(`第 ${index + 1} 条账号不是对象`);
      }
      const aliases = item.aliases === undefined ? [] : item.aliases;
      if (!Array.isArray(aliases) && typeof aliases !== "string") {
        throw badRequest(`第 ${index + 1} 条账号的 aliases 必须是数组或文本`);
      }
      return normalizeEntry(item.email, item.authCode, aliases, index + 1);
    })
    : parseTextContent(content);
  return validateImportSet(accounts);
}

function redactMessage(error, secrets) {
  const status = Number(error?.status);
  let message = status >= 400 && status <= 599
    ? String(error.message || "网易邮箱连接失败")
    : "网易邮箱连接失败";
  for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
  return message.slice(0, 240);
}

export async function importNeteaseAccounts(client, input = {}) {
  const accounts = parseNeteaseAccountImport(input);
  const secrets = [...new Set(accounts.map((item) => item.authCode).filter(Boolean))];
  const items = [];

  for (let offset = 0; offset < accounts.length; offset += 4) {
    const batch = accounts.slice(offset, offset + 4);
    const settled = await Promise.all(batch.map(async ({ email, authCode, aliases }) => {
      try {
        const existing = client.db.prepare(
          "SELECT * FROM source_accounts WHERE email = ? COLLATE NOCASE",
        ).get(email);
        const action = existing?.provider === "netease" ? "updated" : "created";
        const connectInput = {
          accountId: existing?.provider === "netease" ? existing.id : undefined,
          email,
          authCode,
        };
        // A credential-only re-import must not erase aliases already mapped to
        // the mailbox. The dedicated alias endpoint handles an explicit clear.
        if (aliases.length) connectInput.aliases = aliases;
        const result = await client.connectAccount(connectInput);
        return {
          email,
          status: "connected",
          action,
          aliasCount: aliases.length,
          account: result.account,
        };
      } catch (error) {
        return {
          email,
          status: "failed",
          aliasCount: aliases.length,
          error: redactMessage(error, secrets),
        };
      }
    }));
    items.push(...settled);
  }

  const imported = items.filter((item) => item.status === "connected").length;
  const created = items.filter((item) => item.status === "connected" && item.action === "created").length;
  const updated = items.filter((item) => item.status === "connected" && item.action === "updated").length;
  return {
    imported,
    created,
    updated,
    failed: items.length - imported,
    total: items.length,
    items,
  };
}
