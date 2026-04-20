// Run with: npx tsx --test tests/project/recommendWizard.spec.ts
//
// 지시 #0373f10b (QA) · NewProjectWizard 3단계 플로우 회귀.
//
// 대상: Joker 가 구현 중인 NewProjectWizard.tsx 의 데이터 경로. 아직 `.tsx` 파일이
// 없으므로, 본 스펙은 그 내부가 따라야 할 **순수 함수 계약** 을 잠근다. 각 시나리오
// 의 헬퍼(createDebouncer · createDescriptionMemo · sanitizeRationale) 는 UI 구현 시
// 그대로 import 해 쓰면 되도록 시그니처를 맞췄다.
//
// 시나리오
//   S1. 400ms 디바운스 — 연속 입력 중 확정 호출은 1회(마지막 값) 로만 발사된다.
//   S2. 클라이언트 메모이제이션 — 동일 description 재입력 시 recommendAgentTeam
//        호출이 재실행되지 않는다(토큰 절약).
//   S3. applyRecommendedTeam — 개별 선택·일괄 추가 모두 fetch 두 단계(hire→attach)
//        를 따라 appliedCount 가 증가한다.
//   S4. sanitizeRationale — <b>/<strong> 외 태그는 제거하고 엔티티는 이스케이프한다.
//   S5. 로딩·에러·빈 상태 문구가 EN/KO locales 와 일치한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recommendAgentTeam,
  type AgentRecommendation,
} from '../../src/project/recommendAgentTeam.ts';
import { applyRecommendedTeam } from '../../src/project/api.ts';
import { translate } from '../../src/i18n/index.ts';

// ────────────────────────────────────────────────────────────────────────────
// 계약 헬퍼 — UI 구현이 재사용할 의도
// ────────────────────────────────────────────────────────────────────────────

/**
 * 낙관적 trailing-edge 디바운서. wait 내에 재호출되면 이전 호출은 버려진다.
 * Joker 의 Wizard 입력 핸들러가 그대로 가져다 쓸 수 있도록 시그니처 단일화.
 */
export function createDebouncer<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  waitMs: number,
): { readonly call: (...args: TArgs) => void; readonly flush: () => void; readonly cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: TArgs | null = null;
  return {
    call(...args: TArgs) {
      pendingArgs = args;
      if (handle !== null) clearTimeout(handle);
      handle = setTimeout(() => {
        handle = null;
        const a = pendingArgs;
        pendingArgs = null;
        if (a) fn(...a);
      }, waitMs);
    },
    flush() {
      if (handle !== null) clearTimeout(handle);
      handle = null;
      const a = pendingArgs;
      pendingArgs = null;
      if (a) fn(...a);
    },
    cancel() {
      if (handle !== null) clearTimeout(handle);
      handle = null;
      pendingArgs = null;
    },
  };
}

/**
 * description 키 기준 in-memory 메모이제이션. 동일 description 에 대해 pending /
 * resolved 를 모두 공유한다(즉, 연속 호출 중에도 네트워크는 1회).
 */
export function createDescriptionMemo<T>(compute: (d: string) => Promise<T>): {
  readonly get: (d: string) => Promise<T>;
  readonly callCount: () => number;
  readonly clear: () => void;
} {
  const cache = new Map<string, Promise<T>>();
  let hits = 0;
  return {
    get(description) {
      const key = description.trim();
      const existing = cache.get(key);
      if (existing) return existing;
      hits += 1;
      const p = compute(description);
      cache.set(key, p);
      // 실패한 호출은 재시도 가능하도록 캐시에서 제거.
      p.catch(() => cache.delete(key));
      return p;
    },
    callCount() {
      return hits;
    },
    clear() {
      cache.clear();
    },
  };
}

/**
 * 추천 근거 텍스트 sanitizer. `<b>` / `</b>` / `<strong>` / `</strong>` 외 모든
 * 태그는 제거하고, 잔여 텍스트의 `<` `>` `&` 는 엔티티로 이스케이프한다. `<strong>`
 * 은 정규화 차원에서 `<b>` 로 대체한다.
 */
export function sanitizeRationale(input: string): string {
  if (typeof input !== 'string') return '';
  // 1) 허용 태그만 플레이스홀더로 치환.
  const OPEN = '\u0000B\u0000';
  const CLOSE = '\u0000/B\u0000';
  // 0) 스크립트/스타일 블록은 컨텐츠 째로 삭제(컨텐츠가 XSS 벡터).
  let s = input
    .replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*style\b[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi, '');
  // 1) 허용 태그만 플레이스홀더로 치환.
  s = s
    .replace(/<\s*b\s*>/gi, OPEN)
    .replace(/<\s*strong\s*>/gi, OPEN)
    .replace(/<\s*\/\s*b\s*>/gi, CLOSE)
    .replace(/<\s*\/\s*strong\s*>/gi, CLOSE);
  // 2) 남은 태그는 전부 제거(속성/주석/자기닫힘 포함).
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  // 3) 잔여 `<` `>` `&` 이스케이프.
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 4) 플레이스홀더 복원.
  s = s.replace(new RegExp(OPEN, 'g'), '<b>').replace(new RegExp(CLOSE, 'g'), '</b>');
  return s;
}

// ────────────────────────────────────────────────────────────────────────────
// S1. 400ms 디바운스
// ────────────────────────────────────────────────────────────────────────────

test('S1-1. 400ms 내 연속 입력 — 확정 호출은 마지막 값 1회', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = [];
  const d = createDebouncer((v: string) => calls.push(v), 400);
  d.call('a');
  t.mock.timers.tick(100);
  d.call('ab');
  t.mock.timers.tick(100);
  d.call('abc');
  t.mock.timers.tick(399);
  assert.deepEqual(calls, [], '디바운스 경계 직전에는 미호출');
  t.mock.timers.tick(1);
  assert.deepEqual(calls, ['abc'], '마지막 값만 1회');
});

test('S1-2. 400ms 경계 이후 별개의 호출 — 2회 발사된다', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = [];
  const d = createDebouncer((v: string) => calls.push(v), 400);
  d.call('first');
  t.mock.timers.tick(400);
  d.call('second');
  t.mock.timers.tick(400);
  assert.deepEqual(calls, ['first', 'second']);
});

test('S1-3. cancel 은 예약된 호출을 버린다', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = [];
  const d = createDebouncer((v: string) => calls.push(v), 400);
  d.call('x');
  t.mock.timers.tick(200);
  d.cancel();
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, []);
});

// ────────────────────────────────────────────────────────────────────────────
// S2. 클라이언트 메모이제이션
// ────────────────────────────────────────────────────────────────────────────

test('S2-1. 동일 description 재입력 — compute 는 1회만 실행', async () => {
  let hits = 0;
  const memo = createDescriptionMemo(async (d: string) => {
    hits += 1;
    return recommendAgentTeam(d); // invoker 미주입 → heuristic, 네트워크 없음
  });
  const a = await memo.get('결제 모듈 보안 강화');
  const b = await memo.get('결제 모듈 보안 강화');
  assert.equal(hits, 1, 'compute 는 1회');
  assert.equal(memo.callCount(), 1);
  assert.strictEqual(a, b, '동일 레퍼런스 반환(동기 캐시)');
});

test('S2-2. 공백·대소문자 차이는 trim 기준으로 같은 키', async () => {
  let hits = 0;
  const memo = createDescriptionMemo(async (d: string) => {
    hits += 1;
    return recommendAgentTeam(d);
  });
  await memo.get('블로그 CMS');
  await memo.get('  블로그 CMS  ');
  assert.equal(hits, 1);
});

test('S2-3. compute 가 실패하면 캐시에서 제거돼 재시도 가능', async () => {
  let hits = 0;
  const memo = createDescriptionMemo(async () => {
    hits += 1;
    throw new Error('boom');
  });
  await assert.rejects(() => memo.get('x'));
  await assert.rejects(() => memo.get('x'));
  assert.equal(hits, 2, '실패 후 재시도는 compute 가 다시 실행돼야');
});

// ────────────────────────────────────────────────────────────────────────────
// S3. applyRecommendedTeam — 개별·일괄
// ────────────────────────────────────────────────────────────────────────────

function makeFetchStub() {
  const calls: { url: string; body: unknown }[] = [];
  let seq = 0;
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.endsWith('/api/agents/hire')) {
      seq += 1;
      return new Response(JSON.stringify({ id: `agent-${seq}` }), { status: 200 });
    }
    if (/\/api\/projects\/[^/]+\/agents$/.test(url)) {
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, calls };
}

const SAMPLE_TEAM: AgentRecommendation[] = [
  { role: 'Leader', name: 'Kai', rationale: '분배' },
  { role: 'Developer', name: 'Dev', rationale: '구현' },
  { role: 'QA', name: 'QA', rationale: '검증' },
];

test('S3-1. 일괄 추가 — 추천 3명 모두 hire+attach 순서로 호출되고 appliedCount=3', async () => {
  const { fetchImpl, calls } = makeFetchStub();
  const res = await applyRecommendedTeam('proj-1', SAMPLE_TEAM, { fetch: fetchImpl });
  assert.equal(res.appliedCount, 3);
  const urls = calls.map((c) => c.url);
  // hire, attach, hire, attach, hire, attach 순서.
  assert.equal(urls.filter((u) => u.endsWith('/api/agents/hire')).length, 3);
  assert.equal(urls.filter((u) => /\/api\/projects\/proj-1\/agents$/.test(u)).length, 3);
  for (const it of res.items) assert.equal(it.ok, true);
});

test('S3-2. 개별 선택 — 사용자가 1명만 체크했을 때 해당 1명만 반영', async () => {
  const { fetchImpl, calls } = makeFetchStub();
  const onlyDev = SAMPLE_TEAM.filter((r) => r.role === 'Developer');
  const res = await applyRecommendedTeam('proj-2', onlyDev, { fetch: fetchImpl });
  assert.equal(res.appliedCount, 1);
  assert.equal(calls.length, 2, 'hire + attach 합 2회');
});

test('S3-3. 빈 선택 — 네트워크 호출 없이 appliedCount=0', async () => {
  const { fetchImpl, calls } = makeFetchStub();
  const res = await applyRecommendedTeam('proj-3', [], { fetch: fetchImpl });
  assert.equal(res.appliedCount, 0);
  assert.equal(calls.length, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// S4. sanitizeRationale
// ────────────────────────────────────────────────────────────────────────────

test('S4-1. <b>/<strong> 은 <b> 로 통일되어 보존된다', () => {
  assert.equal(sanitizeRationale('핵심 <b>결제</b> 모듈'), '핵심 <b>결제</b> 모듈');
  assert.equal(sanitizeRationale('핵심 <strong>결제</strong> 모듈'), '핵심 <b>결제</b> 모듈');
});

test('S4-2. <script>·<img>·<a> 등 위험 태그는 제거된다', () => {
  assert.equal(
    sanitizeRationale('<script>alert(1)</script>보안'),
    '보안',
  );
  assert.equal(
    sanitizeRationale('<img src=x onerror=1>디자인'),
    '디자인',
  );
  assert.equal(
    sanitizeRationale('클릭 <a href="javascript:alert(1)">여기</a>!'),
    '클릭 여기!',
  );
});

test('S4-3. 잔여 `<` `>` `&` 문자는 엔티티로 이스케이프', () => {
  assert.equal(sanitizeRationale('1 < 2 & 3 > 0'), '1 &lt; 2 &amp; 3 &gt; 0');
});

test('S4-4. HTML 주석도 제거된다', () => {
  assert.equal(sanitizeRationale('a <!-- secret --> b'), 'a  b');
});

test('S4-5. 빈/비문자열 입력은 빈 문자열로 폴백', () => {
  assert.equal(sanitizeRationale(''), '');
  assert.equal(sanitizeRationale(undefined as unknown as string), '');
});

// ────────────────────────────────────────────────────────────────────────────
// S5. 로딩·에러·빈 상태 문구(EN/KO)
// ────────────────────────────────────────────────────────────────────────────

test('S5-1. 로딩 문구 — project.newProjectWizard.loading 의 EN/KO 매핑', () => {
  assert.equal(translate('project.newProjectWizard.loading', 'en'), 'Preparing recommendations…');
  assert.equal(translate('project.newProjectWizard.loading', 'ko'), '추천을 준비하는 중…');
});

test('S5-2. 에러 문구 — 재시도 안내 포함', () => {
  assert.equal(
    translate('project.newProjectWizard.error', 'en'),
    "Couldn't fetch recommendations. Try again.",
  );
  assert.equal(
    translate('project.newProjectWizard.error', 'ko'),
    '추천을 불러오지 못했습니다. 다시 시도해 주세요.',
  );
});

test('S5-3. 빈 추천 상태 — 설명 입력 유도 문구', () => {
  assert.equal(
    translate('project.newProjectWizard.empty', 'en'),
    'No recommendations yet. Add a project description above.',
  );
  assert.equal(
    translate('project.newProjectWizard.empty', 'ko'),
    '추천이 아직 없습니다. 위에 프로젝트 설명을 입력해 주세요.',
  );
});

test('S5-4. 모든 상태 키는 양 로캘에서 문자열로 해석된다(미번역 키는 없다)', () => {
  const keys = [
    'project.newProjectWizard.loading',
    'project.newProjectWizard.error',
    'project.newProjectWizard.empty',
  ];
  for (const k of keys) {
    const en = translate(k, 'en');
    const ko = translate(k, 'ko');
    assert.notEqual(en, k, `en 로캘에 ${k} 가 번역되어야 함`);
    assert.notEqual(ko, k, `ko 로캘에 ${k} 가 번역되어야 함`);
    assert.notEqual(en, ko, `${k} 는 로캘별로 다른 문구여야 함`);
  }
});
