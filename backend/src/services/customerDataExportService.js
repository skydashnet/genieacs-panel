import { tdb } from '../config/database.js';
import { currentTenantId } from '../config/tenantContext.js';
import AuditLog from '../models/AuditLog.js';
import CustomerAccount from '../models/CustomerAccount.js';
import Tenant from '../models/Tenant.js';
import { exportaColuna } from './tenantExportService.js';
import { timestampMs } from '../utils/helpers.js';

/**
 * O dossiê de UM assinante, num arquivo.
 *
 * A exportação do provedor (`tenantExportService`) responde "leve o meu
 * cadastro embora". Esta responde outra pergunta, e é a pergunta que a LGPD
 * faz: **um titular pediu para ver o que existe sobre ele.** O ISP é o
 * controlador desse dado e nós somos operadores — quando o pedido chega, quem
 * tem que ter o botão é o ISP, e até aqui ele não tinha nenhum.
 *
 * ## Por que é um mapa escrito à mão, e não um laço sobre o schema
 *
 * A exportação do provedor pode enumerar as tabelas escopadas porque TODA linha
 * delas é do provedor — o `tenant_id` é o critério, e ele está em todas. Aqui
 * não existe critério único: o dado de um assinante se liga por `account_id` em
 * quatro tabelas, por `device_id` em oito, por contrato em quatro, por telefone
 * em três, e por login PPPoE no mapa da rede. Um laço genérico ou traria linhas
 * de outros assinantes ou não traria nada; o mapa abaixo é o preço de estar
 * certo, e cada linha dele é uma decisão que alguém pode conferir.
 *
 * ## As três reconstruções
 *
 * Nada disso sai de uma coluna só:
 *
 * 1. **Os device ids.** Uma ONT trocada deixa a anterior em `device_swaps`, e a
 *    telemetria dela continua em `device_samples` sob o id ANTIGO. Exportar só
 *    pelo `device_id` atual perderia o histórico inteiro de quem já trocou de
 *    aparelho — que é justamente quem tem mais história.
 * 2. **Os contratos.** `sgp_links.account_id` é anulável e é `SET NULL`, então
 *    nem toda linha de contrato aponta para a conta; o caminho de volta é pelo
 *    device id.
 * 3. **Os telefones.** A caixa de entrada do WhatsApp se liga por número, e o
 *    número mora em `sgp_links` (dois campos) e nas próprias conversas.
 *
 * ## O que NÃO está no arquivo, e é dito no arquivo
 *
 * Uma conta aposentada perde o `device_id` e o `identity_hash`: `retire()` os
 * sobrescreve com `retired:<id>`, e `retireAccount` apaga o vínculo de contrato
 * junto. O dossiê de quem foi aposentado é estruturalmente incompleto, e isso
 * não é consertável depois do fato — nenhum serviço recupera uma linha
 * destruída. O manifesto diz isso em `notCollected`, porque quem abrir o
 * arquivo daqui a dois anos precisa saber o que falta antes de concluir que o
 * painel escondeu alguma coisa.
 */

/**
 * As tabelas escopadas que não guardam dado de assinante, e por quê.
 *
 * Exportada para `backend/test/lgpd-inventario.test.js`, que exige que TODA
 * tabela escopada esteja aqui ou seja alcançada pelo dossiê — nunca em nenhum
 * dos dois. Uma tabela nova que escape das duas listas não dá erro: ela
 * simplesmente não entra no arquivo que o titular pediu, e não é apagada quando
 * ele pede exclusão. O teste é o que transforma esse silêncio em falha.
 */
export const SEM_DADO_DE_ASSINANTE = Object.freeze({
  settings: 'configuração do provedor',
  wa_agents: 'disponibilidade da equipe no WhatsApp',
  wa_tags: 'as etiquetas que o provedor criou para as conversas',
  app_state: 'relógios dos jobs do provedor',
  vendors: 'catálogo de fabricantes',
  wifi_security_config: 'política de WiFi do provedor',
  map_settings: 'preferências do mapa',
  tenant_genieacs_connections: 'como o painel chega ao GenieACS do provedor',
  tenant_invites: 'convites da equipe do provedor',
  provisioning_profiles: 'perfis de provisionamento',
  whatsapp_accounts: 'instâncias de WhatsApp do provedor',
  wa_templates: 'modelos de mensagem',
  wa_meta_templates: 'modelos aprovados da Meta (texto do provedor, sem assinante)',
  wa_broadcasts: 'campanhas — o destinatário sai em wa_broadcast_recipients',
  subscriptions: 'assinatura do provedor conosco',
  billing_events: 'extrato do provedor conosco',
  billing_charges: 'as cobranças que a plataforma emitiu ao provedor',
  billing_invoices: 'as notas fiscais das cobranças pagas pelo provedor',
  subscription_reminder_sends: 'lembretes de cobrança que a plataforma mandou ao provedor',
  coupon_redemptions: 'cupons de desconto que o provedor já resgatou',
  usage_peaks: 'o pico de uso (operadores, assinantes, ONTs) de cada período, para a cobrança por excedente',
  tenant_credits: 'créditos do provedor conosco (indicação, ajuste do console)',
  credit_allocations: 'quanto de cada crédito abateu cada cobrança do provedor',
  cancellation_requests: 'pedidos de cancelamento do provedor conosco — motivo e oferta aceita, nenhum assinante',
  outage_events: 'rompimentos por caixa do mapa — só a caixa e contagens, nenhum assinante',
  outage_incidents: 'quedas em massa por nó do mapa — quem foi atingido sai em outage_incident_devices',
  maintenance_windows: 'manutenções programadas por nó do mapa — quem foi avisado sai em maintenance_window_devices'
});

/**
 * Tudo a que UM assinante alcança, reconstruído — e a razão de ser uma função
 * exportada e não um trecho dentro do `build`.
 *
 * O export e a exclusão (`customerErasureService.js`) têm que responder
 * **exatamente a mesma pergunta**: o que, neste banco, é desta pessoa. Se cada
 * um reconstruísse o conjunto por conta própria, o dia em que um deles ganhasse
 * um caminho novo — mais uma tabela de telefone, mais um jeito de casar
 * contrato — o outro ficaria para trás em silêncio. E o silêncio aqui tem duas
 * formas, as duas ruins: um export que entrega menos do que existe, e uma
 * exclusão que deixa para trás o que o export acabou de mostrar ao titular.
 *
 * Uma função só, e as duas metades do direito da LGPD só discordam se alguém as
 * fizer discordar de propósito.
 */
export async function alcanceDoAssinante(account) {
  const posses = await possesDoAssinante(account);
  const deviceIds = [...new Set(posses.map((p) => p.deviceId))];
  const naPosse = (deviceId, quando) => {
    const t = instante(quando);
    if (!Number.isFinite(t)) return false;
    return posses.some((p) => p.deviceId === deviceId && t >= p.desde && t < p.ate);
  };
  // O vínculo com o ERP e o alerta são o estado de AGORA do aparelho: só valem
  // para a ONT que ainda está com esta conta.
  const emPosseAgora = new Set(posses.filter((p) => p.ate === Infinity).map((p) => p.deviceId));
  const minha = (valor) => valor !== null && valor !== undefined && Number(valor) === Number(account.id);
  const deOutraConta = (valor) => valor !== null && valor !== undefined && !minha(valor);

  const vinculos = (await tdb('sgp_links').where((q) => {
    q.where({ account_id: account.id });
    if (deviceIds.length) q.orWhereIn('device_id', deviceIds);
  }).orderBy('id')).filter((v) => minha(v.account_id)
    || (!deOutraConta(v.account_id) && emPosseAgora.has(v.device_id)));
  const contratos = [...new Set(vinculos.map((v) => v.contract).filter(Boolean))];
  // O mesmo contrato também pode estar em `sgp_contacts`: foi achado numa busca
  // ao SGP antes de a ONT dele aparecer no painel, e a linha fica.
  // E o cadastro SEM contrato da mesma pessoa, que a sincronização completa
  // traz do SGP: ele não tem contrato para casar, então casa pelo documento.
  const documentos = [...new Set(vinculos.map((v) => v.document).filter(Boolean))];
  const contatos = (contratos.length || documentos.length)
    ? await tdb('sgp_contacts').where((q) => {
      if (contratos.length) q.whereIn('contract', contratos);
      if (documentos.length) q.orWhere((semContrato) => semContrato.whereNull('contract').whereIn('document', documentos));
    }).orderBy('id')
    : [];
  // A ficha completa da mesma pessoa: pelo cliente dono de cada contrato, pelo
  // cadastro sem contrato, e pelo documento.
  const chavesCliente = [...new Set(contatos.flatMap((c) => [c.client_ref, c.contract ? null : c.sgp_client_id]).filter(Boolean))];
  const documentosCliente = [...new Set([...documentos, ...contatos.map((c) => c.document)].filter(Boolean))];
  const clientes = (chavesCliente.length || documentosCliente.length)
    ? await tdb('sgp_clients').where((q) => {
      q.whereRaw('1 = 0');
      if (chavesCliente.length) q.orWhereIn('sgp_client_id', chavesCliente);
      if (documentosCliente.length) q.orWhereIn('document', documentosCliente);
    }).orderBy('id')
    : [];
  const telefones = [...vinculos, ...contatos].flatMap((v) => [v.phone_e164, v.phone_manual]).filter(Boolean);

  const contatoIds = contatos.map((c) => c.id);
  const conjuntoContratos = new Set(contratos);
  const conjuntoContatos = new Set(contatoIds);
  const conjuntoTelefones = new Set(telefones);
  // Uma conversa ligada a OUTRA conta é daquela pessoa, mesmo que tenha
  // acontecido na mesma ONT; e uma solta, que casou só pelo aparelho, só é
  // desta se começou enquanto o aparelho era desta conta. Sem isso, o dossiê de
  // quem recebeu uma ONT reaproveitada trazia as conversas do dono anterior.
  const conversas = (deviceIds.length || contratos.length || telefones.length || contatoIds.length)
    ? (await tdb('wa_conversations').where((q) => {
      q.where({ customer_account_id: account.id });
      if (deviceIds.length) q.orWhereIn('device_id', deviceIds);
      if (contratos.length) q.orWhereIn('contract', contratos);
      // A conversa com o cadastro sem contrato aponta para a linha, não para um contrato.
      if (contatoIds.length) q.orWhereIn('sgp_contact_id', contatoIds);
      if (telefones.length) q.orWhereIn('wa_phone_e164', [...conjuntoTelefones]);
    }).orderBy('id')).filter((c) => {
      if (c.customer_account_id !== null && c.customer_account_id !== undefined) return minha(c.customer_account_id);
      return conjuntoContratos.has(c.contract)
        || conjuntoContatos.has(c.sgp_contact_id)
        || conjuntoTelefones.has(c.wa_phone_e164)
        || naPosse(c.device_id, c.created_at);
    })
    : [];

  // O número da conversa também é telefone do titular, e pode não estar em
  // `sgp_links` — o assinante escreve do celular da esposa e a conversa nasce
  // ligada ao contrato pelo device id.
  for (const conversa of conversas) {
    if (conversa.wa_phone_e164) telefones.push(conversa.wa_phone_e164);
  }

  // As linhas chaveadas só pelo aparelho, já recortadas pelo período de posse.
  // Saem daqui prontas, e não como uma lista de devices, para que o export e a
  // exclusão não possam recortar cada um do seu jeito.
  const eventos = (deviceIds.length || contratos.length)
    ? (await tdb('sgp_events').where((q) => {
      if (deviceIds.length) q.whereIn('device_id', deviceIds);
      if (contratos.length) q.orWhereIn('contract', contratos);
    }).orderBy('id')).filter((e) => conjuntoContratos.has(e.contract)
      || naPosse(e.device_id, e.occurred_at ?? e.received_at ?? e.created_at))
    : [];
  const amostras = deviceIds.length
    ? (await tdb('device_samples').whereIn('device_id', deviceIds).orderBy('id'))
      .filter((a) => naPosse(a.device_id, a.inform_at))
    : [];
  const horas = deviceIds.length
    ? (await tdb('device_sample_hours').whereIn('device_id', deviceIds).orderBy('id'))
      .filter((h) => naPosse(h.device_id, h.bucket_at))
    : [];
  // Quedas em massa que atingiram a ONT enquanto era desta conta: guardam
  // nome, contrato e o telefone a que o aviso foi.
  const quedas = deviceIds.length
    ? (await tdb('outage_incident_devices').whereIn('device_id', deviceIds).orderBy('id'))
      .filter((q) => naPosse(q.device_id, q.created_at))
    : [];
  // Manutenções programadas que avisaram a ONT enquanto era desta conta:
  // mesmo recorte e mesmos dados das quedas.
  const manutencoes = deviceIds.length
    ? (await tdb('maintenance_window_devices').whereIn('device_id', deviceIds).orderBy('id'))
      .filter((m) => naPosse(m.device_id, m.created_at))
    : [];
  const trocas = (await tdb('device_swaps').where((q) => {
    q.where({ account_id: account.id });
    if (deviceIds.length) q.orWhereIn('device_id', deviceIds);
  }).orderBy('id')).filter((t) => minha(t.account_id)
    || (!deOutraConta(t.account_id) && naPosse(t.device_id, t.occurred_at)));

  const nos = account.pppoe_username
    ? await tdb('mapping_nodes')
      .whereRaw('LOWER(pppoe) = ?', [String(account.pppoe_username).toLowerCase()])
      .orderBy('id')
    : [];

  return {
    deviceIds,
    posses,
    naPosse,
    emPosseAgora: [...emPosseAgora],
    contratos,
    telefones: [...new Set(telefones)],
    vinculos,
    contatos,
    clientes,
    // Os documentos da pessoa, também pelo cadastro: o que a TeiaH respondeu
    // sobre eles (`teiah_consultations`) é dela.
    documentos: [...new Set([...documentosCliente, ...clientes.map((c) => c.document)].filter(Boolean))],
    conversas,
    conversaIds: conversas.map((c) => c.id),
    eventos,
    amostras,
    horas,
    quedas,
    manutencoes,
    trocas,
    nos,
    noIds: nos.map((n) => n.node_id)
  };
}

/**
 * Milissegundos de um timestamp do banco. Texto sem fuso é UTC — é o que o
 * `CURRENT_TIMESTAMP` do SQLite grava —, e lê-lo como hora local deslocaria
 * cada fronteira de posse pelo fuso do servidor.
 */
function instante(valor) {
  if (typeof valor === 'string'
    && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(valor.trim())) {
    return Date.parse(`${valor.trim().replace(' ', 'T')}Z`);
  }
  return timestampMs(valor);
}

const ACAO_APOSENTADORIA = AuditLog.ACTIONS.SUBSCRIBER_ACCOUNT_RETIRED;

function detalheDe(linha) {
  try {
    return JSON.parse(linha.detail || 'null') || {};
  } catch {
    return {};
  }
}

/**
 * Os períodos em que cada ONT foi DESTA conta: `[{ deviceId, desde, ate }]`,
 * em milissegundos, `ate` exclusivo e `Infinity` enquanto ainda for.
 *
 * O device id não identifica uma pessoa, identifica um aparelho — e aparelho
 * muda de casa. Quando o ISP recolhe a ONT de um assinante e instala na casa
 * de outro, `retireAccount` fecha a conta antiga, mas a telemetria, os eventos
 * do ERP e as conversas continuam gravados sob o mesmo id. Buscar só pelo id
 * entregava ao novo assinante a história do anterior, e a exclusão pedida por
 * um apagava a do outro.
 *
 * O período começa na criação da conta (primeira ONT) ou na troca que trouxe
 * a ONT, e termina na próxima troca, na aposentadoria, ou quando OUTRA conta
 * passa a responder pelo mesmo aparelho — o que vier primeiro.
 */
export async function possesDoAssinante(account) {
  const criada = instante(account.created_at);
  const inicio = Number.isFinite(criada) ? criada : -Infinity;

  const aposentadorias = await tdb('audit_log')
    .where({ action: ACAO_APOSENTADORIA, subject_type: 'customer_account' })
    .orderBy('id');
  const minhaAposentadoria = aposentadorias
    .filter((l) => l.subject_id === String(account.customer_id))
    .at(-1);

  const aposentada = /^retired:/.test(String(account.device_id ?? ''));
  const atual = aposentada
    ? detalheDe(minhaAposentadoria ?? {}).deviceId ?? null
    : (/^erased:/.test(String(account.device_id ?? '')) ? null : account.device_id);

  const trocas = (await tdb('device_swaps').where({ account_id: account.id }))
    .sort((a, b) => (instante(a.occurred_at) - instante(b.occurred_at)) || (a.id - b.id));

  const sequencia = trocas.length
    ? [
      { deviceId: trocas[0].previous_device_id, desde: inicio },
      ...trocas.map((t) => ({ deviceId: t.device_id, desde: instante(t.occurred_at) }))
    ]
    : (atual ? [{ deviceId: atual, desde: inicio }] : []);

  let fim = Infinity;
  if (!account.active) {
    const quando = minhaAposentadoria
      ? instante(minhaAposentadoria.created_at)
      : instante(account.updated_at);
    if (Number.isFinite(quando)) fim = quando;
  }

  const posses = sequencia
    .filter((p) => p.deviceId)
    .map((p, i) => ({
      deviceId: p.deviceId,
      desde: Number.isFinite(p.desde) ? p.desde : inicio,
      ate: i + 1 < sequencia.length ? sequencia[i + 1].desde : fim
    }));
  const deviceIds = [...new Set(posses.map((p) => p.deviceId))];
  if (!deviceIds.length) return posses;

  // Quando cada OUTRA conta passou a responder pelos mesmos aparelhos.
  const inicios = [];
  for (const outra of await tdb('customer_accounts')
    .whereIn('device_id', deviceIds).whereNot({ id: account.id })) {
    inicios.push({ deviceId: outra.device_id, quando: instante(outra.created_at) });
  }
  for (const troca of await tdb('device_swaps')
    .whereIn('device_id', deviceIds)
    .whereNotNull('account_id')
    .whereNot({ account_id: account.id })) {
    inicios.push({ deviceId: troca.device_id, quando: instante(troca.occurred_at) });
  }
  // E as contas de outros que já foram aposentadas: o aparelho delas só
  // sobrevive no registro da aposentadoria.
  const aposentadasDeOutros = aposentadorias
    .filter((l) => l.subject_id !== String(account.customer_id))
    .map((l) => ({ customerId: l.subject_id, deviceId: detalheDe(l).deviceId }))
    .filter((l) => deviceIds.includes(l.deviceId));
  if (aposentadasDeOutros.length) {
    const contas = await tdb('customer_accounts')
      .whereIn('customer_id', aposentadasDeOutros.map((l) => l.customerId));
    const criadaEm = new Map(contas.map((c) => [String(c.customer_id), instante(c.created_at)]));
    for (const l of aposentadasDeOutros) {
      if (criadaEm.has(l.customerId)) inicios.push({ deviceId: l.deviceId, quando: criadaEm.get(l.customerId) });
    }
  }

  for (const posse of posses) {
    for (const { deviceId, quando } of inicios) {
      if (deviceId === posse.deviceId && Number.isFinite(quando) && quando > posse.desde && quando < posse.ate) {
        posse.ate = quando;
      }
    }
  }
  return posses;
}

class CustomerDataExportService {
  static FORMAT_VERSION = 1;

  static async build(accountId) {
    const account = await CustomerAccount.getById(accountId);
    if (!account) return null;

    const {
      deviceIds, naPosse, emPosseAgora, contratos, telefones: todosTelefones, vinculos, contatos,
      clientes, documentos, conversas, conversaIds, eventos, amostras, horas, quedas, manutencoes, trocas, nos, noIds
    } = await alcanceDoAssinante(account);

    const dados = {};
    const contagem = {};
    const guardar = (tabela, linhas) => {
      dados[tabela] = linhas.map((linha) => Object.fromEntries(
        Object.entries(linha).filter(([coluna]) => exportaColuna(coluna))
      ));
      contagem[tabela] = dados[tabela].length;
    };

    guardar('customer_accounts', [account]);
    guardar('customer_wifi_credentials', await tdb('customer_wifi_credentials')
      .where({ account_id: account.id }).orderBy('id'));
    guardar('sgp_links', vinculos);
    guardar('sgp_contacts', contatos);
    guardar('sgp_clients', clientes);
    // O envio à TeiaH Valid de um contrato desta pessoa: o valor em aberto e
    // quando foi mandado. O endereço enviado é o de `sgp_contacts`, acima.
    guardar('teiah_exports', contratos.length
      ? await tdb('teiah_exports').whereIn('contract', contratos).orderBy('id')
      : []);
    // O que a TeiaH respondeu sobre o documento desta pessoa, guardado para não
    // consultar (e pagar) de novo.
    guardar('teiah_consultations', documentos.length
      ? await tdb('teiah_consultations').whereIn('document', documentos).orderBy('id')
      : []);
    guardar('device_swaps', trocas);

    // O perfil é a data de instalação do aparelho, não um dado do período.
    guardar('device_profiles', deviceIds.length
      ? await tdb('device_profiles').whereIn('device_id', deviceIds).orderBy('id')
      : []);
    guardar('device_samples', amostras);
    guardar('device_sample_hours', horas);
    guardar('provisioning_runs', deviceIds.length
      ? (await tdb('provisioning_runs').whereIn('device_id', deviceIds).orderBy('id'))
        .filter((r) => naPosse(r.device_id, r.created_at))
      : []);

    guardar('sgp_events', eventos);

    // `wa_alert_state.subject` guarda um device id OU um nó do mapa, conforme a
    // regra — por isso a busca é pelo conjunto de devices e não por uma coluna
    // chamada `device_id`, que não existe nessa tabela. É o estado de agora,
    // então só da ONT que ainda é desta conta.
    guardar('wa_alert_state', emPosseAgora.length
      ? await tdb('wa_alert_state').whereIn('subject', emPosseAgora).orderBy('id')
      : []);

    // Quedas em massa que atingiram as ONTs desta conta: nome, contrato e o
    // telefone a que o aviso foi mandado.
    guardar('outage_incident_devices', quedas);
    guardar('maintenance_window_devices', manutencoes);

    guardar('wa_conversations', conversas);
    // O que o bot respondeu nessas conversas: só a intenção e a hora.
    guardar('wa_bot_events', conversaIds.length
      ? await tdb('wa_bot_events').whereIn('conversation_id', conversaIds).orderBy('id')
      : []);
    // As etiquetas que a equipe pôs nas conversas deste assinante.
    guardar('wa_conversation_tags', conversaIds.length
      ? await tdb('wa_conversation_tags').whereIn('conversation_id', conversaIds).orderBy('id')
      : []);
    // A nota e o comentário que o assinante deu ao atendimento.
    guardar('wa_satisfaction', conversaIds.length
      ? await tdb('wa_satisfaction').whereIn('conversation_id', conversaIds).orderBy('id')
      : []);
    guardar('wa_messages', conversaIds.length
      ? await tdb('wa_messages').whereIn('conversation_id', conversaIds).orderBy('id')
      : []);
    guardar('wa_opt_outs', (todosTelefones.length || conversaIds.length)
      ? await tdb('wa_opt_outs').where((q) => {
        if (todosTelefones.length) q.whereIn('wa_phone_e164', todosTelefones);
        if (conversaIds.length) q.orWhereIn('conversation_id', conversaIds);
      }).orderBy('id')
      : []);
    guardar('wa_broadcast_recipients', (todosTelefones.length || contratos.length)
      ? await tdb('wa_broadcast_recipients').where((q) => {
        if (todosTelefones.length) q.whereIn('phone_e164', todosTelefones);
        if (contratos.length) q.orWhereIn('contract', contratos);
      }).orderBy('id')
      : []);

    // A régua automática: cada cobrança e agradecimento mandados a esta
    // pessoa, com o valor e o telefone de então.
    guardar('wa_dunning_sends', (todosTelefones.length || contratos.length)
      ? await tdb('wa_dunning_sends').where((q) => {
        if (todosTelefones.length) q.whereIn('phone_e164', todosTelefones);
        if (contratos.length) q.orWhereIn('contract', contratos);
      }).orderBy('id')
      : []);

    // A régua parada para o contrato (comprovante recebido, ou à mão).
    guardar('sgp_billing_status', contratos.length
      ? await tdb('sgp_billing_status').whereIn('contract', contratos).orderBy('id')
      : []);
    guardar('wa_dunning_pauses', contratos.length
      ? await tdb('wa_dunning_pauses').whereIn('contract', contratos).orderBy('id')
      : []);

    // As indicações: as que este assinante fez (pelo contrato) e a dele próprio
    // como indicado (pelo telefone).
    guardar('customer_referrals', (todosTelefones.length || contratos.length)
      ? await tdb('customer_referrals').where((q) => {
        if (todosTelefones.length) q.whereIn('phone_e164', todosTelefones);
        if (contratos.length) q.orWhereIn('referrer_contract', contratos);
      }).orderBy('id')
      : []);

    guardar('mapping_nodes', nos);
    guardar('mapping_edges', noIds.length
      ? await tdb('mapping_edges').where((q) => {
        // `source`/`target`, e não `source_node_id`: as colunas guardam o
        // `node_id` do nó, e o nome curto é o que o schema usa.
        q.whereIn('source', noIds).orWhereIn('target', noIds);
      }).orderBy('id')
      : []);

    // A trilha do provedor, só as linhas que falam DESTA conta. O ator fica:
    // quem revelou a senha do portal de alguém é exatamente o que o titular tem
    // direito de saber.
    // A aposentadoria é gravada pelo Customer ID, e não pelo id da linha.
    guardar('audit_log', await tdb('audit_log')
      .where({ subject_type: 'customer_account' })
      .where((q) => {
        q.where({ subject_id: String(account.id) })
          .orWhere({ action: AuditLog.ACTIONS.SUBSCRIBER_ACCOUNT_RETIRED, subject_id: String(account.customer_id) });
      })
      .orderBy('id'));

    const provedor = await Tenant.findById(currentTenantId());
    const aposentada = !account.active || /^retired:/.test(String(account.device_id ?? ''));

    return {
      manifest: {
        formatVersion: CustomerDataExportService.FORMAT_VERSION,
        generatedAt: new Date().toISOString(),
        subject: {
          accountId: account.id,
          customerId: account.customer_id,
          active: Boolean(account.active),
          retired: aposentada
        },
        // Sem o cadastro fiscal: ele é do ISP, não do titular, e este arquivo
        // vai para as mãos do titular.
        tenant: provedor ? { id: provedor.id, slug: provedor.slug, name: provedor.name } : null,
        tables: Object.keys(dados),
        rowCounts: contagem,
        omittedTables: SEM_DADO_DE_ASSINANTE,
        omittedColumns: {
          why: 'Segredos cifrados e hashes de senha não são exportados: são inúteis '
            + 'fora deste deployment e perigosos dentro de um arquivo que circula.'
        },
        notCollected: [
          {
            what: 'genieacs',
            why: 'O estado ao vivo do aparelho vive no GenieACS, que é de fora deste banco.'
          },
          {
            what: 'attachment-bytes',
            why: 'Os arquivos das conversas ficam em disco; o arquivo traz o nome e o '
              + 'caminho de cada um, não os bytes.'
          },
          ...(aposentada ? [{
            what: 'retired-account-history',
            why: 'Esta conta foi aposentada. A aposentadoria sobrescreve o identificador do '
              + 'aparelho e apaga o vínculo de contrato, então o que existia antes dela não '
              + 'pode mais ser reunido — não está escondido aqui, deixou de existir no banco.'
          }] : [])
        ]
      },
      data: dados
    };
  }
}

export default CustomerDataExportService;
