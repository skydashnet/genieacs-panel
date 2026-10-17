'use client'

import { useCallback, useEffect, useState } from 'react'
import { platformAPI, type CataloguePropagation, type DefaultCatalogue } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTenant } from '@/contexts/tenant-context'
import { useTranslation } from '@/contexts/language-context'
import { platformBoxUrl } from '@/lib/shell'

/**
 * O catálogo de equipamentos que um provedor novo herda.
 *
 * Até a onda que trouxe esta tela, a herança vinha do provedor de MENOR ID que
 * tivesse catálogo — o que fazia do primeiro ISP a referência de todos os
 * próximos sem ninguém ter decidido isso. Agora a fonte é a caixa da
 * plataforma, e esta aba é onde se confere que é mesmo ela.
 *
 * **Por que isso importa e não é cosmético:** do catálogo saem os caminhos de
 * parâmetro que o painel ESCREVE no aparelho. Um provedor sem catálogo tem a
 * troca de senha de WiFi caindo numa lista de caminhos adivinhados — inclusive
 * quando quem troca é o próprio assinante, pelo portal — e o provisionamento
 * parando de escrever VLAN e service list. Nada disso dá erro: a tela só fica
 * errada, e ninguém liga o sintoma à causa.
 *
 * **A leitura é só leitura, de propósito.** Editar o catálogo padrão é editar o catálogo da
 * caixa, nas telas de Configuração que já existem e funcionam. Reconstruí-las
 * aqui seria uma segunda forma de escrever a mesma coisa — e a segunda forma é
 * a que fica para trás.
 *
 * O que esta tela tem que as de lá não podem ter: **quem está sem catálogo**.
 * Nenhum provedor enxerga os outros, então esse fato não existe em tela alguma.
 *
 * E o **reenvio**: a cópia do catálogo só acontecia no dia em que o provedor
 * nascia, então um perfil que a plataforma cadastrasse depois não chegava a
 * ninguém. "Enviar atualizações" leva o que falta; o que o provedor ajustou
 * fica dele, a menos que se peça para sobrescrever.
 */

function Linha({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-2">
      <dt className="text-sm text-muted-foreground">{rotulo}</dt>
      <dd className="text-sm font-medium text-foreground">{children}</dd>
    </div>
  )
}

export function DefaultCatalogueTab() {
  const { t } = useTranslation()
  const { tenant } = useTenant()
  const toast = useToast()
  const [info, setInfo] = useState<DefaultCatalogue | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [propagating, setPropagating] = useState(false)
  const [lastRun, setLastRun] = useState<CataloguePropagation[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await platformAPI.catalogue()
    if (res.success && res.data) {
      setInfo(res.data)
      setError(null)
    } else {
      setError(res.message || '')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const propagar = async () => {
    if (overwrite && !window.confirm(t('catalogue.propagate.overwriteConfirm'))) return
    setPropagating(true)
    try {
      const res = await platformAPI.propagateCatalogue({ overwrite })
      if (res.success && res.data) {
        setLastRun(res.data.results)
        const added = res.data.results.reduce((n, r) => n + r.added, 0)
        const updated = res.data.results.reduce((n, r) => n + r.updated, 0)
        toast.success(t('catalogue.propagate.done', { added, updated, providers: res.data.results.length }))
        void load()
      } else {
        toast.error(res.message || t('catalogue.propagate.failed'))
      }
    } finally {
      setPropagating(false)
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  if (error !== null) return <p className="text-sm text-destructive">{error || t('catalogue.loadFailed')}</p>
  if (!info) return null

  const editar = platformBoxUrl({
    slug: info.box?.slug,
    panelBaseDomain: tenant?.panelBaseDomain,
    path: '/settings'
  })
  const vazios = info.providers.filter((p) => p.rows === 0)

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <section className="modern-card p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="section-heading">{t('catalogue.sourceTitle')}</h2>
          <button type="button" className="modern-button-secondary" onClick={() => void load()}>
            <Icon name="refresh" size={17} />
            {t('common.refresh')}
          </button>
        </div>

        {info.source === 'platform' && (
          <>
            <p className="mt-2 text-lg font-semibold text-foreground">{info.sourceTenant?.name}</p>
            <p className="field-hint mt-1">{t('catalogue.fromPlatform')}</p>
          </>
        )}

        {/* O recuo. Não é erro — é o estado de todo install de um provedor só, e
            de todo deploy hospedado que ainda não criou a caixa. Mas num deploy
            com vários ISPs é exatamente o defeito que esta aba veio mostrar:
            um cliente sendo a referência dos outros. */}
        {info.source === 'provider' && (
          <>
            <p className="mt-2 text-lg font-semibold text-foreground">{info.sourceTenant?.name}</p>
            <p className="field-hint mt-1">{t('catalogue.fromProvider')}</p>
            {!info.box && (
              <>
                <p className="mt-3 text-sm text-muted-foreground">{t('catalogue.boxAbsent')}</p>
                <code className="mt-2 block overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
                  node scripts/create-platform-tenant.js
                </code>
              </>
            )}
          </>
        )}

        {/* Ninguém tem catálogo: a instalação é nova e ninguém cadastrou nada
            ainda. Não há o que copiar, e é por isso que não há o que consertar. */}
        {info.source === 'none' && <p className="field-hint mt-2">{t('catalogue.fromNobody')}</p>}

        <dl className="mt-4 divide-y divide-border border-t border-border">
          <Linha rotulo={t('catalogue.vendorCount')}>{info.defaults.vendors}</Linha>
          <Linha rotulo={t('catalogue.rowCount')}>{info.defaults.rows}</Linha>
        </dl>

        {editar ? (
          <a href={editar} target="_blank" rel="noopener noreferrer" className="modern-button mt-4">
            <Icon name="settings" size={17} />
            {t('catalogue.edit')}
          </a>
        ) : (
          <p className="field-hint mt-4">
            {info.box ? t('catalogue.editSingleHost') : t('catalogue.editNoBox')}
          </p>
        )}
      </section>

      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('catalogue.vendorsTitle')}</h2>
        {info.defaults.vendorNames.length === 0 ? (
          /* Zero fabricantes com linhas > 0 é o caso que "vazio é a soma das
             três tabelas" produz: uma configuração de WiFi sobrando mantém o
             catálogo "existindo", e os provedores novos nascem sem fabricante
             nenhum. Invisível até esta linha. */
          <p className="field-hint mt-2">{t('catalogue.noVendors')}</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {info.defaults.vendorNames.map((v) => (
              <li key={v.name} className="flex items-center justify-between gap-3">
                <span className="text-sm text-foreground">{v.name}</span>
                {!v.enabled && <span className="modern-badge-warning">{t('catalogue.disabled')}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {info.source === 'platform' && (
        <section className="modern-card p-5 sm:p-6 lg:col-span-2">
          <h2 className="section-heading">{t('catalogue.propagate.title')}</h2>
          <p className="field-hint mt-1">{t('catalogue.propagate.description')}</p>
          <label className="mt-4 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            <span>{t('catalogue.propagate.overwrite')}</span>
          </label>
          <button
            type="button"
            className="modern-button mt-4"
            disabled={propagating}
            onClick={() => void propagar()}
          >
            <Icon name="refresh" size={17} />
            {propagating ? t('catalogue.propagate.running') : t('catalogue.propagate.button')}
          </button>
          {lastRun && lastRun.some((r) => r.added || r.updated) && (
            <ul className="mt-4 space-y-1 text-sm">
              {lastRun.filter((r) => r.added || r.updated).map((r) => (
                <li key={r.tenantId} className="text-muted-foreground">
                  <span className="font-medium text-foreground">{r.slug}</span>
                  {' · '}
                  {t('catalogue.propagate.row', { added: r.added, updated: r.updated })}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="modern-card p-5 sm:p-6 lg:col-span-2">
        <h2 className="section-heading">{t('catalogue.providersTitle')}</h2>
        <p className="field-hint mt-1">{t('catalogue.providersHint')}</p>
        {vazios.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t('catalogue.allCovered')}</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {vazios.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{p.name}</p>
                  <p className="text-xs text-muted-foreground">{p.slug}</p>
                </div>
                <span className="modern-badge-warning">{t('catalogue.empty')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export default DefaultCatalogueTab
