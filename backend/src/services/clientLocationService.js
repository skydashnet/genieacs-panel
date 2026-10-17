import { tdb } from '../config/database.js';
import SgpClient from '../models/SgpClient.js';
import SgpLink from '../models/SgpLink.js';
import SgpService from './sgpService.js';
import { geocodeAddress } from './addressLookupService.js';

/**
 * Onde fica a casa de um cliente, para o "Colocar no mapa" abrir já nela.
 *
 * O endereço vem do SGP, pela ordem do que custa menos:
 * 1. `sgp_contacts` pelo login PPPoE — o que a sincronização de contatos já
 *    guardou, sem consulta nenhuma;
 * 2. pelo contrato vinculado ao equipamento (`sgp_links`);
 * 3. o SGP ao vivo, pelo login, quando a integração está pronta.
 *
 * Um contrato sem endereço próprio está no endereço do cliente dono dele
 * (`sgp_clients`), como a sincronização já faz.
 *
 * Com coordenadas no SGP, o ponto é esse. Sem elas, as partes do endereço vão
 * ao Nominatim (`geocodeAddress`: rua e número, depois só a cidade). Falhar
 * ali não é erro: volta o endereço sem ponto, e a tela deixa buscar.
 */
const parseJson = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function coordinates(parts) {
  const lat = Number(parts?.latitude);
  const lng = Number(parts?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function lineOf(parts) {
  if (!parts) return null;
  if (parts.line) return text(parts.line) || null;
  const street = [parts.street, parts.number].filter(Boolean).join(', ');
  const place = [parts.district, [parts.city, parts.state].filter(Boolean).join('/')].filter(Boolean).join(' - ');
  return [street, parts.complement, place, parts.zip].filter(Boolean).join(' · ') || null;
}

async function contactByLogin(login) {
  if (!login) return null;
  return (await tdb('sgp_contacts').whereRaw('LOWER(TRIM(login)) = ?', [login]).orderBy('id', 'desc').first()) || null;
}

async function contactByDevice(deviceId) {
  if (!deviceId) return null;
  const link = await SgpLink.getByDeviceId(deviceId);
  if (!link?.contract) return null;
  return (await tdb('sgp_contacts').where({ contract: link.contract }).first())
    || { contract: link.contract, client_name: link.client_name };
}

const hasOwnAddress = (parts) => Boolean(parts && (coordinates(parts) || parts.street || parts.city));

/** O endereço de um cliente do SGP: o que o operador corrigiu vale sobre o do SGP. */
function clientAddressOf(parsed) {
  const address = parsed?.overrides?.address && typeof parsed.overrides.address === 'object'
    ? parsed.overrides.address
    : parsed?.address;
  return address && typeof address === 'object' ? address : null;
}

/**
 * O endereço em partes de um contato, ou o do cliente dono dele. `clients`
 * (sgp_client_id → registro já lido) evita uma consulta por contato no lote.
 */
async function addressOfContact(contact, clients = null) {
  const own = parseJson(contact.address_parts);
  if (hasOwnAddress(own)) return { parts: own, line: text(contact.address) || lineOf(own) };
  if (contact.client_ref) {
    const parsed = clients
      ? clients.get(String(contact.client_ref)) ?? null
      : await SgpClient.getBySgpId(contact.client_ref).catch(() => null);
    const clientAddress = clientAddressOf(parsed);
    if (clientAddress) return { parts: clientAddress, line: text(contact.address) || lineOf(clientAddress) };
  }
  return { parts: own, line: text(contact.address) || lineOf(own) };
}

const BATCH = 500;

async function inBatches(values, query) {
  const rows = [];
  for (let i = 0; i < values.length; i += BATCH) rows.push(...await query(values.slice(i, i + BATCH)));
  return rows;
}

async function liveContract(login) {
  const config = await SgpService.getConfig().catch(() => null);
  if (!config || !SgpService.isReady(config)) return null;
  try {
    const { contracts } = await SgpService.lookupCustomer({ login });
    const contract = contracts[0] ? SgpService.publicContract(contracts[0]) : null;
    if (!contract) return null;
    return { contract: contract.contract, client_name: contract.name, address: contract.address, address_parts: contract.addressParts };
  } catch {
    return null;
  }
}

class ClientLocationService {
  static async locate({ pppoe, deviceId }) {
    const login = text(pppoe).toLowerCase();
    const contact = (await contactByLogin(login)) || (await contactByDevice(text(deviceId))) || (login ? await liveContract(login) : null);
    if (!contact) return { found: false };

    const { parts, line } = await addressOfContact(contact);
    const base = {
      found: true,
      contract: contact.contract ?? null,
      clientName: text(contact.client_name) || null,
      address: line || null
    };
    const point = coordinates(parts);
    if (point) return { ...base, ...point, precision: 'sgp' };
    if (!parts?.city) return base;
    try {
      const result = await geocodeAddress({
        addressLine: parts.street,
        addressNumber: parts.number,
        city: parts.city,
        state: parts.state,
        postalCode: parts.zip
      });
      return result.found ? { ...base, lat: result.data.lat, lng: result.data.lng, precision: result.data.precision } : base;
    } catch {
      return base;
    }
  }

  /**
   * "Colocar todos no mapa": onde fica cada um de uma lista de equipamentos
   * (`{ pppoe, deviceId }`), só com o que a sincronização do SGP já guardou —
   * sem SGP ao vivo e sem Nominatim, para a prévia sair na hora. As consultas
   * vão em lote, nunca uma por cliente.
   *
   * - `ready`: com coordenadas no SGP, prontos para colocar;
   * - `needsAddress`: com endereço (ao menos a cidade), mas sem coordenadas —
   *   a tela localiza esses um a um, no ritmo que o Nominatim permite;
   * - `noAddress`: sem como localizar — `reason: 'no_contract'` (nenhum
   *   contato do SGP para o login nem para o equipamento) ou `'no_address'`
   *   (o contrato não tem nem a cidade). Esses ficam para colocar um a um.
   */
  static async locateMany(devices) {
    const items = devices.map((device) => ({
      pppoe: text(device.pppoe),
      deviceId: text(device.deviceId) || null,
      login: text(device.pppoe).toLowerCase()
    }));

    const byLogin = new Map();
    const logins = [...new Set(items.map((item) => item.login).filter(Boolean))];
    const contactRows = await inBatches(logins, (chunk) => tdb('sgp_contacts')
      .whereRaw(`LOWER(TRIM(login)) IN (${chunk.map(() => '?').join(', ')})`, chunk)
      .orderBy('id', 'desc'));
    for (const row of contactRows) {
      const key = text(row.login).toLowerCase();
      // Mais de um contrato com o mesmo login: vale o mais novo, como no `locate`.
      if (!byLogin.has(key)) byLogin.set(key, row);
    }

    // Quem não casou pelo login: pelo contrato vinculado ao equipamento.
    const byDevice = new Map();
    const orphanDevices = [...new Set(items.filter((item) => !byLogin.has(item.login) && item.deviceId).map((item) => item.deviceId))];
    if (orphanDevices.length) {
      const links = await inBatches(orphanDevices, (chunk) => tdb('sgp_links').whereIn('device_id', chunk));
      const contracts = [...new Set(links.map((link) => link.contract).filter(Boolean))];
      const byContract = new Map();
      for (const row of await inBatches(contracts, (chunk) => tdb('sgp_contacts').whereIn('contract', chunk))) {
        if (!byContract.has(row.contract)) byContract.set(row.contract, row);
      }
      for (const link of links) {
        if (!link.contract) continue;
        byDevice.set(link.device_id, byContract.get(link.contract) || { contract: link.contract, client_name: link.client_name });
      }
    }

    // Os clientes donos dos contratos sem endereço próprio, lidos de uma vez.
    const contactOf = (item) => byLogin.get(item.login) || (item.deviceId ? byDevice.get(item.deviceId) : null) || null;
    const refs = [...new Set(items.map(contactOf)
      .filter((contact) => contact?.client_ref && !hasOwnAddress(parseJson(contact.address_parts)))
      .map((contact) => String(contact.client_ref)))];
    const clients = new Map();
    for (const row of await inBatches(refs, (chunk) => tdb('sgp_clients').whereIn('sgp_client_id', chunk))) {
      clients.set(String(row.sgp_client_id), SgpClient.parse(row));
    }

    const result = { ready: [], needsAddress: [], noAddress: [] };
    for (const item of items) {
      const contact = contactOf(item);
      const entry = { pppoe: item.pppoe, deviceId: item.deviceId };
      if (!contact) { result.noAddress.push({ ...entry, reason: 'no_contract' }); continue; }
      const { parts, line } = await addressOfContact(contact, clients);
      const located = {
        ...entry,
        contract: contact.contract ?? null,
        clientName: text(contact.client_name) || null,
        address: line || null
      };
      const point = coordinates(parts);
      if (point) result.ready.push({ ...located, ...point });
      else if (parts?.city) result.needsAddress.push(located);
      else result.noAddress.push({ ...located, reason: 'no_address' });
    }
    return result;
  }
}

export default ClientLocationService;
