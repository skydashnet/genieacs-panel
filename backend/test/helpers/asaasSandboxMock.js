import crypto from 'node:crypto';
import http from 'node:http';

/**
 * Um Asaas de mentira com estado, para o `--dry-run` de
 * `scripts/asaas-sandbox-e2e.js` (e para o teste dele).
 *
 * Os outros testes de cobrança montam cada um o seu gateway mínimo, com só as
 * rotas que o arquivo assere. Este aqui precisa do contrário: as MESMAS rotas
 * que o roteiro do sandbox percorre — cliente, token de cartão, cobrança,
 * baixa em dinheiro, estorno, nota fiscal —, com o estado andando entre uma e
 * outra como anda no sandbox de verdade. Não é uma réplica fiel do Asaas: é o
 * suficiente para o roteiro inteiro rodar sem rede e sem chave, e quebrar
 * quando o painel mudar o que pede ao gateway.
 *
 * Os cartões seguem a regra do sandbox: o número de recusa
 * (`REFUSED_CARD_NUMBERS`) tokeniza, mas a cobrança com o token dele volta 400
 * com um erro de cartão; qualquer outro número aprova na criação
 * (`CONFIRMED`).
 */

export const REFUSED_CARD_NUMBERS = Object.freeze(['5184019740373151', '4916561358240741']);

const hoje = () => new Date().toISOString().slice(0, 10);

/**
 * Sobe o gateway em `127.0.0.1`, numa porta livre.
 *
 * @param {{ apiKey: string, nfse?: 'ok'|'disabled' }} opcoes
 * @returns {Promise<{ url: string, close: () => Promise<void>, requests: Array<object>, state: object }>}
 */
export async function startAsaasSandboxMock({ apiKey, nfse = 'ok' } = {}) {
  if (!apiKey) throw new Error('startAsaasSandboxMock needs the apiKey it should accept');
  const state = {
    customers: new Map(),
    payments: new Map(),
    invoices: new Map(),
    tokens: new Map()
  };
  const requests = [];
  let seq = 0;
  const novoId = (prefixo) => {
    seq += 1;
    return `${prefixo}_mock_${String(seq).padStart(6, '0')}`;
  };

  const server = http.createServer((req, res) => {
    let bruto = '';
    req.on('data', (parte) => { bruto += parte; });
    req.on('end', () => {
      let payload = null;
      try { payload = bruto ? JSON.parse(bruto) : null; } catch { payload = null; }
      const [caminho, consulta = ''] = req.url.split('?');
      const query = new URLSearchParams(consulta);
      // O registro guarda o caminho e o método, nunca o corpo: o corpo da
      // tokenização tem o número do cartão, e o da cobrança, o token.
      requests.push({ method: req.method, path: caminho });
      const responder = (status, corpo) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(corpo));
      };
      const erro = (status, code, description) => responder(status, { errors: [{ code, description }] });
      if (req.headers.access_token !== apiKey) return erro(401, 'invalid_access_token', 'A chave de API informada não pertence a este ambiente');

      if (req.method === 'GET' && caminho === '/myAccount/commercialInfo') {
        return responder(200, { companyName: 'Conta de mentira (dry-run)' });
      }

      // ── Clientes ──────────────────────────────────────────────────────
      if (req.method === 'POST' && caminho === '/customers') {
        const doc = String(payload?.cpfCnpj ?? '').replace(/\D/g, '');
        if (doc.length !== 11 && doc.length !== 14) return erro(400, 'invalid_cpfCnpj', 'O CPF/CNPJ informado é inválido.');
        const id = novoId('cus');
        const cliente = { object: 'customer', id, ...payload, cpfCnpj: doc, deleted: false };
        state.customers.set(id, cliente);
        return responder(200, cliente);
      }
      const umCliente = /^\/customers\/([^/]+)$/.exec(caminho);
      if (req.method === 'GET' && umCliente) {
        const cliente = state.customers.get(decodeURIComponent(umCliente[1]));
        return cliente ? responder(200, cliente) : erro(404, 'not_found', 'Cliente não encontrado.');
      }

      // ── Tokenização ───────────────────────────────────────────────────
      if (req.method === 'POST' && caminho === '/creditCard/tokenizeCreditCard') {
        const numero = String(payload?.creditCard?.number ?? '').replace(/\D/g, '');
        if (!state.customers.has(payload?.customer)) return erro(400, 'invalid_customer', 'Cliente inválido.');
        if (numero.length < 13) return erro(400, 'invalid_creditCard', 'Número do cartão inválido.');
        if (!payload?.remoteIp) return erro(400, 'invalid_remoteIp', 'O remoteIp é obrigatório.');
        const token = `tok_mock_${crypto.randomBytes(12).toString('hex')}`;
        const brand = numero.startsWith('4') ? 'VISA' : 'MASTERCARD';
        state.tokens.set(token, { number: numero, brand, recusa: REFUSED_CARD_NUMBERS.includes(numero) });
        return responder(200, { creditCardNumber: numero.slice(-4), creditCardBrand: brand, creditCardToken: token });
      }

      // ── Cobranças ─────────────────────────────────────────────────────
      if (req.method === 'POST' && caminho === '/payments') {
        if (!state.customers.has(payload?.customer)) return erro(400, 'invalid_customer', 'Cliente inválido.');
        const id = novoId('pay');
        const pagamento = {
          object: 'payment',
          id,
          customer: payload.customer,
          billingType: payload.billingType,
          value: payload.value,
          netValue: payload.value,
          originalValue: null,
          dueDate: payload.dueDate,
          originalDueDate: payload.dueDate,
          description: payload.description ?? null,
          externalReference: payload.externalReference ?? null,
          status: 'PENDING',
          invoiceUrl: `https://sandbox.asaas.invalid/i/${id}`,
          fine: payload.fine ?? { value: 0 },
          interest: payload.interest ?? { value: 0 },
          discount: payload.discount ?? { value: 0, dueDateLimitDays: 0 },
          paymentDate: null,
          clientPaymentDate: null,
          confirmedDate: null,
          deleted: false
        };
        if (payload.billingType === 'CREDIT_CARD') {
          const cartao = state.tokens.get(payload.creditCardToken);
          if (!cartao) return erro(400, 'invalid_creditCard', 'Token de cartão inválido.');
          if (!payload.remoteIp) return erro(400, 'invalid_remoteIp', 'O remoteIp é obrigatório.');
          if (cartao.recusa) {
            return erro(400, 'invalid_creditCard', 'Transação não autorizada. Verifique os dados do cartão de crédito e tente novamente.');
          }
          pagamento.status = 'CONFIRMED';
          pagamento.confirmedDate = hoje();
          pagamento.paymentDate = hoje();
          pagamento.clientPaymentDate = hoje();
          pagamento.creditCard = {
            creditCardNumber: cartao.number.slice(-4),
            creditCardBrand: cartao.brand,
            creditCardToken: payload.creditCardToken
          };
          // Cartão não leva multa, juros nem desconto.
          pagamento.fine = { value: 0 };
          pagamento.interest = { value: 0 };
          pagamento.discount = { value: 0, dueDateLimitDays: 0 };
        }
        state.payments.set(id, pagamento);
        return responder(200, pagamento);
      }
      if (req.method === 'GET' && caminho === '/payments') {
        const ref = query.get('externalReference');
        const lista = [...state.payments.values()].filter((p) => !p.deleted && (!ref || p.externalReference === ref));
        return responder(200, { object: 'list', hasMore: false, totalCount: lista.length, data: lista });
      }
      const gesto = /^\/payments\/([^/]+)\/(receiveInCash|undoReceivedInCash|refund)$/.exec(caminho);
      if (req.method === 'POST' && gesto) {
        const pagamento = state.payments.get(decodeURIComponent(gesto[1]));
        if (!pagamento || pagamento.deleted) return erro(404, 'not_found', 'Cobrança não encontrada.');
        if (gesto[2] === 'receiveInCash') {
          if (pagamento.status !== 'PENDING' && pagamento.status !== 'OVERDUE') {
            return erro(400, 'invalid_action', 'Só é possível confirmar o recebimento de cobranças pendentes.');
          }
          const recebido = Number(payload?.value);
          if (Number.isFinite(recebido) && recebido !== pagamento.value) {
            pagamento.originalValue = pagamento.value;
            pagamento.value = recebido;
          }
          pagamento.netValue = pagamento.value;
          pagamento.status = 'RECEIVED_IN_CASH';
          pagamento.paymentDate = payload?.paymentDate ?? hoje();
          pagamento.clientPaymentDate = pagamento.paymentDate;
        } else if (gesto[2] === 'undoReceivedInCash') {
          if (pagamento.status !== 'RECEIVED_IN_CASH') return erro(400, 'invalid_action', 'A cobrança não foi recebida em dinheiro.');
          pagamento.status = 'PENDING';
          pagamento.paymentDate = null;
        } else {
          if (!['RECEIVED', 'CONFIRMED'].includes(pagamento.status)) {
            return erro(400, 'invalid_action', 'Só é possível estornar cobranças recebidas ou confirmadas.');
          }
          pagamento.status = 'REFUNDED';
        }
        return responder(200, pagamento);
      }
      const umPagamento = /^\/payments\/([^/]+)$/.exec(caminho);
      if (umPagamento) {
        const pagamento = state.payments.get(decodeURIComponent(umPagamento[1]));
        if (!pagamento) return erro(404, 'not_found', 'Cobrança não encontrada.');
        if (req.method === 'GET') return responder(200, pagamento);
        if (req.method === 'DELETE') {
          pagamento.deleted = true;
          return responder(200, { deleted: true, id: pagamento.id });
        }
        if (req.method === 'POST') {
          for (const campo of ['dueDate', 'value', 'fine', 'interest', 'discount']) {
            if (payload?.[campo] !== undefined) pagamento[campo] = payload[campo];
          }
          return responder(200, pagamento);
        }
      }

      // ── Notas fiscais ─────────────────────────────────────────────────
      if (req.method === 'GET' && caminho === '/invoices') {
        const doPagamento = query.get('payment');
        return responder(200, {
          object: 'list',
          data: [...state.invoices.values()].filter((n) => !doPagamento || n.payment === doPagamento)
        });
      }
      if (req.method === 'POST' && caminho === '/invoices') {
        if (nfse !== 'ok') {
          return erro(400, 'invalid_action', 'A emissão de notas fiscais não está habilitada para esta conta.');
        }
        if (!state.payments.has(payload?.payment)) return erro(400, 'invalid_payment', 'Cobrança não encontrada.');
        const id = novoId('inv');
        const nota = { object: 'invoice', id, status: 'SCHEDULED', payment: payload.payment, value: payload.value, number: null };
        state.invoices.set(id, nota);
        return responder(200, nota);
      }
      const notaGesto = /^\/invoices\/([^/]+)\/(authorize|cancel)$/.exec(caminho);
      if (req.method === 'POST' && notaGesto) {
        const nota = state.invoices.get(decodeURIComponent(notaGesto[1]));
        if (!nota) return erro(404, 'not_found', 'Nota fiscal não encontrada.');
        nota.status = notaGesto[2] === 'authorize' ? 'AUTHORIZED' : 'CANCELED';
        if (nota.status === 'AUTHORIZED') nota.number = String(seq);
        return responder(200, nota);
      }
      const umaNota = /^\/invoices\/([^/]+)$/.exec(caminho);
      if (req.method === 'GET' && umaNota) {
        const nota = state.invoices.get(decodeURIComponent(umaNota[1]));
        return nota ? responder(200, nota) : erro(404, 'not_found', 'Nota fiscal não encontrada.');
      }

      return erro(404, 'not_found', `Rota de mentira inexistente: ${req.method} ${caminho}`);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

export default { startAsaasSandboxMock, REFUSED_CARD_NUMBERS };
