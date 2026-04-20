// 지시 #a0fe127e — 세션별 토큰 예산 · 컨텍스트 압축 엔진.
//
// 목적
//   장시간 이용 세션에서 토큰 사용량을 추적하고, 임계치 초과 시 대화 이력을 요약
//   블록으로 "압축(compaction)" 해 이후 Claude 호출의 입력 크기를 줄인다. QA
//   `tests/token-budget/tokenBudgetPipeline.spec.ts` 가 본 모듈의 공개 계약을
//   선고정(S1·S2 축) 해 두었기에, 여기의 시그니처는 해당 스펙과 1:1 로 일치해야 한다.
//
// 구성
//   1) `ConversationTurn` / `CompactedHistory` — 테스트와 동일한 타입 모양.
//   2) `shouldCompact(turns, thresholdTokens)` — 합계 토큰이 임계 이상이면 true.
//   3) `compactHistory(turns, keepLatest)` — 오래된 턴을 결정론적 요약 1줄로 치환하고
//      최신 keepLatest 턴을 유지. 요약 포맷은 테스트가 매칭하는 고정 규칙을 따른다.
//   4) `BudgetSession` · `createBudgetSession` · `recordUsage` · `appendTurn` ·
//      `maybeCompact` — 세션 상태 기계. 상위 호출자(에이전트 워커) 가 턴마다 호출하면
//      입력/출력/캐시 축 누적이 `mergeUsage` 로 관리되고, 히스토리는 순수 함수로
//      점진적으로 축약된다. 상태 변경은 **불변 업데이트** 로 반환된다.

import {
  EMPTY_TOTALS,
  mergeUsage,
} from '../utils/claudeTokenUsageStore';
import type {
  ClaudeTokenUsage,
  ClaudeTokenUsageTotals,
} from '../types';

// ────────────────────────────────────────────────────────────────────────────
// 대화 턴 · 압축 결과 — QA 스펙 계약 타입
// ────────────────────────────────────────────────────────────────────────────

export interface ConversationTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  /** 근사 토큰 수(상위에서 tiktoken 또는 길이 기반 추정치). */
  readonly tokens: number;
}

export interface CompactedHistory {
  /** 오래된 턴들의 단일 요약 블록. 압축이 일어나지 않으면 빈 문자열. */
  readonly summary: string;
  /** 유지되는 최신 턴들(최대 `keepLatest` 개). */
  readonly kept: readonly ConversationTurn[];
}

// ────────────────────────────────────────────────────────────────────────────
// 순수 함수 — shouldCompact / compactHistory
// ────────────────────────────────────────────────────────────────────────────

/**
 * 누적 토큰이 임계치를 넘었는지 판정. `>=` 관계로 스펙 `S2-1` 경계를 만족한다.
 * tiktoken 같은 외부 의존 없이 호출자가 정한 `tokens` 근사치만으로 판정한다.
 */
export function shouldCompact(
  turns: readonly ConversationTurn[],
  thresholdTokens: number,
): boolean {
  if (thresholdTokens <= 0) return turns.length > 0;
  let total = 0;
  for (const t of turns) total += Math.max(0, t.tokens | 0);
  return total >= thresholdTokens;
}

/**
 * 오래된 턴을 한 줄 요약으로 치환하고 최신 `keepLatest` 개만 남긴다.
 *
 * 요약 포맷(결정론 — QA 스펙 `S2-2` 고정):
 *   `이전 N턴 요약(T토큰): role:content | role:content | ...`
 *   · N = 버려진(older) 턴 수.
 *   · T = older 턴의 tokens 합.
 *   · 각 항목의 content 는 선두 16자만 인용.
 *
 * `turns.length <= keepLatest` 면 summary 는 빈 문자열이고 kept 는 원본 그대로(`S2-3`).
 * `keepLatest` 는 음수/0 이 들어오면 1 로 보정해 최소한 마지막 메시지는 살린다.
 */
export function compactHistory(
  turns: readonly ConversationTurn[],
  keepLatest: number,
): CompactedHistory {
  const keep = Math.max(1, keepLatest | 0);
  if (turns.length <= keep) {
    return { summary: '', kept: turns };
  }
  const cutoff = turns.length - keep;
  const older = turns.slice(0, cutoff);
  const kept = turns.slice(cutoff);
  const olderTokens = older.reduce((a, t) => a + Math.max(0, t.tokens | 0), 0);
  const summary = `이전 ${older.length}턴 요약(${olderTokens}토큰): ${older
    .map((t) => `${t.role}:${t.content.slice(0, 16)}`)
    .join(' | ')}`;
  return { summary, kept };
}

// ────────────────────────────────────────────────────────────────────────────
// 세션 상태 기계 — recordUsage · appendTurn · maybeCompact
// ────────────────────────────────────────────────────────────────────────────

export interface BudgetSession {
  readonly sessionId: string;
  readonly totals: ClaudeTokenUsageTotals;
  readonly history: readonly ConversationTurn[];
  /** 마지막 압축 시점에 생성된 요약 블록. 프롬프트 상단에 이어 붙일 때 사용. */
  readonly compactedSummary: string;
  /** 이전 recordUsage 호출의 usage.at (ISO). */
  readonly lastUsageAt: string | null;
}

export interface BudgetPolicy {
  /** 히스토리 토큰 합이 이 값 이상이면 `maybeCompact` 가 압축을 트리거한다. */
  readonly compactThresholdTokens: number;
  /** 압축 시 유지되는 최신 턴 수. 기본 6. */
  readonly keepLatestTurns?: number;
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = Object.freeze({
  compactThresholdTokens: 60_000,
  keepLatestTurns: 6,
});

function emptyTotals(): ClaudeTokenUsageTotals {
  return { ...EMPTY_TOTALS, byModel: {}, errors: { ...EMPTY_TOTALS.errors } };
}

export function createBudgetSession(sessionId: string): BudgetSession {
  return {
    sessionId,
    totals: emptyTotals(),
    history: [],
    compactedSummary: '',
    lastUsageAt: null,
  };
}

/**
 * Claude 호출 결과 usage 를 세션 총계에 병합. `mergeUsage` 를 그대로 사용해
 * callCount · byModel · estimatedCostUsd · updatedAt 등 기존 테스트가 검증하는
 * 필드 전부가 일관되게 갱신된다. 본 함수는 상태를 변경하지 않고 새 세션 객체를 반환.
 */
export function recordUsage(
  session: BudgetSession,
  usage: ClaudeTokenUsage,
): BudgetSession {
  const nextTotals = mergeUsage(session.totals, usage);
  return {
    ...session,
    totals: nextTotals,
    lastUsageAt: usage.at ?? session.lastUsageAt,
  };
}

/** 새 대화 턴을 히스토리 꼬리에 추가. */
export function appendTurn(
  session: BudgetSession,
  turn: ConversationTurn,
): BudgetSession {
  return { ...session, history: [...session.history, turn] };
}

/**
 * 현재 히스토리가 임계치를 넘으면 압축을 수행하고, 압축된 요약을 세션에 저장.
 * 이미 누적된 요약(session.compactedSummary) 은 새 요약 앞에 접두사로 연결해
 * "요약의 요약" 을 자연스럽게 만든다(장시간 세션에서 요약이 자라는 것을 막기 위해
 * 호출자는 주기적으로 `resetCompactedSummary` 로 꼬리를 자를 수 있다).
 */
export function maybeCompact(
  session: BudgetSession,
  policy: BudgetPolicy = DEFAULT_BUDGET_POLICY,
): BudgetSession {
  if (!shouldCompact(session.history, policy.compactThresholdTokens)) return session;
  const { summary, kept } = compactHistory(
    session.history,
    policy.keepLatestTurns ?? DEFAULT_BUDGET_POLICY.keepLatestTurns ?? 6,
  );
  const composed = session.compactedSummary && summary
    ? `${session.compactedSummary}\n${summary}`
    : (summary || session.compactedSummary);
  return {
    ...session,
    history: kept,
    compactedSummary: composed,
  };
}

export function resetCompactedSummary(session: BudgetSession): BudgetSession {
  return { ...session, compactedSummary: '' };
}

// ────────────────────────────────────────────────────────────────────────────
// 지시 #29d56176 — 점진적 디그레이드(graceful degrade)
//
// 개념
//   · softCap(기본 0.8) — "slow down" 경계. 이 선을 넘으면 자동 절약 경로를 켠다:
//       (a) 시스템 프롬프트를 결정론적으로 간소화(1/3 길이)
//       (b) 참조 문서(긴 assistant 턴) 를 요약 치환
//       (c) 툴 스키마를 핵심 키만 남긴 축약형으로 재직렬화
//   · hardCap(기본 1.0) — "stop before overflow" 경계. 넘으면 새 세션으로 안전 이전
//       (handoff) — 현재 맥락을 한 덩어리 요약으로 만들어 새 세션 초기 프롬프트에 싣는다.
//
// 계산 기준
//   누적 "input_tokens + output_tokens" / capTokens 를 본다. 캐시는 과금 관점상
//   별개라 분모에 포함하지 않는다(과하게 보수적으로 디그레이드되지 않도록).
// ────────────────────────────────────────────────────────────────────────────

export type DegradeLevel = 'none' | 'soft' | 'hard';

export interface TokenBudgetCap {
  /** 분모 — 세션당 허용 토큰 상한. */
  readonly capTokens: number;
  /** soft 경계 비율. 기본 0.8. */
  readonly softRatio?: number;
  /** hard 경계 비율. 기본 1.0. */
  readonly hardRatio?: number;
}

export const DEFAULT_TOKEN_BUDGET_CAP: TokenBudgetCap = Object.freeze({
  capTokens: 180_000,
  softRatio: 0.8,
  hardRatio: 1.0,
});

export function usageRatio(totals: ClaudeTokenUsageTotals, cap: TokenBudgetCap): number {
  const denom = cap.capTokens <= 0 ? 1 : cap.capTokens;
  const used = totals.inputTokens + totals.outputTokens;
  return used / denom;
}

export function shouldDegrade(
  totals: ClaudeTokenUsageTotals,
  cap: TokenBudgetCap = DEFAULT_TOKEN_BUDGET_CAP,
): DegradeLevel {
  const ratio = usageRatio(totals, cap);
  const hard = cap.hardRatio ?? DEFAULT_TOKEN_BUDGET_CAP.hardRatio!;
  const soft = cap.softRatio ?? DEFAULT_TOKEN_BUDGET_CAP.softRatio!;
  if (ratio >= hard) return 'hard';
  if (ratio >= soft) return 'soft';
  return 'none';
}

// ────────────────────────────────────────────────────────────────────────────
// soft 단계 — 자동 절약 변환
// ────────────────────────────────────────────────────────────────────────────

export interface DegradeInput {
  readonly systemPrompt?: string;
  readonly agentDefinition?: string;
  readonly toolsSchema?: string;
  readonly history?: readonly ConversationTurn[];
  readonly compactedSummary?: string;
}

export interface DegradeOutput {
  readonly systemPrompt?: string;
  readonly agentDefinition?: string;
  readonly toolsSchema?: string;
  readonly history: readonly ConversationTurn[];
  readonly compactedSummary?: string;
  readonly savedTokens: number;
}

/** 시스템 프롬프트를 문장 단위로 1/3 만 남긴다(짧은 문자열은 그대로). */
function simplifySystemPrompt(text: string): string {
  if (!text || text.length <= 240) return text;
  const sentences = text.split(/(?<=[.!?。！？])\s+/);
  const keep = Math.max(2, Math.ceil(sentences.length / 3));
  return sentences.slice(0, keep).join(' ');
}

/** 툴 스키마 JSON 에서 name/description 축만 남기고 파라미터 상세를 생략. */
function shrinkToolsSchema(raw: string): string {
  if (!raw) return raw;
  try {
    const parsed = JSON.parse(raw) as { tools?: Array<{ name?: unknown; description?: unknown }> };
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    const slim = tools.map((t) => ({
      name: typeof t?.name === 'string' ? t.name : '',
      description: typeof t?.description === 'string' ? t.description.slice(0, 80) : '',
    }));
    return JSON.stringify({ tools: slim });
  } catch {
    // 파싱 실패 — 원문을 1/2 로 자른다(최후의 보루).
    return raw.slice(0, Math.ceil(raw.length / 2));
  }
}

/** 큰 assistant 턴은 "(요약) 첫 160자…" 로 치환. user 턴은 보존. */
function summarizeHistory(
  history: readonly ConversationTurn[],
  heavyTokenThreshold: number,
): readonly ConversationTurn[] {
  return history.map((t) => {
    if (t.role === 'assistant' && t.tokens >= heavyTokenThreshold && t.content.length > 200) {
      const head = t.content.slice(0, 160).replace(/\s+/g, ' ').trim();
      return {
        role: t.role,
        content: `(요약) ${head}…`,
        tokens: Math.max(40, Math.floor(t.tokens / 4)),
      };
    }
    return t;
  });
}

/** 입력 길이 합(문자수) — savedTokens 를 근사. 외부에서 비교 가능한 결정론 지표. */
function lengthOf(input: DegradeInput): number {
  const hist = input.history ?? [];
  return (input.systemPrompt ?? '').length
    + (input.agentDefinition ?? '').length
    + (input.toolsSchema ?? '').length
    + (input.compactedSummary ?? '').length
    + hist.reduce((a, t) => a + t.content.length, 0);
}

/**
 * soft 단계에서 호출해 "자동 절약" 변환을 적용한다. hard 단계에서도 handoff 이후
 * 새 세션 초기 프롬프트 준비 전 한 번 돌려 폭주 가능성을 추가로 낮출 수 있다.
 */
export function applySoftDegrade(input: DegradeInput): DegradeOutput {
  const before = lengthOf(input);
  const nextSys = input.systemPrompt ? simplifySystemPrompt(input.systemPrompt) : input.systemPrompt;
  const nextTools = input.toolsSchema ? shrinkToolsSchema(input.toolsSchema) : input.toolsSchema;
  const nextHistory = summarizeHistory(input.history ?? [], 1_000);
  const after = lengthOf({
    ...input,
    systemPrompt: nextSys,
    toolsSchema: nextTools,
    history: nextHistory,
  });
  // 문자수 → 근사 토큰(4자=1토큰) 변환.
  const savedTokens = Math.max(0, Math.ceil((before - after) / 4));
  return {
    systemPrompt: nextSys,
    agentDefinition: input.agentDefinition,
    toolsSchema: nextTools,
    history: nextHistory,
    compactedSummary: input.compactedSummary,
    savedTokens,
  };
}
