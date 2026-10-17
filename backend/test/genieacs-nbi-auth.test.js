import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A credencial com que o painel se apresenta ao GenieACS.
 *
 * Até esta onda o painel **não mandava header de autenticação nenhum**. É
 * defensável no self-hosted, onde a premissa escrita no código é que a NBI está
 * em loopback ou rede privada e quem alcança a porta já está dentro. No SaaS a
 * premissa não vale: a URL é dado do cliente, o ACS fica do lado dele, e o
 * caminho até lá é a internet.
 *
 * O que este arquivo persegue, além do óbvio: que o segredo **não saia por
 * lugar nenhum** — nem no GET da configuração, nem no `settings` inteiro, nem
 * pelo botão de testar conexão, que é o único ponto do painel onde o destino
 * de uma requisição ao ACS vem do corpo do request.
 */

const {
  app, authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: GenieAcsAuthService } = await import('../src/services/genieacsAuthService.js');
const { default: Setting } = await import('../src/models/Setting.js');

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

let panelUrl;
let token;
let tenantId;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operador', password: 'senha-do-operador-1', email: 'operador@exemplo.test' }
  });
  token = setup.body.data.token;
  tenantId = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
});

after(async () => {
  await stopTestServers();
});

const comoOperador = () => authHeaders(token);

describe('toda chamada à NBI passa pelo mesmo lugar', () => {
  /**
   * A varredura estática, e por que ela é o teste que mais importa aqui.
   *
   * `deviceService.js` tem sete chamadas ao ACS. Se cada uma montar os próprios
   * headers, a oitava nasce sem a credencial — e a falha é silenciosa nas duas
   * direções: contra uma NBI que não exige autenticação, funciona; contra uma
   * que exige, é um 401 numa tela só, que parece problema do ACS. Nenhum teste
   * de comportamento pega isso, porque a rota que esqueceu é justamente a que
   * ninguém pensou em cobrir.
   */
  it('nenhuma chamada ao ACS monta os próprios headers', () => {
    const fonte = fs.readFileSync(
      path.join(SRC, 'services', 'genieacs', 'direct.js'), 'utf8'
    );
    const linhas = fonte.split('\n');

    const chamadas = [];
    linhas.forEach((linha, i) => {
      if (!linha.includes('GenieAcsEgress.fetch(')) return;
      // A janela olha para TRÁS também, e não só para frente: duas das sete
      // montam o objeto de opções algumas linhas antes e passam a variável para
      // o fetch. Olhando só para frente, essas duas seriam denunciadas mesmo
      // com a credencial no lugar — e o jeito de "consertar" seria mover a
      // linha, não corrigir nada.
      const bloco = linhas
        .slice(Math.max(0, i - 14), Math.min(linhas.length, i + 10))
        .join('\n');
      chamadas.push({ linha: i + 1, bloco });
    });

    // Uma, e é o ponto da Fase 4: as sete chamadas de `deviceService` viraram
    // uma, no conector. A varredura vale mais assim, não menos — antes ela
    // precisava conferir sete lugares e podia perder o oitavo; agora o oitavo
    // lugar simplesmente não existe, e o caso abaixo é quem garante isso.
    assert.equal(chamadas.length, 1,
      `esperava uma chamada no conector, achei ${chamadas.length}`);

    const semCredencial = chamadas
      .filter(({ bloco }) => !/GenieAcsAuthService\.nbiHeaders\(/.test(bloco))
      .map(({ linha }) => `direct.js:${linha}`);
    assert.deepEqual(semCredencial, []);
  });

  /**
   * A mesma garantia, agora que o transporte é trocável.
   *
   * O modo `agent` não sai pelo egresso: o pedido desce pelo WebSocket que o
   * agente do provedor abriu (`agent.js`). A varredura acima olharia só para
   * `GenieAcsEgress.fetch(` e deixaria o agente passar sem credencial em
   * silêncio — que é exatamente a falha que ela existe para pegar, só que num
   * transporte novo.
   *
   * Então a regra desceu para o ponto onde ela vale em qualquer modo: todo
   * `send` (o transporte de um conector) monta a credencial ele mesmo, por
   * `nbiHeaders`, junto da própria saída. No `agent.js`, a saída é o
   * `agentHub.request(` — e ele não pode alcançar o egresso, senão seria um
   * segundo caminho HTTP para fora com as guardas de outro modo.
   */
  it('e todo transporte de conector monta a credencial na própria saída', () => {
    const DIR = path.join(SRC, 'services', 'genieacs');
    const blocoDoSend = (fonte) => {
      const inicio = fonte.search(/static async send\(/);
      if (inicio < 0) return null;
      // Até o próximo método estático (ou o fim da classe): o corpo do `send`.
      const resto = fonte.slice(inicio + 1);
      const fim = resto.search(/\n {2}static |\n}\n/);
      return fim < 0 ? resto : resto.slice(0, fim);
    };

    const direto = fs.readFileSync(path.join(DIR, 'direct.js'), 'utf8');
    const sendDireto = blocoDoSend(direto);
    assert.ok(sendDireto, 'direct.js perdeu o `send`');
    assert.match(sendDireto, /GenieAcsEgress\.fetch\(/, 'o `send` do direto não sai pelo egresso');
    assert.match(sendDireto, /GenieAcsAuthService\.nbiHeaders\(/, 'o `send` do direto não monta a credencial');

    const agente = fs.readFileSync(path.join(DIR, 'agent.js'), 'utf8');
    assert.doesNotMatch(agente, /GenieAcsEgress\.fetch\(/, 'agent.js alcança o egresso');
    // O agente troca SÓ o transporte: um `request` próprio pularia escopo,
    // raiz, vaga e prazo, que moram no `request` herdado.
    assert.doesNotMatch(agente, /static async request\(/, 'agent.js reescreve o `request`');
    const sendAgente = blocoDoSend(agente);
    assert.ok(sendAgente, 'agent.js não define o `send`');
    assert.match(sendAgente, /agentHub\.request\(/, 'o `send` do agente não desce pelo hub');
    assert.match(sendAgente, /GenieAcsAuthService\.nbiHeaders\(/, 'o `send` do agente não monta a credencial');

    // E nenhum outro conector com transporte próprio sem credencial.
    const semCredencial = fs.readdirSync(DIR)
      .filter((nome) => nome.endsWith('.js'))
      .filter((nome) => {
        const bloco = blocoDoSend(fs.readFileSync(path.join(DIR, nome), 'utf8'));
        return bloco !== null && !/GenieAcsAuthService\.nbiHeaders\(/.test(bloco);
      });
    assert.deepEqual(semCredencial, []);
  });

  /**
   * O que substituiu a varredura das sete: **nenhum outro arquivo fala com o
   * ACS**.
   *
   * A garantia antiga era "cada uma das sete põe a credencial", e ela tinha um
   * buraco por construção — a oitava chamada, escrita em qualquer lugar, nascia
   * sem credencial e sem ninguém para notar. Esta é mais forte: só o conector
   * alcança o egresso, então uma chamada nova ou passa por ele (e leva tudo:
   * credencial, prazo, vaga de concorrência, pinagem de DNS) ou aparece aqui.
   */
  it('e nenhum arquivo fora do conector alcança o egresso do ACS', () => {
    const permitidos = new Set([
      path.join(SRC, 'services', 'genieacs', 'direct.js'),
      // O próprio egresso, que é quem implementa o `fetch` pinado.
      path.join(SRC, 'services', 'genieacsEgress.js'),
      // O botão de testar conexão: o destino vem do corpo do request, então ele
      // é o único ponto que legitimamente NÃO passa pela raiz configurada — e
      // por isso mesmo é o que decide sozinho se leva a credencial, comparando
      // a origem testada com a salva. Ver `settingsController`.
      path.join(SRC, 'controllers', 'settingsController.js')
    ]);

    const infratores = [];
    const varrer = (dir) => {
      for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
        const caminho = path.join(dir, entrada.name);
        if (entrada.isDirectory()) { varrer(caminho); continue; }
        if (!entrada.name.endsWith('.js')) continue;
        if (permitidos.has(caminho)) continue;
        const fonte = fs.readFileSync(caminho, 'utf8');
        if (/GenieAcsEgress\.fetch\(/.test(fonte)) {
          infratores.push(path.relative(SRC, caminho));
        }
      }
    };
    varrer(SRC);
    assert.deepEqual(infratores, []);
  });
});

describe('o header que sai no fio', () => {
  it('não sai nenhum enquanto ninguém configurou', async () => {
    const headers = await runInTenant(tenantId, () => GenieAcsAuthService.nbiHeaders());
    assert.equal('Authorization' in headers, false);
    assert.equal(headers.Accept, 'application/json');
  });

  it('sai Basic com usuário e senha', async () => {
    await runInTenant(tenantId, () => GenieAcsAuthService.saveConfig({
      authType: 'basic', username: 'nbi', secret: 'segredo-da-nbi'
    }));
    const headers = await runInTenant(tenantId, () => GenieAcsAuthService.nbiHeaders());
    assert.equal(headers.Authorization,
      `Basic ${Buffer.from('nbi:segredo-da-nbi').toString('base64')}`);
  });

  it('sai Bearer com o token', async () => {
    await runInTenant(tenantId, () => GenieAcsAuthService.saveConfig({
      authType: 'bearer', secret: 'token-da-nbi'
    }));
    const headers = await runInTenant(tenantId, () => GenieAcsAuthService.nbiHeaders());
    assert.equal(headers.Authorization, 'Bearer token-da-nbi');
  });

  it('deixa de sair quando o tipo volta para none, e o segredo some junto', async () => {
    await runInTenant(tenantId, () => GenieAcsAuthService.saveConfig({ authType: 'none' }));
    const headers = await runInTenant(tenantId, () => GenieAcsAuthService.nbiHeaders());
    assert.equal('Authorization' in headers, false);

    // E some do banco, não só do header: segredo cifrado que nada lê é
    // superfície de vazamento esperando o dia em que alguém religa a
    // autenticação sem saber o que está mandando.
    const bruto = await runInTenant(tenantId, () => getDb()('app_state')
      .where({ key: 'genieacs_auth_config' }).first());
    assert.equal(JSON.parse(bruto.value).secret, null);
  });

  it('mantém o segredo quando o formulário salva sem tocar no campo', async () => {
    // A tela não reexibe o segredo, então um "salvar" que não mexeu no campo
    // manda `undefined`. Sem esta distinção, cada salvamento apagaria a
    // credencial e o painel pararia de falar com o ACS sem ninguém entender.
    await runInTenant(tenantId, () => GenieAcsAuthService.saveConfig({
      authType: 'bearer', secret: 'token-que-fica'
    }));
    await runInTenant(tenantId, () => GenieAcsAuthService.saveConfig({ username: 'outro' }));
    const headers = await runInTenant(tenantId, () => GenieAcsAuthService.nbiHeaders());
    assert.equal(headers.Authorization, 'Bearer token-que-fica');
  });

  it('apaga o segredo quando o campo vem vazio de propósito', async () => {
    await runInTenant(tenantId, () => GenieAcsAuthService.saveConfig({ secret: '' }));
    const headers = await runInTenant(tenantId, () => GenieAcsAuthService.nbiHeaders());
    assert.equal('Authorization' in headers, false);
  });
});

describe('o segredo guardado', () => {
  before(async () => {
    await runInTenant(tenantId, () => GenieAcsAuthService.saveConfig({
      authType: 'bearer', secret: 'segredo-que-nao-pode-vazar'
    }));
  });

  it('não está em claro no banco', async () => {
    const bruto = await runInTenant(tenantId, () => getDb()('app_state')
      .where({ key: 'genieacs_auth_config' }).first());
    assert.equal(bruto.value.includes('segredo-que-nao-pode-vazar'), false, bruto.value);
  });

  it('não volta no GET da própria configuração', async () => {
    const { status, body } = await call(`${panelUrl}/api/settings/genieacs-auth`, {
      headers: comoOperador()
    });
    assert.equal(status, 200);
    assert.equal(JSON.stringify(body).includes('segredo-que-nao-pode-vazar'), false);
    // Mas diz que existe um: sem isso a tela não teria como mostrar a diferença
    // entre "não configurado" e "configurado, e eu não te mostro".
    assert.equal(body.data.secretConfigured, true);
    assert.equal(body.data.authType, 'bearer');
    // A tela precisa saber em que edição o servidor roda para decidir se
    // "sem autenticação" merece aviso — e não tem outro jeito de descobrir.
    assert.equal(typeof body.data.allowsAnonymous, 'boolean');
  });

  it('não volta no GET de settings inteiro', async () => {
    // A razão de a credencial ter rota própria em vez de virar uma chave em
    // `settings`: aquela rota devolve `Setting.getAll()` inteiro.
    const { body } = await call(`${panelUrl}/api/settings`, { headers: comoOperador() });
    assert.equal(JSON.stringify(body).includes('segredo-que-nao-pode-vazar'), false);
  });

  it('não é alcançável pela rota de chave avulsa', async () => {
    // `/:key` casa com qualquer segmento. Se `/genieacs-auth` tivesse sido
    // declarada depois dela, o GET responderia "não encontrado" e o PUT tentaria
    // gravar uma chave com esse nome — os dois erros parecendo bug de outra
    // coisa. Este caso é o que fixa a ordem.
    const { status, body } = await call(`${panelUrl}/api/settings/genieacs-auth`, {
      headers: comoOperador()
    });
    assert.equal(status, 200);
    assert.ok(body.data.authTypes, 'a resposta tem que ser a da credencial, não a de uma chave');
  });
});

describe('o botão de testar conexão', () => {
  /**
   * O único ponto do painel em que o DESTINO de uma requisição ao ACS vem do
   * corpo do request. Mandar a credencial guardada para qualquer endereço faria
   * deste botão um jeito de LER o segredo: aponte para um servidor seu, leia o
   * header. Ele é gravado para nunca mais ser exibido, e um administrador
   * recuperaria assim o que um antecessor configurou.
   */
  let recebidos;
  let servidor;
  let base;

  before(async () => {
    const http = await import('node:http');
    recebidos = [];
    servidor = http.createServer((req, res) => {
      recebidos.push(req.headers.authorization ?? null);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });
    await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${servidor.address().port}`;

    await runInTenant(tenantId, () => Setting.upsert('genieAcsUrl', base));
    await runInTenant(tenantId, () => GenieAcsAuthService.saveConfig({
      authType: 'bearer', secret: 'segredo-do-teste'
    }));
  });

  after(async () => {
    await new Promise((resolve) => servidor.close(resolve));
  });

  it('leva a credencial quando o endereço testado é o que está salvo', async () => {
    recebidos.length = 0;
    const { status } = await call(`${panelUrl}/api/settings/test-genieacs`, {
      method: 'POST', headers: comoOperador(), body: { url: base }
    });
    assert.equal(status, 200);
    assert.deepEqual(recebidos, ['Bearer segredo-do-teste']);
  });

  it('e não leva para um endereço diferente', async () => {
    // O par que dá sentido ao caso acima: sem ele, um teste que nunca mandasse
    // credencial nenhuma passaria aqui.
    const http = await import('node:http');
    const alheios = [];
    const outro = http.createServer((req, res) => {
      alheios.push(req.headers.authorization ?? null);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });
    await new Promise((resolve) => outro.listen(0, '127.0.0.1', resolve));
    try {
      const { status } = await call(`${panelUrl}/api/settings/test-genieacs`, {
        method: 'POST',
        headers: comoOperador(),
        body: { url: `http://127.0.0.1:${outro.address().port}` }
      });
      assert.equal(status, 200);
      assert.deepEqual(alheios, [null], 'o segredo não pode sair para um endereço não salvo');
    } finally {
      await new Promise((resolve) => outro.close(resolve));
    }
  });
});

describe('a rota de configuração', () => {
  it('recusa um tipo de autenticação que não existe', async () => {
    const { status } = await call(`${panelUrl}/api/settings/genieacs-auth`, {
      method: 'PUT', headers: comoOperador(), body: { authType: 'kerberos' }
    });
    assert.equal(status, 400);
  });

  it('recusa basic sem usuário', async () => {
    // O header sairia `Basic OnNlZ3JlZG8=`, com usuário vazio, e o ACS recusaria
    // sem dizer por quê — que na tela é indistinguível de "salvou certo".
    const { status } = await call(`${panelUrl}/api/settings/genieacs-auth`, {
      method: 'PUT', headers: comoOperador(), body: { authType: 'basic', username: '', secret: 'x' }
    });
    assert.equal(status, 400);
  });

  it('aceita basic com usuário', async () => {
    const { status } = await call(`${panelUrl}/api/settings/genieacs-auth`, {
      method: 'PUT', headers: comoOperador(), body: { authType: 'basic', username: 'nbi', secret: 'x' }
    });
    assert.equal(status, 200);
  });
});

describe('a credencial é de cada provedor', () => {
  it('não vaza para o vizinho', async () => {
    const db = getDb();
    await db('tenants').insert({ slug: 'vizinho', name: 'Provedor Vizinho', status: 'active' });
    const vizinho = (await db('tenants').where({ slug: 'vizinho' }).first()).id;

    await runInTenant(tenantId, () => GenieAcsAuthService.saveConfig({
      authType: 'bearer', secret: 'so-do-primeiro'
    }));
    const meus = await runInTenant(tenantId, () => GenieAcsAuthService.nbiHeaders());
    const dele = await runInTenant(vizinho, () => GenieAcsAuthService.nbiHeaders());

    assert.equal(meus.Authorization, 'Bearer so-do-primeiro');
    assert.equal('Authorization' in dele, false,
      'o vizinho não configurou nada e não pode herdar a credencial de ninguém');
  });
});
