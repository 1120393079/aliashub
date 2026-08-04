import { useEffect, useRef, useState } from "react";
import { AlertCircle, AtSign, CheckCircle2, ClipboardPaste, ExternalLink, Globe2, KeyRound, ListPlus, LoaderCircle, Mail, Plus, ShieldCheck, Trash2, Unplug, WandSparkles } from "lucide-react";
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

function ConnectionModal({ open, onClose, existingAccount, onConnected }) {
  const [session, setSession] = useState(null);
  const [account, setAccount] = useState(null);
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [provider, setProvider] = useState(() => normalizeProvider(existingAccount?.provider));
  const [icloudForm, setIcloudForm] = useState({ email: existingAccount?.email || "", appSpecificPassword: "" });
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

  const waiting = status === "awaiting_callback" || status === "completing";
  const footer = status === "connected"
    ? <Button variant="primary" icon={CheckCircle2} onClick={onClose}>完成</Button>
    : provider === "icloud"
      ? <><Button onClick={onClose}>取消</Button><Button variant="primary" icon={ShieldCheck} loading={loading} onClick={connectIcloud}>{existingAccount ? "验证并更新" : "连接 iCloud"}</Button></>
    : waiting
      ? <><Button onClick={onClose}>稍后处理</Button><a className="button button-secondary button-md" href={session.authorizationUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} /><span>打开 {meta.name}</span></a><Button variant="primary" icon={ClipboardPaste} loading={loading} onClick={pasteAndComplete}>{callbackUrl.trim() ? "完成绑定" : "粘贴并完成"}</Button></>
      : <><Button onClick={onClose}>取消</Button><Button variant="primary" icon={ShieldCheck} loading={loading} onClick={start}>{provider === "google" ? "打开 Google 授权" : `${meta.name} 官方授权`}</Button></>;

  return (
    <Modal open={open} onClose={onClose} title={existingAccount ? `${meta.reconnectLabel} ${meta.name} 账号` : "绑定源头邮箱"} description={existingAccount?.email || meta.description} size="md" footer={footer}>
      {status === "connected" ? (
        <div className="connection-success"><span><CheckCircle2 size={30} /></span><h3>{provider === "icloud" ? "iCloud Mail 已连接" : "OAuth 授权已完成"}</h3><p>{account?.email}</p><div><b>{provider === "icloud" ? "IMAP" : "RT"}</b><small>{provider === "icloud" ? "App 专用密码已加密保存" : "长期授权已加密保存"}</small></div></div>
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
          {!existingAccount && <Segmented value={provider} onChange={(value) => { setProvider(value); setMessage(""); setStatus("idle"); }} ariaLabel="邮箱提供商" items={[{ value: "microsoft", label: "Microsoft", icon: MicrosoftProviderIcon }, { value: "google", label: "Google", icon: GoogleProviderIcon }, { value: "icloud", label: "iCloud", icon: ICloudProviderIcon }]} />}
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
  const handledConnectTarget = useRef("");
  const toast = useToast();
  const load = async () => {
    try { setData(await api("/api/accounts")); } catch (error) { toast(error.message, "error"); }
  };
  useEffect(() => { load(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const accountId = Number(initialAccountId);
    if (!connectAccount || !data || !Number.isSafeInteger(accountId) || accountId <= 0) return;
    const key = String(accountId);
    if (handledConnectTarget.current === key) return;
    const account = data.items.find((item) => item.id === accountId);
    if (!account) return;
    handledConnectTarget.current = key;
    setReconnecting(account);
    window.requestAnimationFrame(() => document.getElementById(`source-account-${accountId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }, [data, initialAccountId, connectAccount]);
  const remove = async () => {
    try { await api(`/api/accounts/${removing.id}`, { method: "DELETE" }); toast("源头邮箱已移除"); setRemoving(null); load(); onDataChange(); }
    catch (error) { toast(error.message, "error"); }
  };
  const connectionDone = () => { load(); onDataChange(); };
  const openAliasSync = (account, icloudKind = "") => setAliasSyncTarget({ account, icloudKind });
  const items = data?.items || [];

  return (
    <div className="page-stack sources-page">
      <div className="context-bar"><div className="context-copy"><Mail size={16} />已添加 {items.length} 个源头邮箱</div><Button variant="primary" icon={Plus} onClick={() => setAddOpen(true)}>添加源头邮箱</Button></div>
      <section className="source-grid">
        {!data ? <LoadingBlock rows={7} /> : items.length ? items.map((account) => {
          const accountMeta = providerMeta(account.provider);
          const supportsOfficial = accountSupportsOfficialAliases(account);
          const supportsPlus = accountSupportsPlusAliases(account);
          const supportsImported = accountSupportsImportedAliases(account);
          const supportsAliases = supportsOfficial || supportsImported;
          return <article id={`source-account-${account.id}`} className={`source-card source-card-${accountMeta.id}${Number(initialAccountId) === account.id ? " source-card-target" : ""}`} key={account.id}>
            <header><ProviderMark provider={accountMeta.id} size={38} /><div><h2>{account.display_name || account.email.split("@")[0]}</h2><p>{account.email}<span className="provider-name">{accountMeta.name}</span></p></div><StatusBadge status={account.status}>{accountStatus[account.status]}</StatusBadge></header>
            {supportsOfficial ? <div className="source-quota"><div><span>官方基础地址</span><b>{account.official_used} <small>/ {account.official_limit}</small></b></div><div className="quota-track"><i style={{ width: `${Math.min(100, account.official_used / account.official_limit * 100)}%` }} /></div><small>剩余 {account.official_remaining} 个记录名额，实际以 Microsoft 官网限制为准</small></div> : <div className="source-provider-capability">{supportsPlus ? <WandSparkles size={18} /> : supportsImported ? <AtSign size={18} /> : <KeyRound size={18} />}<span><b>{accountMeta.capabilityTitle}</b><small>{accountMeta.capabilityDescription}</small></span></div>}
            {supportsImported ? <dl className="source-stats"><div><dt>邮箱别名</dt><dd>{account.icloud_mail_aliases || 0}</dd></div><div><dt>隐藏邮箱</dt><dd>{account.icloud_hide_my_emails || 0}</dd></div><div><dt>自定义域名</dt><dd>{account.icloud_custom_domain_emails || 0}</dd></div><div><dt>本地登记</dt><dd>{(account.icloud_mail_aliases || 0) + (account.icloud_hide_my_emails || 0) + (account.icloud_custom_domain_emails || 0)} 个可直接注册</dd></div></dl> : <dl className="source-stats"><div><dt>官方别名</dt><dd>{supportsAliases ? account.official_aliases : "不支持"}</dd></div><div><dt>分裂地址</dt><dd>{supportsPlus ? account.split_count : "不支持"}</dd></div><div><dt>收件扫描</dt><dd>{relativeTime(account.last_inbox_scan_at)}</dd></div><div><dt>{supportsOfficial ? "别名同步" : accountMeta.connectionLabel}</dt><dd>{supportsOfficial ? relativeTime(account.last_synced_at) : account.connection_connected ? "已连接" : "待连接"}</dd></div></dl>}
            {account.status === "action_required" && <div className="inline-alert warning"><AlertCircle size={15} /><span>{accountMeta.name} 连接需要更新</span><Button size="sm" onClick={() => setReconnecting(account)}>{accountMeta.reconnectLabel}</Button></div>}
            {account.limit_reason && <div className="inline-alert warning"><AlertCircle size={15} /><span>{account.limit_reason}</span></div>}
            <footer>{supportsOfficial && <Button icon={AtSign} onClick={() => onNavigate("factory", { accountId: account.id, mode: "official" })}>官方别名</Button>}{supportsImported && <Button icon={AtSign} onClick={() => openAliasSync(account, "mail_alias")}>邮箱别名</Button>}{supportsImported && <Button icon={ShieldCheck} onClick={() => openAliasSync(account, "hide_my_email")}>隐藏邮箱</Button>}{supportsImported && <Button icon={Globe2} onClick={() => openAliasSync(account, "custom_domain")}>自定义域名</Button>}{supportsPlus && <Button icon={WandSparkles} onClick={() => onNavigate("factory", { accountId: account.id, mode: "split" })}>生成分裂</Button>}<div className="source-more">{supportsOfficial && <IconButton icon={ListPlus} label="手工登记官网别名" onClick={() => openAliasSync(account)} />}<IconButton icon={account.status === "connected" ? ShieldCheck : Unplug} label={`${accountMeta.reconnectLabel} ${accountMeta.name}`} onClick={() => setReconnecting(account)} /><IconButton icon={Trash2} label="移除源头邮箱" onClick={() => setRemoving(account)} /></div></footer>
          </article>;
        }) : <div className="empty-source-panel"><EmptyState icon={Mail} title="添加第一个源头邮箱" description="支持 Microsoft Outlook、Gmail、Google Workspace 与 iCloud Mail。" action={<Button variant="primary" icon={Plus} onClick={() => setAddOpen(true)}>添加源头邮箱</Button>} /></div>}
      </section>
      <ConnectionModal open={addOpen} onClose={() => setAddOpen(false)} onConnected={connectionDone} />
      <ConnectionModal open={Boolean(reconnecting)} existingAccount={reconnecting} onClose={() => setReconnecting(null)} onConnected={connectionDone} />
      <AliasSyncModal account={aliasSyncTarget?.account} icloudKind={aliasSyncTarget?.icloudKind} onClose={() => setAliasSyncTarget(null)} onSynced={connectionDone} />
      <ConfirmDialog open={Boolean(removing)} onClose={() => setRemoving(null)} onConfirm={remove} title="移除这个源头邮箱？" description={removing ? `${removing.email} 的登录凭据、官方别名记录（如有）、分裂地址和验证码都会从本系统删除。` : ""} confirmText="移除邮箱" danger />
    </div>
  );
}
