import { useEffect, useState } from "react";
import { ArchiveRestore, Check, Copy, KeyRound, LoaderCircle, Mail, RefreshCw, Search, Trash2 } from "lucide-react";
import { api, queryString } from "../api.js";
import { Button, ConfirmDialog, EmptyState, LoadingBlock, ProviderMark, Segmented, StatusBadge, useToast } from "../components.jsx";
import { accountOptionLabel, providerMeta } from "../providers.js";
import { copyText, relativeTime } from "../utils.js";

export default function CodesPage({ refreshKey, onDataChange, initialAccountId }) {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState(initialAccountId ? String(initialAccountId) : "all");
  const [filter, setFilter] = useState("unused");
  const [search, setSearch] = useState("");
  const [data, setData] = useState(null);
  const [scanning, setScanning] = useState(new Map());
  const [updatingId, setUpdatingId] = useState(null);
  const [markAllOpen, setMarkAllOpen] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();
  const load = async () => {
    try {
      const codeFilter = filter === "hidden" ? { hidden: "true" } : { unused: "true" };
      const [accountData, codeData] = await Promise.all([
        api("/api/accounts"),
        api(`/api/codes${queryString({ accountId, ...codeFilter, q: search })}`),
      ]);
      setAccounts(accountData.items); setData(codeData);
    } catch (error) { toast(error.message, "error"); }
  };
  useEffect(() => { if (initialAccountId) setAccountId(String(initialAccountId)); }, [initialAccountId]);
  useEffect(() => { const timer = window.setTimeout(load, 150); return () => window.clearTimeout(timer); }, [accountId, filter, search, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const pollJob = (account, jobId) => {
    const poll = async () => {
      try {
        const result = await api(`/api/jobs/${jobId}`);
        setScanning((current) => new Map(current).set(account.id, result.job));
        if (["queued", "running"].includes(result.job.status)) return window.setTimeout(poll, 2_000);
        toast(result.job.message, result.job.status === "failed" ? "error" : "success");
        setScanning((current) => { const next = new Map(current); next.delete(account.id); return next; });
        load(); onDataChange();
      } catch (error) { toast(error.message, "error"); setScanning((current) => { const next = new Map(current); next.delete(account.id); return next; }); }
    };
    poll();
  };
  const scan = async (account) => {
    try {
      setScanning((current) => new Map(current).set(account.id, { status: "queued", message: "正在排队" }));
      const result = await api(`/api/accounts/${account.id}/scan-codes`, { method: "POST" });
      pollJob(account, result.job.id);
    } catch (error) { toast(error.message, "error"); setScanning((current) => { const next = new Map(current); next.delete(account.id); return next; }); }
  };
  const scanSelected = async () => {
    const targets = accountId === "all" ? accounts.filter((item) => item.status === "connected") : accounts.filter((item) => item.id === Number(accountId) && item.status === "connected");
    if (!targets.length) return toast("没有可扫描的已连接邮箱", "error");
    targets.forEach(scan);
  };
  const markUsed = async (item) => {
    setUpdatingId(item.id);
    try {
      await api(`/api/codes/${item.id}`, { method: "PATCH", body: { isUsed: true } });
      toast("验证码已使用并移到回收站");
      await load(); onDataChange();
    } catch (error) { toast(error.message, "error"); }
    finally { setUpdatingId(null); }
  };
  const markAllUsed = async () => {
    setMarkingAll(true);
    try {
      const result = await api("/api/codes/mark-used", { method: "POST", body: { accountId, q: search.trim() } });
      toast(result.marked ? `已将 ${result.marked} 条已用验证码移到回收站` : "没有需要标记的验证码");
      setMarkAllOpen(false); await load(); onDataChange();
    } catch (error) { toast(error.message, "error"); }
    finally { setMarkingAll(false); }
  };
  const restoreCode = async (item) => {
    setUpdatingId(item.id);
    try {
      await api(`/api/codes/${item.id}`, { method: "PATCH", body: { isHidden: false } });
      toast("验证码已恢复为未使用"); await load(); onDataChange();
    } catch (error) { toast(error.message, "error"); }
    finally { setUpdatingId(null); }
  };
  const permanentlyDelete = async () => {
    if (!deleteConfirm) return;
    const item = deleteConfirm.item;
    setDeleting(true);
    if (item) setUpdatingId(item.id);
    try {
      const result = item
        ? await api(`/api/codes/${item.id}`, { method: "DELETE" })
        : await api("/api/codes/purge-hidden", { method: "POST", body: { accountId, q: search.trim() } });
      const deleted = result?.deleted || 0;
      toast(item ? "验证码已彻底删除" : deleted ? `已彻底删除 ${deleted} 条验证码` : "回收站已为空");
      setDeleteConfirm(null); await load(); onDataChange();
    } catch (error) { toast(error.message, "error"); }
    finally { setDeleting(false); setUpdatingId(null); }
  };
  const copyCode = async (code) => { await copyText(code); toast(`验证码 ${code} 已复制`); };
  const isScanning = scanning.size > 0;
  const selectedAccount = accounts.find((item) => item.id === Number(accountId));
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const emptyContent = {
    unused: { title: "没有未使用验证码", description: "扫描已连接的邮箱后，新验证码会显示在这里。" },
    hidden: { title: "回收站为空", description: "使用过的验证码会自动移到这里，并可恢复为未使用。" },
  }[filter];

  return (
    <div className="page-stack codes-page">
      <div className="page-toolbar">
        <Segmented value={filter} onChange={setFilter} ariaLabel="验证码状态" items={[{ value: "unused", label: "未使用", count: data?.unused || 0 }, { value: "hidden", label: "回收站", count: data?.hidden || 0 }]} />
        <div className="toolbar-actions codes-toolbar-actions">
          <label className="search-box"><Search size={16} /><input maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索验证码、发件人或地址" /></label>
          <select className="compact-select" value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="all">全部源头邮箱</option>{accounts.map((account) => <option key={account.id} value={account.id}>{accountOptionLabel(account)}</option>)}</select>
          {filter === "unused" && <Button icon={Check} className="codes-mark-used-button" disabled={!data?.unused || updatingId !== null || markingAll || deleting} onClick={() => setMarkAllOpen(true)}>全部标记已用</Button>}
          {filter === "hidden"
            && <Button variant="danger-ghost" icon={Trash2} loading={deleting && deleteConfirm?.all} disabled={!data?.hidden || updatingId !== null || deleting} onClick={() => setDeleteConfirm({ all: true })}>{search.trim() ? "删除搜索结果" : "清空回收站"}</Button>}
          <Button variant="primary" icon={isScanning ? LoaderCircle : RefreshCw} className={isScanning ? "spin-icon codes-scan-button" : "codes-scan-button"} disabled={deleting || markingAll} onClick={scanSelected}>扫描收件箱</Button>
        </div>
      </div>
      {isScanning && <section className="scan-status-bar"><LoaderCircle className="spin" size={17} /><span>后台正在扫描 {scanning.size} 个源头邮箱</span><div>{[...scanning.entries()].map(([id, job]) => <span key={id}>{accounts.find((item) => item.id === id)?.email}<small>{job.message}</small></span>)}</div></section>}
      {!data ? <LoadingBlock rows={8} /> : data.items.length ? <section className="code-grid">{data.items.map((item) => {
        const itemProvider = providerMeta(item.source_provider || accountById.get(item.account_id)?.provider);
        return <article className={`verification-card ${item.is_used ? "used" : ""} ${item.is_hidden ? "hidden" : ""}`} key={item.id}>
          <header><span className="code-provider"><ProviderMark provider={itemProvider.id} size={28} /><span><b>{item.sender}</b><small>{itemProvider.name} · {item.subject}</small></span></span><StatusBadge status={item.is_hidden ? "paused" : "active"}>{item.is_hidden ? "回收站" : "可使用"}</StatusBadge></header>
          <button className="verification-code" onClick={() => copyCode(item.code)}><span>{item.code}</span><Copy size={17} /></button>
          <div className="address-chain"><span><Mail size={14} />源头号<b>{item.source_email}</b></span>{item.parent_address && <span><AtSignIcon />基础地址<b>{item.parent_address}</b></span>}{item.address && <span><KeyRound size={14} />收件地址<b>{item.address}</b></span>}</div>
          <p>{item.preview}</p>
          <footer><time>{relativeTime(item.received_at)}</time><div className="code-card-actions">{item.is_hidden ? <><Button size="sm" icon={ArchiveRestore} loading={updatingId === item.id && !deleting} disabled={updatingId !== null || deleting} onClick={() => restoreCode(item)}>恢复为未使用</Button><Button size="sm" variant="danger-ghost" icon={Trash2} disabled={updatingId !== null || deleting} onClick={() => setDeleteConfirm({ item })}>彻底删除</Button></> : <Button size="sm" icon={Check} loading={updatingId === item.id} disabled={updatingId !== null} onClick={() => markUsed(item)}>标记已用</Button>}</div></footer>
        </article>;
      })}</section> : <section className="table-panel"><EmptyState icon={filter === "hidden" ? ArchiveRestore : KeyRound} title={emptyContent.title} description={emptyContent.description} action={filter === "unused" ? <Button variant="primary" icon={RefreshCw} onClick={scanSelected}>扫描收件箱</Button> : null} /></section>}
      <ConfirmDialog open={markAllOpen} onClose={() => setMarkAllOpen(false)} onConfirm={markAllUsed} loading={markingAll} title="全部标记为已用？" description={`${accountId === "all" ? "所有源头邮箱" : selectedAccount?.email || "当前源头邮箱"}${search.trim() ? "的当前搜索结果" : "中"}共有 ${data?.unused || 0} 条未使用验证码。标记后会立即移到回收站，需要时可恢复为未使用。`} confirmText="标记已用并移入回收站" />
      <ConfirmDialog open={Boolean(deleteConfirm)} onClose={() => { if (!deleting) setDeleteConfirm(null); }} onConfirm={permanentlyDelete} loading={deleting} danger title={deleteConfirm?.item ? "彻底删除这条验证码？" : search.trim() ? "彻底删除搜索结果？" : "清空回收站？"} description={deleteConfirm?.item ? `验证码 ${deleteConfirm.item.code} 将从本系统彻底删除且无法恢复。邮箱服务商中的原邮件不会被删除。` : `将彻底删除当前筛选范围内的 ${data?.hidden || 0} 条验证码，删除后无法恢复。邮箱服务商中的原邮件不会被删除。`} confirmText={deleteConfirm?.item ? "彻底删除" : "永久删除全部"} />
    </div>
  );
}

function AtSignIcon() {
  return <span className="at-sign-text">@</span>;
}
