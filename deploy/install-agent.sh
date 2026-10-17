#!/usr/bin/env bash
#
# Instalador do agente do GenieACS do SkyGenPanel.
#
# Uso:        curl -fsSL https://<painel>/api/genieacs-agent/install.sh | sudo bash
# Desfazer:   curl -fsSL https://<painel>/api/genieacs-agent/install.sh | sudo bash -s -- --uninstall
#
# O agente é um programa pequeno que roda numa máquina da rede do provedor, abre
# uma conexão WebSocket de SAÍDA para o painel e fica esperando: quando o painel
# precisa falar com a NBI do GenieACS daquele provedor, manda o pedido por essa
# conexão e o agente chama o GenieACS local. Nenhuma porta é aberta na rede do
# provedor — por isso ele serve a quem não tem IP público.
#
# A CHAVE
#
#   A chave do agente (`sgpa_…`) é a credencial do provedor inteiro perante o
#   painel, e este script foi escrito em volta de uma regra só: ela nunca passa
#   pelo argv de processo nenhum. Argv é público na máquina — `ps`, `/proc/*/cmdline`
#   e o histórico do shell mostram para qualquer usuário local. Por isso:
#
#   - não existe `--token`: um argumento que o script não conhece é recusado SEM
#     ser repetido na tela, porque poderia ser a chave colada no lugar errado;
#   - `AGENT_TOKEN` no ambiente é ignorado: a única forma de pô-lo lá através do
#     `sudo` é escrevê-lo na linha de comando;
#   - a chave chega por `AGENT_TOKEN_FILE` (um caminho) ou digitada, com `read -s`
#     lendo de `/dev/tty` — o stdin deste script é o pipe do `curl`, e ler dele
#     consumiria o próprio script;
#   - é escrita no arquivo de ambiente pelo `printf` EMBUTIDO do bash, com
#     redirecionamento: embutido não é processo, e não aparece em `ps`.
#
# REEXECUTAR
#
#   Rodar de novo atualiza o programa do agente (baixado do mesmo painel, na
#   versão do painel) e a unidade do systemd. A chave gravada é mantida se nenhuma
#   nova for informada — o script pergunta "manter a chave atual?".
#
# Tudo roda dentro de `main`, chamada na ÚLTIMA linha: com `curl | bash` o bash
# executa o que já chegou enquanto o resto ainda está a caminho, e um download
# cortado no meio não pode deixar meio instalador rodando como root.
#
set -euo pipefail

# O painel que serve este arquivo troca o valor abaixo pela própria origem
# pública (ver `backend/src/routes/genieacsAgentFiles.js`), e ele vira o padrão
# de PANEL_URL. Vazio quando o painel não sabe o próprio endereço — então o
# script pergunta. Não mude a forma desta linha: o painel procura por ela exata.
DEFAULT_PANEL_URL=''

SERVICE_NAME="skygenpanel-agent"
SERVICE_USER="skygenpanel-agent"
AGENT_DIR="/opt/skygenpanel-agent"
AGENT_FILE="${AGENT_DIR}/skygenpanel-agent.mjs"
ENV_FILE="/etc/skygenpanel-agent.env"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
DEFAULT_GENIEACS_URL="http://127.0.0.1:7557"
# O mesmo piso do painel (`engines` do backend): o agente usa o `WebSocket` e o
# `fetch` globais do Node, e é nesta versão que os dois são testados juntos.
NODE_MAJOR_MIN=22
NODE_MINOR_MIN=22
NODE_RELEASE_LINE=22

# `sgpa_` + 32 bytes aleatórios em base64url, sem preenchimento.
TOKEN_RE='^sgpa_[A-Za-z0-9_-]{43}$'
# Esquema, host (com porta e colchetes de IPv6) e um caminho opcional. Nada de
# `@` (usuário e senha na URL), aspas, espaço ou `?`: o valor vai para um arquivo
# de ambiente lido pelo systemd e para a linha do `curl`, e um conjunto fechado
# de caracteres é o que dispensa pensar em escape nos dois lugares.
URL_RE='^https?://[][A-Za-z0-9.:-]+(/[A-Za-z0-9._~/-]*)?$'

log()  { printf '\033[1;34m[skygp-agent]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[skygp-agent]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[skygp-agent]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Instalador do agente do GenieACS do SkyGenPanel.

  curl -fsSL https://<painel>/api/genieacs-agent/install.sh | sudo bash
  curl -fsSL https://<painel>/api/genieacs-agent/install.sh | sudo bash -s -- --uninstall

Variáveis de ambiente (todas opcionais; o que faltar é perguntado):
  PANEL_URL         endereço do painel, ex.: https://alfa.painel.exemplo.com
  GENIEACS_URL      NBI do GenieACS nesta rede (padrão: http://127.0.0.1:7557)
  AGENT_TOKEN_FILE  caminho de um arquivo com a chave do agente (sgpa_…)

A chave nunca é aceita por argumento nem pela variável AGENT_TOKEN: sem
AGENT_TOKEN_FILE ela é pedida no terminal, sem eco.
EOF
}

# --- terminal ---------------------------------------------------------------
#
# Com `curl | sudo bash` o stdin é o pipe; o terminal de quem digita é
# `/dev/tty`. Existir não basta: sem terminal de controle (cron, CI, `ssh` sem
# `-t`) o arquivo existe e abrir falha. Abrir de verdade é o teste.
tty_available() {
  { : </dev/tty; } 2>/dev/null
}

# ask VAR "pergunta" [padrão] — sem terminal, fica o padrão.
ask() {
  local __var="$1" prompt="$2" default="${3:-}" answer=""
  if tty_available; then
    if [ -n "$default" ]; then
      printf '%s [%s]: ' "$prompt" "$default" >/dev/tty
    else
      printf '%s: ' "$prompt" >/dev/tty
    fi
    IFS= read -r answer </dev/tty || answer=""
  fi
  printf -v "$__var" '%s' "${answer:-$default}"
}

# ask_yes "pergunta" — S é o padrão, e também a resposta sem terminal.
ask_yes() {
  local answer=""
  tty_available || return 0
  printf '%s [S/n]: ' "$1" >/dev/tty
  IFS= read -r answer </dev/tty || answer=""
  # "n", "não", "nao", "no": qualquer coisa que comece com n.
  case "$answer" in
    [nN]*) return 1 ;;
    *) return 0 ;;
  esac
}

# --- pré-requisitos ---------------------------------------------------------
require_root() {
  [ "$EUID" -eq 0 ] \
    || die "É preciso ser root. Rode de novo com: curl -fsSL <painel>/api/genieacs-agent/install.sh | sudo bash"
}

require_systemd() {
  command -v systemctl >/dev/null 2>&1 || die "O agente roda como serviço do systemd, e esta máquina não tem systemctl."
  [ -d /run/systemd/system ] || die "O systemd precisa estar rodando como gerenciador de serviços."
}

install_system_dependencies() {
  local missing=()
  local command_name
  for command_name in curl tar xz sha256sum realpath awk useradd userdel; do
    command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name")
  done
  [ "${#missing[@]}" -gt 0 ] || return 0

  log "Instalando pacotes do sistema (faltam: ${missing[*]})"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends \
      curl ca-certificates xz-utils tar coreutils gawk passwd
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y curl ca-certificates xz tar coreutils gawk shadow-utils
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl ca-certificates xz tar coreutils gawk shadow-utils
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Syu --needed --noconfirm curl ca-certificates xz tar coreutils gawk shadow
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive refresh
    zypper --non-interactive install curl ca-certificates xz tar coreutils gawk shadow
  else
    die "Nenhum gerenciador de pacotes conhecido. Suportados: apt, dnf, yum, pacman, zypper."
  fi

  for command_name in curl tar xz sha256sum realpath awk useradd userdel; do
    command -v "$command_name" >/dev/null 2>&1 \
      || die "Não foi possível instalar o comando necessário: $command_name"
  done
}

# --- Node.js ----------------------------------------------------------------
#
# O mesmo caminho do `deploy/install.sh`: o binário oficial do nodejs.org,
# conferido contra o SHASUMS256, em /usr/local/lib/nodejs com links em
# /usr/local/bin. A diferença é que o agente não precisa de npm — um Node da
# distribuição sem o pacote `npm` serve.
node_archive_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    armv7l) echo "armv7l" ;;
    ppc64le) echo "ppc64le" ;;
    s390x) echo "s390x" ;;
    *) return 1 ;;
  esac
}

node_runtime_ready() {
  local major minor resolved_node
  command -v node >/dev/null 2>&1 || return 1
  resolved_node="$(realpath "$(command -v node)" 2>/dev/null || true)"
  # Um Node do nvm, em /home ou /root, não serve: o serviço roda com
  # `ProtectHome=yes` e com outro usuário, e não enxergaria o binário.
  case "$resolved_node" in
    /home/*|/root/*|'') return 1 ;;
  esac
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  minor="$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || true)"
  [[ "$major" =~ ^[0-9]+$ ]] && [[ "$minor" =~ ^[0-9]+$ ]] \
    && { [ "$major" -gt "$NODE_MAJOR_MIN" ] \
      || { [ "$major" -eq "$NODE_MAJOR_MIN" ] && [ "$minor" -ge "$NODE_MINOR_MIN" ]; }; }
}

install_node_runtime() {
  if node_runtime_ready; then
    log "Usando o Node.js $(node -v) que já está instalado"
    return 0
  fi

  local archive_arch release_url temp_dir archive checksum_file node_home extracted_home archive_version
  archive_arch="$(node_archive_arch)" \
    || die "Arquitetura de CPU sem Node.js oficial: $(uname -m)"
  release_url="https://nodejs.org/dist/latest-v${NODE_RELEASE_LINE}.x"
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/skygenpanel-agent-node.XXXXXXXX")"

  cleanup_node_temp() {
    if [ -n "${temp_dir:-}" ] && [ -d "$temp_dir" ]; then
      rm -rf -- "$temp_dir"
    fi
  }
  trap cleanup_node_temp EXIT

  log "Baixando o Node.js ${NODE_RELEASE_LINE}.x oficial mais recente para linux-${archive_arch}"
  checksum_file="$temp_dir/SHASUMS256.txt"
  curl --proto '=https' --tlsv1.2 --retry 3 --fail --location \
    "$release_url/SHASUMS256.txt" --output "$checksum_file"

  archive="$(awk -v arch="$archive_arch" \
    '$2 ~ ("^node-v[0-9.]+-linux-" arch "\\.tar\\.xz$") { print $2; exit }' \
    "$checksum_file")"
  [ -n "$archive" ] || die "Nenhum pacote oficial do Node.js para linux-${archive_arch}"

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
  [ -x "$extracted_home/bin/node" ] || die "O pacote do Node.js baixado não tem o formato esperado."

  if [ -e "$node_home" ] || [ -L "$node_home" ]; then
    if [ ! -d "$node_home" ] || [ -L "$node_home" ] || [ ! -x "$node_home/bin/node" ]; then
      die "O destino do Node.js já existe e não é um diretório seguro: $node_home"
    fi
    [ "$("$node_home/bin/node" -v)" = "$archive_version" ] \
      || die "O destino do Node.js já existe com outra versão: $node_home"
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
      warn "Preservando o $destination existente como $backup"
      mv -- "$destination" "$backup"
    fi
    ln -sfn "$source_path" "$destination"
  done
  hash -r
  node_runtime_ready || die "O Node.js foi instalado, mas a conferência da versão falhou."

  cleanup_node_temp
  trap - EXIT
  log "Node.js $(node -v) instalado"
}

# --- o que já está gravado --------------------------------------------------
#
# Lido com `read` embutido, linha a linha, e não com `grep`/`cut`: o arquivo tem
# a chave dentro, e nada aqui a põe em argv — nem para procurá-la.
existing_env_value() {
  local wanted="$1" key value
  if [ ! -f "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; then
    return 0
  fi
  while IFS='=' read -r key value || [ -n "$key" ]; do
    if [ "$key" = "$wanted" ]; then
      printf '%s' "$value"
      return 0
    fi
  done <"$ENV_FILE"
}

# --- as três respostas ------------------------------------------------------
resolve_panel_url() {
  local default="${DEFAULT_PANEL_URL:-}"
  [ -n "$default" ] || default="$(existing_env_value PANEL_URL)"

  if [ -n "${PANEL_URL:-}" ]; then
    log "Painel: ${PANEL_URL} (da variável PANEL_URL)"
  else
    ask PANEL_URL "Endereço do painel" "$default"
  fi
  PANEL_URL="${PANEL_URL%/}"
  [ -n "$PANEL_URL" ] \
    || die "Sem o endereço do painel. Rode de novo num terminal, ou com PANEL_URL=https://… no ambiente."
  [[ "$PANEL_URL" =~ $URL_RE ]] \
    || die "Endereço do painel inválido: use http(s)://host[:porta], sem usuário, senha nem parâmetros."
  case "$PANEL_URL" in
    http://localhost|http://localhost:*|http://127.*|http://\[::1\]*) ;;
    http://*)
      warn "O painel está em http://, sem TLS: a chave do agente e as respostas do GenieACS vão"
      warn "abertas pela rede até ele. Use https:// sempre que o painel estiver fora desta rede."
      ;;
  esac
}

resolve_genieacs_url() {
  local default code
  default="$(existing_env_value GENIEACS_URL)"
  default="${default:-$DEFAULT_GENIEACS_URL}"

  if [ -n "${GENIEACS_URL:-}" ]; then
    log "GenieACS: ${GENIEACS_URL} (da variável GENIEACS_URL)"
  else
    ask GENIEACS_URL "Endereço da NBI do GenieACS nesta rede" "$default"
  fi
  GENIEACS_URL="${GENIEACS_URL%/}"
  [[ "$GENIEACS_URL" =~ $URL_RE ]] \
    || die "Endereço do GenieACS inválido: use http(s)://host[:porta], sem usuário, senha nem parâmetros."

  # Aviso, e não recusa: o GenieACS pode estar parado agora e subir depois, e o
  # agente tenta de novo a cada pedido. O que se quer é que o operador saiba
  # HOJE que o endereço não responde, e não pelo primeiro 503 do painel.
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
    "$GENIEACS_URL/devices/?limit=1&projection=_id" 2>/dev/null || true)"
  case "$code" in
    2??) log "O GenieACS respondeu em ${GENIEACS_URL} (HTTP ${code})." ;;
    401|403)
      log "O GenieACS respondeu em ${GENIEACS_URL} e pede credencial (HTTP ${code})."
      log "Tudo certo: a credencial da NBI é a que está cadastrada no painel, e vai em cada pedido."
      ;;
    ''|000)
      warn "O GenieACS não respondeu em ${GENIEACS_URL}. O agente vai ser instalado assim mesmo;"
      warn "confira o endereço e se a NBI (porta 7557, por padrão) está no ar."
      ;;
    *) warn "O GenieACS respondeu HTTP ${code} em ${GENIEACS_URL}; confira se este é o endereço da NBI." ;;
  esac
}

valid_token() {
  [[ "$1" =~ $TOKEN_RE ]]
}

# Preenche AGENT_TOKEN. A variável só existe dentro do bash, e daqui ela só sai
# pelo `printf` embutido de `write_env_file`.
resolve_agent_token() {
  local current_token=""
  AGENT_TOKEN=""

  if [ -n "${AGENT_TOKEN_FILE:-}" ]; then
    if [ ! -f "$AGENT_TOKEN_FILE" ] || [ ! -r "$AGENT_TOKEN_FILE" ]; then
      die "AGENT_TOKEN_FILE não aponta para um arquivo legível: $AGENT_TOKEN_FILE"
    fi
    IFS= read -r AGENT_TOKEN <"$AGENT_TOKEN_FILE" || true
    # Colado de um editor do Windows, ou com espaço sobrando: tudo que não é da
    # chave sai aqui, pela expansão do bash e não por `tr`.
    AGENT_TOKEN="${AGENT_TOKEN//[[:space:]]/}"
    valid_token "$AGENT_TOKEN" \
      || die "O conteúdo de AGENT_TOKEN_FILE não tem o formato de uma chave de agente (sgpa_ + 43 caracteres)."
    log "Chave lida de AGENT_TOKEN_FILE (final …${AGENT_TOKEN: -4})."
    return 0
  fi

  current_token="$(existing_env_value AGENT_TOKEN)"
  if valid_token "$current_token"; then
    if ask_yes "Manter a chave atual (final …${current_token: -4})?"; then
      AGENT_TOKEN="$current_token"
      log "Mantendo a chave atual (final …${AGENT_TOKEN: -4})."
      return 0
    fi
  fi

  tty_available \
    || die "Sem a chave do agente. Gere uma no painel e rode num terminal, ou informe AGENT_TOKEN_FILE=/caminho/do/arquivo."

  local attempt
  for attempt in 1 2 3; do
    printf 'Chave do agente (gerada no painel; não aparece enquanto você digita): ' >/dev/tty
    IFS= read -rs AGENT_TOKEN </dev/tty || AGENT_TOKEN=""
    printf '\n' >/dev/tty
    AGENT_TOKEN="${AGENT_TOKEN//[[:space:]]/}"
    if valid_token "$AGENT_TOKEN"; then
      log "Chave recebida (final …${AGENT_TOKEN: -4})."
      return 0
    fi
    warn "Isso não tem o formato de uma chave de agente (sgpa_ + 43 caracteres). Tentativa ${attempt} de 3."
  done
  die "Nenhuma chave válida informada."
}

# --- instalar ---------------------------------------------------------------
download_agent() {
  local temp_dir redirect_proto
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/skygenpanel-agent.XXXXXXXX")"
  # Um redirecionamento só pode SUBIR para https — nunca descer de https para
  # http, que é como um proxy no meio do caminho trocaria o programa.
  case "$PANEL_URL" in
    https://*) redirect_proto='=https' ;;
    *) redirect_proto='=http,https' ;;
  esac

  log "Baixando o agente de ${PANEL_URL}/api/genieacs-agent/agent.mjs"
  # O nome termina em `.mjs` porque é a extensão que faz o `node --check` ler o
  # arquivo como módulo ES — o mesmo modo em que o serviço vai carregá-lo.
  if ! curl --fail --silent --show-error --location --proto-redir "$redirect_proto" \
      --retry 3 --max-time 60 \
      "$PANEL_URL/api/genieacs-agent/agent.mjs" --output "$temp_dir/skygenpanel-agent.mjs"; then
    rm -rf -- "$temp_dir"
    die "Não foi possível baixar o agente do painel. Confira o endereço e se o painel está no ar."
  fi
  if ! node --check "$temp_dir/skygenpanel-agent.mjs"; then
    rm -rf -- "$temp_dir"
    die "O arquivo baixado não é um programa válido para este Node.js (versão do painel antiga, ou um proxy respondeu no lugar dele)."
  fi

  install -d -o root -g root -m 0755 "$AGENT_DIR"
  install -o root -g root -m 0644 "$temp_dir/skygenpanel-agent.mjs" "$AGENT_FILE"
  rm -rf -- "$temp_dir"
}

create_service_user() {
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    return 0
  fi
  log "Criando o usuário de sistema '${SERVICE_USER}' (sem shell e sem home)"
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
    || useradd --system --no-create-home --home-dir /nonexistent --shell /bin/false "$SERVICE_USER"
}

# O arquivo é de root e 0600: quem o lê é o systemd, ainda como root, antes de
# trocar para o usuário do serviço — o agente recebe as variáveis prontas e não
# precisa (nem consegue) abrir o arquivo. `umask 077` antes de criar, e não
# `chmod` depois: entre criar e mudar a permissão haveria um instante em que a
# chave estaria num arquivo legível por todos.
write_env_file() {
  local old_umask temp_env
  [ ! -L "$ENV_FILE" ] || die "Recusando arquivo de ambiente que é link simbólico: $ENV_FILE"
  old_umask="$(umask)"
  umask 077
  temp_env="$(mktemp "$(dirname "$ENV_FILE")/.skygenpanel-agent.env.XXXXXXXX")"
  {
    printf '# Agente do GenieACS do SkyGenPanel. Gerado por install-agent.sh.\n'
    printf '# Lido pelo systemd como root; nenhum outro usuário precisa abrir este arquivo.\n'
    printf 'PANEL_URL=%s\n' "$PANEL_URL"
    printf 'AGENT_TOKEN=%s\n' "$AGENT_TOKEN"
    printf 'GENIEACS_URL=%s\n' "$GENIEACS_URL"
  } >"$temp_env"
  chown root:root "$temp_env"
  chmod 0600 "$temp_env"
  mv -f -- "$temp_env" "$ENV_FILE"
  umask "$old_umask"
}

write_unit_file() {
  local node_bin
  node_bin="$(command -v node)"
  cat >"$UNIT_FILE" <<EOF
[Unit]
Description=Agente do GenieACS do SkyGenPanel (conexão de saída para o painel)
Wants=network-online.target
After=network-online.target
# O agente precisa ficar de pé para sempre: sem limite de partidas, o systemd
# nunca desiste dele depois de uma queda longa da rede ou do painel.
StartLimitIntervalSec=0

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
# Lido pelo systemd como root, antes de trocar de usuário — por isso o arquivo
# pode (e deve) ser 0600 de root.
EnvironmentFile=${ENV_FILE}
ExecStart=${node_bin} ${AGENT_FILE}
Restart=always
RestartSec=5

# Endurecimento. O agente só lê o próprio arquivo e abre conexões TCP de saída
# (o painel e o GenieACS); tudo o mais é tirado dele.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
# IPv4 e IPv6 para o painel e o GenieACS, e o socket Unix só pela resolução de
# nomes: em distribuições com o nss-resolve do systemd-resolved (Fedora, por
# exemplo) o getaddrinfo fala com o resolvedor por socket Unix, e sem ele o
# agente não acharia o painel pelo nome — falha que só apareceria na máquina
# do provedor, sem nenhuma pista no log além de "painel inalcançável".
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
# \`no\` de propósito: o V8 compila JavaScript para código de máquina em tempo de
# execução (JIT), e isso exige memória que é escrita e depois executada. Com
# \`yes\` o Node morre na partida.
MemoryDenyWriteExecute=no
CapabilityBoundingSet=
SystemCallArchitectures=native
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$UNIT_FILE"
}

start_service() {
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 \
    || die "Não foi possível habilitar o serviço ${SERVICE_NAME}."
  # `restart`, e não `start`: numa reexecução o serviço já está de pé com o
  # programa e a chave antigos.
  systemctl restart "$SERVICE_NAME"

  local ready=false
  for _ in 1 2 3 4 5; do
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      ready=true
      break
    fi
    sleep 1
  done

  systemctl --no-pager --lines=5 status "$SERVICE_NAME" || true
  printf '\n'
  if [ "$ready" = true ]; then
    log "Agente instalado e rodando."
    log "Confira no painel (Configurações → GenieACS) se ele aparece como conectado."
  else
    warn "O serviço não ficou de pé. Veja o motivo com: journalctl -u ${SERVICE_NAME} -n 50"
  fi
  log "Log ao vivo:        journalctl -u ${SERVICE_NAME} -f"
  log "Trocar a chave:     gere outra no painel e rode este instalador de novo"
  log "Desinstalar:        curl -fsSL ${PANEL_URL}/api/genieacs-agent/install.sh | sudo bash -s -- --uninstall"
}

install_agent() {
  require_root
  require_systemd
  install_system_dependencies
  install_node_runtime

  resolve_panel_url
  resolve_agent_token
  resolve_genieacs_url

  download_agent
  create_service_user
  write_env_file
  log "Configuração gravada em ${ENV_FILE} (root, 0600)"
  write_unit_file
  log "Unidade gravada em ${UNIT_FILE}"
  start_service
}

# --- desinstalar ------------------------------------------------------------
uninstall_agent() {
  require_root
  require_systemd
  log "Removendo o agente do GenieACS"
  systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f -- "$UNIT_FILE"
  systemctl daemon-reload
  systemctl reset-failed "$SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f -- "$ENV_FILE"
  # Caminho fixo deste script, conferido antes do `rm -rf` mesmo assim: é o tipo
  # de linha que um dia alguém transforma em variável de ambiente.
  case "$AGENT_DIR" in
    /opt/skygenpanel-agent|*/skygenpanel-agent) rm -rf -- "$AGENT_DIR" ;;
    *) die "Recusando remover um diretório inesperado: $AGENT_DIR" ;;
  esac
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    userdel "$SERVICE_USER" >/dev/null 2>&1 || warn "Não foi possível remover o usuário ${SERVICE_USER}."
  fi
  log "Agente removido. O Node.js fica instalado: outros programas podem usá-lo."
  log "No painel, gere outra chave (ou troque o modo do provedor) para invalidar a que estava aqui."
}

main() {
  # Nunca da variável de ambiente, nem para um aviso com o valor: através do
  # `sudo`, a única forma de ela chegar aqui é ter sido digitada na linha de
  # comando, que é exatamente onde a chave não pode estar.
  if [ -n "${AGENT_TOKEN:-}" ]; then
    warn "A variável AGENT_TOKEN foi ignorada: a chave não entra pela linha de comando."
    warn "Use AGENT_TOKEN_FILE=/caminho/do/arquivo, ou digite quando for pedida."
  fi
  unset AGENT_TOKEN

  local action=install
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --uninstall) action=uninstall ;;
      -h|--help) usage; return 0 ;;
      # O argumento NÃO é repetido: pode ser a chave, colada no lugar errado.
      *) die "Opção desconhecida (não repetida aqui, porque poderia ser a chave). Use --help." ;;
    esac
    shift
  done

  case "$action" in
    install) install_agent ;;
    uninstall) uninstall_agent ;;
  esac
}

# Para os testes carregarem as funções sem instalar nada.
if [ "${SKYGP_AGENT_SOURCE_ONLY:-}" != 1 ]; then
  main "$@"
fi
