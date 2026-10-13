# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately:

- use GitHub private vulnerability reporting (the **Security** tab of this
  repository, "Report a vulnerability"), or
- email **dev@maidbyc.com**.

Please do not open public issues for vulnerabilities. Include the OpenWrt
release, the package version, and steps to reproduce.

## Scope

`luci-app-table-firewall` has no backend and stores no secrets. It only reads
and writes the stock UCI firewall configuration through LuCI's ubus/rpcd, under
the same ACL as `luci-app-firewall`. Every change goes through LuCI's
**Save & Apply** with its rollback safety net.

## Packages are unsigned

The released `.ipk` / `.apk` files are not signed. Verify where you got them,
compare the checksum published with the release, or build the package yourself
(`scripts/build-packages.sh`). See [`INSTALL.md`](INSTALL.md).

## Supported releases

OpenWrt 24.10 and 25.12, and the latest package version only.
