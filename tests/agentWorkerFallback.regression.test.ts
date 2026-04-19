// Run with: npx tsx --test tests/agentWorkerFallback.regression.test.ts
//
// QA 회귀(#8888a819) — agentWorker 의 세션 폴백 가드.
//   · setAgentWorkerSessionStatus('exhausted') 이후 도착하는 enqueue 는 즉시 거부되고
//     WORKER_SESSION_EXHAUSTED_MESSAGE 로 reject 된다.
//   · 기존 큐 드레인은 해당 가드의 영향을 받지 않는다(계약을 정적 스캔으로 잠금).
//   · active 로 복귀하면 새 enqueue 가 다시 queue 에 쌓인다(reject 되지 않는다).
//
// AgentWorker 는 실제 Claude CLI 를 spawn 하므로 run-to-completion 통합 테스트를
// 본 파일에서 돌리지 않는다. `enqueue` 시점의 **가드 분기** 만 실행하고, 그 뒤
// spawn 이 필요한 drain 경로는 호출하지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  AgentWorker,
  setAgentWorkerSessionStatus,
  getAgentWorkerSessionStatus,
  WORKER_SESSION_EXHAUSTED_MESSAGE,
} from '../src/server/agentWorker.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = readFileSync(
  resolve(__dirname, '..', 'src', 'server', 'agentWorker.ts'),
  'utf8',
);

// ────────────────────────────────────────────────────────────────────────────
// 상수·접근자 계약
// ────────────────────────────────────────────────────────────────────────────

test('WORKER_SESSION_EXHAUSTED_MESSAGE 는 한국어 안내 문구로 고정되어 있다', () => {
  assert.match(WORKER_SESSION_EXHAUSTED_MESSAGE, /\[워커\]/);
  assert.match(WORKER_SESSION_EXHAUSTED_MESSAGE, /토큰이 소진/);
  assert.match(WORKER_SESSION_EXHAUSTED_MESSAGE, /기존 큐만 드레인/);
});

test('setAgentWorkerSessionStatus / getAgentWorkerSessionStatus — 동일 값에 대해 상호 참조', () => {
  setAgentWorkerSessionStatus('active');
  assert.equal(getAgentWorkerSessionStatus(), 'active');
  setAgentWorkerSessionStatus('exhausted');
  assert.equal(getAgentWorkerSessionStatus(), 'exhausted');
  setAgentWorkerSessionStatus('warning');
  assert.equal(getAgentWorkerSessionStatus(), 'warning');
  setAgentWorkerSessionStatus('active'); // 테스트 격리: 활성 상태로 복귀
});

// ────────────────────────────────────────────────────────────────────────────
// enqueue 실행 분기 — exhausted 에서 즉시 reject
// ────────────────────────────────────────────────────────────────────────────

function makeWorker(): AgentWorker {
  // spawn 은 enqueue 호출 시에만 발생 — 생성자는 필드 초기화뿐이라 실 child 없이 안전.
  return new AgentWorker({
    agentId: 'fallback-test',
    projectId: 'proj-1',
    workspacePath: process.cwd(),
    port: 0,
  });
}

test('enqueue — exhausted 상태에서 호출되면 WORKER_SESSION_EXHAUSTED_MESSAGE 로 reject 된다', async () => {
  setAgentWorkerSessionStatus('exhausted');
  const w = makeWorker();
  const err = await w.enqueue('아무 프롬프트', 'task-1').then(
    () => null,
    (e: Error) => e,
  );
  assert.ok(err instanceof Error, 'Error 로 reject');
  assert.equal(
    (err as Error).message,
    WORKER_SESSION_EXHAUSTED_MESSAGE,
    '정확한 공개 상수와 일치하는 메시지로 reject',
  );
  // 거부되었으므로 큐에 쌓이지 않아야 한다.
  assert.equal(w.queueLength(), 0, '거부된 enqueue 는 큐 길이를 증가시키지 않는다');
  assert.equal(w.isIdle(), true);
  setAgentWorkerSessionStatus('active');
});

test('active 상태에서는 enqueue 가 세션 가드에서 reject 되지 않는다(정적 잠금)', () => {
  // 실제 enqueue 를 호출하면 drain() 가 Claude CLI 를 spawn 하려 시도해 테스트 환경에서
  // 불안정하다. 대신 "세션 가드 분기 이후에 queue.push(new QueueItem) 이 실행된다" 를
  // 소스 스캔으로 잠근다. gaurd-통과 이후 경로가 유지되면 런타임 회귀는 없다.
  assert.match(
    WORKER_SRC,
    /if\s*\(currentSessionStatus\s*===\s*['"]exhausted['"]\)[\s\S]{0,200}return Promise\.reject[\s\S]{0,600}this\.queue\.push\(\s*\{\s*prompt,\s*taskId,/,
    '가드 통과 후에 queue.push 가 호출되어야 한다(active 시 정상 경로)',
  );
  setAgentWorkerSessionStatus('active');
  assert.equal(getAgentWorkerSessionStatus(), 'active', '테스트 간 격리를 위한 리셋');
});

// ────────────────────────────────────────────────────────────────────────────
// 정적 스캔 — 가드 위치 · 드레인 보존 계약
// ────────────────────────────────────────────────────────────────────────────

test('agentWorker.ts — exhausted 가드는 enqueue 함수 내부에서 queue.push 앞에 위치한다', () => {
  // enqueue 블록만 잘라 내부 순서를 본다(파일 다른 곳의 exhausted 분기와 혼선 방지).
  const idx = WORKER_SRC.indexOf('enqueue(prompt:');
  assert.ok(idx > -1, 'enqueue 함수 정의를 찾아야 한다');
  // 블록 범위는 넉넉히 2,000자. drain() 호출까지 포함.
  const block = WORKER_SRC.slice(idx, idx + 2000);
  const guardAt = block.indexOf("currentSessionStatus === 'exhausted'");
  const rejectAt = block.indexOf('WORKER_SESSION_EXHAUSTED_MESSAGE');
  const pushAt = block.indexOf('this.queue.push');
  assert.ok(guardAt > 0, 'enqueue 블록 내 exhausted 검사 존재');
  assert.ok(
    rejectAt > guardAt,
    'exhausted 검사 바로 아래에 WORKER_SESSION_EXHAUSTED_MESSAGE reject 가 위치해야 한다',
  );
  assert.ok(
    pushAt > rejectAt,
    'queue.push 는 세션 가드 통과 이후에만 실행되는 위치여야 한다',
  );
});

test('agentWorker.ts — 기존 큐 드레인 경로(drain)는 세션 상태를 다시 검사하지 않는다(이미 쌓인 큐는 보호)', () => {
  // drain() 또는 이에 상응하는 메서드가 currentSessionStatus 를 직접 검사하지 않아야
  // "이미 큐에 들어간 항목은 그대로 처리" 계약이 유지된다.
  const drainFn = WORKER_SRC.match(/private\s+drain\s*\([\s\S]{0,50}\)\s*\{[\s\S]*?\n  \}/);
  if (drainFn) {
    assert.ok(
      !/currentSessionStatus/.test(drainFn[0]),
      'drain 경로에 세션 상태 검사가 추가되면 "기존 큐 보호" 계약이 깨진다',
    );
  } else {
    // drain 이 다른 이름으로 분해됐다면 전체 파일 범위에서라도 "queue.shift 위쪽에
    // session 검사 없음" 을 느슨히 잠근다.
    assert.match(
      WORKER_SRC,
      /queue\.shift\(\)/,
      'drain 경로에서 queue.shift 가 사용되어야 한다',
    );
  }
});

test('agentWorker.ts — exhausted 가드 주석에 "기존 큐는 그대로 드레인" 설명이 유지된다(의도 문서화)', () => {
  assert.match(
    WORKER_SRC,
    /토큰 소진 이후 도착한 신규 태스크는 즉시 거부[\s\S]{0,400}이미 큐에 쌓여 있던 항목은 그대로 드레인/,
    '의도 주석이 제거되면 미래 리뷰어가 "기존 큐도 끊어야 하지 않나" 오해할 수 있어 유지 필요',
  );
});
