import { PinnedTransport } from '../../utils/net/pinnedFetch.js';
import { deploymentIsShared } from '../genieacsEgress.js';
import {
  effectiveApiKey, effectiveBaseUrl, effectiveChargesConfig, earlyDiscountFor
} from './asaasSettingsService.js';

/**
 * O cliente HTTP do gateway de pagamento — a única coisa deste repositório que
 * pede dinheiro a alguém.
 *
 * ## A credencial de SAÍDA não é a de entrada
 *
 * A entrega do webhook chega com `asaas-access-token`; a chamada que sai leva
 * `access_token`. São dois cabeçalhos diferentes com nomes parecidos, e
 * confundi-los dá 401 numa direção só — a direção que só é exercitada quando
 * alguém tenta cobrar de verdade. Conferido na documentação do gateway em
 * setembro de 2026, junto com as duas URLs base: `api.asaas.com/v3` em
 * produção e `api-sandbox.asaas.com/v3` no ambiente de testes, cada uma com a
 * sua família de chaves (`$aact_prod_…` e `$aact_hmlg_…`).
 *
 * ## Por que `PinnedTransport` e não `safeFetch`
 *
 * `safeFetch` destrói as opções que não conhece — `maxBytes` e `timeoutMs` ele
 * aceita, mas o destructuring dele é a lista inteira, e não há como pedir nada
 * além. Aqui é preciso o mesmo que o cliente do SGP precisa: resolver o nome
 * com prazo, conferir os endereços, e conectar NO ENDEREÇO conferido, para que
 * um DNS que muda de resposta entre a conferência e a conexão não mande a
 * chave da API para outro lugar.
 *
 * ## Sem retentativa aqui dentro
 *
 * A insistência é do job, que tem `attempts` no banco e sabe parar. Um retry
 * escondido no cliente transformaria "o gateway está fora do ar" em três
 * cobranças criadas quando ele voltar — que é o pior resultado possível, porque
 * quem paga é o cliente.
 */

/** Prazo da chamada inteira, da resolução do nome ao último byte. */
const TIMEOUT_MS = 20_000;

/** A resposta de uma cobrança é um objeto pequeno; um megabyte é folga larga. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** O corpo do erro refletido, truncado: é diagnóstico, não é log de tudo. */
const ERROR_BODY_LIMIT = 500;

export class AsaasError extends Error {
  constructor(message, { status = null, code = 'gateway_error', errors = [] } = {}) {
    super(message);
    this.name = 'AsaasError';
    this.status = status;
    this.code = code;
    // Os `errors` que o gateway devolveu no corpo (`[{ code, description }]`),
    // lidos — é por eles que uma recusa do CARTÃO se separa de uma recusa
    // qualquer do pedido (ver `CardAutopayService.classifyError`).
    this.errors = Array.isArray(errors) ? errors : [];
  }
}

/** Os `errors` de um corpo de erro do gateway, lidos — nunca lança. */
function errosDoCorpo(texto) {
  try {
    const corpo = JSON.parse(texto || '{}');
    if (!Array.isArray(corpo?.errors)) return [];
    return corpo.errors.slice(0, 10).map((item) => ({
      code: String(item?.code ?? '').slice(0, 64),
      description: String(item?.description ?? '').slice(0, ERROR_BODY_LIMIT)
    }));
  } catch {
    return [];
  }
}

/**
 * A chave da API deste deploy, ou nulo. Lida a cada chamada: não se guarda.
 *
 * Assíncrona desde que a chave passou a poder vir do console — a caixa da
 * plataforma guarda o valor e o ambiente é só o que vale quando ela não tem
 * nada (ver `asaasSettingsService`). O cache curto de lá é o que impede isto
 * de virar uma leitura no banco por chamada.
 */
export async function apiKey() {
  return effectiveApiKey();
}

/**
 * A base da API, sem barra no fim: `ASAAS_BASE_URL` quando posta (é a porta do
 * teste), senão a do ambiente escolhido no console.
 */
export async function baseUrl() {
  return effectiveBaseUrl();
}

/**
 * Uma chamada à API do gateway.
 *
 * Quatro resultados distintos, e a distinção é o que decide o que o job faz:
 * credencial recusada (não adianta insistir), pedido recusado (idem, e o motivo
 * é do operador), erro do gateway (insistir adianta) e falha de transporte
 * (idem). O job trata todos como falha, mas o `last_error` da linha guarda qual
 * — e é o que alguém vai ler.
 */
async function chamar(caminho, { method = 'POST', payload = null } = {}) {
  const chave = await apiKey();
  if (!chave) throw new AsaasError('the Asaas API key is not configured', { code: 'not_configured' });

  const base = await baseUrl();
  let url;
  try {
    url = new URL(`${base}${caminho}`);
  } catch {
    throw new AsaasError(`ASAAS_BASE_URL is not a valid URL: ${base}`, { code: 'invalid_base_url' });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AsaasError('ASAAS_BASE_URL must be http or https', { code: 'invalid_base_url' });
  }

  const corpo = payload === null ? null : JSON.stringify(payload);
  const sinal = AbortSignal.timeout(TIMEOUT_MS);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  // A recusa NOMEIA o que aprendeu, ao contrário da do SGP: lá o leitor é um
  // inquilino e "resolve para 10.0.0.5" seria o painel mapeando a rede privada
  // dele a pedido; aqui o leitor é quem opera a plataforma, e o endereço é a
  // informação que resolve o chamado.
  //
  // `allowPrivateAddresses` só num deploy de um provedor só, que é o que deixa
  // um teste apontar a base para `127.0.0.1` sem abrir a porta no deploy
  // hospedado. A régua é `deploymentIsShared()`, e não `IS_SAAS`, pelo mesmo
  // motivo do ACS e do SGP: `EDITION` tem default `selfhosted`, e um deploy
  // compartilhado que esqueça a variável não pode ganhar a rede privada de
  // brinde. Aqui a base é do operador da plataforma, não de um inquilino — o
  // risco é menor, mas a regra é uma só, e a guarda que muda de critério de
  // cliente para cliente é a que alguém esquece de revisar.
  const addresses = await PinnedTransport.vetTarget(hostname, {
    signal: sinal,
    allowPrivateAddresses: !deploymentIsShared(),
    refuse: (motivo) => new AsaasError(motivo, { code: 'blocked_host' })
  });
  sinal.throwIfAborted();
  if (!addresses.length) {
    throw new AsaasError(`${hostname} did not resolve`, { code: 'unreachable' });
  }

  let resposta;
  try {
    resposta = await PinnedTransport.request({
      url,
      hostname,
      addresses,
      method,
      headers: {
        'Content-Type': 'application/json',
        // O painel se identifica: o gateway registra isso e é o que aparece do
        // lado de lá quando alguém pergunta quem abriu a cobrança.
        'User-Agent': 'TR69-Controle',
        access_token: chave
      },
      body: corpo,
      signal: sinal,
      maxBytes: MAX_RESPONSE_BYTES
    });
  } catch (error) {
    throw new AsaasError(`could not reach the gateway: ${error.message}`, { code: 'unreachable' });
  }

  // Um 3xx é erro duro e não se segue: a chave da API iria junto no salto.
  if (resposta.status >= 300 && resposta.status < 400) {
    throw new AsaasError(`gateway answered with a redirect (${resposta.status})`, {
      status: resposta.status, code: 'redirect'
    });
  }

  const texto = await resposta.text();
  if (!resposta.ok) {
    const codigo = resposta.status === 401 || resposta.status === 403
      ? 'unauthorized'
      : resposta.status < 500 ? 'refused' : 'gateway_error';
    throw new AsaasError(
      `gateway answered ${resposta.status}: ${texto.slice(0, ERROR_BODY_LIMIT)}`,
      { status: resposta.status, code: codigo, errors: errosDoCorpo(texto) }
    );
  }

  try {
    return JSON.parse(texto || '{}');
  } catch {
    throw new AsaasError('gateway answered with something that is not JSON', {
      status: resposta.status, code: 'bad_response'
    });
  }
}

/**
 * A multa, os juros e o desconto por antecipação de uma cobrança, nos nomes
 * do gateway — ou um objeto vazio.
 *
 * Só o que está ligado vai (`asaasSettingsService`, bloco `charges`): um
 * `fine: { value: 0 }` mandado à toa seria uma linha a mais para o gateway
 * recusar no dia em que mudar a regra dele. E nada disso vai numa cobrança de
 * cartão: ela é paga na hora, o gateway ignora os três campos, e mandá-los só
 * faria a página mostrar um desconto que nunca se aplica.
 *
 * O desconto sai de `earlyDiscountFor`, a mesma conta que a conferência do
 * pagamento faz — e com o piso: quando a porcentagem levaria a fatura abaixo
 * de R$ 5,00, vai o fixo que para exatamente no piso. Sem `amountCents` (a
 * atualização que só muda o vencimento) o desconto não vai, e o que o gateway
 * já tem fica como está.
 */
export async function chargeTermsFor(amountCents, { billingType = 'UNDEFINED' } = {}) {
  return (await termosDaCobranca(amountCents, { billingType })).campos;
}

/**
 * Os termos de uma cobrança: os campos para o gateway (`campos`) e o
 * desconto que foi junto (`discountTerms`, `{ discount: {...} | null }`) — que
 * a emissão grava na linha (`billing_charges.discount_terms`), para a
 * conferência do pagamento ler o desconto COM QUE a cobrança saiu, e não o da
 * configuração de hoje. `discountTerms` indefinido quando o valor não é
 * conhecido (o desconto não vai, e o que o gateway tem fica).
 */
async function termosDaCobranca(amountCents, { billingType = 'UNDEFINED' } = {}) {
  if (String(billingType).toUpperCase() === 'CREDIT_CARD') return { campos: {}, discountTerms: { discount: null } };
  const termos = await effectiveChargesConfig();
  const campos = {};
  if (termos.finePercent > 0) campos.fine = { value: termos.finePercent, type: 'PERCENTAGE' };
  if (termos.interestMonthlyPercent > 0) campos.interest = { value: termos.interestMonthlyPercent };
  const desconto = amountCents === undefined || amountCents === null
    ? null
    : earlyDiscountFor(Number(amountCents), termos);
  if (desconto) {
    campos.discount = desconto.kind === 'percent'
      ? { value: desconto.percent, dueDateLimitDays: desconto.daysBefore, type: 'PERCENTAGE' }
      : { value: paraReais(desconto.cents), dueDateLimitDays: desconto.daysBefore, type: 'FIXED' };
  }
  const semValor = amountCents === undefined || amountCents === null;
  return {
    campos,
    discountTerms: semValor ? undefined : {
      discount: desconto
        ? { cents: desconto.cents, kind: desconto.kind, percent: desconto.percent ?? null, daysBefore: desconto.daysBefore }
        : null
    }
  };
}

/**
 * Cria a cobrança e devolve o que o painel precisa guardar.
 *
 * `billingType: 'UNDEFINED'` de propósito: devolve uma página onde quem paga
 * escolhe entre Pix e boleto, então um endereço só responde pelos dois meios —
 * e um ISP que prefere um ou outro não precisa que a plataforma adivinhe. Pedir
 * `PIX` fecharia a porta do boleto, que é como metade deste mercado paga.
 */
export async function createCharge({
  customerRef, amountCents, currency = 'BRL', dueDate, description, reference,
  billingType = 'UNDEFINED', creditCardToken = null, remoteIp = null
}) {
  // O gateway é brasileiro e cobra em reais; ele não tem campo de moeda. Um
  // plano em outra moeda gravaria essa moeda na tabela e cobraria reais no
  // gateway — a cobrança sairia com o número certo e a unidade errada. Recusar
  // é a única resposta honesta enquanto não houver um gateway que aceite.
  const moeda = String(currency || 'BRL').toUpperCase();
  if (moeda !== 'BRL') {
    throw new AsaasError(`this gateway only charges in BRL; the plan is in ${moeda}`, {
      code: 'unsupported_currency'
    });
  }

  // O cartão recorrente (0100): com o token salvo e o IP de quem ligou a
  // cobrança automática, o gateway cobra sozinho no cartão. Sem os dois, a
  // página de sempre — nunca uma cobrança de cartão sem token.
  const porCartao = billingType === 'CREDIT_CARD';
  if (porCartao && (!creditCardToken || !remoteIp)) {
    throw new AsaasError('a card charge needs the saved card token and the remote IP', { code: 'bad_request' });
  }
  const payload = {
    customer: customerRef,
    billingType: porCartao ? 'CREDIT_CARD' : 'UNDEFINED',
    // O gateway fala em reais; o painel guarda centavos, como toda coluna de
    // dinheiro daqui. A conversão mora neste ponto e em nenhum outro.
    value: Number((amountCents / 100).toFixed(2)),
    dueDate,
    description,
    externalReference: reference
  };
  // Multa, juros e desconto, quando ligados — e nunca no cartão.
  const termos = await termosDaCobranca(amountCents, { billingType: porCartao ? 'CREDIT_CARD' : 'UNDEFINED' });
  Object.assign(payload, termos.campos);
  if (porCartao) {
    payload.creditCardToken = String(creditCardToken);
    payload.remoteIp = String(remoteIp);
  }
  const resposta = await semToken(creditCardToken, () => chamar('/payments', { payload }));

  const chargeId = String(resposta?.id ?? '').trim();
  if (!chargeId) {
    throw new AsaasError('gateway created something without an id', { code: 'bad_response' });
  }
  return {
    chargeId,
    invoiceUrl: resposta?.invoiceUrl ? String(resposta.invoiceUrl) : null,
    dueDate: resposta?.dueDate ? String(resposta.dueDate).slice(0, 10) : null,
    status: resposta?.status ? String(resposta.status) : null,
    discountTerms: termos.discountTerms
  };
}

/**
 * Roda `fn` e, se ela lançar, tira o token do cartão da mensagem do erro.
 *
 * O erro do gateway reflete o corpo da resposta, e o erro sobe para
 * `last_error` (que o console mostra) e para o log. O token é credencial de
 * cobrança: não pode aparecer em nenhum dos dois, nem que o gateway o ecoe.
 */
async function semToken(token, fn) {
  try {
    return await fn();
  } catch (error) {
    const segredo = token ? String(token) : '';
    if (segredo && error && typeof error.message === 'string' && error.message.includes(segredo)) {
      error.message = error.message.split(segredo).join('[redacted]');
    }
    if (segredo && Array.isArray(error?.errors)) {
      for (const item of error.errors) {
        if (typeof item?.description === 'string' && item.description.includes(segredo)) {
          item.description = item.description.split(segredo).join('[redacted]');
        }
      }
    }
    throw error;
  }
}

/**
 * O cartão com que um pagamento foi pago — `GET /payments/{id}` lido só pelo
 * que o cartão recorrente precisa: o meio (`billingType`) e, quando foi
 * cartão, o token, a bandeira e os quatro últimos dígitos (`creditCard`).
 *
 * Separado de `getCharge` de propósito: aquela volta para o console, para o
 * log e para quem mais a chamar; esta é a ÚNICA leitura que devolve o token, e
 * quem a chama é só `cardAutopayService`, que o cifra na hora.
 *
 * @returns {Promise<{ billingType: string|null, token: string|null,
 *   brand: string|null, last4: string|null }>}
 */
export async function getPaymentCard(paymentId) {
  const resposta = await chamar(`/payments/${idNoCaminho(paymentId)}`, { method: 'GET' });
  const cartao = resposta?.creditCard && typeof resposta.creditCard === 'object' ? resposta.creditCard : {};
  const texto = (valor, max) => (valor === null || valor === undefined || String(valor).trim() === ''
    ? null : String(valor).trim().slice(0, max));
  const digitos = String(cartao.creditCardNumber ?? '').replace(/\D/g, '');
  return {
    billingType: texto(resposta?.billingType, 32),
    token: texto(cartao.creditCardToken, 512),
    brand: texto(cartao.creditCardBrand, 32),
    last4: digitos ? digitos.slice(-4) : null
  };
}

/**
 * As cobranças que o gateway tem com uma `externalReference` nossa —
 * `GET /payments?externalReference=…`.
 *
 * É a pergunta que o cartão recorrente faz antes de tentar de novo uma
 * cobrança de cartão cuja criação pode ter dado certo com a resposta perdida
 * no caminho: no cartão, uma segunda cobrança é dinheiro saindo duas vezes
 * da conta de alguém, e não uma fatura a mais na caixa dele. As apagadas não
 * contam.
 *
 * @returns {Promise<Array<{ chargeId: string, status: string|null, billingType: string|null,
 *   invoiceUrl: string|null, dueDate: string|null }>>}
 */
export async function findChargesByReference(reference) {
  const ref = String(reference ?? '').trim();
  if (!ref) throw new AsaasError('no external reference', { code: 'bad_request' });
  const resposta = await chamar(`/payments?externalReference=${encodeURIComponent(ref)}&limit=20`, { method: 'GET' });
  const lista = Array.isArray(resposta?.data) ? resposta.data : [];
  return lista
    .filter((item) => item && item.id && item.deleted !== true)
    .map((item) => ({
      chargeId: String(item.id),
      status: item.status ? String(item.status) : null,
      billingType: item.billingType ? String(item.billingType).toUpperCase() : null,
      invoiceUrl: item.invoiceUrl ? String(item.invoiceUrl) : null,
      dueDate: item.dueDate ? String(item.dueDate).slice(0, 10) : null
    }));
}

/**
 * Cancela (apaga) uma cobrança no gateway — `DELETE /payments/{id}`.
 *
 * Existe para a troca de plano feita pelo próprio provedor: a cobrança do
 * período já emitida saiu com o preço velho, e deixá-la viva ao lado da nova
 * seria pôr duas faturas do mesmo mês na mão de quem paga — e a primeira a ser
 * paga, pelo valor errado.
 *
 * **404 é sucesso.** O que se quer é que a cobrança não exista mais do lado de
 * lá, e "não existe" é exatamente isso: alguém a apagou no painel do gateway,
 * ou uma tentativa anterior apagou e a resposta se perdeu. Tratar como erro
 * travaria a troca de plano por uma cobrança que já não incomoda ninguém.
 *
 * O id vai codificado no caminho: ele veio do gateway, mas mora no nosso banco,
 * e um caractere de caminho nele mudaria QUAL recurso se apaga.
 *
 * @returns {Promise<{ deleted: boolean, alreadyGone: boolean }>}
 */
export async function cancelCharge(chargeId) {
  const id = String(chargeId ?? '').trim();
  if (!id) throw new AsaasError('no gateway charge id to cancel', { code: 'bad_request' });
  try {
    const resposta = await chamar(`/payments/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return { deleted: resposta?.deleted !== false, alreadyGone: false };
  } catch (error) {
    if (error instanceof AsaasError && error.status === 404) return { deleted: true, alreadyGone: true };
    throw error;
  }
}

/** O id de uma cobrança no gateway, pronto para ir no caminho — ou o erro. */
function idNoCaminho(chargeId) {
  const id = String(chargeId ?? '').trim();
  if (!id) throw new AsaasError('no gateway charge id', { code: 'bad_request' });
  // Codificado pelo mesmo motivo de `cancelCharge`: o id veio do gateway, mas
  // mora no nosso banco, e um caractere de caminho nele mudaria QUAL recurso
  // se toca.
  return encodeURIComponent(id);
}

/** Centavos para reais, como o gateway fala. Um ponto só, como em `createCharge`. */
function paraReais(amountCents) {
  return Number((Number(amountCents) / 100).toFixed(2));
}

/**
 * Dá como recebida em dinheiro uma cobrança que o gateway emitiu —
 * `POST /payments/{id}/receiveInCash`.
 *
 * Existe para o "marcar como paga" do console: o provedor pagou por fora (uma
 * transferência para a conta, um acerto em mãos) e a cobrança continua viva do
 * lado de lá. Sem esta chamada ela ficaria `PENDING` no gateway, e o gateway
 * faria o que faz com toda cobrança pendente: lembraria o provedor, depois o
 * chamaria de atrasado — por uma fatura que ele já pagou.
 *
 * `notifyCustomer: false` de propósito: o aviso de "recebemos o seu pagamento"
 * é conversa nossa com o cliente, e quem registra à mão sabe se ela cabe.
 *
 * Ao contrário de `cancelCharge`, 404 aqui NÃO é sucesso: uma cobrança que não
 * existe mais no gateway não foi recebida por ninguém, e dizer que foi seria
 * registrar dinheiro sobre um recibo que não existe. Quem chama decide o que
 * fazer com a recusa — e o console, que é quem chama, para tudo.
 */
export async function receiveInCash(chargeId, { paymentDate, value }) {
  const caminho = `/payments/${idNoCaminho(chargeId)}/receiveInCash`;
  const resposta = await chamar(caminho, {
    payload: { paymentDate, value: paraReais(value), notifyCustomer: false }
  });
  return { status: resposta?.status ? String(resposta.status) : null };
}

/**
 * Lê uma cobrança como o gateway a vê agora — `GET /payments/{id}`.
 *
 * É a pergunta que a baixa manual do console faz ANTES de mandar o
 * `receiveInCash`: o webhook pode ter se perdido, e aí a Asaas já tem a
 * cobrança como paga (`RECEIVED`, `CONFIRMED`) enquanto o painel a mostra em
 * aberto. O `receiveInCash` numa cobrança já recebida é recusado — e sem esta
 * leitura a baixa ficaria respondendo 502 para sempre, empurrando quem opera
 * para o pagamento avulso, que o webhook reentregue depois creditaria de novo.
 *
 * @returns {Promise<{ id: string, status: string|null, valueCents: number|null }>}
 */
export async function getCharge(chargeId) {
  const resposta = await chamar(`/payments/${idNoCaminho(chargeId)}`, { method: 'GET' });
  const valor = Number(resposta?.value);
  return {
    id: String(resposta?.id ?? chargeId),
    status: resposta?.status ? String(resposta.status) : null,
    // Arredondado sobre o produto, pelo motivo de `paraCentavos` no provider.
    valueCents: Number.isFinite(valor) ? Math.round(valor * 100) : null,
    // O dia do pagamento, quando já foi pago — o desconto por antecipação é
    // conferido por ele (ver `SubscriptionService.recordPayment`).
    paidOn: /^\d{4}-\d{2}-\d{2}/.test(String(resposta?.paymentDate ?? resposta?.confirmedDate ?? ''))
      ? String(resposta.paymentDate ?? resposta.confirmedDate).slice(0, 10)
      : null
  };
}

/**
 * Estorna, INTEIRO, um pagamento recebido pelo gateway —
 * `POST /payments/{id}/refund`.
 *
 * Sem `value` no corpo, de propósito: a documentação do gateway lê a ausência
 * como "o valor todo", e o estorno do console é só o inteiro (decisão de quem
 * opera o SaaS — o estorno parcial desfaria um pedaço de período, e ninguém
 * sabe dizer qual). Mandar o valor que o painel acha que a cobrança tinha
 * arriscaria estornar a menos uma cobrança paga com juros.
 *
 * Só para o que entrou PELO gateway (`RECEIVED`, `CONFIRMED`): o recebimento
 * em dinheiro marcado à mão não tem dinheiro do lado de lá para devolver, e é
 * desfeito por `undoReceivedInCash`. Quem escolhe entre os dois é o console,
 * depois de ler a cobrança (`getCharge`).
 *
 * 404 NÃO é sucesso, pelo mesmo motivo de `receiveInCash`: uma cobrança que
 * não existe do lado de lá não teve estorno nenhum, e dizer que teve seria
 * desfazer um período sobre um recibo que ninguém emitiu.
 *
 * @returns {Promise<{ status: string|null }>}
 */
export async function refundCharge(chargeId) {
  const resposta = await chamar(`/payments/${idNoCaminho(chargeId)}/refund`, { payload: {} });
  return { status: resposta?.status ? String(resposta.status) : null };
}

/**
 * Desfaz a baixa em dinheiro de uma cobrança — `POST
 * /payments/{id}/undoReceivedInCash`.
 *
 * O avesso de `receiveInCash`: o console deu baixa numa cobrança paga por fora
 * e agora estorna. Não há dinheiro do lado do gateway para devolver (quem
 * devolve é gente, pelo mesmo caminho por fora por onde ele entrou); o que se
 * desfaz lá é a etiqueta de "recebida". A cobrança volta a `PENDING` no
 * gateway — e é o console quem decide, depois, se a cancela ou a cobra de
 * novo.
 *
 * @returns {Promise<{ status: string|null }>}
 */
export async function undoReceivedInCash(chargeId) {
  const resposta = await chamar(`/payments/${idNoCaminho(chargeId)}/undoReceivedInCash`, { payload: {} });
  return { status: resposta?.status ? String(resposta.status) : null };
}

/**
 * Muda o vencimento e/ou o valor de uma cobrança já emitida —
 * `POST /payments/{id}`.
 *
 * Só os campos que mudam vão no corpo, mais o `billingType` com que ela nasceu
 * (`UNDEFINED`, ver `createCharge`): a documentação do gateway o pede na
 * atualização, e mandar outro trocaria em silêncio a página de Pix-ou-boleto
 * por uma de um meio só.
 *
 * A resposta traz a cobrança como ficou, e o que se devolve é o que o painel
 * guarda dela — o vencimento que o gateway de fato aceitou, que é o que vale
 * se ele arredondar para um dia útil.
 */
export async function updateCharge(chargeId, {
  dueDate = undefined, value = undefined, amountCents = undefined, billingType = 'UNDEFINED'
} = {}) {
  // O meio com que a cobrança nasceu (0100, `billing_charges.billing_type`):
  // a de cartão continua de cartão — o token já está nela, do lado de lá.
  const payload = { billingType: billingType === 'CREDIT_CARD' ? 'CREDIT_CARD' : 'UNDEFINED' };
  if (dueDate !== undefined) payload.dueDate = dueDate;
  if (value !== undefined) payload.value = paraReais(value);
  // Os termos de hoje vão junto: o desconto é sobre o valor que a cobrança
  // passa a ter (`value`), ou sobre o que ela já tem (`amountCents`, quando
  // quem chama o sabe) — o piso de R$ 5,00 depende dele.
  const termos = await termosDaCobranca(value !== undefined ? value : amountCents, { billingType });
  Object.assign(payload, termos.campos);
  const resposta = await chamar(`/payments/${idNoCaminho(chargeId)}`, { payload });
  return {
    dueDate: resposta?.dueDate ? String(resposta.dueDate).slice(0, 10) : null,
    invoiceUrl: resposta?.invoiceUrl ? String(resposta.invoiceUrl) : null,
    status: resposta?.status ? String(resposta.status) : null,
    // Os termos que foram junto — quem atualiza a linha os grava.
    ...(termos.discountTerms !== undefined ? { discountTerms: termos.discountTerms } : {})
  };
}

/**
 * Confere se a chave responde, e em nome de quem — o botão "Testar conexão" do
 * console.
 *
 * `GET /myAccount/commercialInfo` é a leitura que devolve o NOME da conta, e o
 * nome é o que faz o teste valer alguma coisa: "conectou" com a chave do
 * sandbox de um colega também conecta, e só o nome mostra que a chave é da
 * conta certa. Se o gateway não conhecer esse caminho (404), o saldo serve de
 * segunda leitura: autentica igual, só não diz de quem é. Qualquer outra
 * recusa — 401 sobretudo — sobe como está, porque é ela a resposta do teste.
 *
 * @returns {Promise<{accountName: string|null}>}
 */
export async function testConnection() {
  try {
    const conta = await chamar('/myAccount/commercialInfo', { method: 'GET' });
    const nome = conta?.companyName || conta?.name || conta?.tradingName || null;
    return { accountName: nome ? String(nome) : null };
  } catch (error) {
    if (!(error instanceof AsaasError) || error.status !== 404) throw error;
  }
  await chamar('/finance/balance', { method: 'GET' });
  return { accountName: null };
}

/**
 * Cria o cliente no gateway e devolve o id dele — o `billing_customer_ref` que
 * o console grava no provedor.
 *
 * O corpo vem pronto de quem chama (o cadastro fiscal, traduzido para os nomes
 * do gateway): este arquivo é transporte e não sabe o que é um CNPJ. O que ele
 * garante é o mesmo de `createCharge` — um id na volta, ou um erro.
 *
 * @returns {Promise<{customerId: string}>}
 */
export async function createCustomer(payload) {
  const resposta = await chamar('/customers', { payload });
  const customerId = String(resposta?.id ?? '').trim();
  if (!customerId) {
    throw new AsaasError('gateway created a customer without an id', { code: 'bad_response' });
  }
  return { customerId };
}

/**
 * A nota como o painel a guarda, lida de qualquer resposta de `/invoices`.
 *
 * Os campos que a tela mostra e nada mais: o resto do corpo (impostos,
 * dados do tomador) é da Asaas e mora lá.
 */
function notaDe(resposta, idPedido = null) {
  const texto = (valor, max) => (valor === null || valor === undefined || valor === ''
    ? null
    : String(valor).slice(0, max));
  return {
    id: String(resposta?.id ?? idPedido ?? '').trim(),
    status: resposta?.status ? String(resposta.status).toUpperCase() : null,
    number: texto(resposta?.number, 64),
    pdfUrl: texto(resposta?.pdfUrl, 512),
    xmlUrl: texto(resposta?.xmlUrl, 512),
    statusDescription: texto(resposta?.statusDescription, 500)
  };
}

/**
 * Agenda a NFS-e de um pagamento — `POST /invoices`.
 *
 * O corpo vem montado por quem chama (`billingInvoiceService`, a partir da
 * configuração de Integrações): este arquivo é transporte, como em
 * `createCustomer`. O valor entra em centavos e sai em reais, pelo mesmo
 * ponto único de conversão das cobranças.
 *
 * @returns {Promise<{ id: string, status: string|null, number: string|null,
 *   pdfUrl: string|null, xmlUrl: string|null, statusDescription: string|null }>}
 */
export async function createInvoice({ valueCents, ...payload }) {
  const resposta = await chamar('/invoices', {
    payload: { ...payload, value: paraReais(valueCents) }
  });
  const nota = notaDe(resposta);
  if (!nota.id) throw new AsaasError('gateway created an invoice without an id', { code: 'bad_response' });
  return nota;
}

/** Pede a emissão da nota agendada agora — `POST /invoices/{id}/authorize`. */
export async function authorizeInvoice(invoiceId) {
  return notaDe(await chamar(`/invoices/${idNoCaminho(invoiceId)}/authorize`, { payload: {} }), invoiceId);
}

/** A nota como a Asaas a vê agora — `GET /invoices/{id}`. */
export async function getInvoice(invoiceId) {
  return notaDe(await chamar(`/invoices/${idNoCaminho(invoiceId)}`, { method: 'GET' }), invoiceId);
}

/**
 * As notas que a Asaas tem para um pagamento — `GET /invoices?payment=…`.
 *
 * É a pergunta que se faz antes de pedir de novo a nota cuja criação pode
 * ter dado certo com a resposta perdida no caminho.
 */
export async function listInvoicesForPayment(paymentId) {
  const id = String(paymentId ?? '').trim();
  if (!id) throw new AsaasError('no gateway payment id', { code: 'bad_request' });
  const resposta = await chamar(`/invoices?payment=${encodeURIComponent(id)}&limit=20`, { method: 'GET' });
  const lista = Array.isArray(resposta?.data) ? resposta.data : [];
  return lista.map((item) => notaDe(item)).filter((nota) => nota.id);
}

/** Cancela a nota — `POST /invoices/{id}/cancel`. A recusa sobe como está. */
export async function cancelInvoice(invoiceId) {
  return notaDe(await chamar(`/invoices/${idNoCaminho(invoiceId)}/cancel`, { payload: {} }), invoiceId);
}

export default {
  createCharge, chargeTermsFor, cancelCharge, getCharge, getPaymentCard, findChargesByReference, receiveInCash, refundCharge, undoReceivedInCash, updateCharge,
  createCustomer, testConnection, apiKey, baseUrl, AsaasError,
  createInvoice, authorizeInvoice, getInvoice, cancelInvoice, listInvoicesForPayment
};
