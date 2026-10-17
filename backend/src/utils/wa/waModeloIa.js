import { modeloCitaOsDoisEspelhos } from './waCobranca.js';

/**
 * Pedir à IA o texto de um modelo de mensagem, e conferir o que ela devolveu.
 *
 * Só funções puras: o que sai daqui para o modelo (o prompt) e o que volta dele
 * (o texto limpo). O laço com o provedor fica em `WaAiService.draftTemplate`.
 */

export const TONS = Object.freeze({
  amigavel: 'amigável e próximo, sem gírias',
  formal: 'formal e respeitoso',
  firme: 'firme e direto, sem ser rude'
});

export const OBJETIVO_MAX = 500;
export const TEXTO_MAX = 2000;

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g;

const DESCRICAO = Object.freeze({
  nome: 'nome completo do cliente',
  primeiro_nome: 'primeiro nome do cliente',
  contrato: 'número do contrato',
  plano: 'plano contratado',
  atendente: 'nome de quem está atendendo',
  valor: 'valor da fatura',
  vencimento: 'data de vencimento',
  dias_atraso: 'dias de atraso (só existe para fatura já vencida)',
  dias_para_vencer: 'dias que faltam para vencer (só existe antes do vencimento)',
  pix: 'código PIX copia e cola (o sistema preenche)',
  linha_digitavel: 'linha digitável do boleto (o sistema preenche)',
  link_boleto: 'link do boleto (o sistema preenche)'
});

export function tomValido(tom) {
  return Object.hasOwn(TONS, tom) ? tom : 'amigavel';
}

/** O prompt de sistema: o papel, as regras e as variáveis que a categoria aceita. */
export function promptDeModelo({ empresa, categoria, variaveis, tom }) {
  const lista = variaveis.map((nome) => `- {{${nome}}}: ${DESCRICAO[nome] || 'preenchida pelo sistema'}`).join('\n');
  const partes = [
    `Você escreve modelos de mensagem de WhatsApp para o provedor de internet ${empresa || 'de internet'}. Responda sempre em português do Brasil, com tom ${TONS[tomValido(tom)]}.`,
    'Regras que você nunca quebra:',
    '- Devolva SÓ o texto da mensagem, pronto para usar: sem aspas em volta, sem título, sem explicação, sem markdown (nada de **negrito** nem listas com asteriscos).',
    '- Mensagem curta: no máximo 5 linhas de texto, mais os campos de pagamento quando houver.',
    '- Use APENAS as variáveis abaixo, escritas exatamente assim, com chaves duplas. Nunca invente outra. O sistema troca cada uma pelo dado real de cada cliente.',
    lista,
    '- Nunca escreva valores, datas, prazos, descontos, links ou códigos PIX por conta própria: se a mensagem precisa deles, use a variável. Não prometa nada que o pedido não diga.'
  ];
  if (variaveis.includes('dias_atraso')) {
    partes.push('- {{dias_atraso}} e {{dias_para_vencer}} nunca aparecem no mesmo texto: o primeiro é para quem já está em atraso, o segundo para quem ainda não venceu.');
  }
  if (categoria === 'cobranca') {
    partes.push('- É uma cobrança: seja claro sobre o que o cliente deve fazer e termine com "Se já pagou, desconsidere esta mensagem."');
  } else if (categoria === 'atendimento') {
    partes.push('- É uma resposta rápida que o atendente envia durante a conversa: cumprimente pelo {{primeiro_nome}} e assine com {{atendente}} quando fizer sentido.');
  } else if (categoria === 'geral') {
    partes.push('- É um aviso ou campanha para vários clientes: prefira {{primeiro_nome}}, {{contrato}} e {{plano}}; use valor, vencimento e códigos de pagamento só se o pedido for sobre cobrança.');
  }
  return partes.join('\n');
}

/** O pedido do atendente: escrever do zero, ou melhorar o que já está na caixa. */
export function pedidoDeModelo({ objetivo, atual }) {
  if (atual) {
    return [
      'Melhore o texto abaixo (ortografia, clareza, tom), mantendo o sentido e as variáveis que ele já usa.',
      objetivo ? `Pedido do atendente: ${objetivo}` : '',
      `Texto atual:\n${atual}`
    ].filter(Boolean).join('\n\n');
  }
  return `Escreva o modelo de mensagem. O que ela deve fazer: ${objetivo}`;
}

/** O que sobrou depois de limpar a resposta do modelo. */
export function limparTextoDoModelo(bruto, variaveis) {
  let texto = String(bruto ?? '').trim();
  // Cerca de código e aspas em volta: o modelo as põe por hábito.
  texto = texto.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  texto = texto.replace(/^["“'‘]([\s\S]*)["”'’]$/, '$1').trim();
  texto = texto.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#{1,6}\s+/gm, '');

  const removidas = [];
  texto = texto.replace(PLACEHOLDER, (completo, nome) => {
    if (variaveis.includes(nome)) return `{{${nome}}}`;
    if (!removidas.includes(nome)) removidas.push(nome);
    return '';
  });
  // Onde a variável saiu, não pode ficar um espaço duplo nem uma linha só de pontuação.
  texto = texto.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?;:])/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
  return {
    texto: texto.slice(0, TEXTO_MAX),
    removidas,
    espelhos: modeloCitaOsDoisEspelhos(texto)
  };
}

/** Quais variáveis o texto cita, fora da lista aceita — para a segunda tentativa. */
export function variaveisForaDaLista(texto, variaveis) {
  const citadas = [...String(texto ?? '').matchAll(PLACEHOLDER)].map((m) => m[1]);
  return [...new Set(citadas)].filter((nome) => !variaveis.includes(nome));
}
