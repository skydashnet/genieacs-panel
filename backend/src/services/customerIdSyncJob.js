import CustomerAccount from '../models/CustomerAccount.js';
import CustomerService from './customerService.js';
import DeviceService from './deviceService.js';
import Setting from '../models/Setting.js';
import { classifySyncError } from './customerSyncErrors.js';

/**
 * Onde fica o resultado da última passada: uma chave interna de `settings`,
 * fora de `ALLOWED_SETTING_KEYS` — a lista das configurações não a mostra e
 * o PUT não a aceita. Sobrevive a um reinício, que a memória não sobrevive.
 */
export const LAST_SYNC_KEY = 'customerIdSyncLast';

/**
 * A sincronização de IDs de cliente pedida pelo botão das configurações.
 *
 * Cada conta nova nasce com a sua senha do portal, e a senha é um bcrypt —
 * dezenas de milissegundos cada, numa thread só. Com mil ONTs sem conta a
 * passada leva minutos, e o proxy na frente do painel corta a requisição
 * muito antes: o operador via "não foi possível sincronizar" enquanto o
 * servidor continuava trabalhando. Por isso a requisição espera no máximo
 * `BUDGET_MS`; o que passar disso continua aqui, em segundo plano, e quem
 * pedir de novo nesse meio-tempo ouve "em andamento" em vez de abrir uma
 * segunda passada sobre as mesmas contas.
 */
const running = new Map();
/** Quando começou a passada em curso de cada provedor. */
const startedAt = new Map();
const TIMED_OUT = Symbol('timed-out');

async function syncOnce() {
  const devices = await DeviceService.getCustomerIdentityDevices();
  const deviceIds = devices.map((device) => String(device?._id || '')).filter(Boolean);
  const identityHashes = devices
    .filter((device) => device?._id && device?.softwareId && device?.pppoe)
    .map((device) => CustomerService.identityHash(device.softwareId, device.pppoe));
  const existingRows = await CustomerAccount.getExistingForIdentities(deviceIds, identityHashes);
  const customerIds = await CustomerService.syncDevices(devices, { enabled: true });
  return {
    enabled: true,
    total: deviceIds.length,
    existing: Math.min(existingRows.length, customerIds.size),
    generated: Math.max(customerIds.size - existingRows.length, 0),
    pending: Math.max(new Set(deviceIds).size - customerIds.size, 0)
  };
}

class CustomerIdSyncJob {
  /** Quanto a requisição espera antes de responder "continua em segundo plano". */
  static BUDGET_MS = 20_000;

  static isRunning(key) {
    return running.has(key);
  }

  /**
   * Roda (ou encontra rodando) a passada do provedor `key`.
   *
   * Devolve `{ running: true }` se ela já estava em curso ou não terminou no
   * prazo, ou o resumo se terminou. Uma falha dentro do prazo é relançada,
   * para o chamador dizer o motivo; depois do prazo, só vai para o log.
   */
  static async run(key) {
    if (running.has(key)) return { running: true };
    const started = new Date();
    const job = syncOnce();
    // Dentro do prazo, quem loga e responde é o chamador; depois dele, não há
    // mais ninguém esperando e o log é o único lugar onde a falha aparece.
    // O desfecho vai para `LAST_SYNC_KEY` nos dois casos: é o que a tela lê
    // para dizer como terminou a passada que continuou em segundo plano.
    //
    // A resposta espera esse registro E a saída do mapa `running`: responder
    // assim que a passada termina deixava uma janela em que um segundo pedido
    // encontrava a trava ainda de pé e ouvia "em andamento" de uma passada
    // que já tinha acabado.
    let detached = false;
    const tracked = job
      .then(
        async (result) => {
          await this.remember({ ok: true, startedAt: started, result });
          return { ok: true, result };
        },
        async (error) => {
          if (detached) console.error('Customer ID sync (background) error:', error);
          const reason = classifySyncError(error);
          await this.remember({ ok: false, startedAt: started, code: reason.code, reasonKey: reason.reasonKey, status: reason.status ?? null });
          return { ok: false, error };
        }
      )
      .finally(() => { running.delete(key); startedAt.delete(key); });
    running.set(key, tracked);
    startedAt.set(key, started);

    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), this.BUDGET_MS);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([tracked, deadline]);
      if (outcome === TIMED_OUT) {
        detached = true;
        return { running: true };
      }
      if (!outcome.ok) throw outcome.error;
      return outcome.result;
    } finally {
      clearTimeout(timer);
    }
  }

  static async remember({ ok, startedAt: started, result = null, code = null, reasonKey = null, status = null }) {
    const record = {
      ok,
      startedAt: started.toISOString(),
      finishedAt: new Date().toISOString(),
      ...(ok
        ? { total: result.total, existing: result.existing, generated: result.generated, pending: result.pending }
        : { code, reasonKey, status })
    };
    try {
      await Setting.upsert(LAST_SYNC_KEY, JSON.stringify(record));
    } catch (error) {
      console.warn(`Customer ID sync: could not record the outcome: ${error.message}`);
    }
  }

  /**
   * Como está a sincronização do provedor `key`: se há uma passada em curso
   * (e desde quando) e como terminou a última.
   */
  static async status(key) {
    let last = null;
    try {
      const raw = await Setting.getByKey(LAST_SYNC_KEY);
      last = raw ? JSON.parse(raw) : null;
    } catch {
      last = null;
    }
    return {
      running: running.has(key),
      startedAt: startedAt.get(key)?.toISOString() ?? null,
      last
    };
  }

  /** Para os testes: espera toda passada em curso terminar. */
  static async idle() {
    // O `finally` que grava o desfecho roda depois da passada; espera-se o
    // mapa esvaziar, não só as promessas que estavam nele.
    while (running.size) {
      await Promise.allSettled([...running.values()]);
      await new Promise((resolve) => { setImmediate(resolve); });
    }
  }
}

export default CustomerIdSyncJob;
