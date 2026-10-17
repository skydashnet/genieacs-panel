import { AsyncLocalStorage } from 'node:async_hooks';
import Setting from '../../models/Setting.js';
import { getDb } from '../../config/database.js';
import { currentTenantId } from '../../config/tenantContext.js';
import { TranslatableError } from '../../i18n/index.js';
import GenieAcsEgress from '../genieacsEgress.js';
import GenieAcsAuthService from '../genieacsAuthService.js';
import { withAcsSlot } from './concurrency.js';
import { sameAcsAsAny } from './acsIdentity.js';
import { firmwareOwner, validFirmwareName } from '../firmwareFiles.js';

/**
 * O modo `direct`: o painel fala HTTP com a NBI do provedor.
 *
 * É o único modo que existe hoje, e é o caso normal do self-hosted — a NBI na
 * mesma rede, alcançável. Os outros três do plano (agente, túnel, hospedagem
 * própria) entram como irmãos deste arquivo, implementando a mesma superfície,
 * sem que `DeviceService` saiba da diferença.
 *
 * Aqui moram os cinco passos que estavam repetidos em sete lugares: montar a
 * URL a partir da raiz configurada, pôr a credencial, abrir o prazo, pegar a
 * vaga de concorrência e sair pelo egresso com pinagem de DNS. Cada um deles
 * tem uma razão escrita no seu ponto de origem; o que este arquivo acrescenta é
 * que agora eles acontecem **sempre**, e não sempre-que-alguém-lembrar.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * O prazo de quem manda um arquivo inteiro (firmware) à NBI. Os 15 s de sempre
 * são para JSON; 64 MB subindo por um link de provedor levam mais. É o mesmo
 * teto que o agente aceita (`MAX_TIMEOUT_MS` do programa dele).
 */
export const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * A tag de equipamentos do provedor, num GenieACS COMPARTILHADO.
 *
 * O desenho original é um ACS por provedor, e nele o endereço basta para
 * separar as frotas. Quando vários provedores apontam para o MESMO ACS, o
 * endereço não separa nada: cada um veria — e poderia reiniciar, apagar,
 * resetar — a frota de todos. A tag é o que separa: com ela definida, o
 * provedor só enxerga e só age em equipamento que carrega essa tag.
 *
 * Quem grava é a plataforma, pelo console (`platformGenieAcsController`). Vazia
 * é o comportamento de sempre: ACS exclusivo, ou instalação própria.
 */
export const DEVICE_SCOPE_KEY = 'deviceScopeTag';
export const DEVICE_SCOPE_TAG_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/** `{ ...query }` com a busca original E a tag, ou só a tag. */
export function mergeScopeQuery(rawQuery, tag) {
  let base = null;
  if (rawQuery !== undefined && rawQuery !== null && String(rawQuery).trim() !== '') {
    base = typeof rawQuery === 'string' ? JSON.parse(rawQuery) : rawQuery;
  }
  const escopo = { _tags: tag };
  const temBase = base && typeof base === 'object' && Object.keys(base).length > 0;
  return JSON.stringify(temBase ? { $and: [base, escopo] } : escopo);
}

/**
 * Sem o escopo do provedor, só dentro de `fn`. Existe para UMA coisa: a
 * ferramenta da plataforma que marca com a tag os equipamentos que ainda não
 * têm dono — que, por definição, o filtro não deixaria ver.
 */
const semEscopo = new AsyncLocalStorage();
export function withoutDeviceScope(fn) {
  return semEscopo.run(true, fn);
}

/**
 * A tag que nenhuma ONT carrega: o escopo de um provedor SEM tag num GenieACS
 * que outro provedor também usa. Sem ela, esse provedor via a frota de todos;
 * com ela, vê nada até a plataforma definir a tag dele — o lado seguro.
 */
export const UNASSIGNED_SCOPE_TAG = '__sem_tag_de_provedor__';

/** Por provedor: o endereço do ACS dele é usado por outro? Lido do banco no máximo a cada 30 s. */
const compartilhado = new Map();
const COMPARTILHADO_TTL_MS = 30_000;

/** Esquece o que se sabe sobre ACS compartilhado — o console chama ao mudar endereço ou tag. */
export function forgetSharedAcs() {
  compartilhado.clear();
}

const naoEncontrado = () => new TranslatableError('device.notFound', null, { status: 404, code: 'device_not_found' });
const arquivoNaoEncontrado = () => new TranslatableError('device.firmwareNotFound', null, { status: 404, code: 'firmware_not_found' });

/**
 * O caminho de UM arquivo na coleção `files`, com o nome conferido e escapado.
 * Nome torto é "não encontrado" — o mesmo que o escopo responde —, e nunca um
 * caminho montado com ele.
 */
export function filePath(name) {
  if (!validFirmwareName(name)) throw arquivoNaoEncontrado();
  return `files/${encodeURIComponent(name)}`;
}

/**
 * A busca da coleção `files` E o prefixo do dono (`<tag>--`). A tag só tem
 * `[A-Za-z0-9_]` (`DEVICE_SCOPE_TAG_PATTERN`), então vai na expressão sem
 * escape nenhum.
 */
export function mergeFilesOwnerQuery(rawQuery, tag) {
  let base = null;
  if (rawQuery !== undefined && rawQuery !== null && String(rawQuery).trim() !== '') {
    base = typeof rawQuery === 'string' ? JSON.parse(rawQuery) : rawQuery;
  }
  // A tag "sem dono" não é dona de nada: a expressão que nunca casa.
  const dono = tag !== UNASSIGNED_SCOPE_TAG && DEVICE_SCOPE_TAG_PATTERN.test(String(tag)) ? `^${tag}--` : '^$a';
  const escopo = { _id: { $regex: dono } };
  const temBase = base && typeof base === 'object' && Object.keys(base).length > 0;
  return JSON.stringify(temBase ? { $and: [base, escopo] } : escopo);
}

class DirectConnector {
  static mode = 'direct';

  /**
   * O que este modo acrescenta ao egresso. O direto não acrescenta nada; o
   * túnel (`tunnel.js`) libera a rede privada de cliente.
   */
  static egressOptions() {
    return {};
  }

  /** A URL configurada para este provedor, sem normalizar. */
  static async baseUrl() {
    const settings = await Setting.getAll();
    return settings.genieAcsUrl;
  }

  /**
   * A raiz da NBI: esquema, host e porta, sem caminho, busca ou fragmento.
   *
   * Recusa credenciais embutidas na URL e esquema que não seja HTTP(S). As duas
   * recusas são antigas e continuam aqui e não no chamador, porque é aqui que a
   * URL vira destino — quem chama passa um caminho e não escolhe host nenhum.
   */
  static async rootUrl() {
    const baseUrl = await this.baseUrl();
    if (!baseUrl) {
      throw new Error('GenieACS URL not configured');
    }
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('GenieACS URL must use HTTP or HTTPS');
    }
    if (url.username || url.password) {
      throw new Error('Credentials in the GenieACS URL are not supported');
    }
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  }

  /**
   * O destino de um caminho relativo à raiz.
   *
   * **A raiz decide o host; o caminho nunca.** O `endpoint` que chega aqui já
   * teve seus segmentos escapados por quem o montou, e é concatenado depois de
   * ter as barras iniciais removidas — de modo que um caminho absoluto, ou um
   * que comece com `//`, não consegue trocar o servidor. Foi exatamente esse o
   * buraco fechado quando o branch de URL absoluta saiu de `buildGenieAcsUrl`:
   * qualquer chamador que deixasse passar um endpoint controlado por terceiro
   * alcançava um host que o operador nunca configurou.
   */
  static async urlFor(endpoint = '', query = {}) {
    const root = await this.rootUrl();
    const caminho = String(endpoint ?? '').replace(/^\/+/, '');
    const url = new URL(caminho ? `${root}/${caminho}` : root);
    for (const [chave, valor] of Object.entries(query || {})) {
      if (valor !== undefined && valor !== null) {
        url.searchParams.set(chave, String(valor));
      }
    }
    return url;
  }

  /**
   * Uma requisição à NBI, com os cinco passos aplicados.
   *
   * Devolve a `Response` crua de propósito. Três dos sete chamadores precisam
   * de mais do que o corpo — um lê um header de contagem, dois toleram 404 —, e
   * um conector que só devolvesse JSON os obrigaria a montar a requisição por
   * fora, que é como os cinco passos se perdem de novo.
   */
  static async request(endpoint = '', {
    query = {},
    method = 'GET',
    body = null,
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    unscoped = false,
    // Corpo binário (o arquivo de firmware): vai como está, sem
    // `JSON.stringify`, com o `contentType` dado. Exclui `body`.
    rawBody = null,
    contentType = 'application/octet-stream'
  } = {}) {
    // O escopo do provedor vem ANTES de montar a URL: é aqui, e só aqui, que
    // toda conversa com o ACS passa — lista, detalhe, tarefa, tag, falha.
    // `unscoped` é só para o próprio conector (a conferência de posse) e para
    // a ferramenta da plataforma que marca equipamentos ainda sem dono.
    if (!unscoped && !semEscopo.getStore()) {
      const tag = await this.scopeTag();
      if (tag) query = await this.applyScope(tag, endpoint, String(method || 'GET').toUpperCase(), query);
    }
    const url = await this.urlFor(endpoint, query);

    // O prazo E a credencial ficam DEPOIS de a vaga sair, dentro do callback.
    //
    // Antes ele era armado aqui em cima, e a vaga só era pedida no `withAcsSlot`
    // lá embaixo — mas a fila de concorrência espera sem prazo nenhum. Com seis
    // vagas por provedor e uma varredura de frota segurando as suas por
    // segundos, a sétima requisição gastava os 15 s inteiros ESPERANDO e era
    // abortada sem nunca ter aberto socket. Nada distingue esse aborto de um
    // ACS mudo, então o operador lia "o ACS não respondeu" sobre um ACS que
    // ninguém tinha perguntado nada.
    //
    // O prazo mede o que ele diz medir: a requisição.
    //
    // A credencial desceu junto pelo mesmo motivo, e agora importa mais: com a
    // espera na fila podendo ser longa, lê-la antes de entrar na fila seria
    // usar o valor de quando a requisição foi ENFILEIRADA. Ela é lida quando a
    // requisição vai sair — e continua vindo de `nbiHeaders`, que é o único
    // lugar que a monta.
    //
    // O que sai daqui para `send` é o pedido já decidido — destino, método,
    // corpo, prazo — e SÓ o transporte muda de um modo para o outro: o direto
    // e o túnel vão pelo egresso, o agente (`agent.js`) desce pelo WebSocket
    // que o programa do provedor abriu. Escopo, raiz, vaga e prazo continuam
    // aqui, uma vez, para todos.
    return withAcsSlot(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const extras = { ...headers };
        let payload = null;
        if (rawBody !== null && rawBody !== undefined) {
          if (!Buffer.isBuffer(rawBody)) throw new TypeError('rawBody must be a Buffer');
          extras['Content-Type'] = contentType;
          payload = rawBody;
        } else if (body !== null && body !== undefined) {
          extras['Content-Type'] = 'application/json';
          payload = typeof body === 'string' ? body : JSON.stringify(body);
        }
        return await this.send(url, {
          method, headers: extras, body: payload, signal: controller.signal, timeoutMs
        });
      } finally {
        clearTimeout(timeoutId);
      }
    });
  }

  /**
   * O transporte: leva o pedido já montado até a NBI e devolve a `Response`.
   *
   * **A credencial é posta AQUI, por `nbiHeaders`, em todo transporte.** Não
   * em `request`, que seria um lugar só — e é justamente por isso: um
   * transporte novo que recebesse os headers prontos não teria como provar
   * que eles vieram de `nbiHeaders`, e a guarda estática de
   * `genieacs-nbi-auth.test.js` confere, arquivo por arquivo, que cada `send`
   * monta a credencial do lado da sua própria saída. `headers` aqui são só os
   * extras do chamador (e o `Content-Type` quando há corpo).
   *
   * Continua sendo lida quando a requisição vai sair, porque `send` roda
   * dentro da vaga (ver o comentário em `request`).
   */
  static async send(url, { method, headers, body, signal }) {
    const options = {
      method,
      headers: await GenieAcsAuthService.nbiHeaders(headers),
      signal,
      // Nunca seguir 3xx: um host autorizado que responde com redirecionamento
      // está tentando levar a requisição a um lugar que ninguém autorizou, e
      // seguir seria desfazer a guarda de egresso depois de ela ter passado.
      redirect: 'manual'
    };
    if (body !== null && body !== undefined) options.body = body;
    return GenieAcsEgress.fetch(url, { ...options, ...this.egressOptions() });
  }

  /**
   * A tag de equipamentos deste provedor; `null` quando o ACS é só dele.
   *
   * Sem tag num ACS que outro provedor também usa, o escopo é
   * `UNASSIGNED_SCOPE_TAG`: nada casa, e o provedor não vê a frota alheia
   * enquanto a plataforma não define a dele.
   */
  static async scopeTag() {
    const raw = String((await Setting.getByKey(DEVICE_SCOPE_KEY)) ?? '').trim();
    if (DEVICE_SCOPE_TAG_PATTERN.test(raw)) return raw;
    return (await this.sharesAcs()) ? UNASSIGNED_SCOPE_TAG : null;
  }

  /**
   * Outro provedor (não a plataforma) aponta para o mesmo GenieACS que este?
   *
   * "O mesmo" é o de `sameAcsAsAny`: origem normalizada igual ou os mesmos
   * `ip:porta` — o IP no lugar do nome, ou um segundo nome DNS, não fazem do
   * ACS de todos um ACS só deste.
   */
  static async sharesAcs() {
    const id = currentTenantId();
    const guardado = compartilhado.get(id);
    if (guardado && guardado.expiresAt > Date.now()) return guardado.value;
    const minha = await this.baseUrl();
    let value = false;
    if (minha) {
      // tenant-scope-exempt: a pergunta é justamente se OUTRO provedor usa o
      // mesmo ACS — atravessa provedores de propósito, e só lê o endereço.
      //
      // Quem está em modo `agent` não conta: o endereço dele (quando há) é o
      // de dentro da rede DELE, alcançado pelo agente dele, e coincidir com o
      // de outro — `http://localhost:7557` é o de metade das instalações — não
      // é ACS compartilhado. Contá-lo poria o vizinho no escopo vazio.
      const rows = await getDb()('settings')
        .where({ key: 'genieAcsUrl' })
        .whereNot('settings.tenant_id', id)
        .whereIn('settings.tenant_id', getDb()('tenants').whereNot({ kind: 'platform' }).select('id'))
        .whereNotIn('settings.tenant_id', getDb()('tenant_genieacs_connections')
          .where('tenant_genieacs_connections.mode', 'agent')
          .select('tenant_genieacs_connections.tenant_id'))
        .select('value');
      value = await sameAcsAsAny(minha, rows.map((row) => row.value));
    }
    compartilhado.set(id, { value, expiresAt: Date.now() + COMPARTILHADO_TTL_MS });
    return value;
  }

  /**
   * As tags de TODOS os provedores. Leitura fora do escopo de propósito: é o
   * que impede um provedor de pôr (ou tirar) a tag de outro num equipamento.
   */
  static async allScopeTags() {
    // tenant-scope-exempt: as tags de TODOS os provedores, para que um não ponha
    // nem tire a de outro. Atravessa provedores de propósito, e o filtro por
    // `tenant_id` diz quais — os que existem.
    const rows = await getDb()('settings')
      .where({ key: DEVICE_SCOPE_KEY })
      .whereIn('tenant_id', getDb()('tenants').select('id'))
      .select('value');
    return new Set(rows.map((row) => String(row.value ?? '').trim()).filter(Boolean));
  }

  /** O equipamento é deste provedor? Senão, "não encontrado" — nunca "é de outro". */
  static async assertOwned(tag, deviceId) {
    const id = String(deviceId ?? '');
    if (!id) throw naoEncontrado();
    const response = await this.request(this.collectionPath('devices'), {
      unscoped: true,
      query: { query: JSON.stringify({ _id: id, _tags: tag }), projection: '_id' }
    });
    if (!response.ok) throw naoEncontrado();
    const text = await response.text();
    const rows = text ? JSON.parse(text) : [];
    if (!Array.isArray(rows) || rows.length === 0) throw naoEncontrado();
  }

  /**
   * Aplica a tag do provedor a uma requisição.
   *
   * - Leitura da coleção de equipamentos: a busca ganha `_tags = tag`.
   * - Qualquer coisa num equipamento (`devices/<id>/...`: tarefa, tag, apagar):
   *   antes, o equipamento tem que ser do provedor.
   * - Tag de provedor num equipamento: ninguém põe nem tira pela API do painel.
   * - Falha (`faults/<device>:<canal>`): o equipamento da falha tem que ser dele.
   * - Fila de tarefas de um equipamento: idem.
   * - Arquivo (`files/<nome>`: gravar, apagar): só o que leva o prefixo da tag
   *   no nome (`firmwareOwner`); a lista da coleção ganha o mesmo filtro.
   */
  static async applyScope(tag, endpoint, method, query = {}) {
    const caminho = String(endpoint ?? '').replace(/^\/+/, '');
    const partes = caminho.split('/');

    if (partes[0] === 'devices') {
      if (partes.length === 1 || partes[1] === '') {
        if (method !== 'GET') throw naoEncontrado();
        return { ...query, query: mergeScopeQuery(query?.query, tag) };
      }
      const deviceId = decodeURIComponent(partes[1]);
      if (partes[2] === 'tags' && partes[3] !== undefined) {
        const alvo = decodeURIComponent(partes[3]);
        if ((await this.allScopeTags()).has(alvo) || alvo === tag) {
          throw new TranslatableError('device.scopeTagProtected', null, { status: 403, code: 'scope_tag_protected' });
        }
      }
      await this.assertOwned(tag, deviceId);
      return query;
    }

    if (partes[0] === 'faults' && partes[1]) {
      const faultId = decodeURIComponent(partes[1]);
      const corte = faultId.lastIndexOf(':');
      await this.assertOwned(tag, corte > 0 ? faultId.slice(0, corte) : faultId);
      return query;
    }

    if (partes[0] === 'files') {
      if (partes.length === 1 || partes[1] === '') {
        // A lista: só os do dono, já no GenieACS. O serviço filtra de novo
        // (`filesOwnedBy`); isto é a guarda de quem esquecer de filtrar.
        if (method !== 'GET') throw arquivoNaoEncontrado();
        return { ...query, query: mergeFilesOwnerQuery(query?.query, tag) };
      }
      let nome = '';
      try { nome = decodeURIComponent(partes[1]); } catch { nome = ''; }
      // O arquivo de outro provedor, o sem dono e o nome torto respondem o
      // mesmo "não encontrado": nunca confirmar que um nome existe.
      if (partes.length > 2 || tag === UNASSIGNED_SCOPE_TAG || !validFirmwareName(nome)
        || firmwareOwner({ _id: nome }) !== tag) {
        throw arquivoNaoEncontrado();
      }
      return query;
    }

    if (partes[0] === 'tasks' && query?.query) {
      let filtro = {};
      try { filtro = JSON.parse(query.query); } catch { filtro = {}; }
      if (typeof filtro.device === 'string') await this.assertOwned(tag, filtro.device);
      return query;
    }

    return query;
  }

  /**
   * O caminho de uma coleção, com o nome conferido.
   *
   * O nome vem de código nosso em todos os chamadores de hoje, e a conferência
   * existe para o dia em que não vier: um nome com barra ou ponto-ponto sairia
   * da coleção e viraria outro caminho na mesma NBI.
   */
  static collectionPath(collection) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(String(collection))) {
      throw new Error('Invalid GenieACS collection name');
    }
    return String(collection);
  }
}

export default DirectConnector;
