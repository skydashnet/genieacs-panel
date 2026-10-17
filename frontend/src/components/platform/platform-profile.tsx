'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  platformAPI,
  publicAPI,
  PLATFORM_PROFILE_FIELDS,
  type CnpjData,
  type PlatformBillingPolicy,
  type PlatformProfile,
  type PlatformProfileField
} from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n/dictionary'
import { centsToInput } from '@/lib/subscription-console'
import { parseRewardToCents } from '@/lib/referrals'

type Rascunho = Record<PlatformProfileField, string>

const VAZIO = Object.fromEntries(PLATFORM_PROFILE_FIELDS.map((campo) => [campo, ''])) as Rascunho

/** A suspensão automática (0102): números, digitados como texto. */
type CampoPolitica = keyof PlatformBillingPolicy
// `grupo`: a suspensão automática e, à parte, a retenção no cancelamento (0107).
const CAMPOS_POLITICA: {
  campo: CampoPolitica; rotulo: TranslationKey; dica: TranslationKey; max: number; grupo: 'billing' | 'retention'
}[] = [
  { campo: 'autoSuspendDays', rotulo: 'platform.profile.autoSuspendDays', dica: 'platform.profile.autoSuspendDaysHint', max: 90, grupo: 'billing' },
  { campo: 'autoSuspendWarnDays', rotulo: 'platform.profile.autoSuspendWarnDays', dica: 'platform.profile.autoSuspendWarnDaysHint', max: 30, grupo: 'billing' },
  {
    campo: 'retentionDiscountPercent', rotulo: 'platform.profile.retentionDiscountPercent',
    dica: 'platform.profile.retentionDiscountPercentHint', max: 90, grupo: 'retention'
  },
  {
    campo: 'retentionDiscountMonths', rotulo: 'platform.profile.retentionDiscountMonths',
    dica: 'platform.profile.retentionDiscountMonthsHint', max: 24, grupo: 'retention'
  },
  {
    campo: 'retentionPauseMaxMonths', rotulo: 'platform.profile.retentionPauseMaxMonths',
    dica: 'platform.profile.retentionPauseMaxMonthsHint', max: 12, grupo: 'retention'
  }
]
const PADRAO_POLITICA: PlatformBillingPolicy = {
  autoSuspendDays: 15,
  autoSuspendWarnDays: 3,
  retentionDiscountPercent: 20,
  retentionDiscountMonths: 3,
  retentionPauseMaxMonths: 2
}
const POLITICA_VAZIA = Object.fromEntries(CAMPOS_POLITICA.map(({ campo }) => [campo, ''])) as Record<CampoPolitica, string>
const GRUPOS_POLITICA: { grupo: 'billing' | 'retention'; titulo: TranslationKey; dica: TranslationKey }[] = [
  { grupo: 'billing', titulo: 'platform.profile.billing', dica: 'platform.profile.billingHint' },
  { grupo: 'retention', titulo: 'platform.profile.retention', dica: 'platform.profile.retentionHint' }
]

/** Os blocos do formulário, e os campos de cada um. */
const BLOCOS: {
  titulo: TranslationKey
  dica: TranslationKey
  campos: { campo: PlatformProfileField; rotulo: TranslationKey; placeholder?: string; tipo?: string; largo?: boolean }[]
}[] = [
  {
    titulo: 'platform.profile.company',
    dica: 'platform.profile.companyHint',
    campos: [
      { campo: 'tradeName', rotulo: 'platform.profile.tradeName', placeholder: 'TR69' },
      { campo: 'legalName', rotulo: 'platform.profile.legalName' },
      { campo: 'taxId', rotulo: 'platform.profile.taxId', placeholder: '00.000.000/0000-00' },
      { campo: 'address', rotulo: 'platform.profile.address', largo: true }
    ]
  },
  {
    titulo: 'platform.profile.contact',
    dica: 'platform.profile.contactHint',
    campos: [
      { campo: 'contactWhatsapp', rotulo: 'platform.profile.contactWhatsapp', placeholder: '(93) 99999-9999', tipo: 'tel' },
      { campo: 'contactEmail', rotulo: 'platform.profile.contactEmail', placeholder: 'contato@empresa.com.br', tipo: 'email' }
    ]
  },
  {
    titulo: 'platform.profile.notices',
    dica: 'platform.profile.noticesHint',
    campos: [
      { campo: 'notifyWhatsapp', rotulo: 'platform.profile.notifyWhatsapp', placeholder: '(93) 99999-9999', tipo: 'tel' },
      { campo: 'notifyEmail', rotulo: 'platform.profile.notifyEmail', placeholder: 'vendas@empresa.com.br', tipo: 'email' }
    ]
  },
  {
    titulo: 'platform.profile.social',
    dica: 'platform.profile.socialHint',
    campos: [
      { campo: 'instagram', rotulo: 'platform.profile.instagram', placeholder: '@empresa' },
      { campo: 'facebook', rotulo: 'platform.profile.facebook', placeholder: 'facebook.com/empresa' },
      { campo: 'youtube', rotulo: 'platform.profile.youtube', placeholder: '@empresa' },
      { campo: 'linkedin', rotulo: 'platform.profile.linkedin', placeholder: 'linkedin.com/company/empresa' }
    ]
  }
]

/** Exibe o que o banco guarda do jeito que se digita: telefone e CNPJ formatados. */
function paraTela(campo: PlatformProfileField, valor: string | null) {
  if (!valor) return ''
  if (campo === 'contactWhatsapp' || campo === 'notifyWhatsapp') {
    const d = valor.replace(/^55(?=\d{10,11}$)/, '')
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  }
  return valor
}

function mascaraCnpj(texto: string) {
  const d = texto.replace(/\D/g, '').slice(0, 14)
  return d
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2')
}

/**
 * O endereço da Receita numa linha: `Rua X, 100 - Sala 2 - Centro, Cidade/UF, CEP 00000-000`.
 * Parte vazia é pulada, para não sobrar vírgula nem traço solto.
 */
function enderecoDoCnpj(d: CnpjData) {
  const rua = [d.addressLine, d.addressNumber].filter(Boolean).join(', ')
  const inicio = [rua, d.addressExtra, d.district].filter(Boolean).join(' - ')
  const cidade = [d.city, d.state].filter(Boolean).join('/')
  const cep = d.postalCode && /^\d{8}$/.test(d.postalCode.replace(/\D/g, ''))
    ? `CEP ${d.postalCode.replace(/\D/g, '').replace(/^(\d{5})(\d{3})$/, '$1-$2')}`
    : ''
  return [inicio, cidade, cep].filter(Boolean).join(', ')
}

/** O telefone da Receita (`ddd_telefone_1`) como a tela mostra, se for um número do Brasil. */
function telefoneDoCnpj(bruto: string | undefined) {
  const d = String(bruto ?? '').replace(/\D/g, '')
  if (d.length !== 10 && d.length !== 11) return ''
  return paraTela('contactWhatsapp', d)
}

/**
 * Configurações → Dados do SaaS: a empresa que vende, como o site a mostra, e
 * para onde vão os avisos de cadastro e de pedido de demonstração.
 *
 * O `.env` continua valendo para o campo que nunca foi salvo aqui — o selo ao
 * lado de cada rótulo diz de onde o valor vem. Salvar vazio apaga o que foi
 * gravado e devolve o campo ao `.env`.
 */
export function PlatformProfileForm() {
  const { t } = useTranslation()
  const toast = useToast()
  const [perfil, setPerfil] = useState<PlatformProfile | null>(null)
  const [rascunho, setRascunho] = useState<Rascunho>(VAZIO)
  const [politica, setPolitica] = useState<Record<CampoPolitica, string>>(POLITICA_VAZIA)
  // O crédito da indicação de provedores (0106), digitado em reais.
  const [recompensa, setRecompensa] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, setSalvando] = useState(false)
  // A consulta do CNPJ na Receita: o estado da tela, e qual CNPJ já foi
  // consultado — para não repetir a consulta a cada tecla nem ao carregar.
  const [cnpj, setCnpj] = useState<{ estado: 'idle' | 'looking' | 'found' | 'error'; texto?: string }>({ estado: 'idle' })
  const consultado = useRef('')

  const aplicar = useCallback((dados: PlatformProfile) => {
    consultado.current = String(dados.values.taxId ?? '').replace(/\D/g, '')
    setPerfil(dados)
    setRascunho(Object.fromEntries(
      PLATFORM_PROFILE_FIELDS.map((campo) => [campo, paraTela(campo, dados.values[campo])])
    ) as Rascunho)
    const gravada = { ...PADRAO_POLITICA, ...(dados.billing ?? {}) }
    setPolitica(Object.fromEntries(
      CAMPOS_POLITICA.map(({ campo }) => [campo, String(gravada[campo])])
    ) as Record<CampoPolitica, string>)
    setRecompensa(centsToInput(dados.billing?.referralRewardCents ?? 0))
  }, [])

  useEffect(() => {
    let vivo = true
    platformAPI.getPlatformProfile().then((res) => {
      if (!vivo) return
      if (res.success && res.data) aplicar(res.data)
      else setErro(res.message || t('platform.profile.loadFailed'))
    }).catch(() => { if (vivo) setErro(t('platform.profile.loadFailed')) })
    return () => { vivo = false }
  }, [aplicar, t])

  /**
   * Busca o CNPJ na Receita e preenche o rascunho — sem salvar: a pessoa
   * confere e clica em Salvar.
   *
   * Razão social e endereço são sobrescritos, porque o CNPJ é a fonte deles.
   * Nome fantasia, e-mail e WhatsApp só entram se estiverem vazios: são a
   * marca e o contato que a pessoa escolheu, e a Receita não sabe disso.
   */
  const buscarCnpj = useCallback(async (digitos: string) => {
    consultado.current = digitos
    setCnpj({ estado: 'looking' })
    try {
      const res = await publicAPI.cnpj(digitos)
      if (!res.success || !res.data) {
        setCnpj({ estado: 'error', texto: res.message || t('platform.profile.cnpjFailed') })
        return
      }
      const d = res.data
      setRascunho((r) => ({
        ...r,
        legalName: d.legalName || r.legalName,
        address: enderecoDoCnpj(d) || r.address,
        tradeName: r.tradeName.trim() ? r.tradeName : (d.tradeName || ''),
        contactEmail: r.contactEmail.trim() ? r.contactEmail : (d.email?.toLowerCase() || ''),
        contactWhatsapp: r.contactWhatsapp.trim() ? r.contactWhatsapp : telefoneDoCnpj(d.phone)
      }))
      setCnpj({ estado: 'found', texto: d.legalName })
    } catch {
      setCnpj({ estado: 'error', texto: t('platform.profile.cnpjFailed') })
    }
  }, [t])

  // Completou os 14 dígitos de um CNPJ novo: consulta sozinho, depois de uma pausa.
  useEffect(() => {
    const digitos = rascunho.taxId.replace(/\D/g, '')
    if (digitos.length !== 14 || digitos === consultado.current) return undefined
    const timer = window.setTimeout(() => { void buscarCnpj(digitos) }, 400)
    return () => window.clearTimeout(timer)
  }, [rascunho.taxId, buscarCnpj])

  const salvar = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!perfil) return
    // Só o que mudou vai, para um campo que vem do `.env` não virar "gravado"
    // só porque o formulário o reenviou.
    const patch: Partial<Record<PlatformProfileField, string>> & Partial<Record<CampoPolitica | 'referralRewardCents', number | null>> = {}
    for (const campo of PLATFORM_PROFILE_FIELDS) {
      if (rascunho[campo].trim() !== paraTela(campo, perfil.values[campo])) patch[campo] = rascunho[campo].trim()
    }
    // Os números da política: vazio volta ao padrão; o servidor valida.
    for (const { campo } of CAMPOS_POLITICA) {
      const texto = politica[campo].trim()
      const atual = perfil.billing?.[campo] ?? PADRAO_POLITICA[campo]
      if (texto === String(atual)) continue
      patch[campo] = texto === '' ? null : Number(texto)
    }
    // O crédito da indicação: em reais na tela, centavos no servidor.
    const centavos = parseRewardToCents(recompensa)
    if (centavos === null) {
      toast.error(t('platform.profile.referralRewardInvalid'))
      return
    }
    if (centavos !== (perfil.billing?.referralRewardCents ?? 0)) patch.referralRewardCents = centavos
    if (!Object.keys(patch).length) {
      toast.success(t('platform.profile.nothingChanged'))
      return
    }
    setSalvando(true)
    try {
      const res = await platformAPI.updatePlatformProfile(patch)
      if (res.success && res.data) {
        aplicar(res.data)
        toast.success(t('platform.profile.saved'))
      } else {
        toast.error(res.message || t('platform.profile.saveFailed'))
      }
    } catch {
      toast.error(t('platform.profile.saveFailed'))
    } finally {
      setSalvando(false)
    }
  }

  const selo = (campo: PlatformProfileField) => {
    const origem = perfil?.sources[campo]
    if (!origem) return null
    return (
      <span className="ml-2 text-xs font-normal text-muted-foreground">
        · {t(origem === 'db' ? 'integrations.sourceDb' : 'integrations.sourceEnv')}
      </span>
    )
  }

  if (erro) return <p className="alert-error text-sm">{erro}</p>
  if (!perfil) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>

  return (
    <form onSubmit={salvar} className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('platform.settings.profile')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.profile.description')}</p>
      </div>

      {!perfil.canSave && <p className="alert-warning text-sm">{t('platform.profile.noPlatformBox')}</p>}

      {BLOCOS.map((bloco) => (
        <section key={bloco.titulo} className="rounded-md border border-border p-4 sm:p-5">
          <h3 className="font-semibold text-foreground">{t(bloco.titulo)}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t(bloco.dica)}</p>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {bloco.campos.map(({ campo, rotulo, placeholder, tipo, largo }) => (
              <div key={campo} className={largo ? 'sm:col-span-2' : ''}>
                <label htmlFor={`profile-${campo}`} className="field-label">
                  {t(rotulo)}
                  {selo(campo)}
                </label>
                <div className={campo === 'taxId' ? 'flex gap-2' : ''}>
                  <input
                    id={`profile-${campo}`}
                    type={tipo ?? 'text'}
                    className="modern-input w-full min-w-0"
                    placeholder={placeholder}
                    value={rascunho[campo]}
                    disabled={!perfil.canSave}
                    aria-describedby={campo === 'taxId' ? 'profile-taxId-status' : undefined}
                    onChange={(e) => {
                      const valor = campo === 'taxId' ? mascaraCnpj(e.target.value) : e.target.value
                      setRascunho((r) => ({ ...r, [campo]: valor }))
                    }}
                  />
                  {campo === 'taxId' && (
                    <button
                      type="button"
                      className="modern-button-secondary shrink-0"
                      disabled={!perfil.canSave || cnpj.estado === 'looking' || rascunho.taxId.replace(/\D/g, '').length !== 14}
                      onClick={() => void buscarCnpj(rascunho.taxId.replace(/\D/g, ''))}
                    >
                      {t('platform.profile.cnpjLookup')}
                    </button>
                  )}
                </div>
                {campo === 'taxId' && cnpj.estado !== 'idle' && (
                  <p
                    id="profile-taxId-status"
                    aria-live="polite"
                    className={`field-hint ${cnpj.estado === 'error' ? 'text-destructive' : cnpj.estado === 'found' ? 'text-emerald-600 dark:text-emerald-400' : ''}`}
                  >
                    {cnpj.estado === 'looking'
                      ? t('platform.profile.cnpjLooking')
                      : cnpj.estado === 'found'
                        ? t('platform.profile.cnpjFound', { name: cnpj.texto ?? '' })
                        : cnpj.texto}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}

      {GRUPOS_POLITICA.map((bloco) => (
        <section key={bloco.grupo} className="rounded-md border border-border p-4 sm:p-5">
          <h3 className="font-semibold text-foreground">{t(bloco.titulo)}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t(bloco.dica)}</p>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {CAMPOS_POLITICA.filter((c) => c.grupo === bloco.grupo).map(({ campo, rotulo, dica, max }) => (
              <div key={campo}>
                <label htmlFor={`profile-${campo}`} className="field-label">{t(rotulo)}</label>
                <input
                  id={`profile-${campo}`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={max}
                  step={1}
                  className="modern-input w-full min-w-0"
                  value={politica[campo]}
                  disabled={!perfil.canSave}
                  aria-describedby={`profile-${campo}-hint`}
                  onChange={(e) => setPolitica((p) => ({ ...p, [campo]: e.target.value }))}
                />
                <p id={`profile-${campo}-hint`} className="field-hint">
                  {t(dica, { days: (perfil.billingDefaults ?? PADRAO_POLITICA)[campo] ?? PADRAO_POLITICA[campo] })}
                </p>
              </div>
            ))}
          </div>
        </section>
      ))}

      <section className="rounded-md border border-border p-4 sm:p-5">
        <h3 className="font-semibold text-foreground">{t('platform.profile.referral')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.profile.referralHint')}</p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="profile-referralRewardCents" className="field-label">{t('platform.profile.referralReward')}</label>
            <input
              id="profile-referralRewardCents"
              inputMode="decimal"
              className="modern-input w-full min-w-0"
              value={recompensa}
              disabled={!perfil.canSave}
              aria-describedby="profile-referralRewardCents-hint"
              onChange={(e) => setRecompensa(e.target.value)}
            />
            <p id="profile-referralRewardCents-hint" className="field-hint">{t('platform.profile.referralRewardHint')}</p>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="modern-button" disabled={salvando || !perfil.canSave}>
          {salvando ? t('common.saving') : t('common.save')}
        </button>
        <p className="text-xs text-muted-foreground">{t('platform.profile.emptyHint')}</p>
      </div>
    </form>
  )
}

export default PlatformProfileForm
