# Contributing

Bug reports and pull requests are welcome. Read [`DESIGN.md`](DESIGN.md) first:
the reasoning behind the behaviour is the valuable part, and several things
that look like missing features are deliberate.

## Running the tests

```sh
scripts/test-all.sh
```

Needs only `node`; everything is offline. All runs must be green before you
open a PR. The two "packaged" runs execute only if a built package exists in
`dist/`; create one with `scripts/build-packages.sh` and run `test-all.sh`
again before changes that touch packaging or minification-sensitive code.

### The suites

- **`test-model.js`** checks the model against captured fixtures. Its key
  assertion compares the chain the model computes with the chain nftables
  actually used, read back from the box's compiled ruleset through fw4's
  `!fw4: <name>` comments. That is ground truth, not a restatement of our logic.
- **`test-view.js`** executes the view against a DOM shim.
- **`test-css.js`** checks contrast invariants in the stylesheet.
- **Packaged run**: both suites again against the resources extracted from the
  built package, because `luci.mk` minifies the JavaScript and the shipped file
  is not the file in the tree.

### The shim lied four times

The DOM/LuCI shim in `test-view.js` was wrong whenever it modelled what an API
was assumed to do rather than what it does:

| shim was wrong about | consequence |
|---|---|
| `uci.move()` returning a boolean | valid moves silently reported as failures |
| `appendChild` setting `parentNode` | a fresh element stacked on every render |
| `L.require()` returning a class | a green test on code that threw in the browser |
| `querySelector` searching `<head>` | duplicate guard looked broken when it was fine |

The third is the dangerous one: it passed while the feature was broken. When a
test disagrees with the browser, suspect the shim first. Fix the shim, not the
code, and read the real LuCI implementation (clone it to `ref/luci`, see
`.gitignore`) rather than guessing.

## Fixtures

There are two sets, `test/fixtures` (24.10) and `test/fixtures-2512` (25.12),
each carrying its own box's compiled ruleset. Refresh one from a test box with
`scripts/capture-fixtures.sh <host> <dir>`. `scripts/seed-fw.sh` (run on the
test box) builds the test ruleset idempotently. Use addresses and names that
point nowhere: placeholder hosts end in `.local`, never a real public domain.

## Iterating on a router

```sh
LAB_HOST=<router> LAB_KEY=~/.ssh/<key> scripts/deploy.sh
```

This pushes the source over ssh (tar, no sftp needed). Then look at the page in
a browser, in **both the light and the dark theme**; no test checks that it
looks right, and white-on-white bugs have shipped because only one theme was
checked.

## Traps

- **ACL groups are granted at login.** After changing `acl.d/*.json` or
  installing the package, log out of LuCI and back in, or the menu entry stays
  hidden and it looks like a failed install.
- **LuCI cache-busts with the package database mtime** (`/lib/apk/db/installed`
  or `/usr/lib/opkg/status`), so editing files changes no URL and browsers
  serve stale JavaScript. `deploy.sh` touches that database for this reason.
  The stylesheet also carries `?v=` explicitly.
- **No `scp` on stock OpenWrt**: dropbear ships no sftp-server. Use
  `cat file | ssh host 'cat > /tmp/x'`, as the scripts do.

## Deliberate behaviour

These are intentional. A PR that "fixes" them will not be merged without
discussing [`DESIGN.md`](DESIGN.md) first.

- **Search never hides rows.** A rule's meaning depends on what precedes it in
  its chain; filtering could show a rule as live while an earlier catch-all
  pre-empts it. Search only highlights.
- **A hidden column never hides a rule's specificity**: a rule with values in
  hidden columns carries a `+N` marker.
- **Wildcard (`dest='*'`) rules render as shadow copies** at their true
  position in every group they can affect, because position is the hazard.
- **Every group states its real chain terminator**, which is not always what
  the config implies (a zone pair with no `config forwarding` rejects via
  `handle_reject` instead of taking the chain's nominal drop policy).

## Code guidelines

- Do not subclass a stock LuCI view. `L.require()` returns `new _class()` and a
  view's `__init__` is its lifecycle, so requiring one runs it. The General
  Settings and IP Sets tabs point straight at `luci-app-firewall`'s views.
- Keep `model.js` separate from the view and chain-aware, so other features
  (see [`ROADMAP.md`](ROADMAP.md)) can reuse it.
- No backend: nothing may call `fw4` or `nft`, or edit `/etc/config/*`
  directly. Everything goes through UCI over ubus.

## Where the code is

```
luci-app-table-firewall/
  Makefile                                   luci.mk layout; LUCI_MAINTAINER, not PKG_
  htdocs/luci-static/resources/
    table-firewall/model.js                  UCI -> normalized, chain-aware model
    table-firewall/search.js                 tokeniser + matching (highlight only)
    table-firewall/editor.js                 stock form.Map in a modal, all 3 section types
    table-firewall/table-firewall.css        scoped to [data-page^="admin-network-table_firewall"]
    view/table-firewall/rules.js             the page
  root/usr/share/luci/menu.d/…json           3 tabs; zones/ipsets point at stock views
  root/usr/share/rpcd/acl.d/…json            uci firewall rw; dhcp/network ro; a few ubus methods
scripts/                                     tests, build, deploy, fixture capture
test/                                        fixture sets
```
