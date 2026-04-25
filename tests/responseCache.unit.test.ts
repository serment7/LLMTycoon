// Run with: npx tsx --test tests/responseCache.unit.test.ts
//
// 지시 #65a79466 — LLM 응답 캐싱 레이어 단위 테스트.
// 검증 포인트
//   1. get/set: 동일 키 적중·다른 키 미스
//   2. TTL: 만료 직전 적중, 만료 직후 미스
//   3. LRU: 용량 초과 시 가장 오래된 항목부터 축출, 조회로 항목 갱신
//   4. stats.cacheHitRate: 누적 hit/miss 비율 산출
//   5. makeCacheKey: 모델·프롬프트가 같으면 같은 키, 어느 한 쪽이라도 다르면 다른 키

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createResponseCache,
  makeCacheKey,
} from '../src/services/llm/responseCache.ts';

test('get/set — 동일 키 적중, 다른 키는 undefined', () => {
  const cache = createResponseCache();
  cache.setCached('k1', 'v1');
  assert.equal(cache.getCached('k1'), 'v1');
  assert.equal(cache.getCached('missing'), undefined);
});

test('TTL — 만료 직전엔 적중, 만료 직후엔 미스', () => {
  let now = 1_000_000;
  const cache = createResponseCache({ ttlMs: 1000, now: () => now });
  cache.setCached('k', 'v');
  now += 999; // 1ms 남음
  assert.equal(cache.getCached('k'), 'v');
  now += 2; // 만료 1ms 초과
  assert.equal(cache.getCached('k'), undefined);
});

test('LRU — 용량 초과 시 가장 오래된 항목 축출', () => {
  const cache = createResponseCache({ maxEntries: 3 });
  cache.setCached('a', '1');
  cache.setCached('b', '2');
  cache.setCached('c', '3');
  cache.setCached('d', '4'); // a 가 축출되어야 함
  assert.equal(cache.getCached('a'), undefined);
  assert.equal(cache.getCached('b'), '2');
  assert.equal(cache.getCached('c'), '3');
  assert.equal(cache.getCached('d'), '4');
});

test('LRU — get 으로도 최근성이 갱신된다', () => {
  const cache = createResponseCache({ maxEntries: 3 });
  cache.setCached('a', '1');
  cache.setCached('b', '2');
  cache.setCached('c', '3');
  // a 를 조회해 최근으로 끌어올림
  assert.equal(cache.getCached('a'), '1');
  cache.setCached('d', '4'); // 이제 가장 오래된 b 가 축출되어야 함
  assert.equal(cache.getCached('a'), '1');
  assert.equal(cache.getCached('b'), undefined);
  assert.equal(cache.getCached('c'), '3');
  assert.equal(cache.getCached('d'), '4');
});

test('stats.cacheHitRate — 누적 hits/(hits+misses) 비율', () => {
  const cache = createResponseCache();
  // 호출 0건 → 0
  assert.equal(cache.stats.cacheHitRate, 0);
  cache.setCached('k', 'v');
  cache.getCached('k'); // hit
  cache.getCached('k'); // hit
  cache.getCached('miss'); // miss
  const s = cache.stats;
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
  assert.ok(Math.abs(s.cacheHitRate - 2 / 3) < 1e-9);
  assert.equal(s.size, 1);
});

test('clear — 항목과 통계가 모두 0 으로 초기화', () => {
  const cache = createResponseCache();
  cache.setCached('k', 'v');
  cache.getCached('k');
  cache.getCached('miss');
  cache.clear();
  const s = cache.stats;
  assert.equal(s.hits, 0);
  assert.equal(s.misses, 0);
  assert.equal(s.size, 0);
  assert.equal(cache.getCached('k'), undefined);
});

test('makeCacheKey — 모델·프롬프트 동일 시 같은 키, 한쪽 다르면 다른 키', () => {
  assert.equal(makeCacheKey('m1', 'hello'), makeCacheKey('m1', 'hello'));
  assert.notEqual(makeCacheKey('m1', 'hello'), makeCacheKey('m2', 'hello'));
  assert.notEqual(makeCacheKey('m1', 'hello'), makeCacheKey('m1', 'hello!'));
});
