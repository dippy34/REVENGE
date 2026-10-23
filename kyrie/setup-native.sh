#!/usr/bin/env bash
# setup-native.sh: add Kyrie to the box that already runs the 631 site through
# server/setup-native.sh (same checkout, same Caddy). Nothing else is changed:
#   - Kyrie runs as its own systemd service, `kyrie`, on 127.0.0.1:$PORT, as the
#     `revenge` user (so it can reach the Safari engine's socket in /run/revenge)
#   - behind the 631 door it serves the whole site from this checkout, with its
#     own visit counts (/var/lib/kyrie) and game cache (/var/cache/kyrie)
#   - one site block for $DOMAIN is appended to /etc/caddy/Caddyfile
#     (backed up first, validated, restored if invalid)
#
# Run as root, after server/setup-native.sh has run once:
#   DOMAIN='kyriestudy.com, www.kyriestudy.com' ANTHROPIC_API_KEY=... bash kyrie/setup-native.sh
# Re-run any time to update to the latest main. ANTHROPIC_API_KEY is only needed
# the first time (it is saved in /etc/kyrie.env); without one, the site's own key
# from /etc/revenge.env is used if it has one.
set -euo pipefail

DIR="${DIR:-/opt/revenge}"
PORT="${PORT:-8130}"
DOMAIN="${DOMAIN:?set DOMAIN, e.g. DOMAIN=\"kyriestudy.com, www.kyriestudy.com\"}"
UNIT=/etc/systemd/system/kyrie.service
ENVF=/etc/kyrie.env
SITEENV=/etc/revenge.env
RHSOCK=/run/revenge/rh.sock
CADDYFILE=/etc/caddy/Caddyfile
MARK="# kyrie-site"

for c in node npm git caddy curl; do
  command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 1; }
done
node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo "need Node 20+" >&2; exit 1; }
id revenge >/dev/null 2>&1 && [ -d "$DIR/.git" ] && [ -f "$SITEENV" ] || {
  echo "run server/setup-native.sh first (no revenge user, $DIR checkout or $SITEENV)" >&2; exit 1
}

if ss -Htln "sport = :$PORT" | grep -q . && ! systemctl is-active --quiet kyrie; then
  echo "port $PORT is already in use:" >&2; ss -Htlnp "sport = :$PORT" >&2; exit 1
fi

echo "> code"
git -C "$DIR" pull -q --ff-only
(cd "$DIR/server" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
(cd "$DIR/kyrie" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
[ -f "$DIR/kyrie/server.mjs" ] || { echo "no kyrie/ in $DIR: is it on main yet?" >&2; exit 1; }

echo "> settings"
touch "$ENVF"
chmod 600 "$ENVF"
getvar() { grep -m1 "^$1=" "$2" | cut -d= -f2- || true; }
setvar() {
  { grep -v "^$1=" "$ENVF" || true; printf '%s=%s\n' "$1" "$2"; } > "$ENVF.tmp"
  mv "$ENVF.tmp" "$ENVF"
  chmod 600 "$ENVF"
}
# the Claude key: passed in (replaces the saved one), else saved, else the site's
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then setvar ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
elif [ -z "$(getvar ANTHROPIC_API_KEY "$ENVF")" ] && [ -n "$(getvar ANTHROPIC_API_KEY "$SITEENV")" ]; then
  setvar ANTHROPIC_API_KEY "$(getvar ANTHROPIC_API_KEY "$SITEENV")"
fi
# the proxy lock and the stats page follow the 631 site's settings on every run
# (only these two: its hunt secrets stay with it, so the hunt is off on Kyrie)
setvar ACCESS_KEY "$(getvar ACCESS_KEY "$SITEENV")"
setvar STATS_KEY "$(getvar STATS_KEY "$SITEENV")"

echo "> service"
cat > "$UNIT" <<EOF
[Unit]
Description=Kyrie, the study app, with the 631 site behind its door (see $DIR/kyrie/README.md)
After=network-online.target revenge-rh.service
Wants=network-online.target revenge-rh.service

[Service]
User=revenge
WorkingDirectory=$DIR/kyrie
EnvironmentFile=$ENVF
Environment=KYRIE_HOST=127.0.0.1 KYRIE_PORT=$PORT NODE_ENV=production CACHE_DIR=/var/cache/kyrie STATS_DIR=/var/lib/kyrie RH_SOCKET=$RHSOCK
StateDirectory=kyrie
StateDirectoryMode=0750
CacheDirectory=kyrie
CacheDirectoryMode=0750
ExecStart=$(command -v node) server.mjs
Restart=always
RestartSec=2
# no logs, by design
StandardOutput=null
StandardError=null
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
systemctl enable -q kyrie
systemctl restart kyrie

echo "> caddy"
current="$(grep -A1 -F "$MARK" "$CADDYFILE" | tail -n +2 | sed 's/ *{$//' || true)"
if [ "$current" = "$DOMAIN" ]; then
  echo "  site block for $DOMAIN already present"
else
  bak="$CADDYFILE.bak-kyrie-$(date +%Y%m%d-%H%M%S)"
  cp -p "$CADDYFILE" "$bak"
  if [ -n "$current" ]; then
    sed -i "/^$MARK/{n;s/^.* {\$/$DOMAIN {/}" "$CADDYFILE"
  else
    printf '\n%s (added by kyrie/setup-native.sh)\n%s {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:%s\n}\n' "$MARK" "$DOMAIN" "$PORT" >> "$CADDYFILE"
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
if [ "$code" != "200" ]; then echo "Kyrie did not answer on port $PORT (got $code)" >&2; exit 1; fi
door="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Sec-Fetch-Site: same-origin' "http://127.0.0.1:$PORT/631" || true)"
menu="$(curl -s -H 'Cookie: kyrie631=1' "http://127.0.0.1:$PORT/" | grep -c 'data-page="menu"' || true)"
if [ "$door" = "204" ] && [ "$menu" = "1" ]; then echo "  631 door: works"; else echo "  WARNING: the 631 door did not open (POST /631 gave $door)" >&2; fi
[ -n "$(getvar ANTHROPIC_API_KEY "$ENVF")" ] && echo "  Claude cards: on" || echo "  Claude cards: off (no ANTHROPIC_API_KEY yet)"
echo "> done: https://${DOMAIN%%,*}"
