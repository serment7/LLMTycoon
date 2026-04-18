---
purpose: regression-run-log
scope: auto-dev-toggle × shared-goal-modal × hydration-rerun
executor: 개발자 에이전트 (6940336c-c26d-46cb-9054-f4803030c898)
executed-at: 2026-04-19
trigger-directive: 지시 #db4b3ed8 (완료 보고 대상: 디자이너)
related-code:
  - tests/autoDevToggleSharedGoalModal.regression.test.ts (본 턴 신규 · C1~C4 + 진리표)
  - tests/sharedGoal.regression.test.ts (동반 검증 · S1~S4 서버 가드)
  - tests/shared-goal-form-mockup.md (UI 시안 · 상태 머신 4상태)
  - tests/project-settings-save-load-regression-20260419.md (우선 검토 · 저장/로드 계약)
  - src/server/taskRunner.ts (setAutoDev → getActiveSharedGoal 가드)
  - src/types.ts (SharedGoal · AutoDevSettings 형상)
  - src/App.tsx (자동 개발 토글 핸들러 · line 1916~1948 · 모달 아직 미구현)
related-tests:
  - tests/autoDevToggleSharedGoalModal.regression.test.ts (12건, 전부 통과)
  - tests/sharedGoal.regression.test.ts (12건, 11 통과 + 1 skip(미구현 TODO))
---

# 자동 개발 토글 × 공동 목표 모달 회귀 (2026-04-19)

지시 #db4b3ed8 의 네 가지 케이스(C1~C4) 를 **시뮬레이터 기반 회귀 스위트**
(`tests/autoDevToggleSharedGoalModal.regression.test.ts`) 로 명문화하고 1회 실행했다.

현재 저장소에는 `SharedGoalForm.tsx` / 모달 UI 실구현이 **아직 착수되지 않은 상태** 이며
(`src/components/` 목록에 부재, `tests/shared-goal-form-mockup.md` 에만 시안 존재),
자동 개발 토글은 `src/App.tsx:1916~1948` 에서 목표 유무를 체크하지 않고 바로
`PATCH /api/auto-dev` 를 호출하는 **경유 구조**다. 따라서 본 문서는 **(A) UI 계약을
시뮬레이터 순수 함수로 잠그고**, **(B) 추후 실구현이 들어올 때 React 훅으로
1:1 치환 가능한 형태로 테스트를 유지** 하는 데 목적을 둔다.

우선 검토 파일(프로젝트 설정 저장/로드 회귀) 의 핵심 결론 — "DB 가 단일 진실
소스, 낙관적 갱신 금지, 새로고침 시 플리커 금지" — 이 그대로 C4(하이드레이션
경로에서 모달 중복 표시 금지) 의 근거가 된다.

## 실행 결과 요약

실행 환경: Windows 11, Node 기본, `npx tsx --test …` (2026-04-19 수행).

| 스위트                                                       | 테스트 수 | 통과/실패       | 비고                                                  |
| ------------------------------------------------------------ | --------- | --------------- | ----------------------------------------------------- |
| tests/autoDevToggleSharedGoalModal.regression.test.ts (신규) | 12        | ✅ 12 / 0       | C1·C2·C3·C4 + 8조합 진리표 전부 통과                    |
| tests/sharedGoal.regression.test.ts (참고 동반)              | 12        | ✅ 11 / 0 · ⏭ 1 | skip 1 은 `buildLeaderPlanPrompt` 네이티브 도입 TODO 가드 |

## 시나리오 매트릭스 · 기대 결과 vs 실제 결과

| 번호 | 입력                                                            | 기대 결과                                                                 | 실제 결과                                        | 판정 |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ | ---- |
| C1   | 목표 미입력(`activeGoal=null`) + `intent=on` + `fromHydration=false` | `showModal=true`, `modalMode='goal-required'`, `shouldPatchServer=false`, `nextEnabled=false`, 안내 로그에 "공동 목표" 포함 | 동일 — assert 5건 모두 통과                        | ✅   |
| C1'  | `title` 만 있고 `description` 이 공백·탭·개행                    | 동일한 `showModal=true` (하프 저장도 미입력 간주)                            | 통과                                               | ✅   |
| C1'' | `status='archived'` 인 과거 목표                                 | 활성 목표 부재로 간주 → 모달                                                | 통과                                               | ✅   |
| C2   | 활성 목표 존재 + `intent=on`                                     | `showModal=false`, `shouldPatchServer=true`, `nextEnabled=true` (즉시 루프) | 통과                                               | ✅   |
| C2'  | C1 모달에서 목표 저장 후 [확인] (`onGoalModalConfirm`)            | C2 와 동일한 outcome                                                      | 통과                                               | ✅   |
| C3   | C1 모달 상태에서 [취소] 클릭                                     | `nextEnabled=false`, `showModal=false`, `shouldPatchServer=false`          | 통과 (서버 호출 없이 OFF 복귀)                      | ✅   |
| C3'  | ESC 키로 모달 닫기 (동일 핸들러)                                 | [취소] 와 `deepEqual`                                                     | 통과                                               | ✅   |
| C3'' | 취소 후 다시 토글 ON 시도                                        | 상태 라칭 없이 C1 과 동일하게 모달 재표시                                    | 통과                                               | ✅   |
| C4   | `fromHydration=true` + `currentEnabled=true` + 활성 목표         | 모달 금지, 서버 호출 금지, 초기 `enabled` 값 그대로 반영                     | 통과 — 새로고침 플리커 없음                         | ✅   |
| C4'  | 하이드레이션 중 활성 목표 응답이 지연(`activeGoal=null`)          | 그래도 모달 금지 (서버 신뢰 — 200ms 후 도착할 목표를 기다림)                  | 통과                                               | ✅   |
| C4'' | 하이드레이션 직후 사용자가 직접 토글 클릭                         | 평시 가드 복귀 — 목표 없으면 C1 과 동일 모달                                  | 통과                                               | ✅   |
| 진리표 | (intent × hasGoal × fromHydration) 8조합                      | (intent=on, goal=null, hydration=false) 만 모달, 나머지 7건 모달 금지        | 8조합 전부 기대치와 일치                             | ✅   |

## 핵심 불변 계약

스위트가 잠그는 불변 3개:

1. **모달은 "사용자가 직접 OFF→ON 을 눌렀고 활성 공동 목표가 없을 때" 에만 뜬다.**
   하이드레이션 경로(`fromHydration=true`) 에서는 어떤 조합이든 모달을 띄우지 않는다.
2. **모달이 떠 있는 동안 서버 `PATCH /api/auto-dev` 는 절대 호출되지 않는다.** 낙관적
   갱신을 허용하면 취소 시 "ON→OFF" 의 시각적 플리커와 서버-클라 상태 분기(일시적
   enabled=true 저장) 가 생긴다.
3. **취소/확인/재시도 경로에 숨은 메모리가 없다.** 한 번 취소했다고 다음 번 클릭에서
   모달이 생략되거나, 확정했다고 이후 세션에서 자동 확정되는 식의 라칭 금지.

## 구현 시 유의(실 구현에 이식하기 위한 핸드오프)

본 스위트의 `evaluateAutoDevToggle` / `onGoalModalCancel` / `onGoalModalConfirm`
순수 함수를 그대로 React 훅(`useAutoDevToggle`) 에 이식하면 된다. 구체적으로:

- **토글 onClick**: `evaluateAutoDevToggle({ intent: !enabled ? 'on':'off', currentEnabled: enabled, activeGoal: state.sharedGoal })` 결과로
  - `showModal` 이면 모달만 연다 (setOpen(true)).
  - `shouldPatchServer` 이면 기존 경로(`PATCH /api/auto-dev`) 호출.
- **모달 취소/ESC 핸들러**: `onGoalModalCancel` 결과를 setEnabled(false) + setOpen(false) 로 적용.
  원래 토글 시각을 낙관적으로 ON 으로 밀어버리지 말 것(시뮬레이터는 `nextEnabled=false`
  고정). 이 원칙이 C3' 의 ESC 일관성을 지탱한다.
- **하이드레이션 트리거**: 앱 첫 마운트(`GET /api/auto-dev` 1회 응답) 경로는
  `fromHydration=true` 로 `evaluateAutoDevToggle` 을 통과시켜 `showModal=false` 를
  받는다. 이후 사용자 클릭부터는 `fromHydration=false` 로 돌린다. C4/C4''/C4' 가
  이 단절 지점의 계약.
- **하프 저장**: C1' 이 검증하듯 `title/description` 둘 중 하나라도 비면 "미입력" 으로
  간주. `SharedGoalForm` 의 `saved` 상태 조건(`mockup §3`)과 일치시켜야 한다.

## 리스크 메모

- (미구현) 현 `App.tsx:1916~1948` 토글은 목표 확인 없이 바로 PATCH 를 쏜다.
  서버 `setAutoDev` (src/server/taskRunner.ts:265~268) 가 400 으로 거절하므로 기능상
  **안전망은 존재** 하지만, 사용자 경험(모달 안내) 은 비어 있다. 본 스위트가 실구현
  도입 시 즉시 활성화되는 사전 회귀 가드 역할을 한다.
- 우선 검토 파일의 "S2 — 재진입 플리커 방지" 와 본 문서의 C4 는 **같은 UX 원칙의
  두 측면**(설정 값 플리커 ↔ 모달 플리커)이다. 두 문서가 내려놓은 공통 계약 —
  "하이드레이션 프레임은 UI 를 렌더만 하고 판정은 하지 않는다" — 을 한 곳에 문서화해
  두면 다음 신규 기능(예: 자동 커밋 토글) 에 재사용하기 쉬울 것.
- 모달 실구현 PR 에서는 본 스위트의 `evaluateAutoDevToggle` 을 **export 하여 훅이
  실함수를 호출** 하는 구조가 권장된다. 테스트 로컬 시뮬레이터 → 실구현 교체 시
  import 경로만 바꾸면 계약 재검증이 자동으로 이어진다.
