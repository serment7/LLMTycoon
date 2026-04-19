// Run with: npx tsx --test tests/agentWorkerMediaDispatch.regression.test.ts
//
// 회귀 테스트: `src/server/agentWorker.ts` 의 매체 도구 디스패처(#bc9843bb).
// 핸들러 주입/정상/no-handler/에러/세션 소진 큐잉/복귀 후 flush 5가지 경로를
// 런타임으로 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dispatchAgentToolUses,
  flushQueuedMediaToolRequests,
  getQueuedMediaToolRequestCount,
  setMediaToolHandler,
  resetMediaToolHandler,
  setMediaTimelineEmitter,
  resetMediaTimelineEmitter,
  setAgentWorkerSessionStatus,
  type MediaToolHandler,
} from '../src/server/agentWorker.ts';
import type { MediaAsset, MediaTimelineEvent } from '../src/types.ts';

function reset() {
  setAgentWorkerSessionStatus('active');
  resetMediaToolHandler();
  resetMediaTimelineEmitter();
}

function stubAsset(kind: MediaAsset['kind'] = 'pdf'): MediaAsset {
  return {
    id: `stub-${kind}-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'p',
    kind,
    name: `stub.${kind}`,
    mimeType: 'application/octet-stream',
    sizeBytes: 1024,
    createdAt: new Date().toISOString(),
    generatedBy: { adapter: 'stub', prompt: 'x' },
  };
}

test('빈 텍스트 → 빈 결과', async () => {
  reset();
  const out = await dispatchAgentToolUses('', { agentId: 'a', projectId: 'p' });
  assert.deepEqual(out, []);
});

test('정상 경로 — 핸들러가 호출되고 dispatched 결과를 돌려준다', async () => {
  reset();
  const received: string[] = [];
  const handler: MediaToolHandler = async (req, ctx) => {
    received.push(`${req.tool}:${ctx.agentId}`);
    return stubAsset(req.tool === 'generate_pdf' ? 'pdf' : req.tool === 'generate_pptx' ? 'pptx' : 'video');
  };
  setMediaToolHandler(handler);
  const text = '{"tool":"generate_pdf","input":{"title":"t","sections":[]}}';
  const out = await dispatchAgentToolUses(text, { agentId: 'agent-1', projectId: 'p1' });
  assert.equal(out.length, 1);
  assert.equal(out[0].result, 'dispatched');
  assert.ok(out[0].asset);
  assert.deepEqual(received, ['generate_pdf:agent-1']);
});

test('타임라인 emitter 가 등록되어 있으면 MediaTimelineEvent 가 reason=generated 로 방출된다', async () => {
  reset();
  setMediaToolHandler(async () => stubAsset('pdf'));
  const emitted: MediaTimelineEvent[] = [];
  setMediaTimelineEmitter(e => emitted.push(e));
  const text = '{"tool":"generate_pdf","input":{"title":"t","sections":[]}}';
  await dispatchAgentToolUses(text, { agentId: 'a', projectId: 'p' });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].reason, 'generated');
});

test('핸들러 미등록 → no-handler 결과', async () => {
  reset();
  const text = '{"tool":"generate_pdf","input":{"title":"t","sections":[]}}';
  const out = await dispatchAgentToolUses(text, { agentId: 'a', projectId: 'p' });
  assert.equal(out.length, 1);
  assert.equal(out[0].result, 'no-handler');
});

test('핸들러 예외는 error 결과로 래핑되고 이후 요청이 계속 처리된다', async () => {
  reset();
  let call = 0;
  setMediaToolHandler(async (req) => {
    call += 1;
    if (call === 1) throw new Error('boom');
    return stubAsset('pptx');
  });
  const text = [
    '{"tool":"generate_pdf","input":{"title":"t","sections":[]}}',
    '{"tool":"generate_pptx","input":{"slides":[{"title":"s"}]}}',
  ].join('\n');
  const out = await dispatchAgentToolUses(text, { agentId: 'a', projectId: 'p' });
  assert.equal(out.length, 2);
  assert.equal(out[0].result, 'error');
  assert.match(out[0].error ?? '', /boom/);
  assert.equal(out[1].result, 'dispatched');
});

test('§폴백 — exhausted 세션에서는 queued-exhausted 로 큐잉되고 reason 이 붙은 이벤트가 즉시 방출된다', async () => {
  reset();
  setMediaToolHandler(async () => stubAsset('video')); // 호출되어선 안 됨
  const emitted: MediaTimelineEvent[] = [];
  setMediaTimelineEmitter(e => emitted.push(e));
  setAgentWorkerSessionStatus('exhausted');
  const text = '{"tool":"generate_video","input":{"prompt":"홍보"}}';
  const out = await dispatchAgentToolUses(text, { agentId: 'a', projectId: 'p' });
  assert.equal(out.length, 1);
  assert.equal(out[0].result, 'queued-exhausted');
  assert.equal(getQueuedMediaToolRequestCount(), 1);
  assert.equal(emitted.length, 1, '타임라인에는 즉시 "대기" 이벤트가 찍혀야 한다');
  assert.equal(emitted[0].reason, 'queued-exhausted');
  assert.match(emitted[0].summary ?? '', /토큰 소진 대기/);
});

test('exhausted → active 복귀 후 flushQueuedMediaToolRequests 가 FIFO 로 재실행한다', async () => {
  reset();
  const order: string[] = [];
  setMediaToolHandler(async (req) => {
    order.push(req.tool);
    return stubAsset(req.tool === 'generate_pdf' ? 'pdf' : req.tool === 'generate_pptx' ? 'pptx' : 'video');
  });
  setAgentWorkerSessionStatus('exhausted');
  const text = [
    '{"tool":"generate_pdf","input":{"title":"A","sections":[]}}',
    '{"tool":"generate_pptx","input":{"slides":[{"title":"s"}]}}',
    '{"tool":"generate_video","input":{"prompt":"p"}}',
  ].join('\n');
  await dispatchAgentToolUses(text, { agentId: 'a', projectId: 'p' });
  assert.equal(getQueuedMediaToolRequestCount(), 3);
  setAgentWorkerSessionStatus('active');
  const out = await flushQueuedMediaToolRequests();
  assert.equal(out.length, 3);
  assert.deepEqual(order, ['generate_pdf', 'generate_pptx', 'generate_video']);
  assert.equal(getQueuedMediaToolRequestCount(), 0);
});

test('exhausted 상태에서 flush 를 호출해도 큐가 비워지지 않는다 (세션 복귀 후에만 되감기)', async () => {
  reset();
  setMediaToolHandler(async () => stubAsset('pdf'));
  setAgentWorkerSessionStatus('exhausted');
  const text = '{"tool":"generate_pdf","input":{"title":"t","sections":[]}}';
  await dispatchAgentToolUses(text, { agentId: 'a', projectId: 'p' });
  assert.equal(getQueuedMediaToolRequestCount(), 1);
  const out = await flushQueuedMediaToolRequests();
  assert.equal(out.length, 0);
  assert.equal(getQueuedMediaToolRequestCount(), 1);
});
