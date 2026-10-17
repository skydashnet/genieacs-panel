import WaConversation from '../models/WaConversation.js';
import { optOutOf } from '../utils/wa/waOptOutTipos.js';
import WaOptOut from '../models/WaOptOut.js';
import SgpLink from '../models/SgpLink.js';
import SgpContact from '../models/SgpContact.js';
import ContactProfileService, { whatsappPhoneOf } from './contactProfileService.js';
import SgpService from './sgpService.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import CustomerAccount from '../models/CustomerAccount.js';
import { WaError } from './whatsappConfigService.js';
import WaBillingService from './waBillingService.js';
import WaConversationService from './waConversationService.js';
import { tdb } from '../config/database.js';
import { normalizarTelefoneBr, variantesTelefoneBr } from '../utils/wa/waDestino.js';

/** The page the screen asks for, and the most it may ask for. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * How many `sgp_links` rows one listing reads before collapsing them into
 * subscribers. A contract can cover several ONTs, so paging by row would split
 * a subscriber across two pages; reading a bounded window and paging the
 * collapsed list keeps one subscriber per line at the cost of a ceiling that a
 * search narrows long before anyone reaches it.
 */
const ROW_CEILING = 5000;

/**
 * The same ceiling for `sgp_contacts`, which the full sync fills with every
 * client of the SGP. Only the columns the list draws are read, so even this
 * many rows is a few megabytes, once per request.
 */
const CONTACT_CEILING = 50_000;

/** What the status filter accepts. `none` is a client with no contract. */
export const CONTACT_STATES = Object.freeze(['active', 'blocked', 'cancelled', 'unknown', 'none']);

const CONTACT_KEY = /^c:(\d+)$/;

/**
 * How a contact is addressed from the browser: its contract when it has one,
 * `c:<row id>` when it does not. The route parameter and the link body take
 * either.
 */
export function contactKey(subscriber) {
  return subscriber.contract ? String(subscriber.contract) : `c:${subscriber.contactId}`;
}

/** CPF/CNPJ on screen as its last digits only — the search still sees all of it. */
function maskDocument(document) {
  const digits = String(document ?? '').replace(/\D/g, '');
  if (!digits) return null;
  return `•••${digits.slice(-4)}`;
}

/**
 * The SGP's subscribers as WhatsApp contacts.
 *
 * The inbox knew a subscriber only after they wrote in. This is the other
 * direction: the operator looks a subscriber up — by name, contract, document
 * or number — sees whether there is already a thread with them, and opens one
 * when there is not.
 *
 * Two directories, both read through `tdb` because two providers can hold the
 * same contract number and neither may see the other's subscriber here:
 * `sgp_links`, the mirror of the ERP per ONT, and `sgp_contacts`, the
 * subscribers an operator looked up in the SGP that have no ONT in the panel.
 */
/** "With" or "without" a managed ONT linked to the contract. */
const DEVICE_FILTERS = ['with', 'without'];

class WaContactService {
  static async list({ search = '', limit = DEFAULT_LIMIT, offset = 0, state = '', noPhone = false, imported = false, device = '' } = {}) {
    const size = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const skip = Math.max(Number(offset) || 0, 0);
    const everyone = await this.gather({ search });
    const subscribers = this.narrow(everyone, { state, noPhone, imported, device });
    const page = await this.withEditedNames(subscribers.slice(skip, skip + size));
    return {
      total: subscribers.length,
      counts: this.counts(everyone, { state, noPhone, imported, device }),
      contacts: await this.decorate(page)
    };
  }

  /**
   * Every subscriber the list would show for this search and state, in its
   * order and unpaged — the list pages it, the spreadsheet export takes it all.
   *
   * `noPhone` keeps only who has no number the panel could message — the same
   * "Sem telefone" the list shows, after the record's number filled the gap.
   * It combines with `state`: "active with no phone" is the list to fix first.
   *
   * `imported` keeps only the clients that came from an import (the connected
   * WhatsApp's phone book or a spreadsheet), which no SGP row backs.
   *
   * `device` is `with` or `without` a managed ONT linked to the contract.
   */
  static async collect({ search = '', state = '', noPhone = false, imported = false, device = '' } = {}) {
    return this.narrow(await this.gather({ search }), { state, noPhone, imported, device });
  }

  /**
   * Everyone the search matches, sorted, before any state, phone or origin
   * filter — the one expensive read, so the list can both filter it and count
   * it for the filter buttons without asking the database twice.
   */
  static async gather({ search = '' } = {}) {
    const raw = String(search ?? '').trim();

    const linkRows = await this.searchTable('sgp_links', raw);
    const linkStates = new Map(linkRows.map((row) => [String(row.contract), row.state || 'unknown']));
    const withDevice = WaBillingService.subscribersFrom(linkRows).map((subscriber) => ({
      ...subscriber,
      contactId: null,
      state: linkStates.get(subscriber.contract) || 'unknown',
      lastSeenAt: null
    }));
    await this.fillPhonesFromContacts(withDevice);
    const known = new Set(withDevice.map((s) => s.contract));
    // A contract that has an ONT is drawn from `sgp_links`, which is the
    // fresher mirror; its `sgp_contacts` row only duplicates it.
    const withoutDevice = (await this.searchTable('sgp_contacts', raw, CONTACT_CEILING))
      .filter((row) => !row.contract || !known.has(String(row.contract)))
      .map((row) => this.subscriberFromContact(row));

    return [...withDevice, ...withoutDevice]
      .sort((a, b) => (
      String(a.clientName ?? '').localeCompare(String(b.clientName ?? ''), 'pt-BR')
      || String(a.contract).localeCompare(String(b.contract))
    ));
  }

  /** The state, phone and origin filters, applied to what `gather` returned. */
  static narrow(everyone, { state = '', noPhone = false, imported = false, device = '' } = {}) {
    const wanted = CONTACT_STATES.includes(state) ? state : null;
    const linked = DEVICE_FILTERS.includes(device) ? device : null;
    return everyone
      .filter((subscriber) => !wanted || subscriber.state === wanted)
      .filter((subscriber) => !noPhone || !subscriber.phone)
      .filter((subscriber) => !imported || subscriber.importSource)
      .filter((subscriber) => !linked || (linked === 'with') === Boolean(subscriber.deviceId));
  }

  /**
   * What each filter button would show if it were clicked now, with the other
   * filters left as they are: the tabs count under the phone and origin
   * toggles, each toggle counts under the current tab — so the number on the
   * active filter is always the list's own total.
   */
  static counts(everyone, { state = '', noPhone = false, imported = false, device = '' } = {}) {
    const size = (filters) => this.narrow(everyone, filters).length;
    const tab = CONTACT_STATES.includes(state) ? state : '';
    return {
      states: {
        all: size({ noPhone, imported, device }),
        active: size({ state: 'active', noPhone, imported, device }),
        blocked: size({ state: 'blocked', noPhone, imported, device }),
        cancelled: size({ state: 'cancelled', noPhone, imported, device }),
        none: size({ state: 'none', noPhone, imported, device })
      },
      noPhone: size({ state: tab, noPhone: true, imported, device }),
      imported: size({ state: tab, noPhone, imported: true, device }),
      withDevice: size({ state: tab, noPhone, imported, device: 'with' }),
      withoutDevice: size({ state: tab, noPhone, imported, device: 'without' })
    };
  }

  /**
   * The number of each ONT subscriber as its client record shows it. The ONT
   * row often has no phone while the contacts sync brought the contract's
   * number, and the list must offer the conversation the record offers —
   * `whatsappPhoneOf` decides between the two rows, for both screens.
   */
  static async fillPhonesFromContacts(subscribers) {
    const contracts = subscribers.map((s) => String(s.contract));
    const byContract = new Map();
    for (let at = 0; at < contracts.length; at += 500) {
      // eslint-disable-next-line no-await-in-loop -- a few chunks, one query each
      const rows = await tdb('sgp_contacts')
        .whereIn('contract', contracts.slice(at, at + 500))
        .select('contract', 'phone_manual', 'phone_e164');
      for (const row of rows) byContract.set(String(row.contract), row);
    }
    for (const subscriber of subscribers) {
      const contact = byContract.get(String(subscriber.contract));
      if (!contact) continue;
      const link = subscriber.phoneSource === 'manual'
        ? { phone_manual: subscriber.phone }
        : { phone_e164: subscriber.phone };
      Object.assign(subscriber, whatsappPhoneOf(link, contact));
    }
  }

  /**
   * The name an operator gave a client in its record, over the SGP's, for the
   * rows of one page. The search still matches the SGP's name.
   */
  static async withEditedNames(page) {
    if (page.length === 0) return page;
    const contracts = page.map((s) => s.contract).filter(Boolean).map(String);
    const ids = page.filter((s) => !s.contract && s.contactId).map((s) => s.contactId);
    const rows = await tdb('sgp_contacts').where((match) => {
      match.whereRaw('1 = 0');
      if (contracts.length > 0) match.orWhereIn('contract', contracts);
      if (ids.length > 0) match.orWhereIn('id', ids);
    }).select('id', 'contract', 'sgp_client_id', 'client_ref');
    const names = await ContactProfileService.editedNames(rows);
    if (names.size === 0) return page;
    return page.map((subscriber) => {
      const row = rows.find((entry) => (subscriber.contract
        ? String(entry.contract) === String(subscriber.contract)
        : Number(entry.id) === Number(subscriber.contactId)));
      const name = row ? names.get(row.client_ref || (!row.contract ? row.sgp_client_id : null)) : null;
      return name ? { ...subscriber, clientName: name } : subscriber;
    });
  }

  /**
   * One of the two directories, filtered by what the operator typed. The two
   * tables share every column the search reads, on purpose.
   */
  static async searchTable(table, raw, ceiling = ROW_CEILING) {
    const query = tdb(table);
    const term = WaConversation.likeTerm(raw);
    if (raw) {
      const like = `%${term}%`;
      const digits = term.replace(/\D/g, '');
      query.where((match) => {
        // Same rule as the inbox: a term that stripping LIKE's wildcards
        // emptied must match nothing, not everything.
        if (!term) {
          match.whereRaw('1 = 0');
          return;
        }
        match
          .whereRaw('lower(client_name) like ?', [like])
          .orWhereRaw('lower(contract) like ?', [like]);
        if (digits) {
          match
            .orWhere('document', 'like', `%${digits}%`)
            .orWhere('phone_e164', 'like', `%${digits}%`)
            .orWhere('phone_manual', 'like', `%${digits}%`);
        }
      });
    }
    return query
      .orderBy('client_name', 'asc')
      .orderBy('contract', 'asc')
      .orderBy('id', 'asc')
      .limit(ceiling);
  }

  /** An `sgp_contacts` row in the shape `subscribersFrom` gives an `sgp_links` one. */
  static subscriberFromContact(row) {
    const manual = normalizarTelefoneBr(row.phone_manual);
    const fromSgp = normalizarTelefoneBr(row.phone_e164);
    return {
      contract: row.contract ? String(row.contract) : null,
      contactId: row.id,
      clientName: row.client_name || null,
      document: row.document || null,
      deviceId: null,
      phone: manual || fromSgp || null,
      phoneSource: manual ? 'manual' : (fromSgp ? 'sgp' : null),
      state: row.contract ? (row.state || 'unknown') : 'none',
      lastSeenAt: row.last_seen_at || null,
      importSource: row.import_source || null
    };
  }

  /**
   * The subscriber behind a contract, from whichever directory holds it: the
   * one with an ONT first, then the one found by a lookup.
   */
  static async subscriberFor(contract) {
    const key = String(contract ?? '').trim();
    if (!key) return null;
    // `c:<id>`: a client with no contract, addressed by its row.
    const byId = key.match(CONTACT_KEY);
    if (byId) {
      const contact = await SgpContact.getById(byId[1]);
      return contact ? this.subscriberFromContact(contact) : null;
    }
    const links = await SgpLink.getByContract(key);
    const contact = await SgpContact.getByContract(key);
    if (links.length > 0) {
      const subscriber = { ...WaBillingService.subscribersFrom(links)[0], contactId: null, state: links[0].state || 'unknown' };
      // The ONT's row often has no phone while the contacts sync brought the
      // contract's number (or the client record corrected it): the number is
      // the one the client record shows (`whatsappPhoneOf`).
      return { ...subscriber, ...whatsappPhoneOf(links[0], contact) };
    }
    return contact ? this.subscriberFromContact(contact) : null;
  }

  /**
   * Asks the SGP itself, for the subscriber the panel has no ONT for.
   *
   * The SGP answers by document or by contract, never by name, so the term is
   * read as a CPF (11 digits) or CNPJ (14 digits) when it is one, and as a
   * contract otherwise. What comes back is kept in `sgp_contacts` — unless the
   * contract already has an ONT, in which case `sgp_links` owns it — so that
   * the thread opened from it has a subscriber to point at, and the number
   * resolves when the subscriber writes in.
   */
  static async lookupSgp(term) {
    const raw = String(term ?? '').trim();
    const digits = raw.replace(/\D/g, '');
    if (!raw) {
      throw new WaError('whatsapp.error.lookupTermRequired', { code: 'lookup_term_required', status: 400 });
    }
    const filters = digits.length === 11 || digits.length === 14
      ? { document: digits }
      : { contract: raw };

    const found = await SgpService.lookupContacts(filters);
    const keys = [];
    for (const contract of found) {
      if ((await SgpLink.getByContract(contract.contract)).length === 0) {
        await SgpContact.upsertFromSgp(SgpService.contractToContactRow(contract));
      }
      if (!keys.includes(contract.contract)) keys.push(contract.contract);
    }

    // By document, the client listing too: it is the only lookup that finds a
    // client with NO contract, which `consultacliente` cannot. Best effort —
    // an install whose listing refuses or is unreachable still answers with
    // what the contract lookup found.
    if (filters.document) {
      let clients = [];
      try {
        clients = await SgpService.lookupClients({ document: filters.document });
      } catch (error) {
        console.warn(`SGP client listing lookup failed: ${error.code || error.message}`);
      }
      for (const client of clients) {
        if (client.contract) {
          if (keys.includes(client.contract)) continue;
          if ((await SgpLink.getByContract(client.contract)).length === 0) {
            await SgpContact.upsertFromSgp(SgpService.contractToContactRow(client));
          }
          keys.push(client.contract);
          continue;
        }
        const stored = await SgpContact.upsertFromSgp(SgpService.contractToContactRow(client));
        if (stored && !keys.includes(`c:${stored.id}`)) keys.push(`c:${stored.id}`);
      }
    }

    const subscribers = [];
    for (const key of keys) {
      const subscriber = await this.subscriberFor(key);
      if (subscriber) subscribers.push(subscriber);
    }
    return { total: subscribers.length, contacts: await this.decorate(subscribers) };
  }

  /**
   * Which of these subscribers already has a thread, and who asked not to be
   * contacted. Two batched lookups for the page, never one per row.
   */
  static async decorate(subscribers) {
    if (subscribers.length === 0) return [];
    const contracts = subscribers.map((s) => s.contract).filter(Boolean);
    const contactIds = subscribers.filter((s) => !s.contract && s.contactId).map((s) => s.contactId);
    const phones = [...new Set(subscribers.flatMap((s) => variantesTelefoneBr(s.phone)))];

    const threads = await tdb('wa_conversations')
      .where((match) => {
        match.whereRaw('1 = 0');
        if (contracts.length > 0) match.orWhereIn('contract', contracts);
        if (contactIds.length > 0) match.orWhereIn('sgp_contact_id', contactIds);
        if (phones.length > 0) match.orWhereIn('wa_phone_e164', phones);
      })
      .orderBy('last_message_at', 'desc')
      .select('id', 'contract', 'sgp_contact_id', 'wa_phone_e164', 'last_message_at', 'closed_at');
    const blocked = await WaOptOut.activeBlocks(phones);
    const sgpUrls = await this.sgpPageUrls(contracts, contactIds);

    return subscribers.map((subscriber) => {
      const spellings = variantesTelefoneBr(subscriber.phone);
      // The thread bound to the contract first: it is the one an operator
      // already confirmed. A thread matched only by number comes second.
      const thread = (subscriber.contract
        ? threads.find((row) => row.contract === subscriber.contract)
        : threads.find((row) => Number(row.sgp_contact_id) === Number(subscriber.contactId)))
        || threads.find((row) => spellings.includes(row.wa_phone_e164))
        || null;
      return {
        key: contactKey(subscriber),
        contract: subscriber.contract,
        hasContract: Boolean(subscriber.contract),
        state: subscriber.state || 'unknown',
        lastSeenAt: subscriber.lastSeenAt || null,
        importSource: subscriber.importSource || null,
        clientName: subscriber.clientName,
        document: maskDocument(subscriber.document),
        deviceId: subscriber.deviceId,
        // False for a subscriber found by a lookup: the SGP knows them, the
        // panel has no ONT of theirs.
        hasDevice: Boolean(subscriber.deviceId),
        phone: subscriber.phone,
        phoneSource: subscriber.phoneSource,
        ...optOutOf(spellings.map((phone) => blocked.get(phone)).filter((tipos) => tipos !== undefined)),
        conversationId: thread?.id ?? null,
        lastMessageAt: thread?.last_message_at ?? null,
        sgpUrl: (subscriber.contract
          ? sgpUrls.byContract.get(String(subscriber.contract))
          : sgpUrls.byId.get(Number(subscriber.contactId))) ?? null
      };
    });
  }

  /**
   * The SGP page of each client on a page of the list, from the client ids the
   * contacts sync stored — two batched reads, never one per row. A subscriber
   * the sync has not stored, or an install with the SGP off, has no link.
   */
  static async sgpPageUrls(contracts, contactIds) {
    const byContract = new Map();
    const byId = new Map();
    if (contracts.length === 0 && contactIds.length === 0) return { byContract, byId };
    const config = await SgpService.getConfig().catch(() => null);
    if (!config?.enabled) return { byContract, byId };
    const rows = await tdb('sgp_contacts')
      .where((match) => {
        match.whereRaw('1 = 0');
        if (contracts.length > 0) match.orWhereIn('contract', contracts.map(String));
        if (contactIds.length > 0) match.orWhereIn('id', contactIds);
      })
      .select('id', 'contract', 'client_ref', 'sgp_client_id');
    for (const row of rows) {
      const url = SgpService.clientPageUrl(config, row.client_ref || row.sgp_client_id);
      if (!url) continue;
      if (row.contract) byContract.set(String(row.contract), url);
      byId.set(Number(row.id), url);
    }
    return { byContract, byId };
  }

  /**
   * O nome do cliente de cada número, para a lista do "não perturbe". Procura
   * o número (nas duas grafias do nono dígito) nos dois cadastros; o do ONT
   * vence o do SGP, como na lista de contatos.
   */
  static async namesByPhone(phones) {
    const wanted = [...new Set((phones || []).filter(Boolean))];
    const names = new Map();
    if (wanted.length === 0) return names;
    const spellings = new Map();
    for (const phone of wanted) for (const variant of variantesTelefoneBr(phone)) spellings.set(variant, phone);
    const list = [...spellings.keys()];
    const take = (rows, column) => {
      for (const row of rows) {
        const phone = spellings.get(row[column]);
        if (phone && row.client_name) names.set(phone, row.client_name);
      }
    };
    for (let at = 0; at < list.length; at += 500) {
      const part = list.slice(at, at + 500);
      // eslint-disable-next-line no-await-in-loop -- poucos blocos, uma leitura cada
      take(await tdb('sgp_contacts').whereIn('phone_e164', part).select('phone_e164', 'client_name'), 'phone_e164');
      // eslint-disable-next-line no-await-in-loop
      take(await tdb('sgp_contacts').whereIn('phone_manual', part).select('phone_manual', 'client_name'), 'phone_manual');
      // eslint-disable-next-line no-await-in-loop
      take(await tdb('sgp_links').whereIn('phone_e164', part).select('phone_e164', 'client_name'), 'phone_e164');
      // eslint-disable-next-line no-await-in-loop
      take(await tdb('sgp_links').whereIn('phone_manual', part).select('phone_manual', 'client_name'), 'phone_manual');
    }
    return names;
  }

  /**
   * The thread with this subscriber: the one that exists, or a new one.
   *
   * Opening is not sending. A new thread is an empty row the operator writes
   * into; nothing leaves the panel until they press send, and then it leaves
   * through the same queue, opt-out check and all, as any other reply.
   *
   * @returns {Promise<{ conversation: object, created: boolean }>}
   */
  static async openConversation(contract, { phone = null } = {}) {
    const subscriber = await this.subscriberFor(contract);
    if (!subscriber) {
      throw new WaError('whatsapp.error.subscriberNotFound', {
        code: 'subscriber_not_found',
        status: 404
      });
    }

    // Another of the client's numbers, picked from its record. Only a number
    // the record lists: this route opens threads with subscribers, not with
    // whatever number a browser sends.
    const wanted = phone ? normalizarTelefoneBr(phone) : null;
    if (phone && !wanted) {
      throw new WaError('whatsapp.error.invalidPhone', { code: 'invalid_phone', status: 400 });
    }
    const extra = wanted && wanted !== normalizarTelefoneBr(subscriber.phone);
    if (extra) {
      const profile = await ContactProfileService.get(String(contract)).catch(() => null);
      const listed = (profile?.fields?.phones?.value ?? []).map((entry) => normalizarTelefoneBr(entry));
      if (!listed.includes(wanted)) {
        throw new WaError('whatsapp.error.invalidPhone', { code: 'invalid_phone', status: 400 });
      }
    } else {
      // A conversa presa ao contrato num número que o cadastro não tem mais
      // é solta antes: "Conversar" abre a do número atual.
      if (subscriber.contract) await WaConversationService.retireStaleBindings(subscriber.contract);
      const [contact] = await this.decorate([subscriber]);
      if (contact.conversationId) {
        let existing = await WaConversation.getById(contact.conversationId);
        // A conversa que só tinha cobrança automática: o atendente abriu, ela
        // passa a "Abertas".
        if (existing && !existing.engaged_at) {
          existing = await WaConversation.update(existing.id, { engaged_at: new Date() });
        }
        return { conversation: await WaConversationService.decorate(existing), created: false };
      }
    }

    const number = extra ? wanted : normalizarTelefoneBr(subscriber.phone);
    if (!number) {
      throw new WaError('whatsapp.error.subscriberNoPhone', {
        code: 'subscriber_no_phone',
        status: 409
      });
    }
    const account = await WhatsAppAccount.getForPurpose('general');
    if (!account) {
      throw new WaError('whatsapp.error.noAccount', { code: 'no_account', status: 400 });
    }

    const conversation = await WaConversation.ensure({
      accountId: account.id,
      // The canonical form the inbound handler builds, so the subscriber's
      // answer lands in this thread — `ensure` also finds it under the other
      // spelling of the ninth digit.
      externalThreadId: `${number}@s.whatsapp.net`,
      waPhone: number,
      pushName: subscriber.clientName || null
    });
    const customer = subscriber.deviceId ? await CustomerAccount.getByDeviceId(subscriber.deviceId) : null;
    // Foi o atendente quem abriu: a conversa vai para "Abertas" mesmo que até
    // aqui ela só tivesse cobrança automática.
    const engaged = conversation.engaged_at ? {} : { engaged_at: new Date() };
    const alreadyBound = conversation.contract || conversation.sgp_contact_id;
    const bound = alreadyBound
      ? (conversation.engaged_at ? conversation : await WaConversation.update(conversation.id, engaged))
      : await WaConversation.update(conversation.id, subscriber.contract
        ? {
          contract: subscriber.contract,
          device_id: subscriber.deviceId,
          customer_account_id: conversation.customer_account_id ?? customer?.id ?? null,
          ...engaged
        }
        // A client with no contract is bound by its row: there is no contract
        // to write, and inventing one would send billing looking for invoices
        // under it.
        : { sgp_contact_id: subscriber.contactId, ...engaged });
    return { conversation: await WaConversationService.decorate(bound), created: true };
  }
}

export default WaContactService;
