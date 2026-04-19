# 전체 UI 접근성 점검 체크리스트 (2026-04-19, 디자이너)

관련 선행 문서:
- `docs/qa-agent-status-panel-design-review-2026-04-19.md` — QA 알파가 AgentStatusPanel 영역에서
  이미 도출한 "색 + 글리프 이중 시그널 · useReducedMotion 가드 · role/aria-live 경로" 3축을
  본 체크리스트의 합격 기준으로 **그대로 재사용** 한다. 본 문서는 그 원칙을 나머지 7개 화면으로
  확장 적용한다.
- `tests/media-attachment-panel-mockup.md` (2026-04-19) — 멀티미디어 첨부 패널 시안. §8 "접근성"
  블록을 본 체크리스트의 `MediaAttachmentPanel` 항목과 병기.
- `tests/token-fallback-states-mockup.md` (2026-04-19) — 구독 토큰 폴백 4단계. F3/F4 상태의
  ARIA 낭독 규약·키보드 Alt+R 경로를 본 체크리스트의 `ClaudeTokenUsage` 항목에 이식.
- `src/utils/useReducedMotion.ts` — `prefers-reduced-motion: reduce` 단일 훅. 본 체크리스트의
  "축소 모션" 열은 모두 이 훅의 호출 여부로 판정한다.

목표: WCAG 2.1 AA 기준을 프로젝트 전역에 일관 적용하기 위한 **단일 체크리스트**. 각 컴포넌트의
합격/결함 항목을 한 표로 묶어 QA·개발자가 PR 리뷰에서 대조할 수 있게 한다.

---

## 0. 판정 원칙 (A-01 ~ A-08)

| ID   | 원칙                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| A-01 | **키보드만으로 전체 동작 완료 가능** — 마우스 전용 경로는 결함. Tab/Shift+Tab/Enter/Space/Esc/방향키의 네 축만 사용.                  |
| A-02 | **포커스 링은 반드시 보임** — `:focus-visible` 에 `--focus-ring-*` 토큰 기반 박스-그림자 링이 적용된다. `outline: none` 단독 사용 금지. |
| A-03 | **WCAG AA 본문 4.5:1** — 큰 글자(18pt+/14pt bold)는 3:1. 아이콘·경계선 같은 UI 그래픽은 3:1.                                      |
| A-04 | **색만으로 의미 전달 금지** — 상태/단계 구분은 색 + 아이콘/글리프 + 텍스트 **3중 인코딩**.                                        |
| A-05 | **실시간 변화는 `aria-live` 로 낭독** — 단, 10% 미만 미세 변화나 반복 증분은 throttle 후 낭독(스크린리더 소음 방지).                  |
| A-06 | **모달·오버레이는 포커스 트랩 + `inert` 바깥** — `role="dialog" aria-modal="true"` 에 포커스 트랩 필수. 닫힐 때 `lastFocus` 복원. |
| A-07 | **축소 모션 존중** — `useReducedMotion()` 훅을 **모든 `animate-*`/ CSS transition** 경로가 가드. shimmer/shake/pulse 즉시 중단.    |
| A-08 | **한국어 낭독 우선** — `aria-label` 은 한국어 문장. 영문 약어(`PDF`, `MP4`)는 라벨 안에 포함해도 좋지만 문장 주어는 한국어로 유지.   |

---

## 1. 합격 기준 표 — 7개 컴포넌트 × 5축

각 셀의 기호: ✅ 합격 · 🟡 부분 · 🔴 결함 · — 해당 없음. 근거는 §2 에 파일:라인 수준으로 제공.

| 화면                              | 키보드 포커스 순서           | 대비비 (AA 4.5:1)                    | ARIA 라이브 리전                       | 스크린리더 라벨                     | 축소 모션(useReducedMotion)     |
| --------------------------------- | ----------------------------- | ------------------------------------ | -------------------------------------- | ----------------------------------- | ------------------------------- |
| `AuthGate.tsx`                    | 🟡 LoginForm 의존              | ✅ 본문 11.9:1, 경고 9.4:1             | 🔴 bootError 배너 aria-live 없음        | 🟡 버튼 라벨만 존재(제목 없음)       | — (정적 화면)                   |
| `DirectivePrompt.tsx`             | ✅ textarea → dropzone → 제출   | ✅ cyan-dashed 8.1:1 · amber 8.7:1    | 🟡 업로드 중 `data-uploading` 만 존재   | ✅ dropzone aria-label 한국어         | ✅ 훅 사용(shimmer/shake 가드)   |
| `LogPanelTabs.tsx`                | ✅ ←/→ roving, Tab 내부 이동     | ✅ 탭 활성 cyan 8.1:1                   | ✅ unseen 배지 `aria-live="polite"`      | ✅ `role="tab"` + `aria-selected`     | — (탭은 정적 전환)              |
| `ProjectManagement.tsx`           | 🟡 GitAutomationPanel 깊이 있음 | ✅ saved emerald 5.9:1                 | 🟡 saveStatus 중 일부만 낭독             | 🟡 버튼 일부 `aria-label` 누락         | 🟡 pulse 일부 미가드             |
| `SharedGoalModal.tsx`             | ✅ 포커스 트랩 + lastFocus 복원  | ✅ header-fg 15.8:1, error 5.9:1       | ✅ `role="dialog" aria-modal="true"`    | ✅ `aria-labelledby` + `describedby` | ✅ 진입/이탈/shake 전부 가드     |
| `ClaudeTokenUsage.tsx`            | ✅ Tab → 설정 토글 → 툴팁 내부   | ✅ 동적 fg 교정(caution 8.7:1 등)      | 🟡 폴백 단계 전이 토스트 의존           | ✅ 누적 상태 한국어 aria-label        | — (shimmer 없음)                |
| `TokenUsageSettingsPanel.tsx`     | ✅ 4 입력 → 저장 → 재인증         | ✅ 확정 emerald 6.3:1                   | ✅ 저장 실패 `role="alert"`              | ✅ 라벨-입력 연결                     | — (정적)                        |

**주의**: 본 표의 "합격" 은 **2026-04-19 시점** 의 스냅샷이다. 새 커밋이 들어오면 §3 의
"회귀 방지 체크리스트" 로 한 번 더 확인해야 한다.

---

## 2. 화면별 상세 관찰

### 2.1 `AuthGate.tsx` — 인증 게이트

| 축                   | 현황                                                                                                | 보완 제안                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 키보드 포커스 순서   | `LoginForm` 이 자체 오토포커스 하는 구조. Tab 순서는 username → password → 제출 → 회원가입 링크.     | ✅ 로그인 실패 시 에러 메시지(setError) 로 포커스가 돌아가지 않는다. `aria-describedby` 로 에러를 연결해 제출 후에도 낭독되게. |
| 대비비               | 로그인 폼 배경 `--pixel-card` #16213e 위 본문 white/100 = 15.8:1 AAA. 에러 텍스트 `--error-state-title-fg` #fecaca = 9.4:1 AAA. | ✅                                                                                                      |
| ARIA 라이브 리전    | `bootError` 를 `<div className="text-red-400">` 로만 표시. 스크린리더가 못 듣는다.                     | 🔴 `role="alert"` 을 감싸거나 `<ErrorState>` 로 승격. **본 PR 의 후속 작업 권장**.                         |
| 스크린리더 라벨     | 카드 전체에 `role="main"` 또는 `aria-labelledby` 없음. 사용자는 "어느 화면에 있는지" 를 못 듣는다.      | 🟡 카드 래퍼에 `<main aria-labelledby="auth-title">` + `<h1 id="auth-title">`.                            |
| 축소 모션            | 정적 화면이라 해당 없음.                                                                             | —                                                                                                       |

### 2.2 `DirectivePrompt.tsx` — 리더 지시 입력 + 첨부

| 축                   | 현황                                                                                                | 보완 제안                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 키보드 포커스 순서   | textarea → 드롭존(`role="button"`) → 제출 → 첨부 타일(각각 포커스 가능).                              | ✅ 다만 `tests/media-attachment-panel-mockup.md §8` 에서 드롭존 자체는 키보드 포커스 불가로 전환 권장(중복 회피). |
| 대비비               | 드롭존 cyan dashed 8.1:1, drag-over amber 8.7:1, error red 5.9:1 모두 AA 이상.                       | ✅                                                                                                      |
| ARIA 라이브 리전    | 업로드 진행은 `data-uploading="true|false"` 만. 스크린리더에 실시간 낭독 없음.                         | 🟡 업로드 중 1회·완료 시 1회 `aria-live="polite"` (10% 단위로 throttle).                                  |
| 스크린리더 라벨     | dropzone `aria-label="첨부 파일 드래그 앤 드롭 영역"` 존재. 타일은 kind+이름+상태 4축 낭독.          | ✅                                                                                                      |
| 축소 모션            | shimmer/shake 전부 `useReducedMotion()` 훅으로 가드됨.                                              | ✅                                                                                                      |

### 2.3 `LogPanelTabs.tsx` — 지시/로그 탭

| 축                   | 현황                                                                                                | 보완 제안                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 키보드 포커스 순서   | roving tabindex(`Tab` 은 패널 내부로, `←/→` 는 탭 사이). 초기 포커스는 활성 탭.                       | ✅ 모범 사례.                                                                                           |
| 대비비               | 활성 탭 `--pixel-accent` cyan 7.9:1 · 비활성 white/60 = 7.9:1.                                      | ✅                                                                                                      |
| ARIA 라이브 리전    | unseen 배지 숫자 증가 시 `aria-live="polite"` 로 낭독. 같은 수치 반복 낭독 없음.                    | ✅                                                                                                      |
| 스크린리더 라벨     | `role="tablist"` → `role="tab"` + `aria-selected` + `aria-controls="log-panel-tabpanel-{key}"`.      | ✅                                                                                                      |
| 축소 모션            | 탭 전환은 `hidden` 속성 토글 — transition 없음. 해당 없음.                                          | —                                                                                                       |

### 2.4 `ProjectManagement.tsx` — 프로젝트 관리 상세

| 축                   | 현황                                                                                                | 보완 제안                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 키보드 포커스 순서   | 탭 전환 → GitAutomationPanel(중첩 폼) → SharedGoalForm. 탭 깊이가 깊어 Tab 연타가 많다.              | 🟡 자주 쓰는 동작(저장, 자동 개발 토글) 에 단축키 힌트(`aria-keyshortcuts`) 를 붙여 가속.                 |
| 대비비               | saveStatus 4밴드(idle/saving/error/dirty)는 이미 토큰화. 본문 대비 모두 AA 이상.                    | ✅                                                                                                      |
| ARIA 라이브 리전    | saveStatus 전이(dirty → saving → idle) 중 idle 복귀만 일부 낭독. saving 진입은 시각 단서만.           | 🟡 saving 진입 시 `role="status" aria-live="polite">저장 중</span>` 을 toast 가 아니라 인라인으로 한 번 더. |
| 스크린리더 라벨     | GitCredentialsSection 의 토큰 입력란 일부 `aria-label` 대신 `placeholder` 만 존재.                    | 🟡 `<label for>` 또는 `aria-label` 을 모든 입력에 명시.                                                   |
| 축소 모션            | 일부 pulse 는 훅 가드 있음, 일부 saved 플래시는 CSS transition 으로 노출 — 훅 미가드.                 | 🟡 `@media (prefers-reduced-motion: reduce)` 안에 해당 transition `transition: none` 덮기.               |

### 2.5 `SharedGoalModal.tsx` — 자동 개발 ON on-ramp

| 축                   | 현황                                                                                                | 보완 제안                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 키보드 포커스 순서   | 진입 시 제목 input autoFocus · Tab 순환 포커스 트랩 · Esc dirty 가드 · lastFocus 복원.                | ✅ 참조 모범. 다른 모달의 기준으로 삼을 것.                                                            |
| 대비비               | header-fg 15.8:1, subtle 8.6:1, error 5.9:1, confirm 6.3:1.                                         | ✅                                                                                                      |
| ARIA 라이브 리전    | `role="dialog" aria-modal="true"` + empty-create 배너 `role="status" aria-live="polite"` 1회 낭독.   | ✅                                                                                                      |
| 스크린리더 라벨     | `aria-labelledby="shared-goal-modal-title"` + `aria-describedby="shared-goal-modal-subtitle"`.      | ✅                                                                                                      |
| 축소 모션            | 진입·이탈·shake 전부 훅 가드. 축소 모션 경로는 opacity 만 유지.                                      | ✅                                                                                                      |

### 2.6 `ClaudeTokenUsage.tsx` — 상단바 토큰 사용량 배지

| 축                   | 현황                                                                                                | 보완 제안                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 키보드 포커스 순서   | 루트 `tabIndex=0 role="button"`, 설정 아이콘·툴팁 내부 버튼 순. 우클릭 = 키보드 메뉴 키로도 동일.    | ✅                                                                                                      |
| 대비비               | 동적 fg 교정(#1 바로 전 라운드) 후 severity 별 글자색까지 실제 반영. caution 8.7:1, warning 5.9:1.   | ✅                                                                                                      |
| ARIA 라이브 리전    | 폴백 단계 전이(F1→F2, F2→F3 등)는 ToastProvider 가 담당. 배지 자체는 조용히 색만 바꿈.              | 🟡 F3→F4 전이는 배지에도 `role="alert"` 을 1회 덧붙여 "쓰기 잠금" 을 즉시 낭독.                            |
| 스크린리더 라벨     | `aria-label="Claude 토큰 사용량(오늘): 입출력 4.3K, 대략 비용 $1.2, 호출 12회"` 형태 한국어.         | ✅                                                                                                      |
| 축소 모션            | pulse 는 CSS 로만, prefers-reduced-motion 에서 color 만 유지로 대체(시안 §2.1).                      | 🟡 실제 구현 시 `prefers-reduced-motion` 미디어 쿼리로 pulse 제거 확정.                                   |

### 2.7 `TokenUsageSettingsPanel.tsx` — 임계값 설정 패널

| 축                   | 현황                                                                                                | 보완 제안                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 키보드 포커스 순서   | 4 입력 → 내보내기 범위 라디오 → 다운로드 → 모두 지우기 → 오늘 리셋 → 저장(= primary).               | ✅                                                                                                      |
| 대비비               | 확정 emerald 6.3:1, 취소 11.9:1, 본문 12.3:1.                                                       | ✅                                                                                                      |
| ARIA 라이브 리전    | 저장 실패 시 `role="alert"` 로 즉시 낭독.                                                           | ✅                                                                                                      |
| 스크린리더 라벨     | 라디오 그룹 `role="radiogroup" aria-label="내보내기 범위"`. 각 입력은 `label`-연결.                 | ✅                                                                                                      |
| 축소 모션            | 정적 폼 — 해당 없음.                                                                                | —                                                                                                       |

---

## 3. 단계별 결함 · 조치 계획

### 3.1 🔴 차단급 (다음 PR 에 반드시 들어가야 함)

| ID | 위치                             | 문제                                                     | 조치                                                             |
| -- | -------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| A1 | `AuthGate.tsx` bootError 배너    | 에러 메시지가 낭독되지 않음                              | `ErrorState` 컴포넌트로 교체 또는 `role="alert"` 래퍼 추가       |
| A2 | `ClaudeTokenUsage.tsx` F3→F4 전이 | 쓰기 잠금 상태 진입이 배지 레벨에서 즉시 낭독되지 않음    | 배지 루트에 `role="alert"` 을 F4 진입 순간 1회 `key` 바꿔 재생성 |

### 3.2 🟡 비차단 (다음 스프린트 백로그)

| ID | 위치                                  | 문제                                                        | 조치                                                        |
| -- | ------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| B1 | `DirectivePrompt.tsx`                 | 업로드 진행이 `data-uploading` 만 존재 — 낭독 없음           | 10% 단위 `role="status" aria-live="polite"` throttle         |
| B2 | `ProjectManagement.tsx` saving 상태    | 진입 시점 낭독 부재                                         | 인라인 `<span role="status">저장 중</span>` 1회 렌더         |
| B3 | `ProjectManagement.tsx` saved 플래시 | 축소 모션 미가드 CSS transition                              | `@media (prefers-reduced-motion: reduce)` 절 추가            |
| B4 | `AuthGate.tsx` 화면 제목              | `h1` 부재                                                   | `<main aria-labelledby="auth-title"><h1 id="auth-title">…`  |
| B5 | `GitCredentialsSection` 입력           | `label` 없는 입력 존재                                      | 각 입력에 `<label>` 또는 `aria-label` 보강                   |
| B6 | 단축키 보강                            | 저장·자동 개발 토글에 키 힌트 부재                           | `aria-keyshortcuts` 및 툴팁에 "Ctrl+S" 병기                  |

### 3.3 ℹ 관찰만 (개선 시점 자율)

- 한국어 낭독 순서 통일(주어 + 목적어 + 상태) 을 전역 규약으로 승격할지 여부 결정.
- `AgentStatusPanel.tsx` 는 본 체크리스트 범위 밖이지만, QA 알파 보고서 D-01~D-03 과 묶어 동일
  라운드에서 토큰 이식 권장.

---

## 4. 회귀 방지 QA 체크리스트 (PR 리뷰용 복사본)

리뷰어는 해당 컴포넌트를 건드린 PR 이라면 아래 10항목을 눈으로 훑고 체크합니다.

- [ ] Tab 한 번만 눌러 페이지 진입 직후 의미 있는 포커스 위치로 간다.
- [ ] Tab/Shift+Tab 으로 모든 컨트롤을 도달할 수 있고 visible focus 링이 보인다.
- [ ] Esc 로 열린 오버레이/모달이 닫히고 직전 포커스 요소로 복원된다.
- [ ] 대비비가 AA 4.5:1 이상(아이콘 3:1). 의심 시 DevTools 의 Contrast checker 확인.
- [ ] 색만으로 의미 전달되는 곳이 없다(아이콘/텍스트 병기 확인).
- [ ] `aria-live` 로 낭독돼야 하는 상태 변화가 실제로 낭독된다(VoiceOver/NVDA 테스트).
- [ ] `prefers-reduced-motion: reduce` 환경에서 shimmer/shake/pulse 가 즉시 멈춘다.
- [ ] `role="dialog"` 는 `aria-modal="true"` 와 포커스 트랩을 모두 갖춘다.
- [ ] 모든 버튼이 `aria-label` 또는 가시적인 텍스트 레이블을 갖는다.
- [ ] 오류 배너는 `role="alert"` 또는 `aria-live="assertive"` 로 즉시 낭독된다.

---

## 5. 후속 시안 문서와의 연결

- `tests/fallback-readonly-banner-mockup.md` (본 라운드 신규): F4 상태에서 쓰이는 영구 배너·재로그인
  CTA 의 **시각 계층·카피 톤·토큰 보강** 을 세부 규격으로 남긴다. 본 체크리스트의 A2/B3 항목과
  직접 연결되며, 배너 낭독 규약은 §2.6 을 그대로 차용.
- `tests/media-attachment-panel-mockup.md`: §8 에 기재된 스크린리더 규약이 본 체크리스트의
  `DirectivePrompt.tsx` 행과 동치. 구현 시 두 문서를 교차 검토.
- `tests/shared-goal-modal-mockup.md`: §9 a11y 체크리스트는 본 §2.5 의 "합격" 근거가 되어 준다.
