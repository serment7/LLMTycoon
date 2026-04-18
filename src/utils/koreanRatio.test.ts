// Run with: npx tsx --test src/utils/koreanRatio.test.ts
//
// QA: koreanRatio 유틸의 순수 함수 계약을 고정한다.
// agentWorker 가 매 턴 결과 텍스트를 이 유틸로 검증하므로,
//  (1) 코드·식별자·경로·URL 을 제거한 뒤의 한글/영문 비율 계산
//  (2) 짧은 표본에 대한 통과 규칙
//  (3) 리더 JSON 응답에서 message/description 만 추려내는 샘플러
// 세 축이 전부 깨지지 않도록 지킨다.
//
// stripCodeAndIdentifiers 가 영문 덩어리를 과다/과소 제거하면 isMostlyKorean
// 가 false-positive 혹은 false-negative 를 내고, 결국 경고 로그가 잘못 터지거나
// 아예 터지지 않게 된다 — 두 방향을 모두 커버한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_KOREAN_THRESHOLD,
  MIN_KOREAN_SAMPLE_LENGTH,
  collectNaturalLanguageSample,
  isMostlyKorean,
  koreanRatio,
  stripCodeAndIdentifiers,
} from './koreanRatio.ts';

// ---------------------------------------------------------------------------
// koreanRatio — 한글/(한글+영문) 비율.
// ---------------------------------------------------------------------------

test('koreanRatio: 빈 입력은 0', () => {
  assert.equal(koreanRatio(''), 0);
  // null/undefined 도 방어적으로 0 — agentWorker 가 empty result 를 넘길 수 있다.
  assert.equal(koreanRatio(undefined as unknown as string), 0);
  assert.equal(koreanRatio(null as unknown as string), 0);
});

test('koreanRatio: 순수 한글 문장은 1', () => {
  assert.equal(koreanRatio('안녕하세요 반갑습니다'), 1);
});

test('koreanRatio: 순수 영문 문장은 0', () => {
  assert.equal(koreanRatio('hello world this is english'), 0);
});

test('koreanRatio: 혼합 문장은 (한글)/(한글+영문) 로 계산된다', () => {
  // "안녕" 2자 + "hi" 2자 → 2/4 = 0.5.
  const r = koreanRatio('안녕 hi');
  assert.equal(r, 0.5);
});

test('koreanRatio: 코드 블록·인라인 코드는 계산에서 제외된다', () => {
  // 영문 코드가 안에 있어도 한국어 비율을 낮추면 안 된다.
  const text = '다음 코드를 참고하세요 ```const foo = bar();``` 입니다';
  assert.equal(koreanRatio(text), 1);
});

test('koreanRatio: URL 과 파일 경로는 비율 계산에서 제외된다', () => {
  const text = '자세한 내용은 https://example.com/docs 의 src/utils/koreanRatio.ts 참고';
  // URL·경로 제거 후 "자세한 내용은 의 참고" 만 남음 → 한글 100%.
  assert.equal(koreanRatio(text), 1);
});

test('koreanRatio: camelCase/PascalCase/snake_case 식별자는 제외된다', () => {
  const text = 'agentWorker 와 AgentContextBubble 과 some_snake 를 호출';
  // 식별자 토큰 제거 후 한글만 남으므로 1.
  assert.equal(koreanRatio(text), 1);
});

test('koreanRatio: 소문자 단일 영단어("hello") 는 제외되지 않는다 — 영어 회귀를 잡기 위함', () => {
  // camelCase 패턴이 아닌 평범한 영어 단어는 strip 대상이 아니어야 한다.
  // 그렇지 않으면 순수 영문 응답이 한글 100% 로 잘못 잡힌다.
  const r = koreanRatio('hello world');
  assert.equal(r, 0);
});

// ---------------------------------------------------------------------------
// stripCodeAndIdentifiers — 필터 단계별 회귀 고정.
// ---------------------------------------------------------------------------

test('stripCodeAndIdentifiers: 펜스 코드블록을 통째로 공백화', () => {
  const out = stripCodeAndIdentifiers('앞 ```foo bar``` 뒤');
  assert.match(out, /앞\s+\s+뒤/);
  assert.ok(!out.includes('foo'));
  assert.ok(!out.includes('bar'));
});

test('stripCodeAndIdentifiers: 인라인 코드 백틱은 개별적으로 제거', () => {
  const out = stripCodeAndIdentifiers('인라인 `inline_code` 테스트');
  assert.ok(!out.includes('inline'));
});

test('stripCodeAndIdentifiers: 윈도우 경로(C:\\...) 제거', () => {
  const out = stripCodeAndIdentifiers('경로 C:\\Users\\foo\\bar.ts 참고');
  assert.ok(!out.includes('Users'));
  assert.ok(!out.includes('bar.ts'));
});

test('stripCodeAndIdentifiers: 점 표기 식별자(foo.bar.baz) 제거', () => {
  const out = stripCodeAndIdentifiers('객체 foo.bar.baz 호출');
  assert.ok(!out.includes('foo.bar.baz'));
});

test('stripCodeAndIdentifiers: 빈 입력은 빈 문자열', () => {
  assert.equal(stripCodeAndIdentifiers(''), '');
  assert.equal(stripCodeAndIdentifiers(undefined as unknown as string), '');
});

// ---------------------------------------------------------------------------
// isMostlyKorean — 임계값 통과 판정 + 짧은 표본 예외.
// ---------------------------------------------------------------------------

test('isMostlyKorean: 빈 입력은 true — 검증할 본문이 없으면 통과로 취급', () => {
  assert.equal(isMostlyKorean(''), true);
});

test('isMostlyKorean: 짧은 표본(16자 미만)은 항상 true', () => {
  // "ok" 같은 한 단어 응답에 false 를 내리면 흐름이 막힌다 — false-positive 방지.
  assert.equal(isMostlyKorean('ok'), true);
  assert.equal(isMostlyKorean('hi there'), true);
});

test('isMostlyKorean: 긴 순수 영문 응답은 false — 경고 경로가 작동해야 한다', () => {
  const text =
    'this is a long english only response that should definitely trip the korean ratio check';
  assert.equal(isMostlyKorean(text), false);
});

test('isMostlyKorean: 긴 순수 한글 응답은 true', () => {
  const text = '이번 턴에 변경한 파일과 의존성은 모두 코드그래프에 반영했습니다 확인 부탁드립니다';
  assert.equal(isMostlyKorean(text), true);
});

test('isMostlyKorean: 임계값을 조정하면 경계에서 동작이 달라진다', () => {
  // 한글 4자 + 영문 6자 → 비율 0.4. 기본 threshold(0.4) 에선 통과.
  // 하지만 strip 단계가 걸러주는 토큰이 있으므로, 혼합 비율만 보려면 평문을 쓴다.
  const text = '가나다라 abcdef 를 처리합니다 fallback cache reset done';
  // 기본 임계치보다 높은 값(0.9) 로는 실패해야 한다.
  assert.equal(isMostlyKorean(text, 0.9), false);
});

test('DEFAULT_KOREAN_THRESHOLD: 0 초과 1 이하 — 의미 있는 비율 범위', () => {
  // 상수가 0이 되면 모든 응답이 통과, 1 초과면 항상 실패. 회귀 방지용 가드.
  assert.ok(DEFAULT_KOREAN_THRESHOLD > 0);
  assert.ok(DEFAULT_KOREAN_THRESHOLD <= 1);
});

test('isMostlyKorean: 구두점/숫자/이모지만 있어 언어 신호가 없으면 true — 분모 0 오경고 방지', () => {
  // 과거에는 한글·영문이 하나도 없으면 비율 0 으로 계산되어 임계값 미만 → false 로
  // 떨어졌다. 결과적으로 "!!!!!!!!!" 같은 응답에 잘못된 경고가 박혔다.
  assert.equal(isMostlyKorean('!'.repeat(40)), true);
  assert.equal(isMostlyKorean('1234567890 9876543210 13579'), true);
  // 이모지 연속 — 언어 신호 없음.
  assert.equal(isMostlyKorean('🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂'), true);
});

test('koreanRatio: 한글 호환 자모(ㅋ/ㅎ)도 한글로 집계된다', () => {
  // "ㅋㅋㅋ" 같은 자모-only 표현이 0 으로 잡히면 순수 자모 응답이 영어 회귀로
  // 잘못 분류된다. 자모도 한국어 신호로 본다.
  assert.equal(koreanRatio('ㅋㅋㅋ'), 1);
  // 혼합: "ㅋㅋㅋ" 3 + "hi" 2 → 3/5 = 0.6.
  assert.equal(koreanRatio('ㅋㅋㅋ hi'), 0.6);
});

test('isMostlyKorean: 자모만 긴 응답도 한국어로 통과', () => {
  // 16자 이상의 자모 스트리밍도 경고로 막히지 않는다.
  assert.equal(isMostlyKorean('ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ'), true);
});

test('MIN_KOREAN_SAMPLE_LENGTH: 경계 — 샘플 길이가 기준 미만이면 항상 통과', () => {
  // 상수가 export 되지 않으면 경계 테스트 자체가 흔들린다 — 노출 자체를 고정.
  assert.ok(MIN_KOREAN_SAMPLE_LENGTH >= 8);
  const below = 'a'.repeat(MIN_KOREAN_SAMPLE_LENGTH - 1);
  const atOrAbove = 'a'.repeat(MIN_KOREAN_SAMPLE_LENGTH);
  assert.equal(isMostlyKorean(below), true);
  // 기준 이상이면 비율 검사가 동작해 영문은 false.
  assert.equal(isMostlyKorean(atOrAbove), false);
});

// ---------------------------------------------------------------------------
// collectNaturalLanguageSample — 리더 JSON 에서 자연어만 추림.
// ---------------------------------------------------------------------------

test('collectNaturalLanguageSample: JSON 이 아니면 원문 그대로', () => {
  const text = '그냥 자연어 문장';
  assert.equal(collectNaturalLanguageSample(text), text);
});

test('collectNaturalLanguageSample: 빈 입력은 빈 문자열', () => {
  assert.equal(collectNaturalLanguageSample(''), '');
});

test('collectNaturalLanguageSample: tasks[].description 과 message 만 합쳐 반환', () => {
  const raw = JSON.stringify({
    mode: 'dispatch',
    tasks: [
      { assignedTo: 'dev-1', description: '첫 번째 업무 설명' },
      { assignedTo: 'qa-1', description: '두 번째 업무 설명' },
    ],
    message: '이번 턴 헤드라인',
  });
  const sample = collectNaturalLanguageSample(raw);
  // JSON 키(assignedTo/mode 등) 는 샘플에 포함되지 않아야 한다 —
  // 키 자체가 영문이라는 이유로 한국어 비율이 잘못 떨어지는 것을 막기 위함.
  assert.ok(!sample.includes('assignedTo'));
  assert.ok(!sample.includes('mode'));
  assert.ok(sample.includes('이번 턴 헤드라인'));
  assert.ok(sample.includes('첫 번째 업무 설명'));
  assert.ok(sample.includes('두 번째 업무 설명'));
});

test('collectNaturalLanguageSample: message 만 있고 tasks 는 비어도 동작', () => {
  const raw = JSON.stringify({ tasks: [], message: '답변만 드립니다' });
  const sample = collectNaturalLanguageSample(raw);
  assert.equal(sample.trim(), '답변만 드립니다');
});

test('collectNaturalLanguageSample: 유효 JSON 이지만 message/tasks 모두 없으면 원문 폴백', () => {
  const raw = JSON.stringify({ unrelated: 'value' });
  assert.equal(collectNaturalLanguageSample(raw), raw);
});

test('collectNaturalLanguageSample: 파싱 실패 시 원문 그대로', () => {
  const raw = '{ not really json }';
  assert.equal(collectNaturalLanguageSample(raw), raw);
});

// ---------------------------------------------------------------------------
// 통합 — agentWorker 의 검증 경로 그대로 재현.
// ---------------------------------------------------------------------------

test('통합: 리더 JSON 응답이 자연어는 한국어이고 JSON 키만 영문이라면 isMostlyKorean=true', () => {
  const raw = JSON.stringify({
    mode: 'reply',
    tasks: [],
    message: '현재 상태는 모든 팀원이 대기 중이며 이번 턴에는 분배할 업무가 없습니다',
  });
  const sample = collectNaturalLanguageSample(raw);
  assert.equal(isMostlyKorean(sample), true);
});

test('통합: 리더 JSON 의 description 이 전부 영문이면 isMostlyKorean=false → 경고 경로', () => {
  const raw = JSON.stringify({
    mode: 'dispatch',
    tasks: [
      { assignedTo: 'dev-1', description: 'refactor login form validation hooks and error states' },
      { assignedTo: 'qa-1', description: 'extend qa scenarios to cover locked accounts and retries' },
    ],
    message: 'distribute login improvements across the team members now',
  });
  const sample = collectNaturalLanguageSample(raw);
  assert.equal(isMostlyKorean(sample), false);
});
