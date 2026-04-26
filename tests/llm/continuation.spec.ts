// Run with: npx tsx --test tests/llm/continuation.spec.ts
//
// 지시 #e4c60f64 — `finish_reason='length'` 발생 시 자동 이어쓰기(continuation)
// 회귀 스펙. 토큰 한도에 걸려 응답이 잘렸을 때, 호출자가 후속 호출을 자동으로
// 띄워 컨텍스트를 이어붙이는 흐름을 잠근다.
//
// 본 스펙도 자급자족(self-contained) — 참조 구현을 inline 으로 포함한다. dev 가
// `src/llm/continuation.ts` 로 추출하면 import 만 바꿔 동일 테스트로 회귀 감시.
//
// 축
//   C1. finish_reason !== 'length' — 즉시 종료, rounds=1, content 보존.
//   C2. finish_reason === 'length' 1회 — 1차 이어쓰기 후 정상 결합.
//   C3. 연속 length — maxRounds 까지 이어 붙이고 한도 도달 시 마지막 finishReason 반환.
//   C4. 결합 시 joiner — 기본 빈 문자열, 명시적 joiner 가 있으면 그대로 사용.
//   C5. fetchNext 인자(state) — accumulated · round 를 회차마다 정확히 전달.
//   C6. 모델별 한도 매트릭스(llama3:8b/qwen2.5:7b/mistral:7b) — 같은 시나리오를
//       세 모델 한도로 파라미터화해 회귀 출처를 즉시 식별.

import test from 'node:test';
import assert from 'node:assert/strict';

// ────────────────────────────────────────────────────────────────────────────
// 참조 구현 — dev 추출 시 src/llm/continuation.ts 로 이동 예정
// ────────────────────────────────────────────────────────────────────────────

type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | (string & {});

interface CompletionResult {
  readonly content: string;
  readonly finishReason: FinishReason;
  readonly tokensUsed?: number;
}

interface ContinuationState {
  readonly accumulated: string;
  readonly round: number; // 1 = 첫 이어쓰기 호출(initial 이후)
}

interface ContinuationOptions {
  /** 최대 라운드 수(initial 호출 포함). 기본 4 — initial + 3 회 연장. */
  readonly maxRounds?: number;
  /** 텍스트 결합자. 기본 ''. */
  readonly joiner?: string;
}

interface ContinuationResult {
  readonly content: string;
  readonly rounds: number; // 실제 수행된 호출 수(initial 포함)
  readonly finishReason: FinishReason;
  readonly capped: boolean; // maxRounds 한도로 종료됐는지
}

async function continueOnLengthFinish(
  initial: CompletionResult,
  fetchNext: (state: ContinuationState) => Promise<CompletionResult>,
  options: ContinuationOptions = {},
): Promise<ContinuationResult> {
  const maxRounds = Math.max(1, options.maxRounds ?? 4);
  const joiner = options.joiner ?? '';
  let accumulated = initial.content;
  let last = initial;
  let rounds = 1;
  while (last.finishReason === 'length' && rounds < maxRounds) {
    const next = await fetchNext({ accumulated, round: rounds });
    accumulated = `${accumulated}${joiner}${next.content}`;
    last = next;
    rounds += 1;
  }
  return {
    content: accumulated,
    rounds,
    finishReason: last.finishReason,
    capped: rounds >= maxRounds && last.finishReason === 'length',
  };
}

const MODEL_TOKEN_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  'llama3:8b': 8_192,
  'qwen2.5:7b': 32_768,
  'mistral:7b': 8_192,
});

// ────────────────────────────────────────────────────────────────────────────
// C1. finish_reason !== 'length' — 즉시 종료
// ────────────────────────────────────────────────────────────────────────────

test('C1-1. finish_reason="stop" — 이어쓰기 미호출, rounds=1', async () => {
  let calls = 0;
  const result = await continueOnLengthFinish(
    { content: '완성된 답', finishReason: 'stop' },
    async () => { calls += 1; return { content: '!', finishReason: 'stop' }; },
  );
  assert.equal(result.content, '완성된 답');
  assert.equal(result.rounds, 1);
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.capped, false);
  assert.equal(calls, 0, 'fetchNext 가 호출되지 않아야 한다');
});

test('C1-2. finish_reason="tool_calls" — 도구 호출은 이어쓰기 대상이 아니다', async () => {
  let calls = 0;
  const result = await continueOnLengthFinish(
    { content: '', finishReason: 'tool_calls' },
    async () => { calls += 1; return { content: '', finishReason: 'stop' }; },
  );
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(calls, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// C2. 1회 length — 1차 이어쓰기 후 결합
// ────────────────────────────────────────────────────────────────────────────

test('C2-1. length → stop — 두 조각이 순서대로 결합되고 finishReason="stop"', async () => {
  const result = await continueOnLengthFinish(
    { content: '앞부분', finishReason: 'length' },
    async () => ({ content: '뒷부분', finishReason: 'stop' }),
  );
  assert.equal(result.content, '앞부분뒷부분');
  assert.equal(result.rounds, 2);
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.capped, false);
});

test('C2-2. tokensUsed 합산은 호출자 책임 — 본 함수는 텍스트만 결합', async () => {
  const result = await continueOnLengthFinish(
    { content: 'A', finishReason: 'length', tokensUsed: 100 },
    async () => ({ content: 'B', finishReason: 'stop', tokensUsed: 200 }),
  );
  assert.equal(result.content, 'AB');
  // 결과 타입에 tokensUsed 가 없는 것을 명시적으로 확인 — 합산 로직 비포함.
  assert.equal((result as unknown as { tokensUsed?: number }).tokensUsed, undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// C3. 연속 length — maxRounds 한도
// ────────────────────────────────────────────────────────────────────────────

test('C3-1. 연속 length 가 maxRounds 까지 — 마지막 finishReason="length", capped=true', async () => {
  const responses: CompletionResult[] = [
    { content: '두번째', finishReason: 'length' },
    { content: '세번째', finishReason: 'length' },
    { content: '네번째', finishReason: 'length' },
  ];
  let i = 0;
  const result = await continueOnLengthFinish(
    { content: '첫번째', finishReason: 'length' },
    async () => responses[i++],
    { maxRounds: 4 },
  );
  assert.equal(result.content, '첫번째두번째세번째네번째');
  assert.equal(result.rounds, 4);
  assert.equal(result.finishReason, 'length');
  assert.equal(result.capped, true);
  assert.equal(i, 3, 'fetchNext 가 정확히 3회 호출(initial 제외)');
});

test('C3-2. 중간에 stop 으로 끝나면 즉시 종료(capped=false)', async () => {
  const responses: CompletionResult[] = [
    { content: 'B', finishReason: 'length' },
    { content: 'C', finishReason: 'stop' },
    { content: 'NEVER', finishReason: 'length' }, // 호출되면 안 됨
  ];
  let i = 0;
  const result = await continueOnLengthFinish(
    { content: 'A', finishReason: 'length' },
    async () => responses[i++],
    { maxRounds: 5 },
  );
  assert.equal(result.content, 'ABC');
  assert.equal(result.rounds, 3);
  assert.equal(result.capped, false);
  assert.equal(i, 2, 'stop 직후 더 이상 호출하지 않는다');
});

test('C3-3. maxRounds=1 — 이어쓰기 비활성, length 여도 그대로 반환', async () => {
  let calls = 0;
  const result = await continueOnLengthFinish(
    { content: '잘림', finishReason: 'length' },
    async () => { calls += 1; return { content: 'x', finishReason: 'stop' }; },
    { maxRounds: 1 },
  );
  assert.equal(result.content, '잘림');
  assert.equal(result.rounds, 1);
  assert.equal(result.capped, true);
  assert.equal(calls, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// C4. joiner — 결합자 동작
// ────────────────────────────────────────────────────────────────────────────

test('C4-1. 기본 joiner="" — 공백 없이 직접 결합', async () => {
  const result = await continueOnLengthFinish(
    { content: '앞', finishReason: 'length' },
    async () => ({ content: '뒤', finishReason: 'stop' }),
  );
  assert.equal(result.content, '앞뒤');
});

test('C4-2. joiner="\\n" 명시 — 라운드 사이 줄바꿈 삽입', async () => {
  const responses: CompletionResult[] = [
    { content: 'B', finishReason: 'length' },
    { content: 'C', finishReason: 'stop' },
  ];
  let i = 0;
  const result = await continueOnLengthFinish(
    { content: 'A', finishReason: 'length' },
    async () => responses[i++],
    { joiner: '\n' },
  );
  assert.equal(result.content, 'A\nB\nC');
});

// ────────────────────────────────────────────────────────────────────────────
// C5. fetchNext 인자 — accumulated · round 정확 전달
// ────────────────────────────────────────────────────────────────────────────

test('C5-1. round 는 1 부터 시작해 라운드마다 +1, accumulated 는 직전까지 결합본', async () => {
  const seen: ContinuationState[] = [];
  const responses: CompletionResult[] = [
    { content: 'B', finishReason: 'length' },
    { content: 'C', finishReason: 'length' },
    { content: 'D', finishReason: 'stop' },
  ];
  let i = 0;
  await continueOnLengthFinish(
    { content: 'A', finishReason: 'length' },
    async (state) => { seen.push(state); return responses[i++]; },
    { maxRounds: 5 },
  );
  assert.deepEqual(seen, [
    { accumulated: 'A', round: 1 },
    { accumulated: 'AB', round: 2 },
    { accumulated: 'ABC', round: 3 },
  ]);
});

// ────────────────────────────────────────────────────────────────────────────
// C6. 모델별 한도 매트릭스 — 한 시나리오를 세 모델로 파라미터화
// ────────────────────────────────────────────────────────────────────────────
//
// 시나리오: 모델 한도가 N 이라면, 첫 응답이 한도에 걸려 length 로 잘리고,
// 이어쓰기 1회로 합쳐 정확히 N 토큰 만큼의 텍스트를 모은다. 같은 fetchNext
// 흐름이 모델 한도 차이와 무관하게 동작함을 잠근다.

for (const [model, limit] of Object.entries(MODEL_TOKEN_LIMITS)) {
  test(`C6-1[${model}]. 한도 ${limit} — length 1회 → stop, 결합 길이 ${limit}자`, async () => {
    const half = Math.floor(limit / 2);
    const remainder = limit - half;
    const result = await continueOnLengthFinish(
      { content: 'x'.repeat(half), finishReason: 'length' },
      async () => ({ content: 'x'.repeat(remainder), finishReason: 'stop' }),
    );
    assert.equal(result.content.length, limit, `${model}: 결합 후 길이`);
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.capped, false);
    assert.equal(result.rounds, 2);
  });

  test(`C6-2[${model}]. 한도 ${limit} — 연속 length 가 maxRounds=2 에 걸려 capped=true`, async () => {
    const piece = 'y'.repeat(Math.floor(limit / 4));
    const result = await continueOnLengthFinish(
      { content: piece, finishReason: 'length' },
      async () => ({ content: piece, finishReason: 'length' }),
      { maxRounds: 2 },
    );
    assert.equal(result.rounds, 2);
    assert.equal(result.finishReason, 'length');
    assert.equal(result.capped, true, `${model}: maxRounds 한도 도달`);
    assert.equal(result.content.length, piece.length * 2);
  });
}
