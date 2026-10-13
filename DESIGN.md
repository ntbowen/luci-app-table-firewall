# Table Firewall — design

A second, table-driven firewall UI. **Stock `Network → Firewall` is left
untouched**; this lives beside it at `Network → Table Firewall`, so we can
always fall back and compare.

POC scope: the **Traffic Rules** tab only.

## Menu

`admin/network/table_firewall` → tab `rules` ("Traffic Rules"), which itself
carries the IPv4 / IPv6 sub-tabs.
Later tabs (`forwards`, `walk`) slot in as siblings.

## The grouping model — and one correction

Grouping is by **(source zone → destination zone)**, one table per pair, sorted
so all rules sharing a source zone sit together. `DMZ → device` (input) is its
own table, as is `lan → device`.

I checked this against the compiled ruleset rather than assuming it, and the
result **corrects an assumption from the original planning chat** ("each group
is one chain, groups don't interact"). What fw4 actually does:

- Every rule with `src=lan` lands in **one** chain, `forward_lan`, in **global
  UCI order** — regardless of destination zone.
- The destination zone is **not** matched in the rule. It's matched inside the
  jump target: `accept_to_DMZ` is `oifname "br-dmz" ... accept`.

So a group is *not* a chain. The grouped view is still honest, but for a
different reason than assumed: a jump into a non-matching destination chain
**falls through and returns**, and a packet has exactly one egress interface, so
two rules with different destination zones can never match the same packet.

**Therefore:**
1. Grouping by zone pair is safe. ✅
2. Reordering *within* a group is the only reordering that changes behaviour. ✅
3. Rules may be moved across non-group members when writing back the global
   order, and that is harmless — with one exception, below.

### The exception: `dest='*'` rules — shadow copies

A rule with `dest='*'` jumps to a target with **no** `oifname` restriction, so it
matches traffic to *any* destination zone. Stock OpenWrt ships one:
`Allow-ICMPv6-Forward` (`src=wan dest=*`).

Everywhere a wildcard surfaces — the `✳` shadow badge, the `any zone` chip, the
move confirmation, and the zone dropdown in the editor — the UI says plainly
that **using `any zone` is not recommended**, and why: such a rule is evaluated
against traffic in every zone pair it spans and can pre-empt rules further down
that look unrelated to it. Naming the zone keeps the evaluation order readable.
The option is still offered, because fw4 supports it and existing configs use
it; it is just never presented as a neutral choice.

This is dangerous precisely because of **position**: a wildcard DROP at global
position 20 will kill traffic that a `lan → DMZ` ACCEPT at position 25 was meant
to allow. Pinning wildcards to the top of a group would therefore misrepresent
them just as badly as hiding them.

**Decision: shadow copies.** A wildcard rule is rendered inside every group it
can actually affect, **at its true position in that group's sequence** — so
you can see it sitting between rule 3 and rule 4 and understand what it
pre-empts. All copies are views of one UCI section:

- Editing any copy edits the single underlying rule; all copies update.
- Deleting or toggling any copy affects the one real rule.
- **Dragging a shadow copy is a global move** and changes its position in every
  group at once. That must be surfaced in the UI before it is committed, not
  discovered afterwards.
- Copies are visually marked as shadows so they are never mistaken for a rule
  local to that pair.

"Every group it can affect" is decided by the chain, not by the source zone
alone. `*` means *any zone*, and a zone is not the device: a rule with
`dest='*'` is a forward rule (fw4 puts it in `forward_<src>`), so it can never
affect traffic to the router and must not appear in an input group. Symmetric
for `src='*'`, which spans every real source zone but not the device's own
output. Getting this wrong shows a rule where it cannot fire.

Any rule that matches no group at all is rendered in a flagged "Not shown in
any zone pair" section rather than dropped. A rule silently missing from the
page is the worst failure this view can have.

Note the useful interaction with the IPv4/IPv6 split below: the stock wildcard
rule is `family='ipv6'`, so it does not appear in the IPv4 tab at all. For a
typical config the shadow machinery only has to be right on the IPv6 tab.

## Ordering: one global list, grouped projection

- Source of truth: the **global ordered list of rule SIDs**, mirroring UCI.
- The grouped tables are a projection of it.
- Drag within a group resolves the drop to its neighbour SID in the global list
  and calls `uci.move(config, sid, refSid, after)`.
- `uci.move()` renumbers local state immediately, so the new order shows in the
  table at once, and flags a `uci reorder` change that rides the normal Save &
  Apply with rollback. Nothing writes config directly — critical here, since a
  bad rule can cut our own session.
- Dragging **between groups** is not a reorder: it would mean changing the
  rule's zones, which is an edit. Refused. Likewise dragging between the filter
  and mangle buckets, which are not ordered against each other at all.
- Dragging a **wildcard shadow copy** moves the one underlying rule, so its
  position changes in every group it appears in. Confirmed before it happens
  rather than discovered afterwards.

## IPv4 / IPv6 selection

Traffic Rules carries two **independent toggles**, IPv4 and IPv6, both on by
default. A rule is shown when it applies to any selected family, so a
dual-stack rule appears once with both on.

The `family` option is only part of the answer — of the 61 rules in the lab, 54
leave it unset. The tab assignment uses the **effective** family:

1. explicit `option family` (`ipv4` / `ipv6`) wins;
2. otherwise infer from the rule's own content — an IPv4 literal in `src_ip` /
   `dest_ip`, or `icmpv6` / IPv6-only `icmp_type` values, pin the family;
3. otherwise the rule is genuinely dual-stack and appears in **both** tabs.

Inferred assignments must be marked differently from declared ones — the user
should be able to tell "OpenWrt decided this is v4-only" from "I set this".

## Sticky header: search + Save & Apply

A header bar pinned to the top of the view (`position: sticky`), so it stays put
while scrolling long rule tables. It carries the search box on the left and the
change/apply block on the right:

```
+--------------------------------------------------------------------------+
| (search) host, ip, port, zone, name...   ! 3 unsaved changes             |
|                                            [ Revert ] [ Save & Apply ]   |
+--------------------------------------------------------------------------+
```

**When there are staged changes the whole bar turns red.** This exists because
a DNS record was lost during design simply by filling a form and never pressing
Save & Apply — the UI should make pending state impossible to walk away from.

Wiring, against the real API rather than a reimplementation:

- **Apply** calls `ui.changes.apply(true)` — the *checked* apply. Changes must be
  confirmed within `L.env.apply_rollback` seconds or the device rolls them back.
  For a firewall editor this is the only acceptable default: a bad rule can cut
  the session that would confirm it. `apply(false)` is deliberately not offered.
  LuCI's `checkConnectivityAffected()` warning comes along for free.
- **Revert** calls `ui.changes.revert()`.
- **The count** is a button opening `ui.changes.displayChanges()`, LuCI's own
  changelog modal. Reorders show up there as `uci reorder` entries, so a drag is
  as visible and as revertable as any field edit.
- **Staying in sync**: `ui.changes` is a singleton whose count updates funnel
  through `setIndicator()`. The view wraps that one method to also paint the
  header, so the bar tracks changes made anywhere — including apply and revert —
  and restores the original on teardown. No polling.

### Rows with staged changes

A rule that has been edited, toggled, added, duplicated or moved is tinted and
carries a `✎` badge until the change is applied or reverted, so the red toolbar
says *that* something is pending and the rows say *what*.

The changeset alone cannot answer this. A single drag makes `uci.js` reorder
the whole config, and the server records one `order` record **per section** —
measured on the lab box, reordering six rules produced six order records. Using
those would highlight every rule on the page and convey nothing. So `order`
records are ignored and moved rules are tracked locally as they move, while
`set` / `add` / `remove` come from the changeset, which means an edit made on
another LuCI page still shows up here.

The tint is teal: amber is already the search hit and the wildcard shadow, blue
the drop indicator and IPv4, purple IPv6 and the mangle block, red delete and
the dirty toolbar. The badge carries the meaning so colour is never the only
signal.

Red must not be the only signal: the bar pairs colour with an icon and the
literal count, and has to stay legible in both the light and dark LuCI themes.

## Table

### Columns

fw4 accepts **37 options** on a rule, so no table can show everything. In the
lab's 61 rules only 12 appear at all, and six of them (`name`, `src`, `target`,
`proto`, `dest_port`, `dest`) cover nearly every rule — so a compact default
with the rest opt-in is the right shape. Related options collapse into one
column: the seven time options become a single **Time** column.

**Shown by default**

| ⠿ | # | On | IPv | Name | Source zone | Source IP | Destination zone | Dest IP | Protocol | Service (Dest port) | Action | ⋯ |

Columns are named as the add/edit dialog names the same fields, so nobody has
to work out that the table's "Service" and the editor's "Destination port" are
one thing.

- **⠿** drag handle · **#** position · **On** enabled toggle
- **IPv** — two fixed slots, IPv4 always left and IPv6 always right. A
  dual-stack rule fills both; a rule pinned to one family leaves the other slot
  empty but still occupied, so the family reads from position alone while
  scanning. This matters because dual-stack rules appear in *both* family tabs,
  and the column says which kind you are looking at.
- **Source** / **Destination** — zone badges, rendered with luci-base's own
  `getZoneColorStyle` and the `zonebadge` class so a zone looks identical here
  and on every stock page.
- **Source IP** / **Dest IP** — their own columns, not folded into the zone.
  These are the two fields most able to make two rules look identical while
  matching completely different traffic, so they are visible by default and
  are the last columns anyone should hide.
- **Protocol** — its own column, not folded into Service. Folded in, it was
  repeated once per port (`tcp/465 tcp/587`), and a port-less protocol such as
  `esp` appeared under a heading reading "Dest port", which is simply wrong.
- **Service (Dest port)** — ports, resolved to names (`443 (https)`). ICMP
  types live here too: they occupy the same slot a port does.
- **Action** — ✅ ACCEPT · 🚫 REJECT · ⛔ DROP · 🏷 MARK · 👻 NOTRACK
- **⋯** edit / duplicate / delete

There is deliberately **no hit counter** in the POC. nftables does carry
per-rule counters, but no stock ubus method exposes them; see ROADMAP.md for
what adding one would take and why it was deferred.

**Available, off by default**

Source port · Time (`weekdays`, `monthdays`, `start_date`,
`stop_date`, `start_time`, `stop_time`, `utc_time`) · Limit (`limit`,
`limit_burst`) · Log · Mark (`mark`, `set_mark`, `set_xmark`) · DSCP · Helper ·
IPSet · Device/direction · Extra (raw) · Chain (`forward_lan`) · Section ID

Chain and Section ID are for debugging and for confirming the grouping is
telling the truth.

### Hiding a column must never hide a match condition

The same reasoning that rules out filtering rows applies, more subtly, to
columns. If `src_ip` is hidden, two rules can render **identically** while
matching completely different traffic — and then someone reorders or deletes
the wrong one. A rule that looks simpler than it is, is a lie.

So: **any rule carrying a value in a hidden column shows a marker** in its row
(a small badge naming how many hidden criteria it has). Hovering lists them;
clicking turns those columns on. Hiding a column may reduce *detail*, never
reduce the apparent *specificity* of a rule.

The column picker is a **button in the sticky header**, beside search, so it
is reachable while scrolling and there is exactly one of it.

### The resize strip

Along the bottom edge of the sticky toolbar runs one continuous rule with a dot
at every column split and the column name immediately after it, the rule
running on to the next dot — `·Name————·Source————·`. The label is left-aligned
and padded to match the theme's table cells, so it sits directly above the
column's own content. Dragging a dot
resizes the column to its left, across **every** group table at once — which is
only coherent because all tables already share one column layout.

It sits in the toolbar rather than on a table header for a practical reason:
there are ~20 tables, so header-mounted handles would mean 20 sets of them, all
of which scroll out of view. One always-visible set controls them all, and the
names in the strip double as a column legend once the per-table headers have
scrolled away.

The strip and the tables are driven by the **same** `--tf-w-<key>` custom
properties, so they cannot drift out of alignment; the strip measures the real
rendered table to place its dots, rather than recomputing the geometry.

Below 1100px the tables take a min-width and scroll inside their own
containers, so a dot would no longer sit above the column it claims to control.
The strip is hidden there — absent is better than lying.

Not drag-only: handles are focusable and resize with arrow keys (Shift for
bigger steps, Home to reset), double-click resets one column, and the Columns
dialog has a Reset widths button. Widths persist per browser in `localStorage`
beside the visibility preference. Column choice
persists per browser in `localStorage`; it is a display preference, never
written to the device.


- **Source / Destination**: zone badge, plus `src_ip` / `dest_ip` resolved to a
  host name where one is known.
- **Service**: protocol + ports, shown as `tcp/22 (ssh)`.
- **Action**: ✅ ACCEPT · 🚫 REJECT · ⛔ DROP · 🏷 MARK · 👻 NOTRACK.
- **Disabled rules**: dimmed, dashed left border, name struck through — clearly
  distinct but still readable, still ordered in place.

### Every table shows all zone pairs, and where the chain ends

All possible pairs are rendered; pairs with no rules collapse to a one-line
header, so an empty `DMZ → MGMT_DMZ` is visibly empty rather than absent.

Every table ends with a **non-draggable footer row showing the real chain
terminator**, so you can always see what happens to a packet that matches
nothing. Verified against the compiled ruleset:

- **`src → device` (input)** — ends at the source zone's `input` policy
  (`input_lan` ends `jump accept_from_lan`; `input_DMZ` ends `jump drop_from_DMZ`).
- **`src → dest` (forward)** — if a `config forwarding src→dest` exists, the
  chain ends by accepting via that forwarding (`jump accept_to_DMZ`). If it does
  not, the packet falls out of the zone chain, returns to the parent `forward`
  chain and hits `jump handle_reject` → **REJECT with TCP reset**, *not* the
  chain's nominal `policy drop`. The footer must say which of these applies.
- **`src → src` (intra-zone)** — the zone's own `forward` policy.
- Where port forwards target the zone, `forward_X` also carries
  `ct status dnat accept` **before** the policy — DNAT'd traffic is accepted
  regardless of the rules above. That deserves its own footer line; it is a
  common surprise.

## Search with autocomplete

One token-based search box. Suggestion sources, all verified present on-box:

- **Hosts / IPs** — two sources, and **both are required**. Measured on the lab
  box, `luci-rpc.getHostHints` returned 20 entries, 9 carrying a name — but
  every static-lease host came back with an **empty `ipaddrs` array**, because
  hints are keyed by MAC and the addresses come from leases and the neighbour
  table. A configured host that has never appeared on the wire has a name and no
  address. `config domain` records are absent from hints entirely.

  So: `getHostHints` for what is actually live (granted by the existing
  `luci-base-network-status` ACL), **plus a direct read of `/etc/config/dhcp`**
  for `config host` static leases, `config domain` static DNS records (LuCI
  labels these "Hostnames") and `config cname`. Plus `/etc/hosts` and interface
  subnets. Typing `web` suggests `web01 (10.10.10.10)`.

  This is why the ACL needs read on `dhcp` — without it, host autocomplete is
  names with no addresses.

  Note both hostnames and IP literals are dotted, so the tokenizer must
  distinguish `www.tinypixelmapper.com` from `192.168.199.36` rather than
  splitting on `.`.
- **Ports / services** — `/etc/services` on the box (172 entries, includes
  `ssh 22/tcp`), merged with a built-in table for common ports it omits.
  Typing `ssh` → `22/tcp`; typing `22` → `ssh`.
- **Zones**, **actions** (`accept`/`drop`/`reject`), and free text over names.

**IP search must be subnet-aware, not string matching.** Searching
`10.10.10.10` has to match a rule whose `dest_ip` is `10.10.10.0/24`. That
containment check is what makes the search useful to an admin rather than a
glorified grep, and it needs real CIDR math.

**But containment applies to a rule's address fields only — never to zone
membership.** Matching "this address lives inside that zone's subnet" sounds
helpful and is actively misleading: measured on the lab config, searching one
DMZ host matched 18 rules of which only 2 named the address, because every rule
merely referencing the DMZ zone lit up — including rules with no address
criteria at all. A search box answers *which rules mention this*. *Which rules
would affect traffic from this host* is a different question, and the one Rules
Walk exists to answer; conflating them makes the search untrustworthy for the
question it appears to be answering.

### Search highlights, it never filters

**Non-matching rules are never hidden.** Search marks hits and leaves every
rule in place.

This is a correctness constraint, not a preference. A rule's meaning depends
entirely on what sits above it in the same chain: hide the `DROP` that
pre-empts your match and the UI will confidently show you a rule that never
fires. Searching `22` and being shown only the SSH rules is precisely how
someone concludes SSH is open when an earlier catch-all is dropping it. A
filter that removes rows from a firewall view is a footgun, so the POC does not
offer one at all — not even opt-in.

Navigation at scale is solved without hiding anything:

- Matched rows get a distinct highlight (background + left marker). Non-matches
  are left **fully legible** — not dimmed, since dimming is de-emphasis and the
  surrounding rules are the whole point. Dimming also already means "disabled".
- The header shows a live match count with previous/next controls that scroll
  between hits, like a browser's find — you move to a hit, you don't delete its
  context. The arrows are **hidden unless a search is active**, and the label
  becomes `3 / 12 matches` as you step, so the controls explain themselves
  instead of sitting there permanently as an unlabelled pair that does nothing.
- Group headers show their own match count, so a long page can be scanned.
- A group that is collapsed but contains a hit auto-expands, so a match can
  never be hidden behind a fold.

The only thing search collapses is a zone pair with **no rules at all**, which
by definition hides nothing.

## Build approach

**Custom table view + stock modal editor.**

The framework's `form.js` GridSection does give real drag-and-drop and free
validation, but it renders *one* table per section and owns its own ordering —
it can't express N grouped sub-tables sharing one global order. So:

- Render the grouped tables ourselves (`ui.js` widgets + our own markup + DnD).
- For **editing a single rule**, open a stock `form.Map` in a modal
  (`table-firewall/editor.js`) rather than hand-built inputs. That inherits the
  framework's widgets, its per-field datatypes (`port`, `ipmask`, `macaddr`,
  `timehhmmss`, `dateyyyymmdd`, `neg(...)`) and its save path — `Map.save()`
  validates, raises its own error modal on failure, and stages through
  `uci.save()` into the same changeset that Save & Apply and its rollback
  operate on. Reimplementing that would be the expensive and error-prone part
  of going custom.
- **Double-click a row to edit it**; the trailing **⋯** opens a per-row menu
  with Edit, Duplicate and Delete; **Add** is the first control in the sticky
  toolbar. The menu is appended to `<body>` and positioned `fixed`, because the
  row lives inside a `.tf-scroll` container whose overflow would clip a menu
  anchored in the table.
- **Duplicate** lands directly after the original via `uci.move()`, so the copy
  appears in the same group at the position being looked at, and opens the
  editor immediately — leaving two byte-identical rules behind would be both
  confusing and pointless. Cancelling removes the copy.
- **Delete** is confirmed, names the rule, says the change is only staged, and
  warns when the rule uses a wildcard zone and therefore disappears from
  several groups at once. A new rule is appended, which is where UCI puts it and therefore
  where it evaluates; it can be dragged into place afterwards. Cancelling an Add
  removes the section again, so an abandoned Add never leaves an empty rule
  staged in the changeset.

## File layout

```
luci-app-table-firewall/
  htdocs/luci-static/resources/table-firewall/model.js   # UCI → normalized model
  htdocs/luci-static/resources/table-firewall/search.js  # tokenizer + autocomplete
  htdocs/luci-static/resources/view/table-firewall/rules.js
  root/usr/share/luci/menu.d/luci-app-table-firewall.json
  root/usr/share/rpcd/acl.d/luci-app-table-firewall.json
```

`model.js` is deliberately separate and chain-aware so **Rules Walk**
(see ROADMAP.md) can reuse it.

## ACL

Modelled on the stock `luci-app-firewall.json`, which is just
`uci: ["firewall"]` read+write. We additionally need **read** on `dhcp` and
`network` (host and subnet autocomplete) and `luci-rpc.getHostHints`.
rpcd ACL mistakes fail as silent permission-denied, so this gets tested first.

## Dev loop

Drop files into `/www/luci-static/resources/...` and
`/usr/share/luci/menu.d/` on 192.168.199.222, clear `/tmp/luci-*`, reload. No
image build until we package it.


# The other tabs

Stock `luci-app-firewall` has six: General Settings (zones), Port Forwards,
Traffic Rules, NAT Rules, IP Sets, Custom Rules.

## Built: General Settings and IP Sets are reused, not rebuilt

A LuCI menu entry names a **view path**, and nothing keys off that path being
unique. So our menu can point at `firewall/zones` and `firewall/ipsets`
directly and the stock views render inside our tab strip — no fork, no
duplicated maintenance, and they keep working when upstream changes them.

The menu points **straight at the stock view paths**. That is the only way it
can work, and it also means those pages cannot be modified from here.

A delegating wrapper — `'require view.firewall.zones as stock'`, then
`stock.constructor.extend({ render })` — was tried and abandoned. It cannot
work, for a structural reason worth recording:

- `L.require()` ends with `const instance = new _class()`; a required module
  arrives **instantiated**.
- A view's `__init__` *is* its lifecycle: `luci.js:1954` runs
  `ready.then(this.load).then(this.render).then(…)` and writes the result into
  `#view`, straight from the constructor.

So requiring a view in order to subclass it **runs that view**, before and
alongside the subclass, both rendering into the same element. The observed
`fwDefaults.getInput is not a function` came out of that. Views are not
reusable as classes — only reachable as menu targets.

The practical consequence: **General Settings and IP Sets are stock pages, and
stay stock.** Anything we want to say about zones has to be said on our own
page — which is where the intra-zone distinction below is surfaced. Changing
them would mean forking the views into this app, or patching upstream LuCI.

Both entries declare `depends.acl` on **both** ACL groups (LuCI requires all
listed groups) and `depends.fs` on the stock view file existing, so the tabs
disappear cleanly rather than 404 if `luci-app-firewall` is not installed.

Requirements to satisfy for that to work:

- both views `require firewall`, `tools.firewall` and `form`; zones also needs
  `network` and `tools.widgets`
- `zones.js` calls `luci.getConntrackHelpers`; our ACL now grants it, alongside
  `network.device status` which the zone and device widgets need
- stock's parent entry also depends on `/sbin/fw3` being executable; fw4
  systems ship an fw3 compat shim, so this holds on both lab boxes

Custom Rules is skipped: it depends on `/usr/share/fw3/helpers.conf`, which is
an fw3-era file.

## Source-zone sections fold, and summarise

Each `zone as source` heading is a fold control carrying a live summary:

```
▾  wan  as source            21 rules  6 DNAT  3 SNAT  2 mangle  1 disabled
```

Counts are **by distinct section id**, so a wildcard rule shadowed into several
pairs counts once, and they follow the active IPv4/IPv6 tab. SNAT is the union
over the zone's destinations, deduplicated, since the same source-NAT rules are
shown after several pairs.

The fold is persisted per browser alongside the column preferences. **A fold
never hides a search hit**: a folded zone containing a match opens itself and
says why, for the same reason search never hides a row — what you cannot see,
you cannot reason about.

## Built: NAT renders beside the pair it affects

Final placement, replacing the earlier per-source-zone blocks:

```
lan → wan   9 rules
  ➡️ Port forwards arriving here — prerouting   dstnat_lan · positions within
     (none for this pair)                        that chain, 6 in total
  1  ✅ Block-LAN-SMTP-Direct …
  …
  ↳ Anything not matched above: ✅ ACCEPT — zone forwarding lan → wan
  ▸ ⬅️ Leaving via wan   3 NAT rules   🎭 masquerade   shared by every pair ending here
```

- **Shadowed forwards are detected.** Splitting forwards by destination is the
  one thing that could hide a collision within `dstnat_<src>`, so a forward
  that an earlier one already swallows is flagged with ⚠ naming the culprit.
  Overlap is compared properly — protocols intersected, ports as ranges
  (`80 443` overlaps `443`, `6881-6889` contains `6885`), source addresses by
  CIDR containment — not by string equality.
- **Port forwards** carry both zones, so each lands beside exactly one pair, at
  the top — they run in prerouting and create the traffic the filter rules then
  judge. They are numbered by their **true position in `dstnat_<src>`**, and the
  header names that chain and its total, because they are ordered against every
  forward sharing the source zone, not just the ones shown.
- **Source NAT** is keyed by egress zone alone, so the same rules belong after
  *every* pair ending there. Rendered **collapsed by default** as a one-line
  summary marked "shared by every pair ending here", expandable in place.
- It sits **after the verdict**, because it applies on the way out.
- **Masquerade** needs nothing extra: it is a zone option that fw4 emits as the
  last rule of `srcnat_<zone>`, so it is already this block's terminator, shown
  as a badge on the collapsed summary.

`natTerminatorFor()` is family-aware: `masq` and `masq6` are separate options,
so a zone masquerading IPv4 is not claimed to masquerade IPv6, and
`masq_src`/`masq_dest` scoping is stated when set.

## Why the grouping is NOT the same as Traffic Rules

This is the important finding, and it contradicts the obvious plan of "same
treatment as traffic rules".

**Traffic rules can be grouped by zone pair** because the destination zone is
matched *in the jump target* (`accept_to_DMZ` is `oifname "br-dmz"`), and a
jump into a non-matching target falls through. Two rules with different
destination zones can never match the same packet, so splitting them into
separate tables loses nothing.

**Port forwards are the opposite.** Verified against the compiled ruleset:

```
chain dstnat_wan {
    tcp dport 80    dnat ip to 10.10.10.10:80    "DNAT-Web-HTTP"      (dest DMZ)
    tcp dport 443   dnat ip to 10.10.10.10:443   "DNAT-Web-HTTPS"     (dest DMZ)
    tcp dport 2222  dnat ip to 10.10.30.5:22     "DNAT-SSH-Jumphost"  (dest production)
    ...
}
```

Every forward with the same **source** zone sits in one ordered chain, and the
destination zone appears **only in the rewrite target**, never as a match. A
forward to DMZ and a forward to production compete for the same inbound packet;
the first match wins. Grouping them by `src → dest` would separate rules that
genuinely order against each other — precisely the lie this whole design exists
to prevent.

So:

| | section | chain | group by |
|---|---|---|---|
| Traffic rules | `rule` | `forward_<src>` / `input_<src>` | zone **pair** |
| Port forwards | `redirect` (dnat) | `dstnat_<src>` | **source zone only** |
| NAT rules | `nat` | `srcnat_<src>` | **source zone only** |

`config nat` has no `dest` zone option at all (`src`, `src_ip`, `src_port`,
`snat_ip`, `snat_port`, `dest_ip`, `dest_port`, …), so there is no pair to group
by even in principle.

One legacy case: `config redirect` with `target snat` lands in
`srcnat_<**dest**>` — keyed by destination, unlike everything else. Rare, but
the model must not assume redirects are always dnat.

The columns, search, resize strip, staged-change highlighting and reorder
machinery all carry over unchanged; only the grouping key differs. `model.js`
already parses `redirect` but not `nat`, and derives no chain for either — both
need adding alongside the existing rule chain logic.


## Correction to record: `config nat`'s `src` is the *egress* zone

Found 2026-09-09 by Gerhard looking at the seeded SNAT rules: our table shows
"Source zone: wan" where the source is actually unconstrained and `wan` is
where the traffic *leaves*.

He is right, and the evidence is unambiguous:

- The parent chains dispatch on opposite interfaces —
  `srcnat` uses **`oifname`** (outgoing), `dstnat` uses **`iifname`**
  (incoming). So `srcnat_wan` is reached by traffic *leaving* via wan.
- Stock LuCI's `snats.js` agrees. It reads the same `src` option twice:
  `rule_dest_txt()` renders it as the **destination** ("To <zone>"), while
  `rule_src_txt()` **ignores it** and prints the source as literally
  *"any zone"*, showing only `src_ip`/`src_port`. The editor labels the field
  **"Outbound zone"**.

So the option name is a UCI wart, and the mapping across section types is:

| section | option | meaning | chain |
|---|---|---|---|
| `redirect` (dnat) | `src` | ingress zone (`iifname`) — genuinely the source | `dstnat_<src>` |
| `nat` | `src` | **egress** zone (`oifname`) — the destination | `srcnat_<src>` |
| `redirect` (snat, legacy) | `dest` | egress zone | `srcnat_<dest>` |

### What this breaks in the current build

1. **Columns are inverted for NAT rows.** A `nat` row should show
   *Source zone* = **any zone** (only `src_ip` constrains it) and
   *Destination zone* = the `src` option's value. We currently show the
   reverse.

2. **The SNAT block is filed under the wrong heading.** The page is organised
   "per source zone", and the srcnat block for a zone was placed there. But a
   packet enters via zone A (`dstnat_A`), is filtered A→B, and leaves via zone
   B (`srcnat_B`) — so the srcnat block under a section headed "wan as source"
   is really about traffic *arriving* at wan from elsewhere.

   The packet-flow reading still holds, but the heading is what is wrong: a
   zone section should be headed just **`wan`**, with its blocks labelled
   *arriving via wan* (dstnat) and *leaving via wan* (srcnat), and the filter
   groups in between being the ones where wan is the source. That keeps
   everything anchored on one zone and stops the heading claiming a direction
   the srcnat block does not have.

The NAT editor already labels the field "Outbound zone", matching stock, so
only the table display and the section heading are wrong.


## Dissection: placing DNAT and SNAT next to the pair they affect

Gerhard's proposal — put DNAT above the matching `src → dest` group, and SNAT
after each `zone → wan` group — measured against the lab data.

### DNAT above the matching pair: works, and costs nothing

Every port forward carries both zones, so each lands in **exactly one** pair.
In the lab all six have `src=wan`, with `dest` DMZ (4) or production (2) — so
they distribute cleanly, no copies needed.

The one caveat: all six are ordered together in `dstnat_wan` and compete for
the same inbound packet, so splitting them by destination separates rules that
do order against each other. In the lab they cannot actually collide (ports
80/443/25/587 versus 2222/33890 are disjoint) but an edit could create a
collision tomorrow. Mitigations, both cheap:

- number each forward by its **true position in `dstnat_<src>`**, and name the
  chain and its total in the block header, so the split is visible;
- **detect overlap** across the whole chain — two forwards whose `proto` +
  `src_dport` + `src_ip` intersect — and flag both. A shadowed port forward is
  a classic misconfiguration, so this is worth having regardless. (Already on
  the roadmap as shadowed-rule detection.)

### SNAT after the pair: works, but it is the only place copies are needed

NAT rules are keyed by **egress** zone alone, so `srcnat_wan` applies to
everything leaving via wan whatever its source. Placed after each `X → wan`
group it repeats: **4 copies** in the lab (lan, DMZ, MGMT_DMZ, production →
wan), 5 if empty pairs show it too.

That is the honest cost of putting it where it is useful. Proposed mitigation:
render it **collapsed by default** as a one-line summary — `⬅️ leaving via wan
— 3 NAT rules + masquerade` — expandable in place, and marked as a shared block
so it is obvious the copies are one set of rules, not four.

### The missing masquerade falls out of that placement for free

`masq` is a **zone** option, not a rule — only `wan` has it here — and fw4
emits it as the **last rule of `srcnat_wan`**:

```
ip saddr 10.10.30.0/24 masquerade          "MASQ-Production-Out"
meta nfproto ipv4 masquerade               "Masquerade IPv4 wan traffic"   <- zone masq
```

So it is already the natural terminator of the SNAT block, and the block only
needs to appear after `X → wan` for it to show up where it is wanted. Nothing
extra to build.

Two details to get right when doing it:

- **`masq` and `masq6` are separate zone options.** Ours sets `masq` only, and
  fw4 emits `meta nfproto ipv4 masquerade` — IPv4 only. The **IPv6 tab must not
  claim masquerade**. `natTerminatorFor()` currently ignores family, which is a
  bug to fix at the same time.
- **`masq_src` / `masq_dest`** can scope masquerading to particular subnets. If
  set, the terminator should say so rather than implying it covers everything.


## Zone forward policy is intra-zone only

Worth stating because the stock UI reads otherwise, and Gerhard caught it.

A zone's **Forward** setting is *not* the fallback for zone-to-zone traffic.
`forward_<zone>` ends with `jump <policy>_to_<zone>`, and that target matches
the zone's **own** `oifname` — so it only ever governs traffic that both enters
and leaves through the same zone.

```
chain forward_lan {
    …
    jump accept_to_wan      "Accept lan to wan forwarding"     <- config forwarding
    jump accept_to_DMZ      "Accept lan to DMZ forwarding"     <- config forwarding
    jump drop_to_lan                                            <- zone forward=DROP
}
chain accept_to_lan { oifname "br-lan" accept }
```

Zone-to-zone is governed by `config forwarding` sections; with none, the packet
falls out of the zone chain to the parent `forward` chain.

**And the fallback there is the default forward policy, not a fixed REJECT.**
`ruleset.uc` appends `jump handle_reject` only `if (fw4.forward_policy() ==
"reject")`; otherwise the chain's own `policy` applies. The terminator had
REJECT hardcoded, which would have stated the wrong verdict on any config whose
default forward policy is DROP or ACCEPT.


## Dissection: one address, several names

Reported 2026-09-09 — an nginx host serving several sites has several FQDNs on
one address, and the table shows only one of them.

**The bug is real.** `addrCell()` resolves a name with

```js
const host = model.hosts.find(h => h.ip === v && h.name);
```

`.find()` returns the **first** match and discards the rest, so an address with
several names always renders exactly one, arbitrarily chosen by parse order —
static leases first, then `config domain` records, then leases and neighbours.
The model itself already holds them all; only the rendering throws them away.

Measured on the 24.10 box after the report:

```
10.10.10.1   -> nginx [DNS record], nginx2 [DNS record], nginx.lan [lease/neighbour]
10.10.10.10  -> web01 [static lease]
```

So the fix is to render every name for an address, not the first — deduplicated,
because the same name can arrive from more than one source (`nginx` as a
`config domain` record and `nginx.lan` from the neighbour table are the same
host seen twice).

### But the reported case is not the one that was set up

`nginx` and `nginx2` were entered against **10.10.10.1** — the DMZ bridge's own
gateway address — not 10.10.10.10. `Allow-Prod-Updates` has
`src_ip=10.10.10.10`, which is `web01`, and that address genuinely has only one
name. So that rule will still show `web01` alone after the fix, and it is right
to. The multi-name rendering will show for any rule referencing 10.10.10.1.

**Built:** `model.namesFor(ip)` returns every name for an address, most
authoritative first (static leases, then DNS records, then leases and
neighbours). The cell shows the first two inline and puts the rest behind a
`+N` badge that names them on hover — the same pattern as the hidden-criteria
marker, so a long list cannot crowd out the address itself.

Deduplication strips the configured local domain before comparing, so `nginx`
and `nginx.lan` count as one host seen twice rather than two names. A name in
another domain (`www.tinypixelmapper.com`) is left whole.


## Built: IPv4/IPv6 as independent toggles

The two buttons toggle independently rather than flipping between families, so
both can be on at once — and both are on by default.

This fits the project's governing principle better than tabs do: showing
everything by default and never hiding what you did not ask to hide. Measured
on the lab config, of 76 objects (rules, forwards, NAT):

```
dual-stack   51        v4 only selected -> 71
IPv4 only    20        v6 only selected -> 56
IPv6 only     5        both selected    -> 76
```

A dual-stack rule is filtered by *"does it apply to any selected family"*, so
selecting both shows it **once**, not twice — there is no duplication to
resolve. The tabs never showed this because you could never see both at once.

### It makes the IPv column earn its place

In the v4 tab nearly every visible rule lights v4, so the chips are close to
redundant. With both families shown they become the thing that tells you which
is which — the column stops being decoration.

### Four things need attention

1. **Both off.** A degenerate state that renders an empty page and looks like a
   fault. Turning off the last active family should be refused rather than
   producing a blank table.

2. **The masquerade terminator is the one family-dependent verdict.** `masq`
   and `masq6` are separate zone options, and on this config they differ:

   ```
   wan srcnat, IPv4 -> MASQUERADE   zone wan masquerades remaining IPv4 traffic
   wan srcnat, IPv6 -> NONE         no source NAT
   ```

   With both selected the footer has to state **both**, not pick one. That is
   strictly more honest than either tab is today, where the footer silently
   describes only the family you happen to be looking at.

3. **Counts and summaries take a family, not a set.** `zoneSummary()` and the
   header's match count are written around a single family and need to accept
   the selection.

4. **Default.** Tabs default to IPv4. Independent toggles should default to
   **both on** — the same reasoning that stops search hiding rows. A firewall
   view that quietly omits five IPv6 rules unless you find the right button is
   the failure this project exists to avoid.

The selection persists alongside the column, width and fold preferences.

All four points were handled: the last active family cannot be switched off,
the masquerade footer states each family separately when they differ (and drops
the qualifier when only one family is selected), `zoneSummary()` and the counts
take the selection, and both families are on by default.

The `family` tab state is gone; `inFamilies()` is the single filter, so a rule
is shown when it applies to **any** selected family — which is what makes a
dual-stack rule appear once rather than twice.
