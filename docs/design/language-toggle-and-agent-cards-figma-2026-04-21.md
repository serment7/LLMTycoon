---
date: 2026-04-21
owner: Designer (LLMTycoon)
trigger-directive: "지시 #3f4408ef — 언어 드롭다운 + 추천 에이전트 카드 Figma 시안(src/ui/mcp 토큰 계승)"
prior-context:
  - src/llm/tokenBudget.ts (우선 검토 파일 — 세션별 토큰 예산·압축 엔진)
  - src/ui/AppShell.tsx (상단 헤더 · TokenUsageIndicator 마운트 · z-index 30)
  - src/ui/McpConnectionForm.tsx (src/ui/mcp 상응 — Tailwind 토큰 규칙 권위: `text-[10px] uppercase tracking-wider text-white/70` 라벨, `bg-black/30 border-2 px-3 py-2 text-[12px] text-white font-mono` 입력)
  - src/ui/TokenUsageIndicator.tsx (AppShell 헤더 내 유일한 기존 배지 — 언어 드롭다운과 나란히 배치)
  - src/ui/NewProjectWizard.tsx (추천 카드가 들어갈 호스트)
  - src/project/recommendAgentTeam.ts (AgentRecommendation · ROLE_CATALOG 5종)
  - src/i18n/index.ts (useLocale · setLocale · 폴백 3단)
  - locales/{en,ko}.json (locale.label · locale.en · locale.ko 키 기존 확정)
  - src/components/EmptyState.tsx · ErrorState.tsx (상태 3종 공용 템플릿)
  - docs/design/mcp-transport-and-language-toggle-2026-04-20.md (언어 토글 1차 배치 · 세그먼티드 vs 드롭다운 규약)
  - docs/design/project-creation-agent-recommendation-2026-04-20.md (추천 카드 3단 플로우 · 기본 레이아웃)
  - docs/design/recommendation-edit-and-templates-2026-04-21.md (편집 모드 확장 · Shift+D 단축키 등)
  - docs/design/cross-feature-onboarding-and-state-audit-2026-04-21.md (상태 3종 동일 규약)
report-to: QA (6940336c-c26d-46cb-9054-f4803030c898)
scope:
  - "AppShell 헤더의 EN/KO 언어 드롭다운: 텍스트 라벨 only·선택 강조·키보드 내비게이션·다크모드"
  - "프로젝트 생성 모달의 추천 에이전트 카드 리스트: role 아이콘·skills 칩·[추가]/[모두 추가] CTA 계층"
  - "추천 카드 로딩·빈·에러 3종 상태 시안"
  - "src/ui/McpConnectionForm Tailwind 토큰 체계와 1:1 일관 토큰화"
---

# 언어 드롭다운 + 추천 에이전트 카드 — Figma 시안 (2026-04-21)

본 시안은 **Figma 파일이 아직 없는 레포 현실** 을 감안해, `src/ui/McpConnectionForm.tsx` 가 확정한 **Tailwind 토큰 규칙** 을 기준 언어로 삼고 그 위에 두 UI 를 동일 규약으로 묶는다. Figma 가 도입되는 시점에 §6 토큰 매핑 표를 Variables 로 이식하면 픽셀 손실 없이 전환 가능하다.

두 UI 는 서로 다른 화면에 있지만 **같은 토큰 · 같은 포커스 링 · 같은 상태 색** 을 공유해야 한다. 토큰 불일치는 라운드 2 디자인 감사(`design-system-consistency-round2.md`)의 C-## 불일치를 되살리는 원인이므로 본 시안에서 선제 차단.

> 우선 검토 파일 `src/llm/tokenBudget.ts` 는 `shouldCompact` / `compactHistory` 두 순수 함수로 **토큰 예산 상한** 을 잠근다. 본 시안의 **§3 추천 카드 "모두 추가"** 는 대량 요청을 한 번에 발생시킬 수 있으므로, 상위 호출자가 `recordUsage` → `maybeCompact` 경로로 예산 초과를 감지하면 CTA 를 disabled + §3.5 "토큰 한도 근접" 배너로 덮는 분기를 두 번째 규약으로 둔다. 즉 UI 는 "추가" 를 속도 제한 없이 노출하지만, 엔진이 `shouldCompact` true 를 돌려주면 UX 가 그 신호를 **즉시 반영** 한다.

---

## 0. 설계 원칙 (F-01 ~ F-12)

### 0.1 공통(F-01 ~ F-03)

| ID   | 원칙 |
| ---- | ---- |
| F-01 | **`src/ui/McpConnectionForm` 토큰 체계 계승**: 라벨 `text-[10px] uppercase tracking-wider text-white/70` · 입력 `bg-black/30 border-2 px-3 py-2 text-[12px] text-white font-mono` · 에러 `text-[11px] text-red-300 role="alert"`. 본 시안의 모든 텍스트 크기 · 간격은 이 세트 안에서 선택. 새 값 도입 금지. |
| F-02 | **다크모드 기본, 라이트 분기 없음(현재 레포)**: `--color-bg` `#1a1a2e` 위 설계 고정. 라이트 테마 지원은 후속 PR. 본 시안의 rgba 는 다크 배경 대비 WCAG AA 기준으로 검증(§6.4). |
| F-03 | **국기 아이콘 금지**: 지시문 명시. 국기는 "국가 = 언어" 오해를 부를 수 있고(예: 아랍어 국기 모호성) 액세시빌리티 스크린리더가 "깃발 이모지" 로 오독한다. 텍스트 라벨(`한국어` · `English`) 만. |

### 0.2 언어 드롭다운(F-04 ~ F-07)

| ID   | 원칙 |
| ---- | ---- |
| F-04 | **헤더 우측 고정 · TokenUsageIndicator 왼쪽**: AppShell 헤더(`app-shell-header`, z-index 30) 안. 인디케이터 바로 왼쪽에 위치해 "이번 세션" 축의 보조 메타로 묶인다. 모바일(<600px)에서는 인디케이터 아래 두 번째 행으로 밀림. |
| F-05 | **버튼 + 드롭다운 패널 2 파트**: 버튼은 `[현재 언어명 ▾]` 폭 120px. 클릭 시 아래로 폭 160px 패널이 펼쳐져 옵션 리스트 노출. 현재 선택은 체크 아이콘 + bold. |
| F-06 | **`role="button"` + `aria-haspopup="listbox"` + `aria-expanded`**: WAI-ARIA APG 컴보박스 패턴 간소화 형. 전체 목록이 2개뿐이라 `role="combobox"` 까지는 과투자. 간단한 메뉴 버튼 + 리스트박스. |
| F-07 | **키보드 100%**: 버튼 포커스 · Enter/Space/ArrowDown 로 열림 · ArrowUp/Down 순회 · Enter 선택 · Esc 닫기. 열린 채로 Tab 이동 시 드롭다운 바로 닫힘. |

### 0.3 추천 카드(F-08 ~ F-12)

| ID   | 원칙 |
| ---- | ---- |
| F-08 | **카드당 4 영역**: 상단 role 아이콘·이름·역할 라벨 / 중단 rationale 1문장 / 하단 skills 칩 / 액션(포함 체크박스 · [추가] / 우상단 더보기 ⋮). 4 영역 순서 변경 금지. |
| F-09 | **CTA 계층 2단**: `[추가]` 카드당(ghost) vs `[모두 추가]` 리스트 푸터(primary · 우측 정렬). 두 버튼이 동시에 돋보이면 사용자가 결정 못함 — primary 는 `[모두 추가]` 단 하나. |
| F-10 | **skills 칩은 ≤ 4개**: 초과 시 `+N` 펠릿. 5 개 이상 노출하면 카드 높이가 무너지고 "모든 역할이 다 많은 스킬이 있다" 는 가짜 신호를 준다. 핵심 3 + 1 (여백) 이 자연 리듬. |
| F-11 | **로딩 스켈레톤 카드 3장**: 카드 수(기본 3~4) 에 맞춰. 펄스 360ms. 150ms 미만 로딩이면 스켈레톤 자체 생략(`EmptyState variant=loading` 선행 시안 §4.1 계승). |
| F-12 | **에러는 인라인 `ErrorState` · 빈 배열은 친화 `EmptyState`**: 에러 상태에 "직접 추가" 대체 경로는 선행 시안 `error-recovery-ux-2026-04-21.md` §4.2 를 본 카드 리스트 안에 이식. 본 시안은 카드 그리드 자체의 자리를 `ErrorState` 가 차지한다. |

---

## 1. 언어 드롭다운 — Figma 1페이지 등가

### 1.1 닫힘 상태(기본)

```
┌ AppShell 헤더 (높이 48px, bg: var(--color-bg), border-b: 2px var(--color-border)) ──────────┐
│                                                                                              │
│                                           [🔋 156K/500K · 14:22 리셋]  [한국어 ▾]           │
│                                                                          ↑                   │
│                                                    src/ui/TokenUsageIndicator    LanguageDropdown │
└──────────────────────────────────────────────────────────────────────────────────────────────┘

 LanguageDropdown · 닫힘 (폭 120 × 높이 32)
 ┌──────────────────────┐
 │  한국어        ▾      │  ← text-[12px] text-white/90 font-mono
 └──────────────────────┘
   border: 2px solid rgba(255,255,255,0.18)
   background: rgba(0,0,0,0.32)  (= --token-usage-badge-bg 재사용)
   padding: 4px 10px              (= --token-usage-badge-padding 재사용)
   radius: 6px                    (= --token-usage-badge-radius 재사용)
```

### 1.2 포커스 · 호버 상태

```
 LanguageDropdown · hover
 ┌──────────────────────┐
 │  한국어        ▾      │  ← border color → rgba(127,212,255,0.45) (= --color-accent 투명)
 └──────────────────────┘

 LanguageDropdown · focus-visible (포커스 링)
 ┌──────────────────────┐
 │  한국어        ▾      │  ← outline: 2px solid var(--color-focus-ring), offset: 2px
 └──────────────────────┘
```

### 1.3 열림 상태 (ArrowDown 또는 클릭)

```
 LanguageDropdown · open
 ┌──────────────────────┐
 │  한국어        ▴      │  ← 화살표 회전
 └──────────────────────┘
 ┌──────────────────────────────┐  ← 폭 160 (버튼보다 40px 더 넓게 · 오른쪽 정렬)
 │ ✓ 한국어                      │  ← 현재 선택: bold + text-white · bg rgba(127,212,255,0.08)
 │   English                     │  ← 기본: text-[12px] text-white/70
 └──────────────────────────────┘
   배경: var(--color-surface)           (#16213e)
   테두리: 2px var(--color-border)       (#4e4e6a)
   라운드: 6px
   그림자: 0 14px 36px rgba(0,0,0,0.50)  (= --token-usage-tooltip-shadow 재사용)
   z-index: 40                          (AppShell 헤더 30 보다 위, 온보딩 60 보다 아래)
   각 옵션 높이: 36px, padding: 8px 12px
```

### 1.4 상태별 시각 스타일 상세

| 상태                 | 텍스트 색                              | 배경                                      | 테두리                                      | 추가 표식                         |
| -------------------- | -------------------------------------- | ----------------------------------------- | ------------------------------------------- | --------------------------------- |
| 버튼 기본              | `text-white/90` (rgba 0.90)             | `--token-usage-badge-bg` (rgba 0,0,0,.32)  | `rgba(255,255,255,0.18)`                     | —                                 |
| 버튼 호버              | `text-white`                            | `--token-usage-badge-bg`                   | `rgba(127,212,255,0.45)`                     | —                                 |
| 버튼 포커스            | `text-white`                            | `--token-usage-badge-bg`                   | `rgba(255,255,255,0.18)` + outline accent    | `outline: 2px solid --color-focus-ring` · offset 2 |
| 버튼 활성(열림)         | `text-white`                            | `rgba(127,212,255,0.10)`                   | `rgba(127,212,255,0.55)`                     | 화살표 방향 ▴                     |
| 옵션 기본              | `text-white/70`                         | `transparent`                              | —                                           | —                                 |
| 옵션 호버              | `text-white`                            | `rgba(255,255,255,0.06)`                   | —                                           | —                                 |
| 옵션 선택              | `text-white` + **bold**                 | `rgba(127,212,255,0.08)`                   | `border-left: 2px solid --color-accent`      | 좌측 ✓ 체크                        |
| 옵션 포커스(키보드)      | `text-white`                            | `rgba(127,212,255,0.12)`                   | —                                           | `outline-offset: -2px` 내부 링    |
| disabled (해당 없음)   | —                                       | —                                          | —                                           | 2개 옵션 모두 항상 활성           |

### 1.5 다크모드 · 명암 대비(WCAG AA)

| 조합                                                  | 대비 근사치 | 판정  |
| ----------------------------------------------------- | ----------- | ----- |
| 버튼 텍스트 `rgba(244,244,251,.90)` on `rgba(0,0,0,.32)` | ≈ 14:1       | AAA ✓ |
| 옵션 기본 `rgba(244,244,251,.70)` on `#16213e`          | ≈ 9:1         | AAA ✓ |
| 옵션 선택 `#f4f4fb` bold on `rgba(127,212,255,0.08)`    | ≈ 13:1        | AAA ✓ |
| 포커스 링 `#7fd4ff` on `#1a1a2e`                        | ≈ 11:1        | AAA ✓ |

- 라이트 모드는 지원 시점(후속 PR) 에 `--color-surface` 가 반전되므로 동일 규칙을 그대로 적용하면 대비 유지.

### 1.6 키보드 상태 기계

```
 Button focus ──Enter/Space/ArrowDown──▶ Open
 Button focus ──Tab──▶ Next focusable                  (닫힌 상태, 일반 흐름)

 Open · 첫 진입 → 현재 선택 옵션으로 포커스 이동
 Open ──ArrowDown──▶ 다음 옵션                          (순환)
 Open ──ArrowUp──▶ 이전 옵션                            (순환)
 Open ──Home──▶ 첫 옵션 · End ──▶ 마지막 옵션
 Open · 영문자 k/e 입력 ──▶ 해당 접두 옵션으로 점프        (type-ahead)
 Open ──Enter/Space──▶ 선택 + Close + setLocale + 버튼으로 포커스 복귀
 Open ──Tab──▶ 선택 없이 Close + 다음 focusable 로 이동
 Open ──Esc──▶ 선택 없이 Close + 버튼 포커스 복귀
 Open · 외부 클릭 ──▶ 선택 없이 Close
```

- 선택 후 `aria-live="polite"` 로 "언어를 영어로 전환했습니다" / "Switched to Korean" 1회 낭독. 선행 시안 `mcp-transport-and-language-toggle-2026-04-20.md` §3.1 계승.

### 1.7 ARIA 구조(구현 힌트)

```tsx
<div className="lang-dropdown">
  <button
    type="button"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={listId}
    aria-label={t('locale.label')}  // "언어" · "Language"
  >
    <span>{localeLabel}</span>
    <ChevronDown aria-hidden />
  </button>
  {open && (
    <ul
      id={listId}
      role="listbox"
      aria-activedescendant={activeId}
      tabIndex={-1}
    >
      {LOCALES.map((l) => (
        <li
          key={l}
          id={`lang-opt-${l}`}
          role="option"
          aria-selected={current === l}
        >
          {current === l && <CheckIcon aria-hidden />}
          <span>{t(`locale.${l}`)}</span>
        </li>
      ))}
    </ul>
  )}
</div>
```

### 1.8 모바일 · 협소 뷰포트

- 폭 < 600px 에서는 AppShell 헤더 1행에 인디케이터 + 드롭다운 둘 다 못 들어갈 수 있음.
- 폴백: 드롭다운이 인디케이터 아래 두 번째 행으로 밀림(헤더 높이 48 → 80, flex-wrap). 버튼 폭은 동일 120 고정.
- 극단 폭(<400px): 버튼 텍스트가 `KO ▾` · `EN ▾` (2글자 약칭) 으로 축약. `aria-label` 은 전체 단어 유지.

### 1.9 Figma 프레임 구성(참고)

Figma 도입 시 1 페이지에 다음 8 프레임을 세로 스택:

| 순번 | 프레임명                    | 내용                                      |
| ---- | --------------------------- | ----------------------------------------- |
| 1    | `header/with-dropdown/default` | 헤더 전체(인디케이터 + 드롭다운 닫힘)      |
| 2    | `dropdown/button/default`     | 닫힘 상태 버튼 단독                        |
| 3    | `dropdown/button/hover`        | 호버                                      |
| 4    | `dropdown/button/focus`        | 포커스 링                                 |
| 5    | `dropdown/button/open`         | 열림(화살표 회전)                         |
| 6    | `dropdown/panel/open`          | 옵션 패널 단독(현재=한국어 선택 상태)      |
| 7    | `dropdown/panel/kbd-focus`     | 옵션에 키보드 포커스 상태                 |
| 8    | `header/mobile/stacked`        | 폭 < 600 접힘 상태                        |

---

## 2. 추천 에이전트 카드 — 레이아웃

### 2.1 리스트 전체 배치 (NewProjectWizard 단계 2)

```
┌ NewProjectWizard · 단계 2 "검토" ──────────────────────────────────────────┐
│  추천 팀 3명                              [출처: 휴리스틱 폴백]              │
│                                                         [모두 선택] [초기화]│
│                                                                             │
│  ┌ RoleCard (폭 flex · 최소 260) ─────┐ ┌ RoleCard ────┐ ┌ RoleCard ────┐   │
│  │  👑  Kai                           │ │  🛠 Dev        │ │ ♿ Ada          │   │
│  │  Leader                             │ │  Developer    │ │ Designer       │   │
│  │                                     │ │               │ │                 │   │
│  │  팀 분배·진행 관리에 집중.              │ │  "웹앱" 키워드│ │ "접근성" 키워드 │   │
│  │                                     │ │  로 추천.        │ │ 로 추천.          │   │
│  │                                     │ │               │ │                 │   │
│  │  [분배] [보고] [할일]                │ │  [웹][리액트]   │ │ [a11y][WCAG]    │   │
│  │                                     │ │  [테스트]       │ │ [디자인]         │   │
│  │                                     │ │               │ │                 │   │
│  │  ☑ 포함  [+ 추가]        ⋮            │ │  ☑ 포함 [+ 추가] ⋮│ │ ☑ 포함 [+ 추가] ⋮│   │
│  └──────────────────────────────────────┘ └──────────────┘ └──────────────┘   │
│                                                                             │
│  [취소]                                     [💡 모두 추가 3명 (팀 구성)]    │
│                                                              ↑ primary      │
└─────────────────────────────────────────────────────────────────────────────┘
```

- 그리드: `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3` — 반응형 1/2/3 열.
- 카드 최소 폭 260, 최대 340. 높이 가변(최소 220 · 최대 300, 초과 시 skills 칩 내부 스크롤).
- 카드 간격 `gap-3` (12px) · 선행 시안 일관성.

### 2.2 `RoleCard` 구조 · 토큰

```
┌ RoleCard · 폭 280 × 높이 236 ─────────────────────────────────┐
│                                                                │
│ [⋮ 더보기] ← 우상단 8px 여백                                    │
│                                                                │
│ ┌ 아이콘 halo (40×40, radius 50%, bg rgba accent 0.12) ┐       │
│ │          👑                                           │       │
│ └──────────────────────────────────────────────────────┘       │
│                                                                │
│ Kai                              ← text-[14px] font-bold       │
│ Leader                            ← text-[10px] uppercase tracking-wider text-white/70
│                                                                │
│ ───────────────────────────────────────────────────            │
│                                                                │
│ 팀 분배·진행 관리에 집중해 주세요.    ← text-[12px] text-white/85, 2줄 clamp
│ 매일 한 번 진척 보고.                                              │
│                                                                │
│ ───────────────────────────────────────────────────            │
│                                                                │
│ Skills                                                          │
│ [분배] [보고] [할일] +1                                          │
│                                                                │
│ ───────────────────────────────────────────────────            │
│                                                                │
│ ☑ 포함              [+ 추가]                                     │
│ ↑ 체크박스 18×18   ↑ ghost 버튼 우측 정렬                         │
└────────────────────────────────────────────────────────────────┘

   카드 토큰
   · 배경: var(--color-surface-elevated)    (#0f3460)
   · 테두리 기본: 2px var(--color-border)   (#4e4e6a)
   · 라운드: 4px                              (= --radius-md)
   · padding: 16px                            (= --space-lg)
   · 포함 시 테두리: 2px var(--color-accent)
   · 호버 그림자: var(--media-preview-card-shadow) (일관성)
```

### 2.3 role 별 아이콘 · 팔레트 매핑

| role         | 아이콘(lucide)   | halo 색                                     | aria-label 보강               |
| ------------ | ---------------- | ------------------------------------------- | ----------------------------- |
| Leader        | `Crown`          | `rgba(251,191,36,0.12)` (amber)              | "팀장"                          |
| Developer     | `Wrench`         | `rgba(127,212,255,0.12)` (cyan = accent)      | "개발자"                        |
| QA            | `ClipboardCheck` | `rgba(52,211,153,0.12)` (emerald)             | "품질 보증"                     |
| Designer      | `Palette`        | `rgba(236,72,153,0.12)` (pink)                | "디자이너"                      |
| Researcher    | `Compass`        | `rgba(139,92,246,0.12)` (violet)              | "리서처"                        |

- halo 색은 카드 본체에 영향 주지 않음 — 40×40 아이콘 배경만. **5 역할을 색만으로 구분하지 않고 아이콘 + 라벨 3중 신호**.

### 2.4 skills 칩 스타일

```
 Chip · 기본
 ┌─────────────┐
 │  #분배       │  ← text-[10px] uppercase tracking-wider text-white/80
 └─────────────┘
   배경: rgba(127,212,255,0.08)
   테두리: 1px rgba(127,212,255,0.28)
   padding: 2px 8px
   radius: 999px (pill)
   height: 20px

 Chip · 초과 표시 "+N"
 ┌────────┐
 │  +2     │  ← 동일 스타일 + text-white/60
 └────────┘
```

- 클릭 불가(데코). 4개 초과 시 마지막 칩은 `+N` 으로 축약, hover 시 툴팁으로 전체 skill 나열.
- `skills` 가 0개인 경우(스키마 실패) 칩 섹션 자체 숨김 — `Skills` 라벨도 함께 사라짐.

### 2.5 액션 계층 · 체크박스 + [추가] + [모두 추가]

```
 카드 하단
 ☑ 포함                          [+ 추가]
 ↑ role="checkbox"              ↑ ghost 버튼

   체크박스 동작: 기본 체크됨. 해제 시 카드 테두리가 dashed 로 바뀌고 본문이 0.6 투명.
                "모두 추가" 에서는 제외됨.

   [+ 추가] 동작: 단건 즉시 추가. 추가 완료 시 카드가 3초간 emerald 강조 + 체크 고정,
                버튼 레이블이 `[✓ 추가됨]` 으로 변경(disabled).

 리스트 푸터
                                                    [💡 모두 추가 3명]
                                                    ↑ primary, bg var(--color-accent)
                                                       color var(--color-accent-contrast)
```

- primary 는 하나만(F-09). [추가] 는 ghost · [모두 추가] 는 filled accent.
- 배너에서 `[모두 추가]` 클릭 시 체크된 N 건만 적용. 0 건이면 disabled + 툴팁 "최소 1 명을 선택해 주세요".

### 2.6 더보기 ⋮ 메뉴

```
 카드 우상단 [⋮] 클릭 시 팝오버 (폭 200)
 ┌───────────────────────────┐
 │ 🔍 근거 상세 보기          │  ← RationaleDrawer 열기 (Shift+D 동일, 선행 시안 §2)
 │ ✎ 편집 모드로 전환         │  ← 전역 편집 토글 ON
 │ ↔ 대안 역할로 교체 …        │  ← 대안 2 건 하위 메뉴
 │ 🗑 카드 제거                │  ← Leader 제외
 └───────────────────────────┘
```

- 메뉴 아이템 `role="menuitem"`. 키보드 ↑/↓ 순회, Enter 선택, Esc 닫기.
- 제거는 편집 모드 OFF 에서도 가능(단건 제거 = 체크 해제 + 시각 숨김). 되돌리기 3초 토스트.

---

## 3. 상태 3종 — 로딩 · 빈 · 에러

### 3.1 로딩 스켈레톤

```
 ┌ RoleCardSkeleton × 3 ─────────────────────────────────────┐
 │ [▓▓ 40×40]                                                  │
 │ ▓▓▓▓▓▓▓▓                                                  │ ← 이름 행(60% 폭)
 │ ▓▓▓▓                                                      │ ← 역할 행(30%)
 │ ░                                                         │
 │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                                    │ ← 근거 2줄
 │ ▓▓▓▓▓▓▓▓▓▓▓▓▓                                            │
 │ ░                                                         │
 │ [▓▓] [▓▓▓] [▓▓]                                           │ ← 칩 3개
 │ ░                                                         │
 │ [░░] ······ [▓▓▓▓▓▓]                                      │ ← 체크박스 + 버튼
 └───────────────────────────────────────────────────────────┘
```

- 각 `▓` : `bg: rgba(255,255,255,0.08)` · radius 2~4px · pulse `animation: fadeAndSlide 360ms` (기존 `--motion-duration-lg`). `prefers-reduced-motion` 시 정적.
- 150ms 미만 응답은 스켈레톤 자체 노출 안 함(§3 선행 시안 규약 계승).
- `role="status"` + `aria-live="polite"` + `aria-label="추천 팀을 불러오는 중"`.

### 3.2 빈 상태

```
┌ EmptyState · icon=Compass ──────────────────────────────────┐
│                    🧭                                         │
│                                                               │
│            추천할 팀을 찾지 못했어요                             │
│                                                               │
│      설명이 짧거나 일반적이어서 매칭이 어려웠어요.                  │
│                                                               │
│   💡 "웹/접근성/테스트" 같은 키워드를 덧붙여 보세요.                │
│                                                               │
│           [직접 에이전트 추가]    [최근 추천 불러오기]              │
└───────────────────────────────────────────────────────────────┘
```

- 선행 시안 `error-recovery-ux-2026-04-21.md` §4.2 카피 재사용(키: `errors.recommend.empty.*`).
- 카드 그리드의 자리를 `EmptyState` 가 그대로 차지 — 외곽 크기는 최소 `--empty-state-min-height` 160px.
- 두 버튼의 hierarchy: `[직접 에이전트 추가]` primary(ghost accent) · `[최근 추천 불러오기]` secondary(ghost subtle).
- 최근 추천 0건 시 두 번째 버튼 disabled + 툴팁 "이전 추천이 없어요".

### 3.3 에러 상태

```
┌ ErrorState · role=alert · tone=danger ──────────────────────┐
│ ⚠  추천을 불러오지 못했어요                                    │
│                                                               │
│    네트워크가 불안정하거나 추천 서비스에 일시 장애가 있어요.         │
│    요청 ID: req_01HXX...  [요청 ID 복사]                        │
│                                                               │
│                       [다시 시도]    [최근 추천 불러오기]          │
└───────────────────────────────────────────────────────────────┘
```

- `ErrorState` 공용 컴포넌트 재사용. `aria-live="assertive"`.
- `tone='danger'` (붉은 스트립) 이 기본. 온라인 감지(`useOnlineStatus`) 로 오프라인 판정 시 `tone='warning'` (amber) + 배너 문구 교체("오프라인 · 로컬 캐시만 표시").
- 요청 ID 는 `classifyClaudeError` 가 제공하면 노출 · 없으면 해당 줄 숨김.

### 3.4 부분 실패(단건 실패 + 나머지 정상)

```
┌ 리스트 상단 · InlineBanner (tone=warning) ──────────────────┐
│ ⚠ 추천 중 1건을 가져오지 못했어요. 나머지 2건만 표시합니다. [다시 시도] │
└─────────────────────────────────────────────────────────────┘
[RoleCard · Kai]   [RoleCard · Ada]
```

- 전체 실패는 §3.3 ErrorState. 부분 실패는 **인라인 warning 배너 + 정상 카드 동시 노출**. 부분 성공 허용 규약(선행 `multimedia-ui-spec.md` M-04 계승).

### 3.5 토큰 예산 초과 상태(추가 제안 — F 원칙 § 서두 연결)

우선 검토 파일 `tokenBudget.ts` 의 `shouldCompact` 가 true 를 돌려주면 "모두 추가" 버튼은 **disabled + 상단 warning 배너**:

```
┌ 리스트 상단 · InlineBanner (tone=warning) ──────────────────┐
│ ⚡ 세션 토큰 한도가 근접했어요. 한 명씩 추가하거나 압축 후 다시 시도하세요. │
│                                                  [압축 실행]    │
└─────────────────────────────────────────────────────────────┘
                                                [💡 모두 추가 3명]
                                                 ↑ disabled + aria-disabled
```

- 단건 `[+ 추가]` 는 여전히 활성 — 사용자가 의식적으로 한 건씩 추가하면 예산 내에서 진행 가능.
- `[압축 실행]` 클릭 시 `maybeCompact` 호출 · 성공 시 배너 자동 해제 · 실패 시 `ErrorState` 로 전환.

---

## 4. `src/ui/McpConnectionForm` 토큰과의 1:1 매핑

### 4.1 라벨 · 입력 토큰 공유

| McpConnectionForm 사용       | 본 시안 대응                                       |
| ---------------------------- | -------------------------------------------------- |
| `text-[10px] uppercase tracking-wider text-white/70` | 드롭다운 옵션 메타·카드 "Skills" 라벨·role 라벨  |
| `text-[12px] text-white font-mono`                    | 드롭다운 버튼 텍스트·카드 이름                   |
| `bg-black/30 border-2 px-3 py-2`                      | 드롭다운 버튼 컨테이너(padding 축소 4/10 로 변형)  |
| `text-[11px] text-red-300 role="alert"`                | 추천 리스트 인라인 warning/error 보조 문구         |

### 4.2 공통 포커스 링

- 본 시안 모든 상호작용 요소: `outline: 2px solid var(--color-focus-ring)` · `outline-offset: 2px`. McpConnectionForm 의 `focus-visible:ring-2 ring-[var(--pixel-accent)]` 와 **의미 동등**(Tailwind ring vs native outline 변환).

### 4.3 spacing 표

| 의미                       | McpConnectionForm              | 본 시안                     |
| -------------------------- | ------------------------------ | --------------------------- |
| 필드 세로 간격              | `space-y-3` (12px)              | 카드 섹션 구분 `space-y-3`   |
| 섹션 큰 간격                | `space-y-4` (16px)              | 카드 내부 블록 간 `space-y-4`|
| 버튼 그룹                   | `gap-3` (12px)                   | 리스트 푸터 버튼 간 `gap-3` |
| 체크박스 ↔ 레이블            | `gap-2` (8px)                    | 카드 하단 체크 + 레이블 `gap-2`|

### 4.4 라운드 · 그림자 재사용

| 요소                  | 토큰                                            |
| --------------------- | ----------------------------------------------- |
| 드롭다운 버튼          | `--token-usage-badge-radius` 6px                  |
| 드롭다운 패널          | 6px · 그림자 `--token-usage-tooltip-shadow`        |
| 카드 테두리            | `--radius-md` 4px                                 |
| 카드 호버 그림자       | `--media-preview-card-shadow`                     |
| 칩 pill                 | 999px                                            |

---

## 5. 접근성 체크리스트(네 표면 공통)

| 요소                           | role / aria                                                                 | 키보드 동작                             |
| ------------------------------ | --------------------------------------------------------------------------- | --------------------------------------- |
| 드롭다운 버튼                   | `role="button"` + `aria-haspopup="listbox"` + `aria-expanded` + `aria-label` | Enter/Space/↓ 열림                      |
| 드롭다운 리스트                 | `role="listbox"` + `aria-activedescendant`                                    | ↑↓ 순회 · Enter 선택 · Esc 닫기          |
| 드롭다운 옵션                   | `role="option"` + `aria-selected`                                             | 포커스 시 `activedescendant` 갱신        |
| 추천 카드 리스트 컨테이너        | `role="list"` + `aria-label="추천 팀"`                                         | Tab 1회로 첫 카드 진입                  |
| 카드 개별                       | `role="listitem"` + `aria-labelledby="card-{id}-name"`                        | Tab 순서 체크박스 → [추가] → ⋮            |
| 체크박스                        | native `<input type="checkbox">` + `aria-describedby="card-{id}-rationale"`   | Space 토글                              |
| 아이콘 전용 버튼(⋮)              | `aria-label="{name} 카드 옵션"`                                               | Enter 팝오버 열기                       |
| 상태 전환 알림                   | `aria-live="polite"` 영역 — "추천 3건 준비됨", "언어 전환됨"                   | —                                       |
| 에러 배너                       | `role="alert"` + `aria-live="assertive"`                                      | —                                       |

### 5.1 색맹 · 저시력 대응(O-14 계승)

- 언어 드롭다운 "현재 선택" 신호는 **색 + bold + ✓ 체크** 3중.
- 추천 카드 "포함/제외" 신호는 **테두리 색 + 테두리 스타일(solid/dashed) + 체크박스** 3중.
- role 구분은 **아이콘(모양) + halo 색 + 텍스트 라벨** 3중.

### 5.2 `prefers-reduced-motion` 대응

- 드롭다운 열림 fade: `--motion-duration-sm` 140ms → 0ms.
- 카드 호버 lift · 스켈레톤 pulse → 즉시 정적.
- 추가 완료 emerald 강조 3초 → 색만 유지(애니메이션 생략).

---

## 6. 토큰 맵 · 신규 0건

| 의미                          | 기존 토큰                                      |
| ----------------------------- | ---------------------------------------------- |
| 강조(선택된 언어·포함 카드)    | `--color-accent` `#7fd4ff`                     |
| 강조 글자                      | `--color-accent-contrast` `#000`               |
| 본문 배경                      | `--color-bg` `#1a1a2e`                         |
| 서피스 기본                    | `--color-surface` `#16213e`                    |
| 서피스 상승                    | `--color-surface-elevated` `#0f3460`           |
| 테두리                          | `--color-border` `#4e4e6a`                     |
| 본문 글자                      | `--color-text` `#f4f4fb`                       |
| 보조/미묘 글자                  | `--color-text-muted` / `--color-text-subtle`    |
| 위험                            | `--color-danger` / `--color-danger-surface`    |
| 경고                            | `--color-warning` / `--color-warning-surface`  |
| 정보                            | `--color-info` / `--color-info-surface`        |
| 성공                            | `--color-success` / `--color-success-surface`  |
| 포커스 링                        | `--color-focus-ring`                            |
| 드롭다운 그림자                  | `--token-usage-tooltip-shadow`                  |
| 배지 배경/라운드/패딩            | `--token-usage-badge-bg` / `-radius` / `-padding`|
| 카드 hover 그림자                | `--media-preview-card-shadow`                   |
| 라운드 3종                        | `--radius-sm` · `-md` · `-lg`                   |
| 공백 5종                         | `--space-xs` · `-sm` · `-md` · `-lg` · `-xl`     |
| 모션 4 단계                       | `--motion-duration-xs` · `-sm` · `-md` · `-lg`   |

신규 CSS 변수 · Tailwind 유틸 **0 건**.

---

## 7. Figma 파일이 생길 때 이식 경로

1. `docs/design/figma/` 디렉터리 신설(본 시안 §1 · §2 · §3 각각 1 페이지).
2. 위 §6 토큰 맵을 **Figma Variables** 로 1:1 생성 — Color · Number · String 타입.
3. 컴포넌트: `Header/LanguageDropdown/{Default,Hover,Focus,Open}` · `Recommend/RoleCard/{Default,Hover,Focus,Selected,Unselected,AddedPulse}` · `Recommend/List/{Loading,Empty,Error,BudgetNearLimit,PartialFailure}` Variants.
4. 본 `.md` 의 ASCII 프레임이 각 Figma Frame 의 1:1 대응. 픽셀 수치는 §1.3 · §2.2 그대로.

> 규약: **Figma 가 단일 진실이 되는 순간 본 md 의 픽셀 수치는 Figma 가 권위** 로 이동. 본 md 는 그 이전까지 임시 권위.

---

## 8. 결정 대기

| ID    | 질문                                                                         | 대상  |
| ----- | ---------------------------------------------------------------------------- | ----- |
| R-F1  | 드롭다운 옵션 2개뿐인 현 시점에서 `role="combobox"` 로 승격할 가치가 있는가     | QA    |
| R-F2  | 극단 폭 < 400px 에서 버튼 축약(`KO ▾` / `EN ▾`) 이 실제 사용자에게 읽히는지       | QA    |
| R-F3  | type-ahead(알파벳 키로 점프) 가 ko 에서 "ㄱ/ㅎ" 같은 한글 자모까지 지원해야 하는지   | QA    |
| R-F4  | 추천 카드 skills 칩 4개 초과 시 `+N` 대신 "더 보기 · 펼치기" 패턴을 선호하는지     | QA    |
| R-F5  | role 아이콘을 lucide 고정 vs 프로젝트 내 단일 아이콘 팩으로 교체 여부               | Kai   |
| R-F6  | 토큰 예산 근접 시(§3.5) [모두 추가] disabled 가 사용자 자율성을 지나치게 제약하는지 | Kai   |
| R-F7  | 언어 드롭다운 + 온보딩 투어 1번 스텝 중복 — 온보딩 중에는 드롭다운 disabled 처리?  | QA    |
| R-F8  | 추천 카드 "추가 완료" 펄스 3초가 시각 노이즈가 되지 않는지 사용성 측정                | QA    |

---

## 9. 파일 배치(구현 지침)

```
src/ui/
  LanguageDropdown.tsx                         (신규 · §1 컴포넌트)
  AppShell.tsx                                  (기존 · 헤더에 LanguageDropdown 삽입)
  recommend/
    RoleCard.tsx                                (신규 · §2)
    RoleCardSkeleton.tsx                        (신규 · §3.1)
    RecommendationList.tsx                       (신규 · 그리드 + 상태 분기)
    RecommendationFooter.tsx                    (신규 · 모두 추가 CTA)
    TokenBudgetBanner.tsx                        (신규 · §3.5)

src/utils/
  roleVisuals.ts                                (신규 · role → icon/halo/label 매핑 · 단일 진실)

locales/
  en.json · ko.json                             (기존 `locale.*` 유지 · 추천 카드 카피는 이미 `project.newProjectWizard.*` / `recommend.*` 재사용)
```

- 모든 신규 컴포넌트는 `node:test` 순수 유닛 스펙 + React Testing Library 통합 스펙으로 회귀 잠금 권장.
- `LanguageDropdown` 은 단축키(`Alt+Shift+L`) 로 전역 오픈 가능하게 `KeyboardShortcutCheatsheet` 에 등록(선행 시안 §8.2 계승).

---

끝.
