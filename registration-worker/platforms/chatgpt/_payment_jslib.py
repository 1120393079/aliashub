"""
浏览器端 JS 注入片段集合（Camoufox / BitBrowser / Chromium 通用）。

为什么把 JS 字符串集中到一个模块：

1. 这些片段同时由 ``add_init_script``（每次 navigate 前装）和
   ``page.evaluate`` / ``frame.evaluate``（主动调用）使用，复用同一份源
   能避免漂移。
2. 多个 helper（``checkout_finished_success`` 等）和顶层 ``payment.py``
   都用得到，放在 ``payment.py`` 里会让那个文件膨胀过头。
3. JS 本身是 host 无关的——Camoufox（Firefox 内核）和 BitBrowser
   （Chromium 内核）都暴露标准 DOM/CDP，``page.evaluate`` 行为一致，所以
   JS 不需要分支判断浏览器后端。

参考：``GuJumpgate`` 的 ``content/plus-checkout.js`` /
``content/paypal-flow.js``（Chrome MV3 content_script）。本项目走 Python
+ Playwright 远程 attach，不便注入完整 content_script，但单点 JS 工具
（拟人点击、autocomplete 抑制、金额提取）的语义可以一比一搬过来。
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Autocomplete / Stripe 浮层抑制
# ---------------------------------------------------------------------------
#
# Stripe hosted checkout（``pay.openai.com``）的地址输入框会异步弹出
# ``.AddressAutocomplete-results`` 浮层。它的 z-index 高，会盖住
# ``Subscribe`` / ``Pay`` 按钮，导致 click 被吃掉。GuJumpgate 用一个
# MutationObserver 把它直接 ``display:none`` 掉。
#
# 本项目里这个脚本由 ``add_init_script`` 在每次 navigate 前装一次，所以
# 整个 checkout 生命周期都生效，不需要业务侧再调。如果某次 navigate 没
# 触发 init_script（极少见），调用方可以主动 ``page.evaluate`` 一次。
#
# Sentinel：``window.__GPT_AUTOCOMPLETE_SUPPRESSOR_INSTALLED__`` 防止重复
# 装 observer。

AUTOCOMPLETE_SUPPRESSOR_JS = r"""
(() => {
  if (window.__GPT_AUTOCOMPLETE_SUPPRESSOR_INSTALLED__) return 0;
  window.__GPT_AUTOCOMPLETE_SUPPRESSOR_INSTALLED__ = true;

  // 命中一次就压下去；只针对地址 / Stripe autocomplete 相关浮层，避免误伤
  // 业务 UI。pay.openai.com 上常见的 selector 都覆盖了。
  const SELECTORS = [
    '.AddressAutocomplete-results',
    '[class*="AddressAutocomplete"]',
    '#billing-address-autocomplete-results',
  ];

  const hide = (root) => {
    for (const sel of SELECTORS) {
      try {
        root.querySelectorAll(sel).forEach((node) => {
          try {
            node.style.setProperty('display', 'none', 'important');
            node.style.setProperty('visibility', 'hidden', 'important');
            node.style.setProperty('pointer-events', 'none', 'important');
            node.style.setProperty('height', '0', 'important');
            node.style.setProperty('overflow', 'hidden', 'important');
          } catch (_) {
            // ignore readonly style
          }
        });
      } catch (_) {
        // ignore selector errors on early DOM
      }
    }
  };

  const install = () => {
    if (!document || !document.documentElement) return;
    hide(document);
    try {
      const observer = new MutationObserver(() => hide(document));
      observer.observe(document.documentElement, { childList: true, subtree: true });
      window.__GPT_AUTOCOMPLETE_SUPPRESSOR_OBSERVER__ = observer;
    } catch (_) {
      // 老 Firefox 可能尚未就绪，下一次 mutation 触发再补装
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
  return 1;
})();
"""


# ---------------------------------------------------------------------------
# 拟人点击（hidden / tabindex=-1 / 被遮挡 元素的兜底）
# ---------------------------------------------------------------------------
#
# Playwright 的 ``Locator.click()`` 会做 actionability 检查：可见、可
# enabled、不被覆盖、稳定位置，任意一项不过都 3s 超时。Stripe checkout
# 上 PayPal radio 是 ``<input type="radio" tabindex="-1">``（CSS 隐藏，
# 真正可点的是 ``<label>``），即便 ``force=True`` 也无法绕过 hidden 检
# 测——超时是必然。
#
# GuJumpgate 的解法：派发完整的 PointerEvent + MouseEvent 序列 +
# ``el.click()`` + 表单 ``form.requestSubmit(el)``。这绕过 actionability
# check，直接复刻浏览器原生点击事件序列。
#
# 调用方式（payment.py）：
#     page.evaluate(HUMAN_LIKE_CLICK_JS, selector_or_handle)
# 入参可以是 CSS 选择器字符串（最简单），也可以是 Playwright 的
# ElementHandle/JSHandle（CDP 会自动转 JS Element）。

HUMAN_LIKE_CLICK_JS = r"""
(target) => {
  const resolveElement = (input) => {
    if (input instanceof Element) return input;
    if (typeof input === 'string') {
      try { return document.querySelector(input); } catch (_) { return null; }
    }
    return null;
  };
  const el = resolveElement(target);
  if (!el) return { ok: false, reason: 'element_not_found' };

  // 滚到中央，blur 当前焦点元素（避免 input 自动补全浮层挡住后续提交）
  try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {}
  try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch (_) {}
  try { el.focus && el.focus({ preventScroll: true }); } catch (_) {}

  const rect = el.getBoundingClientRect();
  const clientX = Math.floor(rect.left + rect.width / 2);
  const clientY = Math.floor(rect.top + rect.height / 2);
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    button: 0,
    buttons: 1,
  };
  const PointerCtor = (typeof PointerEvent === 'function') ? PointerEvent : MouseEvent;
  const events = [
    ['pointerover', PointerCtor],
    ['pointerenter', PointerCtor],
    ['mouseover', MouseEvent],
    ['mouseenter', MouseEvent],
    ['pointermove', PointerCtor],
    ['mousemove', MouseEvent],
    ['pointerdown', PointerCtor],
    ['mousedown', MouseEvent],
    ['pointerup', PointerCtor],
    ['mouseup', MouseEvent],
    ['click', MouseEvent],
  ];
  for (const [type, Ctor] of events) {
    try { el.dispatchEvent(new Ctor(type, eventInit)); } catch (_) {}
  }

  // 兜底：原生 click（对 label / button 同样有效）
  try { typeof el.click === 'function' && el.click(); } catch (_) {}

  // 表单提交按钮：用 requestSubmit 触发表单 submit 事件（绕开 onclick 失效）
  try {
    const form = el.form
      || (el.getAttribute && document.getElementById(String(el.getAttribute('form') || '').trim()))
      || (el.closest && el.closest('form'));
    const tag = String(el.tagName || '').toUpperCase();
    const type = String((el.getAttribute && el.getAttribute('type')) || el.type || '').toLowerCase();
    const isSubmitLike = (tag === 'BUTTON' && (!type || type === 'submit'))
      || (tag === 'INPUT' && type === 'submit');
    if (form && isSubmitLike && typeof form.requestSubmit === 'function') {
      form.requestSubmit(el);
    }
  } catch (_) {}

  return {
    ok: true,
    rect: { x: clientX, y: clientY, w: Math.round(rect.width), h: Math.round(rect.height) },
    tag: String(el.tagName || ''),
  };
}
"""


# ---------------------------------------------------------------------------
# 金额提取（hosted Stripe + chatgpt.com 自有 checkout 都支持）
# ---------------------------------------------------------------------------
#
# Stripe hosted checkout 上"今日应付金额"明确出现在
# ``#OrderDetails-TotalAmount``；chatgpt.com 自有 checkout 没有稳定 ID，
# 需要按 label 文本（"今日应付金额 / Amount due today / Total due
# today"）反查同级金额。GuJumpgate 同时覆盖两条路径，直接搬过来。
#
# 返回 ``{has_today_due, amount, is_zero, raw_amount, source}``。
# - ``has_today_due``: 是否成功定位到"今日应付"标签或金额容器
# - ``amount``: 解析出的浮点金额（None 表示找到 label 但金额无法解析）
# - ``is_zero``: ``abs(amount) < 0.005``，免费试用判定
# - ``raw_amount``: 原始文本（"$0.00 / month"）
# - ``source``: ``'hosted'`` / ``'inline-label'`` / ``'none'``
#
# 之所以输出结构化数据而不是直接抛 error：业务侧需要根据"是否免费试用资
# 格"做不同决策（弃号 vs 继续），让 Python 端写策略更灵活。

CHECKOUT_AMOUNT_PROBE_JS = r"""
() => {
  const isVisible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(rect.width) > 0
      && Number(rect.height) > 0;
  };
  const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();

  const parseAmount = (rawValue) => {
    const raw = norm(rawValue);
    const match = raw.match(/(?:[$€£¥]\s*)?([+-]?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})|[+-]?\d+(?:[.,]\d{1,2})?)(?:\s*[$€£¥])?/);
    if (!match) return null;
    let num = String(match[1] || '').trim();
    const lastComma = num.lastIndexOf(',');
    const lastDot = num.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
      const dec = lastComma > lastDot ? ',' : '.';
      const thou = dec === ',' ? '.' : ',';
      num = num.replace(new RegExp('\\' + thou, 'g'), '').replace(dec, '.');
    } else if (lastComma > -1) {
      num = num.replace(',', '.');
    }
    const value = Number(num.replace(/[^\d.+-]/g, ''));
    return Number.isFinite(value) ? { amount: value, raw: match[0] } : null;
  };

  // 1) hosted（pay.openai.com / checkout.stripe.com）：直接读
  // ``#OrderDetails-TotalAmount`` / ``#ProductSummary-totalAmount``。
  // 多个 selector 都试，挑第一个非 0；全 0 也保留。
  const hostedSelectors = [
    '#OrderDetails-TotalAmount .CurrencyAmount',
    '#OrderDetails-TotalAmount',
    '#ProductSummary-totalAmount .CurrencyAmount',
    '#ProductSummary-totalAmount',
  ];
  const hostedSeen = new Set();
  const hostedEntries = [];
  for (const sel of hostedSelectors) {
    const el = document.querySelector(sel);
    if (!el || hostedSeen.has(el)) continue;
    hostedSeen.add(el);
    const text = norm(el.innerText || el.textContent || '');
    if (!text) continue;
    const parsed = parseAmount(text);
    if (parsed) {
      hostedEntries.push({ amount: parsed.amount, raw: text });
    }
  }
  if (hostedEntries.length) {
    const nonZero = hostedEntries.find((e) => Math.abs(e.amount) >= 0.005) || null;
    const chosen = nonZero || hostedEntries[0];
    const isZero = hostedEntries.every((e) => Math.abs(e.amount) < 0.005);
    return {
      has_today_due: true,
      amount: chosen.amount,
      is_zero: isZero,
      raw_amount: chosen.raw,
      source: 'hosted',
    };
  }

  // 2) chatgpt.com 自有 checkout：找"今日应付"label 同级金额
  const labelPattern = /今日应付金额|今日应付|今天应付|amount\s*due\s*today|due\s*today|today'?s\s*total|total\s*due\s*today/i;
  const amountPattern = /[$€£¥]\s*[+-]?\d|[+-]?\d+(?:[.,]\d{1,2})?\s*[$€£¥]/;
  const elements = Array.from(document.querySelectorAll('div, span, p, strong, b'))
    .filter(isVisible);
  for (const el of elements) {
    const text = norm(el.innerText || el.textContent || '');
    if (!labelPattern.test(text)) continue;
    const candidates = [];
    const tail = text.replace(labelPattern, '').trim();
    if (tail) candidates.push(tail);
    const parent = el.parentElement;
    if (parent) {
      for (const sib of Array.from(parent.children || [])) {
        if (sib === el) continue;
        const sibText = norm(sib.innerText || sib.textContent || '');
        if (amountPattern.test(sibText)) candidates.push(sibText);
      }
    }
    for (const c of candidates) {
      const parsed = parseAmount(c);
      if (!parsed) continue;
      return {
        has_today_due: true,
        amount: parsed.amount,
        is_zero: Math.abs(parsed.amount) < 0.005,
        raw_amount: parsed.raw,
        source: 'inline-label',
      };
    }
    return {
      has_today_due: true,
      amount: null,
      is_zero: false,
      raw_amount: '',
      source: 'inline-label',
    };
  }

  return {
    has_today_due: false,
    amount: null,
    is_zero: false,
    raw_amount: '',
    source: 'none',
  };
}
"""


# ---------------------------------------------------------------------------
# Stage 探测（chatgpt.com checkout / pay.openai.com / paypal.com 都覆盖）
# ---------------------------------------------------------------------------
#
# 返回 ``{stage, host, pathname, signals}``，stage 是字符串枚举：
#   - ``chatgpt_success``:  已跳回 chatgpt.com / pay.openai.com 的成功页
#   - ``hosted_checkout``:  pay.openai.com hosted checkout（Stripe）
#   - ``chatgpt_checkout``: chatgpt.com/checkout/openai_xxx 自有 checkout
#   - ``paypal_login``:     paypal.com/pay 登录
#   - ``paypal_review``:    paypal.com/webapps/hermes 同意并继续
#   - ``paypal_verify``:    paypal hosted 6 位 OTP 验证码
#   - ``paypal_blocked``:   paypal "you have been blocked"
#   - ``paypal_generic_error``: paypal 通用错误页
#   - ``paypal_intermediate``:  /agreements/approve 等中间页
#   - ``ctf_sandbox``:      ChatGPT 自家 sandbox（CTF）
#   - ``unknown``:          未识别
#
# 只读 DOM 特征 + url，不做任何写操作；幂等可重入。

STAGE_PROBE_JS = r"""
() => {
  const host = String(location.host || '').toLowerCase();
  const pathname = String(location.pathname || '').toLowerCase();
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const bodyText = norm(document.body && document.body.innerText || '');

  const signals = {
    host,
    pathname,
    has_paypal_otp_inputs: false,
    has_paypal_review_consent: false,
    has_paypal_login: false,
    has_paypal_blocked: false,
    has_paypal_generic_error: false,
    has_paypal_intermediate: false,
    has_chatgpt_success: false,
  };

  // chatgpt.com / pay.openai.com 成功页：外层流程一旦命中就早退
  // 注意：``pay.openai.com`` 是 hosted checkout 的承载域名，但只有 ``/c/pay/``
  // 之外的路径才算成功跳走。
  if (host === 'chatgpt.com' || host === 'www.chatgpt.com') {
    if (!/\/checkout\//.test(pathname)) {
      signals.has_chatgpt_success = true;
    }
  }
  if (host === 'pay.openai.com' && !/^\/c\/pay\//.test(pathname)) {
    signals.has_chatgpt_success = true;
  }

  // PayPal hosted 6 位验证码：6 个 ``ci-ciBasic-N`` 全可见
  let otpCount = 0;
  for (let i = 0; i < 6; i += 1) {
    const input = document.getElementById('ci-ciBasic-' + i);
    if (input) {
      const r = input.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) otpCount += 1;
    }
  }
  signals.has_paypal_otp_inputs = otpCount >= 6;

  // PayPal 登录页：``input#email`` 可见 + 路径 /pay
  if (host.includes('paypal.')) {
    const emailInput = document.getElementById('email');
    if (emailInput) {
      const r = emailInput.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) {
        signals.has_paypal_login = pathname === '/pay' || pathname.startsWith('/pay');
      }
    }
    // Hermes 同意并继续
    if (/\/webapps\/hermes/.test(pathname)) {
      const btn = document.getElementById('consentButton')
        || document.querySelector('button[data-testid="consentButton"]');
      if (btn) {
        const r = btn.getBoundingClientRect();
        signals.has_paypal_review_consent = r && r.width > 0 && r.height > 0;
      } else {
        // 无明确 ID，但页面在 hermes 路径下也算 review
        signals.has_paypal_review_consent = true;
      }
    }
    // 通用错误 / 被风控
    signals.has_paypal_blocked = /you\s+have\s+been\s+blocked/i.test(bodyText)
      || /security\s+challenge/i.test(bodyText) && /load/i.test(bodyText);
    signals.has_paypal_generic_error = /things\s+don['’]?t\s+appear\s+to\s+be\s+working/i.test(bodyText)
      || /sorry,\s*something\s+went\s+wrong/i.test(bodyText)
      || /paypal\s+isn['’]?t\s+available\s+at\s+this\s+time/i.test(bodyText);
    signals.has_paypal_intermediate = /\/agreements\/approve/.test(pathname);
  }

  // 决策
  let stage = 'unknown';
  if (signals.has_chatgpt_success) stage = 'chatgpt_success';
  else if (signals.has_paypal_blocked) stage = 'paypal_blocked';
  else if (signals.has_paypal_generic_error) stage = 'paypal_generic_error';
  else if (signals.has_paypal_otp_inputs) stage = 'paypal_verify';
  else if (signals.has_paypal_review_consent) stage = 'paypal_review';
  else if (signals.has_paypal_intermediate) stage = 'paypal_intermediate';
  else if (signals.has_paypal_login) stage = 'paypal_login';
  else if (host === 'pay.openai.com' || host === 'checkout.stripe.com') stage = 'hosted_checkout';
  else if (host.includes('chatgpt.com') && /\/checkout\//.test(pathname)) stage = 'chatgpt_checkout';
  else if (/sandbox|ctf/.test(host) || /sandbox|ctf/.test(pathname)) stage = 'ctf_sandbox';

  return { stage, host, pathname, signals };
}
"""
