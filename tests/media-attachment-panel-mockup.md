# MediaAttachmentPanel · 멀티미디어 업로드·미리보기 UX 시안 (2026-04-19)

관련 선행 문서:
- `src/components/DirectivePrompt.tsx` — 기존 텍스트 + 첨부 일체형 입력 컴포넌트. 본 시안의
  하위 자료가 되는 첨부 배지·드래그앤드롭 영역의 기초 구현이 여기에 있다. Joker 가
  신규 `MediaAttachmentPanel.tsx` 를 이 영역에서 분리·승격할 예정이며, 본 시안은
  그 분리 지점의 시각·상호작용 규약을 선-고정한다.
- `src/components/EmptyState.tsx` / `src/components/ErrorState.tsx` — 본 시안의 빈 상태·
  에러 상태는 이 두 공용 컴포넌트를 **그대로 재활용** 한다. 새로운 빈/에러 박스를
  만들지 않는다.
- `src/components/ToastProvider.tsx` — 업로드 실패/용량 초과 시 토스트는 본 시안에서
  생성하지 않고 `useToast().push({ variant: 'error', ... })` 로 일원화.
- `src/index.css` — 본 PR 에서 `--media-attach-*` 토큰 계열을 선도입해 구현자가
  리터럴 컬러 없이 시안을 그대로 옮기게 한다.

대상 컴포넌트(신규 제안): `src/components/MediaAttachmentPanel.tsx`
진입점: `DirectivePrompt.tsx` 가 본 패널을 **prop-drill 아닌 children 슬롯** 으로 품고,
        지시 본문·제출 버튼과 같은 컨테이너 프레임 안에서 레이아웃을 공유한다.

---

## 0. 설계 원칙 (M-01 ~ M-08)

| ID   | 원칙                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------- |
| M-01 | **미리보기 우선** — 첨부는 파일명·크기 숫자가 아니라 **썸네일** 로 보여준다. 텍스트는 부속.                      |
| M-02 | **업로드 라이프사이클 4단계** — `queued` → `uploading` → `done` → `error`. 각 단계는 색·아이콘·애니메이션 3중 인코딩. |
| M-03 | **빈 상태 = 초대, 에러 상태 = 조치** — `EmptyState.tsx` 의 cyan 점선, `ErrorState.tsx` 의 red 실선을 그대로 상속. |
| M-04 | **드래그 오버 = 초대 강화** — 빈 상태의 cyan 점선이 **cyan 실선 + glow** 로 2프레임 상승.                       |
| M-05 | **용량·포맷 실패는 토스트** — 패널 안에 박히는 에러 박스는 "전체 업로드 파이프라인이 멎은 상태" 전용.              |
| M-06 | **영상 생성 진행 = 가로 게이지** — 파일 업로드 progress 와 **동일한 게이지 컴포넌트** 를 재사용. 두 개를 만들지 않는다. |
| M-07 | **접근성** — 각 파일 타일은 `role="listitem"`, 영상 생성 상태는 `role="status" aria-live="polite"` 로 낭독.    |
| M-08 | **토큰 공용** — `--shared-goal-modal-*` 의 surface/field-focus/error-strip 과 숫자를 맞춰 "같은 의미 = 같은 색" 유지. |

---

## 1. 패널 레이아웃 (ASCII)

```
┌─────────────────────────── MediaAttachmentPanel (within DirectivePrompt) ───────────────────────────┐
│ ▸ HEADER                                                                                             │
│   🗂 첨부 (3 / 10)                                    전체 크기 12.4 MB / 100 MB   [모두 지우기]        │
├─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▸ GRID (빈 상태)                                                                                      │
│   ┌─────────────────────────────────────────────────────────────────────────────────────────────┐    │
│   │                         (EmptyState variant="empty")                                          │    │
│   │                                                                                               │    │
│   │                      🗂 첨부할 파일이 아직 없습니다                                              │    │
│   │           파일을 여기에 끌어다 놓거나 [ + 파일 선택 ] 으로 추가할 수 있어요.                        │    │
│   │                                                                                               │    │
│   │                   PDF · PPT · 이미지 · MP4 · 오디오 · TXT  (최대 20 MB/개)                       │    │
│   └─────────────────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                                      │
│ ▸ GRID (drag over)                                                                                   │
│   ┌─────────────────────────────────────────────────────────────────────────────────────────────┐    │
│   │ ░░░░░░░░ cyan 실선 2px + inner-glow ░░░░░░░░                                                   │    │
│   │                          ⬇ 여기에 놓으세요                                                      │    │
│   │                       (PDF · PPT · 이미지 · MP4)                                               │    │
│   └─────────────────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                                      │
│ ▸ GRID (with items)                                                                                  │
│   ┌────────────┬────────────┬────────────┬────────────┐                                              │
│   │  PDF 썸네일 │ PPT 슬라이드│  이미지     │  영상 생성   │                                              │
│   │ ┌────────┐ │ ┌────────┐ │ ┌────────┐ │ ┌────────┐ │                                              │
│   │ │ p.1 📄 │ │ │ 1/24 🎞│ │ │ 🖼️     │ │ │ ▶ 04:12│ │                                              │
│   │ └────────┘ │ └────────┘ │ └────────┘ │ └────────┘ │                                              │
│   │ 제안서.pdf │ 발표.pptx   │ screen.png │ 생성_중.mp4│                                              │
│   │ 2.4 MB ✓   │ 5.1 MB ↑68│ 820 KB ✓   │ 생성 중…62%│                                              │
│   │ ████████ 100│ █████████63│ ████████ 100│ ███████─62│                                              │
│   └────────────┴────────────┴────────────┴────────────┘                                              │
│                                                                                                      │
│ ▸ GRID (error: 파이프라인 전체 실패)                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────────────────────────────┐    │
│   │                         (ErrorState onRetry=재시도 onDismiss=닫기)                             │    │
│   │  ⚠ 업로드 경로가 차단되었습니다                                                                  │    │
│   │  서버 연결이 끊어졌습니다. 네트워크를 확인한 뒤 [재시도] 를 누르면 대기 중인 3개 파일이 다시 올라갑니다. │    │
│   │                                                                    [재시도]  [닫기]              │    │
│   └─────────────────────────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 파일 타일(Attachment Tile) 정밀 규격

각 타일은 `<li role="listitem">` 이며, 내부는 4행 세로 레이아웃이다.

| 행      | 역할                                              | 높이      |
| ------- | ------------------------------------------------- | --------- |
| 1 썸네일 | kind 별 미리보기(문단 §3)                         | 120px     |
| 2 이름  | 파일명(truncate with middle-ellipsis)              | 18px      |
| 3 메타  | 크기 · 상태 아이콘(`queued ○` / `uploading ↑` / `done ✓` / `error ⚠`) | 16px |
| 4 게이지 | 0~100 가로 게이지(상태별 색)                       | 4px       |

**너비**: 기본 184px (`--media-attach-tile-width`). 컨테이너 폭에 따라 `minmax(160px, 1fr)` 로
CSS grid 자동 배치. 모바일(<414px) 에서는 `minmax(136px, 1fr)` 로 축소하여 2열 확보.

**모서리·그림자**: `border-radius: var(--media-attach-tile-radius, 8px)`. 기본은 `box-shadow` 없음.
`hover` / `focus-visible` 시 `--media-attach-tile-hover-glow` 를 외곽 2px 링으로 1프레임 띄움.

**상태별 시각** (game changers 는 상태별 색·애니메이션만 바뀌고 구조는 동일):

| 상태        | 테두리                                       | 메타 아이콘 | 게이지 색                                   | 애니메이션                                 |
| ----------- | -------------------------------------------- | ----------- | ------------------------------------------- | ------------------------------------------ |
| `queued`    | `--media-attach-tile-border` (white/18%)     | ○           | `--media-attach-gauge-track` (단색 트랙)    | 없음                                       |
| `uploading` | `--media-attach-tile-border-active` (cyan)   | ↑           | `--media-attach-gauge-fill` (cyan)          | indeterminate 일 땐 1.2s shimmer           |
| `done`      | `--media-attach-tile-border-done` (emerald)  | ✓           | `--media-attach-gauge-fill-done` (emerald)  | 완료 직후 160ms emerald 테두리 플래시       |
| `error`     | `--media-attach-tile-border-error` (red)     | ⚠           | `--media-attach-gauge-fill-error` (red)     | 200ms translateX shake 1회                 |

---

## 3. kind 별 썸네일 규격 — PDF · PPT · 영상 생성

본 시안의 핵심은 "문서/프레젠테이션/영상은 숫자가 아니라 **축소된 실물** 로 보여준다"는 것.
기존 `DirectivePrompt.tsx` 는 `pdf/image/text/other` 4종의 아이콘 라벨만 쓰고 있어, 이번 확장에서
`pdf → 썸네일`, `ppt → 슬라이드`, `video → 프레임+진행` 을 추가 분기한다.

### 3.1 PDF 썸네일

| 요소            | 규격                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------- |
| 이미지          | 첫 페이지를 서버에서 PNG 로 렌더(300×420 longest fit 120px height). `object-fit: cover`.             |
| 좌상단 배지     | `PDF` 라벨(배경 `--media-attach-kind-pdf-bg`, 글자 `--media-attach-kind-pdf-fg`). kr-msg 폰트. |
| 우하단 메타     | `p.1 / 12` (몇 쪽 중 첫 쪽) — subtle fg.                                                            |
| 로딩 중         | 썸네일 없으면 `<EmptyState variant="loading" fillMinHeight={false} />` 를 그대로 타일 안에 넣는다.   |
| 실패(thumb API) | 텍스트 "미리보기 준비 중" + 아이콘 `FileText` — 여전히 파일 자체는 업로드 성공.                        |

**스크린리더**: `aria-label="PDF 제안서.pdf, 12쪽 중 1쪽 썸네일"`.

### 3.2 PPT 슬라이드 프리뷰

| 요소            | 규격                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------- |
| 이미지          | 첫 슬라이드 PNG. 비율 16:9 고정(썸네일 높이 120px 기준 폭 213px). `object-fit: contain`.              |
| 좌상단 배지     | `PPT` 라벨(배경 `--media-attach-kind-ppt-bg`, 글자 `--media-attach-kind-ppt-fg`).                  |
| 우하단 메타     | `1 / 24` (현재/총 슬라이드 수).                                                                     |
| hover/focus     | 썸네일 위에 오버레이 `▶ 슬라이드 펼치기` — 클릭 시 `onPreview(attachment, { slide: 1 })` 호출.       |
| 슬라이드 네비   | 타일 하단에 작은 도트(최대 10). `aria-hidden="true"` — 키보드 초점은 ▶ 오버레이로만.                    |

**색**: PPT 는 `--media-attach-kind-ppt-bg` 주황(oven/발표 은유) + 글자는 어두운 세피아. PDF 의
진한 주홍과 색상만 한 단계 이동해 "문서" 계열 안에서도 두 종을 구분.

### 3.3 영상 생성(Video Generation) 진행 표시

영상은 **업로드가 아닌 "생성"** 경로도 포함한다(예: 외부 생성 엔진 호출 후 결과를 첨부). 따라서 타일은
`generating` 이라는 하위 상태(subset of `uploading`)를 갖고, 메타·게이지·썸네일 세 축 모두 바뀐다.

| 요소           | 규격                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| 썸네일         | 생성 중이면 **첫 프레임 플레이스홀더**(회색 그라디언트 + 중앙 `Film` 아이콘). 완료 시 첫 프레임 PNG.       |
| 오버레이       | `▶ 04:12` (예상 총 길이 혹은 현재 생성된 분량). 중앙. 글자 `--media-attach-video-overlay-fg`.          |
| 좌상단 배지    | `MP4` (혹은 `WEBM`). 배경 `--media-attach-kind-video-bg`, 글자 `--media-attach-kind-video-fg`.         |
| 게이지         | `--media-attach-gauge-fill-generating` (sky — "미래에 도착할 결과"). indeterminate 경로는 shimmer.       |
| 메타           | `생성 중… 62%` (정수 퍼센트). 62% 이상은 `--media-attach-gauge-fill-generating-high` 로 밝기 +6%.         |
| 완료 직후      | 160ms emerald 플래시(업로드 `done` 과 동일 구간) + `✓ 생성 완료` 토스트 1회.                               |
| 취소 버튼       | 우상단 `×` — `role="button" aria-label="영상 생성 취소"`. 클릭 시 `onCancelGenerate(attachmentId)` 위임.  |

**낭독**: `<div role="status" aria-live="polite">영상 생성 62% 진행 중</div>` 를 10% 단위로만 갱신
(스크린리더 소음 방지).

---

## 4. 드래그앤드롭 4상태

`DirectivePrompt.tsx` 는 이미 `data-drag-over` 를 드롭존에 찍는다. 본 시안은 그 위에 네 개의 시각
상태를 명시적으로 규격화한다. 네 상태 모두 **같은 DOM 서브트리** 에서 클래스·데이터 속성 토글로만
표현한다(layout shift 0 계약).

| 상태         | 트리거                                                           | 테두리                                      | 배경                                       | 아이콘 / 카피                            |
| ------------ | ---------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------ | --------------------------------------- |
| `idle-empty` | 아직 첨부 0개                                                    | `--media-attach-dropzone-border` (cyan dashed) | `--media-attach-dropzone-bg` (투명)          | `🗂` + "파일을 여기로 끌어다 놓거나…"      |
| `idle-has`   | 첨부 ≥1개. 드래그 오버 아님                                       | 없음(타일 그리드만 보임)                      | 없음                                       | 하단 작은 "+ 더 끌어다 놓을 수 있어요"     |
| `drag-over` | OS 드래그가 패널 위로 진입                                       | `--media-attach-dropzone-border-active` (cyan 실선) | `--media-attach-dropzone-bg-active` (cyan 8%) | `⬇` + "여기에 놓으세요" (h2 스케일)    |
| `drag-reject` | MIME/용량 필터에 걸려 drop 시 에러가 예상되는 경우                  | `--media-attach-dropzone-border-reject` (amber 실선) | `--media-attach-dropzone-bg-reject` (amber 8%) | `⛔` + "이 파일은 추가할 수 없어요(형식)" |

**OS 드래그 타입 검사**: `dragover` 의 `e.dataTransfer.types` 를 읽어 `Files` 가 없는 드래그(텍스트·이미지
드래그 등)는 `drag-reject` 로 분기. 접근성상 `aria-busy`, `aria-describedby` 로 카피를 직접 낭독하는
것은 피하고, **시각 단서** + 드롭 직후 토스트로 전달.

**회귀 방지 체크리스트**
- [ ] 드롭존은 `height: var(--media-attach-dropzone-min-height, 160px)` 이상으로 항상 눈에 들어온다.
- [ ] 드래그 오버 ↔ 해제 전이 시 `transform` 이 아닌 `box-shadow` 변화만 사용(Mac 트랙패드에서 박스 흔들림 방지).
- [ ] 키보드 사용자는 `[ + 파일 선택 ]` 버튼 하나로만 전체 추가 경로를 커버한다. 드롭존 자체는 Tab 으로 선택 불가(중복 포커스 회피).

---

## 5. 게이지 컴포넌트 재사용 규약

업로드 progress 와 영상 생성 progress 는 **동일한 `<Progress>` 컴포넌트** 를 쓴다. 구현은 `<div
role="progressbar" aria-valuemin=0 aria-valuemax=100 aria-valuenow={n}>` 의 단순 래퍼이며,
색만 `data-variant` 로 분기.

| data-variant    | 트랙                             | 채움                                            | 쓰이는 곳                          |
| --------------- | -------------------------------- | ----------------------------------------------- | ---------------------------------- |
| `upload`        | `--media-attach-gauge-track`     | `--media-attach-gauge-fill`                    | 업로드 중 타일                      |
| `upload-done`   | `--media-attach-gauge-track`     | `--media-attach-gauge-fill-done`               | 업로드 완료 타일(100% 유지)         |
| `upload-error`  | `--media-attach-gauge-track`     | `--media-attach-gauge-fill-error`              | 업로드 실패 타일                    |
| `generating`    | `--media-attach-gauge-track`     | `--media-attach-gauge-fill-generating`          | 영상 생성 중 타일                   |
| `generating-high` | `--media-attach-gauge-track`   | `--media-attach-gauge-fill-generating-high`   | 영상 생성 62% 이상 — 밝기 상승      |

**indeterminate 규칙**: `aria-valuenow` 가 누락됐거나 < 0 이면 `::after` 에 1.2s translate 애니메이션으로
shimmer. `prefers-reduced-motion: reduce` 에서는 shimmer 제거 + 고정 70% 채움으로 대체.

---

## 6. 빈 상태 · 에러 상태 재활용

본 시안은 **새로운 빈 상태 박스나 에러 박스를 만들지 않는다**. 대신:

```tsx
// 빈 상태
<MediaAttachmentPanel>
  {attachments.length === 0 ? (
    <EmptyState
      variant="empty"
      title="첨부할 파일이 아직 없습니다"
      description={<>파일을 여기에 끌어다 놓거나 <button>+ 파일 선택</button> 으로 추가할 수 있어요.</>}
      action={{ label: '파일 선택', onClick: pickFile, testId: 'media-attach-empty-cta' }}
    />
  ) : (
    <MediaAttachmentGrid ... />
  )}
</MediaAttachmentPanel>

// 전체 파이프라인 에러
{pipelineError && (
  <ErrorState
    title="업로드 경로가 차단되었습니다"
    description={pipelineError.message}
    onRetry={retryAll}
    onDismiss={clearPipelineError}
    testId="media-attach-pipeline-error"
  />
)}
```

**원칙**: 타일 1건의 실패는 타일 내부에서 `error` 상태로 표현(§2), 패널 전체의 실패(서버 다운 등)
만 `ErrorState` 로 올라온다. 두 축이 섞이면 사용자가 "하나 실패인지 전체 실패인지" 를 판별 못한다.

---

## 7. index.css 토큰 — `--media-attach-*` (본 PR 선도입)

기존 `--shared-goal-modal-*` 과 이름 공간을 분리하되, **숫자 공유** 를 통해 시각 규약 통일:
- `--media-attach-tile-border-done` = `--shared-goal-border-saved` (emerald `#34d399`)
- `--media-attach-tile-border-error` = `--error-state-strip` (red `#f87171`)
- `--media-attach-dropzone-border` = `--empty-state-border` 와 같은 cyan dashed
- `--media-attach-dropzone-border-active` = `--shared-goal-modal-field-focus` (cyan `#7fd4ff`)
- `--media-attach-dropzone-border-reject` = `--shared-goal-modal-field-editing-border` (amber `#fbbf24`)

### 7.1 타일

| 토큰                                      | 값                                  | 용도                                |
| ----------------------------------------- | ----------------------------------- | ----------------------------------- |
| `--media-attach-tile-width`               | `184px`                             | 그리드 1셀 기본 폭                  |
| `--media-attach-tile-radius`              | `8px`                               | 타일 모서리                         |
| `--media-attach-tile-border`              | `rgba(255, 255, 255, 0.18)`         | 기본 테두리 (= `--shared-goal-modal-field-border`) |
| `--media-attach-tile-border-active`       | `#7fd4ff`                           | 업로드 중 cyan                      |
| `--media-attach-tile-border-done`         | `#34d399`                           | 완료 emerald                        |
| `--media-attach-tile-border-error`        | `#f87171`                           | 실패 red                            |
| `--media-attach-tile-hover-glow`          | `rgba(127, 212, 255, 0.35)`         | hover/focus 2px 외곽 링              |
| `--media-attach-tile-bg`                  | `rgba(0, 0, 0, 0.28)`               | 썸네일 영역 바탕(실제 이미지 뒤)    |

### 7.2 kind 배지

| 토큰                                | 값        | 용도                                           |
| ----------------------------------- | --------- | ---------------------------------------------- |
| `--media-attach-kind-pdf-bg`        | `#b54708` | PDF 배지 배경(진한 주홍, orange-700)            |
| `--media-attach-kind-pdf-fg`        | `#ffe5cc` | PDF 배지 글자                                  |
| `--media-attach-kind-ppt-bg`        | `#d97706` | PPT 배지 배경(오렌지, orange-600)              |
| `--media-attach-kind-ppt-fg`        | `#fff4e0` | PPT 배지 글자                                  |
| `--media-attach-kind-image-bg`      | `#0e7490` | 이미지 배지 배경(cyan-700)                     |
| `--media-attach-kind-image-fg`      | `#cffafe` | 이미지 배지 글자                               |
| `--media-attach-kind-video-bg`      | `#6d28d9` | 영상 배지 배경(violet-700)                     |
| `--media-attach-kind-video-fg`      | `#ede9fe` | 영상 배지 글자                                 |
| `--media-attach-kind-text-bg`       | `#166534` | 텍스트 배지 배경(green-800)                    |
| `--media-attach-kind-text-fg`       | `#dcfce7` | 텍스트 배지 글자                               |

### 7.3 드롭존

| 토큰                                          | 값                                 | 용도                                     |
| --------------------------------------------- | ---------------------------------- | ---------------------------------------- |
| `--media-attach-dropzone-min-height`          | `160px`                            | 빈 상태·드래그 오버 공용 최소 높이          |
| `--media-attach-dropzone-radius`              | `10px`                             |                                          |
| `--media-attach-dropzone-border`              | `rgba(127, 212, 255, 0.35)`        | idle-empty 점선 cyan                     |
| `--media-attach-dropzone-border-active`       | `#7fd4ff`                          | drag-over 실선 cyan                      |
| `--media-attach-dropzone-border-reject`       | `#fbbf24`                          | drag-reject 실선 amber                   |
| `--media-attach-dropzone-bg`                  | `transparent`                      | idle-empty                               |
| `--media-attach-dropzone-bg-active`           | `rgba(127, 212, 255, 0.08)`        | drag-over                                |
| `--media-attach-dropzone-bg-reject`           | `rgba(251, 191, 36, 0.08)`         | drag-reject                              |
| `--media-attach-dropzone-glow`                | `rgba(127, 212, 255, 0.35)`        | drag-over inner-glow(box-shadow inset)   |

### 7.4 게이지

| 토큰                                              | 값                                   | 용도                                  |
| ------------------------------------------------- | ------------------------------------ | ------------------------------------- |
| `--media-attach-gauge-height`                     | `4px`                                | 진행 게이지 높이                      |
| `--media-attach-gauge-radius`                     | `2px`                                |                                       |
| `--media-attach-gauge-track`                      | `rgba(255, 255, 255, 0.08)`          | 비어 있는 트랙                        |
| `--media-attach-gauge-fill`                       | `#7fd4ff`                            | 업로드 중 cyan                        |
| `--media-attach-gauge-fill-done`                  | `#34d399`                            | 완료 emerald                          |
| `--media-attach-gauge-fill-error`                 | `#f87171`                            | 실패 red                              |
| `--media-attach-gauge-fill-generating`            | `#60a5fa`                            | 영상 생성 중 sky                      |
| `--media-attach-gauge-fill-generating-high`       | `#93c5fd`                            | 62% 이상 밝기 상승(sky-300)           |
| `--media-attach-gauge-shimmer-duration`           | `1.2s`                               | indeterminate shimmer 1회전 시간      |

### 7.5 영상 오버레이

| 토큰                                      | 값                                 | 용도                             |
| ----------------------------------------- | ---------------------------------- | -------------------------------- |
| `--media-attach-video-overlay-bg`         | `rgba(0, 0, 0, 0.55)`              | ▶ 재생 시간 오버레이 배경        |
| `--media-attach-video-overlay-fg`         | `#ffffff`                          | 재생 시간 글자                   |
| `--media-attach-video-cancel-fg`          | `rgba(255, 255, 255, 0.80)`        | 취소 × 아이콘                    |
| `--media-attach-video-cancel-hover-fg`    | `#f87171`                          | 취소 hover(red 승격)             |

### 7.6 대비 검증 (`--pixel-card #16213e` 기준)

- `--media-attach-tile-border-done`(#34d399) 5.9:1 · AA 본문
- `--media-attach-tile-border-error`(#f87171) 5.9:1 · AA 본문
- `--media-attach-kind-pdf-fg`(#ffe5cc) on pdf-bg(#b54708) 6.2:1 · AA 본문
- `--media-attach-kind-ppt-fg`(#fff4e0) on ppt-bg(#d97706) 4.7:1 · AA 본문
- `--media-attach-kind-video-fg`(#ede9fe) on video-bg(#6d28d9) 9.1:1 · AAA
- `--media-attach-gauge-fill-generating`(#60a5fa) 4.9:1 · AA 본문

**색각 이상 대응**: kind 배지 5종은 색 + 3~4자 라벨(`PDF`, `PPT`, `IMG`, `MP4`, `TXT`) + 타일
우하단 메타(페이지/슬라이드 번호) 3중 인코딩. 상태 4종(queued/uploading/done/error) 도
색 + 메타 아이콘(○↑✓⚠) + 게이지 색 3중 인코딩.

---

## 8. 접근성 & 키보드

| 키              | 동작                                                                       |
| --------------- | -------------------------------------------------------------------------- |
| `Tab`           | `+ 파일 선택` → 타일 1 → 타일 2 → … → 모두 지우기 → (패널 외부)                 |
| `Enter`/`Space` | 포커스된 타일을 `onPreview(attachment)` 로 열기                              |
| `Delete`        | 포커스된 타일을 제거(`onRemove(attachment.id)`). 미저장이면 토스트로 확인    |
| `Esc`           | 진행 중인 업로드가 있으면 "취소하시겠어요?" 확인 토스트. 없으면 no-op        |

**스크린리더**:
- 패널 루트: `<section aria-label="첨부 파일 ({N})">`
- 그리드: `<ul role="list">`
- 각 타일: `<li role="listitem" aria-label="제안서.pdf, PDF, 2.4 MB, 업로드 완료">`
- 영상 생성 진행: `<div role="status" aria-live="polite">영상 생성 62%</div>` (10% 단위 업데이트)
- 드롭존 오버 상태: aria-live 로 낭독하지 않음(시각 단서로만) — 중복 낭독 방지

---

## 9. 구현 메모 (Joker 인계용)

1. **DOM 구조 분리**: 현재 `DirectivePrompt.tsx` 의 dropzone/attachments 블록을
   `src/components/MediaAttachmentPanel.tsx` 로 옮긴다. DirectivePrompt 는 `<slot />` 위치만 남기고
   props 를 통과시킨다.
2. **썸네일 서버 엔드포인트**: `GET /api/attachments/:id/thumbnail?kind=pdf|ppt&page=1` 를
   신규 추가. 서버는 `pdftoppm` / `libreoffice --headless` 를 사용해 PNG 를 생성하고, 300s
   캐시 헤더를 단다. 시안 단계에서는 404 시 `<EmptyState variant="loading" />` 로 폴백한다.
3. **영상 생성 경로**: `POST /api/media/generate` 응답으로 `attachmentId` 만 받고, 실제 진행은
   SSE 엔드포인트 `/api/media/generate/:id/stream` 에서 `{progress: 0..100, previewFrame?: base64}`
   이벤트로 push. 본 시안은 이 이벤트 스키마만 가정한다.
4. **파일 선택 버튼 재사용**: `EmptyState.action` 의 버튼이 `pickFile()` 을 호출. 드롭존 자체는
   키보드 초점 불가. 이렇게 분리하면 "Tab 으로 같은 동작을 두 번 밟지 않는다" 는 키보드 사용자
   원칙이 유지된다.
5. **토스트 연동**: 용량/MIME 필터 실패는 `useToast().push({ variant: 'warning', title: '형식이 맞지
   않아요', description: '허용: PDF, PPT, 이미지, MP4' })`. 네트워크 실패는 타일 `error` + 패널
   단일 토스트 1회.
6. **Joker 의 기존 작업 보호**: `DirectivePrompt.tsx` 의 기존 `data-drag-over` 속성과
   `directive-prompt__dropzone` 클래스는 유지. 본 시안은 추가 CSS 클래스와 토큰을 덧붙일 뿐
   기존 훅을 제거하지 않는다.

---

## 10. 회귀 방지 체크리스트 (QA 복사용)

- [ ] 빈 상태에서 `EmptyState` 가 렌더되고 `action.onClick` 이 파일 선택 다이얼로그를 연다.
- [ ] 드래그 오버 시 dropzone 테두리가 **dashed → solid** 로만 바뀌고 크기/높이는 변하지 않는다.
- [ ] drag-reject 상태에서 drop 을 강행하면 `ToastProvider` 의 `warning` 토스트 1회가 뜬다.
- [ ] PDF 썸네일 404 시 타일 안에 로딩/대체 표시가 나타나고 타일 자체는 제거되지 않는다.
- [ ] 영상 생성 중 취소 버튼(× ) 이 키보드(`Tab→Enter`) 로도 동작한다.
- [ ] `prefers-reduced-motion: reduce` 경로에서 shimmer·shake 가 제거되고 게이지는 고정 값으로만 표현된다.
- [ ] 100MB 총량 경고 시 패널 헤더의 `12.4 MB / 100 MB` 가 amber 로 전환된다.
- [ ] 스크린리더에서 각 타일은 "파일명, 종류, 크기, 상태" 네 축이 한 번의 낭독으로 전달된다.
