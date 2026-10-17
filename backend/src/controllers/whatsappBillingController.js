import WaMetaTemplateService from '../services/waMetaTemplateService.js';
import WaMetaUsageService from '../services/waMetaUsageService.js';
import WaBillingService from '../services/waBillingService.js';
import WaBroadcastService from '../services/waBroadcastService.js';
import WaTemplateService from '../services/waTemplateService.js';
import WaDunningService from '../services/waDunningService.js';
import WaCampaignService from '../services/waCampaignService.js';
import AuditLog from '../models/AuditLog.js';
import WaAiService from '../services/waAiService.js';
import WaOptOut from '../models/WaOptOut.js';
import { WaError } from '../services/whatsappConfigService.js';
import { SgpError } from '../services/sgpService.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';
import { lerTipos, tiposGravados } from '../utils/wa/waOptOutTipos.js';
import WaContactService from '../services/waContactService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

/**
 * Both error classes are handled here because this surface straddles both
 * integrations: a campaign build fails on the SGP as readily as on WhatsApp,
 * and "the ERP is switched off" has to arrive at the screen as itself rather
 * than as an anonymous 500.
 */
function handleError(req, res, error, fallbackKey) {
  if (error instanceof WaError || error instanceof SgpError) {
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.details || error.code),
      code: error.code,
      // A build that ends with nobody to contact still owes the operator the
      // reason: "every one of them is on the do-not-disturb list" is the answer
      // they need, and it would be lost inside a bare 409.
      ...(error.skipped ? { skipped: error.skipped } : {})
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

/** The opt-out shape the browser may see, built field by field. */
function publicOptOut(row, clientName = null) {
  if (!row) return null;
  return {
    id: row.id,
    waPhoneE164: row.wa_phone_e164 || null,
    waLid: row.wa_lid || null,
    origin: row.origin,
    reasonText: row.reason_text || null,
    // Os tipos que o bloqueio cobre; `null` é tudo.
    categories: tiposGravados(row.categories),
    clientName,
    createdAt: row.created_at || null
  };
}

/** `categories` do corpo da requisição, ou a recusa de um tipo que não existe. */
function tiposDoCorpo(body) {
  if (!body || !('categories' in body)) return { given: false, tipos: null };
  const tipos = lerTipos(body.categories);
  if (tipos === undefined) {
    throw new WaError('whatsapp.error.invalidOptOutCategories', { code: 'invalid_categories', status: 400 });
  }
  return { given: true, tipos };
}

/** What the audit trail keeps of a cadence: its shape, never a phone. */
function auditDetail(rule) {
  return {
    enabled: rule.enabled === true,
    steps: (rule.steps || []).map((step) => ({ offsetDays: step.offsetDays, templateId: step.templateId })),
    maxPerInvoice: rule.maxPerInvoice,
    minIntervalHours: rule.minIntervalHours,
    receiptPauseDays: rule.receiptPauseDays,
    thanksTemplateId: rule.thanksTemplateId ?? null
  };
}

/**
 * A preview as the screen sees it. The failure is translated here, at read
 * time, in the language of whoever is polling — not of whoever clicked.
 */
function publicPreview(req, state) {
  if (!state) return { status: 'idle', checked: 0, total: null, result: null, error: null };
  return {
    status: state.status,
    checked: state.checked,
    total: state.total,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    result: state.status === 'done' ? state.result : null,
    error: state.status === 'failed'
      ? {
        code: state.error?.code || 'preview_failed',
        message: state.error?.translationKey ? translateError(req.t, state.error) : req.t('whatsapp.dunning.previewFailed')
      }
      : null
  };
}

class WhatsAppBillingController {
  // ── Templates ────────────────────────────────────────────────────────

  static async listTemplates(req, res) {
    try {
      const templates = await WaTemplateService.list({
        category: req.query?.category,
        includeInactive: ['1', 'true'].includes(String(req.query?.includeInactive ?? ''))
      });
      return res.json(createResponse(
        req.t('whatsapp.templates.loaded', { count: templates.length }),
        templates
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.templates.loadFailed');
    }
  }

  static async createTemplate(req, res) {
    try {
      const body = req.body ?? {};
      const template = await WaTemplateService.create({
        name: body.name,
        body: body.body,
        category: body.category,
        metaTemplateName: body.metaTemplateName,
        metaLanguage: body.metaLanguage,
        metaParams: body.metaParams,
        metaHeader: body.metaHeader,
        metaButtonParam: body.metaButtonParam
      });
      return res.status(201).json(createResponse(req.t('whatsapp.templates.created'), template));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.templates.saveFailed');
    }
  }

  /**
   * `POST /templates/ai-draft` — a IA escreve (ou melhora) o texto de um
   * modelo. Nada é gravado: o texto volta para a caixa do editor.
   */
  static async draftTemplate(req, res) {
    try {
      const body = req.body ?? {};
      const result = await WaAiService.draftTemplate({
        category: body.category,
        goal: body.goal,
        tone: body.tone,
        current: body.current
      });
      // Que a IA foi usada e para qual categoria; o texto nunca vai para a Trilha.
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.WHATSAPP_TEMPLATE_AI_DRAFT,
        subjectType: 'whatsapp_template',
        subjectId: null,
        detail: { category: String(body.category ?? '').slice(0, 32), improved: Boolean(String(body.current ?? '').trim()) }
      });
      return res.json(createResponse(req.t('whatsapp.templates.aiDrafted'), result));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.templates.aiDraftFailed');
    }
  }

  static async updateTemplate(req, res) {
    try {
      const body = req.body ?? {};
      const template = await WaTemplateService.update(req.params.id, {
        name: body.name,
        body: body.body,
        category: body.category,
        active: body.active,
        metaTemplateName: body.metaTemplateName,
        metaLanguage: body.metaLanguage,
        metaParams: body.metaParams,
        metaHeader: body.metaHeader,
        metaButtonParam: body.metaButtonParam
      });
      return res.json(createResponse(req.t('whatsapp.templates.updated'), template));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.templates.saveFailed');
    }
  }

  /** Os avisos automáticos ligados a modelos da Meta (manutenção, queda, alerta). */
  static async getMetaNoticeBindings(req, res) {
    try {
      return res.json(createResponse(req.t('whatsapp.metaTemplates.bindingsLoaded'), await WaMetaTemplateService.getNoticeBindings()));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.templates.loadFailed');
    }
  }

  static async saveMetaNoticeBindings(req, res) {
    try {
      const saved = await WaMetaTemplateService.saveNoticeBindings(req.body ?? {});
      return res.json(createResponse(req.t('whatsapp.metaTemplates.bindingsSaved'), saved));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.templates.saveFailed');
    }
  }

  // ── Uso dos modelos da Meta ──────────────────────────────────────────

  static async getMetaUsage(req, res) {
    try {
      const report = await WaMetaUsageService.report({ months: Number(req.query.months) || 6 });
      return res.json(createResponse(req.t('whatsapp.metaUsage.loaded'), report));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.metaUsage.loadFailed');
    }
  }

  static async getMetaPrices(req, res) {
    try {
      return res.json(createResponse(req.t('whatsapp.metaUsage.loaded'), await WaMetaUsageService.getPrices()));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.metaUsage.loadFailed');
    }
  }

  static async saveMetaPrices(req, res) {
    try {
      const saved = await WaMetaUsageService.savePrices(req.body ?? {});
      return res.json(createResponse(req.t('whatsapp.metaUsage.pricesSaved'), saved));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.templates.saveFailed');
    }
  }

  static async deleteTemplate(req, res) {
    try {
      await WaTemplateService.remove(req.params.id);
      return res.json(createResponse(req.t('whatsapp.templates.deleted')));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.templates.deleteFailed');
    }
  }

  // ── Do not disturb ───────────────────────────────────────────────────

  static async listOptOuts(req, res) {
    try {
      const rows = await WaOptOut.listActive();
      const names = await WaContactService.namesByPhone(rows.map((row) => row.wa_phone_e164));
      return res.json(createResponse(
        req.t('whatsapp.optOut.loaded', { count: rows.length }),
        rows.map((row) => publicOptOut(row, names.get(row.wa_phone_e164) ?? null))
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.optOut.loadFailed');
    }
  }

  static async createOptOut(req, res) {
    try {
      const body = req.body ?? {};
      // Normalised on the way in, because that is the form a campaign asks
      // about: an entry saved as "(93) 98111-0449" would match nothing, and the
      // failure would be a message sent to someone who asked for silence.
      const phone = normalizarTelefoneBr(body.phone);
      if (!phone) {
        throw new WaError('whatsapp.error.invalidPhone', { code: 'invalid_phone', status: 400 });
      }
      const { tipos } = tiposDoCorpo(body);
      const created = await WaOptOut.record({
        waPhone: phone,
        origin: 'operator',
        reasonText: body.reasonText,
        categories: tipos
      });
      // A null means an active opt-out already covers this number. Answering
      // with it rather than with an error keeps the button idempotent — the
      // outcome the operator asked for is the outcome they have. O que a
      // equipe escolheu agora, porém, vale: os tipos da linha existente são
      // trocados pelos do pedido (`record` só amplia, nunca restringe).
      let row = created || await WaOptOut.findActive({ waPhone: phone });
      if (!created && row && tiposGravados(row.categories)?.join() !== tipos?.join()) {
        row = await WaOptOut.setCategories(row.id, tipos);
      }
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.WHATSAPP_OPT_OUT_CHANGED,
        subjectType: 'opt_out',
        subjectId: row ? String(row.id) : null,
        detail: { categories: tipos ?? 'all', added: Boolean(created) }
      });
      const names = await WaContactService.namesByPhone([phone]);
      return res.status(created ? 201 : 200).json(createResponse(
        req.t('whatsapp.optOut.created'),
        publicOptOut(row, names.get(phone) ?? null)
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.optOut.failed');
    }
  }

  /** A equipe afina quais tipos de comunicação o bloqueio cobre. */
  static async updateOptOut(req, res) {
    try {
      const id = Number(req.params.id);
      const { given, tipos } = tiposDoCorpo(req.body);
      if (!given) {
        throw new WaError('whatsapp.error.invalidOptOutCategories', { code: 'invalid_categories', status: 400 });
      }
      const row = Number.isInteger(id) ? await WaOptOut.setCategories(id, tipos) : null;
      if (!row || row.revoked_at) {
        return res.status(404).json(createErrorResponse(req.t('common.routeNotFound')));
      }
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.WHATSAPP_OPT_OUT_CHANGED,
        subjectType: 'opt_out',
        subjectId: String(row.id),
        detail: { categories: tipos ?? 'all', added: false }
      });
      const names = await WaContactService.namesByPhone([row.wa_phone_e164]);
      return res.json(createResponse(req.t('whatsapp.optOut.updated'), publicOptOut(row, names.get(row.wa_phone_e164) ?? null)));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.optOut.failed');
    }
  }

  static async revokeOptOut(req, res) {
    try {
      const id = Number(req.params.id);
      const row = Number.isInteger(id) ? await WaOptOut.revoke(id, req.user?.userId ?? null) : null;
      if (!row) {
        return res.status(404).json(createErrorResponse(req.t('common.routeNotFound')));
      }
      return res.json(createResponse(req.t('whatsapp.optOut.revoked'), publicOptOut(row)));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.optOut.failed');
    }
  }

  // ── Billing cadence ──────────────────────────────────────────────────

  static async listOverdue(req, res) {
    try {
      const subscribers = await WaBillingService.listOverdue({
        daysMin: req.query?.daysMin,
        daysMax: req.query?.daysMax,
        search: req.query?.search,
        limit: req.query?.limit
      });
      return res.json(createResponse(
        req.t('whatsapp.billing.overdueLoaded', { count: subscribers.length }),
        subscribers
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.billing.overdueLoadFailed');
    }
  }

  /**
   * Builds the campaign. It does NOT send it.
   *
   * The response is a `draft` and a breakdown of who was left out, so the
   * operator can read the list before anyone's phone rings. Starting it is a
   * separate, deliberate request.
   */
  static async buildCampaign(req, res) {
    try {
      const body = req.body ?? {};
      const { broadcast, recipients, skipped } = await WaBillingService.buildCampaign({
        template: body.template,
        contracts: body.contracts,
        title: body.title,
        userId: req.user?.userId ?? null
      });
      return res.status(201).json(createResponse(
        req.t('whatsapp.billing.campaignBuilt', { count: recipients }),
        { broadcast: WaBroadcastService.publicBroadcast(broadcast), recipients, skipped }
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.billing.campaignFailed');
    }
  }

  // ── The subscriber's number ──────────────────────────────────────────

  /**
   * Sets or clears the operator's correction to a subscriber's number.
   *
   * An empty `phone` is not a missing field to reject: it is the operator
   * withdrawing a correction, which hands the contract back to the ERP record.
   * Only a non-empty entry that could not be dialled is refused.
   */
  static async setSubscriberPhone(req, res) {
    try {
      const subscriber = await WaBillingService.setSubscriberPhone(
        req.params.contract,
        req.body?.phone
      );
      return res.json(createResponse(req.t('whatsapp.phoneSaved'), subscriber));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.phoneSaveFailed');
    }
  }

  // ── Campaigns ────────────────────────────────────────────────────────

  static async listBroadcasts(req, res) {
    try {
      const broadcasts = await WaBroadcastService.list();
      return res.json(createResponse(
        req.t('whatsapp.broadcast.loaded', { count: broadcasts.length }),
        broadcasts
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.broadcast.loadFailed');
    }
  }

  // ── Automatic billing cadence ────────────────────────────────────────

  static async getDunningRule(req, res) {
    try {
      return res.json(createResponse(req.t('whatsapp.dunning.loaded'), await WaDunningService.publicRule()));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.dunning.loadFailed');
    }
  }

  /** Saves steps, window and limits. It never switches the cadence on. */
  static async saveDunningRule(req, res) {
    try {
      const body = req.body ?? {};
      const rule = await WaDunningService.saveRule({
        steps: body.steps,
        window: body.window,
        maxPerInvoice: body.maxPerInvoice,
        minIntervalHours: body.minIntervalHours,
        maxPerRun: body.maxPerRun,
        receiptPauseDays: body.receiptPauseDays,
        thanksTemplateId: body.thanksTemplateId
      });
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.WHATSAPP_DUNNING_SAVED,
        subjectType: 'dunning',
        subjectId: null,
        detail: auditDetail(rule)
      });
      return res.json(createResponse(req.t('whatsapp.dunning.saved'), await WaDunningService.publicRule()));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.dunning.saveFailed');
    }
  }

  /**
   * The switch. Its own route, and its own line in the audit trail: turning
   * this on is what makes the panel message subscribers by itself.
   */
  static async setDunningEnabled(req, res) {
    try {
      const enabled = req.body?.enabled === true;
      const rule = await WaDunningService.setEnabled(enabled, req.user?.userId ?? null);
      await AuditLog.fromRequest(req, {
        action: enabled ? AuditLog.ACTIONS.WHATSAPP_DUNNING_ENABLED : AuditLog.ACTIONS.WHATSAPP_DUNNING_DISABLED,
        subjectType: 'dunning',
        subjectId: null,
        detail: auditDetail(rule)
      });
      return res.json(createResponse(
        req.t(enabled ? 'whatsapp.dunning.enabled' : 'whatsapp.dunning.disabled'),
        await WaDunningService.publicRule()
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.dunning.saveFailed');
    }
  }

  /**
   * The ready-made templates, and — on a cadence with no steps yet — the steps
   * that use them. It never switches the cadence on.
   */
  static async installDunningStarter(req, res) {
    try {
      const { created, reused, stepsFilled, rule } = await WaDunningService.installStarter();
      if (stepsFilled) {
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.WHATSAPP_DUNNING_SAVED,
          subjectType: 'dunning',
          subjectId: null,
          detail: { ...auditDetail(rule), starter: true }
        });
      }
      return res.status(created > 0 ? 201 : 200).json(createResponse(
        req.t('whatsapp.dunning.starterInstalled', { created, reused }),
        { created, reused, stepsFilled, rule: await WaDunningService.publicRule() }
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.dunning.starterFailed');
    }
  }

  /**
   * Who would get which step today. Sends nothing.
   *
   * Started in the background and answered at once: one ERP round trip per
   * contract takes minutes on a real provider, far past the minute a reverse
   * proxy waits for a response. The screen polls `GET /dunning/preview`.
   */
  static async startDunningPreview(req, res) {
    try {
      const state = await WaDunningService.startPreview();
      return res.status(202).json(createResponse(req.t('whatsapp.dunning.previewStarted'), publicPreview(req, state)));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.dunning.previewFailed');
    }
  }

  static async getDunningPreview(req, res) {
    try {
      const state = WaDunningService.getPreview();
      return res.json(createResponse(req.t('whatsapp.dunning.loaded'), publicPreview(req, state)));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.dunning.previewFailed');
    }
  }

  /**
   * One pass now, in the background. A pass is one ERP round trip per
   * contract, which on a real provider is minutes: the request answers as soon
   * as the pass has started, and the screen reads the outcome from `lastRun`.
   */
  static async runDunning(req, res) {
    try {
      await WaDunningService.assertCanRun();
      void WaDunningService.run({ manual: true }).catch((error) => {
        console.warn(`[wa] régua: passada manual falhou: ${error.code || error.message}`);
      });
      return res.status(202).json(createResponse(req.t('whatsapp.dunning.runStarted'), { started: true }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.dunning.runFailed');
    }
  }

  static async listDunningSends(req, res) {
    try {
      const page = await WaDunningService.listSends({
        contract: req.query?.contract,
        status: req.query?.status,
        kind: req.query?.kind,
        limit: req.query?.limit,
        offset: req.query?.offset
      });
      return res.json(createResponse(req.t('whatsapp.dunning.sendsLoaded', { count: page.items.length }), page));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.dunning.loadFailed');
    }
  }

  static async dunningStats(req, res) {
    try {
      const stats = await WaDunningService.stats({ days: req.query?.days });
      return res.json(createResponse(req.t('whatsapp.dunning.statsLoaded'), stats));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.dunning.loadFailed');
    }
  }

  // ── Campanhas de aviso ───────────────────────────────────────────────

  static async campaignAudienceOptions(req, res) {
    try {
      return res.json(createResponse(req.t('whatsapp.campaign.optionsLoaded'), await WaCampaignService.audienceOptions()));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.campaign.optionsFailed');
    }
  }

  static async previewCampaign(req, res) {
    try {
      const body = req.body ?? {};
      const preview = await WaCampaignService.preview({
        filters: body.filters,
        templateId: body.templateId,
        body: body.body
      });
      return res.json(createResponse(req.t('whatsapp.campaign.previewReady', { count: preview.counts.reachable }), preview));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.campaign.previewFailed');
    }
  }

  static async createCampaign(req, res) {
    try {
      const body = req.body ?? {};
      const { broadcast, recipients, skipped } = await WaCampaignService.create({
        title: body.title,
        filters: body.filters,
        templateId: body.templateId,
        body: body.body,
        attachment: body.attachment,
        scheduledAt: body.scheduledAt,
        accountId: body.accountId,
        pace: body.pace,
        userId: req.user?.userId ?? null
      });
      const publico = WaBroadcastService.publicBroadcast(broadcast);
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.WHATSAPP_CAMPAIGN_CREATED,
        subjectType: 'broadcast',
        subjectId: String(broadcast.id),
        detail: {
          title: publico.title,
          recipients,
          scheduledAt: publico.scheduledAt,
          attachment: Boolean(publico.attachment),
          audience: publico.audience
        }
      });
      return res.status(201).json(createResponse(
        req.t('whatsapp.campaign.created', { count: recipients }),
        { broadcast: publico, recipients, skipped }
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.campaign.createFailed');
    }
  }

  static async updateCampaign(req, res) {
    try {
      const body = req.body ?? {};
      const { broadcast, recipients, skipped } = await WaCampaignService.update(req.params.id, {
        title: body.title,
        filters: body.filters,
        templateId: body.templateId,
        body: body.body,
        attachment: body.attachment,
        scheduledAt: body.scheduledAt,
        accountId: body.accountId,
        pace: body.pace
      });
      const publico = WaBroadcastService.publicBroadcast(broadcast);
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.WHATSAPP_CAMPAIGN_UPDATED,
        subjectType: 'broadcast',
        subjectId: String(broadcast.id),
        detail: {
          title: publico.title,
          recipients,
          scheduledAt: publico.scheduledAt,
          attachment: Boolean(publico.attachment)
        }
      });
      return res.json(createResponse(
        req.t('whatsapp.campaign.updated', { count: recipients }),
        { broadcast: publico, recipients, skipped }
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.campaign.updateFailed');
    }
  }

  static async broadcastRecipients(req, res) {
    try {
      const detail = await WaBroadcastService.recipients(req.params.id, {
        status: req.query?.status,
        limit: req.query?.limit,
        offset: req.query?.offset
      });
      return res.json(createResponse(req.t('whatsapp.broadcast.loaded', { count: detail.total }), detail));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.broadcast.loadFailed');
    }
  }

  static async setBroadcastStatus(req, res) {
    try {
      const broadcast = await WaBroadcastService.setStatus(req.params.id, req.body?.status);
      return res.json(createResponse(req.t('whatsapp.broadcast.statusChanged'), broadcast));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.broadcast.statusFailed');
    }
  }
}

export default WhatsAppBillingController;
