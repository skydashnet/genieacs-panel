import 'dotenv/config';

/**
 * Como se entra no painel: por e-mail, e — enquanto durar a transição —
 * também pelo nome de usuário.
 *
 * A troca de `username` para e-mail é a última peça da Fase 2 do plano, e a
 * única que quebra contrato com quem já usa o produto: num install em produção,
 * um dia de virada em que o login passa a exigir e-mail tranca do lado de fora
 * todo operador que ainda não cadastrou o dele — inclusive quem cadastraria.
 *
 * Por isso a troca acontece em três passos, e este arquivo é o interruptor do
 * terceiro:
 *
 * 1. A coluna existe e é anulável; **toda conta nova nasce com e-mail**;
 *    quem já existe cadastra o seu em `POST /api/auth/email`. (feito)
 * 2. O login aceita os dois, com nome e e-mail num espaço de nomes só para que
 *    um identificador nunca case duas contas. (feito)
 * 3. `LOGIN_REQUIRES_EMAIL=true` desliga o login por nome. É uma linha de
 *    ambiente, e a decisão de quando virá-la é de quem opera o painel — não do
 *    código, que não sabe se todo mundo já cadastrou o endereço.
 *
 * O painel tem como responder se já dá para virar: `GET /api/users` mostra
 * quem ainda está sem e-mail. Virar a chave antes disso é trancar essa gente
 * do lado de fora, e o passo 3 não tem volta pela tela — só pelo ambiente.
 *
 * A chave é conferida em cada um dos três caminhos que emitem sessão — o
 * login, o aceite de convite por uma conta que já existe, e o refresh —
 * porque um interruptor que só um deles lê não é um interruptor.
 */
export const LOGIN_REQUIRES_EMAIL =
  String(process.env.LOGIN_REQUIRES_EMAIL || '').trim().toLowerCase() === 'true';

/**
 * Se esta conta pode ter sessão neste deployment.
 *
 * É a metade do passo 3 que não depende do que foi digitado: com a chave
 * virada, uma conta sem e-mail não entra por nada — e "por nada" tem de valer
 * nos TRÊS lugares que emitem sessão, não só no `/login`. Valia só lá: aceitar
 * um convite com nome e senha de uma conta herdada emitia sessão com a chave
 * ligada, e o refresh renovava por sete dias a sessão de quem a chave deveria
 * ter trancado. Quem vira a chave para forçar a migração não forçava ninguém.
 */
export function canHoldSession(user) {
  if (!user) return false;
  if (!LOGIN_REQUIRES_EMAIL) return true;
  return Boolean(String(user.email ?? '').trim());
}

/** Se um identificador de login serve neste deployment, para esta conta. */
export function acceptsIdentifier(identifier, user) {
  if (!canHoldSession(user)) return false;
  if (!LOGIN_REQUIRES_EMAIL) return true;
  // Com a chave virada, só o e-mail entra: o nome deixa de servir mesmo para
  // quem já cadastrou o endereço.
  const email = String(user.email ?? '').trim().toLowerCase();
  return String(identifier ?? '').trim().toLowerCase() === email;
}
