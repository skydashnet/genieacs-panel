/**
 * Firmware da ONT: o que a tela decide sozinha.
 *
 * Quem decide o que SERVE para a ONT é o servidor (`backend/src/services/firmwareFiles.js`),
 * que confere de novo na hora de mandar. Aqui é só a escolha inicial e a forma
 * de mostrar o tamanho — funções puras, porque o vitest roda em `node`, sem jsdom.
 */
import type { DeviceFirmwareFile } from '@/lib/api'

/**
 * O arquivo que a tela já deixa marcado: o mais novo que não é o instalado.
 *
 * A lista chega do servidor do mais novo para o mais antigo. Nenhum marcado
 * quando só sobra o instalado — reinstalar a mesma versão é recusado.
 */
export function defaultFirmwareChoice(files: readonly DeviceFirmwareFile[]): string | null {
  return files.find((file) => !file.installed)?.id ?? null
}

/** O tamanho em unidades de 1024, com uma casa: firmware tem dezenas de MB. */
export function formatFileSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  const unidades = ['KB', 'MB', 'GB']
  let valor = bytes / 1024
  let indice = 0
  while (valor >= 1024 && indice < unidades.length - 1) {
    valor /= 1024
    indice += 1
  }
  return `${valor.toFixed(1)} ${unidades[indice]}`
}

/**
 * O teto do envio de firmware, o mesmo padrão do servidor (64 MB). Conferido
 * aqui antes de mandar para a pessoa não esperar o upload inteiro de um arquivo
 * que o servidor (ou o nginx na frente dele) vai recusar no fim.
 */
export const FIRMWARE_MAX_BYTES = 64 * 1024 * 1024

/** O que acompanha o arquivo: os mesmos campos do GenieACS (`metadata`). */
export interface FirmwareMeta {
  oui: string
  productClass: string
  version: string
}

/**
 * Os cabeçalhos do envio: o corpo é o arquivo cru, então nome e metadados vão
 * em cabeçalho — codificados, porque cabeçalho HTTP não carrega acento. Campo
 * vazio não vai: o servidor grava sem ele em vez de gravar `''`.
 */
export function firmwareUploadHeaders(fileName: string, meta?: Partial<FirmwareMeta>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-File-Name': encodeURIComponent(fileName)
  }
  const campos: [keyof FirmwareMeta, string][] = [
    ['oui', 'X-Fw-Oui'],
    ['productClass', 'X-Fw-Product-Class'],
    ['version', 'X-Fw-Version']
  ]
  for (const [campo, cabecalho] of campos) {
    const valor = meta?.[campo]?.trim()
    if (valor) headers[cabecalho] = encodeURIComponent(valor)
  }
  return headers
}

export type FirmwareFileProblem = 'empty' | 'tooLarge'

/** Por que o arquivo escolhido nem vale a pena mandar — ou `null`, se vale. */
export function firmwareFileProblem(size: number, max: number = FIRMWARE_MAX_BYTES): FirmwareFileProblem | null {
  if (!Number.isFinite(size) || size <= 0) return 'empty'
  if (size > max) return 'tooLarge'
  return null
}

/**
 * O modelo é obrigatório na tela: sem ele o arquivo não entra na lista de
 * firmware da ONT nem no lote — ficaria no GenieACS sem servir para nada.
 */
export function firmwareMetaProblem(meta: Partial<FirmwareMeta>): 'productClassRequired' | null {
  return meta.productClass?.trim() ? null : 'productClassRequired'
}

/**
 * O reenvio de um firmware sem dono: o arquivo escolhido no computador tem de
 * ter o mesmo tamanho do antigo — é a conferência barata de que é o mesmo
 * arquivo. Sem o tamanho do antigo, quem confere é o servidor.
 */
export function reassignSizeMatches(originalSize: number | null | undefined, chosenSize: number): boolean {
  if (typeof originalSize !== 'number' || !Number.isFinite(originalSize)) return true
  return originalSize === chosenSize
}

/** O nome com que o arquivo fica no ACS compartilhado: `<tag>--<nome>`. */
export function scopedFirmwareName(tag: string | null | undefined, name: string): string {
  return tag ? `${tag}--${name}` : name
}

/**
 * A resposta de erro vem com frase do servidor e `code`. A exceção é o 413 do
 * nginx na frente do painel: chega como página HTML, sem `code`, e mostrar
 * aquilo num aviso seria pior que nada — vira "arquivo grande demais".
 */
export function firmwareErrorKind(res: { code?: string; message?: string }): 'tooLarge' | 'generic' | null {
  if (res.code) return null
  const texto = (res.message ?? '').trim()
  if (/\b413\b/.test(texto) || /entity too large/i.test(texto)) return 'tooLarge'
  if (!texto || texto.startsWith('<')) return 'generic'
  return null
}
