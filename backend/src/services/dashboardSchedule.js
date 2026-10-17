import AppState from '../models/AppState.js';
import { currentTenantId } from '../config/tenantContext.js';

/**
 * Quando o painel de cada provedor é atualizado, e quando não é.
 *
 * `getDashboardDevices()` busca a **coleção inteira** de dispositivos do
 * GenieACS. Num provedor com 20 mil ONTs isso é um parse de vários MB; a cada
 * minuto, vezes dezenas de provedores, um processo Node não sustenta. O teto de
 * concorrência já impede que isso derrube o painel, mas teto é fila: ele faz o
 * excesso esperar, não deixa de existir.
 *
 * Este arquivo é sobre o excesso não existir, e são três decisões:
 *
 * 1. **Quem não está sendo usado não é atualizado.** Um provedor sem ninguém
 *    logado há 24h não tem quem olhe o painel; buscar a frota dele de minuto em
 *    minuto é gastar o ACS *dele* para atualizar uma tela que ninguém abriu.
 * 2. **A cadência segue a atenção.** Com operador ativo, 60s — que é o que faz
 *    o painel parecer vivo. Ocioso, 5 minutos. A diferença não é economia de
 *    servidor: é que o custo cai onde ninguém percebe a queda.
 * 3. **Nem todos ao mesmo tempo.** Sem defasagem, os provedores devidos caem
 *    todos na mesma virada de minuto — que é exatamente o pico que o teto de
 *    concorrência depois enfileira. A defasagem é derivada do id, então é
 *    estável entre reinícios e não precisa ser guardada.
 *
 * O que NÃO está aqui, de propósito: provedor suspenso. `forEachTenant` já
 * visita só quem está `active`, então uma checagem aqui seria uma segunda regra
 * dizendo a mesma coisa — e duas regras que dizem a mesma coisa é uma que vai
 * ficar para trás.
 */

/** A última vez que alguém entrou no painel deste provedor. */
const ACTIVITY_KEY = 'panel_last_activity_at';

/** Com operador por perto. */
export const ACTIVE_TTL_MS = 60_000;

/** Sem ninguém olhando, mas ainda dentro das 24h. */
export const IDLE_TTL_MS = 5 * 60_000;

/**
 * Quanto tempo depois de um login o provedor ainda conta como "em uso".
 *
 * Uma hora porque é o prazo do access token: um operador que continua no painel
 * renova pelo menos de hora em hora, e é essa renovação que remarca a atividade.
 * Menos que isso faria a cadência rápida cair no meio do expediente de quem não
 * clicou em nada por vinte minutos.
 */
export const ACTIVE_WINDOW_MS = 3600_000;

/** Sem ninguém desde ontem, o painel para de ser atualizado. */
export const IDLE_CUTOFF_MS = 24 * 3600_000;

/**
 * Só grava se a marca andou isto. Sem a folga, cada renovação de token viraria
 * um UPDATE, e a renovação é de hora em hora por operador — barato, mas é
 * escrita no caminho do login por nada.
 */
const WRITE_THROTTLE_MS = 5 * 60_000;

/** Última gravação por provedor, para a folga acima. Memória basta: perder isto num reinício custa uma escrita. */
const ultimaGravacao = new Map();

/**
 * Marca que alguém entrou no painel deste provedor.
 *
 * Chamado do login e da renovação de token — os dois pontos em que se sabe que
 * há gente do outro lado. Nunca lança: registrar atenção não pode ser o motivo
 * de um login falhar.
 */
export async function recordPanelActivity(agora = Date.now()) {
  try {
    const id = currentTenantId();
    const anterior = ultimaGravacao.get(id) ?? 0;
    if (agora - anterior < WRITE_THROTTLE_MS) return false;
    ultimaGravacao.set(id, agora);
    await AppState.upsert(ACTIVITY_KEY, new Date(agora).toISOString());
    return true;
  } catch (error) {
    console.warn(`Could not record panel activity: ${error.message}`);
    return false;
  }
}

/** Para os testes: esquece a folga de escrita. */
export function forgetActivityThrottle() {
  ultimaGravacao.clear();
}

/** A marca de atividade do provedor em escopo, em milissegundos, ou `null`. */
export async function lastPanelActivityAt() {
  const bruto = await AppState.get(ACTIVITY_KEY);
  if (!bruto) return null;
  const quando = Date.parse(bruto);
  return Number.isFinite(quando) ? quando : null;
}

/**
 * A defasagem deste provedor dentro da janela, derivada do id.
 *
 * FNV-1a: pequeno, sem dependência, e espalha ids consecutivos — que é o caso
 * real, porque provedores são criados em sequência. Um `id % n` cru colocaria
 * 1, 2 e 3 em fatias vizinhas de um jeito que depende do tamanho da janela.
 */
export function tenantOffsetMs(tenantId, janelaMs) {
  let h = 0x811c9dc5;
  for (const ch of String(tenantId)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return janelaMs > 0 ? h % janelaMs : 0;
}

/** A cadência que a atenção do provedor pede. */
export function refreshTtlMs(atividadeEm, agora = Date.now()) {
  if (atividadeEm === null || atividadeEm === undefined) return IDLE_TTL_MS;
  return agora - atividadeEm <= ACTIVE_WINDOW_MS ? ACTIVE_TTL_MS : IDLE_TTL_MS;
}

/** Ninguém entrou nas últimas 24h: não há painel para manter quente. */
export function isDormant(atividadeEm, agora = Date.now()) {
  if (atividadeEm === null || atividadeEm === undefined) return true;
  return agora - atividadeEm > IDLE_CUTOFF_MS;
}

/**
 * Se este provedor deve ser atualizado agora.
 *
 * A conta é de **janela**, e não de "passou o tempo desde a última vez", e a
 * diferença é a defasagem existir de verdade. Com o prazo simples, um provedor
 * que atrasou dez segundos numa rodada carrega esse atraso para sempre e todos
 * acabam convergindo para a mesma virada — que é o pico que a defasagem existe
 * para evitar. Fatiando o tempo em janelas com fase própria, cada provedor tem
 * a sua borda, e um atraso não move a borda seguinte.
 *
 * A consequência para quem escreve teste: a borda é do RELÓGIO, não do intervalo
 * entre as chamadas. Duas rodadas coladas caem na mesma janela quase sempre, e
 * o "quase" é uma reprovação a cada ~(intervalo/janela) execuções. Um teste que
 * afirme "a segunda rodada não devia nem tentar" precisa parar o relógio —
 * `mock.timers.enable({ apis: ['Date'], now: Date.now() })` — em vez de contar
 * com a sorte.
 */
export function dueForRefresh({ lastRunAt, ttlMs, offsetMs, now = Date.now() }) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return true;
  const janela = (instante) => Math.floor((instante - offsetMs) / ttlMs);
  if (!Number.isFinite(lastRunAt)) return true;
  return janela(now) > janela(lastRunAt);
}
