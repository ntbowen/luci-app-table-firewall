'use strict';
'require baseclass';
'require uci';
'require rpc';
'require fs';
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Gerhard Mautendorfer (MaidByC)

/* Normalized, chain-aware model of the firewall configuration.
 *
 * Deliberately separate from any view: the grouped rules table and the planned
 * Rules Walk (see ROADMAP.md) both sit on this. The chain a rule lands in is
 * the primary fact; the "zone pair" the UI groups by is *derived* from it.
 *
 * Chain selection and family inference below mirror firewall4's own logic in
 * /usr/share/ucode/fw4.uc rather than being reconstructed from observed
 * behaviour — getting either subtly wrong makes the grouped view lie.
 */

const callHostHints = rpc.declare({
	object: 'luci-rpc',
	method: 'getHostHints',
	expect: { '': {} }
});

const callInterfaceDump = rpc.declare({
	object: 'network.interface',
	method: 'dump',
	expect: { interface: [] }
});

/* The device pseudo-zone: traffic to or from the router itself. fw4 expresses
 * this as an absent src/dest, but the UI needs a nameable bucket for it. */
const DEVICE = '(device)';
const ANY = '*';

/* ICMP type names that exist only in one address family. Mirrors the
 * ipv4_icmptypes / ipv6_icmptypes tables in fw4.uc; a name present in both
 * leaves the family unpinned. */
const ICMP6_ONLY = [
	'packet-too-big', 'bad-header', 'unknown-header-type',
	'router-solicitation', 'router-advertisement',
	'neighbour-solicitation', 'neighbour-advertisement',
	'neighbor-solicitation', 'neighbor-advertisement',
	'redirect'
];

const ICMP4_ONLY = [
	'network-unreachable', 'host-unreachable', 'protocol-unreachable',
	'port-unreachable', 'fragmentation-needed', 'source-route-failed',
	'network-unknown', 'host-unknown', 'network-prohibited',
	'host-prohibited', 'TOS-network-unreachable', 'TOS-host-unreachable',
	'communication-prohibited', 'host-precedence-violation',
	'precedence-cutoff', 'source-quench', 'network-redirect',
	'host-redirect', 'TOS-network-redirect', 'TOS-host-redirect',
	'router-solicitation', 'router-advertisement', 'ttl-zero-during-transit',
	'ttl-zero-during-reassembly', 'ip-header-bad',
	'required-option-missing', 'timestamp-request', 'timestamp-reply',
	'address-mask-request', 'address-mask-reply'
];

function toArray(v) {
	if (v == null) return [];
	if (Array.isArray(v)) return v;
	const s = String(v).trim();
	return s.length ? s.split(/\s+/) : [];
}

function isTrue(v, dflt) {
	if (v == null || v === '') return dflt;
	return v == '1' || v == 'true' || v == 'yes' || v == 'on' || v == 'enabled';
}

/* ---------------------------------------------------------------------------
 * Address helpers. Search has to answer "is 10.10.10.10 inside 10.10.10.0/24",
 * which is the difference between a useful filter and a glorified grep.
 * ------------------------------------------------------------------------ */

function parseIPv4(s) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
	if (!m) return null;
	let n = 0;
	for (let i = 1; i <= 4; i++) {
		const o = +m[i];
		if (o > 255) return null;
		n = (n * 256) + o;
	}
	return n;
}

function expandIPv6(s) {
	if (s.indexOf(':') < 0) return null;
	const halves = s.split('::');
	if (halves.length > 2) return null;

	const head = halves[0] ? halves[0].split(':') : [];
	const tail = (halves.length == 2 && halves[1]) ? halves[1].split(':') : [];
	if (halves.length == 1 && head.length != 8) return null;

	const fill = 8 - head.length - tail.length;
	if (fill < 0) return null;

	const parts = head.concat(Array(halves.length == 2 ? fill : 0).fill('0'), tail);
	if (parts.length != 8) return null;

	const words = [];
	for (const p of parts) {
		if (!/^[0-9a-fA-F]{0,4}$/.test(p)) return null;
		words.push(parseInt(p || '0', 16));
	}
	return words;
}

/* Returns {family, addr, bits} or null. `addr` is a number for v4 and an array
 * of 8 words for v6, so containment can be tested uniformly. */
function parseAddr(str) {
	if (str == null) return null;
	let s = String(str).trim();
	if (!s.length) return null;

	/* firewall rules allow negation with a leading ! */
	let negated = false;
	if (s.charAt(0) == '!') { negated = true; s = s.slice(1).trim(); }

	let bits = null;
	const slash = s.lastIndexOf('/');
	if (slash > 0) {
		const suffix = s.slice(slash + 1);
		s = s.slice(0, slash);
		if (/^\d+$/.test(suffix))
			bits = +suffix;
		else if (parseIPv4(suffix) != null)
			/* dotted netmask */
			bits = (parseIPv4(suffix) >>> 0).toString(2).replace(/0+$/, '').length;
		else
			return null;
	}

	const v4 = parseIPv4(s);
	if (v4 != null)
		return { family: 4, addr: v4, bits: bits == null ? 32 : bits, negated: negated };

	const v6 = expandIPv6(s);
	if (v6 != null)
		return { family: 6, addr: v6, bits: bits == null ? 128 : bits, negated: negated };

	return null;
}

function addrContains(net, probe) {
	if (!net || !probe || net.family != probe.family) return false;

	if (net.family == 4) {
		if (net.bits == 0) return true;
		const mask = net.bits >= 32 ? 0xFFFFFFFF : (~((1 << (32 - net.bits)) - 1) >>> 0);
		return ((net.addr & mask) >>> 0) === ((probe.addr & mask) >>> 0);
	}

	let left = net.bits;
	for (let i = 0; i < 8 && left > 0; i++) {
		const take = Math.min(16, left);
		const mask = take >= 16 ? 0xFFFF : (~((1 << (16 - take)) - 1) & 0xFFFF);
		if ((net.addr[i] & mask) !== (probe.addr[i] & mask)) return false;
		left -= take;
	}
	return true;
}

/* ---------------------------------------------------------------------------
 * Model
 * ------------------------------------------------------------------------ */

const Model = baseclass.extend({
	/* exposed on the instance as well as the module, so callers holding only
	 * a loaded model can still do subnet-aware comparisons */
	parseAddr: parseAddr,
	addrContains: addrContains,

	__init__() {
		this.zones = {};
		this.zoneOrder = [];
		this.rules = [];
		this.redirects = [];
		this.nats = [];
		this.forwardings = [];
		this.defaults = {};
		this.hosts = [];
		this.services = [];
		this.interfaces = {};
		/* rules that matched no zone-pair group; surfaced rather than dropped */
		this.orphans = [];
	},

	load() {
		return Promise.all([
			uci.load('firewall'),
			uci.load('network'),
			uci.load('dhcp'),
			callHostHints().catch(() => ({})),
			callInterfaceDump().catch(() => []),
			fs.read('/etc/services').catch(() => '')
		]).then(([, , , hints, ifaces, services]) => {
			this.parseInterfaces(ifaces);
			this.parseZones();
			this.parseRules();
			this.parseRedirects();
			this.parseNats();
			this.parseForwardings();
			this.parseDefaults();
			this.parseHosts(hints);
			this.parseServices(services);
			this.buildGroups();
			this.buildNatGroups();
			return this;
		});
	},

	parseInterfaces(dump) {
		/* live L3 device + addresses per logical interface */
		for (const i of (dump || [])) {
			this.interfaces[i.interface] = {
				name: i.interface,
				device: i.l3_device || i.device || null,
				up: !!i.up,
				subnets: []
					.concat((i['ipv4-address'] || []).map(a => parseAddr(a.address + '/' + a.mask)))
					.concat((i['ipv6-address'] || []).map(a => parseAddr(a.address + '/' + a.mask)))
					.filter(Boolean)
			};
		}

		/* fall back to static config for interfaces that are down */
		uci.sections('network', 'interface', (s) => {
			const name = s['.name'];
			const rec = this.interfaces[name] || (this.interfaces[name] = {
				name: name, device: s.device || null, up: false, subnets: []
			});
			if (!rec.subnets.length && s.ipaddr) {
				const a = parseAddr(s.netmask ? (s.ipaddr + '/' + s.netmask) : s.ipaddr);
				if (a) rec.subnets.push(a);
			}
			if (!rec.device && s.device) rec.device = s.device;
		});
	},

	parseZones() {
		uci.sections('firewall', 'zone', (s) => {
			const name = s.name || s['.name'];
			const networks = toArray(s.network).length ? toArray(s.network) : [name];
			const devices = toArray(s.device);
			const subnets = [];

			for (const n of networks) {
				const iface = this.interfaces[n];
				if (!iface) continue;
				if (iface.device) devices.push(iface.device);
				for (const sn of iface.subnets) subnets.push(sn);
			}

			this.zones[name] = {
				name: name,
				sid: s['.name'],
				networks: networks,
				devices: devices.filter((d, i, a) => a.indexOf(d) == i),
				subnets: subnets,
				input: (s.input || 'DROP').toUpperCase(),
				output: (s.output || 'DROP').toUpperCase(),
				forward: (s.forward || 'DROP').toUpperCase(),
				masq: isTrue(s.masq, false),
				masq6: isTrue(s.masq6, false),
				masqSrc: toArray(s.masq_src),
				masqDest: toArray(s.masq_dest),
				raw: s,
				/* a zone may itself be restricted to one family, which
				 * propagates to every rule referencing it (fw4.uc:2104) */
				family: this.familyOf(s.family)
			};
			this.zoneOrder.push(name);
		});
	},

	familyOf(v) {
		if (v == null) return 0;
		const s = String(v).toLowerCase();
		if (s == 'ipv4' || s == 'inet' || s == '4') return 4;
		if (s == 'ipv6' || s == 'inet6' || s == '6') return 6;
		return 0;
	},

	/* Chain selection, mirroring fw4.uc lines 2484-2499 exactly.
	 *
	 *   default                       -> "output"
	 *   src specific                  -> (dest ? forward : input)_<src>
	 *   src == "*"                    -> (dest ? forward : input)      [parent!]
	 *   dest specific and no src      -> output_<dest>
	 *   dest == "*" and no src        -> "output"
	 *
	 * The "*" cases land in the *parent* chain, which is why such rules apply
	 * across every zone rather than to one pair.
	 */
	computeChain(src, dest, target) {
		const hasSrc = (src != null), hasDest = (dest != null);
		const srcAny = (src === ANY), destAny = (dest === ANY);
		const srcZone = hasSrc && !srcAny, destZone = hasDest && !destAny;
		const t = String(target || 'ACCEPT').toLowerCase();

		/* Special targets are handled first (fw4.uc:2454-2472) and land in
		 * mangle/raw chains on different netfilter hooks. They therefore never
		 * interact with the filter rules of the same zone pair, which is why
		 * the view must not number them in the same sequence. */
		if (t === 'notrack')
			return { chain: srcZone ? ('notrack_' + src) : 'notrack', kind: 'notrack' };

		if (t === 'helper')
			return { chain: srcZone ? ('helper_' + src) : 'helper', kind: 'helper' };

		if (t === 'mark' || t === 'dscp') {
			let chain;
			if ((srcAny && destAny) || (srcZone && destZone)) chain = 'mangle_forward';
			else if (srcAny && destZone)                      chain = 'mangle_postrouting';
			else if (srcZone && destAny)                      chain = 'mangle_prerouting';
			else if (hasSrc && !hasDest)                      chain = 'mangle_input';
			else                                              chain = 'mangle_output';
			return { chain: chain, kind: 'mangle' };
		}

		/* Ordinary filter rules (fw4.uc:2484-2499). */
		let chain = 'output', kind = 'output';

		if (hasSrc) {
			kind = hasDest ? 'forward' : 'input';
			chain = srcAny ? kind : (kind + '_' + src);
		}

		if (hasDest && !hasSrc) {
			kind = 'output';
			chain = destAny ? 'output' : ('output_' + dest);
		}

		return { chain: chain, kind: kind };
	},

	/* Filter rules are ordered against each other; mangle/raw rules are not. */
	isFilterKind(kind) {
		return kind === 'input' || kind === 'forward' || kind === 'output';
	},

	/* Effective family, mirroring fw4.uc:2544. An explicit option wins;
	 * otherwise address literals, zone families and single-family ICMP type
	 * names pin it. Anything left unpinned is genuinely dual-stack. */
	inferFamily(s, srcZone, destZone) {
		const declared = this.familyOf(s.family);
		if (declared) return { family: declared, by: 'declared' };

		const proto = toArray(s.proto).map(p => String(p).toLowerCase());
		if (proto.indexOf('icmpv6') >= 0 || proto.indexOf('ipv6-icmp') >= 0)
			return { family: 6, by: 'protocol icmpv6' };

		for (const key of ['src_ip', 'dest_ip']) {
			for (const v of toArray(s[key])) {
				const a = parseAddr(v);
				if (a) return { family: a.family, by: key.replace('_', ' ') };
			}
		}

		for (const z of [srcZone, destZone]) {
			if (z && z.family)
				return { family: z.family, by: 'zone ' + z.name };
		}

		const itypes = toArray(s.icmp_type);
		if (itypes.length) {
			const only6 = itypes.every(t => ICMP6_ONLY.indexOf(t) >= 0);
			const only4 = itypes.every(t => ICMP4_ONLY.indexOf(t) >= 0);
			if (only6 && !only4) return { family: 6, by: 'ICMP type' };
			if (only4 && !only6) return { family: 4, by: 'ICMP type' };
		}

		return { family: 0, by: 'dual-stack' };
	},

	parseRules() {
		let index = 0;

		uci.sections('firewall', 'rule', (s) => {
			const src = (s.src != null && s.src !== '') ? s.src : null;
			const dest = (s.dest != null && s.dest !== '') ? s.dest : null;
			const target = (s.target || 'ACCEPT').toUpperCase();
			const { chain, kind } = this.computeChain(src, dest, target);
			const srcZone = (src && src != ANY) ? this.zones[src] : null;
			const destZone = (dest && dest != ANY) ? this.zones[dest] : null;
			const fam = this.inferFamily(s, srcZone, destZone);

			this.rules.push({
				sid: s['.name'],
				index: index++,
				name: s.name || s['.name'],
				enabled: isTrue(s.enabled, true),

				src: src,
				dest: dest,
				srcAny: src === ANY,
				destAny: dest === ANY,
				srcZone: srcZone,
				destZone: destZone,

				chain: chain,
				chainKind: kind,

				target: target,
				proto: toArray(s.proto),
				srcIp: toArray(s.src_ip),
				destIp: toArray(s.dest_ip),
				srcPort: toArray(s.src_port),
				destPort: toArray(s.dest_port),
				icmpType: toArray(s.icmp_type),
				mac: toArray(s.src_mac),
				limit: s.limit || null,

				family: fam.family,
				familyBy: fam.by,

				/* the raw section, so the view can render any of the 37
				 * options fw4 accepts without the model enumerating them */
				raw: s,

				/* A rule that names no specific counterpart zone escapes its
				 * group: dest="*" matches every destination, src="*" sits in
				 * the parent chain and so applies to every source. Both need
				 * to be shown inside every group they can affect. */
				wildcard: (src === ANY || dest === ANY),

				groupKey: this.groupKeyFor(src, dest)
			});
		});
	},

	/* Which zone-pair groups a rule belongs in.
	 *
	 * `*` means *any zone*, and a zone is not the device: a rule with
	 * `dest='*'` is a forward rule (fw4 puts it in forward_<src>), so it can
	 * never affect traffic to the router itself and must not appear in an
	 * input group. Likewise `src='*'` spans every real source zone but not
	 * the device's own output.
	 */
	groupMatchesRule(g, rule) {
		const srcOk = rule.srcAny
			? (g.src !== DEVICE)
			: (g.src === (rule.src == null ? DEVICE : rule.src));

		const destOk = rule.destAny
			? (g.dest !== DEVICE)
			: (g.dest === (rule.dest == null ? DEVICE : rule.dest));

		return srcOk && destOk;
	},

	groupKeyFor(src, dest) {
		const s = (src == null) ? DEVICE : src;
		const d = (dest == null) ? DEVICE : dest;
		return s + '|' + d;
	},

	/* NAT lives on different netfilter hooks from the filter rules, and both
	 * kinds group by *source zone alone* — unlike filter rules, which group by
	 * zone pair.
	 *
	 * Verified against the compiled ruleset: every port forward sharing a
	 * source zone sits in one ordered `dstnat_<src>` chain and the destination
	 * zone appears only in the rewrite target, never as a match. So a forward
	 * to DMZ and one to production compete for the same inbound packet.
	 *
	 *   config redirect, target dnat -> dstnat_<src>     (prerouting)
	 *   config redirect, target snat -> srcnat_<dest>    (legacy, keyed by dest)
	 *   config nat                   -> srcnat_<src>     (postrouting)
	 */
	parseRedirects() {
		let index = 0;
		uci.sections('firewall', 'redirect', (s) => {
			const target = (s.target || 'DNAT').toUpperCase();
			const src = s.src || null;
			const dest = s.dest || null;

			/* fw4 calls a dnat with no rewrite address a "redirect" */
			const kind = (target === 'SNAT') ? 'snat'
				: (s.dest_ip ? 'dnat' : 'redirect');

			const chain = (target === 'SNAT')
				? (dest ? 'srcnat_' + dest : 'srcnat')
				: (src ? 'dstnat_' + src : 'dstnat');

			this.redirects.push({
				sid: s['.name'],
				index: index++,
				name: s.name || s['.name'],
				enabled: isTrue(s.enabled, true),
				section: 'redirect',
				target: target,
				kind: kind,
				src: src,
				dest: dest,
				proto: toArray(s.proto),
				srcIp: toArray(s.src_ip),
				srcPort: toArray(s.src_dport),
				destIp: toArray(s.dest_ip),
				destPort: toArray(s.dest_port),
				rewriteIp: s.dest_ip || null,
				rewritePort: (toArray(s.dest_port)[0] || null),
				hook: (target === 'SNAT') ? 'srcnat' : 'dstnat',
				/* the zone whose chain it is ordered in */
				chainZone: (target === 'SNAT') ? dest : src,
				chain: chain,
				chainKind: (target === 'SNAT') ? 'srcnat' : 'dstnat',
				raw: s,
				/* fields the shared row renderer expects */
				srcAny: src === ANY,
				destAny: dest === ANY,
				srcZone: (src && src != ANY) ? this.zones[src] : null,
				destZone: (dest && dest != ANY) ? this.zones[dest] : null,
				icmpType: [],
				wildcard: false,
				family: this.inferFamily(s, null, null).family,
				familyBy: this.inferFamily(s, null, null).by
			});
		});
	},

	parseNats() {
		let index = 0;
		uci.sections('firewall', 'nat', (s) => {
			/* `src` on a config nat section is the *egress* zone: the parent
			 * srcnat chain dispatches on oifname, and stock LuCI reads the
			 * same option as the destination while showing the source as
			 * "any zone". So it is presented as the destination here, and the
			 * source is genuinely unconstrained apart from src_ip. */
			const egress = s.src || null;
			this.nats.push({
				sid: s['.name'],
				index: index++,
				name: s.name || s['.name'],
				enabled: isTrue(s.enabled, true),
				section: 'nat',
				target: (s.target || 'MASQUERADE').toUpperCase(),
				kind: 'snat',
				src: ANY,
				dest: egress,
				zoneNoWarn: true,
				proto: toArray(s.proto),
				srcIp: toArray(s.src_ip),
				srcPort: toArray(s.src_port),
				destIp: toArray(s.dest_ip),
				destPort: toArray(s.dest_port),
				rewriteIp: s.snat_ip || null,
				rewritePort: s.snat_port || null,
				hook: 'srcnat',
				chainZone: egress,
				chain: egress ? ('srcnat_' + egress) : 'srcnat',
				chainKind: 'srcnat',
				raw: s,
				srcAny: true,
				destAny: false,
				srcZone: null,
				destZone: egress ? this.zones[egress] : null,
				icmpType: [],
				wildcard: false,
				family: this.inferFamily(s, null, null).family,
				familyBy: this.inferFamily(s, null, null).by
			});
		});
	},

	/* NAT grouped by the zone whose chain orders it. */
	buildNatGroups() {
		const byZone = {};
		const bucket = (zone) => (byZone[zone] || (byZone[zone] = { dstnat: [], srcnat: [] }));

		for (const r of this.redirects.concat(this.nats)) {
			const z = r.chainZone || '';
			bucket(z)[r.hook].push(r);
		}

		for (const z in byZone) {
			byZone[z].dstnat.sort((a, b) => a.index - b.index);
			byZone[z].srcnat.sort((a, b) => a.index - b.index);
			/* Position within the real chain. A port forward is displayed
			 * beside the zone pair it targets, but it is ordered against every
			 * forward sharing its source zone — so it carries its true
			 * position, not its position in the slice shown. */
			byZone[z].dstnat.forEach((r, i) => { r.chainPos = i + 1; r.chainTotal = byZone[z].dstnat.length; });
			byZone[z].srcnat.forEach((r, i) => { r.chainPos = i + 1; r.chainTotal = byZone[z].srcnat.length; });
		}

		this.natByZone = byZone;
		return byZone;
	},

	parseForwardings() {
		uci.sections('firewall', 'forwarding', (s) => {
			this.forwardings.push({
				sid: s['.name'],
				src: s.src || null,
				dest: s.dest || null,
				enabled: isTrue(s.enabled, true)
			});
		});
	},

	parseDefaults() {
		const s = uci.get_first('firewall', 'defaults') || {};
		this.defaults = {
			input: (s.input || 'DROP').toUpperCase(),
			output: (s.output || 'ACCEPT').toUpperCase(),
			forward: (s.forward || 'REJECT').toUpperCase()
		};
	},

	hasForwarding(src, dest) {
		return this.forwardings.some(f => f.enabled && f.src == src && f.dest == dest);
	},

	/* What actually happens to a packet that matches nothing in this group.
	 * Verified against the compiled ruleset: a forward pair with no
	 * `config forwarding` does not hit the chain's nominal drop policy, it
	 * falls out of the zone chain and is REJECTed by handle_reject. */
	terminatorFor(srcName, destName) {
		if (destName === DEVICE) {
			const z = this.zones[srcName];
			return {
				verdict: z ? z.input : this.defaults.input,
				reason: z ? _('zone %s input policy').format(srcName) : _('firewall default input policy')
			};
		}

		if (srcName === DEVICE) {
			const z = this.zones[destName];
			return {
				verdict: z ? z.output : this.defaults.output,
				reason: z ? _('zone %s output policy').format(destName) : _('firewall default output policy')
			};
		}

		/* A zone's own forward policy is reached by `jump <policy>_to_<zone>`
		 * at the end of forward_<zone>, and that chain matches the zone's own
		 * oifname — so it only ever governs traffic staying inside the zone.
		 * It is not the fallback for zone-to-zone traffic, which is a common
		 * misreading of the stock UI. */
		if (srcName === destName) {
			const z = this.zones[srcName];
			return {
				verdict: z ? z.forward : this.defaults.forward,
				reason: _('zone %s forward policy — this governs traffic staying inside %s only')
					.format(srcName, srcName)
			};
		}

		if (this.hasForwarding(srcName, destName))
			return {
				verdict: 'ACCEPT',
				reason: _('zone forwarding %s → %s').format(srcName, destName)
			};

		/* With no `config forwarding` the packet falls out of the zone chain
		 * back to the parent forward chain. fw4 appends `jump handle_reject`
		 * there only when the default forward policy is reject; otherwise the
		 * chain's own policy applies. So the verdict is the *default* policy,
		 * never a fixed REJECT. */
		const dflt = this.defaults.forward;
		return {
			verdict: dflt,
			reason: (dflt === 'REJECT')
				? _('no forwarding %s → %s — falls through to the default forward policy (REJECT, via handle_reject)')
					.format(srcName, destName)
				: _('no forwarding %s → %s — falls through to the default forward policy (%s)')
					.format(srcName, destName, dflt)
		};
	},

	/* NAT belonging beside one zone pair.
	 *
	 * A port forward names both zones, so it lands beside exactly one pair.
	 * A NAT rule names only its egress zone, so it belongs after *every* pair
	 * ending there — the same rules shown in several places, which is why the
	 * view renders them collapsed and marked as shared.
	 */
	natForPair(srcName, destName) {
		const fromSrc = (this.natByZone[srcName] || {}).dstnat || [];
		const toDest = (this.natByZone[destName] || {}).srcnat || [];

		return {
			dnat: fromSrc.filter(r => (r.dest || null) === (destName === DEVICE ? null : destName)),
			snat: (destName === DEVICE) ? [] : toDest,
			dnatChain: 'dstnat_' + srcName,
			snatChain: 'srcnat_' + destName
		};
	},

	/* Port specs as ranges: "80", "80 443", "6881-6889" */
	portRanges(list) {
		const out = [];
		for (const spec of (list || [])) {
			for (const part of String(spec).split(/[\s,]+/)) {
				if (!part.length) continue;
				const m = /^(\d+)-(\d+)$/.exec(part);
				if (m) out.push([+m[1], +m[2]]);
				else if (/^\d+$/.test(part)) out.push([+part, +part]);
			}
		}
		return out;
	},

	portsOverlap(a, b) {
		const ra = this.portRanges(a), rb = this.portRanges(b);
		/* an unspecified port matches everything, so it overlaps anything */
		if (!ra.length || !rb.length) return true;
		return ra.some(x => rb.some(y => x[0] <= y[1] && y[0] <= x[1]));
	},

	addrsOverlap(a, b) {
		if (!a.length || !b.length) return true;
		for (const x of a) {
			const ax = parseAddr(x);
			if (!ax) return true;
			for (const y of b) {
				const ay = parseAddr(y);
				if (!ay) return true;
				if (addrContains(ax, ay) || addrContains(ay, ax)) return true;
			}
		}
		return false;
	},

	/* Two port forwards in the same dstnat chain that can match the same
	 * packet: the earlier one wins and the later never fires. This is the only
	 * thing rendering forwards beside their destination pair could hide, so it
	 * is detected rather than left to be noticed. Returns the *earlier* rules
	 * that would pre-empt this one. */
	conflictingForwards(rule) {
		if (rule.hook !== 'dstnat' || !rule.enabled) return [];

		const peers = ((this.natByZone[rule.chainZone] || {}).dstnat || [])
			.filter(r => r !== rule && r.enabled && r.index < rule.index);

		return peers.filter(p => {
			if (p.family && rule.family && p.family !== rule.family) return false;

			const pa = rule.proto.filter(x => x !== 'all');
			const pb = p.proto.filter(x => x !== 'all');
			if (pa.length && pb.length && !pa.some(x => pb.indexOf(x) >= 0)) return false;

			if (!this.portsOverlap(rule.srcPort, p.srcPort)) return false;
			if (!this.addrsOverlap(rule.srcIp, p.srcIp)) return false;

			return true;
		});
	},

	/* The end of a NAT chain. For srcnat the zone's own masquerade runs last
	 * if the zone has masq set — verified in the compiled srcnat_wan chain,
	 * which ends with "Masquerade IPv4 wan traffic" after the config nat
	 * rules. For dstnat nothing further happens: the packet is simply not
	 * translated. */
	natTerminatorFor(zoneName, hook, family) {
		const z = this.zones[zoneName];

		if (hook === 'srcnat') {
			/* masq and masq6 are separate zone options: fw4 emits
			 * `meta nfproto ipv4 masquerade` for masq alone, so a zone that
			 * masquerades IPv4 must not be shown as masquerading IPv6. */
			const on = (family === 6)
				? (z && isTrue(z.raw ? z.raw.masq6 : null, false))
				: (z && z.masq);

			if (on) {
				const scope = z.masqSrc.length || z.masqDest.length
					? _(' (only %s)').format(
						[].concat(
							z.masqSrc.length ? [_('from %s').format(z.masqSrc.join(', '))] : [],
							z.masqDest.length ? [_('to %s').format(z.masqDest.join(', '))] : []
						).join(', '))
					: '';
				return {
					verdict: 'MASQUERADE',
					reason: _('zone %s masquerades remaining IPv%d traffic%s')
						.format(zoneName, family === 6 ? 6 : 4, scope)
				};
			}
			return {
				verdict: 'NONE',
				reason: _('no source NAT — the address is left unchanged')
			};
		}

		return {
			verdict: 'NONE',
			reason: _('no destination NAT — the packet is not redirected')
		};
	},

	/* True when port forwards land in this destination zone: fw4 emits
	 * `ct status dnat accept` ahead of the zone policy, so DNAT'd traffic is
	 * accepted regardless of the rules above. A common surprise, so the view
	 * surfaces it. */
	hasDnatInto(destName) {
		return this.redirects.some(r => r.enabled && r.target == 'DNAT' && r.dest == destName);
	},

	/* Groups are a projection of the global ordered rule list. Wildcard rules
	 * appear in every group they can affect, as shadow copies of one section. */
	buildGroups() {
		this.orphans = [];
		const names = this.zoneOrder.slice();
		const groups = [];
		const seen = {};

		const add = (srcName, destName) => {
			const key = srcName + '|' + destName;
			if (seen[key]) return seen[key];

			const g = {
				key: key,
				src: srcName,
				dest: destName,
				isInput: destName === DEVICE,
				isOutput: srcName === DEVICE,
				rules: [],
				/* mangle/raw rules for this pair: real, but evaluated on a
				 * different hook, so they are never numbered in the filter
				 * sequence above them */
				otherRules: [],
				terminator: this.terminatorFor(srcName, destName),
				dnat: destName !== DEVICE && this.hasDnatInto(destName)
			};
			seen[key] = g;
			groups.push(g);
			return g;
		};

		/* every pair, so an empty one is visibly empty rather than absent */
		for (const s of names) {
			add(s, DEVICE);
			for (const d of names) add(s, d);
		}
		for (const d of names) add(DEVICE, d);

		for (const rule of this.rules) {
			let placed = 0;

			for (const g of groups) {
				if (!this.groupMatchesRule(g, rule)) continue;
				const bucket = this.isFilterKind(rule.chainKind) ? g.rules : g.otherRules;
				bucket.push({ rule: rule, shadow: rule.wildcard });
				placed++;
			}

			/* A rule that lands in no group would simply be absent from the
			 * page, which is the worst failure this view can have. Keep it
			 * visible and flagged rather than silently dropped. */
			if (!placed) this.orphans.push(rule);
		}

		/* keep every group in true global evaluation order */
		for (const g of groups) {
			g.rules.sort((a, b) => a.rule.index - b.rule.index);
			g.otherRules.sort((a, b) => a.rule.index - b.rule.index);
		}

		this.groups = groups;
		return groups;
	},

	/* ------------------------------------------------------------------
	 * Autocomplete sources
	 * ---------------------------------------------------------------- */

	parseHosts(hints) {
		const dnsmasq = uci.get_first('dhcp', 'dnsmasq');
		this.localDomain = (dnsmasq && dnsmasq.domain) ? dnsmasq.domain : 'lan';

		const seen = {};
		const push = (name, ip, origin) => {
			if (!ip) return;
			const key = name + '|' + ip;
			if (seen[key]) return;
			seen[key] = true;
			this.hosts.push({ name: name || null, ip: ip, addr: parseAddr(ip), origin: origin });
		};

		/* Static leases and DNS records come from uci, because getHostHints
		 * returns a configured host with a name but an *empty* ipaddrs array
		 * until it has actually appeared on the wire. */
		uci.sections('dhcp', 'host', (s) => {
			for (const ip of toArray(s.ip)) push(s.name || s.hostname, ip, 'static lease');
		});
		uci.sections('dhcp', 'domain', (s) => push(s.name, s.ip, 'DNS record'));
		uci.sections('dhcp', 'cname', (s) => push(s.cname, s.target, 'CNAME'));

		for (const mac in (hints || {})) {
			const h = hints[mac];
			for (const ip of (h.ipaddrs || [])) push(h.name, ip, 'lease/neighbour');
			for (const ip of (h.ip6addrs || [])) push(h.name, ip, 'lease/neighbour');
		}

		for (const name in this.interfaces) {
			for (const sn of this.interfaces[name].subnets) {
				if (sn.family != 4) continue;
				const o = [24, 16, 8, 0].map(sh => (sn.addr >>> sh) & 255).join('.');
				push(name, o + '/' + sn.bits, 'interface');
			}
		}
	},

	/* /etc/services covers the common cases but is not complete — it has no
	 * 3389, and the lab already carries an RDP rule. The built-in table below
	 * fills the gaps rather than leaving such a rule unnameable. */
	parseServices(text) {
		const byPort = {};

		for (const line of String(text || '').split(/\n/)) {
			const l = line.replace(/#.*$/, '').trim();
			if (!l.length) continue;
			const m = /^(\S+)\s+(\d+)\/(tcp|udp)/.exec(l);
			if (!m) continue;
			const key = m[2] + '/' + m[3];
			if (!byPort[key]) byPort[key] = { name: m[1], port: +m[2], proto: m[3] };
		}

		const extra = [
			['ms-wbt-server', 3389, 'tcp'], ['rdp', 3389, 'tcp'],
			['mysql', 3306, 'tcp'], ['postgresql', 5432, 'tcp'],
			['ldap', 389, 'tcp'], ['ldaps', 636, 'tcp'],
			['submissions', 465, 'tcp'], ['submission', 587, 'tcp'],
			['imaps', 993, 'tcp'], ['pop3s', 995, 'tcp'],
			['microsoft-ds', 445, 'tcp'], ['openvpn', 1194, 'udp'],
			['wireguard', 51820, 'udp'], ['node-exporter', 9100, 'tcp'],
			['syslog', 514, 'udp'], ['snmp', 161, 'udp'],
			['http-alt', 8080, 'tcp'], ['https-alt', 8443, 'tcp']
		];

		for (const [name, port, proto] of extra) {
			const key = port + '/' + proto;
			if (!byPort[key]) byPort[key] = { name: name, port: port, proto: proto };
		}

		this.services = Object.keys(byPort).map(k => byPort[k]);
		this.servicesByPort = byPort;
	},

	/* Options that carry a match condition but are not in the default column
	 * set. A rule using any of these must never render as though it were
	 * simpler than it is, so the view marks it. */
	extraCriteria(rule) {
		const keys = [
			'src_port', 'src_mac', 'icmp_type', 'ipset', 'helper', 'set_helper',
			'mark', 'set_mark', 'set_xmark', 'dscp', 'set_dscp', 'device',
			'direction', 'limit', 'limit_burst', 'extra', 'utc_time',
			'start_date', 'stop_date', 'start_time', 'stop_time',
			'weekdays', 'monthdays'
		];
		const out = [];
		for (const k of keys) {
			const v = rule.raw ? rule.raw[k] : null;
			if (v == null || v === '') continue;
			out.push({ key: k, value: Array.isArray(v) ? v.join(' ') : String(v) });
		}
		return out;
	},

	/* Every name known for an address, most authoritative first.
	 *
	 * An address can carry several names — one nginx serving several sites is
	 * the ordinary case — and they arrive from different places, so the same
	 * host often appears twice in different forms: `nginx` from a config
	 * domain record and `nginx.lan` from the neighbour table. Those are one
	 * name, not two, so comparison strips the configured local domain before
	 * deduplicating. A name in another domain (www.tinypixelmapper.com) is left alone.
	 */
	namesFor(ip) {
		if (!ip) return [];

		const local = (this.localDomain || '').toLowerCase();
		const key = (n) => {
			let k = String(n).toLowerCase();
			if (local && k.endsWith('.' + local))
				k = k.slice(0, -(local.length + 1));
			return k;
		};

		const out = [], seen = {};
		for (const h of this.hosts) {
			if (h.ip !== ip || !h.name) continue;
			const k = key(h.name);
			if (seen[k]) continue;
			seen[k] = true;
			out.push(h.name);
		}
		return out;
	},

	serviceName(port, proto) {
		const p = this.servicesByPort || {};
		const hit = p[port + '/' + (proto || 'tcp')] || p[port + '/tcp'] || p[port + '/udp'];
		return hit ? hit.name : null;
	}
});

return baseclass.extend({
	DEVICE: DEVICE,
	ANY: ANY,
	parseAddr: parseAddr,
	addrContains: addrContains,

	load() {
		return (new Model()).load();
	}
});
