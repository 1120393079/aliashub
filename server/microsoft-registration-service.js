import crypto from "node:crypto";
import { publicAccount } from "./account-service.js";
import { normalizeMicrosoftEmail } from "./address-generator.js";
import { audit, createSourceAccount, getSetting, nowIso, setSetting } from "./db.js";

const WEBHOOK_TOKEN_HASH_SETTING = "microsoft_registration_webhook_token_hash";
const INGEST_PATH = "/api/integrations/microsoft-register/v1/ingest";
const MAX_PAYLOAD_BYTES = 900_000;
const MAX_UPLOAD_ITEMS = 100;
const MAX_TEXT_LENGTH = 8_000;

function errorWithStatus(message, status = 400, code = "MICROSOFT_REGISTRATION_ERROR") {
  return Object.assign(new Error(message), { status, code });
}

function safeEqual(left, right) {
  const first = Buffer.from(String(left || ""));
  const second = Buffer.from(String(right || ""));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function cleanText(value, maximum = MAX_TEXT_LENGTH) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim().slice(0, maximum);
  }
  return "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedKey(value) {
  return String(value || "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function parseEmbeddedJson(value) {
  if (typeof value !== "string") return value;
  const raw = value.trim();
  if (!raw || !["{", "["].includes(raw[0])) return value;
  try { return JSON.parse(raw); } catch { return value; }
}

function scalarValue(value) {
  const parsed = parseEmbeddedJson(value);
  return typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean" ? cleanText(parsed) : "";
}

function findValue(value, names, depth = 0, seen = new WeakSet()) {
  if (depth > 5 || value === null || value === undefined) return "";
  const parsed = parseEmbeddedJson(value);
  if (typeof parsed !== "object") return "";
  if (seen.has(parsed)) return "";
  seen.add(parsed);
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const result = findValue(item, names, depth + 1, seen);
      if (result) return result;
    }
    return "";
  }
  for (const [key, item] of Object.entries(parsed)) {
    if (names.has(normalizedKey(key))) {
      const result = scalarValue(item);
      if (result) return result;
    }
  }
  for (const item of Object.values(parsed)) {
    const result = findValue(item, names, depth + 1, seen);
    if (result) return result;
  }
  return "";
}

function booleanValue(value, names, depth = 0, seen = new WeakSet()) {
  if (depth > 5 || value === null || value === undefined) return null;
  const parsed = parseEmbeddedJson(value);
  if (typeof parsed !== "object") return null;
  if (seen.has(parsed)) return null;
  seen.add(parsed);
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const result = booleanValue(item, names, depth + 1, seen);
      if (result !== null) return result;
    }
    return null;
  }
  for (const [key, item] of Object.entries(parsed)) {
    if (!names.has(normalizedKey(key))) continue;
    if (typeof item === "boolean") return item;
    if (typeof item === "number") return item !== 0;
    if (typeof item === "string" && /^(?:true|false|1|0|yes|no|success|failed)$/i.test(item.trim())) {
      return /^(?:true|1|yes|success)$/i.test(item.trim());
    }
  }
  for (const item of Object.values(parsed)) {
    const result = booleanValue(item, names, depth + 1, seen);
    if (result !== null) return result;
  }
  return null;
}

function maskProxy(value) {
  const raw = cleanText(value, 1_000);
  if (!raw) return "";
  try {
    const parsed = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    const target = raw.includes("@") ? raw.split("@").at(-1) : raw;
    return target.replace(/^\/+/, "").slice(0, 255);
  }
}

function uploadItems(body) {
  const parsedData = parseEmbeddedJson(body?.data ?? body);
  if (Array.isArray(parsedData)) return parsedData.map(parseEmbeddedJson).filter(plainObject);
  if (plainObject(parsedData)) {
    for (const key of ["items", "accounts", "results", "records"]) {
      if (Array.isArray(parsedData[key])) return parsedData[key].map(parseEmbeddedJson).filter(plainObject);
    }
    return [parsedData];
  }
  return [];
}

function extractAccount(item) {
  const emailRaw = findValue(item, new Set(["email", "mail", "email_address", "mail_address", "account_email", "outlook_email", "username", "user_name", "account"]));
  const normalizedEmail = normalizeMicrosoftEmail(emailRaw);
  const statusRaw = findValue(item, new Set(["status", "result_status", "register_status", "state", "result", "message", "msg", "error", "error_message"])).toLowerCase();
  const success = booleanValue(item, new Set(["success", "ok", "registered", "is_success"]));
  const status = success === true || /(?:success|succeed|completed|registered|ok|成功|完成)/i.test(statusRaw)
    ? "success"
    : success === false || /(?:fail|error|denied|invalid|失败|错误)/i.test(statusRaw)
      ? "failed"
      : statusRaw ? "received" : "unknown";
  return {
    email: normalizedEmail,
    displayName: findValue(item, new Set(["display_name", "displayname", "name", "full_name", "fullname"])),
    password: findValue(item, new Set(["password", "pass", "pwd", "mail_password", "account_password"])),
    refreshToken: findValue(item, new Set(["refresh_token", "refreshtoken", "oauth_refresh_token"])),
    accessToken: findValue(item, new Set(["access_token", "accesstoken", "token", "raw_token", "rawtoken", "oauth_token"])),
    scope: findValue(item, new Set(["scope", "scopes", "oauth_scope"])),
    proxyLabel: maskProxy(findValue(item, new Set(["proxy", "proxy_url", "proxyurl", "proxy_label", "proxylabel"]))),
    externalRecordKey: findValue(item, new Set(["event_id", "eventid", "task_id", "taskid", "record_id", "recordid", "uuid", "id", "account_id", "accountid"])),
    status,
  };
}

function pageNumber(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : fallback;
}

function pageSize(value, fallback = 50) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : fallback;
}

function publicRegistrationAccount(row) {
  let metadata = {};
  try { metadata = JSON.parse(row.metadata_json || "{}"); } catch { metadata = {}; }
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    status: row.status,
    proxy_label: row.proxy_label,
    source_label: row.source_label,
    external_record_key: row.external_record_key,
    source_account_id: row.source_account_id || null,
    source_account_email: row.source_account_email || "",
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    upload_count: Number(row.upload_count) || 0,
    has_password: Boolean(row.has_password),
    has_refresh_token: Boolean(row.has_refresh_token),
    has_access_token: Boolean(row.has_access_token),
    metadata,
  };
}

export class MicrosoftRegistrationService {
  constructor({ db, encryptionKey } = {}) {
    this.db = db;
    this.encryptionKey = encryptionKey
      ? crypto.createHash("sha256").update(String(encryptionKey)).digest()
      : null;
  }

  get encryptionReady() {
    return Boolean(this.encryptionKey);
  }

  requireEncryption() {
    if (!this.encryptionKey) {
      throw errorWithStatus("微软邮箱注册接入需要配置 DATA_ENCRYPTION_KEY", 409, "MICROSOFT_REGISTRATION_ENCRYPTION_REQUIRED");
    }
  }

  encryptJson(value) {
    this.requireEncryption();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  decryptJson(value) {
    this.requireEncryption();
    const [version, iv, tag, encrypted] = String(value || "").split(".");
    if (version !== "v1" || !iv || !tag || !encrypted) throw errorWithStatus("注册记录凭据无法解密", 500, "MICROSOFT_REGISTRATION_DECRYPT_FAILED");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8"));
  }

  endpointBase(publicBaseUrl) {
    return `${String(publicBaseUrl || "").replace(/\/+$/, "")}${INGEST_PATH}`;
  }

  configuration(publicBaseUrl) {
    const summary = this.db.prepare(`
      SELECT
        COUNT(*) AS accounts,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successful_accounts,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_accounts,
        MAX(last_seen_at) AS last_received_at
      FROM microsoft_registration_accounts
    `).get();
    const imports = this.db.prepare("SELECT COUNT(*) AS count FROM microsoft_registration_imports").get().count;
    return {
      webhook_configured: Boolean(getSetting(this.db, WEBHOOK_TOKEN_HASH_SETTING, "")),
      encryption_ready: this.encryptionReady,
      endpoint_base: this.endpointBase(publicBaseUrl),
      accounts: Number(summary.accounts) || 0,
      successful_accounts: Number(summary.successful_accounts) || 0,
      failed_accounts: Number(summary.failed_accounts) || 0,
      imports: Number(imports) || 0,
      last_received_at: summary.last_received_at || "",
    };
  }

  rotateWebhookToken(publicBaseUrl) {
    this.requireEncryption();
    const token = crypto.randomBytes(32).toString("base64url");
    setSetting(this.db, WEBHOOK_TOKEN_HASH_SETTING, hash(token));
    const ingestUrl = `${this.endpointBase(publicBaseUrl)}/${token}`;
    audit(this.db, null, "microsoft_registration", "更新微软邮箱注册回传地址", "Go 注册机回传 Token 已轮换", {});
    return {
      ...this.configuration(publicBaseUrl),
      ingest_url: ingestUrl,
      config_snippet: `# AliasHub 微软邮箱注册回传\nserver_upload_url = "${ingestUrl}"\n\n[server_upload_other]\nsource = "go-ms-v9.2.8"`,
    };
  }

  authorizeWebhook(token) {
    const candidate = cleanText(token, 256);
    const configured = getSetting(this.db, WEBHOOK_TOKEN_HASH_SETTING, "");
    if (!candidate || !configured || !safeEqual(hash(candidate), configured)) {
      throw errorWithStatus("微软注册回传地址无效", 401, "MICROSOFT_REGISTRATION_WEBHOOK_UNAUTHORIZED");
    }
  }

  ingest(token, body) {
    this.authorizeWebhook(token);
    return this.ingestPayload(body);
  }

  ingestTrusted(body) {
    return this.ingestPayload(body);
  }

  ingestPayload(body) {
    this.requireEncryption();
    if (!plainObject(body) && !Array.isArray(body)) {
      throw errorWithStatus("回传数据必须为 JSON 对象或数组", 400, "MICROSOFT_REGISTRATION_INVALID_PAYLOAD");
    }
    const serialized = JSON.stringify(body);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
      throw errorWithStatus("回传数据超过允许大小", 413, "MICROSOFT_REGISTRATION_PAYLOAD_TOO_LARGE");
    }
    const items = uploadItems(body);
    if (!items.length) throw errorWithStatus("回传数据中没有可处理的 data", 400, "MICROSOFT_REGISTRATION_EMPTY_DATA");
    if (items.length > MAX_UPLOAD_ITEMS) throw errorWithStatus(`单次最多接收 ${MAX_UPLOAD_ITEMS} 条注册结果`, 400, "MICROSOFT_REGISTRATION_TOO_MANY_ITEMS");

    const payloadSha256 = hash(serialized);
    const sourceMetadata = plainObject(body?.server_upload_other) ? body.server_upload_other : {};
    const sourceLabel = cleanText(sourceMetadata.source || body?.source || "go-ms", 120) || "go-ms";
    const existingImport = this.db.prepare("SELECT id FROM microsoft_registration_imports WHERE payload_sha256 = ?").get(payloadSha256);
    if (existingImport) return { success: true, accepted: 0, updated: 0, ignored: 0, duplicates: 1, import_id: existingImport.id };

    const receivedAt = nowIso();
    const insertImport = this.db.prepare(`
      INSERT INTO microsoft_registration_imports (payload_sha256, source_label, item_count, raw_payload_encrypted, received_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const findAccount = this.db.prepare("SELECT * FROM microsoft_registration_accounts WHERE email = ? COLLATE NOCASE");
    const insertAccount = this.db.prepare(`
      INSERT INTO microsoft_registration_accounts (
        email, display_name, status, proxy_label, source_label, credential_payload_encrypted, source_payload_encrypted,
        source_import_id, external_record_key, metadata_json, has_password, has_refresh_token, has_access_token,
        first_seen_at, last_seen_at, upload_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    const updateAccount = this.db.prepare(`
      UPDATE microsoft_registration_accounts SET
        display_name = ?, status = ?, proxy_label = ?, source_label = ?, credential_payload_encrypted = ?,
        source_payload_encrypted = ?, source_import_id = ?, external_record_key = ?, metadata_json = ?,
        has_password = ?, has_refresh_token = ?, has_access_token = ?, last_seen_at = ?,
        upload_count = upload_count + 1, updated_at = ?
      WHERE id = ?
    `);
    let accepted = 0;
    let updated = 0;
    let ignored = 0;
    let importId = 0;
    this.db.transaction(() => {
      importId = Number(insertImport.run(payloadSha256, sourceLabel, items.length, this.encryptJson(body), receivedAt).lastInsertRowid);
      for (const item of items) {
        const extracted = extractAccount(item);
        if (!extracted.email) {
          ignored += 1;
          continue;
        }
        const existing = findAccount.get(extracted.email);
        const previousCredentials = existing?.credential_payload_encrypted ? this.decryptJson(existing.credential_payload_encrypted) : {};
        const credentials = {
          password: extracted.password || previousCredentials.password || "",
          refresh_token: extracted.refreshToken || previousCredentials.refresh_token || "",
          access_token: extracted.accessToken || previousCredentials.access_token || "",
          scope: extracted.scope || previousCredentials.scope || "",
        };
        const metadata = JSON.stringify({
          data_fields: Object.keys(item).slice(0, 50).map((key) => cleanText(key, 120)),
          server_upload_other_fields: Object.keys(sourceMetadata).slice(0, 50).map((key) => cleanText(key, 120)),
        });
        const encryptedCredentials = credentials.password || credentials.refresh_token || credentials.access_token || credentials.scope
          ? this.encryptJson(credentials)
          : "";
        const encryptedSource = this.encryptJson(item);
        if (existing) {
          updateAccount.run(
            extracted.displayName || existing.display_name,
            extracted.status === "unknown" ? existing.status : extracted.status,
            extracted.proxyLabel || existing.proxy_label,
            sourceLabel,
            encryptedCredentials || existing.credential_payload_encrypted,
            encryptedSource,
            importId,
            extracted.externalRecordKey || existing.external_record_key,
            metadata,
            credentials.password ? 1 : 0,
            credentials.refresh_token ? 1 : 0,
            credentials.access_token ? 1 : 0,
            receivedAt,
            receivedAt,
            existing.id,
          );
          updated += 1;
        } else {
          insertAccount.run(
            extracted.email,
            extracted.displayName,
            extracted.status,
            extracted.proxyLabel,
            sourceLabel,
            encryptedCredentials,
            encryptedSource,
            importId,
            extracted.externalRecordKey,
            metadata,
            credentials.password ? 1 : 0,
            credentials.refresh_token ? 1 : 0,
            credentials.access_token ? 1 : 0,
            receivedAt,
            receivedAt,
            receivedAt,
            receivedAt,
          );
          accepted += 1;
        }
      }
    })();
    audit(this.db, null, "microsoft_registration", "接收微软邮箱注册结果", `${accepted + updated} 个账号记录`, {
      source: sourceLabel,
      accepted,
      updated,
      ignored,
      importId,
    });
    return { success: true, accepted, updated, ignored, duplicates: 0, import_id: importId };
  }

  listAccounts({ page, limit, q, status } = {}) {
    const currentPage = pageNumber(page);
    const currentLimit = pageSize(limit);
    const conditions = ["1 = 1"];
    const params = [];
    const query = cleanText(q, 160);
    if (query) {
      conditions.push("(microsoft_registration_accounts.email LIKE ? OR microsoft_registration_accounts.display_name LIKE ? OR microsoft_registration_accounts.source_label LIKE ?)");
      const term = `%${query}%`;
      params.push(term, term, term);
    }
    if (["success", "failed", "received", "unknown"].includes(status)) {
      conditions.push("microsoft_registration_accounts.status = ?");
      params.push(status);
    }
    const where = conditions.join(" AND ");
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM microsoft_registration_accounts WHERE ${where}`).get(...params).count;
    const items = this.db.prepare(`
      SELECT microsoft_registration_accounts.*, source_accounts.email AS source_account_email
      FROM microsoft_registration_accounts
      LEFT JOIN source_accounts ON source_accounts.id = microsoft_registration_accounts.source_account_id
      WHERE ${where}
      ORDER BY microsoft_registration_accounts.last_seen_at DESC, microsoft_registration_accounts.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, currentLimit, (currentPage - 1) * currentLimit).map(publicRegistrationAccount);
    return { items, total, page: currentPage, pages: Math.max(1, Math.ceil(total / currentLimit)) };
  }

  accountRow(id) {
    const recordId = Number(id);
    if (!Number.isSafeInteger(recordId) || recordId <= 0) throw errorWithStatus("微软注册记录 ID 无效");
    const row = this.db.prepare("SELECT * FROM microsoft_registration_accounts WHERE id = ?").get(recordId);
    if (!row) throw errorWithStatus("微软注册记录不存在", 404, "MICROSOFT_REGISTRATION_RECORD_NOT_FOUND");
    return row;
  }

  credentials(id) {
    const row = this.accountRow(id);
    const credentials = row.credential_payload_encrypted ? this.decryptJson(row.credential_payload_encrypted) : {};
    return {
      id: row.id,
      email: row.email,
      password: String(credentials.password || ""),
      refresh_token: String(credentials.refresh_token || ""),
      access_token: String(credentials.access_token || ""),
      scope: String(credentials.scope || ""),
    };
  }

  addSourceAccount(id) {
    const row = this.accountRow(id);
    let account = row.source_account_id
      ? this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(row.source_account_id)
      : this.db.prepare("SELECT * FROM source_accounts WHERE email = ? COLLATE NOCASE").get(row.email);
    if (account && account.provider !== "microsoft") {
      throw errorWithStatus("这个邮箱已绑定到其他提供商，不能作为 Microsoft 源头邮箱", 409, "MICROSOFT_REGISTRATION_PROVIDER_MISMATCH");
    }
    const existing = Boolean(account);
    if (!account) account = createSourceAccount(this.db, { email: row.email, displayName: row.display_name || row.email.split("@")[0] });
    const timestamp = nowIso();
    this.db.prepare("UPDATE microsoft_registration_accounts SET source_account_id = ?, updated_at = ? WHERE id = ?")
      .run(account.id, timestamp, row.id);
    audit(this.db, account.id, "microsoft_registration", "接入微软注册邮箱", row.email, { registrationRecordId: row.id, existing });
    return { existing, account: publicAccount(this.db, this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id)) };
  }

  deleteAccount(id) {
    const row = this.accountRow(id);
    this.db.prepare("DELETE FROM microsoft_registration_accounts WHERE id = ?").run(row.id);
    audit(this.db, row.source_account_id || null, "microsoft_registration", "删除微软注册记录", row.email, { registrationRecordId: row.id });
    return { deleted: true, id: row.id };
  }
}
