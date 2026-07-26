export const accountAvailabilityMeta = {
  available: { label: "可用", badge: "active" },
  unavailable: { label: "确认失效", badge: "failed" },
  unchecked: { label: "待检测", badge: "queued" },
};

const accountTypeText = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
  trial: "Trial",
  other: "Other",
  unknown: "Unknown",
};

export const accountTypeGroupOrder = [
  "free", "go", "plus", "pro", "team", "business", "enterprise", "edu", "trial", "other", "unknown",
];

export const accountTypeGroupRank = new Map(accountTypeGroupOrder.map((type, index) => [type, index]));

const accountTypeAliases = new Map([
  ["free", new Set(["free", "basic", "starter", "hobby", "chatgptfreeplan"])],
  ["go", new Set(["go", "chatgptgo", "chatgptgoplan"])],
  ["plus", new Set(["plus", "premium", "chatgptplus", "chatgptplusplan"])],
  ["pro", new Set(["pro", "chatgptpro", "chatgptproplan"])],
  ["team", new Set(["team", "chatgptteam", "chatgptteamplan"])],
  ["business", new Set(["business", "chatgptbusiness", "chatgptbusinessplan"])],
  ["enterprise", new Set(["enterprise", "chatgptenterprise", "chatgptenterpriseplan"])],
  ["edu", new Set(["edu", "education", "chatgptedu", "chatgpteduplan", "chatgpteducationplan"])],
  ["trial", new Set(["trial", "trialing", "freetrial", "chatgpttrial", "chatgpttrialplan"])],
]);

const nonAccountTypeSignals = new Set([
  "", "unknown", "none", "null", "invalid", "expired", "banned", "disabled", "inactive",
  "unavailable", "registered", "active", "valid", "subscribed", "eligible", "canceling", "cancelled",
]);

export const transientStatusCodes = new Set([
  "CHECK_TIMEOUT", "PROXY_UNAVAILABLE", "NETWORK_ERROR", "RATE_LIMITED", "UPSTREAM_5XX",
  "UPSTREAM_UNAVAILABLE", "UPSTREAM_REJECTED", "UPSTREAM_CHALLENGE", "CHALLENGE_PAGE", "CHALLENGE_REQUIRED",
  "RESPONSE_UNRECOGNIZED", "CREDENTIALS_MISSING", "AUTH_UNAUTHORIZED_UNCONFIRMED",
  "AUTHENTICATION_UNCONFIRMED", "ACCESS_FORBIDDEN", "ACCOUNT_IDENTITY_MISMATCH", "CHECK_INCONCLUSIVE",
  "CHECK_FAILED", "PLAN_CONFLICT", "DNS_FAILURE", "TLS_FAILURE",
]);

export const definitiveUnavailableCodes = new Set([
  "AUTH_TOKEN_EXPIRED", "AUTH_TOKEN_REVOKED", "AUTH_CREDENTIALS_EXPIRED", "AUTH_CREDENTIALS_REVOKED",
  "TOKEN_EXPIRED", "TOKEN_REVOKED", "CREDENTIAL_EXPIRED", "CREDENTIAL_REVOKED", "CREDENTIALS_EXPIRED",
  "CREDENTIALS_REVOKED", "ACCESS_TOKEN_EXPIRED", "AUTHENTICATION_EXPIRED", "AUTHENTICATION_REVOKED",
  "AUTH_REVOKED", "INVALID_TOKEN", "SESSION_EXPIRED", "SESSION_REVOKED", "ACCOUNT_INVALID",
  "ACCOUNT_DISABLED", "ACCOUNT_BANNED", "ACCOUNT_DEACTIVATED", "ACCOUNT_DELETED", "ACCOUNT_SUSPENDED",
  "USER_DISABLED", "USER_BANNED", "USER_DEACTIVATED", "USER_DELETED", "USER_SUSPENDED",
]);

export function accountSignalValue(item, keys) {
  const containers = [item, item?.overview, item?.status_details, item?.statusDetails]
    .filter((value) => value && typeof value === "object" && !Array.isArray(value));
  for (const container of containers) {
    for (const key of keys) {
      const value = container[key];
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && !value.trim()) continue;
      if (["string", "number", "boolean"].includes(typeof value)) return value;
    }
  }
  return "";
}

export function accountSignalText(item, keys, maximum = 240) {
  return String(accountSignalValue(item, keys) ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, maximum);
}

export function normalizeAccountType(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  const normalized = raw.replace(/[\s-]+/g, "_");
  const compact = raw.replace(/[^a-z0-9]/g, "");
  if (raw === "other") return "other";
  if (nonAccountTypeSignals.has(normalized) || nonAccountTypeSignals.has(compact)) return "unknown";
  for (const [type, aliases] of accountTypeAliases) {
    if (aliases.has(compact)) return type;
  }
  return raw ? "other" : "unknown";
}

export function accountTypeMeta(item) {
  const declaredType = accountSignalText(item, ["account_type", "accountType", "subscription_type", "subscriptionType"], 80);
  const rawType = accountSignalText(item, ["account_type_raw", "accountTypeRaw", "subscription_type_raw", "subscriptionTypeRaw", "plan_type_raw", "planTypeRaw"], 80);
  const declaredKind = normalizeAccountType(declaredType);
  if (declaredKind !== "unknown" && declaredKind !== "other") {
    return { type: declaredKind, raw: declaredType, label: accountTypeText[declaredKind] };
  }
  if (declaredKind === "other") {
    const raw = rawType && normalizeAccountType(rawType) !== "unknown" ? rawType : "";
    return { type: "other", raw, label: raw ? `Other · ${raw}` : accountTypeText.other };
  }
  const candidates = [
    rawType,
    accountSignalText(item, ["plan_name", "planName"], 80),
    accountSignalText(item, ["membership_type", "membershipType", "individual_membership_type", "individualMembershipType"], 80),
    accountSignalText(item, ["plan_type", "planType"], 80),
    accountSignalText(item, ["plan_state", "planState"], 80),
  ].filter(Boolean);
  for (const raw of [...new Set(candidates)]) {
    const type = normalizeAccountType(raw);
    if (type === "unknown") continue;
    if (type === "other") return { type, raw, label: `Other · ${raw}` };
    return { type, raw, label: accountTypeText[type] };
  }
  return { type: "unknown", raw: "", label: accountTypeText.unknown };
}

export function accountGroupMeta(item) {
  const effectiveName = accountSignalText(item, ["group_name", "groupName"], 80);
  const customName = accountSignalText(item, ["custom_group_name", "customGroupName"], 80);
  const defaultName = accountSignalText(item, ["default_group_name", "defaultGroupName"], 80);
  const source = accountSignalText(item, ["group_source", "groupSource"], 20).toLowerCase();
  const name = effectiveName || customName || defaultName;
  const automatic = Boolean(name) && (source === "plan"
    || (!source && !customName && Boolean(defaultName) && name === defaultName));
  return { name, customName, defaultName, source, automatic };
}

export function automaticGroupType(item, groupName) {
  const detected = accountTypeMeta(item).type;
  if (detected !== "unknown") return detected;
  const compactName = String(groupName || "").trim().toLowerCase().replace(/[\s_-]+|套餐/g, "");
  return accountTypeGroupOrder.find((type) => compactName === type
    || compactName === accountTypeText[type].toLowerCase()) || "unknown";
}
