import { getDb, closePool } from '../src/config/database.js';
import Tenant from '../src/models/Tenant.js';
import TenantUser from '../src/models/TenantUser.js';
import { seedDefaults } from '../src/config/seed.js';
import { slugProblem } from '../src/utils/slug.js';

/**
 * Dá à plataforma uma linha em `tenants`, para ela poder ter o que o schema
 * exige que tenha dono.
 *
 * O caso concreto é o WhatsApp. Todas as oito tabelas dele têm `tenant_id` NOT
 * NULL com chave estrangeira para `tenants`, e a sessão do console nasce sem
 * provedor de propósito — então, sem esta linha, quem opera a plataforma não
 * consegue atender os PRÓPRIOS clientes por dentro do painel. Com ela, nada no
 * subsistema muda: o webhook do Evolution já descobre o dono pelo nome da
 * instância, e `forEachTenant` já drena a fila de quem existe.
 *
 * `kind = 'platform'` é o que impede a confusão com um cliente — não listada
 * como provedor, não cobrada, não avisada de vencimento, fora da contagem que
 * decide a marca da tela de login.
 *
 * Script e não botão no console, pelo mesmo motivo de `grant-platform-admin`:
 * isto acontece uma vez por deploy, por quem tem o servidor, e uma rota que
 * cria a linha de maior confiança do sistema é superfície que não se justifica
 * por uma operação única.
 *
 * Rodar duas vezes não é erro a punir: a segunda diz que já existe e não mexe
 * em nada. Vincular administradores é idempotente pelo mesmo princípio.
 */

/** O valor de `--flag=x` ou de `--flag x`, ou null. */
function opcao(args, nome) {
  const igual = args.find((arg) => arg.startsWith(`${nome}=`));
  if (igual) return igual.slice(nome.length + 1);
  const posicao = args.indexOf(nome);
  if (posicao === -1) return null;
  const seguinte = args[posicao + 1];
  return seguinte && !seguinte.startsWith('--') ? seguinte : null;
}

/**
 * Põe os administradores de plataforma como `owner` da caixa.
 *
 * Sem vínculo a linha existe e ninguém entra nela: o login de um painel recusa
 * quem não é membro, e o console não abre tela de provedor. `owner` e não
 * `admin` porque é a casa deles; e a escrita é um upsert à mão porque quem já
 * tem vínculo (rodou o script antes, ou foi posto pelo console) não pode ter o
 * papel rebaixado por uma segunda passada.
 */
async function vincularAdministradores(db, tenantId) {
  const admins = await db('platform_admins').pluck('user_id');
  let novos = 0;
  for (const userId of admins) {
    const existe = await db('tenant_users').where({ tenant_id: tenantId, user_id: userId }).first();
    if (existe) continue;
    await TenantUser.create({ tenantId, userId, role: 'owner' });
    novos += 1;
  }
  return { total: admins.length, novos };
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const slug = opcao(args, '--slug') || 'plataforma';
  const name = opcao(args, '--name') || 'Plataforma';

  try {
    const existente = await Tenant.platform();
    if (existente) {
      console.log(`The platform box already exists: "${existente.name}" (slug "${existente.slug}", id ${existente.id})`);
      const { total, novos } = await vincularAdministradores(getDb(), existente.id);
      console.log(`Platform administrators linked: ${novos} new, ${total} in total`);
      return;
    }

    // A mesma regra de endereço de um provedor, porque É um endereço de
    // provedor: onde há domínio-base, esta caixa responde em
    // `<slug>.<domínio>`. O slug padrão está em `RESERVED_SLUGS`, então só um
    // `--slug` na mão chega aqui com outro valor — e ele passa pela mesma
    // peneira.
    const problema = slugProblem(slug);
    if (problema && slug !== 'plataforma' && slug !== 'platform') {
      console.error(`Invalid slug: ${problema}`);
      process.exitCode = 1;
      return;
    }
    if (await Tenant.findBySlug(slug)) {
      console.error(`Slug "${slug}" is already taken by a provider`);
      process.exitCode = 1;
      return;
    }

    const db = getDb();
    // Numa transação com o seed, pelo mesmo motivo do console: a linha existe
    // ou não existe, e uma caixa criada sem configuração e sem assinatura é
    // lixo que alguém teria de limpar à mão.
    const id = await db.transaction(async (trx) => {
      const novoId = await Tenant.create({ slug, name, kind: 'platform' }, trx);
      await seedDefaults(trx, { tenantIds: [novoId] });
      return novoId;
    });

    const { total, novos } = await vincularAdministradores(db, id);

    console.log(`Platform box created: "${name}" (slug "${slug}", id ${id})`);
    console.log(`Platform administrators linked as owners: ${novos} new, ${total} in total`);
    console.log('It is not listed as a provider, is not billed, and does not count towards the login branding.');
    console.log('Sign in as a platform administrator and pick it at the destination prompt.');
  } catch (error) {
    console.error('Platform box creation failed:', error);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
