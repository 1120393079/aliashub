import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRefreshTokenExportEntry,
  buildSub2ExportEntry,
  refreshTokenExportFilename,
  serializeRefreshTokens,
  serializeSub2Export,
  sub2ExportFilename,
} from "../../src/pages/registration/sub2-export.js";

test("builds a Sub2 Codex Session entry without unrelated account fields", () => {
  const entry = buildSub2ExportEntry({
    id: 47,
    email: "PLUS@EXAMPLE.COM",
    custom_name: "Plus sale 01",
    password: "must-not-export",
  }, "access-token-private");

  assert.deepEqual(entry, {
    name: "Plus sale 01",
    email: "plus@example.com",
    access_token: "access-token-private",
  });
  assert.doesNotMatch(JSON.stringify(entry), /must-not-export/);
});

test("serializes a directly importable JSON array and creates a stable filename", () => {
  const document = serializeSub2Export([
    buildSub2ExportEntry({ email: "buyer@example.com" }, "token-one"),
  ]);

  assert.deepEqual(JSON.parse(document), [{
    name: "buyer@example.com",
    email: "buyer@example.com",
    access_token: "token-one",
  }]);
  assert.equal(
    sub2ExportFilename(4, new Date("2026-08-03T01:39:45.123Z")),
    "sub2-openai-4-20260803T013945Z.json",
  );
});

test("rejects incomplete or empty exports", () => {
  assert.throws(() => buildSub2ExportEntry({ email: "" }, "token"), /邮箱为空/);
  assert.throws(() => buildSub2ExportEntry({ email: "a@example.com" }, ""), /AT 为空/);
  assert.throws(() => serializeSub2Export([]), /没有可导出/);
});

test("serializes Refresh Tokens as account JSON", () => {
  const now = new Date("2026-08-03T01:39:45.123Z");
  const document = serializeRefreshTokens([
    buildRefreshTokenExportEntry(
      { email: "PLUS@EXAMPLE.COM", custom_name: "Plus 01" },
      { access_token: " at-one ", refresh_token: " rt-one ", id_token: "id-one" },
    ),
  ], now);
  assert.deepEqual(JSON.parse(document), {
    exported_at: now.toISOString(),
    proxies: [],
    accounts: [{
      name: "Plus 01",
      platform: "openai",
      type: "oauth",
      credentials: {
        access_token: "at-one",
        refresh_token: "rt-one",
        id_token: "id-one",
        email: "plus@example.com",
      },
      extra: { email: "plus@example.com" },
      concurrency: 1,
      priority: 0,
      rate_multiplier: 1,
      auto_pause_on_expired: false,
    }],
  });
  assert.equal(
    refreshTokenExportFilename(2, now),
    "sub2api-account-20260803013945.json",
  );
  assert.throws(() => buildRefreshTokenExportEntry({ email: "" }, { access_token: "at", refresh_token: "rt" }), /邮箱为空/);
  assert.throws(() => buildRefreshTokenExportEntry({ email: "a@example.com" }, { refresh_token: "rt" }), /AT 为空/);
  assert.throws(() => buildRefreshTokenExportEntry({ email: "a@example.com" }, { access_token: "at" }), /Refresh Token 为空/);
  assert.throws(() => serializeRefreshTokens([]), /没有可导出/);
});
