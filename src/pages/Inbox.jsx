import { useEffect, useRef, useState } from "react";
import {
  ArchiveRestore,
  AlertCircle,
  ArrowLeft,
  CheckSquare,
  ExternalLink,
  Inbox,
  LoaderCircle,
  Mail,
  Paperclip,
  RefreshCw,
  Search,
  Trash2,
  UserRound,
} from "lucide-react";
import { api, queryString } from "../api.js";
import { Button, ConfirmDialog, EmptyState, IconButton, LoadingBlock, Pagination, ProviderMark, Segmented, useToast } from "../components.jsx";
import { accountOptionLabel, providerMeta } from "../providers.js";
import { formatDate, relativeTime } from "../utils.js";

const pageSize = 40;

function senderName(item) {
  return item.sender_name || item.sender_address || "未知发件人";
}

function senderAddress(item) {
  return item.sender_address || item.sender_name || "";
}

function isHtmlMessage(item) {
  return String(item?.body_content_type || "").toLowerCase() === "html"
    || /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(String(item?.body || ""));
}

export default function InboxPage({ refreshKey, onDataChange, initialAccountId }) {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState(initialAccountId ? String(initialAccountId) : "all");
  const [folder, setFolder] = useState("inbox");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [listError, setListError] = useState("");
  const [selected, setSelected] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [scanning, setScanning] = useState(new Map());
  const [confirm, setConfirm] = useState(null);
  const [updating, setUpdating] = useState(false);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const toast = useToast();

  const load = async () => {
    const requestId = ++listRequest.current;
    setListError("");
    try {
      const [accountData, messageData] = await Promise.all([
        api("/api/accounts?includeInboxLinks=true"),
        api(`/api/messages${queryString({ accountId, q: search, hidden: folder === "trash" ? "true" : undefined, page, limit: pageSize })}`),
      ]);
      if (requestId !== listRequest.current) return;
      if (page > (messageData.pages || 1)) { setPage(messageData.pages || 1); return; }
      setAccounts(accountData.items || []);
      setData(messageData);
      setActiveId((current) => messageData.items?.some((item) => item.id === current) ? current : messageData.items?.[0]?.id || null);
    } catch (error) {
      if (requestId === listRequest.current) { setListError(error.message); toast(error.message, "error"); }
    }
  };

  useEffect(() => { if (initialAccountId) setAccountId(String(initialAccountId)); }, [initialAccountId]);
  useEffect(() => {
    listRequest.current += 1;
    const timer = window.setTimeout(load, 140);
    return () => window.clearTimeout(timer);
  }, [accountId, folder, search, page, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setPage(1), [accountId, folder, search]);
  useEffect(() => setSelected([]), [accountId, folder, search, page]);
  useEffect(() => setMobileDetailOpen(false), [accountId, folder, search, page]);
  useEffect(() => { setData(null); setActiveId(null); }, [accountId, folder]);

  useEffect(() => {
    if (!activeId) { setDetail(null); setDetailError(""); return undefined; }
    const requestId = ++detailRequest.current;
    const fallback = data?.items?.find((item) => item.id === activeId) || null;
    setDetail(fallback);
    setDetailLoading(true);
    setDetailError("");
    api(`/api/messages/${activeId}`).then((result) => {
      if (requestId === detailRequest.current) setDetail(result.item || result);
    }).catch((error) => {
      if (requestId === detailRequest.current) { setDetailError(error.message); toast(error.message, "error"); }
    }).finally(() => {
      if (requestId === detailRequest.current) setDetailLoading(false);
    });
    return () => { detailRequest.current += 1; };
  }, [activeId, detailReloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const pollJob = (account, jobId) => {
    const poll = async () => {
      try {
        const result = await api(`/api/jobs/${jobId}`);
        setScanning((current) => new Map(current).set(account.id, result.job));
        if (["queued", "running"].includes(result.job.status)) return window.setTimeout(poll, 2_000);
        toast(result.job.message, result.job.status === "failed" ? "error" : "success");
        setScanning((current) => { const next = new Map(current); next.delete(account.id); return next; });
        onDataChange();
      } catch (error) {
        toast(error.message, "error");
        setScanning((current) => { const next = new Map(current); next.delete(account.id); return next; });
      }
    };
    poll();
  };

  const scanAccount = async (account) => {
    try {
      setScanning((current) => new Map(current).set(account.id, { status: "queued", message: "正在排队" }));
      const result = await api(`/api/accounts/${account.id}/scan-inbox`, { method: "POST" });
      pollJob(account, result.job.id);
    } catch (error) {
      toast(error.message, "error");
      setScanning((current) => { const next = new Map(current); next.delete(account.id); return next; });
    }
  };

  const scanSelected = () => {
    const targets = accountId === "all"
      ? accounts.filter((item) => item.status === "connected" && item.provider !== "inbox_link")
      : accounts.filter((item) => item.id === Number(accountId) && item.status === "connected");
    if (!targets.length) return toast("请选择一个可扫描的链接取件邮箱", "error");
    targets.forEach(scanAccount);
  };

  const toggle = (id) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const pageIds = data?.items?.map((item) => item.id) || [];
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
  const togglePage = () => setSelected((current) => allPageSelected
    ? current.filter((id) => !pageIds.includes(id))
    : [...new Set([...current, ...pageIds])]);

  const applyMessageAction = async () => {
    if (!confirm) return;
    const ids = confirm.ids || [confirm.item.id];
    const action = confirm.action || (folder === "trash" ? "restore" : "hide");
    setUpdating(true);
    try {
      if (action === "purge") {
        const result = await api("/api/messages/purge-hidden", { method: "POST", body: { ids, accountId } });
        toast(`已永久删除 ${result.deleted} 封邮件`);
      } else {
        const hide = action === "hide";
        if (ids.length === 1) {
          await api(`/api/messages/${ids[0]}`, { method: "PATCH", body: { isHidden: hide } });
        } else {
          await api(`/api/messages/${hide ? "hide" : "restore"}`, { method: "POST", body: { ids } });
        }
        toast(hide ? `已将 ${ids.length} 封邮件移到回收站` : `已恢复 ${ids.length} 封邮件`);
      }
      setConfirm(null); setSelected([]); await load(); onDataChange();
    } catch (error) { toast(error.message, "error"); }
    finally { setUpdating(false); }
  };

  const isScanning = scanning.size > 0;
  const inboxCount = data?.total ?? 0;
  const trashCount = data?.hidden ?? 0;
  const shownCount = folder === "trash" ? trashCount : inboxCount;
  const detailBody = detail?.body || detail?.preview || "";
  const detailIsHtml = Boolean(detail?.body) && isHtmlMessage(detail);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const sourceAccounts = accounts.filter((account) => account.provider !== "inbox_link");
  const inboxLinkAccounts = accounts.filter((account) => account.provider === "inbox_link");
  const detailProvider = providerMeta(detail?.source_provider || accountById.get(detail?.account_id)?.provider);
  const retryDetail = () => setDetailReloadKey((value) => value + 1);
  const emptyCopy = search.trim()
    ? { title: "没有匹配的邮件", description: "请更换关键词或邮箱范围后重试。", action: <Button onClick={() => setSearch("")}>清除搜索</Button> }
    : folder === "trash"
      ? { title: "回收站为空", description: "移到回收站的邮件会显示在这里，并可随时恢复。", action: null }
      : { title: "还没有邮件", description: "扫描已连接的邮箱后，邮件会集中显示在这里。", action: <Button variant="primary" icon={RefreshCw} onClick={scanSelected}>扫描收件箱</Button> };
  const confirmAction = confirm?.action || (folder === "trash" ? "restore" : "hide");
  const confirmCount = confirm?.ids?.length || 1;
  const confirmTitle = confirmAction === "purge" ? "永久删除所选邮件？" : (confirmAction === "restore" ? "恢复邮件？" : "移到回收站？");
  const confirmDescription = confirmAction === "purge"
    ? `将从注册工作站永久删除选中的 ${confirmCount} 封邮件，删除后无法恢复，且不会在下次扫描时重新出现。邮箱服务商中的原邮件和验证码记录不会被删除。`
    : (confirmAction === "restore" ? `将选中的 ${confirmCount} 封邮件恢复到网站收件箱。` : `将选中的 ${confirmCount} 封邮件从网站收件箱隐藏，邮箱服务商中的原邮件不会被删除。`);

  return (
    <div className="mail-center">
      <header className="mail-toolbar">
        <Segmented value={folder} onChange={setFolder} ariaLabel="邮件文件夹" items={[
          { value: "inbox", label: "收件箱", icon: Inbox, count: folder === "inbox" ? inboxCount : undefined },
          { value: "trash", label: "回收站", icon: Trash2, count: trashCount },
        ]} />
        <div className="mail-toolbar-controls">
          <label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索发件人、主题或内容" /></label>
          <select className="compact-select" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="all">全部邮件</option>
            <optgroup label="源头邮箱">
              {sourceAccounts.map((account) => <option key={account.id} value={account.id}>{accountOptionLabel(account)}</option>)}
            </optgroup>
            <optgroup label="链接取件邮箱">
              {inboxLinkAccounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}
            </optgroup>
          </select>
          <Button variant="primary" icon={isScanning ? LoaderCircle : RefreshCw} className={isScanning ? "spin-icon" : ""} disabled={isScanning} onClick={scanSelected}>扫描收件箱</Button>
        </div>
      </header>

      {isScanning && <div className="mail-scan-band"><LoaderCircle className="spin" size={16} /><span>正在同步 {scanning.size} 个邮箱</span><div>{[...scanning.entries()].map(([id, job]) => <small key={id}>{accounts.find((item) => item.id === id)?.email}：{job.message}</small>)}</div></div>}
      {selected.length > 0 && <div className="mail-selection-band"><span><CheckSquare size={15} />已选择 <b>{selected.length}</b> 封邮件</span><div><Button size="sm" onClick={() => setSelected([])}>取消选择</Button>{folder === "trash" ? <><Button size="sm" variant="primary" icon={ArchiveRestore} onClick={() => setConfirm({ action: "restore", ids: selected })}>恢复所选</Button><Button size="sm" variant="danger" icon={Trash2} onClick={() => setConfirm({ action: "purge", ids: selected })}>永久删除</Button></> : <Button size="sm" variant="danger" icon={Trash2} onClick={() => setConfirm({ action: "hide", ids: selected })}>移到回收站</Button>}</div></div>}

      <section className="mail-workspace">
        <aside className="mail-list-pane">
          <div className="mail-list-heading"><label><input type="checkbox" aria-label="选择当前页邮件" checked={allPageSelected} disabled={!pageIds.length} onChange={togglePage} /><span>{folder === "trash" ? "已隐藏邮件" : "全部邮件"}</span></label><small>{shownCount} 封</small></div>
          {!data ? listError ? <EmptyState icon={AlertCircle} title="邮件加载失败" description={listError} action={<Button icon={RefreshCw} onClick={load}>重新加载</Button>} /> : <LoadingBlock rows={7} /> : data.items?.length ? <div className="mail-message-list">{data.items.map((item) => {
            const active = activeId === item.id;
            const checked = selected.includes(item.id);
            const itemProvider = providerMeta(item.source_provider || accountById.get(item.account_id)?.provider);
            return (
              <article className={`mail-message-row ${active ? "active" : ""} ${checked ? "selected" : ""} ${item.is_read ? "read" : "unread"}`} key={item.id}>
                <input type="checkbox" aria-label={`选择 ${item.subject || "无主题邮件"}`} checked={checked} onChange={() => toggle(item.id)} />
                <button type="button" onClick={() => { setActiveId(item.id); setMobileDetailOpen(true); }}>
                  <span className="mail-row-top"><b>{senderName(item)}</b><time>{relativeTime(item.received_at)}</time></span>
                  <strong>{item.subject || "（无主题）"}{item.has_attachments && <Paperclip size={12} aria-label="包含附件" />}</strong>
                  <span className="mail-row-preview">{item.preview || "没有内容预览"}</span>
                  <small>{itemProvider.name} · 发送至 {item.recipient_address || item.address || item.source_email}</small>
                </button>
                <div className="mail-row-actions">{folder === "trash" ? <><IconButton icon={ArchiveRestore} label="恢复邮件" size={30} onClick={() => setConfirm({ action: "restore", item })} /><IconButton icon={Trash2} label="永久删除邮件" size={30} onClick={() => setConfirm({ action: "purge", item })} /></> : <IconButton icon={Trash2} label="移到回收站" size={30} onClick={() => setConfirm({ action: "hide", item })} />}</div>
              </article>
            );
          })}</div> : <EmptyState icon={folder === "trash" ? Trash2 : Mail} title={emptyCopy.title} description={emptyCopy.description} action={emptyCopy.action} />}
          {data && <footer className="mail-list-footer"><span>第 {data.page || page} 页</span><Pagination page={data.page || page} pages={data.pages || 1} onChange={setPage} /></footer>}
        </aside>

        <article className={`mail-detail-pane ${mobileDetailOpen ? "mobile-open" : ""}`}>
          {detail ? <>
            <header className="mail-detail-header">
              <IconButton className="mail-detail-back" icon={ArrowLeft} label="返回邮件列表" onClick={() => setMobileDetailOpen(false)} />
              <div><h2>{detail.subject || "（无主题）"}</h2><span><b>{senderName(detail)}</b>{senderAddress(detail) && senderAddress(detail) !== senderName(detail) && <small>&lt;{senderAddress(detail)}&gt;</small>}</span></div>
              <div className="mail-detail-actions">{detail.web_link && <a className="button button-secondary button-sm" href={detail.web_link} target="_blank" rel="noreferrer"><ExternalLink size={15} /><span>{detailProvider.name} 打开</span></a>}{folder === "trash" ? <><Button size="sm" variant="primary" icon={ArchiveRestore} onClick={() => setConfirm({ action: "restore", item: detail })}>恢复</Button><Button size="sm" variant="danger-ghost" icon={Trash2} onClick={() => setConfirm({ action: "purge", item: detail })}>永久删除</Button></> : <Button size="sm" variant="danger-ghost" icon={Trash2} onClick={() => setConfirm({ action: "hide", item: detail })}>删除</Button>}</div>
            </header>
            <dl className="mail-detail-meta">
              <div><dt>收件地址</dt><dd>{detail.recipient_address || detail.address || "-"}</dd></div>
              <div><dt>{detailProvider.id === "inbox_link" ? "取件邮箱" : "源头邮箱"}</dt><dd className="provider-inline"><ProviderMark provider={detailProvider.id} size={18} />{detail.source_email || "-"}</dd></div>
              {detail.parent_address && <div><dt>基础地址</dt><dd>{detail.parent_address}</dd></div>}
              <div><dt>邮件状态</dt><dd><span className={`mail-read-state ${detail.is_read ? "read" : "unread"}`}>{detail.is_read ? "已读" : "未读"}</span>{detail.has_attachments && <span className="mail-attachment-state"><Paperclip size={12} />包含附件</span>}</dd></div>
              <div><dt>接收时间</dt><dd>{formatDate(detail.received_at)}</dd></div>
            </dl>
            <div className={`mail-detail-body ${detailIsHtml ? "mail-detail-html" : ""}`}>{detailError && <div className="mail-detail-error"><AlertCircle size={16} /><span>{detailError}</span><Button size="sm" icon={RefreshCw} onClick={retryDetail}>重试</Button></div>}{detailLoading && <LoaderCircle className="spin" size={16} />}{detailBody ? (detailIsHtml ? <iframe className="mail-html-frame" title={`${detail.subject || "邮件"}正文`} sandbox="" referrerPolicy="no-referrer" srcDoc={detail.body} /> : <p>{detailBody}</p>) : !detailLoading && <span>这封邮件没有正文内容。</span>}</div>
          </> : detailError ? <EmptyState icon={AlertCircle} title="邮件内容加载失败" description={detailError} action={<Button icon={RefreshCw} onClick={retryDetail}>重新加载</Button>} /> : <EmptyState icon={UserRound} title="选择一封邮件" description="邮件内容和实际接收地址会显示在这里。" />}
        </article>
      </section>

      <ConfirmDialog open={Boolean(confirm)} onClose={() => setConfirm(null)} onConfirm={applyMessageAction} loading={updating} danger={confirmAction !== "restore"} title={confirmTitle} description={confirmDescription} confirmText={confirmAction === "purge" ? "永久删除" : (confirmAction === "restore" ? "确认恢复" : "确认删除")} />
    </div>
  );
}
