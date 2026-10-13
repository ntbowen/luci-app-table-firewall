'use strict';
'require baseclass';
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Gerhard Mautendorfer (MaidByC)

/* Search for the rules table.
 *
 * The defining constraint: this never filters. It reports which rules matched
 * and which cells matched, and the view highlights them while leaving every
 * other rule fully visible. A firewall rule's meaning depends on what precedes
 * it, so hiding context would let the UI show a rule that never fires.
 */

return baseclass.extend({
	/* Build the autocomplete vocabulary once per model load. */
	suggestions(model) {
		const out = [];
		const seen = {};
		const push = (value, hint) => {
			if (!value || seen[value]) return;
			seen[value] = true;
			out.push({ value: value, hint: hint });
		};

		for (const z of model.zoneOrder) push(z, _('zone'));

		for (const h of model.hosts) {
			if (h.name) push(h.name, h.ip);
			push(h.ip, h.name || h.origin);
		}

		for (const s of model.services)
			push(s.name, s.port + '/' + s.proto);

		for (const t of ['ACCEPT', 'REJECT', 'DROP', 'MARK', 'NOTRACK'])
			push(t, _('action'));

		for (const p of ['tcp', 'udp', 'icmp', 'icmpv6', 'all'])
			push(p, _('protocol'));

		return out;
	},

	/* A term is one of: an address/CIDR, a port number, a service name, or
	 * free text. Hostnames and IP literals are both dotted, so an address is
	 * recognised by parsing it rather than by looking for dots. */
	classify(model, term) {
		const addr = model.parseAddr ? model.parseAddr(term) : null;
		if (addr) return { kind: 'addr', addr: addr, text: term };
		if (/^\d{1,5}$/.test(term)) return { kind: 'port', port: +term, text: term };
		return { kind: 'text', text: term.toLowerCase() };
	},

	parse(model, query) {
		const terms = String(query || '').trim().split(/\s+/).filter(t => t.length);
		return terms.map(t => this.classify(model, t));
	},

	/* Returns a map sid -> Set(columnKey) of the cells that matched, or null
	 * when the rule does not match at all. Every term must match somewhere
	 * (AND), which is what makes "lan 22" useful. */
	match(model, rule, terms, api) {
		if (!terms.length) return null;

		const hits = new Set();
		const textOf = {
			name: (rule.name || '').toLowerCase(),
			src: (rule.src || '').toLowerCase(),
			dest: (rule.dest || '').toLowerCase(),
			target: (rule.target || '').toLowerCase(),
			service: rule.proto.join(' ').toLowerCase()
		};

		for (const term of terms) {
			let matched = false;

			if (term.kind === 'addr') {
				/* subnet-aware both ways: searching a host finds the rule
				 * scoped to its subnet, and searching a subnet finds rules
				 * naming hosts inside it. */
				for (const [key, list] of [['src_ip', rule.srcIp], ['dest_ip', rule.destIp]]) {
					for (const v of list) {
						const a = api.parseAddr(v);
						if (!a) continue;
						if (api.addrContains(a, term.addr) || api.addrContains(term.addr, a)) {
							hits.add(key); matched = true;
						}
					}
				}
				/* Deliberately NOT matching "this address lives in that zone's
				   subnet". It reads as helpful and is actively misleading:
				   searching one host in the DMZ matched 18 rules on the lab
				   config, of which only 2 named the address — every rule
				   merely referencing the DMZ zone lit up, including ones with
				   no address criteria at all. A search box answers "which
				   rules mention this?"; "which rules would affect traffic
				   from this host?" is a different question, and the one Rules
				   Walk exists to answer. */
			}
			else if (term.kind === 'port') {
				if (this.portListMatches(rule.destPort, term.port)) { hits.add('service'); matched = true; }
				if (this.portListMatches(rule.srcPort, term.port)) { hits.add('src_port'); matched = true; }
			}

			/* text always considered too, so "22" also matches a rule named
			 * "SSH-22" and a service name resolves to its port */
			if (term.kind === 'text' || !matched) {
				const t = term.text.toLowerCase();

				for (const key in textOf) {
					if (textOf[key].indexOf(t) >= 0) { hits.add(key); matched = true; }
				}

				for (const v of rule.srcIp)
					if (v.toLowerCase().indexOf(t) >= 0) { hits.add('src_ip'); matched = true; }
				for (const v of rule.destIp)
					if (v.toLowerCase().indexOf(t) >= 0) { hits.add('dest_ip'); matched = true; }

				/* service name -> port */
				const svc = model.services.filter(s => s.name.toLowerCase() === t);
				for (const s of svc) {
					if (this.portListMatches(rule.destPort, s.port)) { hits.add('service'); matched = true; }
				}

				/* host name -> address */
				for (const h of model.hosts) {
					if (!h.name || h.name.toLowerCase().indexOf(t) < 0 || !h.addr) continue;
					for (const [key, list] of [['src_ip', rule.srcIp], ['dest_ip', rule.destIp]]) {
						for (const v of list) {
							const a = api.parseAddr(v);
							if (a && api.addrContains(a, h.addr)) { hits.add(key); matched = true; }
						}
					}
				}
			}

			if (!matched) return null;      /* every term must match somewhere */
		}

		return hits;
	},

	/* fw4 port specs: "22", "80 443", "6881-6889" */
	portListMatches(list, port) {
		for (const spec of (list || [])) {
			for (const part of String(spec).split(/[\s,]+/)) {
				const range = /^(\d+)-(\d+)$/.exec(part);
				if (range) {
					if (port >= +range[1] && port <= +range[2]) return true;
				}
				else if (+part === port) return true;
			}
		}
		return false;
	}
});
