import Tenant from '../../models/Tenant.js';
import { AsaasError, createCustomer } from './asaasClient.js';

/**
 * O provedor como CLIENTE na conta Asaas da plataforma — criado e ligado.
 *
 * Nasceu dentro de `PlatformIntegrationsController.createAsaasCustomer`, que é
 * o botão do console. Saiu de lá quando o próprio provedor passou a poder
 * pedir "pagar agora" no painel dele: quem nunca foi ligado ao gateway precisa
 * virar cliente ANTES da primeira cobrança, e repetir a tradução do cadastro
 * fiscal e a conferência da corrida em dois controladores seria ter duas
 * versões da regra que decide para quem vai o crédito — e é a segunda versão
 * que diverge.
 *
 * ## O que este serviço NUNCA faz
 *
 * Aceitar de quem chama o gateway ou o id do cliente. Ele recebe o id do
 * provedor e mais nada: o cadastro que vai ao gateway é o que está na linha, e
 * o id que volta é o que o GATEWAY devolveu. É a mesma linha que
 * `Tenant.GATEWAY_COLUMNS` e `PlatformController.setGateway` desenham — um
 * provedor não pode dizer de quem é o dinheiro que entra —, e é o que deixa a
 * rota do provedor usar este serviço sem abrir a porta que aquelas duas
 * fecham: o corpo da requisição do painel não chega aqui.
 *
 * ## Já ligado não é erro
 *
 * `ensure` quer dizer isso: quem já tem vínculo com o Asaas recebe o vínculo
 * que tem, sem chamada nenhuma ao gateway. É o que o "pagar agora" precisa — o
 * segundo clique não pode criar um segundo cliente. O console continua
 * respondendo 409 a quem já está ligado, mas por conta própria, conferindo
 * antes de chamar: lá o pedido é explicitamente "crie", e criar para quem já
 * tem é um pedido que não faz sentido.
 *
 * Ligado a OUTRO gateway (`manual`, por exemplo) é erro, `already_linked`: a
 * plataforma escolheu cobrar esse provedor de outro jeito, e trocar o vínculo
 * é decisão de quem opera o console, pelo PATCH de lá.
 */

/** Só os dígitos. CPF e CNPJ chegam formatados do cadastro fiscal. */
const digitos = (valor) => String(valor ?? '').replace(/\D+/g, '');

/**
 * O cadastro fiscal do provedor, nos nomes do gateway.
 *
 * Só os campos preenchidos: o gateway trata `""` como "apague isto" em alguns
 * campos e como inválido em outros, e mandar só o que existe é a forma de não
 * precisar saber qual é qual.
 *
 * O telefone vai como celular quando tem cara de celular — onze dígitos, com o
 * nove na frente do número —, senão como fixo. O gateway manda o aviso de
 * cobrança por SMS só para `mobilePhone`, e um fixo nesse campo é recusado.
 */
export function customerPayloadFor(tenant) {
  const payload = {
    name: String(tenant.billing_legal_name || tenant.name || '').trim(),
    cpfCnpj: digitos(tenant.billing_tax_id),
    externalReference: `tenant:${tenant.id}`,
    // A plataforma manda os avisos dela (e-mail de vencimento com o link). Os
    // do gateway por cima seriam o mesmo recado duas vezes, com duas marcas.
    notificationDisabled: true
  };
  const opcional = (chave, valor) => {
    const texto = String(valor ?? '').trim();
    if (texto) payload[chave] = texto;
  };
  opcional('email', tenant.billing_email);
  const fone = digitos(tenant.billing_phone);
  if (fone) payload[/^\d{2}9\d{8}$/.test(fone) ? 'mobilePhone' : 'phone'] = fone;
  opcional('postalCode', digitos(tenant.billing_postal_code));
  opcional('address', tenant.billing_address_line);
  opcional('addressNumber', tenant.billing_address_number);
  opcional('complement', tenant.billing_address_extra);
  opcional('province', tenant.billing_district);
  return payload;
}

/**
 * Por que o provedor não virou cliente, com o código que a tela lê e o status
 * que o console sempre respondeu.
 *
 * Os códigos são os de antes da extração, e são contrato: `missing_tax_id`,
 * `invalid_tax_id` e `missing_name` são o cadastro fiscal incompleto (400 —
 * quem conserta é quem preenche o cadastro); `not_found` é o provedor que não
 * existe ou é a caixa da plataforma (404); `already_linked` é o vínculo com
 * outro gateway, ou a corrida perdida para outro (409). Os do gateway vêm do
 * `AsaasError` como estão — `not_configured` (400: é configuração deste lado),
 * `refused` (422: o gateway não aceitou o cadastro) e o resto (502: o gateway
 * ou a rede) —, com o erro original em `cause`, para quem quiser a mensagem.
 */
export class AsaasCustomerError extends Error {
  constructor(message, { code, status = 400, cause = null } = {}) {
    super(message);
    this.name = 'AsaasCustomerError';
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }

  /** Se o motivo é do gateway (ou da falta dele), e não do cadastro ou do provedor. */
  get fromGateway() {
    return this.cause instanceof AsaasError;
  }
}

/**
 * O cadastro fiscal como o gateway vai lê-lo, conferido — ou a recusa.
 *
 * Separado de `ensureAsaasCustomer` porque o "pagar agora" confere o cadastro
 * ANTES de qualquer outra coisa: a pessoa que clicou precisa saber que falta o
 * CNPJ, e não que o gateway está fora do ar, quando os dois são verdade.
 */
export function assertCustomerPayload(tenant) {
  const payload = customerPayloadFor(tenant);
  if (!payload.cpfCnpj) {
    throw new AsaasCustomerError(
      'The provider has no tax id (CPF/CNPJ) in its billing details', { code: 'missing_tax_id' }
    );
  }
  if (payload.cpfCnpj.length !== 11 && payload.cpfCnpj.length !== 14) {
    throw new AsaasCustomerError(
      'The provider tax id must have 11 (CPF) or 14 (CNPJ) digits', { code: 'invalid_tax_id' }
    );
  }
  if (!payload.name) {
    throw new AsaasCustomerError('The provider has no name', { code: 'missing_name' });
  }
  return payload;
}

const jaLigado = () => new AsaasCustomerError(
  'This provider is already linked to a gateway customer', { code: 'already_linked', status: 409 }
);

/**
 * Garante que o provedor é cliente do Asaas e devolve o id dele lá.
 *
 * @returns {Promise<{ customerRef: string, created: boolean, tenant: object }>}
 *   `created` diz se ESTA chamada criou o cliente — é o que decide se há linha
 *   de trilha a escrever, e o que o console lê para manter o 409 da corrida.
 *   `tenant` é a linha como ficou, para quem precisa dela em seguida.
 */
export async function ensureAsaasCustomer(tenantId) {
  const tenant = await Tenant.findById(tenantId);
  // A caixa da plataforma não é cliente de ninguém — ver a emissão.
  if (!tenant || tenant.kind === 'platform') {
    throw new AsaasCustomerError('Provider not found', { code: 'not_found', status: 404 });
  }
  if (tenant.billing_customer_ref) {
    if (tenant.billing_gateway === 'asaas') {
      return { customerRef: tenant.billing_customer_ref, created: false, tenant };
    }
    throw jaLigado();
  }

  const payload = assertCustomerPayload(tenant);

  let customerId;
  try {
    ({ customerId } = await createCustomer(payload));
  } catch (error) {
    if (!(error instanceof AsaasError)) throw error;
    // Sem chave é configuração deste lado; recusa do gateway é o cadastro
    // (um CNPJ que ele não aceita); o resto é o gateway ou a rede.
    const status = error.code === 'not_configured' ? 400 : error.code === 'refused' ? 422 : 502;
    throw new AsaasCustomerError(error.message, { code: error.code, status, cause: error });
  }

  // A gravação é condicional (`linkGatewayIfUnlinked`): dois cliques quase
  // juntos passariam os dois pela conferência de cima, e é o banco quem
  // decide qual vínculo fica. Quem perde relê o vencedor, e o cliente que ele
  // criou no gateway fica no log — órfão, mas achável.
  //
  // Perder para um vínculo com o Asaas devolve o vínculo que ganhou, e não um
  // erro: para o "pagar agora" o segundo clique pediu a mesma coisa que o
  // primeiro, e a resposta certa é a cobrança do primeiro. `created: false` é
  // como o console, que pediu "crie", continua sabendo que não foi ele.
  const ligou = await Tenant.linkGatewayIfUnlinked(tenantId, { gateway: 'asaas', customerRef: customerId });
  const agora = await Tenant.findById(tenantId);
  if (ligou) return { customerRef: customerId, created: true, tenant: agora };

  console.warn(`Provider ${tenantId} got linked meanwhile; gateway customer ${customerId} is orphaned`);
  if (agora?.billing_customer_ref && agora.billing_gateway === 'asaas') {
    return { customerRef: agora.billing_customer_ref, created: false, tenant: agora };
  }
  throw jaLigado();
}

export default { ensureAsaasCustomer, customerPayloadFor, assertCustomerPayload, AsaasCustomerError };
