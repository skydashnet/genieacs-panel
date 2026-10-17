import type { TranslationKey, TranslationVars } from '@/lib/i18n/dictionary'
import type { WhatsAppConfigTest, WhatsAppTestStepResult } from '@/lib/api'

/**
 * O diagnóstico da integração, traduzido para o que se lê na tela.
 *
 * Módulo próprio e função PURA, e não um trecho dentro de `settings.tsx`, por
 * um motivo prático: o vitest deste repositório roda em ambiente `node`, sem
 * jsdom e sem testing-library. Lógica dentro de componente aqui é lógica sem
 * teste — foi o que aconteceu com o item C do PR #101, entregue sem prova. Fora
 * do componente, cada mapeamento de veredito vira um caso.
 *
 * O padrão visual (`Tone`, as classes, os ícones) é o da faixa de saúde do
 * WhatsApp, `components/whatsapp/health-strip.tsx`, que já resolveu esta mesma
 * pergunta nesta mesma área: vários sinais numa lista, sem deixar o grave se
 * esconder ao lado do trivial.
 */

/** Grave, digno de nota, ou pano de fundo. Nada entre os três. */
export type TestTone = 'alarm' | 'warn' | 'calm'

/** Uma linha do resultado. */
export interface TestNote {
  key: string
  tone: TestTone
  icon: string
  /** O nome do passo, à esquerda. */
  label: string
  /** O que se apurou dele. */
  text: string
}

export const TEST_TONE_CLASS: Record<TestTone, string> = {
  alarm:
    'border-[hsl(var(--status-danger)/0.45)] bg-[hsl(var(--status-danger)/0.12)] '
    + 'text-[hsl(var(--status-danger))] font-semibold',
  warn:
    'border-[hsl(var(--status-warning)/0.4)] bg-[hsl(var(--status-warning)/0.1)] '
    + 'text-[hsl(var(--status-warning))] font-medium',
  calm: 'border-border bg-transparent text-muted-foreground'
}

export const TEST_TONE_ICON: Record<TestTone, string> = {
  alarm: 'x',
  warn: 'info',
  calm: 'check'
}

type Translate = (key: TranslationKey, vars?: TranslationVars) => string

/** O nome de cada passo, na ordem em que a tela os mostra. */
const LABEL: Record<string, TranslationKey> = {
  config: 'settings.whatsapp.test.step.config',
  webhookPath: 'settings.whatsapp.test.step.webhookPath',
  server: 'settings.whatsapp.test.step.server',
  license: 'settings.whatsapp.test.step.license',
  adminKey: 'settings.whatsapp.test.step.adminKey',
  instances: 'settings.whatsapp.test.step.instances',
  roundTrip: 'settings.whatsapp.test.step.roundTrip'
}

/**
 * A frase de cada veredito, por passo.
 *
 * Escrita por par `passo.veredito` e não por veredito sozinho porque o mesmo
 * nome quer dizer coisas diferentes em passos diferentes: `skipped` no servidor
 * é "não há endereço salvo" e na chave admin é "o servidor não respondeu, então
 * não dá para dizer". Uma frase só para os dois mandaria o operador conferir a
 * coisa errada.
 */
const PHRASE: Record<string, TranslationKey> = {
  'config.ok': 'settings.whatsapp.test.config.ok',
  'config.disabled': 'settings.whatsapp.test.config.disabled',
  'config.webhook_missing': 'settings.whatsapp.test.config.webhookMissing',
  'config.server_missing': 'settings.whatsapp.test.config.serverMissing',
  'config.admin_key_missing': 'settings.whatsapp.test.config.adminKeyMissing',

  'webhookPath.ok': 'settings.whatsapp.test.webhookPath.ok',
  'webhookPath.path_wrong': 'settings.whatsapp.test.webhookPath.wrong',
  'webhookPath.invalid_url': 'settings.whatsapp.test.webhookPath.invalid',
  'webhookPath.skipped': 'settings.whatsapp.test.skipped',

  'server.ok': 'settings.whatsapp.test.server.ok',
  'server.answered': 'settings.whatsapp.test.server.answered',
  'server.unreachable': 'settings.whatsapp.test.server.unreachable',
  'server.unknown_flavor': 'settings.whatsapp.test.server.unknownFlavor',
  'server.host_not_allowed': 'settings.whatsapp.test.server.hostNotAllowed',
  'server.insecure_base_url': 'settings.whatsapp.test.server.insecure',
  'server.invalid_base_url': 'settings.whatsapp.test.server.invalidUrl',
  'server.blocked_host': 'settings.whatsapp.test.server.blocked',
  'server.skipped': 'settings.whatsapp.test.skipped',

  'license.ok': 'settings.whatsapp.test.license.ok',
  'license.required': 'settings.whatsapp.test.license.required',
  'license.skipped': 'settings.whatsapp.test.skipped',

  'adminKey.ok': 'settings.whatsapp.test.adminKey.ok',
  'adminKey.unauthorized': 'settings.whatsapp.test.adminKey.unauthorized',
  'adminKey.http_error': 'settings.whatsapp.test.adminKey.httpError',
  'adminKey.unreachable': 'settings.whatsapp.test.server.unreachable',
  'adminKey.skipped': 'settings.whatsapp.test.skipped',

  'instances.ok': 'settings.whatsapp.test.instances.ok',
  'instances.orphans': 'settings.whatsapp.test.instances.orphans',
  'instances.missing': 'settings.whatsapp.test.instances.missing',
  'instances.both': 'settings.whatsapp.test.instances.both',
  'instances.skipped': 'settings.whatsapp.test.skipped',

  'roundTrip.reached': 'settings.whatsapp.test.roundTrip.reached',
  'roundTrip.wrong_target': 'settings.whatsapp.test.roundTrip.wrongTarget',
  'roundTrip.not_found': 'settings.whatsapp.test.roundTrip.notFound',
  'roundTrip.unauthorized': 'settings.whatsapp.test.roundTrip.unauthorized',
  'roundTrip.blocked': 'settings.whatsapp.test.roundTrip.blocked',
  'roundTrip.server_error': 'settings.whatsapp.test.roundTrip.serverError',
  'roundTrip.unreachable': 'settings.whatsapp.test.roundTrip.unreachable',
  'roundTrip.skipped': 'settings.whatsapp.test.skipped'
}

/** Os vereditos que significam "deu certo". Todo o resto é problema ou dúvida. */
const APROVADOS = new Set([
  'config.ok', 'webhookPath.ok', 'server.ok', 'license.ok', 'adminKey.ok',
  'instances.ok', 'roundTrip.reached'
])

// `server.answered` fica FORA dos aprovados de propósito: ele só acontece
// quando a licença bloqueou, e a linha seguinte é sempre um ✗. Contá-lo como
// aprovado faria a tela somar um verde a um diagnóstico que já falhou.

/**
 * O que é digno de nota sem ser defeito.
 *
 * Uma instância no servidor que o painel não gerencia não quebra nada que o
 * painel faça — o servidor pode legitimamente hospedar instância de outro
 * sistema. Ela merece ser vista, e não merece o vermelho que manda o operador
 * consertar o que talvez esteja certo.
 */
const AVISOS = new Set(['instances.orphans'])

/**
 * Grave, dúvida ou tudo bem.
 *
 * `skipped` é `warn` e nunca `alarm`: um passo que não pôde rodar não é um
 * defeito, é uma pergunta sem resposta — e pintá-lo de vermelho mandaria o
 * operador consertar uma coisa que talvez esteja certa.
 */
export function toneOf(passo: string, veredito: string): TestTone {
  if (APROVADOS.has(`${passo}.${veredito}`)) return 'calm'
  if (veredito === 'skipped' || AVISOS.has(`${passo}.${veredito}`)) return 'warn'
  return 'alarm'
}

/** O texto de um passo, com o detalhe quando ele acrescenta alguma coisa. */
function textOf(step: WhatsAppTestStepResult, t: Translate): string {
  // A chave aceita sem contagem: no servidor da plataforma o total é dos
  // números de todos os provedores, e o backend não o manda.
  const semContagem = step.passo === 'adminKey' && step.veredito === 'ok'
    && (step.detalhe === null || step.detalhe === undefined)
  const chave = semContagem
    ? 'settings.whatsapp.test.adminKey.okNoCount'
    : PHRASE[`${step.passo}.${step.veredito}`]
  // Veredito que este frontend não conhece — um backend mais novo, por exemplo.
  // Mostrar o código cru é pouco, e é mais do que uma célula vazia.
  if (!chave) return step.veredito
  const detalhe = step.detalhe === null || step.detalhe === undefined ? '' : String(step.detalhe)
  return t(chave, { detail: detalhe })
}

/** O resultado inteiro, pronto para a tela. */
export function testNotes(resultado: WhatsAppConfigTest | null, t: Translate): TestNote[] {
  if (!resultado?.passos?.length) return []
  return resultado.passos.map((step) => ({
    key: step.passo,
    tone: toneOf(step.passo, step.veredito),
    icon: TEST_TONE_ICON[toneOf(step.passo, step.veredito)],
    label: LABEL[step.passo] ? t(LABEL[step.passo]) : step.passo,
    text: textOf(step, t)
  }))
}

/**
 * O resumo, em três estados e não em dois.
 *
 * `failed` quando algum passo é grave; `warned` quando nenhum é grave mas algum
 * é dúvida ou ressalva; `passed` só quando todos são aprovados.
 *
 * Os três existem porque dois mentiriam nas duas pontas: "está tudo certo" com
 * a volta pulada afirma exatamente o que este botão existe para não afirmar, e
 * "há passos que não passaram" sobre uma instância órfã manda o operador
 * procurar um defeito que pode não existir.
 */
export function testOutcome(resultado: WhatsAppConfigTest | null): 'passed' | 'warned' | 'failed' {
  if (!resultado?.passos?.length) return 'failed'
  const tons = resultado.passos.map((step) => toneOf(step.passo, step.veredito))
  if (tons.includes('alarm')) return 'failed'
  return tons.includes('warn') ? 'warned' : 'passed'
}
