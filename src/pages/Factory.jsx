import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, AtSign, CheckCircle2, Copy, Download, ExternalLink, Gauge, Layers3, ListPlus, LoaderCircle, LockKeyhole, Mail, Play, Sparkles, Square, WandSparkles } from "lucide-react";
import { api, appUrl } from "../api.js";
import { Button, EmptyState, FormField, LoadingBlock, ProviderMark, Segmented, StatusBadge, useToast } from "../components.jsx";
import AliasSyncModal from "../AliasSyncModal.jsx";
import { accountSupportsOfficialAliases, providerMeta } from "../providers.js";
import { accountStatus, copyText, jobStatus, kindText, relativeTime } from "../utils.js";

function BaseAddressRow({ item, selectable = false, selected = false, onToggle }) {
  return (
    <label className={`base-address-row ${selectable ? "selectable" : ""} ${selected ? "selected" : ""}`}>
      {selectable && <input type="checkbox" checked={selected} onChange={() => onToggle(item.id)} />}
      <span className={`address-kind-icon kind-${item.kind}`}>{item.kind === "primary" ? <LockKeyhole size={15} /> : <AtSign size={15} />}</span>
      <span><b>{item.address}</b><small>{kindText[item.kind]} · {item.label}</small></span>
      {item.remote_confirmed ? <span className="confirmed-mark"><CheckCircle2 size={14} />邮箱已确认</span> : null}
    </label>
  );
}

function JobProgress({ job, onReconnect, onDownload, onManual, onCancel, cancelling }) {
  if (!job) return null;
  const percent = job.progress_target ? Math.min(100, Math.round(job.progress_current / job.progress_target * 100)) : job.status === "running" ? 40 : 0;
  return (
    <section className={`job-progress-card job-${job.status}`}>
      <div className="job-progress-head"><span>{["queued", "running"].includes(job.status) ? <LoaderCircle className="spin" size={18} /> : job.status === "completed" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}</span><div><b>{jobStatus[job.status]}</b><small>{job.message}</small></div><StatusBadge status={job.status}>{job.progress_current}/{job.progress_target || "-"}</StatusBadge></div>
      <div className="job-progress-track"><i style={{ width: `${percent}%` }} /></div>
      {job.status === "waiting_user" && <div className="job-progress-actions"><Button size="sm" icon={ListPlus} loading={cancelling} onClick={onManual}>改用手工登记</Button><Button size="sm" icon={Download} onClick={onDownload}>下载连接器</Button><Button size="sm" icon={ExternalLink} onClick={onReconnect}>打开微软官网</Button><Button size="sm" variant="danger-ghost" icon={Square} loading={cancelling} onClick={onCancel}>取消任务</Button></div>}
    </section>
  );
}

export default function FactoryPage({ refreshKey, onDataChange, onNavigate, active = true, initialAccountId, initialMode, navigationKey = 0 }) {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState(initialAccountId ? String(initialAccountId) : "");
  const [detail, setDetail] = useState(null);
  const [mode, setMode] = useState(initialMode || "official");
  const [officialForm, setOfficialForm] = useState({ prefix: "", mode: "random", label: "微软官方别名", purpose: "" });
  const [splitForm, setSplitForm] = useState({ prefix: "use", mode: "sequence", countPerBase: 10, randomLength: 6, label: "", purpose: "" });
  const [selectedBases, setSelectedBases] = useState(new Set());
  const [job, setJob] = useState(null);
  const [created, setCreated] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [aliasSyncOpen, setAliasSyncOpen] = useState(false);
  const selectionAccountId = useRef("");
  const detailRequest = useRef(0);
  const toast = useToast();

  const loadAccounts = async () => {
    const result = await api("/api/accounts");
    setAccounts(result.items);
    setAccountId((current) => current || String(result.items[0]?.id || ""));
  };
  const loadDetail = async (id = accountId) => {
    const requestId = ++detailRequest.current;
    if (!id) { setDetail(null); return; }
    let result;
    try {
      result = await api(`/api/accounts/${id}`);
    } catch (error) {
      if (requestId !== detailRequest.current) return;
      throw error;
    }
    if (requestId !== detailRequest.current) return;
    setDetail(result);
    setSelectedBases((current) => {
      if (selectionAccountId.current === String(id)) {
        const validIds = new Set(result.baseAddresses.map((item) => item.id));
        return new Set([...current].filter((itemId) => validIds.has(itemId)));
      }
      selectionAccountId.current = String(id);
      return new Set(result.baseAddresses.map((item) => item.id));
    });
    const activeJob = result.jobs.find((item) => ["queued", "running", "waiting_user", "limited"].includes(item.status) && item.type === "official_fill");
    setJob(activeJob || null);
  };
  useEffect(() => {
    setLoading(true);
    loadAccounts().catch((error) => toast(error.message, "error")).finally(() => setLoading(false));
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const nextAccountId = initialAccountId ? String(initialAccountId) : "";
    if (nextAccountId && nextAccountId !== accountId) {
      setAccountId(nextAccountId);
      setJob(null);
      setCreated([]);
      setSelectedBases(new Set());
      selectionAccountId.current = "";
    }
    if (initialMode) setMode(initialMode);
  }, [initialAccountId, initialMode, navigationKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!active) setAliasSyncOpen(false); }, [active]);
  useEffect(() => {
    if (!accounts.length || accounts.some((item) => item.id === Number(accountId))) return;
    setAccountId(String(accounts[0].id));
    setJob(null);
    setCreated([]);
    setSelectedBases(new Set());
    selectionAccountId.current = "";
  }, [accounts, accountId]);
  useEffect(() => { loadDetail().catch((error) => toast(error.message, "error")); }, [accountId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!job || !["queued", "running", "waiting_user"].includes(job.status)) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const result = await api(`/api/jobs/${job.id}`);
        setJob(result.job);
        if (!["queued", "running", "waiting_user"].includes(result.job.status)) {
          window.clearInterval(timer);
          await Promise.all([loadDetail(), loadAccounts()]);
          onDataChange();
          toast(result.job.message, result.job.status === "failed" ? "error" : "success");
        }
      } catch { /* Keep the current progress while a poll is retried. */ }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedAccount = accounts.find((item) => item.id === Number(accountId));
  const selectedProvider = providerMeta(selectedAccount?.provider);
  const supportsOfficial = accountSupportsOfficialAliases(selectedAccount);
  const effectiveMode = supportsOfficial ? mode : "split";
  useEffect(() => {
    if (!selectedAccount || supportsOfficial) return;
    if (mode !== "split") setMode("split");
    setAliasSyncOpen(false);
    setJob(null);
  }, [selectedAccount?.id, supportsOfficial, mode]);
  const toggleBase = (id) => setSelectedBases((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const selectAll = () => setSelectedBases(new Set(detail?.baseAddresses.map((item) => item.id) || []));
  const clearAll = () => setSelectedBases(new Set());
  const updateOfficial = (key, value) => setOfficialForm((current) => ({ ...current, [key]: value }));
  const updateSplit = (key, value) => setSplitForm((current) => ({ ...current, [key]: value }));

  const startOfficial = async () => {
    if (!selectedAccount || !supportsOfficial) return;
    const popup = window.open("about:blank", "aliashub-microsoft-aliases");
    setSubmitting(true);
    try {
      const result = await api(`/api/accounts/${selectedAccount.id}/official-fill`, { method: "POST", body: officialForm });
      if (popup) popup.location.href = result.officialUrl;
      setJob(result.job); toast("自动任务已创建，请保持连接器运行"); onDataChange();
    } catch (error) { popup?.close(); toast(error.message, "error"); if (error.status === 409 && selectedAccount.status !== "connected") onNavigate("sources"); }
    finally { setSubmitting(false); }
  };
  const stopJob = async (useManual = false) => {
    if (!job) return;
    setCancelling(true);
    try {
      const result = await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
      setJob(result.job);
      await Promise.all([loadDetail(), loadAccounts()]);
      onDataChange();
      if (useManual) {
        setAliasSyncOpen(true);
        toast("自动任务已取消，请登记官网已创建的别名");
      } else {
        toast("任务已取消");
      }
    } catch (error) { toast(error.message, "error"); } finally { setCancelling(false); }
  };
  const reconnectOfficial = async () => {
    if (!job) return;
    const popup = window.open("about:blank", "aliashub-microsoft-aliases");
    try {
      const result = await api(`/api/jobs/${job.id}/official-launch`, { method: "POST" });
      if (popup) { popup.location.href = result.officialUrl; popup.focus(); }
      else toast("浏览器拦截了微软官网窗口，请允许此网站打开弹窗", "error");
    } catch (error) {
      popup?.close();
      toast(error.message, "error");
    }
  };
  const downloadExtension = () => { window.location.href = appUrl("/api/extension/download"); };
  const generate = async () => {
    if (!selectedBases.size) return toast("至少选择一个基础地址", "error");
    setSubmitting(true);
    try {
      const result = await api(`/api/accounts/${selectedAccount.id}/splits`, { method: "POST", body: { ...splitForm, baseAddressIds: [...selectedBases], countPerBase: Number(splitForm.countPerBase), randomLength: Number(splitForm.randomLength) } });
      setCreated(result.items); toast(`已生成 ${result.count} 个分裂地址`); await Promise.all([loadDetail(), loadAccounts()]); onDataChange();
    } catch (error) { toast(error.message, "error"); } finally { setSubmitting(false); }
  };
  const copyCreated = async () => { await copyText(created.map((item) => item.address).join("\n")); toast(`已复制 ${created.length} 个地址`); };
  const aliasSyncDone = async () => {
    await Promise.all([loadDetail(), loadAccounts()]);
    onDataChange();
  };
  const estimatedTotal = selectedBases.size * (Number(splitForm.countPerBase) || 0);
  const preview = useMemo(() => {
    const base = detail?.baseAddresses.find((item) => selectedBases.has(item.id))?.address;
    if (!base) return "选择基础地址后显示预览";
    const [local, domain] = base.split("@");
    const suffix = splitForm.mode === "random" ? "x7k29p" : splitForm.mode === "dated" ? `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-001` : "0001";
    return `${local}+${splitForm.prefix || "use"}-${suffix}@${domain}`;
  }, [detail, selectedBases, splitForm]);

  if (loading && !accounts.length) return <div className="page-stack"><LoadingBlock rows={8} /></div>;
  if (!accounts.length) return <div className="page-stack"><EmptyState icon={Mail} title="先添加一个源头邮箱" description="别名工厂需要至少一个 Microsoft 或 Google 源头邮箱。" action={<Button variant="primary" onClick={() => onNavigate("sources")}>添加源头邮箱</Button>} /></div>;

  return (
    <div className="page-stack factory-page">
      <div className="factory-account-bar">
        <div className="account-selector"><ProviderMark provider={selectedProvider.id} size={34} /><span><small>当前源头邮箱 · {selectedProvider.name}</small><select value={accountId} onChange={(event) => { setAccountId(event.target.value); setJob(null); setCreated([]); setSelectedBases(new Set()); selectionAccountId.current = ""; }}>{accounts.map((account) => <option key={account.id} value={account.id}>{providerMeta(account.provider).name} · {account.display_name ? `${account.display_name} · ` : ""}{account.email}</option>)}</select></span></div>
        {selectedAccount && <div className="account-bar-stats">{supportsOfficial ? <span><b>{selectedAccount.official_used}/{selectedAccount.official_limit}</b> 基础地址</span> : <span><b>Plus</b> 分裂可用</span>}<span><b>{selectedAccount.split_count}</b> 分裂地址</span><StatusBadge status={selectedAccount.status}>{accountStatus[selectedAccount.status]}</StatusBadge></div>}
      </div>
      <Segmented value={effectiveMode} onChange={setMode} ariaLabel="别名生成模式" items={supportsOfficial ? [{ value: "official", label: "官方别名", icon: AtSign }, { value: "split", label: "分裂地址", icon: WandSparkles }] : [{ value: "split", label: "Plus 分裂地址", icon: WandSparkles }]} />

      {effectiveMode === "official" ? (
        <div className="factory-two-column">
          <section className="panel factory-form-panel">
            <header className="panel-header"><div><h2>连接器自动生成（可选）</h2><p>自动批量创建，并按微软官网实际反馈停止</p></div><span className="quota-pill"><Gauge size={15} />剩余记录名额 {selectedAccount?.official_remaining || 0}</span></header>
            <div className="form-stack">
              <div className="form-grid two"><FormField label="地址前缀" hint="可留空"><input value={officialForm.prefix} onChange={(event) => updateOfficial("prefix", event.target.value)} placeholder="例如 alex" /></FormField><FormField label="生成形式"><select value={officialForm.mode} onChange={(event) => updateOfficial("mode", event.target.value)}><option value="random">随机字符</option><option value="readable">易读单词</option><option value="sequence">连续编号</option></select></FormField></div>
              <div className="form-grid two"><FormField label="统一标签"><input value={officialForm.label} onChange={(event) => updateOfficial("label", event.target.value)} /></FormField><FormField label="用途"><input value={officialForm.purpose} onChange={(event) => updateOfficial("purpose", event.target.value)} placeholder="例如 注册账号" /></FormField></div>
              <div className="official-run-summary"><span className="address-kind-icon kind-official"><AtSign size={17} /></span><div><b>新地址创建为 @outlook.com</b><small>Hotmail、Live 和 MSN 源头号同样遵循此规则</small></div></div>
              <div className="connector-prerequisite"><Download size={18} /><span><b>AliasHub 官网连接器（可选）</b><small>仅自动生成需要；不用连接器可在官网创建后手工登记</small></span><div className="connector-actions"><Button size="sm" icon={ListPlus} onClick={() => setAliasSyncOpen(true)}>手工登记</Button><Button size="sm" icon={Download} onClick={downloadExtension}>下载连接器</Button></div></div>
              <Button variant="primary" size="lg" icon={Play} loading={submitting} disabled={selectedAccount?.status !== "connected" || ["queued", "running", "waiting_user"].includes(job?.status)} onClick={startOfficial}>使用连接器自动生成</Button>
              {selectedAccount?.status !== "connected" && <div className="inline-alert warning"><AlertCircle size={16} /><span>这个源头邮箱需要重新登录后才能操作微软官网。</span><Button size="sm" onClick={() => onNavigate("sources")}>去登录</Button></div>}
              <JobProgress job={job} onReconnect={reconnectOfficial} onDownload={downloadExtension} onManual={() => stopJob(true)} onCancel={() => stopJob(false)} cancelling={cancelling} />
            </div>
          </section>
          <section className="panel base-list-panel"><header className="panel-header"><div><h2>可分裂基础地址</h2><p>源头号和官网确认的官方别名</p></div><div className="base-list-actions"><span className="panel-stat">{detail?.baseAddresses.length || 0} 个</span><Button size="sm" icon={ListPlus} onClick={() => setAliasSyncOpen(true)}>手工登记</Button></div></header><div className="base-address-list">{detail?.baseAddresses.map((item) => <BaseAddressRow item={item} key={item.id} />)}</div></section>
        </div>
      ) : (
        <div className="factory-two-column split-layout">
          <section className="panel base-list-panel selectable-bases"><header className="panel-header"><div><h2>选择基础地址</h2><p>{supportsOfficial ? "源头号和每个官方别名都能独立分裂" : "Google 主地址支持 +tag 分裂"}</p></div><div className="tiny-actions"><button onClick={selectAll}>全选</button><button onClick={clearAll}>清空</button></div></header><div className="base-address-list">{detail?.baseAddresses.map((item) => <BaseAddressRow item={item} key={item.id} selectable selected={selectedBases.has(item.id)} onToggle={toggleBase} />)}</div></section>
          <section className="panel factory-form-panel split-form-panel">
            <header className="panel-header"><div><h2>批量生成 Plus 分裂地址</h2><p>{supportsOfficial ? "不占用 Microsoft 官方别名名额" : "使用 Gmail/Workspace 主地址接收邮件"}</p></div><span className="quota-pill"><Layers3 size={15} />预计 {estimatedTotal} 个</span></header>
            <div className="form-stack">
              <div className="form-grid two"><FormField label="用途前缀"><input value={splitForm.prefix} onChange={(event) => updateSplit("prefix", event.target.value)} placeholder="例如 shop" /></FormField><FormField label="每个基础地址生成"><input type="number" min="1" max="2000" value={splitForm.countPerBase} onChange={(event) => updateSplit("countPerBase", Math.max(1, Math.min(2000, Number(event.target.value))))} /></FormField></div>
              <FormField label="编号方式"><Segmented value={splitForm.mode} onChange={(value) => updateSplit("mode", value)} items={[{ value: "sequence", label: "连续编号" }, { value: "random", label: "随机字符" }, { value: "dated", label: "日期编号" }]} /></FormField>
              <div className="form-grid two"><FormField label="统一标签"><input value={splitForm.label} onChange={(event) => updateSplit("label", event.target.value)} placeholder="例如 商店注册" /></FormField><FormField label="用途"><input value={splitForm.purpose} onChange={(event) => updateSplit("purpose", event.target.value)} /></FormField></div>
              <div className="split-preview"><small>地址预览</small><code>{preview}</code></div>
              <Button variant="primary" size="lg" icon={Sparkles} loading={submitting} disabled={!selectedBases.size || estimatedTotal > 5000} onClick={generate}>生成 {estimatedTotal} 个分裂地址</Button>
              {estimatedTotal > 5000 && <div className="inline-alert danger"><AlertCircle size={16} /><span>单次最多生成 5000 个，请减少数量。</span></div>}
            </div>
          </section>
        </div>
      )}

      {created.length > 0 && <section className="panel created-results"><header className="panel-header"><div><h2>本次生成结果</h2><p>{created.length} 个地址已保存到地址仓库</p></div><Button icon={Copy} onClick={copyCreated}>复制全部</Button></header><div className="created-address-grid">{created.slice(0, 18).map((item) => <button key={item.id} onClick={() => copyText(item.address).then(() => toast("地址已复制"))}><span><b>{item.address}</b><small>基础地址：{item.parent_address}</small></span><Copy size={14} /></button>)}</div>{created.length > 18 && <button className="show-all-result" onClick={() => onNavigate("addresses", { accountId: selectedAccount.id })}>另有 {created.length - 18} 个，前往地址仓库查看</button>}</section>}
      <AliasSyncModal account={aliasSyncOpen && supportsOfficial ? selectedAccount : null} onClose={() => setAliasSyncOpen(false)} onSynced={aliasSyncDone} />
    </div>
  );
}
