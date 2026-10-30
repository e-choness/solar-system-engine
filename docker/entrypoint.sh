#!/bin/sh
# Keeps the node_modules volume in sync with package-lock.json, then runs the command.
set -e
cd /app
if [ -f package-lock.json ]; then
  want=$(sha1sum package-lock.json | cut -d' ' -f1)
  have=$(cat node_modules/.lock-hash 2>/dev/null || true)
  if [ "$want" != "$have" ]; then
    echo "[entrypoint] installing dependencies (lockfile changed)"
    npm ci --no-audit --no-fund
    echo "$want" > node_modules/.lock-hash
  fi
fi
exec "$@"
