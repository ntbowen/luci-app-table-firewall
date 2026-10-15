'use strict';
'require view';
'require ui';
'require uci';
'require dom';
'require firewall as fwstock';
'require table-firewall.model as fwmodel';
'require table-firewall.search as fwsearch';
'require table-firewall.editor as fweditor';
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Gerhard Mautendorfer (MaidByC)

/* Traffic Rules, grouped by zone pair.
 *
 * Three rules govern this view, all of them safety rather than taste:
 *
 *  - Search highlights, never filters. A rule's meaning depends on what sits
 *    above it in the same chain.
 *  - Hiding a column may reduce detail, never a rule's apparent specificity;
 *    a rule with values in hidden columns is marked.
 *  - Every table ends with the real chain terminator, so "matches nothing" is
 *    always answerable.
 */

const ACTION_EMOJI = {
	ACCEPT: '✅', REJECT: '🚫', DROP: '⛔',
	MARK: '🏷', NOTRACK: '👻', HELPER: '🧩',
	/* NAT: the arrow points at the end being rewritten */
	DNAT: '➡️', SNAT: '⬅️', MASQUERADE: '🎭', REDIRECT: '↪️',
	NONE: '·'
};

/* OpenWrt's own wording where it differs from the real name, so the page
   matches the rest of LuCI without hiding what the rule actually is. */
const ACTION_LABEL = {
	DNAT: _('DNAT (Port Forward)'),
	SNAT: _('SNAT'),
	MASQUERADE: _('MASQUERADE'),
	REDIRECT: _('REDIRECT')
};

const COLUMNS = [
	{ key: 'pos',      label: '#',           dflt: true,  cls: 'tf-c-pos' },
	{ key: 'enabled',  label: _('On'),       dflt: true,  cls: 'tf-c-on' },
	{ key: 'family',   label: _('IPv'),      dflt: true },
	{ key: 'name',     label: _('Name'),     dflt: true },
	/* labelled as the add/edit dialog labels the same fields */
	{ key: 'src',      label: _('Source zone'), dflt: true },
	{ key: 'src_ip',   label: _('Source IP'), dflt: true },
	{ key: 'dest',     label: _('Destination zone'), dflt: true },
	{ key: 'dest_ip',  label: _('Dest IP'),  dflt: true },
	/* Protocol is its own field in the editor and belongs in its own column:
	   folded into Service it was repeated once per port ("tcp/465 tcp/587"),
	   and a port-less protocol like esp appeared under a column headed
	   "Dest port", which is simply wrong. */
	{ key: 'proto',    label: _('Protocol'), dflt: true },
	{ key: 'service',  label: _('Service (Dest port)'), dflt: true },
	{ key: 'target',   label: _('Action'),   dflt: true },
	{ key: 'src_port', label: _('Source port') },
	{ key: 'time',     label: _('Time') },
	{ key: 'limit',    label: _('Limit') },
	{ key: 'log',      label: _('Log') },
	{ key: 'mark',     label: _('Mark') },
	{ key: 'dscp',     label: _('DSCP') },
	{ key: 'helper',   label: _('Helper') },
	{ key: 'ipset',    label: _('IPSet') },
	{ key: 'device',   label: _('Device') },
	{ key: 'extra',    label: _('Extra') },
	{ key: 'chain',    label: _('Chain') },
	{ key: 'sid',      label: _('Section ID') }
];

/* v2: the IPv column became a default, and a stored v1 preference would keep
   it hidden for anyone who had already opened the page. */
const STORE_KEY = 'luci.table-firewall.columns.v2';
const WIDTH_KEY = 'luci.table-firewall.widths.v1';
const FOLD_KEY = 'luci.table-firewall.folded.v1';
const FAMILY_KEY = 'luci.table-firewall.families.v1';
const MIN_COL_PX = 34;

function joinOrDash(v) {
	if (v == null) return null;
	const s = Array.isArray(v) ? v.join(' ') : String(v);
	return s.length ? s : null;
}

return view.extend({
	load() {
		return fwmodel.load();
	},

	/* ------------------------------------------------------------------
	 * column preferences (per browser, never written to the device)
	 * ---------------------------------------------------------------- */

	loadColumns() {
		let stored = null;
		try { stored = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); }
		catch (e) { stored = null; }

		this.visible = {};
		for (const c of COLUMNS)
			this.visible[c.key] = stored && (c.key in stored) ? !!stored[c.key] : !!c.dflt;
	},

	saveColumns() {
		try { localStorage.setItem(STORE_KEY, JSON.stringify(this.visible)); }
		catch (e) { /* private mode: preference simply does not persist */ }
	},

	activeColumns() {
		return COLUMNS.filter(c => this.visible[c.key]);
	},

	/* ------------------------------------------------------------------
	 * column widths
	 *
	 * The table and the resize strip are driven by the same CSS custom
	 * properties, so they cannot drift apart: --tf-w-<key> is read by
	 * .tf-col-<key> in the stylesheet and applied to the matching strip cell.
	 * ---------------------------------------------------------------- */

	/* Which address families are shown. Independent toggles rather than tabs:
	   a tab quietly hides a whole family behind a button, which is the failure
	   this view exists to avoid. Both are on by default. */
	loadFamilies() {
		let stored = null;
		try { stored = JSON.parse(localStorage.getItem(FAMILY_KEY) || 'null'); }
		catch (e) { stored = null; }

		const ok = Array.isArray(stored) && stored.length &&
			stored.every(f => f === 4 || f === 6);
		this.families = ok ? stored.slice() : [4, 6];
	},

	saveFamilies() {
		try { localStorage.setItem(FAMILY_KEY, JSON.stringify(this.families)); }
		catch (e) { /* private mode: the choice simply does not persist */ }
	},

	toggleFamily(f) {
		const on = this.families.indexOf(f) >= 0;

		/* Refuse to switch off the last one: an empty page reads as a fault,
		   not as a filter. */
		if (on && this.families.length === 1) return false;

		this.families = on
			? this.families.filter(x => x !== f)
			: this.families.concat([f]).sort();

		this.saveFamilies();
		return true;
	},

	/* Shown when it applies to *any* selected family. A dual-stack rule
	   therefore appears once when both are on, not twice. */
	inFamilies(obj) {
		return !obj.family || this.families.indexOf(obj.family) >= 0;
	},

	/* Which source-zone sections are folded away. Persisted like the column
	   preferences: a display choice, never written to the device. */
	loadFolds() {
		try { this.folded = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {}; }
		catch (e) { this.folded = {}; }
	},

	saveFolds() {
		try { localStorage.setItem(FOLD_KEY, JSON.stringify(this.folded)); }
		catch (e) { /* private mode: the fold simply does not persist */ }
	},

	toggleFold(zone) {
		this.folded = this.folded || {};
		this.folded[zone] = !this.folded[zone];
		this.saveFolds();
		this.renderGroups();
	},

	/* What a source zone contains, for the summary on its heading.
	   Counted by distinct section id: a wildcard rule shadowed into several
	   pairs is one rule, not several. */
	zoneSummary(model, src, families) {
		const sel = families || this.families;
		const famOk = r => !r.family || sel.indexOf(r.family) >= 0;
		const rules = new Set(), off = new Set(), disabled = new Set();

		for (const g of model.groups.filter(g => g.src === src)) {
			for (const e of g.rules) if (famOk(e.rule)) {
				rules.add(e.rule.sid);
				if (!e.rule.enabled) disabled.add(e.rule.sid);
			}
			for (const e of (g.otherRules || [])) if (famOk(e.rule)) off.add(e.rule.sid);
		}

		const dnat = ((model.natByZone[src] || {}).dstnat || []).filter(famOk);

		/* Source NAT is keyed by egress zone, so what applies to traffic
		   leaving this zone is the union over its destinations — deduped,
		   since the same rules are shown after several pairs. */
		const snat = new Set();
		for (const g of model.groups.filter(g => g.src === src)) {
			for (const r of ((model.natByZone[g.dest] || {}).srcnat || []))
				if (famOk(r)) snat.add(r.sid);
		}

		return {
			rules: rules.size, disabled: disabled.size, off: off.size,
			dnat: dnat.length, snat: snat.size
		};
	},

	loadWidths() {
		try { this.widths = JSON.parse(localStorage.getItem(WIDTH_KEY) || '{}') || {}; }
		catch (e) { this.widths = {}; }
		this.applyWidths();
	},

	saveWidths() {
		try { localStorage.setItem(WIDTH_KEY, JSON.stringify(this.widths)); }
		catch (e) { /* private mode: widths simply do not persist */ }
	},

	applyWidths() {
		const root = document.documentElement;
		for (const c of COLUMNS) {
			const w = this.widths[c.key];
			if (w > 0) root.style.setProperty('--tf-w-' + c.key, w + 'px');
			else root.style.removeProperty('--tf-w-' + c.key);
		}
	},

	resetWidths() {
		this.widths = {};
		this.saveWidths();
		this.applyWidths();
		this.syncResizeStrip();
	},

	/* ------------------------------------------------------------------
	 * resize strip: one continuous rule, a dot at every column split, the
	 * column name sitting in the gap. Doubles as the always-visible column
	 * legend, since the per-table header rows scroll away.
	 * ---------------------------------------------------------------- */

	buildResizeStrip() {
		const self = this;
		const cols = this.activeColumns();
		const kids = [ E('span', { class: 'tf-rs-dot tf-rs-end' }) ];

		this.stripCells = {};

		cols.forEach((c, i) => {
			/* Left-aligned to match the table cells: label first, then the rule
			   running out to the next dot. */
			const cell = E('span', { class: 'tf-rs-cell', 'data-key': c.key }, [
				E('span', { class: 'tf-rs-label' }, c.label || c.key),
				E('i', { class: 'tf-rs-line' })
			]);
			this.stripCells[c.key] = cell;
			kids.push(cell);

			const last = (i === cols.length - 1);
			const dot = E('span', {
				class: 'tf-rs-dot' + (last ? ' tf-rs-end' : ' tf-rs-handle'),
				'data-key': c.key,
				tabindex: last ? null : '0',
				role: last ? null : 'separator',
				title: last ? null :
					_('Drag to resize “%s”. Double-click to reset. Arrow keys also work.').format(c.label || c.key)
			});
			if (!last) {
				dot.addEventListener('pointerdown', ev => self.beginResize(ev, c.key));
				dot.addEventListener('dblclick', () => {
					delete self.widths[c.key];
					self.saveWidths(); self.applyWidths(); self.syncResizeStrip();
				});
				dot.addEventListener('keydown', ev => self.keyResize(ev, c.key));
			}
			kids.push(dot);
		});

		this.stripEl = E('div', {
			class: 'tf-resize',
			role: 'group',
			'aria-label': _('Column widths')
		}, kids);

		return this.stripEl;
	},

	/* Mirror the real rendered table rather than recomputing its geometry, so
	   the dots sit exactly on the column edges whatever units the stylesheet
	   used. */
	syncResizeStrip() {
		if (!this.stripEl || !this.stripCells) return;

		const table = document.querySelector('.tf-table');
		if (!table) return;

		const ths = table.querySelectorAll('.th');
		let matched = 0;

		for (const th of ths) {
			const m = (th.className || '').match(/tf-col-([a-z_]+)/);
			if (!m) continue;
			const cell = this.stripCells[m[1]];
			if (!cell) continue;
			const w = Math.round(th.getBoundingClientRect().width);
			if (w > 0) { cell.style.width = w + 'px'; matched++; }
		}

		/* Align to the first header cell, measured from the strip's own current
		   position. Measuring against the toolbar instead double-counted the
		   toolbar's padding; zeroing the margin first makes this idempotent
		   rather than drifting a little further on every sync. */
		/* Anchor on the first *resizable* column, not the first cell: the drag
		   handle column sits ahead of them and is not represented in the
		   strip. */
		const firstKey = (this.activeColumns()[0] || {}).key;
		const anchor = firstKey
			? Array.prototype.find.call(ths, th => (th.className || '').indexOf('tf-col-' + firstKey) >= 0)
			: null;

		if (matched && anchor) {
			this.stripEl.style.marginLeft = '0px';
			const dx = Math.round(anchor.getBoundingClientRect().left -
				this.stripEl.getBoundingClientRect().left);
			this.stripEl.style.marginLeft = dx + 'px';
		}
	},

	beginResize(ev, key) {
		const th = document.querySelector('.tf-col-' + key);
		if (!th) return;

		ev.preventDefault();

		const startX = ev.clientX;
		const startW = Math.round(th.getBoundingClientRect().width);
		const self = this;

		const move = (e) => {
			const w = Math.max(MIN_COL_PX, startW + (e.clientX - startX));
			self.widths[key] = w;
			self.applyWidths();
			self.syncResizeStrip();
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			document.body && document.body.classList.remove('tf-resizing');
			self.saveWidths();
		};

		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		document.body && document.body.classList.add('tf-resizing');
	},

	keyResize(ev, key) {
		const step = ev.shiftKey ? 24 : 8;
		let d = 0;
		if (ev.key === 'ArrowLeft') d = -step;
		else if (ev.key === 'ArrowRight') d = step;
		else if (ev.key === 'Home') { delete this.widths[key]; }
		else return;

		ev.preventDefault();

		if (d) {
			const th = document.querySelector('.tf-col-' + key);
			const cur = this.widths[key] ||
				(th ? Math.round(th.getBoundingClientRect().width) : MIN_COL_PX);
			this.widths[key] = Math.max(MIN_COL_PX, cur + d);
		}
		this.saveWidths();
		this.applyWidths();
		this.syncResizeStrip();
	},

	/* ------------------------------------------------------------------
	 * staged changes -> sticky header turns red
	 * ---------------------------------------------------------------- */

	hookChangeIndicator() {
		if (ui.changes.__tfHooked) return;
		ui.changes.__tfHooked = true;

		const orig = ui.changes.setIndicator;
		const self = this;
		ui.changes.setIndicator = function (n) {
			orig.call(this, n);
			self.paintDirty(n);
		};
	},

	paintDirty(n) {
		if (!this.headerEl || !this.changeInfoEl) return;

		this.headerEl.classList.toggle('tf-dirty', n > 0);

		/* applied or reverted: nothing is pending any more */
		if (n === 0 && this.changedSids && this.changedSids.size) {
			this.touched = new Set();
			this.changedSids = new Set();
			if (this.groupsEl) this.renderGroups();
		}
		dom.content(this.changeInfoEl, n > 0
			? [ E('strong', {}, '⚠ ' + _('%d unsaved change(s)').format(n)) ]
			: [ E('span', {}, _('No pending changes')) ]);

		for (const b of [ this.applyBtn, this.revertBtn ])
			if (b) b.disabled = !(n > 0);
	},

	/* Which rules carry a staged change.
	 *
	 * The changeset alone is not enough: a single drag makes uci.js reorder the
	 * whole config, and the server records one `order` record *per section* -
	 * measured on the lab box, reordering six rules produced six order records.
	 * Marking all of those would light up the entire page and say nothing. So
	 * order records are ignored and moved rules are tracked locally instead,
	 * while set/add/remove are read from the changeset so edits made on another
	 * page still show up here.
	 */
	markTouched(sid) {
		(this.touched || (this.touched = new Set())).add(sid);
	},

	refreshChangeIndicator() {
		const self = this;
		return uci.changes().then(c => {
			const sids = new Set(self.touched || []);

			for (const rec of ((c || {}).firewall || [])) {
				if (rec[0] === 'order') continue;
				if (rec[1]) sids.add(rec[1]);
			}

			self.changedSids = sids;
			ui.changes.renderChangeIndicator(c);
		});
	},

	/* uci.set stages locally; uci.save() pushes it into the session change set
	 * that Save & Apply (and its rollback) operates on. */
	stage(fn) {
		fn();
		return uci.save().then(() => this.refreshChangeIndicator());
	},

	/* ------------------------------------------------------------------
	 * header
	 * ---------------------------------------------------------------- */

	renderHeader(model) {
		const self = this;

		const datalist = E('datalist', { id: 'tf-suggest' },
			fwsearch.suggestions(model).slice(0, 400).map(s =>
				E('option', { value: s.value }, s.hint ? String(s.hint) : null)));

		const input = E('input', {
			type: 'search',
			class: 'tf-search',
			list: 'tf-suggest',
			placeholder: _('Search host, IP, port, service, zone or name — highlights, never hides'),
			value: this.query || ''
		});

		input.addEventListener('input', () => {
			self.query = input.value;
			self.renderGroups();
		});

		const count = E('span', { class: 'tf-match-count' }, '');

		/* Only meaningful while searching, so they are not shown otherwise —
		   a permanently visible pair of unlabelled arrows that does nothing
		   invites exactly the question "what are these for?". */
		const prev = E('button', {
			class: 'btn cbi-button tf-nav',
			title: _('Jump to the previous match')
		}, '↑');
		const next = E('button', {
			class: 'btn cbi-button tf-nav',
			title: _('Jump to the next match')
		}, '↓');
		prev.addEventListener('click', () => self.jumpMatch(-1));
		next.addEventListener('click', () => self.jumpMatch(1));
		this.navBtns = [ prev, next ];

		const columns = E('button', { class: 'btn cbi-button' }, '▦ ' + _('Columns'));
		columns.addEventListener('click', ui.createHandlerFn(this, 'showColumnPicker'));

		const info = E('span', { class: 'tf-change-info' }, _('No pending changes'));

		const revert = E('button', { class: 'btn cbi-button tf-revert', disabled: true },
			_('Revert'));
		revert.addEventListener('click', () => ui.changes.revert());

		/* apply(true) is the *checked* apply: it rolls back unless confirmed
		 * from a still-connected browser. The unchecked variant is never
		 * offered here — a bad rule can cut the session that would confirm. */
		const apply = E('button', { class: 'btn cbi-button cbi-button-action important tf-apply', disabled: true },
			_('Save & Apply'));
		apply.addEventListener('click', () => ui.changes.apply(true));

		this.searchInputEl = input;

		this.familyBtns = [4, 6].map(f => {
			const on = this.families.indexOf(f) >= 0;
			const b = E('button', {
				class: 'btn cbi-button tf-fam' + (on ? ' cbi-button-action' : ''),
				'data-family': String(f),
				'aria-pressed': on ? 'true' : 'false',
				title: _('Show or hide IPv%d rules. At least one family stays on.').format(f)
			}, f === 4 ? 'IPv4' : 'IPv6');
			b.addEventListener('click', () => {
				if (!self.toggleFamily(f)) return;
				self.familyBtns.forEach(x => {
					const sel = self.families.indexOf(+x.getAttribute('data-family')) >= 0;
					x.classList.toggle('cbi-button-action', sel);
					x.setAttribute('aria-pressed', sel ? 'true' : 'false');
				});
				self.renderGroups();
			});
			return b;
		});

		this.matchCountEl = count;
		this.changeInfoEl = info;
		this.applyBtn = apply;
		this.revertBtn = revert;

		/* Three things can be added now, so Add is a menu rather than a
		   button that has to guess which one you meant. */
		const add = E('button', {
			class: 'btn cbi-button cbi-button-add',
			title: _('Add a rule, port forward or NAT rule'),
			'aria-haspopup': 'menu'
		}, '+ ' + _('Add') + ' ▾');
		add.addEventListener('click', (ev) => {
			ev.stopPropagation();
			self.openAddMenu(add);
		});

		/* Count and arrows sit inside the field, right aligned, the way a
		   browser's find bar does — that association is what makes them
		   legible without a label. */
		this.searchToolsEl = E('div', { class: 'tf-search-tools' }, [ count, prev, next ]);

		this.headerEl = E('div', { class: 'tf-header' }, [
			E('div', { class: 'tf-actions' }, [ add ]),
			E('div', { class: 'tf-search-wrap' }, [ input, datalist, this.searchToolsEl ]),
			E('div', { class: 'tf-actions tf-tabs' }, this.familyBtns),
			E('div', { class: 'tf-actions' }, [ columns ]),
			E('div', { class: 'tf-actions' }, [ info, revert, apply ]),
			this.buildResizeStrip()
		]);

		return this.headerEl;
	},

	showColumnPicker() {
		const self = this;
		const boxes = COLUMNS.map(c => {
			const cb = E('input', {
				type: 'checkbox',
				checked: this.visible[c.key] ? '' : null,
				disabled: c.key === 'name' ? '' : null
			});
			cb.addEventListener('change', () => {
				self.visible[c.key] = cb.checked;
				self.saveColumns();
				self.renderGroups();
			});
			return E('label', { class: 'tf-col-opt' }, [
				cb, ' ', c.label || c.key,
				c.dflt ? E('span', { class: 'tf-badge' }, _('default')) : ''
			]);
		});

		ui.showModal(_('Columns'), [
			E('p', {}, _('Hiding a column never hides that a rule has extra match criteria — any rule with values in hidden columns is marked in its row.')),
			E('div', { class: 'tf-col-grid' }, boxes),
			E('div', { class: 'right' }, [
				E('button', {
					class: 'btn cbi-button',
					click: ui.createHandlerFn(this, 'resetWidths')
				}, _('Reset widths')), ' ',
				E('button', { class: 'btn cbi-button', click: ui.hideModal }, _('Close'))
			])
		]);
	},

	/* ------------------------------------------------------------------
	 * add / edit
	 * ---------------------------------------------------------------- */

	openAddMenu(btn) {
		this.closeRowMenu();

		const self = this;
		const item = (label, kind) => {
			const b = E('button', { class: 'tf-menu-item' }, label);
			b.addEventListener('click', () => { self.closeRowMenu(); self.handleAdd(kind); });
			return b;
		};

		const menu = E('div', { class: 'tf-menu', role: 'menu' }, [
			item('✅ ' + _('Traffic rule'), 'rule'),
			item('➡️ ' + _('Port forward (DNAT)'), 'redirect'),
			item('⬅️ ' + _('NAT rule (SNAT / MASQUERADE)'), 'nat')
		]);

		const r = btn.getBoundingClientRect();
		menu.style.position = 'fixed';
		menu.style.top = Math.round(r.bottom + 2) + 'px';
		menu.style.left = Math.round(Math.max(4, r.left)) + 'px';

		document.body.appendChild(menu);
		this._menu = menu;

		this._menuDismiss = (ev) => {
			if (menu.contains && menu.contains(ev.target)) return;
			self.closeRowMenu();
		};
		this._menuKey = (ev) => { if (ev.key === 'Escape') self.closeRowMenu(); };
		setTimeout(() => {
			document.addEventListener('mousedown', self._menuDismiss);
			document.addEventListener('keydown', self._menuKey);
		}, 0);
	},

	handleAdd(kind) {
		const type = kind || 'rule';
		const defaults = {
			rule:     { target: 'ACCEPT', enabled: '1' },
			redirect: { target: 'DNAT', enabled: '1' },
			nat:      { target: 'MASQUERADE', enabled: '1' }
		}[type];

		const sid = fweditor.create(this.model, defaults, type);
		return fweditor.open(this.model, sid, true, type).then(saved => {
			if (saved) this.markTouched(sid);
			return saved ? this.reload() : this.refreshChangeIndicator();
		});
	},

	/* ------------------------------------------------------------------
	 * reordering
	 *
	 * The global ordered rule list is the source of truth; the groups are a
	 * projection of it. A drop resolves to uci.move(), which renumbers local
	 * state immediately and stages a `uci reorder` change, so the move shows
	 * up in the table at once and inherits Save & Apply's rollback.
	 * ---------------------------------------------------------------- */

	beginDrag(ev, entry, group, bucket) {
		this._drag = {
			sid: entry.rule.sid,
			chain: entry.rule.chain || null,
			shadow: !!entry.shadow,
			wildcard: !!entry.rule.wildcard,
			name: entry.rule.name,
			group: group.key,
			bucket: bucket
		};

		if (ev.dataTransfer) {
			ev.dataTransfer.effectAllowed = 'move';
			/* some browsers refuse to start a drag without payload */
			try { ev.dataTransfer.setData('text/plain', entry.rule.sid); } catch (e) {}
			const tr = ev.target && ev.target.closest ? ev.target.closest('tr') : null;
			if (tr && ev.dataTransfer.setDragImage) ev.dataTransfer.setDragImage(tr, 12, 12);
		}
	},

	endDrag() {
		this._drag = null;
		document.querySelectorAll('.tf-drop-before, .tf-drop-after').forEach(
			el => el.classList.remove('tf-drop-before', 'tf-drop-after'));
	},

	/* A drop is only meaningful inside the same group and the same bucket:
	   moving a rule to another zone pair would mean changing its zones, which
	   is an edit rather than a move, and filter and mangle rules are not
	   ordered against each other at all. */
	dropAllowed(group, bucket, targetChain) {
		const d = this._drag;
		if (!d || d.bucket !== bucket) return false;

		/* NAT rows are shown beside the zone pair they affect, but they are
		   ordered against every rule in their chain — a forward to DMZ and one
		   to production share dstnat_<src>. So for NAT the chain is what
		   bounds a move, not the group it happens to be displayed in. */
		if (bucket.indexOf('nat') === 0)
			return !!targetChain && targetChain === d.chain;

		return d.group === group.key;
	},

	trackDropTarget(ev, tr, group, bucket) {
		if (!this.dropAllowed(group, bucket, tr.getAttribute('data-chain'))) return false;
		if (tr.getAttribute('data-sid') === this._drag.sid) return false;

		ev.preventDefault();
		if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';

		const r = tr.getBoundingClientRect();
		const after = (ev.clientY - r.top) > (r.height / 2);

		tr.classList.remove('tf-drop-before', 'tf-drop-after');
		tr.classList.add(after ? 'tf-drop-after' : 'tf-drop-before');
		this._dropAfter = after;
		return true;
	},

	handleDrop(ev, tr, group, bucket) {
		if (!this.dropAllowed(group, bucket, tr.getAttribute('data-chain'))) return;

		ev.preventDefault();

		const from = this._drag;
		const toSid = tr.getAttribute('data-sid');
		const after = !!this._dropAfter;

		this.endDrag();

		if (!toSid || toSid === from.sid) return;

		/* Moving a shadow copy moves the one underlying rule, so it changes
		   position in every group it appears in. Say so before doing it. */
		if (from.wildcard) {
			const self = this;
			ui.showModal(_('Move a wildcard rule'), [
				E('p', {}, _('“%s” uses a wildcard zone and is shown in several groups.').format(from.name)),
				E('p', {}, _('Moving it here changes its position in all of them, because they are the same rule.')),
				E('p', { class: 'tf-muted' }, _('Using “any zone” is not recommended for this reason — a wildcard rule pre-empts rules across every zone pair it spans. Naming the zone explicitly keeps the evaluation order readable.')),
				E('div', { class: 'right' }, [
					E('button', { class: 'btn cbi-button', click: ui.hideModal }, _('Cancel')), ' ',
					E('button', {
						class: 'btn cbi-button cbi-button-action important',
						click: () => { ui.hideModal(); self.applyMove(from.sid, toSid, after); }
					}, _('Move it'))
				])
			]);
			return;
		}

		this.applyMove(from.sid, toSid, after);
	},

	applyMove(sid, refSid, after) {
		const self = this;
		if (!uci.move('firewall', sid, refSid, after)) {
			ui.addNotification(null, E('p', {}, _('Could not move the rule.')), 'warning');
			return Promise.resolve();
		}
		self.markTouched(sid);
		return uci.save().then(() => self.reload());
	},

	/* A popup rather than a modal for three items, but appended to <body> and
	   positioned fixed: the row lives inside .tf-scroll, whose overflow would
	   otherwise clip an absolutely-positioned menu. */
	openRowMenu(btn, entry) {
		this.closeRowMenu();

		const self = this;
		const rule = entry.rule;
		const item = (label, fn, cls) => {
			const b = E('button', { class: 'tf-menu-item ' + (cls || '') }, label);
			b.addEventListener('click', () => { self.closeRowMenu(); fn(); });
			return b;
		};

		const menu = E('div', { class: 'tf-menu', role: 'menu' }, [
			item('✎ ' + _('Edit…'), () => self.handleEdit(rule.sid, rule.section)),
			item('⧉ ' + _('Duplicate…'), () => self.handleClone(rule)),
			item('🗑 ' + _('Delete…'), () => self.handleDelete(rule), 'tf-menu-danger')
		]);

		const r = btn.getBoundingClientRect();
		menu.style.position = 'fixed';
		menu.style.top = Math.round(r.bottom + 2) + 'px';
		menu.style.left = Math.round(Math.max(4, r.right - 190)) + 'px';

		document.body.appendChild(menu);
		this._menu = menu;

		this._menuDismiss = (ev) => {
			if (menu.contains && menu.contains(ev.target)) return;
			self.closeRowMenu();
		};
		this._menuKey = (ev) => { if (ev.key === 'Escape') self.closeRowMenu(); };

		setTimeout(() => {
			document.addEventListener('mousedown', self._menuDismiss);
			document.addEventListener('keydown', self._menuKey);
		}, 0);
	},

	closeRowMenu() {
		if (this._menuDismiss) document.removeEventListener('mousedown', this._menuDismiss);
		if (this._menuKey) document.removeEventListener('keydown', this._menuKey);
		this._menuDismiss = this._menuKey = null;
		if (this._menu && this._menu.parentNode)
			this._menu.parentNode.removeChild(this._menu);
		this._menu = null;
	},

	/* Duplicate lands immediately after the original, so the copy is in the
	   same group at the position the user was looking at, and opens the editor
	   straight away: leaving two byte-identical rules behind would be both
	   confusing and pointless. Cancelling removes the copy again. */
	handleClone(rule) {
		const src = rule.raw || {};
		const copy = {};
		for (const k in src) {
			if (k.charAt(0) === '.') continue;
			copy[k] = src[k];
		}
		copy.name = (rule.name || _('rule')) + ' ' + _('(copy)');

		/* Clone the *same section type*: duplicating a port forward has to
		   produce another config redirect, not a config rule. Getting this
		   wrong silently turns a DNAT into a traffic rule, which then appears
		   in a different part of the page. */
		const section = rule.section || 'rule';
		const sid = fweditor.create(this.model, copy, section);
		uci.move('firewall', sid, rule.sid, true);

		return fweditor.open(this.model, sid, true, section).then(saved => {
			if (saved) this.markTouched(sid);
			return saved ? this.reload() : this.refreshChangeIndicator();
		});
	},

	handleDelete(rule) {
		const self = this;

		ui.showModal(_('Delete rule'), [
			E('p', {}, _('Delete “%s”?').format(rule.name)),
			rule.wildcard
				? E('p', { class: 'alert-message warning' },
					_('This rule uses a wildcard zone, so it is shown in several groups. Deleting it removes it from all of them.'))
				: '',
			E('p', { class: 'tf-muted' },
				_('The change is staged — nothing is applied until you press Save & Apply.')),
			E('div', { class: 'right' }, [
				E('button', { class: 'btn cbi-button', click: ui.hideModal }, _('Cancel')), ' ',
				E('button', {
					class: 'btn cbi-button cbi-button-negative important',
					click: () => {
						ui.hideModal();
						uci.remove('firewall', rule.sid);
						uci.save().then(() => self.reload());
					}
				}, _('Delete'))
			])
		]);
	},

	handleEdit(sid, section) {
		return fweditor.open(this.model, sid, false, section || 'rule').then(saved => {
			if (saved) this.markTouched(sid);
			return saved ? this.reload() : this.refreshChangeIndicator();
		});
	},

	/* Re-read the config so the table reflects the edit, including any change
	   of zone that moves the rule into a different group. */
	reload() {
		const self = this;
		return fwmodel.load().then(model => {
			self.model = model;
			/* the changed set must be known before rendering, not after */
			return self.refreshChangeIndicator();
		}).then(() => self.renderGroups());
	},

	/* ------------------------------------------------------------------
	 * cells
	 * ---------------------------------------------------------------- */

	/* Same markup and colour source as the stock firewall pages, so a zone
	   looks identical everywhere in the UI. getZoneColorStyle takes the zone
	   name; null means the device itself and '*' means any zone. */
	zoneChip(name, noWarn) {
		const z = (name == null || name === fwmodel.DEVICE) ? null : name;
		return E('span', {
			class: 'zonebadge',
			style: fwstock.getZoneColorStyle(z)
		}, [
			(z === fwmodel.ANY)
				? E('em', {
					/* A NAT rule's source really is unconstrained — that is
					   the section type, not a risky choice — so it gets a
					   plain label rather than the wildcard warning. */
					title: noWarn
						? _('Not constrained to a zone; only the source address narrows it.')
						: _('Matches every zone. Not recommended: such a rule is evaluated against traffic in every zone pair it spans and can pre-empt rules further down. Naming the zone keeps the evaluation order readable.')
				}, _('any zone'))
				: (z ? E('strong', {}, z) : E('em', {}, _('this device')))
		]);
	},

	zoneCell(name, model) {
		return this.zoneChip(name);
	},

	protoCell(rule) {
		const protos = rule.proto.filter(p => p !== 'all');
		if (!protos.length) return E('span', { class: 'tf-muted' }, _('any'));
		return E('span', {}, protos.join(', '));
	},

	/* Ports only — the protocol has its own column. ICMP types stay here
	   because they are the "what", the same slot a port occupies. */
	serviceCell(rule, model) {
		const protos = rule.proto.filter(p => p !== 'all');
		const ports = rule.destPort;
		const bits = [];

		for (const spec of ports) {
			for (const part of String(spec).split(/[\s,]+/)) {
				const named = /^\d+$/.test(part)
					? model.serviceName(+part, protos[0] || 'tcp') : null;
				bits.push(part + (named ? ' (' + named + ')' : ''));
			}
		}

		if (rule.icmpType.length)
			bits.push(rule.icmpType.join(', '));

		if (!bits.length)
			return E('span', { class: 'tf-muted' }, _('any'));

		return E('span', {}, bits.join('  '));
	},

	cellValue(key, rule, model) {
		const raw = rule.raw || {};

		switch (key) {
			case 'name':    return E('span', { class: 'tf-name' }, rule.name);
			case 'src':     return this.zoneChip(rule.src, rule.zoneNoWarn);
			case 'dest':    return this.zoneChip(rule.dest, rule.zoneNoWarn);
			/* For a NAT rule the interesting address is what it rewrites to,
			   so it is shown in the cell for the end being rewritten, marked
			   with an arrow so it is never mistaken for a match criterion. */
			case 'src_ip':  return (rule.hook === 'srcnat')
				? this.rewriteCell(rule, model, rule.srcIp)
				: this.addrCell(rule.srcIp, model);
			case 'dest_ip': return (rule.hook === 'dstnat')
				? this.rewriteCell(rule, model, rule.destIp)
				: this.addrCell(rule.destIp, model);
			case 'proto':   return this.protoCell(rule);
			case 'service': return this.serviceCell(rule, model);
			case 'target': {
				const t = (rule.kind === 'redirect') ? 'REDIRECT' : rule.target;
				return E('span', {}, [
					(ACTION_EMOJI[t] || '•') + ' ', ACTION_LABEL[t] || t ]);
			}
			case 'src_port': return E('span', {}, joinOrDash(rule.srcPort) || '—');
			case 'family':  return this.familyCell(rule);
			case 'chain':   return E('code', {}, rule.chain);
			case 'sid':     return E('code', {}, rule.sid);
			case 'time': {
				const t = ['weekdays', 'monthdays', 'start_time', 'stop_time', 'start_date', 'stop_date']
					.map(k => joinOrDash(raw[k])).filter(Boolean);
				return E('span', {}, t.length ? t.join(' ') : '—');
			}
			case 'limit':   return E('span', {}, joinOrDash(raw.limit) || '—');
			case 'log':     return E('span', {}, raw.log ? '📝' : '—');
			case 'mark':    return E('span', {}, joinOrDash(raw.mark || raw.set_mark || raw.set_xmark) || '—');
			case 'dscp':    return E('span', {}, joinOrDash(raw.dscp || raw.set_dscp) || '—');
			case 'helper':  return E('span', {}, joinOrDash(raw.helper || raw.set_helper) || '—');
			case 'ipset':   return E('span', {}, joinOrDash(raw.ipset) || '—');
			case 'device':  return E('span', {}, joinOrDash(raw.device) || '—');
			case 'extra':   return E('code', {}, joinOrDash(raw.extra) || '—');
		}
		return E('span', {}, '');
	},

	/* Two fixed slots: IPv4 always left, IPv6 always right. A dual-stack rule
	   fills both; a pinned rule leaves the other slot empty but still
	   occupied, so position alone tells you the family down a long column. */
	familyCell(rule) {
		const both = !rule.family;
		const slot = (fam) => {
			const on = both || rule.family === fam;
			return E('span', {
				class: 'tf-ipv tf-ipv' + fam + (on ? '' : ' tf-ipv-off'),
				title: on
					? _('Applies to IPv%d (%s)').format(fam, rule.familyBy)
					: _('Does not apply to IPv%d').format(fam)
			}, 'v' + fam);
		};
		return E('span', { class: 'tf-ipv-pair' }, [ slot(4), slot(6) ]);
	},

	rewriteCell(rule, model, matchList) {
		const bits = [];

		if (rule.hook === 'dstnat') {
			/* dest_ip on a redirect is the rewrite target, not a match */
			const to = rule.rewriteIp
				? rule.rewriteIp + (rule.rewritePort ? ':' + rule.rewritePort : '')
				: _('this device');
			bits.push(E('span', { class: 'tf-rewrite' }, '→ ' + to));
		}
		else {
			if (matchList && matchList.length)
				bits.push(this.addrCell(matchList, model));
			const to = rule.rewriteIp
				? rule.rewriteIp + (rule.rewritePort ? ':' + rule.rewritePort : '')
				: (rule.target === 'MASQUERADE' ? _('interface address') : null);
			if (to) bits.push(E('span', { class: 'tf-rewrite' }, '→ ' + to));
		}

		if (!bits.length) return E('span', { class: 'tf-muted' }, _('any'));
		return E('span', {}, bits);
	},

	addrCell(list, model) {
		if (!list || !list.length)
			return E('span', { class: 'tf-muted' }, _('any'));

		const INLINE = 2;
		const out = [];

		for (const v of list) {
			/* An address can carry several names — one host serving several
			   sites is ordinary. Show the first couple inline and put the rest
			   behind a badge, rather than picking one arbitrarily or letting a
			   long list crowd out the address itself. */
			const names = model.namesFor(v);
			const shown = names.slice(0, INLINE);
			const rest = names.slice(INLINE);

			out.push(E('span', { class: 'tf-addr' }, [
				v,
				shown.length
					? E('span', { class: 'tf-muted' }, ' ' + shown.join(', '))
					: '',
				rest.length
					? E('span', {
						class: 'tf-badge tf-mark-names',
						title: _('Also known as: %s').format(rest.join(', '))
					}, '+' + rest.length)
					: ''
			]));
		}
		return E('span', {}, out);
	},

	/* ------------------------------------------------------------------
	 * groups
	 * ---------------------------------------------------------------- */

	renderRow(entry, model, position, terms, api, group, bucket) {
		const rule = entry.rule;
		const cols = this.activeColumns();
		const cls = ['tr', 'tf-row'];

		if (!rule.enabled) cls.push('tf-row-disabled');
		if (entry.shadow) cls.push('tf-row-shadow');

		const pending = !!(this.changedSids && this.changedSids.has(rule.sid));
		if (pending) cls.push('tf-row-changed');

		const hits = terms.length ? fwsearch.match(model, rule, terms, api) : null;
		if (hits) cls.push('tf-row-match');

		/* criteria that exist but are not on screen */
		const extras = model.extraCriteria(rule)
			.filter(e => !this.visible[e.key] &&
				!(e.key === 'icmp_type' && this.visible['service']));

		const self = this;
		const handle = E('span', {
			class: 'tf-handle',
			draggable: 'true',
			title: _('Drag to reorder within this group')
		}, '⠿');

		const tds = [ E('td', { class: 'td tf-c-handle' }, handle) ].concat(cols.map(c => {
			const td = E('td', { class: 'td tf-col-' + c.key + ' ' + (c.cls || '') }, [
				c.key === 'pos' ? String(position) :
				c.key === 'enabled' ? this.enabledToggle(rule) :
				this.cellValue(c.key, rule, model)
			]);
			if (hits && hits.has(c.key)) td.classList.add('tf-cell-hit');
			return td;
		}));

		/* marker column: shadow origin and hidden criteria */
		const marks = [];
		if (entry.shadow)
			marks.push(E('span', {
				class: 'tf-badge tf-mark-shadow',
				title: _('Shown here because it uses a wildcard zone, so it applies across zone pairs. Editing, moving or deleting it here affects every group it appears in. Using “any zone” is not recommended: a wildcard rule can pre-empt rules further down that look unrelated to it — naming the zone keeps the evaluation order readable.')
			}, '✳'));

		/* A port forward that an earlier one in the same dstnat chain already
		   swallows will never fire. Flagged here because rendering forwards
		   beside their destination pair is the one thing that could hide it. */
		if (rule.hook === 'dstnat') {
			const clash = model.conflictingForwards(rule);
			if (clash.length)
				marks.push(E('span', {
					class: 'tf-badge tf-mark-clash',
					title: _('Never matches: %s earlier in %s already matches this traffic.')
						.format(clash.map(c => '“' + c.name + '”').join(', '), rule.chain)
				}, '⚠'));
		}

		if (pending)
			marks.push(E('span', {
				class: 'tf-badge tf-mark-pending',
				title: _('This rule has unsaved changes. Save & Apply to keep them, Revert to discard.')
			}, '✎'));

		if (extras.length)
			marks.push(E('span', {
				class: 'tf-badge tf-mark-extra',
				title: _('%d further match criteria not shown: %s').format(
					extras.length, extras.map(e => e.key + '=' + e.value).join(', '))
			}, '+' + extras.length));

		tds.push(E('td', { class: 'td tf-c-marks' }, marks));

		const menuBtn = E('button', {
			class: 'tf-menu-btn',
			title: _('Rule actions'),
			'aria-haspopup': 'menu'
		}, '⋯');
		menuBtn.addEventListener('click', (ev) => {
			ev.stopPropagation();
			this.openRowMenu(menuBtn, entry);
		});
		tds.push(E('td', { class: 'td tf-c-actions' }, menuBtn));

		const tr = E('tr', {
			class: cls.join(' '),
			'data-sid': rule.sid,
			'data-chain': rule.chain || '',
			title: _('Double-click to edit')
		}, tds);
		if (hits) tr.setAttribute('data-match', '1');

		if (group) {
			handle.addEventListener('dragstart', ev => self.beginDrag(ev, entry, group, bucket));
			handle.addEventListener('dragend', () => self.endDrag());
			tr.addEventListener('dragover', ev => self.trackDropTarget(ev, tr, group, bucket));
			tr.addEventListener('dragleave', () =>
				tr.classList.remove('tf-drop-before', 'tf-drop-after'));
			tr.addEventListener('drop', ev => self.handleDrop(ev, tr, group, bucket));
		}

		tr.addEventListener('dblclick', (ev) => {
			/* let the enabled checkbox keep its own double-click */
			if (ev.target && ev.target.tagName === 'INPUT') return;
			self.handleEdit(rule.sid, rule.section);
		});

		return tr;
	},

	enabledToggle(rule) {
		const self = this;
		const cb = E('input', {
			type: 'checkbox',
			checked: rule.enabled ? '' : null,
			title: rule.enabled ? _('Enabled') : _('Disabled')
		});
		cb.addEventListener('change', () => {
			self.markTouched(rule.sid);
			self.stage(() => {
				uci.set('firewall', rule.sid, 'enabled', cb.checked ? '1' : '0');
				rule.enabled = cb.checked;
			}).then(() => self.renderGroups());
		});
		return cb;
	},

	renderGroup(group, model, terms, api) {
		const cols = this.activeColumns();
		const label = () => E('span', { class: 'tf-pair' }, [
			this.zoneChip(group.src),
			E('span', { class: 'tf-arrow' }, '→'),
			this.zoneChip(group.dest)
		]);

		/* A pair with no filter rules can still be where NAT happens — source
		   NAT applies to everything leaving that destination zone whether or
		   not a rule was written for the pair. Collapsing such a pair to a
		   one-line "no rules" stub counted the NAT in the zone summary and
		   then never showed it. */
		const pairNat = model.natForPair(group.src, group.dest);
		const hasNat = pairNat.dnat.length > 0 || pairNat.snat.length > 0;

		if (!group.rules.length && !(group.otherRules || []).length && !hasNat) {
			return E('div', { class: 'tf-group tf-group-empty' }, [
				E('div', { class: 'tf-group-head' }, [
					label(),
					E('span', { class: 'tf-muted' }, _('no rules')),
					E('span', { class: 'tf-term' }, this.terminatorText(group))
				])
			]);
		}

		let matchCount = 0;
		const rows = group.rules.map((entry, i) => {
			const tr = this.renderRow(entry, model, i + 1, terms, api, group, 'filter');
			if (tr.getAttribute('data-match')) matchCount++;
			return tr;
		});

		const head = E('tr', { class: 'tr table-titles' },
			[ E('th', { class: 'th tf-c-handle' }, '') ].concat(
				cols.map(c => E('th', { class: 'th tf-col-' + c.key + ' ' + (c.cls || '') }, c.label)),
				[
					E('th', { class: 'th tf-c-marks' }, ''),
					E('th', { class: 'th tf-c-actions' }, '')
				]));

		const span = String(cols.length + 3);
		const nat = model.natForPair(group.src, group.dest);
		const famOkRule = r => this.inFamilies(r);
		const dnat = nat.dnat.filter(famOkRule);
		const snat = nat.snat.filter(famOkRule);

		/* the real end of the chain, so "matches nothing" is answerable */
		const term = E('tr', { class: 'tr tf-terminator' }, [
			E('td', { class: 'td', colspan: String(cols.length + 3) },
				this.terminatorText(group))
		]);

		const kids = [ head ];

		/* Port forwards land here before anything else: they run in
		   prerouting, and they are what creates the traffic these filter
		   rules then judge. Numbered by their true position in the dstnat
		   chain, because they are ordered against every forward sharing the
		   source zone, not just the ones shown here. */
		if (dnat.length) {
			kids.push(E('tr', { class: 'tr tf-nathead tf-nathead-dstnat' }, [
				E('td', { class: 'td', colspan: span }, [
					E('span', {}, '➡️ ' + _('Port forwards arriving here — prerouting, before the rules below')), ' ',
					E('code', { class: 'tf-muted' }, nat.dnatChain),
					E('span', { class: 'tf-muted' },
						' ' + _('· positions are within that chain, which holds %d in total')
							.format(dnat[0].chainTotal || dnat.length))
				])
			]));
			for (const r of dnat) {
				const tr = this.renderRow({ rule: r, shadow: false }, model,
					r.chainPos || 0, terms, api, group, 'dstnat');
				tr.classList.add('tf-row-nat');
				kids.push(tr);
			}
		}

		kids.push.apply(kids, rows);

		/* Rules on other hooks: real, but not part of the ordering above. They
		   get their own block and their own numbering so the filter sequence
		   is never misrepresented. */
		if (group.otherRules && group.otherRules.length) {
			kids.push(E('tr', { class: 'tr tf-otherhead' }, [
				E('td', { class: 'td', colspan: String(cols.length + 3) },
					'⚙ ' + _('Also matching this pair on other netfilter hooks (mangle / raw). These do not participate in the ordering above.'))
			]));
			group.otherRules.forEach((entry, i) => {
				const tr = this.renderRow(entry, model, i + 1, terms, api, group, 'other');
				tr.classList.add('tf-row-other');
				kids.push(tr);
			});
		}

		if (group.dnat)
			kids.push(E('tr', { class: 'tr tf-terminator' }, [
				E('td', { class: 'td', colspan: String(cols.length + 3) },
					'↳ ' + _('Port-forwarded traffic into %s is accepted before these policies (ct status dnat accept).').format(group.dest))
			]));

		kids.push(term);

		/* Source NAT applies on the way out of this pair's destination zone,
		   so it belongs after the verdict. It is keyed by egress zone alone,
		   so the same rules appear after every pair ending there — collapsed
		   by default and marked as shared, so it is present without becoming
		   noise. */
		if (snat.length || (group.dest !== fwmodel.DEVICE && model.zones[group.dest])) {
			/* The one verdict that differs by family: masq and masq6 are
			   separate zone options, so with both families shown the footer
			   must state both rather than quietly describing one. */
			const natTerms = this.families.map(f => ({
				family: f, term: model.natTerminatorFor(group.dest, 'srcnat', f)
			}));
			const masqFams = natTerms.filter(x => x.term.verdict === 'MASQUERADE')
				.map(x => x.family);
			const anyVerdict = natTerms.some(x => x.term.verdict !== 'NONE');
			const open = this.snatOpen && this.snatOpen[group.dest];

			if (snat.length || anyVerdict) {
				const self = this;
				const summary = E('tr', { class: 'tr tf-nathead tf-nathead-srcnat' }, [
					E('td', { class: 'td', colspan: span }, [
						E('span', { class: 'tf-caret' }, open ? '▾' : '▸'), ' ',
						E('span', {}, '⬅️ ' + _('Leaving via %s').format(group.dest)), ' ',
						E('span', { class: 'tf-badge' },
							snat.length ? _('%d NAT rules').format(snat.length) : _('no NAT rules')),
						masqFams.length
							? E('span', { class: 'tf-badge tf-badge-masq' },
								'🎭 ' + (masqFams.length === this.families.length
									? _('masquerade')
									: _('masquerade (IPv%d)').format(masqFams[0])))
							: '',
						E('span', { class: 'tf-muted' }, ' ' + _('shared by every pair ending here'))
					])
				]);
				summary.addEventListener('click', () => {
					self.snatOpen = self.snatOpen || {};
					self.snatOpen[group.dest] = !self.snatOpen[group.dest];
					self.renderGroups();
				});
				kids.push(summary);

				if (open) {
					for (const r of snat) {
						const tr = this.renderRow({ rule: r, shadow: false }, model,
							r.chainPos || 0, terms, api, group, 'srcnat');
						tr.classList.add('tf-row-nat');
						kids.push(tr);
					}
					/* One line when the families agree, one line each when they
					   do not — never a single line that speaks for both while
					   describing only one. */
					const sameForAll = natTerms.every(x =>
						x.term.verdict === natTerms[0].term.verdict &&
						x.term.reason === natTerms[0].term.reason);

					const line = (t, prefix) => E('tr', { class: 'tr tf-terminator' }, [
						E('td', { class: 'td', colspan: span },
							'↳ ' + (prefix || '') +
							_('Anything not matched above: %s%s — %s').format(
								ACTION_EMOJI[t.verdict] ? ACTION_EMOJI[t.verdict] + ' ' : '',
								t.verdict === 'NONE' ? _('no translation') : t.verdict,
								t.reason))
					]);

					if (sameForAll) kids.push(line(natTerms[0].term, ''));
					else for (const x of natTerms)
						kids.push(line(x.term, 'IPv' + x.family + ': '));
				}
			}
		}

		return E('div', { class: 'tf-group' }, [
			E('div', { class: 'tf-group-head' }, [
				label(),
				E('span', { class: 'tf-badge' }, _('%d rules').format(group.rules.length)),
				matchCount
					? E('span', { class: 'tf-badge tf-badge-match' }, _('%d matches').format(matchCount))
					: ''
			]),
			E('div', { class: 'tf-scroll' }, [
				E('table', { class: 'table tf-table' }, kids)
			])
		]);
	},

	terminatorText(group) {
		const t = group.terminator;
		return '↳ ' + _('Anything not matched above: %s%s — %s').format(
			ACTION_EMOJI[t.verdict] ? ACTION_EMOJI[t.verdict] + ' ' : '',
			t.verdict, t.reason);
	},

	renderGroups() {
		const model = this.model;
		const api = fwmodel;
		const terms = fwsearch.parse(model, this.query);


		const container = this.groupsEl;
		if (!container) return;

		const kids = [];
		let shown = 0;

		/* a rule with no declared family is dual-stack and appears in both
		 * tabs; one pinned to a family appears only in its own */
		const famOk = e => this.inFamilies(e.rule);
		const famOkRule = r => this.inFamilies(r);

		/* Ordered as a packet actually travels: destination NAT first
		   (prerouting), then the filter rules for each zone pair, then source
		   NAT (postrouting). Separate tabs can never show that sequence. */
		for (const src of model.zoneOrder.concat([fwmodel.DEVICE])) {
			const groups = model.groups.filter(g => g.src === src);
			const nat = model.natByZone[src] || { dstnat: [], srcnat: [] };
			if (!groups.length && !nat.dstnat.length) continue;

			const sum = this.zoneSummary(model, src, this.families);
			const self = this;

			/* A fold must never hide a search hit, for the same reason search
			   never hides a row: what you cannot see, you cannot reason about. */
			const hasHit = terms.length && groups.some(g =>
				g.rules.concat(g.otherRules || []).some(e =>
					famOk(e) && fwsearch.match(model, e.rule, terms, api)));

			const folded = !!(this.folded && this.folded[src]) && !hasHit;

			const badge = (n, label, cls) => n
				? E('span', { class: 'tf-badge ' + (cls || '') }, n + ' ' + label)
				: '';

			const head = E('div', {
				class: 'tf-zone-head' + (folded ? ' tf-folded' : ''),
				title: _('Click to fold or unfold this zone')
			}, [
				E('span', { class: 'tf-caret' }, folded ? '▸' : '▾'),
				this.zoneChip(src),
				E('span', { class: 'tf-muted' }, _('as source')),
				E('span', { class: 'tf-zone-counts' }, [
					badge(sum.rules, _('rules')),
					badge(sum.dnat, _('DNAT'), 'tf-badge-dnat'),
					badge(sum.snat, _('SNAT'), 'tf-badge-snat'),
					badge(sum.off, _('mangle'), 'tf-badge-off'),
					badge(sum.disabled, _('disabled'), 'tf-badge-disabled'),
					hasHit && this.folded && this.folded[src]
						? E('span', { class: 'tf-badge tf-badge-match' }, _('unfolded: matches'))
						: ''
				])
			]);
			head.addEventListener('click', () => self.toggleFold(src));
			kids.push(head);

			if (folded) continue;

			/* NAT renders inside the pair it affects: port forwards above the
			   pair they target, source NAT after the pair whose destination
			   zone it leaves through. */
			for (const g of groups) {
				const entries = g.rules.filter(famOk);
				const others = (g.otherRules || []).filter(famOk);
				kids.push(this.renderGroup(
					Object.assign({}, g, { rules: entries, otherRules: others }),
					model, terms, api));
				shown += entries.length + others.length;
			}
		}

		/* Anything the grouping could not place is shown explicitly. A rule
		   that is simply missing from the page is the worst outcome here. */
		const orphans = (model.orphans || []).filter(r => this.inFamilies(r));
		if (orphans.length) {
			kids.push(E('div', { class: 'tf-group tf-group-orphan' }, [
				E('div', { class: 'tf-group-head' }, [
					E('span', {}, '⚠ ' + _('Not shown in any zone pair')),
					E('span', { class: 'tf-badge' }, _('%d rules').format(orphans.length))
				]),
				E('div', { class: 'tf-scroll' }, [
					E('table', { class: 'table tf-table' }, [
						E('tr', { class: 'tr table-titles' },
							[ E('th', { class: 'th tf-c-handle' }, '') ].concat(
								this.activeColumns()
									.map(c => E('th', { class: 'th tf-col-' + c.key + ' ' + (c.cls || '') }, c.label)),
								[
									E('th', { class: 'th tf-c-marks' }, ''),
									E('th', { class: 'th tf-c-actions' }, '')
								]))
					].concat(orphans.map((r, i) =>
						this.renderRow({ rule: r, shadow: false }, model, i + 1, terms, api))))
				])
			]));
		}

		dom.content(container, kids);

		/* the strip is a projection of the same column set */
		this.refreshStrip();

		const total = document.querySelectorAll('.tf-row-match').length;
		this.matchTotal = total;
		this.matchIndex = -1;

		const searching = terms.length > 0;
		for (const b of (this.navBtns || [])) {
			b.hidden = !searching;
			b.disabled = !total;
		}

		this.paintMatchCount(shown, searching);
		this.syncSearchTools();
	},

	/* "3 / 12" while searching makes the arrows self-explanatory; the plain
	   rule count is what matters when not searching. */
	paintMatchCount(shown, searching) {
		if (!this.matchCountEl) return;

		if (!searching) {
			dom.content(this.matchCountEl, _('%d rules').format(shown));
			return;
		}

		if (!this.matchTotal) {
			dom.content(this.matchCountEl, _('no matches'));
			return;
		}

		dom.content(this.matchCountEl, this.matchIndex >= 0
			? _('%d / %d matches').format(this.matchIndex + 1, this.matchTotal)
			: _('%d matches').format(this.matchTotal));
	},

	jumpMatch(dir) {
		const rows = Array.from(document.querySelectorAll('.tf-row-match'));
		if (!rows.length) return;

		rows.forEach(r => r.classList.remove('tf-row-current'));
		this.matchIndex = ((this.matchIndex + dir) % rows.length + rows.length) % rows.length;

		const el = rows[this.matchIndex];
		el.classList.add('tf-row-current');
		if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });

		this.matchTotal = rows.length;
		this.paintMatchCount(rows.length, true);
	},

	/* ------------------------------------------------------------------ */

	/* The theme's own nav is `position: sticky; top: 0; z-index: 800`, so our
	   bar has to park *below* it rather than at the viewport top, and stay
	   under it in stacking order. The height varies by theme and viewport, so
	   it is measured rather than hardcoded and re-measured on resize. */
	/* The tools overlay the field, so the input needs padding equal to their
	   width — which changes as the count text grows and the arrows appear. */
	syncSearchTools() {
		if (!this.searchInputEl || !this.searchToolsEl) return;
		const w = Math.round(this.searchToolsEl.getBoundingClientRect().width);
		this.searchInputEl.style.paddingRight = (w > 0 ? w + 14 : 14) + 'px';
	},

	syncStickyOffsets() {
		const bar = this.headerEl;
		const root = document.documentElement;

		/* sticky offsets are relative to the scroll container, not the
		   viewport — kucat scrolls inside .main-right, not the window */
		let scroller = bar.parentElement;
		while (scroller && scroller !== document.body) {
			const oy = getComputedStyle(scroller).overflowY;
			if (oy === 'auto' || oy === 'scroll') break;
			scroller = scroller.parentElement;
		}
		if (scroller === document.body || !scroller) scroller = null;
		const scTop = scroller ? scroller.getBoundingClientRect().top : 0;

		/* pick the header that sits at the top of our scroll container:
		   a theme may have several (kucat also pins a bar-primary to the
		   bottom of the page), and fixed headers can sit anywhere */
		let navH = 0;
		for (const h of document.querySelectorAll('header')) {
			const r = h.getBoundingClientRect();
			if (r.top <= scTop + 160 && r.bottom > scTop)
				navH = Math.max(navH, Math.round(r.bottom - scTop));
		}
		navH = Math.min(navH, 200);
		const barH = bar ? Math.round(bar.getBoundingClientRect().height) : 0;

		/* Writing 0px would override the stylesheet's fallback and drop the bar
		   straight back under the nav. If the measurement is not meaningful,
		   clear the property and let the fallback stand. */
		if (navH > 0) root.style.setProperty('--tf-nav-h', navH + 'px');
		else root.style.removeProperty('--tf-nav-h');

		if (barH > 0) root.style.setProperty('--tf-bar-h', barH + 'px');
		else root.style.removeProperty('--tf-bar-h');
	},

	watchStickyOffsets() {
		if (this._stickyWatched) return;
		this._stickyWatched = true;

		const sync = () => {
			this.syncStickyOffsets();
			this.syncResizeStrip();
			this.syncSearchTools();
		};
		window.addEventListener('resize', sync);

		/* the bar's own height changes when it wraps or goes red */
		/* fires once on observe, which also corrects any measurement taken
		   before the node was laid out */
		if (window.ResizeObserver && this.headerEl)
			new window.ResizeObserver(sync).observe(this.headerEl);
	},

	/* Rebuild the strip only when the visible columns actually change.
	   renderGroups() runs on every search keystroke, and rebuilding there
	   would churn the DOM and pull focus out of a handle mid-resize. */
	refreshStrip() {
		if (!this.headerEl) return;

		const sig = this.activeColumns().map(c => c.key).join(',');
		if (sig === this._stripSig && this.stripEl && this.stripEl.parentNode) {
			this.syncResizeStrip();
			return;
		}
		this._stripSig = sig;

		const old = this.stripEl;
		const fresh = this.buildResizeStrip();
		if (old && old.parentNode) old.parentNode.replaceChild(fresh, old);
		else this.headerEl.appendChild(fresh);
		this.syncResizeStrip();
	},

	/* Version the stylesheet the same way LuCI versions everything else.
	   JS modules get `?v=<resource_version>` from require(), and the theme
	   requests its own cascade.css the same way — but a <link> built from a
	   bare L.resource() path has no cache-buster, so browsers kept serving a
	   stale stylesheet while the JS updated underneath it. */
	loadStyle() {
		const ver = (L.env && L.env.resource_version) ? '?v=' + L.env.resource_version : '';
		const href = L.resource('table-firewall/table-firewall.css') + ver;
		if (document.querySelector('link[href="' + href + '"]')) return;
		document.head.appendChild(E('link', { rel: 'stylesheet', type: 'text/css', href: href }));
	},

	render(model) {
		this.loadStyle();
		this.loadColumns();
		this.loadWidths();
		this.loadFolds();
		this.model = model;
		this.query = this.query || '';
		this.loadFamilies();

		const self = this;
		this.groupsEl = E('div', { class: 'tf-groups' });

		const root = E('div', { class: 'cbi-map' }, [
			E('h2', {}, _('Traffic Rules')),
			E('div', { class: 'cbi-map-descr' },
				_('Grouped by zone pair, in real evaluation order. Double-click a rule to edit it. Search highlights matches and never hides rules — what sits above a rule determines whether it fires at all.')),
			this.renderHeader(model),
			this.groupsEl
		]);

		/* defer until in the DOM so querySelector-based painting works */
		requestAnimationFrame(() => {
			self.renderGroups();
			self.hookChangeIndicator();
			self.refreshChangeIndicator();
			self.syncStickyOffsets();
			self.watchStickyOffsets();
			self.syncResizeStrip();
			self.syncSearchTools();
		});

		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
