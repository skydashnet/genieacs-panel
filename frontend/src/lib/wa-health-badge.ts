/**
 * O que o sino de "Está funcionando?" mostra fechado.
 *
 * Os avisos moram num painel que só abre com um clique, então a bolinha do sino
 * é a única coisa que o operador vê sem pedir. Ela tem uma regra só: dizer o
 * pior tom que há lá dentro e quantos avisos merecem ser lidos.
 *
 * - vermelho ganha de amarelo: um número desconectado ao lado de nove falhas
 *   continua sendo o número desconectado;
 * - o que é calmo não entra na contagem nem acende a bolinha — "2 de 2 números
 *   conectados" é o painel dizendo que está tudo bem, e um sino que acende todo
 *   dia por isso ensina a parar de olhar para ele;
 * - não conseguir ler a saúde é vermelho: calar sobre isso seria exatamente a
 *   falsa calma que a tira existe para evitar.
 *
 * Módulo próprio pelo motivo de sempre: o vitest roda em `node`, sem jsdom, e
 * função pura aqui é a forma de a decisão ter teste.
 */
export type HealthTone = 'alarm' | 'warn' | 'calm'

export interface HealthBadge {
  /** A cor da bolinha; `calm` é sem bolinha. */
  tone: HealthTone
  /** Quantos avisos vermelhos e amarelos há no painel. */
  count: number
  /** A leitura falhou: a bolinha mostra "!" em vez de número. */
  unreadable: boolean
}

export function healthBadge(tones: readonly HealthTone[], failed: boolean): HealthBadge {
  if (failed) return { tone: 'alarm', count: 0, unreadable: true }
  const count = tones.filter((tone) => tone !== 'calm').length
  const tone: HealthTone = tones.includes('alarm') ? 'alarm' : tones.includes('warn') ? 'warn' : 'calm'
  return { tone, count, unreadable: false }
}
