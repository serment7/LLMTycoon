# MediaAsset 결과 프리뷰 카드 UX 시안 (2026-04-19)

관련 선행 문서:
- `tests/media-attachment-panel-mockup.md` (2026-04-19) — 입력 경로(첨부 업로드·드래그앤드롭).
  본 시안은 그 역방향, **결과물 경로**(Thanos 가 생성한 산출물 미리보기) 를 다룬다. 두 문서는
  같은 kind 배지 팔레트(`--media-attach-kind-*`) 와 게이지 토큰을 재사용해 "입력 ↔ 결과" 가
  시각 언어 상 한 시리즈로 묶이도록 한다.
- `tests/accessibility-audit-checklist.md` (2026-04-19) — 본 시안의 버튼·툴팁·복사 피드백은
  A-01 키보드 접근·A-05 `aria-live`·A-08 한국어 낭독 원칙을 그대로 따른다.
- `tests/task-commit-strategy-mockup.md` (2026-04-19) — 복사 버튼·120ms 플래시 UX 규약을
  그대로 재사용(C-04 해시 복사 패턴). 본 시안의 "다운로드 URL 복사" 도 동일 패턴.
- `src/components/EmptyState.tsx` · `src/components/ErrorState.tsx` — 변환 중·변환 실패 두
  상태는 이 공용 컴포넌트를 그대로 재활용한다(신규 시각 컴포넌트 생성 금지).

대상 컴포넌트(신규/확장):
- `src/components/MediaAssetPreviewCard.tsx` (신규) — PDF · PPT · 영상 · 이미지 · 오디오 5 종을
  단일 카드로 표현. 외부 컨텍스트(작업 결과 탭, CollabTimeline 링크 대상, 알림 센터) 에서
  재사용 가능한 pure presentational.
- `src/components/MediaAssetPreviewGrid.tsx` (신규, 선택) — 카드 여러 개를 묶는 flex/grid.
  단건 렌더만 필요한 자리에서는 불필요하므로 기본 채택은 아님.

---

## 0. 설계 원칙 (P-01 ~ P-10)

| ID   | 원칙                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| P-01 | **썸네일이 카드의 절반 이상** — 결과물은 "봐야 안다". 파일명·메타데이터보다 썸네일이 시선을 먼저 받는다.                           |
| P-02 | **kind 배지 팔레트 재사용** — 첨부 패널의 `--media-attach-kind-*` 5색을 그대로 사용. 입력 ↔ 결과가 같은 색이어야 연상이 유지된다.  |
| P-03 | **하단 버튼은 3개 고정** — [다운로드] [URL 복사] [재생성]. 더 많은 버튼은 오버플로 메뉴(…) 로 숨김.                                |
| P-04 | **재생성 = secondary 톤** — primary 는 [다운로드]. "결과가 나왔는데 또 만들라고 내미는" 톤을 피하기 위함.                             |
| P-05 | **변환 중 = `EmptyState variant="loading"`** · **변환 실패 = `ErrorState onRetry=재생성`** — 공용 컴포넌트로 일원화.                |
| P-06 | **메타데이터는 3줄 상한** — 파일명·크기/포맷·생성 시각의 3가지만. MIME 타입·해시·인코딩 등 기술 메타는 hover 툴팁으로만.              |
| P-07 | **영상은 자동 재생 금지** — 소리로 사용자를 놀라게 하는 대신 정지 썸네일 + 중앙 ▶ 아이콘. 클릭/Enter 시에만 재생.                    |
| P-08 | **재생성은 확인 모달 경유** — 비용이 드는 작업이므로 즉시 실행 금지. "결과가 덮어써진다" 를 1회 확인.                                |
| P-09 | **URL 복사 성공 피드백은 120ms 인라인 플래시** — 토스트가 아님. 토스트는 F4 같은 거시 상태 전용.                                 |
| P-10 | **F4 읽기 전용에서도 카드는 보인다** — 다운로드·복사는 허용, 재생성만 비활성(`data-writable-guard`). 읽기/이동 경로는 잠그지 않음.    |

---

## 1. 카드 기본 구조 (ASCII)

```
┌──────────────────────────────────────────── MediaAssetPreviewCard (기본 272×320) ──┐
│ ┌──────────────────────────────────────────────────────────────────────────────┐ │
│ │ [PDF]                                                                          │ │  ← kind 배지 (좌상단)
│ │                                                                                │ │
│ │                             (썸네일 · 240×160)                                  │ │
│ │                                                                                │ │
│ │                                                                      p.1 / 12 │ │  ← 우하단 페이지/슬라이드 메타
│ └──────────────────────────────────────────────────────────────────────────────┘ │
│  프로젝트 보안 감사 보고서.pdf                                                      │  ← 파일명(1줄, truncate)
│  PDF · 1.8 MB · 12쪽 · 2026-04-19 14:23                                            │  ← 메타 1줄(분리자 ·)
│  생성: Thanos · "결제 모듈 보안 강화" 태스크                                       │  ← 컨텍스트 1줄(optional)
│                                                                                    │
│  [ ⬇ 다운로드 ]   [ 🔗 URL 복사 ]   [ ↻ 재생성 ]                                   │  ← 버튼 3개 고정
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 카드 치수

| 요소              | 값                                              | 근거                                                   |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------ |
| 카드 너비         | `--media-preview-card-width` (272px)            | MediaAttachmentPanel 타일(184px) 보다 크게 — 결과물 강조 |
| 카드 높이         | `--media-preview-card-height` (320px)           | 썸네일 160 + 메타 80 + 버튼 48 + 패딩 32                |
| 썸네일 높이       | `--media-preview-thumb-height` (160px)          | 16:10 비율(가로 240, 세로 160) — 가로 우세 썸네일 공용  |
| 패딩              | `--media-preview-card-padding` (16px)           |                                                        |
| 반응형(<414px)    | 너비 100%, 썸네일 128px                          | 모바일 한 줄 고정, 세로 스크롤 허용                       |

### 1.2 kind 별 썸네일 규격 (첨부 패널 §3 와 동일 · 크기만 상향)

| kind        | 썸네일 소스                                 | 배지     | 우하단 메타             | 특이사항                                             |
| ----------- | ------------------------------------------- | -------- | ----------------------- | ---------------------------------------------------- |
| pdf         | 첫 페이지 PNG (600×400 longest fit 160px)    | PDF      | `p.1 / 12`              | `object-fit: cover`                                   |
| ppt / pptx  | 첫 슬라이드 PNG (16:9)                       | PPT      | `1 / 24`                | `object-fit: contain` + 상하 여백 `--pixel-card` 배경 |
| video       | 첫 프레임 PNG + 중앙 ▶ 오버레이              | MP4      | `04:12` (총 재생 길이) | P-07 자동 재생 금지. 클릭 시 모달로 확대 재생          |
| image       | 원본 이미지 축소                             | IMG      | 해상도 `1920×1080`      | `loading="lazy"`                                     |
| audio       | 파형 스펙트럼 SVG (없으면 Music 아이콘)      | MP3      | 재생 길이 `02:34`       | 파형 색 `--media-attach-kind-video-bg` (violet 재사용) |

---

## 2. 파일 메타데이터 노출 범위 (P-06)

### 2.1 카드 본문(상시 노출) — 최대 3줄

| 줄   | 내용                                           | 폰트·색                                     |
| ---- | ---------------------------------------------- | ------------------------------------------- |
| 1    | 파일명 (확장자 포함, truncate with ellipsis)   | `14px font-bold`, `--media-preview-title-fg` |
| 2    | kind · 크기 · 페이지/해상도/길이 · 생성 시각   | `11px`, `--media-preview-meta-fg` (white/65%) |
| 3    | 생성자 · 원본 태스크/목표 (optional)           | `11px`, `--media-preview-context-fg` (white/55%) |

**구분자 규약**: 메타 줄은 **중점(`·`)** 으로 구분하고 앞뒤에 공백 1칸. 쉼표·슬래시 금지(국제화 시
오해 여지). 한국어에서 중점은 "여러 사실의 동등 나열" 을 자연스럽게 전달한다.

### 2.2 hover/focus 툴팁(확장 정보)

카드에 포커스 혹은 hover 시 600ms 지연 후 카드 하단에 **부제 툴팁** 이 뜬다(툴팁 위치가 아닌 카드
하단 확장):

```
┌──────── 추가 정보 ────────┐
│ MIME: application/pdf      │
│ 해시: sha256:a1b2c3d…      │
│ 저장소: s3://media/… 📋    │  ← 📋 는 경로 복사 버튼(P-09 인라인 플래시)
│ 만료: 2026-05-19 (D-30)    │  ← 서명 URL 인 경우만 표시
└────────────────────────────┘
```

툴팁은 `role="tooltip"` + `aria-describedby` 로 카드에 연결. 키보드 포커스에도 동일하게 나타난다.
`prefers-reduced-motion: reduce` 환경에서는 지연 없이 즉시 노출.

### 2.3 메타 금지 목록

다음 필드는 **카드·툴팁 모두에서 노출하지 않음** — 사용자에게 의미가 거의 없고 레이아웃만 복잡:

- `etag`, `lastModifiedIso` (서버 내부 식별자)
- 내부 파일 경로(s3 키 등) 는 "저장소" 한 줄 요약으로만
- Claude 프롬프트 원문 · 생성 토큰 수 → 이는 `ClaudeTokenUsage` 영역에 이미 있음
- 이진 해시 전체 → 앞 7자 + `…` 만

---

## 3. 버튼 3개 규격

P-03 원칙에 따라 **하단 버튼은 반드시 3개**. 추가 동작은 오버플로(…) 메뉴로 숨김.

### 3.1 버튼 속성

| 버튼         | 아이콘       | 톤         | 동작                                            | 단축키        |
| ------------ | ------------ | ---------- | ----------------------------------------------- | ------------- |
| 다운로드     | `Download`   | primary (emerald) | `GET /api/media/:id/download?inline=false`        | `Enter` (카드 포커스 시) |
| URL 복사     | `Link2`      | secondary  | 클립보드에 전체 URL + 120ms 인라인 플래시 "✓ 복사됨" | `Ctrl+Shift+C` (카드 포커스 시) |
| 재생성       | `RotateCcw`  | secondary  | 확인 모달(§4) → `POST /api/media/:id/regenerate` | —             |

### 3.2 primary(다운로드) 스타일

```css
background: var(--shared-goal-modal-confirm-bg);     /* emerald #34d399 */
color: var(--shared-goal-modal-confirm-fg);          /* 짙은 세피아 */
border: 1px solid var(--shared-goal-modal-confirm-border);
height: 32px · padding: 0 12px · radius: 4px
data-focus-tone="success"
```

### 3.3 secondary(URL 복사·재생성) 스타일

```css
background: transparent;
color: var(--shared-goal-modal-cancel-fg);           /* white/80 */
border: 1px solid var(--shared-goal-modal-cancel-border);
height: 32px · padding: 0 12px · radius: 4px
```

hover 시 배경 `--shared-goal-modal-cancel-hover-bg` (white/6%).

### 3.4 버튼 배치

- 좌측에서 우측 순: [다운로드] [URL 복사] [재생성]
- 간격 `--media-preview-btn-gap` (8px)
- 반응형(<414px) 에서는 세 버튼이 세로 스택으로 바뀜. 높이는 유지, `justify-content: stretch`.

### 3.5 오버플로(…) 메뉴 (확장 옵션)

자주 쓰지 않는 동작(예: "원본 보기", "메타데이터 내보내기", "공유 링크 만료 연장") 은 버튼 3개 옆의
점 세 개(MoreVertical) 아이콘으로 숨긴다. 클릭 시 메뉴:

```
┌─── ⋯ ───────────┐
│ 원본 보기        │
│ 메타 JSON 내려받기│
│ 공유 링크 연장   │
│ 카드 숨기기      │
└───────────────────┘
```

`role="menu"` + `role="menuitem"` + 방향키 네비.

---

## 4. 상태 전이 — 변환 중 · 완료 · 실패

### 4.1 변환 중 (썸네일·메타·버튼 모두 아직 없음)

카드 전체를 `<EmptyState variant="loading">` 로 **교체** 한다. 새 레이아웃을 만들지 않는다.

```tsx
<EmptyState
  variant="loading"
  fillMinHeight={false}
  title="결과를 생성 중…"
  description={<>{kindLabel} · 예상 남은 시간 {etaMs}ms</>}
  testId={`media-preview-${assetId}-loading`}
/>
```

- 카드 테두리·배경은 `--empty-state-*` 토큰 경로로 자연스럽게 cyan dashed 로 전환.
- 상단 kind 배지만 **원래 위치 유지**(사용자가 "무엇을 기다리는지" 를 잊지 않도록).
- 진행률이 있으면 하단에 `--media-preview-progress-*` 토큰 게이지 1줄. 없으면 shimmer
  (`prefers-reduced-motion: reduce` 에서는 고정 70% 채움).

### 4.2 완료 (§1 기본 구조)

변환이 끝나면 thumbnail URL 이 서버에서 도착. 카드는 loading → default 로 **DOM 교체** 가 아닌
**동일 카드 내 콘텐츠 교체**. `key` 는 `assetId` 로 고정해 리렌더 시 포커스/호버가 유지되게 한다.

완료 직후 160ms 동안 `--media-preview-complete-flash-color` (emerald) 테두리 플래시 1회. 축소 모션
환경에서는 플래시 없이 즉시 테두리 색만 전환.

### 4.3 실패 (변환 파이프라인 에러)

`<ErrorState>` 로 카드 전체 교체:

```tsx
<ErrorState
  title="생성에 실패했습니다"
  description={
    <>
      {kindLabel} 변환 도중 오류가 발생했어요. 파일 크기가 허용 범위를 벗어났거나
      서버가 일시적으로 바빴을 수 있습니다. 재생성을 눌러 다시 시도해 보세요.
    </>
  }
  onRetry={handleRegenerate}
  onDismiss={handleHide}
  retryLabel="재생성"
  dismissLabel="숨기기"
  testId={`media-preview-${assetId}-error`}
/>
```

- `onRetry` 는 §4.4 재생성 확인 모달 경유 후 실제 POST 발사.
- 상단 kind 배지는 여전히 좌상단 유지. 실패해도 "어떤 종류의 파일이었는지" 는 알려준다.

### 4.4 재생성 확인 모달 (P-08)

재생성은 비용이 드는 작업이므로 **즉시 실행하지 않는다**. `SharedGoalModal` 과 같은 패턴의
mini-modal:

```
┌─ 결과를 다시 만들까요? ─────────────────────────┐
│ "프로젝트 보안 감사 보고서.pdf" 를 다시 생성하면    │
│ 현재 결과가 덮어써지고 기존 URL 은 만료됩니다.       │
│ 공유해 둔 링크가 있다면 새 링크로 교체가 필요해요.   │
│                                                  │
│              [취소]   [ ↻ 다시 생성하기 ]           │
└──────────────────────────────────────────────────┘
```

- 배경은 `--shared-goal-modal-backdrop`, 다이얼로그는 `--shared-goal-modal-surface`.
- primary 버튼은 emerald(`--shared-goal-modal-confirm-*`) — "결과 지향" 카피.
- 취소는 기본 선택(ESC = 취소). 데이터 손실 방지 기본값.
- `role="dialog" aria-modal="true" aria-labelledby="regen-title"`.

---

## 5. F4 폴백 모드에서의 카드 (P-10)

F4 읽기 전용 모드에서는 모든 쓰기 액션이 잠긴다(선행 시안 `tests/fallback-readonly-banner-mockup.md`).
MediaAsset 카드의 3버튼 중 **재생성만** 비활성화하고, 다운로드·URL 복사는 유지.

```tsx
<button
  data-writable-guard                           // F4 시 전역 CSS 규칙이 자동으로 잠금
  onClick={handleRegenerate}
  aria-label="결과 재생성 (읽기 전용 모드에서는 잠겨 있어요)"
>
  <RotateCcw size={14} /> 재생성
</button>
```

- F4 진입 시 `html[data-fallback="F4"] [data-writable-guard]` 규칙으로 opacity 0.53 + 🔒 접미사가
  자동 적용.
- 다운로드·URL 복사는 `data-writable-guard` 를 **붙이지 않는다** — 읽기 경로이므로 계속 허용.
- 툴팁: `🔒 재충전 필요 — 구독 토큰이 복구되면 자동으로 잠금이 풀립니다` (선행 시안 §3.2 카피
  재사용).

---

## 6. 접근성 · 키보드

| 항목                         | 속성                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| 카드 루트                    | `<article aria-labelledby="media-{id}-title" tabIndex={0}>`                               |
| 파일명 제목                  | `<h3 id="media-{id}-title">`                                                              |
| 썸네일                       | `<img alt="{kindLabel} {filename} 썸네일">` · pdf/ppt 는 페이지 포함(`12쪽 중 1쪽`)           |
| 영상 재생 오버레이            | `role="button" aria-label="영상 재생 (04:12)"`                                            |
| 버튼 3개                     | 각각 `aria-label` 한국어 명시. 단축키는 `aria-keyshortcuts`                                  |
| 메타 툴팁                    | `role="tooltip"` + 카드 `aria-describedby` 연결                                          |
| 로딩 시                      | `<EmptyState variant="loading">` 의 `role="status" aria-live="polite"` 자동 상속            |
| 실패 시                      | `<ErrorState>` 의 `role="alert" aria-live="assertive"` 자동 상속                           |
| 재생성 모달                   | `role="dialog" aria-modal="true"` + 포커스 트랩 + ESC = 취소                               |
| 축소 모션                    | 완료 플래시·썸네일 페이드 모두 `useReducedMotion()` 가드                                      |

### 6.1 키보드 맵 (카드에 포커스가 있을 때)

| 키                | 동작                                                          |
| ----------------- | ------------------------------------------------------------- |
| `Enter`           | [다운로드] 발사                                                |
| `Ctrl+Shift+C`    | URL 복사 (toast 없이 인라인 플래시)                             |
| `Ctrl+R`          | 재생성 확인 모달 열기                                          |
| `Space`           | 영상/오디오면 재생/정지 (모달 안 뜨고 직접 재생)                |
| `Escape`          | 재생성 모달 열려 있으면 취소                                   |
| `Tab`             | 카드 외부로 포커스 이동 (카드 내부는 roving 아니고 세부 버튼은 Shift+Tab/Tab 으로 진입) |

---

## 7. index.css 토큰 제안 — `--media-preview-*`

### 7.1 카드 기본 구조

| 토큰                                          | 값                                           | 용도                                         |
| --------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| `--media-preview-card-width`                  | `272px`                                      | 카드 기본 너비                                |
| `--media-preview-card-height`                 | `320px`                                      | 카드 기본 높이                                |
| `--media-preview-card-radius`                 | `10px`                                       | SharedGoalModal-radius 와 동급                 |
| `--media-preview-card-padding`                | `16px`                                       |                                              |
| `--media-preview-card-bg`                     | `var(--pixel-card)` (= `#16213e`)            | 카드 배경                                    |
| `--media-preview-card-border`                 | `var(--shared-goal-modal-field-border)`      | 기본 테두리                                   |
| `--media-preview-card-border-hover`           | `var(--shared-goal-modal-field-focus)`       | hover/focus cyan                             |
| `--media-preview-card-shadow`                 | `0 8px 24px rgba(0, 0, 0, 0.35)`             | 카드 아래 낮은 그림자                         |

### 7.2 썸네일 · kind 배지

| 토큰                                          | 값                                           | 용도                                         |
| --------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| `--media-preview-thumb-height`                | `160px`                                      | 썸네일 높이                                  |
| `--media-preview-thumb-radius`                | `6px`                                        | 썸네일 모서리                                 |
| `--media-preview-thumb-bg`                    | `var(--media-attach-tile-bg)`                | 썸네일 뒤 바탕(첨부 패널과 동일)             |
| `--media-preview-kind-badge-padding`          | `2px 8px`                                    | 좌상단 배지 패딩                              |
| `--media-preview-kind-badge-radius`           | `4px`                                        |                                              |
| `--media-preview-video-overlay-bg`            | `var(--media-attach-video-overlay-bg)`       | ▶ 아이콘 뒤 반투명 원 (첨부와 동일 토큰)     |
| `--media-preview-video-overlay-fg`            | `var(--media-attach-video-overlay-fg)`       | ▶ 아이콘 색                                   |

### 7.3 타이포

| 토큰                                          | 값                                           | 용도                                         |
| --------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| `--media-preview-title-fg`                    | `var(--shared-goal-modal-header-fg)`         | 파일명 제목(white 100%)                        |
| `--media-preview-title-size`                  | `14px`                                       |                                              |
| `--media-preview-title-weight`                | `700`                                        |                                              |
| `--media-preview-meta-fg`                     | `var(--shared-goal-modal-subtle-fg)`         | 메타 1줄(white/65%)                            |
| `--media-preview-meta-size`                   | `11px`                                       |                                              |
| `--media-preview-context-fg`                  | `rgba(255, 255, 255, 0.55)`                  | 생성자·컨텍스트 1줄                            |
| `--media-preview-meta-divider`                | `'·'`                                       | (CSS 에 의미는 없으나 문서화)                   |

### 7.4 버튼 3개

| 토큰                                          | 값                                           | 용도                                         |
| --------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| `--media-preview-btn-height`                  | `32px`                                       | 세 버튼 공용                                 |
| `--media-preview-btn-gap`                     | `8px`                                        | 버튼 간격                                    |
| `--media-preview-btn-padding`                 | `0 12px`                                     |                                              |
| `--media-preview-btn-radius`                  | `4px`                                        |                                              |
| `--media-preview-copy-flash-duration`         | `120ms`                                      | ✓ 복사됨 인라인 플래시                      |
| `--media-preview-copy-flash-fg`               | `var(--shared-goal-modal-confirm-bg)`        | 플래시 색                                    |
| `--media-preview-btn-overflow-icon-size`      | `16px`                                       | ⋯ (MoreVertical) 아이콘 크기                 |

### 7.5 상태 전이

| 토큰                                          | 값                                           | 용도                                         |
| --------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| `--media-preview-complete-flash-color`        | `var(--shared-goal-modal-confirm-bg)`        | 완료 직후 emerald 플래시 색                   |
| `--media-preview-complete-flash-ms`           | `160ms`                                      | 플래시 지속 시간                              |
| `--media-preview-progress-height`             | `4px`                                        | 로딩 중 게이지 높이                           |
| `--media-preview-progress-track`              | `rgba(255, 255, 255, 0.08)`                  | 게이지 트랙                                    |
| `--media-preview-progress-fill`               | `var(--media-attach-gauge-fill-generating)`  | 게이지 채움(영상 생성 sky 와 같은 hue)        |

---

## 8. 회귀 방지 체크리스트 (QA 복사용)

- [ ] 변환 중 카드는 `<EmptyState variant="loading">` 로만 렌더(인라인 로딩 스피너 중복 금지).
- [ ] 변환 실패 카드는 `<ErrorState onRetry={handleRegenerate}>` 로만 렌더(인라인 에러 배너 중복 금지).
- [ ] 하단 버튼이 정확히 3개(다운로드·URL 복사·재생성). 추가 동작은 ⋯ 메뉴에만.
- [ ] 재생성 클릭 시 즉시 POST 가 아닌 **확인 모달** 이 선행된다.
- [ ] URL 복사 성공 시 버튼 내부 120ms 인라인 플래시만 뜨고 전역 토스트는 뜨지 않는다.
- [ ] F4 모드에서 재생성 버튼만 `data-writable-guard` 로 잠기고 다운로드·URL 복사는 동작한다.
- [ ] 영상 썸네일은 자동 재생되지 않고 ▶ 오버레이 클릭 시에만 재생된다.
- [ ] 썸네일 404(서버 렌더 실패) 시 카드 자체는 유지되고 썸네일 자리에 `<EmptyState variant="loading">`
  또는 kind 아이콘 폴백이 들어간다.
- [ ] 축소 모션 환경에서 완료 emerald 플래시가 제거되고 테두리 색만 즉시 전환된다.
- [ ] 카드 포커스 후 `Ctrl+Shift+C` 로 URL 복사가 동작한다.
- [ ] 카드 포커스 후 `Enter` 가 [다운로드] 를 실행한다(재생성 아님 — P-03 primary 규약).

---

## 9. 구현 메모 (Thanos·Joker 인계용)

1. **신규 컴포넌트**: `src/components/MediaAssetPreviewCard.tsx`.
   ```ts
   interface MediaAsset {
     id: string;
     kind: 'pdf' | 'ppt' | 'video' | 'image' | 'audio';
     filename: string;
     sizeBytes: number;
     createdAt: string;         // ISO
     createdBy?: string;        // 에이전트 이름
     relatedTaskTitle?: string; // 컨텍스트 1줄
     thumbnailUrl?: string;     // 없으면 loading 상태로 간주
     downloadUrl: string;
     publicUrl?: string;        // URL 복사 대상
     durationMs?: number;       // video/audio
     pages?: { current: number; total: number };
     resolution?: { w: number; h: number };
     status: 'generating' | 'done' | 'error';
     errorMessage?: string;
   }
   ```
2. **MediaAsset 스트림**: 서버 엔드포인트 `GET /api/media/:id` 응답과 SSE
   `/api/media/:id/progress` 를 조합. 카드는 둘 모두 구독.
3. **확인 모달 재사용**: `SharedGoalModal.tsx` 의 구조를 그대로 베이스로 가져와 `src/components/
   ConfirmModal.tsx` 공용화 권장. 본 시안의 §4.4 가 첫 사용처가 되고, F4 의 재로그인 모달도 같은
   기반에 얹힐 수 있다.
4. **복사 폴리필**: `tests/task-commit-strategy-mockup.md §9-4` 의 `src/utils/copyToClipboard.ts`
   를 공용으로 재사용(태스크 경계 커밋과 동일 함수).
5. **회귀 테스트**: `tests/mediaAssetPreviewCard.regression.test.tsx` (신규)
   - 변환 중/완료/실패 3상태가 각각 올바른 공용 컴포넌트로 렌더되는지 DOM 매칭.
   - 재생성 버튼 클릭 시 확인 모달이 뜨고 취소가 기본 선택인지.
   - F4 상태에서 재생성만 잠기고 다운로드·URL 복사는 동작하는지.
   - URL 복사 성공 시 전역 토스트가 발사되지 않는지(`useToast` 호출 카운트 = 0).
6. **썸네일 캐시 정책**: `Cache-Control: public, max-age=300` 권장. 재생성 시 새 `assetId` 발급으로
   URL 자체가 바뀌어 캐시 무효화 로직을 별도로 두지 않는다.
