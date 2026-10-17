/**
 * Para onde uma mensagem sai — telefone ou LID — e como um número solto vira
 * um endereço enviável.
 *
 * Desde que o WhatsApp passou a endereçar contatos por LID (`@lid`), um contato
 * pode existir sem telefone nenhum: `wa_phone_e164` fica NULL e a identidade
 * dele é `wa_lid`. Quem envia precisa decidir entre os dois num lugar só.
 *
 * Portado de compra-venda `supabase/functions/_shared/wa-destino.ts`, sem o
 * ramo da Cloud API da Meta (aqui só existe Evolution, que fala LID).
 */

import { classificarJid } from './waJid.js';

/**
 * Decide o endereço de destino a partir do contato e, como último recurso, da
 * conversa.
 *
 * @param {{ wa_phone_e164?: string|null, wa_lid?: string|null }|null|undefined} contato
 * @param {{ external_thread_id?: string|null }|null} [conversa]
 * @returns {{ valor: string, tipo: 'phone'|'lid' }|null}
 */
export function destinoWa(contato, conversa) {
  // Telefone sempre ganha: é auditável e é o que um humano confere olhando.
  const fone = String(contato?.wa_phone_e164 || '').trim();
  if (fone) return { valor: fone, tipo: 'phone' };

  const lid = String(contato?.wa_lid || '').trim();
  if (lid) return { valor: lid, tipo: 'lid' };

  // Fallback de legado, deliberadamente por último: `external_thread_id` é
  // menos confiável que a coluna do contato.
  const thread = classificarJid(conversa?.external_thread_id);
  if (thread.tipo === 'lid' && thread.valor) return { valor: thread.valor, tipo: 'lid' };

  return null;
}

/**
 * Normaliza um telefone brasileiro escrito por humano — ou vindo do cadastro do
 * SGP — para os dígitos que o Evolution aceita como destino (DDI + DDD +
 * número, sem '+' e sem pontuação).
 *
 * O que esta função DELIBERADAMENTE não faz: inventar o nono dígito. A base do
 * sistema de origem tinha 189 de 236 números gravados com 12 dígitos
 * (55 + DDD + 8), de antes da mudança — e telefone fixo continua com 8 dígitos
 * para sempre. Acrescentar um 9 acerta em celular antigo e erra em fixo, e o
 * erro é mudo: a mensagem sai para um número que existe e é de outra pessoa.
 * Quem sabe se o número é celular é o `check_number` do próprio WhatsApp.
 *
 * @param {string|null|undefined} bruto
 * @returns {string} dígitos prontos para envio, ou '' quando não dá para usar
 */
export function normalizarTelefoneBr(bruto) {
  const d = String(bruto || '').replace(/\D/g, '');
  if (!d) return '';
  // Já tem DDI do Brasil: 55 + DDD(2) + 8 ou 9 dígitos.
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d;
  // DDD + número, sem DDI.
  if (d.length === 10 || d.length === 11) return `55${d}`;
  // Fora dessas formas pode ser um número internacional legítimo (E.164 vai até
  // 15 dígitos) ou lixo de cadastro. Devolvemos os dígitos para quem chama
  // decidir; o que não fazemos é adivinhar um DDI.
  if (d.length >= 8 && d.length <= 15) return d;
  return '';
}

/**
 * As grafias sob as quais o MESMO celular brasileiro pode aparecer: com e sem o
 * nono dígito.
 *
 * Serve para CASAR, nunca para enviar. O WhatsApp ainda endereça muita conta
 * antiga pelo número de 12 dígitos (55 + DDD + 8) — é o que chega no JID de uma
 * mensagem recebida —, enquanto o SGP guarda o mesmo aparelho com o 9 na
 * frente. Comparando só a grafia exata, o assinante que escreve do celular
 * cadastrado aparece como "número não vinculado".
 *
 * O cuidado de `normalizarTelefoneBr` vale aqui também: só se mexe no nono
 * dígito de celular. Um número de 8 dígitos que começa com 2 a 5 é fixo e fica
 * como está — acrescentar um 9 nele produziria o celular de outra pessoa.
 *
 * @param {string|null|undefined} bruto
 * @returns {string[]} a grafia normalizada primeiro, e a alternativa quando houver
 */
export function variantesTelefoneBr(bruto) {
  const d = normalizarTelefoneBr(bruto);
  if (!d) return [];
  if (!d.startsWith('55')) return [d];
  const ddd = d.slice(2, 4);
  const local = d.slice(4);
  // 55 + DDD + 9 + 8 dígitos de celular → a grafia antiga, sem o 9.
  if (local.length === 9 && local[0] === '9' && /[6-9]/.test(local[1])) {
    return [d, `55${ddd}${local.slice(1)}`];
  }
  // 55 + DDD + 8 dígitos de celular → a grafia atual, com o 9.
  if (local.length === 8 && /[6-9]/.test(local[0])) {
    return [d, `55${ddd}9${local}`];
  }
  return [d];
}
