/**
 * O centro padrão do mapa e o que se manda para localizar a sede.
 *
 * Brasília é o par que o backend grava para quem ainda não escolheu
 * (`MapSettings.DEFAULTS`, `seed.js`). Enquanto o centro for esse, ninguém
 * marcou a sede — é por isso que a Topologia não desenha o marcador "Sede"
 * nesse ponto.
 */
export const DEFAULT_MAP_CENTER: [number, number] = [-15.7942, -47.8822]

/** Se o par é o padrão (com a tolerância de quem arredondou para 4 casas). */
export function isDefaultCenter(lat: number, lng: number): boolean {
  return Math.abs(lat - DEFAULT_MAP_CENTER[0]) < 1e-4 && Math.abs(lng - DEFAULT_MAP_CENTER[1]) < 1e-4
}

const GEOCODE_KEYS = ['addressLine', 'addressNumber', 'district', 'city', 'state', 'postalCode'] as const
export type GeocodeFields = Partial<Record<(typeof GEOCODE_KEYS)[number], string>>

/** Do formulário do cadastro, só o que serve para achar o ponto. */
export function geocodeFields(form: Record<string, string | null | undefined>): GeocodeFields {
  const out: GeocodeFields = {}
  for (const key of GEOCODE_KEYS) {
    const value = (form[key] ?? '').trim()
    if (value) out[key] = value
  }
  return out
}

/** Cidade e UF são o mínimo para o servidor procurar. */
export function canGeocode(form: Record<string, string | null | undefined>): boolean {
  return Boolean((form.city ?? '').trim() && (form.state ?? '').trim())
}
