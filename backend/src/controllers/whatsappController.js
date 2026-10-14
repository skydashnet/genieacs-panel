import WaMetaTemplateService from '../services/waMetaTemplateService.js';
import WhatsAppConfigService, { WaError } from '../services/whatsappConfigService.js';
import EvolutionInstanceService from '../services/evolutionInstanceService.js';
import MetaWebhookService from '../services/metaWebhookService.js';
import WaBotConfigService from '../services/waBotConfigService.js';
import WaAiService from '../services/waAiService.js';
import WaBotReportService from '../services/waBotReportService.js';
import WaSatisfactionService from '../services/waSatisfactionService.js';
import WaResponseTimeService from '../services/waResponseTimeService.js';
import WaHealthService from '../services/waHealthService.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';
import AuditLog from '../models/AuditLog.js';

export function handleError(req, res, error, fallbackKey) {
  if (error instanceof WaError) {
    // The code lets the UI tell "the integration is off" from "the server
    // refused" without dumping the Evolution response at the operator.
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.details || error.code),
      code: error.code
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

/**
 * Erro da IA: a frase do painel e, ao lado, o que o provedor disse
 * ("HTTP 401 · 1000: Authentication failed"). Sem isso o provedor de internet
 * fica sem saber se a chave é de outra plataforma, se acabou o saldo…
 */
export function aiError(req, res, error) {
  if (error instanceof WaError && String(error.code || '').startsWith('ai_')) {
    const frase = translateError(req.t, error);
    return res.status(error.status).json({
      ...createErrorResponse(error.details ? `${frase} (${error.details})` : frase, null),
      code: error.code
    });
  }
  return handleError(req, res, error, 'whatsapp.ai.error.failed');
}

class WhatsAppController {
  /** `GET /api/whatsapp/bot-config` — a aba Chatbot: opções, textos, horário e os dois interruptores. */
  static async getBotConfig(req, res) {
    try {
      return res.json(createResponse(req.t('whatsapp.configLoaded'), await WaBotConfigService.getPublic(req.locale)));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configLoadFailed');
    }
  }

  /** `POST /api/whatsapp/bot-config/ai-test` — uma pergunta curta à IA, com a chave da tela ou a salva. */
  static async testBotAi(req, res) {
    try {
      const body = req.body ?? {};
      const result = await WaAiService.test({ provider: body.provider, baseUrl: body.baseUrl, apiKey: body.apiKey, model: body.model });
      return res.json(createResponse(req.t('whatsapp.ai.testOk'), result));
    } catch (error) {
      return aiError(req, res, error);
    }
  }

  /** `GET /api/whatsapp/bot-report?days=7|30|90` — o que o bot resolveu no período. */
  static async getBotReport(req, res) {
    try {
      return res.json(createResponse(
        req.t('whatsapp.configLoaded'),
        await WaBotReportService.report({ days: Number(req.query?.days) })
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configLoadFailed');
    }
  }

  /** `GET /api/whatsapp/response-time-report?days=` — quanto o cliente espera por gente. */
  static async getResponseTimeReport(req, res) {
    try {
      return res.json(createResponse(
        req.t('whatsapp.configLoaded'),
        await WaResponseTimeService.report({ days: Number(req.query?.days) })
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configLoadFailed');
    }
  }

  /** `GET /api/whatsapp/satisfaction-report?days=` — a pesquisa de satisfação. */
  static async getSatisfactionReport(req, res) {
    try {
      return res.json(createResponse(
        req.t('whatsapp.configLoaded'),
        await WaSatisfactionService.report({ days: Number(req.query?.days) })
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configLoadFailed');
    }
  }

  /** `PUT /api/whatsapp/bot-config` — campo ausente mantém o que está gravado. */
  static async updateBotConfig(req, res) {
    try {
      const body = req.body ?? {};
      const config = await WaBotConfigService.saveConfig({
        enabled: body.enabled,
        unlockEnabled: body.unlockEnabled,
        options: body.options,
        messages: body.messages,
        hours: body.hours,
        satisfaction: body.satisfaction,
        distribution: body.distribution,
        autoTags: body.autoTags,
        ai: body.ai
      }, req.locale);
      return res.json(createResponse(req.t('whatsapp.configSaved'), config));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configSaveFailed');
    }
  }

  static async getConfig(req, res) {
    try {
      return res.json(createResponse(
        req.t('whatsapp.configLoaded'),
        await WhatsAppConfigService.getPublicConfig()
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configLoadFailed');
    }
  }

  static async updateConfig(req, res) {
    try {
      const body = req.body ?? {};
      const config = await WhatsAppConfigService.saveConfig({
        enabled: body.enabled,
        allowedHosts: body.allowedHosts,
        webhookBaseUrl: body.webhookBaseUrl,
        rejectCallMessage: body.rejectCallMessage,
        portalPublicUrl: body.portalPublicUrl,
        botEnabled: body.botEnabled,
        botUnlockEnabled: body.botUnlockEnabled,
        rateLimitPerMin: body.rateLimitPerMin,
        bulkIntervalMinSec: body.bulkIntervalMinSec,
        bulkIntervalMaxSec: body.bulkIntervalMaxSec,
        bulkBurstSize: body.bulkBurstSize,
        bulkBurstPauseMin: body.bulkBurstPauseMin,
        mediaRetentionDays: body.mediaRetentionDays,
        messageRetentionDays: body.messageRetentionDays,
        managedUrl: body.managedUrl,
        // An absent key keeps the stored one; "" clears it.
        managedAdminKey: body.managedAdminKey === undefined ? undefined : body.managedAdminKey,
        // A entrada da API oficial: para onde a Meta chama e o token que ela
        // confere. O token segue a regra da chave: ausente mantém, "" apaga.
        cloudCallbackUrl: body.cloudCallbackUrl,
        cloudVerifyToken: body.cloudVerifyToken === undefined ? undefined : body.cloudVerifyToken
      });
      return res.json(createResponse(req.t('whatsapp.configSaved'), config));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configSaveFailed');
    }
  }

  static async listAccounts(req, res) {
    try {
      const rows = await WhatsAppAccount.getAll();
      return res.json(createResponse(
        req.t('whatsapp.accountsLoaded', { count: rows.length }),
        rows.map((row) => WhatsAppConfigService.publicAccount(row))
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountsLoadFailed');
    }
  }

  static async createAccount(req, res) {
    try {
      const body = req.body ?? {};
      const { account, qr, pending } = await EvolutionInstanceService.createAccount({
        // Both are ignored in managed mode, where the panel owns the server and
        // the operator never sees its address or its key.
        baseUrl: body.baseUrl,
        adminKey: body.adminKey,
        label: body.label,
        purpose: body.purpose,
        // Número oficial da Meta: `kind: 'cloud'` e as três credenciais dela.
        kind: body.kind === 'cloud' ? 'cloud' : 'baileys',
        metaToken: body.metaToken,
        phoneNumberId: body.phoneNumberId,
        wabaId: body.wabaId
      });
      return res.status(201).json(createResponse(req.t('whatsapp.accountConnecting'), {
        account: WhatsAppConfigService.publicAccount(account),
        qr,
        pending
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  /** Busca na Meta os modelos aprovados de um número oficial. */
  static async syncMetaTemplates(req, res) {
    try {
      const templates = await WaMetaTemplateService.sync(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.metaTemplates.synced', { count: templates.length }), templates));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.metaTemplates.syncFailed');
    }
  }

  /**
   * Troca o token da Meta de um número oficial (delete + create da instância
   * com o mesmo nome e o mesmo webhook). A chave admin só vem do corpo no
   * self-host; num servidor gerenciado ela é da configuração.
   */
  static async updateMetaToken(req, res) {
    try {
      const { account } = await EvolutionInstanceService.updateCloudToken(req.params?.id, {
        metaToken: req.body?.metaToken,
        adminKey: req.body?.adminKey
      });
      return res.json(createResponse(req.t('whatsapp.metaTokenUpdated'), {
        account: WhatsAppConfigService.publicAccount(account)
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  /**
   * Registra de novo o webhook da conta WABA na Meta (`override_callback_uri`
   * com o token de verificação do servidor), com o token do próprio número.
   * Falha da Meta fica gravada no número e volta como 502.
   */
  static async registerMetaWebhook(req, res) {
    try {
      const { account } = await MetaWebhookService.retry(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.metaWebhook.registered'), {
        account: WhatsAppConfigService.publicAccount(account)
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  /**
   * Pede à Meta um modelo novo no número oficial. Sai PENDING: a Meta revisa,
   * e só uma sincronização depois da aprovação o deixa utilizável.
   */
  static async createMetaTemplate(req, res) {
    try {
      const template = await WaMetaTemplateService.create(req.params?.id, req.body ?? {});
      return res.status(201).json(createResponse(req.t('whatsapp.metaTemplates.created'), template));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.metaTemplates.createFailed');
    }
  }

  static async listMetaTemplates(req, res) {
    try {
      const templates = await WaMetaTemplateService.list({
        accountId: req.query?.accountId ? Number(req.query.accountId) : null,
        usableOnly: ['1', 'true'].includes(String(req.query?.usable ?? ''))
      });
      return res.json(createResponse(req.t('whatsapp.metaTemplates.loaded', { count: templates.length }), templates));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.metaTemplates.loadFailed');
    }
  }

  static async getQr(req, res) {
    try {
      const { account, qr, pending } = await EvolutionInstanceService.refreshQr(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.qrReady'), {
        account: WhatsAppConfigService.publicAccount(account),
        qr,
        pending
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  static async getStatus(req, res) {
    try {
      const { account, state } = await EvolutionInstanceService.checkStatus(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.statusChecked'), {
        account: WhatsAppConfigService.publicAccount(account),
        // What the server said, which is not always what was stored: a
        // `disconnected` on a number still pairing is reported and not written.
        state
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  static async restartAccount(req, res) {
    try {
      const { account } = await EvolutionInstanceService.restart(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.accountConnecting'), {
        account: WhatsAppConfigService.publicAccount(account)
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  /**
   * O que o servidor Evolution diz que o webhook desta conta é.
   *
   * Leitura, e é por isso que exige só `whatsapp.read`: quem está de plantão
   * olhando por que nada chega não devia precisar da permissão que cria e
   * apaga número para descobrir a causa.
   */
  static async checkWebhook(req, res) {
    try {
      const resultado = await EvolutionInstanceService.inspectWebhook(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.webhookChecked'), {
        account: WhatsAppConfigService.publicAccount(resultado.account),
        verdict: resultado.verdict,
        supported: resultado.supported,
        serverUrl: resultado.serverUrl
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  /** Reescreve o webhook no servidor, e confere lendo de volta. */
  static async reapplyWebhook(req, res) {
    try {
      const resultado = await EvolutionInstanceService.reapplyWebhook(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.webhookReapplied'), {
        account: WhatsAppConfigService.publicAccount(resultado.account),
        verdict: resultado.verdict,
        supported: resultado.supported,
        serverUrl: resultado.serverUrl
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  /**
   * A volta: o painel se chama pela porta da frente.
   *
   * `whatsapp.config` e não `whatsapp.read`, ao contrário da conferência: esta
   * FAZ o painel emitir uma requisição para um endereço escolhido por quem
   * administra. É a mesma permissão que já decide para qual servidor Evolution
   * o painel fala.
   */
  static async probeWebhook(req, res) {
    try {
      const resultado = await EvolutionInstanceService.probeWebhook(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.webhookProbed'), {
        account: WhatsAppConfigService.publicAccount(resultado.account),
        verdict: resultado.verdict,
        status: resultado.status
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  /**
   * O diagnóstico da configuração, que roda com zero números conectados.
   *
   * A trilha grava os VEREDITOS, nunca a chave admin nem token nenhum. O
   * endereço do webhook passa pelo mesmo redator que o serviço já usa, e ele
   * está no resultado — a linha da trilha é o registro de que o painel emitiu
   * requisições para endereços escolhidos por quem administra, e sem o endereço
   * ela não registra o que interessa.
   */
  static async testConfig(req, res) {
    try {
      const resultado = await EvolutionInstanceService.testConfig();
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.WHATSAPP_CONFIG_TESTED,
        subjectType: 'whatsapp',
        subjectId: 'config',
        detail: {
          ...Object.fromEntries(resultado.passos.map(({ passo, veredito }) => [passo, veredito])),
          webhook: resultado.passos.find((p) => p.passo === 'webhookPath')?.detalhe ?? null
        }
      });
      return res.json(createResponse(req.t('whatsapp.configTested'), resultado));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configTestFailed');
    }
  }

  static async disconnectAccount(req, res) {
    try {
      const { account } = await EvolutionInstanceService.disconnect(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.disconnected'), {
        account: WhatsAppConfigService.publicAccount(account)
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  static async deleteAccount(req, res) {
    try {
      const result = await EvolutionInstanceService.remove(req.params?.id, {
        adminKey: req.body?.adminKey
      });
      // Success even when the server refused: the row is gone either way, and
      // `serverError` is how the operator learns an instance was left running.
      return res.json(createResponse(req.t('whatsapp.accountDeleted'), result));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  static async updateAccount(req, res) {
    try {
      const body = req.body ?? {};
      const account = await EvolutionInstanceService.updateAccount(req.params?.id, {
        label: body.label,
        purpose: body.purpose,
        isDefault: body.isDefault,
        color: body.color
      });
      return res.json(createResponse(req.t('whatsapp.accountUpdated'), {
        account: WhatsAppConfigService.publicAccount(account)
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  /**
   * "Is this working?" — the whole integration in one payload.
   *
   * Shaped exactly as `docs/whatsapp-api-contract.md` freezes it, and returned
   * whole or not at all: a strip that renders half the truth is worse than one
   * that says it could not read, because a missing queue reads as an empty one.
   */
  static async getHealth(req, res) {
    try {
      return res.json(createResponse(
        req.t('whatsapp.healthLoaded'),
        await WaHealthService.read()
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.healthLoadFailed');
    }
  }

  static async checkNumbers(req, res) {
    try {
      const results = await EvolutionInstanceService.checkNumbers(req.body?.numbers);
      return res.json(createResponse(
        req.t('whatsapp.numbersChecked', { count: results.length }),
        results
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }
}

export default WhatsAppController;
