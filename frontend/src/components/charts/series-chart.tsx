import { useId, useMemo, useState } from 'react'
import { useChartWidth } from './use-chart-width'

export interface SeriesPoint {
  /** Seconds since the epoch, as the history endpoint returns them. */
  t: number
  value: number | null
}

interface SeriesChartProps {
  points: SeriesPoint[]
  /** Formats a point for the tooltip, e.g. `-22.4 dBm`. */
  formatValue: (value: number) => string
  formatTime: (epochSeconds: number) => string
  /** Drawn as a dashed rule, e.g. the RX power the alerter fires at. */
  threshold?: number | null
  thresholdLabel?: string
  emptyLabel: string
  ariaLabel: string
}

/**
 * A time series drawn as inline SVG, in the idiom of `trend-chart.tsx`.
 *
 * It is a separate component rather than a widened `TrendChart` for two
 * reasons that both matter here. `TrendChart` anchors its Y axis at zero,
 * which is right for a count and useless for optical power: RX runs around
 * -22 dBm, so anchored at zero the whole fleet is a flat line on the floor of
 * the chart. And it draws one `<circle>` with a `<title>` per point, which is
 * fine for a week of daily counts and is 700 DOM nodes for a day of samples.
 */
export function SeriesChart({
  points,
  formatValue,
  formatTime,
  threshold = null,
  thresholdLabel,
  emptyLabel,
  ariaLabel
}: SeriesChartProps) {
  // `trend-chart.tsx` hard-codes its gradient id, so two charts on one page
  // would collide and the second would paint with the first's fill.
  const gradientId = useId()
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  // Como no `TrendChart`: abaixo de 640px desenha na largura real, para o
  // texto do eixo não encolher junto com o `viewBox`.
  const [containerRef, measured] = useChartWidth<HTMLDivElement>(640)
  const width = Math.min(measured, 640)
  const height = 220
  const left = 44
  const right = 16
  const top = 16
  const bottom = 28
  const chartWidth = width - left - right
  const chartHeight = height - top - bottom

  const geometry = useMemo(() => {
    const readable = points.filter((point) => point.value !== null)
    if (readable.length === 0) return null

    const values = readable.map((point) => point.value as number)
    const rawMin = Math.min(...values, ...(threshold === null ? [] : [threshold]))
    const rawMax = Math.max(...values, ...(threshold === null ? [] : [threshold]))
    // A flat series would divide by zero; give it a band to sit in the middle of.
    const pad = rawMax - rawMin < 1 ? 1 : (rawMax - rawMin) * 0.12
    const min = rawMin - pad
    const max = rawMax + pad

    const firstT = points[0].t
    const lastT = points[points.length - 1].t
    const span = Math.max(lastT - firstT, 1)

    const x = (t: number) => left + ((t - firstT) / span) * chartWidth
    const y = (value: number) => top + chartHeight - ((value - min) / (max - min)) * chartHeight

    const placed = points.map((point) => ({
      ...point,
      x: x(point.t),
      y: point.value === null ? null : y(point.value)
    }))

    // A gap wider than three times the typical step is the device not
    // informing, so the line is broken there rather than drawn straight
    // across an outage as though nothing happened.
    const steps = points.slice(1).map((point, index) => point.t - points[index].t)
    const sorted = [...steps].sort((a, b) => a - b)
    const medianStep = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
    const gapLimit = medianStep > 0 ? medianStep * 3 : Number.POSITIVE_INFINITY

    const segments: { x: number; y: number }[][] = []
    let current: { x: number; y: number }[] = []
    placed.forEach((point, index) => {
      const previous = index > 0 ? points[index - 1] : null
      const broken = previous !== null && point.t - previous.t > gapLimit
      if (point.y === null || broken) {
        if (current.length > 1) segments.push(current)
        current = []
      }
      if (point.y !== null) current.push({ x: point.x, y: point.y })
    })
    if (current.length > 1) segments.push(current)

    return { placed, segments, min, max, y }
  }, [points, threshold, chartHeight, chartWidth])

  if (!geometry) {
    return (
      <div ref={containerRef} className="flex min-h-[220px] items-center justify-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    )
  }

  const { placed, segments, min, max, y } = geometry
  const hovered = hoverIndex === null ? null : placed[hoverIndex]

  const resolveHover = (clientX: number, target: SVGSVGElement) => {
    const box = target.getBoundingClientRect()
    const ratio = (clientX - box.left) / box.width
    const svgX = ratio * width
    let nearest = 0
    let best = Number.POSITIVE_INFINITY
    placed.forEach((point, index) => {
      const distance = Math.abs(point.x - svgX)
      if (distance < best) {
        best = distance
        nearest = index
      }
    })
    setHoverIndex(nearest)
  }

  return (
    <div ref={containerRef} className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        // Abaixo de 640px não sobra margem no `viewBox` e o "-27.8 dBm" do eixo
        // perdia o sinal: o rótulo pode passar da borda, para dentro do padding.
        className="h-[240px] w-full overflow-visible"
        role="img"
        aria-label={ariaLabel}
        onPointerMove={(event) => resolveHover(event.clientX, event.currentTarget)}
        onPointerDown={(event) => resolveHover(event.clientX, event.currentTarget)}
        onPointerLeave={(event) => { if (event.pointerType === 'mouse') setHoverIndex(null) }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity=".28" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
          <g key={ratio}>
            <line
              x1={left}
              x2={width - right}
              y1={top + chartHeight * ratio}
              y2={top + chartHeight * ratio}
              stroke="hsl(var(--border))"
              strokeWidth="1"
            />
            <text
              x={left - 8}
              y={top + chartHeight * ratio + 4}
              textAnchor="end"
              className="fill-muted-foreground text-[10px]"
            >
              {formatValue(max - (max - min) * ratio)}
            </text>
          </g>
        ))}

        {threshold !== null && (
          <line
            x1={left}
            x2={width - right}
            y1={y(threshold)}
            y2={y(threshold)}
            stroke="hsl(var(--destructive))"
            strokeWidth="1.5"
            strokeDasharray="6 4"
          >
            <title>{thresholdLabel}</title>
          </line>
        )}

        {segments.map((segment, index) => (
          <g key={`${segment[0].x}-${index}`}>
            <path
              d={`M ${segment[0].x} ${top + chartHeight} L ${segment.map((p) => `${p.x} ${p.y}`).join(' L ')} L ${segment[segment.length - 1].x} ${top + chartHeight} Z`}
              fill={`url(#${gradientId})`}
            />
            <polyline
              points={segment.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke="hsl(var(--primary))"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>
        ))}

        {hovered && hovered.y !== null && (
          <g>
            <line
              x1={hovered.x}
              x2={hovered.x}
              y1={top}
              y2={top + chartHeight}
              stroke="hsl(var(--muted-foreground))"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <circle
              cx={hovered.x}
              cy={hovered.y}
              r="4"
              fill="hsl(var(--card))"
              stroke="hsl(var(--primary))"
              strokeWidth="2"
            />
          </g>
        )}
      </svg>

      <p className="mt-1 min-h-5 text-center text-xs text-muted-foreground">
        {hovered && hovered.value !== null
          ? `${formatTime(hovered.t)} · ${formatValue(hovered.value)}`
          : ''}
      </p>
    </div>
  )
}

export default SeriesChart
