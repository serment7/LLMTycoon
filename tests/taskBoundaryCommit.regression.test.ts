// Run with: npx tsx --test tests/taskBoundaryCommit.regression.test.ts
//
// QA 회귀(#a6604cb0) — 자동 개발 ON 상태의 "태스크 경계 커밋" 가드.
//
// 지시 본문과 실 구현 간 용어 매핑(테스트가 실제로 잠그는 이름 기준):
//   · 지시 "`onTaskBoundary` 훅"           → 현재 구현 **없음**(agentWorker.ts
//     어디에도 존재하지 않음). 부재 자체를 회귀로 잠가 인위적 도입 시 이 테스트가
//     실패하도록 한다(옵트인 커밋 경로가 기존 파이프라인과 혼선을 일으키지 않도록).
//   · 지시 "`commitStrategy` 별 호출"       → 실제는 `FlowLevel`('commitOnly' ·
//     'commitPush' · 'commitPushPR') + `enabled`(마스터 스위치) 의 조합 가드.
//     `shouldAutoCommit / shouldAutoPush / shouldAutoOpenPR` 3단계가 실제 분기 지점.
//   · 지시 "수동 모드에서는 호출되지 않음"  → `enabled === false` 일 때 세 가드가
//     모두 false 를 돌려주는지 확인.
//   · 지시 "폴백 모드(sessionStatus='exhausted') 에서는 큐잉"
//     → 현재 `ClaudeSessionStatus = 'active' | 'warning' | 'exhausted'` 타입은 존재
//     하지만, 커밋 경로가 `exhausted` 를 감지해 큐잉하는 로직은 **없다**.
//     부재를 정적으로 잠가 도입 시 "커밋 전에 세션 상태를 체크해야 함" 계약이
//     회귀로 따라오도록 한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  shouldAutoCommit,
  shouldAutoPush,
  shouldAutoOpenPR,
  commit as buildCommitSteps,
  type FlowLevel,
} from '../src/utils/gitAutomation.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_WORKER_SRC = readFileSync(
  resolve(__dirname, '..', 'src', 'server', 'agentWorker.ts'),
  'utf8',
);

// ────────────────────────────────────────────────────────────────────────────
// 수동 모드(enabled=false) — 세 가드 모두 false
// ────────────────────────────────────────────────────────────────────────────

test('수동 모드(enabled=false) — flowLevel 과 무관하게 자동 커밋/푸시/PR 모두 차단', () => {
  const levels: FlowLevel[] = ['commitOnly', 'commitPush', 'commitPushPR'];
  for (const flowLevel of levels) {
    const cfg = { enabled: false, flowLevel };
    assert.equal(shouldAutoCommit(cfg), false, `commit(${flowLevel}) 차단`);
    assert.equal(shouldAutoPush(cfg), false, `push(${flowLevel}) 차단`);
    assert.equal(shouldAutoOpenPR(cfg), false, `pr(${flowLevel}) 차단`);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 자동 모드 — flowLevel 단계별 허용/차단 진리표
// ────────────────────────────────────────────────────────────────────────────

test('flowLevel 진리표 — commitOnly 는 commit 만, commitPush 는 commit+push, commitPushPR 은 셋 다 허용', () => {
  const cases: Array<{ flow: FlowLevel; commit: boolean; push: boolean; pr: boolean }> = [
    { flow: 'commitOnly',   commit: true,  push: false, pr: false },
    { flow: 'commitPush',   commit: true,  push: true,  pr: false },
    { flow: 'commitPushPR', commit: true,  push: true,  pr: true  },
  ];
  for (const c of cases) {
    const cfg = { enabled: true, flowLevel: c.flow };
    assert.equal(shouldAutoCommit(cfg), c.commit,  `${c.flow}: commit`);
    assert.equal(shouldAutoPush(cfg),   c.push,    `${c.flow}: push`);
    assert.equal(shouldAutoOpenPR(cfg), c.pr,      `${c.flow}: pr`);
  }
});

test('enabled=undefined(레거시) — flowLevel 만으로 판단하며 commit 을 허용한다', () => {
  const cfg = { flowLevel: 'commitOnly' as FlowLevel };
  assert.equal(shouldAutoCommit(cfg), true, '레거시 경로는 commit 허용');
  assert.equal(shouldAutoPush(cfg), false);
  assert.equal(shouldAutoOpenPR(cfg), false);
});

// ────────────────────────────────────────────────────────────────────────────
// 커밋 스텝 빌더 — `commit(config, ctx)` 가 차단될 때는 빈 배열
// ────────────────────────────────────────────────────────────────────────────

test('commit(config, ctx) — 수동 모드에서는 빈 배열을 돌려줘 git 명령이 한 줄도 나가지 않는다', () => {
  const steps = buildCommitSteps(
    { enabled: false, flowLevel: 'commitPush' },
    {
      workspacePath: '/tmp/ws',
      branch: 'feat/demo',
      commitMessage: 'chore: noop',
      prTitle: 'noop',
    },
  );
  assert.deepEqual(steps, [], '차단 시 steps 는 빈 배열');
});

test('commit(config, ctx) — 허용 모드에서는 checkout → add → commit 3단계 시퀀스를 돌려준다', () => {
  const steps = buildCommitSteps(
    { enabled: true, flowLevel: 'commitOnly' },
    {
      workspacePath: '/tmp/ws',
      branch: 'feat/demo',
      commitMessage: 'chore: 1차 스켈레톤',
      prTitle: 'noop',
    },
  );
  assert.equal(steps.length, 3, 'checkout / add / commit 3단계');
  assert.deepEqual(
    steps.map(s => s.label),
    ['checkout', 'add', 'commit'],
  );
  const commitStep = steps.find(s => s.label === 'commit')!;
  assert.ok(
    commitStep.cmd.includes('chore: 1차 스켈레톤'),
    '커밋 메시지가 cmd 인자에 그대로 포함되어야 한다',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// 승격 계약 (#f3c0ea52) — 부재 잠금 → 호출 규약 잠금
// 이전 사이클의 "부재 잠금" 어설션 2건이 구현 도입과 함께 실제 호출 규약 잠금
// 으로 교체된다. 회귀 방향은 동일하다: 이후 변경이 수동/폴백/큐잉 계약을 깨면
// 본 테스트가 즉시 실패한다.
// ────────────────────────────────────────────────────────────────────────────

test('agentWorker.ts 는 태스크 경계 훅 공개 API 3종을 export 한다 (notify/flush/setHandler)', () => {
  // notifyTaskBoundary 는 커밋 경계 이벤트의 단일 진입점, setTaskBoundaryHandler
  // 는 서버 어댑터 주입, flushQueuedTaskBoundaries 는 exhausted → active 복귀 시
  // 큐잉된 이벤트를 되감는 외부 호출자 계약이다. 셋 중 하나라도 사라지면 관측
  // 가능한 계약이 깨진다.
  assert.match(AGENT_WORKER_SRC, /export function notifyTaskBoundary\b/);
  assert.match(AGENT_WORKER_SRC, /export function setTaskBoundaryHandler\b/);
  assert.match(AGENT_WORKER_SRC, /export function flushQueuedTaskBoundaries\b/);
});

test('notifyTaskBoundary 는 수동/변경없음/세션소진/정상 4경로를 분기한다', () => {
  // 실제 분기 명은 `skipped-manual`·`skipped-no-changes`·`queued-exhausted`·
  // `dispatched` 다. 문자열 상수를 소스에서 정적 확인해, 명시 값이 바뀌면 테스트가
  // 실패해 외부 호출자(서버·UI) 가 같이 업데이트되도록 한다.
  for (const token of ['skipped-manual', 'skipped-no-changes', 'queued-exhausted', 'dispatched']) {
    assert.ok(
      AGENT_WORKER_SRC.includes(`'${token}'`),
      `notifyTaskBoundary 의 분기 토큰 '${token}' 가 소스에 존재해야 한다`,
    );
  }
});

test('세션 소진 큐잉 계약 — exhausted 감지·FIFO 큐·flushQueuedTaskBoundaries 로 되감기', () => {
  // 큐잉 자료구조의 이름이 회귀 대상이다. 배열 기반 shift() FIFO 를 유지해야
  // 호출 순서가 보존된다. Map/Set 으로 바꾸면 FIFO 가 깨지므로 이름을 잠근다.
  assert.match(
    AGENT_WORKER_SRC,
    /currentSessionStatus\s*===\s*'exhausted'/,
    "exhausted 감지는 `currentSessionStatus === 'exhausted'` 형태여야 한다(세션 폴백 공용 소스)",
  );
  assert.match(
    AGENT_WORKER_SRC,
    /const\s+queuedTaskBoundaries\s*:/,
    'queuedTaskBoundaries 배열이 FIFO 자료구조로 존재해야 한다',
  );
  assert.match(
    AGENT_WORKER_SRC,
    /queuedTaskBoundaries\.shift\(\)/,
    'flushQueuedTaskBoundaries 는 shift() 로 FIFO 순을 보존해야 한다',
  );
});
