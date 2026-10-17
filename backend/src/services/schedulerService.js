import AppState from '../models/AppState.js';
import { tdb } from '../config/database.js';
import DeviceService from './deviceService.js';
import ProvisioningService from './provisioningService.js';
import SgpEventService from './sgpEventService.js';
import SgpService from './sgpService.js';
import SgpContactSyncService from './sgpContactSyncService.js';
import TeiahService from './teiahService.js';
import TeiahExportService from './teiahExportService.js';
import WaDunningService from './waDunningService.js';
import { forEachTenant, forEveryTenant } from '../config/tenantJobs.js';
import { currentTenantId } from '../config/tenantContext.js';
import { AUDIT_RETENTION, BOT_EVENTS_RETENTION_DAYS } from '../config/retention.js';
import AuditLog from '../models/AuditLog.js';
import Setting from '../models/Setting.js';
import AuthTicket from '../models/AuthTicket.js';
import ImpersonationTicket from '../models/ImpersonationTicket.js';
import Lead from '../models/Lead.js';
import { leadRetentionDays } from '../utils/leadRetention.js';
import { refreshDeploymentSharing } from './genieacsEgress.js';
import SubscriptionNoticeService from './subscriptionNoticeService.js';
import MaintenanceService from './maintenanceService.js';
import SubscriptionService from './subscriptionService.js';
import ChargeIssuingService from './chargeIssuingService.js';
import BillingInvoiceService from './billing/billingInvoiceService.js';
import CardAutopayService from './billing/cardAutopayService.js';
import CancellationService from './cancellationService.js';
import PlatformAlertService from './platformAlertService.js';
import DeviceScopeTagger, { AUTO_TAG_INTERVAL_MS } from './deviceScopeTagger.js';
import {
  dueForRefresh, isDormant, lastPanelActivityAt, refreshTtlMs, tenantOffsetMs
} from './dashboardSchedule.js';

export { leadRetentionDays };

const STATE_KEY = 'scheduler_state';
const BASE_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 24 * 3600_000;
/** De quanto em quanto tempo o pico de uso do período é medido (0105). */
const USAGE_PEAK_INTERVAL_MS = 10 * 60_000;
/**
 * O prazo da trilha, e por que ele deixou de ser uma constante.
 *
 * Um ano e não "para sempre" porque a trilha guarda dado pessoal — qual
 * assinante, qual contrato, qual operador — e guardar sem prazo é o que a LGPD
 * chama de excesso; e não menos porque a pergunta que uma trilha responde
 * ("quem mexeu nisso?") costuma chegar meses depois do fato, não dias.
 *
 * Isso segue sendo o PADRÃO, e continua bom. O que era ruim é ser a única
 * resposta: um ISP em disputa judicial precisa de mais, e um que resolveu
 * guardar menos dado pessoal precisa de menos, e as duas mudanças exigiam
 * editar este arquivo e subir deploy. Política de guarda não é constante de
 * código — é decisão de quem responde pelos dados.
 *
 * Os limites existem pelos dois lados. Abaixo de 30 dias a trilha deixa de
 * responder à pergunta que a justifica; acima de 10 anos ela vira o arquivo
 * pessoal que o prazo existe para evitar.
 */
const AUDIT_RETENTION_DEFAULT_DAYS = AUDIT_RETENTION.defaultDays;
const AUDIT_RETENTION_MIN_DAYS = AUDIT_RETENTION.minDays;
const AUDIT_RETENTION_MAX_DAYS = AUDIT_RETENTION.maxDays;

/**
 * The panel's only background worker.
 *
 * One unref'd interval drives every periodic job, and each job decides for
 * itself whether it is due from a timestamp persisted in `app_state`. That is
 * deliberate: the enabled flags are read inside the tick rather than used to
 * start and stop timers, so a Settings toggle takes effect within a minute
 * without a lifecycle to keep in sync, and a restart resumes from the stored
 * timestamps instead of from a blank slate.
 *
 * It is started from `server.js` only, never as an import side effect of
 * `app.js`, so the test suite never has a timer running behind it.
 */
class SchedulerService {
  static timer = null;
  static tickPromise = null;
  static lastPruneAt = 0;

  static async start() {
    if (this.timer) return this.timer;
    // A process that died mid-run leaves rows nothing would ever finish.
    //
    // Per provider, like the tick below. It reaches `provisioning_runs` and
    // nothing else, so the loop divides the work rather than repeating it.
    await forEachTenant(() => ProvisioningService.reapInterrupted(), {
      onError: (error, tenant) => {
        console.warn(`Could not reap interrupted provisioning runs for ${tenant.slug}: ${error.message}`);
      }
    }).catch((error) => {
      console.warn(`Could not reap interrupted provisioning runs: ${error.message}`);
    });
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        console.warn(`Scheduler tick failed: ${error.message}`);
      });
    }, BASE_INTERVAL_MS);
    this.timer.unref();
    return this.timer;
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  static async readState() {
    const raw = await AppState.get(STATE_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }

  static async writeState(patch) {
    const state = await this.readState();
    await AppState.upsert(STATE_KEY, JSON.stringify({ ...state, ...patch }));
  }

  static due(lastRunAt, intervalMs) {
    if (!lastRunAt) return true;
    const last = Date.parse(lastRunAt);
    return !Number.isFinite(last) || Date.now() - last >= intervalMs;
  }

  /**
   * O painel deste provedor, se for a hora dele.
   *
   * Era buscado do caminho da requisição: quem abrisse a tela com o cache
   * vencido pagava a busca da frota inteira do GenieACS. Aqui ela acontece
   * antes de alguém pedir — e, o que importa mais, **só para quem tem alguém
   * pedindo**. A regra de quem, quando e com que folga está inteira em
   * `dashboardSchedule.js`; o que este método acrescenta é que uma falha do
   * ACS de um provedor não derruba os outros jobs do tick dele.
   */
  static async refreshDashboard(state) {
    const atividade = await lastPanelActivityAt();
    // Ninguém entrou há um dia: não há tela aberta para manter quente, e o ACS
    // que seria consultado é o do provedor, não o nosso.
    if (isDormant(atividade)) return null;

    const ttlMs = refreshTtlMs(atividade);
    const due = dueForRefresh({
      lastRunAt: Date.parse(state.lastDashboardAt ?? ''),
      ttlMs,
      offsetMs: tenantOffsetMs(currentTenantId(), ttlMs)
    });
    if (!due) return null;

    try {
      await DeviceService.refreshDashboardData({ ttlMs });
    } catch (error) {
      // Marca a tentativa mesmo assim: sem isso um ACS fora do ar vira uma
      // tentativa por tick, que é o oposto do que este job existe para fazer.
      await this.writeState({ lastDashboardAt: new Date().toISOString() });
      console.warn(`Dashboard refresh failed: ${error.message}`);
      return { refreshed: false, ttlMs };
    }
    await this.writeState({ lastDashboardAt: new Date().toISOString() });
    return { refreshed: true, ttlMs };
  }

  /**
   * One pass over every job. Overlapping ticks collapse onto the running one.
   *
   * The scope is opened here, per tick, and not once around `start()`. A scope
   * taken at boot would be captured by the interval and held for the life of
   * the process, so a provider added afterwards would never be visited at all.
   *
   * Per provider since `provisioning_runs` and `sgp_events` were scoped: every
   * driving query now filters by the provider in scope, so the loop divides
   * the work instead of repeating it. Each provider's own schedule comes from
   * its own `app_state` row, which is what makes that true of the CADENCE and
   * not only of the rows — a provider that reconciles hourly no longer drags
   * one that reconciles daily.
   *
   * One provider failing does not stop the others: a broken ERP integration at
   * one ISP must not be why every other ISP's queue stops draining.
   *
   * The daily prune is decided ONCE per tick, above the loop. `lastPruneAt` is
   * a counter on this class rather than a row, so decided INSIDE a loop the
   * first provider would set it and every provider after it would skip its own
   * prune — for that whole day, every day. The cadence is the deployment's; the
   * rows each pass deletes are the provider's.
   *
   * E a poda roda no laço DELA, `retentionPass`, que visita todo provedor —
   * este aqui visita só os ativos, porque envio, alerta e reconciliação não são
   * para quem está suspenso. Guardar dado dele sem prazo também não era.
   */
  static async tick() {
    if (this.tickPromise) return this.tickPromise;
    const prune = Date.now() - this.lastPruneAt >= PRUNE_INTERVAL_MS;
    if (prune) this.lastPruneAt = Date.now();
    // Antes do laço, e a cada passada: a guarda de egresso pergunta "este
    // deployment serve mais de um provedor?" a uma variável de memória, e é
    // aqui que essa variável aprende. Uma passada por minuto é o atraso máximo
    // entre o provedor número dois nascer e a guarda apertar — contra o estado
    // anterior, em que ela dependia de alguém ter posto `EDITION=saas` no
    // `.env` e ficava larga para sempre quando ninguém pôs.
    this.tickPromise = refreshDeploymentSharing()
      .catch(() => {})
      .then(() => forEachTenant((tenant) => this.runJobs({ tenant }), {
        onError: (error, tenant) => {
          console.warn(`Scheduler tick failed for provider ${tenant.slug}: ${error.message}`);
        }
      }))
      // Os alertas para quem opera a plataforma (0112): FORA do laço por
      // provedor — a fila é uma só, acima de todos, e o laço a mandaria uma
      // vez por provedor. Nunca lança.
      .then(() => PlatformAlertService.schedulerPass().catch((error) => {
        console.warn(`Could not send the platform alerts: ${error.message}`);
      }))
      .then(() => (prune ? this.retentionPass() : undefined))
      .then(() => (prune ? this.pruneTickets() : undefined))
      .then(() => (prune ? this.pruneLeads() : undefined))
      .finally(() => {
        this.tickPromise = null;
      });
    return this.tickPromise;
  }

  /**
   * As duas tabelas de bilhete, podadas FORA do laço por provedor.
   *
   * Fora, e não dentro, porque nenhuma das duas é escopada: um `forEachTenant`
   * as apagaria inteiras uma vez por provedor, e num deploy com trinta ISPs
   * isso é trinta varreduras idênticas por dia. Além disso o laço só visita
   * provedor `active` (`forEachTenant` filtra por `tenants.status`), então um
   * provedor suspenso nunca teria os bilhetes dele podados.
   *
   * Os dois `prune` existiam, testados, sem UM chamador — e o comentário de
   * `AuthTicket.create` já dizia "a poda os leva embora depois, pela idade",
   * o que era falso. Com o cadastro passando a cunhar um bilhete de
   * verificação, a falta deixou de ser teórica: a rota é pública, e toda
   * pessoa que apertar "cadastrar" deixa uma linha que nada apagaria.
   */
  static async pruneTickets() {
    await AuthTicket.prune().catch((error) => {
      console.warn(`Could not prune auth tickets: ${error.message}`);
    });
    await ImpersonationTicket.prune().catch((error) => {
      console.warn(`Could not prune impersonation tickets: ${error.message}`);
    });
  }

  /**
   * Os pedidos de contato da vitrine, podados FORA do laço por provedor — e
   * pelo mesmo argumento de `pruneTickets`: `leads` não é escopada
   * (`SHARED_TABLES`), então um `forEveryTenant` a varreria inteira uma vez por
   * provedor, e num deploy com trinta ISPs isso é trinta varreduras idênticas
   * por dia.
   *
   * Não faz nada quando o prazo está desligado, que é o padrão — e nesse caso
   * nem consulta o banco. Ver `leadRetentionDays`.
   *
   * O número apagado vai para o log quando não é zero: é dado pessoal saindo,
   * e uma poda silenciosa é a que ninguém consegue auditar depois.
   */
  static async pruneLeads() {
    const dias = leadRetentionDays();
    if (dias === 0) return;
    const corte = new Date(Date.now() - dias * 24 * 3600_000);
    await Lead.prune(corte).then((apagados) => {
      if (apagados > 0) {
        console.warn(`Pruned ${apagados} lead(s) older than ${dias} days.`);
      }
    }).catch((error) => {
      console.warn(`Could not prune leads: ${error.message}`);
    });
  }

  static async runJobs({ tenant = null } = {}) {
    const summary = {
      provisioning: null, events: null, reconcile: null, dashboard: null, subscriptionNotice: null, autoTag: null
    };
    const state = await this.readState();

    summary.dashboard = await this.refreshDashboard(state);

    // Manutenção programada: aviso na antecedência, início e fim da janela.
    // Toda volta, sem cadência própria — cada passo tem o seu marcador na
    // própria janela, como o aviso de vencimento logo abaixo.
    await MaintenanceService.processDue().catch((error) => {
      console.warn(`Maintenance windows pass failed: ${error.message}`);
    });

    // As ONTs novas de um provedor num GenieACS compartilhado ganham a tag
    // dele pelo prefixo do login PPPoE — sem ela, ficariam invisíveis para o
    // próprio dono. Desligado (sem tag ou sem prefixo), `runAuto` responde
    // `null` e o relógio não anda, para a primeira passada sair logo que a
    // plataforma ligar. Falha do ACS vira o resumo da passada, não exceção.
    if (this.due(state.lastAutoTagAt, AUTO_TAG_INTERVAL_MS)) {
      summary.autoTag = await DeviceScopeTagger.runAuto().catch((error) => {
        console.warn(`Device auto-tag failed: ${error.message}`);
        return { error: error.message };
      });
      if (summary.autoTag) await this.writeState({ lastAutoTagAt: new Date().toISOString() });
    }

    // Os lembretes de cobrança e a emissão rodam DENTRO do laço por provedor,
    // e não numa passada global sobre `subscriptions`, porque precisam do
    // provedor em escopo de qualquer jeito: a assinatura, o nome, o endereço
    // de cobrança e a equipe saem todos de leituras escopadas. Sem cadência
    // própria — a memória de cada um está no banco — e com o `tenant` vindo
    // do laço, que já entrega a linha inteira de `tenants`.
    //
    // Antes da emissão, a descida de plano agendada para a renovação que já
    // chegou (ver `SubscriptionService.applyPendingPlan`). Antes porque a
    // emissão pergunta pelo plano, e a pergunta tem de ver o plano de agora.
    // As ONTs só são contadas se o plano novo as limita — e só quando há uma
    // descida vencida, que é quase nunca.
    // A retenção no cancelamento (0107), antes de tudo que cobra: o
    // cancelamento agendado cuja data chegou, e a pausa que acabou — esta
    // devolve a cobrança, e a emissão logo abaixo abre a fatura na mesma volta.
    summary.cancellation = await CancellationService.processDue({ tenant }).catch((error) => {
      console.warn(`Could not process the scheduled cancellation or pause: ${error.message}`);
      return { action: 'none', reason: 'error' };
    });

    summary.pendingPlan = await SubscriptionService.applyPendingPlan({
      countDevices: () => DeviceService.countDevicesFromGenieAcs()
    }).catch((error) => {
      console.warn(`Could not apply the scheduled plan change: ${error.message}`);
      return { applied: false, reason: 'error' };
    });

    // O fim da isenção com data de fim, também antes da emissão: desligada
    // aqui, a mesma volta já emite a fatura que ela segurava (ver
    // `SubscriptionService.endExpiredBillingExempt`).
    summary.billingExemptEnded = await SubscriptionService.endExpiredBillingExempt({ tenant })
      .catch((error) => {
        console.warn(`Could not end the expired billing exemption: ${error.message}`);
        return { ended: false, reason: 'error' };
      });

    // O cartão recorrente (0100), antes da emissão: o token que um webhook
    // anotou, a cobrança de cartão que deixou de servir reemitida como
    // Pix/boleto, e o aviso da recusa. Nunca lança (ver `processDue`).
    summary.card = await CardAutopayService.processDue({ tenant }).catch((error) => {
      console.warn(`Card autopay pass failed: ${error.message}`);
      return { error: error.message };
    });

    // O pico de uso do período corrente (0105), ANTES da emissão: é ele que a
    // cobrança da renovação lê para somar o excedente. A cada
    // `USAGE_PEAK_INTERVAL_MS`, e não a cada minuto — um pico que dure menos
    // que isso não muda a conta de um mês, e a contagem de ONTs vai ao ACS.
    // Só os recursos com preço de excedente no plano; a contagem que falha
    // não mexe no pico (ver `SubscriptionService.recordUsagePeaks`).
    if (this.due(state.lastUsagePeakAt, USAGE_PEAK_INTERVAL_MS)) {
      summary.usagePeaks = await SubscriptionService.recordUsagePeaks({
        countDevices: () => DeviceService.countDevicesFromGenieAcs()
      }).catch((error) => {
        console.warn(`Could not record the usage peaks: ${error.message}`);
        return { recorded: false, reason: 'error' };
      });
      await this.writeState({ lastUsagePeakAt: new Date().toISOString() });
    }

    // A mesma contagem de ONTs vai à emissão: é ela que decide se a cobrança
    // da renovação já sai pelo preço da descida agendada (ver `issueCurrent`).
    summary.chargeIssued = await ChargeIssuingService.issueCurrent({
      tenant, countDevices: () => DeviceService.countDevicesFromGenieAcs()
    })
      .catch((error) => {
        console.warn(`Could not issue the subscription charge: ${error.message}`);
        return { issued: false, reason: 'error' };
      });
    // O excedente mensal de quem é ANUAL (0105 + 0104): a fatura de só
    // excedente das fatias mensais que já terminaram. Antes da retentativa
    // das avulsas, que leva ao gateway a que falhar aqui.
    summary.overageSlices = await ChargeIssuingService.issueOverageSlices({ tenant })
      .catch((error) => {
        console.warn(`Could not issue the monthly overage charge: ${error.message}`);
        return { issued: false, reason: 'error' };
      });
    // As faturas de pró-rata (0101) que não chegaram ao gateway na subida.
    summary.prorations = await ChargeIssuingService.retryProrations({ tenant })
      .catch((error) => {
        console.warn(`Could not retry the proration charges: ${error.message}`);
        return { retried: 0, issued: 0, error: error.message };
      });

    // A NFS-e das cobranças pagas que a fila guardou (ver
    // `billingInvoiceService`): pedir as pendentes e consultar as agendadas.
    // Sem cadência própria — a espera de cada nota mora na linha dela.
    summary.invoices = await BillingInvoiceService.processDue().catch((error) => {
      console.warn(`Invoice pass failed: ${error.message}`);
      return { error: error.message };
    });
    // Os lembretes de cobrança, DEPOIS da emissão (0092). A ordem importa: o
    // primeiro lembrete (`before`, cinco dias antes) cai no mesmo dia em que a
    // fatura é emitida (`LEAD_DAYS`), e só depois dela ele tem o link de pagar
    // na mão. A emissão nunca lança (falha vira `reason`), então um gateway
    // fora do ar não impede o lembrete — ele só sai com o endereço do painel.
    summary.subscriptionNotice = await SubscriptionNoticeService.notifyCurrent({ tenant })
      .catch((error) => {
        console.warn(`Could not send the subscription reminder: ${error.message}`);
        return { sent: false, reason: 'error' };
      });
    // A suspensão automática por inadimplência (0102), DEPOIS da régua: o
    // aviso de suspensão e a suspensão são as últimas etapas dela, e no dia
    // em que suspende a mensagem do prazo já saiu. Ver
    // `SubscriptionNoticeService.autoSuspendCurrent`.
    summary.autoSuspend = await SubscriptionNoticeService.autoSuspendCurrent({ tenant })
      .catch((error) => {
        console.warn(`Could not run the automatic suspension: ${error.message}`);
        return { action: 'none', reason: 'error' };
      });

    const provisioningConfig = await ProvisioningService.getConfig();
    if (
      provisioningConfig.enabled
      && this.due(state.lastProvisioningAt, provisioningConfig.intervalSeconds * 1000)
    ) {
      summary.provisioning = await ProvisioningService.processDue({});
      await this.writeState({ lastProvisioningAt: new Date().toISOString() });
    }

    const sgpConfig = await SgpService.getConfig();
    if (SgpService.isReady(sgpConfig)) {
      // Pending events are drained every tick regardless of the reconciliation
      // schedule: a webhook that arrived while the panel was busy should not
      // wait for the next reconciliation window.
      summary.events = await SgpEventService.processPending({ limit: 20 });

      if (
        sgpConfig.reconcileEnabled
        && this.due(state.lastReconcileAt, sgpConfig.reconcileIntervalMinutes * 60_000)
      ) {
        summary.reconcile = await SgpEventService.reconcile({});
        await this.writeState({ lastReconcileAt: new Date().toISOString() });
      }

      // Every client of the SGP into the WhatsApp contacts. Only once the
      // operator has set the listing path and switched it on.
      //
      // Not awaited: a sync of thousands of clients takes minutes, and this
      // tick also drains the outbox and the events of every other job. The
      // clock is written BEFORE the run, so a slow sync is not started again
      // on the next tick, and the service's own lock refuses an overlap with
      // the button in Settings. The tenant scope travels with the promise.
      if (
        sgpConfig.contactsSyncEnabled
        && sgpConfig.endpoints.customerList
        && this.due(state.lastContactsSyncAt, sgpConfig.contactsSyncIntervalHours * 3_600_000)
      ) {
        await this.writeState({ lastContactsSyncAt: new Date().toISOString() });
        summary.contacts = 'started';
        void SgpContactSyncService.syncAll().catch((error) => {
          console.warn(`SGP contacts sync failed: ${error.code || error.message}`);
        });
      }

      // The cancelled contracts with open invoices, to TeiaH Valid. Same shape
      // as the contacts sync above: clock first, run in the background, and
      // the service's own lock refuses an overlap with the Settings button.
      const teiahConfig = await TeiahService.getConfig();
      if (
        TeiahService.isReady(teiahConfig)
        && teiahConfig.exportEnabled
        && this.due(state.lastTeiahExportAt, teiahConfig.exportIntervalHours * 3_600_000)
      ) {
        await this.writeState({ lastTeiahExportAt: new Date().toISOString() });
        summary.teiah = 'started';
        void TeiahExportService.exportAll().catch((error) => {
          console.warn(`TeiaH export failed: ${error.code || error.message}`);
        });
      }

      // A régua de cobrança automática. Mesma forma das duas de cima —
      // relógio antes, passada no fundo — porque é uma ida ao SGP por
      // contrato. `due` responde não, barato, com a régua desligada ou fora
      // da janela de envio; o relógio só anda quando a passada sai de fato.
      if (await WaDunningService.due(state.lastDunningAt).catch(() => false)) {
        await this.writeState({ lastDunningAt: new Date().toISOString() });
        summary.dunning = 'started';
        void WaDunningService.run({}).catch((error) => {
          console.warn(`WhatsApp dunning pass failed: ${error.code || error.message}`);
        });
      }
    }

    return summary;
  }

  /**
   * A retenção, uma vez por provedor — TODOS eles, suspenso incluído.
   *
   * Este bloco morava dentro de `runJobs`, no laço de provedores ativos, ao
   * lado de trabalho que fala com o ERP e com o GenieACS. Ficar lá tinha uma
   * consequência que ninguém escreveu: provedor suspenso não é visitado, então
   * a trilha dele — que num ativo tem prazo de um ano, e guarda qual assinante,
   * qual contrato e quem revelou a senha de quem — não tinha prazo NENHUM. E
   * como não existe prazo de suspensão nem exclusão automática, "nenhum" é
   * literal.
   *
   * Separado por isso: são duas perguntas diferentes. `runJobs` responde "quem
   * está trabalhando?", e `active` continua sendo a resposta certa lá — o
   * suspenso não deve ter fila drenada nem ERP reconciliado. Esta responde "de
   * quem eu ainda guardo dado?", e aí o status não decide nada.
   *
   * Nenhum dos três fala com rede. Os três LANÇAM, e por isso cada um leva o
   * seu `.catch`: uma poda que falha não pode levar as outras duas junto.
   */
  /**
   * O prazo da trilha deste provedor, em dias.
   *
   * Lido a cada passada e não guardado em memória: a poda roda uma vez por dia,
   * então uma consulta a mais não se mede — e um valor memorizado significaria
   * que mudar o prazo na tela só vale depois do próximo restart, que é
   * exatamente o tipo de surpresa que faz alguém achar que a tela não salvou.
   *
   * Valor inválido, ausente ou fora dos limites cai no padrão em vez de
   * levantar: a poda não pode parar porque alguém digitou letra num campo — e
   * uma poda parada é a tabela crescendo em silêncio, que é pior que o prazo
   * errado.
   */
  /**
   * O prazo que vale: o do provedor, limitado pelo teto do plano dele (na
   * SaaS). O teto lê o plano, e um plano ilegível não pode parar a poda — cai
   * no prazo do provedor, que é o que valia antes de existir teto.
   */
  static async auditRetentionDays() {
    const escolhido = await this.chosenAuditRetentionDays();
    try {
      return await SubscriptionService.effectiveRetention('audit', escolhido);
    } catch {
      return escolhido;
    }
  }

  static async chosenAuditRetentionDays() {
    const bruto = String(await Setting.getByKey('auditRetentionDays').catch(() => null) ?? '').trim();
    // Só dígitos, e o texto inteiro. `Number.parseInt` aceita `'12abc'` e
    // devolve 12 — e 12 é um inteiro positivo, então passaria pelo teste de
    // tipo e viraria 30 pelo mínimo. Um prazo de 30 dias que ninguém escolheu,
    // nascido de um campo digitado errado, é pior que o padrão.
    //
    // A regra é a mesma do validador da rota, e a repetição aqui é deliberada:
    // este leitor é a última linha, e alcança valor escrito direto no banco ou
    // por uma versão anterior, que nunca passou por aquele validador.
    if (!/^[0-9]+$/.test(bruto)) return AUDIT_RETENTION_DEFAULT_DAYS;
    const n = Number.parseInt(bruto, 10);
    // Zero não é intenção de guardar menos, é ausência de valor — e no resto
    // deste sistema zero quer dizer "para sempre", que é exatamente o oposto
    // do que um prazo preso em 30 dias faria.
    if (n === 0) return AUDIT_RETENTION_DEFAULT_DAYS;
    return Math.min(Math.max(n, AUDIT_RETENTION_MIN_DAYS), AUDIT_RETENTION_MAX_DAYS);
  }

  static async retentionPass() {
    await forEveryTenant(async () => {
      // As duas tabelas crescem a cada ativação e a cada entrega, então uma
      // instalação movimentada encheria o banco. O dia foi decidido por `tick`;
      // o que sai é o deste provedor, pela retenção dele.
      await ProvisioningService.prune().catch((error) => {
        console.warn(`Could not prune provisioning runs: ${error.message}`);
      });
      await SgpEventService.prune().catch((error) => {
        console.warn(`Could not prune SGP events: ${error.message}`);
      });
      // O que o bot respondeu: 180 dias bastam para o relatório, que olha no
      // máximo 90 para trás.
      await tdb('wa_bot_events').where('created_at', '<', new Date(Date.now() - BOT_EVENTS_RETENTION_DAYS * 24 * 3600_000)).del()
        .catch((error) => {
          console.warn(`Could not prune bot events: ${error.message}`);
        });
      // A trilha de auditoria, pelo prazo DESTE provedor. Ver
      // `auditRetentionDays`: o padrão continua sendo um ano, e agora é padrão
      // e não sentença.
      const dias = await this.auditRetentionDays();
      await AuditLog.prune(new Date(Date.now() - dias * 24 * 3600_000)).catch((error) => {
        console.warn(`Could not prune the audit log: ${error.message}`);
      });
    }, {
      onError: (error, tenant) => {
        console.warn(`Retention pass failed for provider ${tenant.slug}: ${error.message}`);
      }
    });
  }
}

export default SchedulerService;
