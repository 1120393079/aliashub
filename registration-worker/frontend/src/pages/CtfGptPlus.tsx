import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getConfig, getConfigOptions, getPlatforms } from "@/lib/app-data";
import { getCaptchaStrategyLabel } from "@/lib/config-options";
import { apiDownload, apiFetch, triggerBrowserDownload } from "@/lib/utils";
import { formatDateTime, translateAccountStatus } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  buildExecutorOptions,
  buildRegistrationOptions,
  hasReusableOAuthBrowser,
  pickOAuthExecutor,
} from "@/lib/registration";
import {
  getTaskStatusText,
  isTerminalTaskStatus,
  TASK_STATUS_VARIANTS,
} from "@/lib/tasks";
import { TaskLogPanel } from "@/components/tasks/TaskLogPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  CheckCircle,
  Copy,
  CreditCard,
  Download,
  ExternalLink,
  Gauge,
  Loader2,
  Mail,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Smartphone,
  X,
} from "lucide-react";

const DEFAULT_PAYMENT = {
  country: "ID",
  currency: "IDR",
  // 账单地址来源：US 走 meiguodizhi 主接口（``/``），JP 走 ``/jp-address``。
  // 默认 US 保持向下兼容；用户在弹窗里下拉切换。
  address_region: "US",
  headless: "false",
  checkout_mode: "camoufox_headed",
  checkout_timeout: 180,
  checkout_hold_seconds: 10,
  record_har: "false",
  // 是否调用 YesCaptcha 接码服务自动求解 hCaptcha/reCAPTCHA/Turnstile。
  // 默认 "false"——用户实战 hCaptcha 会被 YesCaptcha 拒识 ERROR_DOMAIN_NOT_ALLOWED
  // 烧配额；干净 BitBrowser profile 下"代码点击 + 10s 等"通常更稳。需要时
  // 用户在弹窗里手动开启。
  use_captcha_service: "false",
  // 协议长链：用 accessToken/Stripe direct confirm 生成 PayPal 授权长链接，再交给浏览器流程。
  // 默认 "false" 沿用原行为。
  use_stripe_init: "false",
  // 短链：checkout_ui_mode=custom → chatgpt.com/checkout/openai_llc 短链。
  use_short_link: "false",
  // SMS 号码池（多行 `+phone----relay_url`），PayPal OTP 用。空串=不启用。
  sms_pool: "",
};

const BROWSER_MODE_OPTIONS = [
  { value: "camoufox_headed", label: "Camoufox 前台" },
  { value: "camoufox_headless", label: "Camoufox 后台" },
  { value: "bitbrowser_headed", label: "BitBrowser 前台" },
  { value: "bitbrowser_hidden", label: "BitBrowser 隐藏" },
  { value: "bitbrowser_headless", label: "BitBrowser 后台" },
];

const EMPTY_CONFIG_OPTIONS = {
  mailbox_providers: [],
  captcha_providers: [],
  mailbox_settings: [],
  captcha_settings: [],
  captcha_policy: {},
  executor_options: [],
  identity_mode_options: [],
  oauth_provider_options: [],
};

function getAccountOverview(acc: any) {
  return acc?.overview && typeof acc.overview === "object" ? acc.overview : {};
}

function getDisplaySummary(acc: any) {
  return acc?.display_summary && typeof acc.display_summary === "object"
    ? acc.display_summary
    : {};
}

function getLifecycleStatus(acc: any) {
  return (
    getDisplaySummary(acc)?.status?.lifecycle ||
    acc?.lifecycle_status ||
    "registered"
  );
}

function getPlanState(acc: any) {
  return (
    getDisplaySummary(acc)?.status?.plan_state ||
    acc?.plan_state ||
    acc?.overview?.plan_state ||
    "unknown"
  );
}

function getPlanName(acc: any) {
  const overview = getAccountOverview(acc);
  return (
    acc?.plan_name ||
    overview?.plan_name ||
    overview?.plan ||
    overview?.membership_type ||
    ""
  );
}

function getDisplayStatus(acc: any) {
  return (
    getDisplaySummary(acc)?.status?.display ||
    acc?.display_status ||
    acc?.plan_state ||
    getLifecycleStatus(acc)
  );
}

function getCashierUrl(acc: any) {
  const overview = getAccountOverview(acc);
  return overview?.cashier_url || acc?.cashier_url || "";
}

function getDisplayBadges(acc: any) {
  const badges = getDisplaySummary(acc)?.badges;
  return Array.isArray(badges) ? badges : [];
}

function isPhoneBound(acc: any) {
  const binding = getAccountOverview(acc)?.phone_binding;
  return Boolean(
    binding && typeof binding === "object" && binding.status === "bound",
  );
}

function isCtfExported(acc: any) {
  const data = getAccountOverview(acc)?.ctf_gpt_plus;
  return Boolean(data && typeof data === "object" && data.exported === true);
}

// 历史遗留：原来用于"只展示完成过 CTF Plus 链路的账户"。现在列表加载所有
// chatgpt 账号，不再使用此过滤。保留函数体方便回滚，加 ``void`` 关闭 TS6133。
function isPlusAccount(acc: any) {
  const overview = getAccountOverview(acc);
  const chips = Array.isArray(overview?.chips) ? overview.chips.join(" ") : "";
  const planText = [
    getPlanState(acc),
    getPlanName(acc),
    overview?.plan,
    overview?.membership_type,
    chips,
  ]
    .join(" ")
    .toLowerCase();
  if (planText.includes("plus") || planText.includes("team")) return true;
  if (getPlanState(acc) === "subscribed") return true;
  // free / expired 状态但有 cashier_url（曾经下过单 / 走过 CTF）也保留
  if (getCashierUrl(acc)) return true;
  if (planText.includes("free") || planText.includes("expired")) return true;
  return false;
}
void isPlusAccount;

function getDefaultProviderKey(settings: any[] = []) {
  return (
    settings.find((item) => item.is_default)?.provider_key ||
    settings[0]?.provider_key ||
    ""
  );
}

function copyText(text: string) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text);
    return;
  }
  const el = document.createElement("textarea");
  el.value = text;
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  document.body.removeChild(el);
}

function emailApiLine(email: string) {
  return email;
}

function GeneratePlusModal({
  platformMeta,
  onClose,
  onDone,
  reuseAccountId,
  reuseAccountEmail,
}: {
  platformMeta: any;
  onClose: () => void;
  onDone: () => void;
  // 传入时表示"复用已选账号生成支付链接"模式：跳过注册，直接调
  // ``POST /api/actions/chatgpt/{id}/payment_link`` action 让后端用既有
  // access_token 走 cashier API 拿 url 并自动 PayPal checkout。
  reuseAccountId?: number | null;
  reuseAccountEmail?: string;
}) {
  const { t, language } = useI18n();
  const [config, setConfig] = useState<Record<string, any>>({});
  const [configOptions, setConfigOptions] = useState<any>(EMPTY_CONFIG_OPTIONS);
  const [configLoading, setConfigLoading] = useState(true);
  const [count, setCount] = useState(1);
  const [concurrency, setConcurrency] = useState(1);
  const [selection, setSelection] = useState({
    identityProvider: "",
    oauthProvider: "",
    executorType: "",
  });
  const [payment, setPayment] =
    useState<Record<string, string | number>>(DEFAULT_PAYMENT);
  const [taskId, setTaskId] = useState("");
  const [taskStatus, setTaskStatus] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const openedTaskIdsRef = useRef<Set<string>>(new Set());

  const supportedExecutors: string[] = platformMeta?.supported_executors || [];
  const registrationOptions = useMemo(
    () => buildRegistrationOptions(platformMeta, language),
    [platformMeta, language],
  );
  const reusableBrowser = hasReusableOAuthBrowser(config);
  const executorOptions = buildExecutorOptions(
    selection.identityProvider,
    supportedExecutors,
    reusableBrowser,
    platformMeta?.supported_executor_options || [],
    language,
  );
  const enabledExecutorOptions = executorOptions.filter(
    (option) => !option.disabled,
  );
  const selectedRegistration = registrationOptions.find(
    (option) =>
      option.identityProvider === selection.identityProvider &&
      option.oauthProvider === selection.oauthProvider,
  );
  const selectedExecutor = executorOptions.find(
    (option) => option.value === selection.executorType,
  );
  const defaultMailboxProvider = getDefaultProviderKey(
    configOptions.mailbox_settings || [],
  );

  useEffect(() => {
    let active = true;
    setConfigLoading(true);
    Promise.all([
      getConfig().catch(() => ({})),
      getConfigOptions().catch(() => EMPTY_CONFIG_OPTIONS),
    ])
      .then(([cfg, options]) => {
        if (!active) return;
        setConfig(cfg || {});
        setConfigOptions(options || EMPTY_CONFIG_OPTIONS);
      })
      .finally(() => {
        if (active) setConfigLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (configLoading || registrationOptions.length === 0) return;
    const defaultRegistration =
      registrationOptions.find(
        (option) =>
          option.identityProvider === config.default_identity_provider &&
          (option.identityProvider !== "oauth_browser" ||
            option.oauthProvider === (config.default_oauth_provider || "")),
      ) || registrationOptions[0];
    setSelection((current) => {
      const identityProvider =
        current.identityProvider || defaultRegistration.identityProvider;
      const oauthProvider =
        identityProvider === "oauth_browser"
          ? current.oauthProvider || defaultRegistration.oauthProvider
          : "";
      const options = buildExecutorOptions(
        identityProvider,
        supportedExecutors,
        reusableBrowser,
        platformMeta?.supported_executor_options || [],
        language,
      ).filter((option) => !option.disabled);
      const preferredExecutor =
        identityProvider === "oauth_browser"
          ? pickOAuthExecutor(
              supportedExecutors,
              config.default_executor || "",
              reusableBrowser,
            )
          : config.default_executor &&
              supportedExecutors.includes(config.default_executor)
            ? config.default_executor
            : supportedExecutors[0] || "";
      const executorType = options.some(
        (option) => option.value === current.executorType,
      )
        ? current.executorType
        : options.find((option) => option.value === preferredExecutor)?.value ||
          options[0]?.value ||
          "";
      if (
        current.identityProvider === identityProvider &&
        current.oauthProvider === oauthProvider &&
        current.executorType === executorType
      ) {
        return current;
      }
      return { identityProvider, oauthProvider, executorType };
    });
  }, [
    config,
    configLoading,
    language,
    platformMeta,
    registrationOptions,
    reusableBrowser,
    supportedExecutors,
  ]);

  useEffect(() => {
    if (!selection.identityProvider || enabledExecutorOptions.length === 0)
      return;
    if (
      !enabledExecutorOptions.some(
        (option) => option.value === selection.executorType,
      )
    ) {
      setSelection((current) => ({
        ...current,
        executorType: enabledExecutorOptions[0]?.value || "",
      }));
    }
  }, [
    enabledExecutorOptions,
    selection.executorType,
    selection.identityProvider,
  ]);

  // 短链物理复用：注册和打开短链必须同一浏览器，所以付款 checkout_mode 强制
  // 跟随注册的 executorType（两个浏览器选项合并成一个）。短链 off 时不干预。
  const isShortLink = String(payment.use_short_link) === "true";
  useEffect(() => {
    if (!isShortLink) return;
    const reg = String(selection.executorType || "");
    // 只在注册用的是浏览器模式时同步（protocol 注册没浏览器可复用）。
    if (reg && reg !== "protocol" && String(payment.checkout_mode) !== reg) {
      setPayment((cur) => ({ ...cur, checkout_mode: reg }));
    }
  }, [isShortLink, selection.executorType, payment.checkout_mode]);

  const updatePayment = (key: string, value: string | number) => {
    setPayment((current) => ({ ...current, [key]: value }));
  };

  const applyTerminalTask = useCallback(
    async (latest: any) => {
      const latestStatus = String(latest?.status || "");
      setTaskStatus(latestStatus);
      const latestTaskId = String(
        latest?.task_id || latest?.id || taskId || "",
      );
      if (
        latestTaskId &&
        isTerminalTaskStatus(latestStatus) &&
        !openedTaskIdsRef.current.has(latestTaskId)
      ) {
        openedTaskIdsRef.current.add(latestTaskId);
        const urls = Array.isArray(latest?.cashier_urls)
          ? latest.cashier_urls
          : [];
        if (urls.length > 0) {
          urls.forEach((url: string) => window.open(url, "_blank"));
        }
        onDone();
      }
    },
    [onDone, taskId],
  );

  const start = async () => {
    setError("");
    // 复用已选账号模式：跳过身份/注册校验，直接调 payment_link action。
    // 该 action 内部会用账号 access_token 调 ChatGPT cashier API 拿
    // checkout url，再按相同 chatgpt_payment params 走 PayPal 自动 checkout。
    if (reuseAccountId) {
      setStarting(true);
      try {
        const params: Record<string, any> = {
          plan: "plus",
          country: payment.country,
          currency: payment.currency,
          auto_checkout: "true",
          payment_method: "paypal",
          headless:
            payment.checkout_mode === "camoufox_headless" ? "true" : "false",
          checkout_mode: payment.checkout_mode,
          checkout_timeout: Number(
            payment.checkout_timeout || DEFAULT_PAYMENT.checkout_timeout,
          ),
          checkout_hold_seconds: Number(
            payment.checkout_hold_seconds ||
              DEFAULT_PAYMENT.checkout_hold_seconds,
          ),
          record_har: payment.record_har,
          use_captcha_service: payment.use_captcha_service,
          use_stripe_init: payment.use_stripe_init,
          use_short_link: payment.use_short_link,
          proxy_region: payment.country,
          address_region: payment.address_region || "US",
          sms_pool: payment.sms_pool,
          // 强制重新生成（用户每次点都期望换一条新链接），
          // 避免后端因 cashier_url 已在 extra 里就直接跳过重新拉取。
          regenerate: "true",
        };
        const created = await apiFetch(
          `/actions/chatgpt/${reuseAccountId}/payment_link`,
          { method: "POST", body: JSON.stringify({ params }) },
        );
        // payment_link 是 async action，后端返回 task 元信息。
        setTaskId(String(created?.task_id || created?.id || ""));
        setTaskStatus(String(created?.status || "pending"));
      } catch (exc: any) {
        setError(exc?.message || t("login.requestFailed"));
      } finally {
        setStarting(false);
      }
      return;
    }
    if (selection.identityProvider === "mailbox" && !defaultMailboxProvider) {
      setError(t("accounts.missingDefaultMailbox"));
      return;
    }
    // 强校验 SMS 号码池：每个**并发**线程独占一条号——所以池大小要
    // ≥ concurrency（**不是** count）。注册数量可以超过并发数，每批跑完
    // 槽位释放给下一批复用。校验逻辑跟后端 ``_execute_register_task`` 保持一致。
    const validSmsLines = String(payment.sms_pool || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .filter((l) => /^\+?\d{6,16}\s*-{3,}\s*https?:\/\/\S+/.test(l));
    const requestedConcurrency = Math.min(
      Math.max(Number(concurrency || 1), 1),
      Math.max(Number(count || 1), 1),
      5,
    );
    if (validSmsLines.length < requestedConcurrency) {
      setError(
        t("ctfGptPlus.smsPoolNotEnough")
          .replace("{need}", String(requestedConcurrency))
          .replace("{have}", String(validSmsLines.length)),
      );
      return;
    }
    setStarting(true);
    try {
      const extra: Record<string, any> = {
        identity_provider: selection.identityProvider,
        oauth_provider: selection.oauthProvider,
        oauth_email_hint: config.oauth_email_hint,
        chrome_user_data_dir: config.chrome_user_data_dir,
        chrome_cdp_url: config.chrome_cdp_url,
        auto_chatgpt_plus_payment: true,
        chatgpt_payment: {
          plan: "plus",
          country: payment.country,
          currency: payment.currency,
          auto_checkout: "true",
          payment_method: "paypal",
          headless:
            payment.checkout_mode === "camoufox_headless" ? "true" : "false",
          checkout_mode: payment.checkout_mode,
          checkout_timeout: Number(
            payment.checkout_timeout || DEFAULT_PAYMENT.checkout_timeout,
          ),
          checkout_hold_seconds: Number(
            payment.checkout_hold_seconds ||
              DEFAULT_PAYMENT.checkout_hold_seconds,
          ),
          record_har: payment.record_har,
          // 是否启用 YesCaptcha 求解。"false" 时后端的 turnstile_solver 会
          // 强制传 None，captcha 路径退化为"代码鼠标点击 + 10s 等转跳"。
          use_captcha_service: payment.use_captcha_service,
          use_stripe_init: payment.use_stripe_init,
          use_short_link: payment.use_short_link,
          proxy_region: payment.country,
          // 账单地址来源：US 走 meiguodizhi 主接口，JP 走 /jp-address。
          // 让 IP 在日本时也能拿到日文地址 + 日本邮编避免 PayPal 风控。
          address_region: payment.address_region || "US",
          // 号码池 textarea 原样透传给后端，由 parse_sms_pool 切分。
          sms_pool: payment.sms_pool,
        },
      };
      if (selection.identityProvider === "mailbox") {
        extra.mail_provider = defaultMailboxProvider;
      }
      const created = await apiFetch("/tasks/register", {
        method: "POST",
        body: JSON.stringify({
          platform: "chatgpt",
          count: Math.max(Number(count || 1), 1),
          concurrency: Math.min(
            Math.max(Number(concurrency || 1), 1),
            Math.max(Number(count || 1), 1),
            5,
          ),
          proxy: null,
          executor_type: selection.executorType,
          captcha_solver: "auto",
          extra,
        }),
      });
      setTaskId(String(created?.task_id || created?.id || ""));
      setTaskStatus(String(created?.status || "pending"));
    } catch (exc: any) {
      setError(exc?.message || t("login.requestFailed"));
    } finally {
      setStarting(false);
    }
  };

  const handleTaskDone = useCallback(async () => {
    if (!taskId) return;
    try {
      const latest = await apiFetch(`/tasks/${taskId}`);
      await applyTerminalTask(latest);
    } catch {
      onDone();
    }
  }, [applyTerminalTask, onDone, taskId]);

  const numberInput = (
    label: string,
    value: number,
    onChange: (value: number) => void,
    min = 1,
    max?: number,
  ) => (
    <div>
      <label className="mb-1 block text-xs text-[var(--text-muted)]">
        {label}
      </label>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="control-surface control-surface-compact text-center"
      />
    </div>
  );

  const dialog = (
    <div className="dialog-backdrop" onClick={!taskId ? onClose : undefined}>
      <div
        className="dialog-panel dialog-panel-lg flex max-h-[90vh] flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              {reuseAccountId
                ? "复用账号生成 Plus 链接"
                : "生成 GPT Plus 账户"}
            </h2>
            <div className="mt-1 text-xs text-[var(--text-muted)]">
              {reuseAccountId ? (
                <>
                  跳过注册，直接用已选账号
                  {reuseAccountEmail ? (
                    <span className="ml-1 font-mono text-[var(--text-primary)]">
                      {reuseAccountEmail}
                    </span>
                  ) : null}
                  {" 生成支付链接并自动 PayPal checkout。"}
                </>
              ) : (
                "自动注册 ChatGPT 账户，成功后生成并执行 Plus 测试支付链路。"
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!taskId ? (
            configLoading ? (
              <div className="text-sm text-[var(--text-muted)]">
                {t("accounts.loadingRegistrationConfig")}
              </div>
            ) : (
              <div className="space-y-5">
                {!reuseAccountId && (
                  <>
                    <section>
                      <div className="text-sm font-semibold text-[var(--text-primary)]">
                        {t("accounts.selectIdentity")}
                      </div>
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        {registrationOptions.map((option) => {
                          const active =
                            selection.identityProvider ===
                              option.identityProvider &&
                            selection.oauthProvider === option.oauthProvider;
                          return (
                            <button
                              key={option.key}
                              type="button"
                              onClick={() =>
                                setSelection((current) => ({
                                  ...current,
                                  identityProvider: option.identityProvider,
                                  oauthProvider: option.oauthProvider,
                                }))
                              }
                              className={`rounded-lg border px-4 py-3 text-left transition-colors ${
                                active
                                  ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                                  : "border-[var(--border)] bg-[var(--bg-pane)]/45 hover:border-[var(--accent)]/60"
                              }`}
                            >
                              <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                                {option.identityProvider === "mailbox" ? (
                                  <Mail className="h-4 w-4 text-[var(--accent)]" />
                                ) : (
                                  <ShieldCheck className="h-4 w-4 text-[var(--accent)]" />
                                )}
                                {option.label}
                              </div>
                              <div className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                                {option.description}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </section>

                    <section>
                      <div className="text-sm font-semibold text-[var(--text-primary)]">
                        {t("ctfGptPlus.registerMode")}
                      </div>
                      <div className="mt-3">
                        <select
                          value={selection.executorType}
                          onChange={(event) => {
                            const next = event.target.value;
                            const matched = executorOptions.find(
                              (option) => option.value === next,
                            );
                            if (matched && matched.disabled) return;
                            setSelection((current) => ({
                              ...current,
                              executorType: next,
                            }));
                          }}
                          className="control-surface control-surface-compact w-full"
                        >
                          <option value="">
                            {t("accounts.selectExecutorPlaceholder")}
                          </option>
                          {executorOptions.map((option) => (
                            <option
                              key={option.value}
                              value={option.value}
                              disabled={option.disabled}
                            >
                              {option.label}
                              {option.disabled ? " (不可用)" : ""}
                            </option>
                          ))}
                        </select>
                        {(() => {
                          const matched = executorOptions.find(
                            (option) =>
                              option.value === selection.executorType,
                          );
                          return matched?.description ? (
                            <div className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                              {matched.description}
                            </div>
                          ) : null;
                        })()}
                        {isShortLink &&
                          (selection.executorType === "protocol" ||
                            !selection.executorType) && (
                            <div className="mt-1 text-xs leading-5 text-amber-500">
                              ⚠ 短链模式必须用浏览器注册（注册和打开短链要复用同一个浏览器）。
                              当前选的是协议注册，会被自动改成 Camoufox 前台。建议直接选一个浏览器注册模式
                              （Camoufox / BitBrowser）。
                            </div>
                          )}
                      </div>
                    </section>
                  </>
                )}

                <section>
                  <div className="text-sm font-semibold text-[var(--text-primary)]">
                    {t("ctfGptPlus.paymentMode")}
                  </div>
                  {isShortLink ? (
                    <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs leading-5 text-[var(--text-muted)]">
                      短链模式：付款与注册<strong>共用同一个浏览器</strong>（物理复用），
                      浏览器模式跟随上方「注册模式」的选择
                      （当前：<strong>{String(payment.checkout_mode) || "—"}</strong>）。
                      短链是 ChatGPT 托管页、URL 无 token，必须用注册时那个已登录的浏览器打开，
                      所以这里不单独选浏览器。注册用 protocol 时短链会自动改用 Camoufox 前台。
                    </div>
                  ) : (
                    <div className="mt-3">
                      <select
                        value={String(payment.checkout_mode)}
                        onChange={(event) =>
                          updatePayment("checkout_mode", event.target.value)
                        }
                        className="control-surface control-surface-compact w-full"
                      >
                        <option value="protocol">
                          {t("choice.executor.protocol")}
                        </option>
                        <option value="camoufox_headless">
                          {t("ctfGptPlus.camoufoxBackground")}
                        </option>
                        <option value="camoufox_headed">
                          {t("ctfGptPlus.camoufoxForeground")}
                        </option>
                        <option value="bitbrowser_headed">
                          {t("ctfGptPlus.bitbrowserHeaded")}
                        </option>
                        <option value="bitbrowser_hidden">
                          {t("ctfGptPlus.bitbrowserHidden")}
                        </option>
                        <option value="bitbrowser_headless">
                          {t("ctfGptPlus.bitbrowserHeadless")}
                        </option>
                      </select>
                      {String(payment.checkout_mode).startsWith(
                        "bitbrowser_",
                      ) && (
                        <div className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                          {t("ctfGptPlus.bitbrowserPoolHint")}
                        </div>
                      )}
                    </div>
                  )}
                </section>

                <section className="grid gap-3 md:grid-cols-4">
                  {!reuseAccountId &&
                    numberInput(
                      t("accounts.registrationCount"),
                      count,
                      setCount,
                      1,
                      99,
                    )}
                  {!reuseAccountId &&
                    numberInput(
                      t("accounts.concurrency"),
                      concurrency,
                      setConcurrency,
                      1,
                      5,
                    )}
                  <div>
                    <label className="mb-1 block text-xs text-[var(--text-muted)]">
                      {t("ctfGptPlus.country")}
                    </label>
                    <select
                      value={payment.country}
                      onChange={(event) =>
                        updatePayment("country", event.target.value)
                      }
                      className="control-surface control-surface-compact"
                    >
                      {["ID", "US", "SG", "HK", "JP", "GB", "AU", "CA", "EU"].map(
                        (value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ),
                      )}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-[var(--text-muted)]">
                      {t("ctfGptPlus.addressRegion")}
                    </label>
                    <select
                      value={payment.address_region || "US"}
                      onChange={(event) =>
                        updatePayment("address_region", event.target.value)
                      }
                      className="control-surface control-surface-compact"
                      title={t("ctfGptPlus.addressRegionHint")}
                    >
                      <option value="US">
                        {t("ctfGptPlus.addressRegionUS")}
                      </option>
                      <option value="JP">
                        {t("ctfGptPlus.addressRegionJP")}
                      </option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-[var(--text-muted)]">
                      {t("ctfGptPlus.currency")}
                    </label>
                    <select
                      value={payment.currency}
                      onChange={(event) =>
                        updatePayment("currency", event.target.value)
                      }
                      className="control-surface control-surface-compact"
                    >
                      {[
                        "IDR",
                        "USD",
                        "SGD",
                        "HKD",
                        "JPY",
                        "GBP",
                        "AUD",
                        "CAD",
                        "EUR",
                      ].map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </div>
                  {numberInput(
                    t("ctfGptPlus.timeout"),
                    Number(payment.checkout_timeout),
                    (value) => updatePayment("checkout_timeout", value),
                    30,
                  )}
                  {numberInput(
                    t("ctfGptPlus.hold"),
                    Number(payment.checkout_hold_seconds),
                    (value) => updatePayment("checkout_hold_seconds", value),
                    0,
                  )}
                  <div>
                    <label className="mb-1 block text-xs text-[var(--text-muted)]">
                      {t("ctfGptPlus.recordHar")}
                    </label>
                    <select
                      value={String(payment.record_har)}
                      onChange={(event) =>
                        updatePayment("record_har", event.target.value)
                      }
                      className="control-surface control-surface-compact"
                    >
                      <option value="false">{t("common.no")}</option>
                      <option value="true">{t("common.yes")}</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-[var(--text-muted)]">
                      {t("ctfGptPlus.useCaptchaService")}
                    </label>
                    <select
                      value={String(payment.use_captcha_service)}
                      onChange={(event) =>
                        updatePayment(
                          "use_captcha_service",
                          event.target.value,
                        )
                      }
                      className="control-surface control-surface-compact"
                    >
                      <option value="false">{t("common.no")}</option>
                      <option value="true">{t("common.yes")}</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-[var(--text-muted)]">
                      协议生成 PayPal 授权长链
                    </label>
                    <select
                      value={String(payment.use_stripe_init)}
                      onChange={(event) =>
                        updatePayment("use_stripe_init", event.target.value)
                      }
                      className="control-surface control-surface-compact"
                      title="用 accessToken 协议生成 pm-redirects PayPal 授权长链接，再交给所选浏览器模式继续自动填写"
                    >
                      <option value="false">{t("common.no")}</option>
                      <option value="true">{t("common.yes")}</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-[var(--text-muted)]">
                      短链
                    </label>
                    <select
                      value={String(payment.use_short_link)}
                      onChange={(event) =>
                        updatePayment("use_short_link", event.target.value)
                      }
                      className="control-surface control-surface-compact"
                      title="checkout_ui_mode=custom + all_plans_pricing_modal 入口、无优惠券，返回 chatgpt.com/checkout/openai_llc/<id> 短链（与 Stripe 长链二选一，短链优先）"
                    >
                      <option value="false">{t("common.no")}</option>
                      <option value="true">{t("common.yes")}</option>
                    </select>
                  </div>
                </section>

                {/* SMS 号码池：PayPal SignUp 触发 PHONE_CONFIRMATION_REQUIRED 时
                    需要从这里挑一对 (phone, relay_url) 走 OTP 子链。每行一条，
                    格式 `+phone----relay_url`，留空则不启用 OTP 子链。 */}
                <section className="space-y-1">
                  <label className="block text-xs text-[var(--text-muted)]">
                    {t("ctfGptPlus.smsPoolLabel")}
                  </label>
                  <textarea
                    value={payment.sms_pool}
                    onChange={(event) =>
                      updatePayment("sms_pool", event.target.value)
                    }
                    placeholder={t("ctfGptPlus.smsPoolPlaceholder")}
                    rows={4}
                    spellCheck={false}
                    className="control-surface control-surface-compact w-full font-mono text-xs leading-relaxed"
                  />
                  <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">
                    {t("ctfGptPlus.smsPoolHelp")}
                  </p>
                </section>

                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-hover)] px-4 py-3 text-xs text-[var(--text-secondary)]">
                  {!reuseAccountId ? (
                    <>
                      <div>
                        {t("accounts.identitySummary")}:{" "}
                        <span className="text-[var(--text-primary)]">
                          {selectedRegistration?.label || "-"}
                        </span>
                      </div>
                      <div className="mt-1">
                        {t("accounts.executorSummary")}:{" "}
                        <span className="text-[var(--text-primary)]">
                          {selectedExecutor?.label || "-"}
                        </span>
                      </div>
                      <div className="mt-1">
                        {t("accounts.verificationSummary")}:{" "}
                        <span className="text-[var(--text-primary)]">
                          {getCaptchaStrategyLabel(
                            selection.executorType,
                            configOptions.captcha_policy,
                            configOptions.captcha_providers,
                            language,
                          )}
                        </span>
                      </div>
                    </>
                  ) : (
                    <div>
                      复用账号:{" "}
                      <span className="font-mono text-[var(--text-primary)]">
                        {reuseAccountEmail || `#${reuseAccountId}`}
                      </span>
                    </div>
                  )}
                  <div className="mt-1">
                    Plan:{" "}
                    <span className="text-[var(--text-primary)]">
                      ChatGPT Plus / PayPal
                    </span>
                  </div>
                </div>

                {error ? (
                  <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                    {error}
                  </div>
                ) : null}

                <Button
                  onClick={start}
                  disabled={
                    starting ||
                    (!reuseAccountId &&
                      (!selection.identityProvider ||
                        !selection.executorType))
                  }
                  className="w-full"
                >
                  {starting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t("ctfGptPlus.running")}
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-2 h-4 w-4" />
                      {reuseAccountId
                        ? "生成 Plus 链接并 checkout"
                        : t("ctfGptPlus.start")}
                    </>
                  )}
                </Button>
              </div>
            )
          ) : (
            <div className="space-y-3">
              {taskStatus ? (
                <Badge
                  variant={TASK_STATUS_VARIANTS[taskStatus] || "secondary"}
                >
                  {getTaskStatusText(taskStatus, language)}
                </Badge>
              ) : null}
              <TaskLogPanel taskId={taskId} onDone={handleTaskDone} />
            </div>
          )}
        </div>
        <div className="flex justify-end border-t border-[var(--border)] px-6 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined"
    ? createPortal(dialog, document.body)
    : dialog;
}

export default function CtfGptPlus() {
  const { t, language } = useI18n();
  const [platforms, setPlatforms] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  // 保留 ``total`` 变量是为兼容老 setTotal 调用（即便 UI 暂时不展示数量），
  // 加个 ``void`` 让 tsc strict 不报 unused warning。
  void total;
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [error, setError] = useState("");
  const [showGenerate, setShowGenerate] = useState(false);
  const [showBind, setShowBind] = useState(false);
  const [phoneLines, setPhoneLines] = useState("");
  const [binding, setBinding] = useState(false);
  const [bindTaskId, setBindTaskId] = useState("");
  const [bindResult, setBindResult] = useState<any>(null);
  const [bindFilter, setBindFilter] = useState<"all" | "bound" | "unbound">(
    "all",
  );
  const [exportFilter, setExportFilter] = useState<"unexported" | "exported">(
    "unexported",
  );
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [exportFormat, setExportFormat] = useState("email-api");
  const [browserMode, setBrowserMode] = useState("camoufox_headed");
  const [actionConcurrency, setActionConcurrency] = useState(1);
  const [oauthTaskId, setOauthTaskId] = useState("");
  const [oauthModal, setOauthModal] = useState<any>(null);
  const [oauthCallbackUrl, setOauthCallbackUrl] = useState("");
  const [oauthBusy, setOauthBusy] = useState(false);
  const [quotaBusy, setQuotaBusy] = useState(false);
  // 点击顶部"Codex OAuth"按钮先弹这个确认对话框选浏览器模式 / 并发数，
  // 之前是直接用顶部工具栏的两个控件——按用户诉求把它们移进来。
  const [oauthConfirmOpen, setOauthConfirmOpen] = useState(false);

  useEffect(() => {
    getPlatforms()
      .then(setPlatforms)
      .catch(() => setPlatforms([]));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  const platformMeta = useMemo(
    () => platforms.find((item: any) => item.name === "chatgpt") || null,
    [platforms],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // 列表加载所有 chatgpt 账号——不再按 ``status=subscribed`` 过滤、
      // 也不再客户端 ``isPlusAccount`` 截留。诉求是"复用任何已注册账户去
      // 生成 Plus 链接"，未订阅账号也要可见。``page_size=1000`` 足够覆盖
      // 一般场景，超出时下面 setTotal 仍按返回条数走，用户能感知截断。
      const params = new URLSearchParams({
        platform: "chatgpt",
        page: "1",
        page_size: "1000",
      });
      if (debouncedSearch) params.set("email", debouncedSearch);
      const data = await apiFetch(`/accounts?${params}`);
      const items = Array.isArray(data?.items) ? data.items : [];
      setAccounts(items);
      setTotal(items.length);
    } catch (exc: any) {
      setError(exc?.message || t("login.requestFailed"));
      setAccounts([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, t]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const visibleIds = new Set(accounts.map((acc) => Number(acc.id)));
    setSelectedIds(
      (current) => new Set([...current].filter((id) => visibleIds.has(id))),
    );
  }, [accounts]);

  const filteredAccounts = useMemo(
    () =>
      accounts.filter((acc) => {
        const matchesBind =
          bindFilter === "all" ||
          (bindFilter === "bound" && isPhoneBound(acc)) ||
          (bindFilter === "unbound" && !isPhoneBound(acc));
        const matchesExport =
          (exportFilter === "exported" && isCtfExported(acc)) ||
          (exportFilter === "unexported" && !isCtfExported(acc));
        return matchesBind && matchesExport;
      }),
    [accounts, bindFilter, exportFilter],
  );
  const selectedCount = selectedIds.size;
  const allVisibleSelected =
    filteredAccounts.length > 0 &&
    filteredAccounts.every((acc) => selectedIds.has(Number(acc.id)));

  const toggleAccount = (id: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        filteredAccounts.forEach((acc) => next.delete(Number(acc.id)));
      } else {
        filteredAccounts.forEach((acc) => next.add(Number(acc.id)));
      }
      return next;
    });
  };

  const startPhoneBind = async () => {
    setError("");
    const ids = [...selectedIds];
    const fallbackIds = filteredAccounts
      .filter((acc) => !isPhoneBound(acc))
      .map((acc) => Number(acc.id));
    if (!phoneLines.trim()) {
      setError("请先输入手机号和 SMS API");
      return;
    }
    if (ids.length === 0 && fallbackIds.length === 0) {
      setError("没有可绑定的未绑账户");
      return;
    }
    setBinding(true);
    try {
      const result = await apiFetch("/tasks/phone-bind", {
        method: "POST",
        body: JSON.stringify({
          platform: "chatgpt",
          ids,
          fallback_ids: ids.length > 0 ? [] : fallbackIds,
          phone_lines: phoneLines,
          browser_mode: browserMode,
          concurrency: Math.max(Number(actionConcurrency || 1), 1),
        }),
      });
      setBindTaskId(result.task_id || result.id || "");
    } catch (exc: any) {
      setError(exc?.message || t("login.requestFailed"));
      setBinding(false);
    }
  };

  const handleBindTaskDone = useCallback(async () => {
    if (!bindTaskId) return;
    setBinding(false);
    try {
      const task = await apiFetch(`/tasks/${bindTaskId}`);
      const result = task?.result?.data || task?.data;
      if (result) setBindResult(result);
      setShowBind(false);
      setBindTaskId("");
      setPhoneLines("");
      setSelectedIds(new Set());
      await load();
    } catch {
      await load();
    }
  }, [bindTaskId, load]);

  const exportSelected = async () => {
    setError("");
    const ids = [...selectedIds];
    if (ids.length === 0) {
      setError("请先勾选要导出的账户");
      return;
    }
    const pathByFormat: Record<string, string> = {
      "email-api": "/accounts/export/email-api",
      cpa: "/accounts/export/cpa",
      sub2api: "/accounts/export/sub2api",
      cockpit: "/accounts/export/cockpit",
    };
    try {
      const { blob, filename } = await apiDownload(pathByFormat[exportFormat], {
        method: "POST",
        body: JSON.stringify({ platform: "chatgpt", ids }),
      });
      triggerBrowserDownload(blob, filename);
      await markExportStatus(ids, true);
      setSelectedIds(new Set());
      await load();
    } catch (exc: any) {
      setError(exc?.message || t("login.requestFailed"));
    }
  };

  const markExportStatus = async (ids: number[], exported: boolean) => {
    if (ids.length === 0) return;
    await apiFetch("/accounts/ctf-gpt-plus/export-status", {
      method: "POST",
      body: JSON.stringify({ ids, exported }),
    });
  };

  const moveExportStatus = async (id: number, exported: boolean) => {
    setError("");
    try {
      await markExportStatus([id], exported);
      await load();
    } catch (exc: any) {
      setError(exc?.message || t("login.requestFailed"));
    }
  };


  // "刷新配额"——只刷新**当前勾选的账户**（用户诉求："勾了哪些跑哪些"）。
  // 后端 ``POST /api/accounts/refresh-plan?platform=chatgpt`` body 里带
  // ``{ids: [...]}``。一个都没勾选时给个提示，不再默认全跑（避免 100+ 号
  // 一次刷干死 ChatGPT 限流和后端超时）。
  const refreshQuota = async () => {
    setError("");
    const ids = [...selectedIds];
    if (ids.length === 0) {
      setError("请先勾选至少 1 个账户再刷新配额");
      return;
    }
    setQuotaBusy(true);
    try {
      const result = await apiFetch(
        "/accounts/refresh-plan?platform=chatgpt",
        {
          method: "POST",
          body: JSON.stringify({ ids }),
        },
      );
      const updated = Number(result?.updated || 0);
      const total = Array.isArray(result?.items) ? result.items.length : 0;
      const timedOut = Number(result?.timed_out || 0);
      // eslint-disable-next-line no-console
      console.info(
        `[refreshQuota] ${updated}/${total} 已刷新, ${timedOut} 超时`,
        result,
      );
      if (timedOut > 0) {
        setError(
          `本批 ${timedOut} 个账户超时未刷新（共 ${total} 个），请稍后再点一次"刷新配额"`,
        );
      }
      await load();
    } catch (exc: any) {
      setError(exc?.message || t("login.requestFailed"));
    } finally {
      setQuotaBusy(false);
    }
  };

  const startCodexOAuth = async () => {
    setError("");
    const ids = [...selectedIds];
    if (ids.length === 0) {
      setError("请选择至少 1 个账户进行 Codex OAuth");
      return;
    }
    setOauthBusy(true);
    try {
      const data = await apiFetch("/tasks/codex-oauth", {
        method: "POST",
        body: JSON.stringify({
          platform: "chatgpt",
          ids,
          browser_mode: browserMode,
          concurrency: Math.max(Number(actionConcurrency || 1), 1),
        }),
      });
      setOauthTaskId(data.task_id || data.id || "");
    } catch (exc: any) {
      setError(exc?.message || t("login.requestFailed"));
    } finally {
      setOauthBusy(false);
    }
  };

  const handleOAuthTaskDone = useCallback(async () => {
    setOauthBusy(false);
    setSelectedIds(new Set());
    await load();
  }, [load]);

  const completeCodexOAuth = async () => {
    if (!oauthModal?.account_id || !oauthCallbackUrl.trim()) return;
    setOauthBusy(true);
    setError("");
    try {
      await apiFetch(`/accounts/${oauthModal.account_id}/codex-oauth/complete`, {
        method: "POST",
        body: JSON.stringify({ callback_url: oauthCallbackUrl.trim() }),
      });
      setOauthModal(null);
      setOauthCallbackUrl("");
      setSelectedIds(new Set());
      await load();
    } catch (exc: any) {
      setError(exc?.message || t("login.requestFailed"));
    } finally {
      setOauthBusy(false);
    }
  };

  const cashierCount = accounts.filter((acc) =>
    Boolean(getCashierUrl(acc)),
  ).length;
  const subscribedCount = accounts.filter(
    (acc) => getPlanState(acc) === "subscribed",
  ).length;
  const boundCount = accounts.filter(isPhoneBound).length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      {showGenerate && (() => {
        const reuseId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null;
        const reuseAcc = reuseId
          ? accounts.find((a) => Number(a.id) === Number(reuseId))
          : null;
        return (
          <GeneratePlusModal
            platformMeta={platformMeta}
            onClose={() => setShowGenerate(false)}
            onDone={() => load()}
            reuseAccountId={reuseId}
            reuseAccountEmail={reuseAcc?.email || ""}
          />
        );
      })()}
      {showBind &&
        createPortal(
          <div
            className="dialog-backdrop"
            onClick={() => !binding && setShowBind(false)}
          >
            <div
              className="dialog-panel flex max-h-[80vh] flex-col"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
                <div>
                  <h2 className="text-base font-semibold text-[var(--text-primary)]">
                    绑定手机号
                  </h2>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    已选 {selectedCount} 个账户；未勾选时按当前列表未绑账户顺序绑定。
                  </div>
                </div>
                <button
                  onClick={() => !binding && setShowBind(false)}
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-3 px-6 py-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-xs font-medium text-[var(--text-secondary)]">
                    浏览器模式
                    <select
                      value={browserMode}
                      onChange={(event) => setBrowserMode(event.target.value)}
                      disabled={binding}
                      className="control-surface control-surface-compact mt-1 w-full"
                    >
                      {BROWSER_MODE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {browserMode.startsWith("bitbrowser_") && (
                    <div className="rounded border border-[var(--border)] bg-[var(--bg-pane)] px-3 py-2 text-xs text-[var(--text-muted)]">
                      将自动从“设置 → BitBrowser”的号池取一个最少使用的 profile。
                    </div>
                  )}
                  <label className="block text-xs font-medium text-[var(--text-secondary)]">
                    并发数
                    <input
                      type="number"
                      min={1}
                      value={actionConcurrency}
                      onChange={(event) =>
                        setActionConcurrency(Math.max(Number(event.target.value || 1), 1))
                      }
                      disabled={binding}
                      className="control-surface control-surface-compact mt-1 w-full text-center"
                    />
                  </label>
                </div>
                <textarea
                  value={phoneLines}
                  onChange={(event) => setPhoneLines(event.target.value)}
                  rows={7}
                  spellCheck={false}
                  disabled={binding}
                  placeholder="+12025550101----https://relay.example.invalid/api/sms/recordText?key=..."
                  className="control-surface control-surface-compact w-full font-mono text-xs leading-relaxed"
                />
                <p className="text-xs text-[var(--text-muted)]">
                  支持多行；每个手机号最多绑定 3 个 Codex 账户。
                </p>
                {bindTaskId && (
                  <div className="h-[360px] min-h-0 rounded border border-[var(--border)] p-3">
                    <TaskLogPanel taskId={bindTaskId} onDone={handleBindTaskDone} />
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2 border-t border-[var(--border)] px-6 py-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowBind(false)}
                  disabled={binding}
                >
                  {t("common.close")}
                </Button>
                <Button size="sm" onClick={startPhoneBind} disabled={binding}>
                  {binding ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Smartphone className="mr-2 h-4 w-4" />
                  )}
                  开始绑定
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      {bindResult &&
        createPortal(
          <div className="dialog-backdrop" onClick={() => setBindResult(null)}>
            <div
              className="dialog-panel"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
                <h2 className="text-base font-semibold text-[var(--text-primary)]">
                  绑定结果
                </h2>
                <button
                  onClick={() => setBindResult(null)}
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-3 px-6 py-4 text-sm">
                <div className="text-[var(--text-secondary)]">
                  成功 {bindResult.success_count || 0}，失败{" "}
                  {bindResult.failure_count || 0}
                </div>
                <div className="overflow-hidden rounded border border-[var(--border)]">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[var(--bg-pane)] text-[var(--text-muted)]">
                      <tr>
                        <th className="px-3 py-2">手机号</th>
                        <th className="px-3 py-2">使用</th>
                        <th className="px-3 py-2">成功</th>
                        <th className="px-3 py-2">失败</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(bindResult.phones || []).map((item: any) => (
                        <tr
                          key={item.phone}
                          className="border-t border-[var(--border)]/40"
                        >
                          <td className="px-3 py-2 font-mono">{item.phone}</td>
                          <td className="px-3 py-2">{item.used || 0}</td>
                          <td className="px-3 py-2">{item.success || 0}</td>
                          <td className="px-3 py-2">{item.failed || 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="flex justify-end border-t border-[var(--border)] px-6 py-3">
                <Button size="sm" onClick={() => setBindResult(null)}>
                  {t("common.close")}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      {oauthTaskId &&
        createPortal(
          <div className="dialog-backdrop" onClick={() => setOauthTaskId("")}>
            <div
              className="dialog-panel flex max-h-[82vh] flex-col"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
                <div>
                  <h2 className="text-base font-semibold text-[var(--text-primary)]">
                    Codex OAuth
                  </h2>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    任务会调用已写好的 OAuth 认证流程，并把日志输出到这里。
                  </div>
                </div>
                <button
                  onClick={() => setOauthTaskId("")}
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 px-6 py-4">
                <div className="h-[420px] min-h-0 rounded border border-[var(--border)] p-3">
                  <TaskLogPanel taskId={oauthTaskId} onDone={handleOAuthTaskDone} />
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-[var(--border)] px-6 py-3">
                <Button variant="outline" size="sm" onClick={() => setOauthTaskId("")}>
                  {t("common.close")}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      {oauthModal &&
        createPortal(
          <div className="dialog-backdrop" onClick={() => !oauthBusy && setOauthModal(null)}>
            <div
              className="dialog-panel flex max-h-[82vh] flex-col"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
                <div>
                  <h2 className="text-base font-semibold text-[var(--text-primary)]">
                    Codex OAuth
                  </h2>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    {oauthModal.email || ""} 登录完成后粘贴回调 URL 刷新 token。
                  </div>
                </div>
                <button
                  onClick={() => !oauthBusy && setOauthModal(null)}
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-3 px-6 py-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(oauthModal.auth_url, "_blank", "noopener,noreferrer")}
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  打开 OAuth 链接
                </Button>
                <textarea
                  value={oauthCallbackUrl}
                  onChange={(event) => setOauthCallbackUrl(event.target.value)}
                  rows={6}
                  spellCheck={false}
                  placeholder="粘贴之前 OAuth 认证返回的带 access_token / refresh_token 的回调 URL"
                  className="control-surface control-surface-compact w-full font-mono text-xs leading-relaxed"
                />
              </div>
              <div className="flex justify-end gap-2 border-t border-[var(--border)] px-6 py-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOauthModal(null)}
                  disabled={oauthBusy}
                >
                  {t("common.close")}
                </Button>
                <Button
                  size="sm"
                  onClick={completeCodexOAuth}
                  disabled={oauthBusy || !oauthCallbackUrl.trim()}
                >
                  {oauthBusy ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="mr-2 h-4 w-4" />
                  )}
                  刷新 token
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* Codex OAuth 启动确认弹窗：选浏览器模式 + 并发数后才正式启动任务 */}
      {oauthConfirmOpen &&
        createPortal(
          <div
            className="dialog-backdrop"
            onClick={() => !oauthBusy && setOauthConfirmOpen(false)}
          >
            <div
              className="dialog-panel flex max-h-[82vh] flex-col"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
                <div>
                  <h2 className="text-base font-semibold text-[var(--text-primary)]">
                    Codex OAuth 启动选项
                  </h2>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    已选 {selectedIds.size} 个账户。配置浏览器模式和并发数后启动批量 OAuth。
                  </div>
                </div>
                <button
                  onClick={() => !oauthBusy && setOauthConfirmOpen(false)}
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-4 px-6 py-4">
                <div>
                  <label className="mb-1 block text-xs text-[var(--text-muted)]">
                    浏览器模式
                  </label>
                  <select
                    value={browserMode}
                    onChange={(event) => setBrowserMode(event.target.value)}
                    className="control-surface control-surface-compact w-full"
                  >
                    {BROWSER_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-[var(--text-muted)]">
                    并发数
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={actionConcurrency}
                    onChange={(event) =>
                      setActionConcurrency(
                        Math.max(Number(event.target.value || 1), 1),
                      )
                    }
                    className="control-surface control-surface-compact w-full text-center"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-[var(--border)] px-6 py-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOauthConfirmOpen(false)}
                  disabled={oauthBusy}
                >
                  {t("common.close")}
                </Button>
                <Button
                  size="sm"
                  onClick={async () => {
                    setOauthConfirmOpen(false);
                    await startCodexOAuth();
                  }}
                  disabled={oauthBusy || selectedIds.size === 0}
                >
                  {oauthBusy ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="mr-2 h-4 w-4" />
                  )}
                  启动
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">
            {t("ctfGptPlus.title")}
          </h1>
          <div className="mt-1 text-sm text-[var(--text-muted)]">
            已完成 CTF Plus 链路的 ChatGPT 账户会保存在这里。
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw
              className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`}
            />
            {t("common.refresh")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={refreshQuota}
            disabled={quotaBusy || loading || selectedCount === 0}
            title="刷新已勾选账户的订阅状态（plus / free / expired）；未勾选时禁用"
          >
            {quotaBusy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Gauge className="mr-2 h-4 w-4" />
            )}
            刷新配额
          </Button>
          <Button size="sm" onClick={() => setShowGenerate(true)}>
            <Sparkles className="mr-2 h-4 w-4" />
            {selectedIds.size === 1 ? "用已选账号生成 Plus 链接" : "生成 GPT Plus"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowBind(true)}>
            <Smartphone className="mr-2 h-4 w-4" />
            绑定手机号
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setError("");
              if (selectedIds.size === 0) {
                setError("请选择至少 1 个账户进行 Codex OAuth");
                return;
              }
              setOauthConfirmOpen(true);
            }}
            disabled={oauthBusy || selectedCount === 0}
          >
            <ShieldCheck className="mr-2 h-4 w-4" />
            Codex OAuth
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        {[
          ["Plus 账户", String(accounts.length), CheckCircle],
          ["订阅状态", String(subscribedCount), Sparkles],
          ["支付链接", String(cashierCount), CreditCard],
          ["已绑手机号", String(boundCount), Smartphone],
        ].map(([label, value, Icon]: any) => (
          <Card key={label} className="px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs text-[var(--text-muted)]">{label}</div>
                <div className="mt-1 text-lg font-semibold text-[var(--text-primary)]">
                  {value}
                </div>
              </div>
              <Icon className="h-4 w-4 text-[var(--accent)]" />
            </div>
          </Card>
        ))}
      </div>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-3 lg:flex-row lg:items-center lg:gap-3">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索邮箱"
            className="control-surface control-surface-compact w-full lg:w-64"
            style={{ width: "375px" }}
          />
          <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
            {(["unexported", "exported"] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={exportFilter === value ? "default" : "outline"}
                onClick={() => setExportFilter(value)}
              >
                {value === "unexported" ? "未导出" : "已导出"}
              </Button>
            ))}
            {(["all", "bound", "unbound"] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={bindFilter === value ? "default" : "outline"}
                onClick={() => setBindFilter(value)}
              >
                {value === "all" ? "全部" : value === "bound" ? "已绑" : "未绑"}
              </Button>
            ))}
            <select
              value={exportFormat}
              onChange={(event) => setExportFormat(event.target.value)}
              className="control-surface control-surface-compact h-8"
              style={{ width: "145px" }}
            >
              <option value="email-api">Email（仅邮箱）</option>
              <option value="cpa">cpa</option>
              <option value="sub2api">sub2api</option>
              <option value="cockpit">cockpit</option>
            </select>
            <Button
              size="sm"
              variant="outline"
              onClick={exportSelected}
              disabled={selectedCount === 0}
            >
              <Download className="mr-2 h-4 w-4" />
              导出
            </Button>
          </div>
        </div>

        {error ? (
          <div className="mx-4 mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[1080px] text-left">
            <thead className="sticky top-0 z-10 bg-[var(--bg-card)] text-xs uppercase tracking-[0.12em] text-[var(--text-muted)]">
              <tr className="border-b border-[var(--border)]">
                <th className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleVisible}
                    aria-label="select visible accounts"
                  />
                </th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Password</th>
                <th className="px-3 py-2">Plan</th>
                <th className="px-3 py-2">Cashier</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-12 text-center text-sm text-[var(--text-muted)]"
                  >
                    <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                    {t("common.loading")}
                  </td>
                </tr>
              ) : filteredAccounts.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-12 text-center text-sm text-[var(--text-muted)]"
                  >
                    暂无 Plus 账户
                  </td>
                </tr>
              ) : (
                filteredAccounts.map((acc) => {
                  const status = getDisplayStatus(acc);
                  const cashierUrl = getCashierUrl(acc);
                  const displayBadges = getDisplayBadges(acc);
                  const phoneBound = isPhoneBound(acc);
                  const exported = isCtfExported(acc);
                  return (
                    <tr
                      key={acc.id}
                      className="group border-b border-[var(--border)]/30 hover:bg-[var(--text-primary)]/[0.02]"
                    >
                      <td className="px-3 py-2.5 align-top">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(Number(acc.id))}
                          onChange={() => toggleAccount(Number(acc.id))}
                          aria-label={`select ${acc.email}`}
                        />
                      </td>
                      <td className="px-3 py-2.5 align-top font-mono text-sm text-[var(--text-primary)]">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate" title={acc.email}>
                            {acc.email}
                          </span>
                          <button
                            onClick={() => copyText(emailApiLine(acc.email))}
                            title="复制 Email"
                            className="opacity-0 transition-opacity group-hover:opacity-100 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                        </div>
                        {displayBadges.length > 0 ? (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {displayBadges
                              .slice(0, 3)
                              .map((badge: any, index: number) => (
                                <span
                                  key={`${badge?.label || "badge"}-${index}`}
                                  className="rounded border border-[var(--border)]/50 bg-[var(--bg-pane)]/40 px-1 py-0.5 text-[11px] text-[var(--text-muted)]"
                                >
                                  {badge?.label}
                                </span>
                              ))}
                          </div>
                        ) : null}
                        {phoneBound ? (
                          <div className="mt-1.5">
                            <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-300">
                              已绑
                            </span>
                          </div>
                        ) : null}
                        {exported ? (
                          <div className="mt-1.5">
                            <span className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-300">
                              已导出
                            </span>
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 align-top font-mono text-[13px] text-[var(--text-muted)]">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span
                            className="truncate blur-[3px] transition-all hover:blur-none hover:text-[var(--text-primary)]"
                            title={acc.password}
                          >
                            {acc.password}
                          </span>
                          <button
                            onClick={() => copyText(acc.password)}
                            className="opacity-0 transition-opacity group-hover:opacity-100 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <div className="flex flex-col items-start gap-1">
                          {(() => {
                            const planState = String(getPlanState(acc) || "").toLowerCase();
                            const planName = String(getPlanName(acc) || "").toLowerCase();
                            const isPlus =
                              planState === "subscribed" ||
                              planName === "plus" ||
                              planName === "team";
                            const isFree =
                              planState === "free" || planName === "free";
                            const isExpired =
                              planState === "expired" ||
                              planName === "expired" ||
                              planName === "invalid" ||
                              planName === "banned";
                            const label = planName === "team"
                              ? "Team"
                              : isPlus
                              ? "Plus"
                              : isFree
                              ? "Free"
                              : isExpired
                              ? "Expired"
                              : "Unknown";
                            const variant: "success" | "secondary" | "danger" = isPlus
                              ? "success"
                              : isExpired
                              ? "danger"
                              : "secondary";
                            return <Badge variant={variant}>{label}</Badge>;
                          })()}
                          <span className="text-xs text-[var(--text-muted)]">
                            {translateAccountStatus(status, language)} /{" "}
                            {getPlanState(acc)}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        {cashierUrl ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => copyText(cashierUrl)}
                              className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-pane)] hover:text-[var(--text-primary)]"
                              title="复制链接"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                            <a
                              href={cashierUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-pane)] hover:text-[var(--text-primary)]"
                              title="打开链接"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </div>
                        ) : (
                          <span className="text-xs text-[var(--text-muted)]/60">
                            -
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 align-top font-mono text-xs text-[var(--text-muted)]">
                        {acc.created_at
                          ? formatDateTime(acc.created_at, language, {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                              hour12: false,
                            })
                          : "-"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 align-top">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => moveExportStatus(Number(acc.id), !exported)}
                        >
                          {exported ? "移出已导出" : "移入已导出"}
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
