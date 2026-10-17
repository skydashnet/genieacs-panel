import { getActiveLocale, getIntlLocale, translate } from "@/lib/i18n"
import { formatDateValue, getActiveDateFormat, toDate } from "@/lib/date-format"

export function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M'
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K'
  }
  return num.toString()
}

/** Os degraus, em segundos, e o último degrau que cada um cobre. */
const MINUTO = 60
const HORA = 60 * MINUTO
const DIA = 24 * HORA
const SEMANA = 7 * DIA

/**
 * Meses INTEIROS entre duas datas, contados como uma pessoa conta.
 *
 * Pelo calendário e não por média de dias: 30,44 dias por mês diria "há 12
 * meses" para 360 dias, e quem olha a data sabe que não faz um ano. A conta é a
 * diferença de meses menos um quando o dia do mês ainda não chegou — que é o
 * mesmo "ainda não fez" de um aniversário.
 *
 * 31/01 → 28/02 dá ZERO meses, e é o certo: ainda não fez um mês, e a faixa de
 * semanas responde melhor (4 semanas).
 */
function mesesInteiros(de: Date, ate: Date): number {
  const meses = (ate.getFullYear() - de.getFullYear()) * 12 + (ate.getMonth() - de.getMonth())
  return ate.getDate() < de.getDate() ? meses - 1 : meses
}

/**
 * A faixa em que a idade cai — o degrau, e não o texto.
 *
 * Devolve `null` quando a data não é data: `formatRelativeTime` cai então no
 * mesmo `formatDate` de antes, que tem a frase de data inválida.
 */
function faixaDeIdade(dateString: string, now: Date): { valor: number; unidade: 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year' } | null {
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return null

  const segundos = Math.floor((now.getTime() - date.getTime()) / 1000)

  // O primeiro degrau é o que segura o relógio fora de hora, e não um corte à
  // parte: um instante no FUTURO dá segundos negativos, cai aqui, e a tela diz
  // "agora mesmo" em vez de "daqui a três dias". Um `Math.max(0, …)` acima
  // seria a mesma regra escrita duas vezes — e quem a lesse aqui não saberia
  // qual das duas decide.
  if (segundos < MINUTO) return { valor: segundos, unidade: 'second' }
  if (segundos < HORA) return { valor: Math.floor(segundos / MINUTO), unidade: 'minute' }
  if (segundos < DIA) return { valor: Math.floor(segundos / HORA), unidade: 'hour' }
  if (segundos < SEMANA) return { valor: Math.floor(segundos / DIA), unidade: 'day' }

  const meses = mesesInteiros(date, now)
  if (meses < 1) return { valor: Math.floor(segundos / SEMANA), unidade: 'week' }
  if (meses < 12) return { valor: meses, unidade: 'month' }
  // Piso e não arredondamento: 23 meses vira "1 ano". Exagerar a idade de um
  // provedor suspenso empurra para apagar os dados dele mais cedo, e entre os
  // dois erros esse é o que não tem volta.
  return { valor: Math.floor(meses / 12), unidade: 'year' }
}

/**
 * Há quanto tempo, na unidade em que a pergunta é feita.
 *
 * Quem lê "parado desde 12/01/2026" faz a conta de cabeça; quem lê "parado há
 * oito meses" já tem a resposta. A função parava na sétima semana e caía para a
 * DATA — ela respondia QUANDO a uma pergunta que é HÁ QUANTO TEMPO.
 *
 * `Intl.RelativeTimeFormat` devolve a frase inteira e já flexionada em cada
 * idioma: "há 3 dias", "vor 3 Tagen", "قبل ٣ أيام". É por isso que a frase em
 * volta NÃO pode trazer preposição própria — e é aí que estava o outro defeito
 * desta onda: `'Nada chegou desde {when}'` renderizava **"Nada chegou desde há
 * 3 dias"**, e isso está na tela desde que a tira de saúde existe. Quem usa
 * esta função escreve a frase em volta sem "desde", "since" ou "seit".
 *
 * `now` é parâmetro com padrão, no molde do `exportFileName` logo abaixo: sem
 * ele o relógio fica dentro da função e não há como testar faixa nenhuma.
 */
export function formatRelativeTime(dateString: string, now: Date = new Date()): string {
  const faixa = faixaDeIdade(dateString, now)
  if (!faixa) return formatDate(dateString)
  if (faixa.unidade === 'second') return translate(getActiveLocale(), 'common.justNow')

  // Intl handles the plural rules of every supported locale.
  const relative = new Intl.RelativeTimeFormat(getIntlLocale(), { numeric: 'always' })
  return relative.format(-faixa.valor, faixa.unidade)
}

export function debounce<T extends (...args: any[]) => any>(
  func: T,
  waitFor: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout>
  return (...args: Parameters<T>) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => func(...args), waitFor)
  }
}

export function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false)
  } else {
    const textArea = document.createElement('textarea')
    textArea.value = text
    textArea.style.position = 'fixed'
    textArea.style.left = '-999999px'
    textArea.style.top = '-999999px'
    document.body.appendChild(textArea)
    textArea.focus()
    textArea.select()
    return new Promise((resolve) => {
      resolve(document.execCommand('copy'))
      textArea.remove()
    })
  }
}

/** Formats a timestamp in the active locale and the viewer's own time zone. */
export function formatDate(isoString: string | undefined | null): string {
  if (!isoString) return translate(getActiveLocale(), 'common.na');

  try {
    const date = toDate(isoString);
    if (!date) return translate(getActiveLocale(), 'common.invalidDate');
    // The provider's date order, when one was chosen in Settings.
    if (getActiveDateFormat() !== 'auto') {
      return formatDateValue(date, { intlLocale: getIntlLocale(), time: 'seconds' }) ?? translate(getActiveLocale(), 'common.invalidDate');
    }

    return new Intl.DateTimeFormat(getIntlLocale(), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(date);
  } catch {
    return translate(getActiveLocale(), 'common.invalidDate');
  }
}

/**
 * O nome de reserva do arquivo de exportação.
 *
 * O nome bom vem do servidor, no `Content-Disposition` — é ele quem sabe o slug
 * do provedor e é ele quem deve continuar sendo o único autor da regra. Esta
 * função existe para o caso em que o cabeçalho não chega: painel servido de
 * outra origem por um backend que ainda não o expõe. Sem ela o navegador salva
 * `tenant-export` ou, pior, um nome derivado da URL de blob.
 *
 * A data é ISO e não localizada de propósito: `toLocaleDateString()` devolve
 * `12/09/2026` em pt-BR, e barra dentro de nome de arquivo é caminho.
 */
export function exportFileName(slug: string | null | undefined, when: Date = new Date()): string {
  const quem = (slug || 'export').replace(/[^a-zA-Z0-9._-]/g, '-')
  return `skygenpanel-${quem}-${when.toISOString().slice(0, 10)}.json`
}

/**
 * O nome de reserva do dossiê de UM assinante.
 *
 * Mesma regra e mesmo motivo do `exportFileName` acima, com um prefixo que diz
 * de que arquivo se trata: quem atende dez pedidos num dia precisa distinguir o
 * cadastro do provedor do dossiê de uma pessoa sem abrir os dois.
 */
export function subscriberFileName(
  customerId: string | null | undefined, when: Date = new Date()
): string {
  const quem = (customerId || 'export').replace(/[^a-zA-Z0-9._-]/g, '-')
  return `assinante-${quem}-${when.toISOString().slice(0, 10)}.json`
}

/**
 * Um valor em reais, como alguém digita, para centavos inteiros.
 *
 * A escrita anterior era `Number(String(v).replace(',', '.')) * 100`, e o
 * `replace` com string troca só a PRIMEIRA ocorrência. `"1.234,56"` virava
 * `"1.234.56"` → `NaN` → recusado, o que ao menos é visível. Mas `"1.234"` —
 * mil duzentos e trinta e quatro reais, sem centavos — virava `1.234` e era
 * aceito em silêncio como **123 centavos**. Um pagamento de R$ 1.234,00 entrava
 * no extrato como R$ 1,23.
 *
 * A regra aqui:
 *
 *   - com vírgula, ela é o decimal e os pontos são separador de milhar;
 *   - sem vírgula, o ponto é o decimal — `199.90` é o que sai de um teclado
 *     numérico e precisa continuar funcionando;
 *   - **exceto** quando há exatamente três dígitos depois do ponto e nenhuma
 *     vírgula: `"1.234"` é genuinamente ambíguo, e adivinhar aqui é escolher
 *     entre errar por mil para cima ou para baixo. Recusar devolve a decisão a
 *     quem sabe, ao custo de uma redigitação.
 *
 * @returns centavos inteiros, ou `null` quando não dá para ler sem adivinhar
 */
export function parseAmountToCents(digitado: string): number | null {
  const texto = String(digitado ?? '').trim();
  if (!texto) return null;
  // Um formato por vez: dois separadores decimais não é engano de digitação
  // que valha interpretar.
  if ((texto.match(/,/g) || []).length > 1) return null;
  if (!/^[\d.,\s]+$/.test(texto)) return null;

  const semEspaco = texto.replace(/\s/g, '');
  let normalizado;
  if (semEspaco.includes(',')) {
    normalizado = semEspaco.replace(/\./g, '').replace(',', '.');
  } else {
    if (/^\d+\.\d{3}$/.test(semEspaco)) return null;
    if ((semEspaco.match(/\./g) || []).length > 1) {
      normalizado = semEspaco.replace(/\./g, '');
    } else {
      normalizado = semEspaco;
    }
  }

  const reais = Number(normalizado);
  if (!Number.isFinite(reais) || reais < 0) return null;
  // Arredondar sobre o produto em vez de sobre a string cuida do 0.1+0.2 dos
  // binários de ponto flutuante.
  return Math.round(reais * 100);
}
