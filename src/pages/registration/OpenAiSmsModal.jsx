import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock3,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Settings2,
  Smartphone,
} from "lucide-react";
import { api } from "../../api.js";
import { Button, EmptyState, FormField, LoadingBlock, Modal, StatusBadge } from "../../components.jsx";
import { formatDate } from "../../utils.js";

const TERMINAL_STATUSES = new Set([
  "completed",
  "succeeded",
  "success",
  "failed",
  "cancelled",
  "canceled",
  "interrupted",
]);

const DEFAULT_FORM = Object.freeze({
  country: "TH",
  maxPrice: "0.5",
  claimTimeoutSeconds: "300",
  waitSeconds: "120",
  concurrency: "1",
  browserMode: "camoufox_headed",
});

const STATUS_META = Object.freeze({
  pending: { label: "等待执行", badge: "queued" },
  queued: { label: "等待执行", badge: "queued" },
  claiming: { label: "正在抢号", badge: "running" },
  sniping: { label: "正在抢号", badge: "running" },
  acquiring: { label: "正在抢号", badge: "running" },
  acquiring_number: { label: "正在抢号", badge: "running" },
  claim_number: { label: "正在抢号", badge: "running" },
  claiming_number: { label: "正在抢号", badge: "running" },
  waiting_price: { label: "等待价格", badge: "paused" },
  waiting_inventory: { label: "等待库存", badge: "paused" },
  number_acquired: { label: "号码已获取", badge: "active" },
  number_claimed: { label: "号码已获取", badge: "active" },
  starting_worker: { label: "正在启动浏览器", badge: "running" },
  worker_queued: { label: "浏览器排队中", badge: "queued" },
  worker_pending: { label: "浏览器排队中", badge: "queued" },
  worker_claimed: { label: "浏览器已领取", badge: "running" },
  worker_running: { label: "正在绑定", badge: "running" },
  worker_cancel_retry: { label: "正在重试取消", badge: "paused" },
  binding: { label: "正在绑定", badge: "running" },
  running: { label: "正在执行", badge: "running" },
  waiting_code: { label: "等待验证码", badge: "paused" },
  awaiting_code: { label: "等待验证码", badge: "paused" },
  waiting_sms: { label: "等待验证码", badge: "paused" },
  waiting_otp: { label: "等待验证码", badge: "paused" },
  code_received: { label: "验证码已送达", badge: "active" },
  activation_cancelled: { label: "号码已释放", badge: "inactive" },
  cancel_requested: { label: "正在取消", badge: "paused" },
  cancelling: { label: "正在取消", badge: "paused" },
  completed: { label: "接码完成", badge: "active" },
  succeeded: { label: "接码完成", badge: "active" },
  success: { label: "接码完成", badge: "active" },
  failed: { label: "执行失败", badge: "failed" },
  cancelled: { label: "已取消", badge: "inactive" },
  canceled: { label: "已取消", badge: "inactive" },
  interrupted: { label: "已中断", badge: "failed" },
});

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function taskObject(value) {
  const source = objectValue(value);
  return objectValue(
    source.task
    || source.item
    || source.data?.task
    || source.data?.item
    || source.data
    || source,
  );
}

function taskIdFrom(value) {
  const source = objectValue(value);
  const task = taskObject(source);
  return String(firstDefined(
    task.task_id,
    task.id,
    source.task_id,
    source.id,
    source.data?.task_id,
    source.data?.id,
    source.item?.task_id,
    source.item?.id,
    "",
  ));
}

function firstArray(...values) {
  return values.find(Array.isArray) || [];
}

function maskPhone(value) {
  const source = String(value || "").trim();
  if (!source || source.includes("*")) return source;
  const digits = source.replace(/\D/g, "");
  if (!digits) return source;
  return `${"*".repeat(Math.max(3, digits.length - 4))}${digits.slice(-4)}`;
}

function normalizeAccountItem(item, index) {
  const source = objectValue(item);
  const ok = source.ok === true || source.success === true;
  const failed = source.ok === false || source.success === false;
  const lifecycleStatus = String(firstDefined(source.status, "")).toLowerCase();
  const stage = String(firstDefined(source.stage, "")).toLowerCase();
  const status = String(firstDefined(
    TERMINAL_STATUSES.has(lifecycleStatus) ? lifecycleStatus : "",
    stage && stage !== "queued" && stage !== "running" ? stage : "",
    lifecycleStatus,
    ok ? "completed" : "",
    failed ? "failed" : "",
    "pending",
  )).toLowerCase();
  return {
    ...source,
    key: String(firstDefined(source.account_id, source.external_account_id, source.id, source.email, index)),
    accountId: firstDefined(source.account_id, source.external_account_id, source.id, ""),
    email: String(firstDefined(source.email, source.account_email, "")),
    status,
    maskedPhone: maskPhone(firstDefined(source.phone_mask, source.masked_phone, source.phone_masked, source.phone, "")),
    price: firstDefined(source.price, source.activation_price, source.cost, null),
    attempts: Number(firstDefined(source.claim_attempts, source.attempts, source.attempt, source.try_count, 0)) || 0,
    error: String(firstDefined(source.error, source.cleanup_error, source.failure_reason, source.last_error, "")),
  };
}

function normalizeTask(value, previous = null) {
  const task = taskObject(value);
  const resultData = objectValue(task.result?.data || task.result || task.data);
  const rawItems = firstArray(
    task.accounts,
    task.items,
    task.results,
    resultData.accounts,
    resultData.items,
    resultData.results,
    value?.accounts,
    value?.items,
    value?.results,
    value?.data?.accounts,
    value?.data?.items,
    value?.data?.results,
  );
  const status = String(firstDefined(task.status, value?.status, previous?.status, "pending")).toLowerCase();
  const stage = String(firstDefined(task.stage, value?.stage, previous?.stage, "")).toLowerCase();
  const displayStatus = TERMINAL_STATUSES.has(status)
    ? status
    : (stage && stage !== "queued" && stage !== "running" ? stage : status);
  const items = rawItems.length
    ? rawItems.map(normalizeAccountItem)
    : (previous?.items || []);
  return {
    ...(previous || {}),
    ...task,
    taskId: taskIdFrom(value) || previous?.taskId || "",
    status,
    stage,
    displayStatus,
    terminal: Boolean(firstDefined(task.terminal, value?.terminal, false)) || TERMINAL_STATUSES.has(status),
    items,
    error: String(firstDefined(task.error, resultData.error, value?.error, previous?.error, "")),
    progressCurrent: Number(firstDefined(
      task.progress_current,
      task.progress?.current,
      resultData.success_count,
      previous?.progressCurrent,
      0,
    )) || 0,
    progressTotal: Number(firstDefined(
      task.progress_total,
      task.progress?.total,
      resultData.total,
      previous?.progressTotal,
      items.length,
      0,
    )) || 0,
  };
}

function normalizeEvents(value) {
  const source = objectValue(value);
  const items = firstArray(
    source.events,
    source.items,
    source.logs,
    source.data?.events,
    source.data?.items,
    source.data?.logs,
    Array.isArray(value) ? value : null,
  );
  return items.slice(-300).map((item, index) => {
    const event = objectValue(item);
    return {
      ...event,
      key: String(firstDefined(event.id, event.event_id, `${event.created_at || event.timestamp || "event"}-${index}`)),
      createdAt: String(firstDefined(event.created_at, event.timestamp, event.time, "")),
      level: String(firstDefined(event.level, event.severity, event.type, "info")).toLowerCase(),
      message: String(firstDefined(
        event.message,
        event.text,
        event.detail?.message,
        typeof item === "string" ? item : "",
        JSON.stringify(item),
      )),
    };
  });
}

function normalizeCountry(item) {
  if (typeof item === "string") {
    const value = item.trim();
    return value ? { value, label: value.toUpperCase() } : null;
  }
  const source = objectValue(item);
  const value = String(firstDefined(
    source.value,
    source.hero_sms_country_id,
    source.country_id,
    source.code,
    source.country,
    source.id,
    "",
  )).trim();
  if (!value) return null;
  const name = String(firstDefined(source.label, source.name, source.country_name, source.eng, "")).trim();
  const code = String(firstDefined(source.code, "")).trim().toUpperCase();
  return { value, label: name ? `${code ? `${code} · ` : ""}${name}` : (code || value.toUpperCase()) };
}

function normalizeLiveCountry(item, index) {
  const source = objectValue(item);
  const id = Number(firstDefined(source.hero_sms_country_id, source.country_id, source.id, source.value));
  const minPrice = Number(firstDefined(source.min_price, source.price_min_available, source.price, source.cost));
  const stock = Math.max(0, Math.trunc(Number(firstDefined(
    source.stock,
    source.physical_count,
    source.count_physical,
    source.count,
    0,
  )) || 0));
  if (!Number.isSafeInteger(id) || id < 0 || id > 999 || !Number.isFinite(minPrice) || minPrice <= 0) return null;
  return {
    id: String(id),
    numericId: id,
    rank: Number(source.rank) || index + 1,
    name: String(firstDefined(source.name, source.label, `HeroSMS 国家 #${id}`)),
    minPrice,
    stock,
    deliverability: Number.isFinite(Number(source.deliverability)) ? Number(source.deliverability) : null,
    outsideTop: false,
  };
}

function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "--";
  return `$${amount.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function formatRefreshTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "刚刚";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function settingsObject(value) {
  const source = objectValue(value);
  return objectValue(source.settings || source.item || source.data?.settings || source.data || source);
}

function formFromSettings(value) {
  const settings = settingsObject(value);
  const configuredConcurrency = Number(firstDefined(settings.concurrency, settings.default_concurrency, DEFAULT_FORM.concurrency));
  const configuredBrowserMode = String(firstDefined(settings.browser_mode, settings.default_browser_mode, DEFAULT_FORM.browserMode));
  return {
    country: String(firstDefined(
      settings.hero_sms_country_id,
      settings.country_id,
      settings.country,
      settings.default_country,
      settings.sms_country,
      DEFAULT_FORM.country,
    )),
    maxPrice: String(firstDefined(settings.max_price, settings.herosms_max_price, DEFAULT_FORM.maxPrice)),
    claimTimeoutSeconds: String(firstDefined(
      settings.claim_timeout_seconds,
      settings.acquire_timeout_seconds,
      settings.sniping_timeout_seconds,
      DEFAULT_FORM.claimTimeoutSeconds,
    )),
    waitSeconds: String(firstDefined(settings.wait_seconds, settings.code_wait_seconds, DEFAULT_FORM.waitSeconds)),
    concurrency: String(Math.min(Math.max(Number.isSafeInteger(configuredConcurrency) ? configuredConcurrency : 1, 1), 3)),
    browserMode: new Set(["camoufox_headed", "camoufox_headless"]).has(configuredBrowserMode)
      ? configuredBrowserMode : DEFAULT_FORM.browserMode,
  };
}

function formFromTask(value, settings) {
  const task = taskObject(value);
  const fallback = formFromSettings(settings);
  const configuredConcurrency = Number(firstDefined(task.concurrency, fallback.concurrency));
  const configuredBrowserMode = String(firstDefined(task.browser_mode, fallback.browserMode));
  return {
    country: String(firstDefined(task.hero_sms_country_id, task.country_id, task.country, fallback.country)),
    maxPrice: String(firstDefined(task.max_price, fallback.maxPrice)),
    claimTimeoutSeconds: String(firstDefined(task.claim_timeout_seconds, fallback.claimTimeoutSeconds)),
    waitSeconds: String(firstDefined(task.wait_seconds, fallback.waitSeconds)),
    concurrency: String(Math.min(Math.max(Number.isSafeInteger(configuredConcurrency) ? configuredConcurrency : 1, 1), 3)),
    browserMode: new Set(["camoufox_headed", "camoufox_headless"]).has(configuredBrowserMode)
      ? configuredBrowserMode : fallback.browserMode,
  };
}

function statusMeta(status) {
  return STATUS_META[String(status || "").toLowerCase()] || {
    label: String(status || "未知状态"),
    badge: "inactive",
  };
}

function taskItemsWithSelected(task, accounts) {
  if (task?.items?.length) return task.items;
  return (accounts || []).map((item, index) => normalizeAccountItem({
    account_id: item.id,
    email: item.email,
    status: task?.status || "pending",
  }, index));
}

export default function OpenAiSmsModal({
  open,
  onClose,
  accounts = [],
  onOpenSettings,
  onAccountsChanged,
}) {
  const [settings, setSettings] = useState(null);
  const [settingsError, setSettingsError] = useState("");
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [liveCountries, setLiveCountries] = useState([]);
  const [countryMeta, setCountryMeta] = useState(null);
  const [countryError, setCountryError] = useState("");
  const [loadingCountries, setLoadingCountries] = useState(false);
  const [countryReady, setCountryReady] = useState(false);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [paymentConfirmed, setPaymentConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [task, setTask] = useState(null);
  const [events, setEvents] = useState([]);
  const [actionError, setActionError] = useState("");
  const [pollError, setPollError] = useState("");
  const settingsRequest = useRef(0);
  const countriesRequest = useRef(0);
  const countrySelectionReady = useRef(false);
  const settingsInitializationKey = useRef("");
  const terminalRefreshTask = useRef("");
  const taskRef = useRef(null);
  const taskPollRequest = useRef(0);
  const selectedIds = useMemo(() => [...new Set((accounts || []).map((item) => Number(item.id)))]
    .filter((id) => Number.isSafeInteger(id) && id > 0), [accounts]);
  const selectedAccountKey = [...selectedIds].sort((left, right) => left - right).join(",");
  taskRef.current = task;

  const loadSettings = useCallback(async () => {
    const requestId = ++settingsRequest.current;
    const initializationKey = selectedAccountKey || "__empty__";
    const initializeForm = settingsInitializationKey.current !== initializationKey;
    setLoadingSettings(true);
    setSettingsError("");
    if (initializeForm) setSettings(null);
    try {
      const [result, taskList] = await Promise.all([
        api("/api/registration/openai-sms/settings"),
        api("/api/registration/openai-sms/tasks?limit=50").catch(() => null),
      ]);
      if (requestId !== settingsRequest.current) return;
      const normalized = settingsObject(result);
      setSettings(normalized);
      const selected = new Set(selectedAccountKey ? selectedAccountKey.split(",") : []);
      const restored = firstArray(taskList?.items, taskList?.tasks)
        .map((item) => normalizeTask(item))
        .find((item) => !item.terminal && item.items.some((account) => selected.has(String(account.accountId))));
      const currentTask = taskRef.current;
      const currentMatchesSelection = Boolean(
        currentTask?.taskId
        && currentTask.items?.some((account) => selected.has(String(account.accountId))),
      );
      const currentActiveMatches = currentMatchesSelection && !currentTask.terminal;
      const effectiveTask = restored || (currentActiveMatches ? currentTask : null);
      if (restored) {
        terminalRefreshTask.current = "";
        if (currentTask?.taskId !== restored.taskId || currentTask.terminal) taskPollRequest.current += 1;
        setTask((current) => current?.taskId === restored.taskId && !current.terminal ? current : restored);
      } else if (initializeForm && currentTask?.taskId && !currentMatchesSelection) {
        taskPollRequest.current += 1;
        setTask(null);
        setEvents([]);
      }
      if (initializeForm) {
        settingsInitializationKey.current = initializationKey;
        countrySelectionReady.current = Boolean(effectiveTask);
        setPaymentConfirmed(false);
        setForm(effectiveTask ? formFromTask(effectiveTask, normalized) : formFromSettings(normalized));
        if (effectiveTask) setCountryReady(true);
      }
    } catch (error) {
      if (requestId !== settingsRequest.current) return;
      setSettings(null);
      setSettingsError(error.message || "OpenAI 接码设置读取失败");
    } finally {
      if (requestId === settingsRequest.current) setLoadingSettings(false);
    }
  }, [selectedAccountKey]);

  const loadLiveCountries = useCallback(async ({ force = false } = {}) => {
    const requestId = ++countriesRequest.current;
    setLoadingCountries(true);
    setCountryError("");
    try {
      const result = await api(`/api/registration/openai-sms/countries${force ? "?refresh=1" : ""}`);
      if (requestId !== countriesRequest.current) return;
      const source = objectValue(result);
      const normalized = firstArray(source.countries, source.items, source.data?.countries)
        .map(normalizeLiveCountry)
        .filter(Boolean)
        .slice(0, 10);
      if (!normalized.length) throw new Error("HeroSMS 未返回可用的实时国家");
      setLiveCountries(normalized);
      setCountryMeta({
        updatedAt: String(firstDefined(source.updated_at, source.refreshed_at, new Date().toISOString())),
        stale: source.stale === true,
        sortLabel: String(firstDefined(source.sort_label, "按质量排序")),
        recommendedId: String(firstDefined(source.recommended_country_id, normalized[0].id)),
        error: String(firstDefined(source.error, "")),
      });
    } catch (error) {
      if (requestId !== countriesRequest.current) return;
      setCountryError(error.message || "HeroSMS 实时国家读取失败");
      setCountryReady(true);
    } finally {
      if (requestId === countriesRequest.current) setLoadingCountries(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      settingsInitializationKey.current = "";
      countrySelectionReady.current = false;
      setSettings(null);
      setLiveCountries([]);
      setCountryMeta(null);
      setCountryError("");
      setCountryReady(false);
      setPaymentConfirmed(false);
      return undefined;
    }
    setCountryReady(false);
    setPaymentConfirmed(false);
    loadSettings();
    loadLiveCountries();
    const timer = window.setInterval(() => loadLiveCountries(), 30_000);
    return () => {
      settingsRequest.current += 1;
      countriesRequest.current += 1;
      window.clearInterval(timer);
    };
  }, [open, selectedAccountKey, loadSettings, loadLiveCountries]);

  const pollTask = useCallback(async () => {
    const taskId = task?.taskId;
    if (!taskId) return;
    const requestId = ++taskPollRequest.current;
    const encoded = encodeURIComponent(taskId);
    try {
      const [taskResult, eventResult] = await Promise.all([
        api(`/api/registration/openai-sms/tasks/${encoded}`),
        api(`/api/registration/openai-sms/tasks/${encoded}/events`).catch(() => null),
      ]);
      if (requestId !== taskPollRequest.current || taskRef.current?.taskId !== taskId) return;
      setTask((current) => current?.taskId === taskId ? normalizeTask(taskResult, current) : current);
      if (eventResult) setEvents(normalizeEvents(eventResult));
      setPollError("");
    } catch (error) {
      if (requestId !== taskPollRequest.current || taskRef.current?.taskId !== taskId) return;
      setPollError(error.message || "接码任务状态刷新失败");
    }
  }, [task?.taskId]);

  useEffect(() => {
    if (!task?.taskId || task.terminal) return undefined;
    let disposed = false;
    let busy = false;
    const poll = async () => {
      if (disposed || busy) return;
      busy = true;
      await pollTask();
      busy = false;
    };
    poll();
    const timer = window.setInterval(poll, 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [task?.taskId, task?.terminal, pollTask]);

  useEffect(() => {
    if (!task?.taskId || !task.terminal || terminalRefreshTask.current === task.taskId) return;
    terminalRefreshTask.current = task.taskId;
    onAccountsChanged?.();
  }, [task?.taskId, task?.terminal, onAccountsChanged]);

  const keyConfigured = Boolean(firstDefined(
    settings?.api_key_configured,
    settings?.key_configured,
    settings?.hero_sms_configured,
    settings?.configured,
    false,
  ));
  const serviceReady = settings?.ready !== false && !settings?.recovery_error;
  const fallbackCountries = useMemo(() => {
    const result = firstArray(settings?.countries, settings?.country_options)
      .map(normalizeCountry)
      .filter(Boolean);
    const current = String(form.country || DEFAULT_FORM.country);
    if (!result.some((item) => item.value === current)) {
      result.push({ value: current, label: /^\d+$/.test(current) ? `HeroSMS 国家 #${current}` : current.toUpperCase() });
    }
    return result;
  }, [settings, form.country]);

  const maxPrice = Number(form.maxPrice);
  const claimTimeoutSeconds = Number(form.claimTimeoutSeconds);
  const waitSeconds = Number(form.waitSeconds);
  const concurrency = Number(form.concurrency);
  const validationError = !selectedIds.length
    ? "请先显式选择至少一个账号"
    : !form.country
      ? "请选择接码国家"
      : !Number.isFinite(maxPrice) || maxPrice <= 0 || maxPrice > 100
        ? "单号最高价应大于 0 且不超过 100"
        : !Number.isSafeInteger(claimTimeoutSeconds) || claimTimeoutSeconds < 30 || claimTimeoutSeconds > 3_600
          ? "抢号时限请输入 30–3600 秒的整数"
          : !Number.isSafeInteger(waitSeconds) || waitSeconds < 30 || waitSeconds > 1_800
            ? "等码时限请输入 30–1800 秒的整数"
            : !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 3
              ? "并发数请输入 1–3 的整数"
              : "";
  const taskMeta = statusMeta(task?.displayStatus || task?.status);
  const activeTask = Boolean(task?.taskId && !task.terminal);
  const displayedItems = taskItemsWithSelected(task, accounts);
  const countryCards = useMemo(() => {
    const current = String(form.country || "");
    if (!current || !liveCountries.length || liveCountries.some((item) => item.id === current)) return liveCountries;
    const fallback = fallbackCountries.find((item) => item.value === current);
    return [{
      id: current,
      numericId: Number(current),
      rank: 0,
      name: fallback?.label || `HeroSMS 国家 #${current}`,
      minPrice: null,
      stock: null,
      deliverability: null,
      outsideTop: true,
    }, ...liveCountries];
  }, [fallbackCountries, form.country, liveCountries]);
  const selectedLiveCountry = liveCountries.find((item) => item.id === String(form.country || "")) || null;
  const selectedCountryPriceHigh = Boolean(
    selectedLiveCountry && Number.isFinite(maxPrice) && selectedLiveCountry.minPrice > maxPrice + 0.000001,
  );

  useEffect(() => {
    if (!open || loadingSettings || !settings || submitting) return;
    if (activeTask || countrySelectionReady.current) {
      setCountryReady(true);
      return;
    }
    if (!liveCountries.length) return;
    const savedId = String(firstDefined(settings.hero_sms_country_id, settings.country_id, form.country, ""));
    const saved = liveCountries.find((item) => item.id === savedId);
    const recommended = liveCountries.find((item) => item.id === String(countryMeta?.recommendedId || ""));
    const affordable = liveCountries.find((item) => !Number.isFinite(maxPrice) || item.minPrice <= maxPrice + 0.000001);
    const selected = saved || recommended || affordable || liveCountries[0];
    countrySelectionReady.current = true;
    setCountryReady(true);
    if (selected && selected.id !== String(form.country || "")) {
      setForm((current) => ({ ...current, country: selected.id }));
    }
  }, [activeTask, countryMeta?.recommendedId, form.country, liveCountries, loadingSettings, maxPrice, open, settings, submitting]);

  const startTask = async () => {
    setActionError("");
    if (validationError) {
      setActionError(validationError);
      return;
    }
    if (!countryReady) {
      setActionError("请等待 HeroSMS 实时国家加载完成");
      return;
    }
    if (!keyConfigured) {
      setActionError("请先配置 HeroSMS API Key");
      return;
    }
    if (!serviceReady) {
      setActionError(settings?.recovery_error || "OpenAI 自动接码服务尚未就绪");
      return;
    }
    if (!paymentConfirmed) {
      setActionError("请确认本次任务会产生 HeroSMS 号码费用");
      return;
    }
    setSubmitting(true);
    setPollError("");
    setEvents([]);
    try {
      const result = await api("/api/registration/openai-sms/tasks", {
        method: "POST",
        body: {
          ids: selectedIds,
          country: form.country,
          max_price: maxPrice,
          claim_timeout_seconds: claimTimeoutSeconds,
          wait_seconds: waitSeconds,
          concurrency,
          browser_mode: form.browserMode,
          payment_confirmed: true,
        },
      });
      const normalized = normalizeTask(result, {
        status: "pending",
        items: taskItemsWithSelected(null, accounts),
        progressTotal: selectedIds.length,
      });
      if (!normalized.taskId) throw new Error("接码服务未返回任务 ID");
      terminalRefreshTask.current = "";
      taskPollRequest.current += 1;
      setTask(normalized);
      setPaymentConfirmed(false);
    } catch (error) {
      setActionError(error.message || "OpenAI 自动接码任务提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  const cancelTask = async () => {
    if (!task?.taskId || task.terminal) return;
    setCancelling(true);
    setActionError("");
    try {
      const result = await api(`/api/registration/openai-sms/tasks/${encodeURIComponent(task.taskId)}/cancel`, {
        method: "POST",
      });
      setTask((current) => normalizeTask(result, {
        ...current,
        status: "cancel_requested",
      }));
      await pollTask();
    } catch (error) {
      setActionError(error.message || "接码任务取消失败");
    } finally {
      setCancelling(false);
    }
  };

  const close = () => {
    if (!submitting && !cancelling) onClose?.();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="OpenAI 自动接码"
      description={`已显式选择 ${selectedIds.length} 个账号；HeroSMS 服务代码固定为 OpenAI (dr)`}
      size="xl"
      footer={<>
        <Button disabled={submitting || cancelling} onClick={close}>关闭</Button>
        {activeTask ? (
          <Button variant="danger" icon={Ban} loading={cancelling} onClick={cancelTask}>取消任务</Button>
        ) : (
          <Button
            variant="primary"
            icon={Smartphone}
            loading={submitting}
            disabled={loadingSettings || !countryReady || !keyConfigured || !serviceReady || Boolean(validationError) || !paymentConfirmed}
            onClick={startTask}
          >
            {task?.taskId ? "再次启动" : "确认付费并启动"}
          </Button>
        )}
      </>}
    >
      <div className="openai-sms-modal">
        {loadingSettings && !settings ? <LoadingBlock rows={4} /> : settingsError ? (
          <div className="openai-sms-settings-error">
            <AlertTriangle size={20} />
            <span><b>接码设置读取失败</b><small>{settingsError}</small></span>
            <Button size="sm" icon={RefreshCw} onClick={loadSettings}>重试</Button>
          </div>
        ) : !keyConfigured ? (
          <div className="openai-sms-key-required">
            <span><KeyRound size={22} /></span>
            <div><b>HeroSMS API Key 尚未配置</b><small>先在系统设置保存 Key；密钥不会在此弹窗回显。</small></div>
            <Button variant="primary" size="sm" icon={Settings2} onClick={onOpenSettings}>前往 HeroSMS 设置</Button>
          </div>
        ) : (
          <div className="openai-sms-config">
            <div className="openai-sms-config-heading">
              <span><Smartphone size={18} /></span>
              <div><b>HeroSMS 自动抢号并接收 OpenAI 短信</b><small>价格超过上限不会购买；每个账号均显示独立执行结果。</small></div>
              <StatusBadge status="active">Key 已配置</StatusBadge>
            </div>
            {!serviceReady && <div className="inline-alert error"><AlertTriangle size={15} /><span>{settings?.recovery_error || "OpenAI 自动接码服务尚未就绪"}</span></div>}
            <section className="openai-sms-country-picker" aria-busy={loadingCountries}>
              <header>
                <div>
                  <b>接码国家</b>
                  <small>HeroSMS OpenAI (dr) 实时成功率排名</small>
                </div>
                <span className="openai-sms-country-badge">实时前 10</span>
                <span className="openai-sms-country-updated">
                  {countryMeta?.sortLabel || "按质量排序"} · {formatRefreshTime(countryMeta?.updatedAt)}
                </span>
                <button
                  type="button"
                  className="openai-sms-country-refresh"
                  aria-label="刷新实时国家"
                  title="立即刷新实时国家"
                  disabled={loadingCountries || activeTask || submitting}
                  onClick={() => loadLiveCountries({ force: true })}
                >
                  <RefreshCw className={loadingCountries ? "spin" : ""} size={14} />
                </button>
              </header>
              {loadingCountries && !countryCards.length ? <LoadingBlock rows={4} /> : countryCards.length ? (
                <div className="openai-sms-country-grid" role="radiogroup" aria-label="HeroSMS 实时前十国家">
                  {countryCards.map((item) => {
                    const selected = item.id === String(form.country || "");
                    return <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      tabIndex={selected ? 0 : -1}
                      className={`openai-sms-country-card${selected ? " selected" : ""}${item.outsideTop ? " outside" : ""}`}
                      key={item.id}
                      disabled={activeTask || submitting}
                      onClick={() => {
                        countrySelectionReady.current = true;
                        setCountryReady(true);
                        setPaymentConfirmed(false);
                        setForm((current) => ({ ...current, country: item.id }));
                      }}
                      onKeyDown={(event) => {
                        if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) return;
                        const radios = [...event.currentTarget.parentElement.querySelectorAll('[role="radio"]:not(:disabled)')];
                        const currentIndex = radios.indexOf(event.currentTarget);
                        if (currentIndex < 0 || !radios.length) return;
                        event.preventDefault();
                        const nextIndex = event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? radios.length - 1
                            : (currentIndex + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + radios.length) % radios.length;
                        radios[nextIndex].focus();
                        radios[nextIndex].click();
                      }}
                    >
                      <span className="openai-sms-country-rank">{item.outsideTop ? "!" : item.rank}</span>
                      {!item.outsideTop && <img
                        src={`https://cdn.hero-sms.com/assets/img/country/${item.numericId}.svg`}
                        alt=""
                        loading="lazy"
                        onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
                      />}
                      <span className="openai-sms-country-name">
                        <b>{item.name}</b>
                        <small>{item.outsideTop ? "已退出实时前十，可重新选择" : `${item.stock.toLocaleString("zh-CN")} 个可用号码`}</small>
                      </span>
                      <span className="openai-sms-country-price">
                        <small>{item.outsideTop ? "当前" : "起"}</small>
                        <b>{item.outsideTop ? "--" : formatUsd(item.minPrice)}</b>
                      </span>
                      {selected && <CheckCircle2 className="openai-sms-country-check" size={15} />}
                    </button>;
                  })}
                </div>
              ) : (
                <div className="openai-sms-country-fallback">
                  <FormField label="备用国家列表" hint="实时排名暂不可用，仍可使用已支持的 HeroSMS 国家">
                    <select value={form.country} disabled={activeTask || submitting} onChange={(event) => {
                      countrySelectionReady.current = true;
                      setCountryReady(true);
                      setPaymentConfirmed(false);
                      setForm((current) => ({ ...current, country: event.target.value }));
                    }}>
                      {fallbackCountries.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </FormField>
                </div>
              )}
              {(countryError || countryMeta?.stale) && <div className="inline-alert warning" role="status" aria-live="polite">
                <AlertTriangle size={15} />
                <span>{countryError || countryMeta?.error || "实时源暂时不可用，当前显示最近一次缓存"}</span>
                <Button size="sm" icon={RefreshCw} disabled={loadingCountries} onClick={() => loadLiveCountries({ force: true })}>重试</Button>
              </div>}
            </section>
            <div className="form-grid three">
              <FormField label="单号最高价 (USD)" hint="实际价格超过此值时继续等待，不会扣费">
                <input type="number" min="0.0001" max="100" step="0.001" value={form.maxPrice} disabled={activeTask || submitting} onChange={(event) => {
                  setPaymentConfirmed(false);
                  setForm({ ...form, maxPrice: event.target.value });
                }} />
              </FormField>
              <FormField label="并发账号" hint="HeroSMS 自动接码最多并发 3 个账号">
                <input type="number" min="1" max="3" step="1" value={form.concurrency} disabled={activeTask || submitting} onChange={(event) => setForm({ ...form, concurrency: event.target.value })} />
              </FormField>
              <FormField label="抢号时限 (秒)" hint="无库存或超价时在此时限内持续重试">
                <input type="number" min="30" max="3600" step="1" value={form.claimTimeoutSeconds} disabled={activeTask || submitting} onChange={(event) => setForm({ ...form, claimTimeoutSeconds: event.target.value })} />
              </FormField>
              <FormField label="等码时限 (秒)" hint="OpenAI 已接受号码后等待短信的最长时间">
                <input type="number" min="30" max="1800" step="1" value={form.waitSeconds} disabled={activeTask || submitting} onChange={(event) => setForm({ ...form, waitSeconds: event.target.value })} />
              </FormField>
              <FormField label="浏览器模式" hint="有头模式便于观察；无头模式在后台运行">
                <select value={form.browserMode} disabled={activeTask || submitting} onChange={(event) => setForm({ ...form, browserMode: event.target.value })}>
                  <option value="camoufox_headed">Camoufox 有头</option>
                  <option value="camoufox_headless">Camoufox 无头</option>
                </select>
              </FormField>
            </div>
            {selectedCountryPriceHigh && <div className="inline-alert warning"><AlertTriangle size={15} /><span>所选国家当前起价 {formatUsd(selectedLiveCountry.minPrice)} 高于价格上限 {formatUsd(maxPrice)}；任务会等待价格降到上限内，不会超价购买。</span></div>}
            {!activeTask && <label className="openai-sms-payment-confirm">
              <input type="checkbox" checked={paymentConfirmed} disabled={submitting} onChange={(event) => setPaymentConfirmed(event.target.checked)} />
              <span><b>确认允许 HeroSMS 产生号码费用</b><small>本批共 {selectedIds.length} 个账号，系统对每次购号强制执行单号 ${Number.isFinite(maxPrice) ? maxPrice : "--"} USD 上限。</small></span>
            </label>}
            {validationError && <div className="inline-alert error"><AlertTriangle size={15} /><span>{validationError}</span></div>}
          </div>
        )}

        {task?.taskId && <section className="openai-sms-task">
          <header>
            <div className="openai-sms-task-title">
              {task.status === "completed" || task.status === "succeeded" || task.status === "success"
                ? <CheckCircle2 size={18} />
                : task.status === "cancelled" || task.status === "canceled"
                  ? <Ban size={18} />
                  : task.terminal
                    ? <AlertTriangle size={18} />
                    : <LoaderCircle className="spin" size={18} />}
              <span><b>任务 {task.taskId}</b><small>{task.progressCurrent} / {task.progressTotal || selectedIds.length} 个账号已处理</small></span>
            </div>
            <StatusBadge status={taskMeta.badge}>{taskMeta.label}</StatusBadge>
          </header>
          {(actionError || pollError || task.error) && <div className="openai-sms-task-error"><AlertTriangle size={15} /><span>{actionError || pollError || task.error}</span></div>}
          <div className="openai-sms-account-list">
            <div className="openai-sms-account-head"><span>账号</span><span>状态</span><span>手机号</span><span>价格</span><span>尝试</span><span>结果</span></div>
            {displayedItems.map((item) => {
              const meta = statusMeta(item.status);
              return <div className={meta.badge === "failed" ? "failed" : ""} key={item.key}>
                <span className="openai-sms-account-email" title={item.email}>{item.email || `账号 ${item.accountId}`}</span>
                <span><StatusBadge status={meta.badge}>{meta.label}</StatusBadge></span>
                <code>{item.maskedPhone || "等待分配"}</code>
                <span>{item.price !== null && item.price !== undefined && item.price !== "" ? `$${item.price}` : "--"}</span>
                <span>{item.attempts}</span>
                <small title={item.error}>{item.error || (item.status === "failed" || item.status === "interrupted" ? "失败" : item.status === "cancelled" || item.status === "canceled" ? "已取消" : TERMINAL_STATUSES.has(item.status) ? "完成" : "执行中")}</small>
              </div>;
            })}
          </div>
          <div className="openai-sms-log-heading"><Clock3 size={15} /><b>任务日志</b><small>{events.length} 条</small></div>
          {events.length ? <div className="registration-log-list openai-sms-log-list">
            {events.map((item) => <div className={item.level === "error" ? "error" : ""} key={item.key}>
              <time>{item.createdAt ? formatDate(item.createdAt) : "--"}</time>
              <span>{item.message}</span>
            </div>)}
          </div> : task.terminal ? <EmptyState icon={Clock3} title="暂无任务日志" /> : <LoadingBlock rows={3} />}
        </section>}

        {!task?.taskId && actionError && <div className="inline-alert error"><AlertTriangle size={15} /><span>{actionError}</span></div>}
      </div>
    </Modal>
  );
}
