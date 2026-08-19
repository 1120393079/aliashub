import crypto from "node:crypto";
import { importMailcomAliases, publicAccount } from "./account-service.js";
import {
  MAILCOM_ALIAS_STRATEGY,
  normalizeMailcomEmail,
  normalizeMailcomLoginEmail,
} from "./address-generator.js";
import { audit } from "./db.js";

const MAILCOM_ADDRESS_LIMIT = 10;
// Mail.com counts the primary address plus 99 created aliases toward its lifetime quota.
const MAILCOM_ALIAS_HISTORY_LIMIT = 99;
const DEFAULT_VALIDATION_ATTEMPTS = 40;
const DEFAULT_CONFIRMATION_ATTEMPTS = 10;
const DEFAULT_CONFIRMATION_INTERVAL_MS = 750;

export const MAILCOM_WEB_AUTH_REASON_PREFIX = "Mail.com 网页授权需要处理：";
export const MAILCOM_RANDOM_DOMAIN = "random";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function failure(message, status = 502, code = "MAILCOM_ALIAS_AUTOMATION_FAILED", options = {}) {
  return Object.assign(new Error(message, options), { status, code });
}

function normalizedState(item) {
  return String(item?.state || item?.status || "ACTIVE").trim().toUpperCase();
}

function firstString(item, keys) {
  for (const key of keys) {
    if (typeof item?.[key] === "string" && item[key].trim()) return item[key].trim();
  }
  return "";
}

function collection(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["items", "elements", "content", "results", "mailaddresslist", "emailAddresses", "domains", "data"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function remoteAddressValue(item, normalizeAddress) {
  if (typeof item === "string") return normalizeAddress(item);
  if (!item || typeof item !== "object" || !["ACTIVE", "ENABLED"].includes(normalizedState(item))) return "";
  const direct = firstString(item, ["address", "email", "emailAddress", "value", "name"]);
  const localPart = firstString(item, ["localPart", "local_part", "prefix", "username"]);
  const domainValue = item.domain;
  const domain = typeof domainValue === "string"
    ? domainValue
    : firstString(domainValue, ["name", "domain", "value"]);
  return normalizeAddress(direct || (localPart && domain ? `${localPart}@${domain}` : ""));
}

function normalizedRemoteAddresses(value, normalizeAddress) {
  const entries = Array.isArray(value) ? value : collection(value);
  return [...new Set(entries.map((item) => remoteAddressValue(item, normalizeAddress)).filter(Boolean))];
}

export function normalizeRemoteMailcomAddresses(value) {
  return normalizedRemoteAddresses(value, normalizeMailcomEmail);
}

function booleanFlag(value, expected) {
  if (typeof value === "boolean") return value === expected;
  if (typeof value === "string") return value.trim().toLowerCase() === String(expected);
  return false;
}

function remoteAddressSnapshot(value, primaryAddress = "") {
  const primary = normalizeMailcomLoginEmail(primaryAddress);
  const records = new Map();
  const entries = Array.isArray(value) ? value : collection(value);
  for (const entry of entries) {
    let address = remoteAddressValue(entry, normalizeMailcomEmail);
    if (!address && primary) {
      const providerAddress = remoteAddressValue(entry, normalizeMailcomLoginEmail);
      if (providerAddress === primary) address = providerAddress;
    }
    if (!address) continue;
    const metadata = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
    const type = metadata
      ? firstString(metadata, ["type", "addressType", "address_type", "kind", "role"]).toUpperCase()
      : "";
    const protectedReasons = [];
    if (metadata && booleanFlag(metadata.deletable, false)) protectedReasons.push("not_deletable");
    if (metadata && booleanFlag(metadata.defaultSenderAddress, true)) protectedReasons.push("default_sender");
    if (metadata && booleanFlag(metadata.defaultReceiverAddress, true)) protectedReasons.push("default_receiver");
    if (/(^|[^A-Z])(PRIMARY|DEFAULT)([^A-Z]|$)/.test(type)) protectedReasons.push("protected_type");
    const current = records.get(address);
    const mergedReasons = [...new Set([...(current?.protectedReasons || []), ...protectedReasons])];
    records.set(address, {
      address,
      protected: mergedReasons.length > 0,
      protectedReasons: mergedReasons,
    });
  }
  return { addresses: [...records.keys()], records };
}

export function normalizeRemoteMailcomDomains(value) {
  const entries = Array.isArray(value) ? value : collection(value);
  return [...new Set(entries.flatMap((item) => {
    if (typeof item === "string") return [item.trim().toLowerCase()];
    if (!item || typeof item !== "object" || !["ACTIVE", "ENABLED"].includes(normalizedState(item))) return [];
    const name = firstString(item, ["domain", "name", "value", "id"]).toLowerCase();
    return name ? [name.replace(/^@/, "")] : [];
  }).filter((domain) => normalizeMailcomEmail(`alias@${domain}`)))];
}

function validationAvailable(value) {
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object") return false;
  for (const key of ["available", "isAvailable", "valid", "isValid", "emailAddressAvailable"]) {
    if (typeof value[key] === "boolean") return value[key];
  }
  const status = String(value.status || value.result || "").trim().toUpperCase();
  return ["AVAILABLE", "VALID", "OK", "SUCCESS"].includes(status);
}

function safeMessage(error, secrets = []) {
  let message = String(error?.message || "Mail.com 官方别名自动创建失败");
  for (const secret of secrets.filter(Boolean)) message = message.split(String(secret)).join("[REDACTED]");
  return message.replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "Bearer [REDACTED]").slice(0, 300);
}

function mappedFailure(error, secrets = []) {
  if (String(error?.code || "").startsWith("MAILCOM_")) {
    return failure(safeMessage(error, secrets), Number(error?.status) || 502, error.code);
  }
  const code = String(error?.code || "").toUpperCase();
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "TIMEOUT"].includes(code)) {
    return failure("连接 Mail.com 超时，请稍后重试", 504, "MAILCOM_ALIAS_TIMEOUT");
  }
  if (["ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "ENETUNREACH", "ENOTFOUND"].includes(code)) {
    return failure("Mail.com 暂时无法连接，请稍后重试", 503, "MAILCOM_ALIAS_UNAVAILABLE");
  }
  return failure(safeMessage(error, secrets), Number(error?.status) || 502, "MAILCOM_ALIAS_AUTOMATION_FAILED");
}

function generatedLocalPart(randomBytesFn) {
  const random = Buffer.from(randomBytesFn(9)).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `ah${random}`.slice(0, 14);
}

function normalizeRequestedDomain(value) {
  const domain = String(value || "").trim().toLowerCase().replace(/^@/, "");
  return domain && normalizeMailcomEmail(`alias@${domain}`) ? domain : "";
}

function randomDomainRequested(value) {
  return String(value || "").trim().toLowerCase().replace(/^@/, "") === MAILCOM_RANDOM_DOMAIN;
}

export class MailcomAliasAutomationService {
  constructor({
    db,
    mailcom,
    adapter,
    randomBytesFn = crypto.randomBytes,
    randomIntFn = crypto.randomInt,
    maxValidationAttempts = DEFAULT_VALIDATION_ATTEMPTS,
    confirmationAttempts = DEFAULT_CONFIRMATION_ATTEMPTS,
    confirmationIntervalMs = DEFAULT_CONFIRMATION_INTERVAL_MS,
    sleepFn = sleep,
    pickup = null,
  } = {}) {
    if (!db) throw new TypeError("MailcomAliasAutomationService requires db");
    if (!mailcom) throw new TypeError("MailcomAliasAutomationService requires MailComImapClient");
    if (!adapter || typeof adapter.open !== "function") {
      throw new TypeError("MailcomAliasAutomationService requires an adapter");
    }
    this.db = db;
    this.mailcom = mailcom;
    this.adapter = adapter;
    this.randomBytesFn = randomBytesFn;
    this.randomIntFn = typeof randomIntFn === "function" ? randomIntFn : crypto.randomInt;
    this.maxValidationAttempts = Math.max(1, Number(maxValidationAttempts) || DEFAULT_VALIDATION_ATTEMPTS);
    this.confirmationAttempts = Math.max(1, Number(confirmationAttempts) || DEFAULT_CONFIRMATION_ATTEMPTS);
    this.confirmationIntervalMs = Math.max(0, Number(confirmationIntervalMs) || 0);
    this.sleepFn = sleepFn;
    this.pickup = pickup;
    this.accountLocks = new Set();
  }

  setPickup(pickup) {
    this.pickup = pickup;
  }

  pickupPublishingState(address) {
    const value = this.pickup?.publishingState?.(address);
    return {
      active: Boolean(value?.active),
      version: Number(value?.version || 0),
      observable: Boolean(value && Object.hasOwn(value, "version")),
    };
  }

  pickupPublishingChanged(address, before) {
    const after = this.pickupPublishingState(address);
    return after.active || (before.observable && after.version !== before.version);
  }

  account(accountId) {
    const id = Number(accountId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw failure("源头邮箱不存在", 404, "MAILCOM_ACCOUNT_NOT_FOUND");
    }
    const account = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(id);
    if (!account) throw failure("源头邮箱不存在", 404, "MAILCOM_ACCOUNT_NOT_FOUND");
    if (account.provider !== "mailcom") {
      throw failure("这个源头邮箱不是 Mail.com 账号", 409, "MAILCOM_ACCOUNT_REQUIRED");
    }
    return account;
  }

  localActiveAliases(accountId) {
    return this.db.prepare(`
      SELECT * FROM addresses
      WHERE account_id = ? AND kind = 'official' AND strategy = ? AND status = 'active'
      ORDER BY created_at, id
    `).all(accountId, MAILCOM_ALIAS_STRATEGY);
  }

  localAliasHistoryCount(accountId) {
    return Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM addresses
      WHERE account_id = ? AND kind = 'official' AND strategy = ?
        AND status IN ('active', 'disabled')
    `).get(accountId, MAILCOM_ALIAS_STRATEGY)?.count || 0);
  }

  assertAliasCreationAvailable(accountId) {
    const used = this.localAliasHistoryCount(accountId);
    if (used < MAILCOM_ALIAS_HISTORY_LIMIT) return;
    throw failure(
      `Mail.com 历史别名创建额度已耗尽（本地已记录 ${used} 个官方别名），无法继续补建或安全轮换`,
      409,
      "MAILCOM_ALIAS_LIFETIME_QUOTA_EXHAUSTED",
    );
  }

  aliasItem(accountId, address) {
    return this.db.prepare(`
      SELECT * FROM addresses
      WHERE account_id = ? AND address = ? COLLATE NOCASE
        AND kind = 'official' AND strategy = ?
      LIMIT 1
    `).get(accountId, address, MAILCOM_ALIAS_STRATEGY);
  }

  hasActiveRegistration(item) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM registration_jobs
      WHERE (
        (account_id = ? AND (address_id = ? OR base_address_id = ?))
        OR email = ? COLLATE NOCASE
      )
        AND lower(status) IN ('queued', 'pending', 'claimed', 'running', 'paused', 'cancel_requested')
      LIMIT 1
    `).get(item.account_id, item.id, item.id, item.address));
  }

  hasSuccessfulAgreement(address) {
    const normalized = String(address || "").trim().toLowerCase();
    if (!normalized) return false;
    return Boolean(this.db.prepare(`
      SELECT 1 FROM mailcom_registration_pipeline_attempts
      WHERE email = ? COLLATE NOCASE AND agreement_status = 'succeeded'
      LIMIT 1
    `).get(normalized));
  }

  assertAgreementNotProtected(address) {
    if (!this.hasSuccessfulAgreement(address)) return;
    throw failure(
      "这个 Mail.com 邮箱已完成协议授权，永久禁止删除或轮换",
      409,
      "MAILCOM_ALIAS_AGREEMENT_PROTECTED",
    );
  }

  async assertStaleAliasesRemovable(stale) {
    if (!stale.length) return;
    stale.forEach((item) => this.assertAgreementNotProtected(item.address));
    if (stale.some((item) => this.hasActiveRegistration(item))) {
      throw failure(
        "本地 Mail.com 别名与官网不一致，其中有地址正在注册，无法安全同步",
        409,
        "MAILCOM_ALIAS_RECONCILE_CONFLICT",
      );
    }
    const publishingBefore = new Map(stale.map((item) => [
      String(item.address || "").toLowerCase(),
      this.pickupPublishingState(item.address),
    ]));
    if ([...publishingBefore.values()].some((state) => state.active)) {
      throw failure(
        "本地 Mail.com 别名正在上架取件站，无法安全同步",
        409,
        "MAILCOM_ALIAS_RECONCILE_CONFLICT",
      );
    }
    if (this.pickup?.registrationProtectionEnabled?.()) {
      const inventory = await this.pickup.listStatuses();
      if (stale.some((item) => this.pickupPublishingChanged(
        item.address,
        publishingBefore.get(String(item.address || "").toLowerCase()),
      ))) {
        throw failure(
          "本地 Mail.com 别名在库存检查期间开始上架，无法安全同步",
          409,
          "MAILCOM_ALIAS_RECONCILE_CONFLICT",
        );
      }
      const listed = new Set((inventory?.items || [])
        .filter((item) => ["ready", "sold"].includes(String(item?.status || "").toLowerCase()))
        .map((item) => String(item?.email || "").trim().toLowerCase()));
      if (stale.some((item) => listed.has(String(item.address || "").toLowerCase()))) {
        throw failure(
          "本地 Mail.com 别名与官网不一致，其中有地址仍在取件站库存，无法安全同步",
          409,
          "MAILCOM_ALIAS_RECONCILE_CONFLICT",
        );
      }
    }
    if (stale.some((item) => this.hasActiveRegistration(item))) {
      throw failure(
        "本地 Mail.com 别名在同步期间开始注册，请稍后重试",
        409,
        "MAILCOM_ALIAS_RECONCILE_CONFLICT",
      );
    }
  }

  async assertAliasRemovable(item) {
    this.assertAgreementNotProtected(item.address);
    if (this.hasActiveRegistration(item)) {
      throw failure(
        "这个 Mail.com 别名正在注册，无法轮换",
        409,
        "MAILCOM_ALIAS_RECYCLE_PROTECTED",
      );
    }
    const publishingBefore = this.pickupPublishingState(item.address);
    if (publishingBefore.active) {
      throw failure(
        "这个 Mail.com 别名正在上架取件站，无法轮换",
        409,
        "MAILCOM_ALIAS_RECYCLE_PROTECTED",
      );
    }
    if (this.pickup?.registrationProtectionEnabled?.()) {
      const inventory = await this.pickup.listStatuses();
      if (this.pickupPublishingChanged(item.address, publishingBefore)) {
        throw failure(
          "这个 Mail.com 别名在库存检查期间开始上架，无法轮换",
          409,
          "MAILCOM_ALIAS_RECYCLE_PROTECTED",
        );
      }
      const listed = new Set((inventory?.items || [])
        .filter((entry) => ["ready", "sold"].includes(String(entry?.status || "").toLowerCase()))
        .map((entry) => String(entry?.email || "").trim().toLowerCase()));
      if (listed.has(String(item.address || "").toLowerCase())) {
        throw failure(
          "这个 Mail.com 别名仍在取件站库存，无法轮换",
          409,
          "MAILCOM_ALIAS_RECYCLE_PROTECTED",
        );
      }
    }
    if (this.hasActiveRegistration(item)) {
      throw failure(
        "这个 Mail.com 别名在检查期间开始注册，请稍后重试",
        409,
        "MAILCOM_ALIAS_RECYCLE_PROTECTED",
      );
    }
  }

  assertRemoteAliasRemovable(record) {
    if (!record?.protected) return;
    throw failure(
      "Mail.com 官网将这个地址标记为母号、默认地址或不可删除地址，无法轮换",
      409,
      "MAILCOM_ALIAS_REMOTE_PROTECTED",
    );
  }

  async syncAliases(account, remoteAddresses, purpose = "Mail.com 官网自动创建") {
    const primary = account.email.toLowerCase();
    const aliases = normalizeRemoteMailcomAddresses(remoteAddresses).filter((address) => address !== primary);
    const remote = new Set(aliases);
    const stale = this.localActiveAliases(account.id)
      .filter((item) => !remote.has(String(item.address || "").toLowerCase()));
    await this.assertStaleAliasesRemovable(stale);
    const items = importMailcomAliases(this.db, account, aliases, { replace: true, purpose });
    if (stale.length) {
      audit(this.db, account.id, "alias", "清理过期 Mail.com 本地别名映射", `官网未包含的 ${stale.length} 个本地映射已停用`, {
        removed: stale.length,
        remote_count: aliases.length,
      });
    }
    return { aliases, items };
  }

  sessionAddresses(value, primaryAddress = "") {
    return remoteAddressSnapshot(value, primaryAddress).addresses;
  }

  async sessionSnapshot(session, primaryAddress = "") {
    return remoteAddressSnapshot(await session.listAddresses(), primaryAddress);
  }

  async confirmedRemoteAddresses(session, expectedAddress = "", primaryAddress = "") {
    const attempts = expectedAddress ? this.confirmationAttempts : 1;
    let addresses = [];
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      addresses = this.sessionAddresses(await session.listAddresses(), primaryAddress);
      if (!expectedAddress || addresses.includes(expectedAddress)) return addresses;
      if (attempt + 1 < attempts && this.confirmationIntervalMs) {
        await this.sleepFn(this.confirmationIntervalMs);
      }
    }
    throw failure(
      `Mail.com 未确认新别名 ${expectedAddress}，请稍后重试同步`,
      502,
      "MAILCOM_ALIAS_CONFIRMATION_FAILED",
    );
  }

  async confirmedRemoteRemoval(session, removedAddress, primaryAddress = "") {
    let addresses = [];
    for (let attempt = 0; attempt < this.confirmationAttempts; attempt += 1) {
      addresses = this.sessionAddresses(await session.listAddresses(), primaryAddress);
      if (!addresses.includes(removedAddress)) return addresses;
      if (attempt + 1 < this.confirmationAttempts && this.confirmationIntervalMs) {
        await this.sleepFn(this.confirmationIntervalMs);
      }
    }
    throw failure(
      `Mail.com 未确认别名 ${removedAddress} 已删除，请稍后重试同步`,
      502,
      "MAILCOM_ALIAS_DELETE_CONFIRMATION_FAILED",
    );
  }

  randomizedDomains(domains) {
    const shuffled = [...domains];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const sampled = Number(this.randomIntFn(index + 1));
      const target = Number.isSafeInteger(sampled) && sampled >= 0 && sampled <= index
        ? sampled : Math.abs(Math.trunc(sampled || 0)) % (index + 1);
      [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
    }
    return shuffled;
  }

  async availableCandidate(session, domains, occupied, { randomizeDomains = false } = {}) {
    for (let attempt = 0; attempt < this.maxValidationAttempts; attempt += 1) {
      const localPart = generatedLocalPart(this.randomBytesFn);
      const candidates = randomizeDomains ? this.randomizedDomains(domains) : domains;
      for (const domain of candidates) {
        const address = normalizeMailcomEmail(`${localPart}@${domain}`);
        if (!address || occupied.has(address)) continue;
        const result = await session.validateAlias({ localPart, domain, address });
        if (validationAvailable(result)) return { localPart, domain, address };
      }
    }
    throw failure(
      "多次生成的 Mail.com 别名均不可用，请稍后重试",
      409,
      "MAILCOM_ALIAS_CANDIDATE_EXHAUSTED",
    );
  }

  async withAccountLock(account, operation) {
    if (this.accountLocks.has(account.id)) {
      throw failure(
        "这个 Mail.com 账号正在处理官方别名，请等待当前操作完成",
        409,
        "MAILCOM_ALIAS_CREATION_IN_PROGRESS",
      );
    }
    this.accountLocks.add(account.id);
    try {
      return await operation();
    } finally {
      this.accountLocks.delete(account.id);
    }
  }

  activeDomains(value) {
    const domains = normalizeRemoteMailcomDomains(value);
    if (!domains.length) {
      throw failure("Mail.com 没有返回可用别名域名", 502, "MAILCOM_ALIAS_DOMAINS_EMPTY");
    }
    return domains;
  }

  creationDomains(account, domains, domain, { required = false } = {}) {
    const rawDomain = String(domain || "").trim();
    if (randomDomainRequested(rawDomain)) return [...domains];
    const selected = normalizeRequestedDomain(rawDomain);
    if (rawDomain && (!selected || !domains.includes(selected))) {
      throw failure(
        `Mail.com 当前账号不支持域名后缀 ${rawDomain.replace(/^@/, "").toLowerCase()}`,
        409,
        "MAILCOM_ALIAS_DOMAIN_UNAVAILABLE",
      );
    }
    if (required && !selected) {
      throw failure("请指定 Mail.com 别名域名后缀", 400, "MAILCOM_ALIAS_DOMAIN_REQUIRED");
    }
    if (selected) return [selected];
    const primaryDomain = account.email.split("@")[1].toLowerCase();
    return domains.includes(primaryDomain)
      ? [primaryDomain, ...domains.filter((candidate) => candidate !== primaryDomain)]
      : domains;
  }

  resultPayload({ status, existing, created, remote, items, account, domains = [], domain = "" }) {
    const total = remote.length;
    const remaining = Math.max(0, MAILCOM_ADDRESS_LIMIT - total);
    return {
      status,
      existing,
      created,
      total,
      created_count: created,
      existing_count: existing,
      remote_count: total,
      remaining,
      items,
      account: publicAccount(this.db, this.account(account.id)),
      counts: {
        existing,
        created,
        aliases: Math.max(0, total - 1),
        total,
        remaining,
        limit: MAILCOM_ADDRESS_LIMIT,
      },
      domains,
      domain,
    };
  }

  async autoCreate(accountId, options = {}) {
    const account = this.account(accountId);
    return this.withAccountLock(account, () => this.run(account, { domain: options?.domain }));
  }

  async prepareAccount(accountId, options = {}) {
    const account = this.account(accountId);
    const result = await this.withAccountLock(account, () => this.run(account, {
      domain: options?.domain,
      requireDomain: true,
    }));
    return {
      items: result.items,
      account: result.account,
      counts: result.counts,
      domains: result.domains,
      domain: result.domain,
    };
  }

  async verifyAuthorization(accountId) {
    const account = this.account(accountId);
    return this.withAccountLock(account, () => this.runAuthorizationVerification(account));
  }

  async runAuthorizationVerification(account) {
    let session;
    let credentials;
    try {
      if (typeof this.mailcom.credentials !== "function") {
        throw failure(
          "这个邮箱还没有配置可用于网页登录的 Mail.com 密码",
          409,
          "MAILCOM_CREDENTIAL_REQUIRED",
        );
      }
      credentials = this.mailcom.credentials(account);
      session = await this.adapter.open({
        username: credentials.username,
        password: credentials.password,
        accountId: account.id,
      });
      if (!session || typeof session.listAddresses !== "function"
        || typeof session.listDomains !== "function") {
        throw failure("Mail.com 网页授权验证适配器不可用", 503, "MAILCOM_ALIAS_ADAPTER_UNAVAILABLE");
      }

      const addresses = this.sessionAddresses(await session.listAddresses(), account.email);
      if (!addresses.includes(account.email.toLowerCase())) {
        throw failure(
          "Mail.com 网页登录账号与当前母号不一致",
          409,
          "MAILCOM_ALIAS_ACCOUNT_MISMATCH",
        );
      }
      const domains = this.activeDomains(await session.listDomains());
      return {
        account: publicAccount(this.db, this.account(account.id)),
        addresses,
        domains,
      };
    } catch (error) {
      throw mappedFailure(error, [credentials?.password]);
    } finally {
      try {
        await session?.close?.();
      } catch {
        // Closing an in-memory browser session must not replace the verification result.
      }
      if (credentials) {
        credentials.password = "";
        credentials.username = "";
      }
    }
  }

  async run(account, { domain = "", requireDomain = false } = {}) {
    let session;
    let credentials;
    const created = [];
    let latestRemote = [];
    let initialRemote = new Set();
    let initialRemoteKnown = false;
    let synced = { aliases: [], items: [] };
    const randomDomainMode = randomDomainRequested(domain);
    audit(this.db, account.id, "alias", "开始自动创建 Mail.com 官方别名", "将官网地址补足到 10 个", {
      target_address_count: MAILCOM_ADDRESS_LIMIT,
    });
    try {
      if (typeof this.mailcom.credentials !== "function") {
        throw failure(
          "这个邮箱还没有配置可用于网页登录的 Mail.com 密码",
          409,
          "MAILCOM_CREDENTIAL_REQUIRED",
        );
      }
      credentials = this.mailcom.credentials(account);
      session = await this.adapter.open({
        username: credentials.username,
        password: credentials.password,
        accountId: account.id,
      });
      if (!session || typeof session.listAddresses !== "function"
        || typeof session.listDomains !== "function"
        || typeof session.validateAlias !== "function"
        || typeof session.createAlias !== "function") {
        throw failure("Mail.com 自动创建适配器不可用", 503, "MAILCOM_ALIAS_ADAPTER_UNAVAILABLE");
      }

      latestRemote = await this.confirmedRemoteAddresses(session, "", account.email);
      if (!latestRemote.includes(account.email.toLowerCase())) {
        throw failure(
          "Mail.com 网页登录账号与当前母号不一致",
          409,
          "MAILCOM_ALIAS_ACCOUNT_MISMATCH",
        );
      }
      initialRemote = new Set(latestRemote);
      initialRemoteKnown = true;
      synced = await this.syncAliases(account, latestRemote);
      const existingCount = synced.aliases.length;
      let remoteDomains = [];
      let domains = [];
      if (latestRemote.length < MAILCOM_ADDRESS_LIMIT || requireDomain || domain) {
        remoteDomains = this.activeDomains(await session.listDomains());
        domains = this.creationDomains(account, remoteDomains, domain, { required: requireDomain });
      }
      if (latestRemote.length >= MAILCOM_ADDRESS_LIMIT) {
        audit(this.db, account.id, "alias", "Mail.com 官方别名已满", `官网已有 ${latestRemote.length} 个地址`, {
          remote_count: latestRemote.length,
          created_count: 0,
        });
        return this.resultPayload({
          status: "already_full",
          existing: existingCount,
          created: 0,
          remote: latestRemote,
          items: synced.items,
          account,
          domains: remoteDomains,
          domain: randomDomainMode ? MAILCOM_RANDOM_DOMAIN : (domains[0] || ""),
        });
      }

      const occupied = new Set(latestRemote);
      const required = MAILCOM_ADDRESS_LIMIT - latestRemote.length;

      for (let index = 0; index < required; index += 1) {
        this.assertAliasCreationAvailable(account.id);
        const candidate = await this.availableCandidate(session, domains, occupied, {
          randomizeDomains: randomDomainMode,
        });
        await session.createAlias(candidate);
        latestRemote = await this.confirmedRemoteAddresses(session, candidate.address, account.email);
        occupied.add(candidate.address);
        created.push(candidate.address);
        synced = await this.syncAliases(account, latestRemote);
        audit(this.db, account.id, "alias", "自动创建 Mail.com 官方别名", candidate.address, {
          created_count: created.length,
          remote_count: latestRemote.length,
        });
        if (latestRemote.length >= MAILCOM_ADDRESS_LIMIT) break;
      }

      const finalSync = await this.syncAliases(account, latestRemote);
      audit(this.db, account.id, "alias", "Mail.com 官方别名自动创建完成", `新建 ${created.length} 个，官网共 ${latestRemote.length} 个地址`, {
        created_count: created.length,
        remote_count: latestRemote.length,
      });
      return this.resultPayload({
        status: "completed",
        existing: Math.max(0, latestRemote.length - 1 - created.length),
        created: created.length,
        remote: latestRemote,
        items: finalSync.items,
        account,
        domains: remoteDomains,
        domain: randomDomainMode ? MAILCOM_RANDOM_DOMAIN : (domains[0] || ""),
      });
    } catch (error) {
      if (session && typeof session.listAddresses === "function") {
        try {
          latestRemote = await this.confirmedRemoteAddresses(session, "", account.email);
          if (latestRemote.includes(account.email.toLowerCase())) {
            synced = await this.syncAliases(account, latestRemote);
          }
        } catch {
          // Each confirmed alias is synchronized above; final reconciliation is best effort.
        }
      }
      const mapped = mappedFailure(error, [credentials?.password]);
      const primary = account.email.toLowerCase();
      const confirmedCreated = [...new Set([
        ...created,
        ...(initialRemoteKnown
          ? latestRemote.filter((address) => address !== primary && !initialRemote.has(address))
          : []),
      ])];
      if (confirmedCreated.length) {
        mapped.partial = {
          created: confirmedCreated.length,
          total: latestRemote.length,
          existing: Math.max(0, latestRemote.length - 1 - confirmedCreated.length),
        };
        mapped.account = publicAccount(this.db, this.account(account.id));
        mapped.items = synced.items;
      }
      audit(this.db, account.id, "alias", "Mail.com 官方别名自动创建失败", mapped.message, {
        code: mapped.code,
        created_count: confirmedCreated.length,
        remote_count: latestRemote.length,
      });
      throw mapped;
    } finally {
      try {
        await session?.close?.();
      } catch {
        // Closing an in-memory browser session must not replace the operation result.
      }
      if (credentials) {
        credentials.password = "";
        credentials.username = "";
      }
    }
  }

  async recycleAlias(accountId, options = {}) {
    const account = this.account(accountId);
    return this.withAccountLock(account, () => this.runRecycle(account, options || {}));
  }

  async runRecycle(account, { address, domain, replacementAddress } = {}) {
    const normalizedAddress = normalizeMailcomEmail(address);
    if (!normalizedAddress) {
      throw failure("请指定有效的 Mail.com 官方别名", 400, "MAILCOM_ALIAS_ADDRESS_INVALID");
    }
    if (normalizedAddress === account.email.toLowerCase()) {
      throw failure("Mail.com 母号不能删除或轮换", 409, "MAILCOM_ALIAS_PRIMARY_PROTECTED");
    }
    let target = this.aliasItem(account.id, normalizedAddress);
    if (!target) {
      throw failure("要轮换的 Mail.com 官方别名不存在", 404, "MAILCOM_ALIAS_NOT_FOUND");
    }
    await this.assertAliasRemovable(target);

    let session;
    let credentials;
    let latestRemote = [];
    let synced = { aliases: [], items: [] };
    let removedRemotely = false;
    let createdRemotely = false;
    let remoteMutationPossible = false;
    let mutationPhase = "before_remote_mutation";
    let candidate = null;
    const randomDomainMode = randomDomainRequested(domain);
    try {
      if (typeof this.mailcom.credentials !== "function") {
        throw failure(
          "这个邮箱还没有配置可用于网页登录的 Mail.com 密码",
          409,
          "MAILCOM_CREDENTIAL_REQUIRED",
        );
      }
      credentials = this.mailcom.credentials(account);
      session = await this.adapter.open({
        username: credentials.username,
        password: credentials.password,
        accountId: account.id,
      });
      if (!session || typeof session.listAddresses !== "function"
        || typeof session.listDomains !== "function"
        || typeof session.validateAlias !== "function"
        || typeof session.createAlias !== "function"
        || typeof session.deleteAlias !== "function") {
        throw failure("Mail.com 别名轮换适配器不可用", 503, "MAILCOM_ALIAS_ADAPTER_UNAVAILABLE");
      }

      let snapshot = await this.sessionSnapshot(session, account.email);
      latestRemote = snapshot.addresses;
      if (!latestRemote.includes(account.email.toLowerCase())) {
        throw failure(
          "Mail.com 网页登录账号与当前母号不一致",
          409,
          "MAILCOM_ALIAS_ACCOUNT_MISMATCH",
        );
      }
      synced = await this.syncAliases(account, latestRemote, "Mail.com 官网别名轮换");
      const remoteDomains = this.activeDomains(await session.listDomains());
      const domains = this.creationDomains(account, remoteDomains, domain, { required: true });
      const suppliedReplacement = String(replacementAddress || "").trim();
      if (suppliedReplacement) {
        const normalizedReplacement = normalizeMailcomEmail(suppliedReplacement);
        const replacementDomain = normalizedReplacement?.split("@")[1] || "";
        if (!normalizedReplacement || (randomDomainMode
          ? !domains.includes(replacementDomain)
          : replacementDomain !== domains[0])) {
          throw failure(
            "稳定替代地址无效，或其域名后缀与指定 domain 不一致",
            400,
            "MAILCOM_ALIAS_REPLACEMENT_INVALID",
          );
        }
        if (normalizedReplacement === normalizedAddress
          || normalizedReplacement === account.email.toLowerCase()) {
          throw failure(
            "稳定替代地址不能是母号，也不能与要删除的旧别名相同",
            400,
            "MAILCOM_ALIAS_REPLACEMENT_INVALID",
          );
        }
        candidate = {
          localPart: normalizedReplacement.split("@")[0],
          domain: replacementDomain,
          address: normalizedReplacement,
        };
      }
      if (candidate) {
        if (!latestRemote.includes(candidate.address)) {
          const validation = await session.validateAlias(candidate);
          if (!validationAvailable(validation)) {
            throw failure(
              "指定的稳定替代地址已不可用，请生成新的 replacementAddress 后重试",
              409,
              "MAILCOM_ALIAS_REPLACEMENT_UNAVAILABLE",
            );
          }
        }
      } else {
        candidate = await this.availableCandidate(session, domains, new Set(latestRemote), {
          randomizeDomains: randomDomainMode,
        });
      }

      if (!latestRemote.includes(candidate.address)) {
        this.assertAliasCreationAvailable(account.id);
      }

      target = this.aliasItem(account.id, normalizedAddress) || target;
      await this.assertAliasRemovable(target);
      if (latestRemote.includes(normalizedAddress)) {
        this.assertRemoteAliasRemovable(snapshot.records.get(normalizedAddress));
        mutationPhase = "delete_submitting";
        remoteMutationPossible = true;
        await session.deleteAlias({ address: normalizedAddress });
        removedRemotely = true;
        mutationPhase = "delete_confirming";
        latestRemote = await this.confirmedRemoteRemoval(session, normalizedAddress, account.email);
        mutationPhase = "delete_confirmed";
        synced = await this.syncAliases(account, latestRemote, "Mail.com 官网别名轮换");
      }
      if (!candidate || !latestRemote.includes(candidate.address)) {
        if (latestRemote.length >= MAILCOM_ADDRESS_LIMIT) {
          throw failure(
            "Mail.com 官网地址仍已满；请使用上次持久化的 replacementAddress 重放轮换",
            409,
            "MAILCOM_ALIAS_RECYCLE_LIMIT",
          );
        }
        mutationPhase = "create_submitting";
        remoteMutationPossible = true;
        await session.createAlias(candidate);
        createdRemotely = true;
        mutationPhase = "create_confirming";
        latestRemote = await this.confirmedRemoteAddresses(session, candidate.address, account.email);
        mutationPhase = "create_confirmed";
        synced = await this.syncAliases(account, latestRemote, "Mail.com 官网别名轮换");
      }
      const item = synced.items.find((entry) => String(entry.address || "").toLowerCase() === candidate.address);
      audit(this.db, account.id, "alias", "轮换 Mail.com 官方别名", `${normalizedAddress} -> ${candidate.address}`, {
        removed_remote: removedRemotely,
        created_remote: createdRemotely,
        replacement_address: candidate.address,
        domain: candidate.domain,
        remote_count: latestRemote.length,
      });
      return {
        removed: normalizedAddress,
        created: candidate.address,
        item,
        account: publicAccount(this.db, this.account(account.id)),
        removed_remote: removedRemotely,
        created_remote: createdRemotely,
      };
    } catch (error) {
      if (session && typeof session.listAddresses === "function") {
        try {
          latestRemote = await this.confirmedRemoteAddresses(session, "", account.email);
          if (latestRemote.includes(account.email.toLowerCase())) {
            synced = await this.syncAliases(account, latestRemote, "Mail.com 官网别名轮换");
          }
        } catch {
          // The post-delete sync above is authoritative; this is only a final best-effort refresh.
        }
      }
      const mapped = mappedFailure(error, [credentials?.password]);
      mapped.mutation_phase = mutationPhase;
      mapped.remote_mutation_possible = remoteMutationPossible;
      mapped.removed_remotely = removedRemotely;
      mapped.created_remotely = createdRemotely;
      mapped.replacement_address = candidate?.address || "";
      audit(this.db, account.id, "alias", "轮换 Mail.com 官方别名失败", mapped.message, {
        code: mapped.code,
        removed: normalizedAddress,
        removed_remote: removedRemotely,
        created_remote: createdRemotely,
        replacement_address: candidate?.address || "",
        remote_count: latestRemote.length,
      });
      throw mapped;
    } finally {
      try {
        await session?.close?.();
      } catch {
        // Closing an in-memory browser session must not replace the operation result.
      }
      if (credentials) {
        credentials.password = "";
        credentials.username = "";
      }
    }
  }
}

export class UnavailableMailcomAliasAdapter {
  async open() {
    throw failure(
      "服务器尚未配置 Mail.com 网页自动创建组件",
      503,
      "MAILCOM_ALIAS_ADAPTER_UNAVAILABLE",
    );
  }
}

export const mailcomAliasAddressLimit = MAILCOM_ADDRESS_LIMIT;
export const mailcomAliasHistoryLimit = MAILCOM_ALIAS_HISTORY_LIMIT;
