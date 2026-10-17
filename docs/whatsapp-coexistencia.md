# WhatsApp em coexistência (Embedded Signup da Meta)

Coexistência é o modo em que o número **continua no app WhatsApp Business do
celular** e passa a responder também pela API oficial (Cloud API), com os dois
lados vendo as mesmas conversas. É o caminho para o provedor que já atende pelo
app e não quer perder o celular. Este documento é o roteiro de quem opera: o que
preparar, em que ordem rodar, e o que **nunca** fazer.

Fontes: [Onboard WhatsApp Business app users (Coexistence)](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)
e [Embedded Signup — implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation/).

## Limites que vêm junto

- Vazão **fixa em 20 mensagens por segundo** no número (a Meta não sobe).
- As **listas de transmissão** do app viram somente leitura.
- O app WhatsApp Business precisa estar na versão **2.24.17 ou superior** e o país do
  número tem que ser suportado.
- A documentação exige ser **Tech Provider** ou Solution Partner (verificação da
  empresa). Com o app da Meta em modo de desenvolvimento e você como administrador o
  teste costuma funcionar; se a tela "conectar o app WhatsApp Business existente"
  **não aparecer**, é esse o motivo e é preciso concluir a verificação de acesso.
- App em modo de desenvolvimento só aceita no fluxo quem tem papel no app.
- Mensagens enviadas **pelo celular** chegam à API como `smb_message_echoes`. O
  `/webhook/meta` do Evolution v2 pode ignorar esses eventos (e os de `history`), e
  então elas não aparecem no painel. Validar na primeira conta.
- A Meta descontinua o Embedded Signup **v2 em 15/10/2026**. A versão é escolhida na
  configuração do Embedded Signup no painel da Meta (não na página): use a v4.

## Pré-requisitos (antes de rodar o cadastro)

A ordem importa porque, depois de conectar, há **24 horas** para disparar a
sincronização de contatos e de histórico. Perdido o prazo, o número é desconectado
e o fluxo tem que ser refeito.

1. **Webhook assinado.** No app da Meta (`2151827142378177`), produto WhatsApp →
   Configuração → Webhooks: callback `<servidor Evolution>/webhook/meta`, token de
   verificação = `WA_BUSINESS_TOKEN_WEBHOOK` do Evolution (que é o mesmo
   `cloudVerifyToken` do painel; ver `whatsapp-api-contract.md`). Campos:
   `messages`, `smb_message_echoes`, `history`, `smb_app_state_sync`,
   `account_update`. Sem `history` e `smb_app_state_sync` a sincronização não
   entrega nada; sem `account_update` o painel não fica sabendo de uma desconexão
   (`ACCOUNT_OFFBOARDED`) nem da reconexão automática.
2. **Token permanente.** Business Manager → Usuários do sistema → usuário
   administrador do sistema → gerar token com `whatsapp_business_management` e
   `whatsapp_business_messaging`, com acesso à WABA. (Alternativa: trocar o `code`
   que a página mostra, em até 30 s, em
   `GET https://graph.facebook.com/v25.0/oauth/access_token?client_id=<APP_ID>&client_secret=<APP_SECRET>&code=<CODE>`.)
3. **Página no ar.** `frontend/public/whatsapp-signup.html` sai no build do painel e
   é servida em `/whatsapp-signup.html`; o app da Meta só aceita o SDK em
   `https://tr69.com.br/`, então `tr69.com.br` tem que chegar ao painel (bloco
   `server_name tr69.com.br www.tr69.com.br` no nginx, com certificado e `Host`
   intacto — `saas-operations.md` §13). `PLATFORM_EXTRA_HOSTS` não é necessário só
   para a página. Conferir:

   ```
   curl -sI https://tr69.com.br/whatsapp-signup.html | grep -iE '^(HTTP|content-security-policy)'
   ```

   A CSP dessa URL (e só dela) libera `connect.facebook.net`, os iframes do SDK e a
   Graph (`backend/src/app.js`, rota `/whatsapp-signup.html`).

## Rodar o cadastro

Com o celular aberto no WhatsApp Business, abrir a página e clicar em **Conectar com
o Facebook**. Entrar com a conta administradora, escolher **conectar o app WhatsApp
Business existente**, informar o número e seguir as instruções no celular
(**Conectar** → **Confirmar** o compartilhamento de histórico → escanear/colar o
código).

A página mostra na tela: `WABA ID`, `Phone Number ID`, `Business ID`, o `code` (30 s)
e o evento. O esperado é `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`; qualquer outro
`FINISH*` quer dizer que o fluxo escolhido **não** foi o de coexistência. `CANCEL`
traz `current_step`, a etapa em que parou.

Conferir que o número ficou nos dois lados:

```
curl 'https://graph.facebook.com/v25.0/<PHONE_NUMBER_ID>?fields=is_on_biz_app,platform_type' \
  -H 'Authorization: Bearer <TOKEN>'
# esperado: { "is_on_biz_app": true, "platform_type": "CLOUD_API", ... }
```

## Em até 24 h, nesta ordem

**Não chamar `POST /<PHONE_NUMBER_ID>/register`.** O número já está registrado pelo
app; registrar de novo derruba a coexistência.

1. Vincular o app à WABA:

   ```
   curl -X POST 'https://graph.facebook.com/v25.0/<WABA_ID>/subscribed_apps' \
     -H 'Authorization: Bearer <TOKEN>'
   ```

2. Sincronizar os contatos (dispara os webhooks `smb_app_state_sync`). **Só pode ser
   chamado uma vez**; guarde o `request_id` da resposta.

   ```
   curl -X POST 'https://graph.facebook.com/v25.0/<PHONE_NUMBER_ID>/smb_app_data' \
     -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' \
     -d '{ "messaging_product": "whatsapp", "sync_type": "smb_app_state_sync" }'
   ```

3. Sincronizar o histórico (dispara os webhooks `history`; se o provedor não
   compartilhou o histórico, vem um `history` com erro `2593109`). Também **uma vez
   só**.

   ```
   curl -X POST 'https://graph.facebook.com/v25.0/<PHONE_NUMBER_ID>/smb_app_data' \
     -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' \
     -d '{ "messaging_product": "whatsapp", "sync_type": "history" }'
   ```

A sincronização pode levar minutos; deixar o celular com o app aberto ajuda. Quando
termina, o app mostra que o número está conectado à API.

## Criar a conta no painel

`POST /api/whatsapp/accounts` com `{ "kind": "cloud", "label": "...", "purpose":
"support", "metaToken": "<TOKEN>", "phoneNumberId": "<PHONE_NUMBER_ID>", "wabaId":
"<WABA_ID>" }` (ou pela tela de Conexão WhatsApp → número oficial). O painel cria a
instância `WHATSAPP-BUSINESS` no Evolution e registra o webhook na WABA com
`override_callback_uri` apontando para o `/webhook/meta` desse servidor
(`services/metaWebhookService.js`). Essa chamada é a mesma `subscribed_apps` do
passo 1, só que com callback: é idempotente, e o curl manual feito antes não
atrapalha. O resultado fica em `meta_webhook_status` / `meta_webhook_error` da
conta, com "registrar de novo" na tela.

## Problemas comuns

| sintoma | causa |
| --- | --- |
| botão dá "domain not allowed" / "URL bloqueada" | a página não está em `https://tr69.com.br` (host cadastrado no app) |
| a tela de "conectar app existente" não aparece | app sem Tech Provider / verificação de acesso pendente |
| `CANCEL` com `current_step` | o provedor fechou o popup; a etapa diz onde |
| `smb_app_data` responde erro de "já sincronizado" | cada `sync_type` só vale uma vez; refazer exige desconectar e repetir o cadastro |
| número desconectou sozinho | passaram 24 h sem sincronizar, ou o provedor trocou de aparelho (`ACCOUNT_OFFBOARDED`; a reconexão é automática no novo aparelho, `ACCOUNT_RECONNECTED`) |
| mensagens do celular não aparecem no painel | o Evolution não processa `smb_message_echoes` (limitação a validar) |
