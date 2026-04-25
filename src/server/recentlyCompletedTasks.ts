// 지시 #06aa5c30 — 자동 커밋 메시지 빌더(commitMessageBuilder, Thanos 작업) 가
// 동기적으로 조회할 "최근 완료 태스크 버퍼" 를 제공한다.
//
// 배경
//   server.ts 의 자동 커밋 경로(task.completed PATCH 훅 + allAgentsCompletedWatcher)
//   는 buildAutoCommitMessage 에 넘길 "직전 사이클 동안 어떤 에이전트가 어떤 태스크를
//   끝냈는가" 를 메모리에 보관할 곳이 없다. tasksCol(MongoDB) 조회는 비동기이므로
//   commitMessageBuilder 가 동기적으로 끄집어 쓰기 어렵고, 매 커밋 직전 이력 SELECT 로
//   왕복하면 N+1 회귀가 쉽게 난다.
//
// 본 모듈은 단일 프로세스(server.ts) 안에서 in-memory Map<projectId, RecentlyCompletedTask[]>
// 를 유지해 다음 두 사용처를 동시에 만족한다.
//   1) record(): task.completed 훅이 1줄 호출로 사이클 큐에 push. 비동기 I/O 없음.
//   2) get():    commit 직전 commitMessageBuilder 가 동기 조회. consumed=false 항목만 반환.
//   3) consume(): commit 성공 후 호출해 사이클 플래그를 일괄 true 로 전이. 다음 조회는
//                  같은 항목을 다시 보지 않아, 동일 변경이 후속 커밋 본문에 중복 등장
//                  하지 않는다. 명시적 sinceTs 가 들어오면 그 이후 항목만 골라 소비한다.
//
// 동시성 메모: server.ts 는 단일 Node 프로세스 + 메인 이벤트 루프 위에서 동작하고
// 본 함수들은 모두 동기 코드 경로다. 따라서 별도 잠금/원자 연산이 필요하지 않다.
// 다중 프로세스 워커(예: cluster) 도입 시에는 본 모듈 자체로는 일관성이 깨지므로,
// 그 경우 외부 저장소(Redis 등) 어댑터로 교체해야 한다.

export interface RecordedCompletedTaskInput {
  /** 프로젝트 식별자(MongoDB Project.id). */
  readonly projectId: string;
  /** 태스크 식별자(중복 push 방지용). 미지정 시 자동 생성. */
  readonly taskId?: string;
  /** 에이전트 표시 이름. 빈 문자열은 'unknown' 으로 정규화된다. */
  readonly agent: string;
  /** 태스크 한 줄 요약(또는 description). */
  readonly summary: string;
  /** Conventional Commits type 강제값(선택). 미지정이면 빌더가 추론. */
  readonly type?: string;
  /** 워크스페이스 루트 기준 변경 파일 경로. 미지정이면 빈 배열. */
  readonly changedFiles?: readonly string[];
  /** 완료 시각(epoch ms). 미지정 시 Date.now(). 테스트 주입용으로 분리. */
  readonly completedAt?: number;
}

export interface RecentlyCompletedTask {
  readonly projectId: string;
  readonly taskId: string;
  readonly agent: string;
  readonly summary: string;
  readonly type?: string;
  readonly changedFiles: readonly string[];
  readonly completedAt: number;
  /** consumeRecentlyCompletedTasks 가 true 로 전이시키는 사이클 플래그. */
  consumed: boolean;
}

// 모듈 전역 버퍼. projectId → 시간 오름차순 RecentlyCompletedTask 배열.
// 다중 프로세스 환경이면 외부 저장소로 교체해야 한다(상단 동시성 메모 참조).
const buffers = new Map<string, RecentlyCompletedTask[]>();

let autoIdCounter = 0;
function autoTaskId(): string {
  autoIdCounter += 1;
  // 결정론적이지만 충돌 위험 없는 짧은 식별자. 테스트가 reset 함수로 0 으로 되돌린다.
  return `auto-${autoIdCounter.toString(36)}`;
}

function normalizeAgent(name: string | undefined): string {
  const trimmed = (name ?? '').replace(/\s+/g, ' ').trim();
  return trimmed || 'unknown';
}

function normalizeChangedFiles(input: readonly string[] | undefined): readonly string[] {
  if (!input || input.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const cleaned = raw.replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function getOrInitBuffer(projectId: string): RecentlyCompletedTask[] {
  let buf = buffers.get(projectId);
  if (!buf) {
    buf = [];
    buffers.set(projectId, buf);
  }
  return buf;
}

/**
 * 완료된 태스크 1건을 버퍼에 push 한다. 동일 (projectId, taskId) 가 이미 있고
 * consumed=false 면 덮어쓰기(최신 changedFiles/summary 로 갱신) — 같은 태스크가
 * 재완료되는 사고성 호출에서 본문이 두 번 등장하는 일을 막는다.
 * consumed=true 였다면 새 사이클 항목으로 추가 push.
 */
export function recordCompletedTask(input: RecordedCompletedTaskInput): RecentlyCompletedTask {
  if (!input.projectId) {
    throw new Error('recordCompletedTask: projectId 가 필요합니다');
  }
  const buf = getOrInitBuffer(input.projectId);
  const taskId = input.taskId && input.taskId.trim() ? input.taskId.trim() : autoTaskId();
  const completedAt = input.completedAt ?? Date.now();
  const entry: RecentlyCompletedTask = {
    projectId: input.projectId,
    taskId,
    agent: normalizeAgent(input.agent),
    summary: (input.summary ?? '').trim(),
    type: input.type && input.type.trim() ? input.type.trim().toLowerCase() : undefined,
    changedFiles: normalizeChangedFiles(input.changedFiles),
    completedAt,
    consumed: false,
  };
  // 같은 taskId 가 미소비 상태로 살아 있으면 덮어쓴다(중복 push 방지).
  const idx = buf.findIndex(t => t.taskId === taskId && !t.consumed);
  if (idx >= 0) {
    buf[idx] = entry;
  } else {
    buf.push(entry);
  }
  return entry;
}

export interface GetRecentlyCompletedTasksOptions {
  /** 이 시각(epoch ms) 이상에 완료된 항목만. 미지정 시 0 — 즉 모든 미소비 항목. */
  readonly sinceTs?: number;
  /** consumed=true 항목까지 포함할지. 기본 false. 디버그/감사 시 true 로. */
  readonly includeConsumed?: boolean;
}

/**
 * 동기 selector — commitMessageBuilder 가 직전 사이클의 완료 태스크를 즉시 끄집어
 * 쓸 수 있게 한다. 결과는 buffer 의 직접 참조가 아니라 얕은 복사 배열이라
 * 외부에서 mutate 해도 내부 상태가 깨지지 않는다.
 */
export function getRecentlyCompletedTasks(
  projectId: string,
  options: GetRecentlyCompletedTasksOptions = {},
): readonly RecentlyCompletedTask[] {
  const buf = buffers.get(projectId);
  if (!buf || buf.length === 0) return [];
  const since = options.sinceTs ?? 0;
  const includeConsumed = options.includeConsumed === true;
  const out: RecentlyCompletedTask[] = [];
  for (const t of buf) {
    if (t.completedAt < since) continue;
    if (!includeConsumed && t.consumed) continue;
    out.push(t);
  }
  return out;
}

export interface ConsumeOptions {
  /** 이 시각(epoch ms) 이전(=이하)인 항목만 소비. 기본 Infinity — 모두. */
  readonly beforeTs?: number;
}

/**
 * 커밋 단계가 성공한 직후 호출. consumed=false 인 항목 중 beforeTs 이하인 항목을
 * 일괄 true 로 전이하고, 같은 사이클의 결과를 한꺼번에 반환한다.
 * 호출 후에는 getRecentlyCompletedTasks 가 동일 항목을 더 이상 노출하지 않는다.
 */
export function consumeRecentlyCompletedTasks(
  projectId: string,
  options: ConsumeOptions = {},
): readonly RecentlyCompletedTask[] {
  const buf = buffers.get(projectId);
  if (!buf || buf.length === 0) return [];
  const before = options.beforeTs ?? Number.POSITIVE_INFINITY;
  const consumed: RecentlyCompletedTask[] = [];
  for (const t of buf) {
    if (t.consumed) continue;
    if (t.completedAt > before) continue;
    t.consumed = true;
    consumed.push(t);
  }
  return consumed;
}

/**
 * 프로젝트 단위 버퍼를 통째로 제거한다. 프로젝트 삭제(/api/projects/:id DELETE) 같은
 * 사건 발생 시 메모리 누수를 막기 위해 호출한다.
 */
export function clearRecentlyCompletedTasks(projectId?: string): void {
  if (projectId === undefined) {
    buffers.clear();
  } else {
    buffers.delete(projectId);
  }
}

/** 테스트 전용 — 모든 버퍼와 자동 ID 카운터를 리셋한다. */
export function __resetRecentlyCompletedTasksForTests(): void {
  buffers.clear();
  autoIdCounter = 0;
}
