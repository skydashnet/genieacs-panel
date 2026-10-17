import Setting from '../models/Setting.js';

/**
 * Como o painel escreve uma data: escolha do provedor, em Configurações.
 *
 * `auto` segue o idioma de quem olha (o que o painel sempre fez). Os outros
 * fixam a ordem — um provedor brasileiro com a equipe usando o painel em
 * inglês continua vendo dia/mês/ano. A lista é fechada: a tela formata a
 * partir dela, e um valor fora dela não teria como ser desenhado.
 */
export const DATE_FORMATS = Object.freeze([
  'auto',
  'dd/MM/yyyy',
  'MM/dd/yyyy',
  'yyyy-MM-dd',
  'dd-MM-yyyy',
  'dd.MM.yyyy'
]);

export const DEFAULT_DATE_FORMAT = 'auto';

export function isDateFormat(value) {
  return DATE_FORMATS.includes(String(value));
}

/** O formato do provedor atual; `auto` quando não há nada salvo (ou algo inválido). */
export async function readDateFormat() {
  const saved = await Setting.getByKey('dateFormat');
  return isDateFormat(saved) ? saved : DEFAULT_DATE_FORMAT;
}
