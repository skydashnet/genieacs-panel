import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config/paths.js';
import { currentTenantId } from '../config/tenantContext.js';
import { lerMidiaBase64, urlBaixavel } from '../utils/wa/waMidia.js';
import { safeFetch } from '../utils/wa/ssrfGuard.js';
import WhatsAppConfigService from './whatsappConfigService.js';
import { clientForAccount } from './evolutionClient.js';

/**
 * O anexo de uma mensagem recebida: de onde os bytes vêm, e onde eles param.
 *
 * A regra dura mora em `utils/wa/waMidia.js` e não se repete aqui: `*Message.url`
 * é o objeto CIFRADO no CDN do WhatsApp e NUNCA é um anexo. Este módulo só
 * conhece as duas procedências que prestam — o base64 que o servidor já
 * descriptografou e mandou no evento, e o `mediaUrl` do storage do próprio
 * servidor — mais um último recurso que PERGUNTA ao servidor pelos bytes.
 *
 * Nada aqui levanta exceção para quem chama. Um anexo que não desceu é uma
 * mensagem sem anexo, e uma mensagem sem anexo é infinitamente melhor que um
 * evento de entrada perdido: o webhook responderia não-2xx e os dois servidores
 * reenviariam o mesmo evento em laço.
 */

/**
 * Teto por arquivo. O WhatsApp já limita o envio (16 MB de vídeo, 100 MB de
 * documento no cliente novo), mas o limite que vale é o nosso: quem escreve no
 * disco do painel é um servidor de terceiro falando por uma rota pública.
 */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/** Subpasta de `DATA_DIR`. O caminho gravado no banco é relativo a ela. */
export const MEDIA_DIR = 'wa-media';

/**
 * O nome de uma subárvore de provedor dentro de `MEDIA_DIR`.
 *
 * `t` na frente porque o resto de `wa-media` são nomes de diretório numéricos —
 * ids de conversa — e a varredura precisa distinguir os dois olhando só o nome:
 * `12` é conversa da área legada, `t12` é a subárvore do provedor 12. Sem o
 * prefixo, um id de conversa e um id de provedor seriam a mesma string.
 */
export const TENANT_DIR = /^t([1-9][0-9]*)$/;

/**
 * A subárvore de mídia do provedor em escopo, relativa a `DATA_DIR`.
 *
 * Toda escrita nova passa por aqui. Antes da onda 8 os arquivos iam para
 * `wa-media/<conversa>/`, um caminho sem provedor nenhum — é por isso que a
 * varredura não podia rodar por provedor: a passagem de um veria os arquivos do
 * outro como órfãos sem linha. Com o provedor no caminho, cada passagem enxerga
 * só o que é seu, e a leitura continua aceitando as duas formas porque os
 * arquivos antigos não se mudam.
 */
export function tenantMediaDir(tenantId = currentTenantId()) {
  const id = Number(tenantId);
  if (!Number.isInteger(id) || id <= 0) {
    // Um id que não é id viraria um segmento de caminho arbitrário dentro de
    // `wa-media`. Nada aqui chuta um padrão: quem chamou está sem escopo.
    throw new TypeError(`tenantMediaDir needs a provider id; received ${tenantId}`);
  }
  return path.posix.join(MEDIA_DIR, `t${id}`);
}

/**
 * A mesma subárvore em caminho ABSOLUTO, conferida contra a raiz de `wa-media`.
 *
 * Mora aqui, e não no varredor, porque quem apaga um provedor precisa dela sem
 * ter escopo aberto: a exclusão roda no plano de controle e o provedor está
 * deixando de existir. A conferência só pode falhar por defeito — o único
 * insumo é um id — e é exatamente por isso que vale mantê-la: a falha que ela
 * pega é um `rm` em outro lugar do volume.
 */
export function tenantMediaRoot(tenantId = currentTenantId()) {
  const raiz = path.resolve(DATA_DIR);
  const midia = path.resolve(raiz, MEDIA_DIR);
  const absoluto = path.resolve(raiz, tenantMediaDir(tenantId));
  if (absoluto !== midia && !absoluto.startsWith(midia + path.sep)) {
    throw new Error(`media subtree ${absoluto} falls outside ${midia}`);
  }
  return absoluto;
}

/** O id de provedor que um nome de diretório de primeiro nível carrega, ou null. */
export function tenantIdFromDir(name) {
  const match = TENANT_DIR.exec(String(name || ''));
  return match ? Number(match[1]) : null;
}

/**
 * Os nós de mídia do protocolo, e o tipo que cada um vira para o painel.
 * `pttMessage` é áudio de voz; o WhatsApp o separa de `audioMessage`, o operador
 * não precisa saber disso.
 */
const NOS_DE_MIDIA = [
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['audioMessage', 'audio'],
  ['pttMessage', 'audio'],
  // A "bolinha" de vídeo (recado em vídeo) é um vídeo como outro qualquer.
  ['ptvMessage', 'video'],
  ['documentMessage', 'document'],
  ['stickerMessage', 'sticker']
];

/**
 * Envelopes que embrulham a mensagem de verdade. Uma foto mandada em "ver uma
 * vez", ou numa conversa com mensagens temporárias, chega dentro de um destes —
 * e quem procura `imageMessage` na raiz não acha nada.
 */
const ENVELOPES = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage'
];

const EXTENSOES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'video/quicktime': '.mov',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/amr': '.amr',
  'application/pdf': '.pdf'
};

const EXTENSAO_POR_TIPO = {
  image: '.jpg',
  video: '.mp4',
  audio: '.ogg',
  sticker: '.webp',
  document: '.bin'
};

/** Desembrulha até achar a mensagem de verdade. A profundidade é limitada de
 * propósito: o payload vem de fora e um aninhamento fabricado não vira laço. */
export function desembrulhar(mensagem, profundidade = 0) {
  if (!mensagem || typeof mensagem !== 'object' || profundidade > 4) return mensagem ?? null;
  for (const envelope of ENVELOPES) {
    const dentro = mensagem[envelope];
    if (dentro && typeof dentro === 'object' && dentro.message && typeof dentro.message === 'object') {
      return desembrulhar(dentro.message, profundidade + 1);
    }
  }
  return mensagem;
}

/**
 * O nó de mídia da mensagem, já desembrulhado.
 *
 * @returns {{ tipo: string, no: object, mimetype: string, fileName: string }|null}
 */
export function descreverMidia(mensagem) {
  const alvo = desembrulhar(mensagem);
  if (!alvo || typeof alvo !== 'object') return null;
  for (const [campo, tipo] of NOS_DE_MIDIA) {
    const no = alvo[campo];
    if (!no || typeof no !== 'object') continue;
    return {
      tipo,
      no,
      mimetype: typeof no.mimetype === 'string' ? no.mimetype.slice(0, 128) : '',
      fileName: typeof no.fileName === 'string' ? no.fileName : (typeof no.title === 'string' ? no.title : '')
    };
  }
  return null;
}

/**
 * Nome de arquivo derivado do que o remetente mandou — tratado como texto
 * hostil, porque é. `documentMessage.fileName` chega do celular de qualquer
 * pessoa e já foi visto com barra, com `..` e com 400 caracteres.
 */
export function nomeSeguro(fileName, tipo, mimetype) {
  const bruto = String(fileName || '').split(/[\\/]/).pop() || '';
  let limpo = bruto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    // Um nome começando por ponto vira arquivo oculto, e uma sequência de
    // pontos é a metade de um `..`. Nenhum dos dois precisa existir aqui.
    .replace(/^[._]+/, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, 80);
  const extensao = EXTENSOES[String(mimetype).split(';')[0].trim()] || EXTENSAO_POR_TIPO[tipo] || '.bin';
  if (!limpo) return `${tipo}${extensao}`;
  if (!/\.[A-Za-z0-9]{1,8}$/.test(limpo)) return `${limpo}${extensao}`;
  return limpo;
}

function base64ParaBuffer(base64) {
  // O tamanho é conferido ANTES de decodificar: um base64 de 400 MB fabricado
  // custaria a memória do processo só para depois ser recusado.
  if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 16) return null;
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length || buf.length > MAX_MEDIA_BYTES) return null;
  return buf;
}

/** Lê o corpo com teto, sem confiar no `content-length` do outro lado. */
async function lerCorpoLimitado(res) {
  const declarado = Number(res.headers.get('content-length'));
  if (Number.isFinite(declarado) && declarado > MAX_MEDIA_BYTES) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return null;
  const partes = [];
  let total = 0;
  for await (const pedaco of res.body) {
    total += pedaco.length;
    if (total > MAX_MEDIA_BYTES) {
      await res.body.cancel().catch(() => {});
      return null;
    }
    partes.push(Buffer.from(pedaco));
  }
  return total ? Buffer.concat(partes) : null;
}

/**
 * Último recurso: pedir os bytes ao servidor Evolution.
 *
 * Só faz sentido no v2 com `webhook.base64` desligado — o `createInstanceRequest`
 * liga esse campo, então na prática este caminho cobre a instância criada à mão
 * ou por uma versão anterior do painel.
 *
 * O cliente HTTP pertence a outra parte da onda. Ele é importado de forma
 * preguiçosa e a ausência dele NÃO é erro: sem cliente, o anexo simplesmente
 * não desce por aqui, e as duas procedências boas continuam valendo.
 */
async function pedirAoServidor(account, chave) {
  if (!account?.name || !chave || typeof chave !== 'object' || !chave.id) return null;
  // O GO não publica rota equivalente: ele sempre manda o base64 no evento, e
  // inventar um caminho para ele responderia 404.
  if (account.flavor === 'go') return null;

  const config = await WhatsAppConfigService.getConfig();
  const cliente = clientForAccount(account, config, WhatsAppConfigService.decryptInstanceToken(account));
  const resposta = await cliente.send({
    path: `/chat/getBase64FromMediaMessage/${encodeURIComponent(account.name)}`,
    method: 'POST',
    key: 'instance',
    // O servidor quer a mensagem inteira, mas só a `key` é obrigatória: é por
    // ela que ele acha a `mediaKey` guardada e descriptografa o objeto do CDN.
    body: { message: { key: chave }, convertToMp4: false }
  });
  if (!resposta.ok) return null;
  return lerMidiaBase64(resposta.data);
}

/** Ponto de injeção para o teste: (account, chave) => {base64, mimetype?, fileName?}|null */
let buscarNoServidor = pedirAoServidor;

export function setMediaFetcher(fn) {
  buscarNoServidor = typeof fn === 'function' ? fn : pedirAoServidor;
  return buscarNoServidor;
}

/**
 * Os bytes do anexo, na ordem em que vale a pena tentar.
 *
 * @returns {Promise<{ buf: Buffer, mimetype: string, fileName: string }|null>}
 */
async function resolverBytes({ account, dados, mensagem, midia, chave }) {
  // 1. base64 no próprio evento. É o caminho bom: o servidor já baixou e
  //    descriptografou, e não há segunda requisição para falhar.
  for (const recipiente of [dados, mensagem, midia?.no]) {
    const lida = lerMidiaBase64(recipiente);
    if (!lida) continue;
    const buf = base64ParaBuffer(lida.base64);
    if (buf) return { buf, mimetype: lida.mimetype || midia?.mimetype || '', fileName: lida.fileName || midia?.fileName || '' };
  }

  // 2. `mediaUrl`: o arquivo em claro no storage do próprio servidor Evolution.
  //    Passa por `urlBaixavel` porque um endereço do CDN do WhatsApp às vezes
  //    aparece nesse campo — e o que está lá é cifrado.
  const url = urlBaixavel(dados?.mediaUrl ?? mensagem?.mediaUrl ?? midia?.no?.mediaUrl ?? null);
  if (url) {
    try {
      // A URL vem de fora, então vai pelo guard: ele revalida o host a cada
      // redirect e barra endereço interno.
      //
      // Prazo maior que o padrão do guard, e não por descuido: isto aqui baixa
      // um ARQUIVO de até `MAX_MEDIA_BYTES`, enquanto o padrão é dimensionado
      // para resposta de API. Com 30 s um vídeo de 25 MB exigiria quase 7 Mbps
      // do outro lado para não se perder; com 90 s o piso cai para menos de
      // 2,5 Mbps. Continua sendo um limite — o que não pode existir é a espera
      // sem fim, que é o que prendia o handler do webhook.
      const res = await safeFetch(url, {
        headers: { Accept: '*/*' },
        timeoutMs: 90_000,
        // O teto do transporte tem de ser o MESMO de `lerCorpoLimitado`, senão
        // o padrão do guard — dimensionado para resposta de API — recusaria um
        // vídeo legítimo antes de o teto de mídia sequer ser consultado.
        maxBytes: MAX_MEDIA_BYTES
      });
      if (res.ok) {
        const buf = await lerCorpoLimitado(res);
        if (buf) {
          return {
            buf,
            mimetype: res.headers.get('content-type') || midia?.mimetype || '',
            fileName: midia?.fileName || ''
          };
        }
      } else {
        await res.body?.cancel().catch(() => {});
      }
    } catch {
      // Storage fora do ar, host barrado, timeout: cai para o próximo.
    }
  }

  // 3. Perguntar ao servidor.
  try {
    const lida = await buscarNoServidor(account, chave);
    const buf = lida ? base64ParaBuffer(lida.base64) : null;
    if (buf) return { buf, mimetype: lida.mimetype || midia?.mimetype || '', fileName: lida.fileName || midia?.fileName || '' };
  } catch {
    /* mesmo raciocínio: sem anexo é melhor que sem evento */
  }

  return null;
}

class WaMediaService {
  /**
   * Baixa o anexo de uma mensagem recebida e grava em disco.
   *
   * @returns {Promise<{attachment_path: string, attachment_type: string, attachment_name: string}|null>}
   *   `null` quando a mensagem não tem mídia OU quando os bytes não desceram.
   *   Não gravamos tipo e nome sem o arquivo: uma linha com `attachment_name`
   *   preenchido e `attachment_path` vazio desenha um anexo que não abre, que é
   *   exatamente a aparência de falha que esta integração existe para não ter.
   */
  static async armazenar({ account, conversationId, externalId, dados, mensagem }) {
    const midia = descreverMidia(mensagem);
    if (!midia) return null;

    const chave = dados?.key && typeof dados.key === 'object' ? dados.key : null;
    const bytes = await resolverBytes({ account, dados, mensagem: desembrulhar(mensagem), midia, chave });
    if (!bytes) return null;

    // O id externo entra no nome do arquivo, então é higienizado como o resto:
    // ele vem do payload, não da nossa numeração.
    const idSeguro = String(externalId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'sem-id';
    const nome = nomeSeguro(bytes.fileName || midia.fileName, midia.tipo, bytes.mimetype || midia.mimetype);
    const relativo = path.posix.join(tenantMediaDir(), String(conversationId), `${idSeguro}-${nome}`);
    if (relativo.length > 255) return null;

    const destino = path.join(DATA_DIR, relativo);
    try {
      await fs.mkdir(path.dirname(destino), { recursive: true });
      await fs.writeFile(destino, bytes.buf);
    } catch (error) {
      console.error('[wa] failed to store inbound media:', error.message);
      return null;
    }

    return {
      // Relativo a DATA_DIR de propósito: o volume muda de lugar entre a
      // máquina do provedor e o container, e um caminho absoluto gravado no
      // banco quebraria calado na migração.
      attachment_path: relativo,
      attachment_type: String(bytes.mimetype || midia.mimetype || '').slice(0, 128) || null,
      attachment_name: nome.slice(0, 255)
    };
  }
}

export default WaMediaService;
