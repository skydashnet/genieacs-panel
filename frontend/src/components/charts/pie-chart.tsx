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
          outerRadius={80}
          fill="#8884d8"
        >
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip
          formatter={(value) => [value, 'Devices']}
          contentStyle={{
            backgroundColor: isDarkMode ? 'rgb(31 41 55)' : '#fff',
            borderColor: isDarkMode ? 'rgb(55 65 81)' : '#ddd',
            borderRadius: '0.5rem',
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