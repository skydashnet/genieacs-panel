import crypto from 'node:crypto';

/**
 * Código de uso único por tempo (TOTP, RFC 6238), o que os apps autenticadores
 * — Google Authenticator, Microsoft Authenticator, Authy — geram.
 *
 * Sem dependência: é um HMAC-SHA1 sobre o número do passo de 30 segundos,
 * truncado em 6 dígitos (RFC 4226, seção 5.3). Os parâmetros são os padrão
 * porque é o que todo app entende sem configuração: SHA-1, 6 dígitos, 30 s.
 * SHA-1 aqui não é o SHA-1 fraco de assinatura — o HMAC não depende da
 * resistência a colisão que caiu.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/**
 * Quantos passos para trás e para frente valem: o relógio do celular erra, e
 * quem digita leva alguns segundos. Um passo cada lado é o que os provedores
 * grandes aceitam — mais que isso alarga a janela de quem tenta adivinhar.
 */
export const TOTP_WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let valor = 0;
  let saida = '';
  for (const byte of buffer) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      saida += BASE32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) saida += BASE32[(valor << (5 - bits)) & 31];
  return saida;
}

export function base32Decode(texto) {
  const limpo = String(texto ?? '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let valor = 0;
  const bytes = [];
  for (const letra of limpo) {
    const indice = BASE32.indexOf(letra);
    if (indice < 0) throw new Error('Invalid base32');
    valor = (valor << 5) | indice;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Um segredo novo: 20 bytes, o tamanho da saída do SHA-1 que o RFC recomenda. */
export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** O passo de 30 s em que um instante cai. */
export function totpStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/** O código de um passo, como o app o mostra. */
export function totpCode(secret, step, digits = TOTP_DIGITS) {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(contador).digest();
  const deslocamento = hmac[hmac.length - 1] & 0x0f;
  const binario = ((hmac[deslocamento] & 0x7f) << 24)
    | (hmac[deslocamento + 1] << 16)
    | (hmac[deslocamento + 2] << 8)
    | hmac[deslocamento + 3];
  return String(binario % (10 ** digits)).padStart(digits, '0');
}

/**
 * O passo em que o código digitado confere, ou `null`.
 *
 * Devolve o PASSO e não um booleano porque é ele que impede o mesmo código de
 * entrar duas vezes: quem chama grava o último passo aceito e recusa qualquer
 * um que não seja maior (`afterStep`). Sem isso, quem visse o código por cima
 * do ombro teria trinta segundos para entrar com ele de novo.
 *
 * A comparação é em tempo constante, código a código.
 */
export function verifyTotp(secret, code, { nowMs = Date.now(), afterStep = null } = {}) {
  const digitado = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(digitado)) return null;
  const atual = totpStep(nowMs);
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta += 1) {
    const passo = atual + delta;
    if (afterStep !== null && passo <= afterStep) continue;
    const esperado = totpCode(secret, passo);
    if (crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(digitado))) return passo;
  }
  return null;
}

/**
 * A URI que o app lê do QR code. `issuer` aparece no app como o nome da conta
 * — o nome do painel —, e `label` é quem entrou, para quem tem mais de uma.
 */
export function totpUri({ secret, label, issuer }) {
  const rotulo = encodeURIComponent(`${issuer}:${label}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS)
  });
  return `otpauth://totp/${rotulo}?${params.toString()}`;
}
