import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  LEAD_FIELDS,
  LEAD_KEYS_NOT_PERSONAL,
  POLICY_UPDATED_AT,
  RECIPIENTS,
  leadRetentionSentence
} from '@/lib/privacy'

/**
 * A política de privacidade afirma coisas que o código pode desmentir, e este
 * arquivo existe porque o desmentido **não dá erro**.
 *
 * Acrescentar um campo ao formulário da vitrine sem tocar na política não
 * produz exceção, teste vermelho nem linha de log: a página continua dizendo o
 * que coletava antes, e o titular lê uma lista incompleta no exato lugar em que
 * a LGPD (art. 9º) manda informá-lo. Então a regra é a mesma do inventário de
 * dados e do mapa de telas — que o silêncio vire falha.
 *
 * **Como a cobertura é medida.** Lendo a fonte de `landing.tsx` atrás do que
 * `publicAPI.createLead` envia, e não uma lista declarada ao lado. Uma lista
 * seria uma segunda verdade capaz de discordar do formulário de verdade.
 */
const AQUI = path.dirname(new URL(import.meta.url).pathname)
const FRONTEND = path.join(AQUI, '..')
const LANDING = path.join(FRONTEND, 'src', 'pages', 'landing.tsx')

/** As chaves do objeto que `landing.tsx` passa a `publicAPI.createLead({ … })`. */
function chavesDoFormulario(): string[] {
  const fonte = readFileSync(LANDING, 'utf8')
  const abre = fonte.indexOf('publicAPI.createLead({')
  expect(abre, 'a chamada a publicAPI.createLead saiu de landing.tsx: reveja esta leitura').toBeGreaterThan(-1)

  // Casa as chaves de `{ … }` por contagem de chaves, não por "primeiro `})`":
  // um valor com objeto dentro fecharia a leitura antes da hora.
  let profundidade = 0
  let fim = -1
  for (let i = fonte.indexOf('{', abre); i < fonte.length; i += 1) {
    if (fonte[i] === '{') profundidade += 1
    else if (fonte[i] === '}') {
      profundidade -= 1
      if (profundidade === 0) { fim = i; break }
    }
  }
  expect(fim, 'não achei o fim do objeto de createLead').toBeGreaterThan(abre)

  const corpo = fonte.slice(fonte.indexOf('{', abre) + 1, fim)
  return [...corpo.matchAll(/^\s*([A-Za-z_]\w*)\s*:/gm)].map((m) => m[1])
}

describe('o que o formulário da vitrine coleta e o que a política declara', () => {
  const doFormulario = new Set(chavesDoFormulario())
  const declaradas = new Set([
    ...LEAD_FIELDS.map((f) => f.key),
    ...Object.keys(LEAD_KEYS_NOT_PERSONAL)
  ])

  /**
   * O caso que dá nome ao arquivo.
   */
  it('não deixa nenhum campo coletado sem declaração na política', () => {
    const calados = [...doFormulario].filter((k) => !declaradas.has(k))

    expect(calados, calados.length
      ? `O formulário coleta ${calados.join(', ')} e a política não diz.\n`
        + 'Cada campo precisa de UMA das duas coisas em src/lib/privacy.ts:\n'
        + '  (a) entrar em LEAD_FIELDS, se é dado do titular — e a página passa a listá-lo; ou\n'
        + '  (b) entrar em LEAD_KEYS_NOT_PERSONAL, com o motivo escrito, se não é.\n'
        + 'Sem isso o titular lê uma lista incompleta onde a LGPD manda informá-lo — em silêncio.'
      : undefined).toEqual([])
  })

  /**
   * O contrário, e é tão errado quanto: a política que cita o que ninguém coleta
   * mais afirma uma coleta que não existe.
   */
  it('e não cita campo que o formulário já não coleta', () => {
    const fantasmas = [...declaradas].filter((k) => !doFormulario.has(k))

    expect(fantasmas, fantasmas.length
      ? `Declarado(s) na política e ausente(s) do formulário: ${fantasmas.join(', ')}.`
      : undefined).toEqual([])
  })

  it('e toda exceção "não é dado pessoal" traz o motivo por escrito', () => {
    const semMotivo = Object.entries(LEAD_KEYS_NOT_PERSONAL)
      .filter(([, motivo]) => motivo.trim().length < 20)
      .map(([chave]) => chave)

    expect(semMotivo).toEqual([])
  })

  it('e nenhum campo está nos dois lugares ao mesmo tempo', () => {
    const duplos = LEAD_FIELDS.map((f) => f.key).filter((k) => k in LEAD_KEYS_NOT_PERSONAL)

    expect(duplos).toEqual([])
  })
})

describe('a frase sobre quanto tempo o pedido fica guardado', () => {
  /**
   * `0` é o padrão do servidor e quer dizer "nada apaga sozinho". A frase tem
   * que dizer exatamente isso — e não pode prometer um apagamento que a poda não
   * faz.
   */
  it('com zero, diz que nenhuma rotina apaga, e não promete prazo', () => {
    const frase = leadRetentionSentence(0)

    expect(frase).toMatch(/nenhuma rotina automática/i)
    expect(frase).not.toMatch(/\d+ dias/)
  })

  /**
   * O `won` é poupado pela poda em qualquer prazo. Uma frase que prometesse
   * apagar tudo depois de N dias seria falsa sobre o lead que virou contrato.
   */
  it('com um prazo, diz o número e a exceção do pedido que virou contratação', () => {
    const frase = leadRetentionSentence(365)

    expect(frase).toContain('365 dias')
    expect(frase).toMatch(/virou contratação/i)
  })

  /**
   * `undefined` é "não consegui ler" — falha de rede, rota fora do ar. Afirmar
   * "nada apaga" ou um número a partir de um dado que não chegou seria afirmar um
   * fato sem saber.
   */
  it('sem o número, não afirma nem "nada apaga" nem um prazo', () => {
    const frase = leadRetentionSentence(undefined)

    expect(frase).not.toMatch(/nenhuma rotina automática/i)
    expect(frase).not.toMatch(/\d+ dias/)
  })
})

describe('a afirmação "não usamos rastreadores nem análise de audiência"', () => {
  /**
   * A política diz isso ao titular. Uma frase dessas apodrece sem aviso: alguém
   * cola um snippet de analytics no HTML e a página continua prometendo o
   * contrário. Dois guardas, os dois baratos e os dois lendo a fonte:
   * nenhum `<script src>` externo nas páginas, e nenhum identificador de
   * serviço de rastreio conhecido no código do frontend.
   */
  it('não há script externo nas páginas HTML', () => {
    for (const arquivo of ['index.html', 'portal.html']) {
      const html = readFileSync(path.join(FRONTEND, arquivo), 'utf8')
      const externos = [...html.matchAll(/<script[^>]*\ssrc=["'](https?:)?\/\/[^"']+/gi)].map((m) => m[0])

      expect(externos, `${arquivo} carrega script de fora`).toEqual([])
    }
  })

  it('e nenhum serviço de rastreio conhecido aparece no código do frontend', () => {
    const RASTREADORES = [
      'googletagmanager', 'google-analytics', 'gtag(', 'hotjar', 'clarity.ms', 'plausible.io',
      'mixpanel', 'sentry.io', 'posthog', 'segment.com/analytics', 'recaptcha', 'hcaptcha', 'turnstile'
    ]
    const achados: string[] = []
    const raiz = path.join(FRONTEND, 'src')
    for (const rel of readdirSync(raiz, { recursive: true }) as string[]) {
      if (!/\.(ts|tsx)$/.test(rel)) continue
      // Os arquivos que ESCREVEM a afirmação (e este) citam as palavras sem usá-las.
      if (/(^|\/)privacy\.(ts|tsx)$/.test(rel)) continue
      const fonte = readFileSync(path.join(raiz, rel), 'utf8').toLowerCase()
      for (const nome of RASTREADORES) if (fonte.includes(nome)) achados.push(`${rel}: ${nome}`)
    }

    expect(achados, achados.length
      ? `Serviço de rastreio no frontend: ${achados.join('; ')}.\n`
        + 'A política de privacidade afirma que não usamos nenhum — mude a política (src/pages/privacy.tsx, seção 4) junto.'
      : undefined).toEqual([])
  })
})

describe('a política tem o que o art. 9º exige para existir', () => {
  it('traz a data da última revisão, em formato de data', () => {
    expect(POLICY_UPDATED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('e diz para quem o dado vai, com o que e para quê', () => {
    expect(RECIPIENTS.length).toBeGreaterThan(0)
    for (const r of RECIPIENTS) {
      expect(r.who.trim().length).toBeGreaterThan(0)
      expect(r.what.trim().length).toBeGreaterThan(0)
      expect(r.why.trim().length).toBeGreaterThan(0)
    }
  })
})
