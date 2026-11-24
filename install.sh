#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Links this folder into Rex's config folder as "tabjump", so that
# require("tabjump") in init.lua finds it. Run it again after moving the
# folder. ./install.sh --uninstall takes the link away.

here="$(cd "$(dirname "$0")" && pwd -P)"
config_file="${REX_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/rex/init.lua}"
config="$(dirname "$config_file")"
link="$config/tabjump"
line='require("tabjump").setup{}'

fail() { echo "tabjump: $*" >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  if [ -L "$link" ]; then
    \rm "$link"
    echo "Removed $link. Take the $line line out of $config_file, then run: rex config reload"
  else
    echo "Nothing to remove: $link isn't a link."
  fi
  exit 0
fi

command -v rex >/dev/null 2>&1 || fail "needs Rex and its rex command: https://www.superlogical.com/rex/docs/installation"

# The panels are TypeScript that node runs as it is, which needs 22.18.
node_bin=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node" /usr/bin/node "$(command -v node || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    node_bin="$candidate"
    break
  fi
done
[ -n "$node_bin" ] || fail "needs Node.js 22.18 or later, and found no node."
"$node_bin" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' ||
  fail "needs Node.js 22.18 or later. $node_bin is $("$node_bin" --version). Upgrade it, or name a newer one with the node option."

mkdir -p "$config"
if [ -L "$link" ]; then
  \rm "$link"
elif [ -e "$link" ]; then
  fail "$link is already there and isn't a link. Move it away, then run ./install.sh again."
fi
ln -s "$here" "$link"
echo "Linked $link to $here (node: $node_bin)."

if [ -f "$config_file" ] && grep -Fq 'require("tabjump")' "$config_file"; then
  rex config reload >/dev/null 2>&1 || true
  echo "$config_file already loads tabjump. Press Cmd+O in Rex."
else
  echo "Add this line to $config_file, then run: rex config reload"
  echo
  echo "  $line"
fi
