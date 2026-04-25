// Run with: npx tsx --test spec/llm/tokenUsage.spec.ts
//
// 지시 #9e0c243c — 프롬프트 압축 · 캐싱 적용 후 토큰 사용량 회귀 테스트.
//
// 검증 시나리오
//   1) compactTeamContext 적용 전후 토큰 수 비교 — 압축 후 토큰이 줄어든다.
//   2) sliceRecentHistory 가 4턴 이상 입력에서 정확히 3턴만 남기는지 확인.
//   3) responseCache 적중 시 LLM 호출 횟수가 0인지 확인.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compactTeamContext,
  sliceRecentHistory,
  createResponseCache,
  teamContextTokens,
  approximateTokens,
  type TeamContext,
} from '../../src/llm/promptCache.ts';
import type { ConversationTurn } from '../../src/llm/tokenBudget.ts';

function turn(role: 'user' | 'assistant', content: string, tokens?: number): ConversationTurn {
  return {
    role,
    content,
    tokens: tokens ?? approximateTokens(content),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 1) compactTeamContext — 압축 전후 토큰 수 비교
// ────────────────────────────────────────────────────────────────────────────

test('1. compactTeamContext 적용 후 토큰 수가 적용 전보다 감소한다', () => {
  const longTeamSummary =
    '팀 LLMTycoon 은 리더 Kai 가 총괄하고, 개발자 Developer 가 구현 · 베타 검증을 동시 수행하며, '
    + '디자이너와 QA 가 부재 시 Developer 가 그 역할을 임시로 흡수한다. '
    + '자동 개발 플로우는 add_file → add_dependency → update_status 순으로 그래프를 동기화한다. '
    + '캐시 프리픽스는 시스템 프롬프트 → 에이전트 정의 → 툴 스키마 순으로 구성되며, '
    + '히스토리 후미에는 마지막 user 메시지 직전 어시스턴트 턴에 ephemeral 마커를 부착한다. '.repeat(2);

  const longHistory: ConversationTurn[] = [];
  for (let i = 0; i < 12; i += 1) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    longHistory.push(turn(role, `턴 ${i} 본문 — `.repeat(40), 220));
  }

  const before: TeamContext = {
    teamSummary: longTeamSummary,
    compactedSummary: '',
    history: longHistory,
  };
  const beforeTokens = teamContextTokens(before);

  const after = compactTeamContext(before, { keepLatest: 3, maxSummaryChars: 200 });
  const afterTokens = teamContextTokens(after);

  assert.ok(
    afterTokens < beforeTokens,
    `압축 후 토큰이 줄어야 한다 — before=${beforeTokens} after=${afterTokens}`,
  );
  assert.equal(after.history.length, 3, '압축 후 히스토리는 keepLatest=3 만 유지');
  assert.ok(after.compactedSummary.length > 0, '오래된 턴은 compactedSummary 로 흡수되어야 한다');
  assert.ok(
    after.teamSummary.length <= 201, // 200자 + 말줄임표 1자
    `teamSummary 는 maxSummaryChars 이하로 잘려야 — 길이=${after.teamSummary.length}`,
  );
});

test('1-2. compactTeamContext 가 짧은 입력에는 손대지 않는다(불필요 압축 금지)', () => {
  const small: TeamContext = {
    teamSummary: '짧은 팀 요약.',
    compactedSummary: '',
    history: [turn('user', '안녕하세요', 5), turn('assistant', '안녕하세요!', 6)],
  };
  const beforeTokens = teamContextTokens(small);
  const after = compactTeamContext(small, { keepLatest: 3 });
  const afterTokens = teamContextTokens(after);

  assert.equal(afterTokens, beforeTokens, '히스토리가 keepLatest 이하면 토큰 변화 없음');
  assert.equal(after.history.length, small.history.length);
  assert.equal(after.compactedSummary, '');
});

// ────────────────────────────────────────────────────────────────────────────
// 2) sliceRecentHistory — 4턴 이상에서 3턴만 유지
// ────────────────────────────────────────────────────────────────────────────

test('2. sliceRecentHistory 는 4턴 이상 입력에서 정확히 3턴만 남긴다', () => {
  const turns: ConversationTurn[] = [
    turn('user', 'Q1'),
    turn('assistant', 'A1'),
    turn('user', 'Q2'),
    turn('assistant', 'A2'),
    turn('user', 'Q3'),
    turn('assistant', 'A3'),
  ];
  const sliced = sliceRecentHistory(turns, 3);

  assert.equal(sliced.length, 3, '정확히 3턴만 남아야 한다');
  assert.equal(sliced[0].content, 'A2', '가장 오래된 보존 턴은 A2');
  assert.equal(sliced[1].content, 'Q3');
  assert.equal(sliced[2].content, 'A3', '가장 최신 턴은 A3');
});

test('2-2. sliceRecentHistory 는 4턴 정확히 입력에도 3턴만 남긴다(경계)', () => {
  const turns: ConversationTurn[] = [
    turn('user', 'Q1'),
    turn('assistant', 'A1'),
    turn('user', 'Q2'),
    turn('assistant', 'A2'),
  ];
  const sliced = sliceRecentHistory(turns, 3);
  assert.equal(sliced.length, 3);
  assert.equal(sliced[0].content, 'A1');
  assert.equal(sliced[2].content, 'A2');
});

test('2-3. sliceRecentHistory 는 3턴 이하 입력은 그대로 돌려준다', () => {
  const turns: ConversationTurn[] = [turn('user', 'Q1'), turn('assistant', 'A1')];
  const sliced = sliceRecentHistory(turns, 3);
  assert.equal(sliced.length, 2);
  assert.deepEqual(sliced, turns);
});

// ────────────────────────────────────────────────────────────────────────────
// 3) responseCache — 적중 시 LLM 호출 횟수 0
// ────────────────────────────────────────────────────────────────────────────

test('3. responseCache 적중 시 LLM 호출 횟수가 0이다', async () => {
  const cache = createResponseCache();
  const prompt = '추천 에이전트 팀을 알려줘 — 프로젝트: LLMTycoon';
  const cachedResponse = '리더 Kai · Developer · QA 추천';

  // 사전 적재(캐시 워밍).
  cache.set(prompt, cachedResponse);

  let fetcherCalls = 0;
  const fetcher = async () => {
    fetcherCalls += 1;
    return '실제 LLM 응답';
  };

  // 동일 프롬프트로 3회 호출 — 매번 캐시 적중이어야 한다.
  const r1 = await cache.call(prompt, fetcher);
  const r2 = await cache.call(prompt, fetcher);
  const r3 = await cache.call(prompt, fetcher);

  assert.equal(r1, cachedResponse);
  assert.equal(r2, cachedResponse);
  assert.equal(r3, cachedResponse);
  assert.equal(fetcherCalls, 0, '캐시 적중 — fetcher 가 호출되지 않아야 한다');

  const stats = cache.stats();
  assert.equal(stats.llmCalls, 0, 'stats.llmCalls 도 0');
  assert.equal(stats.hits, 3, 'hits 누적 3');
  assert.equal(stats.misses, 0);
});

test('3-2. responseCache 미스 시에는 정확히 한 번만 LLM 을 호출하고 이후엔 적중한다', async () => {
  const cache = createResponseCache();
  let fetcherCalls = 0;
  const fetcher = async () => {
    fetcherCalls += 1;
    return `응답#${fetcherCalls}`;
  };

  const first = await cache.call('동일 프롬프트', fetcher);
  const second = await cache.call('동일 프롬프트', fetcher);
  const third = await cache.call('동일 프롬프트', fetcher);

  assert.equal(first, '응답#1');
  assert.equal(second, '응답#1', '두 번째부터는 캐시 응답');
  assert.equal(third, '응답#1');
  assert.equal(fetcherCalls, 1, 'LLM 호출은 첫 미스 1회만');

  const stats = cache.stats();
  assert.equal(stats.llmCalls, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.hits, 2);
});

test('3-3. responseCache.invalidateAll 후에는 다시 LLM 을 호출한다', async () => {
  const cache = createResponseCache();
  cache.set('p', 'cached');
  let fetcherCalls = 0;
  await cache.call('p', async () => { fetcherCalls += 1; return 'live'; });
  assert.equal(fetcherCalls, 0);

  cache.invalidateAll();
  const after = await cache.call('p', async () => { fetcherCalls += 1; return 'live'; });
  assert.equal(after, 'live');
  assert.equal(fetcherCalls, 1, '무효화 후 첫 호출은 LLM 으로 흐른다');
});
