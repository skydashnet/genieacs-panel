import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  deviceExportQuery,
  exportIgnoresSgp,
  filtersFromQuery,
  filtersToQuery,
  focusFromQuery,
  NO_FILTERS,
  pageFromQuery,
  sgpFromQuery,
  statusFromQuery,
  type DeviceFilters,
} from '@/lib/device-filters'

/**
 * O recorte que viaja na URL.
 *
 * O que estes casos defendem é a diferença entre um link útil e um link que
 * mente. O painel manda "os 7 que precisam de atenção" para cá, e se o
 * parâmetro se perder no caminho a tela abre o inventário inteiro sob aquele
 * rótulo — que é exatamente o que os links faziam antes destes parâmetros
 * existirem, e o que ninguém percebia.
 */

const q = (texto: string) => new URLSearchParams(texto)

describe('a query lida', () => {
  it('traz o recorte que o painel escolheu', () => {
    expect(filtersFromQuery(q('status=offline'))).toEqual({ ...NO_FILTERS, status: 'offline' })
    expect(filtersFromQuery(q('status=online'))).toEqual({ ...NO_FILTERS, status: 'online' })
    expect(filtersFromQuery(q('status=stale'))).toEqual({ ...NO_FILTERS, status: 'stale' })
  })

  it('e o recorte inteiro, quando há mais de um', () => {
    expect(filtersFromQuery(q('search=ONT-9&status=offline&sgp=blocked&page=3'))).toEqual({
      search: 'ONT-9', status: 'offline', sgp: 'blocked', focus: 'all', page: 3
    })
  })

  it('traz o recorte que cada número do painel aponta', () => {
    // Um por número daquela tela. O que abre `focus=hot` é o que a tela conta
    // em "equipamentos quentes" — o valor tem que chegar inteiro até aqui.
    for (const recorte of ['new24h', 'weak-signal', 'hot', 'many-clients'] as const) {
      expect(filtersFromQuery(q(`focus=${recorte}`))).toEqual({ ...NO_FILTERS, focus: recorte })
    }
  })

  it('uma query vazia é a lista inteira', () => {
    expect(filtersFromQuery(q(''))).toEqual(NO_FILTERS)
  })
})

describe('o que vem de fora nunca chega à API', () => {
  it('valor inventado vira "todos", e não um cast', () => {
    // Uma query é digitável, colável e editável por quem passar. `banana` tem
    // que morrer aqui; mandado adiante, ele vira um parâmetro que o servidor
    // não conhece.
    expect(statusFromQuery('banana')).toBe('all')
    expect(sgpFromQuery('banana')).toBe('all')
    expect(focusFromQuery('banana')).toBe('all')
    // Nem o que parece certo: o servidor conhece `weak-signal`, e nada mais.
    expect(focusFromQuery('weakSignal')).toBe('all')
    expect(focusFromQuery('WEAK-SIGNAL')).toBe('all')
    expect(filtersFromQuery(q('status=banana&sgp=banana&focus=banana'))).toEqual(NO_FILTERS)
  })

  it('nulo, vazio e ausente também', () => {
    expect(statusFromQuery(null)).toBe('all')
    expect(statusFromQuery('')).toBe('all')
    expect(statusFromQuery(undefined)).toBe('all')
    expect(sgpFromQuery(null)).toBe('all')
    expect(focusFromQuery(null)).toBe('all')
    expect(focusFromQuery('')).toBe('all')
    expect(focusFromQuery(undefined)).toBe('all')
  })

  it('a página recusa os três jeitos de um número não ser um número', () => {
    // `Number.parseInt` aceita `'12abc'` e `' 12'`; `Number('')` é zero. Uma
    // query mal colada não pode virar requisição com página inválida.
    expect(pageFromQuery('12abc')).toBe(12)
    expect(pageFromQuery('0')).toBe(1)
    expect(pageFromQuery('-3')).toBe(1)
    expect(pageFromQuery('')).toBe(1)
    expect(pageFromQuery('abc')).toBe(1)
    expect(pageFromQuery(null)).toBe(1)
  })
})

describe('a query escrita', () => {
  it('o default SOME do endereço', () => {
    // `/devices` é a lista inteira. `status=all&sgp=all&page=1` não acrescenta
    // informação nenhuma e só faz o link ficar feio de mandar para alguém.
    expect(filtersToQuery(NO_FILTERS).toString()).toBe('')
  })

  it('e o que não é default aparece', () => {
    expect(filtersToQuery({ ...NO_FILTERS, status: 'offline' }).toString()).toBe('status=offline')
    expect(filtersToQuery({ ...NO_FILTERS, page: 4 }).toString()).toBe('page=4')
    // O hífen do valor não pode virar `%2D` nem outra coisa: é este texto que
    // o servidor compara com a lista fechada dele.
    expect(filtersToQuery({ ...NO_FILTERS, focus: 'weak-signal' }).toString())
      .toBe('focus=weak-signal')
  })

  it('a ida e a volta dão o mesmo recorte', () => {
    // A prova que amarra as duas metades: o que a tela escreve na URL é o que
    // a tela lê de volta ao recarregar. Sem isto, um link mandado para o
    // plantão poderia abrir outra coisa.
    const casos: DeviceFilters[] = [
      NO_FILTERS,
      { search: 'ONT-9', status: 'offline', sgp: 'unlinked', focus: 'all', page: 2 },
      { search: '', status: 'online', sgp: 'all', focus: 'hot', page: 1 },
      { search: 'a b&c=d', status: 'all', sgp: 'cancelled', focus: 'many-clients', page: 11 },
      { search: '', status: 'offline', sgp: 'all', focus: 'weak-signal', page: 2 }
    ]
    for (const caso of casos) {
      expect(filtersFromQuery(filtersToQuery(caso)), JSON.stringify(caso)).toEqual(caso)
    }
  })

  it('e a busca com caracteres de query sobrevive à viagem', () => {
    // `&` e `=` dentro do texto buscado quebrariam a query se fossem
    // concatenados à mão. `URLSearchParams` escapa, e este caso é o que
    // garante que ninguém a troque por interpolação de string.
    const url = filtersToQuery({ ...NO_FILTERS, search: 'a&status=online' })
    expect(filtersFromQuery(url).search).toBe('a&status=online')
    expect(filtersFromQuery(url).status).toBe('all')
  })
})

describe('a tela lê por aqui', () => {
  it('e não por uma cópia própria, campo a campo', () => {
    // A ida e volta acima só prova alguma coisa sobre a tela se a tela ler pela
    // mesma função. Ela lia por conta própria — `searchParams.get` e um leitor
    // por campo —, e um campo novo esquecido ali passaria com este arquivo
    // inteiro verde.
    const tela = readFileSync(join(__dirname, '..', 'src', 'pages', 'devices.tsx'), 'utf8')
    expect(tela).toContain('filtersFromQuery(searchParams)')
    expect(tela).not.toMatch(/\b(status|sgp|focus|page)FromQuery\(/)
    expect(tela).not.toContain('searchParams.get(')
  })
})

describe('a query da planilha', () => {
  it('leva busca, estado e foco, e nunca a página nem o filtro do ERP', () => {
    const query = deviceExportQuery({ search: ' vila ', status: 'offline', focus: 'weak-signal' })
    expect(query.toString()).toBe('search=vila&status=offline&focus=weak-signal')
    expect(deviceExportQuery({ search: '', status: 'all', focus: 'all' }).toString()).toBe('')
  })

  it('avisa quando o filtro do ERP está ligado, porque ele não entra', () => {
    expect(exportIgnoresSgp({ sgp: 'all' })).toBe(false)
    expect(exportIgnoresSgp({ sgp: 'blocked' })).toBe(true)
  })
})
