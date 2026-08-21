import { Activity, ArrowRight, AtSign, Clock3, KeyRound, Mail, Plus, ShieldCheck, Sparkles, WandSparkles } from "lucide-react";
import { Button, EmptyState, LoadingBlock, ProviderMark, StatusBadge } from "../components.jsx";
import { accountSupportsOfficialAliases, accountSupportsPlusAliases, providerMeta } from "../providers.js";
import { accountStatus, jobStatus, relativeTime } from "../utils.js";

const activityIcons = { account: Mail, alias: AtSign, split: WandSparkles, code: KeyRound };

export default function OverviewPage({ overview, onNavigate, onAddAccount }) {
  if (!overview) return <div className="page-stack"><LoadingBlock rows={8} /></div>;
  const metrics = overview.metrics;
  return (
    <div className="page-stack overview-page">
      <div className="context-bar">
        <div className="context-copy"><span className="live-dot" />后台任务服务正常</div>
        <div className="context-actions"><Button icon={WandSparkles} onClick={() => onNavigate("factory")}>进入别名工厂</Button><Button variant="primary" icon={Plus} onClick={onAddAccount}>添加源头邮箱</Button></div>
      </div>
      <section className="metric-grid">
        <article className="metric-card"><span className="metric-icon blue"><Mail size={19} /></span><div><span>源头邮箱</span><strong>{metrics.accounts}</strong><small>{metrics.connectedAccounts} 个已连接</small></div></article>
        <article className="metric-card"><span className="metric-icon green"><AtSign size={19} /></span><div><span>官方邮箱别名</span><strong>{metrics.officialAliases}</strong><small>不含源头地址</small></div></article>
        <article className="metric-card"><span className="metric-icon amber"><Sparkles size={19} /></span><div><span>分裂地址</span><strong>{metrics.splitAddresses}</strong><small>可持续批量生成</small></div></article>
        <article className="metric-card"><span className="metric-icon coral"><KeyRound size={19} /></span><div><span>未使用验证码</span><strong>{metrics.unusedCodes}</strong><small>累计识别 {metrics.codes} 条</small></div></article>
      </section>

      <section className="overview-main-grid">
        <article className="panel accounts-summary-panel">
          <header className="panel-header"><div><h2>源头邮箱</h2><p>最近连接和同步状态</p></div><Button size="sm" icon={ArrowRight} onClick={() => onNavigate("sources")}>全部账号</Button></header>
          {overview.recentAccounts.length ? <div className="source-summary-list">{overview.recentAccounts.map((account) => {
            const supportsOfficial = accountSupportsOfficialAliases(account);
            const supportsPlus = accountSupportsPlusAliases(account);
            const meta = providerMeta(account.provider);
            const isMailcom = meta.id === "mailcom";
            const isNetease = meta.id === "netease";
            const canGenerateAliases = supportsOfficial || supportsPlus;
            return <button key={account.id} className="source-summary-row" onClick={() => onNavigate(isMailcom ? "sources" : canGenerateAliases ? "factory" : "inbox", { accountId: account.id, mode: supportsOfficial ? undefined : "split" })}>
              <ProviderMark provider={meta.id} size={34} />
              <span className="source-summary-copy"><b>{account.display_name || account.email.split("@")[0]}</b><small>{meta.name} · {account.email}</small></span>
              <span className="source-alias-mini"><b>{isMailcom ? account.official_used || 1 : isNetease ? account.netease_aliases || 0 : supportsOfficial ? `${account.official_used}/${account.official_limit}` : supportsPlus ? "Plus" : "IMAP"}</b><small>{isMailcom ? "当前地址" : isNetease ? "替身邮箱" : supportsOfficial ? "基础地址" : supportsPlus ? "分裂可用" : "收件扫描"}</small></span>
              <span className="source-alias-mini"><b>{isMailcom ? account.mailcom_aliases ?? account.official_aliases ?? 0 : isNetease ? (account.netease_aliases || 0) + 1 : supportsPlus ? account.split_count : "-"}</b><small>{isMailcom ? "官方别名" : isNetease ? "可直接注册" : supportsPlus ? "分裂" : "只读"}</small></span>
              <StatusBadge status={account.status}>{accountStatus[account.status]}</StatusBadge>
            </button>;
          })}</div> : <EmptyState icon={Mail} title="还没有源头邮箱" action={<Button variant="primary" icon={Plus} onClick={onAddAccount}>添加第一个邮箱</Button>} />}
        </article>

        <article className="panel task-panel">
          <header className="panel-header"><div><h2>自动任务</h2><p>Microsoft 官方别名与邮箱扫描</p></div></header>
          {overview.activeJobs.length ? <div className="task-list">{overview.activeJobs.map((job) => {
            const progress = job.progress_target ? Math.round(job.progress_current / job.progress_target * 100) : job.status === "running" ? 45 : 0;
            return <div className="task-row" key={job.id}><span className={`task-symbol task-${job.status}`}>{job.type === "official_fill" ? <AtSign size={16} /> : <KeyRound size={16} />}</span><span className="task-copy"><b>{job.type === "official_fill" ? "官方别名生成" : "验证码扫描"}</b><small>{job.source_email}</small><span className="task-progress"><i style={{ width: `${progress}%` }} /></span></span><span><StatusBadge status={job.status}>{jobStatus[job.status]}</StatusBadge><small>{job.message}</small></span></div>;
          })}</div> : <EmptyState icon={ShieldCheck} title="没有待处理任务" description="所有任务已执行完毕。" />}
        </article>
      </section>

      <section className="overview-bottom-grid">
        <article className="panel codes-preview-panel">
          <header className="panel-header"><div><h2>最近验证码</h2><p>来自所有源头邮箱</p></div><Button size="sm" icon={ArrowRight} onClick={() => onNavigate("codes")}>验证码中心</Button></header>
          {overview.recentCodes.length ? <div className="code-preview-list">{overview.recentCodes.map((item) => <button key={item.id} onClick={() => onNavigate("codes", { accountId: item.account_id })}><span className="code-digits">{item.code}</span><span><b>{item.sender}</b><small>{item.address || item.source_email}</small></span><time>{relativeTime(item.received_at)}</time></button>)}</div> : <EmptyState icon={KeyRound} title="还没有验证码" />}
        </article>
        <article className="panel activity-panel">
          <header className="panel-header"><div><h2>最近动态</h2><p>账号和地址操作记录</p></div></header>
          <div className="activity-list">{overview.activity.map((item) => { const Icon = activityIcons[item.type] || Activity; return <div className="activity-row" key={item.id}><span className={`activity-icon activity-${item.type}`}><Icon size={15} /></span><span><b>{item.title}</b><small>{item.detail || item.source_email}</small></span><time>{relativeTime(item.created_at)}</time></div>; })}</div>
        </article>
      </section>
    </div>
  );
}
