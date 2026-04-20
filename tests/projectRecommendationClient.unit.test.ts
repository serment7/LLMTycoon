// Run with: npx tsx --test tests/projectRecommendationClient.unit.test.ts
//
// 지시 #d5acb8a5 — 신규 프로젝트 마법사가 의존하는 순수 로직 계약.
//
// 본 스위트는 DOM/React 없이 3 축만 잠근다:
//   S. sanitizeRationale — `**bold**` 만 허용하고 HTML·미허용 마크다운을 제거.
//   C. createRecommendationCache — normalize 키 동일성·LRU 축출·clear.
//   D. createDebouncedRecommender — 400ms 디바운스·연속 호출 시 마지막만 수행·
//      캐시 히트는 즉시 반환(source='cache')·빈 description 은 null.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDebouncedRecommender,
  createRecommendationCache,
  normalizeDescription,
  sanitizeRationale,
} from '../src/project/recommendationClient.ts';
import type { AgentTeamRecommendation } from '../src/project/recommendAgentTeam.ts';

// ────────────────────────────────────────────────────────────────────────────
// S. sanitizeRationale
// ────────────────────────────────────────────────────────────────────────────

test('S1. 일반 텍스트는 strong=false 단일 세그먼트', () => {
  const out = sanitizeRationale('범위를 쪼개고 분배합니다.');
  assert.deepEqual(out, [{ text: '범위를 쪼개고 분배합니다.', strong: false }]);
});

test('S2. **bold** 는 strong 세그먼트로 분리', () => {
  const out = sanitizeRationale('이것은 **중요한** 설명입니다.');
  assert.deepEqual(out, [
    { text: '이것은 ', strong: false },
    { text: '중요한', strong: true },
    { text: ' 설명입니다.', strong: false },
  ]);
});

test('S3. HTML 태그는 전량 제거(스크립트 포함)', () => {
  const out = sanitizeRationale('안녕 <script>alert(1)</script> 세상<b>bold</b>');
  const joined = out.map((s) => s.text).join('');
  assert.ok(!joined.includes('<'));
  assert.ok(!joined.includes('script'));
  assert.ok(joined.includes('bold'));
});

test('S4. 링크 [text](url) 는 text 만 남기고 url 은 제거', () => {
  const out = sanitizeRationale('문서는 [여기](https://evil.example.com) 참고');
  const joined = out.map((s) => s.text).join('');
  assert.ok(joined.includes('여기'));
  assert.ok(!joined.includes('evil.example.com'));
});

test('S5. 홀수 `**` — 닫히지 않은 꼬리는 plain 텍스트로 떨어진다', () => {
  const out = sanitizeRationale('앞 **강조 뒤');
  const strongs = out.filter((s) => s.strong).map((s) => s.text);
  assert.deepEqual(strongs, []);
  assert.ok(out.map((s) => s.text).join('').includes('**강조 뒤'));
});

test('S6. 백틱·밑줄·해시 등 미허용 마크다운 기호는 제거', () => {
  const out = sanitizeRationale('`코드` _기울임_ # 제목');
  const joined = out.map((s) => s.text).join('');
  assert.ok(!joined.includes('`'));
  assert.ok(!joined.includes('_'));
  assert.ok(!joined.includes('#'));
});

test('S7. 비문자열 입력은 빈 배열', () => {
  assert.deepEqual(sanitizeRationale(undefined as unknown as string), []);
  assert.deepEqual(sanitizeRationale(123 as unknown as string), []);
});

// ────────────────────────────────────────────────────────────────────────────
// C. RecommendationCache
// ────────────────────────────────────────────────────────────────────────────

function fakeTeam(name: string): AgentTeamRecommendation {
  return {
    items: [{ role: 'Leader', name, rationale: 'r' }],
    source: 'claude',
  };
}

test('C1. normalizeDescription — 양끝 trim + 연속 공백 단일화', () => {
  assert.equal(normalizeDescription('  결제  모듈 \n보안  '), '결제 모듈 보안');
});

test('C2. cache.get/set — 공백만 다른 description 도 동일 키로 히트', () => {
  const cache = createRecommendationCache();
  cache.set('결제 모듈 보안', fakeTeam('Kai'));
  assert.equal(cache.get('결제   모듈\n보안')?.items[0].name, 'Kai');
});

test('C3. cache LRU — 용량 초과 시 가장 오래된 항목부터 축출', () => {
  const cache = createRecommendationCache(2);
  cache.set('a', fakeTeam('A'));
  cache.set('b', fakeTeam('B'));
  cache.set('c', fakeTeam('C'));
  assert.equal(cache.get('a'), undefined, 'a 는 축출');
  assert.ok(cache.get('b'));
  assert.ok(cache.get('c'));
  assert.equal(cache.size(), 2);
});

test('C4. cache.get — 히트 시 최신으로 갱신(최근 사용) → 축출 대상 변경', () => {
  const cache = createRecommendationCache(2);
  cache.set('a', fakeTeam('A'));
  cache.set('b', fakeTeam('B'));
  // a 를 재사용 → a 가 최신, 이후 c 를 넣으면 b 가 축출돼야 한다.
  cache.get('a');
  cache.set('c', fakeTeam('C'));
  assert.ok(cache.get('a'));
  assert.equal(cache.get('b'), undefined);
  assert.ok(cache.get('c'));
});

test('C5. cache.clear — 전체 초기화', () => {
  const cache = createRecommendationCache();
  cache.set('a', fakeTeam('A'));
  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(cache.get('a'), undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// D. Debounced recommender — 가짜 타이머
// ────────────────────────────────────────────────────────────────────────────

interface FakeTimerHandle {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

function createFakeTimers() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, FakeTimerHandle>();
  const setTimeoutFn = ((fn: () => void, ms: number) => {
    const id = next++;
    timers.set(id, { id, at: now + ms, fn });
    return id;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((id: number) => {
    timers.delete(id);
  }) as unknown as typeof clearTimeout;
  function advance(ms: number) {
    now += ms;
    const due = Array.from(timers.values())
      .filter((t) => t.at <= now)
      .sort((a, b) => a.at - b.at);
    for (const t of due) {
      timers.delete(t.id);
      t.fn();
    }
  }
  return { setTimeoutFn, clearTimeoutFn, advance, size: () => timers.size };
}

test('D1. 디바운스 — 400ms 만료 전에 fetcher 호출 없음', async () => {
  const { setTimeoutFn, clearTimeoutFn, advance, size } = createFakeTimers();
  let calls = 0;
  const rec = createDebouncedRecommender({
    fetcher: async () => {
      calls += 1;
      return fakeTeam('X');
    },
    debounceMs: 400,
    setTimeoutFn,
    clearTimeoutFn,
  });
  const p = rec.request('설명');
  assert.equal(calls, 0, '타이머 만료 전');
  assert.equal(size(), 1);
  advance(399);
  assert.equal(calls, 0, '399ms 에서는 아직 호출 X');
  advance(1);
  await p; // fetcher 완료 대기
  assert.equal(calls, 1);
});

test('D2. 연속 호출 — 이전 타이머는 취소되고 마지막 요청만 수행', async () => {
  const { setTimeoutFn, clearTimeoutFn, advance } = createFakeTimers();
  let calls = 0;
  let lastDesc = '';
  const rec = createDebouncedRecommender({
    fetcher: async ({ description }) => {
      calls += 1;
      lastDesc = description;
      return fakeTeam(description);
    },
    debounceMs: 400,
    setTimeoutFn,
    clearTimeoutFn,
  });
  rec.request('first').catch(() => undefined);
  advance(200);
  rec.request('second').catch(() => undefined);
  advance(200);
  assert.equal(calls, 0, '400ms 경과 전');
  const p3 = rec.request('third');
  advance(400);
  await p3;
  assert.equal(calls, 1);
  assert.equal(lastDesc, 'third');
});

test('D3. 캐시 히트 — 디바운스 없이 즉시 반환하고 source=cache', async () => {
  const { setTimeoutFn, clearTimeoutFn } = createFakeTimers();
  const cache = createRecommendationCache();
  cache.set('보안', fakeTeam('Hit'));
  let calls = 0;
  const rec = createDebouncedRecommender({
    fetcher: async () => {
      calls += 1;
      return fakeTeam('miss');
    },
    cache,
    debounceMs: 400,
    setTimeoutFn,
    clearTimeoutFn,
  });
  const res = await rec.request('보안');
  assert.equal(calls, 0);
  assert.equal(res?.items[0].name, 'Hit');
  assert.equal(res?.source, 'cache');
});

test('D4. 빈 description — fetcher 호출 없이 null 즉시 반환', async () => {
  const { setTimeoutFn, clearTimeoutFn } = createFakeTimers();
  let calls = 0;
  const rec = createDebouncedRecommender({
    fetcher: async () => {
      calls += 1;
      return fakeTeam('x');
    },
    debounceMs: 400,
    setTimeoutFn,
    clearTimeoutFn,
  });
  assert.equal(await rec.request(''), null);
  assert.equal(await rec.request('   '), null);
  assert.equal(calls, 0);
});

test('D5. cancel — 보류 중 타이머·비행 요청 모두 폐기', async () => {
  const { setTimeoutFn, clearTimeoutFn, advance, size } = createFakeTimers();
  let calls = 0;
  const rec = createDebouncedRecommender({
    fetcher: async () => {
      calls += 1;
      return fakeTeam('x');
    },
    debounceMs: 400,
    setTimeoutFn,
    clearTimeoutFn,
  });
  rec.request('설명').catch(() => undefined);
  rec.cancel();
  advance(1000);
  assert.equal(size(), 0);
  assert.equal(calls, 0);
});

test('D6. 성공 시 캐시에 결과 기록', async () => {
  const { setTimeoutFn, clearTimeoutFn, advance } = createFakeTimers();
  const cache = createRecommendationCache();
  const rec = createDebouncedRecommender({
    fetcher: async () => fakeTeam('Stored'),
    cache,
    debounceMs: 400,
    setTimeoutFn,
    clearTimeoutFn,
  });
  const p = rec.request('보안');
  advance(400);
  await p;
  assert.equal(cache.get('보안')?.items[0].name, 'Stored');
});
