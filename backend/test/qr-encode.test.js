/**
 * Tests for the QR encoder that lives in the frontend tree.
 *
 * Why this test reaches across the frontend/backend boundary:
 * `frontend/src/lib/qr/encode.ts` is deliberately dependency-free and
 * import-free, so Node 22's type stripping can load the `.ts` file directly with
 * no build step, no bundler and no test runner of its own. The backend suite is
 * the only `node --test` runner in this repository, so the encoder is tested
 * from here rather than left untested. `backend/test/i18n.test.js` already
 * reads `frontend/src/lib/i18n/locales/*.ts` for the same reason.
 *
 * Why the golden vectors come from somewhere else: an encoder checked only
 * against its own output locks in its own bugs. `fixtures/qr-vectors.json` holds
 * full matrices produced by the Python `qrcode` package -- a mature, unrelated
 * implementation -- so a wrong generator polynomial, a wrong block split or a
 * wrong mask shows up as a full-matrix mismatch. The fixture's `oracleNote`
 * records why `segno` was rejected as the oracle.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeQrCode, looksLikeBrCode, toSvgPath } from '../../frontend/src/lib/qr/encode.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'qr-vectors.json'), 'utf8'));

/** Alignment pattern centres per version, transcribed from ISO/IEC 18004 Annex E. */
const ALIGNMENT_CENTRES = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62]
];

/** One byte length per version 1..13 that lands squarely inside that version. */
const LENGTH_PER_VERSION = [10, 20, 40, 60, 80, 100, 115, 140, 175, 200, 240, 280, 320];

function at(matrix, row, col) {
  return matrix.modules[row * matrix.size + col];
}

function rowsOf(matrix) {
  const rows = [];
  for (let row = 0; row < matrix.size; row += 1) {
    let line = '';
    for (let col = 0; col < matrix.size; col += 1) line += at(matrix, row, col) ? '1' : '0';
    rows.push(line);
  }
  return rows;
}

/** BCH(18,6) version information, recomputed here so the test does not trust the encoder. */
function versionInfoBits(version) {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }
  return ((version << 12) | remainder) & 0x3ffff;
}

function encodeOrFail(text, label) {
  const matrix = encodeQrCode(text);
  assert.ok(matrix, `encodeQrCode returned null for ${label}`);
  return matrix;
}

describe('golden vectors from an independent encoder', () => {
  it('has a fixture that exercises the cases the encoder is used for', () => {
    assert.ok(fixture.vectors.length >= 4);
    assert.ok(fixture.vectors.some((v) => v.version >= 7), 'no version with version-info blocks');
    assert.ok(fixture.vectors.some((v) => v.version < 7), 'no version without version-info blocks');
    assert.ok(fixture.vectors.some((v) => v.byteLength > v.text.length), 'no multi-byte payload');
    assert.ok(fixture.vectors.some((v) => v.ecLevel === 'L'), 'no L-level fallback');
  });

  for (const vector of fixture.vectors) {
    it(`reproduces ${vector.name} (${vector.byteLength} bytes -> V${vector.version}-${vector.ecLevel})`, () => {
      const matrix = encodeOrFail(vector.text, vector.name);
      assert.equal(matrix.version, vector.version);
      assert.equal(matrix.ecLevel, vector.ecLevel);
      assert.equal(matrix.size, vector.size);
      assert.equal(vector.rows.length, vector.size);
      assert.deepEqual(rowsOf(matrix), vector.rows);
    });
  }
});

describe('structural invariants', () => {
  const matrices = LENGTH_PER_VERSION.map((length, index) => {
    const matrix = encodeOrFail('A'.repeat(length), `${length} bytes`);
    assert.equal(matrix.version, index + 1, `${length} bytes should select version ${index + 1}`);
    return matrix;
  });

  for (const matrix of matrices) {
    const { version, size } = matrix;

    describe(`version ${version}`, () => {
      it('is 4 * version + 17 modules wide', () => {
        assert.equal(size, 4 * version + 17);
        assert.equal(matrix.modules.length, size * size);
        assert.ok(matrix.modules.every((m) => typeof m === 'boolean'));
      });

      it('has three finder patterns, each with its separator', () => {
        const corners = [[0, 0], [0, size - 7], [size - 7, 0]];
        for (const [top, left] of corners) {
          for (let dr = -1; dr <= 7; dr += 1) {
            for (let dc = -1; dc <= 7; dc += 1) {
              const row = top + dr;
              const col = left + dc;
              if (row < 0 || col < 0 || row >= size || col >= size) continue;
              // Chebyshev distance from the 7x7 centre: 0,1,3 dark; 2 light; 4 separator.
              const distance = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
              const expected = distance !== 2 && distance !== 4;
              assert.equal(at(matrix, row, col), expected, `finder at (${row},${col})`);
            }
          }
        }
        // A fourth finder in the bottom-right corner would be a placement bug.
        let bottomRightIsFinder = true;
        for (let dr = 0; dr < 7 && bottomRightIsFinder; dr += 1) {
          for (let dc = 0; dc < 7; dc += 1) {
            const distance = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
            if (at(matrix, size - 7 + dr, size - 7 + dc) !== (distance !== 2)) {
              bottomRightIsFinder = false;
              break;
            }
          }
        }
        assert.equal(bottomRightIsFinder, false, 'found a fourth finder pattern');
      });

      it('has alternating timing patterns on row 6 and column 6', () => {
        for (let i = 8; i < size - 8; i += 1) {
          assert.equal(at(matrix, 6, i), i % 2 === 0, `horizontal timing at column ${i}`);
          assert.equal(at(matrix, i, 6), i % 2 === 0, `vertical timing at row ${i}`);
        }
      });

      it('has the always-dark module at (4 * version + 9, 8)', () => {
        assert.equal(at(matrix, 4 * version + 9, 8), true);
        assert.equal(4 * version + 9, size - 8);
      });

      it('writes the same format information in both copies', () => {
        const copyA = [];
        for (let i = 0; i <= 5; i += 1) copyA.push(at(matrix, i, 8));
        copyA.push(at(matrix, 7, 8));
        copyA.push(at(matrix, 8, 8));
        copyA.push(at(matrix, 8, 7));
        for (let i = 9; i < 15; i += 1) copyA.push(at(matrix, 8, 14 - i));

        const copyB = [];
        for (let i = 0; i < 8; i += 1) copyB.push(at(matrix, 8, size - 1 - i));
        for (let i = 8; i < 15; i += 1) copyB.push(at(matrix, size - 15 + i, 8));

        assert.equal(copyA.length, 15);
        assert.deepEqual(copyA, copyB);
        // The format bits are masked with 0x5412, so they are never all light.
        assert.ok(copyA.some((bit) => bit));
      });

      it(`${version >= 7 ? 'carries' : 'omits'} the version information blocks`, () => {
        const expected = [];
        const topRight = [];
        const bottomLeft = [];
        const bits = versionInfoBits(version);
        for (let i = 0; i < 18; i += 1) {
          expected.push(((bits >>> i) & 1) === 1);
          const a = size - 11 + (i % 3);
          const b = Math.floor(i / 3);
          topRight.push(at(matrix, b, a));
          bottomLeft.push(at(matrix, a, b));
        }
        if (version >= 7) {
          assert.deepEqual(topRight, expected);
          assert.deepEqual(bottomLeft, expected);
        } else {
          const written = (
            JSON.stringify(topRight) === JSON.stringify(expected)
            && JSON.stringify(bottomLeft) === JSON.stringify(expected)
          );
          assert.equal(written, false, 'version blocks must not be written below version 7');
        }
      });

      it('has an alignment pattern at every centre that is not under a finder', () => {
        const centres = ALIGNMENT_CENTRES[version - 1];
        assert.equal(centres.length === 0, version === 1);
        const last = centres.length - 1;
        let drawn = 0;
        for (let a = 0; a < centres.length; a += 1) {
          for (let b = 0; b < centres.length; b += 1) {
            const underFinder = (a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0);
            if (underFinder) continue;
            drawn += 1;
            for (let dr = -2; dr <= 2; dr += 1) {
              for (let dc = -2; dc <= 2; dc += 1) {
                const expected = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
                assert.equal(
                  at(matrix, centres[a] + dr, centres[b] + dc),
                  expected,
                  `alignment (${centres[a]},${centres[b]}) offset (${dr},${dc})`
                );
              }
            }
          }
        }
        const expectedCount = centres.length === 0 ? 0 : centres.length * centres.length - 3;
        assert.equal(drawn, expectedCount);
      });
    });
  }
});

describe('capacity and version selection', () => {
  it('fits 331 bytes at V13-M', () => {
    const matrix = encodeOrFail('M'.repeat(331), '331 bytes');
    assert.equal(matrix.version, 13);
    assert.equal(matrix.ecLevel, 'M');
  });

  it('falls back to level L at 332 bytes', () => {
    const matrix = encodeOrFail('M'.repeat(332), '332 bytes');
    assert.equal(matrix.ecLevel, 'L');
    assert.ok(matrix.version <= 13);
  });

  it('fits 425 bytes at V13-L', () => {
    const matrix = encodeOrFail('L'.repeat(425), '425 bytes');
    assert.equal(matrix.version, 13);
    assert.equal(matrix.ecLevel, 'L');
  });

  it('returns null at 426 bytes', () => {
    assert.equal(encodeQrCode('L'.repeat(426)), null);
  });

  it('returns null for empty input', () => {
    assert.equal(encodeQrCode(''), null);
  });

  it('counts UTF-8 bytes, not characters, against the capacity', () => {
    // 213 two-byte characters is 426 bytes even though the string is short.
    assert.equal(encodeQrCode('á'.repeat(213)), null);
    const matrix = encodeOrFail('á'.repeat(212), '424 bytes of accents');
    assert.equal(matrix.ecLevel, 'L');
  });

  it('never throws on hostile input', () => {
    const nasty = [' ', '\uD800', '\uDC00 lone surrogate', '\n\t\r', '💥'.repeat(100)];
    for (const value of nasty) {
      assert.doesNotThrow(() => encodeQrCode(value), `threw on ${JSON.stringify(value)}`);
    }
  });
});

describe('purity', () => {
  const payload = fixture.vectors.find((v) => v.name.startsWith('static-br-code')).text;

  it('produces an identical matrix for the same input twice', () => {
    const first = encodeOrFail(payload, 'BR Code');
    const second = encodeOrFail(payload, 'BR Code');
    assert.notEqual(first, second, 'must not hand back a shared instance');
    assert.deepEqual(first, second);
  });

  it('leaves the input string untouched', () => {
    const original = `${payload}`;
    encodeQrCode(payload);
    assert.equal(payload, original);
    assert.equal(payload.length, original.length);
  });

  it('does not trim, uppercase or normalise the payload', () => {
    // A BR Code ends in 6304 + a CRC16 over everything before it, so any rewrite
    // of the payload produces a code that scans but fails at the bank.
    const base = encodeOrFail(payload, 'BR Code');
    const padded = encodeOrFail(` ${payload} `, 'padded BR Code');
    const lowered = encodeOrFail(payload.toLowerCase(), 'lowercased BR Code');
    assert.notDeepEqual(rowsOf(padded), rowsOf(base), 'outer whitespace was trimmed away');
    assert.notDeepEqual(rowsOf(lowered), rowsOf(base), 'payload case was normalised');

    const accented = fixture.vectors.find((v) => v.name === 'accented-utf8').text;
    const decomposed = accented.normalize('NFD');
    assert.notEqual(decomposed, accented, 'fixture should not already be decomposed');
    assert.notDeepEqual(
      rowsOf(encodeOrFail(decomposed, 'NFD payload')),
      rowsOf(encodeOrFail(accented, 'NFC payload')),
      'payload was Unicode-normalised'
    );
  });
});

describe('toSvgPath', () => {
  const matrix = encodeOrFail(fixture.vectors[1].text, 'BR Code');

  function parse(d) {
    const dark = new Set();
    const subpath = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g;
    let consumed = 0;
    let match = subpath.exec(d);
    while (match !== null) {
      consumed += match[0].length;
      const [x, y, width, back] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
      assert.equal(width, back, 'horizontal run does not close on itself');
      assert.ok(width > 0);
      for (let i = 0; i < width; i += 1) dark.add(`${y},${x + i}`);
      match = subpath.exec(d);
    }
    assert.equal(consumed, d.length, 'path contains something other than module runs');
    return dark;
  }

  it('draws exactly the dark modules', () => {
    const dark = parse(toSvgPath(matrix, 0));
    const expected = new Set();
    for (let row = 0; row < matrix.size; row += 1) {
      for (let col = 0; col < matrix.size; col += 1) {
        if (at(matrix, row, col)) expected.add(`${row},${col}`);
      }
    }
    assert.equal(dark.size, expected.size);
    assert.deepEqual([...dark].sort(), [...expected].sort());
  });

  it('merges horizontal runs instead of emitting one subpath per module', () => {
    const subpaths = toSvgPath(matrix, 0).match(/M/g).length;
    let darkCount = 0;
    for (const module of matrix.modules) if (module) darkCount += 1;
    assert.ok(subpaths < darkCount, `${subpaths} subpaths for ${darkCount} dark modules`);
  });

  it('offsets every module by the quiet zone', () => {
    const quiet = 4;
    const shifted = parse(toSvgPath(matrix, quiet));
    const base = parse(toSvgPath(matrix, 0));
    const expected = new Set([...base].map((key) => {
      const [row, col] = key.split(',').map(Number);
      return `${row + quiet},${col + quiet}`;
    }));
    assert.deepEqual([...shifted].sort(), [...expected].sort());
    for (const key of shifted) {
      const [row, col] = key.split(',').map(Number);
      assert.ok(row >= quiet && col >= quiet, `module ${key} is inside the quiet zone`);
    }
  });

  it('never emits NaN, even for a nonsense quiet zone', () => {
    for (const quiet of [0, 1, 4, -3, 2.7, Number.NaN, Number.POSITIVE_INFINITY]) {
      const d = toSvgPath(matrix, quiet);
      assert.ok(d.length > 0);
      assert.ok(!/NaN|Infinity|undefined/.test(d), `bad coordinate for quiet zone ${quiet}`);
    }
  });

  it('returns an empty path when there is nothing to draw', () => {
    assert.equal(toSvgPath({ size: 2, version: 1, ecLevel: 'M', modules: [false, false, false, false] }, 4), '');
  });
});

describe('looksLikeBrCode', () => {
  const brCode = fixture.vectors.find((v) => v.name.startsWith('static-br-code')).text;

  it('accepts a real BR Code', () => {
    assert.equal(looksLikeBrCode(brCode), true);
    assert.equal(looksLikeBrCode(fixture.vectors.find((v) => v.name.startsWith('dynamic-br-code')).text), true);
  });

  it('rejects a URL', () => {
    assert.equal(looksLikeBrCode('https://example.com/pay/abc123'), false);
  });

  it('rejects empty input', () => {
    assert.equal(looksLikeBrCode(''), false);
  });

  it('rejects a 600-byte blob', () => {
    const blob = `000201${'A'.repeat(586)}6304ABCD`;
    assert.equal(blob.length, 600);
    assert.equal(looksLikeBrCode(blob), false);
  });

  it('rejects payloads missing the trailing CRC16 tag', () => {
    assert.equal(looksLikeBrCode(brCode.slice(0, -1)), false);
    assert.equal(looksLikeBrCode(`${brCode.slice(0, -4)}ZZZZ`), false);
    assert.equal(looksLikeBrCode(brCode.slice(2)), false);
  });

  it('rejects payloads containing control characters', () => {
    assert.equal(looksLikeBrCode(`000201\n${brCode.slice(6)}`), false);
  });
});
