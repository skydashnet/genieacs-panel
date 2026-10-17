/**
 * Por onde uma mensagem sai do painel.
 *
 * A interface existe pelo mesmo motivo que `BillingProvider`: o que muda entre
 * um SMTP do provedor, uma API de envio e o nada é só isto, e o resto do código
 * não deve saber qual está ligado. Quem chama pergunta se há transporte e, se
 * houver, manda; quem não há segue sem e-mail, que é como o painel sempre
 * funcionou.
 *
 * **O envio nunca é a condição de nada.** O convite existe com ou sem e-mail,
 * e o link continua saindo na resposta da criação. Um SMTP fora do ar não pode
 * transformar "convidei alguém" em erro — e é por isso que quem chama recebe
 * `false` em vez de uma exceção.
 */
export class MailTransport {
  /**
   * Manda uma mensagem.
   * @param {{to: string, subject: string, text: string}} _message
   * @returns {Promise<boolean>} entregue ao servidor de e-mail, ou não
   */
  async send(_message) {
    throw new Error('MailTransport.send is not implemented');
  }

  /** Um nome curto para a linha de log. */
  get name() {
    return 'none';
  }
}

/**
 * O transporte de um deploy sem e-mail configurado: não manda nada e diz que
 * não mandou. Existe para que quem chama não precise de um `if` — a diferença
 * entre "não há transporte" e "o envio falhou" é a mesma para quem convidou, e
 * é `false` nos dois casos.
 */
export class NullMailTransport extends MailTransport {
  async send() {
    return false;
  }
}

export default MailTransport;
