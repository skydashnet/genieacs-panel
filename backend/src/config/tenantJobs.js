import { getDb } from './database.js';
import { runInTenant, TenantScopeError } from './tenantContext.js';

/**
 * Runs background work once, as the installation's only provider.
 *
 * Work driven by a timer has no request and therefore no provider, but every
 * query underneath it now demands one. This opens that scope.
 *
 * It runs the job ONCE, not once per provider, and the difference is the whole
 * point. These jobs are driven by a query that is not yet scoped —
 * `WaMessage.listSendable()` reads every sendable message on the deployment,
 * `WaBroadcast.listByStatus()` every running campaign. Running that once per
 * provider would not divide the work between them, it would repeat it: the
 * same message sent as many times as there are providers, to a real
 * subscriber's phone.
 *
 * So it refuses the moment a second provider exists. That is deliberate and it
 * is the safer of the two failures: a queue that stops is noticed and fixed,
 * a queue that sends everything twice is noticed by the customer. The refusal
 * names the job, and the fix is always the same — scope the driving query and
 * move the job to a per-provider loop.
 *
 * @param {string} reason What the job is, for the error a second provider triggers.
 */
export async function forSoleTenant(reason, fn) {
  const tenants = await getDb()('tenants')
    .where({ status: 'active' })
    .orderBy('id', 'asc')
    .limit(2);

  if (tenants.length === 0) return null;
  if (tenants.length > 1) {
    throw new TenantScopeError(
      `${reason} still reads across every provider, so running it once per provider `
      + 'would repeat the work rather than divide it. Scope its driving query before '
      + 'a second provider goes live.'
    );
  }

  return runInTenant(tenants[0].id, fn);
}

/**
 * Runs background work once per active provider, each inside its own scope.
 *
 * The counterpart to `forSoleTenant`, and the one to reach for whenever the
 * job's own query is already scoped — then a per-provider loop genuinely
 * divides the work instead of repeating it. The portal-password backfill is
 * the first: it reads only the accounts of the provider in scope, so running
 * it per provider backfills each provider's own and nobody else's.
 *
 * One provider failing does not stop the others: a broken integration at one
 * ISP must not silently halt the job for every other ISP on the deployment.
 *
 * `only` restringe a visita a esses ids, e o filtro de ativo continua valendo
 * sobre eles: quem chama sabe quem tem trabalho, e esta função continua sendo
 * quem sabe quem está trabalhando. Lista vazia é "ninguém", sem ir ao banco.
 */
export async function forEachTenant(job, { onError, only = null } = {}) {
  if (only && only.length === 0) return [];
  const query = getDb()('tenants').where({ status: 'active' }).orderBy('id', 'asc');
  if (only) query.whereIn('id', only);
  const tenants = await query;
  const results = [];
  for (const tenant of tenants) {
    try {
      results.push(await runInTenant(tenant.id, () => job(tenant)));
    } catch (error) {
      if (onError) onError(error, tenant);
      else console.warn(`Background job failed for provider ${tenant.slug}: ${error.message}`);
    }
  }
  return results;
}

/**
 * O mesmo laço, mas visitando TODO provedor — inclusive o suspenso.
 *
 * Existe para uma pergunta só, e é uma pergunta diferente da que `forEachTenant`
 * responde. Aquele pergunta "quem está trabalhando?", e `active` é a resposta
 * certa: o suspenso não deve ter mensagem enviada, alerta disparado nem ERP
 * reconciliado. Este pergunta **"de quem eu ainda guardo dado?"** — e aí o
 * status não decide nada. Um provedor suspenso continua sendo o titular de CPF,
 * contrato, PPPoE e conversa inteira de assinante.
 *
 * O que havia antes era pior do que parece: `forEachTenant` roda a retenção, e
 * a retenção é o que dá PRAZO ao dado. Sem visita, o suspenso não ficava
 * "congelado" — ficava guardando para sempre, inclusive a trilha, que num
 * provedor ativo tem prazo de um ano. E não existe prazo de suspensão nem
 * exclusão automática, então "para sempre" é literal.
 *
 * O precedente já estava no repositório, a uma função de distância:
 * `waMediaSweeper.soleProvider()` conta provedores **de todo status**, de
 * propósito, porque a pergunta dele também é de existência e não de atividade.
 *
 * Uma coisa fica dita: a exclusão em duas etapas trata a suspensão como
 * "ninguém está trabalhando lá dentro" (`platformController`), e uma poda é,
 * por definição, trabalho acontecendo lá dentro. A premissa continua valendo
 * para o que importa a ela — nenhuma sessão, nenhum envio, nenhuma escrita
 * vinda de fora —, mas deixou de ser literal, e quem mexer naquele caminho
 * precisa saber disto.
 */
export async function forEveryTenant(job, { onError } = {}) {
  const tenants = await getDb()('tenants').orderBy('id', 'asc');
  const results = [];
  for (const tenant of tenants) {
    try {
      results.push(await runInTenant(tenant.id, () => job(tenant)));
    } catch (error) {
      if (onError) onError(error, tenant);
      else console.warn(`Retention pass failed for provider ${tenant.slug}: ${error.message}`);
    }
  }
  return results;
}
