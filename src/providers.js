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
    accountLabel: "Apple 账户邮箱",
    description: "任意邮箱注册的 Apple 账户与 iCloud Mail",
    shortDescription: "Apple 账户 · iCloud Mail",
    authMode: "app_password",
    connectionLabel: "IMAP 状态",
    reconnectLabel: "更新密码",
    supportsOfficialAliases: false,
    supportsPlusAliases: false,
    supportsImportedAliases: true,
    supportsDirectRegistration: true,
    capabilityTitle: "iCloud 邮箱别名 / 隐藏邮箱 / 自定义域名",
    capabilityDescription: "手工导入 iCloud 中已创建的邮箱别名、隐藏邮箱或自定义域名邮箱，直接用于注册和收取验证码",
  },
  mailcom: {
    id: "mailcom",
    name: "mail.com",
    accountLabel: "mail.com 母号",
    description: "mail.com 母号与官方分裂别名",
    shortDescription: "mail.com 母号 · 官方分裂别名",
    authMode: "password",
    connectionLabel: "登录状态",
    reconnectLabel: "更新密码",
    supportsOfficialAliases: false,
    supportsPlusAliases: false,
    supportsImportedAliases: true,
    supportsDirectRegistration: true,
    capabilityTitle: "母号与官方分裂别名",
    capabilityDescription: "登记同一母号下的 mail.com 官方别名，共用登录密码和收件箱，可直接用于注册",
  },
  inbox_link: {
    id: "inbox_link",
    name: "链接取件",
    accountLabel: "链接取件邮箱",
    description: "通过已绑定的 dispose.lol 取件链接读取邮件",
    shortDescription: "独立取件邮箱",
    authMode: "inbox_link",
    connectionLabel: "取件链接",
    reconnectLabel: "更新链接",
    supportsOfficialAliases: false,
    supportsPlusAliases: false,
    supportsImportedAliases: false,
    supportsDirectRegistration: false,
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
