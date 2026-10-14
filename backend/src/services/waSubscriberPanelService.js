import SgpService, { SgpError, deriveContractState } from './sgpService.js';
import DeviceService from './deviceService.js';
import WaConversationService from './waConversationService.js';
import WaTemplateService from './waTemplateService.js';
import WaBillingService from './waBillingService.js';
import WaDunningService from './waDunningService.js';
import BillingStatusService from './billingStatusService.js';
import { WaError } from './whatsappConfigService.js';
import SgpLink from '../models/SgpLink.js';
import SgpContact from '../models/SgpContact.js';
import WaConversation from '../models/WaConversation.js';
import WaSendService from './waSendService.js';
import AuditLog from '../models/AuditLog.js';
import { DEFAULT_LOCALE, translate } from '../i18n/index.js';
import {
  comoDataBr,
  comoReal,
  maisAntigaEmAberto,
  modeloEhLembrete,
  renderCobranca,
  variaveisDeCobranca
} from '../utils/wa/waCobranca.js';

/**
 * The "SGP module" beside a WhatsApp thread: who is writing, which contracts
 * they hold, what their router is doing and what they owe.
 *
 * It is the side panel an attendant used to keep open in the chat tool, and it
 * carries over the rules the compra-venda port brought with it:
 *
 * - Refuse rather than guess (`renderCobranca`). An action whose data is not
 *   all there is not offered: no unlock without an exact contract, and no
 *   contract the server did not itself find for this conversation.
 * - A phone match is a convenience, never an authentication
 *   (`waConversationService`). Everything here is for the operator's eyes; the
 *   panel never sends any of it to the subscriber on its own.
 * - A person's choice is exact (`exactContract`); only the automatic choice is
 *   a guess (`pickContract`).
 * - The invoice that matters is the oldest overdue one, else the next one due
 *   (`maisAntigaEmAberto`).
 * - The ERP being down degrades the panel instead of blanking it: each part
 *   answers on its own, and the stored link stands in for the lookup.
 *
 * The router half comes from GenieACS, not SGP: the ERP has no idea what
 * address the CPE holds, and the ONT does.
 */

function errorOf(error) {
  if (error instanceof SgpError) {
    return { code: error.code, key: error.translationKey || null, message: error.message };
  }
  return { code: error?.status === 404 ? 'not_found' : 'unavailable', key: null, message: error?.message || null };
}

function publicContract(contract) {
  if (!contract) return null;
  const { loginPassword, ...rest } = contract;
  return { ...rest, state: deriveContractState(contract) };
}

/** The shape of a looked-up contract, rebuilt from a stored link when SGP is unreachable. */
function contractFromLink(link) {
  if (!link?.contract) return null;
  return {
    contract: link.contract,
    status: link.status ?? null,
    statusLabel: link.status_label ?? null,
    plan: link.plan ?? null,
    name: link.client_name ?? null,
    document: link.document ?? null,
    address: null,
    login: link.login ?? null,
    phone: link.phone_e164 ?? null,
    blocked: link.state === 'blocked' ? true : null
  };
}

function onlyDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

/** The address of a connected WAN first, then any address the ONT reported. */
export function primaryAddress(connections) {
  const usable = connections.filter((c) => c.ipAddress && c.ipAddress !== '0.0.0.0');
  const connected = usable.filter((c) => /connected|up/i.test(String(c.status ?? '')));
  return (connected[0] || usable[0] || null)?.ipAddress ?? null;
}

class WaSubscriberPanelService {
  /**
   * The stored link that says who this conversation is, most specific first:
   * the ONT the thread was bound to, then any ONT of its contract, then
   * whatever the phone resolves to.
   */
  static async storedLink(conversation) {
    const byPhone = await WaConversationService.resolveSubscriber(conversation.wa_phone_e164);
    // How the number was recognised, when it still says the same thing as the
    // thread; `conversation` when an operator bound the thread by hand.
    const matchedOn = (link) => (byPhone.link && link && byPhone.link.contract === link.contract
      ? byPhone.matchedOn
      : 'conversation');
    if (conversation.device_id) {
      const byDevice = await SgpLink.getByDeviceId(conversation.device_id);
      if (byDevice) return { link: byDevice, matchedOn: matchedOn(byDevice) };
    }
    if (conversation.contract) {
      const [byContract] = await SgpLink.getByContract(conversation.contract);
      if (byContract) return { link: byContract, matchedOn: matchedOn(byContract) };
    }
    return { link: byPhone.link, matchedOn: byPhone.matchedOn };
  }

  /**
   * Every contract this conversation can act on, as the server found them.
   *
   * `document` is the operator's manual search, for a number the panel does
   * not know. Otherwise the stored document wins, then the bound contract.
   */
  static async findContracts(conversation, { document = null } = {}) {
    const { link, matchedOn } = await this.storedLink(conversation);
    // A thread bound to an SGP client with no contract and no ONT: its
    // document is the only handle the SGP lookup accepts.
    // Sem ONT, o cadastro sincronizado (`sgp_contacts`) é quem guarda o CPF/CNPJ:
    // sem ele a busca ia só pelo contrato e achava um contrato só, mesmo para o
    // cliente que tem vários.
    const contact = link
      ? null
      : (conversation.contract
        ? await SgpContact.getByContract(conversation.contract)
        : (conversation.sgp_contact_id ? await SgpContact.getById(conversation.sgp_contact_id) : null));
    const searchDocument = onlyDigits(document) || onlyDigits(link?.document) || onlyDigits(contact?.document);
    const searchContract = conversation.contract || link?.contract || null;

    if (!searchDocument && !searchContract) {
      return { link, matchedOn, contracts: [], error: null, stale: false, searched: false };
    }

    try {
      let { contracts } = await SgpService.lookupCustomer(
        searchDocument ? { document: searchDocument } : { contract: searchContract }
      );
      // Achou pelo contrato e o cadastro daquele contrato diz de quem é: os
      // outros contratos do mesmo cliente vêm pelo documento. Se esta segunda
      // consulta falhar, fica o que a primeira trouxe.
      if (!searchDocument) {
        const documento = onlyDigits(SgpService.exactContract(contracts, searchContract)?.document);
        if (documento) {
          try {
            const todos = (await SgpService.lookupCustomer({ document: documento })).contracts;
            if (todos.some((c) => String(c.contract) === String(searchContract))) contracts = todos;
          } catch {
            // a lista curta, de um contrato só, continua valendo
          }
        }
      }
      return { link, matchedOn, contracts, error: null, stale: false, searched: true };
    } catch (error) {
      if (error instanceof SgpError && error.code === 'not_configured') throw error;
      // The stored link stands in for the lookup: a stale contract the
      // operator can see beats a blank panel while the ERP is down.
      const fallback = document ? null : contractFromLink(link);
      return {
        link,
        matchedOn,
        contracts: fallback ? [fallback] : [],
        error: errorOf(error),
        cause: error,
        stale: Boolean(fallback),
        searched: true
      };
    }
  }

  static async router(contract, conversation) {
    const links = contract ? await SgpLink.getByContract(contract) : [];
    const deviceIds = links.map((l) => l.device_id).filter(Boolean);
    // The ONT the thread was bound to, when it belongs to this contract.
    const deviceId = deviceIds.includes(conversation.device_id) ? conversation.device_id : deviceIds[0] ?? null;
    if (!deviceId) return { available: false, reason: 'unlinked', deviceId: null, deviceIds: [] };

    const [overview, wan] = await Promise.allSettled([
      DeviceService.getCustomerPortalOverview(deviceId),
      DeviceService.getWanAddresses(deviceId)
    ]);
    if (overview.status === 'rejected' && wan.status === 'rejected') {
      return { available: false, reason: 'unreachable', deviceId, deviceIds, error: errorOf(overview.reason) };
    }
    const info = overview.status === 'fulfilled' ? overview.value : null;
    const connections = wan.status === 'fulfilled' ? wan.value : [];
    return {
      available: true,
      deviceId,
      deviceIds,
      status: info?.status ?? null,
      lastInform: info?.lastInform ?? null,
      ont: info?.ont ?? null,
      rxPower: info?.optical?.rxPower ?? null,
      connectedDevices: info?.connectedDevices ?? null,
      ipAddress: primaryAddress(connections),
      connections
    };
  }

  static async invoices(contract) {
    if (!contract) return { items: [], highlight: null, error: null };
    try {
      const { invoices } = await SgpService.listInvoices({ contract, onlyOpen: true });
      await BillingStatusService.record(contract, invoices);
      // `true`: here a not-yet-due invoice is still the one to point at, the
      // way a reminder would — the operator is answering, not dunning.
      const { fatura } = maisAntigaEmAberto(invoices, new Date(), true);
      return { items: invoices, highlight: fatura?.id ?? null, error: null };
    } catch (error) {
      return { items: [], highlight: null, error: errorOf(error) };
    }
  }

  /**
   * The whole panel for one conversation.
   *
   * `contract` is the operator's pick from "contracts found", and is exact: a
   * number that is not in the list selects nothing rather than falling back to
   * a guess. `document` is the manual search for an unknown number.
   */
  static async build(conversationId, { contract: wanted = null, document = null } = {}) {
    let conversation = await WaConversationService.get(conversationId);
    // Aberta a conversa antiga de um cliente que trocou de número: ela sai do
    // contrato aqui, e o módulo passa a tratá-la como número não vinculado.
    if (conversation.contract
      && (await WaConversationService.retireStaleBindings(conversation.contract)).includes(conversation.id)) {
      conversation = await WaConversationService.get(conversationId);
    }
    conversation = await WaConversationService.bindSubscriber(conversation);

    const config = await SgpService.getConfig();
    const attendance = {
      conversationId: conversation.id,
      phone: conversation.wa_phone_e164 || null,
      pushName: conversation.push_name || null,
      contract: conversation.contract || null,
      deviceId: conversation.device_id || null
    };

    if (!SgpService.isReady(config)) {
      return { ready: false, attendance, ticketEnabled: false };
    }

    const found = await this.findContracts(conversation, { document });
    const contracts = found.contracts;
    const selected = wanted
      ? SgpService.exactContract(contracts, wanted)
      : SgpService.pickContract(contracts, conversation.contract || found.link?.contract || null);

    const [router, invoices, contact, dunningPause] = await Promise.all([
      this.router(selected?.contract ?? null, conversation),
      this.invoices(selected?.contract ?? null),
      selected?.clientId || !selected ? null : SgpContact.getByContract(selected.contract),
      selected ? WaDunningService.pauseFor(selected.contract) : null
    ]);
    const sgpUrl = SgpService.clientPageUrl(config, selected?.clientId || contact?.sgp_client_id);

    return {
      ready: true,
      attendance: {
        ...attendance,
        clientName: selected?.name || found.link?.client_name || null,
        document: selected?.document || found.link?.document || null,
        matchedOn: found.matchedOn || null
      },
      contracts: {
        items: contracts.map(publicContract),
        selected: selected?.contract ?? null,
        // "you asked for one that is not here" is its own answer, not a guess.
        missing: Boolean(wanted && !selected),
        searched: found.searched,
        stale: found.stale,
        error: found.error
      },
      contract: publicContract(selected),
      sgpUrl,
      router,
      invoices,
      // A régua parada para este contrato (comprovante recebido): a faixa
      // com "Retomar" no topo das faturas.
      dunningPause,
      ticketEnabled: config.ticketEnabled === true
    };
  }

  /**
   * The contract an action may touch, or a refusal.
   *
   * The browser names the contract, but the server decides whether it may: it
   * has to be the one this conversation is bound to, or one the lookup for
   * this conversation returned. Anything else is someone else's contract.
   */
  static async actionContract(conversationId, wanted, { document = null } = {}) {
    const conversation = await WaConversationService.get(conversationId);
    SgpService.requireReady(await SgpService.getConfig());
    const clean = String(wanted ?? '').trim() || conversation.contract || null;
    if (!clean) {
      throw new SgpError('sgp.error.contractRequired', { code: 'missing_contract', status: 400 });
    }
    if (clean === String(conversation.contract ?? '') && !document) {
      return { conversation, contract: clean };
    }
    const { contracts, error, cause, stale } = await this.findContracts(conversation, { document });
    // Nothing the server could check against — or only the stored link standing
    // in for a lookup that failed — is not a list to authorise from.
    if (error && (contracts.length === 0 || stale)) throw cause;
    if (!SgpService.exactContract(contracts, clean)) {
      throw new SgpError('sgp.error.contractNotInConversation', {
        code: 'contract_not_in_conversation',
        status: 409
      });
    }
    return { conversation, contract: clean };
  }

  /** The operator's correction: this thread belongs to that contract. */
  static async bind(conversationId, { contract, document = null }) {
    const { conversation, contract: clean } = await this.actionContract(conversationId, contract, { document });
    const [first] = await SgpLink.getByContract(clean);
    await WaConversation.update(conversation.id, {
      contract: clean,
      device_id: first?.device_id ?? null
    });
    return this.build(conversation.id, { contract: clean });
  }

  static async unlock(conversationId, { contract }) {
    const { contract: clean } = await this.actionContract(conversationId, contract);
    const result = await SgpService.requestTrustUnlock({ contract: clean });
    return { contract: clean, message: result.message };
  }

  /** Tira a pausa da régua de um contrato desta conversa. */
  static async resumeDunning(conversationId, { contract }) {
    const { contract: clean } = await this.actionContract(conversationId, contract);
    await WaDunningService.resume(clean);
    return { contract: clean, dunningPause: null };
  }

  /**
   * The billing text for this subscriber's invoice, for the operator to read
   * before sending — never sent from here.
   *
   * The same three rules as a dunning campaign, because it is the same text:
   * the template declares whether it is a reminder (`modeloEhLembrete`), the
   * invoice is `maisAntigaEmAberto`'s, and a variable with no value refuses
   * the whole text (`renderCobranca`) instead of handing the operator a
   * "PIX: " with nothing after it.
   */
  static async secondCopy(conversationId, { contract, template }) {
    const { contract: clean } = await this.actionContract(conversationId, contract);
    const { body } = await WaTemplateService.resolveBody(template);

    const [link] = await SgpLink.getByContract(clean);
    let name = link?.client_name || null;
    if (!name) {
      const { contracts } = await SgpService.lookupCustomer({ contract: clean });
      name = SgpService.exactContract(contracts, clean)?.name || null;
    }

    const hoje = new Date();
    const { invoices } = await SgpService.listInvoices({ contract: clean, onlyOpen: true });
    const { fatura, soFuturas } = maisAntigaEmAberto(invoices, hoje, modeloEhLembrete(body));
    if (!fatura) {
      throw new WaError(
        soFuturas ? 'whatsapp.error.secondCopyFutureOnly' : 'whatsapp.error.secondCopyNoInvoice',
        { code: soFuturas ? 'future_only' : 'no_invoice', status: 409 }
      );
    }
    const text = renderCobranca(body, variaveisDeCobranca(fatura, name, hoje));
    if (text === null) {
      throw new WaError('whatsapp.error.secondCopyIncomplete', { code: 'template_incomplete', status: 409 });
    }
    return { contract: clean, invoiceId: fatura.id ?? null, text };
  }

  /**
   * "Enviar na conversa": uma fatura em aberto vai ao cliente em mensagens
   * separadas — o resumo com o link do boleto, depois o PIX sozinho e a linha
   * digitável sozinha, para o cliente copiar só o código no celular.
   *
   * Nada do que vai na mensagem vem do navegador: o contrato passa pela mesma
   * conferência das outras ações (`actionContract`) e a fatura é relida do
   * SGP pelo id, entre as em aberto daquele contrato. Um operador não manda a
   * fatura de outro assinante, nem um código que ele mesmo digitou.
   */
  static async sendInvoice(conversationId, { contract, invoiceId }, { userId = null, req = null } = {}) {
    const { contract: clean } = await this.actionContract(conversationId, contract);
    const wanted = String(invoiceId ?? '').trim();
    const { invoices } = await SgpService.listInvoices({ contract: clean, onlyOpen: true });
    const fatura = wanted
      ? invoices.find((entry) => entry.id !== null && entry.id !== undefined && String(entry.id) === wanted)
      : null;
    if (!fatura) throw new WaError('whatsapp.error.invoiceNotFound', { code: 'invoice_not_found', status: 404 });

    const t = (chave, vars) => translate(DEFAULT_LOCALE, chave, vars);
    const pix = String(fatura.pix ?? '').trim();
    const linha = String(fatura.digitableLine ?? '').trim();
    const link = String(fatura.link ?? '').trim();
    if (!pix && !linha && !link) {
      throw new WaError('whatsapp.error.invoiceNoCodes', { code: 'invoice_no_codes', status: 409 });
    }

    const resumo = [t('whatsapp.invoiceSend.summary', { amount: comoReal(fatura.amount), dueDate: comoDataBr(fatura.dueDate) })];
    if (link) resumo.push('', t('whatsapp.bot.invoiceLink', { value: link }));
    if (pix || linha) resumo.push('', t('whatsapp.invoiceSend.codesFollow'));
    const corpos = [resumo.join('\n'), pix, linha].filter(Boolean);

    // Na ordem, uma de cada vez: o cliente tem de ler o resumo antes dos códigos.
    const messages = [];
    for (const body of corpos) {
      // eslint-disable-next-line no-await-in-loop -- a ordem das mensagens importa
      const message = await WaSendService.enqueue({ conversationId, body, userId, source: 'operator' });
      messages.push(WaSendService.publicMessage(message));
    }

    const auditoria = {
      action: AuditLog.ACTIONS.WHATSAPP_INVOICE_SENT,
      subjectType: 'wa_conversation',
      subjectId: conversationId,
      // Os códigos ficam fora da trilha: são o que paga a conta, não o que se audita.
      detail: { contract: clean, invoiceId: String(fatura.id), messages: messages.length }
    };
    if (req) await AuditLog.fromRequest(req, auditoria);
    else await AuditLog.record({ ...auditoria, actorUserId: userId, actorUsername: null });
    return { contract: clean, invoiceId: String(fatura.id), messages };
  }

  /**
   * "This number is theirs": the conversation's phone becomes the manual phone
   * of a contract the server found for it. The write, its normalisation and
   * its refusals are the billing screen's own (`setSubscriberPhone`).
   */
  static async savePhone(conversationId, { contract }) {
    const { conversation, contract: clean } = await this.actionContract(conversationId, contract);
    if (!conversation.wa_phone_e164) {
      throw new WaError('whatsapp.error.invalidPhone', { code: 'invalid_phone', status: 400 });
    }
    await WaBillingService.setSubscriberPhone(clean, conversation.wa_phone_e164);
    return this.build(conversation.id, { contract: clean });
  }

  static async ticket(conversationId, { contract, content, note }) {
    const { contract: clean } = await this.actionContract(conversationId, contract);
    return SgpService.openTicket({ contract: clean, content, note });
  }
}

export default WaSubscriberPanelService;
