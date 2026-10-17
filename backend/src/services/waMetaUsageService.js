import { tdb } from '../config/database.js';
import AppState from '../models/AppState.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import { WaError } from './whatsappConfigService.js';
import { timestampMs } from '../utils/helpers.js';

/**
 * Quantos modelos aprovados da Meta o painel mandou por mês, por categoria.
 *
 * É a pergunta de quem paga a conta: a Meta cobra por modelo entregue fora da
 * janela de 24 h, e o preço muda conforme a categoria (marketing custa bem mais
 * que utilidade). O painel não vê a fatura — vê o que ELE mandou —, então o
 * número daqui é um espelho do envio, não da cobrança. A estimativa em reais
 * só existe quando o provedor digita os preços que paga, e continua sendo
 * estimativa: preço por país do destinatário, faixa de volume e conversas
 * gratuitas são da Meta e não são modelados.
 */

/** Os períodos que a tela oferece. Qualquer outro valor vira 6. */
export const USAGE_PERIODS = [3, 6, 12];
/** As categorias que a Meta cobra, na ordem em que aparecem na tela. */
export const PRICE_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE'];

const PRICES_KEY = 'wa_meta_prices';
// Teto de sanidade do preço por mensagem, em reais. Nenhuma categoria da Meta
// chega perto disso; um valor acima é dígito a mais (vírgula esquecida), e
// deixá-lo passar faria a estimativa mostrar milhões.
const PRECO_MAXIMO = 100;
// Teto de linhas lidas por relatório. Um provedor grande manda dezenas de
// milhares de modelos num mês de cobrança; acima disto o relatório avisa
// (`truncated`) em vez de segurar a memória do processo inteiro.
const LIMITE = 50000;
// Os estados que contam: a Meta aceitou o envio. `failed` com `sent_as`
// gravado é recusa DEPOIS do aceite (o webhook de status) — conta à parte.
const CONTADOS = ['sent', 'delivered', 'read', 'failed'];
const LOTE = 500;
const SEM_CATEGORIA = 'UNKNOWN';

function mesDe(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function lerModelo(raw) {
  if (!raw) return { name: '', language: '' };
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      name: String(obj?.name ?? '').trim(),
      language: String(obj?.language ?? '').trim()
    };
  } catch {
    return { name: '', language: '' };
  }
}

function somar(mapa, chave, n = 1) {
  mapa[chave] = (mapa[chave] || 0) + n;
}

function ordenarCategorias(vistas) {
  const extras = [...vistas].filter((c) => !PRICE_CATEGORIES.includes(c) && c !== SEM_CATEGORIA).sort();
  return [...PRICE_CATEGORIES, SEM_CATEGORIA, ...extras];
}

class WaMetaUsageService {
  /**
   * O relatório dos últimos `months` meses, contando o mês corrente.
   *
   * O mês de cada mensagem é o do FUSO DO SERVIDOR: o início do período é o
   * dia 1º, 00:00, na hora local do processo, e a chave `YYYY-MM` sai de
   * `getFullYear/getMonth` locais. O fuso vai na resposta (`timezone`) para a
   * tela dizer em que relógio o mês virou — uma mensagem das 22 h do dia 31
   * pode cair no mês seguinte para quem lê em UTC.
   */
  static async report({ months = 6, now = new Date() } = {}) {
    const n = USAGE_PERIODS.includes(Number(months)) ? Number(months) : 6;
    const inicio = new Date(now.getFullYear(), now.getMonth() - (n - 1), 1);

    const linhas = await tdb('wa_messages')
      .where({ sent_as: 'template', direction: 'out' })
      .where('created_at', '>=', inicio)
      .whereIn('delivery_status', CONTADOS)
      .orderBy('id', 'desc')
      .limit(LIMITE + 1)
      .select('created_at', 'delivery_status', 'meta_template', 'conversation_id');
    const truncated = linhas.length > LIMITE;
    if (truncated) linhas.length = LIMITE;

    // `wa_messages` não sabe de que número saiu; a conversa sabe.
    const conversaConta = new Map();
    const ids = [...new Set(linhas.map((l) => l.conversation_id).filter((id) => id != null))];
    for (let i = 0; i < ids.length; i += LOTE) {
      // eslint-disable-next-line no-await-in-loop -- lotes para não estourar o limite de parâmetros do banco
      const conversas = await tdb('wa_conversations').whereIn('id', ids.slice(i, i + LOTE)).select('id', 'account_id');
      for (const c of conversas) conversaConta.set(Number(c.id), c.account_id == null ? null : Number(c.account_id));
    }

    const contas = await WhatsAppAccount.getAll();
    const contaIds = contas.map((c) => c.id);
    // Categoria por número+nome+idioma; sem isso, pelo nome+idioma em qualquer
    // número do provedor (um modelo da mesma WABA vale nos dois números).
    const porConta = new Map();
    const porNome = new Map();
    if (contaIds.length) {
      const modelos = await tdb('wa_meta_templates')
        .whereIn('account_id', contaIds)
        .select('account_id', 'name', 'language', 'category');
      for (const m of modelos) {
        const cat = String(m.category || '').trim().toUpperCase();
        if (!cat) continue;
        porConta.set(`${m.account_id}|${m.name}|${m.language}`, cat);
        if (!porNome.has(`${m.name}|${m.language}`)) porNome.set(`${m.name}|${m.language}`, cat);
      }
    }

    const meses = [];
    for (let i = 0; i < n; i += 1) meses.push(mesDe(new Date(inicio.getFullYear(), inicio.getMonth() + i, 1)));
    const mensal = new Map(meses.map((m) => [m, { month: m, byCategory: {}, total: 0, failed: 0 }]));
    const totais = { byCategory: {}, total: 0, failed: 0 };
    const modelosUsados = new Map();
    const contasUsadas = new Map();
    const vistas = new Set();

    for (const linha of linhas) {
      const ms = timestampMs(linha.created_at);
      if (!Number.isFinite(ms)) continue;
      const mes = mensal.get(mesDe(new Date(ms)));
      if (!mes) continue;
      const { name, language } = lerModelo(linha.meta_template);
      const conta = conversaConta.get(Number(linha.conversation_id)) ?? null;
      const categoria = (name && (porConta.get(`${conta}|${name}|${language}`) || porNome.get(`${name}|${language}`)))
        || SEM_CATEGORIA;
      vistas.add(categoria);
      const falhou = linha.delivery_status === 'failed';

      const modeloKey = `${name}|${language}`;
      if (!modelosUsados.has(modeloKey)) modelosUsados.set(modeloKey, { name, language, category: categoria, count: 0, failed: 0 });
      const modelo = modelosUsados.get(modeloKey);
      const contaKey = conta == null ? 'none' : String(conta);
      if (!contasUsadas.has(contaKey)) contasUsadas.set(contaKey, { accountId: conta, byCategory: {}, total: 0, failed: 0 });
      const porNumero = contasUsadas.get(contaKey);

      if (falhou) {
        mes.failed += 1;
        totais.failed += 1;
        modelo.failed += 1;
        porNumero.failed += 1;
        continue;
      }
      somar(mes.byCategory, categoria);
      mes.total += 1;
      somar(totais.byCategory, categoria);
      totais.total += 1;
      modelo.count += 1;
      somar(porNumero.byCategory, categoria);
      porNumero.total += 1;
    }

    const nomes = new Map(contas.map((c) => [Number(c.id), { label: c.label || null, name: c.name || null }]));
    const accounts = [...contasUsadas.values()]
      .map((a) => ({ ...a, label: nomes.get(a.accountId)?.label ?? null, name: nomes.get(a.accountId)?.name ?? null }))
      .sort((a, b) => b.total - a.total || b.failed - a.failed);
    const templates = [...modelosUsados.values()]
      .sort((a, b) => b.count - a.count || b.failed - a.failed || a.name.localeCompare(b.name));

    const prices = await this.getPrices();
    let estimate = null;
    if (Object.values(prices).some((p) => p !== null)) {
      const byCategory = {};
      let total = 0;
      for (const cat of PRICE_CATEGORIES) {
        if (prices[cat] === null) continue;
        const valor = Math.round((totais.byCategory[cat] || 0) * prices[cat] * 100) / 100;
        byCategory[cat] = valor;
        total += valor;
      }
      estimate = { byCategory, total: Math.round(total * 100) / 100, currency: 'BRL' };
    }

    return {
      months: n,
      since: inicio.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
      truncated,
      categories: ordenarCategorias(vistas),
      monthly: meses.map((m) => mensal.get(m)),
      totals: totais,
      templates,
      accounts,
      prices,
      estimate
    };
  }

  /** Os preços por mensagem que o provedor digitou, `null` onde não digitou. */
  static async getPrices() {
    const raw = await AppState.get(PRICES_KEY);
    let salvo = {};
    try {
      salvo = raw ? JSON.parse(raw) : {};
    } catch {
      salvo = {};
    }
    const out = {};
    for (const cat of PRICE_CATEGORIES) {
      const v = salvo?.[cat];
      const n = v === null || v === undefined || v === '' ? Number.NaN : Number(v);
      out[cat] = Number.isFinite(n) && n >= 0 && n <= PRECO_MAXIMO ? n : null;
    }
    return out;
  }

  /**
   * Grava só as categorias presentes no pedido; `null` ou `''` limpa uma.
   * Um valor inválido recusa o pedido inteiro — gravar metade e calar a outra
   * metade deixaria a estimativa errada sem ninguém perceber.
   */
  static async savePrices(input = {}) {
    const next = await this.getPrices();
    for (const cat of PRICE_CATEGORIES) {
      if (!input || !Object.hasOwn(input, cat)) continue;
      const v = input[cat];
      if (v === null || (typeof v === 'string' && !v.trim())) {
        next[cat] = null;
        continue;
      }
      const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : Number.NaN;
      if (!Number.isFinite(n) || n < 0 || n > PRECO_MAXIMO) {
        throw new WaError('whatsapp.error.invalidMetaPrice', {
          code: 'invalid_meta_price', status: 400, vars: { category: cat }
        });
      }
      next[cat] = Math.round(n * 10000) / 10000;
    }
    await AppState.upsert(PRICES_KEY, JSON.stringify(next));
    return next;
  }
}

export default WaMetaUsageService;
