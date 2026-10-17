import { Link } from 'react-router'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'

/**
 * O nome do assinante como atalho para o cadastro dele (Contatos → ficha).
 *
 * A ficha é aberta pelo contrato, que é a chave que `ContactProfileService`
 * aceita. Sem permissão de ler contatos, ou sem contrato, fica só o nome.
 */
export function ContactLink({
  contract,
  name,
  className = 'wrap-break-word'
}: {
  contract: string | null | undefined
  name: string | null | undefined
  className?: string
}) {
  const { can } = useAuth()
  const { t } = useTranslation()
  const label = name || '—'
  if (!contract || !can('contacts.read')) return <>{label}</>
  return (
    <Link
      to={`/contacts/${encodeURIComponent(contract)}`}
      className={`${className} hover:text-primary hover:underline`}
      title={t('whatsapp.contact.open')}
    >
      {label}
    </Link>
  )
}
