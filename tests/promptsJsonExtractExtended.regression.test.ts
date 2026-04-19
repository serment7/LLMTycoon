// Run with: npx tsx --test tests/promptsJsonExtractExtended.regression.test.ts
//
// QA: 지시 #7055cfec — `src/server/promptsJsonExtract.ts` 의 기존 견고성 테스트
// (핵심 5 · 확장 5) 로 잠기지 않은 경계 조건 3 축을 추가로 고정한다.
//
// 잠그는 계약:
//   Y1. stripCodeFences 는 **멱등성** — 두 번 적용해도 결과가 동일해야 한다.
//   Y2. 빈 펜스 블록(```\n```) 만 있는 입력도 예외 없이 빈 문자열로 귀결.
//   Y3. 이스케이프된 백슬래시 `\\"` 는 문자열을 닫지 않으며 그 안의 `}` 는 깊이 카운트에
//       영향을 주지 않는다(스캐너의 이스케이프 상태 머신 회귀 방지).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findBalancedJsonCandidates,
  stripCodeFences,
} from '../src/server/promptsJsonExtract.ts';

// ---------------------------------------------------------------------------
// Y1 · 멱등성
// ---------------------------------------------------------------------------

test('Y1 — stripCodeFences 는 멱등성: f(x) === f(f(x))', () => {
  const samples = [
    '설명\n```json\n{"a":1}\n```\n끝',
    '~~~json5\n{"b":2}\n~~~',
    '\uFEFF```\n{"c":3}\n```',
    '평문 텍스트 — 펜스 없음',
    '',
  ];
  for (const s of samples) {
    const once = stripCodeFences(s);
    const twice = stripCodeFences(once);
    assert.equal(twice, once, `멱등성 위반: ${JSON.stringify(s)} → ${JSON.stringify(once)} vs ${JSON.stringify(twice)}`);
  }
});

test('Y1 — findBalancedJsonCandidates 도 입력이 이미 "순정" 이면 두 번 통과해도 동일', () => {
  const raw = '{"a":1} {"b":2}';
  const c1 = findBalancedJsonCandidates(raw);
  const c2 = findBalancedJsonCandidates(c1.join('\n'));
  assert.deepEqual(c2, c1);
});

// ---------------------------------------------------------------------------
// Y2 · 빈 펜스
// ---------------------------------------------------------------------------

test('Y2 — 빈 펜스 블록(```\\n```) 만 있는 입력은 예외 없이 빈 문자열이 된다', () => {
  assert.equal(stripCodeFences('```\n```').trim(), '');
  assert.equal(stripCodeFences('```json\n```').trim(), '');
  assert.equal(stripCodeFences('~~~\n~~~').trim(), '');
  assert.equal(stripCodeFences('```  \n\n```').trim(), '');
});

test('Y2 — 빈 펜스만 있을 때 findBalancedJsonCandidates 는 빈 배열 반환(예외 없음)', () => {
  assert.deepEqual(findBalancedJsonCandidates('```\n```'), []);
  assert.deepEqual(findBalancedJsonCandidates('~~~json\n~~~'), []);
});

// ---------------------------------------------------------------------------
// Y3 · 이스케이프된 백슬래시
// ---------------------------------------------------------------------------

test('Y3 — 문자열 안의 이스케이프된 백슬래시는 이어지는 따옴표를 건드리지 않는다', () => {
  // JSON 규격: `\\\\` 는 단일 백슬래시 문자. 그 뒤의 `"` 가 문자열을 닫는다.
  // 본 입력은 `...\\\\","tasks":[]}` 형태로 문자열이 정상 종료되어야 하며, 그 뒤의
  // `}` 가 중괄호 깊이를 감소시켜 균형이 맞아야 한다.
  const text = '{"description":"윈도우 경로 C:\\\\Users\\\\foo — 닫기","tasks":[]}';
  const c = findBalancedJsonCandidates(text);
  assert.equal(c.length, 1, `후보 개수 불일치: ${JSON.stringify(c)}`);
  const parsed = JSON.parse(c[0]);
  assert.equal(parsed.description, '윈도우 경로 C:\\Users\\foo — 닫기',
    'JSON 규격상 "\\\\\\\\" 두 쌍은 문자열 안에서 백슬래시 2개가 된다');
  assert.deepEqual(parsed.tasks, []);
});

test('Y3 — 이스케이프된 따옴표 뒤의 `}` 가 문자열을 조기 종료시키지 않는다', () => {
  const text = '{"quote":"\\"안에 }가 있어도 안전\\"","tasks":[]}';
  const c = findBalancedJsonCandidates(text);
  assert.equal(c.length, 1);
  const parsed = JSON.parse(c[0]);
  assert.equal(parsed.quote, '"안에 }가 있어도 안전"');
});

test('Y3 — 정상 JSON 뒤에 이스케이프가 섞인 추가 블록도 각각 독립 후보로 잡힌다', () => {
  const raw = '{"a":1} 그리고 {"path":"C:\\\\x","b":2}';
  const c = findBalancedJsonCandidates(raw);
  assert.equal(c.length, 2);
  assert.equal(JSON.parse(c[0]).a, 1);
  assert.equal(JSON.parse(c[1]).b, 2);
});
