import { WaError } from './whatsappConfigService.js';

/**
 * Sorting a failed send into "try again" and "never".
 *
 * Burning the retry window is right for a server that is down and wrong for a
 * number that does not exist: the first costs a message a few minutes, the
 * second keeps a row in the queue for the best part of an hour to reach a phone
 * that will never answer.
 *
 * WHEN IN DOUBT, TRANSIENT. Erring that way costs a message that goes out late;
 * erring the other way is a dunning notice that never arrives and nobody
 * notices, because a `failed` row is visible only inside its own thread. So
 * everything below is a list of the failures that can be NAMED as permanent,
 * and anything unrecognised falls through to a retry.
 *
 * ── Why the server's words are read as one string ──────────────────────
 *
 * "Evolution" is two servers that agree about very little. A refused send comes
 * back from v2 as a nested `{status, error, response: {message: [...]}}` and
 * from Evolution GO as a flat `{"error": "..."}`. `evolutionClient.sendOrThrow`
 * has already flattened whichever arrived into `translationVars.body` with
 * `JSON.stringify`, so one regex over that text reads both — which is what
 * `evolutionInstanceService` does with ALREADY_EXISTS, QR_PENDING and
 * NO_SESSION rather than keeping two parsers of two shapes in step.
 */

/**
 * Failures that are about this message rather than about the server.
 *
 * `no_destination` is the invalid number: the thread carries neither a phone
 * nor a LID, so every attempt would compose the same request to nowhere.
 *
 * It is deliberately the only one. `no_account` (no number connected) and
 * `no_public_url` (nothing has told the panel its own address) look permanent
 * and are not — a number reconnects, a setting gets filled in, and the message
 * itself was sendable the whole time. `unauthorized` and `license_required` are
 * the same story with a different fix.
 */
const PERMANENT_CODES = new Set(['no_destination', 'meta_window_closed']);

/**
 * Recusas da Meta (API oficial) que não mudam com o tempo, pelo código numérico
 * que o servidor repassa no corpo:
 *
 *   131047  fora da janela de 24 h — só modelo aprovado passa
 *   131026  o destino não pode receber (não tem WhatsApp, versão antiga…)
 *   131051  tipo de mensagem não suportado
 *   131049  a Meta escolheu não entregar (limite de marketing por pessoa)
 *   132000  quantidade de parâmetros não bate com o modelo
 *   132001  o modelo não existe naquele idioma
 *   132005  texto do modelo grande demais depois de preenchido
 *   132007  o modelo viola política
 *   132012  formato de parâmetro errado
 *   132015/132016  modelo pausado ou desativado
 *
 * Ficam DE FORA, e caem na nova tentativa: 190 (token vencido — conserta-se
 * trocando o token, como `unauthorized`) e 130429/131056 (limite de vazão).
 */
const META_PERMANENT = /"code"\s*:\s*(?:131047|131026|131051|131049|132000|132001|132005|132007|132012|132015|132016)\b/;

/**
 * The server saying this recipient is not a WhatsApp user.
 *
 * Written as narrow alternatives rather than "not ... whatsapp", because that
 * shape also matches "could not reach WhatsApp", which is the opposite verdict.
 */
const NOT_A_RECIPIENT = new RegExp([
  'not (?:on|in|an?|registered)\\b[^"]{0,20}whats\\s?app',
  'whats\\s?app[^"]{0,20}(?:number|user)[^"]{0,16}(?:not|invalid)',
  // The number check's own answer, when a send route echoes it.
  'exists["\'\\s:]{1,4}false',
  'invalid[^"]{0,12}(?:number|jid|phone|recipient)',
  '(?:number|jid|phone|recipient)[^"]{0,12}(?:is )?invalid'
].join('|'), 'i');

/** The server refusing what is being sent, rather than who it is being sent to. */
const CONTENT_REFUSED = new RegExp([
  '(?:content|message|media|file|payload)[^"]{0,20}(?:refus|reject|not allowed|unsupported|too large)',
  '(?:unsupported|invalid)[^"]{0,12}(?:media|mime\\s?type|mime|file\\s?type|format)',
  'file[^"]{0,12}too (?:large|big)'
].join('|'), 'i');

/**
 * Words that settle the doubt in favour of another attempt.
 *
 * Checked BEFORE the two lists above and able to overrule them, because the
 * expensive mistake lives exactly here: "temporarily blocked" and "too many
 * requests" both read as a refusal to a regex looking for one, and both clear
 * on their own within the window. A session that is disconnected is named here
 * for the same reason — it is the state a reconnect ends.
 */
const LOOKS_TEMPORARY = new RegExp([
  'temporar', 'rate.?limit', 'too many', 'try again', 'retry',
  'time[d ]?out', 'unavailable', 'overload', 'reconnect',
  'not connected', 'disconnect', 'no session', 'not logged in'
].join('|'), 'i');

/**
 * Whether this failure will still be a failure in half an hour.
 *
 * @param {unknown} error whatever `waSendService.dispatch` threw
 * @returns {boolean} true only for a failure that can be named permanent
 */
export function isPermanentFailure(error) {
  // A plain Error here is a bug in the panel, not a verdict about the number.
  if (!(error instanceof WaError)) return false;
  if (PERMANENT_CODES.has(error.code)) return true;
  // Every other code is a transport or configuration condition that clears.
  if (error.code !== 'http_error') return false;

  const vars = error.translationVars || {};
  const status = Number(vars.status || 0);
  // A 5xx is the server having a bad minute, and 408 and 429 say so in
  // writing. None of the three is an opinion about the message, so the body is
  // not even read: a proxy's HTML error page must not be pattern-matched into
  // a permanent verdict.
  if (status >= 500 || status === 408 || status === 429) return false;

  const words = String(vars.body ?? '');
  // Antes do LOOKS_TEMPORARY: a mensagem da Meta para o 131047 diz "try again"
  // depois que o cliente responder — e isso não é uma nova tentativa da fila.
  if (META_PERMANENT.test(words)) return true;
  if (LOOKS_TEMPORARY.test(words)) return false;
  return NOT_A_RECIPIENT.test(words) || CONTENT_REFUSED.test(words);
}

export default isPermanentFailure;
