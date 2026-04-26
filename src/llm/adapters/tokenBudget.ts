// 지시 #89f4628d — vllm/ollama 어댑터 입력 토큰 한도 대응 계층.
//
// 목적
//   로컬 추론 백엔드(vllm/ollama)는 모델별로 컨텍스트 윈도우(`max_input_tokens`) 가
//   고정되어 있어, 호출 직전 입력 합계가 한도를 넘으면 백엔드가 곧바로 truncate 하거나
//   OOM 으로 호출이 실패한다. 본 모듈은 모델 메타데이터 표를 단일 진입점으로 관리하고,
//   프롬프트 빌더가 호출 직전 `estimateTokens(messages)` 로 합계를 검사해 한도를 넘으면
//   `truncateToBudget(messages, model)` 로 오래된 대화부터 슬라이딩 윈도우로 잘라내거나
//   한 줄 요약 메시지로 압축한다.
//
// 보존 정책 (우선순위 고정)
//   1) `system` 역할 메시지 — 항상 보존. 역할 정의·도구 설명은 모델 동작의 핵심 계약.
//   2) 가장 마지막 `user` 메시지 — 항상 보존. 이번 턴 질문이 잘려나가면 호출 자체가 무의미.
//   3) 그 사이 turn — 한도가 충족될 때까지 오래된 순으로 제거하거나 요약 1줄로 압축.
//
// 본 모듈은 Anthropic 캐시 친화 빌더(`src/llm/promptCache.ts`) 와는 별개의 축이다 —
// 거기는 cache_control 마커 위치를 다루고, 여기는 백엔드별 컨텍스트 길이 한도를 다룬다.

// ────────────────────────────────────────────────────────────────────────────
// 어댑터 메시지 타입
// ────────────────────────────────────────────────────────────────────────────

export type AdapterRole = 'system' | 'user' | 'assistant';

export interface AdapterMessage {
  readonly role: AdapterRole;
  readonly content: string;
}

// ────────────────────────────────────────────────────────────────────────────
// 모델별 max_input_tokens 메타 표
// ────────────────────────────────────────────────────────────────────────────

export type AdapterBackend = 'vllm' | 'ollama';

export interface ModelTokenLimit {
  readonly model: string;
  readonly maxInputTokens: number;
  readonly backend: AdapterBackend;
}

/**
 * 모델 식별자 → 입력 토큰 한도. 키는 ollama 태그 표기(`name:tag`) 를 그대로 사용해
 * 호출자(어댑터) 가 별도 정규화 없이 lookup 할 수 있다.
 */
export const MODEL_TOKEN_LIMITS: Readonly<Record<string, ModelTokenLimit>> = Object.freeze({
  'llama3:8b': { model: 'llama3:8b', maxInputTokens: 8192, backend: 'ollama' },
  'llama3:70b': { model: 'llama3:70b', maxInputTokens: 8192, backend: 'ollama' },
  'qwen2.5:7b': { model: 'qwen2.5:7b', maxInputTokens: 32768, backend: 'ollama' },
  'qwen2.5:14b': { model: 'qwen2.5:14b', maxInputTokens: 32768, backend: 'ollama' },
  'mixtral:8x7b': { model: 'mixtral:8x7b', maxInputTokens: 32768, backend: 'vllm' },
  'phi3:mini': { model: 'phi3:mini', maxInputTokens: 4096, backend: 'ollama' },
});

/** 등록되지 않은 모델 기본값 — 가장 보수적인 4k. */
export const FALLBACK_MAX_INPUT_TOKENS = 4096;

export function lookupMaxInputTokens(model: string): number {
  const entry = MODEL_TOKEN_LIMITS[model];
  return entry ? entry.maxInputTokens : FALLBACK_MAX_INPUT_TOKENS;
}

// ────────────────────────────────────────────────────────────────────────────
// 토큰 추정 — estimateTokens
// ────────────────────────────────────────────────────────────────────────────
//
// 4자=1토큰 근사 + role 메타 오버헤드(역할 토큰·구분자) 6 토큰을 메시지 단위로 가산.
// tiktoken 같은 외부 의존을 두지 않고 결정론으로 동작 — 어댑터가 호출 직전 한도 체크에
// 쓰기에는 충분히 보수적이다(보수적 = 실제보다 약간 크게 추정).

const ROLE_OVERHEAD_TOKENS = 6;

export function estimateMessageTokens(message: AdapterMessage): number {
  const body = message.content ? Math.ceil(message.content.length / 4) : 0;
  return body + ROLE_OVERHEAD_TOKENS;
}

export function estimateTokens(messages: readonly AdapterMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

// ────────────────────────────────────────────────────────────────────────────
// 한도 적용 — truncateToBudget
// ────────────────────────────────────────────────────────────────────────────

export interface TruncateOptions {
  /** 요약 압축 사용 여부. false 면 슬라이딩 윈도우만. 기본 true. */
  readonly summarize?: boolean;
  /**
   * 한도 대비 헤드룸(완성 토큰 여유분). 모델이 출력할 토큰을 위해 입력 쪽에서
   * 비워 두는 양. 기본 256.
   */
  readonly headroomTokens?: number;
}

export interface TruncateResult {
  readonly messages: readonly AdapterMessage[];
  /** 슬라이딩 윈도우로 그냥 버려진 turn 수(요약에도 들어가지 않은 것). */
  readonly droppedCount: number;
  /** 한 줄 요약 블록으로 압축된 turn 수. */
  readonly summarizedCount: number;
  /** 결과 메시지의 추정 토큰 합. */
  readonly estimatedTokens: number;
  /** target(maxInputTokens − headroom) 안에 들어왔는지. */
  readonly withinBudget: boolean;
  readonly maxInputTokens: number;
}

/**
 * 모델 컨텍스트 윈도우를 넘지 않도록 메시지 배열을 줄인다.
 *
 *   1) `system` 역할과 가장 마지막 `user` 메시지를 따로 떼어 보존군에 둔다.
 *   2) 보존군이 차지하는 토큰을 빼고 남은 예산을 중간 turn 에 분배한다.
 *   3) 중간 turn 이 예산을 넘으면 가장 오래된 것부터 제거한다(슬라이딩 윈도우).
 *   4) `summarize=true` 이고 잘려나간 turn 이 있으면, 그것들을 한 줄 요약 `system`
 *      메시지로 만들어 중간의 맨 앞에 삽입한다. 요약 자체가 예산을 또 넘으면
 *      포기하고 슬라이딩만 남긴다.
 *
 * 결과는 `[...systems, ...middle(요약 포함 가능), lastUser]` 순서로 재조립된다.
 * 입력에 `user` 메시지가 하나도 없으면(시스템만) 보존군은 systems 만 남고 중간은
 * 빈 배열이 된다.
 */
export function truncateToBudget(
  messages: readonly AdapterMessage[],
  model: string,
  options: TruncateOptions = {},
): TruncateResult {
  const maxInputTokens = lookupMaxInputTokens(model);
  const headroom = Math.max(0, options.headroomTokens ?? 256);
  const target = Math.max(0, maxInputTokens - headroom);
  const summarize = options.summarize !== false;

  // 1) 보존 대상 분리.
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  const systems: AdapterMessage[] = [];
  const middleOriginal: AdapterMessage[] = [];
  let lastUser: AdapterMessage | null = null;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role === 'system') {
      systems.push(m);
      continue;
    }
    if (i === lastUserIndex) {
      lastUser = m;
      continue;
    }
    middleOriginal.push(m);
  }
  const tail = lastUser ? [lastUser] : [];

  // 2) 보존군이 이미 예산을 넘으면 — 어떤 잘림도 보존군은 건드리지 않는다.
  //    이 경우 호출자 책임. withinBudget=false 로 신호만 보낸다.
  const preservedTokens = estimateTokens(systems) + estimateTokens(tail);
  const availableForMiddle = Math.max(0, target - preservedTokens);

  // 3) 슬라이딩 윈도우.
  let middle = middleOriginal.slice();
  let droppedTurns: AdapterMessage[] = [];
  while (middle.length > 0 && estimateTokens(middle) > availableForMiddle) {
    droppedTurns.push(middle[0]);
    middle = middle.slice(1);
  }

  // 4) 요약 압축 시도.
  let summarizedCount = 0;
  let droppedCount = droppedTurns.length;
  if (summarize && droppedTurns.length > 0) {
    const summaryMsg = buildSummaryMessage(droppedTurns);
    const summaryTokens = estimateMessageTokens(summaryMsg);
    if (estimateTokens(middle) + summaryTokens <= availableForMiddle) {
      middle = [summaryMsg, ...middle];
      summarizedCount = droppedTurns.length;
      droppedCount = 0;
    }
  }

  const finalMessages: AdapterMessage[] = [...systems, ...middle, ...tail];
  const estimatedTokens = estimateTokens(finalMessages);
  return {
    messages: finalMessages,
    droppedCount,
    summarizedCount,
    estimatedTokens,
    withinBudget: estimatedTokens <= target,
    maxInputTokens,
  };
}

/**
 * 잘려나간 turn 들을 한 줄 결정론 요약으로 만든다.
 *   `[이전 N턴 요약] role:앞40자 | role:앞40자 | ...`
 * 각 항목의 content 는 공백을 1칸으로 정규화한 뒤 앞 40자만 인용한다 — 길이 폭주를 방지.
 */
function buildSummaryMessage(turns: readonly AdapterMessage[]): AdapterMessage {
  const items = turns.map((t) => {
    const head = t.content.slice(0, 40).replace(/\s+/g, ' ').trim();
    return `${t.role}:${head}`;
  });
  return {
    role: 'system',
    content: `[이전 ${turns.length}턴 요약] ${items.join(' | ')}`,
  };
}
