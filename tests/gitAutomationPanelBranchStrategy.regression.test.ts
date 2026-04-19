// Run with: npx tsx --test tests/gitAutomationPanelBranchStrategy.regression.test.ts
//
// QA 회귀(#1a33c2ee) — `GitAutomationPanel` 의 "브랜치 전략(branchStrategy) 로드·
// 저장·재오픈" 불변식. 사용자가 네 가지 전략(per-commit / per-task / per-session /
// fixed-branch) 중 하나를 선택한 뒤 프로젝트 관리 탭을 닫았다 다시 열어도, 또한
// 서버 응답이 늦게 도착하는 하이드레이션 레이스 구간에서도, 최종 화면 상태가 서버/
// 스토리지가 보유한 값과 일치해야 한다.
//
// 배경
// ────────────────────────────────────────────────────────────────────────────
// 선행 커밋 1587ea9("fix: ProjectManagement GitAutomationPanel 저장/로드 하이드
// 레이션 레이스 수정") 은 `ProjectManagement.tsx` 래퍼에서 `gitAutomationByProject
// [selectedProjectId] === undefined` 인 동안 패널을 마운트하지 않고, 프로젝트 전환
// 시 `<Fragment key={selectedProjectId}>` 로 강제 재마운트하도록 고쳤다. 본 테스트는
// 그 래퍼 규칙을 "브랜치 전략 축 하나에 집중해" 4가지 시나리오(B1~B4) 로 잠근다.
//
// 직접 React 를 렌더하지 않는 이유
// ────────────────────────────────────────────────────────────────────────────
// `GitAutomationPanel` 자체는 `useReducedMotion` / 다수의 lucide 아이콘 / Tailwind
// 클래스 체인 등 환경 의존이 많아, 현 jsdom 하니스에서 안정적으로 마운트되지
// 않는다는 판단이 선행 테스트(tests/gitAutomationPanel.regression.test.tsx) 에
// 명시돼 있다. 따라서 본 파일은 래퍼+패널의 **상태 기계(state machine)** 를 순수
// TypeScript 시뮬레이터로 재현해 동일한 불변식을 빠르게 잠근다. 시뮬레이터는
// 실제 구현이 바뀌면 함께 옮겨 갈 수 있도록, 래퍼의 로드/마운트/언마운트 규칙을
// 그대로 반영한다.
//
// ┌─ 시나리오 지도 ────────────────────────────────────────────────────────────┐
// │ B1  저장된 branchStrategy 값이 패널 재오픈 시 그대로 선택되어야 한다        │
// │ B2  설정 로드 지연(비동기) 에도 최종 상태가 서버/스토리지 값과 일치        │
// │ B3  사용자가 값 변경 후 탭 전환해도 저장값이 기본값으로 되돌아가지 않는다   │
// │ B4  fixed-branch + newBranchName 조합도 재오픈 후 그대로 보존된다           │
// └─────────────────────────────────────────────────────────────────────────────┘

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  DEFAULT_AUTOMATION,
  type GitAutomationSettings,
} from '../src/components/GitAutomationPanel.tsx';
import { BRANCH_STRATEGY_VALUES } from '../src/types.ts';
import type { BranchStrategy } from '../src/types.ts';

// ---------------------------------------------------------------------------
// 시뮬레이터 — 래퍼(ProjectManagement) + 패널(GitAutomationPanel) 의 상태 기계.
// ---------------------------------------------------------------------------

// 래퍼는 프로젝트별 설정 슬롯을 보관한다. `undefined` 는 "서버 응답 대기 중" 을
// 뜻하며, 이 동안 래퍼는 로딩 박스만 렌더하고 패널은 절대 마운트하지 않는다.
interface WrapperState {
  selectedProjectId: string | null;
  gitAutomationByProject: Record<string, GitAutomationSettings | undefined>;
}

// 패널이 마운트된 순간의 로컬 상태. 마운트 시점의 `initial` 이 `baseline` 으로
// 고정되고, 사용자의 입력은 `choice`/`newBranchName` 에만 반영된다. 저장 시점에
// 래퍼의 in-memory 슬롯으로 값이 올라가며, 프로젝트 전환/탭 이동 시 Fragment
// key 가 바뀌어 패널이 언마운트되면 로컬 상태는 사라진다.
interface PanelLocal {
  projectId: string;
  baseline: GitAutomationSettings;
  choice: BranchStrategy;
  newBranchName: string;
}

function newWrapper(): WrapperState {
  return { selectedProjectId: null, gitAutomationByProject: {} };
}

// 사용자가 프로젝트 관리 탭에서 특정 프로젝트를 선택한다. 처음 진입하는 프로젝트는
// 슬롯이 비어 있으므로(= undefined) 로딩 박스가 먼저 보이게 된다. 두 번째 이상
// 방문에서는 이미 채워진 슬롯이 있으면 그대로 써서 깜빡임 없이 마운트한다.
function selectProject(w: WrapperState, id: string): void {
  w.selectedProjectId = id;
  if (!(id in w.gitAutomationByProject)) {
    w.gitAutomationByProject[id] = undefined;
  }
}

// 비동기 `loadGitAutomationSettings(projectId)` 의 완료 시점을 에뮬레이트한다.
// 실구현은 서버에서 받은 row 를 `fromServerSettings` 로 정규화해 넣지만, 본
// 시뮬레이터는 이미 UI shape 로 변환된 값을 받는다고 가정한다.
function finishLoad(w: WrapperState, id: string, saved: Partial<GitAutomationSettings>): void {
  w.gitAutomationByProject[id] = { ...DEFAULT_AUTOMATION, ...saved };
}

// 래퍼의 렌더 로직을 한 턴 돌린다. 마운트 조건을 모두 만족하면 패널 로컬 상태
// 스냅샷을 돌려주고, 로딩 구간에는 `null` 을 돌려준다. `null` 구간에는 DEFAULT_
// AUTOMATION 으로 덮이는 과거 회귀가 재발하지 않음이 계약이다.
function renderPanel(w: WrapperState): PanelLocal | null {
  const id = w.selectedProjectId;
  if (!id) return null;
  const saved = w.gitAutomationByProject[id];
  if (saved === undefined) return null;
  return {
    projectId: id,
    baseline: saved,
    choice: saved.branchStrategy,
    newBranchName: saved.newBranchName,
  };
}

// 사용자가 라디오 카드를 클릭한다. 패널 내부 useState 에만 반영되며, 저장 전까지는
// 래퍼 슬롯을 건드리지 않는다(= dirty 상태).
function userPick(local: PanelLocal, choice: BranchStrategy, newBranchName?: string): PanelLocal {
  return {
    ...local,
    choice,
    newBranchName: newBranchName ?? local.newBranchName,
  };
}

// 저장 버튼 클릭. 실구현의 `save()` 와 `ProjectManagement.onSave` 파이프라인을
// 축약해, structuredClone 한 결과를 래퍼 슬롯에 반영한다. fixed-branch 외의
// 전략에서는 newBranchName 이 빈 문자열로 초기화되어 저장되는 계약도 함께 잠근다.
function userSave(w: WrapperState, local: PanelLocal): void {
  const next: GitAutomationSettings = {
    ...local.baseline,
    branchStrategy: local.choice,
    newBranchName: local.choice === 'fixed-branch' ? local.newBranchName.trim() : '',
  };
  w.gitAutomationByProject[local.projectId] = structuredClone(next);
}

// ---------------------------------------------------------------------------
// 공용 픽스처.
// ---------------------------------------------------------------------------

const PROJECT_A = 'P-A';
const PROJECT_B = 'P-B';

// ---------------------------------------------------------------------------
// B1 — 저장된 branchStrategy 값이 패널 재오픈 시 그대로 선택된다.
// ---------------------------------------------------------------------------

test('B1 — Given 서버에 branchStrategy="per-task" 저장된 프로젝트 When 패널을 처음 마운트 Then 해당 라디오가 선택된 상태로 시작된다', () => {
  // Given
  const w = newWrapper();
  selectProject(w, PROJECT_A);
  finishLoad(w, PROJECT_A, { branchStrategy: 'per-task' });

  // When
  const local = renderPanel(w);

  // Then
  assert.ok(local, '로드 완료 후 패널이 마운트되어야 한다');
  assert.equal(local!.choice, 'per-task', '저장된 전략이 baseline 으로 반영되어야 한다');
  assert.notEqual(
    local!.choice,
    DEFAULT_AUTOMATION.branchStrategy,
    'DEFAULT_AUTOMATION.branchStrategy 로 덮이면 회귀 재발(1587ea9)',
  );
});

test('B1 회귀 — 같은 프로젝트를 여러 번 재진입해도 선택값은 서버 저장값과 동일하다', () => {
  const w = newWrapper();
  selectProject(w, PROJECT_A);
  finishLoad(w, PROJECT_A, { branchStrategy: 'per-commit' });
  assert.equal(renderPanel(w)!.choice, 'per-commit');

  // 탭 전환 후 복귀 — 슬롯이 남아 있어 깜빡임 없이 즉시 마운트.
  selectProject(w, PROJECT_B);
  finishLoad(w, PROJECT_B, {}); // default: per-session
  assert.equal(renderPanel(w)!.choice, DEFAULT_AUTOMATION.branchStrategy);

  selectProject(w, PROJECT_A);
  assert.equal(
    renderPanel(w)!.choice,
    'per-commit',
    '이미 채워진 슬롯은 다시 로드를 기다리지 않고 원래 값을 복원해야 한다',
  );
});

// ---------------------------------------------------------------------------
// B2 — 설정 로드가 지연되는 비동기 상황에서도 최종 상태가 서버 값과 일치한다.
// ---------------------------------------------------------------------------

test('B2 — Given 프로젝트 선택 직후 로드 미완료 When 래퍼가 렌더 Then 패널은 마운트되지 않아 DEFAULT 로 덮이지 않는다', () => {
  const w = newWrapper();
  selectProject(w, PROJECT_A);

  // 로드 완료 전 — 패널은 아직 마운트되어서는 안 된다(1587aa9 ②).
  assert.equal(
    renderPanel(w),
    null,
    '로드 전에는 패널을 띄우지 않아야 한다 — 띄우면 DEFAULT_AUTOMATION 으로 초기 state 가 고정된다',
  );

  // 서버 응답이 늦게(예: 수백 ms 뒤) 도착.
  finishLoad(w, PROJECT_A, { branchStrategy: 'per-commit' });
  const local = renderPanel(w);
  assert.ok(local, '로드 완료 후 패널이 마운트되어야 한다');
  assert.equal(local!.choice, 'per-commit', '최종 상태는 서버 값 per-commit 과 일치해야 한다');
});

test('B2 회귀 — 로드 지연이 두 프로젝트에 걸쳐 교차해도 각 패널은 자신의 서버 값으로 수렴한다', () => {
  // 시나리오: A 선택 → B 선택(A 로드 아직 안 끝남) → A 로드 완료 → B 로드 완료.
  // 사용자가 결국 보고 있는 프로젝트의 패널은 그 프로젝트의 서버 값으로 마운트.
  const w = newWrapper();
  selectProject(w, PROJECT_A);
  selectProject(w, PROJECT_B);
  assert.equal(renderPanel(w), null, 'B 로드 전에는 B 패널도 마운트되지 않는다');

  // A 로드만 먼저 도착해도 지금 보이는 건 B → 여전히 null.
  finishLoad(w, PROJECT_A, { branchStrategy: 'per-task' });
  assert.equal(renderPanel(w), null, 'A 로드가 먼저 끝나도 현재 B 가 선택돼 있으면 B 패널은 아직 로딩');

  // B 로드 완료 — B 패널이 B 값으로 마운트.
  finishLoad(w, PROJECT_B, { branchStrategy: 'fixed-branch', newBranchName: 'release/x' });
  const nowB = renderPanel(w)!;
  assert.equal(nowB.choice, 'fixed-branch');
  assert.equal(nowB.newBranchName, 'release/x');

  // 사용자가 A 로 되돌아오면 A 값으로 수렴.
  selectProject(w, PROJECT_A);
  assert.equal(renderPanel(w)!.choice, 'per-task');
});

// ---------------------------------------------------------------------------
// B3 — 사용자가 값을 변경하고 탭을 전환해도 방금 바꾼 값이 기본값으로 되돌아가지 않는다.
// ---------------------------------------------------------------------------

test('B3 — Given 사용자가 per-session 에서 per-commit 으로 변경·저장 When 다른 프로젝트로 탭 전환 후 복귀 Then per-commit 이 그대로 유지된다', () => {
  const w = newWrapper();
  selectProject(w, PROJECT_A);
  finishLoad(w, PROJECT_A, {}); // default per-session

  let local = renderPanel(w)!;
  assert.equal(local.choice, DEFAULT_AUTOMATION.branchStrategy);

  // 사용자 입력 → 저장.
  local = userPick(local, 'per-commit');
  userSave(w, local);

  // 프로젝트 전환 — Fragment key 교체로 A 패널이 언마운트된다.
  selectProject(w, PROJECT_B);
  finishLoad(w, PROJECT_B, {});
  assert.equal(renderPanel(w)!.choice, DEFAULT_AUTOMATION.branchStrategy, 'B 는 자신의 기본값으로 진입');

  // 사용자가 A 로 돌아온다 — 슬롯이 남아 있으므로 즉시 마운트, 값은 저장된 per-commit.
  selectProject(w, PROJECT_A);
  const back = renderPanel(w)!;
  assert.equal(
    back.choice,
    'per-commit',
    '방금 저장한 값이 DEFAULT_AUTOMATION 으로 되돌아오면 1587ea9 ③ 회귀',
  );
});

test('B3 회귀 — 전략 변경 + 즉시 탭 전환(저장 없음) 시 다음 재진입에서는 서버 저장값을 보여준다', () => {
  // 사용자가 저장을 누르지 않고 탭을 전환한 경우에도, 재진입 패널은 서버에 남아 있는
  // "마지막으로 저장된" 값으로 복구되어야 한다(= dirty 상태는 언마운트와 함께 폐기).
  const w = newWrapper();
  selectProject(w, PROJECT_A);
  finishLoad(w, PROJECT_A, { branchStrategy: 'per-task' });

  let local = renderPanel(w)!;
  local = userPick(local, 'fixed-branch', 'hotfix/draft');
  // 저장하지 않고 탭 전환.
  selectProject(w, PROJECT_B);
  finishLoad(w, PROJECT_B, {});
  selectProject(w, PROJECT_A);
  const back = renderPanel(w)!;
  assert.equal(back.choice, 'per-task', '저장되지 않은 dirty 변경은 버려지고 서버 저장값이 복원된다');
  assert.equal(back.newBranchName, '', 'dirty 상태의 newBranchName 도 함께 폐기');
});

// ---------------------------------------------------------------------------
// B4 — fixed-branch + newBranchName 조합이 재오픈 후에도 그대로 보존된다.
// ---------------------------------------------------------------------------

test('B4 — Given fixed-branch + newBranchName="release/next" 저장 When 탭 전환 후 복귀 Then 전략과 이름이 모두 보존된다', () => {
  const w = newWrapper();
  selectProject(w, PROJECT_A);
  finishLoad(w, PROJECT_A, {}); // 기본값에서 출발

  let local = renderPanel(w)!;
  local = userPick(local, 'fixed-branch', 'release/next');
  userSave(w, local);

  selectProject(w, PROJECT_B);
  finishLoad(w, PROJECT_B, {});
  selectProject(w, PROJECT_A);

  const back = renderPanel(w)!;
  assert.equal(back.choice, 'fixed-branch');
  assert.equal(back.newBranchName, 'release/next', 'fixed-branch 전략의 입력값이 사라지면 회귀');
});

test('B4 회귀 — 네 전략 모두가 저장·재오픈 왕복에서 선택값을 잃지 않는다', () => {
  for (const strategy of BRANCH_STRATEGY_VALUES) {
    const w = newWrapper();
    selectProject(w, PROJECT_A);
    finishLoad(w, PROJECT_A, {});

    let local = renderPanel(w)!;
    local = userPick(
      local,
      strategy,
      strategy === 'fixed-branch' ? 'feature/auto' : '',
    );
    userSave(w, local);

    // 재오픈 — 동일 프로젝트 탭을 다시 열어도 값이 유지된다.
    selectProject(w, PROJECT_B);
    finishLoad(w, PROJECT_B, {});
    selectProject(w, PROJECT_A);
    const back = renderPanel(w)!;
    assert.equal(back.choice, strategy, `${strategy} 가 재오픈 후에도 유지되어야 한다`);
    assert.equal(
      back.newBranchName,
      strategy === 'fixed-branch' ? 'feature/auto' : '',
      `${strategy} 에서 newBranchName 정책(fixed-branch 외 비움) 이 유지되어야 한다`,
    );
  }
});

test('B4 회귀 — fixed-branch 에서 다른 전략으로 전환 후 재저장하면 newBranchName 은 비워져 저장된다', () => {
  // fixed-branch 입력값이 다른 전략으로 바꾼 뒤에도 남아 있으면, 서버 페이로드에
  // 뜻하지 않게 fixedBranchName 이 실려 자동화 파이프라인이 혼란해진다.
  // 저장 계약: branchStrategy !== 'fixed-branch' 면 newBranchName = '' 로 정규화.
  const w = newWrapper();
  selectProject(w, PROJECT_A);
  finishLoad(w, PROJECT_A, { branchStrategy: 'fixed-branch', newBranchName: 'feature/keep' });

  let local = renderPanel(w)!;
  assert.equal(local.newBranchName, 'feature/keep');

  // 사용자가 per-session 으로 변경하고 저장.
  local = userPick(local, 'per-session');
  userSave(w, local);

  // 재오픈.
  selectProject(w, PROJECT_B);
  finishLoad(w, PROJECT_B, {});
  selectProject(w, PROJECT_A);
  const back = renderPanel(w)!;
  assert.equal(back.choice, 'per-session');
  assert.equal(back.newBranchName, '', 'fixed-branch 외 전략에서는 저장 시 newBranchName 이 비워져야 한다');
});

// ---------------------------------------------------------------------------
// 래퍼(ProjectManagement) 원본 소스에 B1~B4 를 지탱하는 두 핵심 가드가 살아
// 있는지 추가로 확인한다. 본 소스 검사는 선행 테스트(gitAutomationPanel.
// regression.test.tsx) 의 계약을 잠깐 겹쳐 찍어 두어, 래퍼가 리팩터되더라도
// 본 파일의 시뮬레이터와 실제 구현이 같은 축 위에 있게 한다.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_MGMT_SRC = readFileSync(
  resolve(__dirname, '..', 'src', 'components', 'ProjectManagement.tsx'),
  'utf8',
);

test('래퍼 소스 — gitAutomationByProject[selectedProjectId] === undefined 인 동안 패널 마운트를 건너뛰는 분기가 존재', () => {
  assert.match(
    PROJECT_MGMT_SRC,
    /selectedProjectId\s*&&\s*gitAutomationByProject\[selectedProjectId\]\s*===\s*undefined/,
    'B2 의 로드 지연 가드가 사라지면 패널이 DEFAULT_AUTOMATION 으로 마운트되어 B2 회귀',
  );
});

test('래퍼 소스 — 프로젝트 전환 시 React.Fragment key={selectedProjectId} 로 패널이 강제 재마운트된다', () => {
  assert.match(
    PROJECT_MGMT_SRC,
    /<React\.Fragment\s+key=\{selectedProjectId\s*\|\|\s*'no-project'\}>/,
    'B3 의 탭 전환 재마운트가 사라지면 이전 프로젝트의 local state 가 남아 저장값을 덮는다',
  );
});
