import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Copy, Eye, KeyRound, MailPlus, Play, RefreshCw, Save, Server, Square, Terminal, Trash2, UserPlus } from "lucide-react";
import { api } from "../api.js";
import { Button, ConfirmDialog, EmptyState, FormField, IconButton, LoadingBlock, Modal, Pagination, StatusBadge, useToast } from "../components.jsx";
import { copyText, formatDate } from "../utils.js";

const statusMeta = {
  success: { label: "注册成功", badge: "active" },
  failed: { label: "注册失败", badge: "failed" },
  received: { label: "已接收", badge: "warning" },
  unknown: { label: "待识别", badge: "inactive" },
};

const runnerStatusMeta = {
  starting: { label: "正在启动", badge: "warning" },
  running: { label: "正在注册", badge: "active" },
  stopping: { label: "正在停止", badge: "warning" },
  completed: { label: "已完成", badge: "active" },
  cancelled: { label: "已停止", badge: "inactive" },
  interrupted: { label: "已中断", badge: "failed" },
  failed: { label: "运行失败", badge: "failed" },
};

const defaultRunnerForm = {
  captcha_type: "3",
  captcha_key: "",
  proxy_mode: "list",
  proxy_value: "",
  account_format: "aaaaa11111111",
  password_format: "aaaaa11111111",
  quantity: 1,
  concurrency: 1,
  oauth_mode: "1",
  chrome_version: "143",
};

function RegistrationStatus({ status }) {
  const meta = statusMeta[status] || statusMeta.unknown;
  return <StatusBadge status={meta.badge}>{meta.label}</StatusBadge>;
}

function RunnerStatus({ run }) {
  const meta = runnerStatusMeta[run?.status] || { label: "等待配置", badge: "inactive" };
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
  const [runner, setRunner] = useState(null);
  const [runnerForm, setRunnerForm] = useState(defaultRunnerForm);
  const [runnerLogs, setRunnerLogs] = useState([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [savingRunner, setSavingRunner] = useState(false);
  const [startingRunner, setStartingRunner] = useState(false);
  const [stoppingRunner, setStoppingRunner] = useState(false);
  const [credentials, setCredentials] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [addingSourceId, setAddingSourceId] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const loadRequest = useRef(0);
  const runnerFormInitialized = useRef(false);
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
      const [nextConfig, nextAccounts, nextRunner] = await Promise.all([
        api("/api/microsoft-registration/config"),
        api(`/api/microsoft-registration/accounts?${params.toString()}`),
        api("/api/microsoft-registration/runner"),
      ]);
      const run = nextRunner.current_run || nextRunner.run;
      const nextLogs = run?.id
        ? await api(`/api/microsoft-registration/runner/logs?runId=${run.id}&limit=80`)
        : { items: [] };
      if (requestId !== loadRequest.current) return;
      setConfig(nextConfig);
      setAccounts(nextAccounts);
      setRunner(nextRunner);
      setRunnerLogs(nextLogs.items || []);
      if (!runnerFormInitialized.current) {
        runnerFormInitialized.current = true;
        setRunnerForm({
          ...defaultRunnerForm,
          captcha_type: nextRunner.captcha_type || defaultRunnerForm.captcha_type,
          proxy_mode: nextRunner.proxy?.mode || defaultRunnerForm.proxy_mode,
          account_format: nextRunner.account_format || defaultRunnerForm.account_format,
          password_format: nextRunner.password_format || defaultRunnerForm.password_format,
          quantity: nextRunner.quantity || defaultRunnerForm.quantity,
          concurrency: nextRunner.concurrency || defaultRunnerForm.concurrency,
          oauth_mode: nextRunner.oauth_mode || defaultRunnerForm.oauth_mode,
          chrome_version: nextRunner.chrome_version || defaultRunnerForm.chrome_version,
        });
      }
    } catch (error) {
      if (requestId === loadRequest.current) toast(error.message, "error");
    } finally {
      if (requestId === loadRequest.current) setLoading(false);
    }
  }, [page, query, status, toast]);

  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => () => { loadRequest.current += 1; }, []);
  const runnerActive = ["starting", "running", "stopping"].includes(runner?.current_run?.status);
  useEffect(() => {
    if (!runnerActive) return undefined;
    const timer = window.setInterval(() => load(), 3_000);
    return () => window.clearInterval(timer);
  }, [runnerActive, load]);

  const updateRunner = (key, value) => setRunnerForm((current) => ({ ...current, [key]: value }));

  const saveRunnerConfiguration = async ({ silent = false } = {}) => {
    const payload = { ...runnerForm };
    if (!payload.captcha_key.trim() && runner?.captcha_key_configured) delete payload.captcha_key;
    if (!payload.proxy_value.trim() && runner?.proxy?.configured && runner.proxy.mode === payload.proxy_mode) delete payload.proxy_value;
    const saved = await api("/api/microsoft-registration/runner/config", { method: "PUT", body: payload });
    setRunner(saved);
    setRunnerForm((current) => ({
      ...current,
      captcha_key: "",
      proxy_value: "",
      captcha_type: saved.captcha_type,
      proxy_mode: saved.proxy?.mode || current.proxy_mode,
      account_format: saved.account_format,
      password_format: saved.password_format,
      quantity: saved.quantity,
      concurrency: saved.concurrency,
      oauth_mode: saved.oauth_mode,
      chrome_version: saved.chrome_version,
    }));
    if (!silent) toast("服务器注册配置已保存");
    return saved;
  };

  const saveRunner = async () => {
    setSavingRunner(true);
    try {
      await saveRunnerConfiguration();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setSavingRunner(false);
    }
  };

  const startRunner = async () => {
    setStartingRunner(true);
    try {
      await saveRunnerConfiguration({ silent: true });
      const result = await api("/api/microsoft-registration/runner/start", { method: "POST" });
      setRunner((current) => ({ ...current, run: result.run, current_run: result.run, configured: true }));
      toast("服务器注册机已启动，结果会自动显示在下方");
      await load();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setStartingRunner(false);
    }
  };

  const stopRunner = async () => {
    setStoppingRunner(true);
    try {
      const result = await api("/api/microsoft-registration/runner/stop", { method: "POST" });
      setRunner((current) => ({ ...current, run: result.run || current?.run, current_run: null }));
      toast(result.stopped ? "服务器注册机已停止" : "当前没有运行中的注册任务");
      await load();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setStoppingRunner(false);
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

  if (!config || !accounts || !runner) return <div className="page-stack"><LoadingBlock rows={9} /></div>;
  const activeRun = runner.current_run;
  const visibleRun = activeRun || runner.run;

  return <div className="page-stack microsoft-registration-page">
    <section className="panel microsoft-registration-runner">
      <header className="panel-header"><div><h2>服务器直接注册</h2><p>不用下载或打开 Windows 程序；保存配置后直接点击开始注册。</p></div><RunnerStatus run={visibleRun} /></header>
      {!runner.available && <div className="inline-alert error"><AlertTriangle size={16} /><span>{!runner.encryption_ready ? "服务器加密配置未完成，暂时不能保存注册参数。" : "服务器注册机尚未部署完成。"}</span></div>}
      <div className="microsoft-registration-runner-layout">
        <section className="microsoft-registration-runner-form">
          <header><span><Server size={19} /></span><div><b>填写一次，后面直接开始</b><small>打码 Key 与代理会加密保存；再次使用时可以留空。</small></div></header>
          <div className="form-grid two">
            <FormField label="打码平台"><select value={runnerForm.captcha_type} onChange={(event) => updateRunner("captcha_type", event.target.value)}><option value="3">CaptchaRun Two</option><option value="1">CaptchaRun</option><option value="2">EZ-Captcha</option></select></FormField>
            <FormField label="打码 Key" hint={runner.captcha_key_configured ? "已保存；留空不会覆盖原 Key。" : "注册机必须填写。"}><input type="password" autoComplete="new-password" value={runnerForm.captcha_key} onChange={(event) => updateRunner("captcha_key", event.target.value)} placeholder={runner.captcha_key_configured ? "已保存" : "粘贴打码平台 Key"} /></FormField>
          </div>
          <FormField label="代理方式"><select value={runnerForm.proxy_mode} onChange={(event) => updateRunner("proxy_mode", event.target.value)}><option value="list">账号密码代理列表</option><option value="api">动态代理 API</option></select></FormField>
          {runnerForm.proxy_mode === "list" ? <FormField label="账号密码代理" hint={runner.proxy?.configured ? `已保存 ${runner.proxy.count} 条；留空继续使用。` : "每行一个：username:password@host:port"}><textarea value={runnerForm.proxy_value} onChange={(event) => updateRunner("proxy_value", event.target.value)} rows={5} placeholder={runner.proxy?.configured ? "需要替换代理时再粘贴新列表" : "username:password@host:port"} /></FormField> : <FormField label="动态代理 API" hint={runner.proxy?.configured ? "已保存；留空继续使用。" : "填写代理平台 API 地址。"}><input value={runnerForm.proxy_value} onChange={(event) => updateRunner("proxy_value", event.target.value)} placeholder={runner.proxy?.configured ? "需要替换时再填写" : "https://..."} /></FormField>}
          <div className="form-grid three">
            <FormField label="账号格式" hint="a=小写、A=大写、1=数字"><input value={runnerForm.account_format} onChange={(event) => updateRunner("account_format", event.target.value)} /></FormField>
            <FormField label="注册数量"><input type="number" min="1" max="10000" value={runnerForm.quantity} onChange={(event) => updateRunner("quantity", event.target.value)} /></FormField>
            <FormField label="并发数"><input type="number" min="1" max="100" value={runnerForm.concurrency} onChange={(event) => updateRunner("concurrency", event.target.value)} /></FormField>
          </div>
          <div className="microsoft-registration-runner-actions"><Button icon={Save} loading={savingRunner} disabled={!runner.available || runnerActive} onClick={saveRunner}>保存配置</Button>{runnerActive ? <Button variant="danger" icon={Square} loading={stoppingRunner} onClick={stopRunner}>停止注册</Button> : <Button variant="primary" icon={Play} loading={startingRunner} disabled={!runner.available} onClick={startRunner}>保存并开始注册</Button>}</div>
        </section>
        <aside className="microsoft-registration-runner-status">
          <header><span><Activity size={18} /></span><div><b>{visibleRun ? `任务 #${visibleRun.id}` : "还没有任务"}</b><small>{visibleRun?.message || "保存配置后，点击“保存并开始注册”。"}</small></div><RunnerStatus run={visibleRun} /></header>
          {visibleRun && <dl><div><dt>计划注册</dt><dd>{visibleRun.quantity} 个</dd></div><div><dt>已回传</dt><dd>{visibleRun.received_count} 个</dd></div><div><dt>代理</dt><dd>{visibleRun.proxy_count || 0} 条</dd></div><div><dt>并发</dt><dd>{visibleRun.concurrency || 1}</dd></div></dl>}
          <div className="microsoft-registration-runner-log"><div><Terminal size={15} /><b>运行日志</b></div>{runnerLogs.length ? <pre>{runnerLogs.slice(-8).map((item) => `[${item.stream}] ${item.message}`).join("\n")}</pre> : <p>启动后会在这里显示服务器注册机状态。</p>}</div>
        </aside>
      </div>
    </section>

    <section className="metric-grid">
      <article className="metric-card"><span className="metric-icon blue"><MailPlus size={19} /></span><div><span>回传注册邮箱</span><strong>{config.accounts}</strong><small>已接收的唯一邮箱</small></div></article>
      <article className="metric-card"><span className="metric-icon green"><CheckCircle2 size={19} /></span><div><span>注册成功</span><strong>{config.successful_accounts}</strong><small>来自注册机结果</small></div></article>
      <article className="metric-card"><span className="metric-icon coral"><AlertTriangle size={19} /></span><div><span>注册失败</span><strong>{config.failed_accounts}</strong><small>保留失败记录便于重试</small></div></article>
      <article className="metric-card"><span className="metric-icon amber"><Server size={19} /></span><div><span>最近回传</span><strong>{config.last_received_at ? formatDate(config.last_received_at, false) : "-"}</strong><small>{config.imports} 次原始回传已加密保存</small></div></article>
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
      </> : <EmptyState icon={MailPlus} title="还没有微软注册记录" description="启动上方的服务器注册机后，成功或失败的结果会自动显示在这里。" action={!runnerActive && runner.available ? <Button variant="primary" icon={Play} onClick={startRunner}>开始注册</Button> : undefined} />}
    </section>

    <CredentialModal credentials={credentials} onClose={() => setCredentials(null)} onCopy={(value) => copy(value, "凭据已复制")} />
    <ConfirmDialog open={Boolean(pendingDelete)} onClose={() => setPendingDelete(null)} onConfirm={remove} loading={deleting} danger title="删除微软注册记录？" description="只删除 AliasHub 中的回传记录，不会删除 Windows 注册机中的账号，也不会删除已加入的源头邮箱。" confirmText="确认删除" />
  </div>;
}
