import { FilterRail, useStoredChoice } from '@/components/ui/filter-rail'
import { useTranslation } from '@/contexts/language-context'
import { parseWifiStatusFilter, type WifiStatusFilter } from '@/lib/wifi-filter'

/**
 * O filtro escolhido fica salvo no navegador, por tela (painel e portal têm
 * chaves próprias), para não voltar a "Todas" a cada equipamento aberto.
 */
export function useWifiStatusFilter(storageKey: string) {
  return useStoredChoice<WifiStatusFilter>(storageKey, parseWifiStatusFilter)
}

interface WifiStatusFilterProps {
  value: WifiStatusFilter
  onChange: (next: WifiStatusFilter) => void
  counts: Record<WifiStatusFilter, number>
  className?: string
}

export function WifiStatusFilterControl({ value, onChange, counts, className }: WifiStatusFilterProps) {
  const { t } = useTranslation()
  return (
    <FilterRail
      value={value}
      onChange={onChange}
      ariaLabel={t('detail.wifi.filterAria')}
      className={className}
      options={[
        { value: 'all', label: t('detail.wifi.filterAll', { count: counts.all }) },
        { value: 'enabled', label: t('detail.wifi.filterEnabled', { count: counts.enabled }) },
        { value: 'disabled', label: t('detail.wifi.filterDisabled', { count: counts.disabled }) },
        // Só aparece quando há redes sem estado informado (ou quando é a
        // escolha salva, para o filtro ativo nunca sumir da barra).
        ...(counts.unknown > 0 || value === 'unknown'
          ? [{ value: 'unknown' as const, label: t('detail.wifi.filterUnknown', { count: counts.unknown }) }]
          : []),
      ]}
    />
  )
}
