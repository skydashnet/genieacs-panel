import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A lista de com quem o dado é compartilhado não pode ficar para trás em
 * silêncio.
 *
 * Acrescentar uma chamada a um serviço de fora não produz exceção, teste
 * vermelho nem linha de log: o código passa a mandar dado para um destino novo,
 * e `docs/lista-de-compartilhamento.md` continua dizendo o que dizia. O titular
 * lê uma lista incompleta no exato documento que existe para dizer a verdade
 * sobre isso. Então a regra é a dos outros guardas do projeto: que o silêncio
 * vire falha.
 *
 * **Como a cobertura é medida.** Lendo a fonte atrás de endereços `https://…` e
 * exigindo que cada host esteja no documento ou numa exceção declarada aqui, com
 * o motivo. Uma lista de hosts declarada ao lado seria uma segunda verdade capaz
 * de discordar do código — o mesmo argumento de `lgpd-inventario.test.js`.
 *
 * **O que não alcança:** endereço que o provedor digita numa tela (ERP, GenieACS,
 * Evolution, IA trocada). Não está no código, e o documento o descreve pelo que
 * faz.
 */
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, '..', '..');
const DOC = path.join(RAIZ, 'docs', 'lista-de-compartilhamento.md');

/** Onde procurar. `i18n` fica de fora: é texto de tela, cheio de endereços de exemplo. */
const PASTAS = [
  { dir: path.join(RAIZ, 'backend', 'src'), pular: ['i18n'] },
  { dir: path.join(RAIZ, 'frontend', 'src'), pular: [] },
  { dir: path.join(RAIZ, 'frontend', 'public'), pular: [] }
];
const ARQUIVOS_SOLTOS = [path.join(RAIZ, 'frontend', 'index.html'), path.join(RAIZ, 'frontend', 'portal.html')];
const EXTENSOES = new Set(['.js', '.ts', '.tsx', '.html']);

/**
 * Hosts que aparecem na fonte e NÃO são destino de dado — cada um com o motivo.
 * Sem o motivo escrito a exceção seria só um jeito de calar o teste.
 */
const NAO_E_DESTINO = {
  'www.w3.org': 'namespace de XML/SVG, não é requisição',
  'www.sitemaps.org': 'namespace do sitemap.xml, não é requisição',
  'www.opengis.net': 'namespace de XML geográfico, não é requisição',
  'genieacs.agent': 'nome interno do agente em processo, não resolve na rede',
  'painel.tr69.com.br': 'o próprio domínio do painel, citado em exemplos e comentários',
  'painel.exemplo.com': 'endereço de exemplo em comentário e placeholder',
  'portal.exemplo.com': 'endereço de exemplo em comentário e placeholder',
  'evolution.exemplo.com': 'endereço de exemplo em placeholder',
  'acs.exemplo.com': 'endereço de exemplo em placeholder',
  'acs.seu-provedor.com.br': 'endereço de exemplo em placeholder',
  'sgp.seu-provedor.com.br': 'endereço de exemplo em placeholder',
  'portal.seuprovedor.com.br': 'endereço de exemplo em placeholder',
  'portal.yourisp.com': 'endereço de exemplo em placeholder',
  'portal.suproveedor.com': 'endereço de exemplo em placeholder',
  'provedor.sgp.net.br': 'endereço de exemplo em placeholder',
  'wa.me': 'link de clique-para-conversar que o usuário abre; o painel não envia nada',
  'waze.com': 'link de navegação que o usuário abre; o painel não envia nada',
  'www.google.com': 'link de rota que o usuário abre; o painel não envia nada',
  'maps.google.com': 'link montado numa mensagem; só a pessoa que o abre fala com o Google',
  'www.youtube.com': 'link para o canal da plataforma montado a partir do perfil',
  'developers.facebook.com': 'link de documentação que o usuário abre',
  'business.facebook.com': 'link de configuração que o usuário abre',
  'platform.claude.com': 'link "Comprar créditos" que o usuário abre; o painel não envia nada',
  'platform.openai.com': 'link "Comprar créditos" que o usuário abre; o painel não envia nada',
  'open.bigmodel.cn': 'link "Comprar créditos" que o usuário abre; o painel não envia nada'
};

function arquivosDe(dir, pular) {
  const achados = [];
  for (const nome of readdirSync(dir)) {
    if (pular.includes(nome) || nome === 'node_modules') continue;
    const caminho = path.join(dir, nome);
    if (statSync(caminho).isDirectory()) achados.push(...arquivosDe(caminho, pular));
    else if (EXTENSOES.has(path.extname(nome))) achados.push(caminho);
  }
  return achados;
}

function hostsDaFonte() {
  const arquivos = [
    ...PASTAS.flatMap(({ dir, pular }) => (existsSync(dir) ? arquivosDe(dir, pular) : [])),
    ...ARQUIVOS_SOLTOS.filter((f) => existsSync(f))
  ];
  const hosts = new Map();
  for (const arquivo of arquivos) {
    const fonte = readFileSync(arquivo, 'utf8');
    for (const m of fonte.matchAll(/https?:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g)) {
      const host = m[1].toLowerCase();
      if (!hosts.has(host)) hosts.set(host, path.relative(RAIZ, arquivo));
    }
  }
  return hosts;
}

const documento = readFileSync(DOC, 'utf8');
const hosts = hostsDaFonte();

describe('a lista de compartilhamento', () => {
  /**
   * O caso que dá nome ao arquivo.
   */
  it('não deixa nenhum host que o código alcança sem decisão', () => {
    const calados = [...hosts.keys()]
      .filter((h) => !(h in NAO_E_DESTINO) && !documento.includes(h))
      .sort();

    assert.deepEqual(calados, [], calados.length
      ? `O código cita ${calados.map((h) => `${h} (${hosts.get(h)})`).join(', ')} e a lista de compartilhamento não diz.\n`
        + 'Cada host precisa de UMA das duas coisas:\n'
        + '  (a) entrar em docs/lista-de-compartilhamento.md, com o que sai e para quê; ou\n'
        + '  (b) entrar em NAO_E_DESTINO aqui, com o motivo escrito, se não recebe dado.\n'
        + 'Sem isso o titular lê uma lista incompleta onde a LGPD manda informar — em silêncio.'
      : undefined);
  });

  it('e toda exceção "não é destino" traz o motivo por escrito', () => {
    const semMotivo = Object.entries(NAO_E_DESTINO)
      .filter(([, motivo]) => motivo.trim().length < 15)
      .map(([host]) => host);

    assert.deepEqual(semMotivo, []);
  });

  it('e não sobra exceção para host que o código já não cita', () => {
    const sobrando = Object.keys(NAO_E_DESTINO).filter((h) => !hosts.has(h));

    assert.deepEqual(sobrando, [], sobrando.length
      ? `Em NAO_E_DESTINO e fora da fonte: ${sobrando.join(', ')}. Tire da lista.`
      : undefined);
  });

  it('e nenhum host está na lista e também declarado como não-destino', () => {
    const ambos = Object.keys(NAO_E_DESTINO).filter((h) => documento.includes(h));

    assert.deepEqual(ambos, [], `Em docs e em NAO_E_DESTINO ao mesmo tempo: ${ambos.join(', ')}.`);
  });

  /**
   * Os destinos que recebem dado de ASSINANTE e não têm endereço no código — o
   * documento tem que nomeá-los pelo que são, porque o teste acima não os vê.
   */
  it('nomeia os destinos que o provedor configura e o código não enumera', () => {
    for (const nome of ['GenieACS', 'Evolution', 'SGP', 'Provedor de IA', 'TeiaH', 'Focus Chat', 'Telegram', 'Nominatim']) {
      assert.ok(documento.includes(nome), `a lista não cita ${nome}`);
    }
  });
});
