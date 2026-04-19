// Claude 구독 세션(5시간 주기) 남은 토큰량 계산용 순수 함수 모듈.
//
// 배경
// ────────────────────────────────────────────────────────────────────────────
// 앤트로픽 구독(Claude Pro/Max) 의 사용량은 "첫 호출 시각부터 5시간이 지나면
// 창이 새로 열리고 카운터가 0 으로 리셋" 되는 롤링 윈도우 모델을 따른다.
// 본 모듈은 그 윈도우 전환을 클라이언트 측에서 감지해 상단바 인디케이터
// (TokenUsageIndicator) 가 "남은 토큰 / 총 한도" 를 표시할 수 있도록 계산만
// 담당한다. 영속화·구독·UI 는 호출자(React 컴포넌트) 책임이다.
//
// 설계 원칙
//  1) **순수함수**: now/누적값/이전 상태만 받아 다음 상태와 스냅샷을 반환.
//     React state/useEffect 의 경합 없이 tsx node --test 로 단위 검증 가능.
//  2) **누적값은 외부 소유**: 본 모듈은 ClaudeTokenUsageTotals 의 input+output
//     합계(= cumulativeTokens) 를 받아 "윈도우 시작 시점 값과의 차이" 로
//     사용량을 산출한다. 이렇게 하면 기존 claudeTokenUsageStore 의 `all` 축을
//     truth 로 삼아 중복 축을 만들지 않는다.
//  3) **리셋 감지**: prev 의 windowStartMs 와 now 차이가 WINDOW_MS 이상이면
//     새 윈도우로 전환. 새 윈도우의 시작점 누적값은 "지금 누적값" 이 되어
//     used = 0 으로 리셋된다.
//  4) **폴백 안전**: prev=null 이면 즉시 "지금을 시작으로" 새 윈도우를 만든다.
//     cumulativeTokens 가 비숫자/음수면 0 으로 치환해 NaN 전파를 막는다.

/** 구독 세션 창 길이(ms). 5시간. */
export const SUBSCRIPTION_SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;

/**
 * 기본 세션 한도(토큰). 앤트로픽 구독 플랜 문서는 명시적 토큰 숫자를 공개하지
 * 않으므로(메시지 수·컨텍스트 길이에 따라 변동), 사용자가 프롭으로 조정할 수
 * 있도록 완화된 기본값을 둔다. 1M 토큰은 Claude Max 5x 플랜에서 관찰되는 5시간
 * 상한의 보수 근사값이다. 사용자가 맞추고 싶으면 설정 패널에서 조정한다.
 */
export const DEFAULT_SUBSCRIPTION_TOKEN_LIMIT = 1_000_000;

/** 남은량 비율에 따른 3단계 시각 표식. UI 라벨은 "녹/황/적" 과 1:1 매핑. */
export type SubscriptionSessionSeverity = 'ok' | 'caution' | 'critical';

/** 호출자(컴포넌트)가 영속하거나 ref 로 보관하는 미니 상태. */
export interface SubscriptionSessionState {
  /** 현재 윈도우의 시작 시각(epoch ms). */
  windowStartMs: number;
  /** 윈도우가 열리는 순간의 cumulativeTokens 스냅샷. 뺄셈으로 used 계산. */
  tokensAtWindowStart: number;
}

/** 렌더 1회 분량의 계산 결과. 호출자는 state 를 다음 prev 로 보관한다. */
export interface SubscriptionSessionSnapshot {
  state: SubscriptionSessionState;
  /** 현재 윈도우에서 사용한 토큰 수(=cumulative - tokensAtWindowStart). 0 미만 없음. */
  used: number;
  /** 남은 토큰. max(0, limit - used). */
  remaining: number;
  /** 적용된 한도(입력으로 받은 limit 의 방어적 정규화값). */
  limit: number;
  /** 사용 비율(0~∞). UI 가 0..1 로 클램프해 프로그레스 바에 쓴다. */
  ratioUsed: number;
  /** 다음 리셋 예정 시각(epoch ms). */
  resetAtMs: number;
  /** 시각 표식 단계. */
  severity: SubscriptionSessionSeverity;
  /** 이번 틱에서 5시간 경계를 넘어 윈도우가 리셋됐는가. */
  isReset: boolean;
}

function safeNumber(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0;
  return n;
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_SUBSCRIPTION_TOKEN_LIMIT;
  }
  return limit;
}

/**
 * 비율 → severity 맵. 리셋·폴백 케이스도 동일한 임계를 쓴다.
 *   - ok:       used < 50%  (녹)
 *   - caution:  50% ≤ used < 80%  (황)
 *   - critical: 80% ≤ used  (적)
 * 임계값은 UX 팀의 "절반 넘으면 주의, 80% 넘으면 경고" 지침을 숫자로 고정.
 * 임계값을 바꾸면 본 함수와 TokenUsageIndicator 테스트를 함께 갱신해야 한다.
 */
export function severityFromRatio(ratio: number): SubscriptionSessionSeverity {
  // NaN / 음수는 "아직 데이터 없음/비정상" 으로 보고 ok 로 안전 폴백.
  // +∞ 는 "한도 초과" 로 해석해 critical 로 승격 — 사용자가 즉시 인지해야 한다.
  if (Number.isNaN(ratio) || ratio < 0) return 'ok';
  if (ratio >= 0.8) return 'critical';
  if (ratio >= 0.5) return 'caution';
  return 'ok';
}

/**
 * 현재 cumulative 값과 이전 세션 상태를 받아 스냅샷을 계산한다.
 *
 * 리셋 규칙:
 *   - prev === null        → 새 윈도우 시작(windowStartMs=now, tokensAtWindowStart=cumulative)
 *   - now - windowStartMs ≥ windowMs → 새 윈도우 시작(리셋)
 *   - 그 외                → 동일 윈도우 유지, used = cumulative - tokensAtWindowStart
 *
 * 누적값이 이전 스냅샷보다 작아지는 경우(서버 reset 이벤트로 all=0 이 덮인 직후
 * 등) 는 windowStartMs 를 유지하되 tokensAtWindowStart 를 현재 값으로 당겨와
 * used 가 음수로 나오지 않게 한다. 이는 "서버가 총량을 재시작시켰지만 사용자는
 * 같은 구독 세션 안에 있다" 를 의미하므로 윈도우 자체는 이어 간다.
 */
export function computeSubscriptionSessionSnapshot(params: {
  prev: SubscriptionSessionState | null;
  cumulativeTokens: number;
  nowMs: number;
  limit?: number;
  windowMs?: number;
}): SubscriptionSessionSnapshot {
  const cumulative = safeNumber(params.cumulativeTokens);
  const limit = normalizeLimit(params.limit);
  const windowMs = (params.windowMs && params.windowMs > 0)
    ? params.windowMs
    : SUBSCRIPTION_SESSION_WINDOW_MS;
  const now = Number.isFinite(params.nowMs) ? params.nowMs : 0;

  let state: SubscriptionSessionState;
  let isReset = false;
  if (!params.prev) {
    state = { windowStartMs: now, tokensAtWindowStart: cumulative };
    isReset = false; // 최초 마운트는 "리셋" 이 아니라 "최초 창 열기" — 테두리 깜빡임 회피.
  } else if (now - params.prev.windowStartMs >= windowMs) {
    state = { windowStartMs: now, tokensAtWindowStart: cumulative };
    isReset = true;
  } else if (cumulative < params.prev.tokensAtWindowStart) {
    // 서버 reset 으로 누적이 0 으로 돌아간 경우 — 윈도우는 유지하되 시작점 당김.
    state = { windowStartMs: params.prev.windowStartMs, tokensAtWindowStart: cumulative };
  } else {
    state = params.prev;
  }

  const used = Math.max(0, cumulative - state.tokensAtWindowStart);
  const ratioUsed = limit > 0 ? used / limit : 0;
  const remaining = Math.max(0, limit - used);
  const severity = severityFromRatio(ratioUsed);
  const resetAtMs = state.windowStartMs + windowMs;

  return { state, used, remaining, limit, ratioUsed, resetAtMs, severity, isReset };
}

// ────────────────────────────────────────────────────────────────────────────
// 만료→재리셋 복구 큐 — "세션 소진 중 도착한 요청" 을 유실 없이 보관
// ────────────────────────────────────────────────────────────────────────────
//
// 배경 — 서버가 `token_exhausted`/`subscription_expired` 를 내려보낸 직후에는
// DirectivePrompt·SharedGoalForm 이 읽기 전용으로 전환된다. 그러나 사용자가
// 만료 직전에 이미 enter 로 눌러 "보내기" 를 큐에 올렸거나, 소켓 지연으로 전송이
// 미뤄진 요청은 그대로 사라지면 체감상 "요청이 증발" 한다. 본 유틸은 그 사이에
// 쌓인 요청을 FIFO 로 보관했다가 5시간 윈도우 리셋 또는 상태 전환(active 복귀)
// 시점에 단 1회 flush 하도록 돕는 **순수 함수 집합** 이다. React state · 타이머는
// 호출자(상위 컴포넌트) 책임이다.

/** 큐에 담기는 재시도 항목. 페이로드 내용은 호출자가 자유롭게 정한다. */
export interface PendingSessionRequest<T = unknown> {
  /** 큐 내 동일성을 위한 안정적 id. 호출자가 uuid 등으로 발급. */
  id: string;
  /** 실제 재시도 대상 페이로드(예: DirectivePrompt payload). */
  payload: T;
  /** 큐잉된 시각(ms). flush 시 순서 보존에 활용. */
  queuedAtMs: number;
}

/** 큐 상태. 불변으로 취급해 React state 에 그대로 저장할 수 있다. */
export interface PendingSessionQueue<T = unknown> {
  items: ReadonlyArray<PendingSessionRequest<T>>;
}

/** 최초 상태 — 빈 큐. 공유 상수라 호출자 간 참조 동일성이 유지된다. */
export const EMPTY_PENDING_QUEUE: PendingSessionQueue<never> = Object.freeze({
  items: Object.freeze([]) as ReadonlyArray<PendingSessionRequest<never>>,
}) as PendingSessionQueue<never>;

/**
 * 새 요청을 큐 뒤쪽에 추가한다. 동일 id 가 이미 있으면 원본을 유지해 사용자가
 * "enter 를 두 번 눌렀다" 같은 실수로 중복 재시도가 발생하지 않게 한다.
 * 페이로드/queuedAtMs 가 바뀌어도 기존 항목을 우선한다 — 큐 선두 기준 순서 보존.
 */
export function enqueuePendingRequest<T>(
  queue: PendingSessionQueue<T>,
  req: PendingSessionRequest<T>,
): PendingSessionQueue<T> {
  if (!req || typeof req.id !== 'string' || req.id.length === 0) return queue;
  if (queue.items.some(existing => existing.id === req.id)) return queue;
  return { items: [...queue.items, req] };
}

/**
 * 큐에서 특정 id 를 제거한다(중간 취소 경로용). 존재하지 않으면 동일 참조 반환.
 */
export function dequeuePendingRequest<T>(
  queue: PendingSessionQueue<T>,
  id: string,
): PendingSessionQueue<T> {
  if (!queue.items.some(existing => existing.id === id)) return queue;
  return { items: queue.items.filter(existing => existing.id !== id) };
}

/**
 * 만료→재리셋 전환 판정. 다음 두 조건 중 하나면 "지금 flush 해야 한다".
 *   1) 5시간 윈도우가 경계를 넘어 새로 열림(snapshot.isReset=true).
 *   2) 세션 상태가 exhausted/warning → active 로 풀림.
 * `prevStatus=null` 은 초기 마운트로 해석해 flush 하지 않는다(큐가 비어 있는
 * 상황에서도 괜한 재렌더를 유발하지 않기 위함).
 */
export function shouldFlushPendingQueue(params: {
  prevStatus: 'active' | 'warning' | 'exhausted' | null;
  nextStatus: 'active' | 'warning' | 'exhausted';
  snapshot: Pick<SubscriptionSessionSnapshot, 'isReset'>;
}): boolean {
  if (params.snapshot.isReset) return true;
  if (params.prevStatus === 'exhausted' && params.nextStatus !== 'exhausted') return true;
  if (params.prevStatus === 'warning' && params.nextStatus === 'active') return true;
  return false;
}

/**
 * 큐를 비우고 queuedAtMs 오름차순으로 정렬된 항목 배열을 반환한다. shouldFlush
 * 가 false 면 큐를 건드리지 않고 빈 released 를 돌려준다. 호출자는 released 를
 * 순회하며 실제 재시도를 수행하고, 실패한 항목만 다시 enqueue 하면 된다.
 */
export function flushPendingOnReset<T>(
  queue: PendingSessionQueue<T>,
  shouldFlush: boolean,
): { next: PendingSessionQueue<T>; released: ReadonlyArray<PendingSessionRequest<T>> } {
  if (!shouldFlush || queue.items.length === 0) {
    return { next: queue, released: [] };
  }
  const released = [...queue.items].sort((a, b) => a.queuedAtMs - b.queuedAtMs);
  return { next: EMPTY_PENDING_QUEUE as unknown as PendingSessionQueue<T>, released };
}

/** 지정 시각(ms) 을 HH:MM 형식의 로컬 시간 문자열로 포매팅. 툴팁 라벨 용. */
export function formatResetClock(resetAtMs: number, locale: string = 'ko-KR'): string {
  if (!Number.isFinite(resetAtMs)) return '--:--';
  const d = new Date(resetAtMs);
  // toLocaleTimeString 환경 의존성 회피: 직접 HH:MM 포매팅.
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  // locale 은 파라미터로 받지만 현재 구현은 24시간 표기를 강제한다(한국어 UI 에 맞춤).
  // 미래에 다국어화되면 Intl.DateTimeFormat 으로 교체한다.
  void locale;
  return `${hh}:${mm}`;
}

/** `resetAtMs` 까지 남은 시간을 'Xh Ym' · 'Ym' · '<1m' 형태로 포매팅. 툴팁 보조 라벨용. */
export function formatTimeUntilReset(resetAtMs: number, nowMs: number): string {
  if (!Number.isFinite(resetAtMs) || !Number.isFinite(nowMs)) return '--';
  const remainMs = Math.max(0, resetAtMs - nowMs);
  const mins = Math.floor(remainMs / 60_000);
  if (mins <= 0) return '<1분';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}
