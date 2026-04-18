// Claude 토큰 사용량(ClaudeTokenUsage) 을 브라우저 세션 단위로 누적해 상단바 위젯이
// 소비할 수 있도록 제공하는 외부 스토어. `zustand` 를 프로젝트 의존성에 넣지 않기
// 위해 React 19 의 `useSyncExternalStore` 를 타깃으로 하는 모듈 레벨 pub/sub 패턴을
// 선택했다. 두 가지 순수 함수 `mergeUsage` · `estimateCostUsd` 는 스토어와 독립적
// 으로 테스트된다(tests/claudeTokenUsageStore.regression.test.ts).
//
// 설계 원칙
//  1) **단일 출처**: 서버의 in-memory 총계(`GET /api/claude/token-usage`) 가 truth.
//     UI 는 초기 하이드레이션 1회 + socket 'claude-usage:updated' push 를 받아 덮어쓴다.
//  2) **덧셈-친화적 집계**: delta 를 받으면 수치는 더하기, 호출 카운트는 1 증가.
//     따라서 서버·클라 양쪽에서 `applyDelta` 를 쓰면 총계가 동일하게 수렴한다.
//  3) **브레이크다운**: byModel 은 프론트 툴팁의 "어떤 모델이 얼마나 먹었나" 용.
//  4) **캐시 히트율**: cache_read / (cache_read + input_tokens) 로 정의 —
//     "읽은 캐시 토큰이 전체 입력 중 몇 % 였는가" 를 1줄 숫자로 압축한다.
//
// 비용 계산은 claudeTokenPricing.ts 의 단가표가 있으나 본 프로젝트는 아직 별도
// 단가 파일이 없어 이 파일 하단에 함께 내장한다. 가격표 갱신 시 주의.

import type { ClaudeTokenUsage, ClaudeTokenUsageTotals } from '../types';

// ────────────────────────────────────────────────────────────────────────────
// 가격 테이블 (USD / 1M tokens)
// 출처 기준: 2026-01 공개 앤트로픽 가격표 스냅샷. 실제 청구 근거가 아니며
// UI 표시용 대략값이다. 모델 추가 시 본 테이블만 확장.
// ────────────────────────────────────────────────────────────────────────────
interface ModelPricePerMillion {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// 모델 id 접두 매칭. `claude-opus-4-7` · `claude-opus-4-7[1m]` 등의 변종도 잡힌다.
// 가장 긴 prefix 부터 시도하도록 정의 순서를 유지한다.
const PRICE_TABLE: Array<[string, ModelPricePerMillion]> = [
  ['claude-opus-4',   { input: 15,   output: 75,  cacheRead: 1.5,  cacheWrite: 18.75 }],
  ['claude-sonnet-4', { input: 3,    output: 15,  cacheRead: 0.3,  cacheWrite: 3.75  }],
  ['claude-haiku-4',  { input: 0.8,  output: 4,   cacheRead: 0.08, cacheWrite: 1     }],
  // 보수 기본값(미지 모델). Sonnet 단가를 적용해 과소계상 위험을 줄인다.
  ['claude',          { input: 3,    output: 15,  cacheRead: 0.3,  cacheWrite: 3.75  }],
];

function pricingFor(model: string | undefined): ModelPricePerMillion {
  const m = (model || '').toLowerCase();
  for (const [prefix, price] of PRICE_TABLE) {
    if (m.startsWith(prefix)) return price;
  }
  return PRICE_TABLE[PRICE_TABLE.length - 1][1];
}

/** 한 번의 Claude 호출 usage 의 대략 비용(USD). 0 이하 값은 0 으로 치환. */
export function estimateCostUsd(usage: ClaudeTokenUsage): number {
  const price = pricingFor(usage.model);
  const perMillion = 1_000_000;
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  return (
    safe(usage.input_tokens) / perMillion * price.input +
    safe(usage.output_tokens) / perMillion * price.output +
    safe(usage.cache_read_input_tokens) / perMillion * price.cacheRead +
    safe(usage.cache_creation_input_tokens) / perMillion * price.cacheWrite
  );
}

/** 캐시 히트율(0~1). cacheRead / (cacheRead + input). 둘 다 0 이면 0. */
export function cacheHitRate(totals: ClaudeTokenUsageTotals): number {
  const denom = totals.cacheReadTokens + totals.inputTokens;
  if (denom <= 0) return 0;
  return totals.cacheReadTokens / denom;
}

// ────────────────────────────────────────────────────────────────────────────
// 순수 누적 함수 — 테스트 대상
// ────────────────────────────────────────────────────────────────────────────

export const EMPTY_TOTALS: ClaudeTokenUsageTotals = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  callCount: 0,
  estimatedCostUsd: 0,
  byModel: {},
  updatedAt: '1970-01-01T00:00:00.000Z',
}) as ClaudeTokenUsageTotals;

/**
 * 누적 총계에 한 번의 호출 usage 를 더한다. 입력 totals 는 불변으로 취급해 새
 * 객체를 반환하므로 React state 의 셋터에 그대로 넘길 수 있다.
 *
 * 숫자 필드 음수/NaN 방어: 0 으로 클램프한다. byModel 키는 `usage.model || '알 수 없음'`.
 */
export function mergeUsage(totals: ClaudeTokenUsageTotals, usage: ClaudeTokenUsage): ClaudeTokenUsageTotals {
  const safe = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);
  const delta = {
    inputTokens: safe(usage.input_tokens),
    outputTokens: safe(usage.output_tokens),
    cacheReadTokens: safe(usage.cache_read_input_tokens),
    cacheCreationTokens: safe(usage.cache_creation_input_tokens),
  };
  const cost = estimateCostUsd(usage);
  const modelKey = usage.model && usage.model.length > 0 ? usage.model : '알 수 없음';
  const prevForModel = totals.byModel[modelKey] ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    callCount: 0,
    estimatedCostUsd: 0,
  };
  return {
    inputTokens: totals.inputTokens + delta.inputTokens,
    outputTokens: totals.outputTokens + delta.outputTokens,
    cacheReadTokens: totals.cacheReadTokens + delta.cacheReadTokens,
    cacheCreationTokens: totals.cacheCreationTokens + delta.cacheCreationTokens,
    callCount: totals.callCount + 1,
    estimatedCostUsd: totals.estimatedCostUsd + cost,
    byModel: {
      ...totals.byModel,
      [modelKey]: {
        inputTokens: prevForModel.inputTokens + delta.inputTokens,
        outputTokens: prevForModel.outputTokens + delta.outputTokens,
        cacheReadTokens: prevForModel.cacheReadTokens + delta.cacheReadTokens,
        cacheCreationTokens: prevForModel.cacheCreationTokens + delta.cacheCreationTokens,
        callCount: prevForModel.callCount + 1,
        estimatedCostUsd: prevForModel.estimatedCostUsd + cost,
      },
    },
    updatedAt: usage.at ?? new Date().toISOString(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 외부 스토어 — useSyncExternalStore 타깃
// ────────────────────────────────────────────────────────────────────────────

type Listener = () => void;

let current: ClaudeTokenUsageTotals = EMPTY_TOTALS;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export const claudeTokenUsageStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getSnapshot(): ClaudeTokenUsageTotals {
    return current;
  },
  /** 서버 권위 값으로 통째 교체. 초기 하이드레이션/리셋에 사용. */
  hydrate(totals: ClaudeTokenUsageTotals): void {
    current = totals;
    emit();
  },
  /** 증분 한 건을 누적. 서버 푸시 이벤트 핸들러가 호출한다. */
  applyDelta(usage: ClaudeTokenUsage): void {
    current = mergeUsage(current, usage);
    emit();
  },
  /** 로컬 초기화. 서버 리셋 이벤트 수신 시 호출. */
  reset(): void {
    current = EMPTY_TOTALS;
    emit();
  },
  // 테스트 전용: 모듈 상태를 수동으로 교체한다. 프로덕션 경로에서는 쓰지 않는다.
  __setForTest(next: ClaudeTokenUsageTotals): void {
    current = next;
    emit();
  },
};
