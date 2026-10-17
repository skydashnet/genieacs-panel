import { IS_SAAS } from './edition.js';
import { currentTenantId } from './tenantContext.js';
import { getDb } from './database.js';
import GenieAcsConnection from '../models/GenieAcsConnection.js';
import { normalizedAcsOrigin, sameAcsAsAny } from '../services/genieacs/acsIdentity.js';

/**
 * A fronteira entre o que a plataforma configura e o que o provedor configura.
 *
 * Na SaaS, parte da configuração é infraestrutura da plataforma e não do
 * provedor: o endereço e a credencial do GenieACS de cada um (quem hospeda o
 * ACS é a plataforma) e o servidor Evolution que atende todos os números. O
 * provedor continua vendo essas coisas — o status, o teste de conexão —, mas
 * quem escreve é o console, ou a caixa da plataforma no caso do Evolution.
 *
 * Na self-hosted não existe console: o dono da instalação é o provedor, e
 * tudo continua editável na tela de Configuração dele, como sempre foi.
 *
 * A caixa da plataforma (`kind = 'platform'`) é a exceção dentro da SaaS: é
 * nela que o administrador da plataforma edita o que vale para todos, então
 * ela nunca é "gerenciada pela plataforma" — ela É a plataforma.
 *
 * O GenieACS tem uma segunda exceção, por provedor: o console pode marcar que
 * o provedor usa o PRÓPRIO servidor (`tenant_genieacs_connections.ownership =
 * 'own'`). Aí o endereço, a credencial e os parâmetros TR-069 voltam para as
 * mãos dele. O WhatsApp não muda com isso.
 */

/**
 * Os caminhos dos parâmetros virtuais TR-069 que o painel lê do GenieACS.
 *
 * Dependem dos scripts de provisionamento instalados no ACS — que, na SaaS, é
 * da plataforma. Por isso, junto com o endereço do ACS, quem os mantém é o
 * console, e não o provedor.
 */
export const VIRTUAL_PARAMETER_KEYS = Object.freeze([
  'vpPppoeUsername', 'vpWanBridge', 'vpRxPower', 'vpTemperature', 'vpActiveDevices',
  'vpSuperAdmin', 'vpSuperPassword', 'vpUserAdmin', 'vpUserPassword'
]);

/** Chaves de `settings` que só o console grava na SaaS. */
export const PLATFORM_MANAGED_SETTING_KEYS = Object.freeze(['genieAcsUrl', ...VIRTUAL_PARAMETER_KEYS]);

/**
 * Os campos do WhatsApp que descrevem o SERVIDOR Evolution, e não o uso que o
 * provedor faz dele. Na SaaS eles vêm da caixa da plataforma.
 */
export const WA_SERVER_FIELDS = Object.freeze([
  'allowedHosts', 'webhookBaseUrl', 'managedUrl', 'managedAdminKey',
  // A entrada da API oficial: a Meta chama `<servidor>/webhook/meta`, e quem
  // confere o token de verificação é o servidor Evolution. Os dois são dele.
  'cloudCallbackUrl', 'cloudVerifyToken'
]);

/** Se ESTE tenant tem a configuração de infraestrutura nas mãos da plataforma. */
export function platformManages(tenant) {
  return IS_SAAS && (tenant?.kind ?? 'provider') !== 'platform';
}

/** O mesmo, para o provedor em escopo. */
export async function platformManagesCurrentTenant() {
  if (!IS_SAAS) return false;
  const tenant = await getDb()('tenants').where({ id: currentTenantId() }).first();
  return platformManages(tenant);
}

/**
 * Se o GenieACS do provedor em escopo é da plataforma: SaaS, não é a caixa da
 * plataforma, e o console não marcou que ele usa o próprio servidor.
 */
export async function platformManagesGenieAcsCurrentTenant() {
  if (!(await platformManagesCurrentTenant())) return false;
  return (await GenieAcsConnection.ownership()) !== 'own';
}

/**
 * Se a origem de `url` já é o ACS de outro provedor (ou o da plataforma).
 *
 * Um provedor com ACS próprio grava o endereço que quiser; se ele gravasse o
 * endereço de um vizinho, o painel passaria a tratar os dois como um ACS
 * compartilhado, e o vizinho sem tag de equipamentos deixaria de ver a frota
 * dele. Dividir um ACS é decisão da plataforma, pelo console.
 *
 * "O mesmo ACS" é o de `sameAcsAsAny`: o IP no lugar do nome, maiúsculas, o
 * ponto final, a porta padrão por extenso ou outro nome DNS para o mesmo
 * servidor não escapam da recusa.
 */
export async function genieAcsOriginTakenByAnotherTenant(url) {
  if (!normalizedAcsOrigin(url)) return false;
  // tenant-scope-exempt: comparar com o ACS dos outros provedores é o trabalho
  // desta leitura; nada dela volta para quem pergunta além do sim/não.
  const rows = await getDb()('settings')
    .where({ key: 'genieAcsUrl' })
    .whereNot('tenant_id', currentTenantId())
    .select('value');
  return sameAcsAsAny(url, rows.map((row) => row.value));
}
