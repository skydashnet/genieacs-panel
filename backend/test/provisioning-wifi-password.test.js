import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: ProvisioningService } = await import('../src/services/provisioningService.js');
const { default: ProvisioningRun } = await import('../src/models/ProvisioningRun.js');
const { default: CustomerAccount } = await import('../src/models/CustomerAccount.js');
const { default: CustomerWifiCredentialService } = await import(
  '../src/services/customerWifiCredentialService.js'
);

/**
 * A senha de WiFi que o painel sorteia não pode sumir sem que ninguém saiba.
 *
 * No modo `random` o painel gera a senha, escreve na ONT e guarda a única cópia
 * no cofre do assinante. O que não for guardado ali está perdido: o assinante
 * fica trancado fora do próprio WiFi e o operador não tem o que dizer a ele —
 * só refazer o provisionamento com uma senha nova.
 *
 * E o caminho que a perdia não lançava exceção nenhuma, que é por que o
 * `catch` existente nunca o pegou. `CustomerService.ensureAccount` devolve
 * `null`, calada, quando falta ao aparelho um dos três identificadores do
 * assinante — o `_id`, a versão de software ou o login PPPoE. `ensurePortalAccount`
 * roda antes dos passos justamente para criar essa conta; devolvendo `null` ela
 * não criava nada, e o `if (!account) return;` do passo de WiFi fechava a porta
 * sem uma linha de log.
 */

const DEVICE = 'ont-sem-identidade';
const OUTRO = 'ont-com-identidade';

/** O aparelho como o plano o carrega: `plan.device` é o documento do GenieACS. */
function device({ softwareVersion = 'V1.0.0' } = {}) {
  return {
    _id: DEVICE,
    InternetGatewayDevice: {
      DeviceInfo: softwareVersion
        ? { SoftwareVersion: { _value: softwareVersion, _writable: false } }
        : {}
    }
  };
}

const passo = () => ({ step: 'wifi', index: 1, form: { ssid: 'Provedor-4321', password: 'Senha-Sorteada-9' } });

let avisos;
let errosReais;
const errReal = console.error;
const warnReal = console.warn;

before(async () => {
  await startTestServers();
});

after(async () => {
  console.error = errReal;
  console.warn = warnReal;
  await stopTestServers();
});

/** Captura o que foi dito ao operador, que aqui é metade do que está sob teste. */
function capturarLogs() {
  avisos = [];
  errosReais = [];
  console.warn = (...args) => { avisos.push(args.join(' ')); };
  console.error = (...args) => { errosReais.push(args.join(' ')); };
  return () => { console.warn = warnReal; console.error = errReal; };
}

describe('a senha de WiFi que não tem onde ser guardada', () => {
  it('diz alto que a senha foi escrita na ONT e não guardada', async () => {
    const soltar = capturarLogs();
    try {
      const guardada = await asTenant(() => ProvisioningService.rememberWifiPassword(
        // Sem versão de software e sem login: `ensureAccount` devolve null sem
        // lançar, que é exatamente o caso que sumia em silêncio.
        { deviceId: DEVICE, device: device({ softwareVersion: null }), login: '' },
        passo()
      ));
      assert.equal(guardada, false);
      assert.ok(
        errosReais.some((linha) => linha.includes(DEVICE) && /not stored/.test(linha)),
        `nada foi registrado: ${JSON.stringify(errosReais)}`
      );
      // E o aviso nomeia o que falta, que é a única coisa que o operador pode
      // corrigir no aparelho.
      assert.ok(
        avisos.some((linha) => linha.includes('software version') && linha.includes('PPPoE login')),
        `o aviso não diz o que falta: ${JSON.stringify(avisos)}`
      );
    } finally {
      soltar();
    }
  });

  // A outra metade: quando dá para criar a conta, a senha é guardada em vez de
  // perdida. É a tentativa a mais que resolve o caso comum — `ensurePortalAccount`
  // ter falhado antes por algo passageiro.
  it('cria a conta que faltava e guarda a senha', async () => {
    const plan = { deviceId: OUTRO, device: device(), login: 'assinante@provedor' };
    assert.ok(!(await asTenant(() => CustomerAccount.getByDeviceId(OUTRO))), 'a conta não existe ainda');

    const guardada = await asTenant(() => ProvisioningService.rememberWifiPassword(plan, passo()));

    assert.equal(guardada, true);
    const account = await asTenant(() => CustomerAccount.getByDeviceId(OUTRO));
    assert.ok(account, 'a conta tinha que ter sido criada na segunda tentativa');
    assert.equal(
      await asTenant(() => CustomerWifiCredentialService.reveal(account.id, 1)),
      'Senha-Sorteada-9'
    );
  });
});

describe('a linha da execução', () => {
  /**
   * A execução NÃO vira falha por causa disto — a ONT foi configurada e está no
   * ar, e refazer tudo não traria a senha de volta. O que a linha tem de
   * carregar é que a senha não foi arquivada, para que o chamado do assinante
   * daqui a dois dias tenha resposta.
   */
  it('registra que a senha não foi guardada, sem derrubar a execução', async () => {
    const buildPlanReal = ProvisioningService.buildPlan;
    const runStepReal = ProvisioningService.runStep;
    const soltar = capturarLogs();
    ProvisioningService.buildPlan = async () => ({
      deviceId: DEVICE,
      device: device({ softwareVersion: null }),
      login: '',
      contract: { contract: '4321' },
      profile: { id: null, name: 'Padrão' },
      steps: [passo()]
    });
    ProvisioningService.runStep = async () => ({
      status: 'applied', detail: null, parameters: [['ssid', 'Provedor-4321']]
    });

    try {
      const criada = await asTenant(() => ProvisioningRun.create({
        device_id: DEVICE, trigger: 'manual', status: 'pending', attempt_count: 0
      }));
      const run = await asTenant(() => ProvisioningService.executeRun(
        typeof criada === 'object' ? criada : { id: criada, device_id: DEVICE, attempt_count: 0 }
      ));

      assert.notEqual(run.status, 'failed', 'a ONT foi configurada; a execução não é uma falha');
      const steps = typeof run.steps === 'string' ? JSON.parse(run.steps) : run.steps;
      assert.equal(steps[0].passwordStored, false, 'a linha tem que guardar que a senha se perdeu');
    } finally {
      soltar();
      ProvisioningService.buildPlan = buildPlanReal;
      ProvisioningService.runStep = runStepReal;
      await asTenant(() => getDb()('provisioning_runs').where({ device_id: DEVICE }).delete());
    }
  });
});
