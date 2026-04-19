# 구독 토큰 폴백(F4) 영구 배너 + 재로그인 유도 CTA 시안 (2026-04-19)

관련 선행 문서:
- `tests/token-fallback-states-mockup.md` (2026-04-19) — F1~F4 4단계 전체 명세. 본 시안은
  그 §4.1 (AuthGate 전역 배너) 과 §4.3 (재인증 플로우) 를 **시각 계층·카피 톤** 수준까지
  세분화한 후속 강화이다.
- `tests/accessibility-audit-checklist.md` (2026-04-19, 본 라운드 신규) — A2 항목 "배지 레벨에서
  F4 진입 즉시 낭독" · B3 "saved 플래시 축소 모션 가드" 와 교차.
- `src/components/ToastProvider.tsx` — F4 전이 토스트(duration 0 = 무기한) 가 이미 본 배너와
  동시에 뜨는 구조. 본 시안은 "배너가 없어지지 않는 동안에도 토스트는 닫힐 수 있다" 는
  책임 분담을 명시한다.
- `src/components/AuthGate.tsx` — 배너가 얹히는 최상위 프레임. F4 전용 sticky 배너를 children
  직전에 렌더.

목표: F4 (`fallback-readonly`) 상태에서 사용자가 **초점이 어디 있든** "왜 잠겼고 어떻게 푸는가"
를 즉시 이해하고, **단 하나의 CTA** 로 복귀할 수 있도록 시각 계층·카피 톤을 고정한다.

---

## 0. 설계 원칙 (R-01 ~ R-08)

| ID   | 원칙                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| R-01 | **영구 배너는 1행 40px** — 화면 공간은 최소만 점유. 본문이 스크롤되어도 sticky 로 유지.                                           |
| R-02 | **단일 CTA 원칙** — "재충전" 혹은 "재인증" 중 상황에 맞는 **한 개만**. 두 개를 병치하면 사용자는 선택 장애로 둘 다 안 누른다.        |
| R-03 | **담담한 카피 톤** — "만료" 사실을 전달하되 비난/경고/공포 어휘 금지. "지금 복귀할 수 있어요" 의 회복 가능성을 문장 끝에 남긴다.     |
| R-04 | **색 + 자물쇠 아이콘 + 텍스트** — 배너 좌측 4px 스트립은 회색 실선, 본문에 🔒 + "읽기 전용" 명시. 색만 의존 금지(색각 이상).        |
| R-05 | **키보드 접근성** — `Tab` 포커스 1회 순환에 반드시 CTA 가 포함. `Alt+R` 단축키로 배너 CTA 로 직행(접근성 체크리스트 A2 연동).        |
| R-06 | **스크린리더는 진입 시 1회** — `role="alert"` 로 1회 낭독, 이후 배너가 유지돼도 반복 낭독하지 않는다(스크린리더 피로 방지).         |
| R-07 | **토스트와 역할 분리** — 토스트는 "방금 상태가 바뀌었다" 의 **시점 알림**. 배너는 "지금 이 상태에 있다" 의 **현재 상태 표시**.      |
| R-08 | **복귀 성공 시 0ms 내 사라짐** — 재인증/재충전 성공 응답 수신 즉시 배너 DOM 제거. 180ms fade-out 으로 부드럽게 덮어 깜빡임 없앰.    |

---

## 1. 배너 시각 계층 (ASCII)

```
┌─────────────────────────────────────────── AuthGate (최상위) ──────────────────────────────────┐
│ ┌───── 상단바 (56px) ───────────────────────────────────────────────────────────────────────┐ │
│ │ [로고] LLMTycoon                                         [Thanos·Joker·…] [🔒 토큰 배지]    │ │
│ └──────────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌────────────────── F4 영구 배너 (sticky, z-index 29, 40px 고정) ────────────────────────────┐ │
│ │ ▌🔒 구독 토큰이 만료되어 읽기 전용 모드입니다.                     ┃ [💳 재충전하고 돌아가기]│ │
│ │ │ 잔여 0% · 2026-04-19 12:34 만료 · 자동 갱신 OFF · 모든 저장 기능이 잠겼어요              │ │
│ └──────────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌── children (ProjectManagement · SharedGoalForm · DirectivePrompt · …) ─────────────────────┐ │
│ │ ● 모든 쓰기 버튼은 `aria-disabled="true"` + 53% opacity + "🔒 잠금 — 재충전 필요" 툴팁       │ │
│ │ ● 읽기 패널(로그·에이전트 카드·통계) 은 평상시와 동일하게 렌더                              │ │
│ └──────────────────────────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 배너 세부 규격

| 요소                | 규격                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| 높이                | `var(--token-fallback-banner-height, 40px)` 고정. 반응형 축약 ≤ 640px 에서 `--token-fallback-banner-height-compact, 56px` 로 2행. |
| 배경                | `var(--token-fallback-readonly-bg, rgba(255,255,255,0.06))` (회색 틴트)                                     |
| 좌측 스트립         | `border-left: 4px solid var(--token-fallback-readonly-strip)` (white/45%)                                   |
| 글자 색(제목)       | `var(--token-fallback-banner-title-fg, rgba(255,255,255,0.92))` — 본 PR 신규                                |
| 글자 색(부제)       | `var(--token-fallback-readonly-fg, rgba(255,255,255,0.80))`                                                 |
| 자물쇠 아이콘       | `lucide-react` 의 `Lock` 14px, 색 `var(--token-fallback-readonly-icon)`                                     |
| 그림자              | `var(--token-fallback-banner-shadow, 0 2px 8px rgba(0,0,0,0.35))` — 상단바 아래 낮은 층위 그림자             |
| z-index             | `var(--token-fallback-banner-z-index, 29)` — 상단바(30) 바로 아래, 모달 backdrop(100) 보다 훨씬 낮음           |
| CTA 버튼 배경       | `var(--token-fallback-banner-cta-bg, var(--shared-goal-modal-confirm-bg))` — emerald                          |
| CTA 버튼 글자       | `var(--token-fallback-banner-cta-fg, var(--shared-goal-modal-confirm-fg))` — 짙은 세피아(#052e1b)             |
| CTA 높이            | 28px (배너 40px 중 6px 상하 패딩으로 수직 가운데)                                                             |
| CTA 내부 패딩        | 4px 12px                                                                                                    |
| CTA 포커스          | 전역 `:focus-visible` 규칙이 cyan 링으로 덮음(`--focus-ring-*`). F4 는 회색이지만 CTA 는 emerald 유지로 "조치 가능" 을 색으로도 전달. |
| CTA 단축키           | `aria-keyshortcuts="Alt+R"` — 접근성 체크리스트 A2                                                             |

### 1.2 카피 톤 — 3단 구조

배너의 텍스트는 **한 줄 제목 + 한 줄 부제** 구조로 분리한다. 두 문장 모두 주어가 명확하고 존댓말 유지.

| 슬롯    | 카피 예시                                                           | 규칙                                                                             |
| ------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 제목    | **"구독 토큰이 만료되어 읽기 전용 모드입니다"**                         | "만료", "잠금" 같은 명사만. 감탄/경고 어휘 금지("⚠️ 위험!" 금지).                   |
| 부제    | 잔여 0% · YYYY-MM-DD HH\:mm 만료 · 자동 갱신 OFF · 모든 저장 기능이 잠겼어요 | 사실만 · 숫자만. 이유를 추측하지 않는다("결제 실패일 수 있어요" 금지).              |
| CTA     | **"재충전하고 돌아가기"** 또는 **"재인증하고 돌아가기"**                  | 결과 지향 동사 — "저장 후 시작" 패턴과 동일(§SharedGoalModal §5.3).                |
| CTA 힌트 | (기본 숨김, hover/focus 시 툴팁) "Alt+R 단축키로도 열 수 있어요"       | 단축키는 카피가 아닌 툴팁·aria-keyshortcuts 로만 전달.                             |

**카피 금지어**:
- "긴급", "경고", "위험", "실패", "오류", "끊김", "중단" — 원인이 불확실하거나 복귀 가능한 상태에서 불필요한 공포 조성.
- "다시 시도", "재시도" — 일반적 실패 복구와 혼동. 이 화면은 **구독 갱신** 맥락이므로 "재충전/재인증/돌아가기" 로 특정.
- "?", "!" 의 연속 — 한 문장에 1개만.

### 1.3 CTA 라벨 분기 규약

| 서버 응답 컨텍스트                                       | CTA 라벨                 | 클릭 동작                                                         |
| ---------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------- |
| `allowance.reason === 'balance-exhausted'`                 | `💳 재충전하고 돌아가기`  | 외부 결제 페이지 새 탭 오픈 + 본 탭은 폴링 재시작                 |
| `allowance.reason === 'session-expired'` (세션 만료)       | `🔑 재인증하고 돌아가기`  | `LoginForm` 축약 모달 오픈. 성공 시 allowance 재조회              |
| `allowance.reason === 'key-revoked'`                       | `🔒 새 API 키 발급받기`   | 관리자 설정 페이지로 이동(onPremise) 또는 가이드 링크(SaaS)       |
| `allowance.reason === 'unknown'`                           | `🆘 지원에 문의하기`       | 사전 정의된 문의 링크(외부). 이 경우에만 2차 링크 "문서 보기" 허용 |

**기본값**: `reason` 누락이면 `balance-exhausted` 로 간주(가장 흔한 케이스).

---

## 2. 시각 계층 — 배너 vs 토스트 vs 개별 버튼 잠금

"동시에 세 가지 시각 단서가 뜬다" 는 것이 F4 의 핵심 경험이다. 각 단서의 **역할** 을 분리해
사용자가 혼란스러워하지 않도록 한다.

### 2.1 층별 책임

| 층           | 역할                                                                                                 | 수명                                                |
| ------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 상단바 배지(ClaudeTokenUsage) | "토큰 사용량" 축의 연장 — 🔒 아이콘 + 회색 테두리 + "읽기 전용" 카피 (배지 내 축약)                    | F4 지속 동안                                        |
| F4 영구 배너(본 시안)          | "지금 이 상태에 있다" 의 **현재 상태 표시** + 단일 CTA                                                | F4 지속 동안                                        |
| 전이 토스트(ToastProvider)    | "방금 F3 → F4 로 바뀌었다" 의 **시점 알림** + 동일 CTA 재제공(편의)                                  | 사용자가 ✕ 를 누를 때까지(duration 0)             |
| 개별 쓰기 버튼 잠금            | "이 버튼은 지금 못 누른다" 의 **지점별 설명** — `aria-disabled` + 53% opacity + 툴팁 "🔒 재충전 필요" | F4 지속 동안, 각 버튼 자체 상태                   |

### 2.2 중복 CTA 허용 규칙

배지·배너·토스트 세 곳에 CTA 가 동시에 나올 수 있다. 원칙 R-02 는 "한 층에 한 개" 이지, "화면
전체에 한 개" 는 아니다. 세 CTA 는 **완전히 같은 동작** 을 호출해야 하고, 라벨과 아이콘도 동일.
아래 규칙으로 중복을 정당화:

1. **동일 라벨 · 동일 아이콘 · 동일 클릭 콜백** — `openFallbackRecoveryCTA(reason)` 단일 함수를 공유.
2. **토스트의 CTA 가 눌리면 토스트 먼저 닫히고 배너의 CTA 포커스로 이동** — 연속 조작의 연결성.
3. **배지의 CTA 는 배지 내부가 좁아 아이콘만 노출** — hover/focus 시 툴팁으로 라벨 풀어 보여 준다.

### 2.3 색 톤 위계 (다른 상태 대비)

| 화면 요소                    | 색                                                   | 의미                             |
| ---------------------------- | ---------------------------------------------------- | -------------------------------- |
| F4 영구 배너                 | `--token-fallback-readonly-bg` + 회색 스트립        | 현재 상태 (조치 가능)            |
| F3 배너(폴백 이전 단계)      | `--token-fallback-warning-bg` + red 스트립 + pulse   | 임박 경고(사용자의 주의 필요)    |
| 일반 오류(ErrorState)        | `--error-state-bg` + red 실선 + ⚠                    | 작업 실패(즉시 재시도 권함)     |
| 토스트(error variant)        | `--toast-error-bg` + red 스트립 + 아이콘 Ban        | 시점 알림(방금 발생)             |
| CTA (모두 공용)              | `--shared-goal-modal-confirm-bg` emerald            | 조치 가능 — "여기 누르면 복구"   |

**핵심 원칙**: 상태 배경은 **회색**(조용한 현재), CTA 는 **emerald**(행동 가능). 두 색이 한
화면에 동시에 있는 것이 회복 가능성의 시각 언어다.

---

## 3. 카피 전체 문장 모음 (i18n 대비)

아래 문자열들은 `src/i18n/tokenFallback.ko.ts` (신규 예정) 에 분리해, 번역이 들어와도 라벨·제목·
부제·단축키 힌트가 독립적으로 갱신될 수 있게 한다.

```ts
export const tokenFallbackKo = {
  banner: {
    title: '구독 토큰이 만료되어 읽기 전용 모드입니다',
    subtitleTpl: (ctx: { remainingPct: number; expiredAt: string; autoRenew: boolean }) =>
      `잔여 ${ctx.remainingPct}% · ${ctx.expiredAt} 만료 · 자동 갱신 ${ctx.autoRenew ? 'ON' : 'OFF'} · 모든 저장 기능이 잠겼어요`,
    ctaByReason: {
      'balance-exhausted': { label: '재충전하고 돌아가기', icon: '💳', shortcut: 'Alt+R' },
      'session-expired':   { label: '재인증하고 돌아가기', icon: '🔑', shortcut: 'Alt+R' },
      'key-revoked':       { label: '새 API 키 발급받기',  icon: '🔒', shortcut: 'Alt+R' },
      'unknown':           { label: '지원에 문의하기',       icon: '🆘', shortcut: 'Alt+R' },
    },
    dismissTitle: '지금은 이 배너를 닫을 수 없어요',
    dismissDescription: '읽기 전용 모드 동안에는 배너가 계속 표시됩니다. 복귀 후 자동으로 사라져요.',
  },
  writeGuard: {
    disabledTooltip: '🔒 재충전 필요 — 구독 토큰이 복구되면 자동으로 잠금이 풀립니다',
    srLabel: '쓰기 잠금 상태',
  },
  recoverToast: {
    successTitle: '읽기 전용 모드에서 복귀했습니다',
    successDescription: '직전 작성 중이던 지시·목표는 그대로 보존되어 있어요.',
  },
};
```

**카피 규약**:
1. **이모지는 CTA 에 하나만** — 본문에는 🔒 만 허용. 🎉/🎊 등 기쁨 이모지는 복귀 토스트에서도 금지.
2. **자동 갱신 ON/OFF 는 대문자** — 사용자가 "갱신 설정" 을 식별하는 고정 단서. 번역해도 유지.
3. **"돌아가기" 어미는 CTA 전용** — 배너 본문에서는 쓰지 않는다(이중 약속 방지).

---

## 4. 애니메이션 · 축소 모션 규약

| 경로                      | 기본                                                              | `prefers-reduced-motion: reduce`          |
| ------------------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| 배너 진입(F3 → F4)        | 상단에서 translateY(-100%) → 0 · 220ms · cubic-bezier(0.22, 1, …) | opacity 0 → 1 · 120ms                     |
| 배너 이탈(F4 → F1)        | opacity 1 → 0 · 180ms + translateY(-10%)                           | opacity 1 → 0 · 120ms(translate 없음)     |
| CTA 버튼 hover             | background lighten 6%                                             | 동일(transition 없음)                     |
| CTA 포커스 링              | cyan box-shadow 120ms                                             | transition 없음                           |
| 자물쇠 아이콘 흔들림        | **없음** — 자물쇠는 정적 아이콘이어야 "고정" 의 메시지가 유지됨    | —                                         |
| 복귀 플래시(배지)          | emerald 테두리 160ms 플래시                                        | 플래시 제거, 색만 즉시 emerald → 원상      |

**핵심 규약**: F4 자체는 "시간이 지나도 바뀌지 않는 사실" 이므로 배너에 지속 애니메이션(pulse, shimmer,
blink) 을 **절대 넣지 않는다**. 지속 애니메이션은 "상태가 아직 확정되지 않음/진행 중" 을 의미하는데,
F4 는 그 반대다.

---

## 5. 스크린리더 낭독 순서 (VoiceOver/NVDA 공통 시나리오)

### 5.1 F3 → F4 진입

1. 기존 F3 경고 pulse 가 멈추고 즉시 배너 진입 애니메이션 시작.
2. 배너 루트가 `role="alert" aria-live="assertive"` 로 설정 — 한 번 낭독:
   > "구독 토큰이 만료되어 읽기 전용 모드입니다. 잔여 0%, 2026년 4월 19일 12시 34분 만료,
   > 자동 갱신 OFF. 모든 저장 기능이 잠겼어요. 재충전하고 돌아가기 버튼. 단축키 Alt+R."
3. 이후 사용자가 Tab 으로 이동해도 배너 자체는 **더 낭독되지 않음** — `aria-live` 속성은 첫 삽입
   1회만 트리거.

### 5.2 F4 유지 중 CTA 클릭

1. 사용자가 CTA 에 포커스 → 포커스 링(cyan) 노출 + 스크린리더는 **버튼 역할 + 라벨 + 단축키** 만 낭독.
2. 클릭/Enter → 외부 결제 페이지가 새 탭으로 오픈. 본 탭은 폴링 시작.
3. 폴링 중에는 배너 자체는 그대로, 토스트는 자동으로 사라지거나 사용자가 ✕ 눌러 닫을 수 있음.
4. 성공 응답 수신 → 복귀 플래시 + 토스트 "읽기 전용 모드에서 복귀했습니다" 낭독.

### 5.3 사용자 스크린리더 플로우 검증 포인트

- [ ] 배너 진입 시 1회 낭독 · 유지 중 반복 낭독 없음
- [ ] CTA 포커스 시 "버튼, 재충전하고 돌아가기, 단축키 Alt R" 순 낭독
- [ ] 쓰기 버튼에 포커스 들어가면 `aria-disabled="true"` 와 툴팁이 함께 낭독되어 **이유** 를 즉시 전달
- [ ] 복귀 성공 토스트는 `polite` 로 한 번 낭독 · 쌓이지 않음

---

## 6. index.css 토큰 보강 (본 PR)

기존 `--token-fallback-readonly-*` (5종) 를 그대로 두고, **배너 특화 서브셋** 을 추가한다.
이름 공간을 `--token-fallback-banner-*` 로 분리하는 이유: `token-fallback-readonly-*` 는 "F4
상태의 색 계열" 전반(배지·패널 섹션에서도 사용) 이라 배너 단일 맥락의 미세 조정이 필요하면
배너 토큰만 독립 조정 가능해야 한다.

### 6.1 배너 타이포·구조 (신규)

| 토큰                                      | 값                                 | 용도                                           |
| ----------------------------------------- | ---------------------------------- | ---------------------------------------------- |
| `--token-fallback-banner-title-fg`        | `rgba(255, 255, 255, 0.92)`        | 제목 글자(본문보다 한 단계 강함 — 13.5:1 AAA) |
| `--token-fallback-banner-title-size`      | `13px`                             | 제목 폰트 사이즈                               |
| `--token-fallback-banner-title-weight`    | `700`                              | 제목 굵기                                      |
| `--token-fallback-banner-subtitle-size`   | `11px`                             | 부제 폰트 사이즈                               |
| `--token-fallback-banner-gap`             | `12px`                             | 제목 ↔ 부제 간격                               |
| `--token-fallback-banner-padding`         | `8px 16px`                         | 배너 내부 패딩                                 |
| `--token-fallback-banner-radius`          | `0`                                | sticky 배너는 둥근 모서리 없음(경계 명확)      |
| `--token-fallback-banner-strip-width`     | `4px`                              | 좌측 세로 스트립 두께                          |
| `--token-fallback-banner-height-compact`  | `56px`                             | ≤ 640px 반응형 2행 높이                        |

### 6.2 CTA 상세 (신규)

| 토큰                                         | 값                                               | 용도                                         |
| -------------------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| `--token-fallback-banner-cta-padding`        | `4px 12px`                                       | 버튼 내부 패딩                                |
| `--token-fallback-banner-cta-height`         | `28px`                                           | 배너 40px 안에서 수직 가운데 정렬 기준         |
| `--token-fallback-banner-cta-radius`         | `4px`                                            |                                               |
| `--token-fallback-banner-cta-hover-bg`       | `var(--shared-goal-modal-confirm-hover-bg)`      | hover 밝기 상승 emerald-300                   |
| `--token-fallback-banner-cta-icon-size`      | `14px`                                           | 이모지·Lucide 아이콘 공용 크기                |
| `--token-fallback-banner-cta-shortcut-fg`    | `rgba(5, 46, 27, 0.65)`                         | 툴팁 안의 단축키 힌트 글자(confirm-fg 위에 투명도 내려 2차 위계) |

### 6.3 애니메이션 (신규)

| 토큰                                           | 값                                                  | 용도                                    |
| ---------------------------------------------- | --------------------------------------------------- | --------------------------------------- |
| `--token-fallback-banner-enter-duration`       | `220ms`                                             | 진입 길이                                |
| `--token-fallback-banner-enter-easing`         | `cubic-bezier(0.22, 1, 0.36, 1)`                    | SharedGoalModal 과 동일 easing          |
| `--token-fallback-banner-exit-duration`        | `180ms`                                             | 이탈 길이                                |
| `--token-fallback-banner-enter-y-amp`          | `-100%`                                             | 상단에서 내려오는 translateY 시작 값    |
| `--token-fallback-banner-exit-y-amp`           | `-10%`                                              | 이탈 시 살짝 올라가며 사라짐            |

### 6.4 쓰기 잠금 글로벌 규칙 훅 (신규)

```css
html[data-fallback="F4"] [data-writable-guard] {
  pointer-events: none;
  opacity: var(--token-fallback-writable-guard-opacity, 0.53);
  cursor: not-allowed !important;
}
html[data-fallback="F4"] [data-writable-guard]::after {
  content: "🔒";
  font-size: 10px;
  margin-left: 6px;
  opacity: 0.8;
}
```

| 토큰                                             | 값       | 용도                                        |
| ------------------------------------------------ | -------- | ------------------------------------------- |
| `--token-fallback-writable-guard-opacity`        | `0.53`   | 비활성 버튼 투명도(WCAG 비본문 대비 4.6:1 확보) |

---

## 7. 실패 케이스 대응 (엣지)

| 상황                                                         | UX                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 재충전 외부 페이지에서 성공했지만 본 탭 폴링이 10초 내 응답 없음 | 배너 그대로 유지 + 토스트(`info`)로 "재충전이 감지되면 자동 복귀합니다" 1회 · 추가 폴링 30초 간격 |
| 외부 페이지 오픈 실패(새 탭 차단)                             | CTA 클릭 즉시 **인라인 링크 폴백** — 같은 탭에서 이동, 돌아오면 `window.focus` 이벤트로 폴링 재개    |
| F4 상태에서 네트워크 완전 단절                                | 배너 위에 ErrorState 배너 1건 스택 가능(수직 쌓기). 단, 두 배너가 동시에 있을 때 총 높이 ≤ 88px      |
| 로그인 세션만 만료(토큰은 유효)된 세션-만료 케이스            | `reason='session-expired'` · 라벨 `🔑 재인증하고 돌아가기` · 클릭 시 LoginForm 축약 모달              |
| 관리자가 강제로 폴백 해제(OnPremise) — 배너 도중 F4 해제       | R-08 원칙에 따라 180ms fade-out. 쓰기 버튼 잠금 해제는 CSS 변수 데이터 속성이 빠지며 자동 해제   |

---

## 8. 회귀 방지 체크리스트 (QA 복사용)

- [ ] F4 진입 시 배너가 상단바 바로 아래 sticky 로 40px 출현. 스크롤해도 유지.
- [ ] 배너가 1회 `role="alert"` 로 낭독되고 유지 동안 추가 낭독 없음.
- [ ] CTA 는 `reason` 별로 라벨·아이콘 정확히 분기. 기본값은 `balance-exhausted`.
- [ ] CTA 클릭 = 배지의 CTA = 토스트 action 클릭 — 셋 다 동일한 `openFallbackRecoveryCTA(reason)` 호출.
- [ ] Tab 으로 CTA 에 즉시 도달 가능. Alt+R 단축키도 동일 동작.
- [ ] 모든 쓰기 버튼이 `aria-disabled="true"` + opacity 53% + 🔒 툴팁.
- [ ] 축소 모션 환경에서 진입·이탈이 opacity 120ms 로만 실행됨(translateY 없음).
- [ ] 복귀 성공 시 배너 180ms fade-out + 복귀 토스트(`success` 3s) 한 번만 낭독.
- [ ] 배너 상의 "자동 갱신 ON/OFF" 텍스트가 대문자로 유지(번역 후에도 규약 지킴).
- [ ] F4 + 네트워크 완전 단절 같은 동시 장애 시 배너 + ErrorState 합산 높이 ≤ 88px.

---

## 9. 후속 구현 순서 제안 (Joker·Thanos 인계용)

1. **i18n 리소스 분리** — `src/i18n/tokenFallback.ko.ts` 신규 생성. 본 §3 의 구조 그대로.
2. **배너 컴포넌트** — `src/components/FallbackReadonlyBanner.tsx` 신규. props 는 `{ reason, remainingPct,
   expiredAt, autoRenew, onRecover }`. `role="alert"` + Alt+R keyshortcut 내장.
3. **AuthGate 장착** — `AuthGate` 가 `allowance.mode === 'fallback-readonly'` 일 때 `children` 직전에
   `<FallbackReadonlyBanner />` 렌더. `document.documentElement.dataset.fallback` 을 F4 로 설정.
4. **쓰기 잠금 CSS 규칙** — `src/index.css` 의 `--token-fallback-banner-*` 토큰과 `html[data-fallback="F4"]
   [data-writable-guard]` 규칙을 같이 커밋.
5. **회귀 테스트** — `tests/fallbackReadonlyBanner.regression.test.ts`:
   - B1. 진입 시 1회만 `role="alert"` 이 aria-live 되는지(MutationObserver 기반 테스트).
   - B2. CTA 라벨이 reason 4종별로 정확히 바뀌는지.
   - B3. 쓰기 가드 셀렉터가 `aria-disabled` 와 툴팁을 정확히 덮는지.
   - B4. 축소 모션 환경에서 translate 가 제거되는지(jsdom + `matchMedia` 스텁).
