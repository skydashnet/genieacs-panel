/**
 * O que a política de privacidade do site afirma, como DADO — e não como texto
 * solto dentro de uma página.
 *
 * A diferença é a razão deste arquivo. Uma política escrita à mão envelhece no
 * primeiro commit depois dela: alguém acrescenta um campo ao formulário e a
 * política continua dizendo o que coletava antes. Aqui as afirmações que o
 * código pode desmentir ficam em estruturas que `frontend/test/privacy.test.ts`
 * confronta com a fonte do formulário, e o que o servidor sabe (o prazo de
 * guarda) vem dele em vez de ser digitado.
 *
 * O texto é só em português, de propósito. É um documento jurídico, o português
 * é o idioma que vale perante a lei, e traduzir sem revisão cria versões que
 * podem divergir. Ele não substitui parecer de quem entende de direito.
 */

/** Data da última revisão do CONTEÚDO. Muda à mão, a cada alteração do texto. */
export const POLICY_UPDATED_AT = '2026-10-09'

export type LeadField = {
  /** A chave que `publicAPI.createLead` envia, exatamente como em `landing.tsx`. */
  key: string
  label: string
  /**
   * `contact`: nenhum dos dois é obrigatório sozinho, mas o servidor recusa o
   * pedido sem ao menos um — `!name || (!email && !phone)` em `createLead`.
   * Chamar cada um de "opcional" seria dizer ao titular uma coisa que o
   * formulário desmente.
   */
  required: 'always' | 'never' | 'contact'
}

/**
 * O que o formulário de contato da vitrine coleta.
 *
 * A chave tem que ser a do corpo enviado a `POST /api/public/leads`. O teste lê
 * `landing.tsx` e exige que o conjunto seja IGUAL a este: campo novo no
 * formulário sem declaração aqui quebra a suíte, e campo declarado aqui que o
 * formulário já não coleta também — uma política que cita o que não se coleta é
 * tão errada quanto a que omite o que se coleta.
 */
export const LEAD_FIELDS: readonly LeadField[] = [
  { key: 'name', label: 'Nome', required: 'always' },
  { key: 'company', label: 'Empresa (provedor)', required: 'never' },
  { key: 'email', label: 'E-mail', required: 'contact' },
  { key: 'phone', label: 'Telefone / WhatsApp', required: 'contact' },
  { key: 'city', label: 'Cidade', required: 'never' },
  { key: 'devicesEstimate', label: 'Quantidade estimada de assinantes', required: 'never' },
  { key: 'message', label: 'Mensagem', required: 'never' },
  { key: 'planCode', label: 'Plano de interesse', required: 'never' }
]

/**
 * Chaves que o formulário envia e que NÃO são dado do titular — com o motivo.
 * Sem o motivo escrito a exceção seria só um jeito de calar o teste.
 */
export const LEAD_KEYS_NOT_PERSONAL: Readonly<Record<string, string>> = {
  website:
    'campo-armadilha contra robô, escondido de quem usa a página; o servidor descarta o pedido se ele vier preenchido e nunca o grava'
}

export type Recipient = {
  who: string
  /** O que chega a ele. */
  what: string
  why: string
}

/**
 * Com quem o dado da PLATAFORMA é compartilhado — o nosso, como controlador.
 *
 * Não inclui o que é do provedor (o ERP dele, o ACS dele, a IA e o TeiaH que ele
 * liga): esses recebem dado de assinante, que é do provedor, e a política de
 * quem o controla é a do provedor. Misturar as duas listas faria este documento
 * falar em nome de quem não é o seu controlador.
 */
export const RECIPIENTS: readonly Recipient[] = [
  {
    who: 'Nossa equipe, por e-mail e por WhatsApp',
    what: 'o conteúdo do pedido de contato (nome, empresa, e-mail, telefone, cidade e mensagem)',
    why: 'avisar que um pedido chegou e permitir que alguém responda'
  },
  {
    who: 'Asaas (cobrança)',
    what: 'o cadastro do provedor contratante: razão social, CNPJ/CPF, endereço, e-mail e telefone',
    why: 'emitir e cobrar a assinatura'
  },
  {
    who: 'BrasilAPI, CNPJ.ws e ReceitaWS',
    what: 'o CNPJ digitado no cadastro',
    why: 'preencher os dados da empresa a partir do cadastro público'
  },
  {
    who: 'BrasilAPI e ViaCEP',
    what: 'o CEP digitado no cadastro',
    why: 'preencher o endereço'
  },
  {
    who: 'OpenStreetMap ou Google (imagens do mapa)',
    what: 'o endereço IP do navegador de quem usa o painel e a área do mapa que está sendo vista',
    why: 'mostrar o mapa da rede; é o navegador que pede as imagens, quando o mapa é aberto'
  },
  {
    who: 'Meta (Facebook)',
    what: 'no navegador de quem conecta o WhatsApp oficial, o script da Meta e a identidade do operador no cadastro integrado; no servidor, o identificador da conta WhatsApp Business',
    why: 'conectar o WhatsApp oficial do provedor, apenas quando essa conexão é feita'
  },
  {
    who: 'Provedor de infraestrutura em nuvem onde o serviço é hospedado',
    what: 'os dados que o serviço armazena',
    why: 'executar o serviço'
  }
]

/**
 * A frase sobre quanto tempo o pedido de contato fica guardado.
 *
 * Recebe o número que o SERVIDOR publica (`/api/public/info`), que sai da mesma
 * função que a poda usa. `undefined` é "não consegui ler" e não é "zero": dizer
 * "nada o apaga" por causa de uma falha de rede seria afirmar um fato sem saber.
 *
 * O `won` entra na frase porque a poda o poupa em qualquer prazo — é o único
 * elo entre um provedor que contratou e o pedido que o originou, e a política
 * que o omitisse prometeria um apagamento que o código não faz.
 */
export function leadRetentionSentence(days: number | undefined): string {
  if (days === undefined) {
    return 'Não foi possível ler agora o prazo configurado. Pergunte-nos pelo canal abaixo.'
  }
  if (days === 0) {
    return 'Hoje nenhuma rotina automática apaga o pedido de contato: ele fica guardado até você pedir a exclusão.'
  }
  return `O pedido de contato é apagado automaticamente ${days} dias depois de recebido. `
    + 'A exceção é o pedido que virou contratação: esse registro permanece, porque é o histórico de como o contrato começou.'
}
