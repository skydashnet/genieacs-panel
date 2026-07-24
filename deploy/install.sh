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
NODE_RELEASE_LINE=22

log()  { printf '\033[1;34m[skygp]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[skygp]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[skygp]\033[0m %s\n' "$*" >&2; exit 1; }

validate_dir_syntax() {
  local label="$1" target="$2"
  [[ "$target" = /* ]] || die "$label must be an absolute path: $target"
  case "$target" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var|/var/lib)
      die "Refusing unsafe $label path: $target"
      ;;
  esac
  [[ "$target" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "$label contains unsupported characters: $target"
  case "$target/" in
    *'//'*|*'/./'*|*'/../'*)
      die "$label must be normalized and contain no symbolic-link components: $target"
      ;;
  esac
}

validate_dir_canonical() {
  local label="$1" target="$2" resolved
  resolved="$(realpath -m -- "$target")" || die "Unable to resolve $label: $target"
  [ "$resolved" = "$target" ] || die "$label must be normalized and contain no symbolic-link components: $target"
  [ ! -L "$target" ] || die "$label must not be a symbolic link: $target"
}

install_system_dependencies() {
  local missing=()
  local command_name
  for command_name in git curl tar xz sha256sum realpath find grep awk sed make c++ python3 useradd; do
    command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name")
  done
  [ "${#missing[@]}" -gt 0 ] || return 0

  log "Installing required system packages (missing: ${missing[*]})"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends \
      git curl ca-certificates xz-utils tar coreutils findutils grep gawk sed \
      build-essential python3 passwd
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y \
      git curl ca-certificates xz tar coreutils findutils grep gawk sed \
      gcc-c++ make python3 shadow-utils
  elif command -v yum >/dev/null 2>&1; then
    yum install -y \
      git curl ca-certificates xz tar coreutils findutils grep gawk sed \
      gcc-c++ make python3 shadow-utils
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Syu --needed --noconfirm \
      git curl ca-certificates xz tar coreutils findutils grep gawk sed \
      base-devel python shadow
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive refresh
    zypper --non-interactive install \
      git curl ca-certificates xz tar coreutils findutils grep gawk sed \
      gcc-c++ make python3 shadow
  else
    die "No supported package manager found. Supported: apt, dnf, yum, pacman, zypper."
  fi

  for command_name in git curl tar xz sha256sum realpath find grep awk sed make c++ python3 useradd; do
    command -v "$command_name" >/dev/null 2>&1 \
      || die "Failed to install required command: $command_name"
  done
}

node_archive_arch() {
  case "${1:-$(uname -m)}" in
    x86_64|amd64) echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    armv7l) echo "armv7l" ;;
    ppc64le) echo "ppc64le" ;;
    s390x) echo "s390x" ;;
    *) return 1 ;;
  esac
}

node_runtime_ready() {
  local major resolved_node
  command -v node >/dev/null 2>&1 || return 1
  command -v npm >/dev/null 2>&1 || return 1
  resolved_node="$(realpath "$(command -v node)" 2>/dev/null || true)"
  case "$resolved_node" in
    /home/*|/root/*|'') return 1 ;;
  esac
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  [[ "$major" =~ ^[0-9]+$ ]] && [ "$major" -ge "$NODE_MAJOR_MIN" ]
}

install_node_runtime() {
  if node_runtime_ready; then
    log "Using existing Node.js $(node -v) and npm $(npm -v)"
    return 0
  fi

  local archive_arch release_url temp_dir archive checksum_file node_home extracted_home archive_version
  archive_arch="$(node_archive_arch)" \
    || die "Unsupported CPU architecture for Node.js: $(uname -m)"
  release_url="https://nodejs.org/dist/latest-v${NODE_RELEASE_LINE}.x"
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/skygenpanel-node.XXXXXXXX")"

  cleanup_node_temp() {
    if [ -n "${temp_dir:-}" ] && [ -d "$temp_dir" ]; then
      rm -rf -- "$temp_dir"
    fi
  }
  trap cleanup_node_temp EXIT

  log "Downloading the latest official Node.js ${NODE_RELEASE_LINE}.x for linux-${archive_arch}"
  checksum_file="$temp_dir/SHASUMS256.txt"
  curl --proto '=https' --tlsv1.2 --retry 3 --fail --location \
    "$release_url/SHASUMS256.txt" --output "$checksum_file"

  archive="$(awk -v arch="$archive_arch" \
    '$2 ~ ("^node-v[0-9.]+-linux-" arch "\\.tar\\.xz$") { print $2; exit }' \
    "$checksum_file")"
  [ -n "$archive" ] || die "No official Node.js archive found for linux-${archive_arch}"

  curl --proto '=https' --tlsv1.2 --retry 3 --fail --location \
    "$release_url/$archive" --output "$temp_dir/$archive"
  awk -v file="$archive" '$2 == file { print; found = 1 } END { exit !found }' \
    "$checksum_file" > "$temp_dir/SHASUMS256.selected"
  ( cd "$temp_dir" && sha256sum --check --strict SHASUMS256.selected )

  node_home="/usr/local/lib/nodejs/${archive%.tar.xz}"
  archive_version="${archive#node-}"
  archive_version="${archive_version%-linux-*}"
  install -d -m 0755 /usr/local/lib/nodejs /usr/local/bin
  tar -xJf "$temp_dir/$archive" -C "$temp_dir"
  extracted_home="$temp_dir/${archive%.tar.xz}"
  [ -x "$extracted_home/bin/node" ] || die "Downloaded Node.js archive has an invalid layout."

  if [ -e "$node_home" ] || [ -L "$node_home" ]; then
    [ -d "$node_home" ] && [ ! -L "$node_home" ] && [ -x "$node_home/bin/node" ] \
      || die "Existing Node.js target is not a safe runtime directory: $node_home"
    [ "$("$node_home/bin/node" -v)" = "$archive_version" ] \
      || die "Existing Node.js target has an unexpected version: $node_home"
  else
    mv -- "$extracted_home" "$node_home"
  fi

  local tool source_path destination backup
  for tool in node npm npx corepack; do
    source_path="$node_home/bin/$tool"
    [ -e "$source_path" ] || continue
    destination="/usr/local/bin/$tool"
    if [ -e "$destination" ] && [ ! -L "$destination" ]; then
      backup="${destination}.before-skygenpanel-$(date +%s)-$$"
      warn "Preserving existing $destination as $backup"
      mv -- "$destination" "$backup"
    fi
    ln -sfn "$source_path" "$destination"
  done
  hash -r
  node_runtime_ready || die "Node.js installation completed but runtime verification failed."

  cleanup_node_temp
  trap - EXIT
  log "Installed Node.js $(node -v) and npm $(npm -v)"
}

validate_dir_syntax "install directory" "$INSTALL_DIR"
validate_dir_syntax "data directory" "$DATA_DIR"
[ "$INSTALL_DIR" != "$DATA_DIR" ] || die "Install and data directories must be different."
[[ "$DATA_DIR/" != "$INSTALL_DIR/"* ]] || die "Data directory must not be inside the install directory."
[[ "$INSTALL_DIR/" != "$DATA_DIR/"* ]] || die "Install directory must not be inside the data directory."
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "Invalid service user name: $SERVICE_USER"
[ "$SERVICE_USER" != "root" ] || die "Refusing to run the service as root."

[[ "$APP_PORT" =~ ^[0-9]+$ ]] && [ "$APP_PORT" -ge 1 ] && [ "$APP_PORT" -le 65535 ] \
  || die "SKYGP_PORT must be an integer between 1 and 65535."

if [ "$EUID" -eq 0 ]; then
  log "Root privileges detected; sudo is not required."
else
  die "Root privileges are required. Re-run with: curl -fsSL https://raw.githubusercontent.com/skydashnet/genieacs-panel/main/deploy/install.sh | sudo bash"
fi

# --- dependencies -----------------------------------------------------------
command -v systemctl >/dev/null 2>&1 || die "systemd is required on the target machine."
[ -d /run/systemd/system ] || die "systemd must be running as the system service manager."
install_system_dependencies
validate_dir_canonical "install directory" "$INSTALL_DIR"
validate_dir_canonical "data directory" "$DATA_DIR"
command -v useradd >/dev/null 2>&1 || die "useradd is required but was not installed."
install_node_runtime

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
