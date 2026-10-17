import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServers, stopTestServers } from './helpers/harness.js';

let panelUrl;
let portalUrl;

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());
});

after(async () => {
  await stopTestServers();
});

describe('Permissions-Policy', () => {
  it('o painel libera o microfone só para a própria origem (gravar áudio no WhatsApp)', async () => {
    const res = await fetch(`${panelUrl}/api/health`);
    const policy = res.headers.get('permissions-policy');
    assert.match(policy, /microphone=\(self\)/);
    assert.match(policy, /camera=\(\)/);
    // O player de áudio toca o blob baixado com o token: precisa de `blob:`.
    assert.match(res.headers.get('content-security-policy'), /media-src 'self' blob:/);
  });

  it('o portal do assinante continua sem microfone', async () => {
    const res = await fetch(`${portalUrl}/api/health`);
    const policy = res.headers.get('permissions-policy');
    assert.match(policy, /microphone=\(\)/);
  });
});
