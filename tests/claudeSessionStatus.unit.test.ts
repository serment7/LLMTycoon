// Run with: npx tsx --test tests/claudeSessionStatus.unit.test.ts
//
// 단위 테스트: 구독 세션 폴백(#cdaaabf3) 축의 네 모듈 계약.
//  1) claudeClient · onTokenExhausted / emitTokenExhausted 이벤트 버스
//  2) claudeTokenUsageStore · sessionStatus 필드와 setSessionStatus 액션
//  3) agentWorker · setAgentWorkerSessionStatus 가드 (exhausted → 새 enqueue 는 거부)
//  4) 위 세 축이 같은 ClaudeSessionStatus 타입을 공유함을 확인
//
// UI 배너와 DirectivePrompt/SharedGoalForm 의 readOnly 가드는 별도 regression 에서
// 잠근다(본 파일은 서버·스토어 순수 로직에 집중).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  emitTokenExhausted,
  onTokenExhausted,
  resetTokenExhaustedListeners,
  type TokenExhaustedEvent,
} from '../src/server/claudeClient.ts';
import {
  claudeTokenUsageStore,
  setSessionStatusInState,
} from '../src/utils/claudeTokenUsageStore.ts';
import {
  AgentWorker,
  setAgentWorkerSessionStatus,
  getAgentWorkerSessionStatus,
  WORKER_SESSION_EXHAUSTED_MESSAGE,
} from '../src/server/agentWorker.ts';
import type { ClaudeSessionStatus } from '../src/types.ts';
import { CLAUDE_SESSION_STATUSES } from '../src/types.ts';

// ─── claudeClient 이벤트 버스 ───────────────────────────────────────────────

test('onTokenExhausted — token_exhausted 이벤트를 구독자 전원에게 방송한다', () => {
  resetTokenExhaustedListeners();
  const received: TokenExhaustedEvent[] = [];
  const off = onTokenExhausted((e) => received.push(e));
  emitTokenExhausted({ category: 'token_exhausted', message: '토큰 소진' });
  assert.equal(received.length, 1);
  assert.equal(received[0].category, 'token_exhausted');
  assert.equal(received[0].message, '토큰 소진');
  assert.ok(typeof received[0].at === 'string' && received[0].at.length > 0);
  off();
  resetTokenExhaustedListeners();
});

test('emitTokenExhausted — token_exhausted / subscription_expired 외 카테고리는 무시', () => {
  resetTokenExhaustedListeners();
  let hits = 0;
  onTokenExhausted(() => { hits++; });
  // 의도적 오카테고리 주입(런타임 가드 검증). 공개 타입이 ClaudeErrorCategory 이므로
  // rate_limit 자체는 허용 타입이지만, 본 이벤트는 두 폴백 카테고리만 수용해야 한다.
  emitTokenExhausted({ category: 'rate_limit', message: 'nope' });
  assert.equal(hits, 0);
  emitTokenExhausted({ category: 'subscription_expired', message: '구독 만료' });
  assert.equal(hits, 1);
  resetTokenExhaustedListeners();
});

test('emitTokenExhausted — 개별 리스너 실패는 격리되어 나머지 구독자가 계속 수신', () => {
  resetTokenExhaustedListeners();
  const received: string[] = [];
  onTokenExhausted(() => { throw new Error('boom'); });
  onTokenExhausted((e) => received.push(e.category));
  emitTokenExhausted({ category: 'token_exhausted', message: '' });
  assert.deepEqual(received, ['token_exhausted']);
  resetTokenExhaustedListeners();
});

// ─── claudeTokenUsageStore.sessionStatus ────────────────────────────────────

test('setSessionStatusInState — 동일 상태+사유면 참조가 동일(불변 최적화)', () => {
  const base = { sessionStatus: 'active', sessionStatusReason: undefined } as any;
  const next = setSessionStatusInState(base, 'active', undefined);
  assert.strictEqual(next, base);
});

test('setSessionStatusInState — 서로 다른 상태면 새 참조 + 필드 교체', () => {
  // 얕은 복사 계약을 확인하기 위해 임의 키 `marker` 를 붙인 느슨한 객체를 쓴다.
  const base = {
    sessionStatus: 'active' as ClaudeSessionStatus,
    sessionStatusReason: undefined,
    marker: 1,
  } as unknown as Parameters<typeof setSessionStatusInState>[0];
  const next = setSessionStatusInState(base, 'exhausted', '구독 만료');
  assert.notStrictEqual(next, base);
  assert.equal(next.sessionStatus, 'exhausted');
  assert.equal(next.sessionStatusReason, '구독 만료');
  // 다른 필드는 그대로 승계(얕은 복사).
  assert.equal((next as unknown as { marker: number }).marker, 1);
});

test('claudeTokenUsageStore — setSessionStatus 액션이 스냅샷에 반영된다', () => {
  // 테스트 영향 격리: 현재 스냅샷 저장 → 후 복원.
  const before = claudeTokenUsageStore.getSnapshot();
  try {
    claudeTokenUsageStore.setSessionStatus('exhausted', '토큰 소진');
    const after = claudeTokenUsageStore.getSnapshot();
    assert.equal(after.sessionStatus, 'exhausted');
    assert.equal(after.sessionStatusReason, '토큰 소진');
    claudeTokenUsageStore.setSessionStatus('active');
    const reset = claudeTokenUsageStore.getSnapshot();
    assert.equal(reset.sessionStatus, 'active');
  } finally {
    claudeTokenUsageStore.__setForTest(before);
  }
});

// ─── agentWorker 세션 가드 ──────────────────────────────────────────────────

test('setAgentWorkerSessionStatus — 모듈 상태가 정확히 저장·조회된다', () => {
  setAgentWorkerSessionStatus('warning');
  assert.equal(getAgentWorkerSessionStatus(), 'warning');
  setAgentWorkerSessionStatus('active');
  assert.equal(getAgentWorkerSessionStatus(), 'active');
});

test('AgentWorker.enqueue — exhausted 상태에서 신규 enqueue 는 즉시 거부', async () => {
  setAgentWorkerSessionStatus('exhausted');
  try {
    const worker = new AgentWorker({ agentId: 'test-a', projectId: 'p1', workspacePath: '/tmp/x' });
    await assert.rejects(
      () => worker.enqueue('안녕'),
      (e: unknown) => e instanceof Error && e.message === WORKER_SESSION_EXHAUSTED_MESSAGE,
    );
    worker.dispose();
  } finally {
    setAgentWorkerSessionStatus('active');
  }
});

test('AgentWorker.enqueue — active 상태에서는 거부 가드가 발동하지 않는다(큐에 적재만 검증)', async () => {
  setAgentWorkerSessionStatus('active');
  const worker = new AgentWorker({ agentId: 'test-b', projectId: 'p1', workspacePath: '/tmp/x' });
  // 실제 spawn 을 피하기 위해 enqueue 호출 후 즉시 dispose → 거부 에러(disposed) 로 수렴.
  const p = worker.enqueue('안녕');
  worker.dispose();
  await assert.rejects(p, (e: unknown) => e instanceof Error && /종료/.test(e.message));
});

// ─── 타입 축 공유 ─────────────────────────────────────────────────────────

test('CLAUDE_SESSION_STATUSES — 세 상태가 정확히 정의돼 있다', () => {
  assert.deepEqual([...CLAUDE_SESSION_STATUSES].sort(), ['active', 'exhausted', 'warning']);
});
