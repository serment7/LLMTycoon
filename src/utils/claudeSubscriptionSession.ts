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

// ────────────────────────────────────────────────────────────────────────────
// 다중 탭 동기화 — 한 탭에서 리셋/만료가 일어나면 다른 탭도 즉시 수렴
// ────────────────────────────────────────────────────────────────────────────
//
// 브라우저가 지원하면 BroadcastChannel, 미지원 환경은 `storage` 이벤트로 폴백한다.
// 본 모듈은 두 경로가 공유하는 **직렬화·충돌 해결 순수 함수** 만 제공하고, 실제
// 채널 인스턴스(BroadcastChannel 또는 window.storage 리스너) 는 호출자가 소유한다.
// 그래야 Node(테스트) 에서도 envelope 파싱/충돌 해결 계약을 그대로 검증할 수 있다.

/** 동기화 채널이 exchange 하는 최소 메시지 모양. 작은 JSON 으로 직렬화 가능. */
export interface SessionSyncEnvelope {
  schemaVersion: 1;
  /** state: 윈도우 시작점·누적 스냅샷 / status: 만료·활성 전환. */
  kind: 'state' | 'status';
  /** 탭 고유 id — 자기 자신이 보낸 envelope 를 수신측에서 무시(에코 방지). */
  tabId: string;
  /** envelope 발신 시각(epoch ms). 너무 오래된/미래 메시지 필터링에 사용. */
  emittedAtMs: number;
  /** kind='state' 일 때의 state 페이로드. null 이면 "세션 상태 리셋" 신호. */
  state?: SubscriptionSessionState | null;
  /** kind='status' 일 때의 상태 페이로드. 사유는 배너/토스트 용. */
  status?: { value: 'active' | 'warning' | 'exhausted'; reason?: string };
}

/** envelope 를 만든다. 페이로드 유효성 검증은 parse 쪽에서 담당. */
export function buildSessionSyncEnvelope(params: {
  kind: 'state' | 'status';
  tabId: string;
  emittedAtMs: number;
  state?: SubscriptionSessionState | null;
  status?: { value: 'active' | 'warning' | 'exhausted'; reason?: string };
}): SessionSyncEnvelope {
  return {
    schemaVersion: 1,
    kind: params.kind,
    tabId: params.tabId,
    emittedAtMs: params.emittedAtMs,
    state: params.kind === 'state' ? (params.state ?? null) : undefined,
    status: params.kind === 'status' ? params.status : undefined,
  };
}

/** 파싱 실패/스키마 불일치는 null 을 반환해 호출자가 조용히 무시할 수 있도록 한다. */
export function parseSessionSyncEnvelope(raw: unknown): SessionSyncEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<SessionSyncEnvelope> & { state?: unknown; status?: unknown };
  if (r.schemaVersion !== 1) return null;
  if (r.kind !== 'state' && r.kind !== 'status') return null;
  if (typeof r.tabId !== 'string' || r.tabId.length === 0) return null;
  if (typeof r.emittedAtMs !== 'number' || !Number.isFinite(r.emittedAtMs)) return null;
  const out: SessionSyncEnvelope = {
    schemaVersion: 1,
    kind: r.kind,
    tabId: r.tabId,
    emittedAtMs: r.emittedAtMs,
  };
  if (r.kind === 'state') {
    const s = r.state as Partial<SubscriptionSessionState> | null | undefined;
    if (s && typeof s === 'object'
      && typeof s.windowStartMs === 'number' && Number.isFinite(s.windowStartMs)
      && typeof s.tokensAtWindowStart === 'number' && Number.isFinite(s.tokensAtWindowStart)) {
      out.state = { windowStartMs: s.windowStartMs, tokensAtWindowStart: s.tokensAtWindowStart };
    } else {
      out.state = null;
    }
  }
  if (r.kind === 'status') {
    const st = r.status as { value?: unknown; reason?: unknown } | undefined;
    if (st && (st.value === 'active' || st.value === 'warning' || st.value === 'exhausted')) {
      out.status = { value: st.value, reason: typeof st.reason === 'string' ? st.reason : undefined };
    } else {
      return null;
    }
  }
  return out;
}

/**
 * 수신 envelope 가 로컬 상태에 반영돼야 하는지 판단한다.
 *   - 자기 탭이 보낸 에코는 무시
 *   - emittedAtMs 가 maxAgeMs(기본 60초) 보다 오래됐거나 미래이면 무시
 *     (탭 시계 틀어짐·재생 공격 방지)
 */
export function shouldAcceptSyncEnvelope(params: {
  envelope: SessionSyncEnvelope;
  localTabId: string;
  nowMs: number;
  maxAgeMs?: number;
}): boolean {
  if (params.envelope.tabId === params.localTabId) return false;
  const maxAge = params.maxAgeMs && params.maxAgeMs > 0 ? params.maxAgeMs : 60_000;
  const skew = params.nowMs - params.envelope.emittedAtMs;
  if (skew > maxAge) return false;
  if (skew < -maxAge) return false;
  return true;
}

/**
 * 두 세션 상태(로컬 vs 원격 탭) 의 충돌을 해결한다.
 * 규칙:
 *   1) 한 쪽이 null 이면 non-null 쪽 사용.
 *   2) windowStartMs 가 더 큰(=더 최근에 리셋된) 쪽을 선호 — 리셋 사실이 유실되지 않는다.
 *   3) 동률이면 tokensAtWindowStart 가 더 작은(=덜 사용한 시점) 쪽 — 서버 reset 직후
 *      누적이 내려간 탭과 그대로인 탭이 섞여도 `used` 가 음수로 튀지 않는다.
 */
export function resolveSessionStateConflict(
  local: SubscriptionSessionState | null,
  remote: SubscriptionSessionState | null,
): SubscriptionSessionState | null {
  if (!local) return remote;
  if (!remote) return local;
  if (remote.windowStartMs > local.windowStartMs) return remote;
  if (remote.windowStartMs < local.windowStartMs) return local;
  if (remote.tokensAtWindowStart < local.tokensAtWindowStart) return remote;
  return local;
}

// ────────────────────────────────────────────────────────────────────────────
// 새로고침 복원 — localStorage 스냅샷 + 서버 응답 치환
// ────────────────────────────────────────────────────────────────────────────

/** localStorage 키 — 스키마 변경 시 v1 → v2 로 올려 역호환을 끊는다. */
export const SUBSCRIPTION_SESSION_STORAGE_KEY = 'llmtycoon.subscriptionSession.v1';

/** 디스크 영속 형태. 서버가 알지 못하는 "마지막으로 본 상태" 를 새로고침 틈을 막는 용도. */
export interface PersistedSubscriptionSession {
  schemaVersion: 1;
  state: SubscriptionSessionState;
  status: 'active' | 'warning' | 'exhausted';
  statusReason?: string;
  savedAtMs: number;
}

export function serializePersistedSession(params: {
  state: SubscriptionSessionState;
  status: 'active' | 'warning' | 'exhausted';
  statusReason?: string;
  savedAtMs: number;
}): PersistedSubscriptionSession {
  return {
    schemaVersion: 1,
    state: { windowStartMs: params.state.windowStartMs, tokensAtWindowStart: params.state.tokensAtWindowStart },
    status: params.status,
    statusReason: params.statusReason,
    savedAtMs: params.savedAtMs,
  };
}

/**
 * 저장된 JSON 을 해석해 복원 가능한 스냅샷만 돌려준다. 다음 조건에서 null 을 반환:
 *   - 파싱 실패 / 스키마 불일치
 *   - savedAtMs 가 nowMs 기준 maxAgeMs(기본 WINDOW_MS) 초과 → 이미 "창 밖" 데이터
 *   - state 의 windowStartMs 가 nowMs 기준 WINDOW_MS 이상 지남 → 어차피 새 창이 열림
 */
export function deserializePersistedSession(
  raw: unknown,
  nowMs: number,
  options?: { maxAgeMs?: number; windowMs?: number },
): PersistedSubscriptionSession | null {
  if (!raw) return null;
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); }
    catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const r = parsed as Partial<PersistedSubscriptionSession>;
  if (r.schemaVersion !== 1) return null;
  if (!r.state || typeof r.state.windowStartMs !== 'number' || typeof r.state.tokensAtWindowStart !== 'number') return null;
  if (!Number.isFinite(r.state.windowStartMs) || !Number.isFinite(r.state.tokensAtWindowStart)) return null;
  if (r.status !== 'active' && r.status !== 'warning' && r.status !== 'exhausted') return null;
  if (typeof r.savedAtMs !== 'number' || !Number.isFinite(r.savedAtMs)) return null;

  const windowMs = options?.windowMs && options.windowMs > 0 ? options.windowMs : SUBSCRIPTION_SESSION_WINDOW_MS;
  const maxAge = options?.maxAgeMs && options.maxAgeMs > 0 ? options.maxAgeMs : windowMs;
  if (nowMs - r.savedAtMs > maxAge) return null;
  if (nowMs - r.state.windowStartMs >= windowMs) return null;

  return {
    schemaVersion: 1,
    state: { windowStartMs: r.state.windowStartMs, tokensAtWindowStart: r.state.tokensAtWindowStart },
    status: r.status,
    statusReason: typeof r.statusReason === 'string' ? r.statusReason : undefined,
    savedAtMs: r.savedAtMs,
  };
}

/**
 * 새로고침 직후 "localStorage 복원 → 서버 응답" 두 입력을 하나의 권위값으로 치환한다.
 *
 * 네트워크 복구 순서 방어:
 *   - 서버가 응답하면 서버 status 가 진실로 승격(치환). 로컬이 exhausted 였어도
 *     서버가 active 라고 말하면 즉시 active 로 복귀 — "만료 배지가 새로고침 뒤에도
 *     남아 있는" UX 회귀를 막는다.
 *   - 서버 응답이 아직 없으면(null) 복원값 유지 — 네트워크가 느려도 이전 화면을
 *     재현해 사용자 체감 대기를 줄인다.
 *   - 두 쪽 모두 없으면 state=null, status='active' 로 초기값 폴백.
 */
export function reconcileRestoredWithServer(params: {
  restored: PersistedSubscriptionSession | null;
  serverStatus: 'active' | 'warning' | 'exhausted' | null;
  serverStatusReason?: string;
  nowMs: number;
}): {
  state: SubscriptionSessionState | null;
  status: 'active' | 'warning' | 'exhausted';
  statusReason?: string;
} {
  const restored = params.restored;
  if (params.serverStatus !== null) {
    return {
      state: restored ? restored.state : null,
      status: params.serverStatus,
      statusReason: params.serverStatusReason,
    };
  }
  if (restored) {
    return { state: restored.state, status: restored.status, statusReason: restored.statusReason };
  }
  return { state: null, status: 'active' };
}

// ────────────────────────────────────────────────────────────────────────────
// 세션 신호 → 토스트 변환(#3773fc8d)
// ────────────────────────────────────────────────────────────────────────────
//
// 배경 — 서버가 방송하는 토큰 소진·구독 만료·레이트리밋·네트워크 단절은
// 상단바 배너만으로는 "지금 재시도 중인지" 가 드러나지 않는다. 본 함수는 신호와
// 현재 재시도 큐 길이를 받아 ToastProvider 가 그대로 소비할 수 있는 페이로드를
// 돌려준다. 재시도 큐에 대기 항목이 있으면 "지금 N건 재시도" 액션 버튼을 노출하고,
// 없으면 액션을 생략해 조용한 배너로 수렴한다.

export type SessionToastSignal =
  | 'token_exhausted'
  | 'subscription_expired'
  | 'rate_limit'
  | 'network_offline'
  | 'session_restored';

export interface SessionToastPayload {
  /** ToastVariant 와 동일 축: 팔레트/아이콘이 이 값으로 결정된다. */
  severity: 'info' | 'warning' | 'error';
  /** 한 줄 제목(필수). */
  title: string;
  /** 보조 설명(선택). */
  body?: string;
  /** aria-live. error 는 assertive, 그 외 polite. */
  ariaLive: 'polite' | 'assertive';
  /** 조치 버튼. 재시도 큐가 비어 있으면 label/kind 를 생략해 "조용한 배너" 로. */
  action?: { label: string; kind: 'retry-now' | 'open-settings' };
}

/**
 * 세션 신호를 토스트 페이로드로 변환한다. 본 함수는 순수하며, React · DOM 접근이
 * 없어 Node 에서 직접 호출해 계약을 잠글 수 있다.
 */
export function sessionSignalToToast(params: {
  signal: SessionToastSignal;
  queueLength: number;
}): SessionToastPayload {
  const queueN = Math.max(0, Number.isFinite(params.queueLength) ? params.queueLength : 0);
  // 재시도 큐에 대기 항목이 있을 때만 "지금 N건 재시도" 조치 버튼을 노출한다.
  const retry = queueN > 0
    ? { label: `${queueN}건 지금 재시도`, kind: 'retry-now' as const }
    : undefined;

  switch (params.signal) {
    case 'token_exhausted':
      return {
        severity: 'warning',
        title: '세션 토큰이 소진되었습니다',
        body: '5시간 창이 갱신되면 자동으로 이어집니다.',
        ariaLive: 'polite',
        action: retry,
      };
    case 'subscription_expired':
      return {
        severity: 'error',
        title: '구독이 만료되었습니다',
        body: '결제 상태를 확인하거나 다시 구독해 주세요.',
        ariaLive: 'assertive',
        action: { label: '설정 열기', kind: 'open-settings' },
      };
    case 'rate_limit':
      return {
        severity: 'warning',
        title: '요청이 잠시 제한되었습니다',
        body: '잠시 후 자동으로 다시 시도합니다.',
        ariaLive: 'polite',
        action: retry,
      };
    case 'network_offline':
      return {
        severity: 'info',
        title: '네트워크가 일시적으로 끊겼어요',
        body: '연결이 복구되면 자동으로 이어집니다.',
        ariaLive: 'polite',
        action: retry,
      };
    case 'session_restored':
      return {
        severity: 'info',
        title: '세션이 복구되었습니다',
        // 복구 직후 큐가 남아 있으면 사용자 확인을 기다리는 편이 UX 상 분명.
        body: queueN > 0 ? `대기 중인 ${queueN}건을 다시 시도할 수 있어요.` : undefined,
        ariaLive: 'polite',
        action: retry,
      };
  }
}

/**
 * OAuth `/api/oauth/usage` 의 `five_hour.resets_at` 은 ISO8601 문자열 또는 Unix 초
 * (일부 클라이언트·문서) 로 올 수 있다. JS `Date` 는 초 단위를 ms 로 잘못 넣으면
 * 1970년 근처로 깨지고, 숫자만 문자열로 오면 `Date.parse` 가 실패한다.
 */
export function parseOAuthResetsAtToMs(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (/^\d+(\.\d+)?$/.test(t)) {
      const n = Number(t);
      if (!Number.isFinite(n)) return null;
      return n < 1e12 ? n * 1000 : n;
    }
    const p = Date.parse(t);
    if (Number.isFinite(p)) return p;
  }
  return null;
}

/**
 * API 가 창 경계 직전 시각(예: …T04:59:59.000000+00:00)을 주면 로컬 시계가 XX:59 로
 * 보인다. 다음 분 시작(정각)으로 올려 `/usage` 에서 기대하는 "정각 리셋" 표기와
 * 남은 시간(`formatTimeUntilReset`) 을 맞춘다.
 */
export function normalizeOauthResetsAtWallClockMs(ms: number): number {
  if (!Number.isFinite(ms)) return ms;
  return Math.ceil(ms / 60_000) * 60_000;
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

// ────────────────────────────────────────────────────────────────────────────
// Claude Messages API 첨부 어댑터 (#e5965192)
// ────────────────────────────────────────────────────────────────────────────
//
// `MediaChatAttachment`(클라가 정규화한 첨부) 를 Claude Messages API 의 컨텐츠 블록
// (`type: 'text' | 'document' | 'image'`) 배열로 변환한다. 본 모듈은 바이트를 다루지
// 않으므로 파일 바이트 원본은 호출자(서버 라우트 또는 App.tsx) 가 `sourceResolver`
// 콜백으로 주입한다. 콜백이 null 을 반환하거나 미주입이면 요약 텍스트 블록으로
// 폴백해 "첨부가 컨텍스트에서 사라지는" 회귀를 막는다. 영상은 Anthropic API 가 현재
// 지원하지 않으므로 언제나 텍스트 요약 블록으로 수렴한다.
//
// 설계상 본 함수는 React/DOM 접근이 없다. tsx --test 환경에서 입력·출력만으로 계약을
// 잠글 수 있도록 순수함수로 유지한다.

import type { MediaChatAttachment } from './mediaLoaders';

/** Claude Messages API 에서 문서·이미지 블록이 공유하는 소스 표현. */
export type ClaudeAttachmentSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string };

/** 본 모듈이 돌려주는 컨텐츠 블록. Claude SDK 타입과 호환되도록 최소 필드만 둔다. */
export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'document'; source: ClaudeAttachmentSource; title?: string; context?: string }
  | { type: 'image'; source: ClaudeAttachmentSource };

export interface BuildClaudeAttachmentBlocksOptions {
  /**
   * 첨부마다 바이트·URL 소스를 돌려주는 콜백. 반환이 null 이면 텍스트 폴백 블록으로
   * 대체된다. 서버 라우트가 MediaAsset.storageUrl 을 조회하거나, App.tsx 가 이미
   * 메모리에 가진 Blob 을 base64 로 인코딩해 넘길 때 이 자리에 끼워 넣는다.
   */
  sourceResolver?: (attachment: MediaChatAttachment) => ClaudeAttachmentSource | null;
  /** 요약 한 줄의 최대 길이. 기본 120자. */
  maxSummaryChars?: number;
}

export interface BuiltClaudeAttachmentPayload {
  /** 시스템/유저 메시지 앞에 접두로 붙일 요약. 빈 문자열이면 붙이지 않는다. */
  summaryText: string;
  /** 변환된 컨텐츠 블록 배열(첨부 0건이면 빈 배열). */
  blocks: ClaudeContentBlock[];
}

function clampText(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function attachmentToTextFallback(att: MediaChatAttachment): ClaudeContentBlock {
  const lines: string[] = [`[첨부 ${att.summary}]`];
  if (att.textExcerpt) lines.push(att.textExcerpt);
  // audio 전용 메타 — 파형 요약은 peaks 배열을 8개 구간으로 축약해 '▁▃▅…' 같은
  // 스파크 시그니처로 모델이 톤·강약을 유추할 수 있게 한다. Anthropic API 는 아직
  // 오디오 블록을 받지 않아 text 로 전달하는 것이 최선이다.
  if (att.kind === 'audio') {
    if (typeof att.durationMs === 'number') {
      lines.push(`길이: ${Math.max(1, Math.round(att.durationMs / 1000))}초`);
    }
    if (Array.isArray(att.waveformPeaks) && att.waveformPeaks.length > 0) {
      lines.push(`파형: ${spark(att.waveformPeaks)}`);
    }
  }
  return { type: 'text', text: lines.join('\n') };
}

/** 0..1 사이 peaks 배열을 한 줄 블록 문자 시그니처로 축약. 텍스트 LLM 이 소비한다. */
function spark(peaks: readonly number[]): string {
  if (peaks.length === 0) return '';
  const blocks = '▁▂▃▄▅▆▇█';
  // 최대 8개 구간으로 리샘플링한다 — 너무 긴 파형은 토큰만 먹는다.
  const SLOTS = Math.min(8, peaks.length);
  const step = peaks.length / SLOTS;
  let out = '';
  for (let i = 0; i < SLOTS; i += 1) {
    const s = Math.floor(i * step);
    const e = Math.min(peaks.length, Math.floor((i + 1) * step));
    let sum = 0;
    for (let j = s; j < e; j += 1) sum += Math.max(0, Math.min(1, peaks[j]));
    const avg = sum / Math.max(1, e - s);
    const idx = Math.min(blocks.length - 1, Math.round(avg * (blocks.length - 1)));
    out += blocks[idx];
  }
  return out;
}

/**
 * 첨부 배열을 Claude 컨텐츠 블록으로 변환하고, 리더 시스템/유저 메시지에 접두로
 * 붙일 요약 문자열도 함께 돌려준다. 첨부가 비면 빈 블록과 빈 요약을 반환한다.
 */
export function buildClaudeAttachmentBlocks(
  attachments: readonly MediaChatAttachment[],
  options: BuildClaudeAttachmentBlocksOptions = {},
): BuiltClaudeAttachmentPayload {
  const maxSummary = options.maxSummaryChars && options.maxSummaryChars > 0
    ? options.maxSummaryChars
    : 120;
  const resolver = options.sourceResolver;
  const blocks: ClaudeContentBlock[] = [];
  const summaries: string[] = [];

  for (const att of attachments) {
    summaries.push(att.summary);

    if (att.kind === 'video' || att.kind === 'audio') {
      // Claude API 는 현재 영상·오디오 블록을 받지 않는다 — 요약 텍스트로만 전달.
      blocks.push(attachmentToTextFallback(att));
      continue;
    }

    const source = resolver ? resolver(att) : null;
    if (!source) {
      blocks.push(attachmentToTextFallback(att));
      continue;
    }

    if (att.kind === 'image') {
      blocks.push({ type: 'image', source });
      continue;
    }

    // pdf / pptx → document 블록. Claude 는 PDF 를 직접 소비하지만 PPT 는 아직
    // 미지원이므로, MIME 에 따라 text 폴백으로 수렴한다.
    if (att.mimeType === 'application/pdf') {
      blocks.push({
        type: 'document',
        source,
        title: clampText(att.name, maxSummary),
        context: att.textExcerpt ? clampText(att.textExcerpt, maxSummary) : undefined,
      });
      continue;
    }

    // PPTX(혹은 예외 MIME) 는 텍스트 발췌만 전달.
    blocks.push(attachmentToTextFallback(att));
  }

  const summaryText = summaries.length > 0
    ? `첨부 ${summaries.length}건: ${summaries.map(s => clampText(s, maxSummary)).join(' · ')}`
    : '';

  return { summaryText, blocks };
}

/**
 * 기존 시스템 프롬프트 문자열 앞에 첨부 요약 섹션을 접두로 붙인다. 첨부가 없으면
 * 원본을 그대로 돌려주어 호출자가 분기 없이 사용할 수 있다. 구분자는 두 줄 공백
 * 으로 고정해 리더 프롬프트의 기존 섹션 헤더 패턴과 충돌하지 않게 한다.
 */
export function prefixSystemPromptWithAttachments(
  systemPrompt: string,
  attachments: readonly MediaChatAttachment[],
  options: BuildClaudeAttachmentBlocksOptions = {},
): string {
  if (!attachments || attachments.length === 0) return systemPrompt;
  const { summaryText } = buildClaudeAttachmentBlocks(attachments, options);
  if (!summaryText) return systemPrompt;
  return `## 첨부 요약\n${summaryText}\n\n${systemPrompt}`;
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
