/**
 * Um leitor de Markdown pequeno, para os manuais embutidos no painel (a aba
 * Ajuda do console e o "Como funciona" da tela de Plano).
 *
 * Por que não uma biblioteca: o conteúdo é nosso, escrito à mão em `docs/`, e
 * usa um pedaço pequeno da sintaxe — títulos, parágrafos, listas, negrito,
 * itálico, código, links, tabelas, citações e linha horizontal. Uma
 * dependência inteira para isso pesaria mais que o próprio manual.
 *
 * E por que uma ÁRVORE e não HTML: quem desenha é o React
 * (`components/markdown-view.tsx`), que escapa todo texto sozinho. HTML cru no
 * Markdown não vira tag — sai como texto, letra por letra. Não há
 * `dangerouslySetInnerHTML` em lugar nenhum desse caminho.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; id: string; text: string; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'code'; text: string }
  | { type: 'quote'; children: Inline[] }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][] }
  | { type: 'rule' }

export interface TocEntry {
  id: string
  level: 2 | 3
  text: string
}

/**
 * Um trecho do documento para a busca: um título de nível 2 ou 3 e o que vem
 * até o próximo deles. `parentId` é o nível 2 de que um nível 3 faz parte, para
 * a busca poder mostrar o título de cima quando só o de baixo casa.
 */
export interface Section {
  id: string | null
  parentId: string | null
  blocks: Block[]
  text: string
}

/** Só estes esquemas viram link; o resto (`javascript:`, `data:`…) fica texto. */
const SAFE_HREF = /^(https?:\/\/|mailto:|#)/i

export function isSafeHref(href: string): boolean {
  return SAFE_HREF.test(href.trim())
}

/** Sem acento e em minúsculas: "Inadimplência" e "inadimplencia" se encontram. */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** O `id` de um título: minúsculas, sem acento, palavras unidas por hífen. */
export function slugify(text: string): string {
  const slug = normalize(text)
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
  return slug || 'secao'
}

// ---------------------------------------------------------------------------
// Em linha
// ---------------------------------------------------------------------------

/**
 * Lê o texto de uma linha em pedaços. Na ordem de força: código (nada dentro
 * dele é interpretado), link, negrito, itálico. Um marcador sem par é texto.
 */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = []
  let buffer = ''
  const flush = () => {
    if (buffer) out.push({ type: 'text', text: buffer })
    buffer = ''
  }

  let i = 0
  while (i < source.length) {
    const ch = source[i]

    if (ch === '\\' && i + 1 < source.length && /[\\`*_[\]()|#>-]/.test(source[i + 1])) {
      buffer += source[i + 1]
      i += 2
      continue
    }

    if (ch === '`') {
      const end = source.indexOf('`', i + 1)
      if (end > i) {
        flush()
        out.push({ type: 'code', text: source.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    if (ch === '[') {
      const close = findClosing(source, i + 1, '[', ']')
      if (close > i && source[close + 1] === '(') {
        const end = source.indexOf(')', close + 2)
        if (end > close) {
          const label = source.slice(i + 1, close)
          const href = source.slice(close + 2, end).trim()
          flush()
          if (isSafeHref(href)) out.push({ type: 'link', href, children: parseInline(label) })
          else out.push(...parseInline(label))
          i = end + 1
          continue
        }
      }
    }

    if ((ch === '*' || ch === '_') && source[i + 1] === ch) {
      const marker = ch + ch
      const end = source.indexOf(marker, i + 2)
      if (end > i + 2) {
        flush()
        out.push({ type: 'strong', children: parseInline(source.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }

    if (ch === '*' || (ch === '_' && !/\w/.test(source[i - 1] ?? ''))) {
      const end = source.indexOf(ch, i + 1)
      if (end > i + 1 && source[i + 1] !== ' ') {
        flush()
        out.push({ type: 'em', children: parseInline(source.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }

    buffer += ch
    i += 1
  }
  flush()
  return out
}

function findClosing(source: string, from: number, open: string, close: string): number {
  let depth = 0
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === open) depth += 1
    else if (source[i] === close) {
      if (depth === 0) return i
      depth -= 1
    }
  }
  return -1
}

/** O texto corrido de pedaços em linha, para `id`, sumário e busca. */
export function inlineText(nodes: Inline[]): string {
  return nodes.map((node) => (node.type === 'text' || node.type === 'code' ? node.text : inlineText(node.children))).join('')
}

// ---------------------------------------------------------------------------
// Blocos
// ---------------------------------------------------------------------------

const HEADING = /^(#{1,4})\s+(.*?)\s*#*\s*$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === '\\' && row[i + 1] === '|') {
      cell += '|'
      i += 1
    } else if (row[i] === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += row[i]
    }
  }
  cells.push(cell.trim())
  return cells
}

function startsBlock(line: string, next: string | undefined): boolean {
  return HEADING.test(line) || BULLET.test(line) || ORDERED.test(line) || RULE.test(line)
    || line.trimStart().startsWith('```') || line.trimStart().startsWith('>')
    || (line.includes('|') && next !== undefined && TABLE_DIVIDER.test(next))
}

/**
 * Lê o documento inteiro em blocos. Os `id` dos títulos saem únicos: o segundo
 * "Configuração" vira `configuracao-2`.
 */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  const usados = new Map<string, number>()
  const idUnico = (text: string) => {
    const base = slugify(text)
    const vezes = (usados.get(base) ?? 0) + 1
    usados.set(base, vezes)
    return vezes === 1 ? base : `${base}-${vezes}`
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i += 1
      continue
    }

    if (line.trimStart().startsWith('```')) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        body.push(lines[i])
        i += 1
      }
      i += 1 // a cerca de fechamento (ou o fim do arquivo)
      blocks.push({ type: 'code', text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3 | 4
      const children = parseInline(heading[2])
      const text = inlineText(children)
      blocks.push({ type: 'heading', level, id: idUnico(text), text, children })
      i += 1
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' })
      i += 1
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const header = splitRow(line).map(parseInline)
      const rows: Inline[][][] = []
      i += 2
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]).map(parseInline))
        i += 1
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }

    if (line.trimStart().startsWith('>')) {
      const body: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith('>')) {
        body.push(lines[i].trimStart().replace(/^>\s?/, ''))
        i += 1
      }
      blocks.push({ type: 'quote', children: parseInline(body.join(' ')) })
      continue
    }

    const bullet = BULLET.test(line)
    if (bullet || ORDERED.test(line)) {
      const pattern = bullet ? BULLET : ORDERED
      const items: Inline[][] = []
      let atual: string[] = []
      const fecha = () => {
        if (atual.length) items.push(parseInline(atual.join(' ')))
        atual = []
      }
      while (i < lines.length) {
        const l = lines[i]
        const m = pattern.exec(l)
        // Um item recuado (sublista) entra no item de cima como texto: os
        // manuais não usam sublistas, e assim nada some.
        if (m && !/^\s{2,}/.test(l)) {
          fecha()
          atual.push(m[1])
        } else if (l.trim() && /^\s+/.test(l) && atual.length) {
          atual.push(l.trim().replace(/^[-*+]\s+|^\d+[.)]\s+/, ''))
        } else {
          break
        }
        i += 1
      }
      fecha()
      blocks.push({ type: 'list', ordered: !bullet, items })
      continue
    }

    const body: string[] = [line.trim()]
    i += 1
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
      body.push(lines[i].trim())
      i += 1
    }
    blocks.push({ type: 'paragraph', children: parseInline(body.join(' ')) })
  }
  return blocks
}

// ---------------------------------------------------------------------------
// Sumário e busca
// ---------------------------------------------------------------------------

/** O sumário: os títulos de nível 2 e 3, na ordem do documento. */
export function buildToc(blocks: Block[]): TocEntry[] {
  return blocks.flatMap((block) =>
    block.type === 'heading' && (block.level === 2 || block.level === 3)
      ? [{ id: block.id, level: block.level, text: block.text }]
      : []
  )
}

function blockText(block: Block): string {
  switch (block.type) {
    case 'heading':
      return block.text
    case 'paragraph':
    case 'quote':
      return inlineText(block.children)
    case 'list':
      return block.items.map(inlineText).join(' ')
    case 'code':
      return block.text
    case 'table':
      return [block.header, ...block.rows].map((row) => row.map(inlineText).join(' ')).join(' ')
    case 'rule':
      return ''
  }
}

/**
 * Corta o documento em trechos, um por título de nível 2 ou 3. O que vem antes
 * do primeiro deles (o título do documento e a introdução) é o trecho `id: null`.
 */
export function sectionize(blocks: Block[]): Section[] {
  const sections: Section[] = []
  let atual: Section = { id: null, parentId: null, blocks: [], text: '' }
  let pai: string | null = null
  for (const block of blocks) {
    if (block.type === 'heading' && (block.level === 2 || block.level === 3)) {
      sections.push(atual)
      if (block.level === 2) pai = block.id
      atual = { id: block.id, parentId: block.level === 3 ? pai : null, blocks: [], text: '' }
    }
    atual.blocks.push(block)
  }
  sections.push(atual)
  return sections
    .filter((section) => section.blocks.length > 0)
    .map((section) => ({ ...section, text: normalize(section.blocks.map(blockText).join(' ')) }))
}

/**
 * Os blocos que a busca mostra: cada trecho em que TODAS as palavras buscadas
 * aparecem (sem acento, sem caixa). Um nível 3 que casa sozinho leva junto o
 * título do nível 2 dele, para a pessoa saber onde está. Busca vazia devolve o
 * documento inteiro.
 */
export function filterBlocks(blocks: Block[], query: string): Block[] {
  const termos = normalize(query).split(/\s+/).filter(Boolean)
  if (termos.length === 0) return blocks
  const sections = sectionize(blocks)
  const casa = new Set(sections.filter((s) => termos.every((termo) => s.text.includes(termo))))
  const idsQueCasam = new Set([...casa].map((s) => s.id))
  const out: Block[] = []
  const paisMostrados = new Set<string>()
  for (const section of sections) {
    // Um nível 2 que casa leva os níveis 3 dele inteiros.
    const paiCasa = section.parentId !== null && idsQueCasam.has(section.parentId)
    if (!casa.has(section) && !paiCasa) continue
    if (section.parentId !== null && !idsQueCasam.has(section.parentId) && !paisMostrados.has(section.parentId)) {
      const titulo = sections.find((s) => s.id === section.parentId)?.blocks[0]
      if (titulo) out.push(titulo)
    }
    if (section.id !== null && section.parentId === null) paisMostrados.add(section.id)
    if (section.parentId !== null) paisMostrados.add(section.parentId)
    out.push(...section.blocks)
  }
  return out
}
