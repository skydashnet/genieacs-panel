import crypto from 'node:crypto';
import CustomerReferral, { REFERRAL_STATUSES } from '../models/CustomerReferral.js';
import SgpContact from '../models/SgpContact.js';
import SgpLink from '../models/SgpLink.js';
import Setting from '../models/Setting.js';
import Tenant from '../models/Tenant.js';
import WaConversation from '../models/WaConversation.js';
import WaOptOut from '../models/WaOptOut.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WaSendService from './waSendService.js';
import { WaError } from './whatsappConfigService.js';
import { whatsappPhoneOf } from './contactProfileService.js';
import { currentTenantId } from '../config/tenantContext.js';
import { getDb } from '../config/database.js';
import { portalBaseDomain } from '../middleware/tenantResolver.js';
import { DEFAULT_LOCALE, translatorFor } from '../i18n/index.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';

const BASE_URL_KEY = 'referralBaseUrl';
const TOKEN_VERSION = 'v1';

const invalid = (key, code, status = 400) => new WaError(key, { code, status });

/**
 * O segredo que assina os links. Estável entre reinícios, porque o link vai
 * dentro de mensagens que o cliente guarda por semanas; sem segredo nenhum
 * configurado não há link (`null`), e a variável da campanha pula quem ficaria
 * sem ele.
 */
function secret() {
  return process.env.REFERRAL_LINK_SECRET || process.env.PORTAL_JWT_SECRET || process.env.JWT_SECRET || null;
}

function sign(payload) {
  const key = secret();
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(`referral.${TOKEN_VERSION}.${payload}`).digest('base64url').slice(0, 22);
}

/** O token de um contrato: provedor e contrato, assinados. Nulo sem segredo. */
export function signReferralToken(tenantId, contract) {
  const payload = Buffer.from(JSON.stringify([Number(tenantId), String(contract)])).toString('base64url');
  const signature = sign(payload);
  return signature ? `${TOKEN_VERSION}.${payload}.${signature}` : null;
}

/** `{ tenantId, contract }` de um token válido, ou null. */
export function readReferralToken(token) {
  const [version, payload, signature, ...rest] = String(token ?? '').split('.');
  if (version !== TOKEN_VERSION || !payload || !signature || rest.length > 0) return null;
  const expected = sign(payload);
  if (!expected) return null;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const [tenantId, contract] = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isInteger(tenantId) || tenantId <= 0 || !contract) return null;
    return { tenantId, contract: String(contract) };
  } catch {
    return null;
  }
}

/** O primeiro nome, com a inicial maiúscula (o cadastro do SGP vem em caixa alta). */
const firstName = (name) => {
  const first = String(name ?? '').trim().split(/\s+/)[0];
  return first ? first.charAt(0).toLocaleUpperCase('pt-BR') + first.slice(1).toLocaleLowerCase('pt-BR') : null;
};

const publicRow = (row) => ({
  id: Number(row.id),
  referrerContract: row.referrer_contract,
  referrerName: row.referrer_name || null,
  name: row.name,
  phone: row.phone_e164,
  neighborhood: row.neighborhood || null,
  note: row.note || null,
  status: row.status,
  createdAt: row.created_at ? new Date(row.created_at).toISOString() : null
});

/**
 * Indique e ganhe: o link de cada cliente e a lista de quem ele indicou.
 *
 * O link é `<endereço>/indique?t=<token>`, e o token (provedor + contrato,
 * assinado) é o que liga o cadastro de quem entra ao cliente que indicou, sem
 * tabela de códigos: ninguém forja o link de outro contrato.
 */
class CustomerReferralService {
  /** O endereço público de onde o link abre, sem barra final, ou null. */
  static async baseUrl() {
    const saved = String((await Setting.getByKey(BASE_URL_KEY)) ?? '').trim().replace(/\/+$/, '');
    if (saved) return saved;
    const domain = portalBaseDomain();
    if (!domain) return null;
    const row = await getDb()('tenants').where({ id: currentTenantId() }).first('slug');
    return row?.slug ? `https://${row.slug}.${domain}` : null;
  }

  static async setBaseUrl(value) {
    const text = String(value ?? '').trim().replace(/\/+$/, '');
    if (text && !/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(text)) {
      throw invalid('whatsapp.referral.invalidBaseUrl', 'invalid_base_url');
    }
    await Setting.upsert(BASE_URL_KEY, text);
    return text || null;
  }

  /** O link de um contrato sobre um endereço já lido, ou null quando falta endereço ou segredo. */
  static buildLink(base, contract) {
    if (!base || !contract) return null;
    const token = signReferralToken(currentTenantId(), contract);
    return token ? `${base}/indique?t=${token}` : null;
  }

  // ── A página pública ─────────────────────────────────────────────────────

  /** O que a página mostra: o provedor e o primeiro nome de quem indicou. */
  static async publicInfo(contract) {
    const row = await SgpContact.getByContract(contract);
    if (!row) throw invalid('whatsapp.referral.invalidLink', 'invalid_link', 404);
    const provider = await Tenant.findPortalContactById(currentTenantId());
    return { provider: provider?.name || null, referrerFirstName: firstName(row.client_name) };
  }

  static async submit(contract, input = {}) {
    const row = await SgpContact.getByContract(contract);
    if (!row) throw invalid('whatsapp.referral.invalidLink', 'invalid_link', 404);

    const name = String(input.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (name.length < 2) throw invalid('whatsapp.referral.invalidName', 'invalid_name');
    const phone = normalizarTelefoneBr(input.phone);
    if (!phone) throw invalid('whatsapp.referral.invalidPhone', 'invalid_phone');
    const neighborhood = String(input.neighborhood ?? '').trim().slice(0, 120) || null;

    // Quem indica a si mesmo não ganha nada, e o cadastro seria só ruído.
    const links = await SgpLink.getByContracts([contract]);
    const own = whatsappPhoneOf(links[0] ?? null, row).phone;
    if (own && normalizarTelefoneBr(own) === phone) {
      throw invalid('whatsapp.referral.selfReferral', 'self_referral');
    }

    // O mesmo indicado de novo (a pessoa tocou duas vezes) não duplica.
    const again = await CustomerReferral.findDuplicate(contract, phone);
    if (again) return { referral: publicRow(again), created: false };

    const referral = await CustomerReferral.create({
      referrer_contract: String(contract),
      referrer_name: row.client_name || null,
      name,
      phone_e164: phone,
      neighborhood,
      status: 'new'
    });
    // O aviso a quem indicou nunca derruba o cadastro do indicado.
    this.notifyReferrer(referral, row).catch((error) => {
      console.warn(`Referral notice not sent: ${error.message}`);
    });
    return { referral: publicRow(referral), created: true };
  }

  /** "Fulano se cadastrou pelo seu link": mensagem a quem indicou, uma vez. */
  static async notifyReferrer(referral, contactRow) {
    const links = await SgpLink.getByContracts([referral.referrer_contract]);
    const to = normalizarTelefoneBr(whatsappPhoneOf(links[0] ?? null, contactRow).phone);
    if (!to) return false;
    if (await WaOptOut.isActive({ waPhone: to, category: 'marketing' })) return false;
    const account = await WhatsAppAccount.getForPurpose('billing');
    if (!account) return false;

    const provider = await Tenant.findPortalContactById(currentTenantId());
    const t = translatorFor(DEFAULT_LOCALE);
    const body = t('whatsapp.referral.notify', {
      nome: firstName(contactRow.client_name) || '',
      indicado: firstName(referral.name) || referral.name,
      provedor: provider?.name || ''
    });
    const conversation = await WaConversation.ensure({
      accountId: account.id,
      externalThreadId: `${to}@s.whatsapp.net`,
      waPhone: to,
      pushName: contactRow.client_name || null
    });
    await WaSendService.enqueue({ conversationId: conversation.id, body, source: 'campaign' });
    await CustomerReferral.update(referral.id, { referrer_notified_at: new Date() });
    return true;
  }

  // ── A tela de Indicações ─────────────────────────────────────────────────

  static async list({ status, limit, offset } = {}) {
    const wanted = REFERRAL_STATUSES.includes(status) ? status : null;
    const rows = await CustomerReferral.list({
      status: wanted,
      limit: Math.min(Math.max(Number(limit) || 200, 1), 500),
      offset: Math.max(Number(offset) || 0, 0)
    });
    return {
      referrals: rows.map(publicRow),
      counts: await CustomerReferral.counts(),
      baseUrl: await this.baseUrl(),
      linksReady: Boolean(secret())
    };
  }

  static async update(id, { status, note } = {}) {
    const numeric = Number(id);
    const row = Number.isInteger(numeric) ? await CustomerReferral.getById(numeric) : null;
    if (!row) throw invalid('whatsapp.referral.notFound', 'referral_not_found', 404);
    const patch = {};
    if (status !== undefined) {
      if (!REFERRAL_STATUSES.includes(status)) throw invalid('whatsapp.referral.invalidStatus', 'invalid_status');
      patch.status = status;
    }
    if (note !== undefined) patch.note = String(note ?? '').trim().slice(0, 500) || null;
    return publicRow(await CustomerReferral.update(numeric, patch));
  }
}

export default CustomerReferralService;
