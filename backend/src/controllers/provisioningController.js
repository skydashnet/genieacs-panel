import ProvisioningProfile from '../models/ProvisioningProfile.js';
import ProvisioningRun from '../models/ProvisioningRun.js';
import ProvisioningService from '../services/provisioningService.js';
import DeviceTagService from '../services/deviceTagService.js';
import { SgpError } from '../services/sgpService.js';
import { translateError } from '../i18n/index.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { acsAgentOfflineBody, isAgentOffline } from '../services/genieacs/agent.js';

function handleError(req, res, error, fallbackKey) {
  // O agente do GenieACS desconectado (modo `agent`) sai no formato comum das
  // rotas que falam com o ACS, e não como `provisioning_error`.
  if (isAgentOffline(error)) {
    return res.status(503).json(acsAgentOfflineBody(error, translateError(req.t, error)));
  }
  const status = error?.status ?? (error instanceof SgpError ? error.status : null);
  if (status) {
    return res.status(status).json({
      ...createErrorResponse(translateError(req.t, error), error.details || error.code),
      code: error.code || 'provisioning_error'
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

function readDeviceId(req) {
  const deviceId = String(req.params?.deviceId ?? '').trim();
  return deviceId || null;
}

function readProfileId(req) {
  const id = Number(req.params?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

class ProvisioningController {
  static async getConfig(req, res) {
    try {
      return res.json(createResponse(
        req.t('provisioning.configLoaded'),
        await ProvisioningService.getPublicConfig()
      ));
    } catch (error) {
      return handleError(req, res, error, 'provisioning.configLoadFailed');
    }
  }

  static async updateConfig(req, res) {
    try {
      const config = await ProvisioningService.saveConfig(req.body ?? {});
      return res.json(createResponse(req.t('provisioning.configSaved'), config));
    } catch (error) {
      return handleError(req, res, error, 'provisioning.configSaveFailed');
    }
  }

  static async listProfiles(req, res) {
    try {
      const profiles = await ProvisioningProfile.getAll();
      return res.json(createResponse(req.t('provisioning.profilesLoaded'), {
        profiles: profiles.map((profile) => ProvisioningService.publicProfile(profile))
      }));
    } catch (error) {
      return handleError(req, res, error, 'provisioning.profilesLoadFailed');
    }
  }

  static async createProfile(req, res) {
    try {
      const row = ProvisioningService.serializeProfile(req.body ?? {});
      if (await ProvisioningProfile.getByName(row.name)) {
        return res.status(409).json(createErrorResponse(req.t('provisioning.profileNameTaken')));
      }
      const profile = await ProvisioningProfile.create(row);
      return res.status(201).json(createResponse(req.t('provisioning.profileCreated'), {
        profile: ProvisioningService.publicProfile(profile)
      }));
    } catch (error) {
      return handleError(req, res, error, 'provisioning.profileSaveFailed');
    }
  }

  static async updateProfile(req, res) {
    try {
      const id = readProfileId(req);
      if (!id) return res.status(400).json(createErrorResponse(req.t('provisioning.profileIdRequired')));
      const existing = await ProvisioningProfile.getById(id);
      if (!existing) {
        return res.status(404).json(createErrorResponse(req.t('provisioning.profileNotFound')));
      }
      const row = ProvisioningService.serializeProfile(req.body ?? {}, existing);
      const clash = await ProvisioningProfile.getByName(row.name);
      if (clash && clash.id !== id) {
        return res.status(409).json(createErrorResponse(req.t('provisioning.profileNameTaken')));
      }
      const profile = await ProvisioningProfile.update(id, row);
      return res.json(createResponse(req.t('provisioning.profileUpdated'), {
        profile: ProvisioningService.publicProfile(profile)
      }));
    } catch (error) {
      return handleError(req, res, error, 'provisioning.profileSaveFailed');
    }
  }

  static async deleteProfile(req, res) {
    try {
      const id = readProfileId(req);
      if (!id) return res.status(400).json(createErrorResponse(req.t('provisioning.profileIdRequired')));
      const removed = await ProvisioningProfile.delete(id);
      if (!removed) {
        return res.status(404).json(createErrorResponse(req.t('provisioning.profileNotFound')));
      }
      return res.json(createResponse(req.t('provisioning.profileDeleted')));
    } catch (error) {
      return handleError(req, res, error, 'provisioning.profileDeleteFailed');
    }
  }

  static async previewDevice(req, res) {
    try {
      const deviceId = readDeviceId(req);
      if (!deviceId) return res.status(400).json(createErrorResponse(req.t('sgp.deviceIdRequired')));
      const preview = await ProvisioningService.preview(deviceId);
      return res.json(createResponse(req.t('provisioning.previewReady'), preview));
    } catch (error) {
      return handleError(req, res, error, 'provisioning.previewFailed');
    }
  }

  static async provisionDevice(req, res) {
    try {
      const deviceId = readDeviceId(req);
      if (!deviceId) return res.status(400).json(createErrorResponse(req.t('sgp.deviceIdRequired')));
      const queued = await ProvisioningService.enqueue(deviceId, {
        trigger: 'manual',
        force: req.body?.force === true
      });
      // Run it inline so the operator sees the outcome instead of a promise,
      // then hand back whatever state the run reached.
      const run = await ProvisioningService.executeRun(queued);
      // A manual run has a person behind it, and that person is the
      // technician the ACS names; the scheduler's runs leave the tag alone.
      await DeviceTagService.safeReconcile(deviceId, { technician: req.user?.username });
      return res.json(createResponse(req.t('provisioning.runFinished'), {
        run: ProvisioningService.publicRun(run, req.t)
      }));
    } catch (error) {
      return handleError(req, res, error, 'provisioning.runFailed');
    }
  }

  static async listDeviceRuns(req, res) {
    try {
      const deviceId = readDeviceId(req);
      if (!deviceId) return res.status(400).json(createErrorResponse(req.t('sgp.deviceIdRequired')));
      const runs = await ProvisioningRun.listByDeviceId(deviceId, req.query?.limit);
      return res.json(createResponse(req.t('provisioning.runsLoaded'), {
        runs: runs.map((run) => ProvisioningService.publicRun(run, req.t))
      }));
    } catch (error) {
      return handleError(req, res, error, 'provisioning.runsLoadFailed');
    }
  }

  static async listRuns(req, res) {
    try {
      const runs = await ProvisioningRun.list({
        deviceId: req.query?.deviceId ?? null,
        status: req.query?.status ?? null,
        limit: req.query?.limit
      });
      return res.json(createResponse(req.t('provisioning.runsLoaded'), {
        runs: runs.map((run) => ProvisioningService.publicRun(run, req.t))
      }));
    } catch (error) {
      return handleError(req, res, error, 'provisioning.runsLoadFailed');
    }
  }

  static async runPass(req, res) {
    try {
      const summary = await ProvisioningService.processDue({});
      return res.json(createResponse(req.t('provisioning.passFinished'), summary));
    } catch (error) {
      return handleError(req, res, error, 'provisioning.runFailed');
    }
  }
}

export default ProvisioningController;
