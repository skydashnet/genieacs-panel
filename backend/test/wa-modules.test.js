import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractHost, parseAllowedHosts, hostMatchesPattern, isHostAllowed } from '../src/utils/wa/hostAllowlist.js';
import {
  parseIPv4,
  isPrivateIPv4,
  isPrivateIPv6,
  isBlockedHost,
  assertPublicUrl,
  SsrfBlockedError
} from '../src/utils/wa/ssrfGuard.js';
import { normalizeEvoUrl } from '../src/utils/wa/evolutionPolicy.js';
import { classificarJid, telefoneDoJid } from '../src/utils/wa/waJid.js';
import { destinoWa, normalizarTelefoneBr } from '../src/utils/wa/waDestino.js';
import { urlBaixavel, lerMidiaBase64 } from '../src/utils/wa/waMidia.js';
import { lerRecibo } from '../src/utils/wa/waRecibo.js';
import { pedeSaida } from '../src/utils/wa/waOptOutTexto.js';
import { canonicalizarEvento, EVENTOS } from '../src/utils/wa/waEventos.js';
import { pedidoAutorizado, tokenDaQuery, segredosIguais } from '../src/utils/wa/waWebhookAuth.js';
import {
  flavorFromProbes,
  readLicenseBlock,
  createInstanceRequest,
  connectRequest,
  qrRequest,
  deleteRequest,
  sendMediaRequest,
  sendAudioRequest,
  readQr,
  readStatus,
  readSentId,
  readInstances,
  readNumberChecks,
  readWebhook,
  redigirToken,
  setWebhookRequest,
  webhookUrlWithToken,
  webhookVerdict,
  WEBHOOK_VERDICTS
} from '../src/utils/wa/evolutionApi.js';

describe('host allowlist', () => {
  test('reads a host out of a URL, a bare host, and a host with a port', () => {
    assert.equal(extractHost('https://evo.loja.com/manager'), 'evo.loja.com');
    assert.equal(extractHost('evo.loja.com'), 'evo.loja.com');
    assert.equal(extractHost('evo.loja.com:8080'), 'evo.loja.com');
  });

  test('a wildcard matches subdomains but never the bare domain', () => {
    assert.equal(hostMatchesPattern('a.loja.com', '*.loja.com'), true);
    assert.equal(hostMatchesPattern('a.b.loja.com', '*.loja.com'), true);
    assert.equal(hostMatchesPattern('loja.com', '*.loja.com'), false);
  });

  test('the dot is part of the suffix, so a lookalike domain cannot pass', () => {
    // Without comparing '.loja.com' rather than 'loja.com', an attacker
    // registering malicioso-loja.com would satisfy a naive endsWith.
    assert.equal(hostMatchesPattern('malicioso-loja.com', '*.loja.com'), false);
  });

  test('an empty allowlist permits any host; a filled one is strict', () => {
    assert.equal(isHostAllowed('https://qualquer.com', []), true);
    assert.equal(isHostAllowed('https://qualquer.com', ['evo.loja.com']), false);
    assert.equal(isHostAllowed('https://evo.loja.com', ['evo.loja.com']), true);
  });

  test('parsing tolerates the shapes a human types into a textarea', () => {
    assert.deepEqual(
      parseAllowedHosts(' https://Evo.Loja.com/ \n\n *.outra.com , terceira.com:8080 '),
      ['evo.loja.com', '*.outra.com', 'terceira.com']
    );
  });
});

describe('ssrf guard', () => {
  test('parses every IPv4 notation a resolver accepts', () => {
    assert.equal(parseIPv4('127.0.0.1'), 2130706433);
    assert.equal(parseIPv4('2130706433'), 2130706433); // decimal
    assert.equal(parseIPv4('0x7f.1'), 2130706433); //     hex + short form
    assert.equal(parseIPv4('127.1'), 2130706433); //      short form
    assert.equal(parseIPv4('nao-e-ip'), null);
  });

  test('blocks loopback, RFC1918, link-local and CGNAT', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.0.1', '169.254.169.254', '100.64.0.1']) {
      assert.equal(isPrivateIPv4(parseIPv4(ip)), true, ip);
    }
    assert.equal(isPrivateIPv4(parseIPv4('8.8.8.8')), false);
  });

  test('blocks IPv6 loopback, ULA and IPv4-mapped loopback', () => {
    assert.equal(isPrivateIPv6('::1'), true);
    assert.equal(isPrivateIPv6('fd00::1'), true);
    assert.equal(isPrivateIPv6('fe80::1'), true);
    assert.equal(isPrivateIPv6('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateIPv6('2001:4860:4860::8888'), false);
  });

  /**
   * A grafia que importa é a que o `new URL()` produz, não a que se escreve.
   *
   * O teste acima passa `::ffff:127.0.0.1` como string crua e sempre passou —
   * mas nenhum host chega assim em produção: o serializador do WHATWG reescreve
   * para hextetos antes de o guard ver. Por isso este teste vai por `new URL`,
   * que é o único caminho que reproduz o que o `assertPublicUrl` recebe.
   */
  test('blocks embedded IPv4 in the spelling new URL() actually produces', () => {
    const host = (u) => new URL(u).hostname;
    for (const u of [
      'http://[::ffff:127.0.0.1]/',          // -> [::ffff:7f00:1]
      'http://[::ffff:169.254.169.254]/',    // metadados da cloud
      'http://[::ffff:10.0.0.1]/',
      'http://[::ffff:192.168.1.1]/',
      'http://[::7f00:1]/',                  // IPv4-compatible
      'http://[64:ff9b::169.254.169.254]/',  // NAT64
      'http://[2002:a9fe:a9fe::]/'           // 6to4
    ]) {
      assert.equal(isBlockedHost(host(u)), true, u);
    }
    // Um IPv4 público embutido continua público.
    assert.equal(isBlockedHost(host('http://[::ffff:203.0.113.7]/')), false);
    assert.equal(isBlockedHost(host('http://[2001:4860:4860::8888]/')), false);
  });

  test('refuses an address that claims an IPv4 it cannot parse', () => {
    assert.equal(isPrivateIPv6('::ffff:999.1.1.1'), true);
  });

  test('assertPublicUrl refuses a bracketed literal that maps to loopback', async () => {
    await assert.rejects(
      () => assertPublicUrl('http://[::ffff:127.0.0.1]:41999/'),
      (error) => error instanceof SsrfBlockedError
    );
  });

  test('blocks internal-sounding names, and the decimal form of loopback', () => {
    assert.equal(isBlockedHost('localhost'), true);
    assert.equal(isBlockedHost('acs.internal'), true);
    assert.equal(isBlockedHost('router.home.arpa'), true);
    assert.equal(isBlockedHost('2130706433'), true);
    assert.equal(isBlockedHost('evo.provedor.com.br'), false);
  });
});

describe('evolution policy', () => {
  test('strips the Manager path an operator is likely to paste', () => {
    assert.equal(normalizeEvoUrl('https://evo.loja.com/manager/instances'), 'https://evo.loja.com');
    assert.equal(normalizeEvoUrl('https://evo.loja.com/'), 'https://evo.loja.com');
  });
});

describe('wa jid', () => {
  test('a LID is not a phone, however long it looks', () => {
    const lid = classificarJid('140076734488739@lid');
    assert.equal(lid.tipo, 'lid');
    assert.equal(telefoneDoJid('140076734488739@lid'), '');
  });

  test('the device suffix is stripped instead of glued onto the number', () => {
    // The regression this encodes: stripping only non-digits turned
    // 559381104499:22 into 55938110449922, a phone that does not exist.
    assert.equal(telefoneDoJid('559381104499:22@s.whatsapp.net'), '559381104499');
    assert.equal(telefoneDoJid('559381104499.0:22@s.whatsapp.net'), '559381104499');
  });

  test('groups, broadcasts and unknown domains are not phones', () => {
    assert.equal(classificarJid('12345@g.us').tipo, 'grupo');
    assert.equal(classificarJid('status@broadcast').tipo, 'broadcast');
    assert.equal(classificarJid('algo@novidade.net').tipo, 'desconhecido');
  });

  test('no domain still counts as a phone, which connection_update relies on', () => {
    assert.equal(telefoneDoJid('5593981110449'), '5593981110449');
  });
});

describe('wa destino', () => {
  test('phone wins over LID, and the thread is only a last resort', () => {
    assert.deepEqual(
      destinoWa({ wa_phone_e164: '5593981110449', wa_lid: '1400767' }),
      { valor: '5593981110449', tipo: 'phone' }
    );
    assert.deepEqual(destinoWa({ wa_lid: '1400767' }), { valor: '1400767', tipo: 'lid' });
    assert.deepEqual(
      destinoWa({}, { external_thread_id: '1400767@lid' }),
      { valor: '1400767', tipo: 'lid' }
    );
    assert.equal(destinoWa({}, {}), null);
  });

  test('adds the country code but never invents the ninth digit', () => {
    assert.equal(normalizarTelefoneBr('(93) 98111-0449'), '5593981110449');
    assert.equal(normalizarTelefoneBr('93 3522-1234'), '559335221234');
    // Already 12 digits: 55 + DDD + 8. Landlines stay 8 digits forever, and a
    // guessed 9 would address a real number belonging to someone else.
    assert.equal(normalizarTelefoneBr('559335221234'), '559335221234');
    assert.equal(normalizarTelefoneBr(''), '');
  });
});

describe('wa midia', () => {
  test('rejects the WhatsApp CDN, which serves the encrypted object', () => {
    assert.equal(urlBaixavel('https://mmg.whatsapp.net/v/t62.7118-24/x.enc'), null);
    assert.equal(urlBaixavel('https://minio.evo.com/anexo.jpg'), 'https://minio.evo.com/anexo.jpg');
    assert.equal(urlBaixavel('nao-e-url'), null);
  });

  test('reads the base64 payload flat and nested', () => {
    assert.deepEqual(lerMidiaBase64({ base64: 'AAA', mimetype: 'image/png' }), {
      base64: 'AAA',
      mimetype: 'image/png'
    });
    assert.deepEqual(lerMidiaBase64({ media: { base64: 'BBB' } }), { base64: 'BBB' });
    assert.equal(lerMidiaBase64({ base64: '' }), null);
  });
});

describe('wa recibo', () => {
  // The three formats. Reading only one of them cost the source system sixteen
  // days of silently missing receipts after a server swap.
  test('Evolution API v2 sends the id flat, in keyId', () => {
    assert.deepEqual(
      lerRecibo({ event: 'messages.update', data: { messageId: 'interno', keyId: 'ABC', status: 'DELIVERY_ACK' } }),
      { ids: ['ABC'], status: 'delivered' }
    );
  });

  test('Evolution API v1 nests it in key.id and update.status', () => {
    assert.deepEqual(
      lerRecibo({ data: { key: { id: 'ABC' }, update: { status: 'READ' } } }),
      { ids: ['ABC'], status: 'read' }
    );
  });

  test('Evolution GO batches ids and puts the state on the envelope', () => {
    assert.deepEqual(
      lerRecibo({ state: 'Delivered', data: { MessageIDs: ['A', 'B'] } }),
      { ids: ['A', 'B'], status: 'delivered' }
    );
  });

  test('numeric Baileys statuses are understood', () => {
    assert.equal(lerRecibo({ data: { keyId: 'A', status: 4 } }).status, 'read');
    assert.equal(lerRecibo({ data: { keyId: 'A', status: 2 } }).status, 'sent');
  });

  test('ReadSelf is ignored: that is the operator reading on their own phone', () => {
    assert.equal(lerRecibo({ state: 'ReadSelf', data: { MessageIDs: ['A'] } }), null);
  });

  test('an update with no status at all is not a receipt', () => {
    assert.equal(lerRecibo({ data: { keyId: 'A' } }), null);
    assert.equal(lerRecibo({}), null);
  });
});

describe('opt-out detection', () => {
  test('the whole message must be the request', () => {
    assert.equal(pedeSaida('SAIR'), true);
    assert.equal(pedeSaida('sair.'), true);
    assert.equal(pedeSaida('Não quero receber'), true);
  });

  test('real customer messages that merely contain the word are not opt-outs', () => {
    // Measured against 1,887 real inbound messages in the source system.
    assert.equal(pedeSaida('Então pode separar'), false);
    assert.equal(pedeSaida('pra preparar o bolso'), false);
    assert.equal(pedeSaida('Passo sim daqui a pouco vou sair'), false);
    assert.equal(pedeSaida(''), false);
  });
});

describe('event canonicalisation', () => {
  test('both dialects collapse onto four names', () => {
    assert.equal(canonicalizarEvento('messages.upsert'), EVENTOS.MENSAGEM);
    assert.equal(canonicalizarEvento('Message'), EVENTOS.MENSAGEM);
    assert.equal(canonicalizarEvento('qrcode'), EVENTOS.QR);
    assert.equal(canonicalizarEvento('QRCODE_UPDATED'), EVENTOS.QR);
    assert.equal(canonicalizarEvento('LoggedOut'), EVENTOS.CONEXAO);
    assert.equal(canonicalizarEvento('Receipt'), EVENTOS.RECIBO);
  });
});

describe('webhook authentication', () => {
  const segredos = { webhookToken: 'segredo-do-webhook', instanceToken: 'token-da-instancia' };

  test('the query token authorises, and a wrong one does not', () => {
    assert.equal(pedidoAutorizado(segredos, { urlToken: 'segredo-do-webhook', credencial: '' }), true);
    assert.equal(pedidoAutorizado(segredos, { urlToken: 'errado', credencial: '' }), false);
  });

  test('no credential at all is a refusal, not a pass', () => {
    // The bug this closes: the previous shape short-circuited to "authorised"
    // whenever the server sent nothing — which is exactly what Evolution GO does.
    assert.equal(pedidoAutorizado(segredos, { urlToken: '', credencial: '' }), false);
  });

  test('the instance key still works for an instance created before ?t=', () => {
    assert.equal(pedidoAutorizado(segredos, { urlToken: '', credencial: 'token-da-instancia' }), true);
  });

  test('the query token wins, so the instance key cannot be used to bypass it', () => {
    assert.equal(
      pedidoAutorizado(segredos, { urlToken: 'errado', credencial: 'token-da-instancia' }),
      false
    );
  });

  test('a trailing slash added by a proxy does not break the token', () => {
    assert.equal(tokenDaQuery({ t: 'abc/' }), 'abc');
  });

  test('comparison tolerates different lengths without throwing', () => {
    assert.equal(segredosIguais('curto', 'muito-mais-comprido'), false);
    assert.equal(segredosIguais('', ''), false);
  });
});

describe('evolution api translation', () => {
  test('detects the flavour from unauthenticated probes', () => {
    assert.equal(flavorFromProbes({ ok: true, data: { status: 'ok' } }, { ok: false, data: null }), 'go');
    assert.equal(flavorFromProbes({ ok: false, data: null }, { ok: true, data: { version: '2.1.1' } }), 'v2');
    // Inconclusive falls back to v2, whose failure mode is a readable 404.
    assert.equal(flavorFromProbes({ ok: false, data: null }, { ok: false, data: null }), 'v2');
  });

  test('recognises a licence block by code in any status, and by text only on 503', () => {
    assert.deepEqual(
      readLicenseBlock(401, { code: 'LICENSE_REQUIRED', register_url: 'https://evo.com/manager/login' }),
      { registerUrl: 'https://evo.com/manager/login' }
    );
    assert.ok(readLicenseBlock(503, { error: 'license required' }));
    assert.equal(readLicenseBlock(500, { error: 'license required' }), null);
    // A hostile register_url never reaches the operator as a link.
    assert.deepEqual(readLicenseBlock(503, { code: 'LICENSE_REQUIRED', register_url: 'javascript:alert(1)' }), {
      registerUrl: null
    });
  });

  test('the create payload differs where the servers differ', () => {
    const p = { name: 'painel', token: 'tok', instanceId: 'uuid', webhookUrl: 'https://p/hook?t=s', rejectCallMessage: 'não atendo' };
    const go = createInstanceRequest('go', p);
    const v2 = createInstanceRequest('v2', p);

    assert.equal(go.key, 'admin');
    assert.equal(go.body.instanceId, 'uuid');
    // alwaysOnline true on GO would suppress notifications on the operator's phone.
    assert.equal(go.body.advancedSettings.alwaysOnline, false);
    assert.equal(go.body.advancedSettings.readMessages, false);
    // GO takes no webhook at create; it goes on connect.
    assert.equal(go.body.webhook, undefined);

    assert.equal(v2.body.name, 'painel');
    assert.equal(v2.body.instanceName, 'painel');
    // byEvents true would append the event name after the query string and the
    // ?t= secret would stop parsing as a query param.
    assert.equal(v2.body.webhook.byEvents, false);
    assert.equal(v2.body.webhook.base64, true);
  });

  test('only GO needs the connect call, and it carries the webhook', () => {
    assert.equal(connectRequest('v2', 'https://p/hook'), null);
    const go = connectRequest('go', 'https://p/hook');
    assert.equal(go.path, '/instance/connect');
    assert.equal(go.body.webhookUrl, 'https://p/hook');
    assert.ok(go.body.subscribe.includes('QRCODE'));
  });

  test('routes that carry no instance name use the instance key', () => {
    assert.deepEqual(qrRequest('go', 'painel'), { path: '/instance/qr', method: 'GET', key: 'instance' });
    assert.equal(qrRequest('v2', 'painel').path, '/instance/connect/painel');
  });

  test('GO deletes by id with the admin key, and refuses without one', () => {
    assert.equal(deleteRequest('go', 'painel', null), null);
    assert.deepEqual(deleteRequest('go', 'painel', 'uuid'), {
      path: '/instance/delete/uuid',
      method: 'DELETE',
      key: 'admin'
    });
    assert.equal(deleteRequest('v2', 'painel').key, 'admin');
  });

  test('media field names are not the same on the two servers', () => {
    const p = { number: '55', type: 'image', url: 'u', caption: 'c', fileName: 'f.png' };
    assert.deepEqual(sendMediaRequest('go', 'painel', p).body, {
      number: '55', type: 'image', url: 'u', caption: 'c', filename: 'f.png'
    });
    assert.deepEqual(sendMediaRequest('v2', 'painel', p).body, {
      number: '55', mediatype: 'image', media: 'u', caption: 'c', fileName: 'f.png'
    });
  });

  test('voice notes are unavailable on GO, so callers fall back to media', () => {
    assert.equal(sendAudioRequest('go', 'painel', { number: '55', url: 'u' }), null);
    assert.equal(sendAudioRequest('v2', 'painel', { number: '55', url: 'u' }).path, '/message/sendWhatsAppAudio/painel');
  });

  test('reads the QR from all three shapes the servers use', () => {
    assert.equal(readQr({ qrcode: 'data:image/png;base64,AAA' }).qr, 'data:image/png;base64,AAA');
    assert.equal(readQr({ base64: 'BBB' }).qr, 'BBB');
    assert.equal(readQr({ qrcode: { base64: 'CCC' } }).qr, 'CCC');
    assert.equal(readQr({ data: { base64: 'DDD' } }).qr, 'DDD'); // GO envelope
  });

  test('GO reports status in capitalised Go struct fields', () => {
    assert.equal(readStatus('go', { data: { Connected: true, LoggedIn: true } }), 'connected');
    assert.equal(readStatus('go', { data: { Connected: true, LoggedIn: false } }), 'connecting');
    assert.equal(readStatus('go', { data: { Connected: false } }), 'disconnected');
    assert.equal(readStatus('v2', { state: 'open' }), 'connected');
    assert.equal(readStatus('v2', { instance: { state: 'close' } }), 'disconnected');
    assert.equal(readStatus('v2', { state: 'sei-la' }), null);
  });

  test('finds the sent id in either dialect', () => {
    assert.equal(readSentId({ data: { Info: { ID: 'GO1' } } }), 'GO1');
    assert.equal(readSentId({ key: { id: 'V2' } }), 'V2');
    assert.equal(readSentId({}), null);
  });

  test('the instance listing never carries the token through', () => {
    const rows = readInstances('v2', [
      { name: 'painel', connectionStatus: 'open', ownerJid: '5593981110449@s.whatsapp.net', id: 'x', token: 'SEGREDO' }
    ]);
    assert.deepEqual(rows, [{ name: 'painel', status: 'open', owner: '5593981110449', id: 'x' }]);
    assert.equal(JSON.stringify(rows).includes('SEGREDO'), false);
  });

  test('number checks read both shapes', () => {
    assert.deepEqual(readNumberChecks('go', { data: { Users: [{ Query: '55 93 98111-0449', IsInWhatsapp: true }] } }), [
      { number: '5593981110449', exists: true }
    ]);
    assert.deepEqual(readNumberChecks('v2', [{ number: '5593981110449', exists: false }]), [
      { number: '5593981110449', exists: false }
    ]);
  });

  test('the webhook secret goes in the query, and an existing query is dropped', () => {
    assert.equal(webhookUrlWithToken('https://p/hook', 'a b'), 'https://p/hook?t=a%20b');
    assert.equal(webhookUrlWithToken('https://p/hook?x=1#f', 'tok'), 'https://p/hook?t=tok');
  });
});

describe('webhook verdict', () => {
  const ESPERADO = 'https://painel.provedor.com.br/api/whatsapp-webhook?t=segredo';
  const completo = {
    enabled: true,
    byEvents: false,
    url: ESPERADO,
    events: ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT', 'MESSAGES_UPDATE']
  };
  const veredito = (patch) => webhookVerdict({ ...completo, ...patch }, ESPERADO).verdict;

  test('nada a consertar quando o servidor tem exatamente o que escrevemos', () => {
    assert.equal(veredito({}), WEBHOOK_VERDICTS.OK);
  });

  test('a barra final e o `+` na query não inventam divergência', () => {
    // O Evolution e os proxies na frente dele já reescreveram a URL das duas
    // formas. Um veredito que muda por causa disso manda o operador consertar
    // o que não está quebrado, que é o mais caro dos dois erros possíveis aqui.
    assert.equal(veredito({ url: `${ESPERADO}/` }), WEBHOOK_VERDICTS.OK);
    assert.equal(veredito({ url: 'https://painel.provedor.com.br/api/whatsapp-webhook/?t=segredo' }), WEBHOOK_VERDICTS.OK);
  });

  test('cada jeito de estar quebrado tem o SEU veredito', () => {
    assert.equal(veredito({ url: '' }), WEBHOOK_VERDICTS.ABSENT);
    assert.equal(veredito({ enabled: false }), WEBHOOK_VERDICTS.DISABLED);
    assert.equal(veredito({ url: 'https://n8n.exemplo.test/hook?t=segredo' }), WEBHOOK_VERDICTS.URL_MISMATCH);
    assert.equal(veredito({ url: `${ESPERADO}-outro` }), WEBHOOK_VERDICTS.TOKEN_MISMATCH);
    assert.equal(veredito({ byEvents: true }), WEBHOOK_VERDICTS.BY_EVENTS);
    assert.equal(veredito({ events: ['CONNECTION_UPDATE'] }), WEBHOOK_VERDICTS.EVENTS_MISSING);
  });

  test('`enabled` ausente conta como ligado, e a lista vazia NÃO conta como ok', () => {
    // Este caso mudou, e a decisão mudou junto — não o contrário.
    //
    // Ele afirmava que lista vazia lê como `ok`, pela mesma leniência do
    // `enabled`. A comparação entre os dois campos não se sustenta: `enabled`
    // ausente tem um default óbvio e seguro (ligado, senão nada teria
    // funcionado nunca), e `events` ausente não tem nenhum — o silêncio de um
    // webhook que não assina nada é idêntico ao de um webhook que o servidor
    // simplesmente não descreve.
    //
    // O preço de chamar isso de `ok` apareceu num painel em produção: "Nunca
    // chegou nada" ao lado de um webhook declarado saudável, com a tira de
    // saúde muda e o botão de reaplicar fora da tela, porque ele só aparece
    // quando o veredito não é `ok`. Sem sintoma e sem caminho.
    const antigo = readWebhook({ webhook: { url: ESPERADO } });
    assert.equal(antigo.enabled, true);
    assert.deepEqual(antigo.events, []);
    assert.equal(webhookVerdict(antigo, ESPERADO).verdict, WEBHOOK_VERDICTS.EVENTS_UNKNOWN);
  });

  test('e `events_unknown` não é acusação: o que está errado tem precedência', () => {
    // A ordem importa. Um webhook com a URL de outro serviço E lista vazia é
    // `url_mismatch`, não "não dá para conferir os eventos" — senão o veredito
    // mais fraco esconderia o mais forte, e o operador iria reaplicar quando o
    // problema era outro.
    assert.equal(
      veredito({ url: 'https://n8n.exemplo.test/hook?t=segredo', events: [] }),
      WEBHOOK_VERDICTS.URL_MISMATCH
    );
    assert.equal(veredito({ enabled: false, events: [] }), WEBHOOK_VERDICTS.DISABLED);
    assert.equal(veredito({ byEvents: true, events: [] }), WEBHOOK_VERDICTS.BY_EVENTS);
  });

  test('a lista completa continua sendo `ok`, e a incompleta continua `events_missing`', () => {
    // O degrau novo fica ENTRE os dois: vazia não é falta, e falta não é vazia.
    assert.equal(veredito({}), WEBHOOK_VERDICTS.OK);
    assert.equal(veredito({ events: ['CONNECTION_UPDATE'] }), WEBHOOK_VERDICTS.EVENTS_MISSING);
    assert.equal(veredito({ events: [] }), WEBHOOK_VERDICTS.EVENTS_UNKNOWN);
  });

  test('o token nunca sai inteiro, venha a URL de onde vier', () => {
    // Cada caso traz o SEU segredo, e cada um é procurado na saída. A primeira
    // escrita disto foi `!inclui('segredo') || !inclui('SEGREDO')`, que é
    // verdadeira para qualquer texto — uma asserção que não pode falhar não é
    // prova de nada, e esta é justamente a que guarda um segredo.
    const casos = [
      [ESPERADO, 'segredo'],
      [`${ESPERADO}&x=1`, 'segredo'],
      ['http://p/h?T=SEGREDO', 'SEGREDO'],
      ['http://p/h?a=1&t=outro#frag', 'outro']
    ];
    for (const [url, segredo] of casos) {
      const saida = redigirToken(url);
      assert.ok(!saida.includes(segredo), `${url} vazou ${segredo} em ${saida}`);
      assert.ok(saida.includes('***'), `${url} não foi redigida: ${saida}`);
    }
    assert.equal(redigirToken(ESPERADO), 'https://painel.provedor.com.br/api/whatsapp-webhook?t=***');
    assert.ok(!webhookVerdict(completo, ESPERADO).serverUrl.includes('segredo'));
  });

  test('a reescrita do v2 leva a lista de eventos junto, e byEvents desligado', () => {
    // O v2 trata isto como substituição INTEIRA: mandar só a URL deixaria um
    // webhook configurado que não assina nada — o mesmo silêncio, com
    // aparência de conserto.
    const pedido = setWebhookRequest('v2', 'painel-01', ESPERADO);
    assert.equal(pedido.path, '/webhook/set/painel-01');
    assert.equal(pedido.key, 'instance');
    assert.equal(pedido.body.webhook.byEvents, false);
    assert.ok(pedido.body.webhook.events.includes('MESSAGES_UPSERT'));
    // Os dois formatos, porque as versões do v2 leem em lugares diferentes.
    assert.equal(pedido.body.webhook_by_events, false);
    assert.ok(pedido.body.events.includes('MESSAGES_UPSERT'));
  });

  test('no GO a reescrita é o connect, que é quem grava instance.Webhook', () => {
    const pedido = setWebhookRequest('go', 'painel-01', ESPERADO);
    assert.equal(pedido.path, '/instance/connect');
    assert.equal(pedido.body.webhookUrl, ESPERADO);
  });
});
