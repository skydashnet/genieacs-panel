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
NODE_MAJOR_MIN=20

log()  { printf '\033[1;34m[skygp]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[skygp]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[skygp]\033[0m %s\n' "$*" >&2; exit 1; }

validate_dir() {
  local label="$1" target="$2"
  local resolved
  [[ "$target" = /* ]] || die "$label must be an absolute path: $target"
  resolved="$(realpath -m -- "$target")" || die "Unable to resolve $label: $target"
  [ "$resolved" = "$target" ] || die "$label must be normalized and contain no symbolic-link components: $target"
  case "$target" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var|/var/lib)
      die "Refusing unsafe $label path: $target"
      ;;
  esac
  [[ "$target" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "$label contains unsupported characters: $target"
}

validate_dir "install directory" "$INSTALL_DIR"
validate_dir "data directory" "$DATA_DIR"
[ "$INSTALL_DIR" != "$DATA_DIR" ] || die "Install and data directories must be different."
[[ "$DATA_DIR/" != "$INSTALL_DIR/"* ]] || die "Data directory must not be inside the install directory."
[[ "$INSTALL_DIR/" != "$DATA_DIR/"* ]] || die "Install directory must not be inside the data directory."
[ ! -L "$INSTALL_DIR" ] || die "Install directory must not be a symbolic link."
[ ! -L "$DATA_DIR" ] || die "Data directory must not be a symbolic link."
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "Invalid service user name: $SERVICE_USER"
[ "$SERVICE_USER" != "root" ] || die "Refusing to run the service as root."

[[ "$APP_PORT" =~ ^[0-9]+$ ]] && [ "$APP_PORT" -ge 1 ] && [ "$APP_PORT" -le 65535 ] \
  || die "SKYGP_PORT must be an integer between 1 and 65535."

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
  if [ -e "$INSTALL_DIR" ] && [ "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    die "Install directory exists and is not a git checkout: $INSTALL_DIR"
  fi
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

# --- build ------------------------------------------------------------------
log "Installing backend dependencies"
( cd "$INSTALL_DIR/backend" && npm ci --omit=dev )

log "Installing frontend dependencies + building static export"
( cd "$INSTALL_DIR/frontend" && npm ci --include=dev && npm run build )

# --- data dir + env ---------------------------------------------------------
mkdir -p "$DATA_DIR"
ENV_FILE="$INSTALL_DIR/backend/.env"
[ ! -L "$ENV_FILE" ] || die "Refusing symbolic-link env file: $ENV_FILE"
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

ACTIVE_PORT="$(grep -E '^APP_PORT=' "$ENV_FILE" | head -1 | cut -d= -f2)"
ACTIVE_PORT="${ACTIVE_PORT:-$APP_PORT}"
[[ "$ACTIVE_PORT" =~ ^[0-9]+$ ]] && [ "$ACTIVE_PORT" -ge 1 ] && [ "$ACTIVE_PORT" -le 65535 ] \
  || die "Existing APP_PORT must be an integer between 1 and 65535."

chown -R root:root "$INSTALL_DIR"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR"
chmod 600 "$ENV_FILE"

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
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
UMask=0027
ReadWritePaths=${DATA_DIR}

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

ready=false
for _ in $(seq 1 20); do
  if systemctl is-active --quiet "$SERVICE_NAME" && \
    node -e "fetch('http://127.0.0.1:${ACTIVE_PORT}/api/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"; then
    ready=true
    break
  fi
  sleep 1
done

if [ "$ready" = true ]; then
  log "Service is running."
  log "Open http://localhost:${ACTIVE_PORT} to finish setup."
  log "By default the panel binds to 127.0.0.1. Run 'skygenpanel expose' to allow LAN access."
else
  warn "Service failed to start. Check: journalctl -u ${SERVICE_NAME} -n 50"
  exit 1
fi
