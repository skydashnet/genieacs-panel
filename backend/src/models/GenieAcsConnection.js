import { getDb, tdb, tinsert } from '../config/database.js';
import { runInTenant, runUnscoped } from '../config/tenantContext.js';
import { TenantCache } from '../config/tenantCache.js';

/**
 * Os modos que existem.
 *
 * `agent`: um programa na rede do provedor abre WebSocket de SAÍDA para o
 * painel, e as requisições à NBI descem por essa conexão
 * (`services/genieacs/agent.js`). É o caso do GenieACS sem IP público.
 */
export const CONNECTION_MODES = Object.freeze(['direct', 'tunnel', 'agent']);

/**
 * Quem administra o ACS na SaaS: `platform` (o console) ou `own` (o provedor,
 * com o servidor dele). Na self-hosted não faz diferença: lá é tudo do provedor.
 */
export const GENIEACS_OWNERSHIPS = Object.freeze(['platform', 'own']);

const DEFAULT_MODE = 'direct';
const DEFAULT_OWNERSHIP = 'platform';

/** Teto de `agent_version`, que é a largura da coluna. */
const AGENT_VERSION_MAX = 32;

// Toda requisição ao ACS pergunta o modo; 30 s de cache tiram essa leitura do
// caminho quente, e gravar apaga o cache do provedor na hora.
const cache = new TenantCache(30_000);

/**
 * A versão que o agente disse ter, pronta para a coluna e para a tela.
 *
 * O texto vem de fora — do programa na máquina do provedor, ou de quem quer
 * que tenha a chave —, então só passa o que uma versão tem: letras, dígitos,
 * `.`, `-`, `+` e `_`, cortado na largura da coluna. Vazio vira nulo.
 */
export function sanitizeAgentVersion(raw) {
  const limpo = String(raw ?? '').replace(/[^0-9A-Za-z.+_-]/g, '').slice(0, AGENT_VERSION_MAX);
  return limpo || null;
}

/**
 * Como o painel chega ao GenieACS do provedor em escopo, e quem o administra
 * (`tenant_genieacs_connections`). Sem linha, `direct` e `platform`.
 */
class GenieAcsConnection {
  static async #row() {
    const guardado = cache.get();
    if (guardado) return guardado;
    const row = await tdb('tenant_genieacs_connections').first('mode', 'ownership');
    const valor = {
      mode: CONNECTION_MODES.includes(row?.mode) ? row.mode : DEFAULT_MODE,
      ownership: GENIEACS_OWNERSHIPS.includes(row?.ownership) ? row.ownership : DEFAULT_OWNERSHIP
    };
    cache.set(valor);
    return valor;
  }

  static async #upsert(patch) {
    const existe = await tdb('tenant_genieacs_connections').first('id');
    if (existe) {
      await tdb('tenant_genieacs_connections').update({ ...patch, updated_at: new Date() });
    } else {
      await tinsert('tenant_genieacs_connections', patch);
    }
    cache.invalidate();
  }

  static async mode() {
    return (await GenieAcsConnection.#row()).mode;
  }

  static async ownership() {
    return (await GenieAcsConnection.#row()).ownership;
  }

  static async setMode(mode) {
    if (!CONNECTION_MODES.includes(mode)) throw new Error(`Unknown GenieACS connection mode: ${mode}`);
    await GenieAcsConnection.#upsert({ mode });
  }

  static async setOwnership(ownership) {
    if (!GENIEACS_OWNERSHIPS.includes(ownership)) throw new Error(`Unknown GenieACS ownership: ${ownership}`);
    await GenieAcsConnection.#upsert({ ownership });
  }

  /**
   * O que se sabe do agente do provedor em escopo, sem o digest da chave:
   * `{ tokenHint, tokenCreatedAt, lastSeenAt, version }`. Se ele está
   * conectado AGORA não mora no banco — é do hub, e quem monta o `AgentStatus`
   * da tela é `agentStatus()` em `services/genieacs/agent.js`.
   */
  static async agentInfo() {
    const row = await tdb('tenant_genieacs_connections')
      .first('agent_token_hint', 'agent_token_created_at', 'agent_last_seen_at', 'agent_version');
    return {
      tokenHint: row?.agent_token_hint ?? null,
      tokenCreatedAt: row?.agent_token_created_at ?? null,
      lastSeenAt: row?.agent_last_seen_at ?? null,
      version: row?.agent_version ?? null
    };
  }

  /** Troca a chave do agente do provedor em escopo: o digest novo substitui o velho. */
  static async setAgentToken(hash, hint) {
    await GenieAcsConnection.#upsert({
      agent_token_hash: hash,
      agent_token_hint: hint,
      agent_token_created_at: new Date()
    });
  }

  /**
   * A conexão dona de um digest de chave: `{ tenantId, mode, hash }` ou nulo.
   *
   * tenant-scope-exempt: é por esta busca que a conexão do agente DESCOBRE o
   * provedor — o upgrade do WebSocket chega sem sessão e sem host que valha
   * (o provedor sai da CHAVE, nunca do host). Escopá-la seria já saber a
   * resposta. O digest é único na tabela, então a busca acha uma linha ou
   * nenhuma.
   *
   * `runUnscoped` diz o mesmo à sentinela de SQL, que lê o SQL e não este
   * comentário; declarar aqui mantém a exceção do tamanho de uma busca.
   */
  static async findByAgentTokenHash(hash) {
    return runUnscoped(
      'the GenieACS agent connects with no session; its token is what names the provider',
      async () => {
        // tenant-scope-exempt: a chave nomeia o provedor — ver acima.
        const row = await getDb()('tenant_genieacs_connections')
          .where({ agent_token_hash: String(hash) })
          .first('tenant_id', 'mode', 'agent_token_hash');
        return row ? { tenantId: row.tenant_id, mode: row.mode, hash: row.agent_token_hash } : null;
      }
    );
  }

  /**
   * Marca que o agente do provedor `tenantId` foi visto agora (e, com
   * `version`, que versão ele disse ter). Chamado pelo hub, fora de
   * requisição, por isso abre o escopo do provedor ele mesmo.
   */
  static async touchAgent(tenantId, { version } = {}) {
    const patch = { agent_last_seen_at: new Date() };
    if (version !== undefined) patch.agent_version = sanitizeAgentVersion(version);
    await runInTenant(tenantId, () => tdb('tenant_genieacs_connections').update(patch));
  }

  /** Para os testes. */
  static clearCache() {
    cache.clear();
  }
}

export default GenieAcsConnection;
