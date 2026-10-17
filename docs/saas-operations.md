# Operar a edição SaaS

Como subir, observar, guardar e desfazer um deploy do TR69 Controle que serve vários
provedores. É o documento da Fase 7 do `saas-multi-tenant-plan.md`, escrito para quem
está de plantão e não para quem desenhou o sistema: cada seção diz o que fazer e onde
olhar, e o *porquê* fica em uma linha quando importa para não fazer errado.

As duas edições rodam **o mesmo código**. Tudo que muda entre elas vem de `EDITION`:

| `EDITION=selfhosted` (padrão) | `EDITION=saas` |
| --- | --- |
| Um provedor, resolvido sem olhar o `Host` | Provedor pelo subdomínio; host que não nomeia ninguém é 404 |
| `Configuração → Banco` troca o banco pela tela | A rota não é montada; o banco vem de `DATABASE_URL` |
| ACS em endereço privado permitido | Egresso do ACS recusa faixas privadas e portas fora da lista |
| Sem plano de controle | `/api/platform/*`, cadastro, assinatura, limites de plano |
| `deploy/install.sh` + CLI `skygenpanel` + SQLite/MySQL | `Dockerfile` + Postgres gerenciado + migrations no boot |

## 1. Subir

### Variáveis

Todas estão em `deploy/saas.env.example`, com comentário. As que não podem faltar:

- `EDITION=saas`.
- `TENANT_BASE_DOMAIN` e `PORTAL_BASE_DOMAIN`: `alfa.painel.exemplo.com` é o painel do
  provedor `alfa`; `alfa.portal.exemplo.com` é o portal do assinante dele. Ligar só o
  do painel é legítimo — sem `PORTAL_BASE_DOMAIN` a 5891 apenas deixa de ter endereço,
  e o painel não é afetado. O console mostra as duas em **Saúde do deploy**, e um
  travessão ali é estado, não falha.
- `DATABASE_URL`: `postgres://user:pass@host:5432/db?schema=painel&sslmode=require`.
  Vence o `db-config.json` quando os dois existem, para uma imagem nunca ser apontada
  para o banco errado por um volume velho. `schema` é o `search_path`, que é como um
  Postgres gerenciado guarda mais de um painel; `sslmode=no-verify` mantém TLS e tira a
  verificação de cadeia.
- `JWT_SECRET`, `PORTAL_JWT_SECRET`, `SECRET_BOX_KEY`: três valores **diferentes**, de
  `openssl rand -hex 48`. O boot recusa segredo fraco em `APP_ENV=production` (que é o
  padrão da imagem). `SECRET_BOX_KEY` cifra a credencial NBI e a senha de portal; trocá-la
  torna esses dados ilegíveis — ver §6.
- `TRUST_PROXY=1`: o proxy na frente é o único salto confiável. É o que dá a cada
  provedor o seu balde de rate limit e marca os cookies do portal como `Secure`.
- `METRICS_TOKEN` (opcional, ≥ 32 caracteres): quem coleta `/api/platform/metrics`.
- `SMTP_URL` e `MAIL_FROM` (opcionais): por onde sai o convite de equipe. Sem as duas não
  há envio, e o link continua saindo na tela — ver §8.

### DNS e proxy

Três registros, dois deles curinga:

```
painel.exemplo.com       A/AAAA  → proxy
*.painel.exemplo.com     CNAME   → painel.exemplo.com
*.portal.exemplo.com     CNAME   → painel.exemplo.com
```

O proxy termina TLS e encaminha **preservando o `Host`**: `*.painel…` e `painel…` para
a porta 5890, `*.portal…` para a 5891. É o `Host` que diz ao painel qual provedor está
falando; um proxy que o reescreve entrega todo mundo no mesmo lugar, e o resolvedor
responde 404 para todos.

`deploy/proxy/nginx-saas.conf.example` é esse proxy pronto para nginx — os quatro
blocos, o `default_server` que recusa host desconhecido, e as armadilhas anotadas onde
elas mordem (o curinga não cobre o apex; `http2 on;` não existe antes do nginx 1.25.1;
as linhas `listen [::]` exigem IPv6). Cada bloco do painel tem também o `location =
/api/genieacs-agent/connect` que deixa passar o WebSocket do agente do GenieACS — ver a
seção 12 antes de reaproveitar um proxy antigo. E tem os dois `location` do envio de
firmware (`/api/devices/firmware/files` e o reenvio do console,
`/api/platform/tenants/<id>/genieacs/firmware/reassign`), com `client_max_body_size 64m`
e `proxy_read_timeout 180s`: o resto do painel fica em 2 MB. Se mudar `FIRMWARE_MAX_MB`
no painel, mude o teto desses dois blocos junto. Provedor em modo agente precisa do
agente 1.1.0 ou mais novo para enviar firmware (o painel recusa com `acs_agent_outdated`),
e por esse caminho o arquivo vai até 48 MB.

#### O certificado: um curinga, ou um por provedor

Quem decide é o **DNS**, não o gosto: um certificado curinga só sai por desafio DNS-01,
que precisa de API no provedor de DNS para renovar sozinho a cada 60 dias.

| | Com API no DNS (Cloudflare, Route 53, …) | Sem API no DNS (Registro.br e afins) |
| --- | --- | --- |
| Certificado | um curinga por base | um por provedor, por HTTP-01 |
| Emissão | `certbot certonly --dns-<provedor> -d painel… -d '*.painel…'` | `deploy/novo-provedor.sh <slug>` |
| Blocos do nginx | os de `nginx-saas.conf.example` atendem todos | mais um bloco por provedor |
| Provedor novo | nada a fazer | um comando no servidor |

Não emita um curinga que você vá renovar à mão: a renovação esquecida derruba **todos os
provedores ao mesmo tempo**, e o dia em que isso acontece é o dia em que ninguém lembra
que existia um prazo. Um certificado por provedor renova sozinho pelo `certbot.timer` e
falha, no pior caso, um provedor de cada vez.

**Sem API no DNS**, o arranjo fica assim. Um registro curinga só de DNS (grátis em
qualquer provedor, cadastrado uma vez):

```
painel.exemplo.com       A  → servidor
*.painel.exemplo.com     A  → servidor
```

E, para cada provedor novo, um comando:

```bash
sudo ./deploy/novo-provedor.sh inove
```

Ele lê `TENANT_BASE_DOMAIN` do arquivo de ambiente do deploy — `deploy/saas.env` no
compose, `backend/.env` na instalação pelo CLI `skygenpanel`, procurados nessa ordem e
sobrepostos por `--env-file` — confere que `inove.painel.exemplo.com`
resolve para o mesmo IP da base **antes** de chamar o certbot (uma emissão contra um nome
que não resolve queima uma das cinco tentativas por hora que o Let's Encrypt concede, e o
erro dele não diz que o problema era o DNS), emite, renderiza
`deploy/proxy/nginx-tenant.conf.template` em `sites-available`, testa e recarrega. Se o
`nginx -t` falhar, ele **desativa o bloco novo antes de qualquer reload** — um
`sites-enabled` quebrado derruba todos os provedores, não só o que entrou. Rodar duas
vezes com o mesmo slug não custa uma emissão, e `--dry-run` ensaia contra o *staging*.

Ele **não exige preparo nenhum do nginx** — nem bloco curinga na porta 80, nem webroot já
servido, nem o plugin `python3-certbot-nginx`. O impasse é circular (o certificado precisa
da porta 80 respondendo pelo nome; o bloco que responde pelo nome referencia o certificado
que ainda não existe), e o script o quebra instalando primeiro um bloco `:80` sozinho — que
passa no `nginx -t` por não ter diretiva `ssl_*` —, emitindo, e só então pondo o bloco
completo por cima. Se a emissão falhar, esse bloco HTTP é removido e o nginx volta ao estado
anterior: um nome que redireciona para um HTTPS sem certificado é pior do que nome nenhum.

O script cuida do endereço; **criar o provedor continua sendo pelo console**.

#### Se o servidor é uma instância Oracle Cloud

Dois lugares fecham a porta 80/443, e é preciso abrir os dois: a **Security List** (ou o
NSG) da VCN e o **iptables local** — as imagens Ubuntu e Oracle Linux da Oracle já vêm
com regras de INPUT que recusam tudo menos SSH. Security List aberta e `curl` de fora
dando timeout é sempre o segundo.

O apex `painel.exemplo.com` (e `www.`) é **o endereço da plataforma**, e é onde o
console vive. Ele não pertence a provedor nenhum, e serve exatamente isto:

| Caminho | Para quê |
|---|---|
| `GET /api/tenant/public` | dizer que aqui é a plataforma, e onde os provedores vivem |
| `POST /api/auth/signup` | o ISP que ainda não existe se cadastrar |
| `/api/platform/*` | o console: provedores, planos, assinaturas, cadastro do console |
| `/api/auth/login`, `/user`, `/logout`, `/refresh`, `/change-password`, `/setup-status` | a sessão do console |

**Nada de nenhum provedor é servido nesse host** — `/api/devices`, `/api/settings`,
`/api/users`, a redefinição de senha e o resgate de personificação respondem 404 ali, e
um token de provedor que chegue no apex é recusado com `tenant_mismatch`. O contrário
também vale: onde há domínio-base, `/api/platform/*` **não existe** no host de um
provedor, por construção. O apex do portal não serve nada.

### Compose

```bash
cp deploy/saas.env.example deploy/saas.env   # preencher
docker compose -f deploy/docker-compose.saas.yml up -d --build
docker compose -f deploy/docker-compose.saas.yml logs -f panel
```

O compose traz um Postgres ao lado para homologação. Em produção o banco é gerenciado:
apague o serviço `db`, aponte `DATABASE_URL` para fora e o resto fica igual. As
**migrations rodam no boot** (`ensureSchema`), são idempotentes e ficam registradas em
`schema_migrations`; um deploy é `up -d --build` e nada mais. Se uma migration falhar o
processo não sobe, o `HEALTHCHECK` da imagem fica vermelho e o orquestrador não troca a
versão antiga — que é o comportamento desejado.

O CI constrói a imagem e a sobe até `/api/health` responder (job `image`), então um
`Dockerfile` quebrado não chega à `main`.

### Primeiro acesso

A primeira conta da plataforma nasce **no servidor**, e não por uma tela:

```bash
PLATFORM_ADMIN_PASSWORD='...' \
  node backend/scripts/grant-platform-admin.js quem-opera \
    --create --email quem-opera@exemplo.com
```

Ela não tem vínculo com provedor nenhum — que é o ponto: quem opera a plataforma não
trabalha em nenhum ISP. Entre em `https://painel.exemplo.com` com ela e crie o primeiro
provedor pelo console. Daí em diante, quem já está no cadastro concede a outros pela aba
**Acesso à plataforma** — ninguém ganha o plano de controle sozinho, e a concessão fica
na trilha com quem deu a quem.

Duas consequências de a conta não ter provedor, e as duas são desejadas: ela **não entra
em `slug.painel.exemplo.com`** (o login de lá recusa quem não tem vínculo) e a senha
dela se recupera com `skygenpanel reset-password <usuário>` (ou
`RESET_PASSWORD=... node backend/scripts/reset-password.js <usuário>` — a senha vem da
variável ou da entrada padrão, nunca de argumento), porque o endereço da
plataforma não serve a redefinição por e-mail — aquela grava na trilha de um provedor.

É script e não rota de propósito: quem pode rodá-lo é quem tem o servidor, que é
exatamente quem deveria decidir quem cunha provedores. Uma tela de criação no apex seria
pública, criando a conta de maior privilégio do deploy, trancada só por "ainda não
existe ninguém" — e num SaaS onde ISPs se cadastram sozinhos esse contador não fica em
zero.

**O provedor `default`** que a migração cria num banco novo é um provedor comum: pode
ser renomeado, suspenso e apagado pelo console como qualquer outro. Onde há domínio-base
ele pode inclusive ser o último a sair — um SaaS sem clientes é um estado coerente, e o
console continua de pé porque não pertence a provedor nenhum.

**Num install que começou self-hosted e virou SaaS**, `platform_admins` está vazia e
nenhuma migração promove ninguém — de propósito: um upgrade não pode transformar o
administrador local de um ISP em operador da plataforma. Aí a conta já existe e só falta
a chave:

```bash
node backend/scripts/grant-platform-admin.js quem-opera
```

Nesse caso a conta continua sendo membro do ISP dela, o que é legítimo: a mesma pessoa
opera a plataforma e trabalha no provedor. A diferença entre os dois modos é essa.

### As três sessões

Três audiências de token, e cada uma vale num lugar só. Confundi-las é o erro que este
desenho existe para tornar impossível:

| Sessão | Audiência | Nomeia provedor? | Papel | Onde vale |
|---|---|---|---|---|
| Painel | `skygenpanel-admin` | sim | o do vínculo | `slug.painel…` daquele provedor |
| Console | `skygenpanel-console` | **não** | nenhum | só o apex |
| Personificação | `skygenpanel-platform` | sim | `viewer` imposto | só o host do provedor personificado |

A do console roda **sem escopo de provedor**: qualquer leitura escopada que escape para
ela estoura alto em vez de servir o provedor errado. A de personificação é só leitura,
barrada por método acima de toda rota, e não alcança o console de volta.

### Ligar os subdomínios num deploy que já está no ar

A seção acima descreve um deploy novo. Um que **já serve um host só** — o painel
respondendo em `painel.exemplo.com` sem subdomínio nenhum — chega aqui por outro
caminho, e três coisas mudam debaixo dele ao mesmo tempo. Vale ler antes de mexer.

**O que a mudança faz, e ninguém avisa depois:**

1. **Ligar uma das duas variáveis liga a resolução por host para TUDO**, inclusive o
   portal do assinante na 5891 (`usesTenantSubdomains`). Sem `PORTAL_BASE_DOMAIN` e sem
   o DNS dele, **o portal sai do ar**. Os dois entram na mesma janela, ou nenhum.
2. **O apex e os painéis se separam.** O console CONTINUA no apex — é lá que ele passa
   a morar exclusivamente —, mas o apex deixa de servir o painel do provedor que dividia
   aquele endereço com ele. Quem opera a plataforma e também trabalha num ISP passa a
   usar dois endereços: `painel.exemplo.com/platform` para o console e
   `<slug>.painel.exemplo.com` para o painel daquele provedor. `/api/platform/*` vira
   404 no host de provedor, e os dados de provedor viram 404 no apex.
3. **A sessão passa a valer só no host onde nasceu.** Um token cunhado em
   `alfa.painel…` apresentado em `beta.painel…` é 403 `tenant_mismatch`. É o
   comportamento desejado, e é novo para quem vinha de um host só: cada aba aberta antes
   da mudança entra de novo no endereço que passou a ser o dela.

**A ordem:**

```bash
# 1. DNS — quatro registros, dois curinga. Confira a propagação antes de seguir:
#    dig +short qualquer-coisa.painel.exemplo.com
#
#    painel.exemplo.com      A     → IP do proxy
#    *.painel.exemplo.com    CNAME → painel.exemplo.com
#    portal.exemplo.com      A     → IP do proxy
#    *.portal.exemplo.com    CNAME → painel.exemplo.com

# 2. Certificados. Curinga só sai por desafio DNS, e o apex tem que estar no MESMO
#    certificado: `*.painel.exemplo.com` não casa com `painel.exemplo.com`.
certbot certonly --dns-<provedor> --dns-<provedor>-credentials /etc/letsencrypt/dns.ini \
  -d painel.exemplo.com -d '*.painel.exemplo.com' -d www.painel.exemplo.com
certbot certonly --dns-<provedor> --dns-<provedor>-credentials /etc/letsencrypt/dns.ini \
  -d portal.exemplo.com -d '*.portal.exemplo.com'
certbot renew --dry-run

# 3. Proxy.
sed -e 's/painel\.exemplo\.com/painel.SEUDOMINIO/g' \
    -e 's/portal\.exemplo\.com/portal.SEUDOMINIO/g' \
    deploy/proxy/nginx-saas.conf.example | sudo tee /etc/nginx/sites-available/skygenpanel.conf
sudo ln -sf /etc/nginx/sites-available/skygenpanel.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 4. Variáveis, e reiniciar: o resolvedor lê o domínio-base no IMPORT, então editar
#    o .env sem reiniciar não muda nada.
#      TENANT_BASE_DOMAIN=painel.exemplo.com
#      PORTAL_BASE_DOMAIN=portal.exemplo.com
#      CORS_ORIGINS=https://painel.exemplo.com   # só o apex: origem do mesmo host já passa
#      TRUST_PROXY=1
```

**Sem certificado curinga** — DNS sem API, que é a situação de boa parte dos domínios
`.com.br` — os passos 2 e 3 acima não servem, e não é questão de preferência: não há
`--dns-<provedor>` para chamar, e `nginx-saas.conf.example` não pode ser instalado,
porque os blocos `*.painel…` e `*.portal…` dele apontam para certificados que não
existem. O nginx recusa o **arquivo inteiro** nesse caso, não só o bloco:

```
[emerg] cannot load certificate "/etc/letsencrypt/live/portal.exemplo.com/fullchain.pem":
        … No such file or directory
nginx: configuration file … test failed
```

No lugar deles, um certificado por provedor — e aí a ordem passa a importar:

```bash
# 2'. Um curinga só de DNS (grátis em qualquer provedor, cadastrado uma vez) poupa
#     criar um registro por provedor novo. Só de DNS: o certificado continua sendo um
#     por provedor.
#       painel.exemplo.com     A → servidor
#       *.painel.exemplo.com   A → servidor

# 3'. Um comando por provedor QUE JÁ EXISTE, e ANTES do restart do passo 4.
sudo ./deploy/novo-provedor.sh alfa
sudo ./deploy/novo-provedor.sh beta
```

Nada mais a instalar: o bloco do apex já existe — é o host único de hoje —, e o de cada
provedor entrou com o comando acima.

**Essa ordem é a única coisa desta migração que, invertida, tira gente do ar.** Assim
que `TENANT_BASE_DOMAIN` entra e o processo reinicia, o painel de cada provedor passa a
responder *só* em `<slug>.<base>`; um provedor cujo certificado ainda não saiu atende
com erro de TLS, que é pior do que não atender — o navegador culpa o painel, não a
migração. Emitir antes não custa nada, porque o script é idempotente e confere o DNS
sozinho; emitir depois custa uma janela de indisponibilidade por provedor.

De um provedor novo em diante é um comando só, no dia em que ele é criado no console.

**Conferir**, nesta ordem — a primeira que falhar diz qual passo ficou pela metade:

```bash
curl -s  https://painel.exemplo.com/api/tenant/public           # {"slug":null,…} = porta de entrada
curl -s  https://alfa.painel.exemplo.com/api/tenant/public      # {"slug":"alfa",…}
curl -s  https://naoexiste.painel.exemplo.com/api/tenant/public # 404, e não o painel de alguém
curl -sI https://alfa.portal.exemplo.com/ | head -1             # o portal de pé
curl -s  https://painel.exemplo.com/api/health                  # responde em qualquer host

# e o recorte do console, que é o que mais surpreende quem migra:
curl -so /dev/null -w '%{http_code}\n' https://painel.exemplo.com/api/platform/tenants       # 401: existe, pede sessão
curl -so /dev/null -w '%{http_code}\n' https://alfa.painel.exemplo.com/api/platform/tenants  # 404: não existe ali
curl -so /dev/null -w '%{http_code}\n' https://painel.exemplo.com/api/devices                # 404: o apex não serve provedor
```

A prova de que o endereço passou a existir de verdade: no console, **Equipe** de um
provedor → **Criar convite**. O link tem que sair como
`https://<slug>.painel.exemplo.com/invite#…`; enquanto sair só o token, o painel ainda
não enxerga o domínio-base (variável não aplicada, ou processo não reiniciado).

**Voltar atrás** é tirar `TENANT_BASE_DOMAIN` e `PORTAL_BASE_DOMAIN` e reiniciar: o
apex volta a servir o painel do primeiro provedor, como antes. Nenhum dado muda de
lugar em nenhuma das duas direções — o que muda é só por qual nome cada um atende.

## 2. Ver: logs

Uma linha por evento, e **o provedor em toda linha**. Uma linha sem provedor num
deploy compartilhado é uma linha que ninguém consegue transformar em ação.

```
2026-09-10T18:40:12.331Z INFO  tenant=7 http req=3f1c… method=GET path=/api/devices status=200 ms=41.2 ip=203.0.113.9 host=alfa.painel.exemplo.com
2026-09-10T18:40:12.902Z ERROR tenant=7 unhandled_error req=8a9e… method=POST path=/api/sgp/sync err="connect ETIMEDOUT" errName=Error errCode=ETIMEDOUT
[tenant=7] SGP sync error: connect ETIMEDOUT
```

- `LOG_FORMAT=json` troca para um objeto por linha (`tenant_id` como campo), que é o
  que um coletor prefere. `LOG_LEVEL=debug|info|warn|error`.
- `tenant=-` é uma requisição recusada antes de resolver o provedor (host errado) ou o
  boot. As linhas `[tenant=N] …` são as antigas do `console.*`, etiquetadas no boot com o
  mesmo contexto; jobs de fundo rodam por provedor e saem etiquetados do mesmo jeito.
- Toda requisição tem `req=<uuid>`, devolvido em `X-Request-Id`. Uma captura de tela com
  o cabeçalho e um `grep` no log se encontram.
- `path` nunca traz a query string, então um token colado na URL não vai para o log.
- `/api/health` só aparece quando falha.

## 3. Ver: métricas

`GET /api/platform/metrics`, formato de exposição do Prometheus, **`tenant_id` em toda
série**. Lê quem tem sessão de administrador da plataforma ou quem manda
`Authorization: Bearer $METRICS_TOKEN`.

```
skygenpanel_http_requests_total{method="GET",status="2xx",tenant_id="7"} 1284
skygenpanel_http_request_duration_ms_bucket{le="250",tenant_id="7"} 1270
skygenpanel_acs_requests_total{outcome="refused",tenant_id="7"} 3
```

- `http_requests_total` por provedor, método e classe de status. O caminho **não** é
  rótulo: é ilimitado, e uma série por caminho é como um registro come a memória.
- `http_request_duration_ms` por provedor, com baldes grossos (25/100/250/1000/5000 ms).
  A pergunta que responde é "o painel deste provedor está lento", não a forma do p99.
- `acs_requests_total` por provedor e resultado: `ok`, `refused` (a guarda de egresso
  disse não antes de abrir socket — configuração do provedor) e `error` (rede ou o ACS).
  `refused` subindo é ticket para o provedor; `error` subindo é o ACS dele fora.

Contadores vivem no processo: reiniciou, zerou; duas réplicas são dois alvos de scrape.
Um `scrape_config` mínimo:

```yaml
- job_name: skygenpanel
  scheme: https
  metrics_path: /api/platform/metrics
  authorization: { credentials: "<METRICS_TOKEN>" }
  static_configs: [{ targets: ["default.painel.exemplo.com"] }]
```

Qualquer host de provedor serve; o caminho está isento da porta de assinatura e da
resolução de provedor não depende — mas o apex não o serve.

## 4. Guardar: backup

O que existe em três lugares, e cada um tem seu backup:

| O quê | Onde | Como guardar |
| --- | --- | --- |
| Tudo que é dado | Postgres | `pg_dump` diário, retenção 30 dias, um por semana guardado 1 ano |
| Anexos do WhatsApp | volume `paneldata` (`/var/lib/skygenpanel`) | snapshot do volume no mesmo horário |
| Os três segredos + `saas.env` | cofre da equipe | uma cópia; sem eles o dump é ilegível na parte cifrada |

```bash
# diário, fora do horário de pico
pg_dump "$DATABASE_URL" --format=custom --file="skygp-$(date -u +%F).dump"
# teste de restauração, mensal, num banco vazio
createdb skygp_restore && pg_restore --dbname=skygp_restore --no-owner skygp-2026-09-10.dump
```

### O que o painel agenda sozinho

A tabela acima descreve a edição hospedada, onde o Postgres é gerenciado e o snapshot é do
provedor. Para o **self-hosted** — que é o install do ISP, em SQLite, na máquina dele — o
`deploy/install.sh` instala e liga `skygenpanel-backup.timer`, diário às 03:17 com atraso
aleatório e `Persistent=true`. Timer e não cron por causa do `Persistent`: máquina
desligada às 3h roda o backup ao ligar, em vez de pular o dia em silêncio; e um `oneshot`
que falha fica `failed` e aparece em `systemctl --failed`, enquanto um cron que falha manda
um e-mail que ninguém lê.

Cada passada escreve um diretório em `/var/backups/skygenpanel` com o dump do banco (o
dialeto que o install usa, descoberto por `backend/scripts/backup-target.js`, que é o
único lugar que conhece a precedência `DATABASE_URL` > `db-config.json` > SQLite), o
`tar.gz` de `wa-media`, o `db-config.json`, e um `manifest.json` com tamanhos, `sha256`, a
versão do painel e **em que migração o dump foi tirado**. Retenção: 30 diárias mais o
domingo de cada uma das últimas 52 semanas.

**Num deploy em SQLite**, o banco é aberto em modo **WAL** — leitura e escrita deixam de se
trancar, e uma colisão de lock espera cinco segundos em vez de virar "database is locked" na
hora. Duas consequências operacionais: aparecem os arquivos `-wal` e `-shm` ao lado do banco,
e o `DATA_DIR` **não pode estar em NFS**, onde o WAL não funciona. O backup continua correto
sem nada a mudar, porque `backup-sqlite.js` usa a API `backup()` do próprio SQLite — que é
segura com WAL — e nunca um `cp` do arquivo vivo.

**O `.env` não entra no backup.** O que entra é a impressão digital de `SECRET_BOX_KEY` e
de `JWT_SECRET` — os doze primeiros hex de um SHA-256 salgado com o nome da variável, nunca
o valor. A razão é o modo de falha de `secretBox.decrypt`, que devolve `null` em vez de
levantar: restaurar o banco com a chave errada sobe um painel que responde 200 e em que
toda senha de portal, senha de WiFi e token de API volta nula — o operador vê "o dado
sumiu" quando o que falta é a chave. `skygenpanel backup verify` compara as impressões do
backup mais novo com as do `.env` vivo e recusa em voz alta quando divergem, que é a hora
certa de descobrir isso: antes do restore, e não durante.

`SKYGP_BACKUP_INCLUDE_SECRETS=1` inclui o `.env` em claro, e o script avisa. Só vale se o
destino já for cifrado: o backup passa a carregar a chave mestra e a senha do banco ao lado
do dado, o que troca "perdi o dado" por "vazou o painel inteiro".

Duas decisões continuam sendo de quem opera, e o painel não as toma: **para onde a cópia
sai da máquina** (nada disto é backup enquanto vive no mesmo disco) e **instalar
`postgresql-client` ou `mariadb-client`** quando o install não usa SQLite — o script morre
dizendo qual pacote falta, em vez de escrever um arquivo vazio e sair zero.

Restauração de verdade: parar o painel, restaurar, subir. As migrations no boot
reconhecem o schema restaurado pelo `schema_migrations` e não refazem nada. Se o dump
for de uma versão mais antiga do painel, o boot aplica o que falta — é o caminho de
upgrade normal.

**Por provedor**, sem tocar no banco, o próprio provedor tem `GET /api/tenant/export`
(capacidade `tenant.export`, auditada): todas as tabelas dele na ordem que as chaves
estrangeiras pedem, sem segredo cifrado e sem hash de senha, com um manifesto dizendo o
que ficou de fora. É o que se entrega numa solicitação da LGPD e o que se guarda antes de
apagar um provedor.

E **pelo console**, `GET /api/platform/tenants/:id/export` (plano de controle, com teto de
seis por minuto) produz o mesmo arquivo, pelo mesmo serviço, para qualquer provedor —
inclusive suspenso. Esse "inclusive" é o motivo de a rota existir: suspender devolve 404
no host inteiro do provedor, e a exclusão exige suspensão antes, então a janela para o ISP
levar os próprios dados fechava antes de a exclusão ser permitida. A exportação daqui
grava em `platform_audit` **antes** de entregar — sem a linha, o arquivo não sai — e
também na trilha DO provedor, marcada como vinda do console, porque quem pergunta "alguém
baixou a nossa base?" é o ISP e ele não lê a nossa trilha.

**Por assinante**, na ficha do aparelho, o provedor atende o titular dele sem passar por
nós: `GET /api/customers/:accountId/export` (capacidade `customers.dossier`) monta o
dossiê de uma pessoa, e `DELETE /api/customers/:accountId` (capacidade `customers.erase`,
com o "ID do Cliente" digitado de volta) apaga. As duas ficam em `audit_log`; na exclusão
a linha da trilha é gravada **antes** e é condição para que ela aconteça. Dois avisos para
o plantão, porque chegam como chamado: o CPF que o SGP do ISP guarda não sai daqui, e uma
exclusão feita sem o serviço ter sido cancelado se desfaz na próxima `syncFleet` — a ONT
continua informando e a conta renasce com um ID do Cliente novo.

## 5. Desfazer: suspender, apagar

Ambos no console (`/platform`), ambos gravados em `platform_audit`, que é compartilhada e
**não tem chave estrangeira para `tenants`** — de propósito, para a linha que diz "este
provedor foi apagado" sobreviver ao provedor.

1. **Suspender** (`PATCH /api/platform/tenants/:id`): o provedor para de resolver na
   hora — todo host dele responde 404, os tokens existentes deixam de servir, e os jobs de
   **trabalho** pulam ele: envio, alerta, reconciliação com o ERP, painel, aviso de
   vencimento e emissão da cobrança. Os de **retenção** não pulam, e isso é de propósito:
   trilha, execuções de provisionamento, eventos do ERP, histórico de WhatsApp com os
   anexos e amostras de sinal continuam sendo apagados pela idade. Suspender muda quem
   trabalha, não o que guardamos de alguém — e como não existe prazo de suspensão, deixar
   a retenção de fora queria dizer guardar para sempre. Reversível.
2. **Apagar** (`DELETE /api/platform/tenants/:id`): exige estar no plano de controle, o
   provedor estar **suspenso** (o que faz da exclusão um segundo passo, com um estado
   reversível no meio) e o slug digitado de volta, exato. A linha da trilha é gravada
   **antes**, com a contagem do que vai sumir; se ela não puder ser gravada, nada é
   apagado. Numa instalação **sem** domínio-base há uma quarta condição — não ser o
   último provedor —, porque lá é ele que a resolução por padrão devolve, e sem nenhum o
   deployment inteiro responde 503. Onde o host nomeia o provedor essa condição não
   existe: o console vive no apex e continua de pé com zero clientes.

A assinatura é outra chave: `suspended`/`canceled` na assinatura derruba o painel e o
portal com 402 e mantém tudo no banco; `past_due` deixa ler. Um provedor inadimplente
não precisa ter o alerta de ONT caída parado.

### O console por dentro

Em `https://painel.exemplo.com/platform` — o endereço da plataforma, não o de um
provedor. Quatro abas:

- **Provedores** — criar, suspender, reativar, apagar, ver e mudar a equipe e a
  assinatura de cada um, e abrir o painel de um cliente em modo leitura.
- **Planos** — o catálogo: criar, editar preço, limites e período de teste, ativar e
  desativar. **O código de um plano não muda depois de criado** (é por ele que as
  assinaturas apontam), e mudar um plano só vale para quem assinar DEPOIS: a assinatura
  guarda o plano, não uma cópia dos números dele. Desativar não apaga — some da lista de
  escolha e continua valendo para quem já assina, que é como se para de vender um plano
  sem mexer em contrato de ninguém. Por isso não há botão de excluir plano.
- **Acesso à plataforma** — quem tem o plano de controle. O último não pode ser
  removido: um cadastro vazio tranca todo mundo para fora e só SQL recupera.
- **Trilha da plataforma** — o que a plataforma fez com cada provedor, paginado.

## 6. Trocar segredos

- `JWT_SECRET` / `PORTAL_JWT_SECRET`: trocar e reiniciar. Toda sessão cai; nenhum dado
  se perde.
- `SECRET_BOX_KEY`: trocar **com as duas chaves vivas e rodando `rotate-key`**. A nova em
  `SECRET_BOX_KEY`, a anterior em `SECRET_BOX_KEY_PREVIOUS`, e então
  `skygenpanel rotate-key` — que reescreve todo segredo guardado com a chave viva. Sem
  esse passo, uma linha só migra quando alguém a edita, e limpar a chave anterior do
  `.env` torna ilegível o que não migrou. O comando recusa em vez de adivinhar: um
  segredo que nenhuma chave do processo abre para a execução inteira, e nada é reescrito.
  `--dry-run` conta antes, por versão. **A CLI `skygenpanel` é do install self-hosted** —
  a tabela das edições, no topo deste documento, a põe nessa coluna. Num deploy SaaS o
  comando é o mesmo script, por dentro do contêiner: `docker compose -f
  deploy/docker-compose.saas.yml exec panel node scripts/rotate-secret-key.js`, com ou sem
  `--dry-run`. A CLI não faz mais do que isso (`deploy/skygenpanel:232`).
  **A chave anterior continua necessária para os BACKUPS** tirados antes da troca — a
  retenção guarda perto de um ano deles, e `backup verify` recusa um restore cuja chave
  não bate. Arquive a chave antiga junto com os dumps antes de tirá-la do `.env`.
- `METRICS_TOKEN`: trocar, reiniciar, atualizar o coletor.

## 7. Entrar no painel de um cliente

O console tem, em cada provedor ativo, um botão que abre uma **sessão de atendimento**: o
painel daquele ISP, como os operadores dele o veem.

- **Só leitura.** Toda escrita é recusada com 403 `impersonation_read_only`, em qualquer
  rota. Quando um cliente precisa que alguém mexa em alguma coisa, quem mexe é a equipe
  dele — ou o console, que age em nome da plataforma e assina como tal.
- **Meia hora, sem renovação.** Continuar é voltar ao console e abrir outra.
- **Registrada dos dois lados.** Na nossa trilha (`platform_audit`, ação
  `tenant.impersonated`) e na trilha DO PROVEDOR (`audit_log`, ação
  `platform.impersonated`), que é onde ele vai olhar quando perguntar se entraram no painel
  dele. Conte com isso: o cliente pode ver, e é para poder.
- **Acaba sozinha** se quem a abriu sair de `platform_admins` ou trocar a senha.
- Uma faixa vermelha fica no alto de toda tela enquanto ela dura. "Sair" joga o token fora.

Um provedor **suspenso** não é personificável: o painel dele está fora do ar para os
operadores dele, e é isso que a sessão mostraria.

## 8. E-mail

Opcional, e o painel funciona sem. Com `SMTP_URL` e `MAIL_FROM` configurados, o convite de
equipe vai por e-mail quando quem convida informa um endereço; sem eles, o link sai na tela
para ser entregue como sempre foi.

O link precisa de um endereço absoluto. Com `TENANT_BASE_DOMAIN`, ele é derivado do slug de
cada provedor. Sem subdomínios, é `PUBLIC_BASE_URL` — e sem ela não há envio, porque o
painel não inventa o próprio endereço a partir do que a requisição disser.

Um SMTP fora do ar não quebra nada: o convite existe, a resposta diz `emailed: false` e o
link está ali.

### O que mais sai por e-mail

**A redefinição de senha** (`/forgot-password` no painel de cada provedor). Quem pede
recebe sempre a mesma resposta — exista a conta ou não —, porque a rota é pública e uma
resposta que variasse diria a um estranho quais identificadores têm conta ali. O link vale
trinta minutos, serve uma vez, só funciona no host onde foi cunhado e morre se o endereço da
conta mudar antes de ele ser usado. Concluir derruba todas as sessões daquela conta.

**A prova do endereço** (`/verify-email`). Um endereço cadastrado prova que alguém controla
a CONTA — a senha atual é exigida —, não que controla o ENDEREÇO. A diferença não custava
nada enquanto só a senha abria a conta e passa a custar tudo com a redefinição por e-mail:
um endereço digitado errado seria um caminho para dentro. Por isso **só endereço verificado
recebe redefinição**, e a verificação é desfeita a cada troca de endereço.

Consequência prática do upgrade: **todo endereço já cadastrado entra como não verificado**.
Ninguém fica trancado do lado de fora — a verificação não é condição de login, só de
redefinição —, mas até cada pessoa confirmar o seu, "esqueci minha senha" não funciona para
ela. A tela de conta mostra o aviso e o botão que manda a prova. Vale avisar a equipe na
janela do upgrade, e sem SMTP configurado nenhum dos dois caminhos existe: nesse deploy a
senha esquecida continua sendo resolvida por quem administra.

Nenhuma das duas mensagens carrega dado de provedor — nome de operador, contagem de
assinantes, nada. Uma caixa de entrada alheia não é lugar onde isso mora.

## 9. O que este documento não cobre, porque ainda não existe

Nada — e vale dizer em voz alta, porque esta seção passou meses com dois itens. Os dois
saíram: a metade do gateway que **emite** a cobrança está na seção 10, e o **comando de
re-cifra** da `SECRET_BOX_KEY` está na seção 6.

O que continua fora está escrito onde é útil, junto do mecanismo, e não numa lista à
parte que ninguém revisa: a cobrança em moeda que não seja BRL e a soma de pagamentos
parciais estão no fim da seção 10.

## 10. Receber pagamento sozinho

Até aqui o pagamento de um provedor era um botão no console: alguém conferindo extrato e
marcando à mão. Com dez clientes passa; com cinquenta é uma pessoa por dia, e é uma pessoa
que erra.

`POST /api/billing-webhook` recebe a entrega do gateway e credita a assinatura. Três coisas
para ligar — as duas primeiras no console, aba **Integrações → Asaas**:

1. **O token do webhook.** É a credencial que o gateway devolve no cabeçalho
   `asaas-access-token` de toda entrega, e é do **deploy** e não de um provedor: há uma
   conta no gateway e ela é nossa. O botão *Gerar token* cunha um (32 bytes aleatórios),
   grava cifrado na caixa da plataforma e o mostra **uma vez** — cole-o no painel do
   gateway, na configuração do webhook. Sem token nenhum a rota responde **404**: uma rota
   que mexe em dinheiro não pode ficar aberta porque alguém esqueceu de configurá-la.
2. **O endereço, no painel do gateway.** A tela de Integrações mostra o endereço pronto
   (`https://<apex>/api/billing-webhook`, montado do `TENANT_BASE_DOMAIN` ou do
   `PUBLIC_BASE_URL`). A rota é montada acima do resolvedor de provedor de propósito: o
   apex não nomeia provedor nenhum, e resolvida por host a entrega levaria 404 antes do
   controlador.
3. **A correlação, no console**, aba *Gateway* de cada provedor: o nome do gateway
   (`asaas`) e o id do cliente lá dentro (`cus_…`). É por ela que a entrega volta ao
   provedor certo. Enquanto ela não existir, o pagamento vira uma linha de log dizendo
   `no provider for payment …` e a cobrança segue manual. **Só o console escreve** esses
   dois campos: um provedor que pudesse escrever o próprio id apontaria para o cliente de
   outro e receberia o crédito alheio. Em vez de colar um id, o console também pode
   **criar o cliente no gateway** a partir do cadastro fiscal do provedor (razão social,
   CPF/CNPJ, e-mail, telefone e endereço; `externalReference` = `tenant:<id>` e os avisos
   do gateway desligados, porque os avisos são nossos) e ligá-lo na mesma operação. Exige
   CPF/CNPJ no cadastro e recusa (409) quem já está ligado — para trocar, desligue antes.

**Onde mora a configuração, e o `.env`.** A chave da API, o ambiente (sandbox ou produção)
e o token do webhook ficam no `app_state` da **caixa da plataforma**, os dois segredos
cifrados (contexto `skygenpanel-asaas-gateway-v1`, incluído na re-cifra da seção 6). A
tela nunca mostra o valor, só se está configurado e **de onde vem**: `db` (gravado pelo
console) ou `env`. As variáveis `ASAAS_API_KEY` e `BILLING_WEBHOOK_TOKEN` continuam
funcionando como **fallback opcional** — o que o console gravou ganha, e apagar pelo
console (campo vazio) devolve a palavra ao `.env`. Um deploy que já cobrava pelo `.env`
não precisa mudar nada. Sem caixa da plataforma (self-hosted, ou SaaS que ainda não a
criou) só o `.env` vale, e gravar pelo console responde 409 `no_platform_tenant`. Cada
mudança fica na trilha da plataforma como `platform.integration_changed`, sem o valor.

O caminho de volta tem duas chaves, nesta ordem: a nossa própria referência
(`externalReference` no formato `tenant:<id>`, quando fomos nós que criamos a cobrança) e o
id do cliente no gateway (para a cobrança emitida lá dentro, à mão — que é como os
primeiros contratos vão ser cobrados). Provedor suspenso ou apagado não resolve por
nenhuma das duas.

**A disciplina de status, que é o que impede uma fila de reentrega infinita:** 401 uniforme
para credencial que não presta, 404 para deploy sem gateway ligado, 500 só para falha
genuína deste lado — e **200 para tudo que se escolhe não fazer**: reentrega, evento que
não é dinheiro entrando, pagamento que não resolve provedor nenhum. Um não-2xx faz o
gateway reentregar em laço para sempre.

**A mesma referência credita uma vez só**, e a chave é o id do **pagamento**, não o do
evento. O gateway manda dois eventos para um pagamento de cartão — `PAYMENT_CONFIRMED`
quando a operadora aprova e `PAYMENT_RECEIVED` quando o dinheiro cai, trinta dias depois.
Os dois falam do mesmo `payment.id`, então o segundo responde `duplicate` e não empurra a
data. Com a chave no id do evento, todo cartão ganharia dois períodos e ninguém perceberia
por meses.

**O que conferir antes da primeira cobrança de verdade.** O formato do corpo é a única
coisa aqui que não se verifica sem uma conta no gateway: ele está lido de uma função pura
(`AsaasBillingProvider.interpretar`) e falha FECHANDO — um campo que mudou de nome devolve
"não faço nada" e ninguém é creditado, em vez de creditar errado. Mande uma entrega de
teste pelo painel do gateway e confira no log do processo: `nothing to do with event "…"`
significa que o corpo chegou e não foi reconhecido.

### Emitir a cobrança

A outra metade, e ela também deixou de ser manual. Configure em **Integrações → Asaas**:

- **A chave da API** — a chave com que o painel CHAMA o gateway. Não é a mesma coisa que
  o token do webhook: aquele autentica a entrega que chega, esta autentica a chamada que
  sai, e elas viajam em cabeçalhos diferentes (`asaas-access-token` na entrada,
  `access_token` na saída). Trocá-las dá 401 numa direção só — a que só se exercita
  cobrando de verdade. O botão *Testar conexão* confere a chave e mostra o nome da conta
  (é o que distingue a chave certa da chave de sandbox de outra pessoa).
- **O ambiente** — `sandbox` (`https://api-sandbox.asaas.com/v3`, chaves `$aact_hmlg_…`)
  ou `production` (`https://api.asaas.com/v3`, chaves `$aact_prod_…`). Sem escolha no
  console, é produção quando a chave vem do `.env` (o comportamento de antes) e sandbox
  quando não há chave nenhuma.

`ASAAS_API_KEY` no `.env` continua valendo como fallback, e **`ASAAS_BASE_URL`**, quando
posta, ainda ganha do ambiente escolhido — ela existe para apontar o cliente a um servidor
de testes, e não deveria estar posta num deploy de verdade.

Sem a chave, nada é emitido e todo provedor segue na cobrança manual — e o job diz isso
(`gateway_not_configured`) em vez de queimar tentativas.

**Quando sai.** O job roda dentro da mesma passada por provedor do aviso de vencimento,
cinco dias antes do prazo (`LEAD_DAYS`). O valor é o `price_cents` do plano, o período é o
`period_days` dele, e o vencimento é o fim do período — **exceto** para quem já está
vencido, que recebe três dias a contar de hoje: um gateway recusa cobrança que nasce
vencida, e sem isso a população que mais precisa ser cobrada seria a única a nunca ser.

**Uma cobrança por período, garantida pelo banco.** `billing_charges` tem único
`(tenant_id, period_end)`, e a linha nasce ANTES da chamada ao gateway — é o bilhete que
ganha a corrida entre duas passadas. O gateway não oferece chave de idempotência, então a
guarda é nossa. A chave se renova sozinha: um pagamento empurra `renews_at`, o período
seguinte tem outra chave, e ninguém precisa limpar nada.

**Quando falha.** A linha fica com `status: failed`, o motivo do gateway em `last_error` e
uma espera de uma hora antes da próxima tentativa — sem ela, uma resposta perdida viraria
cinco cobranças de verdade em cinco minutos. Depois de cinco tentativas o job desiste e a
linha fica para alguém ler: a centésima tentativa recusa igual, e o que resolve é uma
pessoa olhar o `last_error`.

**O que o provedor recebe.** O aviso de vencimento passa a levar o link de pagamento
quando há cobrança emitida, e o endereço do painel quando não há. O primeiro aviso de um
ciclo ainda sai com o endereço do painel — a cobrança dele nasce na mesma passada, logo
depois — e é o preço de o aviso não depender do gateway estar de pé.

**O valor é conferido.** Até aqui o pagamento era um interruptor: qualquer número ligava o
período inteiro, e R$0,01 contra uma fatura de R$199,90 comprava o mesmo mês. Agora se
compara com o que foi pedido — **a cobrança que o painel emitiu**, quando ela existe, e o
**preço do plano** quando não (a cobrança criada à mão no painel do gateway, e o botão do
console). A cobrança vence o catálogo de propósito: ela congela o valor no instante em que
pedimos, e se o preço do plano subiu depois, quem pagou pagou o que viu.

- **Pagou a mais:** credita. Boleto atrasado chega com juros, e recusar quem pagou mais do
  que devia seria o absurdo simétrico.
- **Pagou a menos:** o dinheiro **entra no extrato** — ele de fato chegou — e o período
  **não anda**. O provedor fica em `past_due`, que deixa ler e para de deixar escrever:
  visível, avisado e recuperável, em vez de trancado do lado de fora. No log sai
  `paid N of M cents — recorded, period NOT extended`, e a cobrança continua `pending`,
  porque é isso que ela é.
- **Plano de preço zero:** nada foi pedido, nada é conferido. É o caso de todo provedor
  herdado, que está no `unlimited`.
- **Moedas diferentes** entre o pagamento e a referência: não dá para comparar centavos de
  moedas diferentes, então não se compara — e o log diz que não comparou, em vez de a
  conferência falhar em silêncio.

No console, um valor curto volta **409** com os dois números, e a tela oferece registrar
mesmo assim: é a saída para um acordo ou uma entrada negociada. Quem a usa fica na trilha
da plataforma com `underpaymentAccepted`, porque "quem deu desconto a quem" é uma pergunta
que alguém vai fazer.

**O resto do ciclo de vida da cobrança** também chega pelo webhook, e só muda a etiqueta
da cobrança em `billing_charges` — nunca o crédito:

- `PAYMENT_OVERDUE` → **`overdue`**: venceu sem pagamento. Continua em aberto (o link de
  pagamento vale e o aviso de vencimento o manda); um pagamento que chega depois a quita
  normalmente.
- `PAYMENT_DELETED` → **`canceled`**: alguém removeu a cobrança no painel do gateway. O
  job não emite outra para o mesmo período.
- `PAYMENT_REFUNDED` → **`refunded`**: o dinheiro voltou. **O período que ele comprou NÃO é
  desfeito** — isso é decisão de gente, pelo console; o log do processo diz
  `was REFUNDED — the subscription credit was NOT reversed`.

Um evento fora de ordem não reabre nada (um `OVERDUE` atrasado não volta uma cobrança paga
para em aberto), e todos respondem 200, inclusive quando a cobrança não é nossa.

**O que continua fora:** a cobrança em moeda que não seja BRL (o gateway não tem campo de
moeda, e o cliente recusa em voz alta em vez de cobrar reais com etiqueta de dólar);
cancelar no gateway a cobrança de um provedor apagado; e **somar pagamentos parciais** —
dois pagamentos que juntos fecham a conta continuam sem creditar, e cada um deles aparece
no extrato para alguém resolver com o botão do console. Não foi construído porque depende
de o gateway aceitar pagamento divergente, o que não dá para conferir sem uma conta lá
dentro, e um mecanismo construído sobre uma suposição sobre dinheiro é pior que a falta
dele.

## 11. Vários provedores num GenieACS só

O painel separa os provedores pelo endereço do GenieACS de cada um. Quando dois
provedores apontam para o **mesmo** GenieACS, só essa separação não basta: cada um veria
(e poderia reiniciar, apagar ou resetar) a frota inteira. O que os separa, nesse caso, é a
**tag de equipamentos**:

- No console, aba **Provedores → GenieACS**, cada provedor ganha uma tag (letras, números e
  `_`; os prefixos `contrato_`, `idcliente_`, `loja_` e `tecnico_` são do painel e ficam de
  fora). Duas tags iguais em dois provedores são recusadas.
- Com a tag definida, o painel daquele provedor só enxerga ONTs que a carregam: lista,
  contagem, Dashboard, exportação, falhas, detalhe e toda ação. Um equipamento de outro
  provedor responde "não encontrado", como se não existisse.
- Tag vazia é o comportamento antigo — use só quando o GenieACS é exclusivo do provedor.
- O provedor não troca nem remove a própria tag: é campo da plataforma, e a API de tags
  do painel recusa mexer em qualquer tag que seja de algum provedor.
- O console avisa, no cartão do GenieACS, quando outros provedores usam o mesmo endereço
  e algum deles está sem tag — esse é o estado em que as frotas estão misturadas.

**Atenção à ordem:** um provedor com tag e sem nenhum equipamento marcado vê a lista
vazia. É o lado seguro, mas combine com ele antes, ou marque a frota logo em seguida.

### Marcar a frota que já existe

No mesmo cartão, **Marcar equipamentos** procura na frota inteira do GenieACS por prefixo
do login PPPoE (ex.: `TA100`) ou por uma lista de seriais colada. **Ver prévia** mostra
quantos casam, quantos já estão marcados, quantos serão marcados e quais carregam a tag de
OUTRO provedor — esses nunca são alterados, e ficam listados para a correção à mão no
GenieACS. Só depois da prévia aparece o botão que aplica. Cada aplicação entra na trilha da
plataforma.

### Marcar sozinho os equipamentos novos

No mesmo cartão, **Prefixos PPPoE para marcação automática** (ex.: `TA100, TA200`) liga a
marcação pelo próprio painel: a cada 15 minutos o agendador procura, na frota do GenieACS,
ONTs cujo login começa com um desses prefixos e aplica a tag do provedor — com as mesmas
regras da ferramenta manual (só acrescenta; ONT com a tag de outro provedor fica de fora e
conta como conflito). O cartão mostra quando foi a última passada e quantas marcou.

- Exige a tag definida; lista vazia desliga.
- Dois provedores no mesmo GenieACS não podem ter prefixos que se cobrem (`TA1` e `TA100`):
  o console recusa, porque os dois disputariam as mesmas ONTs.
- Uma ONT nova pode levar até 15 minutos para aparecer no painel do provedor.

**Alternativa sem espera:** para a ONT já chegar marcada no primeiro Inform, uma provision
no GenieACS pode aplicar a tag a partir do login PPPoE. Exemplo (ajuste prefixos e tags; um
`if` por provedor):

```js
// Provision "tag-provedor" — preset em todo Inform (evento 0 BOOTSTRAP, 1 BOOT ou periódico)
const agora = Date.now();
const user = declare(
  "InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Username",
  { value: agora - 24 * 3600 * 1000 }
);

let login = "";
for (const p of user) if (p.value && p.value[0]) { login = String(p.value[0]); break; }

const regras = [
  { prefixo: "TA100", tag: "tavaresfibra" },
  { prefixo: "INV", tag: "inove" }
];
for (const r of regras) {
  if (login.toUpperCase().startsWith(r.prefixo)) {
    declare("Tags." + r.tag, null, { value: true });
    break;
  }
}
```

Em ONT TR-181 o caminho do login é `Device.PPP.Interface.*.Username`. A provision só
**acrescenta** tag; um equipamento que troca de provedor tem a tag antiga removida à mão no
GenieACS (o painel não deixa um provedor removê-la).

## 12. O GenieACS do provedor: direto, túnel ou agente

Cada provedor diz ao painel **como** chegar ao GenieACS dele, e o modo é escolhido por
provedor — na SaaS, pelo console (aba **Provedores**, cartão do GenieACS); na instalação
própria, pelas Configurações do provedor, onde só `direto` e `agente` aparecem (lá a rede
privada já é permitida, e o túnel não acrescenta nada).

| Modo | Quando usar | O que o provedor precisa ter |
| --- | --- | --- |
| **Direto** (`direct`) | O GenieACS tem endereço público alcançável pelo painel | NBI (porta 7557) exposta, de preferência com credencial e TLS |
| **Túnel** (`tunnel`) | O GenieACS está numa rede privada que **nós** alcançamos por VPN/WireGuard | O túnel montado do nosso lado; o painel passa a aceitar faixa privada para aquele provedor |
| **Agente** (`agent`) | O GenieACS está atrás de NAT, sem IP público, e ninguém quer abrir porta | Uma máquina Linux com systemd na rede dele, que alcance o GenieACS e saia para a internet |

Na dúvida, **agente**: nada fica exposto na rede do provedor, a conexão é de saída (passa
por NAT e firewall comuns), e a credencial é uma chave que se troca num clique. O túnel
continua sendo a saída para quem já tem VPN com a gente; o direto, para quem já publica a
NBI.

### Instalar o agente

1. Ponha o provedor no modo **agente** e clique em **Gerar chave**. A chave (`sgpa_…`)
   aparece **uma vez só** — o painel guarda apenas o hash dela. Copie antes de fechar.
2. Numa máquina da rede do provedor (Debian/Ubuntu ou RHEL e derivados; qualquer uma que
   alcance o GenieACS serve, inclusive o próprio servidor dele), como quem pode usar
   `sudo`:

   ```bash
   curl -fsSL https://alfa.painel.exemplo.com/api/genieacs-agent/install.sh | sudo bash
   ```

   O endereço é o do painel daquele provedor — a tela mostra o comando pronto. O
   instalador já vem com esse endereço como padrão e pergunta o resto: a chave (digitada
   **sem eco**, lida do terminal e não do pipe) e o endereço da NBI (padrão
   `http://127.0.0.1:7557`, que ele testa e avisa se não responder). Sem terminal — por
   automação —, a chave vem de um arquivo: `curl -fsSL …/install.sh | sudo
   AGENT_TOKEN_FILE=/root/chave.txt bash` (e `PANEL_URL`/`GENIEACS_URL` do mesmo jeito, se
   o padrão não servir). **Nunca** pela linha de comando: o instalador recusa `--token` e ignora
   `AGENT_TOKEN` no ambiente, porque o que passa por argumento aparece no `ps` de qualquer
   usuário da máquina.
3. O instalador põe o Node 22 se faltar (o mesmo piso do painel, 22.22), baixa o agente **do próprio painel** (na mesma
   versão dele), cria o usuário de sistema `skygenpanel-agent` e sobe o serviço. Em
   segundos o cartão do GenieACS mostra **conectado**, com a versão do agente.

O que fica na máquina:

| Onde | O quê |
| --- | --- |
| `/opt/skygenpanel-agent/skygenpanel-agent.mjs` | O programa (root, 0644) |
| `/etc/skygenpanel-agent.env` | `PANEL_URL`, `AGENT_TOKEN`, `GENIEACS_URL` (root, **0600** — quem lê é o systemd, antes de trocar de usuário) |
| `/etc/systemd/system/skygenpanel-agent.service` | A unidade, com o endurecimento do systemd (sem privilégio, sistema de arquivos só leitura, só IPv4/IPv6) |

### Operar

- **Ver o log:** `journalctl -u skygenpanel-agent -f`. "Chave revogada" quer dizer que
  alguém gerou outra no painel (o agente continua tentando a cada minuto, esperando o
  arquivo de ambiente ser atualizado); erro ao chamar o GenieACS local quer dizer que a
  NBI caiu ou o endereço mudou.
- **Estado:** `systemctl status skygenpanel-agent`. O serviço reinicia sozinho (a cada 5 s)
  e nunca desiste; o agente reconecta ao painel sozinho depois de queda de rede ou de
  restart do painel.
- **Trocar a chave:** gere outra no painel — a conexão atual cai na hora (código 4001) — e
  rode o instalador de novo, respondendo **n** a "manter a chave atual?". Ou edite
  `AGENT_TOKEN=` em `/etc/skygenpanel-agent.env` e `sudo systemctl restart
  skygenpanel-agent`. Troque sempre que alguém que viu a chave sair da equipe.
- **Atualizar o agente:** rode o instalador de novo. Ele baixa o programa da versão
  atual do painel e mantém a chave e os endereços gravados.
- **Mudar o endereço do GenieACS:** instalador de novo, ou `GENIEACS_URL=` no mesmo
  arquivo e `systemctl restart`.
- **Desinstalar:**

  ```bash
  curl -fsSL https://alfa.painel.exemplo.com/api/genieacs-agent/install.sh | sudo bash -s -- --uninstall
  ```

  Para, desabilita e remove a unidade, o programa, o arquivo de ambiente e o usuário. O
  Node fica. A chave continua válida no painel até alguém gerar outra ou mudar o modo —
  faça uma das duas.

Agente desconectado não derruba o painel: as telas que dependem do GenieACS respondem
**503 `acs_agent_offline`**, com a hora em que o agente foi visto pela última vez, e o
resto (assinantes, WhatsApp, cobrança) segue normal.

### O que o deploy precisa para o agente funcionar

- **O proxy tem que deixar o WebSocket passar.** O agente conecta em
  `/api/genieacs-agent/connect`, e o `location /` dos exemplos apaga o cabeçalho
  `Connection` (é o keepalive com o painel) — sem um bloco próprio, o upgrade não chega e o
  agente leva 426. `deploy/proxy/nginx-saas.conf.example` e
  `deploy/proxy/nginx-tenant.conf.template` já trazem o bloco `location =
  /api/genieacs-agent/connect` com `Upgrade`/`Connection "upgrade"` e tempos de uma hora;
  **um proxy instalado antes desta versão precisa dele acrescentado à mão** em cada
  `server` do painel (os provedores que têm bloco próprio, feitos por `novo-provedor.sh`,
  inclusive). O Cloudflare Tunnel passa WebSocket sem configuração.
- **Uma réplica do painel.** A conexão de cada agente vive dentro do processo que a
  aceitou. Com duas réplicas atrás de um balanceador, o agente fica preso a uma e os
  pedidos que caem na outra respondem `acs_agent_offline` — metade das telas falhando
  ao acaso. Enquanto não houver roteamento por provedor (mandar todo pedido de um
  provedor para a réplica que tem o agente dele), o deploy com agentes roda com **uma
  réplica só**. O `docker-compose.saas.yml` já sobe uma.
- Os dois arquivos que o instalador baixa (`/api/genieacs-agent/install.sh` e
  `/api/genieacs-agent/agent.mjs`) são públicos e sem segredo, servidos do disco do
  painel — na imagem Docker, o instalador vai para `/app/deploy/`. O padrão de
  `PANEL_URL` que o instalador traz vem do domínio-base (ou de `PUBLIC_BASE_URL` numa
  instalação de um provedor só), **nunca** do `Host` do pedido; sem nenhum dos dois, o
  instalador pergunta.

## 13. A página pública e o cadastro com plano

O ápice (`TENANT_BASE_DOMAIN`) serve a **página pública** em `/`: hero, recursos, como
funciona, planos, dúvidas e "Pedir demonstração". O console continua em `/login` e
`/platform` no mesmo endereço.

**Mostrar a página no domínio de marketing** (ex.: `tr69.com.br`, com o ápice em
`painel.tr69.com.br`). Só apontar o DNS **não basta**: o painel responde 404 a um host
que não conhece. Três caminhos:

1. **Não mexer no domínio.** O site atual continua onde está e os links de "Planos" e
   "Contratar" passam a apontar para `https://painel.tr69.com.br/#planos`.
2. **Redirecionar.** `tr69.com.br` → `https://painel.tr69.com.br/` com 301 (nginx,
   Cloudflare Page Rule/Redirect Rule, ou o painel da hospedagem).
3. **Servir direto, sem redirecionar.**
   - DNS de `tr69.com.br` e `www.tr69.com.br` para o servidor do painel.
   - No proxy, um bloco igual ao do ápice com `server_name tr69.com.br www.tr69.com.br`
     e o certificado desse nome (ver o comentário em
     `deploy/proxy/nginx-saas.conf.example`). O `Host` tem que chegar intacto.
   - `PLATFORM_EXTRA_HOSTS=tr69.com.br` no `.env` e reiniciar o painel. Vários nomes
     vão separados por vírgula; o `www.` de cada um já está incluído.

   **Deploy de endereço único** (sem `TENANT_BASE_DOMAIN`, todos os provedores entrando
   por `painel.tr69.com.br`): o `PLATFORM_EXTRA_HOSTS` também funciona, e é o único jeito
   de ter a vitrine e o cadastro nesse modo. Configure também
   `PUBLIC_BASE_URL=https://painel.tr69.com.br`: é para lá que o "Entrar" da página, o
   fim do cadastro e o WhatsApp de boas-vindas mandam o provedor novo. O endereço
   compartilhado continua exatamente como era (sem cadastro), e o nome extra não serve o
   painel de provedor nenhum.

   O nome extra vale **exatamente como o ápice**: a página pública, o `/signup` e também
   o login e o console da plataforma respondem nele. Um nome que o painel leria como
   provedor (o próprio domínio-base, o do portal, ou `x.painel.tr69.com.br`) é ignorado
   no boot, com aviso no log. O endereço dos provedores não muda: continua
   `<slug>.painel.tr69.com.br`.

- **Planos no site.** Console → Planos → Editar → "Página pública": marque *Mostrar na
  página pública*, escolha a ordem, o destaque ("Mais popular"), a descrição, os recursos
  (um por linha) e, se houver, o preço anual. Só planos **ativos e públicos** aparecem, lidos
  de `GET /api/public/plans`. Nenhum plano nasce público.
- **Contratar.** Cada card leva a `/signup?plano=<código>`. O cadastro nasce em **teste no
  plano escolhido** (os dias de teste do plano, ou o padrão se ele não tiver) e, no fim do
  teste, segue o fluxo de cobrança de sempre (seção 10). Plano que não está à venda é
  ignorado e o provedor recebe o teste padrão.
- **CNPJ e WhatsApp no cadastro.** Opcionais. O CNPJ é consultado na Receita
  (`GET /api/public/cnpj`) e vira `billing_tax_id`/razão social/cidade; o WhatsApp vira
  `billing_phone`. O subdomínio é conferido enquanto se digita
  (`GET /api/public/slug-available`).
- **Avisos por WhatsApp.** Pelo número conectado na caixa da plataforma: boas-vindas ao
  provedor novo e, junto com o e-mail, o aviso de fim de teste/vencimento para o
  `billing_phone`. Sem número conectado, nada é enviado e nada quebra.
- **Pedidos de demonstração.** Gravados em `leads` e listados na aba **Leads** do console
  (novo → contatado → ganho/perdido, com anotações). A equipe é avisada em
  `PLATFORM_NOTIFY_WHATSAPP` e/ou `PLATFORM_NOTIFY_EMAIL`.
- `PLATFORM_CONTACT_WHATSAPP` é o número do botão flutuante do site.
- **Dados do site pelo console:** Console → **Configurações → Dados do SaaS** cadastra
  nome fantasia (vira a marca do site), razão social, CNPJ, endereço, e-mail e WhatsApp de
  contato, os destinos dos avisos (WhatsApp/e-mail) e as redes sociais (Instagram, Facebook,
  YouTube, LinkedIn). Vale na hora, sem reiniciar. O `.env` fica como valor inicial: cada
  campo que nunca foi salvo no console usa a variável correspondente, e salvar o campo vazio
  devolve o valor ao `.env`. Guardado no `app_state` da caixa da plataforma.
- O rodapé do site mostra, se configurados, `PLATFORM_CONTACT_EMAIL`, `PLATFORM_LEGAL_NAME`
  (razão social), `PLATFORM_TAX_ID` (CNPJ) e `PLATFORM_ADDRESS`. O que não estiver no `.env`
  simplesmente não aparece.
- Os textos de venda (hero, números, fabricantes, recursos, perguntas e depoimentos) ficam
  em `frontend/src/components/landing/content.ts`. A seção de depoimentos só aparece quando
  a lista `testimonials` tem itens: preencha com depoimentos reais de clientes.

Limites por endereço: catálogo e subdomínio 60/min, CNPJ 20 a cada 15 min, pedido de
demonstração 5 por hora.
