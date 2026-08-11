const elements = {
  rows: document.getElementById("mailbox-rows"),
  search: document.getElementById("search-mailboxes"),
  status: document.getElementById("filter-status"),
  selectAll: document.getElementById("select-all"),
  toast: document.getElementById("toast"),
  dialog: document.getElementById("edit-dialog"),
  editEmail: document.getElementById("edit-email"),
  editPassword: document.getElementById("edit-password"),
  editLabel: document.getElementById("edit-label"),
  editExtra: document.getElementById("edit-extra"),
  editStatus: document.getElementById("edit-status"),
  bulkStatusDialog: document.getElementById("bulk-status-dialog"),
  bulkStatusTitle: document.getElementById("bulk-status-title"),
  bulkStatus: document.getElementById("bulk-status"),
  bulkStatusSave: document.getElementById("save-bulk-status"),
  ldxpForm: document.getElementById("ldxp-form"),
  ldxpUsername: document.getElementById("ldxp-username"),
  ldxpPassword: document.getElementById("ldxp-password"),
  ldxpCatalog: document.getElementById("ldxp-catalog"),
  ldxpGoods: document.getElementById("ldxp-goods"),
  ldxpRefreshGoods: document.getElementById("ldxp-refresh-goods"),
  ldxpSave: document.getElementById("ldxp-save"),
  ldxpVerify: document.getElementById("ldxp-verify"),
  ldxpReconnect: document.getElementById("ldxp-reconnect"),
  ldxpActionNote: document.getElementById("ldxp-action-note"),
  ldxpConnection: document.getElementById("ldxp-connection"),
  ldxpConnectionTitle: document.getElementById("ldxp-connection-title"),
  ldxpConnectionDetail: document.getElementById("ldxp-connection-detail"),
  copyCardsSelected: document.getElementById("copy-cards-selected"),
  copyApiSelected: document.getElementById("copy-api-selected"),
  uploadSelected: document.getElementById("upload-selected"),
  linkImportForm: document.getElementById("link-import-form"),
  linkImportInput: document.getElementById("link-import-input"),
  linkImportOutput: document.getElementById("link-import-output"),
  linkImportCount: document.getElementById("link-import-count"),
  linkImportStatus: document.getElementById("link-import-status"),
  linkImportSubmit: document.getElementById("link-import-submit"),
  linkImportCopy: document.getElementById("link-import-copy"),
  linkImportClear: document.getElementById("link-import-clear"),
};

let mailboxes = [];
let selected = new Set();
let editing = null;
let ldxpState = null;
let ldxpGoodsLoaded = false;
let ldxpGoodsLoading = false;
let reconnectMode = false;
let adminRefreshInFlight = false;
let ldxpStateRequestInFlight = false;

const ADMIN_REFRESH_INTERVAL_MS = 10_000;

function ldxpVerificationUrl() {
  const prefix = location.pathname.startsWith("/mail-pickup/") ? "/mail-pickup" : "";
  const socketPath = `${prefix ? `${prefix.slice(1)}/` : ""}ldxp-verify/websockify`;
  return `${prefix}/ldxp-verify/vnc.html?autoconnect=true&resize=scale&path=${encodeURIComponent(socketPath)}`;
}

elements.ldxpVerify.href = ldxpVerificationUrl();

function toast(message, type = "success") {
  elements.toast.textContent = message;
  elements.toast.dataset.type = type;
  elements.toast.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => elements.toast.classList.remove("show"), 2200);
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      });
}

function truncateText(value, maxLength = 120) {
  const text = String(value || "").trim();
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function setLdxpActionNote(message = "", type = "") {
  elements.ldxpActionNote.textContent = message;
  elements.ldxpActionNote.dataset.type = type;
}

function setLdxpButtonBusy(button, busy, busyLabel) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyLabel : button.dataset.label;
}

function syncStatePresentation(state) {
  const configured = Boolean(state?.merchant_token_configured);
  const status = String(state?.last_sync_status || "").toLowerCase();
  const error = truncateText(state?.last_sync_error);

  if (!configured) {
    return {
      kind: "idle",
      title: "未连接",
      detail: "用联动小铺账号连接一次，不用抓包或找 Token。",
    };
  }
  if (state?.upload_in_progress) {
    return { kind: "running", title: "正在一键上货", detail: "系统正在自动匹配店铺商品。" };
  }
  if (state?.sync_in_progress || ["running", "syncing"].includes(status)) {
    return { kind: "running", title: "店铺已连接", detail: "正在同步售出状态。" };
  }
  if (error && ["blocked", "failed", "not_configured"].includes(status)) {
    const needsVerification = error.includes("人工滑块验证");
    return {
      kind: "error",
      title: needsVerification ? "需要人工验证" : "连接异常",
      detail: error,
    };
  }
  const goodsName = String(state?.uploads?.goods_name || "").trim();
  const goodsCategory = String(state?.uploads?.goods_category || "").trim();
  return {
    kind: "ready",
    title: "店铺已连接",
    detail: goodsName
      ? `最近上货：${goodsCategory ? `${goodsCategory} · ` : ""}${goodsName}`
      : "请选择对应商品，再把勾选账号上货进去。",
  };
}

function renderLdxpState(state) {
  ldxpState = state && typeof state === "object" ? state : {};
  const presentation = syncStatePresentation(ldxpState);
  const configured = Boolean(ldxpState.merchant_token_configured);

  elements.ldxpConnection.className = `sync-state is-${presentation.kind}`;
  elements.ldxpConnectionTitle.textContent = presentation.title;
  elements.ldxpConnectionDetail.textContent = presentation.detail;
  elements.ldxpForm.hidden = configured && !reconnectMode;
  elements.ldxpCatalog.hidden = !configured || reconnectMode;
  elements.ldxpReconnect.hidden = !configured;
  elements.uploadSelected.disabled = Boolean(ldxpState.upload_in_progress);
}

function renderLdxpGoods(items) {
  const selectedGoodsId = elements.ldxpGoods.value || localStorage.getItem("ldxp-selected-goods-id") || "";
  elements.ldxpGoods.textContent = "";
  if (!items.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "店铺中没有可上货的卡密商品";
    elements.ldxpGoods.append(option);
    return;
  }
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "请选择商品分类和渠道";
  placeholder.disabled = true;
  elements.ldxpGoods.append(placeholder);
  const groups = new Map();
  for (const item of items) {
    const category = String(item.category || "未分类");
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(item);
  }
  for (const [category, goodsItems] of groups) {
    const group = document.createElement("optgroup");
    group.label = category;
    for (const item of goodsItems) {
      const option = document.createElement("option");
      option.value = String(item.id);
      option.textContent = `${item.name}（库存 ${item.stock_count || 0}）`;
      group.append(option);
    }
    elements.ldxpGoods.append(group);
  }
  const availableIds = new Set(items.map((item) => String(item.id)));
  elements.ldxpGoods.value = availableIds.has(selectedGoodsId) ? selectedGoodsId : "";
}

async function loadLdxpGoods({ refresh = false, silent = false } = {}) {
  if (!ldxpState?.merchant_token_configured || ldxpGoodsLoading) return;
  ldxpGoodsLoading = true;
  setLdxpButtonBusy(elements.ldxpRefreshGoods, true, "读取中...");
  try {
    const data = await api(`/api/admin/ldxp/goods${refresh ? "?refresh=1" : ""}`);
    renderLdxpGoods(Array.isArray(data.items) ? data.items : []);
    ldxpGoodsLoaded = true;
    if (!silent) toast(`已读取 ${data.items?.length || 0} 个店铺商品`);
  } catch (error) {
    if (!silent) toast(error.message, "error");
  } finally {
    ldxpGoodsLoading = false;
    setLdxpButtonBusy(elements.ldxpRefreshGoods, false, "读取中...");
  }
}

function renderLdxpStateError(error) {
  elements.ldxpConnection.className = "sync-state is-error";
  elements.ldxpConnectionTitle.textContent = "状态读取失败";
  elements.ldxpConnectionDetail.textContent = truncateText(error?.message || "请稍后刷新重试。 ");
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败：HTTP ${response.status}`);
  return data;
}

function statusLabel(status) {
  return { ready: "待销售", sold: "已售出", disabled: "已停用" }[status] || status;
}

function selectedItems() {
  return mailboxes.filter((item) => selected.has(item.id));
}

function importLineCount(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("//"))
    .length;
}

function parseLinkImport(value) {
  const items = [];
  const seen = new Map();
  const lines = String(value || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].replace(/^\uFEFF/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const separator = line.indexOf("----");
    const email = (separator >= 0 ? line.slice(0, separator) : line).trim().toLowerCase();
    const password = separator >= 0 ? line.slice(separator + 4).trim() : "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new Error(`第 ${lineNumber} 行邮箱格式无效`);
    }
    if (seen.has(email)) {
      throw new Error(`第 ${lineNumber} 行邮箱与第 ${seen.get(email)} 行重复`);
    }
    seen.set(email, lineNumber);
    items.push({ email, ...(password ? { password } : {}) });
    if (items.length > 500) throw new Error("单次最多生成 500 个取件链接");
  }
  if (!items.length) throw new Error("请至少填写一个邮箱");
  return items;
}

function updateLinkImportCount() {
  const count = importLineCount(elements.linkImportInput.value);
  elements.linkImportCount.textContent = `${count} 个邮箱`;
}

async function copy(value, message) {
  await navigator.clipboard.writeText(value);
  toast(message);
}

function makeButton(label, className, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function renderRows() {
  elements.rows.textContent = "";
  if (!mailboxes.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.className = "table-empty";
    cell.textContent = "没有匹配的取件邮箱";
    row.append(cell);
    elements.rows.append(row);
    return;
  }
  for (const mailbox of mailboxes) {
    const row = document.createElement("tr");
    if (selected.has(mailbox.id)) row.classList.add("selected");

    const selectCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(mailbox.id);
    checkbox.addEventListener("change", () => {
      checkbox.checked ? selected.add(mailbox.id) : selected.delete(mailbox.id);
      renderRows();
    });
    selectCell.append(checkbox);

    const emailCell = document.createElement("td");
    const email = document.createElement("strong");
    email.textContent = mailbox.email;
    const label = document.createElement("span");
    label.className = "cell-note";
    label.textContent = mailbox.label || mailbox.extra || "未填写备注";
    emailCell.append(email, label);

    const sourceCell = document.createElement("td");
    const provider = document.createElement("strong");
    provider.textContent = {
      microsoft: "Microsoft",
      icloud: "iCloud",
      google: "Google",
      inbox_link: "链接取件",
      unbound: "仅生成链接",
      cloudflare: "Cloudflare",
    }[mailbox.source_provider] || mailbox.source_provider || "待匹配";
    const sourceEmail = document.createElement("span");
    sourceEmail.className = "cell-note";
    sourceEmail.textContent = mailbox.source_email || "-";
    sourceCell.append(provider, sourceEmail);

    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `status-badge status-${mailbox.status}`;
    badge.textContent = statusLabel(mailbox.status);
    statusCell.append(badge);

    const countCell = document.createElement("td");
    countCell.textContent = String(mailbox.message_count || 0);
    const createdCell = document.createElement("td");
    createdCell.textContent = formatDate(mailbox.created_at);

    const saleCell = document.createElement("td");
    saleCell.className = "sale-cell";
    const soldAt = mailbox.sold_at;
    const tradeNo = mailbox.ldxp_trade_no;
    if (soldAt || tradeNo || mailbox.status === "sold") {
      const soldTime = document.createElement("strong");
      soldTime.textContent = soldAt ? `售出：${formatDate(soldAt)}` : "已售出";
      const order = document.createElement("span");
      order.className = "cell-note";
      order.textContent = tradeNo
        ? `订单：${tradeNo}`
        : mailbox.ldxp_card_digest
          ? "来源：联动小铺库存"
          : "来源：手动标记";
      saleCell.append(soldTime, order);
    } else if (mailbox.ldxp_listed_at) {
      const listedTime = document.createElement("strong");
      listedTime.textContent = `已上货：${formatDate(mailbox.ldxp_listed_at)}`;
      const goods = document.createElement("span");
      goods.className = "cell-note";
      const listedName = mailbox.ldxp_listed_goods_name || `商品 ${mailbox.ldxp_listed_goods_id || ""}`;
      goods.textContent = mailbox.ldxp_listed_goods_category
        ? `${mailbox.ldxp_listed_goods_category} · ${listedName}`
        : listedName;
      saleCell.append(listedTime, goods);
    } else {
      saleCell.textContent = "-";
    }

    const actionCell = document.createElement("td");
    actionCell.className = "row-actions";
    actionCell.append(
      makeButton("邮箱", "mini-button", () => copy(mailbox.email, "邮箱已复制")),
      makeButton("取件", "mini-button accent", () => window.open(mailbox.pickup_url, "_blank", "noopener,noreferrer")),
      makeButton("链接", "mini-button", () => copy(mailbox.pickup_url, "取件链接已复制")),
      makeButton("API", "mini-button", () => copy(mailbox.pickup_api_url, "取件 API 已复制")),
      makeButton("卡密", "mini-button", () => copy(mailbox.delivery_line, "链动卡密已复制")),
      makeButton("编辑", "mini-button accent", () => openEdit(mailbox)),
    );

    row.append(selectCell, emailCell, sourceCell, statusCell, countCell, createdCell, saleCell, actionCell);
    elements.rows.append(row);
  }
  elements.selectAll.checked = mailboxes.length > 0 && mailboxes.every((item) => selected.has(item.id));
}

async function loadMailboxes({ silent = false } = {}) {
  const query = new URLSearchParams();
  if (elements.search.value.trim()) query.set("q", elements.search.value.trim());
  if (elements.status.value) query.set("status", elements.status.value);
  try {
    const data = await api(`/api/admin/mailboxes?${query}`);
    mailboxes = data.items || [];
    for (const key of ["total", "ready", "sold", "disabled"]) {
      document.getElementById(`stat-${key}`).textContent = String(data.stats?.[key] || 0);
    }
    renderRows();
  } catch (error) {
    if (!silent) toast(error.message, "error");
  }
}

async function loadLdxpState({ silent = false } = {}) {
  if (ldxpStateRequestInFlight) return;
  ldxpStateRequestInFlight = true;
  try {
    renderLdxpState(await api("/api/admin/ldxp"));
    if (ldxpState?.merchant_token_configured && !ldxpGoodsLoaded) {
      loadLdxpGoods({ silent: true });
    }
  } catch (error) {
    renderLdxpStateError(error);
    if (!silent) toast(error.message, "error");
  } finally {
    ldxpStateRequestInFlight = false;
  }
}

async function refreshAdmin({ silent = false } = {}) {
  if (adminRefreshInFlight) return;
  adminRefreshInFlight = true;
  try {
    await Promise.all([loadMailboxes({ silent }), loadLdxpState({ silent })]);
  } finally {
    adminRefreshInFlight = false;
  }
}

elements.ldxpForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = elements.ldxpUsername.value.trim();
  const password = elements.ldxpPassword.value;
  if (!username || !password) return toast("请输入联动小铺账号和密码", "error");

  setLdxpButtonBusy(elements.ldxpSave, true, "正在连接...");
  setLdxpActionNote("正在连接店铺...", "pending");
  try {
    const state = await api("/api/admin/ldxp/connect", {
      method: "POST",
      body: { username, password },
    });
    reconnectMode = false;
    ldxpGoodsLoaded = false;
    renderLdxpState(state);
    setLdxpActionNote("店铺已连接。", "success");
    toast("联动小铺已连接");
    await loadLdxpGoods({ refresh: true, silent: true });
  } catch (error) {
    setLdxpActionNote(error.message, "error");
    toast(error.message, "error");
  } finally {
    elements.ldxpPassword.value = "";
    setLdxpButtonBusy(elements.ldxpSave, false, "正在连接...");
  }
});

elements.linkImportInput.addEventListener("input", updateLinkImportCount);

elements.linkImportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  let items;
  try {
    items = parseLinkImport(elements.linkImportInput.value);
  } catch (error) {
    elements.linkImportStatus.textContent = error.message;
    elements.linkImportStatus.dataset.type = "error";
    toast(error.message, "error");
    return;
  }

  setLdxpButtonBusy(elements.linkImportSubmit, true, "正在生成...");
  elements.linkImportCopy.disabled = true;
  elements.linkImportStatus.textContent = `正在处理 ${items.length} 个邮箱...`;
  elements.linkImportStatus.dataset.type = "pending";
  try {
    const result = await api("/api/admin/mailboxes", {
      method: "POST",
      body: { items, upsert: true, clear_credentials: false, allow_unbound: true },
    });
    const generated = Array.isArray(result.items) ? result.items : [];
    if (generated.length !== items.length) throw new Error("服务器返回的取件链接数量不完整");
    elements.linkImportOutput.value = generated
      .map((item) => `${item.email}----${item.pickup_url}`)
      .join("\n");
    elements.linkImportCopy.disabled = false;
    const emptyCount = generated.filter((item) => item.source_provider === "unbound").length;
    elements.linkImportStatus.textContent = emptyCount
      ? `已生成 ${generated.length} 个取件链接，其中 ${emptyCount} 个为未绑定收件源的空取件箱。`
      : `已生成 ${generated.length} 个取件链接。`;
    elements.linkImportStatus.dataset.type = "success";
    await loadMailboxes({ silent: true });
    toast(`已生成 ${generated.length} 个取件链接`);
  } catch (error) {
    elements.linkImportOutput.value = "";
    elements.linkImportStatus.textContent = error.message;
    elements.linkImportStatus.dataset.type = "error";
    toast(error.message, "error");
  } finally {
    setLdxpButtonBusy(elements.linkImportSubmit, false, "正在生成...");
  }
});

elements.linkImportCopy.addEventListener("click", async () => {
  if (!elements.linkImportOutput.value) return;
  await copy(elements.linkImportOutput.value, "取件链接已复制");
});

elements.linkImportClear.addEventListener("click", () => {
  elements.linkImportInput.value = "";
  elements.linkImportOutput.value = "";
  elements.linkImportCopy.disabled = true;
  elements.linkImportStatus.textContent = "未配置收件凭据的外部邮箱会生成空取件箱；密码仅用于账号卡密交付。";
  elements.linkImportStatus.dataset.type = "";
  updateLinkImportCount();
  elements.linkImportInput.focus();
});

elements.ldxpReconnect.addEventListener("click", () => {
  reconnectMode = true;
  elements.ldxpForm.hidden = false;
  elements.ldxpCatalog.hidden = true;
  elements.ldxpReconnect.hidden = true;
  elements.ldxpUsername.focus();
});

elements.ldxpGoods.addEventListener("change", () => {
  if (elements.ldxpGoods.value) localStorage.setItem("ldxp-selected-goods-id", elements.ldxpGoods.value);
});

elements.ldxpRefreshGoods.addEventListener("click", () => loadLdxpGoods({ refresh: true }));

function openEdit(mailbox) {
  editing = mailbox;
  elements.editEmail.textContent = mailbox.email;
  elements.editPassword.value = mailbox.account_password || "";
  elements.editLabel.value = mailbox.label || "";
  elements.editExtra.value = mailbox.extra || "";
  elements.editStatus.value = mailbox.status;
  elements.dialog.showModal();
}

document.getElementById("edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!editing) return;
  try {
    await api(`/api/admin/mailboxes/${editing.id}`, {
      method: "PATCH",
      body: {
        password: elements.editPassword.value,
        label: elements.editLabel.value,
        extra: elements.editExtra.value,
        status: elements.editStatus.value,
      },
    });
    elements.dialog.close();
    toast("邮箱信息已保存");
    await loadMailboxes();
  } catch (error) {
    toast(error.message, "error");
  }
});

document.getElementById("rotate-token").addEventListener("click", async () => {
  if (!editing || !window.confirm("旧取件链接会立即失效，确认重置？")) return;
  try {
    const result = await api(`/api/admin/mailboxes/${editing.id}/rotate`, { method: "POST" });
    editing = result;
    toast("取件链接已重置");
    await copy(result.pickup_url, "新取件链接已复制");
    await loadMailboxes();
  } catch (error) {
    toast(error.message, "error");
  }
});

document.getElementById("delete-mailbox").addEventListener("click", async () => {
  if (!editing || !window.confirm(`确认删除 ${editing.email} 及其全部邮件？`)) return;
  try {
    await api(`/api/admin/mailboxes/${editing.id}`, { method: "DELETE" });
    selected.delete(editing.id);
    elements.dialog.close();
    toast("邮箱已删除");
    await loadMailboxes();
  } catch (error) {
    toast(error.message, "error");
  }
});

document.getElementById("close-dialog").addEventListener("click", () => elements.dialog.close());
document.getElementById("refresh-admin").addEventListener("click", () => refreshAdmin());
elements.search.addEventListener("input", () => {
  window.clearTimeout(loadMailboxes.timer);
  loadMailboxes.timer = window.setTimeout(loadMailboxes, 250);
});
elements.status.addEventListener("change", loadMailboxes);
elements.selectAll.addEventListener("change", () => {
  for (const item of mailboxes) {
    elements.selectAll.checked ? selected.add(item.id) : selected.delete(item.id);
  }
  renderRows();
});

elements.copyCardsSelected.addEventListener("click", async () => {
  const items = selectedItems().filter((item) => item.delivery_line);
  if (!items.length) return toast("请先勾选要复制的卡密", "error");
  await copy(
    items.map((item) => item.delivery_line).join("\n"),
    `已复制 ${items.length} 条卡密`,
  );
});

elements.copyApiSelected.addEventListener("click", async () => {
  const items = selectedItems().filter((item) => item.status !== "disabled" && item.pickup_api_url);
  if (!items.length) return toast("请先选择要导出的取件邮箱", "error");
  await copy(
    items.map((item) => `${item.email}----${item.pickup_api_url}`).join("\n"),
    `已复制 ${items.length} 条邮箱----取件 API`,
  );
});

document.getElementById("edit-status-selected").addEventListener("click", () => {
  const items = selectedItems();
  if (!items.length) return toast("请先勾选要编辑的邮箱", "error");
  const statuses = new Set(items.map((item) => item.status));
  elements.bulkStatus.value = statuses.size === 1 ? items[0].status : "ready";
  elements.bulkStatusTitle.textContent = `批量编辑 ${items.length} 个邮箱`;
  elements.bulkStatusDialog.showModal();
});

document.getElementById("bulk-status-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const items = selectedItems();
  if (!items.length) {
    elements.bulkStatusDialog.close();
    return toast("所选邮箱已不在当前列表，请重新勾选", "error");
  }
  setLdxpButtonBusy(elements.bulkStatusSave, true, "保存中...");
  try {
    const result = await api("/api/admin/mailboxes/status", {
      method: "PATCH",
      body: { ids: items.map((item) => item.id), status: elements.bulkStatus.value },
    });
    elements.bulkStatusDialog.close();
    await loadMailboxes({ silent: true });
    toast(`已更新 ${result.updated || 0} 个邮箱的状态`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setLdxpButtonBusy(elements.bulkStatusSave, false, "保存中...");
  }
});

document.getElementById("close-bulk-status").addEventListener("click", () => elements.bulkStatusDialog.close());
document.getElementById("cancel-bulk-status").addEventListener("click", () => elements.bulkStatusDialog.close());

elements.uploadSelected.addEventListener("click", async () => {
  const items = selectedItems().filter((item) => item.status === "ready");
  if (!items.length) return toast("请先选择待销售账号", "error");
  if (!ldxpState?.merchant_token_configured) {
    elements.ldxpForm.hidden = false;
    elements.ldxpUsername.focus();
    return toast("请先连接联动小铺", "error");
  }
  const goodsId = elements.ldxpGoods.value;
  if (!goodsId) return toast("请先选择要上货的联动小铺商品", "error");
  setLdxpButtonBusy(elements.uploadSelected, true, "正在上货...");
  setLdxpActionNote("正在自动匹配店铺商品并上货...", "pending");
  try {
    const result = await api("/api/admin/ldxp/upload", {
      method: "POST",
      body: { ids: items.map((item) => item.id), goods_id: goodsId },
    });
    for (const item of items) selected.delete(item.id);
    const goodsName = result.goods?.name || `商品 ${result.goods?.id || ""}`;
    setLdxpActionNote(`已上货 ${result.uploaded || 0} 个账号到 ${goodsName}。`, "success");
    toast(`上货成功：${result.uploaded || 0} 个账号`);
    await Promise.all([loadMailboxes({ silent: true }), loadLdxpState({ silent: true })]);
  } catch (error) {
    setLdxpActionNote(error.message, "error");
    toast(error.message, "error");
  } finally {
    setLdxpButtonBusy(elements.uploadSelected, false, "正在上货...");
  }
});

document.getElementById("archive-sold").addEventListener("click", async () => {
  const items = selectedItems();
  if (!items.length) return toast("请先选择已售记录", "error");
  const soldItems = items.filter((item) => item.status === "sold");
  if (!soldItems.length) return toast("所选记录中没有已售账号", "error");
  const message = `确定从本后台删除 ${soldItems.length} 条已售记录吗？\n\n买家的邮箱取件链接仍然有效，不会删除邮箱或邮件。`;
  if (!window.confirm(message)) return;
  try {
    const result = await api("/api/admin/mailboxes/archive-sold", {
      method: "POST",
      body: { ids: soldItems.map((item) => item.id) },
    });
    for (const item of soldItems) selected.delete(item.id);
    await loadMailboxes({ silent: true });
    toast(`已本地删除 ${result.archived || 0} 条记录，取件链接保持有效`);
  } catch (error) {
    toast(error.message, "error");
  }
});

refreshAdmin({ silent: true });
window.setInterval(() => {
  if (document.visibilityState === "visible") refreshAdmin({ silent: true });
}, ADMIN_REFRESH_INTERVAL_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshAdmin({ silent: true });
});
