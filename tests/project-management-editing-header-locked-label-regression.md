---
purpose: manual-test
scope: project-management × editing-header × locked-placeholder-label
owner: 베타(개발자 겸임)
related-code:
  - src/components/ProjectManagement.tsx (formatEditingProjectLabel, line 432~470)
  - src/components/ProjectManagement.tsx (편집 중 헤더 렌더, line 944~990)
  - src/components/ProjectManagement.test.ts (TC-H1~H7 · S1~S3 계약)
  - src/components/ProjectMenuScope.test.ts (TC-MENU-WIRE1~3 · TC-MENU-NAME1~3 계약)
  - src/App.tsx (오피스 플로어 사이드바 탭 부제 표시, line 1293~1299)
  - src/components/EmptyProjectPlaceholder.tsx (미선택 안내 카피)
sibling-doc: tests/office-floor-project-name-regression.md
contract-conflict:
  - 아래 시나리오가 고정하려는 동작("편집 중" 헤더 타이틀이 항상 '선택된 프로젝트
    없음' 으로 잠금)은 현행 TC-H5/H6/H7 · TC-MENU-WIRE2/WIRE3 · TC-MENU-NAME1/NAME2
    와 직접 충돌한다. 기존 계약은 "선택 상태에서 placeholder 로 떨어지면 회귀" 라고
    명시하므로, 본 문서의 기대는 기존 테스트를 먼저 업데이트(혹은 합의된 롤백)
    하지 않으면 CI 에서 상호 모순이 발생한다. **변경 반영 전 리뷰 필수.**
---

# 수동 회귀 — 프로젝트 관리 "편집 중" 뒤 고정 라벨

프로젝트 관리(`/project-management`) 페이지 최상단 헤더의 **"편집 중"** 배지 우측
타이틀 영역을 현재 편집 중인 프로젝트의 이름 대신 **고정 문자열 "선택된 프로젝트
없음"** 으로 고정하는 변경에 대한 수동 회귀 시나리오. 라벨이 잠긴 상태에서도
오피스 플로어 탭 · 태스크 패널 · 파일 그래프 등 **다른 위치의 프로젝트명 표시는
영향 받지 않아야** 하며, 편집 모드 진입/종료로 라벨 DOM 이 재생성될 때도
placeholder 가 깨지지 않아야 한다.

> ⚠️ **계약 충돌 경고:** `src/components/ProjectManagement.test.ts` 의 TC-H5/H6/H7
> 과 `src/components/ProjectMenuScope.test.ts` 의 TC-MENU-WIRE2/WIRE3 ·
> TC-MENU-NAME1/NAME2 는 "선택 상태에서 헤더가 실제 프로젝트 이름을 비춰야 한다"
> 를 불변식으로 못박는다. 본 문서의 E2~E4 기대가 코드로 반영되려면 위 테스트를
> 동시에 조정하거나, 변경 자체의 의도를 리더(Kai)가 확정해야 한다. 둘 중 하나가
> 선행되지 않으면 `npm test` 가 즉시 깨진다.

## 전제 조건

- `npm run dev` 로 프론트엔드 기동, 로그인 후 초기 `gameState` 수화 완료.
- `gameState.projects` 에 2개 이상의 프로젝트가 있고 각각 `ManagedProject`
  (`fullName=org/repo`) 가 연결된 상태 — `ProjectManagement` 본체가 `null` 가드
  (`ProjectManagement.tsx:480~483`)에 막혀 언마운트되지 않아야 시나리오 관측 가능.
- DevTools → Application 탭에서 `SELECTED_PROJECT_KEY` 와
  `pinnedPrTargetProjectId` 를 직접 관찰/삭제할 수 있어야 함.
- 브라우저 한국어 로케일(`ko-KR`). "선택된 프로젝트 없음" 문구는 번역 자원화되어
  있지 않으므로 로케일 변동 시에도 같은 한글 문자열로 고정되어야 한다.

## 관찰 포인트

| 위치                                                    | 기대 값                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------- |
| 헤더 `eyebrow` (`text-[10px] uppercase tracking-[0.2em]`) | 고정 "편집 중". 선택 여부와 무관하게 유지                                 |
| 헤더 `<h1>` 타이틀                                       | **고정 "선택된 프로젝트 없음"** — 본 변경의 핵심. 선택/전환에도 불변       |
| 헤더 컨테이너 `aria-label`                               | "현재 편집 중인 프로젝트" (변경 없음)                                     |
| 헤더 톤(테두리/배경)                                     | placeholder 톤(점선 테두리, 반투명 배경) — `editingLabel.hasProject=false` 와 동일 분기 |
| 오피스 플로어 사이드바 탭 부제                            | 기존대로 선택된 `project.name` (본 변경과 격리)                           |
| `describeProjectScope` 툴팁                               | 선택이 있어도 `PROJECT_SCOPE_TOOLTIP` 고정 폴백 (스코프 카피도 잠긴 상태)  |

## 시나리오 매트릭스

| 번호 | 축                          | 사전 상태                                     | 트리거                                | 기대                                                     |
| ---- | --------------------------- | --------------------------------------------- | ------------------------------------- | -------------------------------------------------------- |
| E1   | 미선택 placeholder 유지     | `selectedProjectId === null`                  | 프로젝트 관리 탭 진입                | 타이틀 "선택된 프로젝트 없음", 톤 placeholder            |
| E2   | 선택 후에도 placeholder 잠금 | `selectedProjectId = 'proj-A'`                | 프로젝트 A 선택/전환                 | **타이틀 여전히 "선택된 프로젝트 없음"** (실제 이름 금지) |
| E3   | 전환 후에도 잠금             | E2 상태에서 A→B 전환                          | 다른 프로젝트 카드의 "워크스페이스 열기" | 헤더 타이틀 변동 없음. 오피스 플로어 부제만 B 로 교체    |
| E4   | 편집 모드 진입/종료          | E2/E3 상태                                    | 설정 편집 시작 · 저장/취소           | 편집 상태 변화로 라벨이 빈 값 · 옛 이름 · undefined 금지 |
| E5   | 격리 검증(오피스 플로어)     | E2/E3 상태                                    | 오피스 플로어 탭 · 태스크 · 파일 그래프 확인 | 해당 위치는 선택 프로젝트 이름을 평소대로 표기            |

---

## E1 — 미선택 상태에서 placeholder 기본 표기

- 선행: `window.localStorage.removeItem('SELECTED_PROJECT_KEY')` 후 새로고침.
  `selectedProjectId === null`. 사이드바 "프로젝트 관리" 탭으로 이동해
  `ProjectManagement` 가 `currentProjectId=null` 로 내려와 본체가 언마운트되는지
  먼저 확인(언마운트되면 E1 관측 불가 — null 가드 해제 또는 더미 프로젝트 필요).
- 절차:
  1. 프로젝트 관리 본체가 렌더된 상태에서 최상단 `<header aria-label="현재 편집 중인 프로젝트">` 를 선택.
  2. eyebrow(`"편집 중"`) 와 타이틀 `<h1>` 을 각각 읽는다.
- 기대:
  - eyebrow = "편집 중"(라이브 닷은 숨김 — `hasProject=false`).
  - 타이틀 = **"선택된 프로젝트 없음"**, `italic` 톤.
  - 헤더 컨테이너 클래스에 `border-dashed` + `bg-black/20` 이 붙어 placeholder 톤을 띤다.
  - `describeProjectScope` 툴팁은 `PROJECT_SCOPE_TOOLTIP` 그대로.
- 실패 시 확인:
  - (a) `formatEditingProjectLabel(null)` 이 기존대로 `title: '선택된 프로젝트 없음'` 으로 폴백하는지.
  - (b) null 가드 때문에 본체가 렌더되지 않고 사이드바만 보인다면 E1 은 "본체 언마운트로 간접 검증" 으로 통과 — 다만 이 경우 E2~E4 관측이 불가능하므로, 가드 유지/해제 정책을 Kai 에게 확인.

## E2 — 프로젝트 선택 후에도 타이틀이 placeholder 로 잠김

- 선행: `gameState.projects` 에 `{id:'proj-A', name:'Atlas'}` 와 연결된
  `ManagedProject{fullName:'acme/atlas'}` 존재. `selectedProjectId = 'proj-A'`.
- 절차:
  1. 오피스 플로어 탭에서 Atlas 프로젝트를 선택해 `selectedProjectId` 갱신.
  2. 사이드바 "프로젝트 관리" 탭으로 이동.
  3. 헤더 eyebrow/타이틀/컨테이너 톤을 관찰.
- 기대:
  - eyebrow = "편집 중" (선택 상태이므로 라이브 닷이 **켜져야** 하는지, 이번 변경이 라이브 닷까지 숨기는지는 Kai 확정 필요 — 초안은 **도트 유지**).
  - 타이틀 = **"선택된 프로젝트 없음"** — `"atlas"` / `"acme/atlas"` / `"Atlas"` 어떤 변형도 등장 금지.
  - 컨테이너 톤은 기존의 `border-[var(--pixel-accent)] bg-[#0f3460]` 강조 톤 유지 여부를 **디자이너 합의로 확정** (고정 라벨이어도 "편집 컨텍스트 있음" 을 시각적으로 알려야 하는지).
- 실패 시 확인:
  - (a) `formatEditingProjectLabel` 이 `hasProject=true` 경로에서 여전히 repo 이름을 `title` 에 넣는다면 본 변경이 미반영된 것.
  - (b) **계약 충돌:** 기존 TC-H5/H7, TC-MENU-WIRE2, TC-MENU-NAME1 가 `title === 'atlas'` 를 강제한다. 해당 테스트를 함께 수정하지 않으면 유닛 테스트 선에서 실패.
  - (c) 헤더가 잠깐이라도 `"atlas"` 를 비추는 프레임이 있으면, React 렌더 배치 문제로 새 고정 규칙이 끝까지 전파되지 않은 것. `formatEditingProjectLabel` 이 분기 하나만 남기고 모든 입력을 placeholder 로 축약했는지 재확인.

## E3 — A→B 전환에도 타이틀 불변

- 선행: E2 상태(Atlas 선택 + 타이틀 "선택된 프로젝트 없음"). `ManagedProject{id:'mp-B', projectId:'proj-B', fullName:'acme/borealis'}` 존재.
- 절차:
  1. 오피스 플로어 탭으로 이동해 Borealis 프로젝트를 선택.
  2. 프로젝트 관리 탭으로 복귀.
  3. 헤더 타이틀 · 오피스 플로어 사이드바 부제를 동시에 관찰.
- 기대:
  - 프로젝트 관리 헤더 타이틀은 여전히 **"선택된 프로젝트 없음"**.
  - 동시에 **오피스 플로어 사이드바 부제는 "Atlas" → "Borealis" 로 정상 갱신** (이 부분이 회귀하면 E5 격리가 무너진 것).
  - `SELECTED_PROJECT_KEY` · `pinnedPrTargetProjectId` 는 기존대로 `proj-B` 로 기록된다.
- 실패 시 확인:
  - (a) `editingProject` 가 `prTargetManaged.find(p => p.id === selectedProjectId)` 로 찾아지는 경로는 유지되어야 한다(본 변경이 조회 자체를 끊어 놓으면 `hasProject` 힌트가 필요한 하위 컴포넌트가 같이 깨진다).
  - (b) 헤더 타이틀이 "Borealis" 로 잠깐 뒤집히면 새 고정 규칙이 `useMemo` 캐시 안쪽까지 전파되지 않은 것.
  - (c) 오피스 플로어 부제도 "선택된 프로젝트 없음" 으로 같이 떨어지면 본 변경이 `formatEditingProjectLabel` 이 아니라 사이드바 표시기까지 망가뜨린 것.

## E4 — 편집 모드 진입/종료 중 라벨 안정성

- 선행: E2 또는 E3 상태.
- 절차:
  1. 프로젝트 관리 메뉴 하단의 설정 편집 버튼(예: PR base 브랜치 · 자동화 토글 · 리뷰어 편집) 을 눌러 편집 모드 진입.
  2. 편집 폼이 열리는 동안 헤더 타이틀 DOM 을 연속적으로 관찰(React DevTools Profiler 의 "Highlight updates" 로 리렌더 추적).
  3. 저장 또는 취소로 편집 모드 종료.
  4. 폼이 닫힌 직후 헤더 타이틀을 다시 읽는다.
- 기대:
  - 편집 진입/종료 어느 시점에도 타이틀 = "선택된 프로젝트 없음" 이 한 프레임도 빠짐없이 유지.
  - 빈 문자열 `""`, `undefined`, `"null"`, `"undefined/undefined"` 같은 텍스트가 노출되면 즉시 회귀.
  - 편집 폼 본문에서 참조하는 `describeProjectScope` 출력이 placeholder 툴팁으로 고정되는지 툴팁 호버로 확인.
- 실패 시 확인:
  - (a) 편집 폼이 `formatEditingProjectLabel` 을 재호출할 때 입력을 달리해(예: 폼 내부의 임시 projectDraft) 포맷터가 다른 분기로 떨어지지 않는지 확인.
  - (b) 편집 종료 직후 `selectedProjectId` 가 잠시 `null` 로 깜빡이면 폼 state 리셋 로직 회귀 — 본 변경과 무관한 기존 버그일 수도 있다.

## E5 — 오피스 플로어 · 태스크 · 파일 그래프 격리 검증

- 선행: E2/E3 중 어느 상태든.
- 절차:
  1. 사이드바 **오피스 플로어** 탭의 부제 확인 — 현재 `selectedProjectId` 의
     프로젝트 이름이 그대로 노출되어야 한다(O1~O4, `office-floor-project-name-regression.md`).
  2. **작업**(태스크 대기열) 탭의 상단 요약 카피와 태스크 카드의 프로젝트 배지 확인.
  3. **오피스 플로어** 탭 메인 영역의 파일 그래프 · 에이전트 캐릭터 말풍선에 프로젝트
     이름이 포함된 문장이 그대로 유지되는지 확인.
  4. `AgentStatusPanel` / `AgentStatusSnapshot` 의 지표 집계 기준 프로젝트 표기 확인.
- 기대:
  - 위 4군데 모두 기존과 동일하게 선택된 프로젝트 이름(또는 파생 표기)을 노출.
  - 오직 프로젝트 관리 탭 헤더 타이틀만 placeholder 로 잠겨 있어야 한다.
- 실패 시 확인:
  - (a) 본 변경이 공유 유틸(`formatEditingProjectLabel`)을 손대 다른 호출자까지 영향을 준 경우 — `ProjectManagement.tsx` 내부에서만 고정 문자열로 갈아 끼우고, 유틸 서명은 유지했는지 확인.
  - (b) 오피스 플로어 부제가 같이 "선택된 프로젝트 없음" 이 됐다면 `App.tsx` 사이드바가 동일 유틸을 재사용한 것 — 유틸 경로를 분리해야 한다.

---

## 회귀 시그널 표 (R1~R7)

| 코드 | 회귀 신호                                                                  | 재현 시 확인할 소스                                                |
| ---- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| R1   | 선택 상태에서 헤더 타이틀이 실제 repo 이름을 비춘다                        | `formatEditingProjectLabel` 의 `hasProject=true` 분기가 아직 살아 있음 |
| R2   | A→B 전환 직후 "atlas" → "borealis" 로 잠깐 뒤집힌다                        | `useMemo` 캐시 누수 또는 렌더 배치 문제                            |
| R3   | 오피스 플로어 사이드바 부제까지 "선택된 프로젝트 없음" 으로 같이 떨어진다   | 변경이 공유 유틸까지 오염 — 경로 분리 필요                        |
| R4   | 편집 폼 열림 순간 타이틀이 빈 문자열로 깜빡인다                            | 편집 폼이 placeholder 를 오버라이드하는 경로                       |
| R5   | `describeProjectScope` 툴팁이 `acme/atlas` 같은 이름을 포함한다             | 스코프 카피 고정 규칙이 전파되지 않음                              |
| R6   | 유닛 테스트에서 TC-H5/H7 · TC-MENU-WIRE2/WIRE3 · TC-MENU-NAME1/NAME2 이 빨간색 | 기존 계약과 충돌 — 테스트도 함께 업데이트해야 함                   |
| R7   | 라이브 닷(녹색 펄스) 이 선택 상태에서도 사라졌다                           | 디자이너 합의와 다른 방향으로 잠금이 적용됨                        |

## 교차 확인 순서(관측 체크리스트)

1. 프로젝트 관리 헤더 타이틀 DOM 값 = "선택된 프로젝트 없음" 인지 먼저 확인.
2. 오피스 플로어 사이드바 부제가 선택된 프로젝트 이름인지 — E5 격리 유지 확인.
3. `ProjectManagement.test.ts` · `ProjectMenuScope.test.ts` 가 업데이트됐는지
   (`git diff` 로 TC-H5/H7 · TC-MENU-WIRE2/WIRE3 · TC-MENU-NAME1/NAME2 가 고정
   placeholder 방향으로 수정됐는지 확인).
4. `describeProjectScope` 출력 · 스코프 툴팁이 기본 카피로 잠겼는지 호버로 확인.
5. 편집 폼 진입/종료 각 1회 후 DOM 재검사 — R4 재현 여부.

## 복구/리셋 절차

- `SELECTED_PROJECT_KEY` · `pinnedPrTargetProjectId` 제거 후 새로고침.
- 테스트 프로젝트(Atlas/Borealis)는 프로젝트 관리 탭에서 삭제. 잔여 `localStorage`
  키가 남으면 다음 진입 시 유령 선택으로 E1 이 깨진다.
- 본 변경 롤백이 필요하면 `formatEditingProjectLabel` 의 `hasProject=true` 분기를
  원복하고 기존 `TC-H5~H7` / `TC-MENU-WIRE2~3` / `TC-MENU-NAME1~2` 가 녹색으로 돌아오는지 확인.

## 리더 확인 요청 지점

- **결정 필요 1:** 선택 상태의 라이브 닷(녹색 펄스)을 유지할지, 이번 변경과 함께 항상 숨길지 — 디자이너 합의 필요.
- **결정 필요 2:** `formatEditingProjectLabel` 을 고쳐 모든 호출자에 영향을 줄지, 아니면 `ProjectManagement.tsx` 렌더 직전에서만 `title` 을 덮어쓸지(유틸 서명 보존) — 유지보수 비용이 다르다.
- **결정 필요 3:** 기존 `ProjectManagement.test.ts` / `ProjectMenuScope.test.ts` 의
  placeholder 금지 불변식을 본 변경에 맞춰 전환할지, 아니면 본 변경 자체를 재검토할지.
