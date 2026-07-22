import crypto from "node:crypto";

function parseCookies(header = "") {
  return Object.fromEntries(
    String(header)
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key]) => key)
      .map(([key, ...rest]) => [key, decodeURIComponent(rest.join("="))]),
  );
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createAuth({ username = "admin", password = "", secret = "", secure = false } = {}) {
  const enabled = Boolean(password);
  const signingSecret = secret || crypto.createHash("sha256").update(`aliashub:${password || "local"}`).digest("hex");

  function sign(timestamp) {
    return crypto.createHmac("sha256", signingSecret).update(`${username}:${timestamp}`).digest("base64url");
  }

  function issueCookie(res) {
    const timestamp = Date.now();
    const token = Buffer.from(`${timestamp}.${sign(timestamp)}`).toString("base64url");
    const flags = [`aliashub_session=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=604800"];
    if (secure) flags.push("Secure");
    res.setHeader("Set-Cookie", flags.join("; "));
  }

  function clearCookie(res) {
    res.setHeader("Set-Cookie", `aliashub_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`);
  }

  function validSession(req) {
    if (!enabled) return true;
    const encoded = parseCookies(req.headers.cookie).aliashub_session;
    if (!encoded) return false;
    try {
      const decoded = Buffer.from(encoded, "base64url").toString("utf8");
      const [timestampText, signature] = decoded.split(".");
      const timestamp = Number(timestampText);
      if (!timestamp || Date.now() - timestamp > 7 * 24 * 60 * 60 * 1000) return false;
      return safeEqual(signature, sign(timestamp));
    } catch {
      return false;
    }
  }

  return {
    enabled,
    status(req, res) {
      const authenticated = validSession(req);
      res.json({ authenticated, authEnabled: enabled, ...(authenticated && enabled ? { username } : {}) });
    },
    check(req, res) {
      if (validSession(req)) return res.status(204).end();
      return res.status(401).end();
    },
    login(req, res) {
      if (!enabled) return res.json({ authenticated: true, authEnabled: false });
      if (safeEqual(req.body?.username, username) && safeEqual(req.body?.password, password)) {
        issueCookie(res);
        return res.json({ authenticated: true, username });
      }
      return res.status(401).json({ error: "用户名或密码错误" });
    },
    logout(_req, res) {
      clearCookie(res);
      res.json({ ok: true });
    },
    requireAdmin(req, res, next) {
      if (validSession(req)) return next();
      return res.status(401).json({ error: "请先登录", code: "AUTH_REQUIRED" });
    },
  };
}
