import { describe, expect, it } from 'vitest'

import type { WhatsAppTemplate } from '@/lib/api'
import { nextOffset, stepProblems, toSavedSteps } from '@/components/whatsapp/dunning-rules'

/**
 * As regras que a tela da régua automática confere antes de salvar. O servidor
 * confere as mesmas e é quem manda (`waDunningService.readSteps`); o que se
 * prova aqui é que a tela aponta o problema na etapa certa, e não depois.
 */

const template = (id: number, body: string): WhatsAppTemplate => ({
  id, name: `modelo ${id}`, body, category: 'cobranca', active: true, createdAt: null, updatedAt: null
})

const COBRANCA = template(1, 'Olá {{nome}}, {{dias_atraso}} dias de atraso.')
const LEMBRETE = template(2, 'Olá {{nome}}, vence em {{dias_para_vencer}} dias.')
const NEUTRO = template(3, 'Olá {{nome}}, sua fatura de {{valor}} está disponível.')
const TODOS = [COBRANCA, LEMBRETE, NEUTRO]

describe('stepProblems', () => {
  it('aceita lembrete antes do vencimento e cobrança depois', () => {
    expect(stepProblems([
      { offsetDays: -3, templateId: 2 },
      { offsetDays: 0, templateId: 2 },
      { offsetDays: 5, templateId: 1 }
    ], TODOS)).toEqual([null, null, null])
  })

  it('recusa lembrete depois do vencimento e cobrança antes dele', () => {
    expect(stepProblems([
      { offsetDays: 2, templateId: 2 },
      { offsetDays: -1, templateId: 1 }
    ], TODOS)).toEqual(['needsDunning', 'needsReminder'])
  })

  it('deixa o modelo que não cita dia servir dos dois lados', () => {
    expect(stepProblems([
      { offsetDays: -2, templateId: 3 },
      { offsetDays: 10, templateId: 3 }
    ], TODOS)).toEqual([null, null])
  })

  it('aponta as duas etapas do mesmo dia, o dia fora da faixa e o modelo que falta', () => {
    expect(stepProblems([
      { offsetDays: 5, templateId: 1 },
      { offsetDays: 5, templateId: 1 },
      { offsetDays: 500, templateId: 1 },
      { offsetDays: 7, templateId: null },
      { offsetDays: 8, templateId: 99 }
    ], TODOS)).toEqual(['duplicate', 'duplicate', 'offsetRange', 'noTemplate', 'noTemplate'])
  })

  it('trata o campo vazio (NaN) como fora da faixa', () => {
    expect(stepProblems([{ offsetDays: Number.NaN, templateId: 1 }], TODOS)).toEqual(['offsetRange'])
  })
})

describe('toSavedSteps', () => {
  it('ordena por dia e descarta o que não tem modelo', () => {
    expect(toSavedSteps([
      { offsetDays: 10, templateId: 1 },
      { offsetDays: -3, templateId: 2 },
      { offsetDays: 4, templateId: null }
    ])).toEqual([{ offsetDays: -3, templateId: 2 }, { offsetDays: 10, templateId: 1 }])
  })
})

describe('nextOffset', () => {
  it('sugere o primeiro dia de atraso, e depois uma semana após a última', () => {
    expect(nextOffset([])).toBe(1)
    expect(nextOffset([{ offsetDays: -3 }])).toBe(1)
    expect(nextOffset([{ offsetDays: 1 }, { offsetDays: 5 }])).toBe(12)
    expect(nextOffset([{ offsetDays: 118 }])).toBe(120)
  })
})
