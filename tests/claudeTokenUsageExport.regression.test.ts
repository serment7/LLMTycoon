// Run with: npx tsx --test tests/claudeTokenUsageExport.regression.test.ts
//
// QA: 지시 #176df2b8 의 (3) CSV/JSON 내보내기 회귀. 설정 패널의 다운로드 버튼이
// 선택한 범위(오늘/주/전체) 에 대해 동일 순수 함수를 사용하므로, 그 함수들을
// Node 환경에서 순수하게 검증한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExportRows,
  toCsv,
  toJson,
  suggestFilename,
} from '../src/utils/claudeTokenUsageExport.ts';
import {
  EMPTY_TOTALS,
  applyDeltaToState,
  type TokenUsageStoreState,
} from '../src/utils/claudeTokenUsageStore.ts';
import type { ClaudeTokenUsage } from '../src/types.ts';

function makeEmpty(date = '2026-04-19'): TokenUsageStoreState {
  return {
    all: { ...EMPTY_TOTALS, byModel: {} },
    today: { ...EMPTY_TOTALS, byModel: {} },
    todayDate: date,
    history: [],
    loadError: null,
  };
}

const USAGE: ClaudeTokenUsage = {
  input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 25, cache_creation_input_tokens: 0,
  model: 'claude-sonnet-4-6',
};

test('buildExportRows(today) — 한 줄 요약', () => {
  let s = makeEmpty('2026-04-19');
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 19, 10));
  const rows = buildExportRows(s, 'today');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-04-19');
  assert.equal(rows[0].inputTokens, 100);
  assert.equal(rows[0].cacheReadTokens, 25);
  assert.ok(rows[0].cacheHitRate > 0 && rows[0].cacheHitRate <= 1);
});

test('buildExportRows(all) — 전체 합계 한 줄', () => {
  let s = makeEmpty('2026-04-19');
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 19, 10));
  const rows = buildExportRows(s, 'all');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '합계');
});

test('buildExportRows(week) — 오늘 + 최근 N일 + 합계 한 줄', () => {
  let s = makeEmpty('2026-04-13');
  for (let d = 13; d <= 19; d++) {
    s = applyDeltaToState(s, USAGE, new Date(2026, 3, d, 10));
  }
  const rows = buildExportRows(s, 'week');
  // 오늘 1 + history 6 + 합계 1 = 8
  assert.equal(rows.length, 8);
  assert.equal(rows[rows.length - 1].date, '합계');
  assert.equal(rows[rows.length - 1].callCount, 7);
});

test('toCsv — UTF-8 BOM + RFC4180 줄바꿈 + 헤더 포함', () => {
  const rows = [
    { date: '2026-04-19', callCount: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 25, cacheCreationTokens: 0, estimatedCostUsd: 0.001, cacheHitRate: 0.2,
      err_rate_limit: 0, err_overloaded: 0, err_api_error: 0, err_bad_request: 0, err_auth: 0, err_timeout: 0, err_network: 0 },
  ];
  const csv = toCsv(rows);
  assert.ok(csv.startsWith('\uFEFF'), 'UTF-8 BOM 필요(Excel 호환)');
  assert.match(csv, /date,callCount,/);
  assert.match(csv, /\r\n/);
  assert.match(csv, /2026-04-19/);
});

test('toCsv — 쉼표·개행·따옴표 포함 셀은 따옴표로 감싸고 내부 따옴표는 이중화', () => {
  const rows = [
    { date: '"합계"', callCount: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCostUsd: 0, cacheHitRate: 0 },
  ];
  const csv = toCsv(rows as unknown as Parameters<typeof toCsv>[0]);
  assert.match(csv, /""합계""/);
});

test('toJson — schema·range·rows 메타를 포함해 왕복 검증 가능', () => {
  const rows = [
    { date: '2026-04-19', callCount: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCostUsd: 0, cacheHitRate: 0,
      err_rate_limit: 0, err_overloaded: 0, err_api_error: 0, err_bad_request: 0, err_auth: 0, err_timeout: 0, err_network: 0 },
  ];
  const json = toJson(rows, { range: 'today', exportedAt: '2026-04-19T10:00:00.000Z' });
  const parsed = JSON.parse(json);
  assert.equal(parsed.schema, 'llmtycoon.tokenUsage.export/v1');
  assert.equal(parsed.range, 'today');
  assert.equal(parsed.rows.length, 1);
});

test('suggestFilename — Windows 금지 문자를 포함하지 않는다', () => {
  const name = suggestFilename('week', '2026-04-19T10:00:00.000Z', 'csv');
  assert.ok(!name.includes(':'), '파일명에 콜론 금지');
  assert.match(name, /\.csv$/);
  assert.match(name, /week/);
});

// ─── 지시 #7ad75649 보강 ──────────────────────────────────────────────────────

test('suggestFilename — Windows 금지 문자 9종(\\ / : * ? " < > |) 전부 부재', () => {
  // Windows 는 파일명에 해당 9문자를 허용하지 않는다. 특히 `:` 외의 다른
  // 문자가 추가로 섞일 여지는 range/ext 입력에서만 생기므로, 정상 입력에서는
  // 전부 부재여야 한다. 사용자가 "내려받은 파일이 열리지 않는" 회귀를 차단.
  const forbidden = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
  for (const range of ['today', 'week', 'all'] as const) {
    for (const ext of ['csv', 'json'] as const) {
      const name = suggestFilename(range, '2026-04-19T10:00:00.000Z', ext);
      for (const ch of forbidden) {
        assert.ok(!name.includes(ch), `range=${range} ext=${ext} 에서 금지 문자 "${ch}" 가 있다: ${name}`);
      }
    }
  }
});

test('toCsv — 빈 행 배열이어도 헤더만 포함한 유효 CSV 를 돌려준다', () => {
  const csv = toCsv([]);
  assert.ok(csv.startsWith('\uFEFF'), 'BOM 은 행 유무와 무관하게 유지');
  // 헤더 행만 존재 → 본문 빈 상태. `\r\n` 이 바디에 붙지 않아야 파서(RFC 4180)
  // 관점에서 유효.
  const withoutBom = csv.replace(/^\uFEFF/, '');
  assert.equal(withoutBom.split('\r\n').filter(l => l.length > 0).length, 1,
    '헤더 한 줄만 남아야 한다');
  assert.match(withoutBom, /^date,callCount,/, '헤더 순서는 고정');
});

test('toJson — 빈 rows 여도 schema/range/exportedAt 메타는 유지된다', () => {
  const json = toJson([], { range: 'week', exportedAt: '2026-04-19T10:00:00.000Z' });
  const parsed = JSON.parse(json);
  assert.equal(parsed.schema, 'llmtycoon.tokenUsage.export/v1');
  assert.equal(parsed.range, 'week');
  assert.equal(parsed.exportedAt, '2026-04-19T10:00:00.000Z');
  assert.deepEqual(parsed.rows, [], 'rows 는 빈 배열이어야 한다');
});
