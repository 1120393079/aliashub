import crypto from "node:crypto";
import os from "node:os";

const AGENT_IDENTITY_REGISTER_URL = "https://auth.openai.com/api/accounts/v1/agent/register";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_AGENT_VERSION = "0.144.0";
const DEFAULT_ORIGINATOR = "codex_cli_rs";
const MAX_REGISTER_ATTEMPTS = 3;
const MAX_RESPONSE_BYTES = 64 * 1024;

function errorWithStatus(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

function nonEmptyText(value, label, maximum = 4_096) {
  const text = String(value || "").trim();
  if (!text) throw errorWithStatus(`${label}不完整`, 409);
  if (text.length > maximum) throw errorWithStatus(`${label}过长`, 409);
  return text;
}

function appendSshString(parts, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  parts.push(length, bytes);
}

export function encodeEd25519PublicKeyAsOpenSsh(publicKey) {
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk?.kty !== "OKP" || jwk?.crv !== "Ed25519" || !jwk.x) {
    throw errorWithStatus("Agent Identity Ed25519 公钥格式无效", 500);
  }
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32) throw errorWithStatus("Agent Identity Ed25519 公钥长度无效", 500);
  const parts = [];
  appendSshString(parts, "ssh-ed25519");
  appendSshString(parts, raw);
  return `ssh-ed25519 ${Buffer.concat(parts).toString("base64")}`;
}

export function generateAgentIdentityKeyMaterial() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKeyPkcs8Base64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKeyOpenSsh: encodeEd25519PublicKeyAsOpenSsh(publicKey),
  };
}

export function redactAgentIdentityMessage(value, secrets = []) {
  let message = String(value || "").trim();
  [...new Set(secrets.filter((item) => typeof item === "string" && item.length >= 3))]
    .sort((left, right) => right.length - left.length)
    .forEach((secret) => { message = message.split(secret).join("[REDACTED]"); });
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\bAgentAssertion\s+[^\s,;]+/gi, "AgentAssertion [REDACTED]")
    .replace(/((?:agent[_-]private[_-]key|agent[_-]runtime[_-]id|task[_-]id|access[_-]token)\s*[:=]\s*["']?)[^"'\s,;}]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

async function limitedResponseText(response) {
  const text = await response.text();
  return text.slice(0, MAX_RESPONSE_BYTES);
}

function platformName(value = process.platform) {
  if (value === "darwin") return "macos";
  if (value === "win32") return "windows";
  return value || "linux";
}

function platformLabel(value = process.platform) {
  if (value === "darwin") return "Mac OS";
  if (value === "win32") return "Windows";
  if (value === "linux") return "Linux";
  return String(value || "unknown").slice(0, 80);
}

function safeHeaderText(value, fallback, maximum = 512) {
  const text = String(value ?? "")
    .replace(/[^\x20-\x7e]/g, "_")
    .trim()
    .slice(0, maximum);
  return text || fallback;
}

function codexUserAgent({ originator, agentVersion, runtimePlatform, runtimeRelease, runtimeArch, terminal }) {
  const effectiveOriginator = safeHeaderText(originator, DEFAULT_ORIGINATOR, 80)
    .replace(/[^a-z0-9_.-]/gi, "_");
  const effectiveVersion = safeHeaderText(agentVersion, DEFAULT_AGENT_VERSION, 80);
  const effectivePlatform = safeHeaderText(platformLabel(runtimePlatform), "Linux", 80);
  const effectiveRelease = safeHeaderText(runtimeRelease, "unknown", 160);
  const effectiveArch = safeHeaderText(runtimeArch, "unknown", 80);
  const effectiveTerminal = safeHeaderText(terminal, "unknown", 160);
  return `${effectiveOriginator}/${effectiveVersion} (${effectivePlatform} ${effectiveRelease}; ${effectiveArch}) ${effectiveTerminal}`;
}

function agentRegistrationError(response) {
  const statusCode = Number(response?.status) || 0;
  const challenge = statusCode === 403
    && /challenge/i.test(String(response?.headers?.get?.("cf-mitigated") || ""));
  const code = challenge
    ? "OPENAI_AGENT_IDENTITY_UPSTREAM_CHALLENGE"
    : statusCode === 401 ? "OPENAI_AGENT_IDENTITY_UNAUTHORIZED"
      : statusCode === 403 ? "OPENAI_AGENT_IDENTITY_FORBIDDEN"
        : "";
  const message = challenge
    ? "OpenAI Agent Identity 注册被上游验证拦截 (HTTP 403)，请改用 OAuth 导入或稍后重试"
    : statusCode === 401
      ? "OpenAI 拒绝当前账号凭据的 Agent Identity 注册 (HTTP 401)，请改用 OAuth 导入"
      : statusCode === 403
        ? "OpenAI 拒绝当前账号的 Agent Identity 注册 (HTTP 403)，请改用 OAuth 导入"
        : `OpenAI Agent Identity 注册失败 (HTTP ${statusCode || "unknown"})`;
  const status = statusCode === 401 || statusCode === 403 ? 409 : 502;
  return Object.assign(errorWithStatus(message, status), code ? { code } : {});
}

function retryDelayMs(response, attempt) {
  const exponential = Math.min(1_000, 250 * (2 ** (attempt - 1)));
  const value = String(response?.headers?.get?.("retry-after") || "").trim();
  if (!value) return exponential;
  const seconds = Number(value);
  const retryAfterMs = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return exponential;
  return Math.min(2_000, Math.max(exponential, retryAfterMs));
}

export async function registerOpenAiAgentIdentity({
  accessToken,
  accountId,
  userId,
  email = "",
  planType = "free",
  fedRamp = false,
  fetchFn = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  agentVersion = process.env.CODEX_AGENT_VERSION || DEFAULT_AGENT_VERSION,
  originator = DEFAULT_ORIGINATOR,
  userAgent,
  runtimePlatform = process.platform,
  runtimeRelease = os.release(),
  runtimeArch = process.arch,
  terminal = process.env.TERM_PROGRAM || process.env.TERM || "unknown",
  sleepFn = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const token = nonEmptyText(accessToken, "注册账号 access token", 100_000);
  const normalizedAccountId = nonEmptyText(accountId, "注册账号 workspace ID");
  const normalizedUserId = nonEmptyText(userId, "注册账号用户 ID");
  if (typeof fetchFn !== "function") throw errorWithStatus("Agent Identity 注册网络客户端不可用", 503);

  const keyMaterial = generateAgentIdentityKeyMaterial();
  const effectiveTimeoutMs = Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const effectiveOriginator = safeHeaderText(originator, DEFAULT_ORIGINATOR, 80)
    .replace(/[^a-z0-9_.-]/gi, "_");
  const effectiveAgentVersion = safeHeaderText(agentVersion, DEFAULT_AGENT_VERSION, 80);
  const effectiveUserAgent = safeHeaderText(
    userAgent || codexUserAgent({
      originator: effectiveOriginator,
      agentVersion: effectiveAgentVersion,
      runtimePlatform,
      runtimeRelease,
      runtimeArch,
      terminal,
    }),
    `${DEFAULT_ORIGINATOR}/${DEFAULT_AGENT_VERSION}`,
  );
  for (let attempt = 1; attempt <= MAX_REGISTER_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    timer.unref?.();
    try {
      const response = await fetchFn(AGENT_IDENTITY_REGISTER_URL, {
        method: "POST",
        signal: controller.signal,
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          originator: effectiveOriginator,
          "User-Agent": effectiveUserAgent,
          ...(fedRamp ? { "X-OpenAI-Fedramp": "true" } : {}),
        },
        body: JSON.stringify({
          abom: {
            agent_version: effectiveAgentVersion,
            agent_harness_id: "codex-cli",
            running_location: `cli-${platformName(runtimePlatform)}`,
          },
          agent_public_key: keyMaterial.publicKeyOpenSsh,
          capabilities: ["responsesapi"],
          ttl: null,
        }),
      });
      if (!response.ok) {
        const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);
        try { await response.body?.cancel?.(); } catch { /* ignore cleanup errors */ }
        if (retryable && attempt < MAX_REGISTER_ATTEMPTS) {
          await sleepFn(retryDelayMs(response, attempt));
          continue;
        }
        if (retryable) {
          throw errorWithStatus(`OpenAI Agent Identity 注册失败 (HTTP ${response.status})`, 503);
        }
        throw agentRegistrationError(response);
      }

      const raw = await limitedResponseText(response);
      let payload;
      try { payload = raw ? JSON.parse(raw) : null; }
      catch { throw errorWithStatus("OpenAI Agent Identity 注册响应无效", 502); }
      const runtimeId = String(payload?.agent_runtime_id || "").trim();
      if (!runtimeId || runtimeId.length > 4_096) {
        throw errorWithStatus("OpenAI Agent Identity 注册响应无效", 502);
      }
      return {
        authJson: {
          auth_mode: "agentIdentity",
          agent_identity: {
            agent_runtime_id: runtimeId,
            agent_private_key: keyMaterial.privateKeyPkcs8Base64,
            account_id: normalizedAccountId,
            chatgpt_user_id: normalizedUserId,
            email: String(email || "").trim(),
            plan_type: String(planType || "free").trim() || "free",
            chatgpt_account_is_fedramp: Boolean(fedRamp),
          },
        },
        runtimeId,
        secrets: [keyMaterial.privateKeyPkcs8Base64, runtimeId],
      };
    } catch (error) {
      if (error?.name === "AbortError") throw errorWithStatus("OpenAI Agent Identity 注册超时", 504);
      if (Number.isInteger(error?.status)) throw error;
      throw errorWithStatus("OpenAI Agent Identity 注册请求失败", 502);
    } finally {
      clearTimeout(timer);
    }
  }
  throw errorWithStatus("OpenAI Agent Identity 注册失败", 502);
}
