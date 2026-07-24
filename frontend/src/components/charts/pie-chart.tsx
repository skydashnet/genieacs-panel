'use client'
import { PieChart as RechartsPieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts'
import { useTheme } from '@/contexts/theme-context'

interface PieChartData {
  name: string
  value: number
  color: string
}

export const PieChart = ({ data }: { data: PieChartData[] }) => {
  const { isDarkMode } = useTheme() || { isDarkMode: false }

  return (
    <ResponsiveContainer width="100%" height={250}>
      <RechartsPieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius={43}
          outerRadius={78}
          paddingAngle={2}
          stroke="none"
        >
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip
          formatter={(value) => [value, 'Devices']}
          contentStyle={{
            backgroundColor: isDarkMode ? 'rgb(31 41 55)' : '#fff',
            borderColor: isDarkMode ? '#34413b' : '#cbd2cc',
            borderRadius: '0.375rem',
          }}
        />
        <Legend
          iconType="circle"
          wrapperStyle={{ fontSize: '14px' }}
        />
      </RechartsPieChart>
    </ResponsiveContainer>
  )
}
