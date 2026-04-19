# 시각 일관성 최종 검수 (2026-04-19, 출시 준비)

관련 선행 문서:
- `tests/accessibility-audit-checklist.md` — 7 화면 × 5축 접근성 판정. 본 검수의 상한선.
- `tests/ux-simplification-targets-20260419.md` — UX 저해 제거(T1~T4). 본 검수와 **병행 적용** 시
  시각 편차가 자동 해소되는 항목 있음(§2.4 표 참조).
- `tests/media-attachment-panel-mockup.md` · `tests/media-asset-preview-mockup.md` · `tests/token-
  fallback-states-mockup.md` · `tests/fallback-readonly-banner-mockup.md` · `tests/task-commit-
  strategy-mockup.md` · `tests/shared-goal-modal-mockup.md` — 각 축 시안이 약속한 토큰 계약을
  본 검수가 **단일 진원** 기준으로 교차 대조.

검수 범위(9 화면):
- `src/App.tsx` · `src/components/AuthGate.tsx` · `src/components/ProjectManagement.tsx`
- `src/components/DirectivePrompt.tsx` · `src/components/CollabTimeline.tsx` · `src/components/LogPanelTabs.tsx`
- `src/components/SharedGoalModal.tsx` · `src/components/ClaudeTokenUsage.tsx` · `src/components/TokenUsageSettingsPanel.tsx`

+ 4 공용 상태 컴포넌트: `EmptyState.tsx` · `ErrorState.tsx` · `ToastProvider.tsx` · (로딩은 EmptyState variant)

본 문서는 **코드 변경 없이 검수만 수행** 한다. 편차 조치는 이어질 라운드에서 처리.

---

## 0. 검수 축 (V-01 ~ V-08)

| ID   | 축                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| V-01 | **공용 상태 컴포넌트 사용** — 9 화면 중 로딩/빈/에러가 있는 자리에 EmptyState·ErrorState·ToastProvider 를 실제로 쓰는가.            |
| V-02 | **간격(spacing)** — padding·gap·stack-gap 의 값이 토큰(혹은 공용 Tailwind 스케일) 을 따르는가, 리터럴 px 인가.                    |
| V-03 | **라운드(radius)** — border-radius 가 `--*-radius` 토큰 또는 4/6/8/10px 의 4 단계 스케일 중 하나인가.                               |
| V-04 | **그림자(shadow)** — box-shadow 가 토큰(`--shared-goal-modal-shadow` · `--toast-shadow` 등) 을 쓰는가, 리터럴 rgba 인가.         |
| V-05 | **모션(duration/easing)** — transition · keyframes 가 토큰 혹은 공용 duration 스케일(120/160/180/220ms) 을 쓰는가.                  |
| V-06 | **색 공유 규약** — "같은 의미 = 같은 색" 이 깨지지 않는가(grep 1 번으로 재확인 가능).                                                  |
| V-07 | **다크/라이트 대응 유무** — `--*-on-light` 변이 또는 `@media (prefers-color-scheme: light)` 존재 여부.                               |
| V-08 | **축소 모션 가드** — 애니메이션이 있는 모든 경로가 `useReducedMotion` 훅 혹은 `@media (prefers-reduced-motion: reduce)` 로 가드.   |

합격 기호: ✅ 합격 · 🟡 부분 · 🔴 편차 · — 해당 없음.

---

## 1. 공용 상태 컴포넌트 사용 표 (V-01)

### 1.1 9 화면별 상태 커버리지

| 화면                              | 로딩 상태                    | 빈 상태                     | 에러 상태                   | 토스트 사용                     |
| --------------------------------- | --------------------------- | -------------------------- | --------------------------- | ------------------------------- |
| `App.tsx`                         | 🔴 전용 스피너(`Loader2` + animate-spin) | 🔴 `EmptyProjectPlaceholder` 별도 컴포넌트 | 🔴 인라인 `alert()` / `<div>` | 🟡 간헐적 — 일부 성공/실패 경로만 |
| `AuthGate.tsx`                    | ✅ `EmptyState variant="loading"` 권장(아직 인라인) · 현 구현은 `<div>Loading...</div>` | — (미해당)                  | 🔴 `bootError` 인라인 `<div className="text-red-400">` (접근성 체크 A1) | 🔴 없음 — 실패 시 토스트 승격 필요 |
| `ProjectManagement.tsx`           | 🟡 Git 자동화만 EmptyState, 다른 로딩은 인라인 | ✅ EmptyState (미선택 박스)   | 🟡 일부 saveStatus 는 인라인 배너 | ✅ useToast 호출(저장 성공·실패)   |
| `DirectivePrompt.tsx`             | 🔴 업로드 진행 `data-uploading` 만(시각 단서 없음 — 접근성 B1) | — (빈 상태 없음 · 드롭존이 대체) | 🟡 `errorToast` prop 으로 부모 위임 | 🔴 자체 useToast 없음 — 부모 위임 |
| `CollabTimeline.tsx`              | — (실시간 스트림만)           | ✅ `EmptyState` 사용         | — (행 단위 orphan/fallback 인라인) | — (없음)                         |
| `LogPanelTabs.tsx`                | — (탭은 정적)                | — (패널 내부는 자식이 담당)   | — (없음)                     | — (없음)                         |
| `SharedGoalModal.tsx`             | ✅ 저장 중 aria-busy + 인라인 "저장 중…" | ✅ empty-create 배너(전용)   | ✅ 필드·서버 에러 `role="alert"` | ✅ useToast (성공/실패)            |
| `ClaudeTokenUsage.tsx`            | — (배지는 동기)              | 🟡 data-empty="true" + 카피만(EmptyState 미사용) | ✅ `--error-state-*` 토큰 소비 | 🟡 폴백 전이만(F1→F4 토스트는 시안 상 ToastProvider 위임) |
| `TokenUsageSettingsPanel.tsx`     | — (정적 폼)                  | — (빈 상태 없음)             | ✅ `role="alert"` 저장 실패 배너 | — (패널 자체는 토스트 발사 안 함) |

### 1.2 주요 편차 요약

- **🔴 A (App)**: 로딩·에러 세 축이 전부 공용 컴포넌트를 우회. 리팩터 1회로 3자리가 동시에 정리됨.
- **🔴 B (AuthGate)**: bootError 배너가 색상 클래스만 가진 `<div>` — 접근성 체크리스트 A1 과 동일 결함.
- **🔴 C (DirectivePrompt)**: 업로드 진행 시각 단서 부재. 접근성 B1 과 연동.
- **🟡 D (ClaudeTokenUsage)**: 빈 상태(호출 없음) 가 EmptyState 를 쓰지 않고 배지 내부 카피·`data-empty`
  로만 전달. 배지는 공간 제약상 EmptyState 통째 삽입은 부적절 — **예외로 인정**, 단 카피·색 규약은 유지.

### 1.3 교차 사용 매트릭스 (공용 컴포넌트 import 여부)

| 파일                              | `EmptyState` import | `ErrorState` import | `useToast` import |
| --------------------------------- | :-----------------: | :-----------------: | :---------------: |
| `App.tsx`                         | ❌                  | ❌                  | ❌                |
| `AuthGate.tsx`                    | ❌                  | ❌                  | ❌                |
| `ProjectManagement.tsx`           | ✅                  | ❌                  | ✅                |
| `DirectivePrompt.tsx`             | ✅                  | ❌                  | ❌                |
| `CollabTimeline.tsx`              | ✅                  | ❌                  | ❌                |
| `LogPanelTabs.tsx`                | ❌                  | ❌                  | ❌                |
| `SharedGoalModal.tsx`             | ❌(전용 배너)       | ❌                  | ✅                |
| `SharedGoalForm.tsx`              | ✅                  | ✅                  | ❌                |
| `ClaudeTokenUsage.tsx`            | ❌(토큰만 소비)     | ❌(토큰만 소비)      | ❌                |
| `TokenUsageSettingsPanel.tsx`     | ❌                  | ❌(토큰만 소비)      | ❌                |
| `EmptyProjectPlaceholder.tsx`     | ✅ 내부 활용         | —                   | —                 |

**관찰**: ErrorState 를 실제로 import 하는 파일이 SharedGoalForm 단 1곳. 나머지는 토큰만 직접 var()
참조. 이는 **토큰 계약은 지켜지고 있으나 컴포넌트 계약은 분산** 이라는 중간 상태를 보여준다. 다음
라운드에서 App.tsx·AuthGate.tsx 의 실패 표시를 ErrorState 로 승격하면 계약이 한 방향으로 수렴한다.

---

## 2. 간격·라운드·그림자·모션 토큰 편차 표 (V-02 ~ V-05)

### 2.1 공용 상태 3종의 규격 (정답지)

아래는 `src/index.css` 의 **현재 단일 진원** 값. 나머지 화면은 이 값들과의 편차를 기록한다.

| 축      | EmptyState              | ErrorState              | Toast (variant 공용)    | SharedGoalModal (참조)     |
| ------- | ----------------------- | ----------------------- | ----------------------- | -------------------------- |
| 패딩    | `20px 24px`             | `16px 20px`             | `12px 14px`             | `padding: 0` (구조 전용)   |
| 간격    | gap 10                  | gap 8                   | gap 10 · stack-gap 8   | gap 16                     |
| 라운드   | `8px` (`--empty-state-radius`) | `8px` (`--error-state-radius`) | `8px` (`--toast-radius`) | `10px` (`--shared-goal-modal-radius`) |
| 그림자   | — (없음)                | — (없음)                 | `0 14px 36px rgba(0,0,0,0.5)` | `0 18px 48px rgba(0,0,0,0.55)` |
| 진입 모션 | — (정적)                | — (정적)                 | `enter 180ms / exit 140ms` | `enter 220ms / exit 160ms` |

### 2.2 라운드(border-radius) 편차 — 9 화면 × 공용 3

| 화면                              | 라운드 관찰                                                                                  | 판정 |
| --------------------------------- | -------------------------------------------------------------------------------------------- | :--: |
| `App.tsx`                         | 상단바 배지류는 radius 없음(픽셀 박스 유지). 프로젝트 전환 모달은 Tailwind `rounded-lg` (8px)  | ✅ 공용 스케일(8px) |
| `AuthGate.tsx`                    | LoginForm/SignupForm 은 Tailwind `rounded` (4px) + 내부 입력 `rounded-sm` (2px)                | 🔴 스케일 밖(2px) |
| `ProjectManagement.tsx`           | 카드 radius 없음(픽셀 박스 유지) · 일부 버튼 `rounded` (4px)                                   | ✅                    |
| `DirectivePrompt.tsx`             | 드롭존 radius 없음(픽셀 박스). 첨부 타일 Tailwind `rounded` (4px)                              | ✅                    |
| `CollabTimeline.tsx`              | 행·필터 칩 모두 radius 없음(픽셀 박스)                                                        | ✅                    |
| `LogPanelTabs.tsx`                | 탭 radius 없음 · 패널 radius 없음                                                             | ✅                    |
| `SharedGoalModal.tsx`             | 다이얼로그 `10px` · 내부 필드 `3px`                                                           | 🟡 내부 필드 3px(4 단계 밖) |
| `ClaudeTokenUsage.tsx`            | 배지 radius 없음 · 툴팁 `8px` · 설정 패널 `8px`                                                | ✅                    |
| `TokenUsageSettingsPanel.tsx`     | 컨테이너 `8px` · 내부 입력 radius 없음                                                        | ✅                    |

**편차 정리**:
- 🔴 AuthGate 의 입력 `rounded-sm`(2px) 는 공용 4 단계(4/6/8/10) 밖. **4px 로 승격** 제안.
- 🟡 SharedGoalModal 의 내부 필드 `3px` → `4px` 로 승격(시안과의 편차는 1px, 근접).

### 2.3 그림자(box-shadow) 편차

| 화면                              | 그림자 관찰                                                        | 판정 |
| --------------------------------- | ------------------------------------------------------------------ | :--: |
| `App.tsx`                         | 모달 `0 18px 48px rgba(0,0,0,0.55)` (= `--shared-goal-modal-shadow`) | ✅   |
| `AuthGate.tsx`                    | LoginForm 카드 `0 10px 30px rgba(0,0,0,0.4)` 하드코드              | 🔴 리터럴 |
| `ProjectManagement.tsx`           | 선택 카드 `inset 0 0 0 1px rgba(0,212,255,.35), 0 0 18px -6px rgba(0,212,255,.55)` (6중 강조) | 🟡 UX-U04 중복 |
| `DirectivePrompt.tsx`             | 그림자 없음                                                        | —    |
| `CollabTimeline.tsx`              | 그림자 없음                                                        | —    |
| `LogPanelTabs.tsx`                | 그림자 없음                                                        | —    |
| `SharedGoalModal.tsx`             | `--shared-goal-modal-shadow` 사용                                 | ✅   |
| `ClaudeTokenUsage.tsx`            | 툴팁 `--token-usage-tooltip-shadow` 사용                          | ✅   |
| `TokenUsageSettingsPanel.tsx`     | 동일 토큰 상속                                                    | ✅   |
| Toast                             | `--toast-shadow`                                                  | ✅   |

**편차**:
- 🔴 AuthGate LoginForm 의 리터럴 그림자 → 신규 토큰 `--surface-shadow-lg` 로 승격 제안(§3.1).
- 🟡 ProjectManagement 선택 카드의 6중 강조 → `tests/ux-simplification-targets-20260419.md` U04 에
  이미 등록. 본 검수 추가 작업 없이 UX 단순화 T2 적용 시 자동 해소.

### 2.4 모션(duration/easing) 편차 요약

| 값                              | 사용처                                             | 용도                                       | 판정                      |
| ------------------------------- | -------------------------------------------------- | ------------------------------------------ | ------------------------- |
| `120ms`                         | 포커스 링 · 축소 모션 fallback                   | 짧은 UI 상태 전이                           | 공용 스케일 — 표준화 OK  |
| `160ms`                         | 완료 플래시(emerald 테두리) · F4 배너 이탈         | "긍정 이벤트 순간" 플래시                    | 공용 스케일 — 표준화 OK  |
| `180ms`                         | Toast enter · FallbackReadonlyBanner exit          | 진입·이탈의 중간 빠르기                      | 공용 스케일 — 표준화 OK  |
| `220ms`                         | SharedGoalModal enter · FallbackReadonlyBanner enter · MediaAsset 행 확장 | 모달·배너 진입                      | 공용 스케일 — 표준화 OK  |
| `300ms` · `400ms`                | ProjectManagement 일부 `transition-all`            | 카드 hover · 장식                            | 🔴 공용 스케일 밖         |
| `animate-pulse` (기본 2s)        | SharedGoalForm 미저장 배지 · 기타 pulse             | 긴급 알림                                    | 🟡 UX U10 제거 권장        |

**제안**: `--motion-duration-xs/-sm/-md/-lg = 120/160/180/220ms` 로 모션 스케일 토큰을 정식
도입(§3.3 참조). `transition-all 300ms` 류는 전부 이 네 개 중 하나로 흡수.

### 2.5 간격(spacing) 편차

프로젝트는 Tailwind v4 기반이라 spacing 은 주로 클래스(`gap-2`, `p-4` 등) 로 표현된다. 리터럴 px 이
섞인 지점만 편차로 본다:

| 위치                                      | 리터럴                      | 판정                              |
| ----------------------------------------- | --------------------------- | --------------------------------- |
| `ToastProvider` stack-gap                 | `--toast-stack-gap: 8px`     | ✅ 토큰                            |
| `SharedGoalModal` footer paddingBottom    | `24px` (인라인 style)        | 🟡 토큰 승격 여지(희박)            |
| `MediaAttachmentPanel` 시안 타일 gap       | `--media-attach-tile-min-width` 등 토큰 | ✅ 토큰                    |
| `ProjectManagement` card internal gap      | Tailwind `gap-3` (12px)     | ✅ Tailwind 스케일                 |
| `AuthGate` LoginForm 필드 간격            | Tailwind `mt-4` (16px)      | ✅ Tailwind 스케일                 |

간격 축은 현 상태 전반 양호. 🔴 편차 없음.

---

## 3. src/index.css 토큰 계층 재편 제안 (V-02 ~ V-06, V-08)

현재 `src/index.css` 는 **434 개** 커스텀 속성을 포함한다. 그룹별 개수:

| 접두어 그룹                     | 개수 | 카테고리 성격                                        |
| ------------------------------- | ---- | ---------------------------------------------------- |
| `--token-fallback-*`            | 44   | 구독 토큰 폴백 4단계                                 |
| `--shared-goal-*` (+ `-modal-*`) | 43   | 공동 목표(인라인 폼 · 모달)                          |
| `--token-usage-*`               | 42   | 상단바 토큰 사용량 위젯                             |
| `--media-attach-*`              | 40   | 첨부 업로드 패널                                    |
| `--media-preview-*`             | 33   | 결과 프리뷰 카드                                    |
| `--task-commit-*`               | 31   | 태스크 경계 커밋                                    |
| `--git-*` (log/stage/alert)     | 46   | Git 자동화                                          |
| `--focus-ring-*`                | 20   | 포커스 링                                            |
| `--empty-state-*` / `--error-state-*` / `--toast-*` | 46 | 공용 상태 3종                         |
| `--agent-state-*`               | 11   | 에이전트 상태 배지                                   |
| `--pixel-*` (베이스)             | 6    | 기반 팔레트                                          |
| 기타 (`--branch-*` · `--graph-reset-*` · `--project-settings-*`) | 32 | 소규모 군집                          |

### 3.1 권장 계층 구조 — 5 레이어

현 구조는 **기능별 군집(수직)** 만 있다. 출시 품질을 위해 **시각 축별 단일 진원(수평)** 을 추가로
얹는 방향을 제안한다. 기존 토큰은 유지하고, **alias 토큰** 만 신규 추가해 점진 이행.

#### L1 · 색상 베이스 (`--color-*`)

기존 `--pixel-*` 을 유지하되 의미 alias 추가:

```css
--color-cyan-info: var(--pixel-accent);          /* = #00d2ff */
--color-cyan-focus: #7fd4ff;                     /* = --shared-goal-modal-field-focus · --token-usage-axis-input-fg */
--color-emerald-confirm: #34d399;                /* = --shared-goal-modal-confirm-bg · --shared-goal-border-saved */
--color-amber-editing: #fbbf24;                  /* = --shared-goal-border-editing · --shared-goal-modal-field-editing-border */
--color-red-error: #f87171;                      /* = --error-state-strip · --shared-goal-modal-error-strip */
--color-violet-video: #6d28d9;                   /* = --media-attach-kind-video-bg */
--color-sky-progress: #60a5fa;                   /* = --media-attach-gauge-fill-generating · --token-usage-axis-cache-create-fg */
```

**이익**: 새 시안이 색 숫자를 적을 때 `var(--color-emerald-confirm)` 만 참조하면 됨. 개별 기능 토큰은
이 alias 를 var() 로 가리키도록 이후 라운드에서 리팩터.

#### L2 · 타이포 스케일 (`--text-*`)

현 상태: 타이포는 Tailwind 클래스(`text-[11px] font-bold leading-relaxed`) 로 흩어져 있다. 크기 6단계로
모음 제안:

```css
--text-size-xs: 10px;      /* micro · xtiny */
--text-size-sm: 11px;      /* body (현 기본) */
--text-size-md: 12px;      /* 버튼 라벨 · 상태 배지 */
--text-size-lg: 13px;      /* EmptyState 제목 · 배너 제목 */
--text-size-xl: 14px;      /* MediaPreview 제목 · 헤더 h1 */
--text-size-2xl: 16px;     /* 모달 h1 */
--text-weight-regular: 400;
--text-weight-medium: 600;
--text-weight-bold: 700;
--text-leading-tight: 1.25;
--text-leading-relaxed: 1.55;    /* = .kr-msg 기본 */
```

**이익**: Tailwind 임의값(`text-[11px]`) 40+건이 `text-[var(--text-size-sm)]` 로 통일. 향후 전체 크기
리스케일 시 토큰 1줄 변경으로 끝남.

#### L3 · 간격 스케일 (`--space-*`)

Tailwind 의 4/8/12/16/24/32 와 정합:

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
```

현재 `--empty-state-padding: 20px 24px` · `--error-state-padding: 16px 20px` 같은 리터럴 px 을
`calc(var(--space-5) + 0) var(--space-6)` 로 치환 가능. 단 당장의 치환은 불필요 — **토큰만 선도입**.

#### L4 · 반경 스케일 (`--radius-*`)

현 산발된 4/6/8/10px 의 4 단계를 공식화:

```css
--radius-sm: 4px;        /* 버튼 · 입력 · chip */
--radius-md: 6px;        /* task-commit 타일 · 썸네일 */
--radius-lg: 8px;        /* EmptyState · ErrorState · Toast · 툴팁 */
--radius-xl: 10px;       /* 모달 · MediaAsset 카드 · GitAutomation 카드 */
```

`--empty-state-radius: 8px` → `var(--radius-lg)` 로 포인터 교체 제안.

#### L5 · 그림자 스케일 (`--shadow-*`)

3단계로 모음:

```css
--shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.35);        /* F4 배너 · 낮은 그림자 */
--shadow-md: 0 14px 36px rgba(0, 0, 0, 0.50);      /* 툴팁 · Toast */
--shadow-lg: 0 18px 48px rgba(0, 0, 0, 0.55);      /* 모달 · 재생성 확인 · 카드 */
```

`--surface-shadow-lg` alias 1 개만 추가해도 AuthGate LoginForm 의 리터럴 그림자가 토큰화된다.

#### L6 · 모션 스케일 (`--motion-*`)

```css
--motion-duration-xs: 120ms;      /* 포커스 링 · 축소 모션 fallback */
--motion-duration-sm: 160ms;      /* 완료/강등 플래시 */
--motion-duration-md: 180ms;      /* 진입·이탈 공용 */
--motion-duration-lg: 220ms;      /* 모달·배너 진입 */
--motion-easing-out: cubic-bezier(0.22, 1, 0.36, 1);   /* SharedGoalModal 과 동일 */
--motion-easing-linear: linear;
--motion-easing-in: cubic-bezier(0.32, 0, 0.67, 0);
```

### 3.2 전체 토큰 체계 블록 배치 순서 (권장)

```
:root {
  /* ── L1 색상 베이스 ───────────────────────────────── */
  --pixel-* · --color-* (alias)

  /* ── L2 타이포 스케일 ─────────────────────────────── */
  --text-size-* · --text-weight-* · --text-leading-*

  /* ── L3 간격 스케일 ───────────────────────────────── */
  --space-*

  /* ── L4 반경 스케일 ───────────────────────────────── */
  --radius-*

  /* ── L5 그림자 스케일 ─────────────────────────────── */
  --shadow-*

  /* ── L6 모션 스케일 ───────────────────────────────── */
  --motion-duration-* · --motion-easing-*

  /* ── 기능 토큰 (현 구조 유지) ─────────────────────── */
  --agent-state-*
  --shared-goal-* / --shared-goal-modal-*
  --token-usage-*
  --token-fallback-* (F1~F4 · 배너 보강)
  --empty-state-*
  --error-state-*
  --focus-ring-*
  --toast-*
  --media-attach-*
  --media-preview-*
  --task-commit-*
  --graph-reset-*
  --git-stage-* / --git-log-* / --git-alert-* / --git-automation-*
  --branch-mode-* / --branch-strategy-*
  --project-settings-*
}
```

**지금은** 기능 토큰 블록이 순서 없이 산발돼 있다. L1~L6 을 파일 상단으로 먼저 올리고, 그 뒤에
기능 토큰을 의존 그래프(단단한 것부터) 순서로 정렬하면 새 시안 작성 시 "어디에 끼워 넣는가" 가
자명해진다.

### 3.3 중복·미사용 토큰 정리 후보

#### 3.3.1 중복(=같은 값을 다른 이름으로)

아래 쌍들은 숫자가 동일하다. alias 토큰 도입 이후 하나를 주정의·나머지를 `var()` 로 돌려 **이중
정의 리스크** 를 제거:

| 대표 값                | 동값 토큰들                                                                                     | 제안                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `#34d399` (emerald)   | `--shared-goal-modal-confirm-bg` · `--shared-goal-border-saved` · `--toast-success-strip` · `--media-attach-tile-border-done` · `--media-attach-gauge-fill-done` · `--token-fallback-recover-flash-color` · `--task-commit-event-glyph-fg` · `--media-preview-complete-flash-color` · `--focus-ring-color-success` | 주정의 1개(`--color-emerald-confirm`) 나머지 `var()` |
| `#f87171` (red)       | `--error-state-strip` · `--shared-goal-modal-error-strip` · `--shared-goal-priority-p1` · `--toast-error-strip` · `--toast-error-icon-fg` · `--media-attach-tile-border-error` · `--media-attach-gauge-fill-error` · `--media-attach-video-cancel-hover-fg` · `--focus-ring-color-danger` · `--token-usage-warning-border` · `--token-fallback-warning-border`/`-strip`/`-icon` | 주정의 1개(`--color-red-error`) 나머지 `var()` |
| `#fbbf24` (amber)     | `--shared-goal-border-editing` · `--shared-goal-modal-field-editing-border`/`-strip` · `--shared-goal-priority-p2` · `--toast-warning-strip`/`-icon-fg` · `--token-usage-caution-border`/`-icon` · `--token-usage-axis-output-fg` · `--token-fallback-caution-border`/`-strip`/`-icon` · `--media-attach-dropzone-border-reject` · `--graph-reset-icon` · `--graph-reset-border-hover` · `--focus-ring-color-caution` | 주정의 1개(`--color-amber-editing`) 나머지 `var()` |
| `#7fd4ff` (cyan)      | `--shared-goal-modal-field-focus` · `--shared-goal-priority-p3` · `--token-usage-axis-input-fg` · `--toast-info-strip`/`-icon-fg` · `--media-attach-tile-border-active` · `--media-attach-dropzone-border-active` · `--media-attach-gauge-fill` · `--task-commit-icon-fg`/`-radio-dot-fg`/`-tile-border-hover`/`-selected` | 주정의 1개(`--color-cyan-focus`) 나머지 `var()` |
| `rgba(255,255,255,0.18)` | `--shared-goal-modal-field-border` · `--media-attach-tile-border` (+ `--task-commit-tile-border` via var) | 주정의 1개 · 나머지 참조 (이미 일부는 var 로 연결됨) |
| `1.6s` (pulse)        | `--token-usage-warning-pulse-duration` · `--token-fallback-warning-pulse-duration`               | 주정의 1개 · 나머지 var() — "경고 pulse 주기" 단일     |
| `160ms` (플래시)       | `--media-preview-complete-flash-ms` · `--token-fallback-recover-flash-ms` · `--task-commit-queued-resolve-flash-ms` | 주정의 `--motion-duration-sm` · 나머지 var()        |

#### 3.3.2 사용 처 확인 필요(잠재 미사용 후보)

다음 토큰은 파일 내 **참조가 현재 발견되지 않는다**. 출시 전 grep 으로 최종 확인 후 제거:

| 토큰                                     | 근거(현 상태)                                      |
| ---------------------------------------- | ---------------------------------------------- |
| `--agent-state-resuming-glow`            | `--agent-state-resuming-border` 와 동일 값 · glow는 애니메이션에만 필요하나 현재 애니메이션 규약 미구현 |
| `--toast-z-index-error`                  | 토스트 variant='error' 전용 z-index 지정이 실제 구현에는 안 걸려 있음(공용 z 사용 중) |
| `--focus-ring-width-thick`                | 아직 참조처 없음. "모달 포커스 두꺼움" 변이는 미구현 |
| `--focus-ring-halo-success`              | success halo 경로가 현재 컴포넌트에서 소비되지 않음 |
| `--graph-reset-border-active`            | 정의만 존재, 실제 클릭 시 색 변경 없음            |
| `--toast-safe-bottom`                    | 하단 앵커 variant 를 아직 구현하지 않아 미소비    |

**원칙**: 미사용 여부는 **grep 1회** 로 확인 가능하므로 제거는 출시 직전 단일 정리 PR 로 묶어 실행.
본 문서는 후보만 기록.

#### 3.3.3 제거 권장 안 되는 유사 토큰

아래는 값이 비슷해 "중복처럼 보이지만" 의미가 달라 유지 필요:

| 토큰 A                              | 토큰 B                              | 유지 이유                                           |
| ----------------------------------- | ----------------------------------- | --------------------------------------------------- |
| `--shared-goal-modal-shadow`        | `--media-preview-card-shadow`       | 모달(최상위)은 큰 그림자, 카드는 중간 그림자 의미 구분 |
| `--media-attach-tile-bg`            | `--task-commit-tile-bg-selected`    | 전자는 썸네일 영역, 후자는 선택 상태 — 의미 분리     |
| `--token-fallback-readonly-strip`   | `--token-fallback-readonly-border`  | strip 은 좌측 4px 실선, border 는 3줄 테두리 — 분리 |

---

## 4. 다크/라이트 모드 + 축소 모션 회귀 체크 포인트 (V-07 · V-08)

### 4.1 다크/라이트 대응 현 상태

프로젝트 기본은 **다크 테마 고정**. `prefers-color-scheme` 쿼리는 `--focus-ring-*-on-light` 의 8
토큰에만 선도입돼 있고 **실제 CSS 규칙으로 이어지지는 않았다**. 즉 현재는 **라이트 테마 대응 불완전**.

| 화면/토큰 군                 | 라이트 대응                                       | 판정   |
| --------------------------- | ------------------------------------------------- | :----: |
| `--focus-ring-*`            | `--focus-ring-color-on-light` · `-success-on-light` · `-danger-on-light` · `-caution-on-light` 4종 선도입 | 🟡 토큰만 |
| `--pixel-*` (베이스)        | 대응 없음                                           | 🔴     |
| `--shared-goal-modal-*`     | 대응 없음(backdrop 은 어두운 층위 가정)              | 🔴     |
| `--token-usage-*`           | 대응 없음(tooltip bg = pixel-card 고정)              | 🔴     |
| `--empty-state-*` / `--error-state-*` | 대응 없음                                  | 🔴     |
| `--toast-*`                 | 대응 없음(bg 가 짙은 색 리터럴)                       | 🔴     |
| `--media-*`                 | 대응 없음                                           | 🔴     |

**결론**: 출시 타깃이 "다크 전용" 이라면 본 축의 🔴 는 **전체 허용(wontfix) 로 문서화** 하고 토큰에서
`-on-light` 변이를 확장하지 않는다. 반대로 "라이트 제공" 을 출시 범위에 포함한다면, 아래 §4.3 의
신규 토큰 집합 도입이 필요하다.

현 시점 권장: **다크 전용 출시**. 라이트 대응은 출시 후 별도 릴리스로 이관.

### 4.2 라이트 모드 선 도입용 신규 토큰 초안 (후속 릴리스용)

```css
@media (prefers-color-scheme: light) {
  :root {
    --pixel-bg: #f4f4f8;
    --pixel-card: #ffffff;
    --pixel-border: #cfd6e4;
    --pixel-accent: #0284c7;            /* 기존 on-light 값과 일치 */
    --pixel-text: #ba1e3f;
    --pixel-white: #0f172a;              /* 반전 */
    --shared-goal-modal-backdrop: rgba(10, 10, 25, 0.35);
    --shared-goal-modal-surface: #ffffff;
    --shared-goal-modal-surface-border: rgba(2, 132, 199, 0.35);
    --shared-goal-modal-header-fg: #0f172a;
    --shared-goal-modal-subtle-fg: rgba(15, 23, 42, 0.65);
    --shared-goal-modal-field-border: rgba(15, 23, 42, 0.18);
    --shared-goal-modal-confirm-bg: #059669;
    --shared-goal-modal-confirm-fg: #ffffff;
    /* … 기능 토큰도 같은 원리로 대응 */
  }
}
```

**현 시점 작성 불필요** — 출시 범위 확정 후. 본 초안은 향후 작업의 **출발점** 으로만 기록.

### 4.3 축소 모션 가드 화면별 체크

| 화면                         | 애니메이션 유무                                | 가드 유무                              | 판정 |
| --------------------------- | ---------------------------------------------- | -------------------------------------- | :--: |
| `App.tsx`                   | `animate-spin` 초기 로드 스피너                 | 없음                                   | 🔴   |
| `AuthGate.tsx`              | 거의 없음                                       | — (해당 없음)                          | ✅   |
| `ProjectManagement.tsx`     | `animate-spin` 3곳 · `transition-all` 카드 hover · pulse 일부 | 카드 hover 가드 없음(UX U01 연동)    | 🟡   |
| `DirectivePrompt.tsx`       | 드롭존 transition · 첨부 shimmer 시안               | `useReducedMotion` 훅 사용 ✅            | ✅   |
| `CollabTimeline.tsx`        | blocked 행 pulse                               | `useReducedMotion` ✅                   | ✅   |
| `LogPanelTabs.tsx`          | 없음                                            | — (해당 없음)                          | ✅   |
| `SharedGoalModal.tsx`       | 진입·이탈·shake·focus ring                      | `useReducedMotion` + @media reduce ✅   | ✅   |
| `ClaudeTokenUsage.tsx`      | 시안상 F3 pulse(미구현) · 현재 UI 변화 없음        | 가드 준비됨                            | ✅   |
| `TokenUsageSettingsPanel.tsx` | 없음                                          | — (해당 없음)                          | ✅   |
| 공용 `EmptyState` loading   | Loader2 `animate-spin` · `useReducedMotion` 훅으로 toggle | ✅                                    | ✅   |
| 공용 `ErrorState`           | 없음                                            | — (해당 없음)                          | ✅   |
| 공용 `ToastProvider` 진입/이탈 | CSS transition 180/140ms                        | 🟡 현재 컴포넌트 차원 훅 미적용 · @media reduce 로만 | 🟡   |

**편차**:
- 🔴 App.tsx 초기 스피너는 `animate-spin` 가드 없음. 접근성 체크리스트에 없는 신규 결함. 단순 수정:
  EmptyState variant="loading" 로 치환하면 해결.
- 🟡 ProjectManagement 는 UX 단순화 T1/T2 적용 시 해소.
- 🟡 ToastProvider 진입 애니메이션은 CSS 기반 → `@media (prefers-reduced-motion: reduce)` 절 추가
  권장.

### 4.4 회귀 방지 체크 포인트 (화면별 · QA 복사용)

#### 4.4.1 공용 축 (전 화면 공통)

- [ ] `:root` 의 L1~L6 스케일 토큰이 정의돼 있다(§3.1).
- [ ] 같은 값이 다른 이름으로 하드코딩된 쌍이 `--color-*`·`--motion-*` alias 를 거쳐 단일 진원을 갖는다.
- [ ] `prefers-reduced-motion: reduce` 환경에서 모든 shimmer·shake·pulse 가 즉시 멈추거나 정적 대체된다.
- [ ] AA 4.5:1 본문 대비가 현재·라이트 도입 후(후속) 양쪽에서 유지된다.

#### 4.4.2 화면별

- **App.tsx**: 초기 로드 스피너가 `<EmptyState variant="loading">` 로 치환됐다. 미선택 상태가
  `<EmptyProjectPlaceholder>` (내부에 EmptyState 사용) 로 렌더.
- **AuthGate.tsx**: bootError 가 `<ErrorState>` 로 렌더. LoginForm 카드 그림자가 `--shadow-lg` 토큰.
  입력 radius 가 `--radius-sm` (4px).
- **ProjectManagement.tsx**: 선택 카드 강조가 ring 1 + bg 1 의 2중 시각(UX U04 적용 후). 카드 hover
  의 translate/transition-all 제거(U01). 검색 테두리 cyan 전환 제거(U05). 새로고침 버튼은 축별
  1곳.
- **DirectivePrompt.tsx**: 드롭존 `role="button" tabIndex={0}` 제거(U08). 업로드 진행 시 상단에
  `role="status"` 1줄 요약(U14).
- **CollabTimeline.tsx**: 빈 상태 EmptyState 사용 유지. blocked 행 pulse 가드 유지. task-commit
  행(시안 §2) 이 구현되면 ◈/◇ 글리프가 기존 ○◔●⊘ 와 겹치지 않는다.
- **LogPanelTabs.tsx**: 탭 포커스 링이 `--focus-ring-*` 토큰 경로로만 표현. 임의 `ring-*` Tailwind
  클래스 없음.
- **SharedGoalModal.tsx**: 모달 radius `--radius-xl` (10px) · 내부 필드 radius `--radius-sm` (4px
  로 조정 권장, 현재 3px 에서 1px 편차). 진입 220ms · 이탈 160ms 고정.
- **ClaudeTokenUsage.tsx**: 빈 상태 카피 + `data-empty="true"` 유지. severity 별 글자색 동적 적용
  검증(직전 라운드 교정). F3 pulse 가드 구현 시 `useReducedMotion`.
- **TokenUsageSettingsPanel.tsx**: 저장 버튼 emerald 팔레트(`--shared-goal-modal-confirm-*`) 유지.
  저장 실패 배너 `role="alert"`.
- **FallbackReadonlyBanner** (신규 예정): 진입 translate 가 `prefers-reduced-motion: reduce` 에서
  opacity 120ms 로만 남는다(토큰 덮어쓰기 테스트 §6.4 에서 이미 잠금).

---

## 5. 액션 아이템 정리 (출시 블로커 · 비블로커 구분)

### 5.1 🔴 출시 블로커 (다음 PR 에 반드시)

| ID   | 화면/축                    | 조치                                                                           | 선행 의존                 |
| ---- | -------------------------- | ------------------------------------------------------------------------------ | ------------------------- |
| B1   | App.tsx 초기 스피너         | `<EmptyState variant="loading" title="앱을 불러오는 중…">` 치환                   | 없음                       |
| B2   | AuthGate.tsx bootError      | `<ErrorState onRetry={() => setReloadKey(r=>r+1)} title="앱 초기화에 실패했습니다" description={bootError}/>` | 없음 (접근성 A1 동일 항목) |
| B3   | index.css L1~L6 alias 선도입 | 색 5색·모션 4단계·반경 4단계·그림자 3단계 alias 토큰 블록만 파일 상단에 삽입(기존 값 변경 없음) | 없음                       |
| B4   | AuthGate LoginForm 그림자    | 리터럴 `0 10px 30px rgba(0,0,0,0.4)` → `var(--shadow-md)` (B3 선행)              | B3                         |

### 5.2 🟡 비블로커 (출시 후 첫 스프린트)

| ID   | 화면/축                    | 조치                                                      |
| ---- | -------------------------- | --------------------------------------------------------- |
| N1   | ClaudeTokenUsage F3 pulse   | 시안의 `--token-fallback-warning-pulse-duration` 을 실제 구현에 반영 + reduced-motion 가드 |
| N2   | ToastProvider 진입 애니메이션 | `@media (prefers-reduced-motion: reduce)` 절 추가(현재 토큰 override 만 있음) |
| N3   | 중복 색 토큰 7쌍(§3.3.1)     | alias 1개로 수렴, 기존 토큰 `var()` 포인팅으로 전환        |
| N4   | 미사용 토큰 6종(§3.3.2)      | grep 최종 확인 후 제거                                    |
| N5   | SharedGoalModal 내부 필드 radius | `3px` → `4px` 로 승격(편차 1px)                           |

### 5.3 🟢 관찰 (다음 릴리스)

| ID   | 축                         | 이유                                                                          |
| ---- | -------------------------- | ----------------------------------------------------------------------------- |
| O1   | 라이트 테마                | §4.2 초안이 있으나 출시 범위 확정 후. `-on-light` 변이 확장 + `@media` 규칙 정식화 |
| O2   | 한국어 타이포 스케일       | `.kr-msg` 전용 `--text-size-kr-*` 변이 — 지금은 공용 스케일로 충분            |
| O3   | ProjectManagement UX U12   | red 채도 과포화 문제(UX U12) 는 색 토큰 계층 재편 이후 자연 해소 가능성        |

---

## 6. 결론 · 출시 체크

본 검수 기준 **출시 블로커 4건**(B1~B4) 만 해결되면 **시각 일관성은 출시 품질** 에 도달한다.
블로커 4건의 공통 특징:

1. **공용 컴포넌트(EmptyState/ErrorState) 경로 재사용** — B1·B2.
2. **토큰 계층 alias 추가** (기존 값·컴포넌트 불변) — B3·B4.

두 축은 독립적이라 병렬 PR 가능. 각 PR 의 diff 는 30줄 이하. 기존 회귀 테스트(`authGateAccessibility`
· `emptyErrorState` · `responsiveLayout`) 로 직접 커버된다.

🟡/🟢 항목은 총 **8건** 이며, 모두 출시 후 첫 스프린트 ~ 릴리스 범위에서 처리해도 사용자 가치에 영향
없다. 특히 라이트 테마(§4.2)는 본 프로젝트가 "다크 전용" 을 공식 선언한다면 **영구 wontfix** 로
분류 가능.

---

## 7. 부록 — 검수 대상 숫자 통계

- 현 `src/index.css` 라인 수: **5428 라인**
- `:root` 내 커스텀 속성 개수: **434 개**
- 기능 토큰 군집 수: **16 개** (agent-state · shared-goal · shared-goal-modal · token-usage · token-
  fallback · empty-state · error-state · focus-ring · toast · media-attach · media-preview · task-
  commit · graph-reset · git-stage/log/alert/automation · branch-mode/strategy · project-settings)
- 제안 alias 신규 토큰: **33 개** (L1 색상 7 · L2 타이포 10 · L3 간격 7 · L4 반경 4 · L5 그림자 3 ·
  L6 모션 6). 기존 토큰은 건드리지 않음.
- 중복 색 쌍(§3.3.1): **4 색** (emerald · red · amber · cyan) × 평균 9 개 토큰/색 = 36 지점.
- 잠재 미사용 토큰: **6 개** (최종 grep 후 확정).
- 공용 상태 컴포넌트 실제 import 파일: **5 개** (EmptyState) · **1 개** (ErrorState) · **2 개** (useToast).

본 문서는 구현 코드 변경 없음. 검수 결과와 토큰 재편 제안만을 포함한다.
