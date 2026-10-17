import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaBotService } = await import('../src/services/waBotService.js');
const { default: WaBotConfigService } = await import('../src/services/waBotConfigService.js');

const SENHA = 'senha-etiquetas-1';
let panelUrl;
const tokens = {};
let accountId;

const req = (method, path, body, quem = 'dona') => call(`${panelUrl}${path}`, { method, headers: authHeaders(tokens[quem]), body });

async function criarUsuario(username, role) {
  const { status } = await req('POST', '/api/users', { username, password: SENHA, role, email: `${username}@exemplo.test` });
  assert.equal(status, 201);
  const entrou = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: { username, password: SENHA } });
  tokens[username] = entrou.body.data.token;
}

async function conversa(phone) {
  const c = await asTenant(() => WaConversation.ensure({
    accountId, externalThreadId: `${phone}@s.whatsapp.net`, waPhone: phone, waLid: null, pushName: 'Cliente'
  }));
  // Na pilha "Abertas": houve gente dos dois lados.
  await getDb()('wa_conversations').where({ id: c.id }).update({ engaged_at: new Date() });
  return c.id;
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona', password: SENHA, email: 'dona@exemplo.test' }
  });
  tokens.dona = setup.body.data.token;
  await criarUsuario('tecnico', 'tech');
  const account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-etiquetas', purpose: 'support', flavor: 'v2', base_url: 'https://evo.provedor.test',
    status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-etiquetas'),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-etiquetas')
  }));
  accountId = account.id;
});

after(async () => {
  await stopTestServers();
});

describe('as etiquetas das conversas', () => {
  it('nasce com as quatro padrão, uma vez só, e apagar uma não a traz de volta', async () => {
    const primeira = await req('GET', '/api/whatsapp/tags');
    assert.equal(primeira.status, 200);
    assert.deepEqual(primeira.body.data.map((t) => t.name).sort(), ['Cancelamento', 'Financeiro', 'Suporte técnico', 'Venda']);
    const venda = primeira.body.data.find((t) => t.name === 'Venda');
    assert.equal((await req('DELETE', `/api/whatsapp/tags/${venda.id}`)).status, 200);
    const depois = await req('GET', '/api/whatsapp/tags');
    assert.equal(depois.body.data.length, 3);
  });

  it('cria com nome único e cor da paleta; o técnico aplica, mas não cria', async () => {
    const ok = await req('POST', '/api/whatsapp/tags', { name: '  Instalação  ', color: 'cyan' });
    assert.equal(ok.status, 201);
    assert.deepEqual({ name: ok.body.data.name, color: ok.body.data.color }, { name: 'Instalação', color: 'cyan' });

    const repetida = await req('POST', '/api/whatsapp/tags', { name: 'instalação', color: 'blue' });
    assert.equal(repetida.status, 409);
    assert.equal(repetida.body.code, 'tag_name_taken');

    const corRuim = await req('POST', '/api/whatsapp/tags', { name: 'Urgente', color: 'red' });
    assert.equal(corRuim.status, 400);

    const tecnico = await req('POST', '/api/whatsapp/tags', { name: 'Do técnico', color: 'blue' }, 'tecnico');
    assert.equal(tecnico.status, 403);
  });

  it('aplica, troca, filtra e mostra na lista', async () => {
    const tags = (await req('GET', '/api/whatsapp/tags')).body.data;
    const financeiro = tags.find((t) => t.name === 'Financeiro');
    const suporte = tags.find((t) => t.name === 'Suporte técnico');
    const a = await conversa('5593981150001');
    const b = await conversa('5593981150002');

    const aplicou = await req('PUT', `/api/whatsapp/conversations/${a}/tags`, { tagIds: [financeiro.id, suporte.id] }, 'tecnico');
    assert.equal(aplicou.status, 200);
    assert.deepEqual(aplicou.body.data.tags.map((t) => t.name), ['Financeiro', 'Suporte técnico']);
    await req('PUT', `/api/whatsapp/conversations/${b}/tags`, { tagIds: [suporte.id] });

    const doFinanceiro = await req('GET', `/api/whatsapp/conversations?tag=${financeiro.id}`);
    assert.deepEqual(doFinanceiro.body.data.map((c) => c.id), [a]);
    const doSuporte = await req('GET', `/api/whatsapp/conversations?tag=${suporte.id}`);
    assert.deepEqual(doSuporte.body.data.map((c) => c.id).sort(), [a, b].sort());

    // Trocar é substituir o conjunto.
    const trocou = await req('PUT', `/api/whatsapp/conversations/${a}/tags`, { tagIds: [suporte.id] });
    assert.deepEqual(trocou.body.data.tags.map((t) => t.name), ['Suporte técnico']);

    const lista = await req('GET', '/api/whatsapp/conversations');
    assert.deepEqual(lista.body.data.find((c) => c.id === b).tags.map((t) => t.color), [suporte.color]);

    const inexistente = await req('PUT', `/api/whatsapp/conversations/${a}/tags`, { tagIds: [999999] });
    assert.equal(inexistente.status, 404);
    assert.equal(inexistente.body.code, 'tag_not_found');
  });

  it('o relatório conta por etiqueta, e excluir a etiqueta apaga os vínculos', async () => {
    const r = await req('GET', '/api/whatsapp/tags/report?days=7');
    assert.equal(r.status, 200);
    const suporte = r.body.data.tags.find((t) => t.name === 'Suporte técnico');
    assert.equal(suporte.taggedInPeriod, 2);
    assert.equal(suporte.openNow, 2);

    await req('DELETE', `/api/whatsapp/tags/${suporte.id}`);
    const vinculos = await getDb()('wa_conversation_tags').where({ tag_id: suporte.id });
    assert.equal(vinculos.length, 0);
  });

  it('o bot etiqueta pelo assunto: segunda via em Financeiro, sinal em Suporte técnico', async () => {
    // As padrão (e a regra) nasceram no primeiro GET; Suporte técnico foi
    // excluída no teste anterior, e a regra dela voltou a "nenhuma".
    const config = await asTenant(() => WaBotConfigService.getConfig());
    const tags = (await req('GET', '/api/whatsapp/tags')).body.data;
    const financeiro = tags.find((t) => t.name === 'Financeiro');
    assert.equal(config.autoTags.invoice, financeiro.id);
    assert.equal(config.autoTags.signal, null, 'a etiqueta excluída sai da regra');

    const id = await conversa('5593981150010');
    await asTenant(() => WaBotService.registrar({ id }, 'fatura'));
    await asTenant(() => WaBotService.registrar({ id }, 'fatura'));
    await asTenant(() => WaBotService.registrar({ id }, 'sinal'));
    let vinculos = await getDb()('wa_conversation_tags').where({ conversation_id: id });
    assert.deepEqual(vinculos.map((v) => v.tag_id), [financeiro.id], 'uma vez só, e nada para o sinal sem regra');

    // Apontar a regra do sinal para uma etiqueta e ver o bot usá-la; a da
    // equipe continua.
    const instalacao = tags.find((t) => t.name === 'Instalação');
    await asTenant(() => WaBotConfigService.saveConfig({ autoTags: { signal: instalacao.id } }));
    await asTenant(() => WaBotService.registrar({ id }, 'outage'));
    vinculos = await getDb()('wa_conversation_tags').where({ conversation_id: id }).orderBy('id');
    assert.deepEqual(vinculos.map((v) => v.tag_id), [financeiro.id, instalacao.id]);

    // Desligada, não etiqueta.
    const outra = await conversa('5593981150011');
    await asTenant(() => WaBotConfigService.saveConfig({ autoTags: { enabled: false } }));
    await asTenant(() => WaBotService.registrar({ id: outra }, 'fatura'));
    assert.equal((await getDb()('wa_conversation_tags').where({ conversation_id: outra })).length, 0);
  });
});
