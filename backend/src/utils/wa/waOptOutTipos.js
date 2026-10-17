/**
 * Os tipos de comunicação que um "não perturbe" pode bloquear.
 *
 * Quem pede para sair pelo WhatsApp ("SAIR") bloqueia TUDO: a coluna
 * `categories` fica nula, e nula quer dizer todos os tipos. A equipe, no
 * painel, pode afinar: o cliente que não quer promoção mas quer saber da
 * fatura e da queda de energia fica só com `marketing` bloqueado.
 *
 * A lista é fechada. Cada envio do painel pergunta pelo SEU tipo; um tipo
 * fora da lista não teria quem o consultasse e bloquearia nada.
 */
export const TIPOS_DE_COMUNICACAO = Object.freeze(['billing', 'service', 'marketing', 'survey']);

/**
 * O que a equipe mandou, em forma de lista de tipos válidos.
 *
 * `null` quando é "todos" — uma lista vazia, ou a lista inteira — porque é
 * assim que o banco guarda o bloqueio total. `undefined` quando o valor
 * contém algo fora da lista: quem chama recusa, em vez de gravar um bloqueio
 * que ninguém vai consultar.
 *
 * @returns {string[]|null|undefined}
 */
export function lerTipos(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const lista = Array.isArray(valor) ? valor : String(valor).split(',');
  const limpa = [...new Set(lista.map((tipo) => String(tipo).trim()).filter(Boolean))];
  if (limpa.length === 0) return null;
  if (limpa.some((tipo) => !TIPOS_DE_COMUNICACAO.includes(tipo))) return undefined;
  return limpa.length === TIPOS_DE_COMUNICACAO.length ? null : TIPOS_DE_COMUNICACAO.filter((tipo) => limpa.includes(tipo));
}

/** O que está gravado em `categories`, de volta a lista; `null` é "todos". */
export function tiposGravados(raw) {
  const lista = String(raw ?? '').split(',').map((tipo) => tipo.trim()).filter((tipo) => TIPOS_DE_COMUNICACAO.includes(tipo));
  return lista.length > 0 ? lista : null;
}

/** Como se grava: lista de tipos em texto, ou `null` para todos. */
export function gravarTipos(tipos) {
  return tipos && tipos.length > 0 ? tipos.join(',') : null;
}

/** Se uma linha de não perturbe bloqueia este tipo. Sem tipo, qualquer bloqueio conta. */
export function bloqueia(raw, tipo) {
  if (!tipo) return true;
  const tipos = tiposGravados(raw);
  return tipos === null || tipos.includes(tipo);
}

/**
 * O que a tela mostra de um número, a partir do que ele bloqueia (uma entrada
 * por linha: lista de tipos, ou `null` para tudo).
 *
 * `optedOut` é o bloqueio TOTAL — o selo de sempre. `optOutCategories` traz os
 * tipos quando o bloqueio é parcial, e é `null` quando não há bloqueio ou ele
 * é total.
 */
export function optOutOf(entradas) {
  const lista = (entradas || []).filter((entrada) => entrada !== undefined);
  if (lista.length === 0) return { optedOut: false, optOutCategories: null };
  if (lista.some((entrada) => entrada === null)) return { optedOut: true, optOutCategories: null };
  const tipos = [...new Set(lista.flat())];
  return { optedOut: false, optOutCategories: TIPOS_DE_COMUNICACAO.filter((tipo) => tipos.includes(tipo)) };
}
