/**
 * Por quanto tempo cada dado pessoal fica guardado — num lugar só.
 *
 * Os números moravam soltos: `AUDIT_RETENTION_*` e um `180` literal no
 * scheduler, `clampNumber(…, 1, 365, 90)` em dois serviços, `14/90` no
 * histórico de aparelhos, `3650` repetido em três arquivos, `STALE_MS` no
 * bloqueio de login. E o documento do inventário (`docs/lgpd-inventario-de-dados.md`)
 * os repetia à mão — por isso a referência `schedulerService.js:457` virou
 * `:579` em dias, sem que nada avisasse.
 *
 * Aqui eles ficam como dado. Os serviços importam daqui os números que aplicam
 * (nenhum valor mudou ao mudar de casa), o documento é GERADO deste registro
 * (`scripts/render-retention-doc.js`) e `test/retention-registry.test.js`
 * exige duas coisas: que toda tabela com dado de titular esteja em `WINDOWS` ou
 * em `SEM_PRAZO` — tabela nova sem decisão quebra a suíte, em vez de passar
 * calada —, e que o documento bata com o que está escrito aqui.
 *
 * **Isto declara a retenção; não a decide.** Tabela sem janela continua sem
 * janela: `SEM_PRAZO` diz isso com todas as letras. Escolher um prazo para ela
 * é decisão de negócio, e nenhuma entra aqui sem alguém escolher o número.
 */

/** Dez anos. Acima disso o número é um engano, não uma política. */
export const MAX_RETENTION_DAYS = 3650;

/** A trilha de auditoria de cada provedor. */
export const AUDIT_RETENTION = Object.freeze({ defaultDays: 365, minDays: 30, maxDays: MAX_RETENTION_DAYS });

/** `wa_bot_events`: o relatório do bot olha no máximo 90 dias para trás. */
export const BOT_EVENTS_RETENTION_DAYS = 180;

/** Execuções de ativação (`provisioning_runs`) e eventos do SGP (`sgp_events`). */
export const RUN_RETENTION = Object.freeze({ defaultDays: 90, minDays: 1, maxDays: 365 });
export const SGP_EVENT_RETENTION = Object.freeze({ defaultDays: 90, minDays: 1, maxDays: 365 });

/** Telemetria de aparelhos: amostra crua e agregado por hora. */
export const RAW_SAMPLE_RETENTION = Object.freeze({ defaultDays: 14, minDays: 1, maxDays: 365 });
export const HOURLY_SAMPLE_RETENTION = Object.freeze({ defaultDays: 90, minDays: 1, maxDays: MAX_RETENTION_DAYS });

/** Pedidos de contato da vitrine (`leads`): nasce desligado, `LEAD_RETENTION_DAYS`. */
export const LEAD_RETENTION = Object.freeze({ defaultDays: 0, minDays: 30, maxDays: MAX_RETENTION_DAYS });

/** Bilhetes de sessão e bloqueio de login: efêmeros, fixos no código. */
export const TICKET_GRACE_DAYS = 1;
export const LOCKOUT_STALE_DAYS = 1;

/**
 * Cada janela que algo no código de fato aplica.
 *
 * - `defaultDays: 0` quer dizer "nenhuma rotina apaga" — o padrão do sistema
 *   para tudo que o provedor não escolheu.
 * - `configuredBy`: `provider` (o provedor muda numa tela), `provider-capped`
 *   (idem, e o teto do plano encurta em silêncio — `SubscriptionService.effectiveRetention`),
 *   `deployment` (variável de ambiente de quem tem o servidor) ou `fixed`
 *   (constante no código).
 * - `spares`: o que a poda deixa passar de propósito.
 * - `source`: o arquivo que lê o número da janela, relativo a `backend/src/`. O teste
 *   confere que ele existe e que importa este registro.
 */
export const WINDOWS = Object.freeze([
  {
    id: 'audit',
    label: 'Trilha de auditoria',
    tables: ['audit_log'],
    ...AUDIT_RETENTION,
    configuredBy: 'provider-capped',
    clock: 'created_at',
    spares: null,
    personalData: 'quem fez o quê, e sobre qual assinante',
    source: 'services/schedulerService.js'
  },
  {
    id: 'bot-events',
    label: 'Eventos do bot',
    tables: ['wa_bot_events'],
    defaultDays: BOT_EVENTS_RETENTION_DAYS,
    minDays: null,
    maxDays: null,
    configuredBy: 'fixed',
    clock: 'created_at',
    spares: null,
    personalData: 'o que o robô respondeu a cada conversa',
    source: 'services/schedulerService.js'
  },
  {
    id: 'provisioning-runs',
    label: 'Execuções de ativação',
    tables: ['provisioning_runs'],
    ...RUN_RETENTION,
    configuredBy: 'provider',
    clock: 'updated_at',
    spares: 'execuções ainda em andamento ou pendentes — só as terminadas saem',
    personalData: 'que aparelho foi ativado, e quando',
    source: 'services/provisioningService.js'
  },
  {
    id: 'sgp-events',
    label: 'Eventos do SGP',
    tables: ['sgp_events'],
    ...SGP_EVENT_RETENTION,
    configuredBy: 'provider',
    clock: 'updated_at',
    spares: 'eventos ainda não processados — só os processados ou ignorados saem',
    personalData: 'o que o ERP avisou sobre o contrato do assinante',
    source: 'services/sgpService.js'
  },
  {
    id: 'device-samples',
    label: 'Telemetria crua',
    tables: ['device_samples'],
    ...RAW_SAMPLE_RETENTION,
    configuredBy: 'provider',
    clock: 'inform_at',
    spares: null,
    personalData: 'sinal, temperatura e estado da ONT do assinante',
    source: 'services/deviceHistoryService.js'
  },
  {
    id: 'device-sample-hours',
    label: 'Telemetria por hora',
    tables: ['device_sample_hours'],
    ...HOURLY_SAMPLE_RETENTION,
    configuredBy: 'provider',
    clock: 'bucket_at',
    spares: null,
    personalData: 'o agregado por hora da telemetria da ONT',
    source: 'services/deviceHistoryService.js'
  },
  {
    id: 'wa-messages',
    label: 'Mensagens do WhatsApp',
    tables: ['wa_messages'],
    defaultDays: 0,
    minDays: 1,
    maxDays: MAX_RETENTION_DAYS,
    configuredBy: 'provider-capped',
    clock: 'created_at',
    spares: 'mensagens ainda na fila de envio; e a própria conversa (`wa_conversations`), que o varredor se recusa a tocar',
    personalData: 'telefone e o conteúdo do atendimento',
    source: 'services/waMessageSweeper.js'
  },
  {
    id: 'wa-media',
    label: 'Anexos do WhatsApp',
    tables: [],
    defaultDays: 0,
    minDays: 1,
    maxDays: MAX_RETENTION_DAYS,
    configuredBy: 'provider-capped',
    clock: 'data de modificação do arquivo',
    spares: 'arquivos ainda ligados a uma mensagem na fila de envio',
    personalData: 'fotos, áudios e documentos que o assinante mandou (arquivos em disco, não tabela)',
    source: 'services/waMediaSweeper.js'
  },
  {
    id: 'leads',
    label: 'Pedidos de contato da vitrine',
    tables: ['leads'],
    ...LEAD_RETENTION,
    configuredBy: 'deployment',
    clock: 'created_at',
    spares: 'pedidos que viraram contratação (`won`) — em qualquer prazo',
    personalData: 'nome, empresa, e-mail, telefone, cidade e mensagem de quem pediu contato',
    source: 'utils/leadRetention.js'
  },
  {
    id: 'auth-tickets',
    label: 'Bilhetes de redefinição e verificação',
    tables: ['auth_tickets'],
    defaultDays: TICKET_GRACE_DAYS,
    minDays: null,
    maxDays: null,
    configuredBy: 'fixed',
    clock: 'expires_at',
    spares: null,
    personalData: 'hash do token de quem pediu redefinir a senha ou verificar o e-mail',
    source: 'models/AuthTicket.js'
  },
  {
    id: 'impersonation-tickets',
    label: 'Bilhetes de entrada do console',
    tables: ['impersonation_tickets'],
    defaultDays: TICKET_GRACE_DAYS,
    minDays: null,
    maxDays: null,
    configuredBy: 'fixed',
    clock: 'expires_at',
    spares: null,
    personalData: 'hash do token que leva o administrador da plataforma ao painel de um provedor',
    source: 'models/ImpersonationTicket.js'
  },
  {
    id: 'account-lockouts',
    label: 'Bloqueio por tentativa de senha',
    tables: ['account_lockouts'],
    defaultDays: LOCKOUT_STALE_DAYS,
    minDays: null,
    maxDays: null,
    configuredBy: 'fixed',
    clock: 'updated_at',
    spares: 'bloqueios ainda em vigor',
    personalData: 'o identificador de quem errou a senha',
    source: 'models/AccountLockout.js'
  }
]);

/**
 * As tabelas com dado de TITULAR que nenhuma rotina poda **por idade**.
 *
 * "Sem prazo" não quer dizer "nunca sai": várias têm saída por ciclo de vida
 * (desvincular um aparelho, apagar uma campanha, a condição que se recupera) e
 * todas as do assinante saem pela exclusão do art. 18
 * (`customerErasureService`). O que não existe é uma rotina que as apague porque
 * ficaram velhas — então, sem uma dessas ações, a linha fica.
 *
 * Esta lista é a declaração de um estado, não uma recomendação. O texto de cada
 * uma diz o que a linha guarda e o que a tira de lá; escolher um prazo é
 * decisão de negócio e não está tomada. Cada afirmação foi conferida contra os
 * `del()` do código — se uma passar a ter poda por idade, ela sai daqui e entra
 * em `WINDOWS`.
 */
export const SEM_PRAZO = Object.freeze({
  // Cadastro e acesso
  customer_accounts: 'o cadastro do assinante no portal; nunca é apagada — a exclusão do art. 18 a anonimiza no lugar',
  customer_wifi_credentials: 'a senha de WiFi do assinante (cifrada); sai só pela exclusão do art. 18',
  // Contrato no ERP
  sgp_links: 'o vínculo ONT↔contrato, com nome, documento e telefone vindos do ERP; sai ao desvincular o aparelho ou trocar a ONT',
  sgp_contacts: 'o contato do contrato importado do ERP; é substituído na sincronização quando o contrato muda de linha',
  sgp_clients: 'o cadastro do cliente importado do ERP (nome, documento, telefone); sai só pela exclusão do art. 18',
  // O aparelho
  device_profiles: 'o perfil do aparelho do assinante; nenhuma rotina o apaga',
  device_swaps: 'o histórico de troca de ONT, que liga a telemetria do id antigo ao novo; nenhuma rotina o apaga',
  // Rede
  mapping_nodes: 'a posição do assinante na planta de fibra; sai quando o operador remove o nó ou limpa o mapa',
  mapping_edges: 'a ligação entre dois nós da planta; sai quando o operador remove a ligação ou limpa o mapa',
  // Atendimento (WhatsApp)
  wa_conversations: 'a conversa e o telefone do assinante; o varredor de mensagens se recusa a tocá-la, por desenho — sai pela exclusão do art. 18',
  wa_opt_outs: 'quem pediu para não receber mensagens; nenhuma rotina o apaga',
  wa_satisfaction: 'a avaliação do atendimento dada pelo assinante; sai só pela exclusão do art. 18',
  wa_conversation_tags: 'as etiquetas postas na conversa; saem ao tirar a etiqueta, ao apagá-la ou pela exclusão do art. 18',
  wa_alert_state: 'o estado dos avisos já enviados; sai quando a condição que o gerou se recupera',
  wa_broadcast_recipients: 'quem recebeu cada campanha; a lista é trocada enquanto a campanha não começou, e a exclusão do art. 18 anonimiza a linha',
  wa_dunning_sends: 'as cobranças já enviadas ao assinante, que também evitam reenvio; saem só pela exclusão do art. 18',
  wa_dunning_pauses: 'as pausas de cobrança pedidas para um contrato; saem quando a pausa é desfeita ou pela exclusão do art. 18',
  // Indicações e situação financeira
  customer_referrals: 'nome e telefone de quem foi indicado (que ainda não é cliente) e o nome de quem indicou; sai só pela exclusão do art. 18',
  sgp_billing_status: 'a data da fatura em aberto mais antiga de cada contrato, sobrescrita a cada consulta ao SGP; sai só pela exclusão do art. 18',
  // Operação
  outage_incident_devices: 'que aparelhos foram atingidos por uma queda; nenhuma rotina o apaga',
  maintenance_window_devices: 'que aparelhos foram avisados de uma manutenção; nenhuma rotina o apaga',
  // Exportação
  teiah_exports: 'o registro do que já saiu do painel sobre o assinante; sai só pela exclusão do art. 18',
  teiah_consultations: 'a resposta da TeiaH sobre um CPF/CNPJ, guardada 30 dias para não consultar de novo; as vencidas saem a cada nova consulta e tudo sai pela exclusão do art. 18'
});

/**
 * Tabelas globais com dado pessoal e sem poda por idade — onde somos o
 * controlador. `leads` e os bilhetes têm janela e estão em `WINDOWS`.
 */
export const GLOBAIS_SEM_PRAZO = Object.freeze({
  users: 'quem opera o painel, de qualquer provedor; nenhuma rotina apaga a conta',
  tenant_users: 'o vínculo pessoa↔provedor; nenhuma rotina o apaga',
  platform_admins: 'quem tem a chave do plano de controle; nenhuma rotina o apaga',
  user_recovery_codes: 'os códigos de recuperação do segundo fator (credencial); nenhuma rotina os apaga',
  platform_audit: 'a trilha do console sobre os provedores; nenhuma rotina a poda',
  platform_alerts: 'a fila dos avisos do console; o `payload` é texto sobre fatos de provedores e seu conteúdo não foi auditado campo a campo; nenhuma rotina a poda',
  tenants: 'nas colunas `billing_*`, o cadastro fiscal do provedor (razão social, CNPJ/CPF, endereço, e-mail, telefone); fica enquanto o provedor existir'
});
