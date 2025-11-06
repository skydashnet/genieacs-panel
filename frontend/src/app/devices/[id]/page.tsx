import DeviceDetailClient from './device-detail-client'

// Generate static params for dynamic routes
export function generateStaticParams() {
  // Return empty array to make it fully dynamic
  return []
}

// This is a Server Component that receives params as props
export default function DeviceDetail({ params }: { params: { id: string } }) {
  return <DeviceDetailClient deviceId={params.id} />
}