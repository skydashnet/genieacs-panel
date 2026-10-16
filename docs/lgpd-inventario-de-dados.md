# Inventário de dados pessoais

Levantado do código, não da memória. Cada afirmação aqui aponta para o arquivo que a
sustenta, e a divisão central é fechada por teste (`backend/test/lgpd-inventario.test.js`) —
ver *Como isto continua verdadeiro*, no fim.

**O que este documento é:** o mapa de que dado pessoal o painel guarda, onde, por quê, quem
alcança e por quanto tempo fica. É o insumo factual de uma política de privacidade, de um
contrato de operador e de uma resposta a incidente.

**O que ele não é:** não é política, não é contrato, e não é parecer jurídico. Quem assina
documento deve passar por advogado — este arquivo existe para que esse advogado trabalhe
sobre o sistema real em vez de sobre texto genérico.

---

## 1. Os dois papéis, e a linha que os separa

A LGPD pergunta primeiro **quem decide** o tratamento. Neste produto a resposta não é uma só,
e a divisória está no schema, não numa opinião:

| Dado | Controlador | Operador | Onde está |
| --- | --- | --- | --- |
| Assinante de um ISP (quem tem a ONT) | **o ISP** | **nós** | as 56 tabelas escopadas por `tenant_id` |
| Operador do painel (quem faz login) | **nós** | — | `users`, `tenant_users` |
| Interessado que pediu contato na vitrine | **nós** | — | `leads` |
| Cadastro fiscal do ISP | **nós** | — | colunas `billing_*` de `tenants` |

A primeira linha é a que governa o volume: o ISP decide coletar, nós só processamos. As três
de baixo são nossas e de mais ninguém — e é por isso que a política de privacidade do
**site** e o contrato de operador com o **ISP** são documentos diferentes, com obrigações
diferentes.

A política do **site** já está publicada em `/privacidade` (texto em `frontend/src/pages/privacy.tsx`,
afirmações em `frontend/src/lib/privacy.ts`, guardadas por `frontend/test/privacy.test.ts`). O
prazo que ela declara para `leads` é lido de `/api/public/info`, da mesma função que a poda usa.
O contrato de operador (`docs/anexo-de-operador.md`) e o modelo de aviso ao assinante (`docs/modelo-de-aviso-ao-assinante.md`) são minutas para revisão jurídica.

A fronteira técnica dessa divisão é `tenant_id`: toda tabela escopada
(`backend/src/config/tenantScope.js`) carrega um provedor em cada linha, e `tdb()` **lança**
se for lida fora de escopo. Não existe linha de assinante sem dono.

---

## 2. Dado de assinante — as 56 tabelas escopadas

As 56 se dividem em exatamente dois grupos, sem sobra (é o que o teste fixa):

### 2.1 As 29 que alcançam um titular

São as que o dossiê percorre quando um assinante exerce o direito de acesso
(`backend/src/services/customerDataExportService.js`). Agrupadas pelo que guardam:

| Grupo | Tabelas | Dado pessoal |
| --- | --- | --- |
| **Cadastro e acesso** | `customer_accounts`, `customer_wifi_credentials` | identificador do cliente, senha do portal (cifrada), senha de WiFi (cifrada) |
| **Contrato no ERP** | `sgp_links`, `sgp_contacts`, `sgp_clients`, `sgp_events` | nome, documento, telefone, login PPPoE, plano, situação |
| **O aparelho** | `device_profiles`, `device_swaps`, `device_samples`, `device_sample_hours` | id da ONT, telemetria, histórico de troca |
| **Rede** | `mapping_nodes`, `mapping_edges` | posição do assinante na planta de fibra |
| **Atendimento (WhatsApp)** | `wa_conversations`, `wa_messages`, `wa_opt_outs`, `wa_satisfaction`, `wa_bot_events`, `wa_conversation_tags`, `wa_alert_state`, `wa_broadcast_recipients`, `wa_dunning_sends`, `wa_dunning_pauses` | telefone, conteúdo das mensagens, anexos, avaliação |
| **Operação** | `provisioning_runs`, `outage_incident_devices`, `maintenance_window_devices` | que aparelho foi ativado, atingido por queda ou avisado |
| **Indicações e situação financeira** | `customer_referrals`, `sgp_billing_status` | nome e telefone de quem foi indicado (ainda não é cliente), contrato e fatura em aberto mais antiga |
| **Trilha** | `audit_log` | quem fez o quê sobre aquele assinante |
| **Exportação** | `teiah_exports` | o que já saiu do painel sobre ele |
| **Consulta à TeiaH** | `teiah_consultations` | o que a TeiaH respondeu sobre o documento dele (nome, telefones, e-mails, endereços, score), guardado 30 dias para não consultar de novo |

**O dado de um titular não se junta por uma coluna só.** O código explica por quê
(`customerDataExportService.js`, docblock do topo): liga-se por `account_id` em quatro
tabelas, por `device_id` em oito, por contrato em quatro, por telefone em três e por login
PPPoE no mapa. Quem trocou de ONT tem telemetria sob o **id antigo**, recuperável só via
`device_swaps` — exportar pelo id atual perderia justamente o histórico de quem tem mais
história.

### 2.2 As 27 que não alcançam titular nenhum

Declaradas uma a uma em `SEM_DADO_DE_ASSINANTE`, cada qual com o motivo escrito ao lado:
configuração do provedor (`settings`, `app_state`, `map_settings`,
`tenant_genieacs_connections`, `provisioning_profiles`, `whatsapp_accounts`), catálogo
(`vendors`, `wifi_security_config`), equipe (`tenant_invites`, `wa_agents`), modelos,
etiquetas e campanhas (`wa_tags`, `wa_templates`, `wa_meta_templates`, `wa_broadcasts` — o
destinatário sai na tabela de recipients, que está no grupo acima), a conta do provedor
conosco (`subscriptions`, `billing_events`, `billing_charges`, `billing_invoices`,
`coupon_redemptions`, `subscription_reminder_sends`, `cancellation_requests`, `usage_peaks`,
`tenant_credits`, `credit_allocations`) e os eventos de rede por **nó do mapa**, não por pessoa
(`outage_events`, `outage_incidents`, `maintenance_windows`).

---

## 3. Dado fora do escopo do provedor — as 14 tabelas globais

Estas não têm `tenant_id` e não pertencem a ISP nenhum. **Aqui o controlador somos nós.**

| Tabela | Dado pessoal | Observação |
| --- | --- | --- |
| `users` | nome de usuário, e-mail, hash de senha, data de verificação | quem opera o painel, de qualquer provedor |
| `tenant_users` | vínculo pessoa ↔ provedor, papel | — |
| `platform_admins` | quem tem a chave do plano de controle | — |
| `platform_audit` | trilha do console | ações sobre provedores |
| `user_recovery_codes` | códigos de recuperação | credencial |
| `auth_tickets`, `impersonation_tickets` | bilhetes de sessão | efêmeros |
| `account_lockouts` | `subject` do bloqueio por tentativa | identificador de quem errou a senha |
| **`leads`** | **nome, empresa, e-mail, telefone, cidade, mensagem e notas** | **quem pediu contato na vitrine e nunca foi cliente de ninguém** |
| `tenants` (colunas `billing_*`) | razão social, CNPJ/CPF, endereço, e-mail e telefone de cobrança | cadastro fiscal do ISP |
| `plans`, `coupons`, `referral_rewards` | — | sem dado pessoal (planos, cupons e o crédito entre dois provedores) |
| `platform_alerts` | `payload`, texto sobre fatos de provedores | fila dos avisos do console por WhatsApp e e-mail. **Não auditei o conteúdo do `payload` campo a campo**; nenhuma rotina a poda |

`leads` merece destaque porque o titular **não tem relação com ISP nenhum**: não há contrato,
nem legítimo interesse em exercício, que sustente guardar o dado dele indefinidamente.

Duas das três razões que este documento listava aqui **foram corrigidas** depois de ele ser
escrito, e vale registrar o que eram:

- A tabela guardava **endereço IP**, e esse campo era **gravado e nunca lido** — `Lead.js` não o
  mencionava em nenhum método e `presentLead` não o entregava ao console, que portanto nunca o
  mostrou. Era coleta sem finalidade em exercício (art. 6º). A migração
  `0109_drop_lead_ip` **derrubou a coluna**, e `publicController.createLead` deixou de gravá-la.
  O controle de abuso da rota continua sendo o `publicLeadLimiter` e o campo-armadilha
  `website`, que nunca dependeram do IP.
- Ela **não era podada por nada**. Agora há prazo — ver a seção seguinte.

---

## 4. Retenção: o que some sozinho, e o que não some

Esta seção é **gerada** de `backend/src/config/retention.js`, o registro de onde o código lê
cada prazo. Não se edita à mão: `backend/test/retention-registry.test.js` falha se o bloco
abaixo divergir do registro, e `node backend/scripts/render-retention-doc.js` o reescreve.
Uma tabela com dado de assinante que não esteja nem numa janela nem declarada "sem prazo"
também quebra aquele teste — a retenção deixa de poder ficar sem decisão em silêncio.

O padrão do sistema é **não apagar**: um update que chega numa instalação em produção não pode
começar a apagar linha que ninguém mandou apagar. Por isso `wa_messages`, os anexos e `leads`
nascem desligados e só apagam depois de alguém escolher o prazo.

**Declarar não é decidir.** As tabelas da 4.2 estão sem prazo por idade hoje, e este documento
diz isso; escolher um número para elas é decisão de negócio que ainda não foi tomada.

<!-- retention:begin — gerado de backend/src/config/retention.js; não edite à mão, rode `node backend/scripts/render-retention-doc.js` -->

### 4.1 O que o código apaga por idade

| Dado | Tabela | Prazo padrão | Limites | Quem muda | Relógio | O que a poda poupa |
| --- | --- | --- | --- | --- | --- | --- |
| Trilha de auditoria | `audit_log` | **365 dias** | 30–3650 dias | o provedor, numa tela — e o teto do plano pode encurtar o que ele escolheu | created_at | — |
| Eventos do bot | `wa_bot_events` | **180 dias** | — | ninguém: fixo no código | created_at | — |
| Execuções de ativação | `provisioning_runs` | **90 dias** | 1–365 dias | o provedor, numa tela | updated_at | execuções ainda em andamento ou pendentes — só as terminadas saem |
| Eventos do SGP | `sgp_events` | **90 dias** | 1–365 dias | o provedor, numa tela | updated_at | eventos ainda não processados — só os processados ou ignorados saem |
| Telemetria crua | `device_samples` | **14 dias** | 1–365 dias | o provedor, numa tela | inform_at | — |
| Telemetria por hora | `device_sample_hours` | **90 dias** | 1–3650 dias | o provedor, numa tela | bucket_at | — |
| Mensagens do WhatsApp | `wa_messages` | **nenhum** — nada apaga sozinho até alguém configurar | 1–3650 dias | o provedor, numa tela — e o teto do plano pode encurtar o que ele escolheu | created_at | mensagens ainda na fila de envio; e a própria conversa (`wa_conversations`), que o varredor se recusa a tocar |
| Anexos do WhatsApp | (arquivos em disco) | **nenhum** — nada apaga sozinho até alguém configurar | 1–3650 dias | o provedor, numa tela — e o teto do plano pode encurtar o que ele escolheu | data de modificação do arquivo | arquivos ainda ligados a uma mensagem na fila de envio |
| Pedidos de contato da vitrine | `leads` | **nenhum** — nada apaga sozinho até alguém configurar | 30–3650 dias | quem tem o servidor, por variável de ambiente | created_at | pedidos que viraram contratação (`won`) — em qualquer prazo |
| Bilhetes de redefinição e verificação | `auth_tickets` | **1 dia** | — | ninguém: fixo no código | expires_at | — |
| Bilhetes de entrada do console | `impersonation_tickets` | **1 dia** | — | ninguém: fixo no código | expires_at | — |
| Bloqueio por tentativa de senha | `account_lockouts` | **1 dia** | — | ninguém: fixo no código | updated_at | bloqueios ainda em vigor |

Onde a coluna "Quem muda" diz que o teto do plano pode encurtar, a janela que **vale** é o menor dos dois, e "para sempre" vira o próprio teto (`SubscriptionService.effectiveRetention`). É a única janela que o provedor não escolheu: a tela mostra o número dele, não o que vale.

### 4.2 O que nenhuma rotina apaga por idade — 23 tabelas com dado de assinante

"Sem prazo" não é "nunca sai": várias têm saída pelo ciclo de vida, e todas as do assinante saem pela exclusão do art. 18. O que não existe é uma rotina que as apague porque ficaram velhas.

| Tabela | O que guarda, e o que a tira de lá |
| --- | --- |
| `customer_accounts` | o cadastro do assinante no portal; nunca é apagada — a exclusão do art. 18 a anonimiza no lugar |
| `customer_wifi_credentials` | a senha de WiFi do assinante (cifrada); sai só pela exclusão do art. 18 |
| `sgp_links` | o vínculo ONT↔contrato, com nome, documento e telefone vindos do ERP; sai ao desvincular o aparelho ou trocar a ONT |
| `sgp_contacts` | o contato do contrato importado do ERP; é substituído na sincronização quando o contrato muda de linha |
| `sgp_clients` | o cadastro do cliente importado do ERP (nome, documento, telefone); sai só pela exclusão do art. 18 |
| `device_profiles` | o perfil do aparelho do assinante; nenhuma rotina o apaga |
| `device_swaps` | o histórico de troca de ONT, que liga a telemetria do id antigo ao novo; nenhuma rotina o apaga |
| `mapping_nodes` | a posição do assinante na planta de fibra; sai quando o operador remove o nó ou limpa o mapa |
| `mapping_edges` | a ligação entre dois nós da planta; sai quando o operador remove a ligação ou limpa o mapa |
| `wa_conversations` | a conversa e o telefone do assinante; o varredor de mensagens se recusa a tocá-la, por desenho — sai pela exclusão do art. 18 |
| `wa_opt_outs` | quem pediu para não receber mensagens; nenhuma rotina o apaga |
| `wa_satisfaction` | a avaliação do atendimento dada pelo assinante; sai só pela exclusão do art. 18 |
| `wa_conversation_tags` | as etiquetas postas na conversa; saem ao tirar a etiqueta, ao apagá-la ou pela exclusão do art. 18 |
| `wa_alert_state` | o estado dos avisos já enviados; sai quando a condição que o gerou se recupera |
| `wa_broadcast_recipients` | quem recebeu cada campanha; a lista é trocada enquanto a campanha não começou, e a exclusão do art. 18 anonimiza a linha |
| `wa_dunning_sends` | as cobranças já enviadas ao assinante, que também evitam reenvio; saem só pela exclusão do art. 18 |
| `wa_dunning_pauses` | as pausas de cobrança pedidas para um contrato; saem quando a pausa é desfeita ou pela exclusão do art. 18 |
| `customer_referrals` | nome e telefone de quem foi indicado (que ainda não é cliente) e o nome de quem indicou; sai só pela exclusão do art. 18 |
| `sgp_billing_status` | a data da fatura em aberto mais antiga de cada contrato, sobrescrita a cada consulta ao SGP; sai só pela exclusão do art. 18 |
| `outage_incident_devices` | que aparelhos foram atingidos por uma queda; nenhuma rotina o apaga |
| `maintenance_window_devices` | que aparelhos foram avisados de uma manutenção; nenhuma rotina o apaga |
| `teiah_exports` | o registro do que já saiu do painel sobre o assinante; sai só pela exclusão do art. 18 |
| `teiah_consultations` | a resposta da TeiaH sobre um CPF/CNPJ, guardada 30 dias para não consultar de novo; as vencidas saem a cada nova consulta e tudo sai pela exclusão do art. 18 |

### 4.3 O mesmo, nas 7 tabelas globais com dado pessoal e sem janela (somos o controlador)

| Tabela | O que guarda |
| --- | --- |
| `users` | quem opera o painel, de qualquer provedor; nenhuma rotina apaga a conta |
| `tenant_users` | o vínculo pessoa↔provedor; nenhuma rotina o apaga |
| `platform_admins` | quem tem a chave do plano de controle; nenhuma rotina o apaga |
| `user_recovery_codes` | os códigos de recuperação do segundo fator (credencial); nenhuma rotina os apaga |
| `platform_audit` | a trilha do console sobre os provedores; nenhuma rotina a poda |
| `platform_alerts` | a fila dos avisos do console; o `payload` é texto sobre fatos de provedores e seu conteúdo não foi auditado campo a campo; nenhuma rotina a poda |
| `tenants` | nas colunas `billing_*`, o cadastro fiscal do provedor (razão social, CNPJ/CPF, endereço, e-mail, telefone); fica enquanto o provedor existir |

<!-- retention:end -->

---

## 5. Os direitos do titular, e o que o painel já faz

| Direito (art. 18) | Implementado | Onde |
| --- | --- | --- |
| Acesso / portabilidade | **sim** | botão *Baixar o dossiê*, na tela do aparelho (`customer-lgpd.tsx`) |
| Eliminação | **sim** | botão *Apagar os dados*, mesma tela (`customerErasureService.js`) |
| Confirmação de tratamento | sim, pelo dossiê | — |
| Correção | parcial | pela tela do aparelho e pelo ERP |
| Informação sobre compartilhamento | **não** | não há documento que liste os terceiros |
| Revogação de consentimento | **não se aplica diretamente** | a base legal do dado de assinante é contrato, não consentimento |

Duas propriedades do que já existe valem registro, porque são as que tornam o par confiável:

1. **O dossiê e a exclusão respondem à mesma pergunta por construção.** As duas chamam
   `alcanceDoAssinante`, uma função só. O comentário dela explica o motivo: se cada uma
   reconstruísse o conjunto por conta própria, o dia em que uma ganhasse um caminho novo a
   outra ficaria para trás em silêncio — e o silêncio tem duas formas ruins, um export que
   entrega menos do que existe e uma exclusão que deixa para trás o que o export mostrou.
2. **Os dois atos entram na trilha de auditoria.** Quem pediu, quando, sobre quem.

E uma limitação que o próprio arquivo declara: a conta **aposentada** perde `device_id` e
`identity_hash`, então o dossiê de quem foi aposentado é estruturalmente incompleto. O
manifesto do arquivo diz isso em `notCollected`, para que ninguém conclua daqui a dois anos
que o painel escondeu algo.

---

## 6. Terceiros que recebem dado pessoal

A lista completa, com o que sai para cada destino, quem o escolhe e em que condição, é
**`docs/lista-de-compartilhamento.md`**. Ela substitui a tabela que esta seção trazia, que tinha
seis destinos quando o código alcança bem mais, e que errava a divisão de quem opera o quê:

- Dizia que GenieACS, SGP e WhatsApp eram "sistemas do próprio ISP, não subcontratação nossa".
  **Na SaaS isso é falso para dois deles:** a plataforma hospeda o GenieACS de cada provedor
  (salvo o que o console marca como servidor próprio) e opera o servidor Evolution único que
  atende todos os números. Nesses dois nós somos **operador** do dado de assinante, e o anexo
  de operador precisa dizê-lo. O SGP é de fato o ERP do provedor.
- Dizia que "os três últimos são escolha do deployment". O provedor de IA, o TeiaH e o Focus
  Chat são configuração **por provedor**; só o SMTP é do deploy inteiro.
- Omitia: TeiaH (que recebe endereço e dívida, e o CPF na consulta), Nominatim (que recebe o
  **endereço do assinante** e que o provedor não pode desligar), BrasilAPI/CNPJ.ws/ReceitaWS/
  ViaCEP, Telegram, Meta, Focus Chat e os servidores de mapa.

`backend/test/sharing-list.test.js` varre a fonte atrás de endereços `https://…` e falha quando
o código passa a alcançar um host que a lista não cita.

---

## 7. O que este levantamento achou

**Confirmado e correto:** as 56 tabelas escopadas se dividem exatamente em 27 sem titular +
29 alcançadas pelo dossiê. Nenhuma órfã. Conferido por script contra o código, não por
leitura.

**As lacunas, em ordem de risco:**

1. **Nada mantinha essa divisão verdadeira.** Não havia teste. A próxima tabela escopada que
   alguém acrescentasse cairia em nenhum dos dois baldes **em silêncio** — e o efeito seria
   um dossiê que entrega menos do que existe e uma exclusão que deixa dado para trás. É a
   lacuna que este trabalho fecha, com `backend/test/lgpd-inventario.test.js`.
2. ~~**`leads` não tem retenção e guarda IP.**~~ **Fechado.** O IP era gravado e nunca lido, e
   a coluna foi derrubada (`0109_drop_lead_ip`); a retenção existe e é configurável por
   `LEAD_RETENTION_DAYS`, desligada por padrão. **O que esta correção não alcança:**
   `createLead` manda o conteúdo do lead para a equipe por e-mail
   (`PlatformNotifyService.notifyTeam`), e apagar a linha não recolhe aquela cópia. Quem lê
   "temos retenção de leads" precisa saber onde ela termina.
3. ~~**A retenção não está declarada.**~~ **Declarada, no estado em que está.** A seção 4 é
   gerada do registro `backend/src/config/retention.js`, e um teste a mantém igual a ele. O
   que ela revelou: **20 das 27 tabelas com dado de assinante não têm poda por idade**
   (4.2), e `wa_messages`/anexos têm janela por provedor, mas nascem desligadas (padrão 0).
   **Declarar não resolveu:** se essas tabelas devem ter prazo é decisão de negócio ainda
   não tomada. Duas correções minhas ao texto anterior: a tabela já omitiu os bilhetes de
   sessão, o bloqueio de login e o **teto do plano**, que encurta em silêncio a janela da
   trilha e do WhatsApp.
4. ~~**Não há lista de compartilhamento publicada.**~~ **Existe**: `docs/lista-de-compartilhamento.md`, mantida pelo teste que varre a fonte. O que falta é publicá-la ao titular: a política do site cobre os dados da plataforma, e o aviso ao assinante é do provedor (modelo em `docs/modelo-de-aviso-ao-assinante.md`).

---

## 8. Como isto continua verdadeiro

Um inventário escrito à mão envelhece no primeiro commit depois dele. O que impede isso aqui
é `backend/test/lgpd-inventario.test.js`: ele exige que **toda** tabela escopada esteja em
exatamente um dos dois lugares — declarada em `SEM_DADO_DE_ASSINANTE`, ou alcançada pelo
dossiê. Acrescentar uma tabela escopada sem classificá-la quebra a suíte, com a mensagem
dizendo qual é e o que fazer.

O teste fixa a **divisão**, não os números: ele não afirma "são 56", porque travar a contagem
faria toda tabela nova quebrar a suíte por motivo errado. O que ele não deixa passar é uma
tabela em nenhum dos dois lados — e a mensagem de falha manda atualizar este documento.

A retenção tem a guarda equivalente, `backend/test/retention-registry.test.js`: toda tabela
com dado de assinante precisa estar numa janela ou declarada sem prazo, e o bloco da seção 4
precisa ser igual ao gerado do registro.

As contagens aqui (56 / 27 / 29) são, portanto, uma fotografia de hoje. Para refazê-la:

```
cd backend && node --input-type=module -e "
const { SCOPED_TABLES } = await import('./src/config/tenantScope.js');
const { SEM_DADO_DE_ASSINANTE } = await import('./src/services/customerDataExportService.js');
console.log('escopadas:', SCOPED_TABLES.size, '| sem titular:', Object.keys(SEM_DADO_DE_ASSINANTE).length);
"
```
