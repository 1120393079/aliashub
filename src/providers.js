export const MAIL_PROVIDERS = {
  microsoft: {
    id: "microsoft",
    name: "Microsoft",
    accountLabel: "Microsoft 邮箱",
    description: "Outlook、Hotmail、Live 与 MSN",
    shortDescription: "Outlook · Hotmail · Live · MSN",
    oauthBase: "/api/microsoft/oauth",
    popupName: "aliashub-microsoft-oauth",
    authMode: "oauth",
    connectionLabel: "OAuth 状态",
    reconnectLabel: "重新授权",
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
    authMode: "oauth",
    connectionLabel: "OAuth 状态",
    reconnectLabel: "重新授权",
    supportsOfficialAliases: false,
    supportsPlusAliases: true,
    capabilityTitle: "支持 Plus 分裂地址",
    capabilityDescription: "Google 不提供官方别名，本系统使用主地址生成 +tag 地址",
  },
  icloud: {
    id: "icloud",
    name: "iCloud",
    accountLabel: "iCloud 邮箱",
    description: "iCloud Mail、me.com 与 mac.com",
    shortDescription: "iCloud Mail · me.com · mac.com",
    authMode: "app_password",
    connectionLabel: "IMAP 状态",
    reconnectLabel: "更新密码",
    supportsOfficialAliases: false,
    supportsPlusAliases: false,
    supportsImportedAliases: true,
    supportsDirectRegistration: true,
    capabilityTitle: "iCloud 邮箱别名 / 隐藏邮箱",
    capabilityDescription: "从 iCloud Mail 导入已创建的邮箱别名或隐藏邮箱，直接用于注册和收取验证码",
  },
};

export function normalizeProvider(value) {
  return Object.hasOwn(MAIL_PROVIDERS, value) ? value : "microsoft";
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

export function accountSupportsImportedAliases(account) {
  if (account?.supports_imported_aliases !== undefined && account?.supports_imported_aliases !== null) return Boolean(account.supports_imported_aliases);
  return Boolean(providerMeta(account?.provider).supportsImportedAliases);
}

export function accountSupportsDirectRegistration(account) {
  if (account?.supports_direct_registration !== undefined && account?.supports_direct_registration !== null) return Boolean(account.supports_direct_registration);
  return Boolean(providerMeta(account?.provider).supportsDirectRegistration);
}

export function accountOptionLabel(account) {
  return `${providerMeta(account?.provider).name} · ${account?.email || ""}`;
}
