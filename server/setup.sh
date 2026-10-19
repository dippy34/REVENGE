#!/usr/bin/env bash
# setup.sh: set up (or update) the site + proxy on a Hetzner server.
# Works on Ubuntu / Debian. Safe on a server that already runs other things:
# it stops if a port it needs is taken, and asks before touching the firewall.
# Run as root:   bash setup.sh
# Then re-run any time to update to the latest main.
set -euo pipefail

if ! command -v apt-get >/dev/null; then
  echo "This script needs Ubuntu or Debian (apt). Tell Claude which OS this is." >&2
  exit 1
fi

# Something else already on a port we need? (our own containers are fine)
busy() { ss -Htln "sport = :$1" | grep -q . && ! docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":$1->"; }

REPO="${REPO:-https://github.com/dippy34/REVENGE.git}"
DIR="${DIR:-/opt/revenge}"

echo "> installing docker and git"
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 git ufw openssl >/dev/null
systemctl enable --now docker >/dev/null

echo "> getting the code"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR/server"

if [ ! -f .env ]; then
  read -rp "Domain (leave empty if you use a Cloudflare Tunnel): " domain
  key="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  printf 'DOMAIN=%s\nACCESS_KEY=%s\n' "$domain" "$key" > .env
  chmod 600 .env
  echo "> your proxy access key is: $key   (also saved in $DIR/server/.env)"
fi
domain="$(grep -E '^DOMAIN=' .env | cut -d= -f2-)"

ports="8080"; [ -n "$domain" ] && ports="8080 80 443"
for p in $ports; do
  if busy "$p"; then
    echo "Port $p is already used by something else on this server:" >&2
    ss -Htlnp "sport = :$p" >&2
    echo "Stopping so nothing breaks. Send this output to Claude." >&2
    exit 1
  fi
done

echo "> firewall"
ufw allow OpenSSH >/dev/null
if [ -n "$domain" ]; then ufw allow 80/tcp >/dev/null; ufw allow 443 >/dev/null; fi
if ufw status | grep -q "Status: active"; then
  echo "  firewall already on; added ssh/http/https rules, nothing else changed"
else
  read -rp "  Turn on the firewall (only SSH, HTTP, HTTPS get in)? Say n if this server runs other services. [y/N] " fw
  if [ "${fw:-n}" = "y" ]; then ufw --force enable >/dev/null; echo "  firewall on"; else echo "  left off"; fi
fi

echo "> starting"
if [ -n "$domain" ]; then
  docker compose --profile caddy up -d --build
  echo "> done: https://$domain (the certificate can take a minute the first time)"
else
  docker compose up -d --build
  echo "> done: running on http://localhost:8080 - point your Cloudflare Tunnel at it"
fi
docker image prune -f >/dev/null
