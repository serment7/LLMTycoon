# 프로젝트 관리 탭 공동 목표 폼 표시 회귀 테스트 보고 (2026-04-19)

- **담당**: Thanos (작업 ID #5c25c4b0)
- **리더 보고 대상**: Kai
- **테스트 파일**:
  - `tests/sharedGoalFormDisplay.regression.test.ts` (본 턴 신규 · P1~P4 + 진리표)
  - `tests/autoDevToggleSharedGoalModal.regression.test.ts` (동반 · C4 하이드레이션 계약과 맞닿음)
  - `tests/sharedGoal.regression.test.ts` (동반 · S1 서버 가드)
- **우선 검토 파일**: `tests/shared-goal-form-mockup.md` (시안 §2 §3 §10)
- **실행 결과 요약**:
  - `tests/sharedGoalFormDisplay.regression.test.ts` → **15건, 전부 통과** (create/edit/skeleton 분기 + 모달 오버레이 계약)
  - 동반 `autoDevToggleSharedGoalModal.regression.test.ts` → 이미 12건 통과(저장소 기존값)로 P4 와 모순 없음
  - 동반 `sharedGoal.regression.test.ts` → 11건 통과 + 1 skip(`buildLeaderPlanPrompt` 네이티브 도입 TODO)

## 1. 배경

`SharedGoalForm.tsx` 실 구현은 아직 착수되지 않았으나(저장소 `ProjectManagement.tsx` 내 `sharedGoal` 키워드 0건), 시안(`tests/shared-goal-form-mockup.md`) 은 이미 고정되어 있고 App.tsx `sharedGoalPromptOpen` 모달에서 사용자를 "프로젝트 관리 탭" 으로 유도한다(`src/App.tsx:2119~2136`).

따라서 "탭 진입 → 폼 표시" 경로가 실제 컴포넌트 도입 시 어떤 조건에서 렌더되어야 하는지를 **시뮬레이터 기반 순수 함수** 로 선제적으로 잠가, 구현이 들어오는 순간 회귀 없이 이식되도록 한다. 기존 `tests/sharedGoal.regression.test.ts` 와 `tests/autoDevToggleSharedGoalModal.regression.test.ts` 가 취한 것과 동일한 패턴.

## 2. 대상 시나리오 (P1~P4)

| ID | 상태 | 기대 동작 | 회귀 방지 목적 |
|----|------|-----------|---------------|
| P1 | 활성 공동 목표 없음 + 프로젝트 관리 탭 진입 | `renderContainer=true`, `mode='create'`, `prefilledFrom=null` | 빈 상태에서 사용자가 입력 시작할 수 있는 폼이 반드시 보이도록 |
| P2 | 활성 목표 있음 + 프로젝트 관리 탭 진입 | `mode='edit'`, `prefilledFrom=activeGoal` (title/description/priority/deadline 전달) | 저장된 목표를 즉시 수정 가능, 프리필 누락 방지 |
| P3 | 새로고침·하이드레이션 직후 | `renderContainer=true`, `mode='skeleton'`, `showFields=false` | 찰나 깜빡임(`null` 렌더)·프리필 비움 플리커 방지 |
| P4 | SharedGoalModal(자동 개발 ON 트리거) 오픈 중 | `renderContainer=true`, `accessibleWhileModalOpen=false` | 모달 뒤 배경 폼 DOM 이 살아 있어야 ESC/저장 후 편집 연속성 |

## 3. 불변 계약 (진리표)

축: `(hasActiveGoal × hydrating × sharedGoalModalOpen)` = 8 조합.
- `hydrating=true` 행: 모두 `skeleton` + 컨테이너 유지, 모달·목표 무관.
- `hydrating=false` 행: `hasActiveGoal` 가 `create`/`edit` 결정, 모달 유무는 컨테이너 렌더에 영향 없음.

진리표는 테스트 파일 마지막 블록에 배열로 고정되어 있어, 구현 PR 이 한 분기를 빠뜨리면 즉시 실패한다.

## 4. 시뮬레이터 설계 요지

```ts
type FormMode = 'create' | 'edit' | 'skeleton';

evaluateSharedGoalFormVisibility({
  activeTab, selectedProjectId, activeGoal, hydrating, sharedGoalModalOpen
}): {
  renderContainer, showFields, mode, prefilledFrom, accessibleWhileModalOpen, reason
}
```

불변 계약 5개 (테스트 파일 주석 §불변 계약):
1. `activeTab==='project-management' && selectedProjectId` → `renderContainer=true`.
2. `hydrating=true` → `mode='skeleton'`, `showFields=false`, 컨테이너는 유지.
3. `activeGoal.status==='active'` → `edit` + 프리필, 그 외 → `create`.
4. `sharedGoalModalOpen=true` 는 컨테이너를 언마운트하지 않으며, 상호작용만 일시 차단.
5. `archived`/`completed` 과거 목표는 활성 없음으로 간주 → `create` 모드로 새 목표 입력 가능.

## 5. 실제 구현 시 매핑 지침 (후속 PR 용)

- `src/components/SharedGoalForm.tsx` 가 props `{ activeGoal, hydrating, modalOpen, onSave, onClear }` 를 받아, 본 시뮬레이터 결과를 그대로 JSX 분기로 옮기면 된다.
- 배치 위치는 시안대로 `src/components/GitAutomationPanel.tsx` 헤더 확장 영역 또는 `ProjectManagement.tsx` 의 우측 사이드 패널 — 어느 쪽을 택해도 `activeTab='project-management'` 탭 서브트리 내부이므로 본 계약은 동일.
- 하이드레이션 경로는 `useProjectOptions` · GET `/api/projects/:id/shared-goal` 응답이 도착하기 전 구간에 한해 `hydrating=true` 를 흘리면 된다.
- SharedGoalModal(자동 개발 ON 가드용) 이 도입되면 본 시뮬레이터의 `sharedGoalModalOpen` 인자로 연결.

## 6. 실행 커맨드

```bash
npx tsx --test tests/sharedGoalFormDisplay.regression.test.ts
npx tsx --test tests/autoDevToggleSharedGoalModal.regression.test.ts
npx tsx --test tests/sharedGoal.regression.test.ts
```

## 7. 후속 권고

1. `SharedGoalForm.tsx` 실 구현 PR 에서 본 시뮬레이터를 컴포넌트 렌더 조건으로 치환하고, `@testing-library/react` 기반 UI 레벨 검증 테스트를 추가로 붙인다.
2. `hydrating` 플래그의 실제 상태 관리(App/ProjectManagement 중 어디에서 소유할지)는 `useProjectOptions` 와 동일한 레이어에 두는 것이 추천 — `project-settings-panel-hydration-regression.md` 와 한 레이어에서 처리해야 플리커 회귀가 한꺼번에 잡힌다.
3. `SharedGoalModal` 이 도입될 때는 본 문서의 P4 를 실 DOM 스냅샷 테스트로 승격(모달 오픈 상태에서 `getByRole('form')` 이 DOM 에 잔존하는지 확인).
