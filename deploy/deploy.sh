#!/usr/bin/env bash
# Pull-based CD, run by mimir-deploy.timer on the server: if `main` has a new
# commit, build and test it as the `mimir` user, switch `current` to it, restart,
# and roll back if the health check fails. A commit that fails is not retried.
set -euo pipefail

REPO=${MIMIR_REPO:-https://github.com/anishmitta1/vigilant-garbanzo.git}
BRANCH=${MIMIR_BRANCH:-main}
ROOT=${MIMIR_ROOT:-/opt/mimir}
PORT=${MIMIR_PORT:-3000}
KEEP=3
export PATH=/opt/node/bin:$PATH

sha=$(git ls-remote "$REPO" "refs/heads/$BRANCH" | cut -f1)
[ -n "$sha" ] || { echo "could not resolve $BRANCH"; exit 1; }
prev=$(readlink -f "$ROOT/current" || true)
[ "$(basename "$prev")" = "$sha" ] && exit 0
[ -e "$ROOT/releases/$sha.failed" ] && exit 0

echo "deploying $BRANCH@$sha"
rel=$ROOT/releases/$sha
as_mimir() { runuser -u mimir -- env PATH="$PATH" HOME=/var/lib/mimir npm_config_cache=/var/lib/mimir/.npm "$@"; }
fail() { echo "deploy of $sha failed: $1"; touch "$ROOT/releases/$sha.failed"; exit 1; }

rm -rf "$rel"
install -d -o mimir -g mimir "$ROOT/releases" "$rel"
cd "$rel"
as_mimir git -c advice.detachedHead=false clone -q "$REPO" . || fail "clone"
as_mimir git checkout -q "$sha" || fail "checkout"
as_mimir npm ci --no-audit --no-fund || fail "npm ci"
as_mimir npm test || fail "tests"
as_mimir npm run build || fail "build"
as_mimir npm prune --omit=dev --no-audit --no-fund || fail "prune"

ln -sfn "$rel" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
systemctl restart mimir
for _ in $(seq 1 15); do
  sleep 2
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null; then
    echo "deployed $sha"
    ls -1dt "$ROOT"/releases/*/ | tail -n +$((KEEP + 1)) | grep -v "$sha" | xargs -r rm -rf
    exit 0
  fi
done

echo "health check failed, rolling back to $prev"
[ -n "$prev" ] && ln -sfn "$prev" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
systemctl restart mimir
fail "health check"
