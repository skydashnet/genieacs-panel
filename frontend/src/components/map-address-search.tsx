import { useState, type FormEvent } from 'react'
import { useTranslation } from '@/contexts/language-context'
import { mappingAPI, type PlaceResult } from '@/lib/api'
import { Icon } from '@/components/ui/icon'

/**
 * Caixa "Buscar endereço" da Topologia.
 *
 * Busca só ao Enter ou no botão, nunca a cada tecla: quem responde é o
 * Nominatim, que pede uma consulta por segundo para o painel inteiro.
 */
export function MapAddressSearch({ onPick, initialQuery = '', className }: {
  onPick: (place: PlaceResult) => void
  /** O que a caixa já traz escrito — o endereço do SGP, no "Colocar no mapa". */
  initialQuery?: string
  className?: string
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState(initialQuery)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<PlaceResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const search = async (event?: FormEvent) => {
    event?.preventDefault()
    const term = q.trim()
    if (term.length < 3) {
      setError(t('map.search.tooShort'))
      setResults(null)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const response = await mappingAPI.searchAddress(term)
      if (!response.success) {
        setError(response.message || t('map.search.failed'))
        setResults(null)
        return
      }
      const list = Array.isArray(response.data) ? response.data : []
      setResults(list)
      if (list.length === 1) {
        onPick(list[0])
        setResults(null)
      }
    } catch {
      setError(t('map.search.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={className ?? 'relative w-full sm:w-80'}>
      <form onSubmit={search} className="flex gap-2" role="search">
        <input
          type="search"
          value={q}
          onChange={(event) => { setQ(event.target.value); setError(null) }}
          onKeyDown={(event) => { if (event.key === 'Escape') setResults(null) }}
          placeholder={t('map.search.placeholder')}
          aria-label={t('map.search.placeholder')}
          maxLength={200}
          className="modern-input min-h-11 min-w-0 flex-1 text-sm sm:min-h-9"
        />
        <button type="submit" className="modern-button-secondary min-h-11 min-w-11 px-3 sm:min-h-9 sm:min-w-0" disabled={busy} aria-label={t('map.search.button')} title={t('map.search.button')}>
          <Icon name={busy ? 'refresh' : 'search'} size={16} className={busy ? 'animate-spin' : ''} />
        </button>
      </form>
      {(error || results) && (
        <div className="absolute inset-x-0 top-full z-1100 mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-card shadow-lg">
          {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
          {results && !results.length && <p className="px-3 py-2 text-xs text-muted-foreground">{t('map.search.empty')}</p>}
          {results?.map((place) => (
            <button
              key={`${place.lat},${place.lng}`}
              type="button"
              onClick={() => { onPick(place); setResults(null) }}
              className="flex min-h-11 w-full items-start gap-2 border-t border-border px-3 py-2 text-start sm:min-h-0 text-xs first:border-t-0 hover:bg-muted"
            >
              <Icon name="pin" size={14} className="mt-0.5 shrink-0" />
              <span className="min-w-0 wrap-anywhere">{place.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
