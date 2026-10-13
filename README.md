# luci-app-table-firewall

A replacement for LuCI's firewall **rules** display: traffic rules, port
forwards and NAT rules on one page, grouped by zone pair in real evaluation
order. Stock `Network → Firewall` is left untouched; this lives beside it at
**Network → Table Firewall**.

Reads and writes stock UCI over ubus. No backend of its own — nothing calls
`fw4`, `nft`, or edits `/etc/config` directly, so every change rides LuCI's
normal Save & Apply with rollback.

| | |
|---|---|
| Design, and why | [`DESIGN.md`](DESIGN.md) |
| Installing | [`INSTALL.md`](INSTALL.md) |
| Optional ideas | [`ROADMAP.md`](ROADMAP.md) |
| Contributing | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Security | [`SECURITY.md`](SECURITY.md) |
| License | [`LICENSE`](LICENSE) (Apache-2.0) |

Targets OpenWrt **24.10** (`.ipk`) and **25.12** (`.apk`); both are built and
tested from the same source, and the package is architecture-independent, so
one file covers every router of a release series.

Install: see [`INSTALL.md`](INSTALL.md).

```sh
scripts/test-all.sh            # all suites, both releases, and the built package
scripts/build-packages.sh      # -> dist/
scripts/deploy.sh <host>       # push source to a box for iteration
```

## License

Apache License 2.0; see [`LICENSE`](LICENSE).
