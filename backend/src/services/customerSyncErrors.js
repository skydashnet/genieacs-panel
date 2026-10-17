import { EGRESS_REFUSED } from './genieacsEgress.js';

/**
 * Por que a sincronização de IDs de cliente falhou, numa forma que se pode
 * mostrar ao operador.
 *
 * `createErrorResponse` só anexa o texto do erro em desenvolvimento — e com
 * razão, porque um erro cru pode carregar URL, host ou mensagem de driver.
 * Em produção o operador ficava com "não foi possível sincronizar" e nenhum
 * caminho. Aqui o erro vira um código e uma frase traduzível que dizem ONDE
 * olhar (o ACS não respondeu, recusou a credencial, não está configurado…),
 * sem nunca repetir o que veio de fora.
 */
export function classifySyncError(error) {
  const message = String(error?.message || '');
  const causeCode = String(error?.cause?.code || error?.code || '');

  if (error?.translationKey === 'settings.customerIdAllocationFailed') {
    return { code: 'allocation_failed', reasonKey: 'settings.customerIdAllocationFailed' };
  }
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || /aborted|timed? ?out/i.test(message)) {
    return { code: 'genieacs_timeout', reasonKey: 'settings.customerIdSync.timeout' };
  }
  if (/GenieACS URL not configured/i.test(message)) {
    return { code: 'genieacs_not_configured', reasonKey: 'settings.customerIdSync.notConfigured' };
  }
  const status = message.match(/GenieACS API (?:responded with |answered with a redirect \()status: (\d{3})/i);
  if (status) {
    const code = Number(status[1]);
    return {
      code: 'genieacs_http',
      status: code,
      reasonKey: code === 401 || code === 403
        ? 'settings.customerIdSync.unauthorized'
        : 'settings.customerIdSync.http'
    };
  }
  if (causeCode === EGRESS_REFUSED || /did not resolve|ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|fetch failed/i.test(`${message} ${causeCode}`)) {
    return { code: 'genieacs_unreachable', reasonKey: 'settings.customerIdSync.unreachable' };
  }
  if (/Invalid GenieACS customer identity response|JSON/i.test(message)) {
    return { code: 'genieacs_bad_response', reasonKey: 'settings.customerIdSync.badResponse' };
  }
  return { code: 'database', reasonKey: 'settings.customerIdSyncFailed' };
}

export default { classifySyncError };
