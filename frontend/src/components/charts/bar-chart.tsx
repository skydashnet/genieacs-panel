interface BarChartData {
  name: string
  value: number
}

export function BarChart({ data, valueLabel = 'Devices' }: { data: BarChartData[]; valueLabel?: string }) {
  const max = Math.max(...data.map((item) => item.value), 1)

  return (
    <div className="flex flex-col sm:min-h-[250px] justify-center gap-3 py-2" role="img" aria-label={`${valueLabel} by category`}>
      {data.map((item) => (
        // No celular o nome vai numa linha própria, acima da barra: na coluna
        // estreita ao lado ele virava "ZTE Corpo…".
        <div key={item.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 sm:grid-cols-[minmax(5.5rem,0.45fr)_minmax(8rem,1fr)_2.5rem] sm:gap-3">
          <span className="col-span-2 truncate text-xs font-semibold text-muted-foreground sm:col-span-1 sm:text-end" title={item.name}>{item.name}</span>
          <div className="h-5 overflow-hidden rounded-sm bg-muted">
            <div className="h-full min-w-1 rounded-sm bg-primary transition-[width] duration-300"
              style={{ width: `${Math.max((item.value / max) * 100, item.value ? 2 : 0)}%` }}
              title={`${item.name}: ${item.value} ${valueLabel}`} />
          </div>
          <span className="font-mono text-xs font-semibold text-foreground">{item.value}</span>
        </div>
      ))}
    </div>
  )
}
