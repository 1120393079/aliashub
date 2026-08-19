import { normalizeMailcomLoginEmail } from "./address-generator.js";

const MAX_IMPORT_ACCOUNTS = 100;
const MAX_IMPORT_CONTENT_BYTES = 900_000;
const MAX_PASSWORD_LENGTH = 256;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, code: "MAILCOM_IMPORT_INVALID" });
}

function normalizeEntry(emailValue, passwordValue, lineNumber) {
  const email = normalizeMailcomLoginEmail(emailValue);
  if (!email) throw badRequest(`第 ${lineNumber} 行邮箱地址格式无效`);
  if (typeof passwordValue !== "string" || !passwordValue) {
    throw badRequest(`第 ${lineNumber} 行缺少邮箱密码`);
  }
  if (passwordValue.length > MAX_PASSWORD_LENGTH || /[\u0000-\u001f\u007f-\u009f]/.test(passwordValue)) {
    throw badRequest(`第 ${lineNumber} 行邮箱密码格式无效`);
  }
  return { email, password: passwordValue };
}

export function parseMailcomAccountImport(input = {}) {
  const supplied = Array.isArray(input?.accounts) ? input.accounts : null;
  const content = typeof input?.content === "string" ? input.content : "";
  if (!supplied && Buffer.byteLength(content, "utf8") > MAX_IMPORT_CONTENT_BYTES) {
    throw badRequest("单次导入内容不能超过 900 KB");
  }

  let accounts;
  if (supplied) {
    accounts = supplied.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw badRequest(`第 ${index + 1} 条账号不是对象`);
      }
      return normalizeEntry(item.email, item.password, index + 1);
    });
  } else {
    const lines = content.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) throw badRequest("请粘贴要导入的 Mail.com 邮箱");
    accounts = lines.map((line, index) => {
      const separator = line.indexOf("----");
      if (separator < 0) {
        throw badRequest(`第 ${index + 1} 行格式无效，请使用 email----password`);
      }
      const email = line.slice(0, separator).trim();
      const password = line.slice(separator + 4);
      return normalizeEntry(email, password, index + 1);
    });
  }

  if (!accounts.length) throw badRequest("没有可导入的 Mail.com 邮箱");
  if (accounts.length > MAX_IMPORT_ACCOUNTS) {
    throw badRequest(`单次最多导入 ${MAX_IMPORT_ACCOUNTS} 个 Mail.com 邮箱`);
  }
  const emails = accounts.map((item) => item.email);
  if (new Set(emails).size !== emails.length) throw badRequest("导入内容中存在重复邮箱");
  return accounts;
}

export async function importMailcomAccounts(client, input = {}) {
  const accounts = parseMailcomAccountImport(input);
  const secrets = [...new Set(accounts.map((item) => item.password).filter(Boolean))];
  const safeError = (error) => {
    const status = Number(error?.status);
    let message = status >= 400 && status <= 599
      ? String(error.message || "Mail.com 邮箱连接失败")
      : "Mail.com 邮箱连接失败";
    for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
    return message.slice(0, 240);
  };
  const items = [];
  for (let offset = 0; offset < accounts.length; offset += 4) {
    const batch = accounts.slice(offset, offset + 4);
    const settled = await Promise.all(batch.map(async ({ email, password }) => {
      try {
        const existing = client.db.prepare("SELECT * FROM source_accounts WHERE email = ? COLLATE NOCASE").get(email);
        const action = existing?.provider === "mailcom" ? "updated" : "created";
        const result = await client.connectAccount({
          accountId: existing?.provider === "mailcom" ? existing.id : undefined,
          email,
          password,
        });
        return { email, status: "connected", action, account: result.account };
      } catch (error) {
        return { email, status: "failed", error: safeError(error) };
      }
    }));
    items.push(...settled);
  }
  const imported = items.filter((item) => item.status === "connected").length;
  const created = items.filter((item) => item.action === "created").length;
  const updated = items.filter((item) => item.action === "updated").length;
  return { imported, created, updated, failed: items.length - imported, total: items.length, items };
}
