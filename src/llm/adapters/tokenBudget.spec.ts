// 지시 #89f4628d — vllm/ollama 어댑터 토큰 한도 모듈 회귀 스펙.
//
// 본 spec 은 `src/llm/adapters/tokenBudget.ts` 의 공개 계약을 고정한다.
//   · S1 모델 메타 표 lookup — 등록 모델 / 미등록 모델
//   · S2 estimateTokens — 빈 배열 / 단일 / 다중
//   · S3 truncateToBudget — 한도 이내면 무변경, 초과면 system·last user 보존, 슬라이딩 + 요약
//   · S4 summarize=false 옵션 — 슬라이딩만 동작, 요약 메시지 미삽입
//
// 실행: `npx tsx --test src/llm/adapters/tokenBudget.spec.ts`

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FALLBACK_MAX_INPUT_TOKENS,
  MODEL_TOKEN_LIMITS,
  estimateMessageTokens,
  estimateTokens,
  lookupMaxInputTokens,
  truncateToBudget,
  type AdapterMessage,
} from './tokenBudget';

describe('S1 모델 메타 표 lookup', () => {
  it('llama3:8b 는 8192, qwen2.5:7b 는 32768', () => {
    assert.equal(lookupMaxInputTokens('llama3:8b'), 8192);
    assert.equal(lookupMaxInputTokens('qwen2.5:7b'), 32768);
    assert.equal(MODEL_TOKEN_LIMITS['llama3:8b'].backend, 'ollama');
    assert.equal(MODEL_TOKEN_LIMITS['mixtral:8x7b'].backend, 'vllm');
  });

  it('미등록 모델은 fallback 값을 돌려준다', () => {
    assert.equal(lookupMaxInputTokens('unknown-model:42b'), FALLBACK_MAX_INPUT_TOKENS);
  });
});

describe('S2 estimateTokens', () => {
  it('빈 배열은 0', () => {
    assert.equal(estimateTokens([]), 0);
  });

  it('단일 메시지는 본문/4 + 6 오버헤드', () => {
    const msg: AdapterMessage = { role: 'user', content: 'a'.repeat(40) };
    // 40/4=10, +6 = 16
    assert.equal(estimateMessageTokens(msg), 16);
    assert.equal(estimateTokens([msg]), 16);
  });

  it('빈 content 도 오버헤드는 가산', () => {
    assert.equal(estimateMessageTokens({ role: 'system', content: '' }), 6);
  });
});

describe('S3 truncateToBudget — 보존 정책 + 슬라이딩 + 요약', () => {
  it('이미 한도 안이면 무변경 + withinBudget=true', () => {
    const msgs: AdapterMessage[] = [
      { role: 'system', content: '역할: 어시스턴트' },
      { role: 'user', content: '안녕' },
    ];
    const r = truncateToBudget(msgs, 'qwen2.5:7b');
    assert.equal(r.messages.length, 2);
    assert.equal(r.droppedCount, 0);
    assert.equal(r.summarizedCount, 0);
    assert.equal(r.withinBudget, true);
    assert.equal(r.maxInputTokens, 32768);
  });

  it('초과 시 system 과 마지막 user 는 보존되고 가장 오래된 turn 부터 줄어든다', () => {
    const big = 'x'.repeat(20_000); // 20000/4 = 5000 토큰
    const msgs: AdapterMessage[] = [
      { role: 'system', content: '시스템 프롬프트' },
      { role: 'user', content: big },
      { role: 'assistant', content: big },
      { role: 'user', content: big },
      { role: 'assistant', content: big },
      { role: 'user', content: '이번 턴 질문' },
    ];
    const r = truncateToBudget(msgs, 'llama3:8b'); // 8192 - 256 = 7936
    // system + 마지막 user 는 무조건 살아 있어야 함.
    assert.equal(r.messages[0].role, 'system');
    assert.equal(r.messages[0].content, '시스템 프롬프트');
    assert.equal(r.messages[r.messages.length - 1].role, 'user');
    assert.equal(r.messages[r.messages.length - 1].content, '이번 턴 질문');
    assert.equal(r.withinBudget, true);
    assert.ok(r.estimatedTokens <= 8192 - 256, '결과는 target 이하여야 한다');
    // 무엇이든 줄어들었어야 한다(중간 4턴 5000 토큰씩 = 20000+ 토큰을 8k 안에 못 담음).
    assert.ok(r.summarizedCount + r.droppedCount > 0, '중간 turn 이 줄어들어야 함');
  });

  it('summarize=true 이면 잘린 turn 이 요약 메시지로 압축된다', () => {
    const filler = 'y'.repeat(2_000); // 500 토큰
    const msgs: AdapterMessage[] = [
      { role: 'system', content: '역할' },
      { role: 'user', content: filler },
      { role: 'assistant', content: filler },
      { role: 'user', content: '최종 질문' },
    ];
    // 한도가 매우 작은 미등록 모델로 강제. fallback 4096 - headroom 256 = 3840 target.
    // filler 한 쌍이면 1000 토큰 정도. headroom 을 크게 줘 강제 압축 유도.
    const r = truncateToBudget(msgs, 'unknown:tiny', { headroomTokens: 3700 });
    // target = 4096 - 3700 = 396. 위 메시지로는 system + user 만 남기에도 빠듯.
    assert.equal(r.messages[0].role, 'system');
    assert.equal(r.messages[r.messages.length - 1].content, '최종 질문');
    // 어떤 형태로든 중간 2턴은 자취를 감춰야 한다.
    const middleContents = r.messages.slice(1, -1).map((m) => m.content);
    assert.ok(!middleContents.includes(filler), '큰 filler 가 그대로 살아있으면 안 된다');
  });

  it('summarize=false 면 요약 없이 슬라이딩만', () => {
    const filler = 'z'.repeat(2_000);
    const msgs: AdapterMessage[] = [
      { role: 'system', content: '역할' },
      { role: 'user', content: filler },
      { role: 'assistant', content: filler },
      { role: 'user', content: '최종' },
    ];
    const r = truncateToBudget(msgs, 'unknown:tiny', { headroomTokens: 3700, summarize: false });
    assert.equal(r.summarizedCount, 0);
    // 요약 마커 문자열이 결과 어디에도 등장하지 않아야 함.
    for (const m of r.messages) {
      assert.ok(!m.content.startsWith('[이전 '), '요약 메시지가 삽입되면 안 된다');
    }
  });
});
