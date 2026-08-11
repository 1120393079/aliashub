import assert from "node:assert/strict";
import test from "node:test";
import {
  codeFromText,
  isIcloudImportedStrategy,
  microsoftDomains,
  normalizeIcloudCustomDomainEmail,
  normalizeMicrosoftEmail,
  splitAddress,
} from "../address-generator.js";

test("accepts supported Microsoft source domains", () => {
  const expectedDomains = [
    "outlook.com", "outlook.at", "outlook.be", "outlook.cl", "outlook.co.id", "outlook.co.il",
    "outlook.co.nz", "outlook.co.th", "outlook.com.ar", "outlook.com.au", "outlook.com.br",
    "outlook.com.gr", "outlook.com.tr", "outlook.com.vn", "outlook.cz", "outlook.de", "outlook.dk",
    "outlook.es", "outlook.fr", "outlook.hu", "outlook.ie", "outlook.in", "outlook.it", "outlook.jp",
    "outlook.kr", "outlook.lv", "outlook.my", "outlook.ph", "outlook.pt", "outlook.sa", "outlook.sg",
    "outlook.sk",
    "hotmail.com", "live.com", "msn.com",
  ];
  assert.deepEqual(microsoftDomains, expectedDomains);
  for (const domain of expectedDomains) {
    assert.equal(normalizeMicrosoftEmail(`Name@${domain}`), `name@${domain}`);
  }
  assert.equal(normalizeMicrosoftEmail("name@gmail.com"), "");
  assert.equal(normalizeMicrosoftEmail("name@outlook.example"), "");
  assert.equal(normalizeMicrosoftEmail("name@outlook.co.fake"), "");
  assert.equal(normalizeMicrosoftEmail("name@outlook.co.uk"), "");
});

test("splits primary and official aliases independently", () => {
  assert.equal(splitAddress("main@hotmail.com", { prefix: "shop", mode: "sequence", sequence: 1 }), "main+shop-0001@hotmail.com");
  assert.equal(splitAddress("official@outlook.com", { prefix: "shop", mode: "sequence", sequence: 1 }), "official+shop-0001@outlook.com");
  assert.equal(splitAddress("main@hotmail.com", { customTag: "gpt-campaign" }), "main+gpt-campaign@hotmail.com");
});

test("accepts iCloud custom-domain addresses as imported direct-registration addresses", () => {
  assert.equal(normalizeIcloudCustomDomainEmail("Apple@custom.example"), "apple@custom.example");
  assert.equal(normalizeIcloudCustomDomainEmail("name@icloud.com"), "");
  assert.equal(normalizeIcloudCustomDomainEmail("relay@privaterelay.appleid.com"), "");
  assert.equal(isIcloudImportedStrategy("icloud_custom_domain"), true);
});

test("extracts contextual verification codes", () => {
  assert.equal(codeFromText("Your verification code is 482913"), "482913");
  assert.equal(codeFromText("この一時検証コードを入力して続行してください: 654321"), "654321");
  assert.equal(codeFromText("Mã xác minh tạm thời này để tiếp tục: 527481"), "527481");
  assert.equal(codeFromText("Microsoft 帐户安全代码：731055"), "731055");
  assert.equal(codeFromText("Order 482913 has shipped"), "");
});
