import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, call, startTestServers, stopTestServers } from './helpers/harness.js';

const { STARTER_TEMPLATES } = await import('../src/services/waDunningService.js');
const { default: WaTemplateService } = await import('../src/services/waTemplateService.js');
const { modeloEhLembrete, modeloCitaOsDoisEspelhos } = await import('../src/utils/wa/waCobranca.js');

/**
 * O botão "Usar modelos prontos": cria os modelos sugeridos e, numa régua sem
 * etapas, preenche as etapas com eles — sem nunca ligar a régua e sem nunca
 * sobrescrever o que o operador já editou.
 */

let panelUrl;
let token;
const api = (path, options = {}) => call(`${panelUrl}/api/whatsapp${path}`, { headers: authHeaders(token), ...options });

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
});

after(async () => {
  await stopTestServers();
});

describe('os modelos prontos', () => {
  it('passam na validação e obedecem aos espelhos', () => {
    for (const starter of STARTER_TEMPLATES) {
      assert.doesNotThrow(() => WaTemplateService.validate(starter), starter.name);
      assert.equal(modeloCitaOsDoisEspelhos(starter.body), false, starter.name);
      if (starter.offsetDays === null) {
        assert.doesNotMatch(starter.body, /dias_atraso|dias_para_vencer/, 'o agradecimento não cita dia');
      } else if (starter.offsetDays > 0) {
        assert.equal(modeloEhLembrete(starter.body), false, `${starter.name} é cobrança`);
        assert.match(starter.body, /\{\{dias_atraso\}\}/);
      } else {
        assert.doesNotMatch(starter.body, /dias_atraso/, `${starter.name} não cita atraso`);
      }
      assert.ok(starter.name.length <= 80);
    }
  });
});

describe('POST /api/whatsapp/dunning/starter', () => {
  it('cria os modelos, preenche as etapas e o agradecimento, e não liga a régua', async () => {
    const { status, body } = await api('/dunning/starter', { method: 'POST' });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.data.created, STARTER_TEMPLATES.length);
    assert.equal(body.data.reused, 0);
    assert.equal(body.data.stepsFilled, true);
    const rule = body.data.rule;
    assert.equal(rule.enabled, false, 'o botão nunca liga a régua');
    assert.deepEqual(rule.steps.map((s) => s.offsetDays), [-3, 0, 1, 5, 10, 20]);
    assert.ok(rule.thanksTemplateId);

    const templates = (await api('/templates')).body.data;
    const nomes = new Set(templates.map((t) => t.name));
    for (const starter of STARTER_TEMPLATES) assert.ok(nomes.has(starter.name), starter.name);
    assert.equal(templates.find((t) => t.id === rule.thanksTemplateId).name, 'Régua · Agradecimento');
  });

  it('de novo: reaproveita, não duplica e não sobrescreve o que o operador editou', async () => {
    const templates = (await api('/templates')).body.data;
    const lembrete = templates.find((t) => t.name === 'Régua · Lembrete (3 dias antes)');
    const editado = 'Oi {{nome}}, faltam {{dias_para_vencer}} dias. PIX: {{pix}}';
    const put = await api(`/templates/${lembrete.id}`, { method: 'PUT', body: { body: editado } });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    const antes = (await api('/dunning/rule')).body.data.steps;
    const { status, body } = await api('/dunning/starter', { method: 'POST' });
    assert.equal(status, 200);
    assert.equal(body.data.created, 0);
    assert.equal(body.data.reused, STARTER_TEMPLATES.length);
    assert.equal(body.data.stepsFilled, false, 'régua com etapas fica como está');
    assert.deepEqual(body.data.rule.steps, antes);

    const depois = (await api('/templates')).body.data;
    assert.equal(depois.length, templates.length);
    assert.equal(depois.find((t) => t.id === lembrete.id).body, editado);
  });
});
