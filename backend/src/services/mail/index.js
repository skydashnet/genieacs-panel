import 'dotenv/config';
import nodemailer from 'nodemailer';
import { MailTransport, NullMailTransport } from './mailTransport.js';
import { log } from '../../utils/logger.js';
import { panelBaseDomain } from '../../middleware/tenantResolver.js';

/**
 * O transporte de e-mail do deploy, se houver um.
 *
 * Configurado por variável de ambiente e por deploy, e não por provedor, de
 * propósito. Quem manda a mensagem é a plataforma — o convite vem do painel,
 * com o nome do painel no remetente —, e um SMTP por provedor seria uma
 * credencial de terceiro guardada por nós para mandar mensagem em nome deles:
 * mais superfície, mais suporte, e a primeira mensagem que não chega vira uma
 * investigação no servidor de e-mail de um cliente. Se um dia um ISP quiser
 * mandar do domínio dele, é uma decisão de produto com preço próprio, e a
 * interface em `mailTransport.js` é onde ela entra.
 *
 *   SMTP_URL=smtps://usuario:senha@smtp.exemplo.com:465
 *   MAIL_FROM=TR69 Controle <nao-responda@exemplo.com>
 *
 * Sem as duas, não há transporte, e o painel funciona como sempre funcionou:
 * o link do convite sai na resposta e quem convidou o entrega como quiser.
 *
 * O endereço do SMTP vem de quem opera o deploy, como `DATABASE_URL` — não é
 * dado de inquilino, então não passa pela guarda de egresso, que existe para
 * URL que um cliente escolhe.
 */
class SmtpMailTransport extends MailTransport {
  constructor(url, from) {
    super();
    this.from = from;
    this.transporter = nodemailer.createTransport(url);
  }

  get name() {
    return 'smtp';
  }

  async send({ to, subject, text }) {
    try {
      await this.transporter.sendMail({ from: this.from, to, subject, text });
      log.info('mail_sent', { to: maskAddress(to), subject });
      return true;
    } catch (error) {
      // Nunca lança: ver o comentário em `MailTransport`. A falha é registrada
      // com o endereço mascarado e a ação que a pediu segue de pé.
      log.error('mail_failed', { to: maskAddress(to), subject, err: error });
      return false;
    }
  }
}

/**
 * `joao@exemplo.com` vira `j***@exemplo.com`.
 *
 * O log diz que uma mensagem saiu e para qual domínio, sem virar uma lista de
 * endereços de gente. O domínio fica inteiro porque é o que se olha quando o
 * problema é entrega, e ele não identifica ninguém sozinho.
 */
function maskAddress(address) {
  const texto = String(address ?? '');
  const at = texto.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${texto[0]}***${texto.slice(at)}`;
}

let cached;

/** O transporte configurado. Resolvido uma vez, porque a configuração é do boot. */
export function mailTransport() {
  if (cached) return cached;
  const url = String(process.env.SMTP_URL || '').trim();
  const from = String(process.env.MAIL_FROM || '').trim();
  if (!url || !from) {
    cached = new NullMailTransport();
    return cached;
  }
  try {
    cached = new SmtpMailTransport(url, from);
  } catch (error) {
    // Uma URL de SMTP malformada não pode impedir o painel de subir: o e-mail
    // é acessório, e um deploy que não manda mensagem funciona.
    log.error('mail_config_invalid', { err: error });
    cached = new NullMailTransport();
  }
  return cached;
}

/** Para os testes, e para nada mais. */
export function resetMailTransport() {
  cached = undefined;
}

/** Há para onde mandar? É o que decide se uma tela oferece o campo de e-mail. */
export function mailConfigured() {
  return mailTransport().name !== 'none';
}

/**
 * O endereço externo do painel de um provedor, ou null.
 *
 * Um link dentro de um e-mail tem que ser absoluto, e o backend só sabe um
 * endereço absoluto quando alguém lhe disse qual é: o domínio-base dos
 * subdomínios, ou `PUBLIC_BASE_URL` numa instalação de um ISP só.
 *
 * O que NÃO se usa aqui é o `Host` da requisição, e vale dizer por quê, porque
 * seria o caminho fácil: quem cria o convite escolhe esse cabeçalho, e um
 * administrador poderia fazer o painel mandar a um colega um link com o token
 * verdadeiro apontando para um servidor dele. O token é a credencial; entregá-lo
 * num endereço que o atacante escolheu é entregá-lo ao atacante.
 */
export function panelUrlFor(tenant) {
  const base = panelBaseDomain();
  if (base && tenant?.slug) return `https://${tenant.slug}.${base}`;
  const publico = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!publico) return null;
  try {
    const parsed = new URL(publico);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return publico;
  } catch {
    return null;
  }
}

export default mailTransport;
