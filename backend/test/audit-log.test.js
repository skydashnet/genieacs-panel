import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: AuditLog } = await import('../src/models/AuditLog.js');
const { default: SchedulerService } = await import('../src/services/schedulerService.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { seedDefaults } = await import('../src/config/seed.js');
const { default: User } = await import('../src/models/User.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');
const { default: CustomerService } = await import('../src/services/customerService.js');
const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);

/**
 * A trilha das ações sensíveis.
 *
 * Duas afirmações, e a segunda é a que este arquivo persegue mais:
 *
 * 1. As ações sensíveis DEIXAM registro — senha de portal revelada ou
 *    redefinida, credencial da NBI trocada, papel mudado, vínculo encerrado,
 *    convite criado e aceito.
 * 2. **Nenhum segredo entra na trilha.** Registra-se que a senha foi revelada,
 *    não qual era. O contrário faria da auditoria o maior repositório de
 *    segredos em claro do produto — e um que ninguém pensa em proteger, porque
 *    "é só log". A varredura no fim do arquivo executa as ações de verdade e
 *    procura, nas linhas que elas produziram, os valores exatos dos segredos
 *    que passaram por perto.
 */
let panelUrl;
let token;
let tenantId;
let deviceId;
let senhaDoPortal;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
  });
  token = setup.body.data.token;
  tenantId = (await getDb()('tenants').orderBy('id', 'asc').first()).id;

  deviceId = 'ONT-DA-TRILHA';
  const conta = await runInTenant(tenantId, () => CustomerService.ensureAccount({
    _id: deviceId, softwareId: 'V1', pppoe: 'assinante-da-trilha'
  }));
  senhaDoPortal = await runInTenant(tenantId, () => CustomerPortalPasswordService.reveal(conta));
  assert.ok(senhaDoPortal, 'o fixture precisa de uma senha legível para o teste ter o que procurar');
});

after(async () => {
  await stopTestServers();
});

const comoOperador = () => authHeaders(token);

/** As linhas cruas da trilha, sem passar por modelo — é o conteúdo que importa. */
const trilha = (where = {}) => getDb()('audit_log').where(where).orderBy('id', 'asc');

describe('as ações que deixam registro', () => {
  it('revelar a senha do portal', async () => {
    const { status } = await call(`${panelUrl}/api/devices/${deviceId}/portal-password`, {
      headers: comoOperador()
    });
    assert.equal(status, 200);

    const linhas = await trilha({ action: 'portal_password.revealed' });
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].actor_username, 'a-dona');
    assert.equal(linhas[0].actor_kind, 'operator');
    assert.equal(Number(linhas[0].tenant_id), Number(tenantId));
    assert.equal(JSON.parse(linhas[0].detail).deviceId, deviceId);
  });

  it('redefinir a senha do portal', async () => {
    const { status } = await call(`${panelUrl}/api/devices/${deviceId}/portal-password/reset`, {
      method: 'POST', headers: comoOperador()
    });
    assert.equal(status, 200);
    assert.equal((await trilha({ action: 'portal_password.reset' })).length, 1);
  });

  it('trocar a credencial da NBI', async () => {
    const { status } = await call(`${panelUrl}/api/settings/genieacs-auth`, {
      method: 'PUT', headers: comoOperador(),
      body: { authType: 'bearer', secret: 'segredo-que-nao-pode-vazar' }
    });
    assert.equal(status, 200);
    const linhas = await trilha({ action: 'genieacs.auth_changed' });
    assert.equal(linhas.length, 1);
    // O que a trilha guarda é que passou a existir uma credencial, não qual.
    assert.equal(JSON.parse(linhas[0].detail).secretConfigured, true);
  });

  it('trocar a URL do GenieACS', async () => {
    await call(`${panelUrl}/api/settings`, {
      method: 'POST', headers: comoOperador(),
      body: { key: 'genieAcsUrl', value: 'http://acs.antigo.exemplo:7557' }
    });
    const { status } = await call(`${panelUrl}/api/settings/genieAcsUrl`, {
      method: 'PUT', headers: comoOperador(), body: { value: 'http://acs.novo.exemplo:7557' }
    });
    assert.equal(status, 200);
    const linhas = await trilha({ action: 'genieacs.url_changed' });
    assert.equal(linhas.length, 1);
    assert.equal(JSON.parse(linhas[0].detail).url, 'http://acs.novo.exemplo:7557');
  });

  it('mas não toda edição de configuração', async () => {
    // A trilha é das ações sensíveis. Virar log de toda edição a encheria de
    // linhas sobre o nome do painel e caminhos de parâmetro virtual, que é como
    // uma trilha deixa de ser lida.
    const antes = (await trilha()).length;
    await call(`${panelUrl}/api/settings`, {
      method: 'POST', headers: comoOperador(), body: { key: 'appName', value: 'Painel' }
    });
    await call(`${panelUrl}/api/settings/appName`, {
      method: 'PUT', headers: comoOperador(), body: { value: 'Outro Nome' }
    });
    assert.equal((await trilha()).length, antes);
  });

  it('criar operador, mudar papel e encerrar vínculo', async () => {
    const criado = await call(`${panelUrl}/api/users`, {
      method: 'POST', headers: comoOperador(),
      body: { username: 'o-tecnico', password: 'senha-do-tecnico-1', role: 'tech', email: 'o-tecnico@exemplo.test' }
    });
    assert.equal(criado.status, 201);
    const id = criado.body.data.user.id;
    assert.equal((await trilha({ action: 'operator.created' })).length, 1);

    const mudou = await call(`${panelUrl}/api/users/${id}`, {
      method: 'PATCH', headers: comoOperador(), body: { role: 'viewer' }
    });
    assert.equal(mudou.status, 200);
    const papel = await trilha({ action: 'operator.role_changed' });
    assert.equal(papel.length, 1);
    assert.deepEqual(
      { de: JSON.parse(papel[0].detail).from, para: JSON.parse(papel[0].detail).to },
      { de: 'tech', para: 'viewer' }
    );

    const removeu = await call(`${panelUrl}/api/users/${id}`, {
      method: 'DELETE', headers: comoOperador()
    });
    assert.equal(removeu.status, 200);
    assert.equal((await trilha({ action: 'operator.removed' })).length, 1);
  });

  it('criar e aceitar convite', async () => {
    const criado = await call(`${panelUrl}/api/invites`, {
      method: 'POST', headers: comoOperador(), body: { role: 'tech', label: 'plantao' }
    });
    assert.equal(criado.status, 201);
    assert.equal((await trilha({ action: 'invite.created' })).length, 1);

    const aceite = await call(
      `${panelUrl}/api/invites/token/accept`,
      { method: 'POST', body: { token: criado.body.data.token, username: 'quem-aceitou', password: 'senha-de-quem-aceitou-1', email: 'quem-aceitou@exemplo.test' } }
    );
    assert.equal(aceite.status, 201, JSON.stringify(aceite.body));

    const linhas = await trilha({ action: 'invite.accepted' });
    assert.equal(linhas.length, 1);
    // O ator é quem ACABOU de entrar, e não quem convidou: `req.user` está
    // vazio nesse request, então o ator é preenchido à mão. Se um dia alguém
    // trocar isso por `fromRequest`, é esta linha que fica vermelha.
    assert.equal(linhas[0].actor_username, 'quem-aceitou');
  });
});

describe('nada de segredo na trilha', () => {
  /**
   * A varredura, e a razão de ela ler a tabela INTEIRA em vez de conferir
   * campo a campo.
   *
   * Conferir campo a campo prova que o campo que eu lembrei está limpo. O que
   * se quer saber é outra coisa: se algum dos segredos que passaram perto das
   * ações acima acabou em alguma coluna de alguma linha. A pergunta certa é
   * sobre a tabela toda, e a resposta tem que ser não para todos.
   */
  it('nenhum valor de segredo aparece em nenhuma coluna de nenhuma linha', async () => {
    const tudo = JSON.stringify(await trilha());
    const segredos = [
      ['a senha do portal revelada', senhaDoPortal],
      ['a credencial da NBI', 'segredo-que-nao-pode-vazar'],
      ['a senha do operador criado', 'senha-do-tecnico-1'],
      ['a senha de quem aceitou o convite', 'senha-de-quem-aceitou-1'],
      ['a senha da dona', 'senha-da-dona-1']
    ];
    for (const [nome, valor] of segredos) {
      assert.equal(tudo.includes(valor), false, `${nome} vazou para a trilha`);
    }
  });

  it('nem o token do convite, que é uma credencial de uso imediato', async () => {
    const criado = await call(`${panelUrl}/api/invites`, {
      method: 'POST', headers: comoOperador(), body: { role: 'viewer' }
    });
    const tudo = JSON.stringify(await trilha());
    assert.equal(tudo.includes(criado.body.data.token), false,
      'quem tem o link entra na equipe; a trilha viraria uma lista de convites utilizáveis');
  });

  it('e a varredura não passa por não achar nada', async () => {
    // Sem isto, uma trilha vazia — ou uma leitura que parou de funcionar —
    // deixaria as duas asserções acima verdes para sempre.
    const linhas = await trilha();
    assert.ok(linhas.length >= 8, `só ${linhas.length} linhas na trilha`);
    assert.ok(JSON.stringify(linhas).includes(deviceId),
      'a trilha tem que conter o que ela DEVE conter, ou a busca acima não prova nada');
  });
});

describe('a trilha é de cada provedor', () => {
  it('a do vizinho não aparece aqui', async () => {
    const db = getDb();
    await db('tenants').insert({ slug: 'vizinho', name: 'Vizinho', status: 'active' });
    const vizinho = (await db('tenants').where({ slug: 'vizinho' }).first()).id;

    await runInTenant(vizinho, () => AuditLog.record({
      action: AuditLog.ACTIONS.PORTAL_PASSWORD_REVEALED,
      subjectType: 'customer_account',
      subjectId: 999,
      detail: { customerId: 'CSG-DO-VIZINHO' }
    }));

    const minhas = await runInTenant(tenantId, () => AuditLog.list({ limit: 200 }));
    assert.equal(minhas.some((l) => String(l.detail).includes('CSG-DO-VIZINHO')), false);

    // E o controle: a linha existe mesmo, no provedor dela.
    const dele = await runInTenant(vizinho, () => AuditLog.list({ limit: 200 }));
    assert.equal(dele.length, 1);
  });
});

describe('gravar nunca derruba a ação', () => {
  it('uma falha de escrita não vira erro para quem pediu', async () => {
    // A revelação de senha que a trilha ia registrar JÁ aconteceu quando a
    // escrita falha. Devolver 500 ali faria o operador tentar de novo e
    // produzir duas revelações e zero registros.
    const original = AuditLog.record;
    AuditLog.record = async () => { throw new Error('banco fora do ar'); };
    try {
      const { status } = await call(`${panelUrl}/api/devices/${deviceId}/portal-password`, {
        headers: comoOperador()
      });
      assert.equal(status, 200);
    } finally {
      AuditLog.record = original;
    }
  });

  it('e o próprio record engole o erro em vez de propagá-lo', async () => {
    // O caso acima passa mesmo se o controlador estivesse com try/catch em
    // volta. Este é sobre o modelo: `record` devolve false, não lança.
    const resultado = await runInTenant(tenantId, () => AuditLog.record({
      action: 'acao.inventada',
      // Uma coluna que não existe: o insert falha no banco, não na validação.
      subjectType: 'x'.repeat(500)
    }));
    assert.equal(typeof resultado, 'boolean');
  });
});

describe('a rota de leitura', () => {
  it('devolve as linhas mais recentes primeiro e pagina por cursor', async () => {
    const primeira = await call(`${panelUrl}/api/audit?limit=3`, { headers: comoOperador() });
    assert.equal(primeira.status, 200);
    assert.equal(primeira.body.data.entries.length, 3);
    const ids = primeira.body.data.entries.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'da mais recente para a mais antiga');

    const segunda = await call(
      `${panelUrl}/api/audit?limit=3&before=${primeira.body.data.nextBefore}`,
      { headers: comoOperador() }
    );
    assert.equal(segunda.status, 200);
    // Cursor e não offset: a tabela cresce enquanto alguém a lê, e um offset
    // entrega a mesma linha duas vezes ou pula uma.
    const repetidas = segunda.body.data.entries.filter((e) => ids.includes(e.id));
    assert.deepEqual(repetidas, []);
  });

  it('filtra por ação', async () => {
    const { body } = await call(`${panelUrl}/api/audit?action=portal_password.revealed`, {
      headers: comoOperador()
    });
    assert.ok(body.data.entries.length >= 1);
    assert.equal(body.data.entries.every((e) => e.action === 'portal_password.revealed'), true);
  });

  it('não existe rota para apagar uma linha', async () => {
    // Se desse, a primeira coisa que alguém faria depois de uma ação indevida
    // seria apagar o registro dela. O que existe é a poda por idade, que não
    // escolhe o quê.
    const linhas = await trilha();
    const alvo = linhas[0].id;
    for (const method of ['DELETE', 'PATCH', 'PUT']) {
      const { status } = await call(`${panelUrl}/api/audit/${alvo}`, {
        method, headers: comoOperador(), body: {}
      });
      assert.equal(status, 404, `${method} não pode existir`);
    }
    assert.equal((await trilha()).length, linhas.length);
  });

  it('recusa quem não tem audit.read', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const userId = await runInTenant(tenantId, () => User.create({
      username: 'tecnico-curioso', password: bcrypt.hashSync('senha-do-curioso-1', 10), role: 'tech'
    }));
    await runInTenant(tenantId, () => TenantUser.create({ tenantId, userId, role: 'tech' }));
    const { body } = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: 'tecnico-curioso', password: 'senha-do-curioso-1' }
    });
    const { status, body: recusa } = await call(`${panelUrl}/api/audit`, {
      headers: authHeaders(body.data.token)
    });
    assert.equal(status, 403);
    assert.equal(recusa.code, 'missing_permission');
  });
});

describe('a poda', () => {
  it('apaga por idade e em bloco, nunca uma linha escolhida', async () => {
    const antigo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await runInTenant(tenantId, () => AuditLog.record({ action: 'acao.velha' }));
    await getDb()('audit_log').where({ action: 'acao.velha' }).update({ created_at: antigo });

    const antes = (await trilha()).length;
    const apagadas = await runInTenant(tenantId,
      () => AuditLog.prune(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)));
    assert.equal(apagadas, 1);
    assert.equal((await trilha()).length, antes - 1);
    assert.equal((await trilha({ action: 'acao.velha' })).length, 0);
  });

  /**
   * E a trilha do provedor SUSPENSO também tem prazo.
   *
   * A poda morava dentro do laço de provedores ativos, e essa era a
   * consequência que ninguém tinha escrito: a trilha de um suspenso não ficava
   * com prazo maior, ficava sem prazo NENHUM. Ela guarda quem são os operadores
   * dele, quantos assinantes tem e quando alguém revelou a senha de um deles —
   * e como não existe prazo de suspensão nem exclusão automática, "sem prazo"
   * é literal.
   *
   * Agora a poda tem laço próprio, que visita todo provedor.
   */
  it('e alcança o provedor suspenso, cuja trilha não tinha prazo nenhum', async () => {
    const antigo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await runInTenant(tenantId, () => AuditLog.record({ action: 'acao.do.suspenso' }));
    await getDb()('audit_log').where({ action: 'acao.do.suspenso' }).update({ created_at: antigo });
    await getDb()('tenants').where({ id: tenantId }).update({ status: 'suspended' });

    try {
      SchedulerService.lastPruneAt = 0;
      await SchedulerService.retentionPass();
      assert.equal(
        (await trilha({ action: 'acao.do.suspenso' })).length, 0,
        'a trilha do suspenso continuou sem prazo'
      );
    } finally {
      await getDb()('tenants').where({ id: tenantId }).update({ status: 'active' });
    }
  });
});

/**
 * O prazo da trilha deixou de ser uma constante.
 *
 * Um ano era o padrão e continua sendo — o que era ruim é ser a única resposta.
 * Um ISP em disputa judicial precisa de mais; um que resolveu guardar menos
 * dado pessoal precisa de menos; e as duas mudanças exigiam editar o agendador
 * e subir deploy. Política de guarda é decisão de quem responde pelos dados.
 */
describe('o prazo da trilha, agora configurável', () => {
  const definir = (valor) => runInTenant(tenantId, () => Setting.upsert('auditRetentionDays', valor));
  const limpar = () => getDb()('settings').where({ key: 'auditRetentionDays' }).del();

  it('sem configuração, continua um ano', async () => {
    await limpar();
    assert.equal(await runInTenant(tenantId, () => SchedulerService.auditRetentionDays()), 365);
  });

  it('a chave nasce semeada, senão a tela não conseguiria salvá-la', async () => {
    // `PUT /api/settings/:key` ATUALIZA e responde 404 quando não há linha —
    // criar é `POST /`. Sem semente o campo existiria na tela e não salvaria, e
    // o provedor concluiria que a tela está quebrada.
    //
    // `seedDefaults` roda a cada boot e insere toda chave que falta, provedor a
    // provedor, então quem já existe recebe a linha sem migração nenhuma.
    await limpar();
    await seedDefaults(getDb());
    const linha = await runInTenant(tenantId, () => Setting.getByKey('auditRetentionDays'));
    assert.equal(linha, '365', 'a chave não foi semeada');

    // E a tela grava por essa rota, que agora encontra o que atualizar.
    const { status } = await call(`${panelUrl}/api/settings/auditRetentionDays`, {
      method: 'PUT', headers: authHeaders(token), body: { value: '180' }
    });
    assert.equal(status, 200);
    assert.equal(await runInTenant(tenantId, () => SchedulerService.auditRetentionDays()), 180);
    await limpar();
  });

  it('o prazo salvo é o que a poda usa', async () => {
    // O caso que prova a mudança inteira: uma linha de 100 dias sobrevive ao
    // padrão de 365 e morre com o prazo de 60.
    await limpar();
    const cemDias = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await runInTenant(tenantId, () => AuditLog.record({ action: 'acao.de.cem.dias' }));
    await getDb()('audit_log').where({ action: 'acao.de.cem.dias' }).update({ created_at: cemDias });

    SchedulerService.lastPruneAt = 0;
    await SchedulerService.retentionPass();
    assert.equal(
      (await trilha({ action: 'acao.de.cem.dias' })).length, 1,
      'o padrão de um ano devia ter mantido uma linha de cem dias'
    );

    await definir('60');
    try {
      SchedulerService.lastPruneAt = 0;
      await SchedulerService.retentionPass();
      assert.equal((await trilha({ action: 'acao.de.cem.dias' })).length, 0);
    } finally {
      await limpar();
    }
  });

  it('valor inválido cai no padrão em vez de parar a poda', async () => {
    // Uma poda parada é a tabela crescendo em silêncio, que é pior que o prazo
    // errado. Letra num campo não pode ser o motivo.
    // `-5` e `0` entram nesta lista e não na do limite: um número negativo
    // não é intenção de guardar menos, é lixo — e preso no mínimo ele
    // pareceria uma escolha de 30 dias que ninguém fez.
    // `'12abc'` está aqui e não entre os limites por um motivo que custou uma
    // correção: `parseInt` o lê como 12, que é inteiro positivo e viraria 30
    // pelo mínimo — um prazo que ninguém escolheu, nascido de um campo
    // digitado errado. E `'0'` porque no resto deste sistema zero quer dizer
    // "para sempre", que é o oposto de um prazo curto.
    for (const lixo of ['abc', '', '12abc', '-5', '0', ' ', '1e3']) {
      await definir(lixo);
      assert.equal(
        await runInTenant(tenantId, () => SchedulerService.auditRetentionDays()), 365,
        `o valor ${JSON.stringify(lixo)} não caiu no padrão`
      );
    }
    await limpar();
  });

  it('e fora dos limites é preso, nunca obedecido', async () => {
    // Abaixo de 30 dias a trilha deixa de responder à pergunta que a
    // justifica; acima de 10 anos ela vira o arquivo de dado pessoal que o
    // prazo existe para evitar.
    await definir('1');
    assert.equal(await runInTenant(tenantId, () => SchedulerService.auditRetentionDays()), 30);
    await definir('99999');
    assert.equal(await runInTenant(tenantId, () => SchedulerService.auditRetentionDays()), 3650);
    await limpar();
  });

  it('a rota recusa o que os limites recusam, e aceita o que eles aceitam', async () => {
    // A linha precisa existir: `PUT /:key` atualiza e 404 quando não há o que
    // atualizar — criar é `POST /`. A validação roda ANTES da leitura, então
    // as recusas abaixo valem com ou sem linha; a aceitação é que precisa de
    // uma.
    await definir('365');
    const salvar = (value) => call(`${panelUrl}/api/settings/auditRetentionDays`, {
      method: 'PUT', headers: authHeaders(token), body: { value }
    });
    assert.equal((await salvar('10')).status, 400);
    assert.equal((await salvar('4000')).status, 400);
    assert.equal((await salvar('abc')).status, 400);
    // `30.5` é inteiro para `parseInt` e não é o que foi digitado — a
    // comparação com o texto original é o que o recusa.
    assert.equal((await salvar('30.5')).status, 400);
    assert.equal((await salvar('180')).status, 200);
    await limpar();
  });
});
