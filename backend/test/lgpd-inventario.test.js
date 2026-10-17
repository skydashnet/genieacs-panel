import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Toda tabela escopada tem que estar classificada, e o teste existe porque a
 * falta de classificação **não dá erro**.
 *
 * Quando um titular exerce o direito de acesso, `customerDataExportService`
 * monta o arquivo percorrendo tabela por tabela, à mão — não há laço sobre o
 * schema, e o docblock de lá explica por quê: o dado de uma pessoa se liga por
 * `account_id` numas, por `device_id` noutras, por contrato, por telefone e por
 * login PPPoE. Um laço genérico traria linha de outro assinante ou não traria
 * nada.
 *
 * O preço desse mapa à mão é que ele pode ficar para trás. Acrescentar uma
 * tabela escopada e esquecer de classificá-la produz exatamente nada de
 * visível: nenhuma exceção, nenhum teste vermelho, nenhuma linha no log. O que
 * acontece é pior e só aparece muito depois — o dossiê entrega MENOS do que
 * existe sobre a pessoa, e `customerErasureService`, que compartilha a mesma
 * função de alcance, deixa para trás justamente o que o dossiê não mostrou.
 *
 * Então a regra aqui não é sobre estilo: é que o silêncio vire falha.
 *
 * **Como a cobertura é medida.** Lendo a fonte do serviço atrás das tabelas que
 * ele consulta, e não uma lista declarada ao lado. Uma lista seria uma segunda
 * verdade capaz de discordar das consultas de verdade — e discordar em silêncio
 * é o defeito que este arquivo existe para impedir. Ler a fonte é o precedente
 * das outras guardas estáticas do projeto (`tenant-scoping.test.js`,
 * `sql-sentinel.test.js`).
 */
const { SCOPED_TABLES } = await import('../src/config/tenantScope.js');
const { SEM_DADO_DE_ASSINANTE } = await import('../src/services/customerDataExportService.js');

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FONTE_DO_DOSSIE = path.join(AQUI, '..', 'src', 'services', 'customerDataExportService.js');

/** As tabelas que o dossiê realmente consulta, lidas das chamadas dele. */
function tabelasDoDossie() {
  const fonte = readFileSync(FONTE_DO_DOSSIE, 'utf8');
  return new Set([...fonte.matchAll(/tdb\('([a-z_]+)'/g)].map((m) => m[1]));
}

const escopadas = [...SCOPED_TABLES].sort();
const semTitular = new Set(Object.keys(SEM_DADO_DE_ASSINANTE));
const noDossie = tabelasDoDossie();

describe('o inventário de dados pessoais', () => {
  /**
   * O caso que dá nome ao arquivo.
   */
  it('não deixa nenhuma tabela escopada sem classificação', () => {
    const orfas = escopadas.filter((t) => !semTitular.has(t) && !noDossie.has(t));

    assert.deepEqual(orfas, [], orfas.length
      ? `Tabela(s) escopada(s) sem classificação: ${orfas.join(', ')}.\n`
        + 'Cada uma precisa de UMA das duas coisas:\n'
        + '  (a) entrar em SEM_DADO_DE_ASSINANTE, com o motivo escrito, se não guarda '
        + 'dado de titular; ou\n'
        + '  (b) ser percorrida por `alcanceDoAssinante`, se guarda.\n'
        + 'Sem isso o dossiê do art. 18 entrega menos do que existe, e a exclusão deixa '
        + 'essa tabela para trás — os dois em silêncio.\n'
        + 'Depois de decidir, atualize docs/lgpd-inventario-de-dados.md.'
      : undefined);
  });

  /**
   * A contradição oposta, e ela é mais sorrateira: uma tabela jurada de não ter
   * titular que o dossiê mesmo assim consulta. Uma das duas afirmações está
   * errada, e qual delas é importa — se a declaração estiver errada, há dado
   * pessoal que ninguém sabe que existe.
   */
  it('e nenhuma tabela está nos dois lugares ao mesmo tempo', () => {
    const ambos = escopadas.filter((t) => semTitular.has(t) && noDossie.has(t));

    assert.deepEqual(ambos, [], ambos.length
      ? `Tabela(s) declarada(s) sem dado de assinante e mesmo assim lida(s) pelo dossiê: ${ambos.join(', ')}.`
      : undefined);
  });

  /**
   * A declaração sem motivo é uma linha que ninguém consegue conferir depois.
   * O valor de cada entrada é a frase que justifica a ausência de titular, e
   * uma string vazia ali passaria pelos dois casos acima sem dizer nada.
   */
  it('e toda declaração traz o motivo por escrito', () => {
    const semMotivo = Object.entries(SEM_DADO_DE_ASSINANTE)
      .filter(([, motivo]) => typeof motivo !== 'string' || motivo.trim().length < 10)
      .map(([tabela]) => tabela);

    assert.deepEqual(semMotivo, [], semMotivo.length
      ? `Sem motivo escrito: ${semMotivo.join(', ')}. A frase é o que permite conferir a decisão depois.`
      : undefined);
  });

  /**
   * E o que foi declarado tem que existir. Uma tabela renomeada ou derrubada
   * deixaria aqui uma linha morta — que parece classificação e não classifica
   * nada, porque a tabela do nome novo fica órfã sem ninguém notar.
   */
  it('e não sobra declaração para tabela que não existe mais', () => {
    const fantasmas = [...semTitular].filter((t) => !SCOPED_TABLES.has(t));

    assert.deepEqual(fantasmas, [], fantasmas.length
      ? `Declarada(s) em SEM_DADO_DE_ASSINANTE mas fora de SCOPED_TABLES: ${fantasmas.join(', ')}.`
      : undefined);
  });
});
