import { useEffect, useState } from "react";
import { AtSign, Check, Copy, Download, Edit3, KeyRound, Link2, Mail, Search, Trash2, WandSparkles } from "lucide-react";
import { api, appUrl, queryString } from "../api.js";
import { Button, ConfirmDialog, EmptyState, FormField, IconButton, LoadingBlock, Modal, Pagination, ProviderMark, Segmented, StatusBadge, useToast } from "../components.jsx";
import {
  accountOptionLabel,
  accountSupportsImportedAliases,
  accountSupportsOfficialAliases,
  accountSupportsPlusAliases,
  providerMeta,
} from "../providers.js";
import { copyText, formatDate, kindText } from "../utils.js";

function EditAddressModal({ item, onClose, onSaved }) {
  const [form, setForm] = useState({ label: "", purpose: "", status: "active" });
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  useEffect(() => { if (item) setForm({ label: item.label, purpose: item.purpose, status: item.status }); }, [item]);
  const save = async () => {
    setSaving(true);
    try { await api(`/api/addresses/${item.id}`, { method: "PATCH", body: form }); toast("地址信息已保存"); onSaved(); onClose(); }
    catch (error) { toast(error.message, "error"); } finally { setSaving(false); }
  };
  return <Modal open={Boolean(item)} onClose={onClose} title="编辑地址" description={item?.address} footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" loading={saving} onClick={save}>保存</Button></>}><div className="form-stack"><FormField label="标签"><input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} /></FormField><FormField label="用途"><input value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })} /></FormField><FormField label="状态"><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="active">使用中</option><option value="disabled">已停用</option></select></FormField></div></Modal>;
}

export default function AddressesPage({ refreshKey, onDataChange, onNavigate, initialAccountId }) {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState(initialAccountId ? String(initialAccountId) : "all");
  const [kind, setKind] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState([]);
  const [deleteMode, setDeleteMode] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();
  const load = async () => {
    try {
      const [accountData, addressData] = await Promise.all([api("/api/accounts"), api(`/api/addresses${queryString({ accountId, kind, q: search, page, limit: 50 })}`)]);
      setAccounts(accountData.items); setData(addressData);
    } catch (error) { toast(error.message, "error"); }
  };
  useEffect(() => { if (initialAccountId) setAccountId(String(initialAccountId)); }, [initialAccountId]);
  useEffect(() => { const timer = window.setTimeout(load, 120); return () => window.clearTimeout(timer); }, [accountId, kind, search, page, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setPage(1), [accountId, kind, search]);
  useEffect(() => setSelected([]), [accountId, kind, search, page]);
  const selectedAccount = accounts.find((account) => account.id === Number(accountId));
  const supportsOfficial = accountId === "all" || accountSupportsOfficialAliases(selectedAccount);
  const supportsImported = accountId === "all" || accountSupportsImportedAliases(selectedAccount);
  const supportsAddressAliases = supportsOfficial || supportsImported;
  const canGenerate = accountId === "all"
    ? accounts.some((account) => accountSupportsOfficialAliases(account) || accountSupportsPlusAliases(account))
    : accountSupportsOfficialAliases(selectedAccount) || accountSupportsPlusAliases(selectedAccount);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const itemProvider = (item) => providerMeta(item.source_provider || accountById.get(item.account_id)?.provider);
  const isImportedIcloudAddress = (item) => itemProvider(item).id === "icloud"
    && ["icloud_mail_alias", "icloud_hide_my_email"].includes(item.strategy);
  const addressTypeLabel = (item) => item.strategy === "icloud_hide_my_email"
    ? "隐藏邮箱"
    : item.strategy === "icloud_mail_alias"
      ? "iCloud 邮箱别名"
      : kindText[item.kind];
  const canDeleteAddress = (item) => item.kind === "split" || isImportedIcloudAddress(item);
  const isRegistrationOccupied = (item) => {
    const value = item?.registration_occupied;
    const count = Number(value);
    return value === true || String(value).toLowerCase() === "true" || (Number.isFinite(count) && count > 0);
  };
  const kindItems = [{ value: "all", label: "全部" }, { value: "primary", label: "源头号" }, ...(supportsAddressAliases ? [{ value: "official", label: selectedAccount?.provider === "icloud" ? "iCloud 邮箱别名" : "官方别名" }] : []), { value: "split", label: "分裂地址" }];
  useEffect(() => { if (!supportsAddressAliases && kind === "official") setKind("all"); }, [supportsAddressAliases, kind]);
  const copy = async (address) => { await copyText(address); toast("地址已复制"); };
  const remove = async (item) => {
    try {
      if (isImportedIcloudAddress(item)) {
        await api(`/api/addresses/${item.id}`, { method: "DELETE" });
        toast("iCloud 本地别名映射已移除");
      } else {
        await api("/api/addresses/bulk-delete", { method: "POST", body: { ids: [item.id], accountId } });
        toast("分裂地址已删除");
      }
      load(); onDataChange();
    }
    catch (error) { toast(error.message, "error"); }
  };
  const toggle = (id) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const splitItems = data?.items.filter((item) => item.kind === "split") || [];
  const allPageSplitsSelected = splitItems.length > 0 && splitItems.every((item) => selected.includes(item.id));
  const togglePage = () => setSelected((current) => allPageSplitsSelected
    ? current.filter((id) => !splitItems.some((item) => item.id === id))
    : [...new Set([...current, ...splitItems.map((item) => item.id)])]);
  const bulkDelete = async () => {
    setDeleting(true);
    try {
      const result = await api("/api/addresses/bulk-delete", {
        method: "POST",
        body: deleteMode === "all" ? { mode: "all", accountId } : { ids: selected, accountId },
      });
      toast(result.deleted ? `已删除 ${result.deleted} 个分裂地址` : "没有需要删除的分裂地址");
      setSelected([]); setDeleteMode(null); await load(); onDataChange();
    } catch (error) { toast(error.message, "error"); } finally { setDeleting(false); }
  };
  const exportHref = appUrl(`/api/export/addresses.csv${queryString({ accountId, kind })}`);

  return (
    <div className="page-stack addresses-page">
      <div className="page-toolbar"><Segmented value={kind} onChange={setKind} ariaLabel="地址类型" items={kindItems} /><div className="toolbar-actions"><label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索邮箱地址、标签或用途" /></label><select className="compact-select" value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="all">全部源头邮箱</option>{accounts.map((account) => <option key={account.id} value={account.id}>{accountOptionLabel(account)}</option>)}</select><Button icon={Download} onClick={() => { window.location.href = exportHref; }}>导出 CSV</Button><Button variant="danger-ghost" icon={Trash2} onClick={() => setDeleteMode("all")}>清空分裂地址</Button></div></div>
      {selected.length > 0 && <div className="selection-bar"><span>已选择 <b>{selected.length}</b> 个分裂地址</span><Button variant="danger" size="sm" icon={Trash2} onClick={() => setDeleteMode("selected")}>删除所选</Button></div>}
      <section className="table-panel">
        {!data ? <LoadingBlock rows={8} /> : data.items.length ? <><div className="data-table-wrap"><table className="data-table address-table"><thead><tr><th className="select-column"><input type="checkbox" aria-label="选择当前页分裂地址" checked={allPageSplitsSelected} disabled={!splitItems.length} onChange={togglePage} /></th><th>邮箱地址</th><th>类型</th><th>基础地址</th><th>源头邮箱</th><th>标签 / 用途</th><th>创建时间</th><th aria-label="操作" /></tr></thead><tbody>{data.items.map((item) => <tr className={selected.includes(item.id) ? "selected-row" : ""} key={item.id}><td className="select-column">{item.kind === "split" && <input type="checkbox" aria-label={`选择 ${item.address}`} checked={selected.includes(item.id)} onChange={() => toggle(item.id)} />}</td><td><div className="address-main"><span className={`address-kind-icon kind-${item.kind}`}>{item.kind === "primary" ? <Mail size={15} /> : item.kind === "official" ? <AtSign size={15} /> : <WandSparkles size={15} />}</span><button onClick={() => copy(item.address)}>{item.address}</button>{isRegistrationOccupied(item) && <StatusBadge status="failed">注册占用</StatusBadge>}{item.status === "disabled" && <StatusBadge status="paused">已停用</StatusBadge>}</div></td><td><span className={`kind-label kind-label-${item.kind}`}>{addressTypeLabel(item)}</span></td><td><span className="base-link">{item.kind === "split" ? <><Link2 size={13} />{item.parent_address}</> : "自身"}</span></td><td><span className="provider-cell"><ProviderMark provider={itemProvider(item).id} size={20} /><span><b>{item.source_email}</b><small>{itemProvider(item).name}</small></span></span></td><td><div className="label-purpose"><b>{item.label || "未命名"}</b><small>{item.purpose || "暂无用途"}</small></div></td><td><span className="muted-cell">{formatDate(item.created_at)}</span></td><td><div className="row-actions"><IconButton icon={Copy} label="复制地址" size={30} onClick={() => copy(item.address)} /><IconButton icon={Edit3} label="编辑地址" size={30} onClick={() => setEditing(item)} />{canDeleteAddress(item) && <IconButton icon={Trash2} label={isImportedIcloudAddress(item) ? "移除本地 iCloud 映射" : "删除分裂地址"} size={30} onClick={() => remove(item)} />}</div></td></tr>)}</tbody></table></div><div className="mobile-address-list">{data.items.map((item) => <article className={selected.includes(item.id) ? "selected" : ""} key={item.id}><header><span className={`address-kind-icon kind-${item.kind}`}>{item.kind === "primary" ? <Mail size={15} /> : item.kind === "official" ? <AtSign size={15} /> : <WandSparkles size={15} />}</span><span><b>{addressTypeLabel(item)}</b><small>{itemProvider(item).name} · {item.source_email}</small></span>{isRegistrationOccupied(item) && <StatusBadge status="failed">注册占用</StatusBadge>}{item.kind === "split" && <input type="checkbox" aria-label={`选择 ${item.address}`} checked={selected.includes(item.id)} onChange={() => toggle(item.id)} />}</header><button onClick={() => copy(item.address)}>{item.address}<Copy size={14} /></button>{item.parent_address && <p>基础：{item.parent_address}</p>}<footer><span>{item.label || "未命名"}</span><span className="row-actions"><IconButton icon={Edit3} label="编辑" onClick={() => setEditing(item)} />{canDeleteAddress(item) && <IconButton icon={Trash2} label={isImportedIcloudAddress(item) ? "移除本地映射" : "删除"} onClick={() => remove(item)} />}</span></footer></article>)}</div><div className="table-footer"><span>共 {data.total} 个地址</span><Pagination page={data.page} pages={data.pages} onChange={setPage} /></div></> : <EmptyState icon={AtSign} title="没有匹配的邮箱地址" description={canGenerate ? "在别名工厂生成可用别名或 Plus 分裂地址。" : selectedAccount?.provider === "icloud" ? "先在源头邮箱中导入 Apple 已创建的 iCloud 别名，再直接用于注册。" : "当前源头邮箱仅可收取邮件和验证码。"} action={canGenerate ? <Button variant="primary" onClick={() => onNavigate("factory", selectedAccount ? { accountId: selectedAccount.id, mode: "split" } : {})}>进入别名工厂</Button> : undefined} />}
      </section>
      <EditAddressModal item={editing} onClose={() => setEditing(null)} onSaved={() => { load(); onDataChange(); }} />
      <ConfirmDialog open={Boolean(deleteMode)} onClose={() => setDeleteMode(null)} onConfirm={bulkDelete} loading={deleting} danger title={deleteMode === "all" ? "清空分裂地址？" : "删除所选分裂地址？"} description={deleteMode === "all" ? (accountId === "all" ? "将删除全部源头邮箱中的所有分裂地址，源头号和官方别名（如有）会保留。" : "将删除当前源头邮箱中的所有分裂地址，源头号和官方别名（如有）会保留。") : `将删除选中的 ${selected.length} 个分裂地址。`} confirmText={deleteMode === "all" ? "确认清空" : "确认删除"} />
    </div>
  );
}
