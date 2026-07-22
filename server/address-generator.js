import crypto from "node:crypto";

// Domains currently offered by signup.live.com across Microsoft consumer markets,
// plus the legacy global Hotmail, Live, and MSN domains.
const MICROSOFT_DOMAINS = new Set([
  "outlook.com",
  "outlook.at",
  "outlook.be",
  "outlook.cl",
  "outlook.co.id",
  "outlook.co.il",
  "outlook.co.nz",
  "outlook.co.th",
  "outlook.com.ar",
  "outlook.com.au",
  "outlook.com.br",
  "outlook.com.gr",
  "outlook.com.tr",
  "outlook.com.vn",
  "outlook.cz",
  "outlook.de",
  "outlook.dk",
  "outlook.es",
  "outlook.fr",
  "outlook.hu",
  "outlook.ie",
  "outlook.in",
  "outlook.it",
  "outlook.jp",
  "outlook.kr",
  "outlook.lv",
  "outlook.my",
  "outlook.ph",
  "outlook.pt",
  "outlook.sa",
  "outlook.sg",
  "outlook.sk",
  "hotmail.com",
  "live.com",
  "msn.com",
]);
const ICLOUD_DOMAINS = new Set(["icloud.com", "me.com", "mac.com"]);
const ICLOUD_PRIVATE_RELAY_DOMAIN = "privaterelay.appleid.com";
export const ICLOUD_MAIL_ALIAS_STRATEGY = "icloud_mail_alias";
export const ICLOUD_HIDE_MY_EMAIL_STRATEGY = "icloud_hide_my_email";
export const ICLOUD_IMPORTED_ADDRESS_STRATEGIES = new Set([
  ICLOUD_MAIL_ALIAS_STRATEGY,
  ICLOUD_HIDE_MY_EMAIL_STRATEGY,
]);
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const WORDS = ["amber", "atlas", "bamboo", "bright", "cedar", "clear", "comet", "harbor", "maple", "pixel", "river", "signal", "studio", "vault"];
const CODE_CONTEXT_SOURCE = [
  "verification", "verify", "security", "one[- ]time", "passcode", "code", "otp",
  "验证码", "驗證碼", "校验码", "确认码", "安全码", "安全代码", "登录码", "登入碼",
  "認証コード", "検証コード", "確認コード", "セキュリティコード", "ワンタイム(?:パスワード|コード)",
  "mã\\s+(?:xác\\s+minh|xác\\s+nhận|bảo\\s+mật|đăng\\s+nhập|dùng\\s+một\\s+lần)",
].join("|");
const CODE_CONTEXT = new RegExp(`(?:${CODE_CONTEXT_SOURCE})`, "i");
const CODE_AFTER_CONTEXT = new RegExp(`(?:${CODE_CONTEXT_SOURCE})[^0-9]{0,60}([0-9]{4,8})`, "i");
const CODE_BEFORE_CONTEXT = new RegExp(`\\b([0-9]{4,8})\\b[^\\n]{0,80}(?:${CODE_CONTEXT_SOURCE})`, "i");

export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/.test(email)) return "";
  if (email.length > 254) return "";
  const [local, domain] = email.split("@");
  if (!local || local.length > 64 || !domain || domain.length > 253) return "";
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return "";
  return email;
}

export function normalizeGoogleEmail(value) {
  return normalizeEmail(value);
}

export function normalizeIcloudEmail(value) {
  const email = normalizeEmail(value);
  return email && ICLOUD_DOMAINS.has(email.split("@")[1]) ? email : "";
}

export function normalizeIcloudAliasEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return "";
  const domain = email.split("@")[1];
  return ICLOUD_DOMAINS.has(domain) || domain === ICLOUD_PRIVATE_RELAY_DOMAIN ? email : "";
}

export function isIcloudPrivateRelay(value) {
  const email = normalizeIcloudAliasEmail(value);
  return Boolean(email && email.endsWith(`@${ICLOUD_PRIVATE_RELAY_DOMAIN}`));
}

export function isIcloudImportedStrategy(value) {
  return ICLOUD_IMPORTED_ADDRESS_STRATEGIES.has(String(value || ""));
}

export function normalizeMicrosoftEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return "";
  const domain = email.split("@")[1];
  return MICROSOFT_DOMAINS.has(domain) ? email : "";
}

export function normalizeAliasLocal(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/[._-]{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 40);
}

export function normalizeTag(value, maxLength = 30) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/[._-]{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, Math.max(1, Number(maxLength) || 30));
}

export function randomString(length = 6) {
  const size = Math.max(3, Math.min(16, Number(length) || 6));
  let value = "";
  for (let index = 0; index < size; index += 1) value += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return value;
}

export function officialCandidate({ prefix = "", mode = "random", sequence = 1 } = {}) {
  const cleanPrefix = normalizeAliasLocal(prefix);
  const joiner = cleanPrefix ? "." : "";
  if (mode === "sequence") return normalizeAliasLocal(`${cleanPrefix || "alias"}${String(sequence).padStart(3, "0")}`);
  if (mode === "readable") return normalizeAliasLocal(`${cleanPrefix}${joiner}${WORDS[crypto.randomInt(0, WORDS.length)]}${crypto.randomInt(10, 100)}`);
  return normalizeAliasLocal(`${cleanPrefix}${joiner}${randomString(7)}`);
}

export function splitAddress(baseAddress, { prefix = "alias", mode = "sequence", sequence = 1, randomLength = 6, customTag = "" } = {}) {
  const [local, domain] = String(baseAddress).toLowerCase().split("@");
  if (!local || !domain) throw new Error("基础地址无效");
  const cleanPrefix = normalizeTag(prefix) || "alias";
  const cleanCustomTag = normalizeTag(customTag, 63);
  let tag;
  if (cleanCustomTag) tag = cleanCustomTag;
  else if (mode === "random") tag = `${cleanPrefix}-${randomString(randomLength)}`;
  else if (mode === "dated") tag = `${cleanPrefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${String(sequence).padStart(3, "0")}`;
  else tag = `${cleanPrefix}-${String(sequence).padStart(4, "0")}`;
  const maxTagLength = 63 - local.length;
  if (maxTagLength < 1) throw new Error("基础地址过长，无法生成分裂地址");
  return `${local}+${normalizeTag(tag, maxTagLength).slice(0, maxTagLength)}@${domain}`;
}

export function codeFromText(value) {
  const text = String(value || "");
  if (!CODE_CONTEXT.test(text)) return "";
  const prioritized = [CODE_AFTER_CONTEXT, CODE_BEFORE_CONTEXT];
  for (const pattern of prioritized) {
    const match = text.match(pattern);
    if (match && match[1] !== "000000") return match[1];
  }
  return "";
}

export const microsoftDomains = [...MICROSOFT_DOMAINS];
export const icloudDomains = [...ICLOUD_DOMAINS];
export const icloudPrivateRelayDomain = ICLOUD_PRIVATE_RELAY_DOMAIN;
