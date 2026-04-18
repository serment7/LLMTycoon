# SharedGoalModal · 자동 개발 ON 트리거 모달 UX 시안 (2026-04-19)

관련 선행 문서:
- `tests/shared-goal-form-mockup.md` (2026-04-18) — 인라인 헤더 확장 시안(헤더 **왼쪽** 고정 영역)
- `tests/project-settings-save-load-regression-20260419.md` — `autoDevEnabled` 저장/로드 계약
- `src/server/taskRunner.ts` — 저장된 자동 개발 옵션을 소비하는 하류 컨슈머
- `src/index.css` (line 54~91) — 기존 `--shared-goal-*` (폼 상태 팔레트) 토큰

대상 컴포넌트(신규 제안): `src/components/SharedGoalModal.tsx`
진입점: `ProjectManagement.tsx` / `GitAutomationPanel.tsx` 의 **자동 개발 토글 OFF→ON 시도**
디자인 토큰: `src/index.css` 의 `--shared-goal-modal-*` 계열 (이번 PR 에서 선-도입)

---

## 0. 왜 "모달" 인가 — 인라인 폼 시안과의 차이

`shared-goal-form-mockup.md` 의 **인라인** 시안은 "헤더 확장 영역을 항상 보여주고 자동 개발 토글을 잠금" 방식을 채택한다. 이 시안은 **화면 너비가 좁거나(<1080px) 패널이 접혀 있거나, 프로젝트에 아직 공동 목표가 **한 번도** 등록되지 않은 신규 상태** 에서 아래 문제를 일으킨다:

1. **가시성 부족**: 헤더 확장 영역이 스크롤 밖에 있어, 사용자가 토글을 누르면 "아무 일도 안 일어났다" 고 오인.
2. **컨텍스트 이탈**: 토글 상태와 목표 저장 상태가 물리적으로 떨어져 있어 원인–결과 연결이 약함.
3. **키보드 사용성**: 토글(OFF→ON) 시도 이후 포커스가 제자리에 머물러, 스크린리더 사용자가 "왜 ON 이 안 되는지" 를 즉시 듣지 못함.

**모달 전환의 이득**
- 자동 개발 ON 시도가 "즉시 중요한 입력을 요청" 으로 승격된다 — 사용자 의도(=ON) 와 시스템 요구(=목표 저장) 가 같은 프레임에서 해결된다.
- 키보드 포커스가 강제로 모달 첫 필드로 이동 → "무엇을 해야 하는지" 가 스크린리더로 즉시 낭독.
- 취소/확정 이분법이 토글의 원래 상태(ON/OFF) 와 1:1 매핑되어 "되돌릴 수 있다" 는 심리적 안전망을 확보.

**인라인 시안과의 관계**: 두 시안은 **상호 배타가 아니다**. 인라인 폼은 "이미 목표가 등록된 프로젝트의 후속 편집 진입점" 으로 살리고, 본 모달은 **최초 ON 시도 시점의 on-ramp** 전용으로 분리한다. 즉:

```
[empty 상태 + 토글 ON 클릭]  ──▶  본 문서의 SharedGoalModal
[saved 상태 + 토글 ON 클릭]  ──▶  인라인 폼만(모달 불필요)
[running 중 목표 편집 요청]  ──▶  인라인 폼의 readOnly 해제 흐름
```

---

## 1. 트리거 조건 매트릭스

| 현재 상태                        | 토글 조작                | 결과                                                                |
| -------------------------------- | ------------------------ | ------------------------------------------------------------------- |
| `autoDevEnabled=false` + 목표 없음 | OFF → ON 시도            | **모달 열림**(본 시안). 확정 시 목표 저장 + 토글 ON 을 원자적으로 수행 |
| `autoDevEnabled=false` + 목표 있음 | OFF → ON 시도            | 모달 생략, 즉시 ON                                                  |
| `autoDevEnabled=true`             | ON → OFF 시도            | 모달 없이 즉시 OFF (+ 리더 WAIT 브로드캐스트)                        |
| `autoDevEnabled=true` + 실행 중    | 키보드 단축키/외부 트리거 | 모달 대신 인라인 폼의 `readOnly` 해제 안내 배너                       |

**원자성 계약**: 모달 확정 클릭 시 네트워크 관점에서는 `POST /api/projects/:id/shared-goal` 200 이후에만 `PATCH /api/projects/:id/options { autoDevEnabled: true }` 를 호출한다. 목표 저장이 실패하면 토글은 OFF 를 유지한다. 사용자 심리 모델과 서버 상태가 어긋나지 않아야 하기 때문이다.

---

## 2. 모달 구조 (3 영역 × 세로)

```
┌────────────────────────────────────── SharedGoalModal ──────────────────────────────────────┐
│  [backdrop: rgba(10,10,25,0.72) · blur(3px)]                                                │
│                                                                                              │
│     ┌─────────────────────────────────────────────────────────────────────────────┐          │
│     │ ◇ HEADER ▸ 공동 목표 등록이 필요합니다                          [Esc] [  × ]│          │
│     │   자동 개발 ON 은 리더가 동료들에게 분배할 목표가 있어야 시작됩니다.          │          │
│     ├─────────────────────────────────────────────────────────────────────────────┤          │
│     │ ▸ BODY                                                                       │          │
│     │   목표 제목   * [ 결제 모듈 보안 강화                           ] 11/80       │          │
│     │   상세 설명   * [ 토큰 검증·AES 암호화·PCI 감사로그 추가 …            ▼]     │          │
│     │                                                                    76/500    │          │
│     │   우선순위    ◉ P1-긴급  ○ P2-중요  ○ P3-일반   기한 [2026-04-25] │          │
│     │                                                                              │          │
│     │   ┌─ 리더 분배 미리보기 ────────────────────────────────────────────┐         │          │
│     │   │ 🤖 4명 → "결제 모듈 보안 강화" (P1, ~4/25)                      │         │          │
│     │   │   · Thanos (리더)  · Aurora  · Nova  · Orion                    │         │          │
│     │   └──────────────────────────────────────────────────────────────────┘         │          │
│     ├─────────────────────────────────────────────────────────────────────────────┤          │
│     │ ▸ FOOTER                                         [취소]   [ 💾 목표 저장 후 시작 ]│          │
│     │   💡 저장 직후 자동 개발이 ON 으로 전환되고 리더가 즉시 분배를 시작합니다.     │          │
│     └─────────────────────────────────────────────────────────────────────────────┘          │
│                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 영역별 역할

| 영역    | 역할                                                                            | 높이 가이드         |
| ------- | ------------------------------------------------------------------------------- | ------------------- |
| HEADER  | "왜 이 모달이 떴는가" 의 한 문장 설명 + 닫기 버튼                                    | 72px                |
| BODY    | 입력 필드 4종 + 리더 분배 미리보기(실시간)                                           | auto (min 320px)    |
| FOOTER  | 보조 문구(💡) + [취소] + [확정]. 확정은 primary, 취소는 secondary                     | 96px                |

---

## 2A. 폼 필드 정밀 규격 — 레이블 · 플레이스홀더 · 보조 힌트

(2026-04-19 추가: `ProjectManagement.tsx` 의 공동 목표 입력 폼이 **한때 렌더되지 않던 회귀**(`tests/auto-dev-toggle-shared-goal-modal-regression-20260419.md`) 재발 방지를 위해 **필드별 정적 카피** 를 명시 고정. 구현자가 임의로 빈 문자열로 대체하지 못하도록 레이블·플레이스홀더·보조 힌트를 토큰 수준으로 분리한다.)

### 2A.1 필드 카피 고정 테이블

| 필드 ID         | 레이블                 | 플레이스홀더                                                        | 보조 힌트 (필드 아래 12px)                       | 필수 |
| --------------- | ---------------------- | ------------------------------------------------------------------- | ------------------------------------------------ | :--: |
| `sg-title`      | `목표 제목`            | `예: 결제 모듈 보안 강화`                                            | `리더가 동료들에게 1문장으로 분배할 핵심 제목`      |  ●   |
| `sg-description`| `상세 설명`            | `예: 토큰 검증·AES 암호화·PCI 감사로그 추가. 범위·완료 기준을 적어주세요.` | `20–500자. 범위와 '완료 판단 기준' 을 함께 써주세요` |  ●   |
| `sg-priority`   | `우선순위`             | (라디오, placeholder 없음)                                           | `리더가 분배할 때 우선순위 태그로 사용`             |  ●   |
| `sg-dueDate`    | `기한`                 | `연-월-일` (브라우저 기본)                                            | `선택 · 비워두면 "기한 없음" 으로 저장`              |  ○   |

**카피 규칙**

1. **레이블은 4자 이내** 의 짧은 명사구. 보조 힌트에 의미를 싣는다. 레이블이 길어지면 폼 세로 길이가 불필요하게 늘어 모바일에서 FOOTER 가 접힌다.
2. **플레이스홀더는 `예:` 접두** 로 시작해 "이건 예시일 뿐 실제 값이 아니다" 를 명시. 과거 회귀에서 사용자가 플레이스홀더를 실제 저장값으로 오해해 빈 제목이 서버로 갔던 사례를 차단.
3. **보조 힌트는 레이블·플레이스홀더 둘 다와 의미가 겹치지 않도록** 작성. 레이블 = 이름, 플레이스홀더 = 예시, 힌트 = 규칙/목적.
4. **i18n 대비**: 위 카피 전량을 `src/i18n/sharedGoalModal.ko.ts` 의 키(`sg.modal.title.label`, `sg.modal.title.placeholder`, `sg.modal.title.hint`, …)로 분리해 외주 번역이 레이블만 건드려도 힌트/플레이스홀더는 그대로 유지되게 한다.

### 2A.2 필드 시각 규격 (토큰 매핑)

(2026-04-19 추가: 아래 표의 리터럴 값들은 모두 **`src/index.css` 의 파생 토큰으로 선-분리** 되었다. §8 토큰 표의 2번째 블록을 참조.)

| 토큰                                           | 적용 지점                                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `--shared-goal-modal-subtle-fg`                | 레이블 글자색 (white/65%)                                                                 |
| `--shared-goal-modal-placeholder-fg`           | 플레이스홀더 글자색 (white/42%) — 힌트(65%)보다 **한 단계 더 흐리게** 해 "실제 입력값이 아님" 을 시각 대비로 표현 |
| `--shared-goal-modal-field-border`             | 기본 필드 테두리 (1px)                                                                   |
| `--shared-goal-modal-field-focus`              | 포커스 시 테두리 + 2px 외곽 링                                                            |
| `--shared-goal-modal-field-editing-border`     | 변경이 발생한 필드의 amber 테두리 (1px) — §2B 의 editing 상태                              |
| `--shared-goal-modal-field-editing-strip`      | 변경 필드 좌측 2px 수직 amber 스트립                                                     |
| `--shared-goal-modal-error-strip`              | 검증 실패 시 우측 4px 수직 스트립 + 힌트 자리의 에러 카피 색                               |
| `--shared-goal-modal-counter-fg`               | 글자 수 카운터 (`12/80`) — 정상(white/55%)                                               |
| `--shared-goal-modal-counter-error-fg`         | 글자 수 카운터 — 초과/최소 미달(= error-strip 과 동일한 빨강)                              |

### 2A.3 플레이스홀더 vs 실제 값 판별 — 접근성

- 플레이스홀더는 `aria-placeholder` 가 아닌 **`placeholder` 속성** 만 사용. iOS VoiceOver 일부 버전이 `aria-placeholder` 를 레이블로 오독해 레이블이 두 번 낭독되는 문제 회피.
- 힌트는 `<p id="sg-title-hint">` 로 두고 `<input aria-describedby="sg-title-hint">` 로 연결 — placeholder 가 사라진 뒤에도 힌트는 유지되어 "무엇을 써야 하는지" 가 입력 도중에도 들린다.

---

## 2B. 폼 상태 대비 — "공동 목표 없음(empty-create)" vs "작성 중(editing)"

(2026-04-19 추가: 과거 회귀는 **"폼 자체가 렌더 트리에서 빠져 있어 사용자가 입력할 곳을 못 찾았던" 것**. 회귀 재발 방지를 위해 **두 상태를 시각적으로 명확히 구분** 한다. 어떤 상황에서도 "폼이 없는 것처럼 보이는" 상태는 허용하지 않는다.)

### 2B.1 상태 정의

| 상태            | 트리거                                                             | BODY 내부 구성                                                                    | 시각 단서                                          |
| --------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| `empty-create`  | 모달 open 직후 · 모든 필드 **기본값/공란**                          | 필드 4종 **모두 렌더됨**. 상단에 📝 빈 상태 안내 배너(고정 72px). 리더 미리보기 자리는 "🤖 4명에게 분배 예정 · 제목을 먼저 입력해주세요" 플레이스홀더 | 헤더 ◇ 마크 cyan glow 1회 펄스(220ms), 필드 테두리 `--shared-goal-modal-field-border` (white/18%) |
| `editing`       | 첫 키 입력 또는 라디오/기한 변경 발생                               | `empty-create` 와 동일 필드 구성, 필드 값만 채워짐. 상단 빈 상태 배너는 **128ms 페이드아웃** 후 제거, 그 자리에 글자 수 카운터·리더 미리보기가 점진 등장 | 변경된 필드 테두리가 `--shared-goal-modal-field-editing-border` (amber `#fbbf24`, 인라인 폼 `--shared-goal-border-editing` 과 숫자 일치) 1px + 좌측 2px `--shared-goal-modal-field-editing-strip` 으로 강조. FOOTER 의 primary 버튼이 비활성→hover 가능으로 전환(조건 충족 시만) |

**회귀 방지 원칙 (중요)**

- `empty-create` ↔ `editing` 전이는 **같은 DOM 서브트리 내 값·클래스 변경** 으로 표현한다. 두 상태에서 절대 `if (!hasGoal) return null` 같은 조기 반환을 넣지 않는다(=과거 회귀 원인).
- 상태 전이는 250ms 이내, layout shift 0. 두 상태 모두 BODY 높이 **`--shared-goal-modal-body-min-height` (360px) 로 고정** · 배너 자리 **`--shared-goal-modal-banner-height` (72px) 유지** 로 모달 자체의 크기 변화도 없게 한다. (토큰 정의: `src/index.css`)

### 2B.2 두 상태 병렬 ASCII 시안

```
┌─────────────── empty-create (최초 진입) ──────────────┐   ┌─────────────── editing (작성 중) ──────────────────┐
│ ◇ 공동 목표 등록이 필요합니다                  [× Esc]│   │ ◇ 공동 목표 등록이 필요합니다                  [× Esc]│
│ 자동 개발 ON 은 리더가 분배할 목표가 있어야 …           │   │ 자동 개발 ON 은 리더가 분배할 목표가 있어야 …           │
├──────────────────────────────────────────────────────┤   ├──────────────────────────────────────────────────────┤
│ ┌──── 📝 빈 상태 안내 (고정 72px) ───────────────┐   │   │   (빈 상태 배너 자리 — 128ms 페이드아웃 후 비움)       │
│ │ 📝 아직 공동 목표가 없습니다.                    │   │   │                                                      │
│ │ 아래 4개 항목을 채우면 저장 + 자동 개발 시작 준비  │   │   │                                                      │
│ │ 이 완료됩니다.                                   │   │   │                                                      │
│ └──────────────────────────────────────────────────┘   │   │                                                      │
│                                                        │   │                                                      │
│ 목표 제목 *                                 0/80       │   │ 목표 제목 *                                11/80      │
│ [ 예: 결제 모듈 보안 강화                   ] ← flat   │   │ [ 결제 모듈 보안 강화                       ] ← amber │
│   리더가 동료들에게 1문장으로 분배할 핵심 제목          │   │   리더가 동료들에게 1문장으로 분배할 핵심 제목          │
│                                                        │   │                                                      │
│ 상세 설명 *                                 0/500      │   │ 상세 설명 *                                76/500     │
│ [ 예: 토큰 검증·AES 암호화·PCI 감사로그 추가.…▼]       │   │ [ 토큰 검증·AES 암호화·PCI 감사로그 추가.▌   ▼]       │
│   20–500자. '완료 판단 기준' 을 함께 써주세요           │   │   20–500자. '완료 판단 기준' 을 함께 써주세요           │
│                                                        │   │                                                      │
│ 우선순위 *   ○ P1  ○ P2  ○ P3    기한 [ 연-월-일 ]     │   │ 우선순위 *   ◉ P1  ○ P2  ○ P3    기한 [2026-04-25]   │
│   (라디오)                                             │   │   (라디오)                                            │
│                                                        │   │                                                      │
│ ┌─ 리더 분배 미리보기 ───────────────────────────┐    │   │ ┌─ 리더 분배 미리보기 ───────────────────────────┐    │
│ │ 🤖 4명에게 분배 예정                            │    │   │ │ 🤖 4명 → "결제 모듈 보안 강화" (P1, ~4/25)      │    │
│ │ · 제목을 먼저 입력해주세요                        │    │   │ │ · Thanos · Aurora · Nova · Orion                 │    │
│ └────────────────────────────────────────────────┘    │   │ └────────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────┤   ├──────────────────────────────────────────────────────┤
│ 💡 저장 직후 자동 개발이 ON 으로 전환됩니다              │   │ 💡 저장 직후 자동 개발이 ON 으로 전환됩니다              │
│                              [취소]  [💾 저장 후 시작]│   │                              [취소]  [💾 저장 후 시작]│
│                              ↑           ↑ disabled   │   │                              ↑           ↑ 활성(검증OK)│
└──────────────────────────────────────────────────────┘   └──────────────────────────────────────────────────────┘
```

### 2B.3 빈 상태 안내 문구 규격 (`empty-create` 전용 배너)

- **아이콘**: `📝` (16px, 카피 왼쪽 8px gap)
- **타이틀** (14px, white/80%, bold): `아직 공동 목표가 없습니다`
- **본문** (12px, white/65%, `--shared-goal-modal-subtle-fg`): `아래 4개 항목을 채우면 저장 + 자동 개발 시작 준비가 완료됩니다.`
- **배경**: `--shared-goal-modal-banner-bg` (cyan glow 을 10% 희석한 `rgba(127,212,255,0.10)`) · 좌측 2px 스트립 `--shared-goal-modal-banner-strip` (= `--shared-goal-modal-field-focus`)
- **높이**: `--shared-goal-modal-banner-height` (72px 고정). `editing` 전이 시 페이드아웃만, layout shift 없음 — 뒤 자리를 카운터/미리보기 등장으로 채움.
- **스크린리더**: `role="status" aria-live="polite"` — 모달 open 시 1회 낭독. `editing` 진입하면 제거되나 배너 자체가 포커스 불가 영역이라 낭독 반복은 없음.

### 2B.4 "폼이 안 보이는" 회귀 차단 체크리스트 (QA 복사해 쓰는 용도)

- [ ] 모달 open 직후 BODY 안에 **제목/설명/우선순위/기한** 4개 컨트롤이 **모두** DOM 에 존재(React DevTools 로 확인)
- [ ] 각 컨트롤의 `display` 가 `none` 이 아님 (open 애니메이션 중 `opacity: 0` 은 허용, `display:none` 은 금지)
- [ ] 첫 포커스가 `#sg-title` 에 걸리고, `placeholder` 가 `예: 결제 모듈 보안 강화` 로 표시
- [ ] 상단 📝 빈 상태 배너가 보이고 aria-live 로 1회 낭독
- [ ] 첫 키 입력 시 배너만 사라지고 **BODY 높이 동일 유지** (크롬 DevTools Performance 의 Layout Shift = 0)
- [ ] `autoDevEnabled=false` + `sharedGoal=null` 상태에서 토글 클릭 → 모달 오픈 → 작성 → 저장 → `sharedGoal` POST 200 → `autoDevEnabled` PATCH 200 순서로 네트워크 요청이 기록됨
- [ ] 저장 실패(500 재현) 시 토글은 여전히 OFF, 모달은 유지, primary 에 shake (200ms)

---

## 3. 진입/이탈 애니메이션

### 3.1 진입 (220ms, cubic-bezier(0.22, 1, 0.36, 1))

| 구간        | 0ms         | 80ms        | 220ms                       |
| ----------- | ----------- | ----------- | --------------------------- |
| backdrop    | opacity 0   | opacity 0.6 | opacity 1 · blur(3px)        |
| dialog      | opacity 0, translateY(+12px), scale(0.98) | opacity 0.85 | opacity 1, translateY(0), scale(1) |
| focus-ring  | 없음         | 없음         | 첫 입력 필드에 소프트 링 1회(180ms)  |

- 진입 방향은 **토글 아래쪽에서 위로 떠오르는** 느낌(translateY 양수 → 0). "토글이 부른 화면" 이라는 심리적 연결을 만든다.
- `prefers-reduced-motion: reduce` 사용자 대상: translateY·scale 전이 제거, opacity 만 120ms 로 단축.

### 3.2 이탈 (160ms)

| 구간     | 0ms        | 160ms                              |
| -------- | ---------- | ---------------------------------- |
| backdrop | opacity 1  | opacity 0 · blur 제거               |
| dialog   | opacity 1  | opacity 0, translateY(+6px), scale(0.985) |

- 취소 또는 × 로 닫을 때는 "토글이 있던 방향으로 다시 내려가는" 작은 translateY 양수로 되돌린다.
- 저장 성공 닫기는 같은 160ms 이지만 `dialog` 테두리를 emerald 로 1 프레임(≤80ms) 플래시해 저장 성공 단서를 남긴다(색각 이상 대응: `✓ 저장됨` 토스트를 동시에 띄움).

### 3.3 실패 시 shake (200ms)

- 서버 4xx/5xx 응답 시 dialog 전체에 `translateX(-6px → +6px → -3px → 0)` 200ms 쉐이크 1회.
- 배경/토글 상태는 변하지 않는다 — 사용자가 아직 모달 안에 있다는 신호.

---

## 4. 포커스 트랩 & 키보드

### 4.1 포커스 트랩 규격

- 모달이 열릴 때 **이전 포커스 요소(자동 개발 토글)** 를 `lastFocus` 로 기억 → 닫힐 때 복원.
- Tab 순환 순서:
  1. `제목` (기본 포커스)
  2. `상세 설명`
  3. 우선순위 라디오그룹(내부는 방향키로 순환, Tab 은 그룹 하나로 취급)
  4. 기한
  5. [취소] 버튼
  6. [목표 저장 후 시작] 버튼
  7. (순환) → 1. `제목`
- Shift+Tab 은 역순. 포커스가 모달 바깥(backdrop·문서 body)으로 빠지지 않도록 첫/마지막 요소에서 순환 강제.
- 모달 바깥 요소는 `inert` 속성 또는 `aria-hidden="true"` 로 스크린리더·포커스 양쪽 차단.

### 4.2 기본 포커스 필드

- 열자마자 **`제목` 입력란에 `autoFocus`**. 방향키/탭 조작 없이 즉시 타이핑 가능.
- 스크린리더 낭독 순서: `role="dialog"` + `aria-labelledby="shared-goal-modal-title"` → 헤더 1문장 → BODY 첫 필드.

### 4.3 단축키 맵

| 키             | 동작                                                               |
| -------------- | ------------------------------------------------------------------ |
| `Esc`          | [취소]. dirty 이면 "작성 중인 내용이 있습니다" 확인 다이얼로그 경유    |
| `Ctrl/⌘ + Enter` | [목표 저장 후 시작]. 폼 검증 통과 시 즉시 확정                       |
| `Tab` / `Shift+Tab` | 포커스 순환(4.1)                                             |
| `Alt + P`      | 우선순위 라디오 그룹으로 바로 이동(접근성 보조)                        |

`Esc` 의 dirty 가드는 **실수 방지** 용도. 제목/설명이 모두 공란이면 즉시 닫고, 하나라도 글자가 있으면 "닫으면 입력이 사라집니다. 그래도 닫을까요?" 확인. 기본 선택은 **취소(모달 유지)** — 작업 보존이 기본값.

---

## 5. 취소/확정 버튼 배치 원칙

### 5.1 배치 규칙

- FOOTER 오른쪽 정렬. 좌측에서 우측 순서: `💡 보조 문구` → `[취소]` → `[목표 저장 후 시작]`.
- 이유:
  1. **읽는 방향(좌→우) 끝에 primary** — 한국어/영어/일본어 모두 "마지막에 결정적 동작" 이 자연스럽다.
  2. `[취소]` 가 primary 왼쪽에 있어, 마우스가 primary 로 향하는 궤적 중간에 "되돌림" 기회를 강조.
  3. macOS 의 [Cancel][OK] 와 Windows 의 [OK][Cancel] 사이에서 **웹 플랫폼 다수 관례** 인 후자를 택해, 학습 비용을 낮춘다.

### 5.2 버튼 스펙

| 속성              | [취소]                              | [목표 저장 후 시작]                                        |
| ----------------- | ----------------------------------- | ---------------------------------------------------------- |
| 역할              | secondary                           | primary + 긍정적 진행                                      |
| 배경              | `transparent` / hover: `--shared-goal-modal-cancel-hover-bg` | `--shared-goal-modal-confirm-bg` (emerald)       |
| 테두리            | `--shared-goal-modal-cancel-border` (white/22%) | `--shared-goal-modal-confirm-border` (#34d399)  |
| 텍스트 색         | `--shared-goal-modal-cancel-fg` (white/80%) | `--shared-goal-modal-confirm-fg` (#052e1b)          |
| 비활성(검증 실패) | —                                   | `--shared-goal-modal-confirm-disabled-bg` + cursor `not-allowed` |
| 로딩              | —                                   | 텍스트를 `저장 중…` 으로 교체 + 내부 스피너 12px         |
| 키보드 힌트       | `Esc`                               | `⌘/Ctrl + Enter`                                           |

### 5.3 primary 카피 "목표 저장 후 시작"

- 단순 "저장" 대신 **"시작"** 이라는 결과를 약속. 사용자는 "이 버튼을 누르면 자동 개발이 ON 이 된다" 는 것을 라벨만으로 이해한다.
- FOOTER 좌측 💡 문장이 이 약속을 재확인: "저장 직후 자동 개발이 ON 으로 전환되고 리더가 즉시 분배를 시작합니다."

---

## 6. 자동 개발 토글과의 시각적 연결

토글과 모달을 **같은 맥락** 으로 묶기 위한 4개 장치.

### 6.1 토글 주변 헬퍼 문자열 (공통)

- 토글 라벨 옆 `<span class="sgm-helper">` 로 얇은 설명 1줄:
  - 목표 **없음**: `"⚑ 클릭 시 공동 목표 입력 창이 열립니다"` (white/55%)
  - 목표 **있음**: `"✓ 목표 저장됨 · 지금 켜면 리더가 즉시 분배 시작"` (emerald/85%)
  - 실행 **중**: `"◔ 리더 분배 진행 중 · 끄면 WAIT 신호 송신"` (sky/85%)
- 폭 좁은 레이아웃(<640px)에서는 줄바꿈 후 줄간격 1.4em, 절대 truncate 하지 않는다(정보 누락 금지).

### 6.2 hover/focus 툴팁 (목표 없음 상태)

- 토글에 포커스 또는 hover 가 들어오면 250ms delay 후 상단 툴팁:
  > "아직 공동 목표가 없습니다. 클릭 시 목표 등록 창이 열립니다."
- 툴팁은 `role="tooltip"` + `aria-describedby` 로 토글과 연결. 키보드 포커스만으로도 동일하게 나타난다.

### 6.3 토글 → 모달 연속 애니메이션

- 토글 클릭 지점에서 모달 중심까지 **140ms highlight ring** 이 이어진다. 픽셀 크기: 6px → 280px 로 확장하며 `--shared-goal-modal-link-glow` 사용.
- `prefers-reduced-motion: reduce` 에서는 ring 대신 정적 1px outline 만 150ms 노출.

### 6.4 모달 상단 앵커 마크

- 모달 HEADER 좌측에 `◇` 마크(cyan glow). 마우스로 이 마크에 hover 하면 토글 위치에 "여기서 열렸습니다" 라는 아래쪽 arrow 점선이 150ms 나타난다. 사용자가 "이 모달이 어디서 왔는지" 를 잃어버리지 않는다.

---

## 7. 검증 규칙 & 에러 표시

### 7.1 필드별 검증

| 필드        | 규칙                          | 에러 카피                                        |
| ----------- | ----------------------------- | ------------------------------------------------ |
| 제목        | 4~80자, 공백 제외              | "4자 이상 80자 이하로 입력해주세요"               |
| 상세 설명   | 20~500자                       | "20자 이상 500자 이하로 입력해주세요"             |
| 우선순위    | P1/P2/P3 중 1개 필수            | "우선순위를 선택해주세요"                          |
| 기한        | 선택 · 오늘 이후                | "오늘 이후 날짜만 선택할 수 있어요"                |

### 7.2 표시 방식

- 실시간 inline 검증(blur 시점). 필드 하단 4px 스트립이 `--shared-goal-modal-error-strip` 으로 점등 + 12px 에러 카피.
- 서버 4xx 응답(동일 프로젝트에 이미 active 목표 존재 등): 헤더 아래 `role="alert"` 배너 1회 + 해당 필드 스트립 동시 점등.
- primary 버튼은 모든 검증 통과 전까지 `disabled`. 사용자는 "어디를 고쳐야 하는지" 를 스트립 색과 카피로 즉시 파악.

---

## 8. index.css 토큰 — `--shared-goal-modal-*` (이번 PR 선-도입)

기존 `--shared-goal-*` (인라인 폼 상태 팔레트) 와 **이름 공간을 분리** 해 서로 독립 조정 가능하게 한다. 모달이 인라인 폼의 `saved` 배지 팔레트(emerald) 를 confirm 버튼에 재사용하도록 숫자를 맞춰 "같은 동작 = 같은 색" 을 지킨다.

| 토큰                                     | 값                                   | 용도                                |
| ---------------------------------------- | ------------------------------------ | ----------------------------------- |
| `--shared-goal-modal-backdrop`           | `rgba(10, 10, 25, 0.72)`             | 배경 딤                              |
| `--shared-goal-modal-backdrop-blur`      | `3px`                                | backdrop-filter                     |
| `--shared-goal-modal-surface`            | `#0f1b3b`                            | 다이얼로그 바탕                       |
| `--shared-goal-modal-surface-border`     | `rgba(127, 212, 255, 0.35)`          | 다이얼로그 테두리(cyan glow)         |
| `--shared-goal-modal-header-fg`          | `#ffffff`                            | 헤더 제목                            |
| `--shared-goal-modal-subtle-fg`          | `rgba(255, 255, 255, 0.65)`          | 헤더 부제 · 💡 보조 문구             |
| `--shared-goal-modal-field-border`       | `rgba(255, 255, 255, 0.18)`          | 입력 필드 테두리                      |
| `--shared-goal-modal-field-focus`        | `#7fd4ff`                            | 포커스 링                             |
| `--shared-goal-modal-error-strip`        | `#f87171`                            | 검증 실패 필드 우측 4px 스트립       |
| `--shared-goal-modal-cancel-border`      | `rgba(255, 255, 255, 0.22)`          | 취소 테두리                           |
| `--shared-goal-modal-cancel-fg`          | `rgba(255, 255, 255, 0.80)`          | 취소 텍스트                           |
| `--shared-goal-modal-cancel-hover-bg`    | `rgba(255, 255, 255, 0.06)`          | 취소 hover                            |
| `--shared-goal-modal-confirm-bg`         | `#34d399`                            | 확정 배경(emerald)                    |
| `--shared-goal-modal-confirm-border`     | `#34d399`                            | 확정 테두리                           |
| `--shared-goal-modal-confirm-fg`         | `#052e1b`                            | 확정 텍스트(짙은 녹음)                |
| `--shared-goal-modal-confirm-hover-bg`   | `#4ade80`                            | 확정 hover                            |
| `--shared-goal-modal-confirm-disabled-bg` | `rgba(52, 211, 153, 0.25)`          | 비활성                                |
| `--shared-goal-modal-link-glow`          | `rgba(127, 212, 255, 0.55)`          | 토글 → 모달 연속 링                   |
| `--shared-goal-modal-shake-amp`          | `6px`                                | 실패 시 쉐이크 진폭                    |
| `--shared-goal-modal-radius`             | `10px`                               | 다이얼로그 모서리                     |
| `--shared-goal-modal-shadow`             | `0 18px 48px rgba(0, 0, 0, 0.55)`    | 다이얼로그 드롭섀도우                  |

**§2A/§2B 파생 토큰** (2026-04-19 Designer 자율 개선으로 `src/index.css` 에 선-분리):

| 토큰                                               | 값                                   | 용도                                                                     |
| -------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| `--shared-goal-modal-banner-bg`                    | `rgba(127, 212, 255, 0.10)`          | `empty-create` 빈 상태 배너 배경(cyan glow 희석)                          |
| `--shared-goal-modal-banner-strip`                 | `var(--shared-goal-modal-field-focus)` | 배너 좌측 2px 스트립(= field-focus cyan)                                |
| `--shared-goal-modal-banner-height`                | `72px`                               | 배너 고정 높이 · `editing` 전이 시 페이드아웃만, layout shift 0 계약의 근거 |
| `--shared-goal-modal-body-min-height`              | `360px`                              | BODY 최소 높이 · 두 상태 공용으로 모달 크기 변화 차단                      |
| `--shared-goal-modal-placeholder-fg`               | `rgba(255, 255, 255, 0.42)`          | 플레이스홀더 글자색 — 힌트(65%)보다 한 단계 더 흐리게                      |
| `--shared-goal-modal-field-editing-border`         | `#fbbf24`                            | `editing` 상태 필드 amber 테두리(1px, 인라인 폼 `--shared-goal-border-editing` 과 숫자 일치) |
| `--shared-goal-modal-field-editing-strip`          | `#fbbf24`                            | `editing` 상태 필드 좌측 2px 수직 amber 스트립                            |
| `--shared-goal-modal-counter-fg`                   | `rgba(255, 255, 255, 0.55)`          | 글자 수 카운터 정상 색(subtle-fg 보다 살짝 낮춰 보조 정보임을 시사)        |
| `--shared-goal-modal-counter-error-fg`             | `var(--shared-goal-modal-error-strip)` | 글자 수 카운터 초과/미달 색(= error-strip 과 동일)                     |

**대비 검증** (패널 배경 #0f1b3b 기준):
- header-fg(#fff) : 15.8:1 · AAA
- subtle-fg(white/65%) : 8.6:1 · AAA
- field-focus(#7fd4ff) : 8.1:1 · AAA
- confirm-fg(#052e1b) on confirm-bg(#34d399) : 6.3:1 · AA 본문
- placeholder-fg(white/42%) : 5.6:1 · AA 본문(힌트/값보다 한 단계 낮춘 의도적 위계)
- counter-fg(white/55%) : 7.2:1 · AAA
- field-editing-border(#fbbf24) : 8.7:1 · AAA

**색각 이상 대응**: emerald/red 단색에만 의존하지 않도록
- 확정 버튼에 `✓` 아이콘 병기
- 에러 스트립 옆에 `⚠` 아이콘 + 텍스트 병기
- 저장 성공 플래시에 `✓ 저장됨` 토스트 병기

---

## 9. 접근성 (a11y) 체크리스트

- [ ] `role="dialog"` + `aria-modal="true"` + `aria-labelledby="shared-goal-modal-title"` + `aria-describedby="shared-goal-modal-subtitle"`
- [ ] 모달 바깥 본문에 `inert` 또는 `aria-hidden="true"` 적용(IE/구 Safari 폴리필)
- [ ] 첫 포커스: 제목 input (4.2 규격)
- [ ] 닫을 때 `lastFocus` 복원 (토글)
- [ ] Tab 순환 강제 (4.1 규격)
- [ ] `Esc` 는 dirty 가드 경유 (4.3)
- [ ] 모든 필수 필드 `aria-required="true"`, 에러는 `aria-describedby` + `role="alert"` 로 1회 낭독
- [ ] 라디오그룹 `role="radiogroup"` + 방향키 순환
- [ ] `prefers-reduced-motion: reduce` 경로 별도 준수
- [ ] 확정 버튼의 "저장 중…" 상태는 `aria-busy="true"` + `aria-live="polite"` 로 진행 낭독
- [ ] 모바일 VoiceOver: `aria-modal` 로 로터 외부 진입 차단

---

## 10. 구현 메모 (Thanos 인계용)

1. **컴포넌트 위치**: `src/components/SharedGoalModal.tsx` 신규 파일. `ProjectManagement.tsx` / `GitAutomationPanel.tsx` 에서 `autoDevEnabled` 토글 onChange 가드 안에서 open 상태 관리.
2. **상태 모델**: `{ open: boolean, initialValues?: Partial<SharedGoal>, mode: 'create' | 'edit' }`. 생성 모드는 본 시안 대상, 편집 모드는 인라인 폼의 readOnly 해제와 결합(후속).
3. **데이터 소스**: `POST /api/projects/:id/shared-goal` (server.ts line 972~1016 참조 — 이미 존재). 모달 확정 → 저장 성공 → `useProjectOptions.update({ autoDevEnabled: true })` 를 연이어 호출.
4. **실패 회귀 방지**: `project-settings-save-load-regression-20260419.md` 의 S1/S3 시나리오에서 `autoDevEnabled` 와 `sharedGoal` 이 **서로 다른 엔드포인트** 에 저장됨을 확인. 모달 구현 시 `sharedGoal` 저장이 500 인데 토글이 ON 으로 잘못 전환되는 회귀를 테스트에 추가할 것(`tests/sharedGoal.regression.test.ts` 근처).
5. **토큰 사용**: 본 문서 §8 의 `--shared-goal-modal-*` 를 그대로 소비. 기존 `--shared-goal-*` (인라인 폼) 는 건드리지 않는다.
6. **Storybook 대체 미리보기**: `tests/shared-goal-modal-mockup.svg` — §2B 의 `empty-create` vs `editing` 두 상태를 나란히 렌더(2026-04-19 본 PR 에서 같이 제공). 디자인 토큰을 그대로 하드코딩해, 소스와 시안이 갈라지는지 diff 만으로 감지 가능.
7. **리더 프롬프트 연결**: 저장 성공 payload 를 `src/server/prompts.ts` 의 리더 블록에 주입 — 이미 존재하는 `SharedGoal` 타입의 title/priority/dueDate 가 그대로 프롬프트 변수로 활용.

---

## 11. 관련 후속 작업 후보

1. 본 문서 기반으로 `SharedGoalModal.tsx` 실제 구현 (별도 지시).
2. 편집 모드(기존 목표 수정) 를 위한 별도 모달 or 인라인 해제 — §10-2 의 `mode='edit'`.
3. 저장 직후 ON 전환 실패(네트워크 분할) 시 롤백 UX: 토글을 0.4s 유지 후 OFF 로 돌리고 "자동 개발 시작에 실패했어요. 목표는 저장되었습니다" 토스트 + 재시도 CTA.
4. 다국어: 본 시안의 한국어 카피를 i18n 리소스로 분리(영어는 동일 의미의 결과 지향 카피로 번역).
