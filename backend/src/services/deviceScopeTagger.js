import AppState from '../models/AppState.js';
import Setting from '../models/Setting.js';
import DeviceService from './deviceService.js';
import DirectConnector, { DEVICE_SCOPE_KEY, withoutDeviceScope } from './genieacs/direct.js';

/** Onde ficam os prefixos PPPoE da marcação automática, em texto separado por vírgula. */
export const AUTO_PREFIXES_KEY = 'deviceScopeAutoPrefixes';

/** Até quantos prefixos um provedor tem, e o tamanho de cada um. */
export const AUTO_PREFIXES_MAX = 20;
export const AUTO_PREFIX_MAX_LENGTH = 64;

/** O resumo da última passada automática, que o console mostra. */
const LAST_AUTO_KEY = 'device_scope_auto_tag';

/** De quanto em quanto tempo o agendador passa pela frota. */
export const AUTO_TAG_INTERVAL_MS = 15 * 60_000;

/** `'TA100, ta200'` ou `['TA100']` → `['ta100', 'ta200']`: sem vazios nem repetidos. */
export function parsePrefixes(raw) {
  const texto = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
  return [...new Set(texto.split(/[\s,;]+/).map((p) => p.trim().toLowerCase()).filter(Boolean))];
}

/** Um prefixo é começo do outro — os dois reivindicariam as mesmas ONTs. */
export function prefixesOverlap(a, b) {
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Marca com a tag do provedor em escopo as ONTs do GenieACS que casam com
 * prefixos de login PPPoE ou com uma lista de seriais.
 *
 * Roda SEM o escopo do provedor, porque o que se procura é justamente o que
 * ainda não tem tag. Equipamento que já carrega a tag de OUTRO provedor não é
 * tocado — ele volta como conflito, para a plataforma decidir à mão. E só
 * acrescenta: nenhuma tag sai de equipamento algum por aqui.
 *
 * É o mesmo caminho da ferramenta manual do console e da varredura periódica
 * do agendador, para as duas nunca discordarem sobre o que é "de quem".
 */
class DeviceScopeTagger {
  static async autoPrefixes() {
    return parsePrefixes(await Setting.getByKey(AUTO_PREFIXES_KEY));
  }

  /**
   * `{ prefixes: string[], serials: Set<string>, apply: boolean }` →
   * `{ tag, matched, alreadyTagged, toTag, tagged, conflicts, conflictCount }`,
   * ou `{ error }` quando o provedor não tem tag.
   */
  static async run({ prefixes = [], serials = new Set(), apply = false } = {}) {
    const tag = String((await Setting.getByKey(DEVICE_SCOPE_KEY)) ?? '').trim();
    if (!tag) return { error: 'Set the provider device tag first' };
    const prefixos = prefixes.map((p) => String(p).toLowerCase()).filter(Boolean);
    const tagsDeProvedor = await DirectConnector.allScopeTags();

    return withoutDeviceScope(async () => {
      const frota = await DeviceService.listFleetIdentity();
      const casam = frota.filter((d) => {
        const login = String(d.pppoe || '').toLowerCase();
        return (login && prefixos.some((p) => login.startsWith(p)))
          || (serials.size > 0 && serials.has(String(d.serial || '').toUpperCase()));
      });
      const jaMarcados = [];
      const conflitos = [];
      const marcar = [];
      for (const d of casam) {
        if (d.tags.includes(tag)) jaMarcados.push(d);
        else if (d.tags.some((t) => tagsDeProvedor.has(t))) conflitos.push(d);
        else marcar.push(d);
      }
      let marcados = 0;
      if (apply) {
        for (const d of marcar) {
          // eslint-disable-next-line no-await-in-loop -- um por vez: o ACS é compartilhado
          await DeviceService.mutateDeviceTag(d._id, tag, 'POST');
          marcados += 1;
        }
      }
      return {
        tag,
        matched: casam.length,
        alreadyTagged: jaMarcados.length,
        toTag: marcar.length,
        tagged: marcados,
        conflicts: conflitos.slice(0, 50).map((d) => ({
          id: d._id, serial: d.serial, pppoe: d.pppoe, tags: d.tags.filter((t) => tagsDeProvedor.has(t))
        })),
        conflictCount: conflitos.length
      };
    });
  }

  /**
   * A passada periódica: os prefixos configurados, aplicando. `null` quando
   * não há o que fazer — sem tag ou sem prefixo, a marcação automática está
   * desligada para este provedor.
   */
  static async runAuto() {
    const prefixes = await this.autoPrefixes();
    if (prefixes.length === 0) return null;
    const tag = String((await Setting.getByKey(DEVICE_SCOPE_KEY)) ?? '').trim();
    if (!tag) return null;
    let resumo;
    try {
      const r = await this.run({ prefixes, apply: true });
      resumo = { at: new Date().toISOString(), tagged: r.tagged, conflictCount: r.conflictCount, error: null };
    } catch (error) {
      resumo = { at: new Date().toISOString(), tagged: 0, conflictCount: 0, error: error.message };
    }
    await AppState.upsert(LAST_AUTO_KEY, JSON.stringify(resumo));
    return resumo;
  }

  /** `{ at, tagged, conflictCount, error }` da última passada, ou `null`. */
  static async lastAuto() {
    const raw = await AppState.get(LAST_AUTO_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

export default DeviceScopeTagger;
