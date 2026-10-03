// Builds the app people download: signed with a Developer ID under the
// hardened runtime (build/entitlements.mac.plist), notarized by Apple and
// stapled, then packed in a DMG that is signed, notarized, and stapled too,
// so it opens on any Mac without a Gatekeeper warning. Output: release/.
//
//   APPLE_API_KEY=<path to AuthKey_XXXX.p8> APPLE_API_KEY_ID=<key id> \
//   APPLE_API_ISSUER=<issuer id> npm run release
//
// It signs with the "Developer ID Application" certificate in a keychain of
// its own, ~/.coding-plan-hub/signing/developer-id/developer-id.keychain-db
// (or CPH_SIGN_KEYCHAIN), unlocked with the password file beside it (or
// CPH_SIGN_KEYCHAIN_PASSWORD), so signing never waits on a keychain prompt.
// Without that keychain it looks in the usual ones. CPH_SIGN_IDENTITY picks
// an identity outright. --no-notarize skips Apple's check so the build can
// be tried with another identity; its DMG is marked -unnotarized.
// Apple can take hours over a first submission from a new certificate. If a
// run stops while waiting, it prints how to resume:
//   npm run release -- --app <the signed app> --submission <Apple's id>
// which waits on that submission instead of building and sending again.
// .github/workflows/release.yml can run this on GitHub instead.
// npm run package:app is still the quick local install, signed with a
// self-made key.
import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const NAME = pkg.productName;
const ENTITLEMENTS = join(root, "build", "entitlements.mac.plist");
const notarize = !process.argv.includes("--no-notarize");
const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
const givenApp = argValue("--app");
const givenSubmission = argValue("--submission");

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 26, ...opts })?.trim();
const fail = (message) => {
  console.error(`\nRelease stopped: ${message}\n`);
  process.exit(1);
};

if (process.platform !== "darwin") fail("releases build on macOS only.");
if (givenSubmission && !givenApp) fail("--submission needs --app, the signed app that was submitted.");

// codesign finds identities only in the keychain search list, so the
// signing keychain joins it for the build and the list goes back after
const keychain = process.env.CPH_SIGN_KEYCHAIN || join(homedir(), ".coding-plan-hub", "signing", "developer-id", "developer-id.keychain-db");
if (existsSync(keychain)) {
  const passwordFile = join(dirname(keychain), "password");
  const password = process.env.CPH_SIGN_KEYCHAIN_PASSWORD ?? (existsSync(passwordFile) ? readFileSync(passwordFile, "utf8").trim() : "");
  run("security", ["unlock-keychain", "-p", password, keychain]);
  const searchList = run("security", ["list-keychains", "-d", "user"])
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter((path) => path && path !== keychain);
  run("security", ["list-keychains", "-d", "user", "-s", ...searchList, keychain]);
  process.on("exit", () => {
    execFileSync("security", ["list-keychains", "-d", "user", "-s", ...searchList]);
  });
}

// signed by its hash: the same name can sit in two keychains, which codesign
// refuses as ambiguous
let identity = process.env.CPH_SIGN_IDENTITY;
let identityName = identity;
if (!identity) {
  const found = run("security", ["find-identity", "-v", "-p", "codesigning", ...(existsSync(keychain) ? [keychain] : [])]).match(
    /([0-9A-F]{40}) "(Developer ID Application: [^"]+)"/
  );
  if (!found) {
    fail('no "Developer ID Application" certificate found. Create one at developer.apple.com under Certificates, or in Xcode: Settings > Accounts > Manage Certificates.');
  }
  [, identity, identityName] = found;
}
if (notarize && !identityName.startsWith("Developer ID Application:") && !process.env.CPH_SIGN_IDENTITY) {
  fail(`Apple only notarizes apps signed with a Developer ID, and "${identityName}" is not one. Use --no-notarize to try the build anyway.`);
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

const notaryArgs = () => ["--key", notary.key, "--key-id", notary.keyId, "--issuer", notary.issuer];
const notaryJson = (args) => JSON.parse(run("xcrun", ["notarytool", ...args, ...notaryArgs(), "--output-format", "json"]));

// Sends a file to Apple, or picks up a submission already sent, and checks
// on it every 30 seconds until Apple decides. A failed check is retried:
// notarytool's own --wait gave up on one passing 401 after 7 hours.
async function notarizeAndWait(file, what, submission, resumeHint) {
  let id = submission;
  if (!id) {
    let upload = file;
    if (file.endsWith(".app")) {
      upload = join(work, `${basename(file, ".app")}.zip`);
      run("ditto", ["-c", "-k", "--keepParent", file, upload]);
    }
    id = notaryJson(["submit", upload]).id;
  }
  console.log(`Notarizing the ${what}: Apple submission ${id}`);
  if (resumeHint) console.log(`If this run stops, resume with:\n  npm run release -- --app "${file}" --submission ${id}`);
  let failures = 0;
  for (;;) {
    let status;
    try {
      status = notaryJson(["info", id]).status;
      failures = 0;
    } catch (err) {
      failures++;
      if (failures >= 20) fail(`Apple's notary service failed 20 checks in a row (${String(err.message).split("\n")[0]}).`);
    }
    if (status === "Accepted") return;
    if (status && status !== "In Progress") {
      fail(`Apple did not accept the ${what} (${status}).\n${run("xcrun", ["notarytool", "log", id, ...notaryArgs()])}`);
    }
    await new Promise((done) => setTimeout(done, 30_000));
  }
}

console.log(`${NAME} ${pkg.version}: signing as ${identityName}, ${notarize ? "notarizing" : "not notarizing"}`);
if (!givenApp) run("npm", ["run", "-s", "build"], { cwd: root, stdio: "inherit" });

// built in a .noindex folder outside the Desktop: Spotlight and iCloud leave
// Finder info on fresh bundles, which codesign rejects
const work = join(mkdtempSync(join(tmpdir(), "cph-release-")), "work.noindex");
mkdirSync(work);
const outDir = join(root, "release");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir);

// the app needs only what electron-vite built, the Dock icon, and the license
const SHIPPED = /^\/(package\.json|LICENSE|out(\/.*)?|build|build\/civly-mark\.png)$/;
const packaged = givenApp
  ? null
  : await packager({
      dir: root,
      name: NAME,
      platform: "darwin",
      arch: "arm64",
      out: work,
      // packager's shared temp folder is cleared by any other packaging run,
      // such as npm run package:app, which would delete this build mid-signing
      tmpdir: join(work, "packager-tmp"),
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
      }
    });
const appPath = givenApp ? resolve(givenApp) : join(packaged[0], `${NAME}.app`);
if (givenApp) {
  if (!existsSync(appPath)) fail(`--app ${appPath} does not exist.`);
  const version = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(appPath, "Contents", "Info.plist")]);
  if (version !== pkg.version) fail(`--app is version ${version}, but package.json says ${pkg.version}.`);
}
run("codesign", ["--verify", "--deep", "--strict", appPath]);
if (notarize) {
  await notarizeAndWait(appPath, "app", givenSubmission, true);
  run("xcrun", ["stapler", "staple", appPath]);
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
  await notarizeAndWait(dmg, "DMG");
  run("xcrun", ["stapler", "staple", dmg]);
  run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", dmg]);
}

const sha = createHash("sha256").update(readFileSync(dmg)).digest("hex");
writeFileSync(`${dmg}.sha256`, `${sha}  ${basename(dmg)}\n`);
rmSync(resolve(work, ".."), { recursive: true, force: true });
console.log(`\n${dmg}\nsha256 ${sha}`);
