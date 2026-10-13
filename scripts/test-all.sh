#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Gerhard Mautendorfer (MaidByC)
# Run both suites against every captured fixture set.
#
# The point of running the model tests against more than one release is that
# each fixture set carries that box's *own* compiled nftables ruleset, so the
# chain logic is checked against what that version of fw4 actually produced.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rc=0

for extra in test-css; do
  out=$(node "$ROOT/scripts/$extra.js" 2>&1)
  line=$(printf '%s' "$out" | tail -1)
  if printf '%s' "$line" | grep -q '^OK'; then
    printf '  %-18s %-11s %s\n' "static" "$extra" "$line"
  else
    printf '  %-18s %-11s FAILED\n%s\n' "static" "$extra" "$out"
    rc=1
  fi
done

for dir in "$ROOT"/test/fixtures*; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  for suite in test-model test-view; do
    out=$(node "$ROOT/scripts/$suite.js" "$dir" 2>&1)
    line=$(printf '%s' "$out" | tail -1)
    if printf '%s' "$line" | grep -q '^OK'; then
      printf '  %-18s %-11s %s\n' "$name" "$suite" "$line"
    else
      printf '  %-18s %-11s FAILED\n%s\n' "$name" "$suite" "$out"
      rc=1
    fi
  done
done

# If a package has been built, run the suites against the *shipped* resources
# too: luci.mk minifies the JavaScript, so what installs on a router is not the
# file we wrote.
PKG=$(ls -t "$ROOT"/dist/luci-app-table-firewall_*_all.ipk 2>/dev/null | head -1 || true)
if [ -n "$PKG" ]; then
  tmp=$(mktemp -d)
  ( cd "$tmp" && tar xzf "$PKG" 2>/dev/null && tar xzf data.tar.gz 2>/dev/null ) || true
  if [ -d "$tmp/www/luci-static/resources" ]; then
    for suite in test-model test-view; do
      out=$(TF_SRC="$tmp/www/luci-static/resources" node "$ROOT/scripts/$suite.js" 2>&1)
      line=$(printf '%s' "$out" | tail -1)
      if printf '%s' "$line" | grep -q '^OK'; then
        printf '  %-18s %-11s %s\n' "packaged" "$suite" "$line"
      else
        printf '  %-18s %-11s FAILED\n%s\n' "packaged" "$suite" "$out"
        rc=1
      fi
    done
  fi
  rm -rf "$tmp"
fi

[ $rc -eq 0 ] && echo "all suites passed" || echo "FAILURES"
exit $rc
