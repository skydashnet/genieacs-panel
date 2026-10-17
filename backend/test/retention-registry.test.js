import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A retenção não pode ficar sem decisão em silêncio.
 *
 * O inventário de dados (`lgpd-inventario.test.js`) obriga toda tabela escopada a
 * ser classificada como "com titular" ou "sem". Este arquivo faz o mesmo um nível
 * abaixo: toda tabela COM titular precisa dizer o que acontece com ela com o
 * passar do tempo — ou uma janela de retenção, ou a declaração de que nenhuma
 * rotina a poda por idade. Acrescentar uma tabela com dado de assinante e não
 * dizer nada produz exatamente nada de visível: nenhuma exceção, nenhuma linha de
 * log, só uma tabela que cresce para sempre e um documento de retenção que
 * deixou de ser verdade. Então o silêncio vira falha.
 *
 * E o documento (`docs/lgpd-inventario-de-dados.md`, seção 4) é GERADO do
 * registro; aqui se confere que o arquivo bate com o gerado. A tabela escrita à
 * mão era a que envelhecia (`wa_messages` dito "sem prazo" quando o prazo
 * existe; os bilhetes, o bloqueio de login e o teto do plano esquecidos; a
 * contagem de tabelas errada em dois dos três números).
 */
const { SCOPED_TABLES, SHARED_TABLES } = await import('../src/config/tenantScope.js');
const { SEM_DADO_DE_ASSINANTE } = await import('../src/services/customerDataExportService.js');
const retention = await import('../src/config/retention.js');
const { renderRetentionMarkdown, replaceRetentionBlock } = await import('../src/utils/retentionDoc.js');

const { WINDOWS, SEM_PRAZO, GLOBAIS_SEM_PRAZO } = retention;
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(AQUI, '..', 'src');
const DOC = path.join(AQUI, '..', '..', 'docs', 'lgpd-inventario-de-dados.md');

const comTitular = [...SCOPED_TABLES].filter((t) => !(t in SEM_DADO_DE_ASSINANTE)).sort();
const comJanela = new Set(WINDOWS.flatMap((w) => w.tables));

describe('o registro de retenção', () => {
  /**
   * O caso que dá nome ao arquivo.
   */
  it('não deixa nenhuma tabela com dado de assinante sem decisão', () => {
    const sem = comTitular.filter((t) => !comJanela.has(t) && !(t in SEM_PRAZO));

    assert.deepEqual(sem, [], sem.length
      ? `Tabela(s) com dado de assinante sem decisão de retenção: ${sem.join(', ')}.\n`
        + 'Cada uma precisa de UMA das duas coisas em src/config/retention.js:\n'
        + '  (a) entrar numa janela de WINDOWS, se alguma rotina a apaga por idade; ou\n'
        + '  (b) entrar em SEM_PRAZO, com o que guarda e o que a tira de lá.\n'
        + 'Sem isso o documento de retenção deixa de ser verdade — em silêncio.\n'
        + 'Depois de decidir: node backend/scripts/render-retention-doc.js'
      : undefined);
  });

  it('e nenhuma tabela está numa janela e também declarada sem prazo', () => {
    const ambos = Object.keys(SEM_PRAZO).filter((t) => comJanela.has(t));

    assert.deepEqual(ambos, [], ambos.length
      ? `Em WINDOWS e em SEM_PRAZO ao mesmo tempo: ${ambos.join(', ')}. Uma das duas afirmações está errada.`
      : undefined);
  });

  it('e não sobra declaração para tabela que não existe, ou que não tem titular', () => {
    const fantasmas = Object.keys(SEM_PRAZO).filter((t) => !comTitular.includes(t));
    const janelasFantasmas = [...comJanela].filter((t) => !SCOPED_TABLES.has(t) && !SHARED_TABLES.has(t));
    const globaisFantasmas = Object.keys(GLOBAIS_SEM_PRAZO).filter((t) => !SHARED_TABLES.has(t));

    assert.deepEqual(fantasmas, [], `Em SEM_PRAZO mas sem titular ou fora de SCOPED_TABLES: ${fantasmas.join(', ')}.`);
    assert.deepEqual(janelasFantasmas, [], `Em WINDOWS mas fora de qualquer lista de tabelas: ${janelasFantasmas.join(', ')}.`);
    assert.deepEqual(globaisFantasmas, [], `Em GLOBAIS_SEM_PRAZO mas fora de SHARED_TABLES: ${globaisFantasmas.join(', ')}.`);
  });

  it('e toda declaração traz o motivo por escrito', () => {
    const vazias = [...Object.entries(SEM_PRAZO), ...Object.entries(GLOBAIS_SEM_PRAZO)]
      .filter(([, motivo]) => typeof motivo !== 'string' || motivo.trim().length < 20)
      .map(([tabela]) => tabela);

    assert.deepEqual(vazias, [], `Sem motivo escrito: ${vazias.join(', ')}.`);
  });

  /**
   * `source` é a promessa de "este arquivo aplica a janela". Se o arquivo mudou
   * de nome, ou deixou de ler o registro, o número do registro passou a ser
   * decoração — e foi exatamente assim que a linha do scheduler apodreceu.
   * `leads` é a exceção honesta: lê o registro via `utils/leadRetention.js`.
   */
  it('e cada janela aponta para um arquivo que existe e que lê o registro', () => {
    for (const janela of WINDOWS) {
      const arquivo = path.join(SRC, janela.source);
      assert.ok(existsSync(arquivo), `${janela.id}: ${janela.source} não existe.`);
      const fonte = readFileSync(arquivo, 'utf8');
      assert.match(
        fonte, /config\/retention\.js/,
        `${janela.id}: ${janela.source} não importa config/retention.js — o número do registro não é o que o código aplica.`
      );
    }
  });

  it('e traz, em cada janela, o que ela governa e a quem pertence a escolha', () => {
    for (const janela of WINDOWS) {
      assert.ok(janela.personalData.trim().length >= 10, `${janela.id}: falta o dado pessoal que a janela governa.`);
      assert.ok(['provider', 'provider-capped', 'deployment', 'fixed'].includes(janela.configuredBy), `${janela.id}: configuredBy inválido.`);
      assert.ok(Number.isInteger(janela.defaultDays) && janela.defaultDays >= 0, `${janela.id}: defaultDays inválido.`);
    }
    const ids = WINDOWS.map((w) => w.id);
    assert.equal(new Set(ids).size, ids.length, 'id de janela repetido.');
  });

  /**
   * O que o registro diz tem que ser o que o código faz. Estes valores são os
   * que estavam espalhados em constantes antes de o registro existir; fixá-los
   * aqui é o que impede que mudar um deles passe despercebido pelo documento
   * que o titular lê.
   */
  it('mantém os valores que o código sempre aplicou', () => {
    const por = Object.fromEntries(WINDOWS.map((w) => [w.id, w]));

    assert.deepEqual(
      [por.audit.defaultDays, por.audit.minDays, por.audit.maxDays], [365, 30, 3650]
    );
    assert.equal(por['bot-events'].defaultDays, 180);
    assert.deepEqual(
      [por['provisioning-runs'].defaultDays, por['provisioning-runs'].minDays, por['provisioning-runs'].maxDays], [90, 1, 365]
    );
    assert.deepEqual(
      [por['sgp-events'].defaultDays, por['sgp-events'].minDays, por['sgp-events'].maxDays], [90, 1, 365]
    );
    assert.deepEqual(
      [por['device-samples'].defaultDays, por['device-samples'].maxDays], [14, 365]
    );
    assert.deepEqual(
      [por['device-sample-hours'].defaultDays, por['device-sample-hours'].maxDays], [90, 3650]
    );
    // O padrão de tudo que o provedor não escolheu é NÃO apagar.
    for (const id of ['wa-messages', 'wa-media', 'leads']) assert.equal(por[id].defaultDays, 0, id);
    assert.equal(por.leads.minDays, 30);
    assert.equal(por.leads.maxDays, 3650);
    assert.equal(por['auth-tickets'].defaultDays, 1);
    assert.equal(por['impersonation-tickets'].defaultDays, 1);
    assert.equal(por['account-lockouts'].defaultDays, 1);
  });
});

describe('o documento de retenção', () => {
  it('é igual ao que o registro gera', () => {
    const documento = readFileSync(DOC, 'utf8');
    const esperado = replaceRetentionBlock(documento);

    assert.notEqual(esperado, null, 'docs/lgpd-inventario-de-dados.md perdeu os marcadores <!-- retention:begin --> / <!-- retention:end -->.');
    assert.equal(
      documento, esperado,
      'O bloco de retenção de docs/lgpd-inventario-de-dados.md diverge de src/config/retention.js.\n'
      + 'Rode: node backend/scripts/render-retention-doc.js'
    );
  });

  it('diz quantas tabelas com dado de assinante não têm poda, e o número é o do registro', () => {
    const bloco = renderRetentionMarkdown();

    assert.match(bloco, new RegExp(`${Object.keys(SEM_PRAZO).length} tabelas com dado de assinante`));
  });
});
