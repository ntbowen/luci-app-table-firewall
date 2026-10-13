#
# Copyright (C) 2026 Gerhard Mautendorfer (MaidByC)
# SPDX-License-Identifier: Apache-2.0
#
# This is free software, licensed under the Apache License, Version 2.0
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=Table-driven firewall rules UI
LUCI_DESCRIPTION:=A grouped, table-driven view of the OpenWrt firewall. \
Traffic rules, port forwards and NAT rules on one page, grouped by zone pair \
in real evaluation order, with search that highlights rather than hides, \
drag-to-reorder, and a footer on every group naming the real chain terminator. \
Reads and writes stock UCI over ubus; it adds no backend of its own.

# luci-app-firewall is a hard dependency: the General Settings and IP Sets tabs
# point straight at its views, and firewall4 provides the ruleset this reads.
LUCI_DEPENDS:=+luci-base +luci-app-firewall +firewall4
LUCI_PKGARCH:=all

# luci.mk reads LUCI_MAINTAINER / LUCI_URL, not the PKG_ equivalents, and
# defaults them to "OpenWrt LuCI community" and the upstream repo — so setting
# PKG_MAINTAINER here would be silently ignored and the package would claim an
# authorship it does not have.
LUCI_MAINTAINER:=MaidByC <dev@maidbyc.com>
LUCI_URL:=https://github.com/MaidByC/luci-app-table-firewall

PKG_NAME:=luci-app-table-firewall
PKG_VERSION:=1.0.0

# Stamped by scripts/build-packages.sh from the git commit count, so every
# build carries a distinct version. That matters because opkg and apk can treat
# a reinstall of the same version as already-satisfied, which makes a failed
# update indistinguishable from a successful one. The literal below is only the
# fallback for building this tree by hand.
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0

include ../../luci.mk

# call BuildPackage - OpenWrt buildroot signature
