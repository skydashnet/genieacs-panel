import crypto from 'node:crypto';
import { getDb } from '../config/database.js';
import { runInTenant } from '../config/tenantContext.js';
import { asaasBilling, AsaasBillingProvider } from '../services/billing/asaasBillingProvider.js';
import BillingCharge, { OPEN_CHARGE_STATUSES } from '../models/BillingCharge.js';
import SubscriptionService from '../services/subscriptionService.js';
import BillingEvent from '../models/BillingEvent.js';
import { effectiveWebhookToken } from '../services/billing/asaasSettingsService.js';
import BillingInvoiceService from '../services/billing/billingInvoiceService.js';
import CardAutopayService from '../services/billing/cardAutopayService.js';
import Tenant from '../models/Tenant.js';

/**
 * A entrega do gateway de pagamento: o provedor pagou, e o painel volta a
 * escrever sozinho.
 *
 * Até aqui o pagamento era um botão no console — alguém conferindo extrato e
 * marcando à mão. Com dez clientes isso passa; com cinquenta é uma pessoa por
 * dia, e é uma pessoa que erra.
 *
 * ## As três decisões de exposição, copiadas dos dois webhooks que já existem
 *
 * 1. **A credencial é do DEPLOY, não de um provedor.** Há uma conta só no
 *    gateway, a nossa, e por isso o token mora na caixa da PLATAFORMA — gravado
 *    pelo console, em Integrações — com `BILLING_WEBHOOK_TOKEN` no ambiente
 *    como o que vale quando o console não gravou nenhum (era a única fonte
 *    antes da tela existir). Comparada em tempo constante, e sem o token configurado a rota responde
 *    404 em vez de aceitar: uma rota de dinheiro aberta porque alguém esqueceu
 *    uma variável é a pior maneira de descobrir que ela existe.
 * 2. **404 quando não há o que atender, 401 uniforme quando a credencial não
 *    presta.** A resposta nunca diz qual parte falhou, e nunca diz se o
 *    provedor existe: o gateway é público e as tentativas são gratuitas.
 * 3. **200 para tudo que se escolhe ignorar.** Reentrega, evento que não é
 *    pagamento, pagamento que não resolve provedor nenhum — todos 2xx, porque
 *    um não-2xx faz o gateway reentregar em laço para sempre. Não-2xx fica para
 *    falha genuína deste lado, que é o único caso em que reentregar ajuda.
 *
 * ## Por que o provedor sai do corpo e não do host
 *
 * A rota é montada ACIMA do resolvedor de provedor. A entrega chega no endereço
 * que o operador digitou no painel do gateway — o apex, provavelmente — e o
 * apex não nomeia provedor nenhum: resolvida por host, ela levaria 404 antes de
 * chegar aqui. Quem sabe de quem é o dinheiro é o corpo, e o `runInTenant`
 * abaixo é o que faz o crédito cair na assinatura certa.
 */

/**
 * O token do deploy, ou nulo.
 *
 * O gravado pelo console (Integrações → Asaas) ganha; `BILLING_WEBHOOK_TOKEN`
 * é o que vale quando o console nunca gravou nenhum — ver
 * `asaasSettingsService`. Lido a cada entrega, com o cache curto de lá: o
 * token trocado pelo console passa a valer neste processo na hora e nos outros
 * em segundos.
 */
async function tokenConfigurado() {
  return effectiveWebhookToken();
}

/**
 * Compara duas credenciais sem vazar o tamanho nem o prefixo pelo tempo.
 *
 * SHA-256 dos dois lados antes do `timingSafeEqual`, que é a forma que
 * `waWebhookAuth` já usa e pelo mesmo motivo: `timingSafeEqual` lança quando os
 * buffers têm tamanhos diferentes, e um erro por tamanho é, ele mesmo, um canal
 * lateral sobre o comprimento do segredo. Com o digest os dois lados têm sempre
 * 32 bytes.
 */
function credenciaisIguais(a, b) {
  const da = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const db = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(da, db);
}

/**
 * De qual provedor é esta entrega.
 *
 * Duas chaves, nesta ordem:
 *
 * 1. **A nossa própria referência** (`externalReference`), quando fomos nós que
 *    criamos a cobrança. É preferida porque é escrita por este painel e não
 *    depende de o cadastro do cliente no gateway estar ligado a quem se pensa.
 * 2. **O id do cliente no gateway**, para a cobrança emitida lá dentro, à mão —
 *    que é como os primeiros contratos vão ser cobrados.
 *
 * `tenants` é tabela compartilhada, então esta leitura não precisa de
 * `runUnscoped` nem de razão escrita: é exatamente a razão de as duas colunas
 * morarem ali e não numa tabela nova escopada.
 */
export async function resolveTenantDaEntrega({ reference, customerRef }, gateway = 'asaas') {
  const db = getDb();

  // `tenant:<id>` ou `tenant:<id>:<período>`. O sufixo é o que a emissão
  // acrescenta para que a referência diga QUAL cobrança e não só de quem — e a
  // forma antiga continua valendo, porque uma cobrança criada à mão no painel
  // do gateway não tem período nenhum a declarar.
  const daReferencia = String(reference ?? '').match(/^tenant:(\d+)(?::|$)/);
  if (daReferencia) {
    const linha = await db('tenants').where({ id: Number(daReferencia[1]) }).first();
    // `active` e não qualquer status: creditar um provedor apagado ou suspenso
    // por decisão de gente é escrever numa assinatura que ninguém vai ler.
    if (linha && linha.status === 'active') return linha.id;
    return null;
  }

  if (customerRef) {
    const linha = await db('tenants')
      .where({ billing_gateway: gateway, billing_customer_ref: customerRef })
      .first();
    if (linha && linha.status === 'active') return linha.id;
  }
  return null;
}

/**
 * Marca como paga a cobrança que o gateway nomeia. Nunca derruba o crédito.
 *
 * Vale igual para a de pró-rata (0101): `recordPayment` já a reconheceu (não
 * estendeu o prazo), e o `update` do modelo regrava `proration_due_at` — o
 * provedor que estava `past_due` por ela volta a escrever na hora.
 */
async function marcarCobrancaPaga(gatewayChargeId) {
  try {
    const cobranca = await BillingCharge.byGatewayId(gatewayChargeId);
    if (cobranca && cobranca.status !== 'paid') {
      await BillingCharge.update(cobranca.id, { status: 'paid' });
    }
  } catch (error) {
    console.warn(`Billing webhook: could not settle the charge: ${error.message}`);
  }
}

/**
 * A NFS-e da cobrança paga, NA FILA — e só na fila: a Asaas não é chamada
 * dentro desta entrega (ver `billingInvoiceService`). Idempotente pela
 * cobrança, então a reentrega não enfileira duas; e nunca lança.
 */
async function enfileirarNota(gatewayChargeId) {
  try {
    const cobranca = await BillingCharge.byGatewayId(gatewayChargeId);
    if (cobranca?.status === 'paid') await BillingInvoiceService.enqueueForCharge(cobranca);
  } catch (error) {
    console.warn(`Billing webhook: could not queue the invoice: ${error.message}`);
  }
}

/**
 * De que estado a cobrança pode ir para cada um dos estados do ciclo.
 *
 * O gateway reentrega e não garante ordem, e é contra isso que esta tabela
 * existe: um `PAYMENT_OVERDUE` atrasado que chegasse depois do pagamento
 * reabriria como `overdue` uma cobrança paga — e o provedor receberia um aviso
 * de atraso do que já pagou. Então só se atrasa o que está em aberto, só se
 * cancela o que não foi pago, e o estorno vale sobre qualquer coisa: é o único
 * dos três que diz que dinheiro SAIU, e ele não pode ser engolido por uma
 * etiqueta anterior.
 */
const TRANSICOES_DO_CICLO = Object.freeze({
  overdue: new Set(['pending', 'failed']),
  canceled: new Set(['pending', 'failed', 'overdue']),
  refunded: new Set(['pending', 'failed', 'overdue', 'paid', 'canceled'])
});

class BillingWebhookController {
  /**
   * Um evento do ciclo de vida: a cobrança muda de etiqueta — e, no estorno, o
   * período que o pagamento comprou é desfeito.
   *
   * O estorno desfaz desde que quem opera o SaaS decidiu a regra (o estorno é
   * só o inteiro, e devolve o prazo o quanto aquele pagamento o empurrou — ver
   * `SubscriptionService.reversePayment`). Antes, esta rota só gritava no log e
   * deixava a decisão para gente; com a regra escrita, o estorno feito no
   * painel da Asaas e o feito pelo botão do console chegam ao mesmo lugar. E
   * não duas vezes: o botão do console faz a Asaas mandar este mesmo evento
   * minutos depois, e a referência `<pagamento>:refund` já gravada faz a
   * segunda passada não desfazer nada (`reversal: 'duplicate'`).
   *
   * 200 em todos os caminhos, inclusive no erro deste lado — e o erro do
   * estorno também: reentregar em laço não conserta o que falhou aqui, e o log
   * diz qual pagamento o console precisa estornar à mão.
   */
  static async atualizarCiclo(ciclo, res) {
    const tenantId = await resolveTenantDaEntrega(ciclo, asaasBilling.name);
    if (!tenantId) {
      console.warn(
        `Billing webhook: no provider for ${ciclo.event} on payment ${ciclo.externalId} `
        + `(reference=${ciclo.reference ?? '-'} customer=${ciclo.customerRef ?? '-'})`
      );
      return res.json({ success: true, code: 'unattributed' });
    }

    // O cartão salvo recusado na captura (0100) não é etiqueta de cobrança.
    if (ciclo.status === 'card_refused') return BillingWebhookController.recusaDeCartao(ciclo, tenantId, res);

    // O estorno PARCIAL: o console só sabe desfazer o período inteiro, e uma
    // parte do dinheiro de volta não diz qual parte do período se desfaz.
    // Nada muda — nem a etiqueta da cobrança, que continua paga pelo que
    // ficou —, e o log grita para alguém decidir.
    if (ciclo.status === 'refunded' && ciclo.partial) {
      console.error(
        `Billing webhook: payment ${ciclo.externalId} for provider ${tenantId} was PARTIALLY refunded `
        + `(${ciclo.refundedCents} of ${ciclo.valueCents} cents) — nothing was changed; review it in the console`
      );
      return res.json({ success: true, code: 'partial_refund' });
    }

    try {
      const code = await runInTenant(tenantId, async () => {
        const cobranca = await BillingCharge.byGatewayId(ciclo.externalId);
        if (!cobranca) return 'no_charge';
        if (!TRANSICOES_DO_CICLO[ciclo.status]?.has(cobranca.status)) return 'unchanged';
        await BillingCharge.update(cobranca.id, { status: ciclo.status });
        return 'charge_updated';
      });

      // O estorno desfaz o período pela referência do PAGAMENTO — a mesma com
      // que o crédito entrou —, com ou sem cobrança nossa por trás: a cobrança
      // criada à mão no painel do gateway também comprou um período.
      let reversal;
      if (ciclo.status === 'refunded') {
        reversal = await BillingWebhookController.desfazerPeriodo(tenantId, ciclo.externalId);
        BillingWebhookController.cancelarNota(tenantId, ciclo.externalId);
      }
      return res.json({ success: true, code, ...(reversal ? { reversal } : {}) });
    } catch (error) {
      console.error(`Billing webhook: could not apply ${ciclo.event} for provider ${tenantId}:`, error.message);
      return res.json({ success: true, code: 'update_failed' });
    }
  }

  /**
   * O período que o pagamento estornado comprou, desfeito — e o que aconteceu,
   * em uma palavra para o corpo da resposta (e para quem lê o log do gateway).
   *
   * Isolado e sem lançar: a etiqueta da cobrança já foi gravada, e uma falha
   * aqui não pode transformá-la em reentrega. Fica no log, com o que o
   * console precisa para desfazer à mão.
   */
  static async desfazerPeriodo(tenantId, externalId) {
    try {
      const estorno = await runInTenant(tenantId, () => SubscriptionService.reversePayment({
        externalId, source: 'webhook'
      }));
      if (estorno.duplicate) return 'duplicate';
      if (!estorno.found) {
        console.warn(
          `Billing webhook: payment ${externalId} for provider ${tenantId} was REFUNDED, `
          + 'but no recorded payment has that reference; nothing to roll back'
        );
        return 'no_payment';
      }
      console.warn(
        `Billing webhook: payment ${externalId} for provider ${tenantId} was REFUNDED — `
        + `renewal rolled back from ${estorno.renewsAtBefore ?? '-'} to ${estorno.renewsAtAfter ?? '-'}`
      );
      return 'reversed';
    } catch (error) {
      console.error(
        `Billing webhook: payment ${externalId} for provider ${tenantId} was REFUNDED and the `
        + `period could NOT be rolled back (${error.message}); refund it in the console`
      );
      return 'reversal_failed';
    }
  }

  /**
   * A nota da cobrança estornada, cancelada FORA desta entrega.
   *
   * Sem `await`, de propósito: o cancelamento é uma chamada à Asaas, e o
   * webhook não espera por ela (a mesma regra da emissão). O escopo viaja com
   * a promessa, e a falha fica no log e na linha da nota — nunca no estorno.
   */
  static cancelarNota(tenantId, externalId) {
    const pendente = runInTenant(tenantId, async () => {
      const cobranca = await BillingCharge.byGatewayId(externalId);
      if (cobranca) await BillingInvoiceService.cancelForCharge(cobranca.id);
    }).catch((error) => {
      console.error(`Billing webhook: could not cancel the invoice of ${externalId}: ${error.message}`);
    });
    BillingWebhookController.pendingInvoiceWork = pendente;
    return pendente;
  }

  /**
   * `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED` (0100): o gateway não conseguiu
   * cobrar no cartão salvo a cobrança que saiu com o token.
   *
   * Aqui só a anotação — a falha no cartão, uma escrita no escopo do
   * provedor —, e só para uma cobrança NOSSA, de cartão e ainda em aberto: a
   * recusa de um cartão digitado na página de uma fatura de Pix-ou-boleto
   * não diz nada do cartão salvo. Reemitir como Pix/boleto e avisar falam
   * com o gateway e com o SMTP, e saem depois da resposta
   * (`agendarCartao`) — e de novo pelo agendador, se este processo cair.
   */
  static async recusaDeCartao(ciclo, tenantId, res) {
    try {
      const code = await runInTenant(tenantId, async () => {
        const cobranca = await BillingCharge.byGatewayId(ciclo.externalId);
        if (!cobranca) return 'no_charge';
        if (cobranca.billing_type !== 'CREDIT_CARD' || !OPEN_CHARGE_STATUSES.includes(cobranca.status)) return 'unchanged';
        await CardAutopayService.markRefused({ reason: 'capture_refused' });
        return 'card_refused';
      });
      if (code === 'card_refused') BillingWebhookController.agendarCartao(tenantId);
      return res.json({ success: true, code });
    } catch (error) {
      console.error(`Billing webhook: could not apply ${ciclo.event} for provider ${tenantId}:`, error.message);
      return res.json({ success: true, code: 'update_failed' });
    }
  }

  /**
   * O trabalho do cartão recorrente que fala com o gateway, FORA desta
   * entrega — a mesma regra da NFS-e: ler o token, reemitir a fatura recusada
   * como Pix/boleto, avisar (`CardAutopayService.processDue`). Sem `await`; a
   * promessa fica em `pendingCardWork` para o teste esperar, e a falha fica
   * no log — a anotação no banco é o que o agendador retoma.
   */
  static agendarCartao(tenantId) {
    const pendente = runInTenant(tenantId, async () => {
      const tenant = await Tenant.findById(tenantId);
      return CardAutopayService.processDue({ tenant });
    }).catch((error) => {
      console.error(`Billing webhook: card autopay work failed for provider ${tenantId}: ${error.message}`);
    });
    BillingWebhookController.pendingCardWork = pendente;
    return pendente;
  }

  static async receive(req, res) {
    const esperado = await tokenConfigurado();
    if (!esperado) {
      // Ninguém ligou gateway nenhum neste deploy. Mesma resposta do webhook do
      // SGP quando não há destino: não há o que atender aqui.
      return res.status(404).json({ success: false, code: 'webhook_disabled' });
    }

    const recebido = req.get('asaas-access-token') ?? '';
    if (!credenciaisIguais(recebido, esperado)) {
      // Só no log do processo, e sem dizer nada de quem mandou: a resposta é a
      // mesma para credencial errada, ausente e malformada.
      console.warn('Rejected a billing webhook delivery: invalid access token');
      return res.status(401).json({ success: false, code: 'invalid_token' });
    }

    // A nota fiscal tem eventos próprios, sem pagamento no corpo: atualizam a
    // linha que a Asaas nomeia, e nota desconhecida é ignorada — 200 sempre.
    if (/^INVOICE_/.test(String(req.body?.event ?? ''))) {
      const code = await BillingInvoiceService.applyWebhook(req.body);
      return res.json({ success: true, code });
    }

    const leitura = AsaasBillingProvider.interpretar(req.body);
    if (!leitura) {
      // Não é dinheiro entrando — mas pode ser o resto da vida da cobrança:
      // venceu, foi apagada no gateway, foi estornada.
      const ciclo = AsaasBillingProvider.interpretarCiclo(req.body);
      if (ciclo) return BillingWebhookController.atualizarCiclo(ciclo, res);

      // Os OUTROS eventos de estorno — pedido em andamento, negado, parcial
      // (`PAYMENT_REFUND_IN_PROGRESS`, `PAYMENT_REFUND_DENIED`,
      // `PAYMENT_PARTIALLY_REFUNDED` e o que a Asaas vier a nomear com
      // REFUND). Nenhum muda estado aqui: o período só se desfaz no
      // `PAYMENT_REFUNDED` inteiro. Mas o console pode ter desfeito o período
      // com o estorno ainda a caminho, e uma NEGATIVA dele quer dizer que o
      // dinheiro ficou conosco e o provedor perdeu o período à toa — é o
      // tipo de coisa que precisa estar no log com o id do pagamento, e não
      // perdida entre os eventos ignorados.
      const nomeDoEvento = String(req.body?.event ?? '');
      if (/REFUND/.test(nomeDoEvento)) {
        console.error(
          `Billing webhook: ${nomeDoEvento} for payment ${req.body?.payment?.id ?? '(no id)'} — `
          + 'no state was changed; review the refund in the console and at the gateway'
        );
        return res.json({ success: true, code: 'refund_event_logged' });
      }

      // O caminho de todo evento que não é dinheiro entrando — e também o de um
      // campo que mudou de nome do outro lado. O corpo vai para o log do
      // processo porque é ele que diz qual dos dois aconteceu, e essa é a
      // pergunta que alguém vai ter na primeira semana.
      console.warn(
        `Billing webhook: nothing to do with event "${req.body?.event ?? '(none)'}"`
      );
      return res.json({ success: true, code: 'ignored' });
    }

    const tenantId = await resolveTenantDaEntrega(leitura, asaasBilling.name);
    if (!tenantId) {
      // 200, e não 404: o gateway reentregaria para sempre uma cobrança que a
      // plataforma genuinamente não sabe atribuir, e a fila dele não é o lugar
      // de guardar esse problema. Fica no log, que é onde alguém procura
      // quando um cliente diz que pagou.
      console.error(
        `Billing webhook: no provider for payment ${leitura.externalId} `
        + `(reference=${leitura.reference ?? '-'} customer=${leitura.customerRef ?? '-'})`
      );
      return res.json({ success: true, code: 'unattributed' });
    }

    try {
      // Daqui para baixo, como o provedor que pagou. É o escopo que diz de quem
      // é o dinheiro — `recordPayment` não recebe `tenantId` justamente para
      // que ninguém credite o provedor errado passando o id errado.
      const {
        duplicate, underpaid, expectedCents, paidCents, refundedReference, cardCapture
      } = await runInTenant(tenantId, async () => {
        // O pagamento cujo estorno JÁ está no extrato. O caso que importa é o
        // da baixa em dinheiro desfeita pelo console: se o cancelamento no
        // gateway não pegou, a cobrança voltou a ser pagável lá, e um
        // pagamento de verdade nela chega com o MESMO id — que o extrato
        // conhece e `recordPayment` chamaria de `duplicate`. Dinheiro entrando
        // sem crédito, em silêncio, é o pior resultado possível desta rota; é
        // gente que precisa olhar (registrar o pagamento avulso, ou devolver),
        // e o log é onde ela procura. Nada é creditado nem marcado pago.
        if (await BillingEvent.findByExternalId(`${leitura.externalId}:refund`)) {
          return { refundedReference: true };
        }
        const resultado = await asaasBilling.recordPayment({
          amountCents: leitura.amountCents,
          currency: 'BRL',
          externalId: leitura.externalId,
          paidOn: leitura.paidOn ?? null,
          actorUserId: null
        });
        // E a cobrança que o painel emitiu para isto, se houver, deixa de estar
        // em aberto. Fecha o par: a emissão gravou o id do gateway, o pagamento
        // chega com o mesmo id, e é assim que "o que está em aberto" para de
        // incluir o que já foi pago.
        //
        // Depois do crédito, e sem poder derrubá-lo: uma falha aqui deixa uma
        // cobrança `pending` que foi paga — feio, visível e corrigível. O caso
        // oposto seria dinheiro recebido e não creditado.
        //
        // E só quando o valor fecha. Uma cobrança paga pela metade continua
        // `pending` porque é isso que ela é: em aberto. Marcá-la paga aqui
        // apagaria da lista de contas a receber exatamente a linha que alguém
        // precisa olhar — e o período, que não andou, ficaria sem explicação
        // em lugar nenhum.
        // Nem quando o valor é curto, nem numa reentrega.
        //
        // O curto é o óbvio: uma cobrança paga pela metade continua `pending`
        // porque é isso que ela é. A reentrega é a armadilha — `recordPayment`
        // volta cedo por `duplicate` e não reavalia o valor, então `underpaid`
        // vem indefinido ali; sem esta segunda condição, a SEGUNDA entrega de
        // um pagamento curto quitaria a cobrança que a primeira deixou em
        // aberto, e o gateway reentrega por desenho. Não é preciso reavaliar
        // nada: a primeira entrega já fez a coisa certa, e repeti-la é no
        // máximo um no-op.
        if (!resultado.duplicate && !resultado.underpaid) {
          await marcarCobrancaPaga(leitura.externalId);
        }
        // Na reentrega também: a fila é idempotente, e a primeira entrega pode
        // ter caído antes de enfileirar. Só a cobrança PAGA entra.
        if (!resultado.underpaid) await enfileirarNota(leitura.externalId);
        // O cartão recorrente (0100): um pagamento NOVO com cartão, com a
        // cobrança automática ligada, deixa anotado que o token dele falta
        // ler. Só o primeiro crédito — a reentrega e o `RECEIVED` de trinta
        // dias depois chegam como `duplicate` e não trocariam por um token
        // velho o cartão salvo depois. Nunca derruba o crédito.
        let cardCapture = false;
        if (!resultado.duplicate && leitura.billingType === 'CREDIT_CARD') {
          try {
            cardCapture = await CardAutopayService.requestCapture(leitura.externalId);
          } catch (error) {
            console.warn(`Billing webhook: could not note the card of payment ${leitura.externalId}: ${error.message}`);
          }
        }
        return { ...resultado, cardCapture };
      });

      if (refundedReference) {
        console.error(
          `Billing webhook: ${leitura.event} for payment ${leitura.externalId} (provider ${tenantId}, `
          + `${leitura.amountCents} cents) arrived AFTER that payment was refunded — NOT credited; `
          + 'record it by hand in the console or return the money'
        );
        return res.json({ success: true, code: 'refunded_reference' });
      }

      if (underpaid) {
        // No log do processo, e não só no extrato: é a única coisa nesta rota
        // que representa dinheiro a menos do que o combinado, e quem procura
        // "por que o fulano não renovou" procura aqui primeiro.
        console.warn(
          `Billing webhook: payment ${leitura.externalId} for provider ${tenantId} paid `
          + `${paidCents} of ${expectedCents} cents — recorded, period NOT extended`
        );
      }

      if (cardCapture) BillingWebhookController.agendarCartao(tenantId);

      // 200 nos três: o dinheiro chegou e foi registrado, e o que o gateway
      // precisa saber é que não há o que reentregar. A diferença entre eles é
      // para o log do gateway e para quem lê esta rota, não para a fila dele.
      return res.json({
        success: true,
        code: duplicate ? 'duplicate' : underpaid ? 'underpaid' : 'recorded'
      });
    } catch (error) {
      // Aqui sim: falhou deste lado, e reentregar resolve.
      console.error(`Billing webhook failed for provider ${tenantId}:`, error.message);
      return res.status(500).json({ success: false, code: 'record_failed' });
    }
  }
}

export default BillingWebhookController;
