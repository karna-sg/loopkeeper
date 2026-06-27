#!/usr/bin/env bash
# Prod redeploy, run ON the prod host as the restricted `deploy` user. The user's authorized_keys
# pins this script as a forced command, so a leaked key can only redeploy the merged main — nothing
# else. Recreates ONLY the api + caddy (never the worker that triggered this), so the worker
# survives and the deploy can't tear down its own process.
#
#   command="/opt/loopkeeper/ops/redeploy.sh",no-port-forwarding,no-pty ssh-ed25519 AAAA... deploy
set -euo pipefail

REPO_DIR="${DEPLOY_REMOTE_PATH:-/opt/loopkeeper}"
BRANCH="${DEPLOY_BRANCH:-main}"

cd "$REPO_DIR"

if ! git fetch --quiet origin "$BRANCH"; then
  echo "REDEPLOY_FAIL git-fetch"
  exit 1
fi
git reset --hard "origin/${BRANCH}" >/dev/null 2>&1

SHA="$(git rev-parse --short HEAD)"

cd "$REPO_DIR/deploy"
if docker compose up -d --build loopkeeper caddy >/dev/null 2>&1; then
  echo "REDEPLOY_OK ${SHA}"
else
  echo "REDEPLOY_FAIL docker-compose"
  exit 1
fi
