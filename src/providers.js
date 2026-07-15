export const MAIL_PROVIDERS = {
  microsoft: {
    id: "microsoft",
    name: "Microsoft",
    accountLabel: "Microsoft 邮箱",
    description: "Outlook、Hotmail、Live 与 MSN",
    shortDescription: "Outlook · Hotmail · Live · MSN",
    oauthBase: "/api/microsoft/oauth",
    popupName: "aliashub-microsoft-oauth",
    supportsOfficialAliases: true,
    supportsPlusAliases: true,
  },
  google: {
    id: "google",
    name: "Google",
    accountLabel: "Google 邮箱",
    description: "Gmail 与 Google Workspace",
    shortDescription: "Gmail · Google Workspace",
    oauthBase: "/api/google/oauth",
    popupName: "aliashub-google-oauth",
    supportsOfficialAliases: false,
    supportsPlusAliases: true,
  },
};

export function normalizeProvider(value) {
  return value === "google" ? "google" : "microsoft";
}

export function providerMeta(value) {
  return MAIL_PROVIDERS[normalizeProvider(value)];
}

export function accountSupportsOfficialAliases(account) {
  if (account?.supports_official_aliases !== undefined && account?.supports_official_aliases !== null) return Boolean(account.supports_official_aliases);
  return providerMeta(account?.provider).supportsOfficialAliases;
}

export function accountSupportsPlusAliases(account) {
  if (account?.supports_plus_aliases !== undefined && account?.supports_plus_aliases !== null) return Boolean(account.supports_plus_aliases);
  return providerMeta(account?.provider).supportsPlusAliases;
}

export function accountOptionLabel(account) {
  return `${providerMeta(account?.provider).name} · ${account?.email || ""}`;
}
