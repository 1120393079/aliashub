import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, KeyRound, LogIn, MailPlus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../api.js";
import { Button, ConfirmDialog, EmptyState, FormField, ICloudMark, IconButton, LoadingBlock, StatusBadge, useToast } from "../components.jsx";
import { formatDate } from "../utils.js";

const emptyLogin = { source_account_id: "", password: "", two_factor_method: "trusted_device" };
const emptyCreate = { account_id: "", count: 1 };

function sessionReady(session) {
  return Boolean(session?.apple_account_login_saved && session?.apple_account_manage_ready);
}

export default function ICloudPrivacyPage({ onNavigate, onDataChange }) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [sourceAccounts, setSourceAccounts] = useState([]);
  const [mailboxes, setMailboxes] = useState([]);
  const [mailboxTotal, setMailboxTotal] = useState(0);
  const [login, setLogin] = useState(emptyLogin);
  const [pending, setPending] = useState(null);
  const [code, setCode] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [create, setCreate] = useState(emptyCreate);
  const [createBusy, setCreateBusy] = useState(false);
  const [createProgress, setCreateProgress] = useState(null);
  const [showLogin, setShowLogin] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [selectedMailboxIDs, setSelectedMailboxIDs] = useState([]);
  const [error, setError] = useState("");

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setRefreshing(true);
    try {
      const [statusData, mailboxData, accountData] = await Promise.all([
        api("/api/icloud-privacy/status"),
        api("/api/icloud-privacy/mailboxes"),
        api("/api/accounts"),
      ]);
      const nextSessions = statusData.sessions || [];
      const nextSources = (accountData.items || []).filter((item) => item.provider === "icloud");
      setSessions(nextSessions);
      setSourceAccounts(nextSources);
      setMailboxes(mailboxData.mailboxes || []);
      setMailboxTotal(mailboxData.total || 0);
      const nextMailboxIDs = new Set((mailboxData.mailboxes || []).map((item) => item.id));
      setSelectedMailboxIDs((current) => current.filter((id) => nextMailboxIDs.has(id)));
      setCreate((current) => {
        if (current.account_id && nextSessions.some((item) => item.account_id === current.account_id)) return current;
        const preferred = nextSessions.find(sessionReady) || nextSessions[0];
        return { ...current, account_id: preferred?.account_id || "" };
      });
      setLogin((current) => {
        if (current.source_account_id && nextSources.some((item) => String(item.id) === String(current.source_account_id))) return current;
        const readyAppleIds = new Set(nextSessions.filter(sessionReady).map((item) => String(item.apple_id || "").toLowerCase()));
        const preferredSource = nextSources.find((item) => readyAppleIds.has(String(item.email || "").toLowerCase())) || nextSources[0];
        return { ...current, source_account_id: preferredSource?.id ? String(preferredSource.id) : "" };
      });
      setError("");
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load({ quiet: true }); }, [load]);

  const selectedSource = useMemo(() => sourceAccounts.find((item) => String(item.id) === String(login.source_account_id)), [sourceAccounts, login.source_account_id]);
  const selectedSession = useMemo(() => sessions.find((item) => item.apple_id?.toLowerCase() === selectedSource?.email?.toLowerCase()), [sessions, selectedSource]);
  const selectedReadySession = sessionReady(selectedSession) ? selectedSession : null;

  useEffect(() => {
    setCreate((current) => ({ ...current, account_id: selectedReadySession?.account_id || "" }));
    setShowLogin(!selectedReadySession);
  }, [selectedReadySession?.account_id]);

  const startLogin = async (event) => {
    event.preventDefault();
    if (!selectedSource?.email || !login.password) return;
    setLoginBusy(true);
    setError("");
    try {
      const data = await api("/api/icloud-privacy/login/start", {
        method: "POST",
        body: {
          apple_id: selectedSource.email,
          password: login.password,
          two_factor_method: login.two_factor_method,
        },
      });
      setLogin((current) => ({ ...current, password: "" }));
      if (data.needs_2fa) {
        setPending({ id: data.pending_id, appleId: data.apple_id || selectedSource.email, expiresAt: data.expires_at });
        setCode("");
        toast("验证码已发送");
      } else {
        setPending(null);
        setShowLogin(false);
        toast("Apple ID 登录成功");
        await load({ quiet: true });
      }
    } catch (loginError) {
      setError(loginError.message);
    } finally {
      setLoginBusy(false);
    }
  };

  const submit2FA = async (event) => {
    event.preventDefault();
    if (!pending?.id || !/^\d{6}$/.test(code)) return;
    setLoginBusy(true);
    setError("");
    try {
      await api("/api/icloud-privacy/login/2fa", {
        method: "POST",
        body: { pending_id: pending.id, code },
      });
      setPending(null);
      setCode("");
      setShowLogin(false);
      toast("Apple ID 验证成功");
      await load({ quiet: true });
    } catch (verifyError) {
      setError(verifyError.message);
    } finally {
      setLoginBusy(false);
    }
  };

  const createMailboxes = async (event) => {
    event.preventDefault();
    if (!create.account_id || !selectedSource?.id) return;
    const target = Math.min(20, Math.max(1, Number(create.count) || 1));
    const baselineIDs = new Set(mailboxes.map((item) => item.id));
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 180_000);
    let pollRunning = false;
    const poll = async () => {
      if (pollRunning) return;
      pollRunning = true;
      try {
        const data = await api("/api/icloud-privacy/mailboxes");
        const rows = data.mailboxes || [];
        const createdRows = rows.filter((item) => !baselineIDs.has(item.id)).slice(0, target);
        setMailboxes(rows);
        setMailboxTotal(data.total || 0);
        setCreateProgress((current) => current ? { ...current, created: createdRows.length } : current);
      } catch {
        // The create request remains authoritative; a later poll will catch up.
      } finally {
        pollRunning = false;
      }
    };
    const pollTimer = window.setInterval(poll, 1_000);
    setCreateBusy(true);
    setCreateProgress({ target, created: 0 });
    setError("");
    try {
      const data = await api("/api/icloud-privacy/mailboxes/create", {
        method: "POST",
        body: { ...create, source_account_id: selectedSource.id, count: target },
        signal: controller.signal,
      });
      const created = data.mailboxes || [];
      setCreateProgress({ target, created: created.length });
      await load({ quiet: true });
      const failedSync = created.filter((item) => !item.alias_hub_synced);
      if (failedSync.length) {
        setError(`已创建 ${created.length} 个隐藏邮箱，其中 ${failedSync.length} 个接入地址仓库失败，可刷新后重试`);
      } else {
        toast(`已创建并入库 ${created.length} 个隐藏邮箱`);
        onDataChange?.();
        onNavigate?.("addresses", {
          accountId: selectedSource.id,
          kind: "official",
          strategy: "icloud_hide_my_email",
        });
      }
    } catch (createError) {
      const authExpired = createError.code === "apple_account_auth_failed" || /HTTP 401|管理态已失效/.test(createError.message || "");
      if (authExpired) {
        await load({ quiet: true });
        setShowLogin(true);
        setError("Apple ID 登录已过期，请重新登录后再创建");
      } else {
        setError(createError.name === "AbortError" ? "创建等待超过 3 分钟，任务已停止；已成功的邮箱会保留在下方列表" : createError.message);
      }
    } finally {
      window.clearInterval(pollTimer);
      window.clearTimeout(timeout);
      await poll();
      setCreateBusy(false);
      window.setTimeout(() => setCreateProgress(null), 4_000);
    }
  };

  const deleteMailbox = async () => {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    try {
      await api(`/api/icloud-privacy/mailboxes/${pendingDelete.id}`, { method: "DELETE" });
      toast("创建记录和仓库映射已删除");
      setPendingDelete(null);
      await load({ quiet: true });
      onDataChange?.();
    } catch (deleteError) {
      setError(deleteError.message);
    } finally {
      setDeleteBusy(false);
    }
  };

  const allMailboxesSelected = mailboxes.length > 0 && mailboxes.every((item) => selectedMailboxIDs.includes(item.id));
  const toggleAllMailboxes = () => setSelectedMailboxIDs(allMailboxesSelected ? [] : mailboxes.map((item) => item.id));
  const toggleMailbox = (id) => setSelectedMailboxIDs((current) => current.includes(id)
    ? current.filter((item) => item !== id)
    : [...current, id]);

  const bulkDeleteMailboxes = async () => {
    if (!selectedMailboxIDs.length) return;
    setDeleteBusy(true);
    setError("");
    try {
      const result = await api("/api/icloud-privacy/mailboxes/bulk-delete", {
        method: "POST",
        body: { ids: selectedMailboxIDs },
      });
      const deletedIDs = new Set(result.deleted_ids || []);
      setSelectedMailboxIDs((current) => current.filter((id) => !deletedIDs.has(id)));
      setPendingDelete(null);
      await load({ quiet: true });
      onDataChange?.();
      if (result.failed) {
        const sample = result.failures?.[0];
        setError(`已删除 ${result.deleted} 条，${result.failed} 条未删除${sample?.error ? `：${sample.error}` : ""}`);
      } else {
        toast(`已删除 ${result.deleted} 条创建记录和仓库映射`);
      }
    } catch (deleteError) {
      setError(deleteError.message);
    } finally {
      setDeleteBusy(false);
    }
  };

  if (loading) return <LoadingBlock rows={8} />;

  return (
    <div className="icloud-privacy-page page-stack">
      {error && <div className="inline-alert error icloud-privacy-alert"><AlertTriangle size={15} /><span>{error}</span></div>}

      <section className="panel icloud-privacy-console">
          <header className="panel-header">
            <div className="icloud-privacy-panel-title"><ICloudMark size={32} /><span><h2>iCloud 隐藏邮箱</h2><p>{mailboxTotal} 条创建记录</p></span></div>
            <IconButton icon={RefreshCw} label="刷新" loading={refreshing} onClick={() => load()} />
          </header>

          <div className="icloud-source-row">
            <FormField label="源头邮箱">
              <select value={login.source_account_id} onChange={(event) => setLogin({ ...login, source_account_id: event.target.value })} disabled={!sourceAccounts.length || createBusy}>
                {!sourceAccounts.length && <option value="">没有已绑定的 iCloud 源头邮箱</option>}
                {sourceAccounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}
              </select>
            </FormField>
            <div className="icloud-login-state">
              <StatusBadge status={pending ? "waiting_user" : selectedReadySession ? "connected" : "disconnected"}>{pending ? "等待验证码" : selectedReadySession ? "已登录" : "未登录"}</StatusBadge>
              {selectedReadySession && !showLogin && <Button size="sm" icon={RefreshCw} onClick={() => setShowLogin(true)}>重新登录</Button>}
            </div>
          </div>

          {!sourceAccounts.length ? (
            <Button icon={MailPlus} onClick={() => onNavigate?.("sources")}>绑定 iCloud 源头邮箱</Button>
          ) : pending ? (
            <form className="icloud-privacy-form icloud-login-inline" onSubmit={submit2FA}>
              <div className="icloud-privacy-pending"><KeyRound size={19} /><span><b>{pending.appleId}</b><small>验证码有效期至 {formatDate(pending.expiresAt)}</small></span></div>
              <FormField label="6 位验证码"><input className="icloud-privacy-code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} autoFocus /></FormField>
              <div className="icloud-privacy-form-actions"><Button type="submit" variant="primary" icon={ShieldCheck} loading={loginBusy} disabled={code.length !== 6}>验证并登录</Button><Button type="button" disabled={loginBusy} onClick={() => { setPending(null); setCode(""); }}>取消</Button></div>
            </form>
          ) : showLogin || !selectedReadySession ? (
            <form className="icloud-privacy-form" onSubmit={startLogin}>
              <FormField label="Apple ID 密码"><input type="password" autoComplete="current-password" value={login.password} onChange={(event) => setLogin({ ...login, password: event.target.value })} /></FormField>
              <FormField label="验证码方式">
                <select value={login.two_factor_method} onChange={(event) => setLogin({ ...login, two_factor_method: event.target.value })}>
                  <option value="trusted_device">受信任设备</option>
                  <option value="phone">短信</option>
                </select>
              </FormField>
              <div className="icloud-privacy-form-actions"><Button type="submit" variant="primary" icon={LogIn} loading={loginBusy} disabled={!selectedSource || !login.password}>登录 Apple ID</Button>{selectedReadySession && <Button type="button" onClick={() => setShowLogin(false)}>取消</Button>}</div>
            </form>
          ) : (
            <form className="icloud-create-inline" onSubmit={createMailboxes}>
              <FormField label="创建数量" hint={`预计约 ${Math.max(1, Number(create.count) || 1) * 4} 秒`}><input type="number" min="1" max="20" step="1" value={create.count} disabled={createBusy} onChange={(event) => setCreate({ ...create, count: event.target.value })} /></FormField>
              <Button type="submit" variant="primary" icon={MailPlus} loading={createBusy} disabled={!create.account_id}>{createBusy && createProgress ? `创建中 ${createProgress.created}/${createProgress.target}` : "创建并进入隐藏邮箱"}</Button>
            </form>
          )}
          {createProgress && <div className={`icloud-create-progress${createBusy ? " running" : ""}`}><div><span>{createBusy ? "正在创建" : "创建完成"}</span><b>{createProgress.created} / {createProgress.target}</b></div><span className="icloud-create-progress-track"><i style={{ width: `${Math.min(100, createProgress.target ? createProgress.created / createProgress.target * 100 : 0)}%` }} /></span></div>}
      </section>

      <section className="table-panel icloud-privacy-table">
        <header className="panel-header"><div><h2>创建记录</h2></div><span className="panel-stat">{mailboxTotal}</span></header>
        {selectedMailboxIDs.length > 0 && <div className="icloud-record-selection"><span>已选择 <b>{selectedMailboxIDs.length}</b> 条</span><Button size="sm" variant="danger" icon={Trash2} onClick={() => setPendingDelete({ bulk: true })}>删除所选</Button></div>}
        {mailboxes.length ? <><div className="data-table-wrap"><table className="data-table"><thead><tr><th className="select-column"><input type="checkbox" aria-label="全选创建记录" checked={allMailboxesSelected} onChange={toggleAllMailboxes} /></th><th>邮箱地址</th><th>源头邮箱</th><th>入库状态</th><th>创建时间</th><th aria-label="操作" /></tr></thead><tbody>{mailboxes.map((item) => <tr className={selectedMailboxIDs.includes(item.id) ? "selected-row" : ""} key={item.id}><td className="select-column"><input type="checkbox" aria-label={`选择 ${item.email}`} checked={selectedMailboxIDs.includes(item.id)} onChange={() => toggleMailbox(item.id)} /></td><td><b className="icloud-mailbox-address">{item.email}</b></td><td>{item.account_apple_id || "-"}</td><td><StatusBadge status={item.alias_hub_synced ? "active" : "failed"}>{item.alias_hub_synced ? "已入库" : "接入失败"}</StatusBadge></td><td><span className="muted-cell">{formatDate(item.created_at)}</span></td><td><IconButton icon={Trash2} label="删除记录" variant="danger" onClick={() => setPendingDelete(item)} /></td></tr>)}</tbody></table></div><div className="icloud-mobile-select-all"><label><input type="checkbox" checked={allMailboxesSelected} onChange={toggleAllMailboxes} /><span>全选 {mailboxes.length} 条</span></label></div><div className="icloud-privacy-mobile-list">{mailboxes.map((item) => <article className={selectedMailboxIDs.includes(item.id) ? "selected" : ""} key={item.id}><header><input type="checkbox" aria-label={`选择 ${item.email}`} checked={selectedMailboxIDs.includes(item.id)} onChange={() => toggleMailbox(item.id)} /><span><b>{item.email}</b><small>{formatDate(item.created_at)}</small></span><StatusBadge status={item.alias_hub_synced ? "active" : "failed"}>{item.alias_hub_synced ? "已入库" : "失败"}</StatusBadge></header><footer><span>{item.account_apple_id || "Apple ID"}</span><IconButton icon={Trash2} label="删除记录" variant="danger" onClick={() => setPendingDelete(item)} /></footer></article>)}</div></> : <EmptyState icon={MailPlus} title="还没有创建记录" />}
      </section>
      <ConfirmDialog open={Boolean(pendingDelete)} onClose={() => setPendingDelete(null)} onConfirm={pendingDelete?.bulk ? bulkDeleteMailboxes : deleteMailbox} loading={deleteBusy} danger title={pendingDelete?.bulk ? `删除选中的 ${selectedMailboxIDs.length} 条记录？` : "删除创建记录？"} description="将同时移除地址仓库中的映射，Apple 账户里的隐藏邮箱仍会保留；已上架售卖的邮箱不会删除。" confirmText="确认删除" />
    </div>
  );
}
