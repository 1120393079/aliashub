export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const productionBase = import.meta.env.BASE_URL.replace(/\/$/, "");
export const appBase = import.meta.env.DEV ? "" : productionBase;

export async function api(path, options = {}) {
  const target = path.startsWith("http") ? path : `${appBase}${path}`;
  const response = await fetch(target, {
    credentials: "same-origin",
    ...options,
    cache: options.cache ?? "no-store",
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    body: options.body && !(options.body instanceof FormData) && typeof options.body !== "string"
      ? JSON.stringify(options.body)
      : options.body,
  });
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    throw new ApiError(data?.error || data?.message || data || "请求失败", response.status, data?.code);
  }
  return data;
}

export function appUrl(path) {
  return `${appBase}${path}`;
}

export function queryString(values) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "" && value !== "all") params.set(key, String(value));
  });
  const text = params.toString();
  return text ? `?${text}` : "";
}
