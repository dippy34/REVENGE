#!/usr/bin/env bash
# setup.sh: first-time setup on a fresh Hetzner Cloud server (Ubuntu 24.04).
# Run as root:   bash setup.sh
# Then re-run any time to update to the latest main.
set -euo pipefail

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

echo "> firewall: ssh, http, https only"
ufw allow OpenSSH >/dev/null
if [ -n "$domain" ]; then ufw allow 80/tcp >/dev/null; ufw allow 443 >/dev/null; fi
ufw --force enable >/dev/null

echo "> starting"
if [ -n "$domain" ]; then
  docker compose --profile caddy up -d --build
  echo "> done: https://$domain (the certificate can take a minute the first time)"
else
  docker compose up -d --build
  echo "> done: running on http://localhost:8080 - point your Cloudflare Tunnel at it"
fi
docker image prune -f >/dev/null
