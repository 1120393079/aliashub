import { useEffect, useState } from "react";
import { Cable, Copy, Database, Download, ExternalLink, KeyRound, LockKeyhole, Mail, Puzzle, Save, Server, ShieldCheck } from "lucide-react";
import { api, appUrl } from "../api.js";
import { Button, FormField, LoadingBlock, StatusBadge, useToast } from "../components.jsx";
import { copyText } from "../utils.js";

export default function SettingsPage() {
  const [form, setForm] = useState(null);
  const [health, setHealth] = useState(null);
  const [nfapi, setNfapi] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savingNfapi, setSavingNfapi] = useState(false);
  const [testingNfapi, setTestingNfapi] = useState(false);
  const toast = useToast();

  const load = async () => {
    try {
      const [settings, status, nfapiConfig] = await Promise.all([api("/api/settings"), api("/api/health"), api("/api/nfapi/config")]);
      setForm(settings);
      setHealth(status);
      setNfapi({ ...nfapiConfig, admin_api_key: "" });
    } catch (error) {
      toast(error.message, "error");
    }
  };

  const saveNfapi = async () => {
    setSavingNfapi(true);
    try {
      const adminApiKey = nfapi.admin_api_key.trim();
      const result = await api("/api/nfapi/config", {
        method: "PATCH",
        body: {
          base_url: nfapi.base_url.trim(),
          ...(adminApiKey ? { admin_api_key: adminApiKey } : {}),
        },
      });
      setNfapi({ ...result, admin_api_key: "" });
      toast("NFapi 连接配置已保存");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setSavingNfapi(false);
    }
  };

  const testNfapi = async () => {
    setTestingNfapi(true);
    try {
      const result = await api("/api/nfapi/test", { method: "POST" });
      setNfapi((current) => ({ ...current, connected: result.connected !== false }));
      toast(result.message || "NFapi 连接正常");
    } catch (error) {
      setNfapi((current) => ({ ...current, connected: false }));
      toast(error.message, "error");
    } finally {
      setTestingNfapi(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    try {
      await api("/api/settings", {
        method: "PATCH",
        body: {
          site_name: form.site_name,
          code_retention_days: form.code_retention_days,
          default_recovery_email: form.default_recovery_email,
        },
      });
      await load();
      toast("系统设置已保存");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setSaving(false);
    }
  };

  if (!form || !nfapi) return <div className="page-stack"><LoadingBlock rows={7} /></div>;

  return (
    <div className="settings-layout">
      <aside className="settings-index"><a href="#general"><Mail size={16} />基本设置</a><a href="#nfapi"><Cable size={16} />NFapi 连接</a><a href="#security"><ShieldCheck size={16} />邮箱连接安全</a><a href="#connector"><Puzzle size={16} />官网扩展</a><a href="#runtime"><Server size={16} />运行状态</a></aside>
      <div className="settings-content">
        <section id="general" className="settings-section">
          <header><span><Mail size={19} /></span><div><h2>基本设置</h2><p>管理台与验证码数据配置</p></div></header>
          <div className="settings-form"><FormField label="站点名称"><input value={form.site_name} onChange={(event) => setForm({ ...form, site_name: event.target.value })} /></FormField><FormField label="验证码保留天数"><input type="number" min="1" max="365" value={form.code_retention_days} onChange={(event) => setForm({ ...form, code_retention_days: event.target.value })} /></FormField><Button variant="primary" icon={Save} loading={saving} onClick={save}>保存设置</Button></div>
        </section>

        <section id="nfapi" className="settings-section">
          <header><span><Cable size={19} /></span><div><h2>NFapi 连接</h2><p>连接账号调度服务并安全保存管理员 API Key</p></div><StatusBadge status={nfapi.connected ? "active" : "inactive"}>{nfapi.connected ? "已连接" : "未连接"}</StatusBadge></header>
          <div className="settings-form">
            <div className="nfapi-connection-state"><Server size={17} /><span><b>{nfapi.connected ? "NFapi API 可用" : "等待连接测试"}</b><small>{nfapi.api_key_configured ? "管理员 API Key 已加密保存" : "尚未配置管理员 API Key"}</small></span><StatusBadge status={nfapi.api_key_configured ? "active" : "inactive"}>{nfapi.api_key_configured ? "Key 已配置" : "缺少 Key"}</StatusBadge></div>
            <FormField label="NFapi 地址" hint="填写 NFapi 管理 API 的基础地址，例如 https://nfapi.example.com"><input type="url" value={nfapi.base_url || ""} onChange={(event) => setNfapi({ ...nfapi, base_url: event.target.value, connected: false })} placeholder="https://nfapi.example.com" /></FormField>
            <FormField label="管理员 API Key" hint={nfapi.api_key_configured ? "已配置；留空保存会保留原 Key，输入新值才会替换。" : "只发送到本站后端加密保存，页面不会回显。"}><input type="password" autoComplete="new-password" value={nfapi.admin_api_key} onChange={(event) => setNfapi({ ...nfapi, admin_api_key: event.target.value, connected: false })} placeholder={nfapi.api_key_configured ? "留空保留现有 Key" : "输入管理员 API Key"} /></FormField>
            <div className="nfapi-connection-actions"><Button icon={Cable} loading={testingNfapi} disabled={savingNfapi || !nfapi.base_url || !nfapi.api_key_configured} onClick={testNfapi}>测试已保存连接</Button><Button variant="primary" icon={Save} loading={savingNfapi} disabled={testingNfapi || !nfapi.base_url || (!nfapi.api_key_configured && !nfapi.admin_api_key.trim())} onClick={saveNfapi}>保存连接</Button></div>
          </div>
        </section>

        <section id="security" className="settings-section">
          <header><span><LockKeyhole size={19} /></span><div><h2>邮箱连接安全</h2><p>Microsoft、Google 公共客户端与 iCloud IMAP 凭据存储</p></div></header>
          <div className="security-list">
            <div><ShieldCheck size={17} /><span><b>Microsoft Authorization Code + PKCE</b><small>{form.microsoft_oauth_client}</small></span><StatusBadge status="active">已启用</StatusBadge></div>
            <div><ShieldCheck size={17} /><span><b>Google 内置公共客户端 + PKCE</b><small>Thunderbird 邮件公共客户端；AliasHub 只执行 Gmail 邮件读取</small></span><StatusBadge status="active">已启用</StatusBadge></div>
            <div><KeyRound size={17} /><span><b>邮箱连接凭据</b><small>OAuth Refresh Token 与 iCloud App 专用密码均使用 AES-256-GCM 加密保存</small></span><StatusBadge status="active">已加密</StatusBadge></div>
            <div><Database size={17} /><span><b>邮件读取权限</b><small>Microsoft Graph Mail.Read · Google Gmail readonly · iCloud IMAP readonly</small></span><StatusBadge status="active">只读</StatusBadge></div>
          </div>
        </section>

        <section id="connector" className="settings-section">
          <header><span><Puzzle size={19} /></span><div><h2>Microsoft 官网扩展</h2><p>仅用于在本地浏览器操作 Microsoft 官方别名页面</p></div></header>
          <div className="settings-form"><FormField label="扩展配对密钥"><div className="copy-input"><input readOnly value={form.extension_api_key || ""} /><Button icon={Copy} onClick={() => copyText(form.extension_api_key).then(() => toast("扩展配对密钥已复制"))}>复制</Button></div></FormField><Button variant="primary" icon={Download} onClick={() => { window.location.href = appUrl(form.extension_download); }}>下载 AliasHub 扩展</Button></div>
        </section>

        <section id="runtime" className="settings-section">
          <header><span><Server size={19} /></span><div><h2>运行状态</h2><p>生产服务与支持范围</p></div></header>
          <dl className="runtime-grid"><div><dt>API 服务</dt><dd><span className="live-dot" />{health?.status === "ok" ? "运行正常" : "未知"}</dd></div><div><dt>源头邮箱</dt><dd>{health?.accounts || 0} 个</dd></div><div><dt>邮箱提供商</dt><dd>Microsoft · Google · iCloud</dd></div><div><dt>Microsoft 域名</dt><dd>{(form.supported_domains || []).join(" · ")}</dd></div><div><dt>服务地址</dt><dd>{form.public_base_url}</dd></div><div><dt>Google OAuth</dt><dd>内置授权</dd></div><div><dt>iCloud IMAP</dt><dd>{form.icloud_imap?.host || "imap.mail.me.com"}:{form.icloud_imap?.port || 993} · TLS</dd></div></dl>
          <a className="official-doc-link" href="https://support.microsoft.com/en-us/outlook/add-or-remove-an-email-alias-in-outlook-com" target="_blank" rel="noreferrer"><ExternalLink size={15} />Microsoft 官方别名规则</a>
        </section>
      </div>
    </div>
  );
}
