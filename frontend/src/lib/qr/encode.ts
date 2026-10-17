/**
 * Dependency-free QR Code encoder — byte mode, versions 1..13, EC levels L and M.
 *
 * Why this lives in the repo instead of a package: the only consumer is the PIX
 * "BR Code" payment code, whose payload is a fixed 110..250 character string that
 * ends in `6304` + a CRC16 over everything before it. Any library that trims,
 * uppercases or otherwise normalises the payload silently invalidates that CRC,
 * and the resulting code fails only in a bank app — never in CI. Keeping the
 * encoder here means the exact bytes we hand to the encoder are the exact bytes
 * that get drawn, and the whole thing is testable from `node --test` because it
 * has no imports at all.
 *
 * Implemented per ISO/IEC 18004:2015: GF(256) arithmetic, Reed-Solomon with
 * multi-block interleaving, alignment patterns, BCH(15,5) format information,
 * BCH(18,6) version information for V >= 7, and all eight data masks scored with
 * penalty rules N1..N4 (lowest score wins — no mask is hardcoded).
 *
 * Deliberately NOT implemented: numeric/alphanumeric/kanji modes, ECI, structured
 * append, versions above 13. Byte mode with UTF-8 covers every payload we draw.
 *
 * Verified module-for-module against the Python `qrcode` package across every
 * byte length from 1 to 425; see backend/test/fixtures/qr-vectors.json.
 *
 * Erasable-syntax only (no enums, no parameter properties, no namespaces) so that
 * Node's type stripping can import this file directly from the backend test suite.
 */

export type QrEcLevel = 'L' | 'M';

export type QrMatrix = {
  size: number;
  version: number;
  ecLevel: QrEcLevel;
  /** Row-major, `size * size` entries. `true` is a dark module. */
  modules: boolean[];
};

const MIN_VERSION = 1;
const MAX_VERSION = 13;

/**
 * Per version (index = version - 1): error correction codewords per block, then
 * (block count, data codewords per block) for group 1 and group 2.
 * ISO/IEC 18004:2015 Table 9.
 */
const EC_BLOCKS: Readonly<Record<QrEcLevel, readonly (readonly number[])[]>> = {
  L: [
    [7, 1, 19, 0, 0],
    [10, 1, 34, 0, 0],
    [15, 1, 55, 0, 0],
    [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0],
    [20, 2, 78, 0, 0],
    [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0],
    [18, 2, 68, 2, 69],
    [20, 4, 81, 0, 0],
    [24, 2, 92, 2, 93],
    [26, 4, 107, 0, 0]
  ],
  M: [
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
    [30, 1, 50, 4, 51],
    [22, 6, 36, 2, 37],
    [22, 8, 37, 1, 38]
  ]
};

/** Alignment pattern centre coordinates per version (index = version - 1). */
const ALIGNMENT_CENTRES: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62]
];

/* -------------------------------------------------------------------------- */
/* GF(256)                                                                     */
/* -------------------------------------------------------------------------- */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

function initGaloisTables(): void {
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if ((value & 0x100) !== 0) value ^= 0x11d; // x^8 + x^4 + x^3 + x^2 + 1
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
}

initGaloisTables();

function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Reed-Solomon generator polynomial of the given degree, highest term first. */
function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMultiply(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** The `ecLength` error correction codewords for one data block. */
function rsRemainder(data: Uint8Array, ecLength: number): Uint8Array {
  const generator = rsGeneratorPoly(ecLength);
  const remainder = new Uint8Array(ecLength);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[ecLength - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLength; j += 1) {
        remainder[j] ^= gfMultiply(generator[j + 1], factor);
      }
    }
  }
  return remainder;
}

/* -------------------------------------------------------------------------- */
/* Capacity and version selection                                              */
/* -------------------------------------------------------------------------- */

function blockSpec(version: number, ecLevel: QrEcLevel): readonly number[] {
  return EC_BLOCKS[ecLevel][version - 1];
}

function dataCodewordCount(version: number, ecLevel: QrEcLevel): number {
  const spec = blockSpec(version, ecLevel);
  return spec[1] * spec[2] + spec[3] * spec[4];
}

/** Byte-mode character count indicator width. */
function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function remainderBitCount(version: number): number {
  return version >= 2 && version <= 6 ? 7 : 0;
}

function fits(byteLength: number, version: number, ecLevel: QrEcLevel): boolean {
  const needed = 4 + charCountBits(version) + byteLength * 8;
  return needed <= dataCodewordCount(version, ecLevel) * 8;
}

function selectVersion(byteLength: number): { version: number; ecLevel: QrEcLevel } | null {
  const levels: readonly QrEcLevel[] = ['M', 'L'];
  for (const ecLevel of levels) {
    for (let version = MIN_VERSION; version <= MAX_VERSION; version += 1) {
      if (fits(byteLength, version, ecLevel)) return { version, ecLevel };
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Bit stream and final codeword sequence                                      */
/* -------------------------------------------------------------------------- */

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

/** Mode indicator, char count, payload, terminator and padding -> data codewords. */
function buildDataCodewords(payload: Uint8Array, version: number, ecLevel: QrEcLevel): Uint8Array {
  const capacity = dataCodewordCount(version, ecLevel);
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4); // byte mode
  appendBits(bits, payload.length, charCountBits(version));
  for (let i = 0; i < payload.length; i += 1) appendBits(bits, payload[i], 8);

  const capacityBits = capacity * 8;
  const terminator = Math.min(4, capacityBits - bits.length);
  for (let i = 0; i < terminator; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = new Uint8Array(capacity);
  for (let i = 0; i < bits.length; i += 1) {
    codewords[i >>> 3] |= bits[i] << (7 - (i & 7));
  }
  const padBytes = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < capacity; i += 1, p += 1) {
    codewords[i] = padBytes[p % 2];
  }
  return codewords;
}

/** Split into blocks, add Reed-Solomon, then interleave (ISO 7.6). */
function interleave(dataCodewords: Uint8Array, version: number, ecLevel: QrEcLevel): Uint8Array {
  const spec = blockSpec(version, ecLevel);
  const ecPerBlock = spec[0];
  const sizes: number[] = [];
  for (let i = 0; i < spec[1]; i += 1) sizes.push(spec[2]);
  for (let i = 0; i < spec[3]; i += 1) sizes.push(spec[4]);

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    const block = dataCodewords.subarray(offset, offset + size);
    offset += size;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, ecPerBlock));
  }

  const result = new Uint8Array(dataCodewords.length + ecPerBlock * sizes.length);
  let out = 0;
  const maxDataSize = Math.max(...sizes);
  for (let i = 0; i < maxDataSize; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) result[out++] = block[i];
    }
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of ecBlocks) result[out++] = block[i];
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Format and version information                                              */
/* -------------------------------------------------------------------------- */

/** BCH(15,5) with generator 0x537, masked with 0x5412 (ISO 7.9.1). */
function formatInfoBits(ecLevel: QrEcLevel, mask: number): number {
  const ecBits = ecLevel === 'L' ? 0b01 : 0b00;
  const data = (ecBits << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  return (((data << 10) | remainder) ^ 0x5412) & 0x7fff;
}

/** BCH(18,6) with generator 0x1f25 (ISO 7.10). */
function versionInfoBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }
  return ((version << 12) | remainder) & 0x3ffff;
}

/* -------------------------------------------------------------------------- */
/* Matrix construction                                                         */
/* -------------------------------------------------------------------------- */

function maskCondition(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

type Canvas = {
  size: number;
  /** 1 = dark. */
  modules: Uint8Array;
  /** 1 = function pattern or reserved info area; never touched by the mask. */
  reserved: Uint8Array;
};

function createCanvas(size: number): Canvas {
  return { size, modules: new Uint8Array(size * size), reserved: new Uint8Array(size * size) };
}

function setFunctionModule(canvas: Canvas, row: number, col: number, dark: boolean): void {
  if (row < 0 || col < 0 || row >= canvas.size || col >= canvas.size) return;
  const index = row * canvas.size + col;
  canvas.modules[index] = dark ? 1 : 0;
  canvas.reserved[index] = 1;
}

function drawFinderPattern(canvas: Canvas, centreRow: number, centreCol: number): void {
  // 7x7 finder plus its one-module separator: everything within Chebyshev radius 4.
  for (let dr = -4; dr <= 4; dr += 1) {
    for (let dc = -4; dc <= 4; dc += 1) {
      const distance = Math.max(Math.abs(dr), Math.abs(dc));
      setFunctionModule(canvas, centreRow + dr, centreCol + dc, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignmentPattern(canvas: Canvas, centreRow: number, centreCol: number): void {
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      setFunctionModule(canvas, centreRow + dr, centreCol + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  }
}

/**
 * Draw order matters where function patterns overlap: the format strip crosses
 * the timing pattern at (6, 8) and (8, 6), and those two modules belong to the
 * timing pattern, so the reservations are laid down first and overwritten.
 */
function drawFunctionPatterns(canvas: Canvas, version: number): void {
  const size = canvas.size;

  // Reserve (but do not yet write) the version information areas.
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(canvas, b, a, false);
      setFunctionModule(canvas, a, b, false);
    }
  }

  // Reserve (but do not yet write) the format information areas.
  for (let i = 0; i <= 8; i += 1) {
    setFunctionModule(canvas, i, 8, false);
    setFunctionModule(canvas, 8, i, false);
  }
  for (let i = 0; i < 8; i += 1) {
    setFunctionModule(canvas, size - 1 - i, 8, false);
    setFunctionModule(canvas, 8, size - 1 - i, false);
  }

  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    setFunctionModule(canvas, 6, i, dark);
    setFunctionModule(canvas, i, 6, dark);
  }

  drawFinderPattern(canvas, 3, 3);
  drawFinderPattern(canvas, 3, size - 4);
  drawFinderPattern(canvas, size - 4, 3);

  const centres = ALIGNMENT_CENTRES[version - 1];
  const last = centres.length - 1;
  for (let a = 0; a < centres.length; a += 1) {
    for (let b = 0; b < centres.length; b += 1) {
      const skipsFinder = (a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0);
      if (!skipsFinder) drawAlignmentPattern(canvas, centres[a], centres[b]);
    }
  }
}

/** Zigzag placement of the final bit stream, two columns at a time (ISO 7.7.3). */
function placeCodewords(canvas: Canvas, codewords: Uint8Array, remainderBits: number): void {
  const size = canvas.size;
  const totalBits = codewords.length * 8 + remainderBits;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vertical : vertical;
        const index = row * size + col;
        if (canvas.reserved[index] === 0 && bitIndex < totalBits) {
          const byte = bitIndex >>> 3;
          const bit = byte < codewords.length ? (codewords[byte] >>> (7 - (bitIndex & 7))) & 1 : 0;
          canvas.modules[index] = bit;
          bitIndex += 1;
        }
      }
    }
  }
}

function writeFormatInfo(canvas: Canvas, ecLevel: QrEcLevel, mask: number): void {
  const size = canvas.size;
  const bits = formatInfoBits(ecLevel, mask);
  const bitAt = (i: number): boolean => ((bits >>> i) & 1) === 1;

  for (let i = 0; i <= 5; i += 1) setFunctionModule(canvas, i, 8, bitAt(i));
  setFunctionModule(canvas, 7, 8, bitAt(6));
  setFunctionModule(canvas, 8, 8, bitAt(7));
  setFunctionModule(canvas, 8, 7, bitAt(8));
  for (let i = 9; i < 15; i += 1) setFunctionModule(canvas, 8, 14 - i, bitAt(i));

  for (let i = 0; i < 8; i += 1) setFunctionModule(canvas, 8, size - 1 - i, bitAt(i));
  for (let i = 8; i < 15; i += 1) setFunctionModule(canvas, size - 15 + i, 8, bitAt(i));

  setFunctionModule(canvas, size - 8, 8, true); // always dark
}

function writeVersionInfo(canvas: Canvas, version: number): void {
  if (version < 7) return;
  const size = canvas.size;
  const bits = versionInfoBits(version);
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunctionModule(canvas, b, a, dark);
    setFunctionModule(canvas, a, b, dark);
  }
}

/* -------------------------------------------------------------------------- */
/* Mask penalty scoring (ISO 7.8.3.1, Table 11)                                */
/* -------------------------------------------------------------------------- */

/** 1:1:3:1:1 (dark:light:dark:light:dark) with a four-module light area beside it. */
const N3_PATTERN_A: readonly number[] = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
const N3_PATTERN_B: readonly number[] = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

function matchesAt(sequence: Uint8Array, start: number, pattern: readonly number[]): boolean {
  for (let k = 0; k < pattern.length; k += 1) {
    if (sequence[start + k] !== pattern[k]) return false;
  }
  return true;
}

/**
 * The light area has to sit inside the symbol: an occurrence in the last ten
 * modules of a line has no room for it and scores nothing. Overlapping
 * occurrences are each counted.
 */
function scoreN3(sequence: Uint8Array): number {
  let score = 0;
  for (let start = 0; start + 11 <= sequence.length; start += 1) {
    if (matchesAt(sequence, start, N3_PATTERN_A) || matchesAt(sequence, start, N3_PATTERN_B)) {
      score += 40;
    }
  }
  return score;
}

function penaltyScore(modules: Uint8Array, size: number): number {
  let n1 = 0;
  let n2 = 0;
  let n3 = 0;
  let darkCount = 0;

  const row = new Uint8Array(size);
  const column = new Uint8Array(size);

  for (let i = 0; i < size; i += 1) {
    let rowPrev = -1;
    let colPrev = -1;
    let rowRun = 0;
    let colRun = 0;
    for (let j = 0; j < size; j += 1) {
      const rowBit = modules[i * size + j];
      const colBit = modules[j * size + i];
      row[j] = rowBit;
      column[j] = colBit;
      darkCount += rowBit;

      if (rowBit === rowPrev) rowRun += 1;
      else {
        if (rowRun >= 5) n1 += rowRun - 2;
        rowRun = 1;
      }
      if (colBit === colPrev) colRun += 1;
      else {
        if (colRun >= 5) n1 += colRun - 2;
        colRun = 1;
      }

      if (i > 0 && j > 0 && rowBit === rowPrev && rowBit === modules[(i - 1) * size + j] && rowBit === modules[(i - 1) * size + j - 1]) {
        n2 += 3;
      }
      rowPrev = rowBit;
      colPrev = colBit;
    }
    if (rowRun >= 5) n1 += rowRun - 2;
    if (colRun >= 5) n1 += colRun - 2;
    n3 += scoreN3(row);
    n3 += scoreN3(column);
  }

  const percent = darkCount / (size * size);
  const n4 = 10 * Math.floor(Math.abs(percent * 100 - 50) / 5);
  return n1 + n2 + n3 + n4;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Encodes `text` exactly as given — the payload is never trimmed, uppercased or
 * normalised, because a BR Code carries its own CRC16 and any rewrite breaks it.
 * Returns `null` for empty input or a payload too large for V13-L. Never throws.
 */
export function encodeQrCode(text: string): QrMatrix | null {
  if (typeof text !== 'string' || text.length === 0) return null;

  let payload: Uint8Array;
  try {
    payload = new TextEncoder().encode(text);
  } catch {
    return null;
  }
  if (payload.length === 0) return null;

  const selection = selectVersion(payload.length);
  if (selection === null) return null;
  const { version, ecLevel } = selection;

  try {
    const size = version * 4 + 17;
    const canvas = createCanvas(size);
    drawFunctionPatterns(canvas, version);

    const dataCodewords = buildDataCodewords(payload, version, ecLevel);
    const finalCodewords = interleave(dataCodewords, version, ecLevel);
    placeCodewords(canvas, finalCodewords, remainderBitCount(version));

    // Score every mask with the format and version areas still light, because
    // ISO 7.8 evaluates data masking before that information is written.
    let bestMask = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestModules = canvas.modules;
    for (let mask = 0; mask < 8; mask += 1) {
      const candidate = new Uint8Array(canvas.modules);
      for (let r = 0; r < size; r += 1) {
        for (let c = 0; c < size; c += 1) {
          const index = r * size + c;
          if (canvas.reserved[index] === 0 && maskCondition(mask, r, c)) {
            candidate[index] ^= 1;
          }
        }
      }
      const score = penaltyScore(candidate, size);
      if (score < bestScore) {
        bestScore = score;
        bestMask = mask;
        bestModules = candidate;
      }
    }

    canvas.modules = bestModules;
    writeFormatInfo(canvas, ecLevel, bestMask);
    writeVersionInfo(canvas, version);

    const modules: boolean[] = new Array<boolean>(size * size);
    for (let i = 0; i < modules.length; i += 1) modules[i] = canvas.modules[i] === 1;
    return { size, version, ecLevel, modules };
  } catch {
    return null;
  }
}

/**
 * SVG path `d` for the dark modules, one module per unit, offset by `quietZone`.
 * Horizontal runs are merged into a single subpath so the path stays small.
 */
export function toSvgPath(matrix: QrMatrix, quietZone: number): string {
  const offset = Number.isFinite(quietZone) ? Math.max(0, Math.trunc(quietZone)) : 0;
  const parts: string[] = [];
  const { size, modules } = matrix;
  for (let row = 0; row < size; row += 1) {
    let col = 0;
    while (col < size) {
      if (!modules[row * size + col]) {
        col += 1;
        continue;
      }
      let end = col;
      while (end < size && modules[row * size + end]) end += 1;
      const width = end - col;
      parts.push(`M${col + offset} ${row + offset}h${width}v1h-${width}z`);
      col = end;
    }
  }
  return parts.join('');
}

/**
 * A cheap shape check for an EMV "BR Code" (PIX) payload: the `000201` payload
 * format indicator, printable characters only, at most 512 bytes, and the
 * mandatory `6304` CRC16 tag at the very end.
 */
export function looksLikeBrCode(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (!value.startsWith('000201')) return false;
  if (value.length < 10) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  let byteLength: number;
  try {
    byteLength = new TextEncoder().encode(value).length;
  } catch {
    return false;
  }
  if (byteLength > 512) return false;
  return /6304[0-9A-Fa-f]{4}$/.test(value);
}
