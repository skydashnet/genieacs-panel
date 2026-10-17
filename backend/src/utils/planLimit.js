import { createErrorResponse } from './helpers.js';

/**
 * A resposta de "não cabe no plano", igual em todo ponto de escrita.
 *
 * 402 e não 403: quem pergunta TEM permissão — é o plano que não comporta. O
 * frontend distingue os dois pelo status e pelo `code`, e a mensagem diz o
 * número, porque "limite atingido" sem o número manda a pessoa contar na mão.
 */
export function planLimitResponse(req, res, error) {
  const key = error.resource === 'operators'
    ? 'subscription.limitOperators'
    : 'subscription.limitSubscribers';
  const message = req.t
    ? req.t(key, { limit: error.limit, current: error.current })
    : error.message;
  return res.status(402).json({
    ...createErrorResponse(message),
    code: error.code,
    limit: error.limit,
    current: error.current
  });
}
