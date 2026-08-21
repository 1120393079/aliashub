import { useEffect, useState } from "react";
import { AlertCircle, AtSign, CheckCircle2, ExternalLink, ListPlus, WandSparkles } from "lucide-react";
import { api } from "./api.js";
import { Button, Modal, useToast } from "./components.jsx";

const ICLOUD_IMPORT_TYPES = {
  mail_alias: {
    strategy: "icloud_mail_alias",
    title: "导入 iCloud 邮箱别名",
    description: "从 iCloud Mail 导入已创建的 @icloud.com、@me.com 或 @mac.com 邮箱别名",
    fieldLabel: "iCloud 邮箱别名（每行一个）",
    placeholder: "例如 work@icloud.com\nshop@me.com",
    officialUrl: "https://www.icloud.com/mail/",
    openLabel: "打开 iCloud Mail",
    popupName: "aliashub-icloud-mail-aliases",
    note: "邮箱别名是 iCloud Mail 的普通别名，不是隐藏邮箱。",
    resultLabel: "iCloud 邮箱别名",
  },
  hide_my_email: {
    strategy: "icloud_hide_my_email",
    title: "导入 iCloud 隐藏邮箱",
    description: "从 iCloud+ Hide My Email 导入已创建的 @icloud.com 地址",
    fieldLabel: "iCloud 隐藏邮箱（每行一个）",
    placeholder: "例如 hidden-address@icloud.com",
    officialUrl: "https://www.icloud.com/icloudplus/",
    openLabel: "打开 iCloud+ 隐藏邮箱",
    popupName: "aliashub-icloud-hide-my-email",
    note: "隐藏邮箱由 iCloud+ 创建，通常是 @icloud.com；同时兼容 @privaterelay.appleid.com。",
    resultLabel: "iCloud 隐藏邮箱",
  },
  custom_domain: {
    strategy: "icloud_custom_domain",
    title: "导入 iCloud 自定义域名邮箱",
    description: "手工导入已在 iCloud+ 自定义电子邮件域中创建并启用的邮箱地址",
    fieldLabel: "iCloud 自定义域名邮箱（每行一个）",
    placeholder: "例如 alias@custom.example\nname@example.net",
    officialUrl: "https://www.icloud.com/icloudplus/",
    openLabel: "打开 iCloud+ 自定义域名",
    popupName: "aliashub-icloud-custom-domain",
    note: "这里保存本地登记列表；删掉一行后确认可移除本地记录，不会删除 iCloud 中的真实域名和邮箱。",
    resultLabel: "iCloud 自定义域名邮箱",
  },
};

const MAILCOM_IMPORT = {
  title: "登记 mail.com 官方分裂别名",
  description: "登记已在 mail.com 母号中创建的官方别名，母号与别名共用登录密码和收件箱",
  fieldLabel: "官方分裂别名（每行一个）",
  placeholder: "例如 shop@mail.com\nwork@galaxyhit.com",
  officialUrl: "https://myaccount.mail.com/",
  openLabel: "打开 mail.com",
  popupName: "aliashub-mailcom-aliases",
  note: "这里只同步注册工作站中的官网地址，不会删除 mail.com 官网地址；没有本地历史创建次数限制。",
};
const EMPTY_MAILCOM_DOMAINS = [];

function resultCount(value, fallback = 0) {
  if (Array.isArray(value)) return value.length;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function aliasTextCount(value) {
  return new Set(String(value || "").split(/[\s,;]+/).map((item) => item.trim().toLowerCase()).filter(Boolean)).size;
}

function mailcomCounts(account, baseAddresses = []) {
  const listedAliases = (Array.isArray(baseAddresses) ? baseAddresses : [])
    .filter((item) => item?.kind === "official")
    .length;
  const aliases = Math.max(resultCount(account?.mailcom_aliases), listedAliases);
  return {
    aliases,
    total: Math.max(resultCount(account?.official_used), aliases + (account ? 1 : 0)),
  };
}

function fullMailcomResult(account, baseAddresses = []) {
  const counts = mailcomCounts(account, baseAddresses);
  return counts.total >= 10
    ? { existing: counts.aliases, created: 0, total: counts.total, status: "already_full" }
    : null;
}

function normalizedMailcomDomains(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((domain) => String(domain || "").trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean))];
}

export default function AliasSyncModal({ account, icloudKind, mailcomDomains = EMPTY_MAILCOM_DOMAINS, initialMailcomDomain = "", onClose, onSynced }) {
  const [aliases, setAliases] = useState("");
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [autoCreating, setAutoCreating] = useState(false);
  const [autoCreateResult, setAutoCreateResult] = useState(null);
  const [mailcomDomain, setMailcomDomain] = useState("");
  const [message, setMessage] = useState("");
  const toast = useToast();
  const isIcloud = account?.provider === "icloud";
  const isMailcom = account?.provider === "mailcom";
  const selectedKind = ICLOUD_IMPORT_TYPES[icloudKind] ? icloudKind : "mail_alias";
  const cloudType = ICLOUD_IMPORT_TYPES[selectedKind];
  const availableMailcomDomains = normalizedMailcomDomains(mailcomDomains);
  const mailcomDomainKey = availableMailcomDomains.join("|");
  const importEndpoint = account
    ? `/api/accounts/${account.id}/${isIcloud ? "icloud-aliases" : isMailcom ? "mailcom-aliases" : "official-aliases"}/import`
    : "";

  useEffect(() => {
    if (!account) return;
    const domains = availableMailcomDomains;
    const preferred = String(initialMailcomDomain || "").trim().toLowerCase().replace(/^@/, "");
    const primaryDomain = String(account.email || "").split("@")[1]?.toLowerCase();
    setMailcomDomain(domains.includes(preferred)
      ? preferred
      : domains.includes(primaryDomain)
        ? primaryDomain
        : domains.includes("mail.com")
          ? "mail.com"
          : domains[0] || "");
    setAliases("");
    setAutoCreateResult(isMailcom ? fullMailcomResult(account) : null);
    setMessage("");
    api(`/api/accounts/${account.id}`)
      .then((result) => {
        setAliases(result.baseAddresses
          .filter((item) => item.kind === "official" && (!isIcloud || item.strategy === cloudType.strategy))
          .map((item) => item.address)
          .join("\n"));
        if (isMailcom) setAutoCreateResult(fullMailcomResult(result.account, result.baseAddresses));
      })
      .catch((error) => setMessage(error.message));
  }, [account, cloudType.strategy, initialMailcomDomain, isIcloud, isMailcom, mailcomDomainKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const autoCreateMailcomAliases = async () => {
    if (!isMailcom || !account?.id || autoCreating) return;
    const baselineAliases = Math.max(resultCount(account.mailcom_aliases), aliasTextCount(aliases));
    const baselineTotal = Math.max(resultCount(account.official_used), baselineAliases + 1);
    setAutoCreating(true);
    setAutoCreateResult(null);
    setMessage("");
    let result = null;
    let operationError = null;
    let refreshed = null;
    let refreshError = null;
    try {
      result = await api(`/api/accounts/${account.id}/mailcom-aliases/auto-create`, {
        method: "POST",
        body: { domain: mailcomDomain },
      });
      const responseAliases = (result?.items || [])
        .filter((item) => item.kind === "official")
        .map((item) => item.address)
        .filter(Boolean);
      if (responseAliases.length) setAliases(responseAliases.join("\n"));
    } catch (error) {
      operationError = error;
    }

    try {
      try {
        refreshed = await api(`/api/accounts/${account.id}`);
        setAliases((refreshed.baseAddresses || [])
          .filter((item) => item.kind === "official")
          .map((item) => item.address)
          .join("\n"));
      } catch (error) {
        refreshError = error;
      }

      const refreshedCounts = refreshed
        ? mailcomCounts(refreshed.account, refreshed.baseAddresses)
        : mailcomCounts(operationError?.account || result?.account || account, operationError?.items || result?.items);
      let statusMessage = "";
      let toastMessage = "";
      let toastType = "success";

      if (!operationError) {
        const existing = resultCount(result?.existing ?? result?.existing_count, refreshedCounts.aliases);
        const created = resultCount(result?.created ?? result?.created_count);
        const total = resultCount(
          result?.total ?? result?.total_count ?? result?.account?.official_used,
          refreshedCounts.total || Math.min(10, existing + created + 1),
        );
        setAutoCreateResult({ existing, created, total, status: result?.status || "completed" });
        toastMessage = `自动创建完成：已有 ${existing}，新建 ${created}，合计 ${total}`;
        if (refreshError) statusMessage = `官网别名已创建，但列表刷新失败：${refreshError.message}`;
      } else {
        const partial = operationError.partial && typeof operationError.partial === "object"
          ? operationError.partial
          : {};
        const reportedCreated = resultCount(
          partial.created ?? partial.created_count ?? operationError.created ?? operationError.created_count,
        );
        const detectedCreated = Math.max(0, refreshedCounts.aliases - baselineAliases);
        const created = Math.max(reportedCreated, detectedCreated);
        const total = resultCount(
          partial.total ?? partial.total_count ?? operationError.total ?? operationError.total_count,
          refreshedCounts.total || baselineTotal + created,
        );
        const increased = refreshedCounts.aliases > baselineAliases || total > baselineTotal;
        const partiallyCompleted = operationError.partial === true
          || (operationError.partial && typeof operationError.partial === "object")
          || created > 0
          || increased;

        if (partiallyCompleted) {
          const existing = resultCount(
            partial.existing ?? partial.existing_count ?? operationError.existing ?? operationError.existing_count,
            Math.max(0, total - created - 1),
          );
          setAutoCreateResult({ existing, created, total, status: "partial", partial: true });
          statusMessage = `部分完成：已有 ${existing}，本次创建 ${created}，当前合计 ${total}。${operationError.message}`;
          toastMessage = `官方别名部分完成：新建 ${created}，合计 ${total}`;
        } else {
          setAutoCreateResult(fullMailcomResult(refreshed?.account, refreshed?.baseAddresses));
          statusMessage = operationError.message;
          toastMessage = operationError.message;
        }
        if (refreshError) statusMessage += `；列表刷新失败：${refreshError.message}`;
        toastType = "error";
      }

      try {
        await onSynced?.(refreshed
          ? { ...(result || operationError?.partial || {}), account: refreshed.account, items: refreshed.baseAddresses }
          : (result || operationError?.partial || {}));
      } catch (error) {
        statusMessage = statusMessage || `账户数据刷新失败：${error.message}`;
      }
      if (statusMessage) setMessage(statusMessage);
      if (toastMessage) toast(toastMessage, toastType);
    } finally {
      setAutoCreating(false);
    }
  };

  const sync = async () => {
    setLoading(true);
    setMessage("");
    try {
      const result = await api(importEndpoint, {
        method: "POST",
        body: {
          aliases: aliases.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean),
          ...(isIcloud ? { type: selectedKind, replace: true } : isMailcom ? { replace: true } : {}),
        },
      });
      const importedCount = selectedKind === "hide_my_email"
        ? result.account?.icloud_hide_my_emails
        : selectedKind === "custom_domain"
          ? result.account?.icloud_custom_domain_emails
          : result.account?.icloud_mail_aliases;
      toast(isIcloud
        ? `登记完成，当前共 ${importedCount || 0} 个${cloudType.resultLabel}`
        : isMailcom
          ? `登记完成，当前共 ${Number(result.account?.mailcom_aliases ?? result.account?.official_aliases ?? result.items?.length) || 0} 个官方分裂别名`
          : `登记完成，当前共 ${result.account.official_aliases} 个官方别名`);
      await onSynced?.(result);
      onClose();
    } catch (error) {
      setMessage(error.message);
      toast(error.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const openOfficial = async () => {
    const popup = window.open("about:blank", isIcloud ? cloudType.popupName : isMailcom ? MAILCOM_IMPORT.popupName : "aliashub-microsoft-aliases");
    setOpening(true);
    setMessage("");
    try {
      if (isIcloud || isMailcom) {
        if (popup) {
          popup.location.href = isMailcom ? MAILCOM_IMPORT.officialUrl : cloudType.officialUrl;
          popup.focus();
        } else {
          setMessage(`浏览器拦截了${isMailcom ? MAILCOM_IMPORT.openLabel : cloudType.openLabel}窗口，请允许此网站打开弹窗`);
        }
        return;
      }
      const result = await api(`/api/accounts/${account.id}/official-launch`, { method: "POST" });
      if (popup) { popup.location.href = result.officialUrl; popup.focus(); }
      else setMessage("浏览器拦截了微软官网窗口，请允许此网站打开弹窗");
    } catch (error) {
      popup?.close();
      setMessage(error.message);
      toast(error.message, "error");
    } finally {
      setOpening(false);
    }
  };

  const close = () => {
    if (!autoCreating) onClose();
  };

  const footer = <>
    <Button disabled={autoCreating} onClick={close}>取消</Button>
    <Button icon={ExternalLink} loading={opening} disabled={autoCreating} onClick={openOfficial}>{isIcloud ? cloudType.openLabel : isMailcom ? MAILCOM_IMPORT.openLabel : "微软官网创建"}</Button>
    <Button variant="primary" icon={ListPlus} loading={loading} disabled={autoCreating} onClick={sync}>{isIcloud || isMailcom ? "保存列表" : "确认登记"}</Button>
  </>;

  return (
    <Modal
      open={Boolean(account)}
      onClose={close}
      title={isIcloud ? cloudType.title : isMailcom ? MAILCOM_IMPORT.title : "登记官网已有别名"}
      description={account ? (isIcloud ? `${account.email} · ${cloudType.description}` : isMailcom ? `${account.email} · ${MAILCOM_IMPORT.description}` : `${account.email} · 仅登记已在微软官网创建的别名`) : ""}
      size="md"
      footer={footer}
    >
      <div className="form-stack alias-sync-form">
        {isMailcom && <section className={`mailcom-auto-create-card${autoCreating ? " is-running" : autoCreateResult?.partial ? " is-partial" : autoCreateResult ? " is-complete" : ""}`} aria-busy={autoCreating}>
          <span className="mailcom-auto-create-icon">{autoCreateResult ? <CheckCircle2 size={22} /> : <WandSparkles size={22} />}</span>
          <div className="mailcom-auto-create-copy">
            <h3>{autoCreating ? "正在自动创建官方别名" : autoCreateResult?.partial ? "官方别名部分完成" : autoCreateResult?.status === "already_full" ? "预备地址已达到目标" : autoCreateResult ? "官方别名自动创建完成" : "自动预备 mail.com 官方别名"}</h3>
            <p>{autoCreating ? "正在登录 mail.com 官网并逐个补齐别名，可能需要几分钟；完成前请勿关闭窗口或重复提交。" : "保留全部已有官网地址，流水线默认预备到合计 10 个；10 不是官网上限，后续轮换不受历史创建次数限制。"}</p>
            <label className="mailcom-auto-create-domain"><span>别名域名后缀</span><select value={mailcomDomain} disabled={autoCreating} onChange={(event) => setMailcomDomain(event.target.value)}>{availableMailcomDomains.map((domain) => <option value={domain} key={domain}>@{domain}</option>)}</select></label>
            {autoCreateResult && <div className="mailcom-auto-create-stats" role="status" aria-live="polite"><span><small>已有</small><b>{autoCreateResult.existing}</b></span><span><small>本次创建</small><b>{autoCreateResult.created}</b></span><span><small>当前合计</small><b>{autoCreateResult.total}</b></span><span><small>预备目标</small><b>10</b></span></div>}
          </div>
          <Button className="mailcom-auto-create-button" variant="primary" icon={WandSparkles} loading={autoCreating} disabled={loading || opening || !mailcomDomain || autoCreateResult?.total >= 10} onClick={autoCreateMailcomAliases}>{autoCreating ? "正在创建，请稍候" : autoCreateResult?.total >= 10 ? "预备已完成" : "一键预备别名"}</Button>
        </section>}
        <label className="form-field">
          <span className="field-label">{isIcloud ? cloudType.fieldLabel : isMailcom ? MAILCOM_IMPORT.fieldLabel : "官网已创建的别名（每行一个）"}</span>
          <textarea rows="6" value={aliases} disabled={autoCreating} onChange={(event) => setAliases(event.target.value)} placeholder={isIcloud ? cloudType.placeholder : isMailcom ? MAILCOM_IMPORT.placeholder : "例如 name@outlook.jp、name@outlook.de"} autoCapitalize="off" autoCorrect="off" spellCheck="false" autoFocus />
        </label>
        <div className="provider-login-note"><AtSign size={22} /><span><b>{account?.email}</b><small>{isIcloud ? cloudType.note : isMailcom ? MAILCOM_IMPORT.note : "只登记到注册工作站，不会在微软官网创建或删除别名"}</small></span></div>
        {message && <div className="inline-alert danger"><AlertCircle size={17} /><span>{message}</span></div>}
      </div>
    </Modal>
  );
}
