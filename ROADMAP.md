# Roadmap — ideas to examine, implement later, or drop

Nothing here is committed work. Each item notes what the current design must
*not* foreclose, so we can keep the door open cheaply.

## Rules Walk  (Gerhard's idea, 2026-09-08)

A second tab: pick a source zone, enter source IP, destination IP, protocol and
port — the tool reports **which rule the packet hits**, in evaluation order,
including what NAT does to it along the way.

Why it's non-trivial: the answer isn't a single rule. A packet traverses
`dstnat` (DNAT may rewrite the destination *before* the forward decision, which
in turn can change which zone it is heading to), then `forward_<srczone>`, then
`snat`. A useful walk shows the whole path, not just the verdict.

A concrete demand for it already surfaced: search deliberately does *not* treat
"this address is inside that zone's subnet" as a match, because doing so made a
single host lookup light up every rule referencing the zone. That question —
*which rules would affect traffic from this host* — is exactly what a walk
answers properly, with the chain order and NAT taken into account.

**What the main table design must preserve so this stays cheap:**

- Keep rule parsing in a `model.js` separate from the view, so the walk can
  reuse the same normalized rule objects instead of re-parsing UCI.
- Model **redirects (port forwards) from day one**, even though the POC tab only
  renders traffic rules — a walk that ignores DNAT is worse than no walk.
- Keep the model **chain-aware** (`input_X` / `forward_X` / `dstnat` / `snat`)
  rather than storing a flat "zone pair" string. The zone pair should be
  *derived* from the chain + target, not the primary key.
- Preserve the real global evaluation order in the model. The grouped view is a
  projection; the walk needs the underlying sequence.
- Resolve zone → device → subnet once, in the model. The walk needs it to decide
  which zone an IP belongs to; the table needs it for search.

Open question: whether to simulate in JS from the UCI model, or shell out to
`nft` on the box. Simulating is portable and offline but can drift from fw4's
real semantics; `nft` is authoritative but needs a new ubus method and extra
ACL. Worth prototyping the JS path first and checking it against `fw4 print`.

## Other ideas (unranked, some may be dropped)

- **Live counters.** Deferred from the POC to keep the app on stock ubus
  methods only. Researched 2026-09-08; findings worth keeping:

  - fw4 emits `counter packets N bytes N` on **every** rule by default, and
    `nft -j list ruleset` returns clean JSON (schema version 1). The data is
    there for free.
  - **But no stock ubus object exposes nftables** — the box has only `luci`
    and `luci-rpc`. Reaching it needs either a `file` `exec` grant on `nft`,
    which would also permit `nft flush ruleset` (a write capability disguised
    as a read — rejected for a firewall app), or a small purpose-built
    read-only rpcd plugin exposing one argument-less `counters` method.
  - Mapping back to UCI is by the `!fw4: <name>` comment, the only link fw4
    provides. Measured on the lab ruleset: 124 distinct comments, of which 65
    are fw4's own internals and must be ignored, and 5 user rules expand to
    two nft rules each (`Allow-LAN-DNS-Out` becomes separate tcp and udp
    lines), so counters must be **summed** per name.
  - UCI permits duplicate rule names. The lab has none, but where they occur
    counters cannot be attributed to a specific rule, and the column must show
    "—" rather than a plausible wrong number.
- **Shadowed-rule detection.** Flag a rule that can never match because an
  earlier rule in the same chain fully covers it. Same engine as Rules Walk.
- **Port forwards tab**, in the same grouped style.
- **Zone topology view** — a small graph of zones and forwarding policies.
- **Bulk enable/disable and multi-select**, for the "turn off this whole block
  while I test" workflow.
- **Rule change diff before apply** — show the staged uci changeset as a
  human-readable summary, not just LuCI's raw change list.
- **Import/export** a ruleset as JSON for moving between boxes.
- **Named object groups** (address / service objects, Fortigate style). Big
  change: OpenWrt has ipsets, but UCI has no first-class address-object concept.
  Likely a "drop unless it proves necessary".
