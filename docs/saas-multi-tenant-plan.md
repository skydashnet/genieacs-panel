# Plano: transformar o TR69 Controle em SaaS multi-tenant

## Contexto

O TR69 Controle nasceu **single-tenant por construção**: um install = um provedor. Estamos
comercializando-o como SaaS, onde cada cliente é um **provedor de internet (tenant)** com
seus próprios operadores, seus próprios assinantes, seu próprio GenieACS e seu próprio plano.

Quando este documento foi escrito não existia **nenhuma** noção de tenant no código —
nenhuma coluna, nenhum middleware, nenhuma query filtrada por dono. Tudo era global: um
`.env`, um banco, uma linha `settings.genieAcsUrl`, um blob
`app_state.sgp_integration_config`, um `map_settings` com `id=1` fixo, e uma tabela `users`
cujo `username` era único globalmente.

**Isso mudou.** As linhas do banco pertencem a um provedor e as queries são filtradas por
ele; o que falta para vender ao segundo provedor está listado no *Estado* abaixo e no
*Checklist* no fim. O objetivo continua o mesmo: um deploy único capaz de atender dois
provedores diferentes **sem qualquer possibilidade de um enxergar dados do outro**, com
onboarding self-service, planos com limites e suspensão por inadimplência.

> **Como ler este documento.** As Fases 0 e 1 estão marcadas ✅ e descrevem o que **existe**;
> onde a entrega divergiu do plano, o texto conta a divergência em vez de a esconder. As
> Fases 2 a 8 continuam sendo plano, e o que já entrou delas está marcado dentro de cada uma.

### Estado: Fases 0 e 1 concluídas

**Fase 0** (fundação e segurança) entrou pelos PRs
[#12](https://github.com/tavaresbr/genieacs-panel/pull/12) e
[#16](https://github.com/tavaresbr/genieacs-panel/pull/16): flag `EDITION` com o seletor de
banco fora da edição hospedada, `SECRET_BOX_KEY` separada do `JWT_SECRET` com versão de chave
por segredo, PostgreSQL, `insertReturningId`, e a suíte rodando nos três dialetos no CI.

**Fase 1** (modelo de tenant e scoping estrutural) está **completa**. Foi entregue por duas
frentes trabalhando em paralelo — uma em fatias numeradas de PR, outra em "ondas" — o que
custou trabalho duplicado em `sgp_links` e três colisões de id de migration, mas chegou ao
fim. Hoje, na `main`:

| | Primeiro rascunho | Levantamento em `0127f49` | **Hoje (`226088d`)** |
| --- | --- | --- | --- |
| Tabelas no schema | 13 | 24 | **29** |
| Tabelas escopadas por provedor | 0 | 0 | **26** |
| Tabelas deliberadamente compartilhadas | — | — | **3** (`tenants`, `users`, `tenant_users`) |
| Tabelas pendentes | — | 24 | **0** |
| Models | 13 | 20 | **27** |
| `getDb()(...)` cru nos models | 65 | 121 | **18** |
| Caches globais em memória | 3 | 5 | **0** |

Os 18 `getDb()` restantes nos models não são resíduo: 10 tocam `users` e 7 `tenant_users`,
que são do deploy por decisão (ver *Onda 12* no fim), e 1 é o
`WhatsAppAccount.getByName` — a busca que **descobre** de qual provedor é um webhook que
chega sem sessão. Escopá-la exigiria já saber a resposta. Está marcada no código com
`tenant-scope-exempt` e a guarda estática exige essa marcação.

#### O que existe hoje como mecanismo

- **`backend/src/config/tenantContext.js`** — `AsyncLocalStorage` com `runInTenant()` e
  `currentTenantId()`, que **lança** fora de escopo. Falhar fechado é o que expôs, mais de
  uma vez, código novo de uma frente alcançando tabela que a outra acabara de escopar.
- **`backend/src/config/database.js`** — `tdb()`, `tinsert()`, `tinsertReturningId()` e
  `tbatchInsert()`. O `tdb()` devolve um Proxy que **lança se alguém chamar `.insert()`**
  nele: knex ignora `where` em insert, então essa porta precisava ser fechada no mecanismo,
  não na convenção.
- **`backend/src/config/tenantScope.js`** — `SCOPED_TABLES` e `SHARED_TABLES`, com o
  porquê de cada grupo escrito ao lado. `pendingTables()` hoje devolve vazio.
- **`backend/src/config/tenantJobs.js`** — `forEachTenant()` (uma passagem por provedor
  **ativo**), `forEveryTenant()` (uma passagem por provedor de **todo** status) e
  `forSoleTenant()` (roda uma vez e **recusa** quando existe um segundo provedor). A
  diferença entre os dois primeiros é a pergunta que cada job faz. *"Quem está
  trabalhando?"* — envio, alerta, reconciliação, painel, cobrança — responde `active`.
  *"De quem eu ainda guardo dado?"* — os jobs de retenção — não olha status: sem prazo de
  suspensão e sem exclusão automática, não visitar o suspenso quer dizer guardar a trilha,
  a conversa e os anexos dele para sempre. A varredura de anexos responde à mesma pergunta
  com laço próprio sobre `tenants`, e não com `forEveryTenant`, porque ela precisa da
  contagem de quem **poderia** ser dono dos arquivos legados — outra pergunta, que o
  arquivo explica ao lado. O `forSoleTenant` **não tem mais nenhum
  chamador** e fica como mecanismo para o próximo job cuja query motriz ainda não seja
  escopada.
- **`backend/src/config/tenantCache.js`** — `TenantCache`, uma entrada por provedor, com
  `invalidate()` (este provedor) separado de `clear()` (todos).
- **Guarda estática** em `backend/test/tenant-scoping.test.js`, que varre `backend/src` e
  falha ao encontrar handle cru numa tabela escopada sem a marcação de isenção.

#### O que a Fase 1 entregou além do previsto

Escopar as tabelas expôs bugs que já estavam em produção com **um** provedor, e que o plano
original não previa:

- **Mensagem de WhatsApp entrante descartada em silêncio** por colisão de `external_id`.
- **Opt-out de um provedor silenciando o número de outro** para a mesma pessoa.
- **Evento SGP do segundo provedor descartado como duplicata** — `dedupe_key` era único no
  deploy e `insertIfNew` lê antes de inserir, então o webhook era respondido com sucesso e o
  evento nunca processado. Nada era registrado.
- **Contrato de um provedor gravado na conversa de outro**: `resolveSubscriber` buscava o
  vínculo pelo telefone em todo o deploy e `bindSubscriber` carimbava a thread com ele.
- **A guarda do "último admin" contava o deploy inteiro** — errada nas duas direções ao mesmo
  tempo.
- Um endpoint `/api/health` que perdia o diagnóstico por estar atrás do resolvedor.

#### O que faltava aqui, e o que entrou desde então

- **A Fase 3 entrou.** `backend/src/middleware/tenantResolver.js` lê o provedor do `Host`
  quando o deployment configura `TENANT_BASE_DOMAIN`/`PORTAL_BASE_DOMAIN`, e cai no primeiro
  provedor da tabela só quando não configura nenhum — que é todo install self-hosted. A
  aposta do plano se confirmou: foi troca de uma função, porque tudo abaixo já lia o provedor
  do contexto.
- **A Fase 2 está completa.** A espinha (token com `tenantId`, papel vindo de `tenant_users`)
  entrou na onda 12; os quatro papéis com `requirePermission` e o convite por e-mail, depois;
  a personificação com audiência própria e o transporte de e-mail, no fecho da fase. A troca
  de `username` para e-mail entrou em três passos, sem dia de virada
  (`backend/src/config/login.js`). O plano de plataforma entrou na onda 13
  (`platform_admins`, o console e o `requirePlatformAdmin` que responde 404 com o corpo
  idêntico ao de rota inexistente).
- **Fases 5, 6 e 7 entregues.** Da **Fase 4** entrou o modo `direct` inteiro — fronteira do
  conector, credencial NBI, as três correções de SSRF, a guarda de egresso e o teto de
  concorrência. Depois vieram o modo `tunnel` (a rede privada de cliente liberada por
  provedor, em `tenant_genieacs_connections`) e o modo `agent` — o agente que o provedor
  instala na rede dele, com o instalador servido pelo próprio painel. Continua em aberto só o
  `hosted`.

### Decisões já tomadas

| Tema | Decisão |
| --- | --- |
| Isolamento | **Banco compartilhado + `tenant_id`** (pool model) |
| GenieACS | **Todos os modos**: URL+credenciais, agente conector, VPN/túnel e hospedagem própria → conector **plugável**, MVP com modo direto |
| Domínio | **Subdomínio por tenant** (`provedor.dominio` / `portal.provedor.dominio`) |
| Cobrança | **Planos e limites no código agora; gateway de pagamento depois** — fechado: o painel emite a cobrança e credita o pagamento sozinho, com periodicidade por plano |

### Licença

O upstream (`skydashnet/genieacs-panel`) é **MIT** — uso comercial é permitido, mas o
arquivo `LICENSE` e o aviso de copyright da SkydashNET devem ser mantidos no produto.

---

## Estado atual relevante

- **Backend**: Node ESM + Express 5 + **Knex 3**, sem ORM. Migrations em
  `backend/src/config/migrations.js`, aplicadas no boot por `ensureSchema()`
  (`backend/src/config/schema.js`), com ledger em `schema_migrations`.
- **Dois listeners no mesmo processo**: painel (`app`, 5890) e portal do assinante
  (`portalApp`, 5891) — `backend/src/app.js`, `backend/src/server.js`.
- **Banco**: SQLite padrão; MySQL e PostgreSQL suportados. A troca em runtime pela UI de
  Settings (`backend/src/services/dbManagementService.js`, `backend/src/routes/database.js`)
  existe **só na edição self-hosted** desde a Fase 0.
- **Acesso a dados**: 27 classes estáticas finas em `backend/src/models/*.js`, hoje sobre
  `tdb()`/`tinsert()` (`backend/src/config/database.js`). O `getDb()` cru sobrevive em 18
  pontos, todos justificados: `users` e `tenant_users`, que são do deploy, e a busca que
  descobre o provedor de um webhook. A aposta do plano original — de que os pontos de
  inserção do filtro seriam muitos mas ficariam todos num diretório — se confirmou.
- **GenieACS**: URL em `settings.genieAcsUrl` — que **já é por provedor**, porque
  `settings` é escopada. O conector plugável existe desde a Fase 4 e é a fronteira por onde
  todo acesso ao ACS passa (`backend/src/services/genieacs/connector.js`), hoje com um modo
  só. A tabela `tenant_genieacs_connections` foi **deliberadamente não construída** enquanto
  `mode` só puder valer `direct`: o porquê está escrito no cabeçalho daquele arquivo, e é o
  mesmo argumento de não criar coluna que nenhum código lê. A credencial NBI por provedor
  existe, cifrada (`backend/src/services/genieacsAuthService.js`) — o parágrafo antigo dizia
  que nenhum header de autenticação era enviado, e isso deixou de ser verdade na Fase 4.
- **Auth operador**: JWT bearer, `backend/src/middleware/auth.js`. Desde a onda 12 o
  payload carrega `tenantId` e o papel vem do **vínculo** em `tenant_users`, não de
  `users.role`. `authenticateToken` reabre o escopo no provedor que o token nomeia, depois
  de conferir a membership contra a tabela. Token antigo, sem `tenantId`, continua valendo
  quando a pessoa tem um vínculo só — a transição não derruba o plantão.
- **Resolução de provedor**: `backend/src/middleware/tenantResolver.js` roda antes das rotas
  e abre um escopo **provisório** lido do `Host`. É o escopo do que acontece sem sessão
  (login, setup, refresh, portal); uma requisição autenticada é reescopada por
  `authenticateToken` no provedor que o token nomeia, depois de conferir a membership. Onde o
  deployment não configura domínio base — todo self-hosted — o escopo provisório é o primeiro
  provedor da tabela, que ali é o único. Onde configura, host que não nomeia provedor é
  recusado em vez de servido: cair no primeiro seria responder com os dados de um provedor a
  quem não perguntou por nenhum.
- **Integrações que guardam segredos**: SGP, provisionamento automático e WhatsApp via
  Evolution API. Todas cifram com `secretBox`, e desde a Fase 0 registram a versão da chave.
- **Auth assinante**: cookie `skygp_portal_session`, `backend/src/middleware/portalAuth.js`.
  O login resolve por `customer_id` através de `CustomerAccount.getByCustomerId`, que passa
  por `tdb` — ou seja, já é escopado pelo provedor em contexto. O cookie **é host-only**:
  `portalCookieOptions` não emite `domain=`, então o navegador não o manda para o vizinho. E
  o payload assinado carrega `tenantId`, conferido contra o host antes de a conta ser lida —
  uma divergência é recusada. Prova em `backend/test/tenant-subdomain.test.js`.

### Achados críticos para o multi-tenant

O levantamento original listou oito. **Seis estão fechados**; o registro fica porque cada um
explica por que uma peça do mecanismo tem a forma que tem, e porque um deles pode voltar.

| # | Achado | Estado |
| --- | --- | --- |
| 1 | Cinco caches globais em memória, três deles com segredo decifrado | ✅ fechado — `TenantCache` e `Map` por provedor |
| 2 | Uniques globais virando colisão entre provedores | ✅ fechado — compostas, com teste de upgrade |
| 3 | Login do portal cruzando provedores | ✅ fechado — a busca passa por `tdb` |
| 4 | Sequestro de conta via `identity_hash` | ✅ fechado — `(tenant_id, identity_hash)` |
| 5 | `/api/database` apagando o banco de todos | ✅ fechado — só na edição self-hosted |
| 6 | `secretBox` derivando a chave do `JWT_SECRET` | ✅ fechado — `SECRET_BOX_KEY` + `key_version` |
| 7 | **Três buracos de SSRF no `deviceService`** | ✅ fechado na Fase 4 — branch de URL absoluta removido, corpo do erro truncado, redirect não seguido, mais a guarda de egresso com IP fixado |
| 8 | Obstáculos de schema para as uniques compostas | ✅ fechado ao longo da Fase 1 |

**O achado 7 foi fechado ANTES de a URL do ACS virar dado do cliente**, que era a ordem
não-negociável deste plano. `buildGenieAcsUrl` não existe mais: o endpoint é concatenado sob
a raiz configurada por `DirectConnector.urlFor`
(`backend/src/services/genieacs/direct.js`), que zera caminho, busca e fragmento da raiz e
recusa esquema fora de http(s). O corpo do erro upstream não volta mais ao cliente — vai
truncado para o log do processo, e o `Error` carrega só o status
(`backend/src/services/deviceService.js`). E nenhum redirecionamento é seguido, por
construção: o transporte com IP fixado usa `node:http`/`node:https`, que não seguem 3xx, e o
pino de DNS entrega ao socket os endereços já vetados, sem segunda resolução
(`backend/src/services/genieacsEgress.js`, `backend/src/utils/pinnedFetch.js`). As provas
estão em `backend/test/genieacs-ssrf.test.js`.

**O que sobrou dessa frente foi achado e fechado na leitura que limpou este documento:** a
guarda de egresso pendia só de `EDITION`, cujo default é `selfhosted`, então um deploy SaaS
sem essa linha no `.env` rodava com a tabela de faixas privadas **e** a allowlist de portas
desligadas. Hoje ela pergunta também à contagem de provedores. Ver o risco 4.

#### Duas garantias que são de construção, não de constraint

Estas duas valem registro porque **não** têm coluna que as sustente, e um `listAll()` novo
as quebraria em silêncio:

- **`customer_wifi_credentials`** era o exemplo original disso, e a decisão mudou: a tabela
  **ganhou `tenant_id`** no `0027`. A garantia por construção foi trocada por uma coluna, e
  foi a escolha certa — uma invariante que depende de ninguém escrever a query errada não é
  uma invariante.
- **`CustomerPortalController.overviewCache`** ainda é um `Map` chaveado só por
  `account.id`. É seguro porque `account.id` é surrogate de `customer_accounts`, que é
  escopada, então o id só chega ali por uma linha que o provedor em escopo já possui. É a
  mesma garantia que a tabela acima acabou de abandonar — vale reavaliar quando alguém mexer
  nesse controlador.

## Arquitetura alvo

```
                      ┌─────────────────────────────────────┐
  *.painel.dominio ──▶│  tenantResolver (Host → tenant)     │
  *.portal.dominio ──▶│  auth (JWT com tenantId)            │
                      │  subscriptionGate (na autenticação) │
                      │  tenantStore.run({tenantId}, ...)   │  ← AsyncLocalStorage
                      └──────────────┬──────────────────────┘
                                     │
                     ┌───────────────┴───────────────┐
                     │  tdb(table) → sempre filtrado │  ← models nunca chamam getDb() direto
                     └───────────────┬───────────────┘
                                     │
                       PostgreSQL (todos os tenants)
                                     │
                     ┌───────────────┴───────────────┐
                     │  GenieACS Connector (por tenant)│
                     │  direct | agent | tunnel | hosted│
                     └───────────────────────────────┘
```

Duas **edições** a partir de um só código, chaveadas por `EDITION=saas|selfhosted`:
a edição self-hosted preserva o instalador, o wizard de primeiro uso, o seletor de banco
e o GenieACS em rede privada; a edição SaaS desliga tudo isso.

---

## Fases

### Fase 0 — Fundação: banco do SaaS e segurança ✅ *(concluída)*

- **Migrations**: construídas em paralelo por outra frente, em
  `backend/src/config/migrations.js` — array ordenado de passos com id estável e `isApplied`
  para baselinear um install anterior ao runner. Este documento propunha o migrator do knex;
  o que existe é melhor e chegou primeiro.
- **PostgreSQL**, porque `RLS` é a única defesa estrutural real contra vazamento no modelo de
  banco compartilhado. Helper `insertReturningId` (`backend/src/config/database.js`) porque
  `const [id] = ...insert()` só devolve id em sqlite e mysql.
- **Suíte nos três dialetos no CI.** É o que impede a próxima migration de depender de algo
  que só um banco aceita — e foi o que revelou quatro defeitos que já estavam no repositório,
  incluindo uma FK entre coluna com e sem sinal que tornava **impossível criar um banco MySQL
  novo**.
- **`SECRET_BOX_KEY`** separada do `JWT_SECRET`, com a versão da chave gravada em cada
  segredo, para que rotacionar o segredo de sessão deixe de destruir os dados cifrados.
- **`EDITION`**, tirando o seletor de banco da edição hospedada.

**Os dois itens de segurança que esta fase antecipou, e por quê:**

- **`/api/database` desmontada na edição SaaS.** Pelo achado 5, essa rota apaga o banco
  inteiro antes de copiar. A flag entrou aqui e não na Fase 7 justamente para nunca existir
  uma janela em que a rota estivesse montada num deploy compartilhado. Hoje é um
  `if (IS_SELF_HOSTED)` em `backend/src/app.js`.
- **`SECRET_BOX_KEY` separada do `JWT_SECRET`**, com fallback para os installs existentes e
  `key_version` em todo conjunto de colunas cifradas. Antecipado porque adicionar a coluna
  depois seria uma retro-migration sobre dados já cifrados — impossível de fazer sem saber
  qual chave cifrou o quê, que é exatamente a informação que a coluna guarda.

**Breaking para self-hosted?** Não foi — a baseline adotou os installs existentes sem perda.

---

### Fase 1 — Modelo de tenant e scoping estrutural ✅ *(concluída)*

Era o coração do plano e foi. O que segue é **o que existe**, com as divergências em
relação ao previsto ditas onde houve.

#### O que foi entregue

- **`tenants`** e **`tenant_users`** existem. As outras tabelas que a Fase 1 previa
  (`tenant_invites`, `plans`, `subscriptions`, `platform_admins`, `audit_log`,
  `tenant_genieacs_connections`) **não** — elas pertencem às Fases 2, 4 e 5 e ficaram lá.
- **26 das 29 tabelas ganharam `tenant_id NOT NULL`**, com FK para `tenants` e as uniques
  refeitas em cima do par. As três de fora são `tenants`, `users` e `tenant_users`, e o
  porquê está na *Onda 12*, no fim deste documento.
- **Todas as uniques sobre valor que o painel não gera viraram compostas**:
  `customer_accounts` (`customer_id`, `device_id`, `identity_hash`), `device_profiles` e
  `sgp_links` (`device_id`), `sgp_events` (`dedupe_key`), `provisioning_profiles` e
  `wa_templates` (`name`), `mapping_nodes`/`mapping_edges`, `map_settings` (que deixou de
  ser singleton `id=1`). `settings` e `app_state` tiveram a PK trocada para
  `(tenant_id, key)`.
- **Catálogos** (`vendors`, `wifi_security_config`) foram pelo
  caminho previsto: `tenant_id NOT NULL` com cópia por provedor, e **não** pelo
  `tenant_id NULL` significando global. A invariante "toda linha de tabela de provedor tem
  `tenant_id`" sobreviveu inteira, e é ela que faz a guarda estática ser uma regra e não uma
  heurística.
- **Os cinco caches globais** viraram por provedor, e apareceu um sexto pelo caminho
  (`deviceHistoryService`). Quatro usam o `TenantCache`; o dashboard usa um `Map` porque
  precisa guardar também a promessa da atualização em voo — sem isso, o segundo provedor
  aguardava a atualização do primeiro e recebia o resultado dela.
- **`dbManagementService.COPY_TABLES`** passou a ser derivada de `SCHEMA_TABLES`, com teste
  que falha se deixar de cobrir o schema. Estava oito tabelas atrás quando foi escrita à mão.

#### O mecanismo, como ficou

Igual ao proposto em espírito, com três diferenças que valem registro:

1. **`tdb()` devolve um Proxy que lança em `.insert()`.** O plano descrevia `tdb` e `tinsert`
   como duas funções ao lado uma da outra; na prática, nada impedia alguém de escrever
   `tdb('x').insert(...)` — knex ignora `where` em insert e a linha entraria sem provedor,
   parecendo perfeitamente razoável. Fechar essa porta é a diferença entre um mecanismo e
   uma convenção.
2. **Não há tratamento especial de catálogo no `tdb`.** O `CATALOG_TABLES` com
   `orWhereNull` do rascunho desapareceu junto com a decisão de copiar o catálogo por
   provedor. Uma função, uma regra.
3. **`forEachTenant` e `forSoleTenant`** não estavam no plano e foram o achado mais útil da
   fase. Todo job de fundo perde o contexto de requisição, e a pergunta *"rodar uma vez por
   provedor divide o trabalho ou o repete?"* tem resposta diferente por job — e errar para o
   lado do "repete" significa, no caso do outbox de WhatsApp, **mandar a mesma mensagem N
   vezes para o telefone de um assinante real**. O `forSoleTenant` roda uma vez e **recusa**
   assim que existe um segundo provedor: uma fila que para é notada e consertada; uma fila
   que envia tudo em dobro é notada pelo cliente.

#### A migração do install existente

Foi feita em ~19 passos de migration em vez de um, e essa foi a decisão mais importante da
fase: **cada passo escopa um grupo pequeno de tabelas e entra sozinho**, com a tabela só
entrando em `SCOPED_TABLES` no mesmo commit em que o model passa por `tdb`. Antes disso a
tabela ficaria filtrada com escritas que não gravam `tenant_id`; depois, a conversão ficaria
sem o teste que a prova.

O `id` da migration é a chave do ledger, então **duas frentes não podem usar o mesmo
número** — aconteceu três vezes e o conserto é renumerar, barato mas obrigatório.

**A armadilha do SQLite era real e apareceu como previsto**: trocar um único global obriga o
knex a reconstruir a tabela, com os dados dentro. O que o plano *não* previa é que a suíte
de tenancy nunca passa por esse caminho — todas partem de um banco que o runner já terminou.
A cobertura dele vive em `backend/test/schema-migrations.test.js`, em blocos que rodam as
migrations pré-tenancy, plantam linhas e só então deixam o `ensureSchema` correr.

Uma armadilha que o plano não previa, e que custou caro: **um byte NUL literal num arquivo
fonte** faz o git classificá-lo como binário e descartar um dos lados num merge, em silêncio.

### Fase 2 — Autenticação, RBAC e gestão de equipe ✅ *(concluída)*

**Já existe** (onda 12): o payload do JWT carrega `tenantId` e o papel do vínculo em
`tenant_users`; `authenticateToken` lê a membership e reabre o escopo no provedor que o
token nomeia; `/api/users` opera sobre os vínculos do provedor que pediu, e a guarda do
"último admin" conta admins **daquele** provedor. A revogação continua sendo o
`token_version` na pessoa — trocar a senha derruba as sessões dela em todos os provedores,
que é o certo.

**Não é preciso, e vale dizer por quê:** o plano pedia um `membershipVersion` no
token para revogar um vínculo sem derrubar as outras sessões da pessoa.
`hydrateAuthenticatedUser` lê `tenant_users` **a cada requisição autenticada**, então a
própria linha é a revogação — tirar alguém da equipe mata a sessão dela naquele provedor
na requisição seguinte, e uma troca de papel morde na mesma hora. Um contador seria cópia
em cache de um fato que já é lido fresco: estritamente mais fraco, e mais uma coisa para
alguém esquecer de incrementar. Coberto por
`backend/test/auth-tenancy.test.js`, "a session open when the membership ends".

**Entrou (ondas 17 e 18):**
- ✅ **Papéis reais**: `owner`, `admin`, `tech`, `viewer`, e `requireRole` virou
  `requirePermission` com **24 capacidades** numa matriz só
  (`backend/src/config/permissions.js`). A regra que fixou o recorte: nenhuma rota fica
  alcançável por quem não a alcança hoje — o `viewer` recebe exatamente o conjunto que
  antes não pedia papel nenhum, e o `tech` é papel novo, então nenhum install perde acesso
  na migração. `owner` e `admin` carregam as mesmas capacidades: a diferença é quem mexe no
  papel de quem, e essa regra vive no controlador de operadores, nas TRÊS portas — promover,
  rebaixar e encerrar o vínculo (a terceira ficou de fora na primeira escrita e foi achada
  na revisão: um `admin` não podia rebaixar o dono, mas podia apagar a membership dele).
- ✅ **Convite** (`tenant_invites`): quem administra oferece o vínculo, e quem entra é a
  pessoa convidada — com a conta que já tem, provando quem é com a senha que já usa, ou com
  uma nova cuja senha o administrador nunca vê. É o que a onda 12 não conseguia fazer.
  **Por link e não por e-mail**: o painel não tem transporte de correio nenhum, e prometer
  um envio que não acontece é pior que entregar o link na mão. O transporte entra depois,
  sem mudar nada do que está feito.

**Entrou (o fecho da fase):**

- ✅ **Personificação auditada, com audiência própria.** Quem opera o SaaS abre uma sessão
  no painel de um cliente para atendê-lo. O token é OUTRO — audiência
  `skygenpanel-platform` —, e ser outro é o ponto: um `if` esquecido em algum lugar trata a
  personificação como sessão comum, mas uma audiência errada não passa pelo `jwt.verify`.
  Cada audiência tem uma forma válida e só uma; o par cruzado é recusado. Meia hora, fixa,
  e sem refresh: continuar custa uma volta ao console, que é mais uma linha na trilha.
  - **Ela lê e não escreve.** O papel `viewer` imposto na hidratação já barraria quase
    tudo, e quase não basta: a matriz pode crescer, e uma rota nova que esqueça o
    `requirePermission` não é barrada por papel nenhum. O muro é por MÉTODO, acima de toda
    rota. O motivo é de produto antes de ser de segurança — uma escrita feita numa
    personificação aparece no painel do cliente como coisa que o cliente fez.
    `POST /api/auth/logout` é o caso que mostra o muro trabalhando: ele incrementa o
    `token_version` da pessoa, e a pessoa ali é quem personifica.
  - **O console não é alcançável de dentro dela**, mesmo sendo de quem o alcança: a
    requisição está re-escopada no provedor personificado, e uma rota do console rodando
    ali agiria sobre o cliente errado.
  - **O bilhete**, que é como a sessão chega ao navegador no host certo. Um JWT no query
    string entra em log de proxy e em histórico; um cookie no domínio-pai desfaz a garantia
    host-only desta mesma fase. O console cunha um valor opaco de uso único, um minuto,
    guardado como hash, e o entrega no FRAGMENTO da URL — a parte que nenhum navegador
    manda ao servidor. A tela no host do provedor o troca pelo token, que nasce no origin
    onde vai viver.
  - **Duas trilhas, duas perguntas**: `platform_audit` registra quem pediu para olhar o
    painel de quem, na cunhagem; o `audit_log` DO PROVEDOR registra que a sessão começou,
    no resgate. A segunda é a que um ISP faz, e ele não lê a nossa.
  - Morre sozinha quando quem a abriu sai do cadastro da plataforma ou troca a senha: as
    duas coisas são lidas a cada requisição, não quando o token foi feito.
- ✅ **Transporte de e-mail**, e com ele o convite deixa de depender de alguém copiar um
  link. Configurado por deploy (`SMTP_URL`, `MAIL_FROM`) e não por provedor: a mensagem vem
  do painel, e um SMTP por provedor seria uma credencial de terceiro guardada por nós para
  mandar mensagem em nome deles. O envio **nunca é condição de nada** — o endereço é
  conferido antes de o convite existir, o envio vem depois da trilha, e um SMTP fora do ar
  responde `emailed: false` com o link na mão.
  - O link dentro da mensagem precisa de endereço absoluto, e o backend só sabe um quando
    alguém lhe disse qual é: o domínio-base, ou `PUBLIC_BASE_URL`. O que ele **não** usa é
    o `Host` da requisição — quem cria o convite escolhe esse cabeçalho, e poderia fazer o
    painel mandar a um colega um link com o token verdadeiro apontando para um servidor
    dele.
  - A mensagem carrega quem convida, qual papel, até quando vale e o link. Nada além: uma
    caixa de entrada alheia não é lugar onde mora dado de provedor.
- ✅ **A tela de aceitar**, que faltava para o link que a API já dava, e **a tela de
  convidar**, que não existia — a API do convite estava sem interface desde a onda 18, de
  modo que quem administrava só tinha o formulário que escolhe a senha do outro. O token
  vai no fragmento nas duas pontas, pelo mesmo motivo do bilhete.

**Nada continua faltando aqui.** O **comando de re-cifra** da rotação da `SECRET_BOX_KEY`
era o último item desta lista e existe: `skygenpanel rotate-key`
(`backend/src/services/secretRotationService.js`). As duas chaves vivas já existiam —
`SECRET_BOX_KEY_PREVIOUS` e `JWT_SECRET_PREVIOUS` são lidas na entrada e nunca na escrita
(`backend/src/utils/secretBox.js`) —, e o que faltava era o passo que reescreve as linhas
antigas na chave nova. A **verificação do
endereço de e-mail** entrou junto com a redefinição de senha por e-mail, que era o dia em
que ela passava a ser pré-requisito — ver o item 10 dos riscos.

**Quebra para os self-hosted atuais:** o login sai de `username` para `email`.

A mitigação que este plano propunha — a migration preenchendo `email = username` quando
parecesse e-mail e `username@local.invalid` caso contrário — **não foi seguida**, e vale
dizer por quê, porque a ideia é sedutora: ela deixa a coluna `NOT NULL` de imediato e faz
todo mundo "já ter" um endereço.

Ela dá a cada conta existente um endereço que **ninguém controla**. Hoje isso não custa
nada, porque só a senha abre a conta. No dia em que existir redefinição de senha por e-mail
— e ela vai existir, é o que todo painel acaba tendo —, `fulano@local.invalid` é um domínio
que qualquer um pode registrar, e cada conta pré-preenchida vira um caminho para dentro
dela. Uma migração não tem como saber o endereço de ninguém, e inventar um é pior que
deixar nulo, porque um nulo se vê e um endereço plausível não.

**E o dia chegou** (migração `0039`): existe redefinição de senha por e-mail, e o alerta
acima virou a regra que a acompanha — `email_verified_at`, nula para todo mundo, inclusive
para os endereços já cadastrados. Só endereço PROVADO recebe redefinição, e cadastrar um
endereço não é prová-lo: a senha atual prova o controle da conta, não o do endereço. Um
carimbo de verificado dado de graça na migração seria exatamente o `fulano@local.invalid`
por outro nome.

**O que foi feito** (onda de login por e-mail): a coluna nasce **anulável e vazia**; toda
conta NOVA exige e-mail; o login aceita nome ou e-mail; quem já usava cadastra o próprio
endereço em `POST /api/auth/email`, provando a senha atual; e `LOGIN_REQUIRES_EMAIL=true`
desliga o nome quando o install quiser. `GET /api/auth/email-readiness` diz quantas contas
ainda ficariam de fora, para que virar a chave seja uma decisão e não uma aposta.

Nome e e-mail vivem no **mesmo espaço de nomes**: cadastrar um e-mail igual ao nome de
alguém, ou trocar o próprio nome para o e-mail de um colega, é recusado. Sem essa regra um
identificador casaria duas contas — e a consequência não recai sobre quem fez, e sim sobre a
vítima, que simplesmente deixa de conseguir entrar sem nada na tela explicando por quê.

---

### Fase 3 — Resolução de tenant por subdomínio ✅ *(entregue; foi uma função só)*

- Novo `backend/src/middleware/tenantResolver.js`, montado em `backend/src/app.js`
  **antes das rotas**, nos dois apps (`app` e `portalApp`):
  resolve o slug do header `Host` → carrega o tenant → 404 se não existir → guarda no
  `tenantStore`. Se o JWT também trouxer `tenantId` e ele **divergir** do host, retorna 403
  (impede trocar de tenant só reusando o token em outro subdomínio).
- Rotas públicas por host: `/api/tenant/public` devolve branding (nome, logo, cores) para a
  tela de login carregar já com a marca do provedor.
- Infra: DNS wildcard `*.painel.dominio` e `*.portal.dominio` + TLS wildcard.
  `CORS_ORIGINS` vira validação por padrão de host, não lista fixa
  (`isAllowedOrigin` em `backend/src/app.js`).
- Domínio próprio do provedor (`painel.provedor.com.br`) fica para depois: tabela
  `tenant_domains` + emissão automática de certificado.
- **Frontend praticamente não muda aqui**: `frontend/src/lib/api.ts` já usa base relativa
  (mesma origem), então o subdomínio resolve sozinho.

---

### Fase 4 — Conectividade GenieACS plugável ✅ *(entregue nos modos `direct`, `tunnel` e `agent`; só o `hosted` continua em aberto)*

Como você quer suportar os quatro modos, o certo é abstrair antes de implementar o segundo.

Nova tabela `tenant_genieacs_connections`: `tenant_id`, `mode`
(`direct`|`agent`|`tunnel`|`hosted`), `base_url`, `auth_type` (`none`|`basic`|`bearer`),
`username`, segredo cifrado com `createSecretBox('genieacs-nbi')`, `verify_tls`,
`allow_private_ranges` (só liberável por nós), `status`, `last_check_at`.

Novo módulo `backend/src/services/genieacs/` com a interface
`connector.fetch(collection, query, method, body)`; `DeviceService` deixa de montar URL e
passa a pedir o conector do tenant. Pontos exatos a refatorar em
`backend/src/services/deviceService.js`: `getGenieAcsUrl` (:112), `getGenieAcsRootUrl` (:117),
`getDevicesBaseUrl` (:144), `fetchGenieAcsCollection` (:148), `buildGenieAcsUrl` (:189),
`fetchFromGenieAcs` (:203) — mais `getVirtualParameters` (:133), que passa a ler do
`settings` já escopado.

**MVP — modo `direct`**, com endurecimento obrigatório (hoje inexistente):
- ✅ **Enviar `Authorization` (Basic/Bearer)** — entrou na onda 19
  (`backend/src/services/genieacsAuthService.js`), com `none` como padrão para nenhum
  install passar a mandar header de repente. Uma função só monta os headers das sete
  chamadas ao ACS, e uma varredura estática falha quando a oitava nascer sem credencial —
  a falha é silenciosa nas duas direções, e a rota que esquece é justamente a que ninguém
  pensou em cobrir. O botão de testar conexão só leva a credencial para a MESMA origem já
  salva: a URL vem no corpo do request, então mandá-la para qualquer endereço faria dele
  um jeito de LER o segredo.
- **Fechar os três buracos de SSRF já presentes** (achado 7): remover o branch de URL
  absoluta em `buildGenieAcsUrl` (:183), truncar/omitir o corpo do erro upstream devolvido ao
  cliente em `fetchGenieAcsCollection` (:158), e definir `redirect: 'manual'` rejeitando 3xx.
- **Guarda de egresso**: resolver o DNS nós mesmos, **bloquear faixas privadas, loopback,
  link-local, CGNAT e ULA IPv6**, e então conectar ao **IP resolvido e fixado** enviando o
  `Host` — só checar se o hostname "parece privado" não fecha DNS rebinding. Mais allowlist
  de portas e o timeout já existente (15s). Na edição self-hosted a faixa privada continua
  liberada (é o caso normal lá) — daí o flag por edição. A allowlist (80, 443, 7557, 8080)
  alarga-se por `GENIEACS_ALLOWED_PORTS`, e é variável de ambiente e não coluna de propósito:
  é o **deployment** dizendo em quais portas a própria rede tolera ser sondada, decisão que
  não cabe a quem sonda.
- Em produção, rotear todo o egresso ACS por um proxy/NAT dedicado sem acesso à nossa VPC.
  Além de defesa em profundidade, dá ao provedor um IP fixo para colocar em allowlist — o que
  é argumento de venda.
- Botão "testar conexão" já existe (`POST /api/settings/test-genieacs`) e passa a validar
  também credenciais e alcance.

**Muro de escala desta fase — ✅ fechado, nas quatro peças.** `refreshDashboardData` →
`getDashboardDevices()` busca a **coleção inteira de dispositivos** do GenieACS. Um provedor
com 20 mil ONTs já era um parse de vários MB por minuto; multiplicado por dezenas de tenants,
um processo Node não sustentava, e o limite estimado era o décimo tenant.

O que o derrubou não foi tornar a passagem mais rápida — foi **deixar de fazê-la**. As quatro
peças:
- ✅ **refresh agendado, com defasagem por provedor e cadência adaptativa** —
  `backend/src/services/dashboardSchedule.js` decide quem, quando e com que folga; o job vive
  em `SchedulerService.refreshDashboard`. Três decisões: a cadência segue a atenção (60s com
  operador da última hora, 5 min ocioso, e o prazo do cache acompanha — senão a primeira tela
  aberta desfazia, do caminho da requisição, a decisão que o job tinha acabado de tomar); a
  defasagem vem de um FNV-1a do id, então é estável entre reinícios e não precisa ser
  guardada; e a conta de "está na hora" é de **janela com fase**, não de prazo decorrido —
  com prazo, um provedor que atrasa dez segundos carrega o atraso e todos convergem de volta
  para a mesma virada de minuto, que é o pico que a defasagem existe para evitar. A marca de
  atenção é gravada no login e na renovação de token — os dois pontos em que se SABE que há
  alguém do outro lado — com folga de 5 min, e nunca derruba um login;
- ✅ **teto de concorrência de fetch ACS global e por provedor** —
  `backend/src/services/genieacs/concurrency.js`. As sete chamadas ao ACS em
  `deviceService.js` passam por `withAcsSlot`, que segura uma vaga do provedor e depois uma
  global, sempre nessa ordem (duas travas em ordens opostas é o deadlock clássico). O teto por
  provedor é o que isola; o global é o que limita sockets e heap. `GENIEACS_MAX_CONCURRENCY`
  (32) e `GENIEACS_MAX_CONCURRENCY_PER_TENANT` (6). Foi a primeira das quatro peças do muro;
- ✅ **não atualizar tenants suspensos nem sem login nas últimas 24h** — suspensos já estavam
  fora: `forEachTenant` visita só quem está `active`, e uma segunda checagem dizendo o mesmo
  seria a que ficaria para trás. O que faltava era a dormência, agora em `isDormant`, e ela
  vale também para o **prewarm do boot**: subir o processo era buscar a coleção de
  dispositivos de TODO provedor da instalação, dormente ou não — o pior minuto do dia, e o
  único em que ninguém está olhando para reclamar;
- ✅ **avaliada** a tabela `devices_summary` — e a decisão é **não construir agora**. Três
  achados, na ordem em que mudam a conclusão:
  1. **Sozinha, ela não economiza nada mensurável.** O que está em cache hoje é o *resumo*
     (`buildDashboardSummary`), não a lista de dispositivos: `getDashboardData` devolve
     `cache.data` e não recalcula nada por requisição. Ou seja, o custo por requisição já é
     zero. Uma tabela acrescentaria N escritas de linha por ciclo para poupar um agregado que
     ninguém recalcula.
  2. **A alavanca é o refresh incremental; a tabela é pré-requisito dele, não substituto.** O
     que continua caro é a varredura: ler a coleção inteira e fazer o parse de vários MB, por
     provedor ativo, por ciclo. Isso só cai lendo **apenas quem informou desde o último
     ciclo** — e aí os atributos de quem não informou precisam morar em algum lugar. Esse
     lugar é a tabela. Construí-la sem o incremental é pagar o custo e não colher o ganho.
  3. **O incremental tem um risco específico, que precisa ser desenhado e não presumido.**
     `$gte` sobre `_lastInform` já é usado pelo filtro online/offline da lista de dispositivos
     (`buildDeviceStatusQuery`), então o operador funciona nas instalações reais — o aviso em
     `provisioningService.findCandidates` é mais cauteloso do que a evidência exige. Mas a
     assimetria que ele aponta continua de pé, e é ela que importa aqui: na lista, um filtro
     que devolve vazio é **visível** (o operador filtra "online", vê nada e reclama); num job
     de fundo, um delta vazio é indistinguível de uma frota quieta, e o painel mostraria uma
     foto congelada com cara de saudável. Um incremental honesto precisa, portanto, de uma
     **reconciliação completa periódica** para limitar a deriva — e é isso que torna o desenho
     não-trivial, não a tabela.

  **Quando revisitar:** quando um único provedor, sozinho, tornar um ciclo caro. O que tirou a
  urgência foi a peça anterior desta mesma lista: o multiplicador que assustava (*todo*
  provedor, *todo* minuto) já não existe — dormentes não são varridos e ociosos são varridos a
  cada 5 min. O custo que sobra é O(frota) por provedor ativo, e ele escala com o tamanho de
  um cliente, não com o número deles.

**Os outros modos** (mesma interface, sem reescrever o `DeviceService`):
- ✅ `agent`: agente instalado no provedor abre WebSocket **de saída** para o SaaS; o conector
  multiplexa requisição/resposta por cima. Nada exposto na internet — é o modo mais seguro e
  o que eu recomendaria como padrão comercial. Entregue com o hub em
  `/api/genieacs-agent/connect`, o programa em `backend/agent/skygenpanel-agent.mjs` (um
  arquivo, sem dependências) e o instalador `deploy/install-agent.sh`, que o painel serve em
  `/api/genieacs-agent/install.sh` junto com o programa — os dois na versão do próprio
  painel. A chave (`sgpa_…`) é guardada só como hash e nunca passa por argv na máquina do
  provedor. **Limite conhecido:** a conexão do agente vive no processo, então o deploy com
  agentes roda com UMA réplica do painel até existir roteamento por provedor. Operação em
  `saas-operations.md` §12.
- ✅ `tunnel`: WireGuard/Cloudflare Tunnel — reutiliza o conector `direct` com
  `allow_private_ranges` ligado. Custo é operacional (setup manual por cliente), não de código.
- `hosted`: nós provisionamos o GenieACS; o conector `direct` aponta para a nossa rede interna.

---

### Fase 5 — Planos, limites e ciclo de vida da assinatura ✅ *(entregue; o gateway emite e recebe)*

Três tabelas (migration `0035`), uma porta, quatro pontos de escrita e a metade comercial do
console. O que a fase NÃO fez é tão importante quanto o que fez, e está escrito na migração:
**nenhum provedor existente muda** — todos recebem `active` num plano `unlimited` sem limite
algum, porque um upgrade não pode ser o dia em que um ISP em produção descobre que está
bloqueado. Quem nasce depois, pelo console, nasce em `trial`.

**Schema.** `plans` é do deploy (é a tabela de preços; um provedor assina *o* plano `pro`, não
tem *o seu*); `subscriptions` é uma por provedor, escopada, com `plan_id` em RESTRICT — plano
com assinante se desativa, não se apaga; `billing_events` é o extrato, escopado, e é o que um
gateway alimenta por webhook pelo mesmo caminho do botão de hoje — e passou a alimentar
de verdade: `POST /api/billing-webhook`, migração `0045`, `AsaasBillingProvider`.

**A porta (`subscriptionGate`)**, chamada de dentro da autenticação e só na edição SaaS. Cinco
estados, uma regra cada, toda a política em `SubscriptionService.decide`:

| estado | passa? |
| --- | --- |
| `trial` | sim — e vira `past_due` sozinho quando o prazo vence, **calculado na leitura**, sem job: não há janela em que um teste vencido ainda passe porque o cron não rodou |
| `active` | sim |
| `past_due` | **só para ler** (GET/HEAD/OPTIONS). O portal do assinante fica inteiro de pé — o assinante não é quem deve — e os webhooks do ERP continuam entrando: recusar o evento do SGP por fatura atrasada perderia dado de quem não deve nada |
| `suspended` | 402 `subscription_suspended` |
| `canceled` | 402 `subscription_canceled` |

**Ela já ficou logo atrás do resolvedor, como `app.use`, e saiu de lá.** A razão de estar ali
era boa — a tela de bloqueio deveria aparecer também para quem ainda nem entrou —, mas nessa
posição a porta responde **antes do 401**: um `GET /api/devices` sem token nenhum devolvia 402
num provedor inadimplente e 401 num em dia, e o corpo do 402 ainda trazia o plano. Qualquer um
que alcance o host, e o host é público, varria e descobria quais ISPs estão atrasados na
fatura — inclusive pelo login do **portal**, que é a superfície mais exposta que existe aqui.

Isso é exatamente o que `tenantController.getPublicProfile` proíbe, com estas palavras: não
distinguir "não existe" de "existe e está suspenso", «um fato sobre o negócio de outra pessoa
que estaríamos publicando». A porta no lugar antigo violava a regra **de outro arquivo**, que é
como uma regra assim costuma cair.

Chamada de `authenticateToken` e de `authenticatePortalCustomer`, a ordem 401-antes-de-402
passa a ser garantida por construção, e o operador do provedor bloqueado continua vendo a placa
do muro: `/api/auth/*` está fora da porta, ele entra normalmente, e a primeira chamada
autenticada devolve o 402. O que se perde é mostrar o muro a um visitante deslogado — que é
precisamente a parte que vazava. Duas consequências registradas: a guarda `IS_SAAS` migrou para
dentro da porta (era o `if` que a montava, e sem ela um painel self-hosted passaria a exigir
assinatura de si mesmo), e os webhooks, que não têm sessão, passam a entrar sempre — recusar um
evento do ERP perde dado de quem não deve nada, e um 402 numa entrega anônima seria o mesmo
oráculo por outra porta.

O 402 leva o `code` e a própria assinatura no corpo, para a tela de bloqueio não ter que
perguntar de novo a uma rota que talvez também responda 402. O que fica **fora** da porta, com
o motivo de cada um escrito nela: `/api/auth/*` (entrar é como se vê o aviso, e como um
administrador da plataforma chega ao console), `/api/tenant/public` (o nome na tela),
`/api/tenant/subscription` (a placa do muro) e `/api/platform/*` (o console vive *acima* das
assinaturas; um provedor cancelado é justamente um que ele precisa alcançar).

`subscriptions.status = 'suspended'` e `tenants.status = 'suspended'` são **duas chaves**, de
propósito: a do provedor é operacional (para os jobs, recusa o webhook), a da assinatura é
comercial (o que o operador vê ao entrar). Uma inadimplência não precisa parar o alerta de ONT
caída, e uma parada operacional não é uma cobrança.

**Limites**, nos pontos de escrita, sempre contados do banco e nunca do cache (o limite existe
para o dia em que dois administradores criam ao mesmo tempo): criação de operador
(`/api/users`), aceite de convite (o convite **não** é consumido pela recusa — a pessoa volta
quando houver vaga), o console adicionando alguém (no escopo do provedor *alvo*, não do
administrador), e a sincronização de aparelhos — que cria contas **até o limite** e deixa o
resto para a próxima passada, sem lançar, porque a sincronização inteira não pode cair por
causa da conta que não coube; um aparelho que já tem conta e trocou de assinante não conta
contra o teto. Recusa é **402** com `code`, `limit` e `current`: quem pede *tem* permissão — é
o plano que não comporta. A contagem de ONTs vem do GenieACS e vira `null` quando o ACS não
responde, sem derrubar os outros dois números.

**Cobrança.** `BillingProvider` é a interface, e hoje tem duas implementações: o
`ManualBillingProvider`, que é nós marcarmos pago, e o do Asaas, que emite a cobrança e
recebe o pagamento. Um pagamento estende o período pelos dias do plano
(`plans.period_days`, com 30 de reserva para o plano que a coluna não alcançou) a partir do
fim atual (pagou adiantado) ou de hoje (pagou atrasado) e volta o status a `active`. Um
provedor `suspended` ou `canceled` **não** é reativado por pagamento: essas duas são
decisões de gente, e é gente que as desfaz. O webhook chama `recordPayment` e grava
`billing_events.provider = 'asaas'`.

**E o valor decide.** Um pagamento só estende o período quando cobre o que foi pedido — a
cobrança que o painel emitiu, quando ela existe, e o `price_cents` do plano quando não.
Pagar a mais credita (boleto atrasado chega com juros); pagar a menos entra no extrato
com a diferença dentro e **não** move `renews_at`. Plano de preço zero não confere nada,
que é o caso de todo provedor herdado. Até esta fatia o número que o pagamento carregava
era enfeite: qualquer valor comprava o período inteiro, e a única pista de que algo estava
errado era a conta bancária não bater.

**Console.** Planos (criar, editar limites/preço/teste, desativar; o `code` não muda — é o
que o extrato nomeia), a assinatura de cada provedor (trocar plano e mudar estado são dois
botões e duas linhas no extrato, de propósito: trocar o plano de quem está em `past_due` não
pode reativá-lo por acidente), registrar pagamento, e uso contra limite. Cada mudança grava
nas **duas** trilhas — `platform_audit` (o que nós fizemos) e o `audit_log` do provedor com
`actorKind: 'platform'` (o que aconteceu com ele, onde ele consegue olhar).

**Frontend, o mínimo que a fase exigia:** a coluna de plano e estado na lista do console, o
painel de plano por provedor, e a casca do app ouvindo o 402 — faixa no alto para `past_due`
(dá para ler), muro para `suspended`/`canceled` (com o nome do plano e a saída). A tela de
"plano e uso" do próprio provedor continua da Fase 6; a rota que a alimenta já existe.

---

### Fase 6 — Frontend ✅ *(entregue)*

**O que entrou:**

- `frontend/src/contexts/tenant-context.tsx`: carrega `/api/tenant/public` no boot e provê
  `{ tenant, name, isSaas, refresh }`. A rota passou a responder também `edition` e
  `panelBaseDomain`, que é o que a tela de login usa para decidir se mostra o link de
  cadastro e o que o cadastro usa para montar o endereço do painel novo.
- **Branding pelo contexto.** O nome do provedor deixou de ser `settings.appName` (um
  ajuste global, guardado no `localStorage` e propagado por evento) e passou a ser
  `tenants.name`, renomeado por `PATCH /api/tenant` (`settings.write`, auditado como
  `tenant.renamed`). A sidebar, o login, o setup, o título da aba e o campo "nome" das
  configurações leem e escrevem o contexto. A migration `0036_tenant_name_from_app_name`
  leva o nome que cada provedor já tinha em `settings` para a linha dele.
- **Cadastro** (`/signup`, `POST /api/auth/signup`): só na edição SaaS **e** só onde há
  domínio-base para o provedor responder — fora disso a rota é 404 e a tela redireciona
  para o login. Cria provedor + `owner` numa transação, semeia os padrões como o boot faz,
  registra em `platform_audit` com `via: 'signup'`, e devolve o endereço do painel. Passa
  pelo `authLimiter`. Slug reservado, tomado ou usuário tomado respondem 409 com mensagem
  traduzida; o `slugProblem` que o console já usava saiu para `backend/src/utils/slug.js`
  e serve aos dois.
- **Onboarding** (`/onboarding`): três passos — nome e centro do mapa, GenieACS e credencial
  NBI (com o teste de conexão), um primeiro colega como `tech`. É a mesma API das
  configurações em outra ordem, não um segundo caminho de escrita. O `OnboardingGate` leva
  para lá quem tem `settings.write` num provedor SaaS **sem** `genieAcsUrl`, uma vez; o
  "pular" fica lembrado por provedor no navegador.
- **Plano e uso** (`/plan`, `settings.read`, só no SaaS): a leitura de
  `/api/tenant/subscription` que a Fase 5 deixou pronta — plano, estado, datas, as três
  contagens contra os limites. Só leitura: mudar de plano continua com a plataforma.
- A seção de troca de banco das configurações **não aparece** na edição SaaS.
- **Resíduos do upstream indonésio resolvidos:** `<html lang="pt-BR">` nos dois HTMLs e o
  centro padrão do mapa em Brasília (`-15.7942, -47.8822`), que o onboarding deixa trocar
  no primeiro passo.
- i18n: as 44 chaves novas entraram nos **13 idiomas** do frontend (árabe e hindi chegaram
  pela `main` no meio da fase, e as chaves da Fase 5 e desta entraram neles junto) e as 8
  mensagens novas nos 13 do backend; a paridade e a unicidade continuam cobertas por
  `backend/test/i18n.test.js`. A lição registrada abaixo vale ainda.

**O que ficou de fora, de propósito:**

- Os dois itens que ficavam aqui — a tela de **aceitar convite** e o cadastro servido pelo
  host de um provedor — entraram depois: a tela no fecho da Fase 2
  (`frontend/src/pages/invite.tsx`, com o token no fragmento) e o **apex como porta de
  entrada** na Fase 7 (`PLATFORM_HOST_PATHS` em `backend/src/middleware/tenantResolver.js`,
  que reconhece também o `www.`).
- `frontend/src/pages/setup.tsx` continua existindo nas duas edições porque é o caminho
  de "instalação sem nenhum usuário"; no SaaS ele nunca aparece porque o cadastro já nasce
  com o `owner`.

**Lição que fica:** o tipo em `dictionary.ts` faz o `npm run typecheck` acusar a chave que
faltar, mas **não** pega a chave declarada **duas vezes** — o literal fica com a última, o
conjunto de chaves continua batendo e o teste de paridade passa. Isso aconteceu quatro
vezes, sempre por dois branches acrescentando as mesmas chaves; em duas delas as cópias
divergiam na redação. É para isso que existe o teste "declara cada chave exatamente uma
vez" em `backend/test/i18n.test.js`, e ele varre as duas metades do app.

---

### Fase 7 — Operação e as duas edições ✅ *(entregue; o runbook é `docs/saas-operations.md`)*

**O que entrou:**

- **`EDITION`** já decidia cadastro, troca de banco, faixas privadas do conector e o
  console; continua decidindo. O assistente de instalação fica nas duas edições de
  propósito: no SaaS ele é como o primeiro `owner` do `default` — e o primeiro
  `platform_admins` — nasce num deploy vazio.
- **Banco pelo ambiente.** `DATABASE_URL` (`postgres://…?schema=&sslmode=`, ou `mysql://`)
  vence o `db-config.json` quando os dois existem: uma imagem contra um Postgres
  gerenciado não pode ser apontada para o banco errado por um volume velho. O arquivo
  continua sendo o mecanismo do self-hosted, onde a tela de troca de banco o escreve.
- **Deploy do SaaS.** `deploy/docker-compose.saas.yml` (imagem + Postgres ao lado, para
  homologação; em produção o `db` sai e a URL aponta para fora), `deploy/saas.env.example`
  com cada variável comentada, `.dockerignore`, e o job `image` no CI, que constrói a
  imagem e a sobe até `/api/health` responder — o `Dockerfile` não era exercitado em
  lugar nenhum. As migrations rodam no boot e são idempotentes; deploy é `up -d --build`.
- **O provedor em toda linha de log.** `backend/src/utils/logger.js`: uma linha por evento
  (`text` logfmt ou `json`), `tenant=` lido do mesmo contexto que as queries leem, uma
  linha `http` por requisição (método, caminho sem query, status, ms, host, `req=` que
  volta em `X-Request-Id`), `/api/health` calado enquanto responde 200. Os ~250
  `console.*` que já existiam **não foram reescritos**: o boot envolve os cinco métodos
  do `console` uma vez, e cada linha antiga sai com `[tenant=N]` quando há contexto —
  jobs de fundo inclusive, porque rodam por provedor.
- **O provedor em toda métrica.** `backend/src/utils/metrics.js`: contadores em memória,
  `tenant_id` em toda série, sem biblioteca. `http_requests_total` (provedor, método,
  classe de status — o caminho **não** é rótulo), `http_request_duration_ms` (baldes
  grossos por provedor) e `acs_requests_total` (provedor, `ok`/`refused`/`error`, contado
  em `GenieAcsEgress.fetch`). `GET /api/platform/metrics` em formato Prometheus, atrás
  do guarda do console **ou** de `METRICS_TOKEN` comparado em tempo constante — um
  coletor não tem sessão.
- **O host apex é a porta de entrada.** `painel.exemplo.com` (e `www.`) deixa de ser 404
  para exatamente duas rotas: `GET /api/tenant/public` (que responde `slug: null` e a
  edição) e `POST /api/auth/signup`. Nada de provedor nenhum é servido ali; nenhum
  contexto de provedor é aberto, então uma query escopada que chegasse por engano falha
  com a sentinela. O cadastro sai do host do provedor `default`, que era a porta de um
  cliente servindo de porta da plataforma. A tela de login de um provedor aponta para
  `https://<base>/signup`; no apex, `/login` leva ao cadastro.
- **Backup e procedimento** no runbook: `pg_dump` diário com teste de restauração
  mensal, snapshot do volume de anexos, os três segredos no cofre; por provedor,
  exportação (`GET /api/tenant/export`) e exclusão em dois passos, já existentes;
  suspensão, rotação de segredos e o que ainda não existe.

  **E agendado, não só escrito:** o install passou a instalar e ligar
  `skygenpanel-backup.timer` — diário, `Persistent=true` para a máquina desligada
  recuperar o dia, com o dump do dialeto que o install realmente usa, o `tar.gz` dos
  anexos e um manifesto. O `.env` fica de fora; o que vai junto é a **impressão digital**
  de `SECRET_BOX_KEY` e `JWT_SECRET`, porque `secretBox.decrypt` devolve `null` em vez de
  levantar — um restore com a chave errada sobe um painel que responde 200 com todo
  segredo lido como nulo, e a impressão digital é o que transforma essa descoberta num
  aviso antes do restore em vez de um susto durante.

**Esta lista ficou vazia.** Os dois últimos itens saíram na mesma semana, por caminhos
independentes: o **gateway de cobrança** passou a ter as duas metades — o painel emite
(migração 0047, `billing_charges`) e credita por webhook (runbook, seção 10) — e o **comando
de re-cifra** da rotação da `SECRET_BOX_KEY` existe como `skygenpanel rotate-key`, documentado
no runbook na seção de trocar segredos. A personificação e o transporte de e-mail já tinham
entrado no fecho da Fase 2.

---

### Fase 8 — Provar o isolamento ✅ *(a lista de portas está contada; o RLS entrou, desligado por padrão)*

Nada vai para dois provedores reais antes disto passar. **Passa.**

#### O que existe

A suíte não ficou num arquivo só, e ficou melhor assim: `backend/test/tenant-leak.test.js`
guarda os casos que atravessam recursos, e **14 suítes `*-tenancy`** cobrem uma tabela ou um
subsistema cada — `sgp-links`, `sgp-events`, `device-profiles`, `provisioning`,
`map-settings`, `vendor-catalogue`, `wifi-credentials`, `whatsapp-media`,
`whatsapp-inbound`, `users`, `auth`, entre outras, mais `tenant-subdomain` e
`tenant-id-sweep`, que provam o isolamento por host, e `role-reach`, que prova por HTTP o
alcance de cada papel sobre uma amostra de 31 rotas. São 1797 testes no total, verdes nos
três dialetos no CI.

O padrão em todas: **dois provedores com as chaves naturais deliberadamente colidindo** —
mesmo `customer_id`, mesmo `device_id`, mesmo `identity_hash`, mesmo `dedupe_key`, mesmo
nome de perfil — e então a asserção de que nenhum enxerga ou altera a linha do outro.

E uma disciplina que não estava no plano e passou a valer para toda fatia: **um teste de
vazamento só conta depois de ter sido visto falhar**, com a sua tabela fora da allowlist.
Ela pegou pelo menos dois testes que passavam pelo motivo errado — um porque a tabela ainda
estava escopada naquela rodada, outro porque a falha do teste anterior o mascarava. E pegou
também a versão errada da própria disciplina: reverter *por coluna* em vez de *por passo de
migration* reverte a migration errada quando duas derrubam um único com o mesmo nome de
coluna, e o teste "falha" provando nada.

#### O "flake" da suíte, resolvido

A suíte carregava havia meses um vermelho intermitente no CI, sempre num arquivo sem relação
com o que estava sendo mudado, e sempre resolvido por re-rodar. Já tinham sido descartadas as
suspeitas óbvias: interferência entre arquivos pelo banco (o harness cria um schema/database
por arquivo), `describe` assíncrono (não existe nenhum) e esgotamento de conexões (medido: 5
conexões de pico com e sem limite no pool). Rodando a suíte cinco vezes seguidas com o log
inteiro guardado, **eram duas causas, nenhuma delas de infraestrutura**:

1. **Um teste dependente do relógio.** `device-history` gravava uma leitura em
   `Date.now() - 60_000` e afirmava que o rollup deixava a hora corrente em paz. Rodando no
   primeiro minuto de uma hora, um minuto atrás é a hora ANTERIOR, que já fechou — o rollup a
   agrupa e o teste falha. Um minuto em cada sessenta: ~1,7% das rodadas.
2. **Uma porta fixa sem tratamento de erro.** `genieacs-egress` é o único arquivo da suíte que
   precisa de porta fixa (a edição SaaS só deixa o egresso sair por 80, 443, 7557 e 8080, então
   `listen(0)` daria uma porta que o próprio guarda recusaria). O `listen` não tinha
   `once('error')`, então um `EADDRINUSE` deixava a Promise **nunca resolver**: o `before`
   pendurava, o event loop esvaziava, e o runner cancelava o arquivo com "Promise resolution is
   still pending but the event loop has already resolved" — mensagem que não nomeia porta,
   arquivo nem causa. Era isso que produzia a cascata de "cancelled" que parecia aleatória.

A lição que fica: **"cancelled" nunca é a falha, é o rastro dela.** A causa está no topo do log
do job, num `before` — e um `before` que pendura em vez de falhar é o que torna esse topo
inútil. Todo `listen` de porta fixa precisa de `once('error', reject)`.

Os testes estruturais existem em `backend/test/tenant-scoping.test.js`: a guarda estática
que varre `backend/src` atrás de handle cru numa tabela escopada, a exigência de que toda
tabela do schema esteja classificada como escopada ou compartilhada, e a marcação
`tenant-scope-exempt` obrigatória para as poucas exceções legítimas.

#### A lista de portas, agora contada

O que faltava não era uma prova a mais: era **saber quantas portas existem** e exigir que
nenhuma fique sem resposta. Uma suíte de vazamento prova que uma porta está fechada; nenhuma
delas percebe a porta que ninguém lembrou de listar — e o vazamento que este projeto viu de
perto não foi um controlador escrito errado, foi um controlador novo copiado do vizinho.

`backend/test/route-coverage.test.js` lê o inventário das rotas dos dois listeners
(`backend/test/helpers/routeInventory.js`, que analisa `app.js` e os arquivos de rota, porque
o Express 5 guarda o prefixo de um roteador montado como função e não há o que ler de volta) e
faz quatro contas:

1. **Toda rota sem guarda de sessão está declarada, com o motivo escrito.** São 12 hoje: as
   quatro de entrada, o cadastro, o perfil público, os dois do token de convite, os dois
   webhooks, a mídia por token assinado e o login do portal. Uma rota nova sem sessão reprova
   o CI.
2. **Toda rota endereçada por parâmetro tem prova nomeada.** As 78 estão declaradas: 37 na
   varredura, e 41 com o motivo escrito de por que a varredura não serve — id de aparelho no
   GenieACS (20), chave natural que os dois provedores têm igual (7), anexo por token
   assinado (2), token de convite (2) e o plano de controle (10). O teto de 41 **só pode
   cair**: declarar motivo é mais fácil do que escrever caso, e sem o teto o caminho fácil
   não custaria nada.
3. **Nenhuma declaração sobrou de rota que sumiu**, dos dois lados — uma tabela que só cresce
   vira decoração —, e todo arquivo de teste citado num motivo existe de verdade.
4. **A ordem das montagens em `app.js`**: o resolvedor de provedor vem antes de todo roteador
   (as duas exceções são as entregas de fora, e estão fixadas pelo nome), a porta da
   assinatura vem logo depois dele nos dois listeners, e a troca de banco e o console
   continuam cada um dentro da sua edição. Um roteador montado uma linha acima do resolvedor
   atende sem provedor em escopo, que é exatamente o que o comentário do `/api/tenant` no
   `app.js` descreve.

A varredura de ids cresceu de 24 para **37 rotas** com as que faltavam: o mapa da planta
(pontos e cabos, GET/PUT/DELETE), a revogação de convite, a caixa de entrada do WhatsApp
(mensagens da conversa, fechar a conversa, escrever nela), o reenfileiramento de uma mensagem,
o cadastro de segurança WiFi de um fabricante e a exclusão de uma conta do WhatsApp. A lista de
casos saiu para `backend/test/helpers/idSweepCases.js` porque agora dois testes a leem — quem
chama as rotas e quem confere que ela chama todas.

Três coisas que a extensão obrigou a acertar, e que valem como registro:

- **O id do vizinho tem que ser do vizinho.** Semeei os pontos do mapa com o mesmo `node_id`
  nos dois provedores, e a varredura acusou o contrário do esperado: o "id do alfa" respondia
  200 porque era também o id do beta. A colisão de chave natural é outra prova, e é da suíte
  de vazamento; esta suíte precisa de um id que só um dos dois tenha.
- **Nem toda recusa é 404.** `POST /api/whatsapp/messages/:id/requeue` responde 409 ao vizinho
  — a rota não distingue "não existe" de "não dá para reenfileirar", e a leitura por baixo é
  escopada. O caso ganhou um status esperado próprio em vez de um 404 forçado no controlador.
- **Um motivo escrito é uma dívida.** A declaração de
  `PUT /api/whatsapp/subscribers/:contract/phone` dizia "prova em `tenant-leak.test.js`" — e
  não havia. O contrato é do SGP e os dois provedores podem ter o mesmo número; a prova entrou
  junto: corrigir o telefone do contrato 4242 de um não pode mudar o do 4242 do outro, que é o
  tipo de erro que só aparece no disparo de cobrança seguinte.

#### RLS no Postgres: implementado, desligado por padrão

Era o último item em aberto. Medido num Postgres 16 de verdade, com política
`USING (tenant_id = current_setting('app.tenant_id')::int)`:

| O que se mediu | Resultado |
| --- | --- |
| Sem a variável marcada, lendo como papel comum | **0 linhas** — falha fechando, que é a direção certa |
| `SET LOCAL` dentro de transação | escopa certo e some no commit |
| INSERT com `tenant_id` de outro provedor | recusado pela política |
| UPDATE atravessando provedor | 0 linhas tocadas |
| Lendo como **dono** da tabela | **vê tudo** — sem `FORCE ROW LEVEL SECURITY` o dono passa por cima |

E a medição que decide: com o pool do knex em uma conexão, uma "requisição" que marca
`SET app.tenant_id = '1'` deixa a marca **na conexão**, e a requisição seguinte, que não
marcou nada, lê `'1'`. Numa aplicação que emite consulta fora de transação — que é esta —
a variável de sessão não é uma defesa, é um vazamento com outro nome: a próxima requisição a
pegar aquela conexão emprestada herda o provedor da anterior.

Então RLS só entra numa das duas formas, e as duas custam:

1. **Transação por requisição**, abrindo com `SET LOCAL app.tenant_id`. É a forma correta e a
   única segura com pool. Custa manter uma transação aberta pela vida inteira de cada
   requisição — inclusive das que só leem, inclusive das que esperam o GenieACS responder.
2. **Uma conexão por provedor**, o que troca o pool por N pools e amarra o número de
   provedores ao número de conexões do banco.

**Atualização: implementado, e desligado por padrão** — `backend/src/config/rls.js`,
`RLS_ENABLED=true`, prova em `backend/test/rls-postgres.test.js` (11 casos que só rodam no
Postgres). Três coisas que a medição anterior não tinha visto:

1. **Havia uma terceira forma**, e é a que entrou: transação por **consulta**, não por
   requisição. Ela não sofre a objeção levantada contra a primeira — não segura transação
   aberta enquanto a requisição espera o GenieACS. Custo medido: 0,258 → 0,649 ms por
   consulta, **+152%**.
2. **As duas formas mais baratas não funcionam, e pelo mesmo motivo**: o contexto do
   `AsyncLocalStorage` **não sobrevive** à execução dentro do knex. Marcar a variável na
   aquisição da conexão ou na execução da consulta foi tentado contra um Postgres de verdade
   — o gancho roda, mas `store.getStore()` ali já não vê o provedor de quem pediu, porque o
   pool resolve fora do contexto do chamador. É por isso que `tdb()` funciona: ele lê o
   provedor na CONSTRUÇÃO, de forma síncrona. A marca do RLS tem que viajar igual.
3. **A linha "lendo como dono: vê tudo" estava incompleta, e de um jeito perigoso.** Não é só
   falta de `FORCE`: um **superusuário** (ou `BYPASSRLS`) ignora a política incondicionalmente,
   `FORCE` inclusive. Foi o que aconteceu na primeira medição desta onda — políticas
   aplicadas, nada reclamando, e cada provedor lendo as linhas de todos. Por isso o painel
   agora **se recusa a subir** com `RLS_ENABLED=true` num papel que passa por cima: um
   controle de segurança que responde "ligado" sem proteger é pior que nenhum, porque encerra
   a conversa.

Dois detalhes que custaram tentativa e valem para quem reescrever a política: ela usa `CASE`
e não `OR`/`AND` porque o Postgres **não garante ordem de avaliação** nesses dois — o cast
para `int` era avaliado mesmo com o outro lado já decidido, e a consulta morria com
`invalid input syntax for type integer`. E o `WITH CHECK` repete o `USING` como
documentação, não como proteção: omitido, o Postgres usa o `USING` também na escrita.

A decisão de **manter desligado** segue de pé, e o motivo é comparativo: as duas linhas que já existem —
`tdb()` com o filtro obrigatório e a sentinela de SQL que lança em teste ao ver tabela
escopada sem filtro — cobrem o mesmo erro (consulta sem provedor) no lugar onde ele é
escrito, e não custam nada em produção. RLS pegaria o caso que elas não pegam: SQL cru rodando
fora do processo, ou um bug do próprio knex. É defesa em profundidade real, e o preço dela
hoje é uma mudança no modelo de transação de toda a aplicação.

O que faria mudar de ideia, escrito para quem for reavaliar: o dia em que a aplicação já
estiver dentro de uma transação por requisição por outro motivo, ou o dia em que houver um
segundo processo (relatórios, exportação em lote) falando com o mesmo banco sem passar pelo
`tdb()`. A receita fica pronta: papel de aplicação separado do dono das tabelas,
`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` (com `FORCE`, se o papel for o dono), a política
acima em cada uma das tabelas escopadas, e `SET LOCAL` no `runInTenant`.

#### Os três itens que dependiam do subdomínio — fechados

Os itens 5, 6 e 2 da lista original esperavam a Fase 3. Com ela no lugar, os três existem:

- **Cookie de portal de A replayado no host de B** — `backend/test/tenant-subdomain.test.js`.
  Três asserções, não uma: o cookie recusado no portal do outro provedor, o mesmo cookie
  ainda válido no seu, e a ausência de `domain=` no `Set-Cookie` — que é o que impede o
  navegador de mandá-lo para o subdomínio vizinho antes de qualquer verificação. A quarta
  põe a requisição onde a leitura escopada *funcionaria* (rodando como A, com a requisição
  dizendo ser de B) para que o provedor assinado no payload possa ser visto fazendo alguma
  coisa: sem isso as duas primeiras passariam com ou sem `tenantId` assinado.
- **Token de operador de A enviado ao host de B** — mesmo arquivo: 403 `tenant_mismatch`,
  nas duas direções, com o controle de que o token funciona no host para o qual foi cunhado.
  403 e não 404 aqui de propósito: quem manda o token já sabe que o provedor existe, porque
  o host resolveu antes de a rota rodar.
- **`GET /:id` com id de B respondendo 404 e não 403** —
  `backend/test/tenant-id-sweep.test.js`, e varrido sobre **as 24 rotas do painel
  endereçadas por id de linha**, não sobre uma. A prova anterior cobria duas
  (`portal-password` e `users`); a diferença não é de quantidade, é que cada rota tem seu
  próprio caminho até o banco e é a rota acrescentada depois — copiando o controlador
  vizinho — que vaza. Cada caso roda duas vezes com o mesmo token, o mesmo host e o mesmo
  corpo, mudando só o id: com o id do vizinho tem que dar 404 e a linha do vizinho tem que
  continuar intacta; com o id próprio tem que dar qualquer coisa menos 404. Sem a segunda
  metade o arquivo passaria inteiro com as rotas desmontadas — e passou, na primeira
  rodada, em quatro casos cujo caminho eu tinha escrito errado.

Tirando o `where` de `tdb()`, 22 dos 24 ficam vermelhos. Os dois que não são os de
`/api/users/:id`, e estão certos: `users` é tabela do deploy, e quem responde 404 ali é a
leitura do vínculo em `tenant_users`, outro mecanismo, com prova própria em
`users-tenancy.test.js`.

- **A sentinela de SQL** em `APP_ENV=test` entrou (`backend/src/config/sqlSentinel.js`):
  toda query que toca tabela escopada sem filtro de provedor lança, com o `from:` do call
  site no erro. Ela é a segunda linha e apareceu como tal — na reversão acima ela sozinha
  derruba o seed antes de qualquer rota rodar, e foi preciso desarmá-la também para ver as
  asserções falharem.

## Riscos principais

Dos dez originais, cinco foram fechados pela Fase 1. Ficam registrados porque explicam
decisões de desenho, e porque o primeiro **não se fecha, só se contém**.

1. **Uma leitura cruzada silenciosa.** Continua sendo o risco que encerra o negócio, e o
   mecanismo o contém em vez de o eliminar: `currentTenantId()` lança fora de escopo, a
   guarda estática recusa handle cru, e as 14 suítes de tenancy provam por tabela. O caminho
   mais provável nunca foi um `WHERE` esquecido — foi cache estático e job de fundo, e foi
   exatamente ali que os problemas apareceram. **Contido, não resolvido.**
2. ~~Sequestro de conta por `identity_hash`~~ — ✅ fechado, unique composta.
3. ~~`/api/database` num deploy compartilhado~~ — ✅ fechado, rota só na edição self-hosted.
4. **Conectividade GenieACS** — continua sendo a maior objeção de venda ("preciso abrir a
   7557 pra internet?"), mas **deixou de ser a maior superfície aberta**: os três buracos de
   SSRF do achado 7 foram fechados e a guarda de egresso com IP fixado entrou **antes** de a
   URL virar dado do cliente, que era a ordem não-negociável. O que resta do risco é de
   produto — só o modo `direct` existe, e ele exige que o ACS do provedor esteja alcançável.

   **Uma ponta de segurança foi achada na leitura que limpou este documento, e fechada junto
   com ela:** a guarda de egresso inteira — a tabela de faixas privadas e a allowlist de
   portas — era aplicada só quando `EDITION=saas`, e o default de `EDITION` é `selfhosted`.
   Um deploy SaaS que subisse sem essa variável rodava com as duas desligadas, e nada no
   processo percebia: o painel funciona, os testes passam, e a única diferença é que um
   endereço de metadados de nuvem volta a ser destino válido, salvável por qualquer admin de
   provedor. O repositório já tinha reconhecido esse modo de falha no outro portão —
   `assertSoleProvider()` em `backend/src/services/dbManagementService.js` decide pela
   **contagem de provedores**, não pelo `.env` — e a correção não tinha sido trazida para cá.
   Agora foi: `deploymentIsShared()` em `backend/src/services/genieacsEgress.js` aplica a
   guarda quando `IS_SAAS` **ou** quando há mais de um provedor na tabela, com o "sim"
   grudento — uma vez que o processo viu dois, não desaprende — e falhando fechado se a
   contagem estourar. Prova em `backend/test/egress-guard-shared-deploy.test.js`, escrita
   com a variável AUSENTE, que é onde ela importa.
5. ~~`JWT_SECRET` como chave de cifra de tudo~~ — ✅ fechado, `SECRET_BOX_KEY` + `key_version`.
6. ~~**O muro de escala do dashboard**~~ — ✅ fechado, nas quatro peças. Escopar o job por
   provedor tinha **multiplicado** o número de passagens em vez de reduzir o trabalho, e o
   limite estimado era de 15–25 provedores. O que o afastou não foi otimizar a passagem, foi
   deixar de fazê-la: dormentes não são varridos, ociosos são varridos a cada 5 min, o teto de
   concorrência limita o que corre junto, e a defasagem por provedor tira o pico da virada de
   minuto. O custo que resta é O(frota) por provedor **ativo** — escala com o tamanho de um
   cliente, não com o número deles. A `devices_summary` foi avaliada e recusada por ora; o
   porquê está na Fase 4.
7. ~~A migration de rebuild no SQLite~~ — ✅ fechado, e coberto por teste que planta linhas
   antes de rodar as migrations.
8. ~~**A troca de `username` para e-mail**~~ — ✅ fechada sem dia de virada: a coluna é
   anulável, o login aceita nome **ou** e-mail, e `LOGIN_REQUIRES_EMAIL=true` desliga o nome
   quando o install decidir. `GET /api/auth/email-readiness` diz quantas contas ficariam de
   fora antes de alguém virar a chave. A nota de release continua valendo para quem virar.
9. **LGPD** — **metade fechada.** O banco guarda CPF/CNPJ em `sgp_links.document`, payload
   de eventos SGP com dado pessoal, credenciais PPPoE e senhas de WiFi recuperáveis em
   claro, de assinantes de terceiros. Somos **operador**, o provedor é **controlador**.

   O que passou a existir: o provedor tem os dois direitos do titular **por assinante**, na
   ficha do aparelho. `GET /api/customers/:accountId/export` (capacidade
   `customers.dossier`) monta o dossiê de uma pessoa reunindo o que está espalhado por
   dezessete tabelas — inclusive a telemetria da ONT anterior, que só existe sob o id
   trocado —, sem segredo nenhum, e diz no manifesto o que **não** está no arquivo.
   `DELETE /api/customers/:accountId` (capacidade `customers.erase`, separada) destrói os
   segredos e o que é conteúdo do titular, e esvazia sem destruir o que é registro do ISP:
   contrato, nó do mapa e trilha ficam, com a pessoa retirada deles. As duas rotas
   perguntam ao banco pela mesma função, para que a exclusão nunca alcance menos do que o
   export acabou de mostrar. Ambas auditadas; na exclusão a trilha é **condição**.

   O que continua faltando, e não é código: contrato com cláusula de operador, política de
   retenção escrita e compromisso de notificação de incidente — **antes do primeiro
   contrato**. Mais duas coisas que o código não consegue cumprir sozinho e que a tela diz
   em voz alta: o CPF no ERP do ISP não é nosso para apagar, e uma exclusão sem
   cancelamento do serviço se desfaz na sincronização seguinte.
10. **Escopo escapando para hospedar o GenieACS** — inalterado. Manter fora até depois da
    Fase 7.

**Um risco novo, aprendido na Fase 1: duas frentes trabalhando no mesmo alvo.** A fatia de
SGP e provisionamento foi construída duas vezes, em paralelo, por duas sessões que não se
viam. Uma delas foi descartada inteira. Custou também três colisões de id de migration e
quatro consertos independentes do mesmo dicionário de idioma — em dois deles as cópias
divergiam na redação, e qual o operador via era decidido pela ordem em que os merges caíram.
O que barateia isso não é coordenação em tempo real, é **fatia pequena que entra rápido**:
quanto menos tempo um PR fica aberto, menos tempo ele tem para colidir.

## Dimensionamento

Os arquivos que concentram o trabalho **restante**, por tamanho atual:
`backend/src/services/deviceService.js` (Fase 4 — conector e as três correções de SSRF),
`frontend/src/pages/settings.tsx` (Fases 5/6/7),
`frontend/src/pages/customer-portal.tsx` (Fase 2),
`backend/src/middleware/tenantResolver.js` (Fase 3 ✅ — foi uma função só).

Os 27 models já estão convertidos; aquele trabalho, que era o volume da Fase 1, acabou.

## Ordem recomendada de entrega

Original: Fase 0 → 1 → 2 → 3 → 8 → 4 → 5 → 6 → 7.
**Percorrido:** 0 ✅ → 1 ✅ → 2 (espinha) → 8 (boa parte).

**Daqui em diante, e a ordem importa:**

1. ~~**Fase 3 — subdomínio.**~~ ✅ Entrou, e destravou o que se esperava: o resolvedor lê o
   host, o portal deixou de resolver o primeiro provedor, e os itens de vazamento que
   dependiam de host puderam enfim ser escritos.
2. ~~**O resto da Fase 2.**~~ ✅ Nada falta. Cookie host-only, `tenantId` no payload do
   portal, rate limit por provedor, os **papéis reais** com `requirePermission` e o
   **convite** entraram; a audiência separada `skygenpanel-platform` com personificação
   auditada entrou na onda 22, junto de `platform_audit`; e o **transporte de e-mail** do
   convite entrou no fecho da fase, com o `NullMailTransport` como caminho de produção de
   todo deploy sem SMTP. A troca
   de `username` para e-mail ✅ entrou, em três passos e sem dia de virada: a coluna é
   anulável, toda conta nova nasce com e-mail, o login aceita os dois, e
   `LOGIN_REQUIRES_EMAIL=true` desliga o nome quando o install decidir. O painel responde
   quantas contas ainda ficariam de fora, para que essa decisão seja tomada olhando um
   número em vez de na esperança.
3. ~~**Fechar a Fase 8**~~ ✅ com os três testes que passaram a ser possíveis e a sentinela
   de SQL. O **RLS no Postgres** ✅ entrou como segunda linha, desligado por padrão: o
   isolamento continua sendo `tdb()`, e o RLS é a rede embaixo dele, para o install que
   aceitar pagar os 152% medidos por consulta.
4. ~~**Fase 4 — conector.**~~ ✅ na ordem certa: as três correções de SSRF e a guarda de
   egresso com IP fixado entraram **antes** de a URL virar dado do cliente; depois a
   credencial NBI (onda 19) e o teto de concorrência. Depois, `mode` por provedor em
   `tenant_genieacs_connections`: `tunnel` (que absorveu o `allow_private_ranges` — liberar
   rede privada sem dizer por quê seria uma chave esquecida ligada) e `agent`, com o
   instalador servido pelo painel. Continuam em aberto o modo `hosted` e `verify_tls` por
   provedor. O muro de escala, esse, fechou nas quatro peças.
5. ~~**Fase 5**~~ ✅ planos, assinatura, `subscriptionGate`, limites nos quatro
   pontos de escrita, `billing_events` e o `ManualBillingProvider`. O gateway (Asaas)
   entrou pela metade que recebe: o webhook credita a assinatura sozinho, com a
   correlação em `tenants` e a credencial no ambiente. Emitir a cobrança continua manual,
   e é a metade que falta.
6. ~~**Fase 6**~~ ✅ contexto do provedor, nome em `tenants`, cadastro, onboarding, plano e
   uso, `<html lang>` e o centro do mapa.
7. ~~**Fase 7**~~ ✅ `DATABASE_URL`, compose e imagem no CI, log e métrica com o provedor
   em toda linha, host apex como porta de entrada, runbook.
8. ~~**Fase 8**~~ ✅ a lista de portas contada e obrigatória no CI, a varredura de ids em 37
   rotas, e o RLS avaliado com medição — e depois **implementado**, atrás de `RLS_ENABLED`,
   com a recusa de subir num papel que passa por cima da política.
9. ~~**O resto da Fase 2**~~ ✅ personificação auditada com audiência própria e bilhete de
   uso único, transporte de e-mail do convite, e as telas de convidar e de aceitar.
10. ~~**Redefinição de senha por e-mail**~~ ✅ e, junto com ela, a **verificação do endereço**
    que ela torna obrigatória — porque a partir dela existe um caminho que entrega o
    controle de uma conta a quem lê uma caixa de entrada. O pedido responde a mesma coisa
    exista a conta ou não; o bilhete serve uma vez, no host onde foi cunhado, e morre se o
    endereço mudar; concluir derruba toda sessão antiga. Todo endereço já cadastrado entra
    como NÃO verificado, de propósito: eles foram gravados exigindo a senha atual, o que
    prova o controle da conta e não o do endereço. → O que sobra: a rotação da
    `SECRET_BOX_KEY` com as duas chaves vivas.

Vale repetir o que o plano dizia e que se confirmou: a Fase 1 saiu para os installs
self-hosted como upgrade normal, e o código de tenancy rodou em produção real com um
provedor só antes de existir um segundo. As duas edições rodam **o mesmo caminho de código**
— self-hosted é um provedor único com resolução por host desligada. É o que impede as
edições de divergirem.

### Checklist antes de vender acesso ao segundo provedor

Nada disso é negociável. **Os doze estão cumpridos.**

| | Item | Estado |
| --- | --- | --- |
| 1 | Toda tabela de provedor: `tenant_id NOT NULL`, FK, uniques começando por `tenant_id` | ✅ |
| 2 | Nenhum código alcança tabela de provedor sem contexto (`currentTenantId()` lança, guarda estática no CI) | ✅ |
| 3 | Login e sessão do portal escopados por provedor | ✅ busca, cookie host-only e `tenantId` assinado no payload |
| 4 | Caches em memória e `app_state.dashboard_snapshot` separados por provedor | ✅ |
| 5 | JWT do operador e do assinante carregam o provedor e são conferidos contra o host | ✅ os dois carregam; divergência com o host é 403 `tenant_mismatch` |
| 6 | Credenciais ACS por provedor, cifradas, guarda de egresso, branch de URL absoluta removido | ✅ credencial NBI por provedor (onda 19), egresso com pinning de DNS, branch de URL absoluta removido |
| 7 | `/api/database` não montada na edição SaaS | ✅ |
| 8 | Rate limit e concorrência de fetch ACS chaveados por provedor | ✅ `tenantIpKey` no limite; `withAcsSlot` no fetch — vaga por provedor e vaga global, nessa ordem |
| 9 | Suíte de vazamento verde no CI e obrigatória para merge | ✅ 1797 testes, três dialetos |
| 10 | `SECRET_BOX_KEY` separada do `JWT_SECRET`, com `key_version` | ✅ |
| 11 | `audit_log` registrando ações sensíveis | ✅ onda 20 — senha de portal, GenieACS, papéis, vínculos, convites, suspensão |
| 12 | Exportação por provedor funcionando (LGPD e "apaguei tudo, socorro") | ✅ exportação (onda 21) e exclusão (onda 22), com trilha que sobrevive ao provedor apagado |

Nenhuma linha vermelha resta, e os dois itens que esta frase listava como pendentes — a
emissão da cobrança e o comando de re-cifra da `SECRET_BOX_KEY` — entraram. Isso **não** quer
dizer produto pronto;
quer dizer que a lista do que não se pode vender sem já não tem item aberto. O transporte de
e-mail do convite, que esta frase listava até hoje, entrou no fecho da Fase 2.

A exclusão entrou na onda 22, e o que a destravou foi `platform_audit`: apagar um provedor
tem que deixar registro, e registrar no `audit_log` DELE é inútil porque a trilha vai junto.
A tabela é compartilhada, guarda `tenant_id` como inteiro simples com o slug e o nome
desnormalizados, e **não tem chave estrangeira para `tenants`** — uma FK apagaria em cascata,
ou impediria, exatamente a linha que existe para dizer que aquele provedor foi apagado. É
também a tabela onde a personificação registra a cunhagem do bilhete — quem pediu para
olhar o painel de quem —, enquanto o `audit_log` do provedor registra o resgate.

## Verificação

```bash
npm run verify          # check backend + testes + lint + typecheck + build (raiz)
cd backend && npm test  # 1797 testes, incluindo as suítes de tenancy
```

A suíte roda nos três dialetos, e **isso não é zelo**: cada uma das armadilhas abaixo passou
em dois bancos e falhou no terceiro.

```bash
cd backend
TEST_DB_CLIENT=mysql2 TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=3306 \
  TEST_DB_USER=skygp TEST_DB_PASSWORD=skygp TEST_DB_NAME=skygp_test npm test
TEST_DB_CLIENT=pg TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=5432 \
  TEST_DB_USER=skygp TEST_DB_PASSWORD=skygp TEST_DB_NAME=skygp_test npm test
```

**Diferenças de dialeto que já custaram caro nesta fase**, todas em migration:

- **`onConflict` com o alvo errado é invisível no MySQL** e lança no SQLite e no Postgres.
  O MySQL ignora o alvo do `ON DUPLICATE KEY`, então um `onConflict('device_id')` que
  deveria ser `onConflict(['tenant_id','device_id'])` passa nos testes de MySQL enquanto
  mescla sobre a linha do provedor errado.
- **`.alter()` numa coluna que ainda está numa PK quebra no Postgres.** O knex emite
  `drop not null` incondicionalmente antes do retipo, e o Postgres recusa. Pior: o knex fixa
  a ordem — toda alteração de coluna sai antes de toda instrução de tabela —, então mover o
  `dropPrimary()` para cima no código não ajuda.
- **`timestamp` do MySQL não tem precisão de sub-segundo.** Um valor com milissegundos é
  arredondado na entrada, e comparar o valor original com o que volta os encontra diferentes
  — uma linha duplicada por passagem, para sempre, só naquele banco.
- **`DELETE ... LIMIT` não existe no Postgres**, e `date_trunc`/`DATE_FORMAT`/`strftime` são
  três coisas diferentes. Bucketização vai em JavaScript.

Validação end-to-end manual, agora possível — a automatizada equivalente está em
`tenant-subdomain.test.js` e `tenant-id-sweep.test.js`:

1. Subir com `EDITION=saas` e Postgres.
2. Criar dois provedores (`alfa`, `beta`).
3. Em cada um, criar operador, contas de assinante com **o mesmo `customer_id`** nos dois, e
   nós de mapa com o mesmo `node_id`.
4. Logar em `alfa.dominio`, copiar o token, e chamar `beta.dominio` com ele → 403.
5. Chamar todas as listagens em cada provedor → nenhum registro do outro.
6. Logar no portal `portal.alfa.dominio` com o `customer_id` compartilhado → autentica a
   conta do `alfa`, nunca a do `beta`.
7. Abrir o dashboard de `alfa`, depois o de `beta` → os números diferem.
8. Suspender a assinatura de `beta` → 402 no painel, portal ainda no ar.

## Onda 12 — `users` como identidade, `tenant_users` como ponte ✅ *(implementada)*

A última tabela por converter, e a única que **não** ganhou `tenant_id`. Entrou no
`0028_tenant_users`. O que segue são as decisões como foram tomadas e por quê — é a parte do
desenho que menos se explica sozinha lendo o código.

### Por que não `users.tenant_id`

Uma linha em `users` é uma **pessoa**. Um consultor ou revenda que atende
várias ISPs com um login só é o arranjo comum neste mercado, e uma coluna de
provedor em `users` fecha isso para sempre. Pior: as três chaves estrangeiras
que apontam para `users.id` — quem enviou a mensagem (`wa_messages.sent_by`),
quem revogou o opt-out, quem criou a campanha — continuariam apontando só para
o id. Com `tenant_id` em `users` e nada mais, nada no esquema impediria
registrar o operador do provedor A como remetente da mensagem do B.

`users` fica global e único por `username`. `tenant_users` diz quem trabalha
para quem, e com que papel lá.

### O papel é do vínculo, não da pessoa

Alguém pode ser admin na ISP que é dele e operador comum na que ele presta
serviço. `users.role` fica onde está e mantém o valor — é o que o backfill lê
e o que um install rodando o código anterior ainda usa —, mas deixa de ser
consultado assim que o token passa a carregar o papel do vínculo.

### O token nomeia o provedor

- O login resolve a pessoa por `username` (global), depois os vínculos dela.
  Com um vínculo, é esse. Com vários, o token carrega o escolhido.
- O token de acesso ganha `tenantId` e o papel **do vínculo**. O escopo da
  requisição autenticada passa a sair do token, não do "primeiro provedor" que
  o `resolveTenant` responde hoje.
- **Token sem `tenantId` continua valendo**, resolvido pelo vínculo único da
  pessoa. É a transição: derrubar toda sessão aberta num upgrade seria o painel
  deslogando o plantão inteiro sem motivo. Com mais de um vínculo e nenhum
  `tenantId`, recusa — aí a ambiguidade é real.
- `token_version` continua sendo a única revogação, e continua na pessoa: trocar
  a senha derruba as sessões dela em todos os provedores, que é o certo.

### `/api/users` passa a ser a equipe de um provedor

Hoje ele lista **todos os operadores do deploy** e aceita qualquer id global em
`update` e `remove`. Passa a operar sobre vínculos do provedor que pediu.

- Remover alguém é **encerrar o vínculo**, nunca apagar a pessoa: ela pode
  trabalhar para outro provedor, e o nome dela está em histórico que aponta para
  `users.id`.
- A guarda do "último admin" conta admins **do provedor**. Contando o deploy
  inteiro ela estava errada nas duas direções ao mesmo tempo: os admins de outra
  ISP impediam esta de remover o último dela, e o último desta podia sair com a
  contagem ainda positiva por causa da equipe de outra.
- Um id que não tem vínculo aqui responde como inexistente, nunca como proibido:
  a diferença conta a quem pergunta que a pessoa existe em outro lugar.

### O que NÃO entra nesta onda

O plano quer `users` chaveado por e-mail no lugar de `username`. Muda como todo
operador entra no painel, não traz isolamento nenhum, e feito junto com a espinha
de autenticação seriam duas mudanças arriscadas de uma vez. Passo próprio.

---

## Onda 13 — tornar a tenancy alcançável (decisões congeladas)

Doze ondas isolaram o painel por provedor, e **nada no painel cria um segundo
provedor**. Não é uma tela faltando: faltava uma autoridade. O administrador de
um provedor não pode cunhar provedores nem alcançar outro, então "quem pode"
precisava existir antes de "como".

### Quem tem a chave

`platform_admins` é criada **vazia**, e a migração não promove ninguém. Uma
migração que entregasse o plano de controle ao administrador de menor id seria
um upgrade promovendo alguém em silêncio — e na edição self-hosted, onde há um
provedor e nenhum plano de controle, promovendo a um papel que nem deveria
existir lá.

O bootstrap é explícito, das duas formas que fazem sentido:

- **Instalação nova em `EDITION=saas`**: o primeiro administrador criado pelo
  `setup` também vira administrador de plataforma. Sem isso, uma instalação SaaS
  nasce sem ninguém que possa criar o segundo provedor.
- **Instalação que já tem usuários**: `scripts/grant-platform-admin.js`, rodado
  por quem tem o servidor — que é exatamente quem deve estar decidindo isso. Há
  precedente no repositório: `scripts/reset-password.js`.

Com a tabela vazia, as rotas de plataforma são inúteis, e isso é o lado seguro
de falhar.

### As rotas são da edição SaaS

Montadas sob `IS_SAAS`, do mesmo jeito que a troca de banco é montada sob
`IS_SELF_HOSTED`. Numa instalação self-hosted elas não existem — não respondem
403, **não existem**, porque um 403 conta a quem perguntou que o plano de
controle está ali.

### O que a API faz, e o que ela não faz

- **Criar** provedor: `slug` e `name`. O slug é o subdomínio da Fase 3, único
  desde a origem.
- **Listar** e **suspender/reativar**. `tenants.status` já tem comportamento real
  em todo o painel: `forEachTenant` só visita `active` — é por ele que passam envio,
  alerta, reconciliação e cobrança — e o webhook do SGP não aceita entrega de suspenso.
  A retenção é a exceção, e de propósito: ela alcança todo provedor, o suspenso incluído,
  porque suspender muda quem trabalha e não o que se guarda de alguém. A rota dá o controle
  de algo que já vale.
- **NÃO apaga provedor.** As tabelas escopadas apontam para `tenants` sem
  cascata, então apagar um provedor com dado falharia na chave estrangeira — e
  se não falhasse seria pior. Suspender é a operação, e ela é reversível.

### Provedor criado em tempo de execução nasce igual a um do boot

`seedDefaults` roda no boot sobre todos os provedores: dá as configurações
padrão e, desde a onda 11, copia o catálogo de equipamentos para quem não tem.
Criar um provedor pela API **tem de passar pelo mesmo caminho**, ou o provedor
novo nasce sem configuração e com detecção de equipamento inerte — que não falha
alto, apenas não casa nada.

### Vincular alguém a um provedor é do plano de controle

A onda 12 recusou, de propósito, que o administrador de um provedor anexasse uma
pessoa que já existe: a criação carrega senha, e anexar resetaria o login de um
estranho e entregaria credenciais em outra ISP a partir de adivinhar um nome.

Um administrador de plataforma é outro nível de confiança — ele já pode criar
provedores. Então **é ele** quem vincula uma pessoa existente a um provedor, e
essa operação **nunca toca a senha**: ela cria o vínculo e nada mais.

---

## Onda 14 — provedor por subdomínio (decisões congeladas)

Hoje o token nomeia o provedor, mas o **endereço não**. Todo mundo chega pelo
mesmo host e o resolvedor sempre responde o primeiro provedor. É o que falta
para a tenancy valer na prática.

### A compatibilidade vem antes de tudo

**Sem domínio base configurado, nada muda.** Nenhum install self-hosted tem DNS
curinga, e o comportamento atual — o provedor próprio do install — continua
sendo a resposta. Essa garantia é absoluta: quem não configurar nada não pode
notar diferença nenhuma. É por isso que o domínio base é opt-in por ambiente e
não um padrão.

### Como o host vira provedor

- `PANEL_BASE_DOMAIN` e `PORTAL_BASE_DOMAIN`. Um host `alfa.painel.exemplo.com`
  com base `painel.exemplo.com` resolve o slug `alfa`.
- O slug é comparado como o DNS compara: sem diferenciar maiúsculas, e a porta
  do `Host` é descartada.

### O que acontece quando não resolve

Com domínio base configurado e um host que não nomeia provedor nenhum — sem
subdomínio, slug inexistente, ou **provedor suspenso** — a resposta é **404**,
a mesma para os três casos.

Distinguir "suspenso" de "nunca existiu" conta a quem perguntou quais slugs são
reais, e um slug é o nome de uma ISP. É o mesmo raciocínio que a onda 13 usou
para o plano de controle, e a onda 12 para uma linha que o chamador não pode
ver.

### Token que discorda do host: 403

Uma sessão válida do provedor A apontada para o subdomínio de B é **recusada
com 403**, não servida. Sem isso, trocar de provedor seria reusar o token em
outro endereço — e todo o trabalho das ondas 10 a 13 seria contornável por
edição de URL.

403 e não 404 aqui, ao contrário do caso acima, e o motivo é que não há o que
esconder: quem chegou até aqui já provou ter sessão, e o passo do host já teria
respondido 404 se B não existisse. Um 403 nesse ponto não conta nada que a
requisição anterior não tenha contado.

### O cache do resolvedor precisa morrer

O `cachedId` de hoje guarda **um** provedor num módulo. Com o host decidindo,
isso passa de otimização a defeito: o primeiro host a chegar decidiria o
provedor de todo mundo. O comentário atual do arquivo já avisa disso.

### Marca na tela de login: só o nome

`/api/tenant/public` devolve `slug` e `name` do provedor do host, e nada mais.
Logo e cores exigem colunas que `tenants` não tem e um caminho de upload;
ficam para uma onda própria, junto com `tenant_domains` e domínio próprio do
provedor. O que resolve hoje é a tela de login dizer o nome certo em vez do
nome do painel.

A rota é pública por necessidade — ela existe para ser lida antes de haver
sessão — então devolve exatamente esses dois campos e nada que sirva para
enumerar: um host que não resolve responde o mesmo 404 de qualquer outro.

### O que NÃO entra

- DNS curinga e TLS curinga são infraestrutura do lado de quem opera, não código.
- `CORS_ORIGINS` **não muda**: `isAllowedOrigin` já aceita uma origem cujo host
  é o host da própria requisição, que é exatamente o caso do subdomínio.
- Domínio próprio do provedor (`painel.provedor.com.br`) continua adiado.

---

## Onda 24 — o webhook do Evolution deixa de ser suposto ✅ *(implementada)*

O sintoma que abriu esta onda é uma tela: **"1 de 1 números conectados"** ao lado
de **"Nunca chegou nada"**. O painel conversava com o servidor Evolution sem
problema — era ele quem perguntava o estado da conexão e recebia resposta — e
nada voltava no sentido contrário.

### A causa: a URL era escrita uma vez e nunca mais lida

O webhook entrava **dentro do corpo do `POST /instance/create`** e acabava ali.
Não havia rota que o lesse de volta nem que o reescrevesse. Três caminhos
comuns deixavam o servidor e o painel divergindo, e nenhum deles dava erro em
lugar nenhum:

1. **A instância já existia no servidor.** O create responde *"already exists"*,
   `createAccount` cai no ramo que só recupera o id pela listagem — e o webhook
   do payload **nunca é escrito**. O número pareia, conecta e não entrega nada.
   É o caminho de quem aponta o painel para um Evolution que já estava rodando,
   que é o caso comum de quem já usava a API antes.
2. **Alguém mexeu no webhook pela interface do Evolution.**
3. **O `webhookBaseUrl` do painel mudou depois do pareamento** — mudança que não
   alcança instância nenhuma já criada.

### O que entrou

- `findWebhookRequest` / `setWebhookRequest` e o veredito **puro**
  `webhookVerdict`, em `utils/wa/evolutionApi.js`. Puro porque é a regra que
  decide o que o operador lê na tela, e uma regra dessas tem que poder ser
  travada em teste sem servidor nenhum.
- `inspectWebhook` e `reapplyWebhook` no serviço, com as rotas
  `GET`/`POST /api/whatsapp/accounts/:id/webhook`. **Conferir é leitura**
  (`whatsapp.read`) e **reescrever muda o servidor** (`whatsapp.config`): quem
  está de plantão descobre a causa sem ter a permissão que também cria e apaga
  número.
- A **trilha da recusa**: um evento que chega e leva 401 grava
  `webhook_refused_at` e o motivo. É o que separa *"o Evolution não está
  chamando"* de *"está chamando e sendo recusado"* — dois problemas com
  consertos opostos que, sem isto, eram a mesma frase vermelha na tela.

### Três decisões que valem escrever

**Um veredito por conserto.** `absent`, `url_mismatch`, `token_mismatch`,
`disabled`, `by_events`, `events_missing`, `unreachable`. Dois estados que se
consertam do mesmo jeito seriam um só — `absent` e `token_mismatch` levam à
mesma reescrita, mas quem lê "ausente" sabe que a instância já existia antes do
painel, e quem lê "token" sabe que o painel já escreveu ali um dia. Isso muda
para onde ir quando a reescrita **não** resolver.

**O conserto NÃO troca o token.** Trocá-lo abriria uma janela em que o painel já
espera o token novo e o servidor ainda manda o antigo: todo evento dessa janela
vira 401 — exatamente a falha que o conserto existe para acabar. Token novo só
quando não há nenhum guardado.

**Campo ausente conta como certo.** Versões antigas do v2 não devolvem `enabled`
nem `events`. Tratá-las como desligadas ou sem assinatura acusaria um servidor
são, e esse é o mais caro dos dois erros possíveis aqui: ele manda o operador
consertar o que não está quebrado, e o veredito perde o crédito no dia em que
estiver certo.

### O que NÃO entra

- **O Evolution GO fica sem conferência.** Lá o webhook vive em
  `instance.Webhook` e não existe rota que o devolva. O conserto (reescrever
  pelo `connect`) continua disponível e é idempotente; o que não se faz é
  responder `ok` sem ter lido — seria a mesma confiança cega que criou o
  problema. A tela diz `supported: false` em vez de inventar veredito.
- **Conferência automática no boot ou por relógio.** Ela custa uma volta ao
  servidor Evolution por número, e a tira de saúde já oferece a conferência
  exatamente quando ela importa: número conectado e nada tendo chegado nunca.

---

## Onda 25 — a volta, que é a leitura que faltava ✅ *(implementada)*

A onda 24 deu ao painel como perguntar ao servidor Evolution qual webhook ele
guarda. **O operador conferiu, o veredito respondeu `ok`, e nada chegou mesmo
assim.** O buraco estava no que aquele `ok` significa.

### Um diagnóstico que confirma como são uma instalação quebrada

`webhookVerdict` compara o que o servidor guarda com o que o painel **espera** —
e as duas pontas dessa comparação saem do mesmo `webhookBaseUrl`. Esse campo é
digitado à mão e conferido só na **forma**: absoluto, `http(s)`, sem credencial.
Ninguém confere que o caminho é o que o painel atende (`/api/whatsapp-webhook`),
nem que o endereço chega ao painel.

Com um endereço errado os dois lados concordam, porque são a mesma coisa. Três
jeitos de errar aquele campo, todos silenciosos e todos aprovados pela
comparação:

1. **Sem caminho nenhum** (`https://painel.exemplo.com`). O POST cai na raiz, o
   painel devolve o HTML do frontend com 200, e o Evolution registra entrega
   bem-sucedida. **O pior dos três**, porque tudo parece certo nas duas pontas.
2. **Caminho parecido e errado** (`/api/whatsapp/webhook`). 404 em toda entrega.
3. **O endereço certo atrás de um proxy** que recusa POST de fora.

Foi o erro de desenho da onda anterior, e ele é do tipo que encerra a conversa:
um controle que responde "ligado" sem proteger é pior que nenhum.

### O que entrou

**O painel se chama pela porta da frente.** `POST
/api/whatsapp/accounts/:id/webhook/probe` manda uma sonda para o próprio
endereço público — a URL completa, **com o token** — e lê a volta.

**O nonce é o que faz isso ser prova.** Sem ele, "200" seria a resposta tanto do
webhook quanto da página de login do frontend, que é o caso 1. O painel sorteia
16 bytes, manda, e só aceita a volta se o **mesmo valor** voltar. Uma página
HTML não contém o nonce; o webhook autenticado devolve-o.

**E ele volta só DEPOIS da autorização**, o que faz a volta provar duas coisas
de uma vez: que o endereço chega aqui, e que o token guardado é o que esta rota
aceita. `unauthorized` na volta tem um significado exato e útil — *este endereço
leva a outro painel*.

Sete vereditos, e cada um é um conserto diferente: `reached`, `wrong_target`,
`not_found`, `blocked`, `unauthorized`, `server_error`, `unreachable`.

### Três decisões

**Vai por `safeFetch`, não por `fetch`.** O endereço é digitado por quem
administra, e o mesmo guarda que protege a busca ao servidor Evolution vale
aqui — host revalidado a cada redirecionamento, prazo e teto de corpo. Sem ele,
o campo do webhook viraria um jeito de fazer o painel bater em endereço interno
e contar o resultado. A rota pede `whatsapp.config` pelo mesmo motivo: é a
permissão que já decide para qual servidor o painel fala.

**A falha de transporte não vira exceção.** O operador pediu um diagnóstico, e
"não deu para chegar" **é** o diagnóstico. Lançar trocaria a resposta útil por
um 502 genérico.

**A sonda não grava nada.** Uma linha no banco seria uma conversa falsa na caixa
do operador, e o diagnóstico passaria a sujar o que veio diagnosticar.

### Um erro que quase passou

`canonicalizarEvento` troca ponto por sublinhado, então comparar o evento
recebido com `'panel.probe'` **nunca casa**: a sonda cairia no caminho dos
eventos de verdade e a volta responderia `wrong_target` contra o próprio webhook
são — o diagnóstico mentindo sobre si mesmo. Daí `PROBE_EVENT_CANONICAL` existir
ao lado de `PROBE_EVENT`, com o motivo escrito.

### O que NÃO entra

- **Sonda automática.** Ela emite uma requisição de saída por número. Fica no
  botão e na tira de saúde, que já a oferece quando importa.
- **Conferir o `webhookBaseUrl` na hora de salvar.** Seria a mesma volta num
  momento pior: a configuração ainda não tem conta nenhuma pareada, e o token
  que autentica a volta nasce com a instância.

---

## Onda 26 — a tela pedia um host e o código exigia um caminho ✅ *(implementada)*

A volta da onda 25 respondeu, num painel em produção: **"o host está certo e o
caminho não."** Ela funcionou — e o que ela encontrou não era erro de quem
configurou.

### A tela e o código pediam coisas diferentes

O campo do webhook dizia, em três lugares, que queria um **host**:

- rótulo: *"URL pública do webhook"*;
- exemplo no campo: `https://painel.exemplo.com`, **sem caminho nenhum**;
- ajuda: *"o painel não tem como adivinhar o hostname do seu túnel ou proxy
  reverso"* — só sobre hostname.

E o código usava o que fosse digitado como o endereço **completo**, acrescentando
apenas `?t=`. A conferência era só de forma: absoluto, `http(s)`, sem credencial.

Quem seguia a tela gravava um endereço apontando para a **raiz** do painel. O
Evolution faz `POST` ali, o frontend responde **200 com HTML**, o servidor
registra entrega bem-sucedida — e nada chega nunca. Nem o veredito de
configuração pegava: as duas pontas da comparação dele saem desse mesmo campo.

### O que entrou

`config/waWebhookPath.js`, com uma constante e uma regra:

- **só a origem** (o que a tela pede) recebe o caminho do painel e vira um
  endereço que funciona;
- um caminho que **já termina** no do painel passa intacto — é o que mantém de
  pé quem serve o painel sob um prefixo (`/painel/api/whatsapp-webhook`);
- qualquer outro caminho é **recusado**, com o sufixo escrito na mensagem.

Recusar e não corrigir em silêncio: reescrever o que alguém digitou de propósito
quebraria quem roteia um caminho próprio para cá, e a recusa com o sufixo na
mensagem custa uma leitura.

E `app.js` passou a montar a rota **pela constante**, não por um literal: o
caminho atendido e o endereço conferido saem do mesmo lugar. A tela também foi
corrigida — exemplo e ajuda agora mostram o endereço inteiro.

### O inventário de rotas teve de aprender a constante

Ele lê `app.js` como **texto** e só reconhecia literais. Trocar o literal pela
constante o fez parar de ver a montagem do webhook — e um roteador que ele não
vê é um roteador público que ele não conta, que é o oposto do que ele existe
para fazer. Agora resolve a constante no módulo dela, e **lança** quando não
consegue: sumir em silêncio é o modo de falha que não pode existir aqui.
Conferido revertendo — uma montagem por constante acima do `resolveTenant`
derruba o caso.

### O que NÃO entra

- **Reescrever o valor já gravado nos installs.** Ele é consertado quando o
  operador edita e salva, e a volta é quem manda ele ir lá. Uma migração
  mexendo em configuração de produção pelas costas de quem opera é mais do que
  esta correção precisa.

## Onda 27 — a fronteira entre o console e a Configuração do provedor ✅ *(implementada)*

Na SaaS, a tela de Configuração do provedor deixava ele mexer em coisas que
são infraestrutura da plataforma: para onde o painel fala com o GenieACS (e
com que credencial), e o servidor Evolution do WhatsApp. Os **dados** já eram
separados por provedor (`settings` e `app_state` são escopados); o que faltava
era decidir **quem escreve o quê**. A regra mora em `config/platformManaged.js`
e vale só com `EDITION=saas`. A self-hosted não muda nada, porque ali o dono da
instalação é o próprio provedor e não existe console.

| Item | Console / caixa da plataforma (SaaS) | Configuração do provedor |
|---|---|---|
| Provedores, planos, admins, trilha, deploy | ✅ (já existia) | — |
| URL + credencial do GenieACS de cada provedor | ✅ console, botão **GenieACS** na linha do provedor | Só leitura: endereço, tipo de autenticação e "Testar conexão" (testa o **gravado**, ignora o corpo) |
| Servidor Evolution (URL, chave admin, hosts permitidos, webhook) | ✅ um só, na aba WhatsApp da **caixa da plataforma** | — |
| Números, mensagem de recusa de chamada, link do portal, envios por minuto, alertas | — | ✅ |
| Catálogo padrão (fabricantes + mapeamentos WiFi) | ✅ editado na caixa; **Enviar atualizações** na aba Catálogo padrão | A cópia é do provedor, editável, com **Restaurar padrão** por perfil |
| Tetos de retenção (trilha, mensagens, anexos) | ✅ no plano | Escolhe um valor ≤ teto |
| Nome, idioma, TR-069, portal, SGP, ativação, acesso da conta | — | ✅ |
| Banco de dados | — | Só na self-hosted |

### Como cada peça foi feita

- **GenieACS.**
  - Na SaaS, o provedor recebe `403 platform_managed` ao gravar `genieAcsUrl` (POST/PUT/DELETE em `/api/settings`) e em `PUT /settings/genieacs-auth`.
  - O console grava por `GET`/`PUT /api/platform/tenants/:id/genieacs` e testa por `POST …/genieacs/test`. As rotas rodam no `runInTenant` do alvo, então os dados continuam onde estavam.
  - Cada gravação deixa linha nas duas trilhas: `tenant.genieacs_changed` na nossa, `genieacs.*_changed` com `actor_kind = platform` na do provedor.
  - O teste de conexão virou `probeGenieAcs`, reaproveitado pelos dois lados.
- **Evolution.**
  - `whatsappConfigService` lê os quatro campos de servidor (`WA_SERVER_FIELDS`) do `app_state` da caixa quando o tenant é gerenciado.
  - Na gravação, o provedor tem esses campos ignorados. Os valores antigos dele ficam guardados, mas não são lidos.
  - Um provedor sem servidor da plataforma não cria número (`409 platform_server_missing`).
  - A caixa salvar limpa o cache de todos os provedores.
  - No primeiro boot com caixa, `adoptPlatformWhatsAppServer` copia para ela o servidor do provedor mais antigo que tinha um. Roda uma vez só, com marcador em `app_state`.
- **Catálogo.**
  - `propagateCatalogue` (em `config/seed.js`) insere o que falta, pela identidade `vendors.name` / `wifi_security_config.product_class`.
  - Só sobrescreve com `overwrite`, e nunca apaga.
  - A fonte tem de ser a caixa (`409` caso contrário): empurrar o catálogo de um cliente para os outros não é padrão nenhum.
  - `POST /api/vendor-management/:id/reset` e `…/wifi-security-configs/:id/reset` voltam uma linha ao padrão. Os dois estão na varredura de ids.
- **Retenção.**
  - Migração `0057_plan_retention_caps`: três colunas nulas em `plans`, e nulo é sem teto.
  - `SubscriptionService.capRetention` devolve o menor entre a escolha do provedor e o teto, e com teto "para sempre" (0) vira o teto.
  - É aplicado na poda da trilha e nas duas varreduras do WhatsApp, através do `getConfig`.
  - Gravar acima do teto responde `422 retention_above_cap`.

### O que ficou de fora de propósito

- **Tela nova no console para editar o catálogo ou o servidor Evolution.** Os dois são editados nas telas de Configuração da **caixa da plataforma**, que já existem. Uma segunda tela para escrever a mesma coisa é a que fica para trás.
- **Apagar o que o provedor tinha gravado** (URL do Evolution, chave). Deixou de ser lido, e apagar seria destruir sem pedido.
