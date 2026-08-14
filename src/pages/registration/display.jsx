import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, Ban, Check, ChevronRight, CircleStop, ClipboardCopy, Copy, Database, Eye, EyeOff, KeyRound, LoaderCircle, Mail, Pause, Pencil, Play, RefreshCw, ScrollText, ShieldCheck, Trash2 } from "lucide-react";
import { Button, IconButton, LoadingBlock, StatusBadge } from "../../components.jsx";
import { formatDate, relativeTime } from "../../utils.js";
import {
  accountAvailabilityMeta,
  accountGroupMeta,
  accountNeedsAccessTokenRefresh,
  accountSignalText,
  accountSignalValue,
  accountTypeMeta,
  definitiveUnavailableCodes,
  transientStatusCodes,
} from "./account-signals.js";
import { deletableStatuses, occupiedAliasInfo, releasableStatuses } from "./registration-model.js";

export function NfapiBatchImportResult({ result }) {
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const created = Number(result?.created) || 0;
  const updated = Number(result?.updated) || 0;
  const skipped = Number(result?.skipped) || 0;
  const failed = Number(result?.failed) || 0;
  const total = Number(result?.total) || 0;
  return <section className="nfapi-import-result">
    <header><Check size={17} /><div><b>NFapi 批量导入已完成</b><small>统一配置已逐个应用到所选账号</small></div></header>
    <div className="nfapi-result-metrics">
      <span><b>{total}</b>已选账号</span>
      <span><b>{created}</b>新增</span>
      <span><b>{updated}</b>更新</span>
      <span><b>{skipped}</b>已存在</span>
      <span className={failed ? "error" : ""}><b>{failed}</b>需处理</span>
    </div>
    {errors.length > 0 && <div className="nfapi-result-errors">
      {errors.map((item, index) => <small key={`${item?.id || "account"}-${index}`}>账号 #{item?.id || "-"}：{item?.message || "导入失败"}</small>)}
    </div>}
  </section>;
}

export function OccupiedAliasNotice({ base }) {
  const occupied = occupiedAliasInfo(base);
  if (!occupied.count) return null;
  const samples = occupied.aliases.slice(0, 3);
  const remainder = occupied.count > samples.length ? `等 ${occupied.count} 个` : "";
  return <div className="inline-alert danger registration-occupied-alias-alert" role="alert">
    <AlertTriangle size={16} />
    <span>
      <b>已标记 {occupied.count} 个注册占用别名</b>
      <small>{samples.length ? `最近占用：${samples.join("、")}${remainder ? `，${remainder}` : ""}` : "该基础地址曾生成被目标站占用的注册邮箱；请优先更换基础地址或后缀。"}</small>
    </span>
  </div>;
}

export function PasswordCell({ value, status, error, available, onCopy }) {
  const [visible, setVisible] = useState(false);
  if (!available) {
    const label = status === "not_configured"
      ? "未设置"
      : status === "failed" ? "设置失败" : status === "configured" ? "已设置" : "未确认";
    return <span className={`registration-password-state status-${status || "unknown"}`} title={error || label}><b>{label}</b>{status === "failed" && error && <small>{error}</small>}</span>;
  }
  return <div className="registration-secret"><code>{visible ? value : "••••••••••••"}</code><button title={visible ? "隐藏密码" : "显示密码"} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={14} /> : <Eye size={14} />}</button><button title="复制密码" onClick={onCopy}><Copy size={14} /></button></div>;
}

export function AccessTokenCell({ available, loading, onCopy }) {
  return <div className="registration-secret"><code>{available ? "••••••••••••" : "未获取"}</code><button disabled={!available || loading} title={available ? "复制 AccessToken (AT)" : "尚未获取 AT"} onClick={onCopy}>{loading ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}</button></div>;
}

export function AccountNameGroup({ item, mobile = false }) {
  const group = accountGroupMeta(item);
  const groupLabel = group.name || "未分组";
  const groupTitle = group.automatic ? `${groupLabel}（按套餐自动分组）` : groupLabel;
  return <div className={`registration-account-meta ${mobile ? "registration-account-meta-mobile" : ""}`}><b title={item.custom_name || "未命名"}>{item.custom_name || "未命名"}</b><small className="registration-account-group" title={groupTitle}><span>{groupLabel}</span>{group.automatic && <em>自动</em>}</small></div>;
}

function accountSignalTime(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return Number.isFinite(Date.parse(text)) ? `${formatDate(text)}（${relativeTime(text)}）` : text;
}

export function AccountSignalCell({ item, compact = false, onRefreshAccessToken, refreshingAccessToken = false, disabled = false }) {
  const statusCode = accountSignalText(item, [
    "status_code", "statusCode", "validity_code", "validityCode", "validity_status_code", "validityStatusCode",
    "validity_error_code", "validityErrorCode", "check_code", "checkCode", "code",
  ], 80).toUpperCase().replace(/[\s-]+/g, "_");
  const statusReason = accountSignalText(item, [
    "status_reason", "statusReason", "validity_reason", "validityReason", "validity_status_reason", "validityStatusReason",
    "validity_error", "validityError", "validity_message", "validityMessage", "check_reason", "checkReason", "reason",
  ]);
  const checkError = accountSignalText(item, ["status_check_error", "statusCheckError", "check_error", "checkError"]);
  const checkState = accountSignalText(item, ["status_check_state", "statusCheckState", "check_state", "checkState", "detection_status", "detectionStatus"], 40).toLowerCase();
  const retryableValue = accountSignalValue(item, ["status_retryable", "statusRetryable", "validity_retryable", "validityRetryable", "retryable"]);
  const retryable = retryableValue === true || ["1", "true", "yes"].includes(String(retryableValue).toLowerCase());
  const remoteStatus = accountSignalText(item, ["display_status", "displayStatus", "lifecycle_status", "lifecycleStatus", "status"], 80).toLowerCase();
  const fallbackAvailability = new Set(["active", "registered", "valid", "trial", "subscribed"]).has(remoteStatus)
    ? "available" : definitiveUnavailableCodes.has(statusCode) ? "unavailable" : "unchecked";
  const rawAvailability = accountSignalText(item, ["availability", "availability_status", "availabilityStatus"], 40).toLowerCase();
  const availability = accountAvailabilityMeta[rawAvailability] ? rawAvailability : fallbackAvailability;
  const checkFailed = new Set(["failed", "inconclusive", "retry", "retryable", "error", "timeout"]).has(checkState);
  const transientCode = transientStatusCodes.has(statusCode)
    || /(?:TIMEOUT|NETWORK|PROXY|RATE_LIMIT|UPSTREAM|HTTP_5\d\d|CLOUDFLARE|CHALLENGE|TEMPORAR|UNRECOGNIZED)/.test(statusCode);
  const transient = availability !== "unavailable" && (checkFailed || retryable || transientCode);
  const terminalAccountInvalid = availability === "unavailable"
    && /^(?:ACCOUNT|USER)_(?:BANNED|DISABLED|DEACTIVATED|DELETED|SUSPENDED)$/.test(statusCode);
  const meta = terminalAccountInvalid
    ? { label: "AT 失效", badge: "failed" }
    : transient && availability === "unchecked"
      ? { label: "待复检", badge: "warning" }
      : accountAvailabilityMeta[availability];
  const type = accountTypeMeta(item);
  const attemptedAt = accountSignalText(item, ["status_check_attempted_at", "statusCheckAttemptedAt", "check_attempted_at", "checkAttemptedAt", "attempted_at", "attemptedAt"], 80);
  const confirmedAt = accountSignalText(item, ["status_confirmed_at", "statusConfirmedAt", "validity_confirmed_at", "validityConfirmedAt"], 80);
  const checkedAt = attemptedAt || accountSignalText(item, [
    "status_checked_at", "statusCheckedAt", "validity_checked_at", "validityCheckedAt", "checked_at", "checkedAt",
  ], 80) || confirmedAt;
  const detail = [statusCode && `[${statusCode}]`, statusReason || (transient ? checkError : "")].filter(Boolean).join(" ");
  const statusConflictValue = accountSignalValue(item, ["status_conflict", "statusConflict", "validity_conflict", "validityConflict"]);
  const statusConflict = statusConflictValue === true || ["1", "true", "yes"].includes(String(statusConflictValue).toLowerCase());
  const checkCaption = transient
    ? `${detail || "检测暂时失败"} · ${availability === "unchecked" ? "请稍后复检" : "保留上次结果"}`
    : detail || (availability === "unavailable" ? "后端已确认失效（未返回原因码）"
      : checkState === "checked" ? "刚刚完成状态检测"
        : statusConflict ? "最新 API 已确认可用"
          : checkedAt ? `检测 ${relativeTime(checkedAt)}` : "等待状态检测");
  const accountStatus = accountSignalText(item, ["account_status", "accountStatus", "lifecycle_status", "lifecycleStatus", "display_status", "displayStatus"], 80);
  const credentialStatus = accountSignalText(item, ["credential_status", "credentialStatus", "validity_status", "validityStatus"], 80);
  const subscriptionStatus = accountSignalText(item, ["subscription_status", "subscriptionStatus", "plan_status", "planStatus", "plan_state", "planState"], 80);
  const source = accountSignalText(item, ["status_source", "statusSource", "validity_source", "validitySource", "check_source", "checkSource", "source"], 120);
  const sourceAndTime = [
    source && `来源 ${source}`,
    checkedAt && `本次 ${relativeTime(checkedAt)}`,
    confirmedAt && confirmedAt !== checkedAt && `确认 ${relativeTime(confirmedAt)}`,
  ].filter(Boolean).join(" · ");
  const title = [
    `状态：${meta.label}`,
    `类型：${type.label}`,
    accountStatus && `账号状态=${accountStatus}`,
    credentialStatus && `凭据状态=${credentialStatus}`,
    subscriptionStatus && `订阅状态=${subscriptionStatus}`,
    statusCode && `状态码=${statusCode}`,
    statusReason && `原因=${statusReason}`,
    transient && !statusReason && checkError && `检测错误=${checkError}`,
    statusConflict && "历史页面状态与最新 API 结果冲突，采用最新 API 结果",
    source && `来源=${source}`,
    checkedAt && `检测时间=${accountSignalTime(checkedAt)}`,
    confirmedAt && confirmedAt !== checkedAt && `确认时间=${accountSignalTime(confirmedAt)}`,
  ].filter(Boolean).join(" · ");
  const captionClass = transient ? "check-failed" : availability === "unavailable" ? "check-invalid" : detail ? "check-detail" : "";
  const accessTokenMissing = !item.access_token_available;
  const accessTokenRefreshRequired = accessTokenMissing || accountNeedsAccessTokenRefresh(statusCode);
  const accessTokenActionLabel = refreshingAccessToken ? "邮箱登录中" : accessTokenMissing ? "邮箱登录" : "刷新 AT";
  const accessTokenActionTitle = accessTokenMissing
    ? "使用已绑定邮箱验证码重新登录并获取 Session 和 Access Token"
    : "仅使用现有网页登录 Session 刷新 Access Token，不获取 RT";
  return <div className={`registration-account-signal ${compact ? "compact" : ""}`} title={title}><div><StatusBadge status={meta.badge}>{meta.label}</StatusBadge><span className={`registration-account-type type-${type.type}`}>{type.label}</span>{accessTokenRefreshRequired && onRefreshAccessToken && <button type="button" className="registration-refresh-at-button" disabled={disabled || refreshingAccessToken} title={accessTokenActionTitle} onClick={() => onRefreshAccessToken(item)}>{refreshingAccessToken ? <LoaderCircle className="spin" size={12} /> : <Mail size={12} />}<span>{accessTokenActionLabel}</span></button>}</div><small className={captionClass}>{checkCaption}</small>{sourceAndTime && <small className="check-meta">{sourceAndTime}</small>}</div>;
}

export function JobCommands({ job, onLogs, onPause, onResume, onCancel, onRelease, onDelete, busy = false }) {
  const pausable = job.status === "queued" || job.status === "running";
  const resumable = job.status === "paused";
  const cancellable = pausable || resumable;
  const releasable = releasableStatuses.has(job.status);
  return <div className="row-actions"><button className="registration-row-command registration-log-command" aria-label={`查看 ${job.email || "注册任务"} 的日志`} title="查看邮箱注册日志" onClick={() => onLogs(job)}><ScrollText size={15} /><span>日志</span></button>{pausable && <button className="registration-row-command warning" disabled={busy} title="暂停后续注册" onClick={() => onPause(job)}><Pause size={15} /></button>}{resumable && <button className="registration-row-command" disabled={busy} title="继续注册" onClick={() => onResume(job)}><Play size={15} /></button>}{cancellable && <button className="registration-row-command danger" disabled={busy} title="取消剩余注册" onClick={() => onCancel(job.id)}><Ban size={15} /></button>}{releasable && <button className="registration-row-command warning" disabled={busy} title="强制释放任务" onClick={() => onRelease(job)}><CircleStop size={15} /></button>}{deletableStatuses.has(job.status) && <button className="registration-row-command danger" title="删除注册记录" onClick={() => onDelete(job)}><Trash2 size={15} /></button>}</div>;
}

export function AccountCommands({ item, checking, busy = false, onRefresh, onPassword, onNfapi, onMailbox, onEdit, onCopy, onDelete }) {
  const passwordTitle = item.password_available
    ? "密码已配置"
    : item.password_setup_reason || "使用原邮箱设置密码";
  return <div className="registration-account-actions" aria-label={`${item.email} 的账号操作`}>
    <button className="registration-row-command" disabled={busy || checking} aria-label="检测状态和套餐" title="检测状态和套餐" onClick={() => onRefresh([item.id])}><RefreshCw size={15} /></button>
    <button className="registration-row-command" disabled={busy || item.password_available || !item.password_setup_available} aria-label={passwordTitle} title={passwordTitle} onClick={() => onPassword(item)}><ShieldCheck size={15} /></button>
    <button className="registration-row-command" disabled={busy} aria-label="添加或更新 NFapi" title="添加或更新 NFapi" onClick={() => onNfapi([item.id])}><Database size={15} /></button>
    <button className="registration-row-command" disabled={busy} aria-label="查看邮箱" title="查看邮箱" onClick={() => onMailbox(item)}><Mail size={15} /></button>
    <button className="registration-row-command" disabled={busy} aria-label="编辑名称和分组" title="编辑名称和分组" onClick={() => onEdit(item)}><Pencil size={15} /></button>
    <button className="registration-row-command" aria-label={item.password_available ? "复制账号和密码" : "复制邮箱"} title={item.password_available ? "复制账号和密码" : "复制邮箱"} onClick={() => onCopy(item)}><ClipboardCopy size={15} /></button>
    <button className="registration-row-command danger" disabled={busy} aria-label="删除本地账号" title="删除本地账号" onClick={() => onDelete(item)}><Trash2 size={15} /></button>
  </div>;
}

function isHtmlEmail(item, body) {
  const contentType = String(item?.body_content_type || item?.bodyContentType || item?.content_type || "").toLowerCase();
  return contentType === "html"
    || /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(String(body || ""));
}

export function OAuthMailboxPanel({
  email,
  data,
  loading,
  error,
  updatedAt,
  onRefresh,
  onClose,
  onCopyCode,
  title = "验证码邮箱",
  emptyTitle = "等待验证码邮件",
  emptyDescription = "打开 OAuth 登录后，新邮件会自动出现在这里。",
}) {
  const emails = data?.emails || [];
  const [selectedEmailKey, setSelectedEmailKey] = useState("");
  const emailEntries = emails.map((item, index) => ({
    item,
    key: String(item.id || item.message_id || `${item.date || "email"}-${index}`),
  }));
  const selectedEmail = emailEntries.find((entry) => entry.key === selectedEmailKey)?.item || null;
  const selectedEmailBody = selectedEmail?.body || selectedEmail?.text || selectedEmail?.body_preview || selectedEmail?.preview || "";
  const selectedEmailIsHtml = Boolean(selectedEmailBody) && isHtmlEmail(selectedEmail, selectedEmailBody);
  const initialError = Boolean(error && !data);
  const footerState = initialError
    ? "读取失败"
    : updatedAt ? `更新于 ${relativeTime(updatedAt)}` : loading ? "正在连接邮箱" : "尚未更新";

  useEffect(() => setSelectedEmailKey(""), [email]);

  return (
    <aside className="nfapi-oauth-mailbox" aria-label={`${email || "当前账号"}的${title}`} aria-busy={loading}>
      <header>
        <div className="nfapi-mailbox-title"><Mail size={17} /><span><b>{title}</b><small title={email}>{email}</small></span></div>
        <div className="nfapi-mailbox-actions">
          <IconButton className={loading ? "spin-icon" : ""} icon={loading ? LoaderCircle : RefreshCw} label="刷新当前邮箱" size={30} disabled={loading} onClick={onRefresh} />
          <IconButton icon={EyeOff} label={`隐藏${title}`} size={30} onClick={onClose} />
        </div>
      </header>
      <div className="nfapi-mailbox-content" aria-live="polite">
        {!data && loading && !error ? <LoadingBlock rows={5} /> : initialError ? <div className="nfapi-mailbox-empty failed"><AlertTriangle size={22} /><b>邮箱读取失败</b><span>{error}</span><Button size="sm" icon={RefreshCw} loading={loading} onClick={onRefresh}>立即重试</Button></div> : <>
          {error && <div className="nfapi-mailbox-error"><AlertTriangle size={14} /><span>{error}</span></div>}
          {selectedEmail ? <article className="nfapi-mail-detail" aria-label="邮件详情">
            <header>
              <IconButton icon={ArrowLeft} label="返回邮件列表" size={30} onClick={() => setSelectedEmailKey("")} />
              <span><strong>{selectedEmail.subject || "（无主题）"}</strong><small title={selectedEmail.from || "OpenAI"}>{selectedEmail.from || "OpenAI"}</small></span>
            </header>
            <dl className="nfapi-mail-detail-meta">
              <div><dt>发件人</dt><dd>{selectedEmail.from || "OpenAI"}</dd></div>
              <div><dt>收件人</dt><dd>{email || "-"}</dd></div>
              <div><dt>接收时间</dt><dd>{formatDate(selectedEmail.date)}</dd></div>
            </dl>
            {selectedEmail.verification_code && <button className="nfapi-mail-code nfapi-mail-detail-code" type="button" title="复制验证码" aria-label={`复制验证码 ${selectedEmail.verification_code}`} onClick={() => onCopyCode(selectedEmail.verification_code)}><span>{selectedEmail.verification_code}</span><Copy size={14} /></button>}
            <div className={`nfapi-mail-detail-body ${selectedEmailIsHtml ? "nfapi-mail-detail-html" : ""}`}>{selectedEmailBody ? (selectedEmailIsHtml ? <iframe className="nfapi-mail-html-frame" title={`${selectedEmail.subject || "邮件"}正文`} sandbox="" referrerPolicy="no-referrer" srcDoc={selectedEmailBody} /> : <p>{selectedEmailBody}</p>) : <span>这封邮件没有正文内容。</span>}</div>
          </article> : emails.length ? <div className="nfapi-mail-list" role="list">{emailEntries.map(({ item, key }) => (
            <article className="nfapi-mail-item" role="listitem" key={key}>
              <header><b title={item.from || "OpenAI"}>{item.from || "OpenAI"}</b><span><time dateTime={item.date}>{relativeTime(item.date)}</time><ChevronRight size={13} aria-hidden="true" /></span></header>
              <button className="nfapi-mail-open" type="button" title="查看邮件详情" aria-label={`查看邮件详情：${item.subject || "无主题"}`} onClick={() => setSelectedEmailKey(key)} />
              {item.verification_code && <button className="nfapi-mail-code" type="button" title="复制验证码" aria-label={`复制验证码 ${item.verification_code}`} onClick={() => onCopyCode(item.verification_code)}><span>{item.verification_code}</span><Copy size={14} /></button>}
              <strong>{item.subject || "（无主题）"}</strong>
              <p>{item.body_preview || item.preview || item.text || "没有邮件预览"}</p>
            </article>
          ))}</div> : <div className="nfapi-mailbox-empty"><Mail size={22} /><b>{emptyTitle}</b><span>{emptyDescription}</span></div>}
        </>}
      </div>
      <footer><span>{footerState}</span><small>{error ? "每 4 秒自动重试" : "每 4 秒自动刷新"}</small></footer>
    </aside>
  );
}
