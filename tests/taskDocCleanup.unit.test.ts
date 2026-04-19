// Run with: npx tsx --test tests/taskDocCleanup.unit.test.ts
//
// 지시 #75971d83 — 태스크 완료 시 관련 docs/ 문서 정리 파이프라인 회귀 잠금.
//
// 축 A. planTaskDocCleanup — 순수 판정 규칙
// 축 B. executeTaskDocCleanup — 삭제 실행 · 확인 게이트 · 되돌리기
// 축 C. recordTaskDocReference / toggleKeepFlag — 참조·유지 플래그 헬퍼

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../src/types.ts';
import {
  planTaskDocCleanup,
  executeTaskDocCleanup,
  recordTaskDocReference,
  toggleKeepFlag,
  type CleanupPlan,
} from '../src/services/taskDocCleanupService.ts';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    projectId: overrides.projectId ?? 'P',
    assignedTo: overrides.assignedTo ?? 'A',
    description: overrides.description ?? '',
    status: overrides.status ?? 'completed',
    relatedDocs: overrides.relatedDocs,
    keepDocs: overrides.keepDocs,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// A. planTaskDocCleanup
// ────────────────────────────────────────────────────────────────────────────

test('A1. docs/ 아래 경로만 삭제 후보, 그 외 경로는 not-a-docs-path 로 skip', () => {
  const done = makeTask({
    id: 't1',
    relatedDocs: ['docs/design/a.md', 'src/index.ts', 'docs/specs/b.md'],
  });
  const plan = planTaskDocCleanup(done, [done]);
  const map = Object.fromEntries(plan.items.map((it) => [it.path, it]));
  assert.equal(map['docs/design/a.md'].action, 'delete');
  assert.equal(map['docs/specs/b.md'].action, 'delete');
  assert.equal(map['src/index.ts'].action, 'skip');
  assert.equal(map['src/index.ts'].reason, 'not-a-docs-path');
});

test('A2. keepDocs 에 포함된 경로는 user-keep-flag 로 skip', () => {
  const done = makeTask({
    id: 't1',
    relatedDocs: ['docs/a.md', 'docs/b.md'],
    keepDocs: ['docs/b.md'],
  });
  const plan = planTaskDocCleanup(done, [done]);
  const b = plan.items.find((it) => it.path === 'docs/b.md')!;
  assert.equal(b.action, 'skip');
  assert.equal(b.reason, 'user-keep-flag');
  assert.equal(plan.items.find((it) => it.path === 'docs/a.md')!.action, 'delete');
});

test('A3. 다른 활성 태스크가 같은 경로를 참조하면 shared-with-active-task 로 skip 하고 heldBy 에 ID 기록', () => {
  const done = makeTask({ id: 't-done', relatedDocs: ['docs/shared.md', 'docs/solo.md'] });
  const other = makeTask({
    id: 't-active',
    status: 'in-progress',
    relatedDocs: ['docs/shared.md'],
  });
  const plan = planTaskDocCleanup(done, [done, other]);
  const shared = plan.items.find((it) => it.path === 'docs/shared.md')!;
  assert.equal(shared.action, 'skip');
  assert.equal(shared.reason, 'shared-with-active-task');
  assert.deepEqual(shared.heldBy, ['t-active']);
  assert.equal(plan.items.find((it) => it.path === 'docs/solo.md')!.action, 'delete');
});

test('A4. 완료된 다른 태스크가 같은 경로를 갖고 있어도 홀드로 간주하지 않음', () => {
  const done = makeTask({ id: 't-done', relatedDocs: ['docs/x.md'] });
  const alsoDone = makeTask({
    id: 't-archived',
    status: 'completed',
    relatedDocs: ['docs/x.md'],
  });
  const plan = planTaskDocCleanup(done, [done, alsoDone]);
  assert.equal(plan.items[0].action, 'delete', '완료 태스크는 홀더가 아님');
});

test('A5. globalKeep 옵션은 프로젝트 레벨 보존 목록으로 작동', () => {
  const done = makeTask({ id: 't', relatedDocs: ['docs/a.md', 'docs/README.md'] });
  const plan = planTaskDocCleanup(done, [done], { globalKeep: ['docs/README.md'] });
  assert.equal(plan.items.find((it) => it.path === 'docs/README.md')!.reason, 'user-keep-flag');
});

test('A6. 백슬래시 경로(Windows) 도 슬래시로 정규화되어 키가 일치', () => {
  const done = makeTask({ id: 't', relatedDocs: ['docs\\design\\w.md'] });
  const other = makeTask({
    id: 'u',
    status: 'pending',
    relatedDocs: ['docs/design/w.md'],
  });
  const plan = planTaskDocCleanup(done, [done, other]);
  const it = plan.items[0];
  assert.equal(it.path, 'docs/design/w.md');
  assert.equal(it.action, 'skip');
  assert.equal(it.reason, 'shared-with-active-task');
});

// ────────────────────────────────────────────────────────────────────────────
// B. executeTaskDocCleanup
// ────────────────────────────────────────────────────────────────────────────

test('B1. delete 항목만 remove 호출, skip 은 건드리지 않음', async () => {
  const plan: CleanupPlan = {
    taskId: 't1',
    items: [
      { path: 'docs/a.md', action: 'delete' },
      { path: 'docs/b.md', action: 'skip', reason: 'user-keep-flag' },
    ],
  };
  const removed: string[] = [];
  const out = await executeTaskDocCleanup(plan, {
    remove: async (p) => { removed.push(p); },
  });
  assert.deepEqual(removed, ['docs/a.md']);
  assert.deepEqual(out.deleted, ['docs/a.md']);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].reason, 'user-keep-flag');
  assert.equal(out.failed.length, 0);
  assert.equal(out.cancelledByUser, false);
});

test('B2. confirm 이 false 를 반환하면 어떤 경로도 삭제되지 않고 cancelledByUser=true', async () => {
  const plan: CleanupPlan = {
    taskId: 't1',
    items: [{ path: 'docs/a.md', action: 'delete' }],
  };
  let removeCalls = 0;
  const out = await executeTaskDocCleanup(plan, {
    remove: async () => { removeCalls += 1; },
    confirm: async () => false,
  });
  assert.equal(removeCalls, 0);
  assert.equal(out.cancelledByUser, true);
  assert.deepEqual(out.deleted, []);
});

test('B3. snapshot + restore 가 주어지면 undo 로 복원 가능', async () => {
  const plan: CleanupPlan = {
    taskId: 't1',
    items: [
      { path: 'docs/a.md', action: 'delete' },
      { path: 'docs/b.md', action: 'delete' },
    ],
  };
  const live = new Map<string, string>([
    ['docs/a.md', '# A'],
    ['docs/b.md', '# B'],
  ]);
  const out = await executeTaskDocCleanup(plan, {
    snapshot: async (p) => live.get(p)!,
    remove: async (p) => { live.delete(p); },
    restore: async (p, snap) => { live.set(p, snap); },
  });
  assert.deepEqual(out.deleted.sort(), ['docs/a.md', 'docs/b.md']);
  assert.equal(live.has('docs/a.md'), false);
  assert.equal(live.has('docs/b.md'), false);

  const restored = await out.undo();
  assert.deepEqual(restored.sort(), ['docs/a.md', 'docs/b.md']);
  assert.equal(live.get('docs/a.md'), '# A');
  assert.equal(live.get('docs/b.md'), '# B');
});

test('B4. snapshot 실패 시 해당 경로는 failed=snapshot-failed 로 기록되고 삭제되지 않음', async () => {
  const plan: CleanupPlan = {
    taskId: 't1',
    items: [
      { path: 'docs/a.md', action: 'delete' },
      { path: 'docs/b.md', action: 'delete' },
    ],
  };
  const removed: string[] = [];
  const out = await executeTaskDocCleanup(plan, {
    snapshot: async (p) => {
      if (p === 'docs/b.md') throw new Error('io');
      return 'snap';
    },
    remove: async (p) => { removed.push(p); },
    restore: async () => { /* noop */ },
  });
  assert.deepEqual(removed, ['docs/a.md']);
  assert.deepEqual(out.deleted, ['docs/a.md']);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].path, 'docs/b.md');
  assert.equal(out.failed[0].error, 'snapshot-failed');
});

test('B5. remove 가 throw 하면 failed 에 누적, 다른 경로는 계속 진행', async () => {
  const plan: CleanupPlan = {
    taskId: 't1',
    items: [
      { path: 'docs/a.md', action: 'delete' },
      { path: 'docs/b.md', action: 'delete' },
    ],
  };
  const out = await executeTaskDocCleanup(plan, {
    remove: async (p) => {
      if (p === 'docs/a.md') throw new Error('permission denied');
    },
  });
  assert.deepEqual(out.deleted, ['docs/b.md']);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].path, 'docs/a.md');
  assert.match(out.failed[0].error, /permission/);
});

test('B6. onDeleted / onRestored 훅이 UI 토스트에 연결할 수 있도록 순서대로 호출', async () => {
  const plan: CleanupPlan = {
    taskId: 't1',
    items: [{ path: 'docs/a.md', action: 'delete' }],
  };
  const deletedEvents: string[] = [];
  const restoredEvents: string[] = [];
  const store = new Map<string, string>([['docs/a.md', 'body']]);
  const out = await executeTaskDocCleanup(plan, {
    snapshot: async (p) => store.get(p)!,
    remove: async (p) => { store.delete(p); },
    restore: async (p, snap) => { store.set(p, snap); },
    onDeleted: (p) => deletedEvents.push(p),
    onRestored: (p) => restoredEvents.push(p),
  });
  assert.deepEqual(deletedEvents, ['docs/a.md']);
  await out.undo();
  assert.deepEqual(restoredEvents, ['docs/a.md']);
});

// ────────────────────────────────────────────────────────────────────────────
// C. recordTaskDocReference / toggleKeepFlag
// ────────────────────────────────────────────────────────────────────────────

test('C1. recordTaskDocReference 는 docs/ 경로만 누적 + 중복 제거 + 변경 여부 반환', () => {
  const t = makeTask({ id: 't' });
  assert.equal(recordTaskDocReference(t, 'docs/x.md'), true);
  assert.equal(recordTaskDocReference(t, 'docs/x.md'), false, '중복은 변경 없음');
  assert.equal(recordTaskDocReference(t, 'src/index.ts'), false, 'docs/ 밖은 거부');
  assert.equal(recordTaskDocReference(t, 'docs\\y.md'), true, '백슬래시 경로는 정규화 후 추가');
  assert.deepEqual(t.relatedDocs, ['docs/x.md', 'docs/y.md']);
});

test('C2. toggleKeepFlag 는 on/off 를 번갈아 전환', () => {
  const t = makeTask({ id: 't' });
  assert.equal(toggleKeepFlag(t, 'docs/a.md'), true);
  assert.deepEqual(t.keepDocs, ['docs/a.md']);
  assert.equal(toggleKeepFlag(t, 'docs/a.md'), false);
  assert.deepEqual(t.keepDocs, []);
});

test('C3. 통합 — 기록·유지·삭제 시나리오가 한 흐름에서 일관되게 동작', async () => {
  // 두 태스크 t1(완료), t2(진행 중). t1 이 doc1/doc2/doc3 을 기록하고,
  // doc2 는 유지 플래그, doc3 은 t2 가 공유 중. 실행 결과 doc1 만 삭제되어야 한다.
  const t1 = makeTask({ id: 't1', status: 'completed' });
  const t2 = makeTask({ id: 't2', status: 'in-progress' });
  recordTaskDocReference(t1, 'docs/doc1.md');
  recordTaskDocReference(t1, 'docs/doc2.md');
  recordTaskDocReference(t1, 'docs/doc3.md');
  recordTaskDocReference(t2, 'docs/doc3.md');
  toggleKeepFlag(t1, 'docs/doc2.md');

  const plan = planTaskDocCleanup(t1, [t1, t2]);
  const byPath = Object.fromEntries(plan.items.map((it) => [it.path, it]));
  assert.equal(byPath['docs/doc1.md'].action, 'delete');
  assert.equal(byPath['docs/doc2.md'].reason, 'user-keep-flag');
  assert.equal(byPath['docs/doc3.md'].reason, 'shared-with-active-task');

  const store = new Map<string, string>([
    ['docs/doc1.md', '1'],
    ['docs/doc2.md', '2'],
    ['docs/doc3.md', '3'],
  ]);
  const out = await executeTaskDocCleanup(plan, {
    snapshot: async (p) => store.get(p)!,
    remove: async (p) => { store.delete(p); },
    restore: async (p, snap) => { store.set(p, snap); },
  });
  assert.deepEqual(out.deleted, ['docs/doc1.md']);
  assert.equal(store.has('docs/doc1.md'), false);
  assert.equal(store.has('docs/doc2.md'), true);
  assert.equal(store.has('docs/doc3.md'), true);

  const restored = await out.undo();
  assert.deepEqual(restored, ['docs/doc1.md']);
  assert.equal(store.get('docs/doc1.md'), '1');
});
