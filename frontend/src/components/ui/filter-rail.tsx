import { useCallback, useState } from 'react'

/**
 * Uma escolha de filtro salva no navegador sob `storageKey`. `parse` decide o
 * que fazer com valor ausente ou inválido. Sem armazenamento disponível, a
 * escolha vale só para esta visita.
 */
export function useStoredChoice<T extends string>(storageKey: string, parse: (value: string | null) => T) {
  const [value, setValueState] = useState<T>(() => {
    try {
      return parse(localStorage.getItem(storageKey))
    } catch {
      return parse(null)
    }
  })

  const setValue = useCallback((next: T) => {
    setValueState(next)
    try {
      localStorage.setItem(storageKey, next)
    } catch {
      // Sem armazenamento, a escolha vale só para esta visita.
    }
  }, [storageKey])

  return [value, setValue] as const
}

interface FilterRailProps<T extends string> {
  value: T
  onChange: (next: T) => void
  options: ReadonlyArray<{ value: T; label: string }>
  ariaLabel: string
  className?: string
}

/** Botões de filtro no mesmo visual das abas (`tab-rail`). */
export function FilterRail<T extends string>({ value, onChange, options, ariaLabel, className }: FilterRailProps<T>) {
  return (
    <div className={['tab-rail', className].filter(Boolean).join(' ')} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className="tab-button"
          data-active={value === option.value}
          aria-pressed={value === option.value}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
