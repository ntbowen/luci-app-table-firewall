#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Gerhard Mautendorfer (MaidByC)
/* Verify model.js against the lab box's real config and compiled ruleset.
 *
 * The interesting assertion is the last one: for every rule, the chain the
 * model computes must equal the chain nftables actually put it in. fw4 tags
 * each emitted rule with a `!fw4: <name>` comment, so the compiled ruleset can
 * be read back as ground truth rather than trusting our reimplementation of
 * fw4's chain selection.
 *
 * Usage: node scripts/test-model.js [fixtureDir]
 */

'use strict';
const fs = require('fs');
const path = require('path');

const FIX = process.argv[2] || process.env.TF_FIXTURES || path.join(__dirname, '..', 'test', 'fixtures');


const read = f => fs.readFileSync(path.join(FIX, f), 'utf8');
const readJSON = f => JSON.parse(read(f));

/* ---- minimal LuCI environment ------------------------------------------ */

const configs = {
	firewall: readJSON('uci-firewall.json').values,
	network: readJSON('uci-network.json').values,
	dhcp: readJSON('uci-dhcp.json').values
};

const uci = {
	load: () => Promise.resolve(),
	sections(config, type, cb) {
		const all = configs[config] || {};
		const out = Object.keys(all)
			.map(k => all[k])
			.filter(s => !type || s['.type'] === type)
			.sort((a, b) => (a['.index'] | 0) - (b['.index'] | 0));
		if (cb) out.forEach(cb);
		return out;
	},
	get_first(config, type) {
		return this.sections(config, type)[0] || null;
	}
};

const rpcResults = {
	getHostHints: readJSON('hosthints.json'),
	dump: readJSON('ifdump.json').interface
};

const rpc = {
	declare: (opts) => () => Promise.resolve(rpcResults[opts.method])
};

const fsMod = { read: (p) => Promise.resolve(p === '/etc/services' ? read('services.txt') : '') };

const baseclass = {
	extend(proto) {
		function C() { if (this.__init__) this.__init__.apply(this, arguments); }
		C.prototype = Object.create(proto);
		C.prototype.constructor = C;
		Object.assign(C, proto);
		return C;
	}
};

function _(s) { return s; }
String.prototype.format = function (...a) {
	let i = 0;
	return this.replace(/%[sd%]/g, m => (m === '%%' ? '%' : String(a[i++])));
};

/* ---- load model.js ------------------------------------------------------ */

const BASE = process.env.TF_SRC || path.join(__dirname, '..',
	'luci-app-table-firewall', 'htdocs/luci-static/resources');

/* Strip the leading run of quoted directives, as luci.js does. A line-based
   strip misses a minified prologue, where they all share one line. */
const src = fs.readFileSync(path.join(BASE, 'table-firewall/model.js'), 'utf8')
	.replace(/^(?:\s*'(?:use strict|require [^']*)';)+/, '');

const factory = new Function('baseclass', 'uci', 'rpc', 'fs', '_',
	'"use strict";' + src);
const model = factory(baseclass, uci, rpc, fsMod, _);

/* ---- ground truth from the compiled ruleset ----------------------------- */

function chainsFromNft() {
	const map = {};                       /* rule name -> Set(chain) */
	let chain = null;
	for (const line of read('nft.txt').split('\n')) {
		const c = /^\s*chain\s+(\S+)\s*\{/.exec(line);
		if (c) { chain = c[1]; continue; }
		if (/^\s*\}/.test(line)) { chain = null; continue; }
		const m = /comment "!fw4:\s*(.+?)"/.exec(line);
		if (chain && m) (map[m[1]] || (map[m[1]] = new Set())).add(chain);
	}
	return map;
}

/* ---- run ---------------------------------------------------------------- */

let pass = 0, fail = 0;
const check = (ok, label, detail) => {
	if (ok) { pass++; }
	else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};

model.load().then(m => {
	console.log('=== parsed ===');
	console.log('zones      :', m.zoneOrder.join(', '));
	console.log('rules      :', m.rules.length);
	console.log('redirects  :', m.redirects.length);
	console.log('forwardings:', m.forwardings.length);
	console.log('hosts      :', m.hosts.length);
	console.log('services   :', m.services.length);
	console.log('groups     :', m.groups.length,
		'(non-empty: ' + m.groups.filter(g => g.rules.length).length + ')');

	console.log('\n=== address containment ===');
	const A = model.parseAddr, C = model.addrContains;
	check(C(A('10.10.10.0/24'), A('10.10.10.10')), '10.10.10.10 in 10.10.10.0/24');
	check(!C(A('10.10.10.0/24'), A('10.10.20.10')), '10.10.20.10 not in 10.10.10.0/24');
	check(C(A('0.0.0.0/0'), A('8.8.8.8')), 'default route contains 8.8.8.8');
	check(C(A('192.168.199.0/255.255.255.0'), A('192.168.199.36')), 'dotted netmask form');
	check(!C(A('10.0.0.0/8'), A('fe80::1')), 'v4 net does not contain a v6 address');
	check(C(A('fe80::/10'), A('fe80::aff:fe63:1')), 'v6 containment');
	check(C(A('2001:db8::/32'), A('2001:db8:1:2::5')), 'v6 containment across words');
	check(!C(A('2001:db8::/32'), A('2001:db9::5')), 'v6 non-containment');

	console.log('\n=== service names ===');
	check(m.serviceName(22, 'tcp') === 'ssh', 'port 22 resolves to ssh');
	check(m.serviceName(25, 'tcp') === 'smtp', 'port 25 resolves to smtp');
	check(!!m.serviceName(3389, 'tcp'), 'port 3389 nameable (absent from /etc/services)',
		'got ' + m.serviceName(3389, 'tcp'));

	console.log('\n=== host autocomplete ===');
	const byName = n => m.hosts.filter(h => h.name === n);
	check(byName('web01').some(h => h.ip === '10.10.10.10'), 'web01 has its static-lease IP');
	check(byName('www.tinypixelmapper.com').some(h => h.ip === '192.168.199.36'),
		'DNS record from config domain is present');

	console.log('\n=== several names for one address ===');
	const n10 = m.namesFor('10.10.10.10');
	check(n10.length >= 3, 'every name for an address is returned, not just the first',
		n10.join(', '));
	check(n10.indexOf('web01') >= 0 && n10.indexOf('nginx') >= 0 &&
		n10.indexOf('nginx2') >= 0, 'all three are present', n10.join(', '));

	/* `nginx` and `nginx.lan` are one host seen twice, not two names */
	check(!n10.some(x => x.toLowerCase() === 'nginx.lan'),
		'the local-domain form is deduplicated against the short form',
		n10.join(', '));

	check(m.namesFor('10.10.10.20').join() === 'mail01',
		'an address with one name still returns just it',
		m.namesFor('10.10.10.20').join());
	check(m.namesFor('203.0.113.99').length === 0,
		'an unknown address returns nothing');

	/* a name in another domain must not be stripped */
	check(m.namesFor('192.168.199.36').indexOf('www.tinypixelmapper.com') >= 0,
		'an FQDN outside the local domain is kept whole',
		m.namesFor('192.168.199.36').join(', '));

	console.log('\n=== family inference ===');
	const byRule = n => m.rules.find(r => r.name === n);
	const icmp6 = byRule('Allow-ICMPv6-Forward');
	check(icmp6 && icmp6.family === 6, 'Allow-ICMPv6-Forward is IPv6', icmp6 && icmp6.familyBy);
	const web = byRule('Allow-LAN-Web');
	check(web && web.family === 0, 'Allow-LAN-Web is dual-stack', web && web.familyBy);
	const pub = byRule('Pub-Web-HTTP');
	check(pub && pub.family === 4, 'Pub-Web-HTTP inferred IPv4 from dest_ip', pub && pub.familyBy);

	console.log('\n=== wildcard handling ===');
	check(icmp6 && icmp6.wildcard, 'dest=* rule flagged as wildcard');
	const shadowGroups = m.groups.filter(g => g.rules.some(e => e.shadow));
	check(shadowGroups.length > 1, 'wildcard rule shadowed into multiple groups',
		shadowGroups.length + ' group(s)');
	check(shadowGroups.every(g => g.src === 'wan'),
		'shadows confined to the wildcard rule\'s source zone');

	console.log('\n=== wildcard placement respects the chain ===');
	/* dest='*' is a forward rule: it can never affect traffic to the device,
	   so it must not appear in an input group */
	const wc = m.rules.find(r => r.name === 'Allow-ICMPv6-Forward');
	const inGroups = m.groups.filter(g => g.rules.some(e => e.rule === wc));
	check(inGroups.length > 0, 'wildcard rule is shadowed somewhere', inGroups.length + '');
	check(inGroups.every(g => !g.isInput),
		'and never into an input group',
		inGroups.filter(g => g.isInput).map(g => g.key).join(',') || 'none');
	check(inGroups.every(g => g.src === 'wan'),
		'confined to its own source zone');

	/* a src='*' input rule must land in every input group, not vanish */
	const synth = Object.assign({}, m.rules[0], {
		name: 'SYNTH-any-src-input', src: '*', dest: null,
		srcAny: true, destAny: false, wildcard: true,
		chainKind: 'input', chain: 'input', index: 999
	});
	const hits = m.groups.filter(g => m.groupMatchesRule(g, synth));
	check(hits.length > 0, "src='*' input rule matches groups", hits.length + '');
	check(hits.every(g => g.isInput), 'and only input groups');
	check(hits.length === m.zoneOrder.length,
		'one per source zone', hits.length + ' vs ' + m.zoneOrder.length);

	check(m.orphans.length === 0, 'no rule was dropped from every group',
		m.orphans.map(r => r.name).join(','));

	console.log('\n=== chain terminators ===');
	const t1 = m.terminatorFor('DMZ', model.DEVICE);
	check(t1.verdict === 'DROP', 'DMZ -> device ends at zone input policy DROP', t1.verdict);
	const t2 = m.terminatorFor('lan', 'DMZ');
	check(t2.verdict === 'ACCEPT', 'lan -> DMZ ends at its config forwarding', t2.verdict);
	const t3 = m.terminatorFor('DMZ', 'MGMT_DMZ');
	check(t3.verdict === 'REJECT', 'DMZ -> MGMT_DMZ (no forwarding) rejects, not drops', t3.verdict);

	/* The fallback is the *default* forward policy, not a fixed REJECT: fw4
	   only appends `jump handle_reject` when that policy is reject, otherwise
	   the parent chain's own policy applies. */
	const savedFwd = m.defaults.forward;
	for (const p of ['DROP', 'ACCEPT', 'REJECT']) {
		m.defaults.forward = p;
		check(m.terminatorFor('DMZ', 'MGMT_DMZ').verdict === p,
			'an undefined pair follows the default forward policy (' + p + ')',
			m.terminatorFor('DMZ', 'MGMT_DMZ').verdict);
	}
	m.defaults.forward = savedFwd;

	/* A zone's own forward policy governs intra-zone traffic only. */
	const intra = m.terminatorFor('lan', 'lan');
	check(intra.verdict === m.zones.lan.forward,
		'intra-zone uses the zone forward policy', intra.verdict);
	check(/inside/.test(intra.reason),
		'and says so, since the stock UI reads as though it were the pair fallback',
		intra.reason);

	console.log('\n=== NAT parsing and grouping ===');
	check(m.nats.length === 3, 'config nat sections parsed', m.nats.length + '');
	check(m.redirects.length === 6, 'config redirect sections parsed', m.redirects.length + '');
	const masq = m.nats.find(n => n.target === 'MASQUERADE');
	check(masq && masq.chain === 'srcnat_wan',
		'a nat rule is ordered in srcnat_<src>', masq && masq.chain);
	const dnat = m.redirects.find(r => r.kind === 'dnat');
	check(dnat && dnat.chain === 'dstnat_wan',
		'a port forward is ordered in dstnat_<src>', dnat && dnat.chain);
	check(m.redirects.every(r => r.chainZone === r.src || r.target === 'SNAT'),
		'port forwards are keyed by source zone');
	/* config nat's `src` option is the egress zone: srcnat dispatches on
	   oifname, and stock LuCI reads it as the destination while showing the
	   source as "any zone". The model presents it that way round. */
	check(m.nats.every(n => n.src === model.ANY),
		'a NAT rule has no constrained source zone',
		m.nats.map(n => n.src).join(','));
	check(m.nats.every(n => n.dest === 'wan'),
		'and its egress zone is presented as the destination',
		m.nats.map(n => n.dest).join(','));
	check(m.nats.every(n => n.chain === 'srcnat_' + n.dest),
		'which is the zone whose srcnat chain orders it');

	console.log('\n=== NAT beside a zone pair ===');
	const pair = m.natForPair('wan', 'DMZ');
	check(pair.dnat.length === 4, 'port forwards land beside the pair they target',
		pair.dnat.length + '');
	check(pair.dnat.every(r => r.dest === 'DMZ'), 'and only those');
	check(m.natForPair('wan', 'production').dnat.length === 2,
		'the other pair gets the rest');
	check(pair.dnat.every(r => r.chainTotal === 6),
		'each still knows its true chain length', 'chainTotal');
	check(pair.dnat.map(r => r.chainPos).join() === '1,2,3,4',
		'and its true position in dstnat_wan', pair.dnat.map(r => r.chainPos).join());

	const toWan = m.natForPair('lan', 'wan');
	check(toWan.snat.length === 3, 'NAT rules appear after every pair ending in wan',
		toWan.snat.length + '');
	check(m.natForPair('DMZ', 'wan').snat.length === 3, 'the same set, shared');
	check(m.natForPair('lan', 'DMZ').snat.length === 0,
		'and not after a pair ending elsewhere');

	console.log('\n=== shadowed port forwards ===');
	check(m.redirects.every(r => m.conflictingForwards(r).length === 0),
		'the seeded forwards do not shadow each other',
		m.redirects.filter(r => m.conflictingForwards(r).length)
			.map(r => r.name).join(','));

	/* synthetic: a later forward on a port an earlier one already takes */
	{
		const first = m.redirects.find(r => r.srcPort.join() === '80');
		const clone = Object.assign({}, first, {
			name: 'SYNTH-later', index: 999, dest: 'production'
		});
		((m.natByZone['wan'] || {}).dstnat || []).push(clone);
		const clash = m.conflictingForwards(clone);
		check(clash.length >= 1, 'a later forward on a taken port is detected',
			clash.map(c => c.name).join(','));
		check(m.conflictingForwards(first).length === 0,
			'and the earlier one is not blamed');

		/* a disjoint port must not be flagged */
		const other = Object.assign({}, first, {
			name: 'SYNTH-disjoint', index: 998, srcPort: ['9999']
		});
		check(m.conflictingForwards(other).length === 0,
			'a forward on a free port is not flagged');

		/* ranges must be compared as ranges, not strings */
		check(m.portsOverlap(['80 443'], ['443']), 'port lists overlap by value');
		check(m.portsOverlap(['6881-6889'], ['6885']), 'ranges contain single ports');
		check(!m.portsOverlap(['80'], ['443']), 'and disjoint ports do not overlap');
		((m.natByZone['wan'] || {}).dstnat || []).pop();
	}

	console.log('\n=== masquerade is family-aware ===');
	const t4 = m.natTerminatorFor('wan', 'srcnat', 4);
	const t6 = m.natTerminatorFor('wan', 'srcnat', 6);
	check(t4.verdict === 'MASQUERADE', 'wan masquerades IPv4', t4.verdict);
	check(t6.verdict === 'NONE',
		'but not IPv6 — masq and masq6 are separate options', t6.verdict);
	check(m.natTerminatorFor('lan', 'srcnat', 4).verdict === 'NONE',
		'a zone without masq says so');

	const wan = m.natByZone['wan'];
	check(!!wan, 'wan has a NAT bucket');
	check(wan.dstnat.length === 6 && wan.srcnat.length === 3,
		'grouped per hook under the source zone',
		'dstnat=' + wan.dstnat.length + ' srcnat=' + wan.srcnat.length);
	check(wan.dstnat.map(r => r.index).join() ===
		wan.dstnat.map(r => r.index).sort((a, b) => a - b).join(),
		'kept in config order');

	console.log('\n=== model chain vs compiled nftables chain ===');
	const truth = chainsFromNft();
	let checked = 0, mismatched = 0;

	/* NAT rules are ground-truthed the same way as filter rules */
	for (const r of m.redirects.concat(m.nats)) {
		if (!r.enabled) continue;
		const actual = truth[r.name];
		if (!actual) continue;
		checked++;
		if (!actual.has(r.chain)) {
			mismatched++;
			console.log('  FAIL ' + r.name + ': model=' + r.chain +
				' actual=' + Array.from(actual).join(','));
		}
	}

	for (const r of m.rules) {
		if (!r.enabled) continue;                 /* disabled rules are not emitted */
		const actual = truth[r.name];
		if (!actual) continue;                    /* not emitted for this family */
		checked++;
		if (!actual.has(r.chain)) {
			mismatched++;
			console.log('  FAIL ' + r.name + ': model=' + r.chain +
				' actual=' + Array.from(actual).join(','));
		}
	}
	check(checked > 40, 'compared a meaningful number of rules', checked + ' compared');
	check(mismatched === 0, 'every rule lands in the chain nftables used',
		mismatched + ' mismatch(es)');

	console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed');
	process.exit(fail ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });
