// 지시 #75971d83 — 태스크 완료 시 관련 docs/ 문서 정리 서비스.
//
// 목적
//   태스크(status='completed') 로 전이되는 순간, 해당 태스크가 참조하던 docs/
//   하위 임시·사인오프 문서를 자동 정리한다. "자동 삭제" 를 말 그대로 즉시 수행하면
//   사용자가 회복할 수 없으므로, 본 모듈은 다음 두 단계를 분리해 설계한다:
//     · planTaskDocCleanup    — 순수 함수. 현재 태스크 전체를 보고 "삭제 후보" 와
//                                "유지(=건너뛰기)" 를 결정. 부작용 없음.
//     · executeTaskDocCleanup — 계획을 받아 실제 remover 로 삭제를 수행하고,
//                                사용자에게 보일 undo 토큰을 반환. 되돌리기 창 안에서
//                                undo() 를 호출하면 이전에 보관된 콘텐츠를 복원.
//
// 안전 장치(지시에서 요구한 ①②③)
//   ① 다른 활성 태스크(status !== 'completed') 가 동일 경로를 relatedDocs 에 갖고
//      있으면 건너뛴다(= 공유 문서는 마지막 태스크가 끝날 때까지 살린다).
//   ② task.keepDocs 에 포함된 경로는 보존(= 사용자가 '유지' 플래그를 건 문서).
//      전역 유지 집합을 주입해 "프로젝트 레벨 보존" 과도 합쳐 판정할 수 있다.
//   ③ 실제 삭제는 remover 를 통해 한 번 실행되고, planItem 별 `restore()` 콜백을
//      모아 반환한다 — 사용자가 UI 에서 '되돌리기' 를 누르면 그 콜백이 호출된다.
//
// 테스트 용이성
//   · 파일 시스템에 닿지 않는 순수 함수(planTaskDocCleanup) 와, remover/restorer 가
//     주입된 executeTaskDocCleanup 두 계층으로 나눠 Node 의 fs 의존을 배제한다.
//   · 서버(taskRunner) 는 fs 기반 remover 를, 브라우저 UI 는 "휴지통 이동" remover 를
//     주입하면 된다.

import type { Task } from '../types';

// ────────────────────────────────────────────────────────────────────────────
// 타입
// ────────────────────────────────────────────────────────────────────────────

export type CleanupSkipReason =
  | 'shared-with-active-task'
  | 'user-keep-flag'
  | 'not-a-docs-path';

export interface CleanupPlanItem {
  /** 정리 대상 문서 경로(예: 'docs/design/foo.md'). */
  path: string;
  /** 'delete' 면 executeTaskDocCleanup 이 실제 remover 를 호출한다. */
  action: 'delete' | 'skip';
  /** action='skip' 인 경우 이유. */
  reason?: CleanupSkipReason;
  /** shared-with-active-task 인 경우 해당 상대 태스크 ID 목록(디버깅/토스트 문구용). */
  heldBy?: string[];
}

export interface CleanupPlan {
  taskId: string;
  items: CleanupPlanItem[];
}

export interface PlanOptions {
  /** 프로젝트 레벨에서 항상 유지해야 하는 경로(예: 'docs/design/README.md'). */
  globalKeep?: readonly string[];
  /** docs/ 이외 경로가 들어왔을 때 무시할지 여부. 기본 true. */
  enforceDocsPrefix?: boolean;
}

export interface ExecutionConfirmInput {
  plan: CleanupPlan;
  deletions: readonly CleanupPlanItem[];
}

export interface ExecutionOptions {
  /** 실제 삭제를 수행. 실패는 throw 하면 해당 경로는 실패로 집계된다. */
  remove(path: string): Promise<void>;
  /**
   * 사용자 확인 게이트(③). 반환값 true 면 진행, false 면 전체 취소.
   * 미지정 시 기본 'auto-proceed' 로 간주(자동 테스트·서버 사이드 정리).
   */
  confirm?: (input: ExecutionConfirmInput) => Promise<boolean>;
  /** 되돌리기에 필요한 원본 스냅샷 로더 — 삭제 직전 호출, 결과가 restore 에 재주입. */
  snapshot?: (path: string) => Promise<string>;
  /** 스냅샷 기반 복원 — remove 의 반대 연산. */
  restore?: (path: string, snapshot: string) => Promise<void>;
  /** 삭제/복원 이벤트 훅(UI 토스트 연결점). */
  onDeleted?: (path: string) => void;
  onRestored?: (path: string) => void;
}

export interface ExecutionOutcome {
  taskId: string;
  deleted: string[];
  skipped: Array<{ path: string; reason: CleanupSkipReason; heldBy?: string[] }>;
  failed: Array<{ path: string; error: string }>;
  /** 사용자가 취소 게이트에서 false 를 반환하면 true. */
  cancelledByUser: boolean;
  /**
   * 되돌리기. 호출하면 deleted 된 경로를 snapshot 기반으로 restore 콜백이
   * 복원한다. snapshot/restore 가 주어지지 않았으면 no-op 로 동작하며,
   * 반환값은 실제 복원된 경로 배열.
   */
  undo: () => Promise<string[]>;
}

// ────────────────────────────────────────────────────────────────────────────
// 1) 계획 수립
// ────────────────────────────────────────────────────────────────────────────

function isDocsPath(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  return norm.startsWith('docs/');
}

/**
 * 완료된 태스크의 relatedDocs 를 순회해 각 경로에 대해 'delete' / 'skip' 판정.
 * 부작용 없는 순수 함수이며 다음 규칙을 적용한다:
 *   · docs/ prefix 가 아닌 경로는 'not-a-docs-path' 로 skip(실수 보호).
 *   · task.keepDocs 또는 options.globalKeep 포함 → 'user-keep-flag' 로 skip.
 *   · 다른 활성(= status !== 'completed') 태스크가 동일 경로를 relatedDocs 에
 *     갖고 있으면 'shared-with-active-task' 로 skip, 해당 태스크 ID 를 heldBy 에 담는다.
 */
export function planTaskDocCleanup(
  completedTask: Task,
  allTasks: readonly Task[],
  options: PlanOptions = {},
): CleanupPlan {
  const docs = Array.from(new Set((completedTask.relatedDocs ?? []).map((p) => p.replace(/\\/g, '/'))));
  const enforcePrefix = options.enforceDocsPrefix !== false;
  const keepSet = new Set<string>([
    ...(completedTask.keepDocs ?? []),
    ...(options.globalKeep ?? []),
  ].map((p) => p.replace(/\\/g, '/')));

  const activeHolders = new Map<string, string[]>();
  for (const t of allTasks) {
    if (t.id === completedTask.id) continue;
    if (t.status === 'completed') continue;
    for (const raw of t.relatedDocs ?? []) {
      const p = raw.replace(/\\/g, '/');
      const arr = activeHolders.get(p) ?? [];
      arr.push(t.id);
      activeHolders.set(p, arr);
    }
  }

  const items: CleanupPlanItem[] = docs.map((path) => {
    if (enforcePrefix && !isDocsPath(path)) {
      return { path, action: 'skip', reason: 'not-a-docs-path' };
    }
    if (keepSet.has(path)) {
      return { path, action: 'skip', reason: 'user-keep-flag' };
    }
    const heldBy = activeHolders.get(path);
    if (heldBy && heldBy.length > 0) {
      return { path, action: 'skip', reason: 'shared-with-active-task', heldBy };
    }
    return { path, action: 'delete' };
  });

  return { taskId: completedTask.id, items };
}

// ────────────────────────────────────────────────────────────────────────────
// 2) 실행(+ undo)
// ────────────────────────────────────────────────────────────────────────────

/**
 * planTaskDocCleanup 의 결과를 실제 remover 로 실행한다. 삭제 직전 snapshot 이
 * 주어지면 그 결과를 캡처해 undo 시점에 restore 콜백으로 넘겨 복원한다.
 *
 * 삭제 전에 options.confirm 게이트가 false 를 반환하면 전체 작업을 취소하고
 * ExecutionOutcome.cancelledByUser=true 로 표식한다.
 */
export async function executeTaskDocCleanup(
  plan: CleanupPlan,
  options: ExecutionOptions,
): Promise<ExecutionOutcome> {
  const deletions = plan.items.filter((it) => it.action === 'delete');
  const skipped = plan.items
    .filter((it) => it.action === 'skip' && it.reason)
    .map((it) => ({ path: it.path, reason: it.reason!, heldBy: it.heldBy }));

  if (options.confirm && deletions.length > 0) {
    const proceed = await options.confirm({ plan, deletions });
    if (!proceed) {
      return {
        taskId: plan.taskId,
        deleted: [],
        skipped,
        failed: [],
        cancelledByUser: true,
        undo: async () => [],
      };
    }
  }

  const snapshots = new Map<string, string>();
  const deleted: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  for (const item of deletions) {
    try {
      if (options.snapshot) {
        try {
          const snap = await options.snapshot(item.path);
          snapshots.set(item.path, snap);
        } catch {
          // 스냅샷 실패는 '되돌리기 불가' 로 표시하고 삭제 자체는 진행하지 않는다 —
          // undo 보장이 어긋나면 사용자에게 약속한 ③ 를 지킬 수 없기 때문이다.
          failed.push({ path: item.path, error: 'snapshot-failed' });
          continue;
        }
      }
      await options.remove(item.path);
      deleted.push(item.path);
      options.onDeleted?.(item.path);
    } catch (err) {
      failed.push({ path: item.path, error: (err as Error).message });
    }
  }

  const undo: ExecutionOutcome['undo'] = async () => {
    if (!options.restore) return [];
    const restored: string[] = [];
    for (const path of deleted) {
      const snap = snapshots.get(path);
      if (snap === undefined) continue;
      try {
        await options.restore(path, snap);
        restored.push(path);
        options.onRestored?.(path);
      } catch {
        // 한 건 실패가 다른 복원으로 번지지 않게 한다.
      }
    }
    return restored;
  };

  return {
    taskId: plan.taskId,
    deleted,
    skipped,
    failed,
    cancelledByUser: false,
    undo,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 3) 참조 기록 헬퍼
// ────────────────────────────────────────────────────────────────────────────

/**
 * 에이전트 작업 중 docs/ 경로를 생성·참조했을 때 태스크의 relatedDocs 에 중복 없이
 * 추가한다. 반환값은 변경이 실제 발생했는지 여부 — 호출자가 DB update 를 건너뛸
 * 수 있도록 한다.
 */
export function recordTaskDocReference(task: Task, docPath: string): boolean {
  const norm = docPath.replace(/\\/g, '/');
  if (!isDocsPath(norm)) return false;
  const list = task.relatedDocs ?? [];
  if (list.includes(norm)) return false;
  task.relatedDocs = [...list, norm];
  return true;
}

/**
 * 사용자가 '유지' 플래그를 토글할 때 호출. 이미 keep 이면 해제, 아니면 추가.
 * 반환값은 변경 후 keep 여부(true=유지 중, false=해제됨).
 */
export function toggleKeepFlag(task: Task, docPath: string): boolean {
  const norm = docPath.replace(/\\/g, '/');
  const list = task.keepDocs ?? [];
  if (list.includes(norm)) {
    task.keepDocs = list.filter((p) => p !== norm);
    return false;
  }
  task.keepDocs = [...list, norm];
  return true;
}
