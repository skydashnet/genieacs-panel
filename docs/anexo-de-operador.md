# Anexo de tratamento de dados pessoais (minuta)

> **Esta é uma minuta, não um contrato.** Descreve o que o produto faz, conferido contra o
> código; **não foi revisada por advogado** e não substitui a revisão. Tudo entre colchetes
> `[ ]` é decisão das partes ou dado que o código não tem. As cláusulas marcadas **(jurídico)**
> são caracterização legal que cabe a quem entende de direito.
>
> Fontes factuais: `docs/lgpd-inventario-de-dados.md` (o que existe e por quanto tempo),
> `docs/lista-de-compartilhamento.md` (para quem o dado vai).

## 1. Partes e papéis

- **Controlador:** o PROVEDOR, [razão social, CNPJ], contratante do SkyGenPanel — quanto ao dado
  de **seus assinantes**: o provedor decide coletar, para quê e por quanto tempo.
- **Operador:** [razão social da plataforma, CNPJ] — quanto ao mesmo dado, que trata em nome do
  provedor para prestar o serviço.
- **Dado em que somos controlador, e que este anexo não cobre:** o operador do painel (quem
  entra), o pedido de contato da vitrine e o cadastro fiscal do provedor. Esses seguem a política
  de privacidade do site (`/privacidade`). A separação é a do inventário, seção 1.

## 2. Objeto e duração

Tratamento de dados pessoais de assinantes do provedor pela execução do serviço descrito no
contrato principal [referência], enquanto ele vigorar, mais o que a cláusula 11 prevê para o
fim.

## 3. Dados e titulares

Titulares: os **assinantes do provedor** (e, quando for o caso, as pessoas que ele indica ou
com quem conversa pelo WhatsApp).

Categorias, conforme o inventário (seção 2.1 — o conjunto exato é o que o código percorre ao
montar o dossiê do titular):

| Grupo | Dado |
| --- | --- |
| Cadastro e acesso | identificador do assinante no portal; senha do portal e senha de WiFi (cifradas) |
| Contrato no ERP | nome, documento, telefone, login PPPoE, plano, situação, fatura em aberto mais antiga |
| O aparelho | identificador da ONT, telemetria, histórico de troca |
| Rede | posição do assinante na planta de fibra |
| Atendimento (WhatsApp) | telefone, conteúdo das mensagens e anexos, avaliação, estado dos avisos e cobranças enviados |
| Operação | que aparelho foi ativado, atingido por uma queda ou avisado de manutenção |
| Indicações | nome e telefone de quem foi indicado, que pode não ser cliente |
| Trilha | quem, no provedor, fez o quê sobre o assinante |

## 4. Instruções do controlador (jurídico)

O operador trata o dado **somente** para operar as funções que o provedor liga e configura, e
segundo as instruções documentadas do contrato [cláusula a confirmar: não usar o dado do
assinante para fins próprios]. Esta minuta não afirma, sobre o código, que isso nunca ocorre:
o que está levantado são os destinos e as funções (inventário e lista de compartilhamento), e a
promessa de finalidade é da cláusula, assumida por quem assina.

## 5. O que nós operamos, e o que é do provedor

A divisão importa porque define onde o dado do assinante passa por infraestrutura nossa:

| Componente | SaaS | Instalação própria |
| --- | --- | --- |
| Banco de dados do painel | **nosso** | do provedor |
| Servidor **GenieACS** | **nosso** (um por provedor), salvo o provedor que o console marca como "servidor próprio" | do provedor |
| Servidor **Evolution** (ponte para o WhatsApp) | **nosso**, um único para todos os números | do provedor |
| **SGP** (ERP) | do provedor | do provedor |

Nos três primeiros, quando a edição é a SaaS, o dado de assinante **reside em infraestrutura
operada por nós**. No SGP, não: ele é o sistema de origem de parte desse dado.

## 6. Medidas de segurança que existem no produto

Só o que foi conferido no código. Cada item cita onde mora.

- **Isolamento entre provedores.** Toda tabela com dado de provedor carrega `tenant_id`, e o
  acesso passa por `tdb()`, que **lança erro** fora do escopo de um provedor em vez de devolver
  linhas (`backend/src/config/tenantScope.js`). No Postgres existe, quando ligada, segurança em
  nível de linha (`backend/src/config/rls.js`). Uma guarda estática de testes impede acesso à
  tabela escopada fora desse caminho (`backend/test/tenant-scoping.test.js`).
- **Segredos cifrados em repouso** (credenciais do ERP e do TeiaH, senhas do portal e de WiFi do assinante), com chave
  do deploy rotacionável (`backend/src/utils/secretBox.js`, `SECRET_BOX_KEY`).
- **Senhas de operador guardadas só como hash** (bcrypt); **segundo fator** TOTP com códigos de
  recuperação (`mfaService.js`, `totp.js`).
- **Bloqueio por tentativas de senha** e limitadores de taxa nas rotas de autenticação
  (`AccountLockout`, `authLimiter`).
- **Trilha de auditoria por provedor** (`audit_log`): quem fez o quê, com prazo configurável
  (inventário, seção 4).
- **Exportação sem segredos:** o arquivo que o provedor leva embora não inclui o material
  cifrado nem hashes de credencial (`tenantExportService.js`, com teste).
- **Egresso controlado:** os endereços de GenieACS e ERP que o provedor digita passam por uma
  guarda de egresso contra destinos internos, conforme o deploy (`genieacsEgress.js`).

**Não afirmo** (o código não prova): criptografia de disco, criptografia em trânsito entre o
navegador e o servidor (depende do proxy do deploy), política de backup, testes de intrusão,
certificações. Medidas de infraestrutura: [a preencher pelas partes].

## 7. Subcontratados

**Escolhidos por nós** (sub-operadores nossos — o provedor precisa ser informado):

| Destino | Dado de assinante que recebe |
| --- | --- |
| Provedor de infraestrutura em nuvem [nome] | tudo o que o serviço armazena |
| Provedor de SMTP [nome] | e-mail e texto de mensagens transacionais (operador; avisos) |
| **Nominatim / OpenStreetMap** | **o endereço do assinante** (número, rua, cidade, UF e CEP) para obter coordenadas. Fixo no código: o provedor não pode desligar |
| Mapas (OpenStreetMap ou Google) | endereço IP do navegador do operador e a área vista; não é dado de assinante |

**Escolhidos pelo provedor** (o provedor é quem contrata; o produto apenas envia, quando ele
liga a função): SGP, provedor de IA (padrão `api.z.ai`), TeiaH Valid, Focus Chat, Telegram, e a
Meta/WhatsApp. O detalhe de cada um, com o que sai, está em `docs/lista-de-compartilhamento.md`,
tabela B. **A Meta não é nosso subcontratado:** o canal WhatsApp é, por natureza, um terceiro.

[Mecanismo de aviso ao provedor sobre troca de subcontratado, e prazo para objetar: a definir.]

## 8. Direitos dos titulares (art. 18)

O pedido do assinante é dirigido ao **provedor**. O produto dá ao provedor duas ferramentas,
cada uma sob permissão própria (`customers.dossier`, `customers.erase`):

- **Dossiê de acesso:** monta o arquivo com o que o painel guarda sobre o assinante, percorrendo
  as tabelas por conta, aparelho, contrato, telefone e login — inclusive a telemetria sob o
  identificador antigo de quem trocou de ONT (`customerDataExportService.js`).
- **Eliminação:** apaga ou anonimiza o dado do assinante pelas mesmas regras de alcance do
  dossiê, e registra na trilha (`customerErasureService.js`).

**O que a eliminação não alcança**, e o provedor precisa saber: cópias em **backups**; dado já
enviado a destinos externos (o ERP é origem; IA, TeiaH e Telegram guardam por conta deles);
e o que consta no WhatsApp do próprio assinante. O operador auxilia o provedor nos pedidos nos
termos [prazo e forma: a definir].

## 9. Retenção

Os prazos que o código aplica estão em `docs/lgpd-inventario-de-dados.md`, seção 4, gerada de
`backend/src/config/retention.js`. Em resumo: o padrão é **não apagar**; a trilha de auditoria,
a telemetria, as execuções de ativação e os eventos do SGP têm janela; as mensagens e anexos do
WhatsApp têm janela por provedor, que nasce desligada; e **22 tabelas com dado de assinante não
têm poda por idade**. Na SaaS, o plano pode impor um teto à retenção da trilha e do WhatsApp,
que encurta o prazo que o provedor escolheu.

[Os prazos que o provedor pretende aplicar a cada tabela são decisão do controlador; o produto
não escolhe por ele.]

## 10. Incidentes de segurança (jurídico)

O produto **não tem mecanismo de aviso de incidente**: é processo humano. [Prazo e forma de
comunicação do operador ao controlador, e conteúdo mínimo da comunicação: a definir pelas
partes.]

## 11. Fim do contrato

- **Levar os dados:** o provedor exporta o cadastro (`GET /api/tenant/export`, ou o console, com
  registro em trilha) num arquivo JSON, sem segredos.
- **Exclusão do provedor:** só pelo console, e em passos que não se fazem por engano: o provedor
  precisa estar **suspenso**, o administrador digita o **identificador do provedor** exato, e a
  exclusão é **registrada antes** de acontecer (sem o registro, não acontece). Apaga todas as
  linhas com dado do provedor, os vínculos de pessoas a ele e os **anexos do WhatsApp em disco**.
- **O que fica:** cópias em **backups** [prazo de expiração: a definir] e o que já foi enviado a
  destinos externos.

## 12. Auditoria e prova

O provedor tem acesso à própria trilha. Direito de auditar o operador, e como: [a definir].

## 13. Assinaturas

[Local, data, partes.]
