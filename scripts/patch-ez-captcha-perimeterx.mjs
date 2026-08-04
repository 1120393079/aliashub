import fs from "node:fs";
import path from "node:path";

const executable = process.argv[2];
if (!executable) {
  throw new Error("usage: node patch-ez-captcha-perimeterx.mjs <runner.exe>");
}

const originalBaseUrl = Buffer.from("https://api.captcha-run.com", "ascii");
const adapterBaseUrl = Buffer.from("http://127.0.0.1:4180/ezapi", "ascii");
const typeSwitchOffset = 0x49bb48;
const originalTypeSwitch = Buffer.from("4883f9010f853f1c0000803a330f85361c0000", "hex");
const adapterTypeSwitch = Buffer.from("0fb60a83e93283f9010f873a1c00000f1f4000", "hex");

if (originalBaseUrl.length !== adapterBaseUrl.length || originalTypeSwitch.length !== adapterTypeSwitch.length) {
  throw new Error("compatibility patches must preserve executable lengths");
}

const executableStat = fs.statSync(executable);
const binary = fs.readFileSync(executable);
const baseUrlOffset = binary.indexOf(originalBaseUrl);
const patchedBaseUrlOffset = binary.indexOf(adapterBaseUrl);
const switchBytes = binary.subarray(typeSwitchOffset, typeSwitchOffset + originalTypeSwitch.length);
const switchIsOriginal = switchBytes.equals(originalTypeSwitch);
const switchIsPatched = switchBytes.equals(adapterTypeSwitch);

if (baseUrlOffset === -1 && patchedBaseUrlOffset !== -1 && switchIsPatched) {
  console.log("EZ-Captcha compatibility patch already present");
  process.exit(0);
}
if (baseUrlOffset === -1 || binary.indexOf(originalBaseUrl, baseUrlOffset + 1) !== -1) {
  throw new Error("CaptchaRun base URL was not found exactly once");
}
if (!switchIsOriginal) {
  throw new Error("captcha platform switch does not match the expected v9.2.8 code");
}

const backup = `${executable}.pre-ez-adapter`;
if (!fs.existsSync(backup)) {
  fs.copyFileSync(executable, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, executableStat.mode);
  fs.chownSync(backup, executableStat.uid, executableStat.gid);
}

adapterBaseUrl.copy(binary, baseUrlOffset);
adapterTypeSwitch.copy(binary, typeSwitchOffset);
const temporary = path.join(path.dirname(executable), `.${path.basename(executable)}.ez-patch-${process.pid}`);
fs.writeFileSync(temporary, binary);
fs.chmodSync(temporary, executableStat.mode);
fs.chownSync(temporary, executableStat.uid, executableStat.gid);
fs.renameSync(temporary, executable);

console.log(`Patched EZ-Captcha adapter URL at offset ${baseUrlOffset}`);
console.log(`Enabled captcha platform types 2 and 3 at offset ${typeSwitchOffset}`);
