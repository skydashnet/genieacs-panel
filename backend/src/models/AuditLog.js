import { tdb, tinsert } from '../config/database.js';

/**
 * A trilha das ações sensíveis.
 *
 * Três regras, e as três existem porque a alternativa é pior de um jeito que só
 * aparece meses depois:
 *
 * 1. **Gravar nunca derruba a ação.** Se a trilha falhar, a revelação de senha
 *    que ela ia registrar já aconteceu — devolver 500 ali faria o operador
 *    tentar de novo e produzir duas revelações e zero registros. O erro vai
 *    para o log do processo e a resposta segue.
 * 2. **Nada de segredo em `detail`.** A trilha registra que a senha foi
 *    revelada, não qual era. A primeira coisa é o que permite auditar; a
 *    segunda faria da auditoria o maior repositório de segredos em claro do
 *    produto — e um que ninguém pensa em proteger, porque "é só log".
 * 3. **Só leitura depois.** Não existe update nem delete linha a linha aqui, de
 *    propósito. O que existe é a poda por idade, que apaga em bloco pelo tempo
 *    e não escolhe o quê — uma trilha em que se apaga uma linha específica não
 *    serve para nada.
 */
class AuditLog {
  /** As ações que o painel registra. Nome estável: a tela filtra por ele. */
  static ACTIONS = Object.freeze({
    PORTAL_PASSWORD_REVEALED: 'portal_password.revealed',
    PORTAL_PASSWORD_RESET: 'portal_password.reset',
    GENIEACS_URL_CHANGED: 'genieacs.url_changed',
    GENIEACS_AUTH_CHANGED: 'genieacs.auth_changed',
    GENIEACS_CONNECTION_CHANGED: 'genieacs.connection_changed',
    GENIEACS_AGENT_TOKEN_GENERATED: 'genieacs.agent_token_generated',
    GENIEACS_OWNERSHIP_CHANGED: 'genieacs.ownership_changed',
    OPERATOR_ROLE_CHANGED: 'operator.role_changed',
    OPERATOR_REMOVED: 'operator.removed',
    OPERATOR_CREATED: 'operator.created',
    INVITE_CREATED: 'invite.created',
    INVITE_ACCEPTED: 'invite.accepted',
    INVITE_REVOKED: 'invite.revoked',
    TENANT_STATUS_CHANGED: 'tenant.status_changed',
    // O operador rodou o diagnóstico da integração de WhatsApp. Fica na trilha
    // porque ele faz o painel emitir requisições de saída para endereços que
    // quem administra escolheu — inclusive contra a própria URL pública —, e é
    // a única ação dessa família alcançável com zero números conectados, isto é,
    // a mais fácil de disparar. O `detail` guarda o veredito de cada passo e o
    // endereço do webhook já redigido; nunca a chave admin nem token nenhum.
    WHATSAPP_CONFIG_TESTED: 'whatsapp.config_tested',
    // A integração do Focus Chat foi salva. O `detail` diz se ficou ativa e se
    // o token mudou, nunca o token.
    FOCUSCHAT_CONFIG_UPDATED: 'focuschat.config_updated',
    // O bot ou o grupo do Telegram dos alertas mudou. `{ tokenChanged, chatId }`
    // — o grupo não é segredo e é o que se procura; o token nunca vem aqui.
    ALERTS_TELEGRAM_CHANGED: 'alerts.telegram_changed',
    // A régua de cobrança automática foi ligada, desligada ou teve as etapas
    // trocadas. Ligar é o ato que faz o painel mandar mensagem sozinho para
    // centenas de assinantes, e a pergunta "quem ligou isso?" tem que ter
    // resposta. O `detail` guarda as etapas e os limites, nunca um telefone.
    WHATSAPP_DUNNING_ENABLED: 'whatsapp.dunning_enabled',
    WHATSAPP_DUNNING_DISABLED: 'whatsapp.dunning_disabled',
    WHATSAPP_DUNNING_SAVED: 'whatsapp.dunning_saved',
    // Uma campanha de aviso foi criada (rascunho ou agendada). O `detail`
    // guarda os filtros e quantos vão receber, nunca um telefone.
    WHATSAPP_CAMPAIGN_CREATED: 'whatsapp.campaign_created',
    WHATSAPP_CAMPAIGN_UPDATED: 'whatsapp.campaign_updated',
    WHATSAPP_REFERRAL_UPDATED: 'whatsapp.referral_updated',
    // A equipe pôs um número no "não perturbe" ou mudou os tipos de comunicação
    // que ele bloqueia. O `detail` guarda os tipos, nunca o telefone.
    WHATSAPP_OPT_OUT_CHANGED: 'whatsapp.opt_out_changed',
    WHATSAPP_TEMPLATE_AI_DRAFT: 'whatsapp.template_ai_draft',
    // A conta de portal do assinante ANTERIOR de uma ONT foi encerrada, porque
    // o aparelho passou a reportar outro login PPPoE. É destrutivo — o Customer
    // ID muda, a senha do portal é recunhada e o vínculo com o ERP é apagado —
    // e por muito tempo produziu só um `console.warn`, que é log de processo e
    // some. O ISP que perguntasse "por que meu assinante perdeu o acesso" não
    // tinha onde olhar.
    SUBSCRIBER_ACCOUNT_RETIRED: 'subscriber_account.retired',
    WHATSAPP_BOT_TRUST_UNLOCK: 'whatsapp.bot_trust_unlock',
    // Uma fatura do SGP foi mandada ao cliente pelo painel da conversa.
    WHATSAPP_INVOICE_SENT: 'whatsapp.invoice_sent',
    // Os clientes de uma queda em massa foram avisados por WhatsApp.
    OUTAGE_NOTIFIED: 'outage.notified',
    // Manutenção programada: agendar, avisar os clientes e cancelar mexem com
    // o que o assinante recebe no WhatsApp.
    MAINTENANCE_SCHEDULED: 'maintenance.scheduled',
    MAINTENANCE_NOTIFIED: 'maintenance.notified',
    MAINTENANCE_CANCELLED: 'maintenance.cancelled',
    TENANT_EXPORTED: 'tenant.exported',
    // O cadastro fiscal do provedor mudou — razão social, CNPJ, endereço,
    // contato de cobrança. Registra QUAIS campos, nunca os valores: a trilha
    // responde "quem mexeu no meu cadastro", e para isso o nome do campo basta.
    // Guardar os valores faria dela uma segunda cópia do cadastro, com
    // retenção maior que a do original.
    TENANT_BILLING_CHANGED: 'tenant.billing_changed',
    // O dossiê de UM assinante saiu daqui. Ação própria e não `tenant.exported`
    // porque a frase que o ISP lê na trilha dele tem que descrever o que
    // aconteceu, e "provedor exportado" não descreve os dados de uma pessoa.
    // O `detail` guarda contagens, nunca conteúdo: a trilha está DENTRO do
    // export do provedor e é podada por idade, então um detalhe com dado
    // pessoal seria uma segunda cópia do dossiê, com retenção própria.
    CUSTOMER_DATA_EXPORTED: 'customer_data.exported',
    // E o dossiê de UM assinante deixou de existir. Duas ações e não uma com
    // um campo `scope`, pelo mesmo motivo que `password_reset.requested` e
    // `.completed` são duas: a tela filtra pelo nome da ação, e "quem apagou um
    // assinante este mês" é a pergunta que alguém vai fazer sozinha.
    //
    // Esta é a única linha da trilha que sobrevive ao seu próprio assunto: a
    // exclusão esvazia a conta e não toca em `audit_log`, então o `subject_id`
    // daqui passa a apontar para uma linha onde não há mais ninguém. É o estado
    // certo — continua dizendo que a conta 412 foi apagada, no dia tal, por
    // fulano, e já não há como saber quem era 412.
    CUSTOMER_DATA_ERASED: 'customer_data.erased',
    // O cadastro de um cliente foi corrigido no painel, ou um cliente foi
    // criado nele. O `detail` guarda QUAIS campos, nunca os valores — pelo
    // mesmo motivo de `tenant.billing_changed`.
    CONTACT_UPDATED: 'contact.updated',
    CONTACT_CREATED: 'contact.created',
    // O CPF/CNPJ de quem ia ser cadastrado foi consultado na TeiaH Valid — um
    // birô de dados pessoais. O `detail` diz se achou, nunca o documento nem
    // o que veio.
    CONTACT_TEIAH_LOOKUP: 'contact.teiah_lookup',
    CONTACT_TEIAH_APPLIED: 'contact.teiah_applied',
    // Um título em aberto foi mandado ao cliente pelo WhatsApp, pela ficha. O
    // `detail` diz qual título e qual conversa, nunca o texto (tem o PIX).
    CONTACT_INVOICE_SENT: 'contact.invoice_sent',
    // "Sincronizar" na ficha: o SGP consultado de novo para um cliente e as
    // ONTs dos contratos chamadas a reportar. O `detail` guarda contratos e
    // quantidades, nunca dados do cadastro.
    CONTACT_SYNCED: 'contact.synced',
    // "Receber" na ficha: um título baixado no SGP. O `detail` diz qual
    // título, o valor e a forma, e se o comprovante saiu — nunca o nome.
    CONTACT_INVOICE_SETTLED: 'contact.invoice_settled',
    // A base de contatos saiu numa planilha, ou entrou por uma. O `detail`
    // guarda quantidades e filtros, nunca uma linha da planilha.
    CONTACTS_EXPORTED: 'contacts.exported',
    CONTACTS_IMPORTED: 'contacts.imported',
    // A lista de equipamentos saiu numa planilha. Quantas linhas e o recorte
    // (estado, foco, se houve busca) — nunca o texto buscado nem uma linha.
    DEVICES_EXPORTED: 'devices.exported',
    // A assinatura mudou de plano ou de estado. Gravada NO provedor, com
    // `actorKind: 'platform'`, pelo mesmo motivo da suspensão: quem vai
    // perguntar "por que meu painel ficou só leitura" é o ISP, e a resposta
    // tem que estar onde ele olha.
    SUBSCRIPTION_CHANGED: 'subscription.changed',
    // O provedor mudou o próprio nome — o que aparece na barra lateral, na
    // tela de login e na aba do navegador.
    TENANT_RENAMED: 'tenant.renamed',
    // E o endereço em que o painel dele responde mudou — feito de fora, pelo
    // plano de controle, porque o slug é o subdomínio e só o console o troca.
    // Ação própria e não `TENANT_RENAMED`: a frase "provedor renomeado" não
    // descreve um endereço que mudou, e é a frase que o ISP vai ler na trilha
    // dele quando o painel parar de responder no lugar de sempre.
    TENANT_SLUG_CHANGED: 'tenant.slug_changed',
    LOGIN_EMAIL_CHANGED: 'login_email.changed',
    // O endereço de login foi PROVADO — alguém abriu o que foi mandado para
    // ele. É o que separa "esta conta tem um endereço" de "este endereço é
    // desta pessoa", e é a linha que a redefinição de senha exige antes de
    // mandar qualquer coisa.
    LOGIN_EMAIL_VERIFIED: 'login_email.verified',
    // Pediram uma senha nova para esta conta. Registrada mesmo quando ninguém
    // completa: para quem é dono da conta, "alguém pediu para redefinir minha
    // senha" é o aviso, e ele só serve se estiver escrito no momento do pedido.
    PASSWORD_RESET_REQUESTED: 'password_reset.requested',
    // E a senha de fato mudou por esse caminho. Duas linhas e não uma porque
    // respondem a perguntas diferentes, e a distância entre elas é a informação:
    // um pedido sem conclusão é ruído, um pedido concluído que ninguém fez é
    // uma invasão.
    PASSWORD_RESET_COMPLETED: 'password_reset.completed',
    // Alguém do plano de controle abriu uma sessão de leitura NESTE provedor.
    // Gravada aqui, e não só na trilha da plataforma, porque quem tem direito
    // de saber que entraram no painel dele é o dono do painel — e a trilha da
    // plataforma é a nossa, ele não a lê.
    PLATFORM_IMPERSONATED: 'platform.impersonated',
    // O que o operador fez NA ONT. Até aqui só a senha do portal deixava
    // linha; reiniciar, mudar WAN, Wi-Fi e credencial, e apagar o aparelho do
    // ACS não deixavam nada — e é a primeira pergunta de quem recebe a ligação
    // do assinante: "quem mexeu no meu roteador?". O `detail` guarda QUAIS
    // campos, nunca os valores: a senha do Wi-Fi e a credencial da ONT não
    // podem ter uma segunda cópia com a retenção da trilha. "Forçar contato"
    // fica de fora de propósito: ele só pede à ONT que se reporte, e não muda
    // nada nela.
    DEVICE_REBOOTED: 'device.rebooted',
    DEVICE_DELETED: 'device.deleted',
    DEVICE_WAN_CHANGED: 'device.wan_changed',
    DEVICE_WAN_ADDED: 'device.wan_added',
    DEVICE_WIFI_CHANGED: 'device.wifi_changed',
    DEVICE_CREDENTIALS_CHANGED: 'device.credentials_changed',
    // A ONT voltou de fábrica: sem PPPoE, sem Wi-Fi, assinante sem internet até
    // alguém reprovisionar. A linha que mais importa desta família.
    DEVICE_FACTORY_RESET: 'device.factory_reset',
    // Ping ou traceroute pedido à ONT. Não muda a configuração dela, e entra
    // mesmo assim: é tráfego saindo da rede do cliente, e o destino — que não
    // é segredo — é justamente o que quem investiga quer ler.
    DEVICE_DIAGNOSTIC_STARTED: 'device.diagnostic_started',
    // Firmware trocado: a ONT grava e reinicia. O detalhe diz o arquivo e as
    // duas versões — a de antes é a que se procura quando algo parou depois.
    DEVICE_FIRMWARE_UPGRADE: 'device.firmware_upgrade',
    // Firmware enviado ao GenieACS pelo painel, e apagado de lá. Não mexe em
    // ONT nenhuma, e entra mesmo assim: o arquivo é o que um lote manda gravar
    // em centenas delas, e "quem pôs este arquivo aqui" é a primeira pergunta
    // quando um lote dá errado. O detalhe diz o modelo, a versão e o tamanho.
    DEVICE_FIRMWARE_UPLOAD: 'device.firmware_upload',
    DEVICE_FIRMWARE_DELETE: 'device.firmware_delete',
    // Uma ação em vários aparelhos: UMA linha por lote, com a ação, as
    // contagens e o recorte da lista. Uma linha por aparelho afogaria a trilha
    // e esconderia justamente que foi um lote.
    DEVICE_BATCH_ACTION: 'device.batch_action',
    // Login em duas etapas da própria conta. Nunca o segredo nem os códigos:
    // só que foi ligado, desligado, que os códigos foram trocados — e, o que o
    // dono mais quer ver, que alguém entrou com um código de recuperação (o
    // celular sumiu).
    USER_MFA_ENABLED: 'user.mfa_enabled',
    USER_MFA_DISABLED: 'user.mfa_disabled',
    USER_MFA_RECOVERY_REGENERATED: 'user.mfa_recovery_regenerated',
    USER_MFA_RECOVERY_USED: 'user.mfa_recovery_used',
    // A conta foi travada por tentativas erradas demais — de senha ou de
    // código (`models/AccountLockout.js`). Uma linha por trava, não por
    // tentativa, gravada em cada provedor em que a pessoa trabalha: é o aviso
    // de que alguém está tentando entrar. O `detail` diz por onde (`login`,
    // `invite`, `change_password`...) e até quando; nunca o que foi digitado.
    USER_ACCOUNT_LOCKED: 'user.account_locked',
    // O dono passou a exigir (ou deixou de exigir) o 2FA da equipe, com
    // `{ from, to }`; e alguém da equipe teve o 2FA desligado por quem
    // administra — celular e códigos perdidos —, com o nome da pessoa.
    TENANT_MFA_REQUIRED_CHANGED: 'tenant.mfa_required_changed',
    OPERATOR_MFA_RESET: 'operator.mfa_reset',
    // O que o console fez numa conta da equipe: dados trocados (login, e-mail,
    // telefone, papel — o detalhe diz quais), um link de senha novo gerado, a
    // senha definida na hora e as sessões encerradas. Nunca o segredo.
    OPERATOR_UPDATED: 'operator.updated',
    OPERATOR_PASSWORD_LINK_ISSUED: 'operator.password_link_issued',
    OPERATOR_PASSWORD_SET: 'operator.password_set',
    OPERATOR_SESSIONS_REVOKED: 'operator.sessions_revoked'
  });

  /**
   * A troca de banco em runtime NÃO é auditada, e vale dizer por quê antes que
   * alguém a acrescente achando que foi esquecimento.
   *
   * A linha teria que ser escrita depois da troca, e depois da troca o banco é
   * outro: o provedor em escopo veio do banco ANTIGO, e num banco novo aquele
   * id ou não existe (a FK recusa) ou pertence a outro provedor (a linha nasce
   * no lugar errado, que é pior). Escrever antes registraria uma ação que pode
   * não acontecer.
   *
   * O que torna isso aceitável é onde a rota existe: só na edição self-hosted,
   * onde há um provedor e quem opera o painel é dono da máquina — a mesma
   * pessoa que poderia trocar o arquivo do SQLite por fora. Auditar ali
   * protegeria alguém de si mesmo. Se um dia a rota existir no SaaS, isto tem
   * que ser resolvido ANTES, e não com um `record` no fim do handler.
   */

  /**
   * Escreve uma linha. Não lança: ver a regra 1.
   *
   * `detail` é serializado aqui e não pelo chamador, para que a checagem de
   * tamanho e o `JSON.stringify` aconteçam num lugar só — e para que um objeto
   * com referência circular vindo de um controlador vire uma linha sem detalhe
   * em vez de uma exceção no meio de uma resposta que já foi decidida.
   */
  static async record({
    action, actorUserId = null, actorUsername = null, actorKind = 'operator',
    subjectType = null, subjectId = null, detail = null, ip = null
  }) {
    try {
      await tinsert('audit_log', {
        actor_user_id: actorUserId,
        actor_username: actorUsername ? String(actorUsername).slice(0, 64) : null,
        actor_kind: actorKind,
        action,
        subject_type: subjectType ? String(subjectType).slice(0, 32) : null,
        subject_id: subjectId === null || subjectId === undefined
          ? null
          : String(subjectId).slice(0, 128),
        detail: AuditLog.serializeDetail(detail),
        ip: ip ? String(ip).slice(0, 64) : null
      });
      return true;
    } catch (error) {
      console.error('Audit log write failed:', action, error.message);
      return false;
    }
  }

  static serializeDetail(detail) {
    if (detail === null || detail === undefined) return null;
    try {
      return JSON.stringify(detail).slice(0, 2000);
    } catch {
      return null;
    }
  }

  /**
   * A partir de um request: preenche o ator sozinho.
   *
   * Existe para que nenhum controlador precise lembrar de copiar três campos do
   * `req.user` — e para que a próxima ação auditada não nasça com o ator vazio
   * porque quem a escreveu copiou de um exemplo que só passava `action`.
   */
  static async fromRequest(req, entrada) {
    // O try/catch se repete aqui, e não é redundância. A regra 1 tem que valer
    // para a API INTEIRA e não para um caminho dela: com o catch só em
    // `record`, qualquer coisa que estourasse antes de chegar lá — um `req`
    // com getter que lança, um `record` substituído em teste, um erro
    // acrescentado neste método um dia — propagaria para o controlador e
    // transformaria a trilha na causa de um 500 numa ação que já aconteceu.
    // Foi exatamente o que um teste pegou.
    try {
      return await AuditLog.record({
        ...entrada,
        actorUserId: req?.user?.userId ?? null,
        actorUsername: req?.user?.username ?? null,
        // `req.user` é o que a hidratação devolve, e lá não existe
        // `isPlatformAdmin` — quem tem a chave do console é lido fresco por
        // `requirePlatformAdmin`, não carregado na sessão. O default era, por
        // isso, sempre 'operator'; só não apareceu porque todo caminho do
        // console passa `actorKind` na mão. O que a sessão tem é a marca de
        // personificação, e é ela que diz que quem agiu veio do plano de
        // controle.
        actorKind: entrada.actorKind ?? (req?.user?.impersonation ? 'platform' : 'operator'),
        ip: req?.ip ?? null
      });
    } catch (error) {
      console.error('Audit log write failed:', entrada?.action, error.message);
      return false;
    }
  }

  /**
   * A trilha deste provedor, da mais recente para a mais antiga.
   *
   * Paginada por `before` (o id da última linha já vista) e não por `offset`:
   * a tabela cresce enquanto alguém a lê, e um offset entrega a mesma linha
   * duas vezes ou pula uma. O cursor é imune a isso.
   */
  static async list({ action = null, limit = 50, before = null } = {}) {
    let query = tdb('audit_log').orderBy('id', 'desc').limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
    if (action) query = query.where({ action });
    if (before) query = query.where('id', '<', Number(before));
    return query;
  }

  /**
   * Apaga o que passou da janela de retenção. Devolve quantas linhas saíram.
   *
   * Em bloco e por tempo — nunca linha a linha. Ver a regra 3.
   */
  static async prune(cutoff) {
    return tdb('audit_log').where('created_at', '<', cutoff).del();
  }
}

export default AuditLog;
