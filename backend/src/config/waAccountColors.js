/**
 * A cor de cada número do WhatsApp, na caixa de entrada.
 *
 * O provedor com mais de um número via as conversas dos dois misturadas e
 * idênticas: o mesmo assinante duas vezes seguidas, uma por número, sem nada
 * dizendo qual recebeu. A cor é o que separa — e ela vem sempre acompanhada do
 * nome do número na tela, porque cor sozinha não chega a quem não a distingue.
 *
 * Paleta FECHADA, e sem vermelho, verde nem amarelo: essas três são as cores de
 * estado do painel (`--status-danger`, `--status-success`, `--status-warning`),
 * e uma conversa pintada de vermelho leria como erro. Nem verde-azulado: fica a
 * vinte graus do verde do painel, e a mensagem RECEBIDA nessa cor pareceria
 * resposta do provedor. Fechada também porque é o que garante contraste nos
 * dois temas — cada nome tem o seu tom claro e o seu tom escuro em
 * `globals.css`.
 *
 * A ORDEM é a de atribuição, e começa pelas mais distantes entre si: o provedor
 * típico tem dois ou três números, e azul, rosa e verde-limão se separam de
 * longe, enquanto azul e violeta, vizinhos na roda, pedem atenção.
 *
 * O frontend tem a mesma lista em `lib/wa-account-color.ts`, e um teste de lá
 * importa ESTA e exige que as duas concordem. Lista escrita duas vezes sem esse
 * teste é como os limiares ópticos passaram a discordar entre telas.
 */
export const WA_ACCOUNT_COLORS = Object.freeze([
  'blue', 'pink', 'lime', 'violet', 'orange', 'cyan', 'fuchsia', 'indigo'
]);

export function isAccountColor(value) {
  return typeof value === 'string' && WA_ACCOUNT_COLORS.includes(value);
}

/**
 * A cor de um número novo, dadas as que os outros números do provedor já têm.
 *
 * A primeira da paleta que ninguém usa; com as oito em uso, a menos usada, e no
 * empate a primeira da paleta. Assim duas cores só se repetem a partir do nono
 * número, e nunca por acaso de id.
 *
 * @param {Array<string|null>} usadas as cores dos outros números, nulos inclusos.
 */
export function nextAccountColor(usadas = []) {
  const contagem = new Map(WA_ACCOUNT_COLORS.map((cor) => [cor, 0]));
  for (const cor of usadas) {
    if (contagem.has(cor)) contagem.set(cor, contagem.get(cor) + 1);
  }
  let escolhida = WA_ACCOUNT_COLORS[0];
  for (const cor of WA_ACCOUNT_COLORS) {
    if (contagem.get(cor) < contagem.get(escolhida)) escolhida = cor;
  }
  return escolhida;
}
