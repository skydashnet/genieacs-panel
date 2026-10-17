import { describe, expect, it } from 'vitest'
import { conversationAddress, conversationTitle } from '@/components/whatsapp/conversation-list'
import type { WhatsAppConversation } from '@/lib/api'

const thread = (extra: Partial<WhatsAppConversation>) => ({ id: 7, clientName: null, pushName: null, waPhoneE164: null, waLid: null, ...extra }) as WhatsAppConversation

describe('conversation number shown masked', () => {
  it('masks the number under a name', () => {
    expect(conversationAddress(thread({ clientName: 'Marco', waPhoneE164: '5593981309997' }))).toBe('(93) 98130-9997')
  })

  it('uses the masked number as the title of an unnamed thread, and shows no second line', () => {
    const unnamed = thread({ waPhoneE164: '5593981309997' })
    expect(conversationTitle(unnamed)).toBe('(93) 98130-9997')
    expect(conversationAddress(unnamed)).toBeNull()
  })

  it('leaves a LID or a foreign number as it came', () => {
    expect(conversationAddress(thread({ clientName: 'X', waLid: '123456789012345' }))).toBe('123456789012345')
    expect(conversationAddress(thread({ clientName: 'X', waPhoneE164: '14155550123' }))).toBe('14155550123')
  })
})
