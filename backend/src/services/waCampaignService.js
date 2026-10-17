import WaMetaTemplateService from './waMetaTemplateService.js';
import SgpContact from '../models/SgpContact.js';
import SgpLink from '../models/SgpLink.js';
import WaBroadcast from '../models/WaBroadcast.js';
import WaOptOut from '../models/WaOptOut.js';
import WaTemplate from '../models/WaTemplate.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WaBillingService from './waBillingService.js';
import CustomerReferralService from './customerReferralService.js';
import { normalizeAttachment } from './waSendService.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import { VARIAVEIS_DE_COBRANCA, comoDataBr, renderCobranca } from '../utils/wa/waCobranca.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';

/**
 * As variáveis de uma campanha de aviso: o que o cadastro sabe de cada
 * contrato. Não há fatura aqui — quem quer citar valor, PIX ou vencimento está
 * fazendo cobrança, e a cobrança tem a sua própria tela, que consulta o SGP.
 */
export const VARIAVEIS_DE_CAMPANHA = Object.freeze(['nome', 'primeiro_nome', 'contrato', 'plano', 'link_indicacao']);

/** O teto de uma campanha. Com o ritmo padrão (~90/h), 5000 são dois dias e pouco. */
export const MAX_CAMPAIGN_RECIPIENTS = 5000;

/** Quantos exemplos a prévia mostra, com a mensagem já preenchida. */
const PREVIEW_SAMPLE = 50;

/** Até quando se pode agendar, e com que folga mínima. */
const MAX_SCHEDULE_MS = 60 * 24 * 3600_000;
const MIN_SCHEDULE_MS = 60_000;

/** Larguras de `wa_broadcasts`. */
const TITLE_LIMIT = 200;

/** Quantos valores de cada filtro a tela recebe para montar os seletores. */
const OPTIONS_LIMIT = 300;

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g;

/** Bairro e cidade comparados sem maiúsculas, acentos e espaços sobrando. */
export function chaveDeLugar(valor) {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Os contratos colados pelo operador: um por linha, ou separados por vírgula, ponto e vírgula ou espaço. */
export function contratosColados(texto) {
  const lista = Array.isArray(texto) ? texto : String(texto ?? '').split(/[\s,;]+/);
  return [...new Set(lista.map((c) => String(c ?? '').trim()).filter(Boolean).map((c) => c.slice(0, 64)))];
}

/** "RAQUEL ARAÚJO XAVIER" → "Raquel". O SGP costuma gravar o nome em maiúsculas. */
export function primeiroNome(nome) {
  const primeiro = String(nome ?? '').trim().split(/\s+/)[0] || '';
  if (!primeiro) return '';
  return primeiro.charAt(0).toLocaleUpperCase('pt-BR') + primeiro.slice(1).toLocaleLowerCase('pt-BR');
}

function lerEndereco(bruto) {
  if (!bruto) return {};
  if (typeof bruto === 'object') return bruto;
  try {
    const lido = JSON.parse(bruto);
    return lido && typeof lido === 'object' ? lido : {};
  } catch {
    return {};
  }
}

function lista(valor, largura) {
  if (!Array.isArray(valor)) return [];
  return [...new Set(valor.map((v) => String(v ?? '').trim()).filter(Boolean).map((v) => v.slice(0, largura)))];
}

/** Os filtros como chegam do navegador, já limpos. */
export function lerFiltros(entrada = {}) {
  return {
    states: lista(entrada.states, 32),
    plans: lista(entrada.plans, 255),
    districts: lista(entrada.districts, 128),
    cities: lista(entrada.cities, 128),
    contracts: contratosColados(entrada.contracts)
  };
}

const SEM_CONTRATO = 'none';
// O ritmo escolhido na tela, em mensagens por hora. Só desacelera: o ritmo do
// provedor continua sendo o teto na fila de saída.
const RITMOS = Object.freeze({ default: null, slow: 30, very_slow: 12 });
const ORDEM_SITUACAO = ['active', 'blocked', 'cancelled', 'unknown', SEM_CONTRATO];

function invalido(key, code, vars) {
  return new WaError(key, { code, status: 400, vars });
}

/**
 * Campanhas de aviso: o público sai do cadastro (e não de faturas), a mensagem
 * sai de um modelo ou de um texto livre com as variáveis do cadastro, e o
 * envio é o mesmo de sempre — `wa_broadcasts`, o laço de `WaBroadcastService`
 * e o outbox, no ritmo das mensagens automáticas.
 */
class WaCampaignService {
  /**
   * Os valores que existem hoje na base para cada filtro, com quantos
   * contratos têm cada um — o que a tela precisa para montar os seletores.
   */
  static async audienceOptions() {
    const rows = await SgpContact.listForAudience();
    const contar = (mapa, rotulo) => {
      const texto = String(rotulo ?? '').trim();
      if (!texto) return;
      const chave = chaveDeLugar(texto);
      const atual = mapa.get(chave);
      if (atual) atual.count += 1;
      else mapa.set(chave, { value: texto, count: 1 });
    };
    const states = new Map();
    const plans = new Map();
    const districts = new Map();
    const cities = new Map();
    for (const row of rows) {
      const estado = String(row.state ?? '').trim();
      if (estado) states.set(estado, { value: estado, count: (states.get(estado)?.count || 0) + 1 });
      const plano = String(row.plan ?? '').trim();
      if (plano) plans.set(plano, { value: plano, count: (plans.get(plano)?.count || 0) + 1 });
      const endereco = lerEndereco(row.address_parts);
      contar(districts, endereco.district);
      contar(cities, endereco.city);
    }
    const ordenar = (mapa) => [...mapa.values()]
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'pt-BR'))
      .slice(0, OPTIONS_LIMIT);
    // Mesma ordem da aba Contatos: Ativos, Suspensos, Cancelados, Sem contrato.
    const semContrato = (await SgpContact.listWithoutContract()).length;
    if (semContrato > 0) states.set(SEM_CONTRATO, { value: SEM_CONTRATO, count: semContrato });
    const ordemSituacao = (valor) => {
      const i = ORDEM_SITUACAO.indexOf(valor);
      return i === -1 ? ORDEM_SITUACAO.length : i;
    };
    return {
      states: [...states.values()]
        .sort((a, b) => ordemSituacao(a.value) - ordemSituacao(b.value) || b.count - a.count)
        .slice(0, OPTIONS_LIMIT),
      plans: ordenar(plans),
      districts: ordenar(districts),
      cities: ordenar(cities),
      total: rows.length
    };
  }

  /**
   * Quem os filtros escolhem, e quem fica de fora e por quê.
   *
   * Entre grupos diferentes vale E (situação E plano E bairro…); dentro do
   * mesmo grupo, OU (Ativo OU Bloqueado). Um grupo vazio não restringe nada.
   * Um telefone que aparece em dois contratos do mesmo cliente recebe uma
   * mensagem só.
   */
  static async resolveAudience(entrada = {}) {
    const filtros = lerFiltros(entrada);
    const porContrato = filtros.contracts.length > 0 ? new Set(filtros.contracts) : null;
    const bairros = new Set(filtros.districts.map(chaveDeLugar));
    const cidades = new Set(filtros.cities.map(chaveDeLugar));
    const filtraCadastro = filtros.states.length > 0 || filtros.plans.length > 0
      || bairros.size > 0 || cidades.size > 0;

    // "Sem contrato" não é um valor de `sgp_contacts.state`: são os clientes sem contrato.
    const incluiSemContrato = filtros.states.includes(SEM_CONTRATO);
    const estadosReais = filtros.states.filter((s) => s !== SEM_CONTRATO);
    const soSemContrato = incluiSemContrato && estadosReais.length === 0;

    const contatos = (soSemContrato ? [] : await SgpContact.listForAudience({ states: estadosReais, plans: filtros.plans }))
      .filter((row) => {
        if (porContrato && !porContrato.has(String(row.contract))) return false;
        if (bairros.size === 0 && cidades.size === 0) return true;
        const endereco = lerEndereco(row.address_parts);
        if (bairros.size > 0 && !bairros.has(chaveDeLugar(endereco.district))) return false;
        if (cidades.size > 0 && !cidades.has(chaveDeLugar(endereco.city))) return false;
        return true;
      });
    const cadastro = new Map(contatos.map((row) => [String(row.contract), row]));

    // Os vínculos com a ONT têm a correção de número que o operador fez por
    // lá; e um contrato colado que só existe no vínculo entra quando nenhum
    // filtro de cadastro foi pedido (sem cadastro, não há como saber o plano).
    const contratos = new Set(cadastro.keys());
    if (porContrato && !filtraCadastro) for (const c of porContrato) contratos.add(c);
    const vinculos = [];
    const todos = [...contratos];
    for (let i = 0; i < todos.length; i += 200) {
      // eslint-disable-next-line no-await-in-loop -- poucos blocos
      vinculos.push(...await SgpLink.getByContracts(todos.slice(i, i + 200)));
    }

    const assinantes = WaBillingService.subscribersFrom(
      vinculos.filter((link) => contratos.has(String(link.contract))),
      contatos
    );

    // Clientes sem contrato só entram sem filtro de plano nem contrato colado
    // (não têm nenhum dos dois); bairro e cidade valem como nos demais.
    if (incluiSemContrato && filtros.plans.length === 0 && !porContrato) {
      for (const row of await SgpContact.listWithoutContract()) {
        if (bairros.size > 0 || cidades.size > 0) {
          const endereco = lerEndereco(row.address_parts);
          if (bairros.size > 0 && !bairros.has(chaveDeLugar(endereco.district))) continue;
          if (cidades.size > 0 && !cidades.has(chaveDeLugar(endereco.city))) continue;
        }
        assinantes.push({
          contract: null,
          clientName: row.client_name || null,
          phone: row.phone_manual || row.phone_e164 || null
        });
      }
    }

    const linkBase = await CustomerReferralService.baseUrl();
    const semTelefone = [];
    const comTelefone = [];
    for (const assinante of assinantes) {
      const phone = normalizarTelefoneBr(assinante.phone);
      const linha = {
        contract: assinante.contract,
        clientName: assinante.clientName,
        plan: cadastro.get(assinante.contract)?.plan ?? null,
        referralLink: CustomerReferralService.buildLink(linkBase, assinante.contract),
        phone
      };
      if (phone) comTelefone.push(linha);
      else semTelefone.push(linha);
    }

    const bloqueados = await WaOptOut.activePhones(comTelefone.map((r) => r.phone), 'marketing');
    const vistos = new Set();
    const recipients = [];
    let optOut = 0;
    let duplicate = 0;
    for (const linha of comTelefone) {
      if (bloqueados.has(linha.phone)) {
        optOut += 1;
        continue;
      }
      if (vistos.has(linha.phone)) {
        duplicate += 1;
        continue;
      }
      vistos.add(linha.phone);
      recipients.push(linha);
    }

    return {
      filters: filtros,
      recipients,
      counts: {
        matched: assinantes.length,
        noPhone: semTelefone.length,
        optOut,
        duplicate
      }
    };
  }

  /**
   * O texto da campanha: um modelo cadastrado (`templateId`) ou o que foi
   * digitado (`body`). Só as variáveis do cadastro são aceitas; uma de
   * cobrança manda o operador para a Cobrança avulsa.
   */
  static async resolveMessage({ templateId, body } = {}) {
    let texto = String(body ?? '').trim();
    let modelo = null;
    const id = Number(templateId);
    if (templateId !== undefined && templateId !== null && templateId !== '') {
      modelo = Number.isInteger(id) ? await WaTemplate.getById(id) : null;
      if (!modelo) {
        throw new WaError('whatsapp.templates.notFound', { code: 'template_not_found', status: 404 });
      }
      texto = String(modelo.body ?? '').trim();
    }
    if (!texto) throw invalido('whatsapp.error.templateEmpty', 'template_empty');

    const citadas = [...new Set([...texto.matchAll(PLACEHOLDER)].map((m) => m[1]))];
    const deCobranca = citadas.filter((v) => !VARIAVEIS_DE_CAMPANHA.includes(v) && VARIAVEIS_DE_COBRANCA.includes(v));
    if (deCobranca.length > 0) {
      throw invalido('whatsapp.campaign.billingVariables', 'billing_variables', {
        names: deCobranca.map((v) => `{{${v}}}`).join(', ')
      });
    }
    const desconhecidas = citadas.filter((v) => !VARIAVEIS_DE_CAMPANHA.includes(v));
    if (desconhecidas.length > 0) {
      throw invalido('whatsapp.error.unknownVariable', 'unknown_variable', {
        names: desconhecidas.map((v) => `{{${v}}}`).join(', ')
      });
    }
    return { body: texto, templateId: modelo?.id ?? null, template: modelo };
  }

  /** A mensagem de um destinatário, ou `null` quando falta algo que o texto cita. */
  static vars(recipient) {
    return {
      nome: recipient.clientName || '',
      primeiro_nome: primeiroNome(recipient.clientName),
      contrato: recipient.contract || '',
      plano: recipient.plan || '',
      // O link de indicação do próprio cliente; sem endereço configurado ou sem
      // contrato ele fica vazio, e quem ficaria com a mensagem pela metade é pulado.
      link_indicacao: recipient.referralLink || ''
    };
  }

  static render(body, recipient) {
    return renderCobranca(body, this.vars(recipient));
  }

  /**
   * `template` é o modelo do painel, quando a campanha usa um: se ele aponta
   * para um modelo da Meta, cada destinatário leva a sua foto dele, para o
   * número oficial poder mandar fora da janela de 24 h.
   */
  static renderAll(body, recipients, template = null) {
    const prontos = [];
    let templateIncomplete = 0;
    for (const recipient of recipients) {
      const texto = this.render(body, recipient);
      const meta = texto === null ? null : WaMetaTemplateService.buildPayload(template, this.vars(recipient), texto);
      if (texto === null || meta?.incomplete) templateIncomplete += 1;
      else prontos.push({ ...recipient, body: texto, metaTemplate: meta });
    }
    return { prontos, templateIncomplete };
  }

  /** Quem receberia e o quê, sem gravar nada. */
  static async preview({ filters, templateId, body } = {}) {
    const mensagem = await this.resolveMessage({ templateId, body });
    const { recipients, counts } = await this.resolveAudience(filters);
    const { prontos, templateIncomplete } = this.renderAll(mensagem.body, recipients, mensagem.template);
    return {
      counts: { ...counts, templateIncomplete, reachable: prontos.length },
      max: MAX_CAMPAIGN_RECIPIENTS,
      sample: prontos.slice(0, PREVIEW_SAMPLE).map((r) => ({
        contract: r.contract,
        clientName: r.clientName,
        phone: r.phone,
        body: r.body
      }))
    };
  }

  /**
   * O número que envia a campanha: o escolhido na tela (precisa estar
   * conectado) ou, sem escolha, o de sempre — o da cobrança.
   */
  static async resolveAccount(accountId) {
    if (accountId === undefined || accountId === null || accountId === '') {
      return WhatsAppAccount.getForPurpose('billing');
    }
    const id = Number(accountId);
    const account = Number.isInteger(id) ? await WhatsAppAccount.getById(id) : null;
    if (!account) {
      throw new WaError('whatsapp.error.noAccount', { code: 'account_not_found', status: 404 });
    }
    if (account.status !== 'connected') {
      throw new WaError('whatsapp.error.noAccount', { code: 'account_not_connected', status: 409 });
    }
    return account;
  }

  static lerAgendamento(valor) {
    if (valor === undefined || valor === null || valor === '') return null;
    const quando = new Date(valor);
    const agora = Date.now();
    if (Number.isNaN(quando.getTime())
      || quando.getTime() < agora + MIN_SCHEDULE_MS
      || quando.getTime() > agora + MAX_SCHEDULE_MS) {
      throw invalido('whatsapp.campaign.invalidSchedule', 'invalid_schedule');
    }
    return quando;
  }

  /**
   * Tudo que a campanha precisa para ser gravada, sem gravar nada: o texto, o
   * público já resolvido e renderizado, o número e o ritmo. `create` e `update`
   * usam o mesmo caminho, para que editar nunca valide menos que criar.
   * `attachment`: `undefined` mantém o anexo de quem edita, `null` tira, um
   * objeto troca.
   */
  static async prepare({ filters, templateId, body, attachment, scheduledAt, accountId = null, pace = 'default' }) {
    if (!Object.hasOwn(RITMOS, pace ?? 'default')) {
      throw invalido('whatsapp.campaign.invalidPace', 'invalid_pace');
    }
    const agendada = this.lerAgendamento(scheduledAt);
    const anexo = attachment ? normalizeAttachment(attachment) : null;
    const mensagem = await this.resolveMessage({ templateId, body });
    WaBillingService.reserveBuild();

    const { recipients, counts, filters: filtros } = await this.resolveAudience(filters);
    const { prontos, templateIncomplete } = this.renderAll(mensagem.body, recipients, mensagem.template);
    if (prontos.length === 0) {
      throw new WaError('whatsapp.campaign.noRecipients', { code: 'no_recipients', status: 409 });
    }
    if (prontos.length > MAX_CAMPAIGN_RECIPIENTS) {
      throw new WaError('whatsapp.error.tooManyRecipients', {
        code: 'too_many_recipients',
        status: 400,
        vars: { max: MAX_CAMPAIGN_RECIPIENTS }
      });
    }

    const config = await WhatsAppConfigService.getConfig();
    const account = await this.resolveAccount(accountId);
    return {
      prontos,
      counts: { ...counts, templateIncomplete },
      anexo,
      anexoMantido: attachment === undefined,
      fields: {
        template_id: mensagem.templateId,
        body: mensagem.body,
        account_id: account?.id ?? null,
        pace_per_hour: RITMOS[pace ?? 'default'],
        status: agendada ? 'queued' : 'draft',
        scheduled_at: agendada,
        // A lista colada pode ter milhares de contratos; o cartão só precisa
        // saber quantos, e a edição precisa da lista (`contractList`).
        audience_json: JSON.stringify({
          ...filtros,
          contracts: filtros.contracts.length,
          contractList: filtros.contracts
        }),
        rate_limit_per_min: config.rateLimitPerMin,
        total_count: prontos.length
      }
    };
  }

  /**
   * Grava a campanha: rascunho (começa quando alguém clicar em Iniciar) ou
   * agendada (`queued` com `scheduled_at`; o laço de `WaBroadcastService` a
   * inicia na hora).
   */
  static async create({ title, userId = null, ...entrada } = {}) {
    const preparo = await this.prepare(entrada);
    const { anexo } = preparo;
    const broadcast = await WaBroadcast.create({
      title: String(title || `Campanha ${comoDataBr(new Date())}`).trim().slice(0, TITLE_LIMIT),
      ...preparo.fields,
      kind: 'general',
      attachment_path: anexo?.path ?? null,
      attachment_type: anexo?.type ?? null,
      attachment_name: anexo?.name ?? null,
      created_by: userId
    });
    await WaBroadcast.addRecipients(broadcast.id, preparo.prontos);
    return { broadcast, recipients: preparo.prontos.length, skipped: preparo.counts };
  }

  /**
   * Edita uma campanha que ainda não saiu (rascunho ou agendada): refaz o
   * público, o texto e o resto pelo mesmo caminho da criação e troca a lista
   * de destinatários. Uma campanha que já começou não se edita — parte dela já
   * foi entregue.
   */
  static async update(id, { title, ...entrada } = {}) {
    const numeric = Number(id);
    const atual = Number.isInteger(numeric) ? await WaBroadcast.getById(numeric) : null;
    if (!atual) throw new WaError('whatsapp.broadcast.notFound', { code: 'broadcast_not_found', status: 404 });
    if (atual.kind !== 'general' || !['draft', 'queued'].includes(atual.status)) {
      throw new WaError('whatsapp.error.invalidStatus', { code: 'invalid_status', status: 409 });
    }
    const preparo = await this.prepare(entrada);
    const { anexo, anexoMantido } = preparo;
    const campos = {
      ...preparo.fields,
      ...(title ? { title: String(title).trim().slice(0, TITLE_LIMIT) } : {}),
      ...(anexoMantido ? {} : {
        attachment_path: anexo?.path ?? null,
        attachment_type: anexo?.type ?? null,
        attachment_name: anexo?.name ?? null
      })
    };
    // Condicionado ao estado: se a campanha começou entre a leitura e aqui, a
    // edição não passa e nenhum destinatário é tocado.
    const trocou = await WaBroadcast.updateIfStatus(numeric, ['draft', 'queued'], campos);
    if (!trocou) throw new WaError('whatsapp.error.invalidStatus', { code: 'invalid_status', status: 409 });
    await WaBroadcast.replaceRecipients(numeric, preparo.prontos);
    return {
      broadcast: await WaBroadcast.getById(numeric),
      recipients: preparo.prontos.length,
      skipped: preparo.counts
    };
  }
}

export default WaCampaignService;
