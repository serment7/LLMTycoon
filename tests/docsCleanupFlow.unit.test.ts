// Run with: npx tsx --test tests/docsCleanupFlow.unit.test.ts
//
// 지시 #7a3713f3 ② — 태스크 완료 시 docs/ 하위 연관 문서 자동 삭제 플로우 회귀 잠금.
//
// 배경
//   태스크가 completed 로 전이되면 taskDocCleanupService 가 relatedDocs 를 순회해
//   "더 이상 필요 없는" docs/ 임시·사인오프 문서를 정리한다. 즉시 삭제가 아니라 다음
//   세 단계의 안전 장치를 거친다.
//     ① 다른 활성 태스크(status !== 'completed')가 같은 경로를 참조하면 보존
//        ('shared-with-active-task').
//     ② task.keepDocs 또는 options.globalKeep 에 들어간 경로는 보존
//        ('user-keep-flag').
//     ③ 실행은 snapshot → remove 순서이고, 결과의 undo() 가 restore 콜백을 통해
//        복원 가능.
//
// 잠금 축
//   DC1. 기본 — 완료 태스크의 docs/ 경로가 모두 delete 로 계획된다.
//   DC2. 다른 태스크 참조 시 보존 — 활성 태스크가 heldBy 에 기록된다.
//   DC3. keepDocs 플래그 보존 — user-keep-flag 로 skip.
//   DC4. 사용자 되돌리기 — execute 후 undo() 가 snapshot 기반으로 복원한다.
//   DC5. 다건 연쇄 삭제 — 앞 태스크 완료 시점엔 뒷 태스크가 보존, 뒷 태스크도
//        완료되면 그 경로가 비로소 실질 삭제 대상이 된다.
//   DC6. docs/ 접두사가 아닌 경로는 무시(not-a-docs-path) — 실수 보호.
//   DC7. globalKeep 주입 — 프로젝트 레벨 보존과 합쳐 판정.
//   DC8. confirm 게이트 false → 전체 취소(cancelledByUser=true), 삭제 0건.
//   DC9. snapshot 실패 → 해당 경로는 failed 로 집계되고 remove 호출 자체가 스킵.
//   DC10. recordTaskDocReference / toggleKeepFlag 보조 API 계약.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planTaskDocCleanup,
  executeTaskDocCleanup,
  recordTaskDocReference,
  toggleKeepFlag,
  type CleanupPlan,
} from '../src/services/taskDocCleanupService.ts';
import type { Task } from '../src/types.ts';

function makeTask(partial: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    id: partial.id,
    projectId: partial.projectId ?? 'P1',
    assignedTo: partial.assignedTo ?? 'Kai',
    description: partial.description ?? `task-${partial.id}`,
    status: partial.status ?? 'in-progress',
    relatedDocs: partial.relatedDocs,
    keepDocs: partial.keepDocs,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// DC1. 기본 시나리오
// ────────────────────────────────────────────────────────────────────────────

test('DC1. 완료 태스크의 docs/ 경로가 모두 delete 로 계획됨(다른 참조/keep 없음)', () => {
  const done = makeTask({
    id: 't1', status: 'completed',
    relatedDocs: ['docs/design/foo.md', 'docs/qa/bar.md'],
  });
  const plan = planTaskDocCleanup(done, [done]);
  assert.equal(plan.taskId, 't1');
  assert.equal(plan.items.length, 2);
  for (const it of plan.items) {
    assert.equal(it.action, 'delete');
    assert.equal(it.reason, undefined);
  }
  assert.deepEqual(plan.items.map((i) => i.path).sort(), ['docs/design/foo.md', 'docs/qa/bar.md']);
});

// ────────────────────────────────────────────────────────────────────────────
// DC2. 다른 활성 태스크 참조 시 보존
// ────────────────────────────────────────────────────────────────────────────

test('DC2. 활성 태스크가 동일 docs/ 경로를 참조 중 → shared-with-active-task 로 skip, heldBy 기록', () => {
  const done = makeTask({
    id: 't1', status: 'completed',
    relatedDocs: ['docs/spec/shared.md', 'docs/spec/solo.md'],
  });
  const active = makeTask({
    id: 't2', status: 'in-progress',
    relatedDocs: ['docs/spec/shared.md'],
  });
  const another = makeTask({
    id: 't3', status: 'pending',
    relatedDocs: ['docs/spec/shared.md'],
  });
  const plan = planTaskDocCleanup(done, [done, active, another]);
  const shared = plan.items.find((i) => i.path === 'docs/spec/shared.md')!;
  const solo = plan.items.find((i) => i.path === 'docs/spec/solo.md')!;
  assert.equal(shared.action, 'skip');
  assert.equal(shared.reason, 'shared-with-active-task');
  assert.deepEqual(shared.heldBy?.sort(), ['t2', 't3']);
  assert.equal(solo.action, 'delete', '다른 참조 없는 경로는 정상적으로 삭제 대상');
});

test('DC2b. 이미 completed 인 다른 태스크는 보존 사유가 아님', () => {
  const done = makeTask({
    id: 't1', status: 'completed',
    relatedDocs: ['docs/design/finished.md'],
  });
  const alreadyDone = makeTask({
    id: 't0', status: 'completed',
    relatedDocs: ['docs/design/finished.md'],
  });
  const plan = planTaskDocCleanup(done, [done, alreadyDone]);
  const [only] = plan.items;
  assert.equal(only.action, 'delete', 'completed 끼리는 서로를 보존 사유로 삼지 않음');
});

// ────────────────────────────────────────────────────────────────────────────
// DC3. keepDocs 플래그 보존
// ────────────────────────────────────────────────────────────────────────────

test('DC3. task.keepDocs 포함 경로 → user-keep-flag 로 skip, 다른 태스크 참조보다 우선', () => {
  const done = makeTask({
    id: 't1', status: 'completed',
    relatedDocs: ['docs/sign-off/a.md', 'docs/sign-off/b.md'],
    keepDocs: ['docs/sign-off/a.md'],
  });
  const active = makeTask({
    id: 't2', status: 'in-progress',
    relatedDocs: ['docs/sign-off/a.md'], // keep 플래그가 우선함을 확인
  });
  const plan = planTaskDocCleanup(done, [done, active]);
  const a = plan.items.find((i) => i.path === 'docs/sign-off/a.md')!;
  const b = plan.items.find((i) => i.path === 'docs/sign-off/b.md')!;
  assert.equal(a.action, 'skip');
  assert.equal(a.reason, 'user-keep-flag');
  assert.equal(a.heldBy, undefined, 'keep 이면 heldBy 기록하지 않음');
  assert.equal(b.action, 'delete');
});

// ────────────────────────────────────────────────────────────────────────────
// DC4. 사용자 되돌리기
// ────────────────────────────────────────────────────────────────────────────

test('DC4. execute 후 undo() 가 snapshot 기반으로 복원하고 onRestored 훅을 쏘며 복원된 경로를 반환', async () => {
  const done = makeTask({
    id: 't1', status: 'completed',
    relatedDocs: ['docs/temp/x.md', 'docs/temp/y.md'],
  });
  const plan = planTaskDocCleanup(done, [done]);

  const fs = new Map<string, string>([
    ['docs/temp/x.md', 'content-X'],
    ['docs/temp/y.md', 'content-Y'],
  ]);
  const deletedLog: string[] = [];
  const restoredLog: string[] = [];

  const outcome = await executeTaskDocCleanup(plan, {
    async remove(path) {
      if (!fs.has(path)) throw new Error(`enoent: ${path}`);
      fs.delete(path);
    },
    async snapshot(path) {
      const v = fs.get(path);
      if (v === undefined) throw new Error('missing');
      return v;
    },
    async restore(path, snapshot) {
      fs.set(path, snapshot);
    },
    onDeleted: (p) => deletedLog.push(p),
    onRestored: (p) => restoredLog.push(p),
  });

  assert.deepEqual(outcome.deleted.sort(), ['docs/temp/x.md', 'docs/temp/y.md']);
  assert.equal(outcome.cancelledByUser, false);
  assert.equal(outcome.failed.length, 0);
  assert.equal(fs.size, 0, '실행 단계 후 파일이 모두 삭제');
  assert.deepEqual(deletedLog.sort(), ['docs/temp/x.md', 'docs/temp/y.md']);

  // 되돌리기 — snapshot 이 있으므로 두 건 모두 복원되어야 한다.
  const restored = await outcome.undo();
  assert.deepEqual(restored.sort(), ['docs/temp/x.md', 'docs/temp/y.md']);
  assert.deepEqual(restoredLog.sort(), ['docs/temp/x.md', 'docs/temp/y.md']);
  assert.equal(fs.get('docs/temp/x.md'), 'content-X');
  assert.equal(fs.get('docs/temp/y.md'), 'content-Y');
});

test('DC4b. restore 콜백이 주어지지 않으면 undo 는 no-op (빈 배열)', async () => {
  const done = makeTask({
    id: 't1', status: 'completed',
    relatedDocs: ['docs/temp/only.md'],
  });
  const plan = planTaskDocCleanup(done, [done]);
  const outcome = await executeTaskDocCleanup(plan, {
    async remove() { /* 성공 */ },
    // snapshot/restore 둘 다 미주입.
  });
  assert.deepEqual(outcome.deleted, ['docs/temp/only.md']);
  const restored = await outcome.undo();
  assert.deepEqual(restored, []);
});

// ────────────────────────────────────────────────────────────────────────────
// DC5. 다건 연쇄 삭제
// ────────────────────────────────────────────────────────────────────────────

test('DC5. 공유 문서는 앞 태스크 완료 시점엔 보존, 뒷 태스크가 완료되는 순간 비로소 삭제 대상', () => {
  const shared = 'docs/design/shared-handoff.md';

  // 시점 1: t1 이 completed, t2 는 아직 in-progress 로 shared 를 참조 중.
  const t1Done = makeTask({
    id: 't1', status: 'completed',
    relatedDocs: [shared, 'docs/design/t1-only.md'],
  });
  const t2Active = makeTask({
    id: 't2', status: 'in-progress',
    relatedDocs: [shared, 'docs/design/t2-only.md'],
  });
  const plan1 = planTaskDocCleanup(t1Done, [t1Done, t2Active]);
  const sharedIn1 = plan1.items.find((i) => i.path === shared)!;
  const t1OnlyIn1 = plan1.items.find((i) => i.path === 'docs/design/t1-only.md')!;
  assert.equal(sharedIn1.action, 'skip', 't2 가 참조 중이므로 shared 는 보존');
  assert.deepEqual(sharedIn1.heldBy, ['t2']);
  assert.equal(t1OnlyIn1.action, 'delete', 't1 단독 경로는 즉시 삭제 대상');

  // 시점 2: t2 도 completed 로 전이. 이제 활성 참조자가 없으므로 shared 는 삭제.
  const t2Done = makeTask({ ...t2Active, status: 'completed' });
  const plan2 = planTaskDocCleanup(t2Done, [t1Done, t2Done]);
  const sharedIn2 = plan2.items.find((i) => i.path === shared)!;
  const t2OnlyIn2 = plan2.items.find((i) => i.path === 'docs/design/t2-only.md')!;
  assert.equal(sharedIn2.action, 'delete', '마지막 참조자가 빠져 shared 도 삭제 대상');
  assert.equal(t2OnlyIn2.action, 'delete');
});

// ────────────────────────────────────────────────────────────────────────────
// DC6~DC9. 안전 장치 / 옵션
// ────────────────────────────────────────────────────────────────────────────

test('DC6. docs/ 접두사가 아닌 경로는 not-a-docs-path 로 skip(실수 보호)', () => {
  const done = makeTask({
    id: 't1', status: 'completed',
    relatedDocs: ['docs/ok.md', 'src/accidental.ts', '../escape.md'],
  });
  const plan = planTaskDocCleanup(done, [done]);
  const rogue = plan.items.find((i) => i.path === 'src/accidental.ts')!;
  const escape = plan.items.find((i) => i.path === '../escape.md')!;
  const ok = plan.items.find((i) => i.path === 'docs/ok.md')!;
  assert.equal(rogue.action, 'skip');
  assert.equal(rogue.reason, 'not-a-docs-path');
  assert.equal(escape.action, 'skip');
  assert.equal(escape.reason, 'not-a-docs-path');
  assert.equal(ok.action, 'delete');
});

test('DC7. options.globalKeep 도 keep 사유로 잡힌다', () => {
  const done = makeTask({
    id: 't1', status: 'completed',
    relatedDocs: ['docs/readme.md', 'docs/delete-me.md'],
  });
  const plan = planTaskDocCleanup(done, [done], { globalKeep: ['docs/readme.md'] });
  const readme = plan.items.find((i) => i.path === 'docs/readme.md')!;
  const delMe = plan.items.find((i) => i.path === 'docs/delete-me.md')!;
  assert.equal(readme.action, 'skip');
  assert.equal(readme.reason, 'user-keep-flag');
  assert.equal(delMe.action, 'delete');
});

test('DC8. confirm 게이트가 false 를 반환하면 전체 취소, 삭제 0건 · cancelledByUser=true', async () => {
  const done = makeTask({
    id: 't1', status: 'completed',
    relatedDocs: ['docs/a.md', 'docs/b.md'],
  });
  const plan = planTaskDocCleanup(done, [done]);
  let removeCalled = 0;
  const outcome = await executeTaskDocCleanup(plan, {
    async remove() { removeCalled += 1; },
    async confirm() { return false; },
  });
  assert.equal(outcome.cancelledByUser, true);
  assert.deepEqual(outcome.deleted, []);
  assert.equal(removeCalled, 0, '사용자 취소 시 remove 호출 금지');
});

test('DC9. snapshot 실패 → 해당 경로는 failed(snapshot-failed) 로 집계, remove 는 호출되지 않음', async () => {
  const done = makeTask({
    id: 't1', status: 'completed',
    relatedDocs: ['docs/ok.md', 'docs/broken.md'],
  });
  const plan = planTaskDocCleanup(done, [done]);
  const removeCalls: string[] = [];
  const outcome = await executeTaskDocCleanup(plan, {
    async remove(path) { removeCalls.push(path); },
    async snapshot(path) {
      if (path === 'docs/broken.md') throw new Error('read error');
      return 'snap-of-' + path;
    },
    async restore() { /* not exercised */ },
  });
  assert.deepEqual(outcome.deleted, ['docs/ok.md']);
  assert.deepEqual(outcome.failed, [{ path: 'docs/broken.md', error: 'snapshot-failed' }]);
  assert.deepEqual(removeCalls, ['docs/ok.md'], 'snapshot 실패 경로는 remove 호출되지 않아 복원 약속이 깨지지 않음');
});

// ────────────────────────────────────────────────────────────────────────────
// DC10. 보조 API — 참조 기록 · keep 토글
// ────────────────────────────────────────────────────────────────────────────

test('DC10. recordTaskDocReference — docs/ 경로만 누적, 중복은 false 반환', () => {
  const task = makeTask({ id: 't1' });
  assert.equal(recordTaskDocReference(task, 'docs/a.md'), true);
  assert.equal(recordTaskDocReference(task, 'docs/a.md'), false, '중복은 변경 없음');
  assert.equal(recordTaskDocReference(task, 'src/x.ts'), false, 'docs/ 외 경로는 무시');
  // 역슬래시 경로도 정규화되어 저장된다.
  assert.equal(recordTaskDocReference(task, 'docs\\b.md'), true);
  assert.deepEqual(task.relatedDocs, ['docs/a.md', 'docs/b.md']);
});

test('DC10b. toggleKeepFlag — 추가/해제 반복, 반환값이 최종 keep 상태', () => {
  const task = makeTask({ id: 't1', relatedDocs: ['docs/a.md'] });
  assert.equal(toggleKeepFlag(task, 'docs/a.md'), true);
  assert.deepEqual(task.keepDocs, ['docs/a.md']);
  assert.equal(toggleKeepFlag(task, 'docs/a.md'), false);
  assert.deepEqual(task.keepDocs, []);
});

// ────────────────────────────────────────────────────────────────────────────
// 타입 재확인 — CleanupPlan 의 최소 계약(리팩터링 시 외부 소비자 보호)
// ────────────────────────────────────────────────────────────────────────────

test('CleanupPlan 타입은 taskId 와 items 를 외부에 노출한다', () => {
  const plan: CleanupPlan = { taskId: 't1', items: [] };
  assert.equal(plan.taskId, 't1');
  assert.ok(Array.isArray(plan.items));
});
