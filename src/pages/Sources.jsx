import { useEffect, useRef, useState } from "react";
import { AlertCircle, AtSign, CheckCircle2, ChevronDown, ClipboardPaste, ExternalLink, Globe2, KeyRound, ListPlus, LoaderCircle, Mail, Plus, ShieldCheck, Trash2, Unplug, Upload, WandSparkles } from "lucide-react";
import { api } from "../api.js";
import { Button, ConfirmDialog, EmptyState, FormField, IconButton, LoadingBlock, Modal, ProviderMark, Segmented, StatusBadge, useToast } from "../components.jsx";
import AliasSyncModal from "../AliasSyncModal.jsx";
import {
  accountSupportsImportedAliases,
  accountSupportsOfficialAliases,
  accountSupportsPlusAliases,
  normalizeProvider,
  providerMeta,
} from "../providers.js";
import { accountStatus, relativeTime } from "../utils.js";

const MicrosoftProviderIcon = ({ size }) => <ProviderMark provider="microsoft" size={size} />;
const GoogleProviderIcon = ({ size }) => <ProviderMark provider="google" size={size} />;
const ICloudProviderIcon = ({ size }) => <ProviderMark provider="icloud" size={size} />;
const MailComProviderIcon = ({ size }) => <ProviderMark provider="mailcom" size={size} />;

const SOURCE_PROVIDER_ITEMS = [
  { value: "microsoft", label: "Microsoft", icon: MicrosoftProviderIcon },
  { value: "google", label: "Google", icon: GoogleProviderIcon },
  { value: "icloud", label: "iCloud", icon: ICloudProviderIcon },
  { value: "mailcom", label: "mail.com", icon: MailComProviderIcon },
];

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function mailcomUsage(account) {
  const limit = Math.max(1, count(account?.official_limit) || 10);
  const aliases = count(account?.mailcom_aliases ?? account?.official_aliases);
  const used = Math.max(1, count(account?.official_used) || aliases + 1);
  return { aliases, used, limit, remaining: Math.max(0, limit - used) };
}

function latestScan(accounts) {
  const latest = accounts.map((account) => account.last_inbox_scan_at).filter(Boolean).sort().at(-1);
  return relativeTime(latest);
}

function providerSummaryStats(provider, accounts) {
  const connected = accounts.filter((account) => account.status === "connected").length;
  const total = (field) => accounts.reduce((sum, account) => sum + count(account[field]), 0);
  if (provider === "mailcom") {
    const usage = accounts.map(mailcomUsage);
    return [
      { label: "母号", value: accounts.length },
      { label: "已连接", value: connected },
      { label: "官方别名", value: usage.reduce((sum, item) => sum + item.aliases, 0) },
      { label: "剩余名额", value: usage.reduce((sum, item) => sum + item.remaining, 0) },
    ];
  }
  if (provider === "icloud") {
    return [
      { label: "账号", value: accounts.length },
      { label: "已连接", value: connected },
      { label: "邮箱别名", value: total("icloud_mail_aliases") },
      { label: "隐藏 / 自定义", value: total("icloud_hide_my_emails") + total("icloud_custom_domain_emails") },
    ];
  }
  if (provider === "google") {
    return [
      { label: "账号", value: accounts.length },
      { label: "已连接", value: connected },
      { label: "分裂地址", value: total("split_count") },
      { label: "最近扫描", value: latestScan(accounts) },
    ];
  }
  return [
    { label: "账号", value: accounts.length },
    { label: "已连接", value: connected },
    { label: "官方别名", value: total("official_aliases") },
    { label: "分裂地址", value: total("split_count") },
  ];
}

function normalizedMailcomDomains(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((domain) => String(domain || "").trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean))];
}

function ProviderGroup({ provider, accounts, expanded, onToggle, actions }) {
  const meta = providerMeta(provider);
  const regionId = `source-provider-${provider}-accounts`;
  return <article className={`source-provider-group source-provider-group-${provider}${expanded ? " is-expanded" : ""}`}>
    <div className="source-provider-summary-card">
      <button type="button" className="source-provider-summary-toggle" aria-expanded={expanded} aria-controls={regionId} onClick={onToggle}>
        <ProviderMark provider={provider} size={42} />
        <span className="source-provider-summary-copy"><b>{meta.name}</b><small>{meta.shortDescription}</small></span>
        <dl className="source-provider-summary-stats">{providerSummaryStats(provider, accounts).map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
        <span className="source-provider-summary-expand"><b>{accounts.length} 个账号</b><ChevronDown size={18} /></span>
      </button>
      {actions && <div className="source-provider-summary-actions">{actions}</div>}
    </div>
  </article>;
}

function ProviderExpanded({ provider, accounts, onCollapse, children }) {
  const meta = providerMeta(provider);
  return <section className={`source-provider-expanded source-provider-expanded-${provider}`} id={`source-provider-${provider}-accounts`}>
    <header className="source-provider-expanded-header"><ProviderMark provider={provider} size={30} /><span><b>{meta.name} 独立账号</b><small>{accounts.length} 个账号</small></span><Button size="sm" onClick={onCollapse}>收起</Button></header>
    {children}
  </section>;
}

function SourceAccountCard({ account, initialAccountId, operation, onAliasSync, onNavigate, onReconnect, onRemove }) {
  const accountMeta = providerMeta(account.provider);
  const supportsOfficial = accountSupportsOfficialAliases(account);
  const supportsPlus = accountSupportsPlusAliases(account);
  const supportsImported = accountSupportsImportedAliases(account);
  const isMailcom = accountMeta.id === "mailcom";
  const supportsAliases = isMailcom || supportsOfficial || supportsImported;
  const usage = mailcomUsage(account);
  const operationComplete = operation?.status === "completed";
  const operationPartial = operation?.partial;
  const operationQueued = operation?.status === "queued";
  const operationRunning = operation?.status === "running";
  const operationLocked = operationQueued || operationRunning;
  return <article id={`source-account-${account.id}`} className={`source-card source-card-${accountMeta.id}${Number(initialAccountId) === account.id ? " source-card-target" : ""}`}>
    <header><ProviderMark provider={accountMeta.id} size={38} /><div><h2>{account.display_name || account.email.split("@")[0]}</h2><p>{account.email}<span className="provider-name">{accountMeta.name}</span></p></div><StatusBadge status={account.status}>{accountStatus[account.status]}</StatusBadge></header>
    {isMailcom ? <div className="source-quota"><div><span>母号 / 官方分裂别名</span><b>{usage.used} <small>/ {usage.limit}</small></b></div><div className="quota-track"><i style={{ width: `${Math.min(100, usage.used / usage.limit * 100)}%` }} /></div><small>母号与别名合计最多 10 个地址；不支持 +tag / Plus 分裂</small></div> : supportsOfficial ? <div className="source-quota"><div><span>官方基础地址</span><b>{account.official_used} <small>/ {account.official_limit}</small></b></div><div className="quota-track"><i style={{ width: `${Math.min(100, account.official_used / account.official_limit * 100)}%` }} /></div><small>剩余 {account.official_remaining} 个记录名额，实际以 Microsoft 官网限制为准</small></div> : <div className="source-provider-capability">{supportsPlus ? <WandSparkles size={18} /> : supportsImported ? <AtSign size={18} /> : <KeyRound size={18} />}<span><b>{accountMeta.capabilityTitle}</b><small>{accountMeta.capabilityDescription}</small></span></div>}
    {isMailcom ? <dl className="source-stats"><div><dt>母号</dt><dd>1</dd></div><div><dt>官方分裂别名</dt><dd>{usage.aliases}</dd></div><div><dt>可直接注册</dt><dd>{usage.used} 个地址</dd></div><div><dt>收件扫描</dt><dd>{relativeTime(account.last_inbox_scan_at)}</dd></div></dl> : supportsImported ? <dl className="source-stats"><div><dt>邮箱别名</dt><dd>{account.icloud_mail_aliases || 0}</dd></div><div><dt>隐藏邮箱</dt><dd>{account.icloud_hide_my_emails || 0}</dd></div><div><dt>自定义域名</dt><dd>{account.icloud_custom_domain_emails || 0}</dd></div><div><dt>本地登记</dt><dd>{(account.icloud_mail_aliases || 0) + (account.icloud_hide_my_emails || 0) + (account.icloud_custom_domain_emails || 0)} 个可直接注册</dd></div></dl> : <dl className="source-stats"><div><dt>官方别名</dt><dd>{supportsAliases ? account.official_aliases : "不支持"}</dd></div><div><dt>分裂地址</dt><dd>{supportsPlus ? account.split_count : "不支持"}</dd></div><div><dt>收件扫描</dt><dd>{relativeTime(account.last_inbox_scan_at)}</dd></div><div><dt>{supportsOfficial ? "别名同步" : accountMeta.connectionLabel}</dt><dd>{supportsOfficial ? relativeTime(account.last_synced_at) : account.connection_connected ? "已连接" : "待连接"}</dd></div></dl>}
    {operation && <div className={`source-account-operation is-${operation.status}${operationPartial ? " is-partial" : ""}`} role="status">{operationRunning ? <LoaderCircle className="spin" size={16} /> : operationQueued ? <LoaderCircle size={16} /> : operationComplete ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}<span><b>{operationRunning ? "正在创建官方别名" : operationQueued ? "等待创建官方别名" : operationComplete ? `已新建 ${operation.created || 0} 个别名` : operationPartial ? `部分完成，新建 ${operation.created || 0} 个` : "创建失败"}</b>{operation.error && <small>{operation.error}</small>}</span></div>}
    {account.status === "action_required" && <div className="inline-alert warning"><AlertCircle size={15} /><span>{accountMeta.name} 连接需要更新</span><Button size="sm" onClick={() => onReconnect(account)}>{accountMeta.reconnectLabel}</Button></div>}
    {account.limit_reason && <div className="inline-alert warning"><AlertCircle size={15} /><span>{account.limit_reason}</span></div>}
    <footer>{isMailcom && <Button icon={AtSign} disabled={operationLocked} onClick={() => onAliasSync(account)}>管理别名</Button>}{supportsOfficial && <Button icon={AtSign} onClick={() => onNavigate("factory", { accountId: account.id, mode: "official" })}>官方别名</Button>}{supportsImported && !isMailcom && <Button icon={AtSign} onClick={() => onAliasSync(account, "mail_alias")}>邮箱别名</Button>}{supportsImported && !isMailcom && <Button icon={ShieldCheck} onClick={() => onAliasSync(account, "hide_my_email")}>隐藏邮箱</Button>}{supportsImported && !isMailcom && <Button icon={Globe2} onClick={() => onAliasSync(account, "custom_domain")}>自定义域名</Button>}{supportsPlus && <Button icon={WandSparkles} onClick={() => onNavigate("factory", { accountId: account.id, mode: "split" })}>生成分裂</Button>}<div className="source-more">{supportsOfficial && <IconButton icon={ListPlus} label="手工登记官网别名" onClick={() => onAliasSync(account)} />}<IconButton icon={account.status === "connected" ? ShieldCheck : Unplug} label={`${accountMeta.reconnectLabel} ${accountMeta.name}`} disabled={operationLocked} onClick={() => onReconnect(account)} /><IconButton icon={Trash2} label="移除源头邮箱" disabled={operationLocked} onClick={() => onRemove(account)} /></div></footer>
  </article>;
}

function MailComImportModal({ open, onClose, onImported }) {
  const [content, setContent] = useState("");
  const [importResult, setImportResult] = useState(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!open) {
      setContent("");
      setImportResult(null);
      setMessage("");
    }
  }, [open]);

  const submit = async () => {
    if (!content.trim()) return;
    setLoading(true);
    setImportResult(null);
    setMessage("");
    try {
      const result = await api("/api/mailcom/import", { method: "POST", body: { content } });
      const imported = Number(result.imported ?? result.created ?? result.count ?? result.items?.length) || 0;
      const created = Number(result.created) || 0;
      const updated = Number(result.updated) || 0;
      const failed = Number(result.failed ?? result.invalid) || 0;
      const failures = Array.isArray(result.items)
        ? result.items.filter((item) => item?.status === "failed").map((item) => ({
          email: String(item.email || "未知邮箱"),
          error: String(item.error || "连接失败"),
        }))
        : [];
      const summary = `成功 ${imported} 个（新增 ${created}，更新 ${updated}）${failed ? `，失败 ${failed} 个` : ""}`;
      toast(summary || "mail.com 母号已导入", failed ? "error" : "success");
      setContent("");
      setImportResult({ imported, created, updated, failed, failures });
      await onImported?.(result);
      if (!failed) onClose();
    } catch (error) {
      setMessage(error.message);
      toast(error.message, "error");
    } finally {
      setLoading(false);
    }
  };

  return <Modal
    open={open}
    onClose={() => { if (!loading) onClose(); }}
    title="导入 mail.com 母号"
    description="批量导入注册机产出的 mail.com 登录账号，并直接加入源头邮箱"
    size="lg"
    footer={<><Button disabled={loading} onClick={onClose}>取消</Button><Button variant="primary" icon={Upload} loading={loading} disabled={!content.trim()} onClick={submit}>导入母号</Button></>}
  >
    <div className="form-stack">
      <div className="provider-login-note"><ProviderMark provider="mailcom" size={34} /><span><b>每行一个账号</b><small>格式：邮箱----密码；密码只会发送到服务器并加密保存</small></span></div>
      <FormField label="mail.com 账号" hint="支持 mail.com 提供的其他邮箱域名；提供商按本次导入固定识别为 mail.com"><textarea rows="11" value={content} disabled={loading} onChange={(event) => setContent(event.target.value)} placeholder={'name@mail.com----password\nname@galaxyhit.com----password'} autoCapitalize="off" autoCorrect="off" spellCheck="false" autoFocus /></FormField>
      {importResult && <div className="provider-login-note"><CheckCircle2 size={24} /><span><b>本次成功 {importResult.imported} 个</b><small>新增 {importResult.created} · 更新 {importResult.updated} · 失败 {importResult.failed}；提交内容已清空，结果不会回显密码</small></span></div>}
      {importResult?.failures?.length > 0 && <div className="provider-login-note" role="alert"><AlertCircle size={24} /><span><b>失败详情</b>{importResult.failures.map((item, index) => <small key={`${item.email}-${index}`}>{item.email}：{item.error}</small>)}</span></div>}
      {message && <div className="inline-alert danger"><AlertCircle size={17} /><span>{message}</span></div>}
    </div>
  </Modal>;
}

function ConnectionModal({ open, onClose, existingAccount, onConnected }) {
  const [session, setSession] = useState(null);
  const [account, setAccount] = useState(null);
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [provider, setProvider] = useState(() => normalizeProvider(existingAccount?.provider));
  const [icloudForm, setIcloudForm] = useState({ email: existingAccount?.email || "", appSpecificPassword: "" });
  const [mailcomForm, setMailcomForm] = useState({ email: existingAccount?.email || "", password: "" });
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setSession(null);
    setAccount(null);
    setStatus("idle");
    setMessage("");
    setCallbackUrl("");
    setProvider(normalizeProvider(existingAccount?.provider));
    setIcloudForm({ email: existingAccount?.email || "", appSpecificPassword: "" });
    setMailcomForm({ email: existingAccount?.email || "", password: "" });
  }, [open, existingAccount?.id]);

  const meta = providerMeta(provider);

  const start = async () => {
    const popup = window.open("about:blank", meta.popupName);
    setLoading(true);
    setMessage("");
    setCallbackUrl("");
    try {
      const result = await api(`${meta.oauthBase}/start`, { method: "POST", body: { accountId: existingAccount?.id || null } });
      setSession(result);
      setStatus("awaiting_callback");
      if (popup) {
        popup.location.href = result.authorizationUrl;
        popup.focus();
      } else {
        window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      popup?.close();
      setStatus("error");
      setMessage(error.message);
      toast(error.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const complete = async (value) => {
    const pastedUrl = String(value || callbackUrl).trim();
    if (!pastedUrl) {
      setMessage(`请粘贴 ${meta.name} 授权后浏览器地址栏里的完整 localhost 地址`);
      return;
    }
    setLoading(true);
    setStatus("completing");
    setMessage("");
    try {
      const result = await api(`${meta.oauthBase}/${session.sessionId}/complete`, {
        method: "POST",
        body: { callbackUrl: pastedUrl },
      });
      setAccount(result.account);
      setStatus("connected");
      toast(`${result.account.email} 已通过 ${meta.name} OAuth 连接`);
      onConnected();
    } catch (error) {
      setStatus("awaiting_callback");
      setMessage(error.message);
      toast(error.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const pasteAndComplete = async () => {
    let value = callbackUrl.trim();
    if (!value && navigator.clipboard?.readText) {
      try {
        value = (await navigator.clipboard.readText()).trim();
        setCallbackUrl(value);
      } catch {
        setMessage("浏览器未允许读取剪贴板，请长按输入框粘贴回调地址");
        return;
      }
    }
    await complete(value);
  };

  const connectIcloud = async () => {
    const email = String(existingAccount?.email || icloudForm.email).trim();
    if (!email || !icloudForm.appSpecificPassword.trim()) {
      setMessage("请填写 Apple 账户邮箱和 App 专用密码");
      return;
    }
    setLoading(true);
    setStatus("connecting");
    setMessage("");
    try {
      const result = await api("/api/icloud/connect", {
        method: "POST",
        body: {
          accountId: existingAccount?.id || null,
          email,
          appSpecificPassword: icloudForm.appSpecificPassword,
        },
      });
      setAccount(result.account);
      setStatus("connected");
      setIcloudForm((current) => ({ ...current, appSpecificPassword: "" }));
      toast(`${result.account.email} 已连接 iCloud Mail`);
      onConnected();
    } catch (error) {
      setStatus("error");
      setMessage(error.message);
      toast(error.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const connectMailcom = async () => {
    const email = String(existingAccount?.email || mailcomForm.email).trim();
    if (!email || !mailcomForm.password) {
      setMessage("请填写 mail.com 邮箱和登录密码");
      return;
    }
    setLoading(true);
    setStatus("connecting");
    setMessage("");
    try {
      const result = await api("/api/mailcom/connect", {
        method: "POST",
        body: {
          accountId: existingAccount?.id || null,
          email,
          password: mailcomForm.password,
        },
      });
      setAccount(result.account);
      setStatus("connected");
      setMailcomForm((current) => ({ ...current, password: "" }));
      toast(`${result.account.email} 已连接 mail.com`);
      onConnected();
    } catch (error) {
      setStatus("error");
      setMessage(error.message);
      toast(error.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const waiting = status === "awaiting_callback" || status === "completing";
  const footer = status === "connected"
    ? <Button variant="primary" icon={CheckCircle2} onClick={onClose}>完成</Button>
    : provider === "mailcom"
      ? <><Button onClick={onClose}>取消</Button><Button variant="primary" icon={ShieldCheck} loading={loading} onClick={connectMailcom}>{existingAccount ? "验证并更新" : "连接 mail.com"}</Button></>
      : provider === "icloud"
      ? <><Button onClick={onClose}>取消</Button><Button variant="primary" icon={ShieldCheck} loading={loading} onClick={connectIcloud}>{existingAccount ? "验证并更新" : "连接 iCloud"}</Button></>
    : waiting
      ? <><Button onClick={onClose}>稍后处理</Button><a className="button button-secondary button-md" href={session.authorizationUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} /><span>打开 {meta.name}</span></a><Button variant="primary" icon={ClipboardPaste} loading={loading} onClick={pasteAndComplete}>{callbackUrl.trim() ? "完成绑定" : "粘贴并完成"}</Button></>
      : <><Button onClick={onClose}>取消</Button><Button variant="primary" icon={ShieldCheck} loading={loading} onClick={start}>{provider === "google" ? "打开 Google 授权" : `${meta.name} 官方授权`}</Button></>;

  return (
    <Modal open={open} onClose={onClose} title={existingAccount ? `${meta.reconnectLabel} ${meta.name} 账号` : "绑定源头邮箱"} description={existingAccount?.email || meta.description} size="md" footer={footer}>
      {status === "connected" ? (
        <div className="connection-success"><span><CheckCircle2 size={30} /></span><h3>{provider === "icloud" ? "iCloud Mail 已连接" : provider === "mailcom" ? "mail.com 已连接" : "OAuth 授权已完成"}</h3><p>{account?.email}</p><div><b>{provider === "icloud" ? "IMAP" : provider === "mailcom" ? "密码" : "RT"}</b><small>{provider === "icloud" ? "App 专用密码已加密保存" : provider === "mailcom" ? "mail.com 登录密码已加密保存" : "长期授权已加密保存"}</small></div></div>
      ) : provider === "mailcom" ? (
        <div className="oauth-start-panel">
          {!existingAccount && <Segmented value={provider} onChange={(value) => { setProvider(value); setMessage(""); setStatus("idle"); }} ariaLabel="邮箱提供商" items={SOURCE_PROVIDER_ITEMS} />}
          <ProviderMark provider="mailcom" size={48} />
          <h3>mail.com 登录验证</h3>
          <p>这里只连接真正的母号；已登记的官方分裂别名不能作为 IMAP 登录账号。</p>
          {message && <div className="inline-alert danger"><AlertCircle size={17} /><span>{message}</span></div>}
          <div className="icloud-connect-form">
            <FormField label="mail.com 母号"><input type="email" value={existingAccount?.email || mailcomForm.email} disabled={Boolean(existingAccount)} onChange={(event) => setMailcomForm({ ...mailcomForm, email: event.target.value })} placeholder="name@mail.com" autoComplete="username" /></FormField>
            <FormField label="登录密码" hint="验证成功后使用 AES-256-GCM 加密保存"><input type="password" value={mailcomForm.password} onChange={(event) => setMailcomForm({ ...mailcomForm, password: event.target.value })} placeholder="输入 mail.com 登录密码" autoComplete="new-password" autoFocus /></FormField>
            <div className="inline-alert warning"><AlertCircle size={17} /><span>Free 账号不能通过 IMAP 自动收件。若网页登录正常但这里失败，请先开通 Premium，并在 mail.com 设置中启用 POP3/IMAP；验证失败不会保存账号或密码。</span></div>
            <a className="icloud-password-link" href="https://navigator-lxa.mail.com/mail/" target="_blank" rel="noreferrer"><ExternalLink size={14} />先到 mail.com 网页验证母号和密码</a>
            <div className="provider-login-note"><KeyRound size={24} /><span><b>母号统一取件</b><small>母号和官方分裂别名共享登录密码与收件箱</small></span></div>
          </div>
        </div>
      ) : waiting ? (
        <div className="oauth-callback-step">
          <span className={`challenge-icon ${status === "completing" ? "pulse" : ""}`}>{status === "completing" ? <LoaderCircle className="spin" size={24} /> : <ExternalLink size={24} />}</span>
          <h3>{status === "completing" ? `正在验证 ${meta.name} 回调` : `完成 ${meta.name} 授权`}</h3>
          <p>授权完成后浏览器会停在 localhost 页面。</p>
          <label className="form-field oauth-callback-field">
            <span className="field-label">localhost 回调地址</span>
            <textarea rows="3" value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} placeholder={provider === "google" ? "http://127.0.0.1:12142/?code=...&state=..." : "http://localhost:12141/desktop?code=...&state=..."} autoCapitalize="off" autoCorrect="off" spellCheck="false" />
            <small>粘贴浏览器地址栏中的完整地址</small>
          </label>
          {message && <div className="inline-alert danger"><AlertCircle size={17} /><span>{message}</span></div>}
        </div>
      ) : (
        <div className="oauth-start-panel">
          {!existingAccount && <Segmented value={provider} onChange={(value) => { setProvider(value); setMessage(""); setStatus("idle"); }} ariaLabel="邮箱提供商" items={SOURCE_PROVIDER_ITEMS} />}
          <ProviderMark provider={provider} size={48} />
          <h3>{provider === "icloud" ? "iCloud Mail IMAP" : `${meta.name} OAuth`}</h3>
          <p>{provider === "icloud" ? "使用 Apple 账户生成的 App 专用密码，只读连接 iCloud 收件箱" : provider === "google" ? "内置 Thunderbird 邮件公共客户端，无需配置；打开授权后粘贴 localhost 回调" : `由 ${meta.name} 官方页面授权，使用 PKCE 保护授权码`}</p>
          {message && <div className="inline-alert danger"><AlertCircle size={17} /><span>{message}</span></div>}
          {provider === "icloud" ? <div className="icloud-connect-form">
            <FormField label="Apple 账户邮箱" hint="不限邮箱域名，支持 QQ 邮箱等 Apple 账户"><input type="email" value={existingAccount?.email || icloudForm.email} disabled={Boolean(existingAccount)} onChange={(event) => setIcloudForm({ ...icloudForm, email: event.target.value })} placeholder="name@qq.com" autoComplete="username" /></FormField>
            <FormField label="App 专用密码" hint="不是 Apple 账户登录密码；连接成功后会使用 AES-256-GCM 加密保存"><input type="password" value={icloudForm.appSpecificPassword} onChange={(event) => setIcloudForm({ ...icloudForm, appSpecificPassword: event.target.value })} placeholder="xxxx-xxxx-xxxx-xxxx" autoComplete="new-password" /></FormField>
            <a className="icloud-password-link" href="https://account.apple.com/account/manage" target="_blank" rel="noreferrer"><ExternalLink size={14} />前往 Apple 账户生成 App 专用密码</a>
            <div className="provider-login-note"><KeyRound size={24} /><span><b>固定安全连接</b><small>imap.mail.me.com · 993 · TLS · 只读收件箱</small></span></div>
          </div> : <div className="provider-login-note"><KeyRound size={24} /><span><b>{provider === "google" ? "Thunderbird 邮件公共客户端" : "Mailspring 公共客户端"}</b><small>{provider === "google" ? "无需 Client ID 或 Secret，Refresh Token 加密保存" : "无需应用 Secret，Refresh Token 加密保存"}</small></span></div>}
        </div>
      )}
    </Modal>
  );
}

export default function SourcesPage({ refreshKey, onDataChange, onNavigate, addOpen, setAddOpen, initialAccountId, connectAccount = false }) {
  const [data, setData] = useState(null);
  const [reconnecting, setReconnecting] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [aliasSyncTarget, setAliasSyncTarget] = useState(null);
  const [mailcomImportOpen, setMailcomImportOpen] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState(() => new Set());
  const [mailcomDomain, setMailcomDomain] = useState("mail.com");
  const [mailcomBatch, setMailcomBatch] = useState({
    running: false,
    completed: 0,
    total: 0,
    succeeded: 0,
    failed: 0,
    created: 0,
    currentEmail: "",
    results: {},
  });
  const handledConnectTarget = useRef("");
  const handledRevealTarget = useRef("");
  const toast = useToast();
  const load = async () => {
    try { setData(await api("/api/accounts")); } catch (error) { toast(error.message, "error"); }
  };
  useEffect(() => { load(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const domains = normalizedMailcomDomains(data?.mailcomDomains);
    if (!domains.length) return;
    setMailcomDomain((current) => domains.includes(current) ? current : domains.includes("mail.com") ? "mail.com" : domains[0]);
  }, [data]);
  useEffect(() => {
    const accountId = Number(initialAccountId);
    if (!data || !Number.isSafeInteger(accountId) || accountId <= 0) return;
    const key = String(accountId);
    const account = data.items.find((item) => item.id === accountId);
    if (!account) return;
    if (handledRevealTarget.current !== key) {
      handledRevealTarget.current = key;
      const provider = normalizeProvider(account.provider);
      setExpandedProviders((current) => current.has(provider) ? current : new Set([...current, provider]));
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => document.getElementById(`source-account-${accountId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })));
    }
    if (connectAccount && handledConnectTarget.current !== key) {
      handledConnectTarget.current = key;
      setReconnecting(account);
    }
  }, [data, initialAccountId, connectAccount]);
  const remove = async () => {
    try { await api(`/api/accounts/${removing.id}`, { method: "DELETE" }); toast("源头邮箱已移除"); setRemoving(null); load(); onDataChange(); }
    catch (error) { toast(error.message, "error"); }
  };
  const connectionDone = () => { load(); onDataChange(); };
  const mailcomImportDone = async () => { await load(); onDataChange(); };
  const openAliasSync = (account, icloudKind = "") => setAliasSyncTarget({ account, icloudKind });
  const items = data?.items || [];
  const mailcomDomains = normalizedMailcomDomains(data?.mailcomDomains);
  const mailcomAccounts = items.filter((account) => normalizeProvider(account.provider) === "mailcom");
  const mailcomEligibleAccounts = mailcomAccounts.filter((account) => account.status === "connected" && mailcomUsage(account).remaining > 0);
  const toggleProvider = (provider) => setExpandedProviders((current) => {
    const next = new Set(current);
    if (next.has(provider)) next.delete(provider);
    else next.add(provider);
    return next;
  });
  const mergeAccount = (nextAccount) => {
    if (!nextAccount?.id) return;
    setData((current) => current ? {
      ...current,
      items: current.items.map((account) => account.id === nextAccount.id ? { ...account, ...nextAccount } : account),
    } : current);
  };
  const runMailcomAliasBatch = async () => {
    if (mailcomBatch.running || !mailcomDomain || !mailcomEligibleAccounts.length) return;
    const targets = [...mailcomEligibleAccounts];
    setExpandedProviders((current) => current.has("mailcom") ? current : new Set([...current, "mailcom"]));
    setMailcomBatch({
      running: true,
      completed: 0,
      total: targets.length,
      succeeded: 0,
      failed: 0,
      created: 0,
      currentEmail: targets[0]?.email || "",
      results: Object.fromEntries(targets.map((account) => [account.id, { status: "queued" }])),
    });
    let succeeded = 0;
    let failed = 0;
    let created = 0;
    for (let index = 0; index < targets.length; index += 1) {
      const account = targets[index];
      setMailcomBatch((current) => ({
        ...current,
        currentEmail: account.email,
        results: { ...current.results, [account.id]: { status: "running" } },
      }));
      let operation;
      try {
        const result = await api(`/api/accounts/${account.id}/mailcom-aliases/auto-create`, {
          method: "POST",
          body: { domain: mailcomDomain },
        });
        const createdCount = count(result?.created ?? result?.created_count);
        succeeded += 1;
        created += createdCount;
        mergeAccount(result?.account);
        operation = { status: "completed", created: createdCount, total: count(result?.total), domain: result?.domain || mailcomDomain };
      } catch (error) {
        const createdCount = count(error?.partial?.created ?? error?.created ?? error?.created_count);
        failed += 1;
        created += createdCount;
        mergeAccount(error?.account);
        operation = {
          status: "failed",
          partial: Boolean(error?.partial) || createdCount > 0,
          created: createdCount,
          error: error.message,
          code: error.code,
        };
      }
      const completed = index + 1;
      setMailcomBatch((current) => ({
        ...current,
        completed,
        succeeded,
        failed,
        created,
        currentEmail: completed < targets.length ? targets[completed].email : "",
        results: { ...current.results, [account.id]: operation },
      }));
    }
    setMailcomBatch((current) => ({ ...current, running: false, currentEmail: "" }));
    await load();
    onDataChange();
    toast(failed ? `别名创建完成：成功 ${succeeded}，失败 ${failed}，新建 ${created}` : `别名创建完成：${succeeded} 个母号共新建 ${created} 个别名`, failed ? "error" : "success");
  };
  const batchProgress = mailcomBatch.total ? Math.min(100, mailcomBatch.completed / mailcomBatch.total * 100) : 0;
  const mailcomActions = <div className="mailcom-summary-controls">
    <label className="mailcom-summary-domain"><span>别名域名后缀</span><select value={mailcomDomain} disabled={mailcomBatch.running || !mailcomDomains.length} onChange={(event) => setMailcomDomain(event.target.value)}>{mailcomDomains.map((domain) => <option value={domain} key={domain}>@{domain}</option>)}</select></label>
    <Button variant="primary" icon={WandSparkles} loading={mailcomBatch.running} disabled={!mailcomDomain || !mailcomEligibleAccounts.length} onClick={runMailcomAliasBatch}>{mailcomBatch.running ? `${mailcomBatch.completed} / ${mailcomBatch.total}` : mailcomEligibleAccounts.length ? `一键补满 ${mailcomEligibleAccounts.length} 个母号` : "别名已全部补满"}</Button>
    {mailcomBatch.total > 0 && <div className={`mailcom-batch-progress${mailcomBatch.failed ? " has-errors" : ""}`} role="status" aria-live="polite"><span><b>{mailcomBatch.running ? `正在处理 ${mailcomBatch.completed + 1} / ${mailcomBatch.total}` : `完成 ${mailcomBatch.completed} / ${mailcomBatch.total}`}</b><small>{mailcomBatch.running ? mailcomBatch.currentEmail : `成功 ${mailcomBatch.succeeded} · 失败 ${mailcomBatch.failed} · 新建 ${mailcomBatch.created}`}</small></span><i><b style={{ width: `${batchProgress}%` }} /></i></div>}
  </div>;

  return (
    <div className="page-stack sources-page">
      <div className="context-bar"><div className="context-copy"><Mail size={16} />已添加 {items.length} 个源头邮箱</div><div className="context-actions"><Button icon={Upload} onClick={() => setMailcomImportOpen(true)}>导入 mail.com 母号</Button><Button variant="primary" icon={Plus} onClick={() => setAddOpen(true)}>添加源头邮箱</Button></div></div>
      <section className="source-provider-workspace">
        {!data ? <LoadingBlock rows={7} /> : <>
          <div className="source-provider-groups">{SOURCE_PROVIDER_ITEMS.map((providerItem) => {
            const providerAccounts = items.filter((account) => normalizeProvider(account.provider) === providerItem.value);
            const expanded = expandedProviders.has(providerItem.value);
            return <ProviderGroup key={providerItem.value} provider={providerItem.value} accounts={providerAccounts} expanded={expanded} onToggle={() => toggleProvider(providerItem.value)} actions={providerItem.value === "mailcom" ? mailcomActions : null} />;
          })}</div>
          {expandedProviders.size > 0 && <div className="source-provider-expanded-list">{SOURCE_PROVIDER_ITEMS.filter((providerItem) => expandedProviders.has(providerItem.value)).map((providerItem) => {
            const providerAccounts = items.filter((account) => normalizeProvider(account.provider) === providerItem.value);
            return <ProviderExpanded key={providerItem.value} provider={providerItem.value} accounts={providerAccounts} onCollapse={() => toggleProvider(providerItem.value)}>
              {providerAccounts.length ? <div className="source-grid">{providerAccounts.map((account) => <SourceAccountCard key={account.id} account={account} initialAccountId={initialAccountId} operation={mailcomBatch.results[account.id]} onAliasSync={openAliasSync} onNavigate={onNavigate} onReconnect={setReconnecting} onRemove={setRemoving} />)}</div> : <div className="source-provider-empty"><EmptyState icon={Mail} title={`暂无 ${providerMeta(providerItem.value).name} 邮箱`} description="添加后会显示在这个栏目中。" /></div>}
            </ProviderExpanded>;
          })}</div>}
        </>}
      </section>
      <MailComImportModal open={mailcomImportOpen} onClose={() => setMailcomImportOpen(false)} onImported={mailcomImportDone} />
      <ConnectionModal open={addOpen} onClose={() => setAddOpen(false)} onConnected={connectionDone} />
      <ConnectionModal open={Boolean(reconnecting)} existingAccount={reconnecting} onClose={() => setReconnecting(null)} onConnected={connectionDone} />
      <AliasSyncModal account={aliasSyncTarget?.account} icloudKind={aliasSyncTarget?.icloudKind} mailcomDomains={mailcomDomains} initialMailcomDomain={mailcomDomain} onClose={() => setAliasSyncTarget(null)} onSynced={connectionDone} />
      <ConfirmDialog open={Boolean(removing)} onClose={() => setRemoving(null)} onConfirm={remove} title="移除这个源头邮箱？" description={removing ? `${removing.email} 的登录凭据、官方别名记录（如有）、分裂地址和验证码都会从本系统删除。` : ""} confirmText="移除邮箱" danger />
    </div>
  );
}
