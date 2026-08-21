import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import express from "express";
import { deleteSelectedAddresses, deleteSplitAddresses, generateSplits, importIcloudAliases, importMailcomAliases, JobRunner, parseJson, publicAccount, syncOfficialAddresses } from "./account-service.js";
import { createAuth } from "./auth.js";
import { MAILCOM_ALIAS_STRATEGY, NETEASE_ALIAS_STRATEGY, isIcloudImportedStrategy, isMailcomAliasStrategy, isNeteaseAliasStrategy, mailcomDomains, microsoftDomains, neteaseAliasDomain, neteaseDomains, normalizeIcloudAliasEmail, normalizeMailcomEmail, normalizeMicrosoftEmail, normalizeNeteaseAliasEmail } from "./address-generator.js";
import { audit, createDatabase, createSourceAccount, getSettings, nowIso, setSetting } from "./db.js";
import { ExtensionService } from "./extension-service.js";
import { registerEzCaptchaAdapter } from "./ez-captcha-adapter.js";
import { GoogleGmailClient } from "./google-gmail.js";
import { ICloudImapClient, icloudImapConfiguration } from "./icloud-imap.js";
import { IcloudPrivacyClient } from "./icloud-privacy-client.js";
import { InboxLinkMailboxService } from "./inbox-link-pool.js";
import { InventoryApiService } from "./inventory-api-service.js";
import { IcRegistrationPipelineService } from "./ic-registration-pipeline-service.js";
import { importMailcomAccounts } from "./mailcom-import.js";
import { MailcomAliasAutomationService } from "./mailcom-alias-service.js";
import { MailcomAliasPlaywrightAdapter } from "./mailcom-alias-playwright.js";
import { MailComImapClient, mailcomImapConfiguration } from "./mailcom-imap.js";
import { MailcomRegistrationPipelineService } from "./mailcom-registration-pipeline-service.js";
import { importNeteaseAliases } from "./netease-aliases.js";
import { NeteaseImapClient, neteaseImapHosts } from "./netease-imap.js";
import { importNeteaseAccounts } from "./netease-import.js";
import { MicrosoftGraphClient } from "./microsoft-graph.js";
import { NfapiService, PUBLIC_AGENT_IDENTITY_ERROR_CODES } from "./nfapi-service.js";
import { NfapiCredentialStore, NfapiCredentialSync } from "./nfapi-credential-sync.js";
import { OpenAiSmsService } from "./openai-sms-service.js";
import { MicrosoftRegistrationRunnerService } from "./microsoft-registration-runner-service.js";
import { MicrosoftRegistrationService } from "./microsoft-registration-service.js";
import { PickupService } from "./pickup-service.js";
import { PaymentAgreementService } from "./payment-agreement-service.js";
import { PaymentLinkService } from "./payment-link-service.js";
import { RegistrationClient } from "./registration-client.js";
import { RegistrationService } from "./registration-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function positive(value, fallback = 20, maximum = 5_000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, Math.floor(parsed))) : fallback;
}

function safeMailcomPartialError(error) {
  const partial = error?.partial;
  if (!partial || typeof partial !== "object") return {};
  const integer = (value) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  };
  const account = error.account && typeof error.account === "object" ? {
    id: Number(error.account.id),
    provider: String(error.account.provider || ""),
    email: String(error.account.email || ""),
    display_name: String(error.account.display_name || ""),
    status: String(error.account.status || ""),
    official_limit: integer(error.account.official_limit),
    official_used: integer(error.account.official_used),
    official_remaining: integer(error.account.official_remaining),
    official_aliases: integer(error.account.official_aliases),
    mailcom_aliases: integer(error.account.mailcom_aliases),
    address_count: integer(error.account.address_count),
    credential_connected: Boolean(error.account.credential_connected),
    supports_direct_registration: Boolean(error.account.supports_direct_registration),
    supports_mailcom_aliases: Boolean(error.account.supports_mailcom_aliases),
  } : undefined;
  const items = Array.isArray(error.items) ? error.items.map((item) => ({
    id: Number(item.id),
    account_id: Number(item.account_id),
    parent_address_id: item.parent_address_id == null ? null : Number(item.parent_address_id),
    address: String(item.address || ""),
    kind: String(item.kind || ""),
    status: String(item.status || ""),
    strategy: String(item.strategy || ""),
    label: String(item.label || ""),
    purpose: String(item.purpose || ""),
    remote_confirmed: Number(item.remote_confirmed) === 1 ? 1 : 0,
    created_at: String(item.created_at || ""),
    updated_at: String(item.updated_at || ""),
  })) : undefined;
  return {
    partial: {
      created: integer(partial.created),
      total: integer(partial.total),
      existing: integer(partial.existing),
    },
    ...(account ? { account } : {}),
    ...(items ? { items } : {}),
  };
}

function sendProxyResult(res, result) {
  Object.entries(result?.headers || {}).forEach(([name, value]) => {
    if (value !== undefined && value !== null) res.setHeader(name, value);
  });
  const status = Number(result?.status) || 502;
  const body = Buffer.isBuffer(result?.body) ? result.body : Buffer.from(result?.body || "");
  if (status === 204 || status === 304) return res.status(status).end();
  return res.status(status).send(body);
}

function publicJob(row) {
  return row ? { ...row, config: parseJson(row.config), result: parseJson(row.result) } : null;
}

function inventoryIdList(value, label = "账号") {
  if (!Array.isArray(value)) throw Object.assign(new Error(`请选择要导入的${label}`), { status: 400 });
  const ids = [...new Set(value.map(Number))];
  if (!ids.length) throw Object.assign(new Error(`请选择要导入的${label}`), { status: 400 });
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw Object.assign(new Error(`${label} ID 无效`), { status: 400 });
  }
  if (ids.length > 100) throw Object.assign(new Error("单次最多导入 100 个账号"), { status: 400 });
  return ids;
}

function inventoryPayloadFromBody(body = {}) {
  if (body.payload !== undefined) {
    if (body.payload === null || typeof body.payload !== "object") {
      throw Object.assign(new Error("库存账号 JSON 必须是对象、数组或 files 结构"), { status: 400 });
    }
    return body.payload;
  }
  for (const key of ["data", "cards", "files", "card_ids"]) {
    if (body[key] === undefined) continue;
    const value = body[key];
    if (value === null || typeof value !== "object") {
      throw Object.assign(new Error("库存账号 JSON 必须是对象、数组或 files 结构"), { status: 400 });
    }
    return { [key]: value };
  }
  return null;
}

async function collectInventoryCards(registration, ids) {
  const uniqueIds = inventoryIdList(ids, "注册账号");
  const settled = await Promise.all(uniqueIds.map(async (id) => {
    try {
      let exported;
      try {
        exported = await registration.registeredAccountSub2Export(id);
      } catch (fullExportError) {
        // An account may have a valid AT but no RT yet.  nvtokens can still
        // inspect an AT-only Codex card, so keep that useful fallback instead
        // of dropping the account from a bulk submission.
        const access = await registration.registeredAccountAccessToken(id);
        exported = { ...access, credentials: { email: access.email, access_token: access.access_token } };
        if (!exported.access_token) throw fullExportError;
      }
      const credentials = exported?.credentials && typeof exported.credentials === "object"
        ? { ...exported.credentials }
        : {};
      const email = String(exported?.email || credentials.email || "").trim().toLowerCase();
      if (!email || !credentials.access_token) {
        throw Object.assign(new Error("账号缺少 Access Token"), { status: 409 });
      }
      // nvtokens accepts a plain Codex credential object and computes its
      // license identity from the signed credentials.  Keep all optional
      // fields from the server-side export intact.
      return {
        ok: true,
        id,
        entry: { ...credentials, email, type: "codex" },
      };
    } catch (error) {
      return { ok: false, id, error: String(error?.message || "账号凭据读取失败").slice(0, 240) };
    }
  }));
  const entries = settled.filter((item) => item.ok).map((item) => item.entry);
  const failed = settled.filter((item) => !item.ok).map(({ id, error }) => ({ id, error }));
  return { payload: { data: entries }, entries, failed, requestedCount: uniqueIds.length };
}

function inventoryLocalResult(generated) {
  if (!Number.isSafeInteger(generated?.requestedCount)) return null;
  const credentialFailures = Array.isArray(generated.failed) ? generated.failed : [];
  return {
    requested_count: generated.requestedCount,
    source_count: Array.isArray(generated.entries) ? generated.entries.length : 0,
    local_failed_count: credentialFailures.length,
    credential_failures: credentialFailures,
  };
}

async function collectInventoryMailboxes(registration, inboxLinkMailboxes, body = {}) {
  if (body.tokens !== undefined) {
    if (!Array.isArray(body.tokens) || body.tokens.length > 1_000) {
      throw Object.assign(new Error("邮箱凭证 tokens 必须是最多 1000 条的数组"), { status: 400 });
    }
    const tokens = body.tokens.map((token) => {
      if (typeof token !== "string") return token;
      const match = token.trim().match(/^(\S+@\S+)\s+(https:\/\/\S+)$/i);
      return match ? `${match[1]}----${match[2]}` : token;
    });
    return { payload: { tokens }, missing: [], source: "tokens", sourceCount: tokens.length };
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text) {
    if (Buffer.byteLength(text, "utf8") > 900_000) {
      throw Object.assign(new Error("邮箱凭证内容超过 900 KB"), { status: 413 });
    }
    // Accept the convenient `email https://...` spelling used by AliasHub's
    // own link-mailbox pool in addition to nvtokens' `email----https://...`
    // spelling.  Other credential formats are forwarded byte-for-byte.
    const textLines = text.split(/\r?\n/);
    const sourceCount = textLines.filter((line) => line.trim()).length;
    if (sourceCount > 1_000) {
      throw Object.assign(new Error("单次最多导入 1000 个邮箱凭证"), { status: 400 });
    }
    const normalizedText = textLines.map((line) => {
      const match = line.trim().match(/^(\S+@\S+)\s+(https:\/\/\S+)$/i);
      return match ? `${match[1]}----${match[2]}` : line;
    }).join("\n");
    return { payload: { text: normalizedText }, missing: [], source: "text", sourceCount };
  }
  if (body.all_linked === true) {
    if (!inboxLinkMailboxes || typeof inboxLinkMailboxes.exportAllActiveEntries !== "function") {
      throw Object.assign(new Error("链接取件邮箱服务尚未配置"), { status: 503 });
    }
    const exported = inboxLinkMailboxes.exportAllActiveEntries({ maximum: 1_000 });
    const lines = exported.entries.map((item) => `${item.email}----${item.inboxLink}`);
    if (!lines.length) {
      throw Object.assign(new Error("当前没有已启用的链接取件邮箱"), { status: 409 });
    }
    return {
      payload: { text: lines.join("\n") },
      missing: [],
      source: "all_linked",
      sourceCount: lines.length,
    };
  }
  let emails = Array.isArray(body.emails)
    ? body.emails.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
    : [];
  if (Array.isArray(body.ids) && body.ids.length) {
    const ids = inventoryIdList(body.ids, "注册账号");
    const listed = await registration.listRegisteredAccounts({ refreshUnchecked: false });
    const byId = new Map((listed?.items || []).map((item) => [Number(item.id), item]));
    emails = ids.map((id) => String(byId.get(id)?.email || "").trim().toLowerCase()).filter(Boolean);
    const missingAccounts = ids.filter((id) => !byId.has(id));
    if (missingAccounts.length) {
      throw Object.assign(new Error(`部分注册账号不存在：${missingAccounts.join(", ")}`), { status: 404 });
    }
  }
  emails = [...new Set(emails)];
  if (!emails.length) throw Object.assign(new Error("请选择注册账号或粘贴邮箱凭证"), { status: 400 });
  if (emails.length > 1_000) throw Object.assign(new Error("单次最多匹配 1000 个邮箱凭证"), { status: 400 });
  if (!inboxLinkMailboxes || typeof inboxLinkMailboxes.exportEntriesByEmails !== "function") {
    throw Object.assign(new Error("链接取件邮箱服务尚未配置"), { status: 503 });
  }
  const exported = inboxLinkMailboxes.exportEntriesByEmails(emails);
  const lines = exported.entries.map((item) => `${item.email}----${item.inboxLink}`);
  if (!lines.length) {
    throw Object.assign(new Error("所选账号没有已绑定的 HTTPS 取件链接"), {
      status: 409,
      missing_emails: exported.missing,
    });
  }
  return {
    payload: { text: lines.join("\n") },
    missing: exported.missing,
    source: "linked_mailboxes",
    sourceCount: lines.length,
  };
}

export function inboxLinkChatgptStatus(account) {
  if (!account) return null;
  const plan = String(account.account_type || account.plan || "unknown").trim().toLowerCase();
  const credentialStatus = String(account.credential_status || "unknown").trim().toLowerCase();
  const validityStatus = String(account.validity_status || "unknown").trim().toLowerCase();
  const statusCode = String(account.status_code || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const free = plan === "free";
  const atInvalid = ["expired", "revoked", "missing"].includes(credentialStatus)
    || ["invalid", "expired", "revoked"].includes(validityStatus)
    || [
      "access_token_refresh_required",
      "auth_unauthorized_unconfirmed",
      "authentication_unconfirmed",
    ].includes(statusCode)
    || /(?:auth(?:entication)?|access_token|credential|session|token).*(?:expired|revoked|invalid|missing|unauthorized|refresh_required)/.test(statusCode);
  return {
    external_account_id: Number(account.id) || null,
    plan,
    display_status: account.display_status || account.status || "unknown",
    credential_status: credentialStatus,
    validity_status: validityStatus,
    status_code: statusCode,
    at_invalid: atInvalid,
    unlink_recommended: free && atInvalid,
  };
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

function isLocallyImportedAlias(item) {
  return item?.kind === "official" && (
    (item.source_provider === "icloud" && isIcloudImportedStrategy(item.strategy))
    || (item.source_provider === "mailcom" && isMailcomAliasStrategy(item.strategy))
    || (item.source_provider === "netease" && isNeteaseAliasStrategy(item.strategy))
  );
}

function isArchivedMailcomAliasSql(addressTable = "addresses", accountTable = "source_accounts") {
  return `(
    ${accountTable}.provider = 'mailcom'
    AND ${addressTable}.kind = 'official'
    AND ${addressTable}.strategy = 'mailcom_alias'
    AND ${addressTable}.status = 'disabled'
    AND ${addressTable}.remote_confirmed = 0
  )`;
}

function hasActiveAddressRegistration(db, item) {
  if (!item) return false;
  return Boolean(db.prepare(`
    SELECT 1 FROM registration_jobs
    WHERE (
      (
        registration_jobs.account_id = ?
        AND (
          registration_jobs.address_id = ?
          OR registration_jobs.base_address_id = ?
        )
      )
      OR registration_jobs.email = ? COLLATE NOCASE
    )
      AND lower(registration_jobs.status) IN ('queued', 'pending', 'claimed', 'running', 'paused', 'cancel_requested')
    LIMIT 1
  `).get(item.account_id, item.id, item.id, item.address));
}

function hasActiveMailcomPipelineAddress(db, item) {
  if (!item || item.source_provider !== "mailcom") return false;
  return Boolean(db.prepare(`
    SELECT 1
    FROM mailcom_registration_pipeline_items AS items
    JOIN mailcom_registration_pipelines AS pipelines ON pipelines.id = items.pipeline_id
    WHERE pipelines.status IN ('queued', 'running', 'cancel_requested')
      AND items.status IN ('queued', 'running', 'retry_wait', 'cancel_requested')
      AND items.account_id = ?
      AND (
        items.current_address_id = ?
        OR items.current_email = ? COLLATE NOCASE
        OR items.initial_email = ? COLLATE NOCASE
      )
    LIMIT 1
  `).get(item.account_id, item.id, item.address, item.address));
}

function activeMailcomPipelineReference(db, items, { accountId = null } = {}) {
  const mailcomItems = (items || []).filter((item) => item?.source_provider === "mailcom");
  const normalizedAccountId = Number(accountId);
  const accountWide = Number.isSafeInteger(normalizedAccountId) && normalizedAccountId > 0;
  if (!accountWide && !mailcomItems.length) return null;
  const addressIds = new Set(mailcomItems.map((item) => Number(item.id)).filter(Number.isSafeInteger));
  const emails = new Set(mailcomItems
    .map((item) => String(item.address || "").trim().toLowerCase())
    .filter(Boolean));
  const references = db.prepare(`
    SELECT pipelines.id AS pipeline_id, pipelines.status AS pipeline_status,
      items.id AS item_id, items.account_id, items.source_email,
      items.initial_address_id, items.initial_email,
      items.current_address_id, items.current_email, items.replacement_email,
      attempts.address_id AS attempt_address_id, attempts.email AS attempt_email,
      attempts.replacement_address_id AS attempt_replacement_address_id,
      attempts.replacement_email AS attempt_replacement_email
    FROM mailcom_registration_pipeline_items AS items
    JOIN mailcom_registration_pipelines AS pipelines ON pipelines.id = items.pipeline_id
    LEFT JOIN mailcom_registration_pipeline_attempts AS attempts
      ON attempts.id = items.current_attempt_id AND attempts.item_id = items.id
    WHERE pipelines.status IN ('queued', 'running', 'cancel_requested')
  `).all();
  const matchesId = (value) => value != null && addressIds.has(Number(value));
  const matchesEmail = (value) => emails.has(String(value || "").trim().toLowerCase());
  return references.find((reference) => (
    (accountWide && Number(reference.account_id) === normalizedAccountId)
    || matchesId(reference.initial_address_id)
    || matchesId(reference.current_address_id)
    || matchesId(reference.attempt_address_id)
    || matchesId(reference.attempt_replacement_address_id)
    || matchesEmail(reference.source_email)
    || matchesEmail(reference.initial_email)
    || matchesEmail(reference.current_email)
    || matchesEmail(reference.replacement_email)
    || matchesEmail(reference.attempt_email)
    || matchesEmail(reference.attempt_replacement_email)
  )) || null;
}

function assertNoActiveMailcomPipelineReference(db, items, {
  accountId = null,
  message = "这个 Mail.com 邮箱正被无限注册提链流水线使用，请先取消并等待流水线结束",
} = {}) {
  if (!activeMailcomPipelineReference(db, items, { accountId })) return;
  throw Object.assign(new Error(message), {
    status: 409,
    code: "MAILCOM_PIPELINE_DELETE_CONFLICT",
  });
}

async function assertAddressRemovalAllowed(db, pickup, items, {
  activeMessage = "所选地址中有邮箱正在注册，请等待任务结束后再删除",
  inventoryMessage = "所选邮箱包含取件站售卖库存，请先从取件站下架",
  mailcomPipelineMessage = "这个 Mail.com 邮箱正被无限注册提链流水线使用，请先取消并等待流水线结束",
  mailcomAccountId = null,
  checkActive = true,
  checkInventoryForAll = false,
  refreshItems = null,
} = {}) {
  assertNoActiveMailcomPipelineReference(db, items, {
    accountId: mailcomAccountId,
    message: mailcomPipelineMessage,
  });
  if (checkActive && items.some((item) => (
    hasActiveAddressRegistration(db, item) || hasActiveMailcomPipelineAddress(db, item)
  ))) {
    throw Object.assign(new Error(activeMessage), { status: 409, code: "MAILCOM_PIPELINE_ADDRESS_BUSY" });
  }
  let checkedItems = items;
  let inventoryCandidates = checkInventoryForAll ? checkedItems : checkedItems.filter(isLocallyImportedAlias);
  if (!inventoryCandidates.length || !pickup.registrationProtectionEnabled()) return;
  const inventory = await pickup.listStatuses();
  if (typeof refreshItems === "function") {
    checkedItems = refreshItems();
    inventoryCandidates = checkInventoryForAll ? checkedItems : checkedItems.filter(isLocallyImportedAlias);
  }
  assertNoActiveMailcomPipelineReference(db, checkedItems, {
    accountId: mailcomAccountId,
    message: mailcomPipelineMessage,
  });
  const listed = new Set((inventory.items || [])
    .filter((item) => ["ready", "sold"].includes(String(item.status || "").toLowerCase()))
    .map((item) => String(item.email || "").toLowerCase()));
  if (inventoryCandidates.some((item) => listed.has(String(item.address || "").toLowerCase()))) {
    throw Object.assign(new Error(inventoryMessage), { status: 409 });
  }
  if (checkActive && checkedItems.some((item) => (
    hasActiveAddressRegistration(db, item) || hasActiveMailcomPipelineAddress(db, item)
  ))) {
    throw Object.assign(new Error(activeMessage), { status: 409, code: "MAILCOM_PIPELINE_ADDRESS_BUSY" });
  }
}

function addressQuery(db, { accountId, kind, strategy, q, page = 1, limit = 50 } = {}) {
  const conditions = [
    "source_accounts.provider <> 'inbox_link'",
    `NOT ${isArchivedMailcomAliasSql()}`,
  ];
  const params = [];
  if (accountId) { conditions.push("addresses.account_id = ?"); params.push(Number(accountId)); }
  if (kind && kind !== "all") { conditions.push("addresses.kind = ?"); params.push(kind); }
  if (strategy) { conditions.push("addresses.strategy = ?"); params.push(String(strategy)); }
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
      parent.address AS parent_address,
      CASE WHEN EXISTS (
        SELECT 1
        FROM registration_jobs AS registration_history
        WHERE (
          registration_history.address_id = addresses.id
          OR (
            addresses.kind IN ('primary', 'official')
            AND registration_history.base_address_id = addresses.id
            AND registration_history.email = addresses.address COLLATE NOCASE
          )
        )
          AND lower(registration_history.status) = 'failed'
          AND registration_history.failure_reason = 'user_already_exists'
      ) THEN 1 ELSE 0 END AS registration_occupied,
      (
        SELECT COUNT(*)
        FROM registration_jobs AS failed_registration
        WHERE (
          failed_registration.address_id = addresses.id
          OR (
            addresses.kind IN ('primary', 'official')
            AND failed_registration.base_address_id = addresses.id
            AND failed_registration.email = addresses.address COLLATE NOCASE
          )
        )
          AND lower(failed_registration.status) = 'failed'
      ) AS registration_failure_count,
      COALESCE((
        SELECT lower(latest_registration.status)
        FROM registration_jobs AS latest_registration
        WHERE latest_registration.address_id = addresses.id
          OR (
            addresses.kind IN ('primary', 'official')
            AND latest_registration.base_address_id = addresses.id
            AND latest_registration.email = addresses.address COLLATE NOCASE
          )
        ORDER BY COALESCE(latest_registration.finished_at, latest_registration.updated_at, latest_registration.created_at) DESC,
          latest_registration.id DESC
        LIMIT 1
      ), '') AS last_registration_status
    FROM addresses
    JOIN source_accounts ON source_accounts.id = addresses.account_id
    LEFT JOIN addresses parent ON parent.id = addresses.parent_address_id
    WHERE ${where}
    ORDER BY CASE addresses.kind WHEN 'primary' THEN 0 WHEN 'official' THEN 1 ELSE 2 END, addresses.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit)
    .map((item) => ({
      ...item,
      registration_occupied: Boolean(item.registration_occupied),
      registration_failure_count: Number(item.registration_failure_count) || 0,
      registration_failed: item.last_registration_status === "failed",
    }));
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

function failedRegistrationAddressIds(db, { accountId, kind, strategy, q } = {}) {
  const conditions = [
    "source_accounts.provider <> 'inbox_link'",
    `NOT ${isArchivedMailcomAliasSql()}`,
    `(addresses.kind = 'split' OR (
      source_accounts.provider = 'icloud'
      AND addresses.kind = 'official'
      AND addresses.strategy IN ('icloud_mail_alias', 'icloud_hide_my_email', 'icloud_custom_domain')
    ) OR (
      source_accounts.provider = 'mailcom'
      AND addresses.kind = 'official'
      AND addresses.strategy = 'mailcom_alias'
    ) OR (
      source_accounts.provider = 'netease'
      AND addresses.kind = 'official'
      AND addresses.strategy = 'netease_alias'
    ))`,
    `COALESCE((
      SELECT lower(latest_registration.status)
      FROM registration_jobs AS latest_registration
      WHERE latest_registration.address_id = addresses.id
        OR (
          addresses.kind IN ('primary', 'official')
          AND latest_registration.base_address_id = addresses.id
          AND latest_registration.email = addresses.address COLLATE NOCASE
        )
      ORDER BY COALESCE(latest_registration.finished_at, latest_registration.updated_at, latest_registration.created_at) DESC,
        latest_registration.id DESC
      LIMIT 1
    ), '') = 'failed'`,
  ];
  const params = [];
  if (accountId) { conditions.push("addresses.account_id = ?"); params.push(Number(accountId)); }
  if (kind && kind !== "all") { conditions.push("addresses.kind = ?"); params.push(kind); }
  if (strategy) { conditions.push("addresses.strategy = ?"); params.push(String(strategy)); }
  if (q) {
    conditions.push("(addresses.address LIKE ? OR addresses.label LIKE ? OR addresses.purpose LIKE ? OR source_accounts.email LIKE ?)");
    const term = `%${q}%`;
    params.push(term, term, term, term);
  }
  const ids = db.prepare(`
    SELECT addresses.id
    FROM addresses
    JOIN source_accounts ON source_accounts.id = addresses.account_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY addresses.created_at DESC, addresses.id DESC
    LIMIT 5000
  `).all(...params).map((item) => Number(item.id));
  return { ids, count: ids.length };
}

function publicMessage(row, { includeBody = false } = {}) {
  if (!row) return null;
  const storedContentType = String(row.body_content_type || "text").toLowerCase();
  const bodyContentType = storedContentType === "html"
    || /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(String(row.body || ""))
    ? "html"
    : "text";
  const item = {
    ...row,
    body_content_type: bodyContentType,
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
    SELECT mail_messages.*, source_accounts.email AS source_email, source_accounts.provider AS source_provider,
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
    SELECT mail_messages.*, source_accounts.email AS source_email, source_accounts.provider AS source_provider,
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
  const mailcom = options.mailcom || new MailComImapClient({
    db,
    encryptionKey: options.dataEncryptionKey || process.env.DATA_ENCRYPTION_KEY,
    imapFactory: options.mailcomImapFactory,
    parseMessage: options.mailcomParseMessage,
  });
  const netease = options.netease || new NeteaseImapClient({
    db,
    encryptionKey: options.dataEncryptionKey || process.env.DATA_ENCRYPTION_KEY,
    imapFactory: options.neteaseImapFactory,
    parseMessage: options.neteaseParseMessage,
  });
  const mailcomAliases = options.mailcomAliases || new MailcomAliasAutomationService({
    db,
    mailcom,
    adapter: options.mailcomAliasAdapter || new MailcomAliasPlaywrightAdapter({
      browserExecutable: options.mailcomBrowserExecutable,
      headless: options.mailcomAliasHeadless,
      loginTimeoutMs: options.mailcomAliasLoginTimeoutMs,
      requestTimeoutMs: options.mailcomAliasRequestTimeoutMs,
      cleanupTimeoutMs: options.mailcomAliasCleanupTimeoutMs,
      browserSemaphore: options.mailcomAliasBrowserSemaphore,
      maxConcurrentBrowsers: options.mailcomAliasMaxBrowsers,
      browserWaitTimeoutMs: options.mailcomAliasBrowserWaitTimeoutMs,
      openTimeoutMs: options.mailcomAliasOpenTimeoutMs,
      openAttempts: options.mailcomAliasOpenAttempts,
      retryDelayMs: options.mailcomAliasRetryDelayMs,
    }),
    randomBytesFn: options.mailcomAliasRandomBytesFn,
    maxValidationAttempts: options.mailcomAliasMaxValidationAttempts,
    confirmationAttempts: options.mailcomAliasConfirmationAttempts,
    confirmationIntervalMs: options.mailcomAliasConfirmationIntervalMs,
    sleepFn: options.mailcomAliasSleepFn,
  });
  const inboxLinkMailboxes = options.inboxLinkMailboxes || new InboxLinkMailboxService({
    db,
    encryptionKey: options.dataEncryptionKey ?? process.env.DATA_ENCRYPTION_KEY,
    fetchFn: options.inboxLinkFetchFn || options.fetchFn,
    apiBase: options.inboxLinkApiBase,
  });
  const inbox = options.inbox || {
    scanInbox(account) {
      if (account.provider === "google") return gmail.scanInbox(account);
      if (account.provider === "microsoft") return graph.scanInbox(account);
      if (account.provider === "icloud") return icloud.scanInbox(account);
      if (account.provider === "mailcom") return mailcom.scanInbox(account);
      if (account.provider === "netease") return netease.scanInbox(account);
      if (account.provider === "inbox_link") return inboxLinkMailboxes.scanInbox(account);
      throw Object.assign(new Error(`不支持的邮箱提供商：${account.provider}`), {
        status: 409,
        code: "UNSUPPORTED_MAIL_PROVIDER",
      });
    },
  };
  const extension = options.extension || new ExtensionService(db);
  const jobs = new JobRunner(db, inbox);
  const publicBaseUrl = options.publicBaseUrl || process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4180}`;
  const icloudPrivacyInternalKey = String(
    options.icloudPrivacyInternalKey || process.env.ICLOUD_PRIVACY_INTERNAL_KEY || "",
  ).trim();
  const icloudPrivacy = options.icloudPrivacy || options.icloudPrivacyClient || new IcloudPrivacyClient({
    baseUrl: options.icloudPrivacyBaseUrl || process.env.ICLOUD_PRIVACY_SERVICE_URL,
    internalKey: icloudPrivacyInternalKey,
    fetchFn: options.icloudPrivacyFetchFn || options.fetchFn,
    requestTimeoutMs: options.icloudPrivacyRequestTimeoutMs,
    createTimeoutMs: options.icloudPrivacyCreateTimeoutMs,
  });
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
    inboxLinkMailboxes,
    pickup: options.pickup || null,
    checkoutProbe: options.checkoutProbe,
    checkoutProxyResolver: options.checkoutProxyResolver,
    trialProbe: options.trialProbe,
    trialProxyResolver: options.trialProxyResolver,
    gbTrialProbe: options.gbTrialProbe,
    gbTrialProxyResolver: options.gbTrialProxyResolver,
    usTrialProbe: options.usTrialProbe,
    usTrialProxyResolver: options.usTrialProxyResolver,
    usDirectCountryProbe: options.usDirectCountryProbe,
    momoProbe: options.momoProbe,
    momoProxyResolver: options.momoProxyResolver,
  });
  const pickup = options.pickup || new PickupService({
    db,
    registration,
    baseUrl: options.pickupBaseUrl || process.env.PICKUP_SERVICE_URL,
    publicUrl: options.pickupPublicUrl || process.env.PICKUP_PUBLIC_URL || process.env.PICKUP_PUBLIC_BASE_URL,
    username: options.pickupUsername || process.env.PICKUP_ADMIN_USERNAME || process.env.ADMIN_USERNAME,
    password: options.pickupPassword || process.env.PICKUP_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD,
    fetchFn: options.pickupFetchFn || options.fetchFn,
  });
  registration.pickup = pickup;
  mailcomAliases.setPickup?.(pickup);
  const paymentLinks = options.paymentLinks || new PaymentLinkService({
    db,
    registration,
    baseUrl: options.paymentLinkBaseUrl ?? process.env.PAYMENT_LINK_SERVICE_URL,
    password: options.paymentLinkPassword ?? process.env.PAYMENT_LINK_SERVICE_PASSWORD,
    fetchFn: options.paymentLinkFetchFn || options.fetchFn,
    pollIntervalMs: options.paymentLinkPollIntervalMs,
    timeoutMs: options.paymentLinkTimeoutMs,
    queueTimeoutMs: options.paymentLinkQueueTimeoutMs,
  });
  registration.paymentLinks = paymentLinks;
  const paymentAgreements = options.paymentAgreements || new PaymentAgreementService({
    db,
    encryptionKey: options.dataEncryptionKey || process.env.DATA_ENCRYPTION_KEY,
    baseUrl: options.paymentAgreementBaseUrl || process.env.PAYMENT_AGREEMENT_SERVICE_URL,
    heroSmsEndpoint: options.heroSmsEndpoint || process.env.HEROSMS_ENDPOINT,
    fetchFn: options.paymentAgreementFetchFn || options.fetchFn,
    pollIntervalMs: options.paymentAgreementPollIntervalMs,
    requestTimeoutMs: options.paymentAgreementRequestTimeoutMs,
  });
  const mailcomRegistrationPipelines = options.mailcomRegistrationPipelines
    || new MailcomRegistrationPipelineService({
      db,
      registration,
      paymentLinks,
      paymentAgreements,
      mailcomAliases,
      pollIntervalMs: options.mailcomRegistrationPipelinePollIntervalMs,
      retryBaseMs: options.mailcomRegistrationPipelineRetryBaseMs,
      retryMaximumMs: options.mailcomRegistrationPipelineRetryMaximumMs,
      trialCheckConcurrency: options.mailcomRegistrationPipelineTrialCheckConcurrency
        ?? process.env.MAILCOM_REGISTRATION_PIPELINE_TRIAL_CHECK_CONCURRENCY,
      trialCheckAttemptLimit: options.mailcomRegistrationPipelineTrialCheckAttemptLimit
        ?? process.env.MAILCOM_REGISTRATION_PIPELINE_TRIAL_CHECK_ATTEMPT_LIMIT,
      aliasOperationConcurrency: options.mailcomRegistrationPipelineAliasOperationConcurrency
        ?? process.env.MAILCOM_REGISTRATION_PIPELINE_ALIAS_OPERATION_CONCURRENCY,
      sleepFn: options.mailcomRegistrationPipelineSleepFn,
    });
  const icRegistrationPipelines = options.icRegistrationPipelines || new IcRegistrationPipelineService({
    db,
    registration,
    paymentLinks,
    paymentAgreements,
    icloudPrivacy,
    pollIntervalMs: options.icRegistrationPipelinePollIntervalMs,
  });
  const openAiSms = options.openAiSms || new OpenAiSmsService({
    db,
    registration,
    client: registrationClient,
    paymentAgreements,
    publicBaseUrl,
    sleepFn: options.openAiSmsSleepFn,
    nowFn: options.openAiSmsNowFn,
    remotePollIntervalMs: options.openAiSmsRemotePollIntervalMs,
    remoteFailureLimit: options.openAiSmsRemoteFailureLimit,
    relayRateLimit: options.openAiSmsRelayRateLimit,
    relayRateWindowMs: options.openAiSmsRelayRateWindowMs,
    countryFetchFn: options.openAiSmsCountryFetchFn || options.fetchFn,
    countryRankUrl: options.openAiSmsCountryRankUrl,
    countryCacheTtlMs: options.openAiSmsCountryCacheTtlMs,
    countryStaleTtlMs: options.openAiSmsCountryStaleTtlMs,
    countryRequestTimeoutMs: options.openAiSmsCountryRequestTimeoutMs,
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
  const inventory = options.inventory || new InventoryApiService({
    db,
    encryptionKey: options.dataEncryptionKey || process.env.DATA_ENCRYPTION_KEY,
    fetchFn: options.inventoryFetchFn || options.fetchFn,
    cardsUrl: options.inventoryCardsUrl || process.env.NVTOKENS_CARDS_IMPORT_URL,
    mailboxesUrl: options.inventoryMailboxesUrl || process.env.NVTOKENS_MAILBOXES_IMPORT_URL,
    poolUrl: options.inventoryPoolUrl || process.env.NVTOKENS_CARDS_POOL_URL,
    apiKey: options.inventoryApiKey || process.env.NVTOKENS_API_KEY,
    timeoutMs: options.inventoryTimeoutMs || process.env.NVTOKENS_API_TIMEOUT_MS,
    allowHttp: options.inventoryAllowHttp === true,
  });
  let nfapiCredentialSync = Object.hasOwn(options, "nfapiCredentialSync")
    ? options.nfapiCredentialSync : null;
  if (!Object.hasOwn(options, "nfapiCredentialSync")
    && !options.registrationClient
    && typeof nfapi.client === "function") {
    const store = options.nfapiCredentialStore || new NfapiCredentialStore();
    nfapiCredentialSync = new NfapiCredentialSync({
      db,
      store,
      registrationClient,
      nfapiClientFactory: () => nfapi.client(),
      nfapiBaseUrl: () => nfapi.baseUrl(),
    });
  }
  registration.nfapiCredentialSync = nfapiCredentialSync;
  const microsoftRegistration = options.microsoftRegistration || new MicrosoftRegistrationService({
    db,
    encryptionKey: options.dataEncryptionKey ?? process.env.DATA_ENCRYPTION_KEY,
  });
  const microsoftRegistrationProxyPoolService = options.microsoftRegistrationProxyPoolService || options.proxyPoolService || registration;
  const microsoftRegistrationRunner = options.microsoftRegistrationRunner || new MicrosoftRegistrationRunnerService({
    db,
    dataDir,
    encryptionKey: options.dataEncryptionKey ?? process.env.DATA_ENCRYPTION_KEY,
    toolDir: options.microsoftRegistrationRunnerDir,
    wineBinary: options.microsoftRegistrationWineBinary,
    xvfbBinary: options.microsoftRegistrationXvfbBinary,
    registrationService: microsoftRegistration,
    proxyProvider: () => registration.getProxyPool(),
    proxyPoolService: microsoftRegistrationProxyPoolService,
    spawnFn: options.microsoftRegistrationSpawnFn,
    waitForPort: options.microsoftRegistrationWaitForPort,
  });
  microsoftRegistrationRunner.setProxyProvider?.(() => registration.getProxyPool());
  microsoftRegistrationRunner.setProxyPoolService?.(microsoftRegistrationProxyPoolService);
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

  const requireIcloudPrivacyInternalKey = (req, res, next) => {
    const supplied = String(req.get("X-Alias-Hub-Internal-Key") || "");
    const expected = icloudPrivacyInternalKey;
    const suppliedBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(expected);
    const valid = suppliedBuffer.length === expectedBuffer.length
      && expectedBuffer.length > 0
      && timingSafeEqual(suppliedBuffer, expectedBuffer);
    if (!valid) return res.status(401).json({ error: "内部接口认证失败" });
    return next();
  };
  app.use("/api/internal/icloud-privacy", requireIcloudPrivacyInternalKey);
  app.post("/api/internal/icloud-privacy/import", (req, res, next) => {
    try {
      const sourceAccountId = Number(req.body?.source_account_id);
      if (!Number.isSafeInteger(sourceAccountId) || sourceAccountId <= 0) {
        throw Object.assign(new Error("源头邮箱 ID 无效"), { status: 400 });
      }
      const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(sourceAccountId);
      if (!account) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
      const sourceAppleId = normalizeIcloudAliasEmail(req.body?.source_apple_id);
      if (sourceAppleId && sourceAppleId !== String(account.email || "").toLowerCase()) {
        throw Object.assign(new Error("Apple ID 与所选源头邮箱不一致"), { status: 409 });
      }
      const emails = Array.isArray(req.body?.emails) ? req.body.emails : [];
      importIcloudAliases(db, account, emails, {
        type: "hide_my_email",
        replace: false,
        purpose: "Apple 新接口创建",
        remoteConfirmed: true,
      });
      const normalized = [...new Set(emails.map(normalizeIcloudAliasEmail).filter(Boolean))];
      const items = normalized.length ? db.prepare(`
        SELECT * FROM addresses
        WHERE account_id = ? AND strategy = 'icloud_hide_my_email'
          AND address IN (${normalized.map(() => "?").join(",")})
        ORDER BY created_at DESC
      `).all(sourceAccountId, ...normalized) : [];
      res.json({ imported: items.length, items });
    } catch (error) { next(error); }
  });
  app.delete("/api/internal/icloud-privacy/address", async (req, res, next) => {
    try {
      const sourceAccountId = Number(req.body?.source_account_id);
      const email = normalizeIcloudAliasEmail(req.body?.email);
      if (!Number.isSafeInteger(sourceAccountId) || sourceAccountId <= 0 || !email) {
        throw Object.assign(new Error("源头邮箱 ID 或隐藏邮箱无效"), { status: 400 });
      }
      const item = db.prepare(`
        SELECT * FROM addresses
        WHERE account_id = ? AND address = ? COLLATE NOCASE
          AND kind = 'official' AND strategy = 'icloud_hide_my_email'
      `).get(sourceAccountId, email);
      if (!item) return res.json({ deleted: 0 });
      if (pickup.registrationProtectionEnabled()) {
        const inventory = await pickup.listStatuses();
        const listed = (inventory.items || []).find((entry) => String(entry.email || "").toLowerCase() === email);
        if (listed && ["ready", "sold"].includes(listed.status)) {
          throw Object.assign(new Error("这个隐藏邮箱已进入售卖库存，请先从取件站下架"), { status: 409 });
        }
      }
      db.prepare("DELETE FROM addresses WHERE id = ?").run(item.id);
      audit(db, sourceAccountId, "alias", "删除隐藏邮箱创建记录", email, { apple_remote_deleted: false });
      return res.json({ deleted: 1 });
    } catch (error) { return next(error); }
  });

  registerEzCaptchaAdapter({
    app,
    db,
    fetchFn: options.captchaFetchFn || options.fetchFn || fetch,
  });

  app.get("/api/extension/download", auth.requireAdmin, (_req, res, next) => {
    const archive = path.join(projectRoot, "release", "aliashub-outlook-extension.zip");
    if (!fs.existsSync(archive)) return next(Object.assign(new Error("浏览器扩展安装包尚未生成"), { status: 404 }));
    return res.download(archive, "aliashub-outlook-extension.zip");
  });
  app.get("/api/microsoft-registration/download", auth.requireAdmin, (_req, res, next) => {
    const archive = path.join(projectRoot, "release", "go-language-microsoft-registration-v9.2.8.zip");
    if (!fs.existsSync(archive)) return next(Object.assign(new Error("微软注册机安装包尚未上传"), { status: 404 }));
    return res.download(archive, "go-language-microsoft-registration-v9.2.8.zip");
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

  app.post("/api/integrations/microsoft-register/v1/ingest/:token", (req, res, next) => {
    try { res.status(202).json(microsoftRegistration.ingest(req.params.token, req.body)); } catch (error) { next(error); }
  });
  app.post("/api/integrations/microsoft-register/v1/runner/:runId/:token", (req, res, next) => {
    try { res.status(202).json(microsoftRegistrationRunner.ingest(req.params.runId, req.params.token, req.body, microsoftRegistration)); } catch (error) { next(error); }
  });

  app.use("/api/external", registration.requireConnectorKey.bind(registration));
  app.get("/api/external/accounts", (req, res, next) => {
    try { res.json(registration.externalAccounts(req.query)); } catch (error) { next(error); }
  });
  app.get("/api/external/emails", async (req, res, next) => {
    try { res.json(await registration.externalEmails(req.query)); } catch (error) { next(error); }
  });

  app.get("/api/registration/openai-sms/relay/:token", async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await openAiSms.relay(req.params.token, { requestResend: req.query.resend === "1" }));
    } catch (error) { next(error); }
  });

  app.use("/api", auth.requireAdmin);

  app.get(/^\/paypal-pay$/, auth.requireAdmin, (_req, res) => {
    res.redirect(307, "/alias-hub/paypal-pay/");
  });
  app.all("/paypal-pay/*", auth.requireAdmin, async (req, res, next) => {
    try {
      const result = await paymentAgreements.proxyWorkbench(req);
      return sendProxyResult(res, result);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/microsoft-registration/config", (_req, res) => {
    res.json(microsoftRegistration.configuration(publicBaseUrl));
  });
  app.get("/api/microsoft-registration/runner", (_req, res) => {
    res.json(microsoftRegistrationRunner.configuration());
  });
  app.put("/api/microsoft-registration/runner/config", (req, res, next) => {
    try { res.json(microsoftRegistrationRunner.saveConfiguration(req.body || {})); } catch (error) { next(error); }
  });
  app.delete("/api/microsoft-registration/runner/proxy", (_req, res, next) => {
    try { res.json(microsoftRegistrationRunner.clearProxyConfiguration()); } catch (error) { next(error); }
  });
  app.post("/api/microsoft-registration/runner/saved-proxies", (req, res, next) => {
    try { res.status(201).json(microsoftRegistrationRunner.saveSavedProxy(req.body || {})); } catch (error) { next(error); }
  });
  app.delete("/api/microsoft-registration/runner/saved-proxies/:id", (req, res, next) => {
    try { res.json(microsoftRegistrationRunner.deleteSavedProxy(req.params.id)); } catch (error) { next(error); }
  });
  app.post("/api/microsoft-registration/runner/start", async (_req, res, next) => {
    try { res.status(202).json({ run: await microsoftRegistrationRunner.start(publicBaseUrl) }); } catch (error) { next(error); }
  });
  app.post("/api/microsoft-registration/runner/stop", (req, res, next) => {
    try { res.json(microsoftRegistrationRunner.stop(req.body || {})); } catch (error) { next(error); }
  });
  app.get("/api/microsoft-registration/runner/logs", (req, res, next) => {
    try { res.json(microsoftRegistrationRunner.logs(req.query)); } catch (error) { next(error); }
  });
  app.post("/api/microsoft-registration/webhook-token", (_req, res, next) => {
    try { res.status(201).json(microsoftRegistration.rotateWebhookToken(publicBaseUrl)); } catch (error) { next(error); }
  });
  app.get("/api/microsoft-registration/accounts", (req, res, next) => {
    try { res.json(microsoftRegistration.listAccounts(req.query)); } catch (error) { next(error); }
  });
  app.get("/api/microsoft-registration/accounts/:id/credentials", (req, res, next) => {
    try { res.json(microsoftRegistration.credentials(req.params.id)); } catch (error) { next(error); }
  });
  app.post("/api/microsoft-registration/accounts/:id/add-source", (req, res, next) => {
    try { res.json(microsoftRegistration.addSourceAccount(req.params.id)); } catch (error) { next(error); }
  });
  app.delete("/api/microsoft-registration/accounts/:id", (req, res, next) => {
    try { res.json(microsoftRegistration.deleteAccount(req.params.id)); } catch (error) { next(error); }
  });

  app.get("/api/registration/options", async (_req, res, next) => {
    try { res.json(await registration.options()); } catch (error) { next(error); }
  });
  app.get("/api/inbox-link-mailboxes", async (_req, res, next) => {
    try {
      const data = inboxLinkMailboxes.list();
      let registeredAccounts = [];
      try {
        const registered = await registration.listRegisteredAccounts({ refreshUnchecked: false });
        registeredAccounts = registered.items || [];
      } catch {
        // The link pool remains manageable when the registration service is temporarily unavailable.
      }
      const accountByEmail = new Map(registeredAccounts.map((item) => [String(item.email || "").toLowerCase(), item]));
      data.items = data.items.map((item) => {
        const chatgpt = inboxLinkChatgptStatus(accountByEmail.get(item.email.toLowerCase()));
        return {
          ...item,
          chatgpt,
          unlink_recommended: Boolean(chatgpt?.unlink_recommended),
        };
      });
      data.free_invalid_at = data.items.filter((item) => item.unlink_recommended).length;
      data.account_status_ready = registeredAccounts.length > 0;
      res.json(data);
    } catch (error) { next(error); }
  });
  app.post("/api/inbox-link-mailboxes/import", (req, res, next) => {
    try { res.status(201).json(inboxLinkMailboxes.import(req.body || {})); } catch (error) { next(error); }
  });
  const deleteInboxLinkMailboxes = async (input = {}) => {
    const rows = inboxLinkMailboxes.validateBulkDelete(input);
    const latestCompletedAccount = db.prepare(`
      SELECT external_account_id
      FROM registration_jobs
      WHERE lower(email) = lower(?)
        AND status = 'completed' AND external_account_id <> ''
      ORDER BY id DESC LIMIT 1
    `);
    const accountIdByMailboxId = new Map();
    for (const row of rows) {
      const externalAccountId = Number(latestCompletedAccount.get(row.email)?.external_account_id) || 0;
      if (externalAccountId) accountIdByMailboxId.set(Number(row.id), externalAccountId);
    }
    const accountIds = [...new Set(accountIdByMailboxId.values())];
    let gptResult = { requested: 0, deleted: 0, failed: [] };
    if (accountIds.length) {
      gptResult = await registration.deleteRegisteredAccounts({ ids: accountIds });
    }
    const failedAccountIds = new Set((gptResult.failed || []).map((item) => Number(item.id)));
    const removableIds = rows
      .filter((row) => {
        const accountId = accountIdByMailboxId.get(Number(row.id));
        return !accountId || !failedAccountIds.has(accountId);
      })
      .map((row) => Number(row.id));
    const bindings = removableIds.length
      ? inboxLinkMailboxes.bulkDelete({ ids: removableIds })
      : { deleted: 0, items: [] };
    return {
      requested: rows.length,
      deleted: bindings.deleted,
      items: bindings.items,
      gpt_requested: accountIds.length,
      gpt_deleted: Number(gptResult.deleted) || 0,
      gpt_failed: gptResult.failed || [],
    };
  };
  app.post("/api/inbox-link-mailboxes/bulk-delete", async (req, res, next) => {
    try { res.json(await deleteInboxLinkMailboxes(req.body || {})); } catch (error) { next(error); }
  });
  app.delete("/api/inbox-link-mailboxes/:id", async (req, res, next) => {
    try {
      const result = await deleteInboxLinkMailboxes({ ids: [req.params.id] });
      res.json({ ...result.items[0], gpt_deleted: result.gpt_deleted, gpt_failed: result.gpt_failed });
    } catch (error) { next(error); }
  });
  app.get("/api/pickup/config", (_req, res) => {
    res.json(pickup.configuration());
  });
  app.get("/api/pickup/statuses", async (_req, res, next) => {
    try { res.json(await pickup.listStatuses()); }
    catch (error) { next(error); }
  });
  app.get("/api/pickup/source-addresses", (_req, res, next) => {
    try { res.json(pickup.listSourceAddresses()); }
    catch (error) { next(error); }
  });
  app.post("/api/pickup/import-addresses", async (req, res, next) => {
    try { res.json(await pickup.importSourceAddresses(req.body || {})); }
    catch (error) { next(error); }
  });
  app.post("/api/pickup/import-accounts", async (req, res, next) => {
    try { res.json(await pickup.importRegisteredAccounts(req.body || {})); }
    catch (error) { next(error); }
  });
  app.get("/api/registration/payment-links", (_req, res, next) => {
    try { res.json(paymentLinks.list()); } catch (error) { next(error); }
  });
  app.put("/api/registration/payment-links/proxies", (req, res, next) => {
    try { res.json(paymentLinks.saveProxyPool(req.body || {})); } catch (error) { next(error); }
  });
  app.post("/api/registration/payment-links/proxy-source", async (req, res, next) => {
    try { res.json(await paymentLinks.refreshProxySource(req.body || {})); } catch (error) { next(error); }
  });
  app.post("/api/registration/payment-links/tasks", async (req, res, next) => {
    try { res.status(202).json(await paymentLinks.start(req.body || {})); } catch (error) { next(error); }
  });
  app.get("/api/registration/payment-agreements/runtime", (_req, res, next) => {
    try { res.json(paymentAgreements.runtime()); } catch (error) { next(error); }
  });
  app.put("/api/registration/payment-agreements/runtime", (req, res, next) => {
    try { res.json(paymentAgreements.updateRuntime(req.body || {})); } catch (error) { next(error); }
  });
  app.get("/api/registration/payment-agreements/settings", (_req, res, next) => {
    try { res.json(paymentAgreements.settings()); } catch (error) { next(error); }
  });
  app.put("/api/registration/payment-agreements/settings", (req, res, next) => {
    try { res.json(paymentAgreements.updateSettings(req.body || {})); } catch (error) { next(error); }
  });
  app.post("/api/registration/payment-agreements/test", async (_req, res, next) => {
    try { res.json(await paymentAgreements.heroBalance()); } catch (error) { next(error); }
  });
  app.get("/api/registration/ic-pipelines", (req, res, next) => {
    try { res.json(icRegistrationPipelines.list(req.query || {})); } catch (error) { next(error); }
  });
  app.post("/api/registration/ic-pipelines", async (req, res, next) => {
    try { res.status(202).json(await icRegistrationPipelines.start(req.body || {})); } catch (error) { next(error); }
  });
  app.get("/api/registration/ic-pipelines/mailbox-status", async (_req, res, next) => {
    try { res.json(await icRegistrationPipelines.mailboxStatus()); } catch (error) { next(error); }
  });
  app.get("/api/registration/ic-pipelines/:id", (req, res, next) => {
    try { res.json(icRegistrationPipelines.get(req.params.id)); } catch (error) { next(error); }
  });
  app.post("/api/registration/ic-pipelines/:id/cancel", async (req, res, next) => {
    try { res.json(await icRegistrationPipelines.cancel(req.params.id)); } catch (error) { next(error); }
  });
  app.get("/api/registration/mailcom-pipelines/status", async (_req, res, next) => {
    try { res.json(await mailcomRegistrationPipelines.status()); } catch (error) { next(error); }
  });
  app.get("/api/registration/mailcom-pipelines", (req, res, next) => {
    try { res.json(mailcomRegistrationPipelines.list(req.query || {})); } catch (error) { next(error); }
  });
  app.post("/api/registration/mailcom-pipelines", async (req, res, next) => {
    try { res.status(202).json(await mailcomRegistrationPipelines.start(req.body || {})); } catch (error) { next(error); }
  });
  app.get("/api/registration/mailcom-pipelines/:id/successful-accounts", (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(mailcomRegistrationPipelines.successfulAccounts(req.params.id, req.query || {}));
    } catch (error) { next(error); }
  });
  app.get("/api/registration/mailcom-pipelines/:id", (req, res, next) => {
    try { res.json(mailcomRegistrationPipelines.get(req.params.id)); } catch (error) { next(error); }
  });
  app.post("/api/registration/mailcom-pipelines/:id/cancel", async (req, res, next) => {
    try { res.json(await mailcomRegistrationPipelines.cancel(req.params.id)); } catch (error) { next(error); }
  });
  app.get("/api/registration/openai-sms/settings", (_req, res, next) => {
    try { res.json(openAiSms.settings()); } catch (error) { next(error); }
  });
  app.put("/api/registration/openai-sms/settings", (req, res, next) => {
    try { res.json(openAiSms.updateSettings(req.body || {})); } catch (error) { next(error); }
  });
  app.get("/api/registration/openai-sms/countries", async (req, res, next) => {
    try { res.json(await openAiSms.topCountries({ force: req.query.refresh === "1" })); } catch (error) { next(error); }
  });
  app.get("/api/registration/openai-sms/tasks", (req, res, next) => {
    try { res.json(openAiSms.list(req.query || {})); } catch (error) { next(error); }
  });
  app.post("/api/registration/openai-sms/tasks", async (req, res, next) => {
    try { res.status(202).json(await openAiSms.start(req.body || {})); } catch (error) { next(error); }
  });
  app.get("/api/registration/openai-sms/tasks/:id", async (req, res, next) => {
    try { res.json(await openAiSms.getTask(req.params.id)); } catch (error) { next(error); }
  });
  app.post("/api/registration/openai-sms/tasks/:id/cancel", async (req, res, next) => {
    try { res.json(await openAiSms.cancel(req.params.id)); } catch (error) { next(error); }
  });
  app.get("/api/registration/openai-sms/tasks/:id/events", async (req, res, next) => {
    try { res.json(await openAiSms.events(req.params.id, req.query || {})); } catch (error) { next(error); }
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
    try {
      const items = await registration.listJobs(req.query);
      res.json({ items, counts: registration.jobCounts() });
    } catch (error) { next(error); }
  });
  app.get("/api/registration/queue/control", async (_req, res, next) => {
    try { res.json(await registration.registrationQueueControl()); } catch (error) { next(error); }
  });
  app.post("/api/registration/queue/pause", async (_req, res, next) => {
    try { res.json(await registration.pauseRegistrationQueue()); } catch (error) { next(error); }
  });
  app.post("/api/registration/queue/resume", async (_req, res, next) => {
    try { res.json(await registration.resumeRegistrationQueue()); } catch (error) { next(error); }
  });
  app.post("/api/registration/queue/cancel", async (_req, res, next) => {
    try { res.json(await registration.cancelRegistrationQueue()); } catch (error) { next(error); }
  });
  app.post("/api/registration/jobs/:id/cancel", async (req, res, next) => {
    try { res.json({ item: await registration.cancelJob(req.params.id) }); } catch (error) { next(error); }
  });
  app.post("/api/registration/jobs/:id/pause", async (req, res, next) => {
    try { res.json({ item: await registration.pauseJob(req.params.id) }); } catch (error) { next(error); }
  });
  app.post("/api/registration/jobs/:id/resume", async (req, res, next) => {
    try { res.json({ item: await registration.resumeJob(req.params.id) }); } catch (error) { next(error); }
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
    try { res.json(await registration.listRegisteredAccounts({ refreshUnchecked: false })); } catch (error) { next(error); }
  });
  app.post("/api/registration/accounts/import-local", async (req, res, next) => {
    try { res.status(201).json(await registration.importLocalAccounts(req.body || {})); } catch (error) { next(error); }
  });
  app.post("/api/registration/accounts/refresh-status", async (req, res, next) => {
    try {
      const input = req.body || {};
      res.json(await registration.refreshRegisteredAccountSignals(input, {
        skipNfapiSync: input.skip_nfapi_sync === true,
      }));
    } catch (error) { next(error); }
  });
  app.post("/api/registration/accounts/check-checkout", async (req, res, next) => {
    try { res.json(await registration.checkRegisteredAccountCheckouts(req.body || {})); } catch (error) { next(error); }
  });
  app.post("/api/registration/accounts/check-jp-trial", async (req, res, next) => {
    try { res.json(await registration.checkRegisteredAccountTrials(req.body || {})); } catch (error) { next(error); }
  });
  app.post("/api/registration/accounts/check-gb-trial", async (req, res, next) => {
    try { res.json(await registration.checkRegisteredAccountGbTrials(req.body || {})); } catch (error) { next(error); }
  });
  app.post("/api/registration/accounts/check-us-trial", async (req, res, next) => {
    try { res.json(await registration.checkRegisteredAccountUsTrials(req.body || {})); } catch (error) { next(error); }
  });
  app.post("/api/registration/accounts/check-momo", async (req, res, next) => {
    try { res.json(await registration.checkRegisteredAccountMomoEligibility(req.body || {})); } catch (error) { next(error); }
  });
  app.patch("/api/registration/accounts/bulk-group", async (req, res, next) => {
    try { res.json(await registration.updateRegisteredAccountGroups(req.body || {})); } catch (error) { next(error); }
  });
  app.patch("/api/registration/accounts/:id", async (req, res, next) => {
    try { res.json(await registration.updateRegisteredAccountMetadata(req.params.id, req.body || {})); } catch (error) { next(error); }
  });
  app.post("/api/registration/accounts/:id/refresh-at", async (req, res, next) => {
    try { res.json(await registration.refreshRegisteredAccountAccessToken(req.params.id, req.body || {})); } catch (error) { next(error); }
  });
  app.get("/api/registration/accounts/:id/access-token", async (req, res, next) => {
    try { res.json(await registration.registeredAccountAccessToken(req.params.id)); } catch (error) { next(error); }
  });
  app.get("/api/registration/accounts/:id/refresh-token", async (req, res, next) => {
    try { res.json(await registration.registeredAccountRefreshToken(req.params.id)); } catch (error) { next(error); }
  });
  app.get("/api/registration/accounts/:id/sub2api-export", async (req, res, next) => {
    try { res.json(await registration.registeredAccountSub2Export(req.params.id)); } catch (error) { next(error); }
  });
  app.get("/api/registration/accounts/:id/emails", async (req, res, next) => {
    try { res.json(await registration.registeredAccountEmails(req.params.id, req.query)); } catch (error) { next(error); }
  });
  const deleteRegistrationAccounts = async (input) => {
    const result = await registration.deleteRegisteredAccounts(input);
    const released = mailcomRegistrationPipelines.releaseBlockedAccounts(
      result.deleted_accounts || [],
    );
    return {
      ...result,
      released_mailcom_blocked: released.released,
      resumed_mailcom_slots: released.resumed,
    };
  };
  app.delete("/api/registration/accounts/:id", async (req, res, next) => {
    try { res.json(await deleteRegistrationAccounts({ ids: [req.params.id] })); } catch (error) { next(error); }
  });
  app.post("/api/registration/accounts/bulk-delete", async (req, res, next) => {
    try { res.json(await deleteRegistrationAccounts(req.body || {})); } catch (error) { next(error); }
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
        reauthorization: req.body?.reauthorization,
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

  app.get("/api/inventory/config", (_req, res, next) => {
    try { res.json(inventory.configuration()); } catch (error) { next(error); }
  });
  app.patch("/api/inventory/config", (req, res, next) => {
    try { res.json(inventory.updateConfiguration(req.body || {})); } catch (error) { next(error); }
  });
  app.post("/api/inventory/test", async (_req, res, next) => {
    try { res.json(await inventory.testConnection()); } catch (error) { next(error); }
  });
  app.post("/api/inventory/cards/import", async (req, res, next) => {
    try {
      const input = req.body || {};
      const directPayload = inventoryPayloadFromBody(input);
      const generated = directPayload === null
        ? await collectInventoryCards(registration, input.ids)
        : { payload: directPayload, failed: [] };
      const localResult = inventoryLocalResult(generated);
      if (localResult && localResult.source_count === 0) {
        audit(db, null, "inventory", "提交账号到库存 API", "", {
          requested_count: localResult.requested_count,
          source_count: 0,
          local_failed_count: localResult.local_failed_count,
          accepted: 0,
          rejected: 0,
        });
        return res.status(409).json({
          error: localResult.credential_failures[0]?.error || "所选账号没有可导入的 AT/Refresh Token",
          code: "INVENTORY_LOCAL_CREDENTIALS_UNAVAILABLE",
          ...localResult,
        });
      }
      const upstream = await inventory.importCards(generated.payload, {
        idempotencyKey: String(req.get("Idempotency-Key") || "").trim().slice(0, 200),
      });
      const summary = inventory.resultSummary(upstream, generated.payload);
      audit(db, null, "inventory", "提交账号到库存 API", "", {
        requested_count: localResult?.requested_count || 0,
        source_count: localResult?.source_count || 0,
        local_failed_count: localResult?.local_failed_count || 0,
        accepted: Number(summary.accepted || summary.summary?.accepted || 0),
        rejected: Number(summary.rejected || summary.summary?.rejected || 0),
      });
      res.status(201).json({
        ...summary,
        ...(localResult || { credential_failures: [] }),
      });
    } catch (error) { next(error); }
  });
  app.post("/api/inventory/cards/pool", async (req, res, next) => {
    try {
      const input = req.body || {};
      const directPayload = inventoryPayloadFromBody(input);
      const generated = directPayload === null
        ? await collectInventoryCards(registration, input.ids)
        : { payload: directPayload, failed: [] };
      const localResult = inventoryLocalResult(generated);
      if (localResult && localResult.source_count === 0) {
        audit(db, null, "inventory", "提交账号到库存号池", "", {
          requested_count: localResult.requested_count,
          source_count: 0,
          local_failed_count: localResult.local_failed_count,
          accepted: 0,
          rejected: 0,
        });
        return res.status(409).json({
          error: localResult.credential_failures[0]?.error || "所选账号没有可导入的 AT/Refresh Token",
          code: "INVENTORY_LOCAL_CREDENTIALS_UNAVAILABLE",
          ...localResult,
        });
      }
      const payload = {
        ...((generated.payload && typeof generated.payload === "object" && !Array.isArray(generated.payload))
          ? generated.payload : { data: generated.payload }),
        ...(input.price_yuan !== undefined ? { price_yuan: input.price_yuan } : {}),
        ...(input.price_cents !== undefined ? { price_cents: input.price_cents } : {}),
        ...(input.warranty_channel_id !== undefined ? { warranty_channel_id: input.warranty_channel_id } : {}),
        ...(input.warranty_name !== undefined ? { warranty_name: input.warranty_name } : {}),
      };
      const upstream = await inventory.importCards(payload, {
        pool: true,
        idempotencyKey: String(req.get("Idempotency-Key") || "").trim().slice(0, 200),
      });
      const summary = inventory.resultSummary(upstream, payload);
      audit(db, null, "inventory", "提交账号到库存号池", "", {
        requested_count: localResult?.requested_count || 0,
        source_count: localResult?.source_count || 0,
        local_failed_count: localResult?.local_failed_count || 0,
        accepted: Number(summary.accepted || summary.summary?.accepted || 0),
        rejected: Number(summary.rejected || summary.summary?.rejected || 0),
      });
      res.status(201).json({
        ...summary,
        ...(localResult || { credential_failures: [] }),
      });
    } catch (error) { next(error); }
  });
  app.post("/api/inventory/mailboxes/import", async (req, res, next) => {
    try {
      const generated = await collectInventoryMailboxes(registration, inboxLinkMailboxes, req.body || {});
      const upstream = await inventory.importMailboxes(generated.payload, {
        idempotencyKey: String(req.get("Idempotency-Key") || "").trim().slice(0, 200),
      });
      const summary = inventory.resultSummary(upstream, generated.payload);
      audit(db, null, "inventory", "提交邮箱凭证到库存 API", "", {
        source: generated.source,
        source_count: generated.sourceCount || 0,
        matched: Number(summary.matched || 0),
        updated: Number(summary.updated || 0),
        invalid: Number(summary.invalid || 0),
        unmatched: Number(summary.unmatched || 0),
      });
      res.status(201).json({
        ...summary,
        source: generated.source,
        source_count: generated.sourceCount || 0,
        missing_emails: generated.missing || [],
      });
    } catch (error) { next(error); }
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

  app.post("/api/mailcom/connect", async (req, res, next) => {
    try {
      if (["host", "port", "server", "secure"].some((key) => Object.hasOwn(req.body || {}, key))) {
        throw Object.assign(new Error("Mail.com IMAP 服务地址由系统固定配置，不能自定义"), { status: 400 });
      }
      const reconnecting = Boolean(req.body?.accountId);
      const result = await mailcom.connectAccount({
        accountId: req.body?.accountId,
        email: req.body?.email,
        displayName: req.body?.displayName,
        password: req.body?.password,
      });
      const recovery = mailcomRegistrationPipelines.scheduleSavedAuthorizationRecovery?.(
        result?.account?.id,
        { force: true },
      ) || { scheduled: 0 };
      res.status(reconnecting ? 200 : 201).json({
        ...result,
        authorization_recovery_scheduled: recovery.scheduled,
      });
    } catch (error) { next(error); }
  });

  app.post("/api/mailcom/import", async (req, res, next) => {
    try {
      const result = await importMailcomAccounts(mailcom, req.body || {});
      const accountIds = (result.items || [])
        .filter((item) => item.status === "connected")
        .map((item) => item.account?.id)
        .filter(Boolean);
      const recovery = mailcomRegistrationPipelines.scheduleSavedAuthorizationRecovery?.(
        accountIds,
        { force: true },
      ) || { scheduled: 0 };
      res.status(201).json({
        ...result,
        authorization_recovery_scheduled: recovery.scheduled,
      });
    } catch (error) { next(error); }
  });

  app.post("/api/netease/connect", async (req, res, next) => {
    try {
      if (["host", "port", "server", "secure", "proxy"].some((key) => Object.hasOwn(req.body || {}, key))) {
        throw Object.assign(new Error("网易邮箱 IMAP 服务地址由系统按母号后缀固定配置，不能自定义"), {
          status: 400,
          code: "NETEASE_IMAP_CONFIGURATION_FIXED",
        });
      }
      const reconnecting = Boolean(req.body?.accountId);
      const result = await netease.connectAccount({
        accountId: req.body?.accountId,
        email: req.body?.email,
        displayName: req.body?.displayName,
        authCode: req.body?.authCode,
        aliases: req.body?.aliases,
      });
      res.status(reconnecting ? 200 : 201).json(result);
    } catch (error) { next(error); }
  });

  app.post("/api/netease/import", async (req, res, next) => {
    try {
      res.status(201).json(await importNeteaseAccounts(netease, req.body || {}));
    } catch (error) { next(error); }
  });

  app.get("/api/overview", (_req, res) => {
    const accounts = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'connected' THEN 1 ELSE 0 END) AS connected,
        SUM(CASE WHEN status = 'action_required' THEN 1 ELSE 0 END) AS action_required
      FROM source_accounts WHERE provider <> 'inbox_link'
    `).get();
    const addresses = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN kind = 'official' THEN 1 ELSE 0 END) AS official,
        SUM(CASE WHEN kind = 'split' THEN 1 ELSE 0 END) AS split
      FROM addresses
      JOIN source_accounts ON source_accounts.id = addresses.account_id
      WHERE addresses.status = 'active' AND source_accounts.provider <> 'inbox_link'
    `).get();
    const codes = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN is_used = 0 THEN 1 ELSE 0 END) AS unused FROM verification_codes WHERE is_hidden = 0").get();
    const recentAccounts = db.prepare("SELECT * FROM source_accounts WHERE provider <> 'inbox_link' ORDER BY updated_at DESC LIMIT 6").all().map((row) => publicAccount(db, row));
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

  app.get("/api/accounts", (req, res) => {
    const includeInboxLinks = req.query.includeInboxLinks === "true";
    const items = db.prepare(`
      SELECT * FROM source_accounts
      ${includeInboxLinks ? "" : "WHERE provider <> 'inbox_link'"}
      ORDER BY created_at DESC
    `).all().map((row) => {
      const latestJob = db.prepare("SELECT * FROM automation_jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT 1").get(row.id);
      return { ...publicAccount(db, row), latest_job: publicJob(latestJob) };
    });
    res.json({
      items,
      supportedDomains: microsoftDomains,
      mailcomDomains,
      neteaseDomains,
      neteaseAliasDomain,
      providers: {
        microsoft: { authMode: "oauth", supportsOfficialAliases: true, supportsPlusAliases: true, supportsImportedAliases: false, supportsDirectRegistration: false },
        google: { authMode: "oauth", supportsOfficialAliases: false, supportsPlusAliases: true, supportsImportedAliases: false, supportsDirectRegistration: false },
        icloud: { authMode: "app_password", supportsOfficialAliases: false, supportsPlusAliases: false, supportsImportedAliases: true, supportsDirectRegistration: true },
        mailcom: { authMode: "password", supportsOfficialAliases: false, supportsPlusAliases: false, supportsImportedAliases: true, supportsDirectRegistration: true, supportsMailcomAliases: true, aliasPreparationTarget: 10 },
        netease: { authMode: "imap_auth_code", supportsOfficialAliases: false, supportsPlusAliases: false, supportsImportedAliases: true, supportsDirectRegistration: true, supportsNeteaseAliases: true, aliasDomain: neteaseAliasDomain },
        inbox_link: { authMode: "inbox_link", supportsOfficialAliases: false, supportsPlusAliases: false, supportsImportedAliases: false, supportsDirectRegistration: false },
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
      const bases = db.prepare("SELECT * FROM addresses WHERE account_id = ? AND kind IN ('primary', 'official') ORDER BY kind = 'primary' DESC, created_at")
        .all(row.id)
        .filter((item) => !(
          row.provider === "mailcom"
          && isMailcomAliasStrategy(item.strategy)
          && item.status === "disabled"
          && !item.remote_confirmed
        ));
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
      if (row.provider === "mailcom" || row.provider === "netease") {
        const accountAddresses = () => db.prepare(`
            SELECT addresses.*, source_accounts.provider AS source_provider
            FROM addresses
            JOIN source_accounts ON source_accounts.id = addresses.account_id
            WHERE addresses.account_id = ?
          `).all(row.id);
        await assertAddressRemovalAllowed(db, pickup, accountAddresses(), {
          activeMessage: `这个 ${row.provider === "netease" ? "网易" : "Mail.com"} 母号仍有邮箱正在注册，请等待任务结束后再移除`,
          inventoryMessage: `这个 ${row.provider === "netease" ? "网易" : "Mail.com"} 母号包含取件站售卖库存，请先从取件站下架`,
          checkInventoryForAll: true,
          refreshItems: accountAddresses,
        });
        if (row.provider === "mailcom") {
          mailcomRegistrationPipelines.abandonRecoveries({
            accountId: row.id,
            reason: `Mail.com 母号 ${row.email} 已从系统移除，不再恢复别名轮换`,
          });
        }
      }
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
      const items = importIcloudAliases(db, account, input, {
        type: String(req.body?.type || ""),
        replace: req.body?.replace === true,
      });
      res.json({
        items,
        account: publicAccount(db, db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id)),
      });
    } catch (error) { next(error); }
  });

  app.post("/api/accounts/:id/mailcom-aliases/import", async (req, res, next) => {
    try {
      const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(req.params.id));
      if (!account) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
      if (account.provider !== "mailcom") {
        throw Object.assign(new Error("这个源头邮箱不是 Mail.com 账号"), { status: 409, code: "MAILCOM_ACCOUNT_REQUIRED" });
      }
      const input = Array.isArray(req.body?.aliases) ? req.body.aliases : [];
      if (req.body?.replace === true) {
        const requested = new Set(input.map(normalizeMailcomEmail).filter(Boolean));
        const invalid = input.some((value) => String(value || "").trim() && !normalizeMailcomEmail(value));
        if (!invalid) {
          const removalCandidates = () => db.prepare(`
              SELECT addresses.*, source_accounts.provider AS source_provider
              FROM addresses
              JOIN source_accounts ON source_accounts.id = addresses.account_id
              WHERE addresses.account_id = ? AND addresses.kind = 'official'
                AND addresses.strategy = ? AND addresses.status = 'active'
            `).all(account.id, MAILCOM_ALIAS_STRATEGY)
              .filter((item) => !requested.has(String(item.address || "").toLowerCase()));
          await assertAddressRemovalAllowed(db, pickup, removalCandidates(), {
            activeMessage: "待移除的 Mail.com 别名中有邮箱正在注册，请等待任务结束后再同步",
            inventoryMessage: "待移除的 Mail.com 别名包含取件站售卖库存，请先从取件站下架",
            refreshItems: removalCandidates,
          });
          removalCandidates().forEach((item) => mailcomRegistrationPipelines.abandonRecoveries({
            email: item.address,
            reason: `Mail.com 别名 ${item.address} 已从系统移除，不再恢复轮换`,
          }));
        }
      }
      const items = importMailcomAliases(db, account, input, {
        replace: req.body?.replace === true,
        purpose: String(req.body?.purpose || "Mail.com 手工导入"),
      });
      res.json({
        items,
        account: publicAccount(db, db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id)),
      });
    } catch (error) { next(error); }
  });

  app.get("/api/accounts/:id/netease-aliases", (req, res, next) => {
    try {
      const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(req.params.id));
      if (!account) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
      if (account.provider !== "netease") {
        throw Object.assign(new Error("这个源头邮箱不是网易邮箱账号"), { status: 409, code: "NETEASE_ACCOUNT_REQUIRED" });
      }
      const items = db.prepare(`
        SELECT * FROM addresses
        WHERE account_id = ? AND kind = 'official' AND strategy = ? AND status = 'active'
        ORDER BY created_at, id
      `).all(account.id, NETEASE_ALIAS_STRATEGY);
      res.json({
        items,
        aliases: items.map((item) => item.address),
        account: publicAccount(db, account),
      });
    } catch (error) { next(error); }
  });

  app.post("/api/accounts/:id/netease-aliases", async (req, res, next) => {
    try {
      const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(req.params.id));
      if (!account) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
      if (account.provider !== "netease") {
        throw Object.assign(new Error("这个源头邮箱不是网易邮箱账号"), { status: 409, code: "NETEASE_ACCOUNT_REQUIRED" });
      }
      if (!Array.isArray(req.body?.aliases)) {
        throw Object.assign(new Error("网易替身邮箱列表必须是数组"), { status: 400, code: "NETEASE_ALIAS_LIST_REQUIRED" });
      }
      const input = req.body.aliases;
      const requested = new Set(input.map(normalizeNeteaseAliasEmail).filter(Boolean));
      const invalid = input.some((value) => String(value || "").trim() && !normalizeNeteaseAliasEmail(value));
      if (!invalid) {
        const removalCandidates = () => db.prepare(`
          SELECT addresses.*, source_accounts.provider AS source_provider
          FROM addresses
          JOIN source_accounts ON source_accounts.id = addresses.account_id
          WHERE addresses.account_id = ? AND addresses.kind = 'official'
            AND addresses.strategy = ? AND addresses.status = 'active'
        `).all(account.id, NETEASE_ALIAS_STRATEGY)
          .filter((item) => !requested.has(String(item.address || "").toLowerCase()));
        await assertAddressRemovalAllowed(db, pickup, removalCandidates(), {
          activeMessage: "待移除的网易替身邮箱中有地址正在注册，请等待任务结束后再同步",
          inventoryMessage: "待移除的网易替身邮箱已进入售卖库存，请先从取件站下架",
          checkActive: true,
          refreshItems: removalCandidates,
        });
      }
      const allItems = importNeteaseAliases(db, account, input, {
        replace: true,
        purpose: String(req.body?.purpose || "网易替身邮箱手工导入"),
      });
      const items = allItems.filter((item) => isNeteaseAliasStrategy(item.strategy) && item.status === "active");
      const currentAccount = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id);
      res.json({
        items,
        aliases: items.map((item) => item.address),
        account: publicAccount(db, currentAccount),
      });
    } catch (error) { next(error); }
  });

  app.post("/api/accounts/:id/mailcom-aliases/auto-create", async (req, res, next) => {
    try {
      res.json(await mailcomAliases.autoCreate(req.params.id, { domain: req.body?.domain }));
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
    const aliasAutomationOnly = account.provider === "mailcom"
      && account.status === "action_required"
      && String(account.limit_reason || "").startsWith("Mail.com 网页授权需要处理：");
    if (account.status !== "connected" && !aliasAutomationOnly) {
      throw Object.assign(new Error("请先完成这个源头邮箱的连接验证"), { status: 409 });
    }
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
      strategy: req.query.strategy,
      q: req.query.q,
      page: positive(req.query.page, 1, 10_000),
      limit: positive(req.query.limit, 50, 200),
    }));
  });

  app.get("/api/addresses/registration-failures", (req, res) => {
    res.json(failedRegistrationAddressIds(db, {
      accountId: req.query.accountId,
      kind: req.query.kind,
      strategy: req.query.strategy,
      q: req.query.q,
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

  app.post("/api/addresses/bulk-delete", async (req, res, next) => {
    try {
      const accountValue = req.body?.accountId;
      const accountId = accountValue && accountValue !== "all" ? Number(accountValue) : null;
      if (accountId !== null && (!Number.isSafeInteger(accountId) || accountId <= 0)) {
        throw Object.assign(new Error("源头邮箱 ID 无效"), { status: 400 });
      }
      if (accountId !== null && !db.prepare("SELECT 1 FROM source_accounts WHERE id = ?").get(accountId)) {
        throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
      }
      if (req.body?.mode === "all") {
        return res.json(deleteSplitAddresses(db, { accountId, all: true }));
      }
      const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number)
        .filter((id) => Number.isInteger(id) && id > 0))];
      if (!ids.length) throw Object.assign(new Error("请选择要删除的地址"), { status: 400 });
      if (ids.length > 5_000) throw Object.assign(new Error("单次最多删除 5000 个地址"), { status: 400 });
      const params = [...ids];
      const accountCondition = accountId ? "AND addresses.account_id = ?" : "";
      if (accountId) params.push(accountId);
      const items = db.prepare(`
        SELECT addresses.*, source_accounts.provider AS source_provider
        FROM addresses
        JOIN source_accounts ON source_accounts.id = addresses.account_id
        WHERE addresses.id IN (${ids.map(() => "?").join(",")}) ${accountCondition}
      `).all(...params);
      await assertAddressRemovalAllowed(db, pickup, items);
      return res.json(deleteSelectedAddresses(db, { ids, accountId }));
    } catch (error) { next(error); }
  });

  app.delete("/api/addresses/:id", async (req, res, next) => {
    try {
      const item = db.prepare(`
        SELECT addresses.*, source_accounts.provider AS source_provider
        FROM addresses JOIN source_accounts ON source_accounts.id = addresses.account_id
        WHERE addresses.id = ?
      `).get(Number(req.params.id));
      if (!item) return res.status(204).end();
      const importedAliasAddress = isLocallyImportedAlias(item);
      if (item.kind !== "split" && !importedAliasAddress) {
        throw Object.assign(new Error("源头号和官方别名需要在对应邮箱官网删除"), { status: 409 });
      }
      await assertAddressRemovalAllowed(db, pickup, [item], {
        activeMessage: "这个邮箱正在注册，请等待任务结束后再删除",
        inventoryMessage: "这个邮箱已进入售卖库存，请先从取件站下架",
        checkActive: ["mailcom", "netease"].includes(item.source_provider),
      });
      if (item.source_provider === "mailcom" && importedAliasAddress) {
        mailcomRegistrationPipelines.abandonRecoveries({
          email: item.address,
          reason: `Mail.com 别名 ${item.address} 已从系统移除，不再恢复轮换`,
        });
        db.prepare(`
          UPDATE addresses
          SET status = 'disabled', remote_confirmed = 0, updated_at = ?
          WHERE id = ?
        `).run(nowIso(), item.id);
      } else {
        db.prepare("DELETE FROM addresses WHERE id = ?").run(item.id);
      }
      audit(
        db,
        item.account_id,
        importedAliasAddress ? "alias" : "split",
        importedAliasAddress
          ? `移除本地 ${item.source_provider === "mailcom" ? "Mail.com" : item.source_provider === "netease" ? "网易" : "iCloud"} 地址映射`
          : "删除分裂地址",
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
    delete settings.inventory_api_key_encrypted;
    delete settings.payment_agreement_herosms_api_key_encrypted;
    delete settings.payment_agreement_country;
    delete settings.payment_agreement_proxy_pool;
    delete settings.nfapi_import_defaults;
    delete settings.microsoft_registration_webhook_token_hash;
    res.json({
      ...settings,
      ...gmail.configuration(),
      extension_api_key: extension.apiKey,
      public_base_url: publicBaseUrl,
      auth_enabled: auth.enabled,
      supported_domains: microsoftDomains,
      mailcom_domains: mailcomDomains,
      microsoft_oauth_mode: "authorization_code_pkce",
      microsoft_oauth_client: "Mailspring · Microsoft Graph Mail.Read",
      icloud_imap: icloudImapConfiguration,
      mailcom_imap: mailcomImapConfiguration,
      netease_imap: { hosts: neteaseImapHosts, port: 993, secure: true, alias_domain: neteaseAliasDomain },
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
    const publicMailcomError = String(error?.code || "").startsWith("MAILCOM_");
    const publicNeteaseError = String(error?.code || "").startsWith("NETEASE_") || String(error?.code || "").startsWith("INVALID_NETEASE_");
    const publicIcPipelineError = String(error?.code || "").startsWith("IC_PIPELINE_");
    const publicInventoryError = String(error?.code || "").startsWith("INVENTORY_");
    const body = { error: status >= 500 && !publicMailcomError && !publicNeteaseError && !publicIcPipelineError && !publicInventoryError ? "服务器处理请求失败" : error.message };
    if (PUBLIC_AGENT_IDENTITY_ERROR_CODES.has(error?.code) || publicMailcomError || publicNeteaseError || publicIcPipelineError || publicInventoryError) {
      body.code = error.code;
    }
    if (publicMailcomError && error?.partial) Object.assign(body, safeMailcomPartialError(error));
    res.status(status).json(body);
  });
  return { app, db, graph, gmail, icloud, icloudPrivacy, mailcom, mailcomAliases, netease, inbox, inboxLinkMailboxes, extension, jobs, registration, pickup, paymentLinks, paymentAgreements, icRegistrationPipelines, mailcomRegistrationPipelines, openAiSms, nfapi, inventory, nfapiCredentialSync, microsoftRegistration, microsoftRegistrationRunner };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.umask(0o077);
  const runtime = createApp();
  const port = Number(process.env.PORT) || 4180;
  const host = process.env.HOST || "127.0.0.1";
  const server = runtime.app.listen(port, host, () => console.log(`AliasHub listening on http://${host}:${port}`));
  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (error) console.error("AliasHub HTTP shutdown failed:", error);
          resolve();
        };
        timer = setTimeout(() => {
          server.closeAllConnections?.();
          finish(new Error("HTTP drain timed out"));
        }, 45_000);
        timer.unref?.();
        server.close(finish);
      });
      await runtime.microsoftRegistrationRunner.stopForShutdown();
      await runtime.icRegistrationPipelines?.close?.();
      await runtime.mailcomRegistrationPipelines?.close?.();
      await runtime.openAiSms.close();
      await runtime.paymentAgreements.close();
      await runtime.nfapiCredentialSync?.close?.();
      runtime.db.close();
    })().then(
      () => process.exit(0),
      (error) => {
        console.error("AliasHub shutdown failed:", error);
        process.exit(1);
      },
    );
    return shutdownPromise;
  };
  process.on("SIGTERM", () => { shutdown(); });
  process.on("SIGINT", () => { shutdown(); });
}
