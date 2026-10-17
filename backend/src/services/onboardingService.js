import Setting from '../models/Setting.js';
import GenieAcsConnection from '../models/GenieAcsConnection.js';
import TenantUser from '../models/TenantUser.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import ProvisioningProfile from '../models/ProvisioningProfile.js';
import DeviceService from './deviceService.js';
import SgpService from './sgpService.js';

/** As duas marcas de "já vi isto", por provedor, na tabela `settings`. */
export const WIZARD_DONE_KEY = 'onboardingWizardDoneAt';
export const CHECKLIST_DISMISSED_KEY = 'onboardingChecklistDismissedAt';

/** Quanto o painel espera o ACS responder antes de dar o item por pendente. */
const DEVICE_COUNT_TIMEOUT_MS = 4000;

/** A ordem é a da tela: do que destrava tudo ao que só refina. */
export const ONBOARDING_ITEMS = ['genieacs', 'firstDevice', 'provisioning', 'sgp', 'whatsapp', 'team'];

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

/**
 * Os primeiros passos de um provedor novo, conferidos no que ele TEM, e não
 * numa marca que alguém clicou: "SGP configurado" é o SGP ter endereço e token,
 * "primeiro equipamento" é o ACS devolver um. Assim o checklist não mente
 * depois de uma configuração desfeita, nem pede o que já foi feito por outra
 * tela.
 *
 * Uma fonte que falha — o ACS fora do ar, a leitura de uma tabela — vira
 * "pendente", nunca um erro: o checklist é um guia, e o Dashboard onde ele mora
 * não pode cair porque o GenieACS não respondeu.
 */
export default class OnboardingService {
  static async status(tenantId) {
    const genieAcsUrl = await Setting.getByKey('genieAcsUrl').catch(() => null);
    // No modo agente o endereço pode ficar vazio: quem sabe onde o GenieACS
    // está é o agente, na rede do provedor. Ter escolhido o modo é o passo.
    const modoAgente = (await GenieAcsConnection.mode().catch(() => 'direct')) === 'agent';
    const hasAcs = modoAgente || Boolean(String(genieAcsUrl || '').trim());

    const checks = {
      genieacs: async () => hasAcs,
      firstDevice: async () => hasAcs
        && (await withTimeout(DeviceService.countDevicesFromGenieAcs(null), DEVICE_COUNT_TIMEOUT_MS)) > 0,
      provisioning: async () => (await ProvisioningProfile.countEnabled()) > 0,
      sgp: async () => {
        const config = await SgpService.getConfig();
        return Boolean(config.enabled && config.baseUrl && config.token);
      },
      whatsapp: async () => (await WhatsAppAccount.getAll()).length > 0,
      team: async () => (await TenantUser.listForTenant(tenantId)).length > 1
    };

    const results = await Promise.allSettled(ONBOARDING_ITEMS.map((key) => checks[key]()));
    const items = ONBOARDING_ITEMS.map((key, index) => ({
      key,
      done: results[index].status === 'fulfilled' && results[index].value === true
    }));

    const [wizardDoneAt, checklistDismissedAt] = await Promise.all([
      Setting.getByKey(WIZARD_DONE_KEY).catch(() => null),
      Setting.getByKey(CHECKLIST_DISMISSED_KEY).catch(() => null)
    ]);

    return {
      wizardDone: Boolean(wizardDoneAt),
      checklistDismissed: Boolean(checklistDismissedAt),
      items
    };
  }

  /** `what` já validado pelo controller: 'wizard' ou 'checklist'. */
  static async dismiss(what) {
    const key = what === 'wizard' ? WIZARD_DONE_KEY : CHECKLIST_DISMISSED_KEY;
    await Setting.upsert(key, new Date().toISOString());
  }
}
