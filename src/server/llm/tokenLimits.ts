// 출력 토큰 한도 산정·이어쓰기·워치독 (#llm-output-token-budget)
//
// 로컬 LLM(Ollama / vLLM) 의 단일 chat 응답은 모델 기본 max_tokens 가 작으면
// 길이 절단으로 끝난다. 특히 ollama 의 num_predict 는 기본 128 토큰이라 한국어
// 응답에서는 첫 단락도 못 마치고 잘리는 일이 잦다. 이 모듈은 두 트랜스포트가
// 공유할 정책을 한곳에 모은다:
//
//   1) modelLimits / safeMaxOutputTokens — 모델별 컨텍스트 창과 한 번에 뽑을
//      안전 출력 토큰 수.
//   2) continueGeneration — 길이 절단 응답을 이어 쓰도록 메시지 배열을 확장.
//   3) watchdogCeiling / remainingBudget / estimateTokens — 누적 출력 토큰이
//      컨텍스트 창의 90% 를 넘지 않도록 강제하는 가드.
//
// 보수적 가정: 4 글자 = 1 토큰 룰. 한국어는 평균 1.5 글자/토큰에 가까워 실제로는
// 토큰을 더 적게 잡지만, 보수적으로 4 를 쓰면 watchdog 가 먼저 발동해 안전 쪽으로
// 기운다(= 잘못된 컷 < 컨텍스트 폭발).

export interface ModelLimits {
  /** 모델이 한 번의 호출에서 다룰 수 있는 입력+출력 합산 토큰. */
  contextWindow: number;
  /** 단일 응답에 적용할 권장 max_tokens 기본값. 너무 크게 잡으면 길이 절단이
   *  드물어지지만 첫 응답 latency 가 늘고, 너무 작으면 자주 이어쓰기를 돈다. */
  defaultMaxOutput: number;
}

const MODEL_LIMITS: Record<string, ModelLimits> = {
  // Qwen 시리즈 — 32k context, 4k 출력 권장
  'qwen3.5:9b': { contextWindow: 32_768, defaultMaxOutput: 4_096 },
  'qwen3:8b':   { contextWindow: 32_768, defaultMaxOutput: 4_096 },
  'qwen2.5:7b': { contextWindow: 32_768, defaultMaxOutput: 4_096 },
  // Llama 3 시리즈 — 128k context
  'llama3.1:8b':  { contextWindow: 128_000, defaultMaxOutput: 8_192 },
  'llama3.1:70b': { contextWindow: 128_000, defaultMaxOutput: 8_192 },
  'llama3.2:3b':  { contextWindow: 128_000, defaultMaxOutput: 4_096 },
  // DeepSeek-R1 — reasoning 토큰 때문에 출력 한도를 넉넉히
  'deepseek-r1:14b': { contextWindow: 64_000, defaultMaxOutput: 8_192 },
  'deepseek-r1:7b':  { contextWindow: 64_000, defaultMaxOutput: 4_096 },
  // 알 수 없는 모델 fallback — 보수적으로 작게
  __default__: { contextWindow: 8_192, defaultMaxOutput: 1_024 },
};

const FALLBACK = MODEL_LIMITS.__default__;

/** watchdog 가 차단을 시작하는 컨텍스트 사용률(0~1). */
export const WATCHDOG_RATIO = 0.9;

/** 모델 식별자에서 컨텍스트/출력 한도를 산출. ":latest" 등 변형 태그도 베이스명으로 매칭한다. */
export function modelLimits(model: string): ModelLimits {
  if (!model) return FALLBACK;
  const direct = MODEL_LIMITS[model];
  if (direct) return direct;
  const base = model.split(':')[0];
  for (const key of Object.keys(MODEL_LIMITS)) {
    if (key === '__default__') continue;
    if (key === base || key.startsWith(base + ':')) return MODEL_LIMITS[key];
  }
  return FALLBACK;
}

/**
 * 단일 chat 응답에 적용할 안전 max_tokens. env LLM_MAX_OUTPUT_TOKENS 가 있으면
 * 그 값을 우선하고, 없으면 모델 기본 출력 한도를 쓴다.
 */
export function safeMaxOutputTokens(model: string): number {
  const env = process.env.LLM_MAX_OUTPUT_TOKENS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return modelLimits(model).defaultMaxOutput;
}

/** 누적 출력 토큰의 상한(컨텍스트 창 × WATCHDOG_RATIO). */
export function watchdogCeiling(model: string): number {
  return Math.floor(modelLimits(model).contextWindow * WATCHDOG_RATIO);
}

/**
 * 이어쓰기 호출에 쓸 남은 예산(토큰). 누적 출력이 ceiling 을 넘으면 0 을 돌려
 * 호출자가 루프를 끊도록 한다.
 */
export function remainingBudget(model: string, consumedTokens: number): number {
  return Math.max(0, watchdogCeiling(model) - consumedTokens);
}

/**
 * 보수적 토큰 추정. 정확한 tokenizer 호출(=네트워크/파일 IO) 을 피하기 위해
 * 4 글자/토큰 룰을 쓴다. watchdog 만 발동시키면 되는 용도라 정확도는 크게
 * 중요하지 않다.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * 길이 절단된 partial 응답을 이어 쓰도록 메시지 배열을 확장한다. 원본을
 * 변형하지 않고 새 배열을 돌려준다. ollama / vllm 모두 OpenAI 메시지 규약을
 * 따르므로 동일한 포맷이 통한다.
 *
 * `prevText` 를 assistant 메시지로 깔고, 직후 user 메시지로 "이어 쓰기" 지시를
 * 명시적으로 넣는다. 모델이 새 인사·서두를 붙이지 않도록 강하게 못 박는다.
 */
export function continueGeneration<T extends { role: string; content: string }>(
  messages: readonly T[],
  prevText: string,
): T[] {
  return [
    ...messages,
    { role: 'assistant', content: prevText } as T,
    {
      role: 'user',
      content:
        '직전 응답이 출력 토큰 한도로 잘렸다. 잘린 지점부터 자연스럽게 이어 쓰기만 하라. ' +
        '이미 쓴 내용을 반복하지 말고, 새로운 인사·서두 없이 이어가라.',
    } as T,
  ];
}

/** 트랜스포트가 이어쓰기 루프 상한으로 쓸 라운드 수. env 로 조정 가능. */
export function continueRounds(): number {
  const env = process.env.LLM_CONTINUE_ROUNDS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 3;
}
