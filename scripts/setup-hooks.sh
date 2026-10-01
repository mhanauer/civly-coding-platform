#!/bin/sh
# Installs the pre-push check (scripts/push-guard.mjs) in this clone's own
# hooks folder, outside the working tree. A hook kept in the working tree
# vanishes when a commit without it is checked out, and that push would go
# through unchecked. This one stays, and stops the push when the checkout has
# no guard to run.
set -e
if [ -n "$(git config --get core.hooksPath)" ]; then
  echo "core.hooksPath is set ($(git config --get core.hooksPath)), so git would skip this hook. Unset it and run again." >&2
  exit 1
fi
hooks="$(git rev-parse --git-path hooks)"
mkdir -p "$hooks"
cat > "$hooks/pre-push" <<'HOOK'
#!/bin/sh
# Installed by npm run setup:hooks. Every push publishes: scripts/push-guard.mjs
# stops it on uncommitted changes, personal or secret text, or a failing test.
guard="$(git rev-parse --show-toplevel)/scripts/push-guard.mjs"
if [ ! -f "$guard" ]; then
  echo "Push stopped: this checkout has no scripts/push-guard.mjs to check it." >&2
  exit 1
fi
exec node "$guard" "$@"
HOOK
chmod +x "$hooks/pre-push"
echo "Pre-push check installed: $hooks/pre-push"
