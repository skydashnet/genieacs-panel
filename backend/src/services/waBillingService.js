import WaMetaTemplateService from './waMetaTemplateService.js';
import SgpService, { SgpError } from './sgpService.js';
import BillingStatusService from './billingStatusService.js';
import SgpLink from '../models/SgpLink.js';
import SgpContact from '../models/SgpContact.js';
import { whatsappPhoneOf } from './contactProfileService.js';
import WaBroadcast from '../models/WaBroadcast.js';
import WaOptOut from '../models/WaOptOut.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WaTemplateService from './waTemplateService.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';
import { currentTenantId } from '../config/tenantContext.js';
import {
  chaveDaFatura,
  comoDataBr,
  diasEntre,
  maisAntigaEmAberto,
  modeloEhLembrete,
  renderCobranca,
  variaveisDeCobranca,
  variaveisVazias
} from '../utils/wa/waCobranca.js';

/**
 * Pause between two SGP calls.
 *
 * The provider's SGP is a production billing system that is, at the same
 * moment, answering the phone menu real subscribers are calling. A campaign
 * build is one round trip per recipient; hammering it would degrade the URA for
 * people who are on the line right now.
 */
const SGP_PACE_MS = 150;

/** Recipients one campaign may carry. */
export const MAX_RECIPIENTS = 300;

/** How many campaign builds are allowed, and over what window. */
const BUILD_WINDOW_MS = 5 * 60 * 1000;
const MAX_BUILDS_PER_WINDOW = 3;

/** Default window for the overdue listing, in days past the due date. */
const DEFAULT_DAYS_MIN = 1;
const DEFAULT_DAYS_MAX = 90;
const DEFAULT_LIST_LIMIT = 50;

/** `wa_broadcasts.title` is 200 characters wide. */
const TITLE_LIMIT = 200;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Turning the SGP's invoices into WhatsApp campaigns.
 *
 * Two rules shape everything below, and neither is a matter of operator
 * discipline:
 *
 * 1. **Building a campaign never sends.** `buildCampaign` writes a `draft` and
 *    stops. Messaging hundreds of people must not be the side effect of a click
 *    on a listing screen — an operator opens the campaign, reads the rendered
 *    bodies, and presses start.
 *
 * 2. **Skips are counted by reason.** "412 skipped" tells an operator nothing.
 *    "83 with no mobile on record, 12 asked not to be contacted" tells them what
 *    to fix, and which of the two problems is theirs.
 */
class WaBillingService {
  /**
   * Os instantes das montagens de campanha na última janela, POR PROVEDOR.
   *
   * Um campo de classe em vez de um middleware, a mesma forma que o
   * `waOutboxWorker` usa para o teto dele: o que se limita é o custo para o
   * ERP do provedor (uma ida e volta por destinatário), não a taxa de
   * requisições de um navegador.
   *
   * A chave por provedor é o conserto. Era um array só, compartilhado pelo
   * processo inteiro: o provedor A montava três campanhas e os provedores B, C
   * e D levavam 429 por cinco minutos sem terem feito nada. Negação de serviço
   * cruzada, trivial de disparar, num painel que vende isolamento.
   *
   * É exatamente a classe de defeito que `config/tenantCache.js` documenta como
   * já corrigida em quatro serviços — "deixou de estar certo no momento em que
   * a configuração passou a ser por provedor". Este teto ficou de fora daquela
   * passagem.
   */
  static buildWindows = new Map();

  /**
   * Subscribers the billing cadence could contact.
   *
   * The window is SYMMETRIC around the due date: `daysOverdue` is positive for
   * an invoice that has come due and negative for one that has not, so
   * `daysMin: -5` reads as "including anyone due within the next five days".
   * One scale for both directions is what lets the same screen prepare a
   * dunning run and a reminder run.
   */
  static async listOverdue({ daysMin, daysMax, search, limit } = {}) {
    // Checked once, up front: with the integration off there is nothing to
    // list, and finding that out one contract at a time would look like every
    // subscriber having been refused.
    SgpService.requireReady(await SgpService.getConfig());

    const min = Number.isFinite(Number(daysMin)) ? Math.trunc(Number(daysMin)) : DEFAULT_DAYS_MIN;
    const max = Number.isFinite(Number(daysMax)) ? Math.trunc(Number(daysMax)) : DEFAULT_DAYS_MAX;
    const cap = Math.min(Math.max(Number(limit) || DEFAULT_LIST_LIMIT, 1), MAX_RECIPIENTS);
    const needle = String(search ?? '').trim().toLowerCase();

    const subscribers = (await this.subscribers())
      .filter((row) => !needle || [row.contract, row.clientName, row.phone]
        .some((field) => String(field ?? '').toLowerCase().includes(needle)))
      .slice(0, cap);

    const hoje = new Date();
    const found = [];
    for (const subscriber of subscribers) {
      // eslint-disable-next-line no-await-in-loop -- the pace IS the point; see SGP_PACE_MS
      const invoices = await this.pacedInvoices(subscriber.contract, found.length > 0);
      if (invoices === null) continue; // the SGP refused this contract; not a reason to stop
      // `true` so the listing shows the next invoice to fall due as well: at
      // this stage nobody has chosen a template, so the screen must be able to
      // show both a dunning candidate and a reminder candidate.
      const { fatura } = maisAntigaEmAberto(invoices, hoje, true);
      if (!fatura) continue;
      const days = diasEntre(fatura.dueDate, hoje);
      if (days === null || days < min || days > max) continue;
      found.push({
        contract: subscriber.contract,
        clientName: subscriber.clientName,
        document: subscriber.document,
        phone: subscriber.phone,
        phoneSource: subscriber.phoneSource,
        deviceId: subscriber.deviceId,
        amount: fatura.amount ?? null,
        dueDate: fatura.dueDate || null,
        daysOverdue: days
      });
    }
    return found;
  }

  /**
   * Builds a campaign and returns it as a DRAFT.
   *
   * Nothing here sends, and nothing here queues: the outbox never sees a
   * message until an operator moves the campaign to `running`.
   *
   * @returns {Promise<{ broadcast: object, recipients: number, skipped: object }>}
   */
  static async buildCampaign({ template, contracts, title, userId = null } = {}) {
    // Reserved on the ATTEMPT, not on success: the cost being limited is the
    // round trips, and a build that ends with nobody to contact spent them too.
    this.reserveBuild();

    const { body, templateId, name, template: stored } = await WaTemplateService.resolveBody(template);
    const wanted = [...new Set(
      (Array.isArray(contracts) ? contracts : [])
        .map((entry) => String(entry ?? '').trim())
        .filter(Boolean)
    )];

    const skipped = {
      noPhone: 0,
      optOut: 0,
      noInvoice: 0,
      futureOnly: 0,
      sgpRefused: 0,
      templateIncomplete: 0,
      // Which variables the `templateIncomplete` ones lacked: `{ pix: 12 }`.
      missing: {}
    };

    if (wanted.length === 0) {
      throw noRecipients(skipped);
    }
    if (wanted.length > MAX_RECIPIENTS) {
      throw new WaError('whatsapp.error.tooManyRecipients', {
        code: 'too_many_recipients',
        status: 400,
        vars: { max: MAX_RECIPIENTS }
      });
    }
    SgpService.requireReady(await SgpService.getConfig());

    const wantedSet = new Set(wanted);
    const byContract = new Map(
      (await this.subscribers({ contracts: [...wantedSet] }))
        .map((row) => [row.contract, row])
    );

    // A contract the panel has never linked to an ONT has no phone anywhere, so
    // it lands in the same bucket as one whose cadastre is blank. From the
    // operator's side both mean the same thing: no mobile on record.
    const withPhone = [];
    for (const contract of wanted) {
      const subscriber = byContract.get(contract);
      if (!subscriber?.phone) skipped.noPhone += 1;
      else withPhone.push(subscriber);
    }

    // ONE query for the whole campaign. Asking per recipient would be hundreds
    // of round trips to answer a question a single `IN` answers.
    const blocked = await WaOptOut.activePhones(withPhone.map((row) => row.phone), 'billing');
    const reachable = withPhone.filter((row) => {
      if (!blocked.has(row.phone)) return true;
      skipped.optOut += 1;
      return false;
    });

    // The template declares itself: citing `{{dias_para_vencer}}` is what makes
    // a body a reminder, and only a reminder may pick an invoice that has not
    // come due. See the header of utils/wa/waCobranca.js.
    const lembrete = modeloEhLembrete(body);
    const hoje = new Date();
    const recipients = [];
    let calls = 0;

    for (const subscriber of reachable) {
      // eslint-disable-next-line no-await-in-loop -- one round trip per recipient, paced on purpose
      const invoices = await this.pacedInvoices(subscriber.contract, calls++ > 0);
      if (invoices === null) {
        skipped.sgpRefused += 1;
        continue;
      }
      const { fatura, soFuturas } = maisAntigaEmAberto(invoices, hoje, lembrete);
      if (!fatura) {
        // Two different facts, counted apart: "owes nothing" is good news and
        // "owes something that has not come due yet" is a reason to send a
        // reminder template instead.
        if (soFuturas) skipped.futureOnly += 1;
        else skipped.noInvoice += 1;
        continue;
      }
      const vars = variaveisDeCobranca(fatura, subscriber.clientName, hoje);
      const rendered = renderCobranca(body, vars);
      // A null render means a variable the body cites has no value. The
      // recipient is DROPPED — never sent a partial message. "PIX: " with
      // nothing after it tells a subscriber to pay a placeholder.
      if (rendered === null) {
        skipped.templateIncomplete += 1;
        for (const name of variaveisVazias(body, vars)) skipped.missing[name] = (skipped.missing[name] || 0) + 1;
        continue;
      }
      // O modelo da Meta do número oficial, com as mesmas variáveis.
      const metaTemplate = WaMetaTemplateService.buildPayload(stored, vars, rendered);
      if (metaTemplate?.incomplete) {
        skipped.templateIncomplete += 1;
        for (const name of metaTemplate.incomplete) skipped.missing[name] = (skipped.missing[name] || 0) + 1;
        continue;
      }
      recipients.push({
        contract: subscriber.contract,
        clientName: subscriber.clientName,
        phone: subscriber.phone,
        body: rendered,
        metaTemplate,
        // The invoice the message cites, so the flush can check it was not
        // paid while the campaign sat in draft.
        invoiceKey: chaveDaFatura(fatura),
        dueDate: fatura.dueDate ? String(fatura.dueDate).slice(0, 10) : null
      });
    }

    if (recipients.length === 0) throw noRecipients(skipped);

    const config = await WhatsAppConfigService.getConfig();
    const account = await WhatsAppAccount.getForPurpose('billing');
    const broadcast = await WaBroadcast.create({
      title: String(title || name || `Cobrança ${comoDataBr(hoje)}`).trim().slice(0, TITLE_LIMIT),
      template_id: templateId,
      body,
      // Recorded as the intended sender, not as a commitment: the flush loop
      // resolves the number again at send time, because a campaign can sit in
      // draft for a day and numbers reconnect.
      account_id: account?.id ?? null,
      status: 'draft',
      rate_limit_per_min: config.rateLimitPerMin,
      total_count: recipients.length,
      created_by: userId
    });
    await WaBroadcast.addRecipients(broadcast.id, recipients);

    return { broadcast, recipients: recipients.length, skipped };
  }

  /**
   * One SGP round trip, paced.
   *
   * Live rather than from a snapshot on purpose: a boleto that was reissued has
   * a new digitable line and a new PIX code, and a message carrying the old one
   * sends the subscriber to a bank that will refuse it.
   *
   * @returns {Promise<object[]|null>} null when the SGP refused this contract
   */
  static async pacedInvoices(contract, pace = true) {
    if (pace) await sleep(SGP_PACE_MS);
    try {
      const { invoices } = await SgpService.listInvoices({ contract, onlyOpen: true });
      // A foto da situação (em dia, vence hoje, atrasado) sai de graça daqui:
      // a régua, a conferência na saída e a atualização da lista passam por este caminho.
      await BillingStatusService.record(contract, invoices);
      return invoices;
    } catch (error) {
      // One refused contract is a fact about that contract — an unknown
      // customer, a cadastre in a state the ERP will not answer for. It must
      // not end the run for everybody else.
      if (error instanceof SgpError) return null;
      throw error;
    }
  }

  /**
   * Sets or clears the operator's correction to a subscriber's number.
   *
   * The whole billing cadence hangs off this one field. A number the ERP has
   * wrong does not announce itself: the subscriber lands in `noPhone` — or,
   * worse, someone else's phone rings — quietly, campaign after campaign, and
   * until now the only way to fix it was an UPDATE typed against the database.
   *
   * An empty `phone` CLEARS the override and hands the contract back to
   * whatever the last sync wrote. That is a real operation and not a malformed
   * request: an operator who mistyped a correction has to be able to undo it
   * without inventing a number, and the ERP's own record is the fallback the
   * reader already prefers when there is no manual one.
   *
   * @returns {Promise<object>} the subscriber as the listing shows them, minus
   *   the invoice fields — those cost an SGP round trip and nothing about this
   *   write can have changed them.
   */
  static async setSubscriberPhone(contract, phone) {
    const key = String(contract ?? '').trim();
    // Read before write: `update` reports rows touched, which on a contract
    // that does not exist and on one whose number is already the typed value
    // is the same zero. Only one of those is a 404.
    // The contract may live in either table: linked to an ONT (`sgp_links`)
    // or known only from the SGP sync (`sgp_contacts`). Either one is enough.
    const existing = key ? await SgpLink.getByContract(key) : [];
    const contact = key ? await SgpContact.getByContract(key) : null;
    if (existing.length === 0 && !contact) {
      throw new WaError('whatsapp.error.subscriberNotFound', {
        code: 'subscriber_not_found',
        status: 404
      });
    }

    const wanted = String(phone ?? '').trim();
    const digits = wanted ? normalizarTelefoneBr(wanted) : '';
    // Only a non-empty entry can be invalid. `normalizarTelefoneBr` refuses
    // rather than guessing — it never invents the ninth digit — so what it
    // rejects here is a number that could not be dialled, not one it is unsure
    // about.
    if (wanted && !digits) {
      throw new WaError('whatsapp.error.invalidPhone', { code: 'invalid_phone', status: 400 });
    }

    // Stored normalised, in the form a send actually uses. Keeping "(93)
    // 98111-0449" would leave the correction looking right on screen and
    // matching nothing at dispatch time — the same failure the do-not-disturb
    // list normalises on the way in to avoid.
    //
    // Written to BOTH rows the contract has. The reader (`whatsappPhoneOf`)
    // prefers the contact's manual number over the link's, the same order the
    // Contacts screen uses — so a correction written to the link alone would
    // lose to an older one typed on the contact page, and look ignored.
    if (existing.length > 0) await SgpLink.setManualPhone(key, digits || null);
    if (contact) await SgpContact.setManualPhone(key, digits || null);

    const [subscriber] = await this.subscribers({ contracts: [key] });
    return subscriber;
  }

  /**
   * Every subscriber the billing cadence can reach, one per contract.
   *
   * Two sources, because the panel knows a subscriber from two places:
   * `sgp_links` — a contract tied to an ONT — and `sgp_contacts` — every
   * client the SGP sync brought in, with or without an ONT on this panel.
   * Reading only the first was the bug: most links carry no phone (the number
   * lives on the synced contact), so subscribers whose mobile the Contacts
   * screen shows landed in `noPhone`, and a contract with no ONT here was never
   * considered at all.
   *
   * The number is chosen by `whatsappPhoneOf`, the same function and the same
   * order the Contacts screen uses, so the cadence can never disagree with what
   * the operator sees on the subscriber's page.
   *
   * @param {{ contracts?: string[] }} [options] restrict to these contracts
   */
  static async subscribers({ contracts } = {}) {
    let links;
    let contacts;
    if (Array.isArray(contracts)) {
      const wanted = [...new Set(contracts.map((c) => String(c ?? '').trim()).filter(Boolean))];
      if (wanted.length === 0) return [];
      links = [];
      contacts = [];
      // Chunked: an `IN` list has a ceiling on every engine, and a campaign
      // can name hundreds of contracts.
      for (let i = 0; i < wanted.length; i += 200) {
        const chunk = wanted.slice(i, i + 200);
        // eslint-disable-next-line no-await-in-loop -- a handful of chunks
        links.push(...await SgpLink.getByContracts(chunk));
        // eslint-disable-next-line no-await-in-loop -- idem
        contacts.push(...await SgpContact.getByContracts(chunk));
      }
    } else {
      links = await SgpLink.getAll();
      contacts = await SgpContact.listWithContract();
    }
    return this.subscribersFrom(links, contacts);
  }

  /**
   * `sgp_links` and `sgp_contacts` rows as subscribers, one per contract.
   *
   * Links come first, so the order a listing shows is the one it always had;
   * contracts known only from the SGP sync follow. The phone of each is
   * `whatsappPhoneOf(link, contact)`: the operator's correction wins over the
   * ERP's number, and the contact's over the link's.
   */
  static subscribersFrom(links, contacts = []) {
    const contactByContract = new Map();
    for (const contact of contacts || []) {
      const contract = String(contact.contract ?? '').trim();
      if (contract && !contactByContract.has(contract)) contactByContract.set(contract, contact);
    }

    const byContract = new Map();
    const add = (contract, link, contact) => {
      const { phone, phoneSource } = whatsappPhoneOf(link, contact);
      byContract.set(contract, {
        contract,
        clientName: link?.client_name || contact?.client_name || null,
        document: link?.document || contact?.document || null,
        deviceId: link?.device_id || null,
        phone,
        phoneSource
      });
    };

    for (const link of links || []) {
      const contract = String(link.contract ?? '').trim();
      if (!contract || byContract.has(contract)) continue;
      add(contract, link, contactByContract.get(contract) || null);
    }
    for (const [contract, contact] of contactByContract) {
      if (!byContract.has(contract)) add(contract, null, contact);
    }
    return [...byContract.values()];
  }

  // ── The build ceiling ──────────────────────────────────────────────

  static reserveBuild() {
    const tenantId = currentTenantId();
    const cutoff = Date.now() - BUILD_WINDOW_MS;
    const janela = (this.buildWindows.get(tenantId) || []).filter((at) => at > cutoff);

    if (janela.length >= MAX_BUILDS_PER_WINDOW) {
      // A janela podada volta para o mapa mesmo na recusa: sem isso, um
      // provedor que insiste mantém entradas velhas vivas para sempre.
      this.buildWindows.set(tenantId, janela);
      throw new WaError('whatsapp.error.rateLimited', { code: 'rate_limited', status: 429 });
    }

    janela.push(Date.now());
    this.buildWindows.set(tenantId, janela);
  }

  /** Esquece a janela de um provedor. Existe para o teste, e para o `stop`. */
  static resetBuildWindow(tenantId = currentTenantId()) {
    this.buildWindows.delete(tenantId);
  }
}

/**
 * Nobody left to contact.
 *
 * The counts ride along on the error because they are the answer the operator
 * actually needs: the build failing is not news, "every one of them is on the
 * do-not-disturb list" is.
 */
function noRecipients(skipped) {
  const error = new WaError('whatsapp.error.noRecipients', {
    code: 'no_recipients',
    status: 409
  });
  error.skipped = skipped;
  return error;
}

export default WaBillingService;
