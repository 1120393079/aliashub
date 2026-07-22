import { useEffect, useState } from "react";
import { AlertCircle, AtSign, ExternalLink, ListPlus } from "lucide-react";
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
    description: "从 iCloud+ Hide My Email 导入已创建的 @privaterelay.appleid.com 地址",
    fieldLabel: "iCloud 隐藏邮箱（每行一个）",
    placeholder: "例如 xxxxx@privaterelay.appleid.com",
    officialUrl: "https://www.icloud.com/icloudplus/",
    openLabel: "打开 iCloud+ 隐藏邮箱",
    popupName: "aliashub-icloud-hide-my-email",
    note: "隐藏邮箱由 iCloud+ 创建，邮件会转发到该源头 iCloud 邮箱。",
    resultLabel: "iCloud 隐藏邮箱",
  },
};

export default function AliasSyncModal({ account, icloudKind, onClose, onSynced }) {
  const [aliases, setAliases] = useState("");
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [message, setMessage] = useState("");
  const toast = useToast();
  const isIcloud = account?.provider === "icloud";
  const selectedKind = ICLOUD_IMPORT_TYPES[icloudKind] ? icloudKind : "mail_alias";
  const cloudType = ICLOUD_IMPORT_TYPES[selectedKind];
  const importEndpoint = account ? `/api/accounts/${account.id}/${isIcloud ? "icloud-aliases" : "official-aliases"}/import` : "";

  useEffect(() => {
    if (!account) return;
    setAliases("");
    setMessage("");
    api(`/api/accounts/${account.id}`)
      .then((result) => setAliases(result.baseAddresses
        .filter((item) => item.kind === "official" && (!isIcloud || item.strategy === cloudType.strategy))
        .map((item) => item.address)
        .join("\n")))
      .catch((error) => setMessage(error.message));
  }, [account, cloudType.strategy, isIcloud]);

  const sync = async () => {
    setLoading(true);
    setMessage("");
    try {
      const result = await api(importEndpoint, {
        method: "POST",
        body: {
          aliases: aliases.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean),
          ...(isIcloud ? { type: selectedKind } : {}),
        },
      });
      const importedCount = selectedKind === "hide_my_email"
        ? result.account.icloud_hide_my_emails
        : result.account.icloud_mail_aliases;
      toast(isIcloud
        ? `登记完成，当前共 ${importedCount || 0} 个${cloudType.resultLabel}`
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
    const popup = window.open("about:blank", isIcloud ? cloudType.popupName : "aliashub-microsoft-aliases");
    setOpening(true);
    setMessage("");
    try {
      if (isIcloud) {
        if (popup) {
          popup.location.href = cloudType.officialUrl;
          popup.focus();
        } else {
          setMessage(`浏览器拦截了${cloudType.openLabel}窗口，请允许此网站打开弹窗`);
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

  const footer = <>
    <Button onClick={onClose}>取消</Button>
    <Button icon={ExternalLink} loading={opening} onClick={openOfficial}>{isIcloud ? cloudType.openLabel : "微软官网创建"}</Button>
    <Button variant="primary" icon={ListPlus} loading={loading} onClick={sync}>确认登记</Button>
  </>;

  return (
    <Modal
      open={Boolean(account)}
      onClose={onClose}
      title={isIcloud ? cloudType.title : "登记官网已有别名"}
      description={account ? (isIcloud ? `${account.email} · ${cloudType.description}` : `${account.email} · 仅登记已在微软官网创建的别名`) : ""}
      size="md"
      footer={footer}
    >
      <div className="form-stack alias-sync-form">
        <label className="form-field">
          <span className="field-label">{isIcloud ? cloudType.fieldLabel : "官网已创建的别名（每行一个）"}</span>
          <textarea rows="6" value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder={isIcloud ? cloudType.placeholder : "例如 name@outlook.jp、name@outlook.de"} autoCapitalize="off" autoCorrect="off" spellCheck="false" autoFocus />
        </label>
        <div className="provider-login-note"><AtSign size={22} /><span><b>{account?.email}</b><small>{isIcloud ? cloudType.note : "只登记到 AliasHub，不会在微软官网创建或删除别名"}</small></span></div>
        {message && <div className="inline-alert danger"><AlertCircle size={17} /><span>{message}</span></div>}
      </div>
    </Modal>
  );
}
