#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Gerhard Mautendorfer (MaidByC)
# Seed a realistic multi-zone firewall for UI work.
set -e

# ---------- networks: port-less bridges so the zones actually resolve ----------
add_net() { # name bridge ipaddr
  uci -q delete network.$1 2>/dev/null || true
  uci set network.$1=interface
  uci set network.$1.device="$2"
  uci set network.$1.proto='static'
  uci set network.$1.ipaddr="$3"
  uci set network.$1.netmask='255.255.255.0'
}
add_dev() {
  uci add network device >/dev/null
  uci set network.@device[-1].name="$1"
  uci set network.@device[-1].type='bridge'
}
# only add bridges once
if ! uci show network | grep -q "name='br-dmz'"; then
  add_dev br-dmz; add_dev br-mgmtdmz; add_dev br-prod
fi
add_net dmz        br-dmz      10.10.10.1
add_net mgmt_dmz   br-mgmtdmz  10.10.20.1
add_net production br-prod     10.10.30.1
uci commit network

# ---------- zones ----------
add_zone() { # name network input output forward masq
  uci add firewall zone >/dev/null
  uci set firewall.@zone[-1].name="$1"
  uci set firewall.@zone[-1].network="$2"
  uci set firewall.@zone[-1].input="$3"
  uci set firewall.@zone[-1].output="$4"
  uci set firewall.@zone[-1].forward="$5"
  [ -n "$6" ] && uci set firewall.@zone[-1].masq="$6"
  return 0
}
if ! uci show firewall | grep -q "name='DMZ'"; then
  add_zone DMZ        dmz        DROP   ACCEPT DROP
  add_zone MGMT_DMZ   mgmt_dmz   DROP   ACCEPT DROP
  add_zone production production REJECT ACCEPT DROP
fi

# ---------- inter-zone forwarding policies ----------
add_fwd() {
  uci add firewall forwarding >/dev/null
  uci set firewall.@forwarding[-1].src="$1"
  uci set firewall.@forwarding[-1].dest="$2"
}
if ! uci show firewall | grep -q "forwarding.*src='DMZ'"; then
  add_fwd DMZ wan; add_fwd MGMT_DMZ wan; add_fwd production wan
  add_fwd lan DMZ; add_fwd lan MGMT_DMZ; add_fwd lan production
fi

# ---------- rules ----------
# r <name> <src> <dest> <proto> <dport> <target> [dest_ip] [enabled]
r() {
  # idempotent: a rule with this name already exists, leave it alone
  uci show firewall | grep -q "\.name='$1'\$" && return 0
  uci add firewall rule >/dev/null
  uci set firewall.@rule[-1].name="$1"
  uci set firewall.@rule[-1].src="$2"
  [ "$3" != "-" ] && uci set firewall.@rule[-1].dest="$3"
  [ "$4" != "-" ] && uci set firewall.@rule[-1].proto="$4"
  [ "$5" != "-" ] && uci set firewall.@rule[-1].dest_port="$5"
  uci set firewall.@rule[-1].target="$6"
  [ -n "$7" ] && [ "$7" != "-" ] && uci set firewall.@rule[-1].dest_ip="$7"
  [ -n "$8" ] && uci set firewall.@rule[-1].enabled="$8"
  return 0
}

# --- input: traffic to the router itself (no dest) ---
r "Mgmt-SSH-from-LAN"          lan        - tcp     22        ACCEPT
r "Mgmt-LuCI-HTTPS-from-LAN"   lan        - tcp     443       ACCEPT
r "Mgmt-LuCI-HTTP-from-LAN"    lan        - tcp     80        ACCEPT
r "Allow-DNS-from-LAN"         lan        - "tcp udp" 53      ACCEPT
r "Allow-NTP-from-LAN"         lan        - udp     123       ACCEPT
r "Allow-Ping-from-LAN"        lan        - icmp    -         ACCEPT
r "Mgmt-SSH-from-Production"   production - tcp     22        ACCEPT
r "Allow-SNMP-from-Production" production - udp     161       ACCEPT
r "Drop-SSH-from-WAN"          wan        - tcp     22        DROP
r "Drop-Telnet-from-WAN"       wan        - tcp     23        DROP
r "Drop-Mgmt-from-DMZ"         DMZ        - -       -         DROP
r "Drop-Mgmt-from-MGMT_DMZ"    MGMT_DMZ   - -       -         DROP

# --- lan -> wan ---
r "Block-LAN-SMTP-Direct"      lan wan tcp 25            REJECT
r "Block-LAN-Torrent"          lan wan tcp 6881-6889     REJECT
r "Allow-LAN-Web"              lan wan tcp "80 443"      ACCEPT
r "Allow-LAN-DNS-Out"          lan wan "tcp udp" 53      ACCEPT
r "Allow-LAN-Submission"       lan wan tcp 587           ACCEPT
r "Allow-LAN-IMAPS"            lan wan tcp 993           ACCEPT
r "Allow-LAN-SSH-Out"          lan wan tcp 22            ACCEPT
r "Allow-LAN-NTP-Out"          lan wan udp 123           ACCEPT
r "Allow-LAN-VPN-Out"          lan wan udp 1194          ACCEPT

# --- wan -> DMZ (published services) ---
r "Pub-Web-HTTP"               wan DMZ tcp 80        ACCEPT 10.10.10.10
r "Pub-Web-HTTPS"              wan DMZ tcp 443       ACCEPT 10.10.10.10
r "Pub-Mail-SMTP"              wan DMZ tcp 25        ACCEPT 10.10.10.20
r "Pub-Mail-Submission"        wan DMZ tcp "465 587" ACCEPT 10.10.10.20
r "Pub-Mail-IMAPS"             wan DMZ tcp 993       ACCEPT 10.10.10.20
r "Drop-WAN-to-DMZ-Any"        wan DMZ -   -         DROP

# --- lan -> DMZ ---
r "Allow-LAN-DMZ-SSH"          lan DMZ tcp 22           ACCEPT
r "Allow-LAN-DMZ-Web"          lan DMZ tcp "80 443"     ACCEPT
r "Allow-LAN-DMZ-Mail"         lan DMZ tcp "25 143 993" ACCEPT

# --- DMZ -> wan ---
r "Allow-DMZ-Updates"          DMZ wan tcp "80 443" ACCEPT
r "Allow-DMZ-SMTP-Out"         DMZ wan tcp 25       ACCEPT
r "Allow-DMZ-DNS-Out"          DMZ wan udp 53       ACCEPT
r "Drop-DMZ-Any-Out"           DMZ wan -   -        DROP

# --- DMZ -> production (tight) ---
r "Allow-DMZ-Prod-MySQL"       DMZ production tcp 3306      ACCEPT 10.10.30.50
r "Allow-DMZ-Prod-LDAP"        DMZ production tcp "389 636" ACCEPT
r "Drop-DMZ-Prod-Any"          DMZ production -   -         DROP

# --- lan -> production ---
r "Allow-LAN-Prod-SSH"         lan production tcp 22       ACCEPT
r "Allow-LAN-Prod-RDP"         lan production tcp 3389     ACCEPT
r "Allow-LAN-Prod-Web"         lan production tcp "80 443" ACCEPT
r "Allow-LAN-Prod-SMB"         lan production tcp 445      ACCEPT
r "Legacy-LAN-Prod-FTP"        lan production tcp "20 21"  ACCEPT - 0

# --- MGMT_DMZ ---
r "Allow-MGMTDMZ-Prod-Syslog"  MGMT_DMZ production udp 514       ACCEPT
r "Allow-MGMTDMZ-Prod-SNMP"    MGMT_DMZ production udp 161       ACCEPT
r "Allow-MGMTDMZ-Updates"      MGMT_DMZ wan       tcp "80 443"   ACCEPT
r "Drop-MGMTDMZ-Any-Out"       MGMT_DMZ wan       -   -          DROP
r "Allow-LAN-MGMTDMZ-Mgmt"     lan    MGMT_DMZ    tcp "22 443"   ACCEPT
r "Allow-Prod-MGMTDMZ-Metrics" production MGMT_DMZ tcp 9100      ACCEPT

# --- production -> wan ---
r "Allow-Prod-Updates"         production wan tcp "80 443" ACCEPT
r "Allow-Prod-NTP"             production wan udp 123      ACCEPT
r "Old-Prod-Direct-SMTP"       production wan tcp 25       ACCEPT - 0
r "Drop-Prod-Any-Out"          production wan -   -        DROP

# ---------- port forwards ----------
# d <name> <proto> <src_dport> <dest zone> <dest_ip> <dest_port>
d() {
  # idempotent: a redirect with this name already exists, leave it alone
  uci show firewall | grep -q "\.name='$1'\$" && return 0
  uci add firewall redirect >/dev/null
  uci set firewall.@redirect[-1].name="$1"
  uci set firewall.@redirect[-1].target='DNAT'
  uci set firewall.@redirect[-1].src='wan'
  uci set firewall.@redirect[-1].proto="$2"
  uci set firewall.@redirect[-1].src_dport="$3"
  uci set firewall.@redirect[-1].dest="$4"
  uci set firewall.@redirect[-1].dest_ip="$5"
  uci set firewall.@redirect[-1].dest_port="$6"
  return 0
}
d "DNAT-Web-HTTP"     tcp 80    DMZ        10.10.10.10 80
d "DNAT-Web-HTTPS"    tcp 443   DMZ        10.10.10.10 443
d "DNAT-Mail-SMTP"    tcp 25    DMZ        10.10.10.20 25
d "DNAT-Mail-Submit"  tcp 587   DMZ        10.10.10.20 587
d "DNAT-SSH-Jumphost" tcp 2222  production 10.10.30.5  22
d "DNAT-RDP-Terminal" tcp 33890 production 10.10.30.60 3389

uci commit firewall
echo "SEEDED"

# --- rules exercising the non-default columns -----------------------------
# These exist so the "hidden criteria" marker and the Time/Limit/Mark/Log
# columns have something real to show.
if ! uci show firewall | grep -q "name='Maint-Window-Backup'"; then
  uci add firewall rule >/dev/null
  uci set firewall.@rule[-1].name='Maint-Window-Backup'
  uci set firewall.@rule[-1].src='lan'
  uci set firewall.@rule[-1].dest='production'
  uci set firewall.@rule[-1].proto='tcp'
  uci set firewall.@rule[-1].dest_port='873'
  uci set firewall.@rule[-1].start_time='01:00:00'
  uci set firewall.@rule[-1].stop_time='05:00:00'
  uci add_list firewall.@rule[-1].weekdays='Sat'
  uci add_list firewall.@rule[-1].weekdays='Sun'
  uci set firewall.@rule[-1].target='ACCEPT'

  uci add firewall rule >/dev/null
  uci set firewall.@rule[-1].name='Legacy-NTP-Fixed-SrcPort'
  uci set firewall.@rule[-1].src='lan'
  uci set firewall.@rule[-1].dest='wan'
  uci set firewall.@rule[-1].proto='udp'
  uci set firewall.@rule[-1].src_port='123'
  uci set firewall.@rule[-1].dest_port='123'
  uci set firewall.@rule[-1].target='ACCEPT'

  uci add firewall rule >/dev/null
  uci set firewall.@rule[-1].name='Mark-VOIP-Priority'
  uci set firewall.@rule[-1].src='lan'
  uci set firewall.@rule[-1].dest='wan'
  uci set firewall.@rule[-1].proto='udp'
  uci set firewall.@rule[-1].dest_port='5060 5061'
  uci set firewall.@rule[-1].set_mark='0x10'
  uci set firewall.@rule[-1].target='MARK'

  uci add firewall rule >/dev/null
  uci set firewall.@rule[-1].name='Log-DMZ-Denied'
  uci set firewall.@rule[-1].src='DMZ'
  uci set firewall.@rule[-1].dest='production'
  uci set firewall.@rule[-1].proto='tcp'
  uci set firewall.@rule[-1].dest_port='1433'
  uci set firewall.@rule[-1].limit='10/minute'
  uci set firewall.@rule[-1].target='REJECT'

  uci commit firewall
  echo "advanced rules seeded"
fi

# --- NAT (srcnat) rules ----------------------------------------------------
# config nat is a distinct section type from config redirect, and has no dest
# zone option at all — it groups by source zone only.
if ! uci show firewall | grep -q "name='SNAT-DMZ-Egress'"; then
  uci add firewall nat >/dev/null
  uci set firewall.@nat[-1].name='SNAT-DMZ-Egress'
  uci set firewall.@nat[-1].src='wan'
  uci set firewall.@nat[-1].src_ip='10.10.10.0/24'
  uci set firewall.@nat[-1].proto='tcp'
  # Just a plausible address for a SNAT rule to rewrite to; nothing depends on
  # it being reachable. Change it if your lab uses another range.
  uci set firewall.@nat[-1].snat_ip='192.168.199.222'
  uci set firewall.@nat[-1].target='SNAT'

  uci add firewall nat >/dev/null
  uci set firewall.@nat[-1].name='MASQ-Production-Out'
  uci set firewall.@nat[-1].src='wan'
  uci set firewall.@nat[-1].src_ip='10.10.30.0/24'
  uci set firewall.@nat[-1].target='MASQUERADE'

  uci add firewall nat >/dev/null
  uci set firewall.@nat[-1].name='No-NAT-MGMTDMZ-Internal'
  uci set firewall.@nat[-1].src='wan'
  uci set firewall.@nat[-1].src_ip='10.10.20.0/24'
  uci set firewall.@nat[-1].dest_ip='10.0.0.0/8'
  uci set firewall.@nat[-1].target='ACCEPT'

  uci commit firewall
  echo "nat rules seeded"
fi

# --- extra DNS names on one address ----------------------------------------
# One host serving several sites is the ordinary case, and it is what shows
# that a name lookup must not stop at the first match.
if ! uci show dhcp | grep -q "name='nginx'"; then
  for n in nginx nginx2; do
    uci add dhcp domain >/dev/null
    uci set dhcp.@domain[-1].name="$n"
    uci set dhcp.@domain[-1].ip='10.10.10.10'
  done
  uci commit dhcp
  /etc/init.d/dnsmasq reload >/dev/null 2>&1
  echo "extra DNS names seeded"
fi
