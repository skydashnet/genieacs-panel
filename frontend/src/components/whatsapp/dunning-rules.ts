import type { WhatsAppDunningStep, WhatsAppTemplate } from '@/lib/api'

/**
 * As regras da régua automática que a tela confere ANTES de salvar.
 *
 * O servidor confere as mesmas (`waDunningService.readSteps`) e é quem manda.
 * Repetir aqui serve para a pessoa ver o problema ao lado da etapa, enquanto
 * edita, e não como um erro genérico depois de apertar "Salvar".
 */

export const OFFSET_MIN = -30
export const OFFSET_MAX = 120
export const MAX_STEPS = 12

export type StepProblem =
  | 'noTemplate'
  | 'offsetRange'
  | 'duplicate'
  | 'needsDunning'
  | 'needsReminder'

/** Um modelo que cita `{{dias_para_vencer}}` É um lembrete (`modeloEhLembrete`). */
export function isReminderBody(body: string): boolean {
  return /\{\{\s*dias_para_vencer\s*\}\}/.test(body)
}

export function citesDaysOverdue(body: string): boolean {
  return /\{\{\s*dias_atraso\s*\}\}/.test(body)
}

/**
 * O problema de cada etapa, na ordem em que elas aparecem, ou `null`.
 *
 * Depois do vencimento (dia > 0) o modelo não pode ser lembrete; até o
 * vencimento (dia ≤ 0) não pode citar `{{dias_atraso}}`. Um modelo que não
 * cita nenhum dos dois serve dos dois lados.
 */
export function stepProblems(
  steps: { offsetDays: number; templateId: number | null }[],
  templates: WhatsAppTemplate[]
): (StepProblem | null)[] {
  const byId = new Map(templates.map((tpl) => [tpl.id, tpl]))
  const count = new Map<number, number>()
  for (const step of steps) count.set(step.offsetDays, (count.get(step.offsetDays) ?? 0) + 1)
  return steps.map((step) => {
    if (!Number.isInteger(step.offsetDays) || step.offsetDays < OFFSET_MIN || step.offsetDays > OFFSET_MAX) {
      return 'offsetRange'
    }
    if ((count.get(step.offsetDays) ?? 0) > 1) return 'duplicate'
    const template = step.templateId === null ? undefined : byId.get(step.templateId)
    if (!template) return 'noTemplate'
    if (step.offsetDays > 0 && isReminderBody(template.body)) return 'needsDunning'
    if (step.offsetDays <= 0 && citesDaysOverdue(template.body)) return 'needsReminder'
    return null
  })
}

/** As etapas prontas para o servidor, em ordem de dia. */
export function toSavedSteps(steps: { offsetDays: number; templateId: number | null }[]): WhatsAppDunningStep[] {
  return steps
    .filter((step): step is WhatsAppDunningStep => step.templateId !== null)
    .map((step) => ({ offsetDays: step.offsetDays, templateId: step.templateId }))
    .sort((a, b) => a.offsetDays - b.offsetDays)
}

/** Um dia sugerido para a próxima etapa: uma semana depois da última. */
export function nextOffset(steps: { offsetDays: number }[]): number {
  if (steps.length === 0) return 1
  const last = Math.max(...steps.map((step) => step.offsetDays))
  return Math.min(last <= 0 ? 1 : last + 7, OFFSET_MAX)
}
