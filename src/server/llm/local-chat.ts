// Ollama / vLLM 공통 tool-call 루프 (#llm-provider-abstraction)
//
// 두 공급자 모두 OpenAI function-calling 규약을 공유하므로, 메시지 히스토리·툴콜
// 루프·종료 조건 로직을 한곳에서 돌려 쓰고, HTTP 어댑터만 공급자별로 분리한다.
//
// 한 번 `chatLoop` 를 호출할 때의 생애주기:
//   1. caller 가 메시지 배열(시스템+유저+(과거턴))을 넘긴다.
//   2. HTTP 로 LLM 을 한 번 호출해 응답을 받는다.
//   3. 응답이 tool_calls 를 포함하면, 각 콜을 executeLocalTool 로 실행해
//      role='tool' 메시지로 히스토리에 추가한다. → 2 로 되돌아간다.
//   4. tool_calls 가 없거나 MAX_TOOL_ITERATIONS 도달 시, 최종 assistant.content 를
//      반환한다. 이 때 메시지 히스토리에는 이 턴의 assistant + tool 메시지가
//      모두 추가된 상태이므로, 호출자가 다음 턴 user 메시지를 push 해서 계속
//      "같은 세션" 을 이어 갈 수 있다.
//
// 이 파일은 "chat 한 번"에 집중한다. 세션 상태(메시지 히스토리, 시스템 프롬프트)는
// LocalAgentWorker 가 소유한다. 단발 호출은 호출 시점에 메시지 배열을 새로 만들어
// 넘기면 된다.

import type { LLMMessage, ToolCall, ToolDefinition } from './provider';
import { executeLocalTool, type LocalToolContext } from './tools-adapter';

export interface ChatTransport {
  /**
   * 단일 완료 호출. 메시지와 도구 정의를 넘기면 next assistant 메시지(= tool_calls
   * 가 있을 수도, content 가 있을 수도 있음)를 돌려 준다. 스트리밍은 안 쓴다 —
   * 에이전트 실행은 이미 큐잉/비동기 드레인으로 실행되므로, 스트리밍 이득이 적고
   * 파서만 복잡해진다.
   */
  chat(messages: LLMMessage[], tools: readonly ToolDefinition[]): Promise<{
    content: string;
    toolCalls: ToolCall[];
  }>;
  /** 공급자 식별 라벨(로그용). */
  readonly label: string;
}

export interface ChatLoopOptions {
  maxToolIterations: number;
  toolContext: LocalToolContext;
  tools: readonly ToolDefinition[];
  /** 주입해 두면 각 라운드의 호출 통계를 관찰할 수 있다. 서버 stats/usage 집계용. */
  onRound?: (round: number, toolCalls: number) => void;
}

/**
 * 히스토리를 in-place 로 확장하면서 tool-call 루프를 돌린다. 루프가 끝나면 최종
 * assistant 메시지의 content 를 반환한다. 호출자(= LocalAgentWorker 또는
 * oneshot 경로) 는 이 히스토리를 세션에 보관해 다음 턴에 재사용한다.
 */
export async function chatLoop(
  transport: ChatTransport,
  messages: LLMMessage[],
  options: ChatLoopOptions,
): Promise<string> {
  for (let round = 0; round < options.maxToolIterations; round++) {
    const { content, toolCalls } = await transport.chat(messages, options.tools);
    // 어시스턴트 메시지를 먼저 기록 — 도구 실행 후 주입되는 tool 메시지와의 순서가
    // OpenAI 규약을 따르도록 한다(assistant tool_calls → tool results → next assistant).
    messages.push({
      role: 'assistant',
      content: content ?? '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    });
    options.onRound?.(round + 1, toolCalls.length);

    // 종료 조건: 도구 호출이 없으면 이번 round 의 content 가 최종 응답이다.
    if (toolCalls.length === 0) {
      return content ?? '';
    }

    // 각 tool_call 을 순차 실행 — 동시 실행은 서버 REST 상태를 충돌시킬 수 있고,
    // 어차피 도구 한 개 한 개가 빨라서 직렬이어도 체감 영향이 거의 없다.
    for (const call of toolCalls) {
      const result = await executeLocalTool(call.name, call.arguments, options.toolContext);
      messages.push({
        role: 'tool',
        content: result,
        toolCallId: call.id,
        name: call.name,
      });
    }
  }
  // 반복 상한 도달 — 마지막 어시스턴트 메시지가 있으면 그 content 를 반환.
  const last = [...messages].reverse().find(m => m.role === 'assistant');
  return last?.content ?? '';
}
