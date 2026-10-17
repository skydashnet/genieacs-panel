import DeviceService from './deviceService.js';
import { toCsvWith } from '../utils/csv.js';

/**
 * A planilha do inventário: o recorte da lista de equipamentos, num arquivo.
 *
 * As colunas são o que se identifica e o que se mede. O que é SEGREDO fica de
 * fora, e não por esquecimento: senha do Wi-Fi, do portal e do PPPoE nunca
 * saem daqui. O PPPoE sai só como login, que é o que liga a ONT ao contrato.
 */
export const DEVICE_EXPORT_COLUMNS = Object.freeze([
  { header: 'Série', field: 'serial' },
  { header: 'Fabricante', field: 'manufacturer' },
  { header: 'Modelo', field: 'model' },
  { header: 'Firmware', field: 'firmware' },
  { header: 'Estado', field: 'state' },
  { header: 'Último contato', field: 'lastInform' },
  { header: 'Cadastrada em', field: 'registered' },
  { header: 'PPPoE', field: 'pppoe' },
  { header: 'RX (dBm)', field: 'rxPower' },
  { header: 'Temperatura (°C)', field: 'temperature' },
  { header: 'Clientes no Wi-Fi', field: 'wifiClients' },
  { header: 'ID do cliente', field: 'customerId' },
  { header: 'ID no GenieACS', field: 'deviceId' }
]);

const valor = (v) => (v === null || v === undefined || v === '' ? '' : v);

/**
 * Uma medida como o Excel em português a lê: vírgula decimal. A planilha já é
 * a do Excel em português (BOM, `;`), e `-19.8` ali vira texto ou data.
 */
function medida(v) {
  if (v === null || v === undefined || v === '') return '';
  const numero = Number(v);
  return Number.isFinite(numero) ? String(numero).replace('.', ',') : v;
}

/** Uma linha da planilha a partir de um aparelho da lista. */
export function exportRow(device, now = Date.now()) {
  return {
    serial: valor(device.SerialNumber),
    manufacturer: valor(device.manufacturer),
    model: valor(device.productclass),
    firmware: valor(device.softwareId),
    state: DeviceService.isDeviceOnline(device, now) ? 'online' : 'offline',
    lastInform: valor(device._lastInform),
    registered: valor(device._registered),
    pppoe: valor(device.pppoe),
    rxPower: medida(device.rxpower),
    temperature: medida(device.temperature),
    wifiClients: valor(device.activedevices),
    customerId: valor(device.customerId),
    deviceId: valor(device._id)
  };
}

export async function exportDevicesCsv(query = {}) {
  const { devices, filters } = await DeviceService.getDevicesForExport(query);
  const now = Date.now();
  return {
    csv: toCsvWith(DEVICE_EXPORT_COLUMNS, devices.map((device) => exportRow(device, now))),
    count: devices.length,
    filters
  };
}
