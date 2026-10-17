/**
 * Leitura do recibo de entrega (os ✓✓) — TRÊS formatos, porque são três
 * servidores diferentes com o mesmo nome.
 *
 * O DEFEITO QUE ISTO CORRIGE
 * --------------------------
 * No sistema de origem, a troca do Evolution GO pelo Evolution API v2 matou os
 * recibos no MESMO dia. Medido no banco, mensagens que a loja mandou:
 *
 *     11/08     576 saídas    512 com recibo   (89%)
 *     12/08     610 saídas    546 com recibo   (89%)   <- último dia normal
 *     13/08      17 saídas      1 com recibo
 *     28/08   2.366 saídas      0 com recibo   ( 0%)
 *
 * Ficou DEZESSEIS DIAS assim sem ninguém notar, e o silêncio não foi acidente:
 * sem recibo a mensagem renderiza "✓ Enviada", que é o mesmo desenho de uma
 * mensagem que acabou de sair. A falha não tem aparência.
 *
 * A causa, medida e não suposta: o webhook continuou vivo (2.859 requisições em
 * 23 h, todas HTTP 200, zero 401) — o `MESSAGES_UPDATE` chegava e nós é que o
 * jogávamos fora. O ramo do recibo procurava o id em `data.key.id` e o estado em
 * `data.update.status`. O v2 manda PLANO, e não existe `data.key` ali:
 *
 *     { "event": "messages.update",
 *       "data": { "messageId": "cm9m2q06m2pakoe4rcgdmwe42",
 *                 "keyId": "CE34AD105D61A07CAEBB49DE65BAC9C4",
 *                 "status": "DELIVERY_ACK" } }
 *
 * `keyId` é o mesmo identificador que `MESSAGES_UPSERT` entrega em `key.id` e
 * que gravamos em `wa_messages.external_id`. `messageId` é o id interno do banco
 * do Evolution e NÃO serve para casar.
 *
 * POR QUE OS TRÊS FORMATOS, E NÃO SÓ O ATUAL
 * ------------------------------------------
 * Trocar uma premissa por outra seria repetir o erro. Ler os três custa três
 * `??` e elimina a próxima migração silenciosa.
 *
 *   servidor              id da mensagem      estado
 *   --------------------  ------------------  --------------------------
 *   Evolution API v2      data.keyId          data.status
 *   Evolution API v1      data.key.id         data.update.status
 *   Evolution GO          data.MessageIDs[]   body.state
 *
 * Um Receipt do GO cobre VÁRIAS mensagens de uma vez; os outros dois, uma.
 *
 * Portado de compra-venda `supabase/functions/_shared/wa-recibo.ts`.
 */

/**
 * Os ids que o evento carimba, nos três formatos.
 *
 * A ordem importa: o GO é testado primeiro porque `MessageIDs` é um array e os
 * outros dois são escalares, então não há como confundi-los. Entre v2 e v1 não
 * há ambiguidade — um tem `keyId`, o outro tem `key.id`.
 */
function idsDoEvento(data) {
  const lote = data?.MessageIDs;
  if (Array.isArray(lote) && lote.length) {
    return lote.map((v) => String(v)).filter(Boolean);
  }
  const unico = data?.keyId ?? data?.key?.id;
  return unico ? [String(unico)] : [];
}

/**
 * Traduz o estado bruto para o vocabulário de `wa_messages.delivery_status`.
 *
 * `'ReadSelf'` fica de fora DE PROPÓSITO: é o operador lendo no próprio
 * celular. Diz respeito a ele, não à entrega ao cliente — marcar como 'read'
 * poria o ✓✓ azul numa mensagem que o cliente nunca abriu, o que é mentir no
 * painel.
 *
 * Os números são do Baileys (`proto.WebMessageInfo.Status`): 2 = SERVER_ACK,
 * 3 = DELIVERY_ACK, 4 = READ. O v2 manda ora o nome, ora o número.
 */
function estadoDoEvento(bruto) {
  // A integração WHATSAPP-BUSINESS (API oficial) repassa os estados da Meta:
  // `sent`, `delivered`, `read`, em maiúsculas ou não.
  const texto = typeof bruto === 'string' ? bruto.toUpperCase() : bruto;
  if (texto === 'READ' || bruto === 4) return 'read';
  if (texto === 'DELIVERY_ACK' || bruto === 3 || texto === 'DELIVERED') return 'delivered';
  if (texto === 'SERVER_ACK' || bruto === 2 || texto === 'SENT') return 'sent';
  return null;
}

/**
 * A Meta recusando DEPOIS de aceitar: o envio volta 200 com id e, segundos
 * depois, o estado chega como `failed` — o caso clássico é a janela de 24 h
 * (131047). Sem ler isto, a mensagem fica "✓ Enviada" para sempre.
 *
 * @returns {{ ids: string[], errorText: string }|null}
 */
export function lerFalhaDeEnvio(body) {
  const env = body ?? {};
  const data = env.data ?? {};
  const ids = idsDoEvento(data);
  if (!ids.length) return null;
  const bruto = String(data?.update?.status ?? data?.status ?? env.state ?? '').toUpperCase();
  if (bruto !== 'FAILED' && bruto !== 'ERROR') return null;
  const erros = data.errors ?? data.error ?? data?.update?.errors ?? null;
  let errorText = '';
  if (erros) errorText = typeof erros === 'string' ? erros : JSON.stringify(erros);
  return { ids, errorText: errorText.slice(0, 300) };
}

/**
 * Lê um evento de atualização de mensagem e devolve o recibo, ou `null` quando
 * não há o que carimbar.
 *
 * `null` cobre o caso legítimo (um `messages.update` de edição de texto não traz
 * estado nenhum) e o caso de formato desconhecido. Quem chama decide o que
 * fazer — mas no sistema de origem os dois viravam o mesmo 200 mudo, e é essa
 * indistinção que deixou a falha invisível por dezesseis dias.
 *
 * @returns {{ ids: string[], status: 'sent'|'delivered'|'read' }|null}
 */
export function lerRecibo(body) {
  const env = body ?? {};
  const data = env.data ?? {};
  const ids = idsDoEvento(data);
  if (!ids.length) return null;

  // v1 aninha em `update`; v2 põe no topo do `data`; o GO põe no topo do
  // ENVELOPE, fora do `data`.
  const bruto = data?.update?.status ?? data?.status ?? env.state;
  const status = estadoDoEvento(bruto);
  return status ? { ids, status } : null;
}
