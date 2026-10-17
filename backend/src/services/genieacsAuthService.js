import AppState from '../models/AppState.js';
import { createSecretBox } from '../utils/secretBox.js';
import { IS_SELF_HOSTED } from '../config/edition.js';
import { TenantCache } from '../config/tenantCache.js';

/**
 * A credencial com que o painel se apresenta ao GenieACS daquele provedor.
 *
 * Até aqui o painel **não mandava header de autenticação nenhum**. Isso é
 * defensável na edição self-hosted, onde a premissa escrita no código é que a
 * NBI está em loopback ou rede privada e quem alcança a porta já está dentro.
 * No SaaS a premissa não vale: a URL passa a ser dado do cliente, o ACS fica do
 * lado dele, e o caminho até lá atravessa a internet. Uma NBI sem autenticação
 * exposta é o painel inteiro de um provedor aberto a quem souber o endereço —
 * e é o provedor que fica exposto, não nós.
 *
 * Guarda o segredo cifrado com `secretBox` sob contexto próprio, como o token
 * do SGP e o da instância do Evolution. Contexto próprio e não compartilhado:
 * uma chave que abre três coisas transforma o vazamento de uma no vazamento das
 * três, e o custo de separar é uma string.
 */

const CONFIG_KEY = 'genieacs_auth_config';

const secretoBox = createSecretBox('skygenpanel-genieacs-nbi-v1');

/** `none` continua sendo o padrão: nenhum install existente ganha header de repente. */
export const AUTH_TYPES = Object.freeze(['none', 'basic', 'bearer']);

const DEFAULT_CONFIG = Object.freeze({ authType: 'none', username: '' });

/**
 * Cache por provedor, como o do SGP e o do Evolution.
 *
 * Toda requisição ao ACS passaria a ler `app_state` e a decifrar o segredo sem
 * ele — e o dashboard sozinho faz uma dessas por minuto, por provedor.
 */
const configCache = new TenantCache(60_000);

class GenieAcsAuthService {
  static configCache = configCache;

  static async readStored() {
    const raw = await AppState.get(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG, secret: null };
    try {
      const parsed = JSON.parse(raw);
      return {
        authType: AUTH_TYPES.includes(parsed.authType) ? parsed.authType : 'none',
        username: String(parsed.username || ''),
        secret: parsed.secret ? (secretoBox.decrypt(parsed.secret) ?? '') : null
      };
    } catch {
      // Blob ilegível vira "sem credencial" e não exceção: o que está em jogo é
      // se manda header, e falhar fechado aqui derruba o painel inteiro daquele
      // provedor por causa de um JSON torto.
      return { ...DEFAULT_CONFIG, secret: null };
    }
  }

  static async getConfig() {
    const cached = configCache.get();
    if (cached) return cached;
    const config = await this.readStored();
    configCache.set(config);
    return config;
  }

  /** O que a tela pode ver: nunca o segredo, só se existe um. */
  static async getPublicConfig() {
    const { secret, ...resto } = await this.getConfig();
    return {
      ...resto,
      secretConfigured: Boolean(secret),
      authTypes: AUTH_TYPES,
      // Vai na resposta porque a decisão é da tela, e sem este campo a tela não
      // tem como tomá-la: ela não sabe em que edição o servidor roda. Estava
      // faltando na primeira escrita — o método existia com um comentário
      // prometendo um consumidor que não podia existir.
      allowsAnonymous: GenieAcsAuthService.allowsAnonymous()
    };
  }

  /**
   * Grava. `secret: undefined` mantém o que está lá; `secret: ''` apaga.
   *
   * A distinção existe porque a tela não pode reexibir o segredo para
   * reenviá-lo: um formulário que salva sem tocar no campo mandaria vazio, e
   * sem esta regra cada "salvar" apagaria a credencial. Apagar tem que ser
   * pedido, e é o string vazio que pede.
   */
  static async saveConfig(patch = {}) {
    const atual = await this.getConfig();
    const authType = AUTH_TYPES.includes(patch.authType) ? patch.authType : atual.authType;
    const username = patch.username === undefined
      ? atual.username
      : String(patch.username).trim().slice(0, 128);

    let secret = atual.secret;
    if (patch.secret !== undefined) {
      const texto = String(patch.secret);
      secret = texto.length ? texto.slice(0, 512) : null;
    }
    // Trocar para `none` apaga o segredo em vez de deixá-lo guardado sem uso.
    // Segredo cifrado que nada lê é só superfície de vazamento esperando o dia
    // em que alguém religa a autenticação sem saber o que está mandando.
    if (authType === 'none') secret = null;

    await AppState.upsert(CONFIG_KEY, JSON.stringify({
      authType,
      username,
      secret: secret ? { v: 1, ...secretoBox.encrypt(secret) } : null
    }));
    // `invalidate` e não `clear`: quem salvou foi ESTE provedor, e limpar tudo
    // custaria uma ida ao banco a cada um dos outros sem que nada tivesse
    // mudado para eles.
    configCache.invalidate();
    return this.getPublicConfig();
  }

  /**
   * O header `Authorization` daquele provedor, ou `{}`.
   *
   * Devolve objeto e nunca string para que o call site espalhe com `...` — um
   * `undefined` espalhado é objeto vazio, então uma configuração ausente não
   * vira `Authorization: undefined` no fio.
   */
  static async authHeader() {
    const { authType, username, secret } = await this.getConfig();
    if (authType === 'basic') {
      if (!secret && !username) return {};
      const par = Buffer.from(`${username}:${secret ?? ''}`, 'utf8').toString('base64');
      return { Authorization: `Basic ${par}` };
    }
    if (authType === 'bearer') {
      if (!secret) return {};
      return { Authorization: `Bearer ${secret}` };
    }
    return {};
  }

  /**
   * Os headers de TODA requisição à NBI.
   *
   * Existe como função única, e não como um objeto montado em cada call site,
   * porque `deviceService.js` tem sete chamadas ao ACS e a oitava vai nascer
   * sem o header se cada uma montar o seu. `genieacs-nbi-auth.test.js` varre o
   * arquivo e falha quando uma chamada não vem daqui — é a mesma forma da
   * guarda estática de escopo, pelo mesmo motivo: a falha silenciosa aqui é uma
   * requisição sem credencial, que o ACS de quem não exige autenticação aceita
   * numa boa, e o de quem exige recusa com um 401 sem explicação na tela.
   */
  static async nbiHeaders(extra = {}) {
    return { Accept: 'application/json', ...(await this.authHeader()), ...extra };
  }

  /**
   * Se este deployment pode falar com uma NBI sem autenticação.
   *
   * No self-hosted sim, e é o caso normal: a NBI está na LAN do próprio
   * provedor e nunca teve credencial. No SaaS a URL é dado do cliente e o
   * caminho até lá é a internet, então "sem autenticação" é configuração que
   * ninguém deveria conseguir salvar sem ver um aviso — quem decide o que fazer
   * com esta resposta é a tela, que é onde a pessoa está.
   */
  static allowsAnonymous() {
    return IS_SELF_HOSTED;
  }
}

export default GenieAcsAuthService;
