---
purpose: manual-test
scope: workspace-sidebar × office-floor-tab × project-name-display
owner: 베타(개발자 겸임)
related-code:
  - src/App.tsx (워크스페이스 사이드바 — 오피스 플로어 버튼, line 1293~1299)
  - src/App.tsx (selectedProjectId 상태 · projectId 로 name 조회, line 178·675)
  - src/components/AgentStatusSnapshot.tsx (오피스 플로어 상단 스냅샷 패널 — 활성 프로젝트 신호)
  - src/components/EmptyProjectPlaceholder.tsx (미선택 상태 안내)
sibling-doc: tests/manual-git-automation-regression.md
---

# 수동 회귀 — 오피스 플로어 메뉴의 프로젝트 이름 표시

좌측 워크스페이스 사이드바의 **"오피스 플로어"** 탭 버튼이 현재 선택된 프로젝트
이름을 부제 위치에 노출한다. 이 표시는 다음 4가지 축에서 깨지기 쉬우므로 변경이
들어간 릴리스마다 본 문서의 O1~O4 시나리오를 순서대로 눈으로 확정한다. 자동
테스트(`EmptyProjectPlaceholder.test.tsx`, `AgentStatusSnapshot.test.ts`)는 본
문서의 보조 계약만을 커버하므로, 사이드바 탭 자체의 시각 회귀는 수동이 1차이다.

## 전제 조건

- `npm run dev` 로 프론트엔드 기동, 로그인 · 초기 `gameState` 수화(hydrated=true) 완료.
- `gameState.projects` 에 최소 2개의 프로젝트가 있고, 각 프로젝트에 팀원 1인 이상 편성.
- 사이드바 첫 버튼(오피스 플로어)이 `activeTab === 'game'` 기본 경로에서 활성 표시.
- `localStorage` 의 `SELECTED_PROJECT_KEY` 값을 직접 조작할 필요가 있을 수 있으므로
  DevTools → Application 탭 접근이 가능한 Chromium 계열 브라우저 사용 권장.

## 관찰 포인트

| 위치                                               | 값                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| 사이드바 "오피스 플로어" 버튼의 타이틀(첫 줄)      | 고정 문자열 **"오피스 플로어"** — 변경되지 않아야 한다              |
| 같은 버튼의 부제(두 번째 줄, `text-[10px] opacity-70`) | 선택된 프로젝트의 `project.name`. 미선택 상태에서는 **"실시간 뷰"** |
| 버튼 `aria-label` / `title` (접근성)               | "오피스 플로어 — {프로젝트 이름}" 패턴 유지(없으면 타이틀만)       |
| 탭 사이드바의 `width`                              | 기본 220px. 긴 이름이 들어와도 열 폭을 밀어내지 않아야 한다         |

## 시나리오 매트릭스

| 번호 | 축                     | 사전 상태                       | 트리거                                | 기대 결과                                                   |
| ---- | ---------------------- | ------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| O1   | 기본 선택 표시         | 프로젝트 A 를 선택한 상태       | 초기 렌더                             | 부제에 "A" 가 정확히 표시, 타이틀은 그대로 "오피스 플로어"  |
| O2   | 즉시 갱신              | O1 의 "A" 가 보이는 상태        | `ProjectManagement` 에서 프로젝트 B 워크스페이스 열기 | 1 프레임 이내에 부제가 "A" → "B" 로 교체                    |
| O3   | 미선택 플레이스홀더    | `selectedProjectId === null`    | 프로젝트 삭제 또는 선택 해제          | 부제가 기본 **"실시간 뷰"** 로 수렴, 오피스 플로어 타이틀 유지 |
| O4   | 긴 이름 레이아웃 보호  | 60자 이상의 프로젝트 이름 존재 | 해당 프로젝트 선택                    | 부제는 CSS truncate(말줄임) 적용, 사이드바 220px 유지       |

---

## O1 — 기본 선택 상태에서 프로젝트 이름 표시

- 선행: `gameState.projects` 에 `{id:'p1', name:'Atlas'}` 존재. 브라우저 `localStorage`
  의 `SELECTED_PROJECT_KEY = 'p1'` 상태에서 앱 재수화.
- 절차:
  1. 사이드바 첫 번째 버튼을 확인.
  2. 타이틀 DOM (`text-sm font-bold block`) 이 "오피스 플로어" 인지 확인.
  3. 부제 DOM (`text-[10px] opacity-70`) 이 "Atlas" 인지 확인.
- 기대:
  - 부제가 정확히 `project.name` 문자열. 앞뒤 공백 제거(`trim()`) 후 비교했을 때 일치.
  - 타이틀은 고정 "오피스 플로어". 부제가 타이틀 자리를 침범하지 않아야 한다.
  - `activeTab === 'game'` 이면 `border-[var(--pixel-accent)]` 강조 테두리가 살아 있어야 함.
- 실패 시 확인:
  - (a) `selectedProjectId` 가 실제로 `'p1'` 인지 React DevTools 로 확인.
  - (b) `gameState.projects.find(p => p.id === selectedProjectId)` 반환이 `undefined` 가
    아닌지(프로젝트가 이미 삭제됐는데 `SELECTED_PROJECT_KEY` 만 남은 고아 상태 의심).
  - (c) 서버 `/api/state` 응답이 해당 프로젝트를 포함하는지 네트워크 탭에서 교차 확인.

## O2 — 프로젝트 전환 시 즉시 갱신

- 선행: O1 상태에서 부제 "Atlas" 가 보이고 있음. `gameState.projects` 에 `{id:'p2', name:'Borealis'}` 도 존재.
- 절차:
  1. 사이드바의 **프로젝트** 탭으로 이동 (`activeTab = 'projects'`).
  2. 프로젝트 B("Borealis") 카드의 "워크스페이스 열기" 버튼 클릭
     (App.tsx 의 `aria-label="… 워크스페이스 열기"` 패턴, 기본 동작은
     `setSelectedProjectId(project.id)` + `setActiveTab('game')`).
  3. 오피스 플로어 탭으로 자동 복귀된 직후 첫 번째 버튼 부제를 확인.
- 기대:
  - 1 프레임(≤ 16ms) 이내에 부제가 "Borealis" 로 교체. "Atlas" 가 잠시라도 남아 있으면 회귀.
  - `localStorage.SELECTED_PROJECT_KEY` 도 동기 재기록됨("p1" → "p2").
  - 브라우저 addLog 이벤트 패널에 `워크스페이스 전환: Borealis` 1줄 추가.
- 실패 시 확인:
  - (a) `setSelectedProjectId` 가 React 배치 렌더에 묶여 사이드바만 늦게 다시 렌더되는
    경우 — 사이드바가 `selectedProjectId` 를 closure 로 읽는지, prop 으로 받는지 확인.
  - (b) `gameState.projects.find(...)` 가 동일 id 에 대해 다른 객체를 반환하지 않는지
    (렌더 키 안정성). 이름 지연은 주로 `useEffect` 보다 앞선 `useMemo` 캐시 미갱신.
  - (c) 전환 중 짧게 "실시간 뷰" 로 falling-back 되면 `selectedProjectId` 가 잠시
    `null` 로 찍히는 것 — 연속된 두 setState 사이의 동기화 누락.

## O3 — 프로젝트 미선택 상태 플레이스홀더

- 선행: 모든 프로젝트를 닫거나, 유일 프로젝트를 삭제해 `selectedProjectId === null`
  상태를 재현. App.tsx 의 삭제 흐름에서는 `if (selectedProjectId === projectId) setSelectedProjectId(null)` 경로로 도달한다.
- 절차:
  1. 프로젝트 관리 탭에서 선택 중이던 프로젝트를 삭제.
  2. 자동으로 오피스 플로어 탭으로 돌아온 직후 버튼 부제를 확인.
  3. `localStorage` 의 `SELECTED_PROJECT_KEY` 키가 제거됐는지도 교차 확인.
- 기대:
  - 부제가 기본 문자열 **"실시간 뷰"** 로 원복.
  - 오피스 플로어 메인 영역에는 `EmptyProjectPlaceholder` 가 렌더되고,
    `EmptyProjectPlaceholder.test.tsx` 의 "미선택 상태에서 빈 안내 카피가 나온다" 기대와 일치.
  - `aria-label` / `title` 이 프로젝트 이름을 포함하지 않아야 한다
    (예전 값을 stale 캐시에서 끌어오면 회귀).
- 실패 시 확인:
  - (a) `project?.name` 이 `undefined` 일 때 빈 문자열("")을 렌더해 버튼 부제가
    시각적으로 비는 경우 — 반드시 기본 "실시간 뷰" 폴백이 있어야 한다.
  - (b) 삭제 직후 1 tick 동안 옛 이름이 남아 있으면 `gameState.projects` 배열이
    서버 브로드캐스트와 비동기인 상태. `/api/state` 응답을 먼저 반영한 뒤 로컬
    `selectedProjectId` 를 변경해야 한다.
  - (c) `SELECTED_PROJECT_KEY` 에 삭제된 id 가 남아 있으면 다음 방문 시 "유령"
    상태로 O1 테스트가 깨진다.

## O4 — 긴 프로젝트 이름의 레이아웃 보호

- 선행: 테스트용 프로젝트 생성 모달에서 아래 두 가지 경계 이름을 등록.
  - `L1`: 한글 40자 "초장문프로젝트이름한글사십자테스트시나리오회귀검증오피스플로어사이드바"
  - `L2`: 공백 없는 영문 80자 "AVeryLongProjectNameThatShouldOverflowTheSidebarButMustBeTruncatedGracefullyHere"
- 절차:
  1. L1, L2 순으로 선택해 각각 사이드바 부제를 관찰.
  2. 브라우저 개발자 도구에서 `aside` 엘리먼트의 실측 폭(`getBoundingClientRect().width`)을 기록.
  3. 부제 엘리먼트의 `overflow` / `text-overflow` 속성 계산값 확인.
- 기대:
  - 사이드바 폭이 **220px** 에서 변하지 않아야 한다(±1px 수용, 스크롤바 변동 제외).
  - 부제 텍스트는 말줄임(`truncate` / `overflow:hidden` + `text-overflow:ellipsis`)으로
    표시. 넘치는 문자가 다음 줄로 내려오거나 가로 스크롤을 유발하면 회귀.
  - 버튼의 `title` 속성에는 전체 이름이 그대로 들어가, 마우스 호버 시 확인 가능.
  - 풀 이름이 필요한 상황(스크린리더)에서는 `aria-label` 로 L1/L2 전체 문자열이 읽힌다.
- 실패 시 확인:
  - (a) `w-[220px]` 가 콘텐츠에 의해 밀리면 `flex` 컨테이너의 `min-width: 0` 누락.
     부제 `<span>` 에 `truncate` 클래스를 복구해 해결.
  - (b) 말줄임 미적용으로 두 번째 줄이 타이틀을 밀어내면 타이포 스케일 변경 회귀
     (`text-sm` vs `text-[10px]` 역전).
  - (c) 이모지 · 조합형 한글에서 말줄임이 문자 중간을 자르면 `word-break: keep-all`
     을 병행해 조합이 깨지지 않는지 확인.

---

## 교차 확인 — 스냅샷/빈 상태 패널과의 일관성

| 관측 축                              | 기대                                                             |
| ------------------------------------ | ---------------------------------------------------------------- |
| `AgentStatusSnapshot` 상단 헤더      | 사이드바 부제와 같은 프로젝트 이름을 기준으로 지표 집계          |
| `EmptyProjectPlaceholder` 렌더 조건   | O3 상태(= 사이드바 부제 "실시간 뷰")에서만 노출                 |
| 태스크 대기열 / 파일 그래프          | 사이드바 부제에 표시된 프로젝트의 파일/태스크만 노출             |

세 축이 동시에 "같은 프로젝트" 를 가리키지 않으면 `selectedProjectId` 전파 경로에
드리프트가 발생한 것 — 위 O1~O4 중 가장 먼저 깨진 번호부터 원인 분기를 재추적.

## 회귀 시그널 표 (R1~R6)

| 코드 | 회귀 신호                                                                 | 재현 시 확인할 소스                                                |
| ---- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| R1   | 부제가 항상 "실시간 뷰" 로만 표시됨(프로젝트 이름 미반영)                 | 사이드바 `<span>` 이 정적 문자열로 고정된 것(line 1298 회귀)       |
| R2   | 프로젝트 삭제 후에도 이전 이름이 사이드바에 남음                          | `selectedProjectId` 가 삭제 분기에서 `null` 로 떨어지지 않는 경로  |
| R3   | 전환 직후 짧게 이전 이름이 깜빡임                                         | 렌더 배치 이슈 — 사이드바가 stale closure 로 `project` 참조        |
| R4   | 긴 이름에서 사이드바 폭이 확장되어 본문이 좁아짐                          | `truncate` / `min-width:0` 누락, O4 실패와 동일 원인                |
| R5   | `aria-label` 이 프로젝트 이름을 포함하지 않아 스크린리더가 구분 불가      | 접근성 라벨 합성 누락                                              |
| R6   | `SELECTED_PROJECT_KEY` 가 삭제된 id 를 그대로 유지해 재방문 시 부제가 빈 값 | 삭제 경로에서 `localStorage.removeItem` 미호출                     |

## 복구/리셋 절차

- `selectedProjectId` 리셋: DevTools Console 에서 `window.localStorage.removeItem('SELECTED_PROJECT_KEY')` 실행 후 새로고침.
- 테스트 프로젝트 정리: 프로젝트 관리 탭에서 L1/L2 삭제. 또는 서버 DB 에서 `projects` 컬렉션의 `name IN ('초장문…','AVeryLong…')` 도큐먼트 제거.
- 상태 드리프트 의심 시 서버 재기동 후 `/api/state` 응답의 `projects[]` 와 프론트
  `gameState.projects` 가 동일 길이인지 확인.
