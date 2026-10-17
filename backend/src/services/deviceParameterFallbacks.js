/**
 * Where the panel looks for a subscriber login and an optical RX reading when
 * the operator's VirtualParameters do not answer.
 *
 * Both figures are read through VirtualParameters (`vpPppoeUsername`,
 * `vpRxPower`), which are scripts an operator installs into GenieACS by hand.
 * An install that never received them — or received them under other names —
 * answers with nothing at all, and the consequences run well past two empty
 * columns: with no login on file no customer account is generated, and with no
 * account there is nothing for an SGP contract to match, so the Subscriber,
 * Customer ID and SGP columns all go blank together while the ONT has been
 * reporting its login and its RX power in its own data model the whole time.
 *
 * These candidates are consulted only after the configured VirtualParameter
 * came back empty, so an install whose scripts do answer reads exactly as it
 * did before.
 */

/** Beyond this many WAN objects a fallback is guesswork, not a lookup. */
const WAN_SCAN_LIMIT = 8;

/**
 * The concrete paths the device list asks GenieACS to project. GenieACS only
 * returns what a projection names, so the common indices have to be spelled
 * out; the resolver below then walks whatever came back, which is how an ONT
 * that numbers its WAN objects differently is still read on the detail page,
 * where the whole `WANDevice` subtree is projected.
 */
export const PPPOE_FALLBACK_PATHS = Object.freeze([
  ...[1, 2].flatMap((wan) =>
    [1, 2].flatMap((connection) =>
      [1, 2, 3].map((ppp) =>
        `InternetGatewayDevice.WANDevice.${wan}.WANConnectionDevice.${connection}`
        + `.WANPPPConnection.${ppp}.Username`
      )
    )
  ),
  // TR-181 data model, used by the ONTs that report `Device.` rather than
  // `InternetGatewayDevice.`
  'Device.PPP.Interface.1.Username',
  'Device.PPP.Interface.2.Username'
]);

/**
 * Optical RX power as the ONT vendors expose it. GPON diagnostics never made
 * it into TR-098, so every vendor put the reading under its own extension
 * object; TR-181 finally standardized it as
 * `Device.Optical.Interface.{i}.OpticalSignalLevel`.
 *
 * This list is a fast path, not the strategy. Naming an object here means a
 * projection can ask for it by name and a single request answers; the scan
 * below is what actually makes the reading findable, because no list of
 * vendor object names is ever complete. A path here that no ONT in the fleet
 * has costs nothing but its own length in the query string.
 */
export const RX_POWER_FALLBACK_PATHS = Object.freeze([
  // Nokia / Alcatel-Lucent (ALCL) G-series. The G-0425G / G-1425G keep their
  // optics in an object of their own at the root, not under WANDevice.
  'InternetGatewayDevice.X_ALU_OntOpticalParam.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_ALU-COM_GponInterfaceConfig.RXPower',
  // Huawei HG/EG series
  'InternetGatewayDevice.WANDevice.1.X_HW_GponInterfaceConfig.RXPower',
  // ZTE F-series
  'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower',
  // FiberHome
  'InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.RXPower',
  // China Telecom / China Unicom / China Mobile profiles, shipped by several
  // ODM firmwares sold under other brands
  'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_CU_GponInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.RXPower',
  // The misspelling is the firmware's, not a typo here: several ONU builds
  // ship the object as "InterafceConfig" and GenieACS stores what it is told.
  'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
  // TR-181, in units of 0.1 dBm
  'Device.Optical.Interface.1.OpticalSignalLevel'
]);

/**
 * The standard home of a CPE's temperature: TR-098 and TR-181 both define
 * `DeviceInfo.TemperatureStatus.TemperatureSensor.{i}.Value`, in °C. Nokia's
 * G-series publishes it there rather than beside the optics, which is why a
 * scan of the WAN tree alone read N/D on those ONTs. Named here so the list
 * can project it; `-274` is the TR-098 "no reading" value and is rejected.
 */
export const TEMPERATURE_FALLBACK_PATHS = Object.freeze([
  'InternetGatewayDevice.DeviceInfo.TemperatureStatus.TemperatureSensor.1.Value',
  'InternetGatewayDevice.DeviceInfo.TemperatureStatus.TemperatureSensor.2.Value',
  'Device.DeviceInfo.TemperatureStatus.TemperatureSensor.1.Value',
  // Nokia G-series: the transceiver's own reading, beside its RX power. The
  // TemperatureStatus above reads -274 ("no reading") on the G-0425G.
  'InternetGatewayDevice.X_ALU_OntOpticalParam.Temperature'
]);

/**
 * Vendor optics objects that sit at the root of the TR-098 tree, outside
 * `WANDevice`. Named so the detail page and the fleet probe can project them
 * whole — GenieACS only returns what a projection names, and a scan can only
 * find what came back.
 */
export const VENDOR_OPTICAL_OBJECTS = Object.freeze([
  'InternetGatewayDevice.X_ALU_OntOpticalParam'
]);

/**
 * A root-level vendor object that holds optics: `X_<vendor>_…Optic…`, or one
 * named for the PON itself (`X_<vendor>_GponInfo`). Anchored after the vendor
 * prefix so `…ResponseTime` is not read as a PON.
 */
const VENDOR_OPTICAL_ROOT = /^X_[A-Za-z0-9-]+_(?:.*optic|[gex]?pon)/i;

/**
 * A GPON ONT that is lit reads somewhere between roughly -30 dBm (the receiver
 * floor) and -8 dBm (too hot). The window is deliberately wider than that: it
 * is here to reject a reading in the wrong unit, not to judge the link.
 */
const RX_POWER_MIN_DBM = -40;
const RX_POWER_MAX_DBM = -0.01;

/**
 * The same reading is published as dBm, as tenths and as hundredths depending
 * on the firmware, and nothing in the value says which. The scale is therefore
 * inferred: the first one that lands inside the physically possible window is
 * the one the firmware meant. It is unambiguous in practice because the
 * alternatives are an order of magnitude apart — -2500 is -25 dBm at a
 * hundredth and an impossible -250 dBm at a tenth.
 */
const RX_POWER_SCALES = Object.freeze([1, 10, 100]);

/**
 * Reads a number out of whatever the ONT reported — a number, a numeric
 * string, or a string carrying its unit, as in "-21.53 dBm".
 */
function parseReading(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const numeric = Number.parseFloat(match[0].replace(',', '.'));
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Normalizes a vendor RX reading to dBm, or returns null when no scale makes
 * it a possible optical power. Exactly zero is one of those: it is what an
 * ONT with no reading to give publishes, and shown as 0 dBm it would read as
 * the strongest signal in the fleet.
 */
export function normalizeRxPowerReading(value) {
  const numeric = parseReading(value);
  if (numeric === null || numeric === 0) return null;

  for (const scale of RX_POWER_SCALES) {
    const scaled = numeric / scale;
    if (scaled >= RX_POWER_MIN_DBM && scaled <= RX_POWER_MAX_DBM) {
      return Math.round(scaled * 100) / 100;
    }
  }
  return null;
}

/**
 * Names a vendor might have given the reading. Anchored on purpose: an ONT
 * that also publishes `RXPowerThreshold` or `RXPowerAlarm` must not have a
 * threshold read back to a technician as the signal on the fibre.
 */
const RX_POWER_NAMES =
  /^(?:rx_?power|rx_?optical_?power|rx_?optical_?level|rx_?level|optical_?rx_?power|optical_?signal_?level)$/i;

/**
 * How much of a device document the scan is allowed to walk. A GenieACS
 * document is operator data of unbounded shape, and a lookup that reads a
 * column has no business touching every node of it.
 */
const SCAN_NODE_BUDGET = 400;
const SCAN_MAX_DEPTH = 3;

/** The named (non-index, non-metadata) children of a GenieACS object node. */
function namedChildren(node) {
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).filter(
    ([key, value]) => !key.startsWith('_') && value && typeof value === 'object'
  );
}

/**
 * Collects every parameter under `node` whose own name says it is an RX
 * optical reading, as `{ path, node }`, walking no deeper and no wider than
 * the budget above.
 */
function collectRxCandidates(node, prefix, depth, budget, found) {
  if (depth > SCAN_MAX_DEPTH || budget.left <= 0) return;
  for (const [key, child] of namedChildren(node)) {
    if (budget.left-- <= 0) return;
    const path = `${prefix}.${key}`;
    if (RX_POWER_NAMES.test(key)) {
      found.push({ path, node: child });
      continue;
    }
    collectRxCandidates(child, path, depth + 1, budget, found);
  }
}

/**
 * Where an ONT keeps its optics: each `WANDevice`, each TR-181 optical
 * interface, and the vendor objects at the root of the TR-098 tree — where
 * Nokia's G-series puts `X_ALU_OntOpticalParam`, and where a scan of the WAN
 * tree alone read N/D on every one of them.
 */
function opticalScopes(item) {
  const scopes = [];
  for (const [key, node] of indexedChildren(item?.InternetGatewayDevice?.WANDevice)) {
    scopes.push({ node, prefix: `InternetGatewayDevice.WANDevice.${key}` });
  }
  for (const [key, node] of namedChildren(item?.InternetGatewayDevice)) {
    if (VENDOR_OPTICAL_ROOT.test(key)) scopes.push({ node, prefix: `InternetGatewayDevice.${key}` });
  }
  for (const [key, node] of indexedChildren(item?.Device?.Optical?.Interface)) {
    scopes.push({ node, prefix: `Device.Optical.Interface.${key}` });
  }
  return scopes;
}

/**
 * Finds an optical RX reading by what the parameter is called rather than by
 * where a particular vendor put it.
 *
 * The catalogue above can only list object names someone has already seen; a
 * fleet running anything else reads N/A for every row with the value sitting
 * right there in the document. Every vendor does agree on the leaf name,
 * though — it is `RXPower` or a spelling of it — so the name is what this
 * matches on, and the value still has to survive `normalizeRxPowerReading`
 * before it is believed.
 */
export function findRxPowerReading(item, readValue) {
  const candidates = [];
  const budget = { left: SCAN_NODE_BUDGET };

  for (const { node, prefix } of opticalScopes(item)) {
    collectRxCandidates(node, prefix, 1, budget, candidates);
  }

  for (const candidate of candidates) {
    const value = normalizeRxPowerReading(readValue(candidate.node));
    if (value !== null) return { value, path: candidate.path };
  }
  return null;
}

/**
 * Names a vendor gives the optics' temperature. Anchored for the same reason
 * as the RX names: `TemperatureThreshold` or `TemperatureAlarm` must not be
 * read back as the temperature of the transceiver.
 */
const TEMPERATURE_NAMES = /^(?:transceiver_?)?temperature$|^temp$|^optical_?temperature$/i;

/** A transceiver that is running reads somewhere in this window, in °C. */
const TEMPERATURE_MIN_C = -40;
const TEMPERATURE_MAX_C = 120;

/**
 * Normalizes a temperature reading to °C. SFF-8472 publishes it in units of
 * 1/256 °C, and several firmwares pass that through untouched — 11520 is
 * 45 °C — so the raw value is tried first and the 1/256 scale second.
 */
export function normalizeTemperatureReading(value) {
  const numeric = parseReading(value);
  // -274 is TR-098's "the sensor has no reading", below absolute zero on
  // purpose; read at the 1/256 scale it would pass as -1 °C.
  if (numeric === null || numeric === -274) return null;
  for (const scale of [1, 256]) {
    const scaled = numeric / scale;
    if (scaled >= TEMPERATURE_MIN_C && scaled <= TEMPERATURE_MAX_C && scaled !== 0) {
      return Math.round(scaled * 10) / 10;
    }
  }
  return null;
}

function collectNamed(node, prefix, depth, budget, found, names) {
  if (depth > SCAN_MAX_DEPTH || budget.left <= 0) return;
  for (const [key, child] of namedChildren(node)) {
    if (budget.left-- <= 0) return;
    const path = `${prefix}.${key}`;
    if (names.test(key)) {
      found.push({ path, node: child });
      continue;
    }
    collectNamed(child, path, depth + 1, budget, found, names);
  }
}

/**
 * The optics' temperature, found by what the parameter is called — the same
 * approach `findRxPowerReading` takes, for the same reason: every vendor puts
 * it under its own object, and a fleet running anything the catalogue does
 * not name reads N/D with the value sitting in the document.
 */
export function findTemperatureReading(item, readValue) {
  const candidates = [];
  const budget = { left: SCAN_NODE_BUDGET };
  for (const { node, prefix } of opticalScopes(item)) {
    collectNamed(node, prefix, 1, budget, candidates, TEMPERATURE_NAMES);
  }
  for (const candidate of candidates) {
    const value = normalizeTemperatureReading(readValue(candidate.node));
    if (value !== null) return { value, path: candidate.path };
  }
  return null;
}

/**
 * Every leaf the scans would read an RX power or a temperature from, with
 * whatever GenieACS holds there. A leaf with no `_value` is one GenieACS knows
 * the name of and never read — the list of names to ask the ONT for.
 */
export function opticalReadingLeaves(item) {
  const found = [];
  for (const { node, prefix } of opticalScopes(item)) {
    collectRxCandidates(node, prefix, 1, { left: SCAN_NODE_BUDGET }, found);
    collectNamed(node, prefix, 1, { left: SCAN_NODE_BUDGET }, found, TEMPERATURE_NAMES);
  }
  return found;
}

/**
 * A WAN connection parameter found by name, in the connection itself or in
 * the `WANConnectionDevice` above it, where some vendors keep the VLAN.
 * Returns the full path, or null.
 */
export function findWanParameterByName(item, connectionPath, names) {
  const parts = String(connectionPath).split('.');
  const scopes = [connectionPath, parts.slice(0, -2).join('.')];
  for (const scope of scopes) {
    let node = item;
    for (const part of scope.split('.')) node = node?.[part];
    const found = [];
    collectNamed(node, scope, 1, { left: SCAN_NODE_BUDGET }, found, names);
    // One level only: a VLAN two objects down belongs to something else.
    const direct = found.filter((entry) => entry.path.split('.').length <= scope.split('.').length + 2);
    if (direct.length > 0) return direct[0].path;
  }
  return null;
}

export const WAN_VLAN_NAMES = /^(?:x_[a-z0-9-]+_)?(?:vlan_?id|vlanidmark|vlan)$/i;
export const WAN_SERVICE_NAMES = /^(?:x_[a-z0-9-]+_)?service_?list$/i;

/** How many rows a parameter listing hands back at most. */
const PARAMETER_LIST_LIMIT = 500;

/** Values that are credentials, and so are never shown back. */
const SECRET_NAMES = /password|passwd|passphrase|secret|presharedkey|keypassphrase|wepkey/i;

/**
 * Every parameter in a GenieACS device document, one row per leaf, filtered
 * by `search` (matched anywhere in the path, case-insensitive).
 *
 * An object GenieACS knows exists but never read comes back as a row with no
 * value, marked `read: false` — that is the difference between "the ONT has
 * no such parameter" and "nobody asked it yet", which is what the operator is
 * trying to tell apart.
 */
export function listDocumentParameters(item, search = '') {
  const needle = String(search ?? '').trim().toLowerCase();
  const rows = [];
  let total = 0;
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    const isLeaf = '_value' in node;
    if (path && (isLeaf || (node._object === false && !isLeaf))) {
      if (!needle || path.toLowerCase().includes(needle)) {
        total += 1;
        if (rows.length < PARAMETER_LIST_LIMIT) {
          const secret = SECRET_NAMES.test(path.split('.').at(-1));
          rows.push({
            path,
            value: !isLeaf ? null : secret ? '******' : node._value,
            type: node._type ?? null,
            writable: node._writable ?? null,
            timestamp: node._timestamp ?? null,
            read: isLeaf
          });
        }
      }
      if (isLeaf) return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('_')) continue;
      walk(child, path ? `${path}.${key}` : key);
    }
  };
  walk(item, '');
  return { rows, total, limit: PARAMETER_LIST_LIMIT };
}

/** The numeric children of a GenieACS object node, in index order. */
function indexedChildren(node) {
  if (!node || typeof node !== 'object') return [];
  return Object.keys(node)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b))
    .slice(0, WAN_SCAN_LIMIT)
    .map((key) => [key, node[key]]);
}

/** A login GenieACS stores as an empty string is a gap, not a subscriber. */
function readLogin(node, readValue) {
  const value = readValue(node);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Walks the WAN tree for a PPPoE login, whatever indices the ONT used, and
 * reports the path it was found at so the detail page can say where a value
 * that no VirtualParameter produced actually came from.
 *
 * The caller supplies the reader so that GenieACS's value nodes are unwrapped
 * the one way the rest of the panel unwraps them.
 */
export function findPppoeUsername(item, readValue) {
  for (const [wanKey, wanDevice] of indexedChildren(item?.InternetGatewayDevice?.WANDevice)) {
    for (const [connKey, connectionDevice] of indexedChildren(wanDevice?.WANConnectionDevice)) {
      for (const [pppKey, connection] of indexedChildren(connectionDevice?.WANPPPConnection)) {
        const value = readLogin(connection?.Username, readValue);
        if (value) {
          return {
            value,
            path: `InternetGatewayDevice.WANDevice.${wanKey}.WANConnectionDevice.${connKey}`
              + `.WANPPPConnection.${pppKey}.Username`
          };
        }
      }
    }
  }

  for (const [key, iface] of indexedChildren(item?.Device?.PPP?.Interface)) {
    const value = readLogin(iface?.Username, readValue);
    if (value) return { value, path: `Device.PPP.Interface.${key}.Username` };
  }

  return null;
}

/**
 * Every PPPoE login leaf the document names, with whatever GenieACS holds
 * there — a value node, a node it only knows the name of, or nothing.
 *
 * A GenieACS stores only what it was asked to fetch. A ZTE F-series reports
 * its WAN connections and their addresses in the Inform, so the objects are in
 * the document from day one; the `Username` beside them is not, until someone
 * asks for it by name. This is the list of names to ask for.
 */
export function pppoeLoginLeaves(item) {
  const leaves = [];
  for (const [wanKey, wanDevice] of indexedChildren(item?.InternetGatewayDevice?.WANDevice)) {
    for (const [connKey, connectionDevice] of indexedChildren(wanDevice?.WANConnectionDevice)) {
      for (const [pppKey, connection] of indexedChildren(connectionDevice?.WANPPPConnection)) {
        leaves.push({
          path: `InternetGatewayDevice.WANDevice.${wanKey}.WANConnectionDevice.${connKey}`
            + `.WANPPPConnection.${pppKey}.Username`,
          node: connection?.Username
        });
      }
    }
  }
  for (const [key, iface] of indexedChildren(item?.Device?.PPP?.Interface)) {
    leaves.push({ path: `Device.PPP.Interface.${key}.Username`, node: iface?.Username });
  }
  return leaves;
}

export default {
  PPPOE_FALLBACK_PATHS,
  RX_POWER_FALLBACK_PATHS,
  TEMPERATURE_FALLBACK_PATHS,
  findPppoeUsername,
  findRxPowerReading,
  findTemperatureReading,
  findWanParameterByName,
  listDocumentParameters,
  normalizeRxPowerReading,
  normalizeTemperatureReading,
  opticalReadingLeaves,
  pppoeLoginLeaves,
  VENDOR_OPTICAL_OBJECTS
};
