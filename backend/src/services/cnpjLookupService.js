import { log } from '../utils/logger.js';

/**
 * Consulta um CNPJ em serviços públicos para PREENCHER o cadastro do provedor.
 *
 * Só sugere: não grava nada, e o cadastro continua terminando sem ela — a
 * regra de `utils/taxId.js` (um cadastro não pode depender de um terceiro
 * para terminar) vale igual. Se todas as fontes caírem, o operador digita.
 *
 * Roda no servidor e não no navegador porque a CSP do painel só deixa a tela
 * falar com a própria origem, e porque assim o painel escolhe o que devolve:
 * só os campos do cadastro, já no tamanho que a rota de gravação aceita.
 *
 * Três fontes, em cascata, porque cada uma cai do seu jeito: a BrasilAPI
 * recusa IPs de datacenter com 403/429, a CNPJ.ws e a ReceitaWS limitam a
 * poucas consultas por minuto. A primeira que responder vale; um 404 (a
 * Receita não conhece o número) encerra a busca, porque as outras leem a
 * mesma base e diriam o mesmo.
 */

const TIMEOUT_MS = 6000;
const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'genieacs-panel (+https://painel.tr69.com.br)'
};

/** Os limites de `CAMPOS_FATURAMENTO` do controlador — o que não cabe, corta. */
const LIMITES = {
  legalName: 160,
  // O nome fantasia não é campo do cadastro: vai só para a tela sugerir o nome
  // do painel (onboarding). Mesmo teto da razão social.
  tradeName: 160,
  postalCode: 8,
  addressLine: 160,
  addressNumber: 16,
  addressExtra: 80,
  district: 80,
  city: 80,
  state: 2,
  email: 160,
  phone: 32
};

function texto(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor).replace(/\s+/g, ' ').trim();
}

/** Monta o cadastro a partir de campos já separados: normaliza, descarta vazios e corta. */
function cadastro(bruto) {
  const cep = texto(bruto.postalCode).replace(/\D/g, '');
  const normalizado = {
    ...bruto,
    postalCode: cep ? cep.padStart(8, '0') : '',
    state: texto(bruto.state).toUpperCase(),
    email: texto(bruto.email).toLowerCase()
  };
  const saida = {};
  for (const chave of Object.keys(LIMITES)) {
    const valor = texto(normalizado[chave]);
    if (valor) saida[chave] = valor.slice(0, LIMITES[chave]);
  }
  return saida;
}

const juntar = (...partes) => partes.map(texto).filter(Boolean).join(' ');

/** Resposta da BrasilAPI (`/api/cnpj/v1`). */
export function mapBrasilApiCnpj(dados) {
  return cadastro({
    legalName: dados?.razao_social,
    tradeName: dados?.nome_fantasia,
    postalCode: dados?.cep,
    addressLine: juntar(dados?.descricao_tipo_de_logradouro, dados?.logradouro),
    addressNumber: dados?.numero,
    addressExtra: dados?.complemento,
    district: dados?.bairro,
    city: dados?.municipio,
    state: dados?.uf,
    email: dados?.email,
    phone: dados?.ddd_telefone_1
  });
}

/** Resposta da CNPJ.ws pública (`publica.cnpj.ws/cnpj`). */
export function mapCnpjWs(dados) {
  const est = dados?.estabelecimento ?? {};
  return cadastro({
    legalName: dados?.razao_social,
    tradeName: est.nome_fantasia,
    postalCode: est.cep,
    addressLine: juntar(est.tipo_logradouro, est.logradouro),
    addressNumber: est.numero,
    addressExtra: est.complemento,
    district: est.bairro,
    city: est.cidade?.nome,
    state: est.estado?.sigla,
    email: est.email,
    phone: juntar(est.ddd1, est.telefone1).replace(/\s+/g, '')
  });
}

/** Resposta da ReceitaWS (`receitaws.com.br/v1/cnpj`). */
export function mapReceitaWs(dados) {
  return cadastro({
    legalName: dados?.nome,
    tradeName: dados?.fantasia,
    postalCode: dados?.cep,
    addressLine: dados?.logradouro,
    addressNumber: dados?.numero,
    addressExtra: dados?.complemento,
    district: dados?.bairro,
    city: dados?.municipio,
    state: dados?.uf,
    email: dados?.email,
    // A ReceitaWS junta vários telefones com " / "; fica o primeiro.
    phone: texto(dados?.telefone).split('/')[0]
  });
}

const FONTES = [
  { nome: 'brasilapi', url: (cnpj) => `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, mapear: mapBrasilApiCnpj },
  { nome: 'cnpjws', url: (cnpj) => `https://publica.cnpj.ws/cnpj/${cnpj}`, mapear: mapCnpjWs },
  {
    nome: 'receitaws',
    url: (cnpj) => `https://receitaws.com.br/v1/cnpj/${cnpj}`,
    mapear: mapReceitaWs,
    // A ReceitaWS responde 200 com `status: "ERROR"` para o que não conhece.
    naoEncontrado: (dados) => dados?.status === 'ERROR' && /inv[aá]lido|n[aã]o encontrad/i.test(texto(dados?.message))
  }
];

function motivo(erro) {
  const causa = erro?.cause?.code || erro?.cause?.message;
  if (erro?.name === 'TimeoutError') return 'timeout';
  return causa ? `${erro.message} (${causa})` : String(erro?.message || erro);
}

/**
 * `{ found: true, data, source }`, `{ found: false }` quando a Receita não
 * conhece o número, ou lança quando nenhuma fonte respondeu.
 */
export async function lookupCnpj(cnpj) {
  const falhas = [];
  for (const fonte of FONTES) {
    try {
      const response = await fetch(fonte.url(cnpj), {
        headers: HEADERS,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (response.status === 404) return { found: false };
      if (!response.ok) {
        falhas.push(`${fonte.nome}: HTTP ${response.status}`);
        continue;
      }
      const dados = await response.json();
      if (fonte.naoEncontrado?.(dados)) return { found: false };
      const data = fonte.mapear(dados);
      if (!data.legalName) {
        falhas.push(`${fonte.nome}: resposta sem razão social`);
        continue;
      }
      return { found: true, data, source: fonte.nome };
    } catch (erro) {
      falhas.push(`${fonte.nome}: ${motivo(erro)}`);
    }
  }
  const resumo = falhas.join('; ');
  log.warn('cnpj lookup failed', { attempts: resumo });
  throw new Error(resumo);
}

export default { lookupCnpj, mapBrasilApiCnpj, mapCnpjWs, mapReceitaWs };
