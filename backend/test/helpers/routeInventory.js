import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every route the two apps mount, read off the source rather than off a
 * running Express, because Express 5 keeps a mounted router's prefix as a
 * matcher function and not as a string — there is nothing to read back.
 *
 * The source is regular enough for a parser this small: `app.use('/api/x',
 * yRoutes)` in `app.js` says where a router file hangs, and inside each file
 * every route is `router.<method>(<'path'>, ...handlers)`, sometimes across
 * several lines, sometimes with a spread of a guard array declared at the top
 * of the same file. Both shapes are resolved here, so a test can ask of each
 * route: what guards stand in front of it?
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/**
 * As constantes de caminho que `app.js` importa, resolvidas no módulo delas.
 *
 * Um prefixo de montagem pode ser uma constante em vez de um literal, e há um
 * motivo para isso: o caminho do webhook é conferido contra o endereço público
 * que o operador digita, e as duas pontas divergirem foi uma falha real — o
 * painel atendia em `/api/whatsapp-webhook` e aceitava sem reclamar um endereço
 * apontando para outro lugar. Ler só literais aqui obrigaria a repetir o
 * caminho, que é exatamente o que a constante existe para evitar.
 *
 * @returns {Map<string, string>} nome da constante → valor
 */
function readPathConstants(text) {
  const valores = new Map();
  for (const m of text.matchAll(/^import \{([^}]+)\} from '(\.\/[\w/]+)\.js';/gm)) {
    const nomes = m[1].split(',').map((n) => n.trim()).filter(Boolean);
    let fonte;
    try {
      fonte = fs.readFileSync(path.join(SRC, `${m[2].slice(2)}.js`), 'utf8');
    } catch {
      continue;
    }
    for (const nome of nomes) {
      const achado = new RegExp(`^export const ${nome} = '([^']*)';`, 'm').exec(fonte);
      if (achado) valores.set(nome, achado[1]);
    }
  }
  return valores;
}

/** `app.use('/api/x', yRoutes)` → [{ app, prefix, importName }]. */
function readMounts() {
  const text = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  const imports = new Map();
  for (const m of text.matchAll(/^import (\w+) from '\.\/routes\/(\w+)\.js';/gm)) {
    imports.set(m[1], m[2]);
  }
  const constantes = readPathConstants(text);
  const mounts = [];
  for (const m of text.matchAll(/^\s*(app|portalApp)\.use\((?:'(\/api[^']*)'|(\w+)),\s*(\w+)\);/gm)) {
    const file = imports.get(m[4]);
    if (!file) continue;
    const prefix = m[2] ?? constantes.get(m[3]);
    // Uma constante que não resolveu some da lista, e some em silêncio — que é
    // como uma rota pública deixaria de ser contada. Melhor quebrar aqui.
    if (!prefix) throw new Error(`mount prefix ${m[3]} não resolveu em app.js`);
    if (!prefix.startsWith('/api')) continue;
    mounts.push({ app: m[1], prefix, file });
  }
  return mounts;
}

/** The guard arrays a routes file spreads into its routes: name → handler names. */
function readGuardArrays(text) {
  const arrays = new Map();
  for (const m of text.matchAll(/^const (\w+) = \[([^\]]*)\];/gm)) {
    arrays.set(m[1], m[2].split(',').map((s) => s.trim().replace(/\(.*$/, '')).filter(Boolean));
  }
  return arrays;
}

/** Splits a route's argument list at top-level commas only. */
function splitArgs(args) {
  const out = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const ch of args) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if ('([{'.includes(ch)) depth += 1;
    if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) { out.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Every `router.<method>(...)` call in one file, with its handlers named. */
function readRoutes(file) {
  const text = fs.readFileSync(path.join(SRC, 'routes', `${file}.js`), 'utf8');
  const arrays = readGuardArrays(text);
  const routes = [];
  const re = /router\.(get|post|put|patch|delete)\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // Walk to the matching close paren, honouring nested parens and strings.
    let depth = 1;
    let i = re.lastIndex;
    let quote = null;
    for (; i < text.length && depth > 0; i += 1) {
      const ch = text[i];
      if (quote) { if (ch === quote && text[i - 1] !== '\\') quote = null; continue; }
      if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
    }
    const args = splitArgs(text.slice(re.lastIndex, i - 1).replace(/\/\/[^\n]*/g, ''));
    const routePath = args[0].replace(/^['"`]|['"`]$/g, '');
    const handlers = args.slice(1).flatMap((arg) => {
      const spread = /^\.\.\.(\w+)$/.exec(arg);
      if (spread) return arrays.get(spread[1]) ?? [`...${spread[1]}`];
      return [arg.replace(/\(.*$/s, '').replace(/^async.*$/s, '(inline)').trim()];
    });
    const lineStart = text.slice(0, m.index).lastIndexOf('\n');
    const line = text.slice(lineStart + 1, m.index);
    routes.push({
      method: m[1].toUpperCase(),
      path: routePath,
      handlers,
      // A route mounted only on one edition: `if (IS_SAAS) router.post(...)`.
      edition: /IS_SAAS/.test(line) ? 'saas' : /IS_SELF_HOSTED/.test(line) ? 'selfhosted' : null
    });
    re.lastIndex = i;
  }
  return routes;
}

/**
 * The inventory: one entry per mounted route, with its full path. Routers
 * mounted under an edition flag in `app.js` carry that edition too.
 */
export function listRoutes() {
  const appText = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  const out = [];
  for (const mount of readMounts()) {
    // Whether the mount line sits inside `if (IS_SAAS) {` / `if (IS_SELF_HOSTED) {`.
    const before = appText.slice(0, appText.indexOf(`'${mount.prefix}', ${routeVar(appText, mount.file)}`));
    const lastIf = Math.max(before.lastIndexOf('if (IS_SAAS) {'), before.lastIndexOf('if (IS_SELF_HOSTED) {'));
    const lastClose = before.lastIndexOf('\n}');
    const mountEdition = lastIf > lastClose
      ? (before.lastIndexOf('if (IS_SAAS) {') === lastIf ? 'saas' : 'selfhosted')
      : null;
    for (const route of readRoutes(mount.file)) {
      const full = (mount.prefix + (route.path === '/' ? '' : route.path)).replace(/\/+$/, '') || mount.prefix;
      out.push({
        app: mount.app,
        file: mount.file,
        method: route.method,
        path: full,
        handlers: route.handlers,
        edition: route.edition ?? mountEdition
      });
    }
  }
  return out;
}

function routeVar(appText, file) {
  const m = new RegExp(`^import (\\w+) from '\\./routes/${file}\\.js';`, 'm').exec(appText);
  return m ? m[1] : file;
}

/** `/api/x/:nodeId/y` → `/api/x/:p/y`, so two spellings of "an id" compare equal. */
export function normalizeParams(routePath) {
  return routePath.replace(/:[A-Za-z_]+/g, ':p');
}
