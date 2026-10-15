'use strict';
'require baseclass';
'require form';
'require ui';
'require uci';
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Gerhard Mautendorfer (MaidByC)

/* Rule editor.
 *
 * Deliberately a stock LuCI form.Map rendered into a modal rather than
 * hand-built inputs: that inherits the framework's widgets, its per-field
 * datatypes (port, ipmask, macaddr, timehhmmss, dateyyyymmdd, neg(...)) and
 * its save path, which stages into the same uci changeset that Save & Apply
 * and its rollback operate on. Reimplementing any of that would be the
 * expensive and error-prone part of a custom table.
 */

const TARGETS = [
	['ACCEPT', '✅ ' + _('Accept')],
	['REJECT', '🚫 ' + _('Reject')],
	['DROP',   '⛔ ' + _('Drop')],
	['MARK',   '🏷 ' + _('Mark')],
	['NOTRACK','👻 ' + _('Do not track')],
	['HELPER', '🧩 ' + _('Assign helper')]
];

return baseclass.extend({
	/* Build a Map holding exactly one section. `type` selects which kind of
	 * firewall object is being edited: a filter rule, a port forward
	 * (config redirect) or a NAT rule (config nat). They are genuinely
	 * different section types with different options — config nat has no
	 * destination zone at all — so each gets its own field set. */
	buildMap(model, sid, type) {
		const kind = type || 'rule';
		if (kind === 'redirect') return this.buildRedirectMap(model, sid);
		if (kind === 'nat') return this.buildNatMap(model, sid);

		const m = new form.Map('firewall');
		const s = m.section(form.NamedSection, sid, 'rule');

		s.anonymous = true;
		s.addremove = false;

		s.tab('general', _('General'));
		s.tab('advanced', _('Advanced'));
		s.tab('time', _('Time restrictions'));

		/* '*' is offered because fw4 supports it and existing configs use it,
		   but it is called out at the point of choosing: a wildcard end has no
		   interface match, so the rule is evaluated against every zone and can
		   pre-empt rules further down that look unrelated to it. */
		const WILDCARD_WARNING = _('Not recommended: a wildcard end matches every zone, so this rule is evaluated against traffic it may look unrelated to and can pre-empt rules further down the chain. Naming the zone keeps the evaluation order readable.');

		const zoneOpts = (o, isDest) => {
			o.value('', isDest ? _('this device (input)') : _('this device (output)'));
			o.value('*', _('any zone — not recommended'));
			for (const z of model.zoneOrder) o.value(z, z);
			o.description = WILDCARD_WARNING;
		};

		let o;

		o = s.taboption('general', form.Value, 'name', _('Name'));
		o.rmempty = false;
		o.placeholder = _('Describe what this rule does');

		o = s.taboption('general', form.Flag, 'enabled', _('Enabled'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('general', form.ListValue, 'family', _('Address family'));
		o.value('', _('IPv4 and IPv6'));
		o.value('ipv4', _('IPv4 only'));
		o.value('ipv6', _('IPv6 only'));

		o = s.taboption('general', form.ListValue, 'src', _('Source zone'));
		zoneOpts(o, false);

		o = s.taboption('general', form.DynamicList, 'src_ip', _('Source address'));
		o.datatype = 'list(neg(ipmask))';
		o.placeholder = _('any');

		o = s.taboption('general', form.ListValue, 'dest', _('Destination zone'));
		zoneOpts(o, true);

		o = s.taboption('general', form.DynamicList, 'dest_ip', _('Destination address'));
		o.datatype = 'list(neg(ipmask))';
		o.placeholder = _('any');

		o = s.taboption('general', form.Value, 'proto', _('Protocol'));
		o.value('', _('any'));
		o.value('tcp', 'TCP');
		o.value('udp', 'UDP');
		o.value('tcp udp', 'TCP + UDP');
		o.value('icmp', 'ICMP');
		o.value('icmpv6', 'ICMPv6');

		o = s.taboption('general', form.Value, 'dest_port', _('Destination port'));
		o.datatype = 'list(neg(portrange))';
		o.placeholder = _('any');

		o = s.taboption('general', form.ListValue, 'target', _('Action'));
		for (const [v, label] of TARGETS) o.value(v, label);
		o.default = 'ACCEPT';
		o.rmempty = false;

		/* --- advanced --- */

		o = s.taboption('advanced', form.Value, 'src_port', _('Source port'));
		o.datatype = 'list(neg(portrange))';
		o.placeholder = _('any');

		o = s.taboption('advanced', form.DynamicList, 'src_mac', _('Source MAC'));
		o.datatype = 'list(neg(macaddr))';

		o = s.taboption('advanced', form.Value, 'set_mark', _('Set mark'));
		o.depends('target', 'MARK');

		o = s.taboption('advanced', form.Value, 'set_helper', _('Helper'));
		o.depends('target', 'HELPER');

		o = s.taboption('advanced', form.Value, 'limit', _('Limit'));
		o.placeholder = '10/minute';

		o = s.taboption('advanced', form.Flag, 'log', _('Log matched packets'));

		o = s.taboption('advanced', form.Value, 'extra', _('Extra arguments'));
		o.placeholder = _('passed to fw4 verbatim');

		/* --- time --- */

		o = s.taboption('time', form.MultiValue, 'weekdays', _('Week days'));
		o.value('Mon', _('Monday'));
		o.value('Tue', _('Tuesday'));
		o.value('Wed', _('Wednesday'));
		o.value('Thu', _('Thursday'));
		o.value('Fri', _('Friday'));
		o.value('Sat', _('Saturday'));
		o.value('Sun', _('Sunday'));

		o = s.taboption('time', form.Value, 'start_time', _('Start time (hh:mm:ss)'));
		o.datatype = 'timehhmmss';

		o = s.taboption('time', form.Value, 'stop_time', _('Stop time (hh:mm:ss)'));
		o.datatype = 'timehhmmss';

		o = s.taboption('time', form.Value, 'start_date', _('Start date (yyyy-mm-dd)'));
		o.datatype = 'dateyyyymmdd';

		o = s.taboption('time', form.Value, 'stop_date', _('Stop date (yyyy-mm-dd)'));
		o.datatype = 'dateyyyymmdd';

		o = s.taboption('time', form.Flag, 'utc_time', _('Times are UTC'));

		return m;
	},

	zoneOptions(model, o, isDest) {
		o.value('', isDest ? _('this device (input)') : _('this device (output)'));
		o.value('*', _('any zone — not recommended'));
		for (const z of model.zoneOrder) o.value(z, z);
	},

	/* Port forward: config redirect, target DNAT. src_dport is what the client
	 * connects to; dest_ip/dest_port are the rewrite. */
	buildRedirectMap(model, sid) {
		const m = new form.Map('firewall');
		const s = m.section(form.NamedSection, sid, 'redirect');
		s.anonymous = true;
		s.addremove = false;
		s.tab('general', _('General'));
		s.tab('advanced', _('Advanced'));

		let o;
		o = s.taboption('general', form.Value, 'name', _('Name'));
		o.rmempty = false;

		o = s.taboption('general', form.Flag, 'enabled', _('Enabled'));
		o.default = '1'; o.rmempty = false;

		o = s.taboption('general', form.ListValue, 'target', _('Action'));
		o.value('DNAT', '➡️ ' + _('DNAT (Port Forward)'));
		o.value('SNAT', '⬅️ ' + _('SNAT (legacy on this section type)'));
		o.default = 'DNAT'; o.rmempty = false;

		o = s.taboption('general', form.ListValue, 'src', _('Source zone'));
		this.zoneOptions(model, o, false);

		o = s.taboption('general', form.Value, 'proto', _('Protocol'));
		o.value('tcp udp', 'TCP + UDP'); o.value('tcp', 'TCP'); o.value('udp', 'UDP');
		o.default = 'tcp udp';

		o = s.taboption('general', form.Value, 'src_dport', _('External port'));
		o.datatype = 'neg(portrange)';
		o.description = _('The port the client connects to.');

		o = s.taboption('general', form.ListValue, 'dest', _('Destination zone'));
		this.zoneOptions(model, o, true);

		o = s.taboption('general', form.Value, 'dest_ip', _('Internal address'));
		o.datatype = 'ipaddr';
		o.description = _('Where the traffic is sent. Leave empty to redirect to this device.');

		o = s.taboption('general', form.Value, 'dest_port', _('Internal port'));
		o.datatype = 'portrange';
		o.description = _('Leave empty to keep the external port.');

		o = s.taboption('advanced', form.DynamicList, 'src_ip', _('Source address'));
		o.datatype = 'list(neg(ipmask))';
		o = s.taboption('advanced', form.DynamicList, 'src_mac', _('Source MAC'));
		o.datatype = 'list(neg(macaddr))';
		o = s.taboption('advanced', form.Value, 'extra', _('Extra arguments'));

		return m;
	},

	/* NAT: config nat. Deliberately has no destination *zone* — fw4 orders
	 * these in srcnat_<src> by source zone alone. */
	buildNatMap(model, sid) {
		const m = new form.Map('firewall');
		const s = m.section(form.NamedSection, sid, 'nat');
		s.anonymous = true;
		s.addremove = false;
		s.tab('general', _('General'));
		s.tab('advanced', _('Advanced'));

		let o;
		o = s.taboption('general', form.Value, 'name', _('Name'));
		o.rmempty = false;

		o = s.taboption('general', form.Flag, 'enabled', _('Enabled'));
		o.default = '1'; o.rmempty = false;

		o = s.taboption('general', form.ListValue, 'target', _('Action'));
		o.value('MASQUERADE', '🎭 ' + _('MASQUERADE — rewrite to the outgoing interface address'));
		o.value('SNAT', '⬅️ ' + _('SNAT — rewrite to a fixed address'));
		o.value('ACCEPT', '✅ ' + _('ACCEPT — no translation'));
		o.default = 'MASQUERADE'; o.rmempty = false;

		o = s.taboption('general', form.ListValue, 'src', _('Outbound zone'));
		this.zoneOptions(model, o, false);
		o.description = _('The zone the traffic leaves through. NAT rules are evaluated in this zone\'s srcnat chain.');

		o = s.taboption('general', form.Value, 'snat_ip', _('Rewrite to address'));
		o.datatype = 'ipaddr';
		o.depends('target', 'SNAT');

		o = s.taboption('general', form.Value, 'snat_port', _('Rewrite to port'));
		o.datatype = 'portrange';
		o.depends('target', 'SNAT');

		o = s.taboption('general', form.DynamicList, 'src_ip', _('Source address'));
		o.datatype = 'list(neg(ipmask))';
		o = s.taboption('general', form.DynamicList, 'dest_ip', _('Destination address'));
		o.datatype = 'list(neg(ipmask))';

		o = s.taboption('advanced', form.Value, 'proto', _('Protocol'));
		o.value('', _('any')); o.value('tcp', 'TCP'); o.value('udp', 'UDP');
		o = s.taboption('advanced', form.Value, 'src_port', _('Source port'));
		o.datatype = 'neg(portrange)';
		o = s.taboption('advanced', form.Value, 'dest_port', _('Destination port'));
		o.datatype = 'neg(portrange)';
		o = s.taboption('advanced', form.Value, 'extra', _('Extra arguments'));

		return m;
	},

	/* Opens the modal. Resolves true when saved, false when dismissed.
	 * `isNew` sections are removed again on cancel, so an abandoned Add does
	 * not leave an empty rule staged in the changeset. */
	open(model, sid, isNew, type) {
		const self = this;
		const m = this.buildMap(model, sid, type);

		return m.render().then(node => {
			return new Promise(resolve => {
				const done = (saved) => { ui.hideModal(); resolve(saved); };

				const cancel = () => {
					if (isNew) uci.remove('firewall', sid);
					done(false);
				};

				const save = () => {
					/* m.save() validates first and raises its own error modal
					   on failure, so a rejection here means "stay open". */
					m.save().then(() => done(true)).catch(() => {});
				};

				const titles = {
					rule: isNew ? _('Add traffic rule') : _('Edit traffic rule'),
					redirect: isNew ? _('Add port forward (DNAT)') : _('Edit port forward (DNAT)'),
					nat: isNew ? _('Add NAT rule') : _('Edit NAT rule')
				};

				ui.showModal(titles[type || 'rule'], [
					node,
					E('div', { class: 'right' }, [
						E('button', { class: 'btn cbi-button', click: cancel }, _('Cancel')), ' ',
						E('button', {
							class: 'btn cbi-button cbi-button-action important',
							click: save
						}, _('Save'))
					])
				], 'cbi-modal');
			});
		});
	},

	/* A new rule is appended, which is where UCI puts it and therefore where
	 * it evaluates. It can be dragged into place afterwards. */
	create(model, defaults, type) {
		const sid = uci.add('firewall', type || 'rule');
		for (const k in (defaults || {}))
			if (defaults[k] != null) uci.set('firewall', sid, k, defaults[k]);
		return sid;
	}
});
