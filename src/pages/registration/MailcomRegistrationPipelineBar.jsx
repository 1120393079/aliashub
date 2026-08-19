import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  AtSign,
  Cable,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleStop,
  Clock3,
  Link2,
  LoaderCircle,
  MailPlus,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserCheck,
} from "lucide-react";
import { api } from "../../api.js";
import { Button, EmptyState, FormField, Modal, StatusBadge, useToast } from "../../components.jsx";
import { formatDate } from "../../utils.js";
import { proxySelectLabel } from "./proxy-model.js";

const activeStatuses = new Set(["queued", "running", "cancel_requested", "stopping"]);
const terminalStatuses = new Set(["completed", "partial_failed", "failed", "cancelled", "stopped", "interrupted"]);
const successfulAccountsPageSize = 12;

const statusLabels = {
  queued: "等待启动",
  running: "持续运行中",
  cancel_requested: "正在停止",
  stopping: "正在停止",
  completed: "已结束",
  partial_failed: "部分失败",
  failed: "执行失败",
  cancelled: "已停止",
  stopped: "已停止",
  interrupted: "已中断",
};

const stageLabels = {
  queued: "等待调度",
  preparation_queued: "等待汇总 mail.com 地址",
  preparing_accounts: "汇总并补建官方别名",
  processing_parallel: "注册、提链、协议与轮换并行处理中",
  prepare_queued: "等待准备母号",
  prepare_running: "同步母号与官方别名",
  prepare_failed: "母号别名准备失败",
  processing: "处理全部地址槽",
  scanning: "汇总 mail.com 地址",
  selecting_alias: "选择下一个官方别名",
  alias_selected: "官方别名已分配",
  registration_queued: "提交注册队列",
  registration_submitting: "提交注册任务",
  registration_wait: "等待注册结果",
  registration_runtime_retry_wait: "注册依赖恢复后重试",
  registration_retry_wait: "等待重试注册",
  registering: "注册账号",
  registered: "注册完成",
  link_queued: "等待提链",
  link_submitting: "提交提链任务",
  link_wait: "等待提链结果",
  link_retry_wait: "等待重试提链",
  link_runtime_retry_wait: "提链依赖恢复后重试",
  extracting_link: "提取 PayPal 链接",
  extracting_links: "提取 PayPal 链接",
  linked: "提链完成",
  agreement_ready: "准备自动协议授权",
  agreement_queued: "等待自动协议授权",
  agreement_submitting: "提交自动协议授权",
  agreement_wait: "等待协议授权结果",
  agreement_running: "自动协议授权中",
  agreement_runtime_retry_wait: "协议授权依赖恢复后重试",
  agreement_succeeded: "自动协议授权完成",
  agreement_preserved: "协议成功账号已保留",
  agreement_failed: "自动协议授权失败",
  deleting_alias: "删除已结束的别名",
  recycling: "轮换官方别名",
  recycle_retry_wait: "等待重试轮换别名",
  recycle_failed: "官方别名轮换失败",
  recycle_account_blocked: "正在自动恢复母号网页授权",
  account_action_required: "母号网页授权自动恢复中",
  account_action_required_remote_uncertain: "自动恢复授权并确认远端轮换",
  recycle_cancelled: "官方别名轮换已取消",
  recycled: "官方别名已轮换",
  creating_alias: "补建官方别名",
  succeeded: "注册、提链与协议授权完成",
  unavailable: "地址已被占用",
  registration_failed: "注册失败",
  link_failed: "提链失败",
  cancel_requested: "停止新任务并收尾",
  stopping: "停止新任务并收尾",
  completed: "流水线已结束",
  partial_failed: "流水线部分失败",
  failed: "流水线失败",
  cancelled: "流水线已停止",
  stopped: "流水线已停止",
  interrupted: "流水线已中断",
};

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalCount(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === "object" && Number.isFinite(Number(value.count))) {
      return Math.max(0, Number(value.count));
    }
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return null;
}

function enabledFlag(value) {
  if (value === true || value === 1) return true;
  return typeof value === "string" && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function inventoryCounts(summary) {
  const root = objectValue(summary);
  const inventory = objectValue(root.inventory);
  const connected = objectValue(root.connected);
  const counts = objectValue(root.counts);
  const accountCount = optionalCount(
    root.connected_account_count,
    root.connectedAccountCount,
    root.account_count,
    inventory.connected_account_count,
    inventory.account_count,
    connected.account_count,
    connected.accounts,
    counts.accounts,
    root.accounts,
  ) ?? 0;
  const aliasCount = optionalCount(
    root.active_alias_count,
    root.connected_alias_count,
    root.connectedAliasCount,
    root.alias_count,
    inventory.active_alias_count,
    inventory.alias_count,
    connected.alias_count,
    connected.aliases,
    counts.aliases,
    root.aliases,
  ) ?? 0;
  const explicitAddressCount = optionalCount(
    root.connected_address_count,
    root.connectedAddressCount,
    root.address_count,
    inventory.connected_address_count,
    inventory.address_count,
    connected.address_count,
    connected.addresses,
    counts.addresses,
    root.addresses,
  );
  return {
    accountCount,
    aliasCount,
    addressCount: explicitAddressCount ?? (accountCount + aliasCount),
  };
}

function recoveryItems(summary) {
  const root = objectValue(summary);
  const dependency = objectValue(root.dependency);
  const source = root.recovering_recycles
    ?? root.recoveringRecycles
    ?? root.recovery_items
    ?? root.recoveryItems
    ?? dependency.recovering_recycles
    ?? dependency.recoveringRecycles
    ?? [];
  if (!Array.isArray(source)) return [];
  return source.map((value) => {
    const item = objectValue(value);
    const accountId = Number(item.account_id ?? item.accountId);
    return {
      accountId: Number.isSafeInteger(accountId) && accountId > 0 ? accountId : null,
      sourceEmail: String(item.source_email ?? item.sourceEmail ?? "").trim(),
      aliasEmail: String(item.alias_email ?? item.aliasEmail ?? item.email ?? "").trim(),
      error: String(item.error ?? item.recycle_error ?? item.recycleError ?? "").trim(),
      nextRetryAt: item.next_retry_at ?? item.nextRetryAt ?? null,
    };
  }).filter((item) => item.sourceEmail || item.aliasEmail || item.error);
}

function automaticAuthorizationMessage(value, fallback = "后台正在使用已保存密码自动恢复 Mail.com 网页授权") {
  const message = String(value || fallback).trim();
  return message
    .replace(/请更新密码或先在官网完成人机验证/g, "后台将使用已保存密码自动重试")
    .replace(/请先在官网完成(?:人机或身份)?验证/g, "后台将使用已保存密码自动重试")
    .replace(/请重新连接母号后再试/g, "后台将使用已保存密码自动重试")
    .replace(/需要重新连接(?:后才能继续)?/g, "正在自动恢复网页授权")
    .replace(/重新连接母号/g, "自动恢复网页授权");
}

function normalizeDomain(item) {
  const source = objectValue(item);
  const raw = typeof item === "string"
    ? item
    : source.domain ?? source.suffix ?? source.value ?? source.name ?? "";
  const value = String(raw).trim().replace(/^@+/, "").toLowerCase();
  if (!value) return null;
  return {
    value,
    label: String(source.label || value).trim(),
    ready: source.ready !== false && source.enabled !== false && source.available !== false,
  };
}

function summaryDomains(summary) {
  const root = objectValue(summary);
  const inventory = objectValue(root.inventory);
  const source = root.mailcom_domains
    ?? root.domains
    ?? root.domain_suffixes
    ?? root.available_domains
    ?? inventory.mailcom_domains
    ?? inventory.domains
    ?? [];
  const values = Array.isArray(source)
    ? source
    : Object.entries(objectValue(source)).map(([domain, detail]) => (
      detail && typeof detail === "object" ? { domain, ...detail } : domain
    ));
  const result = new Map();
  for (const item of values) {
    const domain = normalizeDomain(item);
    if (domain && !result.has(domain.value)) result.set(domain.value, domain);
  }
  return [...result.values()];
}

function isPipeline(value) {
  return Boolean(value && typeof value === "object" && value.id !== undefined && (
    value.status !== undefined
    || value.stage !== undefined
    || value.terminal !== undefined
    || value.attempt_count !== undefined
  ));
}

function pipelineCandidates(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload.filter(isPipeline);
  if (isPipeline(payload)) return [payload];
  if (typeof payload !== "object") return [];
  const result = [];
  for (const key of ["active", "latest", "pipeline", "item"]) {
    if (isPipeline(payload[key])) result.push(payload[key]);
  }
  if (Array.isArray(payload.items)) result.push(...payload.items.filter(isPipeline));
  if (payload.data && payload.data !== payload) result.push(...pipelineCandidates(payload.data));
  return result;
}

function isPipelineActive(pipeline) {
  if (!pipeline) return false;
  if (pipeline.terminal === true) return false;
  if (pipeline.terminal === false) return true;
  return activeStatuses.has(String(pipeline.status || "").toLowerCase());
}

function isPipelineTerminal(pipeline) {
  if (!pipeline) return false;
  if (pipeline.terminal === true) return true;
  return terminalStatuses.has(String(pipeline.status || "").toLowerCase());
}

function selectPipeline(...payloads) {
  const candidates = payloads.flatMap(pipelineCandidates);
  return candidates.find(isPipelineActive) || candidates[0] || null;
}

function pipelineStatusBadge(status) {
  if (status === "completed") return "completed";
  if (status === "partial_failed") return "warning";
  if (status === "failed" || status === "interrupted") return "failed";
  if (status === "cancelled" || status === "stopped") return "cancelled";
  if (status === "cancel_requested" || status === "stopping") return "warning";
  return activeStatuses.has(status) ? status : "inactive";
}

function stageLabel(value) {
  const stage = String(value || "").trim().toLowerCase();
  if (!stage) return "准备无限流水线";
  if (stageLabels[stage]) return stageLabels[stage];
  if (stage.includes("recycl") || stage.includes("delet")) return "删除并轮换官方别名";
  if (stage.includes("alias") && (stage.includes("creat") || stage.includes("new"))) return "补建官方别名";
  if (stage.includes("alias") || stage.includes("address")) return "分配官方别名";
  if (stage.includes("agreement") || stage.includes("protocol") || stage.includes("authoriz")) return "自动协议授权";
  if (stage.includes("register")) return "注册账号";
  if (stage.includes("link") || stage.includes("extract")) return "提取 PayPal 链接";
  return stage;
}

function agreementPresentation(item) {
  const stage = String(item?.stage || "").trim().toLowerCase();
  const inferred = stage.startsWith("agreement_") ? stage.slice("agreement_".length) : "";
  const status = String(item?.agreement_status || inferred).trim().toLowerCase();
  if (status === "completed" || status === "succeeded") {
    return { badge: "completed", label: "授权成功" };
  }
  if (status === "failed" || status === "interrupted") {
    return { badge: "failed", label: "授权失败" };
  }
  if (status === "cancelled" || status === "canceled") {
    return { badge: "cancelled", label: "授权已取消" };
  }
  if (status === "uncertain") {
    return { badge: "warning", label: "结果待确认" };
  }
  if (status === "skipped") {
    return { badge: "inactive", label: "历史未自动授权" };
  }
  if (["queued", "ready", "pending"].includes(status)) {
    return { badge: "queued", label: "等待授权" };
  }
  if (status || item?.agreement_job_id || String(item?.stage || "").includes("agreement")) {
    return { badge: "running", label: "授权中" };
  }
  return { badge: "inactive", label: "未记录" };
}

function successfulAccountKey(item, index = 0) {
  return String(item?.id || `${item?.external_account_id || item?.email || "account"}-${item?.cycle || index}`);
}

function successfulAccountTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "-";
  return formatDate(value);
}

function makeRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `mailcom-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function statNumber(pipeline, ...keys) {
  return optionalCount(...keys.map((key) => pipeline?.[key])) ?? 0;
}

export default function MailcomRegistrationPipelineBar({
  options,
  paymentLinks,
  paymentAgreementRuntime,
  paymentAgreementSettings,
  queueControl,
  paymentLinkCountry,
  onPaymentLinkCountryChange,
  onRefresh,
  onNavigate,
}) {
  const [form, setForm] = useState({
    domain: "random",
    concurrency: 1,
    linkAttempts: 3,
    browserMode: "headed",
    proxySelection: "auto",
  });
  const [country, setCountry] = useState(paymentLinkCountry || paymentLinks?.country || "DE");
  const [summary, setSummary] = useState(null);
  const [pipeline, setPipeline] = useState(null);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [loadingState, setLoadingState] = useState(true);
  const [summaryLoadError, setSummaryLoadError] = useState("");
  const [pipelineLoadError, setPipelineLoadError] = useState("");
  const [recoveryProbeActive, setRecoveryProbeActive] = useState(false);
  const [actionError, setActionError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [successfulAccountsOpen, setSuccessfulAccountsOpen] = useState(false);
  const [successfulAccounts, setSuccessfulAccounts] = useState({
    total: 0,
    limit: successfulAccountsPageSize,
    offset: 0,
    nextCursor: "",
    hasMore: false,
    items: [],
  });
  const [successfulAccountsLoading, setSuccessfulAccountsLoading] = useState(false);
  const [successfulAccountsLoadingMore, setSuccessfulAccountsLoadingMore] = useState(false);
  const [successfulAccountsRefreshing, setSuccessfulAccountsRefreshing] = useState(false);
  const [successfulAccountsError, setSuccessfulAccountsError] = useState("");
  const requestSequence = useRef(0);
  const successfulAccountsSequence = useRef(0);
  const successfulAccountsBusy = useRef("");
  const successfulAccountsRef = useRef(successfulAccounts);
  const successfulAccountsFullRefreshAt = useRef(0);
  const startBusy = useRef(false);
  const cancelBusy = useRef(false);
  const pendingStartRequest = useRef({ key: "", id: "" });
  const terminalNotification = useRef("");
  const dependencyRefreshReady = useRef(false);
  const toast = useToast();

  useEffect(() => {
    successfulAccountsRef.current = successfulAccounts;
  }, [successfulAccounts]);

  const pipelineActive = isPipelineActive(pipeline);
  const status = String(pipeline?.status || "").toLowerCase();
  const statusClass = status.replace(/[^a-z0-9_-]/g, "-");
  const loadError = summaryLoadError || pipelineLoadError;
  const counts = useMemo(() => inventoryCounts(summary), [summary]);
  const dependency = objectValue(summary?.dependency);
  const recoveringRecycles = useMemo(() => recoveryItems(summary), [summary]);
  const recoveryFlag = summary?.recovery_active ?? summary?.recoveryActive
    ?? dependency.recovery_active ?? dependency.recoveryActive;
  const recoveringRecycleCountValue = optionalCount(
    summary?.recovering_recycle_count,
    summary?.recoveringRecycleCount,
    dependency.recovering_recycle_count,
    dependency.recoveringRecycleCount,
    recoveringRecycles,
  );
  const recoveryError = String(
    summary?.recovery_error ?? summary?.recoveryError
      ?? dependency.recovery_error ?? dependency.recoveryError
      ?? recoveringRecycles[0]?.error ?? "",
  ).trim();
  const recoveryFieldsPresent = recoveryFlag !== undefined
    || recoveringRecycleCountValue !== null
    || Boolean(recoveryError)
    || recoveringRecycles.length > 0;
  const recoveryActive = recoveryProbeActive
    || enabledFlag(recoveryFlag)
    || Number(recoveringRecycleCountValue || 0) > 0
    || Boolean(recoveryError);
  const recoveringRecycleCount = recoveryActive
    ? Math.max(1, Number(recoveringRecycleCountValue || 0))
    : 0;
  const primaryRecovery = recoveringRecycles[0] || null;
  const recoveryTargets = recoveringRecycles.slice(0, 3).map((item) => {
    const source = item.sourceEmail || "未知母号";
    const alias = item.aliasEmail ? `，待轮换别名 ${item.aliasEmail}` : "";
    return `母号 ${source}${item.accountId ? "" : "（已从系统删除）"}${alias}`;
  });
  const recoveryTargetSuffix = recoveringRecycleCount > recoveryTargets.length
    ? `；另有 ${recoveringRecycleCount - recoveryTargets.length} 个`
    : "";
  const visibleRecoveryError = automaticAuthorizationMessage(
    primaryRecovery?.error || recoveryError,
    "",
  ).slice(0, 180);
  const recoveryBlocker = recoveryActive
    ? recoveryTargets.length
      ? `安全收尾 ${recoveringRecycleCount}：${recoveryTargets.join("；")}${recoveryTargetSuffix}${visibleRecoveryError ? `。自动授权恢复状态：${visibleRecoveryError}` : "。后台会使用已保存密码自动恢复网页授权"}`
      : `有 ${recoveringRecycleCount} 个停止后的别名轮换正在安全收尾；后台会使用已保存密码自动恢复网页授权并确认结果`
    : "";

  const domainOptions = useMemo(() => {
    const result = summaryDomains(summary);
    const submitted = normalizeDomain(pipeline?.domain);
    if (submitted && submitted.value !== "random" && !result.some((item) => item.value === submitted.value)) result.push(submitted);
    return result;
  }, [summary, pipeline?.domain]);
  const domainSignature = domainOptions.map((item) => `${item.value}:${item.ready}`).join("|");
  const randomDomainReady = domainOptions.some((item) => item.ready);

  const countryOptions = useMemo(() => {
    const result = new Map();
    for (const item of paymentLinks?.countries || []) {
      const code = String(item?.code || "").trim().toUpperCase();
      if (code) result.set(code, { code, currency: String(item?.currency || "") });
    }
    const submittedCountry = pipeline?.payment_link_country || pipeline?.paymentLinkCountry;
    const current = String(submittedCountry || country || paymentLinkCountry || paymentLinks?.country || "DE").trim().toUpperCase();
    if (current && !result.has(current)) result.set(current, { code: current, currency: "" });
    return [...result.values()];
  }, [country, paymentLinkCountry, paymentLinks?.countries, paymentLinks?.country, pipeline?.payment_link_country, pipeline?.paymentLinkCountry]);
  const liveDependencySignature = [
    queueControl?.paused,
    options?.service?.ok,
    options?.proxies?.length,
    paymentLinks?.configured,
    paymentLinks?.checkout_proxy_count,
    paymentLinks?.update_proxy_count,
    paymentLinks?.apply_checkout_update,
    paymentLinks?.error,
    paymentAgreementRuntime?.configured,
    paymentAgreementRuntime?.country,
    paymentAgreementRuntime?.proxy_count,
    paymentAgreementRuntime?.error,
    paymentAgreementSettings?.protocol_configured,
    paymentAgreementSettings?.configured,
    paymentAgreementSettings?.api_key_configured,
    paymentAgreementSettings?.error,
  ].map((value) => String(value ?? "")).join("|");

  const loadState = useCallback(async ({ quiet = false } = {}) => {
    const sequence = ++requestSequence.current;
    if (!quiet) setLoadingState(true);
    const [statusResult, pipelinesResult] = await Promise.allSettled([
      api("/api/registration/mailcom-pipelines/status"),
      api("/api/registration/mailcom-pipelines"),
    ]);
    if (sequence !== requestSequence.current) return null;

    const nextSummary = statusResult.status === "fulfilled" ? statusResult.value : null;
    const nextPipelines = pipelinesResult.status === "fulfilled" ? pipelinesResult.value : null;
    if (nextSummary) {
      setSummary(nextSummary);
      setRecoveryProbeActive(false);
    }
    setSummaryLoadError(statusResult.status === "rejected"
      ? (statusResult.reason?.message || "mail.com 汇总状态读取失败")
      : "");
    setPipelineLoadError(pipelinesResult.status === "rejected"
      ? (pipelinesResult.reason?.message || "mail.com 流水线状态读取失败")
      : "");

    const nextPipeline = selectPipeline(nextSummary, nextPipelines);
    if (nextPipeline || (statusResult.status === "fulfilled" && pipelinesResult.status === "fulfilled")) {
      setPipeline(nextPipeline);
    }
    setStateLoaded(true);
    setLoadingState(false);
    return nextPipeline;
  }, []);

  const loadSuccessfulAccounts = useCallback(async ({ append = false, quiet = false, full = false } = {}) => {
    const pipelineId = String(pipeline?.id || "");
    if (!pipelineId) return null;
    if (successfulAccountsBusy.current === pipelineId) return { busy: true };
    const current = successfulAccountsRef.current;
    const cursor = append ? String(current.nextCursor || "") : "";
    if (append && !cursor) return null;
    const quietTarget = full
      ? Math.max(successfulAccountsPageSize, current.items.length)
      : Math.min(100, Math.max(successfulAccountsPageSize, current.items.length));
    const limit = quiet ? Math.min(100, quietTarget) : successfulAccountsPageSize;
    const sequence = ++successfulAccountsSequence.current;
    successfulAccountsBusy.current = pipelineId;
    if (quiet) setSuccessfulAccountsRefreshing(true);
    else if (append) setSuccessfulAccountsLoadingMore(true);
    else setSuccessfulAccountsLoading(true);
    try {
      let result;
      let incoming = [];
      let preserveTailCursor = false;
      let quietFallbackCursor = "";
      if (quiet) {
        let pageCursor = "";
        const loadedHeadKey = current.items.length ? successfulAccountKey(current.items[0]) : "";
        let bridgedLoadedHead = !loadedHeadKey;
        const loadedKeys = new Set(current.items.map((item, index) => successfulAccountKey(item, index)));
        const novelKeys = new Set();
        let totalGap = 0;
        const unseenLoaded = new Set(full ? current.items.map((item, index) => successfulAccountKey(item, index)) : []);
        do {
          const pageLimit = full || incoming.length >= quietTarget
            ? 100
            : Math.min(100, Math.max(1, quietTarget - incoming.length));
          const page = await api(
            `/api/registration/mailcom-pipelines/${encodeURIComponent(pipelineId)}/successful-accounts?limit=${pageLimit}${pageCursor ? `&before_id=${encodeURIComponent(pageCursor)}` : ""}`,
          );
          const pageItems = Array.isArray(page?.items) ? page.items : [];
          if (!incoming.length) quietFallbackCursor = String(page?.next_cursor || "");
          incoming.push(...pageItems);
          pageItems.forEach((item, index) => {
            const key = successfulAccountKey(item, index);
            if (key === loadedHeadKey) bridgedLoadedHead = true;
            if (!loadedKeys.has(key)) novelKeys.add(key);
            unseenLoaded.delete(key);
          });
          result = page;
          totalGap = Math.max(0, (Number(page?.total) || 0) - Number(current.total || 0));
          pageCursor = String(page?.next_cursor || "");
          if (page?.has_more !== true || !pageCursor || !pageItems.length) break;
        } while (full
          ? unseenLoaded.size > 0 || novelKeys.size < totalGap
          : incoming.length < quietTarget || !bridgedLoadedHead || novelKeys.size < totalGap);
        preserveTailCursor = Boolean(
          current.items.length && bridgedLoadedHead && novelKeys.size >= totalGap,
        );
        result = { ...(result || {}), items: incoming };
      } else {
        result = await api(
          `/api/registration/mailcom-pipelines/${encodeURIComponent(pipelineId)}/successful-accounts?limit=${limit}${cursor ? `&before_id=${encodeURIComponent(cursor)}` : ""}`,
        );
        incoming = Array.isArray(result?.items) ? result.items : [];
      }
      if (sequence !== successfulAccountsSequence.current) return null;
      const total = Math.max(0, Number(result?.total) || 0);
      setSuccessfulAccounts((previous) => {
        if (!append && !quiet) {
          return {
            total,
            limit: Math.max(1, Number(result?.limit) || limit),
            offset: 0,
            nextCursor: String(result?.next_cursor || ""),
            hasMore: result?.has_more === true,
            items: incoming,
          };
        }
        const merged = [];
        const seen = new Set();
        for (const [index, item] of [...(quiet ? incoming : previous.items), ...(quiet ? previous.items : incoming)].entries()) {
          const key = successfulAccountKey(item, index);
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(item);
        }
        merged.sort((left, right) => Number(right?.id || 0) - Number(left?.id || 0));
        return {
          total,
          limit: merged.length,
          offset: 0,
          nextCursor: append
            ? String(result?.next_cursor || "")
            : String(
              preserveTailCursor && (previous.nextCursor || merged.length >= total)
                ? previous.nextCursor || ""
                : (merged.length < total ? quietFallbackCursor || result?.next_cursor || "" : ""),
            ),
          hasMore: append ? result?.has_more === true : merged.length < total,
          items: merged,
        };
      });
      setSuccessfulAccountsError("");
      return result;
    } catch (error) {
      if (sequence === successfulAccountsSequence.current) {
        setSuccessfulAccountsError(error.message || "提链成功账号读取失败");
      }
      return null;
    } finally {
      if (sequence === successfulAccountsSequence.current) {
        setSuccessfulAccountsLoading(false);
        setSuccessfulAccountsLoadingMore(false);
        setSuccessfulAccountsRefreshing(false);
      }
      if (successfulAccountsBusy.current === pipelineId) successfulAccountsBusy.current = "";
    }
  }, [pipeline?.id]);

  useEffect(() => {
    loadState();
    return () => {
      requestSequence.current += 1;
      successfulAccountsSequence.current += 1;
    };
  }, [loadState]);

  useEffect(() => {
    successfulAccountsSequence.current += 1;
    successfulAccountsFullRefreshAt.current = 0;
    setSuccessfulAccountsOpen(false);
    setSuccessfulAccounts({
      total: 0,
      limit: successfulAccountsPageSize,
      offset: 0,
      nextCursor: "",
      hasMore: false,
      items: [],
    });
    setSuccessfulAccountsError("");
    setSuccessfulAccountsLoading(false);
    setSuccessfulAccountsLoadingMore(false);
    setSuccessfulAccountsRefreshing(false);
  }, [pipeline?.id]);

  useEffect(() => {
    if (!successfulAccountsOpen || !pipelineActive || !pipeline?.id) return undefined;
    let stopped = false;
    let timer = window.setTimeout(async function poll() {
      const full = Date.now() - successfulAccountsFullRefreshAt.current >= 30_000;
      const result = await loadSuccessfulAccounts({ quiet: true, full });
      if (full && result && !result.busy) successfulAccountsFullRefreshAt.current = Date.now();
      if (!stopped) timer = window.setTimeout(poll, 2_000);
    }, 2_000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [successfulAccountsOpen, pipelineActive, pipeline?.id, loadSuccessfulAccounts]);

  useEffect(() => {
    if (!successfulAccountsOpen || pipelineActive || !pipeline?.id) return undefined;
    let stopped = false;
    let timer;
    let retries = 0;
    const refreshFinalState = async () => {
      const result = await loadSuccessfulAccounts({ quiet: true, full: true });
      if (!stopped && result?.busy) {
        timer = window.setTimeout(refreshFinalState, 250);
      } else if (!stopped && result === null && retries < 3) {
        retries += 1;
        timer = window.setTimeout(refreshFinalState, 250 * retries);
      }
    };
    refreshFinalState();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [successfulAccountsOpen, pipelineActive, pipeline?.id, pipeline?.finished_at, loadSuccessfulAccounts]);

  useEffect(() => {
    if (!dependencyRefreshReady.current) {
      dependencyRefreshReady.current = true;
      return;
    }
    loadState({ quiet: true });
  }, [liveDependencySignature, loadState]);

  useEffect(() => {
    if (!pipelineActive && !recoveryActive) return undefined;
    let stopped = false;
    let timer = window.setTimeout(async function poll() {
      await loadState({ quiet: true });
      if (!stopped) timer = window.setTimeout(poll, 2_000);
    }, 2_000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [pipelineActive, pipeline?.id, recoveryActive, loadState]);

  useEffect(() => {
    if (!isPipelineTerminal(pipeline) || !pipeline?.id) return;
    const notificationKey = `${pipeline.id}:${status}`;
    if (terminalNotification.current === notificationKey) return;
    terminalNotification.current = notificationKey;
    setForm((current) => (current.domain === "random" ? current : { ...current, domain: "random" }));
    Promise.resolve().then(() => onRefresh?.()).catch(() => {});
  }, [pipeline, status, onRefresh]);

  useEffect(() => {
    if (pipelineActive) return;
    const nextCountry = String(paymentLinkCountry || paymentLinks?.country || "DE").trim().toUpperCase();
    if (nextCountry) setCountry(nextCountry);
  }, [paymentLinkCountry, paymentLinks?.country, pipelineActive]);

  useEffect(() => {
    if (pipelineActive) return;
    setForm((current) => {
      if (current.domain === "random") return current;
      const selected = domainOptions.find((item) => item.value === current.domain && item.ready);
      const preferred = domainOptions.find((item) => item.ready) || domainOptions[0];
      const domain = selected?.value || (randomDomainReady ? "random" : preferred?.value) || "";
      return domain === current.domain ? current : { ...current, domain };
    });
  }, [domainSignature, domainOptions, pipelineActive, randomDomainReady]);

  useEffect(() => {
    if (pipelineActive) return;
    setForm((current) => {
      const proxyCount = options?.proxies?.length || 0;
      const fixedProxy = String(current.proxySelection || "").match(/^proxy:(\d+)$/);
      const proxySelection = fixedProxy && Number(fixedProxy[1]) >= proxyCount
        ? (proxyCount ? "auto" : "direct")
        : (!current.proxySelection || (current.proxySelection === "auto" && !proxyCount))
          ? (proxyCount ? "auto" : "direct")
          : current.proxySelection;
      return proxySelection === current.proxySelection ? current : { ...current, proxySelection };
    });
  }, [options?.proxies?.length, pipelineActive]);

  useEffect(() => {
    if (!pipelineActive) return;
    const submittedCountry = String(pipeline?.payment_link_country || pipeline?.paymentLinkCountry || country || "DE").toUpperCase();
    setForm((current) => ({
      ...current,
      domain: String(pipeline?.domain || current.domain || "").replace(/^@+/, "").toLowerCase(),
      concurrency: Number(pipeline?.concurrency || current.concurrency || 1),
      linkAttempts: Number(pipeline?.link_attempts ?? pipeline?.linkAttempts ?? current.linkAttempts ?? 3),
      browserMode: pipeline?.browser_mode || pipeline?.browserMode || current.browserMode,
      proxySelection: pipeline?.proxy_selection || pipeline?.proxySelection || current.proxySelection,
    }));
    if (submittedCountry) setCountry(submittedCountry);
  }, [pipelineActive, pipeline?.browser_mode, pipeline?.browserMode, pipeline?.concurrency, pipeline?.domain, pipeline?.link_attempts, pipeline?.linkAttempts, pipeline?.payment_link_country, pipeline?.paymentLinkCountry, pipeline?.proxy_selection, pipeline?.proxySelection]);

  const selectedDomain = form.domain === "random"
    ? { value: "random", label: "随机后缀", ready: randomDomainReady }
    : domainOptions.find((item) => item.value === form.domain) || null;
  const concurrency = Number(form.concurrency);
  const concurrencyError = !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 20
    ? "请输入 1 到 20 的整数"
    : "";
  const linkAttempts = Number(form.linkAttempts);
  const linkAttemptsError = !Number.isSafeInteger(linkAttempts) || linkAttempts < 1 || linkAttempts > 10
    ? "请输入 1 到 10 的整数"
    : "";
  const fixedProxy = String(form.proxySelection || "").match(/^proxy:(\d+)$/);
  const proxyCount = options?.proxies?.length || 0;
  const proxyInvalid = form.proxySelection === "auto" && !proxyCount
    ? "注册代理池为空，请改用直连"
    : fixedProxy && Number(fixedProxy[1]) >= proxyCount
      ? "固定注册代理已不存在，请重新选择"
      : "";
  const registrationReady = typeof options?.service?.ok === "boolean"
    ? options.service.ok
    : Boolean(dependency.registration_ready);
  const paymentLinkReady = typeof paymentLinks?.configured === "boolean"
    ? paymentLinks.configured
    : Boolean(dependency.payment_links_configured);
  const paymentAgreementRuntimeLoaded = paymentAgreementRuntime !== null && paymentAgreementRuntime !== undefined;
  const paymentAgreementSettingsLoaded = paymentAgreementSettings !== null && paymentAgreementSettings !== undefined;
  const paymentAgreementRuntimeReady = paymentAgreementRuntimeLoaded
    && paymentAgreementRuntime?.configured === true;
  const paymentAgreementSettingsReady = paymentAgreementSettingsLoaded
    && paymentAgreementSettings?.protocol_configured === true
    && paymentAgreementSettings?.configured === true
    && paymentAgreementSettings?.api_key_configured === true;
  const paymentAgreementReady = paymentAgreementRuntimeReady && paymentAgreementSettingsReady;
  const checkoutProxyCount = optionalCount(paymentLinks?.checkout_proxy_count, dependency.checkout_proxy_count) ?? 0;
  const updateProxyCount = optionalCount(paymentLinks?.update_proxy_count, dependency.update_proxy_count) ?? 0;
  const updateRequired = typeof paymentLinks?.apply_checkout_update === "boolean"
    ? paymentLinks.apply_checkout_update
    : dependency.apply_checkout_update !== false;
  const queuePaused = typeof queueControl?.paused === "boolean"
    ? queueControl.paused
    : Boolean(dependency.queue_paused);
  const liveDependencyStateComplete = typeof queueControl?.paused === "boolean"
    && typeof options?.service?.ok === "boolean"
    && typeof paymentLinks?.configured === "boolean"
    && paymentLinks?.checkout_proxy_count !== undefined
    && paymentLinks?.update_proxy_count !== undefined
    && typeof paymentAgreementRuntime?.configured === "boolean"
    && typeof paymentAgreementSettings?.protocol_configured === "boolean"
    && typeof paymentAgreementSettings?.configured === "boolean"
    && typeof paymentAgreementSettings?.api_key_configured === "boolean";
  const dependencyError = liveDependencyStateComplete ? "" : dependency.error;
  const inventoryReady = counts.accountCount > 0;
  const domainReady = Boolean(selectedDomain?.ready);

  const readiness = [
    ...(recoveryFieldsPresent ? [{
      label: recoveryActive ? `安全收尾 ${recoveringRecycleCount}` : "轮换收尾",
      ready: !recoveryActive,
      title: recoveryBlocker || "没有停止后待收尾的别名轮换",
    }] : []),
    { label: "母号/别名", ready: inventoryReady, title: `母号 ${counts.accountCount}，别名 ${counts.aliasCount}${counts.accountCount > 0 && counts.aliasCount < 1 ? "（启动后自动补建）" : ""}` },
    { label: "注册服务", ready: registrationReady },
    { label: "提链", ready: paymentLinkReady },
    {
      label: "自动协议授权",
      ready: paymentAgreementReady,
      title: paymentAgreementReady
        ? `${String(paymentAgreementRuntime?.country || "").toUpperCase()} · ${Number(paymentAgreementRuntime?.proxy_count || 0)} 条协议代理`
        : "协议国家、代理池、HeroSMS 与协议服务必须全部就绪",
    },
    { label: "Checkout", ready: checkoutProxyCount > 0, title: `${checkoutProxyCount} 条代理` },
    { label: "Update", ready: !updateRequired || updateProxyCount > 0, title: updateRequired ? `${updateProxyCount} 条代理` : "已关闭" },
    { label: "域名", ready: domainReady, title: form.domain === "random" ? "随机选择可用后缀" : (form.domain ? `@${form.domain}` : "没有可用域名") },
  ];

  const blockers = [
    !stateLoaded ? "正在读取 mail.com 汇总与流水线状态" : "",
    summaryLoadError ? `mail.com 汇总服务不可用：${summaryLoadError}` : "",
    pipelineLoadError ? `mail.com 流水线服务不可用：${pipelineLoadError}` : "",
    recoveryBlocker,
    queuePaused ? "注册队列已暂停，请先恢复队列" : "",
    counts.accountCount < 1 ? "没有已连接的 mail.com 母号" : "",
    !registrationReady ? "注册服务未连接" : "",
    !paymentLinkReady ? "PayPal 提链服务未配置" : "",
    !paymentAgreementRuntimeLoaded ? "正在检查自动协议授权运行配置" : "",
    paymentAgreementRuntime?.error ? `自动协议授权运行配置读取失败：${paymentAgreementRuntime.error}` : "",
    paymentAgreementRuntimeLoaded && !paymentAgreementRuntime?.error && !paymentAgreementRuntimeReady
      ? "请先配置协议国家和至少一条协议代理"
      : "",
    !paymentAgreementSettingsLoaded ? "正在检查 HeroSMS 与协议授权服务" : "",
    paymentAgreementSettings?.error ? `自动协议授权配置读取失败：${paymentAgreementSettings.error}` : "",
    paymentAgreementSettingsLoaded && !paymentAgreementSettings?.error && paymentAgreementSettings?.protocol_configured !== true
      ? "PayPal 协议授权服务尚未配置"
      : "",
    paymentAgreementSettingsLoaded && !paymentAgreementSettings?.error
      && (paymentAgreementSettings?.configured !== true || paymentAgreementSettings?.api_key_configured !== true)
      ? "HeroSMS 尚未配置，无法自动完成协议授权"
      : "",
    checkoutProxyCount < 1 ? "Checkout Proxy 池为空" : "",
    updateRequired && updateProxyCount < 1 ? "Update Proxy 池为空" : "",
    !domainOptions.length ? "没有可用的 mail.com 域名后缀" : "",
    !form.domain ? "请选择域名后缀" : "",
    selectedDomain && !selectedDomain.ready
      ? (selectedDomain.value === "random" ? "没有可供随机选择的域名后缀" : `域名 @${selectedDomain.value} 当前不可用`)
      : "",
    concurrencyError,
    linkAttemptsError,
    proxyInvalid,
    !String(country || "").trim() ? "请选择提链国家" : "",
    dependencyError ? String(dependencyError) : "",
    summary?.ready === false && !recoveryActive ? "mail.com 无限流水线服务尚未就绪" : "",
  ].filter(Boolean);

  const start = async () => {
    if (startBusy.current || pipelineActive) return;
    if (blockers.length) {
      toast(blockers[0], "error");
      return;
    }
    startBusy.current = true;
    setSubmitting(true);
    setActionError("");
    const payload = {
      domain: form.domain,
      concurrency,
      linkAttempts,
      browserMode: form.browserMode,
      proxySelection: form.proxySelection,
      paymentLinkCountry: String(country).toUpperCase(),
      recycleSucceeded: false,
    };
    try {
      const requestKey = JSON.stringify(payload);
      if (pendingStartRequest.current.key !== requestKey) {
        pendingStartRequest.current = { key: requestKey, id: makeRequestId() };
      }
      const result = await api("/api/registration/mailcom-pipelines", {
        method: "POST",
        body: { ...payload, requestId: pendingStartRequest.current.id },
      });
      const nextPipeline = selectPipeline(result);
      if (nextPipeline) setPipeline(nextPipeline);
      else await loadState({ quiet: true });
      pendingStartRequest.current = { key: "", id: "" };
      toast("mail.com 无限注册、提链与自动协议授权流水线已启动");
    } catch (error) {
      const existing = selectPipeline(error?.details);
      if (existing) setPipeline(existing);
      const activeConflict = error?.status === 409
        && String(error?.code || error?.details?.code || "").toUpperCase() === "MAILCOM_PIPELINE_ACTIVE";
      const recoveryConflict = error?.status === 409
        && String(error?.code || error?.details?.code || "").toUpperCase() === "MAILCOM_PIPELINE_RECOVERY_ACTIVE";
      const recovered = !existing && activeConflict ? await loadState({ quiet: true }) : null;
      if (recovered && isPipelineActive(recovered)) {
        pendingStartRequest.current = { key: "", id: "" };
        setActionError("");
        toast("已载入正在运行的 mail.com 无限流水线");
        return;
      }
      if (recoveryConflict) {
        setRecoveryProbeActive(true);
        setActionError("");
        await loadState({ quiet: true });
        toast("停止后的别名轮换正在安全收尾，后台会使用已保存密码自动恢复网页授权；完成后可再次启动", "error");
        return;
      }
      const message = error.message || "mail.com 无限流水线启动失败";
      setActionError(message);
      toast(message, "error");
    } finally {
      startBusy.current = false;
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    if (!pipeline?.id || !pipelineActive || pipeline?.cancellable === false || cancelBusy.current) return;
    if (!window.confirm("确定停止 mail.com 无限注册、提链与自动协议授权流水线吗？已汇总的结果会保留。")) return;
    cancelBusy.current = true;
    setCancelling(true);
    setActionError("");
    try {
      const result = await api(`/api/registration/mailcom-pipelines/${encodeURIComponent(pipeline.id)}/cancel`, {
        method: "POST",
      });
      const nextPipeline = selectPipeline(result);
      if (nextPipeline) setPipeline(nextPipeline);
      setRecoveryProbeActive(true);
      await loadState({ quiet: true });
      toast("已停止新任务并进入安全收尾；网页授权失效时后台会使用已保存密码自动恢复");
    } catch (error) {
      const message = error.message || "停止 mail.com 无限流水线失败";
      setActionError(message);
      toast(message, "error");
    } finally {
      cancelBusy.current = false;
      setCancelling(false);
    }
  };

  const attemptCount = statNumber(pipeline, "attempt_count", "attemptCount");
  const registrationSuccessCount = statNumber(pipeline, "registration_success_count", "registrationSuccessCount");
  const linkSuccessCount = statNumber(pipeline, "link_success_count", "linkSuccessCount");
  const agreementActiveCount = statNumber(pipeline, "agreement_active_count", "agreementActiveCount");
  const agreementSuccessCount = statNumber(pipeline, "agreement_success_count", "agreementSuccessCount");
  const agreementFailureCount = statNumber(pipeline, "agreement_failure_count", "agreementFailureCount");
  const failureCount = statNumber(pipeline, "failure_count", "failureCount");
  const recycledCount = statNumber(pipeline, "recycled_count", "recycledCount");
  const createdAliasCount = statNumber(pipeline, "created_alias_count", "created_count", "createdAliasCount", "createdCount");
  const preparation = useMemo(() => {
    const primaries = (Array.isArray(pipeline?.items) ? pipeline.items : [])
      .filter((item) => item?.slot_kind === "primary" || item?.primary === true);
    const processed = primaries.filter((item) => !String(item?.stage || "").startsWith("prepare_")).length;
    const failed = primaries.filter((item) => (
      !String(item?.stage || "").startsWith("prepare_") && String(item?.prepare_error || "").trim()
    )).length;
    return { total: primaries.length, processed, succeeded: Math.max(0, processed - failed), failed };
  }, [pipeline?.items]);
  const preparationActive = pipelineActive && preparation.total > 0 && preparation.processed < preparation.total;
  const phaseProgress = objectValue(pipeline?.phase_progress || pipeline?.phaseProgress);
  const phaseCards = useMemo(() => {
    const definitions = [
      ["preparation", "母号准备", MailPlus],
      ["registration", "注册", UserCheck],
      ["link", "提链", Link2],
      ["agreement", "协议授权", ShieldCheck],
      ["recycle", "别名轮换", RefreshCw],
    ];
    return definitions.map(([key, label, icon]) => {
      const phase = objectValue(phaseProgress[key]);
      const number = (name) => Math.max(0, Number(phase[name] || 0));
      const waiting = number("waiting");
      const running = number("running");
      const retrying = number("retrying");
      return {
        key,
        label,
        icon,
        waiting,
        running,
        retrying,
        succeeded: number("succeeded"),
        failed: number("failed"),
        uncertain: number("uncertain"),
        preserved: number("preserved"),
        total: number("total"),
        active: waiting + running + retrying > 0,
      };
    });
  }, [phaseProgress]);
  const actionRequiredAccounts = useMemo(() => {
    const rows = pipeline?.action_required_accounts || pipeline?.actionRequiredAccounts || [];
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      accountId: Number(row?.account_id ?? row?.accountId) || null,
      sourceEmail: String(row?.source_email ?? row?.sourceEmail ?? "").trim(),
      currentEmail: String(row?.current_email ?? row?.currentEmail ?? "").trim(),
      affectedCount: Math.max(0, Number(row?.affected_count ?? row?.affectedCount ?? 0)),
      activeCount: Math.max(0, Number(row?.active_count ?? row?.activeCount ?? 0)),
      error: automaticAuthorizationMessage(row?.error),
    }));
  }, [pipeline?.action_required_accounts, pipeline?.actionRequiredAccounts]);
  const registrationFailedCount = phaseCards.find((phase) => phase.key === "registration")?.failed || 0;
  const registrationResolvedCount = registrationSuccessCount + registrationFailedCount;
  const registrationSuccessRate = registrationResolvedCount > 0
    ? Math.round((registrationSuccessCount / registrationResolvedCount) * 1_000) / 10
    : null;
  const activityMessage = String(
    pipeline?.activity_message || pipeline?.activityMessage || phaseProgress.message || pipeline?.message || `任务 ${pipeline?.id || ""}`,
  );
  const recentErrors = useMemo(() => {
    const items = Array.isArray(pipeline?.items) ? pipeline.items : [];
    const attempts = Array.isArray(pipeline?.attempts) ? pipeline.attempts : [];
    const explicitRecent = Array.isArray(pipeline?.recent_errors)
      ? pipeline.recent_errors
      : Array.isArray(pipeline?.recentErrors) ? pipeline.recentErrors : [];
    const normalizeError = (item, index, source) => {
      const detail = typeof item === "string" ? { error: item } : objectValue(item);
      const error = detail.recycle_error || detail.prepare_error || detail.error || detail.failure_reason;
      if (!error) return null;
      const email = detail.email || detail.current_email || detail.currentEmail || detail.source_email || detail.sourceEmail || "未知邮箱";
      const sourceEmail = detail.source_email || detail.sourceEmail || "";
      const attemptNumber = detail.attempt_number ?? detail.attemptNumber ?? null;
      return {
        key: detail.id || `${source}-${email}-${detail.cycle ?? index}-${attemptNumber ?? "attempt"}-${detail.stage || "unknown"}`,
        email,
        sourceEmail,
        stage: detail.stage,
        cycle: detail.cycle,
        attemptNumber,
        error: String(error),
      };
    };
    const errors = [
      ...explicitRecent.map((item, index) => normalizeError(item, index, "recent")),
      ...[...attempts, ...items].map((item, index) => normalizeError(item, index, "attempt")).filter(Boolean).reverse(),
    ].filter(Boolean);
    if (pipeline?.error && !errors.some((item) => item.error === String(pipeline.error))) {
      errors.unshift({ key: "pipeline-error", email: "流水线", stage: pipeline.stage, cycle: null, attemptNumber: null, error: String(pipeline.error) });
    }
    const seen = new Set();
    return errors.filter((item) => {
      const key = `${item.email}\u0000${item.cycle ?? ""}\u0000${item.attemptNumber ?? ""}\u0000${item.stage || ""}\u0000${item.error}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 4);
  }, [pipeline]);
  const pipelineFailure = status === "failed" || status === "partial_failed" || status === "interrupted";
  const canStop = pipelineActive && Boolean(pipeline?.id) && pipeline?.cancellable !== false
    && status !== "cancel_requested" && status !== "stopping";
  const badgeStatus = pipeline
    ? pipelineStatusBadge(status)
    : loadError ? "failed" : stateLoaded ? "inactive" : "queued";
  const badgeLabel = pipeline
    ? (statusLabels[status] || status || "未知")
    : loadError ? "不可用" : stateLoaded ? "待启动" : "检测中";
  const successfulAccountsHasMore = successfulAccounts.hasMore === true;

  const openSuccessfulAccounts = () => {
    if (!pipeline?.id || linkSuccessCount < 1) return;
    setSuccessfulAccountsOpen(true);
    const initial = {
      total: linkSuccessCount,
      limit: successfulAccountsPageSize,
      offset: 0,
      nextCursor: "",
      hasMore: linkSuccessCount > successfulAccountsPageSize,
      items: [],
    };
    setSuccessfulAccounts(initial);
    successfulAccountsRef.current = initial;
    setSuccessfulAccountsError("");
    loadSuccessfulAccounts();
  };

  return (
    <>
    <section className={`mc-registration-pipeline-bar ${pipelineActive ? "is-active" : ""} ${collapsed ? "is-collapsed" : ""} ${statusClass ? `is-${statusClass}` : ""}`}>
      <header className="mc-pipeline-heading">
        <span className="mc-pipeline-icon"><MailPlus size={19} /></span>
        <div>
          <h2>mail.com 无限注册提链与协议授权流水线</h2>
          <p>汇总全部母号与官方别名；注册 → PayPal 提链 → 自动协议授权，失败自动轮换，结果统一保留</p>
        </div>
        <StatusBadge status={badgeStatus}>{badgeLabel}</StatusBadge>
        <div className="mc-pipeline-heading-actions">
          {loadError && <Button size="sm" icon={RefreshCw} loading={loadingState} onClick={() => loadState()}>重试检测</Button>}
          <Button
            className="mc-pipeline-run-action"
            variant={pipelineActive ? "danger" : "primary"}
            size="sm"
            icon={pipelineActive ? CircleStop : Play}
            loading={pipelineActive ? (cancelling || status === "cancel_requested" || status === "stopping") : submitting}
            disabled={pipelineActive ? !canStop : blockers.length > 0}
            title={pipelineActive ? (canStop ? "停止当前无限流水线" : "流水线正在停止或当前不可取消") : (blockers[0] || "")}
            onClick={pipelineActive ? cancel : start}
          >{pipelineActive ? (status === "cancel_requested" || status === "stopping" ? "停止中" : "停止") : "启动无限注册、提链并授权"}</Button>
          <Button
            className="mc-pipeline-collapse-toggle"
            size="sm"
            icon={collapsed ? ChevronDown : ChevronUp}
            aria-expanded={!collapsed}
            aria-controls="mailcom-pipeline-details"
            onClick={() => setCollapsed((value) => !value)}
          >{collapsed ? "展开" : "折叠"}</Button>
        </div>
      </header>

      <div id="mailcom-pipeline-details" className="mc-pipeline-details" hidden={collapsed}>
        <div className="mc-pipeline-fields">
          <FormField label="汇总范围">
            <output className="mc-pipeline-scope" title={`已连接母号 ${counts.accountCount}，地址 ${counts.addressCount}，官方别名 ${counts.aliasCount}`}>
              <span>母号 <b>{counts.accountCount}</b></span>
              <span>地址 <b>{counts.addressCount}</b></span>
              <span>别名 <b>{counts.aliasCount}</b></span>
            </output>
          </FormField>
          <FormField label="域名后缀">
            <select value={form.domain} disabled={pipelineActive || !domainOptions.length} onChange={(event) => setForm({ ...form, domain: event.target.value })}>
              <option value="random" disabled={!randomDomainReady}>随机后缀</option>
              {domainOptions.map((item) => <option key={item.value} value={item.value} disabled={!item.ready}>@{item.label}</option>)}
            </select>
          </FormField>
          <FormField label="注册并发" error={concurrencyError} hint="1-20">
            <input type="number" min="1" max="20" step="1" value={form.concurrency} disabled={pipelineActive} onChange={(event) => setForm({ ...form, concurrency: Number(event.target.value) })} />
          </FormField>
          <FormField label="提链次数" error={linkAttemptsError} hint="1-10，默认 3 次">
            <input type="number" min="1" max="10" step="1" value={form.linkAttempts} disabled={pipelineActive} onChange={(event) => setForm({ ...form, linkAttempts: Number(event.target.value) })} />
          </FormField>
          <FormField label="浏览器模式">
            <select value={form.browserMode} disabled={pipelineActive} onChange={(event) => setForm({ ...form, browserMode: event.target.value })}>
              <option value="headed">内嵌指纹浏览器</option>
              <option value="headless">后台指纹浏览器</option>
            </select>
          </FormField>
          <FormField label="注册代理" error={proxyInvalid}>
            <select value={form.proxySelection} disabled={pipelineActive} onChange={(event) => setForm({ ...form, proxySelection: event.target.value })}>
              <option value="direct">直连（不使用代理）</option>
              <option value="auto">自动轮换代理池（{proxyCount}）</option>
              {(options?.maskedProxies || []).map((item, index) => (
                <option key={`${item}-${index}`} value={`proxy:${index}`}>固定：{proxySelectLabel(item, options?.proxyMetadata?.[index])}</option>
              ))}
            </select>
          </FormField>
          <FormField label="提链国家">
            <select value={country} disabled={pipelineActive} onChange={(event) => {
              const value = event.target.value;
              setCountry(value);
              onPaymentLinkCountryChange?.(value);
            }}>
              {countryOptions.map((item) => <option key={item.code} value={item.code}>{item.code}{item.currency ? `（${item.currency}）` : ""}</option>)}
            </select>
          </FormField>
        </div>

        <div className="mc-pipeline-cycle-toggle is-preserve">
          <ShieldCheck size={14} />
          <span>协议授权成功账号永久保留；仅失败的官方别名删除并轮换</span>
        </div>

        <div className="mc-pipeline-readiness" aria-label="mail.com 流水线配置检查">
          {readiness.map((item) => <span className={item.ready ? "ready" : "blocked"} title={item.title || item.label} key={item.label}>{item.ready ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}{item.label}</span>)}
        </div>

        {!pipelineActive && blockers.length > 0 && <div className="mc-pipeline-blocker">
          <AlertTriangle size={15} />
          <span>{blockers[0]}</span>
          {recoveryActive && typeof onNavigate === "function" && <Button
            size="sm"
            icon={primaryRecovery?.accountId ? ShieldCheck : MailPlus}
            onClick={() => onNavigate("sources", primaryRecovery?.accountId
              ? { accountId: primaryRecovery.accountId }
              : {})}
          >{primaryRecovery?.accountId ? "查看自动恢复" : "打开源头邮箱"}</Button>}
        </div>}
        {pipelineActive && loadError && <div className="mc-pipeline-blocker"><AlertTriangle size={15} /><span>状态刷新失败，将自动重试：{loadError}</span></div>}
        {pipelineActive && dependency.ready === false && dependency.error && <div className="mc-pipeline-blocker">
          <AlertTriangle size={15} />
          <span>流水线正在等待依赖恢复：{String(dependency.error)}</span>
        </div>}
      </div>

      {actionError && <div className="mc-pipeline-action-error" role="alert"><AlertTriangle size={15} /><span>{actionError}</span></div>}

      {pipeline && actionRequiredAccounts.length > 0 && <div className="mc-pipeline-account-blockers" role="alert">
        <b><AlertTriangle size={15} />Mail.com 网页授权自动恢复</b>
        {actionRequiredAccounts.map((account) => <div key={account.accountId || account.sourceEmail}>
          <span>
            <strong>{account.sourceEmail || `母号 #${account.accountId}`}</strong>
            <small>{account.currentEmail ? `当前别名 ${account.currentEmail} · ` : ""}受影响 {account.affectedCount} 个地址槽{account.activeCount ? ` · 仍在收尾 ${account.activeCount} 个` : ""}</small>
            <em>{account.error}</em>
          </span>
          {account.accountId && typeof onNavigate === "function" && <Button
            size="sm"
            icon={Cable}
            onClick={() => onNavigate("sources", { accountId: account.accountId })}
          >查看母号</Button>}
        </div>)}
      </div>}

      {pipeline && <div className="mc-pipeline-activity" aria-live="polite">
        <div className="mc-pipeline-activity-heading">
          {pipelineActive ? <LoaderCircle className="spin" size={17} /> : status === "completed" ? <CheckCircle2 size={17} /> : pipelineFailure ? <AlertTriangle size={17} /> : <CircleStop size={17} />}
          <span><b>{pipelineActive ? "五阶段流水线并行处理中" : stageLabel(pipeline.stage || status)}</b><small>{preparationActive
            ? `每个母号处理完成后立即进入注册、提链和协议授权；母号已处理 ${preparation.processed} / ${preparation.total}（成功 ${preparation.succeeded}，失败 ${preparation.failed}）。${activityMessage}`
            : activityMessage}</small></span>
          <strong>{pipelineActive
            ? (String(pipeline.domain || "").replace(/^@+/, "").toLowerCase() === "random"
              ? "随机后缀"
              : (pipeline.domain ? `@${String(pipeline.domain).replace(/^@+/, "")}` : "持续运行"))
            : (statusLabels[status] || "已结束")}</strong>
        </div>
        <div className="mc-pipeline-phases" aria-label="流水线五阶段实时状态">
          {phaseCards.map((phase) => {
            const PhaseIcon = phase.icon;
            return <article className={phase.active ? "is-active" : ""} key={phase.key}>
              <header><PhaseIcon size={14} /><b>{phase.label}</b>{phase.active && <i />}</header>
              <span><small>等待</small><b>{phase.waiting}</b></span>
              <span><small>进行</small><b>{phase.running}</b></span>
              <span><small>重试</small><b>{phase.retrying}</b></span>
              <footer>
                <span>成功 <b>{phase.succeeded}</b></span>
                <span>失败 <b>{phase.failed}</b></span>
                {phase.uncertain > 0 && <span>待确认 <b>{phase.uncertain}</b></span>}
                {phase.preserved > 0 && <span>已保留 <b>{phase.preserved}</b></span>}
              </footer>
            </article>;
          })}
        </div>
        <small className="mc-pipeline-count-note">等待 / 进行 / 重试表示当前地址槽；成功率只统计注册阶段已出结果的尝试，不含仍在处理的地址。注册成功会立即提链，提链成功会立即自动协议授权。</small>
        <div className="mc-pipeline-stats">
          {preparation.total > 0 && <span title={`成功 ${preparation.succeeded}，失败 ${preparation.failed}`}><MailPlus size={13} />母号处理 <b>{preparation.processed} / {preparation.total}</b></span>}
          <span><Activity size={13} />尝试 <b>{attemptCount}</b></span>
          <span><UserCheck size={13} />注册成功 <b>{registrationSuccessCount}</b></span>
          <span title="成功 ÷（成功 + 失败）；不含等待、进行和重试"><Activity size={13} />注册成功率 <b>{registrationSuccessRate === null ? "—" : `${registrationSuccessRate}%`}</b></span>
          <button
            type="button"
            className="mc-pipeline-stat-action"
            disabled={!pipeline?.id || linkSuccessCount < 1}
            aria-haspopup="dialog"
            title={linkSuccessCount > 0 ? `查看本流水线 ${linkSuccessCount} 个提链成功账号及协议授权结果` : "暂无提链成功账号"}
            onClick={openSuccessfulAccounts}
          ><Link2 size={13} />提链成功 <b>{linkSuccessCount}</b></button>
          <span><Cable size={13} />协议中 <b>{agreementActiveCount}</b></span>
          <span><ShieldCheck size={13} />协议成功 <b>{agreementSuccessCount}</b></span>
          <span><AlertTriangle size={13} />协议失败 <b>{agreementFailureCount}</b></span>
          <span title="包含注册、提链和协议阶段保留的历史失败尝试"><AlertTriangle size={13} />累计失败尝试 <b>{failureCount}</b></span>
          <span><Trash2 size={13} />已删/轮换 <b>{recycledCount}</b></span>
          <span><AtSign size={13} />已补建 <b>{createdAliasCount}</b></span>
        </div>
        {!collapsed && recentErrors.length > 0 && <div className="mc-pipeline-failures" role="alert">
          <b><AlertTriangle size={14} />最近错误</b>
          {recentErrors.map((item) => <span key={item.key}>{item.email}{item.sourceEmail && item.sourceEmail !== item.email ? ` · 母号 ${item.sourceEmail}` : ""}{item.cycle !== null && item.cycle !== undefined ? ` · 第 ${item.cycle} 轮` : ""}{item.attemptNumber !== null && item.attemptNumber !== undefined ? ` · 第 ${item.attemptNumber} 次尝试` : ""} · {stageLabel(item.stage)}：{item.error}</span>)}
          {failureCount > recentErrors.length && <small>累计失败尝试 {failureCount} 次，此处仅显示最近 {recentErrors.length} 条。</small>}
        </div>}
      </div>}
    </section>

    <Modal
      open={successfulAccountsOpen}
      onClose={() => setSuccessfulAccountsOpen(false)}
      title="mail.com 提链成功账号"
      description={`本流水线共 ${successfulAccounts.total || linkSuccessCount} 个提链成功账号；提链完成后由后台自动执行协议授权`}
      size="lg"
      footer={<Button onClick={() => setSuccessfulAccountsOpen(false)}>关闭</Button>}
    >
      <div className="mc-successful-accounts">
        <div className="mc-successful-summary" aria-label="成功账号协议授权汇总">
          <span><Link2 size={15} /><small>提链成功</small><b>{successfulAccounts.total || linkSuccessCount}</b></span>
          <span><Cable size={15} /><small>协议中</small><b>{agreementActiveCount}</b></span>
          <span><ShieldCheck size={15} /><small>协议成功</small><b>{agreementSuccessCount}</b></span>
          <span><AlertTriangle size={15} /><small>协议失败</small><b>{agreementFailureCount}</b></span>
          {successfulAccountsRefreshing && <em><LoaderCircle className="spin" size={13} />正在刷新</em>}
        </div>

        {successfulAccountsError && <div className="mc-successful-error" role="alert">
          <AlertTriangle size={15} />
          <span>{successfulAccountsError}</span>
          <Button size="sm" icon={RefreshCw} onClick={() => loadSuccessfulAccounts()}>重试</Button>
        </div>}

        {successfulAccountsLoading && !successfulAccounts.items.length ? (
          <div className="mc-successful-loading"><LoaderCircle className="spin" size={24} /><span><b>正在读取提链成功账号</b><small>同时加载每个账号的自动协议授权状态。</small></span></div>
        ) : successfulAccounts.items.length ? (
          <div className="mc-successful-account-list">
            {successfulAccounts.items.map((item, index) => {
              const agreement = agreementPresentation(item);
              const agreementStatus = String(item.agreement_status || "").toLowerCase();
              const sourceLabel = item.slot_kind === "primary" ? "母号地址" : "官方别名";
              return <article className={agreement.badge === "failed" ? "is-failed" : ""} key={successfulAccountKey(item, index)}>
                <header>
                  <span className="mc-successful-account-icon"><UserCheck size={17} /></span>
                  <span className="mc-successful-account-title">
                    <b title={item.email}>{item.email || "未知邮箱"}</b>
                    <small title={item.source_email}>{sourceLabel}{item.source_email ? ` · 母号 ${item.source_email}` : ""}{item.cycle ? ` · 第 ${item.cycle} 轮` : ""}</small>
                  </span>
                  <StatusBadge status={agreement.badge}>{agreement.label}</StatusBadge>
                </header>
                <dl>
                  <div><dt>注册账号</dt><dd title={String(item.external_account_id || "")}>{item.external_account_id ? `#${item.external_account_id}` : "未记录"}</dd></div>
                  <div><dt>提链国家</dt><dd>{item.payment_link_country || "-"}</dd></div>
                  <div><dt>协议国家</dt><dd>{agreementStatus === "skipped" ? "历史未授权" : (item.agreement_country || "-")}</dd></div>
                  <div><dt>协议任务</dt><dd title={item.agreement_job_id || ""}>{item.agreement_job_id || "-"}</dd></div>
                  <div><dt>注册完成</dt><dd>{successfulAccountTime(item.registration_finished_at)}</dd></div>
                  <div><dt>提链完成</dt><dd>{successfulAccountTime(item.link_finished_at)}</dd></div>
                </dl>
                <footer>
                  <Clock3 size={14} />
                  <span><small>协议授权结果</small><b>{agreementStatus === "skipped" ? agreement.label : item.agreement_finished_at ? successfulAccountTime(item.agreement_finished_at) : agreement.label}</b></span>
                </footer>
                {item.agreement_error && <div className="mc-successful-account-error"><AlertTriangle size={13} /><span>{item.agreement_error}</span></div>}
              </article>;
            })}
          </div>
        ) : !successfulAccountsError ? (
          <EmptyState icon={UserCheck} title="暂无提链成功账号" description="账号提链成功后会自动出现在这里，并显示协议授权进度。" />
        ) : null}

        {(successfulAccounts.items.length > 0 || successfulAccountsHasMore) && <div className="mc-successful-pagination">
          <span>已显示 <b>{successfulAccounts.items.length}</b> / {successfulAccounts.total}</span>
          {successfulAccountsHasMore && <Button size="sm" icon={ChevronDown} loading={successfulAccountsLoadingMore} onClick={() => loadSuccessfulAccounts({ append: true })}>加载更多</Button>}
        </div>}
      </div>
    </Modal>
    </>
  );
}
