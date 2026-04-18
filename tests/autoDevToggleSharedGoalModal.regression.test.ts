// Run with: npx tsx --test tests/autoDevToggleSharedGoalModal.regression.test.ts
//
// QA: 자동 개발 토글 ON/OFF × 공동 목표(shared goal) 모달 노출 동작 회귀 테스트.
//
// 범위
// ────────────────────────────────────────────────────────────────────────
// 본 파일은 "자동 개발" 토글이 ON 으로 밀릴 때 공동 목표 모달을 언제 띄우고
// 언제 띄우지 않아야 하는지, 모달 취소/확정에 따라 토글 상태가 어떻게 복귀
// 하거나 전진하는지, 그리고 새로고침 복원 경로에서 모달이 중복 렌더되지
// 않는지를 네 가지 케이스(C1~C4) 로 잠근다.
//
// 우선 검토 파일: tests/project-settings-save-load-regression-20260419.md 의
// 설정 저장/로드 계약(특히 /api/auto-dev · /api/projects/:id/shared-goal 두
// 영속 경로). 본 모달 동작도 "서버 DB 가 단일 진실 소스" 규칙을 따르기 때문에,
// 새로고침 후 enabled=true 로 복원되는 경우에도 서버가 활성 공동 목표의 존재를
// 함께 응답해 주면 클라이언트는 모달을 띄울 필요가 없다. 바로 이 재진입 플리커
// 가 C4 의 핵심이다.
//
// 대상 UI 계약: src/components/SharedGoalForm.tsx (신규 예정 · tests/shared-goal-form-mockup.md 기준)
// 대상 서버 계약: src/server/taskRunner.ts::setAutoDev → getActiveSharedGoal 의 가드 경로
//
// ┌─ 케이스 지도 ────────────────────────────────────────────────────────────┐
// │ C1  목표 미입력 + 토글 OFF→ON        → 모달 즉시 표시, 서버 호출 보류    │
// │ C2  목표 저장 후 토글 OFF→ON         → 모달 미표시, 즉시 루프 시작       │
// │ C3  C1 모달 [취소] 클릭              → 토글 자동 OFF 복귀, 모달 닫힘     │
// │ C4  새로고침 → 자동 개발 ON 복원     → 모달 중복 표시 금지(목표 존재 시) │
// └──────────────────────────────────────────────────────────────────────────┘

import test from 'node:test';
import assert from 'node:assert/strict';

import type { SharedGoal, AutoDevSettings } from '../src/types.ts';

// ---------------------------------------------------------------------------
// 모달 상태 시뮬레이터
// ---------------------------------------------------------------------------
//
// 실제 SharedGoalForm.tsx 가 도입되면 본 시뮬레이터는 React 훅 (예:
// useAutoDevToggle) 로 교체한다. 그때까지는 "토글 클릭" 핸들러가 만들어야
// 하는 결정 트리를 순수 함수로 고정해 두어, 구현이 들어오는 순간 1:1 로
// 이식할 수 있도록 한다.

type ToggleIntent = 'on' | 'off';

interface ToggleInput {
  intent: ToggleIntent;
  currentEnabled: boolean;
  activeGoal: SharedGoal | null;
  // 서버에서 최초 하이드레이션으로 복원된 상태인가? 사용자가 직접 누른
  // 토글 클릭이 아니라 재진입 플리커 방지용으로 상태만 싱크하는 경우.
  // true 일 때는 모달을 띄우지 않는 것이 C4 의 계약이다.
  fromHydration?: boolean;
}

interface ToggleOutcome {
  // 서버 PATCH /api/auto-dev 를 호출해도 되는가. 모달을 먼저 띄워야 하는
  // 경우에는 false — 사용자가 목표 저장 후 확정해야 서버 호출이 발생한다.
  shouldPatchServer: boolean;
  nextEnabled: boolean;
  showModal: boolean;
  // 모달이 뜬다면 어떤 모드인가. 모달 UI 가 동일 컴포넌트를 재사용하므로
  // "goal-required" / null 두 값만 사용한다.
  modalMode: 'goal-required' | null;
  // 디버깅·사용자 안내용. C1 ON 시도 직후 탭/로그에 흘릴 수 있다.
  log?: string;
}

function trimmedGoalText(goal: SharedGoal | null): string {
  if (!goal) return '';
  // title·description 양쪽 중 하나라도 비어 있으면 "미저장" 으로 간주.
  // SharedGoalForm 의 saved 상태 조건과 일치시킨다.
  const t = (goal.title ?? '').trim();
  const d = (goal.description ?? '').trim();
  if (t.length === 0 || d.length === 0) return '';
  if (goal.status !== 'active') return '';
  return `${t}\n${d}`;
}

/**
 * 자동 개발 토글 클릭 시 실행되는 판정 함수.
 *
 * 불변 계약
 * ─────────────────────────────────────────────────────────────────────────
 *  1) intent='on' + 활성 공동 목표 없음 + !fromHydration → 모달 표시, 서버 호출 보류.
 *  2) intent='on' + 활성 공동 목표 있음 → 모달 미표시, 즉시 서버 PATCH.
 *  3) intent='off' → 무조건 모달 미표시, 서버 PATCH 로 꺼짐 전파.
 *  4) fromHydration=true → 어떤 조합이든 모달을 띄우지 않는다(서버가 단일 진실 소스).
 */
export function evaluateAutoDevToggle(input: ToggleInput): ToggleOutcome {
  const goalText = trimmedGoalText(input.activeGoal);
  const hasGoal = goalText.length > 0;

  // 재진입(하이드레이션) 은 UI 플리커 방지 — 서버가 이미 판정을 내린 상태를
  // 그대로 비추기만 한다. 모달을 여기서 다시 띄우면 "새로고침마다 모달 팝"
  // 회귀가 생긴다(C4).
  if (input.fromHydration) {
    return {
      shouldPatchServer: false,
      nextEnabled: input.currentEnabled,
      showModal: false,
      modalMode: null,
    };
  }

  if (input.intent === 'off') {
    return {
      shouldPatchServer: true,
      nextEnabled: false,
      showModal: false,
      modalMode: null,
    };
  }

  // intent === 'on'
  if (!hasGoal) {
    // C1: 모달을 띄우고 서버 호출은 미뤄야 한다. UI 상으로 토글 시각이 즉시
    // ON 으로 튀면 모달 취소 후 OFF 로 되돌릴 때 한 번 더 플리커가 생기므로,
    // nextEnabled=false 로 고정해 "모달이 떠 있는 동안은 아직 OFF" 로 본다.
    return {
      shouldPatchServer: false,
      nextEnabled: false,
      showModal: true,
      modalMode: 'goal-required',
      log: '자동 개발 ON 차단: 공동 목표를 먼저 입력해주세요',
    };
  }

  // C2: 목표가 저장되어 있으면 모달 없이 즉시 서버 호출.
  return {
    shouldPatchServer: true,
    nextEnabled: true,
    showModal: false,
    modalMode: null,
  };
}

/**
 * 모달에서 사용자가 [취소] 를 눌렀을 때의 결과. C3 계약.
 * 토글은 항상 OFF 로 복귀하고, 서버에는 아무 호출도 가지 않는다
 * (원래 ON 요청 자체가 서버에 나가기 전이므로).
 */
export function onGoalModalCancel(prev: { enabled: boolean }): {
  nextEnabled: boolean;
  showModal: boolean;
  shouldPatchServer: boolean;
} {
  return {
    nextEnabled: false,
    showModal: false,
    shouldPatchServer: false,
  };
}

/**
 * 모달에서 목표를 입력·저장한 뒤 [확인] 을 누를 때의 결과.
 * C1→저장→확인 경로를 통과하면 C2 와 동일한 "모달 미표시 · 서버 PATCH" 가 된다.
 */
export function onGoalModalConfirm(input: {
  savedGoal: SharedGoal | null;
}): ToggleOutcome {
  return evaluateAutoDevToggle({
    intent: 'on',
    currentEnabled: false,
    activeGoal: input.savedGoal,
  });
}

// ---------------------------------------------------------------------------
// 공용 픽스처
// ---------------------------------------------------------------------------

const NOW_ISO = '2026-04-19T10:00:00.000Z';

const EMPTY_SETTINGS: AutoDevSettings = {
  enabled: false,
  projectId: 'proj-modal',
  updatedAt: NOW_ISO,
};

const ACTIVE_GOAL: SharedGoal = {
  id: 'goal-1',
  projectId: 'proj-modal',
  title: '결제 모듈 보안 강화',
  description: '토큰 검증·AES 암호화·PCI 감사로그 추가',
  priority: 'high',
  deadline: '2026-04-25',
  status: 'active',
  createdAt: '2026-04-18T09:00:00.000Z',
};

const ARCHIVED_GOAL: SharedGoal = {
  ...ACTIVE_GOAL,
  id: 'goal-old',
  status: 'archived',
};

// ---------------------------------------------------------------------------
// 케이스 C1 — 공동 목표 미입력 상태에서 자동 개발 ON → 모달 즉시 표시
// ---------------------------------------------------------------------------

test('C1 — 목표 미입력 + 자동 개발 OFF→ON 클릭: 모달이 즉시 표시되고 서버 PATCH 는 보류된다', () => {
  const outcome = evaluateAutoDevToggle({
    intent: 'on',
    currentEnabled: false,
    activeGoal: null,
  });

  assert.equal(outcome.showModal, true, '모달이 노출되어야 한다');
  assert.equal(outcome.modalMode, 'goal-required');
  assert.equal(outcome.shouldPatchServer, false, '목표 저장 전에는 서버 호출이 나가면 안 된다');
  assert.equal(outcome.nextEnabled, false, '모달 대기 중에는 토글 시각이 OFF 로 유지되어야 한다');
  assert.match(outcome.log ?? '', /공동 목표/);
});

test('C1 회귀 — title 은 있으나 description 이 공백인 "하프 저장" 도 미입력으로 간주되어 모달이 뜬다', () => {
  const halfGoal: SharedGoal = { ...ACTIVE_GOAL, description: '   \n\t ' };
  const outcome = evaluateAutoDevToggle({
    intent: 'on',
    currentEnabled: false,
    activeGoal: halfGoal,
  });
  assert.equal(outcome.showModal, true);
  assert.equal(outcome.shouldPatchServer, false);
});

test('C1 회귀 — archived 상태의 과거 목표는 "활성 목표 없음" 과 동치로 모달을 띄운다', () => {
  const outcome = evaluateAutoDevToggle({
    intent: 'on',
    currentEnabled: false,
    activeGoal: ARCHIVED_GOAL,
  });
  assert.equal(outcome.showModal, true);
  assert.equal(outcome.modalMode, 'goal-required');
});

// ---------------------------------------------------------------------------
// 케이스 C2 — 공동 목표 입력·확정 후 ON → 모달 미표시 및 루프 시작
// ---------------------------------------------------------------------------

test('C2 — 활성 공동 목표가 저장된 상태에서 토글 OFF→ON: 모달 미표시, 서버 PATCH 즉시 호출', () => {
  const outcome = evaluateAutoDevToggle({
    intent: 'on',
    currentEnabled: false,
    activeGoal: ACTIVE_GOAL,
  });
  assert.equal(outcome.showModal, false);
  assert.equal(outcome.modalMode, null);
  assert.equal(outcome.shouldPatchServer, true);
  assert.equal(outcome.nextEnabled, true, '즉시 루프 시작 — UI 시각도 ON 으로 전환');
});

test('C2 회귀 — C1 모달에서 목표 저장 후 [확인] 을 누르는 플로우도 동일한 결과(PATCH 진행)', () => {
  // Given: C1 경로로 모달이 떠 있고, 사용자가 모달 내 폼에서 목표를 입력 저장.
  const savedGoal: SharedGoal = { ...ACTIVE_GOAL, id: 'goal-just-saved' };
  const outcome = onGoalModalConfirm({ savedGoal });
  assert.equal(outcome.showModal, false);
  assert.equal(outcome.shouldPatchServer, true);
  assert.equal(outcome.nextEnabled, true);
});

// ---------------------------------------------------------------------------
// 케이스 C3 — ON 시도 중 모달 [취소] → 토글 자동 OFF 복귀
// ---------------------------------------------------------------------------

test('C3 — 모달이 떠 있는 동안 [취소] 클릭: 토글이 OFF 로 복귀하고 서버 호출이 나가지 않는다', () => {
  // Given: C1 경로로 모달이 뜬 상태. 이 시점의 토글 시각은 이미 OFF (C1 가드 계약).
  const after = onGoalModalCancel({ enabled: false });
  assert.equal(after.nextEnabled, false);
  assert.equal(after.showModal, false);
  assert.equal(after.shouldPatchServer, false);
});

test('C3 회귀 — ESC 키로 모달을 닫은 경우에도 동일하게 OFF 로 복귀해야 한다(취소와 동일 핸들러)', () => {
  // 시뮬레이터 관점에서는 [취소] 버튼과 ESC 가 같은 onGoalModalCancel 을 호출해야
  // 한다는 "한 출처" 계약을 확인.
  const byButton = onGoalModalCancel({ enabled: false });
  const byEscape = onGoalModalCancel({ enabled: false });
  assert.deepEqual(byButton, byEscape);
});

test('C3 회귀 — 취소 후 재시도 시 C1 과 동일하게 다시 모달이 뜬다(상태 라칭 금지)', () => {
  // 한 번 취소했다고 "다음 번에도 모달을 건너뜀" 같은 기억을 두면 안 된다.
  onGoalModalCancel({ enabled: false });
  const retry = evaluateAutoDevToggle({
    intent: 'on',
    currentEnabled: false,
    activeGoal: null,
  });
  assert.equal(retry.showModal, true);
  assert.equal(retry.modalMode, 'goal-required');
});

// ---------------------------------------------------------------------------
// 케이스 C4 — 새로고침 후 자동 개발 상태 복원 시 모달 중복 표시 여부
// ---------------------------------------------------------------------------

test('C4 — enabled=true 로 하이드레이션된 상태는 모달을 띄우지 않는다(서버가 판정을 이미 통과)', () => {
  // 서버 측 setAutoDev 가 setEnabled=true 를 승인했다는 뜻은 활성 공동 목표가 존재했다는
  // 뜻. 클라이언트가 재진입 시 모달을 다시 띄우면 사용자가 새로고침할 때마다 모달이
  // 깜빡이는 회귀가 생긴다.
  const outcome = evaluateAutoDevToggle({
    intent: 'on',
    currentEnabled: true,
    activeGoal: ACTIVE_GOAL,
    fromHydration: true,
  });
  assert.equal(outcome.showModal, false, '하이드레이션 경로에서는 모달 금지');
  assert.equal(outcome.shouldPatchServer, false, '재진입 플리커를 만들지 않아야 한다');
  assert.equal(outcome.nextEnabled, true);
});

test('C4 경계 — 하이드레이션 시 목표가 undefined 로 오면 서버 신뢰 원칙상 모달을 띄우지 않는다', () => {
  // 네트워크 레이스로 활성 목표 응답이 조금 늦게 올 수 있다. 그 순간 모달을 띄워
  // 버리면 200ms 뒤 도착한 실제 목표로 다시 닫는 "플래시 모달" 회귀가 된다.
  // 하이드레이션 경로에서는 초기 enabled 값을 그대로 반영하고, 모달 판정은
  // 사용자가 직접 토글을 건드릴 때만 수행한다.
  const outcome = evaluateAutoDevToggle({
    intent: 'on',
    currentEnabled: true,
    activeGoal: null,
    fromHydration: true,
  });
  assert.equal(outcome.showModal, false);
  assert.equal(outcome.nextEnabled, true);
});

test('C4 — 하이드레이션 직후 사용자가 직접 OFF→ON 을 다시 누르면 정상 가드가 작동한다', () => {
  // 하이드레이션 바이패스는 "첫 렌더 한 번" 에만 적용되어야 하며,
  // 이후 사용자 클릭에는 C1/C2 의 평시 가드가 그대로 동작해야 한다.
  // 예: 하이드레이션 결과 enabled=false + 목표 없음 → 사용자가 토글 ON 시도.
  const outcome = evaluateAutoDevToggle({
    intent: 'on',
    currentEnabled: false,
    activeGoal: null,
    fromHydration: false,
  });
  assert.equal(outcome.showModal, true);
  assert.equal(outcome.modalMode, 'goal-required');
});

// ---------------------------------------------------------------------------
// 불변 계약 — 세 개의 축이 모두 엮인 진리표를 한 번 더 잠근다.
// (intent, hasGoal, fromHydration) 의 8개 조합에서 모달 노출이 일관되는지 확인.
// ---------------------------------------------------------------------------

test('불변 — (intent × hasGoal × fromHydration) 8조합 진리표', () => {
  type Row = {
    intent: ToggleIntent;
    goal: SharedGoal | null;
    hydration: boolean;
    expectModal: boolean;
    expectPatch: boolean;
    expectNextEnabled: boolean;
  };
  const rows: Row[] = [
    // 사용자 클릭 경로
    { intent: 'on',  goal: null,        hydration: false, expectModal: true,  expectPatch: false, expectNextEnabled: false },
    { intent: 'on',  goal: ACTIVE_GOAL, hydration: false, expectModal: false, expectPatch: true,  expectNextEnabled: true  },
    { intent: 'off', goal: null,        hydration: false, expectModal: false, expectPatch: true,  expectNextEnabled: false },
    { intent: 'off', goal: ACTIVE_GOAL, hydration: false, expectModal: false, expectPatch: true,  expectNextEnabled: false },
    // 하이드레이션 경로 — 어떤 조합이든 모달 금지, 서버 호출 금지.
    { intent: 'on',  goal: null,        hydration: true,  expectModal: false, expectPatch: false, expectNextEnabled: false /* currentEnabled 값 그대로 */ },
    { intent: 'on',  goal: ACTIVE_GOAL, hydration: true,  expectModal: false, expectPatch: false, expectNextEnabled: false },
    { intent: 'off', goal: null,        hydration: true,  expectModal: false, expectPatch: false, expectNextEnabled: false },
    { intent: 'off', goal: ACTIVE_GOAL, hydration: true,  expectModal: false, expectPatch: false, expectNextEnabled: false },
  ];
  for (const row of rows) {
    // 하이드레이션 행에서는 currentEnabled=false 로 통일해 nextEnabled 기대값을 고정.
    const outcome = evaluateAutoDevToggle({
      intent: row.intent,
      currentEnabled: false,
      activeGoal: row.goal,
      fromHydration: row.hydration,
    });
    assert.equal(outcome.showModal, row.expectModal,
      `showModal 불일치: ${JSON.stringify(row)} → ${JSON.stringify(outcome)}`);
    assert.equal(outcome.shouldPatchServer, row.expectPatch,
      `shouldPatchServer 불일치: ${JSON.stringify(row)}`);
    assert.equal(outcome.nextEnabled, row.expectNextEnabled,
      `nextEnabled 불일치: ${JSON.stringify(row)}`);
  }
});

// EMPTY_SETTINGS 는 실 구현의 AutoDevSettings 형상과 시뮬레이터가 어긋나지 않도록
// 타입 체크 목적으로만 참조한다(테스트 런타임에서는 직접 사용하지 않는다).
void EMPTY_SETTINGS;
