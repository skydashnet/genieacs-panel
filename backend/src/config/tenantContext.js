import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which provider the work in flight belongs to.
 *
 * Every request resolves its provider once, and everything underneath reads it
 * from here rather than passing it down through call after call. Background
 * work has no request, so it has to open the context itself — once per
 * provider — before touching anything scoped.
 *
 * `currentTenantId()` throws when there is no context instead of falling back
 * to a default. That is the whole design: a query that forgot its provider
 * fails loudly in a test, rather than quietly returning every provider's rows.
 */
const store = new AsyncLocalStorage();

export class TenantScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TenantScopeError';
    // Not a client's fault and not something a caller can retry into working.
    this.status = 500;
  }
}

/**
 * Runs `fn` with `tenantId` as the provider in scope.
 *
 * `actor` é opcional e carrega QUEM está agindo — o mesmo objeto de sessão que
 * `req.user` recebe. Ele existe pelo motivo que o `tenantId` existe: há escrita
 * fundo no serviço que precisa saber quem a provocou, e passá-la chamada por
 * chamada é a forma que se esquece. Trabalho de fundo não tem autor, e ali ele
 * fica nulo — que é a resposta certa, não um valor de reserva.
 */
export function runInTenant(tenantId, fn, { actor = null } = {}) {
  const id = Number(tenantId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new TenantScopeError(`runInTenant needs a provider id; received ${tenantId}`);
  }
  return store.run({ tenantId: id, actor }, fn);
}

/**
 * Runs `fn` with no provider in scope, on purpose.
 *
 * For the few things that legitimately span every provider: the migration
 * runner, copying a panel between databases, the platform console. The reason
 * is required and appears in the error if scoped code is reached anyway, so an
 * escape hatch cannot be opened silently or by accident.
 */
export function runUnscoped(reason, fn, { actor = null } = {}) {
  if (!reason) throw new TenantScopeError('runUnscoped needs a reason');
  // `actor` pelo mesmo motivo que em `runInTenant`, e agora com um caso real: a
  // sessão do console roda aqui, e quem opera a plataforma é autor de tudo o
  // que ela faz. Trabalho de fundo continua sem autor, que é o certo.
  return store.run({ tenantId: null, unscoped: reason, actor }, fn);
}

/**
 * Quem está agindo, ou `null` quando não há ninguém.
 *
 * `null` é a resposta honesta para trabalho de fundo — o varredor, a fila, o
 * webhook — e não deve ser confundida com "não sei": quem lê isto e precisa de
 * um autor deve tratar a ausência, nunca inventar um.
 */
export function currentActor() {
  return store.getStore()?.actor ?? null;
}

export function currentContext() {
  return store.getStore() ?? null;
}

export function hasTenantContext() {
  return Number.isInteger(store.getStore()?.tenantId);
}

/** The provider in scope, or a thrown error. Never a default. */
export function currentTenantId() {
  const context = store.getStore();
  if (!context) {
    throw new TenantScopeError(
      'No provider in scope. A request resolves one; background work has to open '
      + 'it with runInTenant(), once per provider.'
    );
  }
  if (context.tenantId === null) {
    throw new TenantScopeError(
      `Deliberately unscoped (${context.unscoped}), but something asked for a provider. `
      + 'Either the work belongs inside runInTenant(), or the table should not be scoped.'
    );
  }
  return context.tenantId;
}
