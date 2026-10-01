// Builds the app people download: signed with a Developer ID under the
// hardened runtime (build/entitlements.mac.plist), notarized by Apple and
// stapled, then packed in a DMG that is signed, notarized, and stapled too,
// so it opens on any Mac without a Gatekeeper warning. Output: release/.
//
//   APPLE_API_KEY=<path to AuthKey_XXXX.p8> APPLE_API_KEY_ID=<key id> \
//   APPLE_API_ISSUER=<issuer id> npm run release
//
// It signs with the keychain's "Developer ID Application" certificate, or
// CPH_SIGN_IDENTITY. --no-notarize skips Apple's check so the build can be
// tried with another identity; its DMG is marked -unnotarized.
// .github/workflows/release.yml runs this for each version tag.
// npm run package:app is still the quick local install, signed with a
// self-made key.
import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const NAME = pkg.productName;
const ENTITLEMENTS = join(root, "build", "entitlements.mac.plist");
const notarize = !process.argv.includes("--no-notarize");

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 26, ...opts })?.trim();
const fail = (message) => {
  console.error(`\nRelease stopped: ${message}\n`);
  process.exit(1);
};

if (process.platform !== "darwin") fail("releases build on macOS only.");

let identity = process.env.CPH_SIGN_IDENTITY;
if (!identity) {
  const found = run("security", ["find-identity", "-v", "-p", "codesigning"]).match(/"(Developer ID Application: [^"]+)"/);
  if (!found) {
    fail('no "Developer ID Application" certificate in the keychain. Create one in Xcode: Settings > Accounts > Manage Certificates > + > Developer ID Application.');
  }
  identity = found[1];
}
if (notarize && !identity.startsWith("Developer ID Application:")) {
  fail(`Apple only notarizes apps signed with a Developer ID, and "${identity}" is not one. Use --no-notarize to try the build anyway.`);
}

let notary;
if (notarize) {
  const { APPLE_API_KEY: key, APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER: issuer } = process.env;
  if (!key || !keyId || !issuer) {
    fail("set APPLE_API_KEY (path to the .p8 file), APPLE_API_KEY_ID and APPLE_API_ISSUER from an App Store Connect API key.");
  }
  if (!existsSync(key)) fail(`APPLE_API_KEY points to ${key}, which does not exist.`);
  notary = { key, keyId, issuer };
}

console.log(`${NAME} ${pkg.version}: signing as ${identity}, ${notarize ? "notarizing" : "not notarizing"}`);
run("npm", ["run", "-s", "build"], { cwd: root, stdio: "inherit" });

// built in a .noindex folder outside the Desktop: Spotlight and iCloud leave
// Finder info on fresh bundles, which codesign rejects
const work = join(mkdtempSync(join(tmpdir(), "cph-release-")), "work.noindex");
mkdirSync(work);
const outDir = join(root, "release");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir);

// the app needs only what electron-vite built, the Dock icon, and the license
const SHIPPED = /^\/(package\.json|LICENSE|out(\/.*)?|build|build\/civly-mark\.png)$/;
const [built] = await packager({
  dir: root,
  name: NAME,
  platform: "darwin",
  arch: "arm64",
  out: work,
  overwrite: true,
  icon: join(root, "build", "icon.icns"),
  appBundleId: "com.civly.codingplatform",
  appCategoryType: "public.app-category.developer-tools",
  appVersion: pkg.version,
  ignore: (path) => path !== "" && !SHIPPED.test(path),
  extendInfo: {
    NSAppleEventsUsageDescription: "Brings a Chrome tab forward when the chats' browser needs you."
  },
  osxSign: {
    identity,
    // packager only warns about a failed signature unless told otherwise
    continueOnError: false,
    // the check that the identity is trusted would refuse a self-made key
    identityValidation: notarize,
    optionsForFile: () => ({
      hardenedRuntime: true,
      entitlements: ENTITLEMENTS,
      // Apple's timestamp server only stamps Apple-issued certificates
      ...(notarize ? {} : { timestamp: "none" })
    })
  },
  ...(notarize ? { osxNotarize: { appleApiKey: notary.key, appleApiKeyId: notary.keyId, appleApiIssuer: notary.issuer } } : {})
});
const appPath = join(built, `${NAME}.app`);
run("codesign", ["--verify", "--deep", "--strict", appPath]);
if (notarize) {
  run("xcrun", ["stapler", "validate", appPath]);
  run("spctl", ["--assess", "--type", "execute", appPath]);
}
console.log(`Signed${notarize ? ", notarized and stapled" : ""}: ${NAME}.app`);

// the DMG: the app, a link to Applications to drag it onto, and the license
const stage = join(work, "dmg");
mkdirSync(stage);
run("ditto", ["--norsrc", "--noextattr", appPath, join(stage, `${NAME}.app`)]);
symlinkSync("/Applications", join(stage, "Applications"));
copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE.txt"));
const dmg = join(outDir, `${NAME.replaceAll(" ", "-")}-${pkg.version}-arm64${notarize ? "" : "-unnotarized"}.dmg`);
run("hdiutil", ["create", "-quiet", "-volname", `${NAME} ${pkg.version}`, "-srcfolder", stage, "-fs", "HFS+", "-format", "UDZO", "-ov", dmg]);
run("codesign", ["--sign", identity, ...(notarize ? ["--timestamp"] : []), dmg]);

if (notarize) {
  console.log("Notarizing the DMG (usually a few minutes)");
  const submitted = JSON.parse(
    run("xcrun", ["notarytool", "submit", dmg, "--key", notary.key, "--key-id", notary.keyId, "--issuer", notary.issuer, "--wait", "--output-format", "json"])
  );
  if (submitted.status !== "Accepted") {
    const log = run("xcrun", ["notarytool", "log", submitted.id, "--key", notary.key, "--key-id", notary.keyId, "--issuer", notary.issuer]);
    fail(`Apple did not accept the DMG (${submitted.status}).\n${log}`);
  }
  run("xcrun", ["stapler", "staple", dmg]);
  run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", dmg]);
}

const sha = createHash("sha256").update(readFileSync(dmg)).digest("hex");
writeFileSync(`${dmg}.sha256`, `${sha}  ${basename(dmg)}\n`);
rmSync(resolve(work, ".."), { recursive: true, force: true });
console.log(`\n${dmg}\nsha256 ${sha}`);
