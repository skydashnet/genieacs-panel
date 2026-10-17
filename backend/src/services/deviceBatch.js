/**
 * Ações em vários equipamentos de uma vez: o que é puro nisso.
 *
 * O lote tem teto porque cada aparelho é uma tarefa no ACS e uma chamada ao
 * servidor do provedor: duzentos cobre a página cheia e o recorte típico de um
 * bairro ou de uma OLT, e segura o clique que mandaria a frota inteira de uma
 * vez. O executor fica em `DeviceService.runBatch`.
 */

export const BATCH_LIMIT = 200;
export const BATCH_ACTIONS = Object.freeze(['reboot', 'firmware', 'inform']);

/** Um id de aparelho do GenieACS, do tamanho que a trilha e o ACS aceitam. */
const ID_MAX = 256;

/**
 * Os ids do pedido, limpos: texto, sem vazio, sem repetição, na ordem em que
 * vieram. `null` quando o pedido não é uma lista de ids — quem chama responde
 * 400 sem mandar nada a ninguém.
 */
export function normalizeBatchIds(raw) {
  if (!Array.isArray(raw)) return null;
  const vistos = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') return null;
    const id = item.trim();
    if (!id || id.length > ID_MAX) return null;
    vistos.add(id);
  }
  return [...vistos];
}

/**
 * O recorte que a tela usou, para a trilha dizer "reiniciou os 37 offline do
 * bairro X" e não só "reiniciou 37". Só os campos que o filtro da lista tem, e
 * cada um curto: é texto vindo do navegador indo para a trilha.
 */
export function batchFilterLabel(filter) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return null;
  const out = {};
  for (const campo of ['search', 'status', 'focus']) {
    const valor = filter[campo];
    if (typeof valor === 'string' && valor.trim() && valor.trim() !== 'all') {
      out[campo] = valor.trim().slice(0, 64);
    }
  }
  return Object.keys(out).length ? out : null;
}

/** As contagens do resultado, na forma que a trilha e a tela leem. */
export function batchSummary(results) {
  const summary = { total: results.length, sent: 0, queued: 0, failed: 0 };
  for (const result of results) {
    if (result.outcome in summary) summary[result.outcome] += 1;
  }
  return summary;
}

/**
 * Roda `fn` sobre cada item com no máximo `limit` de uma vez, e devolve os
 * resultados na ordem dos itens. `fn` não deve lançar — o executor devolve a
 * falha de cada aparelho como resultado —, mas se lançar, a falha fica naquele
 * item e o resto segue.
 */
export async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let proximo = 0;
  const trabalhador = async () => {
    while (proximo < items.length) {
      const indice = proximo;
      proximo += 1;
      try {
        // eslint-disable-next-line no-await-in-loop -- o limite É a sequência
        results[indice] = await fn(items[indice], indice);
      } catch (error) {
        results[indice] = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, trabalhador));
  return results;
}
