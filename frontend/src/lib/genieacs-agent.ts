/**
 * As decisões da tela do agente do GenieACS, sem tela nenhuma.
 *
 * O agente é o programa que o provedor instala numa máquina da própria rede:
 * ele abre a conexão ATÉ o painel e fica esperando pedidos, e por isso o
 * GenieACS dele pode morar numa rede sem IP público, sem porta aberta. A tela
 * que cuida disso existe em dois lugares — o console da plataforma e as
 * Configurações do provedor — e as duas têm que chegar às mesmas respostas:
 * em que estado o agente está, qual botão aparece, que frase o erro mostra.
 *
 * Módulo próprio pelo motivo de sempre: o vitest roda em `node`, sem jsdom, e
 * função pura aqui é a forma de a decisão ter teste. Sem importar nada de
 * `@/lib/api` nem de i18n: o que entra são dados, o que sai são decisões (e
 * chaves de tradução como texto), e quem traduz é quem desenha.
 */

/** Como o painel chega ao GenieACS de um provedor. Espelha `GenieAcsConnectionMode` do `api.ts`. */
export type AgentConnectionMode = 'direct' | 'tunnel' | 'agent'

/**
 * O que o servidor conta do agente — o `AgentStatus` do contrato.
 *
 * `tokenHint` são os quatro últimos caracteres da chave: o bastante para o
 * operador conferir QUAL chave está no arquivo de ambiente da máquina, e pouco
 * demais para servir de chave. A chave inteira só existe na resposta da geração.
 */
export interface AgentStatusShape {
  tokenHint: string | null
  tokenCreatedAt: string | null
  connected: boolean
  connectedAt: string | null
  lastSeenAt: string | null
  version: string | null
}

/**
 * O "conectado desde" da tela: só `connectedAt`, que o servidor marca quando a
 * conexão abre. Nunca `lastSeenAt` — ele anda a cada batimento, e "conectado
 * desde há 1 minuto" seria dito de um agente ligado há semanas.
 */
export function connectedSince(status: AgentStatusShape): string | null {
  return status.connected && validDate(status.connectedAt) ? status.connectedAt : null
}

/**
 * Em que pé o agente está, na ordem em que a pessoa precisa saber:
 *
 * - `connected`: há uma conexão aberta agora. Ganha de tudo — se o servidor diz
 *   que está conectado, a conexão existe, e é isso que decide se os pedidos
 *   passam;
 * - `no-key`: nenhuma chave gerada. Não há o que instalar ainda, e dizer
 *   "nunca conectou" aqui mandaria procurar defeito numa máquina que nem
 *   poderia conectar;
 * - `disconnected`: já conectou alguma vez (há `lastSeenAt`) e caiu;
 * - `never`: tem chave, nunca conectou — o caso de quem gerou a chave e ainda
 *   não rodou o instalador.
 *
 * Uma data que não é data conta como ausente: "desconectado há NaN" é pior que
 * "nunca conectou", e o segundo manda a pessoa ao lugar certo (a máquina).
 */
export type AgentPhase = 'connected' | 'disconnected' | 'never' | 'no-key'

export function agentPhase(status: AgentStatusShape | null | undefined): AgentPhase {
  if (!status) return 'no-key'
  if (status.connected) return 'connected'
  if (!status.tokenHint) return 'no-key'
  return validDate(status.lastSeenAt) ? 'disconnected' : 'never'
}

/**
 * O que o botão da chave faz. `regenerate` pede confirmação, porque gerar
 * outra derruba o agente que está rodando com a atual (fechamento 4001) — e
 * ele só volta quando alguém levar a chave nova até a máquina.
 */
export type KeyAction = 'generate' | 'regenerate'

export function keyAction(status: AgentStatusShape | null | undefined): KeyAction {
  return status?.tokenHint ? 'regenerate' : 'generate'
}

/**
 * A origem do painel sem a barra do fim. `window.location.origin` já vem sem
 * ela, mas uma `VITE_API_URL` ou um endereço colado podem trazer — e
 * `https://painel//api/...` é um 404 que ninguém enxerga no comando.
 */
function semBarraFinal(origin: string): string {
  return origin.trim().replace(/\/+$/, '')
}

/**
 * O comando que instala o agente na máquina do provedor.
 *
 * SEM a chave, de propósito: o instalador a pede na hora. Uma chave colada no
 * comando vai para o histórico do shell (`~/.bash_history`) e para a lista de
 * processos enquanto roda — e é justamente a credencial que abre caminho até o
 * GenieACS do provedor.
 */
export function installCommand(origin: string): string {
  return `curl -fsSL ${semBarraFinal(origin)}/api/genieacs-agent/install.sh | sudo bash`
}

/** O arquivo do agente sozinho, para quem prefere instalar à mão. */
export function agentFileUrl(origin: string): string {
  return `${semBarraFinal(origin)}/api/genieacs-agent/agent.mjs`
}

/**
 * A frase do erro `acs_agent_offline` (o 503 das rotas que falam com o
 * GenieACS quando o agente do provedor não está conectado).
 *
 * Duas frases e não uma com "{when}" opcional: "desconectado — última conexão
 * nunca" não é português, e "nunca se conectou" diz outra coisa — que o
 * problema é a instalação, não a queda.
 */
export type OfflineMessageKey = 'api.acsAgentOffline' | 'api.acsAgentNeverConnected'

export function offlineMessageKey(lastSeenAt: string | null | undefined): OfflineMessageKey {
  return validDate(lastSeenAt) ? 'api.acsAgentOffline' : 'api.acsAgentNeverConnected'
}

/**
 * Os modos que o seletor oferece, ou `[]` quando o modo é só leitura.
 *
 * - No console, os três: é lá que a plataforma escolhe, inclusive o túnel.
 * - Nas Configurações do provedor com `modeEditable` (instalação própria),
 *   Direto ou Agente. O túnel fica de fora porque existe para a SaaS abrir a
 *   rede privada a UM provedor; na instalação própria a rede privada já é
 *   permitida, e o servidor recusa `tunnel` ali com 400.
 * - Sem `modeEditable` (SaaS), nenhum: quem escolhe é a plataforma, e a tela
 *   mostra o modo como texto.
 *
 * Se o modo gravado não está entre as opções (um `tunnel` antigo numa
 * instalação própria), ele entra no fim: um `<select>` cujo valor não é uma das
 * opções mostra a PRIMEIRA, e a tela diria "Direto" para um provedor que não
 * está em direto.
 */
export type ModeSurface = 'console' | 'settings'

export function modeOptions(
  surface: ModeSurface,
  modeEditable: boolean,
  current: AgentConnectionMode
): AgentConnectionMode[] {
  if (surface === 'console') return ['direct', 'tunnel', 'agent']
  if (!modeEditable) return []
  const base: AgentConnectionMode[] = ['direct', 'agent']
  return base.includes(current) ? base : [...base, current]
}

/**
 * Se o botão de gerar chave aparece, e se está liberado.
 *
 * - Quem não pode gravar o GenieACS não vê o botão: gerar a chave desconecta o
 *   agente em produção.
 * - O modo que vale é o GRAVADO, não o do seletor: a rota das Configurações
 *   recusa com 409 `mode_not_agent` enquanto o modo salvo não é `agent`, e uma
 *   chave gerada para um provedor que continua em Direto não serviria para
 *   nada. Com o seletor em Agente e nada salvo, o botão aparece desligado com a
 *   dica "salve primeiro" — esconder o botão deixaria a pessoa procurando.
 */
export type KeyButtonState = 'hidden' | 'save-first' | 'enabled'

export function keyButtonState(opts: { canWrite: boolean; savedMode: AgentConnectionMode }): KeyButtonState {
  if (!opts.canWrite) return 'hidden'
  return opts.savedMode === 'agent' ? 'enabled' : 'save-first'
}

/** O passo da leitura do estado: 15 s, como pedido para a tela. */
export const AGENT_POLL_MS = 15_000
/** O recuo para de dobrar aqui: 2^4 − 1 = 15 passos, ~4 minutos. */
export const AGENT_POLL_BACKOFF_CAP = 4

/**
 * Quanto esperar, depois de `failures` leituras seguidas que falharam, antes da
 * próxima. Zero falhas é zero espera — o relógio de 15 s já é o passo.
 *
 * O mesmo desenho da tira de saúde do WhatsApp: exponencial com teto, porque um
 * servidor que caiu não precisa de uma aba esquecida aberta batendo nele a
 * cada 15 s, e porque a tela deixada aberta por horas é o caso normal aqui — o
 * operador fica olhando o estado enquanto instala o agente na outra máquina.
 */
export function pollBackoffMs(failures: number): number {
  if (!Number.isFinite(failures) || failures <= 0) return 0
  return (2 ** Math.min(Math.floor(failures), AGENT_POLL_BACKOFF_CAP) - 1) * AGENT_POLL_MS
}

function validDate(value: string | null | undefined): value is string {
  if (!value) return false
  return !Number.isNaN(new Date(value).getTime())
}
