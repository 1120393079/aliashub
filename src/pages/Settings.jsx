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
  const [savingGoogleOAuth, setSavingGoogleOAuth] = useState(false);
  const [savingNfapi, setSavingNfapi] = useState(false);
  const [testingNfapi, setTestingNfapi] = useState(false);
  const toast = useToast();

  const load = async () => {
    try {
      const [settings, status, nfapiConfig] = await Promise.all([api("/api/settings"), api("/api/health"), api("/api/nfapi/config")]);
      setForm({
        ...settings,
        google_oauth_client_secret: "",
        google_oauth_saved_client_id: settings.google_oauth_client_id || "",
      });
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
      toast("SUB2 兼容服务连接配置已保存");
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
      toast(result.message || "SUB2 兼容服务连接正常");
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

  const saveGoogleOAuth = async () => {
    const clientId = String(form.google_oauth_client_id || "").trim();
    const clientSecret = String(form.google_oauth_client_secret || "").trim();
    const clientIdChanged = clientId !== String(form.google_oauth_saved_client_id || "").trim();
    if (!clientId || (!clientSecret && (!form.google_oauth_client_secret_configured || clientIdChanged))) {
      toast("Google OAuth 必须填写自己的 Client ID 和对应的 Client Secret", "error");
      return;
    }
    setSavingGoogleOAuth(true);
    try {
      await api("/api/settings", {
        method: "PATCH",
        body: {
          google_oauth_client_id: clientId,
          ...(clientSecret ? { google_oauth_client_secret: clientSecret } : {}),
        },
      });
      await load();
      toast("Google OAuth 客户端配置已保存");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setSavingGoogleOAuth(false);
    }
  };

  if (!form || !nfapi) return <div className="page-stack"><LoadingBlock rows={7} /></div>;

  return (
    <div className="settings-layout">
      <aside className="settings-index"><a href="#general"><Mail size={16} />基本设置</a><a href="#nfapi"><Cable size={16} />SUB2 兼容服务</a><a href="#security"><ShieldCheck size={16} />OAuth 安全</a><a href="#connector"><Puzzle size={16} />官网扩展</a><a href="#runtime"><Server size={16} />运行状态</a></aside>
      <div className="settings-content">
        <section id="general" className="settings-section">
          <header><span><Mail size={19} /></span><div><h2>基本设置</h2><p>管理台与验证码数据配置</p></div></header>
          <div className="settings-form"><FormField label="站点名称"><input value={form.site_name} onChange={(event) => setForm({ ...form, site_name: event.target.value })} /></FormField><FormField label="验证码保留天数"><input type="number" min="1" max="365" value={form.code_retention_days} onChange={(event) => setForm({ ...form, code_retention_days: event.target.value })} /></FormField><Button variant="primary" icon={Save} loading={saving} onClick={save}>保存设置</Button></div>
        </section>

        <section id="nfapi" className="settings-section">
          <header><span><Cable size={19} /></span><div><h2>SUB2 兼容服务（可选）</h2><p>可选连接兼容 SUB2 管理 API 的账号调度服务；未配置不影响邮箱与注册功能</p></div><StatusBadge status={nfapi.connected ? "active" : "inactive"}>{nfapi.connected ? "已连接" : "可选 · 未连接"}</StatusBadge></header>
          <div className="settings-form">
            <div className="nfapi-connection-state"><Server size={17} /><span><b>{nfapi.connected ? "SUB2 API 可用" : "SUB2 服务未连接（可选）"}</b><small>{nfapi.api_key_configured ? "管理员 API Key 已加密保存" : "无需使用 SUB2 导入时可保持未配置"}</small></span><StatusBadge status={nfapi.api_key_configured ? "active" : "inactive"}>{nfapi.api_key_configured ? "Key 已配置" : "可选配置"}</StatusBadge></div>
            <FormField label="SUB2 服务地址" hint="填写 SUB2 兼容服务管理 API 的基础地址，例如 https://sub2.example.com"><input type="url" value={nfapi.base_url || ""} onChange={(event) => setNfapi({ ...nfapi, base_url: event.target.value, connected: false })} placeholder="https://sub2.example.com" /></FormField>
            <FormField label="管理员 API Key" hint={nfapi.api_key_configured ? "已配置；留空保存会保留原 Key，输入新值才会替换。" : "只发送到本站后端加密保存，页面不会回显。"}><input type="password" autoComplete="new-password" value={nfapi.admin_api_key} onChange={(event) => setNfapi({ ...nfapi, admin_api_key: event.target.value, connected: false })} placeholder={nfapi.api_key_configured ? "留空保留现有 Key" : "输入管理员 API Key"} /></FormField>
            <div className="nfapi-connection-actions"><Button icon={Cable} loading={testingNfapi} disabled={savingNfapi || !nfapi.base_url || !nfapi.api_key_configured} onClick={testNfapi}>测试已保存连接</Button><Button variant="primary" icon={Save} loading={savingNfapi} disabled={testingNfapi || !nfapi.base_url || (!nfapi.api_key_configured && !nfapi.admin_api_key.trim())} onClick={saveNfapi}>保存连接</Button></div>
          </div>
        </section>

        <section id="security" className="settings-section">
          <header><span><LockKeyhole size={19} /></span><div><h2>邮箱连接安全</h2><p>Microsoft、Google OAuth 与 iCloud IMAP 凭据存储</p></div></header>
          <div className="security-list">
            <div><ShieldCheck size={17} /><span><b>Microsoft Authorization Code + PKCE</b><small>{form.microsoft_oauth_client}</small></span><StatusBadge status="active">已启用</StatusBadge></div>
            <div><KeyRound size={17} /><span><b>邮箱连接凭据</b><small>OAuth Refresh Token 与 iCloud App 专用密码均使用 AES-256-GCM 加密保存</small></span><StatusBadge status="active">已加密</StatusBadge></div>
            <div><Database size={17} /><span><b>邮件读取权限</b><small>Microsoft Graph Mail.Read · Google Gmail readonly · iCloud IMAP readonly</small></span><StatusBadge status="active">只读</StatusBadge></div>
          </div>
          <div className="settings-form">
            <div className="oauth-config-status"><span><b>{form.google_oauth_configured ? "Google OAuth 客户端已配置" : "Google OAuth 客户端未配置"}</b><small>{form.google_oauth_configured ? "使用你自己的 Google OAuth Client ID 和 Client Secret" : "绑定 Gmail 或 Google Workspace 前，必须填写自己的 Client ID 和 Client Secret"}</small></span><StatusBadge status={form.google_oauth_configured ? "active" : "warning"}>{form.google_oauth_configured ? "可授权" : "必须配置"}</StatusBadge></div>
            <FormField label="Google OAuth Client ID" hint="填写你在 Google Cloud Console 创建的 OAuth 客户端 ID"><input value={form.google_oauth_client_id || ""} onChange={(event) => setForm({ ...form, google_oauth_client_id: event.target.value, google_oauth_configured: false })} placeholder="xxxx.apps.googleusercontent.com" autoComplete="off" /></FormField>
            <FormField label="Google OAuth Client Secret" hint={form.google_oauth_client_secret_configured ? "已加密保存；Client ID 不变时留空可保留，修改 Client ID 时必须填写新 Secret。" : "必须填写与 Client ID 对应的 Client Secret；只发送到本站后端加密保存。"}><input type="password" value={form.google_oauth_client_secret || ""} onChange={(event) => setForm({ ...form, google_oauth_client_secret: event.target.value, google_oauth_configured: false })} placeholder={form.google_oauth_client_secret_configured ? "留空保留现有 Secret" : "输入 Client Secret"} autoComplete="new-password" /></FormField>
            <FormField label="Google OAuth 回调地址" hint="请将此地址配置到 Google OAuth 客户端允许的重定向 URI"><div className="copy-input"><input readOnly value={form.google_oauth_redirect_uri || ""} /><Button icon={Copy} onClick={() => copyText(form.google_oauth_redirect_uri).then(() => toast("Google OAuth 回调地址已复制"))}>复制</Button></div></FormField>
            <Button variant="primary" icon={Save} loading={savingGoogleOAuth} onClick={saveGoogleOAuth}>保存 Google OAuth 配置</Button>
          </div>
        </section>

        <section id="connector" className="settings-section">
          <header><span><Puzzle size={19} /></span><div><h2>Microsoft 官网扩展</h2><p>仅用于在本地浏览器操作 Microsoft 官方别名页面</p></div></header>
          <div className="settings-form"><FormField label="扩展配对密钥"><div className="copy-input"><input readOnly value={form.extension_api_key || ""} /><Button icon={Copy} onClick={() => copyText(form.extension_api_key).then(() => toast("扩展配对密钥已复制"))}>复制</Button></div></FormField><Button variant="primary" icon={Download} onClick={() => { window.location.href = appUrl(form.extension_download); }}>下载 AliasHub 扩展</Button></div>
        </section>

        <section id="runtime" className="settings-section">
          <header><span><Server size={19} /></span><div><h2>运行状态</h2><p>生产服务与支持范围</p></div></header>
          <dl className="runtime-grid"><div><dt>API 服务</dt><dd><span className="live-dot" />{health?.status === "ok" ? "运行正常" : "未知"}</dd></div><div><dt>源头邮箱</dt><dd>{health?.accounts || 0} 个</dd></div><div><dt>邮箱提供商</dt><dd>Microsoft · Google · iCloud</dd></div><div><dt>Microsoft 域名</dt><dd>{(form.supported_domains || []).join(" · ")}</dd></div><div><dt>服务地址</dt><dd>{form.public_base_url}</dd></div><div><dt>Google OAuth</dt><dd>{form.google_oauth_configured ? "自有客户端已配置" : "必须配置 Client ID + Secret"}</dd></div><div><dt>iCloud IMAP</dt><dd>{form.icloud_imap?.host || "imap.mail.me.com"}:{form.icloud_imap?.port || 993} · TLS</dd></div></dl>
          <a className="official-doc-link" href="https://support.microsoft.com/en-us/outlook/add-or-remove-an-email-alias-in-outlook-com" target="_blank" rel="noreferrer"><ExternalLink size={15} />Microsoft 官方别名规则</a>
        </section>
      </div>
    </div>
  );
}
