/**
 * Allowlist de host por administrador — parsing e matching, genéricos.
 *
 * Complementa — não substitui — o guard anti-SSRF de ./ssrfGuard.js. Os dois
 * respondem a perguntas diferentes sobre a mesma URL:
 *
 *   ssrfGuard     → "este destino é público?"       (sempre aplicado)
 *   hostAllowlist → "este destino foi autorizado?"  (governança do admin)
 *
 * Como as regras são editadas por humanos num textarea, o parsing precisa ser
 * tolerante (espaços, linhas em branco, `https://` colado junto, porta,
 * maiúsculas) e o matching precisa ser estrito.
 *
 * Portado de compra-venda `supabase/functions/_shared/host-allowlist.ts`.
 */

/**
 * Extrai o hostname de uma URL ou de um host solto ("evo.loja.com",
 * "evo.loja.com:8080"). Retorna '' quando não dá para determinar — o chamador
 * trata como "não permitido".
 */
export function extractHost(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
  if (!s) return '';
  try {
    const u = new URL(s);
    // `new URL('evo.loja.com:8080')` NÃO falha: o parser lê "evo.loja.com:"
    // como esquema e devolve hostname vazio. Só aceitamos o resultado quando o
    // esquema é http/https — caso contrário cai no ramo de host solto.
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname.replace(/\.$/, '');
  } catch {
    /* não é URL absoluta — segue como host solto */
  }
  try {
    return new URL(`https://${s}`).hostname.replace(/\.$/, '');
  } catch {
    return '';
  }
}

/**
 * Normaliza a allowlist vinda do banco ou de um textarea (uma entrada por
 * linha, ou separadas por vírgula). Entradas inválidas são descartadas em
 * silêncio — um item que não vira host não pode virar permissão.
 *
 * O curinga `*.dominio.com` é preservado como está; quem interpreta é
 * hostMatchesPattern().
 */
export function parseAllowedHosts(raw) {
  const items = Array.isArray(raw)
    ? raw.map((v) => String(v ?? ''))
    : String(raw ?? '').split(/[\n,;]+/);

  const out = [];
  for (const item of items) {
    const s = item.trim().toLowerCase();
    if (!s) continue;
    if (s.startsWith('*.')) {
      const base = extractHost(s.slice(2));
      if (base) out.push(`*.${base}`);
      continue;
    }
    const h = extractHost(s);
    if (h) out.push(h);
  }
  return [...new Set(out)];
}

/**
 * `*.dominio.com` casa com qualquer subdomínio (a.dominio.com, a.b.dominio.com)
 * mas NÃO com o domínio nu — quem quiser os dois lista os dois. Sem o curinga,
 * a comparação é exata.
 *
 * O sufixo é comparado com o ponto incluído (`.dominio.com`): sem isso,
 * `malicioso-dominio.com` passaria por um endsWith('dominio.com').
 */
export function hostMatchesPattern(host, pattern) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  const p = String(pattern || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h || !p) return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // '*.loja.com' -> '.loja.com'
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === p;
}

/**
 * Allowlist VAZIA = qualquer host público (o ssrfGuard segue barrando rede
 * interna). É o default: cada provedor aponta para o próprio servidor
 * Evolution, então exigir enumeração prévia inviabilizaria a integração.
 * Preencher a lista é o modo estrito.
 */
export function isHostAllowed(rawUrl, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  const host = extractHost(rawUrl);
  if (!host) return false;
  return allowed.some((p) => hostMatchesPattern(host, p));
}
