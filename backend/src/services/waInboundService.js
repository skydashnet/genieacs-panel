import { getDb, tinsertReturningId } from '../config/database.js';
import WaConversation from '../models/WaConversation.js';
import WaMessage from '../models/WaMessage.js';
import WaOptOut from '../models/WaOptOut.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import { EVENTOS } from '../utils/wa/waEventos.js';
import { readMetaError, readQr, readStatus } from '../utils/wa/evolutionApi.js';
import { classificarJid, telefoneDoJid } from '../utils/wa/waJid.js';
import { lerFalhaDeEnvio, lerRecibo } from '../utils/wa/waRecibo.js';
import { pedeSaida } from '../utils/wa/waOptOutTexto.js';
import WaMediaService, { desembrulhar } from './waMediaService.js';
import { resumoSemTexto } from '../utils/wa/waSemTexto.js';
import WaBotService from './waBotService.js';
import WaSatisfactionService from './waSatisfactionService.js';
import WaAssignmentService from './waAssignmentService.js';
import WaConversationService from './waConversationService.js';
import WaDunningService, { pareceComprovante } from './waDunningService.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config/paths.js';

/**
 * Os quatro tratadores do webhook de entrada.
 *
 * TUDO aqui devolve um resultado, nunca um 4xx, quando o evento é reconhecido —
 * inclusive o que ignoramos de propósito. Os dois servidores Evolution reenviam
 * em não-2xx, então recusar uma mensagem de grupo, que nunca vamos querer, viraria
 * o mesmo grupo batendo na porta para sempre.
 *
 * E tudo que chega é hostil por definição: o webhook é público por padrão de
 * navegador, e sua única credencial é um token na URL. Todo campo que vira
 * coluna passa por corte de tamanho aqui, antes do banco — MySQL trunca em
 * silêncio no modo permissivo, Postgres levanta erro, e nenhum dos dois é o
 * comportamento que queremos descobrir em produção.
 */

/** Tetos. Cada um espelha a coluna correspondente em `config/migrations.js`. */
const MAX = Object.freeze({
  // `body` é TEXT, mas um corpo de megabytes num evento forjado não tem uso
  // legítimo: o WhatsApp limita texto a 65.536 e legenda a 1.024.
  body: 8192,
  externalId: 128,
  threadId: 128,
  phone: 24,
  lid: 32,
  pushName: 120,
  // `qr_code` é TEXT e o QR real tem alguns KB; o teto existe só para que um
  // evento forjado não engorde a linha da conta.
  qr: 100_000,
  // Um `messages.upsert` do Baileys pode trazer um lote. Cinquenta cobre
  // qualquer sincronização real e limita o custo de um lote fabricado.
  lote: 50,
  recibos: 200
});

/**
 * Onde cada sabor põe o texto. O `conversation` cru e o `extendedTextMessage`
 * (que é o que chega quando a mensagem tem link, citação ou menção) cobrem a
 * esmagadora maioria; o resto existe para que um clique em botão não vire uma
 * mensagem vazia no painel.
 */
function textoDaMensagem(mensagem, profundidade = 0) {
  if (!mensagem || typeof mensagem !== 'object' || profundidade > 4) return '';
  if (typeof mensagem.conversation === 'string') return mensagem.conversation;
  if (typeof mensagem.extendedTextMessage?.text === 'string') return mensagem.extendedTextMessage.text;

  for (const envelope of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage']) {
    const dentro = mensagem[envelope];
    if (dentro && typeof dentro === 'object' && dentro.message) {
      const achado = textoDaMensagem(dentro.message, profundidade + 1);
      if (achado) return achado;
    }
  }

  for (const no of ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage']) {
    if (typeof mensagem[no]?.caption === 'string') return mensagem[no].caption;
  }
  if (typeof mensagem.buttonsResponseMessage?.selectedDisplayText === 'string') {
    return mensagem.buttonsResponseMessage.selectedDisplayText;
  }
  if (typeof mensagem.templateButtonReplyMessage?.selectedDisplayText === 'string') {
    return mensagem.templateButtonReplyMessage.selectedDisplayText;
  }
  if (typeof mensagem.listResponseMessage?.title === 'string') return mensagem.listResponseMessage.title;
  return '';
}

function cortar(valor, teto) {
  const texto = typeof valor === 'string' ? valor : String(valor ?? '');
  return texto.slice(0, teto);
}

/**
 * A parte que o webhook devolve quando algo dá errado no meio.
 * `skipped` é o único observável desta rota: sem ele, um evento descartado e um
 * evento gravado respondem o mesmo 200 mudo — que foi exatamente como o sistema
 * de origem passou dezesseis dias sem recibo nenhum e ninguém notou.
 */
const pular = (motivo) => ({ handled: false, skipped: motivo });

// ────────────────────────────────────────────────────────────────────
// qrcode_updated
// ────────────────────────────────────────────────────────────────────

async function tratarQr(account, body) {
  const { qr } = readQr(body?.data ?? body);
  if (!qr) return pular('no_qr');
  await WhatsAppAccount.update(account.id, {
    qr_code: cortar(qr, MAX.qr),
    qr_updated_at: new Date(),
    // Ter QR na tela é, por definição, estar no meio do pareamento. Uma
    // instância `pending` que começou a emitir QR já saiu do lugar.
    status: 'connecting'
  });
  return { handled: true };
}

// ────────────────────────────────────────────────────────────────────
// connection_update
// ────────────────────────────────────────────────────────────────────

/**
 * O GO quebra "conexão" em cinco eventos e às vezes manda o `data` vazio —
 * `canonicalizarEvento` colapsa os cinco num nome só, e nesse caso o estado só
 * existe no nome cru. Ler o `data` primeiro e cair para o nome é o que evita
 * um `Connected` de corpo vazio ser lido como `disconnected` por
 * `readStatus('go', {})`, que é o padrão dele.
 */
const ESTADO_POR_NOME = Object.freeze({
  connected: 'connected',
  pairsuccess: 'connected',
  connecting: 'connecting',
  loggedout: 'disconnected',
  disconnected: 'disconnected',
  connectfailure: 'disconnected',
  temporaryban: 'disconnected'
});

function estadoDaConexao(flavor, body) {
  const data = body?.data && typeof body.data === 'object' ? body.data : {};
  const carregaEstado = flavor === 'go'
    ? ['Connected', 'connected', 'LoggedIn', 'loggedIn'].some((k) => k in data)
    : true;
  const lido = carregaEstado ? readStatus(flavor, data) : null;
  if (lido) return lido;
  const cru = String(body?.event ?? body?.Event ?? '').toLowerCase().replace(/[.\s_-]/g, '');
  return ESTADO_POR_NOME[cru] ?? null;
}

/**
 * O número pareado, quando o evento o carrega. Cada servidor o chama de um
 * jeito, e a maioria dos `connection_update` não o traz de jeito nenhum — daí
 * a lista, e daí não ser erro não achar.
 */
function telefonePareado(body) {
  const data = body?.data && typeof body.data === 'object' ? body.data : {};
  const instancia = data.instance && typeof data.instance === 'object' ? data.instance : {};
  const candidatos = [
    data.jid, data.JID, data.wuid, data.owner, data.ownerJid,
    data.me?.id, data.me?.jid, instancia.owner, instancia.ownerJid, instancia.wuid
  ];
  for (const cru of candidatos) {
    if (typeof cru !== 'string' || !cru) continue;
    const fone = telefoneDoJid(cru);
    if (fone && fone.length <= MAX.phone) return fone;
  }
  return '';
}

async function tratarConexao(account, body) {
  const status = estadoDaConexao(account.flavor, body);
  const fone = telefonePareado(body);
  if (!status && !fone) return pular('no_state');

  const patch = {};
  if (status) patch.status = status;
  if (fone) patch.phone_e164 = fone;
  if (status === 'connected') {
    patch.last_seen_at = new Date();
    // O QR de uma sessão já pareada não abre mais nada. Deixá-lo na linha faria
    // a tela oferecer um código morto para ler.
    patch.qr_code = null;
    patch.qr_updated_at = null;
    patch.last_error = null;
  }
  await WhatsAppAccount.update(account.id, patch);
  return { handled: true, status: status ?? account.status };
}

// ────────────────────────────────────────────────────────────────────
// messages_upsert
// ────────────────────────────────────────────────────────────────────

/**
 * Telefone e LID do contato — os dois podem existir, e nenhum é garantido.
 *
 * A ARMADILHA, e a razão de `fromMe` entrar aqui: numa mensagem que o PROVEDOR
 * mandou, `key.senderPn` e `Info.SenderAlt` são o número DELE, não o do
 * cliente. Lê-los sem olhar o `fromMe` grava o telefone do provedor como
 * identidade da conversa do cliente, e a partir daí toda cobrança daquele fio
 * sai para o próprio provedor.
 */
function identidades({ enderecoCru, chave, info, fromMe }) {
  const candidatos = [enderecoCru, chave.remoteJidAlt, info.ChatAlt];
  if (!fromMe) candidatos.push(chave.senderPn, info.SenderAlt);

  let waPhone = '';
  let waLid = '';
  for (const cru of candidatos) {
    if (typeof cru !== 'string' || !cru.trim()) continue;
    const classe = classificarJid(cru);
    if (!classe.valor) continue;
    if (classe.tipo === 'phone' && !waPhone && classe.valor.length <= MAX.phone) waPhone = classe.valor;
    if (classe.tipo === 'lid' && !waLid && classe.valor.length <= MAX.lid) waLid = classe.valor;
  }
  return { waPhone, waLid };
}

/**
 * O pushName só é nome quando é nome.
 *
 * O Evolution GO manda o próprio identificador nesse campo quando o contato não
 * tem nome público. Gravá-lo põe quinze dígitos onde vai o nome do cliente — foi
 * assim que a lista de conversas do sistema de origem virou uma coluna de
 * números em 16 das 50 linhas.
 */
function nomeExibido(bruto, waPhone, waLid) {
  const nome = cortar(String(bruto ?? '').trim(), MAX.pushName);
  if (!nome) return '';
  const digitos = nome.replace(/\D/g, '');
  if (digitos && (digitos === waPhone || digitos === waLid)) return '';
  return nome;
}

async function gravarMensagem(account, item) {
  const dados = item && typeof item === 'object' ? item : {};
  const chave = dados.key && typeof dados.key === 'object' ? dados.key : {};
  const info = dados.Info && typeof dados.Info === 'object' ? dados.Info : {};
  const fromMe = chave.fromMe === true || info.IsFromMe === true;

  // 1. O endereço, e o que fazemos com o que ele não é.
  if (info.IsGroup === true) return pular('group');
  const enderecoCru = typeof chave.remoteJid === 'string' ? chave.remoteJid : (typeof info.Chat === 'string' ? info.Chat : '');
  const endereco = classificarJid(enderecoCru);
  if (endereco.tipo === 'grupo') return pular('group');
  if (endereco.tipo === 'broadcast') return pular('broadcast');
  // Domínio novo: melhor perder a mensagem do que gravar a parte local como se
  // fosse telefone, que é o defeito que `waJid.js` existe para não repetir.
  if (endereco.tipo === 'desconhecido') return pular('unknown_domain');
  if (!endereco.valor || endereco.valor.length > MAX.lid) return pular('no_address');

  // 2. As duas identidades possíveis.
  const { waPhone, waLid } = identidades({ enderecoCru, chave, info, fromMe });
  if (!waPhone && !waLid) return pular('no_identity');

  const externalId = cortar(String(chave.id ?? info.ID ?? '').trim(), MAX.externalId + 1);
  if (!externalId) return pular('no_external_id');
  // Truncar um id externo casaria duas mensagens diferentes na mesma linha, o
  // que é pior que perder uma. Nenhum dos dois servidores emite id tão longo.
  if (externalId.length > MAX.externalId) return pular('external_id_too_long');

  // O fio é identificado pela forma canônica, não pelo JID cru: uma sessão de
  // WhatsApp Web acrescenta sufixo de device (`:22`) e abriria uma segunda
  // conversa com a mesma pessoa.
  const threadId = cortar(`${endereco.valor}@${endereco.dominio || 's.whatsapp.net'}`, MAX.threadId);

  // Redelivery é rotina nos dois servidores. Sair aqui evita baixar o mesmo
  // anexo de novo; a corrida que escapar é pega pelo índice único, abaixo.
  if (await WaMessage.getByExternalId(externalId)) return { handled: true, duplicate: true };

  // 3. e 4. A conversa.
  const mensagem = dados.message ?? dados.Message ?? null;
  const pushName = nomeExibido(dados.pushName ?? info.PushName, waPhone, waLid);
  const conversation = await WaConversation.ensure({
    accountId: account.id,
    externalThreadId: threadId,
    waPhone,
    waLid,
    pushName
  });

  const texto = cortar(textoDaMensagem(mensagem), MAX.body);

  // 5a. O eco de uma mensagem que saiu DAQUI adota a linha que já existe.
  //
  // Antes do anexo de propósito: o eco de uma mídia que o painel mandou traria
  // os mesmos bytes de volta, e baixá-los seria uma segunda cópia no disco de
  // um arquivo que já está lá, apontado pela linha que estamos adotando.
  if (fromMe) {
    const adotada = await WaMessage.adoptEcho({
      conversationId: conversation.id,
      body: texto || null,
      externalId
    });
    if (adotada) return { handled: true, adopted: true, messageId: adotada };
  }

  // 6. O anexo. Nunca levanta: sem bytes a mensagem entra sem anexo.
  const anexo = await WaMediaService.armazenar({
    account,
    conversationId: conversation.id,
    externalId,
    dados,
    mensagem
  });

  // 5. A linha.
  const agora = new Date();
  const linha = {
    conversation_id: conversation.id,
    direction: fromMe ? 'out' : 'in',
    external_id: externalId,
    // Sem texto e sem anexo: reação, localização, contato, enquete ou uma
    // mídia que não deu para baixar. O balão diz o que foi, em vez de "Anexo".
    // Só o balão: bot, opt-out e pesquisa continuam lendo `texto`.
    body: texto || (anexo ? null : resumoSemTexto(desembrulhar(mensagem)) || null),
    is_note: false,
    // Uma mensagem que já saiu do celular do provedor está, no mínimo, enviada.
    // `applyReceipt` nunca anda para trás, então o ✓✓ que vier depois manda.
    delivery_status: fromMe ? 'sent' : null,
    // A hora é a da CHEGADA, não a `messageTimestamp` do evento. Um servidor que
    // reconecta despeja o histórico com carimbo antigo; ordenar por ele enterra
    // a mensagem nova no meio da conversa, onde ninguém a vê.
    created_at: agora,
    updated_at: agora,
    ...(anexo ?? {})
  };

  let messageId;
  try {

    // `tinsertReturningId`, nunca `insertReturningId`: `wa_messages` é tabela
    // escopada, e só a variante com `t` carimba o `tenant_id` da linha. A crua
    // deixa a coluna cair no DEFAULT que a migração 0012 pôs — o provedor #1 —
    // e o escopo aberto pelo webhook é simplesmente ignorado. Com um provedor
    // só as duas se comportam igual, que é por que isto passou despercebido:
    // com dois, TODA mensagem que chega no Evolution do provedor B é arquivada
    // no provedor A, aparece na caixa de entrada dele e some da do B.
    messageId = await tinsertReturningId('wa_messages', linha);
  } catch (error) {
    // O índice único de `external_id` É a deduplicação. Uma violação aqui
    // significa que o evento chegou duas vezes — que é sucesso, não falha:
    // devolver erro faria o servidor reenviar o mesmo evento em laço.
    if (await WaMessage.getByExternalId(externalId)) {
      // O evento chegou duas vezes. Os bytes desta passagem não têm linha que
      // os aponte — a primeira já gravou os dela —, então saem daqui.
      await descartarAnexoOrfao(anexo);
      return { handled: true, duplicate: true };
    }
    // Qualquer outro erro: a linha não existe e o arquivo também não deve
    // existir. Ele foi escrito ANTES do insert porque o caminho dele é uma
    // coluna da linha, e essa ordem deixava bytes sem dono no caminho de erro.
    // Não eram poucos para sempre: o varredor de mídia só apaga o que está
    // ligado a uma linha, e a retenção padrão é 0 — nunca apaga —, então numa
    // instalação padrão esses arquivos ficavam no disco para sempre.
    await descartarAnexoOrfao(anexo);
    throw error;
  }

  // 7. O pedido de saída, SÓ na entrada.
  // Um eco de saída com "sair" é o operador digitando no próprio celular; tratá-lo
  // como opt-out descadastraria o cliente por uma palavra que o provedor escreveu.
  if (!fromMe && pedeSaida(texto)) {
    await WaOptOut.record({
      waPhone,
      waLid,
      conversationId: conversation.id,
      origin: 'customer',
      reasonText: texto
    });
  }

  // 7b. A resposta da pesquisa de satisfação, numa conversa encerrada. Uma
  // nota não reabre o fio nem cai no bot; outro assunto segue o fluxo normal.
  const pesquisa = !fromMe && conversation.closed_at
    ? await WaSatisfactionService.captureReply({ conversation, text: texto })
    : null;
  const soPesquisa = pesquisa?.consumed === true && pesquisa.reopen === false;

  // 8. O topo da lista de conversas.
  const patch = { last_message_at: agora };
  // Gente dos dois lados: o cliente escreveu, ou o provedor respondeu pelo
  // próprio celular (o eco `fromMe`). Qualquer um dos dois tira a conversa de
  // "Sem resposta" e a põe em "Abertas".
  if (!conversation.engaged_at) patch.engaged_at = agora;
  if (!fromMe) {
    patch.last_inbound_at = agora;
    // Quem escreveu de novo reabre o próprio fio. Encerrar é arquivar, e um
    // arquivo não responde ninguém: sem isto, o cliente que volta a falar cai
    // fora da lista padrão do operador e vira invisível — que é exatamente o
    // contrário do que a lista existe para fazer. Só na ENTRADA: um eco de
    // saída é o operador digitando, e não é notícia do cliente.
    if (conversation.closed_at && !soPesquisa) patch.closed_at = null;
    // Incremento no banco, não `lido + 1` em memória: dois eventos do mesmo
    // contato chegam concorrentes e um leria o contador antes do outro escrever.
    if (!soPesquisa) patch.unread_count = getDb().raw('unread_count + 1');
  }
  await WaConversation.update(conversation.id, patch);

  // 8b. Quem é o assinante do outro lado.
  //
  // Aqui, e não só dentro do bot: o vínculo era feito apenas quando o bot
  // chegava a responder, então um provedor com o autoatendimento desligado — ou
  // um fio com operador presente — nunca via o contrato ao lado da conversa, e
  // a caixa inteira dizia "número não vinculado". `bindSubscriber` escreve uma
  // vez e nunca sobrescreve o vínculo que um operador corrigiu à mão.
  //
  // Só na entrada, e sem deixar uma falha virar 500: o evento já está gravado,
  // e um erro aqui faria o servidor reenviá-lo para sempre.
  if (!fromMe && !conversation.contract) {
    try {
      await WaConversationService.bindSubscriber(conversation);
    } catch (error) {
      console.error('waInbound bindSubscriber:', error?.message || error);
    }
  }

  // 8c. Imagem ou PDF do cliente numa conversa com contrato: pode ser o
  // comprovante. A régua para esse contrato por uns dias, e a conversa ganha
  // nota e etiqueta para alguém conferir no SGP. Nunca lança.
  if (!fromMe && pareceComprovante(anexo?.attachment_type)) {
    const atual = conversation.contract ? conversation : await WaConversation.getById(conversation.id);
    await WaDunningService.pauseForReceipt({ conversation: atual, messageId, mime: anexo.attachment_type });
  }

  // 9. O bot de autoatendimento.
  // Depois de gravar e depois do opt-out, de propósito: o bot decide sobre uma
  // mensagem que já existe, e uma que pediu saída ele não responde. Não protege
  // com try: `responder` engole tudo por contrato (ver `waBotService.js`), e
  // tem que engolir — uma falha dele virando 500 aqui faria o servidor reenviar
  // este evento para sempre.
  let resultadoDoBot = null;
  if (!pesquisa?.consumed) {
    resultadoDoBot = await WaBotService.responder({
      conversation,
      messageId,
      body: texto,
      direction: linha.direction
    });
  }

  // 10. A distribuição: a conversa que precisa de gente ganha um atendente
  // (ou entra na fila). Só na entrada, e nunca por uma nota da pesquisa.
  if (!fromMe && !soPesquisa) {
    await WaAssignmentService.afterInbound({ conversation, botResult: resultadoDoBot });
  }

  return { handled: true, conversationId: conversation.id, direction: linha.direction };
}

/**
 * Quanto tempo o lote inteiro pode levar.
 *
 * O teto de CINQUENTA itens limita o tamanho, não o tempo — são coisas
 * diferentes e cada uma precisa do seu limite, exatamente como `ssrfGuard` já
 * diz sobre o prazo de um salto contra o teto de bytes.
 *
 * Cada item pode baixar mídia: `safeFetch` com 90 s, e se ele falhar ainda há
 * uma segunda tentativa pelo servidor, com 15 s. Cinquenta itens em série, no
 * pior caso, são cerca de 87 minutos com o handler do Express preso. E
 * `waWebhookLimiter` conta CHEGADAS, não requisições simultâneas: nada limitava
 * quantos handlers ficavam presos ao mesmo tempo.
 *
 * O desfecho é pior que lento. O Evolution estoura o prazo dele, lê a não
 * resposta como falha e REENTREGA o mesmo lote — multiplicando os handlers
 * presos até acabarem os sockets. Um storage lento do outro lado, ou um payload
 * forjado com cinquenta mídias apontando para um host que arrasta, chegam lá.
 *
 * Dois minutos é folgado para um lote honesto — a sincronização real do Baileys
 * traz texto, e mídia é a exceção — e curto o bastante para a reentrega do
 * Evolution encontrar o handler livre em vez de somar outro.
 */
const ORCAMENTO_LOTE_MS = 120_000;

/**
 * Apaga os bytes de um anexo que não chegou a ter linha.
 *
 * Nunca lança e nunca altera o desfecho de quem chama: isto é limpeza pendurada
 * num caminho que já deu errado, e uma falha aqui não pode virar o motivo de um
 * 500 — nem esconder o erro de verdade que está subindo.
 */
async function descartarAnexoOrfao(anexo) {
  const relativo = anexo?.attachment_path;
  if (!relativo) return;
  try {
    await fs.unlink(path.join(DATA_DIR, relativo));
  } catch (error) {
    // ENOENT é o caso comum e não é problema: significa que não havia nada.
    if (error?.code !== 'ENOENT') {
      console.warn(`[wa] anexo órfão ficou no disco (${relativo}): ${error.message}`);
    }
  }
}

async function tratarMensagens(account, body) {
  const data = body?.data;
  // O v2 manda um objeto; algumas versões mandam o lote do Baileys.
  let itens;
  if (Array.isArray(data)) itens = data;
  else if (Array.isArray(data?.messages)) itens = data.messages;
  else if (data && typeof data === 'object') itens = [data];
  else return pular('no_data');

  itens = itens.slice(0, MAX.lote);
  if (itens.length === 1) return gravarMensagem(account, itens[0]);

  let gravadas = 0;
  let abandonados = 0;
  const pulados = [];
  const prazo = Date.now() + ORCAMENTO_LOTE_MS;
  for (const item of itens) {
    // O orçamento é conferido ANTES de cada item, não durante: interromper uma
    // gravação pela metade deixaria arquivo sem linha. Parar na borda entre
    // dois itens é o único ponto em que abandonar não custa nada.
    if (Date.now() >= prazo) {
      abandonados = itens.length - (gravadas + pulados.length);
      console.warn(
        `[wa] lote de ${itens.length} passou de ${ORCAMENTO_LOTE_MS}ms; `
        + `${abandonados} item(ns) não processado(s)`
      );
      break;
    }
    // Sequencial de propósito: `WaConversation.ensure` é um get-or-create sem
    // transação, e um lote do mesmo contato em paralelo criaria duas conversas.
    // eslint-disable-next-line no-await-in-loop
    const r = await gravarMensagem(account, item);
    if (r.handled) gravadas += 1;
    else pulados.push(r.skipped);
  }
  return {
    handled: gravadas > 0,
    stored: gravadas,
    skipped: pulados.length ? pulados.join(',') : undefined,
    // Sai no corpo da resposta porque é a única observabilidade deste caminho:
    // sem isto, um lote cortado pela metade e um lote inteiro respondem igual.
    ...(abandonados > 0 ? { dropped: abandonados } : {})
  };
}

// ────────────────────────────────────────────────────────────────────
// messages_update
// ────────────────────────────────────────────────────────────────────

async function tratarRecibo(account, body) {
  const falha = lerFalhaDeEnvio(body);
  if (falha) {
    const ids = falha.ids
      .filter((id) => typeof id === 'string' && id && id.length <= MAX.externalId)
      .slice(0, MAX.recibos);
    if (!ids.length) return pular('no_receipt');
    const janela = readMetaError(falha.errorText).windowClosed;
    const motivo = janela ? 'meta_window_closed' : `meta_failed ${falha.errorText}`.trim();
    const atualizadas = await WaMessage.markFailedByExternalId(ids, motivo);
    return { handled: true, status: 'failed', updated: atualizadas };
  }
  const recibo = lerRecibo(body);
  // `null` é legítimo: um `messages.update` de edição de texto não carrega
  // estado nenhum. Não é o mesmo que formato desconhecido, mas os dois viram um
  // 200 — o que os separa é o `skipped` no corpo da resposta.
  if (!recibo) return pular('no_receipt');

  const ids = recibo.ids
    .filter((id) => typeof id === 'string' && id && id.length <= MAX.externalId)
    .slice(0, MAX.recibos);
  if (!ids.length) return pular('no_receipt');

  const atualizadas = await WaMessage.applyReceipt(ids, recibo.status);
  return { handled: true, status: recibo.status, updated: atualizadas };
}

// ────────────────────────────────────────────────────────────────────

class WaInboundService {
  /**
   * Despacha um evento já autenticado e já canonicalizado.
   *
   * @param {object} account linha de `whatsapp_accounts`
   * @param {string} evento nome canônico de `utils/wa/waEventos.js`
   * @param {object} body corpo cru do webhook
   * @returns {Promise<{handled: boolean, skipped?: string}>}
   */
  static async handle(account, evento, body) {
    // Mensagem ou recibo chegando por um número é prova de sessão viva. Um
    // número preso em "conectando" (o aviso de reconexão se perdeu) volta a
    // "conectado" aqui — sem isso o painel recusava responder um cliente que
    // acabara de escrever. "Desconectado" não sobe por este caminho: um evento
    // atrasado não pode desfazer um logout; o envio confere ao vivo.
    if ((evento === EVENTOS.MENSAGEM || evento === EVENTOS.RECIBO) && account.status === 'connecting' && !account.qr_code) {
      try {
        await WhatsAppAccount.update(account.id, { status: 'connected', last_seen_at: new Date(), last_error: null });
      } catch (error) {
        console.warn(`[wa] could not mark account ${account.id} connected: ${error?.message || error}`);
      }
    }
    switch (evento) {
      case EVENTOS.QR: return tratarQr(account, body);
      case EVENTOS.CONEXAO: return tratarConexao(account, body);
      case EVENTOS.MENSAGEM: return tratarMensagens(account, body);
      case EVENTOS.RECIBO: return tratarRecibo(account, body);
      // Um evento que não conhecemos ainda é 200 com motivo. Os dois servidores
      // publicam eventos que não assinamos, e recusá-los os traria de volta.
      default: return pular('unsupported_event');
    }
  }
}

export { textoDaMensagem, nomeExibido, identidades, estadoDaConexao, telefonePareado };
export default WaInboundService;
