// Run with: npx tsx --test tests/sharedGoalFormDisplay.regression.test.ts
//
// QA: "프로젝트 관리" 탭 진입 시 공동 목표(SharedGoal) 입력/편집 폼 표시 회귀 테스트.
//
// 범위
// ────────────────────────────────────────────────────────────────────────
// 본 파일은 사용자가 메인 UI 의 "프로젝트 관리" 탭으로 진입했을 때, 활성 공동
// 목표의 유무·하이드레이션 타이밍·SharedGoalModal 동시 노출 상황에서 폼이
// 언제 어떤 모드로 렌더되는지를 네 가지 케이스(P1~P4) 로 잠근다.
//
// 우선 검토 파일: tests/shared-goal-form-mockup.md (시안 §2 §3 §10)
//   - 폼의 기본 배치는 GitAutomationPanel 헤더 확장 영역(또는 ProjectManagement
//     우측 사이드 패널). 탭 전환과 무관하게 "프로젝트 관리" 탭 내부에서는 항상
//     렌더된다.
//   - empty → create 모드(빈 필드), saved → edit 모드(기존 값 프리필).
//
// 배경 — 회귀 방지 목적
// ────────────────────────────────────────────────────────────────────────
// 기존 저장소에는 ProjectManagement.tsx 가 공동 목표 인라인 폼을 아직 갖고
// 있지 않다(검색 기준: ProjectManagement.tsx 내 "sharedGoal" 키워드 0건).
// 본 테스트는 SharedGoalForm 이 ProjectManagement 탭에 배치될 때 다음
// 회귀 카테고리를 사전에 잠가 두기 위한 계약이다.
//
//   R1. "프로젝트 관리" 탭 진입 시 활성 목표가 없으면 create 폼이 보여야 함.
//   R2. 활성 목표가 있으면 동일 자리에 edit 폼이 프리필 값과 함께 보여야 함.
//   R3. 새로고침 직후 하이드레이션 구간(서버 응답이 도착하기 전)에도 폼
//       자체는 "사라지지 않아야" 함 — 스켈레톤/로딩은 허용이지만 null 렌더는 회귀.
//   R4. SharedGoalModal(자동 개발 ON 트리거로 뜨는 전역 모달)이 열려 있어도
//       배경의 폼 DOM 은 유지되어야 한다. 모달을 닫은 직후 편집 연속성이
//       보장되도록, 폼은 모달이 씌워진 상태에서도 "접근 가능" 이어야 함.
//
// 시뮬레이터 기반 (실제 컴포넌트 도입 전)
// ────────────────────────────────────────────────────────────────────────
// src/components/SharedGoalForm.tsx 가 구현되면 본 시뮬레이터(`evaluate...`)
// 는 React 훅 혹은 컴포넌트의 렌더 조건으로 이식된다. 구현 시 본 파일의
// 기대값을 그대로 JSX 조건부 렌더 분기로 옮기면 회귀 없이 통과한다.
//
// ┌─ 케이스 지도 ────────────────────────────────────────────────────────────┐
// │ P1  공동 목표 없음 + 프로젝트 관리 탭 진입  → create 폼 렌더                │
// │ P2  공동 목표 있음 + 프로젝트 관리 탭 진입  → edit 폼 렌더 + 필드 프리필    │
// │ P3  새로고침·하이드레이션 직후              → 폼 컨테이너 유지(스켈레톤 OK) │
// │ P4  SharedGoalModal 오픈 중                 → 배경 폼 DOM 접근 유지         │
// └──────────────────────────────────────────────────────────────────────────┘

import test from 'node:test';
import assert from 'node:assert/strict';

import type { SharedGoal } from '../src/types.ts';

// ---------------------------------------------------------------------------
// 공용 타입 · 시뮬레이터
// ---------------------------------------------------------------------------

type AppTab = 'main' | 'project-management' | 'shop' | 'log';

interface FormVisibilityInput {
  activeTab: AppTab;
  selectedProjectId: string | null;
  activeGoal: SharedGoal | null;
  // 초기 /api/projects/:id/shared-goal 응답이 돌아오기 전의 찰나. true 이면
  // activeGoal 값은 "미확정(unknown)" 으로 간주하며, 컴포넌트는 비어있는 창을
  // 만드는 대신 스켈레톤을 남겨둔다.
  hydrating: boolean;
  // 자동 개발 ON 트리거 시 뜨는 "공동 목표 필요" 모달(SharedGoalModal) 의
  // 오픈 여부. 모달이 떠 있어도 배경의 인라인 폼 DOM 은 보존되어야 한다 —
  // 모달을 ESC 로 닫았을 때 편집 연속성을 유지하기 위함.
  sharedGoalModalOpen: boolean;
}

type FormMode = 'create' | 'edit' | 'skeleton';

interface FormVisibilityOutcome {
  // 프로젝트 관리 탭의 렌더 트리에서 폼 컨테이너가 존재하는가.
  // 모달이 덮여 있어도 (overlay 관계) 컨테이너 자체는 true 여야 한다.
  renderContainer: boolean;
  // 폼 본문(입력 필드 + 미리보기)이 실제로 보이는가. 하이드레이션 중이면
  // false(스켈레톤만 보임), 평시에는 true.
  showFields: boolean;
  mode: FormMode | null;
  // edit 모드일 때 프리필 값의 출처. null 이면 create 의 빈 값.
  prefilledFrom: SharedGoal | null;
  // 모달이 위에 덮여 있다면 폼 인터랙션은 잠시 비활성이지만, DOM 에
  // 남아 있어야 한다. 테스트는 이 조합을 한 번에 잠근다.
  accessibleWhileModalOpen: boolean;
  // 진단용 코드. 실패 시 로그에서 원인을 빨리 짚기 위함.
  reason: string;
}

/**
 * 프로젝트 관리 탭에서 공동 목표 폼이 어떻게 렌더되어야 하는지를 판정한다.
 *
 * 불변 계약
 * ─────────────────────────────────────────────────────────────────────────
 *  1) activeTab='project-management' + selectedProjectId 존재 → 폼 컨테이너
 *     는 항상 렌더된다(renderContainer=true). 다른 탭이거나 프로젝트 미선택
 *     이면 false.
 *  2) hydrating=true 이면 모드는 'skeleton' 이며 showFields=false. 하지만
 *     컨테이너는 남겨 둬 탭 전환 깜빡임을 제거한다.
 *  3) 하이드레이션 완료 후 activeGoal=null 이면 'create', 있으면 'edit'.
 *     edit 모드에서 prefilledFrom 은 활성 목표 객체 그대로(참조 전달) —
 *     컴포넌트는 이 객체의 title/description/priority/deadline 을 필드에
 *     복사한다.
 *  4) sharedGoalModalOpen=true 라도 renderContainer 는 반드시 true.
 *     모달은 오버레이일 뿐 폼 DOM 을 언마운트하지 않는다(편집 연속성).
 *  5) activeGoal.status !== 'active' 인 과거 목표는 비활성으로 간주 —
 *     edit 가 아니라 create 모드를 띄워 새 목표를 만들 수 있게 한다.
 */
export function evaluateSharedGoalFormVisibility(
  input: FormVisibilityInput,
): FormVisibilityOutcome {
  // 규칙 1: 탭/프로젝트 선택 가드
  if (input.activeTab !== 'project-management') {
    return {
      renderContainer: false,
      showFields: false,
      mode: null,
      prefilledFrom: null,
      accessibleWhileModalOpen: false,
      reason: 'tab-not-project-management',
    };
  }
  if (!input.selectedProjectId) {
    return {
      renderContainer: false,
      showFields: false,
      mode: null,
      prefilledFrom: null,
      accessibleWhileModalOpen: false,
      reason: 'no-project-selected',
    };
  }

  // 규칙 2: 하이드레이션 중에는 컨테이너만 남기고 스켈레톤.
  if (input.hydrating) {
    return {
      renderContainer: true,
      showFields: false,
      mode: 'skeleton',
      prefilledFrom: null,
      accessibleWhileModalOpen: !input.sharedGoalModalOpen,
      reason: 'hydrating',
    };
  }

  // 규칙 3/5: 활성 목표 유무로 create/edit 결정.
  const isActive =
    !!input.activeGoal && input.activeGoal.status === 'active';
  const mode: FormMode = isActive ? 'edit' : 'create';
  const prefilledFrom = isActive ? input.activeGoal : null;

  return {
    renderContainer: true,
    showFields: true,
    mode,
    prefilledFrom,
    // 규칙 4: 모달이 덮여 있으면 상호작용은 막히지만 DOM 은 살아 있어야 한다.
    // 상호작용 가능 여부와 DOM 존재 여부를 혼동하지 않도록 accessibleWhileModalOpen
    // 은 "상호작용 가능" 을 의미한다 — 모달 닫히면 true.
    accessibleWhileModalOpen: !input.sharedGoalModalOpen,
    reason: isActive ? 'has-active-goal' : 'no-active-goal',
  };
}

// ---------------------------------------------------------------------------
// 공용 픽스처
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-mgmt-form';

const ACTIVE_GOAL: SharedGoal = {
  id: 'goal-active',
  projectId: PROJECT_ID,
  title: '결제 모듈 보안 강화',
  description: '토큰 검증·AES 암호화·PCI 감사로그 추가',
  priority: 'high',
  deadline: '2026-04-25',
  status: 'active',
  createdAt: '2026-04-18T09:00:00.000Z',
};

const ARCHIVED_GOAL: SharedGoal = {
  ...ACTIVE_GOAL,
  id: 'goal-archived',
  status: 'archived',
};

const COMPLETED_GOAL: SharedGoal = {
  ...ACTIVE_GOAL,
  id: 'goal-completed',
  status: 'completed',
};

const BASE_INPUT: FormVisibilityInput = {
  activeTab: 'project-management',
  selectedProjectId: PROJECT_ID,
  activeGoal: null,
  hydrating: false,
  sharedGoalModalOpen: false,
};

// ---------------------------------------------------------------------------
// P1 — 공동 목표 없음 + 프로젝트 관리 탭 진입 → create 폼 렌더
// ---------------------------------------------------------------------------

test('P1 — 공동 목표가 없는 상태에서 프로젝트 관리 탭으로 진입하면 create 모드 폼이 보인다', () => {
  const outcome = evaluateSharedGoalFormVisibility({
    ...BASE_INPUT,
    activeGoal: null,
  });
  assert.equal(outcome.renderContainer, true, '폼 컨테이너가 항상 렌더되어야 한다');
  assert.equal(outcome.showFields, true, '하이드레이션 종료 후에는 필드가 보여야 한다');
  assert.equal(outcome.mode, 'create');
  assert.equal(outcome.prefilledFrom, null, 'create 에서는 프리필이 없다');
  assert.equal(outcome.reason, 'no-active-goal');
});

test('P1 회귀 — activeTab 이 프로젝트 관리가 아니면 폼은 렌더되지 않는다', () => {
  for (const tab of ['main', 'shop', 'log'] as const) {
    const outcome = evaluateSharedGoalFormVisibility({
      ...BASE_INPUT,
      activeTab: tab,
    });
    assert.equal(outcome.renderContainer, false, `tab=${tab} 에서 폼이 떠 있으면 회귀`);
  }
});

test('P1 회귀 — selectedProjectId 가 null 이면 폼 대신 프로젝트 선택 안내가 뜬다(폼 렌더 금지)', () => {
  const outcome = evaluateSharedGoalFormVisibility({
    ...BASE_INPUT,
    selectedProjectId: null,
  });
  assert.equal(outcome.renderContainer, false);
  assert.equal(outcome.reason, 'no-project-selected');
});

test('P1 회귀 — archived/completed 과거 목표만 있고 활성 목표가 없으면 create 모드', () => {
  for (const legacy of [ARCHIVED_GOAL, COMPLETED_GOAL]) {
    const outcome = evaluateSharedGoalFormVisibility({
      ...BASE_INPUT,
      activeGoal: legacy,
    });
    assert.equal(outcome.mode, 'create', `status=${legacy.status} 는 활성이 아니다`);
    assert.equal(outcome.prefilledFrom, null, '비활성 과거 목표로 프리필하면 회귀');
  }
});

// ---------------------------------------------------------------------------
// P2 — 공동 목표 있음 + 프로젝트 관리 탭 진입 → edit 폼 렌더 + 필드 프리필
// ---------------------------------------------------------------------------

test('P2 — 활성 공동 목표가 있는 상태에서 프로젝트 관리 탭으로 진입하면 edit 모드 폼이 프리필된 채 보인다', () => {
  const outcome = evaluateSharedGoalFormVisibility({
    ...BASE_INPUT,
    activeGoal: ACTIVE_GOAL,
  });
  assert.equal(outcome.renderContainer, true);
  assert.equal(outcome.showFields, true);
  assert.equal(outcome.mode, 'edit');
  assert.equal(outcome.prefilledFrom, ACTIVE_GOAL, '활성 목표 객체가 그대로 프리필로 전달되어야 한다');
  assert.equal(outcome.reason, 'has-active-goal');
});

test('P2 회귀 — 활성 목표의 필수 필드(title/description/priority) 는 프리필 경로로 손실 없이 도달해야 한다', () => {
  const outcome = evaluateSharedGoalFormVisibility({
    ...BASE_INPUT,
    activeGoal: ACTIVE_GOAL,
  });
  assert.ok(outcome.prefilledFrom);
  assert.equal(outcome.prefilledFrom!.title, ACTIVE_GOAL.title);
  assert.equal(outcome.prefilledFrom!.description, ACTIVE_GOAL.description);
  assert.equal(outcome.prefilledFrom!.priority, ACTIVE_GOAL.priority);
  assert.equal(outcome.prefilledFrom!.deadline, ACTIVE_GOAL.deadline);
});

test('P2 회귀 — 활성 목표가 있어도 탭이 바뀌면 폼은 즉시 언마운트된다(탭 격리)', () => {
  const outcome = evaluateSharedGoalFormVisibility({
    ...BASE_INPUT,
    activeTab: 'main',
    activeGoal: ACTIVE_GOAL,
  });
  assert.equal(outcome.renderContainer, false, '다른 탭에서도 폼이 남아 있으면 탭 격리 회귀');
});

// ---------------------------------------------------------------------------
// P3 — 새로고침·하이드레이션 직후에도 폼 컨테이너가 사라지지 않는다
// ---------------------------------------------------------------------------

test('P3 — 하이드레이션 중에는 스켈레톤 모드로 컨테이너가 유지된다(null 렌더 금지)', () => {
  const outcome = evaluateSharedGoalFormVisibility({
    ...BASE_INPUT,
    hydrating: true,
    activeGoal: null,
  });
  assert.equal(outcome.renderContainer, true, '하이드레이션 중 컨테이너가 사라지면 찰나 깜빡임 회귀');
  assert.equal(outcome.showFields, false, '값이 오기 전 필드를 그리면 프리필이 비어 보이는 회귀');
  assert.equal(outcome.mode, 'skeleton');
  assert.equal(outcome.reason, 'hydrating');
});

test('P3 회귀 — 하이드레이션 중 활성 목표 객체가 같이 들어와도 모드는 skeleton 유지(플리커 방지)', () => {
  // 네트워크 레이스로 activeGoal 이 살짝 더 빠르게 도착해도, 하이드레이션
  // 플래그가 아직 true 이면 스켈레톤을 유지해 필드를 한 번에 채워넣는다.
  const outcome = evaluateSharedGoalFormVisibility({
    ...BASE_INPUT,
    hydrating: true,
    activeGoal: ACTIVE_GOAL,
  });
  assert.equal(outcome.mode, 'skeleton');
  assert.equal(outcome.showFields, false);
});

test('P3 — 하이드레이션 종료 직후(hydrating: false) 는 평시 규칙이 그대로 적용된다', () => {
  const noGoal = evaluateSharedGoalFormVisibility({
    ...BASE_INPUT,
    hydrating: false,
    activeGoal: null,
  });
  assert.equal(noGoal.mode, 'create');
  const withGoal = evaluateSharedGoalFormVisibility({
    ...BASE_INPUT,
    hydrating: false,
    activeGoal: ACTIVE_GOAL,
  });
  assert.equal(withGoal.mode, 'edit');
});

// ---------------------------------------------------------------------------
// P4 — SharedGoalModal 자동 개발 ON 트리거 흐름에서도 폼 접근이 정상이어야 함
// ---------------------------------------------------------------------------

test('P4 — 자동 개발 ON 트리거로 SharedGoalModal 이 열려도 배경의 폼 DOM 은 유지된다', () => {
  const outcome = evaluateSharedGoalFormVisibility({
    ...BASE_INPUT,
    activeGoal: null,
    sharedGoalModalOpen: true,
  });
  assert.equal(outcome.renderContainer, true, '모달 오픈 시 배경 폼을 언마운트하면 편집 연속성 회귀');
  assert.equal(outcome.showFields, true);
  // 상호작용 측면에서는 모달이 덮여 있으므로 일시 비활성.
  assert.equal(outcome.accessibleWhileModalOpen, false,
    '모달이 떠 있을 때 배경 폼이 클릭 가능하면 포커스 충돌 회귀');
});

test('P4 회귀 — 모달이 닫히면 즉시 배경 폼이 다시 인터랙션 가능해진다', () => {
  const withModal = evaluateSharedGoalFormVisibility({
    ...BASE_INPUT,
    sharedGoalModalOpen: true,
  });
  assert.equal(withModal.accessibleWhileModalOpen, false);
  const afterClose = evaluateSharedGoalFormVisibility({
    ...BASE_INPUT,
    sharedGoalModalOpen: false,
  });
  assert.equal(afterClose.accessibleWhileModalOpen, true);
  // 컨테이너 자체는 두 프레임 모두 렌더되어 있어야 한다.
  assert.equal(withModal.renderContainer, true);
  assert.equal(afterClose.renderContainer, true);
});

test('P4 회귀 — 모달 중 하이드레이션 플래시 케이스에서도 컨테이너는 유지된다', () => {
  // 사용자가 모달을 띄운 직후 새로고침 없이 그대로 놔뒀다고 해도, 내부에서
  // 활성 목표 재조회로 hydrating 이 잠시 true 로 튀는 레이스가 생길 수 있다.
  // 이 순간 컨테이너를 언마운트해 버리면 모달 배경이 검은 공백이 되는 회귀.
  const outcome = evaluateSharedGoalFormVisibility({
    ...BASE_INPUT,
    hydrating: true,
    sharedGoalModalOpen: true,
  });
  assert.equal(outcome.renderContainer, true);
  assert.equal(outcome.mode, 'skeleton');
});

test('P4 — 모달 오픈 중 사용자가 모달에서 목표를 저장해 activeGoal 이 생기면, 닫힘 직후 edit 모드로 매끄럽게 전환된다', () => {
  // Given: 모달이 열려 있고 아직 활성 목표 없음(P4 진입).
  const during = evaluateSharedGoalFormVisibility({
    ...BASE_INPUT,
    activeGoal: null,
    sharedGoalModalOpen: true,
  });
  assert.equal(during.mode, 'create');
  // When: 사용자가 모달에서 저장해 goal 이 반영되고 모달이 닫힘.
  const after = evaluateSharedGoalFormVisibility({
    ...BASE_INPUT,
    activeGoal: ACTIVE_GOAL,
    sharedGoalModalOpen: false,
  });
  // Then: create → edit 로 전환되며 프리필이 따라온다.
  assert.equal(after.mode, 'edit');
  assert.equal(after.prefilledFrom, ACTIVE_GOAL);
});

// ---------------------------------------------------------------------------
// 불변 계약 — 4 축 진리표로 한 번 더 잠금.
// (activeTab=project-management 고정, selectedProjectId 고정)
// 축: (hasActiveGoal × hydrating × sharedGoalModalOpen) = 8 조합.
// ---------------------------------------------------------------------------

test('불변 — (hasActiveGoal × hydrating × sharedGoalModalOpen) 8조합 진리표', () => {
  type Row = {
    hasGoal: boolean;
    hydrating: boolean;
    modal: boolean;
    expectContainer: boolean;
    expectMode: FormMode | null;
    expectShowFields: boolean;
  };
  const rows: Row[] = [
    // 하이드레이션 중 — 목표 유무·모달 상관없이 skeleton.
    { hasGoal: false, hydrating: true,  modal: false, expectContainer: true, expectMode: 'skeleton', expectShowFields: false },
    { hasGoal: true,  hydrating: true,  modal: false, expectContainer: true, expectMode: 'skeleton', expectShowFields: false },
    { hasGoal: false, hydrating: true,  modal: true,  expectContainer: true, expectMode: 'skeleton', expectShowFields: false },
    { hasGoal: true,  hydrating: true,  modal: true,  expectContainer: true, expectMode: 'skeleton', expectShowFields: false },
    // 평시 — hasGoal 이 mode 를 결정, 모달 유무와 무관하게 컨테이너는 유지.
    { hasGoal: false, hydrating: false, modal: false, expectContainer: true, expectMode: 'create', expectShowFields: true },
    { hasGoal: true,  hydrating: false, modal: false, expectContainer: true, expectMode: 'edit',   expectShowFields: true },
    { hasGoal: false, hydrating: false, modal: true,  expectContainer: true, expectMode: 'create', expectShowFields: true },
    { hasGoal: true,  hydrating: false, modal: true,  expectContainer: true, expectMode: 'edit',   expectShowFields: true },
  ];
  for (const row of rows) {
    const outcome = evaluateSharedGoalFormVisibility({
      ...BASE_INPUT,
      activeGoal: row.hasGoal ? ACTIVE_GOAL : null,
      hydrating: row.hydrating,
      sharedGoalModalOpen: row.modal,
    });
    assert.equal(outcome.renderContainer, row.expectContainer,
      `renderContainer 불일치: ${JSON.stringify(row)}`);
    assert.equal(outcome.mode, row.expectMode,
      `mode 불일치: ${JSON.stringify(row)} → ${JSON.stringify(outcome)}`);
    assert.equal(outcome.showFields, row.expectShowFields,
      `showFields 불일치: ${JSON.stringify(row)}`);
  }
});
