import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAmountToCents } from '@/lib/utils'

/**
 * O valor de um pagamento, digitado por uma pessoa.
 *
 * A escrita anterior trocava só a PRIMEIRA vírgula por ponto, então
 * `"1.234"` — mil duzentos e trinta e quatro reais — virava `1.234` e era
 * aceito em silêncio como 123 centavos. É dinheiro, e o erro não aparecia em
 * lugar nenhum: os campos limpavam e o extrato recarregava igual.
 */
describe('parseAmountToCents', () => {
  it('lê o formato brasileiro, com e sem milhar', () => {
    expect(parseAmountToCents('199,90')).toBe(19990)
    expect(parseAmountToCents('1.234,56')).toBe(123456)
    expect(parseAmountToCents('1.234.567,89')).toBe(123456789)
    expect(parseAmountToCents('0,01')).toBe(1)
  })

  it('lê o ponto como decimal quando não há vírgula', () => {
    // O que sai de um teclado numérico.
    expect(parseAmountToCents('199.90')).toBe(19990)
    expect(parseAmountToCents('1500')).toBe(150000)
    expect(parseAmountToCents('0.5')).toBe(50)
  })

  it('RECUSA o ambíguo em vez de adivinhar', () => {
    // "1.234" pode ser mil duzentos e trinta e quatro, ou um e vinte e três.
    // Errar aqui é errar por mil vezes, para um lado ou para o outro.
    expect(parseAmountToCents('1.234')).toBeNull()
    expect(parseAmountToCents('12.500')).toBeNull()
  })

  it('recusa o que não é número', () => {
    expect(parseAmountToCents('')).toBeNull()
    expect(parseAmountToCents('abc')).toBeNull()
    expect(parseAmountToCents('R$ 10,00')).toBeNull()
    expect(parseAmountToCents('1,2,3')).toBeNull()
    expect(parseAmountToCents('-5')).toBeNull()
  })

  it('não perde centavo no ponto flutuante', () => {
    expect(parseAmountToCents('0,07')).toBe(7)
    expect(parseAmountToCents('1,10')).toBe(110)
    expect(parseAmountToCents('29,99')).toBe(2999)
  })
})

/**
 * O preço de um PLANO, que é a outra tela que lê dinheiro digitado.
 *
 * Ela tinha uma cópia da leitura antiga, e pior que a do pagamento: onde a do
 * pagamento recusava, esta devolvia ZERO. "1.234,56" virava NaN e o `: 0` do
 * fim fazia do NaN um plano de graça, sem erro nenhum na tela — o preço que
 * todo provedor daquele plano paga. O campo vazio também valia zero.
 */
describe('o preço do plano', () => {
  /**
   * O que a troca podia quebrar: editar um plano sem mexer no preço.
   *
   * O formulário de edição é preenchido com `(priceCents / 100).toFixed(2)`,
   * com PONTO. Se a leitura nova recusasse ou mudasse algum desses valores,
   * abrir um plano e salvar sem tocar no preço alteraria o que se cobra.
   */
  it('a edição devolve exatamente o preço que abriu', () => {
    const valores = [0, 1, 99, 100, 990, 8990, 12345, 99999, 100000, 123400, 123456, 999999, 1234567]
    for (const cents of valores) {
      expect(parseAmountToCents((cents / 100).toFixed(2)), String(cents)).toBe(cents)
    }
  })

  it('o que a mensagem de erro ensina a digitar é aceito', () => {
    // A frase da tela diz "1.234,00 ou 89,90" e "para um plano gratuito, 0".
    expect(parseAmountToCents('1.234,00')).toBe(123400)
    expect(parseAmountToCents('89,90')).toBe(8990)
    expect(parseAmountToCents('0')).toBe(0)
  })

  it('e o que virava plano de graça agora é recusado', () => {
    expect(parseAmountToCents('')).toBeNull()
    expect(parseAmountToCents('1.234')).toBeNull()
    expect(parseAmountToCents('abc')).toBeNull()
  })

  /**
   * A guarda contra a cópia voltar.
   *
   * O defeito não era a regra — a regra certa já existia, com testes. Era uma
   * SEGUNDA leitura de dinheiro escrita à mão numa tela que ninguém lembrou de
   * atualizar quando a primeira foi consertada. Este caso procura o padrão da
   * cópia antiga em todo o `src`, fora do único lugar onde ele é usado do
   * jeito certo (depois de tirar os pontos de milhar).
   */
  it('nenhuma tela lê dinheiro à mão', () => {
    const raiz = join(__dirname, '..', 'src')
    const achados: string[] = []
    const anda = (dir: string) => {
      for (const nome of readdirSync(dir)) {
        const caminho = join(dir, nome)
        if (statSync(caminho).isDirectory()) { anda(caminho); continue }
        if (!/\.(tsx?|jsx?)$/.test(nome) || caminho.endsWith(join('lib', 'utils.ts'))) continue
        if (readFileSync(caminho, 'utf8').includes(".replace(',', '.')")) achados.push(caminho)
      }
    }
    anda(raiz)
    expect(achados, 'use parseAmountToCents').toEqual([])
  })
})
