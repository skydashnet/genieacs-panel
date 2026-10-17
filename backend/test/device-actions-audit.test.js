import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  asTenant, authHeaders, call, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: AuditLog } = await import('../src/models/AuditLog.js');

/**
 * O que o operador faz NA ONT deixa linha na trilha.
 *
 * Até aqui só a senha do portal deixava. Reiniciar, mudar Wi-Fi, trocar a
 * credencial e apagar o aparelho do ACS não deixavam nada — e "quem mexeu no
 * meu roteador?" é a primeira pergunta de quem recebe a ligação do assinante.
 *
 * O que estes casos defendem além da linha existir: ela diz QUAIS campos, e
 * nunca os valores. A senha do Wi-Fi e a da ONT viajam nesses formulários, e a
 * trilha é exportada com o provedor e tem retenção própria.
 */
const DEVICE_ID = 'ONT-AUDIT-1';
const SENHA_WIFI = 'Senha-Do-Wifi-Nao-Pode-Vazar';
const SENHA_ONT = 'Senha-Da-Ont-Nao-Pode-Vazar';

let panelUrl;
let token;
/** A senha do operador de `before`, duas vezes: o reset de fábrica pede as duas. */
const SENHAS = { password: 'operator-password-1', passwordConfirm: 'operator-password-1' };
let genie;

before(async () => {
  ({ panelUrl } = await startTestServers());
  genie = await startGenieAcsStub({ devices: [buildDevice({ id: DEVICE_ID })] });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => Setting.upsert('genieAcsUrl', genie.url));
});

after(async () => {
  await genie.close();
  await stopTestServers();
});

beforeEach(() => {
  genie.state.respond = null;
  genie.state.tasks.length = 0;
});

const linhas = (action) => getDb()('audit_log').where({ action }).orderBy('id', 'asc');
const post = (path, body) => call(`${panelUrl}${path}`, { method: 'POST', headers: authHeaders(token), body });

describe('a trilha do que se faz na ONT', () => {
  it('reiniciar deixa linha, com o aparelho e quem foi', async () => {
    const antes = (await linhas(AuditLog.ACTIONS.DEVICE_REBOOTED)).length;
    const { status } = await post('/api/devices/reboot', { deviceId: DEVICE_ID });
    assert.equal(status, 200);

    const depois = await linhas(AuditLog.ACTIONS.DEVICE_REBOOTED);
    assert.equal(depois.length, antes + 1);
    const linha = depois.at(-1);
    assert.equal(linha.subject_type, 'device');
    assert.equal(linha.subject_id, DEVICE_ID);
    assert.equal(linha.actor_username, 'operator');
  });

  it('mudar o Wi-Fi diz quais campos — e a senha não entra', async () => {
    const { status } = await post(`/api/devices/${DEVICE_ID}/update-wifi`, {
      index: 1,
      formData: { ssid: 'Casa-do-Joao', password: SENHA_WIFI }
    });
    assert.equal(status, 200);

    const linha = (await linhas(AuditLog.ACTIONS.DEVICE_WIFI_CHANGED)).at(-1);
    assert.ok(linha, 'mudar o Wi-Fi não deixou linha');
    const detalhe = JSON.parse(linha.detail);
    assert.equal(detalhe.fields, 'ssid, password');
    assert.equal(detalhe.index, '1');
    assert.ok(!JSON.stringify(linha).includes(SENHA_WIFI), 'a senha do Wi-Fi foi parar na trilha');
    assert.ok(!JSON.stringify(linha).includes('Casa-do-Joao'), 'o valor do campo foi parar na trilha');
  });

  it('trocar a credencial da ONT diz o tipo — e a senha não entra', async () => {
    const { status } = await post(`/api/devices/${DEVICE_ID}/update-credentials`, {
      type: 'super',
      password: SENHA_ONT
    });
    assert.equal(status, 200);

    const linha = (await linhas(AuditLog.ACTIONS.DEVICE_CREDENTIALS_CHANGED)).at(-1);
    assert.ok(linha, 'trocar a credencial não deixou linha');
    assert.equal(JSON.parse(linha.detail).type, 'super');
    assert.ok(!JSON.stringify(linha).includes(SENHA_ONT), 'a senha da ONT foi parar na trilha');
  });

  it('apagar o aparelho do ACS exige a série e a senha, como o reset de fábrica', async () => {
    // O uso é apagar o ONT antigo que ficou no ACS depois de uma troca; o
    // clique no aparelho errado apagaria o que está em serviço.
    const apagar = (body) => call(`${panelUrl}/api/devices/${DEVICE_ID}`, {
      method: 'DELETE',
      headers: authHeaders(token),
      body
    });
    const antes = (await linhas(AuditLog.ACTIONS.DEVICE_DELETED)).length;
    const casos = [
      [undefined, 400, 'password_required'],
      [{ confirmSerial: 'ZTEG12345678' }, 400, 'password_required'],
      [{ confirmSerial: 'ZTEG12345678', password: 'operator-password-1', passwordConfirm: 'x' }, 400, 'password_mismatch'],
      [{ confirmSerial: 'ZTEG12345678', password: 'senha-errada-1', passwordConfirm: 'senha-errada-1' }, 403, 'password_incorrect'],
      [{ confirmSerial: 'ZTEG00000000', ...SENHAS }, 400, 'serial_mismatch'],
      [{ ...SENHAS }, 400, 'serial_mismatch']
    ];
    for (const [body, esperado, codigo] of casos) {
      // eslint-disable-next-line no-await-in-loop -- uma tentativa por vez
      const res = await apagar(body);
      assert.equal(res.status, esperado, `aceitou ${JSON.stringify(body)}`);
      assert.equal(res.body.code, codigo);
    }
    assert.deepEqual(genie.state.deleted, [], 'apagou sem a confirmação');
    assert.equal((await linhas(AuditLog.ACTIONS.DEVICE_DELETED)).length, antes);
  });

  it('apagar o aparelho do ACS deixa linha', async () => {
    const { status } = await call(`${panelUrl}/api/devices/${DEVICE_ID}`, {
      method: 'DELETE',
      headers: authHeaders(token),
      body: { confirmSerial: ' zteg12345678 ', ...SENHAS }
    });
    assert.equal(status, 200);
    assert.deepEqual(genie.state.deleted, [DEVICE_ID]);
    const linha = (await linhas(AuditLog.ACTIONS.DEVICE_DELETED)).at(-1);
    assert.equal(linha?.subject_id, DEVICE_ID);
  });

  it('a ação que o ACS recusou não deixa linha', async () => {
    // A trilha diz o que aconteceu. Uma linha "reiniciou" sobre um reboot que
    // o ACS recusou mandaria o técnico procurar outra causa para a queda.
    genie.state.respond = ({ send }) => send(500, { message: 'down' });
    const antes = (await linhas(AuditLog.ACTIONS.DEVICE_REBOOTED)).length;
    const { status } = await post('/api/devices/reboot', { deviceId: DEVICE_ID });
    assert.equal(status, 500);
    assert.equal((await linhas(AuditLog.ACTIONS.DEVICE_REBOOTED)).length, antes);
  });

  it('o reset de fábrica exige o número de série DESTE aparelho', async () => {
    // A tela pode ter ficado aberta noutro aparelho, e a API é chamada por quem
    // não usa a tela. Série errada: nenhuma tarefa sai, nenhuma linha entra.
    const antes = (await linhas(AuditLog.ACTIONS.DEVICE_FACTORY_RESET)).length;
    for (const errada of ['ZTEG00000000', '', undefined]) {
      // eslint-disable-next-line no-await-in-loop -- uma tentativa por vez
      const { status, body } = await post('/api/devices/factory-reset', { deviceId: DEVICE_ID, confirmSerial: errada, ...SENHAS });
      assert.equal(status, 400, `aceitou ${JSON.stringify(errada)}`);
      assert.equal(body.code, 'serial_mismatch');
    }
    assert.equal(genie.state.tasks.filter((t) => t.task?.name === 'factoryReset').length, 0, 'mandou o reset com a série errada');
    assert.equal((await linhas(AuditLog.ACTIONS.DEVICE_FACTORY_RESET)).length, antes);
  });

  it('o reset de fábrica exige a senha do operador, digitada duas vezes e certa', async () => {
    // Série certa em todos: o que decide aqui é só a senha.
    const antes = (await linhas(AuditLog.ACTIONS.DEVICE_FACTORY_RESET)).length;
    const casos = [
      [{}, 400, 'password_required'],
      [{ password: 'operator-password-1' }, 400, 'password_required'],
      [{ password: 'operator-password-1', passwordConfirm: 'operator-password-2' }, 400, 'password_mismatch'],
      [{ password: 'senha-errada-1', passwordConfirm: 'senha-errada-1' }, 403, 'password_incorrect']
    ];
    for (const [senhas, esperado, codigo] of casos) {
      // eslint-disable-next-line no-await-in-loop -- uma tentativa por vez
      const { status, body } = await post('/api/devices/factory-reset', { deviceId: DEVICE_ID, confirmSerial: 'ZTEG12345678', ...senhas });
      assert.equal(status, esperado, `aceitou ${JSON.stringify(senhas)}`);
      assert.equal(body.code, codigo);
    }
    assert.equal(genie.state.tasks.filter((t) => t.task?.name === 'factoryReset').length, 0, 'mandou o reset sem a senha certa');
    assert.equal((await linhas(AuditLog.ACTIONS.DEVICE_FACTORY_RESET)).length, antes);
  });

  it('com a série certa — sem ligar para maiúsculas e espaços — a ONT volta de fábrica, com linha', async () => {
    const { status } = await post('/api/devices/factory-reset', { deviceId: DEVICE_ID, confirmSerial: '  zteg12345678 ', ...SENHAS });
    assert.equal(status, 200);
    assert.deepEqual(
      genie.state.tasks.filter((t) => t.task?.name === 'factoryReset').map((t) => t.deviceId),
      [DEVICE_ID]
    );
    const linha = (await linhas(AuditLog.ACTIONS.DEVICE_FACTORY_RESET)).at(-1);
    assert.equal(linha?.subject_id, DEVICE_ID);
  });

  it('forçar contato não deixa linha, de propósito: não muda nada na ONT', async () => {
    const antes = await getDb()('audit_log').count({ n: '*' });
    await post('/api/devices/summon', { deviceId: DEVICE_ID });
    const depois = await getDb()('audit_log').count({ n: '*' });
    assert.equal(Number(depois[0].n), Number(antes[0].n));
  });
});
