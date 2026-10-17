import type { TranslationKey } from '@/lib/i18n'

/**
 * A template variable as the operator reads it: "PIX", not `pix`. An unknown
 * name (a variable added on the server first) falls back to the raw name.
 */
const VARIABLE_LABELS: Record<string, TranslationKey> = {
  nome: 'whatsapp.variable.nome',
  primeiro_nome: 'whatsapp.variable.primeiro_nome',
  contrato: 'whatsapp.variable.contrato',
  plano: 'whatsapp.variable.plano',
  valor: 'whatsapp.variable.valor',
  vencimento: 'whatsapp.variable.vencimento',
  dias_atraso: 'whatsapp.variable.dias_atraso',
  dias_para_vencer: 'whatsapp.variable.dias_para_vencer',
  pix: 'whatsapp.variable.pix',
  linha_digitavel: 'whatsapp.variable.linha_digitavel',
  link_boleto: 'whatsapp.variable.link_boleto'
}

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string

export function variableLabel(t: Translate, name: string): string {
  const key = VARIABLE_LABELS[name]
  return key ? t(key) : name
}

/** "Missing: PIX, boleto link" — or `null` when the list is empty. */
export function missingText(t: Translate, missing: string[] | null | undefined): string | null {
  if (!missing?.length) return null
  return t('whatsapp.dunning.skip.templateMissing', { names: missing.map((name) => variableLabel(t, name)).join(', ') })
}
