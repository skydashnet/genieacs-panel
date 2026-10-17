import { LEAD_RETENTION } from '../config/retention.js';

/**
 * Por quanto tempo o painel guarda os pedidos de contato da vitrine.
 *
 * Mora aqui, fora de `schedulerService.js`, por um motivo de dependência e não
 * de arrumação: a página pública de privacidade precisa DIZER este prazo, e o
 * controller que a serve não pode importar o scheduler — que puxa dezenas de
 * serviços — só para ler uma variável de ambiente. Os dois leem a MESMA função,
 * então o que a política afirma e o que a poda faz não têm como divergir.
 */

/**
 * O prazo dos pedidos de contato da vitrine, em dias — e ele nasce DESLIGADO.
 *
 * Zero ou ausente quer dizer "para sempre", que é a convenção deste sistema
 * (ver `SchedulerService.auditRetentionDays`, que lê o prazo da trilha, e
 * `waMessageSweeper.retentionDays`).
 * E aqui o desligado é o padrão de propósito: um `skygenpanel update` que chega
 * numa instalação em produção não pode começar a apagar linhas que ninguém
 * escolheu apagar. Quem liga o prazo é quem responde por ele.
 *
 * Variável de ambiente, e não linha de configuração, por um motivo técnico:
 * `Setting` e `AppState` passam por `tdb` e têm chave `(tenant_id, key)` —
 * lançam fora de escopo de provedor. `leads` é da plataforma e não tem
 * provedor, então guardar o prazo numa linha exigiria eleger um provedor
 * arbitrário para hospedá-lo, ou depender de a caixa da plataforma existir, e
 * ela é um passo opcional (`scripts/create-platform-tenant.js`).
 *
 * Os limites: abaixo de 30 dias o prazo apagaria o pedido antes de a equipe
 * comercial tê-lo trabalhado; acima de 10 anos ele não é prazo.
 */
const LEAD_RETENTION_MIN_DAYS = LEAD_RETENTION.minDays;
const LEAD_RETENTION_MAX_DAYS = LEAD_RETENTION.maxDays;

/** Dias de guarda dos leads, ou zero para "para sempre". */
export function leadRetentionDays(raw = process.env.LEAD_RETENTION_DAYS) {
  const bruto = String(raw ?? '').trim();
  // A mesma regra estrita do prazo da trilha, e pelo mesmo motivo:
  // `Number.parseInt('12abc')` devolve 12, e um prazo de 12 dias nascido de um
  // campo digitado errado apagaria dado que ninguém mandou apagar. Aqui isso é
  // pior do que lá, porque o padrão é não apagar nada.
  if (!/^[0-9]+$/.test(bruto)) return 0;
  const n = Number.parseInt(bruto, 10);
  if (n === 0) return 0;
  return Math.min(Math.max(n, LEAD_RETENTION_MIN_DAYS), LEAD_RETENTION_MAX_DAYS);
}
