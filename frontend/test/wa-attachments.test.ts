import { describe, expect, it } from 'vitest'

import en from '@/lib/i18n/locales/en'
import {
  ATTACHMENT_TYPES,
  ATTACHMENT_TYPE_ALIASES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_MB,
  MAX_ATTACHMENTS_PER_SEND,
  acceptAttribute,
  attachmentRefusal,
  canAddFiles,
  extensionOf,
  isClipboardPlaceholderName,
  isPreviewable,
  pastedFileName,
  planSend,
  resolveAttachmentType
} from '@/lib/wa-attachments'

/**
 * A lista de tipos mora no backend e a tela tem uma cópia. O módulo do backend
 * é alcançado por caminho calculado, como em `test/audit-actions.test.ts`, para
 * que o TypeScript o trate como import dinâmico sem precisar de `allowJs`.
 */
const backendUrl = new URL('../../backend/src/config/waAttachmentTypes.js', import.meta.url).href

interface BackendAttachmentConfig {
  ATTACHMENT_TYPES: ReadonlyArray<{ type: string; extensions: string[]; kind: string; convertTo?: string }>
  ATTACHMENT_TYPE_ALIASES: Record<string, string>
  MAX_ATTACHMENT_MB: number
  MAX_ATTACHMENTS_PER_SEND: number
}

const backend = (await import(/* @vite-ignore */ backendUrl)) as BackendAttachmentConfig

const arquivo = (name: string, type: string, size = 1024) => ({ name, type, size })

describe('a cópia da tela acompanha a lista do backend', () => {
  /**
   * Um tipo que só o backend aceita fica escondido no seletor; um que só a
   * tela aceita sobe inteiro para ser recusado no fim. Os dois são o operador
   * achando que o painel está quebrado.
   */
  it('tem exatamente os mesmos tipos, extensões, kinds e conversões', () => {
    const normaliza = (rows: ReadonlyArray<{ type: string; extensions: readonly string[]; kind: string; convertTo?: string }>) =>
      rows.map((row) => ({
        type: row.type,
        extensions: [...row.extensions],
        kind: row.kind,
        convertTo: row.convertTo ?? null
      }))
    expect(normaliza(ATTACHMENT_TYPES)).toEqual(normaliza(backend.ATTACHMENT_TYPES))
  })

  it('os mesmos apelidos', () => {
    expect({ ...ATTACHMENT_TYPE_ALIASES }).toEqual({ ...backend.ATTACHMENT_TYPE_ALIASES })
  })

  it('e os mesmos tetos', () => {
    expect(MAX_ATTACHMENT_MB).toBe(backend.MAX_ATTACHMENT_MB)
    expect(MAX_ATTACHMENTS_PER_SEND).toBe(backend.MAX_ATTACHMENTS_PER_SEND)
    expect(MAX_ATTACHMENT_BYTES).toBe(backend.MAX_ATTACHMENT_MB * 1024 * 1024)
  })
})

describe('extensionOf', () => {
  it('lê a última extensão, minúscula', () => {
    expect(extensionOf('Foto.JPG')).toBe('.jpg')
    expect(extensionOf('backup.tar.zip')).toBe('.zip')
  })

  it('e devolve vazio para nome sem extensão ou arquivo oculto', () => {
    expect(extensionOf('LEIAME')).toBe('')
    expect(extensionOf('.bashrc')).toBe('')
    expect(extensionOf('termina.')).toBe('')
  })
})

describe('resolveAttachmentType', () => {
  it('aceita o tipo do navegador quando ele está na lista', () => {
    expect(resolveAttachmentType({ name: 'rota.png', type: 'image/png' })).toBe('image/png')
    expect(resolveAttachmentType({ name: 'boleto.pdf', type: 'application/pdf' })).toBe('application/pdf')
  })

  it('lê os apelidos como o tipo da lista', () => {
    expect(resolveAttachmentType({ name: 'foto.jpg', type: 'image/jpg' })).toBe('image/jpeg')
    expect(resolveAttachmentType({ name: 'logs.zip', type: 'application/x-zip-compressed' })).toBe('application/zip')
    expect(resolveAttachmentType({ name: 'foto.heif', type: 'image/heif' })).toBe('image/heic')
    expect(resolveAttachmentType({ name: 'aviso.mp3', type: 'audio/mp3' })).toBe('audio/mpeg')
  })

  it('ignora parâmetros e maiúsculas no tipo', () => {
    expect(resolveAttachmentType({ name: 'nota.txt', type: 'Text/Plain; charset=utf-8' })).toBe('text/plain')
  })

  /** A foto do iPhone chega sem tipo nenhum no Chrome e no Firefox. */
  it('decide pela extensão quando o navegador não diz o tipo', () => {
    expect(resolveAttachmentType({ name: 'IMG_0412.HEIC', type: '' })).toBe('image/heic')
    expect(resolveAttachmentType({ name: 'contrato.docx', type: '' })).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
  })

  it('e quando ele diz só octet-stream', () => {
    expect(resolveAttachmentType({ name: 'boleto.pdf', type: 'application/octet-stream' })).toBe('application/pdf')
  })

  /**
   * O Windows com Excel instalado manda `.csv` como planilha do Excel. Declarar
   * isso faria o servidor comparar o conteúdo de um CSV com um XLS e recusar.
   */
  it('prefere a extensão quando o tipo do navegador é de outra linha da lista (CSV no Windows)', () => {
    expect(resolveAttachmentType({ name: 'clientes.csv', type: 'application/vnd.ms-excel' })).toBe('text/csv')
  })

  it('mas um .xls de verdade continua sendo do Excel', () => {
    expect(resolveAttachmentType({ name: 'planilha.xls', type: 'application/vnd.ms-excel' })).toBe('application/vnd.ms-excel')
  })

  it('fica com o tipo quando a extensão é desconhecida ou não existe (print colado)', () => {
    expect(resolveAttachmentType({ name: 'image', type: 'image/png' })).toBe('image/png')
    expect(resolveAttachmentType({ name: 'foto.jfif', type: 'image/jpeg' })).toBe('image/jpeg')
  })

  it('recusa HTML, SVG, script e executável, com ou sem tipo', () => {
    expect(resolveAttachmentType({ name: 'pagina.html', type: 'text/html' })).toBeNull()
    expect(resolveAttachmentType({ name: 'logo.svg', type: 'image/svg+xml' })).toBeNull()
    expect(resolveAttachmentType({ name: 'setup.exe', type: '' })).toBeNull()
    expect(resolveAttachmentType({ name: 'run.js', type: 'application/octet-stream' })).toBeNull()
  })

  it('e não deixa a extensão salvar um tipo proibido que o navegador afirmou', () => {
    expect(resolveAttachmentType({ name: 'pagina.pdf', type: 'text/html' })).toBeNull()
  })

  it('sem tipo e sem extensão conhecida, não sai', () => {
    expect(resolveAttachmentType({ name: 'arquivo', type: '' })).toBeNull()
  })
})

describe('attachmentRefusal', () => {
  it('não recusa o que o servidor aceitaria', () => {
    expect(attachmentRefusal(arquivo('rota.png', 'image/png'))).toBeNull()
    expect(attachmentRefusal(arquivo('IMG_0001.HEIC', ''))).toBeNull()
  })

  it('o teto exato ainda passa; um byte a mais, não', () => {
    expect(attachmentRefusal(arquivo('video.mp4', 'video/mp4', MAX_ATTACHMENT_BYTES))).toBeNull()
    expect(attachmentRefusal(arquivo('video.mp4', 'video/mp4', MAX_ATTACHMENT_BYTES + 1))).toEqual({
      key: 'whatsapp.error.attachmentTooLarge',
      vars: { max: 16 }
    })
  })

  it('recusa o tipo fora da lista', () => {
    expect(attachmentRefusal(arquivo('pagina.html', 'text/html'))).toEqual({ key: 'whatsapp.error.attachmentTypeNotAllowed' })
  })

  it('recusa o arquivo vazio', () => {
    expect(attachmentRefusal(arquivo('nada.txt', 'text/plain', 0))).toEqual({ key: 'whatsapp.error.attachmentEmpty' })
  })

  it('e toda chave que ela devolve existe no dicionário', () => {
    for (const key of [
      'whatsapp.error.attachmentTooLarge',
      'whatsapp.error.attachmentTypeNotAllowed',
      'whatsapp.error.attachmentEmpty',
      'whatsapp.error.attachmentContentMismatch'
    ] as const) {
      expect(en[key], key).toBeTruthy()
    }
    expect(en['whatsapp.error.attachmentTooLarge']).toContain('{max}')
  })
})

describe('isPreviewable', () => {
  it('mostra miniatura das imagens que todo navegador desenha', () => {
    expect(isPreviewable('image/jpeg')).toBe(true)
    expect(isPreviewable('image/gif')).toBe(true)
  })

  it('mas não de HEIC, PDF ou tipo desconhecido', () => {
    expect(isPreviewable('image/heic')).toBe(false)
    expect(isPreviewable('application/pdf')).toBe(false)
    expect(isPreviewable(null)).toBe(false)
  })
})

describe('planSend', () => {
  it('sem arquivo é uma mensagem de texto, aparada', () => {
    expect(planSend({ body: '  Bom dia  ', files: [] })).toEqual([{ body: 'Bom dia', file: null }])
  })

  it('sem texto e sem arquivo, nenhum envio', () => {
    expect(planSend({ body: '   ', files: [] })).toEqual([])
  })

  it('um arquivo leva o texto como legenda', () => {
    expect(planSend({ body: 'Rota da fibra', files: ['a'] })).toEqual([{ body: 'Rota da fibra', file: 'a' }])
  })

  it('vários arquivos: só o primeiro leva o texto, na ordem da tela', () => {
    expect(planSend({ body: 'Fotos da instalação', files: ['a', 'b', 'c'] })).toEqual([
      { body: 'Fotos da instalação', file: 'a' },
      { body: '', file: 'b' },
      { body: '', file: 'c' }
    ])
  })

  it('arquivos sem texto vão todos sem legenda', () => {
    expect(planSend({ body: '  ', files: ['a', 'b'] })).toEqual([
      { body: '', file: 'a' },
      { body: '', file: 'b' }
    ])
  })
})

describe('acceptAttribute', () => {
  const accept = acceptAttribute().split(',')

  it('traz todo tipo e toda extensão da lista', () => {
    for (const row of ATTACHMENT_TYPES) {
      expect(accept).toContain(row.type)
      for (const ext of row.extensions) expect(accept).toContain(ext)
    }
  })

  it('e nada do que fica de fora de propósito', () => {
    for (const proibido of ['text/html', '.html', 'image/svg+xml', '.svg', '.js', '.exe']) {
      expect(accept).not.toContain(proibido)
    }
  })
})

describe('canAddFiles', () => {
  it('aceita tudo enquanto cabe', () => {
    expect(canAddFiles(0, 3)).toEqual({ accepted: 3, refused: 0 })
    expect(canAddFiles(7, 3)).toEqual({ accepted: 3, refused: 0 })
  })

  it('aceita o que cabe e recusa o resto', () => {
    expect(canAddFiles(8, 5)).toEqual({ accepted: 2, refused: 3 })
    expect(canAddFiles(0, MAX_ATTACHMENTS_PER_SEND + 2)).toEqual({ accepted: MAX_ATTACHMENTS_PER_SEND, refused: 2 })
  })

  it('com a caixa cheia, recusa tudo', () => {
    expect(canAddFiles(MAX_ATTACHMENTS_PER_SEND, 1)).toEqual({ accepted: 0, refused: 1 })
  })
})

describe('pastedFileName', () => {
  const quando = new Date(2026, 8, 26, 9, 5, 7)

  it('nomeia o print pela hora', () => {
    expect(pastedFileName(quando, 0, 'image/png')).toBe('print-090507.png')
  })

  it('o segundo do mesmo colar ganha sufixo, e a extensão segue o tipo', () => {
    expect(pastedFileName(quando, 1, 'image/jpeg')).toBe('print-090507-2.jpg')
    expect(pastedFileName(quando, 2, 'image/jpg')).toBe('print-090507-3.jpg')
  })
})

describe('isClipboardPlaceholderName', () => {
  it('reconhece o nome que a área de transferência inventa', () => {
    expect(isClipboardPlaceholderName('image.png')).toBe(true)
    expect(isClipboardPlaceholderName('')).toBe(true)
  })

  it('e mantém o nome de um arquivo copiado de verdade', () => {
    expect(isClipboardPlaceholderName('foto-poste.png')).toBe(false)
    expect(isClipboardPlaceholderName('image-2.png')).toBe(false)
  })
})

describe('planSend com áudio', () => {
  const isAudio = (f: string) => f.endsWith('.webm')

  it('o áudio não leva legenda: o texto vai antes, como mensagem própria', () => {
    expect(planSend({ body: 'Segue o áudio', files: ['voz.webm'], isAudio })).toEqual([
      { body: 'Segue o áudio', file: null },
      { body: '', file: 'voz.webm' }
    ])
  })

  it('com uma foto junto, o texto vai de legenda da foto', () => {
    expect(planSend({ body: 'Olha', files: ['voz.webm', 'foto.jpg'], isAudio })).toEqual([
      { body: '', file: 'voz.webm' },
      { body: 'Olha', file: 'foto.jpg' }
    ])
  })

  it('áudio sem texto é só o áudio', () => {
    expect(planSend({ body: ' ', files: ['voz.webm'], isAudio })).toEqual([{ body: '', file: 'voz.webm' }])
  })
})
