import { createSecretBox, LEGACY_KEY_VERSION } from '../utils/secretBox.js';
import { getDb, tdb } from '../config/database.js';
import AppState from '../models/AppState.js';
import Tenant from '../models/Tenant.js';
import { runInTenant } from '../config/tenantContext.js';

/**
 * A metade que faltava da rotação da `SECRET_BOX_KEY`.
 *
 * A outra metade já existia, e é a que engana: pondo a chave antiga em
 * `SECRET_BOX_KEY_PREVIOUS`, o painel LÊ o que foi cifrado com ela e ESCREVE só
 * com a nova. Quem roda a rotação vê tudo funcionando — porque a chave velha
 * ainda está no ambiente. O que não existia é o passo que percorre as linhas
 * antigas e as reescreve, e sem ele uma linha só migra quando alguém a edita.
 *
 * Na prática isso quer dizer: a senha de portal de um assinante que ninguém
 * regerou, a credencial NBI de um provedor que ninguém re-salvou e o token do
 * Evolution de uma instância que já está pareada ficam na chave antiga para
 * sempre. No dia em que alguém limpar `SECRET_BOX_KEY_PREVIOUS` do `.env` — o
 * passo natural de "terminar a rotação", que o README manda dar — esses
 * segredos param de descriptografar EM SILÊNCIO: `decrypt` responde `null`, e
 * no portal `hasSavedPassword` continua dizendo que existe senha, porque só
 * testa se as colunas estão preenchidas.
 *
 * ## A regra que decide se este módulo presta
 *
 * `decrypt` devolve `null` para duas coisas diferentes: "não havia segredo" e
 * "não tenho a chave que escreveu isto". Um laço que trate `null` como "nada a
 * fazer" marca como migrada exatamente a linha que ficou ilegível — que é a
 * perda de dado que o `key_version` existe para evitar.
 *
 * Por isso três estados, nunca dois:
 *
 * - colunas vazias  → não havia segredo, pular;
 * - decifrou        → re-cifrar com a chave viva;
 * - colunas cheias e `decrypt` devolveu `null` → **parar e falhar alto**.
 *
 * ## Por que TODO segredo é reescrito, e não só os "desatualizados"
 *
 * Porque não dá para saber quais são. O `key_version` distingue a chave
 * derivada do `JWT_SECRET` (1) da derivada do `SECRET_BOX_KEY` (2) — e não
 * distingue duas chaves DENTRO da versão 2. Rotacionar a `SECRET_BOX_KEY` deixa
 * a versão em 2 nos dois lados, antes e depois, porque o que mudou foi a chave
 * e não a origem dela.
 *
 * Uma primeira versão deste arquivo pulava as linhas já na versão 2 achando que
 * estavam em dia. Pulava exatamente as linhas que este comando existe para
 * mover, e o teste que tira a chave anterior do ambiente foi quem disse isso.
 *
 * Re-cifrar o que já está na chave viva é inofensivo: troca o IV, não o
 * segredo. O `--dry-run` continua respondendo o que interessa antes de mexer —
 * quantos segredos existem em cada versão.
 *
 * ## O que este comando NÃO resolve, e ninguém tinha escrito
 *
 * Cada backup grava a impressão digital de `SECRET_BOX_KEY` e de `JWT_SECRET`
 * (`deploy/skygenpanel-backup`), e `skygenpanel backup verify` recusa um
 * restore cuja chave não bate. A retenção padrão é 30 diários mais 52 semanais
 * — perto de um ano de cópias, todas tiradas com a chave ANTIGA.
 *
 * Então reescrever as linhas torna seguro largar a chave anterior **para o
 * banco vivo**, e não para o histórico de backup: o dado velho está nos dumps.
 * A chave antiga tem que continuar arquivada junto com eles. É o que o resumo
 * deste comando diz ao operador, em vez de deixá-lo descobrir no dia do
 * restore.
 */

/** Um segredo em colunas: a tabela, o prefixo das colunas e a de versão. */
const COLUNAS = Object.freeze([
  {
    tabela: 'customer_accounts',
    prefixo: 'password',
    versao: 'password_key_version',
    contexto: 'skygenpanel-customer-portal-password-v1'
  },
  {
    tabela: 'customer_wifi_credentials',
    prefixo: 'password',
    versao: 'password_key_version',
    contexto: 'skygenpanel-customer-wifi-password-v1'
  },
  {
    tabela: 'provisioning_profiles',
    prefixo: 'wifi_password',
    versao: 'wifi_password_key_version',
    contexto: 'skygenpanel-provisioning-profile-v1'
  },
  {
    tabela: 'provisioning_profiles',
    prefixo: 'cpe_password',
    versao: 'cpe_password_key_version',
    // O MESMO contexto do de cima, de propósito: os dois vivem na mesma linha e
    // foram cifrados pela mesma caixa. Dar um contexto próprio a este aqui
    // tornaria a re-cifra ilegível pelo serviço que a lê.
    contexto: 'skygenpanel-provisioning-profile-v1'
  },
  {
    tabela: 'whatsapp_accounts',
    prefixo: 'token',
    versao: 'token_key_version',
    contexto: 'skygenpanel-evolution-instance-token-v1'
  },
  {
    tabela: 'whatsapp_accounts',
    prefixo: 'webhook_token',
    versao: 'webhook_token_key_version',
    contexto: 'skygenpanel-evolution-webhook-token-v1'
  },
  {
    // O token do cartão recorrente (0100) — ver `cardAutopayService`. A
    // assinatura é escopada, então entra no laço dos provedores como as outras.
    tabela: 'subscriptions',
    prefixo: 'card_token',
    versao: 'card_token_key_version',
    contexto: 'skygenpanel-subscription-card-token-v1'
  }
]);

/**
 * Um segredo guardado dentro de um JSON em `app_state`.
 *
 * `caminho` é onde o envelope mora no objeto. E o envelope é
 * `{ v: 1, password_ciphertext, password_iv, password_tag, password_key_version }`
 * — onde **`v` NÃO é a versão da chave**. É a versão do formato do envelope, é
 * constante, e confundir os dois é a forma mais fácil de estragar este arquivo.
 * A versão da chave é o `password_key_version` de dentro.
 */
const BLOBS = Object.freeze([
  {
    chave: 'genieacs_auth_config',
    caminho: ['secret'],
    contexto: 'skygenpanel-genieacs-nbi-v1'
  },
  {
    chave: 'sgp_integration_config',
    caminho: ['token'],
    contexto: 'skygenpanel-sgp-token-v1'
  },
  {
    // O MESMO blob do de cima, outro contexto. Re-cifrar os dois com a mesma
    // caixa destruiria um deles, sem erro e sem volta.
    chave: 'sgp_integration_config',
    caminho: ['webhookSecret'],
    contexto: 'skygenpanel-sgp-webhook-secret-v1'
  },
  {
    // A chave de API da TeiaH Valid do provedor.
    chave: 'teiah_integration_config',
    caminho: ['apiKey'],
    contexto: 'skygenpanel-teiah-apikey-v1'
  },
  {
    chave: 'whatsapp_evolution_config',
    caminho: ['managedAdminKey'],
    contexto: 'skygenpanel-evolution-admin-key-v1'
  },
  {
    // O token de verificação do webhook da Meta (API oficial), no mesmo blob.
    chave: 'whatsapp_evolution_config',
    caminho: ['cloudVerifyToken'],
    contexto: 'skygenpanel-evolution-meta-verify-token-v1'
  },
  {
    // O token do bot do Telegram dos alertas, dentro dos ajustes de alerta.
    chave: 'whatsapp_alert_settings',
    caminho: ['telegram', 'botToken'],
    contexto: 'skygenpanel-telegram-bot-v1'
  },
  {
    // A conta da plataforma no Asaas, gravada pelo console na caixa da
    // plataforma: a chave da API que CHAMA o gateway...
    chave: 'asaas_gateway_config',
    caminho: ['apiKey'],
    contexto: 'skygenpanel-asaas-gateway-v1'
  },
  {
    // ...e o token que o gateway devolve na entrega do webhook. O mesmo blob e,
    // ao contrário do SGP acima, a MESMA caixa — os dois foram cifrados por ela
    // (`asaasSettingsService`), e é essa caixa que tem de re-cifrar os dois.
    chave: 'asaas_gateway_config',
    caminho: ['webhookToken'],
    contexto: 'skygenpanel-asaas-gateway-v1'
  },
  {
    // A chave da API de IA do atendimento (Claude, OpenAI-compatível…).
    chave: 'wa_bot_config',
    caminho: ['ai', 'apiKey'],
    contexto: 'skygenpanel-wa-ai-key-v1'
  }
]);

/**
 * Segredos em tabela COMPARTILHADA — da pessoa, e não de um provedor.
 *
 * O segredo do login em duas etapas mora em `users`, que não tem provedor: a
 * mesma pessoa entra em vários. Por isso ele é rotacionado uma vez, fora do
 * laço dos provedores. Sem esta lista, seria o primeiro segredo do painel fora
 * da rotação — e o dia de largar a chave anterior trancaria todo mundo que usa
 * o 2FA do lado de fora.
 */
const COLUNAS_COMPARTILHADAS = Object.freeze([
  {
    tabela: 'users',
    prefixo: 'totp',
    versao: 'totp_key_version',
    contexto: 'skygenpanel-user-totp-v1'
  }
]);

/**
 * As caixas, criadas AQUI e não importadas dos serviços.
 *
 * Os serviços chamam `createSecretBox` no topo do módulo, então as chaves deles
 * ficam congeladas no instante do import. Um comando que mexesse no ambiente
 * depois disso falaria com caixas que ainda têm as chaves antigas.
 */
function caixas() {
  const porContexto = new Map();
  for (const contexto of [...COLUNAS, ...COLUNAS_COMPARTILHADAS, ...BLOBS].map((s) => s.contexto)) {
    if (!porContexto.has(contexto)) porContexto.set(contexto, createSecretBox(contexto));
  }
  return porContexto;
}

/** O envelope que `secretBox` lê, montado a partir de um prefixo de coluna. */
function envelopeDe(linha, prefixo) {
  return {
    password_ciphertext: linha[`${prefixo}_ciphertext`],
    password_iv: linha[`${prefixo}_iv`],
    password_tag: linha[`${prefixo}_tag`]
  };
}

function temSegredo(envelope) {
  return Boolean(envelope.password_ciphertext && envelope.password_iv && envelope.password_tag);
}

/** O erro que para tudo: cheio e ilegível é perda de dado, não "nada a fazer". */
class SecretUnreadableError extends Error {
  constructor(onde) {
    super(
      `${onde} guarda um segredo que nenhuma chave deste processo abre. `
      + 'Ponha a chave que o escreveu em SECRET_BOX_KEY_PREVIOUS (ou JWT_SECRET_PREVIOUS '
      + 'para a versão 1) antes de rodar de novo. Nada foi reescrito.'
    );
    this.name = 'SecretUnreadableError';
  }
}

class SecretRotationService {
  static get COLUNAS() { return COLUNAS; }
  static get COLUNAS_COMPARTILHADAS() { return COLUNAS_COMPARTILHADAS; }
  static get BLOBS() { return BLOBS; }

  /**
   * Percorre todo provedor e conta, ou reescreve.
   *
   * `Tenant.list()` e não `forEachTenant`: aquele visita só provedor `active`,
   * e um suspenso ficaria na chave antiga — virando lixo no dia em que a
   * anterior saísse do `.env`, que é exatamente o dia em que este comando
   * deveria ter tornado seguro tirá-la.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.dryRun] Só conta. Nada é escrito.
   * @returns {Promise<{versoes: Record<number, number>, reescritas: number}>}
   */
  static async run({ dryRun = false } = {}) {
    const boxes = caixas();
    const resumo = { versoes: {}, reescritas: 0 };
    const contar = (versao) => {
      resumo.versoes[versao] = (resumo.versoes[versao] ?? 0) + 1;
    };

    for (const tenant of await Tenant.every()) {
      // eslint-disable-next-line no-await-in-loop -- em série de propósito: o
      // relatório precisa ser determinístico e o volume é pequeno.
      await runInTenant(tenant.id, async () => {
        for (const alvo of COLUNAS) {
          await this.rotacionarColuna(alvo, boxes.get(alvo.contexto), { dryRun, contar, resumo });
        }
        for (const alvo of BLOBS) {
          await this.rotacionarBlob(alvo, boxes.get(alvo.contexto), { dryRun, contar, resumo });
        }
      });
    }

    // Uma vez, fora de qualquer provedor: a tabela é da pessoa.
    for (const alvo of COLUNAS_COMPARTILHADAS) {
      // eslint-disable-next-line no-await-in-loop -- em série, como o resto
      await this.rotacionarColuna(alvo, boxes.get(alvo.contexto), { dryRun, contar, resumo, consulta: getDb() });
    }

    return resumo;
  }

  static async rotacionarColuna(alvo, box, { dryRun, contar, resumo, consulta = null }) {
    const { tabela, prefixo, versao } = alvo;
    const db = (nome) => (consulta ? consulta(nome) : tdb(nome));
    const linhas = await db(tabela)
      .whereNotNull(`${prefixo}_ciphertext`)
      .select('id', `${prefixo}_ciphertext`, `${prefixo}_iv`, `${prefixo}_tag`, versao);

    for (const linha of linhas) {
      const envelope = { ...envelopeDe(linha, prefixo), password_key_version: linha[versao] };
      if (!temSegredo(envelope)) continue;
      contar(Number(envelope.password_key_version) || LEGACY_KEY_VERSION);

      const aberto = box.decrypt(envelope);
      if (aberto === null) throw new SecretUnreadableError(`${tabela}#${linha.id}.${prefixo}`);
      if (dryRun) continue;

      const cifrado = box.encrypt(aberto);
      await db(tabela).where({ id: linha.id }).update({
        [`${prefixo}_ciphertext`]: cifrado.password_ciphertext,
        [`${prefixo}_iv`]: cifrado.password_iv,
        [`${prefixo}_tag`]: cifrado.password_tag,
        [versao]: cifrado.password_key_version
      });
      resumo.reescritas += 1;
    }
  }

  static async rotacionarBlob(alvo, box, { dryRun, contar, resumo }) {
    const { chave, caminho } = alvo;
    const cru = await AppState.get(chave);
    if (!cru) return;

    let objeto;
    try {
      objeto = JSON.parse(cru);
    } catch {
      // Um blob ilegível como JSON não é problema desta rotação: quem o lê já
      // trata isso, e reescrevê-lo daqui seria adivinhar.
      return;
    }

    const envelope = caminho.reduce((atual, parte) => atual?.[parte], objeto);
    if (!envelope || typeof envelope !== 'object' || !temSegredo(envelope)) return;
    contar(Number(envelope.password_key_version) || LEGACY_KEY_VERSION);

    const aberto = box.decrypt(envelope);
    const onde = `app_state['${chave}'].${caminho.join('.')}`;
    if (aberto === null) throw new SecretUnreadableError(onde);
    if (dryRun) return;

    // `v` preservado: é a versão do FORMATO do envelope, não da chave. Perdê-lo
    // aqui mudaria o contrato que os serviços leem, em silêncio.
    const { v } = envelope;
    const cifrado = box.encrypt(aberto);
    let alvoNo = objeto;
    for (const parte of caminho.slice(0, -1)) alvoNo = alvoNo[parte];
    alvoNo[caminho[caminho.length - 1]] = { ...(v === undefined ? {} : { v }), ...cifrado };

    await AppState.upsert(chave, JSON.stringify(objeto));
    resumo.reescritas += 1;
  }
}

export { SecretUnreadableError };
export default SecretRotationService;
