import { FormEvent, useEffect, useState } from 'react'
import { BrandMark } from '@/components/brand-mark'
import { Icon } from '@/components/ui/icon'
import { LanguageSwitcher } from '@/components/language-switcher'
import { useTranslation } from '@/contexts/language-context'
import { getActiveLocale } from '@/lib/i18n'

/**
 * A página que o link de indicação abre: um amigo de um cliente deixa nome e
 * WhatsApp, e o provedor entra em contato. Sem sessão; o token da URL é o que
 * liga o cadastro ao cliente que indicou.
 */

type Info = { provider: string | null; referrerFirstName: string | null }
type Reply<T> = { success: boolean; message?: string; data?: T }

async function request<T>(path: string, init?: RequestInit): Promise<Reply<T>> {
  const response = await fetch(`/api/customer/referral${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      'Accept-Language': getActiveLocale()
    }
  })
  const contentType = response.headers.get('content-type') || ''
  const result = contentType.includes('application/json') ? await response.json() : { success: false }
  return response.ok ? result : { ...result, success: false }
}

export default function ReferralPage() {
  const { t } = useTranslation()
  const token = new URLSearchParams(window.location.search).get('t') ?? ''

  const [info, setInfo] = useState<Info | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'invalid'>('loading')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [neighborhood, setNeighborhood] = useState('')
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void (async () => {
      const res = await request<Info>(`?t=${encodeURIComponent(token)}`)
      if (!alive) return
      if (res.success && res.data) {
        setInfo(res.data)
        setState('ready')
      } else {
        setState('invalid')
      }
    })()
    return () => { alive = false }
  }, [token])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSending(true)
    setError('')
    try {
      const res = await request('', {
        method: 'POST',
        body: JSON.stringify({ t: token, name, phone, neighborhood })
      })
      if (res.success) setDone(true)
      else setError(res.message || t('portal.referral.sendFailed'))
    } finally {
      setSending(false)
    }
  }

  const provider = info?.provider ?? null

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:flex sm:items-center sm:justify-center">
      <div className="mx-auto w-full max-w-md">
        <header className="mb-8 flex items-center gap-3">
          <BrandMark className="h-12 w-12 shrink-0" title={provider ?? 'TR69 Controle'} />
          <div className="min-w-0">
            <p className="text-lg font-bold">{provider ?? 'TR69 Controle'}</p>
          </div>
          <LanguageSwitcher collapseOnMobile className="ms-auto shrink-0" />
        </header>

        <section className="modern-card p-5 sm:p-7">
          {state === 'loading' && (
            <p className="text-sm text-muted-foreground" aria-live="polite">{t('common.loading')}</p>
          )}

          {state === 'invalid' && (
            <>
              <h1 className="text-2xl font-bold">{t('portal.referral.invalidTitle')}</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('portal.referral.invalidBody')}</p>
            </>
          )}

          {state === 'ready' && done && (
            <>
              <h1 className="text-2xl font-bold">{t('portal.referral.doneTitle')}</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('portal.referral.doneBody')}</p>
            </>
          )}

          {state === 'ready' && !done && (
            <>
              <p className="page-kicker">{t('portal.referral.kicker')}</p>
              <h1 className="text-2xl font-bold">
                {info?.referrerFirstName
                  ? t('portal.referral.titleNamed', { nome: info.referrerFirstName })
                  : t('portal.referral.title')}
              </h1>
              <p className="mb-6 mt-2 text-sm leading-6 text-muted-foreground">
                {provider
                  ? t('portal.referral.subtitle', { provedor: provider })
                  : t('portal.referral.subtitleNoProvider')}
              </p>
              <form className="space-y-4" onSubmit={submit}>
                <div>
                  <label className="field-label" htmlFor="referral-name">{t('portal.referral.name')}</label>
                  <input
                    id="referral-name"
                    className="modern-input"
                    value={name}
                    maxLength={120}
                    autoComplete="name"
                    onChange={(event) => setName(event.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="referral-phone">{t('portal.referral.phone')}</label>
                  <input
                    id="referral-phone"
                    className="modern-input"
                    type="tel"
                    inputMode="tel"
                    value={phone}
                    maxLength={20}
                    autoComplete="tel"
                    placeholder="(93) 99999-9999"
                    onChange={(event) => setPhone(event.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="referral-neighborhood">{t('portal.referral.neighborhood')}</label>
                  <input
                    id="referral-neighborhood"
                    className="modern-input"
                    value={neighborhood}
                    maxLength={120}
                    onChange={(event) => setNeighborhood(event.target.value)}
                  />
                </div>
                {error && (
                  <div className="rounded-md border border-destructive/35 bg-destructive/10 p-3 text-sm text-foreground" role="alert">
                    {error}
                  </div>
                )}
                <button className="modern-button w-full" type="submit" disabled={sending}>
                  {sending ? <Icon name="refresh" size={17} className="animate-spin" /> : <Icon name="check" size={17} />}
                  {sending ? t('portal.referral.sending') : t('portal.referral.submit')}
                </button>
                <p className="text-xs leading-5 text-muted-foreground">{t('portal.referral.consent')}</p>
              </form>
            </>
          )}
        </section>
      </div>
    </main>
  )
}
