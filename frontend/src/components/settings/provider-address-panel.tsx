import { useEffect, useState } from 'react'
import { mapSettingsAPI, subscriptionAPI, tenantAPI, type TenantBilling } from '@/lib/api'
import { ADDRESS_FIELDS, CLASSE_LARGURA, CONTACT_FIELDS, IDENTITY_FIELDS, type BillingField } from '@/components/billing-profile'
import type { TranslationKey } from '@/lib/i18n'
import { LocationPicker, wrapLongitude } from '@/components/location-picker'
import { canGeocode, geocodeFields } from '@/lib/provider-location'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'

/**
 * O cadastro do provedor (empresa, endereço, contato) e o ponto da sede no
 * mapa, num bloco só.
 *
 * Nenhum dado novo: o cadastro é o fiscal (o mesmo que a tela Plano edita) e
 * o ponto é o centro do mapa da rede. Aqui é onde o operador
 * procura "o endereço do provedor"; lá é onde o contador procura a nota.
 *
 * Cada metade exige a própria permissão — `settings.write` para o endereço,
 * `map.write` para o ponto — e o Salvar só grava a metade que a pessoa pode
 * gravar. Do cadastro vão só os campos que mudaram: a rota trata campo
 * ausente como "não mexe", então editar aqui não desfaz o que alguém acabou
 * de gravar pela tela Plano noutro campo.
 */
type AddressForm = Record<string, string>

const SECTIONS: Array<{ title: TranslationKey; fields: BillingField[] }> = [
  { title: 'settings.providerAddress.companySection', fields: IDENTITY_FIELDS },
  { title: 'settings.providerAddress.addressSection', fields: ADDRESS_FIELDS },
  { title: 'settings.providerAddress.contactSection', fields: CONTACT_FIELDS }
]
const ALL_FIELDS = SECTIONS.flatMap((section) => section.fields)

function addressFrom(billing: TenantBilling | null): AddressForm {
  const out: AddressForm = {}
  for (const { chave } of ALL_FIELDS) out[chave] = (billing?.[chave] ?? '') as string
  return out
}

export function ProviderAddressPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const { can } = useAuth()
  const canAddress = can('settings.write')
  const canMap = can('map.write')

  const [address, setAddress] = useState<AddressForm>(() => addressFrom(null))
  const [savedAddress, setSavedAddress] = useState<AddressForm>(() => addressFrom(null))
  const [center, setCenter] = useState<{ lat: string; lng: string }>({ lat: '', lng: '' })
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [lookingUp, setLookingUp] = useState(false)
  const [locating, setLocating] = useState(false)

  useEffect(() => {
    void (async () => {
      const [sub, map] = await Promise.all([subscriptionAPI.current(), mapSettingsAPI.get()])
      if (sub.success && sub.data) {
        const initial = addressFrom(sub.data.billing)
        setAddress(initial)
        setSavedAddress(initial)
      }
      const data = map.data as { center_lat?: string; center_lng?: string } | undefined
      if (map.success && data) setCenter({ lat: String(data.center_lat ?? ''), lng: String(data.center_lng ?? '') })
      setLoaded(true)
    })()
  }, [])

  const lat = Number(center.lat), lng = wrapLongitude(Number(center.lng))
  const validPoint = center.lat.trim() !== '' && center.lng.trim() !== ''
    && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180

  /** Junta ao formulário o que a consulta trouxe, só nos campos do cadastro e só o que veio preenchido. */
  const merge = (base: AddressForm, found: Partial<Record<string, unknown>>) => {
    const next = { ...base }
    for (const { chave } of ALL_FIELDS) {
      const value = found[chave]
      if (typeof value === 'string' && value.trim() !== '') next[chave] = value
    }
    return next
  }

  /**
   * Põe o marcador da sede no endereço do formulário (Nominatim, no servidor).
   * `silent` é a chamada automática depois de CNPJ/CEP: se falhar, não
   * incomoda — o botão "Localizar no mapa" continua ali.
   */
  const locateOnMap = async (form: AddressForm, silent = false) => {
    if (!canMap || !canGeocode(form)) {
      if (!silent) toast.error(t('settings.providerAddress.locateNeedsCity'))
      return
    }
    setLocating(true)
    try {
      const res = await tenantAPI.geocode(geocodeFields(form))
      if (!res.success || !res.data) {
        if (!silent) toast.error(res.message || t('settings.providerAddress.locateFailed'))
        return
      }
      setCenter({ lat: String(res.data.lat), lng: String(res.data.lng) })
      toast.success(t(res.data.precision === 'address'
        ? 'settings.providerAddress.locatedAddress'
        : 'settings.providerAddress.locatedCity'))
    } finally {
      setLocating(false)
    }
  }

  // Preenche o formulário com o que a Receita tem para o CNPJ digitado, e
  // leva o marcador para o endereço achado. Só o formulário: quem confere e
  // salva é o operador, pelo mesmo Salvar.
  const fillFromCnpj = async () => {
    setLookingUp(true)
    try {
      const res = await tenantAPI.lookupCnpj(address.taxId ?? '')
      if (!res.success || !res.data) { toast.error(res.message || t('settings.providerAddress.cnpjLookupFailed')); return }
      const next = merge(address, res.data)
      setAddress(next)
      toast.success(t('settings.providerAddress.cnpjFilled'))
      await locateOnMap(next, true)
    } finally {
      setLookingUp(false)
    }
  }

  // O endereço do CEP. Número e complemento ficam: o CEP não os conhece.
  // Quando a fonte já traz o ponto, ele vale; senão, geocodifica.
  const fillFromCep = async () => {
    setLookingUp(true)
    try {
      const res = await tenantAPI.lookupCep(address.postalCode ?? '')
      if (!res.success || !res.data) { toast.error(res.message || t('settings.providerAddress.cepLookupFailed')); return }
      const next = merge(address, res.data)
      setAddress(next)
      toast.success(t('settings.providerAddress.cepFilled'))
      const { lat: pointLat, lng: pointLng } = res.data
      if (canMap && typeof pointLat === 'number' && typeof pointLng === 'number') {
        setCenter({ lat: String(pointLat), lng: String(pointLng) })
      } else {
        await locateOnMap(next, true)
      }
    } finally {
      setLookingUp(false)
    }
  }

  /** Os campos que têm botão de consulta ao lado. */
  const LOOKUPS: Record<string, { run: () => Promise<void>; digits: number; label: TranslationKey; busyLabel: TranslationKey }> = {
    taxId: { run: fillFromCnpj, digits: 14, label: 'settings.providerAddress.cnpjFill', busyLabel: 'settings.providerAddress.cnpjLooking' },
    postalCode: { run: fillFromCep, digits: 8, label: 'settings.providerAddress.cepFill', busyLabel: 'settings.providerAddress.cepLooking' }
  }

  const save = async () => {
    if (canMap && !validPoint) { toast.error(t('settings.providerAddress.invalid')); return }
    setBusy(true)
    try {
      if (canAddress) {
        const patch: Partial<TenantBilling> = {}
        for (const { chave } of ALL_FIELDS) {
          if ((address[chave] ?? '') !== (savedAddress[chave] ?? '')) patch[chave] = address[chave] ?? ''
        }
        if (Object.keys(patch).length) {
          const res = await tenantAPI.updateBilling(patch)
          if (!res.success || !res.data) { toast.error(res.message || t('billing.saveFailed')); return }
          const fresh = addressFrom(res.data.billing)
          setAddress(fresh)
          setSavedAddress(fresh)
        }
      }
      if (canMap) {
        const current = await mapSettingsAPI.get()
        if (!current.success) { toast.error(current.message || t('settings.saveError')); return }
        const res = await mapSettingsAPI.update({ ...(current.data as object ?? {}), center_lat: String(lat), center_lng: String(lng) })
        if (!res.success) { toast.error(res.message || t('settings.saveError')); return }
        // O campo passa a mostrar o que foi gravado (longitude já em ±180).
        setCenter({ lat: String(lat), lng: String(lng) })
      }
      toast.success(t('settings.providerAddress.saved'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modern-card max-w-3xl p-5 sm:p-6">
      <h2 className="section-heading">{t('settings.providerAddress.title')}</h2>
      <p className="section-description mb-6">{t('settings.providerAddress.description')}</p>
      <div className="space-y-5">
        {SECTIONS.map(({ title, fields }, index) => (
          <div key={title} className={index > 0 ? 'border-t border-border pt-5' : undefined}>
            <h3 className="mb-4 font-semibold">{t(title)}</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
              {fields.map(({ chave, label, hint, largura, maxLength, inputMode }) => (
                <div key={chave} className={CLASSE_LARGURA[largura]}>
                  <label htmlFor={`provider-${chave}`} className="field-label">{t(label)}</label>
                  <div className={LOOKUPS[chave] ? 'flex flex-col gap-2 sm:flex-row' : undefined}>
                    <input
                      id={`provider-${chave}`}
                      className={LOOKUPS[chave] ? 'modern-input w-full sm:flex-1' : 'modern-input w-full'}
                      value={address[chave] ?? ''}
                      maxLength={maxLength}
                      inputMode={inputMode}
                      disabled={!canAddress || busy || lookingUp || !loaded}
                      onChange={(e) => setAddress((a) => ({ ...a, [chave]: e.target.value }))}
                    />
                    {LOOKUPS[chave] && canAddress && (
                      <button
                        type="button"
                        className="modern-button-secondary whitespace-nowrap"
                        disabled={busy || lookingUp || !loaded || (address[chave] ?? '').replace(/\D/g, '').length !== LOOKUPS[chave].digits}
                        onClick={() => void LOOKUPS[chave].run()}
                      >
                        {lookingUp ? t(LOOKUPS[chave].busyLabel) : t(LOOKUPS[chave].label)}
                      </button>
                    )}
                  </div>
                  {hint && <p className="field-hint">{t(hint)}</p>}
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="border-t border-border pt-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="font-semibold">{t('settings.providerAddress.mapLabel')}</h3>
              <p className="field-hint mb-4 mt-1">{t('onboarding.identity.mapHint')}</p>
            </div>
            {canMap && (
              <button
                type="button"
                className="modern-button-secondary whitespace-nowrap"
                disabled={busy || locating || !loaded || !canGeocode(address)}
                onClick={() => void locateOnMap(address)}
              >
                {locating ? t('settings.providerAddress.locating') : t('settings.providerAddress.locate')}
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="provider-lat" className="field-label">{t('onboarding.identity.lat')}</label>
              <input id="provider-lat" className="modern-input w-full" inputMode="decimal" disabled={!canMap || busy || !loaded} value={center.lat} onChange={(e) => setCenter((c) => ({ ...c, lat: e.target.value }))} />
            </div>
            <div>
              <label htmlFor="provider-lng" className="field-label">{t('onboarding.identity.lng')}</label>
              <input id="provider-lng" className="modern-input w-full" inputMode="decimal" disabled={!canMap || busy || !loaded} value={center.lng} onChange={(e) => setCenter((c) => ({ ...c, lng: e.target.value }))} />
            </div>
          </div>
          {/* Monta depois da leitura: o seletor só abre no ponto salvo se já o
              recebe na primeira renderização. Sem `map.write`, só mostra. */}
          {loaded && (
            <div className="mt-4">
              <LocationPicker
                lat={center.lat.trim() === '' ? null : lat}
                lng={center.lng.trim() === '' ? null : lng}
                onChange={(la, ln) => { if (canMap) setCenter({ lat: String(la), lng: String(ln) }) }}
              />
            </div>
          )}
        </div>

        <button type="button" className="modern-button" disabled={busy || !loaded} onClick={() => void save()}>
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}
