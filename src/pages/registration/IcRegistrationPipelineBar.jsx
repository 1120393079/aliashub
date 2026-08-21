import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, CircleStop, Cloud, CreditCard, Link2, LoaderCircle, Play, RefreshCw, UserCheck } from "lucide-react";
import { api } from "../../api.js";
import { Button, FormField, StatusBadge, useToast } from "../../components.jsx";
import { proxySelectLabel } from "./proxy-model.js";
import { baseOptionLabel, directRegistrationBases, preferredBase, registrationBaseOptions } from "./registration-model.js";

const activeStatuses = new Set(["queued", "running", "cancel_requested"]);
const terminalStatuses = new Set(["completed", "partial_failed", "failed", "cancelled", "interrupted"]);
const itemTerminalStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);
const itemFailureStatuses = new Set(["failed", "interrupted"]);
const pipelineFailureStatuses = new Set(["partial_failed", "failed", "interrupted"]);
const stageRanks = {
  queued: 0,
  mailbox_queued: 2,
  mailbox_submitting: 4,
  creating_mailbox: 5,
  creating_mailboxes: 5,
  mailbox_ready: 7,
  registration_queued: 10,
  registration_submitting: 10,
  registration_wait: 20,
  registering: 20,
  registered: 25,
  link_ready: 30,
  link_submitting: 40,
  extracting_link: 45,
  extracting_links: 45,
  link_wait: 50,
  agreement_ready: 60,
  agreement_queued: 65,
  agreement_submitting: 70,
  agreement_running: 75,
  paying: 75,
  agreement_wait: 80,
};

const statusLabels = {
  queued: "等待启动",
  running: "自动执行中",
  cancel_requested: "正在取消",
  completed: "全部完成",
  partial_failed: "部分完成",
  failed: "执行失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

const mailboxSessionStatusLabels = {
  source_not_connected: "源头邮箱未连接",
  login_missing: "尚未登录对应 Apple ID",
  login_required: "Apple ID 登录态不可用",
  login_expired: "Apple ID 登录态已失效",
  manage_not_ready: "Apple ID 管理态尚未就绪",
  service_unavailable: "邮箱创建服务当前不可用",
};

const stageLabels = {
  queued: "等待启动",
  mailbox_queued: "等待创建 iCloud 邮箱",
  mailbox_submitting: "正在创建 iCloud 邮箱",
  creating_mailbox: "创建 iCloud 邮箱",
  creating_mailboxes: "创建 iCloud 邮箱",
  mailbox_ready: "iCloud 邮箱创建完成",
  registration_queued: "提交注册队列",
  registration_submitting: "提交注册任务",
  registration_wait: "等待注册完成",
  registering: "注册账号",
  registered: "注册完成",
  extracting_link: "PayPal 提链",
  extracting_links: "PayPal 提链",
  link_ready: "准备 PayPal 提链",
  link_submitting: "提交 PayPal 提链",
  link_wait: "等待 PayPal 提链",
  agreement_ready: "准备协议支付",
  agreement_submitting: "提交协议支付",
  agreement_wait: "等待协议支付",
  agreement_queued: "等待协议支付",
  agreement_running: "协议支付",
  paying: "协议支付",
  completed: "流水线完成",
  partial_failed: "流水线部分完成",
  failed: "流水线失败",
  cancelled: "流水线已取消",
  interrupted: "流水线已中断",
};

function stageLabel(value) {
  const stage = String(value || "").trim().toLowerCase();
  if (!stage) return "准备流水线";
  if (stageLabels[stage]) return stageLabels[stage];
  if (stage.includes("mail")) return "创建 iCloud 邮箱";
  if (stage.includes("register")) return "注册账号";
  if (stage.includes("link") || stage.includes("extract")) return "PayPal 提链";
  if (stage.includes("agreement") || stage.includes("payment") || stage.includes("paying")) return "协议支付";
  return stage;
}

function pipelineStatusBadge(status) {
  if (status === "completed") return "completed";
  if (status === "partial_failed") return "warning";
  if (status === "failed") return "failed";
  if (status === "interrupted") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "cancel_requested") return "warning";
  return activeStatuses.has(status) ? status : "inactive";
}

function currentPipelineStage(pipeline, status) {
  if (status === "cancel_requested" || terminalStatuses.has(status)) return pipeline?.stage;
  const activeItems = (pipeline?.items || []).filter((item) => (
    !itemTerminalStatuses.has(String(item?.status || "").toLowerCase())
  ));
  return activeItems.reduce((latest, item) => {
    const stage = String(item?.stage || "").toLowerCase();
    return (stageRanks[stage] ?? -1) > (stageRanks[latest] ?? -1) ? stage : latest;
  }, String(pipeline?.stage || "").toLowerCase());
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function makeRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `ic-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function directPipeline(payload) {
  if (payload?.pipeline?.id) return payload.pipeline;
  if (payload?.id) return payload;
  if (payload?.active?.id) return payload.active;
  if (!Array.isArray(payload?.items)) return null;
  return payload.items.find((item) => activeStatuses.has(String(item?.status || "").toLowerCase()))
    || payload.items[0]
    || null;
}

export default function IcRegistrationPipelineBar({
  options,
  paymentLinks,
  paymentAgreementRuntime,
  paymentAgreementSettings,
  paymentLinkCountry,
  onPaymentLinkCountryChange,
  onRefresh,
  onNavigate,
}) {
  const [form, setForm] = useState({
    mailboxMode: "auto_create",
    accountId: "",
    baseAddressId: "",
    count: 1,
    concurrency: 1,
    browserMode: "headed",
    proxySelection: "auto",
  });
  const [country, setCountry] = useState(paymentLinkCountry || paymentLinks?.country || "DE");
  const [pipeline, setPipeline] = useState(null);
  const [loadingPipeline, setLoadingPipeline] = useState(true);
  const [pipelineLoaded, setPipelineLoaded] = useState(false);
  const [pipelineLoadError, setPipelineLoadError] = useState("");
  const [mailboxStatus, setMailboxStatus] = useState(null);
  const [mailboxStatusLoaded, setMailboxStatusLoaded] = useState(false);
  const [mailboxStatusLoadError, setMailboxStatusLoadError] = useState("");
  const [loadingMailboxStatus, setLoadingMailboxStatus] = useState(true);
  const [actionError, setActionError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const requestSequence = useRef(0);
  const mailboxStatusSequence = useRef(0);
  const startBusy = useRef(false);
  const cancelBusy = useRef(false);
  const pendingStartRequest = useRef({ key: "", id: "" });
  const terminalNotification = useRef("");
  const toast = useToast();
  const pipelineActive = activeStatuses.has(String(pipeline?.status || "").toLowerCase());
  const autoCreateMailbox = form.mailboxMode === "auto_create";

  const icloudAccounts = useMemo(() => (options?.accounts || []).filter((item) => (
    item.provider === "icloud" && item.registration_mode === "direct"
  )), [options?.accounts]);

  const selectedAccount = useMemo(() => icloudAccounts.find((item) => (
    String(item.id) === String(form.accountId)
  )) || null, [icloudAccounts, form.accountId]);

  const baseOptions = useMemo(() => registrationBaseOptions(selectedAccount), [selectedAccount]);
  const selectedBase = useMemo(() => baseOptions.find((item) => (
    String(item.id) === String(form.baseAddressId)
  )) || null, [baseOptions, form.baseAddressId]);
  const availableBases = useMemo(() => (
    directRegistrationBases(selectedAccount, form.baseAddressId)
  ), [selectedAccount, form.baseAddressId]);
  const availableCount = Math.min(200, availableBases.length);
  const submittedBase = pipelineActive && !selectedBase
    ? (pipeline?.items || []).find((item) => String(item.address_id) === String(form.baseAddressId))
    : null;

  const selectedMailboxSession = useMemo(() => (mailboxStatus?.sessions || []).find((item) => (
    String(item?.source_account_id || "") === String(form.accountId)
  )) || null, [mailboxStatus?.sessions, form.accountId]);
  const mailboxServiceReady = mailboxStatusLoaded
    && !mailboxStatusLoadError
    && mailboxStatus?.configured === true
    && !mailboxStatus?.error;
  // can_create_hme describes the legacy iCloud Web channel. The one-click
  // pipeline uses the Apple Account channel, whose readiness is exposed by
  // the normalized `ready` field.
  const appleLoginReady = Boolean(selectedMailboxSession?.ready);

  const countryOptions = useMemo(() => {
    const result = new Map();
    for (const item of paymentLinks?.countries || []) {
      const code = String(item?.code || "").trim().toUpperCase();
      if (code) result.set(code, { code, currency: String(item?.currency || "") });
    }
    const current = String(country || paymentLinkCountry || paymentLinks?.country || "DE").trim().toUpperCase();
    if (current && !result.has(current)) result.set(current, { code: current, currency: "" });
    return [...result.values()];
  }, [country, paymentLinkCountry, paymentLinks?.countries, paymentLinks?.country]);

  useEffect(() => {
    const nextCountry = String(paymentLinkCountry || paymentLinks?.country || "DE").trim().toUpperCase();
    if (nextCountry) setCountry(nextCountry);
  }, [paymentLinkCountry, paymentLinks?.country]);

  useEffect(() => {
    setForm((current) => {
      if (pipelineActive) return current;
      const account = icloudAccounts.find((item) => String(item.id) === String(current.accountId))
        || icloudAccounts[0]
        || null;
      const bases = registrationBaseOptions(account);
      const base = bases.find((item) => String(item.id) === String(current.baseAddressId))
        || preferredBase(account)
        || null;
      const available = Math.min(200, directRegistrationBases(account, base?.id).length);
      const autoCreate = current.mailboxMode === "auto_create";
      const fixedProxy = String(current.proxySelection || "").match(/^proxy:(\d+)$/);
      const proxySelection = fixedProxy && Number(fixedProxy[1]) >= (options?.proxies?.length || 0)
        ? ((options?.proxies?.length || 0) ? "auto" : "direct")
        : (!current.proxySelection || (current.proxySelection === "auto" && !(options?.proxies?.length || 0)))
          ? ((options?.proxies?.length || 0) ? "auto" : "direct")
          : current.proxySelection;
      return {
        ...current,
        accountId: String(account?.id || ""),
        baseAddressId: String(base?.id || ""),
        count: Math.max(1, Math.min(Number(current.count) || 1, autoCreate ? 20 : (available || 1))),
        proxySelection,
      };
    });
  }, [icloudAccounts, options?.proxies?.length, pipelineActive]);

  useEffect(() => {
    if (!pipelineActive) return;
    const submittedMailboxMode = String(pipeline?.mailbox_mode || pipeline?.mailboxMode || "").toLowerCase();
    setForm((current) => ({
      ...current,
      mailboxMode: submittedMailboxMode || (pipeline?.base_address_id ? "existing" : current.mailboxMode),
      accountId: String(pipeline?.account_id || current.accountId || ""),
      baseAddressId: String(pipeline?.base_address_id || current.baseAddressId || ""),
      count: Number(pipeline?.count || current.count || 1),
      concurrency: Number(pipeline?.concurrency || current.concurrency || 1),
      browserMode: pipeline?.browser_mode || current.browserMode,
      proxySelection: pipeline?.proxy_selection || current.proxySelection,
    }));
  }, [
    pipelineActive,
    pipeline?.account_id,
    pipeline?.base_address_id,
    pipeline?.browser_mode,
    pipeline?.concurrency,
    pipeline?.count,
    pipeline?.mailbox_mode,
    pipeline?.mailboxMode,
    pipeline?.proxy_selection,
  ]);

  const loadPipeline = useCallback(async ({ quiet = false } = {}) => {
    const sequence = ++requestSequence.current;
    if (!quiet) setLoadingPipeline(true);
    try {
      const result = await api("/api/registration/ic-pipelines");
      if (sequence !== requestSequence.current) return null;
      setPipeline(directPipeline(result));
      setPipelineLoadError("");
      setPipelineLoaded(true);
      return result;
    } catch (error) {
      if (sequence === requestSequence.current) {
        setPipelineLoadError(error.message || "一键流水线状态读取失败");
        setPipelineLoaded(true);
      }
      return null;
    } finally {
      if (sequence === requestSequence.current && !quiet) setLoadingPipeline(false);
    }
  }, []);

  const loadMailboxStatus = useCallback(async ({ quiet = false } = {}) => {
    const sequence = ++mailboxStatusSequence.current;
    if (!quiet) setLoadingMailboxStatus(true);
    try {
      const result = await api("/api/registration/ic-pipelines/mailbox-status");
      if (sequence !== mailboxStatusSequence.current) return null;
      setMailboxStatus(result || {});
      setMailboxStatusLoadError("");
      setMailboxStatusLoaded(true);
      return result;
    } catch (error) {
      if (sequence === mailboxStatusSequence.current) {
        setMailboxStatusLoadError(error.message || "iCloud 邮箱创建服务状态读取失败");
        setMailboxStatusLoaded(true);
      }
      return null;
    } finally {
      if (sequence === mailboxStatusSequence.current && !quiet) setLoadingMailboxStatus(false);
    }
  }, []);

  useEffect(() => {
    loadPipeline();
    return () => { requestSequence.current += 1; };
  }, [loadPipeline]);

  useEffect(() => {
    loadMailboxStatus();
    return () => { mailboxStatusSequence.current += 1; };
  }, [loadMailboxStatus]);

  useEffect(() => {
    if (!pipelineActive) return undefined;
    let stopped = false;
    let timer = window.setTimeout(async function poll() {
      await loadPipeline({ quiet: true });
      if (!stopped) timer = window.setTimeout(poll, 2_000);
    }, 2_000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [pipelineActive, pipeline?.id, loadPipeline]);

  useEffect(() => {
    const status = String(pipeline?.status || "").toLowerCase();
    if (!pipeline?.id || !terminalStatuses.has(status)) return;
    const notificationKey = `${pipeline.id}:${status}`;
    if (terminalNotification.current === notificationKey) return;
    terminalNotification.current = notificationKey;
    Promise.resolve(onRefresh?.()).catch(() => {});
  }, [pipeline?.id, pipeline?.status, onRefresh]);

  const count = Number(form.count);
  const concurrency = Number(form.concurrency);
  const countError = pipelineActive
    ? ""
    : !Number.isSafeInteger(count) || count < 1
    ? "请输入大于等于 1 的整数"
    : autoCreateMailbox && count > 20
      ? "单次最多创建并注册 20 个邮箱"
      : !autoCreateMailbox && count > 200
        ? "单次最多使用 200 个已有邮箱"
      : !autoCreateMailbox && count > availableCount
      ? `从所选邮箱往下仅 ${availableBases.length} 个可用`
      : "";
  const concurrencyError = !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 5
    ? "请输入 1 到 5 的整数"
    : "";
  const fixedProxy = String(form.proxySelection || "").match(/^proxy:(\d+)$/);
  const updateProxyRequired = paymentLinks?.apply_checkout_update !== false;
  const agreementSettingsReady = Boolean(
    paymentAgreementSettings?.protocol_configured
    && paymentAgreementSettings?.configured
    && paymentAgreementSettings?.api_key_configured,
  );
  const proxyInvalid = form.proxySelection === "auto" && !(options?.proxies?.length || 0)
    ? "注册代理池为空，请改用直连"
    : fixedProxy && Number(fixedProxy[1]) >= (options?.proxies?.length || 0)
      ? "固定注册代理已不存在，请重新选择"
      : "";

  const readiness = [
    { label: "流水线服务", ready: pipelineLoaded && !pipelineLoadError },
    ...(autoCreateMailbox ? [
      { label: "邮箱创建服务", ready: mailboxServiceReady },
      { label: "Apple 登录态", ready: appleLoginReady },
    ] : []),
    { label: "注册服务", ready: Boolean(options?.service?.ok) },
    { label: "提链服务", ready: Boolean(paymentLinks?.configured) },
    { label: "Checkout", ready: Number(paymentLinks?.checkout_proxy_count || 0) > 0 },
    { label: updateProxyRequired ? "Update" : "Update 已关闭", ready: !updateProxyRequired || Number(paymentLinks?.update_proxy_count || 0) > 0 },
    { label: "协议支付", ready: Boolean(paymentAgreementRuntime?.configured) && agreementSettingsReady },
  ];

  const blockers = [
    !pipelineLoaded ? "正在检查一键流水线服务" : "",
    pipelineLoadError ? `一键流水线服务不可用：${pipelineLoadError}` : "",
    autoCreateMailbox && !mailboxStatusLoaded ? "正在检查 iCloud 邮箱创建服务" : "",
    autoCreateMailbox && mailboxStatusLoadError ? `iCloud 邮箱创建服务不可用：${mailboxStatusLoadError}` : "",
    autoCreateMailbox && mailboxStatusLoaded && !mailboxStatusLoadError && mailboxStatus?.configured !== true
      ? `iCloud 邮箱创建服务未配置${mailboxStatus?.error ? `：${mailboxStatus.error}` : ""}`
      : "",
    autoCreateMailbox && mailboxStatusLoaded && mailboxStatus?.configured === true && mailboxStatus?.error
      ? `iCloud 邮箱创建服务不可用：${mailboxStatus.error}`
      : "",
    autoCreateMailbox && mailboxServiceReady && !selectedMailboxSession
      ? "所选 iCloud 账号尚未登录 Apple ID，请先到 iCloud 隐藏邮箱完成登录"
      : "",
    autoCreateMailbox && mailboxServiceReady && selectedMailboxSession && !appleLoginReady
      ? selectedMailboxSession.ready
        ? "所选 iCloud 账号当前不能创建隐藏邮箱，请重新登录 Apple ID"
        : `所选 iCloud 账号的 Apple 登录态未就绪${selectedMailboxSession.status ? `：${mailboxSessionStatusLabels[selectedMailboxSession.status] || selectedMailboxSession.status}` : "，请重新登录"}`
      : "",
    !options?.service?.ok ? "注册服务未连接" : "",
    !paymentLinks?.configured ? "PayPal 提链服务未配置" : "",
    !Number(paymentLinks?.checkout_proxy_count || 0) ? "Checkout Proxy 池为空" : "",
    updateProxyRequired && !Number(paymentLinks?.update_proxy_count || 0) ? "Update Proxy 池为空" : "",
    !paymentAgreementRuntime?.configured ? "协议支付运行配置未完成" : "",
    !paymentAgreementSettings ? "正在检查 HeroSMS 与协议支付配置" : "",
    paymentAgreementSettings?.error ? `协议支付配置读取失败：${paymentAgreementSettings.error}` : "",
    paymentAgreementSettings && !paymentAgreementSettings.protocol_configured ? "协议支付服务尚未配置" : "",
    paymentAgreementSettings && (!paymentAgreementSettings.configured || !paymentAgreementSettings.api_key_configured)
      ? "HeroSMS 尚未配置"
      : "",
    !icloudAccounts.length ? "没有可用的 iCloud 直连账号" : "",
    !form.accountId ? "请选择 iCloud 账号" : "",
    !autoCreateMailbox && !selectedBase ? "没有可用的 iCloud 注册邮箱" : "",
    countError,
    concurrencyError,
    proxyInvalid,
    !String(country || "").trim() ? "请选择账单国家" : "",
  ].filter(Boolean);
  const mailboxSetupRequired = autoCreateMailbox && mailboxStatusLoaded
    && (!mailboxServiceReady || !appleLoginReady);
  const showMailboxSetupAction = mailboxSetupRequired
    && /(?:iCloud 邮箱创建|Apple 登录|隐藏邮箱)/.test(blockers[0] || "");

  const start = async () => {
    if (startBusy.current || pipelineActive) return;
    if (blockers.length) {
      toast(blockers[0], "error");
      return;
    }
    startBusy.current = true;
    setSubmitting(true);
    setActionError("");
    try {
      const requestKey = JSON.stringify({
        mailboxMode: form.mailboxMode,
        accountId: Number(form.accountId),
        baseAddressId: autoCreateMailbox ? null : Number(form.baseAddressId),
        count,
        concurrency,
        browserMode: form.browserMode,
        proxySelection: form.proxySelection,
        paymentLinkCountry: String(country).toUpperCase(),
      });
      if (pendingStartRequest.current.key !== requestKey) {
        pendingStartRequest.current = { key: requestKey, id: makeRequestId() };
      }
      const result = await api("/api/registration/ic-pipelines", {
        method: "POST",
        body: {
          mailboxMode: form.mailboxMode,
          accountId: Number(form.accountId),
          ...(!autoCreateMailbox ? { baseAddressId: Number(form.baseAddressId) } : {}),
          count,
          concurrency,
          browserMode: form.browserMode,
          proxySelection: form.proxySelection,
          paymentLinkCountry: String(country).toUpperCase(),
          requestId: pendingStartRequest.current.id,
        },
      });
      setPipeline(directPipeline(result));
      pendingStartRequest.current = { key: "", id: "" };
      toast("iC 注册、提链与协议支付流水线已启动");
      Promise.resolve(onRefresh?.()).catch(() => {});
    } catch (error) {
      const existing = directPipeline(error?.details);
      if (existing) setPipeline(existing);
      setActionError(error.message || "一键流水线启动失败");
      toast(error.message || "一键流水线启动失败", "error");
    } finally {
      startBusy.current = false;
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    if (!pipeline?.id || !pipelineActive || cancelBusy.current) return;
    if (!window.confirm("确定取消这次 iC 注册、提链与协议支付流水线吗？已完成的阶段会保留。")) return;
    cancelBusy.current = true;
    setCancelling(true);
    setActionError("");
    try {
      const result = await api(`/api/registration/ic-pipelines/${encodeURIComponent(pipeline.id)}/cancel`, {
        method: "POST",
      });
      setPipeline(directPipeline(result));
      toast("已请求取消 iC 自动流水线");
    } catch (error) {
      setActionError(error.message || "取消流水线失败");
      toast(error.message || "取消流水线失败", "error");
    } finally {
      cancelBusy.current = false;
      setCancelling(false);
    }
  };

  const total = Math.max(0, Number(pipeline?.progress_total ?? pipeline?.count ?? 0) || 0);
  const current = Math.max(0, Math.min(total || Number.MAX_SAFE_INTEGER, Number(pipeline?.progress_current || 0) || 0));
  const status = String(pipeline?.status || "").toLowerCase();
  const percent = status === "completed"
    ? 100
    : total ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0;
  const displayStage = currentPipelineStage(pipeline, status);
  const phaseProgress = objectValue(pipeline?.phase_progress || pipeline?.phaseProgress);
  const phaseCards = useMemo(() => [
    ["mailbox", "邮箱准备", Cloud],
    ["registration", "注册", UserCheck],
    ["link", "提链", Link2],
    ["agreement", "协议支付", CreditCard],
  ].map(([key, label, icon]) => {
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
      active: waiting + running + retrying > 0,
    };
  }), [phaseProgress]);
  const pipelineFailure = pipelineFailureStatuses.has(status);
  const failedItems = (pipeline?.items || []).filter((item) => (
    item?.error && itemFailureStatuses.has(String(item.status || "").toLowerCase())
  )).slice(-4);

  return (
    <section className={`ic-registration-pipeline-bar ${pipelineActive ? "is-active" : ""} ${collapsed ? "is-collapsed" : ""} ${status ? `is-${status}` : ""}`}>
      <header className="ic-pipeline-heading">
        <span className="ic-pipeline-icon"><Cloud size={19} /></span>
        <div>
          <h2>iCloud 一键注册流水线</h2>
          <p>自动创建 iCloud 隐藏邮箱 → 注册 → PayPal 提链 → 协议支付；单个失败不会阻塞其他账号</p>
        </div>
        {pipeline && <StatusBadge status={pipelineStatusBadge(status)}>{statusLabels[status] || status || "未知"}</StatusBadge>}
        <div className="ic-pipeline-heading-actions">
          {pipelineLoadError && <Button size="sm" icon={RefreshCw} loading={loadingPipeline} onClick={() => loadPipeline()}>重试检测</Button>}
          {autoCreateMailbox && !pipelineLoadError && mailboxStatusLoadError && <Button size="sm" icon={RefreshCw} loading={loadingMailboxStatus} onClick={() => loadMailboxStatus()}>重试邮箱检测</Button>}
          {!pipelineLoadError && actionError && <Button size="sm" icon={RefreshCw} loading={loadingPipeline} onClick={() => { setActionError(""); loadPipeline(); }}>刷新状态</Button>}
          <Button
            variant="primary"
            size="sm"
            icon={Play}
            className="ic-pipeline-start-action"
            loading={submitting}
            disabled={pipelineActive || blockers.length > 0}
            title={pipelineActive ? "已有一键流水线正在执行" : (blockers[0] || "")}
            onClick={start}
          >{autoCreateMailbox ? "一键创建邮箱并注册、提链、协议支付" : "一键启动 iC 注册并提链加协议支付"}</Button>
          {pipelineActive && <Button size="sm" variant="danger" icon={CircleStop} loading={cancelling} onClick={cancel}>取消</Button>}
          <Button
            className="ic-pipeline-collapse-toggle"
            size="sm"
            icon={collapsed ? ChevronDown : ChevronUp}
            aria-expanded={!collapsed}
            aria-controls="ic-pipeline-details"
            onClick={() => setCollapsed((value) => !value)}
          >{collapsed ? "展开" : "折叠"}</Button>
        </div>
      </header>

      <div id="ic-pipeline-details" className="ic-pipeline-details" hidden={collapsed}>
        <div className={`ic-pipeline-fields ${autoCreateMailbox ? "is-auto-create" : "is-existing"}`}>
        <FormField label="iCloud 账号">
          <select value={form.accountId} disabled={pipelineActive} onChange={(event) => {
            const account = icloudAccounts.find((item) => String(item.id) === event.target.value);
            const base = preferredBase(account);
            const available = Math.min(200, directRegistrationBases(account, base?.id).length);
            setForm((currentForm) => ({
              ...currentForm,
              accountId: event.target.value,
              baseAddressId: String(base?.id || ""),
              count: Math.max(1, Math.min(
                Number(currentForm.count) || 1,
                currentForm.mailboxMode === "auto_create" ? 20 : (available || 1),
              )),
            }));
          }}>
            <option value="">请选择</option>
            {icloudAccounts.map((item) => <option key={item.id} value={item.id}>{item.email}</option>)}
          </select>
        </FormField>
        <FormField label="邮箱方式">
          <select value={form.mailboxMode} disabled={pipelineActive} onChange={(event) => {
            const mailboxMode = event.target.value;
            const base = selectedBase || preferredBase(selectedAccount);
            const available = Math.min(200, directRegistrationBases(selectedAccount, base?.id).length);
            setForm((currentForm) => ({
              ...currentForm,
              mailboxMode,
              baseAddressId: String(base?.id || ""),
              count: Math.max(1, Math.min(
                Number(currentForm.count) || 1,
                mailboxMode === "auto_create" ? 20 : (available || 1),
              )),
            }));
          }}>
            <option value="auto_create">自动创建全新隐藏邮箱（推荐）</option>
            <option value="existing">使用已有邮箱</option>
          </select>
        </FormField>
        {!autoCreateMailbox && <FormField label="起始邮箱" hint={pipelineActive ? `本次已锁定 ${pipeline?.count || form.count} 个邮箱` : `从这里起按顺序可用 ${availableBases.length} 个${availableBases.length > 200 ? "，单次最多 200 个" : ""}`}>
          <select value={form.baseAddressId} disabled={pipelineActive} onChange={(event) => {
            const available = Math.min(200, directRegistrationBases(selectedAccount, event.target.value).length);
            setForm((currentForm) => ({
              ...currentForm,
              baseAddressId: event.target.value,
              count: Math.max(1, Math.min(Number(currentForm.count) || 1, available || 1)),
            }));
          }}>
            <option value="">请选择</option>
            {submittedBase && <option value={form.baseAddressId}>{submittedBase.email || "本次已提交的起始邮箱"}</option>}
            {baseOptions.map((item) => <option key={item.id} value={item.id}>{baseOptionLabel(item)}</option>)}
          </select>
        </FormField>}
        <FormField
          label={autoCreateMailbox ? "创建并注册数量" : "数量"}
          error={countError}
          hint={pipelineActive && autoCreateMailbox ? `本次将创建并注册 ${pipeline?.count || form.count} 个新邮箱` : (autoCreateMailbox ? "每次自动创建全新的 iCloud 隐藏邮箱，单次最多 20 个" : "")}
        >
          <input type="number" min="1" max={autoCreateMailbox ? 20 : Math.max(1, availableCount)} step="1" value={form.count} disabled={pipelineActive} onChange={(event) => setForm({ ...form, count: Number(event.target.value) })} />
        </FormField>
        <FormField label="注册并发" error={concurrencyError} hint="1-5">
          <input type="number" min="1" max="5" step="1" value={form.concurrency} disabled={pipelineActive} onChange={(event) => setForm({ ...form, concurrency: Number(event.target.value) })} />
        </FormField>
        <FormField label="注册代理" error={proxyInvalid}>
          <select value={form.proxySelection} disabled={pipelineActive} onChange={(event) => setForm({ ...form, proxySelection: event.target.value })}>
            <option value="direct">直连（不使用代理）</option>
            <option value="auto">自动轮换代理池（{options?.proxies?.length || 0}）</option>
            {(options?.maskedProxies || []).map((item, index) => (
              <option key={`${item}-${index}`} value={`proxy:${index}`}>固定：{proxySelectLabel(item, options?.proxyMetadata?.[index])}</option>
            ))}
          </select>
        </FormField>
        <FormField label="账单国家">
          <select value={country} disabled={pipelineActive} onChange={(event) => {
            const value = event.target.value;
            setCountry(value);
            onPaymentLinkCountryChange?.(value);
          }}>
            {countryOptions.map((item) => <option key={item.code} value={item.code}>{item.code}{item.currency ? `（${item.currency}）` : ""}</option>)}
          </select>
        </FormField>
        </div>

        <div className="ic-pipeline-readiness" aria-label="流水线配置检查">
          {readiness.map((item) => <span className={item.ready ? "ready" : "blocked"} key={item.label}>{item.ready ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}{item.label}</span>)}
        </div>

        {!pipelineActive && blockers.length > 0 && <div className="ic-pipeline-blocker"><AlertTriangle size={15} /><span>{blockers[0]}</span>{showMailboxSetupAction && <Button size="sm" icon={Cloud} onClick={() => onNavigate?.("icloud-privacy")}>打开 iCloud 隐藏邮箱</Button>}</div>}
        {pipelineActive && pipelineLoadError && <div className="ic-pipeline-blocker"><AlertTriangle size={15} /><span>状态刷新失败，将自动重试：{pipelineLoadError}</span></div>}
      </div>
      {actionError && <div className="ic-pipeline-action-error" role="alert"><AlertTriangle size={15} /><span>{actionError}</span></div>}

      {pipeline && <div className="ic-pipeline-progress" aria-live="polite">
        <div className="ic-pipeline-progress-heading">
          {pipelineActive ? <LoaderCircle className="spin" size={17} /> : status === "completed" ? <CheckCircle2 size={17} /> : pipelineFailure ? <AlertTriangle size={17} /> : <CircleStop size={17} />}
          <span><b>{stageLabel(displayStage)}</b><small>{pipeline.message || `任务 ${pipeline.id}`}</small></span>
          <strong>{current} / {total || pipeline.count || 0}</strong>
        </div>
        <span className="ic-pipeline-progress-track" role="progressbar" aria-label="iC 自动流水线进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></span>
        <div className="mc-pipeline-phases ic-pipeline-phases" aria-label="流水线四阶段实时状态">
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
              </footer>
            </article>;
          })}
        </div>
        <small className="mc-pipeline-count-note">等待 / 进行 / 重试表示当前邮箱槽；成功 / 失败表示各阶段累计结果。注册成功后会自动提链，提链成功后会自动协议支付。</small>
        <div className="ic-pipeline-stage-stats">
          <span><CheckCircle2 size={13} />成功 <b>{Number(pipeline.success_count || 0)}</b></span>
          <span><AlertTriangle size={13} />失败 <b>{Number(pipeline.failure_count || 0)}</b></span>
          <span><CircleStop size={13} />取消 <b>{Number(pipeline.cancelled_count || 0)}</b></span>
        </div>
        {!collapsed && (pipelineFailure || failedItems.length > 0) && <div className="ic-pipeline-failures" role="alert">
          <b><AlertTriangle size={14} />失败原因</b>
          {pipelineFailure && pipeline.error && <span>{pipeline.error}</span>}
          {failedItems.map((item) => <span key={item.id || `${item.email}-${item.stage}`}>{item.email || "未知邮箱"} · {stageLabel(item.failure_stage || item.stage)}：{item.error}</span>)}
          {Number(pipeline.failure_count || 0) > failedItems.length && <small>另有 {Number(pipeline.failure_count || 0) - failedItems.length} 个失败项，请在注册记录中查看完整原因。</small>}
        </div>}
      </div>}
    </section>
  );
}
