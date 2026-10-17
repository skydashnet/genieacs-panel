import Plan, { parsePlanFeatures } from '../models/Plan.js';
import Tenant from '../models/Tenant.js';
import Lead from '../models/Lead.js';
import { leadRetentionDays } from '../utils/leadRetention.js';
import SubscriptionService from '../services/subscriptionService.js';
import PlatformNotifyService from '../services/platformNotifyService.js';
import { lookupCnpj } from '../services/cnpjLookupService.js';
import { normalizeTaxId, isValidCnpj } from '../utils/taxId.js';
import { slugProblem } from '../utils/slug.js';
import { createResponse, createErrorResponse, isValidEmail } from '../utils/helpers.js';
import { panelBaseDomain } from '../middleware/tenantResolver.js';
import { PRODUCT_NAME } from '../config/brand.js';
import { panelUrlFor } from '../services/mail/index.js';
import { readProfile } from '../services/platformProfileService.js';
import { translate } from '../i18n/index.js';
import { DEFAULT_LOCALE } from '../i18n/config.js';

/**
 * A página pública: o que um visitante sem conta pode perguntar ao ápice.
 *
 * Tudo aqui é leitura de coisa que já é pública por natureza (o catálogo que
 * se vende, se um subdomínio está livre, o que a Receita diz de um CNPJ) ou a
 * gravação de um pedido de contato. Nada lê ou escreve dado de provedor.
 */

/** O plano como a vitrine o mostra: sem id, sem contagem, sem retenção. */
export function presentPublicPlan(plan) {
  return {
    code: plan.code,
    name: plan.name,
    description: plan.description ?? null,
    features: parsePlanFeatures(plan.features),
    limits: SubscriptionService.limitsOf(plan),
    priceCents: Number(plan.price_cents ?? 0),
    priceYearlyCents: plan.price_yearly_cents === null || plan.price_yearly_cents === undefined
      ? null
      : Number(plan.price_yearly_cents),
    currency: plan.currency,
    periodDays: Number(plan.period_days ?? 30),
    trialDays: Number(plan.trial_days ?? 0),
    featured: Boolean(plan.featured)
  };
}

const LEAD_LIMITS = { name: 128, company: 160, email: 160, phone: 32, city: 80, message: 2000 };

function clip(value, max) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

class PublicController {
  /** `GET /api/public/info` — o que a página precisa saber da plataforma. */
  static async info(req, res) {
    try {
      // Os dados da empresa vêm de Configurações → Dados do SaaS, com o `.env`
      // valendo para o que o console nunca gravou.
      const { values: p } = await readProfile();
      return res.json(createResponse('ok', {
        productName: p.tradeName || PRODUCT_NAME,
        tradeName: p.tradeName,
        baseDomain: panelBaseDomain() || null,
        // Onde um provedor entra, quando é um endereço só para todos (sem
        // subdomínio): o "Entrar" da vitrine leva para lá, e não para o login do
        // console. Com subdomínio, cada um entra no seu, e isto é nulo.
        panelUrl: panelBaseDomain() ? null : panelUrlFor(null),
        // O número do botão flutuante de WhatsApp. Só dígitos.
        contactWhatsapp: p.contactWhatsapp,
        contactEmail: p.contactEmail,
        legalName: p.legalName,
        taxId: p.taxId,
        address: p.address,
        // Quanto tempo o pedido de contato fica guardado — `0` quer dizer que
        // NADA o apaga sozinho. A página de privacidade diz exatamente isto, e
        // lê da mesma função que a poda (`utils/leadRetention.js`): a política
        // e o que o código faz não têm como divergir.
        leadRetentionDays: leadRetentionDays(),
        social: {
          instagram: p.instagram,
          facebook: p.facebook,
          youtube: p.youtube,
          linkedin: p.linkedin
        }
      }));
    } catch (error) {
      console.error('Public info error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /** `GET /api/public/plans` — o catálogo à venda, na ordem do console. */
  static async plans(req, res) {
    try {
      const plans = await Plan.listPublic();
      // Curto: o console muda o preço e a página tem que acompanhar logo.
      res.set('Cache-Control', 'public, max-age=60');
      return res.json(createResponse('ok', { plans: plans.map(presentPublicPlan) }));
    } catch (error) {
      console.error('Public plans error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /**
   * `GET /api/public/slug-available?slug=` — a mesma regra do cadastro, antes
   * dele. Responde 200 nos dois casos; `available` e `problem` dizem qual.
   */
  static async slugAvailable(req, res) {
    try {
      const slug = String(req.query?.slug ?? '');
      const problem = slugProblem(slug);
      if (problem) return res.json(createResponse('ok', { slug, available: false, problem: 'invalid' }));
      const taken = Boolean(await Tenant.findBySlug(slug));
      return res.json(createResponse('ok', { slug, available: !taken, problem: taken ? 'taken' : null }));
    } catch (error) {
      console.error('Slug check error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /** `GET /api/public/cnpj?cnpj=` — o cadastro da Receita, para preencher o formulário. */
  static async cnpj(req, res) {
    const cnpj = normalizeTaxId(req.query?.cnpj);
    if (!isValidCnpj(cnpj)) {
      return res.status(400).json(createErrorResponse(req.t('tenant.billingTaxIdInvalid')));
    }
    try {
      const result = await lookupCnpj(cnpj);
      if (!result.found) {
        return res.status(404).json(createErrorResponse(req.t('tenant.cnpjNotFound')));
      }
      return res.json(createResponse(req.t('tenant.cnpjFound'), { taxId: cnpj, ...result.data }));
    } catch (error) {
      return res.status(502).json(createErrorResponse(req.t('tenant.cnpjLookupFailed'), error.message));
    }
  }

  /** `POST /api/public/leads` — "Pedir demonstração". */
  static async createLead(req, res) {
    try {
      const body = req.body ?? {};
      // O campo que um humano não vê. Robô que preenche tudo recebe o mesmo
      // 201 de todo mundo e não grava nada — recusar ensinaria o robô.
      if (String(body.website ?? '').trim()) {
        return res.status(201).json(createResponse(req.t('public.leadCreated'), { ok: true }));
      }
      const name = clip(body.name, LEAD_LIMITS.name);
      const email = clip(body.email, LEAD_LIMITS.email);
      const phone = clip(body.phone, LEAD_LIMITS.phone);
      if (!name || (!email && !phone) || (email && !isValidEmail(email))) {
        return res.status(400).json(createErrorResponse(req.t('public.leadInvalid')));
      }
      const devices = Number(body.devicesEstimate);
      const planCode = clip(body.planCode, 32);
      const lead = await Lead.create({
        name,
        company: clip(body.company, LEAD_LIMITS.company),
        email,
        phone,
        city: clip(body.city, LEAD_LIMITS.city),
        devices_estimate: Number.isInteger(devices) && devices >= 0 && devices < 10_000_000 ? devices : null,
        message: clip(body.message, LEAD_LIMITS.message),
        plan_code: planCode && (await Plan.findPublicByCode(planCode)) ? planCode : null,
        status: 'new',
        source: 'landing'
        // O IP não é guardado, e a ausência é deliberada.
        //
        // Ele era gravado aqui e NUNCA lido: `models/Lead.js` não o menciona em
        // nenhum método, e `presentLead` — lista fechada de campos — não o
        // entrega ao console, que portanto nunca o mostrou. Dado pessoal
        // guardado sem finalidade em exercício é o que o art. 6º da LGPD chama
        // de desnecessário, e a migração `0109_drop_lead_ip` derrubou a coluna.
        //
        // E ele não era o controle de abuso desta rota: isso são o
        // `publicLeadLimiter` e o campo-armadilha `website` logo acima, que
        // devolvem 201 ao robô sem gravar nada.
      });

      // Melhor esforço, fora do caminho da resposta.
      const vars = {
        name: lead.name,
        company: lead.company || '-',
        email: lead.email || '-',
        phone: lead.phone || '-',
        city: lead.city || '-',
        devices: lead.devices_estimate ?? '-',
        plan: lead.plan_code || '-',
        message: lead.message || '-'
      };
      PlatformNotifyService.notifyTeam({
        subject: translate(DEFAULT_LOCALE, 'public.leadNotifySubject', vars),
        text: translate(DEFAULT_LOCALE, 'public.leadNotifyBody', vars)
      }).catch(() => {});

      return res.status(201).json(createResponse(req.t('public.leadCreated'), { ok: true }));
    } catch (error) {
      console.error('Create lead error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }
}

export default PublicController;
