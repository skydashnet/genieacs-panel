/**
 * Os provedores de IA que o painel sabe falar. Por dentro a conversa tem um
 * formato só, o da OpenAI (`messages` com `system|user|assistant|tool`,
 * `tool_calls`); cada adaptador converte de e para a API do provedor e
 * devolve `{content, toolCalls, message}`.
 */

export const AI_PROVIDER_OPENAI = 'openai-compatible';
export const AI_PROVIDER_ANTHROPIC = 'anthropic';

export const AI_PROVIDERS = {
  [AI_PROVIDER_OPENAI]: {
    id: AI_PROVIDER_OPENAI,
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-4.5-flash'
  },
  [AI_PROVIDER_ANTHROPIC]: {
    id: AI_PROVIDER_ANTHROPIC,
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5-5'
  }
};

export const isAiProvider = (id) => Object.hasOwn(AI_PROVIDERS, id);
export const aiProviderOrDefault = (id) => (isAiProvider(id) ? id : AI_PROVIDER_OPENAI);

const ANTHROPIC_VERSION = '2023-06-01';

const parseArgs = (raw) => {
  try {
    return typeof raw === 'string' ? (raw.trim() ? JSON.parse(raw) : {}) : (raw || {});
  } catch {
    return {};
  }
};

const openai = {
  path: '/chat/completions',
  buildRequest({ apiKey, model, messages, tools, maxTokens }) {
    return {
      headers: { Authorization: `Bearer ${apiKey}` },
      body: {
        model,
        messages,
        temperature: 0.3,
        max_tokens: maxTokens,
        ...(tools?.length ? { tools, tool_choice: 'auto' } : {})
      }
    };
  },
  /** Códigos que a z.ai usa para "sem saldo". */
  isNoBalance: ({ codigo, mensagem }) =>
    codigo === '1113' || /balance|saldo|余额|resource package/i.test(mensagem),
  parse(data) {
    const message = data?.choices?.[0]?.message;
    if (!message || typeof message !== 'object') return null;
    const toolCalls = [];
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const name = call?.function?.name;
      if (!name) continue;
      toolCalls.push({
        id: String(call.id || `call_${toolCalls.length}`),
        name: String(name),
        arguments: parseArgs(call.function.arguments)
      });
    }
    const content = typeof message.content === 'string' ? message.content.trim() : null;
    return { content: content || null, toolCalls, message };
  }
};

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('\n');
  return '';
};

/** Anthropic exige alternar user/assistant: turnos seguidos do mesmo papel viram um. */
function pushTurn(turns, role, blocks) {
  if (!blocks.length) return;
  const last = turns[turns.length - 1];
  if (last && last.role === role) last.content.push(...blocks);
  else turns.push({ role, content: [...blocks] });
}

/** Mensagens no formato OpenAI → `{system, messages}` da Anthropic. */
export function toAnthropicMessages(messages) {
  const system = [];
  const turns = [];
  for (const m of messages || []) {
    if (m.role === 'system') {
      const t = textOf(m.content).trim();
      if (t) system.push(t);
    } else if (m.role === 'assistant') {
      const blocks = [];
      const t = textOf(m.content).trim();
      if (t) blocks.push({ type: 'text', text: t });
      for (const call of m.tool_calls || []) {
        blocks.push({
          type: 'tool_use',
          id: String(call.id),
          name: String(call.function?.name ?? ''),
          input: parseArgs(call.function?.arguments)
        });
      }
      pushTurn(turns, 'assistant', blocks);
    } else if (m.role === 'tool') {
      pushTurn(turns, 'user', [{
        type: 'tool_result',
        tool_use_id: String(m.tool_call_id),
        content: textOf(m.content)
      }]);
    } else {
      const t = textOf(m.content).trim();
      if (t) pushTurn(turns, 'user', [{ type: 'text', text: t }]);
    }
  }
  // A conversa tem de começar por um turno do usuário.
  if (turns.length && turns[0].role !== 'user') turns.unshift({ role: 'user', content: [{ type: 'text', text: '.' }] });
  return { system: system.join('\n\n'), messages: turns };
}

const anthropic = {
  path: '/v1/messages',
  buildRequest({ apiKey, model, messages, tools, maxTokens }) {
    const { system, messages: turns } = toAnthropicMessages(messages);
    return {
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: {
        model,
        max_tokens: maxTokens,
        temperature: 0.3,
        ...(system ? { system } : {}),
        messages: turns,
        ...(tools?.length
          ? {
              tools: tools.map((t) => ({
                name: t.function.name,
                description: t.function.description ?? '',
                input_schema: t.function.parameters ?? { type: 'object', properties: {} }
              })),
              tool_choice: { type: 'auto' }
            }
          : {})
      }
    };
  },
  isNoBalance: ({ mensagem }) => /credit balance|billing/i.test(mensagem),
  parse(data) {
    if (!data || !Array.isArray(data.content)) return null;
    const texts = [];
    const toolCalls = [];
    for (const block of data.content) {
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      else if (block?.type === 'tool_use' && block.name) {
        toolCalls.push({
          id: String(block.id || `call_${toolCalls.length}`),
          name: String(block.name),
          arguments: block.input && typeof block.input === 'object' ? block.input : {}
        });
      }
    }
    const content = texts.join('\n').trim();
    // `message` no formato interno (OpenAI), como o orquestrador espera.
    const message = {
      role: 'assistant',
      content: content || null,
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.arguments) }
            }))
          }
        : {})
    };
    return { content: content || null, toolCalls, message };
  }
};

export const AI_ADAPTERS = { [AI_PROVIDER_OPENAI]: openai, [AI_PROVIDER_ANTHROPIC]: anthropic };
