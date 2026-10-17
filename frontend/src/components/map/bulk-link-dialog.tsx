import { useMemo, useState } from 'react'
import { useTranslation } from '@/contexts/language-context'
import { Icon } from '@/components/ui/icon'
import { mappingAPI } from '@/lib/api'
import { chunk } from '@/lib/bulk-place'
import { uniqueId } from '@/lib/kml-import'
import type { OccupancyEdge, OccupancyNode } from '@/lib/box-occupancy'
import { DROP_LIMITS, LINK_DEFAULT_METERS, planBulkLinks } from '@/lib/nearest-box'

/**
 * "Ligar clientes às caixas": cada cliente do mapa sem cabo ganha o drop até
 * a CTO livre mais próxima dentro do raio escolhido. Sem esse cabo, o cliente
 * não conta nas portas da caixa nem no alerta de rompimento.
 *
 * A prévia vem de `planBulkLinks`, que nunca passa da capacidade da caixa. Os
 * cabos vão pelo `/import`, em lotes: acrescenta e pula o que já existe.
 */
export function BulkLinkDialog<T extends OccupancyNode>({ nodes, edges, edgeIds, onClose, onDone }: {
  nodes: T[]
  edges: OccupancyEdge[]
  edgeIds: string[]
  onClose: () => void
  onDone: (created: number) => void
}) {
  const { t } = useTranslation()
  const [maxMeters, setMaxMeters] = useState<number>(LINK_DEFAULT_METERS)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const plan = useMemo(() => planBulkLinks(nodes, edges, { maxMeters }), [edges, maxMeters, nodes])
  const chosen = plan.links.filter((link) => !excluded.has(link.client.node_id))

  const toggle = (id: string) => setExcluded((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const save = async () => {
    const taken = new Set(edgeIds)
    const cables = chosen.map((link) => ({
      edge_id: uniqueId(`drop-${link.client.node_id}`, taken),
      source: link.box.node_id,
      target: link.client.node_id,
      fiber_type: 'drop',
      distance: link.distance
    }))
    const batches = chunk(cables)
    let created = 0
    setError(null)
    setSaving({ done: 0, total: batches.length })
    try {
      for (const [index, batch] of batches.entries()) {
        const response = await mappingAPI.importData({ nodes: [], edges: batch })
        if (!response.success || !response.data) throw new Error(response.message || t('map.link.failed'))
        created += response.data.createdEdges
        setSaving({ done: index + 1, total: batches.length })
      }
      onDone(created)
    } catch (err) {
      // Os lotes que já entraram ficam; repetir pula quem já tem cabo.
      setError(err instanceof Error ? err.message : t('map.link.failed'))
      setSaving(null)
      if (created) onDone(created)
    }
  }

  return (
    <div className="modal-backdrop z-2300 bg-black/65" role="dialog" aria-modal="true">
      <div className="modal-panel modern-card flex max-w-2xl flex-col p-5 sm:p-6">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="section-heading">{t('map.link.title')}</h2>
          <button type="button" onClick={onClose} className="icon-button" aria-label={t('common.close')} disabled={saving !== null}><Icon name="x" size={20} /></button>
        </div>
        <p className="mb-3 text-sm text-muted-foreground">{t('map.link.hint')}</p>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="link-radius" className="font-semibold">{t('map.link.radius')}</label>
          <select id="link-radius" className="modern-input w-auto" value={maxMeters} disabled={saving !== null}
            onChange={(event) => { setMaxMeters(Number(event.target.value)); setExcluded(new Set()) }}>
            {DROP_LIMITS.map((meters) => <option key={meters} value={meters}>{t('map.link.meters', { meters })}</option>)}
          </select>
          <span className="text-muted-foreground">{t('map.link.summary', { linked: plan.links.length, unreachable: plan.unreachable.length })}</span>
        </div>
        {error && <p className="mb-3 text-sm text-destructive" role="alert">{error}</p>}
        <ul className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
          {plan.links.map((link) => (
            <li key={link.client.node_id} className="flex items-center gap-3 border-t border-border px-3 py-2 first:border-t-0">
              <input type="checkbox" checked={!excluded.has(link.client.node_id)} disabled={saving !== null}
                aria-label={link.client.name} onChange={() => toggle(link.client.node_id)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{link.client.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {t('map.link.to', { box: link.box.name, meters: link.distance })}
                </span>
              </span>
              {link.unknownCapacity && <span className="shrink-0 text-xs text-amber-600" title={t('map.link.unknownCapacityHint')}>{t('map.link.unknownCapacity')}</span>}
            </li>
          ))}
          {!plan.links.length && <li className="py-8 text-center text-sm text-muted-foreground">{t('map.link.empty')}</li>}
        </ul>
        {plan.unreachable.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{t('map.link.unreachableHint', { count: plan.unreachable.length })}</p>}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {saving && <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">{t('map.link.saving', { done: saving.done, total: saving.total })}</span>}
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={saving !== null}>{t('common.cancel')}</button>
          <button type="button" className="modern-button" onClick={() => void save()} disabled={saving !== null || !chosen.length}>
            <Icon name="signal" size={17} />{t('map.link.save', { count: chosen.length })}
          </button>
        </div>
      </div>
    </div>
  )
}
