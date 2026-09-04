#!/usr/bin/env bash
# Bring Invoice Creator back after it was parked (see deploy/PARKED.md).
# Run as root on the droplet.
set -euo pipefail

echo "==> Re-enabling systemd units"
systemctl enable --now invoice-creator.service
systemctl enable --now invoice-billing.timer

echo "==> Restoring the nginx site"
rm -f /etc/nginx/sites-enabled/vibedev-holding
ln -sf /etc/nginx/sites-available/invoice-creator /etc/nginx/sites-enabled/invoice-creator
nginx -t
systemctl reload nginx

echo "==> Health check"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/health | grep -q '"status":"ok"'; then
    echo "healthy — https://vibedev.ie/app/ is live again"
    exit 0
  fi
  sleep 1
done
echo "health check FAILED"
systemctl status invoice-creator --no-pager -l | tail -20
exit 1
