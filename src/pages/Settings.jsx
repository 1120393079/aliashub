import { useEffect, useState } from "react";
import { Cable, Copy, Database, Download, ExternalLink, KeyRound, LockKeyhole, Mail, Puzzle, Save, Server, ShieldCheck, Smartphone } from "lucide-react";
import { api, appUrl } from "../api.js";
import { Button, FormField, LoadingBlock, StatusBadge, useToast } from "../components.jsx";
import { copyText } from "../utils.js";

const EMPTY_INVENTORY_CONFIG = {
  cards_url: "https://nvtokens.com/api/inventory/cards/import",
  mailboxes_url: "https://nvtokens.com/api/inventory/mailboxes/import",
  pool_url: "https://nvtokens.com/api/inventory/cards/pool",
  api_key_configured: false,
  encryption_ready: false,
  connected: false,
  endpoints_locked: true,
  custom_endpoints_enabled: false,
  api_key: "",
};

export default function SettingsPage({ initialSection = "" }) {
  const [form, setForm] = useState(null);
  const [health, setHealth] = useState(null);
  const [nfapi, setNfapi] = useState(null);
  const [heroSms, setHeroSms] = useState(null);
  const [inventory, setInventory] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savingNfapi, setSavingNfapi] = useState(false);
  const [testingNfapi, setTestingNfapi] = useState(false);
  const [savingHeroSms, setSavingHeroSms] = useState(false);
  const [testingHeroSms, setTestingHeroSms] = useState(false);
  const [savingInventory, setSavingInventory] = useState(false);
  const [testingInventory, setTestingInventory] = useState(false);
  const [clearingInventory, setClearingInventory] = useState(false);
  const [activeSection, setActiveSection] = useState(initialSection || "general");
  const toast = useToast();

  const load = async () => {
    try {
      const [settings, status, nfapiConfig, heroSmsConfig, inventoryConfig] = await Promise.all([
        api("/api/settings"),
        api("/api/health"),
        api("/api/nfapi/config"),
        api("/api/registration/payment-agreements/settings").catch((error) => ({
          configured: false,
          api_key_configured: false,
          encryption_ready: false,
          load_error: error.message || "HeroSMS 配置读取失败",
        })),
        api("/api/inventory/config").catch((error) => ({
          ...EMPTY_INVENTORY_CONFIG,
          load_error: error.message || "nvtokens 配置读取失败",
        })),
      ]);
      setForm(settings);
      setHealth(status);
      setNfapi({ ...nfapiConfig, admin_api_key: "" });
      setHeroSms({ ...heroSmsConfig, api_key: "" });
      setInventory({ ...EMPTY_INVENTORY_CONFIG, ...inventoryConfig, api_key: "" });
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

  const saveHeroSms = async () => {
    setSavingHeroSms(true);
    try {
      const apiKey = heroSms.api_key.trim();
      const result = await api("/api/registration/payment-agreements/settings", {
        method: "PUT",
        body: {
          ...(apiKey ? { api_key: apiKey } : {}),
          max_price: Number(heroSms.max_price),
          change_retries: Number(heroSms.change_retries),
          wait_seconds: Number(heroSms.wait_seconds),
        },
      });
      setHeroSms({ ...result, api_key: "" });
      toast("HeroSMS 接码配置已保存");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setSavingHeroSms(false);
    }
  };

  const testHeroSms = async () => {
    setTestingHeroSms(true);
    try {
      const result = await api("/api/registration/payment-agreements/test", { method: "POST" });
      toast(`HeroSMS 连接正常，当前余额 ${result.balance}`);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setTestingHeroSms(false);
    }
  };

  const saveInventory = async () => {
    setSavingInventory(true);
    try {
      const apiKey = inventory.api_key.trim();
      const result = await api("/api/inventory/config", {
        method: "PATCH",
        body: apiKey ? { api_key: apiKey } : {},
      });
      setInventory({ ...EMPTY_INVENTORY_CONFIG, ...result, api_key: "" });
      toast("nvtokens 配置已保存");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setSavingInventory(false);
    }
  };

  const testInventory = async () => {
    setTestingInventory(true);
    try {
      const result = await api("/api/inventory/test", { method: "POST" });
      setInventory((current) => ({ ...current, connected: result.connected !== false, last_connected_at: result.last_connected_at }));
      toast(result.message || "nvtokens 连接正常");
    } catch (error) {
      setInventory((current) => ({ ...current, connected: false }));
      toast(error.message, "error");
    } finally {
      setTestingInventory(false);
    }
  };

  const clearInventory = async () => {
    if (!window.confirm("清除当前 nvtokens API Key？清除后库存 API 不会再发起请求。")) return;
    setClearingInventory(true);
    try {
      const result = await api("/api/inventory/config", { method: "PATCH", body: { clear_api_key: true } });
      setInventory({ ...EMPTY_INVENTORY_CONFIG, ...result, api_key: "" });
      toast("nvtokens API Key 已清除");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setClearingInventory(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!initialSection || !form || !heroSms || !inventory) return;
    setActiveSection(initialSection);
    window.requestAnimationFrame(() => document.getElementById(initialSection)?.scrollIntoView({ block: "start" }));
  }, [initialSection, form, heroSms, inventory]);

  const scrollSection = (section) => {
    setActiveSection(section);
    document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

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

  if (!form || !nfapi || !heroSms || !inventory) return <div className="page-stack"><LoadingBlock rows={8} /></div>;

  const heroMaxPrice = Number(heroSms.max_price);
  const heroRetries = Number(heroSms.change_retries);
  const heroWaitSeconds = Number(heroSms.wait_seconds);
  const heroSmsValid = heroSms.encryption_ready !== false
    && (heroSms.api_key_configured || heroSms.api_key.trim())
    && Number.isFinite(heroMaxPrice) && heroMaxPrice > 0 && heroMaxPrice <= 100
    && Number.isInteger(heroRetries) && heroRetries >= 0 && heroRetries <= 10
    && Number.isInteger(heroWaitSeconds) && heroWaitSeconds >= 30 && heroWaitSeconds <= 1800;

  return (
    <div className="settings-layout">
      <aside className="settings-index">
        <button type="button" className={activeSection === "general" ? "active" : ""} onClick={() => scrollSection("general")}><Mail size={16} />基本设置</button>
        <button type="button" className={activeSection === "nfapi" ? "active" : ""} onClick={() => scrollSection("nfapi")}><Cable size={16} />NFapi 连接</button>
        <button type="button" className={activeSection === "inventory" ? "active" : ""} onClick={() => scrollSection("inventory")}><Database size={16} />nvtokens 库存</button>
        <button type="button" className={activeSection === "herosms" ? "active" : ""} onClick={() => scrollSection("herosms")}><Smartphone size={16} />HeroSMS 接码</button>
        <button type="button" className={activeSection === "security" ? "active" : ""} onClick={() => scrollSection("security")}><ShieldCheck size={16} />邮箱连接安全</button>
        <button type="button" className={activeSection === "connector" ? "active" : ""} onClick={() => scrollSection("connector")}><Puzzle size={16} />官网扩展</button>
        <button type="button" className={activeSection === "runtime" ? "active" : ""} onClick={() => scrollSection("runtime")}><Server size={16} />运行状态</button>
      </aside>
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

        <section id="inventory" className="settings-section">
          <header><span><Database size={19} /></span><div><h2>nvtokens 库存</h2><p>统一配置库存 API；账号入库、邮箱凭证匹配和直接入池从业务页面发起</p></div><StatusBadge status={inventory.connected ? "active" : inventory.api_key_configured ? "warning" : "inactive"}>{inventory.connected ? "已连接" : inventory.api_key_configured ? "待测试" : "未配置"}</StatusBadge></header>
          <div className="settings-form">
            <div className="nfapi-connection-state"><Database size={17} /><span><b>{inventory.connected ? "nvtokens API 鉴权正常" : inventory.api_key_configured ? "API Key 已保存，等待连接测试" : "尚未配置 nvtokens API Key"}</b><small>{inventory.encryption_ready === false ? "服务器未配置 DATA_ENCRYPTION_KEY，暂不能保存 Key" : inventory.api_key_configured ? "Key 使用 AES-256-GCM 加密保存，页面不会回显" : "Key 只发送到本站后端并加密保存"}</small></span><StatusBadge status={inventory.api_key_configured ? "active" : "inactive"}>{inventory.api_key_configured ? "Key 已配置" : "缺少 Key"}</StatusBadge></div>
            {inventory.load_error && <div className="inline-alert error"><span>{inventory.load_error}</span></div>}
            <div className="inventory-settings-note"><Database size={15} /><span>服务端固定代理 nvtokens 的三个 HTTPS 接口；地址不可在浏览器修改。保存后可在「注册账号」或「验证码中心」打开库存 API 执行批量操作。</span></div>
            <div className="form-grid two">
              <FormField label="账号入库地址"><input type="url" value={inventory.cards_url || ""} readOnly /></FormField>
              <FormField label="邮箱凭证地址"><input type="url" value={inventory.mailboxes_url || ""} readOnly /></FormField>
              <FormField label="直接入池地址"><input type="url" value={inventory.pool_url || ""} readOnly /></FormField>
              <FormField label="nvtokens API Key" hint={inventory.api_key_configured ? "已配置；留空保存会保留原 Key，输入新值才会替换。" : "只发送到本站后端加密保存，页面不会回显。"}><input type="password" autoComplete="new-password" value={inventory.api_key} disabled={inventory.encryption_ready === false || savingInventory || clearingInventory} onChange={(event) => setInventory({ ...inventory, api_key: event.target.value, connected: false })} placeholder={inventory.encryption_ready === false ? "先配置 DATA_ENCRYPTION_KEY" : inventory.api_key_configured ? "留空保留现有 Key" : "粘贴 x-api-key"} /></FormField>
            </div>
            <div className="nfapi-connection-actions"><Button icon={Cable} loading={testingInventory} disabled={savingInventory || clearingInventory || !inventory.api_key_configured} onClick={testInventory}>测试连接</Button>{inventory.api_key_configured && <Button disabled={savingInventory || testingInventory || clearingInventory} onClick={clearInventory}>清除 Key</Button>}<Button variant="primary" icon={Save} loading={savingInventory} disabled={testingInventory || clearingInventory || inventory.encryption_ready === false} onClick={saveInventory}>保存 nvtokens 配置</Button></div>
          </div>
        </section>

        <section id="herosms" className="settings-section">
          <header><span><Smartphone size={19} /></span><div><h2>HeroSMS 接码</h2><p>同一把加密 Key 同时用于 PayPal 协议和 OpenAI 自动接码</p></div><StatusBadge status={heroSms.configured ? "active" : "inactive"}>{heroSms.configured ? "已配置" : "未配置"}</StatusBadge></header>
          <div className="settings-form">
            <div className="nfapi-connection-state"><Smartphone size={17} /><span><b>{heroSms.api_key_configured ? "HeroSMS API Key 已保存" : "等待配置 HeroSMS API Key"}</b><small>{heroSms.encryption_ready ? "API Key 使用 AES-256-GCM 加密保存；PayPal 使用 ts，OpenAI 使用 dr" : "服务器 DATA_ENCRYPTION_KEY 尚未配置"}</small></span><StatusBadge status={heroSms.api_key_configured ? "active" : "inactive"}>{heroSms.api_key_configured ? "Key 已配置" : "缺少 Key"}</StatusBadge></div>
            {(heroSms.load_error || heroSms.api_key_error) && <div className="inline-alert error"><span>{heroSms.load_error || heroSms.api_key_error}</span></div>}
            <FormField label="HeroSMS API Key" hint={heroSms.api_key_configured ? "已配置；留空保存会保留原 Key，输入新值才会替换。" : "从 HeroSMS API 页面复制；保存后不会在页面回显。"}><input type="password" autoComplete="new-password" value={heroSms.api_key} disabled={savingHeroSms} onChange={(event) => setHeroSms({ ...heroSms, api_key: event.target.value })} placeholder={heroSms.api_key_configured ? "留空保留现有 Key" : "输入 HeroSMS API Key"} /></FormField>
            <div className="form-grid three">
              <FormField label="PayPal 单号最高价格" hint="OpenAI 使用账号页弹窗中的独立上限；允许范围 0.01–100"><input type="number" min="0.01" max="100" step="0.01" value={heroSms.max_price ?? 1} disabled={savingHeroSms} onChange={(event) => setHeroSms({ ...heroSms, max_price: event.target.value })} /></FormField>
              <FormField label="PayPal 自动换号次数" hint="允许范围 0–10"><input type="number" min="0" max="10" step="1" value={heroSms.change_retries ?? 2} disabled={savingHeroSms} onChange={(event) => setHeroSms({ ...heroSms, change_retries: event.target.value })} /></FormField>
              <FormField label="PayPal 等码秒数" hint="允许范围 30–1800 秒"><input type="number" min="30" max="1800" step="1" value={heroSms.wait_seconds ?? 120} disabled={savingHeroSms} onChange={(event) => setHeroSms({ ...heroSms, wait_seconds: event.target.value })} /></FormField>
            </div>
            <div className="nfapi-connection-actions"><Button icon={Cable} loading={testingHeroSms} disabled={savingHeroSms || !heroSms.api_key_configured} onClick={testHeroSms}>测试已保存 Key</Button><Button variant="primary" icon={Save} loading={savingHeroSms} disabled={testingHeroSms || !heroSmsValid} onClick={saveHeroSms}>保存 HeroSMS 设置</Button></div>
          </div>
        </section>

        <section id="security" className="settings-section">
          <header><span><LockKeyhole size={19} /></span><div><h2>邮箱连接安全</h2><p>Microsoft、Google 公共客户端与 iCloud / mail.com / 网易邮箱凭据存储</p></div></header>
          <div className="security-list">
            <div><ShieldCheck size={17} /><span><b>Microsoft Authorization Code + PKCE</b><small>{form.microsoft_oauth_client}</small></span><StatusBadge status="active">已启用</StatusBadge></div>
            <div><ShieldCheck size={17} /><span><b>Google 内置公共客户端 + PKCE</b><small>Thunderbird 邮件公共客户端；注册工作站只执行 Gmail 邮件读取</small></span><StatusBadge status="active">已启用</StatusBadge></div>
            <div><KeyRound size={17} /><span><b>邮箱连接凭据</b><small>OAuth Refresh Token、iCloud App 专用密码、mail.com 登录密码与网易客户端授权码均使用 AES-256-GCM 加密保存</small></span><StatusBadge status="active">已加密</StatusBadge></div>
            <div><Database size={17} /><span><b>网易邮箱 IMAP</b><small>@163.com / @126.com / @yeah.net 母号；固定连接 imap.163.com:993 / imap.126.com:993 / imap.yeah.net:993 · TLS</small></span><StatusBadge status="active">已支持</StatusBadge></div>
            <div><Mail size={17} /><span><b>网易替身邮箱</b><small>替身邮箱固定使用 @aka.yeah.net，通过所属母号的 IMAP 邮箱读取邮件</small></span><StatusBadge status="active">已支持</StatusBadge></div>
            <div><Database size={17} /><span><b>邮件读取权限</b><small>Microsoft Graph Mail.Read · Google Gmail readonly · iCloud / mail.com / 网易邮箱 IMAP readonly</small></span><StatusBadge status="active">只读</StatusBadge></div>
          </div>
        </section>

        <section id="connector" className="settings-section">
          <header><span><Puzzle size={19} /></span><div><h2>Microsoft 官网扩展</h2><p>仅用于在本地浏览器操作 Microsoft 官方别名页面</p></div></header>
          <div className="settings-form"><FormField label="扩展配对密钥"><div className="copy-input"><input readOnly value={form.extension_api_key || ""} /><Button icon={Copy} onClick={() => copyText(form.extension_api_key).then(() => toast("扩展配对密钥已复制"))}>复制</Button></div></FormField><Button variant="primary" icon={Download} onClick={() => { window.location.href = appUrl(form.extension_download); }}>下载注册工作站扩展</Button></div>
        </section>

        <section id="runtime" className="settings-section">
          <header><span><Server size={19} /></span><div><h2>运行状态</h2><p>生产服务与支持范围</p></div></header>
          <dl className="runtime-grid"><div><dt>API 服务</dt><dd><span className="live-dot" />{health?.status === "ok" ? "运行正常" : "未知"}</dd></div><div><dt>源头邮箱</dt><dd>{health?.accounts || 0} 个</dd></div><div><dt>邮箱提供商</dt><dd>Microsoft · Google · iCloud · mail.com · 网易邮箱</dd></div><div><dt>Microsoft 域名</dt><dd>{(form.supported_domains || []).join(" · ")}</dd></div><div><dt>服务地址</dt><dd>{form.public_base_url}</dd></div><div><dt>Google OAuth</dt><dd>内置授权</dd></div><div><dt>iCloud IMAP</dt><dd>{form.icloud_imap?.host || "imap.mail.me.com"}:{form.icloud_imap?.port || 993} · TLS</dd></div><div><dt>mail.com IMAP</dt><dd>imap.mail.com:993 · TLS</dd></div><div><dt>网易邮箱域名</dt><dd>@163.com · @126.com · @yeah.net</dd></div><div><dt>网易替身域</dt><dd>@aka.yeah.net</dd></div><div><dt>网易 IMAP</dt><dd>imap.163.com:993 / imap.126.com:993 / imap.yeah.net:993 · TLS</dd></div></dl>
          <a className="official-doc-link" href="https://support.microsoft.com/en-us/outlook/add-or-remove-an-email-alias-in-outlook-com" target="_blank" rel="noreferrer"><ExternalLink size={15} />Microsoft 官方别名规则</a>
        </section>
      </div>
    </div>
  );
}
