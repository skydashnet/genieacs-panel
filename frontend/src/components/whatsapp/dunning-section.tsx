'use client'

import { useState } from 'react'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { BillingPanel } from './billing-panel'
import { DunningHistoryPanel } from './dunning-history-panel'
import { DunningRulePanel } from './dunning-rule-panel'

type View = 'auto' | 'manual' | 'history'

const VIEWS: [View, TranslationKey][] = [
  ['history', 'whatsapp.dunning.tabHistory'],
  ['auto', 'whatsapp.dunning.tabAuto'],
  ['manual', 'whatsapp.dunning.tabManual']
]

/**
 * The "Régua de cobrança" tab: what the automatic cadence has done, the
 * cadence itself, and the one-off builder that was here first.
 *
 * Results first because it is what an operator opens the tab to check every
 * day; the cadence is edited rarely, and the one-off builder keeps its rule —
 * building never sends — one click away. Only the open view is mounted: the one-off builder calls the ERP once per subscriber the
 * moment it appears, and nobody who came to edit the steps asked for that.
 */
export function DunningSection() {
  const { t } = useTranslation()
  const [view, setView] = useState<View>('history')

  return (
    <div className="space-y-5">
      <div className="tab-rail" role="tablist" aria-label={t('whatsapp.billing.title')}>
        {VIEWS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="tab-button"
            role="tab"
            data-active={view === id}
            aria-selected={view === id}
            onClick={() => setView(id)}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {view === 'auto' && <DunningRulePanel />}
      {view === 'manual' && <BillingPanel />}
      {view === 'history' && <DunningHistoryPanel />}
    </div>
  )
}
