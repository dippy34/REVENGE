#!/usr/bin/env bash
# autodeploy.sh: run as root by kyrie-deploy.timer every 2 minutes (turned on
# with AUTODEPLOY=1 bash kyrie/setup-native.sh). When main on GitHub has
# moved, it brings the checkout up to it and runs setup-native.sh, which
# ends by checking that Kyrie answers. If anything fails, it goes back to
# the commit that was running, sets that up again, and leaves the bad commit
# alone until main moves on. Prints one line per deploy (journalctl -u
# kyrie-deploy); nothing about visitors.
#
# Everything sits in main(), so bash has read the whole file before the
# checkout it lives in changes under it.
set -euo pipefail

main() {
  local dir="${DIR:-/opt/revenge}" state="${DEPLOY_STATE:-/var/lib/kyrie-deploy}" conf="${DEPLOY_CONF:-/etc/kyrie-deploy.conf}"
  mkdir -p "$state"
  exec 9>"$state/lock"
  flock -n 9 || return 0 # one deploy at a time
  # shellcheck source=/dev/null
  . "$conf"
  : "${DOMAIN:?no DOMAIN in $conf}"

  git -C "$dir" fetch -q origin main
  local old new
  old="$(git -C "$dir" rev-parse HEAD)"
  new="$(git -C "$dir" rev-parse origin/main)"
  [ "$old" != "$new" ] || return 0
  [ "$(cat "$state/bad" 2>/dev/null || true)" != "$new" ] || return 0

  echo "deploying ${new:0:7} (was ${old:0:7})"
  if git -C "$dir" merge -q --ff-only "$new" && DOMAIN="$DOMAIN" NO_PULL=1 bash "$dir/kyrie/setup-native.sh" >"$state/last.log" 2>&1; then
    echo "$new" >"$state/live"
    rm -f "$state/bad"
    echo "live: ${new:0:7}"
  else
    echo "$new" >"$state/bad"
    echo "${new:0:7} failed (see $state/last.log); back to ${old:0:7}"
    git -C "$dir" reset -q --hard "$old"
    DOMAIN="$DOMAIN" NO_PULL=1 bash "$dir/kyrie/setup-native.sh" >"$state/rollback.log" 2>&1 || echo "the rollback failed too (see $state/rollback.log)"
    return 1
  fi
}

main "$@"
exit
