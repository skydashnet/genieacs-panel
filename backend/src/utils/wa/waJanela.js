/**
 * A janela de envio da régua de cobrança: em que dias e horas o provedor
 * aceita que o painel mande mensagem sozinho.
 *
 * O formato é o mesmo do horário do chatbot (`waBotConfigService.js`) — sete
 * dias, `day` seguindo `Date#getDay` (0 é domingo), `open`/`close` em `HH:MM` —
 * para que a tela possa usar o mesmo editor e a pessoa reconheça o que vê. A
 * diferença é o padrão: cobrança não sai de madrugada nem no domingo, e o
 * sábado fecha ao meio-dia.
 *
 * Puro, sem banco e sem relógio próprio: o `now` é sempre de quem chama, e é o
 * que deixa o teste andar o calendário.
 */

export const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

const DIAS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Segunda a sexta 08–20, sábado 08–12, domingo fechado. */
export function semanaPadraoCobranca() {
  return [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    day,
    closed: day === 0,
    open: '08:00',
    close: day === 6 ? '12:00' : '20:00'
  }));
}

export function fusoValido(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** O dia da semana e a hora `HH:MM` de `now` no fuso dado. */
export function relogioNoFuso(now, timezone) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const valor = (tipo) => partes.find((p) => p.type === tipo)?.value;
  return { dia: DIAS_EN.indexOf(valor('weekday')), hora: `${valor('hour')}:${valor('minute')}` };
}

/**
 * Se `now` cai dentro da janela.
 *
 * Uma janela ilegível responde NÃO. É a direção segura: a régua parada por
 * configuração quebrada aparece na tela como "fora da janela"; a régua que
 * dispara às três da manhã porque o fuso veio vazio aparece no telefone de
 * centenas de assinantes.
 */
export function dentroDaJanela(janela, now = new Date()) {
  if (!janela || !Array.isArray(janela.week) || !fusoValido(janela.timezone)) return false;
  const { dia, hora } = relogioNoFuso(now, janela.timezone);
  const regra = janela.week.find((d) => Number(d?.day) === dia);
  if (!regra || regra.closed) return false;
  return hora >= regra.open && hora < regra.close;
}

/**
 * Valida e normaliza uma janela vinda da tela.
 *
 * @returns {{ timezone: string, week: object[] }|null} `null` quando inválida
 */
export function lerJanela(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const timezone = String(raw.timezone ?? '').trim();
  if (!fusoValido(timezone)) return null;
  if (!Array.isArray(raw.week)) return null;
  const week = [];
  for (const padrao of semanaPadraoCobranca()) {
    const dia = raw.week.find((d) => Number(d?.day) === padrao.day) || padrao;
    const closed = dia.closed === true;
    const open = String(dia.open ?? padrao.open);
    const close = String(dia.close ?? padrao.close);
    if (!closed && (!HORA.test(open) || !HORA.test(close) || open >= close)) return null;
    week.push({ day: padrao.day, closed, open, close });
  }
  return { timezone, week };
}
