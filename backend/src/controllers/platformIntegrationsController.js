import Tenant from '../models/Tenant.js';
import PlatformAudit from '../models/PlatformAudit.js';
import { BILLING_WEBHOOK_PATH } from '../config/billingWebhookPath.js';
import { panelBaseDomain } from '../middleware/tenantResolver.js';
import {
  AsaasSettingsError,
  CHARGES_FIELDS,
  NFSE_FIELDS,
  generateWebhookToken,
  readPublic,
  save
} from '../services/billing/asaasSettingsService.js';
import { AsaasError, testConnection } from '../services/billing/asaasClient.js';
import {
  AsaasCustomerError,
  customerPayloadFor,
  ensureAsaasCustomer
} from '../services/billing/asaasCustomerService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

/**
 * As integrações da PLATAFORMA com sistemas de fora — hoje, a conta dela no
 * Asaas.
 *
 * É a outra metade da cobrança automática. A emissão (`chargeIssuingService`)
 * e o webhook (`billingWebhookController`) já existiam, mas só andavam com duas
 * variáveis no `.env` do servidor, e a única forma de trocá-las era um terminal
 * e um reinício. Esta tela as põe onde está quem opera a cobrança.
 *
 * Três regras, e as três vêm do resto do console:
 *
 * 1. **Nenhum segredo sai.** A leitura diz se a chave e o token existem e DE
 *    ONDE vêm (`db` ou `env`), nunca o valor — o mesmo de `/deployment`. A
 *    única exceção é o token cunhado aqui, que sai uma vez, na resposta da
 *    cunhagem, porque é preciso colá-lo no painel do gateway.
 * 2. **Ausente mantém, vazio apaga.** Um formulário que reenvia tudo não pode
 *    apagar a chave só porque o campo de senha voltou em branco — e apagar a
 *    gravada devolve a palavra ao `.env`, se ele tiver o valor.
 * 3. **Toda mudança na trilha da plataforma, sem o valor.**
 */

/**
 * O endereço que se cola no painel do gateway como destino do webhook.
 *
 * Do domínio-base quando há um — o ápice, que é onde a rota atende sem
 * provedor nenhum na frente —, senão de `PUBLIC_BASE_URL`, e senão só o
 * caminho: a tela mostra o que sabe, e um caminho sem host ainda diz a quem
 * configura o que falta completar. Nunca do `Host` da requisição, pelo motivo
 * de sempre: o cabeçalho é de quem pede.
 */
export function billingWebhookUrl() {
  const base = panelBaseDomain();
  if (base) return `https://${base}${BILLING_WEBHOOK_PATH}`;
  const publico = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (publico) {
    try {
      const parsed = new URL(publico);
      if (['http:', 'https:'].includes(parsed.protocol)) return `${publico}${BILLING_WEBHOOK_PATH}`;
    } catch {
      // Um `PUBLIC_BASE_URL` que não é URL cai no caminho sozinho, abaixo.
    }
  }
  return BILLING_WEBHOOK_PATH;
}

async function presentAsaas() {
  return { ...(await readPublic()), webhookUrl: billingWebhookUrl() };
}

function settingsError(res, error) {
  return res.status(error.status || 400).json(createErrorResponse(error.message, null, error.code));
}

/**
 * O cadastro fiscal nos nomes do gateway mora em `asaasCustomerService`, junto
 * com a criação do cliente — que deixou de ser só deste controlador quando o
 * provedor passou a poder pedir "pagar agora" no próprio painel. Reexportado
 * aqui para quem já o importava deste endereço.
 */
export { customerPayloadFor };

class PlatformIntegrationsController {
  /** `GET /api/platform/integrations/asaas` */
  static async getAsaas(req, res) {
    try {
      return res.json(createResponse('Asaas integration retrieved', await presentAsaas()));
    } catch (error) {
      console.error('Get Asaas integration error:', error);
      return res.status(500).json(createErrorResponse('Failed to read the Asaas integration', error.message));
    }
  }

  /**
   * `PUT /api/platform/integrations/asaas` — `{ environment?, apiKey?,
   * webhookToken?, nfseEnabled?, serviceDescription?, municipalServiceId?,
   * municipalServiceCode?, municipalServiceName?, issPercent?, retainIss?,
   * observations?, finePercent?, interestMonthlyPercent?, discountKind?,
   * discountValue?, discountDaysBefore? }`. 400 `invalid_nfse` quando a nota
   * não fecha; 400 `invalid_charges` quando multa, juros ou desconto saem da
   * faixa.
   */
  static async updateAsaas(req, res) {
    try {
      const corpo = req.body ?? {};
      const nfse = Object.fromEntries(NFSE_FIELDS.map((campo) => [campo, corpo[campo]]));
      const termos = Object.fromEntries(CHARGES_FIELDS.map((campo) => [campo, corpo[campo]]));
      const { changed } = await save({
        environment: corpo.environment,
        apiKey: corpo.apiKey,
        webhookToken: corpo.webhookToken,
        ...nfse,
        ...termos
      });
      const atual = await presentAsaas();

      const registrada = await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_INTEGRATION_CHANGED,
        detail: {
          integration: 'asaas',
          environment: atual.environment,
          apiKeyChanged: changed.apiKey,
          webhookTokenChanged: changed.webhookToken,
          // A nota não é segredo: vai inteira, para a trilha dizer quem ligou.
          ...(changed.nfse ? { nfseChanged: true, nfseEnabled: atual.nfseEnabled } : {}),
          // Multa, juros e desconto também não são segredo: vão os números.
          ...(changed.charges
            ? { chargesChanged: true, charges: Object.fromEntries(CHARGES_FIELDS.map((campo) => [campo, atual[campo]])) }
            : {})
        }
      });
      if (!registrada) console.warn('Asaas integration changed without a platform trail line');

      return res.json(createResponse('Asaas integration updated', atual));
    } catch (error) {
      if (error instanceof AsaasSettingsError) return settingsError(res, error);
      console.error('Update Asaas integration error:', error);
      return res.status(500).json(createErrorResponse('Failed to update the Asaas integration', error.message));
    }
  }

  /**
   * `POST /api/platform/integrations/asaas/test`
   *
   * A recusa do gateway responde 200 com `ok: false`, e não um 4xx: a rota
   * funcionou — a pergunta era "a chave presta?", e "não" é uma resposta. O
   * 400 fica para quando não há chave nenhuma a testar.
   */
  static async testAsaas(req, res) {
    try {
      const atual = await readPublic();
      if (!atual.apiKeyConfigured) {
        return res.status(400).json(createErrorResponse(
          'The Asaas API key is not configured', null, 'not_configured'
        ));
      }
      try {
        const { accountName } = await testConnection();
        return res.json(createResponse('Asaas answered', {
          ok: true,
          ...(accountName ? { accountName } : {}),
          environment: atual.environment
        }));
      } catch (error) {
        if (!(error instanceof AsaasError)) throw error;
        return res.json(createResponse(error.message, { ok: false, environment: atual.environment }, error.code));
      }
    } catch (error) {
      console.error('Test Asaas integration error:', error);
      return res.status(500).json(createErrorResponse('Failed to test the Asaas integration', error.message));
    }
  }

  /**
   * `POST /api/platform/integrations/asaas/webhook-token`
   *
   * Cunha, grava e devolve — a única vez em que o token sai do servidor. Quem
   * cunhou cola no painel do gateway; quem perdeu cunha outro, e o velho para
   * de valer na hora, que é o que se quer de um token que alguém perdeu.
   */
  static async rotateWebhookToken(req, res) {
    try {
      const { webhookToken, settings } = await generateWebhookToken();
      const registrada = await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_INTEGRATION_CHANGED,
        detail: {
          integration: 'asaas',
          environment: settings.environment,
          apiKeyChanged: false,
          webhookTokenChanged: true
        }
      });
      if (!registrada) console.warn('Asaas webhook token minted without a platform trail line');
      return res.json(createResponse('Webhook token generated', { webhookToken }));
    } catch (error) {
      if (error instanceof AsaasSettingsError) return settingsError(res, error);
      console.error('Generate Asaas webhook token error:', error);
      return res.status(500).json(createErrorResponse('Failed to generate the webhook token', error.message));
    }
  }

  /**
   * `POST /api/platform/tenants/:id/gateway/asaas-customer`
   *
   * Cria o provedor como cliente na conta Asaas da plataforma e o liga a ele —
   * o passo que antes era abrir o painel do gateway, cadastrar o CNPJ à mão e
   * colar o id de volta no console, com a chance de colar o id do cliente
   * errado e mandar o crédito de um para o outro.
   *
   * 409 quando já há vínculo: criar um segundo cliente para quem já tem um
   * deixaria dois cadastros no gateway para o mesmo CNPJ, e as cobranças de
   * um não achariam o outro. Para trocar, desliga-se primeiro, pelo PATCH.
   */
  static async createAsaasCustomer(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      const tenant = await Tenant.findById(id);
      // A caixa da plataforma não é cliente de ninguém — ver a emissão.
      if (!tenant || tenant.kind === 'platform') {
        return res.status(404).json(createErrorResponse('Provider not found'));
      }
      if (tenant.billing_customer_ref) {
        return res.status(409).json(createErrorResponse(
          'This provider is already linked to a gateway customer', null, 'already_linked'
        ));
      }

      // A criação, a tradução do cadastro e a conferência da corrida são do
      // serviço, que o "pagar agora" do provedor também usa. O que fica aqui é
      // o que é do console: o 409 para quem já está ligado (conferido acima,
      // antes de chamar) e para a corrida perdida — `created: false` depois de
      // a conferência de cima ter passado quer dizer que outro clique ligou o
      // provedor enquanto este falava com o gateway.
      let resultado;
      try {
        resultado = await ensureAsaasCustomer(id);
      } catch (error) {
        if (!(error instanceof AsaasCustomerError)) throw error;
        return res.status(error.status).json(createErrorResponse(error.message, null, error.code));
      }
      if (!resultado.created) {
        return res.status(409).json(createErrorResponse(
          'This provider is already linked to a gateway customer', null, 'already_linked'
        ));
      }

      const registrada = await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.TENANT_GATEWAY_CUSTOMER_CREATED,
        tenant,
        // O gateway e que houve vínculo; o id do cliente, não — mesma razão de
        // `setGateway`: é a chave que decide para quem vai o crédito.
        detail: { gateway: 'asaas', linked: true }
      });
      if (!registrada) console.warn(`Provider ${id} gateway customer created without a platform trail line`);

      const atual = await Tenant.findById(id);
      return res.status(201).json(createResponse('Gateway customer created', {
        id, gateway: Tenant.presentGateway(atual)
      }));
    } catch (error) {
      console.error('Create Asaas customer error:', error);
      return res.status(500).json(createErrorResponse('Failed to create the gateway customer', error.message));
    }
  }
}

export default PlatformIntegrationsController;
