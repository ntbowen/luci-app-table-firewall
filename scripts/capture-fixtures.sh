#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Gerhard Mautendorfer (MaidByC)
# Refresh a fixture directory from a lab box, including the compiled ruleset
# that the model test uses as ground truth.
#
# Usage: capture-fixtures.sh [host] [dest-dir]
set -euo pipefail
# LAB_HOST lets a different lab (a different network) set the default once.
HOST="${1:-${LAB_HOST:-192.168.199.222}}"
KEY="${LAB_KEY:-$HOME/.ssh/id_ed25519}"
OW=(ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "root@$HOST")
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${2:-$ROOT/test/fixtures}"
mkdir -p "$DEST"

for c in firewall network dhcp; do
  "${OW[@]}" "ubus call uci get '{\"config\":\"$c\"}'" > "$DEST/uci-$c.json"
done
"${OW[@]}" 'ubus call luci-rpc getHostHints'   > "$DEST/hosthints.json"
"${OW[@]}" 'ubus call network.interface dump'  > "$DEST/ifdump.json"
"${OW[@]}" 'cat /etc/services'                 > "$DEST/services.txt"
"${OW[@]}" 'nft -a list ruleset'               > "$DEST/nft.txt"
echo "fixtures refreshed from $HOST into $DEST"
