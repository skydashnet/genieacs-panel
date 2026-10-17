import { currentTenantId } from '../../config/tenantContext.js';
import GenieAcsConnection from '../../models/GenieAcsConnection.js';
import DirectConnector from './direct.js';
import TunnelConnector from './tunnel.js';
import AgentConnector from './agent.js';

/** O conector de cada modo de `tenant_genieacs_connections`. */
const CONECTORES = Object.freeze({
  direct: DirectConnector,
  tunnel: TunnelConnector,
  agent: AgentConnector
});

/**
 * Por onde o painel fala com o GenieACS daquele provedor.
 *
 * Até aqui `DeviceService` montava a URL, escolhia os headers, abria o
 * `AbortController`, pegava a vaga de concorrência e chamava o egresso — **em
 * sete lugares**, cada um repetindo os cinco passos. Repetição de cinco passos
 * em sete lugares não é estilo: é a oitava chamada nascendo sem um deles, e a
 * onda 19 já mostrou qual (a credencial, que some em silêncio porque um ACS sem
 * autenticação aceita a requisição do mesmo jeito).
 *
 * O que muda de fato é outra coisa, e é o motivo de a Fase 4 pedir isto antes
 * de qualquer segundo modo: **`DeviceService` deixa de saber que existe URL.**
 * Ele pede um caminho ao conector do provedor; como aquele caminho chega ao ACS
 * — HTTP direto, um agente que abriu WebSocket de saída, um túnel, uma
 * instância que nós hospedamos — é problema do conector. Sem essa separação,
 * cada modo novo seria um `if` a mais nos sete lugares.
 *
 * ## Os modos
 *
 * O modo mora em `tenant_genieacs_connections` (sem linha, `direct`), e é
 * escolhido AQUI e em mais nenhum lugar:
 *
 * - `direct`: a URL, pelo egresso com as guardas de sempre;
 * - `tunnel`: a mesma URL, com a rede privada DE CLIENTE liberada para este
 *   provedor (`tunnel.js`) — o GenieACS atrás de VPN/WireGuard;
 * - `agent`: sem URL alcançável nenhuma — um programa na rede do provedor
 *   abriu WebSocket de saída para o painel, e o pedido desce por ele
 *   (`agent.js`, `agentHub.js`). Só o transporte muda: escopo, raiz, vaga,
 *   prazo e credencial são os do direto. Agente desconectado é
 *   `acs_agent_offline` na hora, que as rotas devolvem como 503.
 *
 * Os três diferem só em `send` (e o túnel, em `egressOptions`): tudo o que
 * vem antes de sair — e é onde mora a segurança — é o mesmo código.
 *
 * `allow_private_ranges` do plano virou o próprio modo `tunnel`, e não uma
 * coluna solta: liberar rede privada sem dizer por quê seria uma chave que
 * alguém liga "para testar" e esquece ligada.
 */

/**
 * O conector do provedor em escopo.
 *
 * Assíncrono desde já, ainda que hoje não precise: quando o modo vier de uma
 * linha do banco, esta função lê o banco, e uma assinatura que muda de síncrona
 * para assíncrona muda todo mundo que a chama. O custo de já ser assíncrona é
 * zero; o de virar assíncrona depois é o refactor inteiro outra vez.
 */
export async function connectorFor() {
  // Chamado fora de escopo, isto lança — e lançar é certo. Um conector sem
  // provedor é uma requisição ao ACS de ninguém, que é exatamente o que a
  // tenancy existe para impedir.
  currentTenantId();
  return CONECTORES[await GenieAcsConnection.mode()] ?? DirectConnector;
}

export { DirectConnector, TunnelConnector, AgentConnector };
