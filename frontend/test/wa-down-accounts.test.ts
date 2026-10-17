import { describe, expect, it } from 'vitest'
import { downAccounts, downSignature } from '../src/lib/wa-down-accounts'

const conta = (id: number, status: string, patch: Partial<{ label: string | null; phoneE164: string | null }> = {}) => ({
  id,
  name: `skygp_${id}`,
  label: null,
  phoneE164: null,
  status,
  ...patch
})

describe('downAccounts', () => {
  it('só desconectado e expirado contam como caído; pareando não', () => {
    const result = downAccounts([
      conta(1, 'connected'),
      conta(2, 'disconnected', { label: 'Atendimento' }),
      conta(3, 'connecting'),
      conta(4, 'pending'),
      conta(5, 'expired', { phoneE164: '5593981110000' })
    ])
    expect(result).toEqual([
      { id: 2, name: 'Atendimento' },
      { id: 5, name: '+5593981110000' }
    ])
  })

  it('sem apelido nem telefone, usa o nome da instância', () => {
    expect(downAccounts([conta(7, 'disconnected')])).toEqual([{ id: 7, name: 'skygp_7' }])
  })
})

describe('downSignature', () => {
  it('não depende da ordem, e muda quando outro número cai', () => {
    expect(downSignature([{ id: 5, name: 'b' }, { id: 2, name: 'a' }])).toBe('2,5')
    expect(downSignature([{ id: 2, name: 'a' }])).not.toBe(downSignature([{ id: 2, name: 'a' }, { id: 3, name: 'c' }]))
  })
})
