import { GLOBAIS_SEM_PRAZO, SEM_PRAZO, WINDOWS } from '../config/retention.js';

/**
 * Gera o bloco de retenção de `docs/lgpd-inventario-de-dados.md` a partir de
 * `config/retention.js`.
 *
 * O documento é derivado, não redigitado: era a tabela da seção 4 escrita à mão
 * que apodrecia (o prazo de `wa_messages` dito "inexistente" quando existe, os
 * bilhetes e o bloqueio de login omitidos, a linha do scheduler que mudou).
 * `test/retention-registry.test.js` exige que o bloco do arquivo seja IGUAL a
 * este; `scripts/render-retention-doc.js` reescreve quando não for.
 */
export const BEGIN_MARKER = '<!-- retention:begin — gerado de backend/src/config/retention.js; não edite à mão, rode `node backend/scripts/render-retention-doc.js` -->';
export const END_MARKER = '<!-- retention:end -->';

const QUEM_MUDA = Object.freeze({
  provider: 'o provedor, numa tela',
  'provider-capped': 'o provedor, numa tela — e o teto do plano pode encurtar o que ele escolheu',
  deployment: 'quem tem o servidor, por variável de ambiente',
  fixed: 'ninguém: fixo no código'
});

function prazo(janela) {
  if (janela.defaultDays === 0) return '**nenhum** — nada apaga sozinho até alguém configurar';
  const unidade = janela.defaultDays === 1 ? 'dia' : 'dias';
  return `**${janela.defaultDays} ${unidade}**`;
}

function limites(janela) {
  if (janela.minDays === null || janela.maxDays === null) return '—';
  return `${janela.minDays}–${janela.maxDays} dias`;
}

function celula(texto) {
  return String(texto).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderRetentionMarkdown() {
  const linhas = [];
  linhas.push(BEGIN_MARKER, '');
  linhas.push('### 4.1 O que o código apaga por idade', '');
  linhas.push('| Dado | Tabela | Prazo padrão | Limites | Quem muda | Relógio | O que a poda poupa |');
  linhas.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const j of WINDOWS) {
    const tabelas = j.tables.length ? j.tables.map((t) => `\`${t}\``).join(', ') : '(arquivos em disco)';
    linhas.push(
      `| ${celula(j.label)} | ${tabelas} | ${prazo(j)} | ${limites(j)} | ${celula(QUEM_MUDA[j.configuredBy])} | ${celula(j.clock)} | ${celula(j.spares ?? '—')} |`
    );
  }
  linhas.push('');
  linhas.push(
    'Onde a coluna "Quem muda" diz que o teto do plano pode encurtar, a janela que **vale** é o menor dos dois, '
    + 'e "para sempre" vira o próprio teto (`SubscriptionService.effectiveRetention`). É a única janela que o '
    + 'provedor não escolheu: a tela mostra o número dele, não o que vale.'
  );
  linhas.push('');

  const semPrazo = Object.entries(SEM_PRAZO);
  linhas.push(`### 4.2 O que nenhuma rotina apaga por idade — ${semPrazo.length} tabelas com dado de assinante`, '');
  linhas.push('"Sem prazo" não é "nunca sai": várias têm saída pelo ciclo de vida, e todas as do assinante saem pela exclusão do art. 18. O que não existe é uma rotina que as apague porque ficaram velhas.', '');
  linhas.push('| Tabela | O que guarda, e o que a tira de lá |');
  linhas.push('| --- | --- |');
  for (const [tabela, motivo] of semPrazo) linhas.push(`| \`${tabela}\` | ${celula(motivo)} |`);
  linhas.push('');

  const globais = Object.entries(GLOBAIS_SEM_PRAZO);
  linhas.push(`### 4.3 O mesmo, nas ${globais.length} tabelas globais com dado pessoal e sem janela (somos o controlador)`, '');
  linhas.push('| Tabela | O que guarda |');
  linhas.push('| --- | --- |');
  for (const [tabela, motivo] of globais) linhas.push(`| \`${tabela}\` | ${celula(motivo)} |`);
  linhas.push('', END_MARKER);
  return linhas.join('\n');
}

/** Substitui o bloco entre os marcadores; devolve `null` se o arquivo não os tem. */
export function replaceRetentionBlock(documento, bloco = renderRetentionMarkdown()) {
  const abre = documento.indexOf('<!-- retention:begin');
  const fecha = documento.indexOf(END_MARKER);
  if (abre === -1 || fecha === -1 || fecha < abre) return null;
  return documento.slice(0, abre) + bloco + documento.slice(fecha + END_MARKER.length);
}
