'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router'
import {
  devicesAPI,
  sgpAPI,
  vendorsAPI,
  type DeviceListResponse,
  type SgpContractState,
  type SgpLinkRow,
} from '@/lib/api'
import {
  deviceExportQuery,
  exportIgnoresSgp,
  filtersFromQuery,
  filtersToQuery,
  type DeviceFocusFilter,
  type DeviceStatusFilter,
  type SgpFilter,
} from '@/lib/device-filters'
import { useLoading } from '@/components/ui/loading'
import { useToast } from '@/components/ui/toast'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import { formatDate } from '@/lib/utils'
import { RX_BAND_STYLE, rxBand } from '@/lib/rx-signal'
import { useAuth } from '@/contexts/auth-context'
import { DeviceBatchBar } from '@/components/device-batch-bar'
import {
  BATCH_LIMIT,
  canSelectWholeFilter,
  pageSelectionState,
  toggleOne,
  togglePage,
  type SelectableRow
} from '@/lib/device-batch'
import type { Device, Vendor } from '@/types'
import { summonDeferredMessage } from '@/lib/device-actions'

interface ProcessedDevice extends Device {
  isOnline: boolean
  brand: string
}

/** Matches the backend default; the API caps anything above 100 anyway. */
const PAGE_SIZE = 25
const SEARCH_DEBOUNCE_MS = 300

const SGP_STATE_BADGES: Record<SgpContractState, string> = {
  active: 'modern-badge-success',
  blocked: 'modern-badge-warning',
  cancelled: 'modern-badge-error',
  unknown: 'modern-badge',
}

const SGP_STATE_LABEL_KEYS = {
  active: 'devices.sgp.state.active',
  blocked: 'devices.sgp.state.blocked',
  cancelled: 'devices.sgp.state.cancelled',
  unknown: 'devices.sgp.state.unknown',
} as const

export default function DevicesPage() {
  const [searchParams, setSearchParams] = useSearchParams()

  // Lido UMA vez, na montagem. Depois daqui quem manda é o estado da tela, e a
  // URL o acompanha — ler a query a cada render faria o endereço e os
  // seletores brigarem pelo mesmo valor a cada tecla digitada.
  //
  // Pela MESMA função que o teste de ida e volta exercita. A tela lia campo a
  // campo, por conta própria, e aquele teste provava uma leitura que ela não
  // fazia: um campo novo esquecido aqui passaria verde.
  const [inicial] = useState(() => filtersFromQuery(searchParams))
  const [devices, setDevices] = useState<Device[]>([])
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [paging, setPaging] = useState({ page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 0 })
  const [loading, setLoading] = useState(true)
  const [initialLoad, setInitialLoad] = useState(true)
  const [searchInput, setSearchInput] = useState(inicial.search)
  const [searchTerm, setSearchTerm] = useState(inicial.search)
  const [filterStatus, setFilterStatus] = useState<DeviceStatusFilter>(inicial.status)
  const [page, setPage] = useState(inicial.page)
  const [filterSgp, setFilterSgp] = useState<SgpFilter>(inicial.sgp)
  const [filterFocus, setFilterFocus] = useState<DeviceFocusFilter>(inicial.focus)
  const [sgpLinks, setSgpLinks] = useState<Map<string, SgpLinkRow>>(new Map())
  const [sgpAvailable, setSgpAvailable] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [refreshNonce, setRefreshNonce] = useState(0)

  const loadingCtl = useLoading()
  const toast = useToast()
  const { t, formatDateTime } = useTranslation()
  const { can } = useAuth()
  // Ações em lote: só para quem tem `devices.maintain` — um clique alcança
  // muitos assinantes. Sem a permissão, a lista fica exatamente como era.
  const canBatch = can('devices.maintain')
  // A planilha: só dono e admin (`devices.export`), com o recorte que o
  // servidor sabe aplicar. O filtro do ERP é feito aqui na tela e não entra —
  // a tela diz isso em vez de entregar mais linhas do que mostra.
  const canExport = can('devices.export')
  const [exporting, setExporting] = useState(false)
  // A sincronização da frota com o SGP, a mesma de Configurações → SGP, à mão
  // de quem está olhando a coluna de contratos. `sgp.act`, como a rota exige.
  const canSyncSgp = can('sgp.act')
  const [sgpSyncing, setSgpSyncing] = useState(false)
  const [selected, setSelected] = useState<Map<string, string>>(new Map())
  const [selectingAll, setSelectingAll] = useState(false)

  // Trocar o filtro limpa a seleção: a trilha registra o recorte usado, e uma
  // seleção feita sob outro filtro diria na trilha um recorte que não é o dela.
  useEffect(() => {
    setSelected(new Map())
  }, [searchTerm, filterStatus, filterFocus, filterSgp])

  /**
   * A URL acompanha os filtros.
   *
   * `searchTerm` e não `searchInput`: aquele já passou pelo debounce, então a
   * barra de endereço muda uma vez por busca e não uma vez por tecla. E
   * `replace` em vez de `push` pelo mesmo motivo — trocar um filtro não deve
   * empilhar uma entrada no histórico que o botão voltar tenha que desfazer
   * uma a uma.
   *
   * O default some da URL: `/devices` é a lista inteira, e um endereço cheio de
   * `status=all&page=1` só faz o link ficar feio de mandar para o plantão.
   */
  useEffect(() => {
    setSearchParams(
      filtersToQuery({
        search: searchTerm,
        status: filterStatus,
        sgp: filterSgp,
        focus: filterFocus,
        page
      }),
      { replace: true }
    )
  }, [searchTerm, filterStatus, filterSgp, filterFocus, page, setSearchParams])

  // A faixa sai de `lib/rx-signal`, a mesma leitura e os mesmos limiares do
  // backend que conta o painel. Esta tela tinha uma cópia própria, com
  // `parseFloat` — que lia "-25 dBm" como -25 enquanto o painel contava
  // "desconhecido".
  const getSignalStrengthInfo = (rxPowerStr: unknown) => {
    const estilo = RX_BAND_STYLE[rxBand(rxPowerStr)]
    return { color: estilo.color, label: t(estilo.labelKey), badgeClass: estilo.badgeClass }
  }

  const findBrand = useCallback((manufacturer: string, productClass: string, vendors: Vendor[]) => {
    manufacturer = manufacturer?.toLowerCase() || ''
    productClass = productClass?.toLowerCase() || ''

    const sortedVendors = [...vendors].sort((a, b) => (b.priority || 0) - (a.priority || 0))

    for (const vendor of sortedVendors) {
      const manPatterns = vendor.manufacturer_patterns || []
      const prodPatterns = vendor.product_patterns || []

      const manMatch = manPatterns.some((p: string) => manufacturer.includes(p.toLowerCase()))
      const prodMatch = prodPatterns.some((p: string) => productClass.includes(p.toLowerCase()))

      if (manMatch || prodMatch) {
        return vendor.name
      }
    }

    return manufacturer || 'Unknown'
  }, [])

  const handleSummon = async (e: React.MouseEvent, deviceId: string) => {
    e.preventDefault();
    e.stopPropagation();

    loadingCtl.show(t('devices.summon.loading'));
    try {
      const res = await devicesAPI.summonDevice(deviceId);
      if (res.success && res.data?.reached === false) {
        toast.warning(summonDeferredMessage(res.data, t, formatDateTime, res.message || t('devices.summon.success')));
      } else if (res.success) {
        toast.success(res.message || t('devices.summon.success'));
      } else {
        toast.error(res.message || t('devices.summon.failed'));
      }
    } catch (error: any) {
      toast.error(error.message || t('devices.summon.error'));
    } finally {
      loadingCtl.hide();
    }
  }

  // Typing must not fire a request per keystroke: the search term the API sees
  // only catches up once the operator pauses, and any change restarts paging.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setSearchTerm(searchInput)
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [searchInput])

  // The vendor catalogue only feeds brand resolution, so it is fetched once
  // instead of travelling with every page of devices.
  useEffect(() => {
    let cancelled = false
    vendorsAPI.getAll()
      .then((res) => {
        if (!cancelled && res.success) setVendors((res.data as Vendor[]) || [])
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [refreshNonce])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError('')

    const fetchDevices = async () => {
      try {
        const res = await devicesAPI.getDevices({
          page,
          pageSize: PAGE_SIZE,
          search: searchTerm,
          status: filterStatus,
          focus: filterFocus
        })

        if (cancelled) return

        if (res.success && res.data) {
          const payload = res.data as DeviceListResponse<Device>
          setDevices(payload.devices || [])
          setPaging({
            page: payload.page,
            pageSize: payload.pageSize,
            total: payload.total,
            totalPages: payload.totalPages
          })
          // The API clamps a page past the end; follow it so the controls agree.
          if (payload.page !== page) setPage(payload.page)
        } else if (res.code === 'acs_agent_offline' && res.message) {
          // O GenieACS deste provedor é alcançado pelo agente, e ele caiu: a
          // frase genérica mandaria conferir o endereço, que não é o problema
          // — o problema é a máquina onde o agente roda. `api.ts` já montou a
          // frase com o "há quanto tempo".
          setLoadError(res.message)
        } else {
          setLoadError(t('devices.error.inventory'))
        }
      } catch {
        if (!cancelled) {
          setLoadError(t('devices.error.unreachable'))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
          setInitialLoad(false)
        }
      }
    }

    fetchDevices()

    return () => { cancelled = true }
  }, [page, searchTerm, filterStatus, filterFocus, refreshNonce, t])

  const processedDevices = useMemo<ProcessedDevice[]>(() => {
    const now = new Date()
    return devices.map((item) => {
      const lastInform = item._lastInform ? new Date(item._lastInform) : null
      const lastInformMs = lastInform?.getTime()
      const ageMs = lastInformMs === undefined ? Number.NaN : now.getTime() - lastInformMs
      const isOnline = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 10 * 60 * 1000

      return {
        ...item,
        isOnline,
        brand: findBrand(item.manufacturer || '', item.productclass || 'Unknown', vendors)
      }
    })
  }, [devices, vendors, findBrand])

  // The SGP links load apart from the inventory: when the integration is off
  // (or momentarily unreachable) the panel simply drops the contract column.
  useEffect(() => {
    let cancelled = false

    ;(async () => {
      const res = await sgpAPI.getLinks()
      if (cancelled) return
      if (!res.success || !res.data) {
        setSgpAvailable(false)
        setSgpLinks(new Map())
        return
      }
      setSgpAvailable(true)
      setSgpLinks(new Map((res.data.links || []).map((link) => [link.deviceId, link])))
    })()

    return () => { cancelled = true }
  }, [refreshNonce])

  // Search, status and the dashboard slice are resolved by the API; only the
  // contract state, which the devices endpoint knows nothing about, is narrowed
  // here — and only across the rows of the page that came back.
  const visibleDevices = useMemo<ProcessedDevice[]>(() => {
    if (!sgpAvailable || filterSgp === 'all') return processedDevices
    return processedDevices.filter((device) => {
      const link = sgpLinks.get(device._id)
      return filterSgp === 'unlinked' ? !link : link?.state === filterSgp
    })
  }, [processedDevices, filterSgp, sgpAvailable, sgpLinks])

  const clearFilters = () => {
    setSearchInput('')
    setSearchTerm('')
    setFilterStatus('all')
    setFilterSgp('all')
    setFilterFocus('all')
    setPage(1)
  }

  if (initialLoad) {
    return (
      <div className="page-shell">
        <div className="page-frame">
          <div className="mb-5 h-24 animate-pulse rounded-md bg-muted" />
          <div className="modern-card h-112 animate-pulse bg-muted" aria-label={t('devices.loadingAria')} />
        </div>
      </div>
    )
  }

  const hasFilters = Boolean(searchInput)
    || filterStatus !== 'all'
    || filterSgp !== 'all'
    || filterFocus !== 'all'
  const rangeFrom = paging.total === 0 ? 0 : (paging.page - 1) * paging.pageSize + 1
  const rangeTo = (paging.page - 1) * paging.pageSize + processedDevices.length
  // The contract filter hides rows of the current page, so the server range
  // alone would not explain what is on screen.
  const contractFiltered = visibleDevices.length !== processedDevices.length
  const pageRows: SelectableRow[] = visibleDevices.map((device) => ({ id: device._id, label: device.SerialNumber || device._id }))
  const pageState = pageSelectionState(selected, pageRows)
  const batchFilter: Record<string, string> = {
    ...(searchTerm ? { search: searchTerm } : {}),
    ...(filterStatus !== 'all' ? { status: filterStatus } : {}),
    ...(filterFocus !== 'all' ? { focus: filterFocus } : {})
  }

  // "Todos os N do filtro": busca os ids página a página, no maior tamanho que
  // a API aceita, e para no teto do lote.
  const selectWholeFilter = async () => {
    setSelectingAll(true)
    try {
      const next = new Map(selected)
      for (let pagina = 1; next.size < Math.min(paging.total, BATCH_LIMIT); pagina += 1) {
        const res = await devicesAPI.getDevices({ page: pagina, pageSize: 100, search: searchTerm, status: filterStatus, focus: filterFocus })
        const payload = res.success ? (res.data as DeviceListResponse<Device>) : null
        const linhas = payload?.devices ?? []
        for (const device of linhas) {
          if (next.size >= BATCH_LIMIT) break
          next.set(device._id, device.SerialNumber || device._id)
        }
        if (!payload || linhas.length === 0 || pagina >= payload.totalPages) break
      }
      setSelected(next)
    } catch {
      toast.error(t('devices.batch.selectAllFailed'))
    } finally {
      setSelectingAll(false)
    }
  }

  const DeviceStatus = ({ device }: { device: ProcessedDevice }) => (
    <span className={device.isOnline ? 'modern-badge-success' : 'modern-badge-error'}>
      <span className="status-dot" />
      {device.isOnline ? t('devices.status.online') : t('devices.status.offline')}
    </span>
  )

  const renderSgpCell = (device: ProcessedDevice) => {
    const link = sgpLinks.get(device._id)
    if (!link) {
      return <span className="modern-badge">{t('devices.sgp.unlinked')}</span>
    }
    return (
      <>
        <span className={SGP_STATE_BADGES[link.state]}>{t(SGP_STATE_LABEL_KEYS[link.state])}</span>
        <span className="mt-1 block truncate font-mono text-[0.68rem] text-muted-foreground" title={link.clientName || undefined}>
          {link.contract}{link.clientName ? ` · ${link.clientName}` : ''}
        </span>
      </>
    )
  }

  const exportSheet = async () => {
    setExporting(true)
    try {
      const res = await devicesAPI.exportSheet(deviceExportQuery({ search: searchTerm, status: filterStatus, focus: filterFocus }))
      if (!res.success || !res.blob) {
        toast.error(res.message || t('devices.export.failed'))
        return
      }
      const url = URL.createObjectURL(res.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = res.filename || 'equipamentos.csv'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      if (exportIgnoresSgp({ sgp: filterSgp })) toast.info(t('devices.export.sgpIgnored'))
    } finally {
      setExporting(false)
    }
  }

  const syncSgp = async () => {
    setSgpSyncing(true)
    loadingCtl.show(t('devices.sgpSync.loading'))
    try {
      const res = await sgpAPI.syncAll()
      if (res.success && res.data) {
        toast.success(t('devices.sgpSync.done', {
          linked: res.data.linked,
          created: res.data.created,
          updated: res.data.updated,
          relinked: res.data.relinked ?? 0,
        }))
        // Recarrega a lista e a coluna de contratos: os vínculos acabaram de mudar.
        setRefreshNonce((value) => value + 1)
        return
      }
      if (res.code === 'not_configured') setSgpAvailable(false)
      toast.error(res.message || t('devices.sgpSync.failed'))
    } catch {
      toast.error(t('devices.sgpSync.failed'))
    } finally {
      loadingCtl.hide()
      setSgpSyncing(false)
    }
  }

  return (
    <div className="page-shell">
      <div className="page-frame">
        {/* Até o xl as ações descem para baixo do título: lado a lado, elas
            espremiam o título em duas linhas e a descrição em cinco. */}
        <header className="page-header sm:max-xl:flex-col sm:max-xl:items-stretch">
          <div>
            <p className="page-kicker">{t('devices.kicker')}</p>
            <h1 className="page-title">{t('devices.title')}</h1>
            <p className="page-description">{t('devices.description')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground sm:shrink-0 sm:flex-nowrap sm:gap-3">
            <span className="me-auto whitespace-nowrap sm:me-0"><strong className="data-value">{paging.total}</strong> {t('devices.totalLabel')}</span>
            {canSyncSgp && sgpAvailable && (
              <button
                type="button"
                className="modern-button-secondary whitespace-nowrap px-3 sm:px-4"
                disabled={sgpSyncing}
                onClick={() => void syncSgp()}
                aria-label={t('devices.sgpSync.aria')}
              >
                <Icon name="refresh" size={16} />
                {sgpSyncing ? t('devices.sgpSync.loading') : t('devices.sgpSync.button')}
              </button>
            )}
            {canExport && (
              <button
                type="button"
                className="modern-button-secondary whitespace-nowrap px-3 sm:px-4"
                disabled={exporting}
                onClick={() => void exportSheet()}
                title={exportIgnoresSgp({ sgp: filterSgp }) ? t('devices.export.sgpIgnored') : undefined}
              >
                <Icon name="external" size={16} />
                {t('devices.export.button')}
              </button>
            )}
            <button type="button" onClick={() => setRefreshNonce((value) => value + 1)} className="icon-button" aria-label={t('devices.refreshAria')}>
              <Icon name="refresh" size={18} />
            </button>
          </div>
        </header>

        {loadError ? (
          <section className="modern-card empty-state" role="alert">
            <div className="empty-state-icon text-[hsl(var(--status-danger))]"><Icon name="warning" size={22} /></div>
            <h2 className="empty-state-title">{t('devices.error.title')}</h2>
            <p className="empty-state-copy">{loadError}</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <button type="button" onClick={() => setRefreshNonce((value) => value + 1)} className="modern-button">{t('devices.error.retry')}</button>
              <Link to="/settings" className="modern-button-secondary">{t('devices.error.checkConfig')}</Link>
            </div>
          </section>
        ) : (
          <>
            <section className={`mb-4 grid gap-3 rounded-(--radius) border border-border bg-card p-3 sm:grid-cols-2 lg:items-end ${sgpAvailable ? 'xl:grid-cols-[minmax(14rem,1fr)_11rem_12rem_13rem_auto]' : 'xl:grid-cols-[minmax(16rem,1fr)_12rem_13rem_auto]'}`}>
              <div className="sm:col-span-2 xl:col-span-1">
                <label htmlFor="device-search" className="field-label">{t('devices.filter.searchLabel')}</label>
                <div className="relative">
                  <Icon name="search" size={18} className="pointer-events-none absolute inset-s-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="device-search"
                    type="search"
                    placeholder={t('devices.filter.searchPlaceholder')}
                    className="modern-input ps-10"
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                  />
                </div>
              </div>
              <div>
                <label htmlFor="device-status" className="field-label">{t('devices.filter.statusLabel')}</label>
                <div className="relative">
                  <select
                    id="device-status"
                    className="modern-input appearance-none pe-10"
                    value={filterStatus}
                    onChange={(event) => {
                      setFilterStatus(event.target.value as DeviceStatusFilter)
                      setPage(1)
                    }}
                  >
                    <option value="all">{t('devices.filter.all')}</option>
                    <option value="online">{t('devices.filter.onlineOnly')}</option>
                    <option value="offline">{t('devices.filter.offlineOnly')}</option>
                    <option value="stale">{t('devices.filter.staleOnly')}</option>
                  </select>
                  <Icon name="chevron-down" size={17} className="pointer-events-none absolute inset-e-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>
              {/* Os recortes que o painel aponta. Cada opção daqui é um número
                  daquela tela, e é o servidor quem os cumpre — por isso trocar
                  aqui volta para a página 1, como o status: o recorte muda a
                  lista inteira, não as linhas desta página. */}
              <div>
                <label htmlFor="device-focus" className="field-label">{t('devices.filter.focusLabel')}</label>
                <div className="relative">
                  <select
                    id="device-focus"
                    className="modern-input appearance-none pe-10"
                    value={filterFocus}
                    onChange={(event) => {
                      setFilterFocus(event.target.value as DeviceFocusFilter)
                      setPage(1)
                    }}
                  >
                    <option value="all">{t('devices.filter.focusAll')}</option>
                    <option value="new24h">{t('devices.filter.focusNew24h')}</option>
                    <option value="weak-signal">{t('devices.filter.focusWeakSignal')}</option>
                    <option value="hot">{t('devices.filter.focusHot')}</option>
                    <option value="many-clients">{t('devices.filter.focusManyClients')}</option>
                  </select>
                  <Icon name="chevron-down" size={17} className="pointer-events-none absolute inset-e-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>
              {sgpAvailable && (
                <div>
                  <label htmlFor="device-sgp" className="field-label">{t('devices.sgp.filterLabel')}</label>
                  <div className="relative">
                    <select id="device-sgp" className="modern-input appearance-none pe-10" value={filterSgp} onChange={(event) => setFilterSgp(event.target.value as SgpFilter)}>
                      <option value="all">{t('devices.sgp.filterAll')}</option>
                      <option value="active">{t('devices.sgp.filterActive')}</option>
                      <option value="blocked">{t('devices.sgp.filterBlocked')}</option>
                      <option value="cancelled">{t('devices.sgp.filterCancelled')}</option>
                      <option value="unlinked">{t('devices.sgp.filterUnlinked')}</option>
                    </select>
                    <Icon name="chevron-down" size={17} className="pointer-events-none absolute inset-e-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  </div>
                </div>
              )}
              <div className="flex min-h-11 items-center justify-between gap-3 px-1 text-sm text-muted-foreground sm:col-span-2 xl:col-span-1 xl:justify-end">
                <span>
                  {t('devices.pagination.range', { from: rangeFrom, to: rangeTo, total: paging.total })}
                  {contractFiltered && <> · <strong className="data-value">{visibleDevices.length}</strong> {t('devices.shownLabel')}</>}
                </span>
                {hasFilters && (
                  <button type="button" onClick={clearFilters} className="font-semibold text-primary hover:underline">
                    {t('devices.filter.clear')}
                  </button>
                )}
              </div>
            </section>

            {visibleDevices.length === 0 ? (
              <section className="modern-card empty-state">
                <div className="empty-state-icon"><Icon name={hasFilters ? 'search' : 'server'} size={22} /></div>
                <h2 className="empty-state-title">{hasFilters ? t('devices.empty.filteredTitle') : t('devices.empty.title')}</h2>
                <p className="empty-state-copy">
                  {hasFilters ? t('devices.empty.filteredCopy') : t('devices.empty.copy')}
                </p>
                {hasFilters ? (
                  <button type="button" onClick={clearFilters} className="modern-button-secondary mt-5">{t('devices.filter.clear')}</button>
                ) : (
                  <Link to="/settings" className="modern-button mt-5">{t('devices.empty.checkConnection')}</Link>
                )}
              </section>
            ) : (
              <>
                {canBatch && (
                  <DeviceBatchBar
                    selection={selected}
                    filter={batchFilter}
                    filterTotal={paging.total}
                    canSelectAll={canSelectWholeFilter(paging.total, selected.size, contractFiltered)}
                    selectingAll={selectingAll}
                    onSelectAll={() => void selectWholeFilter()}
                    onClear={() => setSelected(new Map())}
                  />
                )}
                <section className="modern-card desktop-table overflow-hidden" aria-busy={loading}>
                  <div className="max-h-[calc(100vh-18rem)] overflow-auto">
                    <table className="modern-table">
                      <thead>
                        <tr>
                          {canBatch && (
                            <th className="w-10">
                              <input
                                type="checkbox"
                                aria-label={t('devices.batch.selectPage')}
                                checked={pageState === 'all'}
                                ref={(el) => { if (el) el.indeterminate = pageState === 'some' }}
                                onChange={() => setSelected((current) => togglePage(current, pageRows))}
                              />
                            </th>
                          )}
                          <th>{t('devices.table.status')}</th>
                          <th>{t('devices.table.serial')}</th>
                          <th className="hidden xl:table-cell">{t('devices.table.vendorModel')}</th>
                          <th>{t('devices.table.subscriber')}</th>
                          <th className="hidden 3xl:table-cell">{t('devices.table.customerId')}</th>
                          {sgpAvailable && <th className="hidden 3xl:table-cell">{t('devices.sgp.column')}</th>}
                          <th>{t('devices.table.opticalRx')}</th>
                          <th className="hidden 3xl:table-cell">{t('devices.table.lastInform')}</th>
                          <th><span className="sr-only">{t('common.actions')}</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleDevices.map((device) => {
                          const signalInfo = getSignalStrengthInfo(device.rxpower)
                          return (
                            <tr key={device._id}>
                              {canBatch && (
                                <td className="w-10">
                                  <input
                                    type="checkbox"
                                    aria-label={t('devices.batch.selectOne', { device: device.SerialNumber || device._id })}
                                    checked={selected.has(device._id)}
                                    onChange={() => setSelected((current) => toggleOne(current, { id: device._id, label: device.SerialNumber || device._id }))}
                                  />
                                </td>
                              )}
                              <td>
                                <DeviceStatus device={device} />
                                {/* Com o menu lateral, todas as colunas juntas só cabem a partir
                                    de ≈1840 px (3xl). Abaixo disso as escondidas viram segunda
                                    linha: fabricante e modelo até 1280 px (xl); último inform,
                                    ID do cliente e SGP até 3xl. */}
                                <span className="mt-1 block text-[0.68rem] text-muted-foreground 3xl:hidden">{formatDate(device._lastInform)}</span>
                              </td>
                              <td className="max-w-40 xl:max-w-[18rem]">
                                <Link to={`/devices/detail?id=${encodeURIComponent(device._id)}`} className="block break-all font-mono text-sm font-semibold text-primary hover:underline xl:truncate xl:break-normal">
                                  {device.SerialNumber || device._id}
                                </Link>
                                {device.SerialNumber && <span className="mt-1 block break-all font-mono text-[0.68rem] text-muted-foreground xl:truncate xl:break-normal">{device._id}</span>}
                                <span className="mt-0.5 block truncate text-xs text-muted-foreground xl:hidden">{device.brand} · {device.productclass || t('devices.modelNotReported')}</span>
                              </td>
                              <td className="hidden xl:table-cell">
                                <span className="block font-semibold">{device.brand}</span>
                                <span className="mt-0.5 block text-xs text-muted-foreground">{device.productclass || t('devices.modelNotReported')}</span>
                              </td>
                              <td className="max-w-44 break-all font-mono text-xs 3xl:max-w-none 3xl:break-normal">
                                {device.pppoe || t('devices.notReported')}
                                <span className="mt-0.5 block font-semibold text-muted-foreground 3xl:hidden">{device.customerId || t('devices.notGenerated')}</span>
                                {sgpAvailable && <span className="mt-1 block break-normal font-sans 3xl:hidden">{renderSgpCell(device)}</span>}
                              </td>
                              <td className="hidden font-mono text-xs font-semibold 3xl:table-cell">{device.customerId || t('devices.notGenerated')}</td>
                              {sgpAvailable && <td className="hidden max-w-56 3xl:table-cell">{renderSgpCell(device)}</td>}
                              <td>
                                <span className={`font-mono text-sm font-semibold ${signalInfo.color}`}>
                                  {device.rxpower !== null && device.rxpower !== undefined ? `${device.rxpower} dBm` : t('common.na')}
                                </span>
                                <span className="mt-0.5 block text-[0.68rem] text-muted-foreground">{signalInfo.label}</span>
                              </td>
                              <td className="hidden whitespace-nowrap text-xs text-muted-foreground 3xl:table-cell">{formatDate(device._lastInform)}</td>
                              <td>
                                <div className="flex justify-end gap-1">
                                  <button onClick={(event) => handleSummon(event, device._id)} className="icon-button" title={t('devices.summon.title')} aria-label={t('devices.summon.aria', { device: device.SerialNumber || device._id })}>
                                    <Icon name="bell" size={17} />
                                  </button>
                                  <Link to={`/devices/detail?id=${encodeURIComponent(device._id)}`} className="icon-button" aria-label={t('devices.summon.open', { device: device.SerialNumber || device._id })}>
                                    <Icon name="chevron-right" size={17} />
                                  </Link>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="mobile-card-list space-y-3" aria-label={t('devices.title')} aria-busy={loading}>
                  {visibleDevices.map((device) => {
                    const signalInfo = getSignalStrengthInfo(device.rxpower)
                    return (
                      <article key={device._id} className="mobile-data-card">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1">
                              {canBatch && (
                                <label className="-ms-2 flex size-10 shrink-0 cursor-pointer items-center justify-center">
                                  <input
                                    type="checkbox"
                                    className="size-4"
                                    aria-label={t('devices.batch.selectOne', { device: device.SerialNumber || device._id })}
                                    checked={selected.has(device._id)}
                                    onChange={() => setSelected((current) => toggleOne(current, { id: device._id, label: device.SerialNumber || device._id }))}
                                  />
                                </label>
                              )}
                              <DeviceStatus device={device} />
                            </div>
                            <Link to={`/devices/detail?id=${encodeURIComponent(device._id)}`} className="mt-2 block break-all font-mono text-sm font-semibold text-primary">
                              {device.SerialNumber || device._id}
                            </Link>
                            <p className="mt-1 truncate text-xs text-muted-foreground">{device.brand} · {device.productclass || t('devices.unknownModel')}</p>
                          </div>
                          <Link to={`/devices/detail?id=${encodeURIComponent(device._id)}`} className="icon-button shrink-0" aria-label={t('devices.summon.open', { device: device.SerialNumber || device._id })}>
                            <Icon name="chevron-right" size={18} />
                          </Link>
                        </div>
                        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-4 text-sm">
                          <div className="min-w-0"><dt className="text-xs text-muted-foreground">PPPoE</dt><dd className="mt-1 truncate font-mono text-xs">{device.pppoe || t('devices.notReported')}</dd></div>
                          <div className="min-w-0"><dt className="text-xs text-muted-foreground">{t('devices.table.customerId')}</dt><dd className="mt-1 truncate font-mono text-xs font-semibold">{device.customerId || t('devices.notGenerated')}</dd></div>
                          {sgpAvailable && <div className="col-span-2 min-w-0"><dt className="text-xs text-muted-foreground">{t('devices.sgp.column')}</dt><dd className="mt-1">{renderSgpCell(device)}</dd></div>}
                          <div><dt className="text-xs text-muted-foreground">{t('devices.table.opticalRx')}</dt><dd className={`mt-1 font-mono text-xs font-semibold ${signalInfo.color}`}>{device.rxpower ?? t('common.na')}{device.rxpower !== null && device.rxpower !== undefined ? ' dBm' : ''}</dd></div>
                          <div className="col-span-2"><dt className="text-xs text-muted-foreground">{t('devices.table.lastInform')}</dt><dd className="mt-1 text-xs">{formatDate(device._lastInform)}</dd></div>
                        </dl>
                        <button onClick={(event) => handleSummon(event, device._id)} className="modern-button-secondary mt-4 w-full">
                          <Icon name="bell" size={17} /> {t('devices.summon.button')}
                        </button>
                      </article>
                    )
                  })}
                </section>

                <nav className="mt-4 flex flex-wrap items-center justify-between gap-3" aria-label={t('devices.pagination.aria')}>
                  <p className="text-sm text-muted-foreground">
                    {t('devices.pagination.range', { from: rangeFrom, to: rangeTo, total: paging.total })}
                    {contractFiltered && <> · <strong className="data-value">{visibleDevices.length}</strong> {t('devices.shownLabel')}</>}
                  </p>
                  <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-start">
                    <button
                      type="button"
                      className="modern-button-secondary px-3 sm:px-4"
                      onClick={() => setPage((value) => Math.max(1, value - 1))}
                      disabled={loading || paging.page <= 1}
                    >
                      <Icon name="chevron-left" size={17} /> {t('devices.pagination.previous')}
                    </button>
                    <span className="px-1 text-center text-sm text-muted-foreground">
                      {t('devices.pagination.pageOf', { page: paging.page, totalPages: Math.max(1, paging.totalPages) })}
                    </span>
                    <button
                      type="button"
                      className="modern-button-secondary px-3 sm:px-4"
                      onClick={() => setPage((value) => value + 1)}
                      disabled={loading || paging.page >= paging.totalPages}
                    >
                      {t('devices.pagination.next')} <Icon name="chevron-right" size={17} />
                    </button>
                  </div>
                </nav>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
