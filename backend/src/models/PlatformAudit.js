import { getDb } from '../config/database.js';

/**
 * A trilha do plano de controle.
 *
 * Deliberadamente NÃO lida por `tdb`, pelo mesmo motivo de `tenants` e
 * `platform_admins`: ela é ACIMA de qualquer provedor. Filtrá-la pelo escopo
 * faria a listagem devolver só o que aconteceu com o provedor em que quem
 * pergunta está logado, e quem pergunta aqui opera o SaaS inteiro.
 *
 * `tenant_id` é inteiro simples e não chave estrangeira — ver a fábrica da
 * tabela. A linha que diz que um provedor foi apagado é a única desta tabela
 * que não pode faltar, e uma FK a apagaria junto com ele.
 */
class PlatformAudit {
  static ACTIONS = Object.freeze({
    TENANT_CREATED: 'tenant.created',
    TENANT_STATUS_CHANGED: 'tenant.status_changed',
    // O nome ou o SUBDOMÍNIO de um provedor foram corrigidos. Uma ação para os
    // dois campos, com o que mudou nomeado no detalhe: a pergunta que se faz
    // desta linha é "quem mexeu no cadastro deste provedor", e separar em duas
    // ações obrigaria a fazê-la duas vezes.
    TENANT_IDENTITY_CHANGED: 'tenant.identity_changed',
    TENANT_DELETED: 'tenant.deleted',
    // Quem baixou o cadastro inteiro de qual provedor, pelo console. Linha
    // própria e obrigatória: é a única ação daqui que tira do deployment uma
    // cópia dos assinantes de um cliente — CPF, contrato, telefone e as
    // conversas — e a leva para o computador de quem operou. A exclusão apaga e
    // deixa rastro; esta COPIA, e sem registro não deixaria nenhum.
    TENANT_EXPORTED: 'tenant.exported',
    // Um provedor foi ligado (ou desligado) do gateway de pagamento. Ação
    // própria e não `TENANT_IDENTITY_CHANGED`: a pergunta que se faz desta
    // linha é "desde quando este cliente paga sozinho, e quem o ligou", e ela é
    // a que se faz quando um pagamento cai no provedor errado. O detalhe diz o
    // gateway e SE há vínculo — nunca o id do cliente, que é a chave que decide
    // para quem vai o crédito.
    TENANT_GATEWAY_CHANGED: 'tenant.gateway_changed',
    // O console criou o cliente de um provedor DENTRO do gateway e o ligou a
    // ele. Linha própria e não `TENANT_GATEWAY_CHANGED`: ali alguém colou um id
    // que já existia; aqui a plataforma abriu um cadastro numa conta de fora,
    // com o CNPJ e o endereço do provedor. Mesma regra de detalhe: o gateway,
    // nunca o id do cliente.
    TENANT_GATEWAY_CUSTOMER_CREATED: 'tenant.gateway_customer_created',
    // Para onde o painel de um provedor fala com o GenieACS, e com que
    // credencial. Na SaaS só o console grava isso, e a linha é o que responde
    // "desde quando este cliente aponta para aquele ACS, e quem mudou".
    TENANT_GENIEACS_CHANGED: 'tenant.genieacs_changed',
    // Os firmwares SEM dono de um GenieACS compartilhado (enviados antes de o
    // dono ir no nome do arquivo): o console reenviou um como de um provedor
    // (`<tag>--<nome>`), ou apagou o antigo. O detalhe diz o nome e a tag.
    TENANT_FIRMWARE_REASSIGNED: 'tenant.firmware_reassigned',
    TENANT_FIRMWARE_DELETED: 'tenant.firmware_deleted',
    // O servidor Evolution que atende todos os provedores.
    PLATFORM_WHATSAPP_CHANGED: 'platform.whatsapp_changed',
    // Os dados da empresa que vende o SaaS (Configurações → Dados do SaaS).
    // O detalhe lista os campos que mudaram, não os valores.
    PLATFORM_PROFILE_CHANGED: 'platform.profile_changed',
    // O "Enviar alerta de teste" dos alertas da plataforma (0112). O detalhe
    // diz os canais e o resultado de cada um, nunca o destino.
    PLATFORM_ALERT_TEST: 'platform.alert_test',
    // A conta da plataforma num sistema de fora — hoje o Asaas: ambiente,
    // chave da API, token do webhook. O detalhe diz O QUE mudou (qual
    // integração, o ambiente, se a chave e o token foram trocados), nunca o
    // valor: a trilha é lida por mais gente do que o console.
    PLATFORM_INTEGRATION_CHANGED: 'platform.integration_changed',
    // O catálogo padrão de equipamentos foi reenviado aos provedores.
    CATALOGUE_PROPAGATED: 'catalogue.propagated',
    // A Fase 5: o que o plano de controle fez com a assinatura de um provedor.
    PLAN_CREATED: 'plan.created',
    PLAN_UPDATED: 'plan.updated',
    // Um pedido de demonstração da página pública mudou de etapa.
    LEAD_UPDATED: 'lead.updated',
    SUBSCRIPTION_PLAN_CHANGED: 'subscription.plan_changed',
    SUBSCRIPTION_STATUS_CHANGED: 'subscription.status_changed',
    PAYMENT_RECORDED: 'subscription.payment_recorded',
    // A tela de Assinaturas do console. O prazo mexido à mão (cortesia ou
    // correção) e o que se fez com UMA cobrança: marcada paga por fora,
    // cancelada, com vencimento ou valor trocados, reemitida. Uma ação por
    // gesto, e não `PAYMENT_RECORDED` para a baixa manual: aquela é o botão
    // de pagamento avulso, sem cobrança por trás; esta fecha uma cobrança que
    // o painel emitiu — e, quando ela está no gateway, fala com ele.
    SUBSCRIPTION_DEADLINE_CHANGED: 'subscription.deadline_changed',
    CHARGE_SETTLED: 'charge.settled',
    CHARGE_CANCELED: 'charge.canceled',
    CHARGE_UPDATED: 'charge.updated',
    CHARGE_REISSUED: 'charge.reissued',
    // O estorno de uma cobrança paga, pelo console: o dinheiro volta (no
    // gateway, ou por fora) e o período que ele comprou é desfeito. Ação
    // própria, e não `CHARGE_CANCELED`: cancelar é "ninguém pagou"; estornar é
    // "pagou, e devolvemos" — e é a segunda que alguém procura quando o
    // provedor pergunta por que voltou a dever.
    CHARGE_REFUNDED: 'charge.refunded',
    // O console pediu a NFS-e de uma cobrança paga — a primeira, ou outra no
    // lugar da que deu erro ou foi cancelada.
    CHARGE_INVOICE_REQUESTED: 'charge.invoice_requested',
    // O console ligou ou desligou o "isento de cobrança" de um provedor: ativo
    // sem gerar fatura, até alguém desligar. Ação própria porque é a resposta
    // a "por que este provedor não paga?", e ela precisa de uma linha que diga
    // exatamente isso — quem, quando e com que motivo.
    SUBSCRIPTION_BILLING_EXEMPT_CHANGED: 'subscription.billing_exempt_changed',
    // Os cupons de desconto (0093): o catálogo deles, mexido pelo console, e
    // o cupom entrando ou saindo da assinatura de um provedor — pelo console
    // ou pelo próprio provedor (`selfService: true`). É a trilha que responde
    // "por que este provedor paga menos que o plano?".
    COUPON_CREATED: 'coupon.created',
    COUPON_UPDATED: 'coupon.updated',
    COUPON_DELETED: 'coupon.deleted',
    SUBSCRIPTION_COUPON_CHANGED: 'subscription.coupon_changed',
    // O ajuste manual do saldo de créditos de um provedor (0106): crédito
    // dado ou tirado pelo console, com o motivo. É a trilha que responde
    // "de onde veio este desconto na fatura?" quando não foi uma indicação.
    TENANT_CREDIT_ADJUSTED: 'tenant.credit_adjusted',
    // A retenção no cancelamento (0107): o provedor pediu para cancelar e
    // aceitou o desconto ou a pausa, agendou o cancelamento, ou o desfez — ou
    // o console o desfez. O detalhe diz qual (`action`).
    SUBSCRIPTION_CANCELLATION_CHANGED: 'subscription.cancellation_changed',
    // O lembrete de cobrança mandado à mão pelo painel de inadimplência —
    // fora da régua, no máximo um por provedor a cada vinte e quatro horas.
    SUBSCRIPTION_REMINDER_SENT: 'subscription.reminder_sent',
    // Quem trabalha para qual provedor, decidido de fora dele. É a ação mais
    // forte que o plano de controle tem: um vínculo escrito aqui vira uma
    // sessão legítima DENTRO de um ISP, com o cadastro inteiro atrás dela. Sem
    // estas duas linhas, vincular-se a um ISP e depois sair não deixaria
    // rastro em trilha nenhuma.
    // E quem CONVIDOU alguém que ainda não tem login para um provedor — o
    // caminho que dá a primeira conta a um provedor recém-criado. Linha própria
    // e não `MEMBER_ADDED`: no convite ninguém entrou na equipe ainda, e o que
    // aconteceu foi a cunhagem de uma credencial com validade. Quem aceitou, e
    // quando, é a trilha DO PROVEDOR que registra.
    MEMBER_INVITED: 'tenant.member_invited',
    // E quem CRIOU uma conta dentro de um provedor a partir do console, para um
    // provedor administrado. Linha própria e não `MEMBER_ADDED`: ali a pessoa
    // já existia e ganhou mais um vínculo; aqui a conta nasceu agora, e o
    // detalhe registra se a senha inicial foi digitada por quem operou o
    // console ou se só a própria pessoa a conheceu.
    OPERATOR_CREATED: 'tenant.operator_created',
    MEMBER_ADDED: 'tenant.member_added',
    MEMBER_REMOVED: 'tenant.member_removed',
    // Mexer numa conta da equipe de um provedor, do console. As quatro
    // espelham as de `AuditLog` com o mesmo nome e nunca carregam o segredo.
    MEMBER_UPDATED: 'tenant.member_updated',
    MEMBER_PASSWORD_LINK_ISSUED: 'tenant.member_password_link',
    MEMBER_PASSWORD_SET: 'tenant.member_password_set',
    MEMBER_SESSIONS_REVOKED: 'tenant.member_sessions_revoked',
    // Quem pediu para olhar o painel de qual cliente. Gravada na cunhagem do
    // bilhete — antes de a sessão existir —, porque é o pedido que é o ato do
    // plano de controle. Que a sessão tenha de fato começado é o que a trilha
    // do provedor registra, e é lá que a pergunta "entraram no meu painel?"
    // é feita.
    TENANT_IMPERSONATED: 'tenant.impersonated',
    // Quem deu a chave do reino a quem. São as duas únicas ações desta tabela
    // que não falam de um provedor — `tenant_id` sai nulo nelas de propósito,
    // porque o cadastro do plano de controle está ACIMA de qualquer provedor e
    // apontar uma delas para um seria inventar um recorte que não existe.
    //
    // E são as duas que mais importam: quem está neste cadastro cria e apaga
    // provedores, muda o que cada um paga e abre sessão de leitura no painel de
    // qualquer cliente. Sem estas linhas, a promoção que precede tudo isso
    // seria o único passo sem rastro da cadeia inteira.
    PLATFORM_ADMIN_GRANTED: 'platform_admin.granted',
    PLATFORM_ADMIN_REVOKED: 'platform_admin.revoked'
  });

  /**
   * Escreve. Como em `AuditLog`, não lança: a ação que a linha ia registrar já
   * aconteceu quando a escrita falha.
   *
   * A exceção que vale nomear: na exclusão, quem chama grava ANTES de apagar e
   * confere o retorno. Ali a trilha não é registro do que houve, é condição
   * para que aconteça — apagar um provedor sem conseguir registrar é apagar sem
   * deixar rastro, e isso não se faz.
   */
  static async record({
    action, actorUserId = null, actorUsername = null,
    tenant = null, detail = null, ip = null
  }) {
    try {
      await getDb()('platform_audit').insert({
        actor_user_id: actorUserId,
        actor_username: actorUsername ? String(actorUsername).slice(0, 64) : null,
        action,
        tenant_id: tenant?.id ?? null,
        tenant_slug: tenant?.slug ? String(tenant.slug).slice(0, 64) : null,
        tenant_name: tenant?.name ? String(tenant.name).slice(0, 128) : null,
        detail: PlatformAudit.serializeDetail(detail),
        ip: ip ? String(ip).slice(0, 64) : null
      });
      return true;
    } catch (error) {
      console.error('Platform audit write failed:', action, error.message);
      return false;
    }
  }

  static serializeDetail(detail) {
    if (detail === null || detail === undefined) return null;
    try {
      return JSON.stringify(detail).slice(0, 4000);
    } catch {
      return null;
    }
  }

  static async fromRequest(req, entrada) {
    try {
      return await PlatformAudit.record({
        ...entrada,
        actorUserId: req?.user?.userId ?? null,
        actorUsername: req?.user?.username ?? null,
        ip: req?.ip ?? null
      });
    } catch (error) {
      console.error('Platform audit write failed:', entrada?.action, error.message);
      return false;
    }
  }

  /** As ações mais recentes primeiro, paginadas por cursor. */
  static async list({ limit = 50, before = null } = {}) {
    let query = getDb()('platform_audit')
      .orderBy('id', 'desc')
      .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
    if (before) query = query.where('id', '<', Number(before));
    return query;
  }
}

export default PlatformAudit;
