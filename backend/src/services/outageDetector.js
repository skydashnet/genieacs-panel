/**
 * Provável rompimento: vários clientes da mesma caixa offline ao mesmo tempo.
 *
 * Uma função só, usada pelo alerta de WhatsApp (`waAlertService`, regra
 * `mass_outage`) e pelo estado ao vivo da Topologia (`mapStatusService`) —
 * para que o mapa e a mensagem nunca discordem sobre qual caixa caiu.
 *
 * O cliente pertence à caixa mais próxima a que está ligado por cabo (ODP
 * antes de ODC antes de OLT), e é pela caixa que se agrupa: é para lá que o
 * técnico vai.
 *
 * Quando uma caixa "caiu":
 * - `count >= threshold` (o número da regra, 5 por padrão) — como sempre foi;
 * - ou, numa caixa pequena, a maioria: `count >= ceil(total × MAJORITY)`,
 *   nunca menos que 2. Uma CTO com 4 clientes, todos offline, nunca chegava
 *   a 5 e o rompimento dela virava quatro alertas soltos. Numa caixa grande
 *   nada muda: 3 de 16 continua sendo instabilidade comum, não rompimento.
 */
export const AGGREGATION_TYPES = Object.freeze(['odp', 'odc', 'olt']);
export const MAJORITY = 0.6;

/** Cliente (nó ONT) → a caixa mais próxima a que está ligado por cabo. */
export function parentBoxes(nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.node_id, node]));
  const parentOf = new Map();
  for (const edge of edges) {
    for (const [from, to] of [[edge.source, edge.target], [edge.target, edge.source]]) {
      const child = nodeById.get(from);
      const parent = nodeById.get(to);
      if (!child || !parent || child.type !== 'ont') continue;
      if (!AGGREGATION_TYPES.includes(parent.type)) continue;
      const current = parentOf.get(child.node_id);
      if (!current || AGGREGATION_TYPES.indexOf(parent.type) < AGGREGATION_TYPES.indexOf(current.type)) {
        parentOf.set(child.node_id, parent);
      }
    }
  }
  return parentOf;
}

/** Quantos offline bastam numa caixa com `total` clientes, para a regra `threshold`. */
export function outageMinimum(threshold, total) {
  const absolute = Math.max(2, Math.round(Number(threshold) || 5));
  const majority = Math.max(2, Math.ceil(total * MAJORITY));
  return total > 0 ? Math.min(absolute, majority) : absolute;
}

/**
 * As caixas que caíram.
 *
 * `offline`: `Map` de `node_id` do cliente → quando ele informou por último
 * (ms, ou null). Devolve, por caixa, os clientes offline, o total de clientes
 * que a caixa tem no mapa e `since` — o último sinal do primeiro a cair, que
 * é a melhor estimativa de quando o rompimento aconteceu.
 */
export function detectOutages({ nodes, edges, offline, threshold }) {
  const parentOf = parentBoxes(nodes, edges);
  const totals = new Map();
  for (const parent of parentOf.values()) totals.set(parent.node_id, (totals.get(parent.node_id) ?? 0) + 1);

  const groups = new Map();
  for (const [clientId, lastInform] of offline) {
    const parent = parentOf.get(clientId);
    if (!parent) continue;
    const bucket = groups.get(parent.node_id) ?? { box: parent, clients: [], since: null };
    bucket.clients.push(clientId);
    if (Number.isFinite(lastInform) && (bucket.since === null || lastInform < bucket.since)) bucket.since = lastInform;
    groups.set(parent.node_id, bucket);
  }

  const outages = [];
  for (const bucket of groups.values()) {
    const total = totals.get(bucket.box.node_id) ?? bucket.clients.length;
    if (bucket.clients.length < outageMinimum(threshold, total)) continue;
    outages.push({ ...bucket, count: bucket.clients.length, total });
  }
  return outages.sort((a, b) => b.count - a.count);
}

/** Link do Google Maps para a caixa: o técnico abre direto no celular. */
export function mapsLink(node) {
  const lat = Number(node?.latitude);
  const lng = Number(node?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  return `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/** Altura de cada tipo de nó na árvore da rede: só se desce para um menor. */
const NIVEL = Object.freeze({ olt: 3, odc: 2, odp: 1, htb: 1, ont: 0 });

/** Os tipos que podem entrar em manutenção programada. */
export const MAINTENANCE_TYPES = Object.freeze(['olt', 'odc', 'odp', 'htb']);

/**
 * Os clientes (nós ONT) embaixo de um nó, em qualquer profundidade.
 *
 * `parentBoxes` só olha um salto, que basta para agrupar uma queda pela caixa
 * mais próxima. Uma manutenção numa ODC ou numa OLT atinge tudo o que está
 * pendurado nela, passando pelas ODPs. A busca só desce de nível — nunca
 * volta para a OLT nem atravessa para a caixa vizinha pela OLT em comum.
 */
export function clientsBeneath(nodeId, nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.node_id, node]));
  const inicio = nodeById.get(nodeId);
  if (!inicio || !(inicio.type in NIVEL)) return [];
  const vizinhos = new Map();
  for (const edge of edges) {
    for (const [a, b] of [[edge.source, edge.target], [edge.target, edge.source]]) {
      if (!vizinhos.has(a)) vizinhos.set(a, []);
      vizinhos.get(a).push(b);
    }
  }
  const vistos = new Set([nodeId]);
  const fila = [inicio];
  const clientes = [];
  while (fila.length) {
    const atual = fila.shift();
    for (const id of vizinhos.get(atual.node_id) ?? []) {
      const vizinho = nodeById.get(id);
      if (!vizinho || vistos.has(id) || !(vizinho.type in NIVEL)) continue;
      if (NIVEL[vizinho.type] >= NIVEL[atual.type]) continue;
      vistos.add(id);
      if (vizinho.type === 'ont') clientes.push(vizinho);
      else fila.push(vizinho);
    }
  }
  return clientes;
}
