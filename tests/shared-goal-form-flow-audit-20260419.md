---
purpose: e2e-flow-audit
scope: 공동 목표 입력 폼 × 안내 모달 × 자동 개발 토글 × 데이터 계층
executor: 개발자 에이전트 (dfce6d78-c2c8-4263-b189-6dfe1a3a1f23)
executed-at: 2026-04-19
trigger-directive: 지시 #2ce6a013 (완료 보고 대상: 리더 Kai)
related-code:
  - src/App.tsx (line 178~182, 1922~1987, 2118~2146 · 토글 가드 + 안내 모달)
  - src/components/ProjectManagement.tsx (공동 목표 폼 부재 확인)
  - src/components/GitAutomationPanel.tsx (헤더 확장 폼 부재 확인)
  - server.ts (line 974~1018 · GET/POST /api/projects/:id/shared-goal)
  - src/server/taskRunner.ts (line 107~113, 255~280, 289~304 · setAutoDev·autoDevTick 가드)
  - src/server/prompts.ts (line 115~126 · 리더 블록 주입)
  - src/utils/useProjectOptions.ts (sharedGoalId 만 다룸 · goal 본문은 미캐시)
  - src/index.css (line 79~91, 3997~4108 · --shared-goal-* 디자인 토큰)
  - tests/shared-goal-form-mockup.md (UI 시안 · 미구현)
  - tests/shared-goal-modal-mockup.md (자동 개발 ON 트리거 모달 시안 · 미구현)
  - tests/auto-dev-toggle-shared-goal-modal-regression-20260419.md (C1~C4 계약)
  - tests/sharedGoal.regression.test.ts (S1~S4 서버 가드)
---

# 공동 목표 입력 폼 노출 흐름 감사 (2026-04-19)

## 0. 점검 범위

지시 #2ce6a013 의 요청에 따라 공동 목표 폼 노출 흐름을 엔드투엔드로 점검한다.
경로: `메인 툴바 자동 개발 토글` → `SharedGoal 안내 모달` → `프로젝트 관리 탭` →
`공동 목표 입력 폼` → `서버 `POST /api/projects/:id/shared-goal`` → `리더 프롬프트 블록`.

중점 질문: **폼이 숨겨지는 원인이 데이터 계층에도 있는가?**

## 1. 흐름도 (현 상태)

```
[메인 툴바 · 자동 개발 OFF→ON 클릭]            App.tsx:1926
            │
            ▼
[GET /api/projects/:id/shared-goal] ─ 선택 프로젝트 있을 때  App.tsx:1935, server.ts:974
            │
      goal === null ?
     ┌──────┴──────┐
     │             │
   (empty)       (saved)
     │             │
     ▼             ▼
[SharedGoal 안내 모달]      [PATCH /api/auto-dev { enabled:true }]
 App.tsx:2118~2146           서버 setAutoDev 2중 가드 통과(taskRunner.ts:255~280)
     │
     ▼
[ "공동 목표 입력으로 이동" 버튼 → setActiveTab('project-management') ]
     │
     ▼
[ProjectManagement.tsx 렌더]
     │
     ▼
❌ **공동 목표 입력 폼이 렌더되지 않음** (SharedGoalForm.tsx 미구현)
     │
     ▼
[ 사용자는 GitAutomationPanel 헤더만 보고 길을 잃음 ]
```

## 2. 계층별 점검 결과

### 2.1 서버(데이터 계층) — ✅ 정상

| 항목 | 위치 | 판정 |
| ---- | ---- | ---- |
| `GET /api/projects/:id/shared-goal` — 활성 1건 조회, 없으면 `null` 반환 | server.ts:974~983 | ✅ `null` 이 "empty" 의 명시적 신호로 충실 |
| `POST /api/projects/:id/shared-goal` — 입력 검증·기존 active → archived 전이 | server.ts:985~1018 | ✅ "활성 1건" 불변식 유지 |
| `TaskRunner.getActiveSharedGoal` — status='active' 만 반환 | taskRunner.ts:107~113 | ✅ `{ projection: { _id: 0 }, sort: { createdAt: -1 } }` 으로 최신 1건 |
| `setAutoDev` 가드 — enabled+projectId 조합에서 목표 없음 → `SHARED_GOAL_REQUIRED` | taskRunner.ts:255~280 | ✅ 서버 API 레벨에서도 ON 을 거부 |
| `autoDevTick` 가드 — 활성 목표 없는 프로젝트 스킵 | taskRunner.ts:289~304 | ✅ "목표 없이 맥락 없는 분배" 방지 |
| 리더 프롬프트 — `renderSharedGoalBlock` 으로 제목·설명·우선순위·마감 주입 | prompts.ts:115~126 | ✅ 저장된 goal 이 즉시 리더 분배에 반영 |
| `updateProjectOptionsSchema.sharedGoalId` — null 은 $unset, 빈 문자열은 거부 | projectOptions.ts·projectOptions.test.ts | ✅ `sharedGoalId` 와 `sharedGoal` 본문의 저장 경로는 분리 |

결론: **데이터 계층에는 폼이 숨겨지는 원인이 존재하지 않는다.** 서버 응답, null
시맨틱, 저장/로드 계약 전부가 "empty=null, saved=객체" 라는 2상(bi-state) 규약을
정확히 지키며, `tests/sharedGoal.regression.test.ts` (S1~S4) 가 이 계약을 잠근다.

### 2.2 클라이언트 상태 계층 — ⚠️ 본문 캐시 부재(의도된 설계)

| 항목 | 위치 | 판정 |
| ---- | ---- | ---- |
| `useProjectOptions` — `sharedGoalId` 는 다루지만 `SharedGoal` 본문은 다루지 않음 | useProjectOptions.ts:20~47 | ⚠️ 의도된 범위 분리 |
| 앱 전역에 sharedGoal 본문을 캐시하는 zustand/redux 스토어 없음 (프로젝트 전체에 zustand/redux 미도입) | — | ⚠️ 정책적 결정 |
| 토글 클릭 시점에 즉석 `fetch` | App.tsx:1935 | ✅ "DB 가 단일 진실 소스 + 낙관 갱신 금지" 원칙과 일치 |

`project-settings-save-load-regression-20260419.md` 가 잠근 원칙:
"DB 가 단일 진실 소스, 낙관적 갱신 금지, 새로고침 시 플리커 금지" — 이를 존중해
`sharedGoal` 본문을 전역 스토어에 캐시하지 않은 것은 **의도된 설계**다. 폼 내부에서만
한시적으로 `useState` 또는 전용 훅(예: `useSharedGoal(projectId)`) 으로 들고 있으면
충분하며, 이는 폼이 숨겨지는 원인과 무관하다.

### 2.3 UI 층 — ❌ **폼 미구현이 유일 원인**

| 컴포넌트 | 기대 위치(시안) | 현 상태 |
| -------- | ---------------- | -------- |
| `SharedGoalForm.tsx` | `GitAutomationPanel` 헤더 좌측 확장 영역 | ❌ 파일 자체 부재 |
| `SharedGoalModal.tsx` | 자동 개발 OFF→ON 원자 트리거 | ❌ 파일 자체 부재, 현재는 `Modal` 재사용한 "안내" 모달(App.tsx:2118~2146)이 임시로 자리 차지 |
| `ProjectManagement.tsx` 렌더 대상 | `GitAutomationPanel` + 시안상 `SharedGoalForm` | ❌ 후자 누락 |

**안내 모달(App.tsx:2118~2146) 은 "프로젝트 관리" 탭의 공동 목표 입력 폼에서...**
라고 지시하지만, 해당 폼이 존재하지 않아 사용자가 막다른 길에 빠진다. 시각적으로
"폼이 숨겨진 것처럼" 보이지만, 정확한 표현은 **"폼이 아직 존재하지 않는다"** 이다.

## 3. 빈 상태(Empty State) 처리 로직 점검

### 3.1 서버 빈 상태 응답

- `GET /api/projects/:id/shared-goal` → `res.json(goal || null)` (server.ts:982)
  - `goal` 이 falsy 인 경우(= 활성 레코드 없음) 반드시 `null` 반환.
  - 204 No Content 가 아닌 200 + `null` 을 쓰는 이유: 클라이언트가 `await res.json()`
    만으로 분기할 수 있어 분기문이 단순해지며, fetch 에러와 "목표 없음" 을 혼동하지
    않게 된다.

### 3.2 클라이언트 빈 상태 가드

- App.tsx:1937: `if (!goal) { setSharedGoalPromptOpen(true); return; }` — 정상.
- App.tsx:1964: 서버 `setAutoDev` 가 `SHARED_GOAL_REQUIRED` 400 을 돌려줄 때도 동일
  경로로 모달을 띄운다. **2중 가드(pre-check + 서버 응답)** 가 의도대로 동작.
- 하이드레이션 경로에서는 토글 OnClick 이 트리거되지 않으므로 C4/C4'/C4''
  (autoDevToggleSharedGoalModal.regression.test.ts) 가 잠그는 "하이드레이션 중 모달
  금지" 불변식도 위반 없음.

### 3.3 미구현 폼의 가상 빈 상태

시안(`shared-goal-form-mockup.md` §3) 의 4상 상태 머신(`empty` → `editing` → `saved`
→ `running`) 은 **폼이 구현되면** 아래 방식으로 서버 응답에 매핑된다:

| 서버 응답(GET) | 폼 상태 | 렌더 |
| --------------- | -------- | ---- |
| `null` | `empty` | `--shared-goal-border-empty` · "공동 목표를 먼저 입력해주세요" |
| `{ ...saved }` 동일값 | `saved` | `--shared-goal-border-saved` · 배지 `✓ 저장됨` |
| `{ ...saved }` + 편집 중 | `editing` | `--shared-goal-border-editing` · `⚠ 미저장` |
| `autoDevEnabled=true` AND `saved` | `running` | `--shared-goal-border-running` · 진행 링 |

즉, 빈 상태(Empty) 의 입력원은 **GET 응답의 `null`** 하나뿐이며 서버·클라 양쪽에서
이미 일관되게 처리된다. 폼 구현 시 이 매핑을 그대로 연결하면 데이터 계층 변경 없이
동작할 것이다.

## 4. 결론 — "데이터 계층에 원인 없음"

점검 전 가설(데이터 계층이 숨김 원인 중 하나일 수 있다)은 **기각** 한다.

- 서버 API, null 시맨틱, `SHARED_GOAL_REQUIRED` 2중 가드, `useProjectOptions` 의
  scope 분리, `setAutoDev`/`autoDevTick` 의 활성 목표 전제 — 모두 **기대대로 동작**한다.
- 유일한 원인: **`SharedGoalForm.tsx` 미구현** (UI 층). 후속 과제로 이관 필요.

이 감사 결과에 따라 **본 턴에서 데이터 계층 코드 수정은 수행하지 않는다**(수정
대상이 없으므로). 후속 액션은 아래 §5 의 인계 항목으로 넘긴다.

## 5. 후속 인계

1. **SharedGoalForm.tsx 구현** (최우선) — 시안 `tests/shared-goal-form-mockup.md` §2~10
   을 따르며, GitAutomationPanel 헤더 좌측 확장 영역에 배치. 데이터 훅은 신규
   `useSharedGoal(projectId)` 를 만들어 `GET/POST /api/projects/:id/shared-goal` 를
   감쌀 것(전역 스토어 불필요).
2. **SharedGoalModal.tsx 구현** — 시안 `tests/shared-goal-modal-mockup.md` 따라 자동
   개발 OFF→ON 원자 트리거. 현 App.tsx:2118~2146 의 "안내" 모달은 교체 대상.
3. **App.tsx 토글 핸들러 리팩터**: 시뮬레이터 `evaluateAutoDevToggle` 을
   `tests/autoDevToggleSharedGoalModal.regression.test.ts` 에서 export → 실 핸들러가
   직접 호출하도록 치환. C1~C4 계약이 즉시 실회귀 가드로 승격.
4. **안내 카피 교정**: 폼 구현 전까지 임시로 "자동 개발은 활성 공동 목표가 없어
   시작할 수 없습니다. 구현 예정인 공동 목표 입력 폼이 도입되면 이곳에서 바로
   입력할 수 있습니다." 로 문구를 정직하게 바꾸는 옵션도 있으나, 구현 PR 과 함께
   동시 교체가 더 깔끔하다.

## 6. 검증 한 줄

> 데이터 계층은 정상 · 폼이 보이지 않는 진짜 원인은 UI 컴포넌트 미구현.
