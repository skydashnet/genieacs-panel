/**
 * Classificação de JID do WhatsApp — o domínio é o único critério confiável.
 *
 * O WhatsApp passou a endereçar contatos por LID (`@lid`), um identificador de
 * privacidade que substitui o número: `140076734488739@lid`. Ele NÃO é
 * telefone. Só o WhatsApp resolve um LID para uma pessoa; para nós é uma chave
 * opaca.
 *
 * O que quebrou no sistema de origem: o webhook cortava tudo depois do '@' e
 * chamava o resto de telefone. Um LID virava "telefone" 140076734488739, ia
 * para o cadastro do cliente e — porque o upsert cai para o telefone quando não
 * há pushName — virava o NOME do cliente. A lista de conversas passou a mostrar
 * 15 dígitos no lugar do nome em 16 das 50 conversas.
 *
 * POR QUE O TAMANHO NÃO SERVE DE CRITÉRIO
 * ---------------------------------------
 * A tentação é filtrar por comprimento: "telefone brasileiro tem 12 ou 13
 * dígitos, LID tem 14 ou 15". Não funciona, e falha para os dois lados:
 *
 *   • E.164 permite até 15 dígitos. Um número internacional legítimo de 15
 *     dígitos seria descartado como LID.
 *   • O bug de sufixo de device (abaixo) já produziu `55938110449922` — 14
 *     dígitos, telefone real deformado, não LID.
 *
 * O domínio, esse sim, é declarado pelo próprio WhatsApp e não é ambíguo.
 *
 * A LIMPEZA DA PARTE LOCAL
 * ------------------------
 * A parte antes do '@' não é só o número: um JID de device vinculado tem a
 * forma `user:device` — e `user.agent:device` quando há agent (whatsmeow,
 * types/jid.go: JID.String()). Uma sessão de WhatsApp Web é sempre um device
 * companheiro, então Device > 0 SEMPRE nesse caminho.
 *
 * Tirar apenas os não-dígitos gruda o sufixo no número: `559381104499:22`
 * virava `55938110449922`, um telefone que não existe.
 *
 * Portado de compra-venda `supabase/functions/_shared/wa-jid.ts`.
 */

/** @typedef {'phone'|'lid'|'grupo'|'broadcast'|'desconhecido'} TipoEndereco */

/**
 * @param {string|null|undefined} jid
 * @returns {{ tipo: TipoEndereco, valor: string, dominio: string }}
 *   `valor` são os dígitos da parte local, já sem sufixo de device;
 *   `dominio` é o domínio cru do JID em minúsculas, vazio quando não há '@'.
 */
export function classificarJid(jid) {
  const cru = String(jid || '').trim();
  const arroba = cru.lastIndexOf('@');
  const dominio = arroba >= 0 ? cru.slice(arroba + 1).toLowerCase() : '';
  const local = arroba >= 0 ? cru.slice(0, arroba) : cru;
  const valor = local.split(':')[0].split('.')[0].replace(/\D/g, '');

  // Domínio vazio conta como telefone DE PROPÓSITO: é o formato de
  // `data.jid`/`wuid` do connection_update e de parte do payload do v2, que
  // mandam o número sem sufixo nenhum. O preço é que um LID cru, sem domínio,
  // seria lido como telefone — mas nunca vimos LID chegar assim, e tratar "sem
  // domínio" como desconhecido derrubaria caminhos que hoje funcionam.
  if (dominio === '' || dominio === 's.whatsapp.net' || dominio === 'c.us') {
    return { tipo: 'phone', valor, dominio };
  }
  if (dominio === 'lid') return { tipo: 'lid', valor, dominio };
  if (dominio === 'g.us') return { tipo: 'grupo', valor, dominio };
  if (dominio === 'broadcast' || dominio.endsWith('.broadcast')) {
    return { tipo: 'broadcast', valor, dominio };
  }
  // Domínio que ainda não conhecemos: melhor ignorar a mensagem do que gravar a
  // parte local como se fosse um número de telefone.
  return { tipo: 'desconhecido', valor, dominio };
}

/** Dígitos de um JID de telefone. Vazio para qualquer outro tipo de endereço. */
export function telefoneDoJid(jid) {
  const end = classificarJid(jid);
  return end.tipo === 'phone' ? end.valor : '';
}
