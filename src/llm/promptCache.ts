// 지시 #9e0c243c — 팀 컨텍스트 압축 · 최근 N턴 슬라이서 · 응답 캐시.
//
// 목적
//   장시간 대화 세션에서 (a) 팀 컨텍스트(역할 정의 + 히스토리)를 주기적으로
//   "압축" 해 토큰 입력을 줄이고, (b) 최근 N턴만 슬라이스해 프롬프트 후미를 짧게
//   유지하며, (c) 동일 프롬프트에 대한 모델 응답을 메모리 캐시로 재사용해 LLM
//   호출 자체를 회피한다. 본 모듈은 회귀 테스트 spec/llm/tokenUsage.spec.ts 의
//   계약 대상이며, 시그니처/동작 규약은 해당 스펙과 1:1 로 일치해야 한다.

import { compactHistory, type ConversationTurn } from './tokenBudget';

// ────────────────────────────────────────────────────────────────────────────
// 토큰 근사 — 4자=1토큰
// ────────────────────────────────────────────────────────────────────────────

export function approximateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ────────────────────────────────────────────────────────────────────────────
// 팀 컨텍스트 압축 — compactTeamContext
// ────────────────────────────────────────────────────────────────────────────

export interface TeamContext {
  /** 팀 구성 · 역할 · 자동 개발 규칙 등 정적 텍스트. */
  readonly teamSummary: string;
  /** 누적 대화 요약(이전 압축 산출물). 없으면 빈 문자열. */
  readonly compactedSummary: string;
  /** 최신순 오름차순 대화 턴. */
  readonly history: readonly ConversationTurn[];
}

export interface CompactTeamContextOptions {
  /** 히스토리에서 살릴 최신 턴 수. 기본 3. */
  readonly keepLatest?: number;
  /** teamSummary 가 이 길이를 넘으면 앞부분만 남기고 말줄임표를 붙인다. 기본 240자. */
  readonly maxSummaryChars?: number;
}

/**
 * 팀 컨텍스트의 토큰 사용량(근사). teamSummary + compactedSummary + 히스토리 턴
 * tokens 합. spec/llm/tokenUsage.spec.ts 의 "전후 비교" 축에서 사용.
 */
export function teamContextTokens(ctx: TeamContext): number {
  const summary = approximateTokens(ctx.teamSummary)
    + approximateTokens(ctx.compactedSummary);
  const history = ctx.history.reduce((acc, t) => acc + Math.max(0, t.tokens | 0), 0);
  return summary + history;
}

/**
 * 팀 컨텍스트를 결정론적으로 압축한다.
 *   1) 오래된 히스토리는 `compactHistory` 로 한 줄 요약 + 최신 keepLatest 턴만 유지.
 *   2) teamSummary 는 maxSummaryChars 초과분을 잘라 말줄임표 1자만 추가.
 *   3) 기존 compactedSummary 는 새 요약 앞에 prefix 로 연결("요약의 요약").
 * 호출자는 반환된 TeamContext 를 다음 LLM 호출의 입력으로 그대로 사용한다.
 */
export function compactTeamContext(
  ctx: TeamContext,
  options: CompactTeamContextOptions = {},
): TeamContext {
  const keepLatest = options.keepLatest ?? 3;
  const maxSummaryChars = options.maxSummaryChars ?? 240;

  const { summary, kept } = compactHistory(ctx.history, keepLatest);
  const composed = ctx.compactedSummary && summary
    ? `${ctx.compactedSummary}\n${summary}`
    : (summary || ctx.compactedSummary);

  const teamSummary = ctx.teamSummary.length > maxSummaryChars
    ? `${ctx.teamSummary.slice(0, maxSummaryChars)}…`
    : ctx.teamSummary;

  return {
    teamSummary,
    compactedSummary: composed,
    history: kept,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// sliceRecentHistory — 최신 N턴 잘라내기
// ────────────────────────────────────────────────────────────────────────────

/**
 * 최신 `keepLatest` 턴만 남긴다(기본 3).
 *   · turns.length <= keepLatest → 원본 그대로 반환.
 *   · keepLatest <= 0 → 빈 배열.
 *   · 그 외 → 끝에서 keepLatest 개만 잘라낸 새 배열.
 * compactHistory 와 달리 요약 블록은 만들지 않는다 — "프롬프트 후미만 짧게" 가 목적.
 */
export function sliceRecentHistory(
  turns: readonly ConversationTurn[],
  keepLatest = 3,
): readonly ConversationTurn[] {
  const keep = Math.max(0, keepLatest | 0);
  if (keep === 0) return [];
  if (turns.length <= keep) return turns;
  return turns.slice(turns.length - keep);
}

// ────────────────────────────────────────────────────────────────────────────
// responseCache — 프롬프트 → 응답 메모리 캐시
// ────────────────────────────────────────────────────────────────────────────

export interface ResponseCacheStats {
  readonly hits: number;
  readonly misses: number;
  /** call() 가 실제로 fetcher 를 호출한 횟수. 캐시 적중 시 증가하지 않는다. */
  readonly llmCalls: number;
}

export interface ResponseCache {
  readonly get: (prompt: string) => string | null;
  readonly set: (prompt: string, response: string) => void;
  /** 캐시 적중이면 fetcher 를 호출하지 않고 즉시 반환, 미스면 fetcher 결과를 저장 후 반환. */
  readonly call: (prompt: string, fetcher: () => Promise<string> | string) => Promise<string>;
  readonly stats: () => ResponseCacheStats;
  readonly invalidateAll: () => void;
  readonly size: () => number;
}

/** 결정론 FNV-1a 32bit — 외부 의존 없이 프롬프트 키를 짧게 유지. */
function hashPrompt(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function normalizePrompt(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

export function createResponseCache(): ResponseCache {
  const map = new Map<string, string>();
  let hits = 0;
  let misses = 0;
  let llmCalls = 0;

  function keyFor(prompt: string): string {
    return hashPrompt(normalizePrompt(prompt));
  }

  return {
    get(prompt) {
      const v = map.get(keyFor(prompt));
      if (v === undefined) { misses += 1; return null; }
      hits += 1;
      return v;
    },
    set(prompt, response) {
      map.set(keyFor(prompt), response);
    },
    async call(prompt, fetcher) {
      const key = keyFor(prompt);
      const cached = map.get(key);
      if (cached !== undefined) {
        hits += 1;
        return cached;
      }
      misses += 1;
      llmCalls += 1;
      const result = await fetcher();
      map.set(key, result);
      return result;
    },
    stats() {
      return { hits, misses, llmCalls };
    },
    invalidateAll() {
      map.clear();
    },
    size() {
      return map.size;
    },
  };
}
