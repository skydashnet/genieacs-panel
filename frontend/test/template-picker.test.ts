import { describe, expect, it } from 'vitest'
import { groupTemplates, needsInvoice, templateVariables } from '@/lib/template-picker'

const t = (id: number, name: string, body: string, category: string, active = true) => ({ id, name, body, category, active })

describe('template-picker', () => {
  it('lê as variáveis do texto, uma vez cada', () => {
    expect(templateVariables('Olá {{ nome }}, {{valor}} vence {{vencimento}}. {{nome}}')).toEqual(['nome', 'valor', 'vencimento'])
  })

  it('separa o que pede fatura do que a conversa preenche', () => {
    expect(needsInvoice('Olá {{primeiro_nome}}, contrato {{contrato}}')).toBe(false)
    expect(needsInvoice('Seu PIX: {{pix}}')).toBe(true)
    expect(needsInvoice('Boleto: {{ link_boleto }}')).toBe(true)
    expect(needsInvoice('Sem variável')).toBe(false)
  })

  it('agrupa por categoria na ordem da aba Modelos e esconde os inativos', () => {
    const grupos = groupTemplates([
      t(1, 'Aviso', 'Manutenção hoje', 'alerta'),
      t(2, 'Saudação', 'Olá {{nome}}', 'atendimento'),
      t(3, 'Fatura', 'Valor {{valor}}', 'cobranca'),
      t(4, 'Velho', 'não usar', 'cobranca', false),
      t(5, 'Outro', 'texto', 'desconhecida')
    ])
    expect(grupos.map((g) => g.category)).toEqual(['atendimento', 'cobranca', 'alerta', 'geral'])
    expect(grupos.find((g) => g.category === 'cobranca')?.items.map((i) => i.id)).toEqual([3])
  })

  it('busca sem acento pelo nome e pelo texto', () => {
    const lista = [t(1, 'Manutenção', 'rede parada', 'alerta'), t(2, 'Fatura', 'manutencao programada', 'cobranca'), t(3, 'Oi', 'olá', 'geral')]
    const ids = groupTemplates(lista, 'MANUTENCAO').flatMap((g) => g.items.map((i) => i.id))
    expect(ids.sort()).toEqual([1, 2])
  })
})
