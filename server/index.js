import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import express from "express";
import { deleteSplitAddresses, generateSplits, importIcloudAliases, JobRunner, parseJson, publicAccount, syncOfficialAddresses } from "./account-service.js";
import { createAuth } from "./auth.js";
import { isIcloudImportedStrategy, microsoftDomains, normalizeIcloudAliasEmail, normalizeMicrosoftEmail } from "./address-generator.js";
import { audit, createDatabase, createSourceAccount, getSettings, nowIso, setSetting } from "./db.js";
import { ExtensionService } from "./extension-service.js";
import { GoogleGmailClient } from "./google-gmail.js";
import { ICloudImapClient, icloudImapConfiguration } from "./icloud-imap.js";
import { MicrosoftGraphClient } from "./microsoft-graph.js";
import { NfapiService } from "./nfapi-service.js";
import { RegistrationClient } from "./registration-client.js";
import { RegistrationService } from "./registration-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function positive(value, fallback = 20, maximum = 5_000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, Math.floor(parsed))) : fallback;
}

function publicJob(row) {
  return row ? { ...row, config: parseJson(row.config), result: parseJson(row.result) } : null;
}

function requireMicrosoftAccount(account) {
  if (account?.provider !== "microsoft") {
    throw Object.assign(new Error("这个邮箱提供商不支持 Microsoft 官方别名功能"), {
      status: 409,
      code: "OFFICIAL_ALIASES_UNSUPPORTED",
    });
  }
  return account;
}

function addressQuery(db, { accountId, kind, q, page = 1, limit = 50 } = {}) {
  const conditions = ["1 = 1"];
  const params = [];
  if (accountId) { conditions.push("addresses.account_id = ?"); params.push(Number(accountId)); }
  if (kind && kind !== "all") { conditions.push("addresses.kind = ?"); params.push(kind); }
  if (q) {
    conditions.push("(addresses.address LIKE ? OR addresses.label LIKE ? OR addresses.purpose LIKE ? OR source_accounts.email LIKE ?)");
    const term = `%${q}%`;
    params.push(term, term, term, term);
  }
  const where = conditions.join(" AND ");
  const total = db.prepare(`SELECT COUNT(*) AS count FROM addresses JOIN source_accounts ON source_accounts.id = addresses.account_id WHERE ${where}`).get(...params).count;
  const items = db.prepare(`
    SELECT addresses.*, source_accounts.email AS source_email, source_accounts.display_name AS source_name,
      source_accounts.provider AS source_provider,
      parent.address AS parent_address
    FROM addresses
    JOIN source_accounts ON source_accounts.id = addresses.account_id
    LEFT JOIN addresses parent ON parent.id = addresses.parent_address_id
    WHERE ${where}
    ORDER BY CASE addresses.kind WHEN 'primary' THEN 0 WHEN 'official' THEN 1 ELSE 2 END, addresses.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

function publicMessage(row, { includeBody = false } = {}) {
  if (!row) return null;
  const item = {
    ...row,
    to_recipients: parseJson(row.to_recipients, []),
    cc_recipients: parseJson(row.cc_recipients, []),
    is_read: Boolean(row.is_read),
    has_attachments: Boolean(row.has_attachments),
    body_truncated: Boolean(row.body_truncated),
    is_hidden: Boolean(row.is_hidden),
  };
  if (!includeBody) delete item.body;
  return item;
}

function messageById(db, id) {
  const row = db.prepare(`
    SELECT mail_messages.*, source_accounts.email AS source_email,
      addresses.address, addresses.kind AS address_kind, parent.address AS parent_address
    FROM mail_messages
    JOIN source_accounts ON source_accounts.id = mail_messages.account_id
    LEFT JOIN addresses ON addresses.id = mail_messages.address_id
    LEFT JOIN addresses parent ON parent.id = addresses.parent_address_id
    WHERE mail_messages.id = ?
  `).get(Number(id));
  return publicMessage(row, { includeBody: true });
}

function accountScope(db, value, { required = false } = {}) {
  if (value === "all") return { accountId: null, allAccounts: true };
  if ((value === undefined || value === null || value === "") && !required) return { accountId: null, allAccounts: true };
  const accountId = typeof value === "number"
    ? value
    : (typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : NaN);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw Object.assign(new Error("请选择有效的源头邮箱"), { status: 400 });
  }
  if (!db.prepare("SELECT 1 FROM source_accounts WHERE id = ?").get(accountId)) {
    throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
  }
  return { accountId, allAccounts: false };
}

function messageQuery(db, { accountId, q, hidden = false, page = 1, limit = 50 } = {}) {
  const scope = accountScope(db, accountId);
  const conditions = ["1 = 1"];
  const params = [];
  if (!scope.allAccounts) {
    conditions.push("mail_messages.account_id = ?");
    params.push(scope.accountId);
  }
  if (q) {
    conditions.push(`(
      mail_messages.subject LIKE ? OR mail_messages.sender_name LIKE ? OR
      mail_messages.sender_address LIKE ? OR mail_messages.recipient_address LIKE ? OR
      mail_messages.preview LIKE ? OR mail_messages.body LIKE ? OR
      source_accounts.email LIKE ? OR addresses.address LIKE ?
    )`);
    const term = `%${String(q).trim()}%`;
    params.push(term, term, term, term, term, term, term, term);
  }
  const where = conditions.join(" AND ");
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN mail_messages.is_hidden = 0 THEN 1 ELSE 0 END) AS visible,
      SUM(CASE WHEN mail_messages.is_hidden = 1 THEN 1 ELSE 0 END) AS hidden
    FROM mail_messages
    JOIN source_accounts ON source_accounts.id = mail_messages.account_id
    LEFT JOIN addresses ON addresses.id = mail_messages.address_id
    WHERE ${where}
  `).get(...params);
  const visible = counts.visible || 0;
  const hiddenCount = counts.hidden || 0;
  const currentTotal = hidden ? hiddenCount : visible;
  const items = db.prepare(`
    SELECT mail_messages.*, source_accounts.email AS source_email,
      addresses.address, addresses.kind AS address_kind, parent.address AS parent_address
    FROM mail_messages
    JOIN source_accounts ON source_accounts.id = mail_messages.account_id
    LEFT JOIN addresses ON addresses.id = mail_messages.address_id
    LEFT JOIN addresses parent ON parent.id = addresses.parent_address_id
    WHERE ${where} AND mail_messages.is_hidden = ?
    ORDER BY mail_messages.received_at DESC, mail_messages.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, hidden ? 1 : 0, limit, (page - 1) * limit).map((row) => publicMessage(row));
  return {
    items,
    total: visible,
    visible,
    hidden: hiddenCount,
    currentTotal,
    page,
    pages: Math.max(1, Math.ceil(currentTotal / limit)),
  };
}

function setMessagesHidden(db, input, isHidden) {
  if (input?.all !== undefined && typeof input.all !== "boolean") {
    throw Object.assign(new Error("all 必须是布尔值"), { status: 400 });
  }
  const all = input?.all === true;
  const scope = accountScope(db, input?.accountId, { required: all });
  const rawIds = input?.ids;
  if (!all && !Array.isArray(rawIds)) {
    throw Object.assign(new Error("请选择要处理的邮件"), { status: 400 });
  }
  if (all && Array.isArray(rawIds) && rawIds.length) {
    throw Object.assign(new Error("不能同时选择邮件和全部邮件"), { status: 400 });
  }
  const ids = all ? [] : [...new Set(rawIds.map((value) => Number(value)))];
  if (!all && (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0))) {
    throw Object.assign(new Error("请选择有效的邮件"), { status: 400 });
  }
  if (ids.length > 5_000) throw Object.assign(new Error("单次最多处理 5000 封邮件"), { status: 400 });

  if (!all && !scope.allAccounts) {
    const placeholders = ids.map(() => "?").join(",");
    const outside = db.prepare(`
      SELECT 1 FROM mail_messages WHERE id IN (${placeholders}) AND account_id != ? LIMIT 1
    `).get(...ids, scope.accountId);
    if (outside) throw Object.assign(new Error("所选邮件不属于指定的源头邮箱"), { status: 409 });
  }

  const conditions = ["is_hidden = ?"];
  const params = [isHidden ? 0 : 1];
  if (!scope.allAccounts) {
    conditions.push("account_id = ?");
    params.push(scope.accountId);
  }
  if (!all) {
    conditions.push(`id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }
  const rows = db.prepare(`SELECT id, account_id, subject FROM mail_messages WHERE ${conditions.join(" AND ")}`).all(...params);
  if (!rows.length) return 0;
  const byAccount = new Map();
  rows.forEach((row) => byAccount.set(row.account_id, (byAccount.get(row.account_id) || 0) + 1));
  const update = db.prepare("UPDATE mail_messages SET is_hidden = ?, updated_at = ? WHERE id = ?");
  db.transaction(() => {
    const now = nowIso();
    rows.forEach((row) => update.run(isHidden ? 1 : 0, now, row.id));
    byAccount.forEach((count, sourceAccountId) => audit(
      db,
      sourceAccountId,
      "mail",
      isHidden ? "隐藏邮件" : "恢复邮件",
      `共${isHidden ? "隐藏" : "恢复"} ${count} 封`,
      { count },
    ));
  })();
  return rows.length;
}

function purgeHiddenMessages(db, input) {
  const scope = accountScope(db, input?.accountId, { required: true });
  if (!Array.isArray(input?.ids)) {
    throw Object.assign(new Error("请选择要永久删除的邮件"), { status: 400 });
  }
  const ids = [...new Set(input.ids.map((value) => Number(value)))];
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw Object.assign(new Error("请选择有效的邮件"), { status: 400 });
  }
  if (ids.length > 5_000) throw Object.assign(new Error("单次最多永久删除 5000 封邮件"), { status: 400 });

  const placeholders = ids.map(() => "?").join(",");
  if (!scope.allAccounts) {
    const outside = db.prepare(`
      SELECT 1 FROM mail_messages WHERE id IN (${placeholders}) AND account_id != ? LIMIT 1
    `).get(...ids, scope.accountId);
    if (outside) throw Object.assign(new Error("所选邮件不属于指定的源头邮箱"), { status: 409 });
  }
  const rows = db.prepare(`
    SELECT id, account_id, fingerprint, subject
    FROM mail_messages
    WHERE id IN (${placeholders}) AND is_hidden = 1
  `).all(...ids);
  if (rows.length !== ids.length) {
    throw Object.assign(new Error("所选邮件已不在回收站，请刷新后重试"), { status: 409 });
  }

  const byAccount = new Map();
  const deleted = db.transaction(() => {
    const deletedAt = nowIso();
    const remember = db.prepare(`
      INSERT OR IGNORE INTO mail_message_tombstones (fingerprint, account_id, deleted_at)
      VALUES (?, ?, ?)
    `);
    const remove = db.prepare("DELETE FROM mail_messages WHERE id = ? AND is_hidden = 1");
    let count = 0;
    rows.forEach((row) => {
      remember.run(row.fingerprint, row.account_id, deletedAt);
      const result = remove.run(row.id);
      if (!result.changes) throw Object.assign(new Error("邮件已不在回收站"), { status: 409 });
      count += result.changes;
      byAccount.set(row.account_id, (byAccount.get(row.account_id) || 0) + result.changes);
    });
    byAccount.forEach((accountCount, sourceAccountId) => audit(
      db,
      sourceAccountId,
      "mail",
      "永久删除邮件",
      `共永久删除 ${accountCount} 封`,
      { count: accountCount },
    ));
    return count;
  })();
  return deleted;
}

export function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(projectRoot, "data"));
  const db = options.db || createDatabase({
    filename: options.databasePath || process.env.DATABASE_PATH || path.join(dataDir, "outlook-alias-hub.db"),
    seedDemo: options.seedDemo ?? process.env.SEED_DEMO === "true",
  });
  const graph = options.graph || new MicrosoftGraphClient({
    db,
    encryptionKey: process.env.DATA_ENCRYPTION_KEY,
    fetchFn: options.fetchFn,
  });
  const gmail = options.gmail || new GoogleGmailClient({
    db,
    encryptionKey: process.env.DATA_ENCRYPTION_KEY,
    fetchFn: options.googleFetchFn || options.fetchFn,
    clientId: options.googleClientId,
    clientSecret: options.googleClientSecret,
    redirectUri: options.googleRedirectUri,
  });
  const icloud = options.icloud || new ICloudImapClient({
    db,
    encryptionKey: options.dataEncryptionKey || process.env.DATA_ENCRYPTION_KEY,
    imapFactory: options.icloudImapFactory,
    parseMessage: options.icloudParseMessage,
  });
  const inbox = options.inbox || {
    scanInbox(account) {
      if (account.provider === "google") return gmail.scanInbox(account);
      if (account.provider === "microsoft") return graph.scanInbox(account);
      if (account.provider === "icloud") return icloud.scanInbox(account);
      throw Object.assign(new Error(`不支持的邮箱提供商：${account.provider}`), {
        status: 409,
        code: "UNSUPPORTED_MAIL_PROVIDER",
      });
    },
  };
  const extension = options.extension || new ExtensionService(db);
  const jobs = new JobRunner(db, inbox);
  const publicBaseUrl = options.publicBaseUrl || process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4180}`;
  const registrationClient = options.registrationClient || new RegistrationClient({
    baseUrl: process.env.REGISTRATION_SERVICE_URL,
    token: process.env.REGISTRATION_SERVICE_TOKEN,
    fetchFn: options.registrationFetchFn,
  });
  const registration = new RegistrationService({
    db,
    graph: inbox,
    client: registrationClient,
    publicBaseUrl,
    mailboxBaseUrl: process.env.REGISTRATION_MAILBOX_URL,
    browserUrl: process.env.REGISTRATION_BROWSER_URL,
  });
  const nfapi = options.nfapi || new NfapiService({
    db,
    registrationClient,
    encryptionKey: options.dataEncryptionKey || process.env.DATA_ENCRYPTION_KEY,
    fetchFn: options.nfapiFetchFn,
    agentIdentityFetchFn: options.agentIdentityFetchFn,
    agentIdentityRegistrar: options.agentIdentityRegistrar,
    agentIdentityVersion: options.agentIdentityVersion,
    agentIdentityPendingTtlMs: options.agentIdentityPendingTtlMs,
    baseUrl: options.nfapiBaseUrl || process.env.SUB2_BASE_URL || process.env.NFAPI_BASE_URL,
    apiKey: options.nfapiApiKey || process.env.SUB2_ADMIN_API_KEY || process.env.NFAPI_ADMIN_API_KEY,
  });
  const auth = createAuth({
    username: process.env.ADMIN_USERNAME ?? "admin",
    password: process.env.ADMIN_PASSWORD || "",
    secret: process.env.SESSION_SECRET || "",
    secure: publicBaseUrl.startsWith("https://"),
  });
  const app = express();

  db.prepare("UPDATE automation_jobs SET status = 'queued', message = '服务重启后恢复任务', updated_at = ? WHERE status = 'running' AND type = 'inbox_scan'").run(nowIso());
  db.prepare(`
    UPDATE automation_jobs SET status = 'waiting_user', message = '等待官网连接器连接微软别名页面',
      stop_reason = 'extension_required', updated_at = ?
    WHERE type = 'official_fill' AND status = 'queued'
  `).run(nowIso());
  jobs.schedule();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Cache-Control", req.path.startsWith("/api/") ? "no-store" : "no-cache");
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "outlook-alias-hub", time: nowIso() });
  });
  app.get("/api/auth/status", auth.status);
  app.get("/api/auth/check", auth.check);
  app.post("/api/auth/login", auth.login);
  app.post("/api/auth/logout", auth.logout);

  app.get("/api/extension/download", auth.requireAdmin, (_req, res, next) => {
    const archive = path.join(projectRoot, "release", "aliashub-outlook-extension.zip");
    if (!fs.existsSync(archive)) return next(Object.assign(new Error("浏览器扩展安装包尚未生成"), { status: 404 }));
    return res.download(archive, "aliashub-outlook-extension.zip");
  });

  app.use("/api/extension", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-AliasHub-Extension-Key");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    return extension.requireKey(req, res, next);
  });
  app.get("/api/extension/status", (_req, res) => res.json({ ok: true, service: "AliasHub 官方别名连接器" }));
  app.get("/api/extension/accounts", (_req, res) => res.json({ items: extension.accounts() }));
  app.get("/api/extension/tasks", (req, res) => res.json({ task: extension.claimTask(req.query.email) }));
  app.post("/api/extension/tasks/:id/report", (req, res, next) => {
    try { res.json({ job: publicJob(extension.report(req.params.id, req.body)) }); } catch (error) { next(error); }
  });
  app.post("/api/extension/sync", (req, res, next) => {
    try { res.json(extension.syncAliases(req.body?.email, req.body?.aliases)); } catch (error) { next(error); }
  });

  app.use("/api/external", registration.requireConnectorKey.bind(registration));
  app.get("/api/external/accounts", (req, res, next) => {
    try { res.json(registration.externalAccounts(req.query)); } catch (error) { next(error); }
  });
  app.get("/api/external/emails", async (req, res, next) => {
    try { res.json(await registration.externalEmails(req.query)); } catch (error) { next(error); }
  });

  app.use("/api", auth.requireAdmin);

  app.get("/api/registration/options", async (_req, res, next) => {
    try { res.json(await registration.options()); } catch (error) { next(error); }
  });
  app.put("/api/registration/proxies", (req, res, next) => {
    try { res.json(registration.saveProxyPool(req.body?.proxies)); } catch (error) { next(error); }
  });
  app.post("/api/registration/proxies/inspect", async (req, res, next) => {
    try { res.json(await registration.inspectProxy(req.body || {})); } catch (error) { next(error); }
  });
  app.post("/api/registration/jobs", async (req, res, next) => {
    try { res.status(202).json({ items: await registration.createJobs(req.body || {}) }); } catch (error) { next(error); }
  });
  app.get("/api/registration/jobs", async (req, res, next) => {
    try { res.json({ items: await registration.listJobs(req.query) }); } catch (error) { next(error); }
  });
  app.post("/api/registration/jobs/:id/cancel", async (req, res, next) => {
    try { res.json({ item: await registration.cancelJob(req.params.id) }); } catch (error) { next(error); }
  });
  app.post("/api/registration/jobs/:id/release", async (req, res, next) => {
    try { res.json(await registration.releaseJob(req.params.id)); } catch (error) { next(error); }
  });
  app.delete("/api/registration/jobs/:id", (req, res, next) => {
    try { res.json(registration.deleteJob(req.params.id)); } catch (error) { next(error); }
  });
  app.post("/api/registration/jobs/bulk-delete", (req, res, next) => {
    try { res.json(registration.deleteJobs(req.body || {})); } catch (error) { next(error); }
  });
  app.get("/api/registration/jobs/:id/events", async (req, res, next) => {
    try { res.json({ items: await registration.taskEvents(req.params.id) }); } catch (error) { next(error); }
  });
  app.get("/api/registration/accounts", async (_req, res, next) => {
    try { res.json(await registration.listRegisteredAccounts()); } catch (error) { next(error); }
  });
  app.post("/api/registration/accounts/refresh-status", async (req, res, next) => {
    try { res.json(await registration.refreshRegisteredAccountSignals(req.body || {})); } catch (error) { next(error); }
  });
  app.patch("/api/registration/accounts/:id", async (req, res, next) => {
    try { res.json(await registration.updateRegisteredAccountMetadata(req.params.id, req.body || {})); } catch (error) { next(error); }
  });
  app.get("/api/registration/accounts/:id/access-token", async (req, res, next) => {
    try { res.json(await registration.registeredAccountAccessToken(req.params.id)); } catch (error) { next(error); }
  });
  app.get("/api/registration/accounts/:id/emails", async (req, res, next) => {
    try { res.json(await registration.registeredAccountEmails(req.params.id, req.query)); } catch (error) { next(error); }
  });
  app.delete("/api/registration/accounts/:id", async (req, res, next) => {
    try { res.json(await registration.deleteRegisteredAccounts({ ids: [req.params.id] })); } catch (error) { next(error); }
  });
  app.post("/api/registration/accounts/bulk-delete", async (req, res, next) => {
    try { res.json(await registration.deleteRegisteredAccounts(req.body || {})); } catch (error) { next(error); }
  });
  app.post("/api/registration/accounts/:id/set-password", async (req, res, next) => {
    try { res.status(202).json(await registration.startPasswordSetup(req.params.id, req.body || {})); } catch (error) { next(error); }
  });
  app.get("/api/registration/accounts/:id/set-password/:taskId", async (req, res, next) => {
    try { res.json(await registration.passwordSetupStatus(req.params.id, req.params.taskId)); } catch (error) { next(error); }
  });
  app.post("/api/registration/accounts/:id/set-password/:taskId/cancel", async (req, res, next) => {
    try { res.json(await registration.cancelPasswordSetup(req.params.id, req.params.taskId)); } catch (error) { next(error); }
  });
  app.post("/api/registration/accounts/:id/nfapi-oauth/start", async (req, res, next) => {
    try {
      res.status(201).json(await nfapi.startOAuthImport({
        id: req.params.id,
        options: req.body?.options || {},
        save_defaults: req.body?.save_defaults,
        force_restart: req.body?.force_restart,
      }));
    } catch (error) { next(error); }
  });
  app.post("/api/registration/accounts/:id/nfapi-oauth/:sessionId/complete", async (req, res, next) => {
    try { res.json(await nfapi.completeOAuthImport(req.params.sessionId, req.body?.callback_url, req.params.id)); } catch (error) { next(error); }
  });
  app.post("/api/registration/accounts/:id/nfapi-agent-identity/import", async (req, res, next) => {
    try {
      res.json(await nfapi.importAgentIdentity({
        id: req.params.id,
        options: req.body && Object.hasOwn(req.body, "options") ? req.body.options : {},
        save_defaults: req.body?.save_defaults,
      }));
    } catch (error) { next(error); }
  });
  app.post("/api/registration/accounts/import-nfapi", async (req, res, next) => {
    next(Object.assign(new Error("SUB2 兼容服务已改为逐账号 Agent Identity 或 OAuth 导入，请使用对应的添加账号入口"), { status: 410 }));
  });

  app.get("/api/nfapi/config", (_req, res, next) => {
    try { res.json(nfapi.configuration()); } catch (error) { next(error); }
  });
  app.patch("/api/nfapi/config", (req, res, next) => {
    try { res.json(nfapi.updateConfiguration(req.body || {})); } catch (error) { next(error); }
  });
  app.post("/api/nfapi/test", async (req, res, next) => {
    try {
      if (req.body && Object.keys(req.body).length) nfapi.updateConfiguration(req.body);
      res.json(await nfapi.testConnection());
    } catch (error) { next(error); }
  });
  app.get("/api/nfapi/options", async (_req, res, next) => {
    try { res.json(await nfapi.options()); } catch (error) { next(error); }
  });

  app.post("/api/microsoft/oauth/start", async (req, res, next) => {
    try { res.status(201).json(await graph.startAuthorization({ accountId: req.body?.accountId })); }
    catch (error) { next(error); }
  });

  app.post("/api/microsoft/oauth/:sessionId/complete", async (req, res, next) => {
    try { res.json(await graph.completeAuthorization(req.params.sessionId, req.body?.callbackUrl)); }
    catch (error) { next(error); }
  });

  app.post("/api/google/oauth/start", async (req, res, next) => {
    try { res.status(201).json(await gmail.startAuthorization({ accountId: req.body?.accountId })); }
    catch (error) { next(error); }
  });

  app.post("/api/google/oauth/:sessionId/complete", async (req, res, next) => {
    try { res.json(await gmail.completeAuthorization(req.params.sessionId, req.body?.callbackUrl)); }
    catch (error) { next(error); }
  });

  app.post("/api/icloud/connect", async (req, res, next) => {
    try {
      if (["host", "port", "server", "secure"].some((key) => Object.hasOwn(req.body || {}, key))) {
        throw Object.assign(new Error("iCloud IMAP 服务地址由系统固定配置，不能自定义"), { status: 400 });
      }
      const reconnecting = Boolean(req.body?.accountId);
      const result = await icloud.connectAccount({
        accountId: req.body?.accountId,
        email: req.body?.email,
        displayName: req.body?.displayName,
        appSpecificPassword: req.body?.appSpecificPassword,
      });
      res.status(reconnecting ? 200 : 201).json(result);
    } catch (error) { next(error); }
  });

  app.get("/api/overview", (_req, res) => {
    const accounts = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'connected' THEN 1 ELSE 0 END) AS connected,
        SUM(CASE WHEN status = 'action_required' THEN 1 ELSE 0 END) AS action_required
      FROM source_accounts
    `).get();
    const addresses = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN kind = 'official' THEN 1 ELSE 0 END) AS official,
        SUM(CASE WHEN kind = 'split' THEN 1 ELSE 0 END) AS split
      FROM addresses WHERE status = 'active'
    `).get();
    const codes = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN is_used = 0 THEN 1 ELSE 0 END) AS unused FROM verification_codes WHERE is_hidden = 0").get();
    const recentAccounts = db.prepare("SELECT * FROM source_accounts ORDER BY updated_at DESC LIMIT 6").all().map((row) => publicAccount(db, row));
    const recentCodes = db.prepare(`
      SELECT verification_codes.*, source_accounts.email AS source_email, addresses.address, addresses.kind,
        parent.address AS parent_address
      FROM verification_codes
      JOIN source_accounts ON source_accounts.id = verification_codes.account_id
      LEFT JOIN addresses ON addresses.id = verification_codes.address_id
      LEFT JOIN addresses parent ON parent.id = addresses.parent_address_id
      WHERE verification_codes.is_hidden = 0
      ORDER BY verification_codes.received_at DESC LIMIT 6
    `).all().map((row) => ({ ...row, is_used: Boolean(row.is_used), is_hidden: Boolean(row.is_hidden) }));
    const activeJobs = db.prepare("SELECT automation_jobs.*, source_accounts.email AS source_email FROM automation_jobs JOIN source_accounts ON source_accounts.id = automation_jobs.account_id WHERE automation_jobs.status IN ('queued', 'running', 'waiting_user', 'limited') ORDER BY automation_jobs.created_at DESC LIMIT 6").all().map(publicJob);
    const activity = db.prepare("SELECT audit_log.*, source_accounts.email AS source_email FROM audit_log LEFT JOIN source_accounts ON source_accounts.id = audit_log.account_id ORDER BY audit_log.created_at DESC LIMIT 8").all().map((row) => ({ ...row, metadata: parseJson(row.metadata) }));
    res.json({
      metrics: {
        accounts: accounts.total || 0,
        connectedAccounts: accounts.connected || 0,
        actionRequired: accounts.action_required || 0,
        addresses: addresses.total || 0,
        officialAliases: addresses.official || 0,
        splitAddresses: addresses.split || 0,
        codes: codes.total || 0,
        unusedCodes: codes.unused || 0,
      },
      recentAccounts,
      recentCodes,
      activeJobs,
      activity,
    });
  });

  app.get("/api/accounts", (_req, res) => {
    const items = db.prepare("SELECT * FROM source_accounts ORDER BY created_at DESC").all().map((row) => {
      const latestJob = db.prepare("SELECT * FROM automation_jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT 1").get(row.id);
      return { ...publicAccount(db, row), latest_job: publicJob(latestJob) };
    });
    res.json({
      items,
      supportedDomains: microsoftDomains,
      providers: {
        microsoft: { authMode: "oauth", supportsOfficialAliases: true, supportsPlusAliases: true, supportsImportedAliases: false, supportsDirectRegistration: false },
        google: { authMode: "oauth", supportsOfficialAliases: false, supportsPlusAliases: true, supportsImportedAliases: false, supportsDirectRegistration: false },
        icloud: { authMode: "app_password", supportsOfficialAliases: false, supportsPlusAliases: false, supportsImportedAliases: true, supportsDirectRegistration: true },
      },
    });
  });

  app.post("/api/accounts", async (req, res, next) => {
    let account;
    try {
      const email = normalizeMicrosoftEmail(req.body?.email);
      if (!email) throw Object.assign(new Error("首版支持 Outlook、Hotmail、Live 和 MSN 邮箱"), { status: 400 });
      const existing = db.prepare("SELECT * FROM source_accounts WHERE email = ? COLLATE NOCASE").get(email);
      if (existing) throw Object.assign(new Error("这个源头邮箱已经添加"), { status: 409 });
      account = createSourceAccount(db, { email, displayName: String(req.body?.displayName || "").trim() });
      const loginState = { stage: "not_started", message: "源头邮箱已添加，请打开微软官方登录页面" };
      res.status(201).json({ account: publicAccount(db, db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id)), loginState });
    } catch (error) {
      if (account && error.status >= 500) db.prepare("UPDATE source_accounts SET status = 'error', updated_at = ? WHERE id = ?").run(nowIso(), account.id);
      next(error);
    }
  });

  app.get("/api/accounts/:id", (req, res, next) => {
    try {
      const row = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(req.params.id));
      if (!row) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
      const bases = db.prepare("SELECT * FROM addresses WHERE account_id = ? AND kind IN ('primary', 'official') ORDER BY kind = 'primary' DESC, created_at").all(row.id);
      const latestJobs = db.prepare("SELECT * FROM automation_jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT 10").all(row.id).map(publicJob);
      res.json({ account: publicAccount(db, row), baseAddresses: bases, jobs: latestJobs });
    } catch (error) { next(error); }
  });

  app.patch("/api/accounts/:id", (req, res, next) => {
    try {
      const row = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(req.params.id));
      if (!row) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
      db.prepare("UPDATE source_accounts SET display_name = ?, updated_at = ? WHERE id = ?").run(req.body?.displayName ?? row.display_name, nowIso(), row.id);
      res.json({ account: publicAccount(db, db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(row.id)) });
    } catch (error) { next(error); }
  });

  app.delete("/api/accounts/:id", async (req, res, next) => {
    try {
      const row = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(req.params.id));
      if (!row) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
      db.prepare("DELETE FROM source_accounts WHERE id = ?").run(row.id);
      res.status(204).end();
    } catch (error) { next(error); }
  });

  app.post("/api/accounts/:id/sync", (req, res, next) => {
    try {
      const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(req.params.id));
      if (!account) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
      requireMicrosoftAccount(account);
      const items = db.prepare("SELECT * FROM addresses WHERE account_id = ? AND kind IN ('primary', 'official') ORDER BY kind = 'primary' DESC, created_at").all(account.id);
      const launch = extension.setTarget(account.id);
      return res.json({ items, officialUrl: launch.officialUrl, message: "微软官网打开后由 AliasHub 扩展同步" });
    } catch (error) { return next(error); }
  });

  app.post("/api/accounts/:id/official-launch", (req, res, next) => {
    try {
      const launch = extension.setTarget(Number(req.params.id));
      return res.json({ officialUrl: launch.officialUrl, accountId: launch.account.id, email: launch.account.email });
    } catch (error) { return next(error); }
  });

  app.post("/api/accounts/:id/official-aliases/import", (req, res, next) => {
    try {
      const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(req.params.id));
      if (!account) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
      requireMicrosoftAccount(account);
      const input = Array.isArray(req.body?.aliases) ? req.body.aliases : [];
      const invalid = input.map((value) => String(value || "").trim()).filter((value) => value && !normalizeMicrosoftEmail(value));
      if (invalid.length) throw Object.assign(new Error(`不支持的别名：${invalid[0]}`), { status: 400 });
      const known = db.prepare(`
        SELECT address FROM addresses
        WHERE account_id = ? AND kind IN ('primary', 'official') AND status = 'active'
      `).all(account.id).map((item) => item.address.toLowerCase());
      const aliases = [...new Set([...known, account.email, ...input.map(normalizeMicrosoftEmail).filter(Boolean)])];
      if (aliases.length > account.official_limit) {
        throw Object.assign(new Error(`这个账号最多登记 ${account.official_limit} 个基础地址`), { status: 400 });
      }
      const items = syncOfficialAddresses(db, account, aliases);
      res.json({ items, account: publicAccount(db, db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id)) });
    } catch (error) { next(error); }
  });

  app.post("/api/accounts/:id/icloud-aliases/import", (req, res, next) => {
    try {
      const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(req.params.id));
      if (!account) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
      if (account.provider !== "icloud") {
        throw Object.assign(new Error("这个源头邮箱不是 iCloud 账号"), { status: 409, code: "ICLOUD_ACCOUNT_REQUIRED" });
      }
      const input = Array.isArray(req.body?.aliases) ? req.body.aliases : [];
      const invalid = input.map((value) => String(value || "").trim()).filter((value) => value && !normalizeIcloudAliasEmail(value));
      if (invalid.length) {
        throw Object.assign(new Error(`仅支持 @icloud.com、@me.com、@mac.com 或 @privaterelay.appleid.com 地址：${invalid[0]}`), { status: 400 });
      }
      const items = importIcloudAliases(db, account, input);
      res.json({
        items,
        account: publicAccount(db, db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id)),
      });
    } catch (error) { next(error); }
  });

  app.post("/api/accounts/:id/official-fill", (req, res, next) => {
    try {
      const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(req.params.id));
      if (!account) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
      requireMicrosoftAccount(account);
      if (account.status !== "connected") throw Object.assign(new Error("请先完成这个源头邮箱的微软登录"), { status: 409 });
      const existing = db.prepare("SELECT * FROM automation_jobs WHERE account_id = ? AND type = 'official_fill' AND status IN ('queued', 'running', 'waiting_user') ORDER BY created_at DESC LIMIT 1").get(account.id);
      if (existing) return res.status(409).json({ error: "这个账号已有官方别名任务正在执行", job: publicJob(existing) });
      const config = {
        prefix: String(req.body?.prefix || ""),
        mode: ["random", "readable", "sequence"].includes(req.body?.mode) ? req.body.mode : "random",
        label: String(req.body?.label || "微软官方别名"),
        purpose: String(req.body?.purpose || ""),
      };
      const target = Math.max(0, account.official_limit - publicAccount(db, account).official_used);
      let job = jobs.createJob(account.id, "official_fill", config, target);
      if (!target) {
        jobs.updateJob(job.id, { status: "completed", message: "官方别名已经达到上限", finished_at: nowIso() });
        job = jobs.getJob(job.id);
      } else {
        jobs.updateJob(job.id, { status: "waiting_user", message: "等待官网连接器连接微软别名页面", stop_reason: "extension_required" });
        job = jobs.getJob(job.id);
      }
      const launch = extension.setTarget(account.id, job.id);
      res.status(202).json({ job, officialUrl: launch.officialUrl, extensionDownload: "/api/extension/download" });
    } catch (error) { next(error); }
  });

  app.post("/api/accounts/:id/splits", (req, res, next) => {
    try {
      const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(req.params.id));
      if (!account) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
      if (!publicAccount(db, account).supports_plus_aliases) {
        throw Object.assign(new Error("这个邮箱提供商不支持 Plus 分裂地址"), { status: 409 });
      }
      const items = generateSplits(db, account, req.body || {});
      res.status(201).json({ items, count: items.length });
    } catch (error) { next(error); }
  });

  const queueInboxScan = (accountId) => {
    const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(accountId));
    if (!account) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
    if (account.status !== "connected") throw Object.assign(new Error("请先完成这个源头邮箱的连接验证"), { status: 409 });
    const existing = db.prepare("SELECT * FROM automation_jobs WHERE account_id = ? AND type = 'inbox_scan' AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1").get(account.id);
    if (existing) return { existing: publicJob(existing), job: null };
    return { existing: null, job: jobs.createJob(account.id, "inbox_scan", {}, 0) };
  };

  const scanAccountInbox = (req, res, next) => {
    try {
      const queued = queueInboxScan(req.params.id);
      if (queued.existing) return res.status(409).json({ error: "这个账号正在扫描收件箱", job: queued.existing });
      return res.status(202).json({ job: queued.job });
    } catch (error) { next(error); }
  };

  app.post("/api/accounts/:id/scan-inbox", scanAccountInbox);
  app.post("/api/accounts/:id/scan-codes", scanAccountInbox);

  app.post("/api/messages/scan", (req, res, next) => {
    try {
      const scope = accountScope(db, req.body?.accountId, { required: true });
      if (!scope.allAccounts) {
        const queued = queueInboxScan(scope.accountId);
        if (queued.existing) return res.status(409).json({ error: "这个账号正在扫描收件箱", job: queued.existing });
        return res.status(202).json({ job: queued.job, jobs: [queued.job], skipped: [] });
      }
      const accounts = db.prepare("SELECT id FROM source_accounts WHERE status = 'connected' ORDER BY id").all();
      const queuedJobs = [];
      const skipped = [];
      accounts.forEach((account) => {
        const queued = queueInboxScan(account.id);
        if (queued.existing) skipped.push(queued.existing);
        else queuedJobs.push(queued.job);
      });
      return res.status(202).json({ jobs: queuedJobs, skipped });
    } catch (error) { return next(error); }
  });

  app.get("/api/addresses", (req, res) => {
    res.json(addressQuery(db, {
      accountId: req.query.accountId,
      kind: req.query.kind,
      q: req.query.q,
      page: positive(req.query.page, 1, 10_000),
      limit: positive(req.query.limit, 50, 200),
    }));
  });

  app.patch("/api/addresses/:id", (req, res, next) => {
    try {
      const item = db.prepare("SELECT * FROM addresses WHERE id = ?").get(Number(req.params.id));
      if (!item) throw Object.assign(new Error("地址不存在"), { status: 404 });
      const status = req.body?.status && ["active", "disabled"].includes(req.body.status) ? req.body.status : item.status;
      db.prepare("UPDATE addresses SET label = ?, purpose = ?, status = ?, updated_at = ? WHERE id = ?")
        .run(req.body?.label ?? item.label, req.body?.purpose ?? item.purpose, status, nowIso(), item.id);
      res.json({ item: db.prepare("SELECT * FROM addresses WHERE id = ?").get(item.id) });
    } catch (error) { next(error); }
  });

  app.post("/api/addresses/bulk-delete", (req, res, next) => {
    try {
      const accountId = req.body?.accountId && req.body.accountId !== "all" ? Number(req.body.accountId) : null;
      if (accountId && !db.prepare("SELECT 1 FROM source_accounts WHERE id = ?").get(accountId)) {
        throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
      }
      res.json(deleteSplitAddresses(db, {
        ids: req.body?.ids,
        accountId,
        all: req.body?.mode === "all",
      }));
    } catch (error) { next(error); }
  });

  app.delete("/api/addresses/:id", (req, res, next) => {
    try {
      const item = db.prepare(`
        SELECT addresses.*, source_accounts.provider AS source_provider
        FROM addresses JOIN source_accounts ON source_accounts.id = addresses.account_id
        WHERE addresses.id = ?
      `).get(Number(req.params.id));
      if (!item) return res.status(204).end();
      const importedIcloudAddress = item.source_provider === "icloud"
        && item.kind === "official"
        && isIcloudImportedStrategy(item.strategy);
      if (item.kind !== "split" && !importedIcloudAddress) {
        throw Object.assign(new Error("源头号和官方别名需要在对应邮箱官网删除"), { status: 409 });
      }
      db.prepare("DELETE FROM addresses WHERE id = ?").run(item.id);
      audit(
        db,
        item.account_id,
        importedIcloudAddress ? "alias" : "split",
        importedIcloudAddress ? "移除本地 iCloud 别名映射" : "删除分裂地址",
        item.address,
        {},
      );
      res.status(204).end();
    } catch (error) { next(error); }
  });

  app.get("/api/jobs", (req, res) => {
    const conditions = [];
    const params = [];
    if (req.query.accountId) { conditions.push("automation_jobs.account_id = ?"); params.push(Number(req.query.accountId)); }
    if (req.query.status) { conditions.push("automation_jobs.status = ?"); params.push(req.query.status); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const items = db.prepare(`SELECT automation_jobs.*, source_accounts.email AS source_email FROM automation_jobs JOIN source_accounts ON source_accounts.id = automation_jobs.account_id ${where} ORDER BY automation_jobs.created_at DESC LIMIT 100`).all(...params).map(publicJob);
    res.json({ items });
  });

  app.get("/api/jobs/:id", (req, res, next) => {
    const job = jobs.getJob(Number(req.params.id));
    if (!job) return next(Object.assign(new Error("任务不存在"), { status: 404 }));
    return res.json({ job });
  });

  app.post("/api/jobs/:id/cancel", (req, res, next) => {
    try {
      const job = db.prepare("SELECT * FROM automation_jobs WHERE id = ?").get(Number(req.params.id));
      if (!job) throw Object.assign(new Error("任务不存在"), { status: 404 });
      if (!["queued", "running", "waiting_user", "limited"].includes(job.status)) return res.json({ job: publicJob(job) });
      const now = nowIso();
      db.prepare("UPDATE automation_jobs SET status = 'cancelled', message = '任务已取消', stop_reason = 'cancelled_by_user', finished_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, job.id);
      audit(db, job.account_id, "job", "取消任务", `任务 #${job.id}`, { type: job.type });
      return res.json({ job: publicJob(db.prepare("SELECT * FROM automation_jobs WHERE id = ?").get(job.id)) });
    } catch (error) { return next(error); }
  });

  app.post("/api/jobs/:id/official-launch", (req, res, next) => {
    try {
      const job = db.prepare("SELECT * FROM automation_jobs WHERE id = ? AND type = 'official_fill'").get(Number(req.params.id));
      if (!job) throw Object.assign(new Error("官方别名任务不存在"), { status: 404 });
      const launch = extension.setTarget(job.account_id, job.id);
      return res.json({ officialUrl: launch.officialUrl, accountId: launch.account.id, email: launch.account.email });
    } catch (error) { return next(error); }
  });

  app.get("/api/messages", (req, res, next) => {
    try {
      return res.json(messageQuery(db, {
        accountId: req.query.accountId,
        q: req.query.q,
        hidden: req.query.hidden === "true",
        page: positive(req.query.page, 1, 10_000),
        limit: positive(req.query.limit, 50, 200),
      }));
    } catch (error) { return next(error); }
  });

  app.get("/api/messages/:id", (req, res, next) => {
    try {
      const item = messageById(db, req.params.id);
      if (!item) throw Object.assign(new Error("邮件不存在"), { status: 404 });
      return res.json({ item });
    } catch (error) { return next(error); }
  });

  app.patch("/api/messages/:id", (req, res, next) => {
    try {
      const item = db.prepare("SELECT * FROM mail_messages WHERE id = ?").get(Number(req.params.id));
      if (!item) throw Object.assign(new Error("邮件不存在"), { status: 404 });
      if (typeof req.body?.isHidden !== "boolean") {
        throw Object.assign(new Error("isHidden 必须是布尔值"), { status: 400 });
      }
      const isHidden = req.body.isHidden ? 1 : 0;
      if (isHidden !== item.is_hidden) {
        db.prepare("UPDATE mail_messages SET is_hidden = ?, updated_at = ? WHERE id = ?").run(isHidden, nowIso(), item.id);
        audit(db, item.account_id, "mail", isHidden ? "隐藏邮件" : "恢复邮件", item.subject, { messageId: item.id });
      }
      return res.json({ ok: true, item: messageById(db, item.id) });
    } catch (error) { return next(error); }
  });

  app.post("/api/messages/hide", (req, res, next) => {
    try { return res.json({ hidden: setMessagesHidden(db, req.body || {}, true) }); }
    catch (error) { return next(error); }
  });

  app.post("/api/messages/restore", (req, res, next) => {
    try { return res.json({ restored: setMessagesHidden(db, req.body || {}, false) }); }
    catch (error) { return next(error); }
  });

  app.post("/api/messages/purge-hidden", (req, res, next) => {
    try { return res.json({ deleted: purgeHiddenMessages(db, req.body || {}) }); }
    catch (error) { return next(error); }
  });

  app.get("/api/codes", (req, res, next) => {
    try {
      if (req.query.unused === "true" && req.query.used === "true") {
        throw Object.assign(new Error("不能同时筛选未使用和已使用验证码"), { status: 400 });
      }
      const conditions = ["1 = 1"];
      const params = [];
      if (req.query.accountId) { conditions.push("verification_codes.account_id = ?"); params.push(Number(req.query.accountId)); }
      if (req.query.q) {
        conditions.push("(verification_codes.code LIKE ? OR verification_codes.sender LIKE ? OR verification_codes.subject LIKE ? OR source_accounts.email LIKE ? OR addresses.address LIKE ?)");
        const term = `%${req.query.q}%`;
        params.push(term, term, term, term, term);
      }
      const baseWhere = conditions.join(" AND ");
      const itemConditions = [...conditions];
      if (req.query.hidden === "true") itemConditions.push("verification_codes.is_hidden = 1");
      else {
        itemConditions.push("verification_codes.is_hidden = 0");
        if (req.query.unused === "true") itemConditions.push("verification_codes.is_used = 0");
        if (req.query.used === "true") itemConditions.push("verification_codes.is_used = 1");
      }
      const items = db.prepare(`
        SELECT verification_codes.*, source_accounts.email AS source_email,
          addresses.address, addresses.kind AS address_kind, parent.address AS parent_address
        FROM verification_codes
        JOIN source_accounts ON source_accounts.id = verification_codes.account_id
        LEFT JOIN addresses ON addresses.id = verification_codes.address_id
        LEFT JOIN addresses parent ON parent.id = addresses.parent_address_id
        WHERE ${itemConditions.join(" AND ")}
        ORDER BY verification_codes.received_at DESC LIMIT 200
      `).all(...params).map((row) => ({ ...row, is_used: Boolean(row.is_used), is_hidden: Boolean(row.is_hidden) }));
      const counts = db.prepare(`
        SELECT
          SUM(CASE WHEN verification_codes.is_hidden = 0 THEN 1 ELSE 0 END) AS total,
          SUM(CASE WHEN verification_codes.is_hidden = 0 AND verification_codes.is_used = 0 THEN 1 ELSE 0 END) AS unused,
          SUM(CASE WHEN verification_codes.is_hidden = 0 AND verification_codes.is_used = 1 THEN 1 ELSE 0 END) AS used,
          SUM(CASE WHEN verification_codes.is_hidden = 1 THEN 1 ELSE 0 END) AS hidden
        FROM verification_codes
        JOIN source_accounts ON source_accounts.id = verification_codes.account_id
        LEFT JOIN addresses ON addresses.id = verification_codes.address_id
        WHERE ${baseWhere}
      `).get(...params);
      res.json({ items, total: counts.total || 0, unused: counts.unused || 0, used: counts.used || 0, hidden: counts.hidden || 0 });
    } catch (error) { next(error); }
  });

  app.post("/api/codes/mark-used", (req, res, next) => {
    try {
      const scope = accountScope(db, req.body?.accountId, { required: true });
      if (req.body?.q !== undefined && typeof req.body.q !== "string") {
        throw Object.assign(new Error("q 必须是字符串"), { status: 400 });
      }
      const query = String(req.body?.q || "").trim();
      if (query.length > 200) throw Object.assign(new Error("搜索关键词最多 200 个字符"), { status: 400 });

      const conditions = ["verification_codes.is_hidden = 0", "verification_codes.is_used = 0"];
      const params = [];
      if (!scope.allAccounts) {
        conditions.push("verification_codes.account_id = ?");
        params.push(scope.accountId);
      }
      if (query) {
        conditions.push("(verification_codes.code LIKE ? OR verification_codes.sender LIKE ? OR verification_codes.subject LIKE ? OR source_accounts.email LIKE ? OR addresses.address LIKE ?)");
        const term = `%${query}%`;
        params.push(term, term, term, term, term);
      }
      const where = conditions.join(" AND ");
      const marked = db.transaction(() => {
        const rows = db.prepare(`
          SELECT verification_codes.id, verification_codes.account_id
          FROM verification_codes
          JOIN source_accounts ON source_accounts.id = verification_codes.account_id
          LEFT JOIN addresses ON addresses.id = verification_codes.address_id
          WHERE ${where}
        `).all(...params);
        if (!rows.length) return 0;

        const mark = db.prepare("UPDATE verification_codes SET is_used = 1, is_hidden = 1 WHERE id = ? AND is_used = 0 AND is_hidden = 0");
        const byAccount = new Map();
        let count = 0;
        rows.forEach((row) => {
          const result = mark.run(row.id);
          if (!result.changes) return;
          count += result.changes;
          byAccount.set(row.account_id, (byAccount.get(row.account_id) || 0) + result.changes);
        });
        byAccount.forEach((accountCount, sourceAccountId) => audit(
          db,
          sourceAccountId,
          "code",
          "批量标记验证码已用",
          `共标记 ${accountCount} 条`,
          { count: accountCount, filtered: Boolean(query) },
        ));
        return count;
      })();
      res.json({ marked });
    } catch (error) { next(error); }
  });

  app.post("/api/codes/hide-used", (req, res, next) => {
    try {
      const requestedAccountId = req.body?.accountId;
      const allAccounts = requestedAccountId === "all";
      let accountId = null;
      if (!allAccounts) {
        if (typeof requestedAccountId === "number") accountId = requestedAccountId;
        else if (typeof requestedAccountId === "string" && /^[1-9]\d*$/.test(requestedAccountId)) accountId = Number(requestedAccountId);
        if (!Number.isSafeInteger(accountId) || accountId <= 0) {
          throw Object.assign(new Error("请选择有效的源头邮箱"), { status: 400 });
        }
      }
      if (!allAccounts && !db.prepare("SELECT 1 FROM source_accounts WHERE id = ?").get(accountId)) {
        throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
      }
      const where = `${allAccounts ? "" : "account_id = ? AND "}is_used = 1 AND is_hidden = 0`;
      const params = allAccounts ? [] : [accountId];
      const hidden = db.transaction(() => {
        const byAccount = db.prepare(`
          SELECT account_id, COUNT(*) AS count
          FROM verification_codes
          WHERE ${where}
          GROUP BY account_id
        `).all(...params);
        const result = db.prepare(`UPDATE verification_codes SET is_hidden = 1 WHERE ${where}`).run(...params);
        byAccount.forEach((row) => audit(db, row.account_id, "code", "隐藏已用验证码", `共隐藏 ${row.count} 条`, { count: row.count }));
        return result.changes;
      })();
      res.json({ hidden });
    } catch (error) { next(error); }
  });

  app.post("/api/codes/purge-hidden", (req, res, next) => {
    try {
      const scope = accountScope(db, req.body?.accountId, { required: true });
      if (req.body?.q !== undefined && typeof req.body.q !== "string") {
        throw Object.assign(new Error("q 必须是字符串"), { status: 400 });
      }
      const query = String(req.body?.q || "").trim();
      if (query.length > 200) throw Object.assign(new Error("搜索关键词最多 200 个字符"), { status: 400 });
      const conditions = ["verification_codes.is_hidden = 1"];
      const params = [];
      if (!scope.allAccounts) {
        conditions.push("verification_codes.account_id = ?");
        params.push(scope.accountId);
      }
      if (query) {
        conditions.push("(verification_codes.code LIKE ? OR verification_codes.sender LIKE ? OR verification_codes.subject LIKE ? OR source_accounts.email LIKE ? OR addresses.address LIKE ?)");
        const term = `%${query}%`;
        params.push(term, term, term, term, term);
      }
      const deleted = db.transaction(() => {
        const rows = db.prepare(`
          SELECT verification_codes.id, verification_codes.account_id, verification_codes.fingerprint
          FROM verification_codes
          JOIN source_accounts ON source_accounts.id = verification_codes.account_id
          LEFT JOIN addresses ON addresses.id = verification_codes.address_id
          WHERE ${conditions.join(" AND ")}
        `).all(...params);
        if (!rows.length) return 0;
        const remember = db.prepare(`
          INSERT OR IGNORE INTO verification_code_tombstones (fingerprint, account_id, deleted_at)
          VALUES (?, ?, ?)
        `);
        const remove = db.prepare("DELETE FROM verification_codes WHERE id = ? AND is_hidden = 1");
        const byAccount = new Map();
        let count = 0;
        const deletedAt = nowIso();
        rows.forEach((row) => {
          remember.run(row.fingerprint, row.account_id, deletedAt);
          const result = remove.run(row.id);
          if (!result.changes) return;
          count += result.changes;
          byAccount.set(row.account_id, (byAccount.get(row.account_id) || 0) + result.changes);
        });
        byAccount.forEach((accountCount, sourceAccountId) => audit(
          db,
          sourceAccountId,
          "code",
          "清空验证码回收站",
          `共永久删除 ${accountCount} 条`,
          { count: accountCount, filtered: Boolean(query) },
        ));
        return count;
      })();
      res.json({ deleted });
    } catch (error) { next(error); }
  });

  app.delete("/api/codes/:id", (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw Object.assign(new Error("请选择有效的验证码"), { status: 400 });
      }
      const item = db.prepare("SELECT * FROM verification_codes WHERE id = ?").get(id);
      if (!item) throw Object.assign(new Error("验证码不存在"), { status: 404 });
      if (!item.is_hidden) throw Object.assign(new Error("只能永久删除回收站中的验证码"), { status: 409 });
      const deleted = db.transaction(() => {
        db.prepare(`
          INSERT OR IGNORE INTO verification_code_tombstones (fingerprint, account_id, deleted_at)
          VALUES (?, ?, ?)
        `).run(item.fingerprint, item.account_id, nowIso());
        const result = db.prepare("DELETE FROM verification_codes WHERE id = ? AND is_hidden = 1").run(item.id);
        if (!result.changes) throw Object.assign(new Error("验证码已不在回收站"), { status: 409 });
        audit(db, item.account_id, "code", "永久删除验证码", "已永久删除 1 条", { count: 1, codeId: item.id });
        return result.changes;
      })();
      res.json({ deleted });
    } catch (error) { next(error); }
  });

  app.patch("/api/codes/:id", (req, res, next) => {
    try {
      const item = db.prepare("SELECT * FROM verification_codes WHERE id = ?").get(Number(req.params.id));
      if (!item) throw Object.assign(new Error("验证码不存在"), { status: 404 });
      if (req.body?.isUsed !== undefined && typeof req.body.isUsed !== "boolean") {
        throw Object.assign(new Error("isUsed 必须是布尔值"), { status: 400 });
      }
      if (req.body?.isHidden !== undefined && typeof req.body.isHidden !== "boolean") {
        throw Object.assign(new Error("isHidden 必须是布尔值"), { status: 400 });
      }
      if (req.body?.isUsed !== undefined && req.body?.isHidden !== undefined
        && req.body.isUsed !== req.body.isHidden) {
        throw Object.assign(new Error("已用验证码必须位于回收站"), { status: 409 });
      }
      let isUsed = req.body?.isUsed === undefined ? item.is_used : (req.body.isUsed ? 1 : 0);
      let isHidden = req.body?.isHidden === undefined ? item.is_hidden : (req.body.isHidden ? 1 : 0);
      if (req.body?.isUsed === true) isHidden = 1;
      if (req.body?.isUsed === false || req.body?.isHidden === false) {
        isUsed = 0;
        isHidden = 0;
      }
      if (isHidden && !isUsed) throw Object.assign(new Error("请先将验证码标记为已用"), { status: 409 });
      db.prepare("UPDATE verification_codes SET is_used = ?, is_hidden = ? WHERE id = ?").run(isUsed, isHidden, item.id);
      if (isHidden !== item.is_hidden) audit(db, item.account_id, "code", isHidden ? "隐藏验证码" : "恢复验证码", item.subject, { codeId: item.id });
      res.json({ ok: true, item: { ...item, is_used: Boolean(isUsed), is_hidden: Boolean(isHidden) } });
    } catch (error) { next(error); }
  });

  app.get("/api/export/addresses.csv", (req, res) => {
    const { items } = addressQuery(db, { accountId: req.query.accountId, kind: req.query.kind, limit: 100_000, page: 1 });
    const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = [["address", "kind", "base_address", "source_email", "label", "purpose", "created_at"], ...items.map((item) => [item.address, item.kind, item.parent_address || item.address, item.source_email, item.label, item.purpose, item.created_at])];
    res.setHeader("Content-Disposition", `attachment; filename="outlook-addresses-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.type("text/csv").send(`\uFEFF${rows.map((row) => row.map(escape).join(",")).join("\n")}`);
  });

  app.get("/api/settings", (_req, res) => {
    const settings = getSettings(db);
    delete settings.google_oauth_client_secret_encrypted;
    delete settings.nfapi_admin_api_key_encrypted;
    delete settings.nfapi_import_defaults;
    res.json({
      ...settings,
      ...gmail.configuration(),
      extension_api_key: extension.apiKey,
      public_base_url: publicBaseUrl,
      auth_enabled: auth.enabled,
      supported_domains: microsoftDomains,
      microsoft_oauth_mode: "authorization_code_pkce",
      microsoft_oauth_client: "Mailspring · Microsoft Graph Mail.Read",
      icloud_imap: icloudImapConfiguration,
      extension_download: "/api/extension/download",
    });
  });
  app.patch("/api/settings", (req, res) => {
    ["site_name", "code_retention_days", "default_recovery_email"].forEach((key) => {
      if (req.body?.[key] !== undefined) setSetting(db, key, req.body[key]);
    });
    const google = gmail.updateConfiguration(req.body || {});
    res.json({ ok: true, ...google });
  });

  const distDir = path.join(projectRoot, "dist");
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir, { maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  app.use((req, res) => res.status(404).json({ error: "接口不存在" }));
  app.use((error, _req, res, _next) => {
    const status = Number(error.status) || (String(error.message).includes("UNIQUE constraint") ? 409 : 500);
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status >= 500 ? "服务器处理请求失败" : error.message });
  });
  return { app, db, graph, gmail, icloud, inbox, extension, jobs, registration, nfapi };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.umask(0o077);
  const runtime = createApp();
  const port = Number(process.env.PORT) || 4180;
  const host = process.env.HOST || "127.0.0.1";
  const server = runtime.app.listen(port, host, () => console.log(`AliasHub listening on http://${host}:${port}`));
  const shutdown = async () => {
    server.close();
    runtime.db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
