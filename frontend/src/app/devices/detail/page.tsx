'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import DeviceDetailClient from './device-detail-client'

function DetailInner() {
  const params = useSearchParams()
  const id = params.get('id') || ''
  return <DeviceDetailClient deviceId={id} />
}

export default function DeviceDetailPage() {
  return (
    <Suspense fallback={<div className="p-6 text-gray-500 dark:text-gray-400">Loading...</div>}>
      <DetailInner />
    </Suspense>
  )
}
