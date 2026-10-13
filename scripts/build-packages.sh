#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Gerhard Mautendorfer (MaidByC)
# Build luci-app-table-firewall for both target releases.
#
# 24.10 packages as .ipk (opkg), 25.12 as .apk — the SDK for each release
# emits the right format, which is why this builds against both rather than
# converting one into the other.
#
# Usage: scripts/build-packages.sh [release ...]     default: both
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDKDIR="$ROOT/sdk"
DIST="$ROOT/dist"
RELEASES=("${@:-24.10.8 25.12.5}")
read -r -a RELEASES <<< "${RELEASES[*]}"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

mkdir -p "$SDKDIR" "$DIST"

for rel in "${RELEASES[@]}"; do
  base="https://downloads.openwrt.org/releases/$rel/targets/x86/64"
  tarball=$(curl -s "$base/" | grep -oE 'openwrt-sdk-[^"<]*\.tar\.zst' | head -1)
  [ -n "$tarball" ] || { echo "no SDK listed for $rel" >&2; exit 1; }

  say "$rel: $tarball"
  [ -f "$SDKDIR/$tarball" ] || curl -# -o "$SDKDIR/$tarball" "$base/$tarball"

  dir="$SDKDIR/${tarball%.tar.zst}"
  if [ ! -d "$dir" ]; then
    say "extracting"
    tar -C "$SDKDIR" -xf "$SDKDIR/$tarball"
  fi

  cd "$dir"

  # The luci feed supplies luci.mk and the luci-base / luci-app-firewall
  # definitions this package depends on.
  # base *and* luci are both needed. The SDK ships feeds/base as a symlink to
  # its own package/ directory, which contains no sources — so libnl-tiny, lua
  # and ucode are absent, and luci-base's own dependencies (rpcd-mod-luci,
  # lucihttp) fail to build against missing headers. Fetching base replaces
  # that symlink with the real tree. packages/routing/telephony are not needed.
  if [ ! -d feeds/luci ] || [ -L feeds/base ]; then
    say "fetching the base and luci feeds (a few minutes)"
    ./scripts/feeds update base luci >/dev/null 2>&1
  fi

  # Build from inside the feed, which is where luci.mk expects to be included
  # from (`include ../../luci.mk`).
  rm -rf "feeds/luci/applications/luci-app-table-firewall"
  cp -r "$ROOT/luci-app-table-firewall" "feeds/luci/applications/"

  # Stamp the release from the commit count so each build is distinguishable.
  # Only the copy inside the SDK is rewritten: passing PKG_RELEASE on the make
  # command line would override it for every package in the build, not ours.
  rel=$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)
  if ! git -C "$ROOT" diff --quiet 2>/dev/null || \
     ! git -C "$ROOT" diff --cached --quiet 2>/dev/null; then
    say "working tree is dirty — the stamped release will not identify a commit"
  fi
  sed -i "s/^PKG_RELEASE:=.*/PKG_RELEASE:=$rel/" \
    "feeds/luci/applications/luci-app-table-firewall/Makefile"
  say "version $(grep -oP '(?<=^PKG_VERSION:=).*' "$ROOT/luci-app-table-firewall/Makefile")-r$rel"

  # The feed index is built when the feed is fetched, so a package dropped in
  # afterwards is invisible to `feeds install` until the index is rebuilt.
  # -i reindexes without re-fetching.
  ./scripts/feeds update -i >/dev/null 2>&1
  ./scripts/feeds install -a >/dev/null 2>&1
  ./scripts/feeds install -p luci luci-app-table-firewall >/dev/null

  [ -e "package/feeds/luci/luci-app-table-firewall" ] || {
    echo "feeds install did not link the package into package/feeds/luci" >&2
    exit 1
  }

  say "building"
  make defconfig >/dev/null
  make package/luci-app-table-firewall/compile -j"$(nproc)" V=s > "$DIST/build-$rel.log" 2>&1 || {
    echo "build failed — tail of $DIST/build-$rel.log:" >&2
    tail -30 "$DIST/build-$rel.log" >&2
    exit 1
  }

  found=$(find bin -name 'luci-app-table-firewall*' \( -name '*.ipk' -o -name '*.apk' \) | head -5)
  [ -n "$found" ] || { echo "built, but no package found under bin/" >&2; exit 1; }

  for f in $found; do
    cp "$f" "$DIST/"
    say "-> dist/$(basename "$f")"
  done

  cd "$ROOT"
done

say "done"
ls -lh "$DIST" | tail -n +2
