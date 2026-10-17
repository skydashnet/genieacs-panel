/**
 * Política de destino do servidor Evolution: normalização da URL e allowlist.
 *
 * Portado de compra-venda `supabase/functions/_shared/evolution-policy.ts`.
 */

import { isHostAllowed as isHostAllowedGeneric } from './hostAllowlist.js';

export { extractHost, hostMatchesPattern, parseAllowedHosts } from './hostAllowlist.js';

/**
 * O Evolution publica o Manager (web UI) em /manager; a API REST responde na
 * raiz. É comum o operador colar a URL do Manager (ex.: .../manager/instances) —
 * removemos /manager e o que vier depois para não montar caminhos inválidos.
 */
export function normalizeEvoUrl(raw) {
  return String(raw || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/manager(\/.*)?$/i, '')
    .replace(/\/+$/, '');
}

/**
 * Allowlist VAZIA = qualquer host público (o ssrfGuard segue barrando rede
 * interna). É o default: o provedor sobe o próprio servidor Evolution, então
 * exigir enumeração prévia inviabilizaria a integração. Preencher a lista é o
 * modo estrito.
 */
export function isHostAllowed(rawUrl, allowed) {
  return isHostAllowedGeneric(normalizeEvoUrl(rawUrl), allowed);
}
