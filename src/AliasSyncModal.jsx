import { useEffect, useState } from "react";
import { AlertCircle, AtSign, ExternalLink, ListPlus } from "lucide-react";
import { api } from "./api.js";
import { Button, Modal, useToast } from "./components.jsx";

export default function AliasSyncModal({ account, onClose, onSynced }) {
  const [aliases, setAliases] = useState("");
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [message, setMessage] = useState("");
  const toast = useToast();

  useEffect(() => {
    if (!account) return;
    setAliases("");
    setMessage("");
    api(`/api/accounts/${account.id}`)
      .then((result) => setAliases(result.baseAddresses.filter((item) => item.kind === "official").map((item) => item.address).join("\n")))
      .catch((error) => setMessage(error.message));
  }, [account]);

  const sync = async () => {
    setLoading(true);
    setMessage("");
    try {
      const result = await api(`/api/accounts/${account.id}/official-aliases/import`, {
        method: "POST",
        body: { aliases: aliases.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean) },
      });
      toast(`登记完成，当前共 ${result.account.official_aliases} 个官方别名`);
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
    const popup = window.open("about:blank", "aliashub-microsoft-aliases");
    setOpening(true);
    setMessage("");
    try {
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

  const footer = <><Button onClick={onClose}>取消</Button><Button icon={ExternalLink} loading={opening} onClick={openOfficial}>微软官网创建</Button><Button variant="primary" icon={ListPlus} loading={loading} onClick={sync}>确认登记</Button></>;

  return (
    <Modal open={Boolean(account)} onClose={onClose} title="登记官网已有别名" description={account ? `${account.email} · 仅登记已在微软官网创建的别名` : ""} size="md" footer={footer}>
      <div className="form-stack alias-sync-form">
        <label className="form-field">
          <span className="field-label">官网已创建的别名（每行一个）</span>
          <textarea rows="6" value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="例如 name@outlook.jp、name@outlook.de" autoCapitalize="off" autoCorrect="off" spellCheck="false" autoFocus />
        </label>
        <div className="provider-login-note"><AtSign size={22} /><span><b>{account?.email}</b><small>只登记到 AliasHub，不会在微软官网创建或删除别名</small></span></div>
        {message && <div className="inline-alert danger"><AlertCircle size={17} /><span>{message}</span></div>}
      </div>
    </Modal>
  );
}
