#!/bin/zsh
# npm installs a bare Electron.app under node_modules, and Spotlight lists it
# as an app called "Electron". Spotlight skips folders ending in .noindex, so
# the bundle moves there and dist becomes a link to it. Runs after npm install.
set -e
cd "$(dirname "$0")/../node_modules/electron"
if [ -d dist ] && [ ! -L dist ]; then
  mv dist dist.noindex
  ln -s dist.noindex dist
fi
