/**
 * O que mostrar no balão de uma mensagem que chegou sem texto e sem anexo.
 *
 * Sem isto o painel desenhava só "Anexo", e o atendente não tinha como saber
 * se o cliente reagiu com um 👍, mandou a localização, um contato ou uma foto
 * que não deu para baixar. Puro: recebe a mensagem já desembrulhada (sem
 * `ephemeralMessage` e afins) e devolve o texto, ou '' quando não reconhece.
 */

const TIPO_MIDIA = {
  imageMessage: '📷 Foto',
  videoMessage: '🎥 Vídeo',
  ptvMessage: '🎥 Vídeo',
  audioMessage: '🎤 Áudio',
  pttMessage: '🎤 Áudio',
  documentMessage: '📄 Documento',
  stickerMessage: '🏷️ Figurinha'
};

const texto = (valor) => (typeof valor === 'string' ? valor.trim() : '');

/** Os telefones de um vCard (`TEL;...:+55 93 9...`), sem repetição. */
function telefonesDoVcard(vcard) {
  const achados = [];
  for (const linha of String(vcard || '').split(/\r?\n/)) {
    const m = linha.match(/^(?:item\d+\.)?TEL[^:]*:(.+)$/i);
    if (m && texto(m[1]) && !achados.includes(texto(m[1]))) achados.push(texto(m[1]));
  }
  return achados;
}

function contato(no) {
  const nome = texto(no?.displayName) || 'sem nome';
  const telefones = telefonesDoVcard(no?.vcard);
  return telefones.length ? `${nome} — ${telefones.join(', ')}` : nome;
}

function localizacao(no) {
  const lat = Number(no?.degreesLatitude);
  const lng = Number(no?.degreesLongitude);
  const nome = [texto(no?.name), texto(no?.address)].filter(Boolean).join(' — ');
  const link = Number.isFinite(lat) && Number.isFinite(lng)
    ? `https://www.google.com/maps?q=${lat},${lng}`
    : '';
  return ['📍 Localização', nome, link].filter(Boolean).join('\n');
}

/**
 * @param {object|null} mensagem a mensagem já desembrulhada
 */
export function resumoSemTexto(mensagem) {
  if (!mensagem || typeof mensagem !== 'object') return '';

  const reacao = mensagem.reactionMessage;
  if (reacao && typeof reacao === 'object') {
    const emoji = texto(reacao.text);
    return emoji ? `Reagiu com ${emoji} a uma mensagem` : 'Removeu a reação a uma mensagem';
  }

  const local = mensagem.locationMessage || mensagem.liveLocationMessage;
  if (local && typeof local === 'object') return localizacao(local);

  if (mensagem.contactMessage && typeof mensagem.contactMessage === 'object') {
    return `👤 Contato: ${contato(mensagem.contactMessage)}`;
  }
  const lista = mensagem.contactsArrayMessage?.contacts;
  if (Array.isArray(lista) && lista.length) {
    return `👤 Contatos:\n${lista.slice(0, 10).map(contato).join('\n')}`;
  }

  const enquete = mensagem.pollCreationMessage || mensagem.pollCreationMessageV2 || mensagem.pollCreationMessageV3;
  if (enquete && typeof enquete === 'object') {
    const opcoes = Array.isArray(enquete.options) ? enquete.options.map((o) => texto(o?.optionName)).filter(Boolean) : [];
    return [`📊 Enquete: ${texto(enquete.name) || 'sem título'}`, ...opcoes.map((o) => `• ${o}`)].join('\n');
  }
  if (mensagem.pollUpdateMessage) return '📊 Votou numa enquete';

  // Era mídia, mas os bytes não chegaram (o servidor não entregou, o arquivo
  // expirou): o atendente fica sabendo o que era e que precisa pedir de novo.
  for (const [no, rotulo] of Object.entries(TIPO_MIDIA)) {
    if (mensagem[no] && typeof mensagem[no] === 'object') {
      const nome = texto(mensagem[no].fileName);
      return `${rotulo}${nome ? ` (${nome})` : ''} — não foi possível baixar o arquivo. Peça ao cliente para enviar de novo.`;
    }
  }
  return '';
}
