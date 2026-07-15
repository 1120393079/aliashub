function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (!response?.ok) return reject(new Error(response?.error || "扩展操作失败"));
      resolve(response.data);
    });
  });
}

const baseUrl = document.getElementById("baseUrl");
const apiKey = document.getElementById("apiKey");
const message = document.getElementById("message");
const state = document.getElementById("state");

function show(text, error = false) {
  message.textContent = text;
  message.classList.toggle("error", error);
  state.classList.toggle("connected", !error && text.includes("已连接"));
}

async function boot() {
  const config = await send({ type: "getConfig" });
  baseUrl.value = config.baseUrl;
  apiKey.value = config.apiKey;
  if (config.apiKey) test();
}

async function test() {
  try {
    await send({ type: "api", path: "/api/extension/status" });
    show("已连接 AliasHub");
  } catch (error) {
    show(error.message, true);
  }
}

document.getElementById("save").addEventListener("click", async () => {
  try {
    await send({ type: "saveConfig", baseUrl: baseUrl.value, apiKey: apiKey.value });
    await test();
  } catch (error) {
    show(error.message, true);
  }
});

document.getElementById("open").addEventListener("click", () => {
  send({ type: "openAliases" }).then(() => window.close()).catch((error) => show(error.message, true));
});
boot().catch((error) => show(error.message, true));
