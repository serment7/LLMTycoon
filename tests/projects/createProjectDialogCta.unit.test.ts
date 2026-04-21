// Run with: npx tsx --test tests/projects/createProjectDialogCta.unit.test.ts
//
// 지시 #49c7f589 — CreateProjectDialog 의 "최적의 팀 추천 받기" CTA 버튼 계약.
//
// UI 단위 테스트는 React 렌더링 의존 없이 "fetcher 가 호출되는 조건" 만 검증한다:
// 디자이너 요청은 설명 필드 하단 primary CTA 가 (1) 설명이 비어 있으면 호출을
// 트리거하지 않고, (2) 설명이 있으면 기존 추천 캐시 로직을 그대로 거친다는 점이다.
// 본 스위트는 `createDebouncedRecommender` 계약을 직접 호출해 동일 흐름을 재현한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDebouncedRecommender,
  createRecommendationCache,
  type RecommenderFetcher,
} from '../../src/project/recommendationClient.ts';
import type { AgentTeamRecommendation } from '../../src/project/recommendAgentTeam.ts';

const SAMPLE: AgentTeamRecommendation = {
  source: 'heuristic',
  locale: 'ko',
  items: [
    { role: 'Leader', name: 'Kai', rationale: '분배' },
    { role: 'Developer', name: 'Dev', rationale: '구현' },
  ],
};

function fakeFetcher(): { fetcher: RecommenderFetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: RecommenderFetcher = async ({ description }) => {
    calls.push(description);
    return SAMPLE;
  };
  return { fetcher, calls };
}

test('CTA1. 설명이 공백이면 CTA 경로는 fetcher 를 호출하지 않고 즉시 null', async () => {
  const { fetcher, calls } = fakeFetcher();
  const recommender = createDebouncedRecommender({ fetcher, debounceMs: 10 });
  const result = await recommender.request('   ');
  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test('CTA2. 설명이 있으면 fetcher 를 한 번 호출하고 추천 결과를 돌려준다', async () => {
  const { fetcher, calls } = fakeFetcher();
  const recommender = createDebouncedRecommender({ fetcher, debounceMs: 0 });
  const team = await recommender.request('결제 모듈 보안 강화');
  assert.deepEqual(calls, ['결제 모듈 보안 강화']);
  assert.ok(team);
  assert.equal(team!.items[0].role, 'Leader');
});

test('CTA3. 캐시 히트는 fetcher 를 재호출하지 않고 source=cache 로 돌아온다', async () => {
  const { fetcher, calls } = fakeFetcher();
  const cache = createRecommendationCache(4);
  const recommender = createDebouncedRecommender({ fetcher, cache, debounceMs: 0 });
  const first = await recommender.request('동일 설명');
  assert.ok(first);
  assert.equal(calls.length, 1);
  const second = await recommender.request('동일 설명');
  assert.ok(second);
  assert.equal(second!.source, 'cache', '재호출은 캐시 소스여야 한다');
  assert.equal(calls.length, 1, 'fetcher 는 한 번만 호출');
});
