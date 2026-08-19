import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  AtSign,
  Ban,
  Copy,
  ExternalLink,
  Inbox,
  PackageOpen,
  RefreshCw,
  Search,
  ShoppingBag,
  Store,
} from "lucide-react";
import { api } from "../api.js";
import { Button, EmptyState, LoadingBlock, Modal, StatusBadge, useToast } from "../components.jsx";
import { copyText, formatDate } from "../utils.js";
import { indexPickupStatuses, pickupAccountState } from "./registration/pickup-model.js";

const saleFilters = [
  ["all", "全部"],
  ["unlisted", "可上架"],
  ["ready", "待销售"],
  ["sold", "已售出"],
  ["blocked", "ChatGPT 禁售"],
];

function inventoryState(inventory, email) {
  const state = pickupAccountState(inventory, email);
  if (state.item) return { ...state, key: state.item.status };
  if (!inventory.loaded) return { ...state, key: "loading" };
  if (inventory.error) return { ...state, key: "unknown" };
  return { ...state, key: "unlisted" };
}

function saleState(item, inventory) {
  if (!item.eligible) {
    return {
      key: "blocked",
      badge: item.chatgpt_registered ? "failed" : "warning",
      label: item.chatgpt_registered
        ? "ChatGPT 禁售"
        : item.mailcom_recycling_reserved ? "别名轮换中" : "源头未连接",
      item: null,
    };
  }
  return inventoryState(inventory, item.email);
}

function PickupCell({ inventory, item }) {
  const state = saleState(item, inventory);
  const pickup = inventory.byEmail?.[String(item.email || "").toLowerCase()] || null;
  const listedAt = pickup?.created_at || pickup?.updated_at;
  return <div className="sales-pickup-state">
    <StatusBadge status={state.badge}>{state.label}</StatusBadge>
    {item.eligible && pickup?.pickup_url && <a href={pickup.pickup_url} target="_blank" rel="noreferrer"><ExternalLink size={11} />打开取件</a>}
    {!item.eligible && <small>{item.blocked_reason}</small>}
    {item.eligible && listedAt && <small>{formatDate(listedAt)}</small>}
  </div>;
}

export default function SalesPage({ refreshKey, onNavigate }) {
  const [addresses, setAddresses] = useState([]);
  const [config, setConfig] = useState(null);
  const [inventory, setInventory] = useState({ loaded: false, byEmail: {}, error: "", adminUrl: "" });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState([]);
  const [publishing, setPublishing] = useState(false);
  const [deliveryResult, setDeliveryResult] = useState(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const [addressResult, configResult, statusResult] = await Promise.allSettled([
      api("/api/pickup/source-addresses"),
      api("/api/pickup/config"),
      api("/api/pickup/statuses"),
    ]);
    if (addressResult.status === "fulfilled") {
      setAddresses(Array.isArray(addressResult.value?.items) ? addressResult.value.items : []);
    } else {
      setLoadError(addressResult.reason?.message || "源头邮箱库存加载失败");
    }
    if (configResult.status === "fulfilled") setConfig(configResult.value);
    if (statusResult.status === "fulfilled") {
      setInventory({
        loaded: true,
        byEmail: indexPickupStatuses(statusResult.value?.items),
        error: "",
        adminUrl: statusResult.value?.admin_url || configResult.value?.admin_url || "",
      });
    } else {
      setInventory({
        loaded: true,
        byEmail: {},
        error: statusResult.reason?.message || "取件站状态加载失败",
        adminUrl: configResult.status === "fulfilled" ? configResult.value?.admin_url || "" : "",
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const counts = useMemo(() => {
    const result = { all: addresses.length, unlisted: 0, ready: 0, sold: 0, disabled: 0, blocked: 0, unknown: 0 };
    addresses.forEach((item) => {
      const key = saleState(item, inventory).key;
      result[key] = (result[key] || 0) + 1;
    });
    return result;
  }, [addresses, inventory]);

  const filteredAddresses = useMemo(() => {
    const term = query.trim().toLowerCase();
    return addresses.filter((item) => {
      const state = saleState(item, inventory);
      if (filter !== "all" && state.key !== filter) return false;
      if (!term) return true;
      return [item.email, item.label, item.purpose, item.type_label, item.source_email, item.source_provider]
        .some((value) => String(value || "").toLowerCase().includes(term));
    });
  }, [addresses, filter, inventory, query]);

  const visibleSelectableIds = filteredAddresses.filter((item) => item.eligible).map((item) => Number(item.id));
  const allVisibleSelected = Boolean(visibleSelectableIds.length)
    && visibleSelectableIds.every((id) => selectedIds.includes(id));
  const unlistedIds = inventory.error ? [] : addresses
    .filter((item) => item.eligible && inventoryState(inventory, item.email).key === "unlisted")
    .map((item) => Number(item.id));

  useEffect(() => {
    const eligible = new Set(addresses.filter((item) => item.eligible).map((item) => Number(item.id)));
    setSelectedIds((current) => current.filter((id) => eligible.has(id)));
  }, [addresses]);

  const toggleAllVisible = () => {
    if (allVisibleSelected) {
      const visible = new Set(visibleSelectableIds);
      setSelectedIds((current) => current.filter((id) => !visible.has(id)));
      return;
    }
    setSelectedIds((current) => [...new Set([...current, ...visibleSelectableIds])]);
  };

  const toggleAddress = (item) => {
    if (!item.eligible) return;
    const id = Number(item.id);
    setSelectedIds((current) => current.includes(id)
      ? current.filter((candidate) => candidate !== id)
      : [...current, id]);
  };

  const showDeliveryResult = async (result) => {
    setDeliveryResult(result);
    if (!result?.delivery_text) return;
    try {
      await copyText(result.delivery_text);
    } catch {
      toast("上货成功，取件内容请在结果窗口手动复制", "error");
    }
  };

  const publish = async (ids) => {
    const targets = [...new Set(ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (!targets.length) return toast("没有可上架的源头邮箱", "error");
    setPublishing(true);
    try {
      const result = await api("/api/pickup/import-addresses", { method: "POST", body: { ids: targets } });
      await showDeliveryResult(result);
      setSelectedIds((current) => current.filter((id) => !targets.includes(id)));
      await load();
      toast(`已上架 ${result.imported} 个源头邮箱，取件内容已复制`);
    } catch (error) {
      toast(error.message || "一键上货失败", "error");
    } finally {
      setPublishing(false);
    }
  };

  const copyDelivery = async () => {
    try {
      await copyText(deliveryResult?.delivery_text || "");
      toast("取件内容已复制");
    } catch {
      toast("复制失败，请手动复制", "error");
    }
  };

  if (loading && !addresses.length) return <div className="page-stack sales-page"><LoadingBlock rows={6} /></div>;

  return <div className="page-stack sales-page">
    <section className="metric-grid sales-metrics">
      <article className="metric-card"><span className="metric-icon blue"><Inbox size={19} /></span><div><span>导入邮箱</span><strong>{counts.all}</strong><small>源头邮箱中的别名库存</small></div></article>
      <article className="metric-card"><span className="metric-icon amber"><PackageOpen size={19} /></span><div><span>可上架</span><strong>{counts.unlisted}</strong><small>未注册 ChatGPT</small></div></article>
      <article className="metric-card"><span className="metric-icon green"><Store size={19} /></span><div><span>待销售</span><strong>{counts.ready}</strong><small>已生成买家取件链接</small></div></article>
      <article className="metric-card"><span className="metric-icon coral"><Ban size={19} /></span><div><span>ChatGPT 禁售</span><strong>{counts.blocked}</strong><small>注册成功或已占用</small></div></article>
    </section>

    <section className="panel sales-quick-panel">
      <div className="sales-quick-copy"><span><ShoppingBag size={21} /></span><div><h2>源头邮箱一键售卖</h2><p>库存只读取源头邮箱中导入或同步的邮箱别名；注册过 ChatGPT 或已被 ChatGPT 占用的邮箱会自动禁售。</p></div></div>
      <div className="sales-quick-actions">
        {inventory.adminUrl && <Button icon={ExternalLink} onClick={() => window.open(inventory.adminUrl, "_blank", "noopener,noreferrer")}>取件站后台</Button>}
        <Button icon={AtSign} onClick={() => onNavigate("sources")}>管理源头邮箱</Button>
        <Button variant="primary" icon={Store} loading={publishing} disabled={!unlistedIds.length || !config?.enabled} onClick={() => publish(unlistedIds)}>一键上架全部可售（{unlistedIds.length}）</Button>
      </div>
    </section>

    {loadError && <div className="inline-alert error sales-page-alert"><AlertTriangle size={16} /><span>{loadError}</span><Button size="sm" onClick={load}>重试</Button></div>}
    {inventory.error && <div className="inline-alert warning sales-page-alert"><AlertTriangle size={16} /><span>{inventory.error}；当前不会把未知状态误判为可上架。</span><Button size="sm" onClick={load}>重新连接</Button></div>}
    {config && !config.enabled && <div className="inline-alert warning sales-page-alert"><AlertTriangle size={16} /><span>取件站尚未完成服务配置，上货暂不可用。</span></div>}

    <section className="table-panel sales-inventory-panel">
      <header className="panel-header"><div><h2>源头邮箱售卖库存</h2><p>仅邮箱别名可售；ChatGPT 注册成功和“邮箱已注册”记录由后端强制拦截</p></div><Button icon={RefreshCw} loading={loading} onClick={load}>刷新库存</Button></header>
      <div className="sales-toolbar">
        <div className="sales-filter-tabs">
          {saleFilters.map(([value, label]) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}<b>{counts[value] || 0}</b></button>)}
        </div>
        <label className="search-box sales-search"><Search size={16} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索邮箱、来源或类型" /></label>
      </div>

      {addresses.length ? <>
        <div className="sales-selection-bar">
          <label><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} disabled={!visibleSelectableIds.length} /><span>全选当前可售邮箱</span></label>
          <span>已选 <b>{selectedIds.length}</b> 个</span>
          <Button size="sm" variant="primary" icon={Store} loading={publishing} disabled={!selectedIds.length || !config?.enabled} onClick={() => publish(selectedIds)}>上架所选</Button>
        </div>
        {filteredAddresses.length ? <>
          <div className="data-table-wrap"><table className="data-table sales-table"><thead><tr><th className="select-column" /><th>导入邮箱</th><th>邮箱类型</th><th>源头邮箱</th><th>ChatGPT</th><th>取件站状态</th><th>导入时间</th></tr></thead><tbody>{filteredAddresses.map((item) => {
            const checked = selectedIds.includes(Number(item.id));
            return <tr className={`${checked ? "selected-row" : ""}${!item.eligible ? " sales-blocked-row" : ""}`} key={item.id}>
              <td className="select-column"><input type="checkbox" checked={checked} disabled={!item.eligible} aria-label={`选择 ${item.email}`} onChange={() => toggleAddress(item)} /></td>
              <td><button className="sales-email-button" onClick={() => copyText(item.email).then(() => toast("邮箱已复制"))}><b>{item.email}</b><Copy size={13} /></button><small>{item.label || item.purpose || "源头邮箱导入"}</small></td>
              <td><div className="sales-account-type"><b>{item.type_label}</b><small>{item.strategy || "official"}</small></div></td>
              <td><div className="sales-source"><b>{item.source_email}</b><small>{item.source_provider}</small></div></td>
              <td><StatusBadge status={item.chatgpt_registered ? "failed" : "active"}>{item.chatgpt_registered ? "已注册 · 禁售" : "未注册"}</StatusBadge></td>
              <td><PickupCell inventory={inventory} item={item} /></td>
              <td><span className="muted-cell">{formatDate(item.created_at)}</span></td>
            </tr>;
          })}</tbody></table></div>
          <div className="sales-mobile-list">{filteredAddresses.map((item) => {
            const checked = selectedIds.includes(Number(item.id));
            const state = saleState(item, inventory);
            return <article className={`${checked ? "selected" : ""}${!item.eligible ? " blocked" : ""}`} key={item.id}>
              <header><input type="checkbox" checked={checked} disabled={!item.eligible} aria-label={`选择 ${item.email}`} onChange={() => toggleAddress(item)} /><StatusBadge status={state.badge}>{state.label}</StatusBadge></header>
              <button onClick={() => copyText(item.email).then(() => toast("邮箱已复制"))}>{item.email}<Copy size={13} /></button>
              <div className="sales-mobile-meta"><span><small>类型</small><b>{item.type_label}</b></span><span><small>源头邮箱</small><b>{item.source_email}</b></span></div>
              <footer><PickupCell inventory={inventory} item={item} /></footer>
            </article>;
          })}</div>
        </> : <EmptyState icon={Search} title="没有匹配的邮箱" description="请调整搜索词或库存状态筛选。" />}
      </> : <EmptyState icon={AtSign} title="还没有导入邮箱" description="请先在源头邮箱中登记邮箱别名、隐藏邮箱或自定义域名邮箱。" action={<Button icon={AtSign} onClick={() => onNavigate("sources")}>管理源头邮箱</Button>} />}
    </section>

    <Modal
      open={Boolean(deliveryResult)}
      onClose={() => setDeliveryResult(null)}
      title="源头邮箱上货完成"
      description={`已生成 ${deliveryResult?.imported || 0} 个取件卡，发货内容已自动复制`}
      size="lg"
      footer={<>
        {deliveryResult?.admin_url && <Button icon={ExternalLink} onClick={() => window.open(deliveryResult.admin_url, "_blank", "noopener,noreferrer")}>打开取件站后台</Button>}
        <Button variant="primary" icon={Copy} onClick={copyDelivery}>复制全部取件内容</Button>
      </>}
    >
      <div className="sales-delivery-result"><textarea readOnly rows="12" value={deliveryResult?.delivery_text || ""} /></div>
    </Modal>
  </div>;
}
