// vLLM (OpenAI-compatible) 트랜스포트 (#llm-provider-abstraction)
//
// vLLM 이 제공하는 `/v1/chat/completions` 는 OpenAI 스펙을 그대로 따른다. 즉
// messages 는 { role, content, tool_calls?, tool_call_id? } 이고, 응답은
// choices[0].message 에 { content, tool_calls: [{id, type:'function', function:
// {name, arguments: string}}] } 가 들어 있다. arguments 는 **JSON 문자열** 이라
// 파싱이 필요하다(Ollama 는 객체로 주는 쪽이 많아 서로 다르다).

import type { LLMMessage, ToolCall, ToolDefinition } from './provider';
import type { ChatTransport } from './local-chat';

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: OpenAIMessage; finish_reason?: string }>;
}

export class VllmTransport implements ChatTransport {
  readonly label = 'vllm';

  constructor(
    private baseUrl: string,
    private model: string,
    private apiKey: string,
    private timeoutMs: number,
  ) {}

  async chat(
    messages: LLMMessage[],
    tools: readonly ToolDefinition[],
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(toOpenAIMessage),
      stream: false,
    };
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`vllm ${res.status}: ${text.slice(0, 400)}`);
    }
    const data = (await res.json()) as OpenAIChatResponse;
    const msg = data.choices?.[0]?.message;
    const content = msg?.content ?? '';
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((c, i) => ({
      id: c.id ?? `call_${Date.now()}_${i}`,
      name: c.function.name,
      arguments: parseArgs(c.function.arguments),
    }));
    return { content, toolCalls };
  }
}

function toOpenAIMessage(m: LLMMessage): OpenAIMessage {
  if (m.role === 'tool') {
    return { role: 'tool', content: m.content, tool_call_id: m.toolCallId, name: m.name };
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function parseArgs(a: string | undefined): Record<string, unknown> {
  if (!a) return {};
  try { return JSON.parse(a) as Record<string, unknown>; } catch { return {}; }
}
