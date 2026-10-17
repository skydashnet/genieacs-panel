import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectOutages, mapsLink, outageMinimum } from '../src/services/outageDetector.js';

/**
 * A regra de "provável rompimento", sozinha: quantos offline bastam numa
 * caixa, e a quem cada cliente pertence.
 */
describe('outageMinimum', () => {
  it('caixa grande segue o número da regra; caixa pequena, a maioria; nunca menos de 2', () => {
    assert.equal(outageMinimum(5, 16), 5);
    assert.equal(outageMinimum(5, 8), 5);
    assert.equal(outageMinimum(5, 5), 3);
    assert.equal(outageMinimum(5, 4), 3);
    assert.equal(outageMinimum(5, 2), 2);
    assert.equal(outageMinimum(5, 1), 2);
    assert.equal(outageMinimum(3, 16), 3);
  });
});

describe('detectOutages', () => {
  const nodes = [
    { node_id: 'olt', type: 'olt', name: 'OLT' },
    { node_id: 'cto', type: 'odp', name: 'CTO', latitude: -4.27, longitude: -55.98 },
    ...['a', 'b', 'c', 'd'].map((id) => ({ node_id: id, type: 'ont', name: id }))
  ];
  const edges = [
    { source: 'olt', target: 'cto' },
    { source: 'cto', target: 'a' },
    { source: 'b', target: 'cto' },
    { source: 'cto', target: 'c' },
    // Ligado à CTO e à OLT: vale a caixa mais próxima, a CTO.
    { source: 'cto', target: 'd' },
    { source: 'olt', target: 'd' }
  ];

  it('3 de 4 na mesma caixa: caiu, desde o primeiro sinal perdido', () => {
    const offline = new Map([['a', 3000], ['b', 1000], ['c', 2000]]);
    const [outage] = detectOutages({ nodes, edges, offline, threshold: 5 });
    assert.equal(outage.box.node_id, 'cto');
    assert.equal(outage.count, 3);
    assert.equal(outage.total, 4);
    assert.equal(outage.since, 1000);
  });

  it('1 de 4 não é rompimento; cliente sem caixa não conta', () => {
    assert.deepEqual(detectOutages({ nodes, edges, offline: new Map([['a', 1]]), threshold: 5 }), []);
    assert.deepEqual(detectOutages({ nodes, edges, offline: new Map([['solto', 1], ['outro', 1]]), threshold: 2 }), []);
  });

  it('link do mapa', () => {
    assert.equal(mapsLink({ latitude: -4.27, longitude: -55.98 }), 'https://maps.google.com/?q=-4.270000,-55.980000');
    assert.equal(mapsLink({}), '');
  });
});
