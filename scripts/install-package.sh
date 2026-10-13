#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Gerhard Mautendorfer (MaidByC)
# Install a built package onto a lab box and verify it landed.
#
# Usage: scripts/install-package.sh <host> [package-file]
#
# Picks the right artifact for the box automatically: 24.10 takes the .ipk via
# opkg, 25.12 the .apk via apk. Installing the real package is the only way to
# know the Makefile actually produces something usable — deploy.sh copies files
# into place and proves nothing about packaging.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${1:?usage: install-package.sh <host> [package-file]}"
KEY="${LAB_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

mgr=$(ssh "${SSH_OPTS[@]}" "root@$HOST" 'command -v apk >/dev/null && echo apk || echo opkg')
say "$HOST uses $mgr"

pkg="${2:-}"
if [ -z "$pkg" ]; then
  ext=$([ "$mgr" = apk ] && echo apk || echo ipk)
  pkg=$(ls -t "$ROOT"/dist/luci-app-table-firewall*."$ext" 2>/dev/null | head -1 || true)
  [ -n "$pkg" ] || { echo "no .$ext in dist/ — run scripts/build-packages.sh first" >&2; exit 1; }
fi

say "installing $(basename "$pkg")"
cat "$pkg" | ssh "${SSH_OPTS[@]}" "root@$HOST" "cat > /tmp/$(basename "$pkg")"

if [ "$mgr" = apk ]; then
  ssh "${SSH_OPTS[@]}" "root@$HOST" "apk add --allow-untrusted /tmp/$(basename "$pkg")"
else
  ssh "${SSH_OPTS[@]}" "root@$HOST" "opkg install --force-reinstall /tmp/$(basename "$pkg")"
fi

say "verifying"
ssh "${SSH_OPTS[@]}" "root@$HOST" '
  rm -f /tmp/luci-indexcache* /tmp/luci-modulecache/* 2>/dev/null
  for db in /lib/apk/db/installed /usr/lib/opkg/status; do [ -f "$db" ] && touch "$db"; done
  /etc/init.d/rpcd reload >/dev/null 2>&1
  echo "  menu:  $(ls /usr/share/luci/menu.d/ | grep -c table-firewall) file(s)"
  echo "  acl:   $(ls /usr/share/rpcd/acl.d/ | grep -c table-firewall) file(s)"
  echo "  views: $(ls /www/luci-static/resources/view/table-firewall/ 2>/dev/null | tr "\n" " ")"
  echo "  libs:  $(ls /www/luci-static/resources/table-firewall/ 2>/dev/null | tr "\n" " ")"
'
say "done — http://$HOST/cgi-bin/luci/admin/network/table_firewall"
