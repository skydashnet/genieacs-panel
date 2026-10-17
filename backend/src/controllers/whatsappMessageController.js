import WaMessageActionService from '../services/waMessageActionService.js';
import WaSendService from '../services/waSendService.js';
import WaConversationService from '../services/waConversationService.js';
import WaContactService from '../services/waContactService.js';
import WaAssignmentService from '../services/waAssignmentService.js';
import WaTagService from '../services/waTagService.js';
import WaResponseTimeService from '../services/waResponseTimeService.js';
import WaNotificationService from '../services/waNotificationService.js';
import WaAlertService from '../services/waAlertService.js';
import WaBotConfigService from '../services/waBotConfigService.js';
import WaAiService from '../services/waAiService.js';
import { aiError } from './whatsappController.js';
import { SgpError } from '../services/sgpService.js';
import { roleHas } from '../config/permissions.js';
import WaMessage from '../models/WaMessage.js';
import { WaError } from '../services/whatsappConfigService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

/**
 * The widest window the bulk requeue will take, whatever the request asks for.
 *
 * `hours` arrives from the browser, and an unclamped one is a mistake in the
 * same family as an unbounded DELETE, only pointing the other way: a typo of
 * 720 would put a month of failures back on the wire at once. Twenty-four is
 * the ceiling because it is the window the panel already shows — `failed24h`
 * on the health strip is the number the operator is looking at when they reach
 * for this button, so the button can requeue what they can see and no more.
 *
 * Past a day the content itself is the argument: a dunning notice from last
 * week is not a message anyone wants delivered today, and the subscriber it
 * would reach may well have paid in the meantime.
 */
const MAX_REQUEUE_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

function handleError(req, res, error, fallbackKey) {
  // The SGP lookup on the contacts screen answers with the SGP's own refusals
  // ("integration off", "unreachable"), already coded and translated there.
  if (error instanceof WaError || error instanceof SgpError) {
    // The code lets the UI tell "no number is connected" from "this thread has
    // nowhere to send" without dumping the Evolution response at the operator.
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.details || error.code),
      code: error.code
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

class WhatsAppMessageController {
  /**
   * Enqueues one outbound message and answers immediately.
   *
   * The response is deliberately not "sent": it is the queued row, delivery
   * status and all. Waiting on the Evolution server here would make the reply
   * box as slow as the slowest thing in the chain, and would leave the operator
   * with no message at all when it timed out — the worker despatches, and the
   * webhook moves the row to delivered and read.
   */
  static async listConversations(req, res) {
    try {
      const rows = await WaConversationService.list({
        limit: req.query?.limit,
        offset: req.query?.offset,
        search: req.query?.search,
        status: req.query?.status,
        assignee: req.query?.assignee,
        tagId: req.query?.tag,
        userId: req.user?.userId ?? null
      });
      return res.json(createResponse(req.t('whatsapp.conversationsLoaded', { count: rows.length }), rows));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.conversationsLoadFailed');
    }
  }

  static async listMessages(req, res) {
    try {
      const data = await WaConversationService.messages(req.params?.id, {
        limit: req.query?.limit,
        before: req.query?.before
      });
      return res.json(createResponse(
        req.t('whatsapp.messagesLoaded', { count: data.messages.length }),
        data
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.messagesLoadFailed');
    }
  }

  /**
   * Closes a thread, or reopens it.
   *
   * The two literals are the whole vocabulary: an unrecognized value is a 400
   * rather than a silent close, because the difference between the two is what
   * an operator sees in their list tomorrow morning.
   */
  /** `POST /conversations/:id/assign` — assumir (o próprio id), transferir, ou `null` para soltar. */
  static async assign(req, res) {
    try {
      const conversation = await WaConversationService.get(req.params?.id);
      await WaAssignmentService.transfer(conversation, req.body?.userId ?? null);
      return res.json(createResponse(
        req.t('whatsapp.conversationAssigned'),
        await WaConversationService.decorate(await WaConversationService.get(conversation.id))
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.conversationStatusFailed');
    }
  }

  /** `PUT /conversations/:id/tags` — troca o conjunto de etiquetas da conversa. */
  static async setTags(req, res) {
    try {
      const conversation = await WaConversationService.get(req.params?.id);
      await WaTagService.setConversationTags(conversation.id, req.body?.tagIds);
      return res.json(createResponse(
        req.t('whatsapp.tags.saved'),
        await WaConversationService.decorate(await WaConversationService.get(conversation.id))
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.conversationStatusFailed');
    }
  }

  static async listTags(req, res) {
    try {
      return res.json(createResponse(req.t('whatsapp.configLoaded'), await WaTagService.list()));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configLoadFailed');
    }
  }

  static async tagsReport(req, res) {
    try {
      return res.json(createResponse(req.t('whatsapp.configLoaded'), await WaTagService.report({ days: Number(req.query?.days) })));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configLoadFailed');
    }
  }

  static async createTag(req, res) {
    try {
      const tag = await WaTagService.create({ name: req.body?.name, color: req.body?.color });
      return res.status(201).json(createResponse(req.t('whatsapp.tags.saved'), tag));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configSaveFailed');
    }
  }

  static async updateTag(req, res) {
    try {
      const tag = await WaTagService.update(req.params?.id, { name: req.body?.name, color: req.body?.color });
      return res.json(createResponse(req.t('whatsapp.tags.saved'), tag));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configSaveFailed');
    }
  }

  static async deleteTag(req, res) {
    try {
      await WaTagService.remove(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.tags.deleted'), null));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configSaveFailed');
    }
  }

  /**
   * `GET /waiting` — quem espera gente há mais que o limite da regra
   * "Cliente esperando". O painel avisa mesmo com os alertas da equipe
   * desligados; fora do horário de atendimento a lista vem vazia.
   */
  static async listWaiting(req, res) {
    try {
      const settings = await WaAlertService.getSettings();
      const threshold = Math.max(1, Number(settings.rules?.wa_waiting?.threshold) || 15);
      const withinHours = await WaBotConfigService.withinHours(new Date());
      const items = withinHours ? await WaResponseTimeService.waitingNow({ minMinutes: threshold }) : [];
      return res.json(createResponse(req.t('whatsapp.configLoaded'), { thresholdMinutes: threshold, withinHours, items }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configLoadFailed');
    }
  }

  /** `GET /conversations/:id` — uma conversa, como a lista a desenha (o link da notificação). */
  static async getConversation(req, res) {
    try {
      const conversation = await WaConversationService.get(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.conversationsLoaded', { count: 1 }), await WaConversationService.decorate(conversation)));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.conversationsLoadFailed');
    }
  }

  /** `GET /ai/status` — se o botão "Sugerir (IA)" aparece para quem atende. */
  static async aiStatus(req, res) {
    try {
      const ai = await WaBotConfigService.aiSettings();
      return res.json(createResponse(req.t('whatsapp.configLoaded'), { suggest: Boolean(ai.suggest && ai.apiKey), templates: Boolean(ai.apiKey) }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configLoadFailed');
    }
  }

  /** `POST /conversations/:id/suggest-reply` — um rascunho da IA; nada é enviado. */
  static async suggestReply(req, res) {
    try {
      const result = await WaAiService.suggest(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.ai.suggested'), result));
    } catch (error) {
      if (String(error?.code || '').startsWith('ai_')) return aiError(req, res, error);
      return handleError(req, res, error, 'whatsapp.ai.error.failed');
    }
  }

  /** `GET /notifications?after=<id>` — mensagens novas para o sino do navegador. */
  static async listNotifications(req, res) {
    try {
      return res.json(createResponse(
        req.t('whatsapp.configLoaded'),
        await WaNotificationService.since({ userId: req.user?.userId ?? null, after: req.query?.after })
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configLoadFailed');
    }
  }

  /** `GET /agents` — a equipe, quem está disponível e quantas conversas tem. */
  static async listAgents(req, res) {
    try {
      return res.json(createResponse(req.t('whatsapp.configLoaded'), await WaAssignmentService.listAgents()));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configLoadFailed');
    }
  }

  /** `POST /agents/me` — o interruptor "Disponível", que a tela reenvia como pulso. */
  static async setAvailability(req, res) {
    try {
      return res.json(createResponse(
        req.t('whatsapp.configSaved'),
        await WaAssignmentService.setAvailability(req.user.userId, req.body?.available === true)
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configSaveFailed');
    }
  }

  static async setStatus(req, res) {
    const status = req.body?.status;
    if (status !== 'open' && status !== 'closed') {
      // With a machine `code`, like every other refusal here: a screen that
      // translates codes cannot translate a bare message, and this route was
      // the only one in the WhatsApp surface answering without one.
      return res.status(400).json(createErrorResponse(
        req.t('whatsapp.error.invalidConversationStatus'),
        null,
        'invalid_conversation_status'
      ));
    }
    try {
      const conversation = await WaConversationService.setStatus(req.params?.id, status, { userId: req.user?.userId ?? null });
      return res.json(createResponse(
        req.t(status === 'closed' ? 'whatsapp.conversationClosed' : 'whatsapp.conversationReopened'),
        conversation
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.conversationStatusFailed');
    }
  }

  /**
   * Says, by hand, which SGP subscriber a thread belongs to.
   *
   * `savePhone` writes the thread's number onto the contract as its manual
   * phone — the same write as the billing screen's number correction — so it
   * asks for the same `campaigns.manage` that route asks for. Linking alone is
   * inbox work and stays `whatsapp.send`, like the route.
   */
  static async linkSubscriber(req, res) {
    const savePhone = req.body?.savePhone === true;
    if (savePhone && !roleHas(req.user?.role, 'campaigns.manage')) {
      return res.status(403).json({
        message: req.t('auth.insufficientPermissions'),
        code: 'missing_permission'
      });
    }
    try {
      const conversation = await WaConversationService.linkSubscriber(req.params?.id, {
        contract: req.body?.contract,
        savePhone
      });
      return res.json(createResponse(req.t('whatsapp.subscriberLinked'), conversation));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.subscriberLinkFailed');
    }
  }

  /** The SGP's subscribers as contacts, with the thread each one already has. */
  static async listContacts(req, res) {
    try {
      const data = await WaContactService.list({
        search: req.query?.search,
        limit: req.query?.limit,
        offset: req.query?.offset,
        state: req.query?.state,
        noPhone: req.query?.noPhone === 'true',
        imported: req.query?.imported === 'true',
        device: String(req.query?.device ?? '')
      });
      return res.json(createResponse(
        req.t('whatsapp.contactsLoaded', { count: data.contacts.length }),
        data
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.contactsLoadFailed');
    }
  }

  /**
   * Asks the SGP for a subscriber by CPF/CNPJ or contract — the way to reach
   * one the panel has no ONT for. What it finds becomes a contact.
   */
  static async lookupContacts(req, res) {
    try {
      const data = await WaContactService.lookupSgp(req.body?.search);
      return res.json(createResponse(
        req.t('whatsapp.contactsLoaded', { count: data.contacts.length }),
        data
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.contactsLoadFailed');
    }
  }

  /** The thread with one subscriber — the existing one, or a new empty one. */
  static async openContactConversation(req, res) {
    try {
      const phone = typeof req.body?.phone === 'string' ? req.body.phone : null;
      const { conversation, created } = await WaContactService.openConversation(req.params?.contract, { phone });
      return res.status(created ? 201 : 200).json(createResponse(
        req.t('whatsapp.conversationOpened'),
        conversation
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.conversationOpenFailed');
    }
  }

  static async send(req, res) {
    try {
      const body = req.body ?? {};
      const message = await WaSendService.enqueue({
        conversationId: req.params.id,
        body: body.body,
        attachment: body.attachment,
        isNote: body.isNote === true,
        // Modelo aprovado da Meta, para responder fora da janela de 24 h num
        // número oficial. Conferido no enqueue contra o número que envia.
        metaTemplate: body.metaTemplate,
        replyToId: body.replyToId ?? null,
        userId: req.user?.userId ?? null,
        // Said rather than left to the default: this route is the one place a
        // human is demonstrably behind the message, and the row should say so
        // in its own right and not only by having a `sentBy`.
        source: 'operator'
      });
      return res.status(201).json(createResponse(
        req.t('whatsapp.messageQueued'),
        WaSendService.publicMessage(message)
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.messageSendFailed');
    }
  }

  /** `POST /messages/:id/reaction` — `{ emoji }`; vazio tira a reação. */
  static async react(req, res) {
    try {
      const message = await WaMessageActionService.react(req.params?.id, req.body?.emoji);
      return res.json(createResponse(req.t('whatsapp.messageReacted'), WaSendService.publicMessage(message)));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.messageActionFailed');
    }
  }

  /** `POST /messages/:id/delete` — apaga para todos (nossa) ou some do painel (do cliente). */
  static async remove(req, res) {
    try {
      const message = await WaMessageActionService.remove(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.messageDeleted'), WaSendService.publicMessage(message)));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.messageActionFailed');
    }
  }

  /**
   * `POST /messages/:id/requeue` — one failed row, back in the queue as itself.
   *
   * Every eligibility question is `WaMessage.requeue`'s to answer, and it
   * answers all of them with the same null: the row is another provider's, or
   * the id is not a row at all, or the row is not `failed`. Those are one
   * sentence to the operator and must stay one — telling them apart would tell
   * a prober which ids exist, and the person at the panel can do nothing
   * different about any of the three.
   *
   * A row that is not `failed` is a 409 rather than a shrug: two operators
   * looking at the same red bubble will both press, and the second one has to
   * be told the message is already on its way rather than watching a button do
   * nothing.
   */
  static async requeue(req, res) {
    const id = Number(req.params?.id);
    const refuse = () => res.status(409).json(createErrorResponse(
      req.t('whatsapp.messageNotRequeueable'),
      null,
      'message_not_requeueable'
    ));

    if (!Number.isInteger(id) || id <= 0) return refuse();

    try {
      const message = await WaMessage.requeue(id);
      if (!message) return refuse();
      return res.json(createResponse(
        req.t('whatsapp.messageRequeued'),
        WaSendService.publicMessage(message)
      ));
    } catch (error) {
      return handleError(req, res, error, 'common.internalError');
    }
  }

  /**
   * `POST /messages/requeue-failed` — every failure inside a window, at once.
   *
   * IN THE SCOPE OF THE PROVIDER WHO ASKED, and nobody else's. The model's
   * `tdb` puts the provider the resolver opened into the WHERE, which is the
   * whole reason this is safe: the deployment-wide version of this statement
   * would let an admin at one ISP put another ISP's queue back on the wire,
   * which is the exact bug wave 8 fixed on the media sweep button.
   *
   * The statement itself is `WaMessage.requeueFailedSince` rather than a query
   * written here, so the patch and the `failed`-only rule have one definition
   * shared with the single-row path. This controller decides only the window.
   *
   * One statement rather than a loop over `WaMessage.requeue`, because the case
   * this exists for is thousands of rows and thousands of round trips is not a
   * recovery. The patch below is deliberately the same one that method applies
   * — cleared error, cleared claim, attempts back to zero and `next_attempt_at`
   * NULL for "due now" — and the WHERE carries the same per-row rule it does,
   * so a `sent` row cannot be swept up here either.
   *
   * The window is measured on `created_at` and not on when the row failed: it
   * is the column the index `(delivery_status, created_at)` sorts by, so this
   * is a seek instead of a scan over every failure the panel ever had, and it
   * is the same column `failed24h` counts — the figure the operator read before
   * pressing.
   */
  static async requeueFailed(req, res) {
    const asked = Number(req.body?.hours);
    // An absent or unparsable `hours` is the ceiling and anything under an hour
    // is an hour — a clamp rather than a 400, because the screen sends one
    // fixed value and an operator recovering a campaign is owed the recovery
    // instead of a form error. Both ends of the clamp fail towards a window the
    // operator could have asked for.
    const hours = Number.isFinite(asked)
      ? Math.min(Math.max(Math.floor(asked), 1), MAX_REQUEUE_HOURS)
      : MAX_REQUEUE_HOURS;

    try {
      const requeued = await WaMessage.requeueFailedSince(
        new Date(Date.now() - hours * HOUR_MS)
      );

      // Zero is a real answer and comes back as one: nothing failed inside the
      // window is not the same as a button that did not work, and the count is
      // the only thing that separates them on screen.
      return res.json(createResponse(
        req.t('whatsapp.messagesRequeued', { count: requeued }),
        { requeued }
      ));
    } catch (error) {
      return handleError(req, res, error, 'common.internalError');
    }
  }
}

export default WhatsAppMessageController;
