import { after, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * A cadência do painel, que é o muro de escala da Fase 4.
 *
 * `getDashboardDevices()` busca a coleção INTEIRA de dispositivos do GenieACS.
 * Com 20 mil ONTs isso é um parse de vários MB; a cada minuto, vezes dezenas de
 * provedores, um processo Node não sustenta. O teto de concorrência que entrou
 * antes impede que isso derrube o painel, mas teto é fila — o trabalho continua
 * existindo, só espera.
 *
 * Estes testes são sobre o trabalho NÃO existir. A pergunta que cada um faz não
 * é "atualizou?" e sim "quantas vezes o ACS foi consultado?", porque é a única
 * medida em que a diferença aparece.
 */

const {
  call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: AppState } = await import('../src/models/AppState.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');
const { default: SchedulerService } = await import('../src/services/schedulerService.js');
const {
  ACTIVE_TTL_MS, ACTIVE_WINDOW_MS, IDLE_CUTOFF_MS, IDLE_TTL_MS,
  dueForRefresh, forgetActivityThrottle, isDormant, lastPanelActivityAt,
  recordPanelActivity, refreshTtlMs, tenantOffsetMs
} = await import('../src/services/dashboardSchedule.js');

const ACTIVITY_KEY = 'panel_last_activity_at';

let panelUrl;
let tenantId;
let servidor;
let buscas = 0;

before(async () => {
  ({ panelUrl } = await startTestServers());
  await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operador', password: 'senha-do-operador-1', email: 'operador@exemplo.test' }
  });
  tenantId = (await getDb()('tenants').orderBy('id', 'asc').first()).id;

  servidor = http.createServer((req, res) => {
    buscas += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  await runInTenant(tenantId, () => Setting.upsert(
    'genieAcsUrl', `http://127.0.0.1:${servidor.address().port}`
  ));
});

after(async () => {
  await new Promise((resolve) => servidor.close(resolve));
  await stopTestServers();
});

/** Escreve a marca de atividade direto, sem a folga de escrita. */
const atividadeEm = (quando) => runInTenant(
  tenantId, () => AppState.upsert(ACTIVITY_KEY, new Date(quando).toISOString())
);

const semAtividade = () => getDb()('app_state')
  .where({ tenant_id: tenantId, key: ACTIVITY_KEY }).delete();

const zerarAgenda = () => runInTenant(
  tenantId, () => AppState.upsert('scheduler_state', JSON.stringify({}))
);

beforeEach(async () => {
  buscas = 0;
  forgetActivityThrottle();
  DeviceService.forgetDashboards();
  await zerarAgenda();
});

describe('quem não está sendo usado não é atualizado', () => {
  it('um provedor sem ninguém há 24h não consulta o ACS', async () => {
    await atividadeEm(Date.now() - IDLE_CUTOFF_MS - 60_000);
    const resultado = await runInTenant(tenantId, () => SchedulerService.runJobs({}));
    assert.equal(resultado.dashboard, null);
    assert.equal(buscas, 0, 'o ACS do provedor não podia ter sido consultado');
  });

  it('e um que nunca teve ninguém, tampouco', async () => {
    // O caso do provedor recém-criado: sem marca nenhuma. Cair no lado "ativo"
    // aqui seria manter quente o painel de todo cadastro de teste que alguém
    // abriu uma vez.
    await semAtividade();
    const resultado = await runInTenant(tenantId, () => SchedulerService.runJobs({}));
    assert.equal(resultado.dashboard, null);
    assert.equal(buscas, 0);
  });

  it('mas um com operador recente consulta', async () => {
    // O par que dá sentido aos dois acima: sem ele, um job que nunca rodasse
    // passaria em ambos.
    await atividadeEm(Date.now());
    const resultado = await runInTenant(tenantId, () => SchedulerService.runJobs({}));
    assert.equal(resultado.dashboard?.refreshed, true);
    assert.equal(buscas, 1);
  });
});

describe('a cadência segue a atenção', () => {
  it('com operador da última hora, 60s', async () => {
    await atividadeEm(Date.now() - 60_000);
    const resultado = await runInTenant(tenantId, () => SchedulerService.runJobs({}));
    assert.equal(resultado.dashboard?.ttlMs, ACTIVE_TTL_MS);
  });

  it('sem ninguém há mais de uma hora, 5 minutos', async () => {
    await atividadeEm(Date.now() - ACTIVE_WINDOW_MS - 60_000);
    const resultado = await runInTenant(tenantId, () => SchedulerService.runJobs({}));
    assert.equal(resultado.dashboard?.ttlMs, IDLE_TTL_MS);
  });

  it('e o prazo do cache acompanha, senão a requisição desfaz a decisão', async () => {
    // Sem isto o cache venceria em 60s de qualquer jeito, e a primeira tela
    // aberta depois disso dispararia — do caminho da requisição — exatamente a
    // busca que o job tinha acabado de decidir que podia esperar.
    await atividadeEm(Date.now() - ACTIVE_WINDOW_MS - 60_000);
    await runInTenant(tenantId, () => SchedulerService.runJobs({}));
    const prazo = await runInTenant(tenantId, () => DeviceService.dashboardCacheFor().expiresAt);
    assert.ok(
      prazo - Date.now() > ACTIVE_TTL_MS,
      `o cache venceria em ${prazo - Date.now()}ms, dentro da cadência rápida`
    );
  });
});

/**
 * Os dois testes abaixo afirmam "duas rodadas dentro da MESMA janela", e por
 * isso param o relógio antes de rodar.
 *
 * `dueForRefresh` corta o tempo em janelas absolutas, cada provedor com a sua
 * borda. Duas rodadas coladas caem na mesma janela quase sempre — mas "quase"
 * aqui é ≈ (intervalo entre as duas chamadas)/60s de chance de a borda passar
 * entre elas, e nesse caso a segunda rodada é LEGITIMAMENTE devida: o teste
 * reprovava o código certo, e só de vez em quando. Foi assim que o
 * `Backend on postgres` caiu num PR que não tocava em uma linha de aplicação.
 *
 * `apis: ['Date']` congela só `Date.now`: `setTimeout` continua real, que é o
 * que estes testes precisam para fazer HTTP de verdade contra o servidor local
 * e contra a porta fechada.
 *
 * E `now` é obrigatório aqui, apesar de opcional na API: sem ele o relógio
 * congela em ZERO, e a rodada grava `lastDashboardAt` em 1970 — que o SQLite e
 * o Postgres aceitam e o MySQL recusa, porque um `TIMESTAMP` dele começa em
 * 1970-01-01 00:00:01 UTC. Parar o relógio é o ponto; pará-lo antes do início
 * do tempo é outro bug.
 */
describe('a rodada seguinte espera a janela', () => {
  it('duas rodadas seguidas consultam o ACS uma vez só', async () => {
    await atividadeEm(Date.now());
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      await runInTenant(tenantId, () => SchedulerService.runJobs({}));
      await runInTenant(tenantId, () => SchedulerService.runJobs({}));
      assert.equal(buscas, 1, 'a segunda rodada caiu na mesma janela e não devia repetir');
    } finally {
      mock.timers.reset();
    }
  });

  it('e um ACS fora do ar não vira uma tentativa por rodada', async () => {
    // A tentativa precisa ser marcada mesmo quando falha. Sem isso, o provedor
    // com ACS inalcançável é justamente o que mais consulta.
    await atividadeEm(Date.now());
    await runInTenant(tenantId, () => Setting.upsert('genieAcsUrl', 'http://127.0.0.1:1'));
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      const primeira = await runInTenant(tenantId, () => SchedulerService.runJobs({}));
      assert.equal(primeira.dashboard?.refreshed, false);
      const segunda = await runInTenant(tenantId, () => SchedulerService.runJobs({}));
      assert.equal(segunda.dashboard, null, 'a segunda rodada não devia nem tentar');
    } finally {
      // Antes da restauração da URL: um relógio congelado que vazasse para o
      // teste seguinte custaria muito mais caro do que a falha daqui.
      mock.timers.reset();
      await runInTenant(tenantId, () => Setting.upsert(
        'genieAcsUrl', `http://127.0.0.1:${servidor.address().port}`
      ));
    }
  });
});

describe('nem todos ao mesmo tempo', () => {
  it('provedores diferentes têm bordas diferentes dentro da janela', () => {
    const janela = IDLE_TTL_MS;
    const defasagens = new Set(
      Array.from({ length: 12 }, (_, i) => tenantOffsetMs(i + 1, janela))
    );
    assert.ok(
      defasagens.size >= 11,
      `12 provedores consecutivos caíram em ${defasagens.size} bordas distintas`
    );
    for (const d of defasagens) assert.ok(d >= 0 && d < janela);
  });

  it('e a borda é estável: o mesmo id dá sempre a mesma', () => {
    // É o que dispensa guardar a defasagem, e o que faz um reinício não
    // reagrupar todo mundo na mesma virada de minuto.
    assert.equal(tenantOffsetMs(7, IDLE_TTL_MS), tenantOffsetMs(7, IDLE_TTL_MS));
    assert.equal(tenantOffsetMs('7', IDLE_TTL_MS), tenantOffsetMs(7, IDLE_TTL_MS));
  });

  it('a janela é de fase, não de prazo: um atraso não desloca a borda seguinte', () => {
    const ttlMs = 60_000;
    const offsetMs = 0;
    // Rodou 10s atrasada dentro da janela anterior. Com a conta de prazo
    // ("passaram 60s?"), a próxima só viria 10s depois da borda — e o atraso se
    // acumularia até todos convergirem para a mesma virada.
    const bordaAnterior = 3 * ttlMs;
    const lastRunAt = bordaAnterior + 10_000;
    assert.equal(
      dueForRefresh({ lastRunAt, ttlMs, offsetMs, now: 4 * ttlMs + 1 }),
      true,
      'a borda seguinte tem de valer, mesmo com a rodada anterior atrasada'
    );
    assert.equal(
      dueForRefresh({ lastRunAt, ttlMs, offsetMs, now: bordaAnterior + 59_000 }),
      false,
      'e dentro da mesma janela não vale'
    );
  });
});

describe('a marca de atividade', () => {
  it('o login registra que este provedor tem gente', async () => {
    await semAtividade();
    forgetActivityThrottle();
    const { status } = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'operador', password: 'senha-do-operador-1' }
    });
    assert.equal(status, 200);
    const marca = await runInTenant(tenantId, () => lastPanelActivityAt());
    assert.ok(marca !== null, 'o login tinha de ter deixado a marca');
    assert.ok(Math.abs(Date.now() - marca) < 60_000);
  });

  it('e uma segunda entrada em seguida não escreve de novo', async () => {
    // A folga existe porque a renovação de token é de hora em hora POR
    // operador: sem ela, um provedor com trinta pessoas escreve trinta vezes.
    await semAtividade();
    forgetActivityThrottle();
    const entrar = () => call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'operador', password: 'senha-do-operador-1' }
    });
    await entrar();
    const primeira = await runInTenant(tenantId, () => lastPanelActivityAt());
    // Sem esta linha o teste passaria vazio num painel que nunca grava marca
    // nenhuma: duas leituras nulas são iguais entre si.
    assert.ok(primeira !== null, 'a primeira entrada tinha de ter gravado');
    await entrar();
    const segunda = await runInTenant(tenantId, () => lastPanelActivityAt());
    assert.equal(segunda, primeira, 'a segunda entrada não devia ter reescrito a marca');
  });

  it('não deixa um banco fora do ar derrubar o login', async () => {
    // Registrar atenção é conveniência. Ser o motivo de ninguém entrar, não.
    const original = AppState.upsert;
    AppState.upsert = async () => { throw new Error('banco fora do ar'); };
    try {
      forgetActivityThrottle();
      const gravou = await runInTenant(tenantId, () => recordPanelActivity());
      assert.equal(gravou, false);
    } finally {
      AppState.upsert = original;
    }
  });

  it('é de cada provedor: a de um não conta como a do vizinho', async () => {
    const beta = await insertReturningId('tenants', {
      slug: 'vizinho-do-painel', name: 'Vizinho', status: 'active'
    });
    await atividadeEm(Date.now());
    const marcaDoBeta = await runInTenant(beta, () => lastPanelActivityAt());
    assert.equal(marcaDoBeta, null, 'a atividade do alfa não pode aparecer no beta');
    assert.equal(isDormant(marcaDoBeta), true);
  });
});

describe('as regras puras', () => {
  it('sem marca é dormente, e a cadência é a ociosa', () => {
    assert.equal(isDormant(null), true);
    assert.equal(refreshTtlMs(null), IDLE_TTL_MS);
  });

  it('a fronteira das 24h é exatamente onde está escrito', () => {
    const agora = Date.now();
    assert.equal(isDormant(agora - IDLE_CUTOFF_MS, agora), false);
    assert.equal(isDormant(agora - IDLE_CUTOFF_MS - 1, agora), true);
  });

  it('e a da hora também', () => {
    const agora = Date.now();
    assert.equal(refreshTtlMs(agora - ACTIVE_WINDOW_MS, agora), ACTIVE_TTL_MS);
    assert.equal(refreshTtlMs(agora - ACTIVE_WINDOW_MS - 1, agora), IDLE_TTL_MS);
  });
});
