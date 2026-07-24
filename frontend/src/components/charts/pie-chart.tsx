import { useMemo, useState } from 'react'

interface PieChartData {
  name: string
  value: number
  color: string
}

const RADIUS = 70
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function PieChart({ data, valueLabel = 'Devices' }: { data: PieChartData[]; valueLabel?: string }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const total = useMemo(() => data.reduce((sum, item) => sum + item.value, 0), [data])
  const segments = useMemo(() =>
    data.map((item, index) => {
      const length = total > 0 ? (item.value / total) * CIRCUMFERENCE : 0
      const consumed = total > 0
        ? data.slice(0, index).reduce((sum, previous) => sum + (previous.value / total) * CIRCUMFERENCE, 0)
        : 0
      return { ...item, length, offset: -consumed }
    }), [data, total])
  const active = activeIndex === null ? null : data[activeIndex]

  return (
    <div className="grid min-h-[250px] items-center gap-4 sm:grid-cols-[minmax(180px,1fr)_minmax(140px,0.7fr)]">
      <div className="relative mx-auto size-[210px]">
        <svg viewBox="0 0 180 180" className="size-full -rotate-90" role="img" aria-label={`${valueLabel} distribution`}>
          <circle cx="90" cy="90" r={RADIUS} fill="none" stroke="hsl(var(--muted))" strokeWidth="30" />
          {segments.map((segment, index) => (
            <circle
              key={segment.name}
              cx="90"
              cy="90"
              r={RADIUS}
              fill="none"
              stroke={segment.color}
              strokeWidth={activeIndex === index ? 34 : 30}
              strokeDasharray={`${segment.length} ${Math.max(CIRCUMFERENCE - segment.length, 0)}`}
              strokeDashoffset={segment.offset}
              className="cursor-pointer transition-[stroke-width,opacity] duration-150"
              opacity={activeIndex === null || activeIndex === index ? 1 : 0.38}
              tabIndex={0}
              onFocus={() => setActiveIndex(index)}
              onBlur={() => setActiveIndex(null)}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseLeave={() => setActiveIndex(null)}
            >
              <title>{segment.name}: {segment.value} {valueLabel}</title>
            </circle>
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="font-mono text-2xl font-semibold text-foreground">{active?.value ?? total}</span>
          <span className="mt-1 max-w-24 text-[0.68rem] font-semibold text-muted-foreground">{active?.name ?? valueLabel}</span>
        </div>
      </div>
      <div className="flex flex-wrap justify-center gap-2 sm:flex-col sm:items-stretch">
        {data.map((item, index) => (
          <button key={item.name} type="button"
            onMouseEnter={() => setActiveIndex(index)} onMouseLeave={() => setActiveIndex(null)}
            onFocus={() => setActiveIndex(index)} onBlur={() => setActiveIndex(null)}
            className="flex min-h-9 items-center justify-between gap-3 rounded px-2 text-left text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
            <span className="flex min-w-0 items-center gap-2"><span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} /><span className="truncate">{item.name}</span></span>
            <span className="font-mono text-foreground">{item.value}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
