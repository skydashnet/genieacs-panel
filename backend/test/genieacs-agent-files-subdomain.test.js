import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * O instalador do agente num deploy com subdomínio por provedor.
 *
 * A origem que ele leva como padrão de PANEL_URL é para onde o instalador, como
 * root, vai mandar a chave do agente. Aqui se prova que ela sai do que o
 * resolvedor conferiu — a linha do provedor no banco, ou o ápice configurado —
 * e que um `Host` que não nomeia provedor nenhum não chega a ser respondido,
 * quanto mais virar padrão.
 *
 * Em arquivo próprio porque o domínio-base é lido no import do resolvedor, e
 * `node --test` dá um processo a cada arquivo.
 */
process.env.TENANT_BASE_DOMAIN = 'painel.exemplo.com';
process.env.PORTAL_BASE_DOMAIN = 'portal.exemplo.com';
process.env.PUBLIC_BASE_URL = '';

const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');

let panelUrl;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();
  const primeiro = await db('tenants').orderBy('id', 'asc').first();
  await db('tenants').where({ id: primeiro.id }).update({ slug: 'alfa', name: 'Provedor Alfa' });
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  await db('tenants').insert({ slug: 'parada', name: 'Provedor Parado', status: 'suspended' });
});

after(async () => {
  await stopTestServers();
});

/** `fetch` troca o `Host` em silêncio; o cliente cru é o único que o escolhe. */
function getComHost(host, caminho) {
  const alvo = new URL(`${panelUrl}${caminho}`);
  return new Promise((resolve, reject) => {
    http.get({
      host: alvo.hostname, port: alvo.port, path: alvo.pathname, headers: { Host: host }
    }, (res) => {
      let texto = '';
      res.on('data', (c) => { texto += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(texto); } catch { /* é o script */ }
        resolve({ status: res.statusCode, texto, json });
      });
    }).on('error', reject);
  });
}

const padraoDe = (script) => /^DEFAULT_PANEL_URL=(.*)$/m.exec(script)?.[1];

describe('a origem do instalador, por host', () => {
  it('no host de um provedor, o endereço daquele provedor', async () => {
    const alfa = await getComHost('alfa.painel.exemplo.com', '/api/genieacs-agent/install.sh');
    assert.equal(alfa.status, 200);
    assert.equal(padraoDe(alfa.texto), "'https://alfa.painel.exemplo.com'");

    const beta = await getComHost('beta.painel.exemplo.com:443', '/api/genieacs-agent/install.sh');
    assert.equal(beta.status, 200);
    // A porta do `Host` não vira parte do endereço: ele é montado de novo a
    // partir do domínio-base, e o host só escolheu a linha.
    assert.equal(padraoDe(beta.texto), "'https://beta.painel.exemplo.com'");
  });

  it('no ápice, onde o console mostra o comando, o domínio-base', async () => {
    for (const host of ['painel.exemplo.com', 'www.painel.exemplo.com']) {
      const r = await getComHost(host, '/api/genieacs-agent/install.sh');
      assert.equal(r.status, 200, host);
      assert.equal(padraoDe(r.texto), "'https://painel.exemplo.com'", host);
    }
    // E o programa também responde lá — o 404 que puder vir é o do arquivo
    // (ainda não chegou), nunca o do resolvedor.
    const programa = await getComHost('painel.exemplo.com', '/api/genieacs-agent/agent.mjs');
    assert.ok(programa.status === 200 || programa.json?.code === 'agent_file_missing',
      `status ${programa.status}`);
  });

  it('um host que não é provedor nenhum não é respondido', async () => {
    for (const host of ['atacante.example', 'fantasma.painel.exemplo.com', 'parada.painel.exemplo.com']) {
      const r = await getComHost(host, '/api/genieacs-agent/install.sh');
      assert.equal(r.status, 404, host);
      assert.ok(!r.texto.includes('DEFAULT_PANEL_URL'), host);
    }
  });
});
