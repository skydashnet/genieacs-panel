import { tdb, tinsertReturningId } from '../config/database.js';

/**
 * Os modelos aprovados na Meta, por número oficial — ver `waMetaTemplatesTable`.
 *
 * Uma cópia do que a Meta diz, trocada inteira a cada sincronização: o que
 * sumiu de lá some daqui.
 */
class WaMetaTemplate {
  static async listByAccount(accountId, { usableOnly = false } = {}) {
    const query = tdb('wa_meta_templates').where({ account_id: accountId });
    if (usableOnly) query.where({ status: 'APPROVED', supported: true });
    return query.orderBy([{ column: 'name' }, { column: 'language' }]);
  }

  static async find(accountId, name, language) {
    return (await tdb('wa_meta_templates')
      .where({ account_id: accountId, name, language })
      .first()) || null;
  }

  /** O mesmo modelo em qualquer número deste provedor. */
  static async findAnyAccount(name, language) {
    return (await tdb('wa_meta_templates').where({ name, language }).first()) || null;
  }

  /** Troca a lista do número pela que a Meta acabou de devolver. */
  static async replaceForAccount(accountId, rows) {
    const now = new Date();
    const atuais = await tdb('wa_meta_templates').where({ account_id: accountId });
    const chave = (r) => `${r.name}\u0000${r.language}`;
    const novas = new Map(rows.map((r) => [chave(r), r]));
    for (const antiga of atuais) {
      if (!novas.has(chave(antiga))) {
        // eslint-disable-next-line no-await-in-loop -- poucas linhas por número
        await tdb('wa_meta_templates').where({ id: antiga.id }).del();
      }
    }
    for (const row of rows) {
      const dados = {
        meta_id: row.metaId ? String(row.metaId).slice(0, 64) : null,
        category: String(row.category || '').slice(0, 24) || null,
        status: String(row.status || '').slice(0, 24) || null,
        body_text: row.bodyText || null,
        param_count: Number(row.paramCount) || 0,
        param_format: row.paramFormat === 'named' ? 'named' : 'positional',
        supported: Boolean(row.supported),
        header_format: String(row.headerFormat || 'NONE').slice(0, 12),
        header_param_count: Number(row.headerParamCount) || 0,
        buttons_json: JSON.stringify(Array.isArray(row.buttons) ? row.buttons : []),
        components_json: JSON.stringify(row.components ?? []),
        synced_at: now
      };
      const existente = atuais.find((a) => chave(a) === chave(row));
      if (existente) {
        // eslint-disable-next-line no-await-in-loop -- idem
        await tdb('wa_meta_templates').where({ id: existente.id }).update(dados);
      } else {
        // eslint-disable-next-line no-await-in-loop -- idem
        await tinsertReturningId('wa_meta_templates', {
          account_id: accountId,
          name: String(row.name).slice(0, 255),
          language: String(row.language).slice(0, 16),
          ...dados
        });
      }
    }
    return this.listByAccount(accountId);
  }
}

export default WaMetaTemplate;
