// Run with: npx tsx --test tests/promptsMediaTool.regression.test.ts
//
// 회귀 테스트: `src/server/prompts.ts` 의 매체 생성 도구 명세·파서(#bc9843bb).
// 에이전트 응답의 JSON 블록을 `findBalancedJsonCandidates` 경유로 안전하게
// 추출해 `MediaToolRequest[]` 로 돌려주는지 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEDIA_TOOL_NAMES,
  formatMediaToolGuide,
  parseMediaToolRequests,
  type MediaToolName,
} from '../src/server/prompts.ts';

test('MEDIA_TOOL_NAMES — 세 도구 이름이 고정되어 있다', () => {
  assert.deepEqual([...MEDIA_TOOL_NAMES].sort(), ['generate_pdf', 'generate_pptx', 'generate_video'].sort());
});

test('formatMediaToolGuide — 세 도구 호출 예시와 "토큰 소진" 안내가 모두 들어 있다', () => {
  const guide = formatMediaToolGuide();
  for (const name of MEDIA_TOOL_NAMES) assert.match(guide, new RegExp(name));
  assert.match(guide, /토큰 소진/);
});

test('parseMediaToolRequests — 단일 도구 호출 JSON 을 그대로 추출한다', () => {
  const text = '먼저 리포트를 낼게요.\n{"tool":"generate_pdf","input":{"title":"감사 리포트","sections":[]}}';
  const out = parseMediaToolRequests(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].tool, 'generate_pdf');
  assert.equal((out[0].input as { title?: string }).title, '감사 리포트');
});

test('parseMediaToolRequests — 코드펜스 안의 JSON 도 추출한다', () => {
  const text = '```json\n{"tool":"generate_pptx","input":{"slides":[{"title":"표지"}]}}\n```';
  const out = parseMediaToolRequests(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].tool, 'generate_pptx');
});

test('parseMediaToolRequests — 다중 JSON 블록을 순서대로 돌려준다', () => {
  const text = [
    '{"tool":"generate_pdf","input":{"title":"A","sections":[]}}',
    '사이 자연어',
    '{"tool":"generate_video","input":{"prompt":"30초 홍보"}}',
  ].join('\n');
  const out = parseMediaToolRequests(text);
  assert.deepEqual(out.map(r => r.tool), ['generate_pdf', 'generate_video']);
});

test('parseMediaToolRequests — 허용 목록 밖의 tool 은 제외한다', () => {
  const text = '{"tool":"malicious_rm","input":{}}';
  assert.deepEqual(parseMediaToolRequests(text), []);
});

test('parseMediaToolRequests — input 이 객체가 아니면 거부한다 (배열·null·primitive)', () => {
  const arrayInput = '{"tool":"generate_pdf","input":[]}';
  const nullInput = '{"tool":"generate_pdf","input":null}';
  const numberInput = '{"tool":"generate_pdf","input":42}';
  assert.deepEqual(parseMediaToolRequests(arrayInput), []);
  assert.deepEqual(parseMediaToolRequests(nullInput), []);
  assert.deepEqual(parseMediaToolRequests(numberInput), []);
});

test('parseMediaToolRequests — 문자열 내 중괄호는 깊이 카운트에 영향을 주지 않는다(균형 파서 위임)', () => {
  const text = '{"tool":"generate_pdf","input":{"title":"결과가 } 처럼 보이는 제목","sections":[]}}';
  const out = parseMediaToolRequests(text);
  assert.equal(out.length, 1);
  assert.equal(
    (out[0].input as { title?: string }).title,
    '결과가 } 처럼 보이는 제목',
  );
});

test('parseMediaToolRequests — 빈 텍스트는 빈 배열을 돌려준다', () => {
  assert.deepEqual(parseMediaToolRequests(''), []);
});

test('MediaToolName 유니온 — 컴파일 시 허용 값이 이 세 개임을 타입으로 잠근다', () => {
  const ok: MediaToolName[] = ['generate_pdf', 'generate_pptx', 'generate_video'];
  assert.equal(ok.length, 3);
});
