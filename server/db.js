import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const schema = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS source_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL DEFAULT 'microsoft',
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL DEFAULT '',
    recovery_email TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'connecting' CHECK(status IN ('connecting', 'connected', 'action_required', 'disconnected', 'error')),
    profile_key TEXT NOT NULL UNIQUE,
    official_limit INTEGER NOT NULL DEFAULT 10,
    limit_reason TEXT NOT NULL DEFAULT '',
    next_retry_at TEXT,
    last_synced_at TEXT,
    last_inbox_scan_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
    parent_address_id INTEGER REFERENCES addresses(id) ON DELETE CASCADE,
    address TEXT NOT NULL COLLATE NOCASE,
    kind TEXT NOT NULL CHECK(kind IN ('primary', 'official', 'split')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'pending', 'limited', 'disabled', 'failed')),
    strategy TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    purpose TEXT NOT NULL DEFAULT '',
    remote_confirmed INTEGER NOT NULL DEFAULT 0,
    last_code_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(account_id, address)
  );

  CREATE INDEX IF NOT EXISTS idx_addresses_account_kind ON addresses(account_id, kind, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_addresses_parent ON addresses(parent_address_id);

  CREATE TABLE IF NOT EXISTS automation_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('bind', 'official_fill', 'alias_sync', 'inbox_scan')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'waiting_user', 'limited', 'completed', 'failed', 'cancelled')),
    progress_current INTEGER NOT NULL DEFAULT 0,
    progress_target INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    stop_reason TEXT NOT NULL DEFAULT '',
    config TEXT NOT NULL DEFAULT '{}',
    result TEXT NOT NULL DEFAULT '{}',
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_account ON automation_jobs(account_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON automation_jobs(status, created_at);

  CREATE TABLE IF NOT EXISTS verification_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
    address_id INTEGER REFERENCES addresses(id) ON DELETE SET NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL,
    sender TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    preview TEXT NOT NULL DEFAULT '',
    received_at TEXT NOT NULL,
    is_used INTEGER NOT NULL DEFAULT 0,
    is_hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_codes_account ON verification_codes(account_id, received_at DESC);

  CREATE TABLE IF NOT EXISTS verification_code_tombstones (
    fingerprint TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
    deleted_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_code_tombstones_account ON verification_code_tombstones(account_id, deleted_at DESC);

  CREATE TRIGGER IF NOT EXISTS prevent_deleted_code_reinsert
  BEFORE INSERT ON verification_codes
  WHEN EXISTS (
    SELECT 1 FROM verification_code_tombstones
    WHERE fingerprint = NEW.fingerprint
  )
  BEGIN
    SELECT RAISE(IGNORE);
  END;

  CREATE TABLE IF NOT EXISTS mail_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
    address_id INTEGER REFERENCES addresses(id) ON DELETE SET NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    graph_message_id TEXT NOT NULL DEFAULT '',
    internet_message_id TEXT NOT NULL DEFAULT '',
    sender_name TEXT NOT NULL DEFAULT '',
    sender_address TEXT NOT NULL DEFAULT '',
    recipient_address TEXT NOT NULL DEFAULT '',
    to_recipients TEXT NOT NULL DEFAULT '[]',
    cc_recipients TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL DEFAULT '',
    preview TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    body_content_type TEXT NOT NULL DEFAULT 'text',
    body_truncated INTEGER NOT NULL DEFAULT 0,
    verification_code TEXT NOT NULL DEFAULT '',
    web_link TEXT NOT NULL DEFAULT '',
    is_read INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    received_at TEXT NOT NULL,
    is_hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(account_id, graph_message_id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_account_received ON mail_messages(account_id, received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_hidden_received ON mail_messages(is_hidden, received_at DESC);

  CREATE TABLE IF NOT EXISTS mail_message_tombstones (
    fingerprint TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
    deleted_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_message_tombstones_account ON mail_message_tombstones(account_id, deleted_at DESC);

  CREATE TRIGGER IF NOT EXISTS prevent_deleted_message_reinsert
  BEFORE INSERT ON mail_messages
  WHEN EXISTS (
    SELECT 1 FROM mail_message_tombstones
    WHERE fingerprint = NEW.fingerprint
  )
  BEGIN
    SELECT RAISE(IGNORE);
  END;

  CREATE TABLE IF NOT EXISTS microsoft_tokens (
    account_id INTEGER PRIMARY KEY REFERENCES source_accounts(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL DEFAULT '',
    microsoft_user_id TEXT NOT NULL DEFAULT '',
    refresh_token_encrypted TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '',
    token_updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS google_tokens (
    account_id INTEGER PRIMARY KEY REFERENCES source_accounts(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL DEFAULT '',
    google_user_id TEXT NOT NULL DEFAULT '',
    refresh_token_encrypted TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '',
    token_updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS icloud_credentials (
    account_id INTEGER PRIMARY KEY REFERENCES source_accounts(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    app_password_encrypted TEXT NOT NULL,
    credential_updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_code_sessions (
    id TEXT PRIMARY KEY,
    expected_account_id INTEGER REFERENCES source_accounts(id) ON DELETE SET NULL,
    provider TEXT NOT NULL DEFAULT 'microsoft',
    client_id TEXT NOT NULL DEFAULT '',
    code_verifier_encrypted TEXT NOT NULL,
    state TEXT NOT NULL UNIQUE,
    redirect_uri TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_oauth_code_expiry ON oauth_code_sessions(expires_at);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER REFERENCES source_accounts(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS registration_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER REFERENCES source_accounts(id) ON DELETE SET NULL,
    address_id INTEGER REFERENCES addresses(id) ON DELETE SET NULL,
    base_address_id INTEGER REFERENCES addresses(id) ON DELETE SET NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    external_task_id TEXT NOT NULL DEFAULT '',
    external_account_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    stage TEXT NOT NULL DEFAULT 'queued',
    browser_mode TEXT NOT NULL DEFAULT 'headed',
    proxy_label TEXT NOT NULL DEFAULT '',
    exit_ip TEXT NOT NULL DEFAULT '',
    fingerprint_id TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    birth_date TEXT NOT NULL DEFAULT '',
    progress_current INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER NOT NULL DEFAULT 1,
    message TEXT NOT NULL DEFAULT '',
    failure_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_registration_jobs_status ON registration_jobs(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_registration_jobs_email ON registration_jobs(email, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_registration_jobs_external ON registration_jobs(external_task_id);

  CREATE TABLE IF NOT EXISTS registration_password_setup_tasks (
    task_id TEXT PRIMARY KEY,
    external_account_id INTEGER NOT NULL CHECK(external_account_id > 0),
    status TEXT NOT NULL
      CHECK(status IN ('queued', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled', 'interrupted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_registration_password_setup_account
    ON registration_password_setup_tasks(external_account_id, status, created_at DESC);

  CREATE TABLE IF NOT EXISTS registered_account_metadata (
    external_account_id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    custom_name TEXT NOT NULL DEFAULT '',
    group_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_registered_account_metadata_group
    ON registered_account_metadata(group_name COLLATE NOCASE, updated_at DESC);

  CREATE TABLE IF NOT EXISTS registered_account_status_checks (
    external_account_id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    detection_status TEXT NOT NULL DEFAULT 'unchecked',
    account_status TEXT NOT NULL DEFAULT 'unknown',
    credential_status TEXT NOT NULL DEFAULT 'unknown',
    subscription_status TEXT NOT NULL DEFAULT 'unknown',
    account_type TEXT NOT NULL DEFAULT 'unknown',
    account_type_raw TEXT NOT NULL DEFAULT '',
    code TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    retryable INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT '',
    http_status INTEGER NOT NULL DEFAULT 0,
    evidence_path TEXT NOT NULL DEFAULT '',
    checked_at TEXT NOT NULL DEFAULT '',
    attempted_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_registered_account_status_checks_email
    ON registered_account_status_checks(email COLLATE NOCASE, updated_at DESC);

  CREATE TABLE IF NOT EXISTS registered_account_nfapi_links (
    external_account_id TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    nfapi_base_url TEXT NOT NULL,
    nfapi_account_id INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    short_lived INTEGER NOT NULL DEFAULT 0,
    last_action TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (external_account_id, nfapi_base_url)
  );

  CREATE INDEX IF NOT EXISTS idx_registered_account_nfapi_links_account
    ON registered_account_nfapi_links(nfapi_account_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS microsoft_registration_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload_sha256 TEXT NOT NULL UNIQUE,
    source_label TEXT NOT NULL DEFAULT 'go-ms',
    item_count INTEGER NOT NULL DEFAULT 0,
    raw_payload_encrypted TEXT NOT NULL,
    received_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_microsoft_registration_imports_received
    ON microsoft_registration_imports(received_at DESC);

  CREATE TABLE IF NOT EXISTS microsoft_registration_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'received'
      CHECK(status IN ('received', 'success', 'failed', 'unknown')),
    proxy_label TEXT NOT NULL DEFAULT '',
    source_label TEXT NOT NULL DEFAULT 'go-ms',
    credential_payload_encrypted TEXT NOT NULL DEFAULT '',
    source_payload_encrypted TEXT NOT NULL DEFAULT '',
    source_import_id INTEGER REFERENCES microsoft_registration_imports(id) ON DELETE SET NULL,
    source_account_id INTEGER REFERENCES source_accounts(id) ON DELETE SET NULL,
    external_record_key TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    has_password INTEGER NOT NULL DEFAULT 0,
    has_refresh_token INTEGER NOT NULL DEFAULT 0,
    has_access_token INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    upload_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_microsoft_registration_accounts_seen
    ON microsoft_registration_accounts(last_seen_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_microsoft_registration_accounts_status
    ON microsoft_registration_accounts(status, last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_microsoft_registration_accounts_source
    ON microsoft_registration_accounts(source_account_id, last_seen_at DESC);

  CREATE TABLE IF NOT EXISTS microsoft_registration_runner_config (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    secret_payload_encrypted TEXT NOT NULL DEFAULT '',
    captcha_key_configured INTEGER NOT NULL DEFAULT 0,
    proxy_mode TEXT NOT NULL DEFAULT 'list' CHECK(proxy_mode IN ('list', 'api')),
    proxy_count INTEGER NOT NULL DEFAULT 0,
    account_format TEXT NOT NULL DEFAULT 'aaaaa11111111',
    password_format TEXT NOT NULL DEFAULT 'aaaaa11111111',
    quantity INTEGER NOT NULL DEFAULT 1,
    concurrency INTEGER NOT NULL DEFAULT 1,
    captcha_type TEXT NOT NULL DEFAULT '3',
    oauth_mode TEXT NOT NULL DEFAULT '3',
    chrome_version TEXT NOT NULL DEFAULT '143',
    updated_at TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS microsoft_registration_runner_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL CHECK(status IN ('starting', 'running', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted')),
    phase TEXT NOT NULL DEFAULT '',
    account_format TEXT NOT NULL DEFAULT '',
    quantity INTEGER NOT NULL DEFAULT 1,
    concurrency INTEGER NOT NULL DEFAULT 1,
    proxy_mode TEXT NOT NULL DEFAULT '',
    proxy_count INTEGER NOT NULL DEFAULT 0,
    auth_pid INTEGER,
    runner_pid INTEGER,
    callback_token_hash TEXT NOT NULL DEFAULT '',
    callback_expires_at TEXT NOT NULL DEFAULT '',
    received_count INTEGER NOT NULL DEFAULT 0,
    last_received_at TEXT NOT NULL DEFAULT '',
    stop_requested INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    exit_code INTEGER,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_microsoft_registration_runner_active
    ON microsoft_registration_runner_runs(status)
    WHERE status IN ('starting', 'running', 'stopping');
  CREATE INDEX IF NOT EXISTS idx_microsoft_registration_runner_runs_created
    ON microsoft_registration_runner_runs(created_at DESC);

  CREATE TABLE IF NOT EXISTS microsoft_registration_runner_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES microsoft_registration_runner_runs(id) ON DELETE CASCADE,
    stream TEXT NOT NULL CHECK(stream IN ('system', 'auth', 'registrar')),
    level TEXT NOT NULL CHECK(level IN ('info', 'error')),
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_microsoft_registration_runner_logs_run
    ON microsoft_registration_runner_logs(run_id, id);

  CREATE TABLE IF NOT EXISTS nfapi_oauth_import_sessions (
    id TEXT PRIMARY KEY,
    external_account_id INTEGER NOT NULL CHECK(external_account_id > 0),
    payload_encrypted TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'expired')),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    consumed_at TEXT,
    finished_at TEXT,
    last_error TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_nfapi_oauth_import_expiry
    ON nfapi_oauth_import_sessions(status, expires_at);
`;

export function nowIso() {
  return new Date().toISOString();
}

export function setSetting(db, key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), nowIso());
}

export function getSetting(db, key, fallback = "") {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? fallback;
}

export function getSettings(db) {
  return Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
}

export function listRegisteredAccountStatusChecks(db) {
  return db.prepare(`
    SELECT * FROM registered_account_status_checks
    ORDER BY updated_at DESC
  `).all().map((row) => ({
    ...row,
    retryable: Boolean(row.retryable),
  }));
}

export function upsertRegisteredAccountStatusCheck(db, outcome = {}) {
  const externalAccountId = String(outcome.external_account_id || outcome.id || "").trim();
  const email = String(outcome.email || "").trim().toLowerCase();
  if (!externalAccountId || !email) throw new Error("账号状态检测结果缺少账号身份");
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO registered_account_status_checks (
      external_account_id, email, detection_status, account_status,
      credential_status, subscription_status, account_type, account_type_raw,
      code, reason, retryable, source, http_status, evidence_path,
      checked_at, attempted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_account_id) DO UPDATE SET
      email = excluded.email,
      detection_status = excluded.detection_status,
      account_status = excluded.account_status,
      credential_status = excluded.credential_status,
      subscription_status = excluded.subscription_status,
      account_type = excluded.account_type,
      account_type_raw = excluded.account_type_raw,
      code = excluded.code,
      reason = excluded.reason,
      retryable = excluded.retryable,
      source = excluded.source,
      http_status = excluded.http_status,
      evidence_path = excluded.evidence_path,
      checked_at = excluded.checked_at,
      attempted_at = excluded.attempted_at,
      updated_at = excluded.updated_at
  `).run(
    externalAccountId,
    email,
    String(outcome.detection_status || "unchecked"),
    String(outcome.account_status || "unknown"),
    String(outcome.credential_status || "unknown"),
    String(outcome.subscription_status || "unknown"),
    String(outcome.account_type || "unknown"),
    String(outcome.account_type_raw || ""),
    String(outcome.code || ""),
    String(outcome.reason || ""),
    outcome.retryable ? 1 : 0,
    String(outcome.source || ""),
    Math.max(0, Number(outcome.http_status || outcome.status_http) || 0),
    String(outcome.evidence_path || outcome.status_evidence_path || ""),
    String(outcome.checked_at || ""),
    String(outcome.attempted_at || ""),
    timestamp,
    timestamp,
  );
  return db.prepare(`
    SELECT * FROM registered_account_status_checks WHERE external_account_id = ?
  `).get(externalAccountId);
}

export function audit(db, accountId, type, title, detail = "", metadata = {}) {
  db.prepare("INSERT INTO audit_log (account_id, type, title, detail, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(accountId || null, type, title, detail, JSON.stringify(metadata), nowIso());
}

export function createSourceAccount(db, {
  email,
  displayName = "",
  provider = "microsoft",
  officialLimit = provider === "microsoft" ? 10 : 1,
} = {}) {
  const now = nowIso();
  const recoveryEmail = getSetting(db, "default_recovery_email", "");
  const result = db.prepare(`
    INSERT INTO source_accounts
      (provider, email, display_name, recovery_email, profile_key, official_limit, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(provider, email, displayName, recoveryEmail, crypto.randomUUID(), officialLimit, now, now);
  const accountId = Number(result.lastInsertRowid);
  db.prepare(`
    INSERT INTO addresses (account_id, address, kind, status, label, remote_confirmed, created_at, updated_at)
    VALUES (?, ?, 'primary', 'active', '源头地址', 1, ?, ?)
  `).run(accountId, email, now, now);
  audit(db, accountId, "account", "添加源头邮箱", email, { provider });
  return db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(accountId);
}

function seedDemoData(db) {
  if (db.prepare("SELECT COUNT(*) AS count FROM source_accounts").get().count) return;
  const now = new Date();
  const ago = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const account = createSourceAccount(db, { email: "alex.demo@outlook.com", displayName: "Alex 的 Outlook" });
  db.prepare("UPDATE source_accounts SET status = 'connected', last_synced_at = ?, updated_at = ? WHERE id = ?").run(ago(12), ago(12), account.id);
  const insert = db.prepare(`
    INSERT INTO addresses (account_id, parent_address_id, address, kind, status, strategy, label, purpose, remote_confirmed, last_code_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
  `);
  const shop = Number(insert.run(account.id, null, "alex.shop@outlook.com", "official", "official", "购物专用", "购物", 1, ago(46), ago(2_000), ago(12)).lastInsertRowid);
  const work = Number(insert.run(account.id, null, "alex.work@outlook.com", "official", "official", "工作注册", "工作", 1, null, ago(1_700), ago(12)).lastInsertRowid);
  const primary = db.prepare("SELECT id FROM addresses WHERE account_id = ? AND kind = 'primary'").get(account.id).id;
  insert.run(account.id, primary, "alex.demo+github@outlook.com", "split", "plus", "GitHub", "开发", 0, ago(18), ago(420), ago(18));
  insert.run(account.id, shop, "alex.shop+amazon@outlook.com", "split", "plus", "Amazon", "购物", 0, ago(46), ago(390), ago(46));
  insert.run(account.id, work, "alex.work+notion@outlook.com", "split", "plus", "Notion", "协作", 0, null, ago(360), ago(360));
  const codeRows = [
    [primary, "482913", "GitHub", "Your GitHub verification code", "Use 482913 to verify your email address.", 18],
    [shop, "731055", "Amazon", "Verify your email address", "Enter code 731055 to continue.", 46],
  ];
  const insertCode = db.prepare(`
    INSERT INTO verification_codes (account_id, address_id, fingerprint, code, sender, subject, preview, received_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  codeRows.forEach((item, index) => insertCode.run(account.id, item[0], `demo-code-${index}`, item[1], item[2], item[3], item[4], ago(item[5]), ago(item[5])));
  audit(db, account.id, "alias", "同步官方别名", "发现 2 个官方别名", {});
  audit(db, account.id, "split", "生成分裂地址", "共生成 3 个地址", {});
}

function legacyRegistrationFailureReason(row = {}) {
  if (String(row.status || "").toLowerCase() !== "failed") return "";
  const text = `${row.failure_reason || ""} ${row.stage || ""} ${row.message || ""}`.toLowerCase();
  return /(?:user_already_exists|user_exists|account_already_exists|email_already_exists|email_already_registered(?:_on_openai)?|email_already_used|email_in_use|(?:user|account|email)\s+already\s+(?:exists|registered|used)|(?:邮箱|电子邮箱)\s*(?:(?:已|已经)\s*(?:被)?|被)\s*(?:占用|注册|使用|存在)|(?:可能|疑似)?\s*已在\s*openai\s*(?:上)?注册过)/i.test(text)
    ? "user_already_exists"
    : "";
}

function normalizedAddressEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function legacyBaseAddressId(email, bases) {
  const target = normalizedAddressEmail(email);
  if (!target) return null;
  const exact = bases.find((base) => normalizedAddressEmail(base.address) === target);
  if (exact) return exact.id;
  const at = target.lastIndexOf("@");
  if (at <= 0 || at === target.length - 1) return null;
  const local = target.slice(0, at);
  const domain = target.slice(at + 1);
  const candidates = bases
    .map((base) => ({ ...base, address: normalizedAddressEmail(base.address) }))
    .filter((base) => {
      const separator = base.address.lastIndexOf("@");
      if (separator <= 0 || separator === base.address.length - 1) return false;
      return base.address.slice(separator + 1) === domain && local.startsWith(`${base.address.slice(0, separator)}+`);
    })
    .sort((left, right) => right.address.length - left.address.length);
  return candidates.length ? candidates[0].id : null;
}

function migrateRegistrationJobHistory(db) {
  const migrateLinkedAddress = db.prepare(`
    UPDATE registration_jobs
    SET base_address_id = (
      SELECT COALESCE(addresses.parent_address_id, addresses.id)
      FROM addresses
      WHERE addresses.id = registration_jobs.address_id
    )
    WHERE (base_address_id IS NULL OR base_address_id = 0)
      AND address_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM addresses WHERE addresses.id = registration_jobs.address_id)
  `);
  const unresolvedRows = db.prepare(`
    SELECT id, account_id, email
    FROM registration_jobs
    WHERE (base_address_id IS NULL OR base_address_id = 0)
      AND account_id IS NOT NULL
  `);
  const basesByAccount = db.prepare(`
    SELECT id, account_id, address
    FROM addresses
    WHERE kind IN ('primary', 'official')
  `);
  const setBaseAddress = db.prepare("UPDATE registration_jobs SET base_address_id = ? WHERE id = ? AND (base_address_id IS NULL OR base_address_id = 0)");
  const failedRows = db.prepare(`
    SELECT id, status, stage, message, failure_reason
    FROM registration_jobs
    WHERE lower(status) = 'failed'
  `);
  const setFailureReason = db.prepare("UPDATE registration_jobs SET failure_reason = ? WHERE id = ?");

  db.transaction(() => {
    migrateLinkedAddress.run();
    const groupedBases = new Map();
    for (const base of basesByAccount.all()) {
      const accountId = Number(base.account_id);
      const items = groupedBases.get(accountId) || [];
      items.push(base);
      groupedBases.set(accountId, items);
    }
    for (const row of unresolvedRows.all()) {
      const baseAddressId = legacyBaseAddressId(row.email, groupedBases.get(Number(row.account_id)) || []);
      if (baseAddressId) setBaseAddress.run(baseAddressId, row.id);
    }
    for (const row of failedRows.all()) {
      const failureReason = legacyRegistrationFailureReason(row);
      if (failureReason) setFailureReason.run(failureReason, row.id);
    }
  })();
}

export function createDatabase({ filename, seedDemo = false } = {}) {
  const resolved = path.resolve(filename || "./data/outlook-alias-hub.db");
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const db = new Database(resolved);
  db.pragma("busy_timeout = 5000");
  db.exec(schema);
  const accountColumns = db.pragma("table_info(source_accounts)").map((column) => column.name);
  if (!accountColumns.includes("provider")) db.exec("ALTER TABLE source_accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'microsoft'");
  if (!accountColumns.includes("recovery_email")) db.exec("ALTER TABLE source_accounts ADD COLUMN recovery_email TEXT NOT NULL DEFAULT ''");
  db.exec("DROP TABLE IF EXISTS oauth_device_sessions");
  const tokenColumns = db.pragma("table_info(microsoft_tokens)").map((column) => column.name);
  if (!tokenColumns.includes("client_id")) db.exec("ALTER TABLE microsoft_tokens ADD COLUMN client_id TEXT NOT NULL DEFAULT ''");
  const oauthSessionColumns = db.pragma("table_info(oauth_code_sessions)").map((column) => column.name);
  if (!oauthSessionColumns.includes("provider")) db.exec("ALTER TABLE oauth_code_sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'microsoft'");
  const codeColumns = db.pragma("table_info(verification_codes)").map((column) => column.name);
  if (!codeColumns.includes("is_hidden")) db.exec("ALTER TABLE verification_codes ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS idx_codes_hidden_received ON verification_codes(is_hidden, received_at DESC)");
  const registrationColumns = db.pragma("table_info(registration_jobs)").map((column) => column.name);
  if (!registrationColumns.includes("exit_ip")) db.exec("ALTER TABLE registration_jobs ADD COLUMN exit_ip TEXT NOT NULL DEFAULT ''");
  if (!registrationColumns.includes("fingerprint_id")) db.exec("ALTER TABLE registration_jobs ADD COLUMN fingerprint_id TEXT NOT NULL DEFAULT ''");
  if (!registrationColumns.includes("deleted_at")) db.exec("ALTER TABLE registration_jobs ADD COLUMN deleted_at TEXT");
  if (!registrationColumns.includes("base_address_id")) {
    db.exec("ALTER TABLE registration_jobs ADD COLUMN base_address_id INTEGER REFERENCES addresses(id) ON DELETE SET NULL");
  }
  if (!registrationColumns.includes("failure_reason")) {
    db.exec("ALTER TABLE registration_jobs ADD COLUMN failure_reason TEXT NOT NULL DEFAULT ''");
  }
  migrateRegistrationJobHistory(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_registration_jobs_visible ON registration_jobs(deleted_at, created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_registration_jobs_base_address ON registration_jobs(base_address_id, created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_registration_jobs_address_failure ON registration_jobs(address_id, failure_reason, created_at DESC)");
  const accountStatusCheckColumns = db.pragma("table_info(registered_account_status_checks)")
    .map((column) => column.name);
  if (!accountStatusCheckColumns.includes("http_status")) {
    db.exec("ALTER TABLE registered_account_status_checks ADD COLUMN http_status INTEGER NOT NULL DEFAULT 0");
  }
  if (!accountStatusCheckColumns.includes("evidence_path")) {
    db.exec("ALTER TABLE registered_account_status_checks ADD COLUMN evidence_path TEXT NOT NULL DEFAULT ''");
  }
  const nfapiOAuthColumns = db.pragma("table_info(nfapi_oauth_import_sessions)").map((column) => column.name);
  if (!nfapiOAuthColumns.includes("external_account_id")) {
    db.exec("ALTER TABLE nfapi_oauth_import_sessions ADD COLUMN external_account_id INTEGER NOT NULL DEFAULT 0");
    const migratedAt = nowIso();
    db.prepare(`
      UPDATE nfapi_oauth_import_sessions
      SET status = 'expired', payload_encrypted = '', finished_at = ?, last_error = ''
      WHERE status IN ('pending', 'processing')
    `).run(migratedAt);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nfapi_oauth_import_active_account
    ON nfapi_oauth_import_sessions(external_account_id)
    WHERE external_account_id > 0 AND status IN ('pending', 'processing')
  `);
  const defaults = {
    site_name: "AliasHub",
    official_limit_default: "10",
    split_batch_limit: "5000",
    code_retention_days: "30",
    default_recovery_email: "",
    microsoft_public_client_id: "8787a430-6eee-41e1-b914-681d90d35625",
    google_oauth_client_id: "",
    google_oauth_client_secret_encrypted: "",
    google_oauth_redirect_uri: "http://127.0.0.1:12142/",
    extension_api_key: "",
    registration_connector_key: "",
    registration_proxy_pool: "[]",
    nfapi_base_url: "",
    nfapi_admin_api_key_encrypted: "",
    nfapi_import_defaults: "{}",
    nfapi_last_connected_at: "",
    microsoft_registration_webhook_token_hash: "",
  };
  const statement = db.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
  Object.entries(defaults).forEach(([key, value]) => statement.run(key, value, nowIso()));
  db.prepare(`
    UPDATE settings SET value = ?, updated_at = ?
    WHERE key = 'microsoft_public_client_id'
      AND value IN ('14d82eec-204b-4c2f-b7e8-296a70dab67e', '9e5f94bc-e8a4-4e73-b8be-63364c29d753')
  `).run(defaults.microsoft_public_client_id, nowIso());
  db.prepare("DELETE FROM settings WHERE key = 'browser_session_minutes'").run();
  if (!getSetting(db, "extension_api_key")) setSetting(db, "extension_api_key", crypto.randomBytes(24).toString("base64url"));
  if (!getSetting(db, "registration_connector_key")) setSetting(db, "registration_connector_key", crypto.randomBytes(24).toString("base64url"));
  db.prepare("DELETE FROM oauth_code_sessions WHERE expires_at <= ?").run(nowIso());
  const expiredAt = nowIso();
  db.prepare(`
    UPDATE nfapi_oauth_import_sessions
    SET status = 'expired', payload_encrypted = '', finished_at = ?, last_error = ''
    WHERE status IN ('pending', 'processing') AND expires_at <= ?
  `).run(expiredAt, expiredAt);
  if (seedDemo) db.transaction(() => seedDemoData(db))();
  return db;
}
