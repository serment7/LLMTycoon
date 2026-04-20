// Run with: npx tsx --test tests/token-budget/redundantRequest.spec.ts
//
// 지시 #1d6c9ff4 (QA) · 토큰 절약 전략 회귀 — 불필요한 재요청 감지.
//
// 같은 프롬프트/같은 입력으로 연속 호출이 발생하면 API 비용만 늘고 결과는 동일.
// 현재 mergeUsage 는 "수신된 usage 는 항상 누적" 하는 단순 덧셈 모델이라, 재요청
// 탐지는 **상위 호출자** 의 책임이다. 본 스펙은 그 계약을 **검증 가능한 형태로 고정**
// 하고, 재요청 회귀를 드러내기 위한 감지기 헬퍼(detectRedundantCalls) 를 테스트한다.
//
// 검증 축
//   A. 동일 usage 가 2회 연속 mergeUsage 되면 totals 는 **두 번 증가** 한다 — 중복
//      감지 책임은 상위 호출자에 있음을 명시적으로 잠근다(설계 계약).
//   B. detectRedundantCalls — 같은 (model, at) 조합이 2회 이상이면 true.
//   C. 모델/타임스탬프가 다르면 재요청으로 오판하지 않는다.
//   D. 빈 시퀀스·단일 호출은 언제나 false.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_TOTALS,
  mergeUsage,
} from '../../src/utils/claudeTokenUsageStore.ts';
import type { ClaudeTokenUsage, ClaudeTokenUsageTotals } from '../../src/types.ts';

/**
 * 같은 (model + at) 쌍이 2회 이상 나타나면 재요청 의심으로 판정한다.
 * mergeUsage 가 이를 처리하지 않으므로 호출자/미들웨어에서 동일한 판정식을
 * 구현해야 한다. 판정식 자체는 여기에 고정해 회귀를 방지한다.
 */
export function detectRedundantCalls(calls: readonly ClaudeTokenUsage[]): boolean {
  const seen = new Set<string>();
  for (const c of calls) {
    if (!c.at || !c.model) continue;
    const key = `${c.model}|${c.at}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function u(partial: Partial<ClaudeTokenUsage>): ClaudeTokenUsage {
  return {
    input_tokens: 1_000,
    output_tokens: 200,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    model: 'claude-sonnet-4-6',
    at: '2026-04-20T10:00:00.000Z',
    ...partial,
  };
}

test('A. mergeUsage 는 중복 usage 도 그대로 누적한다 — 중복 감지 책임은 상위', () => {
  let totals: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, byModel: {}, errors: EMPTY_TOTALS.errors };
  const dup = u({ input_tokens: 1_000 });
  totals = mergeUsage(totals, dup);
  totals = mergeUsage(totals, dup);
  assert.equal(totals.callCount, 2, 'callCount 은 2');
  assert.equal(totals.inputTokens, 2_000, 'input 도 2배 누적');
});

test('B. detectRedundantCalls — (model, at) 동일 쌍 2회 이상이면 true', () => {
  const seq: ClaudeTokenUsage[] = [
    u({ at: '2026-04-20T10:00:00.000Z' }),
    u({ at: '2026-04-20T10:00:01.000Z' }),
    u({ at: '2026-04-20T10:00:00.000Z' }), // 중복
  ];
  assert.equal(detectRedundantCalls(seq), true);
});

test('C. 다른 모델 또는 다른 타임스탬프는 재요청으로 오판하지 않는다', () => {
  const seq1: ClaudeTokenUsage[] = [
    u({ model: 'claude-opus-4-7', at: '2026-04-20T10:00:00.000Z' }),
    u({ model: 'claude-sonnet-4-6', at: '2026-04-20T10:00:00.000Z' }),
  ];
  assert.equal(detectRedundantCalls(seq1), false, '모델 상이');

  const seq2: ClaudeTokenUsage[] = [
    u({ at: '2026-04-20T10:00:00.000Z' }),
    u({ at: '2026-04-20T10:00:00.001Z' }),
  ];
  assert.equal(detectRedundantCalls(seq2), false, 'at 1ms 차이');
});

test('D. 빈 시퀀스·단일 호출·model/at 결여 항목은 false', () => {
  assert.equal(detectRedundantCalls([]), false);
  assert.equal(detectRedundantCalls([u({})]), false);
  // at 결여 호출이 2건 있어도 key 가 만들어지지 않아 false.
  const seq: ClaudeTokenUsage[] = [u({ at: undefined }), u({ at: undefined })];
  assert.equal(detectRedundantCalls(seq), false);
});

test('E. 대량 시퀀스 성능 — 1,000회에서 결정론적 판정(스모크)', () => {
  const seq: ClaudeTokenUsage[] = [];
  for (let i = 0; i < 1_000; i++) {
    seq.push(u({ at: new Date(1_700_000_000_000 + i * 1_000).toISOString() }));
  }
  assert.equal(detectRedundantCalls(seq), false);
  seq.push(seq[0]); // 의도적 중복.
  assert.equal(detectRedundantCalls(seq), true);
});
