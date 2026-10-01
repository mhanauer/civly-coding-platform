#!/bin/zsh
# Packages the Civly Coding Platform .app with icon, bundle id, and a stable signature.
set -e
cd "$(dirname "$0")/.."

APP_NAME="Civly Coding Platform"

# macOS ties every privacy grant (Full Disk Access, App Management, folders)
# to the app's signature. An ad-hoc signature changes with each build, so
# every package used to drop them all and the prompts started over. This
# self-signed key signs every build the same way. It lives in its own keychain
# with a generated password, so signing never asks for the login password.
SIGN_DIR="$HOME/.coding-plan-hub/signing"
KEYCHAIN="$SIGN_DIR/signing.keychain-db"
if [ ! -f "$SIGN_DIR/cert.pem" ] || [ ! -f "$KEYCHAIN" ]; then
  rm -rf "$SIGN_DIR"
  mkdir -p "$SIGN_DIR"
  chmod 700 "$SIGN_DIR"
  /usr/bin/openssl rand -hex 24 > "$SIGN_DIR/password"
  chmod 600 "$SIGN_DIR/password"
  cat > "$SIGN_DIR/cert.cnf" <<'EOF'
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=Civly Coding Platform Local Signing
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
EOF
  # the system openssl on purpose: its .p12 imports into the keychain as is
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -config "$SIGN_DIR/cert.cnf" \
    -keyout "$SIGN_DIR/key.pem" -out "$SIGN_DIR/cert.pem" 2>/dev/null
  /usr/bin/openssl pkcs12 -export -inkey "$SIGN_DIR/key.pem" -in "$SIGN_DIR/cert.pem" \
    -out "$SIGN_DIR/key.p12" -passout "file:$SIGN_DIR/password"
  security create-keychain -p "$(<"$SIGN_DIR/password")" "$KEYCHAIN"
  security set-keychain-settings "$KEYCHAIN"
  security unlock-keychain -p "$(<"$SIGN_DIR/password")" "$KEYCHAIN"
  security import "$SIGN_DIR/key.p12" -k "$KEYCHAIN" -P "$(<"$SIGN_DIR/password")" -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$(<"$SIGN_DIR/password")" "$KEYCHAIN" >/dev/null
  # the key is in the keychain now
  rm -f "$SIGN_DIR/key.pem" "$SIGN_DIR/key.p12"
fi
SIGN_ID=$(/usr/bin/openssl x509 -in "$SIGN_DIR/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')
# built in a .noindex folder: Spotlight skips it, so it cannot tag the fresh
# bundle between the clean and the sign below. Outside the repo on purpose:
# iCloud Drive syncs the Desktop and keeps adding Finder info to the nested
# helper apps, which codesign rejects every time (seen 2026-09-28).
OUT="${TMPDIR:-/tmp}/civly-coding-package.noindex"
APP="$OUT/${APP_NAME}-darwin-arm64/${APP_NAME}.app"

# A previously run bundle carries com.apple.provenance stamps that codesign
# rejects and xattr cannot remove; always extract from scratch
rm -rf "$OUT/${APP_NAME}-darwin-arm64"

npm run build
npx electron-packager . "$APP_NAME" \
  --platform=darwin --arch=arm64 \
  --out="$OUT" --overwrite \
  --ignore="^/node_modules" --ignore="^/dist" --ignore="^/dist\.noindex" --ignore="^/scripts" --ignore="^/\.git"

cp build/icon.icns "$APP/Contents/Resources/icon.icns"
/usr/libexec/PlistBuddy \
  -c "Set :CFBundleIconFile icon.icns" \
  -c "Set :CFBundleIdentifier com.civly.codingplatform" \
  "$APP/Contents/Info.plist"
# codesign only finds an identity through the keychain search list, so the
# signing keychain joins it for the sign and the list goes back after
security unlock-keychain -p "$(<"$SIGN_DIR/password")" "$KEYCHAIN"
KEYCHAINS=("${(@f)$(security list-keychains -d user | sed -E 's/^[[:space:]]*"(.*)"$/\1/')}")
KEYCHAINS=(${KEYCHAINS:#$KEYCHAIN})
trap 'security list-keychains -d user -s "${KEYCHAINS[@]}"' EXIT
security list-keychains -d user -s "${KEYCHAINS[@]}" "$KEYCHAIN"
# Finder/Chrome can leave resource forks on the bundle; codesign refuses them.
# macOS sometimes re-tags a freshly built bundle between the clean and the
# sign, so clean and sign again a few times before giving up.
for attempt in 1 2 3 4 5; do
  xattr -cr "$APP"
  if codesign --force --deep -s "$SIGN_ID" "$APP" 2>/tmp/cph-codesign.err; then break; fi
  if [ "$attempt" = 5 ]; then cat /tmp/cph-codesign.err >&2; exit 1; fi
  sleep 2
done
security list-keychains -d user -s "${KEYCHAINS[@]}"

# keep the launchable copy in /Applications current
rm -rf "/Applications/${APP_NAME}.app"
ditto --norsrc --noextattr "$APP" "/Applications/${APP_NAME}.app"
# Copying from a managed Desktop can add Finder metadata back to nested apps.
# Remove it from the installed copy and verify the actual artifact users launch.
xattr -cr "/Applications/${APP_NAME}.app"
codesign --verify --deep --strict "/Applications/${APP_NAME}.app"

# drop the build copy so Spotlight only finds the /Applications one
rm -rf "$OUT/${APP_NAME}-darwin-arm64"

echo "Installed: /Applications/${APP_NAME}.app"
