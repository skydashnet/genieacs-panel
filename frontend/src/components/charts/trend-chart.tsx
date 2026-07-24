'use client'

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useTheme } from '@/contexts/theme-context'

interface TrendPoint {
  name: string
  value: number
}

export function TrendChart({ data, valueLabel = 'Devices' }: { data: TrendPoint[]; valueLabel?: string }) {
  const { isDarkMode } = useTheme()
  const textColor = isDarkMode ? '#aebbb4' : '#5e6c65'
  const tooltipText = isDarkMode ? '#f4f3ed' : '#17211c'

  return (
    <ResponsiveContainer width="100%" height={250}>
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -20 }}>
        <defs>
          <linearGradient id="dashboardTrend" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#4a9a7c" stopOpacity={0.42} />
            <stop offset="95%" stopColor="#4a9a7c" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke={isDarkMode ? '#34413b' : '#d8ddd8'} />
        <XAxis dataKey="name" stroke={textColor} tick={{ fontSize: 12 }} />
        <YAxis allowDecimals={false} stroke={textColor} tick={{ fontSize: 12 }} />
        <Tooltip
          formatter={(value) => [value, valueLabel]}
          contentStyle={{
            backgroundColor: isDarkMode ? 'rgb(31 41 55)' : '#fff',
            borderColor: isDarkMode ? '#34413b' : '#cbd2cc',
            borderRadius: '0.375rem',
            color: tooltipText,
          }}
          labelStyle={{ color: tooltipText }}
          itemStyle={{ color: tooltipText }}
        />
        <Area type="monotone" dataKey="value" stroke="#4a9a7c" strokeWidth={2.5} fill="url(#dashboardTrend)" />
      </AreaChart>
    </ResponsiveContainer>
  )
}
