import { useEffect, useMemo, useState } from "react";
import { Bell, BookOpen, Inbox, KeyRound, LayoutDashboard, LogOut, Mail, Menu, Moon, Plus, Settings, Sun, UserPlus, WandSparkles, X } from "lucide-react";
import { api } from "./api.js";
import { Button, IconButton, LoadingBlock, ProviderMark, useToast } from "./components.jsx";
import OverviewPage from "./pages/Overview.jsx";
import SourcesPage from "./pages/Sources.jsx";
import FactoryPage from "./pages/Factory.jsx";
import RegistrationPage from "./pages/Registration.jsx";
import InboxPage from "./pages/Inbox.jsx";
import CodesPage from "./pages/Codes.jsx";
import AddressesPage from "./pages/Addresses.jsx";
import SettingsPage from "./pages/Settings.jsx";

const pages = {
  overview: { label: "总览", subtitle: "源头邮箱与任务状态", icon: LayoutDashboard },
  sources: { label: "源头邮箱", subtitle: "Microsoft 与 Google 邮箱", icon: Mail },
  factory: { label: "别名工厂", subtitle: "官方别名与 Plus 分裂地址", icon: WandSparkles },
  registration: { label: "注册", subtitle: "邮箱注册，不接入手机号", icon: UserPlus },
  inbox: { label: "邮件中心", subtitle: "集中接收所有绑定邮箱的邮件", icon: Inbox },
  codes: { label: "验证码中心", subtitle: "集中查看所有源头号的验证码", icon: KeyRound },
  addresses: { label: "地址仓库", subtitle: "全部基础地址和分裂地址", icon: BookOpen },
  settings: { label: "系统设置", subtitle: "服务与数据配置", icon: Settings },
};

function LoginPage({ onAuthenticated }) {
  const [form, setForm] = useState({ username: "admin", password: "" });
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const submit = async (event) => {
    event.preventDefault();
    setLoading(true);
    try {
      await api("/api/auth/login", { method: "POST", body: form });
      onAuthenticated();
    } catch (error) { toast(error.message, "error"); } finally { setLoading(false); }
  };
  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-brand"><img src={`${import.meta.env.BASE_URL}aliashub-mark.svg`} alt="" /><div><strong>AliasHub</strong><span>多邮箱别名中枢</span></div></div>
        <div className="login-heading"><h1>登录管理台</h1><p>访问源头邮箱、别名和验证码</p></div>
        <form onSubmit={submit} className="form-stack">
          <label className="form-field"><span className="field-label">管理员账号</span><input autoComplete="username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></label>
          <label className="form-field"><span className="field-label">密码</span><input type="password" autoComplete="current-password" autoFocus value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
          <Button variant="primary" size="lg" loading={loading} type="submit">进入管理台</Button>
        </form>
      </section>
    </main>
  );
}

export default function App() {
  const [auth, setAuth] = useState(null);
  const [page, setPage] = useState(() => window.location.hash.replace("#", "") || "overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("aliashub-theme") || "light");
  const [overview, setOverview] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [routeState, setRouteState] = useState({});
  const [factoryMounted, setFactoryMounted] = useState(() => page === "factory");
  const [factoryRouteState, setFactoryRouteState] = useState({ navigationKey: 0 });
  const toast = useToast();

  const checkAuth = async () => {
    try { setAuth(await api("/api/auth/status")); } catch { setAuth({ authenticated: false, authEnabled: true }); }
  };
  useEffect(() => { checkAuth(); }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("aliashub-theme", theme);
  }, [theme]);
  useEffect(() => {
    if (!auth?.authenticated) return undefined;
    const load = () => api("/api/overview").then(setOverview).catch(() => {});
    load();
    const timer = window.setInterval(load, 20_000);
    return () => window.clearInterval(timer);
  }, [auth?.authenticated, refreshKey]);
  useEffect(() => {
    const onHash = () => {
      const target = window.location.hash.replace("#", "");
      if (!pages[target]) return;
      if (target === "factory") setFactoryMounted(true);
      setPage(target);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (target, state = {}) => {
    if (target === "factory") {
      setFactoryMounted(true);
      setFactoryRouteState((current) => ({ ...state, navigationKey: current.navigationKey + 1 }));
    }
    setPage(target); setRouteState(state); setMobileNav(false); window.location.hash = target;
  };
  const changed = () => setRefreshKey((value) => value + 1);
  const logout = async () => { await api("/api/auth/logout", { method: "POST" }); setAuth({ authenticated: false, authEnabled: true }); };
  const content = useMemo(() => {
    const props = { refreshKey, onDataChange: changed, onNavigate: navigate };
    if (page === "sources") return <SourcesPage {...props} addOpen={addAccountOpen} setAddOpen={setAddAccountOpen} />;
    if (page === "factory") return null;
    if (page === "registration") return <RegistrationPage {...props} />;
    if (page === "inbox") return <InboxPage {...props} initialAccountId={routeState.accountId} />;
    if (page === "codes") return <CodesPage {...props} initialAccountId={routeState.accountId} />;
    if (page === "addresses") return <AddressesPage {...props} initialAccountId={routeState.accountId} />;
    if (page === "settings") return <SettingsPage {...props} />;
    return <OverviewPage {...props} overview={overview} onAddAccount={() => { navigate("sources"); setAddAccountOpen(true); }} />;
  }, [page, refreshKey, routeState, overview, addAccountOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!auth) return <div className="boot-screen"><img src={`${import.meta.env.BASE_URL}aliashub-mark.svg`} alt="AliasHub" /><LoadingBlock rows={2} /></div>;
  if (!auth.authenticated) return <LoginPage onAuthenticated={checkAuth} />;
  const current = pages[page] || pages.overview;
  const unusedCodes = overview?.metrics?.unusedCodes || 0;
  const actionRequired = overview?.metrics?.actionRequired || 0;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <div className="sidebar-brand"><img src={`${import.meta.env.BASE_URL}aliashub-mark.svg`} alt="" /><div><strong>AliasHub</strong><span>邮箱别名中枢</span></div><IconButton className="sidebar-close" icon={X} label="关闭菜单" onClick={() => setMobileNav(false)} /></div>
        <nav className="sidebar-nav" aria-label="主导航">
          {Object.entries(pages).map(([key, item]) => {
            const Icon = item.icon;
            const badge = key === "codes" ? unusedCodes : key === "sources" ? actionRequired : 0;
            return <button key={key} className={page === key ? "active" : ""} onClick={() => navigate(key)}><Icon size={18} /><span>{item.label}</span>{badge > 0 && <b>{badge}</b>}</button>;
          })}
        </nav>
        <div className="sidebar-provider"><span className="provider-mark-pair"><ProviderMark provider="microsoft" size={25} /><ProviderMark provider="google" size={25} /></span><span className="sidebar-provider-copy"><b>Microsoft + Google</b><small>Outlook · Gmail · Workspace</small></span><i className="online-dot" /></div>
        <div className="sidebar-footer">{auth.authEnabled && <button onClick={logout}><LogOut size={17} /><span>退出管理台</span></button>}<span className="version">v1.0</span></div>
      </aside>
      {mobileNav && <button className="sidebar-overlay" aria-label="关闭菜单" onClick={() => setMobileNav(false)} />}

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-title"><IconButton className="mobile-menu" icon={Menu} label="打开菜单" onClick={() => setMobileNav(true)} /><div><h1>{current.label}</h1><p>{current.subtitle}</p></div></div>
          <div className="topbar-actions">
            <IconButton icon={theme === "light" ? Moon : Sun} label={theme === "light" ? "切换暗色" : "切换亮色"} onClick={() => setTheme(theme === "light" ? "dark" : "light")} />
            <button className="notification-button" title="待处理状态" onClick={() => navigate(unusedCodes ? "codes" : "sources")}><Bell size={18} />{unusedCodes + actionRequired > 0 && <span>{unusedCodes + actionRequired}</span>}</button>
            <Button variant="primary" icon={Plus} onClick={() => { navigate("sources"); setAddAccountOpen(true); }}>添加源头邮箱</Button>
          </div>
        </header>
        <div className={`page-content page-${page}`}>
          {page !== "factory" && content}
          {factoryMounted && <div className="cached-page" hidden={page !== "factory"}><FactoryPage {...{ refreshKey, onDataChange: changed, onNavigate: navigate }} active={page === "factory"} initialAccountId={factoryRouteState.accountId} initialMode={factoryRouteState.mode} navigationKey={factoryRouteState.navigationKey} /></div>}
        </div>
      </main>
      <nav className="mobile-bottom-nav">
        {Object.entries(pages).slice(0, 5).map(([key, item]) => { const Icon = item.icon; return <button key={key} className={page === key ? "active" : ""} onClick={() => navigate(key)}><Icon size={19} /><span>{item.label}</span></button>; })}
      </nav>
    </div>
  );
}
