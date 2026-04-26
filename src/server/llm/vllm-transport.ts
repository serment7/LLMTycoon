// vLLM (OpenAI-compatible) 트랜스포트 (#llm-provider-abstraction)
//
// vLLM 이 제공하는 `/v1/chat/completions` 는 OpenAI 스펙을 그대로 따른다. 즉
// messages 는 { role, content, tool_calls?, tool_call_id? } 이고, 응답은
// choices[0].message 에 { content, tool_calls: [{id, type:'function', function:
// {name, arguments: string}}] } 가 들어 있다. arguments 는 **JSON 문자열** 이라
// 파싱이 필요하다(Ollama 는 객체로 주는 쪽이 많아 서로 다르다).
//
// 출력 토큰 한도 정책 (#llm-output-token-budget):
//   - 매 요청에 모델별 안전 max_tokens 를 자동 주입한다.
//   - finish_reason === 'length' 응답을 받으면 partial 본문을 메시지로 깔고
//     이어쓰기를 자동 호출한다(continueGeneration). 도구 호출이 있으면 이어쓰기
//     루프를 끊고 상위 chatLoop 가 도구를 실행하도록 위임한다.
//   - 누적 출력 토큰이 컨텍스트의 90% 에 도달하면 watchdog 가 더 이상의 이어쓰기
//     를 막는다(remainingBudget === 0).

import type { LLMMessage, ToolCall, ToolDefinition } from './provider';
import type { ChatTransport } from './local-chat';
import {
  continueGeneration,
  continueRounds,
  estimateTokens,
  remainingBudget,
  safeMaxOutputTokens,
  watchdogCeiling,
} from './tokenLimits';

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
    const openAIBase = messages.map(toOpenAIMessage);
    let accumulatedText = '';
    let accumulatedTokens = 0;
    const maxRounds = continueRounds();
    const ceiling = watchdogCeiling(this.model);

    for (let round = 0; round <= maxRounds; round++) {
      const remaining = remainingBudget(this.model, accumulatedTokens);
      if (remaining === 0) {
        // watchdog: 컨텍스트 창의 90% 도달 — 이어쓰기를 자르고 현재까지를 반환.
        console.warn(
          `[vllm:${this.model}] watchdog: 누적 출력 ${accumulatedTokens}토큰이 한계(${ceiling})에 도달, 이어쓰기 중단`,
        );
        break;
      }
      const cap = Math.min(safeMaxOutputTokens(this.model), remaining);

      const reqMessages =
        round === 0 ? openAIBase : continueGeneration(openAIBase, accumulatedText);

      const body: Record<string, unknown> = {
        model: this.model,
        messages: reqMessages,
        stream: false,
        max_tokens: cap,
      };
      // 이어쓰기 라운드에서는 도구 호출을 받지 않는다 — partial 본문 직후에 새 도구
      // 콜이 끼어들면 OpenAI 의 assistant.tool_calls 직렬화 규약과 충돌한다.
      if (tools.length > 0 && round === 0) {
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
      const choice = data.choices?.[0];
      const msg = choice?.message;
      const content = msg?.content ?? '';
      const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((c, i) => ({
        id: c.id ?? `call_${Date.now()}_${i}`,
        name: c.function.name,
        arguments: parseArgs(c.function.arguments),
      }));

      accumulatedText += content;
      accumulatedTokens += estimateTokens(content);

      // 도구 호출이 있으면 이어쓰기는 의미가 없다 — 상위 chatLoop 가 도구 결과를
      // 메시지에 추가한 뒤 다음 chat() 으로 다시 들어온다.
      if (toolCalls.length > 0) {
        return { content: accumulatedText, toolCalls };
      }
      if (choice?.finish_reason !== 'length') {
        return { content: accumulatedText, toolCalls: [] };
      }
      // finish_reason === 'length' → 다음 라운드에서 이어쓰기.
    }

    return { content: accumulatedText, toolCalls: [] };
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
