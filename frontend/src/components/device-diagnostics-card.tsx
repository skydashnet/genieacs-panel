import { useCallback, useEffect, useRef, useState } from 'react'
import {
  devicesAPI,
  type DeviceDiagnosticKind,
  type DeviceDiagnosticResult
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import {
  DIAGNOSTIC_POLL_MS,
  diagnosticPhase,
  isValidDiagnosticHost,
  pingLossPercent,
  type DiagnosticPhase
} from '@/lib/device-diagnostics'

type Estado =
  | { tipo: 'parado' }
  | { tipo: 'rodando'; inicio: number }
  | { tipo: 'na-fila' }
  | { tipo: 'fim'; fase: Exclude<DiagnosticPhase, 'running'> }
  | { tipo: 'ultimo' }
  | { tipo: 'falha-pedido'; mensagem: string }

/**
 * Ping e traceroute que saem da própria ONT.
 *
 * A tela pede, e então pergunta a cada cinco segundos até a ONT responder, dar
 * erro, ou o prazo passar. Com a ONT fora do ar o pedido fica na fila do ACS —
 * e aí a tela não espera: diz isso e oferece ler o último resultado depois,
 * com a hora em que ele foi medido, para ninguém ler o resultado de ontem como
 * se fosse de agora.
 */
export function DeviceDiagnosticsCard({ deviceId }: { deviceId: string }) {
  const { t, formatDateTime } = useTranslation()
  const [kind, setKind] = useState<DeviceDiagnosticKind>('ping')
  const [host, setHost] = useState('')
  const [estado, setEstado] = useState<Estado>({ tipo: 'parado' })
  const [result, setResult] = useState<DeviceDiagnosticResult | null>(null)
  const [enviando, setEnviando] = useState(false)
  const vivo = useRef(true)

  useEffect(() => {
    vivo.current = true
    return () => {
      vivo.current = false
    }
  }, [])

  const hostValido = isValidDiagnosticHost(host)
  const rodando = estado.tipo === 'rodando'

  // A consulta periódica: uma leitura por vez, a próxima só depois de a
  // anterior voltar, e nada depois que o cartão sai da tela.
  useEffect(() => {
    if (estado.tipo !== 'rodando') return undefined
    let cancelado = false
    const timer = window.setTimeout(async () => {
      let lido: DeviceDiagnosticResult | null = null
      try {
        const res = await devicesAPI.readDiagnostic(deviceId, kind)
        if (res.success && res.data) lido = res.data
      } catch {
        lido = null
      }
      if (cancelado || !vivo.current) return
      if (lido) setResult(lido)
      const fase = diagnosticPhase(lido, estado.inicio, Date.now())
      setEstado(fase === 'running' ? { tipo: 'rodando', inicio: estado.inicio } : { tipo: 'fim', fase })
    }, DIAGNOSTIC_POLL_MS)
    return () => {
      cancelado = true
      window.clearTimeout(timer)
    }
  }, [estado, deviceId, kind])

  const rodar = useCallback(async () => {
    if (!hostValido) return
    setEnviando(true)
    setResult(null)
    try {
      const res = await devicesAPI.startDiagnostic(deviceId, kind, host.trim())
      if (!vivo.current) return
      if (!res.success || !res.data) {
        setEstado({ tipo: 'falha-pedido', mensagem: res.message || t('detail.diagnostics.failed') })
      } else if (res.data.queued) {
        setEstado({ tipo: 'na-fila' })
      } else {
        setEstado({ tipo: 'rodando', inicio: Date.now() })
      }
    } catch {
      if (vivo.current) setEstado({ tipo: 'falha-pedido', mensagem: t('detail.diagnostics.failed') })
    } finally {
      if (vivo.current) setEnviando(false)
    }
  }, [deviceId, kind, host, hostValido, t])

  const verUltimo = useCallback(async () => {
    setEnviando(true)
    try {
      const res = await devicesAPI.readDiagnostic(deviceId, kind)
      if (!vivo.current) return
      if (res.success && res.data) {
        setResult(res.data)
        setEstado({ tipo: 'ultimo' })
      } else {
        setEstado({ tipo: 'falha-pedido', mensagem: res.message || t('detail.diagnostics.failed') })
      }
    } catch {
      if (vivo.current) setEstado({ tipo: 'falha-pedido', mensagem: t('detail.diagnostics.failed') })
    } finally {
      if (vivo.current) setEnviando(false)
    }
  }, [deviceId, kind, t])

  const trocarTipo = (proximo: DeviceDiagnosticKind) => {
    if (rodando) return
    setKind(proximo)
    setResult(null)
    setEstado({ tipo: 'parado' })
  }

  const mensagemDeErro = (codigo: string | null) => {
    if (codigo === 'Error_CannotResolveHostName') return t('detail.diagnostics.error.resolve')
    if (codigo === 'Error_NoRouteToHost') return t('detail.diagnostics.error.noRoute')
    return t('detail.diagnostics.error.other', { code: codigo || '—' })
  }

  const mostraResultado = result && (estado.tipo === 'fim' || estado.tipo === 'ultimo')

  return (
    <section className="modern-card p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <Icon name="signal" className="mt-0.5 text-primary" />
        <div>
          <h2 className="section-heading">{t('detail.diagnostics.title')}</h2>
          <p className="section-description">{t('detail.diagnostics.description')}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div role="radiogroup" aria-label={t('detail.diagnostics.title')} className="flex rounded-lg border border-border p-0.5">
          {(['ping', 'traceroute'] as const).map((opcao) => (
            <button
              key={opcao}
              type="button"
              role="radio"
              aria-checked={kind === opcao}
              disabled={rodando}
              onClick={() => trocarTipo(opcao)}
              className={`min-h-10 rounded-md px-3 py-1.5 text-sm font-medium transition-colors sm:min-h-0 ${
                kind === opcao ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(opcao === 'ping' ? 'detail.diagnostics.kind.ping' : 'detail.diagnostics.kind.traceroute')}
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1 basis-full sm:min-w-56 sm:basis-0">
          <label htmlFor="diagnostic-host" className="field-label">{t('detail.diagnostics.host')}</label>
          <input
            id="diagnostic-host"
            type="text"
            autoComplete="off"
            spellCheck={false}
            className="modern-input w-full font-mono"
            placeholder={t('detail.diagnostics.hostPlaceholder')}
            value={host}
            disabled={rodando}
            onChange={(event) => setHost(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && hostValido && !rodando && !enviando) void rodar()
            }}
          />
        </div>
        <button
          type="button"
          className="modern-button"
          disabled={!hostValido || rodando || enviando}
          onClick={() => void rodar()}
        >
          <Icon name={rodando ? 'refresh' : 'signal'} size={16} className={rodando ? 'animate-spin' : undefined} />
          {rodando ? t('detail.diagnostics.runningShort') : t('detail.diagnostics.run')}
        </button>
        <button
          type="button"
          className="modern-button-secondary"
          disabled={rodando || enviando}
          onClick={() => void verUltimo()}
        >
          {t('detail.diagnostics.showLast')}
        </button>
      </div>
      {host.trim() !== '' && !hostValido && (
        <p className="field-hint mt-2 text-[hsl(var(--status-danger))]">{t('detail.diagnostics.hostInvalid')}</p>
      )}

      <div aria-live="polite" className="mt-4 space-y-3 text-sm">
        {rodando && <p className="text-muted-foreground">{t('detail.diagnostics.running')}</p>}
        {estado.tipo === 'na-fila' && (
          <p className="text-[hsl(var(--status-warning))]">{t('detail.diagnostics.queued')}</p>
        )}
        {estado.tipo === 'falha-pedido' && (
          <p className="text-[hsl(var(--status-danger))]">{estado.mensagem}</p>
        )}
        {estado.tipo === 'fim' && estado.fase === 'timedOut' && (
          <p className="text-[hsl(var(--status-warning))]">{t('detail.diagnostics.timedOut')}</p>
        )}

        {mostraResultado && result.state === 'idle' && (
          <p className="text-muted-foreground">{t('detail.diagnostics.none')}</p>
        )}
        {estado.tipo === 'ultimo' && result?.state === 'running' && (
          <p className="text-muted-foreground">{t('detail.diagnostics.stillRunning')}</p>
        )}
        {mostraResultado && result.state === 'error' && (
          <p className="text-[hsl(var(--status-danger))]">{mensagemDeErro(result.error)}</p>
        )}
        {mostraResultado && result.state === 'complete' && result.ping && (
          <PingResultado ping={result.ping} />
        )}
        {mostraResultado && result.state === 'complete' && result.hops && (
          <TracerouteResultado hops={result.hops} responseTime={result.responseTime} />
        )}
        {mostraResultado && result.state !== 'idle' && (result.host || result.measuredAt) && (
          <p className="text-xs text-muted-foreground">
            {result.host && <span className="break-all font-mono">{result.host}</span>}
            {result.host && result.measuredAt && ' · '}
            {result.measuredAt && t('detail.diagnostics.measuredAt', { when: formatDateTime(result.measuredAt) })}
          </p>
        )}
      </div>
    </section>
  )
}

function PingResultado({ ping }: { ping: NonNullable<DeviceDiagnosticResult['ping']> }) {
  const { t } = useTranslation()
  const perda = pingLossPercent(ping)
  const total = (ping.success ?? 0) + (ping.failure ?? 0)
  const tom = perda === null ? 'text-foreground'
    : perda === 0 ? 'text-[hsl(var(--status-success))]'
      : perda < 100 ? 'text-[hsl(var(--status-warning))]'
        : 'text-[hsl(var(--status-danger))]'
  return (
    <div className="space-y-1">
      <p className={`font-medium ${tom}`}>
        {t('detail.diagnostics.ping.summary', {
          success: String(ping.success ?? '—'),
          total: String(total),
          loss: perda === null ? '—' : String(perda)
        })}
      </p>
      {ping.average !== null && (
        <p className="text-muted-foreground">
          {t('detail.diagnostics.ping.times', {
            avg: String(ping.average),
            min: String(ping.minimum ?? '—'),
            max: String(ping.maximum ?? '—')
          })}
        </p>
      )}
    </div>
  )
}

function TracerouteResultado({ hops, responseTime }: { hops: NonNullable<DeviceDiagnosticResult['hops']>; responseTime: number | null }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{t('detail.diagnostics.trace.hop')}</th>
              <th className="px-3 py-2 font-medium">{t('detail.diagnostics.trace.host')}</th>
              <th className="px-3 py-2 font-medium">{t('detail.diagnostics.trace.times')}</th>
            </tr>
          </thead>
          <tbody>
            {hops.map((hop) => {
              const nome = hop.host && hop.host !== hop.address ? hop.host : null
              const semResposta = hop.times.length === 0
              return (
                <tr key={hop.hop} className="border-t border-border">
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">{hop.hop}</td>
                  <td className="break-all px-3 py-2 font-mono">
                    {hop.address || nome || '*'}
                    {nome && hop.address && <span className="ml-2 text-muted-foreground">{nome}</span>}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {semResposta ? <span className="text-muted-foreground">{t('detail.diagnostics.trace.noReply')}</span> : hop.times.join(' · ')}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {hops.length === 0 && <p className="text-muted-foreground">{t('detail.diagnostics.trace.empty')}</p>}
      {responseTime !== null && (
        <p className="text-xs text-muted-foreground">{t('detail.diagnostics.trace.total', { ms: String(responseTime) })}</p>
      )}
    </div>
  )
}
