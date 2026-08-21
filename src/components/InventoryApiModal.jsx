import { useEffect, useMemo, useRef, useState } from "react";
import { Cable, Database, Mail, Save, ShieldCheck, Upload } from "lucide-react";
import { api } from "../api.js";
import { Button, FormField, Modal, Segmented, StatusBadge, useToast } from "../components.jsx";

const EMPTY_CONFIG = {
  cards_url: "https://nvtokens.com/api/inventory/cards/import",
  mailboxes_url: "https://nvtokens.com/api/inventory/mailboxes/import",
  pool_url: "https://nvtokens.com/api/inventory/cards/pool",
  api_key_configured: false,
  configured: false,
  connected: false,
  auth_header: "x-api-key",
};

function numberValue(value) {
  if (Array.isArray(value)) return value.length;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function resultMetrics(result) {
  const summary = result?.summary && typeof result.summary === "object" ? result.summary : {};
  const accepted = numberValue(result?.accepted ?? summary.accepted);
  const rejected = numberValue(result?.rejected ?? summary.rejected);
  return {
    requested: numberValue(result?.requested_count ?? summary.requested_count) ?? 0,
    source: numberValue(result?.source_count ?? summary.source_count) ?? 0,
    localFailed: numberValue(result?.local_failed_count ?? summary.local_failed_count) ?? 0,
    credentialFailures: numberValue(result?.credential_failures ?? summary.credential_failures) ?? 0,
    accepted: accepted ?? 0,
    rejected: rejected ?? 0,
    matched: numberValue(result?.matched) ?? 0,
    updated: numberValue(result?.updated) ?? 0,
    unchanged: numberValue(result?.unchanged) ?? 0,
    unmatched: numberValue(result?.unmatched) ?? 0,
    invalid: numberValue(result?.invalid) ?? 0,
    duplicates: numberValue(result?.duplicates) ?? 0,
  };
}

function safeFailureItems(result) {
  const values = [
    ...(Array.isArray(result?.failures) ? result.failures : []),
    ...(Array.isArray(result?.rejected) ? result.rejected : []),
    ...(Array.isArray(result?.unmatched_details) ? result.unmatched_details : []),
    ...(Array.isArray(result?.invalid_details) ? result.invalid_details : []),
    ...(Array.isArray(result?.credential_failures) ? result.credential_failures : []),
  ];
  return values.slice(0, 8).map((item) => ({
    email: String(item?.email || "").slice(0, 180),
    line: item?.line,
    reason: String(item?.reason || item?.error || "未通过上游校验").slice(0, 240),
  }));
}

export default function InventoryApiModal({
  open,
  onClose,
  selectedIds = [],
  selectedEmails = [],
  allLinked = false,
  initialTab = "",
  onDone,
}) {
  const toast = useToast();
  const sessionRef = useRef(0);
  const [config, setConfig] = useState(EMPTY_CONFIG);
  const [tab, setTab] = useState(initialTab || (selectedIds.length ? "cards" : selectedEmails.length ? "mailboxes" : "cards"));
  const [jsonText, setJsonText] = useState("");
  const [mailboxText, setMailboxText] = useState("");
  const [fileName, setFileName] = useState("");
  const [price, setPrice] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  const selectedCount = selectedIds.length;
  const hasSelection = selectedCount > 0 || selectedEmails.length > 0 || allLinked;
  const metrics = useMemo(() => resultMetrics(result), [result]);
  const failures = useMemo(() => safeFailureItems(result), [result]);

  const loadConfig = async (session = sessionRef.current) => {
    try {
      const value = await api("/api/inventory/config");
      if (sessionRef.current !== session) return;
      setConfig({ ...EMPTY_CONFIG, ...value, api_key: "" });
    } catch (error) {
      if (sessionRef.current !== session) return;
      toast(error.message, "error");
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    setTab(initialTab || (!selectedIds.length && (selectedEmails.length || allLinked) ? "mailboxes" : "cards"));
    setConfig(EMPTY_CONFIG);
    setJsonText("");
    setMailboxText("");
    setFileName("");
    setPrice("");
    setResult(null);
    setSaving(false);
    setClearing(false);
    setTesting(false);
    setSubmitting(false);
    loadConfig(session);
    return () => {
      if (sessionRef.current === session) sessionRef.current += 1;
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveConfig = async () => {
    const session = sessionRef.current;
    setSaving(true);
    try {
      const payload = {
        ...(config.api_key?.trim() ? { api_key: config.api_key.trim() } : {}),
      };
      const value = await api("/api/inventory/config", { method: "PATCH", body: payload });
      if (sessionRef.current !== session) return;
      setConfig({ ...EMPTY_CONFIG, ...value, api_key: "" });
      toast("库存 API 配置已保存");
    } catch (error) {
      if (sessionRef.current !== session) return;
      toast(error.message, "error");
    } finally {
      if (sessionRef.current === session) setSaving(false);
    }
  };

  const testConnection = async () => {
    const session = sessionRef.current;
    setTesting(true);
    try {
      const value = await api("/api/inventory/test", { method: "POST" });
      if (sessionRef.current !== session) return;
      setConfig((current) => ({ ...current, connected: true, last_connected_at: value.last_connected_at }));
      toast(value.message || "库存 API 连接正常");
    } catch (error) {
      if (sessionRef.current !== session) return;
      setConfig((current) => ({ ...current, connected: false }));
      toast(error.message, "error");
    } finally {
      if (sessionRef.current === session) setTesting(false);
    }
  };

  const clearKey = async () => {
    if (!window.confirm("清除当前库存 API Key？清除后不会再向 nvtokens 发起请求。")) return;
    const session = sessionRef.current;
    setClearing(true);
    try {
      const value = await api("/api/inventory/config", { method: "PATCH", body: { clear_api_key: true } });
      if (sessionRef.current !== session) return;
      setConfig({ ...EMPTY_CONFIG, ...value, api_key: "" });
      toast("库存 API Key 已清除");
    } catch (error) {
      if (sessionRef.current !== session) return;
      toast(error.message, "error");
    } finally {
      if (sessionRef.current === session) setClearing(false);
    }
  };

  const loadInputFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const session = sessionRef.current;
    try {
      const content = await file.text();
      if (sessionRef.current !== session) return;
      setFileName(file.name);
      if (tab === "mailboxes") setMailboxText(content);
      else setJsonText(content);
    } catch {
      toast("文件读取失败", "error");
    } finally {
      event.target.value = "";
    }
  };

  const submit = async () => {
    const session = sessionRef.current;
    setSubmitting(true);
    setResult(null);
    try {
      let endpoint = "/api/inventory/cards/import";
      let body;
      if (tab === "mailboxes") {
        endpoint = "/api/inventory/mailboxes/import";
        if (mailboxText.trim()) {
          const trimmed = mailboxText.trim();
          if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
              const parsed = JSON.parse(trimmed);
              body = Array.isArray(parsed) ? { tokens: parsed } : parsed;
            } catch { throw new Error("邮箱凭证 JSON 格式无效"); }
          } else {
            body = { text: trimmed };
          }
        }
        else if (selectedIds.length) body = { ids: selectedIds };
        else if (allLinked) body = { all_linked: true };
        else if (selectedEmails.length) body = { emails: selectedEmails };
        else throw new Error("请粘贴邮箱凭证，或先选择注册账号");
      } else {
        if (jsonText.trim()) {
          let payload;
          try { payload = JSON.parse(jsonText); } catch { throw new Error("账号内容不是有效 JSON"); }
          body = { payload };
        } else if (selectedIds.length) {
          body = { ids: selectedIds };
        } else {
          throw new Error("请粘贴账号 JSON，或先选择注册账号");
        }
        if (tab === "pool") {
          endpoint = "/api/inventory/cards/pool";
          if (!price.trim()) throw new Error("直接入池需要填写单价");
          body.price_yuan = price.trim();
        }
      }
      const value = await api(endpoint, {
        method: "POST",
        body,
        headers: { "Idempotency-Key": `aliashub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` },
      });
      if (sessionRef.current !== session) return;
      setResult(value);
      const current = resultMetrics(value);
      const total = current.accepted + current.matched + current.updated;
      const hasLocalFailure = current.localFailed > 0 || current.credentialFailures > 0;
      toast(tab === "mailboxes"
        ? `邮箱凭证已提交：来源 ${current.source}，匹配 ${current.matched}，更新 ${current.updated}${current.localFailed ? `，本地失败 ${current.localFailed}` : ""}`
        : `账号已提交：请求 ${current.requested}，来源 ${current.source}，接受 ${current.accepted}${current.localFailed ? `，本地失败 ${current.localFailed}` : ""}${current.rejected ? `，拒绝 ${current.rejected}` : ""}`,
        current.rejected || current.invalid || hasLocalFailure ? "error" : "success");
      if (total > 0) onDone?.(value);
    } catch (error) {
      if (sessionRef.current !== session) return;
      if (error.code === "INVENTORY_LOCAL_CREDENTIALS_UNAVAILABLE" && error.details) {
        setResult(error.details);
      }
      toast(error.message, "error");
    } finally {
      if (sessionRef.current === session) setSubmitting(false);
    }
  };

  const tabItems = [
    { value: "cards", label: "账号入库", icon: Database },
    { value: "mailboxes", label: "导入邮箱凭证", icon: Mail },
    { value: "pool", label: "直接入池", icon: Upload },
  ];

  return (
    <Modal
      open={open}
      onClose={() => { if (!submitting) onClose(); }}
      size="xl"
      title="库存 API"
      description="统一代理 nvtokens 库存接口；推荐在系统设置的 nvtokens 库存页面维护 Key，这里也可查看状态并执行操作。Key 只在提交配置时传给服务端，后续不会回显。"
      footer={<><Button disabled={submitting} onClick={onClose}>关闭</Button><Button variant="primary" icon={Upload} loading={submitting} disabled={!config.api_key_configured || saving || testing} onClick={submit}>{tab === "mailboxes" ? "提交邮箱凭证" : tab === "pool" ? "提交并入池" : "提交账号入库"}</Button></>}
    >
      <div className="inventory-api-modal">
        <Segmented value={tab} onChange={(value) => { setTab(value); setResult(null); }} ariaLabel="库存 API 操作" items={tabItems} />
        <div className="inline-alert"><ShieldCheck size={15} /><span>状态：<b>{!config.encryption_ready ? "服务器未配置加密密钥" : config.connected ? "已连接" : config.api_key_configured ? "Key 已配置，尚未测试" : "未配置 Key"}</b> · 共支持账号入库、邮箱凭证导入和直接入池 3 项操作。</span><StatusBadge status={!config.encryption_ready ? "failed" : config.connected ? "active" : config.api_key_configured ? "warning" : "inactive"}>{!config.encryption_ready ? "不可用" : config.connected ? "可用" : config.api_key_configured ? "待测试" : "未启用"}</StatusBadge></div>
        <section className="inventory-api-config">
          <header><div><h3>连接配置</h3><p>服务地址已由服务端锁定；首次使用只需粘贴库存 Key 并保存。</p></div><div className="inventory-api-config-actions"><Button size="sm" icon={Cable} loading={testing} disabled={!config.api_key_configured || saving || clearing} onClick={testConnection}>测试连接</Button>{config.api_key_configured && <Button size="sm" disabled={saving || testing || clearing} onClick={clearKey}>清除 Key</Button>}<Button size="sm" variant="primary" icon={Save} loading={saving} disabled={testing || clearing} onClick={saveConfig}>保存配置</Button></div></header>
          <div className="form-grid two"><FormField label="账号入库地址" hint="由服务端锁定，不可在浏览器修改"><input type="url" value={config.cards_url || ""} readOnly /></FormField><FormField label="库存 API Key" hint={config.api_key_configured ? "已配置；留空保存会保留原 Key" : "只发送到本站后端，加密保存"}><input type="password" autoComplete="new-password" value={config.api_key || ""} disabled={config.encryption_ready === false} onChange={(event) => setConfig({ ...config, api_key: event.target.value, connected: false })} placeholder={config.encryption_ready === false ? "先配置 DATA_ENCRYPTION_KEY" : config.api_key_configured ? "留空保留现有 Key" : "粘贴 x-api-key"} /></FormField></div>
          <details><summary>查看固定服务地址</summary><div className="form-grid two"><FormField label="邮箱凭证地址"><input type="url" value={config.mailboxes_url || ""} readOnly /></FormField><FormField label="直接入池地址"><input type="url" value={config.pool_url || ""} readOnly /></FormField></div></details>
          <details><summary>curl 调用示例（Key 使用占位符）</summary><pre className="inventory-api-curl">{`curl -X POST ${config.cards_url || "https://nvtokens.com/api/inventory/cards/import"} \\\n  -H "content-type: application/json" \\\n  -H "x-api-key: YOUR_KEY" \\\n  --data '{"data":{"access_token":"...","refresh_token":"...","email":"user@example.com","type":"codex"}}'`}</pre></details>
        </section>

        {tab === "mailboxes" ? <section className="inventory-api-input"><div className="inventory-api-hint"><Mail size={15} /><span>三种格式可混合，每行一条：<code>邮箱----HTTPS 接码 API</code>、<code>邮箱----密码----client_id----refresh_token</code>、<code>邮箱--密码--2FA 长期密钥</code>。也可以不粘贴，直接按已选注册账号匹配链接取件邮箱。</span></div><input type="file" accept=".txt,.json,.jsonl,text/plain,application/json" onChange={loadInputFile} />{fileName && <small className="muted-cell">已读取：{fileName}</small>}<textarea rows="9" spellCheck="false" value={mailboxText} onChange={(event) => setMailboxText(event.target.value)} placeholder={'user@example.com----https://mail-api.example.com/code?token=...\nuser@outlook.com----password----client_id----refresh_token'} /></section> : <section className="inventory-api-input"><div className="inventory-api-hint"><Database size={15} /><span>{hasSelection ? `当前已选择 ${selectedCount || selectedEmails.length} 个账号；留空将由服务器读取 AT/Refresh Token 并自动匹配。` : "可粘贴单个账号 JSON、数组或完整 sub2api 导出；也可以到注册账号页选择账号后再打开此窗口。"}</span></div><input type="file" accept=".json,.jsonl,application/json" onChange={loadInputFile} />{fileName && <small className="muted-cell">已读取：{fileName}</small>}<textarea rows="9" spellCheck="false" value={jsonText} onChange={(event) => setJsonText(event.target.value)} placeholder={'留空使用已选账号，或粘贴：\n{"data":{"access_token":"...","refresh_token":"...","email":"user@example.com","type":"codex"}}'} />{tab === "pool" && <div className="form-grid two"><FormField label="入池单价（元）"><input inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="例如 10.00" /></FormField><div className="inventory-api-price-note">检测通过后才会进入 nvtokens 号池；失败账号会留在个人库存。</div></div>}</section>}

        {result && <section className="inventory-api-result"><header><h3>提交结果</h3><span>仅显示统计，不回显任何 Token</span></header><div className="inventory-api-metrics"><span><b>{metrics.requested}</b>请求</span><span><b>{metrics.source}</b>来源</span><span><b>{metrics.localFailed}</b>本地失败</span><span><b>{metrics.credentialFailures}</b>凭据失败</span><span><b>{metrics.accepted}</b>接受</span><span><b>{metrics.rejected}</b>拒绝</span><span><b>{metrics.matched}</b>匹配</span><span><b>{metrics.updated}</b>更新</span><span><b>{metrics.unmatched}</b>未匹配</span><span><b>{metrics.invalid}</b>格式错误</span></div>{failures.length > 0 && <div className="inventory-api-failures">{failures.map((item, index) => <div key={`${item.email}-${item.line}-${index}`}><b>{item.email || `第 ${item.line || "?"} 行`}</b><span>{item.reason}</span></div>)}</div>}{(result.missing_emails || []).length > 0 && <p className="inventory-api-missing">未找到已绑定取件链接：{result.missing_emails.slice(0, 8).join("、")}</p>}</section>}
      </div>
    </Modal>
  );
}
