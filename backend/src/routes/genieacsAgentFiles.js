import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../config/database.js';
import { agentFileLimiter } from '../middleware/rateLimit.js';
import { panelBaseDomain } from '../middleware/tenantResolver.js';
import { panelUrlFor } from '../services/mail/index.js';

/**
 * Os dois arquivos que o provedor baixa para instalar o agente do GenieACS: o
 * instalador (`deploy/install-agent.sh`) e o programa (`backend/agent/
 * skygenpanel-agent.mjs`).
 *
 * Servidos PELO PAINEL, e não de um repositório público, por um motivo só: a
 * versão. O agente fala um protocolo com o hub deste processo, e o arquivo que
 * sai daqui é, por construção, o da mesma versão do painel que vai atendê-lo.
 * Baixar do GitHub `main` seria instalar o agente de amanhã contra o painel de
 * ontem.
 *
 * Públicas, sem sessão, e é seguro que sejam: nenhum dos dois carrega segredo.
 * A chave do agente é digitada na máquina do provedor e nunca passa por aqui —
 * o instalador foi escrito em volta disso. Quem baixa sem ser provedor leva um
 * programa que sem chave não conecta em nada.
 *
 * Lidos a cada pedido, e não uma vez no boot: são arquivos de poucas dezenas de
 * KB, pedidos uma vez por instalação, e ler no boot faria um `git pull` sem
 * restart servir o instalador velho com o painel novo — ou o contrário.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Relativos a ESTE arquivo, e não ao diretório de trabalho: o serviço do
 * `install.sh` roda com `WorkingDirectory=…/backend`, a imagem Docker com
 * `/app/backend`, os testes com o que o `node --test` herdou. O módulo é o
 * único ponto fixo nos três.
 *
 * O instalador fica fora de `backend/` (é irmão do `install.sh`, em `deploy/`),
 * e é por isso que o `Dockerfile` o copia à parte para `/app/deploy/` — a
 * imagem não leva `deploy/` inteiro.
 */
export const AGENT_PROGRAM_PATH = path.join(__dirname, '..', '..', 'agent', 'skygenpanel-agent.mjs');
export const AGENT_INSTALLER_PATH = path.join(__dirname, '..', '..', '..', 'deploy', 'install-agent.sh');

/**
 * A linha do instalador que recebe a origem do painel. Exata, âncora de linha
 * inteira: o script diz, logo acima dela, para ninguém mudar a forma.
 */
const PLACEHOLDER = /^DEFAULT_PANEL_URL=''$/m;

/**
 * O mesmo conjunto fechado de caracteres que o instalador aceita (`URL_RE` lá).
 * O valor entra entre aspas simples num script que vai rodar como root, então
 * a conferência aqui não é estética: um `'` que passasse fecharia a string e o
 * resto viraria comando. Só letras, dígitos, `.:-[]` no host e `._~/-` no
 * caminho — nenhum deles fecha aspas nem expande nada.
 */
const SAFE_URL = /^https?:\/\/[\][A-Za-z0-9.:-]+(\/[A-Za-z0-9._~/-]*)?$/;

/** A URL normalizada — sem barra no fim, sem credencial, sem query — ou null. */
export function safePanelOrigin(candidate) {
  if (!candidate) return null;
  let parsed;
  try {
    parsed = new URL(String(candidate));
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const pathname = parsed.pathname.replace(/\/+$/, '');
  const value = `${parsed.origin}${pathname}`;
  return SAFE_URL.test(value) ? value : null;
}

/**
 * O endereço público do painel para ESTA requisição, ou null.
 *
 * Nunca o `Host` cru — a regra de `panelUrlFor` e de `billingWebhookUrl`, pelo
 * mesmo motivo: o cabeçalho é de quem pede, e um cache no meio do caminho que
 * guardasse um instalador com a origem de um atacante entregaria a chave do
 * próximo provedor a ele. O que se usa é o que o resolvedor JÁ conferiu:
 *
 * - no endereço da plataforma (o ápice), o domínio-base configurado;
 * - no host de um provedor, o provedor que o resolvedor achou no banco, com o
 *   endereço montado de novo a partir do domínio-base — o host só serviu para
 *   escolher uma linha que existe;
 * - sem subdomínios (todo self-hosted), `PUBLIC_BASE_URL`, se alguém o
 *   configurou; senão null, e o instalador pergunta.
 */
export async function publicPanelOrigin(req) {
  if (req.platformHost) {
    const base = panelBaseDomain();
    return safePanelOrigin(base ? `https://${base}` : null);
  }
  if (req.hostTenantId) {
    const tenant = await getDb()('tenants').where({ id: req.hostTenantId }).first('slug');
    return safePanelOrigin(panelUrlFor(tenant));
  }
  return safePanelOrigin(panelUrlFor(null));
}

/** O instalador com a origem no lugar da linha vazia; intocado sem origem. */
export function injectPanelOrigin(script, origin) {
  const safe = safePanelOrigin(origin);
  if (!safe) return script;
  return script.replace(PLACEHOLDER, () => `DEFAULT_PANEL_URL='${safe}'`);
}

function missing(req, res) {
  return res.status(404).json({
    success: false,
    code: 'agent_file_missing',
    message: req.t ? req.t('common.notFound') : 'Not found'
  });
}

/**
 * `no-cache`, e não o `no-store` que o painel põe em todo `/api`: guardar não
 * faz mal (não há segredo), desde que se pergunte ao painel antes de reusar — é
 * o que faz uma atualização do painel chegar no próximo `curl`. O `nosniff` já
 * vem do helmet; repetido aqui porque é a garantia de que um navegador que abra
 * o link não trate o script como outra coisa.
 */
function fileHeaders(res, contentType) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache');
  res.removeHeader('Pragma');
}

async function readOrNull(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * O programa do agente. Sem o arquivo — um checkout anterior à chegada dele, ou
 * uma imagem montada errado —, 404 com código próprio: o instalador para ali
 * com uma mensagem, em vez de gravar uma página de erro como `.mjs`.
 */
export function serveAgentProgram(filePath = AGENT_PROGRAM_PATH) {
  return async (req, res, next) => {
    try {
      const source = await readOrNull(filePath);
      if (source === null) return missing(req, res);
      fileHeaders(res, 'text/javascript; charset=utf-8');
      return res.send(source);
    } catch (error) {
      return next(error);
    }
  };
}

export function serveAgentInstaller(filePath = AGENT_INSTALLER_PATH) {
  return async (req, res, next) => {
    try {
      const script = await readOrNull(filePath);
      if (script === null) return missing(req, res);
      const origin = await publicPanelOrigin(req);
      fileHeaders(res, 'text/x-shellscript; charset=utf-8');
      return res.send(injectPanelOrigin(script, origin));
    } catch (error) {
      return next(error);
    }
  };
}

const router = express.Router();

// As duas sem sessão, declaradas em `PUBLICAS` de route-coverage.test.js. Um
// limitador próprio por cima do `apiLimiter`: quem instala pede cada arquivo
// uma vez, e o teto só existe para que baixar em laço não custe leitura de
// disco a cada pedido.
router.get('/install.sh', agentFileLimiter, serveAgentInstaller());
router.get('/agent.mjs', agentFileLimiter, serveAgentProgram());

export default router;
