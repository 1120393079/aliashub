export function relativeTime(value) {
  if (!value) return "从未";
  const delta = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(delta)) return "-";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

export function formatDate(value, withTime = true) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  }).format(new Date(value));
}

export function copyText(value) {
  return navigator.clipboard.writeText(String(value));
}

export const accountStatus = {
  connected: "已连接",
  connecting: "待登录",
  action_required: "需要确认",
  disconnected: "已断开",
  error: "连接异常",
};

export const jobStatus = {
  queued: "排队中",
  running: "执行中",
  waiting_user: "等待确认",
  limited: "已受限",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export const kindText = {
  primary: "源头地址",
  official: "官方别名",
  split: "分裂地址",
};

export function sourceDomain(email = "") {
  return email.split("@")[1] || "outlook.com";
}
