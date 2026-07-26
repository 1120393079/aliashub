const statusText = {
  queued: "排队中",
  running: "注册中",
  completed: "注册成功",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  cancel_requested: "取消中",
};

export const deletableStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);
export const releasableStatuses = new Set(["queued", "pending", "claimed", "running", "cancel_requested"]);
export const accountPageSizes = [5, 10, 20, 50];
export const accountPageSizeStorageKey = "aliashub.registration.account-page-size";

export function initialAccountPageSize() {
  if (typeof window === "undefined") return 10;
  try {
    const stored = Number(window.localStorage.getItem(accountPageSizeStorageKey));
    return accountPageSizes.includes(stored) ? stored : 10;
  } catch {
    return 10;
  }
}

export function preferredBase(account) {
  return account?.bases.find((item) => item.registration_state === "available")
    || account?.bases.find((item) => item.registration_state === "warning")
    || account?.bases[0];
}

export function occupiedAliasInfo(item) {
  const aliases = Array.isArray(item?.occupied_aliases)
    ? item.occupied_aliases
      .map((entry) => typeof entry === "string" ? entry : (entry?.email || entry?.address || entry?.alias || ""))
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
    : [];
  const reportedCount = Number(item?.occupied_alias_count ?? item?.already_exists_count);
  return {
    count: Math.max(Number.isFinite(reportedCount) ? Math.floor(reportedCount) : 0, aliases.length),
    aliases: [...new Set(aliases)],
  };
}

export function baseOptionLabel(item) {
  const type = item.strategy === "icloud_hide_my_email"
    ? "隐藏邮箱"
    : item.strategy === "icloud_mail_alias" ? "邮箱别名" : "";
  const occupied = occupiedAliasInfo(item);
  const state = item.registration_state === "in_progress"
    ? "注册进行中"
    : item.registration_state === "used"
      ? "已用于注册"
      : item.registration_state === "occupied"
        ? "已被目标站占用"
      : item.registration_state === "likely_exhausted"
        ? "疑似已占用"
        : item.registration_state === "warning"
          ? "有占用冲突"
          : item.registration_success_count ? `已成功 ${item.registration_success_count}` : "";
  const details = [occupied.count ? `注册占用 ${occupied.count}` : "", type, state].filter(Boolean).join(" · ");
  return details ? `${item.address}（${details}）` : item.address;
}

export function jobStatusLabel(job) {
  return job.failure_reason === "user_already_exists" ? "邮箱已占用" : (statusText[job.status] || job.status);
}

export function ageFromBirth(value) {
  if (!value) return "-";
  const birth = new Date(value);
  if (!Number.isFinite(birth.getTime())) return "-";
  const now = new Date();
  return now.getFullYear() - birth.getFullYear() - (now < new Date(now.getFullYear(), birth.getMonth(), birth.getDate()) ? 1 : 0);
}
