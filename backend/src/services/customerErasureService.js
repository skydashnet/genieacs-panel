import fs from 'node:fs/promises';
import { getDb, tdb } from '../config/database.js';
import { alcanceDoAssinante } from './customerDataExportService.js';
import { resolveStoredAttachment } from './waMediaFile.js';

/**
 * A outra metade do direito do titular: **apagar**.
 *
 * O export (`customerDataExportService`) responde ao art. 18, II — "me mostre o
 * que você tem sobre mim". Este responde ao art. 18, VI — "agora tire". São os
 * dois lados da mesma obrigação, e é por isso que os dois perguntam ao banco
 * pela MESMA função (`alcanceDoAssinante`): uma exclusão que alcançasse menos
 * do que o export acabou de mostrar seria o painel entregando ao titular a
 * lista exata do que continuou guardando.
 *
 * ## Apagar não é `DELETE`
 *
 * A linha da conta FICA, esvaziada. Três razões, e nenhuma é comodidade:
 *
 * 1. **Um `DELETE` não apaga o que importa.** Das quatro tabelas com chave
 *    estrangeira para `customer_accounts`, só `customer_wifi_credentials`
 *    cascateia; `sgp_links`, `device_swaps` e `wa_conversations` são `SET NULL`
 *    e ficariam de pé com o CPF, o nome e o telefone intactos e sem nem o
 *    vínculo que dizia de quem eram. O `DELETE` destrói o ponteiro e preserva o
 *    dado, que é exatamente o avesso do pedido.
 * 2. **A casa já anonimiza por marcação e chama isso de aposentar.**
 *    `CustomerAccount.retire` sobrescreve `device_id` e `identity_hash` com
 *    `retired:<id>` e mantém a linha. A forma daqui é a mesma, um grau mais
 *    fundo.
 * 3. **A linha esvaziada não custa nada.** `SubscriptionService.subscriberCount`
 *    só conta `active: true`, então uma conta apagada não ocupa vaga no plano —
 *    não há motivo comercial para destruir a linha, e destruí-la levaria junto
 *    os `SET NULL` acima.
 *
 * ## O que fica, e por quê
 *
 * - **`audit_log`, intocada.** É a regra fundadora da tabela: não existe delete
 *   linha a linha ali, existe poda por idade. E a linha "fulano revelou a senha
 *   do portal da conta 412" não é dado do titular, é registro de que um
 *   funcionário do ISP agiu — o titular é sujeito, não dono. A LGPD já é
 *   atendida por prazo (365 dias, `schedulerService`), e o `subject_id`
 *   sobrevivente passa a apontar para uma linha onde não há mais ninguém.
 * - **`wa_opt_outs`, intocada.** A tabela é chaveada por telefone de propósito,
 *   para sobreviver a conta apagada e recriada. Apagar o "não me perturbe" de
 *   quem pediu exclusão é desfazer o pedido: a próxima sincronização do ERP
 *   traz o número de volta e a campanha o alcança.
 * - **`device_profiles`**, que é data de instalação de equipamento, e
 *   **`billing_events`/`subscriptions`**, que são o contrato do ISP conosco e
 *   não têm uma coluna de assinante sequer.
 *
 * ## Os dois avisos que o código não consegue cumprir sozinho
 *
 * 1. **`sgp_links` e `sgp_events` são espelho de um sistema que não é nosso.**
 *    Anonimizar aqui não apaga o CPF no ERP do ISP, e a próxima `syncFleet`
 *    traz tudo de volta se o contrato ainda existir lá.
 * 2. **A conta renasce sozinha.** `CustomerService.ensureAccount` cria conta
 *    para qualquer ONT que informe com PPPoE. Se o serviço não for cancelado,
 *    o assinante reaparece com `customer_id` novo na passada seguinte.
 *
 * Os dois estão na tela, e não só aqui: uma exclusão que se desfaz em um minuto
 * sem ninguém perceber é pior do que uma que não aconteceu.
 */

/**
 * As colunas de segredo da própria conta, zeradas nome a nome.
 *
 * A senha do portal do assinante é guardada DUAS vezes na mesma linha: o bcrypt
 * em `password_hash` e uma cópia AES-GCM reversível em `password_ciphertext`,
 * que é o que o operador revela. Nenhum caminho do produto zera essas colunas —
 * `updatePassword` só as substitui por outras. Sem esta lista, "apagar" não
 * apagaria o único segredo recuperável que o painel guarda de uma pessoa.
 *
 * É a imagem espelhada da regra do export, que se recusa a exportar
 * `password_hash` e tudo que termine em `_ciphertext`/`_iv`/`_tag`: o que não
 * sai num arquivo é o primeiro a ser destruído aqui. `password_key_version`
 * fica — é metadado, diz qual chave cifrou, e não cifra nada.
 */
const SEGREDOS_DA_CONTA = Object.freeze({
  password_hash: null,
  password_ciphertext: null,
  password_iv: null,
  password_tag: null,
  password_updated_at: null
});

/** As colunas de `sgp_links` que dizem quem a pessoa é. O contrato e a ONT ficam. */
const IDENTIDADE_NO_CONTRATO = Object.freeze({
  document: null,
  client_name: null,
  login: null,
  phone_e164: null,
  phone_manual: null
});

class CustomerErasureService {
  /**
   * O que a exclusão vai alcançar, contado antes de tocar em nada.
   *
   * Existe separado do `erase` porque a trilha é gravada ANTES e com estes
   * números — a forma que a exclusão de provedor estabeleceu: se a linha da
   * trilha não puder ser gravada, não se apaga. Apagar sem deixar rastro é a
   * única forma de apagar que é indefensável.
   */
  static async survey(account) {
    const alcance = await alcanceDoAssinante(account);
    const { contratos, documentos, telefones, vinculos, contatos, conversaIds, eventos, amostras, horas, quedas, manutencoes, trocas, nos } = alcance;

    const contar = async (tabela, montar) => {
      const [linha] = await montar(tdb(tabela)).count({ n: '*' });
      return Number(linha?.n ?? 0);
    };

    const rowCounts = {
      customer_accounts: 1,
      customer_wifi_credentials: await contar(
        'customer_wifi_credentials', (q) => q.where({ account_id: account.id })
      ),
      sgp_links: vinculos.length,
      sgp_contacts: contatos.length,
      sgp_clients: alcance.clientes.length,
      teiah_exports: contratos.length
        ? await contar('teiah_exports', (q) => q.whereIn('contract', contratos))
        : 0,
      teiah_consultations: documentos.length
        ? await contar('teiah_consultations', (q) => q.whereIn('document', documentos))
        : 0,
      // As linhas do aparelho já vêm recortadas pelo período em que ele foi
      // desta conta: o que veio antes ou depois é de outro assinante.
      sgp_events: eventos.length,
      device_samples: amostras.length,
      device_sample_hours: horas.length,
      outage_incident_devices: quedas.length,
      maintenance_window_devices: manutencoes.length,
      device_swaps: trocas.length,
      wa_conversations: conversaIds.length,
      wa_messages: conversaIds.length
        ? await contar('wa_messages', (q) => q.whereIn('conversation_id', conversaIds))
        : 0,
      wa_bot_events: conversaIds.length
        ? await contar('wa_bot_events', (q) => q.whereIn('conversation_id', conversaIds))
        : 0,
      wa_satisfaction: conversaIds.length
        ? await contar('wa_satisfaction', (q) => q.whereIn('conversation_id', conversaIds))
        : 0,
      wa_conversation_tags: conversaIds.length
        ? await contar('wa_conversation_tags', (q) => q.whereIn('conversation_id', conversaIds))
        : 0,
      wa_broadcast_recipients: (telefones.length || contratos.length)
        ? await contar('wa_broadcast_recipients', (q) => q.where((w) => {
          if (telefones.length) w.whereIn('phone_e164', telefones);
          if (contratos.length) w.orWhereIn('contract', contratos);
        }))
        : 0,
      wa_dunning_sends: (telefones.length || contratos.length)
        ? await contar('wa_dunning_sends', (q) => q.where((w) => {
          if (telefones.length) w.whereIn('phone_e164', telefones);
          if (contratos.length) w.orWhereIn('contract', contratos);
        }))
        : 0,
      sgp_billing_status: contratos.length
        ? await contar('sgp_billing_status', (q) => q.whereIn('contract', contratos))
        : 0,
      wa_dunning_pauses: contratos.length
        ? await contar('wa_dunning_pauses', (q) => q.whereIn('contract', contratos))
        : 0,
      customer_referrals: (telefones.length || contratos.length)
        ? await contar('customer_referrals', (q) => q.where((w) => {
          if (telefones.length) w.whereIn('phone_e164', telefones);
          if (contratos.length) w.orWhereIn('referrer_contract', contratos);
        }))
        : 0,
      mapping_nodes: nos.length
    };

    return { alcance, rowCounts };
  }

  /**
   * Os arquivos de anexo das mensagens que vão sumir, apagados do disco.
   *
   * Fora da transação e ANTES dela, de propósito. Um anexo é uma foto que o
   * assinante mandou: são bytes dele, não um ponteiro. Se o arquivo ficasse
   * para depois do commit e o processo morresse no meio, a exclusão teria
   * respondido "pronto" com a foto ainda no disco e sem nenhuma linha apontando
   * para ela — dado pessoal órfão, que nenhuma varredura futura sabe que é
   * dado pessoal. Na ordem inversa, uma falha deixa bytes destruídos e linhas
   * de pé, que é um estado feio mas honesto: nada foi prometido ainda, e a
   * exclusão pode ser repetida.
   *
   * É a mesma ordem que a varredura de mídia já usa, pelo mesmo motivo escrito
   * lá: contabilidade por último, e só para arquivo que realmente saiu.
   */
  static async apagarAnexos(conversaIds) {
    if (!conversaIds.length) return { files: 0 };
    const linhas = await tdb('wa_messages')
      .whereIn('conversation_id', conversaIds)
      .whereNotNull('attachment_path')
      .select('id', 'attachment_path');

    let apagados = 0;
    for (const linha of linhas) {
      const arquivo = await resolveStoredAttachment(linha);
      // Nulo é "não há bytes a apagar": sem anexo, caminho que escapa da raiz,
      // ou arquivo que já não está lá. Nenhum dos três é motivo para parar.
      if (!arquivo) continue;
      await fs.unlink(arquivo.absolutePath);
      apagados += 1;
    }
    return { files: apagados };
  }

  /**
   * Apaga. Recebe o levantamento já feito para não perguntar duas vezes e para
   * que o que foi gravado na trilha seja o que vai ser executado.
   */
  static async erase(account, { alcance }) {
    const { contratos, telefones, vinculos, contatos, conversaIds, eventos, amostras, horas, quedas, manutencoes, trocas, noIds } = alcance;
    const idsDe = (linhas) => linhas.map((l) => l.id);
    const marca = `erased:${account.id}`;

    await getDb().transaction(async (trx) => {
      // Filhas antes da mãe, como a exclusão de provedor.
      await tdb('customer_wifi_credentials', trx).where({ account_id: account.id }).del();

      if (conversaIds.length) {
        await tdb('wa_bot_events', trx).whereIn('conversation_id', conversaIds).del();
        await tdb('wa_satisfaction', trx).whereIn('conversation_id', conversaIds).del();
        await tdb('wa_conversation_tags', trx).whereIn('conversation_id', conversaIds).del();
        await tdb('wa_messages', trx).whereIn('conversation_id', conversaIds).del();
        await tdb('wa_conversations', trx).whereIn('id', conversaIds).del();
      }

      // Por id, e não por device: as linhas são as que o levantamento recortou
      // pelo período de posse, e apagar pelo aparelho levaria junto a história
      // de quem teve a ONT antes ou depois.
      for (const [tabela, linhas] of [
        ['sgp_events', eventos], ['device_samples', amostras], ['device_sample_hours', horas],
        // Quem uma queda atingiu leva nome e telefone: sai junto.
        ['outage_incident_devices', quedas],
        // O aviso de manutenção também: nome, contrato e telefone.
        ['maintenance_window_devices', manutencoes]
      ]) {
        for (let i = 0; i < linhas.length; i += 500) {
          await tdb(tabela, trx).whereIn('id', idsDe(linhas.slice(i, i + 500))).del();
        }
      }

      // A partir daqui a linha fica e a pessoa sai dela.
      if (vinculos.length) {
        await tdb('sgp_links', trx)
          .whereIn('id', vinculos.map((v) => v.id))
          .update({ ...IDENTIDADE_NO_CONTRATO, updated_at: new Date() });
      }

      // O mesmo contrato achado numa busca ao SGP. A linha fica pelo mesmo
      // motivo da de `sgp_links`, e a pessoa sai dela pelas mesmas colunas,
      // mais o endereço do contrato.
      if (contatos.length) {
        await tdb('sgp_contacts', trx)
          .whereIn('id', contatos.map((c) => c.id))
          .update({
            ...IDENTIDADE_NO_CONTRATO,
            address: null,
            address_parts: null,
            contract_cancelled_at: null,
            equipment_rented: null,
            updated_at: new Date()
          });
      }

      // O registro do envio à TeiaH sai inteiro: é o contrato e a dívida desta
      // pessoa. O que já está na base da TeiaH tem que ser pedido lá.
      if (contratos.length) {
        await tdb('teiah_exports', trx).whereIn('contract', contratos).del();
      }
      if (alcance.documentos.length) {
        await tdb('teiah_consultations', trx).whereIn('document', alcance.documentos).del();
      }

      // A ficha completa é a pessoa inteira — endereço, nascimento, todos os
      // contatos, o que o operador anotou —, e não tem nada que não seja dela.
      // Sai inteira. Uma sincronização posterior pode trazê-la de volta do SGP,
      // que é onde o pedido de exclusão tem que ser atendido também.
      if (alcance.clientes.length) {
        await tdb('sgp_clients', trx).whereIn('id', alcance.clientes.map((c) => c.id)).del();
      }

      // `customer_id` permanece: é sintético, gerado pelo painel, e é a única
      // costura entre esta linha e as linhas de trilha que falam dela. Sem ele,
      // a trilha passa a apontar para um id que não diz nada a ninguém.
      if (trocas.length) {
        await tdb('device_swaps', trx).whereIn('id', idsDe(trocas))
          .update({ pppoe_username: null, updated_at: new Date() });
      }

      if (telefones.length || contratos.length) {
        // `phone_e164` e `rendered_body` são NOT NULL — string vazia, e não
        // nulo. Vazio é melhor que um token derivado do id: dois assinantes
        // apagados ficam indistinguíveis um do outro, que é o que anonimizar
        // quer dizer.
        await tdb('wa_broadcast_recipients', trx).where((q) => {
          if (telefones.length) q.whereIn('phone_e164', telefones);
          if (contratos.length) q.orWhereIn('contract', contratos);
        }).update({ phone_e164: '', client_name: null, rendered_body: '', meta_template: null });
      }

      // O histórico da régua automática sai inteiro: é quem foi cobrado,
      // quanto e em que número — e nada nele é do provedor. A trava contra
      // cobrança repetida vai junto, e é o certo: um contrato apagado não
      // tem mais fatura a cobrar.
      if (telefones.length || contratos.length) {
        await tdb('wa_dunning_sends', trx).where((q) => {
          if (telefones.length) q.whereIn('phone_e164', telefones);
          if (contratos.length) q.orWhereIn('contract', contratos);
        }).del();
      }

      // As indicações: as que ele fez e a dele como indicado.
      if (telefones.length || contratos.length) {
        await tdb('customer_referrals', trx).where((q) => {
          if (telefones.length) q.whereIn('phone_e164', telefones);
          if (contratos.length) q.orWhereIn('referrer_contract', contratos);
        }).del();
      }

      if (contratos.length) {
        await tdb('wa_dunning_pauses', trx).whereIn('contract', contratos).del();
        await tdb('sgp_billing_status', trx).whereIn('contract', contratos).del();
      }

      if (noIds.length) {
        // O nó FICA: é planta do ISP — a caixa e o drop continuam lá quando o
        // assinante sai — e apagá-lo seria o painel destruindo o mapa da rede
        // por causa do pedido de um terceiro.
        //
        // Mas os três campos que uma pessoa escreveu saem. `pppoe` é o que
        // liga o nó ao titular; `notes` é texto livre pendurado no drop de
        // alguém, e o painel não sabe distinguir "splitter 3, porta 8" de um
        // nome; e `name`, que é `NOT NULL`, vira o próprio `node_id` porque num
        // nó do tipo `ont` ele é, na prática, o nome do assinante — deixá-lo de
        // pé seria a exclusão terminar com a pessoa ainda escrita no mapa. O
        // drop continua achável pelo identificador que sempre foi o dele.
        for (const noId of noIds) {
          await tdb('mapping_nodes', trx)
            .where({ node_id: noId })
            .update({ pppoe: null, notes: null, name: noId, updated_at: new Date() });
        }
      }

      await tdb('customer_accounts', trx).where({ id: account.id }).update({
        ...SEGREDOS_DA_CONTA,
        active: false,
        device_id: marca,
        identity_hash: marca,
        pppoe_username: '',
        software_id: '',
        last_seen_at: null,
        updated_at: new Date()
      });
    });
  }
}

export default CustomerErasureService;
