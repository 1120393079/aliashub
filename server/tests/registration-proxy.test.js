import assert from "node:assert/strict";
import test from "node:test";
import {
  kookeeyStickyTemplate,
  maskProxy,
  materializeProxySession,
  parseProxyPool,
  proxyMetadata,
  redactProxySecrets,
  resolveJobProxies,
  safeProxySamples,
  sanitizeRegistrationRemoteValue,
  statusCheckProxyRoute,
} from "../registration-proxy.js";

const stickyProxy = "http://proxy-user:base-secret-TR-12345678-30m@gate-us.kookeey.info:1000";

test("registration proxy parser normalizes supported forms and rejects ambiguous credentials", () => {
  assert.deepEqual(parseProxyPool(`
# comment
plain-proxy.example:3128
proxy.example:8080:user+name:p@ss
plain-proxy.example:3128
`), [
    "http://plain-proxy.example:3128",
    "http://user%2Bname:p%40ss@proxy.example:8080",
  ]);

  assert.throws(
    () => parseProxyPool(["socks5://user:secret@proxy.example:1080"]),
    (error) => error.status === 400 && error.message === "第 1 条代理地址无效",
  );
  assert.throws(
    () => parseProxyPool(["proxy.example:8080:user:password:extra"]),
    (error) => error.status === 400 && error.message === "第 1 条代理地址无效",
  );
});

test("registration proxy helpers expose safe labels and redact nested remote values", () => {
  assert.equal(maskProxy(stickyProxy), "http://***@gate-us.kookeey.info:1000");
  assert.equal(maskProxy(""), "直连");
  assert.equal(
    redactProxySecrets(`upstream rejected ${stickyProxy}`),
    "upstream rejected http://***@gate-us.kookeey.info:1000",
  );
  assert.deepEqual(sanitizeRegistrationRemoteValue({
    message: `upstream rejected ${stickyProxy}`,
    proxy: { username: "proxy-user", password: "base-secret", session_id: "12345678" },
    detail: { fingerprint_session_id: "safe-fingerprint" },
  }), {
    message: "upstream rejected http://***@gate-us.kookeey.info:1000",
    proxy: { username: "[REDACTED]", password: "[REDACTED]", session_id: "[REDACTED]" },
    detail: { fingerprint_session_id: "safe-fingerprint" },
  });
});

test("registration proxy helpers materialize independent Kookeey sessions", () => {
  assert.deepEqual(proxyMetadata(stickyProxy), {
    provider: "Kookeey",
    dynamic_mode: "sticky_session",
    country_code: "TR",
    session_ttl: "30m",
  });
  assert.equal(kookeeyStickyTemplate("http://proxy.example:8080"), null);

  const usedSessions = new Set();
  const first = materializeProxySession(stickyProxy, usedSessions);
  const second = materializeProxySession(stickyProxy, usedSessions);
  assert.notEqual(first, stickyProxy);
  assert.notEqual(second, stickyProxy);
  assert.notEqual(first, second);
  for (const value of [first, second]) {
    const password = decodeURIComponent(new URL(value).password);
    assert.match(password, /^base-secret-TR-\d{8}-30m$/);
  }

  const route = statusCheckProxyRoute(maskProxy(stickyProxy), [stickyProxy], new Set());
  assert.equal(route.primary, stickyProxy);
  assert.notEqual(route.fallback, stickyProxy);
  assert.deepEqual(statusCheckProxyRoute("直连", [stickyProxy]), { primary: "", fallback: "" });
});

test("registration proxy selection and inspection samples preserve service behavior", () => {
  const saved = ["http://first.example:8001", "http://second.example:8002"];
  assert.equal(resolveJobProxies({ proxySelection: "auto" }, saved), saved);
  assert.deepEqual(resolveJobProxies({ proxySelection: "direct" }, saved), []);
  assert.deepEqual(resolveJobProxies({ proxySelection: "proxy:1" }, saved), [saved[1]]);
  assert.throws(
    () => resolveJobProxies({ proxySelection: "proxy:2" }, saved),
    (error) => error.status === 409,
  );

  assert.deepEqual(safeProxySamples({ samples: [{
    ip: "203.0.113.10",
    country_code: "JP",
    country_name: "Japan",
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    latitude: "35.68",
    longitude: "139.76",
  }] }, 1), [{
    ip: "203.0.113.10",
    country_code: "JP",
    country_name: "Japan",
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    latitude: 35.68,
    longitude: 139.76,
  }]);
  assert.throws(
    () => safeProxySamples({ samples: [{ ip: "not-an-ip" }] }, 1),
    /代理检测服务返回了无效 IP/,
  );
});
