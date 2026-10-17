import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// A edição é lida UMA vez, no carregamento de `edition.js`, e aqui ela tem que
// ficar como está num deploy que ninguém configurou: `selfhosted`, o default.
// É exatamente a situação que este arquivo existe para cobrir, então nada de
// `process.env.EDITION` aqui. Importações dinâmicas pelo mesmo motivo dos
// vizinhos: um import estático subiria acima desta decisão.
delete process.env.EDITION;

const {
  default: GenieAcsEgress, deploymentIsShared, refreshDeploymentSharing, resetDeploymentSharing
} = await import('../src/services/genieacsEgress.js');
const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');

/**
 * A guarda de egresso não pode depender de alguém lembrar de uma variável.
 *
 * Ela inteira — a tabela de faixas privadas e a allowlist de portas — era
 * aplicada só quando `EDITION=saas`, e `EDITION` tem default `selfhosted`. Um
 * deploy SaaS que subisse sem essa linha no `.env` rodava com as duas
 * desligadas, e nada percebia: o painel funciona, os testes passam, e a única
 * diferença é que o endereço de metadados da nuvem volta a ser destino válido —
 * salvável em `genieAcsUrl` por qualquer administrador de provedor.
 *
 * O repositório já tinha reconhecido esse modo de falha no outro portão
 * (`assertSoleProvider`, em `dbManagementService.js`, cujo comentário diz que
 * ler `EDITION` "é a ideia certa na forma errada") e não tinha trazido a
 * correção para cá. Este arquivo é a correção, provada onde ela importa: com a
 * variável AUSENTE.
 */
const PRIVADO = '10.1.2.3';
const PUBLICO = '203.0.113.7';
const PORTA_BOA = 7557;
const PORTA_RUIM = 9999;

const realLookup = GenieAcsEgress.lookup;

function responderCom(endereco) {
  GenieAcsEgress.lookup = async () => [{ address: endereco, family: 4 }];
}

before(async () => {
  await startTestServers();
});

after(async () => {
  GenieAcsEgress.lookup = realLookup;
  // A limpeza vem ANTES de derrubar os servidores: depois deles o pool já foi
  // destruído, e a consulta fica esperando uma conexão que não volta — o teste
  // não falha, trava. Descoberto do jeito mais caro.
  await getDb()('tenants').where({ slug: 'segundo-provedor' }).del();
  await stopTestServers();
});

afterEach(() => {
  GenieAcsEgress.lookup = realLookup;
  resetDeploymentSharing();
});

describe('com um provedor só, a guarda continua fora do caminho', () => {
  it('aceita endereço privado e porta fora da lista', async () => {
    await refreshDeploymentSharing();
    assert.equal(deploymentIsShared(), false);
    responderCom(PRIVADO);
    const alvo = await GenieAcsEgress.resolveTarget(`http://acs.interno.invalid:${PORTA_RUIM}/devices`);
    assert.deepEqual(alvo.addresses.map((a) => a.address), [PRIVADO]);
  });
});

describe('assim que nasce o segundo provedor, ela passa a valer', () => {
  before(async () => {
    await getDb()('tenants').insert({
      slug: 'segundo-provedor', name: 'Segundo Provedor', status: 'active'
    });
  });

  it('recusa a faixa privada, mesmo sem EDITION no ambiente', async () => {
    assert.equal(process.env.EDITION, undefined, 'o teste perde o sentido com a variável posta');
    await refreshDeploymentSharing();
    assert.equal(deploymentIsShared(), true);
    responderCom(PRIVADO);
    await assert.rejects(
      GenieAcsEgress.resolveTarget(`http://acs.interno.invalid:${PORTA_BOA}/devices`),
      /GenieACS host/
    );
  });

  it('e recusa a porta fora da lista', async () => {
    await refreshDeploymentSharing();
    responderCom(PUBLICO);
    await assert.rejects(
      GenieAcsEgress.resolveTarget(`http://acs.cliente.invalid:${PORTA_RUIM}/devices`),
      /port 9999 is not allowed/
    );
  });

  it('mas deixa passar o que é legítimo', async () => {
    await refreshDeploymentSharing();
    responderCom(PUBLICO);
    const alvo = await GenieAcsEgress.resolveTarget(`http://acs.cliente.invalid:${PORTA_BOA}/devices`);
    assert.deepEqual(alvo.addresses.map((a) => a.address), [PUBLICO]);
  });

  /**
   * Grudento de propósito: uma vez que o processo viu dois provedores, não
   * pergunta mais. Reabrir a guarda porque um provedor foi apagado seria trocar
   * segurança por uma consulta, e a única coisa que a releitura poderia fazer é
   * afrouxar.
   */
  it('e não volta atrás quando o segundo provedor some', async () => {
    await refreshDeploymentSharing();
    assert.equal(deploymentIsShared(), true);
    await getDb()('tenants').where({ slug: 'segundo-provedor' }).del();
    await refreshDeploymentSharing();
    assert.equal(deploymentIsShared(), true, 'aprendeu que é compartilhado; não desaprende');
    await getDb()('tenants').insert({
      slug: 'segundo-provedor', name: 'Segundo Provedor', status: 'active'
    });
  });
});
