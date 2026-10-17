/**
 * Um tempo de espera em segundos, do jeito que se lê num relatório:
 * "45 s", "4 min", "1 h 12 min", "2 d 3 h". Os rótulos vêm da tradução, para
 * a unidade sair no idioma de quem olha.
 */
export interface DurationLabels {
  seconds: (n: number) => string
  minutes: (n: number) => string
  hours: (h: number, m: number) => string
  days: (d: number, h: number) => string
}

export function formatDuration(seconds: number | null | undefined, labels: DurationLabels): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return labels.seconds(s)
  const min = Math.round(s / 60)
  if (min < 60) return labels.minutes(min)
  const totalMin = Math.round(s / 60)
  const h = Math.floor(totalMin / 60)
  if (h < 24) return labels.hours(h, totalMin % 60)
  return labels.days(Math.floor(h / 24), h % 24)
}
