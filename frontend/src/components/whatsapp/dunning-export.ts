/**
 * O histórico da régua como planilha: BOM, `;` e CRLF, como o Excel em
 * português abre — o mesmo formato das planilhas do backend (`utils/csv.js`).
 * Uma célula que a planilha leria como fórmula sai com apóstrofo na frente:
 * o nome do assinante vem do ERP.
 */
const NUMBER = /^-?\d+(?:[.,]\d+)?$/

export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text) && !NUMBER.test(text)) text = `'${text}`
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function sheetCsv(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const lines = [header, ...rows].map((line) => line.map(csvCell).join(';'))
  return `\uFEFF${lines.join('\r\n')}\r\n`
}
