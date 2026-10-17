# WhatsApp / Evolution API — contrato interno

Este documento congela as rotas, os payloads e os códigos de erro da integração
de WhatsApp. Ele existe porque a integração é construída em ondas e em paralelo:
quem escreve o backend de uma onda e quem escreve a tela da onda seguinte
programam contra este arquivo, não contra o código um do outro.

**Se uma onda precisar mudar algo aqui, muda aqui primeiro.** Uma divergência
silenciosa entre o que o servidor devolve e o que a tela espera é exatamente o
tipo de falha que não tem aparência.

Estado: **Ondas 0 a 3 implementadas no backend** — ciclo de vida das instâncias,
webhook de entrada, envio, modelos, não perturbe, cobrança, campanhas, alertas
técnicos, caixa de entrada e bot de autoatendimento. Cada seção abaixo é o
contrato da parte que ela nomeia. Nada aqui está pendente, nem rota nem tela: a
caixa de entrada do operador tem front-end desde `frontend/src/pages/whatsapp.tsx`,
com a lista de conversas, o fio aberto e o compositor em
`frontend/src/components/whatsapp/`.

---

## Forma geral

Todas as rotas do painel respondem no envelope do projeto:

```json
{ "success": true,  "message": "…", "data": … }
{ "success": false, "message": "…", "code": "host_not_allowed" }
```

`code` só aparece em erro e é a chave de máquina — a tela traduz por
`whatsapp.error.*` e nunca mostra o corpo cru da resposta do servidor Evolution.

Todas exigem `authenticateToken` + `requirePermission`, com a capacidade que
cada rota nomeia — `whatsapp.read` para ler, `whatsapp.send` para responder e
arquivar, `whatsapp.config` para mexer na instância e no webhook. A exceção é o
webhook de entrada, que é público e tem credencial própria.

> `requireRole(['admin'])`, que este contrato citava em cinco lugares, **não
> existe mais**: os quatro papéis substituíram o booleano de administrador, e a
> guarda passou a ser por capacidade (`backend/src/middleware/auth.js`). Um
> contrato congelado que cita um middleware removido é pior do que um contrato
> vago, porque outras frentes programam contra ele.

---

## Códigos de erro

| `code` | Significado | Chave i18n |
| --- | --- | --- |
| `not_configured` | integração desligada | `whatsapp.error.notConfigured` |
| `incomplete_config` | falta a URL do webhook | `whatsapp.error.incompleteConfig` |
| `invalid_webhook_url` | URL do webhook inválida | `whatsapp.error.invalidWebhookUrl` |
| `invalid_portal_url` | URL do portal do cliente inválida | `whatsapp.error.invalidPortalUrl` |
| `invalid_conversation_status` | conversa só é `open` ou `closed` | `whatsapp.error.invalidConversationStatus` |
| `subscriber_not_found` | contrato inexistente em `sgp_links` | `whatsapp.error.subscriberNotFound` |
| `template_mirrors` | modelo cita os dois espelhos de dias | `whatsapp.error.templateMirrors` |
| `invalid_base_url` | URL do Evolution inválida | `whatsapp.error.invalidBaseUrl` |
| `host_not_allowed` | fora da allowlist do admin | `whatsapp.error.hostNotAllowed` |
| `blocked_host` | endereço interno, barrado pelo guard SSRF | `whatsapp.error.blockedHost` |
| `unauthorized` | o Evolution recusou a credencial | `whatsapp.error.unauthorized` |
| `license_required` | licença do Evolution não ativada | `whatsapp.error.licenseRequired` |
| `meta_window_closed` | número oficial, cliente sem escrever há mais de 24 h e sem modelo aprovado | `whatsapp.error.metaWindowClosed` |
| `cloud_requires_v2` | API oficial pedida num servidor Evolution GO | `whatsapp.error.cloudRequiresV2` |
| `invalid_meta_credentials` | token, Phone Number ID ou WABA fora do formato | `whatsapp.error.invalidMetaCredentials` |
| `not_applicable_cloud` | QR, reinício ou desconexão num número oficial | `whatsapp.error.notApplicableCloud` |
| `not_supported_cloud` | consulta de números sem nenhum número por QR | `whatsapp.error.notSupportedCloud` |
| `invalid_cloud_callback_url` | URL de callback da Meta inválida | `whatsapp.error.invalidCloudCallbackUrl` |
| `meta_templates_cloud_only` | sincronizar modelos de um número por QR | `whatsapp.error.metaTemplatesCloudOnly` |
| `meta_template_unavailable` | modelo da Meta não aprovado, não suportado ou com parâmetro faltando | `whatsapp.error.metaTemplateUnavailable` |
| `meta_param_mismatch` | variáveis ligadas não batem com os parâmetros do modelo | `whatsapp.error.metaParamMismatch` |
| `timeout` / `unreachable` | o Evolution não respondeu | `whatsapp.error.timeout` / `…unreachable` |
| `no_session` | reiniciar sem sessão viva | `whatsapp.error.noSession` |
| `no_account` | nenhum número conectado | `whatsapp.error.noAccount` |
| `no_destination` | contato sem telefone nem LID | `whatsapp.error.noDestination` |
| `message_empty` | sem texto e sem anexo | `whatsapp.error.messageEmpty` |
| `conversation_not_found` | `:id` não existe | `common.routeNotFound` |
| `no_alert_recipients` | nenhum número de plantão para o alerta | `whatsapp.alerts.noRecipients` |
| `no_alert_number` | nenhum número conectado tem purpose `alerts` | `whatsapp.alerts.noAlertNumber` |
| `alerts_disabled` | alertas desligados; nada foi verificado | `whatsapp.alerts.disabledSkip` |
| `no_devices` | não deu para ler a frota; nada foi verificado | `whatsapp.alerts.noDevices` |
| `invalid_phone` | telefone de plantão que não dá para discar | `whatsapp.error.invalidPhone` |

---

## Configuração global — `/api/whatsapp/config`

`GET` devolve, e `PUT` aceita, este objeto. **Nenhum segredo sai daqui.**

```ts
{
  enabled: boolean
  allowedHosts: string[]        // PUT aceita string (uma por linha) ou array
  webhookBaseUrl: string        // absoluta, http(s), sem query nem credencial
  rejectCallMessage: string
  portalPublicUrl: string       // onde o portal do cliente responde, de fora
  rateLimitPerMin: number       // 1..120
  bulkIntervalMinSec: number    // 5..600, padrão 20 — ritmo das automáticas
  bulkIntervalMaxSec: number    // mínimo..600, padrão 45 (abaixo do mínimo vira o mínimo)
  bulkBurstSize: number         // 0..500, padrão 30; 0 desliga a pausa longa
  bulkBurstPauseMin: number     // 1..120, padrão 5
  managedUrl: string
  managed: boolean              // derivado: managedUrl preenchido
  managedAdminKeyConfigured: boolean
  ready: boolean
  updatedAt: string | null
}
```

`PUT` aceita também `managedAdminKey`. **Omitir mantém a chave guardada; `""`
apaga.** É a mesma regra do token do SGP, e a razão é a mesma: salvar o
formulário não pode revogar a integração sem querer.

Ativar (`enabled: true`) sem `webhookBaseUrl` responde `400 incomplete_config` —
sem webhook o servidor não devolve QR, mensagem nem recibo, e a integração
ficaria ligada e muda.

`portalPublicUrl` é um endereço próprio, não derivado. O portal do cliente é
outro app Express em outra porta (`portalApp`), então o endereço público do
painel só é o do portal quando um proxy reverso põe os dois atrás do mesmo
hostname. É a URL que o bot manda; vazia, ele passa para um atendente em vez de
mandar link que não abre. Passa pelas mesmas checagens de `webhookBaseUrl`
(absoluta, http(s), sem credencial) e devolve `400 invalid_public_url` quando
não passa.

---

## Números — `/api/whatsapp/accounts`

`GET /accounts` → array de:

```ts
{
  id: number
  name: string                  // nome da instância no servidor Evolution
  label: string | null
  purpose: 'general'|'billing'|'support'|'sales'|'alerts'
  flavor: 'go' | 'v2'           // detectado por sonda, nunca configurado à mão
  baseUrl: string
  status: 'pending'|'connecting'|'connected'|'disconnected'|'expired'
  qrCode: string | null         // data URI, rotaciona ~20 s
  qrUpdatedAt: string | null
  phoneE164: string | null
  isDefault: boolean
  lastSeenAt: string | null
  lastError: string | null
  createdAt: string | null
  updatedAt: string | null
}
```

O objeto é montado campo a campo no servidor
(`whatsappConfigService.publicAccount`). **Nunca devolva a linha do banco**: ela
carrega os dois segredos cifrados, e uma coluna acrescentada depois vazaria por
padrão.

### ✅ Onda 1 — ciclo de vida (implementado)

Serviço: `services/evolutionInstanceService.js`. Toda resposta de sucesso traz
`data.account` já passado por `publicAccount()`.

| Rota | Faz | `data` |
| --- | --- | --- |
| `POST /accounts` | cria a instância, assina o webhook e devolve o primeiro QR. Body: `{ baseUrl?, adminKey?, label?, purpose? }` — `baseUrl`/`adminKey` só no modo self-host. Responde `201` | `{ account, qr, pending }` |
| `GET /accounts/:id/qr` | busca um QR novo | `{ account, qr, pending }` |
| `GET /accounts/:id/status` | pergunta ao servidor e **promove** para `connected`; só rebaixa quem já estava conectado | `{ account, state }` |
| `POST /accounts/:id/restart` | `reconnect` (GO) / `restart` (v2). Sem sessão viva → `409 no_session` | `{ account }` |
| `POST /accounts/:id/disconnect` | logout; é o único jeito de forçar um QR novo | `{ account }` |
| `DELETE /accounts/:id` | logout + delete no servidor + remove a linha. Body opcional `{ adminKey }` no self-host | `{ removedOnServer, serverError }` |
| `PATCH /accounts/:id` | `{ label?, purpose?, isDefault? }` | `{ account }` |
| `POST /accounts/check-number` | `{ numbers: string[] }`, no máximo 100 | `[{ number, exists }]` |

O que o `POST /accounts` faz, na ordem — a sequência importa e cada passo já
custou um bug no sistema de origem:

1. sonda o sabor (`detectFlavor`) **antes** de montar qualquer payload;
2. cunha `name` (`skygp_<8 hex>_<base36>`), `instanceId`, o token da instância e
   o token do webhook;
3. cria a instância. Resposta com `already exists`/`already in use` **não é
   falha**: é o caminho de reconexão, e o id real vem da listagem;
4. **só no GO**, `POST /instance/connect` — é ele que grava o webhook e sobe o
   cliente. Sem essa chamada a instância existe e nunca conecta;
5. primeiro QR: o da resposta do create, ou uma leitura à parte.

`pending: true` com `qr: null` **não é erro**: o Evolution GO responde
`400 "no QR code available"` nos primeiros segundos, enquanto o cliente sobe. A
conta fica em `connecting` e a tela pede o QR de novo.

Se o create funciona mas a conexão ou o QR falham, a linha é gravada mesmo
assim, em `connecting` e com `lastError` preenchido: a instância já existe no
servidor, e a linha é a única alça que o painel terá sobre ela — sem ela não dá
nem para apagar.

`DELETE` remove a linha local **sempre**, e conta a verdade sobre o servidor em
`removedOnServer`/`serverError`. Recusar a remoção local porque um servidor que
talvez nem exista mais não confirmou deixaria o operador com uma linha
impossível de tirar; dizer que deu certo deixaria uma instância rodando sem ele
saber. No GO o delete é por id e com a chave global: sem uma das duas,
`serverError` explica qual faltou.

`GET /status` grava só quando `state === 'connected'` ou quando o servidor diz
`disconnected` para quem estava `connected`. A promoção é a saída de emergência
para um `connection_update` perdido, que deixaria um número pareado eternamente
em amarelo; a assimetria evita que um `disconnected` passageiro apague um
pareamento em andamento — quem ainda não conectou aparece como desconectado no
servidor o tempo todo em que o QR está na tela.

`purpose` fora da lista responde `400`. `isDefault: true` passa por
`setDefault()`, porque exatamente uma linha carrega a marca.

Além dos códigos da tabela lá em cima, estas rotas devolvem `account_not_found`
(`404`, id que não existe), `invalid_purpose` (`400`), `http_error` (`502`, com
as palavras do próprio servidor) e, quando falta credencial para a rota pedida,
`admin_key_missing` / `instance_token_missing` (`400`).

---

### API oficial (Meta) — integração `WHATSAPP-BUSINESS`

Além do número pareado por QR (Baileys), um número pode ser **oficial**: a
instância do Evolution v2 é criada com `integration: 'WHATSAPP-BUSINESS'` e
fala com a Graph API da Meta no lugar do Baileys. Só o v2 tem essa
integração; num servidor GO a criação responde `cloud_requires_v2`.

`POST /api/whatsapp/accounts` com:

```json
{ "kind": "cloud", "label": "Atendimento", "purpose": "support",
  "metaToken": "<token permanente da Meta>",
  "phoneNumberId": "<Phone Number ID>", "wabaId": "<ID da conta WABA>" }
```

O create enviado ao servidor:

```json
{ "instanceName": "skygp_…", "integration": "WHATSAPP-BUSINESS", "qrcode": false,
  "token": "<token da Meta>", "number": "<Phone Number ID>", "businessId": "<WABA>",
  "webhook": { "enabled": true, "url": "<webhook do painel>?t=…", "byEvents": false, "base64": true } }
```

- O **token da Meta é a chave da instância** (o servidor o adota como
  `apikey`), então ele é o que fica cifrado em `token_ciphertext`. Nunca sai
  para o navegador.
- `whatsapp_accounts.integration` = `cloud` (o padrão é `baileys`), com
  `meta_phone_number_id` e `meta_waba_id`. O `flavor` continua `v2`: ele é o
  dialeto do servidor, não do número.
- Sem QR e sem sessão: `GET /qr`, `POST /restart` e `POST /disconnect`
  respondem `409 not_applicable_cloud`; a remoção só apaga a instância.
- A consulta "este número tem WhatsApp?" usa um número por QR; sem nenhum,
  `409 not_supported_cloud`.

**Trocar o token.** `POST /api/whatsapp/accounts/:id/meta-token` com
`{ "metaToken": "<token novo>", "adminKey": "<chave global, só no self-host>" }`
(permissão `whatsapp.config`). O v2 não tem rota para trocar o token de uma
instância `WHATSAPP-BUSINESS` — nela o token é a `apikey` —, então o painel
apaga (`DELETE /instance/delete/<name>`, chave admin) e cria de novo com o
**mesmo** `instanceName`, os mesmos Phone Number ID e WABA ID e o **mesmo**
`?t=` no webhook: conversas, linha e URL do webhook não mudam. Um 404 no delete
é tolerado (é a retentativa depois de um create que falhou), então repetir a
ação é seguro. Qualquer falha grava `last_error` e a linha **nunca** é apagada;
o token antigo só é substituído depois do create aceito. Recusas, todas antes
de falar com o servidor quando possível: `409 not_cloud` (número QR),
`400 invalid_meta_credentials` (token fora do formato), `400 admin_key_missing`
(self-host sem chave); depois do delete, `409 cloud_instance_still_exists` se o
servidor ainda segura o nome (tentar de novo em segundos). No sucesso o estado
é conferido na Graph e os modelos aprovados são sincronizados de novo.

**Entrada.** A Meta não chama o painel: ela chama `<servidor Evolution>/webhook/meta`,
configurado pelo provedor no app dele na Meta, e o servidor repassa ao
webhook do painel no formato de sempre (`messages.upsert`, `messages.update`).
A configuração ganhou dois campos do servidor (`WA_SERVER_FIELDS`, ou seja,
da plataforma na SaaS):

| campo | o que é |
| --- | --- |
| `cloudCallbackUrl` | para onde a Meta chama. Vazio = `managedUrl` + `/webhook/meta` |
| `cloudVerifyToken` | o token que a Meta confere; igual ao `WA_BUSINESS_TOKEN_WEBHOOK` do Evolution. Cifrado no banco |

`GET /api/whatsapp/config` devolve `cloudWebhook: { callbackUrl, verifyToken }`
para a tela mostrar ao provedor com botão de copiar — o token de verificação só
confirma a assinatura do webhook, não envia nem lê mensagem.

No servidor Evolution: `WA_BUSINESS_TOKEN_WEBHOOK`, `WA_BUSINESS_URL=https://graph.facebook.com`,
`WA_BUSINESS_VERSION` e `WA_BUSINESS_LANGUAGE`, e `/webhook/meta` alcançável
pela internet. Um único callback serve todos os provedores: o Evolution roteia
pelo `phone_number_id`.

**Um app da Meta por provedor.** Cada provedor cria o próprio app (tipo
Empresa, com o produto WhatsApp) no Gerenciador de Negócios dele, gera o token
permanente de um usuário do sistema e cola no painel; o callback e o token de
verificação são os mesmos para todos (os da plataforma). Um app único da
plataforma servindo os números dos provedores exige virar *Tech Provider* na
Meta (verificação da empresa e Embedded Signup) — fica para depois.

Para o número que **já está no app WhatsApp Business** do celular (coexistência,
via Embedded Signup em `https://tr69.com.br/whatsapp-signup.html`), ver
`docs/whatsapp-coexistencia.md`: a ordem dos passos importa e a sincronização
tem prazo de 24 h.


**Janela de 24 horas.** Num número oficial, texto livre só é aceito até 24 h
depois da última mensagem do cliente **naquele número**
(`wa_conversations.last_inbound_at`, com 30 min de folga para a fila). Regra
em `utils/wa/waJanelaMeta.js` (`decidirEnvioCloud`):

| número | janela | modelo Meta na mensagem | sai como |
| --- | --- | --- | --- |
| QR | — | — | texto |
| oficial | aberta | qualquer | texto |
| oficial | fechada (ou outro número) | sim | `sendTemplate` |
| oficial | fechada (ou outro número) | não | recusa `meta_window_closed` |

A regra roda no enfileiramento (409 com o texto ainda na caixa) e de novo no
envio (a campanha anda por horas). `meta_window_closed` e as recusas
definitivas da Meta (131047, 131026, 131051, 131049, 1320xx) não voltam para a
fila; 190 (token) e 130429/131056 (vazão) voltam. A Meta às vezes recusa
**depois** de aceitar: o recibo `FAILED` marca a mensagem como `failed`.

`wa_messages.meta_template` guarda o modelo da mensagem (`{name, language, params}`)
e `sent_as` diz como ela saiu (`text`/`template`); `publicMessage` expõe `sentAs`.
Recibos da Meta chegam como `SENT`/`DELIVERED`/`READ` e são lidos como os do Baileys.

#### Modelos aprovados da Meta

O painel **sincroniza** a lista da Meta (`wa_meta_templates`, por número) e
pode **pedir** modelos novos; quem aprova é sempre a Meta (pelo painel ou pelo
Gerenciador do WhatsApp, o resultado é o mesmo).

| rota | permissão | o que faz |
| --- | --- | --- |
| `POST /api/whatsapp/accounts/:id/templates/sync` | `whatsapp.config` | busca em `GET /template/find/{instância}` e troca a cópia local (o que sumiu da Meta some daqui) |
| `POST /api/whatsapp/accounts/:id/templates` | `whatsapp.config` | cria o modelo em `POST /template/create/{instância}` e sincroniza; responde 201 com o modelo (`PENDING`) |
| `GET /api/whatsapp/meta-templates?accountId=&usable=1` | `whatsapp.read` | lista; `usable` = `APPROVED` e formato suportado |
| `GET/PUT /api/whatsapp/meta-notice-bindings` | `campaigns.read` / `campaigns.manage` | modelo de cada aviso automático (`maintenance`, `outage`, `alert`) |
| `GET /api/whatsapp/meta-usage?months=3\|6\|12` | `campaigns.read` | modelos enviados por mês e categoria (outro valor de `months` vira 6) |
| `GET/PUT /api/whatsapp/meta-prices` | `campaigns.read` / `campaigns.manage` | preço por mensagem (R$) de `MARKETING`, `UTILITY`, `AUTHENTICATION`, `SERVICE`, só para a estimativa |

Suportado = corpo com parâmetros posicionais, e:

- cabeçalho ausente, de mídia (`IMAGE`, `VIDEO`, `DOCUMENT`, enviada por
  link) ou de texto com no máximo uma variável;
- botão de URL com o sufixo dinâmico `{{1}}` no fim da URL, no máximo um
  botão assim por modelo.

Ficam de fora do seletor: cabeçalho `LOCATION`, parâmetro nomeado (no corpo
ou no cabeçalho), sufixo no meio da URL, dois botões dinâmicos e
AUTHENTICATION.

Cada modelo sincronizado traz `headerFormat` (`NONE`, `TEXT`, `IMAGE`,
`VIDEO`, `DOCUMENT`, `LOCATION`), `headerParamCount` e `buttons`
(`[{index, type, urlHasParam}]`), guardados em `wa_meta_templates`
(`header_format`, `header_param_count`, `buttons_json` — migration `0091`).
Uma cópia sincronizada antes da `0091` continua "não suportada" até a próxima
sincronização.

**Criar.** Corpo da rota:

```json
{
  "name": "aviso_fatura", "category": "UTILITY", "language": "pt_BR",
  "headerText": "Sua fatura", "bodyText": "Olá {{1}}, vence {{2}}.",
  "examples": ["Ana", "10/10"], "footerText": "Provedor",
  "buttons": [{ "type": "URL", "text": "Pagar", "url": "https://..." }, { "type": "QUICK_REPLY", "text": "Já paguei" }]
}
```

Só o formato que o painel sabe enviar depois — o modelo criado aqui sai
`supported`. A ordem das recusas: conta (`account_not_found` 404,
`meta_templates_cloud_only` 409), depois o corpo (`invalid_meta_template` 400,
com o campo em `{field}` na mensagem), e só então a rede. Regras: nome
normalizado (minúsculas, espaço → `_`, `^[a-z0-9_]{1,512}$`); categoria
`UTILITY` ou `MARKETING` (AUTHENTICATION fora); idioma `xx` ou `xx_YY` (padrão
`pt_BR`); corpo de 1 a 1024; variáveis só `{{n}}` de 1 até o maior, sem pulo;
um exemplo não vazio por variável; cabeçalho e rodapé até 60, cabeçalho sem
variável; até 3 botões de texto até 25, URL só `https://` e fixa.

O servidor recebe o formato da Graph API (`components` HEADER/BODY/FOOTER/
BUTTONS, `example.body_text` só quando há variável, `allowCategoryChange:
true`). A recusa da Meta volta como `http_error` (502) com o corpo dela na
mensagem — o formulário mostra esse texto. Depois de aceitar, o painel
sincroniza; se a sincronização falhar, devolve o mínimo (`id: null`, `status`
da resposta da Meta ou `PENDING`, `metaId`) e a próxima sincronização traz a
linha. O modelo só fica `usable` quando a Meta aprova e uma sincronização
traz o `APPROVED`.

**Ligações.**

- Modelo do painel (`wa_templates`): `metaTemplateName`, `metaLanguage` e
  `metaParams` — a lista ordenada das nossas variáveis que preenchem `{{1}}`,
  `{{2}}`…; `texto` é o texto inteiro já renderizado. Conferido ao salvar
  (`meta_param_mismatch`, `meta_template_unavailable`). A régua, a cobrança
  avulsa e a campanha montam a foto `{name, language, params, header?,
  buttons?}` por destinatário (`wa_broadcast_recipients.meta_template`);
  variável vazia pula o destinatário como `templateIncomplete`.
- Cabeçalho do modelo (`metaHeader`, coluna `meta_header`):
  `{source, value}`, obrigatório quando o modelo tem cabeçalho de mídia ou de
  texto com variável (`meta_header_mismatch`):
  - `variable` — uma variável da categoria; na mídia, o valor é o link (ex.
    `link_boleto` → documento com `filename` `boleto.pdf`, ou o nome do fim
    do link quando ele tem extensão). Link vazio ou que não é `https` conta
    como variável vazia;
  - `url` — um endereço `https` fixo, conferido ao salvar;
  - `attachment` — o anexo da campanha, resolvido no envio como
    `publicMediaUrl(webhookBaseUrl, id da mensagem)`; mensagem sem anexo
    falha com `meta_header_missing` (sem endereço público, `no_public_url`).
  O cabeçalho de texto aceita só `variable`.
- Botão dinâmico (`metaButtonParam`, colunas `meta_button_param` e
  `meta_button_index`): a variável que completa a URL, obrigatória quando o
  modelo tem o botão (`meta_button_mismatch`). O índice do botão no modelo é
  guardado na ligação, porque a Meta identifica o botão pela posição.
- O que o modelo escolhido não pede é descartado ao salvar.
- Aviso automático: um modelo de até um parâmetro, que recebe o aviso
  inteiro, sem cabeçalho de mídia/variável nem botão dinâmico.
- Atendente: `POST /conversations/:id/messages` aceita `metaTemplate`
  `{name, language, params, header?, buttons?}`, conferido contra o número
  que envia (o cabeçalho e os botões que o modelo pede, nem mais nem menos;
  `meta_template_unavailable`); a conversa mostra o texto do modelo
  preenchido. `header` é `{type: 'image'|'video'|'document', link,
  filename?}` ou `{type: 'text', params: [texto]}`; `buttons` é
  `[{index, param}]`.

Na fila (`wa_messages.meta_template`) o link da mídia só passa se for
`https` (sem usuário/senha, até 1024 caracteres) e o `filename` é cortado a
80 caracteres, sem caminho nem caractere de controle.

O corpo enviado a `POST /message/sendTemplate/{instância}` segue a Cloud
API, que o Evolution repassa à Meta:

```json
{
  "number": "5593…", "name": "boleto_documento", "language": "pt_BR",
  "components": [
    { "type": "header", "parameters": [{ "type": "document", "document": { "link": "https://…", "filename": "boleto.pdf" } }] },
    { "type": "body", "parameters": [{ "type": "text", "text": "Maria" }] },
    { "type": "button", "sub_type": "url", "index": "1", "parameters": [{ "type": "text", "text": "23790001" }] }
  ]
}
```

Imagem e vídeo: `{type: 'image', image: {link}}` / `{type: 'video', video:
{link}}`.

O envio decide pela janela: aberta, texto; fechada, o modelo, se houver.

**Relatório de uso.** Conta as mensagens de `wa_messages` com
`sent_as='template'` e `direction='out'`: `sent`, `delivered` e `read` entram
no total; `failed` (a Meta recusou depois de aceitar) é contado à parte e fica
fora da estimativa. Envio que falhou antes do aceite do Evolution não tem
`sent_as` e não aparece. O mês é o do **fuso do servidor** (o período começa no
dia 1º, 00:00 local, `months - 1` meses atrás; a resposta traz `timezone`). A
categoria vem de `wa_meta_templates` por número + nome + idioma, depois por
nome + idioma em qualquer número do provedor; sem achar, `UNKNOWN`. A resposta
traz `monthly` (todos os meses do período, inclusive vazios), `totals`,
`templates` (ranking), `accounts` (por número), `prices` e `estimate`
(`null` sem preço nenhum). Lê no máximo 50 000 mensagens; acima disso,
`truncated: true`.

Os preços ficam em `app_state.wa_meta_prices` por provedor; `null` ou `''`
limpa uma categoria, e valor negativo, não numérico ou acima de R$ 100 é
recusado com `400 invalid_meta_price`. A permissão segue o par das campanhas
(gasto com modelos é decisão de quem dispara campanha e régua). A estimativa é
só estimativa: preço por país do destinatário, faixa de volume, conversas de
serviço e janelas gratuitas da Meta não são modelados, e envios feitos fora do
painel (Gerenciador da Meta) não entram.

## Webhook — `POST /api/whatsapp-webhook?t=<token>`

Público. Montado **antes** do `apiLimiter` e do `authenticateToken`, com bucket
próprio de 600/min.

Autenticação, nesta ordem:

1. `?t=` comparado em tempo constante com o token de webhook da conta;
2. sem `?t=`, o header `apikey` (ou `body.apikey`) comparado com o token da
   instância — compatibilidade com instância criada antes do `?t=`.

**Ausência de credencial é recusa.** O Evolution GO não manda header nenhum, e
a forma anterior (`if (guardado && enviado && !igual) → 401`) passava direto
nesse caso.

Resolve a conta por `body.instance`. Instância desconhecida e credencial errada
respondem o mesmo `401`: a diferença diria a um sondador quais nomes existem.

Responde `200` para tudo que reconhece, inclusive o que ignora de propósito —
os dois servidores reenviam em não-2xx, e reenviar um evento que descartamos de
propósito vira laço.

Evento canonicalizado para quatro nomes (`utils/wa/waEventos.js`):
`qrcode_updated`, `connection_update`, `messages_upsert`, `messages_update`.

**Onda 1 implementada:** os quatro tratadores estão ligados
(`services/waInboundService.js`, `services/waMediaService.js`).

### O corpo da resposta

A resposta é a ÚNICA observabilidade deste caminho — não há tela, não há alerta,
e um evento gravado e um evento descartado respondem os dois `200`. Por isso ela
diz o que aconteceu:

```json
{ "success": true, "event": "messages_upsert", "handled": true }
{ "success": true, "event": "messages_upsert", "handled": false, "skipped": "group" }
```

Os motivos de `skipped` são estáveis e a tela de diagnóstico pode contá-los:

| `skipped` | Quando |
| --- | --- |
| `group` · `broadcast` | endereço de grupo (`@g.us`) ou de status (`@broadcast`) |
| `unknown_domain` | domínio de JID que ainda não conhecemos — melhor perder a mensagem que gravar a parte local como telefone |
| `no_address` · `no_identity` | evento sem JID utilizável, ou sem telefone **e** sem LID |
| `no_external_id` · `external_id_too_long` | sem `key.id`/`Info.ID`, ou id maior que a coluna (truncar casaria duas mensagens numa linha só) |
| `no_receipt` | `messages_update` sem estado — edição de texto é o caso legítimo |
| `no_qr` · `no_state` | evento de QR ou de conexão que não carrega nada de novo |
| `unsupported_event` | evento que os servidores publicam e nós não assinamos |
| `no_data` | envelope sem `data` |

Uma reentrega devolve `{ handled: true, duplicate: true }`: o índice único de
`wa_messages.external_id` É a deduplicação, e os dois servidores reenviam.
**Chegar duas vezes é sucesso, não erro** — responder não-2xx aí faria o servidor
reenviar o mesmo evento em laço.

`500` fica reservado ao que vale a pena reenviar de verdade (banco fora, disco
cheio). Nada que a gente escolhe ignorar sai por ele.

### O que cada tratador faz

**`qrcode_updated`** — grava `qr_code` + `qr_updated_at` e põe a conta em
`connecting`: ter QR na tela é, por definição, estar no meio do pareamento.

**`connection_update`** — mapeia por `readStatus(flavor, data)` e, quando o
`data` não carrega estado (o GO manda `Connected` com corpo vazio), cai para o
nome cru do evento — sem isso `readStatus('go', {})` leria um `Connected` como
`disconnected`. Ao conectar: `last_seen_at`, `qr_code` limpo (um QR de sessão já
pareada não abre mais nada) e o telefone pareado quando o evento traz JID.

**`messages_upsert`** — endereço, identidade dupla, conversa, linha, anexo,
opt-out, contadores. Três regras que a tela pode assumir:

- **LID não é telefone.** Um contato `@lid` grava `wa_lid` e deixa
  `wa_phone_e164` NULL. A classificação é por domínio, nunca por comprimento.
- **Numa mensagem `fromMe`, `key.senderPn` e `Info.SenderAlt` são o número do
  PROVEDOR**, não o do cliente. Só entram na identidade quando `fromMe` é falso.
- **`pushName` cujos dígitos são o telefone ou o LID é descartado.** O Evolution
  GO manda o identificador como nome, e gravá-lo põe quinze dígitos onde vai o
  nome do cliente.

`external_thread_id` é a forma canônica `<dígitos>@<domínio>`: o sufixo de device
(`:22`) de uma sessão de WhatsApp Web abriria uma segunda conversa com a mesma
pessoa.

**`messages_update`** — `lerRecibo` nos três formatos (v2 plano, v1 aninhado, GO
em lote com o estado fora do `data`) e `WaMessage.applyReceipt`, que nunca anda
para trás.

### Anexo recebido

`waMediaService` tenta, nesta ordem: `base64` no evento → `mediaUrl` do storage
do servidor (por `urlBaixavel`, e pelo guard de SSRF) → `POST
/chat/getBase64FromMediaMessage`. **`*Message.url` nunca é baixado**: é o objeto
cifrado no CDN do WhatsApp.

O terceiro passo usa `services/evolutionClient.js`: `clientForAccount(account, config, token).send(evoRequest)`, que devolve
`{ ok, status, data }`. Ele é pulado no sabor GO — o GO não publica rota
equivalente e sempre manda o base64 no evento — e na prática quase nunca é
exercido no v2, porque o nosso `createInstanceRequest` liga `webhook.base64`.
Ele existe para a instância criada à mão ou por uma versão anterior.

Arquivo em `DATA_DIR/wa-media/<conversationId>/<externalId>-<nome>`, teto de
25 MB, e `attachment_path` gravado RELATIVO a `DATA_DIR` — o volume muda de lugar
entre a máquina do provedor e o container. Anexo que não desceu grava a mensagem
**sem** anexo: `attachment_name` preenchido com `attachment_path` vazio
desenharia um anexo que não abre.

### Opt-out

Só em mensagem de ENTRADA (`direction === 'in'`) e só quando a mensagem INTEIRA é
o pedido (`pedeSaida`). O eco de saída fica de fora de propósito: o provedor
digitando "sair" no próprio celular não pode descadastrar o cliente dele.

---

## Envio — `POST /api/whatsapp/conversations/:id/messages`

Onda 1. `authenticateToken` + `requirePermission('whatsapp.send')`.

```ts
// corpo
{
  body?: string
  attachment?: { url: string, type?: string, name?: string }  // `type` é o MIME
  isNote?: boolean
}
```

**A rota enfileira e responde; ela não fala com o Evolution.** Esperar o servidor
aqui deixaria a caixa de resposta tão lenta quanto o elo mais lento da corrente,
e um timeout deixaria o operador sem mensagem nenhuma. Responde `201` com a
linha criada:

```ts
{
  id: number
  conversationId: number
  direction: 'in' | 'out'
  body: string | null
  attachment: { url: string, type: string|null, name: string|null } | null
  isNote: boolean
  externalId: string | null        // só depois que o servidor aceita
  deliveryStatus: 'queued'|'sending'|'sent'|'delivered'|'read'|'failed'|null
  deliveryError: string | null
  attempts: number
  sentBy: number | null
  source: 'operator' | 'bot' | 'campaign' | 'alert'
  readAt: string | null
  createdAt: string | null
  updatedAt: string | null
}
```

Recusas, todas **antes** de a linha existir — mensagem que nunca vai sair é pior
como linha permanentemente falhada do que como erro na tela, com o texto ainda
na caixa:

| Situação | `code` | HTTP |
| --- | --- | --- |
| nenhum número conectado | `no_account` | 409 |
| conversa sem telefone e sem LID | `no_destination` | 409 |
| sem texto e sem anexo | `message_empty` | 400 |
| `:id` inexistente | `conversation_not_found` | 404 |

**A lista de opt-out NÃO é consultada aqui.** Opt-out significa que o provedor
não *inicia* contato; ele nunca pode impedir o operador de responder quem
escreveu. Quem aplica a lista é o disparo em massa e o alerta (onda 2).

`source` diz **quem redigiu** a mensagem; `sentBy` diz apenas se havia um humano
atrás dela. Os três remetentes automáticos — o bot, o disparo de cobrança e o
alerta técnico — gravam `sentBy: null`, então essa coluna sozinha não distingue
um do outro. O teto do bot (três respostas por conversa por hora) conta
**somente** `source: 'bot'`: contando todos, três cobranças na hora gastavam a
cota do bot numa conversa em que ele nunca falou, e a pergunta seguinte do
assinante ficava sem resposta. Mensagem de entrada — e o eco do provedor
digitando no próprio celular — fica com `'operator'`, o valor padrão da coluna:
`source` nomeia qual remetente do painel escreveu o texto, e nenhum deles
escreveu essa.

`isNote: true` grava a linha com `deliveryStatus: null` e o worker nunca a
enxerga — é a única forma de garantir que uma anotação interna não chegue ao
cliente. Uma nota é aceita mesmo em conversa sem endereço e com o número
desconectado: recusá-la perderia as palavras do operador sem proteger ninguém.

### O worker do outbox

`services/waOutboxWorker.js`, um `setInterval` iniciado em `server.js` e parado
no shutdown. `wa_messages` **é** a fila; não existe tabela paralela.

- Cada passada: `WaMessage.listSendable(n)` e `WaMessage.claim(id)` por
  mensagem. Claim nulo = outra passada já pegou a linha — silêncio, não erro. É
  isso que torna duas passadas simultâneas seguras, e por isso nada aqui
  serializa os ticks.
- Teto de `rateLimitPerMin` envios por minuto corrido, **uma janela por
  provedor** — o que o WhatsApp observa é o tráfego do provedor, e um limite por
  número multiplicaria pelo número de instâncias conectadas. A janela é gravada
  em `app_state` a cada vaga tomada e lida de volta na primeira passagem de cada
  provedor: o teto é o que o WhatsApp impõe, e ele não reinicia junto com o
  processo do painel.
- **Ritmo das automáticas** (`source='campaign'`: régua, cobrança avulsa e
  campanhas). Cada passada manda primeiro o resto da fila (atendente, bot,
  alerta), na hora, e depois **no máximo uma** automática, e só quando chegou a
  vez dela: entre uma e outra, uma espera sorteada entre `bulkIntervalMinSec` e
  `bulkIntervalMaxSec`; a cada `bulkBurstSize` mensagens, uma pausa de
  `bulkBurstPauseMin` minutos. Como a passada é de 5 s, a espera real fica entre
  o sorteado e o sorteado + 5 s. O estado `{ proximaEm, sequencia }` é por
  provedor e fica em `app_state` (`wa_outbox_bulk_pace`), lido de volta depois
  de um restart; um `proximaEm` além da maior espera possível é descartado. A
  regra pura está em `utils/wa/waCadencia.js`. O teto por minuto continua
  valendo para tudo.
- Roteamento: a conta da conversa primeiro (quem escreveu para o suporte tem de
  ser respondido pelo suporte); só se ela não estiver `connected` cai para
  `WhatsAppAccount.getForPurpose()`, **no mesmo purpose**.
- Texto → `sendText`. Anexo → `sendMedia`. **Áudio → `sendWhatsAppAudio`
  primeiro**, para sair como balão de voz e não como arquivo para baixar; cai
  para `sendMedia` **só em resposta não-2xx** (ou quando `sendAudioRequest`
  devolve `null`, que é o caso do Evolution GO). Repetir depois de um 2xx manda
  o áudio duas vezes, e ninguém desmanda o segundo.
- Sucesso: `external_id = readSentId(data)`, `delivery_status: 'sent'`. Quem
  promove para `delivered`/`read` é o webhook.
- Falha: `delivery_error` (500 chars) e **três tentativas** — o contador é o
  `attempts`, incrementado pelo `claim`. Abaixo do teto a linha volta para
  `queued`, porque `listSendable` procura `queued`: deixá-la `failed` a poria
  fora do alcance do worker e faria "três tentativas" significar uma. Na
  terceira ela fica `failed` e ninguém mais a toca.
- Uma passada **nunca lança**: uma mensagem impossível não pode parar a fila.

---

## Bot de autoatendimento

`services/waBotService.js`. Não tem rota: ele é chamado de dentro do webhook, no
passo 9 de `gravarMensagem`, depois da mensagem gravada e depois do opt-out.

### A regra de produto, e ela define o escopo inteiro

**O bot informa, e manda para o portal o resto.**

Uma mensagem de WhatsApp não carrega login nenhum. `resolveSubscriber` casa o
telefone com um contrato como **conveniência, nunca como autenticação** — quem
escreveu provou apenas que tem um aparelho para o qual o WhatsApp entrega.
Qualquer pessoa que saiba o número de um assinante pode escrever para o provedor
e ser tratada como ele.

| O bot PODE | O bot NUNCA PODE |
| --- | --- |
| valor, vencimento, linha digitável, PIX e link da fatura em aberto | mandar senha de WiFi |
| se a conexão está online e o sinal óptico (`rxPower`) | mandar senha do portal |
| passar para um atendente | trocar SSID, reiniciar ONT, mudar qualquer coisa do serviço |

Para tudo da coluna da direita a resposta é `whatsapp.bot.portalHint` com o link
do portal, que tem senha de verdade. **Nada no arquivo lê uma credencial.** O
leitor de sinal é `DeviceService.getCustomerPortalOverview`, escolhido porque
projeta status, SSID e potência óptica e não toca em `KeyPassphrase`.

### Intenções

Casamento **por regra, não por modelo**: determinístico, testável e — o que
importa mais — impossível de convencer a ignorar o parágrafo acima. O texto é
normalizado como em `waOptOutTexto.js` (sem acento, minúsculo, sem pontuação) e
os termos casam **por palavra inteira**, nunca por substring: `sinal` dentro de
"assinalar" não é reclamação de sinal.

| Ordem | Intenção | Resposta |
| --- | --- | --- |
| 1 | `portal` — senha, ssid, nome da rede, reiniciar, resetar | `whatsapp.bot.portalHint` |
| 2 | `fatura` — fatura, boleto, segunda via, pix, vencimento, pagar | `whatsapp.bot.invoice` ou `whatsapp.bot.noOpenInvoice` |
| 3 | `sinal` — sem internet, caiu, sem sinal, lento, offline | `whatsapp.bot.signalOk` ou `whatsapp.bot.signalDown` |
| 4 | qualquer outra coisa | `whatsapp.bot.handoff` |

A ordem é parte do contrato:

- **`portal` primeiro** porque é o grupo cuja resposta é fixa. Uma mensagem que
  pede a senha *e* reclama do sinal tem de cair nele.
- **`fatura` antes de `sinal`** porque "estou sem internet, é o boleto?" é a
  frase de quem está bloqueado por falta de pagamento, e a fatura é o que
  desbloqueia.

A fatura citada é a mais antiga em aberto (`maisAntigaEmAberto`, com a marca de
lembrete ligada: aqui o cliente **perguntou**, então uma fatura a vencer é
resposta legítima, ao contrário de um disparo de cobrança).

### Uma mensagem de entrada gera no máximo UMA de saída

Enfileirada por `WaSendService.enqueue()` com `userId: null` — é essa coluna
nula que marca a mensagem como automática, e é ela que a checagem de presença
humana lê. O bot nunca fala com o Evolution; quem entrega é o worker.

Os códigos de pagamento saem **sem rótulo**, um por linha, separados por linha
em branco. Não há chave `whatsapp.bot.*` para "linha digitável" ou "PIX", e um
rótulo em português dentro de uma mensagem que os outros quatro locales também
renderizam seria pior que a forma atual.

### As travas

Todas obrigatórias; qualquer uma delas responde com silêncio.

| Trava | Por quê |
| --- | --- |
| só `direction === 'in'` | o eco `fromMe` é o provedor digitando no próprio celular; respondê-lo mandaria as palavras dele de volta ao cliente dele |
| nunca com humano no fio — **30 min** desde a última mensagem com `sent_by` (nota interna conta) | um atendente atropelado por um bot é pior que bot nenhum; 30 min cobre quem foi olhar a OLT e não deixa o chamado de ontem calar o bot hoje |
| nunca duas vezes pela mesma mensagem | o índice único de `external_id` é a dedupe real (o reenvio nem chega aqui); o cinto é "existe saída com `id` maior que o da entrada" |
| nunca em pedido de saída | `pedeSaida()` — responder um "SAIR" com mensagem é responder com o oposto do pedido |
| teto de **3 respostas automáticas por hora por contato** | um auto-respondedor do outro lado vira laço, e um laço manda milhares de mensagens pelo número do provedor antes de alguém notar |
| assinante não resolvido → `whatsapp.bot.notRecognised` | número não reconhecido **nunca** recebe dado de contrato |

E **nunca levanta**: `responder()` engole tudo e registra em log. Uma falha do
bot virando 500 no webhook faria o servidor Evolution reenviar o mesmo evento
para sempre. Bot quebrado vira silêncio, e o fio continua não-lido para o
operador.

Quando a intenção falha por fora (SGP fora do ar, GenieACS inalcançável, ONT
online mas sem `rxPower` mapeado) a resposta cai para `whatsapp.bot.handoff` —
a pergunta era real e merece um humano, não silêncio.

### Duas coisas resolvidas depois da entrega

1. **O link do portal.** Virou `whatsappConfig.portalPublicUrl`, campo próprio.
   Derivar da origem de `webhookBaseUrl` acerta no deploy com proxy reverso na
   frente dos dois e erra no deploy em que o portal responde em `:3001`. Vazio,
   o bot manda `whatsapp.bot.handoff` — link quebrado é pior que link nenhum.
2. **O chamado.** `whatsapp.bot.signalDown` dizia "abrimos um chamado" e o
   painel não tem sistema de chamados. O texto passou a dizer o que é verdade:
   o equipamento não está respondendo e um atendente já está vendo. O "chamado"
   continua sendo o fio não-lido na caixa de entrada do operador.

E o caso "online sem `rxPower`" deixou de cair para humano: a pergunta era se a
conexão está de pé, e isso o painel sabe. Responde
`whatsapp.bot.signalOkNoReading` e para aí, sem inventar número.

---

## ✅ Onda 2 — modelos, não perturbe, cobrança e campanhas (implementado)

Tudo abaixo é `authenticateToken` + `requirePermission`, montado em
`routes/whatsappBilling.js`: `campaigns.read` para ler e `campaigns.manage` para
escrever — capacidades próprias, e não as de `whatsapp.*`, porque campanha e
caixa de entrada são trabalhos de gente diferente.

| `code` | Significado | HTTP | Chave i18n |
| --- | --- | --- | --- |
| `unknown_variable` | o corpo cita variável que o disparo não sabe preencher | 400 | `whatsapp.error.unknownVariable` |
| `template_empty` | modelo sem nome ou sem corpo | 400 | `whatsapp.error.templateEmpty` |
| `name_taken` | já existe modelo com esse nome | 409 | `whatsapp.templates.nameTaken` |
| `template_not_found` | `:id` não existe | 404 | `whatsapp.templates.notFound` |
| `invalid_phone` | não dá para usar como telefone | 400 | `whatsapp.error.invalidPhone` |
| `too_many_recipients` | mais de 300 contratos no disparo | 400 | `whatsapp.error.tooManyRecipients` |
| `no_recipients` | ninguém sobrou depois dos filtros | 409 | `whatsapp.error.noRecipients` |
| `rate_limited` | mais de 3 montagens em 5 minutos | 429 | `whatsapp.error.rateLimited` |
| `invalid_status` | a campanha não pode ir para lá de onde está | 409 | `whatsapp.error.invalidStatus` |
| `broadcast_not_found` | `:id` não existe | 404 | `whatsapp.broadcast.notFound` |

### Modelos — `/api/whatsapp/templates`

`GET` (`?category=`, `?includeInactive=1`), `POST`, `PUT /:id`, `DELETE /:id`.

```ts
{ id, name, body, category: 'cobranca'|'alerta'|'suporte'|'geral', active, createdAt, updatedAt }
```

**Um corpo que cita variável fora da lista é recusado na entrada, em qualquer
categoria**, com `unknown_variable` e os nomes ofensores no texto do erro. A
categoria não entra no teste de propósito: ela pode ser trocada depois por um
`PUT`, então aceitar `{{fatura_anterior}}` num modelo 'suporte' só adiaria a
falha. Recusar só na hora do envio seria pior ainda — lá o render devolve
`null` e o operador vê uma campanha que pulou todo mundo sem dizer por quê.

Um `PUT` que omite um campo mantém o guardado: renomear não pode ser lido como
"e apague o corpo".

### Não perturbe — `/api/whatsapp/opt-outs`

`GET` lista os ativos, `POST { phone, reasonText? }` acrescenta,
`DELETE /:id` revoga (revogação é soft; o histórico de quem pediu fica).

```ts
{ id, waPhoneE164, waLid, origin: 'customer'|'operator', reasonText, createdAt }
```

O telefone é **normalizado na entrada** (`normalizarTelefoneBr`), porque é
nessa forma que a campanha pergunta: um registro salvo como `(93) 98111-0449`
não casaria com nada, e o preço da divergência é uma mensagem enviada a quem
pediu silêncio. `POST` de um número já ativo devolve `200` com a linha
existente em vez de erro — o resultado que o operador pediu é o resultado que
ele tem.

### Inadimplentes — `GET /api/whatsapp/billing/overdue`

`?daysMin=&daysMax=&search=&limit=` → `WhatsAppOverdueSubscriber[]`:

```ts
{ contract, clientName, document, phone, phoneSource: 'manual'|'sgp'|null,
  deviceId, amount, dueDate, daysOverdue }
```

**A janela é simétrica.** `daysOverdue` é positivo para fatura vencida e
negativo para fatura a vencer, numa reta só — então `daysMin: -5` lê-se
"incluindo quem vence nos próximos cinco dias". É o que permite a mesma tela
preparar uma cobrança e um lembrete. Padrões: `daysMin=1`, `daysMax=90`,
`limit=50` (teto 300).

O endereço vem de `sgp_links`: `phone_manual` (a correção do operador) ganha de
`phone_e164` (o que o SGP devolveu), e um contrato sem nenhum dos dois aparece
na lista com `phone: null` — esconder seria esconder justamente o cadastro que
precisa de conserto.

É a rota mais lenta do painel de propósito: um round trip ao SGP por assinante,
com **~150 ms entre chamadas**. O SGP do provedor é o mesmo sistema que está,
naquele instante, atendendo a URA de quem ligou.

### Corrigir o número — `PUT /api/whatsapp/subscribers/:contract/phone`

```ts
// corpo
{ phone: string }
// resposta 200 — o assinante como a listagem o mostra, sem os campos da fatura
{ contract, clientName, document, deviceId, phone, phoneSource: 'manual'|'sgp'|null }
```

Escreve `sgp_links.phone_manual`, que é a **correção do operador** e ganha de
`phone_e164` em todo lugar que o painel resolve um número. Existe porque o
cadastro do ERP envelhece e quem tem a correção na mão é o operador — e porque
um número errado é mudo: o assinante cai no `noPhone` da campanha, disparo após
disparo, sem nada aparecer na tela.

**String vazia LIMPA a correção** e devolve o contrato para o registro do ERP.
É operação de verdade, não requisição malformada: quem digitou errado precisa
poder desfazer sem inventar um número para sobrescrever.

O valor entra normalizado por `normalizarTelefoneBr` — a mesma forma que o
envio usa. Guardar "(93) 98111-0449" ficaria certo na tela e não casaria com
nada na hora de disparar.

Escreve em **todas as ONTs do contrato**, não em uma: o leitor reduz
`sgp_links` a um assinante por contrato e fica com a linha que vier primeiro por
`device_id`, então uma correção pela metade voltaria a mostrar o número velho
dependendo de qual ONT ganhasse.

| Código | Quando | HTTP |
| --- | --- | --- |
| `invalid_phone` | número não discável (`whatsapp.error.invalidPhone`) | 400 |
| `subscriber_not_found` | contrato que o painel nunca viu (`whatsapp.error.subscriberNotFound`) | 404 |

**Um sync do SGP nunca apaga isto.** `contractToLinkRow`
(`services/sgpService.js`) deixa `phone_manual` fora da linha de propósito, de
modo que o `onConflict().merge()` do upsert não tem com o que sobrescrever — só
`phone_e164` é atualizado. É a razão de o override ser uma coluna separada em
vez de uma edição em `phone_e164`, e há teste cobrindo exatamente isso
(`backend/test/whatsapp-subscriber-phone.test.js`).

A resposta **não traz `amount`, `dueDate` nem `daysOverdue`**: eles custam um
round trip ao SGP e corrigir um telefone não pode tê-los mudado. A tela aplica
só `phone` e `phoneSource` na linha que já está na mão. Note que
`whatsappAPI.setSubscriberPhone` declara `WhatsAppOverdueSubscriber` como
retorno, que é mais largo do que o que a rota devolve.

### Montar a campanha — `POST /api/whatsapp/billing/campaign`

```ts
// corpo
{ template: string, contracts: string[], title?: string }
// resposta 201
{ broadcast: WhatsAppBroadcast, recipients: number, skipped: WhatsAppSkipCounts }
```

`template` é o **nome** (ou o id) de um modelo guardado, ou o corpo digitado
direto na caixa para um disparo único. Seja qual for, o texto passa pela mesma
validação de variáveis antes de virar mensagem.

**Montar NUNCA envia.** A campanha nasce `draft` e a rota devolve. Nenhuma linha
entra no outbox aqui. Mandar mensagem para centenas de pessoas não pode ser o
efeito colateral de um clique numa tela de listagem: o operador abre a campanha,
lê os corpos já renderizados, e aperta o play.

**Os pulados são contados por motivo**, nunca num número só, e a soma
`recipients + Σ skipped` é sempre o total de contratos pedidos (deduplicados):

| Contador | O que aconteceu |
| --- | --- |
| `noPhone` | sem celular no cadastro — ou contrato que o painel nunca vinculou |
| `optOut` | pediu para não ser contatado |
| `noInvoice` | nada em aberto |
| `futureOnly` | só tem fatura a vencer, e o modelo é de cobrança (`soFuturas`) |
| `sgpRefused` | o SGP recusou aquele contrato; os outros seguem |
| `templateIncomplete` | o render devolveu `null` — variável citada sem valor |

Junto dos contadores vem `skipped.missing = { pix: 12, link_boleto: 3 }`:
quais variáveis faltaram nos `templateIncomplete`, para a tela dizer qual campo
consertar no SGP.

"412 pulados" não diz nada a quem opera; "83 sem celular no cadastro, 12
pediram para não ser contatados" diz o que dá para consertar.

Detalhes que a tela pode contar com:

- **A lista de opt-out é aplicada aqui** — isto é contato iniciado pelo
  provedor, ao contrário da caixa de resposta. Uma consulta só para a campanha
  inteira (`WaOptOut.activePhones`), não uma por destinatário.
- **Os códigos são buscados vivos**, um round trip por destinatário, com os
  mesmos ~150 ms de intervalo. Boleto reemitido tem linha digitável e PIX
  novos, e uma mensagem com o código velho manda o cliente a um banco que vai
  recusar.
- **Teto de 300 destinatários** por campanha, e **3 montagens por 5 minutos**
  (`rate_limited`/429) — cada montagem custa um round trip por destinatário.
- `renderCobranca` devolvendo `null` **descarta** o destinatário. Nunca há
  mensagem parcial: "PIX: " sem nada depois manda o cliente pagar um
  placeholder.
- Sem ninguém para contatar, a resposta é `409 no_recipients` — **com o
  `skipped` junto**, porque "todos estão na lista de não perturbe" é a resposta
  que o operador precisa.

### Campanhas — `/api/whatsapp/broadcasts`

`GET` lista (mais recente primeiro), `POST /:id/status { status }` move.

```ts
{ id, title, body, status, totalCount, sentCount, failedCount,
  rateLimitPerMin, startAt, createdAt, updatedAt,
  kind: 'billing' | 'general',          // 'general' = campanha de aviso
  scheduledAt: string | null,           // agendada ('queued') começa sozinha
  attachment: { name, type } | null,
  audience: { states, plans, districts, cities, contracts: number } | null }
```

#### Detalhe — `GET /broadcasts/:id/recipients?status=&limit=&offset=`

`campaigns.read`. Cada destinatário e o que aconteceu com a mensagem dele:

```ts
{ broadcast, total, hasMore,
  summary: { total, pending, sent, delivered, read, replied, optedOut, failed, skipped, paid },
  items: [{ id, contract, clientName, phone, status, error, deliveryStatus,
            replied, optedOut, sentAt }] }
```

- `delivered`/`read` vêm do `delivery_status` da mensagem na fila;
  `replied` é o assinante ter escrito na mesma conversa **depois** do envio;
  `optedOut`, ter pedido para sair **depois** do envio.
- `status`: `pending` (inclui `sending`), `sent`, `skipped`, `failed` ou
  `replied`. O `summary` é sempre da campanha inteira; `limit` até 500
  (padrão 100). Campanha inexistente → 404 `broadcast_not_found`.
- `error`: `opt_out`, `paid`, `no_destination`, ou o erro do envio.

#### Pagamento depois da montagem (cobrança avulsa)

Cada destinatário da cobrança avulsa guarda a fatura que a mensagem cita
(`invoice_key`, `due_date`). Na hora de enviar, depois da checagem de não
perturbe, o laço consulta de novo as faturas em aberto do contrato no SGP: se a
fatura não está mais lá (paga ou cancelada), o destinatário fica
`skipped/paid` e nada sai. SGP sem resposta deixa enviar — a montagem já viu a
fatura aberta, e uma queda do ERP não pode travar a campanha. Campanhas de
cobrança processam no máximo 10 destinatários por passada, com ~150 ms entre as
consultas.

#### Campanha de aviso ("Nova campanha")

Público pelo cadastro (`sgp_contacts`), sem consultar fatura:

| Rota | Permissão | Faz |
| --- | --- | --- |
| `GET /broadcasts/audience-options` | `campaigns.read` | valores de `state`, `plan`, bairro (`address_parts.district`) e cidade (`address_parts.city`) com contagem |
| `POST /broadcasts/preview` | `campaigns.manage` | `{ filters, templateId? , body? }` → contagens + até 50 exemplos renderizados; não grava nada |
| `POST /broadcasts` | `campaigns.manage` | `{ title, filters, templateId?, body?, attachment?, scheduledAt? }` → rascunho, ou `queued` com `scheduledAt` |

- `filters = { states[], plans[], districts[], cities[], contracts[] }`. Entre
  grupos vale E; dentro do grupo, OU; grupo vazio não restringe. Bairro e
  cidade comparam sem maiúsculas nem acentos. Um contrato colado que só existe
  em `sgp_links` entra apenas quando nenhum filtro de cadastro foi pedido.
- Telefone por `whatsappPhoneOf` (a mesma ordem da tela de Contatos); fica de
  fora quem não tem celular, quem está no não perturbe e o número repetido (um
  cliente com dois contratos recebe uma mensagem).
- Variáveis: `{{nome}}`, `{{primeiro_nome}}`, `{{contrato}}`, `{{plano}}`.
  Variável de cobrança → 400 `billing_variables` (a cobrança é a Cobrança
  avulsa). Faltou o dado citado → o destinatário é pulado
  (`templateIncomplete`), como na cobrança. Modelos da categoria `geral`
  aceitam essas variáveis além das de cobrança.
- Teto de 5000 destinatários; mesma janela de montagens da cobrança avulsa.
- `scheduledAt`: de 1 minuto a 60 dias à frente. O laço inicia as `queued`
  vencidas no começo de cada passada (e só se houver número conectado).
- `attachment`: o `{ path, name }` devolvido por `POST /attachments`,
  conferido pelo mesmo `normalizeAttachment` do envio. Um arquivo para todos os
  destinatários; o sweeper de mídia não apaga o anexo de campanha em
  `draft`/`queued`/`running`/`paused`.
- Na Trilha: `whatsapp.campaign_created`, com os filtros e a contagem.

Transições aceitas — só `running`, `paused` e `canceled` podem ser pedidos:

| De | Para |
| --- | --- |
| `draft` | `running`, `canceled` |
| `queued` | `running`, `paused`, `canceled` |
| `paused` | `running`, `canceled` |
| `running` | `paused`, `canceled` |
| `done` · `canceled` · `failed` | nada |

`draft` não pula para `paused`: pausar o que nunca começou não é estado. Os três
terminais não aceitam nada — recomeçar uma campanha encerrada reenviaria para
quem ela já alcançou. **Só o start exige número conectado** (`no_account`): um
rascunho é um plano, e recusá-lo porque ninguém pareou o telefone jogaria fora
o trabalho do operador por uma condição de um minuto.

### O laço de disparo

`services/waBroadcastService.js`, um `setInterval` iniciado em `server.js` e
parado no shutdown. Um minuto por passada — o orçamento da campanha é escrito
por minuto, e ninguém está esperando por ele como se espera por uma resposta.

- Cada passada percorre as campanhas em `running` e reclama até
  `rate_limit_per_min` destinatários de cada uma, com o mesmo UPDATE
  condicional do outbox (`claimRecipient`); claim nulo = outra passada pegou.
- Guardas, **nesta ordem**: opt-out → endereço → envio.
- **O opt-out é conferido dentro do laço, não como filtro na consulta dos
  pendentes.** Um destinatário filtrado pela consulta nunca sairia de
  `pending`, e a campanha ficaria em `running` para sempre sem ter o que fazer.
  Ele vira `skipped` com `error_msg: 'opt_out'` — estado terminal.
- Número que não normaliza vira `failed` na primeira tentativa: não é falha de
  transporte, é endereço que nunca vai existir.
- O envio é um **enqueue**: `WaSendService.enqueue` numa conversa garantida por
  `WaConversation.ensure` (mesmo `external_thread_id` canônico da entrada, para
  cair no fio que já existe). Quem fala com o Evolution é o worker do outbox,
  sob o mesmo teto e as mesmas três tentativas de todo o resto. Campanha com
  transporte próprio seria um segundo lugar onde uma mensagem trava.
- Três tentativas por destinatário; abaixo do teto a linha volta para `pending`.
- Sem número conectado a campanha é **deixada em `running`** e tentada na
  passada seguinte — queimar as três tentativas por um número que estava só
  repareando perderia a campanha inteira.
- Quando não sobra nenhum `pending`/`sending`, a campanha vira `done`;
  `sent_count` e `failed_count` são recontados das linhas a cada passada
  (um `skipped` conta como não entregue no cabeçalho).
- Uma passada **nunca lança**: uma campanha quebrada não pode parar as outras.

---

## ✅ Caixa de entrada — `/api/whatsapp/conversations` (implementado)

Serviço: `services/waConversationService.js`.

| Rota | Faz | `data` |
| --- | --- | --- |
| `GET /conversations` | lista paginada (`limit` ≤ 200, `offset`), do mais recente | array de conversa |
| `GET /conversations/:id/messages` | histórico (`limit` ≤ 500, `before` = cursor) e **zera o não lido** | `{ conversation, messages }` |
| `POST /conversations/:id/messages` | enfileira; ver a seção Envio | a mensagem criada |

```ts
// conversa
{
  id: number
  accountId: number
  waPhoneE164: string | null
  waLid: string | null
  pushName: string | null
  deviceId: string | null
  contract: string | null
  clientName: string | null
  optedOut: boolean          // pediu para não ser contatado; responder continua valendo
  lastMessageAt: string | null
  lastInboundAt: string | null
  unreadCount: number
  closedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}
```

**Pilhas (`status`)** de `GET /conversations`:

| `status` | Mostra |
| --- | --- |
| `open` (padrão) | não encerradas **com gente dos dois lados** (`engaged_at` preenchido) |
| `noreply` | não encerradas que só receberam envio automático (`engaged_at` nulo) |
| `closed` | encerradas |
| `all` | tudo |

`engaged_at` (migration `0084`) é gravado uma vez, na primeira mensagem do
cliente, no eco `fromMe` do celular do provedor, na primeira mensagem ou nota de
atendente (`source='operator'`) e quando o atendente abre a conversa pelo
cadastro (`openConversation`). Envio automático (`campaign`, `alert`) nunca
grava, e numa conversa já engajada também **não** atualiza `last_message_at`:
a régua e as campanhas não sobem conversa para o topo. Com termo de busca, a
pilha `open` inclui as `noreply`, para a busca por nome ou telefone achar o
cliente em qualquer uma delas.

`before` é o id da mensagem mais antiga que a tela já tem — cursor, não
offset. Este fio cresce enquanto é lido: um cliente respondendo no meio da
rolagem desloca todo offset em um, e a página seguinte repetiria uma
mensagem ou pularia outra sem ninguém perceber. A ordenação é por `id` pelo
mesmo motivo — dois registros podem dividir o mesmo `created_at`, e o empate
deixaria a fronteira da página no ar.

`GET /conversations/:id/messages` é um GET que **escreve**: ler a conversa zera
`unread_count`. O operador olhando para ela é a única coisa que "lido" pode
significar aqui.

A listagem faz **duas** consultas em lote — nomes de cliente e lista de
não-perturbe — em vez de duas por linha. Uma caixa com cinquenta conversas
abriria cem queries para desenhar uma tela.

### Quem está do outro lado

`resolveSubscriber(telefone)` casa o número com um `sgp_links`. O
`phone_manual` que o operador digitou ganha do `phone_e164` que o SGP
sincronizou, porque digitar foi a correção.

O número é comparado **com e sem o nono dígito** (`variantesTelefoneBr`): o
WhatsApp ainda entrega muito celular antigo como `55 + DDD + 8`, e o SGP guarda o
mesmo aparelho com o 9. Número fixo (8 dígitos começando de 2 a 5) nunca ganha
variante. A variante só serve para casar; o envio continua usando o número como
está.

O vínculo acontece em três momentos, e nenhum deles sobrescreve um contrato já
gravado: na chegada de cada mensagem (com ou sem o bot), ao abrir a conversa e,
em lote, na própria listagem — que é o que resolve as conversas antigas.

`POST /api/whatsapp/conversations/:id/subscriber` (`whatsapp.send`) é o vínculo
à mão, para o número que o SGP não conhece:

```json
{ "contract": "10231", "savePhone": true }
```

Ele **sobrescreve** o vínculo atual. `savePhone: true` também grava o número da
conversa como `phone_manual` do contrato — a mesma escrita de
`PUT /subscribers/:contract/phone` — e por isso exige `campaigns.manage`
(403 `missing_permission` sem ela). Responde a conversa no formato da listagem;
404 `conversation_not_found` ou `subscriber_not_found`.

### Contatos do SGP — `/api/whatsapp/contacts`

`GET /api/whatsapp/contacts?search=&limit=50&offset=0` (`whatsapp.read`) lista
os assinantes de `sgp_links`, **um por contrato**, com a conversa que já existe
com cada um:

```json
{
  "total": 1,
  "contacts": [{
    "contract": "10231",
    "clientName": "Carlinhos Vendas",
    "document": "•••8909",
    "deviceId": "ONT-1",
    "hasDevice": true,
    "phone": "5593992081870",
    "phoneSource": "sgp",
    "optedOut": false,
    "conversationId": 12,
    "lastMessageAt": "2026-09-23T16:04:00.000Z"
  }]
}
```

A busca olha nome, contrato, CPF/CNPJ e os dois telefones. O documento sai
mascarado; a busca vê ele inteiro.

`POST /api/whatsapp/contacts/:contract/conversation` (`whatsapp.send`) devolve a
conversa com o assinante — `200` com a que já existe (pelo contrato ou por
qualquer grafia do número), `201` com uma nova, vazia, pelo número de propósito
`general`. Abrir não envia nada. `409 subscriber_no_phone` quando o cadastro não
tem telefone, `400 no_account` sem número conectado, `404 subscriber_not_found`.

#### Assinantes sem ONT — `POST /api/whatsapp/contacts/lookup`

`sgp_links` é chaveada pela ONT, então o assinante sem ONT no painel (rádio,
outro fabricante, cadastro novo) não aparece na listagem acima. Esta rota
(`whatsapp.read` + `sgp.read`, com o limitador das rotas do SGP) pergunta ao
próprio SGP:

```json
{ "search": "987.654.321-00" }
```

O SGP só busca por documento ou contrato, nunca por nome: 11 ou 14 dígitos
viram `cpfcnpj`, qualquer outra coisa vira `contrato`. A resposta tem o mesmo
formato da listagem. Cada contrato achado que **não** tem ONT é guardado em
`sgp_contacts` (um por contrato, por provedor); o que já tem ONT continua sendo
de `sgp_links` e não é duplicado. "Cliente não encontrado" é resposta vazia, não
erro; `400 lookup_term_required` sem termo; as recusas do SGP chegam com o
código e a frase do SGP.

A partir daí o contato sem ONT funciona como os outros: aparece na listagem com
`hasDevice: false`, abre conversa, pode ser escolhido em
`/conversations/:id/subscriber` (e `savePhone` grava em `sgp_contacts`), e o
número dele é reconhecido quando ele escreve — sempre com `device_id` nulo.
Ele NÃO entra no `resolveSubscriber` que o bot usa: o bot responde sobre fatura
e sinal a partir da ONT, e não há ONT.

`sgp_contacts` entra no export e na exclusão de dados do assinante pelo
contrato, como `sgp_links` — e o cadastro sem contrato da mesma pessoa, pelo
documento.

#### Todos os clientes, com ou sem contrato

A sincronização completa (ver `docs/sgp-integration.md`, "Contacts sync") enche
`sgp_contacts` com todos os clientes do SGP. Um cliente **sem contrato** não tem
contrato para servir de endereço, então todo contato ganha uma chave:

- `key`: o contrato, quando existe; `c:<id da linha>` quando não existe. É o
  que `POST /contacts/:key/conversation` e o `contract` de
  `POST /conversations/:id/subscriber` aceitam.
- `hasContract`, `state` (`active` | `blocked` | `cancelled` | `unknown` |
  `none`) e `lastSeenAt` (quando a sincronização o viu por último).
- `GET /contacts?state=none` filtra por situação.

A conversa com um cliente sem contrato é vinculada por
`wa_conversations.sgp_contact_id` (exposto como `sgpContactId`), nunca por um
contrato inventado — a cobrança consulta faturas pelo contrato. Quando o cliente
ganha contrato no SGP, a sincronização move a conversa para o contrato.

A conversa nova fica com o número do SGP no `external_thread_id`. Quando a
resposta chega pela outra grafia do nono dígito, `WaConversation.ensure` acha o
fio existente em vez de abrir um segundo.

**Essa resolução é conveniência, nunca autenticação.** Quem escreveu provou
apenas que tem um telefone que o WhatsApp entrega. Nada que ela destrave pode
ser segredo nem ação destrutiva: o painel já tem um portal do cliente com senha
de verdade, e o bot manda o link dele em vez de virar uma segunda porta, mais
fraca, para os mesmos dados.

---

## Alertas técnicos — `/api/whatsapp/alerts`

Quem recebe estes alertas é a **equipe do provedor**, não o assinante: uma lista
de telefones nas configurações, não uma consulta ao cadastro. Nada aqui sabe de
quem é a ONT que caiu, e não deve saber — um alerta nomeia equipamento.

| Rota | Faz |
| --- | --- |
| `GET /api/whatsapp/alerts/settings` | as regras e seus limiares |
| `PUT /api/whatsapp/alerts/settings` | grava |
| `POST /api/whatsapp/alerts/scan` | roda uma passada agora |

### O objeto de configuração

Guardado como um blob JSON em `app_state` (`whatsapp_alert_settings`), com o
mesmo cache de 30 s do `whatsappConfigService`.

```json
{
  "enabled": false,
  "intervalSeconds": 300,
  "recipients": ["5593981110001"],
  "rules": {
    "ont_offline":      { "enabled": true, "threshold": 30,  "cooldownMinutes": 120 },
    "rx_power_low":     { "enabled": true, "threshold": -27, "cooldownMinutes": 360 },
    "temperature_high": { "enabled": true, "threshold": 70,  "cooldownMinutes": 360 },
    "mass_outage":      { "enabled": true, "threshold": 5,   "cooldownMinutes": 120 }
  },
  "hasAlertsNumber": true,
  "ready": true
}
```

`hasAlertsNumber` e `ready` são somente leitura: a tela precisa poder mostrar
**por que** os alertas estão calados sem disparar uma varredura.

`PUT` aceita qualquer subconjunto. `rules` é **mesclado** sobre o que está
gravado — uma tela que manda uma regra não pode zerar as outras três. Um número
que `normalizarTelefoneBr` não consegue usar é **recusado** (`invalid_phone`,
400): guardá-lo faria a falha acontecer uma vez por alerta, para sempre, num log
que ninguém lê — enquanto quem digitou ainda está olhando o formulário.

`POST /alerts/scan` devolve `{ fired, cleared, notified, skipped }`. Sem número
de purpose `alerts` conectado, ou sem destinatários, responde **409
`no_alert_recipients`** — quem apertou o botão apertou justamente para descobrir se
isto funciona, e um `{fired: 0}` alegre esconderia a resposta.

### As quatro regras

| Regra | Dispara quando | Assunto (`subject`) |
| --- | --- | --- |
| `ont_offline` | `_lastInform` mais velho que o limiar, **em minutos** | id do device |
| `rx_power_low` | potência óptica **≤** o limiar (dBm, negativo) | id do device |
| `temperature_high` | temperatura **≥** o limiar (°C) | id do device |
| `mass_outage` | N ONTs do mesmo nó caem juntas | `node_id` do nó |

**No limiar já dispara.** Quem digita 30 quer dizer "trinta minutos já é demais";
uma comparação estrita faria do único número que a pessoa escolheu o único que
nunca alerta.

A telemetria vem dos leitores que já existem — `DeviceService.getDashboardDevices()`
e `DeviceService.isDeviceOnline()`. **Óptica e temperatura só são julgadas em
device que está informando**: uma ONT apagada devolve a última leitura que
conseguiu mandar, e "potência baixa" empilhado em "ONT offline" é o mesmo
incidente dito duas vezes.

### As regras que impedem isto de virar ruído

`wa_alert_state` é uma tabela de **estado**, não de log: uma linha por
`(rule, subject)` enquanto a condição dura, apagada quando ela passa.

- **Uma condição fala uma vez.** Depois só volta a falar quando
  `cooldownMinutes` passa, contado de `last_notified_at`. Um alerta que repete a
  cada varredura deixa de ser lido, e o que importava deixa de ser lido junto.
- **Recuperação também é mensagem**, uma só, e a linha vai embora com ela. Quem
  recebeu "ONT offline" e nunca mais ouviu nada não consegue distinguir fibra
  consertada de alertador quebrado.
- **Surto em massa cala os alertas individuais.** N ONTs do mesmo nó caindo
  juntas é um rompimento, não N incidentes: sai **uma** mensagem nomeando o nó e
  a contagem, e os `ont_offline` daqueles devices ficam retidos — não são
  limpos, o que mandaria "ONT recuperada" no meio de um rompimento. Quarenta
  mensagens às 3 da manhã é como um sistema de alerta é silenciado para sempre.
- **"Não sei" nunca vira "recuperou".** Leitura ilegível, device apagado,
  device retido por um surto: a linha fica exatamente como estava.
- **Leitura de frota vazia aborta a passada** (`skipped: 'no_devices'`). É muito
  mais provável ser um GenieACS quebrado que um provedor sem ONTs, e tratá-la
  como "tudo certo" dispararia uma recuperação por linha aberta.
- **A lista de opt-out vale aqui.** Um alerta é o provedor *iniciando* contato,
  que é exatamente o que um opt-out recusa.
- **Uma passada nunca lança.** O motivo de não ter feito nada volta em
  `skipped` (`disabled`, `not_configured`, `no_alert_number`, `no_recipients`,
  `no_devices`, `error`), e **todos viram recusa** em `POST /alerts/scan`.
  `{fired: 0}` é a mesma resposta para "nada está errado" e "nada foi
  verificado", e quem apertou o botão apertou para saber qual dos dois é.

O agrupamento do surto é pelo nó de agregação **mais próximo** — a ODP em que a
ONT está pendurada, não a OLT no fim da cadeia. Alerta de OLT inteira seria uma
mensagem para o que normalmente é um drop, e mandaria o técnico para a ponta
errada da rede. Um rompimento mais acima simplesmente vira uma mensagem por ODP
afetada. O elo entre device e nó é o **PPPoE**: `mapping_nodes.pppoe` de um nó
`type: 'ont'`, casado com o PPPoE que `DeviceService.getCustomerIdentityDevices()`
devolve — lido só quando a frota já parece quebrada.

`threshold` de `mass_outage` é o N. O padrão é **5**: uma ODP atende 8 ou 16
assinantes, duas ou três fora é uma noite normal em qualquer rede, cinco na
**mesma** ODP ao mesmo tempo não é coincidência.

### O texto das mensagens

Composto no serviço e traduzido pelo **locale padrão do painel** (`pt-BR`) — um
job de fundo não tem locale de requisição.

| Chave | Variáveis |
| --- | --- |
| `whatsapp.alerts.ontOffline` · `…ontOfflineCleared` | `device`, `minutes` |
| `whatsapp.alerts.rxPowerLow` · `…rxPowerLowCleared` | `device`, `value`, `threshold` |
| `whatsapp.alerts.temperatureHigh` · `…temperatureHighCleared` | `device`, `value`, `threshold` |
| `whatsapp.alerts.massOutage` · `…massOutageCleared` | `node`, `count` |

A metade `*Cleared` não é enfeite: quem olha o celular às 3 da manhã lê a
primeira linha e mais nada, e "ONT offline ✔" é lido como um segundo alarme, não
como um fim de alarme. A recuperação ganha frase própria.

### O laço

`WaAlertService.start()` em `server.js`, parado no shutdown. Um `setInterval` de
60 s que só roda a varredura quando `intervalSeconds` passou. O `enabled` é lido
**dentro** do tick — mesma escolha do `schedulerService` e do `waOutboxWorker`,
para um botão em Configurações valer em um minuto sem ciclo de vida a manter em
sincronia. O "quando foi a última" fica em memória, não em `app_state`: um painel
que acabou de voltar **deve** varrer na hora, e as linhas de cooldown já impedem
que uma condição já anunciada seja anunciada de novo.

Envio: uma conversa por número de plantão (`WaConversation.ensure`, do mesmo
jeito que uma mensagem de entrada faria) e `WaSendService.enqueue`. O worker do
outbox entrega.

---

## Anexos — onda 6

Hoje um anexo é **gravado e inalcançável**. `waMediaService` baixa a mídia que
chega e grava o caminho relativo a `DATA_DIR` em `attachment_path`;
`publicMessage` devolve esse caminho como `attachment.url`, e o navegador não
tem rota nenhuma para buscá-lo. O cliente manda a foto da ONU, e o operador vê
a palavra "Anexo".

Do lado da saída é pior: `sendThrough` entrega `url: message.attachment_path`
ao Evolution — um caminho de disco do painel, que o servidor do Evolution não
tem como buscar. Nada exercita isso hoje porque nada consegue anexar.

São **dois públicos e duas rotas**, e a diferença entre elas é a única coisa
que importa aqui.

### 1. O operador, com sessão

`GET /api/whatsapp/messages/:id/media` — `authenticateToken` +
`requirePermission('whatsapp.read')`, escopado por provedor como todo o resto.
Devolve o arquivo gravado. Não confundir com `/api/whatsapp-media/:id`, que
serve o MESMO arquivo ao servidor Evolution com uma credencial assinada na
query em vez de sessão, porque é outro público.

- O caminho vem **do banco**, nunca da requisição, e é resolvido com
  `path.resolve` contra `DATA_DIR`: um `attachment_path` que escape da pasta é
  recusado com 404, não servido. É a única defesa que importa, porque a coluna
  foi escrita a partir de um nome de arquivo que veio de fora.
- `Content-Disposition: inline` só para imagem; qualquer outra coisa vai como
  `attachment`. **SVG nunca é servido inline** — é executável no navegador, e
  esta rota está na mesma origem do painel.
- Mensagem de outro provedor, id inexistente ou linha sem anexo: `404
  attachment_not_found`.

### 2. O servidor Evolution, sem sessão

`GET /api/whatsapp-media/:id?t=<token>` — montada **antes** do `apiLimiter` e
fora do `authenticateToken`, pela mesma razão que o webhook: quem busca é um
servidor, não um navegador com sessão.

- `t` é `<exp>.<hmac>`, com o HMAC-SHA256 de `${id}.${exp}` sob uma chave
  derivada de `JWT_SECRET` por contexto próprio (`wa-media`), comparado em tempo
  constante. **15 minutos** — o Evolution busca na hora; um link que sobrevive
  ao envio é um arquivo do cliente exposto para sempre.
- Cunhado **pelo worker do outbox, no momento do envio**, nunca pelo navegador.
- A origem é a de `whatsappConfig.webhookBaseUrl`: é o único endereço que o
  painel sabe que o Evolution alcança, porque é por ele que os eventos chegam.
  **Sem ele configurado, o envio com anexo é recusado** (`no_public_url`) em vez
  de mandar uma URL que não abre — a mesma lição do link do portal.

### 3. O que o operador manda

`POST /api/whatsapp/attachments`, corpo **cru** (`express.raw`), nome em
`X-File-Name` (percent-encoded), tipo no `Content-Type`. Corpo cru e não
multipart porque o painel não tem — e não vai ganhar — uma dependência de
upload para uma tela só; é a mesma escolha que o webhook do SGP já faz.

- Teto de **16 MB**, e uma allowlist de tipos: `image/jpeg`, `image/png`,
  `image/webp`, `application/pdf`, `video/mp4`, `audio/ogg`, `audio/mpeg`.
  `image/svg+xml` **fica de fora de propósito**.
- A extensão gravada vem do tipo aceito, **nunca do nome que o operador mandou**:
  o nome é guardado para mostrar, não para resolver caminho.
- Grava em `DATA_DIR/wa-media/out/<aaaa>/<mm>/<uuid>.<ext>` e devolve
  `{ path, type, name }` — `path` relativo a `DATA_DIR`, exatamente como a
  entrada grava.
- Recusas: `attachment_too_large` (413), `attachment_type_not_allowed` (415),
  `attachment_empty` (400) — arquivo de zero byte não é arquivo pequeno:
  gravado, ele chega ao cliente como um download que não abre, igualzinho a
  um upload corrompido.

Como ficou implementada, e as três coisas que o contrato não determinava:

- `authenticateToken` + `requirePermission('whatsapp.send')`, na rota de `whatsappMessages`
  — a mesma que grava a mensagem que vai apontar para o arquivo. Responde
  **201** com `whatsapp.attachmentStored`.
- O `express.raw` é montado em `app.js` **antes** do `express.json({ limit:
  '1mb' })` global, na constante `ATTACHMENT_PATH`. Sem essa reserva uma foto de
  12 MB morre como erro de parse de JSON, e não como recusa que a tela saiba
  explicar. O teto do parser é o teto do contrato, então o arquivo grande é
  recusado antes de ser bufferizado — e a recusa nua do body-parser (413 sem
  `code`) é reescrita como `attachment_too_large`, porque uma tela que traduz
  código não traduz mensagem.
- **Nenhuma tabela é tocada aqui.** A linha sai depois, em
  `POST /conversations/:id/messages`, a partir do `{ path, type, name }` que esta
  rota devolveu — a ordem inversa deixaria uma bolha apontando para bytes que
  nunca chegaram. Quem precisa de escopo de provedor é `wa_messages`, que já tem.
- Um corpo de **zero byte** com tipo aceito é gravado: não há chave para recusar
  arquivo vazio, e inventar uma seria pior que gravar zero byte que ninguém pediu.

---

## Retenção de anexos — onda 7

Nada nunca apaga um arquivo. Cada mídia que chega e cada uma que sai fica em
`DATA_DIR` para sempre, sem cota, sem contagem e sem ninguém olhando. Num
provedor com movimento isso cresce sozinho, e o disco que enche é o mesmo onde
o SQLite escreve.

`whatsappConfig.mediaRetentionDays` — **0 é para sempre, e é o padrão.** Esse
padrão não é preguiça: a configuração chega depois de instalações que já têm
arquivos, e apagar o histórico de um provedor porque ele atualizou o painel
seria o painel destruindo dado que ninguém mandou tocar.

### O que a varredura apaga, e o que ela nunca toca

- Apaga o **arquivo** e limpa as colunas `attachment_*` da linha. A mensagem
  continua no fio, com o texto intacto; o anexo passa a dizer que não está mais
  em disco, que é a verdade e já tem tela.
- **Nunca apaga linha de mensagem.** Histórico de conversa é o que um provedor
  precisa quando o cliente contesta; disco é o que ele precisa quando enche.
  São problemas diferentes e só um deles é resolvido aqui.
- **Nunca apaga arquivo que uma mensagem ainda vai usar.** Uma linha `queued`
  ou `sending` tem um envio pela frente: apagar o arquivo dela transforma um
  envio pendente numa falha permanente. A idade da mensagem não importa — o que
  importa é se ela já saiu.
- Um arquivo em disco sem linha nenhuma apontando para ele é lixo de upload
  abandonado e some pela mesma regra de idade.

`POST /api/whatsapp/media/sweep` roda a varredura na hora, para quem precisa de
disco agora. Responde `whatsapp.mediaSwept` com quantos arquivos e quantos MB.
Com retenção em 0 ela não apaga nada e diz isso.

### O que `waMediaSweeper` decidiu ao implementar isso

Quatro escolhas que o contrato não fixava e que quem mexer nele precisa saber:

- **O relógio é o `mtime` do arquivo**, para arquivo com linha e para órfão
  igual. É o número que o próprio disco guarda, é o único que um órfão tem, e
  para um arquivo com linha ele fica a segundos do `created_at` dela — os bytes
  são gravados e só então a linha. Um relógio só, então arquivo e linha nunca
  discordam sobre a idade.
- **A passagem periódica é de 6 h**, nada parecido com os 5 s da fila de saída:
  a janela é medida em dias, a varredura anda a árvore inteira de mídia
  disputando o mesmo disco do SQLite, e é o único job da integração que apaga —
  passar raro limita o que um bug ali leva antes de alguém ver. Não há passagem
  no boot, de propósito; quem precisa de disco agora tem o botão.
- **A varredura só anda `DATA_DIR/wa-media`**, nunca `DATA_DIR`. É a diferença
  entre recuperar disco e apagar o `panel.sqlite`, que mora um nível acima.
- ~~**Roda em `forSoleTenant`**~~ — **superado pela onda 8.** Rodava, porque o
  disco era um sistema de arquivos de que nenhum provedor tinha um canto: uma
  passagem por provedor veria os arquivos do outro como órfãos sem linha e
  apagaria todos. O conserto que este parágrafo previa é o que a onda 8 fez —
  cada provedor ganhou sua subárvore, e só então o laço por provedor. Ver a
  seção da onda 8.

---

## Saúde da integração — `GET /api/whatsapp/health`

Uma leitura só, que responde "isto está funcionando?". Hoje cada número dela só
é descoberto abrindo conversa por conversa — ou seja, é descoberto pelo cliente
reclamando.

```ts
{
  accounts: { total, connected, disconnected }
  outbox: { queued, sending, failed24h, oldestQueuedAt }
  inbox: { unread, openConversations }
  lastInboundAt: string | null
  lastOutboundAt: string | null
  media: { files, bytes, oldestAt }
}
```

`oldestQueuedAt` é o número que importa: uma fila que só cresce, com a mais
antiga de ontem, é o painel calado sem ninguém saber. `lastInboundAt` é o par
dele — fila vazia e nada entrando há dois dias não é calmaria, é webhook morto.

**Barato de propósito.** É uma tela que faz poll; um agregado caro aqui vira o
motivo de o painel estar lento. Como isso é cumprido, já que `wa_messages` é a
maior tabela do painel:

- Fila e falhas saem de `wa_messages.index(['delivery_status', 'created_at'])`
  — o índice do próprio outbox worker — por IGUALDADE na primeira coluna.
  `queued`, `sending` e `oldestQueuedAt` só tocam a fila, que é pequena por
  definição (uma fila grande É o alarme); `failed24h` acrescenta a faixa em
  `created_at`, a segunda coluna do índice, então a janela de 24 h é um seek e
  não uma varredura de todas as falhas que o painel já teve.
- `oldestQueuedAt` é `ORDER BY created_at LIMIT 1`, não `MIN()`: para no
  primeiro registro e volta como valor de coluna, não como agregado — cada
  engine tipa agregado sobre timestamp de um jeito.
- `inbox` e `lastInboundAt` saem de `wa_conversations`, que tem uma linha por
  CONVERSA em vez de uma por mensagem, e que já mantém `last_inbound_at` a cada
  entrada. `inbox.unread` conta CONVERSAS com não lidas, não a soma dos
  contadores: quem mandou trinta mensagens é uma conversa para abrir.
- `lastOutboundAt` é o único número sem coluna própria, e por isso são três
  consultas (`sent`, `delivered`, `read`) em vez de um `whereIn`: com `ORDER BY`
  o `whereIn` atravessa três faixas disjuntas do índice, e a união delas é quase
  a tabela inteira.
- **Contagem vem como número, sempre.** As três engines discordam se `COUNT(*)`
  volta número ou string — o Postgres devolve bigint que o driver entrega como
  STRING. `waBotService` desviou disso puxando ids; uma leitura de saúde não
  pode, então converte explicitamente. Sem isso `queued` chega como `"40"`,
  `queued > 0` continua verdadeiro, e nada parece errado até uma comparação
  ordenar lexicamente.

**`media` é a única parte cara, e é cacheada por isso.** `files` e `oldestAt`
até viriam do banco, mas `bytes` não: `wa_messages` guarda `attachment_path`,
`attachment_type` e `attachment_name` e NÃO o tamanho, então o único lugar onde
o total em bytes existe é o disco — um `stat` por arquivo. A leitura é guardada
por provedor por cinco minutos; vencida, a anterior é devolvida na hora e a
varredura roda atrás da resposta. Só a primeira leitura depois de subir espera o
disco. Os arquivos ficam em `wa-media/<conversationId>/`, caminho que não carrega
provedor nenhum, então os nomes de diretório são filtrados por `wa_conversations`
antes de qualquer `stat` — sem isso o painel contaria as fotos do vizinho como
suas. Apagar os antigos é da rota de varredura de mídia; esta leitura só conta.

A tira que consome isso (`components/whatsapp/health-strip.tsx`) fica ACIMA da
barra de abas, fora do switch de aba, e faz poll a 60 s — mais devagar que tudo
nesta tela, com as mesmas quatro regras que o bloco de pareamento já provou:
single-flight, tique pulado com a aba em segundo plano, backoff
`2 ** falhas - 1` e todo timer dentro de um efeito que limpa no unmount.

---

## Telas — quem consome o quê

Para achar o consumidor de uma rota sem varrer o `frontend/`:

| Rota | Tela |
| --- | --- |
| `GET/PUT /whatsapp/config` | aba **WhatsApp** de `pages/settings.tsx` (formulário global) |
| `GET /accounts` · `POST /accounts` · `PATCH` · `DELETE` | `components/whatsapp-connection.tsx` (um cartão por número) |
| `GET /accounts/:id/qr` · `GET /accounts/:id/status` | o bloco de pareamento do mesmo componente — os dois únicos pontos com polling |
| `POST /accounts/:id/restart` · `POST /accounts/:id/disconnect` | ações do cartão; `disconnect` + `POST /accounts` é o "desparear e gerar novo QR" |
| `POST /accounts/check-number` | ainda sem tela |
| `GET /whatsapp/health` | `components/whatsapp/health-strip.tsx`, acima da barra de abas de `pages/whatsapp.tsx` |
| conversas, modelos, opt-out, campanhas, cobrança, alertas | ondas 2 e 3, sem tela ainda |

O polling do bloco de pareamento é **medido**, não escolhido: QR a cada 8 s por
até 45 s, status a cada 10 s por até 4 min, os dois em single-flight (um `get_qr`
foi cronometrado em ~5,4 s, mais que o próprio intervalo), pulando o tique
inteiro com a aba em segundo plano e desistindo depois de três falhas seguidas.
Ao desistir a tela troca o bloco pela explicação `whatsapp.qr.silent` — nada
aqui fica girando para sempre.

---

## Modelos de cobrança

Variáveis aceitas: `nome`, `valor`, `vencimento`, `dias_atraso`,
`dias_para_vencer`, `pix`, `linha_digitavel`, `link_boleto`.

Duas regras que o renderizador impõe, e que não dependem da disciplina de quem
opera:

1. **Variável vazia recusa a mensagem inteira** (o render devolve `null`). Um
   "PIX: {{pix}}" literal chegando a um inadimplente é pior que não mandar nada.
2. **`dias_atraso` e `dias_para_vencer` são espelhos mutuamente exclusivos.**
   Fatura vencida preenche o primeiro e esvazia o segundo, e vice-versa. Somado
   à regra 1, um texto de cobrança não tem como chegar a quem ainda não venceu.

Um modelo que cita `{{dias_para_vencer}}` é, por definição, um lembrete — é
assim que o disparo sabe que pode incluir faturas a vencer.

---

## Onda 8 — um provedor por vez, de verdade

As ondas 6 e 7 deixaram três dívidas escritas em comentário no próprio
código. Esta onda paga as três, e as decisões abaixo estão **congeladas**:
quem implementar não escolhe, implementa.

### 1. `sgp_links` por provedor

`sgp_links` é a tabela que transforma um `device_id` em assinante: contrato,
documento, nome, plano e o telefone que o lado WhatsApp usa para resolver uma
mensagem que chega. Era a última tabela do caminho do WhatsApp lida sem filtro
de provedor — e, portanto, o último lugar onde o operador de um provedor podia
digitar um número e receber o assinante de outro.

- A migração `0019_sgp_links_tenant` já existe: adiciona `tenant_id`, faz o
  backfill para o provedor do install, e troca o único global de `device_id`
  pelo par `['tenant_id', 'device_id']`.
- Todo acesso a `sgp_links` passa a ir por `tdb`. Nenhum `getDb()('sgp_links')`
  sobrevive nesta onda.
- `sgp_links` entra em `SCOPED_TABLES` **no mesmo commit** que converte os
  modelos. Entrar antes deixa a tabela filtrada com escritas que não gravam
  `tenant_id`; entrar depois deixa a conversão sem o teste que a prova.
- O ponto sensível é `waConversationService.resolveSubscriber`: hoje ele lê a
  tabela inteira. Depois desta onda, um número que existe em outro provedor
  tem de resolver como **desconhecido**, não como assinante. Resolver telefone
  continua sendo conveniência, nunca autenticação — a regra das ondas 2 e 3
  não muda aqui, só deixa de vazar entre provedores.

### 2. Subárvore de mídia por provedor

Hoje tudo é escrito em `DATA_DIR/wa-media/<conversa>/`, sem provedor no
caminho. É por isso que `waMediaSweeper.tick` usa `forSoleTenant` e se recusa
a rodar assim que existe um segundo provedor: a varredura de um veria os
arquivos do outro como órfãos e apagaria todos.

- O novo caminho é `DATA_DIR/wa-media/t<tenant_id>/<conversa>/`.
- Caminhos antigos (sem `t<id>/`) **continuam sendo servidos**. Uma linha
  gravada antes desta onda aponta para onde o arquivo está, e o arquivo não se
  move: migrar bytes no disco durante um upgrade é o tipo de coisa que falha na
  metade. Escrita nova vai para a subárvore; leitura aceita as duas formas.
- A varredura passa a rodar **por provedor**, e cada passagem enxerga só a sua
  subárvore. A raiz `wa-media/` fora de qualquer `t<id>/` é a área legada: ela
  é varrida na passagem do provedor único do install, como hoje, e é ignorada
  quando existe mais de um provedor — órfão de origem desconhecida não se
  apaga.
- O ponto cego que a onda 7 registrou em comentário morre aqui: um provedor com
  `tenants.status` diferente de `active` não é mais visitado pela varredura, e
  seus arquivos moram numa subárvore que a varredura dos outros nem enxerga.
- A confinagem não afrouxa: `path.resolve` contra `DATA_DIR`, `realpath` na
  leitura, symlink nunca seguido, `wa-media` como teto. Uma subárvore a mais
  não é permissão a mais.

### 3. Retenção do histórico — `messageRetentionDays`

`wa_messages` nunca perdia linha. Numa base que dispara campanha para milhares
de contratos, ela só cresce.

- `messageRetentionDays` já está em `whatsappConfigService`: 0 é para sempre e
  é o padrão, mesmo `normalizeRetentionDays` da retenção de anexos.
- A varredura de histórico **nunca apaga**:
  - linha `queued` ou `sending` — é mensagem que ainda vai sair;
  - linha que ainda tem `attachment_path` preenchido.
- Essa segunda regra é o que amarra as duas retenções sem que um módulo apague
  o arquivo do outro: quem apaga arquivo é `waMediaSweeper`, e ele limpa
  `attachment_path` ao apagar. Só depois disso a linha fica elegível. Com
  retenção de anexos desligada, mensagem com anexo fica para sempre — que é
  exatamente o que "guardar os anexos para sempre" quer dizer.
- A conversa (`wa_conversations`) **nunca** é apagada. Ela guarda o vínculo
  telefone↔contato; apagá-la é perder de quem era a conversa, não economizar
  disco.
- Roda no mesmo laço de 6 h, por provedor, dentro de escopo — `wa_messages` é
  tabela escopada, então aqui não há desculpa de `forSoleTenant`.
- **`delivery_status` é NULL em toda mensagem que CHEGA.** A coluna descreve um
  envio, e nada foi enviado. Um `whereNotIn('delivery_status', [...])` simples
  compara contra NULL, resulta em NULL em vez de verdadeiro, e protege para
  sempre a metade do cliente de toda conversa — uma varredura que parece
  funcionar até alguém contar as linhas. O ramo `whereNull` explícito é o que
  deixa uma mensagem recebida envelhecer.
- Não existe rota de limpeza manual do histórico, ao contrário da mídia. O
  botão da mídia existe para o disco cheio agora; crescimento de tabela não tem
  essa urgência, e o laço de 6 h dá conta. Uma rota que apaga histórico sob
  demanda seria superfície destrutiva a mais sem nada que a peça.

### O botão manual não é o laço

Com a varredura de mídia virando laço por provedor, `WaMediaSweeper.tick()`
passa a andar o disco de **todos** os provedores ativos. Isso é certo para o
temporizador, que não é requisição de ninguém, e errado para o botão: a
requisição chega dentro do escopo de um provedor, e um admin de uma ISP não
tem por que recuperar o disco de outra nem receber os megabytes dela como
resposta.

Por isso `POST /api/whatsapp/media/sweep` chama `sweepCurrentTenant()`, que
varre só o escopo já aberto, pega a mesma trava de concorrência do laço (a
trava é do *run*, não da passagem) e decide sozinho se a área legada entra —
entra só quando há um provedor ativo, mesma regra do laço.

Isto teria parecido correto por exatamente o tempo em que houvesse um provedor
só.

---

## Onda 9 — a fila que sobrevive a um servidor que pisca

Duas coisas achadas lendo o caminho quente da fila de saída, nenhuma delas
anotada em comentário antes desta onda. As decisões abaixo estão **congeladas**.

### O problema, medido

`MAX_ATTEMPTS` é 3, o laço acorda a cada 5 s, e uma tentativa que falha devolve
a linha para `queued` na hora. Ou seja: **três tentativas queimam em quinze
segundos** e a linha vira `failed` para sempre. Um restart do servidor Evolution
que leve vinte segundos falha permanentemente toda a fila — numa campanha de
cobrança, milhares de mensagens de uma vez.

E o "reenviar" da tela não reenvia: ele lê o `body` da linha e manda uma
mensagem **nova**. A linha falhada fica lá, o assinante recebe duas, e uma
mensagem cujo conteúdo era um anexo não reenvia de jeito nenhum — não há corpo
para ler, e o botão não faz nada em silêncio.

### 1. Recuo exponencial — `next_attempt_at`

- A coluna já existe (migração `0020`), é anulável, e **NULL significa "pode
  agora"**. É a única leitura que não trava a fila de um install ao atualizar.
- `listSendable` e `claim` passam a respeitar a hora devida. O índice
  `(delivery_status, next_attempt_at)` existe para essa consulta.
- O recuo é exponencial com teto. O que importa não é a curva e sim a janela
  total: ela tem de ser maior que um restart de servidor, medida em minutos, não
  em segundos. `MAX_ATTEMPTS` sobe junto — três tentativas só faziam sentido
  quando elas eram imediatas.
- `provisioning_runs` já carrega `next_attempt_at` e o seu índice de vencimento.
  É o padrão da casa; siga-o.

### 2. Falha transitória não é falha permanente

Queimar tentativas é certo para um servidor fora do ar e errado para um número
que não existe. As duas têm de ser distinguidas:

- **Transitória** — servidor inalcançável, timeout, 5xx, sessão desconectada.
  Recua e tenta de novo.
- **Permanente** — número inválido, destinatário que não existe no WhatsApp,
  conteúdo recusado. Vira `failed` na primeira, sem gastar a janela.

Na dúvida, **trate como transitória**. O custo de errar para o lado transitório
é uma mensagem que sai alguns minutos depois; para o outro lado é uma cobrança
que nunca chega e ninguém percebe.

### 3. Reenviar é devolver a linha à fila, não criar outra

`WaMessage.requeue(id)` é a superfície congelada:

- Só linha `failed` é elegível, e quem diz isso é o `WHERE`, não o chamador.
  Reenfileirar uma linha `sent` manda a mesma mensagem duas vezes ao assinante;
  reenfileirar uma `queued` zera um recuo que está fazendo o seu trabalho.
- Zera `attempts` e põe `next_attempt_at` em NULL — quem apertou decidiu que o
  motivo da falha passou, e fazer o operador esperar um recuo calculado sobre
  tentativas que não valem mais é o painel discutindo com ele.
- A linha mantém id, anexo, `source` e lugar na conversa. O assinante vê uma
  mensagem, não duas.

Em lote (`POST /api/whatsapp/messages/requeue-failed`), a mesma regra por linha,
dentro do escopo do provedor que pediu — pela mesma razão que o botão de
limpeza da onda 8: a requisição chega no escopo de um provedor e não tem por que
mexer na fila de outro.

### 4. A saúde tem de saber a diferença

Costura entre as duas metades, e que nenhuma das duas enxerga sozinha: uma
mensagem que voltou a `queued` esperando o recuo **está** esperando para sair, e
conta em `queued`. Mas não é a fila parada, e `oldestQueuedAt` reportando-a como
a mais velha esperando transforma uma tentativa saudável num vermelho de "parada
desde anteontem" na tela do operador — que é exatamente o alarme que existe para
significar outra coisa.

- `outbox.retrying` é essa fatia, contada à parte.
- `oldestQueuedAt` considera só as linhas **vencidas**: `next_attempt_at` NULL
  (que é "pode agora", e é o caso comum, não a exceção) ou já passada.
- A tira mostra as três coisas na mesma linha, porque "40 esperando" sem idade
  nenhuma, sem a contagem de retentativas ao lado, se lê como defeito do painel.

### 5. A campanha também espera — mas não pelo motivo óbvio

`wa_broadcast_recipients` tinha a mesma forma de bug: `MAX_ATTEMPTS` 3, laço de
60 s, e falha devolvendo a linha direto para `pending`. Três tentativas em dois
minutos e a campanha inteira terminava em `failed`.

**A falha que chega ali não é o servidor fora do ar**, e vale ser exato porque é
fácil errar essa frase: `WaBroadcastService.deliver` só **enfileira** — escreve
em `wa_messages` e quem tem o transporte é a fila de saída. Um Evolution
reiniciando é problema do item 1 desta seção e já é sobrevivido. O que cai
naquele `catch` é `no_account` — campanha rodando sem número conectado —, um
`no_public_url`, ou banco que engasgou. Configuração e infraestrutura: as coisas
que um operador conserta nos dez minutos depois de começar o disparo e reparar.

Dois minutos não dão esse tempo, e o preço de estourar é a campanha toda.

- A curva e o classificador são **importados** de `waOutboxWorker` e
  `waSendFailure`, não reescritos. Uma campanha que desistisse num cronograma
  diferente do da fila que ela alimenta seria uma segunda política que ninguém
  decidiu.
- Migração `0021`, mesmas regras do `0020`: coluna anulável, NULL é "pode
  agora", índice começando por `broadcast_id` porque é assim que
  `listPendingIds` pergunta.
- O ramo do `sending` velho **ignora** a hora devida de propósito: retomada de
  claim travado é recuperação de queda, não espera que alguém agendou.

## Régua de cobrança automática

A "Régua de cobrança" passou a ter duas metades. A **avulsa** (a de sempre)
monta rascunho e nunca envia. A **automática** envia sozinha, e por isso
nasce desligada: salvar as etapas não liga nada.

### Configuração (uma por provedor, em `app_state` → `wa_dunning_rule`)

| Campo | O que é |
|---|---|
| `steps[]` | `{ offsetDays, templateId }`. `offsetDays` é o dia em relação ao vencimento: −3 é três dias antes, 0 é o dia do vencimento, 5 é cinco dias de atraso. De −30 a 120, até 12 etapas, uma por dia. |
| `maxPerInvoice` | Teto de cobranças enviadas por fatura (1–30, padrão 6). |
| `minIntervalHours` | Intervalo mínimo entre duas mensagens ao mesmo **contrato** (0–720, padrão 24). Adia a etapa; não a gasta. |
| `maxPerRun` | Teto de envios por passada (padrão 500). O resto sai na próxima. |
| `window` | Janela de envio no mesmo formato do horário do chatbot (`timezone`, `week[]`). Padrão: seg–sex 08–20, sáb 08–12, domingo sem envio. |
| `thanksTemplateId` | Modelo de agradecimento, opcional. Não pode citar `{{dias_atraso}}` nem `{{dias_para_vencer}}`. |

O modelo de uma etapa com `offsetDays > 0` não pode ser lembrete (citar
`{{dias_para_vencer}}`), e o de uma etapa com `offsetDays ≤ 0` não pode citar
`{{dias_atraso}}`: a mesma regra dos espelhos de `waCobranca.js`, conferida
ao salvar e não na hora de enviar.

### A passada (`waDunningService.run`)

O agendador roda uma passada a cada 3 horas, **só com a régua ligada e
dentro da janela**. Cada passada:

1. lê as faturas em aberto de cada contrato no SGP, ao vivo, no mesmo ritmo
   da listagem manual;
2. escolhe a fatura em aberto mais antiga e a **etapa mais recente já
   alcançada, do mesmo lado do vencimento**. Etapas perdidas não saem em
   rajada;
3. pula e registra o motivo: sem celular, não-perturbe, variável do modelo
   vazia, teto por fatura. O intervalo mínimo só adia;
4. grava a decisão em `wa_dunning_sends` **antes** de enfileirar. O índice
   único `(tenant, contrato, fatura, tipo, etapa)` é o que garante uma vez por
   etapa por fatura, mesmo com duas passadas ao mesmo tempo;
5. enfileira no outbox (`source: 'campaign'`), que cuida do teto por minuto
   e das novas tentativas.

### Pagamento

- Uma fatura paga não está entre as em aberto, então não gera etapa.
- O webhook `payment_confirmed` do SGP chama `WaDunningService.onPayment`.
  Ele confere a lista **completa** de títulos do contrato: cancelada não é
  paga. Depois marca `paid_at`, tira da fila a cobrança que ainda não saiu
  (remoção condicional a `delivery_status = 'queued'`) e, dentro da janela,
  manda o agradecimento.
- Sem webhook, a passada percebe a fatura cobrada que sumiu das em aberto e
  faz a mesma conferência.
- Agradecimento: uma vez por fatura, só para quem recebeu cobrança de fato,
  até 3 dias depois do pagamento, respeitando o não-perturbe.

### Rotas (`/api/whatsapp`)

| Rota | Permissão | |
|---|---|---|
| `GET /dunning/rule` | `campaigns.read` | Configuração, `inWindowNow`, `running`, `lastRun`. |
| `PUT /dunning/rule` | `campaigns.manage` | Salva. Não liga. Vai para a trilha (`whatsapp.dunning_saved`). |
| `POST /dunning/enabled` | `campaigns.manage` | `{ enabled }`. Ligar exige etapa válida e número de cobrança conectado. Trilha: `whatsapp.dunning_enabled` / `_disabled`. |
| `POST /dunning/preview` | `campaigns.manage` | Quem receberia qual etapa hoje, sem gravar nada. Limitada aos primeiros 300 contratos. |
| `POST /dunning/run` | `campaigns.manage` | Uma passada agora, em segundo plano (202). Recusa com a régua desligada, fora da janela ou com outra passada em curso. |
| `GET /dunning/sends` | `campaigns.read` | Histórico paginado, filtros `contract`, `status`, `kind`. Um pulo por `template_incomplete` traz `missing: ['pix', …]` — as variáveis que faltaram (coluna `reason_detail`); a prévia traz o mesmo `missing` em cada item. |
| `GET /dunning/stats?days=30` | `campaigns.read` | Mensagens, faturas pagas após cobrança, valor recuperado, por etapa. "Recuperado" é correlação, não prova. |
