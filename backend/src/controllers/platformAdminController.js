import PlatformAdmin from '../models/PlatformAdmin.js';
import PlatformAudit from '../models/PlatformAudit.js';
import User from '../models/User.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

/**
 * O cadastro do próprio plano de controle: quem tem a chave do reino.
 *
 * Até esta onda o cadastro só se mexia por `INSERT` na mão. Havia dois
 * caminhos de entrada e nenhum era uma rota: a instalação de um deploy SaaS,
 * que põe o primeiro administrador ali porque sem ele não existe quem crie o
 * segundo provedor, e `scripts/grant-platform-admin.js`, rodado por quem tem o
 * servidor. O argumento a favor de não haver rota era bom — quem pode dar essa
 * chave deveria ser quem segura a máquina — e o que o derrubou foi a operação
 * real: numa plataforma com equipe, "abra um SSH para pôr alguém no time" vira
 * "deixa eu te passar a senha do servidor", que é exatamente o contrário do que
 * o argumento queria proteger. A rota existe para que a concessão seja
 * explícita, guardada pelo mesmo cadastro que ela edita, e REGISTRADA.
 *
 * Duas invariantes mandam neste arquivo, e as duas são sobre não ficar sem
 * saída:
 *
 * 1. **O cadastro nunca fica vazio.** Ele se autoriza a si mesmo: a guarda
 *    relê a tabela a cada requisição, e nenhuma outra rota concede. Zerado, o
 *    console some para todo mundo e só volta com um cliente SQL. A recusa está
 *    em `PlatformAdmin.removeUnlessLast`, onde a contagem e a remoção são um
 *    ato só — ver lá por que um `if` aqui em cima não bastaria.
 * 2. **As duas escritas viram linha em `platform_audit`.** Diferente de
 *    `platformMemberController`, aqui a trilha é UMA só e não duas: aquele
 *    controlador espelha no `audit_log` do provedor afetado porque o que ele
 *    mexe é a equipe de um ISP, e o ISP tem direito de ver mão de fora no
 *    próprio histórico. Esta concessão não afeta provedor nenhum em
 *    particular — ela afeta todos —, então não há em qual `audit_log` espelhar,
 *    e escolher um seria mentir sobre o alcance do que foi dado.
 */

/** O `PlatformAdminView` que o console lê: pessoa mais quando a chave foi dada. */
function present(row) {
  return {
    userId: row.id,
    username: row.username,
    email: row.email ?? null,
    grantedAt: row.created_at ?? null
  };
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

class PlatformAdminController {
  /** `GET /api/platform/admins` — quem tem o plano de controle. */
  static async list(req, res) {
    try {
      const admins = await PlatformAdmin.list();
      return res.json(createResponse(req.t('platformAdmin.listed'), {
        admins: admins.map(present)
      }));
    } catch (error) {
      console.error('List platform admins error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('platformAdmin.listFailed'), error.message)
      );
    }
  }

  /**
   * `POST /api/platform/admins` — dá a chave a quem já existe.
   *
   * A pessoa tem que existir, e a rota não a cria: criar gente é trabalho de
   * `/api/users`, dentro de um provedor, onde o pedido carrega uma senha que
   * alguém escolheu. Este pedido não tem campo de senha, e ter um seria pior do
   * que a ausência — um administrador de plataforma escolhendo a senha de
   * outra pessoa é uma conta que ele sabe entrar e ela não sabe que ele sabe.
   *
   * Por isso um nome desconhecido responde 404 e diz que é isso. A pergunta
   * óbvia é se essa mensagem não vira um oráculo de quais nomes existem no
   * deploy, e a resposta aqui é não — mas não porque o risco seja pequeno, e
   * sim porque ele já está pago: quem chega nesta linha passou por
   * `requirePlatformAdmin`, e a MESMA sessão pode simplesmente chamar
   * `GET /api/platform/tenants/:id/members` e ler nome por nome a equipe de
   * cada provedor do deploy. Esconder aqui o que a rota ao lado entrega em
   * lista não protegeria nada e transformaria um nome digitado errado numa
   * concessão silenciosa que ninguém recebeu. Onde esse cálculo dá o resultado
   * contrário é em `/api/users`, uma casa abaixo, e lá a resposta É evasiva —
   * ver o 404 de wave 12.
   */
  static async grant(req, res) {
    try {
      // `username` no corpo, e um e-mail aceito no mesmo campo: desde que
      // `users.email` existe a pessoa é conhecida pelo endereço tanto quanto
      // pelo nome, e quem pede a promoção de um colega copia o que tem à mão.
      // Um segundo campo `email` só criaria o caso de mandarem os dois e
      // discordarem.
      const identificador = String(req.body?.username ?? '').trim();
      if (!identificador) {
        return res.status(400).json(
          createErrorResponse(req.t('platformAdmin.identifierRequired'))
        );
      }

      const person = await User.findByLogin(identificador);
      if (!person) {
        return res.status(404).json(
          createErrorResponse(req.t('platformAdmin.personNotFound'))
        );
      }

      // `add` já é idempotente e devolve se mudou alguma coisa — conceder duas
      // vezes é o que quem opera faz para conferir que pegou, e responder com
      // violação de chave única a isso seria punir a conferência. O índice
      // único em `user_id` é que garante; a leitura antes dele é conveniência.
      const concedido = await PlatformAdmin.add(person.id);

      // Lido de volta do cadastro para que a resposta tenha a forma exata de um
      // item da lista, `grantedAt` incluso — a data é do banco, não desta
      // requisição, e é a do primeiro `INSERT` quando a concessão foi repetida.
      // Na corrida em que alguém revoga entre as duas linhas, a pessoa volta
      // sem data, o que é melhor do que inventar uma.
      const linha = await PlatformAdmin.find(person.id);
      const admin = linha ? present(linha) : present({ ...person, created_at: null });

      // Só quando mudou. A trilha registra escritas, e uma concessão repetida
      // não é uma: enchê-la de linhas idênticas a cada clique de conferência
      // faria a busca por "quem promoveu fulano" devolver ruído em vez do ato.
      if (concedido) {
        await PlatformAudit.fromRequest(req, {
          action: PlatformAudit.ACTIONS.PLATFORM_ADMIN_GRANTED,
          detail: { userId: person.id, username: person.username }
        });
      }

      // 201 quando a linha nasceu, 200 quando ela já estava lá. A distinção é
      // para quem chama a API direto; o console não precisa dela, e por isso a
      // resposta é a mesma nos dois casos menos pela mensagem.
      return res.status(concedido ? 201 : 200).json(createResponse(
        req.t(concedido ? 'platformAdmin.granted' : 'platformAdmin.alreadyGranted'),
        { admin }
      ));
    } catch (error) {
      console.error('Grant platform admin error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('platformAdmin.grantFailed'), error.message)
      );
    }
  }

  /**
   * `DELETE /api/platform/admins/:userId` — tira a chave.
   *
   * Tirar a chave não apaga a pessoa nem toca no trabalho dela: ela continua
   * sendo operadora do provedor onde trabalha, com as sessões abertas que tem.
   * O que acaba é o alcance do console, e acaba na requisição seguinte, porque
   * é a guarda que relê o cadastro — não há sessão para derrubar.
   *
   * Tirar a PRÓPRIA chave é permitido, e essa é a diferença de forma com a
   * recusa vizinha em `platformMemberController`, que não deixa alguém encerrar
   * o vínculo em que a própria sessão roda. Lá a recusa existe porque a sessão
   * morreria no clique seguinte e a tela pareceria quebrada no momento em que
   * deu certo. Aqui a sessão do painel NÃO morre — ela é do provedor, e o que
   * se está devolvendo é outra coisa. Sair do time da plataforma é uma coisa
   * legítima de se querer fazer, e proibir só obrigaria a pedir a um colega o
   * que a pessoa já pode fazer sozinha. O que continua valendo é a invariante
   * do último: se ela for a última, a recusa é a mesma que seria para qualquer
   * outra pessoa.
   */
  static async revoke(req, res) {
    try {
      const userId = parseId(req.params?.userId);
      if (!userId) {
        return res.status(400).json(createErrorResponse(req.t('platformAdmin.invalidId')));
      }

      // Lido ANTES da remoção porque é o nome que a trilha vai registrar:
      // depois não há mais linha de onde tirá-lo, e o id sozinho não diz a
      // ninguém de quem era a chave daqui a um ano. NÃO é daqui que sai a
      // decisão — quem decide se havia o que remover é a remoção condicional
      // abaixo, e é por isso que o `null` aqui não interrompe nada.
      const linha = await PlatformAdmin.find(userId);

      const resultado = await PlatformAdmin.removeUnlessLast(userId);

      if (resultado === 'absent') {
        return res.status(404).json(createErrorResponse(req.t('platformAdmin.notAnAdmin')));
      }
      if (resultado === 'last') {
        // 409 e não 403: não é falta de autoridade — quem pede tem toda —, é o
        // estado do cadastro que impede. E a mensagem diz o porquê, porque uma
        // recusa sem motivo aqui parece defeito: a tela some o botão quando
        // resta um, então quem chega nesta resposta é quem chamou a rota direto
        // ou quem perdeu a corrida contra outra revogação.
        return res.status(409).json(createErrorResponse(req.t('platformAdmin.lastOne')));
      }

      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_ADMIN_REVOKED,
        detail: { userId, username: linha?.username ?? null }
      });

      return res.json(createResponse(req.t('platformAdmin.revoked'), { userId }));
    } catch (error) {
      console.error('Revoke platform admin error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('platformAdmin.revokeFailed'), error.message)
      );
    }
  }
}

export default PlatformAdminController;
