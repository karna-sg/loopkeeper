#!/usr/bin/env bash
# Run the Loopkeeper backend from its built output, loading local secrets from an env file
# OUTSIDE the repo (default ~/.loopkeeper/env) so nothing sensitive is ever committed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${LOOPKEEPER_ENV_FILE:-$HOME/.loopkeeper/env}"

if [ -f "$ENV_FILE" ]; then
  set -a            # export everything sourced
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  echo "note: no env file at $ENV_FILE — running with defaults (no OpenAI/OAuth)." >&2
fi

cd "$ROOT/backend"
[ -f dist/server/server.mjs ] || pnpm build
exec node dist/server/server.mjs
