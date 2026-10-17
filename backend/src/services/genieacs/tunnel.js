import DirectConnector from './direct.js';

/**
 * O GenieACS do provedor atrás de uma VPN, um WireGuard ou um link dedicado.
 *
 * É o conector direto com uma diferença só: o egresso aceita endereço de rede
 * privada DE CLIENTE (`isCustomerPrivateAddress` — 10/8, 172.16/12,
 * 192.168/16, CGNAT e fc00::/7). Loopback, link-local e metadados de nuvem
 * continuam recusados, e a lista de portas continua valendo.
 *
 * Quem liga este modo é a plataforma, por provedor, no console
 * (`tenant_genieacs_connections.mode`). O provedor não alcança a escolha: uma
 * guarda que o guardado desliga não é guarda.
 */
class TunnelConnector extends DirectConnector {
  static mode = 'tunnel';

  static egressOptions() {
    return { allowPrivateRanges: true };
  }
}

export default TunnelConnector;
