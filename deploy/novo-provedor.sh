#!/usr/bin/env bash
#
# O endereço de um provedor novo, em um comando.
#
#   sudo ./deploy/novo-provedor.sh inove
#
# Criar o provedor no console cria a linha no banco. O endereço dele —
# `inove.painel.exemplo.com` — não existe até alguém apontar o DNS, emitir o
# certificado e montar o bloco no nginx. Este script faz os dois últimos, que
# são os que moram no servidor e são sempre iguais.
#
# QUANDO ELE É NECESSÁRIO
#
#   Só onde NÃO há certificado curinga. Curinga se emite por desafio DNS, que
#   precisa de API no provedor de DNS para renovar sozinho a cada 60 dias; onde
#   essa API não existe (Registro.br, por exemplo), um curinga renovado à mão é
#   um deploy que derruba TODOS os provedores juntos no dia em que alguém
#   esquecer. A saída é um certificado por provedor, por HTTP-01, que renova
#   sozinho — e é o que este script emite.
#
#   Onde há curinga de certificado, `nginx-saas.conf.example` já atende todos os
#   provedores num bloco só e este script não tem função.
#
# O QUE CONTINUA SENDO SEU
#
#   O DNS. Antes de rodar, `<slug>.<base>` precisa resolver para este servidor —
#   por um curinga `*.painel` (grátis, cadastrado uma vez) ou por um registro
#   por provedor. O script confere isso ANTES de chamar o certbot, porque uma
#   emissão contra um nome que não resolve queima uma das cinco tentativas por
#   hora que o Let's Encrypt concede, e a mensagem de erro não diz que o
#   problema era o DNS.
#
set -euo pipefail

readonly PROGRAMA="${0##*/}"
readonly AQUI="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly MODELO="$AQUI/proxy/nginx-tenant.conf.template"

BASE=""
ENV_FILE=""
WEBROOT="/var/www/certbot"

# Os dois arranjos de instalação guardam as variáveis em lugares diferentes, e
# quem roda este script não tem por que saber em qual está: o compose lê
# `deploy/saas.env`, e o CLI (`skygenpanel`, /opt/skygenpanel) lê
# `backend/.env`. Procurados nesta ordem, e `--env-file` vence os dois.
readonly ENV_CANDIDATOS=("$AQUI/saas.env" "$(realpath -m -- "$AQUI/../backend/.env")")
EMAIL=""
ENSAIO=0
SLUG=""

erro()  { printf '%s: %s\n' "$PROGRAMA" "$*" >&2; }
passo() { printf '\n==> %s\n' "$*"; }

ajuda() {
  cat <<AJUDA
Uso: sudo $PROGRAMA <slug> [opções]

Emite o certificado de <slug>.<base> e instala o bloco do nginx que o serve.

Opções:
  --base <domínio>    Domínio-base. Padrão: TENANT_BASE_DOMAIN do arquivo de ambiente.
  --env-file <path>   De onde ler TENANT_BASE_DOMAIN. Padrão: o primeiro que existir
                      entre ${ENV_CANDIDATOS[0]} e ${ENV_CANDIDATOS[1]}
  --webroot <path>    Raiz do desafio ACME. Padrão: $WEBROOT
  --email <endereço>  E-mail da conta do Let's Encrypt, no primeiro uso.
  --dry-run           Ensaia contra o staging do Let's Encrypt e NÃO instala nada.
  -h, --help          Isto.

Exemplo:
  sudo $PROGRAMA inove
  sudo $PROGRAMA inove --dry-run
AJUDA
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) ajuda; exit 0 ;;
    --base)     BASE="${2-}";     shift 2 || { erro "--base exige um domínio"; exit 1; } ;;
    --env-file) ENV_FILE="${2-}"; shift 2 || { erro "--env-file exige um caminho"; exit 1; } ;;
    --webroot)  WEBROOT="${2-}";  shift 2 || { erro "--webroot exige um caminho"; exit 1; } ;;
    --email)    EMAIL="${2-}";    shift 2 || { erro "--email exige um endereço"; exit 1; } ;;
    --dry-run)  ENSAIO=1; shift ;;
    -*) erro "opção desconhecida: $1"; ajuda >&2; exit 1 ;;
    *)
      [ -z "$SLUG" ] || { erro "informe um slug por vez"; exit 1; }
      SLUG="$1"; shift ;;
  esac
done

[ -n "$SLUG" ] || { erro "falta o slug do provedor"; ajuda >&2; exit 1; }

# --- O slug é o subdomínio, então a regra é a do DNS ------------------------
#
# Mesma regra de `backend/src/utils/slug.js`, e as duas têm que continuar
# iguais: um slug que o console aceita e este script recusa é um provedor
# criado sem endereço.
readonly SLUG_MIN=3
readonly SLUG_MAX=63
readonly RESERVADOS=" www api app admin portal mail static assets cdn status plataforma platform "

problema_no_slug() {
  local s="$1"
  if [ "${#s}" -lt "$SLUG_MIN" ] || [ "${#s}" -gt "$SLUG_MAX" ]; then
    printf 'o slug tem de ter entre %s e %s caracteres' "$SLUG_MIN" "$SLUG_MAX"; return
  fi
  if ! printf '%s' "$s" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'; then
    printf 'o slug aceita só minúsculas, dígitos e hífen, começando e terminando em letra ou dígito'; return
  fi
  # `xn--` é punycode; a RFC 5891 reserva todo par de hífens na 3ª e 4ª posição.
  if [ "${s:2:2}" = "--" ]; then
    printf 'o slug não pode ter hífen na 3ª e na 4ª posição ao mesmo tempo'; return
  fi
  case "$RESERVADOS" in *" $s "*) printf 'esse nome é reservado pelo deploy'; return ;; esac
}

if problema="$(problema_no_slug "$SLUG")" && [ -n "$problema" ]; then
  erro "slug inválido ($SLUG): $problema"
  exit 1
fi

# --- O domínio-base vem do deploy, não de dentro do script ------------------
if [ -z "$BASE" ]; then
  if [ -z "$ENV_FILE" ]; then
    for candidato in "${ENV_CANDIDATOS[@]}"; do
      [ -f "$candidato" ] && { ENV_FILE="$candidato"; break; }
    done
  fi
  if [ -z "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
    erro "não achei o arquivo de ambiente. Procurei em:"
    for candidato in "${ENV_CANDIDATOS[@]}"; do erro "    $candidato"; done
    erro "Use --base <domínio> ou --env-file <path>."
    exit 1
  fi
  BASE="$(grep -E '^[[:space:]]*TENANT_BASE_DOMAIN[[:space:]]*=' "$ENV_FILE" \
          | tail -1 | cut -d= -f2- | tr -d '"'"'"' \t\r')"
fi
BASE="$(printf '%s' "$BASE" | tr 'A-Z' 'a-z' | sed -e 's/^\.*//' -e 's/\.*$//')"

if [ -z "$BASE" ]; then
  erro "TENANT_BASE_DOMAIN está vazio em $ENV_FILE — sem domínio-base não há endereço de provedor"
  exit 1
fi

readonly HOST="$SLUG.$BASE"
readonly CONF="/etc/nginx/sites-available/skygenpanel-$SLUG.conf"
readonly LINK="/etc/nginx/sites-enabled/skygenpanel-$SLUG.conf"
readonly VIVO="/etc/letsencrypt/live/$HOST"

printf 'Provedor: %s\nEndereço: https://%s\n' "$SLUG" "$HOST"

# --- Pré-requisitos, todos antes de mexer em qualquer coisa -----------------
[ "$(id -u)" -eq 0 ] || { erro "rode com sudo: o certbot e o nginx pedem root"; exit 1; }
[ -f "$MODELO" ]     || { erro "modelo não encontrado: $MODELO"; exit 1; }
command -v certbot >/dev/null || { erro "certbot não instalado (apt install certbot)"; exit 1; }
command -v nginx   >/dev/null || { erro "nginx não instalado (apt install nginx)"; exit 1; }
[ -d /etc/nginx/sites-available ] && [ -d /etc/nginx/sites-enabled ] || {
  erro "este nginx não usa sites-available/sites-enabled; instale o bloco à mão a partir de $MODELO"
  exit 1
}

# --- Já está pronto? Rodar de novo não pode custar uma emissão --------------
if [ -d "$VIVO" ] && [ -f "$CONF" ] && [ -L "$LINK" ] && [ "$ENSAIO" -eq 0 ]; then
  passo "$HOST já tem certificado e bloco instalados — nada a fazer"
  nginx -t
  exit 0
fi

# --- O DNS é a falha mais comum e a mais cara -------------------------------
#
# O nome novo tem de resolver para o mesmo IP que o domínio-base, que já aponta
# para este servidor. Comparar com a base em vez de com um serviço externo
# funciona atrás de NAT e sem rede de saída.
ips_de() {
  if command -v getent >/dev/null; then
    getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u
  else
    host -t A "$1" 2>/dev/null | awk '/has address/ {print $NF}' | sort -u
  fi
}

passo "Conferindo o DNS de $HOST"
ips_host="$(ips_de "$HOST" || true)"
if [ -z "$ips_host" ]; then
  erro "$HOST não resolve."
  erro "Cadastre no seu DNS, apontando para o IP deste servidor:"
  erro "    *.${BASE%%.*}   A   <IP>     (curinga: vale para todos os provedores)"
  erro "  ou"
  erro "    $SLUG.${BASE%%.*}   A   <IP>  (um registro para este provedor)"
  exit 1
fi

ips_base="$(ips_de "$BASE" || true)"
if [ -n "$ips_base" ] && [ -z "$(comm -12 <(printf '%s\n' "$ips_host") <(printf '%s\n' "$ips_base"))" ]; then
  erro "$HOST resolve para [$(printf '%s ' $ips_host)] e $BASE para [$(printf '%s ' $ips_base)]."
  erro "São servidores diferentes — o certificado sairia para o lugar errado."
  exit 1
fi
printf '    %s -> %s\n' "$HOST" "$(printf '%s ' $ips_host)"

# --- O impasse do primeiro certificado --------------------------------------
#
# O certificado precisa da porta 80 respondendo PELO NOME, e o bloco que
# responde pelo nome referencia um certificado que ainda não existe. A saída é
# instalar em duas etapas: primeiro um bloco `:80` sozinho — que passa no
# `nginx -t` porque não tem nenhuma diretiva `ssl_*` —, depois a emissão, e só
# então o bloco completo por cima.
#
# Assim o script não exige preparo nenhum do nginx: nem bloco curinga na 80, nem
# webroot já servido, nem o plugin `python3-certbot-nginx`. É o que separa
# "funciona na configuração de exemplo" de "funciona no servidor que existe".

bloco_http() {
  cat <<BLOCO
# Etapa 1 de $PROGRAMA: o bloco que serve o desafio do ACME para $HOST.
# Substituído pelo bloco completo assim que o certificado sai.
server {
    listen 80;
    listen [::]:80;
    server_name $HOST;

    location /.well-known/acme-challenge/ {
        root $WEBROOT;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
BLOCO
}

# `nginx -t` vermelho é sempre a mesma resposta, nas duas etapas: o link sai de
# `sites-enabled` ANTES de qualquer reload, porque um `sites-enabled` quebrado
# derruba todos os provedores, não só o que entrou.
recarrega_ou_desfaz() {
  if ! nginx -t; then
    rm -f "$LINK"
    erro "nginx -t falhou ($1); o bloco de $HOST foi desativado e nada foi recarregado."
    erro "O arquivo ficou em $CONF para inspeção."
    exit 1
  fi
  systemctl reload nginx
}

# --- Ensaio: as duas etapas, sem tocar em nada ------------------------------
if [ "$ENSAIO" -eq 1 ]; then
  passo "Ensaio, etapa 1: o bloco HTTP que entraria em $CONF antes da emissão"
  bloco_http
fi

# --- Certificado ------------------------------------------------------------
mkdir -p "$WEBROOT"

certbot_args=(certonly --webroot -w "$WEBROOT" -d "$HOST" --non-interactive --agree-tos)
if [ -n "$EMAIL" ]; then
  certbot_args+=(-m "$EMAIL")
fi
if [ "$ENSAIO" -eq 1 ]; then
  certbot_args+=(--dry-run)
else
  certbot_args+=(--deploy-hook 'systemctl reload nginx')
fi

if [ -d "$VIVO" ] && [ "$ENSAIO" -eq 0 ]; then
  passo "Certificado de $HOST já existe — pulando a emissão"
else
  if [ "$ENSAIO" -eq 0 ]; then
    passo "Instalando o bloco HTTP de $HOST, para o desafio do ACME chegar"
    bloco_http > "$CONF"
    ln -sfn "$CONF" "$LINK"
    recarrega_ou_desfaz "etapa HTTP"
  fi

  passo "Emitindo o certificado de $HOST"
  if ! certbot "${certbot_args[@]}"; then
    if [ "$ENSAIO" -eq 0 ]; then
      # Um bloco que redireciona para um HTTPS sem certificado é pior do que
      # nome nenhum: responde e quebra, em vez de não existir.
      rm -f "$LINK"
      nginx -t && systemctl reload nginx || true
      erro "o bloco HTTP de $HOST foi removido; o nginx voltou ao estado anterior."
    fi
    erro "o certbot falhou. As causas comuns:"
    erro "  - a porta 80 não chega neste servidor (Security List/NSG da VCN, ou iptables local);"
    erro "  - o DNS de $HOST aponta para outro lugar;"
    erro "  - o limite do Let's Encrypt (5 falhas por hora) já foi atingido."
    exit 1
  fi
fi

# --- Bloco completo ---------------------------------------------------------
if [ "$ENSAIO" -eq 1 ]; then
  passo "Ensaio, etapa 2: o bloco completo que SERIA instalado em $CONF"
  sed "s/__HOST__/$HOST/g" "$MODELO"
  printf '\nEnsaio concluído. Nada foi instalado.\n'
  exit 0
fi

passo "Instalando $CONF"
sed "s/__HOST__/$HOST/g" "$MODELO" > "$CONF"
ln -sfn "$CONF" "$LINK"
recarrega_ou_desfaz "bloco completo"

cat <<FIM

Pronto. https://$HOST responde.

Falta criar o provedor "$SLUG" no console (https://$BASE/platform) se ele ainda
não existe — este script cuidou do endereço, não do cadastro.
FIM
