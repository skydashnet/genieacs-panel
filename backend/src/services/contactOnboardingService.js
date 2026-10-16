import SgpService, { SgpError } from './sgpService.js';
import SgpClient from '../models/SgpClient.js';
import SgpContact from '../models/SgpContact.js';
import WaContactService from './waContactService.js';
import ContactProfileService, { ContactProfileError } from './contactProfileService.js';
import { lookupCnpj } from './cnpjLookupService.js';
import TeiahService from './teiahService.js';
import { lookupCep } from './addressLookupService.js';
import { isValidCnpj, isValidCpf } from '../utils/taxId.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';

/**
 * The "Novo cliente" flow: a CPF/CNPJ first, then the record, then — when the
 * operator asks — the same client created in the SGP.
 *
 * Its own file because it stands between two services that already import
 * each other's side of the story: `waContactService` (the SGP lookup that
 * files what it finds) imports `contactProfileService`, so the profile service
 * cannot import it back.
 */

function invalid(field) {
  return new ContactProfileError('contacts.error.invalidField', { code: 'invalid_field', vars: { field } });
}

function clean(value, max = 255) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** CPF → PF, CNPJ → PJ, anything else → null. */
export function personTypeOf(document) {
  const digits = String(document ?? '').replace(/\D/g, '');
  if (digits.length === 11 && isValidCpf(digits)) return 'PF';
  if (digits.length === 14 && isValidCnpj(digits)) return 'PJ';
  return null;
}

class ContactOnboardingService {
  /**
   * What the panel knows about a document before anything is typed:
   * - `inSgp`: the SGP's clients under it (already filed in the contacts list
   *   by the lookup, so "Abrir ficha" opens them);
   * - `inPanel`: a client typed in the panel before, with no SGP behind it;
   * - `prefill`: for a CNPJ nobody has yet, the Receita's record.
   *
   * A CPF has no public source — the Receita does not open it — so a person
   * not in the SGP is typed by hand.
   */
  static async lookupDocument(document, { fresh = false } = {}) {
    const digits = String(document ?? '').replace(/\D/g, '');
    const personType = personTypeOf(digits);
    if (!personType) {
      throw new ContactProfileError('contacts.error.invalidDocument', { code: 'invalid_document' });
    }

    let inSgp = [];
    let sgpChecked = false;
    if (SgpService.isReady(await SgpService.getConfig())) {
      const found = await WaContactService.lookupSgp(digits);
      inSgp = found.contacts.map((contact) => ({
        key: contact.key,
        name: contact.clientName,
        contract: contact.contract,
        state: contact.state
      }));
      sgpChecked = true;
    }

    const local = await SgpClient.getByDocument(digits);
    let inPanel = null;
    if (local && local.source === 'panel') {
      const row = await SgpContact.getClientRow(local.sgp_client_id);
      if (row) {
        inPanel = { key: `c:${row.id}`, name: local.overrides?.name?.value ?? row.client_name ?? null };
      }
    }

    let prefill = null;
    let prefillError = false;
    let teiahScore = null;
    let teiahConsulted = false;
    let teiahCached = false;
    let teiahConsultedAt = null;
    let deceased = false;
    const known = inSgp.length > 0 || Boolean(inPanel);

    // Nobody here knows this document: the TeiaH, when the provider has it,
    // fills the form — a CPF has no other source.
    if (!known && TeiahService.isReady(await TeiahService.getConfig())) {
      teiahConsulted = true;
      try {
        // A consultation younger than 30 days is not paid for twice.
        const consulted = await TeiahService.consultCached(digits, { fresh });
        const found = consulted.result;
        teiahCached = consulted.cached;
        teiahConsultedAt = consulted.consultedAt;
        teiahScore = found.score ?? null;
        deceased = found.deceased === true;
        if (found.found) {
          prefill = {
            source: 'teiah',
            name: found.name,
            tradeName: found.tradeName,
            birthDate: found.birthDate,
            email: found.emails?.[0] ?? null,
            phone: found.phones?.[0] ?? null,
            address: found.address ?? {}
          };
        }
      } catch (error) {
        console.warn(`TeiaH document lookup failed: ${error.code || error.message}`);
        prefillError = true;
      }
    }

    // A company the TeiaH did not fill: the Receita, as before.
    if (!prefill && personType === 'PJ' && inSgp.length === 0) {
      try {
        const result = await lookupCnpj(digits);
        if (result.found) {
          const data = result.data;
          prefill = {
            source: 'receita',
            name: data.legalName || null,
            tradeName: data.tradeName || null,
            birthDate: null,
            email: data.email || null,
            phone: data.phone || null,
            address: {
              street: data.addressLine || null,
              number: data.addressNumber || null,
              complement: data.addressExtra || null,
              district: data.district || null,
              city: data.city || null,
              state: data.state || null,
              zip: data.postalCode || null
            }
          };
          prefillError = false;
        }
      } catch {
        // The Receita down is a form typed by hand, not a failed lookup.
        prefillError = true;
      }
    }

    // A source that gave a name and no (or half an) address leaves the form
    // with the part the operator least wants to type: complete it.
    if (prefill) prefill.address = await this.completeAddress(prefill.address, { digits, personType, fromReceita: prefill.source === 'receita' });

    return {
      document: digits,
      personType,
      sgpChecked,
      inSgp,
      inPanel,
      prefill,
      prefillError,
      teiahConsulted,
      teiahCached,
      teiahConsultedAt,
      teiahScore,
      deceased
    };
  }

  /**
   * Fills what the first source left empty, never what it wrote: the CEP gives
   * street, district, city and state; for a company still without an address,
   * the Receita's record does. Best effort — a lookup that fails leaves the
   * address as it was.
   */
  static async completeAddress(address, { digits, personType, fromReceita }) {
    const result = { ...(address || {}) };
    const fill = (extra) => {
      for (const [field, value] of Object.entries(extra)) {
        if (value && !result[field]) result[field] = value;
      }
    };
    const incomplete = () => !result.street || !result.district || !result.city || !result.state;

    const zip = String(result.zip ?? '').replace(/\D/g, '');
    if (incomplete() && zip.length === 8) {
      try {
        const found = await lookupCep(zip);
        if (found.found) {
          fill({
            street: found.data.addressLine, district: found.data.district, city: found.data.city, state: found.data.state
          });
        }
      } catch {
        // The CEP services down: the form keeps what it has.
      }
    }

    if (incomplete() && personType === 'PJ' && !fromReceita) {
      try {
        const receita = await lookupCnpj(digits);
        if (receita.found) {
          const data = receita.data;
          fill({
            street: data.addressLine,
            number: data.addressNumber,
            complement: data.addressExtra,
            district: data.district,
            city: data.city,
            state: data.state,
            zip: data.postalCode
          });
        }
      } catch {
        // Same: a hand-typed address, not a failed lookup.
      }
    }
    return result;
  }

  static async lookupCep(cep) {
    const digits = String(cep ?? '').replace(/\D/g, '');
    if (digits.length !== 8) {
      throw new ContactProfileError('contacts.error.invalidCep', { code: 'invalid_cep' });
    }
    return lookupCep(digits);
  }

  /**
   * Creates the client in the SGP, then files it here under the SGP's own id,
   * so the next contacts sync finds the same record instead of a second one.
   *
   * The SGP is asked first whether the document is already there: a second
   * client with the same CPF is the one mistake this button must not make.
   */
  static async createInSgp(body) {
    const input = body && typeof body === 'object' ? body : {};
    const document = String(input.document ?? '').replace(/\D/g, '');
    const personType = personTypeOf(document);
    if (!personType) {
      throw new ContactProfileError('contacts.error.invalidDocument', { code: 'invalid_document' });
    }
    const name = clean(input.name);
    if (!name) throw invalid('name');

    const address = input.address && typeof input.address === 'object' ? input.address : {};
    const zip = String(address.zip ?? '').replace(/\D/g, '');
    const state = clean(address.state, 2).toUpperCase();
    // What the SGP marks mandatory, refused here in the operator's language
    // instead of by the SGP in its own.
    if (!clean(address.street)) throw invalid('street');
    if (!clean(address.district)) throw invalid('district');
    if (!clean(address.city)) throw invalid('city');
    if (zip.length !== 8) throw invalid('zip');
    if (!/^[A-Z]{2}$/.test(state)) throw invalid('state');

    const phone = input.whatsappPhone ? normalizarTelefoneBr(input.whatsappPhone) : null;
    if (input.whatsappPhone && !phone) throw invalid('whatsappPhone');
    const email = clean(input.email).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw invalid('email');

    SgpService.requireReady(await SgpService.getConfig());
    const existing = await WaContactService.lookupSgp(document);
    if (existing.total > 0) {
      throw new ContactProfileError('contacts.error.alreadyInSgp', {
        code: 'already_in_sgp',
        status: 409,
        vars: { name: existing.contacts[0].clientName || document }
      });
    }

    const cleanAddress = {
      street: clean(address.street),
      number: clean(address.number, 32),
      complement: clean(address.complement),
      district: clean(address.district),
      city: clean(address.city),
      state,
      zip,
      reference: clean(address.reference)
    };
    const created = await SgpService.createClient({
      personType,
      document,
      name,
      tradeName: clean(input.tradeName),
      responsibleName: clean(input.responsibleName),
      responsibleDocument: input.responsibleDocument,
      email,
      phone,
      birthDate: clean(input.birthDate, 32),
      notes: clean(input.notes, 2000),
      address: { ...cleanAddress, latitude: address.latitude, longitude: address.longitude }
    });

    // The record, as the SGP will send it on the next sync.
    const record = Object.fromEntries(Object.entries(cleanAddress).filter(([, value]) => value));
    await SgpClient.upsertFromSgp({
      clientId: created.clientId,
      document,
      personType,
      name,
      birthDate: clean(input.birthDate, 32) || null,
      address: record,
      phones: phone ? [phone] : [],
      emails: email ? [email] : []
    });
    const row = await SgpContact.upsertFromSgp(SgpService.contractToContactRow({
      contract: null,
      clientId: created.clientId,
      document,
      name,
      phone
    }));
    if (!row) {
      throw new SgpError('sgp.error.clientCreateFailed', { code: 'client_create_failed', status: 502 });
    }
    const profile = await ContactProfileService.get(`c:${row.id}`);
    return { profile, clientId: created.clientId, message: created.message };
  }
}

export default ContactOnboardingService;
