import { describe, expect, it } from 'vitest'

import type { DeviceFirmwareFile } from '@/lib/api'
import {
  FIRMWARE_MAX_BYTES,
  defaultFirmwareChoice,
  firmwareErrorKind,
  firmwareFileProblem,
  firmwareMetaProblem,
  firmwareUploadHeaders,
  formatFileSize,
  reassignSizeMatches,
  scopedFirmwareName
} from '@/lib/firmware'

const arquivo = (id: string, installed = false): DeviceFirmwareFile => ({
  id, version: id, oui: null, productClass: 'F670L', size: null, uploadedAt: null, installed
})

describe('o firmware que a tela já deixa marcado', () => {
  it('o mais novo que não é o instalado', () => {
    expect(defaultFirmwareChoice([arquivo('v3'), arquivo('v2', true), arquivo('v1')])).toBe('v3')
    expect(defaultFirmwareChoice([arquivo('v3', true), arquivo('v2'), arquivo('v1')])).toBe('v2')
  })

  it('nenhum, quando só sobra o instalado ou a lista está vazia', () => {
    expect(defaultFirmwareChoice([arquivo('v1', true)])).toBeNull()
    expect(defaultFirmwareChoice([])).toBeNull()
  })
})

describe('o tamanho do arquivo', () => {
  it('em unidades de 1024, com uma casa', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(2048)).toBe('2.0 KB')
    expect(formatFileSize(12_345_678)).toBe('11.8 MB')
    expect(formatFileSize(3 * 1024 ** 3)).toBe('3.0 GB')
  })

  it('sem número, não inventa zero', () => {
    expect(formatFileSize(null)).toBeNull()
    expect(formatFileSize(undefined)).toBeNull()
    expect(formatFileSize(Number.NaN)).toBeNull()
    expect(formatFileSize(-1)).toBeNull()
  })
})

describe('os cabeçalhos do envio de firmware', () => {
  it('nome e metadados codificados, corpo cru', () => {
    expect(firmwareUploadHeaders('ção v2.bin', { oui: ' D8C678 ', productClass: 'F670L', version: 'V9.0 β' })).toEqual({
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('ção v2.bin'),
      'X-Fw-Oui': 'D8C678',
      'X-Fw-Product-Class': 'F670L',
      'X-Fw-Version': encodeURIComponent('V9.0 β')
    })
  })

  it('campo vazio não vai', () => {
    const headers = firmwareUploadHeaders('a.bin', { oui: '  ', productClass: 'HG8245', version: '' })
    expect(headers).not.toHaveProperty('X-Fw-Oui')
    expect(headers).not.toHaveProperty('X-Fw-Version')
    expect(headers['X-Fw-Product-Class']).toBe('HG8245')
    expect(firmwareUploadHeaders('a.bin')).toEqual({ 'Content-Type': 'application/octet-stream', 'X-File-Name': 'a.bin' })
  })
})

describe('o arquivo antes de enviar', () => {
  it('vazio e grande demais são recusados na tela', () => {
    expect(firmwareFileProblem(0)).toBe('empty')
    expect(firmwareFileProblem(Number.NaN)).toBe('empty')
    expect(firmwareFileProblem(FIRMWARE_MAX_BYTES + 1)).toBe('tooLarge')
    expect(firmwareFileProblem(FIRMWARE_MAX_BYTES)).toBeNull()
    expect(firmwareFileProblem(10, 5)).toBe('tooLarge')
  })

  it('o teto é 64 MB', () => {
    expect(FIRMWARE_MAX_BYTES).toBe(64 * 1024 * 1024)
    expect(formatFileSize(FIRMWARE_MAX_BYTES)).toBe('64.0 MB')
  })

  it('o modelo é obrigatório', () => {
    expect(firmwareMetaProblem({ productClass: '  ' })).toBe('productClassRequired')
    expect(firmwareMetaProblem({})).toBe('productClassRequired')
    expect(firmwareMetaProblem({ productClass: 'F670L' })).toBeNull()
  })
})

describe('o reenvio do firmware sem dono', () => {
  it('o tamanho tem de bater com o do antigo', () => {
    expect(reassignSizeMatches(1000, 1000)).toBe(true)
    expect(reassignSizeMatches(1000, 999)).toBe(false)
  })

  it('sem o tamanho do antigo, quem confere é o servidor', () => {
    expect(reassignSizeMatches(null, 5)).toBe(true)
    expect(reassignSizeMatches(undefined, 5)).toBe(true)
  })

  it('o nome novo leva o prefixo da tag', () => {
    expect(scopedFirmwareName('prov_a', 'fw.bin')).toBe('prov_a--fw.bin')
    expect(scopedFirmwareName(null, 'fw.bin')).toBe('fw.bin')
  })
})

describe('o erro do envio', () => {
  it('com code, vale a frase do servidor', () => {
    expect(firmwareErrorKind({ code: 'firmware_exists', message: 'Já existe' })).toBeNull()
  })

  it('o 413 do nginx vira "grande demais"', () => {
    expect(firmwareErrorKind({ message: '<html><head><title>413 Request Entity Too Large</title></head></html>' })).toBe('tooLarge')
  })

  it('página HTML ou nada vira a frase genérica', () => {
    expect(firmwareErrorKind({ message: '<html>502 Bad Gateway</html>' })).toBe('generic')
    expect(firmwareErrorKind({})).toBe('generic')
    expect(firmwareErrorKind({ message: 'Sem conexão' })).toBeNull()
  })
})
