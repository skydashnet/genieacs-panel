'use client'
import { BarChart as RechartsBarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useTheme } from '@/contexts/theme-context'

interface BarChartData {
  name: string
  value: number
}

export const BarChart = ({ data }: { data: BarChartData[] }) => {
  const { isDarkMode } = useTheme() || { isDarkMode: false }
  const textColor = isDarkMode ? '#aebbb4' : '#5e6c65'

  return (
    <ResponsiveContainer width="100%" height={250}>
      <RechartsBarChart
        data={data}
        layout="vertical"
        margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
      >
        <CartesianGrid horizontal={true} vertical={false} stroke={isDarkMode ? '#34413b' : '#d8ddd8'} />
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
            borderColor: isDarkMode ? '#34413b' : '#cbd2cc',
            borderRadius: '0.375rem',
          }}
        />
        <Bar dataKey="value" fill={isDarkMode ? '#72b69b' : '#25644f'} radius={[0, 3, 3, 0]} />
      </RechartsBarChart>
    </ResponsiveContainer>
  )
}
