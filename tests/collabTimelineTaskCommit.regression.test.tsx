// Run with: npx tsx --test tests/collabTimelineTaskCommit.regression.test.tsx
//
// 회귀 테스트(#f1d5ce51) — CollabTimeline 의 "태스크 경계 커밋" 섹션 렌더링 계약.
// 네 불변을 잠근다:
//   1) taskCommits 미전달 시 해당 섹션은 DOM 에 아예 존재하지 않는다(기존 HANDOFF
//      축만 보이는 화면이 깨지지 않음).
//   2) 이벤트가 전달되면 섹션 헤더·개수·각 row 가 data-testid 로 노출된다.
//   3) row 의 시각 라벨이 COMMIT_STRATEGY_LABEL 을 그대로 사용한다 ('태스크마다 커밋' 등).
//   4) onTaskCommitSelect 가 주어지면 클릭/Enter 로 콜백이 호출된다.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, render, cleanup, fireEvent } from '@testing-library/react';

import { CollabTimeline } from '../src/components/CollabTimeline.tsx';
import type { TaskCommitTimelineEvent } from '../src/types.ts';
import { COMMIT_STRATEGY_LABEL } from '../src/types.ts';

function mount(events: TaskCommitTimelineEvent[] | undefined, onSelect?: (e: TaskCommitTimelineEvent) => void) {
  return render(
    React.createElement(CollabTimeline, {
      entries: [],
      taskCommits: events,
      onTaskCommitSelect: onSelect,
    }),
  );
}

test('taskCommits 미전달 — task-commit 섹션이 렌더되지 않는다', () => {
  const handle = mount(undefined);
  assert.equal(document.querySelector('[data-testid="collab-timeline-task-commits"]'), null);
  handle.unmount();
  cleanup();
});

test('taskCommits 빈 배열 — 섹션은 여전히 숨겨진다(과잉 헤더 방지)', () => {
  const handle = mount([]);
  assert.equal(document.querySelector('[data-testid="collab-timeline-task-commits"]'), null);
  handle.unmount();
  cleanup();
});

test('taskCommits 3건 — 섹션·개수·각 row 가 모두 DOM 에 노출된다', () => {
  const events: TaskCommitTimelineEvent[] = [
    { id: 'c1', type: 'task-commit', taskId: 't1', taskTitle: '결제 리팩터', commitSha: 'abcdef1234567890', strategy: 'per-task', at: '2026-04-19T09:00:00Z', branch: 'feature/pay' },
    { id: 'c2', type: 'task-commit', taskId: 't2', taskTitle: '목표 마감', commitSha: 'fedcba9876543210', strategy: 'per-goal', at: '2026-04-19T10:00:00Z' },
    { id: 'c3', type: 'task-commit', taskId: 't3', commitSha: '1111111aaaa', strategy: 'manual', at: '2026-04-19T11:00:00Z' },
  ];
  const handle = mount(events);
  const section = document.querySelector('[data-testid="collab-timeline-task-commits"]');
  assert.ok(section, '섹션이 렌더되어야 한다');
  const count = document.querySelector('[data-testid="collab-timeline-task-commit-count"]');
  assert.match(count?.textContent ?? '', /3/);
  for (const e of events) {
    const row = document.querySelector(`[data-testid="collab-timeline-task-commit-${e.id}"]`);
    assert.ok(row, `${e.id} 행이 렌더되어야 한다`);
    assert.equal(row!.getAttribute('data-commit-strategy'), e.strategy);
  }
  // SHA 축약(앞 7자)
  const sha1 = document.querySelector('[data-testid="task-commit-sha-c1"]');
  assert.equal(sha1?.textContent, 'abcdef1');
  // 브랜치가 있으면 별도 칩으로 노출
  const branchChip = document.querySelector('[data-testid="task-commit-branch-c1"]');
  assert.equal(branchChip?.textContent, 'feature/pay');
  handle.unmount();
  cleanup();
});

test('strategy 라벨은 COMMIT_STRATEGY_LABEL 단일 출처를 재사용한다', () => {
  const events: TaskCommitTimelineEvent[] = [
    { id: 'x', type: 'task-commit', taskId: 't1', commitSha: 'abcdef1', strategy: 'per-goal', at: '2026-04-19T00:00:00Z' },
  ];
  const handle = mount(events);
  const badge = document.querySelector('[data-testid="task-commit-strategy-x"]');
  assert.equal(badge?.textContent, COMMIT_STRATEGY_LABEL['per-goal']);
  handle.unmount();
  cleanup();
});

test('onTaskCommitSelect — 클릭 시 이벤트가 콜백에 그대로 전달된다', () => {
  const received: TaskCommitTimelineEvent[] = [];
  const events: TaskCommitTimelineEvent[] = [
    { id: 'click', type: 'task-commit', taskId: 't', commitSha: '0000000', strategy: 'per-task', at: '2026-04-19T00:00:00Z' },
  ];
  const handle = mount(events, (e) => received.push(e));
  const row = document.querySelector('[data-testid="collab-timeline-task-commit-click"]') as HTMLElement;
  assert.ok(row);
  act(() => { row.click(); });
  assert.equal(received.length, 1);
  assert.equal(received[0].id, 'click');
  handle.unmount();
  cleanup();
});

test('onTaskCommitSelect — Enter 키도 콜백을 발사한다(키보드 접근성)', () => {
  const received: TaskCommitTimelineEvent[] = [];
  const events: TaskCommitTimelineEvent[] = [
    { id: 'kb', type: 'task-commit', taskId: 't', commitSha: '0000000', strategy: 'per-task', at: '2026-04-19T00:00:00Z' },
  ];
  const handle = mount(events, (e) => received.push(e));
  const row = document.querySelector('[data-testid="collab-timeline-task-commit-kb"]') as HTMLElement;
  assert.ok(row);
  act(() => { fireEvent.keyDown(row, { key: 'Enter' }); });
  assert.equal(received.length, 1);
  handle.unmount();
  cleanup();
});
