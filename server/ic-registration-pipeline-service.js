import crypto from "node:crypto";
import { isIcloudImportedStrategy } from "./address-generator.js";
import { nowIso } from "./db.js";
import { redactProxySecrets } from "./registration-proxy.js";

const ACTIVE_STATUSES = new Set(["queued", "running", "cancel_requested"]);
const TERMINAL_STATUSES = new Set([
  "completed", "partial_failed", "failed", "cancelled", "interrupted",
]);
const ITEM_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const ITEM_FAILURE_STATUSES = new Set(["failed", "interrupted"]);
const PAYMENT_LINK_COUNTRIES = new Set(["DE", "TR", "GB", "US", "BR", "TH", "JP"]);
const BROWSER_MODES = new Set(["headed", "headless"]);
const MAILBOX_MODES = new Set(["existing", "auto_create"]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function failure(message, status = 400, code = "IC_PIPELINE_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

function safeError(value, fallback = "流水线执行失败") {
  const source = value instanceof Error ? value.message : String(value || "");
  return redactProxySecrets(source || fallback)
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/\beyj[a-z0-9_-]{10,}(?:\.[a-z0-9_-]{4,}){1,2}\b/gi, "[REDACTED_TOKEN]")
    .replace(/\b\d{6}\b/g, "******")
    .slice(0, 500);
}

function positiveInteger(value, label, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw failure(`${label}必须是 1 到 ${maximum} 的整数`);
  }
  return number;
}

function normalizeInput(input = {}) {
  const accountId = positiveInteger(input.accountId, "iCloud 账号 ID", Number.MAX_SAFE_INTEGER);
  const mailboxMode = String(input.mailboxMode || "existing").trim().toLowerCase();
  if (!MAILBOX_MODES.has(mailboxMode)) throw failure("邮箱准备模式无效");
  const baseAddressId = mailboxMode === "existing"
    ? positiveInteger(input.baseAddressId, "iCloud 地址 ID", Number.MAX_SAFE_INTEGER)
    : null;
  const count = positiveInteger(input.count ?? 1, "流水线数量", mailboxMode === "auto_create" ? 20 : 200);
  const concurrency = positiveInteger(input.concurrency ?? 1, "流水线并发数", 5);
  const browserMode = String(input.browserMode || "headed").trim().toLowerCase();
  if (!BROWSER_MODES.has(browserMode)) throw failure("浏览器模式无效");
  const proxySelection = String(input.proxySelection || "auto").trim().toLowerCase();
  if (!new Set(["auto", "direct"]).has(proxySelection) && !/^proxy:\d+$/.test(proxySelection)) {
    throw failure("注册代理选择无效");
  }
  const paymentLinkCountry = String(input.paymentLinkCountry || "DE").trim().toUpperCase();
  if (!PAYMENT_LINK_COUNTRIES.has(paymentLinkCountry)) throw failure("提链国家无效");
  const requestId = String(input.requestId || "").trim();
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw failure("requestId 必须是 8 到 128 位安全字符");
  }
  return {
    accountId,
    baseAddressId,
    mailboxMode,
    count,
    concurrency,
    browserMode,
    proxySelection,
    paymentLinkCountry,
    requestId,
  };
}

function requestFingerprint(input) {
  const value = {
    accountId: input.accountId,
    baseAddressId: input.baseAddressId,
    count: input.count,
    concurrency: input.concurrency,
    browserMode: input.browserMode,
    proxySelection: input.proxySelection,
    paymentLinkCountry: input.paymentLinkCountry,
  };
  // Keep the legacy fingerprint unchanged for existing-mailbox requests.
  if (input.mailboxMode === "auto_create") value.mailboxMode = input.mailboxMode;
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isDirectIcloudAddress(row) {
  return row?.kind === "primary"
    || (row?.kind === "official" && isIcloudImportedStrategy(row.strategy));
}

function agreementJob(response) {
  return response?.job && typeof response.job === "object" ? response.job : response;
}

function agreementStatus(snapshot) {
  return String(snapshot?.status || "").trim().toLowerCase();
}

function stagePhase(value) {
  const stage = String(value || "").trim().toLowerCase();
  if (!stage) return "";
  if (stage === "queued" || stage.startsWith("registration_") || stage === "registering" || stage === "registered") {
    return "registration";
  }
  if (stage.startsWith("mailbox_") || stage.startsWith("creating_mail")) return "mailbox";
  if (stage.startsWith("link_") || stage.startsWith("extracting_link")) return "link";
  if (stage.startsWith("agreement_") || stage === "paying" || stage.startsWith("payment_")) return "agreement";
  return "";
}

function itemFailurePhase(item) {
  const saved = stagePhase(item?.failure_stage);
  if (saved) return saved;
  if (!item?.address_id || !String(item?.email || "").trim()) return "mailbox";
  if (!item?.external_account_id) return "registration";
  if (item?.agreement_job_id) return "agreement";
  return "link";
}

export class IcRegistrationPipelineService {
  constructor({
    db,
    registration,
    paymentLinks,
    paymentAgreements,
    icloudPrivacy = null,
    pollIntervalMs = 1_000,
    sleepFn = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    if (!db || !registration || !paymentLinks || !paymentAgreements) {
      throw new TypeError("IcRegistrationPipelineService dependencies are required");
    }
    this.db = db;
    this.registration = registration;
    this.paymentLinks = paymentLinks;
    this.paymentAgreements = paymentAgreements;
    this.icloudPrivacy = icloudPrivacy;
    this.pollIntervalMs = Math.max(20, Number(pollIntervalMs) || 1_000);
    this.sleepFn = sleepFn;
    this.trackers = new Map();
    this.cancellations = new Map();
    this.wakes = new Map();
    this.closed = false;
    this.recoveryPromise = this.recoverActivePipelines();
  }

  taskRow(id) {
    return this.db.prepare("SELECT * FROM ic_registration_pipelines WHERE id = ?").get(String(id || ""));
  }

  requestRow(requestId) {
    return this.db.prepare("SELECT * FROM ic_registration_pipelines WHERE request_id = ?")
      .get(String(requestId || ""));
  }

  itemRow(id) {
    return this.db.prepare("SELECT * FROM ic_registration_pipeline_items WHERE id = ?").get(Number(id));
  }

  items(id) {
    return this.db.prepare(`
      SELECT * FROM ic_registration_pipeline_items WHERE pipeline_id = ? ORDER BY id
    `).all(String(id || ""));
  }

  publicItem(row) {
    if (!row) return null;
    return {
      id: row.id,
      pipeline_id: row.pipeline_id,
      address_id: row.address_id,
      email: row.email,
      mailbox_id: row.mailbox_id,
      registration_job_id: row.registration_job_id,
      external_account_id: row.external_account_id ? Number(row.external_account_id) || row.external_account_id : "",
      payment_link_task_id: row.payment_link_task_id,
      agreement_job_id: row.agreement_job_id,
      status: row.status,
      stage: row.stage,
      failure_stage: row.failure_stage || "",
      terminal: ITEM_TERMINAL_STATUSES.has(row.status),
      error: safeError(row.error, ""),
      created_at: row.created_at,
      updated_at: row.updated_at,
      finished_at: row.finished_at,
    };
  }

  publicTask(id) {
    const row = typeof id === "object" ? id : this.taskRow(id);
    if (!row) return null;
    const rows = this.items(row.id);
    const phaseProgress = this.phaseProgress(row, rows);
    return {
      id: row.id,
      pipeline_id: row.id,
      request_id: row.request_id,
      account_id: row.account_id,
      base_address_id: row.base_address_id,
      mailbox_mode: row.mailbox_mode || "existing",
      privacy_account_id: row.privacy_account_id || "",
      status: row.status,
      stage: row.stage,
      terminal: TERMINAL_STATUSES.has(row.status),
      cancellable: ACTIVE_STATUSES.has(row.status),
      count: row.requested_count,
      concurrency: row.concurrency,
      browser_mode: row.browser_mode,
      proxy_selection: row.proxy_selection,
      payment_link_country: row.payment_link_country,
      progress_current: row.progress_current,
      progress_total: row.progress_total,
      success_count: row.success_count,
      failure_count: row.failure_count,
      cancelled_count: row.cancelled_count,
      message: `邮箱 ${phaseProgress.mailbox.succeeded}/${rows.length} · 注册 ${phaseProgress.registration.succeeded}/${rows.length} · 提链 ${phaseProgress.link.succeeded}/${rows.length} · 协议 ${phaseProgress.agreement.succeeded}/${rows.length}`,
      phase_progress: phaseProgress,
      error: safeError(row.error, ""),
      created_at: row.created_at,
      updated_at: row.updated_at,
      finished_at: row.finished_at,
      items: rows.map((item) => this.publicItem(item)),
    };
  }

  phaseProgress(task, rows = this.items(task?.id)) {
    const activeItems = rows.filter((item) => ACTIVE_STATUSES.has(item.status));
    const failedItems = rows.filter((item) => ITEM_FAILURE_STATUSES.has(item.status));
    const activeStageCount = (...stages) => activeItems.filter((item) => stages.includes(String(item.stage || ""))).length;
    const failedStageCount = (phase) => failedItems.filter((item) => itemFailurePhase(item) === phase).length;
    const registrationWaiting = activeStageCount("queued", "registration_queued");
    const registrationSubmitting = String(task?.stage || "") === "registration_submitting";
    const reachedAgreement = (item) => (
      item.status === "completed"
      || Boolean(item.agreement_job_id)
      || stagePhase(item.stage) === "agreement"
      || stagePhase(item.failure_stage) === "agreement"
    );
    const progress = {
      mailbox: {
        unit: "item",
        waiting: activeStageCount("mailbox_queued"),
        running: activeStageCount("mailbox_submitting", "creating_mailbox", "creating_mailboxes"),
        retrying: 0,
        succeeded: rows.filter((item) => item.address_id && String(item.email || "").trim()).length,
        failed: failedStageCount("mailbox"),
        total: rows.length,
      },
      registration: {
        unit: "item",
        waiting: registrationSubmitting ? 0 : registrationWaiting,
        running: activeStageCount("registration_submitting", "registration_wait", "registering")
          + (registrationSubmitting ? registrationWaiting : 0),
        retrying: 0,
        succeeded: rows.filter((item) => item.external_account_id).length,
        failed: failedStageCount("registration"),
        total: rows.length,
      },
      link: {
        unit: "item",
        waiting: activeStageCount("link_ready"),
        running: activeStageCount("link_submitting", "link_wait", "extracting_link", "extracting_links"),
        retrying: 0,
        succeeded: rows.filter(reachedAgreement).length,
        failed: failedStageCount("link"),
        total: rows.length,
      },
      agreement: {
        unit: "item",
        waiting: activeStageCount("agreement_ready", "agreement_queued"),
        running: activeStageCount("agreement_submitting", "agreement_wait", "agreement_running", "paying"),
        retrying: 0,
        succeeded: rows.filter((item) => item.status === "completed").length,
        failed: failedStageCount("agreement"),
        total: rows.length,
      },
    };
    return progress;
  }

  list({ limit = 20 } = {}) {
    const bounded = Math.max(1, Math.min(100, Number(limit) || 20));
    const rows = this.db.prepare(`
      SELECT * FROM ic_registration_pipelines ORDER BY created_at DESC LIMIT ?
    `).all(bounded);
    const activeCount = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM ic_registration_pipelines
      WHERE status IN ('queued', 'running', 'cancel_requested')
    `).get()?.count || 0);
    const activeRow = this.db.prepare(`
      SELECT * FROM ic_registration_pipelines
      WHERE status IN ('queued', 'running', 'cancel_requested')
      ORDER BY created_at DESC LIMIT 1
    `).get();
    return {
      items: rows.map((row) => this.publicTask(row)),
      active: activeRow ? this.publicTask(activeRow) : null,
      active_count: activeCount,
    };
  }

  async mailboxStatus() {
    const configured = Boolean(this.icloudPrivacy?.configured?.());
    const sources = this.db.prepare(`
      SELECT id, email, status FROM source_accounts
      WHERE provider = 'icloud' ORDER BY updated_at DESC, id DESC
    `).all();
    if (!configured) {
      return {
        configured: false,
        sessions: sources.map((source) => ({
          privacy_account_id: "",
          apple_id: source.email,
          source_account_id: source.id,
          ready: false,
          can_create_hme: false,
          status: "service_unconfigured",
        })),
        error: "iCloud 隐藏邮箱服务尚未配置",
      };
    }
    try {
      const result = await this.icloudPrivacy.status();
      const remoteByAppleId = new Map((Array.isArray(result?.sessions) ? result.sessions : [])
        .map((session) => [String(session?.apple_id || "").trim().toLowerCase(), session])
        .filter(([email]) => email));
      return {
        configured: true,
        sessions: sources.map((source) => {
          const remote = remoteByAppleId.get(String(source.email || "").trim().toLowerCase());
          const sourceReady = source.status === "connected";
          const loginReady = Boolean(remote?.apple_account_login_saved);
          const loginExplicitlyExpired = Boolean(remote?.apple_account_login_checked)
            && remote?.apple_account_login_ok === false;
          const manageReady = Boolean(remote?.apple_account_manage_ready);
          const ready = sourceReady && loginReady && !loginExplicitlyExpired
            && manageReady && Boolean(remote?.account_id);
          const status = ready ? "ready"
            : !sourceReady ? "source_not_connected"
              : !remote ? "login_missing"
                : !loginReady ? "login_required"
                  : loginExplicitlyExpired ? "login_expired" : "manage_not_ready";
          return {
            privacy_account_id: String(remote?.account_id || ""),
            apple_id: source.email,
            source_account_id: source.id,
            ready,
            can_create_hme: Boolean(remote?.can_create_hme),
            status,
          };
        }),
        error: "",
      };
    } catch (error) {
      return {
        configured: true,
        sessions: sources.map((source) => ({
          privacy_account_id: "",
          apple_id: source.email,
          source_account_id: source.id,
          ready: false,
          can_create_hme: false,
          status: "service_unavailable",
        })),
        error: safeError(error, "iCloud 隐藏邮箱服务当前不可用"),
      };
    }
  }

  async privacySessionForAccount(accountId) {
    const status = await this.mailboxStatus();
    if (!status.configured) {
      throw failure(status.error || "iCloud 隐藏邮箱服务尚未配置", 503, "IC_PIPELINE_MAILBOX_SERVICE_UNCONFIGURED");
    }
    if (status.error) {
      throw failure(status.error, 503, "IC_PIPELINE_MAILBOX_SERVICE_UNAVAILABLE");
    }
    const session = status.sessions.find((item) => Number(item.source_account_id) === Number(accountId));
    if (!session) throw failure("iCloud 源头邮箱不存在", 404, "IC_PIPELINE_MAILBOX_SOURCE_NOT_FOUND");
    if (!session.ready || !session.privacy_account_id) {
      const messages = {
        source_not_connected: "请先连接 iCloud 源头邮箱",
        login_missing: "请先登录对应 Apple ID",
        login_required: "Apple ID 登录态不可用，请重新登录",
        login_expired: "Apple ID 登录态已失效，请重新登录",
        manage_not_ready: "Apple ID 管理态尚未就绪，请重新登录",
      };
      throw failure(messages[session.status] || "Apple ID 隐藏邮箱创建状态不可用", 409, "IC_PIPELINE_MAILBOX_NOT_READY");
    }
    return session;
  }

  async validateDependencies() {
    let paymentLinkConfig;
    try {
      paymentLinkConfig = this.paymentLinks.configuration();
    } catch (error) {
      throw failure(
        `提链服务状态读取失败：${safeError(error, "提链服务当前不可用")}`,
        503,
        "IC_PIPELINE_LINK_UNAVAILABLE",
      );
    }
    if (!paymentLinkConfig.configured) throw failure("提链服务尚未配置", 503, "IC_PIPELINE_LINK_UNAVAILABLE");
    if (!paymentLinkConfig.checkout_proxy_count) throw failure("Checkout Proxy 池为空", 409);
    if (paymentLinkConfig.apply_checkout_update && !paymentLinkConfig.update_proxy_count) {
      throw failure("Update Proxy 池为空", 409);
    }
    let agreementSettings;
    try {
      agreementSettings = this.paymentAgreements.settings();
    } catch (error) {
      throw failure(
        `协议支付服务状态读取失败：${safeError(error, "协议支付服务当前不可用")}`,
        503,
        "IC_PIPELINE_AGREEMENT_UNAVAILABLE",
      );
    }
    if (!agreementSettings.protocol_configured) throw failure("协议支付服务尚未配置", 503);
    if (!agreementSettings.configured || !agreementSettings.api_key_configured) {
      throw failure("HeroSMS 尚未配置", 409);
    }
    try {
      this.paymentAgreements.runtime({ required: true });
    } catch (error) {
      throw failure(
        `协议支付运行配置不可用：${safeError(error, "协议支付运行配置不可用")}`,
        503,
        "IC_PIPELINE_AGREEMENT_UNAVAILABLE",
      );
    }
    let queueControl;
    try {
      queueControl = await this.registration.registrationQueueControl?.();
    } catch (error) {
      throw failure(
        `注册队列状态读取失败：${safeError(error, "注册服务当前不可用")}`,
        503,
        "IC_PIPELINE_REGISTRATION_UNAVAILABLE",
      );
    }
    if (queueControl?.paused) {
      throw failure("注册队列当前已暂停，请先恢复队列", 409, "IC_PIPELINE_QUEUE_PAUSED");
    }
    let health;
    try {
      health = await this.registration.client?.health?.();
    } catch (error) {
      throw failure(
        `注册服务健康检查失败：${safeError(error, "注册服务当前不可用")}`,
        503,
        "IC_PIPELINE_REGISTRATION_UNAVAILABLE",
      );
    }
    if (health && (health.configured === false || health.ok === false)) {
      throw failure("注册服务当前不可用", 503, "IC_PIPELINE_REGISTRATION_UNAVAILABLE");
    }
  }

  icloudSourceAccount(accountId) {
    const account = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(accountId));
    if (!account) throw failure("iCloud 账号不存在", 404);
    if (account.provider !== "icloud") throw failure("只支持 iCloud 账号", 409);
    if (account.status !== "connected") throw failure("请先连接 iCloud 账号", 409);
    return account;
  }

  async selectedAddresses(input) {
    const account = this.icloudSourceAccount(input.accountId);
    const base = this.db.prepare(`
      SELECT * FROM addresses WHERE id = ? AND account_id = ? AND status = 'active'
    `).get(input.baseAddressId, account.id);
    if (!isDirectIcloudAddress(base)) throw failure("请选择可直接注册的 iCloud 地址");
    let options;
    try {
      options = await this.registration.options();
    } catch (error) {
      throw failure(
        `注册选项读取失败：${safeError(error, "注册服务当前不可用")}`,
        503,
        "IC_PIPELINE_REGISTRATION_UNAVAILABLE",
      );
    }
    const optionAccount = (options?.accounts || []).find((item) => Number(item.id) === account.id);
    if (!optionAccount || optionAccount.provider !== "icloud") {
      throw failure("iCloud 注册选项当前不可用", 409);
    }
    const addresses = Array.isArray(optionAccount.bases) ? optionAccount.bases : [];
    const selectedIndex = addresses.findIndex((item) => Number(item.id) === input.baseAddressId);
    if (selectedIndex < 0) throw failure("请选择可直接注册的 iCloud 地址");
    if (addresses[selectedIndex].registration_disabled) {
      throw failure(addresses[selectedIndex].registration_hint || "所选 iCloud 地址当前不可注册", 409);
    }
    const selected = addresses.slice(selectedIndex)
      .filter((item) => !item.registration_disabled)
      .slice(0, input.count);
    if (selected.length !== input.count) {
      throw failure(`从所选地址往下仅有 ${selected.length} 个 iCloud 地址`, 409);
    }
    return selected;
  }

  async start(raw = {}) {
    await this.recoveryPromise;
    if (this.closed) throw failure("iCloud 流水线服务正在关闭", 503);
    const input = normalizeInput(raw);
    const fingerprint = requestFingerprint(input);
    const existing = this.requestRow(input.requestId);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) {
        throw failure("requestId 已被不同请求使用", 409, "IC_PIPELINE_IDEMPOTENCY_CONFLICT");
      }
      return this.publicTask(existing);
    }
    this.icloudSourceAccount(input.accountId);
    const addresses = input.mailboxMode === "existing" ? await this.selectedAddresses(input) : [];
    const privacySession = input.mailboxMode === "auto_create"
      ? await this.privacySessionForAccount(input.accountId)
      : null;
    await this.validateDependencies();
    const taskId = crypto.randomUUID();
    const createdAt = nowIso();
    try {
      this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO ic_registration_pipelines (
            id, request_id, request_fingerprint, account_id, base_address_id,
            mailbox_mode, privacy_account_id, status, stage,
            requested_count, concurrency, browser_mode, proxy_selection,
            payment_link_country, progress_total, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          taskId,
          input.requestId,
          fingerprint,
          input.accountId,
          input.baseAddressId,
          input.mailboxMode,
          privacySession?.privacy_account_id || "",
          input.mailboxMode === "auto_create" ? "mailbox_queued" : "queued",
          input.count,
          Math.min(input.concurrency, input.count),
          input.browserMode,
          input.proxySelection,
          input.paymentLinkCountry,
          input.count,
          createdAt,
          createdAt,
        );
        const insertItem = this.db.prepare(`
          INSERT INTO ic_registration_pipeline_items (
            pipeline_id, address_id, email, mailbox_id, status, stage, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
        `);
        if (input.mailboxMode === "auto_create") {
          for (let index = 0; index < input.count; index += 1) {
            insertItem.run(taskId, null, "", "", "mailbox_queued", createdAt, createdAt);
          }
        } else {
          addresses.forEach((address) => {
            insertItem.run(taskId, address.id, address.address, "", "queued", createdAt, createdAt);
          });
        }
      })();
    } catch (error) {
      const winner = this.requestRow(input.requestId);
      if (winner) {
        if (winner.request_fingerprint !== fingerprint) {
          throw failure("requestId 已被不同请求使用", 409, "IC_PIPELINE_IDEMPOTENCY_CONFLICT");
        }
        return this.publicTask(winner);
      }
      if (String(error?.message || "").includes("idx_ic_registration_pipeline_active_address")
        || String(error?.message || "").includes("UNIQUE constraint")) {
        throw failure("所选 iCloud 地址已有进行中的一键流水线", 409, "IC_PIPELINE_ADDRESS_BUSY");
      }
      throw error;
    }
    this.startTracker(taskId);
    return this.publicTask(taskId);
  }

  get(id) {
    const task = this.publicTask(id);
    if (!task) throw failure("iCloud 流水线不存在", 404);
    return task;
  }

  startTracker(taskId) {
    const key = String(taskId);
    if (this.trackers.has(key)) return this.trackers.get(key);
    const tracker = this.runTask(key)
      .catch(async (error) => {
        const message = safeError(error);
        const active = this.items(key).filter((item) => ACTIVE_STATUSES.has(item.status));
        await Promise.allSettled(active.map((item) => this.finishItem(item.id, "failed", message)));
        this.recompute(key);
      })
      .finally(() => this.trackers.delete(key));
    this.trackers.set(key, tracker);
    return tracker;
  }

  mailboxLabel(taskId) {
    return `ic-pipeline:${String(taskId)}`;
  }

  mailboxCandidates(task, rows) {
    const label = this.mailboxLabel(task.id);
    const seen = new Set();
    return (Array.isArray(rows) ? rows : []).filter((mailbox) => {
      const id = String(mailbox?.id || "").trim();
      const email = String(mailbox?.email || "").trim().toLowerCase();
      if (!id || !email || seen.has(id)) return false;
      if (String(mailbox?.label || "") !== label) return false;
      if (String(mailbox?.account_id || "") !== String(task.privacy_account_id || "")) return false;
      if (Number(mailbox?.alias_hub_source_account_id) !== Number(task.account_id)) return false;
      if (mailbox?.alias_hub_synced !== true) return false;
      seen.add(id);
      return true;
    });
  }

  mapCreatedMailboxes(taskId, rows) {
    const task = this.taskRow(taskId);
    if (!task) return { mapped: 0, candidates: 0 };
    const candidates = this.mailboxCandidates(task, rows);
    const addressByEmail = this.db.prepare(`
      SELECT * FROM addresses
      WHERE account_id = ? AND address = ? COLLATE NOCASE
        AND kind = 'official' AND strategy = 'icloud_hide_my_email' AND status = 'active'
      LIMIT 1
    `);
    const conflictingItem = this.db.prepare(`
      SELECT id FROM ic_registration_pipeline_items
      WHERE address_id = ? AND pipeline_id <> ?
        AND status IN ('queued', 'running', 'cancel_requested')
      LIMIT 1
    `);
    const nextPlaceholder = this.db.prepare(`
      SELECT id FROM ic_registration_pipeline_items
      WHERE pipeline_id = ? AND address_id IS NULL
        AND status IN ('queued', 'running')
      ORDER BY id LIMIT 1
    `);
    const updatePlaceholder = this.db.prepare(`
      UPDATE ic_registration_pipeline_items
      SET mailbox_id = ?, address_id = ?, email = ?, status = 'queued',
        stage = 'registration_queued', error = '', updated_at = ?
      WHERE id = ? AND address_id IS NULL AND status IN ('queued', 'running')
    `);
    const existingItems = () => this.items(taskId);
    this.db.transaction(() => {
      for (const mailbox of candidates) {
        const mailboxId = String(mailbox.id);
        const email = String(mailbox.email).trim().toLowerCase();
        const alreadyMapped = existingItems().some((item) => (
          String(item.mailbox_id || "") === mailboxId
          || (item.address_id && String(item.email || "").toLowerCase() === email)
        ));
        if (alreadyMapped) continue;
        const address = addressByEmail.get(task.account_id, email);
        if (!address || !isDirectIcloudAddress(address)) continue;
        if (conflictingItem.get(address.id, taskId)) continue;
        const placeholder = nextPlaceholder.get(taskId);
        if (!placeholder) break;
        updatePlaceholder.run(mailboxId, address.id, address.address, nowIso(), placeholder.id);
      }
    })();
    const mapped = this.items(taskId).filter((item) => item.address_id && item.email).length;
    return { mapped, candidates: candidates.length };
  }

  async reconcileCreatedMailboxes(taskId) {
    const task = this.taskRow(taskId);
    if (!task) return { mapped: 0, candidates: 0, mailboxes: [] };
    let response;
    try {
      response = await this.icloudPrivacy.listMailboxes();
    } catch (error) {
      throw failure(
        `隐藏邮箱创建结果读取失败：${safeError(error, "服务当前不可用")}`,
        Number(error?.status) || 503,
        "IC_PIPELINE_MAILBOX_RECONCILE_FAILED",
      );
    }
    const mailboxes = Array.isArray(response?.mailboxes) ? response.mailboxes : [];
    return { ...this.mapCreatedMailboxes(taskId, mailboxes), mailboxes };
  }

  mailboxAttemptErrors(response, fallback, task = null) {
    const failureMessages = (Array.isArray(response?.failures) ? response.failures : [])
      .map((item) => item?.error || item?.message)
      .filter(Boolean);
    const syncMessages = (Array.isArray(response?.mailboxes) ? response.mailboxes : [])
      .filter((item) => !task || (
        String(item?.label || "") === this.mailboxLabel(task.id)
        && String(item?.account_id || "") === String(task.privacy_account_id || "")
        && Number(item?.alias_hub_source_account_id) === Number(task.account_id)
      ))
      .filter((item) => item?.alias_hub_synced !== true)
      .map((item) => item?.alias_hub_sync_error || `${item?.email || "隐藏邮箱"} 接入地址仓库失败`);
    const messages = [...failureMessages, ...syncMessages]
      .map((message) => safeError(message, "隐藏邮箱创建失败"));
    return messages.length ? messages : [safeError(fallback, "隐藏邮箱创建失败")];
  }

  finishUnmappedMailboxes(taskId, errors) {
    const remaining = this.items(taskId).filter((item) => (
      !item.address_id && !ITEM_TERMINAL_STATUSES.has(item.status)
    ));
    const messages = Array.isArray(errors) && errors.length ? errors : [String(errors || "隐藏邮箱创建失败")];
    remaining.forEach((item, index) => this.finishItem(
      item.id,
      "failed",
      messages[Math.min(index, messages.length - 1)],
    ));
    const activeMapped = this.items(taskId).filter((item) => (
      item.address_id && !ITEM_TERMINAL_STATUSES.has(item.status)
    ));
    if (activeMapped.length) {
      this.db.prepare(`
        UPDATE ic_registration_pipelines
        SET status = 'running', stage = 'registration_queued', updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `).run(nowIso(), taskId);
      this.recompute(taskId);
    }
  }

  async ensureAutoCreatedMailboxes(taskId) {
    let task = this.taskRow(taskId);
    if (!task || task.mailbox_mode !== "auto_create" || TERMINAL_STATUSES.has(task.status)) return;
    if (!this.icloudPrivacy?.configured?.()) {
      throw failure("iCloud 隐藏邮箱服务尚未配置", 503, "IC_PIPELINE_MAILBOX_SERVICE_UNCONFIGURED");
    }

    let reconciled;
    try {
      reconciled = await this.reconcileCreatedMailboxes(taskId);
    } catch (error) {
      if (task.stage === "mailbox_submitting") throw error;
      reconciled = { mapped: 0, candidates: 0, mailboxes: [] };
    }
    task = this.taskRow(taskId);
    if (!task || task.status === "cancel_requested" || TERMINAL_STATUSES.has(task.status)) return;
    if (reconciled.mapped >= task.requested_count) {
      this.finishUnmappedMailboxes(taskId, "未找到对应的隐藏邮箱创建结果");
      return;
    }
    if (task.stage === "mailbox_submitting" || reconciled.candidates > 0 || reconciled.mapped > 0) {
      this.finishUnmappedMailboxes(taskId, this.mailboxAttemptErrors(
        { mailboxes: reconciled.mailboxes },
        "隐藏邮箱创建结果不完整，为避免重复创建已停止重试",
        task,
      ));
      return;
    }

    const claimed = this.db.prepare(`
      UPDATE ic_registration_pipelines
      SET status = 'running', stage = 'mailbox_submitting', updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running') AND stage = 'mailbox_queued'
    `).run(nowIso(), taskId);
    if (!claimed.changes) return;
    this.db.prepare(`
      UPDATE ic_registration_pipeline_items
      SET status = 'running', stage = 'mailbox_submitting', updated_at = ?
      WHERE pipeline_id = ? AND address_id IS NULL AND status = 'queued'
    `).run(nowIso(), taskId);
    this.recompute(taskId);
    task = this.taskRow(taskId);
    if (!task || task.status === "cancel_requested") return;

    let response = null;
    let createError = null;
    try {
      response = await this.icloudPrivacy.createMailboxes({
        accountId: task.privacy_account_id,
        sourceAccountId: task.account_id,
        count: task.requested_count,
        label: this.mailboxLabel(task.id),
        note: "AliasHub ChatGPT 一键注册流水线",
      });
      this.mapCreatedMailboxes(taskId, response?.mailboxes || []);
    } catch (error) {
      createError = error;
    }

    try {
      await this.reconcileCreatedMailboxes(taskId);
    } catch (error) {
      if (!createError) createError = error;
    }
    task = this.taskRow(taskId);
    if (!task || task.status === "cancel_requested" || TERMINAL_STATUSES.has(task.status)) return;
    const mapped = this.items(taskId).filter((item) => item.address_id && item.email).length;
    const fallback = createError
      ? safeError(createError, "隐藏邮箱创建失败")
      : `仅创建并入库 ${mapped}/${task.requested_count} 个隐藏邮箱`;
    this.finishUnmappedMailboxes(taskId, this.mailboxAttemptErrors(response, fallback, task));
  }

  discoverRegistrationJob(item, task) {
    return this.db.prepare(`
      SELECT id FROM registration_jobs
      WHERE address_id = ? AND lower(email) = lower(?) AND created_at >= ?
      ORDER BY id ASC LIMIT 1
    `).get(item.address_id, item.email, task.created_at);
  }

  persistRegistrationJob(itemId, jobId) {
    this.db.prepare(`
      UPDATE ic_registration_pipeline_items
      SET registration_job_id = ?,
        status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
        stage = CASE WHEN status IN ('queued', 'running') THEN 'registration_wait' ELSE stage END,
        updated_at = ?
      WHERE id = ? AND (registration_job_id IS NULL OR registration_job_id = 0)
    `).run(Number(jobId), nowIso(), itemId);
    const item = this.itemRow(itemId);
    if (item) this.recompute(item.pipeline_id);
  }

  async ensureRegistrationJobs(taskId) {
    let task = this.taskRow(taskId);
    if (!task || TERMINAL_STATUSES.has(task.status)) return;
    let missing = [];
    for (const item of this.items(taskId)) {
      if (item.registration_job_id || ITEM_TERMINAL_STATUSES.has(item.status)) continue;
      if (!item.address_id || !item.email) {
        await this.finishItem(item.id, "failed", "隐藏邮箱地址映射缺失");
        continue;
      }
      const discovered = this.discoverRegistrationJob(item, task);
      if (discovered?.id) this.persistRegistrationJob(item.id, discovered.id);
      else missing.push(item);
    }
    if (!missing.length) return;
    if (missing.length !== this.items(taskId).filter((item) => !ITEM_TERMINAL_STATUSES.has(item.status)).length) {
      await Promise.allSettled(missing.map((item) => this.finishItem(
        item.id,
        "failed",
        "注册任务持久化状态不完整，已停止重复提交",
      )));
      return;
    }
    const claimed = this.db.prepare(`
      UPDATE ic_registration_pipelines
      SET status = 'running', stage = 'registration_submitting', updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
        AND stage IN ('queued', 'registration_queued', 'registration_submitting')
    `).run(nowIso(), taskId);
    if (!claimed.changes) return;
    task = this.taskRow(taskId);
    let jobs = [];
    let submitError = null;
    try {
      jobs = await this.registration.createJobs({
        accountId: task.account_id,
        baseAddressId: missing[0]?.address_id || task.base_address_id,
        addressIds: missing.map((item) => Number(item.address_id)),
        count: missing.length,
        concurrency: task.concurrency,
        browserMode: task.browser_mode,
        proxySelection: task.proxy_selection,
        mailboxMode: "source",
      });
    } catch (error) {
      submitError = error;
    }
    const jobsByEmail = new Map((jobs || []).map((job) => [String(job.email || "").toLowerCase(), job]));
    for (const original of missing) {
      const item = this.itemRow(original.id);
      const job = jobsByEmail.get(String(item.email).toLowerCase()) || this.discoverRegistrationJob(item, task);
      if (job?.id) {
        this.persistRegistrationJob(item.id, job.id);
        if (this.itemWasCancelled(item.id)) await this.cancelKnownChildren(this.itemRow(item.id));
      } else {
        await this.finishItem(item.id, "failed", safeError(submitError, "注册任务提交失败"));
      }
    }
  }

  async runTask(taskId) {
    const initial = this.taskRow(taskId);
    if (initial?.mailbox_mode === "auto_create") await this.ensureAutoCreatedMailboxes(taskId);
    const prepared = this.taskRow(taskId);
    if (!prepared || prepared.status === "cancel_requested" || TERMINAL_STATUSES.has(prepared.status) || this.closed) return;
    await this.ensureRegistrationJobs(taskId);
    const task = this.taskRow(taskId);
    if (!task || TERMINAL_STATUSES.has(task.status) || this.closed) return;
    const itemIds = this.items(taskId).map((item) => item.id);
    let cursor = 0;
    const workerCount = Math.min(Math.max(Number(task.concurrency) || 1, 1), itemIds.length || 1);
    const worker = async () => {
      while (!this.closed) {
        const parent = this.taskRow(taskId);
        if (!parent || parent.status === "cancel_requested" || TERMINAL_STATUSES.has(parent.status)) return;
        const index = cursor;
        cursor += 1;
        if (index >= itemIds.length) return;
        const item = this.itemRow(itemIds[index]);
        if (!item || ITEM_TERMINAL_STATUSES.has(item.status)) continue;
        try {
          await this.runItem(item.id);
        } catch (error) {
          if (this.itemWasCancelled(item.id)) await this.cancelItem(item.id);
          else await this.finishItem(item.id, "failed", safeError(error));
        }
        this.recompute(taskId);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, worker));
    this.recompute(taskId);
  }

  async runItem(itemId) {
    let item = this.itemRow(itemId);
    if (!item || ITEM_TERMINAL_STATUSES.has(item.status)) return;
    if (this.itemWasCancelled(itemId)) return this.cancelItem(itemId);
    if (!item.registration_job_id) throw failure("注册任务映射缺失", 500);
    await this.waitForRegistration(itemId);
    item = this.itemRow(itemId);
    if (!item || ITEM_TERMINAL_STATUSES.has(item.status) || this.closed) return;
    if (this.itemWasCancelled(itemId)) return this.cancelItem(itemId);
    await this.ensurePaymentLink(itemId);
    item = this.itemRow(itemId);
    if (!item || ITEM_TERMINAL_STATUSES.has(item.status) || this.closed) return;
    await this.waitForPaymentLink(itemId);
    item = this.itemRow(itemId);
    if (!item || ITEM_TERMINAL_STATUSES.has(item.status) || this.closed) return;
    if (this.itemWasCancelled(itemId)) return this.cancelItem(itemId);
    await this.ensureAgreement(itemId);
    item = this.itemRow(itemId);
    if (!item || ITEM_TERMINAL_STATUSES.has(item.status) || this.closed) return;
    await this.waitForAgreement(itemId);
  }

  async waitForRegistration(itemId) {
    while (!this.closed) {
      const item = this.itemRow(itemId);
      if (!item || ITEM_TERMINAL_STATUSES.has(item.status)) return;
      if (this.itemWasCancelled(itemId)) return this.cancelItem(itemId);
      const local = this.registration.getJob(item.registration_job_id);
      if (!local) throw failure("注册任务不存在", 502);
      const job = await this.registration.syncJob(local);
      if (job.status === "completed") {
        if (!job.external_account_id) throw failure("注册成功但未找到账号 ID", 502);
        this.db.prepare(`
          UPDATE ic_registration_pipeline_items
          SET external_account_id = ?, status = 'running', stage = 'link_ready', updated_at = ?
          WHERE id = ? AND status IN ('queued', 'running')
        `).run(String(job.external_account_id), nowIso(), itemId);
        this.recompute(item.pipeline_id);
        return;
      }
      if (job.status === "failed") return this.finishItem(itemId, "failed", job.message || "注册失败");
      if (new Set(["cancelled", "interrupted"]).has(job.status)) {
        return this.finishItem(itemId, job.status, job.message || "注册任务已结束");
      }
      await this.wait(itemId);
    }
  }

  recentPaymentLink(item) {
    if (!item.external_account_id) return null;
    const row = this.paymentLinks.row(item.external_account_id);
    if (!row?.task_id || !new Set(["queued", "running", "cancel_requested", "succeeded"]).has(row.status)) return null;
    return String(row.started_at || row.updated_at || "") >= String(item.updated_at || "") ? row : null;
  }

  persistPaymentLinkTask(itemId, taskId) {
    this.db.prepare(`
      UPDATE ic_registration_pipeline_items
      SET payment_link_task_id = ?,
        stage = CASE WHEN status IN ('queued', 'running') THEN 'link_wait' ELSE stage END,
        status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
        updated_at = ? WHERE id = ?
    `).run(String(taskId), nowIso(), itemId);
    const item = this.itemRow(itemId);
    if (item) this.recompute(item.pipeline_id);
  }

  async ensurePaymentLink(itemId) {
    let item = this.itemRow(itemId);
    if (item.payment_link_task_id) return;
    if (item.stage !== "link_ready" && item.stage !== "link_submitting") {
      throw failure("提链阶段状态无效", 500);
    }
    let row = this.recentPaymentLink(item);
    if (!row) {
      this.db.prepare(`
        UPDATE ic_registration_pipeline_items SET stage = 'link_submitting', updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `).run(nowIso(), itemId);
      item = this.itemRow(itemId);
      this.recompute(item.pipeline_id);
      const parent = this.taskRow(item.pipeline_id);
      const started = await this.paymentLinks.start({
        ids: [Number(item.external_account_id)],
        country: parent.payment_link_country,
      });
      row = (started.items || []).find((candidate) => (
        String(candidate.external_account_id) === String(item.external_account_id)
      )) || this.paymentLinks.row(item.external_account_id);
      if (!row?.task_id || row.accepted === false) {
        throw failure(row?.error || "提链任务未启动", 409);
      }
    }
    this.persistPaymentLinkTask(itemId, row.task_id);
    if (this.itemWasCancelled(itemId)) await this.cancelKnownChildren(this.itemRow(itemId));
  }

  async waitForPaymentLink(itemId) {
    let item = this.itemRow(itemId);
    if (!item.payment_link_task_id) throw failure("提链任务映射缺失", 500);
    this.paymentLinks.track(item.external_account_id, item.payment_link_task_id).catch(() => undefined);
    while (!this.closed) {
      item = this.itemRow(itemId);
      if (!item || ITEM_TERMINAL_STATUSES.has(item.status)) return;
      if (this.itemWasCancelled(itemId)) return this.cancelItem(itemId);
      const row = this.paymentLinks.row(item.external_account_id);
      if (!row || row.task_id !== item.payment_link_task_id) throw failure("提链任务映射已变化", 409);
      if (row.status === "succeeded") {
        if (!row.provider_url) throw failure("提链完成但未返回支付链接", 502);
        this.db.prepare(`
          UPDATE ic_registration_pipeline_items SET stage = 'agreement_ready', updated_at = ?
          WHERE id = ? AND status = 'running'
        `).run(nowIso(), itemId);
        this.recompute(item.pipeline_id);
        return;
      }
      if (row.status === "failed") return this.finishItem(itemId, "failed", row.error || "提链失败");
      if (row.status === "cancelled") return this.finishItem(itemId, "cancelled", row.error || "提链已取消");
      await this.wait(itemId);
    }
  }

  persistAgreementJob(itemId, jobId) {
    this.db.prepare(`
      UPDATE ic_registration_pipeline_items
      SET agreement_job_id = ?,
        stage = CASE WHEN status IN ('queued', 'running') THEN 'agreement_wait' ELSE stage END,
        status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
        updated_at = ? WHERE id = ?
    `).run(String(jobId), nowIso(), itemId);
    const item = this.itemRow(itemId);
    if (item) this.recompute(item.pipeline_id);
  }

  async ensureAgreement(itemId) {
    let item = this.itemRow(itemId);
    if (item.agreement_job_id) return;
    if (item.stage === "agreement_submitting") {
      throw failure("协议支付上下文在重启后已丢失，未重复扣费", 409, "IC_PIPELINE_AGREEMENT_CONTEXT_LOST");
    }
    if (item.stage !== "agreement_ready") throw failure("协议支付阶段状态无效", 500);
    this.db.prepare(`
      UPDATE ic_registration_pipeline_items SET stage = 'agreement_submitting', updated_at = ?
      WHERE id = ? AND status = 'running' AND stage = 'agreement_ready'
    `).run(nowIso(), itemId);
    item = this.itemRow(itemId);
    this.recompute(item.pipeline_id);
    const link = this.paymentLinks.row(item.external_account_id);
    if (!link || link.status !== "succeeded" || !link.provider_url) throw failure("有效支付链接不存在", 409);
    const response = await this.paymentAgreements.start({
      paypal_url: link.provider_url,
      use_saved_protocol_config: true,
    });
    const job = agreementJob(response);
    const jobId = String(job?.id || "");
    if (!jobId) throw failure("协议支付服务未返回任务 ID", 502);
    this.persistAgreementJob(itemId, jobId);
    if (this.itemWasCancelled(itemId)) await this.cancelKnownChildren(this.itemRow(itemId));
  }

  async waitForAgreement(itemId) {
    let item = this.itemRow(itemId);
    const context = this.paymentAgreements.context?.(item.agreement_job_id);
    if (!context) {
      throw failure("协议支付上下文在重启后已丢失，未重复提交", 409, "IC_PIPELINE_AGREEMENT_CONTEXT_LOST");
    }
    while (!this.closed) {
      item = this.itemRow(itemId);
      if (!item || ITEM_TERMINAL_STATUSES.has(item.status)) return;
      if (this.itemWasCancelled(itemId)) return this.cancelItem(itemId);
      const snapshot = context.lastSnapshot || {};
      const status = agreementStatus(snapshot);
      if (status === "completed") {
        const result = this.finishItem(itemId, "completed", "");
        await this.paymentAgreements.releaseContext?.(item.agreement_job_id, {
          force: true,
          successful: true,
        }).catch(() => undefined);
        return result;
      }
      if (status === "failed" || status === "cancelled") {
        const result = this.finishItem(
          itemId,
          status === "cancelled" ? "cancelled" : "failed",
          snapshot.error || context.lastError || (status === "cancelled" ? "协议支付已取消" : "协议支付失败"),
        );
        await this.paymentAgreements.releaseContext?.(item.agreement_job_id, {
          force: true,
          successful: false,
        }).catch(() => undefined);
        return result;
      }
      if (context.stopped && !context.terminal) {
        const result = this.finishItem(itemId, "failed", context.lastError || "协议支付后台跟踪已停止");
        await this.paymentAgreements.releaseContext?.(item.agreement_job_id, {
          force: true,
          successful: false,
        }).catch(() => undefined);
        return result;
      }
      const agreementTrackers = this.paymentAgreements.trackers;
      if (!context.terminal && !context.stopped
        && agreementTrackers && typeof agreementTrackers.has === "function"
        && !agreementTrackers.has(String(item.agreement_job_id))) {
        const result = this.finishItem(itemId, "failed", context.lastError || "协议支付后台跟踪异常结束");
        await this.paymentAgreements.releaseContext?.(item.agreement_job_id, {
          force: true,
          successful: false,
        }).catch(() => undefined);
        return result;
      }
      await this.wait(itemId);
    }
  }

  itemWasCancelled(itemId) {
    const item = this.itemRow(itemId);
    const parent = item ? this.taskRow(item.pipeline_id) : null;
    return !item || !parent
      || item.status === "cancel_requested" || ITEM_TERMINAL_STATUSES.has(item.status)
      || parent.status === "cancel_requested" || TERMINAL_STATUSES.has(parent.status);
  }

  async cancelKnownChildren(item) {
    if (!item) return;
    if (item.registration_job_id) {
      await this.registration.cancelJob(item.registration_job_id).catch(() => undefined);
    }
    if (item.payment_link_task_id) {
      this.paymentLinks.persistTracked?.(item.external_account_id, item.payment_link_task_id, {
        status: "cancel_requested",
        stage: "cancel_requested",
        error: "任务已取消",
      });
      try {
        const snapshot = await this.paymentLinks.request(
          `/api/tasks/${encodeURIComponent(item.payment_link_task_id)}/cancel`,
          { method: "POST" },
        );
        this.paymentLinks.applySnapshot?.(item.external_account_id, snapshot);
      } catch {
        // The persisted cancel request remains visible and will be reconciled by PaymentLinkService.
      }
    }
    if (item.agreement_job_id && this.paymentAgreements.context?.(item.agreement_job_id)) {
      try {
        await this.paymentAgreements.cancelJob(item.agreement_job_id);
        await this.paymentAgreements.releaseContext?.(item.agreement_job_id, {
          force: true,
          successful: false,
        }).catch(() => undefined);
      } catch { /* Retain the context while its tracker retries remote cancellation. */ }
    }
  }

  async cancelItem(itemId) {
    const key = Number(itemId);
    if (this.cancellations.has(key)) return this.cancellations.get(key);
    const cancellation = (async () => {
      const item = this.itemRow(key);
      if (!item || ITEM_TERMINAL_STATUSES.has(item.status)) return item;
      await this.cancelKnownChildren(item);
      return this.finishItem(key, "cancelled", "任务已取消");
    })().finally(() => this.cancellations.delete(key));
    this.cancellations.set(key, cancellation);
    return cancellation;
  }

  async cancel(id, { skipRecovery = false } = {}) {
    if (!skipRecovery) await this.recoveryPromise;
    const task = this.taskRow(id);
    if (!task) throw failure("iCloud 流水线不存在", 404);
    if (TERMINAL_STATUSES.has(task.status)) return this.publicTask(task);
    const at = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE ic_registration_pipelines
        SET status = 'cancel_requested', stage = 'cancel_requested', updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running', 'cancel_requested')
      `).run(at, task.id);
      this.db.prepare(`
        UPDATE ic_registration_pipeline_items SET status = 'cancel_requested', updated_at = ?
        WHERE pipeline_id = ? AND status IN ('queued', 'running', 'cancel_requested')
      `).run(at, task.id);
    })();
    const items = this.items(task.id).filter((item) => item.status === "cancel_requested");
    items.forEach((item) => this.wake(item.id));
    await Promise.allSettled(items.map((item) => this.cancelItem(item.id)));
    this.recompute(task.id);
    return this.publicTask(task.id);
  }

  finishItem(itemId, status, error = "") {
    const current = this.itemRow(itemId);
    let normalized = ITEM_TERMINAL_STATUSES.has(status) ? status : "failed";
    if (current?.status === "cancel_requested" && normalized !== "completed") normalized = "cancelled";
    const failureStage = ITEM_FAILURE_STATUSES.has(normalized)
      ? String(current?.failure_stage || current?.stage || "")
      : String(current?.failure_stage || "");
    const at = nowIso();
    this.db.prepare(`
      UPDATE ic_registration_pipeline_items
      SET status = ?, stage = ?, failure_stage = ?, error = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
    `).run(normalized, normalized, failureStage, normalized === "completed" ? "" : safeError(error), at, at, itemId);
    const item = this.itemRow(itemId);
    if (item) this.recompute(item.pipeline_id);
    this.wake(itemId);
    return item;
  }

  recompute(taskId) {
    const task = this.taskRow(taskId);
    if (!task) return;
    const items = this.items(taskId);
    const completed = items.filter((item) => item.status === "completed").length;
    const failed = items.filter((item) => new Set(["failed", "interrupted"]).has(item.status)).length;
    const cancelled = items.filter((item) => item.status === "cancelled").length;
    const terminal = completed + failed + cancelled;
    let status = task.status === "cancel_requested" ? "cancel_requested" : "running";
    let stage = task.stage;
    let finishedAt = null;
    let error = task.error || "";
    if (terminal === items.length) {
      finishedAt = task.finished_at || nowIso();
      if (completed === items.length) {
        status = "completed";
        stage = "completed";
        error = "";
      } else if (task.status === "cancel_requested" && failed === 0) {
        status = "cancelled";
        stage = "cancelled";
        error = "任务已取消";
      } else if (completed > 0) {
        status = "partial_failed";
        stage = "partial_failed";
        error = "部分账号未完成流水线";
      } else if (failed > 0) {
        status = "failed";
        stage = "failed";
        error = "流水线执行失败";
      } else {
        status = "cancelled";
        stage = "cancelled";
        error = "任务已取消";
      }
    } else if (task.status === "cancel_requested") {
      stage = "cancel_requested";
    } else {
      const stageRank = (value) => {
        const source = String(value || "");
        if (source.startsWith("agreement_")) return 3;
        if (source.startsWith("link_")) return 2;
        if (source.startsWith("registration_")) return 1;
        return 0;
      };
      const activeStages = items
        .filter((item) => !ITEM_TERMINAL_STATUSES.has(item.status))
        .map((item) => item.stage)
        .sort((left, right) => stageRank(right) - stageRank(left));
      stage = activeStages[0] || stage;
    }
    this.db.prepare(`
      UPDATE ic_registration_pipelines
      SET status = ?, stage = ?, progress_current = ?, success_count = ?, failure_count = ?,
        cancelled_count = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?
    `).run(status, stage, terminal, completed, failed, cancelled, error, finishedAt, nowIso(), taskId);
  }

  async wait(itemId) {
    let wake;
    const interrupted = new Promise((resolve) => { wake = resolve; });
    this.wakes.set(Number(itemId), wake);
    try {
      await Promise.race([this.sleepFn(this.pollIntervalMs), interrupted]);
    } finally {
      if (this.wakes.get(Number(itemId)) === wake) this.wakes.delete(Number(itemId));
    }
  }

  wake(itemId) {
    this.wakes.get(Number(itemId))?.();
    this.wakes.delete(Number(itemId));
  }

  async recoverActivePipelines() {
    const tasks = this.db.prepare(`
      SELECT id, status FROM ic_registration_pipelines
      WHERE status IN ('queued', 'running', 'cancel_requested')
      ORDER BY created_at
    `).all();
    for (const task of tasks) {
      const agreementItems = this.items(task.id).filter((item) => (
        !ITEM_TERMINAL_STATUSES.has(item.status)
        && new Set(["agreement_submitting", "agreement_wait"]).has(item.stage)
        && (!item.agreement_job_id || !this.paymentAgreements.context?.(item.agreement_job_id))
      ));
      agreementItems.forEach((item) => this.finishItem(
        item.id,
        "failed",
        "协议支付上下文在重启后已丢失，未重复提交",
      ));
      if (task.status === "cancel_requested") {
        this.cancel(task.id, { skipRecovery: true }).catch(() => undefined);
      } else if (!TERMINAL_STATUSES.has(this.taskRow(task.id)?.status)) {
        this.startTracker(task.id);
      }
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.wakes.forEach((wake) => wake());
    this.wakes.clear();
    await Promise.allSettled([...this.trackers.values()]);
  }
}
