'use client'

import { useEffect, useRef, useState } from 'react'
import { whatsappAPI, type WhatsAppConversation, type WhatsAppTag } from '@/lib/api'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import { useToast } from '@/components/ui/toast'
import { Icon } from '@/components/ui/icon'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { WA_ACCOUNT_COLORS, WA_ACCOUNT_COLOR_LABEL } from '@/lib/wa-account-color'
import { TAG_NAME_MAX, cleanTagName, nextTagColor, tagClass, tagNameProblem } from '@/lib/wa-tags'

/** Uma etiqueta, na cor dela — sempre com o nome, porque cor sozinha não basta. */
export function TagChip({ tag }: { tag: Pick<WhatsAppTag, 'name' | 'color'> }) {
  return (
    <span
      className={`${tagClass(tag.color)} inline-flex max-w-full items-center gap-1 rounded-full border border-[hsl(var(--wa-account))]/35 bg-[hsl(var(--wa-account))]/10 px-2 py-0.5 text-[0.68rem] font-semibold text-[hsl(var(--wa-account))]`}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-[hsl(var(--wa-account))]" />
      <span className="truncate">{tag.name}</span>
    </span>
  )
}

/** As amostras da paleta, para escolher a cor de uma etiqueta. */
export function ColorSwatches({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup">
      {WA_ACCOUNT_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={t(WA_ACCOUNT_COLOR_LABEL[color])}
          title={t(WA_ACCOUNT_COLOR_LABEL[color])}
          onClick={() => onChange(color)}
          className={`${tagClass(color)} size-6 rounded-full bg-[hsl(var(--wa-account))] ring-offset-2 ring-offset-background ${value === color ? 'ring-2 ring-foreground' : ''}`}
        />
      ))}
    </div>
  )
}

/**
 * As etiquetas da conversa aberta: marcar e desmarcar na hora, e — para quem
 * configura — criar uma nova ali mesmo, sem sair da conversa.
 */
export function TagPicker({ conversation, onChange }: {
  conversation: WhatsAppConversation
  onChange: (next: WhatsAppConversation) => void
}) {
  const { t } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [tags, setTags] = useState<WhatsAppTag[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState<string>('blue')
  const box = useRef<HTMLDivElement>(null)
  const current = conversation.tags ?? []
  const canSend = can('whatsapp.send')
  const canManage = can('whatsapp.config')

  useEffect(() => {
    if (!open) return
    const fechar = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', fechar)
    return () => document.removeEventListener('mousedown', fechar)
  }, [open])

  const abrir = async () => {
    setOpen((v) => !v)
    if (tags) return
    const res = await whatsappAPI.listTags()
    if (res.success && res.data) {
      setTags(res.data)
      setNewColor(nextTagColor(res.data.map((tag) => tag.color)))
    }
  }

  const aplicar = async (ids: number[]) => {
    setSaving(true)
    try {
      const res = await whatsappAPI.setConversationTags(conversation.id, ids)
      if (res.success && res.data) onChange(res.data)
      else toast.error(whatsappErrorMessage(t, res.code))
    } finally {
      setSaving(false)
    }
  }

  const alternar = (tag: WhatsAppTag) => {
    const ids = current.map((c) => c.id)
    void aplicar(ids.includes(tag.id) ? ids.filter((id) => id !== tag.id) : [...ids, tag.id])
  }

  const problema = tags ? tagNameProblem(newName, tags) : null
  const criar = async () => {
    if (!tags || problema) return
    setSaving(true)
    try {
      const res = await whatsappAPI.createTag({ name: cleanTagName(newName), color: newColor })
      if (!res.success || !res.data) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      const proximas = [...tags, res.data].sort((a, b) => a.name.localeCompare(b.name))
      setTags(proximas)
      setNewName('')
      setNewColor(nextTagColor(proximas.map((tag) => tag.color)))
      await aplicar([...current.map((c) => c.id), res.data.id])
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="relative flex flex-wrap items-center gap-1.5" ref={box}>
      {current.map((tag) => <TagChip key={tag.id} tag={tag} />)}
      {canSend && (
        <button
          type="button"
          className="inline-flex min-h-7 items-center gap-1 rounded-full border border-dashed border-border px-2 text-[0.68rem] font-semibold text-muted-foreground hover:bg-[hsl(var(--surface-subtle))]"
          aria-expanded={open}
          onClick={() => void abrir()}
        >
          <Icon name="edit" size={11} />
          {t('whatsapp.tags.button')}
        </button>
      )}
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border border-border bg-card p-2 shadow-lg">
          {tags === null ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">{t('common.loading')}</p>
          ) : (
            <ul className="max-h-60 overflow-y-auto">
              {tags.map((tag) => {
                const marcada = current.some((c) => c.id === tag.id)
                return (
                  <li key={tag.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1.5 text-sm hover:bg-[hsl(var(--surface-subtle))]">
                      <input type="checkbox" checked={marcada} disabled={saving} onChange={() => alternar(tag)} />
                      <TagChip tag={tag} />
                    </label>
                  </li>
                )
              })}
              {tags.length === 0 && <li className="px-1.5 py-2 text-xs text-muted-foreground">{t('whatsapp.tags.none')}</li>}
            </ul>
          )}
          {canManage && tags !== null && (
            <div className="mt-2 grid gap-2 border-t border-border pt-2">
              <input
                className="h-8 rounded-md border border-border bg-background px-2 text-xs placeholder:text-muted-foreground"
                placeholder={t('whatsapp.tags.newPlaceholder')}
                maxLength={TAG_NAME_MAX}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void criar() } }}
              />
              <ColorSwatches value={newColor} onChange={setNewColor} />
              {problema === 'taken' && <p className="text-xs text-[hsl(var(--status-danger))]">{t('whatsapp.tags.nameTaken')}</p>}
              <button
                type="button"
                className="modern-button-secondary min-h-8 px-2 py-1 text-xs"
                disabled={saving || problema !== null}
                onClick={() => void criar()}
              >
                {t('whatsapp.tags.create')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Gerenciar a lista: renomear (ao sair do campo), trocar a cor e excluir.
 * Excluir tira a etiqueta de todas as conversas — pede confirmação.
 */
export function TagsManager() {
  const { t } = useTranslation()
  const toast = useToast()
  const [tags, setTags] = useState<WhatsAppTag[] | null>(null)
  const [nomes, setNomes] = useState<Record<number, string>>({})

  useEffect(() => {
    let vivo = true
    void whatsappAPI.listTags().then((res) => {
      if (!vivo || !res.success || !res.data) return
      setTags(res.data)
      setNomes(Object.fromEntries(res.data.map((tag) => [tag.id, tag.name])))
    })
    return () => { vivo = false }
  }, [])

  const salvar = async (tag: WhatsAppTag, patch: { name?: string; color?: string }) => {
    const res = await whatsappAPI.updateTag(tag.id, patch)
    if (res.success && res.data) {
      const salva = res.data
      setTags((atual) => (atual ?? []).map((x) => (x.id === salva.id ? salva : x)))
      setNomes((atual) => ({ ...atual, [salva.id]: salva.name }))
    } else {
      toast.error(whatsappErrorMessage(t, res.code))
      setNomes((atual) => ({ ...atual, [tag.id]: tag.name }))
    }
  }

  const excluir = async (tag: WhatsAppTag) => {
    if (!window.confirm(t('whatsapp.tags.deleteConfirm', { name: tag.name }))) return
    const res = await whatsappAPI.deleteTag(tag.id)
    if (res.success) setTags((atual) => (atual ?? []).filter((x) => x.id !== tag.id))
    else toast.error(whatsappErrorMessage(t, res.code))
  }

  if (tags === null) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  if (tags.length === 0) return <p className="text-sm text-muted-foreground">{t('whatsapp.tags.none')}</p>

  return (
    <ul className="grid gap-3">
      {tags.map((tag) => (
        <li key={tag.id} className="flex flex-wrap items-center gap-3 border-b border-border pb-3">
          <input
            className="modern-input h-9 w-48 max-w-full text-sm"
            aria-label={t('whatsapp.tags.name')}
            maxLength={TAG_NAME_MAX}
            value={nomes[tag.id] ?? tag.name}
            onChange={(event) => setNomes((atual) => ({ ...atual, [tag.id]: event.target.value }))}
            onBlur={() => {
              const nome = cleanTagName(nomes[tag.id] ?? '')
              if (nome && nome !== tag.name) void salvar(tag, { name: nome })
              else setNomes((atual) => ({ ...atual, [tag.id]: tag.name }))
            }}
          />
          <ColorSwatches value={tag.color} onChange={(color) => { if (color !== tag.color) void salvar(tag, { color }) }} />
          <button
            type="button"
            className="icon-button ml-auto"
            aria-label={t('whatsapp.tags.delete', { name: tag.name })}
            title={t('whatsapp.tags.delete', { name: tag.name })}
            onClick={() => void excluir(tag)}
          >
            <Icon name="trash" size={16} />
          </button>
        </li>
      ))}
    </ul>
  )
}
