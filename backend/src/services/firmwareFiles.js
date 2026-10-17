/**
 * Quais firmwares do GenieACS servem para uma ONT.
 *
 * Os arquivos já moram no GenieACS: o provedor sobe pela tela dele, com o tipo
 * "1 Firmware Upgrade Image", e, se preencher, o fabricante (OUI), o modelo
 * (product class) e a versão. O painel só escolhe entre eles e manda a tarefa
 * `download`.
 *
 * A regra é conservadora de propósito, porque o erro aqui não tem volta: um
 * firmware de outro modelo pode deixar a ONT sem subir, e aí é visita técnica.
 * Serve o arquivo que diz o MESMO modelo da ONT e, se disser o fabricante,
 * o mesmo fabricante. Arquivo sem modelo não serve para ninguém — o painel não
 * adivinha —, e a tela conta quantos ficaram de fora para o operador saber que
 * existem e por que não aparecem.
 */

export const FIRMWARE_FILE_TYPE = '1 Firmware Upgrade Image';

/**
 * De quem é o arquivo, num GenieACS que vários provedores usam.
 *
 * A coleção `files` é uma só para o ACS inteiro, e a NBI do GenieACS só guarda
 * quatro campos de metadado (`fileType`, `oui`, `productClass`, `version`) —
 * não há campo livre onde anotar o dono. O dono vai então no NOME do arquivo:
 * `<tag do provedor>--<nome>` (ex.: `alfa--F670L_V2.bin`). A tag só tem letras,
 * dígitos e `_` (`DEVICE_SCOPE_TAG_PATTERN`), então o que vem antes do primeiro
 * `--` é a tag inteira, sem ambiguidade entre `alfa` e `alfa_2`.
 *
 * Arquivo sem prefixo num ACS compartilhado — os enviados antes desta regra,
 * ou por quem subiu sem prefixo pela tela do GenieACS — não é de provedor
 * nenhum: fica escondido de todos e só a plataforma, no próprio GenieACS, o
 * vê. Mostrá-lo a todos era justamente o vazamento; renomeá-lo com o prefixo
 * certo o devolve ao provedor dono.
 *
 * Com o ACS só do provedor (`scopeTag()` nulo) nada disto se aplica.
 */
export const FIRMWARE_OWNER_SEPARATOR = '--';

/** A tag dona do arquivo, pelo prefixo do nome; `null` quando não tem. */
export function firmwareOwner(file) {
  const nome = String(file?._id ?? file?.id ?? '');
  const corte = nome.indexOf(FIRMWARE_OWNER_SEPARATOR);
  if (corte <= 0) return null;
  const tag = nome.slice(0, corte);
  return /^[A-Za-z0-9_]{1,64}$/.test(tag) ? tag : null;
}

/**
 * Só os arquivos do provedor de `tag`. `tag` nulo (ACS só dele): todos.
 * A tag "sem dono" (`unassignedTag`) não é dona de nada, nem de um arquivo
 * que por acaso tenha o nome dela no prefixo.
 */
export function filesOwnedBy(files, tag, { unassignedTag = null } = {}) {
  const lista = Array.isArray(files) ? files : [];
  if (tag === null || tag === undefined || tag === '') return lista;
  if (unassignedTag && tag === unassignedTag) return [];
  return lista.filter((file) => firmwareOwner(file) === tag);
}

const igual = (a, b) => String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();
const vazio = (value) => String(value ?? '').trim() === '';

/**
 * O nome de um arquivo na coleção `files` — o que vira `files/<nome>` na NBI.
 *
 * Letras, dígitos, ponto, `_` e `-`, e nada mais: sem barra (seria outro
 * caminho na NBI), sem espaço nem acento (o nome vai no caminho E no `download`
 * que a ONT recebe, e firmware de ONT não lida bem com nenhum dos dois). Não
 * começa com ponto, o que já tira `.` e `..` — que, no caminho, a URL
 * resolveria para a raiz da NBI. O teto é folga para o prefixo do dono caber.
 */
export const FIRMWARE_NAME_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
export const FIRMWARE_NAME_MAX_LENGTH = 200;

/** O nome serve para gravar ou apagar na NBI? */
export function validFirmwareName(name) {
  const nome = typeof name === 'string' ? name : '';
  return nome.length > 0 && nome.length <= FIRMWARE_NAME_MAX_LENGTH && FIRMWARE_NAME_PATTERN.test(nome);
}

/** O arquivo é de firmware (o tipo que o painel usa)? */
export function isFirmwareFile(file) {
  return igual(file?.metadata?.fileType, FIRMWARE_FILE_TYPE);
}

/** O arquivo, no formato que a tela lê. */
export function publicFile(file) {
  const meta = file?.metadata ?? {};
  return {
    id: String(file._id),
    version: vazio(meta.version) ? null : String(meta.version).trim().slice(0, 128),
    oui: vazio(meta.oui) ? null : String(meta.oui).trim().slice(0, 16),
    productClass: vazio(meta.productClass) ? null : String(meta.productClass).trim().slice(0, 64),
    size: Number.isFinite(Number(file.length)) ? Number(file.length) : null,
    uploadedAt: file.uploadDate ? String(file.uploadDate) : null
  };
}

/**
 * Separa os firmwares que servem para esta ONT dos que não servem.
 *
 * @param {Array<object>} files os documentos da coleção `files` do GenieACS
 * @param {{ oui?: string|null, productClass?: string|null }} device
 * @returns {{ compatible: object[], otherModels: number }}
 */
export function compatibleFirmware(files, device) {
  const compatible = [];
  let otherModels = 0;
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || file._id === undefined || file._id === null) continue;
    const meta = file.metadata ?? {};
    if (!igual(meta.fileType, FIRMWARE_FILE_TYPE)) continue;
    const modeloConfere = !vazio(meta.productClass) && !vazio(device?.productClass)
      && igual(meta.productClass, device.productClass);
    const fabricanteConfere = vazio(meta.oui) || (!vazio(device?.oui) && igual(meta.oui, device.oui));
    if (modeloConfere && fabricanteConfere) compatible.push(publicFile(file));
    else otherModels += 1;
  }
  // O mais recente primeiro: é o que o operador quase sempre procura.
  compatible.sort((a, b) => String(b.uploadedAt ?? '').localeCompare(String(a.uploadedAt ?? '')));
  return { compatible, otherModels };
}

/**
 * Todos os firmwares do GenieACS que dizem para qual modelo servem.
 *
 * É a lista do lote, onde as ONTs marcadas podem ser de modelos diferentes: a
 * escolha é de um arquivo, e cada ONT é conferida contra ele na hora de mandar
 * (`compatibleFirmware`). Arquivo sem modelo fica de fora pelo mesmo motivo de
 * sempre — não serve para ninguém — e é contado.
 */
export function firmwareCatalog(files) {
  const catalog = [];
  let unclassified = 0;
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || file._id === undefined || file._id === null) continue;
    const meta = file.metadata ?? {};
    if (!igual(meta.fileType, FIRMWARE_FILE_TYPE)) continue;
    if (vazio(meta.productClass)) {
      unclassified += 1;
      continue;
    }
    catalog.push(publicFile(file));
  }
  catalog.sort((a, b) => String(b.uploadedAt ?? '').localeCompare(String(a.uploadedAt ?? '')));
  return { files: catalog, unclassified };
}

/** A versão que a ONT diz rodar, nos dois modelos de dados. */
export function currentFirmwareVersion(row) {
  const pick = (node) => {
    const value = node && typeof node === 'object' && '_value' in node ? node._value : node;
    return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  };
  return pick(row?.InternetGatewayDevice?.DeviceInfo?.SoftwareVersion)
    || pick(row?.Device?.DeviceInfo?.SoftwareVersion)
    || null;
}

/** Se o arquivo é a versão que a ONT já roda — reinstalar só a derrubaria à toa. */
export function isInstalledVersion(file, current) {
  return !vazio(file?.version) && !vazio(current) && igual(file.version, current);
}
