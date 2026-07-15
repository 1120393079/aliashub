const EMAIL_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:outlook(?:\.(?:at|be|cl|cz|de|dk|es|fr|hu|ie|in|it|jp|kr|lv|my|ph|pt|sa|sg|sk)|\.co\.(?:id|il|nz|th)|\.com(?:\.(?:ar|au|br|gr|tr|vn))?)|(?:hotmail|live|msn)\.com)(?![a-z0-9.-])/gi;
const MANAGE_PATH = /\/names\/manage(?:\/|$)/i;
const ADD_ALIAS_PATH = /(?:^|\/)addassocid(?:\/|$)/i;
const INTERACTION_PATTERN = /(verify your identity|help us protect|captcha|验证你的身份|帮助我们保护|图形验证)/i;
const PENDING_KEY = "aliashubPendingAliasTask";
const VERIFIED_KEY = "aliashubVerifiedMicrosoftAccount";
const VERIFIED_MAX_AGE = 15 * 60_000;
const GUARD_ID = "aliashub-account-guard";
let busy = false;
let lastSyncAt = 0;

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (!response?.ok) return reject(new Error(response?.error || "AliasHub 扩展请求失败"));
      return resolve(response.data);
    });
  });
}

function api(path, method = "GET", body) {
  return send({ type: "api", path, method, body });
}

function pageText() {
  const text = document.body?.innerText || "";
  const guardText = document.getElementById(GUARD_ID)?.innerText || "";
  if (!guardText) return text;
  const guardOffset = text.lastIndexOf(guardText);
  return guardOffset === -1
    ? text
    : `${text.slice(0, guardOffset)}${text.slice(guardOffset + guardText.length)}`;
}

function pageEmails() {
  return [...new Set((pageText().match(EMAIL_PATTERN) || []).map((value) => value.toLowerCase()))];
}

function visible(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
}

function firstVisible(selectors) {
  for (const selector of selectors) {
    const item = [...document.querySelectorAll(selector)].find(visible);
    if (item) return item;
  }
  return null;
}

function buttonByText(pattern) {
  return [...document.querySelectorAll("a, button, input[type='submit']")]
    .find((element) => visible(element) && pattern.test((element.innerText || element.value || "").trim()));
}

function fillInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.focus();
}

function readSession(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function writeSession(key, value) {
  if (value) sessionStorage.setItem(key, JSON.stringify(value));
  else sessionStorage.removeItem(key);
}

async function storedPending() {
  return readSession(PENDING_KEY);
}

async function setPending(value) {
  writeSession(PENDING_KEY, value);
}

function rememberVerified(account) {
  writeSession(VERIFIED_KEY, { accountId: account.id, email: account.email, verifiedAt: Date.now() });
}

function recentlyVerified(account) {
  const stored = readSession(VERIFIED_KEY);
  return stored?.accountId === account.id && Date.now() - stored.verifiedAt <= VERIFIED_MAX_AGE;
}

function knownAddresses(account) {
  return new Set([account.email, ...(account.aliases || [])].map((value) => String(value).toLowerCase()));
}

function pageMatches(account, aliases) {
  const known = knownAddresses(account);
  return aliases.some((address) => known.has(address));
}

function pendingMatchesTarget(pending, account) {
  return Boolean(pending)
    && pending.accountId === account.id
    && Number(account.jobId) > 0
    && pending.id === account.jobId;
}

function removeAccountGuard() {
  document.getElementById(GUARD_ID)?.remove();
}

function showAccountGuard(expected, aliases) {
  let guard = document.getElementById(GUARD_ID);
  if (!guard) {
    guard = document.createElement("section");
    guard.id = GUARD_ID;
    guard.setAttribute("role", "alert");
    Object.assign(guard.style, {
      position: "fixed",
      right: "20px",
      bottom: "20px",
      zIndex: "2147483647",
      width: "min(440px, calc(100vw - 40px))",
      boxSizing: "border-box",
      padding: "16px",
      border: "1px solid #ef4444",
      borderRadius: "8px",
      background: "#fff",
      color: "#172033",
      boxShadow: "0 18px 48px rgba(15, 23, 42, .24)",
      font: "14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    });
    const title = document.createElement("strong");
    title.textContent = "AliasHub 已停止：微软账号不匹配";
    title.style.display = "block";
    title.style.color = "#b91c1c";
    title.style.fontSize = "16px";
    const detail = document.createElement("p");
    detail.dataset.role = "detail";
    Object.assign(detail.style, { margin: "8px 0 14px", overflowWrap: "anywhere" });
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "退出当前账号并登录任务邮箱";
    Object.assign(button.style, {
      border: "0",
      borderRadius: "6px",
      padding: "9px 13px",
      background: "#2563eb",
      color: "#fff",
      cursor: "pointer",
      font: "600 14px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    });
    guard.append(title, detail, button);
    document.body.append(guard);
  }
  const detected = aliases.slice(0, 3).join("、") || "无法确认";
  guard.querySelector("[data-role='detail']").textContent = `任务账号：${expected.email}。当前页面检测到：${detected}。切换正确账号前不会同步或创建别名。`;
  guard.querySelector("button").onclick = async () => {
    const button = guard.querySelector("button");
    button.disabled = true;
    button.textContent = "正在切换 Microsoft 账号...";
    try {
      await send({ type: "switchMicrosoftAccount" });
      window.location.assign(expected.officialUrl);
    } catch (error) {
      button.disabled = false;
      button.textContent = "重试切换账号";
      guard.querySelector("[data-role='detail']").textContent = `切换失败：${error.message}`;
    }
  };
}

async function report(pending, status, message = "") {
  await api(`/api/extension/tasks/${pending.id}/report`, "POST", {
    status,
    address: pending.address,
    message,
  });
  if (status !== "interaction") await setPending(null);
}

async function targetAccount(aliases) {
  const data = await api("/api/extension/accounts");
  const expected = data.items[0] || null;
  if (!expected) {
    removeAccountGuard();
    return null;
  }
  if (pageMatches(expected, aliases)) {
    removeAccountGuard();
    rememberVerified(expected);
    return { account: expected, positivelyMatched: true };
  }
  if (ADD_ALIAS_PATH.test(window.location.pathname) && recentlyVerified(expected)) {
    removeAccountGuard();
    return { account: expected, positivelyMatched: false };
  }
  if (aliases.length) showAccountGuard(expected, aliases);
  return null;
}

async function handlePending(pending, text, aliases) {
  if (aliases.includes(pending.address.toLowerCase())) {
    await report(pending, "created");
    return true;
  }
  if (/(already taken|isn't available|not available|already exists|已被使用|不可用|已经存在)/i.test(text)) {
    await report(pending, "taken", "该地址已被占用");
    return true;
  }
  if (/(try again next week|too many aliases|maximum|limit|稍后重试|下周|过多|上限)/i.test(text)) {
    await report(pending, "limited", text.replace(/\s+/g, " ").slice(0, 240));
    return true;
  }
  if (INTERACTION_PATTERN.test(text)) {
    if (!pending.interactionReported) {
      pending.interactionReported = true;
      await setPending(pending);
      await report(pending, "interaction", "请在微软官网完成当前安全验证");
    }
    return true;
  }

  const input = firstVisible([
    "#AssociatedIdLive",
    "input[name='AssociatedIdLive']",
    "input[type='text']",
  ]);
  if (input) {
    if (input.value !== pending.candidate) fillInput(input, pending.candidate);
    const option = firstVisible(["input[type='radio'][value*='Live' i]", "#LiveDomainBox"]);
    option?.click();
    if (!pending.submittedAt || Date.now() - pending.submittedAt > 15_000) {
      const submit = firstVisible(["#SubmitYes", "button[type='submit']", "input[type='submit']"])
        || buttonByText(/^(Add alias|Add username|添加别名|添加用户名)$/i);
      if (submit) {
        pending.submittedAt = Date.now();
        await setPending(pending);
        submit.click();
      }
    }
    return true;
  }

  const add = firstVisible(["a[href*='AddAssocId' i]"])
    || buttonByText(/^(Add email|Add username|添加电子邮件|添加用户名)$/i);
  if (add) {
    add.click();
    return true;
  }
  return false;
}

async function run() {
  if (busy || !document.body) return;
  busy = true;
  try {
    const text = pageText();
    const aliases = pageEmails();
    const resolved = await targetAccount(aliases);
    if (!resolved) return;
    const { account, positivelyMatched } = resolved;

    if (positivelyMatched && aliases.length && Date.now() - lastSyncAt > 10_000) {
      await api("/api/extension/sync", "POST", { email: account.email, aliases });
      lastSyncAt = Date.now();
    }

    let pending = await storedPending();
    if (pending && !pendingMatchesTarget(pending, account)) {
      await setPending(null);
      pending = null;
    }
    if (!pending) {
      const result = await api(`/api/extension/tasks?email=${encodeURIComponent(account.email)}`);
      pending = result.task;
      if (pending) await setPending(pending);
    }
    if (pending) await handlePending(pending, text, aliases);
  } catch (error) {
    console.debug("[AliasHub]", error.message);
  } finally {
    busy = false;
  }
}

async function watchInteractionPage() {
  if (busy || !document.body) return;
  busy = true;
  try {
    const pending = await storedPending();
    if (!pending || pending.interactionReported || !INTERACTION_PATTERN.test(pageText())) return;
    pending.interactionReported = true;
    await setPending(pending);
    await report(pending, "interaction", "请在微软官网完成当前安全验证");
  } catch (error) {
    console.debug("[AliasHub]", error.message);
  } finally {
    busy = false;
  }
}

chrome.storage.local.remove(["activeMicrosoftEmail", "pendingAliasTask"]);
if (MANAGE_PATH.test(window.location.pathname) || ADD_ALIAS_PATH.test(window.location.pathname)) {
  setInterval(run, 2_000);
  run();
} else {
  setInterval(watchInteractionPage, 2_000);
  watchInteractionPage();
}
