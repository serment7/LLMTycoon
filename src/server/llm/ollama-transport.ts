// Ollama HTTP 트랜스포트 (#llm-provider-abstraction)
//
// Ollama 의 `/api/chat` 엔드포인트는 OpenAI 메시지 포맷과 거의 동일하고, 0.3+ 부터
// `tools` 필드와 `message.tool_calls` 응답을 지원한다. 스키마는 약간씩 다르다:
//   - role='tool' 메시지는 { role:'tool', content:'<result>' } 로 전달하며,
//     tool_call_id 가 아니라 "이 메시지가 이전 tool_calls 에 대한 응답"이라는 순서
//     자체로 매칭한다(실전에서는 호출자가 응답 순서를 지키면 충분).
//   - tool_calls 응답은 { id?, function: { name, arguments(obj or string) } } 형태.
//
// 이 트랜스포트는 LLMMessage → Ollama 포맷으로 변환·역변환하고 chatLoop 에 단발
// chat 결과만 돌려준다. 히스토리 소유·루프 제어는 local-chat 에 위임한다.

import type { LLMMessage, ToolCall, ToolDefinition } from './provider';
import type { ChatTransport } from './local-chat';

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id?: string;
    function: { name: string; arguments: Record<string, unknown> | string };
  }>;
}

interface OllamaChatResponse {
  message?: OllamaMessage;
  done?: boolean;
  // usage 파생 통계(prompt_eval_count/eval_count 등)가 실려오지만 현재는 소비자가 없다.
}

export class OllamaTransport implements ChatTransport {
  readonly label = 'ollama';

  constructor(
    private baseUrl: string,
    private model: string,
    private timeoutMs: number,
  ) {}

  async chat(
    messages: LLMMessage[],
    tools: readonly ToolDefinition[],
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const body = {
      model: this.model,
      messages: messages.map(toOllamaMessage),
      // Ollama 는 빈 배열을 주면 함수 호출 모드로 인식하지 않으므로, 없을 땐 필드 자체를 뺀다.
      ...(tools.length > 0 ? { tools: tools.map(toOllamaTool) } : {}),
      stream: false,
      // 긴 시스템 프롬프트 + 히스토리가 모델 컨텍스트 창을 초과하지 않도록 상한을 둔다.
      options: {
        // num_ctx 를 모델 기본값(qwen3.5 는 32k) 에 맡기되, 필요하면 env 로 조정.
        ...(process.env.LLM_NUM_CTX ? { num_ctx: parseInt(process.env.LLM_NUM_CTX, 10) } : {}),
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ollama ${res.status}: ${text.slice(0, 400)}`);
    }
    const raw = await res.text();
    // 드리프트 디버깅용 — env LLM_DEBUG_RAW=1 일 때만 원본 응답을 stderr 에 덤프한다.
    // 로컬 모델이 tool_calls 필드를 실제로 채우는지, 아니면 content 로 흘리는지
    // 눈으로 확인하는 용도. 기본값 off — 운영 로그를 오염시키지 않기 위해.
    if (process.env.LLM_DEBUG_RAW === '1') {
      console.warn(
        `[ollama:${this.model}] raw response (first 1200 chars):\n${raw.slice(0, 1200)}`,
      );
    }
    let data: OllamaChatResponse;
    try {
      data = JSON.parse(raw) as OllamaChatResponse;
    } catch (e) {
      throw new Error(`ollama: JSON 파싱 실패 (${(e as Error).message}): ${raw.slice(0, 200)}`);
    }
    const content = data.message?.content ?? '';
    const toolCalls: ToolCall[] = (data.message?.tool_calls ?? []).map((c, i) => ({
      id: c.id ?? `call_${Date.now()}_${i}`,
      name: c.function.name,
      arguments: normalizeArgs(c.function.arguments),
    }));
    return { content, toolCalls };
  }
}

function toOllamaMessage(m: LLMMessage): OllamaMessage {
  const base: OllamaMessage = { role: m.role, content: m.content || '' };
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    base.tool_calls = m.toolCalls.map(tc => ({
      id: tc.id,
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return base;
}

function toOllamaTool(t: ToolDefinition): unknown {
  return {
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

function normalizeArgs(a: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (!a) return {};
  if (typeof a === 'string') {
    try { return JSON.parse(a) as Record<string, unknown>; } catch { return {}; }
  }
  return a;
}
