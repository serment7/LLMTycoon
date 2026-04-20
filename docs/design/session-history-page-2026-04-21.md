---
date: 2026-04-21
owner: Designer (LLMTycoon)
trigger-directive: "지시 #906a32cd — 세션 이력 페이지(리스트·상세·검색·상태)"
prior-context:
  - src/services/multimedia/adapters/WebSearchAdapter.ts (우선 검토 파일 — 외부 호출 로그의 "공급자별 집계" 규약이 §2.3 MCP 전송 호출 횟수 섹션의 선례)
  - src/components/ConversationSearch.tsx (대화 검색 · Ctrl/Cmd+F · MessageMatch · `--conversation-search-z-index` = 1150)
  - src/utils/conversationSearch.ts (findSearchMatches · splitHighlightSegments)
  - src/components/CollabTimeline.tsx (ledger 타임라인 렌더 · role 필터 · handoffLedger 집계)
  - src/utils/claudeSubscriptionSession.ts (SubscriptionSessionState · windowStartMs · 5시간 리셋)
  - src/utils/claudeTokenUsageStore.ts (4축 토큰 카운터 · input/output/cacheRead/cacheCreation)
  - src/components/EmptyState.tsx · src/components/ErrorState.tsx (상태 3종 공용 템플릿)
  - src/hooks/useOnlineStatus.ts (오프라인 감지)
  - src/i18n/index.ts (translate · useLocale · 폴백 3단)
  - docs/design/token-savings-visualization-2026-04-21.md (3색 바 · .tok-num 타이포 · 스파크라인 규약)
  - docs/design/cross-feature-onboarding-and-state-audit-2026-04-21.md (4×4 상태 감사 · ErrorState tone='warning' 제안)
  - docs/design/error-recovery-ux-2026-04-21.md (CompactionEvent 스키마 · 압축 이력 타임라인 카드)
  - docs/design/project-creation-agent-recommendation-2026-04-20.md (AgentRole 5종 · 카드 레이아웃)
  - docs/design/mcp-transport-and-language-toggle-2026-04-20.md (transport 3종 · 공급자 호출 집계 분기)
report-to: Joker (dfce6d78-c2c8-4263-b189-6dfe1a3a1f23)
scope:
  - "세션 리스트 화면(날짜 그룹 · 카드 · 3색 미니 바 · 압축 횟수 · 최근 활동 · 이어서 작업) 와이어프레임"
  - "세션 상세 드로어(요약 · 토큰 추세 스파크라인 · MCP 전송별 호출 · 압축 이력 타임라인) 정보 구조"
  - "검색·필터(프로젝트·기간·에이전트 역할·단어 검색) 상호작용 규약"
  - "빈 상태·스켈레톤·오류 상태 3종 + EN/KO 타이포 토큰 일관성"
  - "sessionHistory.* i18n 키 후보 전량 + 접근성 체크리스트"
---

# 세션 이력 페이지 — 리스트 · 상세 · 검색 · 상태 (2026-04-21)

직전 네 축 시안(**토큰 절약** · **에러 복구** · **MCP 전송** · **에이전트 추천**) 이 모두 "지금 이 세션" 축이었다면, 본 시안은 **"과거 세션" 축** 을 추가한다. 사용자는 5시간 창이 여러 번 리셋된 후에도 "언제 어떤 에이전트가 얼마나 썼는지" 를 **한 페이지에서** 되짚고, 필요하면 **"이어서 작업"** 버튼으로 과거 세션 맥락을 복원할 수 있어야 한다.

본 시안은 **기존 컴포넌트 · 토큰 · i18n 인프라 위에서** 새 탭 하나(`session-history`) 와 드로어 하나(`SessionDetailDrawer`) 만 추가한다. 새 색 토큰·신규 애니메이션은 없다.

> 우선 검토 파일 `src/services/multimedia/adapters/WebSearchAdapter.ts` 의 "공급자별(Bing/Brave/DuckDuckGo) 호출 집계" 패턴(SearchProvider.id 축) 은 본 시안 §2.3 "MCP 전송별 호출 횟수" 카드의 **축 정합성 선례** 다. 세션 상세에서 `stdio / http / streamable-http` 3 축을 같은 카드 모양으로 집계해 "어댑터 기반 집계 = 공급자 기반 집계" 의 시각 언어를 재사용한다.

---

## 0. 설계 원칙 (H-01 ~ H-14)

### 0.1 정보 구조(H-01 ~ H-05)

| ID   | 원칙 |
| ---- | ---- |
| H-01 | **탭 신설은 최소화**: App.tsx 의 기존 탭 6종(`game / projects / agents / tasks / project-management / multimedia`) 에 `session-history` 한 개만 추가. 기존 탭 경로 재정비 금지 — 회귀 위험. |
| H-02 | **리스트는 날짜 그룹**: 오늘 · 어제 · 이번 주 · 이전(4 버킷). 버킷 라벨 자체는 접기 불가 — 공용 레이아웃 규약(`error-recovery-ux-2026-04-21.md` §2.3 카드 3 계승). |
| H-03 | **세션 = 5시간 창**: `SubscriptionSessionState.windowStartMs` 를 고유 ID 로 사용. 같은 날 여러 세션이 있을 수 있고, 한 세션이 자정을 넘길 수 있음. **자정 경계는 "시작 시각 기준" 으로 한 버킷에 귀속** 하되 카드에 "→ 다음날 HH:mm" 표기. |
| H-04 | **상세는 드로어**: 전체 페이지 이동 없이 우측 슬라이드(폭 520px). 리스트 뒤 스크롤 위치 보존. 모달 아닌 드로어인 이유 — 사용자가 "리스트로 돌아가기" 를 시각적으로 보고 있어야 맥락 유지. |
| H-05 | **검색은 탭 최상단 고정**: 스크롤해도 검색바가 sticky. 리스트 자체가 길어지는 기능 특성(수주~수개월 누적). |

### 0.2 시각 · 상태(H-06 ~ H-10)

| ID   | 원칙 |
| ---- | ---- |
| H-06 | **3색 미니 바 재사용**: 선행 시안 `token-savings-visualization-2026-04-21.md` §1 의 `SessionBreakdownBar` 를 카드 폭에 맞춰 축소. 새 색/규약 금지. |
| H-07 | **"이어서 작업" 은 카드당 1 primary**: 카드 hover/포커스 시 노출. 상시 노출 시 카드 리듬이 깨짐. 키보드 사용자를 위해 **포커스 시에도 반드시 노출**(hover-only 금지). |
| H-08 | **상태 3종은 공용 템플릿**: 로딩 = `EmptyState variant="loading"`, 빈 = `EmptyState variant="empty"`, 오류 = `ErrorState`. 선행 시안 §3.1 계승. |
| H-09 | **압축 횟수는 한 자릿수 bold + 아이콘**: `✦ 3회`. 0 이면 "—" 로 표기해 "기록 없음" 과 "압축 미발생" 을 구분. |
| H-10 | **최근 활동 요약은 1줄 ≤ 48자**: "Joker 가 5개 파일 편집" / "QA 가 3개 테스트 실행". 줄바꿈 금지, 넘치면 말줄임. |

### 0.3 접근성 · i18n(H-11 ~ H-14)

| ID   | 원칙 |
| ---- | ---- |
| H-11 | **리스트는 `role="list"` · 카드는 `role="listitem"`**: 스크린리더가 총 개수를 말할 수 있도록. 필터/검색 결과 변경 시 `aria-live="polite"` 로 "세션 N건 찾음" 1회 낭독. |
| H-12 | **키보드 탐색 ↑↓ 고정**: 카드 포커스 이동은 `↑/↓`, 드로어 열기 Enter, 닫기 Esc. `roving tabindex` 로 Tab 은 필터 그룹↔리스트 경계만 옮긴다. |
| H-13 | **EN/KO 공통 타이포 토큰**: 숫자는 `.tok-num` (선행 시안 §5.3), 본문은 `var(--font-sans)`, 메타라벨은 `var(--font-mono)` 소문자 `10px`. 날짜 그룹 헤더는 `--font-size-md` bold. |
| H-14 | **미번역 키 폴백**: `translate()` 3단 계단(`src/i18n/index.ts:148-157`) 그대로. 본 시안 카피가 빠지면 영어로, 그래도 없으면 key 원문. 레이아웃이 깨지지 않도록 key 도 `.tok-num` 하위에 들어가면 tabular-nums 유지. |

---

## 1. 세션 리스트 화면

### 1.1 전체 레이아웃

```
┌ App · activeTab='session-history' ─────────────────────────────────────────────────────┐
│                                                                                          │
│  ╔═ sticky header (56px) ═══════════════════════════════════════════════════════════╗   │
│  ║ 📚 세션 이력                                            [필터(3)▾]  [🔍 검색 ⌃F]    ║   │
│  ║                                                                                    ║   │
│  ║ ┌─ FilterChips (열림 시 높이 +44px) ──────────────────────────────────────────┐    ║   │
│  ║ │ 프로젝트: [모든 프로젝트 ▾]  기간: [최근 7일 ▾]  역할: [모든 역할 ▾]    [초기화] │    ║   │
│  ║ └───────────────────────────────────────────────────────────────────────────────┘    ║   │
│  ║ 🔍 검색: "_____________________"   ← 열림 시 inline; Esc 닫기                        ║   │
│  ║                                                                                    ║   │
│  ║ 세션 {count}건 · {windowHint}                                    [CSV 내보내기]      ║   │
│  ╚════════════════════════════════════════════════════════════════════════════════════╝   │
│                                                                                          │
│  ── 오늘 (2026-04-21) ──                                                                  │
│  [SessionCard · 09:10 → 14:20]                                                            │
│  [SessionCard · 17:05 → 진행 중]                                                          │
│                                                                                          │
│  ── 어제 (2026-04-20) ──                                                                  │
│  [SessionCard · 22:45 → 03:15 (다음날)]                                                   │
│                                                                                          │
│  ── 이번 주 (4/14 ~ 4/19) ──                                                              │
│  [SessionCard × N]                                                                        │
│                                                                                          │
│  ── 이전 ──                                                                                │
│  [SessionCard × N] · [더 보기 (~페이지 단위)]                                              │
│                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 `SessionCard` 레이아웃

```
┌ SessionCard ──────────────────────────────────────── (role="listitem", 폭 100%, 높이 112px) ──┐
│                                                                                                │
│  ┌─ 왼쪽(식별·시간, 폭 180) ──────┬─ 중앙(지표·활동, flex-1) ────────┬─ 오른쪽(액션, 폭 160) ──┐ │
│  │ 🪟 09:10 → 14:20               │ [▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮] 156K/500K  │       [▶ 이어서 작업]    │ │
│  │ (5시간 10분 · 자정 포함 X)      │  입 76K · 출 32K · 캐시 48K   │                          │ │
│  │                               │                               │   [👁 상세 보기]           │ │
│  │ 프로젝트: llm-tycoon           │  ✦ 자동 압축 3회              │                          │ │
│  │ 참여: 👑🛠♿ (3명)              │  📝 Joker 가 5개 파일 편집     │                          │ │
│  └────────────────────────────────┴───────────────────────────────┴──────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **왼쪽**: 시작시각→종료시각 한 줄 + 세션 길이(분), 프로젝트 이름(truncate 20자), 참여 에이전트 이모지(최대 5개, 넘으면 `+N`).
- **중앙**: `SessionBreakdownBar` 축소(폭 100%, 높이 6px) + 4축 작은 텍스트 + 압축 카운트 + 최근 활동 요약.
- **오른쪽**: `[▶ 이어서 작업]` primary, `[👁 상세 보기]` ghost. hover/포커스 시 등장(H-07 — 상시 숨김 아님, 카드 나머지 영역이 살짝 어두워지고 버튼만 선명).
- 전체 카드 클릭은 `[👁 상세 보기]` 와 동일(드로어 오픈). `[▶ 이어서 작업]` 만 별도 액션.

### 1.3 상태별 시각

| 상태                       | 외곽 테두리                       | 라벨/배지                                            |
| -------------------------- | --------------------------------- | ---------------------------------------------------- |
| 정상(완료됨)                | `var(--color-border)`              | —                                                    |
| 진행 중(이번 세션)           | `var(--color-accent)` 1px + pulse | 우상단 `🟢 진행 중` 배지                               |
| 강제 종료(크래시 · 수동 새 세션) | `var(--color-danger) 1px`        | 우상단 `⚠ 비정상 종료` 배지 + 툴팁 "세션 복원 실패로 종료" |
| 오프라인 수집분만 있음       | `var(--color-warning)` 1px       | 우상단 `📡 오프라인 수집` 배지                         |

- 색 단독 신호 금지(선행 시안 §0.14) — 모두 배지 아이콘 · 텍스트 병행.

### 1.4 "이어서 작업" 동작

- 클릭 시:
  1. 해당 세션의 `projectId` 로 전환 (`game` 탭으로 이동).
  2. 대화 초안/파일 드래프트가 `draftStore` 에 있으면 복원.
  3. 세션 스냅샷 다운로드 파일(`error-recovery-ux-2026-04-21.md` §1.3) 이 있으면 자동 import 제안 모달.
  4. `aria-live` 로 "세션을 복원했어요. 프로젝트 llm-tycoon 으로 이동합니다" 낭독.
- 비활성 조건: 프로젝트가 삭제됨 · 세션 스냅샷 만료(30일 초과) 시 버튼 disabled + 툴팁 이유.

### 1.5 날짜 버킷 로직

- `today` : `Date.now() - startedAtMs < 24h` + 같은 달력일.
- `yesterday` : 같은 규칙 · 전일.
- `thisWeek` : ISO 주 기준(월요일 시작). `yesterday` 가 이번 주에 속해도 `yesterday` 버킷 우선.
- `earlier` : 그 외 전부. 내부는 최신순.
- 버킷이 비어 있으면 해당 헤더 자체 생략(O-12 계승).

---

## 2. 세션 상세 드로어

### 2.1 배치

```
┌ App ─────────────────────────────────────────┬─ SessionDetailDrawer (폭 520px) ────────┐
│  (세션 리스트 — 스크롤 위치 유지 · 어두워짐)    │ 🪟 2026-04-21 09:10 → 14:20              │
│                                              │ (5시간 10분 · llm-tycoon)        [✕ 닫기]│
│                                              │─────────────────────────────────────────│
│                                              │                                         │
│                                              │ ╔═ 카드 1 · 대화 요약 ═════════════╗     │
│                                              │ ║ · 24개 메시지 · 5명 참여          ║     │
│                                              │ ║ · 주요 주제(자동 요약 한 줄 ≤60) ║     │
│                                              │ ║ · [💬 대화로 이동]                ║     │
│                                              │ ╚═══════════════════════════════════╝     │
│                                              │                                         │
│                                              │ ╔═ 카드 2 · 토큰 추세 스파크라인 ════╗    │
│                                              │ ║ 5시간 창 구간별 10분 간격 31점     ║    │
│                                              │ ║ [sparkline SVG · 현재 점 amber]   ║    │
│                                              │ ║ 합계 156K · 캐시 적중 31%          ║    │
│                                              │ ╚═══════════════════════════════════╝     │
│                                              │                                         │
│                                              │ ╔═ 카드 3 · MCP 전송별 호출 횟수 ═══╗     │
│                                              │ ║ stdio            124회 ▮▮▮▮▮▮▮▮  ║    │
│                                              │ ║ http              32회 ▮▮▮        ║    │
│                                              │ ║ streamable-http   18회 ▮▮          ║    │
│                                              │ ║ (총 174회 · 실패 3회)              ║    │
│                                              │ ╚═══════════════════════════════════╝     │
│                                              │                                         │
│                                              │ ╔═ 카드 4 · 자동 압축 이력 ═════════╗     │
│                                              │ ║ ✦ 14:02 Joker  248K→72K  −71%     ║     │
│                                              │ ║ ✦ 11:47 Thanos 180K→61K  −66%     ║     │
│                                              │ ║ ✦ 10:03 QA      98K→40K  −59%     ║     │
│                                              │ ╚═══════════════════════════════════╝     │
│                                              │                                         │
│                                              │ [📥 세션 JSON 다운로드] [▶ 이어서 작업]   │
└──────────────────────────────────────────────┴─────────────────────────────────────────┘
```

- `role="dialog" aria-modal="false"` (모달 아님 — 뒤 리스트 읽기 가능).
- 포커스: 드로어 오픈 시 자동으로 제목에 포커스. Esc 닫기 → 리스트의 원래 카드로 포커스 복귀.
- 스크롤: 드로어 내부는 독립 스크롤. 카드 간 간격 `var(--space-lg)` 16px.

### 2.2 카드 1 — 대화 요약

- 자동 요약 문장은 **세션 종료 직후 1회** 생성해 저장. 본 시안은 표시 규약만 — 요약 엔진은 Joker 선택.
- `[💬 대화로 이동]` : "이어서 작업" 과 비슷하되 **읽기 전용 모드** 로 대화 영역 오픈(과거 세션이므로 전송 불가).
- 실패(요약 엔진 에러) : "요약을 만들지 못했어요. 기본 통계만 표시합니다." `tone="warning"` 안내.

### 2.3 카드 2 — 토큰 추세 스파크라인

- 5시간 창을 **10분 간격 31점** 으로 정규화. 모자라면 앞쪽에 `null` 점으로 공백 유지(가로 비율 일관성).
- 색: 기존 시안 `token-savings-visualization-2026-04-21.md` §2.3 카드 1 재사용. 현재 세션(`진행 중`) 이면 마지막 점만 pulse.
- hover 시 `{time} · {amount} · 캐시 {pct}%` 툴팁.

### 2.4 카드 3 — MCP 전송별 호출 횟수

본 카드는 우선 검토 파일 `WebSearchAdapter.ts` 의 "공급자별 집계" 시각 언어를 **MCP 전송 축** 으로 전용한 것이다.

- 3 행 고정: `stdio / http / streamable-http`. 해당 세션에 발생 0 이어도 행은 노출(비교 직관).
- 각 행: `[transport 라벨] [숫자] [수평 바]`. 바 폭 = max(행 전부) 기준 상대 비율.
- 마지막 행 아래 `(총 {total}회 · 실패 {fail}회)` 메타.
- 실패 > 0 이면 숫자 옆에 `⚠` 아이콘 + 호버 툴팁 "실패 사유 상세 보기" → `McpDisconnectedBanner`(`error-recovery-ux-2026-04-21.md` §2) 와 연동된 로그 뷰.

### 2.5 카드 4 — 자동 압축 이력

- 구조는 `error-recovery-ux-2026-04-21.md` §3.3 의 `CompactionEvent` 스키마를 그대로 소비.
- 드로어 카드 폭이 좁으므로 한 줄에 모두 들어가지 않으면 `reason` 은 **다음 줄로 내리기 금지** — 말줄임 + 호버 툴팁으로 전체.
- 압축 0건이면 카드 자체 숨김(리스트와 다른 규약 — 드로어는 공간이 귀하다).

### 2.6 드로어 푸터

- `[📥 세션 JSON 다운로드]` : 전체 세션(메시지/토큰/압축/MCP 호출 포함) 을 JSON 단일 파일로 저장. 파일명 `llmtycoon-session-{projectId}-{yyyyMMdd-HHmm}.json`.
- `[▶ 이어서 작업]` : 리스트 카드와 동일 동작(§1.4).

---

## 3. 검색 · 필터

### 3.1 검색바

- 위치: sticky 헤더 하단 inline. `Ctrl+F` / `Cmd+F` 로 열림/닫힘(기존 `ConversationSearch` 의 `isOpenSearchShortcut` 로직 공유 — 페이지가 `session-history` 일 때는 본 검색에 바인딩, 그 외 탭에서는 대화 검색에 바인딩).
- 매치 대상:
  1. 세션에 참여한 **에이전트 이름**(`Joker`, `Thanos` 등)
  2. **대화 본문**(`findSearchMatches` 재사용 — 순수 함수이므로 세션 단위로 반복)
  3. 프로젝트 이름
  4. 압축 이력의 `reason`
- 결과 강조: 카드 제목/요약에서 매치 부분을 `<mark>` 태그로 감싸기. 토큰은 `var(--color-info-surface)` + 굵기.

### 3.2 필터 그룹

| 필터           | 형식                                       | 기본값                              | 기술 메모                                                           |
| -------------- | ------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------ |
| 프로젝트        | 드롭다운(단일 선택) + `모든 프로젝트`         | `모든 프로젝트`                      | 사용자가 참여한 프로젝트만 노출. `projectId` 필터.                  |
| 기간           | 프리셋 드롭다운 + 커스텀 범위                | `최근 7일`                          | `오늘 / 어제 / 최근 7일 / 최근 30일 / 전체 / 사용자 지정` 6종. 커스텀은 달력 위젯. |
| 역할            | 멀티 선택 체크박스(Popover)                  | 전체 체크                           | Leader / Developer / QA / Designer / Researcher (5종) 하나라도 참여 세션 |
| 언제 자동 압축? | 토글("압축 발생한 세션만")                   | 꺼짐                                | 스위치. 켜면 `compactionCount > 0` 만.                              |

- 현재 활성 필터 수를 헤더의 `[필터(N) ▾]` 칩에 숫자로 표기.
- `[초기화]` 클릭 시 모든 필터 기본값 복귀 + `aria-live` "필터를 초기화했어요".
- 필터 상태는 URL 쿼리 파라미터로 직렬화(`?project=...&range=7d&role=developer,qa` 등) — 딥링크·뒤로가기 지원.

### 3.3 필터 · 검색의 교집합

- 두 축은 AND 결합. 검색 결과가 0건이면 빈 상태(§4.2) 와 같은 문구 + `[필터 초기화]` CTA.
- 성능: 최대 500 세션까지는 클라이언트 필터 O(n). 그 이상이면 서버 측 페이지네이션(`cursor` 파라미터) — 본 시안 범위 밖이나 URL 구조에서 미리 여지 남김.

---

## 4. 상태 3종 — 빈 · 로딩 · 오류

### 4.1 로딩(첫 진입 · 필터 변경 후)

- `EmptyState variant="loading"` + 2초 뒤에도 로딩이면 **카드 3장 스켈레톤** 으로 전환해 "페이지가 살아 있다" 신호.
- 스켈레톤: 카드 외곽 · 왼쪽/중앙/오른쪽 3블록 · pulse `var(--motion-duration-lg)` = 360ms. `prefers-reduced-motion` 이면 펄스 제거.

### 4.2 빈 — 처음 시작하는 사용자 / 필터가 너무 좁음

**최초 접속(누적 세션 0):**

```
┌ EmptyState variant=empty · icon=History ──────────────────────────────────────┐
│                                                                                │
│                         📚                                                      │
│                                                                                │
│                  아직 완료된 세션이 없어요                                        │
│                                                                                │
│   첫 대화를 마치면 여기에 세션 카드가 쌓여요.                                      │
│   5시간 창마다 자동으로 한 세션이 마감됩니다.                                      │
│                                                                                │
│                   [💬 새 대화 시작하기]                                           │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

**필터 결과 0건:**

```
┌ EmptyState variant=empty · icon=FilterX ──────────────────────────────────────┐
│                                                                                │
│                  필터에 맞는 세션이 없어요                                        │
│                                                                                │
│   {activeFilterSummary}                                                        │
│   예: "프로젝트: llm-tycoon · 최근 7일 · 역할: Designer"                         │
│                                                                                │
│                   [필터 초기화]                                                  │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 오류(로드 실패)

- `ErrorState` (기존 · `tone="danger"` 기본).
- 재시도 버튼 + 보조 `[오프라인 캐시 보기]` (최근 30 세션 로컬 스냅샷이 있을 때만).
- 오프라인 감지(`useOnlineStatus`) 시 `tone="warning"` 로 분기 + 문구 "오프라인 상태 · 캐시된 세션만 표시".

---

## 5. 타이포그래피 · 토큰 규약

| 역할                    | 토큰                                               | 비고                                                         |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| 페이지 제목              | `--font-size-xl` + `--font-weight-bold`            | "📚 세션 이력"                                               |
| 날짜 그룹 헤더            | `--font-size-md` + `--font-weight-bold` + `letter-spacing 0.05em` | "오늘 (2026-04-21)"                                          |
| 카드 제목(시간 범위)      | `--font-size-sm` + `--font-weight-bold` · `.tok-num` | `09:10 → 14:20` · tabular-nums 로 자리 정렬                   |
| 숫자(토큰·압축 횟수)      | `.tok-num` + `--font-mono`                          | 선행 시안 `token-savings-visualization-2026-04-21.md` §5.3 그대로 |
| 요약·라벨(한글 본문)      | `--font-size-sm` + `line-height 1.35`               | H-13 계승                                                    |
| 메타(프로젝트 이름 등)    | `--font-size-xs` + `--color-text-muted`             | 10px                                                         |
| 강조 검색 매치            | `<mark>` + `--color-info-surface` + `--font-weight-bold` | 선행 검색 규약 재사용                                       |

- 신규 토큰 **0건**. 전부 재사용.

---

## 6. 접근성 체크리스트

### 6.1 키보드 탐색

| 위치                | 기대                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------- |
| 탭 진입             | `session-history` 탭이 `aria-selected="true"` 되고 sticky 헤더 첫 상호작용(필터 버튼) 에 포커스 |
| 헤더 → 리스트        | Tab 1회로 필터/검색 영역을 지나 첫 카드(첫 버킷 첫 카드) 로 이동. roving tabindex 도입.    |
| 카드 순환             | ↑/↓ 로 카드 간 이동(버킷 경계 자동 통과). PageUp/PageDown 으로 한 화면 단위 점프.          |
| 드로어 오픈          | Enter 또는 Space. 오픈 후 포커스는 드로어 제목에.                                       |
| 드로어 닫기          | Esc. 포커스는 원래 카드로 복귀(focus-trap 해제 + returnFocusTo).                         |
| 이어서 작업 단축키    | 카드 포커스 상태에서 `g` → "이어서 작업" 실행(비마우스 사용자 편의).                      |
| 검색 열기/닫기        | Ctrl+F / Cmd+F / Esc. `ConversationSearch` 규약(§1) 공유.                                |

### 6.2 스크린리더 라벨

- 리스트 루트: `<div role="list" aria-label="세션 이력 · {count}건">`.
- 버킷 헤더: `<h2 role="presentation">` (라이트 랜드마크 남용 방지).
- 카드: `<article role="listitem" aria-labelledby="sess-{id}-title" aria-describedby="sess-{id}-summary">`.
- 미니 바: `<span role="img" aria-label="입력 76천, 출력 32천, 캐시 적중 48천, 총 500천 중 156천 사용">`.
- 압축 배지: `<span aria-label="자동 압축 3회">✦ 3회</span>`.
- 이어서 작업 버튼: `<button aria-label="이어서 작업 · {projectName} 세션 {startClock}">`.
- 필터 변경 `aria-live="polite"` 영역: "세션 {count}건 찾음 · {activeFiltersSummary}".

### 6.3 대비 · 색 단독 신호 금지

- 진행 중/강제 종료/오프라인 배지는 **색 + 아이콘 + 텍스트** 3중 신호(O-14 원칙 계승).
- 3색 미니 바의 각 구간은 aria-label 로 숫자 중복 표기 — 색맹 사용자가 동일 정보 획득.
- 검색 강조 `<mark>` 는 배경 + bold 2중.

### 6.4 모션 절감

- 카드 hover 페이드 · pulse 배지 모두 `prefers-reduced-motion` 에서 정적 테두리로 대체.
- 스켈레톤 펄스도 동일.

---

## 7. i18n 키 후보 — `sessionHistory.*`

### 7.1 헤더 · 필터

| 키                                        | 한국어                                                | English                                             |
| ----------------------------------------- | ----------------------------------------------------- | --------------------------------------------------- |
| `sessionHistory.title`                     | 세션 이력                                              | Session history                                     |
| `sessionHistory.subtitle`                  | 5시간 창 단위로 기록된 과거 세션을 확인하세요.            | Review past sessions grouped by 5-hour windows.     |
| `sessionHistory.count`                     | 세션 {count}건                                          | {count} sessions                                     |
| `sessionHistory.exportCsv`                  | CSV 내보내기                                            | Export CSV                                           |
| `sessionHistory.filter.label`                | 필터({active})                                          | Filter ({active})                                    |
| `sessionHistory.filter.clear`                | 초기화                                                  | Clear                                                |
| `sessionHistory.filter.project.label`         | 프로젝트                                                | Project                                              |
| `sessionHistory.filter.project.all`           | 모든 프로젝트                                            | All projects                                         |
| `sessionHistory.filter.range.label`           | 기간                                                    | Range                                                |
| `sessionHistory.filter.range.today`           | 오늘                                                    | Today                                                |
| `sessionHistory.filter.range.yesterday`       | 어제                                                    | Yesterday                                            |
| `sessionHistory.filter.range.last7`           | 최근 7일                                                 | Last 7 days                                          |
| `sessionHistory.filter.range.last30`          | 최근 30일                                                | Last 30 days                                         |
| `sessionHistory.filter.range.all`             | 전체                                                    | All                                                  |
| `sessionHistory.filter.range.custom`          | 사용자 지정                                              | Custom                                               |
| `sessionHistory.filter.role.label`             | 역할                                                    | Role                                                 |
| `sessionHistory.filter.role.all`               | 모든 역할                                                | All roles                                            |
| `sessionHistory.filter.compacted.label`        | 자동 압축 있는 세션만                                      | Only sessions with compaction                         |
| `sessionHistory.search.placeholder`             | 에이전트 이름, 대화, 프로젝트 검색                        | Search agents, conversations, projects                |
| `sessionHistory.search.openShortcut`             | 검색 열기(⌃F / ⌘F)                                       | Open search (⌃F / ⌘F)                                 |
| `sessionHistory.search.resultsFound`             | 세션 {count}건 찾음                                       | Found {count} sessions                                |

### 7.2 카드

| 키                                         | 한국어                                                  | English                                              |
| ------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------- |
| `sessionHistory.card.timeRange`             | {startClock} → {endClock}                                | {startClock} → {endClock}                            |
| `sessionHistory.card.timeRange.nextDay`     | {startClock} → {endClock} (다음날)                        | {startClock} → {endClock} (next day)                 |
| `sessionHistory.card.inProgress`            | 진행 중                                                  | In progress                                          |
| `sessionHistory.card.duration`              | {duration}                                               | {duration}                                           |
| `sessionHistory.card.project`               | 프로젝트: {name}                                          | Project: {name}                                      |
| `sessionHistory.card.participants`          | 참여 {count}명                                           | {count} participants                                 |
| `sessionHistory.card.compactionCount`        | ✦ 자동 압축 {count}회                                    | ✦ {count} compactions                                |
| `sessionHistory.card.compactionNone`         | ✦ 자동 압축 —                                            | ✦ No compactions                                     |
| `sessionHistory.card.lastActivity`           | 📝 {summary}                                              | 📝 {summary}                                          |
| `sessionHistory.card.action.resume`           | ▶ 이어서 작업                                             | ▶ Resume                                             |
| `sessionHistory.card.action.resumeDisabled.deleted`  | 프로젝트가 삭제되어 이어갈 수 없어요                       | Project was deleted — cannot resume                   |
| `sessionHistory.card.action.resumeDisabled.expired`   | 세션 스냅샷이 만료됐어요(30일)                            | Session snapshot expired (30 days)                    |
| `sessionHistory.card.action.detail`           | 👁 상세 보기                                              | 👁 View details                                       |
| `sessionHistory.card.badge.inProgress`         | 🟢 진행 중                                                | 🟢 Live                                              |
| `sessionHistory.card.badge.crashed`            | ⚠ 비정상 종료                                             | ⚠ Crashed                                            |
| `sessionHistory.card.badge.offlineOnly`        | 📡 오프라인 수집                                           | 📡 Offline captured                                   |
| `sessionHistory.card.activitySummary.edited`   | {agent} 가 {n}개 파일 편집                                 | {agent} edited {n} files                              |
| `sessionHistory.card.activitySummary.tested`   | {agent} 가 {n}개 테스트 실행                              | {agent} ran {n} tests                                 |
| `sessionHistory.card.activitySummary.searched` | {agent} 가 {n}회 웹 검색                                   | {agent} ran {n} web searches                          |
| `sessionHistory.card.activitySummary.silent`   | 활동 기록 없음                                             | No recorded activity                                  |

### 7.3 날짜 버킷

| 키                                      | 한국어                                     | English                            |
| --------------------------------------- | ------------------------------------------ | ---------------------------------- |
| `sessionHistory.bucket.today`             | 오늘 ({date})                               | Today ({date})                      |
| `sessionHistory.bucket.yesterday`         | 어제 ({date})                               | Yesterday ({date})                  |
| `sessionHistory.bucket.thisWeek`          | 이번 주 ({rangeLabel})                      | This week ({rangeLabel})            |
| `sessionHistory.bucket.earlier`           | 이전                                         | Earlier                              |
| `sessionHistory.bucket.loadMore`          | 더 보기                                      | Load more                            |

### 7.4 상세 드로어

| 키                                                  | 한국어                                                  | English                                             |
| --------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| `sessionHistory.detail.closeAria`                     | 드로어 닫기                                                | Close drawer                                         |
| `sessionHistory.detail.header`                        | {date} {startClock} → {endClock}                          | {date} {startClock} → {endClock}                     |
| `sessionHistory.detail.summary.title`                   | 대화 요약                                                  | Conversation summary                                  |
| `sessionHistory.detail.summary.messages`                | {count}개 메시지                                           | {count} messages                                      |
| `sessionHistory.detail.summary.participants`             | {count}명 참여                                              | {count} participants                                  |
| `sessionHistory.detail.summary.topic`                    | 주요 주제                                                  | Main topic                                            |
| `sessionHistory.detail.summary.openConversation`          | 💬 대화로 이동                                              | 💬 Open conversation                                  |
| `sessionHistory.detail.summary.summaryFailed`              | 요약을 만들지 못했어요. 기본 통계만 표시합니다.                | Couldn't generate summary — showing stats only.       |
| `sessionHistory.detail.trend.title`                         | 토큰 추세                                                   | Token trend                                           |
| `sessionHistory.detail.trend.totalTokens`                    | 합계 {amount}                                                | Total {amount}                                         |
| `sessionHistory.detail.trend.cacheRatio`                     | 캐시 적중 {pct}%                                              | Cache hit {pct}%                                       |
| `sessionHistory.detail.trend.pointAria`                      | {time} · {amount} · 캐시 {pct}%                                | {time} · {amount} · cache {pct}%                       |
| `sessionHistory.detail.mcp.title`                            | MCP 전송별 호출                                               | MCP transport calls                                   |
| `sessionHistory.detail.mcp.totalLine`                         | (총 {total}회 · 실패 {fail}회)                                 | (Total {total} · {fail} failed)                       |
| `sessionHistory.detail.mcp.stdio`                             | stdio                                                         | stdio                                                 |
| `sessionHistory.detail.mcp.http`                              | http                                                          | http                                                  |
| `sessionHistory.detail.mcp.streamable`                         | streamable-http                                                | streamable-http                                       |
| `sessionHistory.detail.mcp.failHint`                           | {count}회 실패 · 상세 보기                                      | {count} failed · view details                         |
| `sessionHistory.detail.compact.title`                           | 자동 압축 이력                                                  | Automatic compaction                                 |
| `sessionHistory.detail.compact.row`                             | ✦ {time} {agent}  {before}→{after}  −{pct}%                      | ✦ {time} {agent}  {before}→{after}  −{pct}%           |
| `sessionHistory.detail.compact.empty`                            | 이 세션에는 자동 압축이 없었어요.                                  | No compactions in this session.                       |
| `sessionHistory.detail.action.downloadJson`                      | 📥 세션 JSON 다운로드                                             | 📥 Download session JSON                              |
| `sessionHistory.detail.action.resume`                            | ▶ 이어서 작업                                                     | ▶ Resume                                             |

### 7.5 상태 3종

| 키                                               | 한국어                                                                | English                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `sessionHistory.state.loading.title`               | 세션을 불러오는 중…                                                     | Loading sessions…                                                       |
| `sessionHistory.state.empty.firstRun.title`         | 아직 완료된 세션이 없어요                                                | No completed sessions yet                                               |
| `sessionHistory.state.empty.firstRun.body`          | 첫 대화를 마치면 여기에 세션 카드가 쌓여요. 5시간 창마다 자동으로 한 세션이 마감됩니다. | Finish your first conversation and cards will show up here — each 5-hour window closes into one session. |
| `sessionHistory.state.empty.firstRun.action`        | 💬 새 대화 시작하기                                                       | 💬 Start a new conversation                                              |
| `sessionHistory.state.empty.noMatch.title`          | 필터에 맞는 세션이 없어요                                                 | No sessions match your filters                                          |
| `sessionHistory.state.empty.noMatch.body`           | {activeFiltersSummary}                                                  | {activeFiltersSummary}                                                  |
| `sessionHistory.state.empty.noMatch.action`         | 필터 초기화                                                              | Clear filters                                                           |
| `sessionHistory.state.error.title`                   | 세션 이력을 불러오지 못했어요                                             | Could not load session history                                           |
| `sessionHistory.state.error.retry`                   | 다시 시도                                                                 | Retry                                                                   |
| `sessionHistory.state.error.viewCache`                | 오프라인 캐시 보기                                                         | View offline cache                                                      |
| `sessionHistory.state.error.offlineHint`              | 오프라인 상태 · 캐시된 세션만 표시                                         | Offline — showing cached sessions only                                  |

### 7.6 이어서 작업 · 알림

| 키                                            | 한국어                                                         | English                                                     |
| --------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| `sessionHistory.resume.toast.restored`          | 세션을 복원했어요. {projectName} 로 이동합니다.                    | Session restored — switching to {projectName}.              |
| `sessionHistory.resume.toast.offlineFallback`   | 오프라인 · 로컬 스냅샷으로만 복원했어요. 새 응답은 연결 시 갱신돼요. | Restored from local snapshot — live context on reconnect.    |
| `sessionHistory.resume.toast.failed`            | 세션 복원에 실패했어요. 상세 드로어에서 JSON 을 내려받아 주세요.    | Resume failed — please download the session JSON in details.  |

---

## 8. 데이터 · 저장 (구현 힌트)

> 본 시안은 UI 층만 확정하지만, §1·§2·§3 가 공통으로 소비할 **최소 스키마** 를 제안한다.

```ts
// src/utils/sessionHistoryStore.ts (신규 제안 — Joker 구현 참고)
export interface SessionHistoryRecord {
  readonly id: string;                        // windowStartMs 와 projectId 조합 해시
  readonly projectId: string;
  readonly projectName: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;          // null = 진행 중
  readonly windowStartMs: number;             // SubscriptionSessionState 기준
  readonly totals: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheCreationTokens: number;
  };
  readonly participants: ReadonlyArray<{ id: string; name: string; role: AgentRole }>;
  readonly lastActivity: {
    readonly kind: 'edited' | 'tested' | 'searched' | 'silent';
    readonly agent?: string;
    readonly count?: number;
  };
  readonly compactionCount: number;
  readonly compactionEvents: ReadonlyArray<CompactionEvent>;   // error-recovery §3.3 재사용
  readonly mcpCallCounts: Record<'stdio' | 'http' | 'streamable-http', {
    readonly total: number;
    readonly failed: number;
  }>;
  readonly sparkline: ReadonlyArray<{ tMs: number; totalTokens: number; cacheRatio: number }>;
  readonly closureReason: 'normal' | 'crashed' | 'offlineOnly' | 'inProgress';
  readonly summary?: {
    readonly topic: string;
    readonly messageCount: number;
    readonly generatedAtMs: number;
  };
}
```

- 저장: IndexedDB 또는 localStorage(50 세션 이하). 본 시안은 구현 위임.
- 최대 보관 30 일 · 500 세션 (선행 `error-recovery-ux-2026-04-21.md` §3.3 규약 계승).
- 현재 세션(`closureReason: 'inProgress'`) 은 실시간 tick 마다 스토어 갱신.

---

## 9. 컴포넌트 트리 · 파일 배치

```
src/views/session-history/                    (신규 디렉터리)
  SessionHistoryView.tsx                      (§1 페이지 루트)
  SessionListHeader.tsx                       (sticky · §3 필터 · 검색)
  SessionFilterChips.tsx                      (§3.2)
  SessionSearchOverlay.tsx                    (§3.1 — ConversationSearch 재사용 래퍼)
  SessionList.tsx                             (§1.1 버킷 + 카드 그리드)
  SessionCard.tsx                             (§1.2)
  SessionDetailDrawer.tsx                     (§2)
  SessionDetailDrawer/
    ConversationSummaryCard.tsx
    TokenTrendSparklineCard.tsx               (token-savings §2.3 재사용)
    McpTransportCallsCard.tsx
    CompactionHistoryCard.tsx                 (error-recovery §3.3 재사용)

src/utils/
  sessionHistoryStore.ts                       (신규 · §8 스키마 + IndexedDB 어댑터)
  sessionHistoryFilters.ts                     (신규 · 순수 필터링 함수)
  sessionHistoryUrl.ts                         (신규 · URL ↔ 필터 상태 직렬화)

src/App.tsx                                    (기존 · activeTab 유니온에 'session-history' 추가)

locales/
  en.json · ko.json                           (§7 sessionHistory.* 전량 — 평면 구조 계승)
```

- 신규 CSS 토큰 · 애니메이션 · Tailwind 유틸 **0건**.
- 기존 컴포넌트 재사용: `EmptyState` · `ErrorState` · `SessionBreakdownBar`(미니 바) · `ConversationSearch` · `TrendSparkline`.

---

## 10. 결정 대기(Joker · QA · Kai)

| ID    | 질문                                                                        | 대상     |
| ----- | --------------------------------------------------------------------------- | -------- |
| R-H1  | 세션 ID 규약 — `windowStartMs + projectId` 해시 vs UUID v7 — 충돌 위험·디버깅 용이성  | Joker    |
| R-H2  | "이어서 작업" 이 `game` 탭으로 이동할 때 현재 미완 초안이 있으면 병합 vs 확인 다이얼로그        | Kai      |
| R-H3  | 자동 요약 엔진을 `ResearchAdapter` 의 `Summarizer` 로 재사용할지 별도 경량 구현 둘지         | Joker    |
| R-H4  | MCP 호출 실패 툴팁이 `McpDisconnectedBanner` 로그 뷰와 연결될 때 탭 전환 vs 인라인 확장         | Joker    |
| R-H5  | 세션 `closureReason: 'crashed'` 판정 기준 — `SessionRecoveryModal` 에서 "새 세션 시작" 선택 시에만 crashed 인지, 비정상 종료 감지가 다른 경로로도 오는지 | Joker    |
| R-H6  | 검색 대상에 **파일 경로** 를 추가할지(에이전트가 편집한 파일명)                          | Kai      |
| R-H7  | 최대 보관 30일/500 세션 중 30일을 넘는 세션을 "접힘" 상태로라도 유지할지 완전 파기할지       | Kai      |
| R-H8  | 카드 폭 < 640px 모바일에서 3열 레이아웃 → 1열 수직 스택 시 최근 활동 요약을 숨길지 유지할지  | QA       |
| R-H9  | 검색 매치 강조에서 대화 본문의 매치가 300건 넘을 때 인덱스 표기 방식(기존 1/300 패턴 재사용?) | QA       |
| R-H10 | CSV 내보내기 스키마 — 세션 단위 요약(1행/세션) vs 메시지 단위 원시(다행/세션) 둘 중 하나       | Kai      |

---

## 11. 범위 밖 · 후속 제안

- **세션 병합/복원 고급 흐름**: 여러 세션을 골라 하나의 작업으로 합치는 기능은 본 시안 밖. 단순 "이어서 작업" 만.
- **팀 공유**: 조직 계정이 도입되면 "팀 전체 세션" 탭을 본 페이지에 대조 탭으로 확장 가능. 본 시안은 개인 로컬 축만.
- **검색 하이라이트 서버 동기화**: 현재 순수 클라이언트 검색. 500 세션 초과 시 서버측 검색 API 가 필요한데, §3.3 URL 구조가 이미 커서 기반 확장에 열려 있음.

---

끝.
