import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Cable, Check, CircleStop, ClipboardCopy, Copy, Database, ExternalLink, EyeOff, Fingerprint, Globe2, KeyRound, Link2, ListChecks, LoaderCircle, Mail, Monitor, Network, Pause, Play, RefreshCw, Save, ScrollText, Server, ShieldCheck, SlidersHorizontal, Trash2, UserPlus } from "lucide-react";
import { api } from "../api.js";
import { planAgentIdentityBulk, runAgentIdentityBulk } from "../agent-identity-bulk.js";
import { Button, ConfirmDialog, EmptyState, FormField, IconButton, LoadingBlock, Modal, Pagination, Segmented, StatusBadge, useToast } from "../components.jsx";
import { copyText, formatDate } from "../utils.js";
import {
  accountGroupMeta,
  accountSignalText,
  accountTypeGroupRank,
  accountTypeMeta,
  automaticGroupType,
} from "./registration/account-signals.js";
import {
  AccessTokenCell,
  AccountCommands,
  AccountNameGroup,
  AccountSignalCell,
  JobCommands,
  NfapiBatchImportResult,
  OAuthMailboxPanel,
  OccupiedAliasNotice,
  PasswordCell,
} from "./registration/display.jsx";
import {
  agentIdentityOAuthFallbackCodes,
  agentIdentityResultMessage,
  apiId,
  importFormFromDefaults,
  nfapiAccountState,
  nfapiImportDefaults,
} from "./registration/nfapi-model.js";
import {
  normalizeProxyDraft,
  normalizeProxySample,
  proxySelectLabel,
} from "./registration/proxy-model.js";
import {
  accountPageSizes,
  accountPageSizeStorageKey,
  ageFromBirth,
  baseOptionLabel,
  deletableStatuses,
  initialAccountPageSize,
  jobStatusLabel,
  preferredBase,
  releasableStatuses,
} from "./registration/registration-model.js";

export default function RegistrationPage({ refreshKey, onNavigate, initialMailboxMode = "" }) {
  const [view, setView] = useState("tasks");
  const [options, setOptions] = useState(null);
  const [jobs, setJobs] = useState(null);
  const [queueControl, setQueueControl] = useState(null);
  const [queueAction, setQueueAction] = useState("");
  const [jobActionIds, setJobActionIds] = useState(() => new Set());
  const [accounts, setAccounts] = useState(null);
  const [accountsError, setAccountsError] = useState("");
  const [form, setForm] = useState({ mailboxMode: initialMailboxMode === "inbox_link" ? "inbox_link" : "source", accountId: "", baseAddressId: "", addressMode: "base", count: 1, suffix: "", browserMode: "headed", proxySelection: "auto", autoContinuePostSignup: true, setPasswordAfterRegistration: false, password: "" });
  const [proxyText, setProxyText] = useState("");
  const [proxySaveFeedback, setProxySaveFeedback] = useState(null);
  const [starting, setStarting] = useState(false);
  const [savingProxies, setSavingProxies] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(true);
  const [logJob, setLogJob] = useState(null);
  const [logs, setLogs] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [releaseTarget, setReleaseTarget] = useState(null);
  const [releasing, setReleasing] = useState(false);
  const [selectedJobIds, setSelectedJobIds] = useState([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState([]);
  const [copyingTokenId, setCopyingTokenId] = useState(null);
  const [copyingSelectedTokens, setCopyingSelectedTokens] = useState(false);
  const [checkingAccountSignals, setCheckingAccountSignals] = useState(false);
  const accountSignalRefreshBusy = useRef(false);
  const lastFocusedAccountRefreshAt = useRef(0);
  const [accountGroupFilter, setAccountGroupFilter] = useState("all");
  const [accountPage, setAccountPage] = useState(1);
  const [accountPageSize, setAccountPageSize] = useState(initialAccountPageSize);
  const [editingAccount, setEditingAccount] = useState(null);
  const [accountEditForm, setAccountEditForm] = useState({ custom_name: "", custom_group_name: "" });
  const [savingAccountMetadata, setSavingAccountMetadata] = useState(false);
  const [nfapiImportIds, setNfapiImportIds] = useState([]);
  const [nfapiOptions, setNfapiOptions] = useState(null);
  const [nfapiForm, setNfapiForm] = useState(nfapiImportDefaults);
  const [nfapiImportMode, setNfapiImportMode] = useState("agent_identity");
  const [nfapiAgentIdentityFallback, setNfapiAgentIdentityFallback] = useState("");
  const [loadingNfapiOptions, setLoadingNfapiOptions] = useState(false);
  const [importingNfapi, setImportingNfapi] = useState(false);
  const [nfapiBatchProgress, setNfapiBatchProgress] = useState(null);
  const [restartingNfapiOAuth, setRestartingNfapiOAuth] = useState(false);
  const [nfapiImportResult, setNfapiImportResult] = useState(null);
  const [nfapiBatchResult, setNfapiBatchResult] = useState(null);
  const [nfapiAccountSnapshot, setNfapiAccountSnapshot] = useState(null);
  const [nfapiOAuthSession, setNfapiOAuthSession] = useState(null);
  const [nfapiOAuthNow, setNfapiOAuthNow] = useState(() => Date.now());
  const [nfapiCallbackUrl, setNfapiCallbackUrl] = useState("");
  const [nfapiMailboxOpen, setNfapiMailboxOpen] = useState(false);
  const [nfapiMailboxData, setNfapiMailboxData] = useState(null);
  const [nfapiMailboxLoading, setNfapiMailboxLoading] = useState(false);
  const [nfapiMailboxError, setNfapiMailboxError] = useState("");
  const [nfapiMailboxUpdatedAt, setNfapiMailboxUpdatedAt] = useState("");
  const registrationOptionsRequest = useRef(0);
  const registrationJobsRequest = useRef(0);
  const registrationAccountsRequest = useRef(0);
  const nfapiOptionsRequest = useRef(0);
  const nfapiMailboxRequest = useRef(0);
  const nfapiMailboxBusy = useRef(false);
  const [passwordSetupTarget, setPasswordSetupTarget] = useState(null);
  const [passwordSetupValue, setPasswordSetupValue] = useState("");
  const [passwordSetupTask, setPasswordSetupTask] = useState(null);
  const [passwordSetupEvents, setPasswordSetupEvents] = useState([]);
  const [startingPasswordSetup, setStartingPasswordSetup] = useState(false);
  const [proxyInspectIndex, setProxyInspectIndex] = useState("");
  const [inspectingProxy, setInspectingProxy] = useState(false);
  const [proxyInspection, setProxyInspection] = useState(null);
  const [proxyInspectionError, setProxyInspectionError] = useState("");
  const toast = useToast();
  const nfapiMailboxAccountId = nfapiImportIds[0];

  const loadOptions = useCallback(async () => {
    const requestId = ++registrationOptionsRequest.current;
    const data = await api("/api/registration/options");
    if (requestId !== registrationOptionsRequest.current) return null;
    setOptions(data);
    setProxyText((current) => current || (data.proxies || []).join("\n"));
    setForm((current) => {
      const accountId = current.accountId || String(data.accounts[0]?.id || "");
      const account = data.accounts.find((item) => String(item.id) === accountId) || data.accounts[0];
      const validBase = account?.bases.some((item) => String(item.id) === current.baseAddressId);
      const proxyMatch = current.proxySelection?.match(/^proxy:(\d+)$/);
      const proxySelection = proxyMatch && Number(proxyMatch[1]) >= data.proxies.length ? "auto" : (current.proxySelection || "auto");
      const direct = account?.registration_mode === "direct";
      return {
        ...current,
        accountId,
        baseAddressId: validBase ? current.baseAddressId : String(preferredBase(account)?.id || ""),
        count: direct && current.mailboxMode !== "inbox_link" ? 1 : current.count,
        suffix: direct ? "" : current.suffix,
        proxySelection,
      };
    });
    setProxyInspectIndex((current) => current !== "" && Number(current) < data.proxies.length ? current : (data.proxies.length ? "0" : ""));
    return data;
  }, []);

  useEffect(() => {
    if (initialMailboxMode !== "inbox_link") return;
    setForm((current) => ({ ...current, mailboxMode: "inbox_link" }));
  }, [initialMailboxMode]);

  const loadJobs = useCallback(async () => {
    const requestId = ++registrationJobsRequest.current;
    try {
      const result = await api("/api/registration/jobs?limit=500");
      if (requestId !== registrationJobsRequest.current) return null;
      setJobs(result.items);
      return result.items;
    } catch (error) {
      if (requestId !== registrationJobsRequest.current) return null;
      toast(error.message, "error");
      return null;
    }
  }, [toast]);

  const loadQueueControl = useCallback(async () => {
    try {
      const result = await api("/api/registration/queue/control");
      setQueueControl(result);
      return result;
    } catch {
      setQueueControl(null);
      return null;
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    const requestId = ++registrationAccountsRequest.current;
    try {
      const data = await api("/api/registration/accounts");
      if (requestId !== registrationAccountsRequest.current) return null;
      setAccounts(data);
      setAccountsError("");
      return data;
    } catch (error) {
      if (requestId !== registrationAccountsRequest.current) return null;
      setAccounts((current) => current || { total: 0, items: [] });
      setAccountsError(error.message || "注册账号加载失败");
      return null;
    }
  }, []);

  const refreshRegistrationData = useCallback(async () => {
    await Promise.all([loadJobs(), loadQueueControl()]);
    await Promise.all([loadOptions(), loadAccounts()]);
  }, [loadJobs, loadQueueControl, loadOptions, loadAccounts]);

  useEffect(() => () => {
    registrationOptionsRequest.current += 1;
    registrationJobsRequest.current += 1;
    registrationAccountsRequest.current += 1;
  }, []);

  const loadNfapiMailbox = useCallback(async ({ background = false } = {}) => {
    if (!nfapiMailboxAccountId || nfapiMailboxBusy.current) return;
    const requestId = ++nfapiMailboxRequest.current;
    nfapiMailboxBusy.current = requestId;
    setNfapiMailboxLoading(true);
    if (!background) setNfapiMailboxError("");
    try {
      const result = await api(`/api/registration/accounts/${nfapiMailboxAccountId}/emails?top=20`);
      if (requestId !== nfapiMailboxRequest.current) return;
      setNfapiMailboxData(result);
      setNfapiMailboxError("");
      setNfapiMailboxUpdatedAt(new Date().toISOString());
    } catch (error) {
      if (requestId === nfapiMailboxRequest.current) setNfapiMailboxError(error.message || "邮箱刷新失败");
    } finally {
      if (nfapiMailboxBusy.current === requestId) nfapiMailboxBusy.current = false;
      if (requestId === nfapiMailboxRequest.current) setNfapiMailboxLoading(false);
    }
  }, [nfapiMailboxAccountId]);

  useEffect(() => {
    refreshRegistrationData().catch((error) => toast(error.message, "error"));
  }, [refreshRegistrationData, refreshKey, toast]);

  useEffect(() => {
    if (!nfapiOAuthSession?.oauth_session_id || !nfapiMailboxOpen) return undefined;
    loadNfapiMailbox();
    const timer = window.setInterval(() => loadNfapiMailbox({ background: true }), 4_000);
    return () => {
      window.clearInterval(timer);
      nfapiMailboxRequest.current += 1;
      nfapiMailboxBusy.current = false;
      setNfapiMailboxLoading(false);
    };
  }, [nfapiOAuthSession?.oauth_session_id, nfapiMailboxOpen, loadNfapiMailbox]);

  useEffect(() => {
    if (!nfapiOAuthSession?.oauth_session_id) return undefined;
    setNfapiOAuthNow(Date.now());
    const timer = window.setInterval(() => setNfapiOAuthNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [nfapiOAuthSession?.oauth_session_id]);

  useEffect(() => {
    const active = jobs?.some((item) => releasableStatuses.has(item.status));
    if (!active) return undefined;
    const timer = window.setInterval(() => {
      refreshRegistrationData().catch((error) => toast(error.message, "error"));
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [jobs, refreshRegistrationData, toast]);

  useEffect(() => {
    if (!jobs) return;
    const available = new Set(jobs.filter((item) => deletableStatuses.has(item.status)).map((item) => item.id));
    setSelectedJobIds((current) => current.filter((id) => available.has(id)));
  }, [jobs]);

  useEffect(() => {
    if (!accounts) return;
    const available = new Set(accounts.items.map((item) => item.id));
    setSelectedAccountIds((current) => current.filter((id) => available.has(id)));
  }, [accounts]);

  useEffect(() => {
    if (!passwordSetupTarget || !passwordSetupTask?.task_id || passwordSetupTask.terminal) return undefined;
    let disposed = false;
    const poll = async () => {
      try {
        const result = await api(`/api/registration/accounts/${passwordSetupTarget.id}/set-password/${encodeURIComponent(passwordSetupTask.task_id)}`);
        if (disposed) return;
        setPasswordSetupTask(result);
        setPasswordSetupEvents(result.events || []);
        if (result.terminal) {
          if (result.status === "completed" && result.password_available) {
            toast("原邮箱二次验证完成，密码已设置");
            await loadAccounts();
          } else {
            toast(result.error || "设置密码任务未完成", "error");
          }
        }
      } catch (error) {
        if (disposed) return;
        setPasswordSetupTask((current) => ({ ...current, terminal: true, status: "failed", error: error.message }));
        toast(error.message, "error");
      }
    };
    poll();
    const timer = window.setInterval(poll, 3_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [passwordSetupTarget, passwordSetupTask?.task_id, passwordSetupTask?.terminal, loadAccounts, toast]);

  const selectedAccount = useMemo(() => options?.accounts.find((item) => String(item.id) === form.accountId), [options, form.accountId]);
  const selectedBase = useMemo(() => selectedAccount?.bases.find((item) => String(item.id) === form.baseAddressId), [selectedAccount, form.baseAddressId]);
  const proxyDraft = useMemo(() => normalizeProxyDraft(proxyText), [proxyText]);
  const activeJobs = jobs?.filter((item) => releasableStatuses.has(item.status) && item.status !== "paused").length || 0;
  const deletableJobIds = jobs?.filter((item) => deletableStatuses.has(item.status)).map((item) => item.id) || [];
  const allJobsSelected = deletableJobIds.length > 0 && deletableJobIds.every((id) => selectedJobIds.includes(id));
  const accountGroups = useMemo(() => {
    const groups = new Map();
    for (const item of accounts?.items || []) {
      const group = accountGroupMeta(item);
      if (!group.name) continue;
      const current = groups.get(group.name) || {
        name: group.name,
        count: 0,
        automaticCount: 0,
        rank: Number.POSITIVE_INFINITY,
      };
      current.count += 1;
      if (group.automatic) {
        current.automaticCount += 1;
        current.rank = Math.min(
          current.rank,
          accountTypeGroupRank.get(automaticGroupType(item, group.name)) ?? accountTypeGroupRank.get("unknown"),
        );
      }
      groups.set(group.name, current);
    }
    return [...groups.values()].sort((left, right) => left.rank - right.rank
      || left.name.localeCompare(right.name, "zh-CN"));
  }, [accounts]);
  const customAccountGroups = useMemo(() => [...new Set((accounts?.items || [])
    .map((item) => accountGroupMeta(item).customName)
    .filter(Boolean))].sort((left, right) => left.localeCompare(right, "zh-CN")), [accounts]);
  const ungroupedAccountCount = useMemo(() => (accounts?.items || [])
    .filter((item) => !accountGroupMeta(item).name).length, [accounts]);
  const visibleAccountItems = useMemo(() => {
    const items = accounts?.items || [];
    if (accountGroupFilter === "all") return items;
    if (accountGroupFilter === "ungrouped") return items.filter((item) => !accountGroupMeta(item).name);
    const groupName = accountGroupFilter.startsWith("group:") ? accountGroupFilter.slice(6) : "";
    return items.filter((item) => accountGroupMeta(item).name === groupName);
  }, [accounts, accountGroupFilter]);
  const accountPages = Math.max(1, Math.ceil(visibleAccountItems.length / accountPageSize));
  const safeAccountPage = Math.min(accountPage, accountPages);
  const accountPageOffset = (safeAccountPage - 1) * accountPageSize;
  const pagedAccountItems = useMemo(
    () => visibleAccountItems.slice(accountPageOffset, accountPageOffset + accountPageSize),
    [visibleAccountItems, accountPageOffset, accountPageSize],
  );
  const accountIds = pagedAccountItems.map((item) => item.id);
  const allAccountsSelected = accountIds.length > 0 && accountIds.every((id) => selectedAccountIds.includes(id));
  const selectedAccounts = (accounts?.items || []).filter((item) => selectedAccountIds.includes(item.id));
  const accountRangeStart = visibleAccountItems.length ? accountPageOffset + 1 : 0;
  const accountRangeEnd = Math.min(accountPageOffset + pagedAccountItems.length, visibleAccountItems.length);

  useEffect(() => {
    setAccountPage((current) => Math.min(Math.max(1, current), accountPages));
  }, [accountPages]);

  useEffect(() => {
    try { window.localStorage.setItem(accountPageSizeStorageKey, String(accountPageSize)); } catch { /* storage can be disabled */ }
  }, [accountPageSize]);

  const changeAccount = (accountId) => {
    const account = options.accounts.find((item) => String(item.id) === accountId);
    const direct = account?.registration_mode === "direct";
    setForm((current) => ({
      ...current,
      accountId,
      baseAddressId: String(preferredBase(account)?.id || ""),
      count: direct ? 1 : current.count,
      suffix: direct ? "" : current.suffix,
    }));
  };

  const start = async () => {
    setStarting(true);
    try {
      const response = await api("/api/registration/jobs", { method: "POST", body: form });
      const submitted = response.items.filter((item) => item.status !== "failed").length;
      toast(`已创建 ${response.items.length} 个邮箱，提交 ${submitted} 个注册任务`);
      setView("tasks");
      await refreshRegistrationData();
    } catch (error) { toast(error.message, "error"); } finally { setStarting(false); }
  };

  const saveProxies = async () => {
    if (proxyDraft.errors.length) {
      setProxySaveFeedback({ type: "error", message: `有 ${proxyDraft.errors.length} 行格式错误，请按行修正后再保存` });
      toast(`代理池有 ${proxyDraft.errors.length} 行格式错误`, "error");
      return;
    }
    setSavingProxies(true);
    try {
      const result = await api("/api/registration/proxies", { method: "PUT", body: { proxies: proxyDraft.proxies } });
      const savedProxies = Array.isArray(result.proxies) ? result.proxies : [];
      const maskedProxies = Array.isArray(result.masked) && result.masked.length === savedProxies.length
        ? result.masked
        : savedProxies.map((_, index) => `代理 ${index + 1}`);
      const returnedMetadata = Array.isArray(result.proxyMetadata) ? result.proxyMetadata : result.metadata;
      const proxyMetadata = Array.isArray(returnedMetadata) && returnedMetadata.length === savedProxies.length
        ? returnedMetadata
        : savedProxies.map(() => null);
      setProxyText(savedProxies.join("\n"));
      setOptions((current) => ({ ...current, proxies: savedProxies, maskedProxies, proxyMetadata }));
      setForm((current) => {
        const match = current.proxySelection?.match(/^proxy:(\d+)$/);
        return match && Number(match[1]) >= savedProxies.length ? { ...current, proxySelection: "auto" } : current;
      });
      setProxyInspectIndex((current) => {
        if (!savedProxies.length) return "";
        const index = Number(current);
        return Number.isInteger(index) && index >= 0 && index < savedProxies.length ? String(index) : "0";
      });
      setProxyInspection(null);
      setProxyInspectionError("");
      const notes = [];
      if (proxyDraft.duplicateLines.length) notes.push(`已忽略 ${proxyDraft.duplicateLines.length} 条重复地址`);
      const message = `已保存 ${savedProxies.length} 条代理${notes.length ? `；${notes.join("；")}` : ""}`;
      setProxySaveFeedback({ type: "success", message });
      toast(message);
      loadOptions().catch(() => {});
    } catch (error) {
      const rejectedIndex = String(error.message || "").match(/第\s*(\d+)\s*条/);
      const sourceLine = rejectedIndex ? proxyDraft.sourceLines[Number(rejectedIndex[1]) - 1] : null;
      const message = sourceLine
        ? `第 ${sourceLine} 行未被服务端接受，请检查协议、认证信息、主机和端口`
        : (error.message || "代理池保存失败");
      setProxySaveFeedback({ type: "error", message });
      toast(message, "error");
    } finally { setSavingProxies(false); }
  };

  const cancel = async (id) => {
    try { await api(`/api/registration/jobs/${id}/cancel`, { method: "POST" }); toast("注册任务已取消"); await refreshRegistrationData(); }
    catch (error) { toast(error.message, "error"); }
  };

  const setJobAction = (id, active) => {
    setJobActionIds((current) => {
      const next = new Set(current);
      if (active) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const controlJob = async (job, action) => {
    if (!job?.id || jobActionIds.has(job.id)) return;
    setJobAction(job.id, true);
    try {
      const result = await api(`/api/registration/jobs/${job.id}/${action}`, { method: "POST" });
      const stillPaused = result.item?.status === "paused";
      toast(action === "pause"
        ? `${job.email} 已暂停后续注册`
        : stillPaused ? "注册队列仍处于全部暂停状态，请先点击“继续全部”" : `${job.email} 已继续注册`,
      stillPaused && action === "resume" ? "error" : "success");
      await Promise.all([loadJobs(), loadQueueControl()]);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setJobAction(job.id, false);
    }
  };

  const controlQueue = async (action) => {
    if (queueAction) return;
    setQueueAction(action);
    try {
      const result = await api(`/api/registration/queue/${action}`, { method: "POST" });
      setQueueControl(result);
      toast(action === "pause" ? "全部注册任务已暂停" : "注册队列已继续");
      await loadJobs();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setQueueAction("");
    }
  };

  const releaseJob = async () => {
    if (!releaseTarget) return;
    setReleasing(true);
    try {
      const result = await api(`/api/registration/jobs/${releaseTarget.id}/release`, { method: "POST" });
      const label = result.item?.status === "cancelled" ? "已取消并释放" : "已强制释放";
      toast(`${releaseTarget.email} ${label}`);
      setReleaseTarget(null);
      await refreshRegistrationData();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setReleasing(false);
    }
  };

  const removeSelected = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      if (deleteTarget.kind === "job") {
        await api(`/api/registration/jobs/${deleteTarget.ids[0]}`, { method: "DELETE" });
        toast("注册记录已删除");
        setSelectedJobIds((current) => current.filter((id) => !deleteTarget.ids.includes(id)));
      } else if (deleteTarget.kind === "jobs") {
        const result = await api("/api/registration/jobs/bulk-delete", { method: "POST", body: { ids: deleteTarget.ids } });
        toast(`已删除 ${result.deleted} 条注册记录`);
        setSelectedJobIds([]);
      } else {
        const result = deleteTarget.kind === "account"
          ? await api(`/api/registration/accounts/${deleteTarget.ids[0]}`, { method: "DELETE" })
          : await api("/api/registration/accounts/bulk-delete", { method: "POST", body: { ids: deleteTarget.ids } });
        const failed = result.failed?.length || 0;
        toast(failed ? `已删除 ${result.deleted} 个账号，${failed} 个失败` : `已删除 ${result.deleted} 个注册账号`, failed ? "error" : "success");
        setSelectedAccountIds((current) => current.filter((id) => !deleteTarget.ids.includes(id)));
      }
      setDeleteTarget(null);
      await refreshRegistrationData();
    } catch (error) { toast(error.message, "error"); } finally { setDeleting(false); }
  };

  const toggleJob = (id) => setSelectedJobIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const toggleAllJobs = () => setSelectedJobIds(allJobsSelected ? [] : deletableJobIds);
  const toggleAccount = (id) => {
    if (importingNfapi) return;
    setSelectedAccountIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };
  const toggleAllAccounts = () => {
    if (importingNfapi) return;
    setSelectedAccountIds(allAccountsSelected ? [] : accountIds);
  };
  const changeAccountGroupFilter = (value) => {
    if (importingNfapi) return;
    setAccountGroupFilter(value);
    setAccountPage(1);
    setSelectedAccountIds([]);
  };
  const changeAccountPage = (value) => {
    if (importingNfapi) return;
    setAccountPage(Math.min(Math.max(1, Number(value) || 1), accountPages));
    setSelectedAccountIds([]);
  };
  const changeAccountPageSize = (value) => {
    if (importingNfapi) return;
    const size = Number(value);
    if (!accountPageSizes.includes(size)) return;
    setAccountPageSize(size);
    setAccountPage(1);
    setSelectedAccountIds([]);
  };

  const refreshAccountSignals = useCallback(async (ids, { notify = true } = {}) => {
    const normalizedIds = [...new Set((ids || []).map(Number).filter(Number.isSafeInteger))];
    if (!normalizedIds.length || accountSignalRefreshBusy.current) return null;
    accountSignalRefreshBusy.current = true;
    setCheckingAccountSignals(true);
    try {
      const result = await api("/api/registration/accounts/refresh-status", {
        method: "POST",
        body: { ids: normalizedIds },
      });
      if (!result.accounts || !Array.isArray(result.accounts.items)) {
        throw new Error("状态检测服务未返回账号列表");
      }
      setAccounts(result.accounts);
      setAccountsError("");
      const typeSummary = Object.entries(result.types || {})
        .filter(([, count]) => Number(count) > 0)
        .map(([type, count]) => `${accountTypeMeta({ account_type: type }).label} ${count}`)
        .join(" / ");
      const statusSummary = `可用 ${result.available || 0}，确认失效 ${result.unavailable || 0}，待检测 ${result.unchecked || 0}`;
      const failureSummary = result.failed ? `；${result.failed} 个检测失败，已保留原状态和类型` : "";
      if (notify) {
        toast(`检测完成：${statusSummary}${typeSummary ? `；类型 ${typeSummary}` : ""}${failureSummary}`, result.failed ? "error" : "success");
      }
      return result;
    } catch (error) {
      if (notify) toast(error.message || "账号状态检测失败", "error");
      return null;
    } finally {
      accountSignalRefreshBusy.current = false;
      setCheckingAccountSignals(false);
    }
  }, [toast]);

  const refreshSelectedAccountSignals = useCallback(() => {
    const ids = selectedAccountIds.length
      ? selectedAccountIds
      : visibleAccountItems.map((item) => item.id);
    return refreshAccountSignals(ids);
  }, [selectedAccountIds, visibleAccountItems, refreshAccountSignals]);

  useEffect(() => {
    if (view !== "accounts" || !accounts?.items?.length) return undefined;
    const refreshOnReturn = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastFocusedAccountRefreshAt.current < 30_000) return;
      const ids = accounts.items
        .filter((item) => {
          const type = accountTypeMeta(item).type;
          const availability = accountSignalText(item, ["availability", "availability_status", "availabilityStatus"], 40).toLowerCase();
          return availability !== "unavailable" && (type === "free" || type === "unknown");
        })
        .map((item) => Number(item.id))
        .filter(Number.isSafeInteger);
      if (!ids.length) return;
      lastFocusedAccountRefreshAt.current = now;
      refreshAccountSignals(ids, { notify: false });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshOnReturn();
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [view, accounts, refreshAccountSignals]);

  const openAccountEditor = (item) => {
    setEditingAccount(item);
    setAccountEditForm({
      custom_name: item.custom_name || "",
      custom_group_name: accountGroupMeta(item).customName,
    });
  };

  const saveAccountMetadata = async () => {
    if (!editingAccount) return;
    setSavingAccountMetadata(true);
    try {
      await api(`/api/registration/accounts/${editingAccount.id}`, {
        method: "PATCH",
        body: {
          custom_name: accountEditForm.custom_name,
          group_name: accountEditForm.custom_group_name,
        },
      });
      toast("账号名称和自定义分组已保存");
      setEditingAccount(null);
      await loadAccounts();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setSavingAccountMetadata(false);
    }
  };

  const openPasswordSetup = (item) => {
    if (!item.password_setup_available) {
      toast(item.password_setup_reason || "这个账号无法从原邮箱补设密码", "error");
      return;
    }
    setPasswordSetupTarget(item);
    setPasswordSetupValue("");
    setPasswordSetupTask(null);
    setPasswordSetupEvents([]);
  };

  const closePasswordSetup = () => {
    if (startingPasswordSetup || (passwordSetupTask && !passwordSetupTask.terminal)) return;
    setPasswordSetupTarget(null);
    setPasswordSetupValue("");
    setPasswordSetupTask(null);
    setPasswordSetupEvents([]);
  };

  const startPasswordSetup = async () => {
    if (!passwordSetupTarget) return;
    setStartingPasswordSetup(true);
    try {
      const result = await api(`/api/registration/accounts/${passwordSetupTarget.id}/set-password`, {
        method: "POST",
        body: { password: passwordSetupValue },
      });
      setPasswordSetupTask(result);
      setPasswordSetupEvents([]);
      setPasswordSetupValue("");
      toast("已启动原邮箱密码设置任务");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setStartingPasswordSetup(false);
    }
  };

  const cancelPasswordSetup = async () => {
    if (!passwordSetupTarget || !passwordSetupTask?.task_id) return;
    try {
      const result = await api(`/api/registration/accounts/${passwordSetupTarget.id}/set-password/${encodeURIComponent(passwordSetupTask.task_id)}/cancel`, { method: "POST" });
      setPasswordSetupTask(result);
      toast("已请求取消设置密码任务");
    } catch (error) {
      toast(error.message, "error");
    }
  };

  const resetNfapiMailbox = (open = false) => {
    nfapiMailboxRequest.current += 1;
    nfapiMailboxBusy.current = false;
    setNfapiMailboxOpen(open);
    setNfapiMailboxData(null);
    setNfapiMailboxLoading(false);
    setNfapiMailboxError("");
    setNfapiMailboxUpdatedAt("");
  };

  const openNfapiImporter = async (ids) => {
    const requestedIds = [...new Set((Array.isArray(ids) ? ids : [])
      .map((id) => String(id ?? "").trim())
      .filter(Boolean))];
    const accountById = new Map((accounts?.items || []).map((item) => [String(item.id), item]));
    const targets = requestedIds.map((id) => accountById.get(id)).filter((item) => item?.id && item.email);
    if (!targets.length) {
      toast("选择的注册账号已不存在，请刷新后重试", "error");
      return;
    }
    if (targets.length !== requestedIds.length) {
      toast(`已跳过 ${requestedIds.length - targets.length} 个不存在的注册账号`, "error");
    }
    const requestId = ++nfapiOptionsRequest.current;
    setNfapiImportIds(targets.map((item) => item.id));
    setNfapiAccountSnapshot(targets.length === 1 ? targets[0] : null);
    setNfapiOptions(null);
    setNfapiImportResult(null);
    setNfapiBatchResult(null);
    setNfapiBatchProgress(null);
    setNfapiImportMode("agent_identity");
    setNfapiAgentIdentityFallback("");
    setNfapiOAuthSession(null);
    setNfapiCallbackUrl("");
    resetNfapiMailbox();
    setLoadingNfapiOptions(true);
    try {
      const result = await api("/api/nfapi/options");
      if (requestId !== nfapiOptionsRequest.current) return;
      setNfapiOptions(result);
      setNfapiForm(importFormFromDefaults(result.defaults));
    } catch (error) {
      if (requestId !== nfapiOptionsRequest.current) return;
      setNfapiOptions({ connection: { connected: false }, groups: [], proxies: [], error: error.message });
      toast(error.message, "error");
    } finally {
      if (requestId === nfapiOptionsRequest.current) setLoadingNfapiOptions(false);
    }
  };

  const closeNfapiImporter = () => {
    if (importingNfapi || restartingNfapiOAuth) return;
    nfapiOptionsRequest.current += 1;
    setNfapiImportIds([]);
    setNfapiOptions(null);
    setNfapiImportResult(null);
    setNfapiBatchResult(null);
    setNfapiBatchProgress(null);
    setNfapiAccountSnapshot(null);
    setNfapiImportMode("agent_identity");
    setNfapiAgentIdentityFallback("");
    setNfapiOAuthSession(null);
    setNfapiCallbackUrl("");
    resetNfapiMailbox();
  };

  const selectNfapiImportMode = (mode) => {
    if (!["agent_identity", "oauth"].includes(mode)
      || importingNfapi
      || restartingNfapiOAuth
      || nfapiOAuthSession
      || nfapiImportResult
      || nfapiBatchResult) return;
    if (nfapiImportIds.length > 1 && mode !== "agent_identity") {
      toast("批量导入仅支持 Agent Identity；OAuth 需逐个账号授权", "error");
      return;
    }
    setNfapiImportMode(mode);
    setNfapiAgentIdentityFallback("");
    setNfapiOAuthSession(null);
    setNfapiCallbackUrl("");
    resetNfapiMailbox();
    setNfapiImportResult(null);
  };

  const parseJsonField = (label, value, expected) => {
    let parsed;
    try {
      parsed = JSON.parse(String(value || (expected === "array" ? "[]" : "{}")));
    } catch {
      throw new Error(`${label}不是有效的 JSON`);
    }
    if (expected === "array" && !Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 数组`);
    if (expected === "object" && (!parsed || Array.isArray(parsed) || typeof parsed !== "object")) throw new Error(`${label}必须是 JSON 对象`);
    return parsed;
  };

  const buildNfapiOptionsPayload = () => {
    const percent = (label, value) => {
      if (value === "" || value === null || value === undefined) return null;
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0.01 || number > 100) throw new Error(`${label}必须在 0.01 到 100 之间`);
      return number;
    };
    const number = (label, value, minimum, maximum, integer = false) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum || (integer && !Number.isInteger(parsed))) {
        throw new Error(`${label}必须在 ${minimum} 到 ${maximum} 之间${integer ? "且为整数" : ""}`);
      }
      return parsed;
    };
    return {
      name_prefix: nfapiForm.name_prefix.trim(),
      account_name: nfapiImportIds.length === 1 ? nfapiForm.account_name.trim() : "",
      notes: nfapiForm.notes.trim(),
      status: nfapiForm.status,
      model_mapping: parseJsonField("模型映射", nfapiForm.model_mapping, "object"),
      proxy_id: nfapiForm.proxy_id === "" ? null : apiId(nfapiForm.proxy_id),
      concurrency: number("并发数", nfapiForm.concurrency, 1, 1000, true),
      load_factor: number("负载系数", nfapiForm.load_factor, 1, 10000, true),
      priority: number("优先级", nfapiForm.priority, 0, 10000, true),
      rate_multiplier: number("计费倍率", nfapiForm.rate_multiplier, 0, 1000),
      expires_at: nfapiImportMode === "agent_identity" ? null : (nfapiForm.expires_at || null),
      auto_pause_on_expired: nfapiImportMode === "agent_identity"
        ? false
        : Boolean(nfapiForm.auto_pause_on_expired),
      temp_unschedulable_enabled: Boolean(nfapiForm.temp_unschedulable_enabled),
      temp_unschedulable_rules: parseJsonField("临时不可调度规则", nfapiForm.temp_unschedulable_rules, "array"),
      ws_mode: nfapiForm.ws_mode,
      openai_passthrough: Boolean(nfapiForm.openai_passthrough),
      codex_cli_only: Boolean(nfapiForm.codex_cli_only),
      allow_app_server: Boolean(nfapiForm.codex_cli_only && nfapiForm.allow_app_server),
      compact_mode: nfapiForm.compact_mode,
      compact_model_mapping: parseJsonField("Compact 模型映射", nfapiForm.compact_model_mapping, "object"),
      image_bridge_mode: nfapiForm.image_bridge_mode,
      auto_pause_5h_disabled: Boolean(nfapiForm.auto_pause_5h_disabled),
      auto_pause_5h_threshold: percent("5h 用量阈值", nfapiForm.auto_pause_5h_threshold),
      auto_pause_7d_disabled: Boolean(nfapiForm.auto_pause_7d_disabled),
      auto_pause_7d_threshold: percent("7d 用量阈值", nfapiForm.auto_pause_7d_threshold),
      group_ids: nfapiForm.group_ids.map(apiId),
      update_existing: Boolean(nfapiForm.update_existing),
      skip_default_group_bind: Boolean(nfapiForm.skip_default_group_bind),
      confirm_mixed_channel_risk: Boolean(nfapiForm.confirm_mixed_channel_risk),
    };
  };

  const submitNfapiImport = async () => {
    const isBatch = nfapiImportIds.length > 1;
    if (!nfapiImportIds.length || (!isBatch && (!nfapiSelectedAccount?.id || !nfapiSelectedAccount?.email))) {
      toast("NFapi 目标账号已不存在，请关闭后重新选择", "error");
      return;
    }
    if (nfapiImportMode === "agent_identity") {
      const batchPlan = isBatch ? planAgentIdentityBulk(accounts?.items || [], nfapiImportIds) : null;
      if (isBatch && !batchPlan.actionable.length) {
        toast("所选账号没有可批量导入的 Agent Identity，请处理提示项后重试", "error");
        return;
      }
      if (!isBatch && !nfapiSelectedAccount.access_token_available) {
        toast("当前账号没有可用 Access Token，请切换到 OAuth 授权", "error");
        return;
      }
      let optionsPayload;
      try {
        optionsPayload = buildNfapiOptionsPayload();
      } catch (error) {
        toast(error.message, "error");
        return;
      }
      setImportingNfapi(true);
      setNfapiImportResult(null);
      setNfapiBatchResult(null);
      setNfapiBatchProgress(null);
      try {
        if (isBatch) {
          const retainedIds = new Set(batchPlan.blocked.map((item) => String(item.id)));
          const processedIds = new Set(batchPlan.ids);
          let defaultsSaved = false;
          const result = await runAgentIdentityBulk(batchPlan.actionable, {
            importAccount: async (target) => {
              const saveDefaults = Boolean(nfapiForm.save_defaults) && !defaultsSaved;
              const imported = await api(`/api/registration/accounts/${target.id}/nfapi-agent-identity/import`, {
                method: "POST",
                body: { options: optionsPayload, save_defaults: saveDefaults },
              });
              if (saveDefaults) defaultsSaved = true;
              return imported;
            },
            onProgress: setNfapiBatchProgress,
          });
          result.failedIds.forEach((id) => retainedIds.add(String(id)));
          const failures = [
            ...batchPlan.blocked.map((item) => ({ id: String(item.id), message: item.reason })),
            ...result.errors,
          ];
          const batchResult = {
            total: batchPlan.total,
            created: result.created,
            updated: result.updated,
            skipped: result.skipped,
            failed: result.failed + batchPlan.blocked.length,
            errors: failures,
          };
          setNfapiBatchResult(batchResult);
          setSelectedAccountIds((current) => current.filter((id) => (
            !processedIds.has(String(id)) || retainedIds.has(String(id))
          )));
          await loadAccounts();
          const succeeded = batchResult.created + batchResult.updated;
          const summary = [`新增 ${batchResult.created}`, `更新 ${batchResult.updated}`, `已存在 ${batchResult.skipped}`, `需处理 ${batchResult.failed}`].join("，");
          const firstFailure = failures[0]?.message || "";
          toast(
            `批量导入完成：${summary}${batchResult.failed && firstFailure ? `；${firstFailure}` : ""}`,
            batchResult.failed ? "error" : "success",
          );
          return;
        }
        const result = await api(`/api/registration/accounts/${nfapiImportIds[0]}/nfapi-agent-identity/import`, {
          method: "POST",
          body: { options: optionsPayload, save_defaults: Boolean(nfapiForm.save_defaults) },
        });
        setNfapiImportResult(result);
        setNfapiOAuthSession(null);
        setNfapiCallbackUrl("");
        resetNfapiMailbox();
        toast(agentIdentityResultMessage(result));
        await loadAccounts();
      } catch (error) {
        if (!isBatch && agentIdentityOAuthFallbackCodes.has(error?.code)) {
          setNfapiAgentIdentityFallback(error.code);
          setNfapiImportMode("oauth");
          setNfapiOAuthSession(null);
          setNfapiCallbackUrl("");
          resetNfapiMailbox();
          toast("OpenAI 当前不允许该账号创建 Agent Identity，已切换到 OAuth 导入。", "error");
        } else {
          toast(error.message, "error");
        }
      } finally {
        setImportingNfapi(false);
        setNfapiBatchProgress(null);
      }
      return;
    }
    if (nfapiOAuthSession) {
      if (!nfapiCallbackUrl.trim()) {
        toast("请粘贴完整的 localhost OAuth 回调地址", "error");
        return;
      }
      setImportingNfapi(true);
      try {
        const result = await api(`/api/registration/accounts/${nfapiImportIds[0]}/nfapi-oauth/${encodeURIComponent(nfapiOAuthSession.oauth_session_id)}/complete`, {
          method: "POST",
          body: { callback_url: nfapiCallbackUrl.trim() },
        });
        setNfapiImportResult(result);
        setNfapiOAuthSession(null);
        setNfapiCallbackUrl("");
        resetNfapiMailbox();
        toast(result.action === "created" ? "NFapi OAuth 账号已创建" : result.action === "skipped" ? "NFapi 已有该账号，已跳过" : "NFapi OAuth 凭据已更新");
        await loadAccounts();
      } catch (error) {
        toast(error.message, "error");
      } finally {
        setImportingNfapi(false);
      }
      return;
    }
    let optionsPayload;
    try {
      optionsPayload = buildNfapiOptionsPayload();
    } catch (error) {
      toast(error.message, "error");
      return;
    }

    setImportingNfapi(true);
    setNfapiImportResult(null);
    try {
      const result = await api(`/api/registration/accounts/${nfapiImportIds[0]}/nfapi-oauth/start`, {
        method: "POST",
        body: { options: optionsPayload, save_defaults: Boolean(nfapiForm.save_defaults) },
      });
      if (!result.authorization_required) {
        setNfapiImportResult(result);
        resetNfapiMailbox();
        toast("NFapi 已存在该账号，已按当前策略跳过");
        await loadAccounts();
      } else {
        setNfapiOAuthSession(result);
        resetNfapiMailbox(true);
        toast("OAuth 授权链接已生成，请使用原账号登录");
      }
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setImportingNfapi(false);
    }
  };

  const restartNfapiOAuth = async () => {
    if (!nfapiOAuthSession || !nfapiSelectedAccount?.id || restartingNfapiOAuth) return;
    let optionsPayload;
    try {
      optionsPayload = buildNfapiOptionsPayload();
    } catch (error) {
      toast(error.message, "error");
      return;
    }
    setRestartingNfapiOAuth(true);
    try {
      const result = await api(`/api/registration/accounts/${nfapiSelectedAccount.id}/nfapi-oauth/start`, {
        method: "POST",
        body: {
          options: optionsPayload,
          save_defaults: Boolean(nfapiForm.save_defaults),
          force_restart: true,
        },
      });
      if (!result.authorization_required || !result.auth_url || !result.oauth_session_id) {
        throw new Error("NFapi 没有返回新的 OAuth 授权链接");
      }
      setNfapiOAuthSession(result);
      setNfapiCallbackUrl("");
      toast("新的 OAuth 授权链接已生成，旧授权页已失效");
    } catch (error) {
      toast(error.message || "重新生成 OAuth 授权链接失败", "error");
    } finally {
      setRestartingNfapiOAuth(false);
    }
  };

  const inspectProxy = async () => {
    if (proxyInspectIndex === "") return;
    setInspectingProxy(true);
    setProxyInspection(null);
    setProxyInspectionError("");
    try {
      const result = await api("/api/registration/proxies/inspect", {
        method: "POST",
        body: { url: options.proxies[Number(proxyInspectIndex)], samples: 3, delay_ms: 350 },
      });
      const sourceSamples = Array.isArray(result.samples) ? result.samples : (Array.isArray(result.results) ? result.results : []);
      const samples = sourceSamples.slice(0, 3).map(normalizeProxySample);
      const uniqueIps = [...new Set(samples.map((item) => item.ip).filter(Boolean))];
      const reportedDistinct = Array.isArray(result.distinct_ips)
        ? result.distinct_ips.length
        : Number(result.distinct_ips ?? result.unique_ip_count);
      const distinctIps = Number.isFinite(reportedDistinct) && reportedDistinct > 0 ? reportedDistinct : uniqueIps.length;
      const selectedMetadata = options.proxyMetadata?.[Number(proxyInspectIndex)] || {};
      const normalized = {
        ...result,
        proxy_label: result.proxy_label || options.maskedProxies?.[Number(proxyInspectIndex)] || `代理 ${Number(proxyInspectIndex) + 1}`,
        samples,
        distinct_ips: distinctIps,
        requested_samples: 3,
        dynamic_mode: result.dynamic_mode || selectedMetadata.dynamic_mode || "",
        provider: result.provider || selectedMetadata.provider || "",
        session_ttl: result.session_ttl || selectedMetadata.session_ttl || "",
        rotation_verified: Boolean(result.rotation_verified ?? distinctIps > 1),
        dynamic: Boolean(result.dynamic ?? result.is_dynamic ?? distinctIps > 1),
      };
      setProxyInspection(normalized);
      if (normalized.dynamic_mode === "sticky_session") {
        toast(`检测到粘性动态代理，3 个独立 session 出现 ${normalized.distinct_ips} 个不同出口`);
      } else {
        toast(normalized.dynamic ? `检测到动态代理，3 次采样出现 ${normalized.distinct_ips} 个不同出口` : "3 次检测完成，本轮未观察到出口轮换");
      }
    } catch (error) {
      setProxyInspectionError(error.message);
      toast(error.message, "error");
    } finally {
      setInspectingProxy(false);
    }
  };

  const openLogs = async (job) => {
    setLogJob(job); setLogs(null);
    try { setLogs((await api(`/api/registration/jobs/${job.id}/events`)).items); }
    catch (error) { setLogs([{ id: "error", message: error.message, level: "error" }]); }
  };

  const copyAccessToken = async (item) => {
    setCopyingTokenId(item.id);
    try {
      const result = await api(`/api/registration/accounts/${item.id}/access-token`);
      await copyText(result.access_token);
      toast("AT 已复制");
    } catch (error) { toast(error.message, "error"); } finally { setCopyingTokenId(null); }
  };

  const copySelectedAccessTokens = async () => {
    if (!selectedAccounts.length) return;
    setCopyingSelectedTokens(true);
    try {
      const results = await Promise.all(selectedAccounts.map(async (item) => {
        try {
          const result = await api(`/api/registration/accounts/${item.id}/access-token`);
          return { ok: true, token: result.access_token };
        } catch (error) {
          return { ok: false, email: item.email, error: error.message || "获取失败" };
        }
      }));
      const tokens = results.filter((item) => item.ok).map((item) => item.token);
      const failed = results.filter((item) => !item.ok);
      if (tokens.length) await copyText(tokens.join("\n"));
      if (failed.length) {
        const detail = failed.slice(0, 3).map((item) => `${item.email}（${item.error}）`).join("、");
        const remainder = failed.length > 3 ? ` 等 ${failed.length} 个` : "";
        toast(`${tokens.length ? `已复制 ${tokens.length} 个 AT；` : ""}失败 ${failed.length} 个：${detail}${remainder}`, "error");
      } else {
        toast(`已复制 ${tokens.length} 个账号的 AT`);
      }
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setCopyingSelectedTokens(false);
    }
  };

  const copyRegisteredAccount = async (item) => {
    if (!item?.email) {
      toast("账号目标已不存在，请刷新后重试", "error");
      return;
    }
    try {
      await copyText(item.password_available ? `${item.email}\t${item.password}` : item.email);
      toast(item.password_available ? "账号和密码已复制" : "邮箱已复制");
    } catch (error) {
      toast(error.message || "账号复制失败", "error");
    }
  };

  const copyNfapiVerificationCode = async (code) => {
    if (!String(code ?? "").trim()) {
      toast("验证码为空，无法复制", "error");
      return;
    }
    try {
      await copyText(code);
      toast(`验证码 ${code} 已复制`);
    } catch (error) {
      toast(error.message || "验证码复制失败", "error");
    }
  };

  if (!options || !jobs || !accounts) return <div className="page-stack"><LoadingBlock rows={8} /></div>;

  const deletingAccounts = deleteTarget?.kind === "account" || deleteTarget?.kind === "accounts";
  const nfapiConnected = Boolean(nfapiOptions?.connection?.connected);
  const nfapiGroups = Array.isArray(nfapiOptions?.groups) ? nfapiOptions.groups : [];
  const nfapiProxies = Array.isArray(nfapiOptions?.proxies) ? nfapiOptions.proxies : [];
  const nfapiSelectedAccount = accounts.items.find((item) => String(item.id) === String(nfapiImportIds[0]))
    || (String(nfapiAccountSnapshot?.id) === String(nfapiImportIds[0]) ? nfapiAccountSnapshot : null);
  const nfapiOAuthExpiresAt = new Date(nfapiOAuthSession?.expires_at || "").getTime();
  const nfapiOAuthExpired = Boolean(nfapiOAuthSession)
    && (!Number.isFinite(nfapiOAuthExpiresAt) || nfapiOAuthExpiresAt <= nfapiOAuthNow);
  const isBatchNfapiImport = nfapiImportIds.length > 1;
  const nfapiBatchPlan = isBatchNfapiImport
    ? planAgentIdentityBulk(accounts.items, nfapiImportIds)
    : null;
  const nfapiBatchActionableCount = nfapiBatchPlan?.actionable.length || 0;
  const nfapiSubmitDisabled = restartingNfapiOAuth
    || loadingNfapiOptions
    || !nfapiConnected
    || Boolean(nfapiImportResult)
    || Boolean(nfapiBatchResult)
    || (isBatchNfapiImport
      ? !nfapiBatchActionableCount
      : !nfapiSelectedAccount?.id
        || !nfapiSelectedAccount?.email
        || (nfapiImportMode === "agent_identity" && !nfapiSelectedAccount.access_token_available)
        || (nfapiImportMode === "oauth" && nfapiOAuthExpired));
  const isAgentIdentityResult = nfapiImportResult?.auth_mode === "agentIdentity"
    || nfapiImportMode === "agent_identity";
  const passwordSetupRunning = Boolean(passwordSetupTask && !passwordSetupTask.terminal);
  const isInboxLinkRegistration = form.mailboxMode === "inbox_link";
  const inboxLinkMailboxCount = Number(options.inboxLinkMailboxes?.available || 0);
  const requestedInboxLinkCount = Number(form.count);
  const validInboxLinkCount = Number.isSafeInteger(requestedInboxLinkCount)
    && requestedInboxLinkCount >= 1
    && requestedInboxLinkCount <= inboxLinkMailboxCount;
  const inboxLinkCountError = isInboxLinkRegistration && !Number.isSafeInteger(requestedInboxLinkCount)
    ? "请输入整数"
    : (isInboxLinkRegistration && requestedInboxLinkCount > inboxLinkMailboxCount
      ? `当前仅 ${inboxLinkMailboxCount} 个可用`
      : "");
  const isDirectRegistration = !isInboxLinkRegistration && selectedAccount?.registration_mode === "direct";
  const isBaseAddressRegistration = !isInboxLinkRegistration && !isDirectRegistration && form.addressMode === "base";
  const deleteCount = deleteTarget?.ids?.length || 0;
  const deleteTitle = deletingAccounts
    ? (deleteCount > 1 ? `删除选中的 ${deleteCount} 个注册账号？` : "删除这个注册账号？")
    : (deleteCount > 1 ? `删除选中的 ${deleteCount} 条注册记录？` : "删除这条注册记录？");
  const deleteDescription = deletingAccounts
    ? "将从本地账号池删除账号、密码（如有）、AT、Cookie 等凭据；不会注销官方 ChatGPT 账号。注册记录、分裂邮箱、邮件和验证码都会保留。"
    : "只从注册记录列表中移除所选记录。已注册账号、账号凭据、分裂邮箱和验证码都会保留。";
  const queueCounts = queueControl?.counts || {};

  return (
    <div className="page-stack registration-page">
      <div className="registration-summary">
        <span><Server size={16} /><b>注册服务</b><StatusBadge status={options.service?.ok ? "active" : "failed"}>{options.service?.ok ? "运行中" : "未连接"}</StatusBadge></span>
        <span><LoaderCircle size={16} /><b>执行中</b><strong>{activeJobs}</strong></span>
        <span><Check size={16} /><b>注册成功</b><strong>{accounts.total}</strong></span>
        <span><Network size={16} /><b>代理池</b><strong>{options.proxies.length}</strong></span>
      </div>

      <div className={`registration-queue-bar ${queueControl?.paused ? "paused" : ""}`}>
        <div><Pause size={18} /><span><b>注册队列</b><small>{queueControl ? `待执行 ${Number(queueCounts.pending || 0)} · 已暂停 ${Number(queueCounts.paused || 0)} · 执行中 ${Number(queueCounts.active || 0)}` : "正在读取队列状态"}</small></span><StatusBadge status={queueControl?.paused ? "paused" : "active"}>{queueControl?.paused ? "全部已暂停" : "队列运行中"}</StatusBadge></div>
        <div className="registration-queue-actions">
          <Button size="sm" icon={Pause} loading={queueAction === "pause"} disabled={!queueControl || queueControl.paused || Boolean(queueAction)} onClick={() => controlQueue("pause")}>暂停全部</Button>
          <Button size="sm" variant="primary" icon={Play} loading={queueAction === "resume"} disabled={!queueControl?.paused || Boolean(queueAction)} onClick={() => controlQueue("resume")}>继续全部</Button>
        </div>
      </div>

      <Segmented value={view} onChange={setView} ariaLabel="注册视图" items={[
        { value: "tasks", label: "注册任务", icon: ListChecks, count: jobs.length },
        { value: "accounts", label: "注册账号", icon: KeyRound, count: accounts.total },
        { value: "proxies", label: "IP 代理池", icon: Network, count: options.proxies.length },
      ]} />

      {view === "tasks" && <>
        <section className="registration-control-grid">
          <article className="panel registration-launch-panel">
            <header className="panel-header"><div><h2>创建邮箱注册任务</h2><p>{isInboxLinkRegistration ? "从邮箱工作台已绑定的链接取件邮箱池中分配邮箱注册" : isDirectRegistration ? "可分别选择 iCloud 邮箱别名或隐藏邮箱；两者均直接注册，不生成 +tag 分裂地址" : "自动生成独立分裂邮箱，并使用全新随机指纹环境"}</p></div><Fingerprint size={20} /></header>
            <div className="registration-launch-form">
              <FormField label="注册邮箱来源"><select value={form.mailboxMode} onChange={(event) => {
                const mailboxMode = event.target.value;
                setForm((current) => ({
                  ...current,
                  mailboxMode,
                  ...(mailboxMode === "inbox_link"
                    ? { count: Math.max(1, Math.min(Number(current.count) || 1, inboxLinkMailboxCount || 1)), suffix: "" }
                    : (selectedAccount?.registration_mode === "direct" ? { count: 1, suffix: "" } : {})),
                }));
              }}><option value="source">邮箱工作台地址</option><option value="inbox_link">链接取件邮箱池（可用 {inboxLinkMailboxCount}）</option></select></FormField>
              {!isInboxLinkRegistration && <div className="form-grid two">
                <FormField label="源头邮箱"><select value={form.accountId} onChange={(event) => changeAccount(event.target.value)}><option value="">请选择</option>{options.accounts.map((item) => <option key={item.id} value={item.id}>{item.email}</option>)}</select></FormField>
                <FormField label={isDirectRegistration ? "iCloud 地址类型" : "基础地址"}><select value={form.baseAddressId} onChange={(event) => setForm({ ...form, baseAddressId: event.target.value })}><option value="">请选择</option>{selectedAccount?.bases.map((item) => <option key={item.id} value={item.id} disabled={Boolean(item.registration_disabled)}>{baseOptionLabel(item)}</option>)}</select></FormField>
              </div>}
              {!isInboxLinkRegistration && <OccupiedAliasNotice base={selectedBase} />}
              {!isInboxLinkRegistration && selectedBase?.registration_hint && <div className="inline-alert warning"><AlertTriangle size={16} /><span>{selectedBase.registration_hint}</span></div>}
              {!isInboxLinkRegistration && !isDirectRegistration && <FormField label="注册邮箱模式" hint="基础地址成功率更高；Plus 分裂适合目标站仍接受 +tag 时批量使用"><select value={form.addressMode} onChange={(event) => setForm({ ...form, addressMode: event.target.value, ...(event.target.value === "base" ? { count: 1, suffix: "" } : {}) })}><option value="base">直接使用基础地址（推荐）</option><option value="split">生成 +tag 分裂地址</option></select></FormField>}
              {isInboxLinkRegistration && <div className={`inline-alert ${inboxLinkMailboxCount ? "success" : "warning"}`}><Link2 size={16} /><span>{inboxLinkMailboxCount ? `当前有 ${inboxLinkMailboxCount} 个已绑定链接邮箱可用；输入几个就分配几个。` : "没有可用的链接取件邮箱，请先到邮箱工作台绑定。"}<button type="button" className="bare-button registration-inline-link" onClick={() => onNavigate?.("inbox-link")}>管理链接邮箱</button></span></div>}
              <div className="form-grid two">
                <FormField label="注册数量" error={inboxLinkCountError} hint={isInboxLinkRegistration ? "从已绑定可用池按绑定时间依次分配；输入多少就提交多少" : isDirectRegistration || isBaseAddressRegistration ? "当前模式直接使用基础地址，固定为 1 个任务" : form.suffix.trim() ? "批量注册会自动追加 -01、-02 编号" : "留空后缀时，每个账号生成随机分裂邮箱"}><input type="number" min="1" max={isInboxLinkRegistration ? 200 : 20} step="1" value={isDirectRegistration || isBaseAddressRegistration ? 1 : form.count} disabled={isDirectRegistration || isBaseAddressRegistration} onChange={(event) => setForm({ ...form, count: Number(event.target.value) })} /></FormField>
                <FormField label="浏览器模式"><select value={form.browserMode} onChange={(event) => setForm({ ...form, browserMode: event.target.value })}><option value="headed">内嵌指纹浏览器</option><option value="headless" disabled={!form.autoContinuePostSignup}>后台指纹浏览器</option></select></FormField>
              </div>
              <div className="form-grid two">
                {!isInboxLinkRegistration && !isDirectRegistration && !isBaseAddressRegistration && <FormField label="邮箱分裂后缀" hint="例如 campaign；不填写则随机生成"><input maxLength={24} value={form.suffix} onChange={(event) => setForm({ ...form, suffix: event.target.value })} placeholder="留空自动随机" /></FormField>}
                <FormField label="注册代理" hint="可固定使用某个已保存代理，也可自动轮换或直连"><select value={form.proxySelection} onChange={(event) => setForm({ ...form, proxySelection: event.target.value })}><option value="auto">自动轮换代理池（{options.proxies.length}）</option>{options.maskedProxies.map((item, index) => <option key={`${item}-${index}`} value={`proxy:${index}`}>固定使用：{proxySelectLabel(item, options.proxyMetadata?.[index])}</option>)}<option value="direct">直连（不使用代理）</option></select></FormField>
              </div>
              <div className="fresh-browser-note"><Fingerprint size={17} /><span><b>仅邮箱验证，每次全新地域指纹</b><small>清空 Cookie · 随机 OS/屏幕/Canvas/WebGL/设备参数 · 语言、时区和地理位置匹配实际出口 IP；官方强制要求手机号时任务停止</small></span></div>
              <div className="registration-option-stack">
                <label className="registration-password-option"><input type="checkbox" checked={form.autoContinuePostSignup} onChange={(event) => setForm({ ...form, autoContinuePostSignup: event.target.checked, ...(event.target.checked ? {} : { browserMode: "headed" }) })} /><span><b>自动点击准备完成页“继续”</b><small>取消勾选后，任务会在内嵌浏览器等待你手动点击，最长 5 分钟。</small></span></label>
                <label className="registration-password-option"><input type="checkbox" checked={form.setPasswordAfterRegistration} onChange={(event) => setForm({ ...form, setPasswordAfterRegistration: event.target.checked, ...(event.target.checked ? {} : { password: "" }) })} /><span><b>注册后设置密码</b><small>未勾选时，仅在官网注册流程强制要求密码时设置；勾选后会进入 ChatGPT 安全设置并再次读取邮箱验证码。</small></span></label>
              </div>
              <FormField label="指定密码（可选）" hint="填写后使用此密码；留空时由注册服务随机生成。长度 12-128 个字符，不能包含首尾空白。"><input type="password" autoComplete="new-password" minLength={12} maxLength={128} disabled={!form.setPasswordAfterRegistration} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={form.setPasswordAfterRegistration ? "留空自动生成随机密码" : "请先勾选注册后设置密码"} /></FormField>
              <Button variant="primary" size="lg" icon={Play} loading={starting} disabled={!options.service?.ok || (isInboxLinkRegistration ? !validInboxLinkCount : !form.accountId || !form.baseAddressId || Boolean(selectedBase?.registration_disabled))} onClick={start}>{isInboxLinkRegistration ? "使用链接邮箱池注册" : isDirectRegistration ? "使用此 iCloud 地址注册" : isBaseAddressRegistration ? "使用此基础地址注册" : "开始注册"}</Button>
            </div>
          </article>

          <article className="panel registration-browser-panel">
            <header className="panel-header"><div><h2>内嵌指纹浏览器</h2><p>查看 Camoufox 当前注册过程</p></div><Button size="sm" icon={Monitor} onClick={() => setBrowserOpen(!browserOpen)}>{browserOpen ? "收起" : "打开"}</Button></header>
            {browserOpen ? <div className="registration-browser-frame"><iframe src={options.browserUrl} title="注册指纹浏览器" allow="clipboard-read; clipboard-write" /></div> : <EmptyState icon={Monitor} title="浏览器画面已收起" action={<Button onClick={() => setBrowserOpen(true)}>重新打开</Button>} />}
          </article>
        </section>

        <section className="table-panel registration-task-panel">
          <header className="panel-header"><div><h2>注册记录</h2><p>邮箱、身份、代理出口和注册结果</p></div><Button size="sm" onClick={() => refreshRegistrationData().catch((error) => toast(error.message, "error"))}>刷新</Button></header>
          {jobs.length ? <>
            <div className="registration-bulk-bar">
              <label><input type="checkbox" checked={allJobsSelected} disabled={!deletableJobIds.length} onChange={toggleAllJobs} />全选可删除记录</label>
              <span>已选择 <b>{selectedJobIds.length}</b> 条</span>
              <Button size="sm" variant="danger" icon={Trash2} disabled={!selectedJobIds.length} onClick={() => setDeleteTarget({ kind: "jobs", ids: selectedJobIds })}>删除所选</Button>
            </div>
            <div className="data-table-wrap"><table className="data-table"><thead><tr><th className="select-column"><input type="checkbox" aria-label="选择全部可删除注册记录" checked={allJobsSelected} disabled={!deletableJobIds.length} onChange={toggleAllJobs} /></th><th>注册邮箱</th><th>随机身份</th><th>指纹会话</th><th>代理 / 出口 IP</th><th>状态</th><th>创建时间</th><th aria-label="操作" /></tr></thead><tbody>{jobs.map((job) => {
              const selectable = deletableStatuses.has(job.status);
              const checked = selectedJobIds.includes(job.id);
              return <tr className={checked ? "selected-row" : ""} key={job.id}><td className="select-column"><input type="checkbox" aria-label={`选择 ${job.email}`} checked={checked} disabled={!selectable} onChange={() => toggleJob(job.id)} /></td><td><button className="registration-email-button" onClick={() => copyText(job.email).then(() => toast("邮箱已复制"))}>{job.email}<Copy size={13} /></button><small className="registration-source">{job.source_email || (job.account_id ? "源邮箱已删除" : "链接取件邮箱")}</small></td><td><div className="registration-identity"><b>{job.display_name || "等待生成"}</b><small>{job.birth_date ? `${job.birth_date} · ${ageFromBirth(job.birth_date)} 岁` : "姓名和年龄自动随机"}</small></div></td><td><code className="fingerprint-code">{job.fingerprint_id}</code><small className="registration-source">{job.browser_mode === "headed" ? "内嵌 Camoufox" : "后台 Camoufox"}</small></td><td><div className="registration-identity"><b>{job.proxy_label}</b><small>{job.exit_ip ? `出口 ${job.exit_ip}` : "等待识别出口 IP"}</small></div></td><td><div className="registration-status"><StatusBadge status={job.status}>{jobStatusLabel(job)}</StatusBadge>{job.failure_reason === "user_already_exists" && <small>建议更换基础地址</small>}</div></td><td><span className="muted-cell">{formatDate(job.created_at)}</span></td><td><JobCommands job={job} busy={jobActionIds.has(job.id)} onLogs={openLogs} onPause={(item) => controlJob(item, "pause")} onResume={(item) => controlJob(item, "resume")} onCancel={cancel} onRelease={setReleaseTarget} onDelete={(item) => setDeleteTarget({ kind: "job", ids: [item.id], item })} /></td></tr>;
            })}</tbody></table></div>
            <div className="registration-mobile-list">{jobs.map((job) => {
              const selectable = deletableStatuses.has(job.status);
              const checked = selectedJobIds.includes(job.id);
              return <article className={checked ? "selected" : ""} key={job.id}><header><input type="checkbox" aria-label={`选择 ${job.email}`} checked={checked} disabled={!selectable} onChange={() => toggleJob(job.id)} /><StatusBadge status={job.status}>{jobStatusLabel(job)}</StatusBadge><time>{formatDate(job.created_at)}</time></header><button onClick={() => copyText(job.email).then(() => toast("邮箱已复制"))}>{job.email}<Copy size={14} /></button><dl><div><dt>身份</dt><dd>{job.display_name || "等待生成"}</dd></div><div><dt>出口 IP</dt><dd>{job.exit_ip || "等待识别"}</dd></div><div><dt>代理</dt><dd>{job.proxy_label}</dd></div></dl><footer><span>{job.display_message || job.message || "-"}</span><JobCommands job={job} busy={jobActionIds.has(job.id)} onLogs={openLogs} onPause={(item) => controlJob(item, "pause")} onResume={(item) => controlJob(item, "resume")} onCancel={cancel} onRelease={setReleaseTarget} onDelete={(item) => setDeleteTarget({ kind: "job", ids: [item.id], item })} /></footer></article>;
            })}</div>
            <div className="table-footer"><span>共 {jobs.length} 个注册任务</span></div>
          </> : <EmptyState icon={UserPlus} title="还没有注册任务" description="选择源头邮箱和基础地址后开始注册。" />}
        </section>
      </>}

      {view === "accounts" && <section className="table-panel registration-account-panel">
        <header className="panel-header"><div><h2>已注册账号</h2><p>账号、凭据、状态与 NFapi 集中管理</p></div><Button size="sm" icon={RefreshCw} disabled={!accounts.items.length || importingNfapi} title="重新加载账号列表，不触发状态检测" onClick={loadAccounts}>刷新列表</Button></header>
        {accounts.items.length ? <>
          {accountsError && <div className="inline-alert error"><AlertTriangle size={15} /><span>{accountsError}；当前保留上一次成功加载的账号列表。</span></div>}
          <div className="registration-account-toolbar">
            <div className="registration-account-filters">
              <label className="registration-select-page"><input type="checkbox" checked={allAccountsSelected} disabled={!accountIds.length || importingNfapi} onChange={toggleAllAccounts} /><span>全选本页</span></label>
              <select className="compact-select registration-group-filter" aria-label="按账号分组筛选" value={accountGroupFilter} disabled={importingNfapi} onChange={(event) => changeAccountGroupFilter(event.target.value)}>
                <option value="all">全部分组（{accounts.items.length}）</option>
                <option value="ungrouped">未分组（{ungroupedAccountCount}）</option>
                {accountGroups.map((group) => <option key={group.name} value={`group:${group.name}`}>{group.name}（{group.count}）{group.automaticCount === group.count ? " · 自动" : group.automaticCount ? ` · 自动 ${group.automaticCount}` : ""}</option>)}
              </select>
              <span className="registration-selection-count">已选 <b>{selectedAccountIds.length}</b> 个</span>
            </div>
            <div className="registration-account-bulk-actions">
              <Button size="sm" icon={ListChecks} loading={checkingAccountSignals} disabled={!visibleAccountItems.length || importingNfapi} title={selectedAccountIds.length ? "重新检测所选账号的当前状态和订阅类型" : "检测当前分组内全部账号的状态和订阅类型"} onClick={refreshSelectedAccountSignals}>{selectedAccountIds.length ? "检测所选" : "检测当前筛选"}</Button>
              <Button size="sm" icon={SlidersHorizontal} disabled={!selectedAccountIds.length || importingNfapi} title="为所选账号统一配置并批量导入 NFapi" onClick={() => openNfapiImporter(selectedAccountIds)}>批量导入</Button>
              <Button size="sm" icon={KeyRound} loading={copyingSelectedTokens} disabled={!selectedAccountIds.length || importingNfapi} onClick={copySelectedAccessTokens}>复制 AT</Button>
              <Button size="sm" variant="danger" icon={Trash2} disabled={!selectedAccountIds.length || importingNfapi} onClick={() => setDeleteTarget({ kind: "accounts", ids: selectedAccountIds })}>删除</Button>
            </div>
          </div>
          {visibleAccountItems.length ? <>
            <div className="data-table-wrap registration-account-table-wrap"><table className="data-table registration-accounts-table"><thead><tr><th className="select-column"><input type="checkbox" aria-label="选择本页全部注册账号" checked={allAccountsSelected} disabled={!accountIds.length || importingNfapi} onChange={toggleAllAccounts} /></th><th>账号</th><th>凭据</th><th>身份 / 出口</th><th>状态 / 类型</th><th>NFapi</th><th>创建时间</th><th className="registration-actions-column" aria-label="操作" /></tr></thead><tbody>{pagedAccountItems.map((item) => {
              const checked = selectedAccountIds.includes(item.id);
              const nfapiState = nfapiAccountState(item);
              return <tr className={checked ? "selected-row" : ""} key={item.id}>
                <td className="select-column"><input type="checkbox" aria-label={`选择 ${item.email}`} checked={checked} disabled={importingNfapi} onChange={() => toggleAccount(item.id)} /></td>
                <td><div className="registration-account-primary"><button title="复制邮箱" onClick={() => copyText(item.email).then(() => toast("邮箱已复制"))}><b>{item.email}</b><Copy size={13} /></button><AccountNameGroup item={item} /></div></td>
                <td><div className="registration-credential-stack"><div><span>密码</span><PasswordCell value={item.password} status={item.password_status} error={item.password_error} available={item.password_available} onCopy={() => copyText(item.password).then(() => toast("密码已复制"))} /></div><div><span>AT</span><AccessTokenCell available={item.access_token_available} loading={copyingTokenId === item.id} onCopy={() => copyAccessToken(item)} /></div></div></td>
                <td><div className="registration-identity-network"><div className="registration-identity"><b>{item.display_name || "未记录姓名"}</b><small>{item.birth_date ? `${item.birth_date} · ${ageFromBirth(item.birth_date)} 岁` : "未记录年龄"}</small></div><div className="registration-exit-line"><Globe2 size={13} /><code>{item.exit_ip || "未记录出口"}</code></div></div></td>
                <td><AccountSignalCell item={item} /></td>
                <td><div className="registration-nfapi-status" title={nfapiState.error || nfapiState.accountId || nfapiState.label}><StatusBadge status={nfapiState.badge}>{nfapiState.label}</StatusBadge>{nfapiState.shortLived && <small>短期凭据</small>}{nfapiState.accountId && <code>#{nfapiState.accountId}</code>}{nfapiState.error && <small className="error">{nfapiState.error}</small>}</div></td>
                <td><span className="muted-cell">{formatDate(item.created_at)}</span></td>
                <td><AccountCommands item={item} checking={checkingAccountSignals} busy={importingNfapi} onRefresh={refreshAccountSignals} onPassword={openPasswordSetup} onNfapi={openNfapiImporter} onEdit={openAccountEditor} onCopy={copyRegisteredAccount} onDelete={(target) => setDeleteTarget({ kind: "account", ids: [target.id], item: target })} /></td>
              </tr>;
            })}</tbody></table></div>
            <div className="registration-mobile-list">{pagedAccountItems.map((item) => {
              const checked = selectedAccountIds.includes(item.id);
              const nfapiState = nfapiAccountState(item);
              return <article className={checked ? "selected" : ""} key={item.id}><header><input type="checkbox" aria-label={`选择 ${item.email}`} checked={checked} disabled={importingNfapi} onChange={() => toggleAccount(item.id)} /><AccountSignalCell item={item} compact /><time>{formatDate(item.created_at)}</time></header><AccountNameGroup item={item} mobile /><button onClick={() => copyText(item.email).then(() => toast("邮箱已复制"))}>{item.email}<Copy size={14} /></button><div className="registration-mobile-credentials"><PasswordCell value={item.password} status={item.password_status} error={item.password_error} available={item.password_available} onCopy={() => copyText(item.password).then(() => toast("密码已复制"))} /><AccessTokenCell available={item.access_token_available} loading={copyingTokenId === item.id} onCopy={() => copyAccessToken(item)} /></div><div className="registration-mobile-facts"><div className="registration-account-exit"><Globe2 size={14} /><span><small>出口 IP</small><b>{item.exit_ip || "未记录"}</b></span></div><div className="registration-account-exit"><Database size={14} /><span><small>NFapi</small><b>{nfapiState.label}{nfapiState.shortLived ? " · 短期凭据" : ""}</b></span></div></div>{nfapiState.error && <div className="inline-alert error"><AlertTriangle size={14} /><span>{nfapiState.error}</span></div>}<footer><span>{item.display_name || "未记录"}</span><AccountCommands item={item} checking={checkingAccountSignals} busy={importingNfapi} onRefresh={refreshAccountSignals} onPassword={openPasswordSetup} onNfapi={openNfapiImporter} onEdit={openAccountEditor} onCopy={copyRegisteredAccount} onDelete={(target) => setDeleteTarget({ kind: "account", ids: [target.id], item: target })} /></footer></article>;
            })}</div>
          </> : <EmptyState icon={KeyRound} title="这个分组还没有账号" action={<Button onClick={() => changeAccountGroupFilter("all")}>查看全部账号</Button>} />}
          <div className="table-footer registration-account-footer">
            <div className="registration-account-range"><strong>{accountRangeStart}–{accountRangeEnd}</strong><span>筛选后 {visibleAccountItems.length} 个 · 总计 {accounts.total} 个</span></div>
            <div className="registration-account-pagination">
              <label><span>每页</span><select aria-label="每页显示账号数" value={accountPageSize} disabled={importingNfapi} onChange={(event) => changeAccountPageSize(event.target.value)}>{accountPageSizes.map((size) => <option key={size} value={size}>{size} 条</option>)}</select></label>
              <label><span>跳至</span><select aria-label="跳转账号页码" value={safeAccountPage} disabled={importingNfapi} onChange={(event) => changeAccountPage(event.target.value)}>{Array.from({ length: accountPages }, (_, index) => <option key={index + 1} value={index + 1}>第 {index + 1} 页</option>)}</select></label>
              <Pagination page={safeAccountPage} pages={accountPages} disabled={importingNfapi} onChange={changeAccountPage} />
            </div>
          </div>
        </> : <EmptyState icon={KeyRound} title={accountsError ? "注册账号暂时无法加载" : "还没有注册成功的账号"} description={accountsError || undefined} action={accountsError ? <Button icon={RefreshCw} onClick={loadAccounts}>重新加载</Button> : undefined} />}
      </section>}

      {view === "proxies" && <section className="registration-proxy-layout">
        <article className="settings-section"><header><span><Network size={19} /></span><div><h2>IP 代理池</h2><p>每行一个代理，注册任务按顺序轮换使用</p></div></header><div className="settings-form"><FormField label="代理地址" hint="支持 URL、host:port:user:password 和无认证 socks5；动态类型由服务端实际识别"><textarea className="proxy-pool-editor" aria-invalid={Boolean(proxyDraft.errors.length)} value={proxyText} onChange={(event) => { setProxyText(event.target.value); setProxySaveFeedback(null); }} placeholder={"http://user:password@host:port\nhost:port:user:password\nsocks5://host:port"} /></FormField>
          {proxyDraft.duplicateLines.length > 0 && <div className="proxy-draft-notes">
            {proxyDraft.duplicateLines.map((item) => <span key={item.line}><AlertTriangle size={14} />第 {item.line} 行与第 {item.originalLine} 行重复，保存时忽略</span>)}
          </div>}
          {proxyDraft.errors.length > 0 && <div className="proxy-line-errors" role="alert"><b><AlertTriangle size={15} />以下地址不会保存</b>{proxyDraft.errors.map((item) => <span key={item.line}>第 {item.line} 行：{item.reason}</span>)}</div>}
          {proxySaveFeedback && <div className={`inline-alert ${proxySaveFeedback.type === "error" ? "error" : "success"}`}><span>{proxySaveFeedback.message}</span></div>}
          <Button variant="primary" icon={Save} loading={savingProxies} onClick={saveProxies}>保存 {proxyDraft.proxies.length} 条代理</Button>
        </div></article>
        <div className="registration-proxy-side">
          <article className="settings-section proxy-inspector"><header><span><RefreshCw size={19} /></span><div><h2>动态出口检测</h2><p>通过所选代理连续请求三次并识别实际国家</p></div></header><div className="settings-form"><FormField label="已保存代理" hint="检测只读取代理配置，不会保存采样结果"><select value={proxyInspectIndex} disabled={!options.proxies.length || inspectingProxy} onChange={(event) => { setProxyInspectIndex(event.target.value); setProxyInspection(null); setProxyInspectionError(""); }}><option value="">请选择代理</option>{(options.maskedProxies || []).map((item, index) => <option key={`${item}-${index}`} value={index}>{proxySelectLabel(item, options.proxyMetadata?.[index])}</option>)}</select></FormField><Button variant="primary" icon={RefreshCw} loading={inspectingProxy} disabled={proxyInspectIndex === ""} onClick={inspectProxy}>检测 3 次出口</Button>{proxyInspectionError && <div className="inline-alert error"><AlertTriangle size={15} /><span>{proxyInspectionError}</span></div>}{proxyInspection && <div className="proxy-inspection-result"><header><div><b>{proxyInspection.proxy_label}</b><small>{proxyInspection.rotation_verified ? "已验证轮换" : "本轮采样"} · 返回 {proxyInspection.samples.length} / 3 次 · {proxyInspection.distinct_ips} 个出口 IP</small></div><StatusBadge status={proxyInspection.dynamic ? "warning" : "active"}>{proxyInspection.dynamic_mode === "sticky_session" ? "粘性动态" : (proxyInspection.dynamic ? "动态出口" : "本轮同一出口")}</StatusBadge></header>
            {proxyInspection.dynamic_mode === "sticky_session" && <div className="proxy-session-note"><RefreshCw size={14} /><span><b>{[proxyInspection.provider, proxyInspection.session_ttl && `${proxyInspection.session_ttl} 粘性`].filter(Boolean).join(" · ") || "粘性动态代理"}</b><small>每个注册任务使用独立 session，并按该任务的实际出口重新匹配地域指纹</small></span></div>}
            {proxyInspection.samples.length < 3 && <div className="proxy-inspection-warning"><AlertTriangle size={14} />检测服务只返回 {proxyInspection.samples.length} 次结果，请重新检测</div>}
            <div className="proxy-sample-list">{Array.from({ length: 3 }, (_, index) => {
              const sample = proxyInspection.samples[index];
              const country = sample && [sample.country_name, sample.country_code].filter((value, itemIndex, items) => value && items.indexOf(value) === itemIndex).join(" · ");
              return <div className={!sample ? "missing" : ""} key={index}><span>{index + 1}</span><code>{sample?.ip || "未返回 IP"}</code><b>{country || "未返回国家"}</b><small>{sample ? ([sample.locale, sample.timezone].filter(Boolean).join(" · ") || "未返回地域参数") : "本次采样缺失"}</small></div>;
            })}</div>
          </div>}</div></article>
          <article className="settings-section"><header><span><Globe2 size={19} /></span><div><h2>使用规则</h2><p>代理与指纹在每个任务启动时独立应用</p></div></header><div className="proxy-rule-list"><div><Check size={16} /><span><b>可选代理</b><small>创建任务时可选择自动轮换、固定某个已保存代理或直连。</small></span></div><div><Fingerprint size={16} /><span><b>随机指纹</b><small>每次启动新的 Camoufox 环境，随机 OS、屏幕、Canvas、WebGL 和设备参数，不复用 Cookie 或本地存储。</small></span></div><div><Globe2 size={16} /><span><b>地域一致</b><small>每次任务按当次实际出口 IP 重新识别国家、语言、时区和地理位置，动态代理不会沿用上次结果。</small></span></div></div></article>
        </div>
      </section>}

      <Modal
        open={Boolean(passwordSetupTarget)}
        onClose={closePasswordSetup}
        title="使用原邮箱设置密码"
        description={passwordSetupTarget?.email}
        size="md"
        footer={<>
          {passwordSetupRunning && passwordSetupTask?.cancellable && <Button variant="danger" disabled={startingPasswordSetup} onClick={cancelPasswordSetup}>取消任务</Button>}
          <Button disabled={startingPasswordSetup || passwordSetupRunning} onClick={closePasswordSetup}>{passwordSetupTask?.terminal ? "关闭" : "取消"}</Button>
          {!passwordSetupTask && <Button variant="primary" icon={ShieldCheck} loading={startingPasswordSetup} onClick={startPasswordSetup}>开始设置</Button>}
        </>}
      >
        {passwordSetupTarget && <div className="password-setup-form">
          <div className="inline-alert"><ShieldCheck size={16} /><span>只恢复这个已注册账号，第二次验证码仍发送到并读取原注册邮箱；不会创建新邮箱或重新注册。</span></div>
          {!passwordSetupTask ? <>
            <FormField label="指定新密码（可选）" hint="留空时由注册服务生成随机密码；长度 12-128 个字符，不能包含首尾空白。"><input type="password" autoComplete="new-password" minLength={12} maxLength={128} value={passwordSetupValue} onChange={(event) => setPasswordSetupValue(event.target.value)} placeholder="留空自动生成随机密码" /></FormField>
            <div className="password-setup-checks"><span><Check size={14} />使用原账号 Session</span><span><Check size={14} />严格刷新邮件基线</span><span><Check size={14} />成功页确认后才保存密码</span></div>
          </> : <>
            <div className="password-setup-status"><StatusBadge status={passwordSetupTask.status === "completed" ? "active" : passwordSetupTask.status === "failed" ? "failed" : "queued"}>{passwordSetupTask.status === "completed" ? "已完成" : passwordSetupTask.status === "failed" ? "失败" : passwordSetupTask.status === "cancelled" ? "已取消" : "处理中"}</StatusBadge><span>{passwordSetupTask.error || `进度 ${passwordSetupTask.progress_current || 0}/${passwordSetupTask.progress_total || 1}`}</span></div>
            {passwordSetupEvents.length ? <div className="registration-log-list password-setup-log">{passwordSetupEvents.map((item, index) => <div className={item.level === "error" ? "error" : ""} key={item.id || index}><time>{item.created_at ? formatDate(item.created_at) : String(index + 1).padStart(2, "0")}</time><span>{item.message}</span></div>)}</div> : <LoadingBlock rows={3} />}
          </>}
        </div>}
      </Modal>

      <Modal
        open={Boolean(nfapiImportIds.length)}
        onClose={closeNfapiImporter}
        title={isBatchNfapiImport ? "批量导入账号至 NFapi" : "添加账号至 NFapi"}
        description={isBatchNfapiImport
          ? `已选择 ${nfapiImportIds.length} 个注册账号，以下设置将统一应用到全部可导入账号。`
          : nfapiSelectedAccount?.email || "选择一个注册账号"}
        size="xl"
        footer={<><Button disabled={importingNfapi || restartingNfapiOAuth} onClick={closeNfapiImporter}>关闭</Button><Button variant="primary" icon={nfapiOAuthSession ? ShieldCheck : nfapiImportMode === "agent_identity" ? Fingerprint : Database} loading={importingNfapi} disabled={importingNfapi || nfapiSubmitDisabled} onClick={submitNfapiImport}>{nfapiOAuthSession ? "提交回调到 NFapi" : isBatchNfapiImport ? `批量生成 Agent Identity 并导入（${nfapiBatchActionableCount}）` : nfapiImportMode === "agent_identity" ? "生成 Agent Identity 并导入" : "生成 OAuth 授权链接"}</Button></>}
      >
        {loadingNfapiOptions ? <LoadingBlock rows={9} /> : nfapiOptions && <div className={`nfapi-import-form${importingNfapi ? " is-importing" : ""}`} inert={importingNfapi ? "" : undefined}>
          <div className={`nfapi-import-connection ${nfapiConnected ? "connected" : "failed"}`}><Cable size={18} /><span><b>{nfapiConnected ? "NFapi 已连接" : "NFapi 当前不可用"}</b><small>{nfapiOptions.connection?.base_url || nfapiOptions.connection?.url || nfapiOptions.error || "请先到系统设置配置地址与管理员 API Key"}</small></span><StatusBadge status={nfapiConnected ? "active" : "failed"}>{nfapiConnected ? "可以导入" : "请检查连接"}</StatusBadge></div>
          {nfapiOptions.error && <div className="inline-alert error"><AlertTriangle size={15} /><span>{nfapiOptions.error}</span></div>}
          {!isBatchNfapiImport && nfapiAgentIdentityFallback && !nfapiImportResult && <div className="inline-alert error" role="status"><AlertTriangle size={15} /><span>OpenAI 拒绝此账号创建 Agent Identity。已切换到 OAuth 导入；点击“生成 OAuth 授权链接”继续。</span></div>}
          {isBatchNfapiImport ? <>
            <div className="inline-alert"><Fingerprint size={15} /><span>已选择 {nfapiBatchPlan.total} 个账号，其中 {nfapiBatchActionableCount} 个可直接导入。批量导入将使用同一套配置，并按顺序执行。</span></div>
            {nfapiBatchPlan.blocked.length > 0 && <div className="inline-alert error"><AlertTriangle size={15} /><span>{nfapiBatchPlan.blocked.slice(0, 3).map((item) => `${item.item?.email || `账号 #${item.id}`}：${item.reason}`).join("；")}{nfapiBatchPlan.blocked.length > 3 ? `；另有 ${nfapiBatchPlan.blocked.length - 3} 个需处理` : ""}</span></div>}
          </> : !nfapiSelectedAccount ? <div className="inline-alert error"><AlertTriangle size={15} /><span>NFapi 目标账号已不存在，请关闭弹窗并刷新账号列表后重新选择。</span></div> : nfapiImportMode === "oauth" && !nfapiSelectedAccount.password_available && <div className="inline-alert"><AlertTriangle size={15} /><span>本地尚未保存该账号密码，仍可继续配置并发起 OAuth；登录时可使用原邮箱验证码，或使用账号已有密码。</span></div>}
          {nfapiBatchProgress && <div className="nfapi-batch-progress" role="status" aria-live="polite"><LoaderCircle className="spin" size={16} /><div><b>正在批量导入 {nfapiBatchProgress.current}/{nfapiBatchProgress.total}</b><small>配置已锁定 · 新增 {nfapiBatchProgress.created} · 更新 {nfapiBatchProgress.updated} · 已存在 {nfapiBatchProgress.skipped} · 失败 {nfapiBatchProgress.failed}</small></div><i aria-hidden="true" style={{ width: `${Math.round((nfapiBatchProgress.current / Math.max(1, nfapiBatchProgress.total)) * 100)}%` }} /></div>}
          {!nfapiOAuthSession && !nfapiImportResult && !nfapiBatchResult && <>
            <section className="nfapi-import-section">
              <header><Fingerprint size={17} /><div><h3>授权方式</h3><p>{isBatchNfapiImport ? "批量导入统一使用 Agent Identity；OAuth 需逐个账号授权。" : "默认使用 Agent Identity，也可切换到 OpenAI OAuth"}</p></div></header>
              <Segmented
                value={nfapiImportMode}
                onChange={selectNfapiImportMode}
                ariaLabel="NFapi 账号授权方式"
                disabled={importingNfapi}
                items={isBatchNfapiImport
                  ? [{ value: "agent_identity", label: "Agent Identity（推荐）", icon: Fingerprint }]
                  : [
                    { value: "agent_identity", label: "Agent Identity（推荐）", icon: Fingerprint },
                    { value: "oauth", label: "OpenAI OAuth", icon: ShieldCheck },
                  ]}
              />
            </section>
            {nfapiImportMode === "agent_identity" ? <>
              <div className="inline-alert"><Fingerprint size={15} /><span>{isBatchNfapiImport ? "使用每个账号已保存的 Access Token 自动生成 Agent Identity，并将下方设置统一导入 NFapi。" : "使用 AliasHub 已保存的 Access Token 自动生成 Agent Identity 并导入 NFapi；NFapi 不保存 OAuth access token 或 refresh token，每次上游请求动态签名。"}</span></div>
              {!isBatchNfapiImport && nfapiSelectedAccount && !nfapiSelectedAccount.access_token_available && <div className="inline-alert error"><AlertTriangle size={15} /><span>当前账号没有可用 Access Token，请切换到 OAuth 授权。</span></div>}
            </> : <div className="inline-alert"><ShieldCheck size={15} /><span>通过 OpenAI OAuth 登录并授权；完成后将回调地址提交到 NFapi 兑换凭据。</span></div>}
          </>}
          {nfapiImportResult && <section className="nfapi-import-result">
            <header><Check size={17} /><div><b>{isAgentIdentityResult ? "NFapi Agent Identity 已完成" : "NFapi OAuth 已完成"}</b><small>{isAgentIdentityResult
              ? nfapiImportResult.action === "created" ? "已创建 Agent Identity 账号" : nfapiImportResult.action === "skipped" ? "已有同一账号，按策略跳过" : "已更新 Agent Identity 凭据"
              : nfapiImportResult.action === "created" ? "已通过添加账号创建 OAuth 账号" : nfapiImportResult.action === "skipped" ? "NFapi 已有同一账号，按设置跳过" : "已通过 OAuth 更新账号凭据"}</small></div></header>
            <div className="nfapi-result-metrics"><span><b>{isAgentIdentityResult ? "Agent Identity" : "OAuth"}</b>授权方式</span><span><b>{isAgentIdentityResult ? "长期" : nfapiImportResult.short_lived ? "短期" : "长期"}</b>凭据状态</span><span><b>{nfapiImportResult.nfapi_account_id ? `#${nfapiImportResult.nfapi_account_id}` : "-"}</b>NFapi 账号</span></div>
          </section>}
          {nfapiBatchResult && <NfapiBatchImportResult result={nfapiBatchResult} />}

          {nfapiOAuthSession && <div className={`nfapi-oauth-workspace ${nfapiMailboxOpen ? "mailbox-open" : ""}`}>
            <section className="nfapi-oauth-flow">
              <header><ShieldCheck size={18} /><div><h3>NFapi 添加账号 OAuth</h3><p>配置已锁定，授权会话将在 {formatDate(nfapiOAuthSession.expires_at)} 过期</p></div><IconButton className="nfapi-mailbox-toggle" icon={nfapiMailboxOpen ? EyeOff : Mail} label={nfapiMailboxOpen ? "隐藏验证码邮箱" : "查看验证码邮箱"} size={32} aria-pressed={nfapiMailboxOpen} onClick={() => setNfapiMailboxOpen((current) => !current)} /></header>
              <div className={`nfapi-oauth-session-warning ${nfapiOAuthExpired ? "expired" : ""}`}><AlertTriangle size={15} /><span><b>{nfapiOAuthExpired ? "授权链接已过期" : "登录页点击无反应？"}</b><small>{nfapiOAuthExpired ? "请重新生成授权链接，旧页面不能继续使用。" : "先关闭旧页面并重新生成链接；新页面仍无反应时，是 OpenAI Sentinel 安全脚本未加载，请切换网络或稍后重试。"}</small></span></div>
              <ol>
                <li><span>1</span><div><b>复制登录账号</b><small>授权时请使用当前注册邮箱；可通过原邮箱验证码登录，有密码时也可使用密码，不要切换其他账号。</small><Button size="sm" icon={ClipboardCopy} disabled={!nfapiSelectedAccount?.email} onClick={() => copyRegisteredAccount(nfapiSelectedAccount)}>{nfapiSelectedAccount?.password_available ? "复制账号和密码" : "复制邮箱"}</Button></div></li>
                <li><span>2</span><div><b>打开 OpenAI OAuth</b><small>完成登录和授权后，浏览器会跳转到 localhost 回调地址。</small><div className="nfapi-oauth-link-actions">{nfapiOAuthExpired ? <Button size="sm" icon={ExternalLink} disabled>授权链接已过期</Button> : <a className="button button-primary button-sm nfapi-oauth-link" href={nfapiOAuthSession.auth_url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} /><span>打开 OAuth 授权登录</span></a>}<Button size="sm" icon={RefreshCw} loading={restartingNfapiOAuth} disabled={importingNfapi} onClick={restartNfapiOAuth}>重新生成授权链接</Button></div></div></li>
                <li><span>3</span><div><b>粘贴完整回调地址</b><small>复制浏览器地址栏中以 http://localhost:1455/auth/callback 开头的完整地址，提交后由 NFapi 兑换凭据并添加账号。</small><textarea rows="4" spellCheck="false" value={nfapiCallbackUrl} onChange={(event) => setNfapiCallbackUrl(event.target.value)} placeholder="http://localhost:1455/auth/callback?code=...&state=..." /></div></li>
              </ol>
            </section>
            {nfapiMailboxOpen && <OAuthMailboxPanel email={nfapiSelectedAccount?.email || nfapiMailboxData?.email} data={nfapiMailboxData} loading={nfapiMailboxLoading} error={nfapiMailboxError} updatedAt={nfapiMailboxUpdatedAt} onRefresh={() => loadNfapiMailbox()} onClose={() => setNfapiMailboxOpen(false)} onCopyCode={copyNfapiVerificationCode} />}
          </div>}

          {!nfapiOAuthSession && !nfapiImportResult && !nfapiBatchResult && <><section className="nfapi-import-section"><header><SlidersHorizontal size={17} /><div><h3>基本与调度</h3><p>这些设置会在导入完成后应用到 NFapi 账号</p></div></header><div className={`form-grid ${nfapiImportIds.length === 1 ? "four" : "three"}`}>{nfapiImportIds.length === 1 && <FormField label="账号名称" hint="留空时使用本地名称"><input maxLength={120} value={nfapiForm.account_name} onChange={(event) => setNfapiForm({ ...nfapiForm, account_name: event.target.value })} placeholder="此账号在 NFapi 中的名称" /></FormField>}<FormField label="名称前缀" hint="添加到 NFapi 账号名称前"><input maxLength={80} value={nfapiForm.name_prefix} onChange={(event) => setNfapiForm({ ...nfapiForm, name_prefix: event.target.value })} placeholder="例如：AliasHub-日本" /></FormField><FormField label="账号状态"><select value={nfapiForm.status} onChange={(event) => setNfapiForm({ ...nfapiForm, status: event.target.value })}><option value="active">启用</option><option value="inactive">停用</option><option value="error">错误</option></select></FormField><FormField label="NFapi 代理"><select value={nfapiForm.proxy_id} onChange={(event) => setNfapiForm({ ...nfapiForm, proxy_id: event.target.value })}><option value="">不绑定代理</option>{nfapiProxies.map((item) => { const id = item.id ?? item.value; return <option key={id} value={id}>{item.name || item.label || item.url || `代理 #${id}`}</option>; })}</select></FormField></div><FormField label="备注"><textarea rows="2" maxLength={2000} value={nfapiForm.notes} onChange={(event) => setNfapiForm({ ...nfapiForm, notes: event.target.value })} placeholder="写入 NFapi 账号备注" /></FormField><div className="form-grid four"><FormField label="并发数"><input type="number" min="1" max="1000" step="1" value={nfapiForm.concurrency} onChange={(event) => setNfapiForm({ ...nfapiForm, concurrency: event.target.value })} /></FormField><FormField label="负载系数"><input type="number" min="0" max="10000" step="1" value={nfapiForm.load_factor} onChange={(event) => setNfapiForm({ ...nfapiForm, load_factor: event.target.value })} /></FormField><FormField label="优先级"><input type="number" min="0" max="10000" step="1" value={nfapiForm.priority} onChange={(event) => setNfapiForm({ ...nfapiForm, priority: event.target.value })} /></FormField><FormField label="计费倍率"><input type="number" min="0" max="1000" step="0.01" value={nfapiForm.rate_multiplier} onChange={(event) => setNfapiForm({ ...nfapiForm, rate_multiplier: event.target.value })} /></FormField></div>{nfapiImportMode === "oauth" ? <div className="form-grid two"><FormField label="凭据过期时间" hint="留空时使用 Token 自带过期时间"><input type="datetime-local" value={nfapiForm.expires_at} onChange={(event) => setNfapiForm({ ...nfapiForm, expires_at: event.target.value })} /></FormField><div className="nfapi-toggle-grid compact"><label><input type="checkbox" checked={nfapiForm.auto_pause_on_expired} onChange={(event) => setNfapiForm({ ...nfapiForm, auto_pause_on_expired: event.target.checked })} /><span><b>过期自动暂停</b><small>凭据过期后退出调度</small></span></label></div></div> : <div className="inline-alert"><Fingerprint size={15} /><span>Agent Identity 不使用 OAuth Token 过期时间；NFapi 会在每次上游请求时动态签名。</span></div>}</section>

          <section className="nfapi-import-section"><header><Network size={17} /><div><h3>协议与客户端</h3><p>控制 OpenAI 请求转发及 Codex 客户端范围</p></div></header><div className="form-grid three"><FormField label="WebSocket 模式"><select value={nfapiForm.ws_mode} onChange={(event) => setNfapiForm({ ...nfapiForm, ws_mode: event.target.value })}><option value="off">关闭</option><option value="ctx_pool">Context Pool</option><option value="passthrough">透传</option><option value="http_bridge">HTTP Bridge</option></select></FormField><FormField label="Compact 模式"><select value={nfapiForm.compact_mode} onChange={(event) => setNfapiForm({ ...nfapiForm, compact_mode: event.target.value })}><option value="auto">自动</option><option value="force_on">强制开启</option><option value="force_off">强制关闭</option></select></FormField><FormField label="图片桥接"><select value={nfapiForm.image_bridge_mode} onChange={(event) => setNfapiForm({ ...nfapiForm, image_bridge_mode: event.target.value })}><option value="inherit">跟随 NFapi 默认值</option><option value="enabled">启用</option><option value="disabled">禁用</option></select></FormField></div><div className="nfapi-toggle-grid"><label><input type="checkbox" checked={nfapiForm.openai_passthrough} onChange={(event) => setNfapiForm({ ...nfapiForm, openai_passthrough: event.target.checked })} /><span><b>OpenAI 请求透传</b><small>原样转发兼容字段</small></span></label><label><input type="checkbox" checked={nfapiForm.codex_cli_only} onChange={(event) => setNfapiForm({ ...nfapiForm, codex_cli_only: event.target.checked, ...(event.target.checked ? {} : { allow_app_server: false }) })} /><span><b>仅 Codex 官方客户端</b><small>限制非 Codex 客户端使用</small></span></label><label className={!nfapiForm.codex_cli_only ? "disabled" : ""}><input type="checkbox" disabled={!nfapiForm.codex_cli_only} checked={nfapiForm.allow_app_server} onChange={(event) => setNfapiForm({ ...nfapiForm, allow_app_server: event.target.checked })} /><span><b>允许 app-server</b><small>纳入 Codex app-server 客户端</small></span></label></div></section>

          <section className="nfapi-import-section"><header><Database size={17} /><div><h3>模型映射</h3><p>使用 JSON 对象配置普通请求与 Compact 请求映射</p></div></header><div className="form-grid two"><FormField label="模型映射 JSON" hint='格式：{"请求模型":"目标模型"}'><textarea className="nfapi-json-editor" rows="6" spellCheck="false" value={nfapiForm.model_mapping} onChange={(event) => setNfapiForm({ ...nfapiForm, model_mapping: event.target.value })} /></FormField><FormField label="Compact 模型映射 JSON" hint='格式：{"请求模型":"Compact 模型"}'><textarea className="nfapi-json-editor" rows="6" spellCheck="false" value={nfapiForm.compact_model_mapping} onChange={(event) => setNfapiForm({ ...nfapiForm, compact_model_mapping: event.target.value })} /></FormField></div></section>

          <section className="nfapi-import-section"><header><CircleStop size={17} /><div><h3>暂停规则</h3><p>按错误响应临时退出调度，并配置 5h / 7d 用量阈值</p></div></header><div className="nfapi-toggle-grid"><label><input type="checkbox" checked={nfapiForm.temp_unschedulable_enabled} onChange={(event) => setNfapiForm({ ...nfapiForm, temp_unschedulable_enabled: event.target.checked })} /><span><b>启用临时不可调度</b><small>错误码和关键词同时命中时触发</small></span></label><label><input type="checkbox" checked={nfapiForm.auto_pause_5h_disabled} onChange={(event) => setNfapiForm({ ...nfapiForm, auto_pause_5h_disabled: event.target.checked })} /><span><b>禁用 5h 自动暂停</b><small>忽略 5h 用量窗口</small></span></label><label><input type="checkbox" checked={nfapiForm.auto_pause_7d_disabled} onChange={(event) => setNfapiForm({ ...nfapiForm, auto_pause_7d_disabled: event.target.checked })} /><span><b>禁用 7d 自动暂停</b><small>忽略 7d 用量窗口</small></span></label></div><FormField label="临时不可调度规则 JSON" hint='数组项支持 error_code、keywords、duration_minutes、description'><textarea className="nfapi-json-editor" rows="6" disabled={!nfapiForm.temp_unschedulable_enabled} spellCheck="false" value={nfapiForm.temp_unschedulable_rules} onChange={(event) => setNfapiForm({ ...nfapiForm, temp_unschedulable_rules: event.target.value })} /></FormField><div className="form-grid two"><FormField label="5h 用量阈值（%）" hint="留空使用 NFapi 全局默认"><input type="number" min="0.01" max="100" step="0.1" disabled={nfapiForm.auto_pause_5h_disabled} value={nfapiForm.auto_pause_5h_threshold} onChange={(event) => setNfapiForm({ ...nfapiForm, auto_pause_5h_threshold: event.target.value })} placeholder="全局默认" /></FormField><FormField label="7d 用量阈值（%）" hint="留空使用 NFapi 全局默认"><input type="number" min="0.01" max="100" step="0.1" disabled={nfapiForm.auto_pause_7d_disabled} value={nfapiForm.auto_pause_7d_threshold} onChange={(event) => setNfapiForm({ ...nfapiForm, auto_pause_7d_threshold: event.target.value })} placeholder="全局默认" /></FormField></div></section>

          <section className="nfapi-import-section"><header><UserPlus size={17} /><div><h3>分组与导入策略</h3><p>可绑定多个 NFapi 分组；已有账号可用本次凭据更新</p></div></header>{nfapiGroups.length ? <div className="nfapi-group-picker">{nfapiGroups.map((item) => { const id = String(item.id ?? item.value); const checked = nfapiForm.group_ids.includes(id); return <label key={id}><input type="checkbox" checked={checked} onChange={() => setNfapiForm({ ...nfapiForm, group_ids: checked ? nfapiForm.group_ids.filter((value) => value !== id) : [...nfapiForm.group_ids, id] })} /><span><b>{item.name || item.label || `分组 #${id}`}</b>{item.description && <small>{item.description}</small>}</span></label>; })}</div> : <div className="nfapi-empty-options">NFapi 没有可选分组</div>}<div className="nfapi-toggle-grid"><label><input type="checkbox" checked={nfapiForm.update_existing} onChange={(event) => setNfapiForm({ ...nfapiForm, update_existing: event.target.checked })} /><span><b>更新已有账号</b><small>存在同一 workspace 时用本次凭据更新账号</small></span></label><label><input type="checkbox" checked={nfapiForm.skip_default_group_bind} onChange={(event) => setNfapiForm({ ...nfapiForm, skip_default_group_bind: event.target.checked })} /><span><b>跳过默认分组</b><small>只绑定上面明确选择的分组</small></span></label><label><input type="checkbox" checked={nfapiForm.confirm_mixed_channel_risk} onChange={(event) => setNfapiForm({ ...nfapiForm, confirm_mixed_channel_risk: event.target.checked })} /><span><b>确认混合渠道风险</b><small>仅在所选组混合 OAuth 与 API Key 时使用</small></span></label><label><input type="checkbox" checked={nfapiForm.save_defaults} onChange={(event) => setNfapiForm({ ...nfapiForm, save_defaults: event.target.checked })} /><span><b>保存为下次默认值</b><small>不保存本次账号 ID 和授权结果</small></span></label></div></section></>}
        </div>}
      </Modal>

      <Modal
        open={Boolean(editingAccount)}
        onClose={() => { if (!savingAccountMetadata) setEditingAccount(null); }}
        title="编辑账号名称和分组"
        description={editingAccount?.email}
        size="sm"
        footer={<><Button disabled={savingAccountMetadata} onClick={() => setEditingAccount(null)}>取消</Button><Button variant="primary" icon={Save} loading={savingAccountMetadata} onClick={saveAccountMetadata}>保存</Button></>}
      >
        <div className="form-stack registration-account-edit-form">
          <FormField label="账号名称" hint="仅作为账号池中的自定义名称，不会修改邮箱或注册身份"><input maxLength={60} value={accountEditForm.custom_name} onChange={(event) => setAccountEditForm({ ...accountEditForm, custom_name: event.target.value })} placeholder="例如：日本主账号" /></FormField>
          <FormField label="自定义分组" hint="留空则按套餐自动分组；填写后优先使用自定义分组"><input list="registration-account-groups" maxLength={40} value={accountEditForm.custom_group_name} onChange={(event) => setAccountEditForm({ ...accountEditForm, custom_group_name: event.target.value })} placeholder={accountGroupMeta(editingAccount || {}).defaultName ? `留空使用：${accountGroupMeta(editingAccount).defaultName}` : "例如：长期使用"} /></FormField>
          {!accountEditForm.custom_group_name.trim() && accountGroupMeta(editingAccount || {}).defaultName && <div className="registration-auto-group-preview"><span>保存后分组</span><b>{accountGroupMeta(editingAccount).defaultName}</b><em>自动</em></div>}
          <datalist id="registration-account-groups">{customAccountGroups.map((group) => <option key={group} value={group} />)}</datalist>
        </div>
      </Modal>
      <Modal open={Boolean(logJob)} onClose={() => { setLogJob(null); setLogs(null); }} title="注册日志" description={logJob?.email} size="lg">
        {!logs ? <LoadingBlock rows={6} /> : logs.length ? <div className="registration-log-list">{logs.map((item, index) => <div className={item.level === "error" ? "error" : ""} key={item.id || index}><time>{item.created_at ? formatDate(item.created_at) : String(index + 1).padStart(2, "0")}</time><span>{item.message || item.detail?.message || JSON.stringify(item.detail || item)}</span></div>)}</div> : <EmptyState icon={ScrollText} title="暂无任务日志" />}
      </Modal>
      <ConfirmDialog open={Boolean(releaseTarget)} onClose={() => { if (!releasing) setReleaseTarget(null); }} onConfirm={releaseJob} loading={releasing} danger title="强制释放这个注册任务？" description={releaseTarget ? `将先请求 Frcibly 停止任务 ${releaseTarget.email}，随后只把本地注册记录标记为已中断或已取消。不会删除分裂邮箱、账号凭据或任何已经注册成功的 ChatGPT 账号。` : ""} confirmText="释放任务" />
      <ConfirmDialog open={Boolean(deleteTarget)} onClose={() => { if (!deleting) setDeleteTarget(null); }} onConfirm={removeSelected} loading={deleting} danger title={deleteTitle} description={deleteTarget ? deleteDescription : ""} confirmText={deletingAccounts ? "删除本地账号" : "删除记录"} />
    </div>
  );
}
