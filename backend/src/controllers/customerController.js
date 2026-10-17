import AuditLog from '../models/AuditLog.js';
import CustomerAccount from '../models/CustomerAccount.js';
import CustomerDataExportService from '../services/customerDataExportService.js';
import CustomerErasureService from '../services/customerErasureService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

/**
 * O dossiê de um assinante — para o provedor entregar a quem o pediu, e para
 * apagar quando ele pedir isso em vez.
 */
class CustomerController {
  /**
   * O id da URL, ou nulo.
   *
   * Nulo e não uma exceção porque as duas rotas respondem a mesma coisa a um id
   * que não é id, e porque um `Number('12abc')` vale `NaN` e um `parseInt` vale
   * 12 — a diferença entre recusar e atender um endereço que ninguém escreveu.
   */
  static idDaUrl(req) {
    const accountId = Number(req.params?.accountId);
    return Number.isInteger(accountId) && accountId > 0 ? accountId : null;
  }

  static async exportDossier(req, res) {
    try {
      const accountId = CustomerController.idDaUrl(req);
      if (accountId === null) {
        return res.status(400).json(createErrorResponse(req.t('customers.invalidId')));
      }

      const arquivo = await CustomerDataExportService.build(accountId);
      // Conta de outro provedor não existe daqui: `CustomerAccount.getById`
      // passa por `tdb`, então a resposta é a mesma de um id inventado — que é
      // o que a varredura de ids confere.
      if (!arquivo) {
        return res.status(404).json(createErrorResponse(req.t('common.notFound')));
      }

      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.CUSTOMER_DATA_EXPORTED,
        subjectType: 'customer_account',
        subjectId: accountId,
        // Contagens, nunca conteúdo: ver o comentário da ação no modelo.
        detail: {
          customerId: arquivo.manifest.subject.customerId,
          rowCounts: arquivo.manifest.rowCounts
        }
      });

      const nome = [
        'assinante',
        String(arquivo.manifest.subject.customerId || accountId).replace(/[^a-zA-Z0-9._-]/g, '-'),
        new Date().toISOString().slice(0, 10)
      ].join('-');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${nome}.json"`);
      return res.send(JSON.stringify(arquivo, null, 2));
    } catch (error) {
      console.error('Customer dossier export error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('customers.exportFailed'), error.message)
      );
    }
  }

  /**
   * O direito de eliminação, exercido pelo ISP em nome do titular.
   *
   * A forma é a da exclusão de provedor, uma escala abaixo, porque aquela já
   * foi conciliada e os dois problemas são o mesmo: um ato sem volta disparado
   * por um clique.
   *
   * 1. **O `customer_id` digitado de volta, exato.** Sem normalizar caixa nem
   *    espaço: normalizar aceitaria um id "quase certo", que é precisamente o
   *    que um engano parece. É a confirmação inteira, e exige ter a ficha do
   *    assinante aberta na frente.
   * 2. **A trilha antes, e como condição.** Se a linha não puder ser gravada,
   *    nada é apagado. Apagar sem deixar rastro é a única forma de apagar que
   *    é indefensável — e aqui com um agravante sobre a exclusão de provedor:
   *    o que some é a prova de que o pedido do titular foi atendido.
   *
   * **Por que NÃO existe o "aposente antes" que a exclusão de provedor tem.**
   * Era o desenho original, e o teste o derrubou por dois motivos, os dois
   * checáveis no código:
   *
   * - **Aposentar não é ato de operador.** `CustomerService.retireAccount` só é
   *   chamado de dentro de `ensureAccount`, quando a sincronização detecta que
   *   uma ONT trocou de dono. Não há rota, botão nem comando que aposente uma
   *   conta — a precondição seria impossível de satisfazer, e a rota nasceria
   *   morta.
   * - **Aposentar destrói justamente a chave de que a exclusão precisa.**
   *   `CustomerAccount.retire` sobrescreve o `device_id` com `retired:<id>`, e
   *   é pelo `device_id` que se alcança a telemetria, os eventos do ERP e o
   *   provisionamento. Exigir a aposentadoria faria a exclusão alcançar MENOS,
   *   não mais: apagaria a conta e deixaria de pé a série de medições da casa
   *   da pessoa.
   *
   * Então a desativação é o primeiro passo DA exclusão e não um passo antes
   * dela, e quem segura o engano é a confirmação digitada.
   */
  static async erase(req, res) {
    try {
      const accountId = CustomerController.idDaUrl(req);
      if (accountId === null) {
        return res.status(400).json(createErrorResponse(req.t('customers.invalidId')));
      }

      // A conta primeiro, e o 404 antes de qualquer validação de corpo: um 400
      // dizendo "confirmação inválida" para o id de outro provedor confirmaria
      // que a linha existe, que é o vazamento que a varredura de ids persegue.
      const account = await CustomerAccount.getById(accountId);
      if (!account) {
        return res.status(404).json(createErrorResponse(req.t('common.notFound')));
      }
      if (req.body?.confirmCustomerId !== account.customer_id) {
        return res.status(409).json(createErrorResponse(req.t('customers.confirmMismatch')));
      }

      const { alcance, rowCounts } = await CustomerErasureService.survey(account);

      const registrada = await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.CUSTOMER_DATA_ERASED,
        subjectType: 'customer_account',
        subjectId: accountId,
        detail: { customerId: account.customer_id, rowCounts }
      });
      if (!registrada) {
        return res.status(500).json(createErrorResponse(req.t('customers.eraseNotLogged')));
      }

      // Os bytes dos anexos primeiro, e fora da transação: ver o comentário no
      // serviço. Uma falha aqui interrompe antes de qualquer escrita no banco.
      const anexos = await CustomerErasureService.apagarAnexos(alcance.conversaIds);
      await CustomerErasureService.erase(account, { alcance });

      return res.json(createResponse(req.t('customers.erased'), {
        accountId,
        customerId: account.customer_id,
        rowCounts,
        attachments: anexos.files,
        // Estava ativa quando foi apagada? A tela precisa saber para dizer a
        // única coisa que o código não consegue fazer sozinho: enquanto a ONT
        // continuar informando na planta, a próxima sincronização recria a
        // conta com `customer_id` novo, e a exclusão se desfaz em um minuto.
        wasActive: Boolean(account.active)
      }));
    } catch (error) {
      console.error('Customer erasure error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('customers.eraseFailed'), error.message)
      );
    }
  }
}

export default CustomerController;
