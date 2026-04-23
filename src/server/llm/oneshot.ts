// 단발 LLM 호출 (server.ts 의 기존 callClaude 대체 지점) (#llm-provider-abstraction)
//
// 입력: prompt + 선택 컨텍스트(agentId/projectId/workspacePath).
// 출력: 최종 assistant 텍스트.
//
// 공급자 분기:
//   - claude-cli : 기존 callClaude 구현을 그대로 호출(server.ts 에서 래퍼 함수를 주입).
//   - ollama/vllm: chatLoop 를 직접 돌려 단일 턴을 완료한다. ctx 가 있으면 LOCAL 도구
//                  셋을 열어 에이전트가 코드 그래프·Git 자동화 API 를 호출할 수 있게 한다.
//
// Claude CLI 구현체는 process.spawn 이 필요해 server.ts 내부의 헬퍼/큐/에러 분류
// 시스템에 의존적이므로, 이 파일에 직접 재구현하지 않고 "주입 가능한" 형태로 열어 둔다.

import { chatLoop } from './local-chat';
import { OllamaTransport } from './ollama-transport';
import { VllmTransport } from './vllm-transport';
import { LOCAL_TOOL_DEFINITIONS } from './tools-adapter';
import { readLLMEnv, type LLMMessage, type OneshotContext } from './provider';

export type ClaudeCliOneshot = (prompt: string, ctx?: OneshotContext) => Promise<string>;

let claudeCliOneshotImpl: ClaudeCliOneshot | null = null;

/**
 * server.ts 가 기동 시 자신의 `callClaude` 구현을 여기에 주입한다. 이렇게 하면 이
 * 모듈이 server.ts 내부 상태(큐·에러 분류)에 순환 의존하지 않으면서도 claude-cli
 * 경로를 공용 oneshot API 뒤로 숨길 수 있다.
 */
export function setClaudeCliOneshot(impl: ClaudeCliOneshot | null): void {
  claudeCliOneshotImpl = impl;
}

/**
 * 공급자 설정에 따라 단발 호출을 분기한다. 호출자는 프로바이더 종류를 몰라도 된다.
 */
export async function callLLMOneshot(prompt: string, ctx?: OneshotContext): Promise<string> {
  const env = readLLMEnv();
  if (env.provider === 'claude-cli') {
    if (!claudeCliOneshotImpl) {
      throw new Error('claude-cli oneshot impl not registered — server.ts 가 setClaudeCliOneshot 로 주입해야 합니다');
    }
    return claudeCliOneshotImpl(prompt, ctx);
  }

  // 로컬 모델 경로: 단발 호출용 메시지 히스토리를 즉석에서 만든다. 시스템 프롬프트는
  // oneshot 경로에선 기본 지시만 얹고, 에이전트 세션의 "persona" 는 createSession
  // 쪽이 담당하도록 책임을 분리한다.
  const messages: LLMMessage[] = [
    { role: 'system', content: '당신은 LLMTycoon 서버가 호출하는 단일 턴 어시스턴트입니다. 답은 한국어로, 간결하게.' },
    { role: 'user', content: prompt },
  ];
  const tools = ctx ? LOCAL_TOOL_DEFINITIONS : [];
  const toolContext = ctx
    ? { agentId: ctx.agentId, projectId: ctx.projectId, port: parseInt(process.env.PORT || '3000', 10) }
    : { agentId: '', projectId: '', port: parseInt(process.env.PORT || '3000', 10) };

  const transport = env.provider === 'ollama'
    ? new OllamaTransport(env.baseUrl, env.model, env.requestTimeoutMs)
    : new VllmTransport(env.baseUrl, env.model, env.apiKey, env.requestTimeoutMs);

  return chatLoop(transport, messages, {
    maxToolIterations: env.maxToolIterations,
    toolContext,
    tools,
  });
}
