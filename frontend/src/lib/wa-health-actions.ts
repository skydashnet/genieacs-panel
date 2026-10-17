/**
 * Quais ações de manutenção fazem sentido agora, dados os números da tira.
 *
 * Os dois botões ocupavam uma fileira inteira da página sem ter o que fazer na
 * situação mais comum: "Enviar de novo as que falharam" com zero falhas, e
 * "Apagar os antigos agora" com a retenção em "sem prazo" — e com prazo zero o
 * varredor do backend não apaga nada (`waMediaSweeper.retentionDays` devolve
 * 0). Botão que não pode fazer nada é ruído, e no topo de uma ferramenta de
 * trabalho é ruído que empurra a caixa de entrada para fora da tela.
 *
 * A permissão continua valendo POR CIMA disto, dentro de cada botão: aqui se
 * decide se há o que fazer, não quem pode.
 *
 * Módulo próprio pelo motivo de sempre: o vitest roda em `node`, sem jsdom, e
 * função pura aqui é a forma de a decisão ter teste.
 */
import type { WhatsAppHealth } from '@/lib/api'

export interface HealthActions {
  /** Há falha nas últimas 24 h para pôr de volta na fila. */
  requeue: boolean
  /** Há prazo de retenção e há arquivo que ele pode alcançar. */
  sweep: boolean
}

export function healthActions(
  health: Pick<WhatsAppHealth, 'outbox' | 'media' | 'retention'>
): HealthActions {
  return {
    requeue: health.outbox.failed24h > 0,
    sweep: health.retention.mediaDays > 0 && health.media.files > 0
  }
}
