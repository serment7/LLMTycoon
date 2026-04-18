# BranchStrategySection · Git 브랜치 전략 UI 시안 (2026-04-18)

대상 섹션: `src/components/ProjectSettingsPanel.tsx` 의 "Git 자동화" 블록 하위
보조 통합처: `src/components/GitAutomationPanel.tsx` 의 `branchPattern` 단일 필드를 본 전략 선택 UI 로 교체
참조 훅: `src/utils/useProjectOptions.ts` · `settingsJson.branchStrategy` 경로에 저장
참조 스키마: `src/utils/projectOptions.ts` — `settingsJson` 객체 내부에 그대로 내려감
시안 이미지: `tests/branch-strategy-mockup.svg` (4 전략 전환 · 조건부 입력 · 미리보기)
디자인 토큰: `src/index.css` 의 `--branch-strategy-*` 계열 (신규 추가)

## 1. 재설계 배경

현재 `GitAutomationPanel` 은 `branchPattern` 을 **단일 자유 입력**(`{type}/{ticket}-{branch}`) 으로만
제공한다. 실제 운영에서는 팀마다 브랜치 라이프사이클이 크게 다른데 자유 입력은 다음 문제를 만든다.

- **실수 빈도**: 변수명 오타(`{tiket}`)·슬래시 누락으로 브랜치 생성 실패 후 재작성.
- **전략의 의미 손실**: "매 커밋마다 새 브랜치" vs "고정 브랜치 재사용" 같은 근본 선택이 패턴 뒤에 숨어, 팀원이 현재 전략을 한눈에 파악하기 어렵다.
- **병합 정책 누락**: 고정 브랜치 재사용은 `main` 자동 병합 여부와 짝을 이루는데 지금 UI 는 그 짝을 표현하지 못한다.

이번 시안은 **4 전략 라디오 + 전략별 조건부 입력 + 실시간 브랜치명 미리보기** 로 재구성한다.

## 2. 4 전략 정의

| 키(`branchStrategy.kind`) | 이름 | 한 줄 설명 | 권장 상황 |
|-----|------|-----------|----------|
| `per-commit` | 매 커밋마다 새 브랜치 | 커밋 1개 = 브랜치 1개. 리뷰 입자를 최소화. | 작은 변경을 잦은 PR 로 배포하는 트렁크 기반 개발 |
| `per-task` | 태스크별 브랜치 | 리더가 분배한 태스크 1개 = 브랜치 1개. | SharedGoal 하위 서브태스크가 명확한 프로젝트 |
| `per-session` | 세션별 단일 브랜치 | 에이전트 세션 1회 = 브랜치 1개. **현 기본값**. | 4명이 같은 세션에서 협업해 통합 커밋을 만드는 리더 단일 브랜치 정책 |
| `fixed` | 고정 브랜치 재사용 | 지정한 브랜치 1개에 계속 커밋. | 개인 샌드박스 / 데모 환경 / `develop` 통합 |

### 상호 배타 규칙

- 4개 중 정확히 하나 선택. 기본값은 `per-session` (리더 단일 브랜치 정책과 일치).
- 전략 변경 시 진행 중인 자동화가 있으면 확인 모달 — "다음 세션부터 적용됩니다" 공지.

## 3. 레이아웃

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 🌿 브랜치 전략                                         [● 저장됨 · 방금 전]│
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ◯ 매 커밋마다 새 브랜치  ⓘ  커밋 1개 = 브랜치 1개. 트렁크 기반 개발에 적합 │
│    └─ 표시: 전략 카드 회색 테두리 (미선택)                                │
│                                                                          │
│  ◉ 태스크별 브랜치       ⓘ  리더 분배 1개 = 브랜치 1개. 서브태스크 선명   │
│    └─ 전략 카드 accent 테두리 · 펼친 영역(아래 조건부 입력)              │
│    ┌────────────────────────────────────────────────────────────────┐   │
│    │ 브랜치명 패턴  [ auto/{ticket}-{slug}-{date}                 ]  │   │
│    │ 변수 칩: {ticket} {slug} {date} {sha6} {agent} {session}        │   │
│    │ 미리보기 ▸  auto/LT-142-payment-security-2026-04-18             │   │
│    └────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ◯ 세션별 단일 브랜치    ⓘ  현 기본값 — 리더 단일 브랜치 정책             │
│                                                                          │
│  ◯ 고정 브랜치 재사용    ⓘ  지정 브랜치 1개에 계속 커밋                    │
│                                                                          │
│                             ※ 선택 시 카드만 펼쳐지고, 나머지는 축약 표시 │
└──────────────────────────────────────────────────────────────────────────┘
```

## 4. 전략별 조건부 입력

### 4.1 `per-commit` — 매 커밋마다 새 브랜치

| 필드 | 기본값 | 제약 |
|------|-------|------|
| `pattern` (브랜치명 패턴) | `auto/{date}-{sha6}` | 필수 · `{sha6}` 포함 강제 (고유성 보장) |
| 변수 칩 | `{date}` `{sha6}` `{agent}` `{type}` | — |
| 미리보기 예 | `auto/2026-04-18-3fa9b2` | — |

- 검증: `{sha6}` 없이 저장 시도 시 red 인라인 오류 "고유성을 보장할 변수가 필요합니다 (`{sha6}` 또는 `{timestamp}`)".
- main 자동 병합 체크박스: 기본 **비활성 숨김** (커밋 단위 병합은 팀 권한에 따라 GitAutomation 의 flow=full-pr 로 대체 권장).

### 4.2 `per-task` — 태스크별 브랜치

| 필드 | 기본값 | 제약 |
|------|-------|------|
| `pattern` | `auto/{ticket}-{slug}` | 필수 · `{ticket}` 또는 `{slug}` 중 하나 포함 |
| 변수 칩 | `{ticket}` `{slug}` `{date}` `{sha6}` `{agent}` | — |
| 미리보기 | `auto/LT-142-payment-security` | — |

- 티켓이 없을 때의 폴백: `{ticket}` → `NO-TICKET`, `{slug}` → 제목 slugify 결과.
- main 자동 병합 체크박스: 선택 가능 (기본 OFF) · 선택 시 "PR merge 성공 후 브랜치 삭제" 토글 노출.

### 4.3 `per-session` — 세션별 단일 브랜치 (현 기본값)

| 필드 | 기본값 | 제약 |
|------|-------|------|
| `pattern` | `auto/{date}-session-{session6}` | 필수 · `{session6}` 포함 권장 |
| 변수 칩 | `{date}` `{session6}` `{type}` `{agent}` | `{agent}` 는 비권장 배지(리더 단일 브랜치 정책) |
| 미리보기 | `auto/2026-04-18-session-a7b3c9` | — |

- `{agent}` 를 선택하면 amber 경고 인라인: "리더 단일 브랜치 정책과 상충 — 세션이 분기될 수 있음".
- main 자동 병합 체크박스: 기본 **OFF** · 세션 종료 훅(`completionWatcher.ts`)에서 단일 PR 로 승격하는 경로는 별도 설정.

### 4.4 `fixed` — 고정 브랜치 재사용

| 필드 | 기본값 | 제약 |
|------|-------|------|
| `fixedBranch` (고정 브랜치명) | `llm-sandbox` | 필수 · 공백 금지 · `main`/`master` 입력 시 red 경고 |
| `autoMergeMain` (main 자동 병합) | `false` | 체크 시 하위 "병합 주기" 드롭다운 활성 |
| `mergeCadence` | `off` | `off` / `daily` / `on-green-ci` |

- 미리보기: `llm-sandbox` (고정이므로 변수 없이 그대로).
- **위험 카피**: `main` 또는 `master` 를 고정 브랜치로 지정하면 "⚠ 프로덕션 브랜치를 직접 수정하는 구성입니다. 강력히 비권장" 배너 + [그래도 사용] 버튼(2초 홀드).
- `autoMergeMain=true` 시 "병합 주기" 드롭다운이 나타남. `on-green-ci` 선택 시 CI 상태 폴링 쿼리 주의사항 툴팁.

## 5. 변수 칩 스펙

- 입력 필드 아래 행으로 배치 · 클릭 시 캐럿 위치에 해당 토큰 삽입.
- 각 칩은 `title` 속성에 치환 예시 포함.
- 색상: 필수 변수(`{sha6}`/`{ticket}`) 는 amber 테두리로 강조, 나머지는 mute.

| 변수 | 설명 | 치환 예 |
|------|------|---------|
| `{date}` | YYYY-MM-DD | `2026-04-18` |
| `{sha6}` | 커밋 SHA 앞 6자 | `3fa9b2` |
| `{session6}` | 세션 ID 앞 6자 | `a7b3c9` |
| `{ticket}` | 공동 목표 · 서브태스크 티켓 ID | `LT-142` |
| `{slug}` | 태스크 제목 slugify | `payment-security` |
| `{agent}` | 에이전트 이름 | `joker` |
| `{type}` | 변경 유형(feat/fix/chore) | `feat` |
| `{timestamp}` | UNIX epoch(10자) | `1745942400` |

## 6. 브랜치명 실시간 미리보기

- 위치: 각 전략 카드의 조건부 입력 섹션 최하단.
- 포맷: `미리보기 ▸  {실제 결과}` · monospace + emerald 강조.
- 디바운스: 150ms (입력 중 번쩍임 억제).
- 실패 시: red 배지 "치환 불가 — 필수 변수 누락" + 어떤 변수가 비었는지 나열.
- 샘플 컨텍스트: 우상단 `[샘플 컨텍스트 ▼]` 버튼으로 예시 태스크·세션·에이전트를 전환해 여러 경우를 즉시 검증.

## 7. 저장 경로 (useProjectOptions 통합)

```ts
settingsJson.branchStrategy = {
  kind: 'per-task' | 'per-commit' | 'per-session' | 'fixed',
  pattern?: string,          // kind !== 'fixed'
  fixedBranch?: string,      // kind === 'fixed'
  autoMergeMain?: boolean,   // kind === 'fixed' | 'per-task'
  mergeCadence?: 'off' | 'daily' | 'on-green-ci',
}
```

- PATCH 페이로드: `{ settingsJson: { branchStrategy: { ... } } }` 로 `useProjectOptions.update()` 호출.
- 서버 `projectOptions.ts` 는 `settingsJson` 을 객체로만 검증하므로 본 스키마는 **클라이언트 측 가드** 로 방어:
  - `kind` 열거형 체크
  - `kind='fixed'` 면 `fixedBranch` 필수
  - 그 외 `pattern` 필수 + 고유성 변수 포함 여부
- 실패 시 `ProjectSettingsPanel` 의 `saveStatus='error'` 배지로 상승.

## 8. 마이크로카피 (각 전략 옆 ⓘ 툴팁)

1. **매 커밋마다 새 브랜치**
   "트렁크 기반 개발 팀에 권장. 커밋 1개를 곧바로 작은 PR 로 만들고 싶을 때 사용합니다. 고유성 변수(`{sha6}`) 가 포함되어야 합니다."
2. **태스크별 브랜치**
   "리더가 분배하는 서브태스크가 뚜렷한 프로젝트에 권장. 한 태스크 안에서 여러 커밋이 누적되며 태스크 종료 시 PR 로 승격하기 좋습니다."
3. **세션별 단일 브랜치**
   "현 기본값. 4명의 에이전트가 같은 세션에서 협업해 한 브랜치에 통합 커밋을 쌓는 리더 단일 브랜치 정책과 일치합니다."
4. **고정 브랜치 재사용**
   "개인 샌드박스·데모 환경·`develop` 통합 등 특정 브랜치에 계속 커밋하는 경우. `main`/`master` 고정은 강력히 비권장합니다."

## 9. 상호작용 상세

- 라디오 그룹 `role="radiogroup"` + 방향키 순환 + Home/End 로 처음·끝 이동.
- 선택 변경 애니메이션: 카드 높이 180ms ease-out · 펼쳐질 때 하위 입력 focus 자동 이동(첫 필드).
- 전략 변경으로 기존 `pattern` 이 무의미해지는 경우(예: `per-commit` → `fixed`), 이전 값은 서버에는 유지하되 UI 에서는 숨긴다(다시 전환 시 복원).
- 저장 버튼: ProjectSettingsPanel 헤더의 `saveStatus` 에 편입 — 본 섹션 단독 저장 버튼은 두지 않음.

## 10. 저장 상태 피드백

- 전략 카드 헤더 우측에 `project-settings-status` 재사용 (idle/saving/error/dirty).
- 미리보기 줄의 "▸" 기호는 현재 저장 상태 색상을 따른다(emerald/sky/red/amber).
- 네트워크 오류 시 [재시도] 버튼을 미리보기 줄 우측에 inline 제공.

## 11. 접근성 (a11y)

- 라디오 그룹: `role="radiogroup"` + `aria-labelledby="branch-strategy-heading"`.
- 각 라디오: `role="radio"` + `aria-checked` · 설명은 `aria-describedby="strategy-{kind}-desc"`.
- 변수 칩: `role="button"` + `aria-label="{변수명} 변수 삽입"` · Enter/Space 삽입.
- 미리보기: `role="status"` + `aria-live="polite"` · 전략 전환·변수 변경 시 낭독.
- 경고 배너(`main` 고정 등): `role="alert"` + 2초 홀드 버튼은 `aria-describedby` 로 의미 전달.
- 색각 이상: 필수 변수 amber, 경고 red 는 각각 별(★) · 경고(⚠) 아이콘 병기.

## 12. 색상 토큰 (index.css 신규 `--branch-strategy-*`)

| 토큰 | 값 | 용도 |
|------|----|------|
| `--branch-strategy-card-idle-border` | `rgba(255,255,255,0.18)` | 미선택 카드 테두리 |
| `--branch-strategy-card-active-border` | `#00d4ff` | 선택 카드 accent 테두리 |
| `--branch-strategy-card-active-bg` | `rgba(0,210,255,0.08)` | 선택 카드 배경 |
| `--branch-strategy-chip-bg` | `rgba(255,255,255,0.06)` | 변수 칩 기본 |
| `--branch-strategy-chip-required` | `#fbbf24` | 필수 변수 amber 테두리 |
| `--branch-strategy-preview-fg` | `#34d399` | 미리보기 emerald 텍스트 |
| `--branch-strategy-preview-error` | `#f87171` | 치환 불가 red |
| `--branch-strategy-danger-banner` | `rgba(248,113,113,0.12)` | `main` 고정 경고 배너 |

## 13. 구현 시 주의

- 전략 전환 시 진행 중 자동화(`AgentStatusPanel` 의 `working` 상태) 가 있으면 확인 모달 → "다음 세션부터 반영" 문구 강제.
- `branchPattern` 단일 필드(기존 `GitAutomationPanel`) 는 **이 전략의 결과물** 로 취급. 본 시안이 결정한 `kind`/`pattern` 에서 서버 포맷(`branchTemplate`) 으로 직렬화되며, `per-session` 의 기본 pattern 이 현재 `{type}/{ticket}-{branch}` 와 일치한다.
- slugify: 한글 → 로마자 변환은 과감하게 생략(서버에서 처리하지 않음), 대신 공백·특수문자는 `-` 로 치환하고 최대 32자 잘라냄.
- `{sha6}` 은 브랜치 생성 시점에는 미상이므로 서버 측 브랜치 생성 훅에서 post-hoc 치환. 미리보기는 **고정 더미 sha** 로 표시하고 "실제 값은 커밋 후 결정" 툴팁 표기.

## 14. 후속 단계 (Joker 인계용)

1. `src/utils/branchStrategy.ts` 신규 — `renderBranchName(kind, pattern, ctx)` 순수 함수 + 단위 테스트 8 케이스(전략 × 필수 변수 누락).
2. `src/components/BranchStrategySection.tsx` 신규 — 라디오 카드 + 조건부 입력 + 변수 칩 + 미리보기.
3. `GitAutomationPanel.tsx` 에서 기존 `branchPattern` 자유 입력을 본 섹션으로 교체 · `settings.branchStrategy` 로 일원화.
4. 서버: `settingsJson.branchStrategy` 의 kind 열거형을 추가 검증(현 `projectOptions.ts` 는 객체만 확인).
5. 회귀 테스트 문서: `tests/branch-strategy-regression.md` — 전략 4종 × 저장·전환·경고 케이스.
