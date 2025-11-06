import { useParams } from 'next/navigation'
import DeviceDetailClient from './device-detail-client'

// Generate static params for dynamic routes
export function generateStaticParams() {
  // Return empty array to make it fully dynamic
  return []
}

export default function DeviceDetail() {
  const params = useParams()
  const deviceId = params.id as string

  return <DeviceDetailClient deviceId={deviceId} />
}