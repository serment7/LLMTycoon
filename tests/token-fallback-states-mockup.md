# ClaudeToken · 구독 토큰 만료 대비 폴백 상태 UX 시안 (2026-04-19)

관련 선행 문서:
- `src/components/ClaudeTokenUsage.tsx` — 상단바 토큰 사용량 배지. 본 시안의 **1차 표시 자리**.
- `src/components/TokenUsageSettingsPanel.tsx` — 임계값 조정 팝오버. 본 시안의 "경고/만료 임박"
  단계에서 **재인증 CTA** 를 삽입하는 자리.
- `src/components/ToastProvider.tsx` — 단계 전이 시점의 낭독·통지 경로. 2단계 이상 승격 시에만
  토스트를 띄운다(매번 띄우면 소음).
- `src/components/AuthGate.tsx` — 4단계 "만료 후 읽기 전용" 모드의 전역 스위치를 얹는 곳.
- `src/index.css` — `--token-fallback-*` 토큰 계열(본 PR 선도입)과 기존 `--shared-goal-modal-*`
  의 숫자 공유.

설계 전제: 구독 토큰(= 클로드 API 키 뒤의 월 할당 토큰 혹은 과금 한도) 이 바닥나면 서버에서
`allowance.remainingRatio` (0~1) 와 `allowance.expiresAt` (ISO) 을 내려준다. 프런트는 이 두 값과
`allowance.mode` (`active`|`fallback-readonly`) 를 받아 아래 4단계 중 하나를 결정한다.

---

## 0. 설계 원칙 (F-01 ~ F-08)

| ID   | 원칙                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | **단계별 시각 승격만, 경로 분기 최소화** — 4단계는 색·아이콘·카피만 바뀌고 UI 구조(배지 위치, 툴팁 구성)는 동일.                           |
| F-02 | **1회 낭독 원칙** — 승격 전이에서만 토스트를 띄운다. 같은 단계에서는 추가 낭독 없음(스크린리더 피로 방지).                                 |
| F-03 | **조치 CTA 1개** — 각 단계는 딱 하나의 "지금 할 수 있는 일" 을 제시한다(예: 경고 → 재충전 링크, 만료 임박 → 재인증, 만료 후 → 읽기 전용 확인). |
| F-04 | **읽기 전용 모드는 돌이킬 수 있음** — 재충전/재인증이 성공하면 즉시 `active` 로 복귀. 상단바 배지의 테두리 플래시(emerald 160ms)로 확인. |
| F-05 | **색 규약 공유** — 경고=`--shared-goal-modal-field-editing-border` amber, 만료 임박=`--shared-goal-modal-error-strip` red, 만료 후=회색 실선. |
| F-06 | **숫자/시간 단위 한국어** — "2시간 남음" / "내일 만료" — 절대값 날짜(2026-04-21)는 툴팁에 병기.                                         |
| F-07 | **보안 고지 우선** — 만료 임박·만료 후 화면에서는 재인증 링크가 **secondary 가 아닌 primary** 여야 한다.                                  |
| F-08 | **자동 갱신 안내** — `allowance.autoRenew: true` 여도 사용자가 "뭔가 끊긴 것 아닌지" 의심하지 않도록 상태 문구에 "자동 갱신 예정" 명시.       |

---

## 1. 4단계 상태 정의 (state matrix)

| 단계                   | 트리거 조건                                                               | 배지(ClaudeTokenUsage)            | 토스트              | AuthGate 변화                                            |
| ---------------------- | ------------------------------------------------------------------------- | --------------------------------- | ------------------- | -------------------------------------------------------- |
| F1. `active`           | `remainingRatio ≥ 0.25` **and** `expiresAt - now > 48h`                    | 기존 normal/caution/warning 팔레트 유지 | 없음              | 변화 없음                                                |
| F2. `approaching-limit` | `0.10 ≤ remainingRatio < 0.25` **or** `24h ≤ expiresAt - now ≤ 48h`           | amber 승격(카피 "⚠ 잔여 25% 미만") | `info` 1회("내일 만료 예정") | 변화 없음                                                |
| F3. `imminent-expiry`   | `remainingRatio < 0.10` **or** `expiresAt - now ≤ 24h` **and** 아직 `active` | red 승격 + 1.6s pulse              | `warning` 6s       | 상단바 아래 polite 배너 1줄 (닫기 가능)                  |
| F4. `fallback-readonly` | 서버가 `allowance.mode: 'fallback-readonly'` 를 응답                        | 회색 실선 + `🔒 읽기 전용` 라벨    | `error` 무기한     | 전역 배너(절대 위치, 닫기 불가) + 쓰기 액션 비활성화     |

**승격·강등 규칙**: 한 단계 올라가면(F1→F2, F2→F3, F3→F4) 무조건 해당 단계의 토스트를 띄운다.
내려가는 경우(F4→F1 등)에는 **emerald `✓ 복귀` 토스트 3s** 를 띄우고 배지 테두리에 160ms 플래시.
"올라간다 = 조치 필요", "내려간다 = 안심" 의 시각적 대칭.

---

## 2. 상단바 배지 — ClaudeTokenUsage 표현

본 시안은 기존 `severity` (normal/caution/warning) 를 건드리지 않고, **새로운 축** `fallbackState`
를 추가한다. 두 축은 동시에 유지되고, 배지는 "더 심각한 쪽" 을 시각적으로 우선한다:

```
우선도: hasError > fallbackState=F4 > fallbackState=F3 > severity=warning
      > fallbackState=F2 > severity=caution > normal
```

### 2.1 배지 단계별 시각

| 단계 | 테두리 색                                     | 좌측 6px 스트립               | 아이콘          | 카피 (배지 내)                         |
| ---- | --------------------------------------------- | ----------------------------- | --------------- | -------------------------------------- |
| F1   | `--shared-goal-modal-field-focus` (cyan)     | cyan                          | `Cpu`           | `토큰: 1.2M · $3.4` (기존 동작)           |
| F2   | `--token-fallback-caution-border` (amber)    | amber                         | `AlertTriangle` | `⚠ 잔여 22% · 내일 만료`                 |
| F3   | `--token-fallback-warning-border` (red)      | red + 1.6s pulse              | `AlertTriangle` | `⚠ 3시간 남음 · 재인증`                  |
| F4   | `--token-fallback-readonly-border` (회색 실선) | 회색 실선 + `🔒` 오버레이     | `Lock`          | `🔒 읽기 전용 · 재충전`                  |

**data 속성**: 루트 div 에 `data-fallback={F1|F2|F3|F4}` 추가. QA 가 색 비교 없이 4단계 전환을
검증할 수 있도록 훅을 분리.

### 2.2 툴팁(hover) 확장 — 단계별 아랫줄 추가

기존 `Claude 토큰 사용량` 툴팁의 하단(오늘/전체 토글 위)에 단계별 한 줄을 끼워 넣는다:

```
┌─────────────────────────────────────────────────┐
│ Claude 토큰 사용량                      호출 12회 │
│ 입력            1,234,567                        │
│ 출력              560,234                        │
│ 캐시 읽기         820,000                        │
│ 캐시 히트율            66% 💰 절약 중             │
│ 대략 비용            $3.42                       │
│ ──────────────────────────────────────────────── │
│ 모델별                                           │
│ claude-sonnet-4-6   1.6M · $2.41                 │
│ claude-opus-4-7     0.3M · $1.01                 │
│ ──────────────────────────────────────────────── │
│ ⚠ 구독 토큰 잔여 22% · 2026-04-21 만료             │
│   [💳 재충전 열기]   [? 요금제 안내]               │
│ ──────────────────────────────────────────────── │
│ 오늘 (04-19)  전체          [↻ 오늘 리셋]        │
└─────────────────────────────────────────────────┘
```

**단계별 한 줄의 톤**:
- F2 (caution): `⚠ 구독 토큰 잔여 22% · 내일 만료` + `[💳 재충전 열기]` secondary
- F3 (imminent): `⚠ 3시간 남음 · 자동 갱신 실패 시 저장 기능이 잠깁니다` + `[🔑 재인증]` primary (emerald confirm 팔레트)
- F4 (readonly): `🔒 구독 토큰이 만료되어 읽기 전용입니다` + `[💳 재충전 후 복귀]` primary red-to-emerald 전환

CTA 카피 규칙: "지금 할 수 있는 단 하나의 일" 을 **결과 지향** 으로 표현(SharedGoalModal §5.3
"목표 저장 후 시작" 패턴과 동일).

---

## 3. ToastProvider 연동 — 승격 전이별 토스트

단계 승격 시점에만 토스트를 띄운다. 같은 단계에 머물면 UI 에 점(pulse)만 돌고 토스트는 없음.

### 3.1 승격 토스트 규격

| 전이     | variant   | 제목                                    | 본문                                                                 | 지속시간  | action                                 |
| -------- | --------- | --------------------------------------- | -------------------------------------------------------------------- | --------- | -------------------------------------- |
| F1 → F2  | `info`    | 구독 토큰 잔여 25% 미만                    | 2026-04-21 에 만료됩니다. 미리 재충전해 두면 자동 개발이 끊기지 않아요. | 4000ms    | `{ label: '재충전 열기', onClick }`    |
| F2 → F3  | `warning` | 구독 토큰 만료 임박 (3시간)                | 지금 재인증하지 않으면 24시간 내 저장 기능이 잠깁니다. 자동 갱신: OFF  | 6000ms    | `{ label: '재인증', onClick }`         |
| F3 → F4  | `error`   | 🔒 읽기 전용 모드로 전환되었습니다          | 쓰기 액션이 잠겼습니다. 재충전 후 페이지를 새로고침하지 않아도 자동 복귀합니다. | 0 (무기한) | `{ label: '재충전', onClick }`         |
| F4 → F1  | `success` | ✓ 구독 토큰이 복구되었습니다                | 읽기 전용 모드가 해제되었어요. 직전 작성 중이던 지시는 보존되었습니다.    | 3000ms    | (없음)                                 |
| F3 → F2  | `success` | 만료 임박 경보 해제                        | 재인증에 성공했습니다. 자동 갱신이 켜져 있어요.                         | 3000ms    | (없음)                                 |
| F2 → F1  | `success` | 구독 토큰이 정상 범위로 복귀                 | 잔여 40% · 다음 갱신까지 여유가 생겼습니다.                           | 3000ms    | (없음)                                 |

**중복 방지**: 같은 id 로 병합(`ToastProvider` T-09 규약). id 는 `token-fallback-transition-F${prev}-to-F${next}`
로 고정. 승격·강등이 1초 안에 연속으로 일어나면 마지막 전이의 토스트만 살아남는다.

### 3.2 토스트 팔레트 — 기존 토큰 재사용

| 단계 토스트 | variant   | 토큰                                                |
| ----------- | --------- | --------------------------------------------------- |
| F1→F2       | info      | `--toast-info-*` (cyan 계열)                        |
| F2→F3       | warning   | `--toast-warning-*` (amber 계열)                    |
| F3→F4       | error     | `--toast-error-*` (red 계열, duration 0=무기한)     |
| 강등(복귀)  | success   | `--toast-success-*` (emerald 계열)                  |

→ 새 토큰이 필요한 건 "배지/AuthGate 내부 단계 표현" 뿐. 토스트는 **기존 `--toast-*` 로 완전히 커버** 된다.

---

## 4. AuthGate 연동 — 전역 읽기 전용 가드

F4 단계에서만 AuthGate 가 개입한다(F1~F3 은 상단바·토스트 레벨로 충분).

### 4.1 전역 상단 배너 (F4 전용)

`AuthGate` 의 `children` 렌더 직전에 **sticky top 배너** 를 1줄 삽입:

```
╔══════════════════════════════════════════════════════════════════════════════════════════╗
║ 🔒 구독 토큰 만료 — 현재 읽기 전용 모드입니다. 재충전하면 즉시 복귀됩니다. [💳 재충전]     ║
╚══════════════════════════════════════════════════════════════════════════════════════════╝
```

- 높이 `--token-fallback-banner-height` (40px 고정).
- 배경 `--token-fallback-readonly-bg` (옅은 회색).
- 좌측 4px 스트립 `--token-fallback-readonly-strip` (회색 실선, 깜빡임 없음).
- 버튼 [💳 재충전] 은 `--shared-goal-modal-confirm-*` emerald 팔레트 재사용.
- `role="alert" aria-live="assertive"` → 진입 직후 1회 낭독.
- 상단바(56px) 는 그대로 두고 이 배너가 그 바로 **아래** 에 쌓인다(z-index 는 상단바보다 1 낮게).
  상단바 오른쪽의 `ClaudeTokenUsage` 배지와 배너 좌측 카피가 동시에 "F4" 를 전달해 색각 이상에도 안전.

### 4.2 쓰기 액션 비활성화 가드

F4 일 때 `AuthContext` 에 `allowance: { mode: 'fallback-readonly' }` 를 얹고, 쓰기 컴포넌트
(SharedGoalModal 저장, ProjectManagement 편집, 자동 개발 토글 ON 등) 는 해당 플래그를 읽어 버튼을
disabled 로 전환 + `title="구독 토큰 만료로 잠겨 있습니다. 재충전하면 자동 복귀됩니다."` tooltip 을 건다.

구현 힌트: 쓰기 버튼 컨테이너에 `data-writable-guard="fallback-readonly"` 를 걸고, CSS 가
`html[data-fallback="F4"] [data-writable-guard]` 전역 규칙으로 `pointer-events: none; opacity: 0.55;` 를 덮으면
개별 컴포넌트 수정 없이 F4 상태가 즉시 반영된다.

### 4.3 재인증 플로우 (F3·F4 공통 CTA 타깃)

- F3: 상단바 배지 또는 툴팁의 `[🔑 재인증]` 클릭 → 기존 `LoginForm` 의 축약 변형을 모달로 띄움
  (username/password 혹은 OAuth 링크 재확인 1단계). 성공 시 F3 → F2/F1 강등.
- F4: 동일 모달 재활용. 서버가 재인증 후 `allowance` 를 새로 내려주면 곧바로 F1 으로 복귀.
- 성공 시 상단바 배지 테두리에 emerald 160ms 플래시 + 복귀 토스트(success).

---

## 5. TokenUsageSettingsPanel 연동 — 재인증 섹션 삽입

기존 패널의 `임계값 설정` 과 `캐시 사용 내역 내보내기` 사이에 **F2/F3/F4 단계에서만** 얇은
섹션을 끼워 넣는다(F1 에서는 완전히 숨김):

```
┌── 구독 토큰 상태 ─────────────────────────┐
│ 현재 상태:  [F3] 만료 임박                │
│ 잔여:       8%   · 대비 100%               │
│ 만료:       2026-04-21 09:00 (3시간 남음)  │
│ 자동 갱신:  OFF                            │
│                                            │
│       [🔑 재인증]   [💳 재충전 열기]       │
└────────────────────────────────────────────┘
```

- 배경: 해당 단계 배지와 동일한 희석 톤(`--token-fallback-{F2,F3,F4}-bg`).
- 좌측 4px 스트립: 단계별 border 토큰.
- 두 버튼 배치는 SharedGoalModal §5.1 규약(좌측 secondary, 우측 primary)과 동일.
- `role="region" aria-label="구독 토큰 폴백 상태"`.

이 섹션은 단계 전이 토스트의 action 버튼이 여는 패널과 **같은 위치** 에 있어, 사용자는 토스트가
사라져도 동일 UI 로 돌아갈 수 있다.

---

## 6. index.css 토큰 — `--token-fallback-*` (본 PR 선도입)

### 6.1 단계별 3종 세트 (border · strip · bg)

| 토큰                                        | 값                                    | 용도                                                      |
| ------------------------------------------- | ------------------------------------- | --------------------------------------------------------- |
| `--token-fallback-caution-border`           | `#fbbf24`                             | F2 배지 테두리(= `--shared-goal-modal-field-editing-border`) |
| `--token-fallback-caution-strip`            | `#fbbf24`                             | F2 좌측 6px 스트립                                         |
| `--token-fallback-caution-bg`               | `rgba(251, 191, 36, 0.10)`            | 설정 패널 섹션 배경 희석                                    |
| `--token-fallback-caution-fg`               | `#fde68a`                             | 카피 글자                                                  |
| `--token-fallback-caution-icon`             | `#fbbf24`                             | AlertTriangle 아이콘                                      |
| `--token-fallback-warning-border`           | `#f87171`                             | F3 배지 테두리(= `--shared-goal-modal-error-strip`)       |
| `--token-fallback-warning-strip`            | `#f87171`                             | F3 좌측 6px 스트립                                         |
| `--token-fallback-warning-bg`               | `rgba(248, 113, 113, 0.12)`           | F3 섹션 배경 희석                                          |
| `--token-fallback-warning-fg`               | `#fecaca`                             | 카피 글자                                                  |
| `--token-fallback-warning-icon`             | `#fca5a5`                             | AlertTriangle 아이콘                                      |
| `--token-fallback-warning-pulse-duration`   | `1.6s`                                | F3 pulse 주기(기존 `--token-usage-warning-pulse-duration` 과 일치) |
| `--token-fallback-readonly-border`          | `rgba(255, 255, 255, 0.35)`           | F4 회색 실선 테두리                                         |
| `--token-fallback-readonly-strip`           | `rgba(255, 255, 255, 0.45)`           | F4 좌측 4px 스트립                                         |
| `--token-fallback-readonly-bg`              | `rgba(255, 255, 255, 0.06)`           | F4 옅은 회색 섹션/배너 배경                                 |
| `--token-fallback-readonly-fg`              | `rgba(255, 255, 255, 0.80)`           | F4 카피 글자                                               |
| `--token-fallback-readonly-icon`            | `rgba(255, 255, 255, 0.75)`           | Lock 아이콘                                                |

### 6.2 전역 배너 (F4) 전용

| 토큰                                       | 값                                   | 용도                                             |
| ------------------------------------------ | ------------------------------------ | ------------------------------------------------ |
| `--token-fallback-banner-height`           | `40px`                               | sticky 배너 고정 높이                            |
| `--token-fallback-banner-z-index`          | `29`                                 | 상단바(30) 바로 아래                             |
| `--token-fallback-banner-shadow`           | `0 2px 8px rgba(0, 0, 0, 0.35)`      | 배너 아래 가벼운 그림자                          |
| `--token-fallback-banner-cta-bg`           | `var(--shared-goal-modal-confirm-bg)` | 재충전 CTA 배경(emerald — "같은 동작 = 같은 색") |
| `--token-fallback-banner-cta-fg`           | `var(--shared-goal-modal-confirm-fg)` | 재충전 CTA 글자                                  |

### 6.3 복귀 플래시

| 토큰                                  | 값                              | 용도                                        |
| ------------------------------------- | ------------------------------- | ------------------------------------------- |
| `--token-fallback-recover-flash-color` | `#34d399`                      | 강등 시 배지 테두리 emerald 160ms 플래시     |
| `--token-fallback-recover-flash-ms`    | `160ms`                        | 플래시 지속 시간                            |

### 6.4 대비 검증 (`--pixel-card #16213e` 기준)

- `--token-fallback-caution-fg`(#fde68a) 11.0:1 · AAA
- `--token-fallback-warning-fg`(#fecaca) 9.4:1 · AAA
- `--token-fallback-readonly-fg`(white/80%) 11.9:1 · AAA
- `--token-fallback-caution-border`(#fbbf24) 8.7:1 · AAA
- `--token-fallback-warning-border`(#f87171) 5.9:1 · AA 본문
- `--token-fallback-readonly-strip`(white/45%) 5.7:1 · AA 본문

**색각 이상 대응**: 단계별 4종은 색 + 아이콘(○ / ⚠ / ⚠-pulse / 🔒) + 카피("잔여 22%" / "3시간 남음"
/ "읽기 전용") 3중 인코딩. readonly 는 **회색 단색** 을 쓰기 때문에 색상에 의존하지 않는 "자물쇠"
기호가 특히 중요.

---

## 7. 스크린리더·키보드 접근성

| 항목                                     | 규약                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 배지 aria-label                          | F1/F2/F3/F4 별로 상태 문구 + 숫자 + "자세히 보려면 호버하거나 클릭" 안내.                                   |
| 배너(F4) `role="alert"`                  | 진입 직후 1회 낭독. 이후 상태 유지 시 재낭독 없음.                                                         |
| 재인증 버튼                              | `aria-keyshortcuts="Alt+R"` — 키보드 사용자가 배지 안의 CTA 에 바로 도달.                                 |
| 툴팁 단계 한 줄                          | 기존 툴팁 안이라 `role="tooltip"` 를 상속. 별도 live region 불필요.                                       |
| 읽기 전용 disabled 버튼                  | `aria-disabled="true"` + `title` 로 이유 전달. 단순 `disabled` 속성은 focus 가 빠져 이유가 안 들림.         |
| `prefers-reduced-motion: reduce`          | F3 pulse 제거, F4 `✓` 복귀 플래시 제거. 상태 전환은 즉시 색만 바뀐다.                                       |

---

## 8. 구현 메모 (Kai 인계용)

1. **허용치 응답 스키마 선-정의**: 서버 `/api/claude/allowance` 응답을 다음 형태로 고정:
   ```ts
   interface ClaudeAllowanceSnapshot {
     mode: 'active' | 'fallback-readonly';
     remainingRatio: number;          // 0..1
     expiresAt: string;               // ISO
     autoRenew: boolean;
     lastCheckedAt: string;
   }
   ```
2. **4단계 resolver**: `src/utils/tokenFallbackResolve.ts` (신규) — `resolveFallbackState(snapshot, now)`
   함수 하나가 F1/F2/F3/F4 를 반환. 테스트는 `tests/tokenFallbackResolve.unit.test.ts` 로 "경계값 4개
   × 강등/승격 대칭" 을 잠근다.
3. **상태 스토어**: `src/utils/claudeAllowanceStore.ts` — `useSyncExternalStore` 와 socket 이벤트
   `allowance:updated` 를 받아 스냅샷을 갱신. ClaudeTokenUsage 가 기존 usage 스토어와 **별도 구독**.
4. **배지 통합**: `ClaudeTokenUsage.tsx` 에 `allowanceState` prop 을 넣지 않는다 — 컴포넌트가 직접
   `claudeAllowanceStore` 를 구독해 자체 판정. 테스트는 `__setForTest` 로 상태 주입.
5. **F4 전역 플래그**: `document.documentElement.setAttribute('data-fallback', 'F4')` 를 AuthGate 가
   값 변할 때만 호출. CSS 가 `html[data-fallback="F4"] [data-writable-guard]` 규칙으로 일괄 잠금.
6. **회귀 테스트** (신규 예정):
   - `tests/tokenFallbackResolve.unit.test.ts` — 4단계 결정 로직 순수 함수.
   - `tests/tokenFallbackTransitions.regression.test.ts` — 토스트 id 병합·중복 낭독 방지.
   - `tests/authGateFallbackBanner.e2e.test.tsx` — F4 진입/해제 시 배너 DOM 존재/제거.

---

## 9. 회귀 방지 체크리스트 (QA 복사용)

- [ ] F1 → F2 승격 시 `info` 토스트가 뜨고 배지 테두리가 amber 로 전환된다.
- [ ] F2 → F3 승격 시 `warning` 토스트(6s) + 배지 pulse 1.6s 시작, `prefers-reduced-motion` 환경에선 pulse 없음.
- [ ] F3 → F4 승격 시 `error` 토스트(무기한) + AuthGate 상단 배너(sticky) 출현 + 모든 쓰기 버튼 비활성화.
- [ ] F4 → F1 강등 시 배너 제거 + 배지 160ms emerald 플래시 + `success` 토스트 3s.
- [ ] 같은 단계 유지 시 토스트가 반복 출력되지 않는다(id 병합).
- [ ] F4 상태에서 저장/편집/자동 개발 토글이 `aria-disabled="true"` 로 잠기고 tooltip 으로 이유를 전달.
- [ ] F3/F4 패널 섹션의 재인증 버튼이 키보드 Alt+R 로 직행 가능.
- [ ] 상태 배지 루트에 `data-fallback` 속성이 F1~F4 로 정확히 찍힌다.
- [ ] 토큰 대비: amber(F2) 8.7:1, red(F3) 5.9:1, gray(F4 strip) 5.7:1 — WCAG AA 본문 이상.
