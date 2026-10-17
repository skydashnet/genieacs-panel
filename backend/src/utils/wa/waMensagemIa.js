/**
 * Pedir à IA para melhorar um texto do bot (saudação, pedido de CPF, pesquisa
 * de satisfação…). Só funções puras: o prompt que sai e o texto limpo que volta.
 * O laço com o provedor fica em `WaAiService.improveMessage`.
 */

export const MENSAGEM_MAX = 1000;

/** Quando cada texto é enviado: é o que a IA precisa saber para não mudar o papel dele. */
const CONTEXTO = Object.freeze({
  greeting: 'Abre o menu. Logo depois dela o sistema lista as opções numeradas (fatura, sinal, atendente). Termine convidando o cliente a responder com o número.',
  askDocument: 'Pede o CPF ou CNPJ do titular do contrato quando o número do WhatsApp não está no cadastro. Peça só os números.',
  notRecognised: 'Avisa que não foi encontrado contrato para o número do cliente e que um atendente responde em instantes.',
  noOpenInvoice: 'Resposta a quem pediu a fatura e não tem nenhuma em aberto.',
  handoffQueued: 'Resposta a quem pediu um atendente: alguém responde em breve, e escrever "menu" volta ao menu.',
  handoff: 'Enviada quando o robô não consegue resolver e passa a conversa para um atendente.',
  outsideHours: 'Enviada fora do horário de atendimento: a mensagem ficou registrada e um atendente responde no próximo expediente.',
  surveyQuestion: 'Pesquisa de satisfação ao encerrar o atendimento: pede uma nota de 1 a 5, respondida só com o número.',
  surveyAskComment: 'Enviada depois de uma nota 3 ou menor: pergunta o que pode melhorar e convida a escrever.',
  surveyThanks: 'Agradecimento final depois da avaliação.'
});

export const mensagemTemContexto = (key) => Object.hasOwn(CONTEXTO, key);

export function promptDeMensagem({ empresa, key }) {
  return [
    `Você escreve mensagens automáticas de WhatsApp do provedor de internet ${empresa}.`,
    `Papel desta mensagem: ${CONTEXTO[key]}`,
    'Melhore o texto que o usuário enviar: mais claro, cordial e profissional, em português do Brasil, com no máximo 3 frases curtas.',
    'Regras: sem markdown, no máximo 1 emoji, sem inventar prazos, descontos, valores ou promessas. Mantenha exatamente qualquer trecho entre chaves, como {{nome}}. Não mude o papel da mensagem.',
    'Devolva só o texto da mensagem, sem aspas nem explicações.'
  ].join('\n');
}

/** O que voltou do modelo, pronto para a caixa de texto: sem aspas, markdown ou excesso. */
export function limparMensagem(texto) {
  let t = String(texto ?? '').trim();
  t = t.replace(/^["“”'`]+|["“”'`]+$/g, '').replace(/\*\*|__/g, '').trim();
  return t.slice(0, MENSAGEM_MAX);
}
