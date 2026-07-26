const nfapiImportedStatuses = new Set(["imported", "created", "updated", "skipped"]);

export const agentIdentityOAuthFallbackCodes = new Set([
  "OPENAI_AGENT_IDENTITY_UNAUTHORIZED",
  "OPENAI_AGENT_IDENTITY_FORBIDDEN",
  "OPENAI_AGENT_IDENTITY_UPSTREAM_CHALLENGE",
]);

export const nfapiImportDefaults = {
  name_prefix: "",
  account_name: "",
  notes: "",
  status: "active",
  model_mapping: "{}",
  proxy_id: "",
  concurrency: 1,
  load_factor: 1,
  priority: 0,
  rate_multiplier: 1,
  expires_at: "",
  auto_pause_on_expired: true,
  temp_unschedulable_enabled: false,
  temp_unschedulable_rules: "[]",
  ws_mode: "off",
  openai_passthrough: false,
  codex_cli_only: false,
  allow_app_server: false,
  compact_mode: "auto",
  compact_model_mapping: "{}",
  image_bridge_mode: "inherit",
  auto_pause_5h_disabled: false,
  auto_pause_5h_threshold: "",
  auto_pause_7d_disabled: false,
  auto_pause_7d_threshold: "",
  group_ids: [],
  update_existing: false,
  skip_default_group_bind: false,
  confirm_mixed_channel_risk: false,
  save_defaults: false,
};

function jsonText(value, fallback) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  return fallback;
}

export function importFormFromDefaults(defaults = {}) {
  const threshold = (value) => value === undefined || value === null || value === "" ? "" : Number(value);
  return {
    ...nfapiImportDefaults,
    ...defaults,
    proxy_id: defaults.proxy_id ?? "",
    group_ids: Array.isArray(defaults.group_ids) ? defaults.group_ids.map(String) : [],
    model_mapping: jsonText(defaults.model_mapping, "{}"),
    compact_model_mapping: jsonText(defaults.compact_model_mapping, "{}"),
    temp_unschedulable_rules: jsonText(defaults.temp_unschedulable_rules, "[]"),
    auto_pause_5h_threshold: threshold(defaults.auto_pause_5h_threshold),
    auto_pause_7d_threshold: threshold(defaults.auto_pause_7d_threshold),
    save_defaults: false,
  };
}

export function apiId(value) {
  return /^\d+$/.test(String(value)) ? Number(value) : value;
}

export function agentIdentityResultMessage(result) {
  if (result?.action === "created") return "NFapi Agent Identity 账号已创建";
  if (result?.action === "skipped") return "NFapi 已有该账号，已按当前策略跳过";
  return "NFapi Agent Identity 凭据已更新";
}

export function nfapiAccountState(item) {
  const details = item.nfapi || {};
  const status = String(item.nfapi_status || details.status || "not_imported").trim().toLowerCase();
  const imported = typeof details.linked === "boolean"
    ? details.linked
    : nfapiImportedStatuses.has(status);
  const shortLived = imported && Boolean(item.nfapi_short_lived ?? details.short_lived);
  return {
    label: imported ? "已导入" : "未导入",
    badge: imported ? (shortLived ? "warning" : "active") : "inactive",
    shortLived,
    accountId: imported ? (item.nfapi_account_id || details.account_id || "") : "",
    error: "",
    updatedAt: imported ? (item.nfapi_updated_at || details.updated_at || "") : "",
  };
}
