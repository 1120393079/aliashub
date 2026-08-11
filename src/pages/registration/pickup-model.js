const pickupStatusMeta = {
  ready: { badge: "active", label: "待销售" },
  sold: { badge: "warning", label: "已售出" },
  disabled: { badge: "inactive", label: "已停用" },
};

export function indexPickupStatuses(items) {
  const byEmail = {};
  for (const item of Array.isArray(items) ? items : []) {
    const email = String(item?.email || "").trim().toLowerCase();
    const status = String(item?.status || "").trim().toLowerCase();
    if (!email || !pickupStatusMeta[status]) continue;
    byEmail[email] = { ...item, email, status };
  }
  return byEmail;
}

export function pickupAccountState(inventory, email) {
  const item = inventory?.byEmail?.[String(email || "").trim().toLowerCase()] || null;
  if (item) return { ...pickupStatusMeta[item.status], item };
  if (!inventory?.loaded) return { badge: "connecting", label: "读取中", item: null };
  if (inventory?.error) return { badge: "warning", label: "状态未知", item: null };
  return { badge: "inactive", label: "未上架", item: null };
}
