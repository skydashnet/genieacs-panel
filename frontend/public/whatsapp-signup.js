/*
 * Embedded Signup da Meta em modo coexistência: o número continua no app
 * WhatsApp Business do celular e passa a responder também pela API oficial.
 * A página só funciona na origem cadastrada no app da Meta (tr69.com.br); em
 * qualquer outra o SDK recusa o FB.login com "domain not allowed".
 *
 * Arquivo clássico (não módulo) e sem nada inline no HTML: a CSP do painel
 * mantém `script-src-attr 'none'`, então o clique é ligado aqui, por
 * `addEventListener`, e não por `onclick=`.
 */
(function () {
  'use strict';

  var APP_ID = '2151827142378177';
  var CONFIG_ID = '1477066904263675';
  var GRAPH_VERSION = 'v25.0';
  // Só a Meta de verdade: `endsWith('facebook.com')` aceitaria `evilfacebook.com`.
  var FACEBOOK_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?facebook\.com$/;

  var btn = document.getElementById('btn');
  var statusEl = document.getElementById('status');
  var resultEl = document.getElementById('result');
  var rawEl = document.getElementById('raw');
  var rawPre = document.getElementById('rawpre');
  var captured = {};

  function setStatus(msg, cls) {
    statusEl.className = cls || '';
    statusEl.textContent = msg;
  }

  function render() {
    var labels = {
      event: 'Resultado', waba_id: 'WABA ID', phone_number_id: 'Phone Number ID',
      business_id: 'Portfólio (Business ID)', code: 'Código de troca (expira em 30s)',
      current_step: 'Parou na etapa', error_message: 'Erro', error_code: 'Código do erro', session_id: 'Sessão'
    };
    resultEl.innerHTML = '';
    Object.keys(captured).forEach(function (k) {
      var tr = document.createElement('tr');
      var th = document.createElement('td');
      th.textContent = labels[k] || k;
      var td = document.createElement('td');
      var code = document.createElement('code');
      code.textContent = String(captured[k]);
      td.appendChild(code);
      tr.appendChild(th);
      tr.appendChild(td);
      resultEl.appendChild(tr);
    });
    resultEl.hidden = false;
    rawEl.hidden = false;
    rawPre.textContent = JSON.stringify(captured, null, 2);
  }

  window.fbAsyncInit = function () {
    FB.init({ appId: APP_ID, autoLogAppEvents: true, xfbml: true, version: GRAPH_VERSION });
  };

  // Dados da sessão (IDs do WABA e do número), via postMessage do popup.
  window.addEventListener('message', function (event) {
    if (!FACEBOOK_ORIGIN.test(event.origin)) return;
    var data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      return; // mensagens que não são JSON são ignoradas
    }
    if (!data || data.type !== 'WA_EMBEDDED_SIGNUP') return;
    captured.event = data.event;
    Object.assign(captured, data.data || {});
    if (data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
      setStatus('Número conectado em coexistência. Copie os IDs abaixo e envie para a configuração. Você tem 24 horas para sincronizar contatos e histórico.', 'ok');
    } else if (data.event && data.event.indexOf('FINISH') === 0) {
      setStatus('Cadastro concluído (' + data.event + '). Atenção: não foi o fluxo de coexistência.', 'err');
    } else if (data.event === 'CANCEL') {
      setStatus('Cadastro cancelado ou com erro. Veja a etapa abaixo.', 'err');
    } else if (data.event === 'ERROR') {
      setStatus('Erro no cadastro. Veja os detalhes abaixo.', 'err');
    }
    render();
  });

  function fbLoginCallback(response) {
    btn.disabled = false;
    if (response.authResponse && response.authResponse.code) {
      captured.code = response.authResponse.code;
      render();
    } else if (!captured.event) {
      setStatus('Janela fechada sem concluir o cadastro.', 'err');
    }
  }

  function launchWhatsAppSignup() {
    if (typeof FB === 'undefined') {
      setStatus('SDK do Facebook ainda carregando, tente de novo em alguns segundos.', 'err');
      return;
    }
    btn.disabled = true;
    setStatus('Aguardando o cadastro na janela do Facebook...');
    FB.login(fbLoginCallback, {
      config_id: CONFIG_ID,
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        setup: {},
        featureType: 'whatsapp_business_app_onboarding',
        sessionInfoVersion: '3'
      }
    });
  }

  btn.addEventListener('click', launchWhatsAppSignup);
})();
