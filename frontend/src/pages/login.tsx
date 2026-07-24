'use client'

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/auth-context'
import { Icon } from '@/components/ui/icon'
import { BrandMark } from '@/components/brand-mark'

export default function Login() {
  const [formData, setFormData] = useState({ username: '', password: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const navigate = useNavigate()
  const { login } = useAuth()

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const ok = await login(formData.username, formData.password)
      if (ok) navigate('/dashboard')
      else setError('Username atau password tidak cocok. Periksa kembali kredensial administrator.')
    } catch {
      setError('Panel tidak dapat menghubungi server. Periksa koneksi lalu coba lagi.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[minmax(22rem,0.8fr)_minmax(32rem,1.2fr)]">
      <section className="hidden flex-col justify-between bg-[#18211d] p-10 text-[#f4f3ed] lg:flex xl:p-14" aria-label="Product information">
        <div className="flex items-center gap-3">
          <BrandMark className="size-11" />
          <div>
            <div className="text-lg font-bold">SkyGenPanel</div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-[#9aa9a2]">GenieACS operations</div>
          </div>
        </div>
        <div className="max-w-lg">
          <div className="mb-5 h-px w-16 bg-[#d97706]" />
          <h1 className="text-4xl font-semibold leading-[1.12] tracking-[-0.035em] text-white">
            Monitor ONT health. Recover subscriber service.
          </h1>
          <p className="mt-5 max-w-md text-base leading-7 text-[#b8c4bd]">
            Satu konsol untuk meninjau inform terakhir, redaman optik, konfigurasi WAN, dan topologi jaringan yang dilaporkan GenieACS.
          </p>
        </div>
        <p className="text-xs leading-5 text-[#819087]">
          Administrative access only · SkydashNET
        </p>
      </section>

      <main className="flex min-h-screen items-start justify-center px-4 pb-10 pt-16 sm:px-8 lg:items-center lg:py-10">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandMark className="size-10" title="SkyGenPanel" />
            <div>
              <div className="font-bold">SkyGenPanel</div>
              <div className="text-[0.65rem] font-bold uppercase tracking-[0.13em] text-muted-foreground">GenieACS operations</div>
            </div>
          </div>

          <div className="auth-panel">
            <div className="mb-7">
              <p className="page-kicker">Operator access</p>
              <h1 className="text-2xl font-bold text-foreground">Sign in to the panel</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Gunakan akun administrator SkyGenPanel untuk membuka data perangkat.
              </p>
            </div>

            <form className="space-y-5" onSubmit={handleSubmit} noValidate>
              {error && (
                <div id="login-error" className="alert-error flex gap-2.5" role="alert">
                  <Icon name="warning" size={19} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div>
                <label htmlFor="username" className="field-label">Username</label>
                <input
                  id="username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  required
                  autoFocus
                  value={formData.username}
                  onChange={(event) => setFormData((value) => ({ ...value, username: event.target.value }))}
                  className="modern-input"
                  placeholder="admin"
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? 'login-error' : undefined}
                />
              </div>

              <div>
                <label htmlFor="password" className="field-label">Password</label>
                <div className="relative">
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={formData.password}
                    onChange={(event) => setFormData((value) => ({ ...value, password: event.target.value }))}
                    className="modern-input pr-12"
                    placeholder="Masukkan password"
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? 'login-error' : undefined}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    <Icon name={showPassword ? 'eye-off' : 'eye'} size={19} />
                  </button>
                </div>
              </div>

              <button type="submit" disabled={loading} className="modern-button w-full">
                {loading ? (
                  <>
                    <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Verifying account…
                  </>
                ) : 'Sign in'}
              </button>
            </form>
          </div>
          <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">
            Jika akses ditolak, hubungi administrator panel untuk mereset kredensial.
          </p>
        </div>
      </main>
    </div>
  )
}
