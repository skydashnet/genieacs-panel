import { randomBytes } from 'node:crypto';
import AppState from '../models/AppState.js';
import CustomerAccount from '../models/CustomerAccount.js';
import ProvisioningProfile from '../models/ProvisioningProfile.js';
import ProvisioningRun from '../models/ProvisioningRun.js';
import SgpLink from '../models/SgpLink.js';
import CustomerService from './customerService.js';
import CustomerWifiCredentialService from './customerWifiCredentialService.js';
import DeviceService from './deviceService.js';
import DeviceTagService from './deviceTagService.js';
import SgpService from './sgpService.js';
import Setting from '../models/Setting.js';
import { TranslatableError } from '../i18n/index.js';
import { createSecretBox } from '../utils/secretBox.js';
import { TenantCache } from '../config/tenantCache.js';
import { RUN_RETENTION } from '../config/retention.js';

const CONFIG_KEY = 'provisioning_config';
const CONFIG_CACHE_TTL_MS = 30_000;
const INTERRUPTED_AFTER_MS = 10 * 60 * 1000;

/**
 * Wi-Fi and admin passwords come last so a WAN write, which changes the PPPoE
 * credentials and can bounce the session TR-069 itself rides on, cannot cost
 * us the steps queued behind it. The ONT reaches us already dialling, so there
 * is no reason to lead with WAN.
 */
export const PROVISIONING_STEPS = Object.freeze(['wifi', 'credentials', 'wan']);

/** Minutes to wait before each retry; the length also caps the attempts. */
const RETRY_BACKOFF_MINUTES = Object.freeze([5, 15, 60, 240]);

export const DEFAULT_PROVISIONING_CONFIG = Object.freeze({
  enabled: false,
  intervalSeconds: 300,
  batchSize: 5,
  informWindowHours: 24,
  markerTag: 'SkyGenProvisioned',
  verifyEnabled: true,
  verifyDelaySeconds: 90,
  requirePppoePassword: false,
  runRetentionDays: RUN_RETENTION.defaultDays
});

const profileBox = createSecretBox('skygenpanel-provisioning-profile-v1');

/**
 * `createSecretBox` names its columns after the customer password it was
 * written for, but a profile holds two independent secrets, so each one is
 * mapped onto its own column prefix.
 */
function encryptTo(prefix, plaintext) {
  const box = profileBox.encrypt(plaintext);
  return {
    [`${prefix}_ciphertext`]: box.password_ciphertext,
    [`${prefix}_iv`]: box.password_iv,
    [`${prefix}_tag`]: box.password_tag,
    [`${prefix}_key_version`]: box.password_key_version
  };
}

function decryptFrom(prefix, row) {
  return profileBox.decrypt({
    password_ciphertext: row?.[`${prefix}_ciphertext`],
    password_iv: row?.[`${prefix}_iv`],
    password_tag: row?.[`${prefix}_tag`],
    password_key_version: row?.[`${prefix}_key_version`]
  });
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function asText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

// Deliberately broad: `LoginSuperPass` is as much a credential as `Password`,
// and a path this misses ends up in a stored run an operator can read.
const SECRET_PATH_PATTERN = /pass|presharedkey|senha|secret|key$/i;

/** A generated password an operator can read back later from the Wi-Fi vault. */
function randomPassword(length = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

class ProvisioningService {
  static configCache = new TenantCache(CONFIG_CACHE_TTL_MS);

  /**
   * Forget the provider in scope — its own configuration changed.
   * To forget every provider's, reach for `configCache.clear()`; that is a
   * reset, not a save, and the two must not share a name.
   */
  static invalidateConfigCache() {
    this.configCache.invalidate();
  }

  static async getConfig() {
    const cached = this.configCache.get();
    if (cached) return cached;
    let stored = {};
    const raw = await AppState.get(CONFIG_KEY);
    if (raw) {
      try {
        stored = JSON.parse(raw);
      } catch {
        stored = {};
      }
    }
    const config = {
      enabled: stored.enabled === true,
      intervalSeconds: clampNumber(stored.intervalSeconds, 60, 86_400, 300),
      batchSize: clampNumber(stored.batchSize, 1, 50, 5),
      informWindowHours: clampNumber(stored.informWindowHours, 1, 720, 24),
      markerTag: this.normalizeMarkerTag(stored.markerTag),
      verifyEnabled: stored.verifyEnabled !== false,
      verifyDelaySeconds: clampNumber(stored.verifyDelaySeconds, 30, 3600, 90),
      requirePppoePassword: stored.requirePppoePassword === true,
      runRetentionDays: clampNumber(stored.runRetentionDays, RUN_RETENTION.minDays, RUN_RETENTION.maxDays, RUN_RETENTION.defaultDays),
      updatedAt: stored.updatedAt || null
    };
    this.configCache.set(config);
    return config;
  }

  static normalizeMarkerTag(value) {
    const text = asText(value) || DEFAULT_PROVISIONING_CONFIG.markerTag;
    // `mutateDeviceTag` rejects anything else, and a rejected tag would leave
    // every provisioned device looking unprovisioned to the poller.
    if (!/^[A-Za-z0-9_]+$/.test(text)) {
      throw new TranslatableError('provisioning.error.markerTagInvalid', null, {
        status: 400,
        code: 'invalid_marker_tag'
      });
    }
    return text;
  }

  static async getPublicConfig() {
    return this.getConfig();
  }

  static async saveConfig(patch = {}) {
    const current = await this.getConfig();
    const next = {
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
      intervalSeconds: patch.intervalSeconds === undefined
        ? current.intervalSeconds
        : clampNumber(patch.intervalSeconds, 60, 86_400, 300),
      batchSize: patch.batchSize === undefined
        ? current.batchSize
        : clampNumber(patch.batchSize, 1, 50, 5),
      informWindowHours: patch.informWindowHours === undefined
        ? current.informWindowHours
        : clampNumber(patch.informWindowHours, 1, 720, 24),
      markerTag: patch.markerTag === undefined
        ? current.markerTag
        : this.normalizeMarkerTag(patch.markerTag),
      verifyEnabled: patch.verifyEnabled === undefined
        ? current.verifyEnabled
        : patch.verifyEnabled === true,
      verifyDelaySeconds: patch.verifyDelaySeconds === undefined
        ? current.verifyDelaySeconds
        : clampNumber(patch.verifyDelaySeconds, 30, 3600, 90),
      requirePppoePassword: patch.requirePppoePassword === undefined
        ? current.requirePppoePassword
        : patch.requirePppoePassword === true,
      runRetentionDays: patch.runRetentionDays === undefined
        ? current.runRetentionDays
        : clampNumber(patch.runRetentionDays, RUN_RETENTION.minDays, RUN_RETENTION.maxDays, RUN_RETENTION.defaultDays),
      updatedAt: new Date().toISOString()
    };

    // Turning the poller on with no profile would walk the fleet and skip
    // every device, which reads as a broken feature rather than an empty one.
    if (next.enabled && (await ProvisioningProfile.countEnabled()) === 0) {
      throw new TranslatableError('provisioning.error.noEnabledProfile', null, {
        status: 400,
        code: 'no_profile'
      });
    }

    await AppState.upsert(CONFIG_KEY, JSON.stringify(next));
    this.invalidateConfigCache();
    return this.getConfig();
  }

  // ---------------------------------------------------------------- profiles

  static serializeProfile(input, existing = null) {
    const name = asText(input.name) ?? existing?.name;
    if (!name) {
      throw new TranslatableError('provisioning.error.profileNameRequired', null, { status: 400 });
    }
    const row = {
      name: name.slice(0, 128),
      plan_patterns: JSON.stringify(
        (Array.isArray(input.planPatterns) ? input.planPatterns : [])
          .map((pattern) => asText(pattern))
          .filter(Boolean)
          .slice(0, 32)
      ),
      is_default: input.isDefault === true,
      priority: clampNumber(input.priority, 0, 1000, existing?.priority ?? 10),
      enabled: input.enabled === undefined ? (existing?.enabled ?? true) : input.enabled === true,
      apply_wan: input.applyWan === undefined ? (existing?.apply_wan ?? true) : input.applyWan === true,
      apply_pppoe_password: input.applyPppoePassword === undefined
        ? (existing?.apply_pppoe_password ?? true)
        : input.applyPppoePassword === true,
      wan_name: asText(input.wanName),
      wan_vlan_id: input.wanVlanId === null || input.wanVlanId === undefined || input.wanVlanId === ''
        ? null
        : clampNumber(input.wanVlanId, 0, 4094, 0),
      wan_service_list: asText(input.wanServiceList)?.slice(0, 128) ?? null,
      wan_connection_type: ['IP_Routed', 'PPPoE_Bridged'].includes(input.wanConnectionType)
        ? input.wanConnectionType
        : null,
      wan_nat_enabled: typeof input.wanNatEnabled === 'boolean' ? input.wanNatEnabled : null,
      apply_wifi: input.applyWifi === undefined ? (existing?.apply_wifi ?? true) : input.applyWifi === true,
      wifi_indexes: JSON.stringify(
        (Array.isArray(input.wifiIndexes) ? input.wifiIndexes : [])
          .map((index) => Number(index))
          .filter((index) => Number.isInteger(index) && index >= 1 && index <= 8)
          .slice(0, 8)
      ),
      wifi_ssid_template: asText(input.wifiSsidTemplate)?.slice(0, 64) ?? null,
      wifi_password_mode: ['fixed', 'random', 'keep'].includes(input.wifiPasswordMode)
        ? input.wifiPasswordMode
        : (existing?.wifi_password_mode ?? 'random'),
      apply_credentials: input.applyCredentials === undefined
        ? (existing?.apply_credentials ?? false)
        : input.applyCredentials === true,
      credential_targets: ['super', 'user', 'both'].includes(input.credentialTargets)
        ? input.credentialTargets
        : (existing?.credential_targets ?? 'super'),
      description: asText(input.description)
    };

    if (input.wifiPassword !== undefined) {
      const password = String(input.wifiPassword);
      if (password === '') {
        Object.assign(row, {
          wifi_password_ciphertext: null, wifi_password_iv: null, wifi_password_tag: null,
          wifi_password_key_version: null
        });
      } else {
        if (password.length < 8 || password.length > 63) {
          throw new TranslatableError('provisioning.error.wifiPasswordInvalid', null, { status: 400 });
        }
        Object.assign(row, encryptTo('wifi_password', password));
      }
    }
    if (input.cpePassword !== undefined) {
      const password = String(input.cpePassword);
      if (password === '') {
        Object.assign(row, {
          cpe_password_ciphertext: null, cpe_password_iv: null, cpe_password_tag: null,
          cpe_password_key_version: null
        });
      } else {
        if (password.length < 1 || password.length > 256) {
          throw new TranslatableError('provisioning.error.cpePasswordInvalid', null, { status: 400 });
        }
        Object.assign(row, encryptTo('cpe_password', password));
      }
    }

    if (row.apply_wifi && row.wifi_password_mode === 'fixed') {
      const hasStored = Boolean(row.wifi_password_ciphertext ?? existing?.wifi_password_ciphertext);
      if (!hasStored) {
        throw new TranslatableError('provisioning.error.wifiPasswordRequired', null, { status: 400 });
      }
    }
    if (row.apply_credentials) {
      const hasStored = Boolean(row.cpe_password_ciphertext ?? existing?.cpe_password_ciphertext);
      if (!hasStored) {
        throw new TranslatableError('provisioning.error.cpePasswordRequired', null, { status: 400 });
      }
    }
    return row;
  }

  /** Profile view for the API: flags and patterns, never the stored secrets. */
  static publicProfile(profile) {
    if (!profile) return null;
    return {
      id: profile.id,
      name: profile.name,
      planPatterns: profile.plan_patterns,
      isDefault: profile.is_default,
      priority: profile.priority,
      enabled: profile.enabled,
      applyWan: profile.apply_wan,
      applyPppoePassword: profile.apply_pppoe_password,
      wanName: profile.wan_name,
      wanVlanId: profile.wan_vlan_id,
      wanServiceList: profile.wan_service_list,
      wanConnectionType: profile.wan_connection_type,
      wanNatEnabled: profile.wan_nat_enabled,
      applyWifi: profile.apply_wifi,
      wifiIndexes: profile.wifi_indexes,
      wifiSsidTemplate: profile.wifi_ssid_template,
      wifiPasswordMode: profile.wifi_password_mode,
      applyCredentials: profile.apply_credentials,
      credentialTargets: profile.credential_targets,
      description: profile.description,
      wifiPasswordConfigured: Boolean(
        profile.wifi_password_ciphertext && profile.wifi_password_iv && profile.wifi_password_tag
      ),
      cpePasswordConfigured: Boolean(
        profile.cpe_password_ciphertext && profile.cpe_password_iv && profile.cpe_password_tag
      ),
      updatedAt: profile.updated_at ? new Date(profile.updated_at).toISOString() : null
    };
  }

  /**
   * Run view for the API. Steps are already redacted on their way in.
   *
   * `error` and each step's `detail` hold translation keys, because the run
   * that produced them had no request and therefore no language. `translate`
   * is the caller's bound translator, so the message is rendered in the
   * reader's language here instead of leaking a key into the interface.
   */
  static publicRun(run, translate = null) {
    if (!run) return null;
    const render = (value) => {
      if (!value) return null;
      return translate ? translate(value) : value;
    };
    return {
      id: run.id,
      deviceId: run.device_id,
      contract: run.contract,
      profileId: run.profile_id,
      profileName: run.profile_name,
      trigger: run.trigger,
      status: run.status,
      attemptCount: run.attempt_count,
      nextAttemptAt: run.next_attempt_at ? new Date(run.next_attempt_at).toISOString() : null,
      steps: (run.steps ?? []).map((step) => ({
        ...step,
        detail: render(step.detail)
      })),
      error: run.error,
      errorMessage: render(run.error),
      startedAt: run.started_at ? new Date(run.started_at).toISOString() : null,
      finishedAt: run.finished_at ? new Date(run.finished_at).toISOString() : null,
      updatedAt: run.updated_at ? new Date(run.updated_at).toISOString() : null
    };
  }

  /**
   * Highest-priority enabled profile whose pattern appears in the SGP plan
   * name, then the explicit default. Matching is substring rather than regex:
   * an operator-supplied regex is both a footgun and a denial-of-service risk,
   * and the vendor table already trained operators on substrings.
   */
  static async matchProfile(planName) {
    const profiles = await ProvisioningProfile.getEnabled();
    const plan = String(planName ?? '').toLowerCase();
    if (plan) {
      const matched = profiles.find((profile) => profile.plan_patterns
        .some((pattern) => plan.includes(String(pattern).toLowerCase())));
      if (matched) return matched;
    }
    return profiles.find((profile) => profile.is_default) || null;
  }

  static renderTemplate(template, context) {
    if (!template) return null;
    return String(template).replace(/\{(\w+)\}/g, (match, name) => {
      const value = context[name];
      return value === undefined || value === null ? '' : String(value);
    }).trim();
  }

  /** Strips anything that looks like a secret before a step reaches the DB. */
  static redactSteps(steps) {
    return (steps || []).map((step) => ({
      ...step,
      detail: step.detail ? String(step.detail).slice(0, 2000) : null,
      parameters: (step.parameters || []).map((parameter) => {
        // A verification pass appends to steps that were redacted on their way
        // into the database, so both the raw tuple and the stored object shape
        // reach this point.
        const [path, value] = Array.isArray(parameter)
          ? parameter
          : [parameter?.path, parameter?.value];
        return { path, value: SECRET_PATH_PATTERN.test(String(path)) ? '••••' : value };
      })
    }));
  }

  // --------------------------------------------------------------- planning

  /**
   * Works out everything a run would do without writing anything: the SGP
   * contract behind the CPE's PPPoE login, the profile its plan matches, and
   * the parameter list each step would queue. The real run executes this same
   * plan, so an operator confirming a preview is confirming what will happen.
   */
  static async buildPlan(deviceId, { item = null } = {}) {
    const device = item ?? await DeviceService.fetchDeviceDocument(deviceId);
    const settings = await Setting.getAll();
    const loginPath = settings.vpPppoeUsername;
    const wanIndex = DeviceService.findPppoeWanIndex(device);
    const login = asText(
      (loginPath ? DeviceService.getParameterValue(device, loginPath) : null)
      ?? (wanIndex
        ? DeviceService.findWanParameter(device, this.wanBasePath(wanIndex), 'Username')?.value
        : null)
    );

    if (!login) {
      return { deviceId, device, skip: 'no_pppoe_login' };
    }

    const contract = await SgpService.lookupContractForProvisioning({ login });
    if (!contract) return { deviceId, device, login, skip: 'no_contract' };

    const profile = await this.matchProfile(contract.plan);
    if (!profile) return { deviceId, device, login, contract, skip: 'no_profile' };

    const config = await this.getConfig();
    if (profile.apply_wan && !wanIndex) {
      return { deviceId, device, login, contract, profile, skip: 'no_pppoe_wan' };
    }
    if (config.requirePppoePassword && profile.apply_pppoe_password && !contract.loginPassword) {
      return { deviceId, device, login, contract, profile, skip: 'no_pppoe_password' };
    }

    const serial = asText(DeviceService.normalizeParameterValue(device._deviceId?._SerialNumber));
    const templateContext = {
      contract: contract.contract,
      login,
      name: contract.name ?? '',
      plan: contract.plan ?? '',
      serial: serial ?? '',
      serial4: serial ? serial.slice(-4) : ''
    };

    const steps = [];
    if (profile.apply_wifi && profile.wifi_indexes.length > 0) {
      const ssid = this.renderTemplate(profile.wifi_ssid_template, templateContext);
      const password = profile.wifi_password_mode === 'fixed'
        ? decryptFrom('wifi_password', profile)
        : profile.wifi_password_mode === 'random'
          ? randomPassword()
          : null;
      for (const index of profile.wifi_indexes) {
        steps.push({
          step: 'wifi',
          index,
          form: { ssid: ssid || undefined, password: password || undefined }
        });
      }
    }
    if (profile.apply_credentials) {
      const password = decryptFrom('cpe_password', profile);
      const targets = profile.credential_targets === 'both'
        ? ['super', 'user']
        : [profile.credential_targets];
      for (const target of targets) {
        steps.push({ step: 'credentials', target, form: { password } });
      }
    }
    if (profile.apply_wan) {
      steps.push({
        step: 'wan',
        wanIndex,
        form: {
          name: profile.wan_name ?? undefined,
          username: login,
          password: profile.apply_pppoe_password && contract.loginPassword
            ? contract.loginPassword
            : undefined,
          vlanEnabled: profile.wan_vlan_id !== null && profile.wan_vlan_id > 0,
          vlanId: profile.wan_vlan_id ?? undefined,
          serviceList: profile.wan_service_list ?? undefined,
          connectionType: profile.wan_connection_type ?? undefined,
          natEnabled: profile.wan_nat_enabled === null ? undefined : profile.wan_nat_enabled
        }
      });
    }

    return { deviceId, device, login, contract, profile, wanIndex, templateContext, steps };
  }

  static wanBasePath(wanIndex) {
    const [devKey, connKey, , instanceKey] = String(wanIndex).split('.');
    return `InternetGatewayDevice.WANDevice.${devKey}.WANConnectionDevice.${connKey}`
      + `.WANPPPConnection.${instanceKey}`;
  }

  /**
   * Dry run for the operator. Returns the parameter list each step would
   * write, with every secret masked, plus whether SGP actually returned a
   * PPPoE password — a boolean, never the value, so the field name can be
   * diagnosed without exposing the credential.
   */
  static async preview(deviceId) {
    const plan = await this.buildPlan(deviceId);
    if (plan.skip) {
      return {
        deviceId,
        skip: plan.skip,
        contract: plan.contract ? SgpService.publicContract(plan.contract) : null,
        profile: plan.profile ? { id: plan.profile.id, name: plan.profile.name } : null,
        login: plan.login ?? null,
        steps: []
      };
    }
    const steps = [];
    for (const step of plan.steps) {
      const result = await this.runStep(plan, step, { dryRun: true });
      steps.push({
        step: step.step,
        target: step.index ?? step.target ?? step.wanIndex ?? null,
        status: result.status,
        detail: result.detail,
        parameters: result.parameters
      });
    }
    return {
      deviceId,
      login: plan.login,
      contract: SgpService.publicContract(plan.contract),
      profile: { id: plan.profile.id, name: plan.profile.name },
      pppoePasswordFound: Boolean(plan.contract.loginPassword),
      steps: this.redactSteps(steps)
    };
  }

  // -------------------------------------------------------------- execution

  /**
   * Applies (or, in a dry run, only computes) one step. A step whose target
   * parameter does not exist on this CPE is `skipped` with a reason rather
   * than failed: not every ONT exposes a VLAN or a service-list node, and
   * failing the run for that would make the feature unusable on those models.
   */
  static async runStep(plan, step, { dryRun = false } = {}) {
    const options = { dryRun, item: plan.device };
    try {
      let result;
      if (step.step === 'wifi') {
        result = await DeviceService.updateWifiConfig(plan.deviceId, step.index, step.form, options);
      } else if (step.step === 'credentials') {
        result = await DeviceService.updateCredentials(
          plan.deviceId, step.target, step.form.password, options
        );
      } else {
        result = await DeviceService.updateWanConfig(
          plan.deviceId, step.wanIndex, step.form, options
        );
      }
      const parameters = result.parameterValues || [];
      if (parameters.length === 0) {
        // The writers only emit parameters that are writable and actually
        // changing, so an empty list means the CPE already matches. That is
        // what makes a retry of a partly-applied run a no-op.
        return { status: 'unchanged', detail: null, parameters: [] };
      }
      if (dryRun) return { status: 'planned', detail: null, parameters };

      const posted = await DeviceService.postProvisioningTask(plan.deviceId, {
        name: 'setParameterValues',
        parameterValues: parameters
      });
      return {
        status: posted.applied ? 'applied' : 'queued',
        detail: posted.applied ? null : `GenieACS accepted the task with status ${posted.status}`,
        parameters
      };
    } catch (error) {
      const message = error?.translationKey || error?.message || 'unknown error';
      // A missing parameter or an absent virtual-parameter mapping is a
      // property of the model, not a failure of this activation.
      const skippable = /not set in settings|Only PPPoE connections|WAN Connection path not found/i
        .test(String(error?.message ?? ''));
      return {
        status: skippable ? 'skipped' : 'failed',
        detail: message,
        parameters: []
      };
    }
  }

  /** Creates (or reuses) the run row a device is queued under. */
  static async enqueue(deviceId, { trigger = 'manual', force = false } = {}) {
    const active = await ProvisioningRun.getActiveByDeviceId(deviceId);
    if (active && !force) return active;
    return ProvisioningRun.create({
      device_id: deviceId,
      trigger,
      status: 'pending',
      attempt_count: 0,
      started_at: null,
      next_attempt_at: null
    });
  }

  static async executeRun(run) {
    const config = await this.getConfig();
    await ProvisioningRun.update(run.id, { status: 'running', started_at: new Date() });

    let plan;
    try {
      plan = await this.buildPlan(run.device_id);
    } catch (error) {
      return this.failRun(run, config, error?.translationKey || error?.message || 'unknown error');
    }

    if (plan.skip) {
      return ProvisioningRun.update(run.id, {
        status: 'skipped',
        contract: plan.contract?.contract ?? null,
        profile_id: plan.profile?.id ?? null,
        profile_name: plan.profile?.name ?? null,
        error: `provisioning.skip.${plan.skip}`,
        finished_at: new Date()
      });
    }

    // Before the steps, not after: the Wi-Fi step files its generated password
    // against this account, and there would be nothing to file it against.
    await this.ensurePortalAccount(plan);

    const steps = [];
    let failed = false;
    for (const step of plan.steps) {
      const result = await this.runStep(plan, step);
      const entry = {
        step: step.step,
        target: step.index ?? step.target ?? step.wanIndex ?? null,
        status: result.status,
        detail: result.detail,
        parameters: result.parameters,
        at: new Date().toISOString()
      };
      steps.push(entry);
      if (result.status === 'failed') {
        // Stop rather than press on: a half-written WAN is worse than a clean
        // retry, and everything already applied stays applied.
        failed = true;
        break;
      }
      if (step.step === 'wifi' && ['applied', 'queued'].includes(result.status)) {
        // A execução não vira falha por causa disto: a ONT foi configurada e
        // está no ar, e refazer tudo não traria de volta a senha. Mas a linha
        // guarda que a senha não foi arquivada, porque no modo `random` essa
        // era a única cópia e o assinante vai ligar perguntando por ela.
        const guardada = await this.rememberWifiPassword(plan, step);
        if (!guardada) entry.passwordStored = false;
      }
    }

    if (failed) {
      return this.failRun(run, config, 'provisioning.error.stepFailed', {
        steps,
        contract: plan.contract.contract,
        profileId: plan.profile.id,
        profileName: plan.profile.name
      });
    }

    await this.linkContract(plan);

    const shouldVerify = config.verifyEnabled
      && steps.some((step) => ['applied', 'queued'].includes(step.status));
    if (shouldVerify) {
      return ProvisioningRun.update(run.id, {
        status: 'awaiting_verify',
        contract: plan.contract.contract,
        profile_id: plan.profile.id,
        profile_name: plan.profile.name,
        steps: this.redactSteps(steps),
        // The deadline lives in the row, not in a timer, so a restart between
        // the write and the check resumes instead of losing the run.
        next_attempt_at: new Date(Date.now() + config.verifyDelaySeconds * 1000),
        error: null
      });
    }

    await this.markProvisioned(plan.deviceId, config);
    return ProvisioningRun.update(run.id, {
      status: 'success',
      contract: plan.contract.contract,
      profile_id: plan.profile.id,
      profile_name: plan.profile.name,
      steps: this.redactSteps(steps),
      next_attempt_at: null,
      error: null,
      finished_at: new Date()
    });
  }

  /**
   * Re-reads the CPE and confirms the values that can be read back. Passwords
   * are deliberately not verified: most CPEs return an empty or masked value
   * for `Password` and `KeyPassphrase`, so comparing them would fail every
   * run for a write that actually worked.
   */
  static async verifyRun(run) {
    const config = await this.getConfig();
    let plan;
    try {
      plan = await this.buildPlan(run.device_id);
    } catch (error) {
      return this.failRun(run, config, error?.translationKey || error?.message || 'unknown error');
    }
    if (plan.skip) {
      return this.failRun(run, config, `provisioning.skip.${plan.skip}`);
    }

    // What the plan wants, path by path. The writers differ in how they decide
    // to write — the WAN one only emits changed values, the Wi-Fi one always
    // emits the SSID — so verification compares the desired value against a
    // fresh reading rather than against whether a write would happen again.
    const expectations = [];
    for (const step of plan.steps) {
      // A credential write is a password by definition and cannot be read
      // back, so verifying it would fail every run that actually worked.
      if (step.step === 'credentials') continue;
      const result = await this.runStep(plan, step, { dryRun: true });
      for (const [path, value] of result.parameters) {
        if (SECRET_PATH_PATTERN.test(String(path))) continue;
        expectations.push({ step: step.step, path, value });
      }
    }

    const fresh = await DeviceService.fetchDeviceDocument(run.device_id);
    const mismatches = [];
    for (const expectation of expectations) {
      const actual = DeviceService.getParameterValue(fresh, expectation.path);
      if (String(actual ?? '') !== String(expectation.value ?? '')) {
        mismatches.push({
          step: expectation.step,
          parameters: [[expectation.path, expectation.value]]
        });
      }
    }

    const steps = [
      ...(run.steps || []),
      {
        step: 'verify',
        status: mismatches.length === 0 ? 'confirmed' : 'mismatch',
        detail: mismatches.length === 0
          ? null
          : mismatches.map((entry) => entry.step).join(', '),
        parameters: mismatches.flatMap((entry) => entry.parameters),
        at: new Date().toISOString()
      }
    ];

    if (mismatches.length === 0) {
      await this.markProvisioned(run.device_id, config);
      return ProvisioningRun.update(run.id, {
        status: 'success',
        steps: this.redactSteps(steps),
        next_attempt_at: null,
        error: null,
        finished_at: new Date()
      });
    }
    return this.failRun(run, config, 'provisioning.error.verificationMismatch', { steps });
  }

  /**
   * Records a failure and schedules the retry, or gives up for good once the
   * backoff table is exhausted. `failed_permanent` is what stops a device from
   * cycling forever; only an explicit operator action revives it.
   */
  static async failRun(run, config, error, extra = {}) {
    const attempts = (run.attempt_count ?? 0) + 1;
    const backoff = RETRY_BACKOFF_MINUTES[attempts - 1];
    const patch = {
      status: backoff === undefined ? 'failed_permanent' : 'pending',
      attempt_count: attempts,
      error,
      next_attempt_at: backoff === undefined ? null : new Date(Date.now() + backoff * 60_000),
      finished_at: backoff === undefined ? new Date() : null
    };
    if (extra.steps) patch.steps = this.redactSteps(extra.steps);
    if (extra.contract) patch.contract = extra.contract;
    if (extra.profileId) patch.profile_id = extra.profileId;
    if (extra.profileName) patch.profile_name = extra.profileName;
    return ProvisioningRun.update(run.id, patch);
  }

  static async markProvisioned(deviceId, config) {
    try {
      await DeviceService.mutateDeviceTag(deviceId, config.markerTag, 'POST');
    } catch (error) {
      // The tag is a convenience for the GenieACS UI and a safety net if the
      // panel database is ever rebuilt; the run row is the authority, so a
      // failure here must not undo a successful activation.
      console.warn(`Could not tag ${deviceId} as provisioned: ${error.message}`);
    }
  }

  /**
   * Guarda no cofre a senha que acabou de ser escrita na ONT.
   *
   * No modo `random` esta é a ÚNICA cópia que existe: o painel a sorteou, o
   * assinante nunca a viu, e o que não for guardado aqui está perdido — o
   * assinante fica trancado fora do próprio WiFi e o operador não tem o que
   * dizer a ele. Daí esta função ter deixado de ser silenciosa.
   *
   * O caminho que a perdia não era uma exceção, e é por isso que o `catch`
   * abaixo nunca o pegou: `CustomerService.ensureAccount` devolve `null`, sem
   * lançar, quando falta ao aparelho um dos três identificadores (o `_id`, a
   * versão de software ou o login PPPoE). `ensurePortalAccount` roda antes dos
   * passos justamente para que exista onde arquivar, mas devolvendo `null` em
   * silêncio ela não criava conta nenhuma e ninguém ficava sabendo; aqui o
   * `if (!account) return;` fechava a porta sem uma linha de log.
   *
   * Agora tenta uma vez mais criar a conta — que resolve o caso comum, o de a
   * primeira tentativa ter falhado por algo passageiro — e, quando ainda assim
   * não há onde guardar, diz isso alto e devolve `false`, que o chamador grava
   * na linha da execução. Perder a senha continua sendo possível; perdê-la sem
   * que ninguém saiba, não.
   *
   * @returns {Promise<boolean>} se a senha está guardada (ou não havia o que guardar)
   */
  static async rememberWifiPassword(plan, step) {
    if (!step.form.password) return true;
    try {
      const account = await CustomerAccount.getByDeviceId(plan.deviceId)
        || await this.ensurePortalAccount(plan);
      if (!account) {
        console.error(
          `Wi-Fi password for ${plan.deviceId} was written to the CPE but not stored: `
          + 'the device has no portal account to file it against. '
          + 'A random password is not recoverable from anywhere else.'
        );
        return false;
      }
      await CustomerWifiCredentialService.save(
        account.id, step.index, step.form.ssid ?? '', step.form.password
      );
      return true;
    } catch (error) {
      console.error(`Could not store the Wi-Fi password for ${plan.deviceId}: ${error.message}`);
      return false;
    }
  }

  /**
   * A conta do portal deste aparelho, criando-a se ainda não existir.
   *
   * Devolve a conta — ou `null` — em vez de não devolver nada, porque quem
   * chama precisa saber: o passo de WiFi arquiva a senha gerada contra ela, e
   * sem conta não há onde arquivar.
   *
   * `ensureAccount` responde `null` sem lançar quando falta ao aparelho um dos
   * três identificadores que formam a identidade do assinante, e esse silêncio
   * é o que fazia a senha sumir sem uma linha de log. O aviso abaixo nomeia o
   * que faltou, que é a única coisa que o operador pode corrigir.
   */
  static async ensurePortalAccount(plan) {
    const softwareId = DeviceService.getParameterValue(
      plan.device, 'InternetGatewayDevice.DeviceInfo.SoftwareVersion'
    );
    try {
      const account = await CustomerService.ensureAccount({
        _id: plan.deviceId,
        softwareId,
        pppoe: plan.login,
        _lastInform: plan.device?._lastInform
      });
      if (!account) {
        const faltando = [
          !plan.deviceId && 'device id',
          !softwareId && 'software version',
          !plan.login && 'PPPoE login'
        ].filter(Boolean);
        console.warn(
          `No portal account for ${plan.deviceId}: the device is missing `
          + `${faltando.join(' and ') || 'a usable identity'}.`
        );
      }
      return account;
    } catch (error) {
      console.warn(`Could not create the portal account for ${plan.deviceId}: ${error.message}`);
      return null;
    }
  }

  static async linkContract(plan) {
    try {
      const account = await CustomerAccount.getByDeviceId(plan.deviceId);
      await SgpLink.upsert(SgpService.contractToLinkRow(plan.contract, {
        deviceId: plan.deviceId,
        accountId: account?.id ?? null,
        linkMode: 'auto'
      }));
    } catch (error) {
      console.warn(`Could not link ${plan.deviceId} to its SGP contract: ${error.message}`);
      return;
    }
    await DeviceTagService.safeReconcile(plan.deviceId);
  }

  // ----------------------------------------------------------------- poller

  /**
   * CPEs that have informed recently, carry a PPPoE login, and have no run
   * that settled them.
   *
   * The filtering happens here rather than in a GenieACS query on purpose:
   * support for `$nin`/`$gt` in the query language varies between GenieACS
   * versions, and a query the server does not understand returns nothing —
   * provisioning would then stop silently. A lean projection over the fleet
   * costs about what the dashboard already costs, and fails visibly.
   */
  static async findCandidates({ limit = 5 } = {}) {
    const config = await this.getConfig();
    const settings = await Setting.getAll();
    const projection = [
      '_id',
      '_lastInform',
      '_tags',
      '_deviceId._SerialNumber',
      'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
      settings.vpPppoeUsername
    ].filter(Boolean);

    const data = await DeviceService.fetchFromGenieAcs('', { projection: projection.join(',') });
    if (!Array.isArray(data)) return [];

    const now = Date.now();
    const windowStart = now - config.informWindowHours * 3600_000;
    const eligible = [];
    for (const item of data) {
      const deviceId = item?._id;
      if (!deviceId) continue;
      const login = settings.vpPppoeUsername
        ? DeviceService.getParameterValue(item, settings.vpPppoeUsername)
        : null;
      if (!login) continue;
      const lastInform = item._lastInform ? Date.parse(item._lastInform) : NaN;
      if (Number.isFinite(lastInform) && lastInform < windowStart) continue;
      const tags = Array.isArray(item._tags) ? item._tags : [];
      if (tags.includes(config.markerTag)) continue;
      eligible.push(deviceId);
    }
    if (eligible.length === 0) return [];

    const settled = await ProvisioningRun.settledDeviceIds(eligible, new Date(now));
    return eligible.filter((deviceId) => !settled.has(deviceId)).slice(0, limit);
  }

  /**
   * One poller pass: finish the runs whose time has come, then queue new
   * candidates. Due work goes first so a device already mid-activation is not
   * left waiting behind a fleet scan.
   */
  static async processDue({ limit } = {}) {
    const config = await this.getConfig();
    const batch = limit ?? config.batchSize;
    const summary = { executed: 0, verified: 0, queued: 0 };

    const due = await ProvisioningRun.getDue(new Date(), batch);
    for (const run of due) {
      if (run.status === 'awaiting_verify') {
        await this.verifyRun(run);
        summary.verified += 1;
      } else {
        await this.executeRun(run);
        summary.executed += 1;
      }
    }

    const remaining = batch - due.length;
    if (remaining > 0) {
      const candidates = await this.findCandidates({ limit: remaining });
      for (const deviceId of candidates) {
        await this.enqueue(deviceId, { trigger: 'poller' });
        summary.queued += 1;
      }
    }
    return summary;
  }

  static async reapInterrupted() {
    return ProvisioningRun.reapInterrupted(new Date(Date.now() - INTERRUPTED_AFTER_MS));
  }

  static async prune() {
    const config = await this.getConfig();
    const cutoff = new Date(Date.now() - config.runRetentionDays * 86_400_000);
    return ProvisioningRun.pruneOlderThan(cutoff);
  }
}

export default ProvisioningService;
