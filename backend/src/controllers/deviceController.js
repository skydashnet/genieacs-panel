import bcrypt from 'bcryptjs';
import AuditLog from '../models/AuditLog.js';
import DeviceService from '../services/deviceService.js';
import DeviceHistoryService from '../services/deviceHistoryService.js';
import CustomerService from '../services/customerService.js';
import DeviceTagService from '../services/deviceTagService.js';
import CustomerPortalPasswordService from '../services/customerPortalPasswordService.js';
import CustomerAccount from '../models/CustomerAccount.js';
import DeviceProfile from '../models/DeviceProfile.js';
import DeviceSwap, { publicSwap } from '../models/DeviceSwap.js';
import TenantUser from '../models/TenantUser.js';
import User from '../models/User.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';
import { exportDevicesCsv } from '../services/deviceExport.js';
import { BATCH_ACTIONS, BATCH_LIMIT, batchFilterLabel, batchSummary, normalizeBatchIds } from '../services/deviceBatch.js';
import { acsAgentOfflineBody, isAgentOffline } from '../services/genieacs/agent.js';
import FirmwareStore, { readUploadHeaders } from '../services/firmwareStore.js';

/**
 * A recusa do escopo do provedor (ACS compartilhado) como resposta própria.
 *
 * O conector recusa equipamento que não é do provedor com "não encontrado", e
 * a tag de um provedor com 403. Sem isto, cada `catch` abaixo transformaria a
 * recusa num 500 genérico — que o operador lê como pane, e não como "esse
 * equipamento não existe aqui".
 *
 * E o agente desconectado (modo `agent`), pelo mesmo motivo: 503 com
 * `code: 'acs_agent_offline'` e `lastSeenAt`, que a tela transforma em "o
 * agente está fora do ar desde…" em vez de um 502 que parece defeito do ACS.
 * Todo `catch` deste controlador passa por aqui, então nenhuma rota de
 * equipamento precisa lembrar disso uma a uma.
 */
function respostaDeEscopo(req, res, error) {
  if (isAgentOffline(error)) {
    return res.status(503).json(acsAgentOfflineBody(error, translateError(req.t, error)));
  }
  const chave = error?.translationKey;
  if (chave !== 'device.notFound' && chave !== 'device.scopeTagProtected') return null;
  return res.status(error.status || (chave === 'device.notFound' ? 404 : 403)).json(
    createErrorResponse(translateError(req.t, error), null, error.code || null)
  );
}

/**
 * A linha da trilha para uma ação que MUDOU a ONT, gravada só depois do sucesso.
 *
 * `fromRequest` não lança — a trilha nunca vira a causa de um 500 numa ação
 * que já aconteceu —, então isto pode ser aguardado sem `try` em volta.
 */
function registrarAcaoNaOnt(req, action, deviceId, detail = null) {
  return AuditLog.fromRequest(req, {
    action,
    subjectType: 'device',
    subjectId: String(deviceId ?? '').slice(0, 128),
    detail
  });
}

/**
 * QUAIS campos o formulário mandou — os nomes, nunca os valores.
 *
 * A senha do Wi-Fi e a da ONT viajam nesses formulários, e a trilha não pode
 * ser a segunda cópia delas: ela é exportada com o provedor e tem retenção
 * própria. Os nomes vêm do navegador, então só passam os que têm cara de nome
 * de campo, e no máximo vinte.
 */
function camposDoFormulario(formData) {
  if (!formData || typeof formData !== 'object' || Array.isArray(formData)) return null;
  const nomes = Object.keys(formData)
    .filter((nome) => /^[A-Za-z0-9_.-]{1,40}$/.test(nome))
    .slice(0, 20);
  return nomes.length ? nomes.join(', ') : null;
}

/**
 * O nome de quem dispensou cada troca, por id de operador.
 *
 * `acknowledged_by` guarda só o id, e `users` é tabela COMPARTILHADA de
 * propósito — uma pessoa atende vários ISPs, e `config/tenantScope.js` avisa
 * que nada no esquema impede o id de um operador de outro provedor de aparecer
 * numa linha daqui. Por isso o nome sai de `TenantUser.listForTenant`, que só
 * enxerga quem trabalha NESTE provedor: um id que não esteja lá volta sem nome,
 * em vez de ser resolvido contra o cadastro global de pessoas.
 *
 * Uma consulta para a lista inteira, não uma por linha: a lista de trocas de um
 * aparelho chega a 100 e a da frota a 200.
 */
async function swapAcknowledgers(req, swaps) {
  const ids = new Set(
    swaps
      .map((swap) => Number(swap?.acknowledged_by))
      .filter((id) => Number.isInteger(id) && id > 0)
  );
  if (ids.size === 0) return new Map();
  const equipe = await TenantUser.listForTenant(req.tenantId);
  return new Map(
    equipe.filter((membro) => ids.has(Number(membro.id)))
      .map((membro) => [Number(membro.id), membro.username])
  );
}

/** Se `password` é a senha de quem está logado. */
async function senhaDoOperadorConfere(req, password) {
  const user = await User.findById(req.user?.userId);
  return Boolean(user?.password)
    && await bcrypt.compare(String(password).slice(0, 128), user.password);
}

class DeviceController {
  /**
   * `GET /api/devices/export` — o recorte da lista numa planilha.
   *
   * Os filtros são os da lista (`status`, `focus`, `search`), lidos pela mesma
   * normalização; a trilha guarda quantas linhas saíram e o recorte, e diz só
   * SE houve busca — o texto buscado pode ser o nome de um assinante.
   */
  static async exportDevices(req, res) {
    try {
      const { csv, count, filters } = await exportDevicesCsv(req.query);
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.DEVICES_EXPORTED,
        subjectType: 'devices',
        subjectId: null,
        detail: {
          count,
          status: filters.status,
          focus: filters.focus,
          search: Boolean(filters.search)
        }
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="equipamentos-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.send(csv);
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      if (error.translationKey) {
        return res.status(error.status || 400).json(
          createErrorResponse(translateError(req.t, error), null, error.code || null)
        );
      }
      console.error('Export devices error:', error);
      return res.status(500).json(createErrorResponse(req.t('device.exportFailed'), error.message));
    }
  }

  static async getDashboard(req, res) {
    try {
      const dashboard = await DeviceService.getDashboardData(req.query.refresh === '1');
      return res.json(createResponse(req.t('device.dashboardRetrieved'), dashboard));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error('Get dashboard error:', error);
      return res.status(502).json(
        createErrorResponse(req.t('device.dashboardFailed'), error.message)
      );
    }
  }

  /** The telemetry series for one ONT, for the chart on its page. */
  static async getHistory(req, res) {
    try {
      const deviceId = String(req.params?.deviceId ?? '').trim();
      if (!deviceId) {
        return res.status(400).json(createErrorResponse(req.t('device.history.deviceIdRequired')));
      }
      const to = req.query?.to ? Date.parse(String(req.query.to)) : Date.now();
      const from = req.query?.from
        ? Date.parse(String(req.query.from))
        : to - 24 * 3600_000;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
        return res.status(400).json(createErrorResponse(req.t('device.history.rangeInvalid')));
      }
      // A year is already 8760 hourly points, four times what the read returns.
      // Refusing beyond it keeps a mistyped date from scanning the whole table.
      if (to - from > 366 * 24 * 3600_000) {
        return res.status(400).json(createErrorResponse(req.t('device.history.rangeInvalid')));
      }
      const history = await DeviceHistoryService.readRange(deviceId, { from, to });
      return res.json(createResponse(req.t('device.history.retrieved'), history));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error('Get device history error:', error);
      return res.status(502).json(
        createErrorResponse(req.t('device.history.failed'), error.message)
      );
    }
  }

  /**
   * The ONT replacements the operator has not looked at yet.
   *
   * Open ones rather than all of them: the panel raises this as a banner, and a
   * list that keeps every swap ever recorded stops being something anyone
   * reads. The full record stays on each device's page.
   */
  static async getSwaps(req, res) {
    try {
      const rows = await DeviceSwap.listOpen(req.query?.limit);
      // A seta em vez de `rows.map(publicSwap)`: o `map` passa o ÍNDICE no
      // segundo argumento, que aqui é o mapa de nomes.
      return res.json(createResponse(req.t('device.swaps.retrieved'), {
        // Esta lista é só das trocas ainda não dispensadas, então
        // `acknowledged_by` é nulo em todas — nenhum nome a resolver.
        swaps: rows.map((row) => publicSwap(row)),
        open: rows.length
      }));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error('List device swaps error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('device.swaps.failed'), error.message)
      );
    }
  }

  /** Every replacement one ONT took part in, at either end of it. */
  /**
   * Every parameter GenieACS holds for one ONT, for telling "the ONT does not
   * publish this" apart from "GenieACS never read it" when a field reads N/D.
   * Credentials come back masked.
   */
  static async getDeviceParameters(req, res) {
    try {
      const deviceId = String(req.query?.deviceId ?? '').trim();
      if (!deviceId) {
        return res.status(400).json(createErrorResponse(req.t('device.history.deviceIdRequired')));
      }
      const result = await DeviceService.listDeviceParameters(deviceId, req.query?.search);
      return res.json(createResponse(req.t('device.parameters.retrieved'), result));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      if (error.translationKey === 'device.notFound') {
        return res.status(404).json(createErrorResponse(req.t('device.notFound')));
      }
      console.error('Get device parameters error:', error);
      return res.status(502).json(createErrorResponse(req.t('device.parameters.failed'), error.message));
    }
  }

  static async getDeviceSwaps(req, res) {
    try {
      const deviceId = String(req.params?.deviceId ?? '').trim();
      if (!deviceId) {
        return res.status(400).json(createErrorResponse(req.t('device.history.deviceIdRequired')));
      }
      const rows = await DeviceSwap.listForDevice(deviceId, req.query?.limit);
      // Aqui entram as já dispensadas, e é a tela onde "quem olhou isso" faz
      // falta: sem o nome, uma troca dispensada é idêntica a uma aberta.
      const nomes = await swapAcknowledgers(req, rows);
      return res.json(createResponse(req.t('device.swaps.retrieved'), {
        swaps: rows.map((row) => publicSwap(row, nomes))
      }));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error('Get device swaps error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('device.swaps.failed'), error.message)
      );
    }
  }

  static async acknowledgeSwap(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(createErrorResponse(req.t('device.swaps.notFound')));
      }
      const existing = await DeviceSwap.getById(id);
      if (!existing) {
        return res.status(404).json(createErrorResponse(req.t('device.swaps.notFound')));
      }
      // `userId`, não `id`: a sessão nunca teve `id` (`middleware/auth.js`, o
      // objeto devolvido por `hydrateSession`). Esta linha dizia `req.user?.id`
      // e o encadeamento opcional transformou o erro de digitação em silêncio —
      // `acknowledged_by` gravava `null` desde que a coluna existe, que é a
      // única que responde quem dispensou o aviso de troca de ONT.
      const swap = await DeviceSwap.acknowledge(id, req.user?.userId ?? null);
      return res.json(createResponse(
        req.t('device.swaps.acknowledged'),
        publicSwap(swap, await swapAcknowledgers(req, [swap]))
      ));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error('Acknowledge device swap error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('device.swaps.failed'), error.message)
      );
    }
  }

  static async getFaults(req, res) {
    try {
      const faults = await DeviceService.getFaults(req.query.limit);
      void DeviceService.mergeDashboardFaults(faults);
      return res.json(createResponse(req.t('device.faultsRetrieved'), faults));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error('Get faults error:', error);
      return res.status(502).json(
        createErrorResponse(req.t('device.faultsFailed'), error.message)
      );
    }
  }

  static async deleteFault(req, res) {
    try {
      await DeviceService.deleteFault(req.params.faultId);
      DeviceService.invalidateDashboard();
      return res.json(createResponse(req.t('device.faultCleared')));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error('Delete fault error:', error);
      const validationError = error.message === 'Invalid fault ID';
      return res.status(validationError ? 400 : 502).json(
        createErrorResponse(req.t('device.faultClearFailed'), error.message)
      );
    }
  }

  static async getDevices(req, res) {
    try {
      const { devices, page, pageSize, total, totalPages } =
        await DeviceService.getDevicesPage(req.query);
      // Customer accounts are written on demand, so decoration is deliberately
      // limited to the page being returned instead of the whole fleet.
      const decoratedDevices = await CustomerService.decorateDevices(devices);
      return res.json(
        createResponse(req.t('device.listRetrieved'), {
          devices: decoratedDevices,
          page,
          pageSize,
          total,
          totalPages
        })
      );
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error('Get devices error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('device.listFailed'), error.message)
      );
    }
  }

  static async getDeviceDetail(req, res) {
    try {
      const { deviceId } = req.params;
      
      if (!deviceId) {
        return res.status(400).json(
          createErrorResponse(req.t('device.idRequired'))
        );
      }

      const deviceDetail = await DeviceService.getDetailDevice(deviceId);
      const profile = await DeviceProfile.getByDeviceId(deviceId);
      const reportedPppoe = deviceDetail.virtualParameters?.pppoeUsername?.value;
      let account = await CustomerAccount.getByDeviceId(deviceId);
      // This page is where staff read the Customer ID and portal password
      // before handing them over, so the account bound to the ONT is
      // revalidated here: an ONT now serving a different PPPoE login must not
      // present the previous subscriber's credentials.
      const staleSubscriber = Boolean(
        account
        && String(reportedPppoe ?? '').trim().length >= 3
        && !CustomerService.isSameSubscriber(account, reportedPppoe)
      );
      if ((!account || staleSubscriber) && await CustomerService.isAutoGenerationEnabled()) {
        account = await CustomerService.ensureAccount({
          _id: deviceId,
          softwareId: deviceDetail.deviceInfo?.softwareVersion,
          pppoe: reportedPppoe,
          lastInform: deviceDetail.lastInform
        }) || (staleSubscriber ? null : account);
      }
      return res.json(
        createResponse(req.t('device.detailRetrieved'), {
          ...deviceDetail,
          customer: {
            // O id da LINHA, ao lado do id impresso. As duas rotas do dossiê
            // (`/api/customers/:accountId/...`) endereçam a conta por ele, e a
            // tela do aparelho é onde o operador está quando um assinante liga
            // pedindo os dados dele. Sem isto a tela teria que descobrir o id
            // por uma segunda rota, ou as rotas teriam que endereçar pelo
            // `customer_id` impresso — que é dado que o assinante conhece e por
            // isso o pior endereço possível para um ato sem volta.
            accountId: account?.id ?? null,
            customerId: account?.customer_id || null,
            installationDate: profile?.installation_date || null,
            generated: Boolean(account),
            portalPasswordSet: Boolean(account?.password_hash),
            portalPasswordUpdatedAt: account?.password_updated_at || null
          }
        })
      );
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error('Get device detail error:', error);
      
      if (error.translationKey === 'device.notFound') {
        return res.status(404).json(
          createErrorResponse(req.t('device.notFound'), error.message)
        );
      }
      
      return res.status(500).json(
        createErrorResponse(req.t('device.detailFailed'), error.message)
      );
    }
  }

  /**
   * Portal passwords are independent of the Customer ID, so staff need a way to
   * read the current one back and to rotate it. Both are admin-only.
   */
  static async getPortalPassword(req, res) {
    try {
      const account = await CustomerAccount.getByDeviceId(req.params.deviceId);
      if (!account) {
        return res.status(404).json(
          createErrorResponse(req.t('device.noCustomerAccount'))
        );
      }
      const password = CustomerPortalPasswordService.reveal(account);
      if (!password) {
        return res.status(404).json(createErrorResponse(
          'No readable portal password is stored. Generate a new one.'
        ));
      }
      // A senha revelada NÃO entra na trilha, e é o ponto: registra-se que ela
      // foi revelada, não qual era. O contrário faria da auditoria o maior
      // repositório de segredos em claro do produto — e um que ninguém pensa em
      // proteger, porque "é só log".
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.PORTAL_PASSWORD_REVEALED,
        subjectType: 'customer_account',
        subjectId: account.id,
        detail: { customerId: account.customer_id, deviceId: account.device_id }
      });
      return res.json(createResponse(req.t('device.portalPasswordRetrieved'), {
        customerId: account.customer_id,
        password,
        updatedAt: account.password_updated_at || null
      }));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error('Get portal password error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('device.portalPasswordReadFailed'), error.message)
      );
    }
  }

  static async resetPortalPassword(req, res) {
    try {
      const account = await CustomerAccount.getByDeviceId(req.params.deviceId);
      if (!account) {
        return res.status(404).json(
          createErrorResponse(req.t('device.noCustomerAccount'))
        );
      }
      const password = await CustomerPortalPasswordService.reset(account.id);
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.PORTAL_PASSWORD_RESET,
        subjectType: 'customer_account',
        subjectId: account.id,
        detail: { customerId: account.customer_id, deviceId: account.device_id }
      });
      return res.json(createResponse(req.t('device.portalPasswordRegenerated'), {
        customerId: account.customer_id,
        password
      }));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error('Reset portal password error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('device.portalPasswordResetFailed'), error.message)
      );
    }
  }

  /**
   * Remove a ONT do GenieACS. Pede o que o reset de fábrica pede — a série
   * digitada e a senha do operador duas vezes —, porque também não tem volta:
   * o uso é apagar o ONT antigo que ficou no ACS depois de uma troca, e o
   * clique no aparelho errado apagaria o que está em serviço.
   */
  static async deleteDevice(req, res) {
    const { deviceId } = req.params;
    const { confirmSerial, password, passwordConfirm } = req.body || {};
    if (!deviceId) {
      return res.status(400).json(createErrorResponse(req.t('device.idRequired')));
    }
    if (!password || !passwordConfirm) {
      return res.status(400).json(createErrorResponse(req.t('device.deletePasswordRequired'), null, 'password_required'));
    }
    if (String(password) !== String(passwordConfirm)) {
      return res.status(400).json(createErrorResponse(req.t('device.factoryResetPasswordMismatch'), null, 'password_mismatch'));
    }
    try {
      if (!await senhaDoOperadorConfere(req, password)) {
        return res.status(403).json(createErrorResponse(req.t('device.factoryResetPasswordIncorrect'), null, 'password_incorrect'));
      }
      await DeviceService.deleteDevice(String(deviceId), confirmSerial);
      await registrarAcaoNaOnt(req, AuditLog.ACTIONS.DEVICE_DELETED, deviceId);
      DeviceService.invalidateDashboard();
      return res.json(
        createResponse(req.t('device.deleted'), { deviceId })
      );
    } catch (error) {
      const escopo = respostaDeEscopo(req, res, error);
      if (escopo) return escopo;
      if (error.translationKey) {
        return res.status(error.status || 400).json(
          createErrorResponse(translateError(req.t, error), null, error.code || null)
        );
      }
      console.error('Delete device error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('device.deleteFailed'), error.message)
      );
    }
  }

  static async rebootDevice(req, res) {
    try {
      const { deviceId } = req.body;
      
      if (!deviceId) {
        return res.status(400).json(
          createErrorResponse(req.t('device.idRequired'))
        );
      }

      const result = await DeviceService.rebootDevice(deviceId);
      await registrarAcaoNaOnt(req, AuditLog.ACTIONS.DEVICE_REBOOTED, deviceId);
      return res.json(
        createResponse(req.t('device.rebootStarted'), { 
          deviceId, 
          taskResponse: result 
        })
      );
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error('Reboot device error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('device.rebootFailed'), error.message)
      );
    }
  }

  static async factoryResetDevice(req, res) {
    const { deviceId, confirmSerial, password, passwordConfirm } = req.body || {};
    if (!deviceId) {
      return res.status(400).json(createErrorResponse(req.t('device.idRequired')));
    }
    // A senha do operador, digitada DUAS vezes, antes de qualquer conversa com
    // o ACS. Conferida aqui e não só na tela: a API é chamada por quem não usa
    // a tela, e um token esquecido aberto não pode apagar uma ONT sozinho.
    // 403 e não 401 na senha errada: 401 diz "sessão inválida", e a sessão
    // continua válida.
    if (!password || !passwordConfirm) {
      return res.status(400).json(createErrorResponse(req.t('device.factoryResetPasswordRequired'), null, 'password_required'));
    }
    if (String(password) !== String(passwordConfirm)) {
      return res.status(400).json(createErrorResponse(req.t('device.factoryResetPasswordMismatch'), null, 'password_mismatch'));
    }
    try {
      if (!await senhaDoOperadorConfere(req, password)) {
        return res.status(403).json(createErrorResponse(req.t('device.factoryResetPasswordIncorrect'), null, 'password_incorrect'));
      }
      await DeviceService.factoryResetDevice(String(deviceId), confirmSerial);
      await registrarAcaoNaOnt(req, AuditLog.ACTIONS.DEVICE_FACTORY_RESET, deviceId);
      DeviceService.invalidateDashboard();
      return res.json(createResponse(req.t('device.factoryResetStarted'), { deviceId }));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      if (error.translationKey) {
        return res.status(error.status || 400).json(
          createErrorResponse(translateError(req.t, error), null, error.code || null)
        );
      }
      console.error('Factory reset error:', error);
      return res.status(502).json(createErrorResponse(req.t('device.factoryResetFailed'), error.message));
    }
  }

  static async runBatch(req, res) {
    const { action, deviceIds, filter, fileId } = req.body || {};
    if (!BATCH_ACTIONS.includes(action)) {
      return res.status(400).json(createErrorResponse(req.t('device.batchInvalid'), null, 'invalid_action'));
    }
    const ids = normalizeBatchIds(deviceIds);
    if (!ids || ids.length === 0) {
      return res.status(400).json(createErrorResponse(req.t('device.batchInvalid'), null, 'invalid_devices'));
    }
    if (ids.length > BATCH_LIMIT) {
      return res.status(400).json(
        createErrorResponse(req.t('device.batchTooLarge', { limit: BATCH_LIMIT }), null, 'batch_too_large')
      );
    }
    try {
      const { results, file } = await DeviceService.runBatch(action, ids, { fileId });
      const summary = batchSummary(results);
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.DEVICE_BATCH_ACTION,
        subjectType: 'device',
        subjectId: null,
        detail: {
          action,
          ...summary,
          ...(file ? { file: file.id.slice(0, 128), version: file.version ? file.version.slice(0, 64) : null } : {}),
          filter: batchFilterLabel(filter)
        }
      });
      if (summary.sent + summary.queued > 0) DeviceService.invalidateDashboard();
      return res.json(createResponse(req.t('device.batchDone'), { action, summary, results, file }));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      if (error.translationKey) {
        return res.status(error.status || 400).json(
          createErrorResponse(translateError(req.t, error), null, error.code || null)
        );
      }
      console.error('Device batch error:', error);
      return res.status(502).json(createErrorResponse(req.t('device.batchFailed'), error.message));
    }
  }

  static async listFirmwareCatalog(req, res) {
    try {
      return res.json(createResponse(null, await DeviceService.listFirmwareCatalog()));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error('List firmware catalog error:', error);
      return res.status(502).json(createErrorResponse(req.t('device.firmwareListFailed'), error.message));
    }
  }

  static async listFirmware(req, res) {
    const deviceId = String(req.query?.deviceId ?? '').trim();
    if (!deviceId) {
      return res.status(400).json(createErrorResponse(req.t('device.idRequired')));
    }
    try {
      const result = await DeviceService.listFirmware(deviceId);
      return res.json(createResponse(null, { deviceId, ...result }));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      if (error.translationKey) {
        return res.status(error.status || 400).json(
          createErrorResponse(translateError(req.t, error), null, error.code || null)
        );
      }
      console.error('List firmware error:', error);
      return res.status(502).json(createErrorResponse(req.t('device.firmwareListFailed'), error.message));
    }
  }

  static async upgradeFirmware(req, res) {
    const { deviceId, fileId } = req.body || {};
    if (!deviceId) {
      return res.status(400).json(createErrorResponse(req.t('device.idRequired')));
    }
    try {
      const result = await DeviceService.upgradeFirmware(String(deviceId), fileId);
      await registrarAcaoNaOnt(req, AuditLog.ACTIONS.DEVICE_FIRMWARE_UPGRADE, deviceId, {
        file: result.file.id.slice(0, 128),
        from: result.from ? String(result.from).slice(0, 64) : null,
        to: result.file.version ? result.file.version.slice(0, 64) : null
      });
      DeviceService.invalidateDashboard();
      return res.json(createResponse(req.t('device.firmwareUpgradeStarted'), {
        deviceId,
        file: result.file,
        from: result.from,
        queued: result.queued
      }));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      if (error.translationKey) {
        return res.status(error.status || 400).json(
          createErrorResponse(translateError(req.t, error), null, error.code || null)
        );
      }
      console.error('Firmware upgrade error:', error);
      return res.status(502).json(createErrorResponse(req.t('device.firmwareUpgradeFailed'), error.message));
    }
  }

  /**
   * `POST /api/devices/firmware/files` — o arquivo cru no corpo; nome e
   * metadados em `X-File-Name`, `X-Fw-Oui`, `X-Fw-Product-Class`,
   * `X-Fw-Version` (com `encodeURIComponent`). 201 com o arquivo como a lista
   * o mostra (`id` já com o prefixo do dono, num ACS compartilhado).
   */
  static async uploadFirmwareFile(req, res) {
    try {
      const file = await FirmwareStore.upload(readUploadHeaders(req), req.body);
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.DEVICE_FIRMWARE_UPLOAD,
        subjectType: 'firmware',
        subjectId: file.id.slice(0, 128),
        detail: { size: file.size, productClass: file.productClass, version: file.version }
      });
      return res.status(201).json(createResponse(req.t('device.firmwareUploaded'), file));
    } catch (error) {
      const escopo = respostaDeEscopo(req, res, error);
      if (escopo) return escopo;
      if (error.translationKey) {
        return res.status(error.status || 400).json(
          createErrorResponse(translateError(req.t, error), null, error.code || null)
        );
      }
      console.error('Firmware upload error:', error);
      return res.status(502).json(createErrorResponse(req.t('device.firmwareUploadFailed'), error.message));
    }
  }

  /** `DELETE /api/devices/firmware/files?name=<id>` — só firmware do próprio provedor. */
  static async deleteFirmwareFile(req, res) {
    try {
      const file = await FirmwareStore.remove(typeof req.query?.name === 'string' ? req.query.name : '');
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.DEVICE_FIRMWARE_DELETE,
        subjectType: 'firmware',
        subjectId: file.id.slice(0, 128),
        detail: { productClass: file.productClass, version: file.version }
      });
      return res.json(createResponse(req.t('device.firmwareDeleted'), { id: file.id }));
    } catch (error) {
      const escopo = respostaDeEscopo(req, res, error);
      if (escopo) return escopo;
      if (error.translationKey) {
        return res.status(error.status || 400).json(
          createErrorResponse(translateError(req.t, error), null, error.code || null)
        );
      }
      console.error('Firmware delete error:', error);
      return res.status(502).json(createErrorResponse(req.t('device.firmwareDeleteFailed'), error.message));
    }
  }

  static async startDiagnostic(req, res) {
    const { deviceId, kind, host, count } = req.body || {};
    if (!deviceId) {
      return res.status(400).json(createErrorResponse(req.t('device.idRequired')));
    }
    try {
      const result = await DeviceService.startDiagnostic(String(deviceId), { kind, host, count });
      await registrarAcaoNaOnt(req, AuditLog.ACTIONS.DEVICE_DIAGNOSTIC_STARTED, deviceId, {
        kind: result.kind,
        host: result.host
      });
      return res.json(createResponse(req.t('device.diagnosticStarted'), { deviceId, ...result }));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      if (error.translationKey) {
        return res.status(error.status || 400).json(
          createErrorResponse(translateError(req.t, error), null, error.code || null)
        );
      }
      console.error('Start diagnostic error:', error);
      return res.status(502).json(createErrorResponse(req.t('device.diagnosticFailed'), error.message));
    }
  }

  static async readDiagnostic(req, res) {
    const { deviceId, kind } = req.body || {};
    if (!deviceId) {
      return res.status(400).json(createErrorResponse(req.t('device.idRequired')));
    }
    try {
      const result = await DeviceService.readDiagnostic(String(deviceId), kind);
      return res.json(createResponse(null, { deviceId, ...result }));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      if (error.translationKey) {
        return res.status(error.status || 400).json(
          createErrorResponse(translateError(req.t, error), null, error.code || null)
        );
      }
      console.error('Read diagnostic error:', error);
      return res.status(502).json(createErrorResponse(req.t('device.diagnosticFailed'), error.message));
    }
  }

  static async summonDevice(req, res) {
    const { deviceId, parameters = [] } = req.body;

    if (!deviceId) {
      return res.status(400).json(
        createErrorResponse(req.t('device.idRequired'))
      );
    }

    try {
      const data = await DeviceService.summonDevice(deviceId, parameters);
      // Only a 200 from GenieACS means the ONT answered; a 202 means the tasks
      // wait for its next periodic Inform, and the operator must be told so
      // rather than reloading the page to the same N/D.
      const message = data.reached
        ? req.t('device.summonApplied')
        : data.reason
          ? req.t('device.summonDeferred', { reason: data.reason })
          : req.t('device.summonDeferredNoReason');
      return res.json(createResponse(message, data));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error('Error summoning device:', error.message);
      return res.status(500).json(
        createErrorResponse(req.t('device.summonFailed'), error.message)
      );
    }
  }

  static async updateWanConfig(req, res) {
    const { id } = req.params;
    const { wanIndex, formData } = req.body;
    
    if (!wanIndex || !formData) {
      return res.status(400).json({ success: false, message: req.t('device.wanFieldsRequired') });
    }

    try {
      const result = await DeviceService.updateWanConfig(id, wanIndex, formData);
      await registrarAcaoNaOnt(req, AuditLog.ACTIONS.DEVICE_WAN_CHANGED, id, {
        wanIndex: String(wanIndex).slice(0, 16),
        fields: camposDoFormulario(formData)
      });
      return res.json(createResponse(req.t(result.messageKey, result.messageVars), result));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error(`Error in updateWanConfig for ${id}:`, error);
      const validationError = /^(Invalid|VLAN ID|PPP |WAN |No editable|Only PPPoE|Vendor not found)/.test(error.message);
      res.status(validationError ? 400 : 500).json(
        createErrorResponse(req.t('device.wanUpdateFailed'), error.message)
      );
    }
  }

  static async addWanConnection(req, res) {
    const { id } = req.params;
    const { containerPath, type } = req.body || {};
    if (!containerPath || !type) {
      return res.status(400).json(createErrorResponse(req.t('device.wanContainerRequired')));
    }
    try {
      const result = await DeviceService.addWanConnection(id, String(containerPath), String(type));
      DeviceService.invalidateDashboard();
      await registrarAcaoNaOnt(req, AuditLog.ACTIONS.DEVICE_WAN_ADDED, id, {
        type: String(type).slice(0, 32)
      });
      return res.json(createResponse(req.t(result.messageKey, result.messageVars), result));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error(`Error adding WAN connection for ${id}:`, error);
      if (error.translationKey) {
        return res.status(error.status || 400).json(
          createErrorResponse(translateError(req.t, error))
        );
      }
      const validationError = /^Invalid WAN/.test(error.message);
      return res.status(validationError ? 400 : 502).json(
        createErrorResponse(req.t('device.wanAddFailed'), error.message)
      );
    }
  }

  static async updateInstallationDate(req, res) {
    const { id } = req.params;
    const installationDate = CustomerService.normalizeInstallationDate(req.body?.installationDate);
    if (!installationDate) {
      return res.status(400).json(createErrorResponse(req.t('device.installationDateFormat')));
    }
    try {
      const detail = await DeviceService.getDetailDevice(id);
      const previous = await DeviceProfile.getByDeviceId(id);
      const installationTag = await DeviceService.syncInstallationTag(
        id,
        installationDate,
        previous?.installation_tag || null
      );
      const profile = await DeviceProfile.upsertInstallationDate(id, installationDate, installationTag);
      let account = await CustomerAccount.getByDeviceId(id);
      if (!account && await CustomerService.isAutoGenerationEnabled()) {
        account = await CustomerService.ensureAccount({
          _id: id,
          softwareId: detail.deviceInfo?.softwareVersion,
          pppoe: detail.virtualParameters?.pppoeUsername?.value,
          lastInform: detail.lastInform
        });
      }
      // Whoever records the installation is the technician the ACS names.
      await DeviceTagService.safeReconcile(id, { technician: req.user?.username });
      return res.json(createResponse(req.t('device.installationDateSaved'), {
        installationDate: profile.installation_date,
        installationTag,
        customerId: account?.customer_id || null
      }));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error(`Error saving installation date for ${id}:`, error);
      const status = error.translationKey === 'device.notFound' ? 404 : 502;
      return res.status(status).json(
        createErrorResponse(req.t('device.installationDateFailed'), error.message)
      );
    }
  }

  static async updateCredentials(req, res) {
    const { id } = req.params;
    const { type, password } = req.body;

    if (!type || !password) {
      return res.status(400).json({ success: false, message: req.t('device.credentialFieldsRequired') });
    }

    try {
      const result = await DeviceService.updateCredentials(id, type, password);
      // O TIPO de credencial (usuário da web, do suporte), nunca a senha.
      await registrarAcaoNaOnt(req, AuditLog.ACTIONS.DEVICE_CREDENTIALS_CHANGED, id, {
        type: String(type).slice(0, 32)
      });
      res.json({ success: true, data: result, message: req.t(result.messageKey, result.messageVars) });
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error(`Error in updateCredentials for ${id}:`, error);
      const validationError = /^(Invalid credential|Password must|VirtualParameter path)/.test(error.message);
      res.status(validationError ? 400 : 500).json(
        createErrorResponse(req.t('device.credentialUpdateFailed'), error.message)
      );
    }
  }

  static async updateWifiConfig(req, res) {
    const { id } = req.params;
    const { index, formData } = req.body || {};
    if (index === undefined || !formData) {
      return res.status(400).json(createErrorResponse(req.t('device.wifiFieldsRequired')));
    }
    try {
      const result = await DeviceService.updateWifiConfig(id, index, formData);
      DeviceService.invalidateDashboard();
      await registrarAcaoNaOnt(req, AuditLog.ACTIONS.DEVICE_WIFI_CHANGED, id, {
        index: String(index).slice(0, 16),
        fields: camposDoFormulario(formData)
      });
      return res.json(createResponse(req.t(result.messageKey, result.messageVars), result));
    } catch (error) {

      const escopo = respostaDeEscopo(req, res, error);

      if (escopo) return escopo;
      console.error(`Error in updateWifiConfig for ${id}:`, error);
      if (error.translationKey) {
        return res.status(error.status || 400).json(
          createErrorResponse(translateError(req.t, error))
        );
      }
      return res.status(500).json(
        createErrorResponse(req.t('device.wifiUpdateFailed'), error.message)
      );
    }
  }
}

export default DeviceController;
