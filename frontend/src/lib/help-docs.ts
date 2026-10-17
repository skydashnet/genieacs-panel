/**
 * Os manuais de cobrança, embutidos no build.
 *
 * A fonte é `docs/` na raiz do repositório — o mesmo arquivo que se lê no
 * GitHub é o que o painel mostra, e não há duas cópias para desencontrar. O
 * `?raw` do Vite traz o texto como string na hora do build; no Docker, o
 * estágio do frontend copia os dois arquivos para `/app/docs` antes do
 * `npm run build` (ver Dockerfile e a exceção no `.dockerignore`).
 *
 * O conteúdo fica em português nos 13 idiomas: só os rótulos em volta (a aba,
 * o link, a busca) são traduzidos, e a tela avisa "conteúdo em português".
 */
import manualCobranca from '../../../docs/manual-cobranca.md?raw'
import guiaProvedor from '../../../docs/guia-provedor-cobranca.md?raw'

/** O manual completo do dono da plataforma (console → Ajuda). */
export const PLATFORM_BILLING_MANUAL: string = manualCobranca

/** O guia curto do lado do provedor (Plano → Como funciona). */
export const PROVIDER_BILLING_GUIDE: string = guiaProvedor

/** O idioma em que os manuais estão escritos. */
export const HELP_CONTENT_LOCALE = 'pt-BR'
