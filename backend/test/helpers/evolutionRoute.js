import { EvolutionClient } from '../../src/services/evolutionClient.js';

/**
 * Leva as chamadas do `EvolutionClient` a um dublê em loopback.
 *
 * O cliente conecta por `PinnedTransport`, ao endereço que ele mesmo resolveu e
 * conferiu — é o que fecha o DNS rebinding. Trocar `globalThis.fetch`, que era
 * como as suítes faziam isso, não alcança mais nada. Então os dois encaixes do
 * cliente são trocados, um de cada vez:
 *
 * - `lookup` responde um endereço de TEST-NET-3 para os nomes que a suíte
 *   roteia, e a guarda de endereço roda de verdade sobre ele — é público, passa;
 * - `connect` recebe a chamada JÁ conferida e a manda para o dublê pelo `fetch`
 *   real, com o esquema rebaixado para `http:` pela mesma razão que o dublê de
 *   `whatsapp-lifecycle` sempre deu: falar TLS com ele exigiria desligar a
 *   conferência do certificado, que é o que este código nunca faz.
 *
 * `rota(url)` devolve a URL do dublê para aquela chamada, ou `null` para deixar
 * passar ao transporte real. Devolve a função que desfaz a troca.
 */
export function rotearEvolution(rota) {
  const lookupReal = EvolutionClient.lookup;
  const connectReal = EvolutionClient.connect;
  const fetchReal = globalThis.fetch;

  EvolutionClient.lookup = (hostname) => {
    const alvo = rota(new URL(`https://${hostname}/`));
    return alvo ? [{ address: '203.0.113.250', family: 4 }] : lookupReal.call(EvolutionClient, hostname);
  };

  EvolutionClient.connect = (opcoes) => {
    const alvo = rota(opcoes.url);
    if (!alvo) return connectReal.call(EvolutionClient, opcoes);
    return fetchReal(alvo, {
      method: opcoes.method,
      headers: opcoes.headers,
      body: opcoes.body,
      signal: opcoes.signal,
      redirect: 'manual'
    });
  };

  return () => {
    EvolutionClient.lookup = lookupReal;
    EvolutionClient.connect = connectReal;
  };
}

/** O caso comum: tudo que começa com `base` vai para `local`, caminho preservado. */
export function rotearBase(base, local) {
  const origem = new URL(base).origin;
  return rotearEvolution((url) => (url.origin === origem
    ? `${local}${url.pathname}${url.search}`
    : null));
}
