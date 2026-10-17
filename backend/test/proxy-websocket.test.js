import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Os exemplos de proxy deixam passar o WebSocket do agente do GenieACS.
 *
 * Todo `location /` destes arquivos põe `proxy_set_header Connection ""` — é o
 * keepalive com o painel —, e essa linha apaga o `Connection: upgrade` do
 * pedido. Um bloco de painel sem o `location = /api/genieacs-agent/connect`
 * próprio responde 426 ao agente (medido com o nginx 1.24 sobre o template), e
 * o sintoma na máquina do provedor é um agente que "não conecta" sem motivo
 * visível. Este arquivo existe para que um bloco de painel novo não nasça sem
 * ele.
 */
const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARQUIVOS = ['deploy/proxy/nginx-saas.conf.example', 'deploy/proxy/nginx-tenant.conf.template'];

/** Os blocos `server { … }` de um arquivo, pelo balanço das chaves. */
function servidores(texto) {
  const semComentario = texto.replace(/#[^\n]*/g, '');
  const blocos = [];
  const re = /\bserver\s*\{/g;
  let m;
  while ((m = re.exec(semComentario)) !== null) {
    let prof = 1;
    let i = re.lastIndex;
    for (; i < semComentario.length && prof > 0; i += 1) {
      if (semComentario[i] === '{') prof += 1;
      if (semComentario[i] === '}') prof -= 1;
    }
    blocos.push(semComentario.slice(m.index, i));
    re.lastIndex = i;
  }
  return blocos;
}

/** O corpo de um `location` exato. */
function localExato(bloco, caminho) {
  const i = bloco.indexOf(`location = ${caminho} {`);
  if (i === -1) return null;
  return bloco.slice(i, bloco.indexOf('}', i) + 1);
}

describe('o proxy de exemplo e o WebSocket do agente', () => {
  for (const arquivo of ARQUIVOS) {
    it(`${arquivo}: todo bloco do painel tem o upgrade do /connect`, () => {
      const blocosDoPainel = servidores(fs.readFileSync(path.join(RAIZ, arquivo), 'utf8'))
        .filter((b) => /proxy_pass http:\/\/127\.0\.0\.1:5890;/.test(b));
      assert.ok(blocosDoPainel.length > 0, 'nenhum bloco do painel encontrado');
      for (const bloco of blocosDoPainel) {
        const local = localExato(bloco, '/api/genieacs-agent/connect');
        const nome = /server_name ([^;]+);/.exec(bloco)?.[1];
        assert.ok(local, `bloco ${nome} sem location = /api/genieacs-agent/connect`);
        for (const diretiva of [
          'proxy_pass http://127.0.0.1:5890;',
          'proxy_http_version 1.1;',
          'proxy_set_header Upgrade    $http_upgrade;',
          'proxy_set_header Connection "upgrade";',
          'proxy_read_timeout 3600s;',
          'proxy_send_timeout 3600s;',
          'proxy_buffering off;',
          // Os mesmos cabeçalhos do vizinho: o Host é o que diz de qual
          // provedor é o agente, e o X-Forwarded-* é o que o TRUST_PROXY lê.
          'proxy_set_header Host              $host;',
          'proxy_set_header X-Real-IP         $remote_addr;',
          'proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;',
          'proxy_set_header X-Forwarded-Proto $scheme;'
        ]) {
          assert.ok(local.includes(diretiva), `bloco ${nome}: falta ${diretiva}`);
        }
        assert.ok(!local.includes('Connection ""'), `bloco ${nome}: o /connect não pode apagar o Connection`);
      }
    });
  }

  it('o portal do assinante não ganha o bloco — o agente fala com o painel', () => {
    const portal = servidores(fs.readFileSync(path.join(RAIZ, ARQUIVOS[0]), 'utf8'))
      .filter((b) => /proxy_pass http:\/\/127\.0\.0\.1:5891;/.test(b));
    assert.equal(portal.length, 1);
    assert.equal(localExato(portal[0], '/api/genieacs-agent/connect'), null);
  });
});
