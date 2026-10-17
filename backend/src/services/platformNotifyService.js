import Tenant from '../models/Tenant.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WhatsAppConfigService from './whatsappConfigService.js';
import { clientForAccount } from './evolutionClient.js';
import { runInTenant } from '../config/tenantContext.js';
import { sendTextRequest } from '../utils/wa/evolutionApi.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';
import { mailTransport } from './mail/index.js';
import { log } from '../utils/logger.js';
import { readProfile } from './platformProfileService.js';

/**
 * A plataforma falando com quem ainda não é — ou acabou de virar — provedor.
 *
 * Pelo WhatsApp da caixa da plataforma (`tenants.kind = 'platform'`), direto no
 * Evolution e sem passar pela caixa de conversas: quem recebe a boas-vindas
 * ainda não é contato de ninguém, e a outbox só envia para conversa que existe.
 *
 * Tudo aqui é melhor esforço e nunca lança. Um cadastro, um lead ou um aviso de
 * vencimento não pode falhar porque o número da plataforma está desconectado —
 * o canal é acessório, como o e-mail.
 */
class PlatformNotifyService {
  /** Manda `text` para `phone` pelo número da plataforma. `true` se saiu. */
  static async sendWhatsapp(phone, text) {
    const number = normalizarTelefoneBr(phone);
    if (!number || !String(text ?? '').trim()) return false;
    try {
      const platform = await Tenant.platform();
      if (!platform) return false;
      return await runInTenant(platform.id, async () => {
        const account = await WhatsAppAccount.getForPurpose('general');
        if (!account) return false;
        const config = await WhatsAppConfigService.getConfig();
        const client = clientForAccount(account, config, WhatsAppConfigService.decryptInstanceToken(account));
        await client.sendOrThrow(sendTextRequest(account.flavor, account.name, number, String(text)));
        return true;
      });
    } catch (error) {
      log.warn('platform whatsapp send failed', { err: error });
      return false;
    }
  }

  /**
   * Avisa quem opera a plataforma de algo que chegou pela página pública (um
   * pedido de demonstração). Os destinos vêm de Configurações → Dados do SaaS
   * (ou do `.env`: `PLATFORM_NOTIFY_WHATSAPP` e `PLATFORM_NOTIFY_EMAIL`).
   * Sem nenhum dos dois, não faz nada.
   */
  static async notifyTeam({ subject, text }) {
    // Configurações → Dados do SaaS, com o `.env` como valor inicial.
    const { values } = await readProfile().catch(() => ({ values: {} }));
    const phone = String(values.notifyWhatsapp || '').trim();
    const email = String(values.notifyEmail || '').trim();
    const results = await Promise.all([
      phone ? this.sendWhatsapp(phone, `*${subject}*\n\n${text}`) : false,
      email
        ? mailTransport().send({ to: email, subject, text }).catch(() => false)
        : false
    ]);
    return results.some(Boolean);
  }
}

export default PlatformNotifyService;
