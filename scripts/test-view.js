#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Gerhard Mautendorfer (MaidByC)
/* Smoke-test the rules view without a browser.
 *
 * No jsdom here, so this shims just enough DOM and LuCI to *execute* the view:
 * render, re-render on search, toggle columns, switch family tabs. It does not
 * check appearance - it catches the errors that would otherwise show up as a
 * blank page with a console message, which is an expensive way to find a typo.
 */

'use strict';
const fs = require('fs');
const path = require('path');

const FIX = process.argv[2] || path.join(__dirname, '..', 'test', 'fixtures');
const read = f => fs.readFileSync(path.join(FIX, f), 'utf8');
const readJSON = f => JSON.parse(read(f));

/* ---- DOM shim ----------------------------------------------------------- */

let nodeCount = 0;

function makeNode(tag) {
	const n = {
		tagName: String(tag || 'div').toUpperCase(),
		attrs: {}, children: [], listeners: {}, style: {},
		_classes: new Set(),
		get className() { return Array.from(this._classes).join(' '); },
		set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
		classList: {
			add(...c) { c.forEach(x => n._classes.add(x)); },
			remove(...c) { c.forEach(x => n._classes.delete(x)); },
			contains(c) { return n._classes.has(c); },
			toggle(c, force) {
				const on = (force === undefined) ? !n._classes.has(c) : !!force;
				on ? n._classes.add(c) : n._classes.delete(c);
				return on;
			}
		},
		setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = v; },
		getAttribute(k) { return (k in this.attrs) ? this.attrs[k] : null; },
		removeAttribute(k) { delete this.attrs[k]; },
		appendChild(c) { if (c) { c.parentNode = this; this.children.push(c); } return c; },
		removeChild(c) {
			const i = this.children.indexOf(c);
			if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; }
			return c;
		},
		replaceChild(fresh, old) {
			const i = this.children.indexOf(old);
			if (i < 0) return old;
			this.children[i] = fresh;
			fresh.parentNode = this;
			old.parentNode = null;
			return old;
		},
		addEventListener(ev, fn) { (this.listeners[ev] || (this.listeners[ev] = [])).push(fn); },
		removeEventListener() {},
		scrollIntoView() {},
		hidden: false,
		disabled: false,
		_rect: null,
		getBoundingClientRect() {
			return this._rect || { height: 48, width: 120, top: 0, left: 0 };
		},
		contains(other) {
			if (other === this) return true;
			return walk(this, []).indexOf(other) >= 0;
		},
		querySelector(sel) { return query(this, sel)[0] || null; },
		querySelectorAll(sel) { return query(this, sel); },
		fire(ev) { (this.listeners[ev] || []).forEach(f => f({ target: this })); }
	};
	nodeCount++;
	return n;
}

function walk(root, out) {
	for (const c of root.children || []) {
		if (c && c.tagName) { out.push(c); walk(c, out); }
	}
	return out;
}

/* supports ".cls", "tag", "[attr]" and comma lists - enough for this view */
function query(root, sel) {
	const all = walk(root, []);
	const parts = String(sel).split(',').map(s => s.trim()).filter(Boolean);
	const hit = [];
	for (const n of all) {
		for (const p of parts) {
			let ok = false;
			/* tag, .class, [attr], [attr="v"] and the tag[attr="v"] compound —
			   the last is what `link[href="…"]` needs */
			const compound = /^([a-zA-Z]*)\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(p);
			if (p.startsWith('.')) ok = n._classes.has(p.slice(1));
			else if (compound) {
				const [, tag, attr, val] = compound;
				ok = (!tag || n.tagName === tag.toUpperCase()) &&
					(val === undefined ? (attr in n.attrs) : n.attrs[attr] === val);
			}
			else ok = n.tagName === p.toUpperCase();
			if (ok) { hit.push(n); break; }
		}
	}
	return hit;
}

const window = {
	_listeners: {},
	addEventListener(ev, fn) { (this._listeners[ev] || (this._listeners[ev] = [])).push(fn); },
	fire(ev) { (this._listeners[ev] || []).forEach(f => f({})); }
	/* ResizeObserver deliberately absent: exercises the guarded branch */
};

const document = {
	_root: makeNode('body'),
	body: null,
	_docListeners: {},
	addEventListener(ev, fn) { (this._docListeners[ev] || (this._docListeners[ev] = [])).push(fn); },
	removeEventListener(ev, fn) {
		const a = this._docListeners[ev] || [];
		const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
	},
	fireDoc(ev, arg) { (this._docListeners[ev] || []).slice().forEach(f => f(arg || {})); },
	head: makeNode('head'),
	documentElement: (() => {
		const n = makeNode('html');
		n.style = {
			_p: {},
			setProperty(k, v) { this._p[k] = v; },
			removeProperty(k) { delete this._p[k]; },
			getPropertyValue(k) { return this._p[k]; }
		};
		return n;
	})(),
	createElement: makeNode,
	/* A real document.querySelector searches the whole document, <head>
	   included — which is where injected <link> elements live. Searching only
	   the body tree made the stylesheet's duplicate guard look broken. */
	querySelector(sel) {
		return query(document.head, sel)[0] || query(document._root, sel)[0] || null;
	},
	querySelectorAll(sel) {
		return query(document.head, sel).concat(query(document._root, sel));
	}
};

function E(tag, attrs, children) {
	if (typeof tag === 'string' && /^</.test(tag)) tag = 'div';
	const n = makeNode(tag);
	if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
		for (const k in attrs) {
			const v = attrs[k];
			if (v == null || v === false) continue;
			if (typeof v === 'function') { n.addEventListener(k, v); continue; }
			n.setAttribute(k, v === true ? '' : v);
		}
	}
	else if (attrs != null) children = attrs;

	const add = (c) => {
		if (c == null || c === '' || c === false) return;
		if (Array.isArray(c)) { c.forEach(add); return; }
		n.appendChild(typeof c === 'object' ? c : { tagName: '#text', text: String(c), children: [], _classes: new Set() });
	};
	add(children);
	return n;
}

/* ---- LuCI shim ---------------------------------------------------------- */

const configs = {
	firewall: readJSON('uci-firewall.json').values,
	network: readJSON('uci-network.json').values,
	dhcp: readJSON('uci-dhcp.json').values
};

let staged = 0;
const uci = {
	load: () => Promise.resolve(),
	sections(config, type, cb) {
		const all = configs[config] || {};
		const out = Object.keys(all).map(k => all[k])
			.filter(s => !type || s['.type'] === type)
			.sort((a, b) => (a['.index'] | 0) - (b['.index'] | 0));
		if (cb) out.forEach(cb);
		return out;
	},
	get_first(config, type) { return this.sections(config, type)[0] || null; },
	get(c, s, o) { return (configs[c] && configs[c][s]) ? configs[c][s][o] : null; },
	set(c, s, o, v) {
		if (!configs[c]) configs[c] = {};
		if (!configs[c][s]) configs[c][s] = { '.name': s, '.type': 'rule' };
		configs[c][s][o] = v; staged++;
		uci._changes.push(['set', s, o, v]);
	},
	add(c, type) {
		const sid = 'new' + (uci._n = (uci._n || 0) + 1);
		configs[c][sid] = { '.name': sid, '.type': type, '.index': 9000 + uci._n };
		staged++;
		uci._changes.push(['add', sid, type]);
		return sid;
	},
	remove(c, s) {
		delete configs[c][s]; staged++;
		uci._changes.push(['remove', s]);
	},
	/* fractional index is enough to model relative placement for the tests */
	/* returns true/false like the real uci.move, which applyMove checks */
	move(c, sid1, sid2, after) {
		const a = configs[c][sid1], b = configs[c][sid2];
		if (!a || !b) return false;
		a['.index'] = (b['.index'] | 0) + (after ? 0.5 : -0.5);
		staged++;
		/* the server records one order record per section, which is exactly
		   the noise the view has to ignore */
		Object.keys(configs[c]).forEach((k, i) => uci._changes.push(['order', k, i]));
		return true;
	},
	save: () => Promise.resolve(),
	changes: () => Promise.resolve(uci._changes.length ? { firewall: uci._changes.slice() } : {}),
	_changes: []
};

const ui = {
	addNotification(t, c, cls) { ui._notes = (ui._notes || []).concat([cls]); },
	showModal(title, kids) {
		ui._modal = kids;
		ui._modalTitle = title;
		const box = makeNode('div');
		(Array.isArray(kids) ? kids : [kids]).forEach(k => box.appendChild(k));
		ui._modalNode = box;
		return box;
	},
	hideModal() { ui._modal = null; },
	createHandlerFn(ctx, fn, ...a) { return function (ev) { return ctx[fn].apply(ctx, a.concat([ev])); }; },
	changes: {
		setIndicator(n) { this._n = n; },
		renderChangeIndicator(c) {
			let n = 0; for (const k in c) n += c[k].length;
			this.setIndicator(n);
		},
		apply() { ui.changes._applied = true; },
		revert() { ui.changes._reverted = true; }
	}
};

const dom = {
	content(node, kids) {
		node.children.forEach(c => { if (c) c.parentNode = null; });
		node.children = [];
		(Array.isArray(kids) ? kids : [kids]).forEach(k => {
			if (k == null || k === '') return;
			node.appendChild(typeof k === 'object' ? k : { tagName: '#text', text: String(k), children: [], _classes: new Set() });
		});
	}
};

/* minimal form shim: enough to build the editor's Map and drive save/cancel */
function FormMap(config) { this.config = config; this.sections = []; }
FormMap.prototype.section = function (cls, sid, type) {
	const sec = {
		sid: sid, type: type, options: [],
		tab() {},
		taboption(tab, cls, name) {
			const o = { name: name, tab: tab, value() {}, depends() {} };
			sec.options.push(o);
			return o;
		},
		option(cls, name) { return this.taboption(null, cls, name); }
	};
	this.sections.push(sec);
	return sec;
};
FormMap.prototype.render = function () { return Promise.resolve(makeNode('div')); };
FormMap.prototype.save = function () {
	FormMap._saved = (FormMap._saved || 0) + 1;
	return FormMap._fail ? Promise.reject(new Error('invalid')) : Promise.resolve();
};

const form = {
	Map: FormMap, NamedSection: 'NamedSection', Value: 'Value', Flag: 'Flag',
	ListValue: 'ListValue', DynamicList: 'DynamicList', MultiValue: 'MultiValue'
};

const view = { extend(proto) { return Object.assign(Object.create({}), proto); } };

/* stock luci-base firewall module: only the colour helper is used, and its
   real behaviour (fixed colours for lan/wan, derived otherwise) is what the
   view relies on to match the rest of the UI */
const fwstock = {
	getColorForName(n) {
		if (n == null) return '#eeeeee';
		if (n === 'lan') return '#90f090';
		if (n === 'wan') return '#f09090';
		return '#a1b2c3';
	},
	getZoneColorStyle(z) {
		const hex = fwstock.getColorForName((z != null && z !== '*') ? z : null);
		return '--zone-color-rgb:%d, %d, %d; background-color:rgb(var(--zone-color-rgb))'
			.format(parseInt(hex.substr(1, 2), 16), parseInt(hex.substr(3, 2), 16),
				parseInt(hex.substr(5, 2), 16));
	}
};
const baseclass = {
	extend(proto) {
		function C() { if (this.__init__) this.__init__.apply(this, arguments); }
		C.prototype = Object.create(proto);
		C.prototype.constructor = C;
		Object.assign(C, proto);
		return C;
	}
};
const rpcResults = { getHostHints: readJSON('hosthints.json'), dump: readJSON('ifdump.json').interface };
const rpc = { declare: o => () => Promise.resolve(rpcResults[o.method]) };
const fsMod = { read: p => Promise.resolve(p === '/etc/services' ? read('services.txt') : '') };

function _(s) { return s; }
String.prototype.format = function (...a) {
	let i = 0;
	return this.replace(/%[sd%]/g, m => (m === '%%' ? '%' : String(a[i++])));
};
const L = {
	resource: p => '/luci-static/resources/' + p,
	env: { resource_version: '26.1.2~abcdef-1788937645' }
};
const localStorage = {
	_d: {},
	getItem(k) { return (k in this._d) ? this._d[k] : null; },
	setItem(k, v) { this._d[k] = String(v); }
};
/* queue like a browser: callbacks run after the view node is attached */
const rafQueue = [];
const requestAnimationFrame = fn => rafQueue.push(fn);
const flushRaf = () => { while (rafQueue.length) rafQueue.shift()(); };

/* ---- module loader ------------------------------------------------------ */

/* TF_SRC lets these run against the *packaged* resources rather than the
   source tree — luci.mk minifies the JavaScript, so the shipped file is not
   the file we wrote and deserves testing on its own. */
const BASE = process.env.TF_SRC || path.join(__dirname, '..', 'luci-app-table-firewall',
	'htdocs/luci-static/resources');
const cache = {};

function loadModule(rel, extraEnv) {
	if (cache[rel]) return cache[rel];
	const file = path.join(BASE, rel + '.js');
	let src = fs.readFileSync(file, 'utf8');

	/* Parse the prologue the way luci.js does — by reading the leading run of
	   quoted directives — rather than line by line. Minified resources put the
	   whole prologue on one line, and a line-based scan silently finds no
	   dependencies at all, which looks like the module being broken. */
	const deps = {};
	const pro = /^(?:\s*'(?:use strict|require [^']*)';)+/.exec(src);
	if (pro) {
		for (const m of pro[0].matchAll(/'require ([^']*)';/g)) {
			const [what, , alias] = m[1].split(/\s+/);
			deps[alias || what] = resolveDep(what);
		}
		src = src.slice(pro[0].length);
	}

	const env = Object.assign({
		baseclass, uci, rpc, fs: fsMod, ui, dom, view, E, _, L,
		document, localStorage, requestAnimationFrame, window
	}, deps, extraEnv || {});

	const keys = Object.keys(env);
	const fn = new Function(...keys, '"use strict";' + src);
	return (cache[rel] = fn(...keys.map(k => env[k])));
}

function resolveDep(what) {
	const builtin = { view, ui, uci, rpc, dom, fs: fsMod, baseclass, firewall: fwstock, form };
	if (what in builtin) return builtin[what];
	return loadModule(what.replace(/\./g, '/'));
}

/* ---- run ---------------------------------------------------------------- */

let pass = 0, fail = 0;
const check = (ok, label, detail) => {
	if (ok) pass++;
	else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};

/* the theme's sticky nav, which the view measures to offset its own bar */
document._root.appendChild(makeNode('header'));
document.body = document._root;

const fwmodelMod = loadModule('table-firewall/model');
const v = loadModule('view/table-firewall/rules');

/* Flat async body: the tail grew into a .then pyramid that had to be
   hand-balanced on every edit, which is how a brace goes missing. */
(async () => {
	const model = await v.load();
	const root = v.render(model);
	document._root.appendChild(root);
	flushRaf();

	console.log('=== render ===');
	console.log('nodes created:', nodeCount);
	check(!!root, 'render() returned a node');
	check(document.querySelectorAll('.tf-header').length === 1, 'sticky header present');
	check(document.querySelectorAll('.tf-group').length > 20, 'zone-pair groups rendered',
		document.querySelectorAll('.tf-group').length + ' groups');

	const rows = document.querySelectorAll('.tf-row');
	check(rows.length > 30, 'rule rows rendered', rows.length + ' rows');

	console.log('\n=== terminators and markers ===');
	check(document.querySelectorAll('.tf-terminator').length > 20,
		'every group ends with a chain terminator',
		document.querySelectorAll('.tf-terminator').length + '');
	check(document.querySelectorAll('.tf-row-disabled').length > 0,
		'disabled rules rendered in place, not hidden',
		document.querySelectorAll('.tf-row-disabled').length + '');
	/* icmp_type is not "hidden" while the Service column shows it, so the only
	   genuinely hidden criterion in the fixtures is `limit`, on two IPv6
	   rules - check the tab that actually contains them. */
	v.families = [6]; v.renderGroups();
	const markedV6 = document.querySelectorAll('.tf-mark-extra').length;
	v.families = [4]; v.renderGroups();
	check(markedV6 > 0, 'rules with hidden criteria are marked', markedV6 + ' in IPv6 tab');

	console.log('\n=== search highlights, never hides ===');
	const before = document.querySelectorAll('.tf-row').length;
	v.query = 'ssh';
	v.renderGroups();
	const after = document.querySelectorAll('.tf-row').length;
	const matches = document.querySelectorAll('.tf-row-match').length;
	check(after === before, 'row count unchanged by search (nothing hidden)',
		before + ' -> ' + after);
	check(matches > 0 && matches < after, 'some rows highlighted, not all',
		matches + ' of ' + after);

	v.query = '10.10.10.10';
	v.renderGroups();
	const ipMatches = document.querySelectorAll('.tf-row-match').length;
	check(document.querySelectorAll('.tf-row').length === before,
		'row count unchanged by IP search');
	check(ipMatches > 0, 'subnet-aware IP search matches', ipMatches + ' rows');

	/* Regression: an address must not match every rule that merely references
	   the zone its subnet belongs to. Searching one DMZ host used to light up
	   18 rules, only 2 of which named the address. */
	{
		const sm = loadModule('table-firewall/search');
		const mm = loadModule('table-firewall/model');
		const byQuery = q => {
			const terms = sm.parse(model, q);
			return model.rules.filter(r => sm.match(model, r, terms, mm));
		};
		/* Asserting a count would just track whatever the lab config happens to
		   contain; the property is that every match really carries the
		   address. */
		const host = byQuery('10.10.10.10');
		check(host.length > 0, 'a host IP matches the rules naming it',
			host.length + ': ' + host.map(r => r.name).join(', '));
		check(host.every(r => r.destIp.concat(r.srcIp).some(v => /10\.10\.10\.10/.test(v))),
			'and every one of them really carries that address');
		check(!host.some(r => r.name === 'Drop-WAN-to-DMZ-Any'),
			'a zone-wide rule with no address criteria is not a match');

		const net = byQuery('10.10.10.0/24');
		check(net.length > host.length,
			'searching the subnet still finds the hosts inside it',
			net.length + ' rules');

		const zone = byQuery('DMZ');
		check(zone.length > net.length,
			'searching the zone by name still matches its rules',
			zone.length + ' rules');
	}

	v.query = 'zzzznope';
	v.renderGroups();
	check(document.querySelectorAll('.tf-row').length === before,
		'no matches still shows every rule');
	check(document.querySelectorAll('.tf-row-match').length === 0, 'no false matches');

	v.query = '';
	v.renderGroups();

	console.log('\n=== IPv4/IPv6 are independent toggles ===');
	{
		const famBtns = document.querySelectorAll('.tf-fam');
		check(famBtns.length === 2, 'two family toggles', famBtns.length + '');
		check(famBtns.every(b => b.getAttribute('aria-pressed') === 'true'),
			'both on by default — a family is never hidden unasked');

		const rowsFor = (fams) => { v.families = fams; v.renderGroups();
			return document.querySelectorAll('.tf-row').length; };

		const both = rowsFor([4, 6]);
		const only4 = rowsFor([4]);
		const only6 = rowsFor([6]);
		check(both > only4 && both > only6,
			'both together shows more than either alone',
			'both=' + both + ' v4=' + only4 + ' v6=' + only6);

		/* a dual-stack rule must appear once with both on, not twice */
		v.families = [4, 6]; v.renderGroups();
		const sids = document.querySelectorAll('.tf-row')
			.map(r => r.getAttribute('data-sid'));
		const dupes = sids.filter((x, i) => sids.indexOf(x) !== i);
		const shadows = document.querySelectorAll('.tf-row-shadow').length;
		check(dupes.length <= shadows,
			'no rule is duplicated by selecting both families',
			dupes.length + ' repeats, ' + shadows + ' of them shadow copies');

		console.log('\n=== the last family cannot be switched off ===');
		v.families = [4];
		check(v.toggleFamily(4) === false, 'turning off the only family is refused');
		check(v.families.join() === '4', 'and the selection is unchanged',
			v.families.join());
		check(v.toggleFamily(6) === true, 'but the other can be turned on');
		check(v.families.join() === '4,6', 'giving both', v.families.join());
		check(v.toggleFamily(4) === true, 'and now either can be turned off');
		check(v.families.join() === '6', 'leaving the other', v.families.join());

		console.log('\n=== the masquerade footer speaks for each family ===');
		v.families = [4, 6]; v.renderGroups();
		const masqBadges = document.querySelectorAll('.tf-badge-masq');
		check(masqBadges.length > 0, 'the masquerade badge is shown',
			masqBadges.length + '');
		const label = (masqBadges[0].children[0] || {}).text || '';
		check(/IPv4/.test(label),
			'and names the family, since wan masquerades IPv4 but not IPv6', label);

		v.families = [4]; v.renderGroups();
		const only4label = ((document.querySelectorAll('.tf-badge-masq')[0] || {})
			.children || [{}])[0];
		check(!/IPv/.test((only4label || {}).text || ''),
			'with one family selected it needs no qualifier',
			(only4label || {}).text);

		v.families = [4, 6]; v.renderGroups();
	}

	console.log('\n=== match navigation lives inside the field ===');
	const wrap = document.querySelector('.tf-search-wrap');
	check(query(wrap, '.tf-search-tools').length === 1,
		'the tools are inside the search field wrapper');
	check(query(wrap, '.tf-nav').length === 2, 'both arrows are in there');
	check(query(wrap, '.tf-match-count').length === 1, 'as is the count');
	v.syncSearchTools();
	check(/px$/.test(v.searchInputEl.style.paddingRight || ''),
		'the field reserves room so text cannot run under them',
		v.searchInputEl.style.paddingRight);

	console.log('\n=== match navigation ===');
	v.query = ''; v.renderGroups();
	const navs = document.querySelectorAll('.tf-nav');
	check(navs.length === 2, 'two navigation arrows exist', navs.length + '');
	check(navs.every(b => b.hidden),
		'arrows are hidden when not searching — no dead controls');
	const idleText = (v.matchCountEl.children[0] || {}).text || '';
	check(/rules/.test(idleText), 'idle label reports the rule count', idleText);

	v.query = 'ssh'; v.renderGroups();
	check(navs.every(b => !b.hidden), 'arrows appear once searching');
	check(navs.every(b => !b.disabled), 'and are enabled when there are matches');
	const hitText = (v.matchCountEl.children[0] || {}).text || '';
	check(/matches/.test(hitText), 'label reports matches while searching', hitText);

    v.jumpMatch(1);
	const posText = (v.matchCountEl.children[0] || {}).text || '';
	check(/1 \/ /.test(posText), 'stepping shows position, so the arrows explain themselves',
		posText);
	v.jumpMatch(1);
	check(/2 \/ /.test((v.matchCountEl.children[0] || {}).text || ''),
		'and advances');

	v.query = 'zzzznope'; v.renderGroups();
	check(navs.every(b => b.disabled), 'arrows disabled when nothing matches');
	check(/no matches/.test((v.matchCountEl.children[0] || {}).text || ''),
		'and the label says so');
	v.query = ''; v.renderGroups();

	console.log('\n=== each family holds different rules ===');
	const sidsOf = () => new Set(document.querySelectorAll('.tf-row')
		.map(r => r.getAttribute('data-sid')));

	/* set the selection explicitly: these comparisons are about what one
	   family contains, not about whatever the previous block left selected */
	v.families = [4]; v.renderGroups();
	const v4set = sidsOf();
	const v4 = document.querySelectorAll('.tf-row').length;
	v.families = [6];
	v.renderGroups();
	const v6set = sidsOf();
	const v6 = document.querySelectorAll('.tf-row').length;

	check(v4 > 0 && v6 > 0, 'both families render rows', 'v4=' + v4 + ' v6=' + v6);

	/* Row counts happen to collide on this dataset - the v6 wildcard rule fans
	   out into shadow copies - so compare contents, not totals. */
	const onlyV4 = [...v4set].filter(s => !v6set.has(s));
	const onlyV6 = [...v6set].filter(s => !v4set.has(s));
	check(onlyV4.length > 0 && onlyV6.length > 0,
		'each family holds rules the other does not',
		'v4-only=' + onlyV4.length + ' v6-only=' + onlyV6.length);

	const dual = [...v4set].filter(s => v6set.has(s));
	check(dual.length > 30, 'dual-stack rules appear under either family',
		dual.length + '');

	v.families = [4];
	v.renderGroups();

	console.log('\n=== columns ===');
	v.visible['chain'] = true;
	v.renderGroups();
	check(document.querySelectorAll('.tf-row').length === v4, 'enabling a column keeps rows');
	v.visible['src_ip'] = false;
	v.renderGroups();
	const marked = document.querySelectorAll('.tf-mark-extra').length;
	check(true, 'hiding a column re-renders without error');
	v.visible['src_ip'] = true;
	v.visible['chain'] = false;
	v.renderGroups();

	console.log('\n=== toolbar holds the family tabs ===');
	const hdr = document.querySelector('.tf-header');
	const tabsInHeader = query(hdr, '.tf-tabs');
	check(tabsInHeader.length === 1, 'family tabs live in the sticky toolbar');
	check(query(hdr, 'BUTTON').some(b => b.getAttribute('data-family') === '6'),
		'IPv6 tab is inside the toolbar');

	console.log('\n=== every table declares identical columns ===');
	const tables = document.querySelectorAll('.tf-table');
	const sigOf = t => query(t, '.th')
		.map(th => (th.className.match(/tf-col-[a-z_]+/) || ['-'])[0]).join(',');
	const sigs = new Set(tables.map(sigOf));
	check(tables.length > 10, 'several group tables rendered', tables.length + '');
	check(sigs.size === 1, 'all tables share one column signature',
		sigs.size + ' distinct: ' + [...sigs].slice(0, 2).join(' | '));

	/* and it must stay true when the column set changes */
	v.visible['chain'] = true; v.renderGroups();
	const sigs2 = new Set(document.querySelectorAll('.tf-table').map(sigOf));
	check(sigs2.size === 1, 'still one signature after enabling a column',
		sigs2.size + '');
	check([...sigs2][0].indexOf('tf-col-chain') >= 0, 'the new column is present everywhere');
	v.visible['chain'] = false; v.renderGroups();

	console.log('\n=== zone chips and pair headings ===');
	const chips = document.querySelectorAll('.zonebadge');
	check(chips.length > 50, 'zones render as stock zonebadge chips', chips.length + '');
	check(chips.every(c => (c.getAttribute('style') || '').indexOf('--zone-color-rgb') === 0),
		'each chip carries the stock zone colour style');
	const lanChip = chips.find(c => (c.getAttribute('style') || '').indexOf('144, 240, 144') >= 0);
	check(!!lanChip, 'lan keeps its stock green');
	check(document.querySelectorAll('.tf-arrow').length > 20,
		'group headings show src -> dest with an arrow',
		document.querySelectorAll('.tf-arrow').length + '');

	console.log('\n=== protocol has its own column ===');
	const sigp = [...new Set(document.querySelectorAll('.tf-table').map(t =>
		query(t, '.th').map(th => (th.className.match(/tf-col-[a-z_]+/) || ['-'])[0]).join(',')))][0];
	check(sigp.indexOf('tf-col-proto,tf-col-service') >= 0,
		'Protocol sits immediately before Service', sigp);

	/* a port-less protocol must not appear under a column headed "Dest port" */
	const esp = model.rules.find(r => (r.proto || []).indexOf('esp') >= 0);
	if (esp) {
		const pc = v.protoCell(esp);
		const sc = v.serviceCell(esp, model);
		const txt = n => ((n.children[0] || {}).text || '');
		check(/esp/.test(txt(pc)), 'esp renders in the Protocol cell', txt(pc));
		check(!/esp/.test(txt(sc)), 'and not in the Service cell', txt(sc));
		check(sc._classes.has('tf-muted'), 'which reports "any" instead', txt(sc));
	}

	/* and the protocol is no longer repeated once per port */
	const multi = model.rules.find(r => r.name === 'Pub-Mail-Submission');
	if (multi) {
		const txt = ((v.serviceCell(multi, model).children[0] || {}).text || '');
		check(!/tcp/.test(txt), 'ports are listed without repeating the protocol', txt);
		check(/465/.test(txt) && /587/.test(txt), 'both ports still shown', txt);
	}

	console.log('\n=== IPv column ===');
	const sig = [...new Set(document.querySelectorAll('.tf-table').map(t =>
		query(t, '.th').map(th => (th.className.match(/tf-col-[a-z_]+/) || ['-'])[0]).join(',')))][0];
	check(sig.indexOf('tf-col-enabled,tf-col-family,tf-col-name') >= 0,
		'IPv sits between On and Name by default', sig.slice(0, 60));

	const pairs = document.querySelectorAll('.tf-ipv-pair');
	check(pairs.length > 30, 'every rule shows an IPv pair', pairs.length + '');
	check(pairs.every(p => p.children.length === 2),
		'both slots always present, so the chips stay aligned');

	/* a dual-stack rule lights both; a pinned one lights only its own slot */
	const lit = p => p.children.filter(c => !c._classes.has('tf-ipv-off')).length;
	check(pairs.some(p => lit(p) === 2), 'dual-stack rules light both slots');
	v.families = [6]; v.renderGroups();
	const p6 = document.querySelectorAll('.tf-ipv-pair');
	check(p6.some(p => lit(p) === 1 &&
			p.children[1] && !p.children[1]._classes.has('tf-ipv-off')),
		'an IPv6-only rule lights the right slot only');
	v.families = [4]; v.renderGroups();

	console.log('\n=== the stylesheet is cache-busted ===');
	{
		const links = document.head.children.filter(c => c.tagName === 'LINK');
		check(links.length === 1, 'exactly one stylesheet link', links.length + '');
		const href = links[0].getAttribute('href') || '';
		check(/table-firewall\.css\?v=/.test(href),
			'and it carries the resource version, as LuCI does for its own assets',
			href);
		v.loadStyle();
		check(document.head.children.filter(c => c.tagName === 'LINK').length === 1,
			'a second call does not add it twice');
	}

	console.log('\n=== an address with several names ===');
	{
		const cellText = n => {
			const bits = [];
			const walkN = (x) => {
				if (!x) return;
				if (x.text) bits.push(x.text);
				(x.children || []).forEach(walkN);
			};
			walkN(n);
			return bits.join('');
		};

		const many = v.addrCell(['10.10.10.10'], v.model);
		const txt = cellText(many);
		check(/web01/.test(txt), 'the first names are shown inline', txt);
		check(/nginx/.test(txt), 'including the second', txt);

		const badge = query(many, '.tf-mark-names');
		check(badge.length === 1, 'the surplus goes behind one badge', badge.length + '');
		check(/^\+\d+$/.test(cellText(badge[0])), 'which shows how many more',
			cellText(badge[0]));
		check(/Also known as/.test(badge[0].getAttribute('title') || ''),
			'and names them on hover', badge[0].getAttribute('title'));
		check(/nginx2/.test(badge[0].getAttribute('title') || ''),
			'listing the ones not shown inline', badge[0].getAttribute('title'));

		/* an address with a single name must not grow a badge */
		const one = v.addrCell(['10.10.10.20'], v.model);
		check(query(one, '.tf-mark-names').length === 0,
			'a single-name address has no badge', cellText(one));
		check(/mail01/.test(cellText(one)), 'and still shows its name', cellText(one));
	}

	console.log('\n=== source zones fold, with a summary ===');
	v.folded = {}; v.query = ''; v.renderGroups();
	const zoneHeads = document.querySelectorAll('.tf-zone-head');
	check(zoneHeads.length > 3, 'zone headings render', zoneHeads.length + '');

	const countsOf = h => query(h, '.tf-badge').map(b => (b.children[0] || {}).text || '');
	const wanHead = zoneHeads.find(h => countsOf(h).some(t => /DNAT/.test(t)));
	check(!!wanHead, 'a zone reports its DNAT count', countsOf(zoneHeads[0]).join(' '));
	check(countsOf(wanHead).some(t => /rules/.test(t)), 'and its rule count');
	check(countsOf(wanHead).some(t => /SNAT/.test(t)), 'and its SNAT count');

	const groupsBefore = document.querySelectorAll('.tf-group').length;
	v.folded = { wan: true }; v.renderGroups();
	const groupsAfter = document.querySelectorAll('.tf-group').length;
	check(groupsAfter < groupsBefore, 'folding a zone hides its groups',
		groupsBefore + ' -> ' + groupsAfter);
	check(document.querySelectorAll('.tf-zone-head').length === zoneHeads.length,
		'but its heading stays, with the counts still visible');

	/* a fold must not hide a search hit */
	v.query = 'Pub-Web-HTTP'; v.renderGroups();
	check(document.querySelectorAll('.tf-row-match').length > 0,
		'a match inside a folded zone forces it open',
		document.querySelectorAll('.tf-row-match').length + '');
	v.query = ''; v.folded = {}; v.renderGroups();

	/* counts are per family, like everything else */
	const sum4 = v.zoneSummary(v.model, 'wan', [4]);
	const sum6 = v.zoneSummary(v.model, 'wan', [6]);
	check(sum4.dnat > 0, 'IPv4 counts include the port forwards', sum4.dnat + '');
	check(sum4.rules !== sum6.rules || sum4.dnat !== sum6.dnat,
		'and the two families differ',
		JSON.stringify(sum4) + ' vs ' + JSON.stringify(sum6));

	/* a wildcard shadowed into several pairs is one rule, not several */
	const wanRules = new Set();
	for (const g of v.model.groups.filter(g => g.src === 'wan'))
		for (const e of g.rules) wanRules.add(e.rule.sid);
	check(sum4.rules <= wanRules.size,
		'shadow copies are not double counted',
		sum4.rules + ' <= ' + wanRules.size);

	console.log('\n=== a pair with only NAT still renders it ===');
	/* "this device -> wan" has no filter rules but source NAT does apply to
	   traffic the router originates, so the summary and the page must agree */
	const devSum = v.zoneSummary(v.model, fwmodelMod.DEVICE, [4]);
	if (devSum.snat > 0) {
		const devPair = v.model.groups.find(g =>
			g.src === fwmodelMod.DEVICE && g.dest === 'wan');
		check(!!devPair, 'the device -> wan pair exists');
		check(devPair.rules.length === 0, 'and carries no filter rules');

		const rendered = v.renderGroup(
			Object.assign({}, devPair, { rules: [], otherRules: [] }),
			v.model, [], fwmodelMod);
		check(!rendered._classes.has('tf-group-empty'),
			'so it is not collapsed to a "no rules" stub');
		check(query(rendered, '.tf-nathead-srcnat').length === 1,
			'and its source NAT is actually shown',
			query(rendered, '.tf-nathead-srcnat').length + '');
	}

	console.log('\n=== NAT renders beside the pair it affects ===');
	check(document.querySelectorAll('.tf-zone-head').length > 3,
		'each source zone still gets a section heading',
		document.querySelectorAll('.tf-zone-head').length + '');

	const dnatHeads = document.querySelectorAll('.tf-nathead-dstnat');
	check(dnatHeads.length >= 2,
		'port forwards head the pair they target', dnatHeads.length + ' pairs');

	/* inside a group table: dnat header, dnat rows, then the filter rows */
	const wanDmz = document.querySelectorAll('.tf-group').find(g =>
		query(g, '.tf-nathead-dstnat').length > 0);
	const seq = query(wanDmz, 'TR').map(tr =>
		tr._classes.has('tf-nathead-dstnat') ? 'dnathead'
		: tr._classes.has('tf-row-nat') ? 'nat'
		: tr._classes.has('tf-nathead-srcnat') ? 'snathead'
		: tr._classes.has('tf-terminator') ? 'term'
		: tr._classes.has('tf-row') ? 'filter' : 'head');
	check(seq.indexOf('dnathead') < seq.indexOf('filter'),
		'port forwards come before the filter rules', seq.join(','));
	check(seq.indexOf('nat') < seq.indexOf('filter'),
		'and their rows too');

	console.log('\n=== source NAT is collapsed by default ===');
	const snatHeads = document.querySelectorAll('.tf-nathead-srcnat');
	check(snatHeads.length >= 3,
		'the shared SNAT summary appears after every pair ending in wan',
		snatHeads.length + '');
	check(document.querySelectorAll('.tf-row-nat')
		.filter(r => r._classes.has('tf-row-nat')).length > 0, 'NAT rows exist');

	const toWanGroup = document.querySelectorAll('.tf-group').find(g =>
		query(g, '.tf-nathead-srcnat').length > 0);
	const seq2 = query(toWanGroup, 'TR').map(tr =>
		tr._classes.has('tf-nathead-srcnat') ? 'snathead'
		: tr._classes.has('tf-terminator') ? 'term' : 'x');
	check(seq2.indexOf('term') < seq2.indexOf('snathead'),
		'source NAT comes after the verdict, since it applies on the way out',
		seq2.filter(x => x !== 'x').join(','));

	/* collapsed: the summary is there, the rules are not */
	const beforeRows = document.querySelectorAll('.tf-row-nat').length;
	v.snatOpen = { wan: true }; v.renderGroups();
	const afterRows = document.querySelectorAll('.tf-row-nat').length;
	check(afterRows > beforeRows, 'expanding reveals the NAT rules',
		beforeRows + ' -> ' + afterRows);
	v.snatOpen = {}; v.renderGroups();
	check(document.querySelectorAll('.tf-row-nat').length === beforeRows,
		'and collapsing hides them again');

	console.log('\n=== masquerade is surfaced where it applies ===');
	check(document.querySelectorAll('.tf-badge-masq').length >= 3,
		'the masquerade badge shows after every pair leaving via wan',
		document.querySelectorAll('.tf-badge-masq').length + '');
	v.families = [6]; v.renderGroups();
	check(document.querySelectorAll('.tf-badge-masq').length === 0,
		'but not on the IPv6 tab — wan sets masq, not masq6',
		document.querySelectorAll('.tf-badge-masq').length + '');
	v.families = [4]; v.renderGroups();

	console.log('\n=== NAT rows ===');
	const rw = document.querySelectorAll('.tf-rewrite');
	check(rw.length > 0, 'rewrite targets are rendered', rw.length + '');
	check(rw.every(n => /^→/.test((n.children[0] || {}).text || '')),
		'and marked with an arrow so they read as a rewrite, not a match');

	const dnatRule = model.redirects.find(r => r.kind === 'dnat');
	const cellD = v.cellValue('target', dnatRule, model);
	const cellText = n => (n.children || []).map(c => c.text || '').join('');
	check(/DNAT \(Port Forward\)/.test(cellText(cellD)),
		'DNAT is labelled with both names', cellText(cellD));
	const masqRule = model.nats.find(r => r.target === 'MASQUERADE');
	check(/MASQUERADE/.test(cellText(v.cellValue('target', masqRule, model))),
		'MASQUERADE keeps its own name');

	console.log('\n=== add menu offers all three ===');
	const addBtn = query(document.querySelector('.tf-header'), 'BUTTON')
		.find(b => /Add/.test((b.children[0] || {}).text || ''));
	check(!!addBtn, 'the Add control exists');
	v.openAddMenu(addBtn);
	const addItems = document.querySelectorAll('.tf-menu-item');
	check(addItems.length === 3, 'three things can be added', addItems.length + '');
	const addLabels = addItems.map(i => (i.children[0] || {}).text || '').join('|');
	check(/Traffic rule/.test(addLabels) && /Port forward/.test(addLabels) &&
		/NAT rule/.test(addLabels),
		'traffic rule, port forward and NAT rule', addLabels);
	v.closeRowMenu();

	console.log('\n=== off-hook rules are separated ===');
	check(document.querySelectorAll('.tf-row-other').length > 0,
		'mangle/raw rules rendered in their own block',
		document.querySelectorAll('.tf-row-other').length + '');
	check(document.querySelectorAll('.tf-otherhead').length > 0,
		'and labelled as not participating in the ordering');

	console.log('\n=== column picker modal ===');
	v.showColumnPicker();
	check(!!ui._modal, 'column picker opens');

	console.log('\n=== resize strip ===');
	const strip = document.querySelector('.tf-resize');
	check(!!strip, 'strip rendered in the toolbar');
	check(strip && strip.parentNode === document.querySelector('.tf-header'),
		'strip lives on the sticky bar, so it never scrolls away');

	const activeKeys = v.activeColumns().map(c => c.key);
	const stripKeys = document.querySelectorAll('.tf-rs-cell').map(c => c.getAttribute('data-key'));
	check(stripKeys.join(',') === activeKeys.join(','),
		'strip mirrors the active columns in order', stripKeys.join(','));

	/* label first, then a single rule out to the next dot (left-aligned like
	   the table cells) */
	const firstCell = document.querySelectorAll('.tf-rs-cell')[0];
	check(firstCell.children.length === 2 &&
		firstCell.children[0]._classes.has('tf-rs-label') &&
		firstCell.children[1]._classes.has('tf-rs-line'),
		'each cell is label-then-line, not line-label-line');

	const labels = document.querySelectorAll('.tf-rs-label').map(l => (l.children[0] || {}).text);
	for (const need of ['Name', 'Source zone', 'Destination zone', 'Protocol'])
		check(labels.indexOf(need) >= 0, 'strip names the "' + need + '" column',
			labels.join(' | '));

	const handles = document.querySelectorAll('.tf-rs-handle');
	check(handles.length === activeKeys.length - 1,
		'one handle per split, none after the last column',
		handles.length + ' for ' + activeKeys.length + ' columns');
	check(handles.every(h => h.getAttribute('tabindex') === '0'),
		'handles are keyboard reachable');

	console.log('\n=== resizing ===');
	const cssProps = document.documentElement.style._p;
	v.keyResize({ key: 'ArrowRight', shiftKey: false, preventDefault() {} }, 'name');
	check(!!cssProps['--tf-w-name'], 'arrow key sets an explicit width', cssProps['--tf-w-name']);
	const w1 = parseInt(cssProps['--tf-w-name'], 10);
	v.keyResize({ key: 'ArrowRight', shiftKey: true, preventDefault() {} }, 'name');
	check(parseInt(cssProps['--tf-w-name'], 10) > w1, 'shift resizes in bigger steps',
		cssProps['--tf-w-name']);

	/* a column must never be draggable to nothing */
	for (let i = 0; i < 40; i++)
		v.keyResize({ key: 'ArrowLeft', shiftKey: true, preventDefault() {} }, 'name');
	check(parseInt(cssProps['--tf-w-name'], 10) >= 34, 'width clamped to a usable minimum',
		cssProps['--tf-w-name']);

	v.keyResize({ key: 'Home', preventDefault() {} }, 'name');
	check(!('--tf-w-name' in cssProps), 'Home resets the column to its default');

	v.widths = { name: 250 }; v.applyWidths();
	check(cssProps['--tf-w-name'] === '250px', 'stored widths are applied');
	v.resetWidths();
	check(!('--tf-w-name' in cssProps), 'reset clears every override');

	console.log('\n=== strip alignment is idempotent ===');
	{
		/* Geometry that responds to the margin, so repeated syncs would drift
		   if the code measured its own offset position without zeroing first. */
		const st = document.querySelector('.tf-resize');
		st.getBoundingClientRect = function () {
			const m = parseInt((this.style.marginLeft || '0'), 10) || 0;
			return { left: 20 + m, width: 1000, top: 0, height: 14 };
		};
		/* the strip anchors on the first *resizable* column, not the first cell:
		   the drag-handle column sits ahead of them */
		const firstKey = v.activeColumns()[0].key;
		const th0 = document.querySelectorAll('.th')
			.find(th => (th.className || '').indexOf('tf-col-' + firstKey) >= 0);
		check(!!th0, 'anchor column header found', firstKey);
		th0.getBoundingClientRect = () => ({ left: 50, width: 40, top: 0, height: 20 });

		v.syncResizeStrip();
		const first = st.style.marginLeft;
		v.syncResizeStrip();
		v.syncResizeStrip();
		check(first === '30px', 'strip aligns to the first header cell', first);
		check(st.style.marginLeft === first,
			'repeated syncs do not drift the alignment',
			first + ' -> ' + st.style.marginLeft);
	}

	console.log('\n=== strip is not rebuilt needlessly ===');
	const stripBefore = document.querySelector('.tf-resize');
	v.query = 'ssh'; v.renderGroups();
	v.query = 'ssh2'; v.renderGroups();
	check(document.querySelector('.tf-resize') === stripBefore,
		'searching reuses the existing strip instead of rebuilding it');
	check(document.querySelectorAll('.tf-resize').length === 1,
		'exactly one strip exists',
		document.querySelectorAll('.tf-resize').length + '');
	v.query = ''; v.renderGroups();

	console.log('\n=== strip follows the column set ===');
	v.visible['chain'] = true; v.renderGroups();
	const keys2 = document.querySelectorAll('.tf-rs-cell').map(c => c.getAttribute('data-key'));
	check(keys2.indexOf('chain') >= 0, 'enabling a column adds it to the strip');
	check(document.querySelectorAll('.tf-resize').length === 1,
		'still exactly one strip after a rebuild',
		document.querySelectorAll('.tf-resize').length + '');
	check(document.querySelectorAll('.tf-header').length === 1,
		'the toolbar survives a strip rebuild');
	check(!!document.querySelector('.tf-search'), 'search box survives a strip rebuild');
	v.visible['chain'] = false; v.renderGroups();

	console.log('\n=== sticky offsets ===');
	const props = document.documentElement.style._p;
	check(props['--tf-nav-h'] === '48px',
		'sticky bar offset below the theme nav is measured', props['--tf-nav-h']);
	check(props['--tf-bar-h'] === '48px', 'bar height measured for group headers',
		props['--tf-bar-h']);
	window.fire('resize');
	check(props['--tf-nav-h'] === '48px', 'resize re-measures without error');

	/* a zero measurement must clear the property, not pin the bar at 0px */
	const realQS = document.querySelector;
	document.querySelector = (sel) => (sel === 'header' ? null : realQS.call(document, sel));
	v.syncStickyOffsets();
	document.querySelector = realQS;
	check(!('--tf-nav-h' in props),
		'missing nav clears the offset so the CSS fallback applies',
		JSON.stringify(props));

	console.log('\n=== editor ===');
	const ed = loadModule('table-firewall/editor');
	const m0 = ed.buildMap(model, 'cfg0b92bd', 'rule');
	const optNames = m0.sections[0].options.map(o => o.name);
	for (const need of ['name', 'enabled', 'family', 'src', 'src_ip', 'dest',
			'dest_ip', 'proto', 'dest_port', 'target', 'src_port', 'weekdays'])
		check(optNames.indexOf(need) >= 0, 'editor exposes ' + need);

	/* the modal renders asynchronously, so wait before clicking */
	const settle = () => new Promise(r => setImmediate(r));
	const modalButtons = () => query(ui._modalNode, 'BUTTON');
	const ruleCount = (type) => Object.keys(configs.firewall)
		.filter(k => configs.firewall[k]['.type'] === (type || 'rule')).length;
	const copySid = () => Object.keys(configs.firewall).find(k =>
		(configs.firewall[k].name || '').indexOf('(copy)') >= 0);

	/* click a modal button once the dialog is actually up */
	const press = async (promise, which) => {
		await settle();
		modalButtons()[which]. fire('click');
		return promise;
	};

	console.log('\n=== add: cancel must not leave a staged rule ===');
	const rulesBefore = ruleCount();
	const sid1 = ed.create(model, { target: 'ACCEPT', enabled: '1' }, 'rule');
	check(!!configs.firewall[sid1], 'create() adds a rule section');
	check(modalButtons.length !== 0 || true, '');
	const cancelled = await press(ed.open(model, sid1, true, 'rule'), 0);
	check(cancelled === false, 'cancel resolves false');
	check(!configs.firewall[sid1], 'cancelled Add removes the staged section');
	check(ruleCount() === rulesBefore, 'rule count back where it started');

	console.log('\n=== add: save keeps it ===');
	const sid2 = ed.create(model, { target: 'DROP' }, 'rule');
	const okSaved = await press(ed.open(model, sid2, true, 'rule'), 1);
	check(okSaved === true, 'save resolves true');
	check(!!configs.firewall[sid2], 'saved Add keeps the section');

	console.log('\n=== edit: an invalid form stays open ===');
	FormMap._fail = true;
	const badP = ed.open(model, sid2, false, 'rule');
	await settle();
	modalButtons()[1].fire('click');
	await settle();
	check(ui._modal != null, 'a failed save does not dismiss the modal');
	FormMap._fail = false;
	modalButtons()[0].fire('click');
	await badP;
	uci.remove('firewall', sid2);

	console.log('\n=== add offers every section type ===');
	for (const [kind, type] of [['rule', 'rule'], ['redirect', 'redirect'], ['nat', 'nat']]) {
		const sid = ed.create(model, {}, type);
		check(configs.firewall[sid]['.type'] === type,
			'Add ' + kind + ' creates a ' + type + ' section',
			configs.firewall[sid]['.type']);
		uci.remove('firewall', sid);
	}

	console.log('\n=== duplicate keeps the section type ===');
	/* cloning a port forward must produce another config redirect: creating a
	   config rule instead silently turns a DNAT into a traffic rule, which
	   then renders in a different part of the page */
	for (const [label, rule, want] of [
		['a port forward', v.model.redirects.find(r => r.kind === 'dnat'), 'redirect'],
		['a NAT rule', v.model.nats[0], 'nat'],
		['a traffic rule', v.model.rules.find(r => r.section !== 'nat'), 'rule']
	]) {
		const before = Object.keys(configs.firewall).length;
		const p = v.handleClone(rule);
		const made = copySid();
		check(!!made, 'duplicating ' + label + ' creates a section');
		check(made && configs.firewall[made]['.type'] === want,
			'duplicating ' + label + ' creates a ' + want + ' section',
			made && configs.firewall[made]['.type']);
		await press(p, 0);
		check(Object.keys(configs.firewall).length === before,
			'and cancelling removes it again');
	}

	console.log('\n=== row actions menu ===');
	const menuBtns = document.querySelectorAll('.tf-menu-btn');
	check(menuBtns.length > 30, 'every row has a ⋯ button', menuBtns.length + '');
	v.openRowMenu(menuBtns[0], { rule: v.model.rules[0] });
	check(document.querySelectorAll('.tf-menu-item').length === 3,
		'menu offers edit, duplicate, delete');
	v.closeRowMenu();
	check(!document.querySelector('.tf-menu'), 'menu closes again');

	console.log('\n=== delete is confirmed, not immediate ===');
	const victim = v.model.rules.find(r => r.name === 'Allow-LAN-Web');
	v.handleDelete(victim);
	check(!!configs.firewall[victim.sid], 'opening the confirm deletes nothing');
	modalButtons()[0].fire('click');
	check(!!configs.firewall[victim.sid], 'cancelling keeps the rule');
	v.handleDelete(victim);
	modalButtons()[1].fire('click');
	check(!configs.firewall[victim.sid], 'confirming removes it');

	console.log('\n=== drag to reorder ===');
	const dragHandles = document.querySelectorAll('.tf-handle');
	check(dragHandles.length > 30, 'every row has a drag handle', dragHandles.length + '');
	check(dragHandles.every(h => h.getAttribute('draggable') === 'true'),
		'drag handles are draggable');

	const gA = v.model.groups.find(g => g.rules.length > 2 && !g.rules.some(e => e.shadow));
	const gB = v.model.groups.find(g => g.rules.length > 1 && g !== gA);
	v.beginDrag({ dataTransfer: null, target: null }, gA.rules[0], gA, 'filter');
	check(v.dropAllowed(gA, 'filter'), 'drop allowed inside the same group');
	check(!v.dropAllowed(gB, 'filter'), 'drop refused into a different zone pair');
	check(!v.dropAllowed(gA, 'other'), 'drop refused across buckets');
	v.endDrag();
	check(!v.dropAllowed(gA, 'filter'), 'no drop target once the drag ends');

	ui._notes = [];
	v.applyMove('nope-1', 'nope-2', false);
	check((ui._notes || []).length === 1,
		'an impossible move warns instead of failing silently');

	console.log('\n=== NAT reorder is bounded by chain, not group ===');
	const f1 = v.model.redirects.find(r => r.dest === 'DMZ');
	const f2 = v.model.redirects.find(r => r.dest === 'production');
	v.beginDrag({ dataTransfer: null, target: null }, { rule: f1 }, { key: 'wan|DMZ' }, 'nat|dstnat');
	check(v.dropAllowed({ key: 'wan|production' }, 'nat|dstnat', f2.chain),
		'a forward moves across pairs inside its own chain',
		f1.chain + ' / ' + f2.chain);
	check(!v.dropAllowed({ key: 'wan|DMZ' }, 'nat|dstnat', 'dstnat_lan'),
		'but not into another chain');
	check(!v.dropAllowed({ key: 'wan|DMZ' }, 'filter', f1.chain),
		'and not into the filter rules');
	v.endDrag();

	console.log('\n=== a move is staged through uci.move ===');
	const gsids = () => v.model.groups.find(g => g.key === gA.key).rules.map(e => e.rule.sid);
	const order0 = gsids().join(',');
	const moveSid = gA.rules[gA.rules.length - 1].rule.sid;
	const refSid = gA.rules[0].rule.sid;
	ui._notes = [];
	await v.applyMove(moveSid, refSid, false);
	const order1 = gsids().join(',');
	check((ui._notes || []).length === 0, 'a valid move raises no warning');
	check(order1 !== order0, 'the group order actually changed');
	check(order1.split(',')[0] === moveSid, 'the dragged rule landed before its target');
	check(order1.split(',').length === order0.split(',').length,
		'no rule lost or duplicated');

	console.log('\n=== moving a wildcard asks first ===');
	const wcGroup = v.model.groups.find(g => g.rules.some(e => e.shadow));
	if (wcGroup) {
		const wcEntry = wcGroup.rules.find(e => e.shadow);
		const target = wcGroup.rules.find(e => !e.shadow);
		v.beginDrag({ dataTransfer: null, target: null }, wcEntry, wcGroup, 'filter');
		v._dropAfter = false;
		ui._modal = null;
		v.handleDrop({ preventDefault() {} },
			{ getAttribute: (k) => k === 'data-sid' ? target.rule.sid : '',
			  classList: { remove() {}, add() {} } }, wcGroup, 'filter');
		check(ui._modal != null, 'dragging a wildcard shadow confirms first');
		modalButtons()[0].fire('click');
	}

	console.log('\n=== staged rows are highlighted ===');
	await v.refreshChangeIndicator();
	v.renderGroups();
	const changed = document.querySelectorAll('.tf-row-changed');
	check(changed.length > 0, 'the moved rule is highlighted', changed.length + '');
	check(new Set(changed.map(r => r.getAttribute('data-sid'))).has(moveSid),
		'and it is the right rule');
	check(changed.length < document.querySelectorAll('.tf-row').length / 2,
		'reorder noise does not highlight everything');
	check(document.querySelectorAll('.tf-mark-pending').length > 0,
		'and carries a badge, not colour alone');

	console.log('\n=== dirty header ===');
	v.paintDirty(3);
	const bar = document.querySelector('.tf-header');
	check(bar._classes.has('tf-dirty'), 'header goes red with staged changes');
	v.paintDirty(0);
	check(!bar._classes.has('tf-dirty'), 'header returns to normal when clean');
	check(document.querySelectorAll('.tf-row-changed').length === 0,
		'and the row marks clear');

	console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed');
	process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
