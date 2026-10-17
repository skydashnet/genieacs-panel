'use client'

import { HelpDocument } from '@/components/help-document'
import { PLATFORM_BILLING_MANUAL } from '@/lib/help-docs'

/**
 * A aba Ajuda do console: o manual de cobrança (`docs/manual-cobranca.md`),
 * embutido no build, com sumário e busca. Nada aqui fala com o servidor — o
 * texto já veio no bundle.
 */
export function PlatformHelp() {
  return <HelpDocument source={PLATFORM_BILLING_MANUAL} layout="page" />
}

export default PlatformHelp
