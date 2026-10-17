import dns from 'node:dns';
import net from 'node:net';

/**
 * "Este endereço de GenieACS é o mesmo ACS daquele outro?"
 *
 * A pergunta decide se um provedor sem tag de equipamentos enxerga a frota
 * inteira (ACS só dele) ou nada (ACS que outro provedor também usa). Comparar o
 * texto de `new URL().origin` não basta: o IP no lugar do nome, o nome com ponto
 * final (`acs.exemplo.`), a porta padrão escrita por extenso ou um segundo nome
 * DNS para o mesmo servidor dão textos diferentes para o MESMO ACS — e quem
 * gravasse um deles passava por "ACS só meu" e via (e controlava) a frota de
 * todos.
 *
 * Então dois endereços são o mesmo ACS quando a origem normalizada coincide OU
 * quando os pares `ip:porta` para onde eles resolvem se cruzam. Errar para o
 * lado de "é o mesmo" é o lado seguro: o pior que acontece é um provedor ficar
 * sem ver nada até a plataforma definir a tag dele.
 */

const PORTA_PADRAO = { 'http:': '80', 'https:': '443' };
const PRAZO_DNS_MS = 2_000;

/**
 * A resolução de nomes, num lugar só que o teste troca (`setAcsLookup`).
 * `dns.lookup` é `getaddrinfo` — o mesmo que o socket usaria.
 */
const lookupPadrao = (hostname) => dns.promises.lookup(hostname, { all: true });
let lookup = lookupPadrao;

/** Troca a resolução de nomes (teste). Sem argumento, volta à de verdade. */
export function setAcsLookup(fn) {
  lookup = typeof fn === 'function' ? fn : lookupPadrao;
}

/** Os colchetes são a notação de URL para IPv6, não parte do endereço. */
function semColchetes(hostname) {
  return String(hostname ?? '').replace(/^\[|\]$/g, '');
}

/** `::ffff:10.0.0.1` é o 10.0.0.1: o mesmo destino, escrito em v6. */
function ipCanonico(address) {
  const ip = String(address ?? '').toLowerCase();
  const mapeado = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapeado) return mapeado[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hex) {
    const alto = parseInt(hex[1], 16);
    const baixo = parseInt(hex[2], 16);
    return [alto >> 8, alto & 255, baixo >> 8, baixo & 255].join('.');
  }
  return ip;
}

function parse(url) {
  if (!url) return null;
  try {
    const parsed = new URL(String(url).trim());
    // Sem host (`mailto:`, `file:`) não há ACS para comparar.
    if (!parsed.hostname) return null;
    const host = semColchetes(parsed.hostname).toLowerCase().replace(/\.+$/, '');
    if (!host) return null;
    const port = parsed.port || PORTA_PADRAO[parsed.protocol] || '';
    return { protocol: parsed.protocol, host, port };
  } catch {
    return null;
  }
}

/**
 * A origem normalizada: esquema, host em minúsculas e sem ponto final, e a
 * porta SEMPRE explícita. `null` para o que não é URL.
 */
export function normalizedAcsOrigin(url) {
  const p = parse(url);
  if (!p) return null;
  const host = net.isIPv6(p.host) ? `[${ipCanonico(p.host)}]` : p.host;
  return `${p.protocol}//${host}:${p.port}`;
}

function comPrazo(promise, ms) {
  let timer;
  const prazo = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('acs_dns_timeout')), ms);
  });
  return Promise.race([promise, prazo]).finally(() => clearTimeout(timer));
}

/**
 * Os pares `ip:porta` para onde o endereço aponta. IP literal é a própria
 * resposta; nome que não resolve (ou demora mais que o prazo) dá conjunto
 * vazio — e aí só a comparação de origem decide.
 */
export async function acsEndpoints(url, { timeoutMs = PRAZO_DNS_MS } = {}) {
  const p = parse(url);
  const endpoints = new Set();
  if (!p) return endpoints;
  const par = (ip) => (net.isIPv6(ip) ? `[${ip}]:${p.port}` : `${ip}:${p.port}`);
  if (net.isIP(p.host)) {
    endpoints.add(par(ipCanonico(p.host)));
    return endpoints;
  }
  try {
    const respostas = await comPrazo(Promise.resolve().then(() => lookup(p.host)), timeoutMs);
    for (const resposta of Array.isArray(respostas) ? respostas : [respostas]) {
      const ip = ipCanonico(typeof resposta === 'string' ? resposta : resposta?.address);
      if (net.isIP(ip)) endpoints.add(par(ip));
    }
  } catch {
    // Sem DNS, sem cruzamento por IP: fica a comparação de origem.
  }
  return endpoints;
}

/**
 * Se `url` é o mesmo ACS que algum de `others`. Resolve cada endereço uma vez
 * só, todos em paralelo.
 */
export async function sameAcsAsAny(url, others, options = {}) {
  const origem = normalizedAcsOrigin(url);
  if (!origem) return false;
  // Um por origem: dez provedores no mesmo nome são uma consulta DNS, não dez.
  const porOrigem = new Map();
  for (const other of others ?? []) {
    const chave = normalizedAcsOrigin(other);
    if (chave && !porOrigem.has(chave)) porOrigem.set(chave, other);
  }
  if (porOrigem.size === 0) return false;
  if (porOrigem.has(origem)) return true;
  const candidatos = [...porOrigem.values()];

  const [meus, ...deles] = await Promise.all([url, ...candidatos].map((u) => acsEndpoints(u, options)));
  if (meus.size === 0) return false;
  return deles.some((set) => [...set].some((endpoint) => meus.has(endpoint)));
}

/** Se `urlA` e `urlB` são o mesmo ACS. */
export function sameAcs(urlA, urlB, options = {}) {
  return sameAcsAsAny(urlA, [urlB], options);
}
