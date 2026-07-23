import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, Eye, KeyRound, MailPlus, RefreshCw, RotateCw, Server, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { api } from "../api.js";
import { Button, ConfirmDialog, EmptyState, FormField, IconButton, LoadingBlock, Modal, Pagination, StatusBadge, useToast } from "../components.jsx";
import { copyText, formatDate } from "../utils.js";

const statusMeta = {
  success: { label: "注册成功", badge: "active" },
  failed: { label: "注册失败", badge: "failed" },
  received: { label: "已接收", badge: "warning" },
  unknown: { label: "待识别", badge: "inactive" },
};

function RegistrationStatus({ status }) {
  const meta = statusMeta[status] || statusMeta.unknown;
  return <StatusBadge status={meta.badge}>{meta.label}</StatusBadge>;
}

function CredentialModal({ credentials, onClose, onCopy }) {
  if (!credentials) return null;
  const fields = [
    ["注册密码", credentials.password],
    ["Refresh Token", credentials.refresh_token],
    ["Access Token", credentials.access_token],
    ["授权 Scope", credentials.scope],
  ].filter(([, value]) => value);
  return <Modal open onClose={onClose} title="注册凭据" description={credentials.email} size="lg">
    <div className="microsoft-registration-credentials">
      {fields.length ? fields.map(([label, value]) => <FormField key={label} label={label}>
        <div className="copy-input"><textarea readOnly value={value} rows={value.length > 160 ? 4 : 2} /><Button icon={Copy} onClick={() => onCopy(value)}>复制</Button></div>
      </FormField>) : <EmptyState icon={KeyRound} title="此回传未包含凭据" description="Go 注册机下一次回传时会自动补充可识别的密码或 OAuth Token。" />}
    </div>
  </Modal>;
}

export default function MicrosoftRegistrationPage({ refreshKey, onDataChange, onNavigate }) {
  const [config, setConfig] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [provisioned, setProvisioned] = useState(null);
  const [rotating, setRotating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [credentials, setCredentials] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [addingSourceId, setAddingSourceId] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const loadRequest = useRef(0);
  const toast = useToast();

  const copy = async (value, message) => {
    try {
      await copyText(value);
      toast(message || "已复制");
    } catch {
      toast("复制失败，请手动复制", "error");
    }
  };

  const load = useCallback(async () => {
    const requestId = ++loadRequest.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (query.trim()) params.set("q", query.trim());
      if (status) params.set("status", status);
      const [nextConfig, nextAccounts] = await Promise.all([
        api("/api/microsoft-registration/config"),
        api(`/api/microsoft-registration/accounts?${params.toString()}`),
      ]);
      if (requestId !== loadRequest.current) return;
      setConfig(nextConfig);
      setAccounts(nextAccounts);
    } catch (error) {
      if (requestId === loadRequest.current) toast(error.message, "error");
    } finally {
      if (requestId === loadRequest.current) setLoading(false);
    }
  }, [page, query, status, toast]);

  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => () => { loadRequest.current += 1; }, []);
  useEffect(() => {
    if (!config?.webhook_configured) return undefined;
    const timer = window.setInterval(() => load(), 12_000);
    return () => window.clearInterval(timer);
  }, [config?.webhook_configured, load]);

  const rotateWebhook = async () => {
    setRotating(true);
    try {
      const result = await api("/api/microsoft-registration/webhook-token", { method: "POST" });
      setProvisioned(result);
      setConfig(result);
      toast("回传地址已生成，请立即复制到 Windows 注册机的 mail.toml");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setRotating(false);
    }
  };

  const revealCredentials = async (id) => {
    try {
      setCredentials(await api(`/api/microsoft-registration/accounts/${id}/credentials`));
    } catch (error) { toast(error.message, "error"); }
  };

  const addSource = async (id) => {
    setAddingSourceId(id);
    try {
      const result = await api(`/api/microsoft-registration/accounts/${id}/add-source`, { method: "POST" });
      toast(result.existing ? "该邮箱已在源头邮箱中" : "已添加到源头邮箱，正在打开 Microsoft OAuth 授权");
      onDataChange();
      onNavigate("sources", { accountId: result.account.id, connect: true });
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setAddingSourceId(null);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api(`/api/microsoft-registration/accounts/${pendingDelete.id}`, { method: "DELETE" });
      toast("微软注册记录已删除");
      setPendingDelete(null);
      await load();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setDeleting(false);
    }
  };

  const changeFilter = (next) => {
    setStatus(next);
    setPage(1);
  };

  if (!config || !accounts) return <div className="page-stack"><LoadingBlock rows={9} /></div>;

  return <div className="page-stack microsoft-registration-page">
    <section className="metric-grid">
      <article className="metric-card"><span className="metric-icon blue"><MailPlus size={19} /></span><div><span>回传注册邮箱</span><strong>{config.accounts}</strong><small>已接收的唯一邮箱</small></div></article>
      <article className="metric-card"><span className="metric-icon green"><CheckCircle2 size={19} /></span><div><span>注册成功</span><strong>{config.successful_accounts}</strong><small>来自 Go 注册机结果</small></div></article>
      <article className="metric-card"><span className="metric-icon coral"><AlertTriangle size={19} /></span><div><span>注册失败</span><strong>{config.failed_accounts}</strong><small>保留失败记录便于重试</small></div></article>
      <article className="metric-card"><span className="metric-icon amber"><Server size={19} /></span><div><span>最近回传</span><strong>{config.last_received_at ? formatDate(config.last_received_at, false) : "-"}</strong><small>{config.imports} 次原始回传已加密保存</small></div></article>
    </section>

    <section className="panel microsoft-registration-webhook">
      <header className="panel-header"><div><h2>Go 微软注册机接入</h2><p>Windows 注册机通过 server_upload_url 自动回传注册结果、密码和 OAuth 数据</p></div><StatusBadge status={config.webhook_configured ? "active" : "inactive"}>{config.webhook_configured ? "回传已配置" : "等待配置"}</StatusBadge></header>
      {!config.encryption_ready && <div className="inline-alert error"><AlertTriangle size={16} /><span>服务端尚未配置 DATA_ENCRYPTION_KEY，不能接收并加密保存注册凭据。</span></div>}
      <div className="microsoft-registration-webhook-body">
        {provisioned ? <div className="microsoft-registration-provisioned">
          <div className="inline-alert success"><ShieldCheck size={16} /><span>回传地址只在本次显示；复制后填写到 Windows 注册机目录的 <code>mail.toml</code>。</span></div>
          <FormField label="server_upload_url"><div className="copy-input"><input readOnly value={provisioned.ingest_url} /><Button icon={Copy} onClick={() => copy(provisioned.ingest_url, "回传地址已复制")}>复制</Button></div></FormField>
          <FormField label="mail.toml 接入片段"><div className="copy-input"><textarea readOnly value={provisioned.config_snippet} rows={7} /><Button icon={Copy} onClick={() => copy(provisioned.config_snippet, "配置片段已复制")}>复制</Button></div></FormField>
        </div> : <div className="microsoft-registration-setup-copy">
          <div><b>1. 在 Windows 启动 go授权服务-v1.0.5.exe 与 go-ms-v9.2.8.exe。</b><small>原程序的 <code>auth_service_url</code> 保持本地 <code>http://127.0.0.1:8081/api/scope</code>。</small></div>
          <div><b>2. 生成一次回传地址，复制到 <code>mail.toml</code> 的 <code>server_upload_url</code>。</b><small>注册完成后，AliasHub 会自动接收并加密归档账号结果。</small></div>
          <div><b>3. 在本页查看记录，需要时一键加入“源头邮箱”继续 OAuth 与收件管理。</b><small>网页不直接运行 Windows EXE；注册任务仍由 Windows 端程序执行。</small></div>
        </div>}
        <div className="microsoft-registration-webhook-actions">
          <Button variant="primary" icon={config.webhook_configured ? RotateCw : KeyRound} loading={rotating} disabled={!config.encryption_ready} onClick={rotateWebhook}>{config.webhook_configured ? "重新生成回传地址" : "生成回传地址"}</Button>
        </div>
      </div>
    </section>

    <section className="table-panel microsoft-registration-records">
      <header className="panel-header"><div><h2>微软邮箱注册记录</h2><p>凭据默认不在列表返回，点击查看后才单独读取</p></div><Button icon={RefreshCw} loading={loading} onClick={load}>刷新</Button></header>
      <div className="microsoft-registration-toolbar">
        <div className="segmented" role="tablist" aria-label="注册状态筛选">
          {[['', '全部'], ['success', '成功'], ['failed', '失败'], ['received', '已接收'], ['unknown', '待识别']].map(([value, label]) => <button key={value || "all"} className={status === value ? "active" : ""} onClick={() => changeFilter(value)} role="tab" aria-selected={status === value}>{label}</button>)}
        </div>
        <label className="search-box"><MailPlus size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜索注册邮箱、名称或来源" /></label>
      </div>
      {accounts.items.length ? <>
        <div className="data-table-wrap"><table className="data-table"><thead><tr><th>邮箱</th><th>注册状态</th><th>回传凭据</th><th>代理 / 来源</th><th>源头邮箱</th><th>最近回传</th><th aria-label="操作" /></tr></thead><tbody>{accounts.items.map((item) => <tr key={item.id}>
          <td><div className="microsoft-registration-email"><b>{item.email}</b><small>{item.display_name || item.external_record_key || "Go 注册机回传"}</small></div></td>
          <td><RegistrationStatus status={item.status} /></td>
          <td><span className="microsoft-registration-flags">{item.has_password && <i>密码</i>}{item.has_refresh_token && <i>Refresh</i>}{item.has_access_token && <i>Access</i>}{!item.has_password && !item.has_refresh_token && !item.has_access_token && <small>未回传</small>}</span></td>
          <td><span className="microsoft-registration-source"><b>{item.proxy_label || "未提供代理"}</b><small>{item.source_label}</small></span></td>
          <td>{item.source_account_id ? <button className="text-link" onClick={() => onNavigate("sources", { accountId: item.source_account_id })}>{item.source_account_email || "已加入"}</button> : <span className="muted-cell">未加入</span>}</td>
          <td><span className="muted-cell">{formatDate(item.last_seen_at)}</span></td>
          <td><div className="row-actions"><IconButton icon={Eye} label="查看凭据" disabled={!item.has_password && !item.has_refresh_token && !item.has_access_token} onClick={() => revealCredentials(item.id)} />{item.source_account_id ? null : <IconButton icon={UserPlus} label="加入源头邮箱" disabled={addingSourceId === item.id} onClick={() => addSource(item.id)} />}<IconButton icon={Trash2} label="删除注册记录" variant="danger" onClick={() => setPendingDelete(item)} /></div></td>
        </tr>)}</tbody></table></div>
        <div className="microsoft-registration-mobile-list">{accounts.items.map((item) => <article key={item.id}><header><span><b>{item.email}</b><small>{item.display_name || item.source_label}</small></span><RegistrationStatus status={item.status} /></header><p>{item.proxy_label || "未提供代理"} · {formatDate(item.last_seen_at)}</p><footer><span className="microsoft-registration-flags">{item.has_password && <i>密码</i>}{item.has_refresh_token && <i>Refresh</i>}{item.has_access_token && <i>Access</i>}</span><span className="row-actions"><IconButton icon={Eye} label="查看凭据" disabled={!item.has_password && !item.has_refresh_token && !item.has_access_token} onClick={() => revealCredentials(item.id)} />{item.source_account_id ? <IconButton icon={MailPlus} label="打开源头邮箱" onClick={() => onNavigate("sources", { accountId: item.source_account_id })} /> : <IconButton icon={UserPlus} label="加入源头邮箱" disabled={addingSourceId === item.id} onClick={() => addSource(item.id)} />}<IconButton icon={Trash2} label="删除" variant="danger" onClick={() => setPendingDelete(item)} /></span></footer></article>)}</div>
        <div className="table-footer"><span>共 {accounts.total} 个注册邮箱</span><Pagination page={accounts.page} pages={accounts.pages} onChange={setPage} /></div>
      </> : <EmptyState icon={MailPlus} title="还没有微软注册记录" description="生成回传地址并写入 Go 注册机的 mail.toml 后，注册结果会自动显示在这里。" action={!config.webhook_configured && config.encryption_ready ? <Button variant="primary" icon={KeyRound} onClick={rotateWebhook}>生成回传地址</Button> : undefined} />}
    </section>

    <CredentialModal credentials={credentials} onClose={() => setCredentials(null)} onCopy={(value) => copy(value, "凭据已复制")} />
    <ConfirmDialog open={Boolean(pendingDelete)} onClose={() => setPendingDelete(null)} onConfirm={remove} loading={deleting} danger title="删除微软注册记录？" description="只删除 AliasHub 中的回传记录，不会删除 Windows 注册机中的账号，也不会删除已加入的源头邮箱。" confirmText="确认删除" />
  </div>;
}
