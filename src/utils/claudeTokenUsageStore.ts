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

import type {
  ClaudeTokenUsage,
  ClaudeTokenUsageTotals,
  ClaudeTokenUsagePersisted,
  ClaudeTokenUsageThresholds,
  ClaudeTokenUsageSeverity,
  ClaudeErrorCategory,
  ClaudeErrorCounters,
  ClaudeSessionStatus,
} from '../types';
import { CLAUDE_ERROR_CATEGORIES } from '../types';

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

/**
 * 한 번의 Claude 호출 usage 의 **축별 비용 분해** (USD). 네 축(input · output ·
 * cacheRead · cacheWrite) 을 각각 독립 계산해 합계 `total` 과 함께 돌려준다.
 * 0 이하/비숫자 토큰은 0 으로 치환. 디자이너가 선도입한
 * `--token-usage-axis-{input,output,cache-read,cache-create}-fg` 토큰과 1:1 매핑
 * 되므로 툴팁·내보내기에서 "어느 축이 얼마를 소비했는가" 를 그대로 시각화할 수 있다.
 */
export interface ClaudeCostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export function estimateCostBreakdownUsd(usage: ClaudeTokenUsage): ClaudeCostBreakdown {
  const price = pricingFor(usage.model);
  const perMillion = 1_000_000;
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const input = safe(usage.input_tokens) / perMillion * price.input;
  const output = safe(usage.output_tokens) / perMillion * price.output;
  const cacheRead = safe(usage.cache_read_input_tokens) / perMillion * price.cacheRead;
  const cacheWrite = safe(usage.cache_creation_input_tokens) / perMillion * price.cacheWrite;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/** 한 번의 Claude 호출 usage 의 대략 비용(USD). 축별 합계 — `estimateCostBreakdownUsd(...).total` 과 동일. */
export function estimateCostUsd(usage: ClaudeTokenUsage): number {
  return estimateCostBreakdownUsd(usage).total;
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

/** 모든 카테고리를 0 으로 채운 기본 에러 카운터. 스토어는 항상 이 키 셋을 유지한다. */
export function emptyErrorCounters(): ClaudeErrorCounters {
  const out = {} as ClaudeErrorCounters;
  for (const c of CLAUDE_ERROR_CATEGORIES) out[c] = 0;
  return out;
}

/** ClaudeTokenUsageTotals.errors 가 누락된 구 객체를 받았을 때 빈 카운터로 보정. */
export function ensureErrorCounters(errors: ClaudeErrorCounters | undefined): ClaudeErrorCounters {
  const base = emptyErrorCounters();
  if (!errors || typeof errors !== 'object') return base;
  for (const c of CLAUDE_ERROR_CATEGORIES) {
    const v = (errors as Record<string, unknown>)[c];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) base[c] = Math.floor(v);
  }
  return base;
}

/** 특정 카테고리 1건을 누적한 새 totals 를 돌려준다(불변). */
export function recordErrorToTotals(totals: ClaudeTokenUsageTotals, category: ClaudeErrorCategory): ClaudeTokenUsageTotals {
  const prev = ensureErrorCounters(totals.errors);
  return {
    ...totals,
    errors: { ...prev, [category]: (prev[category] ?? 0) + 1 },
    updatedAt: new Date().toISOString(),
  };
}

export const EMPTY_TOTALS: ClaudeTokenUsageTotals = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  callCount: 0,
  estimatedCostUsd: 0,
  byModel: {},
  updatedAt: '1970-01-01T00:00:00.000Z',
  errors: emptyErrorCounters(),
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
// 오늘/전체 축 · 자정 경계 · localStorage 영속화 (#3b8038c7)
// ────────────────────────────────────────────────────────────────────────────

// localStorage 저장 키. 스키마 변경 시 v1 → v2 로 올려야 하며, deserialize 는
// 모르는 버전을 조용히 무시해 새로고침이 실패하지 않게 한다.
export const TOKEN_USAGE_STORAGE_KEY = 'llmtycoon.tokenUsage.v1';

/** `Date` 인스턴스를 로컬 시간 기준 'YYYY-MM-DD' 로 포맷한다. */
export function toLocalDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 영속 상태. all = 세션 수명 누적(서버 권위로 하이드레이트), today = 로컬 자정 기준
 * 일별 누적. today 는 서버에서 받지 않고 이 스토어가 자체 관리한다 — 클라이언트의
 * "로컬 타임존 자정" 경계가 서버 프로세스 수명과 다르므로 축을 분리했다.
 * history = 지난 날들의 today 스냅샷(자정 롤오버 시 push). 내보내기/주(주간) 집계용.
 */
export interface TokenUsageHistoryEntry {
  date: string; // 'YYYY-MM-DD'
  totals: ClaudeTokenUsageTotals;
}

export interface TokenUsageStoreState {
  all: ClaudeTokenUsageTotals;
  today: ClaudeTokenUsageTotals;
  todayDate: string;
  // 최신순으로 정렬된 과거 일자별 스냅샷. 최대 HISTORY_LIMIT 개로 순환 제한.
  history: TokenUsageHistoryEntry[];
  // fetch/소켓 경로에서 실패가 누적되면 위젯이 '에러 상태 표기' 로 전환된다.
  // null = 성공/미시도, 문자열 = 마지막 에러 메시지.
  loadError: string | null;
  // 세션 토큰 가용 상태(#cdaaabf3). 서버가 `classifyClaudeError` 로 token_exhausted /
  // subscription_expired 를 감지하면 socket 경로로 푸시한다. `exhausted` 가 되면 상단바
  // 영구 배너, DirectivePrompt 전송 버튼, SharedGoalForm 자동 개발 트리거가 동시에
  // 읽기 전용으로 전환된다. 영속화는 하지 않는다 — 새로고침 후에는 서버가 진실을 다시 내려준다.
  sessionStatus: ClaudeSessionStatus;
  // 소진/만료 시 배너에 표출할 마지막 사유 메시지. 선택 필드.
  sessionStatusReason?: string;
}

export const HISTORY_LIMIT = 30;

function emptyState(nowLocal: Date = new Date()): TokenUsageStoreState {
  return {
    all: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    today: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    todayDate: toLocalDateKey(nowLocal),
    history: [],
    loadError: null,
    sessionStatus: 'active',
    sessionStatusReason: undefined,
  };
}

/** 세션 상태 액션 · 불변 교체. 동일 상태+사유면 참조 동일성 유지. */
export function setSessionStatusInState(
  state: TokenUsageStoreState,
  status: ClaudeSessionStatus,
  reason?: string,
): TokenUsageStoreState {
  if (state.sessionStatus === status && state.sessionStatusReason === reason) return state;
  return { ...state, sessionStatus: status, sessionStatusReason: reason };
}

/** 특정 카테고리 1건을 all/today 양쪽에 누적. 자정 롤오버 수행 후 증분. */
export function recordErrorInState(
  state: TokenUsageStoreState,
  category: ClaudeErrorCategory,
  nowLocal: Date = new Date(),
): TokenUsageStoreState {
  const rolled = maybeRollOverDay(state, nowLocal);
  return {
    ...rolled,
    all: recordErrorToTotals(rolled.all, category),
    today: recordErrorToTotals(rolled.today, category),
  };
}

/** totals 가 "의미 있는 기록"(호출 1회 이상 또는 에러 1건 이상) 인지 검사. history 저장 여부 판단용. */
function hasMeaningfulTotals(totals: ClaudeTokenUsageTotals): boolean {
  if (totals.callCount > 0
    || totals.inputTokens > 0
    || totals.outputTokens > 0
    || totals.cacheReadTokens > 0
    || totals.cacheCreationTokens > 0) return true;
  const errors = totals.errors;
  if (!errors) return false;
  for (const c of CLAUDE_ERROR_CATEGORIES) {
    if ((errors[c] ?? 0) > 0) return true;
  }
  return false;
}

/**
 * 로컬 날짜가 바뀌었으면 이전 today 를 history 앞쪽(최신순) 으로 옮기고 today 를
 * 0 으로 리셋한 새 상태를 돌려준다. 바뀌지 않았으면 동일 참조. history 는
 * HISTORY_LIMIT 으로 순환 제한. 호출 카운트가 0 인 today 는 history 에 남기지 않아
 * 빈 날짜가 섞이지 않게 한다.
 */
export function maybeRollOverDay(
  state: TokenUsageStoreState,
  nowLocal: Date = new Date(),
): TokenUsageStoreState {
  const key = toLocalDateKey(nowLocal);
  if (key === state.todayDate) return state;
  const nextHistory = hasMeaningfulTotals(state.today)
    ? [{ date: state.todayDate, totals: state.today }, ...state.history].slice(0, HISTORY_LIMIT)
    : state.history;
  return {
    ...state,
    today: { ...EMPTY_TOTALS, byModel: {} },
    todayDate: key,
    history: nextHistory,
  };
}

/**
 * 증분 한 건을 all/today 양쪽에 누적한다. 호출 전에 자정 롤오버를 먼저 수행해
 * "자정 지난 뒤 도착한 delta" 가 전날의 today 에 섞이지 않게 한다.
 */
export function applyDeltaToState(
  state: TokenUsageStoreState,
  usage: ClaudeTokenUsage,
  nowLocal: Date = new Date(),
): TokenUsageStoreState {
  const rolled = maybeRollOverDay(state, nowLocal);
  return {
    ...rolled,
    all: mergeUsage(rolled.all, usage),
    today: mergeUsage(rolled.today, usage),
    loadError: null,
  };
}

/**
 * 서버 권위 값(all-time)을 받으면 all 축을 통째 교체한다. today 축은 서버가 모르므로
 * 자정 롤오버만 확인한 뒤 그대로 유지. 새로 고침 직후 초기 fetch 경로가 호출한다.
 */
export function hydrateAllFromServer(
  state: TokenUsageStoreState,
  serverTotals: ClaudeTokenUsageTotals,
  nowLocal: Date = new Date(),
): TokenUsageStoreState {
  const rolled = maybeRollOverDay(state, nowLocal);
  return { ...rolled, all: serverTotals, loadError: null };
}

/** 전체 0 으로 되돌린다. 서버 `claude-usage:reset` 이벤트 수신 시. today 도 같이 0. */
export function resetAllToZero(state: TokenUsageStoreState, nowLocal: Date = new Date()): TokenUsageStoreState {
  return emptyState(nowLocal);
}

/** 오늘 축만 수동 0 으로 되돌린다(설정 패널의 '오늘만 리셋' 용도). */
export function resetTodayOnly(state: TokenUsageStoreState, nowLocal: Date = new Date()): TokenUsageStoreState {
  return {
    ...state,
    today: { ...EMPTY_TOTALS, byModel: {} },
    todayDate: toLocalDateKey(nowLocal),
  };
}

/** 에러 상태를 세팅(위젯 테두리/배경이 error-state 토큰으로 전환됨). */
export function setLoadError(state: TokenUsageStoreState, error: string | null): TokenUsageStoreState {
  if (state.loadError === error) return state;
  return { ...state, loadError: error };
}

// ────────────────────────────────────────────────────────────────────────────
// 범위 집계(오늘/주/전체) · 내보내기 입력 데이터 준비
// ────────────────────────────────────────────────────────────────────────────

export type UsageRange = 'today' | 'week' | 'all';

/** 주(최근 7일, today 포함) 구간의 토큰 누적을 돌려준다. history + today 를 합산. */
function aggregateWeek(state: TokenUsageStoreState): ClaudeTokenUsageTotals {
  // 오늘을 시작점으로 잡고 최신순 history 6개를 추가해 합산. 단, history 의 각
  // 엔트리는 날짜 구분이 있지만 합산 시에는 총량만 본다.
  let totals: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, byModel: {} };
  const recent = state.history.slice(0, 6);
  totals = addTotals(totals, state.today);
  for (const entry of recent) totals = addTotals(totals, entry.totals);
  return totals;
}

function addTotals(a: ClaudeTokenUsageTotals, b: ClaudeTokenUsageTotals): ClaudeTokenUsageTotals {
  const mergedByModel: ClaudeTokenUsageTotals['byModel'] = { ...a.byModel };
  for (const [model, m] of Object.entries(b.byModel)) {
    const prev = mergedByModel[model] ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, callCount: 0, estimatedCostUsd: 0 };
    mergedByModel[model] = {
      inputTokens: prev.inputTokens + m.inputTokens,
      outputTokens: prev.outputTokens + m.outputTokens,
      cacheReadTokens: prev.cacheReadTokens + m.cacheReadTokens,
      cacheCreationTokens: prev.cacheCreationTokens + m.cacheCreationTokens,
      callCount: prev.callCount + m.callCount,
      estimatedCostUsd: prev.estimatedCostUsd + m.estimatedCostUsd,
    };
  }
  // 버그(#af3c8877) 수정: 두 피연산자의 errors 카운터도 카테고리별로 합쳐 반환해야
  // selectRange(week) 합계·buildExportRows(week) 의 "합계" 행에서 err_* 가 유실되지
  // 않는다. 미보유(undefined) 는 `ensureErrorCounters` 가 0 키 셋으로 정규화한다.
  const aErr = ensureErrorCounters(a.errors);
  const bErr = ensureErrorCounters(b.errors);
  const mergedErrors = {} as ClaudeErrorCounters;
  for (const c of CLAUDE_ERROR_CATEGORIES) mergedErrors[c] = (aErr[c] ?? 0) + (bErr[c] ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    callCount: a.callCount + b.callCount,
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
    byModel: mergedByModel,
    updatedAt: a.updatedAt > b.updatedAt ? a.updatedAt : b.updatedAt,
    errors: mergedErrors,
  };
}

/** 범위 셀렉터. 내보내기·뷰 모두 이 함수를 써서 단일 출처로 수렴. */
export function selectRange(state: TokenUsageStoreState, range: UsageRange): ClaudeTokenUsageTotals {
  if (range === 'today') return state.today;
  if (range === 'week') return aggregateWeek(state);
  return state.all;
}

// ────────────────────────────────────────────────────────────────────────────
// localStorage 직렬화/역직렬화 — 순수 함수 (SSR 안전)
// ────────────────────────────────────────────────────────────────────────────

export function serializePersistedTotals(state: TokenUsageStoreState, nowIso: string = new Date().toISOString()): ClaudeTokenUsagePersisted {
  return {
    schemaVersion: 1,
    all: state.all,
    today: state.today,
    todayDate: state.todayDate,
    history: state.history,
    savedAt: nowIso,
  };
}

/**
 * localStorage 문자열을 해석해 TokenUsageStoreState 로 복원한다. 로컬 자정 경계를
 * 넘겼으면 today 만 리셋한다. 파싱 실패/버전 불일치/필드 누락은 모두 null 을
 * 반환해 호출자가 empty 로 시작하게 한다.
 */
export function deserializePersistedTotals(
  raw: string | null,
  nowLocal: Date = new Date(),
): TokenUsageStoreState | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ClaudeTokenUsagePersisted> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.schemaVersion !== 1) return null;
    if (!parsed.all || !parsed.today || typeof parsed.todayDate !== 'string') return null;
    const history = Array.isArray(parsed.history)
      ? parsed.history
          .filter((e): e is TokenUsageHistoryEntry => !!e && typeof (e as TokenUsageHistoryEntry).date === 'string')
          .slice(0, HISTORY_LIMIT)
          .map(e => ({ date: e.date, totals: normalizeTotals(e.totals) }))
      : [];
    const base: TokenUsageStoreState = {
      all: normalizeTotals(parsed.all),
      today: normalizeTotals(parsed.today),
      todayDate: parsed.todayDate,
      history,
      loadError: null,
      // 세션 상태는 영속화하지 않는다 — 새 세션은 항상 active 로 시작하고, 서버가
      // 현재 토큰 가용 상태를 내려 주면 그 값으로 즉시 덮여쓴다.
      sessionStatus: 'active',
    };
    return maybeRollOverDay(base, nowLocal);
  } catch {
    return null;
  }
}

function normalizeTotals(raw: unknown): ClaudeTokenUsageTotals {
  const r = raw as Partial<ClaudeTokenUsageTotals> | null | undefined;
  const pick = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);
  return {
    inputTokens: pick(r?.inputTokens),
    outputTokens: pick(r?.outputTokens),
    cacheReadTokens: pick(r?.cacheReadTokens),
    cacheCreationTokens: pick(r?.cacheCreationTokens),
    callCount: pick(r?.callCount),
    estimatedCostUsd: pick(r?.estimatedCostUsd),
    byModel: (r?.byModel && typeof r.byModel === 'object') ? r.byModel : {},
    updatedAt: typeof r?.updatedAt === 'string' ? r.updatedAt : new Date(0).toISOString(),
    errors: ensureErrorCounters(r?.errors),
  };
}

/** 브라우저 환경에서만 동작. SSR/노드 컨텍스트에서는 no-op. 실패는 조용히 삼킨다. */
export function loadFromStorage(nowLocal: Date = new Date()): TokenUsageStoreState | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage?.getItem(TOKEN_USAGE_STORAGE_KEY) ?? null;
    return deserializePersistedTotals(raw, nowLocal);
  } catch {
    return null;
  }
}

/**
 * 공용 퍼블릭 API · `byModel` 엔트리를 `estimatedCostUsd` 내림차순 상위 N 개만 남기고
 * 나머지는 `"기타"` 버킷에 **총합 보존** 형태로 합친다. 시간이 지나 모델 호출 종류가
 * 급증해 영속 페이로드가 localStorage 한도에 근접할 때 `saveToStorage` 폴백으로 호출.
 * totals 의 네 토큰 축/비용/호출 횟수 **총합 자체는 변경되지 않는다**(byModel 재구성만).
 */
export function truncateByModelForQuota(state: TokenUsageStoreState, topN: number): TokenUsageStoreState {
  if (!Number.isFinite(topN) || topN < 0) return state;
  return {
    ...state,
    all: truncateTotalsByModel(state.all, topN),
    today: truncateTotalsByModel(state.today, topN),
    history: state.history.map(entry => ({
      date: entry.date,
      totals: truncateTotalsByModel(entry.totals, topN),
    })),
  };
}

function truncateTotalsByModel(totals: ClaudeTokenUsageTotals, topN: number): ClaudeTokenUsageTotals {
  const entries = Object.entries(totals.byModel);
  if (entries.length <= topN) return totals;
  // 비용 기준 내림차순. 동일 비용이면 호출 횟수 내림차순으로 안정적 정렬.
  const sorted = [...entries].sort((a, b) => {
    const costDiff = b[1].estimatedCostUsd - a[1].estimatedCostUsd;
    if (costDiff !== 0) return costDiff;
    return b[1].callCount - a[1].callCount;
  });
  const head = sorted.slice(0, topN);
  const tail = sorted.slice(topN);
  const kept: ClaudeTokenUsageTotals['byModel'] = {};
  for (const [k, v] of head) kept[k] = v;
  if (tail.length > 0) {
    const merged = tail.reduce(
      (acc, [, v]) => ({
        inputTokens: acc.inputTokens + v.inputTokens,
        outputTokens: acc.outputTokens + v.outputTokens,
        cacheReadTokens: acc.cacheReadTokens + v.cacheReadTokens,
        cacheCreationTokens: acc.cacheCreationTokens + v.cacheCreationTokens,
        callCount: acc.callCount + v.callCount,
        estimatedCostUsd: acc.estimatedCostUsd + v.estimatedCostUsd,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, callCount: 0, estimatedCostUsd: 0 },
    );
    // "기타" 키가 이미 상위에 있으면 합산, 없으면 신설.
    const existingEtc = kept['기타'];
    kept['기타'] = existingEtc
      ? {
          inputTokens: existingEtc.inputTokens + merged.inputTokens,
          outputTokens: existingEtc.outputTokens + merged.outputTokens,
          cacheReadTokens: existingEtc.cacheReadTokens + merged.cacheReadTokens,
          cacheCreationTokens: existingEtc.cacheCreationTokens + merged.cacheCreationTokens,
          callCount: existingEtc.callCount + merged.callCount,
          estimatedCostUsd: existingEtc.estimatedCostUsd + merged.estimatedCostUsd,
        }
      : merged;
  }
  return { ...totals, byModel: kept };
}

export function saveToStorage(state: TokenUsageStoreState, nowIso: string = new Date().toISOString()): void {
  if (typeof window === 'undefined') return;
  const writeOnce = (s: TokenUsageStoreState): boolean => {
    try {
      const payload = serializePersistedTotals(s, nowIso);
      window.localStorage?.setItem(TOKEN_USAGE_STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  };
  if (writeOnce(state)) return;
  // 1차 실패(쿼터 초과 등) — byModel 상위 5 로 잘라 재시도. 토큰/비용 총합 자체는 보존.
  if (writeOnce(truncateByModelForQuota(state, 5))) return;
  // 2차도 실패하면 조용히 무시. 메모리 내 상태는 그대로 유지된다(기존 동작 호환).
}

// ────────────────────────────────────────────────────────────────────────────
// 임계값 판정 — severity 해석
// ────────────────────────────────────────────────────────────────────────────

export const EMPTY_THRESHOLDS: ClaudeTokenUsageThresholds = Object.freeze({
  caution: Object.freeze({}),
  warning: Object.freeze({}),
}) as ClaudeTokenUsageThresholds;

/**
 * 주어진 totals 와 임계값으로 severity 를 판정한다. warning > caution > normal.
 * tokens(= input+output) 와 usd 중 하나라도 임계값을 넘으면 해당 단계로 승격한다.
 */
export function resolveUsageSeverity(
  totals: ClaudeTokenUsageTotals,
  thresholds: ClaudeTokenUsageThresholds,
): ClaudeTokenUsageSeverity {
  const tokens = totals.inputTokens + totals.outputTokens;
  const usd = totals.estimatedCostUsd;
  if (exceeds(thresholds.warning, tokens, usd)) return 'warning';
  if (exceeds(thresholds.caution, tokens, usd)) return 'caution';
  return 'normal';
}

function exceeds(entry: { tokens?: number; usd?: number } | undefined, tokens: number, usd: number): boolean {
  if (!entry) return false;
  if (typeof entry.tokens === 'number' && entry.tokens > 0 && tokens >= entry.tokens) return true;
  if (typeof entry.usd === 'number' && entry.usd > 0 && usd >= entry.usd) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// 외부 스토어 — useSyncExternalStore 타깃
// ────────────────────────────────────────────────────────────────────────────

type Listener = () => void;

let current: TokenUsageStoreState = emptyState();
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

/**
 * 공용 퍼블릭 API · 상단바 `<ClaudeTokenUsage/>` 위젯과 `<TokenUsageSettingsPanel/>` 이
 * 외부에서 소비하는 유일한 진입점. React 19 `useSyncExternalStore` 와 결합하도록
 * `subscribe`·`getSnapshot` 를 노출한다. 서버가 소유한 `all` 축은 `hydrate()` 로만
 * 덮고, 클라이언트 소유인 `today`/`history`/`errors` 는 각 전용 method 로만 갱신한다.
 */
export const claudeTokenUsageStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getSnapshot(): TokenUsageStoreState {
    return current;
  },
  /** 새 마운트 시 1회. localStorage 를 먼저 복원하고 서버 fetch 결과로 all 을 덮는다. */
  restoreFromStorage(nowLocal: Date = new Date()): void {
    const loaded = loadFromStorage(nowLocal);
    if (loaded) {
      current = loaded;
      emit();
    }
  },
  /** 서버 권위 값으로 all 을 교체. today 는 건드리지 않고 자정 롤오버만 적용. */
  hydrate(totals: ClaudeTokenUsageTotals, nowLocal: Date = new Date()): void {
    current = hydrateAllFromServer(current, totals, nowLocal);
    emit();
    saveToStorage(current);
  },
  /** 증분 한 건을 all/today 양쪽에 누적. 자정 경계를 통과. */
  applyDelta(usage: ClaudeTokenUsage, nowLocal: Date = new Date()): void {
    current = applyDeltaToState(current, usage, nowLocal);
    emit();
    saveToStorage(current);
  },
  /** 전역 0 으로 되돌린다(서버 리셋 이벤트). */
  reset(nowLocal: Date = new Date()): void {
    current = resetAllToZero(current, nowLocal);
    emit();
    saveToStorage(current);
  },
  /** 오늘 축만 0 으로 — 설정 패널의 버튼이 호출. */
  resetToday(nowLocal: Date = new Date()): void {
    current = resetTodayOnly(current, nowLocal);
    emit();
    saveToStorage(current);
  },
  /** 에러 상태 세팅. */
  setError(error: string | null): void {
    current = setLoadError(current, error);
    emit();
  },
  /** 카테고리별 에러 1건 누적. 서버 측 totals.errors 와 동기화된 축. */
  recordError(category: ClaudeErrorCategory, nowLocal: Date = new Date()): void {
    current = recordErrorInState(current, category, nowLocal);
    emit();
    saveToStorage(current);
  },
  /**
   * 세션 토큰 가용 상태를 active/warning/exhausted 로 전환. 서버 socket
   * `claude-session:status` 이벤트 수신 시 호출한다. 영속화 대상이 아니므로
   * saveToStorage 를 생략해 localStorage 읽기/쓰기 비용을 줄인다.
   */
  setSessionStatus(status: ClaudeSessionStatus, reason?: string): void {
    const next = setSessionStatusInState(current, status, reason);
    if (next === current) return;
    current = next;
    emit();
  },
  // 테스트 전용: 모듈 상태를 수동으로 교체한다. 프로덕션 경로에서는 쓰지 않는다.
  __setForTest(next: TokenUsageStoreState): void {
    current = next;
    emit();
  },
};
