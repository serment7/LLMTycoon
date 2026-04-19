// tests/helpers/claudeMock.ts
//
// QA 회귀 공통 헬퍼(지시 #5f4902b0). 모의 Claude 응답·구독 세션 타이머를
// 결정적으로 재현하기 위한 작은 도구 모음.
//
// 배경: 본 저장소는 vitest 를 사용하지 않는다(`package.json` devDeps 미포함).
// 따라서 `vi.useFakeTimers` 를 직접 쓸 수는 없다. 대신 동등한 효과를 내는
// **수동 시계 + fetch 스텁** 조합을 제공해, 기존 `node:test` 러너에서 그대로
// 동작하도록 한다. 장래에 vitest 가 도입되면 본 헬퍼의 공개 시그니처(`installFakeTimers`
// · `installClaudeFetchMock`)를 유지한 채 내부 구현만 `vi.useFakeTimers` 로
// 교체하면 된다.
//
// 제공하는 API:
//   installFakeTimers({ now })
//     - Date.now / setTimeout / clearTimeout / setInterval / clearInterval 을
//       스파이하고 `advance(ms)` 로 수동 진행 가능.
//     - `uninstall()` 으로 원복.
//   installClaudeFetchMock(routes)
//     - 경로 → 응답 팩토리 매핑. match 한 경로에 맞는 응답을 async 로 돌려 준다.
//     - 미매치 경로는 `new Response('{}', { status: 404 })` 기본 폴백.
//   mockSessionStatus(scenario)
//     - 'active' | 'warning' | 'exhausted' | 'rate-limited' | 'reset'
//       5 시나리오별 응답 프리셋.
//   advanceUntilIdle(timers)
//     - 대기 중 타이머 모두 flush(경계 시간 포함). 무한 루프 방지 상한 100회.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FakeTimers {
  now(): number;
  advance(ms: number): void;
  nextTickId(): number;
  pending(): number;
  uninstall(): void;
}

interface ScheduledTimer {
  id: number;
  due: number;
  fn: (...args: unknown[]) => void;
  args: unknown[];
  kind: 'timeout' | 'interval';
  periodMs: number;
}

export function installFakeTimers(opts?: { now?: number }): FakeTimers {
  let clock = opts?.now ?? 0;
  let nextId = 1;
  const schedule: ScheduledTimer[] = [];

  const g = globalThis as any;
  const origDateNow = Date.now;
  const origSetTimeout = g.setTimeout;
  const origClearTimeout = g.clearTimeout;
  const origSetInterval = g.setInterval;
  const origClearInterval = g.clearInterval;

  Date.now = () => clock;
  g.setTimeout = ((fn: any, ms: number, ...args: unknown[]) => {
    const id = nextId++;
    schedule.push({ id, due: clock + (ms ?? 0), fn, args, kind: 'timeout', periodMs: 0 });
    return id as any;
  }) as typeof setTimeout;
  g.clearTimeout = ((id: any) => {
    const idx = schedule.findIndex(s => s.id === id);
    if (idx >= 0) schedule.splice(idx, 1);
  }) as typeof clearTimeout;
  g.setInterval = ((fn: any, ms: number, ...args: unknown[]) => {
    const id = nextId++;
    schedule.push({ id, due: clock + (ms ?? 0), fn, args, kind: 'interval', periodMs: ms ?? 0 });
    return id as any;
  }) as typeof setInterval;
  g.clearInterval = ((id: any) => {
    const idx = schedule.findIndex(s => s.id === id);
    if (idx >= 0) schedule.splice(idx, 1);
  }) as typeof clearInterval;

  return {
    now: () => clock,
    advance(ms: number): void {
      const target = clock + ms;
      let safety = 10_000;
      while (safety-- > 0) {
        // due <= target 중 가장 빠른 것 한 개만 뽑는다. 동일 due 일 때는 삽입
        // 순서(FIFO) 를 지키기 위해 findIndex + 비교 후 update 방식으로 순회.
        let pickIdx = -1;
        for (let i = 0; i < schedule.length; i++) {
          const s = schedule[i];
          if (s.due > target) continue;
          if (pickIdx < 0 || s.due < schedule[pickIdx].due) pickIdx = i;
        }
        if (pickIdx < 0) break;
        const due = schedule[pickIdx];
        clock = due.due;
        // 인터벌은 다음 주기로 재스케줄.
        if (due.kind === 'interval') {
          due.due = clock + due.periodMs;
        } else {
          schedule.splice(pickIdx, 1);
        }
        try { due.fn(...(due.args ?? [])); } catch { /* 테스트에서 추적 */ }
      }
      clock = target;
    },
    nextTickId(): number { return nextId; },
    pending(): number { return schedule.length; },
    uninstall(): void {
      Date.now = origDateNow;
      g.setTimeout = origSetTimeout;
      g.clearTimeout = origClearTimeout;
      g.setInterval = origSetInterval;
      g.clearInterval = origClearInterval;
      schedule.length = 0;
    },
  };
}

// ─── Claude fetch 모의 응답 ────────────────────────────────────────────────

export type MockFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface MockRoute {
  method?: string;
  match: RegExp | ((url: string) => boolean);
  respond: (url: string, init?: RequestInit) => Promise<Response> | Response;
}

export interface FetchMockInstance {
  calls: Array<{ url: string; init?: RequestInit }>;
  fetcher: MockFetcher;
}

export function installClaudeFetchMock(routes: MockRoute[]): FetchMockInstance {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: MockFetcher = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    calls.push({ url, init });
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const r of routes) {
      if (r.method && r.method.toUpperCase() !== method) continue;
      const ok = typeof r.match === 'function' ? r.match(url) : r.match.test(url);
      if (ok) return await r.respond(url, init);
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetcher };
}

// ─── 세션 상태 시나리오 프리셋 ────────────────────────────────────────────

export type SessionScenario = 'active' | 'warning' | 'exhausted' | 'rate-limited' | 'reset';

export function mockSessionStatus(scenario: SessionScenario): Response {
  const base = {
    status: scenario === 'rate-limited' ? 'warning' : scenario,
    reason: scenarioReason(scenario),
    at: new Date().toISOString(),
  };
  if (scenario === 'exhausted') {
    return new Response(
      JSON.stringify({ ...base, status: 'exhausted' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }
  if (scenario === 'rate-limited') {
    return new Response(
      JSON.stringify({ ...base, status: 'warning', category: 'rate_limited' }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '30' } },
    );
  }
  return new Response(JSON.stringify(base), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function scenarioReason(scenario: SessionScenario): string | undefined {
  switch (scenario) {
    case 'warning':      return '세션 80% 임계 도달';
    case 'exhausted':    return '구독 세션 한도 초과';
    case 'rate-limited': return '요청이 잠시 제한됨';
    case 'reset':        return '세션 창 갱신';
    default:             return undefined;
  }
}

// ─── 대기 중 타이머 모두 flush ────────────────────────────────────────────

export function advanceUntilIdle(timers: FakeTimers, bigStep = 60 * 60 * 1000): void {
  let safety = 100;
  while (timers.pending() > 0 && safety-- > 0) {
    timers.advance(bigStep);
  }
}
