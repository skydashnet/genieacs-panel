/**
 * A planilha como o Excel em português abre: BOM, `;`, CRLF.
 *
 * Um só lugar para as duas planilhas do painel (contatos e equipamentos),
 * porque a regra que importa aqui é de segurança e não de formato: uma célula
 * que a planilha leria como fórmula sai com um apóstrofo na frente. Um nome
 * como `=HYPERLINK(...)` digitado no ERP, ou um PPPoE começando com `@`, não
 * pode virar fórmula viva na máquina de quem abriu o arquivo.
 */
const NUMERO = /^-?\d+(?:[.,]\d+)?$/;

export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // Um número puro — `-27`, `-19,8` — não é fórmula, e o apóstrofo o tornaria
  // texto com o apóstrofo à vista: o RX de toda ONT começa com `-`.
  if (/^[=+\-@\t\r]/.test(text) && !NUMERO.test(text)) text = `'${text}`;
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * @param {Array<{ header: string, field: string }>} columns
 * @param {Array<Record<string, unknown>>} rows
 */
export function toCsvWith(columns, rows) {
  const lines = [columns.map((column) => csvCell(column.header)).join(';')];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column.field])).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}
