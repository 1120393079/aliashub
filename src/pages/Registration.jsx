import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Ban, Cable, Check, CircleStop, ClipboardCopy, Copy, Database, ExternalLink, Eye, EyeOff, Fingerprint, Globe2, KeyRound, ListChecks, LoaderCircle, Mail, Monitor, Network, Pencil, Play, RefreshCw, Save, ScrollText, Server, ShieldCheck, SlidersHorizontal, Trash2, UserPlus } from "lucide-react";
import { api } from "../api.js";
import { Button, ConfirmDialog, EmptyState, FormField, IconButton, LoadingBlock, Modal, Segmented, StatusBadge, useToast } from "../components.jsx";
import { copyText, formatDate, relativeTime } from "../utils.js";

const statusText = {
  queued: "排队中",
  running: "注册中",
  completed: "注册成功",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  cancel_requested: "取消中",
};
const deletableStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);
const releasableStatuses = new Set(["queued", "pending", "claimed", "running", "cancel_requested"]);
const nfapiStatusText = {
  not_imported: "未授权",
  pending: "待 OAuth",
  importing: "OAuth 中",
  created: "已创建",
  imported: "已导入",
  updated: "已更新",
  skipped: "已跳过",
  failed: "失败",
};
const nfapiStatusBadge = {
  pending: "queued",
  importing: "queued",
  created: "active",
  imported: "active",
  updated: "active",
  skipped: "warning",
  failed: "failed",
};
const accountAvailabilityMeta = {
  available: { label: "可用", badge: "active" },
  unavailable: { label: "失效", badge: "failed" },
  unchecked: { label: "待检测", badge: "queued" },
};
const accountTypeText = {
  free: "Free",
  plus: "Plus",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
  trial: "Trial",
  subscribed: "订阅",
  eligible: "可开通",
  unknown: "类型待检测",
};
const nfapiImportDefaults = {
  name_prefix: "",
  account_name: "",
  notes: "",
  status: "active",
  model_mapping: "{}",
  proxy_id: "",
  concurrency: 1,
  load_factor: 1,
  priority: 0,
  rate_multiplier: 1,
  expires_at: "",
  auto_pause_on_expired: true,
  temp_unschedulable_enabled: false,
  temp_unschedulable_rules: "[]",
  ws_mode: "off",
  openai_passthrough: false,
  codex_cli_only: false,
  allow_app_server: false,
  compact_mode: "auto",
  compact_model_mapping: "{}",
  image_bridge_mode: "inherit",
  auto_pause_5h_disabled: false,
  auto_pause_5h_threshold: "",
  auto_pause_7d_disabled: false,
  auto_pause_7d_threshold: "",
  group_ids: [],
  update_existing: false,
  skip_default_group_bind: false,
  confirm_mixed_channel_risk: false,
  save_defaults: false,
};

function jsonText(value, fallback) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  return fallback;
}

function importFormFromDefaults(defaults = {}) {
  const threshold = (value) => value === undefined || value === null || value === "" ? "" : Number(value);
  return {
    ...nfapiImportDefaults,
    ...defaults,
    proxy_id: defaults.proxy_id ?? "",
    group_ids: Array.isArray(defaults.group_ids) ? defaults.group_ids.map(String) : [],
    model_mapping: jsonText(defaults.model_mapping, "{}"),
    compact_model_mapping: jsonText(defaults.compact_model_mapping, "{}"),
    temp_unschedulable_rules: jsonText(defaults.temp_unschedulable_rules, "[]"),
    auto_pause_5h_threshold: threshold(defaults.auto_pause_5h_threshold),
    auto_pause_7d_threshold: threshold(defaults.auto_pause_7d_threshold),
    save_defaults: false,
  };
}

function apiId(value) {
  return /^\d+$/.test(String(value)) ? Number(value) : value;
}

function normalizeProxyDraft(text) {
  const proxies = [];
  const errors = [];
  const duplicateLines = [];
  const sourceLines = [];
  const seen = new Map();

  String(text || "").split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const source = raw.trim();
    if (!source || source.startsWith("#")) return;
    const reject = (reason) => errors.push({ line, reason });
    if (/[\u0000-\u001f\u007f-\u009f]/.test(source) || /\s|\\/.test(source)) {
      reject("地址中不能包含空格、换行或反斜杠");
      return;
    }

    let proxy = source;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(proxy)) {
      const providerParts = proxy.match(/^([^:/?#@]+):(\d{1,5}):([^:]+):(.+)$/);
      if (providerParts) {
        const [, host, rawPort] = providerParts;
        const port = Number(rawPort);
        let parsedHost;
        try { parsedHost = new URL(`http://${host}:${rawPort}`); } catch {
          reject("四段式代理的主机名无效");
          return;
        }
        if (!parsedHost.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
          reject("四段式代理必须使用 host:port:user:password，端口范围为 1-65535");
          return;
        }
        if (seen.has(proxy)) {
          duplicateLines.push({ line, originalLine: seen.get(proxy) });
          return;
        }
        seen.set(proxy, line);
        proxies.push(proxy);
        sourceLines.push(line);
        return;
      } else {
        proxy = `http://${proxy}`;
      }
    }

    let parsed;
    try { parsed = new URL(proxy); } catch {
      reject("无法解析；请使用 URL 或 host:port:user:password 格式");
      return;
    }
    if (!new Set(["http:", "https:", "socks5:"]).has(parsed.protocol)) {
      reject("仅支持 http、https 和无认证 socks5");
      return;
    }
    const authority = proxy.slice(proxy.indexOf("://") + 3);
    if (!parsed.hostname || authority.search(/[/?#]/) >= 0) {
      reject("代理地址不能包含路径、查询参数或片段");
      return;
    }
    const atCount = [...authority].filter((char) => char === "@").length;
    if (atCount > 1) {
      reject("认证信息包含未转义的 @");
      return;
    }
    const userInfo = atCount === 1 ? authority.slice(0, authority.indexOf("@")) : "";
    const hostPort = atCount === 1 ? authority.slice(authority.indexOf("@") + 1) : authority;
    const portMatch = hostPort.startsWith("[")
      ? hostPort.match(/^\[[^\]]+\]:(\d+)$/)
      : hostPort.match(/^[^:]+:(\d+)$/);
    const port = Number(portMatch?.[1]);
    if (!portMatch || !Number.isInteger(port) || port < 1 || port > 65535) {
      reject("必须包含 1-65535 范围内的端口");
      return;
    }
    const parsedHostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
    const domain = parsedHostname.endsWith(".") ? parsedHostname.slice(0, -1) : parsedHostname;
    if (!domain || parsedHostname.includes("%") || domain.split(".").some((label) => !label)) {
      reject("主机名或 IP 地址无效");
      return;
    }
    if (atCount === 1) {
      if (parsed.protocol === "socks5:") {
        reject("socks5 暂不支持用户名密码认证");
        return;
      }
      const separator = userInfo.indexOf(":");
      if (separator <= 0 || separator === userInfo.length - 1) {
        reject("用户名和密码必须同时填写");
        return;
      }
      try {
        const credentials = `${decodeURIComponent(userInfo.slice(0, separator))}${decodeURIComponent(userInfo.slice(separator + 1))}`;
        if (/[\u0000-\u001f\u007f-\u009f]/.test(credentials)) throw new Error("invalid credentials");
      } catch {
        reject("用户名或密码包含无效转义字符");
        return;
      }
    }

    const normalized = `${parsed.protocol}//${authority}`;
    if (seen.has(normalized)) {
      duplicateLines.push({ line, originalLine: seen.get(normalized) });
      return;
    }
    seen.set(normalized, line);
    proxies.push(normalized);
    sourceLines.push(line);
  });

  return { proxies, errors, duplicateLines, sourceLines };
}

function normalizeProxySample(item = {}) {
  return {
    ip: String(item.ip || item.exit_ip || item.query || "").trim(),
    country_name: String(item.country_name || item.country || item.region_name || "").trim(),
    country_code: String(item.country_code || item.countryCode || item.country_code2 || "").trim().toUpperCase(),
    locale: String(item.locale || "").trim(),
    timezone: String(item.timezone || item.time_zone || "").trim(),
  };
}

function proxyMetadataLabel(metadata = {}) {
  const details = metadata || {};
  const mode = String(details.dynamic_mode || "").toLowerCase();
  if (mode === "sticky_session") return `动态 · ${details.session_ttl || "会话"} 粘性`;
  if (mode) return "动态出口";
  return "";
}

function proxySelectLabel(masked, metadata) {
  const detail = proxyMetadataLabel(metadata);
  return detail ? `${masked}（${detail}）` : masked;
}

function nfapiAccountState(item) {
  const details = item.nfapi || {};
  const status = item.nfapi_status || details.status || "not_imported";
  const shortLived = Boolean(item.nfapi_short_lived ?? details.short_lived);
  return {
    label: nfapiStatusText[status] || status,
    badge: shortLived && nfapiStatusBadge[status] === "active" ? "warning" : (nfapiStatusBadge[status] || "inactive"),
    shortLived,
    accountId: item.nfapi_account_id || details.account_id || "",
    error: item.nfapi_error || details.last_error || "",
    updatedAt: item.nfapi_updated_at || details.updated_at || "",
  };
}

function preferredBase(account) {
  return account?.bases.find((item) => item.registration_state === "available")
    || account?.bases.find((item) => item.registration_state === "warning")
    || account?.bases[0];
}

function baseOptionLabel(item) {
  if (item.registration_state === "likely_exhausted") return `${item.address}（疑似已占用）`;
  if (item.registration_state === "warning") return `${item.address}（有占用冲突）`;
  if (item.registration_success_count) return `${item.address}（已成功 ${item.registration_success_count}）`;
  return item.address;
}

function jobStatusLabel(job) {
  return job.failure_reason === "user_already_exists" ? "邮箱已占用" : (statusText[job.status] || job.status);
}

function ageFromBirth(value) {
  if (!value) return "-";
  const birth = new Date(value);
  if (!Number.isFinite(birth.getTime())) return "-";
  const now = new Date();
  return now.getFullYear() - birth.getFullYear() - (now < new Date(now.getFullYear(), birth.getMonth(), birth.getDate()) ? 1 : 0);
}

function PasswordCell({ value, status, error, available, onCopy }) {
  const [visible, setVisible] = useState(false);
  if (!available) {
    const label = status === "not_configured"
      ? "未设置"
      : status === "failed" ? "设置失败" : status === "configured" ? "已设置" : "未确认";
    return <span className={`registration-password-state status-${status || "unknown"}`} title={error || label}><b>{label}</b>{status === "failed" && error && <small>{error}</small>}</span>;
  }
  return <div className="registration-secret"><code>{visible ? value : "••••••••••••"}</code><button title={visible ? "隐藏密码" : "显示密码"} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={14} /> : <Eye size={14} />}</button><button title="复制密码" onClick={onCopy}><Copy size={14} /></button></div>;
}

function AccessTokenCell({ available, loading, onCopy }) {
  return <div className="registration-secret"><code>{available ? "••••••••••••" : "未获取"}</code><button disabled={!available || loading} title={available ? "复制 AccessToken (AT)" : "尚未获取 AT"} onClick={onCopy}>{loading ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}</button></div>;
}

function AccountSignalCell({ item, compact = false }) {
  const remoteStatus = String(item.display_status || item.lifecycle_status || item.status || "unknown").toLowerCase();
  const fallbackAvailability = new Set(["invalid", "expired", "banned", "disabled", "deactivated", "inactive"]).has(remoteStatus)
    ? "unavailable"
    : new Set(["active", "registered", "valid", "trial", "subscribed"]).has(remoteStatus) ? "available" : "unchecked";
  const availability = accountAvailabilityMeta[item.availability] ? item.availability : fallbackAvailability;
  const meta = accountAvailabilityMeta[availability];
  const rawType = String(item.account_type || item.plan_name || item.plan_state || "unknown").trim().toLowerCase();
  const typeLabel = accountTypeText[rawType]
    || rawType.replace(/[_-]+/g, " ").replace(/^\w/, (value) => value.toUpperCase());
  const checkedAt = item.status_checked_at || "";
  const title = [
    `状态：${meta.label}`,
    `类型：${typeLabel}`,
    item.display_status && `display=${item.display_status}`,
    item.lifecycle_status && `lifecycle=${item.lifecycle_status}`,
    item.validity_status && `validity=${item.validity_status}`,
    item.status_source && `来源=${item.status_source}`,
  ].filter(Boolean).join(" · ");
  return <div className={`registration-account-signal ${compact ? "compact" : ""}`} title={title}><div><StatusBadge status={meta.badge}>{meta.label}</StatusBadge><span className="registration-account-type">{typeLabel}</span></div><small>{checkedAt ? `检测 ${relativeTime(checkedAt)}` : "等待自动检测"}</small></div>;
}

function JobCommands({ job, onLogs, onCancel, onRelease, onDelete }) {
  const cancellable = job.status === "queued" || job.status === "running";
  const releasable = releasableStatuses.has(job.status);
  return <div className="row-actions"><button className="registration-row-command" title="查看日志" onClick={() => onLogs(job)}><ScrollText size={15} /></button>{cancellable && <button className="registration-row-command danger" title="请求取消任务" onClick={() => onCancel(job.id)}><Ban size={15} /></button>}{releasable && <button className="registration-row-command warning" title="强制释放任务" onClick={() => onRelease(job)}><CircleStop size={15} /></button>}{deletableStatuses.has(job.status) && <button className="registration-row-command danger" title="删除注册记录" onClick={() => onDelete(job)}><Trash2 size={15} /></button>}</div>;
}

function OAuthMailboxPanel({ email, data, loading, error, updatedAt, onRefresh, onClose, onCopyCode }) {
  const emails = data?.emails || [];
  const initialError = Boolean(error && !data);
  const footerState = initialError
    ? "读取失败"
    : updatedAt ? `更新于 ${relativeTime(updatedAt)}` : loading ? "正在连接邮箱" : "尚未更新";
  return (
    <aside className="nfapi-oauth-mailbox" aria-label={`${email || "当前账号"}的验证码邮箱`} aria-busy={loading}>
      <header>
        <div className="nfapi-mailbox-title"><Mail size={17} /><span><b>验证码邮箱</b><small title={email}>{email}</small></span></div>
        <div className="nfapi-mailbox-actions">
          <IconButton className={loading ? "spin-icon" : ""} icon={loading ? LoaderCircle : RefreshCw} label="刷新当前邮箱" size={30} disabled={loading} onClick={onRefresh} />
          <IconButton icon={EyeOff} label="隐藏验证码邮箱" size={30} onClick={onClose} />
        </div>
      </header>
      <div className="nfapi-mailbox-content" aria-live="polite">
        {!data && loading && !error ? <LoadingBlock rows={5} /> : initialError ? <div className="nfapi-mailbox-empty failed"><AlertTriangle size={22} /><b>邮箱读取失败</b><span>{error}</span><Button size="sm" icon={RefreshCw} loading={loading} onClick={onRefresh}>立即重试</Button></div> : <>
          {error && <div className="nfapi-mailbox-error"><AlertTriangle size={14} /><span>{error}</span></div>}
          {emails.length ? <div className="nfapi-mail-list" role="list">{emails.map((item, index) => (
          <article className="nfapi-mail-item" role="listitem" key={item.id || item.message_id || `${item.date}-${index}`}>
            <header><b title={item.from || "OpenAI"}>{item.from || "OpenAI"}</b><time dateTime={item.date}>{relativeTime(item.date)}</time></header>
            {item.verification_code && <button className="nfapi-mail-code" type="button" title="复制验证码" aria-label={`复制验证码 ${item.verification_code}`} onClick={() => onCopyCode(item.verification_code)}><span>{item.verification_code}</span><Copy size={14} /></button>}
            <strong>{item.subject || "（无主题）"}</strong>
            <p>{item.body_preview || item.preview || item.text || "没有邮件预览"}</p>
          </article>
          ))}</div> : <div className="nfapi-mailbox-empty"><Mail size={22} /><b>等待验证码邮件</b><span>打开 OAuth 登录后，新邮件会自动出现在这里。</span></div>}
        </>}
      </div>
      <footer><span>{footerState}</span><small>{error ? "每 4 秒自动重试" : "每 4 秒自动刷新"}</small></footer>
    </aside>
  );
}

export default function RegistrationPage({ refreshKey }) {
  const [view, setView] = useState("tasks");
  const [options, setOptions] = useState(null);
  const [jobs, setJobs] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [accountsError, setAccountsError] = useState("");
  const [form, setForm] = useState({ accountId: "", baseAddressId: "", count: 1, suffix: "", browserMode: "headed", proxySelection: "auto", autoContinuePostSignup: true, setPasswordAfterRegistration: false, password: "" });
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
  const [accountGroupFilter, setAccountGroupFilter] = useState("all");
  const [editingAccount, setEditingAccount] = useState(null);
  const [accountEditForm, setAccountEditForm] = useState({ custom_name: "", group_name: "" });
  const [savingAccountMetadata, setSavingAccountMetadata] = useState(false);
  const [nfapiImportIds, setNfapiImportIds] = useState([]);
  const [nfapiOptions, setNfapiOptions] = useState(null);
  const [nfapiForm, setNfapiForm] = useState(nfapiImportDefaults);
  const [loadingNfapiOptions, setLoadingNfapiOptions] = useState(false);
  const [importingNfapi, setImportingNfapi] = useState(false);
  const [restartingNfapiOAuth, setRestartingNfapiOAuth] = useState(false);
  const [nfapiImportResult, setNfapiImportResult] = useState(null);
  const [nfapiAccountSnapshot, setNfapiAccountSnapshot] = useState(null);
  const [nfapiOAuthSession, setNfapiOAuthSession] = useState(null);
  const [nfapiOAuthNow, setNfapiOAuthNow] = useState(() => Date.now());
  const [nfapiCallbackUrl, setNfapiCallbackUrl] = useState("");
  const [nfapiMailboxOpen, setNfapiMailboxOpen] = useState(false);
  const [nfapiMailboxData, setNfapiMailboxData] = useState(null);
  const [nfapiMailboxLoading, setNfapiMailboxLoading] = useState(false);
  const [nfapiMailboxError, setNfapiMailboxError] = useState("");
  const [nfapiMailboxUpdatedAt, setNfapiMailboxUpdatedAt] = useState("");
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
    const data = await api("/api/registration/options");
    setOptions(data);
    setProxyText((current) => current || (data.proxies || []).join("\n"));
    setForm((current) => {
      const accountId = current.accountId || String(data.accounts[0]?.id || "");
      const account = data.accounts.find((item) => String(item.id) === accountId) || data.accounts[0];
      const validBase = account?.bases.some((item) => String(item.id) === current.baseAddressId);
      const proxyMatch = current.proxySelection?.match(/^proxy:(\d+)$/);
      const proxySelection = proxyMatch && Number(proxyMatch[1]) >= data.proxies.length ? "auto" : (current.proxySelection || "auto");
      return { ...current, accountId, baseAddressId: validBase ? current.baseAddressId : String(preferredBase(account)?.id || ""), proxySelection };
    });
    setProxyInspectIndex((current) => current !== "" && Number(current) < data.proxies.length ? current : (data.proxies.length ? "0" : ""));
  }, []);

  const loadJobs = useCallback(async () => {
    try { setJobs((await api("/api/registration/jobs?limit=200")).items); } catch (error) { toast(error.message, "error"); }
  }, [toast]);

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await api("/api/registration/accounts"));
      setAccountsError("");
    } catch (error) {
      setAccounts((current) => current || { total: 0, items: [] });
      setAccountsError(error.message || "注册账号加载失败");
    }
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
    Promise.all([loadOptions(), loadJobs(), loadAccounts()]).catch((error) => toast(error.message, "error"));
  }, [loadOptions, loadJobs, loadAccounts, refreshKey, toast]);

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
    const timer = window.setInterval(() => Promise.all([loadJobs(), loadAccounts()]), 3_000);
    return () => window.clearInterval(timer);
  }, [jobs, loadJobs, loadAccounts]);

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
  const activeJobs = jobs?.filter((item) => releasableStatuses.has(item.status)).length || 0;
  const deletableJobIds = jobs?.filter((item) => deletableStatuses.has(item.status)).map((item) => item.id) || [];
  const allJobsSelected = deletableJobIds.length > 0 && deletableJobIds.every((id) => selectedJobIds.includes(id));
  const accountGroups = useMemo(() => [...new Set((accounts?.items || []).map((item) => item.group_name).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "zh-CN")), [accounts]);
  const visibleAccountItems = useMemo(() => {
    const items = accounts?.items || [];
    if (accountGroupFilter === "all") return items;
    if (accountGroupFilter === "ungrouped") return items.filter((item) => !item.group_name);
    const groupName = accountGroupFilter.startsWith("group:") ? accountGroupFilter.slice(6) : "";
    return items.filter((item) => item.group_name === groupName);
  }, [accounts, accountGroupFilter]);
  const accountIds = visibleAccountItems.map((item) => item.id);
  const allAccountsSelected = accountIds.length > 0 && accountIds.every((id) => selectedAccountIds.includes(id));
  const selectedAccounts = visibleAccountItems.filter((item) => selectedAccountIds.includes(item.id));

  const changeAccount = (accountId) => {
    const account = options.accounts.find((item) => String(item.id) === accountId);
    setForm({ ...form, accountId, baseAddressId: String(preferredBase(account)?.id || "") });
  };

  const start = async () => {
    setStarting(true);
    try {
      const response = await api("/api/registration/jobs", { method: "POST", body: form });
      const submitted = response.items.filter((item) => item.status !== "failed").length;
      toast(`已创建 ${response.items.length} 个邮箱，提交 ${submitted} 个注册任务`);
      setView("tasks");
      await Promise.all([loadJobs(), loadOptions()]);
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
    try { await api(`/api/registration/jobs/${id}/cancel`, { method: "POST" }); toast("注册任务已取消"); await loadJobs(); }
    catch (error) { toast(error.message, "error"); }
  };

  const releaseJob = async () => {
    if (!releaseTarget) return;
    setReleasing(true);
    try {
      const result = await api(`/api/registration/jobs/${releaseTarget.id}/release`, { method: "POST" });
      const label = result.item?.status === "cancelled" ? "已取消并释放" : "已强制释放";
      toast(`${releaseTarget.email} ${label}`);
      setReleaseTarget(null);
      await Promise.all([loadJobs(), loadAccounts()]);
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
      await Promise.all([loadJobs(), loadAccounts()]);
    } catch (error) { toast(error.message, "error"); } finally { setDeleting(false); }
  };

  const toggleJob = (id) => setSelectedJobIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const toggleAllJobs = () => setSelectedJobIds(allJobsSelected ? [] : deletableJobIds);
  const toggleAccount = (id) => setSelectedAccountIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const toggleAllAccounts = () => setSelectedAccountIds(allAccountsSelected ? [] : accountIds);
  const changeAccountGroupFilter = (value) => {
    setAccountGroupFilter(value);
    setSelectedAccountIds([]);
  };

  const openAccountEditor = (item) => {
    setEditingAccount(item);
    setAccountEditForm({ custom_name: item.custom_name || "", group_name: item.group_name || "" });
  };

  const saveAccountMetadata = async () => {
    if (!editingAccount) return;
    setSavingAccountMetadata(true);
    try {
      await api(`/api/registration/accounts/${editingAccount.id}`, {
        method: "PATCH",
        body: accountEditForm,
      });
      toast("账号名称和分组已保存");
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
    if (ids.length !== 1) {
      toast("SUB2 OAuth 每次只能授权一个账号", "error");
      return;
    }
    const target = accounts?.items.find((item) => String(item.id) === String(ids[0]));
    if (!target?.id || !target.email) {
      toast("选择的注册账号已不存在，请刷新后重试", "error");
      return;
    }
    setNfapiImportIds([target.id]);
    setNfapiAccountSnapshot(target);
    setNfapiOptions(null);
    setNfapiImportResult(null);
    setNfapiOAuthSession(null);
    setNfapiCallbackUrl("");
    resetNfapiMailbox();
    setLoadingNfapiOptions(true);
    try {
      const result = await api("/api/nfapi/options");
      setNfapiOptions(result);
      setNfapiForm(importFormFromDefaults(result.defaults));
    } catch (error) {
      setNfapiOptions({ connection: { connected: false }, groups: [], proxies: [], error: error.message });
      toast(error.message, "error");
    } finally {
      setLoadingNfapiOptions(false);
    }
  };

  const closeNfapiImporter = () => {
    if (importingNfapi || restartingNfapiOAuth) return;
    setNfapiImportIds([]);
    setNfapiOptions(null);
    setNfapiImportResult(null);
    setNfapiAccountSnapshot(null);
    setNfapiOAuthSession(null);
    setNfapiCallbackUrl("");
    resetNfapiMailbox();
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
      expires_at: nfapiForm.expires_at || null,
      auto_pause_on_expired: Boolean(nfapiForm.auto_pause_on_expired),
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
    if (!nfapiImportIds.length || !nfapiSelectedAccount?.id || !nfapiSelectedAccount?.email) {
      toast("OAuth 目标账号已不存在，请关闭后重新选择", "error");
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
        toast(result.action === "created" ? "SUB2 OAuth 账号已创建" : result.action === "skipped" ? "SUB2 已有该账号，已跳过" : "SUB2 OAuth 凭据已更新");
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
        toast("SUB2 已存在该账号，已按当前策略跳过");
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
        throw new Error("SUB2 兼容服务没有返回新的 OAuth 授权链接");
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
  const passwordSetupRunning = Boolean(passwordSetupTask && !passwordSetupTask.terminal);
  const deleteCount = deleteTarget?.ids?.length || 0;
  const deleteTitle = deletingAccounts
    ? (deleteCount > 1 ? `删除选中的 ${deleteCount} 个注册账号？` : "删除这个注册账号？")
    : (deleteCount > 1 ? `删除选中的 ${deleteCount} 条注册记录？` : "删除这条注册记录？");
  const deleteDescription = deletingAccounts
    ? "将从本地账号池删除账号、密码（如有）、AT、Cookie 等凭据；不会注销官方 ChatGPT 账号。注册记录、分裂邮箱、邮件和验证码都会保留。"
    : "只从注册记录列表中移除所选记录。已注册账号、账号凭据、分裂邮箱和验证码都会保留。";

  return (
    <div className="page-stack registration-page">
      <div className="registration-summary">
        <span><Server size={16} /><b>注册服务</b><StatusBadge status={options.service?.ok ? "active" : "failed"}>{options.service?.ok ? "运行中" : "未连接"}</StatusBadge></span>
        <span><LoaderCircle size={16} /><b>执行中</b><strong>{activeJobs}</strong></span>
        <span><Check size={16} /><b>注册成功</b><strong>{accounts.total}</strong></span>
        <span><Network size={16} /><b>代理池</b><strong>{options.proxies.length}</strong></span>
      </div>

      <Segmented value={view} onChange={setView} ariaLabel="注册视图" items={[
        { value: "tasks", label: "注册任务", icon: ListChecks, count: jobs.length },
        { value: "accounts", label: "注册账号", icon: KeyRound, count: accounts.total },
        { value: "proxies", label: "IP 代理池", icon: Network, count: options.proxies.length },
      ]} />

      {view === "tasks" && <>
        <section className="registration-control-grid">
          <article className="panel registration-launch-panel">
            <header className="panel-header"><div><h2>创建邮箱注册任务</h2><p>自动生成独立分裂邮箱，并使用全新随机指纹环境</p></div><Fingerprint size={20} /></header>
            <div className="registration-launch-form">
              <div className="form-grid two">
                <FormField label="源头邮箱"><select value={form.accountId} onChange={(event) => changeAccount(event.target.value)}><option value="">请选择</option>{options.accounts.map((item) => <option key={item.id} value={item.id}>{item.email}</option>)}</select></FormField>
                <FormField label="基础地址"><select value={form.baseAddressId} onChange={(event) => setForm({ ...form, baseAddressId: event.target.value })}><option value="">请选择</option>{selectedAccount?.bases.map((item) => <option key={item.id} value={item.id}>{baseOptionLabel(item)}</option>)}</select></FormField>
              </div>
              {selectedBase?.registration_hint && <div className="inline-alert warning"><AlertTriangle size={16} /><span>{selectedBase.registration_hint}</span></div>}
              <div className="form-grid two">
                <FormField label="注册数量" hint={form.suffix.trim() ? "批量注册会自动追加 -01、-02 编号" : "留空后缀时，每个账号生成随机分裂邮箱"}><input type="number" min="1" max="20" value={form.count} onChange={(event) => setForm({ ...form, count: Number(event.target.value) })} /></FormField>
                <FormField label="浏览器模式"><select value={form.browserMode} onChange={(event) => setForm({ ...form, browserMode: event.target.value })}><option value="headed">内嵌指纹浏览器</option><option value="headless" disabled={!form.autoContinuePostSignup}>后台指纹浏览器</option></select></FormField>
              </div>
              <div className="form-grid two">
                <FormField label="邮箱分裂后缀" hint="例如 campaign；不填写则随机生成"><input maxLength={24} value={form.suffix} onChange={(event) => setForm({ ...form, suffix: event.target.value })} placeholder="留空自动随机" /></FormField>
                <FormField label="注册代理" hint="可固定使用某个已保存代理，也可自动轮换或直连"><select value={form.proxySelection} onChange={(event) => setForm({ ...form, proxySelection: event.target.value })}><option value="auto">自动轮换代理池（{options.proxies.length}）</option>{options.maskedProxies.map((item, index) => <option key={`${item}-${index}`} value={`proxy:${index}`}>固定使用：{proxySelectLabel(item, options.proxyMetadata?.[index])}</option>)}<option value="direct">直连（不使用代理）</option></select></FormField>
              </div>
              <div className="fresh-browser-note"><Fingerprint size={17} /><span><b>仅邮箱验证，每次全新地域指纹</b><small>清空 Cookie · 随机 OS/屏幕/Canvas/WebGL/设备参数 · 语言、时区和地理位置匹配实际出口 IP；官方强制要求手机号时任务停止</small></span></div>
              <div className="registration-option-stack">
                <label className="registration-password-option"><input type="checkbox" checked={form.autoContinuePostSignup} onChange={(event) => setForm({ ...form, autoContinuePostSignup: event.target.checked, ...(event.target.checked ? {} : { browserMode: "headed" }) })} /><span><b>自动点击准备完成页“继续”</b><small>取消勾选后，任务会在内嵌浏览器等待你手动点击，最长 5 分钟。</small></span></label>
                <label className="registration-password-option"><input type="checkbox" checked={form.setPasswordAfterRegistration} onChange={(event) => setForm({ ...form, setPasswordAfterRegistration: event.target.checked, ...(event.target.checked ? {} : { password: "" }) })} /><span><b>注册后设置密码</b><small>未勾选时，仅在官网注册流程强制要求密码时设置；勾选后会进入 ChatGPT 安全设置并再次读取邮箱验证码。</small></span></label>
              </div>
              <FormField label="指定密码（可选）" hint="填写后使用此密码；留空时由注册服务随机生成。长度 12-128 个字符，不能包含首尾空白。"><input type="password" autoComplete="new-password" minLength={12} maxLength={128} disabled={!form.setPasswordAfterRegistration} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={form.setPasswordAfterRegistration ? "留空自动生成随机密码" : "请先勾选注册后设置密码"} /></FormField>
              <Button variant="primary" size="lg" icon={Play} loading={starting} disabled={!form.accountId || !form.baseAddressId || !options.service?.ok} onClick={start}>开始注册</Button>
            </div>
          </article>

          <article className="panel registration-browser-panel">
            <header className="panel-header"><div><h2>内嵌指纹浏览器</h2><p>查看 Camoufox 当前注册过程</p></div><Button size="sm" icon={Monitor} onClick={() => setBrowserOpen(!browserOpen)}>{browserOpen ? "收起" : "打开"}</Button></header>
            {browserOpen ? <div className="registration-browser-frame"><iframe src={options.browserUrl} title="注册指纹浏览器" allow="clipboard-read; clipboard-write" /></div> : <EmptyState icon={Monitor} title="浏览器画面已收起" action={<Button onClick={() => setBrowserOpen(true)}>重新打开</Button>} />}
          </article>
        </section>

        <section className="table-panel registration-task-panel">
          <header className="panel-header"><div><h2>注册记录</h2><p>邮箱、身份、代理出口和注册结果</p></div><Button size="sm" onClick={loadJobs}>刷新</Button></header>
          {jobs.length ? <>
            <div className="registration-bulk-bar">
              <label><input type="checkbox" checked={allJobsSelected} disabled={!deletableJobIds.length} onChange={toggleAllJobs} />全选可删除记录</label>
              <span>已选择 <b>{selectedJobIds.length}</b> 条</span>
              <Button size="sm" variant="danger" icon={Trash2} disabled={!selectedJobIds.length} onClick={() => setDeleteTarget({ kind: "jobs", ids: selectedJobIds })}>删除所选</Button>
            </div>
            <div className="data-table-wrap"><table className="data-table"><thead><tr><th className="select-column"><input type="checkbox" aria-label="选择全部可删除注册记录" checked={allJobsSelected} disabled={!deletableJobIds.length} onChange={toggleAllJobs} /></th><th>注册邮箱</th><th>随机身份</th><th>指纹会话</th><th>代理 / 出口 IP</th><th>状态</th><th>创建时间</th><th aria-label="操作" /></tr></thead><tbody>{jobs.map((job) => {
              const selectable = deletableStatuses.has(job.status);
              const checked = selectedJobIds.includes(job.id);
              return <tr className={checked ? "selected-row" : ""} key={job.id}><td className="select-column"><input type="checkbox" aria-label={`选择 ${job.email}`} checked={checked} disabled={!selectable} onChange={() => toggleJob(job.id)} /></td><td><button className="registration-email-button" onClick={() => copyText(job.email).then(() => toast("邮箱已复制"))}>{job.email}<Copy size={13} /></button><small className="registration-source">{job.source_email || "源邮箱已删除"}</small></td><td><div className="registration-identity"><b>{job.display_name || "等待生成"}</b><small>{job.birth_date ? `${job.birth_date} · ${ageFromBirth(job.birth_date)} 岁` : "姓名和年龄自动随机"}</small></div></td><td><code className="fingerprint-code">{job.fingerprint_id}</code><small className="registration-source">{job.browser_mode === "headed" ? "内嵌 Camoufox" : "后台 Camoufox"}</small></td><td><div className="registration-identity"><b>{job.proxy_label}</b><small>{job.exit_ip ? `出口 ${job.exit_ip}` : "等待识别出口 IP"}</small></div></td><td><div className="registration-status"><StatusBadge status={job.status}>{jobStatusLabel(job)}</StatusBadge>{job.failure_reason === "user_already_exists" && <small>建议更换基础地址</small>}</div></td><td><span className="muted-cell">{formatDate(job.created_at)}</span></td><td><JobCommands job={job} onLogs={openLogs} onCancel={cancel} onRelease={setReleaseTarget} onDelete={(item) => setDeleteTarget({ kind: "job", ids: [item.id], item })} /></td></tr>;
            })}</tbody></table></div>
            <div className="registration-mobile-list">{jobs.map((job) => {
              const selectable = deletableStatuses.has(job.status);
              const checked = selectedJobIds.includes(job.id);
              return <article className={checked ? "selected" : ""} key={job.id}><header><input type="checkbox" aria-label={`选择 ${job.email}`} checked={checked} disabled={!selectable} onChange={() => toggleJob(job.id)} /><StatusBadge status={job.status}>{jobStatusLabel(job)}</StatusBadge><time>{formatDate(job.created_at)}</time></header><button onClick={() => copyText(job.email).then(() => toast("邮箱已复制"))}>{job.email}<Copy size={14} /></button><dl><div><dt>身份</dt><dd>{job.display_name || "等待生成"}</dd></div><div><dt>出口 IP</dt><dd>{job.exit_ip || "等待识别"}</dd></div><div><dt>代理</dt><dd>{job.proxy_label}</dd></div></dl><footer><span>{job.display_message || job.message || "-"}</span><JobCommands job={job} onLogs={openLogs} onCancel={cancel} onRelease={setReleaseTarget} onDelete={(item) => setDeleteTarget({ kind: "job", ids: [item.id], item })} /></footer></article>;
            })}</div>
            <div className="table-footer"><span>共 {jobs.length} 个注册任务</span></div>
          </> : <EmptyState icon={UserPlus} title="还没有注册任务" description="选择源头邮箱和基础地址后开始注册。" />}
        </section>
      </>}

      {view === "accounts" && <section className="table-panel registration-account-panel">
        <header className="panel-header"><div><h2>已注册账号</h2><p>使用原邮箱补设密码，也可通过可选的 SUB2 兼容服务添加账号 OAuth 授权</p></div><Button size="sm" onClick={loadAccounts}>刷新</Button></header>
        {accounts.items.length ? <>
          {accountsError && <div className="inline-alert error"><AlertTriangle size={15} /><span>{accountsError}；当前保留上一次成功加载的账号列表。</span></div>}
          <div className="registration-bulk-bar">
            <label><input type="checkbox" checked={allAccountsSelected} disabled={!accountIds.length} onChange={toggleAllAccounts} />全选当前账号</label>
            <select className="compact-select registration-group-filter" aria-label="按账号分组筛选" value={accountGroupFilter} onChange={(event) => changeAccountGroupFilter(event.target.value)}>
              <option value="all">全部分组（{accounts.total}）</option>
              <option value="ungrouped">未分组</option>
              {accountGroups.map((group) => <option key={group} value={`group:${group}`}>{group}</option>)}
            </select>
            <span>已选择 <b>{selectedAccountIds.length}</b> 个</span>
            <Button size="sm" icon={Database} disabled={selectedAccountIds.length !== 1} title={selectedAccountIds.length > 1 ? "OAuth 每次只能授权一个账号" : "通过 OAuth 添加到 SUB2"} onClick={() => openNfapiImporter(selectedAccountIds)}>OAuth 添加到 SUB2</Button>
            <Button size="sm" icon={KeyRound} loading={copyingSelectedTokens} disabled={!selectedAccountIds.length} onClick={copySelectedAccessTokens}>复制所选 AT</Button>
            <Button size="sm" variant="danger" icon={Trash2} disabled={!selectedAccountIds.length} onClick={() => setDeleteTarget({ kind: "accounts", ids: selectedAccountIds })}>删除所选</Button>
          </div>
          {visibleAccountItems.length ? <>
            <div className="data-table-wrap"><table className="data-table registration-accounts-table"><thead><tr><th className="select-column"><input type="checkbox" aria-label="选择当前分组全部注册账号" checked={allAccountsSelected} disabled={!accountIds.length} onChange={toggleAllAccounts} /></th><th>名称 / 分组</th><th>邮箱</th><th>密码</th><th>AccessToken (AT)</th><th>出口 IP</th><th>姓名 / 年龄</th><th>状态 / 类型</th><th>SUB2</th><th>创建时间</th><th aria-label="操作" /></tr></thead><tbody>{visibleAccountItems.map((item) => {
              const checked = selectedAccountIds.includes(item.id);
              const nfapiState = nfapiAccountState(item);
              return <tr className={checked ? "selected-row" : ""} key={item.id}><td className="select-column"><input type="checkbox" aria-label={`选择 ${item.email}`} checked={checked} onChange={() => toggleAccount(item.id)} /></td><td><div className="registration-account-meta"><b title={item.custom_name || "未命名"}>{item.custom_name || "未命名"}</b><small title={item.group_name || "未分组"}>{item.group_name || "未分组"}</small></div></td><td><b>{item.email}</b></td><td><PasswordCell value={item.password} status={item.password_status} error={item.password_error} available={item.password_available} onCopy={() => copyText(item.password).then(() => toast("密码已复制"))} /></td><td><AccessTokenCell available={item.access_token_available} loading={copyingTokenId === item.id} onCopy={() => copyAccessToken(item)} /></td><td><code className="registration-exit-ip">{item.exit_ip || "未记录"}</code></td><td><div className="registration-identity"><b>{item.display_name || "-"}</b><small>{item.birth_date ? `${item.birth_date} · ${ageFromBirth(item.birth_date)} 岁` : "-"}</small></div></td><td><AccountSignalCell item={item} /></td><td><div className="registration-nfapi-status" title={nfapiState.error || nfapiState.accountId || nfapiState.label}><StatusBadge status={nfapiState.badge}>{nfapiState.label}</StatusBadge>{nfapiState.shortLived && <small>短期凭据</small>}{nfapiState.accountId && <code>#{nfapiState.accountId}</code>}{nfapiState.error && <small className="error">{nfapiState.error}</small>}</div></td><td><span className="muted-cell">{formatDate(item.created_at)}</span></td><td><div className="row-actions"><button className="registration-row-command" disabled={item.password_available || !item.password_setup_available} title={item.password_available ? "密码已配置" : item.password_setup_reason || "使用原邮箱设置密码"} onClick={() => openPasswordSetup(item)}><ShieldCheck size={15} /></button><button className="registration-row-command" title="通过 OAuth 添加或更新 SUB2" onClick={() => openNfapiImporter([item.id])}><Database size={15} /></button><button className="registration-row-command" title="编辑名称和分组" onClick={() => openAccountEditor(item)}><Pencil size={15} /></button><button className="registration-row-command" title={item.password_available ? "复制账号和密码" : "复制邮箱"} onClick={() => copyRegisteredAccount(item)}><ClipboardCopy size={15} /></button><button className="registration-row-command danger" title="删除本地账号" onClick={() => setDeleteTarget({ kind: "account", ids: [item.id], item })}><Trash2 size={15} /></button></div></td></tr>;
            })}</tbody></table></div>
            <div className="registration-mobile-list">{visibleAccountItems.map((item) => {
              const checked = selectedAccountIds.includes(item.id);
              const nfapiState = nfapiAccountState(item);
              return <article className={checked ? "selected" : ""} key={item.id}><header><input type="checkbox" aria-label={`选择 ${item.email}`} checked={checked} onChange={() => toggleAccount(item.id)} /><AccountSignalCell item={item} compact /><time>{formatDate(item.created_at)}</time></header><div className="registration-account-meta registration-account-meta-mobile"><b>{item.custom_name || "未命名"}</b><small>{item.group_name || "未分组"}</small></div><button onClick={() => copyText(item.email).then(() => toast("邮箱已复制"))}>{item.email}<Copy size={14} /></button><PasswordCell value={item.password} status={item.password_status} error={item.password_error} available={item.password_available} onCopy={() => copyText(item.password).then(() => toast("密码已复制"))} /><AccessTokenCell available={item.access_token_available} loading={copyingTokenId === item.id} onCopy={() => copyAccessToken(item)} /><div className="registration-mobile-facts"><div className="registration-account-exit"><Globe2 size={14} /><span><small>出口 IP</small><b>{item.exit_ip || "未记录"}</b></span></div><div className="registration-account-exit"><Database size={14} /><span><small>SUB2</small><b>{nfapiState.label}{nfapiState.shortLived ? " · 短期凭据" : ""}</b></span></div></div>{nfapiState.error && <div className="inline-alert error"><AlertTriangle size={14} /><span>{nfapiState.error}</span></div>}<footer><span>{item.display_name || "未记录姓名"}</span><div className="row-actions"><button className="registration-row-command" disabled={item.password_available || !item.password_setup_available} title={item.password_available ? "密码已配置" : item.password_setup_reason || "使用原邮箱设置密码"} onClick={() => openPasswordSetup(item)}><ShieldCheck size={15} /></button><button className="registration-row-command" title="通过 OAuth 添加或更新 SUB2" onClick={() => openNfapiImporter([item.id])}><Database size={15} /></button><button className="registration-row-command" title="编辑名称和分组" onClick={() => openAccountEditor(item)}><Pencil size={15} /></button><Button size="sm" icon={ClipboardCopy} onClick={() => copyRegisteredAccount(item)}>{item.password_available ? "复制账号" : "复制邮箱"}</Button><button className="registration-row-command danger" title="删除本地账号" onClick={() => setDeleteTarget({ kind: "account", ids: [item.id], item })}><Trash2 size={15} /></button></div></footer></article>;
            })}</div>
          </> : <EmptyState icon={KeyRound} title="这个分组还没有账号" action={<Button onClick={() => changeAccountGroupFilter("all")}>查看全部账号</Button>} />}
          <div className="table-footer"><span>当前 {visibleAccountItems.length} 个，共 {accounts.total} 个注册账号</span></div>
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
        title="OAuth 添加到 SUB2"
        description={nfapiSelectedAccount?.email || "选择一个注册账号"}
        size="xl"
        footer={<><Button disabled={importingNfapi || restartingNfapiOAuth} onClick={closeNfapiImporter}>关闭</Button><Button variant="primary" icon={nfapiOAuthSession ? ShieldCheck : Database} loading={importingNfapi} disabled={restartingNfapiOAuth || loadingNfapiOptions || !nfapiConnected || !nfapiSelectedAccount?.id || !nfapiSelectedAccount?.email || Boolean(nfapiImportResult) || nfapiOAuthExpired} onClick={submitNfapiImport}>{nfapiOAuthSession ? "提交回调到 SUB2" : "生成 OAuth 授权链接"}</Button></>}
      >
        {loadingNfapiOptions ? <LoadingBlock rows={9} /> : nfapiOptions && <div className="nfapi-import-form">
          <div className={`nfapi-import-connection ${nfapiConnected ? "connected" : ""}`}><Cable size={18} /><span><b>{nfapiConnected ? "SUB2 兼容服务已连接" : "SUB2 兼容服务未连接（可选）"}</b><small>{nfapiOptions.connection?.base_url || nfapiOptions.connection?.url || nfapiOptions.error || "此功能为可选；需要导入账号时，请先到系统设置配置服务地址与管理员 API Key"}</small></span><StatusBadge status={nfapiConnected ? "active" : "inactive"}>{nfapiConnected ? "可以导入" : "未启用导入"}</StatusBadge></div>
          {nfapiOptions.error && <div className="inline-alert error"><AlertTriangle size={15} /><span>{nfapiOptions.error}</span></div>}
          {!nfapiSelectedAccount ? <div className="inline-alert error"><AlertTriangle size={15} /><span>OAuth 目标账号已不存在，请关闭弹窗并刷新账号列表后重新选择。</span></div> : !nfapiSelectedAccount.password_available && <div className="inline-alert"><AlertTriangle size={15} /><span>本地尚未保存该账号密码，仍可继续配置并发起 OAuth；登录时可使用原邮箱验证码，或使用账号已有密码。</span></div>}
          {nfapiImportResult && <section className="nfapi-import-result"><header><Check size={17} /><div><b>SUB2 OAuth 已完成</b><small>{nfapiImportResult.action === "created" ? "已通过添加账号创建 OAuth 账号" : nfapiImportResult.action === "skipped" ? "SUB2 已有同一账号，按设置跳过" : "已通过 OAuth 更新账号凭据"}</small></div></header><div className="nfapi-result-metrics"><span><b>OAuth</b>授权方式</span><span><b>{nfapiImportResult.short_lived ? "短期" : "长期"}</b>凭据状态</span><span><b>{nfapiImportResult.nfapi_account_id ? `#${nfapiImportResult.nfapi_account_id}` : "-"}</b>SUB2 账号</span></div></section>}

          {nfapiOAuthSession && <div className={`nfapi-oauth-workspace ${nfapiMailboxOpen ? "mailbox-open" : ""}`}>
            <section className="nfapi-oauth-flow">
              <header><ShieldCheck size={18} /><div><h3>SUB2 添加账号 OAuth</h3><p>配置已锁定，授权会话将在 {formatDate(nfapiOAuthSession.expires_at)} 过期</p></div><IconButton className="nfapi-mailbox-toggle" icon={nfapiMailboxOpen ? EyeOff : Mail} label={nfapiMailboxOpen ? "隐藏验证码邮箱" : "查看验证码邮箱"} size={32} aria-pressed={nfapiMailboxOpen} onClick={() => setNfapiMailboxOpen((current) => !current)} /></header>
              <div className={`nfapi-oauth-session-warning ${nfapiOAuthExpired ? "expired" : ""}`}><AlertTriangle size={15} /><span><b>{nfapiOAuthExpired ? "授权链接已过期" : "登录页点击无反应？"}</b><small>{nfapiOAuthExpired ? "请重新生成授权链接，旧页面不能继续使用。" : "先关闭旧页面并重新生成链接；新页面仍无反应时，是 OpenAI Sentinel 安全脚本未加载，请切换网络或稍后重试。"}</small></span></div>
              <ol>
                <li><span>1</span><div><b>复制登录账号</b><small>授权时请使用当前注册邮箱；可通过原邮箱验证码登录，有密码时也可使用密码，不要切换其他账号。</small><Button size="sm" icon={ClipboardCopy} disabled={!nfapiSelectedAccount?.email} onClick={() => copyRegisteredAccount(nfapiSelectedAccount)}>{nfapiSelectedAccount?.password_available ? "复制账号和密码" : "复制邮箱"}</Button></div></li>
                <li><span>2</span><div><b>打开 OpenAI OAuth</b><small>完成登录和授权后，浏览器会跳转到 localhost 回调地址。</small><div className="nfapi-oauth-link-actions">{nfapiOAuthExpired ? <Button size="sm" icon={ExternalLink} disabled>授权链接已过期</Button> : <a className="button button-primary button-sm nfapi-oauth-link" href={nfapiOAuthSession.auth_url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} /><span>打开 OAuth 授权登录</span></a>}<Button size="sm" icon={RefreshCw} loading={restartingNfapiOAuth} disabled={importingNfapi} onClick={restartNfapiOAuth}>重新生成授权链接</Button></div></div></li>
                <li><span>3</span><div><b>粘贴完整回调地址</b><small>复制浏览器地址栏中以 http://localhost:1455/auth/callback 开头的完整地址，提交后由 SUB2 兑换凭据并添加账号。</small><textarea rows="4" spellCheck="false" value={nfapiCallbackUrl} onChange={(event) => setNfapiCallbackUrl(event.target.value)} placeholder="http://localhost:1455/auth/callback?code=...&state=..." /></div></li>
              </ol>
            </section>
            {nfapiMailboxOpen && <OAuthMailboxPanel email={nfapiSelectedAccount?.email || nfapiMailboxData?.email} data={nfapiMailboxData} loading={nfapiMailboxLoading} error={nfapiMailboxError} updatedAt={nfapiMailboxUpdatedAt} onRefresh={() => loadNfapiMailbox()} onClose={() => setNfapiMailboxOpen(false)} onCopyCode={copyNfapiVerificationCode} />}
          </div>}

          {!nfapiOAuthSession && !nfapiImportResult && <><section className="nfapi-import-section"><header><SlidersHorizontal size={17} /><div><h3>基本与调度</h3><p>这些设置会在 OAuth 完成后应用到 SUB2 账号</p></div></header><div className={`form-grid ${nfapiImportIds.length === 1 ? "four" : "three"}`}>{nfapiImportIds.length === 1 && <FormField label="账号名称" hint="留空时使用本地名称"><input maxLength={120} value={nfapiForm.account_name} onChange={(event) => setNfapiForm({ ...nfapiForm, account_name: event.target.value })} placeholder="此账号在 SUB2 中的名称" /></FormField>}<FormField label="名称前缀" hint="添加到 SUB2 账号名称前"><input maxLength={80} value={nfapiForm.name_prefix} onChange={(event) => setNfapiForm({ ...nfapiForm, name_prefix: event.target.value })} placeholder="例如：AliasHub-日本" /></FormField><FormField label="账号状态"><select value={nfapiForm.status} onChange={(event) => setNfapiForm({ ...nfapiForm, status: event.target.value })}><option value="active">启用</option><option value="inactive">停用</option><option value="error">错误</option></select></FormField><FormField label="SUB2 代理"><select value={nfapiForm.proxy_id} onChange={(event) => setNfapiForm({ ...nfapiForm, proxy_id: event.target.value })}><option value="">不绑定代理</option>{nfapiProxies.map((item) => { const id = item.id ?? item.value; return <option key={id} value={id}>{item.name || item.label || item.url || `代理 #${id}`}</option>; })}</select></FormField></div><FormField label="备注"><textarea rows="2" maxLength={2000} value={nfapiForm.notes} onChange={(event) => setNfapiForm({ ...nfapiForm, notes: event.target.value })} placeholder="写入 SUB2 账号备注" /></FormField><div className="form-grid four"><FormField label="并发数"><input type="number" min="1" max="1000" step="1" value={nfapiForm.concurrency} onChange={(event) => setNfapiForm({ ...nfapiForm, concurrency: event.target.value })} /></FormField><FormField label="负载系数"><input type="number" min="0" max="10000" step="1" value={nfapiForm.load_factor} onChange={(event) => setNfapiForm({ ...nfapiForm, load_factor: event.target.value })} /></FormField><FormField label="优先级"><input type="number" min="0" max="10000" step="1" value={nfapiForm.priority} onChange={(event) => setNfapiForm({ ...nfapiForm, priority: event.target.value })} /></FormField><FormField label="计费倍率"><input type="number" min="0" max="1000" step="0.01" value={nfapiForm.rate_multiplier} onChange={(event) => setNfapiForm({ ...nfapiForm, rate_multiplier: event.target.value })} /></FormField></div><div className="form-grid two"><FormField label="凭据过期时间" hint="留空时使用 Token 自带过期时间"><input type="datetime-local" value={nfapiForm.expires_at} onChange={(event) => setNfapiForm({ ...nfapiForm, expires_at: event.target.value })} /></FormField><div className="nfapi-toggle-grid compact"><label><input type="checkbox" checked={nfapiForm.auto_pause_on_expired} onChange={(event) => setNfapiForm({ ...nfapiForm, auto_pause_on_expired: event.target.checked })} /><span><b>过期自动暂停</b><small>凭据过期后退出调度</small></span></label></div></div></section>

          <section className="nfapi-import-section"><header><Network size={17} /><div><h3>协议与客户端</h3><p>控制 OpenAI OAuth 请求转发及 Codex 客户端范围</p></div></header><div className="form-grid three"><FormField label="WebSocket 模式"><select value={nfapiForm.ws_mode} onChange={(event) => setNfapiForm({ ...nfapiForm, ws_mode: event.target.value })}><option value="off">关闭</option><option value="ctx_pool">Context Pool</option><option value="passthrough">透传</option><option value="http_bridge">HTTP Bridge</option></select></FormField><FormField label="Compact 模式"><select value={nfapiForm.compact_mode} onChange={(event) => setNfapiForm({ ...nfapiForm, compact_mode: event.target.value })}><option value="auto">自动</option><option value="force_on">强制开启</option><option value="force_off">强制关闭</option></select></FormField><FormField label="图片桥接"><select value={nfapiForm.image_bridge_mode} onChange={(event) => setNfapiForm({ ...nfapiForm, image_bridge_mode: event.target.value })}><option value="inherit">跟随 SUB2 默认值</option><option value="enabled">启用</option><option value="disabled">禁用</option></select></FormField></div><div className="nfapi-toggle-grid"><label><input type="checkbox" checked={nfapiForm.openai_passthrough} onChange={(event) => setNfapiForm({ ...nfapiForm, openai_passthrough: event.target.checked })} /><span><b>OpenAI OAuth 透传</b><small>原样转发兼容字段</small></span></label><label><input type="checkbox" checked={nfapiForm.codex_cli_only} onChange={(event) => setNfapiForm({ ...nfapiForm, codex_cli_only: event.target.checked, ...(event.target.checked ? {} : { allow_app_server: false }) })} /><span><b>仅 Codex 官方客户端</b><small>限制非 Codex 客户端使用</small></span></label><label className={!nfapiForm.codex_cli_only ? "disabled" : ""}><input type="checkbox" disabled={!nfapiForm.codex_cli_only} checked={nfapiForm.allow_app_server} onChange={(event) => setNfapiForm({ ...nfapiForm, allow_app_server: event.target.checked })} /><span><b>允许 app-server</b><small>纳入 Codex app-server 客户端</small></span></label></div></section>

          <section className="nfapi-import-section"><header><Database size={17} /><div><h3>模型映射</h3><p>使用 JSON 对象配置普通请求与 Compact 请求映射</p></div></header><div className="form-grid two"><FormField label="模型映射 JSON" hint='格式：{"请求模型":"目标模型"}'><textarea className="nfapi-json-editor" rows="6" spellCheck="false" value={nfapiForm.model_mapping} onChange={(event) => setNfapiForm({ ...nfapiForm, model_mapping: event.target.value })} /></FormField><FormField label="Compact 模型映射 JSON" hint='格式：{"请求模型":"Compact 模型"}'><textarea className="nfapi-json-editor" rows="6" spellCheck="false" value={nfapiForm.compact_model_mapping} onChange={(event) => setNfapiForm({ ...nfapiForm, compact_model_mapping: event.target.value })} /></FormField></div></section>

          <section className="nfapi-import-section"><header><CircleStop size={17} /><div><h3>暂停规则</h3><p>按错误响应临时退出调度，并配置 5h / 7d 用量阈值</p></div></header><div className="nfapi-toggle-grid"><label><input type="checkbox" checked={nfapiForm.temp_unschedulable_enabled} onChange={(event) => setNfapiForm({ ...nfapiForm, temp_unschedulable_enabled: event.target.checked })} /><span><b>启用临时不可调度</b><small>错误码和关键词同时命中时触发</small></span></label><label><input type="checkbox" checked={nfapiForm.auto_pause_5h_disabled} onChange={(event) => setNfapiForm({ ...nfapiForm, auto_pause_5h_disabled: event.target.checked })} /><span><b>禁用 5h 自动暂停</b><small>忽略 5h 用量窗口</small></span></label><label><input type="checkbox" checked={nfapiForm.auto_pause_7d_disabled} onChange={(event) => setNfapiForm({ ...nfapiForm, auto_pause_7d_disabled: event.target.checked })} /><span><b>禁用 7d 自动暂停</b><small>忽略 7d 用量窗口</small></span></label></div><FormField label="临时不可调度规则 JSON" hint='数组项支持 error_code、keywords、duration_minutes、description'><textarea className="nfapi-json-editor" rows="6" disabled={!nfapiForm.temp_unschedulable_enabled} spellCheck="false" value={nfapiForm.temp_unschedulable_rules} onChange={(event) => setNfapiForm({ ...nfapiForm, temp_unschedulable_rules: event.target.value })} /></FormField><div className="form-grid two"><FormField label="5h 用量阈值（%）" hint="留空使用 SUB2 全局默认"><input type="number" min="0.01" max="100" step="0.1" disabled={nfapiForm.auto_pause_5h_disabled} value={nfapiForm.auto_pause_5h_threshold} onChange={(event) => setNfapiForm({ ...nfapiForm, auto_pause_5h_threshold: event.target.value })} placeholder="全局默认" /></FormField><FormField label="7d 用量阈值（%）" hint="留空使用 SUB2 全局默认"><input type="number" min="0.01" max="100" step="0.1" disabled={nfapiForm.auto_pause_7d_disabled} value={nfapiForm.auto_pause_7d_threshold} onChange={(event) => setNfapiForm({ ...nfapiForm, auto_pause_7d_threshold: event.target.value })} placeholder="全局默认" /></FormField></div></section>

          <section className="nfapi-import-section"><header><UserPlus size={17} /><div><h3>分组与 OAuth 策略</h3><p>可绑定多个 SUB2 分组；已有账号也会重新完成 OAuth</p></div></header>{nfapiGroups.length ? <div className="nfapi-group-picker">{nfapiGroups.map((item) => { const id = String(item.id ?? item.value); const checked = nfapiForm.group_ids.includes(id); return <label key={id}><input type="checkbox" checked={checked} onChange={() => setNfapiForm({ ...nfapiForm, group_ids: checked ? nfapiForm.group_ids.filter((value) => value !== id) : [...nfapiForm.group_ids, id] })} /><span><b>{item.name || item.label || `分组 #${id}`}</b>{item.description && <small>{item.description}</small>}</span></label>; })}</div> : <div className="nfapi-empty-options">SUB2 没有可选分组</div>}<div className="nfapi-toggle-grid"><label><input type="checkbox" checked={nfapiForm.update_existing} onChange={(event) => setNfapiForm({ ...nfapiForm, update_existing: event.target.checked })} /><span><b>重新授权已有账号</b><small>存在同一 workspace 时用本次 OAuth 更新凭据</small></span></label><label><input type="checkbox" checked={nfapiForm.skip_default_group_bind} onChange={(event) => setNfapiForm({ ...nfapiForm, skip_default_group_bind: event.target.checked })} /><span><b>跳过默认分组</b><small>只绑定上面明确选择的分组</small></span></label><label><input type="checkbox" checked={nfapiForm.confirm_mixed_channel_risk} onChange={(event) => setNfapiForm({ ...nfapiForm, confirm_mixed_channel_risk: event.target.checked })} /><span><b>确认混合渠道风险</b><small>仅在所选组混合 OAuth 与 API Key 时使用</small></span></label><label><input type="checkbox" checked={nfapiForm.save_defaults} onChange={(event) => setNfapiForm({ ...nfapiForm, save_defaults: event.target.checked })} /><span><b>保存为下次默认值</b><small>不保存本次账号 ID 和授权结果</small></span></label></div></section></>}
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
          <FormField label="所属分组" hint="可选择已有分组，也可以直接输入新分组"><input list="registration-account-groups" maxLength={40} value={accountEditForm.group_name} onChange={(event) => setAccountEditForm({ ...accountEditForm, group_name: event.target.value })} placeholder="例如：长期使用" /></FormField>
          <datalist id="registration-account-groups">{accountGroups.map((group) => <option key={group} value={group} />)}</datalist>
        </div>
      </Modal>
      <Modal open={Boolean(logJob)} onClose={() => { setLogJob(null); setLogs(null); }} title="注册日志" description={logJob?.email} size="lg">
        {!logs ? <LoadingBlock rows={6} /> : logs.length ? <div className="registration-log-list">{logs.map((item, index) => <div className={item.level === "error" ? "error" : ""} key={item.id || index}><time>{item.created_at ? formatDate(item.created_at) : String(index + 1).padStart(2, "0")}</time><span>{item.message || item.detail?.message || JSON.stringify(item.detail || item)}</span></div>)}</div> : <EmptyState icon={ScrollText} title="暂无任务日志" />}
      </Modal>
      <ConfirmDialog open={Boolean(releaseTarget)} onClose={() => { if (!releasing) setReleaseTarget(null); }} onConfirm={releaseJob} loading={releasing} danger title="强制释放这个注册任务？" description={releaseTarget ? `将先请求兼容注册服务停止任务 ${releaseTarget.email}，随后只把本地注册记录标记为已中断或已取消。不会删除分裂邮箱、账号凭据或任何已经注册成功的 ChatGPT 账号。` : ""} confirmText="释放任务" />
      <ConfirmDialog open={Boolean(deleteTarget)} onClose={() => { if (!deleting) setDeleteTarget(null); }} onConfirm={removeSelected} loading={deleting} danger title={deleteTitle} description={deleteTarget ? deleteDescription : ""} confirmText={deletingAccounts ? "删除本地账号" : "删除记录"} />
    </div>
  );
}
