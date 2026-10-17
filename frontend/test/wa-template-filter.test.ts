import { describe, expect, it } from 'vitest'
import { classify, filterTemplates, isFiltering, NO_FILTER, templateCounts } from '@/components/whatsapp/template-filter'

const T = (name: string, body: string, category: string) => ({ name, body, category })

const LIST = [
  T('Régua · Lembrete (3 dias antes)', 'Olá {{nome}}, faltam {{dias_para_vencer}} dias. {{pix}}', 'cobranca'),
  T('Régua · 1 dia de atraso', 'Olá {{nome}}, {{dias_atraso}} dia de atraso.', 'cobranca'),
  T('Régua · Vence hoje', 'Olá {{nome}}, vence hoje: {{valor}}', 'cobranca'),
  T('Bom dia', 'Bom dia {{primeiro_nome}}, em que posso ajudar?', 'atendimento'),
  T('Aviso de queda', 'Estamos com instabilidade na sua região.', 'alerta'),
  T('Sem categoria conhecida', 'Texto qualquer', 'inventada')
]

describe('classify', () => {
  it('lê o tipo pelo que o texto cita', () => {
    expect(classify(LIST[0].body)).toBe('reminder')
    expect(classify(LIST[1].body)).toBe('dunning')
    expect(classify('{{dias_atraso}} {{dias_para_vencer}}')).toBe('both')
    expect(classify(LIST[3].body)).toBe('none')
  })
})

describe('filterTemplates', () => {
  it('sem filtro devolve tudo', () => {
    expect(filterTemplates(LIST, NO_FILTER)).toHaveLength(6)
    expect(isFiltering(NO_FILTER)).toBe(false)
  })

  it('busca no nome e no texto, sem diferenciar maiúsculas nem acentos', () => {
    const nomes = (search: string) => filterTemplates(LIST, { ...NO_FILTER, search }).map((t) => t.name)
    expect(nomes('regua')).toHaveLength(3)
    expect(nomes('INSTABILIDADE')).toEqual(['Aviso de queda'])
    expect(nomes('  atraso ')).toEqual(['Régua · 1 dia de atraso'])
    expect(nomes('nada disso')).toEqual([])
  })

  it('categoria desconhecida conta como geral', () => {
    expect(filterTemplates(LIST, { ...NO_FILTER, category: 'geral' }).map((t) => t.name)).toEqual(['Sem categoria conhecida'])
  })

  it('combina categoria, tipo de cobrança e busca', () => {
    expect(filterTemplates(LIST, { search: '', category: 'cobranca', kind: 'dunning' }).map((t) => t.name))
      .toEqual(['Régua · 1 dia de atraso'])
    expect(filterTemplates(LIST, { search: 'pix', category: 'cobranca', kind: 'reminder' })).toHaveLength(1)
    expect(filterTemplates(LIST, { search: '', category: 'atendimento', kind: 'dunning' })).toHaveLength(0)
  })
})

describe('templateCounts', () => {
  it('conta cada aba mantendo os outros filtros', () => {
    const sem = templateCounts(LIST, NO_FILTER)
    expect(sem.categories).toEqual({ all: 6, cobranca: 3, atendimento: 1, suporte: 0, alerta: 1, geral: 1 })
    expect(sem.kinds).toEqual({ reminder: 1, dunning: 1 })

    const atraso = templateCounts(LIST, { ...NO_FILTER, kind: 'dunning' })
    expect(atraso.categories).toEqual({ all: 1, cobranca: 1, atendimento: 0, suporte: 0, alerta: 0, geral: 0 })
  })

  it('o número de cada botão segue a aba escolhida e a busca', () => {
    const cobranca = templateCounts(LIST, { ...NO_FILTER, category: 'cobranca' })
    expect(cobranca.kinds).toEqual({ reminder: 1, dunning: 1 })
    const alerta = templateCounts(LIST, { ...NO_FILTER, category: 'alerta' })
    expect(alerta.kinds).toEqual({ reminder: 0, dunning: 0 })
    const busca = templateCounts(LIST, { ...NO_FILTER, search: 'pix' })
    expect(busca.categories.all).toBe(1)
  })

  it('o número do filtro ativo é o tamanho da lista', () => {
    const filter = { search: 'regua', category: 'cobranca' as const, kind: '' as const }
    expect(templateCounts(LIST, filter).categories.cobranca).toBe(filterTemplates(LIST, filter).length)
  })
})
