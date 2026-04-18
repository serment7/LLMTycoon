---
purpose: qa-scenario-plan
scope: workspace-sidebar × graph-reset-button × store-reset × regression
executor: 개발자 에이전트 (6940336c-c26d-46cb-9054-f4803030c898)
authored-at: 2026-04-19
trigger-directive: 지시 #ca84c50f (완료 보고 대상: 리더 Kai)
related-code:
  - src/App.tsx (사이드바 하단 버튼 스택, line 1353~1367)
  - src/App.tsx (emergencyStop 핸들러, line 1042~1057)
  - src/App.tsx (gameState 단일 소스 — projects / agents / files / dependencies, line 148)
  - src/utils/workspaceInsights.ts (파일·의존성 그래프를 소비하는 인사이트 계약)
  - src/utils/codeGraphFilter.ts (그래프 필터 유틸 — 리셋 후 빈 입력 안전성 재확인)
related-docs:
  - tests/office-floor-project-name-regression.md (사이드바 수동 회귀 템플릿)
  - tests/git-automation-ui-regression-20260418.md (자동 테스트 + 수동 보조 회귀 템플릿)
status: scenario-drafted (feature-not-yet-merged → 실제 관찰 칸 공란)
---

# "그래프 초기화" 버튼 QA 시나리오 (2026-04-19)

좌측 워크스페이스 사이드바 하단의 **"에이전트 고용"** 과 **"긴급중단"** 사이에
새로 들어올 **"그래프 초기화"** 버튼을 대상으로 한 수동·자동 회귀 계약을
정의한다. 본 문서는 지시 #ca84c50f 에 따라 QA 시나리오를 **사전에** 고정하여
기능이 main 에 병합되는 순간 G1~G5 를 그대로 재생할 수 있도록 한다.

현재 시점(2026-04-19) 기준 코드베이스에서 "그래프 초기화" 문자열·핸들러는
검색되지 않으며(`rg "그래프 초기화|resetGraph|resetCodeGraph|clearGraph"` 빈 결과),
따라서 관찰 결과(Observed) 칸은 **공란 유지** — 기능 구현 PR 이 올라오면 본 문서
하단의 E1~E5 테이블을 채워 회귀 로그로 승격한다.

## 전제 조건

- `npm run dev` 로 프론트엔드 기동, 초기 `gameState` 수화 완료
  (`gameState.projects/.agents/.files/.dependencies` 모두 적어도 1건 이상 존재)
- 프로젝트 1개에 파일 ≥ 3건, 의존성 엣지 ≥ 2건이 이미 그래프에 그려진 상태
- 에이전트 ≥ 2명이 활성(`status !== 'idle'`)으로 표시되는 상태
- DevTools → Application → LocalStorage/SessionStorage 접근 가능
- 서버 측 `/api/emergency-stop` 엔드포인트가 200 으로 응답하는 정상 상태

## 버튼 배치 계약 (정적 검증)

| 관찰 위치                                     | 기대값                                                    |
| --------------------------------------------- | --------------------------------------------------------- |
| 사이드바 `div.mt-auto.pt-4.space-y-3` 자식 순서 | **① 에이전트 고용 → ② 그래프 초기화 → ③ 긴급중단**         |
| 그래프 초기화 버튼 class 톤                   | 에이전트 고용(청록)과 긴급중단(적색) 사이의 중립/주의 톤 |
| `title` 속성                                  | 리셋 범위·비가역성 안내 문구를 반드시 포함                 |
| `aria-label`                                  | "그래프 초기화" 텍스트와 일치 또는 이를 포함               |

정적 검증은 `src/App.tsx` 의 `에이전트 고용` ↔ `긴급중단` 버튼 사이(현재 line 1358
바로 아래, line 1360 시작 블록 직전) 에 `<button>그래프 초기화</button>` 한
노드가 삽입되는지를 diff 및 스크린샷으로 확인한다.

## 스토어 리셋 계약 (동적 검증)

`gameState` 최상위 키는 `{ projects, agents, files, dependencies }` 이며
(`src/App.tsx:148`), 그래프 초기화는 **파일·의존성 그래프만** 비워야 한다.
즉 리셋 후 최소한 다음이 성립해야 한다.

- `gameState.files.filter(f => f.projectId === selectedProjectId).length === 0`
- `(gameState.dependencies ?? []).filter(d => …projectFileIds has both).length === 0`
- `computeWorkspaceInsights(…)` 결과: `totalFiles === 0`, `isolatedFiles === []`,
  `topDependedFile === undefined`, `topDependingFile === undefined`,
  `fileTypeBreakdown === { component:0, service:0, util:0, style:0 }`,
  `cyclicFiles === []`, `coveragePercent === 0`, `avgFilesPerAgent === 0`
  (우선 검토 파일 `src/utils/workspaceInsights.ts` 의 EMPTY\_FILE\_TYPE\_BREAKDOWN
  경로가 그대로 활성화되어야 한다)
- `projects`·`agents` 배열은 **보존** — 그래프 초기화는 에이전트 명단과 프로젝트
  메타데이터에 영향을 주지 않아야 한다(G4 에서 재확인).

## 시나리오 매트릭스

| 번호 | 축                           | 사전 상태                                                                 | 트리거                                                    | 기대 결과                                                                                                                                              |
| ---- | ---------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1   | 버튼 위치 정합                | 사이드바 렌더 직후                                                        | 시각 확인 + DOM 순서 검사                                  | 자식 순서가 `에이전트 고용 → 그래프 초기화 → 긴급중단` 으로 고정, `aria-label`/`title` 부재 없음                                                       |
| G2   | 취소 안전성                   | 파일 ≥ 3, 의존성 ≥ 2 보유                                                  | 그래프 초기화 클릭 → 확인 다이얼로그에서 **취소** 선택     | 노드·엣지 개수·좌표 전부 불변, 로그 패널에 "그래프 초기화 취소" 류 메시지 또는 조용한 닫힘만 남음, `computeWorkspaceInsights` 값 불변                   |
| G3   | 확정 리셋                     | G2 와 동일 전제                                                           | 그래프 초기화 클릭 → **확인** 선택                         | 캔버스에서 파일/엣지 시각 요소 전부 제거, 현재 프로젝트의 `files`·`dependencies` 가 모두 0, 인사이트 패널이 비어 있는 초기 상태로 재렌더             |
| G4   | 후행 기능 회귀                | G3 직후 (그래프가 비어 있고 `projects`·`agents` 는 유지)                  | ① 에이전트 고용 모달로 신규 에이전트 생성 ② 긴급중단 클릭   | 두 버튼 모두 기존과 동일한 로그·서버 응답을 돌려줌 (`에이전트 고용 실패`·`긴급중단 실패` 미발생), 콘솔 에러 0건                                         |
| G5   | 빈 그래프에서의 재클릭        | G3 직후 (빈 그래프)                                                       | 그래프 초기화 버튼을 연속 2회 클릭 → 각각 **확인** 선택    | 네트워크 요청이 있더라도 4xx/5xx 없이 200/204 유지, 콘솔/로그 패널에 예외(`Cannot read properties` 등) 없음, `computeWorkspaceInsights` 가 그대로 0/빈 배열 |

## 자동 테스트 훅 제안 (구현 PR 에서 함께 추가 권장)

| 계약                                                        | 제안 위치                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| `resetGraph` 리듀서 — 해당 프로젝트 `files`·`dependencies` 만 비우고 나머지 보존 | `src/App.tsx` 리듀서 분리 후 테스트 또는 `tests/graphReset.regression.test.ts` (신규) |
| 빈 입력에서 `computeWorkspaceInsights` 결과 형태 고정        | `src/utils/workspaceInsights.ts` 에 대응하는 테스트에 "빈 프로젝트" 케이스 추가 |
| 버튼 DOM 순서                                                | `src/App.tsx` 렌더링 스냅샷 또는 `@testing-library/react` 로 `getAllByRole('button')` 순서 검사 |

## 실행 로그 — 사전 관찰 (정적)

| 번호 | 현재 코드베이스 관찰                                                                                     | 결론                      |
| ---- | -------------------------------------------------------------------------------------------------------- | ------------------------- |
| S1   | `src/App.tsx:1353~1367` 에 `에이전트 고용` ↔ `긴급중단` 만 존재. 사이 간극 없음.                         | **그래프 초기화 버튼 미구현** |
| S2   | 저장소 전체에 `그래프 초기화 / resetGraph / resetCodeGraph / clearGraph` 문자열 없음.                    | 핸들러·액션 미구현         |
| S3   | `workspaceInsights.ts` 의 EMPTY\_FILE\_TYPE\_BREAKDOWN 경로는 이미 빈 입력을 안전하게 처리한다(파일 0건). | 리셋 후 인사이트 계약 충족 가능 |

## 실행 로그 — G1~G5 관찰 (기능 병합 후 채움)

| 번호 | 실행자 | 실행일 | 관찰 | 결과(Pass/Fail) |
| ---- | ------ | ------ | ---- | --------------- |
| G1   |        |        |      |                 |
| G2   |        |        |      |                 |
| G3   |        |        |      |                 |
| G4   |        |        |      |                 |
| G5   |        |        |      |                 |

## 리스크 메모

- `emergencyStop` 은 서버 `POST /api/emergency-stop` 을 호출하고 `addLog` 로
  결과 건수를 표시한다(`src/App.tsx:1049~1053`). 그래프 초기화가 동일 엔드포인트를
  재사용하지 않도록 주의해야 한다(긴급중단은 작업 대기열 복귀, 그래프 초기화는 파일·엣지 삭제로 의미가 다름).
- `gameState.projects`·`gameState.agents` 를 실수로 비우면 G4 가 실패한다.
  스토어 셀렉터 범위를 `files`·`dependencies` 로 한정할 것.
- `dependencies` 는 `gameState.dependencies || []` 로 폴백되고 있으므로
  리셋 후에도 `undefined` 가 아닌 빈 배열을 유지해야 다운스트림 `filter` 가
  안전하다(`src/App.tsx:331,685,689`).
