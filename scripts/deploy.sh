#!/usr/bin/env bash
#
# Manual deploy for the Invoice Creator VPS. Run as root on the host:
#
#   sudo /var/www/invoice-creator/scripts/deploy.sh
#
# Preconditions (see docs/DEPLOYMENT.md for first-time provisioning):
#   - /var/www/invoice-creator is a checkout of this repo on branch main
#   - /etc/invoice-creator/app.env and admin.env exist and are filled in
#   - the invoice-creator systemd unit is installed
#   - `npm test` is green on your machine for the commit you're shipping
#     (tests are NOT run here — vitest+PGlite is memory-heavy)

set -euo pipefail

APP_DIR=/var/www/invoice-creator
APP_ENV=/etc/invoice-creator/app.env
ADMIN_ENV=/etc/invoice-creator/admin.env
HEALTH_URL=http://127.0.0.1:3000/health

cd "$APP_DIR"

echo "==> Fetching latest main"
git fetch --all --prune
git reset --hard origin/main
echo "    now at $(git rev-parse --short HEAD) - $(git log -1 --pretty=%s)"

echo "==> Installing dependencies"
npm ci --include=dev

if [ "${SKIP_TYPECHECK:-0}" = "1" ]; then
  echo "==> Skipping type-check (SKIP_TYPECHECK=1)"
else
  echo "==> Type-checking"
  npm run typecheck
fi

echo "==> Running database migrations (as invoice_owner)"
set -a
# shellcheck disable=SC1090
. "$APP_ENV"
# shellcheck disable=SC1090
. "$ADMIN_ENV"
set +a
npm run migrate

echo "==> Restarting service"
systemctl restart invoice-creator

echo "==> Waiting for health check"
for _ in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" | grep -q '"status":"ok"'; then
    echo "==> Deploy OK — $(curl -fsS "$HEALTH_URL")"
    exit 0
  fi
  sleep 1
done

echo "!! Health check failed after 30s" >&2
systemctl status invoice-creator --no-pager -l >&2 || true
journalctl -u invoice-creator -n 40 --no-pager >&2 || true
exit 1
