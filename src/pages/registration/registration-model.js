const statusText = {
  queued: "排队中",
  running: "注册中",
  paused: "已暂停",
  completed: "注册成功",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  cancel_requested: "取消中",
};

export const deletableStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);
export const releasableStatuses = new Set(["queued", "pending", "claimed", "running", "paused", "cancel_requested"]);
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

function accountIsPlus(item = {}) {
  const text = [
    item.account_type,
    item.account_type_raw,
    item.plan,
    item.plan_name,
    item.plan_state,
  ].map((value) => String(value || "").trim().toLowerCase()).join(" ");
  return /(?:^|[^a-z0-9])(?:plus|premium)(?:[^a-z0-9]|$)|chatgptplus/.test(text);
}

export function accountPlusDate(item = {}) {
  if (!accountIsPlus(item)) return "";
  const value = String(item.plus_at || "").trim();
  return Number.isFinite(Date.parse(value)) ? value : "";
}

export function sortRegisteredAccounts(items = []) {
  return [...items].sort((left, right) => {
    const leftPlus = accountIsPlus(left);
    const rightPlus = accountIsPlus(right);
    if (leftPlus !== rightPlus) return rightPlus ? 1 : -1;
    const leftPlusAt = Date.parse(accountPlusDate(left) || "") || 0;
    const rightPlusAt = Date.parse(accountPlusDate(right) || "") || 0;
    if (leftPlusAt !== rightPlusAt) return rightPlusAt - leftPlusAt;
    return 0;
  });
}

export function registrationBaseOptions(account) {
  const bases = Array.isArray(account?.bases) ? account.bases : [];
  return account?.registration_mode === "direct"
    ? bases.filter((item) => !item.registration_disabled)
    : bases;
}

export function preferredBase(account) {
  const bases = registrationBaseOptions(account);
  return bases.find((item) => item.registration_state === "available")
    || bases.find((item) => item.registration_state === "warning")
    || bases[0];
}

export function directRegistrationBases(account, baseAddressId) {
  if (account?.registration_mode !== "direct") return [];
  const bases = registrationBaseOptions(account);
  const selectedIndex = bases.findIndex((item) => String(item.id) === String(baseAddressId));
  if (selectedIndex < 0) return [];
  return bases.slice(selectedIndex);
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
    : item.strategy === "icloud_custom_domain"
      ? "自定义域名"
    : item.strategy === "icloud_mail_alias" ? "邮箱别名" : "";
  const occupied = occupiedAliasInfo(item);
  const failureCount = Math.max(0, Number(item.registration_failure_count) || 0);
  const failure = failureCount && !occupied.count
    ? (failureCount > 1 ? `注册失败 ${failureCount} 次` : "注册失败")
    : "";
  const pickupState = item.registration_state === "pickup_unknown"
    ? "取件站状态未知 · 禁止注册"
    : item.pickup_status === "ready"
      ? "取件站待销售 · 禁止注册"
      : item.pickup_status === "sold"
        ? "取件站已售出 · 禁止注册"
        : item.pickup_status === "disabled"
          ? "取件站已停用 · 禁止注册"
          : item.registration_state === "pickup_listed" ? "取件站库存 · 禁止注册" : "";
  const state = pickupState || (item.registration_state === "in_progress"
    ? "注册进行中"
    : item.registration_state === "used"
      ? "已用于注册"
      : item.registration_state === "occupied"
        ? "已被目标站占用"
      : item.registration_state === "likely_exhausted"
        ? "疑似已占用"
        : item.registration_state === "warning"
          ? "有占用冲突"
          : item.registration_success_count ? `已成功 ${item.registration_success_count}` : "");
  const details = [occupied.count ? `注册占用 ${occupied.count}` : "", type, failure, state].filter(Boolean).join(" · ");
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
