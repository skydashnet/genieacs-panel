import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: Setting } = await import('../src/models/Setting.js');

const FLEET_SIZE = 30;
const ONLINE_COUNT = 12;
const ONLINE_WINDOW_MS = 10 * 60 * 1000;

/**
 * A telemetria de cada índice, e é ela que os recortes do painel leem.
 *
 * Os valores estão nos limiares de propósito: -24.99 é o último RX que ainda é
 * `Good` e -25 é o primeiro `Poor`, 70 é o primeiro `Hot` e 16 é o primeiro
 * `16+`. Um teste construído com -30 e 85 passaria com qualquer limiar parecido
 * e não provaria nenhum.
 *
 * Um dos quentes está online e o outro offline, para que o recorte possa ser
 * cruzado com o status sem que a resposta seja a mesma lista.
 */
const TELEMETRY = {
  // RX: dois abaixo do limiar (um online, um offline) e um exatamente NO
  // limiar, que tem que ficar de fora.
  4: { rx: -25 },
  20: { rx: -40.2 },
  6: { rx: -24.99 },
  // Temperatura: um exatamente em 70 e um acima; um vazio, que é ausência de
  // leitura e não zero grau.
  7: { temp: 70 },
  21: { temp: 88.5 },
  8: { temp: '' },
  9: { temp: 69.9 },
  // Clientes: um em 16, um acima, e um em 15 que fica de fora.
  10: { clients: 16 },
  22: { clients: 41 },
  11: { clients: 15 }
};

const WEAK_SIGNAL_IDS = ['ONT-004', 'ONT-020'];
const HOT_IDS = ['ONT-007', 'ONT-021'];
const MANY_CLIENT_IDS = ['ONT-010', 'ONT-022'];
/** Índices cadastrados dentro da janela de 24h. O 3 tem data no FUTURO. */
const NEW_IDS = ['ONT-000', 'ONT-001', 'ONT-002'];

function virtualParameters(index) {
  const leitura = TELEMETRY[index] || {};
  const vp = {};
  if ('rx' in leitura) vp.OpticalRXPower = { _value: leitura.rx };
  if ('temp' in leitura) vp.OpticalTemperature = { _value: leitura.temp };
  if ('clients' in leitura) vp.TotalStations = { _value: leitura.clients };
  return vp;
}

/**
 * GenieACS documents as the NBI returns them. The first ONLINE_COUNT devices
 * informed a minute ago, the rest a day ago, so the 10-minute online window
 * splits the fleet deterministically.
 *
 * O cadastro: três dentro das últimas 24h, um com data no FUTURO — que é o que
 * um ACS com o relógio adiantado grava — e o resto há um mês.
 */
function buildFleet() {
  const now = Date.now();
  const cadastro = (index) => {
    if (index < 3) return now - (index + 1) * 60 * 60 * 1000;
    if (index === 3) return now + 2 * 60 * 60 * 1000;
    return now - 30 * 24 * 60 * 60 * 1000;
  };
  return Array.from({ length: FLEET_SIZE }, (_, index) => ({
    _id: `ONT-${String(index).padStart(3, '0')}`,
    _deviceId: {
      _SerialNumber: `SN${String(index).padStart(4, '0')}`,
      _ProductClass: index % 2 === 0 ? 'HG8245Q2' : 'F670L',
      _Manufacturer: index % 2 === 0 ? 'Huawei' : 'ZTE'
    },
    VirtualParameters: virtualParameters(index),
    _lastInform: new Date(
      now - (index < ONLINE_COUNT ? 60_000 : 24 * 60 * 60 * 1000)
    ).toISOString(),
    _registered: new Date(cadastro(index)).toISOString()
  }));
}

const fleet = buildFleet();

/** Avaliador mínimo das faixas de data que o painel empurra para o NBI. */
function matchesRange(value, condition) {
  if (!condition) return true;
  const ponto = new Date(value).getTime();
  if (condition.$gte !== undefined && !(ponto >= new Date(condition.$gte).getTime())) {
    return false;
  }
  if (condition.$lte !== undefined && !(ponto <= new Date(condition.$lte).getTime())) {
    return false;
  }
  if (condition.$lt !== undefined && !(ponto < new Date(condition.$lt).getTime())) {
    return false;
  }
  return true;
}

function matchesQuery(device, query) {
  if (!query) return true;
  return matchesRange(device._lastInform, query._lastInform)
    && matchesRange(device._registered, query._registered);
}

const genieAcs = {
  server: null,
  requests: [],
  sendTotalHeader: true
};

function startGenieAcsStub() {
  return new Promise((resolve) => {
    genieAcs.server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!url.pathname.startsWith('/devices')) {
        res.writeHead(404).end('[]');
        return;
      }
      genieAcs.requests.push({
        query: url.searchParams.get('query'),
        skip: url.searchParams.get('skip'),
        limit: url.searchParams.get('limit'),
        projection: url.searchParams.get('projection')
      });

      const rawQuery = url.searchParams.get('query');
      const query = rawQuery ? JSON.parse(rawQuery) : null;
      const matched = fleet.filter((device) => matchesQuery(device, query));

      const skip = Number.parseInt(url.searchParams.get('skip') ?? '', 10);
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
      let page = matched;
      if (Number.isFinite(skip)) page = page.slice(skip);
      if (Number.isFinite(limit)) page = page.slice(0, limit);

      const headers = { 'Content-Type': 'application/json' };
      if (genieAcs.sendTotalHeader) headers.total = String(matched.length);
      res.writeHead(200, headers).end(JSON.stringify(page));
    });
    genieAcs.server.listen(0, '127.0.0.1', () => resolve());
  });
}

let panelUrl;
let token;

before(async () => {
  ({ panelUrl } = await startTestServers());
  await startGenieAcsStub();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  await asTenant(() => Setting.upsert(
    'genieAcsUrl',
    `http://127.0.0.1:${genieAcs.server.address().port}`
  ));
});

after(async () => {
  await new Promise((resolve) => genieAcs.server.close(resolve));
  await stopTestServers();
});

async function listDevices(search = '') {
  return call(`${panelUrl}/api/devices${search}`, { headers: authHeaders(token) });
}

describe('GET /api/devices pagination', () => {
  it('requires authentication', async () => {
    const { status } = await call(`${panelUrl}/api/devices`);
    assert.equal(status, 401);
  });

  it('returns the first page with default paging metadata', async () => {
    const { status, body } = await listDevices();
    assert.equal(status, 200);
    assert.equal(body.data.page, 1);
    assert.equal(body.data.pageSize, 25);
    assert.equal(body.data.total, FLEET_SIZE);
    assert.equal(body.data.totalPages, 2);
    assert.equal(body.data.devices.length, 25);
    // The per-device shape stayed the same as the unpaged listing.
    assert.equal(body.data.devices[0].SerialNumber, 'SN0029');
    assert.ok('customerId' in body.data.devices[0]);
    assert.ok('rxpower' in body.data.devices[0]);
  });

  it('clamps pageSize to the hard cap and rejects junk values', async () => {
    const capped = await listDevices('?pageSize=500');
    assert.equal(capped.body.data.pageSize, 100);
    assert.equal(capped.body.data.devices.length, FLEET_SIZE);

    const junk = await listDevices('?pageSize=abc&page=-4');
    assert.equal(junk.body.data.pageSize, 25);
    assert.equal(junk.body.data.page, 1);

    const zero = await listDevices('?pageSize=0');
    assert.equal(zero.body.data.pageSize, 25);
  });

  it('reports totals that match the rows returned', async () => {
    const { body } = await listDevices('?pageSize=10&page=3');
    assert.equal(body.data.total, FLEET_SIZE);
    assert.equal(body.data.totalPages, 3);
    assert.equal(body.data.page, 3);
    assert.equal(body.data.devices.length, 10);
  });

  it('serves different rows on page 2 than on page 1', async () => {
    const first = await listDevices('?pageSize=10&page=1');
    const second = await listDevices('?pageSize=10&page=2');

    const firstIds = first.body.data.devices.map((device) => device._id);
    const secondIds = second.body.data.devices.map((device) => device._id);

    assert.equal(firstIds.length, 10);
    assert.equal(secondIds.length, 10);
    assert.equal(firstIds.filter((id) => secondIds.includes(id)).length, 0);
    assert.equal(new Set([...firstIds, ...secondIds]).size, 20);
  });

  it('clamps a page beyond the end back onto the last page', async () => {
    const { body } = await listDevices('?pageSize=10&page=99');
    assert.equal(body.data.page, 3);
    assert.equal(body.data.devices.length, 10);
  });

  it('pushes the status filter to GenieACS and pages the result', async () => {
    const online = await listDevices('?status=online&pageSize=5');
    assert.equal(online.body.data.total, ONLINE_COUNT);
    assert.equal(online.body.data.totalPages, 3);
    assert.equal(online.body.data.devices.length, 5);

    const now = Date.now();
    for (const device of online.body.data.devices) {
      assert.ok(now - new Date(device._lastInform).getTime() < ONLINE_WINDOW_MS);
    }

    const offline = await listDevices('?status=offline&pageSize=100');
    assert.equal(offline.body.data.total, FLEET_SIZE - ONLINE_COUNT);
    assert.equal(offline.body.data.devices.length, FLEET_SIZE - ONLINE_COUNT);
    for (const device of offline.body.data.devices) {
      assert.ok(now - new Date(device._lastInform).getTime() >= ONLINE_WINDOW_MS);
    }

    const forwarded = genieAcs.requests.at(-1);
    assert.ok(forwarded.query, 'the status filter must reach GenieACS');
    assert.ok(JSON.parse(forwarded.query)._lastInform.$lt);
  });

  it('falls back to an unfiltered status for an unknown value', async () => {
    const { body } = await listDevices('?status=banana');
    assert.equal(body.data.total, FLEET_SIZE);
  });

  it('searches server-side across serial, model and vendor', async () => {
    const bySerial = await listDevices('?search=SN0007');
    assert.equal(bySerial.body.data.total, 1);
    assert.equal(bySerial.body.data.devices[0]._id, 'ONT-007');

    const byVendor = await listDevices('?search=zte&pageSize=10');
    assert.equal(byVendor.body.data.total, FLEET_SIZE / 2);
    assert.equal(byVendor.body.data.devices.length, 10);
    assert.equal(byVendor.body.data.totalPages, 2);

    const empty = await listDevices('?search=no-such-device');
    assert.equal(empty.body.data.total, 0);
    assert.equal(empty.body.data.totalPages, 0);
    assert.deepEqual(empty.body.data.devices, []);
  });

  it('finds a device by its SGP subscriber name, ignoring case and accents, and by its contract', async () => {
    await asTenant(() => getDb()('sgp_links').insert({
      tenant_id: getDb().raw('(select id from tenants order by id limit 1)'),
      device_id: 'ONT-011',
      contract: '451',
      client_name: 'ANTÔNIA OLIVEIRA DOS SANTOS',
      state: 'active',
      link_mode: 'manual'
    }));
    try {
      const porNome = await listDevices('?search=antonia%20oliveira');
      assert.equal(porNome.body.data.total, 1);
      assert.equal(porNome.body.data.devices[0]._id, 'ONT-011');

      const comAcento = await listDevices(`?search=${encodeURIComponent('Antônia')}`);
      assert.equal(comAcento.body.data.total, 1);

      const porContrato = await listDevices('?search=451');
      assert.ok(porContrato.body.data.devices.some((device) => device._id === 'ONT-011'));

      const ninguem = await listDevices('?search=fulano%20de%20tal');
      assert.equal(ninguem.body.data.total, 0);
    } finally {
      await asTenant(() => getDb()('sgp_links').where({ device_id: 'ONT-011' }).del());
    }
  });

  it('combines a search with the pushed-down status filter', async () => {
    const { body } = await listDevices('?search=zte&status=online');
    // Odd indices are ZTE, and indices below 12 are online: 1, 3, 5, 7, 9, 11.
    assert.equal(body.data.total, 6);
    assert.equal(body.data.devices.length, 6);
  });

  it('pushes the 24h registration window to GenieACS, with both ends', async () => {
    const { body } = await listDevices('?focus=new24h');
    assert.deepEqual(body.data.devices.map((device) => device._id).sort(), [...NEW_IDS].sort());
    assert.equal(body.data.total, NEW_IDS.length);

    // A data no FUTURO é o caso que o teto existe para recusar: o painel conta
    // `agora - cadastro >= 0`, então sem o `$lte` a lista traria uma linha a
    // mais do que o número que mandou o operador para cá.
    assert.ok(!body.data.devices.some((device) => device._id === 'ONT-003'));

    const forwarded = genieAcs.requests.at(-1);
    const query = JSON.parse(forwarded.query);
    assert.ok(query._registered.$gte, 'a janela de cadastro tem que descer ao NBI');
    assert.ok(query._registered.$lte, 'e o teto junto com ela');
    // O recorte que o GenieACS resolve continua paginando no GenieACS: se
    // tivesse caído na passagem local, não haveria limite nesta requisição.
    assert.ok(forwarded.limit, 'new24h não precisa varrer a frota');
  });

  it('narrows to the optical risk band, and only to it', async () => {
    const { body } = await listDevices('?focus=weak-signal');
    assert.deepEqual(body.data.devices.map((device) => device._id).sort(), [...WEAK_SIGNAL_IDS].sort());
    assert.equal(body.data.total, WEAK_SIGNAL_IDS.length);
    // -24.99 é o último RX que ainda é `Good`. Um limiar deslocado em um
    // centésimo o traria para cá, e a tela diria que ele está em risco.
    assert.ok(!body.data.devices.some((device) => device._id === 'ONT-006'));
  });

  it('narrows to hot devices, and an empty reading is not a cold one', async () => {
    const { body } = await listDevices('?focus=hot');
    assert.deepEqual(body.data.devices.map((device) => device._id).sort(), [...HOT_IDS].sort());
    // Temperatura vazia é ausência de leitura, não zero grau — e 69,9 não é
    // quente. Os dois ficam de fora por motivos diferentes.
    assert.ok(!body.data.devices.some((device) => ['ONT-008', 'ONT-009'].includes(device._id)));
  });

  it('narrows to the busiest LANs', async () => {
    const { body } = await listDevices('?focus=many-clients');
    assert.deepEqual(body.data.devices.map((device) => device._id).sort(), [...MANY_CLIENT_IDS].sort());
    assert.ok(!body.data.devices.some((device) => device._id === 'ONT-011'), '15 não é 16+');
  });

  it('falls back to no slice for an unknown focus', async () => {
    const { body } = await listDevices('?focus=banana');
    assert.equal(body.data.total, FLEET_SIZE);
  });

  it('combines the slice with the status filter and with a search', async () => {
    const online = await listDevices('?focus=hot&status=online');
    assert.deepEqual(online.body.data.devices.map((device) => device._id), ['ONT-007']);

    const offline = await listDevices('?focus=hot&status=offline');
    assert.deepEqual(offline.body.data.devices.map((device) => device._id), ['ONT-021']);

    // ONT-004 é Huawei (índice par) e ONT-020 também: a busca por ZTE não
    // devolve nenhum dos dois com sinal fraco.
    const zte = await listDevices('?focus=weak-signal&search=zte');
    assert.equal(zte.body.data.total, 0);

    const huawei = await listDevices('?focus=weak-signal&search=huawei');
    assert.deepEqual(huawei.body.data.devices.map((device) => device._id).sort(), [...WEAK_SIGNAL_IDS].sort());
  });

  it('pages a slice like any other listing', async () => {
    const primeira = await listDevices('?focus=weak-signal&pageSize=1&page=1');
    const segunda = await listDevices('?focus=weak-signal&pageSize=1&page=2');
    assert.equal(primeira.body.data.total, 2);
    assert.equal(primeira.body.data.totalPages, 2);
    assert.equal(primeira.body.data.devices.length, 1);
    assert.notEqual(primeira.body.data.devices[0]._id, segunda.body.data.devices[0]._id);
  });

  /**
   * A prova de que o link não mente.
   *
   * Cada número do painel é um link para um recorte, e o que torna esse link
   * honesto não é o filtro existir: é a lista devolver a MESMA quantidade que o
   * número mostrou. Este caso lê os dois da mesma frota e exige igualdade —
   * é ele que cai no dia em que alguém mexer num limiar de um lado só.
   */
  it('agrees with the dashboard, number by number', async () => {
    const painel = await call(`${panelUrl}/api/devices/dashboard?refresh=1`, {
      headers: authHeaders(token)
    });
    assert.equal(painel.status, 200);
    const { stats, rxDistribution, temperatureDistribution, clientDistribution } = painel.body.data;

    const totalDe = async (focus) => (await listDevices(`?focus=${focus}`)).body.data.total;

    assert.equal(await totalDe('new24h'), stats.new24h);
    assert.equal(
      await totalDe('weak-signal'),
      (rxDistribution.Poor || 0) + (rxDistribution.Danger || 0)
    );
    assert.equal(await totalDe('hot'), temperatureDistribution.Hot || 0);
    assert.equal(await totalDe('many-clients'), clientDistribution['16+'] || 0);

    // E os números não são todos zero, senão a igualdade acima não prova nada.
    assert.equal(stats.new24h, NEW_IDS.length);
    assert.equal(temperatureDistribution.Hot, HOT_IDS.length);

    // `Warm` é só o ONT-009, de 69,9 graus — o vizinho de baixo do limiar.
    assert.equal(temperatureDistribution.Warm, 1);
    // E NENHUM aparelho está em `Normal`: o único candidato seria o ONT-008,
    // que responde string vazia. Leitura vazia é ausência de leitura, e
    // `Number('')` é zero — sem o teste de valor reportado ele cairia aqui, e
    // o painel afirmaria temperatura normal sobre quem não respondeu nada.
    assert.equal(temperatureDistribution.Normal, 0);
  });

  it('counts without the total header when GenieACS omits it', async () => {
    genieAcs.sendTotalHeader = false;
    try {
      const { body } = await listDevices('?pageSize=10&page=2');
      assert.equal(body.data.total, FLEET_SIZE);
      assert.equal(body.data.totalPages, 3);
      assert.equal(body.data.devices.length, 10);
    } finally {
      genieAcs.sendTotalHeader = true;
    }
  });
});
