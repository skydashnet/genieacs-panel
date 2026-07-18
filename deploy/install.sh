#!/usr/bin/env bash
#
# SkyGenPanel installer — single-service GenieACS panel (UI + API on one port).
# Usage:  curl -fsSL https://raw.githubusercontent.com/skydashnet/genieacs-panel/main/deploy/install.sh | sudo bash
#
set -euo pipefail

REPO_URL="${SKYGP_REPO:-https://github.com/skydashnet/genieacs-panel}"
BRANCH="${SKYGP_BRANCH:-main}"
INSTALL_DIR="${SKYGP_DIR:-/opt/skygenpanel}"
DATA_DIR="${SKYGP_DATA:-/var/lib/skygenpanel}"
SERVICE_NAME="skygenpanel"
SERVICE_USER="${SKYGP_USER:-skygenpanel}"
APP_PORT="${SKYGP_PORT:-5890}"
CLI_PATH="/usr/local/bin/skygenpanel"
NODE_MAJOR_MIN=18

log()  { printf '\033[1;34m[skygp]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[skygp]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[skygp]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (use sudo)."

# --- dependencies -----------------------------------------------------------
command -v git >/dev/null 2>&1 || die "git is required. Install it and re-run."

if ! command -v node >/dev/null 2>&1; then
  die "Node.js not found. Install Node.js >= ${NODE_MAJOR_MIN} and re-run."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge "$NODE_MAJOR_MIN" ] || die "Node.js >= ${NODE_MAJOR_MIN} required (found $(node -v))."

command -v npm >/dev/null 2>&1 || die "npm is required."

# --- service user -----------------------------------------------------------
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating service user '$SERVICE_USER'"
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
    || useradd --system --home-dir "$DATA_DIR" --shell /bin/false "$SERVICE_USER"
fi

# --- fetch / update source --------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  log "Updating existing checkout in $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
else
  log "Cloning $REPO_URL ($BRANCH) into $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

# --- build ------------------------------------------------------------------
log "Installing backend dependencies"
( cd "$INSTALL_DIR/backend" && npm ci --omit=dev 2>/dev/null || npm install --omit=dev )

log "Installing frontend dependencies + building static export"
( cd "$INSTALL_DIR/frontend" && { npm ci 2>/dev/null || npm install; } && npm run build )

# --- data dir + env ---------------------------------------------------------
mkdir -p "$DATA_DIR"
ENV_FILE="$INSTALL_DIR/backend/.env"
if [ ! -f "$ENV_FILE" ]; then
  log "Generating $ENV_FILE with a random JWT secret"
  JWT_SECRET="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
  cat > "$ENV_FILE" <<EOF
APP_PORT=${APP_PORT}
APP_HOST=127.0.0.1
APP_ENV=production
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=1h
REFRESH_TOKEN_EXPIRES_IN=7d
CORS_ORIGINS=http://localhost:${APP_PORT}
DATA_DIR=${DATA_DIR}
EOF
  chmod 600 "$ENV_FILE"
else
  log "Keeping existing $ENV_FILE"
fi

chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR" "$DATA_DIR"

# --- systemd unit -----------------------------------------------------------
log "Installing systemd unit /etc/systemd/system/${SERVICE_NAME}.service"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=SkyGenPanel (GenieACS management panel)
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}/backend
EnvironmentFile=${INSTALL_DIR}/backend/.env
ExecStart=$(command -v node) ${INSTALL_DIR}/backend/src/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=${DATA_DIR} ${INSTALL_DIR}

[Install]
WantedBy=multi-user.target
EOF

# --- CLI --------------------------------------------------------------------
log "Installing CLI at ${CLI_PATH}"
install -m 0755 "$INSTALL_DIR/deploy/skygenpanel" "$CLI_PATH"

# --- start ------------------------------------------------------------------
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"

sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
  log "Service is running."
  log "Open http://localhost:${APP_PORT} to finish setup."
  log "By default the panel binds to 127.0.0.1. Run 'skygenpanel expose' to allow LAN access."
else
  warn "Service failed to start. Check: journalctl -u ${SERVICE_NAME} -n 50"
  exit 1
fi
