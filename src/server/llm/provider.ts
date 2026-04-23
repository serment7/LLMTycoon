// LLM 프로바이더 추상화 (#llm-provider-abstraction)
//
// 서버가 LLM 을 호출하는 두 가지 경로를 공급자와 무관한 인터페이스 뒤로 숨긴다:
//
//   1. oneshot(prompt, ctx?)   — 단발 호출. server.ts 의 기존 `callClaude` 가 맡던 역할.
//                                ctx 가 있으면 MCP(또는 로컬 모델용 함수 호출) 도구 셋을
//                                열어 주고, 없으면 순수 텍스트 생성만 수행한다.
//
//   2. createSession(init)    — 장기 세션. AgentWorker 처럼 "한 에이전트 = 동일 세션"
//                                으로 컨텍스트를 누적하며 턴을 이어 간다. 반환되는
//                                AgentSession 은 기존 AgentWorker public API 의
//                                상위집합이라 TaskRunner 는 타입만 보고 그대로 쓴다.
//
// 구현체: `claude-cli`, `ollama`, `vllm`. env `LLM_PROVIDER` 로 단일 선택하며 혼용 없음.

import type { ImprovementReport, ImprovementReportCategory } from '../../utils/leaderMessage';

export type LLMProviderName = 'claude-cli' | 'ollama' | 'vllm';

export interface OneshotContext {
  agentId: string;
  projectId: string;
  workspacePath?: string;
}

export interface SessionInit {
  agentId: string;
  projectId: string;
  workspacePath: string;
  port?: number;
  systemPrompt?: string;
  onImprovementReport?: (report: ImprovementReport) => void;
}

export type SessionStatus = 'idle' | 'busy';

// AgentWorker 의 public surface 와 동일. TaskRunner / registry 가 구현체 구분 없이
// 다룰 수 있도록 여기 한곳에서 타입을 고정해 둔다.
export interface AgentSession {
  readonly agentId: string;
  projectId: string;
  workspacePath: string;

  enqueue(prompt: string, taskId?: string): Promise<string>;
  dispose(): void;
  status(): SessionStatus;
  queueLength(): number;
  isIdle(): boolean;
  updateSystemPrompt(next: string | undefined): void;
  setOnImprovementReport(handler: ((report: ImprovementReport) => void) | undefined): void;

  // 바깥(taskRunner) 에서 실패 단계를 워커에 귀속시켜 로깅하거나, 개선 보고를
  // 직접 강제 발행할 때 쓴다. LocalAgentWorker 도 같은 시그니처를 만족시킨다.
  logFailure(entry: string): void;
  getLastFailureLog(): string | null;
  reportImprovementToLeader(
    info: { agentId: string; projectId: string; taskId?: string; text: string },
    override?: {
      summary?: string;
      detail?: string;
      category?: ImprovementReportCategory;
      focusFiles?: string[];
      agentName?: string;
      role?: string;
    },
  ): ImprovementReport | null;
}

export interface LLMProvider {
  readonly name: LLMProviderName;
  oneshot(prompt: string, ctx?: OneshotContext): Promise<string>;
  createSession(init: SessionInit): AgentSession;
}

// ───────────────────────────────── 로컬 모델용 공통 타입 ─────────────────────────────
// Ollama / vLLM 이 OpenAI function-calling 규약을 공유하므로 메시지·툴콜 형태도 공유한다.
// Claude CLI 경로는 자체 stream-json 을 쓰므로 이 타입에 의존하지 않는다.

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type LLMRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LLMMessage {
  role: LLMRole;
  content: string;
  toolCalls?: ToolCall[];  // role='assistant'
  toolCallId?: string;     // role='tool'
  name?: string;           // role='tool' (도구 이름)
}

// 공통 env 파서 — 각 프로바이더가 중복 구현하지 않도록 한곳에서 읽는다.
export function readLLMEnv(): {
  provider: LLMProviderName;
  model: string;
  baseUrl: string;
  apiKey: string;
  maxToolIterations: number;
  requestTimeoutMs: number;
} {
  const raw = (process.env.LLM_PROVIDER || 'claude-cli').trim();
  const provider = (['claude-cli', 'ollama', 'vllm'] as LLMProviderName[]).includes(raw as LLMProviderName)
    ? (raw as LLMProviderName)
    : 'claude-cli';
  // 프로바이더별 기본 엔드포인트/모델.
  const defaults: Record<LLMProviderName, { baseUrl: string; model: string }> = {
    'claude-cli': { baseUrl: '', model: '' },
    ollama: { baseUrl: 'http://localhost:11434', model: 'qwen3.5:9b' },
    vllm: { baseUrl: 'http://localhost:8000', model: '' },
  };
  const d = defaults[provider];
  return {
    provider,
    model: (process.env.LLM_MODEL || d.model).trim(),
    baseUrl: (process.env.LLM_BASE_URL || d.baseUrl).trim(),
    apiKey: (process.env.LLM_API_KEY || '').trim(),
    maxToolIterations: Math.max(1, parseInt(process.env.LLM_MAX_TOOL_ITERATIONS || '10', 10)),
    requestTimeoutMs: Math.max(10_000, parseInt(process.env.LLM_REQUEST_TIMEOUT_MS || '180000', 10)),
  };
}
