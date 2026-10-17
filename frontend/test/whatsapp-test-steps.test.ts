import { describe, expect, it } from 'vitest'

import { testNotes, testOutcome, toneOf } from '@/lib/whatsapp-test'
import type { WhatsAppConfigTest } from '@/lib/api'
import en from '@/lib/i18n/locales/en'
import type { TranslationKey, TranslationVars } from '@/lib/i18n/dictionary'

/**
 * O que a tela do diagnóstico afirma, e o que ela não pode afirmar.
 *
 * O cálculo mora fora do componente justamente para caber aqui: o vitest deste
 * repositório roda em ambiente `node`, sem jsdom e sem testing-library, então
 * lógica dentro de JSX é lógica sem prova. O que se testa é a parte que engana
 * se estiver errada — o tom de cada veredito e a frase "está tudo certo".
 */

/** O `t` de verdade, contra o dicionário inglês, com interpolação de `{detail}`. */
const t = (key: TranslationKey, vars?: TranslationVars) =>
  String(en[key]).replace(/\{(\w+)\}/g, (_, nome) => String(vars?.[nome] ?? ''))

const resultado = (passos: WhatsAppConfigTest['passos']): WhatsAppConfigTest => ({ passos })

const TUDO_CERTO = resultado([
  { passo: 'config', veredito: 'ok' },
  { passo: 'webhookPath', veredito: 'ok', detalhe: 'https://painel.exemplo.test/api/whatsapp-webhook' },
  { passo: 'server', veredito: 'ok', detalhe: 'v2' },
  { passo: 'license', veredito: 'ok' },
  { passo: 'adminKey', veredito: 'ok', detalhe: 3 },
  { passo: 'instances', veredito: 'ok', detalhe: 3 },
  { passo: 'roundTrip', veredito: 'reached' }
])

describe('o tom de cada veredito', () => {
  it('aprovado é calmo, falha é alarme', () => {
    expect(toneOf('roundTrip', 'reached')).toBe('calm')
    expect(toneOf('roundTrip', 'wrong_target')).toBe('alarm')
    expect(toneOf('adminKey', 'unauthorized')).toBe('alarm')
  })

  it('`skipped` é aviso e NUNCA alarme', () => {
    // Um passo que não pôde rodar não é defeito, é pergunta sem resposta.
    // Pintá-lo de vermelho mandaria o operador consertar o que talvez esteja
    // certo — e é o caminho mais curto para ele desistir do diagnóstico.
    expect(toneOf('adminKey', 'skipped')).toBe('warn')
    expect(toneOf('license', 'skipped')).toBe('warn')
    expect(toneOf('roundTrip', 'skipped')).toBe('warn')
  })

  it('`ok` do servidor não vale como aprovação de outro passo', () => {
    // O par `passo.veredito` é a chave, e não o veredito sozinho: um `reached`
    // no passo da licença não existe, e se existisse não podia passar por
    // aprovado só porque o nome soa bem.
    expect(toneOf('license', 'reached')).toBe('alarm')
  })
})

describe('"está tudo certo" é uma afirmação, não um resumo', () => {
  it('os seis aprovados passam', () => {
    expect(testOutcome(TUDO_CERTO)).toBe('passed')
  })

  it('um `skipped` DERRUBA o tudo-certo', () => {
    // O caso que decide se esta tela presta: cinco passos verdes e a volta
    // pulada não é "está tudo certo". Dizer que é seria exatamente o
    // diagnóstico que confirma como sã uma instalação quebrada.
    const comVoltaPulada = resultado(
      TUDO_CERTO.passos.map((p) => (p.passo === 'roundTrip' ? { ...p, veredito: 'skipped' } : p))
    )
    expect(testOutcome(comVoltaPulada)).not.toBe('passed')
  })

  it('e o resultado vazio não é aprovação', () => {
    expect(testOutcome(null)).toBe('failed')
    expect(testOutcome(resultado([]))).toBe('failed')
  })
})

describe('as frases', () => {
  it('cada passo tem nome e frase, e o detalhe entra no texto', () => {
    const notas = testNotes(TUDO_CERTO, t)
    expect(notas).toHaveLength(7)
    expect(notas.map((n) => n.key)).toEqual(
      ['config', 'webhookPath', 'server', 'license', 'adminKey', 'instances', 'roundTrip']
    )
    for (const nota of notas) {
      expect(nota.label).not.toBe(nota.key)
      expect(nota.text.trim().length).toBeGreaterThan(0)
    }
    expect(notas.find((n) => n.key === 'server')?.text).toContain('v2')
    expect(notas.find((n) => n.key === 'adminKey')?.text).toContain('3')
  })

  it('o mesmo `skipped` diz coisas diferentes conforme o passo que o produziu', () => {
    // A frase é escrita por par `passo.veredito`. O `skipped` do servidor é
    // "não há endereço salvo" e o da chave admin é "o servidor não respondeu" —
    // uma frase só para os dois mandaria o operador conferir a coisa errada.
    const notas = testNotes(resultado([
      { passo: 'config', veredito: 'server_missing' },
      { passo: 'server', veredito: 'skipped' },
      { passo: 'adminKey', veredito: 'skipped' }
    ]), t)
    expect(notas[0].text).toContain('managed server URL')
    for (const nota of notas.slice(1)) expect(nota.tone).toBe('warn')
  })

  it('veredito que este frontend não conhece mostra o código cru, não some', () => {
    // Um backend mais novo pode mandar um veredito que este mapa não tem. O
    // código cru é pouco e é mais do que uma linha em branco.
    const notas = testNotes(resultado([{ passo: 'server', veredito: 'veredito_do_futuro' }]), t)
    expect(notas[0].text).toBe('veredito_do_futuro')
    expect(notas[0].tone).toBe('alarm')
  })

  it('toda frase de veredito existe no dicionário: nenhuma chave morta', () => {
    // O `typecheck` garante que as treze traduções têm as chaves; não garante
    // que este mapa aponte para chaves que existem. Aqui se confere que
    // nenhuma linha dele produz texto vazio.
    const todos: WhatsAppConfigTest['passos'] = [
      { passo: 'config', veredito: 'disabled' },
      { passo: 'config', veredito: 'webhook_missing' },
      { passo: 'config', veredito: 'admin_key_missing' },
      { passo: 'webhookPath', veredito: 'path_wrong', detalhe: 'https://painel.exemplo.test' },
      { passo: 'webhookPath', veredito: 'invalid_url', detalhe: 'nao-e-url' },
      { passo: 'server', veredito: 'unreachable' },
      { passo: 'server', veredito: 'unknown_flavor', detalhe: 502 },
      { passo: 'server', veredito: 'host_not_allowed' },
      { passo: 'server', veredito: 'insecure_base_url' },
      { passo: 'server', veredito: 'invalid_base_url' },
      { passo: 'server', veredito: 'blocked_host' },
      { passo: 'license', veredito: 'required', detalhe: 'https://evo.exemplo.test/manager' },
      { passo: 'adminKey', veredito: 'unauthorized' },
      { passo: 'adminKey', veredito: 'http_error', detalhe: 500 },
      { passo: 'adminKey', veredito: 'unreachable' },
      { passo: 'roundTrip', veredito: 'wrong_target' },
      { passo: 'roundTrip', veredito: 'not_found' },
      { passo: 'roundTrip', veredito: 'unauthorized' },
      { passo: 'roundTrip', veredito: 'blocked' },
      { passo: 'roundTrip', veredito: 'server_error' },
      { passo: 'roundTrip', veredito: 'unreachable' },
      { passo: 'instances', veredito: 'orphans', detalhe: 2 },
      { passo: 'instances', veredito: 'missing', detalhe: 1 },
      { passo: 'instances', veredito: 'both' }
    ]
    for (const passo of todos) {
      const [nota] = testNotes(resultado([passo]), t)
      expect(nota.text, `${passo.passo}.${passo.veredito}`).not.toBe(passo.veredito)
      expect(nota.text.trim().length).toBeGreaterThan(0)
      expect(nota.text, `${passo.passo}.${passo.veredito}`).not.toContain('{detail}')
    }
  })
})

describe('o descompasso entre o painel e o servidor', () => {
  const comInstancias = (veredito: string, detalhe?: number) => resultado(
    TUDO_CERTO.passos.map((p) => (p.passo === 'instances' ? { passo: 'instances' as const, veredito, detalhe } : p))
  )

  it('instância órfã é AVISO, não falha', () => {
    // O servidor pode legitimamente hospedar instância de outro sistema, e o
    // painel não quebra por causa dela. Pintar de vermelho mandaria o operador
    // consertar o que talvez esteja certo.
    expect(toneOf('instances', 'orphans')).toBe('warn')
    expect(testOutcome(comInstancias('orphans', 2))).toBe('warned')
  })

  it('número do painel sem instância no servidor é FALHA', () => {
    // O painel mostra o número como conectado e ele não envia nem recebe nada.
    // É o oposto da órfã: aqui alguém está contando com uma coisa que não
    // existe.
    expect(toneOf('instances', 'missing')).toBe('alarm')
    expect(testOutcome(comInstancias('missing', 1))).toBe('failed')
  })

  it('e os dois ao mesmo tempo contam como falha', () => {
    expect(toneOf('instances', 'both')).toBe('alarm')
    expect(testOutcome(comInstancias('both'))).toBe('failed')
  })

  it('o resumo tem três estados, não dois', () => {
    // Dois mentiriam nas duas pontas: "está tudo certo" com um passo pulado
    // afirma o que o botão existe para não afirmar, e "há passos que não
    // passaram" sobre uma órfã manda procurar defeito que pode não existir.
    expect(testOutcome(TUDO_CERTO)).toBe('passed')
    expect(testOutcome(comInstancias('skipped'))).toBe('warned')
    expect(testOutcome(comInstancias('orphans', 2))).toBe('warned')
  })

  it('e a frase da órfã explica o webhook antigo, que é a consequência real', () => {
    const [nota] = testNotes(resultado([{ passo: 'instances', veredito: 'orphans', detalhe: 2 }]), t)
    expect(nota.text).toContain('2')
    expect(nota.text.toLowerCase()).toContain('webhook')
  })
})

describe('o servidor que respondeu sem dizer o sabor', () => {
  it('`answered` tem frase própria e não deixa parêntese vazio', () => {
    // A licença recusa até a raiz, então não há sabor a pôr no detalhe. Dito
    // como `ok` — que promete o sabor — a tela mostrava "Respondeu ().".
    const [nota] = testNotes(resultado([{ passo: 'server', veredito: 'answered' }]), t)
    expect(nota.text).not.toBe('answered')
    expect(nota.text).not.toContain('()')
    expect(nota.text.trim().length).toBeGreaterThan(0)
  })

  it('e não conta como aprovado: a linha seguinte é sempre a licença falhando', () => {
    expect(toneOf('server', 'answered')).toBe('alarm')
  })
})
