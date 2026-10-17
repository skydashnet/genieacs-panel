/**
 * Um arquivo mínimo, com os primeiros bytes verdadeiros, de cada tipo aceito.
 *
 * O upload confere a assinatura contra o tipo declarado, então um teste que
 * manda "qualquer coisa" como `application/pdf` testa a recusa, não o aceite.
 * Estes são curtos de propósito: só o cabeçalho que a regra lê, mais um pouco.
 */

/** Um PNG de um pixel, inteiro. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * Um HEIC de 8×8 de verdade, gerado com libheif (pillow-heif) só para este
 * teste — o `heic-convert` decodifica, mas não codifica. Marca `heic`.
 */
export const HEIC = Buffer.from(
  'AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAXxtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABoAABAAAAAAAAADMAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAA5waXRtAAAAAAABAAAA/GlwcnAAAADcaXBjbwAAAHVodmNDAQNwAAAAAAAAAAAAHvAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQApQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbqrprm4CGgwIAAAAyAAAADAIRiAAEABkQBwXPBiQAAABNjb2xybmNseAABAA0ABoAAAAAUaXNwZQAAAAAAAABAAAAAQAAAAChjbGFwAAAACAAAAAEAAAAIAAAAAf///8gAAAAC////yAAAAAIAAAAQcGl4aQAAAAADCAgIAAAAGGlwbWEAAAAAAAAAAQABBYECAwWEAAAAO21kYXQAAAAvKAGvEyFkY0D1JyL//2q6n/rQWf9v9lhZ3K6AwVvy+sD2ZJvA86qRnoCHaacwFXg=',
  'base64'
);

const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
const ZIP = bytes([0x50, 0x4b, 0x03, 0x04], [0x14, 0x00, 0x00, 0x00], 'conteudo');
const OLE = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], Buffer.alloc(24));

/** Tipo → bytes que passam na conferência. Um por linha da lista única. */
export const SAMPLES = Object.freeze({
  'image/jpeg': bytes([0xff, 0xd8, 0xff, 0xe0], [0x00, 0x10], 'JFIF\0'),
  'image/png': PNG,
  'image/webp': bytes('RIFF', [0x1a, 0, 0, 0], 'WEBPVP8 '),
  'image/gif': bytes('GIF89a', [1, 0, 1, 0, 0, 0, 0]),
  'image/heic': HEIC,
  'application/pdf': bytes('%PDF-1.7\n%âãÏÓ\n'),
  'application/msword': OLE,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ZIP,
  'application/vnd.ms-excel': OLE,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ZIP,
  'text/plain': bytes('ordem de serviço 123\nposte 45\n'),
  // Em latin-1, como o Excel do Windows exporta: `ç` e `ã` num byte só.
  'text/csv': Buffer.from('nome;cidade\nJoão;Criciúma\nConceição;Içara\n', 'latin1'),
  'application/zip': ZIP,
  'video/mp4': bytes([0, 0, 0, 0x18], 'ftypmp42', [0, 0, 0, 0], 'isommp42'),
  'audio/ogg': bytes('OggS', [0, 2], Buffer.alloc(20)),
  'audio/mpeg': bytes('ID3', [4, 0, 0, 0, 0, 0, 0]),
  // O cabeçalho EBML de um WebM gravado pelo Chrome.
  'audio/webm': bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]),
  // Um M4A gravado pelo Safari: caixa `ftyp` com a marca M4A.
  'audio/mp4': bytes([0, 0, 0, 0x18], 'ftypM4A ', [0, 0, 0, 0], 'M4A isom')
});

/** Bytes que não são de tipo nenhum da lista (a não ser texto). */
export const HTML = Buffer.from('<html><body><script>alert(1)</script></body></html>');
