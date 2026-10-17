import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { roleHas, type OperatorRole, type Permission } from '@/lib/permissions'
import {
  INNER_SCREENS,
  MENU_SCREENS,
  SETTINGS_SECTIONS,
  visibleMenuScreens,
  visibleSettingsSections
} from '@/lib/screens'

/**
 * O catálogo de telas tem que acompanhar as rotas, e o teste existe porque
 * ficar para trás **não dá erro**.
 *
 * `pages/site-map.tsx` responde "que telas existem" lendo `lib/screens.ts`. Uma
 * tela nova acrescentada a `app.tsx` e esquecida ali não produz nada de
 * visível: nenhuma exceção, nenhum teste vermelho, nenhum aviso. O mapa só vai
 * ficando menos verdadeiro que o produto, e quem o consulta para saber onde
 * fica X não encontra o X que entrou depois — o que é pior do que não ter mapa,
 * porque o mapa parece completo.
 *
 * Então a regra aqui é a mesma de `backend/test/lgpd-inventario.test.js`: que o
 * silêncio vire falha.
 *
 * **Como a cobertura é medida.** Lendo as rotas da fonte de `app.tsx`, e não de
 * uma lista declarada ao lado. Uma lista seria uma segunda verdade capaz de
 * discordar das rotas de verdade, e discordar em silêncio é justamente o
 * defeito que este arquivo existe para impedir. É o precedente das guardas
 * estáticas do backend (`tenant-scoping.test.js`, `sql-sentinel.test.js`).
 */
const AQUI = path.dirname(new URL(import.meta.url).pathname)
const FONTE_DAS_ROTAS = path.join(AQUI, '..', 'src', 'app.tsx')
const FONTE_DA_CONFIGURACAO = path.join(AQUI, '..', 'src', 'pages', 'settings.tsx')

/**
 * As rotas autenticadas: as declaradas dentro do bloco de `<ProtectedShell />`,
 * que é o que "tela do painel" quer dizer. As de fora são as telas sem sessão
 * (entrada, cadastro, convite, redefinição) e as do console, e nenhuma delas é
 * destino de um mapa interno.
 */
function rotasAutenticadas(): string[] {
  const fonte = readFileSync(FONTE_DAS_ROTAS, 'utf8')
  const abre = fonte.indexOf('<Route element={<ProtectedShell />}>')
  expect(abre, 'o bloco de <ProtectedShell /> saiu de app.tsx: reveja esta leitura').toBeGreaterThan(-1)
  const bloco = fonte.slice(abre)
  const fecha = bloco.indexOf('path="*"')
  return [...bloco.slice(0, fecha).matchAll(/path="([^"]+)"/g)].map((m) => m[1])
}

/**
 * Rotas autenticadas que não são tela de destino, com o motivo escrito. Uma
 * declaração sem motivo é uma linha que ninguém consegue conferir depois.
 */
const NAO_E_DESTINO: Record<string, string> = {
  '/sitemap': 'é o próprio mapa: listar-se a si mesmo não ajuda ninguém a chegar a lugar nenhum.'
}

const autenticadas = rotasAutenticadas()
const noCatalogo = new Set<string>([
  ...MENU_SCREENS.map((s) => s.href),
  ...INNER_SCREENS.map((s) => s.path)
])

function papelQuePode(...permissions: Permission[]) {
  return (permission: Permission) => permissions.includes(permission)
}

function comoPapel(role: OperatorRole) {
  return (permission: Permission) => roleHas(role, permission)
}

describe('o catálogo de telas', () => {
  /**
   * O caso que dá nome ao arquivo.
   */
  it('não deixa nenhuma rota autenticada fora do mapa', () => {
    const orfas = autenticadas.filter((rota) => !noCatalogo.has(rota) && !(rota in NAO_E_DESTINO))

    expect(orfas, orfas.length
      ? `Rota(s) autenticada(s) que o mapa não conhece: ${orfas.join(', ')}.\n`
        + 'Cada uma precisa de UMA das três coisas em src/lib/screens.ts:\n'
        + '  (a) entrar em MENU_SCREENS, se é item de menu;\n'
        + '  (b) entrar em INNER_SCREENS, se só se chega a ela de dentro de outra;\n'
        + '  (c) entrar em NAO_E_DESTINO aqui, com o motivo escrito.\n'
        + 'Sem isso a tela existe e o mapa não a mostra — em silêncio.\n'
        + 'Depois de decidir, atualize docs/mapa-do-painel.md.'
      : undefined).toEqual([])
  })

  /**
   * A contradição oposta: uma entrada do catálogo que não é rota nenhuma. O link
   * leva ao `path="*"`, que redireciona para `/dashboard` — então o item do mapa
   * "funciona", só não vai onde diz. É o modo de falhar mais difícil de notar.
   */
  it('e não oferece link para rota que não existe', () => {
    const declaradas = new Set(autenticadas)
    const fantasmas = [...noCatalogo].filter((rota) => !declaradas.has(rota))

    expect(fantasmas, fantasmas.length
      ? `No catálogo e fora de app.tsx: ${fantasmas.join(', ')}. O link cairia no redirecionamento do \`path="*"\`.`
      : undefined).toEqual([])
  })

  it('e toda declaração de "não é destino" traz o motivo por escrito', () => {
    const semMotivo = Object.entries(NAO_E_DESTINO)
      .filter(([, motivo]) => motivo.trim().length < 10)
      .map(([rota]) => rota)

    expect(semMotivo).toEqual([])
  })

  it('e não sobra declaração para rota que não existe mais', () => {
    const declaradas = new Set(autenticadas)
    const sobrando = Object.keys(NAO_E_DESTINO).filter((rota) => !declaradas.has(rota))

    expect(sobrando).toEqual([])
  })
})

describe('quem enxerga quais telas', () => {
  /**
   * A contagem que o `docs/mapa-do-painel.md` errou: `devices.list` abre DUAS
   * telas, Operação e Inventário, não uma. O documento dizia dois itens para um
   * `viewer`; são três. Medido aqui para não voltar a depender de conta à mão.
   */
  it('dá ao viewer exatamente Operação, Inventário e Topologia', () => {
    const hrefs = visibleMenuScreens({ can: comoPapel('viewer'), isSaas: true, isPlatformAdmin: false })
      .map((s) => s.href)

    expect(hrefs).toEqual(['/dashboard', '/devices', '/network-map'])
  })

  it('e ao tech o do viewer mais WhatsApp e Contatos', () => {
    const hrefs = visibleMenuScreens({ can: comoPapel('tech'), isSaas: true, isPlatformAdmin: false })
      .map((s) => s.href)

    expect(hrefs).toEqual(['/dashboard', '/whatsapp', '/devices', '/contacts', '/network-map'])
  })

  /**
   * `owner` e `admin` recebem o MESMO conjunto — a matriz não os distingue, e o
   * que `owner` tem a mais é poder sobre o próprio papel. O mapa não pode
   * sugerir outra coisa.
   */
  it('e não distingue owner de admin', () => {
    const argumentos = { isSaas: true, isPlatformAdmin: false }
    const doOwner = visibleMenuScreens({ can: comoPapel('owner'), ...argumentos }).map((s) => s.href)
    const doAdmin = visibleMenuScreens({ can: comoPapel('admin'), ...argumentos }).map((s) => s.href)

    expect(doOwner).toEqual(doAdmin)
  })

  /**
   * Os dois portões que não são capacidade. O console é o caso que importa: sem
   * ele o item apareceria para quase todo administrador de painel e levaria a
   * rotas que respondem 404 — ou, numa self-hosted, que não estão montadas.
   */
  it('e esconde o console de quem não tem a chave da plataforma, mesmo sendo owner', () => {
    const argumentos = { can: comoPapel('owner'), isSaas: true }
    const sem = visibleMenuScreens({ ...argumentos, isPlatformAdmin: false }).map((s) => s.href)
    const com = visibleMenuScreens({ ...argumentos, isPlatformAdmin: true }).map((s) => s.href)

    expect(sem).not.toContain('/platform')
    expect(com).toContain('/platform')
  })

  it('e esconde o Plano onde não há assinatura de que falar', () => {
    const argumentos = { can: comoPapel('owner'), isPlatformAdmin: false }

    expect(visibleMenuScreens({ ...argumentos, isSaas: false }).map((s) => s.href)).not.toContain('/plan')
    expect(visibleMenuScreens({ ...argumentos, isSaas: true }).map((s) => s.href)).toContain('/plan')
  })
})

describe('as seções da Configuração', () => {
  /**
   * Os ids são endereços: `/settings?tab=<id>`. Um id renomeado em
   * `settings.tsx` e não aqui produz um link que abre a PRIMEIRA aba, calado —
   * `SETTINGS_TABS.includes(wanted)` simplesmente devolve falso e a tela cai no
   * padrão. Ninguém vê erro; o link só deixa de levar onde diz.
   */
  it('apontam todas para uma aba que existe', () => {
    const fonte = readFileSync(FONTE_DA_CONFIGURACAO, 'utf8')
    const inicio = fonte.indexOf('const SETTINGS_TABS = [')
    expect(inicio, 'SETTINGS_TABS saiu de settings.tsx: reveja esta leitura').toBeGreaterThan(-1)
    const bloco = fonte.slice(inicio, fonte.indexOf(']', inicio))
    const abas = new Set([...bloco.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]))

    const desconhecidas = SETTINGS_SECTIONS.map((s) => s.tab).filter((tab) => !abas.has(tab))
    expect(desconhecidas, desconhecidas.length
      ? `Aba(s) que não existem em SETTINGS_TABS: ${desconhecidas.join(', ')}. O link abriria a primeira aba sem avisar.`
      : undefined).toEqual([])

    // E o contrário: uma aba nova na tela que o mapa não oferece.
    const naoOferecidas = [...abas].filter((tab) => !SETTINGS_SECTIONS.some((s) => s.tab === tab))
    expect(naoOferecidas, naoOferecidas.length
      ? `Aba(s) de Configuração fora do mapa: ${naoOferecidas.join(', ')}.`
      : undefined).toEqual([])
  })

  /**
   * `database` é a única que sai por causa da edição: na hospedada a rota do
   * banco não é montada, então o link abriria uma aba vazia.
   */
  it('e não oferecem o banco de dados na edição hospedada', () => {
    const can = () => true

    expect(visibleSettingsSections({ can, isSaas: true }).map((s) => s.tab)).not.toContain('database')
    expect(visibleSettingsSections({ can, isSaas: false }).map((s) => s.tab)).toContain('database')
  })

  /**
   * As duas que têm capacidade própria — as mesmas que `IntegrationsHub` já
   * esconde. Oferecer o link aqui seria contornar aquela regra pela porta nova.
   */
  it('e escondem TeiaH e chatbot de quem não tem a capacidade delas', () => {
    const so = papelQuePode('settings.read')
    const tabs = visibleSettingsSections({ can: so, isSaas: true }).map((s) => s.tab)

    expect(tabs).not.toContain('teiah')
    expect(tabs).not.toContain('chatbot')
    expect(tabs).toContain('sgp')
  })
})
