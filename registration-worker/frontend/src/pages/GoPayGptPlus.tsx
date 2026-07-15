import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/utils";
import { TaskLogPanel } from "@/components/tasks/TaskLogPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Loader2, RefreshCw, Sparkles, UserPlus, X } from "lucide-react";

/**
 * GoPay 协议付款 ChatGPT Plus
 * ---------------------------------------------------------------
 * 三步流水线（参考 application/gopay_pay_chatgpt.py）：
 *
 *   ① 协议   generate_plus_link(country=ID, currency=IDR) → cashier_url
 *   ② 浏览器  打开 cashier_url，等用户/自动化跳到 app.midtrans.com → midtrans_url
 *   ③ 协议   GoPayPayment.pay(midtrans_url, gopay_account) 14 步 Midtrans API
 *
 * 该页面只负责选 ChatGPT/GoPay 账号 + 启动后台 task，详细日志在 TaskLogPanel 里
 * 实时滚动；后端跑完后会把 ChatGPT 账号标 subscribed。
 */

type AccountRow = {
  id: number;
  email: string;
  password?: string;
  user_id?: string;
  lifecycle_status?: string;
  display_status?: string;
  plan_state?: string;
  created_at?: string;
  cashier_url?: string;
  overview?: any;
  display_summary?: any;
  extra?: any;
};

function getLifecycleStatus(acc: AccountRow): string {
  return (
    acc.display_summary?.status?.lifecycle ||
    acc.lifecycle_status ||
    "registered"
  );
}

function getPlanState(acc: AccountRow): string {
  return (
    acc.display_summary?.status?.plan_state ||
    acc.plan_state ||
    acc.overview?.plan_state ||
    "unknown"
  );
}

function getBalanceRp(acc: AccountRow): number {
  const candidates = [
    acc.overview?.balance_rp,
    acc.display_summary?.balance_rp,
    acc.extra?.balance_rp,
  ];
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function getPhone(acc: AccountRow): string {
  return (
    acc.overview?.phone ||
    acc.extra?.phone ||
    acc.email ||
    ""
  );
}

export default function GoPayGptPlus() {
  const [chatgptAccounts, setChatgptAccounts] = useState<AccountRow[]>([]);
  const [gopayAccounts, setGopayAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedChatgpt, setSelectedChatgpt] = useState<Set<number>>(new Set());
  const [selectedGopayId, setSelectedGopayId] = useState<number | null>(null);
  const [country, setCountry] = useState("ID");
  const [currency, setCurrency] = useState("IDR");
  const [grabTimeout, setGrabTimeout] = useState(300);
  const [midtransOverride, setMidtransOverride] = useState("");
  // 浏览器模式（同 CtfGptPlus），bitbrowser_* 需要 profile id
  const [checkoutMode, setCheckoutMode] = useState("camoufox_headed");
  // GoPay 红包链接（余额不足时领红包补余额）
  const [envelopeUrl, setEnvelopeUrl] = useState("");
  // 并发数
  const [concurrency, setConcurrency] = useState(1);
  // 未选 ChatGPT 账号时先注册的数量
  const [registerCount, setRegisterCount] = useState(1);
  // GoPay 号来源：auto=先池后注册 / pool=只用号池 / register=强制现注册
  const [gopaySource, setGopaySource] = useState<"auto" | "pool" | "register">(
    "auto",
  );
  // 自动注册 GoPay 号用的 PIN
  const [gopayPin, setGopayPin] = useState("147258");
  // 接码渠道：herosms / smspool / smsbower
  const [smsProvider, setSmsProvider] = useState("herosms");
  // 拿号价格上限（USD）。herosms / smspool 都按 USD 计价，默认 0.11。
  // 留空 = 用后端默认值。
  const [maxPrice, setMaxPrice] = useState("0.11");
  // smspool 默认 api key
  const [smspoolApiKey, setSmspoolApiKey] = useState(
    "",
  );
  // smsbower 默认 api key（与 Hero-SMS 同协议，但活跃印尼号源更多）
  const [smsbowerApiKey, setSmsbowerApiKey] = useState(
    "",
  );
  // smsapi（固定手机号 + 查最新短信 API）：用户自己的实体卡/长期号
  const [smsapiPhone, setSmsapiPhone] = useState("");
  const [smsapiUrl, setSmsapiUrl] = useState("");
  // Hero-SMS API key 不存账号 extra（避免泄漏给前端 overview），付款步骤
  // 必须在每次任务提交时透传。默认填一个常用 key，留空则后端回退环境变量。
  const [herosmsApiKey, setHerosmsApiKey] = useState(
    "",
  );
  // 调试抓包开关：开启后抓到 midtrans_url 不关浏览器，停在付款页让人工手动
  // 走完 GoPay 网页付款，全程录 HAR + dump 每页 HTML，不跑协议付款。
  const [capturePayment, setCapturePayment] = useState(false);
  // Stripe 协议长链：用 accessToken 直接生成 pay.openai.com cashier_url（纯协议）
  const [useStripeInit, setUseStripeInit] = useState(false);
  // 短链：checkout_ui_mode=custom → chatgpt.com/checkout/openai_llc 短链
  const [useShortLink, setUseShortLink] = useState(false);
  // 付款成功后自动换绑：买一个新印尼号把账号换绑过去，老号弃用，之后一直用新号付款
  const [autoRebind, setAutoRebind] = useState(false);
  // 换绑专用接码渠道（独立于注册渠道）：herosms / smsbower
  const [rebindProvider, setRebindProvider] = useState("herosms");
  const [rebindSmsKey, setRebindSmsKey] = useState("");
  const [rebindCountry, setRebindCountry] = useState("");
  const [rebindService, setRebindService] = useState("");

  const BROWSER_MODE_OPTIONS = [
    { value: "camoufox_headed", label: "Camoufox 前台" },
    { value: "camoufox_headless", label: "Camoufox 后台" },
    { value: "bitbrowser_headed", label: "BitBrowser 前台" },
    { value: "bitbrowser_hidden", label: "BitBrowser 隐藏" },
    { value: "bitbrowser_headless", label: "BitBrowser 后台" },
  ];
  const [taskId, setTaskId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [registeringGopay, setRegisteringGopay] = useState(false);
  const [chatgptSearch, setChatgptSearch] = useState("");

  const reload = async () => {
    setLoading(true);
    try {
      // ChatGPT 账号：只列 plan_state != subscribed 的（已订阅没必要再付一遍）
      const chatgptParams = new URLSearchParams({
        platform: "chatgpt",
        page: "1",
        page_size: "100",
      });
      if (chatgptSearch) chatgptParams.set("email", chatgptSearch);
      const chatgptRes = await apiFetch(`/accounts?${chatgptParams}`);
      setChatgptAccounts(chatgptRes.items || []);

      // GoPay 账号
      const gopayRes = await apiFetch(
        `/accounts?platform=gopay&page=1&page_size=100`,
      );
      setGopayAccounts(gopayRes.items || []);
    } catch (err) {
      console.error("加载账号失败", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(reload, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatgptSearch]);

  const usableGopayAccounts = useMemo(
    () => gopayAccounts.filter((acc) => getBalanceRp(acc) >= 1),
    [gopayAccounts],
  );

  const togglePick = (id: number) => {
    setSelectedChatgpt((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const start = async () => {
    if (selectedChatgpt.size === 0 && registerCount < 1) {
      alert("请至少选 1 个 ChatGPT 账号，或设置注册数量 ≥ 1");
      return;
    }
    if (gopaySource === "pool" && !selectedGopayId) {
      alert("「仅用号池」模式请在下方点选一个 GoPay 账号");
      return;
    }
    setStarting(true);
    try {
      const body: any = {
        chatgpt_account_ids: [...selectedChatgpt],
        gopay_account_id:
          gopaySource === "pool" ? selectedGopayId : 0,
        country,
        currency,
        checkout_mode: checkoutMode,
        envelope_url: envelopeUrl.trim(),
        concurrency,
        grab_timeout: grabTimeout,
        midtrans_url_override: midtransOverride.trim() || "",
        herosms_api_key: herosmsApiKey.trim(),
        gopay_source: gopaySource,
        auto_register_gopay: gopaySource !== "pool",
        gopay_pin: gopayPin.trim() || "147258",
        sms_provider: smsProvider,
        smspool_api_key: smspoolApiKey.trim(),
        smsbower_api_key: smsbowerApiKey.trim(),
        smsapi_url: smsapiUrl.trim(),
        smsapi_phone: smsapiPhone.trim(),
        max_price: maxPrice.trim(),
        capture_payment: capturePayment,
        use_stripe_init: useStripeInit,
        use_short_link: useShortLink,
        auto_rebind: autoRebind,
        rebind_provider: rebindProvider,
        rebind_sms_key: rebindSmsKey.trim(),
        rebind_country: rebindCountry.trim(),
        rebind_service: rebindService.trim(),
      };
      // 未选 ChatGPT 账号 → 从注册开始
      if (selectedChatgpt.size === 0) {
        body.register_count = registerCount;
      }
      console.log("[gopay-pay-chatgpt] submit payload:", body);
      const res = await apiFetch("/tasks/gopay-pay-chatgpt", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setTaskId(res.task_id);
    } catch (err: any) {
      alert(`启动任务失败: ${err?.message || err}`);
    } finally {
      setStarting(false);
    }
  };

  const registerGopayAccount = async () => {
    const pin = gopayPin.trim() || "147258";
    if (!/^\d{6}$/.test(pin)) {
      alert("GoPay PIN 必须是 6 位数字");
      return;
    }
    if (smsProvider === "smsapi" && (!smsapiPhone.trim() || !smsapiUrl.trim())) {
      alert("SmsApi 渠道需要填写固定手机号和查最新短信 API URL");
      return;
    }

    setRegisteringGopay(true);
    try {
      const body = {
        gopay_pin: pin,
        envelope_url: envelopeUrl.trim(),
        sms_provider: smsProvider,
        smspool_api_key: smspoolApiKey.trim(),
        smsbower_api_key: smsbowerApiKey.trim(),
        smsapi_url: smsapiUrl.trim(),
        smsapi_phone: smsapiPhone.trim(),
        herosms_api_key: herosmsApiKey.trim(),
        max_price: maxPrice.trim(),
        auto_rebind: autoRebind,
        rebind_provider: rebindProvider,
        rebind_sms_key: rebindSmsKey.trim(),
        rebind_country: rebindCountry.trim(),
        rebind_service: rebindService.trim(),
      };
      console.log("[gopay-register-account] submit payload:", body);
      const res = await apiFetch("/tasks/gopay-register-account", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setTaskId(res.task_id);
    } catch (err: any) {
      alert(`启动 GoPay 注册任务失败: ${err?.message || err}`);
    } finally {
      setRegisteringGopay(false);
    }
  };

  const closeTask = () => {
    setTaskId(null);
    reload();
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      <Card className="shrink-0 bg-[var(--bg-pane)]/40 border border-[var(--border)] shadow-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]/50">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-[var(--accent)]" />
            <h1 className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">
              GoPay 生成 GPTPlus
            </h1>
            <Badge variant="secondary" className="ml-2">
              印尼 GoPay 协议付款
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={reload}
              disabled={loading}
              className="h-8"
            >
              {loading ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              刷新
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={registerGopayAccount}
              disabled={starting || registeringGopay}
              className="h-8"
            >
              {registeringGopay ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <UserPlus className="mr-1.5 h-3.5 w-3.5" />
              )}
              注册GoPay账户
            </Button>
            <Button
              size="sm"
              onClick={start}
              disabled={starting || registeringGopay || (selectedChatgpt.size === 0 && registerCount < 1)}
              className="h-8 shadow-sm"
            >
              {starting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              )}
              开始 ({selectedChatgpt.size > 0 ? selectedChatgpt.size : `注册${registerCount}`})
            </Button>
          </div>
        </div>
        <div className="px-5 py-3 text-xs text-[var(--text-muted)] grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className="block mb-1">浏览器模式</label>
            <select
              value={checkoutMode}
              onChange={(e) => setCheckoutMode(e.target.value)}
              className="control-surface control-surface-compact w-full"
            >
              {BROWSER_MODE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block mb-1">国家</label>
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="control-surface control-surface-compact w-full"
            >
              <option value="ID">印尼 (ID)</option>
              <option value="US">美国 (US)</option>
            </select>
          </div>
          <div>
            <label className="block mb-1">货币</label>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="control-surface control-surface-compact w-full"
            >
              <option value="IDR">IDR</option>
              <option value="USD">USD</option>
            </select>
          </div>
          <div>
            <label className="block mb-1">并发数</label>
            <input
              type="number"
              min={1}
              max={5}
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              className="control-surface control-surface-compact w-full text-center"
            />
          </div>
          <div>
            <label className="block mb-1">浏览器抓 URL 超时（秒）</label>
            <input
              type="number"
              min={60}
              value={grabTimeout}
              onChange={(e) => setGrabTimeout(Number(e.target.value))}
              className="control-surface control-surface-compact w-full"
            />
          </div>
          {checkoutMode.startsWith("bitbrowser") && (
            <div className="md:col-span-2 flex items-end">
              <p className="text-[11px] text-[var(--text-muted)] leading-tight">
                BitBrowser 模式自动从「设置 → BitBrowser」的 Profile 池按并发取号，
                每个线程独占一个 Profile，无需手填 ID。
              </p>
            </div>
          )}
          <div className="md:col-span-4">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={useStripeInit}
                onChange={(e) => setUseStripeInit(e.target.checked)}
                className="h-4 w-4"
              />
              <span className="text-[var(--text)]">
                Stripe 协议长链（用 accessToken 直接生成 cashier_url，纯协议、不靠浏览器拿链）
              </span>
            </label>
            {useStripeInit && (
              <p className="mt-1 text-[11px] text-[var(--text-muted)] leading-tight">
                开启后步骤①不再依赖默认接口返回的 url，而是显式调 Stripe
                <code>payment_pages/init</code> 把 checkout 实体化成完整
                <code>pay.openai.com</code> 长链。后续仍需浏览器把长链跳到 Midtrans 抓 midtrans_url。
              </p>
            )}
          </div>
          <div className="md:col-span-4">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={useShortLink}
                onChange={(e) => setUseShortLink(e.target.checked)}
                className="h-4 w-4"
              />
              <span className="text-[var(--text)]">
                短链模式（checkout_ui_mode=custom，返回 chatgpt.com/checkout/openai_llc 短链）
              </span>
            </label>
            {useShortLink && (
              <p className="mt-1 text-[11px] text-[var(--text-muted)] leading-tight">
                用 accessToken 调 checkout API（custom 模式、无优惠券），拿 checkout_session_id 拼成
                <code>chatgpt.com/checkout/openai_llc/&lt;id&gt;</code> 短链。和 Stripe 长链二选一，短链优先。
                <strong>短链是 ChatGPT 托管页、URL 里没有 token，打开时必须带账号登录 cookie</strong>，
                所以会把该 ChatGPT 账号的 cookie 注入抓 midtrans 的浏览器；
                <strong>请用 Camoufox 模式</strong>（BitBrowser 的 Chromium 注入 cookie 会被拒，需 profile 已登录）。
              </p>
            )}
          </div>
          <div className="md:col-span-4">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={capturePayment}
                onChange={(e) => setCapturePayment(e.target.checked)}
                className="h-4 w-4"
              />
              <span className="text-[var(--text)]">
                调试抓包模式（抓到 midtrans 后不关浏览器，人工手动付款，录 HAR + 每页 HTML）
              </span>
            </label>
            {capturePayment && (
              <p className="mt-1 text-[11px] text-[var(--text-muted)] leading-tight">
                开启后程序不跑协议付款：抓到 midtrans_url 会停在付款页，请手动走完 GoPay 网页付款全流程。
                产物存到工作目录 <code>_gopay_capture/&lt;时间戳&gt;/</code>（HAR + 各页面 HTML）。
                完成后在该目录新建一个名为 <code>STOP</code> 的空文件结束抓包。
                <strong>要拿 HAR 请用 Camoufox 模式</strong>（BitBrowser CDP 录不了 HAR，只有 HTML）。
              </p>
            )}
          </div>
          <div className="md:col-span-4">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoRebind}
                onChange={(e) => setAutoRebind(e.target.checked)}
                className="h-4 w-4"
              />
              <span className="text-[var(--text)]">
                付款成功后自动换绑（买一个新印尼号，把账号换绑过去；老号弃用，之后一直用新印尼号付款）
              </span>
            </label>
            {autoRebind && (
              <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block mb-1 text-[var(--text-muted)]">换绑接码渠道</label>
                  <select
                    value={rebindProvider}
                    onChange={(e) => setRebindProvider(e.target.value)}
                    className="control-surface control-surface-compact w-full"
                  >
                    <option value="herosms">Hero-SMS</option>
                    <option value="smsbower">SMSBower</option>
                  </select>
                </div>
                <div>
                  <label className="block mb-1 text-[var(--text-muted)]">换绑接码 API Key</label>
                  <input
                    type="password"
                    value={rebindSmsKey}
                    onChange={(e) => setRebindSmsKey(e.target.value)}
                    placeholder="独立 key，留空回退环境变量"
                    className="control-surface control-surface-compact w-full"
                  />
                </div>
                <div>
                  <label className="block mb-1 text-[var(--text-muted)]">换绑国家（固定印尼=6）</label>
                  <input
                    type="text"
                    value={rebindCountry}
                    onChange={(e) => setRebindCountry(e.target.value)}
                    placeholder="6"
                    className="control-surface control-surface-compact w-full text-center"
                  />
                </div>
                <div>
                  <label className="block mb-1 text-[var(--text-muted)]">换绑服务（留空=ni）</label>
                  <input
                    type="text"
                    value={rebindService}
                    onChange={(e) => setRebindService(e.target.value)}
                    placeholder="ni"
                    className="control-surface control-surface-compact w-full text-center"
                  />
                </div>
                <div className="md:col-span-4 text-[11px] text-[var(--text-muted)] leading-tight">
                  换绑渠道独立于注册渠道：注册用 smsapi（固定号）时换绑仍会从这里买一次性号。
                  换绑国家固定印尼（+62 / country=6），因为换绑后的新号要继续用于下一轮 GoPay 付款，外国号付不了。
                  流程：付款成功 → 解绑 OpenAI LLC → 把账号换绑到新印尼号 → 老号弃用，之后一直用新号付款。
                </div>
              </div>
            )}
          </div>
          {selectedChatgpt.size === 0 && (
            <div>
              <label className="block mb-1">注册 ChatGPT 数量（未选账号时）</label>
              <input
                type="number"
                min={1}
                max={50}
                value={registerCount}
                onChange={(e) => setRegisterCount(Number(e.target.value))}
                className="control-surface control-surface-compact w-full text-center"
              />
            </div>
          )}
        </div>
        <div className="px-5 pb-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div>
            <label className="block mb-1 text-[var(--text-muted)]">
              Midtrans URL 直连（可选，跳过浏览器抓取）
            </label>
            <input
              type="text"
              value={midtransOverride}
              onChange={(e) => setMidtransOverride(e.target.value)}
              placeholder="https://app.midtrans.com/snap/v4/redirection/..."
              className="control-surface control-surface-compact w-full"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block mb-1 text-[var(--text-muted)]">
              GoPay 红包链接（可选，余额不足时领取补余额）
            </label>
            <input
              type="text"
              value={envelopeUrl}
              onChange={(e) => setEnvelopeUrl(e.target.value)}
              placeholder="https://app.gopay.co.id/NF8p/qps2s1y0"
              className="control-surface control-surface-compact w-full"
            />
          </div>
          <div>
            <label className="block mb-1 text-[var(--text-muted)]">
              GoPay 号来源
            </label>
            <select
              value={gopaySource}
              onChange={(e) =>
                setGopaySource(e.target.value as "auto" | "pool" | "register")
              }
              className="control-surface control-surface-compact w-full"
            >
              <option value="auto">自动（先用号池，没号再注册）</option>
              <option value="pool">仅用号池（没号直接失败）</option>
              <option value="register">强制注册新号（忽略号池）</option>
            </select>
            <div className="mt-1 text-xs font-mono text-[var(--accent)]">
              当前选择 = {gopaySource}
            </div>
          </div>
          <div>
            <label className="block mb-1 text-[var(--text-muted)]">
              自动注册 GoPay PIN（6 位）
            </label>
            <input
              type="text"
              maxLength={6}
              value={gopayPin}
              onChange={(e) => setGopayPin(e.target.value.replace(/\D/g, ""))}
              placeholder="147258"
              className="control-surface control-surface-compact w-full text-center font-mono"
            />
          </div>
          <div>
            <label className="block mb-1 text-[var(--text-muted)]">接码渠道</label>
            <select
              value={smsProvider}
              onChange={(e) => setSmsProvider(e.target.value)}
              className="control-surface control-surface-compact w-full"
            >
              <option value="herosms">Hero-SMS</option>
              <option value="smspool">SMSPool</option>
              <option value="smsbower">SMSBower</option>
              <option value="smsapi">SmsApi（自有固定号）</option>
            </select>
          </div>
          <div>
            <label className="block mb-1 text-[var(--text-muted)]">
              拿号价格上限（USD）
            </label>
            <input
              type="text"
              value={maxPrice}
              onChange={(e) =>
                setMaxPrice(e.target.value.replace(/[^0-9.]/g, ""))
              }
              placeholder="0.11"
              className="control-surface control-surface-compact w-full text-center font-mono"
            />
            <div className="mt-1 text-xs text-[var(--text-muted)]">
              Hero-SMS / SMSPool 都按 USD 计价。留空或 0 = 不限价。
            </div>
          </div>
          {smsProvider === "smspool" && (
            <div>
              <label className="block mb-1 text-[var(--text-muted)]">
                SMSPool API Key
              </label>
              <input
                type="password"
                value={smspoolApiKey}
                onChange={(e) => setSmspoolApiKey(e.target.value)}
                placeholder="SMSPool API key"
                className="control-surface control-surface-compact w-full"
              />
            </div>
          )}
          {smsProvider === "smsbower" && (
            <div>
              <label className="block mb-1 text-[var(--text-muted)]">
                SMSBower API Key
              </label>
              <input
                type="password"
                value={smsbowerApiKey}
                onChange={(e) => setSmsbowerApiKey(e.target.value)}
                placeholder="SMSBower API key"
                className="control-surface control-surface-compact w-full"
              />
            </div>
          )}
          {smsProvider === "smsapi" && (
            <>
              <div>
                <label className="block mb-1 text-[var(--text-muted)]">
                  固定手机号（含国码，如 +12025550101）
                </label>
                <input
                  type="text"
                  value={smsapiPhone}
                  onChange={(e) => setSmsapiPhone(e.target.value)}
                  placeholder="+12025550101"
                  className="control-surface control-surface-compact w-full font-mono"
                />
              </div>
              <div>
                <label className="block mb-1 text-[var(--text-muted)]">
                  查最新短信 API URL（含 token）
                </label>
                <input
                  type="password"
                  value={smsapiUrl}
                  onChange={(e) => setSmsapiUrl(e.target.value)}
                  placeholder="https://api.sms8.net/api/record?token=xxxx"
                  className="control-surface control-surface-compact w-full"
                />
                <div className="mt-1 text-xs text-[var(--text-muted)]">
                  自有实体卡 / 长期号 + 该号的「查最新短信」接口。注册/PIN/付款
                  共用同一个号，靠短信时间区分新旧 OTP。
                </div>
              </div>
            </>
          )}
          <div className="md:col-span-2">
            <label className="block mb-1 text-[var(--text-muted)]">
              Hero-SMS API key（付款 OTP 用；留空则后端回退环境变量 OPAI_HEROSMS_API_KEY）
            </label>
            <input
              type="password"
              value={herosmsApiKey}
              onChange={(e) => setHerosmsApiKey(e.target.value)}
              placeholder="herosms 接码平台 API key"
              className="control-surface control-surface-compact w-full"
            />
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1 min-h-0 overflow-hidden">
        {/* ChatGPT 账号列表 */}
        <Card className="flex flex-col min-h-0 bg-[var(--bg-pane)]/40 border border-[var(--border)]">
          <div className="px-4 py-3 border-b border-[var(--border)]/50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-[var(--text-primary)]">
                ChatGPT 账号
              </span>
              <Badge variant="secondary">已选 {selectedChatgpt.size}</Badge>
            </div>
            <input
              type="text"
              value={chatgptSearch}
              onChange={(e) => setChatgptSearch(e.target.value)}
              placeholder="搜索邮箱"
              className="control-surface control-surface-compact"
              style={{ width: 200 }}
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[var(--bg-card)]">
                <tr className="text-left text-[var(--text-muted)]">
                  <th className="px-3 py-2 w-8"></th>
                  <th className="px-3 py-2">邮箱</th>
                  <th className="px-3 py-2">套餐</th>
                  <th className="px-3 py-2">cashier_url</th>
                </tr>
              </thead>
              <tbody>
                {chatgptAccounts.map((acc) => {
                  const checked = selectedChatgpt.has(acc.id);
                  const planState = getPlanState(acc);
                  const isSubscribed = planState === "subscribed";
                  const lifecycleStatus = getLifecycleStatus(acc);
                  const cashier = acc.cashier_url || acc.overview?.cashier_url || "";
                  return (
                    <tr
                      key={acc.id}
                      className={`hover:bg-[var(--bg-hover)] ${
                        isSubscribed ? "opacity-60" : ""
                      }`}
                    >
                      <td className="px-3 py-1.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => togglePick(acc.id)}
                          className="h-4 w-4 accent-[var(--accent)]"
                        />
                      </td>
                      <td className="px-3 py-1.5 text-[var(--text-primary)]">
                        {acc.email}
                      </td>
                      <td className="px-3 py-1.5">
                        <Badge
                          variant={
                            isSubscribed
                              ? "success"
                              : lifecycleStatus === "invalid"
                                ? "danger"
                                : "secondary"
                          }
                        >
                          {planState}
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5 text-[var(--text-muted)] truncate max-w-[200px]">
                        {cashier ? "✓" : "-"}
                      </td>
                    </tr>
                  );
                })}
                {chatgptAccounts.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-3 py-6 text-center text-[var(--text-muted)]"
                    >
                      暂无 ChatGPT 账号
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        {/* GoPay 账号列表 */}
        <Card className="flex flex-col min-h-0 bg-[var(--bg-pane)]/40 border border-[var(--border)]">
          <div className="px-4 py-3 border-b border-[var(--border)]/50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-[var(--text-primary)]">
                GoPay 账号（余额 ≥ 1 IDR 才可用）
              </span>
              <Badge variant="secondary">
                可用 {usableGopayAccounts.length}/{gopayAccounts.length}
              </Badge>
            </div>
            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              {gopaySource === "pool"
                ? "点选下方一个号用于付款"
                : gopaySource === "register"
                  ? "强制注册新号（忽略下方号池）"
                  : "自动挑选（先用号池，没号再注册）"}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[var(--bg-card)]">
                <tr className="text-left text-[var(--text-muted)]">
                  <th className="px-3 py-2 w-8"></th>
                  <th className="px-3 py-2">手机号</th>
                  <th className="px-3 py-2">余额 (IDR)</th>
                  <th className="px-3 py-2">状态</th>
                </tr>
              </thead>
              <tbody>
                {gopayAccounts.map((acc) => {
                  const balance = getBalanceRp(acc);
                  const usable = balance >= 1;
                  const phone = getPhone(acc);
                  const lifecycleStatus = getLifecycleStatus(acc);
                  const selected =
                    gopaySource === "pool" && selectedGopayId === acc.id;
                  return (
                    <tr
                      key={acc.id}
                      className={`hover:bg-[var(--bg-hover)] ${
                        !usable ? "opacity-50" : ""
                      } ${selected ? "bg-[var(--accent-soft)]" : ""}`}
                      onClick={() => {
                        if (gopaySource === "pool" && usable) {
                          setSelectedGopayId(acc.id);
                        }
                      }}
                    >
                      <td className="px-3 py-1.5">
                        {gopaySource === "pool" ? (
                          <input
                            type="radio"
                            checked={selected}
                            onChange={() => setSelectedGopayId(acc.id)}
                            disabled={!usable}
                          />
                        ) : null}
                      </td>
                      <td className="px-3 py-1.5 text-[var(--text-primary)] font-mono">
                        {phone}
                      </td>
                      <td className="px-3 py-1.5 text-[var(--text-primary)] font-mono">
                        {balance.toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5">
                        <Badge
                          variant={
                            usable
                              ? "success"
                              : lifecycleStatus === "invalid"
                                ? "danger"
                                : "secondary"
                          }
                        >
                          {usable ? "可用" : "无余额"}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
                {gopayAccounts.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-3 py-6 text-center text-[var(--text-muted)]"
                    >
                      暂无 GoPay 账号，请到「账号 / GoPay」注册
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* 任务执行日志弹窗 */}
      {taskId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => e.target === e.currentTarget && closeTask()}
        >
          <div
            className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col w-[800px] max-w-[95vw]"
            style={{ maxHeight: "85vh" }}
          >
            <div className="px-5 py-3 border-b border-[var(--border)] flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                GoPay 任务执行日志
              </h3>
              <button
                onClick={closeTask}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden p-4">
              <TaskLogPanel taskId={taskId} onDone={() => reload()} />
            </div>
            <div className="px-5 py-3 border-t border-[var(--border)] flex justify-end">
              <Button variant="outline" size="sm" onClick={closeTask}>
                关闭
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
