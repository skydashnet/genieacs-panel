'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Aparece ao entrar na tela: sobe e acende uma vez, e fica.
 *
 * Quem pediu movimento reduzido — e navegador sem `IntersectionObserver` —
 * vê tudo de uma vez, parado: a animação é enfeite, nunca condição para o
 * conteúdo aparecer.
 */
export function Reveal({ children, className = '', delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [visivel, setVisivel] = useState(() => (
    typeof window === 'undefined'
    || typeof IntersectionObserver === 'undefined'
    || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  ))

  useEffect(() => {
    if (visivel || !ref.current) return undefined
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisivel(true)
        observer.disconnect()
      }
    }, { rootMargin: '0px 0px -10% 0px' })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [visivel])

  return (
    <div
      ref={ref}
      style={{ transitionDelay: visivel ? `${delay}ms` : '0ms' }}
      className={`transition-all duration-700 ease-out ${visivel ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'} ${className}`}
    >
      {children}
    </div>
  )
}

export default Reveal
