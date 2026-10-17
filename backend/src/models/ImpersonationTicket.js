import crypto from 'node:crypto';
import { getDb, insertReturningId } from '../config/database.js';
import { TICKET_GRACE_DAYS } from '../config/retention.js';

/**
 * O bilhete de uso único que leva uma personificação do console ao painel.
 *
 * Guarda o hash e nunca o valor — mesma disciplina de `tenant_invites`, e pelo
 * mesmo motivo: enquanto vive, o bilhete É a credencial. O valor aparece uma
 * vez, na resposta da cunhagem, e depois só existe no fragmento da URL para
 * onde o console mandou o navegador.
 *
 * Handle cru de propósito: a tabela é compartilhada, não escopada. Ela é
 * escrita pelo plano de controle antes de qualquer escopo existir, e lida por
 * quem ainda não sabe de qual provedor o bilhete é — descobrir isso é o que a
 * leitura faz. tenant-scope-exempt: tabela compartilhada, declarada em
 * `SHARED_TABLES`.
 */
class ImpersonationTicket {
  /**
   * Um minuto, e não mais.
   *
   * O bilhete existe só para atravessar um redirecionamento de navegador, que
   * é medido em segundos. Um bilhete que vale uma hora é uma credencial de uma
   * hora dormindo no histórico de alguém; um que vale um minuto é uma
   * credencial que já morreu quando alguém for procurá-la ali.
   */
  static TTL_MS = 60 * 1000;

  static hash(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  /** 32 bytes. O que vai no fragmento e some daqui. */
  static mintToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Cunha um bilhete para um provedor, em nome de quem personifica.
   * Devolve o valor em claro UMA vez, com a linha.
   */
  static async create({ tenantId, platformUserId, ttlMs = ImpersonationTicket.TTL_MS }) {
    const token = ImpersonationTicket.mintToken();
    const id = await insertReturningId('impersonation_tickets', {
      token_hash: ImpersonationTicket.hash(token),
      tenant_id: tenantId,
      platform_user_id: platformUserId,
      expires_at: new Date(Date.now() + ttlMs)
    });
    return { id, token };
  }

  /**
   * Resgata: devolve o bilhete e o marca como usado, ou null.
   *
   * O `UPDATE` condicional é o que faz o uso ser único, e não um `if` seguido
   * de uma escrita: dois cliques no mesmo link chegam aqui juntos, e o segundo
   * recebe zero linhas afetadas do banco em vez de passar por uma leitura que
   * os dois já tinham feito. O mesmo desenho de `TenantInvite.markAccepted`.
   *
   * A validade é conferida no mesmo `where`, então um bilhete vencido não é
   * "achado e recusado", é simplesmente não achado — e a resposta de quem
   * chama é a mesma para vencido, já usado e inexistente. Quem tem um bilhete ruim
   * não tem por que aprender qual dos três.
   */
  static async redeem(token) {
    const hash = ImpersonationTicket.hash(token);
    const now = new Date();
    const changed = await getDb()('impersonation_tickets')
      .where({ token_hash: hash })
      .whereNull('redeemed_at')
      .where('expires_at', '>', now)
      .update({ redeemed_at: now });
    if (changed === 0) return null;
    return (await getDb()('impersonation_tickets').where({ token_hash: hash }).first()) || null;
  }

  /**
   * Apaga o que já não serve: vencido ou usado há mais de um dia.
   *
   * O dia de folga é para a linha usada continuar visível logo depois do
   * resgate, que é quando alguém investigando "quem entrou no meu painel" vai
   * olhar. Depois disso a trilha em `platform_audit` e no `audit_log` do
   * provedor é o registro, e a linha aqui é lixo.
   */
  static async prune(now = new Date()) {
    const cutoff = new Date(now.getTime() - TICKET_GRACE_DAYS * 24 * 60 * 60 * 1000);
    return getDb()('impersonation_tickets')
      .where('expires_at', '<', now)
      .andWhere((q) => q.whereNull('redeemed_at').orWhere('redeemed_at', '<', cutoff))
      .del();
  }
}

export default ImpersonationTicket;
