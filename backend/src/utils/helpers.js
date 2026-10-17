export function createResponse(message, data = null, code = null) {
  const response = {
    success: true,
    message
  };
  if (code) {
    response.code = code;
  }
  if (data !== null) {
    response.data = data;
  }
  return response;
}

/**
 * Internal error text is attached only when the deployment explicitly asks for
 * it. APP_ENV defaults to 'development', so testing for "not production" would
 * leak stack messages from every deployment that never sets the variable.
 */
export function createErrorResponse(message, error = null, code = null) {
  const response = {
    success: false,
    message
  };
  if (code) {
    response.code = code;
  }
  if (error && process.env.APP_ENV === 'development') {
    response.error = error;
  }
  return response;
}

/**
 * Milliseconds from a timestamp, whichever shape the driver returned.
 *
 * `pg` and `mysql2` hand back a `Date`; `better-sqlite3` hands back an integer
 * or a string. Every comparison against a stored timestamp goes through here
 * so the three do not have to be remembered at each call site.
 */
export function timestampMs(value) {
  if (value === null || value === undefined) return Number.NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Date.parse(String(value));
}

/**
 * Se um texto pode ser um endereço de e-mail.
 *
 * Deliberadamente frouxa, e vale dizer por quê: validar e-mail por expressão
 * regular é um problema conhecido por não ter solução — a gramática da RFC 5322
 * aceita coisas que nenhum provedor emite, e toda regex "completa" que circula
 * por aí recusa endereços válidos de gente real. O único teste que decide de
 * verdade é mandar uma mensagem e ver se chega, e este painel não manda e-mail.
 *
 * Então o que se checa aqui é o que pega erro de digitação sem recusar ninguém:
 * exatamente um `@`, algo dos dois lados, um ponto no domínio, e sem espaço. O
 * resto é problema de quem digitou o próprio endereço.
 */
export function isValidEmail(value) {
  const texto = String(value ?? '').trim();
  if (texto.length < 6 || texto.length > 255) return false;
  if (/\s/.test(texto)) return false;
  const partes = texto.split('@');
  if (partes.length !== 2) return false;
  const [local, dominio] = partes;
  if (!local.length || !dominio.length) return false;
  if (!dominio.includes('.')) return false;
  if (dominio.startsWith('.') || dominio.endsWith('.') || dominio.includes('..')) return false;
  return true;
}
