import { log } from '../utils/logger.js';

/**
 * CEP → endereço, e endereço → ponto no mapa, para PREENCHER o cadastro do
 * provedor.
 *
 * O mesmo contrato de `cnpjLookupService.js`: só sugere, nada é gravado aqui;
 * roda no servidor porque a CSP do painel só deixa a tela falar com a própria
 * origem; cada fonte tem tempo próprio; e quando nenhuma responde, o motivo de
 * cada uma vai para o log, que é por onde se descobre se o servidor está sem
 * saída ou se a fonte recusou.
 */

const TIMEOUT_MS = 6000;
const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'genieacs-panel (+https://painel.tr69.com.br)'
};

/** Os mesmos limites da gravação do cadastro (`CAMPOS_FATURAMENTO`). */
const LIMITES = { postalCode: 8, addressLine: 160, district: 80, city: 80, state: 2 };

function texto(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor).replace(/\s+/g, ' ').trim();
}

function motivo(erro) {
  if (erro?.name === 'TimeoutError') return 'timeout';
  const causa = erro?.cause?.code || erro?.cause?.message;
  return causa ? `${erro.message} (${causa})` : String(erro?.message || erro);
}

function endereco(bruto) {
  const cep = texto(bruto.postalCode).replace(/\D/g, '');
  const normalizado = { ...bruto, postalCode: cep, state: texto(bruto.state).toUpperCase() };
  const saida = {};
  for (const [chave, limite] of Object.entries(LIMITES)) {
    const valor = texto(normalizado[chave]);
    if (valor) saida[chave] = valor.slice(0, limite);
  }
  return saida;
}

function coordenada(lat, lng) {
  const la = Number(lat), ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || (la === 0 && ln === 0)) return null;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  return { lat: Math.round(la * 1e6) / 1e6, lng: Math.round(ln * 1e6) / 1e6 };
}

/** Resposta da BrasilAPI (`/api/cep/v2`), que às vezes traz coordenadas. */
export function mapBrasilApiCep(dados) {
  const saida = endereco({
    postalCode: dados?.cep,
    addressLine: dados?.street,
    district: dados?.neighborhood,
    city: dados?.city,
    state: dados?.state
  });
  const ponto = coordenada(
    dados?.location?.coordinates?.latitude,
    dados?.location?.coordinates?.longitude
  );
  return ponto ? { ...saida, ...ponto } : saida;
}

/** Resposta do ViaCEP (`/ws/{cep}/json/`). */
export function mapViaCep(dados) {
  return endereco({
    postalCode: dados?.cep,
    addressLine: dados?.logradouro,
    district: dados?.bairro,
    city: dados?.localidade,
    state: dados?.uf
  });
}

const FONTES_CEP = [
  { nome: 'brasilapi', url: (cep) => `https://brasilapi.com.br/api/cep/v2/${cep}`, mapear: mapBrasilApiCep },
  {
    nome: 'viacep',
    url: (cep) => `https://viacep.com.br/ws/${cep}/json/`,
    mapear: mapViaCep,
    // O ViaCEP responde 200 com `{ "erro": true }` para o CEP que não existe.
    naoEncontrado: (dados) => dados?.erro === true || dados?.erro === 'true'
  }
];

/**
 * `{ found: true, data }`, `{ found: false }` quando o CEP não existe, ou
 * lança quando nenhuma fonte respondeu.
 */
export async function lookupCep(cep) {
  const falhas = [];
  for (const fonte of FONTES_CEP) {
    try {
      const response = await fetch(fonte.url(cep), { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.status === 404) return { found: false };
      if (!response.ok) {
        falhas.push(`${fonte.nome}: HTTP ${response.status}`);
        continue;
      }
      const dados = await response.json();
      if (fonte.naoEncontrado?.(dados)) return { found: false };
      const data = fonte.mapear(dados);
      if (!data.city) {
        falhas.push(`${fonte.nome}: resposta sem cidade`);
        continue;
      }
      return { found: true, data };
    } catch (erro) {
      falhas.push(`${fonte.nome}: ${motivo(erro)}`);
    }
  }
  const resumo = falhas.join('; ');
  log.warn('cep lookup failed', { attempts: resumo });
  throw new Error(resumo);
}

/** UF → nome do estado, que é o que o Nominatim entende no campo `state`. */
const ESTADOS = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará',
  DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão',
  MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará',
  PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro',
  RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima',
  SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins'
};

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

async function nominatim(params) {
  const query = new URLSearchParams({ format: 'jsonv2', limit: '1', countrycodes: 'br', country: 'Brasil', ...params });
  const response = await fetch(`${NOMINATIM}?${query}`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const lista = await response.json();
  const primeiro = Array.isArray(lista) ? lista[0] : null;
  return primeiro ? coordenada(primeiro.lat, primeiro.lon) : null;
}

/**
 * O ponto de um endereço brasileiro, pelo Nominatim (OpenStreetMap).
 *
 * Duas tentativas: o endereço inteiro (rua e número) e, se ele não for achado
 * — rua nova, número que o OSM não tem —, só a cidade. A segunda já põe o
 * marcador no lugar certo do país; `precision` diz à tela qual das duas foi,
 * para ela pedir que o operador ajuste o marcador.
 *
 * `{ found: true, data: { lat, lng, precision } }`, `{ found: false }`, ou
 * lança quando a consulta falhou.
 */
export async function geocodeAddress(campos) {
  const city = texto(campos?.city);
  const uf = texto(campos?.state).toUpperCase();
  const state = ESTADOS[uf] || uf;
  const rua = [texto(campos?.addressNumber), texto(campos?.addressLine)].filter(Boolean).join(' ');
  const cep = texto(campos?.postalCode).replace(/\D/g, '');

  const tentativas = [];
  if (rua) {
    tentativas.push({
      precision: 'address',
      params: { street: rua, city, state, ...(cep.length === 8 ? { postalcode: `${cep.slice(0, 5)}-${cep.slice(5)}` } : {}) }
    });
  }
  tentativas.push({ precision: 'city', params: { city, state } });

  const falhas = [];
  let respondeu = false;
  for (const tentativa of tentativas) {
    try {
      const ponto = await nominatim(tentativa.params);
      respondeu = true;
      if (ponto) return { found: true, data: { ...ponto, precision: tentativa.precision } };
    } catch (erro) {
      falhas.push(`nominatim (${tentativa.precision}): ${motivo(erro)}`);
    }
  }
  if (respondeu) return { found: false };
  const resumo = falhas.join('; ');
  log.warn('geocode failed', { attempts: resumo });
  throw new Error(resumo);
}

/** Rótulo curto: o `display_name` do Nominatim chega a ter dez partes. */
function rotulo(item) {
  const partes = String(item?.display_name || '').split(',').map((parte) => parte.trim()).filter(Boolean);
  return partes.filter((parte) => parte !== 'Brasil' && !/^Região (Geográfica|Metropolitana)/.test(parte)).slice(0, 5).join(', ').slice(0, 200);
}

/**
 * Busca livre de um lugar no Brasil (rua, bairro, cidade, ponto conhecido),
 * para a caixa de busca da Topologia.
 *
 * `[{ lat, lng, label }]`, vazio quando nada foi achado; lança quando a
 * consulta falhou.
 */
export async function searchPlaces(q, { limit = 5 } = {}) {
  const termo = texto(q).slice(0, 200);
  const query = new URLSearchParams({ format: 'jsonv2', limit: String(limit), countrycodes: 'br', q: termo });
  const response = await fetch(`${NOMINATIM}?${query}`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const lista = await response.json();
  if (!Array.isArray(lista)) return [];
  return lista
    .map((item) => {
      const ponto = coordenada(item.lat, item.lon);
      return ponto ? { ...ponto, label: rotulo(item) } : null;
    })
    .filter(Boolean);
}

export default { lookupCep, geocodeAddress, searchPlaces, mapBrasilApiCep, mapViaCep };
