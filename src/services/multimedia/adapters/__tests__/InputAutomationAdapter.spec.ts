// Run with: npx tsx --test src/services/multimedia/adapters/__tests__/InputAutomationAdapter.spec.ts
//
// 지시 #75b61e74 · InputAutomationAdapter 실구현 단위 테스트.
//
// OS/UI/이벤트 소스 모두 DI 포트로 분리되어 있어 테스트는 포트 stub 만으로 전 경로를
// 결정론적으로 검증한다. 실제 nut.js/robotjs 는 설치조차 하지 않는다.
//
// 테스트 축
//   A. 기본 비활성(enabled=false) — 권한/레코딩/리플레이 모두 feature-disabled 로 수렴
//   B. requestPermission — 허용/거부/타임아웃/권한 상한 초과/화이트리스트 미매치
//   C. 세션 만료 — TTL 경과 · 권한 상향 요구
//   D. 화이트리스트 순수 함수(matchHost, matchPath, checkWhitelist)
//   E. recordSession — AsyncIterable 계약 + 민감 필드 마스킹 + abort
//   F. replay — 정상 · 포커스 실패(BLOCKED_TARGET) · 단계 실패 스크린샷 수집
//   G. 비상 중단 — 훅 트리거 시 EMERGENCY_STOP + 타임라인 이벤트
//   H. 리플레이 취소 — AbortSignal 로 중간 중단
//   I. invoke 계약 — MediaAdapter 호환 + rationale 공란 거절
//   J. 순수 helper — DPR 스케일 · modifier 매핑
//   K. 레지스트리 등록 경로 — createDefaultRegistry 가 실구현 우선

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MediaAdapterError,
  createDefaultRegistry,
  DEFAULT_ADAPTER_CONFIG,
} from '../../index.ts';
import {
  InputAutomationAdapter,
  createRealInputAutomationAdapter,
  matchHost,
  matchPath,
  maskSensitiveText,
  scaleEventForDpr,
  normalizeModifiers,
  INPUT_AUTOMATION_ADAPTER_ID,
  INPUT_AUTOMATION_ALIAS,
  type ConsentPort,
  type HotkeyPort,
  type InputSourcePort,
  type OsDriver,
  type InputEvent,
  type WhitelistRule,
  type TimelineEvent,
} from '../InputAutomationAdapter.ts';

// ────────────────────────────────────────────────────────────────────────────
// 공용 stub 빌더
// ────────────────────────────────────────────────────────────────────────────

function grantingConsent(level: 'display' | 'interact' | 'system' = 'interact', ttlMs = 60_000): ConsentPort {
  return {
    async request() {
      return { granted: true, expiresAtMs: Date.now() + ttlMs };
    },
  };
}
function denyingConsent(reason?: 'user-cancelled' | 'user-consent-timeout' | 'cap-exceeded' | 'whitelist-miss'): ConsentPort {
  return {
    async request() { return { granted: false, expiresAtMs: 0, reason }; },
  };
}

function silentOsDriver(overrides: Partial<OsDriver> = {}): OsDriver {
  return {
    platform: 'test',
    devicePixelRatio: 1,
    async focus() { return true; },
    async dispatch() { /* noop */ },
    async captureScreenshot() { return new Uint8Array([0xde, 0xad]); },
    async captureDom() { return '<html></html>'; },
    ...overrides,
  };
}

function manualHotkey(): { port: HotkeyPort; fire: () => void; unregistered: boolean } {
  const state: { trigger: (() => void) | null; unregistered: boolean } = { trigger: null, unregistered: false };
  const port: HotkeyPort = {
    register({ trigger }) {
      state.trigger = trigger;
      return () => { state.unregistered = true; };
    },
  };
  return {
    port,
    fire() { state.trigger?.(); },
    get unregistered() { return state.unregistered; },
  };
}

const DEFAULT_TARGET = { url: 'https://app.local.test/login' };
const BASIC_WHITELIST: readonly WhitelistRule[] = [
  { host: 'app.local.test', pathPattern: '/*', maxPermission: 'interact', active: true },
];

function makeAdapter(opts: Partial<Parameters<typeof createRealInputAutomationAdapter>[0]> extends never ? never : ConstructorParameters<typeof InputAutomationAdapter>[1] & { config?: Partial<typeof DEFAULT_ADAPTER_CONFIG> } = {}): InputAutomationAdapter {
  const { config: cfgOverride, ...adapterOpts } = opts as { config?: Partial<typeof DEFAULT_ADAPTER_CONFIG> } & ConstructorParameters<typeof InputAutomationAdapter>[1];
  const config = { ...DEFAULT_ADAPTER_CONFIG, inputAutomationMaxPermission: 'interact' as const, ...(cfgOverride ?? {}) };
  return new InputAutomationAdapter(config, {
    enabled: true,
    consent: grantingConsent(),
    osDriver: silentOsDriver(),
    whitelist: BASIC_WHITELIST,
    ...adapterOpts,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// A. 기본 비활성 — 보안 기본값
// ────────────────────────────────────────────────────────────────────────────

test('A1. 기본 비활성 — requestPermission 은 feature-disabled reason 으로 거부', async () => {
  const adapter = new InputAutomationAdapter(DEFAULT_ADAPTER_CONFIG);
  const res = await adapter.requestPermission({
    level: 'display', rationale: '읽기', target: DEFAULT_TARGET, totalSteps: 1,
  });
  assert.equal(res.granted, false);
  assert.equal(res.reason, 'feature-disabled');
  assert.equal(res.expiresAt, 0);
});

test('A2. 기본 비활성 — replay 는 INPUT_PERMISSION_DENIED(feature-disabled)', async () => {
  const adapter = new InputAutomationAdapter(DEFAULT_ADAPTER_CONFIG);
  await assert.rejects(
    adapter.replay([], { target: DEFAULT_TARGET, level: 'display' }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { inputCode?: string; reason?: string } | undefined;
      return d?.inputCode === 'INPUT_PERMISSION_DENIED' && d?.reason === 'feature-disabled';
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// B. requestPermission
// ────────────────────────────────────────────────────────────────────────────

test('B1. requestPermission — 동의 허용 시 세션 생성 + expiresAt 반환', async () => {
  const adapter = makeAdapter();
  const res = await adapter.requestPermission({
    level: 'interact', rationale: '회귀', target: DEFAULT_TARGET, totalSteps: 3,
  });
  assert.equal(res.granted, true);
  assert.ok(res.expiresAt > Date.now());
  const session = adapter.getActiveSession();
  assert.ok(session);
  assert.equal(session?.level, 'interact');
});

test('B2. requestPermission — 사용자 거절', async () => {
  const adapter = makeAdapter({ consent: denyingConsent('user-cancelled') });
  const res = await adapter.requestPermission({
    level: 'interact', rationale: '회귀', target: DEFAULT_TARGET, totalSteps: 3,
  });
  assert.equal(res.granted, false);
  assert.equal(res.reason, 'user-cancelled');
  assert.equal(adapter.getActiveSession(), null);
});

test('B3. requestPermission — 권한 상한(interact) 초과(system) 즉시 cap-exceeded', async () => {
  const adapter = makeAdapter({ consent: grantingConsent('interact') });
  const res = await adapter.requestPermission({
    level: 'system', rationale: 'OS', target: DEFAULT_TARGET, totalSteps: 1,
  });
  assert.equal(res.granted, false);
  assert.equal(res.reason, 'cap-exceeded');
});

test('B4. requestPermission — 화이트리스트 미매치면 모달 전에 whitelist-miss', async () => {
  const adapter = makeAdapter({ whitelist: [] });
  const res = await adapter.requestPermission({
    level: 'interact', rationale: '회귀', target: DEFAULT_TARGET, totalSteps: 1,
  });
  assert.equal(res.granted, false);
  assert.equal(res.reason, 'whitelist-miss');
});

test('B5. requestPermission — ConsentPort 미주입이면 INPUT_PERMISSION_DENIED 예외', async () => {
  const adapter = new InputAutomationAdapter(
    { ...DEFAULT_ADAPTER_CONFIG, inputAutomationMaxPermission: 'interact' as const },
    { enabled: true, whitelist: BASIC_WHITELIST, osDriver: silentOsDriver() },
  );
  await assert.rejects(
    adapter.requestPermission({ level: 'display', rationale: 'x', target: DEFAULT_TARGET, totalSteps: 1 }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { inputCode?: string } | undefined;
      return d?.inputCode === 'INPUT_PERMISSION_DENIED';
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// C. 세션 만료
// ────────────────────────────────────────────────────────────────────────────

test('C1. 세션 TTL 경과 시 getActiveSession null · invoke 는 INPUT_SESSION_EXPIRED', async () => {
  let current = 1_000_000;
  const adapter = new InputAutomationAdapter(
    { ...DEFAULT_ADAPTER_CONFIG, inputAutomationMaxPermission: 'interact' as const },
    {
      enabled: true,
      consent: {
        async request() { return { granted: true, expiresAtMs: current + 1000 }; },
      },
      osDriver: silentOsDriver(),
      whitelist: BASIC_WHITELIST,
      now: () => current,
    },
  );
  await adapter.requestPermission({ level: 'interact', rationale: 'x', target: DEFAULT_TARGET, totalSteps: 1 });
  assert.ok(adapter.getActiveSession());
  current += 2000; // 시간 경과
  assert.equal(adapter.getActiveSession(), null);
  await assert.rejects(
    adapter.invoke({
      input: {
        steps: [{ kind: 'click', selector: '#x' }],
        requestedPermission: 'interact',
        humanRationale: 'x',
      },
    }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { inputCode?: string } | undefined;
      return d?.inputCode === 'INPUT_SESSION_EXPIRED';
    },
  );
});

test('C2. 세션 권한보다 높은 레벨 요청은 INPUT_SESSION_EXPIRED(permission-upgrade-required)', async () => {
  const adapter = makeAdapter({ consent: grantingConsent('display') });
  await adapter.requestPermission({ level: 'display', rationale: 'x', target: DEFAULT_TARGET, totalSteps: 1 });
  await assert.rejects(
    adapter.invoke({
      input: {
        steps: [{ kind: 'click', selector: '#x' }],
        requestedPermission: 'interact',
        humanRationale: 'x',
      },
    }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { inputCode?: string; reason?: string } | undefined;
      return d?.inputCode === 'INPUT_SESSION_EXPIRED' && d?.reason === 'permission-upgrade-required';
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// D. 화이트리스트 순수 함수
// ────────────────────────────────────────────────────────────────────────────

test('D1. matchHost — 정확 / 와일드카드(서브도메인)', () => {
  assert.equal(matchHost('app.local.test', 'app.local.test'), true);
  assert.equal(matchHost('staging.example.com', '*.example.com'), true);
  assert.equal(matchHost('example.com', '*.example.com'), true);
  assert.equal(matchHost('other.com', '*.example.com'), false);
  assert.equal(matchHost('anything.io', '*'), true);
});

test('D2. matchPath — glob + regex', () => {
  assert.equal(matchPath('/login', '/*'), true);
  assert.equal(matchPath('/admin/users', '/admin/*'), true);
  assert.equal(matchPath('/admin/users', '/public/*'), false);
  assert.equal(matchPath('/anything', '*'), true);
  assert.equal(matchPath('/api/v2/users', '/re:^/api/v\\d+/users$'), true);
  assert.equal(matchPath('/api/v/users', '/re:^/api/v\\d+/users$'), false);
});

test('D3. checkWhitelist — 빈 목록은 전부 거절(S-05)', () => {
  const adapter = makeAdapter({ whitelist: [] });
  const r = adapter.checkWhitelist(DEFAULT_TARGET, 'display');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty-whitelist');
});

test('D4. checkWhitelist — 규칙의 maxPermission 을 넘는 레벨 거절', () => {
  const adapter = makeAdapter({
    whitelist: [
      { host: 'app.local.test', pathPattern: '/*', maxPermission: 'display', active: true },
    ],
  });
  assert.equal(adapter.checkWhitelist(DEFAULT_TARGET, 'display').ok, true);
  const r = adapter.checkWhitelist(DEFAULT_TARGET, 'interact');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'level-exceeds-rule');
});

test('D5. checkWhitelist — 비활성 규칙은 매치 대상에서 제외', () => {
  const adapter = makeAdapter({
    whitelist: [
      { host: 'app.local.test', pathPattern: '/*', maxPermission: 'interact', active: false },
    ],
  });
  const r = adapter.checkWhitelist(DEFAULT_TARGET, 'display');
  assert.equal(r.ok, false);
});

// ────────────────────────────────────────────────────────────────────────────
// E. recordSession
// ────────────────────────────────────────────────────────────────────────────

test('E1. recordSession — AsyncIterable 이 이벤트를 순서대로 방출, 민감 텍스트는 마스킹', async () => {
  const events: InputEvent[] = [
    { kind: 'click', t: 0, selector: '#email' },
    { kind: 'type', t: 100, selector: '#password', text: 'secret', sensitive: true },
  ];
  const source: InputSourcePort = {
    async *subscribe() {
      for (const e of events) yield e;
    },
  };
  const adapter = makeAdapter({ inputSource: source });
  await adapter.requestPermission({ level: 'interact', rationale: 'rec', target: DEFAULT_TARGET, totalSteps: 2 });
  const ctrl = new AbortController();
  const collected: InputEvent[] = [];
  for await (const e of adapter.recordSession({ target: DEFAULT_TARGET, level: 'interact', signal: ctrl.signal })) {
    collected.push(e);
  }
  assert.equal(collected.length, 2);
  assert.equal(collected[0].kind, 'click');
  assert.equal(collected[1].text, '••••••');
  assert.equal(collected[1].sensitive, true);
});

test('E2. recordSession — 화이트리스트 밖은 INPUT_BLOCKED_TARGET', async () => {
  // source port 는 필수 — 있어야 whitelist 검사까지 도달한다.
  const source: InputSourcePort = { async *subscribe() { /* 즉시 종료 */ } };
  const adapter = makeAdapter({ whitelist: [], inputSource: source });
  const ctrl = new AbortController();
  const iter = adapter.recordSession({ target: DEFAULT_TARGET, level: 'interact', signal: ctrl.signal });
  await assert.rejects(
    (async () => { for await (const _ of iter) { /* drain */ } })(),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { inputCode?: string } | undefined;
      return d?.inputCode === 'INPUT_BLOCKED_TARGET';
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// F. replay — 정상 · 포커스 실패 · 단계 실패
// ────────────────────────────────────────────────────────────────────────────

test('F1. replay — 정상 경로: 모든 이벤트 실행 + onProgress 1.0 도달', async () => {
  const dispatched: InputEvent[] = [];
  const adapter = makeAdapter({
    osDriver: silentOsDriver({
      async dispatch(e) { dispatched.push(e); },
    }),
  });
  await adapter.requestPermission({ level: 'interact', rationale: 'x', target: DEFAULT_TARGET, totalSteps: 2 });
  const progress: number[] = [];
  const res = await adapter.replay(
    [
      { kind: 'click', t: 0, selector: '#a' },
      { kind: 'keydown', t: 10, key: 'Enter' },
    ],
    { target: DEFAULT_TARGET, level: 'interact', onProgress: (r) => progress.push(r) },
  );
  assert.equal(res.executedSteps, 2);
  assert.equal(res.failedSteps, 0);
  assert.equal(dispatched.length, 2);
  assert.equal(progress[progress.length - 1], 1);
});

test('F2. replay — 포커스 실패(false 반환) 는 INPUT_BLOCKED_TARGET + target-not-focusable', async () => {
  const adapter = makeAdapter({
    osDriver: silentOsDriver({ async focus() { return false; } }),
  });
  await adapter.requestPermission({ level: 'interact', rationale: 'x', target: DEFAULT_TARGET, totalSteps: 1 });
  await assert.rejects(
    adapter.replay([{ kind: 'click', t: 0, selector: '#a' }], {
      target: DEFAULT_TARGET, level: 'interact',
    }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { inputCode?: string; reason?: string } | undefined;
      return d?.inputCode === 'INPUT_BLOCKED_TARGET' && d?.reason === 'target-not-focusable';
    },
  );
});

test('F3. replay — 단계 실패 시 auditLog + artifacts 수집 + INPUT_BLOCKED_TARGET(step-failed)', async () => {
  let captures = 0;
  const adapter = makeAdapter({
    osDriver: silentOsDriver({
      async dispatch(e) {
        if (e.selector === '#bad') throw new Error('selector missing');
      },
      async captureScreenshot() { captures += 1; return new Uint8Array([1]); },
    }),
  });
  await adapter.requestPermission({ level: 'interact', rationale: 'x', target: DEFAULT_TARGET, totalSteps: 2 });
  await assert.rejects(
    adapter.replay(
      [
        { kind: 'click', t: 0, selector: '#a' },
        { kind: 'click', t: 10, selector: '#bad' },
      ],
      { target: DEFAULT_TARGET, level: 'interact' },
    ),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as {
        inputCode?: string;
        reason?: string;
        failedAt?: number;
        auditLog?: Array<{ index: number; status: string }>;
        artifacts?: { hasScreenshot: boolean };
      } | undefined;
      return d?.inputCode === 'INPUT_BLOCKED_TARGET'
        && d?.reason === 'step-failed'
        && d?.failedAt === 1
        && d?.auditLog?.length === 2
        && d?.artifacts?.hasScreenshot === true;
    },
  );
  assert.equal(captures, 1);
});

// ────────────────────────────────────────────────────────────────────────────
// G. 비상 중단 훅
// ────────────────────────────────────────────────────────────────────────────

test('G1. 비상 중단 — 훅 트리거 시 EMERGENCY_STOP + 타임라인 이벤트 송출', async () => {
  const timeline: TimelineEvent[] = [];
  const hotkey = manualHotkey();
  let dispatchCount = 0;
  const adapter = makeAdapter({
    hotkey: hotkey.port,
    onTimelineEvent: (e) => timeline.push(e),
    osDriver: silentOsDriver({
      async dispatch() {
        dispatchCount += 1;
        if (dispatchCount === 1) hotkey.fire(); // 첫 단계 직후 비상 중단
      },
    }),
  });
  await adapter.requestPermission({ level: 'interact', rationale: 'x', target: DEFAULT_TARGET, totalSteps: 3 });
  await assert.rejects(
    adapter.replay(
      [
        { kind: 'click', t: 0, selector: '#a' },
        { kind: 'click', t: 10, selector: '#b' },
        { kind: 'click', t: 20, selector: '#c' },
      ],
      { target: DEFAULT_TARGET, level: 'interact' },
    ),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { inputCode?: string; executedSteps?: number } | undefined;
      return d?.inputCode === 'INPUT_EMERGENCY_STOP' && (d?.executedSteps ?? 0) >= 1;
    },
  );
  assert.ok(timeline.some((e) => e.kind === 'emergency-stop'));
  assert.ok(timeline.some((e) => e.kind === 'session-start'));
  assert.ok(timeline.some((e) => e.kind === 'session-end'));
  assert.equal(hotkey.unregistered, true, '훅이 확실히 해제되어야 한다');
});

// ────────────────────────────────────────────────────────────────────────────
// H. 리플레이 취소
// ────────────────────────────────────────────────────────────────────────────

test('H1. 리플레이 취소 — 사전 abort 된 signal 은 즉시 ABORTED', async () => {
  const adapter = makeAdapter();
  await adapter.requestPermission({ level: 'interact', rationale: 'x', target: DEFAULT_TARGET, totalSteps: 1 });
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    adapter.replay([{ kind: 'click', t: 0, selector: '#a' }], {
      target: DEFAULT_TARGET, level: 'interact', signal: ctrl.signal,
    }),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'ABORTED',
  );
});

test('H2. 리플레이 취소 — 중간 abort 시 signal 원인으로 중단되고 executedSteps 기록', async () => {
  const ctrl = new AbortController();
  let dispatched = 0;
  const adapter = makeAdapter({
    osDriver: silentOsDriver({
      async dispatch() {
        dispatched += 1;
        if (dispatched === 2) ctrl.abort();
      },
    }),
  });
  await adapter.requestPermission({ level: 'interact', rationale: 'x', target: DEFAULT_TARGET, totalSteps: 5 });
  await assert.rejects(
    adapter.replay(
      Array.from({ length: 5 }, (_, i) => ({ kind: 'click', t: i * 10, selector: `#s${i}` } as InputEvent)),
      { target: DEFAULT_TARGET, level: 'interact', signal: ctrl.signal },
    ),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { inputCode?: string; executedSteps?: number } | undefined;
      return d?.inputCode === 'INPUT_EMERGENCY_STOP' && d?.executedSteps === 2;
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// I. invoke 계약
// ────────────────────────────────────────────────────────────────────────────

test('I1. invoke — rationale 공란은 INPUT_INVALID', async () => {
  const adapter = makeAdapter();
  await adapter.requestPermission({ level: 'interact', rationale: 'x', target: DEFAULT_TARGET, totalSteps: 1 });
  await assert.rejects(
    adapter.invoke({
      input: { steps: [{ kind: 'click', selector: '#a' }], requestedPermission: 'interact', humanRationale: '  ' },
    }),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'INPUT_INVALID',
  );
});

test('I2. invoke — 세션 없으면 INPUT_SESSION_EXPIRED', async () => {
  const adapter = makeAdapter();
  await assert.rejects(
    adapter.invoke({
      input: { steps: [{ kind: 'click', selector: '#a' }], requestedPermission: 'interact', humanRationale: 'x' },
    }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { inputCode?: string } | undefined;
      return d?.inputCode === 'INPUT_SESSION_EXPIRED';
    },
  );
});

test('I3. invoke — 정상 경로에서 MediaAdapterOutcome 래핑 + phase 전이', async () => {
  const adapter = makeAdapter();
  await adapter.requestPermission({ level: 'interact', rationale: 'x', target: DEFAULT_TARGET, totalSteps: 2 });
  const phases: string[] = [];
  const outcome = await adapter.invoke({
    // UI 레이어가 넣는 targetUrl 확장 필드 — inferTarget 이 이를 읽어 whitelist 매치.
    input: {
      steps: [{ kind: 'click', selector: '#a' }, { kind: 'wait', ms: 1 }],
      requestedPermission: 'interact',
      humanRationale: 'x',
      targetUrl: 'https://app.local.test/login',
    } as unknown as Parameters<typeof adapter.invoke>[0]['input'],
    onProgress: (p) => phases.push(p.phase),
  });
  assert.equal(outcome.adapterId, INPUT_AUTOMATION_ADAPTER_ID);
  assert.equal(outcome.result.executedSteps, 2);
  assert.equal(phases[0], 'precheck');
  assert.equal(phases[phases.length - 1], 'finalize');
});

test('I4. canHandle — enabled=false 면 false', () => {
  const adapter = new InputAutomationAdapter(DEFAULT_ADAPTER_CONFIG, { enabled: false });
  const ok = adapter.canHandle({
    steps: [{ kind: 'click', selector: '#a' }],
    requestedPermission: 'display',
    humanRationale: 'x',
  });
  assert.equal(ok, false);
});

// ────────────────────────────────────────────────────────────────────────────
// J. 순수 helper
// ────────────────────────────────────────────────────────────────────────────

test('J1. scaleEventForDpr — DPR 에 맞춰 좌표를 CSS→OS 픽셀로 변환', () => {
  const scaled = scaleEventForDpr({ kind: 'click', t: 0, x: 100, y: 50 }, 2);
  assert.equal(scaled.x, 200);
  assert.equal(scaled.y, 100);
  // 좌표 없는 이벤트는 그대로
  assert.deepEqual(scaleEventForDpr({ kind: 'wait', t: 0, ms: 10 }, 2), { kind: 'wait', t: 0, ms: 10 });
});

test('J2. normalizeModifiers — macOS 에서 ctrl→meta 매핑, 다른 플랫폼은 유지', () => {
  assert.deepEqual(normalizeModifiers(['ctrl', 'shift'], 'darwin'), ['meta', 'shift']);
  assert.deepEqual(normalizeModifiers(['ctrl'], 'win32'), ['ctrl']);
  assert.deepEqual(normalizeModifiers(['meta', 'ctrl'], 'darwin'), ['meta', 'ctrl'], 'meta 이미 있으면 중복 변환 금지');
});

test('J3. maskSensitiveText — sensitive 플래그만 마스킹', () => {
  assert.equal(maskSensitiveText({ kind: 'type', t: 0, text: 'hi', sensitive: true }).text, '••');
  assert.equal(maskSensitiveText({ kind: 'type', t: 0, text: 'hello world' }).text, 'hello world');
});

// ────────────────────────────────────────────────────────────────────────────
// K. 레지스트리 등록
// ────────────────────────────────────────────────────────────────────────────

test('K1. createDefaultRegistry — resolveByKind("input-automation") 가 실구현 선택(priority=-10)', () => {
  const reg = createDefaultRegistry();
  const adapter = reg.resolveByKind('input-automation');
  assert.equal(adapter.descriptor.id, INPUT_AUTOMATION_ADAPTER_ID);
  assert.equal(adapter.descriptor.priority, -10);
  assert.equal(adapter.descriptor.kind, 'input-automation');
  // 등록된 descriptor(list() 결과) 에는 별칭 suffix 가 붙는다 — 인스턴스는 그렇지 않음.
  const listed = reg.list().find((d) => d.id === INPUT_AUTOMATION_ADAPTER_ID);
  assert.ok(listed);
  assert.match(listed!.displayName, new RegExp(INPUT_AUTOMATION_ALIAS.replace('/', '\\/')));
});

test('K2. createRealInputAutomationAdapter — 기본은 비활성(requiresUserConsent=true)', () => {
  const a = createRealInputAutomationAdapter(DEFAULT_ADAPTER_CONFIG);
  assert.equal(a.descriptor.capabilities.requiresUserConsent, true);
  // 기본 비활성 — canHandle=false
  assert.equal(
    a.canHandle({ steps: [{ kind: 'click', selector: '#a' }], requestedPermission: 'display', humanRationale: 'x' }),
    false,
  );
});
