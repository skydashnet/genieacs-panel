'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  platformAPI,
  type GenieAcsAgentStatus,
  type GenieAcsAuthType,
  type GenieAcsConnectionMode,
  type GenieAcsOwnership,
  type Tenant,
  type TenantDeviceTagging,
  type TenantGenieAcs as TenantGenieAcsData,
  type TenantUnownedFirmware
} from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { INSTALLER_VIRTUAL_PARAMETERS, VIRTUAL_PARAMETER_FIELDS } from '@/lib/virtual-parameters'
import { modeOptions } from '@/lib/genieacs-agent'
import { GenieAcsAgentPanel } from '@/components/genieacs-agent-panel'
import { firmwareErrorKind, formatFileSize, reassignSizeMatches, scopedFirmwareName } from '@/lib/firmware'

interface Props {
  tenant: Tenant
}

const MODE_LABELS: Record<GenieAcsConnectionMode, TranslationKey> = {
  direct: 'platform.genieacs.modeDirect',
  tunnel: 'platform.genieacs.modeTunnel',
  agent: 'platform.genieacs.modeAgent'
}

const MODE_HINTS: Record<GenieAcsConnectionMode, TranslationKey> = {
  direct: 'platform.genieacs.modeDirectHint',
  tunnel: 'platform.genieacs.modeTunnelHint',
  agent: 'platform.genieacs.modeAgentHint'
}

const AUTH_LABELS: Record<GenieAcsAuthType, TranslationKey> = {
  none: 'settings.genieAuth.typeNone',
  basic: 'settings.genieAuth.typeBasic',
  bearer: 'settings.genieAuth.typeBearer'
}

/**
 * Para onde o painel deste provedor fala com o GenieACS, e com que credencial.
 *
 * No console e não na tela do provedor, pela mesma razão do gateway: quem
 * hospeda o ACS é a plataforma, e um provedor que pudesse apontar o próprio
 * painel para qualquer endereço usaria o painel como ponte para dentro da rede
 * da plataforma. Ele continua vendo o endereço e testando a conexão.
 *
 * A exceção é o provedor com servidor próprio: marcado aqui, ele passa a gravar
 * endereço, credencial e parâmetros TR-069 na tela dele. Os campos continuam
 * editáveis aqui, para o suporte.
 *
 * O segredo nunca volta do servidor: o campo vazio mantém o guardado, e apagar
 * é um pedido explícito — a mesma regra da tela do provedor.
 *
 * A "tag de equipamentos" é o que separa provedores que dividem o mesmo
 * GenieACS: com ela, o painel do provedor só enxerga (e só age em) ONTs que a
 * carregam. A marcação em lote existe para a frota que já estava no ACS antes
 * da tag — sempre com prévia antes de aplicar.
 *
 * "Firmware sem dono" são os arquivos do ACS compartilhado que não carregam o
 * prefixo `<tag>--` de provedor nenhum — subidos antes do escopo, pela
 * interface do GenieACS. Nenhum provedor os enxerga. O console os lista e, por
 * arquivo, deixa reenviar para este provedor (o administrador escolhe o
 * original no computador: o painel não baixa do GenieACS) ou apagar o antigo.
 *
 * O modo Agente é para o GenieACS numa rede sem IP público: um programa
 * instalado lá abre a conexão até o painel. O bloco dele (estado, chave,
 * instalação) é o mesmo das Configurações do provedor — `GenieAcsAgentPanel`.
 */
export function TenantGenieAcs({ tenant }: Props) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()

  const [data, setData] = useState<TenantGenieAcsData | null>(null)
  const [url, setUrl] = useState('')
  const [mode, setMode] = useState<GenieAcsConnectionMode>('direct')
  const [ownership, setOwnership] = useState<GenieAcsOwnership>('platform')
  const [authType, setAuthType] = useState<GenieAcsAuthType>('none')
  const [username, setUsername] = useState('')
  const [secret, setSecret] = useState('')
  const [clearSecret, setClearSecret] = useState(false)
  // Os caminhos TR-069 dependem dos scripts instalados no ACS — o da
  // plataforma, na SaaS —, e por isso moram aqui e não na tela do provedor.
  const [vps, setVps] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testMessage, setTestMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [deviceTag, setDeviceTag] = useState('')
  const [autoPrefixes, setAutoPrefixes] = useState('')
  const [pppoePrefix, setPppoePrefix] = useState('')
  const [serials, setSerials] = useState('')
  const [tagging, setTagging] = useState(false)
  const [preview, setPreview] = useState<TenantDeviceTagging | null>(null)
  const [semDono, setSemDono] = useState<TenantUnownedFirmware | null>(null)
  const [semDonoErro, setSemDonoErro] = useState<string | null>(null)
  const [firmwareOcupado, setFirmwareOcupado] = useState<string | null>(null)
  const [reenviando, setReenviando] = useState(false)
  // Os antigos já reenviados nesta visita, com o nome novo: o antigo continua
  // no ACS até alguém apagá-lo, e a tela lembra que já pode.
  const [reenviados, setReenviados] = useState<Record<string, string>>({})

  const preencher = useCallback((next: TenantGenieAcsData) => {
    setData(next)
    setUrl(next.url)
    setMode(next.mode ?? 'direct')
    setOwnership(next.ownership ?? 'platform')
    setAuthType(next.auth.authType)
    setUsername(next.auth.username)
    setSecret('')
    setClearSecret(false)
    setVps({ ...next.virtualParameters })
    setDeviceTag(next.deviceTag ?? '')
    setAutoPrefixes((next.autoTagPrefixes ?? []).join(', '))
  }, [])

  useEffect(() => {
    let cancelled = false
    void platformAPI.getTenantGenieAcs(tenant.id).then((res) => {
      if (cancelled) return
      if (res.success && res.data) preencher(res.data)
      else toast.error(res.message || t('platform.genieacs.loadFailed'))
    })
    return () => { cancelled = true }
    // `toast` e `t` mudam de identidade a cada render; recarregar por isso
    // apagaria o que a pessoa está digitando.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id, preencher])

  const carregarSemDono = useCallback(async () => {
    setSemDonoErro(null)
    const res = await platformAPI.listUnownedFirmware(tenant.id)
    if (res.success && res.data) setSemDono(res.data)
    else setSemDonoErro(res.message || t('platform.genieacs.firmwareLoadFailed'))
    // `t` muda de identidade a cada render; recarregar por isso seria um laço.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id])

  useEffect(() => {
    void carregarSemDono()
  }, [carregarSemDono])

  // A leitura periódica do bloco do agente traz o snapshot inteiro, mas só o
  // `agent` é aproveitado: repreencher o formulário apagaria o que a pessoa
  // está digitando nos outros campos.
  const guardarAgente = useCallback((agent: GenieAcsAgentStatus) => {
    setData((atual) => (atual ? { ...atual, agent } : atual))
  }, [])

  const salvar = async () => {
    if (authType === 'basic' && !username.trim()) {
      toast.error(t('settings.genieAuth.usernameRequired'))
      return
    }
    setSaving(true)
    try {
      const res = await platformAPI.updateTenantGenieAcs(tenant.id, {
        url: url.trim(),
        mode,
        ownership,
        authType,
        username: username.trim(),
        ...(clearSecret ? { secret: '' } : secret ? { secret } : {}),
        virtualParameters: vps,
        deviceTag: deviceTag.trim(),
        autoTagPrefixes: autoPrefixes
      })
      if (res.success && res.data) {
        preencher(res.data)
        toast.success(t('platform.genieacs.saved', { provider: tenant.name }))
        // A tag pode ter mudado, e com ela o prefixo do reenvio.
        void carregarSemDono()
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  const testar = async () => {
    setTesting(true)
    setTestMessage(null)
    try {
      // Sem endereço no corpo testa o gravado, com a credencial gravada. Um
      // endereço diferente do gravado vai sem credencial — a mesma regra do
      // teste na tela do provedor.
      const digitado = url.trim()
      const res = await platformAPI.testTenantGenieAcs(tenant.id, digitado && digitado !== data?.url ? digitado : undefined)
      setTestMessage({ ok: res.success, text: res.message || (res.success ? t('settings.general.connectionOk') : t('platform.saveFailed')) })
    } finally {
      setTesting(false)
    }
  }

  const marcar = async (apply: boolean) => {
    setTagging(true)
    try {
      const res = await platformAPI.tagTenantDevices(tenant.id, {
        ...(pppoePrefix.trim() ? { pppoePrefix: pppoePrefix.trim() } : {}),
        ...(serials.trim() ? { serials } : {}),
        apply
      })
      if (!res.success || !res.data) {
        toast.error(res.message || t('platform.saveFailed'))
        return
      }
      setPreview(apply ? null : res.data)
      if (apply) toast.success(t('platform.genieacs.tagApplied', { count: res.data.tagged }))
    } finally {
      setTagging(false)
    }
  }

  const erroDeFirmware = (res: { code?: string; message?: string }) => {
    const tipo = firmwareErrorKind(res)
    if (tipo === 'tooLarge') return t('platform.genieacs.firmwareTooLarge')
    if (tipo === 'generic') return t('platform.saveFailed')
    return res.message || t('platform.saveFailed')
  }

  const reenviar = async (original: { id: string; size: number | null }, arquivo: File) => {
    // A conferência barata de que é o mesmo arquivo; o servidor confere de novo.
    if (!reassignSizeMatches(original.size, arquivo.size)) {
      toast.error(t('platform.genieacs.firmwareSizeMismatch', {
        chosen: formatFileSize(arquivo.size) ?? String(arquivo.size),
        original: formatFileSize(original.size) ?? String(original.size),
        chosenBytes: String(arquivo.size),
        originalBytes: String(original.size)
      }))
      return
    }
    setFirmwareOcupado(original.id)
    setReenviando(true)
    try {
      const res = await platformAPI.reassignFirmware(tenant.id, original.id, arquivo)
      if (res.success && res.data) {
        const novo = res.data.id
        setReenviados((atual) => ({ ...atual, [original.id]: novo }))
        toast.success(t('platform.genieacs.firmwareReassigned', { name: novo }))
      } else {
        toast.error(erroDeFirmware(res))
      }
    } finally {
      setFirmwareOcupado(null)
      setReenviando(false)
    }
  }

  const apagarAntigo = async (nome: string) => {
    const pergunta = reenviados[nome]
      ? 'platform.genieacs.firmwareDeleteConfirm'
      : 'platform.genieacs.firmwareDeleteConfirmNotReassigned'
    if (!window.confirm(t(pergunta, { name: nome }))) return
    setFirmwareOcupado(nome)
    try {
      const res = await platformAPI.deleteUnownedFirmware(tenant.id, nome)
      if (res.success) {
        toast.success(t('platform.genieacs.firmwareDeleted', { name: nome }))
        setSemDono((atual) => (atual ? { ...atual, files: atual.files.filter((f) => f.id !== nome) } : atual))
      } else {
        toast.error(erroDeFirmware(res))
      }
    } finally {
      setFirmwareOcupado(null)
    }
  }

  if (!data) {
    return <p className="py-3 text-sm text-muted-foreground">{t('common.loading')}</p>
  }

  return (
    <div className="space-y-4 py-3">
      <div>
        <h3 className="font-semibold text-foreground">{t('platform.genieacs.title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.genieacs.description')}</p>
      </div>

      <div>
        <label htmlFor={`tenant-${tenant.id}-acs-ownership`} className="block text-sm font-medium mb-1">
          {t('platform.genieacs.ownership')}
        </label>
        <select
          id={`tenant-${tenant.id}-acs-ownership`}
          className="modern-input w-full md:w-80"
          value={ownership}
          onChange={(e) => setOwnership(e.target.value as GenieAcsOwnership)}
        >
          <option value="platform">{t('platform.genieacs.ownershipPlatform')}</option>
          <option value="own">{t('platform.genieacs.ownershipOwn')}</option>
        </select>
        <p className="field-hint">
          {t(ownership === 'own' ? 'platform.genieacs.ownershipOwnHint' : 'platform.genieacs.ownershipPlatformHint')}
        </p>
      </div>

      <div>
        <label htmlFor={`tenant-${tenant.id}-acs-url`} className="block text-sm font-medium mb-1">
          {t('settings.general.genieAcsUrl')}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={`tenant-${tenant.id}-acs-url`}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="modern-input flex-1 font-mono"
            placeholder={data.suggestion || 'http://acs.exemplo.com:7557'}
            autoComplete="off"
          />
          {data.suggestion && data.suggestion !== url && (
            <button type="button" className="modern-button-secondary" onClick={() => setUrl(data.suggestion || '')}>
              {t('platform.genieacs.useSuggestion')}
            </button>
          )}
        </div>
        <p className="field-hint">{t('settings.general.urlHint', { path: '/devices' })}</p>
      </div>

      <div>
        <label htmlFor={`tenant-${tenant.id}-acs-mode`} className="block text-sm font-medium mb-1">
          {t('platform.genieacs.mode')}
        </label>
        <select
          id={`tenant-${tenant.id}-acs-mode`}
          className="modern-input w-full md:w-80"
          value={mode}
          onChange={(e) => setMode(e.target.value as GenieAcsConnectionMode)}
        >
          {modeOptions('console', true, mode).map((opcao) => (
            <option key={opcao} value={opcao}>{t(MODE_LABELS[opcao])}</option>
          ))}
        </select>
        <p className="field-hint">{t(MODE_HINTS[mode])}</p>
      </div>

      {/* O bloco aparece com o SELETOR em Agente — a pessoa vê o que vem
          antes de salvar —, mas a chave só é gerada com o modo gravado: ver
          `keyButtonState`. O console é de administrador da plataforma, que
          sempre pode gravar o GenieACS de um provedor. */}
      {mode === 'agent' && (
        <GenieAcsAgentPanel
          idPrefix={`tenant-${tenant.id}`}
          initialStatus={data.agent ?? null}
          savedMode={data.mode ?? 'direct'}
          canWrite
          fetchStatus={() => platformAPI.getTenantGenieAcs(tenant.id)}
          generateToken={() => platformAPI.generateTenantGenieAcsAgentToken(tenant.id)}
          onStatus={guardarAgente}
        />
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <label htmlFor={`tenant-${tenant.id}-acs-auth`} className="block text-sm font-medium mb-1">
            {t('settings.genieAuth.type')}
          </label>
          <select
            id={`tenant-${tenant.id}-acs-auth`}
            className="modern-input w-full"
            value={authType}
            onChange={(e) => setAuthType(e.target.value as GenieAcsAuthType)}
          >
            {data.auth.authTypes.filter((type) => AUTH_LABELS[type]).map((type) => (
              <option key={type} value={type}>{t(AUTH_LABELS[type])}</option>
            ))}
          </select>
        </div>
        {authType === 'basic' && (
          <div>
            <label htmlFor={`tenant-${tenant.id}-acs-user`} className="block text-sm font-medium mb-1">
              {t('settings.genieAuth.username')}
            </label>
            <input
              id={`tenant-${tenant.id}-acs-user`}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="modern-input w-full"
              autoComplete="off"
            />
          </div>
        )}
        {authType !== 'none' && (
          <div>
            <label htmlFor={`tenant-${tenant.id}-acs-secret`} className="block text-sm font-medium mb-1">
              {t(authType === 'basic' ? 'settings.genieAuth.password' : 'settings.genieAuth.token')}
            </label>
            <input
              id={`tenant-${tenant.id}-acs-secret`}
              type="password"
              autoComplete="new-password"
              value={secret}
              disabled={clearSecret}
              onChange={(e) => setSecret(e.target.value)}
              className="modern-input w-full"
              placeholder={t(data.auth.secretConfigured
                ? 'settings.genieAuth.placeholderStored'
                : 'settings.genieAuth.placeholderEmpty')}
            />
            {data.auth.secretConfigured && (
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={clearSecret} onChange={(e) => setClearSecret(e.target.checked)} />
                {t('settings.genieAuth.clear')}
              </label>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-border pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="font-semibold text-foreground">{t('settings.vp.title')}</h4>
            <p className="mt-1 text-sm text-muted-foreground">{t('platform.genieacs.vpDescription')}</p>
          </div>
          <button
            type="button"
            className="modern-button-secondary shrink-0"
            onClick={() => setVps((atual) => ({ ...atual, ...INSTALLER_VIRTUAL_PARAMETERS }))}
          >
            <Icon name="refresh" size={17} />
            {t('settings.vp.usePreset')}
          </button>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          {VIRTUAL_PARAMETER_FIELDS.map((field) => (
            <div key={field.key}>
              <label htmlFor={`tenant-${tenant.id}-${field.key}`} className="block text-sm font-medium mb-1">
                {t(field.labelKey)}
              </label>
              <input
                id={`tenant-${tenant.id}-${field.key}`}
                value={vps[field.key] ?? ''}
                placeholder={field.hintKey ? t('settings.vp.optionalPlaceholder') : undefined}
                onChange={(e) => setVps((atual) => ({ ...atual, [field.key]: e.target.value }))}
                className="modern-input w-full font-mono text-sm"
                autoComplete="off"
              />
              <p className="field-hint">{field.hintKey ? t(field.hintKey) : field.parameterName}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <h4 className="font-semibold text-foreground">{t('platform.genieacs.scopeTitle')}</h4>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.genieacs.scopeDescription')}</p>

        {data.sharedAcs.providers.length > 0 && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3">
            <Icon
              name="warning"
              size={16}
              className={`mt-0.5 shrink-0 ${data.sharedAcs.missingTag ? 'text-[hsl(var(--status-danger))]' : 'text-[hsl(var(--status-warning))]'}`}
            />
            <div className="text-sm leading-6">
              <p className="font-medium">
                {t(data.sharedAcs.missingTag ? 'platform.genieacs.sharedMissingTag' : 'platform.genieacs.sharedOk')}
              </p>
              <ul className="mt-1 list-disc pl-5">
                {data.sharedAcs.providers.map((p) => (
                  <li key={p.id}>
                    {p.name}: {p.deviceTag
                      ? <span className="font-mono">{p.deviceTag}</span>
                      : <span className="text-[hsl(var(--status-danger))]">{t('platform.genieacs.noTag')}</span>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <div className="mt-4 max-w-sm">
          <label htmlFor={`tenant-${tenant.id}-acs-tag`} className="block text-sm font-medium mb-1">
            {t('platform.genieacs.deviceTag')}
          </label>
          <input
            id={`tenant-${tenant.id}-acs-tag`}
            value={deviceTag}
            onChange={(e) => setDeviceTag(e.target.value)}
            className="modern-input w-full font-mono"
            placeholder={(tenant.slug || 'provedor').replace(/-/g, '_')}
            maxLength={64}
            pattern="[A-Za-z0-9_]*"
            autoComplete="off"
          />
          <p className="field-hint">{t('platform.genieacs.deviceTagHint')}</p>
        </div>

        <div className="mt-4 max-w-xl">
          <label htmlFor={`tenant-${tenant.id}-acs-auto`} className="block text-sm font-medium mb-1">
            {t('platform.genieacs.autoTagPrefixes')}
          </label>
          <input
            id={`tenant-${tenant.id}-acs-auto`}
            value={autoPrefixes}
            onChange={(e) => setAutoPrefixes(e.target.value)}
            className="modern-input w-full font-mono"
            placeholder="TA100, TA200"
            disabled={!deviceTag.trim()}
            autoComplete="off"
          />
          <p className="field-hint">{t('platform.genieacs.autoTagHint')}</p>
          {data.lastAutoTag && (
            <p className={`mt-1 text-sm ${data.lastAutoTag.error ? 'text-[hsl(var(--status-danger))]' : 'text-muted-foreground'}`}>
              {data.lastAutoTag.error
                ? t('platform.genieacs.autoTagFailed', { when: formatDateTime(data.lastAutoTag.at) })
                : t('platform.genieacs.autoTagLast', {
                  when: formatDateTime(data.lastAutoTag.at),
                  tagged: data.lastAutoTag.tagged,
                  conflicts: data.lastAutoTag.conflictCount
                })}
            </p>
          )}
        </div>

        {data.deviceTag && (
          <div className="mt-4 rounded-md border border-border p-4">
            <h5 className="font-medium text-foreground">{t('platform.genieacs.bulkTitle', { tag: data.deviceTag })}</h5>
            <p className="mt-1 text-sm text-muted-foreground">{t('platform.genieacs.bulkDescription')}</p>
            <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label htmlFor={`tenant-${tenant.id}-tag-prefix`} className="block text-sm font-medium mb-1">
                  {t('platform.genieacs.pppoePrefix')}
                </label>
                <input
                  id={`tenant-${tenant.id}-tag-prefix`}
                  value={pppoePrefix}
                  onChange={(e) => { setPppoePrefix(e.target.value); setPreview(null) }}
                  className="modern-input w-full font-mono"
                  placeholder="TA100"
                  autoComplete="off"
                />
              </div>
              <div>
                <label htmlFor={`tenant-${tenant.id}-tag-serials`} className="block text-sm font-medium mb-1">
                  {t('platform.genieacs.serials')}
                </label>
                <textarea
                  id={`tenant-${tenant.id}-tag-serials`}
                  value={serials}
                  onChange={(e) => { setSerials(e.target.value); setPreview(null) }}
                  className="modern-input w-full font-mono text-sm"
                  rows={3}
                  placeholder="ZTEG12345678"
                />
              </div>
            </div>

            {preview && (
              <div className="mt-3 text-sm leading-6">
                <p>{t('platform.genieacs.previewSummary', {
                  matched: preview.matched, toTag: preview.toTag, already: preview.alreadyTagged, conflicts: preview.conflictCount
                })}</p>
                {preview.conflictCount > 0 && (
                  <div className="mt-2">
                    <p className="text-[hsl(var(--status-warning))]">{t('platform.genieacs.conflictsHint')}</p>
                    <ul className="mt-1 list-disc pl-5 font-mono text-xs">
                      {preview.conflicts.map((c) => (
                        <li key={c.id}>{c.serial || c.id}{c.pppoe ? ` · ${c.pppoe}` : ''} → {c.tags.join(', ')}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="modern-button-secondary"
                disabled={tagging || (!pppoePrefix.trim() && !serials.trim())}
                onClick={() => void marcar(false)}
              >
                {t('platform.genieacs.preview')}
              </button>
              {preview && preview.toTag > 0 && (
                <button type="button" className="modern-button" disabled={tagging} onClick={() => void marcar(true)}>
                  {t('platform.genieacs.applyTag', { count: preview.toTag })}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Firmware sem dono: depois da tag, porque o reenvio depende dela —
            o nome novo é `<tag>--<nome>`. */}
        <div className="mt-4 rounded-md border border-border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h5 className="font-medium text-foreground">{t('platform.genieacs.firmwareTitle')}</h5>
              <p className="mt-1 text-sm text-muted-foreground">{t('platform.genieacs.firmwareDescription')}</p>
            </div>
            <button
              type="button"
              className="modern-button-secondary shrink-0"
              disabled={firmwareOcupado !== null}
              onClick={() => void carregarSemDono()}
            >
              <Icon name="refresh" size={16} />
              {t('platform.genieacs.firmwareRefresh')}
            </button>
          </div>

          {semDonoErro && <p className="mt-3 text-sm text-[hsl(var(--status-danger))]">{semDonoErro}</p>}
          {!semDono && !semDonoErro && <p className="mt-3 text-sm text-muted-foreground">{t('common.loading')}</p>}

          {semDono && !semDono.shared && (
            <p className="mt-3 text-sm text-muted-foreground">{t('platform.genieacs.firmwareNotShared')}</p>
          )}

          {semDono && semDono.shared && (
            <div className="mt-3 space-y-3 text-sm">
              {semDono.tag ? (
                <p className="field-hint">
                  {t('platform.genieacs.firmwarePrefixHint', { prefix: `${semDono.tag}--` })}
                </p>
              ) : (
                <p className="flex items-start gap-2 text-[hsl(var(--status-warning))]">
                  <Icon name="warning" size={16} className="mt-0.5 shrink-0" />
                  {t('platform.genieacs.firmwareNeedsTag')}
                </p>
              )}

              {semDono.files.length === 0 ? (
                <p className="text-muted-foreground">{t('platform.genieacs.firmwareNone')}</p>
              ) : (
                <ul className="space-y-2">
                  {semDono.files.map((file) => {
                    const ocupado = firmwareOcupado === file.id
                    const novo = reenviados[file.id]
                    const detalhes = [
                      file.version,
                      file.productClass,
                      file.oui ? `OUI ${file.oui}` : null,
                      formatFileSize(file.size),
                      file.uploadedAt ? formatDateTime(file.uploadedAt) : null
                    ].filter(Boolean)
                    const inputId = `tenant-${tenant.id}-fw-${file.id}`
                    return (
                      <li key={file.id} className="rounded-lg border border-border p-3">
                        <p className="break-all font-mono text-xs text-foreground">{file.id}</p>
                        {detalhes.length > 0 && (
                          <p className="text-xs text-muted-foreground">{detalhes.join(' · ')}</p>
                        )}
                        {novo && (
                          <p className="mt-1 flex items-center gap-1 text-xs text-[hsl(var(--status-success))]">
                            <Icon name="check" size={14} />
                            {t('platform.genieacs.firmwareReassignedAs', { name: novo })}
                          </p>
                        )}
                        {semDono.tag && !novo && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t('platform.genieacs.firmwareWillBecome', { name: scopedFirmwareName(semDono.tag, file.id) })}
                          </p>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {/* O arquivo é escolhido no computador: o painel não
                              baixa o antigo do GenieACS para regravá-lo. */}
                          <input
                            id={inputId}
                            type="file"
                            className="sr-only"
                            disabled={!semDono.tag || firmwareOcupado !== null}
                            onChange={(e) => {
                              const escolhido = e.target.files?.[0]
                              e.target.value = ''
                              if (escolhido) void reenviar(file, escolhido)
                            }}
                          />
                          <label
                            htmlFor={inputId}
                            aria-disabled={!semDono.tag || firmwareOcupado !== null}
                            className={`modern-button-secondary ${!semDono.tag || firmwareOcupado !== null ? 'pointer-events-none opacity-50' : 'cursor-pointer'}`}
                          >
                            {ocupado && reenviando ? t('platform.genieacs.firmwareSending') : t('platform.genieacs.firmwareReassign')}
                          </label>
                          <button
                            type="button"
                            className="modern-button-secondary"
                            disabled={firmwareOcupado !== null}
                            onClick={() => void apagarAntigo(file.id)}
                          >
                            <Icon name="trash" size={16} />
                            {t('platform.genieacs.firmwareDeleteOld')}
                          </button>
                        </div>
                        {!novo && file.size !== null && (
                          <p className="field-hint">
                            {t('platform.genieacs.firmwareSameSize', { size: formatFileSize(file.size) ?? '', bytes: String(file.size) })}
                          </p>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      {testMessage && (
        <p className={`flex items-center gap-2 text-sm ${testMessage.ok ? 'text-[hsl(var(--status-success))]' : 'text-[hsl(var(--status-danger))]'}`}>
          <Icon name={testMessage.ok ? 'check' : 'x'} size={16} />
          {testMessage.text}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void salvar()} disabled={saving} className="modern-button">
          {saving ? t('common.saving') : t('platform.data.save')}
        </button>
        <button type="button" onClick={() => void testar()} disabled={testing || !url.trim()} className="modern-button-secondary">
          {testing ? t('settings.general.testing') : t('settings.general.testConnection')}
        </button>
      </div>
    </div>
  )
}
