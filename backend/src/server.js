import { app, portalApp, APP_ENV } from './app.js';
import { closePool, getDb, testConnection } from './config/database.js';
import { ensureSchema } from './config/schema.js';
import { refreshDeploymentSharing } from './services/genieacsEgress.js';
import { seedDefaults } from './config/seed.js';
import DeviceService from './services/deviceService.js';
import { isDormant, lastPanelActivityAt } from './services/dashboardSchedule.js';
import CustomerService from './services/customerService.js';
import CustomerPortalPasswordService from './services/customerPortalPasswordService.js';
import SchedulerService from './services/schedulerService.js';
import WaOutboxWorker from './services/waOutboxWorker.js';
import WaAlertService from './services/waAlertService.js';
import OutageWatcher from './services/outageWatcher.js';
import DeviceHistoryService from './services/deviceHistoryService.js';
import WaBroadcastService from './services/waBroadcastService.js';
import WaMediaSweeper from './services/waMediaSweeper.js';
import WaMessageSweeper from './services/waMessageSweeper.js';
import { forEachTenant } from './config/tenantJobs.js';
import { installTenantTaggedConsole } from './utils/logger.js';
import { applyRowLevelSecurity, assertRoleEnforcesRls, rlsEnabled } from './config/rls.js';
import { SCOPED_TABLES } from './config/tenantScope.js';
import { buildKnexConfig } from './config/dbConfig.js';
import { agentHub, attachAgentHub } from './services/genieacs/agentHub.js';

// Every `console.*` line written inside a request or a per-provider job
// carries `[tenant=N]` from here on. Done at boot and not at import, so the
// test suite reads its own output untouched.
installTenantTaggedConsole();

const PORT = Number(process.env.APP_PORT) || 5890;
const PORTAL_PORT = process.env.PORTAL_PORT === '0'
  ? 0
  : (Number(process.env.PORTAL_PORT) || 5891);
const HOST = process.env.APP_HOST || '127.0.0.1';
const PORTAL_HOST = process.env.PORTAL_HOST || HOST;

if (PORT !== 0 && PORTAL_PORT !== 0 && PORT === PORTAL_PORT && HOST === PORTAL_HOST) {
  throw new Error('APP_PORT and PORTAL_PORT must be different when using the same host');
}

let server;
let portalServer;

export const startServer = async () => {
  try {
    const dbConnected = await testConnection();

    if (!dbConnected) {
      console.error('Failed to connect to database');
      process.exit(1);
    }

    await ensureSchema();
    await seedDefaults();

    // A guarda de egresso do ACS pergunta a uma variável de memória se este
    // deployment serve mais de um provedor; sem esta linha ela só aprenderia na
    // primeira passada do agendador, e um deploy SaaS sem `EDITION=saas` no
    // `.env` passaria esse primeiro minuto com a tabela de faixas privadas e a
    // allowlist de portas desligadas. Ver `genieacsEgress.js`.
    await refreshDeploymentSharing();

    // O RLS é aplicado no boot, e não por migration, porque ligá-lo é decisão
    // de DEPLOY e não de schema: dois deploys do mesmo código podem querer
    // respostas diferentes, e uma migration daria a mesma para os dois.
    //
    // A checagem do papel vem ANTES de aplicar. Um papel que passa por cima do
    // RLS faria as políticas subirem sem proteger nada, e o deploy acreditaria
    // estar protegido — que é pior do que não ter ligado.
    if (rlsEnabled(buildKnexConfig().client)) {
      await assertRoleEnforcesRls(getDb());
      const tabelas = await applyRowLevelSecurity(getDb(), [...SCOPED_TABLES]);
      console.log(`Row level security applied to ${tabelas.length} tables`);
    }

    server = app.listen(PORT, HOST, () => {
      console.log(`Server running on ${HOST}:${PORT} (${APP_ENV})`);
      // Every boot job below opens a provider scope: none has a request, and
      // the queries under them refuse to run without one. Which primitive each
      // takes is not a style choice — `forEachTenant` divides the work, and is
      // only correct once everything the job reads is itself per provider.
      //
      // The prewarm qualifies now: the GenieACS it reads comes from
      // `settings.genieAcsUrl`, which is per provider, and the accounts it
      // joins against are too.
      //
      // Só para quem tem alguém usando: o prewarm existe para o primeiro
      // operador do dia não esperar pela frota inteira, e um provedor sem
      // ninguém há 24h não tem esse primeiro operador. Sem a poda, subir o
      // processo era buscar a coleção de dispositivos de TODO provedor da
      // instalação, dormente ou não — o pior minuto do dia, e o único em que
      // ninguém está olhando para reclamar.
      void forEachTenant(async () => {
        if (isDormant(await lastPanelActivityAt())) return null;
        return DeviceService.getDashboardData(false);
      }).catch((error) => {
        console.warn(`Dashboard prewarm skipped: ${error.message}`);
      });
      // The Customer ID sweep qualifies too, now that `device_profiles` is per
      // provider — it was the last table under here that was not, `sgp_links`
      // having moved earlier. Everything the sweep reaches is scoped: the
      // devices come from the provider's own GenieACS (`settings.genieAcsUrl`),
      // the accounts it creates and retires are its own, and the SGP link a
      // retirement drops belongs to it. That last one is why this could not be
      // a loop before: two providers' GenieACS hand out the same device ids, so
      // retiring an account used to delete another provider's link for the
      // device id it happened to share.
      void forEachTenant(async () => {
        if (!await CustomerService.isAutoGenerationEnabled()) return null;
        const devices = await DeviceService.getCustomerIdentityDevices();
        return devices.length ? CustomerService.syncDevices(devices, { enabled: true }) : null;
      }, {
        // Named per provider: one ISP with an unreachable GenieACS must be
        // legible as that, not as the sweep having skipped the deployment.
        onError: (error, tenant) => {
          console.warn(`Customer ID prewarm skipped for provider ${tenant.slug}: ${error.message}`);
        }
      }).catch((error) => {
        console.warn(`Customer ID prewarm skipped: ${error.message}`);
      });
      // Accounts created before portal passwords existed authenticated with a
      // slice of their own Customer ID. Give them real credentials in the
      // background so startup is never blocked by a fleet-sized backfill.
      void forEachTenant(() => CustomerPortalPasswordService.backfillMissing())
        .then((counts) => {
          const generated = counts.reduce((total, one) => total + one, 0);
          if (generated > 0) {
            console.log(
              `Generated portal passwords for ${generated} customer account(s); `
              + 'reveal them from the device page before sharing.'
            );
          }
        })
        .catch((error) => {
          console.warn(`Customer portal password backfill skipped: ${error.message}`);
        });
      // The periodic jobs read their own enabled flags, so this starts the
      // driver whether or not the features are on.
      void SchedulerService.start().catch((error) => {
        console.warn(`Background scheduler not started: ${error.message}`);
      });
      // The WhatsApp outbox has its own loop rather than a job inside the
      // scheduler: it runs every few seconds because a reply an operator just
      // typed is waiting on it, while every scheduler job is on a minute or
      // longer. It reads the integration's enabled flag inside each tick, so
      // this arms the driver whether or not WhatsApp is configured.
      WaOutboxWorker.start();
      // The technical-alert scan has its own driver for the opposite reason to
      // the outbox: a pass reads the whole fleet from GenieACS, so it is paced
      // by the operator's `intervalSeconds` rather than by a fixed tick. Like
      // the others it reads its enabled flag inside the tick, so this arms the
      // driver whether or not alerts are configured.
      WaAlertService.start();
      OutageWatcher.start();
      DeviceHistoryService.start();
      // The campaign flush loop is a separate driver on a separate clock: it
      // ticks once a minute because a campaign's budget is written per minute,
      // and it only ever hands recipients to the outbox above. It reads the
      // integration's enabled flag inside each tick, like the worker does.
      WaBroadcastService.start();
      // The attachment sweep is the slowest driver here by three orders of
      // magnitude — a pass every six hours — because it enforces a window
      // measured in days, it walks the whole media tree to do it, and it is
      // the only job on this list that deletes. It reads the retention window
      // inside each tick and does nothing at all while that window is zero,
      // which is the default, so arming it here changes nothing for an
      // installation that never sets one. It deliberately does not sweep at
      // boot: an operator who needs disk now presses the button instead.
      WaMediaSweeper.start();
      // The history sweep keeps the same six-hour clock as the attachment
      // sweep above and for the same reasons, but it is a separate driver
      // because it is a different kind of pass: that one walks a filesystem no
      // provider owns and so runs once for the whole install, this one reads a
      // provider-scoped table and so runs once per provider. It reads the
      // retention window inside each tick and does nothing while that window is
      // zero, which is the default, so arming it here changes nothing for an
      // installation that never sets one. Like its neighbour it does not sweep
      // at boot: a restart must not be a fresh chance to delete history.
      WaMessageSweeper.start();
      console.log(`Panel: http://localhost:${PORT}`);
    });
    // O agente do GenieACS (modo `agent`) conecta por WebSocket no servidor do
    // PAINEL, e só nele: o portal é a porta do assinante, e nada de lá deve
    // aceitar upgrade nenhum. Ver `services/genieacs/agentHub.js` — inclusive a
    // limitação de a conexão viver neste processo.
    attachAgentHub(server);
    portalServer = portalApp.listen(PORTAL_PORT, PORTAL_HOST, () => {
      const address = portalServer.address();
      const activePort = typeof address === 'object' && address ? address.port : PORTAL_PORT;
      console.log(`Customer portal: http://localhost:${activePort}`);
    });
    return server;
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down`);
  SchedulerService.stop();
  WaOutboxWorker.stop();
  WaAlertService.stop();
  OutageWatcher.stop();
  DeviceHistoryService.stop();
  WaBroadcastService.stop();
  WaMediaSweeper.stop();
  WaMessageSweeper.stop();
  // Antes de fechar o servidor: um WebSocket aberto é uma conexão que o
  // `server.close` esperaria para sempre.
  agentHub.close();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (portalServer) {
    await new Promise((resolve) => portalServer.close(resolve));
  }
  await closePool();
  process.exit(0);
}

process.once('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    console.error('Graceful shutdown failed:', error);
    process.exit(1);
  });
});
process.once('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    console.error('Graceful shutdown failed:', error);
    process.exit(1);
  });
});

export default app;
