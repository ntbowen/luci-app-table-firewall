#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Gerhard Mautendorfer (MaidByC)
# Push luci-app-table-firewall to the lab router and clear LuCI's caches.
# Usage: scripts/deploy.sh [host]
set -euo pipefail

# LAB_HOST lets a different lab (a different network) set the default once.
HOST="${1:-${LAB_HOST:-192.168.199.222}}"
KEY="${LAB_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/luci-app-table-firewall"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

say "Deploying to $HOST"

# JS/JSON are validated locally first: a syntax error in a view renders as a
# blank page with only a console message, which is painful to debug on-box.
for f in $(find "$APP" -name '*.json'); do
  python3 -m json.tool <"$f" >/dev/null || { echo "invalid JSON: $f" >&2; exit 1; }
done
if command -v node >/dev/null; then
  for f in $(find "$APP" -name '*.js'); do
    node --check "$f" >/dev/null || { echo "invalid JS: $f" >&2; exit 1; }
  done
fi
say "local syntax checks passed"

ssh "${SSH_OPTS[@]}" "root@$HOST" 'mkdir -p /www/luci-static/resources/view /usr/share/luci/menu.d /usr/share/rpcd/acl.d'

# tar over ssh rather than scp: dropbear on a stock OpenWrt image has no
# sftp-server, and scp needs one. This works on a freshly flashed box with
# nothing installed, which is the point.
tar -C "$APP/htdocs/luci-static/resources" -cf - view/table-firewall table-firewall \
  | ssh "${SSH_OPTS[@]}" "root@$HOST" 'tar -C /www/luci-static/resources -xf -'

tar -C "$APP/root/usr/share/luci/menu.d" -cf - . \
  | ssh "${SSH_OPTS[@]}" "root@$HOST" 'tar -C /usr/share/luci/menu.d -xf -'

tar -C "$APP/root/usr/share/rpcd/acl.d" -cf - . \
  | ssh "${SSH_OPTS[@]}" "root@$HOST" 'tar -C /usr/share/rpcd/acl.d -xf -'

# LuCI cache-busts its resource URLs with ?v=<luci version>-<pkgs_update_time>,
# where pkgs_update_time is the *mtime of the package database*
# (runtime.uc: stat('/lib/apk/db/installed') ?? stat('/usr/lib/opkg/status')).
# Editing our files never changes that, so a browser keeps serving cached JS
# until something is installed. Touching the db bumps every ?v= and forces a
# refetch — mtime only, no content change.
say "bumping the LuCI resource version so browsers refetch"

say "clearing LuCI caches and reloading rpcd"
ssh "${SSH_OPTS[@]}" "root@$HOST" '
  rm -f /tmp/luci-indexcache* /tmp/luci-modulecache/* 2>/dev/null
  for db in /lib/apk/db/installed /usr/lib/opkg/status; do
    [ -f "$db" ] && touch "$db"
  done
  /etc/init.d/rpcd reload >/dev/null 2>&1
  sleep 1
  echo "  menu.d: $(ls /usr/share/luci/menu.d/ | grep -c table-firewall) file(s)"
  echo "  acl.d:  $(ls /usr/share/rpcd/acl.d/ | grep -c table-firewall) file(s)"
  echo "  view:   $(ls /www/luci-static/resources/view/table-firewall/ 2>/dev/null | tr "\n" " ")"
'
say "done — http://$HOST/cgi-bin/luci/admin/network/table_firewall"
