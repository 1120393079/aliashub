import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, KeyRound, Link2, MailPlus, Play, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../api.js";
import { Button, EmptyState, FormField, LoadingBlock, StatusBadge, useToast } from "../components.jsx";
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

export default function InboxLinkRegistrationPage({ onNavigate }) {
  const [poolText, setPoolText] = useState("");
  const [data, setData] = useState(null);
  const [importing, setImporting] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const toast = useToast();
  const detectedCount = useMemo(() => poolLineCount(poolText), [poolText]);

  const load = useCallback(async () => {
    const result = await api("/api/inbox-link-mailboxes");
    setData(result);
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
      setData(result);
      setPoolText("");
      toast(`已绑定 ${result.imported} 个链接邮箱；新增 ${result.created}，更新 ${result.updated}`);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setImporting(false);
    }
  };

  const remove = async (item) => {
    setDeletingId(item.id);
    try {
      await api(`/api/inbox-link-mailboxes/${item.id}`, { method: "DELETE" });
      toast(`${item.email} 已解除绑定`);
      await load();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setDeletingId(null);
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
          <header className="panel-header"><div><h2>绑定链接取件邮箱</h2><p>这里只保存邮箱和取件链接；注册请前往 ChatGPT 注册页面</p></div><MailPlus size={20} /></header>
          <div className="inbox-link-form">
            <FormField
              label="邮箱 + 取件链接"
              hint="每行一组，邮箱与链接用空格隔开；重复邮箱会更新原绑定"
            >
              <textarea
                className="inbox-link-editor"
                value={poolText}
                onChange={(event) => setPoolText(event.target.value)}
                placeholder={"alpha@example.com https://dispose.lol/ib/xxxxxxxx\nbeta@example.com https://dispose.lol/ib/yyyyyyyy"}
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
              <li><b>绑定邮箱</b><span>在本页粘贴邮箱和取件链接。</span></li>
              <li><b>选择邮箱来源</b><span>前往 ChatGPT 注册，选择“链接取件邮箱池”。</span></li>
              <li><b>填写注册数量</b><span>输入几个就从可用绑定中取几个。</span></li>
              <li><b>自动收码</b><span>每个任务使用对应链接读取新验证码。</span></li>
            </ol>
          </article>
          <article className="panel inbox-link-security"><KeyRound size={18} /><span><b>链接密钥已加密保存</b><small>列表和任务日志只显示脱敏链接。</small></span></article>
        </aside>
      </section>

      <section className="table-panel inbox-link-table-panel">
        <header className="panel-header"><div><h2>已绑定链接邮箱</h2><p>共 {data.total} 个，可用于注册 {data.available} 个</p></div><Button size="sm" onClick={() => load().catch((error) => toast(error.message, "error"))}>刷新</Button></header>
        {data.items.length ? <>
          <div className="data-table-wrap"><table className="data-table"><thead><tr><th>邮箱</th><th>取件链接</th><th>状态</th><th>绑定时间</th><th aria-label="操作" /></tr></thead><tbody>{data.items.map((item) => {
            const state = registrationState(item);
            return <tr key={item.id}><td><b>{item.email}</b></td><td><code>{item.masked_link}</code></td><td><StatusBadge status={state.status}>{state.label}</StatusBadge></td><td><span className="muted-cell">{formatDate(item.created_at)}</span></td><td><Button size="sm" variant="danger" icon={Trash2} loading={deletingId === item.id} disabled={item.registration_state === "in_progress"} onClick={() => remove(item)}>解除绑定</Button></td></tr>;
          })}</tbody></table></div>
          <div className="inbox-link-mobile-list">{data.items.map((item) => {
            const state = registrationState(item);
            return <article key={item.id}><header><b>{item.email}</b><StatusBadge status={state.status}>{state.label}</StatusBadge></header><code>{item.masked_link}</code><footer><span>{formatDate(item.created_at)}</span><Button size="sm" variant="danger" icon={Trash2} loading={deletingId === item.id} disabled={item.registration_state === "in_progress"} onClick={() => remove(item)}>解除</Button></footer></article>;
          })}</div>
        </> : <EmptyState icon={Link2} title="还没有绑定链接邮箱" description="在上方按“邮箱 空格 取件链接”的格式粘贴并绑定。" />}
      </section>
    </div>
  );
}
