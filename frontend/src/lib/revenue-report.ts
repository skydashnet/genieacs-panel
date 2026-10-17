/**
 * As contas da aba Receita do console que não precisam de tela: o período
 * padrão, a validação do período (a mesma do servidor, para recusar antes de
 * perguntar), o rótulo do mês e a escala do gráfico.
 *
 * Datas em UTC, como no servidor (`revenueReportService.js`): o relatório é
 * da plataforma, e o mês de um pagamento não pode mudar com o fuso de quem
 * abre a tela.
 */

/** O teto do período, em meses — o mesmo `MAX_RANGE_MONTHS` do servidor. */
export const MAX_RANGE_MONTHS = 36

const ISO_DIA = /^(\d{4})-(\d{2})-(\d{2})$/

export interface RevenueRange {
  from: string
  to: string
}

/** `YYYY-MM-DD` em UTC. */
export function isoDayUtc(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Um `YYYY-MM-DD` que existe no calendário, como meia-noite UTC — ou nulo. */
export function parseIsoDay(value: string): number | null {
  const partes = ISO_DIA.exec(value.trim())
  if (!partes) return null
  const ms = Date.UTC(Number(partes[1]), Number(partes[2]) - 1, Number(partes[3]))
  return isoDayUtc(new Date(ms)) === value.trim() ? ms : null
}

/** Os últimos doze meses, contando o atual: o padrão do servidor. */
export function lastTwelveMonths(now: Date = new Date()): RevenueRange {
  const inicio = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1))
  return { from: isoDayUtc(inicio), to: isoDayUtc(now) }
}

/** De 1º de janeiro até hoje. */
export function yearToDate(now: Date = new Date()): RevenueRange {
  return { from: `${now.getUTCFullYear()}-01-01`, to: isoDayUtc(now) }
}

/** Quantos meses de calendário o período toca (as barras do gráfico). */
export function monthsSpanned(fromMs: number, toMs: number): number {
  const a = new Date(fromMs)
  const b = new Date(toMs)
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1
}

/**
 * O período, se o servidor vai aceitá-lo; senão, o código da recusa — os
 * mesmos códigos do 400 dele.
 */
export function validateRange(range: RevenueRange): 'invalid_date' | 'invalid_range' | 'range_too_long' | null {
  const de = parseIsoDay(range.from)
  const ate = parseIsoDay(range.to)
  if (de === null || ate === null) return 'invalid_date'
  if (de > ate) return 'invalid_range'
  if (monthsSpanned(de, ate) > MAX_RANGE_MONTHS) return 'range_too_long'
  return null
}

/** `2026-03` como o idioma da tela escreve: "mar. de 2026", "Mar 2026"… */
export function monthLabel(month: string, locale: string, style: 'short' | 'long' = 'short'): string {
  const partes = /^(\d{4})-(\d{2})$/.exec(month)
  if (!partes) return month
  const data = new Date(Date.UTC(Number(partes[1]), Number(partes[2]) - 1, 1))
  try {
    return new Intl.DateTimeFormat(locale, {
      month: style, year: style === 'short' ? '2-digit' : 'numeric', timeZone: 'UTC'
    }).format(data)
  } catch {
    return month
  }
}

/**
 * O topo do eixo do gráfico: o maior valor arredondado para cima num número
 * "redondo" (1, 2, 2,5 ou 5 vezes uma potência de dez), para que as linhas de
 * grade caiam em valores legíveis. Zero quando não há nada, e então o gráfico
 * desenha só a linha de base.
 */
export function niceCeiling(max: number): number {
  if (!(max > 0)) return 0
  const potencia = 10 ** Math.floor(Math.log10(max))
  for (const passo of [1, 2, 2.5, 5, 10]) {
    if (passo * potencia >= max) return passo * potencia
  }
  return 10 * potencia
}

/** Recebido menos estornado — o que de fato ficou. */
export function netCents(report: { receivedCents: number; refundedCents: number }): number {
  return report.receivedCents - report.refundedCents
}
