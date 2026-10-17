import AuditLog from '../models/AuditLog.js';
import Setting from '../models/Setting.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';
import CustomerService from '../services/customerService.js';
import DeviceService from '../services/deviceService.js';
import GenieAcsEgress, { EGRESS_REFUSED } from '../services/genieacsEgress.js';
import GenieAcsAuthService, { AUTH_TYPES } from '../services/genieacsAuthService.js';
import Tenant from '../models/Tenant.js';
import { suggestGenieAcsUrl } from '../services/genieacsSuggestion.js';
import { connectorFor } from '../services/genieacs/connector.js';
import {
  acsAgentOfflineBody, afterModeChange, agentStatus, isAgentOffline, issueAgentToken
} from '../services/genieacs/agent.js';
import { forgetSharedAcs } from '../services/genieacs/direct.js';
import GenieAcsConnection from '../models/GenieAcsConnection.js';
import { currentTenantId } from '../config/tenantContext.js';
import { AUDIT_RETENTION } from '../config/retention.js';
import {
  PLATFORM_MANAGED_SETTING_KEYS,
  genieAcsOriginTakenByAnotherTenant,
  platformManagesCurrentTenant,
  platformManagesGenieAcsCurrentTenant
} from '../config/platformManaged.js';
import SubscriptionService from '../services/subscriptionService.js';

/**
 * O prazo da trilha acima do teto do plano é recusado com 422, e não cortado
 * em silêncio: o provedor precisa ver que o número dele não é o que vai valer.
 * `null` quando está dentro do teto, ou quando não há teto.
 */
async function auditRetentionAboveCap(key, value) {
  if (key !== 'auditRetentionDays') return null;
  const { audit } = await SubscriptionService.retentionCaps();
  if (audit === null) return null;
  return Number.parseInt(String(value), 10) > audit ? audit : null;
}

/**
 * A recusa de quando o provedor tenta gravar o que é da plataforma. 403 com um
 * código que a tela reconhece: não é validação errada, é a porta errada — a
 * mudança existe, só que é feita no console.
 */
function platformManagedResponse(req, res) {
  return res.status(403).json(
    createErrorResponse(req.t('settings.platformManaged'), null, 'platform_managed')
  );
}

/**
 * Os modos que o PROVEDOR escolhe pela tela dele. `tunnel` não está aqui: na
 * SaaS quem escolhe é a plataforma (e esta rota já recusa com
 * `platform_managed`), e na instalação própria a rede privada já é permitida
 * no `direct` — o túnel não acrescentaria nada além de um nome a mais.
 */
const PROVIDER_CONNECTION_MODES = Object.freeze(['direct', 'agent']);

/** O que a tela de Configurações lê da conexão com o GenieACS. */
async function genieAcsConnectionSnapshot() {
  return {
    mode: await GenieAcsConnection.mode(),
    // Quem administra o GenieACS escolhe como o painel chega a ele: na SaaS, o
    // console — ou o próprio provedor, quando o console marcou que o servidor
    // é dele (`ownership = 'own'`).
    modeEditable: !(await platformManagesGenieAcsCurrentTenant()),
    agent: await agentStatus()
  };
}

async function refusesPlatformKey(key) {
  return PLATFORM_MANAGED_SETTING_KEYS.includes(String(key)) && platformManagesGenieAcsCurrentTenant();
}

/**
 * A credencial pública mais `platformManaged`: se o ACS deste provedor é da
 * plataforma (só leitura na tela) ou dele. Vai aqui, numa rota autenticada, e
 * não no perfil público do provedor: quem administra o ACS de quem não é
 * assunto de quem ainda não entrou.
 */
async function authConfigWithManaged(config) {
  return { ...config, platformManaged: await platformManagesGenieAcsCurrentTenant() };
}

/**
 * Na SaaS, o provedor com ACS próprio não grava o endereço do ACS de outro
 * provedor — ver `genieAcsOriginTakenByAnotherTenant`. 409 com código próprio,
 * que a tela traduz. Na self-hosted o dono da instalação é um só.
 */
async function refusesTakenOrigin(req, res, key, value) {
  if (String(key) !== 'genieAcsUrl' || !(await platformManagesCurrentTenant())) return null;
  if (!(await genieAcsOriginTakenByAnotherTenant(value))) return null;
  return res.status(409).json(
    createErrorResponse(req.t('settings.genieAcsOriginInUse'), null, 'genieacs_origin_in_use')
  );
}
import OnboardingService from '../services/onboardingService.js';
import { classifySyncError } from '../services/customerSyncErrors.js';
import CustomerIdSyncJob from '../services/customerIdSyncJob.js';

import { isDateFormat, readDateFormat } from '../utils/dateFormat.js';
const ALLOWED_SETTING_KEYS = new Set([
  'appName',
  'genieAcsUrl',
  'autoGenerateCustomerId',
  'customerIdPrefixMode',
  'customerIdCompanyPrefix',
  'customerIdSuffixMode',
  'vpPppoeUsername',
  'vpWanBridge',
  'vpRxPower',
  'vpTemperature',
  'vpActiveDevices',
  'vpSuperAdmin',
  'vpSuperPassword',
  'vpUserAdmin',
  'vpUserPassword',
  // Por quantos dias a trilha de auditoria é guardada. Era uma constante no
  // agendador: um ano para todo mundo, sem tela e sem como saber que existia.
  // Um ISP em disputa precisa de mais, e um que resolveu guardar menos dado
  // pessoal precisa de menos — política de guarda é decisão de quem responde
  // pelos dados, não constante de código.
  'auditRetentionDays',
  // O contato do provedor no portal do assinante (`GET /api/customer/provider`).
  'portalShowProviderContact',
  'portalContactPhone',
  'portalContactWhatsapp',
  'portalContactEmail',
  // Como as datas aparecem em todo o painel e no portal. Ver utils/dateFormat.js.
  'dateFormat'
]);

// Validation runs without a request, so it reports translation keys and the
// controller renders them in the caller's language.
function validateSetting(key, value) {
  if (!ALLOWED_SETTING_KEYS.has(key)) {
    return { errorKey: 'settings.validation.unsupportedKey' };
  }
  const normalized = String(value);
  if (normalized.length > 2048) {
    return { errorKey: 'settings.validation.valueTooLong' };
  }
  if (key === 'autoGenerateCustomerId' && !['true', 'false'].includes(normalized)) {
    return { errorKey: 'settings.validation.autoGeneration' };
  }
  if (key === 'customerIdPrefixMode' && !['default', 'company'].includes(normalized)) {
    return { errorKey: 'settings.validation.prefixMode' };
  }
  if (key === 'customerIdCompanyPrefix' && !/^[A-Za-z]{2,4}$/.test(normalized.trim())) {
    return { errorKey: 'settings.validation.companyPrefix' };
  }
  if (key === 'customerIdSuffixMode' && !['random', 'installation_date'].includes(normalized)) {
    return { errorKey: 'settings.validation.suffixMode' };
  }
  if (key === 'appName' && (normalized.trim().length < 1 || normalized.length > 80)) {
    return { errorKey: 'settings.validation.appName' };
  }
  if (key === 'auditRetentionDays') {
    // Os limites existem pelos dois lados, e por razões opostas: abaixo de 30
    // dias a trilha deixa de responder à pergunta que a justifica ("quem mexeu
    // nisso?", que chega meses depois), e acima de 10 anos ela vira o arquivo
    // de dado pessoal que o prazo existe para evitar.
    const dias = Number.parseInt(normalized, 10);
    if (!Number.isInteger(dias) || String(dias) !== normalized.trim() || dias < AUDIT_RETENTION.minDays || dias > AUDIT_RETENTION.maxDays) {
      return { errorKey: 'settings.validation.auditRetentionDays' };
    }
  }
  if (key === 'dateFormat' && !isDateFormat(normalized)) {
    return { errorKey: 'settings.validation.dateFormat' };
  }
  if (key === 'portalShowProviderContact' && !['true', 'false'].includes(normalized)) {
    return { errorKey: 'settings.validation.portalContactToggle' };
  }
  if (key === 'portalContactPhone' || key === 'portalContactWhatsapp') {
    // Vazio é "use o do cadastro". Preenchido, precisa ser um telefone que o
    // `tel:` e o `wa.me` do portal consigam discar: de 10 a 13 dígitos (DDD e
    // número, com ou sem o 55), e só os separadores de costume em volta.
    const phone = normalized.trim();
    const digits = phone.replace(/\D/g, '');
    if (phone && (!/^[\d\s()+.-]{10,25}$/.test(phone) || digits.length < 10 || digits.length > 13)) {
      return { errorKey: 'settings.validation.portalContactPhone' };
    }
    return { value: phone };
  }
  if (key === 'portalContactEmail') {
    const email = normalized.trim();
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return { errorKey: 'settings.validation.portalContactEmail' };
    }
    return { value: email };
  }
  return { value: normalized };
}

class SettingsController {
  /**
   * O que muda como o painel se DESENHA para qualquer pessoa da equipe — hoje,
   * só o formato da data. Sem `settings.read`: um técnico que não abre as
   * configurações também vê datas, e precisa vê-las no formato do provedor.
   */
  static async getDisplayPreferences(req, res) {
    try {
      return res.json(createResponse(req.t('settings.listRetrieved'), { dateFormat: await readDateFormat() }));
    } catch (error) {
      console.error('Display preferences error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /**
   * Os primeiros passos do provedor: o checklist do Dashboard e a marca de que
   * o assistente de boas-vindas já foi visto. Ver `OnboardingService`.
   */
  static async getOnboardingStatus(req, res) {
    try {
      const status = await OnboardingService.status(currentTenantId());
      return res.json(createResponse(req.t('settings.listRetrieved'), status));
    } catch (error) {
      console.error('Onboarding status error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /**
   * "Já vi": o assistente foi concluído ou pulado, ou o checklist foi ocultado.
   * Gravado no provedor, e não no navegador, para que outro administrador ou
   * outra máquina não recebam o assistente de novo.
   */
  static async dismissOnboarding(req, res) {
    const what = req.body?.what;
    if (what !== 'wizard' && what !== 'checklist') {
      return res.status(400).json(createErrorResponse(req.t('settings.onboardingInvalid'), null, 'invalid_onboarding_target'));
    }
    try {
      await OnboardingService.dismiss(what);
      return res.json(createResponse(req.t('settings.updated'), { what }));
    } catch (error) {
      console.error('Onboarding dismiss error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /**
   * `GET /api/settings/genieacs-suggestion` — o endereço de ACS que a
   * plataforma sugere a ESTE provedor, ou nada.
   *
   * Serve o passo 2 do onboarding, onde hoje se digita a NBI do zero. A
   * sugestão sai de `GENIEACS_URL_TEMPLATE` com `{slug}` e `{id}` do provedor em
   * escopo — um endereço por provedor, porque um ACS compartilhado entre dois
   * mostraria a frota de um ao outro (ver `genieacsSuggestion.js`).
   *
   * `settings.write` e não `settings.read`: quem não pode gravar a URL não tem
   * o que fazer com a sugestão dela, e a capacidade que guarda a tela é a que
   * guarda a rota.
   *
   * `null` não é erro — é "este deploy não configurou template", que é o estado
   * de todo install que não hospeda ACS nenhum. A tela se comporta como sempre.
   */
  static async getGenieAcsSuggestion(req, res) {
    try {
      const tenant = await Tenant.findById(currentTenantId());
      return res.json(createResponse(
        req.t('settings.listRetrieved'),
        { suggestion: suggestGenieAcsUrl(tenant) }
      ));
    } catch (error) {
      console.error('GenieACS suggestion error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /**
   * A credencial da NBI daquele provedor, sem o segredo.
   *
   * Rota própria e não uma chave em `/api/settings`, por uma razão só: aquela
   * rota devolve `Setting.getAll()` inteiro, então toda chave que entra lá está
   * no fio no mesmo instante. Um segredo cifrado no banco e servido em claro no
   * GET não é segredo — e a redação teria que ser lembrada por quem
   * acrescentasse a próxima chave, que é o tipo de lembrança que falha.
   */
  static async getGenieAcsAuth(req, res) {
    try {
      return res.json(createResponse(
        req.t('settings.listRetrieved'),
        await authConfigWithManaged(await GenieAcsAuthService.getPublicConfig())
      ));
    } catch (error) {
      console.error('Get GenieACS auth error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  static async updateGenieAcsAuth(req, res) {
    try {
      if (await platformManagesGenieAcsCurrentTenant()) return platformManagedResponse(req, res);
      const authType = req.body?.authType;
      if (authType !== undefined && !AUTH_TYPES.includes(authType)) {
        return res.status(400).json(
          createErrorResponse(req.t('settings.validation.genieAcsAuthType'))
        );
      }
      // `basic` sem usuário é configuração que não autentica ninguém e que a
      // tela não teria como distinguir de "salvou certo": o header sai
      // `Basic OnNlZ3JlZG8=`, com usuário vazio, e o ACS recusa sem dizer por
      // quê. `bearer` não precisa de usuário — o token é a credencial inteira.
      const proximo = {
        ...req.body,
        username: req.body?.username
      };
      const atual = await GenieAcsAuthService.getPublicConfig();
      const tipoFinal = authType ?? atual.authType;
      const usuarioFinal = proximo.username === undefined ? atual.username : String(proximo.username).trim();
      if (tipoFinal === 'basic' && !usuarioFinal) {
        return res.status(400).json(
          createErrorResponse(req.t('settings.validation.genieAcsAuthUsername'))
        );
      }

      const salvo = await GenieAcsAuthService.saveConfig({
        authType,
        username: proximo.username,
        secret: req.body?.secret
      });
      // O segredo não entra na trilha; o que entra é que a credencial mudou,
      // para qual tipo, e se passou a existir uma. É o suficiente para
      // responder "desde quando o ACS parou de aceitar a gente" sem guardar a
      // resposta de quem quiser se passar pelo painel.
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.GENIEACS_AUTH_CHANGED,
        subjectType: 'settings',
        subjectId: 'genieacs-auth',
        detail: {
          authType: salvo.authType,
          username: salvo.username,
          secretConfigured: salvo.secretConfigured
        }
      });
      return res.json(createResponse(req.t('settings.updated'), await authConfigWithManaged(salvo)));
    } catch (error) {
      console.error('Update GenieACS auth error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /**
   * `GET /api/settings/genieacs-connection` — `{ mode, modeEditable, agent }`.
   *
   * `settings.write`, como as outras duas desta conexão: é a permissão que
   * grava o `genieAcsUrl`, e o que esta tela mostra (a dica da chave, desde
   * quando o agente está fora) só serve a quem pode agir sobre ele.
   */
  static async getGenieAcsConnection(req, res) {
    try {
      return res.json(createResponse(req.t('settings.listRetrieved'), await genieAcsConnectionSnapshot()));
    } catch (error) {
      console.error('Get GenieACS connection error:', error?.message || error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError')));
    }
  }

  /**
   * `PUT /api/settings/genieacs-connection` — `{ mode: 'direct'|'agent' }`.
   *
   * Na SaaS o modo é de quem administra o GenieACS, como o endereço: 403
   * `platform_managed` se é a plataforma; o provedor com servidor próprio
   * escolhe. O túnel fica de fora aqui em qualquer caso: ele mexe na regra de
   * rede do PAINEL, e isso é só do console.
   * Sair de `agent` derruba a conexão do agente (fechamento `4003`).
   */
  static async updateGenieAcsConnection(req, res) {
    try {
      if (await platformManagesGenieAcsCurrentTenant()) return platformManagedResponse(req, res);
      const mode = req.body?.mode;
      if (!PROVIDER_CONNECTION_MODES.includes(mode)) {
        return res.status(400).json(
          createErrorResponse(req.t('settings.validation.genieAcsConnectionMode'), null, 'invalid_mode')
        );
      }
      const antes = await GenieAcsConnection.mode();
      if (antes !== mode) {
        await GenieAcsConnection.setMode(mode);
        afterModeChange(antes, mode);
        forgetSharedAcs();
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.GENIEACS_CONNECTION_CHANGED,
          subjectType: 'settings',
          subjectId: 'genieacs-connection',
          detail: { from: antes, to: mode }
        });
      }
      return res.json(createResponse(req.t('settings.updated'), await genieAcsConnectionSnapshot()));
    } catch (error) {
      console.error('Update GenieACS connection error:', error?.message || error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError')));
    }
  }

  /**
   * `POST /api/settings/genieacs-connection/agent-token` — 201 `{ token, agent }`.
   *
   * Nas duas edições: quem instala o agente é o provedor, na rede dele, e é
   * ele quem precisa da chave — inclusive para trocá-la se vazar. Só com o
   * modo em `agent` (senão 409 `mode_not_agent`): uma chave gerada para um
   * modo que não a usa é uma credencial esquecida esperando alguém ligar o
   * modo. A chave aparece só nesta resposta; a trilha guarda a dica.
   */
  static async generateGenieAcsAgentToken(req, res) {
    try {
      if ((await GenieAcsConnection.mode()) !== 'agent') {
        return res.status(409).json(
          createErrorResponse(req.t('settings.genieAcsAgentModeRequired'), null, 'mode_not_agent')
        );
      }
      const { token, agent } = await issueAgentToken();
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.GENIEACS_AGENT_TOKEN_GENERATED,
        subjectType: 'settings',
        subjectId: 'genieacs-connection',
        detail: { tokenHint: agent.tokenHint }
      });
      return res.status(201).json(createResponse(req.t('settings.updated'), { token, agent }));
    } catch (error) {
      console.error('Generate GenieACS agent token error:', error?.message || error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError')));
    }
  }

  static async getAllSettings(req, res) {
    try {
      // Só as chaves que esta rota também grava. A tabela guarda estado
      // interno (`onboardingWizardDoneAt`, `deviceScopeTag`…), e a tela de
      // configurações regrava tudo o que lê: uma chave interna na lista virava
      // um PUT recusado ("chave não suportada") que interrompia o salvar no
      // meio — antes de chegar à geração de IDs, que vai por último.
      const all = await Setting.getAll();
      const settings = Object.fromEntries(Object.entries(all).filter(([key]) => ALLOWED_SETTING_KEYS.has(key)));
      return res.json(
        createResponse(req.t('settings.listRetrieved'), settings)
      );
    } catch (error) {
      console.error('Get all settings error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('settings.listFailed'), error.message)
      );
    }
  }

  static async getSettingByKey(req, res) {
    try {
      const { key } = req.params;
      
      if (!key) {
        return res.status(400).json(
          createErrorResponse(req.t('settings.keyRequired'))
        );
      }
      if (!ALLOWED_SETTING_KEYS.has(key)) {
        return res.status(404).json(createErrorResponse(req.t('settings.notFound')));
      }

      const value = await Setting.getByKey(key);
      
      if (value === null) {
        return res.status(404).json(
          createErrorResponse(req.t('settings.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('settings.retrieved'), { [key]: value })
      );
    } catch (error) {
      console.error('Get setting error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('settings.getFailed'), error.message)
      );
    }
  }

  static async createSetting(req, res) {
    try {
      const { key, value } = req.body;
      
      if (!key || value === undefined || value === null) {
        return res.status(400).json(
          createErrorResponse(req.t('settings.keyValueRequired'))
        );
      }

      if (await refusesPlatformKey(key)) return platformManagedResponse(req, res);

      const validated = validateSetting(String(key), value);
      if (validated.errorKey) {
        return res.status(400).json(createErrorResponse(req.t(validated.errorKey)));
      }
      const recusada = await refusesTakenOrigin(req, res, key, validated.value);
      if (recusada) return recusada;

      const teto = await auditRetentionAboveCap(String(key), validated.value);
      if (teto !== null) {
        return res.status(422).json(createErrorResponse(
          req.t('settings.validation.auditRetentionAboveCap', { max: teto }), null, 'retention_above_cap'
        ));
      }

      await Setting.create(key, validated.value);
      return res.json(
        createResponse(req.t('settings.created'), { [key]: validated.value })
      );
    } catch (error) {
      console.error('Create setting error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('settings.createFailed'), error.message)
      );
    }
  }

  static async updateSetting(req, res) {
    try {
      const { key } = req.params;
      const { value } = req.body;
      
      if (!key || value === undefined || value === null) {
        return res.status(400).json(
          createErrorResponse(req.t('settings.keyValueRequired'))
        );
      }

      if (await refusesPlatformKey(key)) return platformManagedResponse(req, res);

      const validated = validateSetting(String(key), value);
      if (validated.errorKey) {
        return res.status(400).json(createErrorResponse(req.t(validated.errorKey)));
      }
      const recusada = await refusesTakenOrigin(req, res, key, validated.value);
      if (recusada) return recusada;

      const teto = await auditRetentionAboveCap(String(key), validated.value);
      if (teto !== null) {
        return res.status(422).json(createErrorResponse(
          req.t('settings.validation.auditRetentionAboveCap', { max: teto }), null, 'retention_above_cap'
        ));
      }

      const updated = await Setting.update(key, validated.value);
      
      if (!updated) {
        return res.status(404).json(
          createErrorResponse(req.t('settings.notFound'))
        );
      }

      // Só a URL do ACS, e não toda chave que passa por aqui: a trilha existe
      // para as ações sensíveis, e virar log de toda edição de configuração a
      // encheria de linhas sobre o nome do painel e os caminhos de parâmetro
      // virtual — que é como uma trilha deixa de ser lida. Mudar para onde o
      // painel fala é outra coisa: é para onde vão as credenciais dos
      // assinantes daquele provedor.
      if (key === 'genieAcsUrl') {
        forgetSharedAcs();
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.GENIEACS_URL_CHANGED,
          subjectType: 'settings',
          subjectId: key,
          detail: { url: validated.value }
        });
      }

      return res.json(
        createResponse(req.t('settings.updated'), { [key]: validated.value })
      );
    } catch (error) {
      console.error('Update setting error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('settings.updateFailed'), error.message)
      );
    }
  }

  /**
   * Como está a sincronização de IDs de cliente: ligada ou não, se há uma
   * passada em curso e como terminou a última — com o motivo traduzido,
   * quando falhou.
   */
  static async customerIdSyncStatus(req, res) {
    try {
      const enabled = await CustomerService.isAutoGenerationEnabled();
      const status = await CustomerIdSyncJob.status(currentTenantId() ?? 'default');
      const last = status.last && !status.last.ok
        ? {
            ...status.last,
            message: req.t(
              status.last.reasonKey || 'settings.customerIdSyncFailed',
              status.last.status ? { status: status.last.status } : undefined
            )
          }
        : status.last;
      return res.json(createResponse(req.t('settings.listRetrieved'), { enabled, ...status, last }));
    } catch (error) {
      console.error('Customer ID sync status error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  static async syncCustomerIds(req, res) {
    try {
      const enabled = await CustomerService.isAutoGenerationEnabled();
      if (!enabled) {
        return res.json(createResponse(req.t('settings.customerIdSyncDisabled'), {
          enabled: false,
          total: 0,
          existing: 0,
          generated: 0,
          pending: 0
        }));
      }
      const result = await CustomerIdSyncJob.run(currentTenantId() ?? 'default');
      if (result.running) {
        return res.json(createResponse(req.t('settings.customerIdSyncRunning'), { enabled: true, running: true }));
      }
      return res.json(createResponse(
        result.pending
          ? req.t('settings.customerIdSyncedPending', { count: result.pending })
          : req.t('settings.customerIdSynced'),
        result
      ));
    } catch (error) {
      console.error('Customer ID sync error:', error);
      // O motivo vai classificado, também em produção: é o que diz ao operador
      // onde olhar. O texto cru do erro continua só no log (e no `error` do
      // modo desenvolvimento), porque pode carregar host e URL do ACS.
      const reason = classifySyncError(error);
      return res.status(502).json({
        ...createErrorResponse(
          req.t(reason.reasonKey, reason.status ? { status: reason.status } : undefined),
          translateError(req.t, error),
          reason.code
        ),
        ...(reason.status ? { status: reason.status } : {})
      });
    }
  }

  static async deleteSetting(req, res) {
    try {
      const { key } = req.params;
      
      if (!key) {
        return res.status(400).json(
          createErrorResponse(req.t('settings.keyRequired'))
        );
      }
      if (!ALLOWED_SETTING_KEYS.has(key)) {
        return res.status(404).json(createErrorResponse(req.t('settings.notFound')));
      }
      if (await refusesPlatformKey(key)) return platformManagedResponse(req, res);

      const deleted = await Setting.delete(key);
      
      if (!deleted) {
        return res.status(404).json(
          createErrorResponse(req.t('settings.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('settings.deleted'))
      );
    } catch (error) {
      console.error('Delete setting error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('settings.deleteFailed'), error.message)
      );
    }
  }

  static async testGenieAcsConnection(req, res) {
    try {
      // Na SaaS, com o ACS da plataforma, o provedor não escolhe para onde o
      // painel fala: testa o endereço que a plataforma gravou, e o corpo do
      // request é ignorado. É o que mantém o botão útil ("o ACS está
      // respondendo?") sem ele virar uma sonda para endereços que o provedor
      // não pode gravar. Com ACS próprio ele testa o que digitou, como na
      // self-hosted — pelo mesmo guarda de saída.
      const url = (await platformManagesGenieAcsCurrentTenant())
        ? await DeviceService.getGenieAcsUrl().catch(() => null)
        : req.body?.url;
      const { status, body } = await probeGenieAcs(req.t, url);
      return res.status(status).json(body);
    } catch (error) {
      console.error('Test GenieACS connection error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }
}

/**
 * O teste de conexão no modo agente: um `GET /devices?limit=1` pelo conector,
 * com a credencial e o escopo de sempre. As respostas seguem as do teste
 * direto (mesmas frases, mesmos status), mais o 503 de agente desconectado.
 */
async function probeViaAgent(t, conector) {
  const reply = (status, body) => ({ status, body });
  try {
    const response = await conector.request('devices', { query: { limit: 1 }, timeoutMs: 10_000 });
    if (!response.ok) {
      return reply(502, createErrorResponse(
        t('settings.connectionStatus', { status: response.status }),
        t('settings.connectionTestFailed')
      ));
    }
    const data = await response.json().catch(() => null);
    return Array.isArray(data)
      ? reply(200, createResponse(t('settings.connectionSuccess'), { deviceCount: data.length }))
      : reply(200, createResponse(t('settings.connectionUnexpectedFormat')));
  } catch (error) {
    if (isAgentOffline(error)) return reply(503, acsAgentOfflineBody(error, t('device.acsAgentOffline')));
    if (error?.agentCode === 'timeout' || error?.name === 'TimeoutError') {
      return reply(504, createErrorResponse(t('settings.connectionTimeout')));
    }
    if (error?.agentCode === 'upstream_unreachable') {
      return reply(502, createErrorResponse(t('settings.connectionRefused')));
    }
    return reply(502, createErrorResponse(t('settings.connectionTestFailed')));
  }
}

/**
 * Pergunta ao GenieACS em `url` se ele responde, com o mesmo guarda de saída
 * de toda outra chamada. Devolve `{ status, body }` em vez de escrever na
 * resposta, porque o console chama isto em nome de um provedor — dentro do
 * `runInTenant` dele, com a credencial dele — e responde pela própria rota.
 */
export async function probeGenieAcs(t, url) {
  const reply = (status, body) => ({ status, body });

  // No modo agente não há endereço a testar daqui: quem chega ao GenieACS é o
  // agente, na rede do provedor. O botão testa esse caminho inteiro — o mesmo
  // que a lista de equipamentos usa —, e a URL do corpo não entra em nada.
  const conector = await connectorFor();
  if (conector.mode === 'agent') return probeViaAgent(t, conector);

  if (!url) {
    return reply(400,
      createErrorResponse(t('settings.urlRequired'))
    );
  }

  let testUrl;
  try {
    testUrl = new URL(String(url).trim());
  } catch {
    return reply(400,
      createErrorResponse(t('settings.urlInvalid'))
    );
  }

  if (!['http:', 'https:'].includes(testUrl.protocol)) {
    return reply(400,
      createErrorResponse(t('settings.urlSchemeUnsupported'))
    );
  }

  if (testUrl.username || testUrl.password) {
    return reply(400,
      createErrorResponse(t('settings.urlCredentialsUnsupported'))
    );
  }

  testUrl.pathname = '/devices';
  testUrl.search = '';
  testUrl.hash = '';
  testUrl.searchParams.set('limit', '1');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    // The URL under test arrives in the request body, so this is the one
    // GenieACS call whose destination is named by the caller rather than by
    // stored settings. It goes through the same guard as every other, or
    // the "test connection" button is a probe for anything our network can
    // reach that the configured URL is not allowed to be.
    // A credencial guardada só acompanha o teste quando o endereço testado
    // é a MESMA origem que está salva.
    //
    // Não é zelo: a URL vem no corpo do request, então mandar a credencial
    // para qualquer endereço faria deste botão um jeito de LER o segredo —
    // aponte para um servidor seu, leia o header. Ele é gravado para nunca
    // mais ser exibido, e um administrador recuperaria assim o que um
    // antecessor configurou. Contra a mesma origem já salva não há o que
    // extrair: o segredo já vai para lá a cada requisição do painel.
    //
    // O efeito colateral é honesto e vale dizer na tela: testar um endereço
    // NOVO vai sem autenticação, e contra uma NBI que exige credencial isso
    // responde 401. É a resposta certa — a configuração daquele endereço
    // ainda não foi salva, então não há credencial dele para usar.
    const salva = await DeviceService.getGenieAcsUrl().catch(() => null);
    const mesmaOrigem = (() => {
      try { return salva ? new URL(salva).origin === testUrl.origin : false; } catch { return false; }
    })();
    // O modo do provedor (túnel: rede privada de cliente liberada) vale para o
    // teste pela mesma regra da credencial: só na origem JÁ SALVA. Um endereço
    // qualquer vindo no corpo, com a rede privada liberada, faria do botão uma
    // sonda da rede do painel — inclusive do túnel de outro provedor.
    const modo = mesmaOrigem ? (await connectorFor()).egressOptions() : {};
    const response = await GenieAcsEgress.fetch(testUrl, {
      method: 'GET',
      headers: mesmaOrigem
        ? await GenieAcsAuthService.nbiHeaders()
        : { Accept: 'application/json' },
      signal: controller.signal,
      ...modo
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return reply(502,
        createErrorResponse(
          t('settings.connectionStatus', { status: response.status }),
          t('settings.connectionTestFailed')
        )
      );
    }

    const data = await response.json();

    if (Array.isArray(data)) {
      return reply(200,
        createResponse(t('settings.connectionSuccess'), {
          deviceCount: data.length
        })
      );
    } else {
      return reply(200,
        createResponse(t('settings.connectionUnexpectedFormat'))
      );
    }
  } catch (error) {
    clearTimeout(timeoutId);

    // A refused address is the operator's own misconfiguration, not an
    // upstream outage, so it answers 400 with the reason rather than 502.
    if (error.code === EGRESS_REFUSED) {
      return reply(400,
        createErrorResponse(t('settings.urlEgressRefused'), error.message)
      );
    }

    if (error.name === 'AbortError' || error.type === 'request-timeout') {
      return reply(504,
        createErrorResponse(t('settings.connectionTimeout'))
      );
    }

    if (error.code === 'ECONNREFUSED') {
      return reply(502,
        createErrorResponse(t('settings.connectionRefused'))
      );
    }

    return reply(502,
      createErrorResponse(t('settings.connectionFailed'), error.message)
    );
  }
}

export default SettingsController;
