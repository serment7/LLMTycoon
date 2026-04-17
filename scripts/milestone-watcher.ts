// Watches agent events and dispatches milestone automation exactly-once per
// (agentId, milestoneId) pair within SEEN_TTL_MS. Side effects live in
// milestone-automation; this module owns dedup, retry, and observability.
import { handleMilestone } from './milestone-automation.js';

export type AgentEvent = {
  agentId: string;
  milestoneId?: string;
  reachedMilestone?: boolean;
  title?: string;
  baseBranch?: string;
  body?: string;
  timestamp?: number;
};

export type WatcherMetrics = {
  received: number;
  skipped: number;
  processed: number;
  failed: number;
  retries: number;
  // Timeouts bubble up through `failed` too, but we keep a dedicated counter
  // because a timeout points at a wedged downstream — alerting wants to
  // distinguish that from plain errors.
  timedOut: number;
  lastError?: string;
  lastProcessedAt?: number;
  lastLatencyMs?: number;
  maxLatencyMs: number;
  skippedByReason: Record<SkipReason, number>;
};

export type SkipReason =
  | 'not-milestone'
  | 'malformed'
  | 'duplicate'
  | 'in-flight'
  | 'timeout'
  | 'circuit-open';

export type CircuitState = 'closed' | 'open' | 'half-open';

export type HealthStatus = {
  healthy: boolean;
  inFlight: number;
  seen: number;
  failureRate: number;
  staleMs?: number;
  circuit: CircuitState;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  // Current depth of the dead-letter ring buffer. A non-zero value alone is
  // not unhealthy — a rising depth between drains is. Surfaced here so probes
  // that scrape /health notice DLQ accumulation without a separate endpoint.
  dlqDepth: number;
};

// Distinguishes *why* an event failed validation. The caller-visible
// `SkipReason` collapses all of these into `'malformed'`; this finer-grained
// reason is surfaced through `validateEvent` for tests and operator tooling
// that want to assert on the specific failure mode.
export type ValidationFailure =
  | 'missing-event'
  | 'not-reached'
  | 'missing-agent-id'
  | 'invalid-agent-id'
  | 'missing-milestone-id'
  | 'invalid-milestone-id';

export type ValidationResult = { ok: boolean; reason?: ValidationFailure };

export type WatcherListener = (
  event: 'processed' | 'skipped' | 'failed',
  payload: { key: string; error?: string; reason?: SkipReason; latencyMs?: number },
) => void;

const SEEN_TTL_MS = 24 * 60 * 60 * 1000;
const SEEN_MAX_ENTRIES = 10_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 500;
// Dead-letter ring buffer size. QA triages wedges by replaying the last N
// failed events; larger than typical per-incident fan-out but bounded so a
// sustained outage can't OOM the process.
const DLQ_MAX_ENTRIES = 128;
// Upper bound on a single handleMilestone invocation. If the downstream
// dispatcher wedges, we'd rather surface a timeout than hold the slot open
// forever and starve later events on the same (agent, milestone) pair.
const HANDLE_TIMEOUT_MS = 60_000;
const STALE_AFTER_MS = 15 * 60 * 1000;
const UNHEALTHY_FAILURE_RATE = 0.25;

const seen = new Map<string, number>();
const inFlight = new Set<string>();
// Parallel map of in-flight start timestamps keyed by the same
// `agentId:milestoneId` composite. Kept alongside the Set so UI consumers
// (GitAutomationPanel / AgentStatusPanel live badges) can render "진행 중 N초"
// without having to instrument every call site that mutates `inFlight`.
const inFlightStartedAt = new Map<string, number>();
const listeners = new Set<WatcherListener>();

export type DeadLetterEntry = {
  key: string;
  agentId: string;
  milestoneId: string;
  error: string;
  attempts: number;
  timedOut: boolean;
  failedAt: number;
};

// Ring buffer of terminal failures after retries are exhausted. We keep the
// failing event's identity (but not its body) so QA can correlate with logs
// without the buffer becoming a PII sink.
const deadLetters: DeadLetterEntry[] = [];
let dlqCursor = 0;

function pushDeadLetter(entry: DeadLetterEntry): void {
  if (deadLetters.length < DLQ_MAX_ENTRIES) {
    deadLetters.push(entry);
  } else {
    deadLetters[dlqCursor] = entry;
    dlqCursor = (dlqCursor + 1) % DLQ_MAX_ENTRIES;
  }
}

function emptySkipCounters(): Record<SkipReason, number> {
  return {
    'not-milestone': 0,
    malformed: 0,
    duplicate: 0,
    'in-flight': 0,
    timeout: 0,
    'circuit-open': 0,
  };
}

// Circuit breaker: after CIRCUIT_FAILURE_THRESHOLD consecutive failures we
// stop dispatching for CIRCUIT_COOLDOWN_MS. The first attempt after cooldown
// runs in half-open mode — success closes the circuit, another failure
// re-opens it. This protects the downstream from a thundering herd while it
// is already known-bad.
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 30_000;

const circuit: { state: CircuitState; consecutiveFailures: number; openedAt: number } = {
  state: 'closed',
  consecutiveFailures: 0,
  openedAt: 0,
};

function circuitAllows(now: number): boolean {
  if (circuit.state === 'closed') return true;
  if (circuit.state === 'open' && now - circuit.openedAt >= CIRCUIT_COOLDOWN_MS) {
    circuit.state = 'half-open';
    return true;
  }
  return circuit.state === 'half-open';
}

function recordCircuitSuccess(): void {
  circuit.consecutiveFailures = 0;
  circuit.state = 'closed';
}

function recordCircuitFailure(now: number): void {
  circuit.consecutiveFailures++;
  if (circuit.state === 'half-open' || circuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuit.state = 'open';
    circuit.openedAt = now;
  }
}

const metrics: WatcherMetrics = {
  received: 0,
  skipped: 0,
  processed: 0,
  failed: 0,
  retries: 0,
  timedOut: 0,
  maxLatencyMs: 0,
  skippedByReason: emptySkipCounters(),
};

// Rolling window of per-event latencies (ms) used to compute p50/p95.
// Fixed-size ring buffer so we don't grow unbounded under sustained load;
// the window is large enough that percentiles stay meaningful but small
// enough that one pathological spike ages out within minutes of normal
// traffic.
const LATENCY_WINDOW = 256;
const latencyWindow: number[] = [];
let latencyCursor = 0;

function recordLatency(ms: number): void {
  if (latencyWindow.length < LATENCY_WINDOW) {
    latencyWindow.push(ms);
  } else {
    latencyWindow[latencyCursor] = ms;
    latencyCursor = (latencyCursor + 1) % LATENCY_WINDOW;
  }
}

function percentile(sortedAsc: number[], p: number): number | undefined {
  if (sortedAsc.length === 0) return undefined;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

class WatcherTimeoutError extends Error {
  readonly retryable = true;
  constructor(label: string, ms: number) {
    super(`${label} exceeded ${ms}ms`);
    this.name = 'WatcherTimeoutError';
  }
}

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MILESTONE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Returns a structured validation result. Callers that only need a boolean
// should use `isValid`; tests and operator tooling use `validateEvent` to
// assert on the exact failure mode without grepping log strings.
export function validateEvent(ev: AgentEvent | null | undefined): ValidationResult {
  if (!ev || typeof ev !== 'object') return { ok: false, reason: 'missing-event' };
  if (ev.agentId === undefined || ev.agentId === null || ev.agentId === '') {
    return { ok: false, reason: 'missing-agent-id' };
  }
  if (!AGENT_ID_RE.test(ev.agentId)) return { ok: false, reason: 'invalid-agent-id' };
  if (ev.milestoneId === undefined || ev.milestoneId === null || ev.milestoneId === '') {
    return { ok: false, reason: 'missing-milestone-id' };
  }
  if (!MILESTONE_ID_RE.test(ev.milestoneId)) return { ok: false, reason: 'invalid-milestone-id' };
  return { ok: true };
}

function isValid(
  ev: AgentEvent,
): ev is Required<Pick<AgentEvent, 'agentId' | 'milestoneId'>> & AgentEvent {
  return validateEvent(ev).ok;
}

function pruneSeen(now: number): void {
  for (const [key, ts] of seen) {
    if (now - ts > SEEN_TTL_MS) seen.delete(key);
  }
  // Hard cap guards against a flood of unique keys within the TTL window.
  // Map iteration order is insertion order, so we drop the oldest first.
  if (seen.size > SEEN_MAX_ENTRIES) {
    const overflow = seen.size - SEEN_MAX_ENTRIES;
    const iter = seen.keys();
    for (let i = 0; i < overflow; i++) {
      const next = iter.next();
      if (next.done) break;
      seen.delete(next.value);
    }
  }
}

function notify(
  event: 'processed' | 'skipped' | 'failed',
  payload: { key: string; error?: string; reason?: SkipReason; latencyMs?: number },
): void {
  for (const listener of listeners) {
    try {
      listener(event, payload);
    } catch (err) {
      console.warn('[milestone-watcher] listener threw:', err);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Non-retryable errors fail fast: validation, auth, explicit abort. These are
// marked by throwing `Object.assign(new Error(msg), { retryable: false })`
// from handleMilestone. Anything else is treated as transient.
function isRetryable(err: unknown): boolean {
  if (err && typeof err === 'object' && 'retryable' in err) {
    return (err as { retryable?: boolean }).retryable !== false;
  }
  return true;
}

function recordSkip(reason: SkipReason, key: string): void {
  metrics.skipped++;
  metrics.skippedByReason[reason]++;
  notify('skipped', { key, reason });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new WatcherTimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function onAgentEvent(ev: AgentEvent): Promise<void> {
  metrics.received++;
  const now = Date.now();
  pruneSeen(now);

  if (!ev?.reachedMilestone) {
    recordSkip('not-milestone', ev?.agentId ?? '<unknown>');
    return;
  }
  if (!isValid(ev)) {
    const validation = validateEvent(ev);
    console.warn('[milestone-watcher] rejected malformed event', {
      agentId: ev?.agentId,
      milestoneId: ev?.milestoneId,
      reason: validation.reason,
    });
    recordSkip('malformed', `${ev?.agentId ?? '?'}:${ev?.milestoneId ?? '?'}`);
    return;
  }

  const key = `${ev.agentId}:${ev.milestoneId}`;
  if (seen.has(key)) {
    recordSkip('duplicate', key);
    return;
  }
  if (inFlight.has(key)) {
    recordSkip('in-flight', key);
    return;
  }
  if (!circuitAllows(now)) {
    recordSkip('circuit-open', key);
    return;
  }

  inFlight.add(key);
  const startedAt = Date.now();
  inFlightStartedAt.set(key, startedAt);
  let attempt = 0;
  try {
    while (true) {
      try {
        await withTimeout(
          handleMilestone({
            id: ev.milestoneId,
            title: ev.title?.trim() || `milestone ${ev.milestoneId}`,
            branch: `auto/${ev.agentId}/${ev.milestoneId}`,
            baseBranch: ev.baseBranch,
            body: ev.body,
          }),
          HANDLE_TIMEOUT_MS,
          `handleMilestone ${key}`,
        );
        const latencyMs = Date.now() - startedAt;
        seen.set(key, Date.now());
        metrics.processed++;
        metrics.lastProcessedAt = Date.now();
        metrics.lastLatencyMs = latencyMs;
        if (latencyMs > metrics.maxLatencyMs) metrics.maxLatencyMs = latencyMs;
        recordLatency(latencyMs);
        recordCircuitSuccess();
        notify('processed', { key, latencyMs });
        return;
      } catch (err) {
        if (!isRetryable(err) || attempt >= MAX_RETRIES) throw err;
        attempt++;
        metrics.retries++;
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  } catch (err) {
    metrics.failed++;
    const timedOut = err instanceof WatcherTimeoutError;
    if (timedOut) metrics.timedOut++;
    metrics.lastError = err instanceof Error ? err.message : String(err);
    recordCircuitFailure(Date.now());
    pushDeadLetter({
      key,
      agentId: ev.agentId,
      milestoneId: ev.milestoneId,
      error: metrics.lastError,
      attempts: attempt + 1,
      timedOut,
      failedAt: Date.now(),
    });
    console.error(`[milestone-watcher] failed ${key}:`, metrics.lastError);
    notify('failed', { key, error: metrics.lastError });
    throw err;
  } finally {
    inFlight.delete(key);
    inFlightStartedAt.delete(key);
  }
}

// Snapshot of terminal failures for QA triage. Returned oldest-first so
// operators reading the list see failure progression chronologically.
export function getDeadLetters(): ReadonlyArray<DeadLetterEntry> {
  if (deadLetters.length < DLQ_MAX_ENTRIES) return [...deadLetters];
  return [...deadLetters.slice(dlqCursor), ...deadLetters.slice(0, dlqCursor)];
}

export function clearDeadLetters(): void {
  deadLetters.length = 0;
  dlqCursor = 0;
}

export type DeadLetterSummary = {
  total: number;
  timedOut: number;
  byAgent: Record<string, number>;
  byMilestone: Record<string, number>;
  // Error message -> occurrence count. Normalized via `normalizeErrorMessage`
  // so transient values (ids, paths, timestamps) don't fragment the grouping.
  byError: Record<string, number>;
  firstFailedAt?: number;
  lastFailedAt?: number;
};

// Collapses ids, hex hashes, timestamps, and absolute paths so that otherwise
// identical errors cluster together in `summarizeDeadLetters`. Conservative:
// when in doubt we keep the token, since an over-zealous normalizer hides
// real signal. Extend this as new noisy patterns show up in triage.
function normalizeErrorMessage(msg: string): string {
  return msg
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\b\d{10,}\b/g, '<ts>')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"]+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Aggregated view of the DLQ for QA triage dashboards. Scans the buffer once
// and returns counts grouped along the axes operators actually ask about:
// "which agent is flaking?", "which error class dominates?", "is this a
// timeout storm?". Kept allocation-light so a SIGUSR2 diagnostic dump can
// include it without spiking memory.
export function summarizeDeadLetters(): DeadLetterSummary {
  const entries = getDeadLetters();
  const summary: DeadLetterSummary = {
    total: entries.length,
    timedOut: 0,
    byAgent: {},
    byMilestone: {},
    byError: {},
  };
  for (const entry of entries) {
    if (entry.timedOut) summary.timedOut++;
    summary.byAgent[entry.agentId] = (summary.byAgent[entry.agentId] ?? 0) + 1;
    summary.byMilestone[entry.milestoneId] =
      (summary.byMilestone[entry.milestoneId] ?? 0) + 1;
    const bucket = normalizeErrorMessage(entry.error);
    summary.byError[bucket] = (summary.byError[bucket] ?? 0) + 1;
    if (summary.firstFailedAt === undefined || entry.failedAt < summary.firstFailedAt) {
      summary.firstFailedAt = entry.failedAt;
    }
    if (summary.lastFailedAt === undefined || entry.failedAt > summary.lastFailedAt) {
      summary.lastFailedAt = entry.failedAt;
    }
  }
  return summary;
}

// Targeted DLQ lookup for QA replay flows: given an (agent, milestone) pair,
// return the matching terminal failure if one exists. Returns the most recent
// entry when the same key has failed more than once within the ring buffer.
export function findDeadLetter(
  agentId: string,
  milestoneId: string,
): DeadLetterEntry | undefined {
  const entries = getDeadLetters();
  let match: DeadLetterEntry | undefined;
  for (const entry of entries) {
    if (entry.agentId === agentId && entry.milestoneId === milestoneId) {
      if (!match || entry.failedAt >= match.failedAt) match = entry;
    }
  }
  return match;
}

// Removes DLQ entries matching (agentId, milestoneId) after QA has replayed
// them successfully elsewhere. Returns the number of entries removed so the
// caller can assert on exact hits. Compacts the buffer back to oldest-first
// insertion order so subsequent pushes resume growth-mode cleanly — the ring
// cursor is only meaningful when length == DLQ_MAX_ENTRIES, and removal drops
// us below that threshold.
export function removeDeadLetter(agentId: string, milestoneId: string): number {
  const ordered = getDeadLetters();
  const kept = ordered.filter(
    (e) => !(e.agentId === agentId && e.milestoneId === milestoneId),
  );
  const removed = ordered.length - kept.length;
  if (removed === 0) return 0;
  deadLetters.length = 0;
  for (const entry of kept) deadLetters.push(entry);
  dlqCursor = 0;
  return removed;
}

// Read-only view of the tunables for tests and operator tooling. Exposing
// these through a function (rather than re-exporting the consts) means the
// caller sees the live value even if a future change makes them mutable at
// runtime — e.g. via an admin endpoint — without having to chase call sites.
export type WatcherConfig = {
  seenTtlMs: number;
  seenMaxEntries: number;
  maxRetries: number;
  retryBackoffMs: number;
  handleTimeoutMs: number;
  staleAfterMs: number;
  unhealthyFailureRate: number;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
  dlqMaxEntries: number;
  latencyWindow: number;
};

export function getWatcherConfig(): Readonly<WatcherConfig> {
  return {
    seenTtlMs: SEEN_TTL_MS,
    seenMaxEntries: SEEN_MAX_ENTRIES,
    maxRetries: MAX_RETRIES,
    retryBackoffMs: RETRY_BACKOFF_MS,
    handleTimeoutMs: HANDLE_TIMEOUT_MS,
    staleAfterMs: STALE_AFTER_MS,
    unhealthyFailureRate: UNHEALTHY_FAILURE_RATE,
    circuitFailureThreshold: CIRCUIT_FAILURE_THRESHOLD,
    circuitCooldownMs: CIRCUIT_COOLDOWN_MS,
    dlqMaxEntries: DLQ_MAX_ENTRIES,
    latencyWindow: LATENCY_WINDOW,
  };
}

// One-shot diagnostic bundle: metrics + health + circuit + in-flight + DLQ.
// Emitted to logs on SIGUSR2 in production so SREs get a full snapshot
// without restarting the process. Keep this allocation-light — it runs in
// the hot path of an alert.
export type WatcherDiagnostics = {
  capturedAt: number;
  metrics: Readonly<WatcherMetrics>;
  health: HealthStatus;
  circuit: Readonly<typeof circuit>;
  inFlightKeys: string[];
  deadLetters: ReadonlyArray<DeadLetterEntry>;
};

export function getDiagnostics(now: number = Date.now()): WatcherDiagnostics {
  return {
    capturedAt: now,
    metrics: getMetrics(),
    health: getHealth(now),
    circuit: getCircuitState(),
    inFlightKeys: getInFlightKeys(),
    deadLetters: getDeadLetters(),
  };
}

// Awaits all currently in-flight dispatches before returning. Intended for
// graceful shutdown — call before process.exit so we don't abandon a partial
// PR creation. Polls because handleMilestone owns its own promise; we don't
// track them centrally to keep onAgentEvent's hot path allocation-free.
export async function drainInFlight(timeoutMs = 5 * HANDLE_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight.size > 0) {
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
  return true;
}

export function getCircuitState(): Readonly<typeof circuit> {
  return { ...circuit };
}

export function subscribe(listener: WatcherListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Snapshot of keys currently being dispatched. Handy for operator debugging
// when the watcher looks wedged: the keys reveal which (agent, milestone)
// pairs are stuck past HANDLE_TIMEOUT_MS.
export function getInFlightKeys(): string[] {
  return Array.from(inFlight);
}

export function getMetrics(): Readonly<WatcherMetrics> {
  return { ...metrics, skippedByReason: { ...metrics.skippedByReason } };
}

// Rolls up the raw counters into a go/no-go signal for dashboards and probes.
// `healthy` flips false when the failure rate crosses the threshold or when
// we've been silent past STALE_AFTER_MS despite having processed events
// before — both are symptoms worth paging on.
export function getHealth(now: number = Date.now()): HealthStatus {
  const total = metrics.processed + metrics.failed;
  const failureRate = total === 0 ? 0 : metrics.failed / total;
  const staleMs =
    metrics.lastProcessedAt === undefined ? undefined : now - metrics.lastProcessedAt;
  const isStale = staleMs !== undefined && staleMs > STALE_AFTER_MS;
  const healthy =
    failureRate < UNHEALTHY_FAILURE_RATE && !isStale && circuit.state !== 'open';
  const sorted = [...latencyWindow].sort((a, b) => a - b);
  return {
    healthy,
    inFlight: inFlight.size,
    seen: seen.size,
    failureRate,
    staleMs,
    circuit: circuit.state,
    p50LatencyMs: percentile(sorted, 50),
    p95LatencyMs: percentile(sorted, 95),
    dlqDepth: deadLetters.length,
  };
}

// 디자이너: GitAutomationPanel 헤더의 "저장됨 / 진행 중 / 동기화 실패" 인디케이터와
// AgentStatusPanel의 리더 실시간 배지가 같은 데이터 소스에서 유도되도록 하기 위한
// 상태 밴드. 워처가 어떤 상태인지 UI가 세 갈래로만 분기하도록 축약한다.
// - idle:    설정은 저장돼 있지만 지금은 디스패치 중이 아님 (초록 배지)
// - running: inFlight 1건 이상 — 커밋/푸시/PR이 실시간으로 진행 중 (노랑 글로우)
// - failed:  회로가 열렸거나 최근 처리 후 실패가 누적됨 (빨강 배지 + 재시도 안내)
// - stale:   마지막 처리 후 STALE_AFTER_MS를 초과 — 워커가 살아 있는지 확인 필요
export type AutomationSyncState = 'idle' | 'running' | 'failed' | 'stale';

// 디자이너: AgentStatusPanel에서 각 에이전트 카드 우상단에 띄울 실시간 배지의
// 원재료. 워처가 (agentId:milestoneId) 키로만 관리하던 in-flight 엔트리를 UI가
// 곧바로 그릴 수 있는 형태로 풀어준다. `elapsedMs`를 함께 실어 "X초째 진행 중"
// 카운터를 컴포넌트 쪽에서 setInterval 없이도 스냅샷 폴링만으로 갱신할 수 있게 한다.
export type AgentAutomationBadge = {
  agentId: string;
  milestoneId: string;
  key: string;
  startedAt: number;
  elapsedMs: number;
};

// 디자이너: 패널 두 곳(GitAutomationPanel·AgentStatusPanel)이 서로 다른 엔드포인트를
// 찌르지 않도록, UI가 필요한 모든 신호를 한 번에 묶은 단일 스냅샷을 제공한다.
// 프런트에서는 이 객체 하나만 폴링해 두 패널을 동시에 갱신할 수 있다.
export type UiAutomationSnapshot = {
  capturedAt: number;
  syncState: AutomationSyncState;
  activeBadges: AgentAutomationBadge[];
  // 가장 오래 in-flight 상태인 엣지의 경과 시간(ms). 배지 톤(경고/일반)을 고르는 데 쓴다.
  longestElapsedMs: number;
  lastProcessedAt?: number;
  lastError?: string;
  circuit: CircuitState;
  healthy: boolean;
};

// 파생: in-flight 맵을 UI 배지 배열로 변환. 시작 시각 오름차순으로 정렬해
// "가장 먼저 시작한 자동화"가 맨 위에 오도록 한다 — 리더가 막힌 작업을 먼저 보게 된다.
export function getAgentAutomationBadges(now: number = Date.now()): AgentAutomationBadge[] {
  const badges: AgentAutomationBadge[] = [];
  for (const [key, startedAt] of inFlightStartedAt) {
    const sep = key.indexOf(':');
    // 키 파싱 실패 시에도 배지를 완전히 숨기기보다 원문 키를 노출해 UI가 "알 수 없는
    // 작업"으로라도 그릴 수 있게 한다. 디버깅 신호를 잃지 않는 쪽이 낫다.
    const agentId = sep >= 0 ? key.slice(0, sep) : key;
    const milestoneId = sep >= 0 ? key.slice(sep + 1) : '';
    badges.push({
      agentId,
      milestoneId,
      key,
      startedAt,
      elapsedMs: Math.max(0, now - startedAt),
    });
  }
  badges.sort((a, b) => a.startedAt - b.startedAt);
  return badges;
}

// 워처의 내부 상태를 UI가 이해하는 세 갈래(+stale)로 접는다. 우선순위는
// failed → running → stale → idle. 실패 신호가 진행 신호보다 앞서는 이유는,
// "지금 돌고 있지만 직전 실행이 실패했다"를 사용자에게 숨기는 것이 더 큰 혼란이기 때문.
export function getUiAutomationSnapshot(now: number = Date.now()): UiAutomationSnapshot {
  const health = getHealth(now);
  const badges = getAgentAutomationBadges(now);
  const longestElapsedMs = badges.reduce(
    (max, b) => (b.elapsedMs > max ? b.elapsedMs : max),
    0,
  );

  let syncState: AutomationSyncState;
  if (circuit.state === 'open' || (metrics.failed > 0 && !health.healthy)) {
    syncState = 'failed';
  } else if (badges.length > 0) {
    syncState = 'running';
  } else if (health.staleMs !== undefined && health.staleMs > STALE_AFTER_MS) {
    syncState = 'stale';
  } else {
    syncState = 'idle';
  }

  return {
    capturedAt: now,
    syncState,
    activeBadges: badges,
    longestElapsedMs,
    lastProcessedAt: metrics.lastProcessedAt,
    lastError: metrics.lastError,
    circuit: circuit.state,
    healthy: health.healthy,
  };
}

export function resetWatcherState(): void {
  seen.clear();
  inFlight.clear();
  inFlightStartedAt.clear();
  listeners.clear();
  metrics.received = 0;
  metrics.skipped = 0;
  metrics.processed = 0;
  metrics.failed = 0;
  metrics.retries = 0;
  metrics.timedOut = 0;
  metrics.maxLatencyMs = 0;
  metrics.skippedByReason = emptySkipCounters();
  delete metrics.lastError;
  delete metrics.lastProcessedAt;
  delete metrics.lastLatencyMs;
  latencyWindow.length = 0;
  latencyCursor = 0;
  circuit.state = 'closed';
  circuit.consecutiveFailures = 0;
  circuit.openedAt = 0;
  deadLetters.length = 0;
  dlqCursor = 0;
}

// QA self-check: verifies that the watcher's internal counters and data
// structures are mutually consistent. Tests call this at the end of each
// scenario; production callers can invoke it from a health probe. Throws on
// violation so the caller sees a stack trace — silent drift is what we want
// to catch. The invariants here are exactly the ones that have bitten us
// before, so additions should be driven by bug postmortems, not speculation.
export function assertWatcherInvariants(): void {
  const violations: string[] = [];

  if (metrics.received < 0) violations.push(`received is negative: ${metrics.received}`);
  const accounted = metrics.processed + metrics.failed + metrics.skipped;
  if (accounted > metrics.received) {
    // `received` increments before branching; in-flight events are counted
    // but not yet resolved, so accounted can legitimately be *less* than
    // received. It must never *exceed* it — that would mean we
    // double-counted a disposition.
    violations.push(
      `processed+failed+skipped (${accounted}) exceeds received (${metrics.received})`,
    );
  }

  const skipTotal = Object.values(metrics.skippedByReason).reduce((a, b) => a + b, 0);
  if (skipTotal !== metrics.skipped) {
    violations.push(`skippedByReason sum (${skipTotal}) != metrics.skipped (${metrics.skipped})`);
  }

  if (seen.size > SEEN_MAX_ENTRIES) {
    violations.push(`seen size ${seen.size} exceeds cap ${SEEN_MAX_ENTRIES}`);
  }

  if (circuit.consecutiveFailures < 0) {
    violations.push(`circuit.consecutiveFailures negative: ${circuit.consecutiveFailures}`);
  }
  if (circuit.state === 'open' && circuit.openedAt === 0) {
    violations.push('circuit is open but openedAt is unset');
  }

  if (latencyWindow.length > LATENCY_WINDOW) {
    violations.push(`latencyWindow length ${latencyWindow.length} exceeds cap ${LATENCY_WINDOW}`);
  }
  for (const ms of latencyWindow) {
    if (ms < 0 || !Number.isFinite(ms)) {
      violations.push(`latencyWindow contains invalid sample: ${ms}`);
      break;
    }
  }

  if (deadLetters.length > DLQ_MAX_ENTRIES) {
    violations.push(
      `deadLetters length ${deadLetters.length} exceeds cap ${DLQ_MAX_ENTRIES}`,
    );
  }
  if (deadLetters.length > metrics.failed) {
    // DLQ entries are pushed only inside the failure branch, so the buffer
    // can never hold more rows than we've observed failures. If this ever
    // trips we've double-pushed or clobbered a counter.
    violations.push(
      `deadLetters (${deadLetters.length}) exceeds metrics.failed (${metrics.failed})`,
    );
  }
  if (dlqCursor < 0 || dlqCursor >= DLQ_MAX_ENTRIES) {
    violations.push(`dlqCursor ${dlqCursor} out of range [0, ${DLQ_MAX_ENTRIES})`);
  }
  if (latencyCursor < 0 || latencyCursor >= LATENCY_WINDOW) {
    violations.push(`latencyCursor ${latencyCursor} out of range [0, ${LATENCY_WINDOW})`);
  }
  // Latency samples are only recorded on successful dispatch, so an empty
  // `processed` counter with a non-empty window means we leaked samples from
  // a prior test run that forgot to reset — a class of test-flake that has
  // bitten us before.
  if (metrics.processed === 0 && latencyWindow.length > 0) {
    violations.push(
      `latencyWindow has ${latencyWindow.length} samples but processed is 0`,
    );
  }
  if (metrics.failed === 0 && deadLetters.length > 0) {
    violations.push(
      `deadLetters has ${deadLetters.length} entries but failed is 0`,
    );
  }
  for (const entry of deadLetters) {
    // Each DLQ row is a snapshot, not a live reference. Attempts must be
    // positive and bounded by the configured retry cap plus the initial try.
    if (entry.attempts < 1 || entry.attempts > MAX_RETRIES + 1) {
      violations.push(
        `deadLetter ${entry.key} has attempts=${entry.attempts} outside [1, ${MAX_RETRIES + 1}]`,
      );
      break;
    }
    if (entry.key !== `${entry.agentId}:${entry.milestoneId}`) {
      violations.push(
        `deadLetter key ${entry.key} does not match agent:milestone composition`,
      );
      break;
    }
    if (entry.failedAt <= 0 || !Number.isFinite(entry.failedAt)) {
      violations.push(`deadLetter ${entry.key} has invalid failedAt ${entry.failedAt}`);
      break;
    }
  }

  // in-flight keys must never also be in `seen` — we only mark seen after a
  // successful dispatch, and removal from in-flight happens in the same
  // microtask. An overlap points at a race in onAgentEvent's finally block.
  for (const key of inFlight) {
    if (seen.has(key)) {
      violations.push(`key ${key} appears in both inFlight and seen`);
      break;
    }
  }
  // The UI-facing in-flight start-time map must stay byte-for-byte aligned
  // with `inFlight`. A diverging size means either a missed cleanup in the
  // finally block or a stray direct mutation — both would show up as ghost
  // badges that never disappear in AgentStatusPanel.
  if (inFlight.size !== inFlightStartedAt.size) {
    violations.push(
      `inFlight (${inFlight.size}) and inFlightStartedAt (${inFlightStartedAt.size}) sizes diverge`,
    );
  }
  for (const key of inFlight) {
    if (!inFlightStartedAt.has(key)) {
      violations.push(`inFlight key ${key} missing startedAt entry`);
      break;
    }
  }
  for (const [key, ts] of inFlightStartedAt) {
    if (!inFlight.has(key)) {
      violations.push(`inFlightStartedAt key ${key} has no matching inFlight entry`);
      break;
    }
    if (ts <= 0 || !Number.isFinite(ts)) {
      violations.push(`inFlightStartedAt ${key} has invalid timestamp ${ts}`);
      break;
    }
  }
  if (metrics.timedOut > metrics.failed) {
    violations.push(
      `timedOut (${metrics.timedOut}) exceeds failed (${metrics.failed})`,
    );
  }
  if (metrics.received > 0 && metrics.retries > metrics.received * (MAX_RETRIES + 1)) {
    // Each event can retry at most MAX_RETRIES times. If the retry counter
    // exceeds that upper bound, something is double-counting or looping.
    violations.push(
      `retries (${metrics.retries}) exceeds theoretical max for received (${metrics.received})`,
    );
  }

  if (violations.length > 0) {
    throw new Error(`[milestone-watcher] invariant violations:\n  - ${violations.join('\n  - ')}`);
  }
}

// Sanity-check module-level config at import time. These knobs have foot-guns
// (a zero timeout would make every dispatch fail instantly; a negative TTL
// would never dedupe) that are easier to catch here than to debug in prod.
(function assertConfigSane(): void {
  const bad: string[] = [];
  if (SEEN_TTL_MS <= 0) bad.push(`SEEN_TTL_MS must be > 0, got ${SEEN_TTL_MS}`);
  if (SEEN_MAX_ENTRIES <= 0) bad.push(`SEEN_MAX_ENTRIES must be > 0, got ${SEEN_MAX_ENTRIES}`);
  if (MAX_RETRIES < 0) bad.push(`MAX_RETRIES must be >= 0, got ${MAX_RETRIES}`);
  if (RETRY_BACKOFF_MS < 0) bad.push(`RETRY_BACKOFF_MS must be >= 0, got ${RETRY_BACKOFF_MS}`);
  if (HANDLE_TIMEOUT_MS <= 0) bad.push(`HANDLE_TIMEOUT_MS must be > 0, got ${HANDLE_TIMEOUT_MS}`);
  if (STALE_AFTER_MS <= 0) bad.push(`STALE_AFTER_MS must be > 0, got ${STALE_AFTER_MS}`);
  if (UNHEALTHY_FAILURE_RATE <= 0 || UNHEALTHY_FAILURE_RATE > 1) {
    bad.push(`UNHEALTHY_FAILURE_RATE must be in (0, 1], got ${UNHEALTHY_FAILURE_RATE}`);
  }
  if (CIRCUIT_FAILURE_THRESHOLD <= 0) {
    bad.push(`CIRCUIT_FAILURE_THRESHOLD must be > 0, got ${CIRCUIT_FAILURE_THRESHOLD}`);
  }
  if (CIRCUIT_COOLDOWN_MS <= 0) {
    bad.push(`CIRCUIT_COOLDOWN_MS must be > 0, got ${CIRCUIT_COOLDOWN_MS}`);
  }
  if (DLQ_MAX_ENTRIES <= 0) {
    bad.push(`DLQ_MAX_ENTRIES must be > 0, got ${DLQ_MAX_ENTRIES}`);
  }
  if (bad.length > 0) {
    throw new Error(`[milestone-watcher] invalid config:\n  - ${bad.join('\n  - ')}`);
  }
})();
