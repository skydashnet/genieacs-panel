'use client'
import { BarChart as RechartsBarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { useTheme } from '@/contexts/theme-context'

interface BarChartData {
  name: string
  value: number
}

export const BarChart = ({ data }: { data: BarChartData[] }) => {
  const { isDarkMode } = useTheme() || { isDarkMode: false }
  const textColor = isDarkMode ? '#cbd5e1' : '#4b5563' // gray-300 / gray-600

  return (
    <ResponsiveContainer width="100%" height={250}>
      <RechartsBarChart 
        data={data} 
        layout="vertical"
        margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? '#374151' : '#e5e7eb'} />
        <XAxis type="number" stroke={textColor} />
        <YAxis 
          dataKey="name" 
          type="category" 
          width={100} 
          stroke={textColor} 
          tick={{ fontSize: 12 }} 
        />
        <Tooltip
          formatter={(value) => [value, 'Devices']}
          contentStyle={{
            backgroundColor: isDarkMode ? 'rgb(31 41 55)' : '#fff',
            borderColor: isDarkMode ? 'rgb(55 65 81)' : '#ddd',
            borderRadius: '0.5rem',
          }}
        />
        <Bar dataKey="value" fill="#3b82f6" />
      </RechartsBarChart>
    </ResponsiveContainer>
  )
}