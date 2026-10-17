/**
 * Os primeiros bytes de um anexo conferidos contra o tipo que o navegador disse.
 *
 * O `Content-Type` do upload é uma declaração de quem mandou, não um fato: um
 * `.docx` que na verdade é `<html>` passaria pela lista de tipos e chegaria ao
 * celular do assinante com o nome do provedor. A lista decide QUAIS tipos
 * entram; esta função decide se os bytes SÃO daquele tipo.
 *
 * Pura e sem dependência de propósito: só olha o começo do buffer, nunca
 * descompacta nada (um ZIP é conferido pela assinatura, não aberto — abrir é
 * onde mora a bomba de descompressão) e não sabe nada de disco nem de request.
 */

/** Quanto do começo de um texto é lido atrás de um byte NUL. */
export const TEXT_SNIFF_BYTES = 8 * 1024;

/** As marcas de `ftyp` que um HEIC/HEIF do iPhone (e parentes) declara. */
export const HEIC_BRANDS = Object.freeze(['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1']);

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Se `bytes` aparece em `buffer` a partir de `offset`. */
function startsWith(buffer, bytes, offset = 0) {
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

/** O mesmo, com a assinatura escrita como texto ASCII. */
function startsWithAscii(buffer, text, offset = 0) {
  return startsWith(buffer, Array.from(Buffer.from(text, 'latin1')), offset);
}

/** A marca principal de uma caixa `ftyp` (ISO BMFF), ou null. */
export function ftypBrand(buffer) {
  if (!startsWithAscii(buffer, 'ftyp', 4) || buffer.length < 12) return null;
  return buffer.subarray(8, 12).toString('latin1');
}

/**
 * Texto é "não tem NUL nos primeiros 8 KB" — e só isso.
 *
 * NÃO se exige UTF-8, de propósito: o CSV que o Excel do Windows exporta em
 * português sai em cp1252/latin-1, e exigir UTF-8 recusaria justamente o
 * arquivo que o operador mais manda. O que separa texto de binário (e de
 * executável, que sempre tem NUL no cabeçalho) é o NUL. E o risco de um texto
 * com conteúdo de HTML é pequeno: o painel serve `text/plain` como download,
 * com `nosniff`, nunca renderizado.
 */
function looksLikeText(buffer) {
  return !buffer.subarray(0, TEXT_SNIFF_BYTES).includes(0x00);
}

/** Uma regra por tipo da lista de `config/waAttachmentTypes.js`. */
const RULES = {
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]),
  'image/gif': (b) => startsWithAscii(b, 'GIF87a') || startsWithAscii(b, 'GIF89a'),
  'image/webp': (b) => startsWithAscii(b, 'RIFF') && startsWithAscii(b, 'WEBP', 8),
  'image/heic': (b) => HEIC_BRANDS.includes(ftypBrand(b)),
  'application/pdf': (b) => startsWithAscii(b, '%PDF'),
  // Word e Excel antigos são o mesmo contêiner OLE; a assinatura não os separa,
  // e não precisa: os dois são entregues como documento.
  'application/msword': (b) => startsWith(b, OLE),
  'application/vnd.ms-excel': (b) => startsWith(b, OLE),
  // DOCX e XLSX são ZIPs por dentro. Confere-se que é um ZIP, sem abrir.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (b) => startsWith(b, ZIP),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (b) => startsWith(b, ZIP),
  'application/zip': (b) => startsWith(b, ZIP),
  'text/plain': looksLikeText,
  'text/csv': looksLikeText,
  'video/mp4': (b) => ftypBrand(b) !== null,
  'audio/ogg': (b) => startsWithAscii(b, 'OggS'),
  // O cabeçalho EBML, comum ao WebM e ao Matroska.
  'audio/webm': (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]),
  'audio/mp4': (b) => ftypBrand(b) !== null,
  // Com etiqueta ID3 na frente, ou direto no primeiro quadro (11 bits de sync).
  'audio/mpeg': (b) => startsWithAscii(b, 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)
};

/**
 * Se os bytes combinam com o tipo declarado (já normalizado, sem parâmetros).
 *
 * Um tipo sem regra devolve false: quem acrescentar um tipo à lista sem dizer
 * como reconhecê-lo descobre isso no primeiro upload, e não pelo assinante.
 */
export function matchesDeclaredType(buffer, type) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  const rule = RULES[type];
  return rule ? rule(buffer) : false;
}

export default { matchesDeclaredType, ftypBrand, HEIC_BRANDS, TEXT_SNIFF_BYTES };
