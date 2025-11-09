import DeviceDetailClient from './device-detail-client'

export function generateStaticParams() {
  return []
}

export default function DeviceDetail({ params }: { params: { id: string } }) {
  return <DeviceDetailClient deviceId={params.id} />
}