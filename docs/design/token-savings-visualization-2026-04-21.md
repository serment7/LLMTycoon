---
date: 2026-04-21
owner: Designer (LLMTycoon)
trigger-directive: "지시 #35876c7d — 장시간 이용을 위한 토큰 절약 가시화"
prior-context:
  - src/i18n/index.ts (우선 검토 파일 — translate/persist/폴백 3단 계단 권위)
  - src/components/TokenUsageIndicator.tsx (상단바 세션 잔량 배지 — 본 시안의 1차 앵커)
  - src/components/ClaudeTokenUsage.tsx (누적 토큰·비용 뷰 — 상단바 2차 배지)
  - src/components/TokenUsageSettingsPanel.tsx (설정 패널 — 상세 탭 합류 지점)
  - src/utils/claudeTokenUsageStore.ts (input/output/cacheRead/cacheCreation 4축 스키마)
  - src/utils/claudeTokenUsageThresholds.ts (caution/warning 임계 계약)
  - src/index.css L539–L594 (--token-usage-axis-* 4축 팔레트 · 게이지 토큰)
  - locales/ko.json · locales/en.json (Joker 완료 i18n 리소스 스키마)
  - docs/design/mcp-transport-and-language-toggle-2026-04-20.md (언어 모드 토글 배치 선례 — 본 시안 토스트 계약 계승)
report-to: Joker (dfce6d78-c2c8-4263-b189-6dfe1a3a1f23)
scope:
  - "상주 토큰 인디케이터: 입력/출력/캐시 적중 3색 누적 바 + 세션 한도 비율 + 자동 컨텍스트 압축 토스트 한/영"
  - "설정 화면 '토큰 사용 상세' 패널: 최근 7세션 추세 스파크라인 + 에이전트 상위 3 + 압축 이력 타임라인"
  - "EN/KO 숫자·단위(K/M tokens) 정렬 타이포그래피 가이드(tabular-nums · font-variant · 단위 처리)"
  - "i18n 키 후보 전체 테이블 — Joker 가 locales/{en,ko}.json 에 그대로 이관 가능하도록 완결 제공"
---

# 토큰 절약 가시화 — 인디케이터 + 상세 패널 + 타이포 가이드 (2026-04-21)

공동 목표 첫 축("장시간 이용") 을 **눈으로** 이어가게 하는 세 층위를 확정한다.

1. **상주 인디케이터(상단바)** — 지금 이 순간의 세션 여유를 3초 안에 판독.
2. **설정 → 상세 패널** — 최근 7세션 추세 · 에이전트별 상위 · 압축 이력.
3. **타이포 · i18n** — EN/KO 양쪽에서 숫자·단위 정렬과 폴백이 흐트러지지 않도록 토큰화.

기존 상단바 위젯(`TokenUsageIndicator` · `ClaudeTokenUsage`) 은 "세션 잔량 배지" 와 "누적 사용량 뷰" 로 축이 이미 분리되어 있다(indicator L4–L6 주석). 본 시안은 **둘의 경계를 건드리지 않고** 두 배지 사이에 **3색 누적 바 1줄** 을 얹어 "어디에 토큰을 썼는지" 를 드러낸다. 상세 뷰는 설정 패널의 새 섹션으로 합류한다.

> 우선 검토 파일 `src/i18n/index.ts` 의 3단 폴백(`현재 locale → en → key 원문`, L148–L157) 은 본 시안의 §5 타이포 가이드 · §6 i18n 키 테이블의 하위 계약이다. 미번역 키가 숫자 라벨 자리에 새어 나오면 스파크라인 열 정렬이 깨지므로, §5.4 에서 **key 원문도 tabular-nums 로 고정 렌더** 하는 규칙을 명시한다.

---

## 0. 설계 원칙 (T-01 ~ T-12)

### 0.1 인디케이터(T-01 ~ T-05)

| ID   | 원칙 |
| ---- | ---- |
| T-01 | **3색 누적 바 1줄** : 입력(cyan) / 출력(amber) / 캐시 적중(emerald). 각 색은 기존 `--token-usage-axis-*-fg` 토큰(`src/index.css:568–570`) 을 그대로 쓴다. 추가 색 금지. |
| T-02 | **비율은 두 곳만** : 세션 한도 대비 `% 사용` (왼쪽 라벨) · `남은 X · 리셋까지 Y` (오른쪽 라벨). 가운데 바는 비율 시각만. |
| T-03 | **"절약 중" 상태의 즉시성** : 캐시 적중 비율이 40% 를 넘으면 바 오른쪽 끝에 `💰` 배지. 배지는 텍스트 없이 이모지 1개 + `aria-label="캐시 절약 중"`. 사용자가 "지금 어떤 행동이 절약인지" 를 배지 → 툴팁 → 상세 패널 3단으로 내려간다. |
| T-04 | **상단바 우선 · 사이드바 폴백** : 뷰포트 ≥ 1280px 는 상단바 `TokenUsageIndicator` 옆 1행. < 1280px 는 좌측 사이드바 하단으로 이동(세로 표기로 회전 금지 — 가독성 파괴). 상단바·사이드바 동시 노출 금지(두 군데 보이면 "업데이트 안 되는 하나" 에 대한 혼동 발생). |
| T-05 | **심각도는 팔레트 + 아이콘 + 바 너비 3중 신호** : 색 단독 의존 금지(indicator L41–L46 주석 계승). 3중 신호가 있어야 색맹·저대비 사용자도 같은 정보를 얻는다. |

### 0.2 압축 토스트(T-06 ~ T-08)

| ID   | 원칙 |
| ---- | ---- |
| T-06 | **토스트는 "완료 후 1회" 만** : 컨텍스트 압축이 끝난 직후 1회. 시작 시점 토스트는 `aria-live` 소음만 만든다. 감축량이 확정된 후 "${before} → ${after} 토큰 · ${pct}% 절감" 한 줄. |
| T-07 | **수치는 반올림 대문자 단위** : `"150K → 42K 토큰 · 72% 절감"`. 소수점 금지(§5.2 규칙). 감축 0% 는 토스트 자체를 생략. |
| T-08 | **클릭 시 상세 패널 열기** : 토스트 본문 · 버튼 모두 클릭 영역. 클릭하면 `SettingsDrawer` 의 "토큰 사용 상세" 탭을 열고 압축 이력의 해당 항목으로 자동 스크롤. |

### 0.3 상세 패널(T-09 ~ T-10)

| ID   | 원칙 |
| ---- | ---- |
| T-09 | **한 화면 · 3카드 수직 배치** : 7세션 추세 스파크라인 · 에이전트별 상위 3 · 압축 이력. 좌우 분할 레이아웃은 노트북 13" 에서 가독성이 급격히 떨어진다. |
| T-10 | **스파크라인에는 툴팁만 · 축 눈금 없음** : 7점은 "추세" 신호이지 분석 도구가 아니다. 개별 점 hover 툴팁 + 현재 세션 하이라이트 점만. Y축 · X축 눈금 금지. |

### 0.4 타이포 · i18n(T-11 ~ T-12)

| ID   | 원칙 |
| ---- | ---- |
| T-11 | **숫자·단위는 tabular-nums + 단위 분리 span** : `12.3K` 는 `<span class="num">12.3</span><span class="unit">K</span>` 로 분리. EN/KO 공통. 폭 차이는 단위 span 의 `min-width` 로 흡수한다(§5.1). |
| T-12 | **i18n 키 후보는 본 시안이 완결 공급** : Joker 가 `locales/{en,ko}.json` 에 그대로 붙일 수 있도록 §6 이 **한 줄도 남김 없이** 최종 문자열을 제공한다. 번역 외주가 JSON 만 수정하는 관행(`src/i18n/index.ts:14–15` 주석) 을 유지. |

---

## 1. 상주 토큰 인디케이터 — 레이아웃

### 1.1 뷰포트 ≥ 1280px · 상단바 슬롯

```
┌ TopBar ─────────────────────────────────────────────────────────────────────────────────────┐
│ [로고]  [프로젝트 ▾]   ...   [🔋 세션 2.4K 남음 · 14:22 리셋]  │←existing Indicator           │
│                                                                                             │
│                                    [▮▮▮▮▮▮▮▮▮▮▮▮▮▮  156K/500K (31%)  💰 ]  ←본 시안 NEW    │
│                                      입 76K · 출 32K · 캐시적중 48K                           │
│                                                                                             │
│                                              [⚙ 설정]  [🌐 한국어 ▾]  [사용자]                │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

- 폭: 240px 고정. 단일 행에 두 줄(바 + 미니 범례).
- 위치: 기존 `TokenUsageIndicator` (세션 잔량) 와 `ClaudeTokenUsage` (누적 비용) 사이. 의미 경계: "지금 세션 잔량" → "어디에 썼나(본 시안)" → "장기 누적 비용".
- 마우스 호버 시 툴팁으로 세부 전개(§1.4).

### 1.2 뷰포트 < 1280px · 좌측 사이드바 하단

```
┌ Sidebar ─────────┐
│ [대화]            │
│ [파일]            │
│ [에이전트]         │
│ ─────────────── │
│ [🔋 2.4K 남음]    │
│                  │
│ 토큰 사용         │
│ ▮▮▮▮▮▮▮▮▮▮▮▮▮▮  │ ← 3색 수평 바 · 폭 100%
│ 156K/500K  31%   │
│ 입 76K · 출 32K  │
│ 캐시적중 48K 💰   │
│                  │
│ [상세 열기 →]     │
└──────────────────┘
```

- 세로 180px 카드. `[상세 열기]` 는 설정 드로어 열기 + "토큰 사용 상세" 섹션으로 스크롤.
- 사이드바 접힘 상태(아이콘만) 에서는 `🔋` 와 바만 남고 숫자는 호버 툴팁으로.

### 1.3 3색 바 ASCII 디테일

```
 bar container : width 240px · height 8px · radius var(--radius-sm) · bg var(--token-usage-gauge-track)

 [▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ ]
  ↑ 입력(cyan)                                            ↑ 캐시적중(emerald)
         ↑ 출력(amber) — 출력은 입력 오른쪽에 붙여 "입/출 인과" 시각화
```

- 세 구간의 합이 바 전체 폭 × (사용 비율). 남는 끝은 트랙 회색 그대로.
- 구간 순서는 `input → output → cacheRead` 고정. 이유: 입/출은 "요청→응답" 의 인과 시간순, 캐시 적중은 "이전 입력에서 재활용된 몫" 이라 끝에 붙이면 "절약으로 줄인 분량" 이 직관적으로 읽힌다.
- `cacheCreation`(캐시 쓰기) 은 바에 표시하지 않는다 — "투자" 성격이라 단기 판독을 흐린다. 상세 패널에서만 노출(§2.3).
- 각 구간 `aria-label` : `"입력 76천 토큰, 15퍼센트"` · `"출력 32천 토큰, 6퍼센트"` · `"캐시 적중 48천 토큰, 10퍼센트"`.

### 1.4 호버 툴팁 — 4축 스택

```
┌ 토큰 사용 상세(호버) ──────────────────────────┐
│ 이번 세션                                      │
│ ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── │
│ 입력        76,240  (15%)  ▮                   │
│ 출력        32,110  ( 6%)  ▮                   │
│ 캐시 적중   48,900  (10%)  ▮   ← 절감 효과     │
│ 캐시 생성    3,200  ( -)   ▮   ← 미래 투자     │
│ ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── │
│ 합계       160,450 / 500,000  (32%)            │
│ 남은 토큰  339,550   · 14:22 리셋               │
│                                                │
│ 💰 캐시 적중 비율 30.5% — 토큰을 아끼고 있어요. │
│ [상세 패널 열기 →]                              │
└────────────────────────────────────────────────┘
```

- 폭 320px (`--token-usage-tooltip-width` 재사용).
- 4축 순서는 **바와 같은 색·순서** (입→출→캐시적중→캐시생성). 인지 부담 최소.
- `💰` 행은 캐시 적중 비율 ≥ 40% 일 때만. < 40% 는 동일 위치에 비활성 회색 문구 `"캐시 적중이 적어 추가 절약 여지가 있어요."` — 사용자가 다음 행동을 잡도록.
- 키보드: 배지에 포커스 후 Space/Enter 로 툴팁 열림, Esc 로 닫힘.

### 1.5 상태별 심각도 매핑

| 세션 한도 대비 사용률 | severity   | 바 색 팔레트                                             | 아이콘          | 추가 신호             |
| --------------------- | ---------- | -------------------------------------------------------- | --------------- | --------------------- |
| 0% ≤ x < 50%           | ok          | 4축 색 그대로 (cyan·amber·emerald·sky)                    | 🔋 Full         | —                     |
| 50% ≤ x < 80%          | caution     | 4축 색 + 외곽 테두리 `--token-usage-caution-border`       | 🔋 Medium       | 바 상단 2px caution 스트립 |
| x ≥ 80%                | critical    | 4축 색 + 외곽 `--token-usage-warning-border` + pulse glow | 🔋 Warning      | `aria-live="polite"` 로 "토큰 한도 80% 초과" 1회 알림 |

- 사용률은 `(input + output + cacheRead) / limit`. `cacheCreation` 은 분자에 넣지 않는다 — 바 · 합계 · 심각도 모두 같은 규칙을 공유해 사용자가 "왜 숫자가 다른가" 를 추측하지 않도록.

---

## 2. 설정 → "토큰 사용 상세" 패널

### 2.1 위치 · 정보 구조

```
┌ SettingsDrawer ─────────────────────────────────────────┐
│ 🌐 언어              (§mcp-transport-and-language-toggle)│
│ 🎨 테마                                                   │
│ 🔔 토큰 경고 임계 · 📊 토큰 사용 상세      ← 탭 2개 승격    │
│ ⌨ 단축키                                                  │
│ 🎛 모션 절감                                              │
└─────────────────────────────────────────────────────────┘
```

- 기존 `TokenUsageSettingsPanel` 의 "임계값 입력" 축은 **한 탭** 으로, 본 시안이 신설하는 "토큰 사용 상세" 는 **인접 탭** 으로. 두 탭은 좌우 토글 (→/←).
- 두 탭 모두 `role="tab"` · `aria-selected`. 기존 임계값 폼 레이아웃은 변경하지 않는다.

### 2.2 "토큰 사용 상세" 탭 — 3카드 수직 배치

```
┌ 토큰 사용 상세 ──────────────────────────────────────────┐
│                                                           │
│  ╔═ 카드 1 · 최근 7세션 추세 ══════════════════════════╗   │
│  ║ 합계 토큰 / 세션       (단위: K)                     ║   │
│  ║  200K ┤                                 ●            ║   │ ← 현재 세션(진한 점)
│  ║  150K ┤             ╱─────╲      ╱─────              ║   │
│  ║  100K ┤   ●────────●       ●────●                    ║   │
│  ║   50K ┤                                              ║   │
│  ║    0K ┴─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─            ║   │ ← X/Y 눈금 선 없음(T-10)
│  ║       4/15  4/16  4/17  4/18  4/19  4/20  오늘       ║   │
│  ║                                                      ║   │
│  ║ 💡 오늘은 평균 대비 +18% — 캐시 적중이 적습니다.      ║   │
│  ╚══════════════════════════════════════════════════════╝   │
│                                                           │
│  ╔═ 카드 2 · 에이전트별 사용량 상위 3 ══════════════════╗   │
│  ║                                                      ║   │
│  ║  1.  Joker       82K  ▮▮▮▮▮▮▮▮▮▮▮▮▮ (52%)          ║   │
│  ║  2.  Thanos      46K  ▮▮▮▮▮▮▮        (29%)          ║   │
│  ║  3.  QA          18K  ▮▮▮            (11%)          ║   │
│  ║  — 기타 2명 ──   12K   ▮              ( 8%)          ║   │ ← 아코디언 접기
│  ║                                                      ║   │
│  ║ [탭 3초 · 세션 전체 보기 →]                           ║   │
│  ╚══════════════════════════════════════════════════════╝   │
│                                                           │
│  ╔═ 카드 3 · 자동 컨텍스트 압축 이력 ══════════════════╗   │
│  ║ 오늘                                                 ║   │
│  ║  ✦ 14:02  Joker    248K → 72K   −71%  "긴 요청 정리" ║   │
│  ║  ✦ 11:47  Thanos   180K → 61K   −66%  "템플릿 반복" ║   │
│  ║  ─────────────────────────────────────────────      ║   │
│  ║ 어제                                                 ║   │
│  ║  ✦ 22:15  QA         98K → 40K   −59%                ║   │
│  ║                                                      ║   │
│  ║ [더 보기(전체 30일) →]                                ║   │
│  ╚══════════════════════════════════════════════════════╝   │
│                                                           │
│  [CSV 내보내기]  [JSON 내보내기]                           │
└───────────────────────────────────────────────────────────┘
```

### 2.3 카드별 상세 · 인터랙션

#### 카드 1 — 7세션 추세 스파크라인

- 데이터: 최근 7 세션의 `input + output + cacheRead` 합. 오늘 미완 세션은 현재까지 누계로 1 점.
- 렌더: `<svg viewBox="0 0 280 80">` 에 polyline 1개. 점은 `<circle r="3">` 7개.
- 색: 전체 라인 `--token-usage-axis-input-fg`(cyan), 현재 세션 점만 `--token-usage-axis-output-fg`(amber) + 반경 4.5.
- 하이라이트 툴팁: 점 hover 시 "4/19 · 132K · 캐시 28%" 한 줄. `role="tooltip"`.
- 요약 문구: 평균 대비 편차에 따라 4 분기(§6.3 i18n 테이블 t-summary-*).
- 빈 상태(7 세션 이하): `"데이터가 쌓이면 추세가 보여요."` + 회색 점선 placeholder.

#### 카드 2 — 에이전트별 상위 3

- 데이터 원천: 세션 내 각 에이전트 발신 요청의 `input + output` 합. `cacheRead` 는 공유 자원이라 에이전트 분할이 모호 → 본 카드에서는 포함시키지 않는다(툴팁에 각주).
- 행 레이아웃: `[순위]  [이름 cut 12자]  [토큰 숫자]  [수평바 100px]  [% 소수점 0]`.
- 4위 이하는 "기타 N명" 1행으로 묶고 클릭 시 확장.
- 이름이 UI 폭을 넘으면 truncate + `title`.

#### 카드 3 — 압축 이력 타임라인

- 그룹 : "오늘 · 어제 · 이번 주 · 이전" 4 버킷. 비어 있는 버킷은 라벨 자체 생략.
- 한 행: `✦ 시각 · 에이전트 · before → after · 절감% · 이유(있으면)`.
- 이유 문자열은 에이전트가 보낸 `reason` 필드 그대로(번역 없음 — 사용자 콘텐츠).
- `[더 보기]` 클릭 시 30일 보기 모달(별도 화면 · 본 시안 범위 외).
- 스토어 통합: 기존 `claudeTokenUsageStore` 에 `compactionEvents` 축 신설을 전제(스키마는 §3.3).

### 2.4 내보내기 · 비우기

- `[CSV 내보내기]` · `[JSON 내보내기]` 는 **기존** `buildExportRows` / `toCsv` / `toJson`(`src/utils/claudeTokenUsageExport.ts`) 경로 재사용. 범위 선택은 드롭다운으로 "이번 세션 / 오늘 / 7일 / 30일".
- `[오늘 사용량 초기화]` 는 **탭 1(임계값)** 에 이미 있음 — 상세 탭에서는 중복 노출 금지.

---

## 3. 자동 컨텍스트 압축 — 이벤트 · 토스트 · 상세

### 3.1 트리거 시점

- 백엔드 에이전트 워커가 컨텍스트 압축을 "완료" 한 직후 1회 이벤트 발송. 시작 · 중단은 토스트 불필요(내부 작업).

### 3.2 토스트 · 카피

| 키                                      | 한국어                                                     | English                                                          |
| --------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `tokenUsage.toast.compacted.title`       | 컨텍스트 압축 완료                                            | Context compressed                                                |
| `tokenUsage.toast.compacted.body`        | {before} → {after} 토큰 · {pct}% 절감 ({agent})                | {before} → {after} tokens · saved {pct}% ({agent})                 |
| `tokenUsage.toast.compacted.cta`         | 상세 보기                                                     | View details                                                       |
| `tokenUsage.toast.compacted.noGain`      | 압축 시도했지만 감축 효과가 거의 없었어요. 원본을 유지합니다.      | Compaction attempted but yielded negligible gain; keeping original. |
| `tokenUsage.toast.compacted.failed`      | 컨텍스트 압축에 실패했어요. 그대로 진행합니다.                 | Context compaction failed — continuing with the full context.     |

- 기본 지속: `tokenUsage.toast.compacted.body` 는 5초, `noGain`·`failed` 는 4초.
- `role="status"` + `aria-live="polite"`. assertive 금지 — 사용자 작업 흐름을 끊지 않는다.
- 단일 세션 내 **최대 3회/분** 만 토스트. 그 이상은 상세 패널 배지(§2.3 카드 3) 카운트만 증가.

### 3.3 스토어 스키마 제안(Joker 참고)

본 시안은 UI 층만 다루지만, 카드 3 · 토스트 · 스파크라인이 공유할 최소 스키마를 제안한다:

```ts
// src/utils/claudeTokenUsageStore.ts 확장 제안
export interface CompactionEvent {
  readonly occurredAtMs: number;
  readonly agentName: string | null;   // null 이면 "시스템"
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly reason?: string;            // 사용자 콘텐츠 — 번역 대상 아님
  readonly outcome: 'saved' | 'noGain' | 'failed';
}
```

- 30일 이후 자동 파기. 최대 500건까지 링 버퍼.
- 기존 `claudeTokenUsageStore.all` 축은 건드리지 않는다 — 새 축을 `compactionHistory` 로 병렬 추가.

---

## 4. 접근성 · 키보드

### 4.1 상주 인디케이터

| 항목                         | 동작                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| 배지 전체                     | `role="status"` · `aria-live="polite"` · `aria-label` 은 §1.3 형식 한/영 번역 적용    |
| Tab                           | 기존 `TokenUsageIndicator` → 본 바 → `ClaudeTokenUsage` 순                          |
| Enter/Space                   | 툴팁 열림 · 재입력 시 닫힘                                                             |
| Esc                           | 열린 툴팁 닫고 배지로 포커스 복귀                                                       |
| 색맹 대응                      | 팔레트 + 아이콘 + 바 두께 3중 신호(T-05), 툴팁은 텍스트 우선으로 4축 숫자 전달          |
| 저대비 모드(`prefers-contrast`) | 외곽 테두리 `var(--pixel-border)` 고정 2px · 캐시적중 배지는 밑줄 병기                  |

### 4.2 상세 패널

| 항목                         | 동작                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| 탭 전환                       | `role="tablist"` · ←/→ 순환 · `aria-selected`                                         |
| 스파크라인 포커스               | `role="img"` + `aria-label` 에 7점 숫자 텍스트 요약(스크린리더가 그림을 건너뛰지 않도록) |
| 점 포커스 지원                  | 키보드 사용자용 "이전 점 / 다음 점" 단축 `[` · `]` — 점이 작아 마우스 이외 수단 제공    |
| 카드 2 행                      | `role="listitem"` · 순위/이름/토큰/% 순서로 음성 합성 자연스럽게                        |
| 카드 3 타임라인                 | `role="log"` · 최신 상단                                                              |
| 내보내기 버튼                  | `aria-busy` 는 다운로드 준비 중에만                                                    |

---

## 5. 타이포그래피 — EN/KO 숫자·단위 정렬

### 5.1 핵심 규칙

숫자 · 단위(K/M) · 퍼센트가 표·바·리스트에서 **세로 정렬이 깨지지 않도록** 세 축을 고정한다.

| 축                    | 값                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------- |
| `font-variant-numeric` | `tabular-nums lining-nums` — 모든 숫자 자리폭 동일                                      |
| `font-family` (숫자 축)  | 기존 `font-mono`(`JetBrains Mono` 계열) 재사용. EN/KO 무관 동일 폰트                      |
| 단위 span 최소 폭      | `1ch` (영문 기준 "K"·"M" 1자 폭). 한글 UI 에서 단위가 "토큰" 으로 번역돼도 span 자체는 1ch 유지 |

### 5.2 숫자 포맷 규칙

| 범위                  | 포맷               | 예              |
| --------------------- | ------------------ | --------------- |
| 0 ≤ n < 1,000          | 정수 그대로         | `912`           |
| 1,000 ≤ n < 10,000      | `x.xK`(소수 1자리)  | `1.2K`, `9.8K`  |
| 10,000 ≤ n < 1,000,000  | `xxK`(정수)         | `76K`, `500K`   |
| ≥ 1,000,000             | `x.xM`(소수 1자리)  | `1.2M`          |

- 반올림은 `Math.round`. `toFixed` 의 문자열 고정 소수점 버그 방지 위해 `Intl.NumberFormat(locale, { maximumFractionDigits: 1 })` 사용.
- 퍼센트: 정수. `71%` · `6%`. "0%" 는 표기하되 "< 1%" 인 비영(非零) 값은 `"< 1%"` 로 별도 렌더해 "실제 사용 중" 임을 잃지 않는다.

### 5.3 단위 span 마크업 (T-11)

```tsx
// <TokenAmount value={76240} />
<span className="tok-num">
  <span className="tok-num__value">76</span>
  <span className="tok-num__unit">K</span>
</span>
```

```css
.tok-num { font-variant-numeric: tabular-nums lining-nums; font-family: var(--font-mono); }
.tok-num__value { display: inline-block; text-align: right; min-width: 3ch; }
.tok-num__unit  { display: inline-block; text-align: left;  min-width: 1ch; margin-left: 1px; opacity: 0.72; }
```

- `min-width: 3ch` : `999` / `9.8K` / `76K` 최대 3자리까지 같은 폭.
- EN/KO 어디서도 숫자는 동일 위치에 고정. 한글 UI 에서도 "토큰" 은 단위 span 밖의 별도 라벨로 분리해 이 규칙이 깨지지 않는다.

### 5.4 한글 UI 의 줄 간격 · 라벨 처리

| 항목               | 규칙                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| 행 높이             | 영문 기준 `1.25` 배, 한글은 `1.35` 배(`line-height`) — 자음/모음 수직 여유 확보     |
| 라벨/숫자 구분       | 라벨은 `var(--font-sans)`, 숫자는 `var(--font-mono)`. 두 축 사이 간격 `var(--space-xs)` |
| 단위 문자열          | 영문 `K`·`M` 고정. 한국어에서도 번역하지 않는다(국제 관례 · 폭 정렬 우선). `tokens` 는 번역(`토큰`). |
| 미번역 키 폴백 렌더  | `translate()` 가 key 원문을 반환해도 `.tok-num` 자식으로 넣으면 `tabular-nums` 가 유지되므로 레이아웃이 깨지지 않는다. 개발 빌드 `[MISSING]` 배지도 라벨 영역에만 부착(숫자 span 오염 금지). |

### 5.5 토큰 · 변수 가이드(신규 CSS 변수 제안)

- 신규: **없음**. 기존 `--font-mono`(index.css) · `--space-xs`(`tokens.css`) · `--token-usage-axis-*-fg` 그대로.
- 유틸 클래스만 신설(`.tok-num`, `.tok-num__value`, `.tok-num__unit`). `src/index.css` 말미에 5줄 추가 권장.

---

## 6. i18n 키 테이블 — Joker 이관용

> 본 섹션은 `locales/{en,ko}.json` 에 **그대로 붙여 넣기 가능** 하도록 전체 키-값을 제공한다. `{placeholder}` 는 런타임 치환 대상 — JSON 저장 시 그대로 유지. 네임스페이스 `tokenUsage.*` 로 통일해 기존 `multimedia.*` · `project.*` 와 동일한 구조.

### 6.1 인디케이터 (§1)

| 키                                        | 한국어                                                       | English                                              |
| ----------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| `tokenUsage.indicator.barAria`             | 토큰 사용 바                                                   | Token usage bar                                       |
| `tokenUsage.indicator.segment.input`       | 입력 {amount} 토큰, {pct}%                                    | Input {amount} tokens, {pct}%                         |
| `tokenUsage.indicator.segment.output`      | 출력 {amount} 토큰, {pct}%                                    | Output {amount} tokens, {pct}%                        |
| `tokenUsage.indicator.segment.cacheRead`   | 캐시 적중 {amount} 토큰, {pct}%                                | Cache hit {amount} tokens, {pct}%                     |
| `tokenUsage.indicator.remaining`           | {amount} 남음 · {clock} 리셋                                   | {amount} left · resets at {clock}                     |
| `tokenUsage.indicator.usedOfLimit`         | {used}/{limit} ({pct}%)                                       | {used}/{limit} ({pct}%)                               |
| `tokenUsage.indicator.savingBadge`         | 💰 캐시 절약 중                                                 | 💰 Saving with cache                                   |
| `tokenUsage.indicator.savingAriaLabel`     | 캐시 적중으로 토큰 절약 중                                       | Currently saving tokens via cache hits                |
| `tokenUsage.indicator.openDetail`           | 상세 보기                                                       | View details                                           |

### 6.2 호버 툴팁 (§1.4)

| 키                                           | 한국어                                                    | English                                            |
| -------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------- |
| `tokenUsage.tooltip.title`                    | 이번 세션                                                   | This session                                        |
| `tokenUsage.tooltip.row.input`                | 입력                                                        | Input                                               |
| `tokenUsage.tooltip.row.output`               | 출력                                                        | Output                                              |
| `tokenUsage.tooltip.row.cacheRead`             | 캐시 적중                                                   | Cache hit                                           |
| `tokenUsage.tooltip.row.cacheCreation`         | 캐시 생성                                                   | Cache write                                         |
| `tokenUsage.tooltip.row.cacheReadHint`         | 절감 효과                                                   | Savings                                             |
| `tokenUsage.tooltip.row.cacheCreationHint`     | 미래 투자                                                   | Future investment                                   |
| `tokenUsage.tooltip.total`                    | 합계                                                        | Total                                               |
| `tokenUsage.tooltip.remaining`                | 남은 토큰                                                   | Remaining                                           |
| `tokenUsage.tooltip.resetAt`                  | {clock} 리셋                                                | Resets at {clock}                                   |
| `tokenUsage.tooltip.cacheRatioGood`            | 캐시 적중 비율 {pct}% — 토큰을 아끼고 있어요.                  | Cache hit rate {pct}% — you're saving tokens.        |
| `tokenUsage.tooltip.cacheRatioPoor`            | 캐시 적중이 적어 추가 절약 여지가 있어요.                      | Low cache hits — there's room to save more.          |

### 6.3 스파크라인 · 요약 (§2.3 카드 1)

| 키                                             | 한국어                                                        | English                                                  |
| ---------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| `tokenUsage.detail.trend.title`                 | 최근 7세션 추세                                                  | Last 7 sessions                                            |
| `tokenUsage.detail.trend.aria`                  | 최근 7세션 토큰 추세 그래프                                      | Token usage trend over the last 7 sessions                  |
| `tokenUsage.detail.trend.empty`                 | 데이터가 쌓이면 추세가 보여요.                                    | The trend appears once more sessions are recorded.          |
| `tokenUsage.detail.trend.todayLabel`            | 오늘                                                           | Today                                                     |
| `tokenUsage.detail.trend.point.tooltip`         | {date} · {amount} · 캐시 {pct}%                                 | {date} · {amount} · cache {pct}%                            |
| `tokenUsage.detail.trend.summary.above`          | 오늘은 평균 대비 +{pct}% — 캐시 적중이 적습니다.                    | Today is +{pct}% above average — low cache hits.             |
| `tokenUsage.detail.trend.summary.near`           | 오늘은 평균과 비슷합니다.                                         | Today is close to the average.                             |
| `tokenUsage.detail.trend.summary.below`          | 오늘은 평균 대비 −{pct}% — 절약 흐름입니다.                         | Today is −{pct}% below average — saving well.               |
| `tokenUsage.detail.trend.summary.insufficient`   | 추세 판독에는 3세션 이상이 필요합니다.                             | Need at least 3 sessions for a trend.                       |

### 6.4 에이전트 상위 3 (§2.3 카드 2)

| 키                                           | 한국어                                                    | English                                          |
| -------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| `tokenUsage.detail.top.title`                  | 에이전트별 사용량 상위 3                                     | Top 3 agents by usage                              |
| `tokenUsage.detail.top.empty`                  | 이번 세션에는 에이전트 활동이 없어요.                         | No agent activity in this session yet.             |
| `tokenUsage.detail.top.row`                    | {rank}. {agent}  {amount}  ({pct}%)                         | {rank}. {agent}  {amount}  ({pct}%)                 |
| `tokenUsage.detail.top.othersGroup`            | 기타 {n}명                                                  | {n} others                                         |
| `tokenUsage.detail.top.expandOthers`           | 기타 펼치기                                                  | Show others                                        |
| `tokenUsage.detail.top.collapseOthers`         | 기타 접기                                                    | Hide others                                        |
| `tokenUsage.detail.top.footnoteCache`           | * 캐시 적중은 공유 자원이라 에이전트별 분할에 포함하지 않습니다. | * Cache hits are shared and excluded from per-agent totals. |

### 6.5 압축 이력 (§2.3 카드 3)

| 키                                                 | 한국어                                                      | English                                                  |
| -------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| `tokenUsage.detail.compact.title`                    | 자동 컨텍스트 압축 이력                                        | Automatic context compaction history                       |
| `tokenUsage.detail.compact.empty`                    | 아직 기록된 압축이 없어요.                                     | No compaction events recorded yet.                         |
| `tokenUsage.detail.compact.bucket.today`              | 오늘                                                         | Today                                                     |
| `tokenUsage.detail.compact.bucket.yesterday`          | 어제                                                         | Yesterday                                                  |
| `tokenUsage.detail.compact.bucket.thisWeek`           | 이번 주                                                       | This week                                                  |
| `tokenUsage.detail.compact.bucket.earlier`            | 이전                                                         | Earlier                                                   |
| `tokenUsage.detail.compact.row`                       | ✦ {time} · {agent} · {before}→{after} · {pct}% 절감            | ✦ {time} · {agent} · {before}→{after} · saved {pct}%        |
| `tokenUsage.detail.compact.reasonPrefix`              | 사유: {reason}                                                 | Reason: {reason}                                           |
| `tokenUsage.detail.compact.outcome.saved`             | 절감                                                          | Saved                                                      |
| `tokenUsage.detail.compact.outcome.noGain`            | 효과 없음                                                     | No gain                                                    |
| `tokenUsage.detail.compact.outcome.failed`            | 실패                                                          | Failed                                                     |
| `tokenUsage.detail.compact.moreButton`                 | 더 보기 (전체 30일)                                              | View all (last 30 days)                                     |

### 6.6 토스트 (§3.2)

(§3.2 테이블 그대로 — JSON 이관용)

```json
"tokenUsage": {
  "toast": {
    "compacted": {
      "title":    { "ko": "컨텍스트 압축 완료",                             "en": "Context compressed" },
      "body":     { "ko": "{before} → {after} 토큰 · {pct}% 절감 ({agent})",  "en": "{before} → {after} tokens · saved {pct}% ({agent})" },
      "cta":      { "ko": "상세 보기",                                    "en": "View details" },
      "noGain":   { "ko": "압축 시도했지만 감축 효과가 거의 없었어요. 원본을 유지합니다.", "en": "Compaction attempted but yielded negligible gain; keeping original." },
      "failed":   { "ko": "컨텍스트 압축에 실패했어요. 그대로 진행합니다.",    "en": "Context compaction failed — continuing with the full context." }
    }
  }
}
```

> 실제 JSON 배치 시에는 기존 `ko.json` · `en.json` 의 한쪽씩 분리 구조(위 파일들 형식) 에 맞춰 평면화한다. 본 블록은 "한 번에 보이는 뷰" 용.

### 6.7 내보내기 · 범위 선택

| 키                                          | 한국어                   | English                |
| ------------------------------------------- | ------------------------ | ---------------------- |
| `tokenUsage.detail.export.csv`                | CSV 내보내기               | Export CSV              |
| `tokenUsage.detail.export.json`               | JSON 내보내기              | Export JSON             |
| `tokenUsage.detail.range.session`              | 이번 세션                  | This session            |
| `tokenUsage.detail.range.today`                | 오늘                       | Today                   |
| `tokenUsage.detail.range.last7`                | 최근 7일                    | Last 7 days             |
| `tokenUsage.detail.range.last30`               | 최근 30일                   | Last 30 days            |

### 6.8 심각도 안내

| 키                                         | 한국어                                                        | English                                                   |
| ------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------- |
| `tokenUsage.severity.ok`                    | 여유 있음                                                       | OK                                                         |
| `tokenUsage.severity.caution`                | 절반 이상 사용                                                  | Over half used                                             |
| `tokenUsage.severity.critical`               | 한도 근접                                                       | Near limit                                                 |
| `tokenUsage.severity.criticalAnnounce`       | 토큰 한도 80% 초과 — 압축·캐시 활용을 늘려 주세요.                | Over 80% of token limit — lean on cache and compaction.     |

---

## 7. 컴포넌트 트리(구현 지침, 참고)

```
TopBarUsageSlot                            (신규 · 기존 상단바에 삽입)
├─ TokenUsageIndicator                     (기존 · 세션 잔량, 불변)
├─ SessionBreakdownBar                     (신규 · 본 시안의 3색 바 + 툴팁)
│  ├─ BarSegment(input·output·cacheRead)   (신규)
│  ├─ SavingBadge (💰)                      (신규)
│  └─ BreakdownTooltip                      (기존 tooltip 토큰 재사용)
└─ ClaudeTokenUsage                         (기존 · 누적 비용, 불변)

SidebarUsageCard                            (신규 · <1280px 폴백)
└─ SessionBreakdownBar                      (재사용)

SettingsDrawer                              (기존 · 확장)
└─ TokenUsageTabs                           (신규)
   ├─ TokenUsageSettingsPanel               (기존 탭 1 · 임계값)
   └─ TokenUsageDetailPanel                 (신규 탭 2 · 본 시안)
      ├─ TrendSparkline                    (7점 polyline)
      ├─ AgentTopList                       (상위 3 + 기타 접기)
      └─ CompactionHistoryTimeline          (버킷 그룹)

TokenAmount                                 (신규 · 공통 숫자 · §5.3)
```

- 모든 색·간격·라운드·모션은 **기존 토큰 재사용**. 신규 유틸 클래스 3 개(`.tok-num*`) 외 CSS 변수 신설 없음.

---

## 8. 결정 대기(Joker · QA)

| ID    | 질문                                                                     | 대상     |
| ----- | ------------------------------------------------------------------------ | -------- |
| R-T1  | 3색 바 위치: 상단바 1행 추가 vs 기존 인디케이터 "아래 줄"로 확장 — 공간 영향  | Joker    |
| R-T2  | `💰` 임계(현재 40%) 를 QA 사용 로그로 조정 필요 여부                          | QA       |
| R-T3  | `compactionEvents` 링 버퍼 500건 · 30일 파기 정책 적정성                       | Joker    |
| R-T4  | 스파크라인이 빈 상태(3세션 미만) 에서 placeholder 톤 — 점선 vs 완전 비움          | QA       |
| R-T5  | 에이전트별 "기타 N명" 임계(현재 상위 3 초과) — 5명 이상으로 완화?              | Joker    |
| R-T6  | 한/영 폭 정렬이 실제 사용 폰트(JetBrains Mono) 에서 3ch min-width 로 충분한지  | QA 실측   |
| R-T7  | 토스트 최대 3회/분 제한(§3.2) 이 과도한지 — 중요한 압축까지 억제될 가능성       | Joker    |

---

## 9. 파일 배치(참고)

```
src/components/
  SessionBreakdownBar.tsx                  (신규 · §1.3 바 + 툴팁)
  SidebarUsageCard.tsx                     (신규 · §1.2 폴백)
  TokenUsageTabs.tsx                       (신규 · §2.1 탭 승격)
  TokenUsageDetailPanel.tsx                (신규 · §2.2 3카드)
  TrendSparkline.tsx                       (신규 · §2.3 카드 1)
  AgentTopList.tsx                         (신규 · §2.3 카드 2)
  CompactionHistoryTimeline.tsx            (신규 · §2.3 카드 3)
  TokenAmount.tsx                           (신규 · §5.3 공통 숫자)

src/utils/
  claudeTokenUsageStore.ts                  (기존 · §3.3 compactionHistory 축 추가)
  formatTokenAmount.ts                      (신규 · §5.2 포맷 규칙 단일 함수)

src/index.css
  말미에 .tok-num* 5줄 추가 (§5.3)

locales/
  en.json · ko.json                        (§6 키 추가 — 기존 평면화 스타일 유지)
```

---

끝.
