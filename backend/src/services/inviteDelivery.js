import { mailTransport, panelUrlFor } from './mail/index.js';
import { normalizeRole } from '../config/permissions.js';
import { PRODUCT_NAME } from '../config/brand.js';

/**
 * A entrega de um convite: o que ele mostra, por onde ele é aceito, e o e-mail
 * que leva o link.
 *
 * Estava tudo dentro de `inviteController` e saiu daqui porque passou a ter DOIS
 * chamadores. O convite nasce em dois lugares agora — na tela de equipe do
 * próprio provedor e no console da plataforma, que cunha o convite do provedor
 * que acabou de criar —, e as duas coisas que não podem divergir entre eles são
 * exatamente estas: a FORMA DO LINK, porque é o endereço que a pessoa vai abrir
 * e `/invite` só existe naquele host, e o CORPO DO E-MAIL, porque ele carrega
 * uma credencial e a régua do que pode ir junto dela foi decidida uma vez.
 *
 * O que NÃO está aqui é quem pode convidar e com qual papel: isso é regra de
 * autorização e vive em cada controlador, que são planos diferentes — dentro do
 * provedor um `admin` não cunha um `owner`, e o plano de controle está acima
 * dessa regra porque é ele quem entrega o provedor ao primeiro dono.
 */

/**
 * O prazo de um link de PRIMEIRA SENHA, cunhado pelo console.
 *
 * Sete dias, como o convite, e não os trinta minutos da redefinição comum. Os
 * dois prazos medem coisas diferentes: quem pediu para redefinir está parado na
 * tela esperando o e-mail, enquanto quem recebe um acesso recém-criado o recebe
 * de quem o criou — por telefone, por mensagem, no meio do dia de trabalho — e
 * abre quando puder. Meia hora aqui só produziria um segundo pedido.
 */
export const PASSWORD_SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Meia hora a trinta dias. Fora disso é engano de quem digitou, não escolha. */
export const MIN_TTL_MS = 30 * 60 * 1000;
export const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * O que uma tela pode ver de um convite. Nunca o token: ele não está guardado,
 * e se estivesse continuaria fora daqui.
 */
export function publicInvite(invite) {
  return {
    id: invite.id,
    role: normalizeRole(invite.role),
    label: invite.label,
    expiresAt: invite.expires_at,
    createdAt: invite.created_at
  };
}

/**
 * O endereço em que este convite é aceito, ou `null` quando o deploy não tem
 * domínio-base para montá-lo.
 *
 * O token vai no FRAGMENTO, que é a parte da URL que o navegador não manda a
 * servidor nenhum: é a mesma escolha do bilhete de personificação, e pelo mesmo
 * motivo — um token de convite num query string entra em log de proxy e no
 * histórico do navegador, e quem o tiver entra na equipe.
 *
 * O host é o do PROVEDOR convidado, não o de quem convidou. Do lado do próprio
 * provedor os dois coincidem e a tela monta o link com o endereço da própria
 * aba; do console não coincidem, e é por isso que esta função existe: o
 * endereço do provedor alvo é a única coisa que o console não sabe montar.
 */
export function inviteLink(tenant, token) {
  const base = panelUrlFor(tenant);
  return base ? `${base}/invite#${token}` : null;
}

/**
 * O endereço em que a pessoa escolhe a primeira senha, ou `null` sem
 * domínio-base.
 *
 * Mesma forma do convite — host do provedor, token no fragmento — e de
 * propósito: é a mesma tela `/reset-password` que a redefinição comum usa, e o
 * bilhete é o mesmo `auth_tickets` com o mesmo resgate de uso único preso ao
 * host. O que muda é só quem cunha e por quanto tempo vale.
 */
export function passwordSetupLink(tenant, token) {
  const base = panelUrlFor(tenant);
  return base ? `${base}/reset-password#${token}` : null;
}

/**
 * Manda o link da primeira senha, se houver para onde e por onde.
 *
 * Mensagem própria, e não a da redefinição: aquela começa com "alguém pediu uma
 * senha nova para a sua conta", que para quem está recebendo um acesso pela
 * primeira vez é uma frase sobre uma conta que ela não sabe que tem.
 */
export async function sendPasswordSetup({ req, tenant, email, token }) {
  const transporte = mailTransport();
  if (transporte.name === 'none') return false;

  const link = passwordSetupLink(tenant, token);
  if (!link) return false;

  const nome = tenant?.name || PRODUCT_NAME;
  const dias = Math.round(PASSWORD_SETUP_TTL_MS / (24 * 60 * 60 * 1000));
  return transporte.send({
    to: email,
    subject: req.t('platform.operatorMailSubject', { provider: nome }),
    text: req.t('platform.operatorMailBody', { provider: nome, link, days: dias })
  });
}

/**
 * Manda o convite por e-mail, se houver para onde e por onde.
 *
 * Devolve `false` em vez de lançar em todas as saídas ruins — sem transporte,
 * sem endereço externo conhecido, SMTP recusando —, porque nenhuma delas
 * desfaz o convite. Quem convidou fica com o link na resposta.
 *
 * A mensagem é texto puro e curta de propósito. Ela carrega uma CREDENCIAL: o
 * link é o que põe a pessoa na equipe. Não vai nela nada além de quem convida,
 * qual é o papel, até quando vale e o link — nem nome de operador, nem contagem
 * de assinantes, nem nada que faça de uma caixa de entrada alheia um lugar onde
 * mora dado do provedor.
 */
export async function sendInvite({ req, tenant, email, token }) {
  const transporte = mailTransport();
  if (transporte.name === 'none') return false;

  const link = inviteLink(tenant, token);
  if (!link) return false;

  const nome = tenant?.name || PRODUCT_NAME;
  return transporte.send({
    to: email,
    subject: req.t('invite.mailSubject', { provider: nome }),
    text: req.t('invite.mailBody', { provider: nome, link })
  });
}
