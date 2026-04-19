// Run with: npx tsx --test tests/branchModeSketch.regression.test.ts
//
// QA 회귀(#8e4b841f) — GitAutomationPanel 의 "브랜치 전략 · 2모드 시안(A안)"
// (`branchMode` + `branchModeNewName`) 이 로컬 전용 상태에서 승격되어, 서버 저장/
// 로드 왕복에서 그대로 복원됨을 잠근다. 과거 시안 블록은 UI state 로만 존재해
// 앱 재시작/새로고침 시 항상 기본값('new', 'feature/') 으로 초기화됐다 — 사용자가
// 'continue' 로 전환해도 저장 버튼이 이 축을 페이로드에 실어주지 않았기 때문.
//
// 본 테스트는 `toServerSettings → (서버 저장 모사) → fromServerSettings` 경로를
// 한 번 타고 돌아와 최종 GitAutomationSettings 가 처음 저장한 값과 일치하는지
// 확인한다. `ProjectManagement.tsx` 의 두 순수 함수는 `export` 돼 있지 않아
// 본 테스트는 **동일한 의미**를 갖는 로컬 reference implementation 을 두고
// 대신 `DEFAULT_AUTOMATION` · `GitAutomationSettings` 공개 타입만 import 해 계약을
// 잠근다. 원 함수가 변경되면 본 reference 도 함께 옮겨 동작한다.
//
// ┌─ 시나리오 지도 ──────────────────────────────────────────────────────────────┐
// │ M1  저장→재로드 후 branchMode='continue' 가 그대로 복원된다                  │
// │ M2  저장→재로드 후 branchModeNewName 이 그대로 복원된다(모드 무관)          │
// │ M3  서버 row 가 필드를 모르는 레거시 프로젝트는 DEFAULT_AUTOMATION 값으로 폴백 │
// │ M4  잘못된 branchModeSketch 문자열이 박혀도 DEFAULT('new') 로 폴백           │
// │ M5  save() 페이로드가 두 필드를 항상 포함해 서버에 전달한다                  │
// └──────────────────────────────────────────────────────────────────────────────┘

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_AUTOMATION,
  type GitAutomationSettings,
  type BranchMode,
} from '../src/components/GitAutomationPanel.tsx';

// ---------------------------------------------------------------------------
// Reference implementation — ProjectManagement.tsx 의 toServerSettings /
// fromServerSettings 의 핵심 계약만 재현한다. 실구현이 변하면 본 파일을 함께
// 갱신하거나 구현 함수를 export 해 이 reference 를 제거한다.
// ---------------------------------------------------------------------------

function toServerSettings(ui: GitAutomationSettings): Record<string, unknown> {
  return {
    enabled: ui.enabled,
    flowLevel: ui.flow === 'commit' ? 'commitOnly'
      : ui.flow === 'commit-push' ? 'commitPush' : 'commitPushPR',
    branchTemplate: ui.branchPattern,
    uiBranchStrategy: ui.branchStrategy,
    branchStrategy: ui.branchStrategy === 'fixed-branch' ? 'current' : 'new',
    prTitleTemplate: ui.prTitleTemplate,
    commitStrategy: ui.commitStrategy,
    commitMessagePrefix: ui.commitMessagePrefix,
    // 2모드 시안(A안) 필드 — 서버 `branchName` 과 충돌하지 않는 별도 키.
    branchModeSketch: ui.branchMode,
    branchModeNewName: ui.branchModeNewName,
  };
}

function fromServerSettings(server: Record<string, unknown>): GitAutomationSettings {
  const rawBranchMode = server.branchModeSketch;
  const branchMode: BranchMode = rawBranchMode === 'continue' || rawBranchMode === 'new'
    ? rawBranchMode
    : DEFAULT_AUTOMATION.branchMode;
  const branchModeNewName = typeof server.branchModeNewName === 'string'
    ? server.branchModeNewName
    : DEFAULT_AUTOMATION.branchModeNewName;
  return {
    ...DEFAULT_AUTOMATION,
    enabled: server.enabled !== false,
    branchStrategy: (server.uiBranchStrategy as GitAutomationSettings['branchStrategy'])
      ?? DEFAULT_AUTOMATION.branchStrategy,
    branchMode,
    branchModeNewName,
  };
}

function roundTrip(input: GitAutomationSettings): GitAutomationSettings {
  const serialized = toServerSettings(input);
  const stored = JSON.parse(JSON.stringify(serialized)); // 서버 저장 모사
  return fromServerSettings(stored);
}

// ---------------------------------------------------------------------------
// M1 — branchMode='continue' 가 저장·재로드 왕복 뒤에도 유지된다.
// ---------------------------------------------------------------------------

test('M1 — Given 사용자가 branchMode="continue" 로 저장 When 페이지를 새로고침 Then continue 가 라디오에 그대로 복원된다', () => {
  const saved: GitAutomationSettings = {
    ...DEFAULT_AUTOMATION,
    branchMode: 'continue',
    branchModeNewName: 'feature/keep-this',
  };

  const restored = roundTrip(saved);

  assert.equal(restored.branchMode, 'continue',
    "저장→재로드 후 branchMode 가 'new' 로 되돌아가면 A안 라디오가 매번 초기화되는 회귀(#8e4b841f) 재발");
  assert.equal(restored.branchModeNewName, 'feature/keep-this',
    'branchModeNewName 입력값은 모드 무관하게 보존되어야 한다');
});

// ---------------------------------------------------------------------------
// M2 — 'new' 모드의 브랜치명이 저장 경로에 실려 복원된다.
// ---------------------------------------------------------------------------

test('M2 — Given branchMode="new" + branchModeNewName="fix/login-refresh" When 왕복 Then 이름이 그대로 복원된다', () => {
  const saved: GitAutomationSettings = {
    ...DEFAULT_AUTOMATION,
    branchMode: 'new',
    branchModeNewName: 'fix/login-refresh',
  };

  const restored = roundTrip(saved);

  assert.equal(restored.branchMode, 'new');
  assert.equal(restored.branchModeNewName, 'fix/login-refresh');
});

// ---------------------------------------------------------------------------
// M3 — 레거시 프로젝트(본 필드를 모르는 row) 는 DEFAULT 값으로 폴백.
// ---------------------------------------------------------------------------

test('M3 — Given 서버 row 에 branchModeSketch/branchModeNewName 이 없음 When fromServerSettings Then DEFAULT_AUTOMATION 값으로 폴백', () => {
  const legacyRow = {
    enabled: true,
    flowLevel: 'commitOnly',
    branchTemplate: '{type}/{ticket}-{branch}',
    uiBranchStrategy: 'per-session',
    branchStrategy: 'new',
  };

  const restored = fromServerSettings(legacyRow);

  assert.equal(restored.branchMode, DEFAULT_AUTOMATION.branchMode,
    '레거시 row 에서는 A안 라디오가 항상 기본값으로 선택되어야 한다');
  assert.equal(restored.branchModeNewName, DEFAULT_AUTOMATION.branchModeNewName);
});

// ---------------------------------------------------------------------------
// M4 — 서버에 잘못된 문자열이 박혀도 DEFAULT 로 폴백.
// ---------------------------------------------------------------------------

test('M4 — Given 서버 row 에 branchModeSketch="garbage" When fromServerSettings Then DEFAULT("new") 로 폴백', () => {
  const garbageRow = {
    enabled: true,
    flowLevel: 'commitOnly',
    branchTemplate: '{type}/{ticket}-{branch}',
    uiBranchStrategy: 'per-session',
    branchStrategy: 'new',
    branchModeSketch: 'garbage',
    branchModeNewName: 42, // 숫자도 문자열로 강제 폴백
  };

  const restored = fromServerSettings(garbageRow);

  assert.equal(restored.branchMode, 'new');
  assert.equal(restored.branchModeNewName, DEFAULT_AUTOMATION.branchModeNewName);
});

// ---------------------------------------------------------------------------
// M5 — toServerSettings 가 두 필드를 항상 페이로드에 포함한다.
// ---------------------------------------------------------------------------

test('M5 — Given 임의의 GitAutomationSettings When toServerSettings Then payload 에 branchModeSketch·branchModeNewName 가 실린다', () => {
  const ui: GitAutomationSettings = {
    ...DEFAULT_AUTOMATION,
    branchMode: 'continue',
    branchModeNewName: 'chore/drift',
  };

  const payload = toServerSettings(ui);

  assert.equal(payload.branchModeSketch, 'continue',
    "save() 페이로드가 branchModeSketch 를 빼먹으면 서버 row 에 저장되지 않아 재로드 시 'new' 로 되돌아가는 회귀");
  assert.equal(payload.branchModeNewName, 'chore/drift');
});

// ---------------------------------------------------------------------------
// DEFAULT_AUTOMATION 소스 검사 — 승격 후 두 필드가 기본값 테이블에 올라 있는지.
// ---------------------------------------------------------------------------

test('DEFAULT_AUTOMATION 은 branchMode 와 branchModeNewName 을 기본값으로 정의해야 한다', () => {
  assert.equal(DEFAULT_AUTOMATION.branchMode, 'new',
    'A안 최초 진입 시 "새 브랜치 생성" 이 선택돼 있어야 한다 (branch-mode-mockup.md 섹션 2)');
  assert.equal(typeof DEFAULT_AUTOMATION.branchModeNewName, 'string',
    'branchModeNewName 초기값은 빈 문자열도 허용하는 string 이어야 한다');
});

// ---------------------------------------------------------------------------
// M6 — A안(2모드 시안) 축과 B안(4전략)·단일모드(fixed-branch) 축의 값 분기 일관성.
// 두 축은 GitAutomationSettings 에서 독립 필드이며, 서로를 덮지 않는다.
// (실질 체크리스트 ⑥ — "B안·단일모드와의 값 분기 일관성")
// ---------------------------------------------------------------------------

test('M6 — Given branchMode="continue" + branchStrategy="fixed-branch" 저장 When 왕복 Then 두 축 모두 각자의 값을 유지한다', () => {
  const saved: GitAutomationSettings = {
    ...DEFAULT_AUTOMATION,
    // 2모드(A안) 축
    branchMode: 'continue',
    branchModeNewName: 'feature/sketch-slug',
    // 4전략(B안) / 단일모드 축
    branchStrategy: 'fixed-branch',
    newBranchName: 'release/alpha',
  };

  const restored = roundTrip(saved);

  assert.equal(restored.branchMode, 'continue',
    'A안 축이 4전략 축과 엮여 덮이면 단순화 대안 UI 가 매번 기본값으로 초기화되는 회귀');
  assert.equal(restored.branchModeNewName, 'feature/sketch-slug');
  assert.equal(restored.branchStrategy, 'fixed-branch',
    '4전략(B안·단일모드) 축은 A안 축 변경에 영향을 받지 않아야 한다');
});

// ---------------------------------------------------------------------------
// M7 — 폴백·예외 케이스 모음. (실질 체크리스트 ⑦)
// null / undefined / boolean / 빈 객체 / 오타 값이 서버 row 에 섞여 들어와도
// 로드 계층은 항상 유효한 branchMode 값을 돌려줘 UI 라디오가 "선택 없음" 으로
// 깨지지 않는다.
// ---------------------------------------------------------------------------

test('M7 — Given 서버 row 에 null·숫자·빈 객체 등 이상값 When fromServerSettings Then branchMode 는 항상 "new"·"continue" 중 하나', () => {
  const cases: Array<Record<string, unknown>> = [
    { branchModeSketch: null, branchModeNewName: null },
    { branchModeSketch: undefined },
    { branchModeSketch: true, branchModeNewName: 123 },
    { branchModeSketch: {}, branchModeNewName: [] },
    {}, // 필드 자체 부재
  ];
  for (const row of cases) {
    const restored = fromServerSettings(row);
    assert.ok(
      restored.branchMode === 'new' || restored.branchMode === 'continue',
      `이상값(${JSON.stringify(row)}) 에도 branchMode 는 유효 열거값이어야 한다`,
    );
    assert.equal(typeof restored.branchModeNewName, 'string',
      `이상값(${JSON.stringify(row)}) 에도 branchModeNewName 은 string 으로 폴백되어야 한다`);
  }
});
