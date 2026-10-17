import { useEffect, useState } from 'react'

/**
 * A largura real do contêiner, para o SVG desenhar nela em vez de escalar um
 * `viewBox` fixo — escalado, o texto de 11px virava 5px no celular.
 *
 * Ref de callback e não `useRef`: o gráfico troca de elemento raiz (vazio ↔
 * desenho), e o observador tem que acompanhar o elemento novo.
 */
export function useChartWidth<T extends HTMLElement>(fallback: number) {
  const [element, setElement] = useState<T | null>(null)
  const [width, setWidth] = useState(fallback)

  useEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const next = Math.round(element.clientWidth)
      if (next > 0) setWidth(next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  return [setElement, width] as const
}
