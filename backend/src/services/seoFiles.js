/**
 * `robots.txt` e `sitemap.xml`.
 *
 * Os dois dependem de uma pergunta só, e é a que decide tudo aqui: **este host
 * é o ápice da plataforma?** Porque só no ápice existe algo público — a vitrine
 * (`pages/landing.tsx`), com o catálogo de planos e o cadastro. Em qualquer
 * outro endereço deste mesmo processo o que há é painel de provedor, console ou
 * portal de assinante: tudo atrás de sessão, e nada que deva aparecer numa
 * busca.
 *
 * Num deploy de host único — sem `TENANT_BASE_DOMAIN` e sem
 * `PLATFORM_EXTRA_HOSTS` — **não há ápice**: `resolveTenant` cai no provedor
 * padrão, o perfil público nomeia aquele provedor e `LandingRoute` manda a raiz
 * para `/platform`. Lá a vitrine não está no ar, e o efeito útil destes dois
 * arquivos é só um: manter o painel fora dos buscadores. O SEO acende sozinho
 * no dia em que um nome de marketing entrar em `PLATFORM_EXTRA_HOSTS`, que é
 * para isso que ele existe.
 */

/**
 * As rotas que a árvore do console serve sem sessão (`app.tsx`, `ConsoleRoutes`)
 * e que fazem sentido para um estranho. `/impersonate` também mora lá e NÃO
 * entra: é o resgate de um bilhete, não uma página.
 */
export const PUBLIC_PATHS = Object.freeze(['/', '/signup', '/login', '/privacidade']);

/**
 * E destas, as que um buscador deve ANUNCIAR. A entrada fica de fora de
 * propósito: página de login não é destino de quem chega de uma busca — é para
 * onde se volta. Liberada no `robots.txt`, para não parecer bloqueio; só não
 * oferecida no mapa.
 */
export const SITEMAP_PATHS = Object.freeze(['/', '/signup', '/privacidade']);

/**
 * O `robots.txt` deste host.
 *
 * Fora do ápice é `Disallow: /` e **nenhuma linha `Sitemap:`** — um painel de
 * provedor não anuncia mapa, e apontar para um que responde 404 seria pior do
 * que não apontar.
 *
 * No ápice a forma é de lista de permissão (`Disallow: /` primeiro, e as
 * exceções depois), e não de lista de proibição. A diferença aparece no dia em
 * que alguém acrescentar uma rota pública: com lista de proibição ela nasceria
 * indexável e ninguém saberia; assim ela nasce fechada até alguém decidir o
 * contrário. `Allow:` e o âncora `$` são extensão (Google, Bing) — o rastreador
 * que não os entende lê apenas o `Disallow: /`, o que erra para o lado seguro.
 */
export function robotsFor({ platformHost, host }) {
  if (!platformHost) {
    return ['User-agent: *', 'Disallow: /', ''].join('\n');
  }

  const linhas = ['User-agent: *', 'Disallow: /'];
  for (const caminho of PUBLIC_PATHS) {
    linhas.push(`Allow: ${caminho === '/' ? '/$' : caminho}`);
  }
  const base = origemPublica(host);
  if (base) linhas.push('', `Sitemap: ${base}/sitemap.xml`);
  return [...linhas, ''].join('\n');
}

/**
 * O `sitemap.xml` deste host, ou `null` quando o host não é o ápice — e aí a
 * rota responde 404, que é o que o arquivo é ali: inexistente. Um `urlset`
 * vazio seria ruído, e um que anuncia endereços que redirecionam é pior.
 *
 * Sem `lastmod`: não temos data honesta para a vitrine (ela muda com o deploy,
 * não com conteúdo), e uma data inventada é exatamente o que faz um buscador
 * parar de confiar no arquivo.
 */
export function sitemapFor({ platformHost, host }) {
  if (!platformHost) return null;
  const base = origemPublica(host);
  if (!base) return null;

  const urls = SITEMAP_PATHS.map((caminho) => {
    const absoluto = `${base}${caminho === '/' ? '/' : caminho}`;
    return `  <url><loc>${escaparXml(absoluto)}</loc></url>`;
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    ''
  ].join('\n');
}

/**
 * `https://<host>`, com o host do próprio pedido.
 *
 * Ecoar o cabeçalho `Host` costuma ser defeito; aqui não é, e o motivo é o
 * ramo: só se chega neste código com `platformHost`, e quem o define é
 * `isPlatformHost()`, que confere o nome contra a allowlist do ápice
 * (`TENANT_BASE_DOMAIN`, `www.` dele e `PLATFORM_EXTRA_HOSTS`). Fora da
 * allowlist a resposta não carrega host nenhum.
 *
 * `https` fixo, pelo precedente de `panelUrlFor` em `services/mail/index.js`,
 * que monta `https://${slug}.${base}` sem adivinhar protocolo: um ápice público
 * com TLS terminado no proxy é a única forma suportada de servir isto.
 */
function origemPublica(host) {
  const limpo = String(host || '').trim().toLowerCase();
  if (!limpo || !/^[a-z0-9.-]+$/.test(limpo)) return null;
  return `https://${limpo}`;
}

function escaparXml(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
