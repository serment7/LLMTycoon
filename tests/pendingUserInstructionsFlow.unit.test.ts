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
// 축 H. 지시 #992f64c9 — 사용자 시나리오 기반 회귀 잠금
//        ① ON 상태 지시 전달 시 enqueue + 현재 태스크 중단 없음
//        ② 현재 태스크 완료(working→idle) 시점에 팀 리더에게 flush 전달
//        ③ OFF 상태 지시는 즉시 리더에게 전달
//        ④ 다건 지시가 FIFO 로 순서 보존되어 처리
//        ⑤ 사용자가 큐 항목을 취소할 수 있으며 취소 건은 flush 대상에서 제외

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

// ────────────────────────────────────────────────────────────────────────────
// H. 지시 #992f64c9 — 사용자 시나리오 회귀
//
// 실제 사용 경로(자동 개발 ON 중 지시 투입 → working 이 0 으로 떨어질 때 flush)를
// 끝에서 끝까지 재현해 UI 계약이 바뀌어도 동작이 지켜지는지 잠근다.
// ────────────────────────────────────────────────────────────────────────────

test('H1. 시나리오 ① — 자동 개발 ON + working>0 투입: 큐 적재만, 현재 태스크는 끊기지 않음', async () => {
  const store = resetDispatcherWithStore();
  setAutoModeProvider(() => true);
  setWorkingAgentsProvider(() => 1);

  let dispatchCount = 0;
  setInstructionDispatcher(async () => { dispatchCount += 1; });

  const outcome = await submitUserInstruction({
    text: '다음 단계 준비해 줘',
    projectId: 'P-focus',
  });

  // 계약: 큐에만 들어가고, 이미 진행 중인 working 에이전트로의 디스패치는 발생하지 않아야 한다.
  assert.equal(outcome.kind, 'queued');
  assert.equal(dispatchCount, 0, 'ON + 작업 중에는 즉시 디스패치 금지');
  const snap = store.snapshot();
  assert.equal(snap.pendingCount, 1);
  assert.equal(snap.items[0].projectId, 'P-focus');
  assert.equal(snap.items[0].status, 'pending');

  resetAgentDispatcherForTests();
});

test('H2. 시나리오 ② — working→idle 전이 순간 훅이 flush 를 호출, 큐 맨 앞 항목이 리더로 전달', async () => {
  const store = resetDispatcherWithStore();
  setAutoModeProvider(() => true);
  // working 제공자는 "투입 시점" 계산에 쓰이므로 1 로 맞춰 큐에 쌓이도록.
  setWorkingAgentsProvider(() => 1);
  const delivered: Array<{ text: string; projectId?: string }> = [];
  setInstructionDispatcher(async (input) => {
    delivered.push({ text: input.text, projectId: input.projectId });
  });

  // 사용자는 working 상태에서 지시를 투입 → 큐에 적재된다.
  await submitUserInstruction({ text: 'idle 전이되면 이거 시작', projectId: 'P-flush' });
  assert.equal(store.snapshot().pendingCount, 1);
  assert.equal(delivered.length, 0);

  // idle 전이 판정: 이전 1 → 현재 0 일 때만 true. 훅이 이 조건에서 flush 를 호출.
  assert.equal(detectIdleTransition(1, 0), true);
  const agentsAfterFinish: Agent[] = [fakeAgent('Kai', 'idle'), fakeAgent('Joker', 'idle')];
  assert.equal(countWorking(agentsAfterFinish), 0, '팀 전원 idle');

  const res = await flushPendingInstructions();
  assert.equal(res.kind, 'flushed');
  assert.equal(delivered.length, 1, '리더에게 정확히 1회 전달');
  assert.equal(delivered[0].text, 'idle 전이되면 이거 시작');
  assert.equal(delivered[0].projectId, 'P-flush');
  // 전달 완료 후 큐는 비어 있고 done 으로 마감.
  const after = store.snapshot();
  assert.equal(after.pendingCount, 0);
  assert.equal(after.processingCount, 0);
  assert.equal(after.items[0].status, 'done');

  resetAgentDispatcherForTests();
});

test('H3. 시나리오 ③ — 자동 개발 OFF 상태 지시는 즉시 전달(큐를 거치지 않음)', async () => {
  const store = resetDispatcherWithStore();
  setAutoModeProvider(() => false);
  setWorkingAgentsProvider(() => 3);
  const sent: string[] = [];
  setInstructionDispatcher(async (input) => { sent.push(input.text); });

  const r1 = await submitUserInstruction({ text: 'one' });
  const r2 = await submitUserInstruction({ text: 'two' });

  assert.equal(r1.kind, 'dispatched');
  assert.equal(r2.kind, 'dispatched');
  assert.deepEqual(sent, ['one', 'two'], 'OFF 에서는 투입 순서대로 즉시 전달');
  assert.equal(store.snapshot().pendingCount, 0, '큐를 거치지 않음');
  assert.equal(store.snapshot().items.length, 0, '스토어에 흔적이 남지 않음');

  resetAgentDispatcherForTests();
});

test('H4. 시나리오 ④ — ON 상태에서 다건 투입 후 연속 flush 시 FIFO 순서 보존', async () => {
  const store = resetDispatcherWithStore();
  setAutoModeProvider(() => true);
  setWorkingAgentsProvider(() => 1);
  const delivered: string[] = [];
  setInstructionDispatcher(async (input) => { delivered.push(input.text); });

  await submitUserInstruction({ text: 'step-1' });
  await submitUserInstruction({ text: 'step-2' });
  await submitUserInstruction({ text: 'step-3' });
  assert.equal(store.snapshot().pendingCount, 3);

  // idle 전이 이후 연속 flush. flushPendingInstructions 는 맨 앞 한 건만 처리하므로
  // UI 가 "한 건 끝나면 다음 건" 루프를 돌리는 상황을 모사한다.
  const firstFlush = await flushPendingInstructions();
  assert.equal(firstFlush.kind, 'flushed');
  const secondFlush = await flushPendingInstructions();
  assert.equal(secondFlush.kind, 'flushed');
  const thirdFlush = await flushPendingInstructions();
  assert.equal(thirdFlush.kind, 'flushed');

  assert.deepEqual(delivered, ['step-1', 'step-2', 'step-3'], '투입 순서 = 전달 순서');
  const snap = store.snapshot();
  assert.equal(snap.pendingCount, 0);
  assert.equal(snap.processingCount, 0);
  assert.equal(snap.items.filter((r) => r.status === 'done').length, 3);

  resetAgentDispatcherForTests();
});

test('H5. 시나리오 ⑤ — 사용자가 큐 항목을 취소하면 flush 에서 제외되고 다음 항목이 전달', async () => {
  const store = resetDispatcherWithStore();
  setAutoModeProvider(() => true);
  setWorkingAgentsProvider(() => 1);
  const delivered: string[] = [];
  setInstructionDispatcher(async (input) => { delivered.push(input.text); });

  // 3건 적재 — 중간 한 건을 사용자가 취소한다.
  const out1 = await submitUserInstruction({ text: 'keep-1' });
  const out2 = await submitUserInstruction({ text: 'cancel-me' });
  const out3 = await submitUserInstruction({ text: 'keep-2' });
  assert.equal(out1.kind, 'queued');
  assert.equal(out2.kind, 'queued');
  assert.equal(out3.kind, 'queued');
  if (out2.kind !== 'queued') throw new Error('unreachable');

  // 취소 — 해당 항목만 cancelled, 나머지는 pending 유지.
  const cancelled = store.cancel(out2.item.id);
  assert.equal(cancelled, true, '첫 cancel 호출은 성공');
  assert.equal(store.cancel(out2.item.id), false, '두 번째 호출은 no-op');

  const snapAfterCancel = store.snapshot();
  assert.equal(snapAfterCancel.pendingCount, 2, 'cancel 된 건은 pending 에서 제외');
  assert.equal(
    snapAfterCancel.items.find((r) => r.id === out2.item.id)?.status,
    'cancelled',
  );

  // idle 전이 후 두 차례 flush — cancelled 는 건너뛰고 keep-1, keep-2 만 전달된다.
  const r1 = await flushPendingInstructions();
  assert.equal(r1.kind, 'flushed');
  const r2 = await flushPendingInstructions();
  assert.equal(r2.kind, 'flushed');
  const r3 = await flushPendingInstructions();
  assert.equal(r3.kind, 'idle', '취소된 항목은 pending 이 아니므로 큐가 비어 idle');

  assert.deepEqual(delivered, ['keep-1', 'keep-2'], 'cancel-me 는 디스패처로 넘어가지 않음');
  const finalSnap = store.snapshot();
  assert.equal(finalSnap.items.filter((r) => r.status === 'done').length, 2);
  assert.equal(finalSnap.items.filter((r) => r.status === 'cancelled').length, 1);
  assert.equal(finalSnap.pendingCount, 0);
  assert.equal(finalSnap.processingCount, 0);

  resetAgentDispatcherForTests();
});
