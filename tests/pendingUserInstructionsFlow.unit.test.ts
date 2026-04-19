// Run with: npx tsx --test tests/pendingUserInstructionsFlow.unit.test.ts
//
// 지시 #367441f0 — 자동 개발 ON 상태 대기 큐 · agentDispatcher 게이팅 · idle 전이 flush
// · OFF 정책 · 경쟁 상태 직렬화까지 파이프라인 전체를 잠근다.
//
// 축 A. 큐 스토어 — FIFO · 취소 · 중복 취소 no-op · markFailed → pending 복귀
// 축 B. 경쟁 상태 — 동시 beginNextPending 호출은 정확히 한 건만 승격
// 축 C. submitUserInstruction — autoMode ON + working>0 → queued, 그렇지 않으면 dispatched
// 축 D. submitUserInstruction — 디스패처 throw 는 큐에 적재 + markFailed
// 축 E. flushPendingInstructions — idle 순간 단일 승자가 처리, busy 중복 호출은 skipped
// 축 F. useFlushPendingInstructions 헬퍼 — detectIdleTransition 경계 케이스
// 축 G. applyAutoDevOffPolicy — keep/discard/flush-now 세 정책의 큐 최종 상태

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPendingUserInstructionsStore,
  type PendingUserInstructionsStore,
} from '../src/stores/pendingUserInstructionsStore.ts';
import {
  submitUserInstruction,
  flushPendingInstructions,
  applyAutoDevOffPolicy,
  setAutoModeProvider,
  setWorkingAgentsProvider,
  setInstructionDispatcher,
  setPendingInstructionsStoreForTests,
  resetAgentDispatcherForTests,
} from '../src/services/agentDispatcher.ts';
import { detectIdleTransition, countWorking } from '../src/hooks/useFlushPendingInstructions.ts';
import type { Agent } from '../src/types.ts';

function makeStore(): PendingUserInstructionsStore {
  return createPendingUserInstructionsStore({
    now: (() => {
      let t = 1_700_000_000_000;
      return () => (t += 1);
    })(),
    newId: (() => {
      let n = 0;
      return () => `t-${++n}`;
    })(),
  });
}

function fakeAgent(name: string, status: Agent['status']): Agent {
  return {
    id: name,
    name,
    role: name === 'Kai' ? 'Leader' : 'Developer',
    spriteTemplate: 's',
    x: 0,
    y: 0,
    status,
  };
}

function resetDispatcherWithStore(): PendingUserInstructionsStore {
  resetAgentDispatcherForTests();
  const store = makeStore();
  setPendingInstructionsStoreForTests(store);
  return store;
}

// ────────────────────────────────────────────────────────────────────────────
// A. 큐 스토어 기본 계약
// ────────────────────────────────────────────────────────────────────────────

test('A1. enqueue → list/pendingCount 가 FIFO 순서를 보존', () => {
  const store = makeStore();
  store.enqueue({ text: 'first' });
  store.enqueue({ text: 'second' });
  const snap = store.snapshot();
  assert.equal(snap.pendingCount, 2);
  assert.deepEqual(snap.items.map((r) => r.text), ['first', 'second']);
});

test('A2. cancel 은 pending 만 cancelled 로 전이, processing/done 은 무시', () => {
  const store = makeStore();
  const a = store.enqueue({ text: 'a' });
  const b = store.enqueue({ text: 'b' });
  assert.equal(store.cancel(a.id), true);
  assert.equal(store.cancel(a.id), false, '두 번째 취소는 no-op');
  // b 는 승격 후 cancel 시도
  store.beginNextPending();
  assert.equal(store.cancel(b.id), false, 'processing 은 cancel 대상이 아님');
});

test('A3. markFailed 는 processing 을 pending 으로 되돌리고 lastError 를 기록', () => {
  const store = makeStore();
  const a = store.enqueue({ text: 'a' });
  const started = store.beginNextPending();
  assert.equal(started?.id, a.id);
  assert.equal(store.markFailed(a.id, '네트워크 오류'), true);
  const snap = store.snapshot();
  assert.equal(snap.items[0].status, 'pending');
  assert.equal(snap.items[0].lastError, '네트워크 오류');
});

test('A4. cancelAllPending 은 pending 전부 cancelled, processing 은 유지', () => {
  const store = makeStore();
  store.enqueue({ text: 'a' });
  const b = store.enqueue({ text: 'b' });
  store.beginNextPending(); // a → processing
  const count = store.cancelAllPending();
  assert.equal(count, 1, 'pending 이었던 b 한 건만 취소');
  const snap = store.snapshot();
  assert.equal(snap.items.find((r) => r.id === b.id)?.status, 'cancelled');
});

// ────────────────────────────────────────────────────────────────────────────
// B. 경쟁 상태 직렬화
// ────────────────────────────────────────────────────────────────────────────

test('B. 동시 beginNextPending 5회 호출은 정확히 하나만 processing 을 반환', () => {
  const store = makeStore();
  const a = store.enqueue({ text: 'a' });
  store.enqueue({ text: 'b' });
  // 동기적으로 5회 호출 → 첫 호출이 a 를 가져가고, 나머지는 b, b 이후 null...
  const results = [
    store.beginNextPending(),
    store.beginNextPending(),
    store.beginNextPending(),
    store.beginNextPending(),
    store.beginNextPending(),
  ];
  const processing = results.filter((r): r is NonNullable<typeof r> => r !== null);
  assert.equal(processing.length, 2, 'pending 이 2건이었으므로 최대 2건만 승격');
  assert.equal(processing[0].id, a.id);
  assert.equal(new Set(processing.map((r) => r.id)).size, 2, '동일 item 이 중복 승격되지 않음');
});

// ────────────────────────────────────────────────────────────────────────────
// C. submitUserInstruction 게이팅
// ────────────────────────────────────────────────────────────────────────────

test('C1. autoMode ON + working>0 → queued', async () => {
  const store = resetDispatcherWithStore();
  setAutoModeProvider(() => true);
  setWorkingAgentsProvider(() => 2);
  const dispatchSpy: Array<{ text: string }> = [];
  setInstructionDispatcher(async (input) => { dispatchSpy.push({ text: input.text }); });

  const out = await submitUserInstruction({ text: 'hello', projectId: 'P1' });
  assert.equal(out.kind, 'queued');
  assert.equal(dispatchSpy.length, 0, 'autoMode ON + 작업 중에는 디스패처가 호출되지 않음');
  assert.equal(store.snapshot().pendingCount, 1);

  resetAgentDispatcherForTests();
});

test('C2. autoMode OFF 또는 working==0 → 즉시 dispatched', async () => {
  const store = resetDispatcherWithStore();
  setAutoModeProvider(() => false);
  setWorkingAgentsProvider(() => 2);
  const dispatchSpy: Array<{ text: string }> = [];
  setInstructionDispatcher(async (input) => { dispatchSpy.push({ text: input.text }); });

  const out = await submitUserInstruction({ text: 'go' });
  assert.equal(out.kind, 'dispatched');
  assert.equal(dispatchSpy.length, 1);
  assert.equal(store.snapshot().pendingCount, 0);

  resetAgentDispatcherForTests();
});

test('C3. working==0 면 autoMode ON 이어도 즉시 디스패치', async () => {
  resetDispatcherWithStore();
  setAutoModeProvider(() => true);
  setWorkingAgentsProvider(() => 0);
  const dispatchSpy: string[] = [];
  setInstructionDispatcher(async (input) => { dispatchSpy.push(input.text); });

  const out = await submitUserInstruction({ text: 'immediate' });
  assert.equal(out.kind, 'dispatched');
  assert.deepEqual(dispatchSpy, ['immediate']);

  resetAgentDispatcherForTests();
});

// ────────────────────────────────────────────────────────────────────────────
// D. 디스패처 실패는 큐 적재 + markFailed
// ────────────────────────────────────────────────────────────────────────────

test('D. 디스패처 throw 는 큐에 적재 후 markFailed 로 lastError 기록', async () => {
  const store = resetDispatcherWithStore();
  setAutoModeProvider(() => false);
  setWorkingAgentsProvider(() => 0);
  setInstructionDispatcher(async () => { throw new Error('503 busy'); });

  const out = await submitUserInstruction({ text: 'retry-me' });
  assert.equal(out.kind, 'queued');
  const snap = store.snapshot();
  assert.equal(snap.items.length, 1);
  assert.equal(snap.items[0].status, 'pending');
  assert.match(snap.items[0].lastError ?? '', /503/);

  resetAgentDispatcherForTests();
});

// ────────────────────────────────────────────────────────────────────────────
// E. flushPendingInstructions
// ────────────────────────────────────────────────────────────────────────────

test('E1. flush 는 맨 앞 pending 을 꺼내 디스패치, 동시 호출은 busy 로 skip', async () => {
  const store = resetDispatcherWithStore();
  setAutoModeProvider(() => false);
  setWorkingAgentsProvider(() => 0);
  store.enqueue({ text: 'q1' });
  store.enqueue({ text: 'q2' });
  const dispatchedTexts: string[] = [];
  // 첫 호출이 끝나기 전에 동시 flush 가 와도 processing=1 이므로 busy skip.
  let resolveDispatch: (() => void) | null = null;
  setInstructionDispatcher(async (input) => {
    dispatchedTexts.push(input.text);
    await new Promise<void>((resolve) => { resolveDispatch = resolve; });
  });

  const first = flushPendingInstructions();
  // 동시 호출 — 아직 첫 디스패치가 진행 중.
  const second = await flushPendingInstructions();
  assert.equal(second.kind, 'skipped');
  assert.equal(second.kind === 'skipped' ? second.reason : '', 'busy');

  resolveDispatch?.();
  const firstRes = await first;
  assert.equal(firstRes.kind, 'flushed');
  assert.deepEqual(dispatchedTexts, ['q1']);

  resetAgentDispatcherForTests();
});

test('E2. 큐가 비어 있을 때 flush 는 idle', async () => {
  resetDispatcherWithStore();
  setInstructionDispatcher(async () => { /* noop */ });
  const res = await flushPendingInstructions();
  assert.equal(res.kind, 'idle');
  resetAgentDispatcherForTests();
});

test('E3. 디스패처 미등록 상태 → flush 는 skipped(no-dispatcher)', async () => {
  const store = resetDispatcherWithStore();
  store.enqueue({ text: 'x' });
  // setInstructionDispatcher 호출하지 않음
  const res = await flushPendingInstructions();
  assert.equal(res.kind, 'skipped');
  assert.equal(res.kind === 'skipped' ? res.reason : '', 'no-dispatcher');
  resetAgentDispatcherForTests();
});

// ────────────────────────────────────────────────────────────────────────────
// F. useFlushPendingInstructions 헬퍼
// ────────────────────────────────────────────────────────────────────────────

test('F. detectIdleTransition — working>0 에서 0 으로 내려가는 찰나만 true', () => {
  assert.equal(detectIdleTransition(3, 0), true);
  assert.equal(detectIdleTransition(1, 0), true);
  assert.equal(detectIdleTransition(0, 0), false, '처음부터 idle 이면 false');
  assert.equal(detectIdleTransition(3, 2), false);
  assert.equal(detectIdleTransition(0, 2), false, 'working 증가도 false');

  const agents: Agent[] = [fakeAgent('Kai', 'idle'), fakeAgent('Joker', 'working')];
  assert.equal(countWorking(agents), 1);
});

// ────────────────────────────────────────────────────────────────────────────
// G. applyAutoDevOffPolicy — 세 정책의 결과
// ────────────────────────────────────────────────────────────────────────────

test('G1. keep — 큐가 그대로 유지', async () => {
  const store = resetDispatcherWithStore();
  store.enqueue({ text: 'a' });
  store.enqueue({ text: 'b' });
  await applyAutoDevOffPolicy('keep');
  assert.equal(store.snapshot().pendingCount, 2);
  resetAgentDispatcherForTests();
});

test('G2. discard — pending 전부 cancelled', async () => {
  const store = resetDispatcherWithStore();
  store.enqueue({ text: 'a' });
  store.enqueue({ text: 'b' });
  await applyAutoDevOffPolicy('discard');
  const snap = store.snapshot();
  assert.equal(snap.pendingCount, 0);
  assert.equal(snap.items.filter((r) => r.status === 'cancelled').length, 2);
  resetAgentDispatcherForTests();
});

test('G3. flush-now — 모든 pending 을 순차 디스패치 후 done 으로 마감', async () => {
  const store = resetDispatcherWithStore();
  store.enqueue({ text: 'a' });
  store.enqueue({ text: 'b' });
  const order: string[] = [];
  setInstructionDispatcher(async (input) => { order.push(input.text); });
  await applyAutoDevOffPolicy('flush-now');
  assert.deepEqual(order, ['a', 'b']);
  const snap = store.snapshot();
  assert.equal(snap.pendingCount, 0);
  assert.equal(snap.items.filter((r) => r.status === 'done').length, 2);
  resetAgentDispatcherForTests();
});
