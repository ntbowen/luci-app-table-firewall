#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Gerhard Mautendorfer (MaidByC)
/* Contrast invariants for the stylesheet.
 *
 * The red staged-changes bar sets color:#fff on its subtree. Twice now that
 * has painted white text onto a light background — first on the themes' own
 * near-white buttons, then on the count overlaying the white search field.
 * Neither shows on the dark theme, so both survived review. These checks state
 * the invariant instead of relying on noticing it.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..',
	'luci-app-table-firewall/htdocs/luci-static/resources/table-firewall/table-firewall.css'), 'utf8');

let pass = 0, fail = 0;
const check = (ok, label, detail) => {
	if (ok) pass++;
	else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};

/* crude but sufficient: split into `selector { body }` pairs */
const rules = [];
const re = /([^{}]+)\{([^}]*)\}/g;
let m;
while ((m = re.exec(css)) !== null)
	rules.push({ sel: m[1].trim(), body: m[2].trim() });

const declares = (sel, prop) => rules.some(r =>
	r.sel.includes(sel) && new RegExp('(^|;)\\s*' + prop + '\\s*:').test(r.body));

console.log('=== contrast invariants ===');

/* anything sitting on top of the search input must set its own colour */
check(declares('.tf-search-tools', 'color'),
	'.tf-search-tools declares an explicit colour (it overlays the white input)');

/* the dirty bar must not blanket-colour controls */
const blanket = rules.filter(r =>
	r.sel.includes('tf-dirty') &&
	/(^|,)\s*\[data-page[^,]*\.tf-dirty\s+(a|button)\s*$/.test(r.sel) &&
	/color\s*:\s*#fff/i.test(r.body));
check(blanket.length === 0,
	'the dirty bar does not force white onto every button/anchor',
	blanket.map(r => r.sel).join(' | '));

/* Every element painted with a solid dark background must state a foreground
   somewhere in its own class set. .tf-ipv4/.tf-ipv6 carry only the background;
   their colour comes from the shared .tf-ipv they are always used with, so the
   pair is what has to be checked, not each half. */
const pairs = [
	[['.tf-ipv'], '.tf-ipv4 / .tf-ipv6 chips'],
	[['.tf-mark-pending'], 'pending badge'],
	[['.tf-mark-extra'], 'hidden-criteria badge'],
	[['.tf-zone-device'], 'device zone chip'],
	[['.tf-menu-danger'], 'delete menu item'],
	[['.tf-mark-names'], 'extra-names chip'],
	[['.tf-mark-clash'], 'shadowed-forward badge']
];
for (const [classes, label] of pairs)
	check(classes.some(c => declares(c, 'color')),
		label + ' states a foreground for its background', classes.join(','));

console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
