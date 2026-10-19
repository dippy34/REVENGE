#!/usr/bin/env bash
# setup-native.sh: add the site + proxy to a server that already runs Caddy
# as a system service (no Docker). Nothing else on the server is changed:
#   - the app runs as its own systemd service on 127.0.0.1:$PORT
#   - Rammerhead (the Safari / iPad engine of the proxy page) runs as a second
#     service on a unix socket, with the kernel forbidden to let it open
#     connections to loopback, private networks or this machine's own addresses
#   - one site block for $DOMAIN is appended to /etc/caddy/Caddyfile
#     (backed up first, validated, restored if invalid)
#
# Run as root:
#   DOMAIN=sub.example.com ACCESS_KEY=... bash setup-native.sh
# Re-run any time to update to the latest main.
set -euo pipefail

REPO="${REPO:-https://github.com/dippy34/REVENGE.git}"
DIR="${DIR:-/opt/revenge}"
PORT="${PORT:-8080}"
DOMAIN="${DOMAIN:?set DOMAIN, e.g. DOMAIN=abc.1-2-3-4.sslip.io}"
UNIT=/etc/systemd/system/revenge.service
RHUNIT=/etc/systemd/system/revenge-rh.service
RHENVF=/etc/revenge-rh.env
RHSOCK=/run/revenge/rh.sock
ENVF=/etc/revenge.env
CADDYFILE=/etc/caddy/Caddyfile
MARK="# revenge-site"

for c in node npm git caddy; do
  command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 1; }
done
node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo "need Node 20+" >&2; exit 1; }

# the port must be free, or already ours
if ss -Htln "sport = :$PORT" | grep -q . && ! systemctl is-active --quiet revenge; then
  echo "port $PORT is already in use:" >&2; ss -Htlnp "sport = :$PORT" >&2; exit 1
fi

echo "> user"
id revenge >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin revenge

echo "> code"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q --ff-only; else git clone -q --depth 1 "$REPO" "$DIR"; fi
(cd "$DIR/server" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)

echo "> settings"
# For ACCESS_KEY (proxy lock) and STATS_KEY (the /stats/ page):
# set, even to empty, replaces the saved value (empty = off);
# unset keeps the saved one, or makes a new one on first install.
touch "$ENVF"
chmod 600 "$ENVF"
getvar() { grep -m1 "^$1=" "$ENVF" | cut -d= -f2- || true; }
setvar() {
  { grep -v "^$1=" "$ENVF" || true; printf '%s=%s\n' "$1" "$2"; } > "$ENVF.tmp"
  mv "$ENVF.tmp" "$ENVF"
  chmod 600 "$ENVF"
}
newkey() { openssl rand -base64 18 | tr -d '/+=' | cut -c1-20; }
for v in ACCESS_KEY STATS_KEY; do
  if [ -n "${!v+x}" ]; then setvar "$v" "${!v}"
  elif ! grep -q "^$v=" "$ENVF"; then setvar "$v" "$(newkey)"
  fi
done

# Rammerhead only needs the proxy key, not the stats key
printf 'ACCESS_KEY=%s\n' "$(getvar ACCESS_KEY)" > "$RHENVF"
chmod 600 "$RHENVF"

echo "> service"
# Where Rammerhead may NOT connect: it follows any address it is given, so without
# this anyone could use it to reach services on this server (Caddy's admin
# port, this app) or the provider's private network. The kernel enforces it.
OWN="$( { ip -4 -o addr show scope global; ip -6 -o addr show scope global; } 2>/dev/null | awk '{print $4}' | sed 's#/.*##' | sort -u | tr '\n' ' ')"
DNS="$( { grep -hE '^nameserver' /etc/resolv.conf /run/systemd/resolve/resolv.conf 2>/dev/null || true; } | awk '{print $2}' | grep -v '%' | sort -u | tr '\n' ' ')"
DENY="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 ::1/128 fc00::/7 fe80::/10 $OWN"
cat > "$RHUNIT" <<UNITEOF
[Unit]
Description=Rammerhead, the Safari / iPad engine of the proxy page (see $DIR/docs/06-backend.md)
After=network-online.target
Wants=network-online.target

[Service]
User=revenge
WorkingDirectory=$DIR/server
EnvironmentFile=$RHENVF
Environment=RH_SOCKET=$RHSOCK NODE_ENV=production
RuntimeDirectory=revenge
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
ExecStart=$(command -v node) rammerhead.cjs
Restart=always
RestartSec=2
# no logs, by design
StandardOutput=null
StandardError=null
# it reaches the web, but never this machine or private networks (the unix
# socket to server.mjs is not an IP connection, so it is not affected)
IPAddressDeny=$DENY
IPAddressAllow=127.0.0.53 $DNS
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
MemoryMax=600M

[Install]
WantedBy=multi-user.target
UNITEOF

cat > "$UNIT" <<EOF
[Unit]
Description=static site + Scramjet proxy (see $DIR/docs/06-backend.md)
After=network-online.target revenge-rh.service
Wants=network-online.target revenge-rh.service

[Service]
User=revenge
WorkingDirectory=$DIR/server
EnvironmentFile=$ENVF
Environment=HOST=127.0.0.1 PORT=$PORT NODE_ENV=production CACHE_DIR=/var/cache/revenge STATS_DIR=/var/lib/revenge RH_SOCKET=$RHSOCK
# daily visit counts are saved here (no IPs, see server/stats.mjs)
StateDirectory=revenge
StateDirectoryMode=0750
# game files relayed from the R2 bucket are cached here (size capped by CACHE_MAX_MB)
CacheDirectory=revenge
CacheDirectoryMode=0750
ExecStart=$(command -v node) server.mjs
Restart=always
RestartSec=2
# no logs, by design
StandardOutput=null
StandardError=null
# hardening: read-only system (except the cache and state dirs above), no privileges,
# network + unix sockets only
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
MemoryMax=700M

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q revenge revenge-rh
systemctl restart revenge-rh
systemctl restart revenge

echo "> caddy"
# DOMAIN may list several names: "a.example, www.a.example"
current="$(grep -A1 -F "$MARK" "$CADDYFILE" | tail -n +2 | sed 's/ *{$//' || true)"
if [ "$current" = "$DOMAIN" ]; then
  echo "  site block for $DOMAIN already present"
else
  bak="$CADDYFILE.bak-revenge-$(date +%Y%m%d-%H%M%S)"
  cp -p "$CADDYFILE" "$bak"
  if [ -n "$current" ]; then
    sed -i "/^$MARK/{n;s/^.* {\$/$DOMAIN {/}" "$CADDYFILE"   # rename the block's hosts
  else
    printf '\n%s (added by server/setup-native.sh)\n%s {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:%s\n}\n' "$MARK" "$DOMAIN" "$PORT" >> "$CADDYFILE"
  fi
  if caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    systemctl reload caddy
    echo "  site block now serves $DOMAIN (backup: $bak)"
  else
    cp -p "$bak" "$CADDYFILE"
    echo "  new Caddyfile did not validate; restored the backup, nothing changed" >&2
    exit 1
  fi
fi

echo "> check"
for i in $(seq 1 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)"
  [ "$code" = "200" ] && break
  sleep 1
done
if [ "$code" != "200" ]; then echo "app did not answer on port $PORT (got $code)" >&2; exit 1; fi
echo "> safari engine"
for i in $(seq 1 20); do [ -S "$RHSOCK" ] && break; sleep 1; done
rhget() { curl -s -m 25 --unix-socket "$RHSOCK" "http://rh$1" || true; }
pw="$(getvar ACCESS_KEY)"
sid="$(rhget "/newsession${pw:+?pwd=$pw}" | tr -d '[:space:]')"
if ! printf '%s' "$sid" | grep -qE '^[a-z0-9]{32}$'; then
  echo "  could not start a session (is revenge-rh running? systemctl status revenge-rh)" >&2
else
  if rhget "/$sid/https://example.com/" | grep -q 'Example Domain'; then
    echo "  reaches the public web: yes"
  else
    echo "  WARNING: could not reach example.com through it (DNS allowance?)" >&2
  fi
  # it must NOT reach this server's own services, nor the provider's private network
  leak=0
  for u in "http://127.0.0.1:$PORT/proxy/config.json" "http://[::ffff:127.0.0.1]:$PORT/proxy/config.json" \
           "http://localhost:$PORT/proxy/config.json" "http://[::1]:$PORT/proxy/config.json"; do
    rhget "/$sid/$u" | grep -q '"semag"' && leak=1
  done
  if rhget "/$sid/http://169.254.169.254/hetzner/v1/metadata" | grep -q 'instance-id'; then leak=1; fi
  if [ "$leak" = 1 ]; then
    systemctl stop revenge-rh
    echo "  FAILED: the Safari engine could reach this server's own services. I stopped it." >&2
    echo "  (the kernel IP filter is probably not working here; the rest of the site is fine)" >&2
    exit 1
  fi
  echo "  blocked from loopback, private networks and metadata: yes"
fi
echo "> done: https://$DOMAIN"
key="$(getvar ACCESS_KEY)"
skey="$(getvar STATS_KEY)"
echo "  proxy access key: ${key:-none (open)}"
echo "  stats page: https://${DOMAIN%%,*}/stats/  key: ${skey:-none (stats page off)}"
