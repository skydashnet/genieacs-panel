interface TrendPoint {
  name: string
  value: number
}

export function TrendChart({ data, valueLabel = 'Devices' }: { data: TrendPoint[]; valueLabel?: string }) {
  const width = 640
  const height = 210
  const left = 24
  const right = 18
  const top = 18
  const bottom = 34
  const chartWidth = width - left - right
  const chartHeight = height - top - bottom
  const max = Math.max(...data.map((item) => item.value), 1)
  const points = data.map((item, index) => {
    const x = left + (data.length <= 1 ? chartWidth / 2 : (index / (data.length - 1)) * chartWidth)
    const y = top + chartHeight - (item.value / max) * chartHeight
    return { ...item, x, y }
  })
  const line = points.map((point) => `${point.x},${point.y}`).join(' ')
  const area = points.length
    ? `M ${points[0].x} ${top + chartHeight} L ${line.replaceAll(' ', ' L ')} L ${points.at(-1)?.x} ${top + chartHeight} Z`
    : ''

  return (
    <div className="min-h-[250px] w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[250px] w-full overflow-visible" role="img" aria-label={`${valueLabel} trend`}>
        <defs>
          <linearGradient id="nativeDashboardTrend" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity=".36" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity=".02" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((ratio) => (
          <line key={ratio} x1={left} x2={width - right} y1={top + chartHeight * ratio} y2={top + chartHeight * ratio}
            stroke="hsl(var(--border))" strokeWidth="1" />
        ))}
        {area && <path d={area} fill="url(#nativeDashboardTrend)" />}
        {line && <polyline points={line} fill="none" stroke="hsl(var(--primary))" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />}
        {points.map((point) => (
          <g key={point.name}>
            <circle cx={point.x} cy={point.y} r="5" fill="hsl(var(--card))" stroke="hsl(var(--primary))" strokeWidth="3" tabIndex={0}>
              <title>{point.name}: {point.value} {valueLabel}</title>
            </circle>
            <text x={point.x} y={height - 9} textAnchor="middle" fill="hsl(var(--muted-foreground))" fontSize="11">{point.name}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}
