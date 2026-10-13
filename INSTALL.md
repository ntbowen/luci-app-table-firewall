# Installing luci-app-table-firewall

Two artifacts, one per OpenWrt release series:

| release | file | installed with |
|---|---|---|
| **24.10.x** | `luci-app-table-firewall_<version>_all.ipk` | `opkg` |
| **25.12.x** | `luci-app-table-firewall-<version>.apk` | `apk` |

The release number is the **git commit count** at build time, so each build
carries a distinct version (`1.0.0-r57`, `1.0.0-r58`, …). opkg and apk can
treat a reinstall of the same version as already-satisfied, which would make a
failed update look exactly like a successful one — and this project has already
hit two caching problems that presented that way.

**One file covers every router of that release.** The package is pure
JavaScript and JSON, built `PKGARCH:=all` — `Architecture: all` in the ipk,
`A:noarch` in the apk. So the same file installs on x86, ath79, mt7621,
ipq806x and anything else; you need one artifact per *release*, not per device.

Build them with `scripts/build-packages.sh`; they land in `dist/`.

## Dependencies

`luci-base`, `luci-app-firewall`, `firewall4` — all present on a stock
OpenWrt image with LuCI, so nothing needs downloading. `luci-app-firewall` is
required, not optional: the General Settings and IP Sets tabs render its views.

Because every dependency is already installed, this works **offline** — no
`opkg update` / `apk update` and no internet on the router.

## Path A — LuCI web UI, no SSH

The most practical route for a router you only reach through its web interface.

1. **System → Software**
2. **Upload Package…**, choose the `.ipk` or `.apk` for that router's release
3. Install when prompted
4. **Log out and back in**

That last step is not optional. rpcd grants ACL groups to a session **at login
time**, so a session that predates the install does not carry
`luci-app-table-firewall` and the menu entry stays hidden — the app appears to
have not installed. Logging out and in fixes it.

Then: **Network → Table Firewall**.

## Path B — command line

`scp` needs an sftp-server, which stock dropbear does not have, so pipe it
instead:

```sh
# 24.10
cat dist/luci-app-table-firewall_*_all.ipk | ssh root@ROUTER 'cat > /tmp/tfw.ipk'
ssh root@ROUTER 'opkg install /tmp/tfw.ipk'

# 25.12
cat dist/luci-app-table-firewall-*.apk | ssh root@ROUTER 'cat > /tmp/tfw.apk'
ssh root@ROUTER 'apk add --allow-untrusted /tmp/tfw.apk'
```

`--allow-untrusted` is needed because the package is not signed by a repository
key. That is expected for a locally built file and is the only thing separating
this from a hosted feed.

### The packages are unsigned

Neither package carries a signature, and no signing key exists yet.

- **25.12 (apk):** apk refuses unsigned packages unless you pass
  `--allow-untrusted`, which is why the command above needs it.
- **24.10 (opkg):** opkg does not verify a signature on a file you install from
  a local path, so nothing is checked and nothing needs to be overridden.

What this means: the integrity of what you install rests entirely on where you
downloaded it from. Get the file from the project's release page, compare its
checksum with the one published there, and only then copy it to the router. If
you cannot verify where a file came from, build it yourself with
`scripts/build-packages.sh`.

From this checkout, `scripts/install-package.sh <host>` does all of the above
and picks the right artifact by asking the box whether it has `apk` or `opkg`.

## Removing it

```sh
opkg remove luci-app-table-firewall     # 24.10
apk del luci-app-table-firewall         # 25.12
```

Nothing in `/etc/config/firewall` is touched — the app only ever edits UCI
through the normal LuCI mechanisms, so removing it leaves your rules exactly as
they are.

## Later: hosting it as a feed

Publishing needs a web server and a signing keypair — `usign` for opkg,
`melange`/apk keys for apk — plus a package index alongside the files. Until
that server exists, the paths above are the supported route. Nothing about the
package changes when it moves to a feed; only how it is fetched.
