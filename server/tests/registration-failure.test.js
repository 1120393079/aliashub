import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCOUNT_CREATION_POLICY_BLOCKED_REASON,
  knownRegistrationFailureReason,
  OCCUPIED_ALIAS_FAILURE_REASON,
  occupiedAliasHistory,
  publicRegistrationJob,
  registrationFailureReason,
  remoteRegistrationFailureReason,
} from "../registration-failure.js";

test("registration failure classifier preserves occupied-account detection", () => {
  assert.equal(knownRegistrationFailureReason("emailAlreadyRegistered"), OCCUPIED_ALIAS_FAILURE_REASON);
  assert.equal(remoteRegistrationFailureReason({
    result: { errors: [{ error_code: "email_already_registered_on_openai" }] },
  }), OCCUPIED_ALIAS_FAILURE_REASON);
  assert.equal(registrationFailureReason({
    status: "failed",
    message: "about_you 提交失败: user_already_exists",
  }), OCCUPIED_ALIAS_FAILURE_REASON);
});

test("registration failure classifier maps registration_disallowed to a stable policy reason", () => {
  assert.equal(
    knownRegistrationFailureReason("registration_disallowed"),
    ACCOUNT_CREATION_POLICY_BLOCKED_REASON,
  );
  assert.equal(remoteRegistrationFailureReason({
    status: "failed",
    data: {
      error: {
        error_code: "registration_disallowed",
        message: "Sorry, we cannot create your account with the given information.",
      },
    },
  }), ACCOUNT_CREATION_POLICY_BLOCKED_REASON);
});

test("registration failure classifier recognizes multilingual policy rejections", () => {
  const messages = [
    "Sorry, we cannot create your account with the given information.",
    "利用規約のため、お客様のアカウントを作成できません。",
    "根据服务条款，无法创建您的账户。",
    "이용약관에 따라 계정을 만들 수 없습니다.",
    "En raison de notre politique, nous ne pouvons pas créer votre compte.",
  ];
  for (const message of messages) {
    assert.equal(
      remoteRegistrationFailureReason({ message }),
      ACCOUNT_CREATION_POLICY_BLOCKED_REASON,
      message,
    );
  }
  assert.equal(remoteRegistrationFailureReason({ message: "registration failed after proxy timeout" }), "");
});

test("public registration jobs expose a clear policy-blocked message without proxy secrets", () => {
  const item = publicRegistrationJob({
    id: 42,
    status: "failed",
    stage: "about_you",
    failure_reason: "registration_disallowed",
    message: "upstream http://private-user:private-password@proxy.example:8080 cannot create your account",
  });
  assert.equal(item.failure_reason, ACCOUNT_CREATION_POLICY_BLOCKED_REASON);
  assert.equal(item.display_message, "目标站按注册策略拒绝创建账号，请更换网络出口或邮箱后重试");
  assert.equal(item.message, "upstream http://***@proxy.example:8080 cannot create your account");
  assert.doesNotMatch(JSON.stringify(item), /private-user|private-password/);
});

test("occupied alias history excludes policy-blocked registrations", () => {
  const history = occupiedAliasHistory([
    {
      status: "failed",
      email: "Used@outlook.com",
      failure_reason: "user_already_exists",
      finished_at: "2026-07-25T00:00:00.000Z",
    },
    {
      status: "failed",
      email: "used@outlook.com",
      message: "email already registered",
      finished_at: "2026-07-26T00:00:00.000Z",
    },
    {
      status: "failed",
      email: "policy@outlook.com",
      failure_reason: "registration_disallowed",
      finished_at: "2026-07-27T00:00:00.000Z",
    },
  ]);
  assert.deepEqual(history, {
    count: 1,
    aliases: [{ email: "used@outlook.com", last_seen_at: "2026-07-26T00:00:00.000Z" }],
    lastSeenAt: "2026-07-26T00:00:00.000Z",
  });
});
