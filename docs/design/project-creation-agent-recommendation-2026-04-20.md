---
date: 2026-04-20
owner: Designer (LLMTycoon)
trigger-directive: "지시 #38ead312 — 신규 프로젝트 생성 플로우 · 에이전트 추천 UI/UX"
prior-context:
  - src/types.ts (AgentRole = 'Leader' | 'Developer' | 'QA' | 'Designer' | 'Researcher')
  - src/types/codeConvention.ts (우선 검토 파일 — 추천 카드 하단 기본 컨벤션 프리셋과 연결)
  - src/components/EmptyProjectPlaceholder.tsx (신규 프로젝트 진입점 — 본 시안의 상위 버튼)
  - src/components/SharedGoalModal.tsx · src/i18n/sharedGoalModal.ko.ts (모달 · 카피 번역 분리 선례)
  - src/styles/tokens.css (의미 토큰 기준값)
  - docs/design/design-system-consistency-round2.md (카드 · 간격 · 라운드 · 포커스 기준)
  - docs/design/skills-mcp-settings-spec.md (탭 · 카드 · 마스킹 패턴 선례)
report-to: QA (6940336c-c26d-46cb-9054-f4803030c898)
scope: "신규 프로젝트 생성 모달의 3단계(설명 → 추천 → 추가) 정보 구조 · 추천 카드 레이아웃 · EN/KO 토글 위치 · 추천 근거 한/영 카피 테이블"
---

# 신규 프로젝트 생성 — 에이전트 추천 UI/UX (2026-04-20)

본 시안은 `EmptyProjectPlaceholder` 의 `[새 프로젝트 시작]` 버튼이 여는 **신규 프로젝트 생성 모달** 의 3단계 화면을 고정한다. 사용자가 1줄 설명만 쓰면 시스템이 5 역할(`Leader · Developer · QA · Designer · Researcher`, `src/types.ts:2`) 중 **이 프로젝트에 맞는 3–4명 추천 + 근거** 를 카드로 제시하고, **단일 [바로 추가] 버튼** 으로 팀 구성을 확정한다. 기존 `SharedGoalModal` 의 카피 분리 관례(`src/i18n/sharedGoalModal.ko.ts`) 를 그대로 따르되 **EN 리소스를 병기** 해 언어 토글 축을 이 모달에서부터 심는다.

Figma 소스는 없으므로 본 시안은 **현행 토큰 시스템(`src/styles/tokens.css`)** 을 기준 언어로 한다. Figma 파일이 도입되면 §4 토큰 매핑 표가 그대로 Figma Variables 로 이식된다.

---

## 0. 설계 원칙 (P-01 ~ P-10)

| ID   | 원칙 |
| ---- | ---- |
| P-01 | **3단계를 2화면으로 압축**: 설명 입력(Step 1) + 추천 결과(Step 2) + 추가 확정(Step 3) 을 **한 모달 안에서 스크롤 없이** 완결한다. 추천은 Step 1 입력 후 `onBlur` + debounce 600ms 로 실시간 갱신되어 Step 2 가 이미 보인 상태로 Step 3 로 넘어간다. 별도 페이지 이동 금지. |
| P-02 | **추천 = "카드 세트 전체가 1 선택지"**: 개별 역할 체크박스가 아니라 **팀 조합(예: Dev+QA+Designer) 카드 묶음** 을 하나의 선택지로 제시한다. 사용자는 기본 추천을 그대로 받거나(= [바로 추가]), 묶음 내 개별 카드에서 *엇나가는 1명만 빼고 추가* 가 가능. |
| P-03 | **근거 텍스트는 카드당 1문장 ≤ 60자**: "왜 이 역할인가" 를 1줄로. 길면 카드가 무거워져 카드 3장 동시 비교가 안 된다. 상세는 툴팁(`title`) + 카드 확장(↓). |
| P-04 | **[바로 추가] 는 primary 단 하나**: 모달 footer 의 primary 버튼은 "팀 추가하고 시작" 하나로 고정. 사용자가 카드를 수정하면 버튼 레이블이 `"선택 3명 추가"` 로 카운트 반영. 저장 경로 2개 금지. |
| P-05 | **언어 토글은 헤더 우측, 닫기 버튼 왼쪽**: 헤더 내 `[🌐 한국어 ▾]` 드롭다운. 전역 설정을 건드리지 않고 **본 모달 세션 한정** 으로 언어를 바꾼다(영속은 사용자 설정 페이지에서만). 본 토글이 모달 밖 앱 전역까지 바꾸면 회귀 위험 — §3.4 명시. |
| P-06 | **추천 근거는 기계적으로 환원 가능한 문구**: "설명에 '프론트엔드' 가 있어 Designer 추천" 처럼 입력 키워드 → 역할 매핑을 드러낸다. 블랙박스 문구("AI 가 추천함") 금지 — 신뢰 · 검증 가능성 확보. |
| P-07 | **0건 빈 상태와 1건 부족 상태 분리**: 설명이 너무 짧으면 "설명을 30자 이상 써주세요"(빈 상태), 분석은 됐지만 명확한 역할이 1개뿐이면 "**리더 외 역할이 약해요 — 설명에 '테스트' 나 '디자인' 을 추가해 보세요**"(부족 상태). 기본 추천(Leader+Developer) 은 항상 포함해 **빈 화면이 절대 나오지 않도록**. |
| P-08 | **키보드만으로 완결**: 설명 입력(Tab) → 카드 포커스(Tab 또는 ↓) → 카드 토글(Space) → 언어 토글(Shift+L) → primary(Enter) → 취소(Esc). SharedGoalModal 의 `dirty 가드` 관례 그대로. |
| P-09 | **추천 가능 최대 = 4, 최소 = 2**: 리더 1 + 실무 1–3 = 총 2–4. 5명 이상은 "첫 팀" 에 과도. 추후 프로젝트 설정에서 추가. |
| P-10 | **추가 후 곧바로 공동 목표 모달로 체이닝**: 팀이 비었을 때만 나오는 `SharedGoalModal` 과 순차 체인. 본 모달이 완료되면 `onAgentsAdded` → 상위가 `SharedGoalModal` 을 자동 오픈. 사용자에게 "다음 할 일 찾기" 부담을 지우지 않는다. |

---

## 1. 정보 구조 — 3단계 1화면

```
┌────────────── NewProjectAgentModal (단일 모달, 폭 560px, 동적 높이 최대 88vh) ──────────────┐
│                                                                                             │
│  ╔═ Header (48px 고정) ═════════════════════════════════════════════════════════════════╗   │
│  ║ 🚀 새 프로젝트 시작                               [🌐 한국어 ▾]  [✕ 닫기]           ║   │
│  ║                                                       ↑ P-05                         ║   │
│  ╚══════════════════════════════════════════════════════════════════════════════════════╝   │
│                                                                                             │
│  ╔═ Step 1 · 프로젝트 설명 입력 (높이 160px) ═══════════════════════════════════════════╗   │
│  ║ 프로젝트를 한 문장으로 설명해 주세요.                                               ║   │
│  ║ ┌─────────────────────────────────────────────────────────────────────────────────┐ ║   │
│  ║ │ 예: 사내 일정 공유 웹앱을 만들고 접근성 감사까지 한 번에 끝내고 싶어요.         │ ║   │
│  ║ │                                                                       128/400   │ ║   │
│  ║ └─────────────────────────────────────────────────────────────────────────────────┘ ║   │
│  ║ 💡 30자 이상 써주면 추천 정확도가 올라갑니다.    [감지된 키워드: 웹 · 접근성 · 감사] ║   │
│  ╚══════════════════════════════════════════════════════════════════════════════════════╝   │
│                                                                                             │
│  ╔═ Step 2 · 추천 팀 (debounce 600ms 후 렌더 · 스켈레톤 3장 → 실제 카드) ══════════════╗   │
│  ║ 추천 팀 3명 · 근거는 카드를 누르면 상세 확장                                         ║   │
│  ║                                                                                      ║   │
│  ║ ┌── RoleCard (192×120) ──┐  ┌── RoleCard ──┐  ┌── RoleCard ──┐                      ║   │
│  ║ │ 👑 리더                 │  │ 🛠 개발자    │  │ ♿ 디자이너  │                      ║   │
│  ║ │ 팀 분배·진행 관리        │  │ 웹앱 구현     │  │ 접근성 감사   │                      ║   │
│  ║ │ 근거: 기본 팀 구성        │  │ "웹앱" 키워드 │  │ "접근성" 키워드│                      ║   │
│  ║ │ [✓ 포함]  [—]            │  │ [✓ 포함] [—] │  │ [✓ 포함] [—] │                      ║   │
│  ║ └─────────────────────────┘  └──────────────┘  └──────────────┘                      ║   │
│  ║                                                                                      ║   │
│  ║ ┌── 더 제안(선택) ─────────────────────────────────────────────────────────────┐    ║   │
│  ║ │ [ + QA (감사 로그 · 회귀 방지) ]    [ + Researcher (외부 사례 조사) ]         │    ║   │
│  ║ └───────────────────────────────────────────────────────────────────────────────┘    ║   │
│  ╚══════════════════════════════════════════════════════════════════════════════════════╝   │
│                                                                                             │
│  ╔═ Footer (56px 고정) ═════════════════════════════════════════════════════════════════╗   │
│  ║ 💡 추가 후 바로 '공동 목표 등록' 이 이어집니다 (P-10).        [취소]  [팀 3명 추가] ║   │
│  ║                                                                       ↑ primary    ║   │
│  ╚══════════════════════════════════════════════════════════════════════════════════════╝   │
│                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Step 상태 기계

```
  [empty]
     │  입력 시작(1자 이상)
     ▼
  [typing]  ── debounce 600ms ──▶  [analyzing]
     ▲                                  │
     │ 지우기                             │ 분석 완료
     │                                  ▼
     └───────────────  [recommended]  ◀─┐
                          │ 카드 조작    │ 입력 재개
                          ▼              │
                       [edited] ────────┘
                          │ [팀 N명 추가]
                          ▼
                       [creating]  →  [done] → onAgentsAdded → (SharedGoalModal 체인)
                          │ 실패
                          ▼
                       [error]  → 재시도 버튼 (기본 팀으로 복귀 옵션 동반)
```

- 상태 `empty` 에서는 Step 2 카드 자리에 **플레이스홀더("설명을 적으면 이곳에 팀이 나타납니다")** 가 보인다 — 빈 네거티브 공간 금지(P-07).
- `analyzing` 은 카드 3장 스켈레톤만 200–600ms 노출. 너무 짧게 끝나면(<150ms) 스켈레톤 자체를 생략해 깜빡임 방지.

---

## 2. 카드 · 토큰 · 타이포

### 2.1 RoleCard 레이아웃

```
┌ 192 × 120 ────────────────────────────┐   ← padding: var(--space-lg) = 16px
│ [icon 24]   역할명(14·bold)            │     gap: var(--space-sm) = 8px
│                                        │     bg: var(--color-surface-elevated)
│ 한 줄 요약(12·regular, muted)           │     border: 1px var(--color-border)
│                                        │     radius: var(--radius-md) = 4px
│ 근거: … 1문장(11·subtle, ≤ 60자)        │
│                                        │
│ [✓ 포함]   [— 제외]                    │   ← primary(accent) / ghost
└────────────────────────────────────────┘
```

- 상태별 테두리:
  - 포함(기본): `1px solid var(--color-accent)` + 배경 `var(--color-surface-elevated)`
  - 제외: `1px dashed var(--color-border)` + 배경 `transparent` + 라벨 `var(--color-text-subtle)`
  - 호버: `box-shadow: var(--media-preview-card-shadow)` 재사용(일관성, `design-system-consistency-round2.md` §1.3)
  - 포커스: `outline: var(--focus-ring-width) solid var(--color-focus-ring)` + `outline-offset: var(--focus-ring-offset)`

### 2.2 토큰 매핑

| 영역                          | 속성               | 토큰                                    | 값   |
| ----------------------------- | ------------------ | --------------------------------------- | ---- |
| 모달 본체                      | 배경               | `var(--color-surface)`                  | —    |
|                               | 라운드              | `var(--radius-lg)`                      | 8px  |
|                               | 그림자              | `var(--token-usage-tooltip-shadow)` 재사용 | —    |
| Step 간 수직 간격              | —                   | `var(--space-lg)`                        | 16px |
| 카드 그리드 gap                | —                   | `var(--space-md)`                        | 12px |
| 추천 근거 텍스트 색             | color               | `var(--color-text-subtle)`               | —    |
| 감지 키워드 pill                | 배경/글자           | `var(--color-info-surface)` / `var(--color-info)` | —    |
| primary 버튼(팀 N명 추가)       | 배경/글자           | `var(--color-accent)` / `var(--color-accent-contrast)` | —    |
| "더 제안" chip                   | 라운드               | `var(--radius-sm)` (2px)                 | —    |
| 스켈레톤 pulse                   | animation-duration   | `var(--motion-duration-lg)` (360ms)       | —    |

> 새 토큰은 만들지 않는다 — 현행 `tokens.css` 의 의미 토큰만 재사용(라운드 2 §1 일관성).

### 2.3 타이포 · 간격 규칙

- 모달 제목 16·bold(`--font-size-xl` + `--font-weight-bold`)
- Step 제목 13·bold(`--font-size-md`)
- 카드 역할명 14·bold(`--font-size-lg`), 요약 12(`--font-size-sm`), 근거 11(`--font-size-xs`)
- textarea 은 4행 고정, `resize: vertical` 금지(레이아웃 깨짐 방지)

---

## 3. 언어 토글 (EN/KO)

### 3.1 위치 · 동작

- **위치**: 모달 헤더 우측, 닫기(✕) 버튼 **왼쪽**. 드롭다운 형태: `[🌐 한국어 ▾]` / `[🌐 English ▾]`.
- **범위**: 본 모달 세션 한정. 닫으면 다음 오픈 시 앱 전역 언어로 복귀.
- **동기화**: 앱 전역 언어가 존재하면 그것이 초기값. 사용자가 본 모달에서 토글해도 **전역 상태 변경 금지**(P-05). 전역 영속은 사용자 설정 페이지의 전용 토글에서.
- **단축키**: `Shift+L` — 모달이 열려 있을 때만 토글. 스크린리더에 "언어를 영어로 전환했습니다" / "한국어로 전환했습니다" 알림(`aria-live="polite"`).

### 3.2 드롭다운 상호작용

```
 [🌐 한국어 ▾]    클릭/Enter/Space      ┌───────────────┐
                                          │ ✓ 한국어       │  ← 현재 선택에 check
                                          │   English      │
                                          └───────────────┘
                                          ↑ 위/아래 화살표 순회
                                          Esc 로 닫기(포커스 원복)
```

- 드롭다운 자체 폭 120px 고정, 헤더 높이 안에 수직 중앙 정렬.
- 모바일 대응: 폭 < 480px 에서는 아이콘만(`🌐`) 보이고 텍스트는 숨김(`aria-label` 로 대체).

### 3.3 리소스 파일 배치

```
src/i18n/
  sharedGoalModal.ko.ts              ← 기존
  newProjectAgentModal.ko.ts         ← 신규(Thanos 구현 시 생성)
  newProjectAgentModal.en.ts         ← 신규
  index.ts                            ← 신규 허브. useModalCopy('newProjectAgentModal') 훅 제공
```

- `ko` / `en` 파일은 **같은 키 스키마** 를 가져 런타임 스위치가 값만 바꾸도록. `sharedGoalModalKo` 의 `as const` 관례 계승.
- 누락 키가 한쪽에 있으면 TypeScript 타입 에러가 나도록 `type Copy = typeof ko` 로 고정, `en: Copy` 타이핑.

### 3.4 언어 토글이 건드리지 않는 것 — 회귀 경계

- 모달 외부(상단바·좌측 패널·프로젝트 목록 등) 의 텍스트
- 저장된 프로젝트 설명 본문(사용자가 쓴 문장은 그대로 저장 — 번역 금지)
- 에이전트 이름(`Leader/Developer/...`) 자체는 타입 식별자 — 다국어는 **라벨** 에만.

---

## 4. 추천 엔진 — 결정론적 규칙

P-06 을 충족하기 위해 LLM 블랙박스 추천이 아니라 **설명 키워드 → 역할 가중치** 의 단순 룰 엔진을 1차 기준으로 둔다. LLM 확장은 후속 PR 에서 `ResearchAdapter` 를 경유.

### 4.1 키워드 → 역할 가중치 매트릭스

| 카테고리        | 키워드(한/영 · 소문자 매칭)                                       | Leader | Developer | QA | Designer | Researcher |
| --------------- | ----------------------------------------------------------------- | :----: | :-------: | :-: | :------: | :--------: |
| 기본(항상)      | —                                                                   | **+3** | +1        | 0  | 0        | 0          |
| 웹/앱 구현       | 웹, web, 앱, app, 프론트, front, 모바일, mobile                      | 0      | **+3**    | 0  | +1       | 0          |
| 백엔드/데이터   | api, 서버, backend, 데이터, db, database, 파이프라인, pipeline        | 0      | **+3**    | +1 | 0        | 0          |
| 테스트/품질     | 테스트, test, qa, 감사, audit, 회귀, regression, 자동화, e2e          | 0      | 0         | **+3** | 0   | 0          |
| 디자인/접근성   | 디자인, design, ui, ux, 접근성, accessibility, 시안, prototype        | 0      | 0         | 0  | **+3**   | 0          |
| 조사/벤치마크   | 조사, research, 벤치마크, benchmark, 사례, case, 논문, paper           | 0      | 0         | 0  | 0        | **+3**     |

- 점수 상위 3개 역할을 기본 포함. Leader 는 **점수와 무관하게 항상 포함**(팀 리더 없는 프로젝트 금지, P-09).
- 설명 < 30자이면 `[Leader, Developer]` 2명 고정 추천(P-07 부족 상태).

### 4.2 근거 문구 생성 규칙

1. **기본 팀 문구**: 매치 키워드 없이 추천된 역할(Leader · 설명 짧을 때의 Developer) 은 "기본 팀 구성" / "Default core team".
2. **키워드 매치 문구**: "\"<키워드>\" 키워드를 기반으로 추천" / "Recommended from \"<keyword>\" keyword".
3. **복수 키워드 매치**: 가장 높은 점수의 키워드 1개만 표기. 전체 매치는 카드 확장에서 리스트.

> 근거 문구는 **입력 그대로의 키워드** 를 따옴표로 감싸 보여 신뢰를 확보(P-06).

---

## 5. 카피 테이블 — 한국어 / English

본 테이블은 §3.3 의 리소스 파일 2종이 공유할 **키-값 쌍** 이다.

### 5.1 헤더 · 플레이스홀더 · 힌트

| 키                              | 한국어                                                      | English                                                         |
| ------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| `header.title`                   | 새 프로젝트 시작                                             | Start a new project                                              |
| `header.languageToggleAria`      | 언어 전환                                                    | Switch language                                                  |
| `header.closeAria`               | 닫기                                                         | Close                                                            |
| `step1.label`                    | 프로젝트를 한 문장으로 설명해 주세요.                         | Describe your project in one sentence.                           |
| `step1.placeholder`              | 예: 사내 일정 공유 웹앱을 만들고 접근성 감사까지 한 번에 끝내고 싶어요. | e.g., Build an internal scheduling web app and finish an accessibility audit in one go. |
| `step1.hint`                     | 💡 30자 이상 써주면 추천 정확도가 올라갑니다.                   | 💡 30+ characters improves recommendation accuracy.                |
| `step1.keywordsLabel`            | 감지된 키워드                                                 | Detected keywords                                                |
| `step1.counter`                  | `{current}/{max}`                                           | `{current}/{max}`                                                |

### 5.2 Step 2 — 카드 · 근거 템플릿

| 키                              | 한국어                                           | English                                                |
| ------------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| `step2.heading`                  | 추천 팀 {count}명 · 카드를 눌러 상세 보기           | Recommended team of {count} · Click a card for details |
| `step2.role.Leader`              | 리더                                              | Leader                                                 |
| `step2.role.Developer`           | 개발자                                            | Developer                                              |
| `step2.role.QA`                  | QA 엔지니어                                       | QA engineer                                            |
| `step2.role.Designer`            | 디자이너                                          | Designer                                               |
| `step2.role.Researcher`          | 리서처                                            | Researcher                                             |
| `step2.summary.Leader`           | 팀 분배·진행 관리                                   | Task dispatch & progress                               |
| `step2.summary.Developer`        | 구현·기술 선택                                      | Implementation & tech choices                          |
| `step2.summary.QA`               | 테스트·회귀 감시                                    | Testing & regression watch                             |
| `step2.summary.Designer`         | UI/UX·접근성                                        | UI/UX & accessibility                                  |
| `step2.summary.Researcher`       | 외부 사례·자료 조사                                  | External cases & research                              |
| `step2.rationale.default`        | 기본 팀 구성                                       | Default core team                                      |
| `step2.rationale.keyword`        | "{keyword}" 키워드를 기반으로 추천                    | Recommended from the "{keyword}" keyword               |
| `step2.rationale.shortInput`     | 설명이 짧아 기본 추천만 보여드려요                    | Description is short — showing the default recommendation only |
| `step2.actions.include`          | ✓ 포함                                             | ✓ Include                                              |
| `step2.actions.exclude`          | 제외                                               | Exclude                                                |
| `step2.moreSuggestionsLabel`     | 더 제안(선택)                                       | More suggestions (optional)                            |

### 5.3 Footer · 상태 · 오류

| 키                              | 한국어                                                    | English                                                    |
| ------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| `footer.hint`                    | 💡 추가 후 바로 '공동 목표 등록' 이 이어집니다.              | 💡 Shared goal registration starts right after adding.        |
| `footer.cancel`                  | 취소                                                       | Cancel                                                     |
| `footer.confirm`                 | 팀 {count}명 추가                                           | Add {count} agents                                         |
| `footer.confirmCreating`         | 추가 중…                                                    | Adding…                                                    |
| `states.empty`                   | 설명을 적으면 이곳에 팀이 나타납니다.                       | Your team appears here once you type a description.         |
| `states.analyzing`               | 추천 중…                                                    | Analyzing…                                                 |
| `states.shortInputHint`          | 리더 외 역할이 약해요 — 설명에 '테스트' 나 '디자인' 을 추가해 보세요. | Roles besides Leader are weak — try adding "test" or "design" to the description. |
| `errors.addFailed`               | 에이전트 추가 중 오류가 발생했습니다. 다시 시도하세요.      | Could not add agents. Please try again.                    |
| `errors.networkOffline`          | 오프라인입니다. 연결이 돌아오면 자동으로 재시도합니다.      | You are offline. Retrying automatically when reconnected.   |
| `dirtyClose`                     | 작성 중인 설명이 있습니다. 닫으면 사라집니다. 닫을까요?       | You have unsaved description text. Close anyway?             |

---

## 6. 접근성 · 키보드 · 스크린리더

| 요구                                | 구현                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 모달 열림                            | `role="dialog"` + `aria-modal="true"` + `aria-labelledby=header.title`                                    |
| 포커스 시작점                        | 설명 textarea (자동 포커스 + 커서 끝 배치)                                                                 |
| 포커스 트랩                          | 모달 내부만 Tab 순환. 최소 첫/마지막 요소: 언어 토글 / primary 버튼                                       |
| Esc                                   | 내용 없으면 즉시 닫기. 내용 있으면 `dirtyClose` 확인 다이얼로그(SharedGoalModal 선례)                     |
| 추천 상태 변경 알림                  | `aria-live="polite"` 영역에 "추천 3명 준비됨" / "Recommendation ready: 3 agents" (언어별)                 |
| 카드 포함/제외 토글                  | `role="switch"` + `aria-checked` + `aria-describedby=rationale-<role>`                                    |
| 언어 변경 알림                       | `aria-live="polite"` · "언어를 영어로 전환했습니다" 등 §3.1 카피                                         |
| 색상 대비                            | 근거 텍스트 `--color-text-subtle` 는 WCAG AA 본문 3:1 미달 가능 → 폰트 11px + bold false 이므로 **최소 4.5:1 보장 토큰 쓰도록 추후 `--color-text-rationale` 신설 가능**(본 시안은 기존 토큰 재사용, 추가 고려 사항 §7.1) |

---

## 7. 후속 · 위험 · 결정 대기

### 7.1 색 대비 추가 토큰 — 신설 검토 대상

- `--color-text-subtle` (rgba(..., 0.56)) 는 다크 배경에서 본문 3:1 정도. 근거 문구 11px 에 쓰면 AA 미달 가능성.
- 제안: `--color-text-rationale = rgba(244, 244, 251, 0.72)` (text-muted 재사용) — 본 시안 1차는 재사용, 후속 대비 테스트 후 신설 여부 결정.
- QA 에 **WebAIM Contrast Checker 로 실측** 을 요청(§R-1).

### 7.2 전역 언어 토글과의 통합 경로

- 본 모달 토글은 세션 한정. 사용자 설정 페이지에 동일 컨트롤(전역 · 영속) 이 존재해야 모달 토글이 "왜 저장 안 되는지" 설명이 된다.
- 후속 PR: `src/views/settings/LanguagePreference.tsx` 신설. 본 시안 범위 밖이지만 **같은 드롭다운 컴포넌트** 를 공유하도록 구조 예약.

### 7.3 추천 LLM 확장 경로

- 현재 §4 룰은 결정론적. LLM 기반 보강이 필요해지면 `src/services/multimedia/ResearchAdapter` 의 `Summarizer` 축에 `recommendAgents(description)` 를 추가해 룰 + LLM 점수를 평균한다.
- UI 변경은 **근거 문구 생성 로직만** — 카드 모양 · 토큰 · 토글 축은 그대로.

### 7.4 결정 대기

| ID  | 질문                                                                  | 대기 대상 |
| --- | --------------------------------------------------------------------- | --------- |
| R-1 | 근거 텍스트 `--color-text-subtle` 대비 실측 — 신규 토큰 필요 여부      | QA        |
| R-2 | "더 제안" 섹션의 최대 노출 역할 수(현재 2개 — 3개로 올려도 과밀하지 않나) | QA · Kai   |
| R-3 | `Shift+L` 단축키가 브라우저/IME 와 충돌하는지 검증                        | QA        |
| R-4 | 분석 debounce 600ms 적정성(너무 느림? 300ms?)                             | QA 사용성 테스트 |

---

## 8. 컴포넌트 트리(참고, 구현 지침)

```
NewProjectAgentModal                 (신규 · src/components/NewProjectAgentModal.tsx)
├─ ModalShell                        (기존 모달 컨테이너 재사용 — SharedGoalModal 패턴 계승)
├─ Header
│  ├─ Title                          ("새 프로젝트 시작" / "Start a new project")
│  ├─ LanguageToggle                  (신규 · 드롭다운 컴포넌트, 재사용 가능하게 export)
│  └─ CloseButton
├─ DescriptionInput                   (textarea + 카운터 + 힌트 + 키워드 pill)
├─ RecommendationList                 (상태 분기: empty / analyzing / recommended / error)
│  ├─ RoleCard × N
│  └─ MoreSuggestions                 (chip 버튼 × ≤3)
├─ Footer
│  ├─ Hint
│  ├─ CancelButton
│  └─ PrimaryButton                   (레이블 동적: "팀 N명 추가" / "Add N agents")
└─ CopyResource                        (훅: useModalCopy('newProjectAgentModal'))
```

- 새 파일: `NewProjectAgentModal.tsx`, `LanguageToggle.tsx`, `useRecommendTeam.ts`(룰 엔진), `newProjectAgentModal.ko.ts` · `.en.ts`.
- 재사용: 모달 컨테이너 · 포커스 트랩 훅 · 토큰. 새 토큰 추가는 §7.1 QA 결과에 따라 분리 PR.

---

## 부록 A — ASCII 상태 3종 비교

```
상태: empty
┌ Step 2 ────────────────────────────────────────┐
│   (🪄 설명을 적으면 이곳에 팀이 나타납니다.)      │
│                                                 │
└─────────────────────────────────────────────────┘

상태: analyzing
┌ Step 2 ────────────────────────────────────────┐
│ ░░░░░░░░░░░░░   ░░░░░░░░░░░░░   ░░░░░░░░░░░░░  │  ← 스켈레톤 3장, pulse
│ ░░░░░░░░░░░░░   ░░░░░░░░░░░░░   ░░░░░░░░░░░░░  │
└─────────────────────────────────────────────────┘

상태: recommended
┌ Step 2 ────────────────────────────────────────┐
│ [👑 리더 · 기본 팀 구성]                        │
│ [🛠 개발자 · "웹앱" 키워드]                      │
│ [♿ 디자이너 · "접근성" 키워드]                   │
│ 더 제안: [+ QA] [+ Researcher]                  │
└─────────────────────────────────────────────────┘
```

---

끝.
