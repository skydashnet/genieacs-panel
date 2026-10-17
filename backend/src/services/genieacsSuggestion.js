import 'dotenv/config';
import { GenieAcsEgress, deploymentIsShared } from './genieacsEgress.js';

/**
 * O endereço de GenieACS que o painel SUGERE a um provedor que está nascendo.
 *
 * Existe para o modo `hosted`: quem opera o deploy sobe uma instância de ACS por
 * provedor, e o operador que passa pelo onboarding não deveria ter que decorar o
 * padrão de endereço que nós mesmos escolhemos.
 *
 * **Uma instância por provedor, e não uma compartilhada.** A consulta do painel
 * ao ACS não carrega filtro de provedor nenhum — `DeviceService.getDevicesPage`
 * monta `projection` e um `query` de `_lastInform`, e nada mais. O que separa um
 * provedor do outro é exclusivamente o `baseUrl` que o conector lê de
 * `settings.genieAcsUrl`. Dois provedores no mesmo ACS enxergariam a frota
 * inteira um do outro; por isso o template abaixo recebe `{slug}` e `{id}`, que
 * é o que faz cada provedor cair num endereço SÓ DELE.
 *
 * Variável de ambiente e não coluna, pelo mesmo motivo de
 * `GENIEACS_ALLOWED_PORTS`: é o deployment dizendo onde ele hospeda, decisão de
 * quem tem o servidor — não de quem usa o painel.
 *
 *   GENIEACS_URL_TEMPLATE=https://acs-{slug}.exemplo.com
 *   GENIEACS_URL_TEMPLATE=http://acs.exemplo.com:{id}
 */

/** Os marcadores que o template aceita, e o que cada um vale. */
const MARCADORES = ['slug', 'id'];

/**
 * A sugestão para um provedor, ou `null`.
 *
 * `null` em quatro casos, e nenhum deles é erro: sem template configurado, com
 * um template que não produz URL válida, com uma porta que o painel recusaria
 * ao salvar, e sem provedor em mãos.
 *
 * **Por que conferir a porta aqui.** A guarda de egresso só aparece na hora de
 * gravar. Sugerir `:7547` — a porta do CWMP, por onde as ONTs falam, e não a da
 * NBI, que é 7557 — entregaria ao operador um endereço que só falha no botão
 * Salvar, com uma mensagem sobre allowlist de portas que ele não escreveu. A
 * tela tem que sugerir só o que ela aceitaria de volta.
 *
 * **E por que NÃO resolver o DNS aqui**, embora a guarda o faça ao salvar: no
 * modo `hosted` a instância daquele provedor pode ainda não existir no instante
 * em que alguém passa pelo onboarding. Recusar a sugestão por o nome ainda não
 * resolver seria recusá-la por uma razão que se conserta sozinha cinco minutos
 * depois. A alcançabilidade é o que o botão "Testar conexão" já responde.
 */
export function suggestGenieAcsUrl(tenant, template = process.env.GENIEACS_URL_TEMPLATE) {
  const molde = String(template ?? '').trim();
  if (!molde || !tenant) return null;

  const valores = { slug: tenant.slug, id: tenant.id };
  let texto = molde;
  for (const marcador of MARCADORES) {
    const valor = valores[marcador];
    // Um marcador sem valor invalida a sugestão inteira: deixar `{slug}` cru no
    // endereço seria pior que não sugerir, porque parece preenchido.
    if (molde.includes(`{${marcador}}`) && (valor === null || valor === undefined || valor === '')) {
      return null;
    }
    texto = texto.replaceAll(`{${marcador}}`, String(valor ?? ''));
  }

  // Sobrou marcador? Alguém escreveu `{tenant}` ou errou a grafia. Devolver o
  // texto com a chave dentro faria a tela oferecer um endereço impossível.
  if (/\{[a-zA-Z_]+\}/.test(texto)) return null;

  let url;
  try {
    url = new URL(texto);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  // Credencial embutida é recusada pelo conector (`DirectConnector.rootUrl`);
  // sugeri-la seria sugerir o que não se consegue salvar.
  if (url.username || url.password) return null;

  const porta = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  // A MESMA condição da guarda: num deploy de um provedor só ela não se aplica,
  // e ali qualquer porta serve. Ler `deploymentIsShared` em vez de `IS_SAAS`
  // mantém as duas respostas iguais — duas leituras da mesma regra que
  // discordam é o defeito que só aparece no dia da gravação.
  if (deploymentIsShared() && !GenieAcsEgress.ALLOWED_PORTS.has(porta)) return null;

  return texto;
}

export default suggestGenieAcsUrl;
