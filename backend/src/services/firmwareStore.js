import express from 'express';
import { TranslatableError } from '../i18n/index.js';
import DeviceService from './deviceService.js';
import { connectorFor } from './genieacs/connector.js';
import { UNASSIGNED_SCOPE_TAG, UPLOAD_TIMEOUT_MS, filePath } from './genieacs/direct.js';
import { AGENT_FILE_UPLOAD_VERSION, agentSupportsFileUpload } from './genieacs/agent.js';
import {
  FIRMWARE_FILE_TYPE, FIRMWARE_NAME_MAX_LENGTH, FIRMWARE_OWNER_SEPARATOR,
  firmwareOwner, isFirmwareFile, publicFile, validFirmwareName
} from './firmwareFiles.js';

/**
 * Enviar e apagar firmware no GenieACS pelo painel.
 *
 * Até aqui o provedor subia o arquivo pela tela do próprio GenieACS. Num ACS
 * compartilhado isso não serve: a coleção `files` é de todos, e o dono do
 * arquivo vai no nome (`<tag>--<nome>`, ver `firmwareFiles.js`) — quem sobe
 * pela tela do GenieACS sem o prefixo cria um arquivo que nenhum provedor vê.
 * Pelo painel, quem põe o prefixo é o SERVIDOR, com a tag do provedor em
 * escopo; o nome que a tela manda é só o do arquivo.
 *
 * O corpo é o arquivo cru (`application/octet-stream`), como o anexo do
 * WhatsApp: sem dependência de multipart para uma tela. O nome e os metadados
 * vêm em cabeçalhos, cada um com `encodeURIComponent`.
 *
 * A plataforma tem três gestos a mais, sobre os arquivos SEM dono de um ACS
 * compartilhado (os enviados antes desta regra): listar, reenviar como de um
 * provedor (o admin escolhe o arquivo no computador; o painel não baixa do
 * GenieACS) e apagar o antigo.
 */

/** O teto do arquivo, em MB. `FIRMWARE_MAX_MB` no ambiente; 64 por padrão. */
export const FIRMWARE_MAX_MB = (() => {
  const valor = Number.parseFloat(process.env.FIRMWARE_MAX_MB ?? '');
  return Number.isFinite(valor) && valor > 0 ? valor : 64;
})();
const FIRMWARE_MAX_BYTES = Math.floor(FIRMWARE_MAX_MB * 1024 * 1024);

/** Os caminhos que recebem o arquivo cru — montados em `app.js` antes do parser JSON. */
export const FIRMWARE_UPLOAD_PATH = '/api/devices/firmware/files';
export const FIRMWARE_REASSIGN_PATH = '/api/platform/tenants/:id/genieacs/firmware/reassign';

/**
 * O parser do corpo cru, com o 413 dito na língua da tela.
 *
 * O teto é o do contrato, então um arquivo acima dele é recusado antes de os
 * bytes serem guardados; a recusa do body-parser é um 413 sem código, e a tela
 * traduz códigos — daí o tratador logo abaixo (o mesmo do anexo do WhatsApp).
 */
export const firmwareRawBody = [
  express.raw({ type: () => true, limit: FIRMWARE_MAX_BYTES }),
  // Quatro argumentos de propósito: o Express só trata como tratador de erro
  // uma função de aridade 4. `next` é obrigatório e fica sem uso.
  (err, req, res, next) => {
    if (err?.type !== 'entity.too.large') return next(err);
    return res.status(413).json({
      success: false,
      message: req.t('device.firmwareTooLarge', { max: FIRMWARE_MAX_MB }),
      code: 'firmware_too_large'
    });
  }
];

const erro = (key, status, code, vars = null) => new TranslatableError(key, vars, { status, code });
const nomeInvalido = () => erro('device.firmwareNameInvalid', 400, 'firmware_name_invalid');
const naoEncontrado = () => erro('device.firmwareNotFound', 404, 'firmware_not_found');
const semTag = () => erro('device.firmwareScopeUnassigned', 409, 'firmware_scope_unassigned');
const metadadoInvalido = () => erro('device.firmwareMetadataInvalid', 400, 'firmware_metadata_invalid');

/** Um cabeçalho com `encodeURIComponent`, decodificado; `null` se torto. */
function cabecalho(req, nome) {
  const cru = req.get(nome);
  if (cru === undefined) return '';
  try {
    return decodeURIComponent(String(cru)).trim();
  } catch {
    return null;
  }
}

/**
 * Texto que vai num cabeçalho HTTP até a NBI: ASCII visível e espaço. Um
 * cabeçalho não carrega acento sem codificação, e o GenieACS o guardaria
 * como veio.
 */
const ASCII_VISIVEL = /^[\x20-\x7E]*$/;
function metadado(valor, max) {
  if (valor === null || valor.length > max || !ASCII_VISIVEL.test(valor)) throw metadadoInvalido();
  return valor;
}

/**
 * `{ name, oui, productClass, version }` dos cabeçalhos do pedido.
 * `X-File-Name` é o nome do arquivo, sem prefixo de dono; o modelo
 * (`X-Fw-Product-Class`) é obrigatório — firmware sem modelo não serve para
 * ONT nenhuma no painel (`firmwareCatalog`).
 */
export function readUploadHeaders(req) {
  const name = cabecalho(req, 'X-File-Name');
  if (!name || !validFirmwareName(name)) throw nomeInvalido();
  const productClass = metadado(cabecalho(req, 'X-Fw-Product-Class'), 64);
  if (!productClass) throw metadadoInvalido();
  return {
    name,
    oui: metadado(cabecalho(req, 'X-Fw-Oui'), 16),
    productClass,
    version: metadado(cabecalho(req, 'X-Fw-Version'), 128)
  };
}

/** O nome original de `X-File-Name` (reenvio da plataforma), sem metadados. */
export function readOriginalName(req) {
  const name = cabecalho(req, 'X-File-Name');
  if (!name || !validFirmwareName(name)) throw nomeInvalido();
  return name;
}

/** O corpo do pedido, se é um arquivo de verdade. */
function corpo(body) {
  if (!Buffer.isBuffer(body) || body.length === 0) throw erro('device.firmwareEmpty', 400, 'firmware_empty');
  return body;
}

/** O documento do arquivo `nome` na coleção `files`, ou `null`. */
async function buscar(connector, nome, { unscoped = false } = {}) {
  const response = await connector.request(connector.collectionPath('files'), {
    unscoped,
    query: { query: JSON.stringify({ _id: nome }), limit: 1 }
  });
  if (!response.ok) throw await DeviceService.genieAcsError('GenieACS files API', response);
  const text = await response.text();
  const rows = text ? JSON.parse(text) : [];
  return Array.isArray(rows) ? rows.find((row) => row?._id === nome) ?? null : null;
}

/** `PUT files/<nome>` com os quatro metadados que a NBI guarda. */
async function gravar(connector, nome, bytes, meta, { unscoped = false } = {}) {
  if (connector.mode === 'agent' && !(await agentSupportsFileUpload())) {
    throw erro('device.firmwareAgentOutdated', 409, 'acs_agent_outdated', { version: AGENT_FILE_UPLOAD_VERSION });
  }
  const headers = { fileType: FIRMWARE_FILE_TYPE };
  if (meta.oui) headers.oui = meta.oui;
  if (meta.productClass) headers.productClass = meta.productClass;
  if (meta.version) headers.version = meta.version;
  const response = await connector.request(filePath(nome), {
    method: 'PUT',
    rawBody: bytes,
    headers,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    unscoped
  });
  if (!response.ok) throw await DeviceService.genieAcsError('GenieACS files API', response);
  await response.text().catch(() => '');
  return publicFile({
    _id: nome,
    length: bytes.length,
    uploadDate: new Date().toISOString(),
    metadata: { fileType: FIRMWARE_FILE_TYPE, ...meta }
  });
}

/** `DELETE files/<nome>`. */
async function apagar(connector, nome, { unscoped = false } = {}) {
  const response = await connector.request(filePath(nome), { method: 'DELETE', unscoped });
  if (response.status === 404) throw naoEncontrado();
  if (!response.ok) throw await DeviceService.genieAcsError('GenieACS files API', response);
  await response.text().catch(() => '');
}

/** O nome com o prefixo do dono; recusa o que não cabe no teto. */
function comDono(tag, nome) {
  const final = `${tag}${FIRMWARE_OWNER_SEPARATOR}${nome}`;
  if (final.length > FIRMWARE_NAME_MAX_LENGTH) throw nomeInvalido();
  return final;
}

class FirmwareStore {
  /**
   * O provedor envia um firmware. Num ACS compartilhado o nome gravado é
   * `<tag>--<nome>`, e um nome que já traga prefixo de dono é recusado (seria
   * o provedor escolhendo de quem é o arquivo). Sem tag ainda num ACS
   * compartilhado, nada se grava: o arquivo não seria de ninguém.
   */
  static async upload({ name, oui, productClass, version }, body) {
    const bytes = corpo(body);
    const connector = await connectorFor();
    const tag = (await connector.scopeTag?.()) ?? null;
    if (tag === UNASSIGNED_SCOPE_TAG) throw semTag();
    if (!validFirmwareName(name)) throw nomeInvalido();
    let nome = name;
    if (tag) {
      if (firmwareOwner({ _id: name }) !== null) throw nomeInvalido();
      nome = comDono(tag, name);
    }
    if (await buscar(connector, nome)) throw erro('device.firmwareExists', 409, 'firmware_exists');
    return gravar(connector, nome, bytes, { oui, productClass, version });
  }

  /**
   * O provedor apaga um firmware dele, pelo nome completo (o `id` da lista).
   * O de outro provedor, o sem dono e o que não é firmware respondem "não
   * encontrado" — nunca "é de outro".
   */
  static async remove(name) {
    if (!validFirmwareName(name)) throw naoEncontrado();
    const connector = await connectorFor();
    const tag = (await connector.scopeTag?.()) ?? null;
    if (tag === UNASSIGNED_SCOPE_TAG) throw naoEncontrado();
    if (tag && firmwareOwner({ _id: name }) !== tag) throw naoEncontrado();
    const atual = await buscar(connector, name);
    if (!atual || !isFirmwareFile(atual)) throw naoEncontrado();
    await apagar(connector, name);
    return publicFile(atual);
  }

  /**
   * Plataforma, no escopo do provedor alvo: os firmwares SEM dono do ACS dele.
   * `{ tag, shared, files }` — ACS só do provedor: `shared: false` e nada
   * (lá o arquivo sem prefixo é dele, não "sem dono").
   */
  static async listUnowned() {
    const connector = await connectorFor();
    const escopo = (await connector.scopeTag?.()) ?? null;
    if (!escopo) return { tag: null, shared: false, files: [] };
    const todos = await DeviceService.fetchFirmwareFilePages(
      { 'metadata.fileType': FIRMWARE_FILE_TYPE },
      { unscoped: true }
    );
    const files = todos
      .filter((file) => file && file._id !== undefined && file._id !== null && firmwareOwner(file) === null)
      .map(publicFile)
      .sort((a, b) => a.id.localeCompare(b.id));
    return { tag: escopo === UNASSIGNED_SCOPE_TAG ? null : escopo, shared: true, files };
  }

  /** O arquivo sem dono `name`, ou "não encontrado". */
  static async findUnowned(connector, name) {
    if (!validFirmwareName(name) || firmwareOwner({ _id: name }) !== null) throw naoEncontrado();
    const original = await buscar(connector, name, { unscoped: true });
    if (!original || !isFirmwareFile(original)) throw naoEncontrado();
    return original;
  }

  /**
   * Plataforma: grava `<tag>--<nome>` com os bytes que o admin escolheu no
   * computador e os metadados do arquivo sem dono `name`. O tamanho tem que
   * bater com o do antigo — é a conferência de que o arquivo escolhido é o
   * mesmo. O antigo NÃO é apagado aqui: isso é o gesto seguinte, à parte.
   */
  static async reassign(name, body) {
    const bytes = corpo(body);
    const connector = await connectorFor();
    const tag = (await connector.scopeTag?.()) ?? null;
    if (!tag) throw erro('device.firmwareNotShared', 409, 'firmware_acs_not_shared');
    if (tag === UNASSIGNED_SCOPE_TAG) throw semTag();
    const original = await this.findUnowned(connector, name);
    if (Number(original.length) !== bytes.length) {
      throw erro('device.firmwareSizeMismatch', 400, 'firmware_size_mismatch');
    }
    const nome = comDono(tag, name);
    if (await buscar(connector, nome, { unscoped: true })) throw erro('device.firmwareExists', 409, 'firmware_exists');
    const meta = original.metadata ?? {};
    const texto = (valor, max) => {
      const t = String(valor ?? '').trim();
      return t && t.length <= max && ASCII_VISIVEL.test(t) ? t : '';
    };
    const file = await gravar(connector, nome, bytes, {
      oui: texto(meta.oui, 16),
      productClass: texto(meta.productClass, 64),
      version: texto(meta.version, 128)
    }, { unscoped: true });
    return { tag, file };
  }

  /** Plataforma: apaga um arquivo SEM dono do ACS compartilhado do provedor. */
  static async removeUnowned(name) {
    const connector = await connectorFor();
    const tag = (await connector.scopeTag?.()) ?? null;
    if (!tag) throw naoEncontrado();
    const original = await this.findUnowned(connector, name);
    await apagar(connector, name, { unscoped: true });
    return publicFile(original);
  }
}

export default FirmwareStore;
