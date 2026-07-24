import { FormEvent, useCallback, useEffect, useState } from 'react'
import { BrandMark } from '@/components/brand-mark'
import { Icon } from '@/components/ui/icon'

type PortalOverview = {
  customerId: string
  status: 'online' | 'offline'
  lastInform: string | null
  lastBoot: string | null
  registered: string | null
  ont: {
    manufacturer: unknown
    model: unknown
    serialNumber: unknown
    hardwareVersion: unknown
    softwareVersion: unknown
    uptimeSeconds: unknown
  }
  optical: { rxPower: unknown; temperature: unknown }
  connectedDevices: unknown
  wifi: Array<{
    index: number
    ssid: unknown
    enabled: boolean | null
    connectedDevices: unknown
    hasSavedPassword?: boolean
  }>
  generatedAt: string
}

type ApiResult<T> = { success: boolean; message?: string; data?: T }
type WifiEditor = { index: number; ssid: string; password: string }

async function portalRequest<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const response = await fetch(`/api/customer${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const contentType = response.headers.get('content-type') || ''
  const result = contentType.includes('application/json')
    ? await response.json()
    : { success: false, message: 'Respons portal tidak valid' }
  if (!response.ok) return { ...result, success: false }
  return result
}

function text(value: unknown) {
  if (value === null || value === undefined || value === '') return 'Belum dilaporkan'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return 'Belum dilaporkan'
}

function dateTime(value: string | null) {
  if (!value) return 'Belum dilaporkan'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Belum dilaporkan'
    : date.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
}

function uptime(value: unknown) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) return 'Belum dilaporkan'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return [days ? `${days} hari` : '', hours ? `${hours} jam` : '', `${minutes} menit`]
    .filter(Boolean)
    .join(' ')
}

function MetricCard({
  icon, label, value, helper
}: {
  icon: string
  label: string
  value: string
  helper?: string
}) {
  return (
    <article className="modern-card p-4 sm:p-5">
      <div className="mb-5 flex items-center justify-between">
        <p className="metric-label">{label}</p>
        <span className="rounded-md bg-secondary p-2 text-primary"><Icon name={icon} size={18} /></span>
      </div>
      <p className="break-words text-xl font-bold tracking-tight">{value}</p>
      {helper && <p className="mt-1 text-xs text-muted-foreground">{helper}</p>}
    </article>
  )
}

export default function CustomerPortal() {
  const [checkingSession, setCheckingSession] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [customerId, setCustomerId] = useState('')
  const [password, setPassword] = useState('')
  const [showLoginPassword, setShowLoginPassword] = useState(false)
  const [overview, setOverview] = useState<PortalOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [wifiEditor, setWifiEditor] = useState<WifiEditor | null>(null)
  const [wifiSaving, setWifiSaving] = useState(false)
  const [showWifiPassword, setShowWifiPassword] = useState(false)
  const [visibleSavedPasswordIndex, setVisibleSavedPasswordIndex] = useState<number | null>(null)
  const [revealedWifiPasswords, setRevealedWifiPasswords] = useState<Record<number, string>>({})
  const [revealingWifiPasswordIndex, setRevealingWifiPasswordIndex] = useState<number | null>(null)
  const [wifiFeedback, setWifiFeedback] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  const loadOverview = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await portalRequest<PortalOverview>('/overview')
      if (!result.success || !result.data) {
        if (result.message?.toLowerCase().includes('session')) setAuthenticated(false)
        setError(result.message || 'Informasi ONT belum dapat dimuat.')
        return
      }
      setOverview(result.data)
    } catch {
      setError('Portal tidak dapat terhubung ke server. Periksa koneksi lalu coba lagi.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void portalRequest<{ customerId: string }>('/session')
      .then((result) => {
        if (cancelled) return
        setAuthenticated(result.success)
        if (result.success) void loadOverview()
      })
      .finally(() => {
        if (!cancelled) setCheckingSession(false)
      })
    return () => { cancelled = true }
  }, [loadOverview])

  useEffect(() => {
    if (!authenticated) return
    const timer = window.setInterval(() => void loadOverview(), 60_000)
    return () => window.clearInterval(timer)
  }, [authenticated, loadOverview])

  useEffect(() => {
    if (authenticated) return
    setOverview(null)
    setWifiEditor(null)
    setShowWifiPassword(false)
    setVisibleSavedPasswordIndex(null)
    setRevealedWifiPasswords({})
    setRevealingWifiPasswordIndex(null)
    setWifiFeedback(null)
  }, [authenticated])

  const login = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const result = await portalRequest<{ customerId: string }>('/login', {
        method: 'POST',
        body: JSON.stringify({ customerId, password }),
      })
      if (!result.success) {
        setError(result.message || 'ID Customer atau password salah.')
        return
      }
      setAuthenticated(true)
      setPassword('')
      setShowLoginPassword(false)
      await loadOverview()
    } catch {
      setError('Portal tidak dapat terhubung ke server. Coba lagi.')
    } finally {
      setLoading(false)
    }
  }

  const logout = async () => {
    await portalRequest('/logout', { method: 'POST' })
    setAuthenticated(false)
    setOverview(null)
    setCustomerId('')
    setPassword('')
    setShowLoginPassword(false)
  }

  const openWifiEditor = (index: number, ssid: unknown) => {
    setWifiEditor({ index, ssid: text(ssid), password: '' })
    setShowWifiPassword(false)
    setVisibleSavedPasswordIndex(null)
    setWifiFeedback(null)
  }

  const toggleSavedWifiPassword = async (index: number) => {
    if (visibleSavedPasswordIndex === index) {
      setVisibleSavedPasswordIndex(null)
      return
    }
    if (revealedWifiPasswords[index]) {
      setVisibleSavedPasswordIndex(index)
      return
    }

    setRevealingWifiPasswordIndex(index)
    setWifiFeedback(null)
    try {
      const result = await portalRequest<{ password: string }>(`/wifi/${index}/password`)
      if (!result.success || !result.data?.password) {
        if (result.message?.toLowerCase().includes('session')) setAuthenticated(false)
        setWifiFeedback({
          type: 'error',
          message: result.message || 'Password WiFi belum dapat dibuka.'
        })
        return
      }
      setRevealedWifiPasswords((current) => ({
        ...current,
        [index]: result.data!.password
      }))
      setVisibleSavedPasswordIndex(index)
    } catch {
      setWifiFeedback({
        type: 'error',
        message: 'Portal tidak dapat terhubung ke server. Coba lagi.'
      })
    } finally {
      setRevealingWifiPasswordIndex(null)
    }
  }

  const saveWifi = async (event: FormEvent) => {
    event.preventDefault()
    if (!wifiEditor) return
    const ssid = wifiEditor.ssid.trim()
    if (!ssid || ssid.length > 32) {
      setWifiFeedback({ type: 'error', message: 'Nama WiFi harus berisi 1 sampai 32 karakter.' })
      return
    }
    if (wifiEditor.password && !/^[\x20-\x7e]{8,63}$/.test(wifiEditor.password)) {
      setWifiFeedback({ type: 'error', message: 'Password WiFi harus terdiri dari 8 sampai 63 karakter.' })
      return
    }

    setWifiSaving(true)
    setWifiFeedback(null)
    try {
      const result = await portalRequest<{ index: number; ssid: string }>('/wifi', {
        method: 'PUT',
        body: JSON.stringify({
          index: wifiEditor.index,
          ssid,
          password: wifiEditor.password
        }),
      })
      if (!result.success) {
        if (result.message?.toLowerCase().includes('session')) setAuthenticated(false)
        setWifiFeedback({
          type: 'error',
          message: result.message || 'Perubahan WiFi belum dapat dikirim.'
        })
        return
      }
      setOverview((current) => current ? {
        ...current,
        wifi: current.wifi.map((network) => (
          network.index === wifiEditor.index
            ? {
                ...network,
                ssid,
                hasSavedPassword: Boolean(wifiEditor.password) || network.hasSavedPassword
              }
            : network
        ))
      } : current)
      setWifiEditor(null)
      setShowWifiPassword(false)
      setWifiFeedback({
        type: 'success',
        message: result.message || 'Perubahan WiFi dikirim ke ONT.'
      })
    } catch {
      setWifiFeedback({
        type: 'error',
        message: 'Portal tidak dapat terhubung ke server. Coba lagi.'
      })
    } finally {
      setWifiSaving(false)
    }
  }

  if (checkingSession) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-5">
        <div className="text-center" aria-live="polite">
          <BrandMark className="mx-auto h-12 w-12" title="SkyGenPanel" />
          <Icon name="refresh" className="mx-auto mt-5 animate-spin text-primary" />
          <p className="mt-2 text-sm text-muted-foreground">Memeriksa sesi portal…</p>
        </div>
      </main>
    )
  }

  if (!authenticated) {
    return (
      <main className="min-h-screen bg-background px-4 py-8 sm:flex sm:items-center sm:justify-center">
        <div className="mx-auto w-full max-w-md">
          <header className="mb-8 flex items-center gap-3">
            <BrandMark className="h-12 w-12 shrink-0" title="SkyGenPanel" />
            <div>
              <p className="text-lg font-bold">SkyGenPanel</p>
              <p className="text-sm text-muted-foreground">Portal pelanggan</p>
            </div>
          </header>
          <section className="modern-card p-5 sm:p-7">
            <p className="page-kicker">Akses mandiri pelanggan</p>
            <h1 className="text-2xl font-bold">Periksa kondisi ONT</h1>
            <p className="mb-6 mt-2 text-sm leading-6 text-muted-foreground">
              Masukkan ID Customer yang diberikan penyedia layanan. Password awal adalah enam digit terakhir ID.
            </p>
            <form className="space-y-4" onSubmit={login}>
              <div>
                <label className="field-label" htmlFor="customer-id">ID Customer</label>
                <input
                  id="customer-id"
                  className="modern-input font-mono uppercase"
                  value={customerId}
                  onChange={(event) => setCustomerId(event.target.value.toUpperCase())}
                  autoComplete="username"
                  maxLength={18}
                  placeholder="CSG-XXXXXXX-XXXXXX"
                  required
                />
              </div>
              <div>
                <label className="field-label" htmlFor="customer-password">Password</label>
                <div className="relative">
                  <input
                    id="customer-password"
                    className="modern-input pr-12 font-mono"
                    type={showLoginPassword ? 'text' : 'password'}
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={password}
                    onChange={(event) => setPassword(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    autoComplete="current-password"
                    placeholder="6 digit"
                    required
                  />
                  <button
                    type="button"
                    className="absolute right-1 top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-secondary"
                    onClick={() => setShowLoginPassword((visible) => !visible)}
                    aria-label={showLoginPassword ? 'Sembunyikan password login' : 'Tampilkan password login'}
                    aria-pressed={showLoginPassword}
                  >
                    <Icon name={showLoginPassword ? 'eye-off' : 'eye'} size={18} />
                  </button>
                </div>
              </div>
              {error && (
                <div className="rounded-md border border-destructive/35 bg-destructive/10 p-3 text-sm text-foreground" role="alert">
                  {error}
                </div>
              )}
              <button className="modern-button w-full" type="submit" disabled={loading}>
                {loading ? <Icon name="refresh" size={17} className="animate-spin" /> : <Icon name="lock" size={17} />}
                {loading ? 'Memeriksa…' : 'Masuk ke portal'}
              </button>
            </form>
          </section>
          <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">
            Data berasal dari laporan terakhir ONT ke sistem operator.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark className="h-10 w-10 shrink-0" title="SkyGenPanel" />
            <div className="min-w-0">
              <p className="font-bold">Portal Pelanggan</p>
              <p className="truncate font-mono text-xs text-muted-foreground">{overview?.customerId || customerId}</p>
            </div>
          </div>
          <button type="button" className="modern-button-secondary shrink-0 px-3" onClick={logout}>
            <Icon name="logout" size={17} /> <span className="hidden sm:inline">Keluar</span>
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6 flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="page-kicker">Ringkasan koneksi</p>
            <h1 className="page-title">Kondisi internet rumah Anda</h1>
            <p className="page-description">Status ONT, sinyal optik, dan WiFi berdasarkan laporan perangkat terakhir.</p>
          </div>
          <button type="button" className="modern-button-secondary" onClick={() => void loadOverview()} disabled={loading}>
            <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
            Perbarui
          </button>
        </div>

        {error && (
          <section className="modern-card mb-5 border-destructive/40 p-4" role="alert">
            <div className="flex items-start gap-3">
              <Icon name="warning" className="mt-0.5 shrink-0 text-destructive" />
              <div>
                <h2 className="font-semibold">Data belum tersedia</h2>
                <p className="mt-1 text-sm text-muted-foreground">{error}</p>
                <button type="button" className="mt-3 text-sm font-semibold text-primary hover:underline" onClick={() => void loadOverview()}>
                  Coba lagi
                </button>
              </div>
            </div>
          </section>
        )}

        {!overview && loading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Memuat informasi ONT">
            {[0, 1, 2, 3].map((item) => <div key={item} className="h-36 animate-pulse rounded-[var(--radius)] bg-muted" />)}
          </div>
        ) : overview ? (
          <>
            {overview.status === 'offline' && (
              <div className="mb-4 rounded-md border border-[hsl(var(--status-warning))]/40 bg-[hsl(var(--status-warning))]/10 p-4 text-sm">
                ONT belum mengirim laporan dalam 10 menit terakhir. Periksa daya dan kabel fiber sebelum menghubungi operator.
              </div>
            )}
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Metrik koneksi">
              <MetricCard
                icon="power"
                label="Status ONT"
                value={overview.status === 'online' ? 'Online' : 'Offline'}
                helper={`Inform terakhir ${dateTime(overview.lastInform)}`}
              />
              <MetricCard icon="signal" label="Sinyal optik RX" value={`${text(overview.optical.rxPower)}${text(overview.optical.rxPower) === 'Belum dilaporkan' ? '' : ' dBm'}`} />
              <MetricCard icon="thermometer" label="Suhu perangkat" value={`${text(overview.optical.temperature)}${text(overview.optical.temperature) === 'Belum dilaporkan' ? '' : ' °C'}`} />
              <MetricCard icon="phone" label="Perangkat terhubung" value={text(overview.connectedDevices)} helper="Total klien yang dilaporkan ONT" />
            </section>

            <div className="mt-5 grid gap-5 lg:grid-cols-[1.05fr_.95fr]">
              <section className="modern-card p-5 sm:p-6">
                <h2 className="section-heading">Informasi ONT</h2>
                <p className="section-description mb-5">Identitas dan kondisi perangkat di lokasi pelanggan.</p>
                <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                  {[
                    ['Pabrikan', text(overview.ont.manufacturer)],
                    ['Model', text(overview.ont.model)],
                    ['Serial number', text(overview.ont.serialNumber)],
                    ['Hardware', text(overview.ont.hardwareVersion)],
                    ['Software', text(overview.ont.softwareVersion)],
                    ['Uptime', uptime(overview.ont.uptimeSeconds)],
                    ['Boot terakhir', dateTime(overview.lastBoot)],
                    ['Terdaftar', dateTime(overview.registered)],
                  ].map(([label, value]) => (
                    <div key={label} className="border-b border-border pb-3">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
                      <dd className="mt-1 break-words font-mono text-sm">{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>

              <section className="modern-card p-5 sm:p-6">
                <h2 className="section-heading">Jaringan WiFi</h2>
                <p className="section-description mb-5">Lihat atau ubah nama dan password jaringan di ONT Anda.</p>
                {wifiFeedback && (
                  <div
                    className={`mb-4 rounded-md border p-3 text-sm ${
                      wifiFeedback.type === 'success'
                        ? 'border-[hsl(var(--status-success))]/40 bg-[hsl(var(--status-success))]/10'
                        : 'border-destructive/40 bg-destructive/10'
                    }`}
                    role={wifiFeedback.type === 'error' ? 'alert' : 'status'}
                    aria-live="polite"
                  >
                    {wifiFeedback.message}
                  </div>
                )}
                {overview.wifi.length ? (
                  <div className="space-y-3">
                    {overview.wifi.map((network) => (
                      <article key={network.index} className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate font-semibold">{text(network.ssid)}</p>
                            <p className="mt-1 text-xs text-muted-foreground">WiFi #{network.index}</p>
                          </div>
                          <span className={
                            network.enabled === false
                              ? 'modern-badge-error'
                              : network.enabled === true
                                ? 'modern-badge-success'
                                : 'modern-badge'
                          }>
                            {
                              network.enabled === false
                                ? 'Nonaktif'
                                : network.enabled === true
                                  ? 'Aktif'
                                  : 'Status belum dilaporkan'
                            }
                          </span>
                        </div>
                        <p className="mt-3 text-sm text-muted-foreground">
                          <strong className="text-foreground">{text(network.connectedDevices)}</strong> perangkat terhubung
                        </p>
                        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2">
                          <div className="min-w-0">
                            <p className="text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">Password tersimpan</p>
                            <p className="mt-1 truncate font-mono text-sm">
                              {network.hasSavedPassword
                                ? (
                                    visibleSavedPasswordIndex === network.index &&
                                    revealedWifiPasswords[network.index]
                                      ? revealedWifiPasswords[network.index]
                                      : '••••••••••••'
                                  )
                                : 'Belum tersimpan'}
                            </p>
                          </div>
                          {network.hasSavedPassword && (
                            <button
                              type="button"
                              className="inline-flex size-10 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary"
                              disabled={revealingWifiPasswordIndex === network.index}
                              onClick={() => void toggleSavedWifiPassword(network.index)}
                              aria-label={
                                visibleSavedPasswordIndex === network.index
                                  ? 'Sembunyikan password tersimpan'
                                  : 'Tampilkan password tersimpan'
                              }
                              aria-pressed={visibleSavedPasswordIndex === network.index}
                            >
                              <Icon
                                name={
                                  revealingWifiPasswordIndex === network.index
                                    ? 'refresh'
                                    : visibleSavedPasswordIndex === network.index
                                      ? 'eye-off'
                                      : 'eye'
                                }
                                size={18}
                                className={revealingWifiPasswordIndex === network.index ? 'animate-spin' : ''}
                              />
                            </button>
                          )}
                        </div>
                        <p className="mt-1.5 text-[0.68rem] leading-5 text-muted-foreground">
                          Hanya password terakhir yang pernah dikirim melalui portal ini.
                        </p>
                        {wifiEditor?.index === network.index ? (
                          <form className="mt-4 space-y-4 border-t border-border pt-4" onSubmit={saveWifi}>
                            <div>
                              <label className="field-label" htmlFor={`wifi-ssid-${network.index}`}>Nama WiFi</label>
                              <input
                                id={`wifi-ssid-${network.index}`}
                                className="modern-input"
                                value={wifiEditor.ssid}
                                maxLength={32}
                                onChange={(event) => setWifiEditor((current) => (
                                  current ? { ...current, ssid: event.target.value } : current
                                ))}
                                autoComplete="off"
                                required
                              />
                              <p className="field-hint">Maksimal 32 karakter.</p>
                            </div>
                            <div>
                              <label className="field-label" htmlFor={`wifi-password-${network.index}`}>Password baru</label>
                              <div className="relative">
                                <input
                                  id={`wifi-password-${network.index}`}
                                  className="modern-input pr-12 font-mono"
                                  type={showWifiPassword ? 'text' : 'password'}
                                  value={wifiEditor.password}
                                  minLength={wifiEditor.password ? 8 : undefined}
                                  maxLength={63}
                                  onChange={(event) => setWifiEditor((current) => (
                                    current ? { ...current, password: event.target.value } : current
                                  ))}
                                  autoComplete="new-password"
                                  placeholder="Kosongkan jika tidak diubah"
                                />
                                <button
                                  type="button"
                                  className="absolute right-1 top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-secondary"
                                  onClick={() => setShowWifiPassword((visible) => !visible)}
                                  aria-label={showWifiPassword ? 'Sembunyikan password' : 'Tampilkan password'}
                                  aria-pressed={showWifiPassword}
                                >
                                  <Icon name={showWifiPassword ? 'eye-off' : 'eye'} size={18} />
                                </button>
                              </div>
                              <p className="field-hint">8–63 karakter. Kosongkan untuk mempertahankan password saat ini.</p>
                            </div>
                            <div className="rounded-md border border-[hsl(var(--status-warning))]/35 bg-[hsl(var(--status-warning))]/10 p-3 text-xs leading-5">
                              Perangkat yang memakai jaringan ini dapat terputus dan harus tersambung ulang setelah perubahan diterapkan.
                            </div>
                            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                              <button
                                type="button"
                                className="modern-button-secondary"
                                disabled={wifiSaving}
                                onClick={() => setWifiEditor(null)}
                              >
                                Batal
                              </button>
                              <button
                                type="submit"
                                className="modern-button"
                                disabled={
                                  wifiSaving ||
                                  (!wifiEditor.password && wifiEditor.ssid.trim() === text(network.ssid))
                                }
                              >
                                <Icon name={wifiSaving ? 'refresh' : 'check'} size={17} className={wifiSaving ? 'animate-spin' : ''} />
                                {wifiSaving ? 'Mengirim…' : 'Simpan perubahan'}
                              </button>
                            </div>
                          </form>
                        ) : (
                          <button
                            type="button"
                            className="modern-button-secondary mt-4 w-full"
                            onClick={() => openWifiEditor(network.index, network.ssid)}
                          >
                            <Icon name="edit" size={17} /> Ubah nama atau password
                          </button>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-border p-6 text-center">
                    <Icon name="wifi" className="mx-auto text-muted-foreground" />
                    <p className="mt-2 text-sm font-semibold">WiFi belum dilaporkan</p>
                    <p className="mt-1 text-xs text-muted-foreground">Data akan muncul setelah ONT mengirim parameter WiFi.</p>
                  </div>
                )}
              </section>
            </div>
            <p className="mt-5 text-center text-xs text-muted-foreground">
              Data diperbarui {dateTime(overview.generatedAt)} · otomatis setiap 60 detik
            </p>
          </>
        ) : null}
      </div>
    </main>
  )
}
