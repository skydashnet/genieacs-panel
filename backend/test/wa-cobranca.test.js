import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  VARIAVEIS_DE_COBRANCA,
  comoReal,
  comoDataBr,
  diasEntre,
  variaveisDeCobranca,
  renderCobranca,
  modeloEhLembrete,
  variaveisDesconhecidas,
  maisAntigaEmAberto
} from '../src/utils/wa/waCobranca.js';

const HOJE = new Date('2026-09-08T12:00:00Z');

const vencida = { amount: 129.9, dueDate: '2026-08-27', pix: 'PIX1', digitableLine: '0001', link: 'https://b/1', paid: false };
const aVencer = { amount: 89.9, dueDate: '2026-09-15', pix: 'PIX2', digitableLine: '0002', link: 'https://b/2', paid: false };
const paga = { amount: 50, dueDate: '2026-07-01', paid: true };

describe('formatting', () => {
  test('money is Brazilian, without Intl', () => {
    assert.equal(comoReal(129.9), 'R$ 129,90');
    assert.equal(comoReal(1234.5), 'R$ 1.234,50');
    assert.equal(comoReal(1234567.89), 'R$ 1.234.567,89');
    assert.equal(comoReal(0), 'R$ 0,00');
    assert.equal(comoReal('nao-numero'), '');
  });

  test('dates are dd/mm/yyyy and read in UTC', () => {
    assert.equal(comoDataBr('2026-08-27'), '27/08/2026');
    assert.equal(comoDataBr(new Date('2026-01-05T00:00:00Z')), '05/01/2026');
    assert.equal(comoDataBr(null), '');
    assert.equal(comoDataBr('nao-data'), '');
  });

  test('day counting ignores the clock, so a due date is a calendar day', () => {
    // Both instants are the same calendar day; a timezone-naive subtraction
    // would call this a day of arrears.
    assert.equal(diasEntre('2026-09-08T23:00:00Z', '2026-09-08T01:00:00Z'), 0);
    assert.equal(diasEntre('2026-08-27', HOJE), 12);
    assert.equal(diasEntre('2026-09-15', HOJE), -7);
  });
});

describe('the mirror variables', () => {
  test('an overdue invoice fills dias_atraso and empties dias_para_vencer', () => {
    const v = variaveisDeCobranca(vencida, 'João', HOJE);
    assert.equal(v.dias_atraso, '12');
    assert.equal(v.dias_para_vencer, '');
    assert.equal(v.valor, 'R$ 129,90');
    assert.equal(v.vencimento, '27/08/2026');
  });

  test('an invoice not yet due does the opposite', () => {
    const v = variaveisDeCobranca(aVencer, 'Maria', HOJE);
    assert.equal(v.dias_atraso, '');
    assert.equal(v.dias_para_vencer, '7');
  });

  test('an invoice due today counts as not yet due', () => {
    const v = variaveisDeCobranca({ ...aVencer, dueDate: '2026-09-08' }, 'Ana', HOJE);
    assert.equal(v.dias_atraso, '');
    assert.equal(v.dias_para_vencer, '0');
  });
});

describe('the refusal rule', () => {
  test('renders when every cited variable has a value', () => {
    const texto = renderCobranca(
      'Oi {{nome}}, sua fatura de {{valor}} venceu há {{dias_atraso}} dias. PIX: {{pix}}',
      variaveisDeCobranca(vencida, 'João', HOJE)
    );
    assert.equal(texto, 'Oi João, sua fatura de R$ 129,90 venceu há 12 dias. PIX: PIX1');
  });

  test('refuses the whole message when one variable is empty', () => {
    // The invoice carries no PIX code. Sending "PIX: " tells a debtor to pay
    // nothing; leaving "{{pix}}" literal tells them to pay a placeholder.
    const semPix = { ...vencida, pix: '' };
    assert.equal(
      renderCobranca('Pague por PIX: {{pix}}', variaveisDeCobranca(semPix, 'João', HOJE)),
      null
    );
  });

  test('a dunning text cannot reach someone who is not yet due', () => {
    // This is the rule doing its work: `dias_atraso` is empty for a future
    // invoice, so the whole message is refused. No screen warning, no operator
    // discipline — the render refuses.
    assert.equal(
      renderCobranca('Está em atraso há {{dias_atraso}} dias', variaveisDeCobranca(aVencer, 'Maria', HOJE)),
      null
    );
  });

  test('a reminder cannot reach someone already overdue', () => {
    assert.equal(
      renderCobranca('Vence em {{dias_para_vencer}} dias', variaveisDeCobranca(vencida, 'João', HOJE)),
      null
    );
  });

  test('a template with no variables always renders', () => {
    assert.equal(renderCobranca('Passe na loja', {}), 'Passe na loja');
  });
});

describe('template classification', () => {
  test('a template citing dias_para_vencer declares itself a reminder', () => {
    assert.equal(modeloEhLembrete('Vence em {{dias_para_vencer}} dias'), true);
    assert.equal(modeloEhLembrete('Vence em {{ dias_para_vencer }} dias'), true);
    assert.equal(modeloEhLembrete('Atraso de {{dias_atraso}} dias'), false);
    assert.equal(modeloEhLembrete(''), false);
  });

  test('reports variables the dispatcher cannot fill', () => {
    assert.deepEqual(variaveisDesconhecidas('Oi {{nome}}, {{cidade}} e {{pedido}}'), ['cidade', 'pedido']);
    assert.deepEqual(variaveisDesconhecidas('Oi {{nome}}, {{valor}}'), []);
  });

  test('every documented variable is fillable', () => {
    const v = variaveisDeCobranca(vencida, 'João', HOJE);
    for (const nome of VARIAVEIS_DE_COBRANCA) {
      assert.ok(nome in v, nome);
    }
  });
});

describe('choosing the invoice to cite', () => {
  test('the oldest overdue one wins', () => {
    const maisVelha = { ...vencida, dueDate: '2026-07-10', pix: 'ANTIGA' };
    const { fatura, soFuturas } = maisAntigaEmAberto([vencida, maisVelha, aVencer], HOJE);
    assert.equal(fatura.pix, 'ANTIGA');
    assert.equal(soFuturas, false);
  });

  test('paid invoices are never cited', () => {
    assert.equal(maisAntigaEmAberto([paga], HOJE).fatura, null);
  });

  test('with only future invoices, a dunning template gets nothing and says why', () => {
    const { fatura, soFuturas } = maisAntigaEmAberto([aVencer], HOJE, false);
    assert.equal(fatura, null);
    // The caller needs the reason so the skip count can say "only has invoices
    // not yet due" rather than lumping it with "no open invoice".
    assert.equal(soFuturas, true);
  });

  test('with only future invoices, a reminder gets the next one', () => {
    const { fatura, soFuturas } = maisAntigaEmAberto([aVencer], HOJE, true);
    assert.equal(fatura.pix, 'PIX2');
    assert.equal(soFuturas, false);
  });

  test('an empty wallet is not "only future"', () => {
    assert.deepEqual(maisAntigaEmAberto([], HOJE), { fatura: null, soFuturas: false });
  });
});
