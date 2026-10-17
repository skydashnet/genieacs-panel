import AuditLog from '../models/AuditLog.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

/**
 * A trilha, como a tela a lê.
 *
 * Só leitura. Não há rota para escrever nem para apagar linha: a escrita vem
 * dos controladores que fazem a ação, e apagar uma linha específica é
 * exatamente o que uma trilha não pode oferecer — se desse, a primeira coisa
 * que alguém faria depois de uma ação indevida seria apagar o registro dela.
 * O que existe é a poda por idade, que roda no agendador e não escolhe o quê.
 */
function publicEntry(row) {
  let detail = null;
  if (row.detail) {
    try { detail = JSON.parse(row.detail); } catch { detail = null; }
  }
  return {
    id: row.id,
    action: row.action,
    actor: {
      // O id pode ter virado null (a pessoa saiu do deploy); o nome fica, que é
      // a razão de ele ser desnormalizado na tabela.
      userId: row.actor_user_id ?? null,
      username: row.actor_username ?? null,
      kind: row.actor_kind
    },
    subject: { type: row.subject_type, id: row.subject_id },
    detail,
    ip: row.ip,
    at: row.created_at
  };
}

class AuditController {
  static async list(req, res) {
    try {
      const rows = await AuditLog.list({
        action: req.query?.action || null,
        limit: req.query?.limit,
        before: req.query?.before || null
      });
      return res.json(createResponse(req.t('audit.listed'), {
        entries: rows.map(publicEntry),
        // O cursor da próxima página: o id da última linha desta.
        //
        // Nulo só quando a página veio VAZIA — e não quando veio incompleta,
        // que é o que este comentário afirmava e o código nunca fez. Quem
        // chama descobre o fim por página incompleta (`entries.length <
        // limit`), que é o sinal correto e o que a tela usa. Fazer o cursor
        // cumprir a promessa antiga exigiria este controlador conhecer o limite
        // já ajustado, que é calculado dentro de `AuditLog.list` — ou seja,
        // duplicar a regra de ajuste aqui, ou mudar a forma de retorno do
        // modelo. Nenhuma das duas se paga por uma ida a mais ao banco na
        // última página; um comentário falso, sim, se cobra da próxima pessoa.
        nextBefore: rows.length ? rows[rows.length - 1].id : null,
        actions: Object.values(AuditLog.ACTIONS)
      }));
    } catch (error) {
      console.error('List audit log error:', error);
      return res.status(500).json(createErrorResponse(req.t('audit.listFailed'), error.message));
    }
  }
}

export { publicEntry };
export default AuditController;
