import assert from "node:assert/strict";
import test from "node:test";
import { createAuth } from "../auth.js";

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.ended = true; return this; },
    end() { this.ended = true; return this; },
  };
}

test("auth check rejects anonymous requests and accepts a signed admin session", () => {
  const auth = createAuth({
    username: "admin",
    password: "correct-password",
    secret: "test-session-secret",
    secure: true,
  });

  const anonymousStatus = response();
  auth.status({ headers: {} }, anonymousStatus);
  assert.deepEqual(anonymousStatus.body, { authenticated: false, authEnabled: true });

  const anonymousCheck = response();
  auth.check({ headers: {} }, anonymousCheck);
  assert.equal(anonymousCheck.statusCode, 401);

  const login = response();
  auth.login({ body: { username: "admin", password: "correct-password" } }, login);
  assert.equal(login.statusCode, 200);
  const cookie = login.headers["set-cookie"].split(";", 1)[0];

  const authenticatedStatus = response();
  auth.status({ headers: { cookie } }, authenticatedStatus);
  assert.deepEqual(authenticatedStatus.body, {
    authenticated: true,
    authEnabled: true,
    username: "admin",
  });

  const authenticatedCheck = response();
  auth.check({ headers: { cookie } }, authenticatedCheck);
  assert.equal(authenticatedCheck.statusCode, 204);
});

test("auth check remains open when administrator authentication is disabled", () => {
  const auth = createAuth({ password: "" });
  const result = response();
  auth.check({ headers: {} }, result);
  assert.equal(result.statusCode, 204);
});
