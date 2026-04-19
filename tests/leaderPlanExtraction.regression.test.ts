// Run with: npx tsx --test tests/leaderPlanExtraction.regression.test.ts
//
// QA: `src/server/prompts.ts::extractLeaderPlan` 견고화(#50ad6e15) 회귀 테스트.
//
// 과거 구현은 `text.match(/\{[\s\S]*\}/)` greedy 정규식을 써서 세 가지 상황에서
// 조용히 null 을 돌려주었다. 본 테스트는 각 상황에서 파서가 **의도한 JSON 블록** 을
// 정확히 집어내는지 잠근다.
//
//   R1. ```json ... ``` 코드 펜스로 감싸진 응답
//   R2. 두 개 이상의 JSON 블록이 연달아 있는 응답(분배 예 + 답변 예)
//   R3. description 문자열 내부에 `}` 가 포함된 응답
//   R4. 앞뒤에 긴 자연어 설명이 붙은 응답
//   R5. JSON 이 깨진 경우 null 반환(조용한 실패)

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractLeaderPlan } from '../src/server/prompts.ts';
import {
  findBalancedJsonCandidates,
  stripCodeFences,
} from '../src/server/promptsJsonExtract.ts';

test('stripCodeFences — ```json ... ``` 을 깔끔히 제거한다', () => {
  const input = '설명\n```json\n{"mode":"reply","tasks":[],"message":"hi"}\n```\n끝';
  const out = stripCodeFences(input);
  assert.ok(out.includes('"mode":"reply"'));
  assert.ok(!out.includes('```'));
});

test('stripCodeFences — 언어 태그 없는 ``` 과 ~~~ 도 지원', () => {
  assert.ok(!stripCodeFences('```\n{}\n```').includes('`'));
  assert.ok(!stripCodeFences('~~~json\n{}\n~~~').includes('~'));
});

test('findBalancedJsonCandidates — 단일 JSON 하나를 돌려준다', () => {
  const c = findBalancedJsonCandidates('앞\n{"a":1}\n뒤');
  assert.deepEqual(c, ['{"a":1}']);
});

test('findBalancedJsonCandidates — 연달아 있는 두 JSON 을 각각 돌려준다 (과거 greedy 회귀 차단)', () => {
  const text = '분배 예: {"mode":"dispatch","tasks":[]} 답변 예: {"mode":"reply","tasks":[]}';
  const c = findBalancedJsonCandidates(text);
  assert.equal(c.length, 2);
  assert.ok(c[0].includes('dispatch'));
  assert.ok(c[1].includes('reply'));
});

test('findBalancedJsonCandidates — 중첩 객체는 바깥쪽만 후보로 돌려준다', () => {
  const c = findBalancedJsonCandidates('{"a":{"b":{"c":1}}}');
  assert.deepEqual(c, ['{"a":{"b":{"c":1}}}']);
});

test('findBalancedJsonCandidates — 문자열 안의 `}` 는 깊이 카운트에 영향을 주지 않는다', () => {
  const text = '{"description":"결과가 }; 처럼 보이는 문자열","tasks":[]}';
  const c = findBalancedJsonCandidates(text);
  assert.equal(c.length, 1);
  assert.equal(c[0], text);
});

test('findBalancedJsonCandidates — 이스케이프된 따옴표를 올바르게 다룬다', () => {
  const text = '{"description":"따옴표 \\" 안의 } 도 안전","tasks":[]}';
  const c = findBalancedJsonCandidates(text);
  assert.equal(c.length, 1);
  const parsed = JSON.parse(c[0]);
  assert.equal(parsed.description, '따옴표 " 안의 } 도 안전');
});

// ---------------------------------------------------------------------------
// R1 ~ R5 · extractLeaderPlan 최종 결과 계약
// ---------------------------------------------------------------------------

test('R1 — ```json 펜스 응답도 정상 파싱된다', () => {
  const raw = '간단한 브리핑입니다.\n```json\n{"mode":"dispatch","tasks":[{"assignedTo":"a1","description":"로그인 폼 구현"}],"message":"분배합니다"}\n```';
  const out = extractLeaderPlan(raw);
  assert.ok(out);
  assert.equal(out!.mode, 'dispatch');
  assert.equal(out!.tasks.length, 1);
  assert.equal(out!.tasks[0].assignedTo, 'a1');
  assert.equal(out!.message, '분배합니다');
});

test('R2 — 두 JSON 블록이 섞여 있으면 "리더 플랜 모양" 인 첫 번째 후보를 채택한다', () => {
  // 앞에 "관련 없는" JSON 이 먼저 오더라도(예: 예시 스키마) 리더 플랜 모양(mode/tasks/message
  // 중 하나 이상 포함) 인 첫 후보가 채택된다. 과거 구현은 두 블록을 이어붙인 잘못된
  // 문자열을 JSON.parse 해 null 을 반환했다.
  const raw = '예시 스키마: {"schema":"v1"}\n실제 응답: {"mode":"reply","tasks":[],"message":"현재 진행 중"}';
  const out = extractLeaderPlan(raw);
  assert.ok(out);
  assert.equal(out!.mode, 'reply');
  assert.equal(out!.message, '현재 진행 중');
});

test('R2 회귀 — 둘 다 리더 플랜 모양이면 먼저 등장한 블록을 채택한다', () => {
  const raw = '{"mode":"dispatch","tasks":[{"assignedTo":"a","description":"작업"}]}\n{"mode":"reply","tasks":[],"message":"다음"}';
  const out = extractLeaderPlan(raw);
  assert.ok(out);
  assert.equal(out!.mode, 'dispatch');
  assert.equal(out!.tasks.length, 1);
});

test('R3 — description 내부에 `}` 가 들어와도 균형 스캐너가 정확히 잡는다', () => {
  const raw = '응답: {"mode":"dispatch","tasks":[{"assignedTo":"a","description":"if (x) { return; } 블록을 정리"}],"message":"정리"}';
  const out = extractLeaderPlan(raw);
  assert.ok(out);
  assert.equal(out!.tasks.length, 1);
  assert.match(out!.tasks[0].description, /return;/);
});

test('R4 — 앞뒤 자연어 서술이 붙은 경우에도 JSON 만 추출한다', () => {
  const raw = [
    '리더의 판단 요약: 현재 팀원 3명이 idle 이므로 분배합니다.',
    '아래는 분배 결과:',
    '{"mode":"dispatch","tasks":[{"assignedTo":"b","description":"파싱 버그 수정"}],"message":"분배 완료"}',
    '추가 설명: 이 분배는 다음 틱에 반영됩니다.',
  ].join('\n');
  const out = extractLeaderPlan(raw);
  assert.ok(out);
  assert.equal(out!.mode, 'dispatch');
  assert.equal(out!.tasks[0].assignedTo, 'b');
});

test('R5 — JSON 이 전혀 없거나 모두 깨진 경우 null 을 돌려준다(조용한 실패)', () => {
  assert.equal(extractLeaderPlan(''), null);
  assert.equal(extractLeaderPlan('JSON 이 하나도 없는 문장'), null);
  assert.equal(extractLeaderPlan('{ 깨진: json }'), null);
});

test('R5 회귀 — 리더 플랜 모양이 아닌 JSON 블록만 있으면 null', () => {
  const raw = '메타: {"schema":"v1","version":3}';
  assert.equal(extractLeaderPlan(raw), null);
});

// ---------------------------------------------------------------------------
// 하위 호환 — leaderDispatch.test.ts 의 기본 시나리오와 동일한 응답 형식이 변함없이 파싱.
// ---------------------------------------------------------------------------

test('하위호환 — 단순 dispatch 응답', () => {
  const raw = '{"mode":"dispatch","tasks":[{"assignedTo":"dev-1","description":"로그인 폼의 유효성 검증 함수 추가"}],"message":"분배합니다"}';
  const out = extractLeaderPlan(raw);
  assert.ok(out);
  assert.equal(out!.mode, 'dispatch');
  assert.equal(out!.tasks.length, 1);
});

test('하위호환 — mode 누락 시 tasks 길이로 추정', () => {
  assert.equal(extractLeaderPlan('{"tasks":[],"message":"진행 중"}')!.mode, 'reply');
  assert.equal(extractLeaderPlan('{"tasks":[{"assignedTo":"a","description":"x"}]}')!.mode, 'dispatch');
});

test('하위호환 — 빈 객체 `{}` 는 파싱 성공 후 reply 로 복원된다', () => {
  // 과거 leaderDispatch.test.ts:247 의 계약 — `{}` 는 tasks=[] + mode=reply 로 귀결.
  // 식별 휴리스틱에 "빈 객체 허용" 예외를 둬 이 계약을 유지한다.
  const out = extractLeaderPlan('{}');
  assert.ok(out);
  assert.equal(out!.mode, 'reply');
  assert.deepEqual(out!.tasks, []);
  assert.equal(out!.message, undefined);
});

// ---------------------------------------------------------------------------
// R6 · 빈 객체 선행 시 명시적 후보 우선 채택 (지시 #08730f76 회귀 보강)
// ---------------------------------------------------------------------------

test('R6 — `{}` 가 앞에 있고 뒤에 명시적 리더 플랜이 있으면 뒤 블록을 채택한다', () => {
  const raw = '사전 객체: {}\n실제 응답: {"mode":"dispatch","tasks":[{"assignedTo":"dev-2","description":"토큰 위젯 합류"}],"message":"분배"}';
  const out = extractLeaderPlan(raw);
  assert.ok(out);
  assert.equal(out!.mode, 'dispatch');
  assert.equal(out!.tasks.length, 1);
  assert.equal(out!.tasks[0].assignedTo, 'dev-2');
});

test('R6 — 명시적 후보가 전혀 없고 `{}` 만 있으면 하위호환대로 reply fallback', () => {
  const raw = '앞: {} 뒤: {}';
  const out = extractLeaderPlan(raw);
  assert.ok(out, 'fallback 경로에서 null 이면 안 된다');
  assert.equal(out!.mode, 'reply');
  assert.deepEqual(out!.tasks, []);
});

// ---------------------------------------------------------------------------
// R7 · normalizeLeaderPlan 의 공백 필터 + 빈 메시지 승격
// ---------------------------------------------------------------------------

test('R7 — tasks 항목 중 assignedTo/description 이 공백이면 제거된다', () => {
  const raw = '{"mode":"dispatch","tasks":[' +
    '{"assignedTo":"   ","description":"정상 설명이지만 수신자 공백"},' +
    '{"assignedTo":"dev-1","description":"   "},' +
    '{"assignedTo":"dev-2","description":"유효한 태스크"}' +
  ']}';
  const out = extractLeaderPlan(raw);
  assert.ok(out);
  assert.equal(out!.tasks.length, 1, '공백 assignedTo / 공백 description 은 필터링');
  assert.equal(out!.tasks[0].assignedTo, 'dev-2');
});

test('R7 — tasks 항목이 전부 공백으로 필터링되면 mode 가 reply 로 전환된다', () => {
  const raw = '{"tasks":[{"assignedTo":"   ","description":"   "}]}';
  const out = extractLeaderPlan(raw);
  assert.ok(out);
  assert.equal(out!.mode, 'reply', 'mode 미지정 + 유효 tasks 0 → reply');
  assert.deepEqual(out!.tasks, []);
});

test('R7 — message 가 빈 문자열/공백이면 undefined 로 승격된다', () => {
  const a = extractLeaderPlan('{"mode":"reply","tasks":[],"message":""}');
  assert.ok(a);
  assert.equal(a!.message, undefined, '빈 문자열 → undefined');
  const b = extractLeaderPlan('{"mode":"reply","tasks":[],"message":"   \\n\\t "}');
  assert.ok(b);
  assert.equal(b!.message, undefined, '공백·탭·개행만 → undefined');
  // 정상 메시지는 그대로 유지
  const c = extractLeaderPlan('{"mode":"reply","tasks":[],"message":"진행 중입니다"}');
  assert.ok(c);
  assert.equal(c!.message, '진행 중입니다');
});
