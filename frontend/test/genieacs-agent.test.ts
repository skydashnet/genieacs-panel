import { describe, expect, it } from 'vitest'
import {
  AGENT_POLL_MS,
  agentFileUrl,
  agentPhase,
  connectedSince,
  installCommand,
  keyAction,
  keyButtonState,
  modeOptions,
  offlineMessageKey,
  pollBackoffMs,
  type AgentStatusShape
} from '../src/lib/genieacs-agent'
import en from '../src/lib/i18n/locales/en'
import ptBR from '../src/lib/i18n/locales/pt-BR'

const status = (over: Partial<AgentStatusShape> = {}): AgentStatusShape => ({
  tokenHint: 'abcd',
  tokenCreatedAt: '2026-09-20T10:00:00.000Z',
  connected: false,
  connectedAt: null,
  lastSeenAt: null,
  version: null,
  ...over
})

describe('agentPhase', () => {
  it('conectado ganha de tudo, inclusive de um estado sem chave', () => {
    expect(agentPhase(status({ connected: true, lastSeenAt: '2026-09-27T10:00:00Z' }))).toBe('connected')
    // Se o servidor diz que há conexão, ela existe: é isso que decide se os pedidos passam.
    expect(agentPhase(status({ connected: true, tokenHint: null }))).toBe('connected')
  })

  it('sem chave é "sem chave", e não "nunca conectou"', () => {
    expect(agentPhase(status({ tokenHint: null }))).toBe('no-key')
    // Uma chave trocada não existe (gerar outra substitui): sem `tokenHint`, a data velha não conta.
    expect(agentPhase(status({ tokenHint: null, lastSeenAt: '2026-09-01T00:00:00Z' }))).toBe('no-key')
    expect(agentPhase(null)).toBe('no-key')
    expect(agentPhase(undefined)).toBe('no-key')
  })

  it('com chave e já visto, desconectado', () => {
    expect(agentPhase(status({ lastSeenAt: '2026-09-26T08:00:00Z' }))).toBe('disconnected')
  })

  it('com chave e nunca visto — ou visto numa data que não é data —, nunca conectou', () => {
    expect(agentPhase(status())).toBe('never')
    expect(agentPhase(status({ lastSeenAt: '' }))).toBe('never')
    expect(agentPhase(status({ lastSeenAt: 'ontem' }))).toBe('never')
  })
})

describe('connectedSince', () => {
  it('é o connectedAt da conexão aberta', () => {
    expect(connectedSince(status({ connected: true, connectedAt: '2026-09-01T08:00:00Z', lastSeenAt: '2026-09-27T12:00:00Z' })))
      .toBe('2026-09-01T08:00:00Z')
  })

  it('nunca o lastSeenAt, que anda a cada batimento', () => {
    expect(connectedSince(status({ connected: true, connectedAt: null, lastSeenAt: '2026-09-27T12:00:00Z' }))).toBeNull()
  })

  it('sem conexão, não há "desde"', () => {
    expect(connectedSince(status({ connected: false, connectedAt: '2026-09-01T08:00:00Z' }))).toBeNull()
  })
})

describe('keyAction', () => {
  it('sem chave gera; com chave, "gerar outra" (que pede confirmação)', () => {
    expect(keyAction(status({ tokenHint: null }))).toBe('generate')
    expect(keyAction(null)).toBe('generate')
    expect(keyAction(status())).toBe('regenerate')
    expect(keyAction(status({ connected: true }))).toBe('regenerate')
  })
})

describe('installCommand / agentFileUrl', () => {
  it('monta o comando a partir da origem do painel', () => {
    expect(installCommand('https://painel.exemplo.com.br'))
      .toBe('curl -fsSL https://painel.exemplo.com.br/api/genieacs-agent/install.sh | sudo bash')
    expect(agentFileUrl('https://painel.exemplo.com.br'))
      .toBe('https://painel.exemplo.com.br/api/genieacs-agent/agent.mjs')
  })

  it('não dobra a barra quando a origem vem com barra no fim', () => {
    expect(installCommand('http://10.0.0.5:3000/')).toBe('curl -fsSL http://10.0.0.5:3000/api/genieacs-agent/install.sh | sudo bash')
    expect(agentFileUrl('http://10.0.0.5:3000//')).toBe('http://10.0.0.5:3000/api/genieacs-agent/agent.mjs')
  })

  it('nunca leva a chave: o instalador a pede, e o comando vai para o histórico do shell', () => {
    const cmd = installCommand('https://p.exemplo.com')
    expect(cmd).not.toMatch(/sgpa_|AGENT_TOKEN|token=/i)
  })
})

describe('offlineMessageKey', () => {
  it('com data, a frase do "última conexão"; sem data, a do "nunca se conectou"', () => {
    expect(offlineMessageKey('2026-09-27T07:00:00Z')).toBe('api.acsAgentOffline')
    expect(offlineMessageKey(null)).toBe('api.acsAgentNeverConnected')
    expect(offlineMessageKey(undefined)).toBe('api.acsAgentNeverConnected')
    expect(offlineMessageKey('não é data')).toBe('api.acsAgentNeverConnected')
  })

  it('as duas chaves existem nos dicionários, e só a primeira tem {when}', () => {
    for (const dict of [en, ptBR]) {
      expect(dict['api.acsAgentOffline']).toContain('{when}')
      expect(dict['api.acsAgentNeverConnected']).not.toContain('{when}')
    }
  })

  it('a frase em volta do "há quanto tempo" não traz "desde": o formatador já diz "há 3 horas"', () => {
    expect(ptBR['api.acsAgentOffline']).not.toMatch(/desde \{when\}/)
    expect(ptBR['genieacsAgent.lastSeen']).not.toMatch(/desde \{when\}/)
  })
})

describe('modeOptions', () => {
  it('no console, os três modos', () => {
    expect(modeOptions('console', false, 'direct')).toEqual(['direct', 'tunnel', 'agent'])
    expect(modeOptions('console', true, 'agent')).toEqual(['direct', 'tunnel', 'agent'])
  })

  it('nas Configurações da instalação própria, Direto ou Agente — sem túnel', () => {
    expect(modeOptions('settings', true, 'direct')).toEqual(['direct', 'agent'])
    expect(modeOptions('settings', true, 'agent')).toEqual(['direct', 'agent'])
  })

  it('um túnel já gravado aparece no fim, para o seletor não mentir "Direto"', () => {
    expect(modeOptions('settings', true, 'tunnel')).toEqual(['direct', 'agent', 'tunnel'])
  })

  it('na SaaS (sem modeEditable), nenhuma opção: o modo é só leitura', () => {
    expect(modeOptions('settings', false, 'agent')).toEqual([])
    expect(modeOptions('settings', false, 'direct')).toEqual([])
  })
})

describe('keyButtonState', () => {
  it('quem não pode gravar não vê o botão', () => {
    expect(keyButtonState({ canWrite: false, savedMode: 'agent' })).toBe('hidden')
    expect(keyButtonState({ canWrite: false, savedMode: 'direct' })).toBe('hidden')
  })

  it('vale o modo GRAVADO: sem salvar o Agente, o botão pede para salvar primeiro', () => {
    expect(keyButtonState({ canWrite: true, savedMode: 'direct' })).toBe('save-first')
    expect(keyButtonState({ canWrite: true, savedMode: 'tunnel' })).toBe('save-first')
    expect(keyButtonState({ canWrite: true, savedMode: 'agent' })).toBe('enabled')
  })
})

describe('pollBackoffMs', () => {
  it('sem falha, sem espera extra', () => {
    expect(pollBackoffMs(0)).toBe(0)
    expect(pollBackoffMs(-1)).toBe(0)
    expect(pollBackoffMs(Number.NaN)).toBe(0)
  })

  it('dobra a cada falha e para no teto', () => {
    expect(pollBackoffMs(1)).toBe(1 * AGENT_POLL_MS)
    expect(pollBackoffMs(2)).toBe(3 * AGENT_POLL_MS)
    expect(pollBackoffMs(3)).toBe(7 * AGENT_POLL_MS)
    expect(pollBackoffMs(4)).toBe(15 * AGENT_POLL_MS)
    expect(pollBackoffMs(40)).toBe(15 * AGENT_POLL_MS)
  })
})
