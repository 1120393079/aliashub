const CAPTCHA_RUN_BASE_URL = "https://api.captcha-run.com";
const EZ_CAPTCHA_BASE_URL = "https://api.ez-captcha.com";
const MICROSOFT_PERIMETERX_KEY = "PXH9SXukH";

function isLoopback(req) {
  const address = String(req.socket?.remoteAddress || "");
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function bearerKey(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || "").trim());
  return match?.[1]?.trim() || "";
}

function findPerimeterXKey(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return "";
  if (typeof value === "string") return /^PX[A-Za-z0-9_-]{6,40}$/.test(value) ? value : "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPerimeterXKey(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  for (const key of ["websiteKey", "captcha_app_key", "captchaAppKey", "appId", "app_id"]) {
    const found = findPerimeterXKey(value[key], depth + 1);
    if (found) return found;
  }
  for (const item of Object.values(value)) {
    const found = findPerimeterXKey(item, depth + 1);
    if (found) return found;
  }
  return "";
}

async function relay(res, response) {
  const body = await response.text();
  res.status(response.status);
  res.type(response.headers.get("content-type") || "application/json");
  res.send(body);
}

export function registerEzCaptchaAdapter({ app, db, fetchFn = fetch }) {
  const captchaType = () => String(db.prepare(
    "SELECT captcha_type FROM microsoft_registration_runner_config WHERE id = 1",
  ).get()?.captcha_type || "");

  const requireLoopback = (req, res, next) => {
    if (!isLoopback(req)) return res.status(404).end();
    return next();
  };

  app.use("/ezapi", requireLoopback);

  app.post("/ezapi/v2/tasks", async (req, res, next) => {
    try {
      const key = bearerKey(req);
      if (!key) return res.status(401).json({ error: "missing captcha key" });

      if (captchaType() !== "2") {
        const response = await fetchFn(`${CAPTCHA_RUN_BASE_URL}/v2/tasks`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(req.body || {}),
        });
        return await relay(res, response);
      }

      const websiteKey = findPerimeterXKey(req.body) || MICROSOFT_PERIMETERX_KEY;
      const response = await fetchFn(`${EZ_CAPTCHA_BASE_URL}/createTask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientKey: key,
          task: { type: "PerimeterX", websiteKey },
        }),
      });
      return await relay(res, response);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/ezapi/v2/tasks/:taskId", async (req, res, next) => {
    try {
      const key = bearerKey(req);
      if (!key) return res.status(401).json({ error: "missing captcha key" });

      if (captchaType() !== "2") {
        const response = await fetchFn(`${CAPTCHA_RUN_BASE_URL}/v2/tasks/${encodeURIComponent(req.params.taskId)}`, {
          headers: { authorization: `Bearer ${key}` },
        });
        return await relay(res, response);
      }

      const response = await fetchFn(`${EZ_CAPTCHA_BASE_URL}/getTaskResult`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKey: key, taskId: req.params.taskId }),
      });
      return await relay(res, response);
    } catch (error) {
      return next(error);
    }
  });
}
