const params = new URLSearchParams(window.location.search);
const pathToken = window.location.pathname.startsWith("/p/")
  ? decodeURIComponent(window.location.pathname.slice(3))
  : "";
const token = params.get("token") || pathToken;
const apiBase = `/api/public/mailbox/${encodeURIComponent(token)}`;
const AUTO_REFRESH_MS = 10000;

const elements = {
  email: document.getElementById("pickup-email"),
  list: document.getElementById("pickup-list"),
  detail: document.getElementById("pickup-detail"),
  refresh: document.getElementById("refresh-mail"),
  copyEmail: document.getElementById("copy-email"),
  expiry: document.getElementById("pickup-expiry"),
  toast: document.getElementById("toast"),
};

let selectedId = 0;
let currentEmail = "";
let refreshing = false;
let signature = "";

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => elements.toast.classList.remove("show"), 1800);
}

function formatDate(value) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      });
}

function senderLabel(message) {
  const name = String(message.sender_name || "").trim();
  const address = String(message.sender_address || "").trim();
  if (name && address && name.toLowerCase() !== address.toLowerCase()) return `${name} <${address}>`;
  return name || address || "未知发件人";
}

function verificationCode(text) {
  const match = /(?:verification|login|security|temporary|验证码|認証|検証|ログイン|コード)[^0-9]{0,80}([0-9]{6})/i.exec(String(text || ""));
  return match?.[1] || "";
}

function appendMailText(container, value) {
  const text = String(value || "");
  const pattern = /[<\[]?(https?:\/\/[^\s<>\]]+)[>\]]?/gi;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    container.append(document.createTextNode(text.slice(offset, match.index)));
    let url = match[1];
    let suffix = "";
    while (/[),.;!?。，！？]$/.test(url)) {
      suffix = url.slice(-1) + suffix;
      url = url.slice(0, -1);
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      container.append(document.createTextNode(match[0]));
      offset = match.index + match[0].length;
      continue;
    }
    if (!/\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(parsed.pathname)) {
      const link = document.createElement("a");
      link.className = "mail-link";
      link.href = parsed.toString();
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "打开邮件中的链接";
      container.append(link);
    }
    if (suffix) container.append(document.createTextNode(suffix));
    offset = match.index + match[0].length;
  }
  container.append(document.createTextNode(text.slice(offset)));
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败：HTTP ${response.status}`);
  return data;
}

function showListMessage(message) {
  elements.list.className = "pickup-list empty";
  elements.list.textContent = message;
}

function renderMessages(messages) {
  elements.list.textContent = "";
  elements.list.className = "pickup-list";
  if (!messages.length) {
    showListMessage("当前邮箱暂时没有邮件");
    return;
  }
  for (const message of messages) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mail-item${message.id === selectedId ? " active" : ""}`;
    button.dataset.messageId = String(message.id);

    const subject = document.createElement("strong");
    subject.textContent = message.subject || "无主题";
    const sender = document.createElement("span");
    sender.className = "from";
    sender.textContent = senderLabel(message);
    const preview = document.createElement("span");
    preview.className = "preview";
    preview.textContent = message.preview || "点击查看邮件正文";
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = formatDate(message.received_at);

    button.append(subject, sender, preview, time);
    button.addEventListener("click", () => loadMessage(message.id));
    elements.list.append(button);
  }
}

async function loadMessage(id) {
  selectedId = id;
  elements.list.querySelectorAll(".mail-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.messageId === String(id));
  });
  elements.detail.className = "pickup-detail empty";
  elements.detail.textContent = "正在读取邮件正文...";
  try {
    const message = await request(`${apiBase}/messages/${id}`);
    elements.detail.textContent = "";
    elements.detail.className = "pickup-detail";

    const header = document.createElement("div");
    header.className = "mail-detail-header";
    const title = document.createElement("h2");
    title.textContent = message.subject || "无主题";
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "button danger mail-delete";
    deleteButton.textContent = "删除邮件";
    deleteButton.addEventListener("click", () => deleteMessage(id, deleteButton));
    header.append(title, deleteButton);
    const meta = document.createElement("div");
    meta.className = "mail-meta";
    for (const value of [
      `发件人：${senderLabel(message)}`,
      `收件邮箱：${message.recipient}`,
      `时间：${formatDate(message.received_at)}`,
    ]) {
      const span = document.createElement("span");
      span.textContent = value;
      meta.append(span);
    }
    const content = String(message.text_body || "").trim();
    const code = verificationCode(`${message.subject || ""}\n${content}`);
    let codeBox = null;
    if (code) {
      codeBox = document.createElement("div");
      codeBox.className = "mail-code";
      const codeLabel = document.createElement("span");
      codeLabel.textContent = "邮件验证码";
      const codeValue = document.createElement("strong");
      codeValue.textContent = code;
      const copyCode = document.createElement("button");
      copyCode.type = "button";
      copyCode.className = "button secondary";
      copyCode.textContent = "复制验证码";
      copyCode.addEventListener("click", async () => {
        await navigator.clipboard.writeText(code);
        toast("验证码已复制");
      });
      codeBox.append(codeLabel, codeValue, copyCode);
    }
    const body = document.createElement("div");
    body.className = "mail-body";
    appendMailText(body, content || "暂无正文");
    elements.detail.append(header, meta);
    if (codeBox) elements.detail.append(codeBox);
    elements.detail.append(body);
    await refreshMail(false);
  } catch (error) {
    elements.detail.className = "pickup-detail empty";
    elements.detail.textContent = error.message;
  }
}

async function deleteMessage(id, button) {
  if (!window.confirm("确定删除这封邮件吗？删除后不可恢复。")) return;
  button.disabled = true;
  try {
    await request(`${apiBase}/messages/${id}`, { method: "DELETE" });
    selectedId = 0;
    signature = "";
    elements.detail.className = "pickup-detail empty";
    elements.detail.innerHTML = "<div><strong>邮件已删除</strong><span>请选择其他邮件继续查看。</span></div>";
    await refreshMail(false);
    toast("邮件已删除");
  } catch (error) {
    button.disabled = false;
    toast(error.message);
  }
}

async function refreshMail(showLoading = true) {
  if (refreshing || !token) return;
  refreshing = true;
  elements.refresh.disabled = true;
  if (showLoading) showListMessage("正在获取邮件...");
  try {
    const data = await request(apiBase);
    currentEmail = data.email || "";
    elements.email.textContent = currentEmail;
    elements.copyEmail.disabled = !currentEmail;
    elements.expiry.textContent = data.expires_at ? `有效期至 ${formatDate(data.expires_at)}` : "长期有效";
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const nextSignature = JSON.stringify(messages.map((item) => [item.id, item.subject, item.received_at]));
    if (nextSignature !== signature) {
      signature = nextSignature;
      renderMessages(messages);
    }
  } catch (error) {
    elements.email.textContent = "取件链接不可用";
    showListMessage(error.message);
    elements.detail.className = "pickup-detail empty";
    elements.detail.textContent = "请检查链接是否完整，或联系卖家重置取件链接。";
  } finally {
    refreshing = false;
    elements.refresh.disabled = false;
  }
}

elements.refresh.addEventListener("click", () => refreshMail(false));
elements.copyEmail.addEventListener("click", async () => {
  if (!currentEmail) return;
  await navigator.clipboard.writeText(currentEmail);
  toast("邮箱地址已复制");
});

if (!token) {
  elements.email.textContent = "取件链接缺少 token";
  showListMessage("请使用卖家提供的完整取件链接");
} else {
  refreshMail();
  window.setInterval(() => {
    if (!document.hidden) refreshMail(false);
  }, AUTO_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshMail(false);
  });
}
