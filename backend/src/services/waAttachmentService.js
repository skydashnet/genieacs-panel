import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { DATA_DIR } from '../config/paths.js';
import { WaError } from './whatsappConfigService.js';
import { nomeSeguro, tenantMediaDir } from './waMediaService.js';
import {
  ATTACHMENT_TYPES,
  ATTACHMENT_TYPE_ALIASES,
  MAX_ATTACHMENT_MB
} from '../config/waAttachmentTypes.js';
import { matchesDeclaredType } from '../utils/wa/sniffAttachment.js';

/**
 * The file the OPERATOR sends, on its way in.
 *
 * The inbound half of this lives in `waMediaService`: bytes that arrive from
 * the Evolution server, written under `DATA_DIR/wa-media/t<id>/<conversa>/`.
 * This is the other direction — a photo of the fibre path, the invoice as a
 * PDF — and it shares that module's two decisions on purpose: the path stored
 * in the database is relative to `DATA_DIR`, and the name that came from
 * outside is treated as text to display and never as a path to resolve.
 *
 * What it does NOT share is the type list. `waMediaService` maps whatever the
 * customer's phone sent so the operator can at least see it; this side is an
 * allowlist, because these bytes are written by a request and served back by
 * the panel on the panel's own origin. `image/svg+xml` is left out of it
 * deliberately: an SVG is a script that happens to draw, and the one place it
 * would run is the session of the operator who opened it.
 */

/** The ceiling, in bytes and in the unit the refusal says out loud. O número
 * mora em `config/waAttachmentTypes.js`, que a tela também lê; reexportado aqui
 * para quem já importava daqui. */
export { MAX_ATTACHMENT_MB };
export const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;

/**
 * The whole allowlist, and the extension each accepted type is stored with.
 *
 * The extension comes from HERE and never from the name the operator sent: the
 * name is a label under a bubble, while the extension is half of what a browser
 * decides to do with the file later. A `laudo.html` uploaded as `image/png` is
 * stored as `.png`, and a `foto.png` uploaded as `text/html` is not stored.
 */
export const ALLOWED_TYPES = Object.freeze(Object.fromEntries(
  // Derivado da lista única: a primeira extensão de cada linha é a do disco.
  ATTACHMENT_TYPES.map((row) => [row.type, row.extensions[0]])
));

/** A linha da lista para um tipo já normalizado, ou undefined. */
const TYPE_ROWS = new Map(ATTACHMENT_TYPES.map((row) => [row.type, row]));

/**
 * The provider's outbound subfolder, so inbound and outbound never collide.
 *
 * A function rather than a constant because the provider is now part of the
 * path: `wa-media/t<id>/out`. Resolved per call, from the scope the request
 * already opened, which is the only place the answer exists.
 */
export function outDir() {
  return path.posix.join(tenantMediaDir(), 'out');
}

/** The path the raw-body parser is mounted on. Exported so `app.js` and the
 * router cannot drift apart: reserving the wrong path would hand a 12 MB photo
 * to the global JSON parser. */
export const ATTACHMENT_PATH = '/api/whatsapp/attachments';

/**
 * The `Content-Type` without its parameters, lowercased — e com o apelido
 * trocado pelo nome da lista (`image/jpg` → `image/jpeg`). O apelido só entra
 * por aqui: o que se guarda e o que se compara é sempre o nome canônico.
 */
export function normalizeType(contentType) {
  const base = String(contentType || '').split(';')[0].trim().toLowerCase();
  return ATTACHMENT_TYPE_ALIASES[base] || base;
}

/**
 * The name to show, from the percent-encoded header.
 *
 * `decodeURIComponent` throws on a malformed sequence — a header written by
 * hand rather than by `encodeURIComponent` — and that is a bad name, not a
 * 500: it falls back to the raw header, which `nomeSeguro` then strips of
 * everything that is not a plain filename. Path separators, `..` and leading
 * dots do not survive it, so `../../etc/passwd` arrives here as `passwd` and
 * is stored as a label beside a file whose real name is a UUID.
 */
export function displayName(headerValue, type) {
  const raw = String(headerValue || '');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const nome = nomeSeguro(decoded, 'document', type);
  return comExtensaoDoTipo(nome, decoded, type);
}

/**
 * O rótulo terminando numa extensão que o tipo aceita.
 *
 * No WhatsApp o nome do documento é o que o celular do assinante usa para
 * decidir com que app abrir: um `.docx` que chega como `contrato.bin` não abre,
 * e um PDF que chega como `fatura.exe` é pior. `nomeSeguro` só conhece as
 * extensões de mídia recebida, então sem nada aqui um nome sem extensão ganhava
 * `.bin`. A extensão de um nome que não combina com o tipo é mantida e a do
 * tipo é acrescentada depois (`relatorio.final.pdf`), para não comer um pedaço
 * do nome que o operador escolheu.
 */
function comExtensaoDoTipo(nome, original, type) {
  const row = TYPE_ROWS.get(type);
  if (!row) return nome;
  const principal = row.extensions[0];
  const atual = path.extname(nome).toLowerCase();
  if (row.extensions.includes(atual)) return nome;
  // `nomeSeguro` pôs `.bin` num nome que veio sem extensão: é essa que sai.
  const semBin = atual === '.bin' && path.extname(String(original)).toLowerCase() !== '.bin'
    ? nome.slice(0, -atual.length)
    : nome;
  return `${semBin}${principal}`;
}

/**
 * O nome depois da conversão: a extensão antiga sai e entra a do tipo novo.
 * `IMG_0001.HEIC` vira `IMG_0001.jpg` — o assinante recebe um JPEG, e um nome
 * dizendo HEIC faria o celular dele procurar o app errado.
 */
function trocarExtensao(nome, type) {
  const extensao = ALLOWED_TYPES[type];
  const atual = path.extname(nome);
  return `${atual ? nome.slice(0, -atual.length) : nome}${extensao}`;
}

/**
 * HEIC → JPEG, com o conversor carregado só na primeira foto de iPhone.
 *
 * `heic-convert` puxa um decodificador HEVC inteiro em JS/wasm; carregar isso
 * na subida do painel custaria memória a todo provedor que nunca recebe HEIC.
 * Qualquer falha — arquivo truncado, HEIC com a marca certa e o miolo errado —
 * vira a mesma recusa de conteúdo: o que o operador mandou não é o que disse.
 */
async function converter(buffer, destino) {
  if (destino !== 'image/jpeg') throw new Error(`conversão não suportada: ${destino}`);
  const { default: convert } = await import('heic-convert');
  const saida = await convert({ buffer, format: 'JPEG', quality: 0.9 });
  return Buffer.from(saida);
}

function recusaDeConteudo() {
  return new WaError('whatsapp.error.attachmentContentMismatch', {
    code: 'attachment_content_mismatch',
    status: 415
  });
}

class WaAttachmentService {
  /**
   * Validates the upload and writes it under `DATA_DIR`.
   *
   * Throws `WaError` with the machine codes the contract froze — the screen
   * translates the code, never the message beside it.
   *
   * @returns {Promise<{ path: string, type: string, name: string }>}
   *   `path` is relative to `DATA_DIR`, which is exactly what `sendMessage`
   *   takes as `attachment.url` and what the inbound side already stores.
   */
  static async store({ buffer, contentType, fileName }) {
    if (!Buffer.isBuffer(buffer)) {
      // No body, or a body the raw parser did not take because the request
      // carried no `Content-Type` at all. Either way there is no accepted type
      // here, which is the same refusal as a rejected one.
      throw new WaError('whatsapp.error.attachmentTypeNotAllowed', {
        code: 'attachment_type_not_allowed',
        status: 415
      });
    }

    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new WaError('whatsapp.error.attachmentTooLarge', {
        code: 'attachment_too_large',
        status: 413,
        vars: { max: MAX_ATTACHMENT_MB }
      });
    }

    if (buffer.length === 0) {
      // Storing it would put a nought-byte file on the customer's phone: a
      // download that opens onto nothing, indistinguishable from a corrupt
      // upload. Refusing costs the operator one retry and says why.
      throw new WaError('whatsapp.error.attachmentEmpty', {
        code: 'attachment_empty',
        status: 400
      });
    }

    const declared = normalizeType(contentType);
    const row = TYPE_ROWS.get(declared);
    if (!row) {
      throw new WaError('whatsapp.error.attachmentTypeNotAllowed', {
        code: 'attachment_type_not_allowed',
        status: 415
      });
    }

    // O tipo está na lista; agora, se os bytes são mesmo dele. Depois do teto e
    // do vazio, que são mais baratos e já dizem o motivo certo.
    if (!matchesDeclaredType(buffer, declared)) throw recusaDeConteudo();

    let bytes = buffer;
    let type = declared;
    if (row.convertTo) {
      try {
        bytes = await converter(buffer, row.convertTo);
      } catch {
        throw recusaDeConteudo();
      }
      // O teto vale para o que sai também: é o JPEG que vai para o WhatsApp, e
      // o limite de mídia de lá não sabe que o arquivo já foi um HEIC menor.
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        throw new WaError('whatsapp.error.attachmentTooLarge', {
          code: 'attachment_too_large',
          status: 413,
          vars: { max: MAX_ATTACHMENT_MB }
        });
      }
      type = row.convertTo;
    }
    const extension = ALLOWED_TYPES[type];

    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    // A UUID rather than anything derived from the upload: the only two inputs
    // this route has are bytes and a name, and neither may decide where the
    // bytes land. Two operators uploading `foto.jpg` in the same minute is the
    // ordinary case, not the exotic one.
    const relative = path.posix.join(outDir(), year, month, `${crypto.randomUUID()}${extension}`);
    const destination = path.join(DATA_DIR, relative);

    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes);

    const name = type === declared
      ? displayName(fileName, type)
      : trocarExtensao(displayName(fileName, declared), type);
    return { path: relative, type, name };
  }
}

/**
 * The raw-body mount, kept here so `app.js` carries one line.
 *
 * The reasoning is the SGP webhook's, one step further. The webhook mounts
 * `express.raw` on its path before the global `express.json` because
 * body-parser marks the body as read and the parser below then skips it; here
 * the same reservation is what stops a 12 MB photo from dying as a JSON parse
 * error against a 1 MB ceiling. The panel gets no multipart dependency for one
 * screen, which is the choice the contract froze.
 *
 * The limit is the contract's ceiling exactly, so a file over it is refused
 * before its bytes are buffered — but body-parser's own refusal is a bare 413
 * with no machine code, and a screen that translates codes cannot translate
 * that. The error handler below restates it as the refusal the contract names.
 */
export const attachmentRawBody = [
  express.raw({ type: '*/*', limit: `${MAX_ATTACHMENT_MB}mb` }),
  // Four arguments on purpose: Express only treats an arity-4 function as an
  // error handler. `next` is unused and required.
  // eslint-disable-next-line no-unused-vars
  (err, req, res, next) => {
    if (err?.type !== 'entity.too.large') return next(err);
    return res.status(413).json({
      success: false,
      message: req.t('whatsapp.error.attachmentTooLarge', { max: MAX_ATTACHMENT_MB }),
      code: 'attachment_too_large'
    });
  }
];

export default WaAttachmentService;
