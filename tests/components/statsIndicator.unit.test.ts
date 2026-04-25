// Run with: npx tsx --test tests/components/statsIndicator.unit.test.ts
//
// 지시 #4a9402f3 · StatsIndicator 의사결정 트리 잠금 스펙.
//
// 본 스펙은 React 렌더링 없이도 검증 가능한 순수 함수 3종을 잠근다.
//   T1. classifyTier — 70/40 임계 + null → unknown.
//   T2. buildStatsLines — 세 지표 → 라벨/퍼센트/티어/세부 줄로 1:1 매핑.
//   T3. buildAriaSummary — 스크린리더 한 줄 요약 포맷.
//
// React 컴포넌트(StatsIndicator) 자체의 hover/focus 상호작용은 Playwright e2e 또는
// React Testing Library 스펙 영역(헤더 통합 테스트)에서 잠근다 — 본 스펙의 책임 밖.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAriaSummary,
  buildStatsLines,
  classifyTier,
} from '../../src/components/StatsIndicator.tsx';

test('T1-1. classifyTier — null → unknown', () => {
  assert.equal(classifyTier(null), 'unknown');
});

test('T1-2. classifyTier — 0/39/40/69/70/100 임계 분류', () => {
  assert.equal(classifyTier(0), 'bad');
  assert.equal(classifyTier(39), 'bad');
  assert.equal(classifyTier(40), 'warn');
  assert.equal(classifyTier(69), 'warn');
  assert.equal(classifyTier(70), 'good');
  assert.equal(classifyTier(100), 'good');
});

test('T2-1. buildStatsLines — 정상 데이터 3줄 모두 percent/티어 정확', () => {
  const lines = buildStatsLines({
    coverage: { percent: 82, isolatedFiles: [] },
    activity: { percent: 50, active: 2, total: 4, breakdown: 'Dev 1/2, QA 1/2' },
    collaboration: { percent: 30, messageCount: 12, detail: '메시지 12 · 채널 3' },
  });
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map(l => [l.key, l.label, l.percent, l.tier]),
    [
      ['coverage', '커버리지', 82, 'good'],
      ['activity', '활성률', 50, 'warn'],
      ['collaboration', '협업', 30, 'bad'],
    ],
  );
});

test('T2-2. buildStatsLines — coverage 고립 파일 → detail 에 목록 포함', () => {
  const [coverage] = buildStatsLines({
    coverage: { percent: 60, isolatedFiles: ['a.ts', 'b.ts'] },
    activity: { percent: 0, active: 0, total: 0 },
    collaboration: { percent: null, messageCount: 0, detail: '' },
  });
  assert.match(coverage.detail, /고립 파일 2건/);
  assert.match(coverage.detail, /a\.ts, b\.ts/);
});

test('T2-3. activity total === 0 → percent null + tier unknown + 기본 detail', () => {
  const [, activity] = buildStatsLines({
    coverage: { percent: 0, isolatedFiles: [] },
    activity: { percent: 0, active: 0, total: 0 },
    collaboration: { percent: null, messageCount: 0, detail: '' },
  });
  assert.equal(activity.percent, null);
  assert.equal(activity.tier, 'unknown');
  assert.equal(activity.detail, '활성 0 / 전체 0');
});

test('T2-4. collaboration messageCount === 0 → "협업 로그 없음" 폴백', () => {
  const [, , collab] = buildStatsLines({
    coverage: { percent: 100, isolatedFiles: [] },
    activity: { percent: 100, active: 1, total: 1 },
    collaboration: { percent: null, messageCount: 0, detail: '무시되는 detail' },
  });
  assert.equal(collab.percent, null);
  assert.equal(collab.tier, 'unknown');
  assert.equal(collab.detail, '협업 로그 없음');
});

test('T3-1. buildAriaSummary — 라벨/퍼센트/콤마 구분 한 줄', () => {
  const lines = buildStatsLines({
    coverage: { percent: 82, isolatedFiles: [] },
    activity: { percent: 50, active: 2, total: 4 },
    collaboration: { percent: 30, messageCount: 1, detail: '' },
  });
  assert.equal(buildAriaSummary(lines), '커버리지 82%, 활성률 50%, 협업 30%');
});

test('T3-2. buildAriaSummary — null 퍼센트는 "데이터 없음" 으로 표기', () => {
  const lines = buildStatsLines({
    coverage: { percent: 0, isolatedFiles: [] },
    activity: { percent: 0, active: 0, total: 0 },
    collaboration: { percent: null, messageCount: 0, detail: '' },
  });
  assert.equal(
    buildAriaSummary(lines),
    '커버리지 0%, 활성률 데이터 없음, 협업 데이터 없음',
  );
});
