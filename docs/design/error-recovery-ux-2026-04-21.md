---
date: 2026-04-21
owner: Designer (LLMTycoon)
trigger-directive: "지시 #eabeb955 — 장시간 세션 오류 복구 UX(세션 복원·MCP 끊김·API 실패·추천 빈 응답)"
prior-context:
  - src/ui/NewProjectWizard.tsx (우선 검토 파일 — status 기계·에러 메시지 경로 권위)
  - src/components/ToastProvider.tsx (토스트 공용 · variant 4종 · duration/aria-live 규칙 확정)
  - src/server/claudeErrors.ts (classifyClaudeError · 재시도 정책)
  - src/types.ts L401–L428 (ClaudeErrorCategory 9종 · ClaudeErrorCounters)
  - src/utils/draftStore.ts · src/components/MediaDraftRestoreBadge.tsx (초안 복원 선례)
  - src/hooks/useOnlineStatus.ts (온라인 감지)
  - src/components/ErrorState.tsx (에러 공용 · role=alert · aria-live=assertive)
  - src/project/recommendAgentTeam.ts · src/project/recommendationClient.ts (추천 캐시 · 폴백)
  - docs/design/cross-feature-onboarding-and-state-audit-2026-04-21.md (직전 시안 · ErrorState tone='warning' 변형 제안)
  - docs/design/token-savings-visualization-2026-04-21.md (토큰 인디케이터 3색 바 · 임계 심각도)
  - docs/design/mcp-transport-and-language-toggle-2026-04-20.md (전송 방식별 분기 선례)
  - docs/design/project-creation-agent-recommendation-2026-04-20.md (추천 모달 정보 구조)
  - docs/design/toast-notification-visual-2026-04-19.md (T-01~T-12 토스트 규약)
report-to: Kai (7efcca3d-9d2e-4c46-9df0-c6b01352048c)
scope:
  - "세션 복원 실패 복구 모달 · 자동 재시도 카운트다운 · 수동 재시도 · 새 세션 시작 · 이력 별도 저장 4 선택지"
  - "MCP 전송별 연결 끊김 배너(stdio/http/streamable-http) · 이전 응답 보존 · 오프라인 대기 문구 한/영"
  - "Anthropic 실패 유형별 토스트(레이트 리밋/토큰 한도/캐시 미스 비용 급증 80%·95%) 우선순위 팔레트"
  - "추천 API 빈 배열·실패 시 대안 문구 · '최근 추천 불러오기' 버튼 배치"
  - "errors.* 네임스페이스 i18n 키 후보 전량 + ARIA live region 체크리스트"
---

# 장시간 세션 오류 복구 UX — 통합 시안 (2026-04-21)

장시간(5시간 이상) 세션에서는 **네트워크 순간 단절 · 세션 스냅샷 손상 · API 한도 도달 · 추천 서비스 백엔드 지연** 네 가지가 연쇄로 발생한다. 각각을 따로 처리하면 사용자에게는 "오류 토스트만 쏟아지는 1분" 으로 보인다. 본 시안은 네 축을 **같은 우선순위 팔레트 · 같은 aria-live 등급 · 같은 복구 행동 구조(자동 재시도 → 수동 재시도 → 수용 가능한 대안)** 로 묶는다.

기존 `ToastProvider` (variant 4종: success/info/warning/error · duration/aria 규약 확정) 와 `classifyClaudeError` (9 카테고리 · retryAfter 헤더 파싱) 위에서 **새 UI 컴포넌트 2개** 만 추가한다:
1. `SessionRecoveryModal` — 세션 복원 실패 전용 다이얼로그
2. `McpDisconnectedBanner` — MCP 연결 끊김 상주 배너

나머지는 기존 `ToastProvider` · `ErrorState` · `EmptyState` 로 수렴한다(선행 시안 §3.4 `tone='warning'` 변형 prop 전제).

> 우선 검토 파일 `src/ui/NewProjectWizard.tsx` 의 `status: 'idle' | 'loading' | 'ready' | 'error' | 'applying'` 기계(L80) 는 본 시안 §4 "추천 빈/실패 대안" 이 확장할 상태 모델의 기반이다. 새 상태 `'empty'` 와 `'offlineFallback'` 을 추가해 빈 응답과 온라인 오류를 분리한다(§4.2).

---

## 0. 설계 원칙 (E-01 ~ E-14)

### 0.1 공통(E-01 ~ E-04)

| ID   | 원칙 |
| ---- | ---- |
| E-01 | **우선순위 팔레트는 3단** — info(blue) / warning(amber) / error(red). 추가 색 금지. 기존 `--color-info-*` · `--color-warning-*` · `--color-danger-*` 세 팔레트만 사용. |
| E-02 | **자동 재시도가 있을 때만 카운트다운 표기**. 수동 재시도 버튼은 언제나 노출 — "자동 대기가 싫은 사용자" 를 막지 않는다. |
| E-03 | **같은 사건의 토스트 병합**: `id` 고정으로 중복 발화 차단(`ToastProvider` T-09). 네트워크 깜빡임이 3초에 5번 터져도 토스트는 1장, duration 만 연장. |
| E-04 | **복구 선택지는 4개 이하**: 많으면 사용자가 결정 회피. "자동 재시도 · 수동 재시도 · 대안 · 떠나기" 로 수렴. |

### 0.2 세션 복원 모달(E-05 ~ E-07)

| ID   | 원칙 |
| ---- | ---- |
| E-05 | **자동 재시도는 10초 · 3회**: 10 · 20 · 40 초 간격 지수 백오프. 그 이상은 사용자 결정 필요. |
| E-06 | **"새 세션 시작" 은 데스트럭티브 톤**: 이전 대화/진행이 버려질 수 있으므로 `--color-danger` 테두리 + `[이전 세션 스냅샷 다운로드]` 버튼 동반(안전망). |
| E-07 | **토큰 사용 이력 별도 저장** 안내는 모달 하단 고정 — 복원 실패 시에도 "데이터는 분리 저장되어 안전합니다" 를 우선 전달. 심리적 완충. |

### 0.3 MCP 끊김 배너(E-08 ~ E-10)

| ID   | 원칙 |
| ---- | ---- |
| E-08 | **배너 1개 · 전송 방식에 따라 문구 분기**: stdio(자식 프로세스 종료) / http(엔드포인트 4xx·5xx) / streamable-http(SSE 스트림 끊김) 각각 다른 1문장. |
| E-09 | **이전 응답은 "보존/폐기" 를 사용자에게 묻지 않고 기본 보존**: 자동 폐기는 회복 불가. 배너에 `[응답 초기화]` 는 2차 액션으로만. |
| E-10 | **오프라인 대기 시간은 상대 시간(Intl.RelativeTimeFormat)**: "2분 전 끊김" · "방금" · "5분 전". 절대 시각 금지(사용자 혼란). |

### 0.4 Anthropic 실패 토스트(E-11 ~ E-12)

| ID   | 원칙 |
| ---- | ---- |
| E-11 | **9 카테고리 → 3 팔레트 매핑**: `rate_limit · overloaded · timeout` = warning / `token_exhausted · subscription_expired · auth` = error / `api_error · bad_request · network` = 상황 따라(bad_request 는 개발자 로그, 사용자에겐 info). |
| E-12 | **비용 급증 경고는 80% · 95% 2 단계**: 80% 는 warning 토스트(6초), 95% 는 error 토스트(무기한, 사용자 확인 필요). 이건 Anthropic 응답이 아니라 **내부 누적 계산** 의 결과 — 토스트 id 는 `tokenUsage.costSurge.80` · `...95` 로 분리해 한 세션에서 각 1회만. |

### 0.5 추천 빈·실패 대안(E-13 ~ E-14)

| ID   | 원칙 |
| ---- | ---- |
| E-13 | **빈 배열은 에러가 아닌 "안내"**: info 톤. "직접 추가하기" 와 "최근 추천 불러오기" 두 행동 제시. |
| E-14 | **"최근 추천" 은 로컬 캐시 재사용** (`RecommendationCache`): 네트워크 없어도 동작. 캐시가 0개면 버튼은 비활성 + 툴팁 "이전 추천이 없어요". |

---

## 1. 세션 복원 실패 — 복구 모달

### 1.1 와이어프레임(기본 상태 · 자동 재시도 중)

```
┌ SessionRecoveryModal ─────────────────────────────────── (role="alertdialog", modal) ──┐
│                                                                                          │
│   ⚠  세션 복원 실패                                                 [✕ 닫기]             │
│                                                                                          │
│   저장된 세션 스냅샷을 불러오지 못했어요.                                                  │
│   자동 재시도를 진행하고 있습니다 — **{count}초 후 재시도**(시도 {attempt}/3).              │
│                                                                                          │
│   ┌─ 지금 이 순간의 상태 ─────────────────────────────┐                                  │
│   │ • 토큰 사용 이력 :  ✔ 별도 저장 · 유실 없음           │  ← 심리 완충 문구(E-07)        │
│   │ • 대화 초안       :  ✔ 브라우저 draftStore 에 보존    │                                  │
│   │ • 네트워크         :  ⚠ 오프라인 상태 감지됨(재연결 대기) │  ← online 이면 이 줄 숨김   │
│   └───────────────────────────────────────────────────┘                                  │
│                                                                                          │
│   ┌──────────────────────────────┬──────────────────────────────┐                         │
│   │  🔄 지금 다시 시도             │  🆕 새 세션 시작(주의)        │                         │
│   │  (자동 재시도 중단)             │  이전 스냅샷이 폐기될 수 있어요  │                         │
│   └──────────────────────────────┴──────────────────────────────┘                         │
│                                                                                          │
│   [📥 이전 세션 스냅샷 다운로드]   [📊 토큰 사용 이력 보기]    [나중에 다시]                 │
│                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- 모달 폭 560px, 동적 높이 최대 72vh.
- `role="alertdialog"` + `aria-modal="true"` + `aria-labelledby=title` + `aria-describedby=body`.
- 배경 스크림: `--onboarding-scrim-bg` rgba(0,0,0,.45) 재사용 — OnboardingTour 와 시각 일관.

### 1.2 상태 기계(3 회차 자동 재시도 + 수동 결정)

```
 mounted (initial)
   │  자동 재시도 시작(attempt=1, delay=10s)
   ▼
 autoCountdown ────success──▶ restored → 모달 닫힘
   │
   │ attempt<3 · 실패
   ▼
 autoCountdown (attempt++, delay*=2)
   │
   │ attempt=3 실패 또는 사용자 [지금 다시 시도]
   ▼
 manualWait  ──retry success──▶ restored → 모달 닫힘
   │
   │ retry fail / [새 세션 시작]
   ▼
 decide       ──[새 세션]─▶ wiped  (이전 스냅샷 다운로드 권고 후)
   │
   └──[나중에]──▶ dismissed (모달 닫힘, 복원 실패 배지 우상단 고정)
```

- 초기 오프라인이면 자동 재시도를 **일시 중지** 하고 `useOnlineStatus` 가 online=true 로 바뀌는 순간 즉시 시도(E-05 시간은 online 일 때만 흐름).
- `nowMs - lastFailAtMs` 기반 카운트다운은 **1초마다 렌더** 하지 않고 `Intl.RelativeTimeFormat` + 최소 500ms RAF 로 동결(CPU 비용).

### 1.3 4 선택지 상세

| 버튼                          | 변형          | 동작                                                                   |
| ----------------------------- | ------------- | ---------------------------------------------------------------------- |
| 🔄 지금 다시 시도                | primary(accent) | 자동 카운트다운 중단 · 즉시 `restoreSession()` 호출 · `aria-live="polite"` 로 "재시도 중" 알림 |
| 🆕 새 세션 시작(주의)            | danger(outline) | 확인 대화상자 없이 즉시 실행되면 안 됨 — **인라인 2단계 확인**: 버튼 클릭 → 버튼 자리가 "정말 시작할까요? [새 세션] [취소]" 로 전환(3초 지나면 자동 되돌림) |
| 📥 이전 세션 스냅샷 다운로드      | ghost          | 로컬에 있는 직전 스냅샷(JSON) 을 `llmtycoon-session-snapshot-{ts}.json` 로 저장 |
| 📊 토큰 사용 이력 보기            | ghost          | 설정 드로어의 "토큰 사용 상세" 탭 열기(선행 시안 `token-savings-visualization-2026-04-21.md` §2.1 합류) |
| 나중에 다시                    | link-only      | 모달 닫기 + 우상단 고정 **복구 배지**(아이콘 ⚠ 색 warning) 표시. 클릭 시 모달 재오픈. |

### 1.4 "새 세션 시작" 2단계 확인 — 인라인 패턴

```
┌ ... ─────────────────────────────────────┐
│  🆕 새 세션 시작(주의)                     │    ← 클릭 전
│  이전 스냅샷이 폐기될 수 있어요             │
└───────────────────────────────────────────┘

       클릭 ↓

┌ ... ─────────────────────────────────────┐
│  정말 새 세션으로 시작할까요?               │
│  [새 세션 시작]   [취소]           3s      │ ← 3초 후 자동 취소
└───────────────────────────────────────────┘
```

- 3초 자동 취소는 `--motion-duration-lg` × 10 = 3600ms 근사 카운터. 시각적 카운트다운은 오른쪽에 작은 숫자(3 → 2 → 1).
- 접근성: 전환 시 `aria-live="assertive"` 로 "확인이 필요합니다" 낭독.
- window.confirm 절대 금지(`cross-feature-onboarding-and-state-audit-2026-04-21.md` §4.1 MCP 삭제와 동일 규약 공유).

### 1.5 복구 배지(모달 "나중에" 이후)

```
 ┌─ 상단바 우측 ──────────────────┐
 │  [⚠ 복구 대기 · 지금 시도 →]    │  ← amber pulse · role="button"
 └────────────────────────────────┘
```

- 위치: `TokenUsageIndicator` 왼쪽. 공간이 없으면 사이드바 상단.
- 클릭 시 모달 재오픈, 상태는 `manualWait` 로 복귀.
- 사용자가 새 세션 선택 후에는 배지 자동 제거.

---

## 2. MCP 전송별 연결 끊김 배너

### 2.1 배너 공통 레이아웃

```
 ┌ McpDisconnectedBanner ──────────────────────────────── (role="status", aria-live="polite") ──┐
 │  🔌 {transport_label} 연결이 {relativeTime} 끊겼어요       [재연결]   [상세]   [닫기]           │
 │  {savedMessage}                                                                                 │
 └─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- 위치: 상단바 바로 아래 전체 폭 스트립. 높이 48px.
- 톤: `tone='warning'` (amber strip). 선행 시안 `cross-feature-onboarding-and-state-audit-2026-04-21.md` §3.4 의 `ErrorState` 변형 prop 재사용.
- `role="status"` 이유: 경고지만 사용자 작업을 끊을 정도는 아님. `role="alert"` 금지.

### 2.2 전송 방식별 문구 분기 (한/영)

| transport           | 끊김 원인                      | 한국어 1문장                                                              | English                                                              |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `stdio`              | 자식 프로세스 종료/SIGPIPE       | stdio 연결이 {relativeTime} 끊겼어요 — 자식 프로세스가 종료됐습니다.         | stdio connection lost {relativeTime} — the child process exited.      |
| `http`               | 엔드포인트 4xx · 5xx · 네트워크 | HTTP 서버가 {relativeTime} 응답하지 않아요.                                 | HTTP server stopped responding {relativeTime}.                        |
| `streamable-http`    | SSE 스트림 단절                 | 스트림이 {relativeTime} 끊겼어요 — 부분 응답은 아래 보존돼 있어요.            | Stream broken {relativeTime} — partial responses are preserved below. |

### 2.3 "이전 응답 보존" 배너 하위 문구

| transport           | 한국어                                                              | English                                                           |
| ------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `stdio`              | 지금까지 받은 출력은 그대로 유지됩니다.                                | All output received so far is preserved.                           |
| `http`               | 마지막 성공 응답은 캐시에 남아 있어요.                                  | The last successful response is kept in cache.                    |
| `streamable-http`    | 부분 스트림은 자리 표시자로 남겨 두었어요. 재연결 시 이어 받을 수 있어요. | Partial stream kept as placeholder — reconnecting will resume it. |

### 2.4 재연결 동작 · 버튼 상태

| 버튼              | 동작                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------- |
| `[재연결]`         | 즉시 재시도. stdio: 자식 프로세스 재기동. http: 마지막 요청 POST 재시도. streamable: SSE 재수립. |
| `[상세]`           | 프로젝트 관리 메뉴의 MCP 서버 설정 탭 열기 + 해당 서버 카드로 스크롤                         |
| `[닫기]`            | 배너 숨김(세션 한정). 실제 끊김 상태는 해소되지 않으며, 우상단에 작은 🔌 뱃지만 남음           |

### 2.5 오프라인 대기 시간 표기

- `Intl.RelativeTimeFormat(locale, { numeric: 'auto' })` 사용. "방금 · 1분 전 · 5분 전 · 1시간 전".
- 60초 미만은 "방금"("just now"), 60~3600초는 분 단위, 그 이상은 시간 단위. 1일 넘으면 날짜 고정(YYYY-MM-DD HH:mm).

### 2.6 자동 해소

- 재연결 성공 시 배너 자동 닫힘 + **3초 success 토스트** "MCP 서버에 다시 연결됐어요."(`states.offline.toast.onRestore` 재사용 가능).
- 사용자가 수동 닫기 후 재연결되면 토스트만 표시(배너 재오픈 안 함).

---

## 3. Anthropic API 요청 실패 — 유형별 토스트

### 3.1 9 카테고리 → 토스트 매핑

| category              | variant  | duration | id 전략                                | 우선순위 | 접근성(role·aria-live) |
| --------------------- | -------- | -------- | -------------------------------------- | -------- | ---------------------- |
| `rate_limit`           | warning  | 6초       | `anthropic.rate_limit` (병합)          | 1(최상)   | alert · assertive      |
| `token_exhausted`      | error    | 무기한    | `anthropic.token_exhausted`            | 1        | alert · assertive      |
| `subscription_expired` | error    | 무기한    | `anthropic.subscription_expired`       | 1        | alert · assertive      |
| `overloaded`           | warning  | 6초       | `anthropic.overloaded`                 | 2         | status · polite        |
| `auth`                 | error    | 무기한    | `anthropic.auth`                       | 1        | alert · assertive      |
| `timeout`              | warning  | 6초       | `anthropic.timeout`                    | 3         | status · polite        |
| `network`              | warning  | 6초       | `anthropic.network`                    | 3         | status · polite        |
| `api_error`            | warning  | 6초       | `anthropic.api_error.{requestId}`       | 3         | status · polite        |
| `bad_request`          | info(dev) | 4초       | `anthropic.bad_request.{requestId}`     | 4(낮음)   | status · polite        |

- `bad_request` 은 사용자 탓이 거의 없으므로 info 톤. 본문에는 "개발자에게 알려주세요" + 요청 ID 복사 버튼.
- `auth` · `subscription_expired` 는 기존 `SubscriptionExpiredError` / `TokenExhaustedError` 전용 경로로 동일 카피 공유.
- 우선순위 1 여러 개가 동시 발생하면 최상위만 노출, 나머지는 로그로 수집(E-04 원칙).

### 3.2 카피(한/영)

#### rate_limit
- 제목(ko): **요청이 일시 제한됐어요** / en: **Requests rate-limited**
- 본문(ko): `{retryIn}초 후 자동으로 다시 시도합니다. 지금 재시도할 수도 있어요.`
- 본문(en): `Retrying automatically in {retryIn}s. You can retry now too.`
- 액션: `[지금 재시도]` · `[설정에서 임계 조정]`

#### token_exhausted
- 제목(ko): **토큰이 소진됐어요** / en: **Token quota exhausted**
- 본문(ko): `5시간 창 사용량이 100% 에 도달했어요. {resetClock} 에 초기화돼요.`
- 본문(en): `5-hour window hit 100% — resets at {resetClock}.`
- 액션: `[사용 상세 보기]` · `[설정 열기]`

#### subscription_expired
- 제목(ko): **구독이 만료됐어요** / en: **Subscription expired**
- 본문(ko): `Claude 계정에서 결제 상태를 확인해 주세요.`
- 액션: `[Claude 계정 열기]`

#### overloaded (Anthropic 529)
- 제목(ko): **Claude 서버가 붐벼요** / en: **Claude servers are busy**
- 본문(ko): `곧 다시 시도할게요. 잠시 기다려 주세요.`
- 액션: `[지금 재시도]`

#### auth
- 제목(ko): **인증이 필요해요** / en: **Authentication required**
- 본문(ko): `Claude 세션이 끊겼어요. 다시 로그인해 주세요.`
- 액션: `[다시 로그인]`

#### timeout · network
- 제목(ko): **응답이 늦어요** / en: **Response timed out** (timeout)
- 본문(ko): `네트워크가 불안정한 것 같아요. 다시 시도합니다.`
- 제목(ko): **연결이 끊겼어요** / en: **Connection lost** (network)
- 본문(ko): `인터넷 연결을 확인해 주세요.`

#### api_error / bad_request
- 제목(ko): **요청에 문제가 있었어요** / en: **Request failed**
- 본문(ko): `요청 ID {requestId} 로 기록됐어요.`
- 액션: `[요청 ID 복사]` · `[개발자 로그 보내기]`

### 3.3 비용 급증 경고(80% · 95%)

두 경고는 Anthropic 에러가 아닌 **내부 누적 모니터링** 결과다. `claudeTokenUsageStore` 의 실시간 합계 vs `ClaudeTokenUsageThresholds` 비교로 발생.

| 임계     | variant  | duration | id                               | 카피(ko)                                                                | 카피(en)                                                          |
| -------- | -------- | -------- | -------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 80%      | warning  | 6초       | `tokenUsage.costSurge.80`         | 🔔 세션 토큰 80% 도달 — 캐시 활용을 늘려 절약하세요.                        | 🔔 Token usage hit 80% — lean on cache to save.                   |
| 95%      | error    | 무기한    | `tokenUsage.costSurge.95`         | ⚠ 세션 토큰 95% 도달 — 5분 내 만료 가능. 중요한 요청 먼저 처리하세요.         | ⚠ Token usage hit 95% — window may expire within 5 min. Prioritize. |

- 둘 다 토스트 id 가 고정이라 한 세션에 각 1회만 발화. 같은 임계가 다시 넘어도 중복 토스트 금지.
- 리셋 감지(`computeSubscriptionSessionSnapshot.isReset`) 시 두 id 모두 재사용 가능하도록 ToastProvider 에 `dismissById` 호출.
- 액션: `[상세 보기]`(→ 토큰 사용 상세 패널), `[설정에서 임계 조정]`(→ SettingsDrawer 임계 탭).

### 3.4 팔레트 매핑(우선순위 시각)

```
  error ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  (빨강 · --color-danger · strip 4px)
    · token_exhausted · subscription_expired
    · auth · tokenUsage.costSurge.95

  warning ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  (amber · --color-warning · strip 4px)
    · rate_limit · overloaded · timeout · network
    · api_error · tokenUsage.costSurge.80

  info ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  (cyan · --color-info · strip 2px)
    · bad_request(개발자 노출용)
```

- strip 두께 차이도 신호 — error 4px · warning 4px · info 2px.
- 동시 다발 시 위에서 아래 순서로 쌓이며, 최상단 3개만 보이고 나머지는 "+N개" 아코디언.

---

## 4. 추천 API 빈 배열 · 실패 시 대안

### 4.1 상태 모델 확장(NewProjectWizard)

현행 `status: 'idle' | 'loading' | 'ready' | 'error' | 'applying'` (L80) 에 두 상태 추가:

```ts
 status:
   | 'idle'
   | 'loading'
   | 'ready'            // items.length > 0
   | 'empty'            // items.length === 0 (정상 응답)
   | 'offlineFallback'  // 오프라인 · 최근 캐시 노출
   | 'error'            // 실패
   | 'applying'
```

- 빈 응답(`team.items.length === 0`) 은 `error` 가 아닌 `empty` 로 분기 — E-13.
- 오프라인 감지 후 캐시 적중이 있으면 `offlineFallback` 으로. 캐시가 없으면 일반 `error` 로.

### 4.2 빈 응답(E-13)

```
┌ 추천 결과 ──────────────────────────────────────┐
│                                                  │
│   🧭  추천할 팀을 찾지 못했어요                    │
│                                                  │
│   설명이 짧거나 일반적이어서 매칭이 어려웠어요.      │
│   아래 두 가지 중 하나로 진행해 보세요:            │
│                                                  │
│   ┌───────────────────┐  ┌───────────────────┐    │
│   │ ✏ 직접 에이전트 추가 │  │ 🕒 최근 추천 불러오기 │    │
│   │ 역할을 골라 추가해요  │  │ 캐시에서 {n}건         │    │
│   └───────────────────┘  └───────────────────┘    │
│                                                  │
│   💡 설명에 "웹/접근성/테스트" 같은 키워드를 덧붙이면 │
│      추천 정확도가 올라가요.                       │
│                                                  │
└──────────────────────────────────────────────────┘
```

- `EmptyState` 변형 — `variant="empty"`, icon=`<Compass>`, `action={label: '직접 에이전트 추가', onClick: navigateToAgentPanel}` 에 추가 버튼 1개를 custom children 으로 붙임.
- `[최근 추천 불러오기]` : `RecommendationCache.entries()` 를 순회해 최근 1개를 복원. 캐시 0건이면 버튼 disabled + 툴팁.

### 4.3 실패 상태(error)

- 기존 `ErrorState` 로. 제목 · 본문 · 재시도 버튼 + `[최근 추천 불러오기]` 보조 버튼.
- `classifyClaudeError` 결과에 따라 본문만 §3.2 카피 재사용.

### 4.4 오프라인 폴백(offlineFallback)

```
┌ 추천 결과(오프라인) ───────────────────────────┐
│  📡 오프라인 상태 — 최근 추천을 보여드려요       │
│     마지막 갱신: {relativeTime}                 │
│                                                 │
│   [👑 리더 · 기본 팀]  [🛠 개발자 · "웹" 키워드]    │  ← 캐시 카드
│                                                 │
│   ⚠ 연결이 돌아오면 새 추천을 자동으로 갱신할게요. │
└─────────────────────────────────────────────────┘
```

- 배너 `tone="warning"`. 추천 카드는 정상 모양 그대로, 배지만 "캐시" 라는 pill 추가.
- 온라인 복귀 시 자동으로 새 추천 요청 후 `ready` 로 전이 + 토스트 "추천을 새로 불러왔어요".

### 4.5 "최근 추천 불러오기" 버튼 배치

| 위치                                          | 노출 조건                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| 단계 2 리뷰 영역 우상단                        | 언제나 노출(단, `status === 'ready'` 이고 현재 추천이 최신이면 disabled) |
| `empty` 상태 카드 내부 우측                    | 캐시 1개 이상 있을 때                                                   |
| `error` 상태 `ErrorState` 의 secondary action  | 캐시 1개 이상 있을 때                                                   |
| `offlineFallback` 상태                         | 버튼 자체는 숨김(이미 캐시 중) — 대신 "수동 새로고침" 비활성 버튼 노출     |

- 버튼 컴포넌트는 단일 `<RecentRecommendationsButton />` 로 추출해 4 위치에서 재사용.
- 스크린리더 라벨: "최근 추천 {count}건 불러오기".

---

## 5. i18n 키 후보 — `errors.*` 네임스페이스

> Joker 가 `locales/{en,ko}.json` 에 바로 붙여 쓸 수 있도록 전 키를 제공. `{placeholder}` 는 런타임 치환.

### 5.1 세션 복원(§1)

| 키                                              | 한국어                                                         | English                                                     |
| ----------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| `errors.session.recovery.title`                  | 세션 복원 실패                                                   | Session restore failed                                       |
| `errors.session.recovery.body`                   | 저장된 세션 스냅샷을 불러오지 못했어요.                            | We couldn't load the saved session snapshot.                 |
| `errors.session.recovery.autoCountdown`          | {count}초 후 재시도 (시도 {attempt}/3)                            | Retrying in {count}s (attempt {attempt}/3)                  |
| `errors.session.recovery.stateTokenHistorySafe`   | 토큰 사용 이력: 별도 저장 · 유실 없음                              | Token history: stored separately · intact                    |
| `errors.session.recovery.stateDraftSaved`         | 대화 초안: 브라우저에 보존                                          | Chat draft: kept in browser                                  |
| `errors.session.recovery.stateOffline`             | 네트워크: 오프라인 — 재연결 대기                                    | Network: offline — awaiting reconnect                        |
| `errors.session.recovery.action.retryNow`          | 지금 다시 시도                                                    | Retry now                                                    |
| `errors.session.recovery.action.newSession`        | 새 세션 시작(주의)                                                | Start new session (caution)                                  |
| `errors.session.recovery.action.newSessionHint`    | 이전 스냅샷이 폐기될 수 있어요                                     | This may discard the previous snapshot                       |
| `errors.session.recovery.action.confirmNew`         | 정말 새 세션으로 시작할까요?                                       | Really start a new session?                                  |
| `errors.session.recovery.action.confirmYes`          | 새 세션 시작                                                      | Start new session                                            |
| `errors.session.recovery.action.confirmNo`          | 취소                                                              | Cancel                                                       |
| `errors.session.recovery.action.download`            | 이전 세션 스냅샷 다운로드                                           | Download previous snapshot                                   |
| `errors.session.recovery.action.viewTokenHistory`    | 토큰 사용 이력 보기                                                 | View token usage                                             |
| `errors.session.recovery.action.later`               | 나중에 다시                                                         | Later                                                        |
| `errors.session.recovery.badge`                       | 복구 대기 · 지금 시도                                                | Recovery pending · retry                                     |

### 5.2 MCP 끊김(§2)

| 키                                                   | 한국어                                                              | English                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `errors.mcp.disconnected.stdio.title`                 | stdio 연결이 {relativeTime} 끊겼어요                                  | stdio connection lost {relativeTime}                                |
| `errors.mcp.disconnected.stdio.body`                  | 자식 프로세스가 종료됐습니다.                                          | The child process exited.                                           |
| `errors.mcp.disconnected.stdio.saved`                  | 지금까지 받은 출력은 그대로 유지됩니다.                                | All output received so far is preserved.                             |
| `errors.mcp.disconnected.http.title`                   | HTTP 서버가 {relativeTime} 응답하지 않아요                             | HTTP server stopped responding {relativeTime}                        |
| `errors.mcp.disconnected.http.body`                    | 네트워크 상태 또는 엔드포인트를 확인해 주세요.                          | Check your network or endpoint status.                               |
| `errors.mcp.disconnected.http.saved`                   | 마지막 성공 응답은 캐시에 남아 있어요.                                  | The last successful response is kept in cache.                       |
| `errors.mcp.disconnected.streamable.title`              | 스트림이 {relativeTime} 끊겼어요                                       | Stream broken {relativeTime}                                          |
| `errors.mcp.disconnected.streamable.body`              | 부분 응답은 아래 보존돼 있어요.                                         | Partial responses are preserved below.                               |
| `errors.mcp.disconnected.streamable.saved`              | 재연결 시 이어 받을 수 있어요.                                          | Reconnecting will resume the stream.                                 |
| `errors.mcp.disconnected.action.reconnect`               | 재연결                                                                | Reconnect                                                            |
| `errors.mcp.disconnected.action.openDetail`              | 상세                                                                  | Details                                                              |
| `errors.mcp.disconnected.action.dismiss`                 | 닫기                                                                  | Dismiss                                                              |
| `errors.mcp.reconnected.toast`                            | MCP 서버에 다시 연결됐어요.                                             | Reconnected to the MCP server.                                       |

### 5.3 Anthropic API 실패(§3.1~§3.2)

| 키                                            | 한국어(제목·본문)                                                  | English                                                           |
| --------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `errors.anthropic.rate_limit.title`             | 요청이 일시 제한됐어요                                                | Requests rate-limited                                               |
| `errors.anthropic.rate_limit.body`               | {retryIn}초 후 자동으로 다시 시도합니다.                               | Retrying automatically in {retryIn}s.                              |
| `errors.anthropic.rate_limit.retryNow`           | 지금 재시도                                                           | Retry now                                                          |
| `errors.anthropic.overloaded.title`             | Claude 서버가 붐벼요                                                  | Claude servers are busy                                              |
| `errors.anthropic.overloaded.body`              | 곧 다시 시도할게요. 잠시 기다려 주세요.                                | Will retry shortly. Please hold on.                                 |
| `errors.anthropic.timeout.title`                | 응답이 늦어요                                                         | Response timed out                                                   |
| `errors.anthropic.timeout.body`                 | 네트워크가 불안정한 것 같아요. 다시 시도합니다.                         | Network looks unstable — retrying.                                   |
| `errors.anthropic.network.title`                | 연결이 끊겼어요                                                       | Connection lost                                                      |
| `errors.anthropic.network.body`                 | 인터넷 연결을 확인해 주세요.                                           | Please check your internet connection.                              |
| `errors.anthropic.token_exhausted.title`         | 토큰이 소진됐어요                                                     | Token quota exhausted                                               |
| `errors.anthropic.token_exhausted.body`          | 5시간 창 사용량이 100% 에 도달했어요. {resetClock} 에 초기화돼요.        | 5-hour window hit 100% — resets at {resetClock}.                   |
| `errors.anthropic.subscription_expired.title`    | 구독이 만료됐어요                                                     | Subscription expired                                                 |
| `errors.anthropic.subscription_expired.body`     | Claude 계정에서 결제 상태를 확인해 주세요.                              | Check billing on your Claude account.                                |
| `errors.anthropic.auth.title`                    | 인증이 필요해요                                                       | Authentication required                                              |
| `errors.anthropic.auth.body`                     | Claude 세션이 끊겼어요. 다시 로그인해 주세요.                           | Your Claude session ended — please sign in again.                    |
| `errors.anthropic.api_error.title`               | 요청에 문제가 있었어요                                                | Request failed                                                       |
| `errors.anthropic.api_error.body`                | 요청 ID {requestId} 로 기록됐어요.                                     | Logged as request ID {requestId}.                                    |
| `errors.anthropic.bad_request.title`              | 요청 형식 오류(개발)                                                   | Bad request (dev)                                                    |
| `errors.anthropic.bad_request.body`               | 요청 ID {requestId} — 개발자에게 공유해 주세요.                         | Request ID {requestId} — please share with the dev team.              |
| `errors.anthropic.action.copyRequestId`           | 요청 ID 복사                                                           | Copy request ID                                                      |
| `errors.anthropic.action.openAccount`             | Claude 계정 열기                                                       | Open Claude account                                                  |
| `errors.anthropic.action.openSettings`            | 설정 열기                                                              | Open settings                                                        |
| `errors.anthropic.action.signInAgain`             | 다시 로그인                                                            | Sign in again                                                        |

### 5.4 비용 급증(§3.3)

| 키                                        | 한국어                                                              | English                                                           |
| ----------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `errors.tokenUsage.costSurge.80.title`      | 🔔 세션 토큰 80% 도달                                                 | 🔔 Session tokens at 80%                                           |
| `errors.tokenUsage.costSurge.80.body`        | 캐시 활용을 늘려 절약하세요.                                           | Lean on cache to save.                                            |
| `errors.tokenUsage.costSurge.95.title`       | ⚠ 세션 토큰 95% 도달                                                  | ⚠ Session tokens at 95%                                            |
| `errors.tokenUsage.costSurge.95.body`        | 5분 내 만료 가능. 중요한 요청 먼저 처리하세요.                           | Window may expire within 5 min — prioritize key requests.          |
| `errors.tokenUsage.costSurge.action.viewDetail` | 상세 보기                                                              | View details                                                       |
| `errors.tokenUsage.costSurge.action.openThresholds` | 설정에서 임계 조정                                                      | Adjust thresholds in Settings                                     |

### 5.5 추천 빈·실패(§4)

| 키                                              | 한국어                                                                  | English                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `errors.recommend.empty.title`                   | 추천할 팀을 찾지 못했어요                                                  | No team matched                                                        |
| `errors.recommend.empty.body`                    | 설명이 짧거나 일반적이어서 매칭이 어려웠어요.                                | Your description was too short or too general for a match.             |
| `errors.recommend.empty.hint`                    | 💡 "웹/접근성/테스트" 같은 키워드를 덧붙이면 정확도가 올라가요.                 | 💡 Add keywords like "web/accessibility/test" to improve accuracy.      |
| `errors.recommend.empty.action.addManually`      | 직접 에이전트 추가                                                         | Add agents manually                                                    |
| `errors.recommend.empty.action.addManuallyHint`  | 역할을 골라 추가해요                                                      | Pick roles to add                                                      |
| `errors.recommend.recent.action`                   | 최근 추천 불러오기                                                          | Load recent recommendations                                             |
| `errors.recommend.recent.count`                    | 캐시에서 {n}건                                                             | {n} in cache                                                            |
| `errors.recommend.recent.emptyHint`                | 이전 추천이 없어요.                                                         | No previous recommendations.                                            |
| `errors.recommend.offline.title`                   | 오프라인 상태 — 최근 추천을 보여드려요                                       | Offline — showing recent recommendations                                |
| `errors.recommend.offline.lastUpdated`             | 마지막 갱신: {relativeTime}                                                 | Last updated: {relativeTime}                                            |
| `errors.recommend.offline.autoRefresh`             | 연결이 돌아오면 자동으로 갱신할게요.                                         | We'll refresh once you're back online.                                   |
| `errors.recommend.error.title`                     | 추천을 불러오지 못했어요                                                    | Could not load recommendations                                         |
| `errors.recommend.error.retry`                      | 다시 시도                                                                    | Retry                                                                   |

---

## 6. 접근성 체크리스트 — ARIA live region · role 기준

### 6.1 role · aria-live 매트릭스

| UI 요소                              | role              | aria-live  | 근거                                                                                                         |
| ------------------------------------ | ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| 세션 복원 모달                        | `alertdialog`      | (기본)     | 사용자 결정 필요. 포커스 트랩 필수.                                                                          |
| 세션 복원 카운트다운 숫자              | `timer`            | `off`       | 숫자 변화 낭독 과다 방지 — 10초 단위 변화만 polite 로 업데이트(아래 6.3).                                      |
| 세션 복원 "나중에" 배지                | `button`           | —          | 클릭 가능 배지.                                                                                              |
| MCP 끊김 배너                          | `status`           | `polite`   | 작업 중단 없음(E-08 · 톤 warning).                                                                          |
| MCP 재연결 성공 토스트                  | `status`           | `polite`   | 긍정 알림.                                                                                                   |
| Anthropic error 토스트(우선순위 1)     | `alert`            | `assertive` | `token_exhausted`·`auth`·`subscription_expired` — 즉시 주목 필요.                                             |
| Anthropic warning 토스트(우선순위 2·3) | `status`           | `polite`   | `rate_limit`·`overloaded`·`timeout`·`network`·`api_error` — 흐름 유지.                                         |
| 비용 급증 80% 토스트                    | `status`           | `polite`   | 정보 전달. 사용자가 즉각 행동할 필요 없음.                                                                   |
| 비용 급증 95% 토스트                    | `alert`            | `assertive` | 5분 내 만료 가능 — 즉시 의식해야 함.                                                                          |
| 추천 empty 영역                         | `region`           | `polite`   | `aria-label="추천 결과"` · 상태 전환 시 polite 알림.                                                           |
| 추천 error `ErrorState`                 | `alert`            | `assertive` | 기존 `ErrorState` 계약.                                                                                      |
| 추천 offlineFallback                    | `status`           | `polite`   | 이미 캐시로 내용 표시. assertive 불필요.                                                                    |
| "인라인 확인"(새 세션 2단계)           | 전환 시 `alert` 토큰 | `assertive` | "확인이 필요합니다" 1회 낭독 후 role 원복.                                                                  |

### 6.2 키보드 · 포커스

| 기능                    | 초기 포커스                     | 주요 단축                                                          |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------ |
| 세션 복원 모달            | `[지금 다시 시도]` primary 버튼  | Esc 열린 상태에서 확인 전 → 건드리지 않음(파괴 방지) · Enter 재시도 |
| 세션 복원 인라인 확인      | `[새 세션 시작]` 버튼             | Esc 로 취소(정적 복귀)                                              |
| MCP 끊김 배너             | `[재연결]` 버튼(탭으로 진입 시) | Enter 재연결 · Esc 닫기                                            |
| 토스트(error 무기한)      | 토스트 내부 첫 버튼               | Esc 닫기(ToastProvider T-06 계승)                                   |
| 추천 empty               | `[직접 에이전트 추가]`            | Tab 두 카드 순회                                                   |

### 6.3 낭독 최소화 가이드

- **카운트다운 숫자**는 매 초마다 낭독하지 않는다. `aria-live="off"` 로 고정하고, 5초·마지막 1초에만 `aria-live="polite"` 로 `"5초 뒤 재시도"` 문장을 따로 주입.
- **토스트 다발 발생 시** 같은 id 병합(T-09) 로 한 번만 낭독.
- **MCP 끊김 시간 변경**(30초 전 → 1분 전 등) 은 낭독하지 않는다 — 시각만 업데이트.

### 6.4 대비 · 색

- error · warning · info 세 팔레트의 텍스트/배경 조합은 모두 기존 시안 `cross-feature-onboarding-and-state-audit-2026-04-21.md` §4.3 의 AA 통과 기준을 이미 만족.
- **비용 급증 토스트의 이모지**(🔔 · ⚠) 는 **텍스트 라벨과 중복 신호** — 색 단독 의존(O-14) 금지.
- 인라인 확인 3초 카운트다운 숫자는 본문 색 그대로(`--color-text`) + 가는 회색 배경 링으로 시각 경계.

---

## 7. 우선순위 · 중복 · 큐 제어

### 7.1 토스트 ↔ 모달 ↔ 배너 3계층 분리

```
 다이얼로그(모달) : 사용자 결정 필수            ← SessionRecoveryModal
 배너           : 상태 고정 + 행동 유도         ← McpDisconnectedBanner
 토스트          : 일시 알림(자동 만료 가능)    ← Anthropic errors · costSurge
```

- **동시에 발생** 하면 모달이 최상위. 그 다음 배너, 그 다음 토스트.
- 모달이 열려 있어도 토스트는 뒤에 쌓임(사용자가 복구 후 확인 가능). 단 assertive 알림은 1회로 제한해 스크린리더 소음 방지.

### 7.2 id 규칙

- `ToastProvider.push({ id, ... })` 의 id 는 병합 키.
- 본 시안 권고 id:
  - `anthropic.<category>` (요청 ID 없는 경우)
  - `anthropic.<category>.<requestId>` (요청 ID 있는 경우)
  - `tokenUsage.costSurge.80` / `...95`
  - `mcp.reconnected.<serverId>`
  - `session.recovery.notice` (배지와 동기화)
- 같은 id 는 수명 리셋(T-09). 변수부가 다르면 별개 토스트.

---

## 8. 컴포넌트 트리 · 파일 배치

```
src/components/
  SessionRecoveryModal.tsx               (신규 · §1)
  SessionRecoveryBadge.tsx                (신규 · §1.5)
  McpDisconnectedBanner.tsx               (신규 · §2 · ErrorState tone=warning 래퍼)
  RecentRecommendationsButton.tsx         (신규 · §4.5 공용 버튼)
  ToastProvider.tsx                       (기존 · 변경 없음)
  ErrorState.tsx                          (기존 · tone='warning' prop 추가 — 선행 시안 §3.4)
  EmptyState.tsx                          (기존 · 그대로)

src/ui/
  NewProjectWizard.tsx                    (기존 · status 모델 확장: empty · offlineFallback)

src/utils/
  anthropicErrorToasts.ts                  (신규 · classifyClaudeError → ToastInput 변환)
  tokenCostSurgeDetector.ts                (신규 · 누적 80/95% 임계 이벤트)
  sessionSnapshotRecovery.ts               (신규 · 자동 재시도 + 카운트다운 pure logic)

locales/
  en.json · ko.json                       (§5 errors.* 전량 추가 — 평면 구조 계승)
```

- 신규 CSS 토큰 · 변수 **0건**. 전부 기존 토큰 재사용.
- `anthropicErrorToasts.ts` 는 `classifyClaudeError` 결과를 받아 `ToastInput` 배열을 돌려주는 순수 함수. 호출부(`agentWorker`·`DirectivePrompt`) 가 `useToast().push(...)` 로 꽂아 쓴다.

---

## 9. 결정 대기(Kai · Joker · QA)

| ID    | 질문                                                                                      | 대상     |
| ----- | ----------------------------------------------------------------------------------------- | -------- |
| R-E1  | 자동 재시도 간격 10·20·40초가 적정한지 — 프로덕션 스냅샷 복원 시간 실측 대기                    | Joker    |
| R-E2  | "이전 세션 스냅샷 다운로드" 포맷 — JSON 단일 파일 vs tar.gz 번들                                  | Kai      |
| R-E3  | `SessionRecoveryBadge` 위치 우선순위(상단바 우측 vs 사이드바 상단)                              | Kai      |
| R-E4  | stdio 재연결 시 자식 프로세스 재기동 권한 — OS 수준 확인 대화 필요 여부                            | Joker    |
| R-E5  | streamable-http "이어 받기" 가 실제 서버 측 `Last-Event-ID` 재개 지원 여부                       | Joker    |
| R-E6  | 비용 급증 80/95% 임계를 사용자가 조정할 수 있도록 `TokenUsageSettingsPanel` 에 항목 추가 여부   | Joker    |
| R-E7  | `bad_request` 카테고리를 info 로 강등하는 것이 사용자 탓이 아닌 관점에서 적절한지                | Kai      |
| R-E8  | "최근 추천 불러오기" 버튼이 단계 2 우상단에 노출되는 것이 시각적으로 혼잡하지 않은지              | QA 사용성 |
| R-E9  | 비용 급증 95% 토스트를 모달로 승격할지(현재는 error 토스트 무기한)                              | Kai      |
| R-A1  | Anthropic 우선순위 1 토스트가 동시 발생 시 큐 처리 규약 실측(SR 낭독 겹침)                       | QA       |
| R-A2  | 카운트다운 aria-live 5초·마지막 1초 규약이 실제 SR(NVDA/JAWS/VoiceOver) 에서 자연스러운지         | QA       |

---

## 10. 구현 권고 요약(Joker 이관)

1. **`ErrorState` 에 `tone` prop 추가** — 선행 시안 §3.4 와 본 시안 모두 전제.
2. **`NewProjectWizard.status` 에 `empty`·`offlineFallback` 추가** — 빈 응답과 오프라인 폴백 분리.
3. **`ToastProvider` API 는 그대로** — id 규약만 문서화(§7.2).
4. **신규 순수 함수 3개** (`anthropicErrorToasts` · `tokenCostSurgeDetector` · `sessionSnapshotRecovery`) 는 모두 `node:test` 단위 테스트 작성 — UI 없이 로직 단독 회귀 방지.
5. **locales 키 이관** — `errors.*` 네임스페이스로 §5 전량 추가. 키 이름 체계는 `errors.<feature>.<state>.<slot>`.

---

끝.
