import { afterEach, describe, expect, it } from 'vitest'

import { loadDictionary, setActiveLocale } from '@/lib/i18n'
import {
  formatDate,
  formatNumber,
  formatRelativeTime
} from '@/lib/utils'
import en from '@/lib/i18n/locales/en'

afterEach(() => {
  setActiveLocale('pt-BR')
})

describe('abbreviating a count', () => {
  it('leaves anything under a thousand alone', () => {
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(1)).toBe('1')
    expect(formatNumber(999)).toBe('999')
  })

  it('abbreviates thousands and millions', () => {
    expect(formatNumber(1000)).toBe('1.0K')
    expect(formatNumber(1500)).toBe('1.5K')
    expect(formatNumber(999999)).toBe('1000.0K')
    expect(formatNumber(1000000)).toBe('1.0M')
    expect(formatNumber(2500000)).toBe('2.5M')
  })

  /**
   * A fleet counter never goes negative, but the function is exported and the
   * behaviour should be written down rather than discovered: below zero it
   * abbreviates nothing.
   */
  it('does not abbreviate a negative', () => {
    expect(formatNumber(-1500)).toBe('-1500')
  })
})

describe('formatting a timestamp', () => {
  const ISO = '2026-03-04T15:06:07.000Z'

  it('renders a real timestamp in the active locale', () => {
    setActiveLocale('pt-BR')
    const rendered = formatDate(ISO)
    // Two-digit, 24-hour, and carrying the date — not asserting the exact
    // punctuation, which belongs to Intl and changes with ICU.
    expect(rendered).toMatch(/\d{2}/)
    expect(rendered).not.toContain('NaN')
  })

  it('says so, translated, when there is nothing to format', () => {
    setActiveLocale('en')
    expect(formatDate(null)).toBe('N/A')
    expect(formatDate(undefined)).toBe('N/A')
    expect(formatDate('')).toBe('N/A')
  })

  /**
   * A malformed timestamp used to render as "Invalid Date" straight from the
   * platform. It has to be a translated string, and it must not be confused
   * with the absent case — one means the field is empty, the other that
   * something upstream sent rubbish.
   */
  it('separates a broken timestamp from an absent one', () => {
    setActiveLocale('en')
    const broken = formatDate('not-a-date')
    expect(broken).not.toBe(formatDate(null))
    expect(broken).not.toContain('NaN')
    expect(broken).toBeTruthy()
  })

  /**
   * The date order is the visible half of the locale: an operator reading
   * `04/03` as April in a Brazilian panel is a real mistake, and it is Intl
   * that prevents it.
   */
  it('orders the date by the active locale', () => {
    setActiveLocale('en')
    const american = formatDate(ISO)
    setActiveLocale('pt-BR')
    const brazilian = formatDate(ISO)

    expect(american).toContain('03/04')
    expect(brazilian).toContain('04/03')
  })

  /**
   * The other half is translated, and it only stops reading English once that
   * locale's dictionary has arrived — which is the documented fallback, not a
   * defect. Loading it here is what makes the difference observable.
   */
  it('translates the absent case once the dictionary has loaded', async () => {
    setActiveLocale('en')
    expect(formatDate(null)).toBe('N/A')

    setActiveLocale('pt-BR')
    // Still English: the chunk has not been asked for yet.
    expect(formatDate(null)).toBe('N/A')

    await loadDictionary('pt-BR')
    expect(formatDate(null)).toBe('N/D')
  })
})

/**
 * Há quanto tempo — a pergunta que a tela do console faz de um provedor parado.
 *
 * A função não tinha teste, e era ela que decidia se o operador lia "parado há
 * oito meses" ou `12/01/2026`. Os casos abaixo fixam cada degrau pela borda,
 * porque limiar sem teste é limiar que alguém desloca sem perceber.
 *
 * `now` entra por parâmetro: sem ele o relógio ficaria dentro da função e não
 * haveria como exercitar faixa nenhuma.
 */
describe('há quanto tempo', () => {
  const AGORA = new Date('2026-09-23T12:00:00.000Z')
  const atras = (ms: number) => new Date(AGORA.getTime() - ms).toISOString()

  const SEGUNDO = 1000
  const MINUTO = 60 * SEGUNDO
  const HORA = 60 * MINUTO
  const DIA = 24 * HORA

  it('abaixo de um minuto não tem número, tem "agora mesmo"', () => {
    setActiveLocale('en')
    expect(formatRelativeTime(atras(0), AGORA)).toBe('Just now')
    expect(formatRelativeTime(atras(59 * SEGUNDO), AGORA)).toBe('Just now')
  })

  it('e cada degrau começa exatamente onde o anterior acaba', () => {
    setActiveLocale('en')
    expect(formatRelativeTime(atras(MINUTO), AGORA)).toBe('1 minute ago')
    expect(formatRelativeTime(atras(59 * MINUTO), AGORA)).toBe('59 minutes ago')
    expect(formatRelativeTime(atras(HORA), AGORA)).toBe('1 hour ago')
    expect(formatRelativeTime(atras(23 * HORA), AGORA)).toBe('23 hours ago')
    expect(formatRelativeTime(atras(DIA), AGORA)).toBe('1 day ago')
    expect(formatRelativeTime(atras(6 * DIA), AGORA)).toBe('6 days ago')
  })

  /**
   * O degrau que esta onda acrescentou, e o defeito que ele consertou.
   *
   * No sétimo dia a função caía para a DATA e ficava lá para sempre: um
   * provedor suspenso há oito meses aparecia como `12/01/2026`, e quem lia
   * fazia a subtração de cabeça. A tela respondia QUANDO a uma pergunta que é
   * HÁ QUANTO TEMPO.
   */
  it('passa a responder além da semana, em vez de virar data', () => {
    setActiveLocale('en')
    expect(formatRelativeTime(atras(7 * DIA), AGORA)).toBe('1 week ago')
    expect(formatRelativeTime(atras(20 * DIA), AGORA)).toBe('2 weeks ago')
    expect(formatRelativeTime('2026-08-23T12:00:00.000Z', AGORA)).toBe('1 month ago')
    expect(formatRelativeTime('2026-01-23T12:00:00.000Z', AGORA)).toBe('8 months ago')
    expect(formatRelativeTime('2025-10-23T12:00:00.000Z', AGORA)).toBe('11 months ago')
    expect(formatRelativeTime('2025-09-23T12:00:00.000Z', AGORA)).toBe('1 year ago')
    expect(formatRelativeTime('2023-09-23T12:00:00.000Z', AGORA)).toBe('3 years ago')

    // E nenhum deles é mais uma data: é isto que mudou.
    expect(formatRelativeTime('2026-01-23T12:00:00.000Z', AGORA)).not.toContain('/')
  })

  /**
   * Meses contados pelo calendário, não por média de dias.
   *
   * 31/01 → 28/02 ainda NÃO fez um mês, e a média de 30,44 dias diria que sim.
   * O mesmo "ainda não fez" de um aniversário.
   */
  it('conta mês como uma pessoa conta', () => {
    setActiveLocale('en')
    const fim = new Date('2026-02-28T12:00:00.000Z')
    expect(formatRelativeTime('2026-01-31T12:00:00.000Z', fim)).toBe('4 weeks ago')
    expect(formatRelativeTime('2026-01-28T12:00:00.000Z', fim)).toBe('1 month ago')

    // E o piso não exagera: 23 meses é "1 ano", não "2".
    expect(formatRelativeTime('2024-10-23T12:00:00.000Z', AGORA)).toBe('1 year ago')
  })

  /**
   * A frase vem inteira do `Intl`, já flexionada — e é por isso que a frase em
   * volta NÃO pode trazer preposição própria. `'Nada chegou desde {when}'`
   * rendia "Nada chegou desde há 3 dias", em treze idiomas.
   */
  it('devolve a frase pronta no idioma ativo, com a preposição dentro', () => {
    setActiveLocale('pt-BR')
    expect(formatRelativeTime(atras(3 * DIA), AGORA)).toBe('há 3 dias')
    setActiveLocale('de')
    expect(formatRelativeTime(atras(3 * DIA), AGORA)).toBe('vor 3 Tagen')
    setActiveLocale('en')
    expect(formatRelativeTime(atras(3 * DIA), AGORA)).toBe('3 days ago')
  })

  it('e as frases que a usam não repetem a preposição', () => {
    // O defeito estava aqui e não na função: um `{when}` que já diz "há" dentro
    // de uma frase que diz "desde" produz as duas.
    for (const texto of [
      en['whatsapp.health.silent'],
      en['whatsapp.health.oldestQueued'],
      en['platform.suspendedHowLong']
    ]) {
      expect(texto, texto).toContain('{when}')
      expect(texto.toLowerCase(), texto).not.toContain('since')
    }
  })

  /**
   * Relógio fora de hora. Uma data no futuro não pode virar duração negativa
   * nem "daqui a três dias" — o painel não prevê, ele conta o que passou.
   */
  it('instante no futuro lê como agora, não como negativo', () => {
    setActiveLocale('en')
    const futuro = new Date(AGORA.getTime() + 3 * DIA).toISOString()
    expect(formatRelativeTime(futuro, AGORA)).toBe('Just now')
  })

  it('e data que não é data continua caindo na frase de data inválida', () => {
    setActiveLocale('en')
    expect(formatRelativeTime('not-a-date', AGORA)).toBe(formatDate('not-a-date'))
    expect(formatRelativeTime('not-a-date', AGORA)).not.toContain('NaN')
  })
})
