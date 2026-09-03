#!/usr/bin/env bash
#
# First-time provisioning for the Invoice Creator VPS. Idempotent: safe to
# re-run. Run as root on a fresh Ubuntu host:
#
#   sudo CERTBOT_EMAIL=you@example.com \
#        ADMIN_EMAIL=you@example.com \
#        bash /var/www/invoice-creator/deploy/provision.sh
#
# If /var/www/invoice-creator does not exist yet, run it straight from GitHub:
#
#   curl -fsSL https://raw.githubusercontent.com/KeithNolan19/Invoice-Creator-/main/deploy/provision.sh \
#     | sudo CERTBOT_EMAIL=you@example.com ADMIN_EMAIL=you@example.com bash
#
# Generated secrets (DB passwords, JWT secret) are written once to
# /etc/invoice-creator/*.env and never rotated on re-run. The platform admin
# password is generated if ADMIN_PASSWORD is unset and printed ONCE at the end.
#
# After provisioning, ongoing releases use scripts/deploy.sh.

set -euo pipefail

APP_DIR=${APP_DIR:-/var/www/invoice-creator}
REPO_URL=${REPO_URL:-https://github.com/KeithNolan19/Invoice-Creator-.git}
BRANCH=${BRANCH:-main}
DOMAIN=${DOMAIN:-vibedev.ie}
ALT_DOMAIN=${ALT_DOMAIN:-www.${DOMAIN}}
APP_USER=${APP_USER:-invoice}
CONF_DIR=/etc/invoice-creator
APP_ENV="$CONF_DIR/app.env"
ADMIN_ENV="$CONF_DIR/admin.env"

CERTBOT_EMAIL=${CERTBOT_EMAIL:-}
ADMIN_EMAIL=${ADMIN_EMAIL:-}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-}
ADMIN_NAME=${ADMIN_NAME:-}

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
psql_su() { sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"

# ---------------------------------------------------------------------------
say "Ensuring swap (this droplet has little RAM)"
if [ "$(swapon --show=NAME --noheadings | wc -l)" -eq 0 ]; then
  SWAP_GB=${SWAP_GB:-2}
  fallocate -l "${SWAP_GB}G" /swapfile 2>/dev/null || \
    dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_GB * 1024)) status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
  echo "    added ${SWAP_GB}G swap"
else
  echo "    swap already present"
fi

# ---------------------------------------------------------------------------
say "Installing OS packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg postgresql nginx \
  certbot python3-certbot-nginx openssl >/dev/null

# ---------------------------------------------------------------------------
say "Ensuring Node.js 24"
need_node=1
if command -v node >/dev/null 2>&1; then
  case "$(node -v)" in v24.*) need_node=0;; esac
fi
if [ "$need_node" -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN=$(command -v node)
echo "    node $($NODE_BIN -v) at $NODE_BIN"

# ---------------------------------------------------------------------------
say "Creating system user '$APP_USER'"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

# ---------------------------------------------------------------------------
say "Fetching the application into $APP_DIR"
# The checkout is owned by $APP_USER; allow root's git to operate on it.
git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$APP_DIR" || \
  git config --global --add safe.directory "$APP_DIR"
if [ ! -d "$APP_DIR/.git" ]; then
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" fetch --all --prune
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
echo "    at $(git -C "$APP_DIR" rev-parse --short HEAD) - $(git -C "$APP_DIR" log -1 --pretty=%s)"

# ---------------------------------------------------------------------------
say "Configuring PostgreSQL (localhost only, low-memory tuning)"
systemctl enable --now postgresql >/dev/null 2>&1 || true
psql_su -c "ALTER SYSTEM SET listen_addresses = 'localhost'"
psql_su -c "ALTER SYSTEM SET shared_buffers = '64MB'"
psql_su -c "ALTER SYSTEM SET effective_cache_size = '192MB'"
psql_su -c "ALTER SYSTEM SET work_mem = '4MB'"
psql_su -c "ALTER SYSTEM SET maintenance_work_mem = '32MB'"
psql_su -c "ALTER SYSTEM SET max_connections = '30'"
systemctl restart postgresql

# ---------------------------------------------------------------------------
say "Writing $CONF_DIR (secrets generated once, kept on re-run)"
mkdir -p "$CONF_DIR"

if [ -f "$ADMIN_ENV" ]; then
  OWNER_PW=$(sed -n 's#.*//invoice_owner:\([^@]*\)@.*#\1#p' "$ADMIN_ENV")
else
  OWNER_PW=$(openssl rand -hex 24)
fi
if [ -f "$APP_ENV" ]; then
  APP_PW=$(sed -n 's#.*//invoice_app_login:\([^@]*\)@.*#\1#p' "$APP_ENV")
  JWT_SECRET=$(sed -n 's#^JWT_SECRET=##p' "$APP_ENV")
else
  APP_PW=$(openssl rand -hex 24)
  JWT_SECRET=$("$NODE_BIN" -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
fi
[ -n "$OWNER_PW" ] && [ -n "$APP_PW" ] && [ -n "$JWT_SECRET" ] || die "could not resolve secrets"

if [ ! -f "$ADMIN_ENV" ]; then
  cat > "$ADMIN_ENV" <<EOF
DATABASE_ADMIN_URL=postgres://invoice_owner:${OWNER_PW}@localhost:5432/invoice_creator
EOF
fi
chown root:root "$ADMIN_ENV"; chmod 600 "$ADMIN_ENV"

if [ ! -f "$APP_ENV" ]; then
  cat > "$APP_ENV" <<EOF
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://invoice_app_login:${APP_PW}@localhost:5432/invoice_creator
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=30m
LOGIN_MAX_PER_IDENTITY=8
LOGIN_MAX_PER_IP=30
LOGIN_WINDOW_MS=900000
EOF
fi
chown "$APP_USER:$APP_USER" "$APP_ENV"; chmod 640 "$APP_ENV"

# ---------------------------------------------------------------------------
say "Creating database role + database"
if ! psql_su -tAc "SELECT 1 FROM pg_roles WHERE rolname='invoice_owner'" | grep -q 1; then
  psql_su -c "CREATE ROLE invoice_owner LOGIN PASSWORD '${OWNER_PW}' CREATEROLE BYPASSRLS"
else
  psql_su -c "ALTER ROLE invoice_owner LOGIN PASSWORD '${OWNER_PW}' CREATEROLE BYPASSRLS"
fi
if ! psql_su -tAc "SELECT 1 FROM pg_database WHERE datname='invoice_creator'" | grep -q 1; then
  psql_su -c "CREATE DATABASE invoice_creator OWNER invoice_owner"
fi
psql_su -d invoice_creator -c "ALTER SCHEMA public OWNER TO invoice_owner"

# ---------------------------------------------------------------------------
say "Installing dependencies + running migrations"
sudo -H -u "$APP_USER" bash -c "cd '$APP_DIR' && npm ci --include=dev"
set -a; . "$APP_ENV"; . "$ADMIN_ENV"; set +a
sudo -H -u "$APP_USER" --preserve-env=DATABASE_URL,DATABASE_ADMIN_URL,JWT_SECRET,NODE_ENV \
  bash -c "cd '$APP_DIR' && npm run migrate"

# app role can now log in
psql_su -d invoice_creator -c "ALTER ROLE invoice_app_login WITH LOGIN PASSWORD '${APP_PW}'"

# ---------------------------------------------------------------------------
say "Installing the systemd service"
sed "s#^ExecStart=.*#ExecStart=${NODE_BIN} --import tsx/esm src/server.ts#" \
  "$APP_DIR/deploy/invoice-creator.service" > /etc/systemd/system/invoice-creator.service
systemctl daemon-reload
systemctl enable invoice-creator >/dev/null 2>&1 || true
systemctl restart invoice-creator

say "Waiting for the app to become healthy"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/health 2>/dev/null | grep -q '"status":"ok"'; then ok=1; break; fi
  sleep 1
done
[ "$ok" -eq 1 ] || { journalctl -u invoice-creator -n 40 --no-pager >&2; die "app did not become healthy"; }
echo "    /health OK"

# ---------------------------------------------------------------------------
say "Creating the platform admin"
ADMIN_CREATED_PW=""
if [ -n "$ADMIN_EMAIL" ]; then
  if [ -z "$ADMIN_PASSWORD" ]; then
    ADMIN_PASSWORD=$(openssl rand -base64 18)
    ADMIN_CREATED_PW="$ADMIN_PASSWORD"
  fi
  export ADMIN_EMAIL ADMIN_PASSWORD ADMIN_NAME
  set +e
  out=$(sudo -H -u "$APP_USER" \
    --preserve-env=DATABASE_URL,DATABASE_ADMIN_URL,JWT_SECRET,NODE_ENV,ADMIN_EMAIL,ADMIN_PASSWORD,ADMIN_NAME \
    bash -c "cd '$APP_DIR' && npm run --silent create-admin" 2>&1)
  rc=$?
  set -e
  echo "$out" | sed 's/^/    /'
  if [ $rc -ne 0 ]; then
    echo "$out" | grep -qi "already exists" && { warn "admin already exists — leaving it"; ADMIN_CREATED_PW=""; } \
      || die "create-admin failed"
  fi
else
  warn "ADMIN_EMAIL not set — skipping admin creation. Run later:"
  warn "  set -a; . $APP_ENV; . $ADMIN_ENV; set +a"
  warn "  sudo -u $APP_USER --preserve-env=DATABASE_URL,DATABASE_ADMIN_URL,JWT_SECRET,NODE_ENV \\"
  warn "    ADMIN_EMAIL=you@example.com bash -c 'cd $APP_DIR && npm run create-admin'"
fi

# ---------------------------------------------------------------------------
say "Configuring nginx"
if [ ! -e /etc/nginx/sites-available/invoice-creator ]; then
  cp "$APP_DIR/deploy/invoice-creator.nginx" /etc/nginx/sites-available/invoice-creator
fi
ln -sf /etc/nginx/sites-available/invoice-creator /etc/nginx/sites-enabled/invoice-creator
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

if [ -n "$CERTBOT_EMAIL" ]; then
  if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    say "Obtaining a TLS certificate"
    certbot --nginx -d "$DOMAIN" -d "$ALT_DOMAIN" \
      --non-interactive --agree-tos -m "$CERTBOT_EMAIL" --redirect
  else
    echo "    certificate for $DOMAIN already present"
  fi
else
  warn "CERTBOT_EMAIL not set — the site is HTTP only. Run later:"
  warn "  sudo certbot --nginx -d $DOMAIN -d $ALT_DOMAIN --redirect -m you@example.com --agree-tos"
fi

# ---------------------------------------------------------------------------
say "Done"
scheme=http; [ -d "/etc/letsencrypt/live/$DOMAIN" ] && scheme=https
echo "  Service:   $(systemctl is-active invoice-creator)"
echo "  Health:    $(curl -fsS "$scheme://$DOMAIN/health" 2>/dev/null || echo '(check DNS/TLS)')"
echo "  Customer:  $scheme://$DOMAIN/app/"
echo "  Admin CC:  $scheme://$DOMAIN/admin/"
if [ -n "$ADMIN_CREATED_PW" ]; then
  echo
  echo "  ┌─ PLATFORM ADMIN (shown once) ──────────────────────────────"
  echo "  │  email:    $ADMIN_EMAIL"
  echo "  │  password: $ADMIN_CREATED_PW"
  echo "  └────────────────────────────────────────────────────────────"
  echo "  Sign in at $scheme://$DOMAIN/admin/ and change nothing else until you have."
fi
echo
echo "  Ongoing deploys:  sudo $APP_DIR/scripts/deploy.sh"
