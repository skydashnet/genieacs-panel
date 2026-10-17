import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/contexts/language-context'
import { Icon } from '@/components/ui/icon'
import { mappingAPI, type BulkPlacement } from '@/lib/api'
import { buildBulkNodes, chunk, selectedByDefault, type BulkCandidate, type BulkPrecision } from '@/lib/bulk-place'

/**
 * "Colocar todos no mapa": os clientes fora do mapa cujo endereço o SGP já
 * tem, colocados de uma vez.
 *
 * - com coordenadas no SGP, entram direto (marcados);
 * - só com endereço, o botão "Localizar pelo endereço" passa um a um pelo
 *   Nominatim, no ritmo que ele permite; os achados pela rua entram marcados
 *   com "confira", os de só a cidade entram desmarcados;
 * - sem endereço, ficam para colocar um a um.
 *
 * A gravação vai pelo `/import`, em lotes: acrescenta, e o que já estiver no
 * mapa é pulado. O cabo até a caixa não é criado aqui.
 */

/** Pausa entre um cliente e o próximo: o Nominatim aceita 1 consulta por segundo, e cada cliente pode gastar duas. */
const LOCATE_PAUSE_MS = 2100

const PRECISION_KEY = {
  sgp: 'map.bulk.fromSgp',
  address: 'map.bulk.fromAddress',
  city: 'map.bulk.fromCity'
} as const

export function BulkPlaceDialog({ existingIds, onClose, onDone }: {
  existingIds: string[]
  onClose: () => void
  onDone: (created: number) => void
}) {
  const { t } = useTranslation()
  const [data, setData] = useState<BulkPlacement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<BulkCandidate[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [locating, setLocating] = useState<{ done: number; total: number } | null>(null)
  const [notFound, setNotFound] = useState(0)
  const [located, setLocated] = useState(false)
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null)
  const cancelRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void mappingAPI.bulkPlacement()
      .then((response) => {
        if (cancelled) return
        if (!response.success || !response.data) { setError(response.message || t('map.bulk.failed')); return }
        setData(response.data)
        const ready: BulkCandidate[] = response.data.ready.map((item) => ({
          pppoe: item.pppoe, deviceId: item.deviceId, clientName: item.clientName ?? null,
          address: item.address ?? null, lat: item.lat, lng: item.lng, precision: 'sgp'
        }))
        setCandidates(ready)
        setSelected(new Set(ready.map((item) => item.pppoe)))
      })
      .catch(() => { if (!cancelled) setError(t('map.bulk.failed')) })
    return () => { cancelled = true; cancelRef.current = true }
  }, [t])

  const locate = async () => {
    const pending = data?.needsAddress ?? []
    if (!pending.length) return
    cancelRef.current = false
    setLocating({ done: 0, total: pending.length })
    let missed = 0
    for (const [index, item] of pending.entries()) {
      if (cancelRef.current) break
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, LOCATE_PAUSE_MS))
      if (cancelRef.current) break
      try {
        const response = await mappingAPI.clientLocation(item.pppoe, item.deviceId)
        const found = response.success ? response.data : null
        if (found && typeof found.lat === 'number' && typeof found.lng === 'number') {
          const candidate: BulkCandidate = {
            pppoe: item.pppoe, deviceId: item.deviceId, clientName: found.clientName ?? item.clientName ?? null,
            address: found.address ?? item.address ?? null, lat: found.lat, lng: found.lng,
            precision: (found.precision ?? 'address') as BulkPrecision
          }
          setCandidates((current) => current.some((row) => row.pppoe === candidate.pppoe) ? current : [...current, candidate])
          if (selectedByDefault(candidate)) setSelected((current) => new Set(current).add(candidate.pppoe))
        } else {
          missed += 1
        }
      } catch {
        missed += 1
      }
      setNotFound(missed)
      setLocating({ done: index + 1, total: pending.length })
    }
    setLocating(null)
    setLocated(true)
  }

  const toggle = (pppoe: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(pppoe)) next.delete(pppoe)
    else next.add(pppoe)
    return next
  })

  const chosen = useMemo(() => candidates.filter((item) => selected.has(item.pppoe)), [candidates, selected])

  const save = async () => {
    const nodes = buildBulkNodes(chosen, existingIds, (precision) => (precision === 'sgp' ? null : t('map.bulk.note')))
    const batches = chunk(nodes)
    let created = 0
    setError(null)
    setSaving({ done: 0, total: batches.length })
    try {
      for (const [index, batch] of batches.entries()) {
        const response = await mappingAPI.importData({ nodes: batch, edges: [] })
        if (!response.success || !response.data) throw new Error(response.message || t('map.bulk.saveFailed'))
        created += response.data.createdNodes
        setSaving({ done: index + 1, total: batches.length })
      }
      onDone(created)
    } catch (err) {
      // Os lotes que já entraram ficam; repetir pula quem já está no mapa.
      setError(err instanceof Error ? err.message : t('map.bulk.saveFailed'))
      setSaving(null)
      if (created) onDone(created)
    }
  }

  const busy = locating !== null || saving !== null
  const noContract = data?.noAddress.filter((item) => item.reason === 'no_contract').length ?? 0
  const noAddress = (data?.noAddress.length ?? 0) - noContract

  return (
    <div className="modal-backdrop z-2300 bg-black/65" role="dialog" aria-modal="true">
      <div className="modal-panel modern-card flex max-w-2xl flex-col p-5 sm:p-6">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="section-heading">{t('map.bulk.title')}</h2>
          <button type="button" onClick={onClose} className="icon-button" aria-label={t('common.close')} disabled={saving !== null}><Icon name="x" size={20} /></button>
        </div>
        <p className="mb-3 text-sm text-muted-foreground">{t('map.bulk.hint')}</p>
        {error && <p className="mb-3 text-sm text-destructive" role="alert">{error}</p>}
        {!data && !error && <p className="text-sm text-muted-foreground">{t('map.bulk.loading')}</p>}
        {data && (
          <>
            <ul className="mb-3 space-y-1 text-sm">
              <li className="flex items-center gap-2"><Icon name="check" size={15} className="text-emerald-600" />{t('map.bulk.ready', { count: data.ready.length })}</li>
              {data.needsAddress.length > 0 && (
                <li className="flex flex-wrap items-center gap-2">
                  <Icon name="pin" size={15} className="text-amber-600" />{t('map.bulk.needsAddress', { count: data.needsAddress.length })}
                  {!located && !locating && (
                    <button type="button" className="modern-button-secondary min-h-10 px-3 text-xs sm:min-h-8" onClick={() => void locate()} disabled={saving !== null}>
                      {t('map.bulk.locate')}
                    </button>
                  )}
                  {locating && (
                    <>
                      <span className="text-xs text-muted-foreground" aria-live="polite">{t('map.bulk.locating', { done: locating.done, total: locating.total })}</span>
                      <button type="button" className="modern-button-secondary min-h-10 px-3 text-xs sm:min-h-8" onClick={() => { cancelRef.current = true }}>{t('common.cancel')}</button>
                    </>
                  )}
                  {located && notFound > 0 && <span className="text-xs text-muted-foreground">{t('map.bulk.notFound', { count: notFound })}</span>}
                </li>
              )}
              {data.noAddress.length > 0 && (
                <li className="flex items-center gap-2 text-muted-foreground">
                  <Icon name="warning" size={15} />{t('map.bulk.noAddress', { contract: noContract, address: noAddress })}
                </li>
              )}
              {data.truncated && <li className="text-xs text-muted-foreground">{t('map.bulk.truncated', { total: data.total })}</li>}
            </ul>
            <ul className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
              {candidates.map((item) => (
                <li key={item.pppoe} className="flex items-start gap-3 border-t border-border px-3 py-2 first:border-t-0">
                  <input type="checkbox" className="mt-1" checked={selected.has(item.pppoe)} disabled={busy}
                    aria-label={item.clientName || item.pppoe} onChange={() => toggle(item.pppoe)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{item.clientName || item.pppoe}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{item.pppoe}</span>
                    {item.address && <span className="block truncate text-xs text-muted-foreground">{item.address}</span>}
                  </span>
                  <span className={`shrink-0 text-xs ${item.precision === 'sgp' ? 'text-emerald-600' : 'text-amber-600'}`}>{t(PRECISION_KEY[item.precision])}</span>
                </li>
              ))}
              {!candidates.length && <li className="py-8 text-center text-sm text-muted-foreground">{t('map.bulk.empty')}</li>}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">{t('map.bulk.cableHint')}</p>
          </>
        )}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {saving && <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">{t('map.bulk.saving', { done: saving.done, total: saving.total })}</span>}
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={saving !== null}>{t('common.cancel')}</button>
          <button type="button" className="modern-button" onClick={() => void save()} disabled={busy || !chosen.length}>
            <Icon name="pin" size={17} />{t('map.bulk.save', { count: chosen.length })}
          </button>
        </div>
      </div>
    </div>
  )
}
