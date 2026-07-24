'use client'

import { useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Icon } from '@/components/ui/icon'
import { BrandMark } from '@/components/brand-mark'

export default function Setup() {
  const [formData, setFormData] = useState({ username: '', password: '', confirmPassword: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { completeSetup } = useAuth()

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')

    if (formData.username.trim().length < 3) {
      setError('Username minimal 3 karakter. Gunakan nama yang mudah dikenali operator.')
      return
    }
    if (formData.password.length < 8) {
      setError('Password minimal 8 karakter. Tambahkan kombinasi huruf, angka, dan simbol.')
      return
    }
    if (formData.password !== formData.confirmPassword) {
      setError('Konfirmasi password berbeda. Ketik ulang password yang sama.')
      return
    }

    setLoading(true)
    try {
      if (!await completeSetup(formData.username.trim(), formData.password)) {
        setError('Akun administrator belum dapat dibuat. Periksa log server lalu coba lagi.')
      }
    } catch {
      setError('Panel tidak dapat menghubungi server. Periksa koneksi lalu coba lagi.')
    } finally {
      setLoading(false)
    }
  }

  const updateField = (event: React.ChangeEvent<HTMLInputElement>) => {
    setFormData((value) => ({ ...value, [event.target.name]: event.target.value }))
  }

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[minmax(22rem,0.8fr)_minmax(32rem,1.2fr)]">
      <section className="hidden flex-col justify-between bg-[#18211d] p-10 text-[#f4f3ed] lg:flex xl:p-14" aria-label="Setup information">
        <div className="flex items-center gap-3">
          <BrandMark className="size-11" />
          <div>
            <div className="text-lg font-bold">SkyGenPanel</div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-[#9aa9a2]">First-run setup</div>
          </div>
        </div>
        <div className="max-w-lg">
          <div className="mb-5 h-px w-16 bg-[#d97706]" />
          <h1 className="text-4xl font-semibold leading-[1.12] tracking-[-0.035em] text-white">
            Secure the operations console before connecting devices.
          </h1>
          <p className="mt-5 max-w-md text-base leading-7 text-[#b8c4bd]">
            Akun pertama menjadi administrator panel. Simpan kredensial ini di password manager dan jangan gunakan ulang password GenieACS.
          </p>
        </div>
        <p className="text-xs leading-5 text-[#819087]">One administrator account is created in this step.</p>
      </section>

      <main className="flex min-h-screen items-start justify-center px-4 pb-10 pt-12 sm:px-8 lg:items-center lg:py-10">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandMark className="size-10" title="SkyGenPanel" />
            <div>
              <div className="font-bold">SkyGenPanel</div>
              <div className="text-[0.65rem] font-bold uppercase tracking-[0.13em] text-muted-foreground">First-run setup</div>
            </div>
          </div>

          <div className="auth-panel">
            <div className="mb-7">
              <p className="page-kicker">Initial administrator</p>
              <h1 className="text-2xl font-bold text-foreground">Create panel access</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Buat kredensial untuk orang yang bertanggung jawab atas konfigurasi ACS.
              </p>
            </div>

            <form className="space-y-5" onSubmit={handleSubmit} noValidate>
              {error && (
                <div id="setup-error" className="alert-error flex gap-2.5" role="alert">
                  <Icon name="warning" size={19} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div>
                <label htmlFor="username" className="field-label">Administrator username</label>
                <input id="username" name="username" autoComplete="username" required autoFocus value={formData.username}
                  onChange={updateField} className="modern-input" placeholder="network-admin"
                  aria-invalid={Boolean(error)} aria-describedby={error ? 'setup-error' : 'username-hint'} />
                <p id="username-hint" className="field-hint">Minimal 3 karakter; hindari username pribadi jika akun dipakai tim.</p>
              </div>

              <div>
                <label htmlFor="password" className="field-label">Password</label>
                <input id="password" name="password" type="password" autoComplete="new-password" required value={formData.password}
                  onChange={updateField} className="modern-input" placeholder="Minimal 8 karakter"
                  aria-invalid={Boolean(error)} aria-describedby={error ? 'setup-error' : 'password-hint'} />
                <p id="password-hint" className="field-hint">Gunakan password unik yang tidak digunakan pada ONT atau GenieACS.</p>
              </div>

              <div>
                <label htmlFor="confirmPassword" className="field-label">Confirm password</label>
                <input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required
                  value={formData.confirmPassword} onChange={updateField} className="modern-input" placeholder="Ketik ulang password"
                  aria-invalid={Boolean(error)} aria-describedby={error ? 'setup-error' : undefined} />
              </div>

              <button type="submit" disabled={loading} className="modern-button w-full">
                {loading ? 'Creating administrator…' : 'Create administrator'}
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  )
}
