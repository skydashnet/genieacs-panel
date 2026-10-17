import crypto from 'node:crypto';
import { getDb, insertReturningId } from '../config/database.js';
import { TICKET_GRACE_DAYS } from '../config/retention.js';

/**
 * O bilhete de uso único que sai por e-mail.
 *
 * Dois usos, um mecanismo: redefinir a senha e provar o endereço. Os dois são
 * um valor opaco de 32 bytes que a tabela guarda só como hash, vale por um
 * prazo curto, serve uma vez e é resgatado no host do provedor — e a única
 * diferença entre eles é o que o resgate faz depois. É por isso que são a mesma
 * tabela e o mesmo modelo, ao contrário de `tenant_invites` e
 * `impersonation_tickets`, que carregam campos próprios.
 *
 * Handle cru de propósito: a tabela é compartilhada, não escopada, porque quem
 * resgata não tem sessão — apresentou um token, e é o token que diz de quem ele
 * é. tenant-scope-exempt: tabela compartilhada, declarada em `SHARED_TABLES`.
 *
 * O que este modelo NÃO faz é decidir se o bilhete serve. Ele devolve a linha;
 * conferir o provedor do host e o endereço atual da conta é do controlador,
 * porque são as perguntas que dependem da requisição.
 */
class AuthTicket {
  static PURPOSES = Object.freeze({
    PASSWORD_RESET: 'password_reset',
    EMAIL_VERIFICATION: 'email_verification'
  });

  /**
   * Trinta minutos para a redefinição, um dia para a prova de endereço.
   *
   * Os dois prazos são diferentes porque as duas mensagens são lidas em
   * momentos diferentes. Quem pede para redefinir a senha está parado na tela
   * esperando — meia hora é folga de sobra, e o que ela limita é por quanto
   * tempo uma credencial que abre a conta fica dormindo numa caixa de entrada.
   * A prova de endereço não abre nada: no pior caso alguém confirma um endereço
   * que já é o seu. Ela pode esperar o dia seguinte, e é bom que espere, porque
   * quem a recebe muitas vezes está no meio de outra coisa.
   */
  static TTL_MS = Object.freeze({
    [AuthTicket.PURPOSES.PASSWORD_RESET]: 30 * 60 * 1000,
    [AuthTicket.PURPOSES.EMAIL_VERIFICATION]: 24 * 60 * 60 * 1000
  });

  static hash(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  /** 32 bytes. O que vai no fragmento da URL e some daqui. */
  static mintToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Cunha um bilhete e devolve o valor em claro UMA vez.
   *
   * Os bilhetes abertos do mesmo uso são invalidados antes, e não é higiene: o
   * segundo pedido de redefinição existe porque o primeiro não chegou ou não
   * foi lido, e deixar os dois valendo multiplica as credenciais vivas na caixa
   * de entrada de alguém por quantas vezes ele clicou no botão. O último
   * pedido é o que vale — que é também o que a pessoa espera.
   */
  static async create({ purpose, userId, tenantId, email, ttlMs = null }) {
    const prazo = ttlMs ?? AuthTicket.TTL_MS[purpose];
    if (!prazo) throw new Error(`Unknown auth ticket purpose: ${purpose}`);

    await AuthTicket.invalidateOpen({ purpose, userId });

    const token = AuthTicket.mintToken();
    const id = await insertReturningId('auth_tickets', {
      token_hash: AuthTicket.hash(token),
      purpose,
      user_id: userId,
      tenant_id: tenantId,
      email,
      expires_at: new Date(Date.now() + prazo)
    });
    return { id, token };
  }

  /**
   * Queima os bilhetes abertos de um uso, sem resgatar nenhum.
   *
   * `redeemed_at` no lugar de um `DELETE` porque a linha gasta é o registro de
   * que o bilhete existiu, e apagá-la aqui esconderia do rastro justamente a
   * sequência que interessa investigar: três pedidos de redefinição em dois
   * minutos. A poda os leva embora depois, pela idade.
   */
  static async invalidateOpen({ purpose, userId }) {
    const now = new Date();
    return getDb()('auth_tickets')
      .where({ purpose, user_id: userId })
      .whereNull('redeemed_at')
      .where('expires_at', '>', now)
      .update({ redeemed_at: now });
  }

  /**
   * Resgata: devolve a linha e a marca como usada, ou null.
   *
   * `UPDATE` condicional e não um `if` seguido de escrita, pelo mesmo motivo de
   * `ImpersonationTicket.redeem` e de `TenantInvite.markAccepted`: dois cliques
   * no mesmo link chegam juntos, e é o banco que diz a um dos dois que nenhuma
   * linha casou. Vencido, já usado e inexistente são todos "não achado" — quem
   * tem um link ruim não tem por que aprender qual dos três.
   *
   * **Os três discriminadores estão no mesmo `where`, e é o ponto.** Um bilhete
   * não é só um valor: é um valor PARA um uso e PARA um host. Conferi-los
   * depois do `UPDATE` seria escrever o resgate primeiro e julgar depois — e
   * quem abrisse o link no painel errado gastaria o bilhete sem trocar nada,
   * deixando a pessoa com um link morto e a conta intacta. Foi o que a suíte
   * pegou. Dentro do `where`, a tentativa errada simplesmente não casa linha
   * nenhuma: não gasta o bilhete, não vaza que ele existe, e o link continua
   * valendo na porta certa.
   *
   * Sem o `purpose` ali, um bilhete de prova de endereço — o barato, o de um
   * dia, o que se manda para um endereço que ninguém provou — seria aceito pelo
   * caminho que redefine a senha.
   */
  static async redeem({ token, purpose, tenantId }) {
    if (!token) return null;
    const hash = AuthTicket.hash(token);
    const now = new Date();
    // `tenantId` nulo NÃO filtra por provedor, e a justificativa é a de
    // `hostMatchesTenant`, palavra por palavra: quem passa nulo é um deploy
    // onde nenhum host nomeia provedor, e onde nenhum host nomeia provedor não
    // existe porta errada. Onde o host NOMEIA, o filtro continua obrigatório —
    // é ele que impede gastar o bilhete de A na porta de B, e é por estar
    // DENTRO do update atômico que a tentativa pela porta errada não casa linha
    // nenhuma e não queima o bilhete de quem o recebeu.
    const alvo = { token_hash: hash, purpose };
    if (tenantId !== null && tenantId !== undefined) alvo.tenant_id = Number(tenantId);
    const changed = await getDb()('auth_tickets')
      .where(alvo)
      .whereNull('redeemed_at')
      .where('expires_at', '>', now)
      .update({ redeemed_at: now });
    if (changed === 0) return null;
    return (await getDb()('auth_tickets').where({ token_hash: hash }).first()) || null;
  }

  /**
   * Apaga o que já não serve: vencido ou usado há mais de um dia.
   *
   * O dia de folga é para a linha gasta continuar visível logo depois do
   * resgate, que é quando alguém investigando "quem trocou minha senha" vai
   * olhar. Depois disso o registro é a trilha no provedor, e a linha aqui é
   * lixo. Mesmo desenho, e mesmo motivo, de `ImpersonationTicket.prune`.
   */
  static async prune(now = new Date()) {
    const cutoff = new Date(now.getTime() - TICKET_GRACE_DAYS * 24 * 60 * 60 * 1000);
    return getDb()('auth_tickets')
      .where('expires_at', '<', now)
      .andWhere((q) => q.whereNull('redeemed_at').orWhere('redeemed_at', '<', cutoff))
      .del();
  }
}

export default AuthTicket;
