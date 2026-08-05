import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Inbox, KeyRound, Link2, MailPlus, Play, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../api.js";
import { Button, ConfirmDialog, EmptyState, FormField, LoadingBlock, Segmented, StatusBadge, useToast } from "../components.jsx";
import { formatDate } from "../utils.js";

function poolLineCount(value) {
  const rows = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("//"));
  return new Set(rows).size;
}

function registrationState(item) {
  if (item.registration_state === "used") return { status: "completed", label: "已注册" };
  if (item.registration_state === "in_progress") return { status: "running", label: "注册中" };
  if (item.status === "disabled") return { status: "disabled", label: "已停用" };
  return { status: "active", label: "可用" };
}

function gptState(item) {
  if (!item.chatgpt) return null;
  const plan = item.chatgpt.plan === "free" ? "GPT Free" : `GPT ${String(item.chatgpt.plan || "未知").toUpperCase()}`;
  return {
    plan,
    planStatus: item.chatgpt.plan === "free" ? "paused" : "completed",
    atLabel: item.chatgpt.at_invalid ? "AT 失效" : "AT 正常",
    atStatus: item.chatgpt.at_invalid ? "failed" : "active",
  };
}

export default function InboxLinkRegistrationPage({ onNavigate }) {
  const [poolText, setPoolText] = useState("");
  const [data, setData] = useState(null);
  const [importing, setImporting] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [selected, setSelected] = useState([]);
  const [filter, setFilter] = useState("all");
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const toast = useToast();
  const detectedCount = useMemo(() => poolLineCount(poolText), [poolText]);

  const load = useCallback(async () => {
    const result = await api("/api/inbox-link-mailboxes");
    setData(result);
    setSelected((current) => current.filter((id) => result.items.some((item) => item.id === id)));
    return result;
  }, []);

  useEffect(() => {
    load().catch((error) => toast(error.message, "error"));
  }, [load, toast]);

  const bind = async () => {
    setImporting(true);
    try {
      const result = await api("/api/inbox-link-mailboxes/import", {
        method: "POST",
        body: { poolText },
      });
      setPoolText("");
      toast(`已绑定 ${result.imported} 个链接邮箱；新增 ${result.created}，更新 ${result.updated}`);
      await load();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setImporting(false);
    }
  };

  const remove = async (item) => {
    setDeletingId(item.id);
    try {
      const result = await api(`/api/inbox-link-mailboxes/${item.id}`, { method: "DELETE" });
      toast(result.gpt_deleted
        ? `${item.email} 的 GPT 账号已删除并解除绑定`
        : `${item.email} 已解除绑定`);
      await load();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setDeletingId(null);
    }
  };

  const visibleItems = useMemo(() => {
    const items = data?.items || [];
    return filter === "free_invalid_at" ? items.filter((item) => item.unlink_recommended) : items;
  }, [data, filter]);
  const selectableIds = visibleItems
    .filter((item) => item.registration_state !== "in_progress")
    .map((item) => item.id);
  const allVisibleSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.includes(id));
  const toggle = (id) => setSelected((current) => current.includes(id)
    ? current.filter((item) => item !== id)
    : [...current, id]);
  const toggleVisible = () => setSelected((current) => allVisibleSelected
    ? current.filter((id) => !selectableIds.includes(id))
    : [...new Set([...current, ...selectableIds])]);

  const bulkDelete = async () => {
    setBulkDeleting(true);
    try {
      const result = await api("/api/inbox-link-mailboxes/bulk-delete", {
        method: "POST",
        body: { ids: selected },
      });
      if (result.gpt_failed?.length) {
        toast(`已删除 GPT 账号 ${result.gpt_deleted} 个并解绑 ${result.deleted} 个，另有 ${result.gpt_failed.length} 个 GPT 账号删除失败`, "error");
      } else {
        toast(`已删除 GPT 账号 ${result.gpt_deleted} 个，并解除绑定 ${result.deleted} 个链接邮箱`);
      }
      setSelected([]);
      setBulkDeleteOpen(false);
      await load();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBulkDeleting(false);
    }
  };

  if (!data) return <div className="page-stack"><LoadingBlock rows={7} /></div>;

  return (
    <div className="page-stack inbox-link-page">
      <div className="inbox-link-summary">
        <span><Link2 size={16} /><b>已绑定</b><strong>{data.total}</strong></span>
        <span><CheckCircle2 size={16} /><b>当前可用</b><strong>{data.available}</strong></span>
        <span><Play size={16} /><b>注册中</b><strong>{data.in_progress}</strong></span>
      </div>

      <section className="inbox-link-layout">
        <article className="panel inbox-link-editor-panel">
          <header className="panel-header"><div><h2>绑定链接取件邮箱</h2><p>绑定后会作为独立邮箱加入邮件中心，与源头邮箱分开显示</p></div><MailPlus size={20} /></header>
          <div className="inbox-link-form">
            <FormField
              label="邮箱 + 取件 API"
              hint="可直接粘贴取件站“复制所选取件API”的 邮箱---API 内容；也兼容 邮箱 空格 HTTPS链接"
            >
              <textarea
                className="inbox-link-editor"
                value={poolText}
                onChange={(event) => setPoolText(event.target.value)}
                placeholder={"name@example.com---https://pickup.example.com/api/mail?key=xxxxxxxx\nuser@custom-domain.com https://mail.example.net/p/yyyyyyyy"}
                spellCheck={false}
                autoComplete="off"
              />
            </FormField>
            <div className="inbox-link-bind-actions">
              <span>检测到 <b>{detectedCount}</b> 行</span>
              <Button variant="primary" size="lg" icon={MailPlus} loading={importing} disabled={!detectedCount || !data.encryption_ready} onClick={bind}>绑定邮箱</Button>
              <Button icon={Play} onClick={() => onNavigate("registration", { mailboxMode: "inbox_link" })}>去 ChatGPT 注册</Button>
            </div>
            {!data.encryption_ready && <div className="inline-alert error"><KeyRound size={16} /><span>服务端未配置加密密钥，暂时不能保存取件链接。</span></div>}
          </div>
        </article>

        <aside className="inbox-link-side">
          <article className="panel inbox-link-guide">
            <header className="panel-header"><div><h2>使用流程</h2><p>绑定与注册分开管理</p></div><ShieldCheck size={20} /></header>
            <ol>
              <li><b>绑定邮箱</b><span>粘贴“复制所选取件API”得到的邮箱---API内容。</span></li>
              <li><b>选择邮箱来源</b><span>前往 ChatGPT 注册，选择“链接取件邮箱池”。</span></li>
              <li><b>填写注册数量</b><span>输入几个就从可用绑定中取几个。</span></li>
              <li><b>邮件中心</b><span>每个链接邮箱独立显示，可单独同步邮件和验证码。</span></li>
            </ol>
          </article>
          <article className="panel inbox-link-security"><KeyRound size={18} /><span><b>完整取件链接已加密保存</b><small>不限制邮箱或链接域名；列表和任务日志只显示脱敏链接。</small></span></article>
        </aside>
      </section>

      <section className="table-panel inbox-link-table-panel">
        <header className="panel-header"><div><h2>已绑定链接邮箱</h2><p>共 {data.total} 个，可用于注册 {data.available} 个；Free 且 AT 失效 {data.free_invalid_at || 0} 个</p></div><Button size="sm" onClick={() => load().catch((error) => toast(error.message, "error"))}>刷新</Button></header>
        {data.items.length ? <>
          <div className="inbox-link-bulk-toolbar">
            <Segmented value={filter} onChange={(value) => { setFilter(value); setSelected([]); }} ariaLabel="链接邮箱筛选" items={[{ value: "all", label: "全部", count: data.total }, { value: "free_invalid_at", label: "Free + AT 失效", count: data.free_invalid_at || 0 }]} />
            <div className="registration-bulk-bar"><label><input type="checkbox" checked={allVisibleSelected} disabled={!selectableIds.length} onChange={toggleVisible} />全选当前筛选</label><span>已选择 <b>{selected.length}</b> 个</span><Button size="sm" variant="danger" icon={Trash2} disabled={!selected.length} onClick={() => setBulkDeleteOpen(true)}>批量删除并解绑</Button></div>
          </div>
          <div className="data-table-wrap"><table className="data-table"><thead><tr><th className="select-column"><input type="checkbox" aria-label="选择当前筛选中的链接邮箱" checked={allVisibleSelected} disabled={!selectableIds.length} onChange={toggleVisible} /></th><th>邮箱</th><th>取件链接</th><th>注册状态</th><th>GPT / AT</th><th>绑定时间</th><th aria-label="操作" /></tr></thead><tbody>{visibleItems.map((item) => {
            const state = registrationState(item);
            const chatgpt = gptState(item);
            const selectable = item.registration_state !== "in_progress";
            return <tr className={selected.includes(item.id) ? "selected-row" : ""} key={item.id}><td className="select-column"><input type="checkbox" aria-label={`选择 ${item.email}`} checked={selected.includes(item.id)} disabled={!selectable} onChange={() => toggle(item.id)} /></td><td><b>{item.email}</b></td><td><code>{item.masked_link}</code></td><td><StatusBadge status={state.status}>{state.label}</StatusBadge></td><td>{chatgpt ? <div className="inbox-link-gpt-status"><StatusBadge status={chatgpt.planStatus}>{chatgpt.plan}</StatusBadge><StatusBadge status={chatgpt.atStatus}>{chatgpt.atLabel}</StatusBadge></div> : <span className="muted-cell">尚无 GPT 账号</span>}</td><td><span className="muted-cell">{formatDate(item.created_at)}</span></td><td><div className="row-actions"><Button size="sm" icon={Inbox} disabled={!item.source_account_id} onClick={() => onNavigate("inbox", { accountId: item.source_account_id })}>邮件中心</Button><Button size="sm" variant="danger" icon={Trash2} loading={deletingId === item.id} disabled={!selectable} onClick={() => remove(item)}>删除并解绑</Button></div></td></tr>;
          })}</tbody></table></div>
          <div className="inbox-link-mobile-list">{visibleItems.map((item) => {
            const state = registrationState(item);
            const chatgpt = gptState(item);
            const selectable = item.registration_state !== "in_progress";
            return <article className={selected.includes(item.id) ? "selected" : ""} key={item.id}><header><label><input type="checkbox" checked={selected.includes(item.id)} disabled={!selectable} onChange={() => toggle(item.id)} /><b>{item.email}</b></label><StatusBadge status={state.status}>{state.label}</StatusBadge></header><code>{item.masked_link}</code>{chatgpt && <div className="inbox-link-gpt-status"><StatusBadge status={chatgpt.planStatus}>{chatgpt.plan}</StatusBadge><StatusBadge status={chatgpt.atStatus}>{chatgpt.atLabel}</StatusBadge></div>}<footer><span>{formatDate(item.created_at)}</span><span className="row-actions"><Button size="sm" icon={Inbox} disabled={!item.source_account_id} onClick={() => onNavigate("inbox", { accountId: item.source_account_id })}>邮件</Button><Button size="sm" variant="danger" icon={Trash2} loading={deletingId === item.id} disabled={!selectable} onClick={() => remove(item)}>删除并解绑</Button></span></footer></article>;
          })}</div>
        </> : <EmptyState icon={Link2} title="还没有绑定链接邮箱" description="在上方粘贴“邮箱---取件API”内容并绑定。" />}
      </section>
      <ConfirmDialog open={bulkDeleteOpen} onClose={() => setBulkDeleteOpen(false)} onConfirm={bulkDelete} loading={bulkDeleting} danger title="批量删除 GPT 账号并解绑？" description={`将永久删除选中邮箱对应的 GPT 账号，同时解除 ${selected.length} 个取件链接绑定并移除邮件中心本地邮件。正在注册的邮箱不会被选中。`} confirmText="确认删除并解绑" />
    </div>
  );
}
