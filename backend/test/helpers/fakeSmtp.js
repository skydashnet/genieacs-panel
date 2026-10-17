import net from 'node:net';

/**
 * Um servidor SMTP de mentira, em processo.
 *
 * Fala o mínimo do protocolo — saúda, aceita qualquer autenticação, engole o
 * `DATA` até o ponto sozinho — e guarda o que recebeu. Existe para que os
 * testes de e-mail leiam a mensagem que o painel montou sem que nada saia desta
 * máquina: o link de um convite e o de uma redefinição de senha são
 * credenciais, e um teste que as mandasse para um servidor de verdade as
 * publicaria no log de alguém.
 *
 * Mora aqui, e não dentro de uma suíte, desde que a segunda precisou dele.
 */
export function smtpDeMentira() {
  const recebidas = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let emDados = false;
    let corrente = '';
    socket.write('220 mentira ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let linha;
      while ((linha = tomarLinha()) !== null) {
        if (emDados) {
          if (linha === '.') {
            recebidas.push(corrente);
            corrente = '';
            emDados = false;
            socket.write('250 OK\r\n');
          } else {
            corrente += `${linha}\n`;
          }
          continue;
        }
        const comando = linha.slice(0, 4).toUpperCase();
        if (comando === 'EHLO' || comando === 'HELO') socket.write('250-mentira\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (comando === 'AUTH') socket.write('235 OK\r\n');
        else if (comando === 'DATA') { emDados = true; socket.write('354 go\r\n'); }
        else if (comando === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => {});

    function tomarLinha() {
      const fim = buffer.indexOf('\r\n');
      if (fim === -1) return null;
      const out = buffer.slice(0, fim);
      buffer = buffer.slice(fim + 2);
      return out;
    }
  });
  return { server, recebidas };
}

/**
 * Desfaz as quebras suaves e os `=XX` do quoted-printable.
 *
 * O nodemailer codifica o corpo assim, então um link com `#` e mais de 76
 * colunas chega picado e com o `#` virado em `=23`. Sem desfazer isso, um teste
 * que procura o link não o acha — e o defeito é do teste, não do produto.
 */
export function decodificarQuotedPrintable(texto) {
  return texto
    .replace(/=\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
