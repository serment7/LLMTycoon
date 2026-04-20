---
date: 2026-04-21
owner: Designer (LLMTycoon)
trigger-directive: "지시 #59497f18 — 4축 통합 온보딩 투어 + 교차 상태 감사 + 접근성 체크리스트"
prior-context:
  - src/components/OnboardingTour.tsx (기존 3스텝 투어 · DEFAULT_ONBOARDING_STEPS · nextOnboardingStep 순수 함수)
  - src/components/EmptyState.tsx (empty / loading 공통 템플릿 · --empty-state-* 토큰)
  - src/components/ErrorState.tsx (에러 상태 공통 템플릿 · --error-state-* 토큰)
  - src/hooks/useOnlineStatus.ts (온라인/오프라인 감지 훅)
  - src/ui/NewProjectWizard.tsx (에이전트 팀 추천 위저드 현행 구현)
  - src/components/ProjectMcpServersPanel.tsx (MCP 패널 · 아직 stdio 단일 전송)
  - src/components/TokenUsageIndicator.tsx (세션 잔량 상단 배지)
  - src/i18n/index.ts (translate/폴백 3단 · useLocale)
  - locales/{en,ko}.json (Joker 완료 · onboarding 키 공간은 비어 있음)
  - src/services/settings/codeConventionStore.ts (우선 검토 파일 — 설정 저장 스코프 분리 선례)
  - docs/design/mcp-transport-and-language-toggle-2026-04-20.md (언어 토글 1차 진입 · 토스트 규약)
  - docs/design/project-creation-agent-recommendation-2026-04-20.md (팀 추천 모달 3단계 정보 구조)
  - docs/design/token-savings-visualization-2026-04-21.md (3색 바 · 상세 패널 · 타이포)
report-to: Kai (7efcca3d-9d2e-4c46-9df0-c6b01352048c)
scope:
  - "4단계 첫 실행 온보딩 투어(언어 → MCP 전송 → 에이전트 추천 미리보기 → 토큰 인디케이터) 와이어프레임·카피·건너뛰기/다시 보기 흐름"
  - "4기능 × 4상태(loading · empty · offline · permissionDenied) 감사 매트릭스와 보정안(Figma 1페이지 등가)"
  - "접근성 체크리스트(키보드 탐색·SR 라벨·대비 AA) 네 기능 통합 표 + 수정 제안"
  - "locales/{en,ko}.json 이관용 onboarding.* · states.* 키 후보 전량"
---

# 4축 온보딩 투어 + 교차 상태 감사 + 접근성 체크리스트 (2026-04-21)

선행 세 시안 — **언어 토글**, **MCP 전송 선택**, **에이전트 팀 추천**, **토큰 절약 가시화** — 을 사용자가 "하나의 첫 실행 흐름" 으로 이해하도록 네 단계 투어로 엮는다. 동시에 네 기능이 같은 네 가지 상태(**로딩 / 빈 / 오프라인 / 권한 없음**) 를 겪을 때 **톤과 레이아웃이 어긋나지 않도록** 매트릭스로 점검하고, 접근성 체크리스트로 **같은 잣대** 를 통과하는지 잠근다.

본 시안은 `src/components/OnboardingTour.tsx` 의 3스텝 골격을 **4스텝으로 확장** 하는 것이 아니라, **별도의 "첫 실행 워크스루"** 로 설계한다. 기존 투어는 상단바·업로드·내보내기 축(이미 사용해 본 사용자 대상) 이고, 본 시안은 **최초 접속 시 한 번** 기능 4축 자체를 안내하는 상위 레이어다. 둘은 공존 — 본 시안이 끝난 뒤 기존 투어로 자연스럽게 내려간다(§1.5).

> 우선 검토 파일 `src/services/settings/codeConventionStore.ts` 의 "전역 + 로컬 스코프" 저장 패턴(L8–L13) 은 본 시안의 온보딩 완료 플래그 · 상태 감사 저장소 축이 **전역 사용자 단위** 로 고정된다는 결정의 근거다. 프로젝트별 분기는 본 시안 범위 밖.

---

## 0. 설계 원칙 (O-01 ~ O-14)

### 0.1 온보딩 투어(O-01 ~ O-08)

| ID   | 원칙 |
| ---- | ---- |
| O-01 | **4단계 1회 · 건너뛰기 언제든 · 다시 보기 설정 메뉴**: 흐름을 흔들지 않는 1회성. 설정 드로어의 `[온보딩 투어 다시 보기]` 버튼으로 언제든 재시작. |
| O-02 | **한 단계 = 한 결정**: 스텝당 사용자가 내릴 결정은 1개 이하 — 언어 선택, 전송 방식 "예시" 확인(결정 없음), 에이전트 팀 추천 미리보기(결정 없음), 인디케이터 인지(결정 없음). 실제 저장은 **언어 1개** 만. 나머지는 "여기 있어요" 식 안내. |
| O-03 | **문구 ≤ 60자**: 지시문 기준. 긴 설명은 스텝 내 `[자세히 보기]` 링크 또는 툴팁. 로딩 중 사용자가 한 번에 읽을 수 있는 양에 맞춤. |
| O-04 | **건너뛰기와 닫기는 구분**: `[건너뛰기]`(Esc) 는 "이번엔 안 볼래요", `[완료]`(Enter) 는 "다 봤어요" — 두 결과 모두 플래그 저장되지만 **건너뛰기는 다시 보기 버튼이 강조색으로 노출**(사용자가 놓친 것을 느끼도록). |
| O-05 | **언어 스텝은 첫 화면**: 이후 스텝이 읽히려면 언어가 맞아야 한다. 언어 스텝에서 바꾸면 **같은 투어 화면의 모든 라벨이 즉시 리렌더**. 투어가 닫혔다 다시 열리는 깜빡임 금지. |
| O-06 | **MCP 전송 스텝은 "설명 카드만"**: 실제 서버 추가는 프로젝트 관리 메뉴에서. 여기서는 stdio/http/streamable-http 차이를 60자 이내 카드 3장으로. 선택 강제 금지 — 아직 사용할 서버도 정해지지 않은 시점. |
| O-07 | **에이전트 추천 스텝은 "미리보기"**: 설명 입력 예시가 프리필된 상태로 추천 카드 2–3장을 보여 주고, "실제로는 설명을 쓰면 됩니다" 문구. 투어 완료 후 `NewProjectWizard` 로 자연 진입. |
| O-08 | **토큰 인디케이터 스텝 = 앵커링만**: 3색 바와 💰 배지 위치를 spotlight 로 가리키고, "캐시 적중이 있으면 💰 가 켜져요" 한 줄. 상세 패널 링크 제공. |

### 0.2 교차 상태 감사(O-09 ~ O-12)

| ID   | 원칙 |
| ---- | ---- |
| O-09 | **4상태는 동일 컴포넌트로**: `loading` · `empty` 는 `EmptyState` (variant), `error` 류(오프라인·권한없음) 는 `ErrorState`. 기능별 커스텀 배너 금지 — 이미 `docs/ux-cleanup-visual-2026-04-19.md` §5 가 확정한 규약. |
| O-10 | **오프라인은 에러가 아닌 "상태"**: 사용자의 잘못이 아님. `ErrorState` 를 재사용하되 스트립 색을 `--color-warning` (amber) 로 분기. 한글 "오프라인" · 영어 "Offline" 라벨 고정. |
| O-11 | **권한 없음은 "요청 경로" 를 제시**: "이 기능을 쓰려면 X 권한이 필요해요 · [설정으로 가기]". 부정 단독 금지 — 항상 다음 행동 1개를 링크로 제공. |
| O-12 | **네 상태의 수직 공간은 같은 min-height**: `var(--empty-state-min-height)` = 160px. 기능마다 높이가 다르면 탭 전환 시 스크롤 점프가 생겨 혼란. |

### 0.3 접근성(O-13 ~ O-14)

| ID   | 원칙 |
| ---- | ---- |
| O-13 | **키보드 완결 + SR 라벨 + 대비 AA** 를 네 기능 모두에서 같은 잣대로 점검. 한 기능이 무너지면 다른 기능의 좋은 구현이 사용자 경험에서는 "일관성 부재" 로 인지된다. |
| O-14 | **색 단독 단서 금지**(WCAG 1.4.1): 심각도·상태 차이는 색 + 아이콘 + 텍스트 · 색 + 모양 · 색 + 밑줄 셋 중 최소 2중. 기존 토큰(§9) 이 이미 이 원칙을 지키지만, 네 기능 교차 지점에서 깨지기 쉬움(§6 체크리스트에서 구체 포인트 지적). |

---

## 1. 4단계 온보딩 투어 — 화면 · 흐름

### 1.1 투어 전체 구조

```
 최초 접속 시 자동 시작
   │
   ├─ 스텝 1 · 🌐 언어 선택          ───► 결정: locale 저장
   ├─ 스텝 2 · 🔌 MCP 전송 안내      ───► 안내만
   ├─ 스텝 3 · 👥 에이전트 추천 미리  ───► 안내만(입력 상자 프리필)
   └─ 스텝 4 · 🔋 토큰 인디케이터    ───► 앵커링 + 상세 패널 링크
        │
        └─ 완료 플래그 저장 → 기존 OnboardingTour 3스텝 자동 전개(§1.5)
```

- 저장 키: `llmtycoon.firstRunTour.completed` (boolean). 기존 `llmtycoon.onboarding.completed` 와 **별도** — 두 투어가 독립적으로 재시작될 수 있도록.
- "건너뛰기" 선택 시: 플래그 저장하되 **설정 드로어의 [투어 다시 보기] 버튼이 3초간 accent 링 펄스**(§1.6).
- 스텝 이동: Enter/→ 다음, ← 이전, Esc 건너뛰기(기존 `nextOnboardingStep` 순수 함수 재사용).

### 1.2 스텝 1 · 언어 선택

```
┌ FirstRunTour · 1/4 ─────────────────────────────────────┐
│                                                          │
│   🌐   언어 선택                                          │
│                                                          │
│   어떤 언어로 진행할까요?                                  │
│   나중에 설정에서 언제든 바꿀 수 있어요.                    │
│                                                          │
│   ┌─────────────────┬─────────────────┐                   │
│   │  ✓ 한국어        │    English      │                   │
│   └─────────────────┴─────────────────┘                   │
│                                                          │
│   ●○○○                                                   │
│   [건너뛰기]                            [다음 →]           │
└──────────────────────────────────────────────────────────┘
```

- 스텝 헤더 공통: 좌측 이모지 아이콘 · 스텝 번호 · 진행 점(●○○○).
- 언어 탭은 `setLocale` 을 즉시 호출. 현재 스텝 포함 모든 라벨이 다음 프레임에 리렌더(O-05). 이전 시안 `mcp-transport-and-language-toggle-2026-04-20.md` §6 의 토스트·`<html lang>` 동기화도 그대로 발동.
- 설정 위치 힌트(문구 "나중에 설정에서…") 는 설정 드로어의 언어 섹션과 **같은 위치** 를 말함.

### 1.3 스텝 2 · MCP 전송 방식 안내(60자 이내 카드 3장)

```
┌ FirstRunTour · 2/4 ─────────────────────────────────────┐
│                                                          │
│   🔌   MCP 전송 방식                                       │
│                                                          │
│   프로젝트 관리 메뉴에서 서버를 추가할 때 세 가지 중 골라요. │
│                                                          │
│   ┌────────────┐ ┌────────────┐ ┌──────────────────┐    │
│   │  stdio      │ │  http       │ │ streamable-http   │    │
│   │ 자식 프로세스 │ │ REST API    │ │ SSE 스트림        │    │
│   │ 로 바로 실행  │ │ 엔드포인트 호출│ │ 지속 연결 · 긴 응답│    │
│   │ (로컬 도구)   │ │ (외부 서버)   │ │ (대화형 공급자)    │    │
│   └────────────┘ └────────────┘ └──────────────────┘    │
│                                                          │
│   ○●○○                                                   │
│   [← 이전]  [건너뛰기]                     [다음 →]        │
└──────────────────────────────────────────────────────────┘
```

- 각 카드 설명 ≤ 60자(O-03). 카드 라운드 `--radius-md`, 간격 `--space-md`.
- 선택 동작 없음 — 카드는 `role="group"` + `aria-label` 만. 투어 중 "결정 부담" 금지(O-06).
- 카드 hover 시 선행 시안(`mcp-transport-and-language-toggle-2026-04-20.md` §1) 의 상세 와이어프레임으로 가는 링크 툴팁.

### 1.4 스텝 3 · 에이전트 추천 미리보기

```
┌ FirstRunTour · 3/4 ─────────────────────────────────────┐
│                                                          │
│   👥   에이전트 팀 추천                                    │
│                                                          │
│   프로젝트 설명만 적으면 팀이 자동으로 추천돼요.            │
│                                                          │
│   ┌─ 프리필 예시(편집 불가) ────────────────────────┐     │
│   │ 사내 일정 공유 웹앱 · 접근성 감사                │     │
│   └─────────────────────────────────────────────────┘     │
│                                                          │
│   추천 팀 3명                                             │
│   ┌───────┐ ┌───────┐ ┌───────┐                           │
│   │👑 리더 │ │🛠 개발 │ │♿ 디자이너│                         │
│   │ 기본 팀 │ │"웹앱"  │ │"접근성"  │                         │
│   └───────┘ └───────┘ └───────┘                           │
│                                                          │
│   💡 실제로는 설명을 직접 쓰면 됩니다.                     │
│                                                          │
│   ○○●○                                                   │
│   [← 이전]  [건너뛰기]                     [다음 →]        │
└──────────────────────────────────────────────────────────┘
```

- 예시 입력 상자는 `disabled` + `aria-readonly`. 추천 카드는 **정적 스냅샷** — 실제 룰 엔진 호출 없음.
- "다음" 을 누르면 스텝 4 로. 투어 종료 후 `NewProjectWizard` 로 이어져 입력하라는 포인터(§1.5).

### 1.5 스텝 4 · 토큰 인디케이터 + 투어 종료

```
┌ FirstRunTour · 4/4 ─────────────────────────────────────┐
│                                                          │
│   🔋   토큰 사용량                                         │
│                                                          │
│    상단바의 3색 바가 이번 세션 사용량을 보여줘요.           │
│                                                          │
│    [▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ 31% · 💰 절약 중]   ←spotlight    │
│                                                          │
│    · 입력 / 출력 / 캐시 적중 3색                           │
│    · 💰 는 캐시로 토큰을 아끼고 있다는 뜻                   │
│                                                          │
│    [토큰 사용 상세 보기 →]  (설정 패널 열기)               │
│                                                          │
│   ○○○●                                                   │
│   [← 이전]  [건너뛰기]                     [완료 ✓]        │
└──────────────────────────────────────────────────────────┘
```

- spotlight 로 실제 배지 위치 강조(기존 `data-tour-anchor` 메커니즘 재사용, `OnboardingTour.tsx:8–10` 주석).
- `[완료 ✓]` → 플래그 저장 → 기존 `llmtycoon.onboarding.completed` 가 false 면 기존 3스텝 투어 자동 시작. 둘 다 true 이면 투어 종료.
- 앵커를 찾지 못하면(뷰포트 작음 등) 중앙 폴백 + "상단에서 확인하세요" 대체 문구.

### 1.6 "다시 보기" 진입점 · 강조 조건

| 조건                                                 | `[투어 다시 보기]` 시각        |
| ---------------------------------------------------- | ------------------------------ |
| 정상 완료(`완료 ✓`)                                   | 일반 링크 톤 · `--color-text-muted` |
| 건너뛰기 종료                                         | **3초 accent 링 펄스** 후 평상 복귀(O-04) |
| 사용자가 직접 리셋                                     | 평상. 투어 즉시 재시작.         |

- 다시 보기 버튼은 **SettingsDrawer 의 "온보딩 투어" 섹션** 에 배치. 새 섹션 1줄. 토큰 절약 시안(`token-savings-visualization-2026-04-21.md`) 이 이미 탭 2개(임계·상세) 로 드로어를 확장하므로, 본 섹션은 탭 위가 아닌 **드로어 하단 유틸 섹션** 에 묶는다(단축키 치트시트 바로 위).

### 1.7 상태 기계

```
 idle
  │ 최초 접속(플래그=false) · "다시 보기" 클릭
  ▼
 step[0]  ──next→  step[1]  ──next→  step[2]  ──next→  step[3]
  ▲  ▲             │         │         │         │
  │  │             └─prev─────┘   ←────┘    ←────┘
  │  └──── esc/skip ──────────────────────────────┐
  │                                                │
  └──── (플래그=true, justSkipped?) ────────────── completed
                                                  │
                                                  ▼
                                    (chain into existing OnboardingTour)
```

---

## 2. 투어 — 접근성 · 단축키 · 포커스

| 항목                   | 동작                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------- |
| 다이얼로그               | `role="dialog"` · `aria-modal="true"` · `aria-labelledby=title` · `aria-describedby=body` |
| 포커스 초기              | 스텝 1 언어 탭 "한국어" 또는 "English" 중 현재 값                                          |
| Tab 순서                  | 제목 영역 → 본문 상호작용 요소 → 건너뛰기 → 이전/다음                                       |
| 단축키                    | Enter/→ 다음 · ← 이전 · Esc 건너뛰기(기존 `OnboardingTour` 계약 계승)                       |
| 포커스 트랩                | 다이얼로그 내부 순환. 마지막 → 다음 탭키 시 첫 요소로                                         |
| spotlight 대비             | 스포트라이트 바깥은 `--onboarding-scrim-bg` rgba(0,0,0,.45) 고정(기존 토큰)                 |
| 움직임 감소                | `prefers-reduced-motion` 존중 · 스텝 전환 fade 생략 · 펄스 애니메이션 정적 경계선으로 대체   |
| 스크린리더 전이           | 스텝 변경 시 새 제목이 자동 포커스되어 낭독됨                                                 |

---

## 3. 교차 상태 감사 — 4 기능 × 4 상태 매트릭스

### 3.1 상태 정의(O-09 ~ O-12 재인용)

| 상태                | 기준 컴포넌트       | 톤 · 색                                                                  |
| ------------------- | -------------------- | ------------------------------------------------------------------------ |
| `loading`            | `EmptyState`(variant) | cyan halo · `Loader2` 아이콘 · `role="status"` · `aria-live="polite"`     |
| `empty`              | `EmptyState`          | cyan halo · `Inbox` 또는 기능별 아이콘 · 정적(role 없음)                    |
| `offline`            | `ErrorState` (변형)   | **amber strip** · `WifiOff` 아이콘 · `aria-live="polite"` · 재연결 시 자동 해제 |
| `permissionDenied`   | `ErrorState`          | red strip · `ShieldAlert` 아이콘 · `[설정으로 가기]` primary · `role="alert"` |

> 현행 `ErrorState` 는 붉은 스트립 고정이다. **오프라인은 amber 로 분기** 하기 위한 prop 확장이 필요 — §3.4 에서 Joker 가 받아 쓸 수 있는 변경 제안을 명시.

### 3.2 매트릭스 — 현행 vs 제안

| 기능 \ 상태         | loading                                    | empty                                          | offline                                               | permissionDenied                                 |
| ------------------- | ------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------ |
| **에이전트 추천**     | 현: 모달 내부 spinner + "추천을 준비하는 중…" → 제안: `EmptyState loading` + 기본 문구 `onboarding.states.loading.recommend` | 현: 카드 자리 빈 문구 `project.newProjectWizard.empty` · 제안 유지(이미 일관) | 현: 명시 없음 → 제안: **amber offline 배너** · 문구 §7 | 현: 없음 → 제안: 추천 실패 403 → `permissionDenied` · 문구 §7 |
| **MCP 전송**         | 현: 없음(동기 폼) → 제안: 서버 추가 제출 중 primary 버튼 `aria-busy` + 문구 `추가 중…` | 현: "등록된 MCP 서버가 없습니다." 이탤릭 한 줄 → 제안: `EmptyState empty` 로 전환 + `[서버 추가하기]` CTA | 현: 저장 실패 시 에러 문자열 그대로 → 제안: amber offline 배너 + 로컬 저장 성공 안내 | 현: `PERMISSION_DENIED` 에러 별도 처리 없음 → 제안: `ErrorState` + `[자격 증명 설정]` CTA |
| **i18n 토글**         | 현: 지연 거의 0 → 제안 유지(스피너 금지, `token-savings-visualization-2026-04-21.md` §6.1 원칙 계승) | 해당 없음(토글은 항상 2개 옵션)                  | 현: `persistLocale` 실패 시 토스트 → 제안 유지(선행 시안 §6.2 `persistFailed`) | 해당 없음(권한 필요 없음)                         |
| **토큰 인디케이터**   | 현: 배지 렌더 자체가 즉시 · 누적 데이터 로드 중 폴백 배지 있음 → 제안: 상세 패널 3카드 각각 `EmptyState loading` | 현: "데이터가 쌓이면 추세가 보여요." 스파크라인 빈상태 → 제안 유지 | 현: 상단 배지 `loadError` 시 "토큰 정보 없음" 폴백 → 제안: amber offline 배지로 브랜드 통일 | 현: OAuth 실패 시 경계 — 제안: `ErrorState` + `[Claude 계정 다시 연결]` CTA |

### 3.3 불일치 지점(C-01 ~ C-06)

| ID    | 지점                                                                 | 제안                                                                                                     |
| ----- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| C-01  | MCP 패널 빈 상태가 `italic text-white/50` 한 줄 — `EmptyState` 미사용    | `<EmptyState variant="empty" title=… action={label: '서버 추가하기'} />` 로 교체                          |
| C-02  | 토큰 인디케이터 폴백 배지는 `--error-state-*` 팔레트 사용(붉음) — 오프라인은 amber 가 되어야 | amber 변형 도입 후 교체. 현행 red 는 실제 에러(401 등) 한정.                                              |
| C-03  | 에이전트 추천 위저드 로딩은 내부 spinner 로 공용 템플릿 미사용            | `EmptyState variant=loading` 로 교체해 4기능 로딩 톤 통일                                                 |
| C-04  | 오프라인 상태를 4기능 모두가 `useOnlineStatus` 로 표시하지 않음            | `OfflineBanner` (ErrorState amber 래퍼) 를 공용화 · §3.4 구현 제안                                        |
| C-05  | 권한 없음 카피가 기능마다 제각각("활성화된 공급자가 없습니다." 등)         | `states.permissionDenied.*` 공용 카피(§7.3) 로 수렴 + 재사용 가능한 CTA 링크(`[설정으로 가기]`)            |
| C-06  | `EmptyState` 의 기본 아이콘이 항상 Inbox — 기능별 구분이 어려움           | 기능별 아이콘 prop 사용(`Users` · `Server` · `Languages` · `Battery`). 이미 prop 지원 — 호출부만 바꾸면 됨. |

### 3.4 `ErrorState` 변형 제안(Joker 구현 참고)

현행 `ErrorState` 는 stripe 색이 `--error-state-strip` 하드코딩. 오프라인 amber 분기를 위해 **최소 prop 1개 추가**:

```ts
export type ErrorStateTone = 'danger' | 'warning';   // 기본 danger
export interface ErrorStateProps {
  tone?: ErrorStateTone;
  // 기존 prop 그대로
}
```

- `tone='warning'` → strip 색 `--color-warning` · 배경 `--color-warning-surface` · 아이콘 `WifiOff`(오프라인 지정 시).
- `tone='danger'` → 현행 그대로(변경 없음 · 하위 호환).
- `aria-live` 는 두 tone 모두 `polite`(assertive 는 사용자 흐름을 끊으므로 피함).

### 3.5 Figma 등가 — 상태 감사 비교 시트

```
 ┌─ 한 페이지 · 4행 × 4열 갤러리 ────────────────────────────────────────────┐
 │           │ loading       │ empty        │ offline      │ permissionDenied │
 │ 에이전트   │ [그림·현행]    │ [그림·현행]   │ [그림·제안]   │ [그림·제안]       │
 │ MCP       │ [그림·제안]    │ [그림·제안]   │ [그림·제안]   │ [그림·제안]       │
 │ i18n      │ [N/A]          │ [N/A]        │ [그림·현행]   │ [N/A]             │
 │ 토큰      │ [그림·제안]    │ [그림·현행]   │ [그림·제안]   │ [그림·제안]       │
 │                                                                            │
 │ 범례: 녹 = 일관 확보 · 황 = 보정 필요 · 회 = 해당 없음                        │
 └────────────────────────────────────────────────────────────────────────────┘
```

- Figma 파일이 아직 없으므로 본 문서의 ASCII 배치가 **Figma 1페이지 = 본 .md 1섹션** 의 등가(선행 시안 `mcp-transport-and-language-toggle-2026-04-20.md` 전문 규약).
- 실제 Figma 도입 시 §3.2 표와 §3.4 prop 은 Components Variants 로 이식.

---

## 4. 접근성 체크리스트 — 4 기능 공통 표

### 4.1 키보드 탐색

| 요구                                  | 에이전트 추천        | MCP 전송              | i18n 토글            | 토큰 인디케이터       |
| ------------------------------------- | -------------------- | --------------------- | -------------------- | -------------------- |
| Tab 순서가 시각 순서와 동일             | ✓ (Wizard 3단)        | ✓ (현행)              | ✓ (드로어)            | ✓ (배지→상세)         |
| Esc 로 닫기/취소                        | ✓ (dirtyClose 가드)   | — (패널이므로)         | ✓ (드로어)            | ✓ (툴팁 닫기)         |
| Enter/Space 로 주요 결정               | ✓                    | ✓                    | ✓                    | ✓                    |
| 모든 상호작용 요소가 포커스 가능         | ✓                    | ⚠ **삭제 확인 `window.confirm`** → 브라우저 종속 포커스 | ✓                    | ✓                    |
| 포커스 링 2px + offset 2px              | ✓                    | ✓ (`focusRing` 상수)   | ✓                    | ✓                    |
| 단축키 문서화 치트시트                  | ⚠ 위저드 단축키 미노출 | — (없음)              | ⚠ `Alt+Shift+L` 미노출 | ✓                    |

**수정 제안**
- **에이전트 추천**: 위저드 단축키(Enter=추가 · Tab=다음 필드) 를 `KeyboardShortcutCheatsheet` 에 등록.
- **MCP**: `confirm()` 을 `ErrorState` 스타일 인라인 확인 UI 또는 Toast 되돌리기(선행 §K-05) 로 교체.
- **i18n**: `Alt+Shift+L` 단축키를 치트시트 "설정" 섹션에 추가. SR 에 단축키 안내 포함.

### 4.2 스크린리더 라벨

| 요구                                   | 에이전트 추천        | MCP 전송              | i18n 토글            | 토큰 인디케이터      |
| -------------------------------------- | -------------------- | --------------------- | -------------------- | -------------------- |
| 다이얼로그/패널 `aria-labelledby`         | ✓                    | ✓ (`project-mcp-servers-heading`) | ✓ (drawer)    | ✓ (상세 패널)         |
| 상태 변경 `aria-live`                     | ✓                    | ⚠ 에러 블록 `polite` 있지만 추가 시 `assertive` 혼재 | ✓ (토스트 polite) | ✓ |
| 그래프/아이콘 `role="img" + aria-label`    | — (아이콘만)          | ✓                    | ✓                    | ⚠ **스파크라인 `role="img"` 미지정** |
| 동적 목록 `role="list"/listitem`          | ✓                    | ⚠ 카드 그리드 `<article>` — role 명시 없음 | —                    | ✓ (카드 2)           |
| 아이콘 전용 버튼 `aria-label`              | ✓                    | ✓                    | ✓                    | ✓                    |

**수정 제안**
- **토큰 스파크라인**: `role="img" aria-label="…7세션 합계 추세…"` 추가(선행 시안 `token-savings-visualization-2026-04-21.md` §4.2 기재 재확인).
- **MCP 카드 그리드**: 컨테이너 `role="list"` + 각 `<article>` `role="listitem"`.
- **MCP 에러 블록**: `aria-live="polite"` 단일 축으로 고정, assertive 남용 금지.

### 4.3 대비 AA(WCAG 2.4.3 · 1.4.3)

| 요소                                 | 현행 토큰/값                                       | 배경                            | 대비 예측   | 판정    |
| ------------------------------------ | -------------------------------------------------- | ------------------------------- | ----------- | ------- |
| 본문 텍스트(흰 100%)                   | #f4f4fb on `--color-bg` #1a1a2e                    | 다크 기본                        | ≈ 14.6:1    | AAA ✓   |
| 보조 텍스트(`--color-text-muted`)      | rgba(244,244,251,.72) on `--color-bg`              | 다크 기본                        | ≈ 10.5:1    | AAA ✓   |
| 미묘 텍스트(`--color-text-subtle`)     | rgba(244,244,251,.56) on `--color-bg`              | 다크 기본                        | ≈ 8.2:1     | AA ✓     |
| 근거 텍스트 11px (추천 카드)           | `--color-text-subtle` on `--color-surface-elevated`| `#0f3460`                        | ≈ 6.7:1     | AA ✓     |
| amber 경고(오프라인 제안)              | `#f59e0b` on `--color-warning-surface` 위 검은      | 반투명 배경                      | ≈ 4.9:1     | AA ✓     |
| 토큰 인디케이터 cyan                    | `#7fd4ff` on `--color-bg`                         | 다크 기본                        | ≈ 11.4:1    | AAA ✓   |
| 토큰 인디케이터 amber(출력)              | `#fbbf24` on `--color-bg`                         | 다크 기본                        | ≈ 11.6:1    | AAA ✓   |
| 캐시 적중 emerald                       | `#34d399` on `--color-bg`                         | 다크 기본                        | ≈ 8.9:1     | AAA ✓   |
| MCP 입력 placeholder                    | 현행 Tailwind `text-white/40` ≈ rgba 0.40         | `bg-black/30`                    | **≈ 2.7:1** | **미달** |
| 투어 scrim 위 다이얼로그 본문            | #f4f4fb on rgba(0,0,0,.45) 위 `--color-surface`    | 복합                             | ≈ 13+:1     | AAA ✓   |

**수정 제안**
- **MCP placeholder** : `text-white/40` → `text-white/60` (= rgba 0.60) 으로 상향. 테스트 계약에 placeholder 값 자체는 영향 없음.
- 본 표의 숫자는 **WCAG Contrast Checker 실측이 아닌 RGBA 근사치** 이므로, Joker 가 `@axe-core/playwright` 같은 자동화 런너로 실측을 거쳐 최종 잠금하는 것을 권장(§8 R-A1).

### 4.4 움직임 · 시각 과민 대응

| 요구                                   | 현행         | 제안                                                          |
| -------------------------------------- | ------------ | ------------------------------------------------------------- |
| `prefers-reduced-motion` 존중           | ✓ (tokens.css) | 네 기능 모두 상속 — 추가 조치 불필요                          |
| 펄스·반짝임 1.6s 순환                    | ✓ (warning-pulse) | 오프라인 배너에 펄스 적용 금지(O-10 톤 — 긴급 아님)            |
| 자동 재생 움직임                         | 없음          | 유지                                                         |

---

## 5. 투어 저장소 · 재시작 진입점

```
 localStorage
 ├── llmtycoon.onboarding.completed             (기존 · 상단바/업로드/내보내기 3스텝)
 ├── llmtycoon.firstRunTour.completed           (신규 · 본 시안 4스텝)
 └── llmtycoon.firstRunTour.skipped             (신규 · 건너뛰기 여부 — "다시 보기" 강조에 사용)
```

- 저장 범위: **전역**. 우선 검토 파일 `codeConventionStore.ts` 의 "전역/로컬" 분리 규약에서 본 플래그는 **사용자 프로필 수준** 이라 전역만 둔다.
- 재시작 API: `resetFirstRunTour()` — 두 신규 키 삭제 + `restartKey` 증가. SettingsDrawer 의 `[투어 다시 보기]` 가 호출.
- 개발자 디버그: `?firstRunTour=replay` 쿼리 파라미터로 1회성 재시작(저장은 건드리지 않음).

---

## 6. 컴포넌트 트리 · 재사용

```
FirstRunTour                                   (신규 · src/components/FirstRunTour.tsx)
├─ TourDialog                                  (공통 · 기존 OnboardingTour 스타일 토큰 재사용)
├─ Step1_Language                               (LanguageToggle 재사용 · 세그먼티드)
├─ Step2_McpTransport                            (카드 3장 · 설명 ≤60자)
├─ Step3_AgentRecommendation                     (NewProjectWizard preview-mode prop)
└─ Step4_TokenIndicator                          (SessionBreakdownBar spotlight 타깃)

OfflineBanner                                    (신규 · src/components/OfflineBanner.tsx)
 └─ ErrorState(tone='warning')                    (변형 · §3.4)

EmptyState  (기존)                                 확장 props 없음 — 기능별 icon 만 바꿔 소비
ErrorState  (기존)                                 tone='warning' 추가 (§3.4)

SettingsDrawer  (기존)                              + "온보딩 투어" 섹션(§1.6)
```

- 새 토큰: **없음**. `--color-warning` · `--color-warning-surface` 재사용.
- 새 CSS 변수: **없음**.

---

## 7. i18n 키 후보 — `onboarding.*` · `states.*`

### 7.1 투어 공통 · 네비게이션

| 키                              | 한국어                                               | English                                            |
| ------------------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| `onboarding.firstRun.title`      | 처음이시군요 — 4단계만 훑어볼게요                      | First time here? Just 4 quick steps                 |
| `onboarding.firstRun.progress`   | {current}/{total}                                   | {current}/{total}                                   |
| `onboarding.firstRun.skip`       | 건너뛰기                                             | Skip                                                |
| `onboarding.firstRun.prev`       | ← 이전                                               | ← Previous                                          |
| `onboarding.firstRun.next`       | 다음 →                                               | Next →                                              |
| `onboarding.firstRun.finish`     | 완료 ✓                                               | Done ✓                                              |
| `onboarding.firstRun.replayLink` | 투어 다시 보기                                        | Replay tour                                         |
| `onboarding.firstRun.replayHint` | 설정 › 온보딩 투어에서 언제든 다시 볼 수 있어요.        | You can replay this from Settings › Onboarding.      |

### 7.2 스텝별 카피

| 키                                           | 한국어                                                            | English                                                            |
| -------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `onboarding.step.language.title`              | 🌐 언어 선택                                                        | 🌐 Choose language                                                  |
| `onboarding.step.language.body`               | 어떤 언어로 진행할까요? 나중에 설정에서 언제든 바꿀 수 있어요.         | Which language should we use? You can change it any time in Settings. |
| `onboarding.step.language.changeHint`         | 설정 → 언어 에서 언제든 바꿀 수 있어요.                                | Change it later in Settings → Language.                             |
| `onboarding.step.mcp.title`                   | 🔌 MCP 전송 방식                                                    | 🔌 MCP transport                                                    |
| `onboarding.step.mcp.body`                    | 프로젝트 관리 메뉴에서 서버를 추가할 때 세 가지 중 골라요.             | When you add a server in Project Management, pick one of three.      |
| `onboarding.step.mcp.card.stdio.title`         | stdio                                                             | stdio                                                             |
| `onboarding.step.mcp.card.stdio.body`          | 자식 프로세스로 바로 실행(로컬 도구)                                  | Spawns a child process (local tools)                                 |
| `onboarding.step.mcp.card.http.title`          | http                                                              | http                                                              |
| `onboarding.step.mcp.card.http.body`           | REST API 엔드포인트 호출(외부 서버)                                    | Calls a REST endpoint (remote server)                                |
| `onboarding.step.mcp.card.streamable.title`    | streamable-http                                                    | streamable-http                                                    |
| `onboarding.step.mcp.card.streamable.body`     | SSE 스트림 · 지속 연결(대화형 공급자)                                 | SSE stream over a long connection (chat-style)                       |
| `onboarding.step.agent.title`                  | 👥 에이전트 팀 추천                                                 | 👥 Agent team recommendations                                       |
| `onboarding.step.agent.body`                   | 프로젝트 설명만 적으면 팀이 자동으로 추천돼요.                         | Describe your project and we'll suggest a team.                       |
| `onboarding.step.agent.previewLabel`           | 프리필 예시(편집 불가)                                                | Sample (read-only preview)                                           |
| `onboarding.step.agent.previewSample`          | 사내 일정 공유 웹앱 · 접근성 감사                                      | Internal scheduling web app · accessibility audit                     |
| `onboarding.step.agent.hint`                   | 💡 실제로는 설명을 직접 쓰면 됩니다.                                  | 💡 In the real flow, just type your description.                      |
| `onboarding.step.token.title`                   | 🔋 토큰 사용량                                                      | 🔋 Token usage                                                       |
| `onboarding.step.token.body`                    | 상단바의 3색 바가 이번 세션 사용량을 보여줘요.                         | The tri-color bar on the top shows this session's usage.              |
| `onboarding.step.token.legend.input`            | 입력                                                               | Input                                                               |
| `onboarding.step.token.legend.output`           | 출력                                                               | Output                                                              |
| `onboarding.step.token.legend.cacheRead`        | 캐시 적중                                                           | Cache hit                                                            |
| `onboarding.step.token.savingHint`              | 💰 는 캐시로 토큰을 아끼고 있다는 뜻이에요.                           | 💰 means we're saving tokens via cache hits.                         |
| `onboarding.step.token.detailLink`               | 토큰 사용 상세 보기                                                   | View token usage details                                             |

### 7.3 공통 상태 카피(4 기능 수렴)

| 키                                          | 한국어                                                     | English                                                   |
| ------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| `states.loading.default`                     | 불러오는 중…                                                | Loading…                                                 |
| `states.loading.recommend`                   | 추천을 준비하는 중…                                          | Preparing recommendations…                                 |
| `states.loading.mcpAdd`                      | MCP 서버 추가 중…                                            | Adding MCP server…                                        |
| `states.empty.default.title`                 | 아직 아무것도 없어요                                         | Nothing here yet                                           |
| `states.empty.default.description`           | 위 도움말을 따라 첫 항목을 추가해 보세요.                     | Follow the guide above to add the first item.              |
| `states.empty.mcp.title`                     | 등록된 MCP 서버가 없어요                                     | No MCP servers yet                                         |
| `states.empty.mcp.action`                    | 서버 추가하기                                                | Add a server                                               |
| `states.empty.tokenTrend.title`              | 추세가 곧 나타나요                                           | Trend will appear soon                                     |
| `states.empty.tokenTrend.description`        | 3세션 이상이 쌓이면 스파크라인이 채워집니다.                  | The sparkline fills in once 3+ sessions are recorded.        |
| `states.offline.title`                        | 오프라인 상태예요                                            | You're offline                                             |
| `states.offline.description`                  | 연결이 돌아오면 자동으로 이어집니다. 로컬 설정은 저장돼 있어요. | We'll reconnect automatically. Local settings are saved.      |
| `states.offline.label`                        | 오프라인                                                    | Offline                                                   |
| `states.permissionDenied.title`               | 권한이 필요해요                                              | Permission required                                       |
| `states.permissionDenied.description`         | 이 기능을 쓰려면 {scope} 권한이 필요합니다.                    | This feature needs {scope} permission.                     |
| `states.permissionDenied.cta`                 | 설정으로 가기                                                | Open settings                                              |
| `states.permissionDenied.scope.mcp`            | MCP 자격 증명                                                | MCP credentials                                           |
| `states.permissionDenied.scope.agent`          | 에이전트 추천 서비스                                          | Agent recommendation service                               |
| `states.permissionDenied.scope.token`          | Claude 계정 연결                                              | Claude account connection                                 |

### 7.4 오프라인 · 재연결 피드백

| 키                                    | 한국어                                                 | English                                                |
| ------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| `states.offline.toast.onDrop`          | 인터넷 연결이 끊어졌어요.                                | Internet connection dropped.                            |
| `states.offline.toast.onRestore`       | 다시 연결됐어요.                                        | You're back online.                                    |
| `states.offline.banner.action`         | 재시도                                                 | Retry                                                  |

---

## 8. 결정 대기(Kai · Joker · QA)

| ID    | 질문                                                                       | 대상     |
| ----- | -------------------------------------------------------------------------- | -------- |
| R-F1  | 4스텝 투어를 기존 OnboardingTour 와 **병합** 할지 **분리** 할지(본 시안은 분리 제안) | Kai      |
| R-F2  | 스텝 3 프리필 예시 문장을 영한 공용으로 둘지, locale 별 예시 문장을 따로 둘지    | Kai      |
| R-F3  | `llmtycoon.firstRunTour.skipped` 플래그 사용 근거 — 7일 후 자동 리셋 등 정책 필요? | Kai      |
| R-S1  | `ErrorState` 에 `tone='warning'` prop 추가하는 변경을 한 번에 반영 vs 단계 전개       | Joker    |
| R-S2  | MCP 삭제 확인의 `window.confirm` 교체를 **토스트 되돌리기** 로 할지 **인라인 확인 배너** 로 할지 | Joker    |
| R-S3  | 4기능의 로딩 폴백을 `EmptyState variant=loading` 으로 일괄 교체 시 회귀 위험       | Joker · QA |
| R-A1  | WCAG 대비 실측을 `@axe-core/playwright` 로 런타임 측정 + CI 고정할 것을 제안       | QA       |
| R-A2  | MCP placeholder `text-white/40` → `text-white/60` 변경이 기존 e2e 를 깨지 않는지   | QA       |
| R-A3  | `Alt+Shift+L` 단축키 충돌(브라우저 번역 확장 · SR) 실측 요청                       | QA       |

---

## 9. 파일 배치(참고)

```
src/components/
  FirstRunTour.tsx                             (신규 · §1 · §2)
  FirstRunTour/                                (내부 스텝 분할 선택)
    Step1Language.tsx
    Step2McpTransport.tsx
    Step3AgentPreview.tsx
    Step4TokenIndicator.tsx
  OfflineBanner.tsx                            (신규 · §3.4)
  ErrorState.tsx                               (기존 · tone prop 추가)
  EmptyState.tsx                               (기존 · 그대로)
  SettingsDrawer.tsx                           (기존 · "온보딩 투어" 섹션 추가)

src/utils/
  firstRunTourStorage.ts                        (신규 · 플래그 2종 + resetFirstRunTour)

locales/
  en.json · ko.json                            (§7 onboarding.* · states.* 키 추가)
```

- 모든 변경은 기존 토큰 재사용. 새 CSS 변수 · 새 Tailwind 유틸 없음.

---

끝.
