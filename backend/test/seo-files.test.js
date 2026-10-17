import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PUBLIC_PATHS, SITEMAP_PATHS, robotsFor, sitemapFor } from '../src/services/seoFiles.js';

/**
 * O que estes dois arquivos dizem a um buscador.
 *
 * O caso que importa neste deploy não é o SEO: é o contrário dele. Sem ápice
 * configurado — sem `TENANT_BASE_DOMAIN` e sem `PLATFORM_EXTRA_HOSTS` — não há
 * página pública nenhuma, e o único efeito útil de servir `robots.txt` é manter
 * o painel de um provedor fora dos resultados de busca. É esse o caso que o
 * primeiro teste fixa.
 */
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FONTE_DAS_ROTAS = path.join(AQUI, '..', '..', 'frontend', 'src', 'app.tsx');

/**
 * As rotas que a árvore do console serve, lidas da fonte do frontend.
 *
 * Lidas, e não declaradas aqui: uma lista ao lado seria livre para discordar das
 * rotas de verdade, e um mapa que anuncia um endereço que redireciona é pior do
 * que mapa nenhum — o buscador aprende a não confiar no arquivo.
 */
function rotasDoConsole() {
  const fonte = readFileSync(FONTE_DAS_ROTAS, 'utf8');
  const abre = fonte.indexOf('function ConsoleRoutes()');
  assert.ok(abre > -1, 'ConsoleRoutes saiu de app.tsx: reveja esta leitura');
  const bloco = fonte.slice(abre, fonte.indexOf('\n}', abre));
  return new Set([...bloco.matchAll(/path="([^"]+)"/g)].map((m) => m[1]));
}

describe('o robots.txt', () => {
  /**
   * O caso que dá nome ao arquivo.
   */
  it('fecha tudo num host que não é o ápice da plataforma', () => {
    const texto = robotsFor({ platformHost: false, host: 'painel.tr69.com.br' });

    assert.match(texto, /^User-agent: \*$/m);
    assert.match(texto, /^Disallow: \/$/m);
    assert.doesNotMatch(texto, /^Allow:/m);
  });

  /**
   * E não anuncia mapa. Um `Sitemap:` apontando para o 404 do próximo teste
   * seria a contradição que faz o buscador desconfiar do arquivo inteiro.
   */
  it('e não aponta para mapa nenhum fora do ápice', () => {
    const texto = robotsFor({ platformHost: false, host: 'painel.tr69.com.br' });

    assert.doesNotMatch(texto, /Sitemap:/);
  });

  it('abre as páginas públicas no ápice, e só elas', () => {
    const texto = robotsFor({ platformHost: true, host: 'tr69.com.br' });

    // A forma é de lista de permissão: `Disallow: /` primeiro, exceções depois.
    // É o que faz uma rota pública nova nascer fechada em vez de indexável.
    assert.match(texto, /^Disallow: \/$/m);
    assert.match(texto, /^Allow: \/\$$/m);
    assert.match(texto, /^Allow: \/signup$/m);
    assert.match(texto, /^Allow: \/login$/m);
    // A política é onde o titular lê o que fazemos com o dado: bloqueá-la do
    // buscador esconderia justamente o aviso que a LGPD (art. 9º) manda dar.
    assert.match(texto, /^Allow: \/privacidade$/m);

    const liberadas = [...texto.matchAll(/^Allow: (.+)$/gm)].map((m) => m[1]);
    assert.equal(liberadas.length, PUBLIC_PATHS.length);
  });

  it('e aponta o mapa no próprio host do pedido', () => {
    const texto = robotsFor({ platformHost: true, host: 'tr69.com.br' });

    assert.match(texto, /^Sitemap: https:\/\/tr69\.com\.br\/sitemap\.xml$/m);
  });

  /**
   * O host chega do cabeçalho `Host`, e ecoá-lo só é seguro porque quem chama
   * com `platformHost: true` é o ramo que já conferiu o nome contra a allowlist
   * do ápice. Esta é a rede embaixo disso: um host com lixo não vira endereço.
   */
  it('e não monta endereço a partir de um host que não é nome de host', () => {
    for (const host of ['', '  ', 'tr69.com.br/evil', 'tr69.com.br"', 'a b']) {
      const texto = robotsFor({ platformHost: true, host });
      assert.doesNotMatch(texto, /Sitemap:/, `host aceito indevidamente: ${JSON.stringify(host)}`);
    }
  });
});

describe('o sitemap.xml', () => {
  it('não existe fora do ápice', () => {
    assert.equal(sitemapFor({ platformHost: false, host: 'painel.tr69.com.br' }), null);
  });

  it('e lista as páginas públicas no ápice', () => {
    const xml = sitemapFor({ platformHost: true, host: 'tr69.com.br' });

    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.match(xml, /<loc>https:\/\/tr69\.com\.br\/<\/loc>/);
    assert.match(xml, /<loc>https:\/\/tr69\.com\.br\/signup<\/loc>/);
    assert.match(xml, /<loc>https:\/\/tr69\.com\.br\/privacidade<\/loc>/);
  });

  /**
   * A entrada fica de fora do mapa de propósito — não é destino de quem chega de
   * uma busca —, e continua liberada no `robots.txt`. Se um dia alguém a
   * acrescentar, que seja decidindo, não por acidente.
   */
  it('e não anuncia a tela de entrada', () => {
    const xml = sitemapFor({ platformHost: true, host: 'tr69.com.br' });

    assert.doesNotMatch(xml, /\/login/);
  });

  /**
   * O caso que protege a honestidade do arquivo: todo endereço anunciado tem que
   * ser uma rota que a árvore do console realmente serve. Renomear `/signup` lá
   * e esquecer aqui produziria um mapa que anuncia um redirecionamento.
   */
  it('e todo endereço que ele anuncia é uma rota que o console serve', () => {
    const servidas = rotasDoConsole();
    const fantasmas = [...SITEMAP_PATHS, ...PUBLIC_PATHS].filter((p) => !servidas.has(p));

    assert.deepEqual(fantasmas, [], fantasmas.length
      ? `Anunciada(s) e fora de ConsoleRoutes: ${fantasmas.join(', ')}.`
      : undefined);
  });

  /**
   * E o contrário, que é o que mantém a lista de permissão fazendo o seu
   * trabalho: uma rota pública nova na árvore do console tem que ser decidida —
   * entra nas liberadas ou fica fechada —, e não passar despercebida.
   */
  it('e toda rota pública do console está classificada', () => {
    // `/impersonate` resgata um bilhete; `/platform` é o console, atrás de
    // sessão; `*` é o redirecionamento. Nenhuma é página.
    const NAO_E_PAGINA = new Set(['/impersonate', '/platform', '*']);
    const naoClassificadas = [...rotasDoConsole()]
      .filter((p) => !PUBLIC_PATHS.includes(p) && !NAO_E_PAGINA.has(p));

    assert.deepEqual(naoClassificadas, [], naoClassificadas.length
      ? `Rota(s) pública(s) nova(s) em ConsoleRoutes: ${naoClassificadas.join(', ')}.\n`
        + 'Decida: entra em PUBLIC_PATHS (e talvez em SITEMAP_PATHS) ou em NAO_E_PAGINA aqui.'
      : undefined);
  });
});
