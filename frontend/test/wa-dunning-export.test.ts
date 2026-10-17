import { describe, expect, it } from 'vitest'
import { csvCell, sheetCsv } from '@/components/whatsapp/dunning-export'

describe('dunning export', () => {
  it('escapes separators, quotes and formulas', () => {
    expect(csvCell('a;b')).toBe('"a;b"')
    expect(csvCell('diz "oi"')).toBe('"diz ""oi"""')
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('-27')).toBe('-27')
    expect(csvCell(null)).toBe('')
  })

  it('writes BOM, semicolons and CRLF', () => {
    const csv = sheetCsv(['A', 'B'], [['1', 'x'], ['2', null]])
    expect(csv).toBe('﻿A;B\r\n1;x\r\n2;\r\n')
  })
})
