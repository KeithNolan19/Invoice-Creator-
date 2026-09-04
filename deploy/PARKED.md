# Invoice Creator is parked

Parked on **2026-09-04** so the vibedev.ie droplet can host another project
(AutoPay). Nothing was deleted — this is fully reversible.

## What "parked" means

| Thing | State |
|---|---|
| Code (`/var/www/invoice-creator`) | untouched, git clean at `f5b1535` |
| Database `invoice_creator` (Postgres) | untouched, still on the box |
| DB backup | `/var/www/backups/invoice_creator_parked_2026-09-04_1247.sql.gz` |
| `invoice-creator.service` | stopped + disabled |
| `invoice-billing.timer` | stopped + disabled |
| nginx | `invoice-creator` site disabled; `vibedev-holding` (static page) enabled |
| Port 3000 | freed |
| TLS cert `/etc/letsencrypt/live/vibedev.ie/` | unchanged, still auto-renewing |

## To bring it back

```bash
sudo bash /var/www/invoice-creator/deploy/unpark.sh
```

That re-enables the services, swaps the nginx site back, and health-checks.
If AutoPay is by then using port 3000, change `PORT` in
`/etc/invoice-creator/app.env` and the `proxy_pass` in the nginx site first.
