// Run with: npx tsx --test tests/promptsJsonExtract.robustness.test.ts
//
// src/server/promptsJsonExtract.ts 의 LLM 응답 견고성 후속 회귀 (지시 #a64a013a).
// 기존 tests/leaderPlanExtraction.regression.test.ts 가 핵심 계약(R1~R5)을 잠그고
// 본 스위트는 경계·불완전 입력에서의 스캐너 탄력성을 추가로 잠근다.
//
// 잠그는 계약 5가지:
//   X1. 미닫힘 `{` 뒤에 정상 JSON 이 오면 뒤 JSON 을 놓치지 않는다(EOF 회귀).
//   X2. UTF-8 BOM 이 앞에 붙어도 stripCodeFences 가 제거해 JSON.parse 가 성공한다.
//   X3. CRLF/CR 개행이 섞여 있어도 펜스가 깔끔히 제거되고 본문에 `\r` 가 남지 않는다.
//   X4. 언어 태그에 `+` 또는 `.` 이 포함돼도 펜스 전체가 제거된다(json+ld · json5).
//   X5. 중첩 객체·배열이 섞인 여러 블록도 각각 균형 잡힌 후보로 나온다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findBalancedJsonCandidates,
  stripCodeFences,
} from '../src/server/promptsJsonExtract.ts';
import { extractLeaderPlan } from '../src/server/prompts.ts';

test('X1 · 앞 `{` 가 미닫힘이어도 뒤의 정상 JSON 후보를 찾는다 (EOF 회귀)', () => {
  const raw = '잘못된 앞: { 아직 닫히지 않았는데\n실제 응답: {"mode":"reply","tasks":[],"message":"ok"}';
  const c = findBalancedJsonCandidates(raw);
  // 뒤의 정상 블록이 반드시 후보에 포함되어야 한다. 과거 구현은 첫 `{` 미닫힘 뒤
  // 완전 종료(break)하여 빈 배열을 돌려주었다.
  const hasReply = c.some(x => x.includes('"reply"'));
  assert.ok(hasReply, `뒤 JSON 후보가 누락됨. 실제 후보: ${JSON.stringify(c)}`);
});

test('X1 · extractLeaderPlan 도 앞 미닫힘을 건너뛰고 뒤 블록을 채택한다', () => {
  const raw = '노이즈: { 닫히지 않는 기호들 [][\n최종: {"mode":"dispatch","tasks":[{"assignedTo":"a","description":"정리"}]}';
  const plan = extractLeaderPlan(raw);
  assert.ok(plan, 'plan 이 null 이면 안 된다');
  assert.equal(plan!.mode, 'dispatch');
  assert.equal(plan!.tasks.length, 1);
  assert.equal(plan!.tasks[0].assignedTo, 'a');
});

test('X2 · 앞에 UTF-8 BOM 이 붙어도 JSON 이 정상 파싱된다', () => {
  const raw = '\uFEFF{"mode":"reply","tasks":[],"message":"hi"}';
  const cleaned = stripCodeFences(raw);
  assert.ok(!cleaned.startsWith('\uFEFF'), 'BOM 이 제거되어야 한다');
  const plan = extractLeaderPlan(raw);
  assert.ok(plan);
  assert.equal(plan!.mode, 'reply');
  assert.equal(plan!.message, 'hi');
});

test('X3 · CRLF 개행 펜스도 깔끔히 제거되고 본문에 `\\r` 가 남지 않는다', () => {
  const raw = '설명\r\n```json\r\n{"mode":"reply","tasks":[],"message":"win"}\r\n```\r\n끝';
  const cleaned = stripCodeFences(raw);
  assert.ok(!cleaned.includes('\r'), `\\r 가 남아 있으면 안 된다: ${JSON.stringify(cleaned)}`);
  assert.ok(!cleaned.includes('```'));
  const plan = extractLeaderPlan(raw);
  assert.ok(plan);
  assert.equal(plan!.message, 'win');
});

test('X4 · 언어 태그에 `+`/`.` 이 포함돼도 펜스 전체가 제거된다', () => {
  for (const tag of ['json5', 'json+ld', 'application.json', 'x-json_5']) {
    const raw = '앞\n\`\`\`' + tag + '\n{"mode":"reply","tasks":[],"message":"t"}\n\`\`\`\n뒤';
    const cleaned = stripCodeFences(raw);
    assert.ok(!cleaned.includes('`'), `tag=${tag} 에서 펜스가 남음: ${JSON.stringify(cleaned)}`);
    assert.ok(!cleaned.includes(tag), `tag=${tag} 이 본문에 섞임: ${JSON.stringify(cleaned)}`);
    const plan = extractLeaderPlan(raw);
    assert.ok(plan, `tag=${tag} 에서 plan 이 null`);
    assert.equal(plan!.message, 't');
  }
});

test('X5 · 중첩 객체 + 배열 혼재 여러 블록이 각각 균형 후보로 나온다', () => {
  const raw = [
    '{"a":{"b":[1,2,3]}}',
    '설명 문장',
    '{"tasks":[{"assignedTo":"x","description":"y"}],"meta":{"v":1}}',
  ].join('\n');
  const c = findBalancedJsonCandidates(raw);
  assert.equal(c.length, 2, `두 개의 최상위 후보가 나와야 한다: ${JSON.stringify(c)}`);
  assert.ok(c[0].includes('"b":[1,2,3]'));
  assert.ok(c[1].includes('"tasks":'));
  for (const candidate of c) {
    assert.doesNotThrow(() => JSON.parse(candidate), `후보가 JSON 으로 파싱되어야 한다: ${candidate}`);
  }
});
