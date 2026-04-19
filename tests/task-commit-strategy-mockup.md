# 태스크 경계 커밋(commitStrategy) UX 시안 (2026-04-19)

관련 선행 문서:
- `tests/shared-goal-modal-mockup.md` (2026-04-19) — 자동 개발 ON on-ramp 모달. 본 시안의
  "commitStrategy 선택" 은 **자동 개발 ON 의 하위 옵션** 이므로 모달의 footer 혹은 설정 패널에
  조회/편집 UI 가 붙는다. `--shared-goal-modal-*` 토큰과 시각적으로 연속되도록 라디오 그룹의
  테두리·포커스 색을 동일 팔레트로 묶는다.
- `tests/token-fallback-states-mockup.md` (2026-04-19) / `tests/fallback-readonly-banner-mockup.md`
  (2026-04-19) — F4 읽기 전용 모드 세부. 본 시안의 "큐잉됨(queued-during-readonly)" 상태는
  F4 지속 동안 자동 커밋이 서버 큐에 쌓이는 케이스. F4 복귀 시 순서대로 풀어내는 규약을 §5 에 명시.
- `src/components/CollabTimeline.tsx` — task-commit 이벤트 배지가 새로 얹히는 자리. 기존
  handoff/report 행 옆에 별도 "commit" 행 종류로 합류. 기존 `STATUS_GLYPH(○◔●⊘)` 와 겹치지
  않는 전용 글리프 `◈`(커밋) · `◇`(큐잉됨)을 사용해 색약 사용자도 형태만으로 구분 가능.
- `src/components/ToastProvider.tsx` — 큐잉됨 상태 진입/해제 시 토스트 톤을 본 시안의 §5.3 에
  info / success 로 고정.

대상 컴포넌트(신규/확장):
- `src/components/TaskCommitStrategyField.tsx` (신규) — 라디오 그룹 UI. `SharedGoalModal` 의 footer
  혹은 `ProjectManagement` 의 자동 개발 섹션에 얹힌다.
- `src/components/CollabTimeline.tsx` (확장) — task-commit / task-commit-queued 두 행 종류 추가.
- `src/components/FallbackReadonlyBanner.tsx` (신규, 선행 시안 §9) — F4 배너 안에 큐잉 건수
  "📦 3건 대기" 라벨이 추가되는 변형.

---

## 0. 설계 원칙 (C-01 ~ C-08)

| ID   | 원칙                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| C-01 | **세 옵션은 동등한 위계로 배열** — 추천 기본값은 '태스크마다' 이지만 라디오 위에 "추천" 라벨을 띄우지는 않는다. 사용자의 선택 맥락을 오염시키지 않기 위함. |
| C-02 | **설명은 "언제·어디에·무엇을" 의 3문장** — 옵션별 보조 카피는 ①언제 커밋되는가 ②어떤 브랜치/원격에 ③메시지 구성 규약. 3문장을 초과하지 않는다. |
| C-03 | **아이콘은 시간축 은유** — 태스크마다=`Milestone`(지점), 공동 목표 완료 시=`Flag`(도착), 수동=`Hand`(자유). 기존 lucide-react 아이콘만 사용. |
| C-04 | **커밋 해시는 항상 앞 7자** — `a1b2c3d` 모노스페이스. hover/focus 시 툴팁으로 전체 해시. 복사 버튼은 **전체 해시** 를 클립보드에 넣는다.      |
| C-05 | **메시지 미리보기는 한 줄 · 72자** — 초과분은 `…` 말줄임. hover 시 전체 메시지 툴팁(`<pre>` + `word-break: keep-all`).                    |
| C-06 | **F4 폴백 동안에는 큐잉됨 행** — 실제 커밋이 생성되지 않았음을 `◇` 빈 다이아몬드 글리프 + "큐잉됨" 라벨 + 회색 톤으로 표현. 조바심 유도 금지.      |
| C-07 | **복구 후 일괄 해소 1회 낭독** — 큐잉 N건이 한 번에 풀리면 `success` 토스트 3s 로 "📦 3건의 커밋이 순차 기록되었습니다" 1회.                   |
| C-08 | **shared-goal-modal 팔레트 연속성** — 라디오 선택 시 테두리 `--shared-goal-modal-field-focus` cyan, 변경 후 미저장 amber, 저장 완료 emerald. |

---

## 1. commitStrategy 3옵션 라디오 그룹 레이아웃

```
┌─ 태스크 경계 커밋 ────────────────────────────────────────────────────────────────┐
│ 자동 개발이 태스크를 끝낼 때 커밋을 어떻게 만들지 선택해 주세요.                       │
│                                                                                    │
│ ┌──────────────────────────────────────────────────────────────────────────────┐  │
│ │ ( ) 🎯 태스크마다                                                              │  │
│ │     각 태스크가 완료되는 순간 바로 커밋합니다.                                   │  │
│ │     현재 브랜치에 쌓이며, 메시지는 "[태스크 제목] 완료" 로 생성됩니다.             │  │
│ │     되돌리기 쉽고 히스토리가 조밀해져요.                                          │  │
│ ├──────────────────────────────────────────────────────────────────────────────┤  │
│ │ ( ) 🏁 공동 목표 완료 시                                                        │  │
│ │     모든 태스크가 끝나고 공동 목표가 done 으로 바뀔 때 한 번에 커밋합니다.           │  │
│ │     squash 없이 모든 변경을 하나의 커밋으로 묶고, 메시지는 목표 제목 + 요약 5줄로 구성. │  │
│ │     리뷰어가 큰 단위로 보고 싶을 때 적합합니다.                                     │  │
│ ├──────────────────────────────────────────────────────────────────────────────┤  │
│ │ ( ) ✋ 수동                                                                     │  │
│ │     자동 커밋을 하지 않습니다.                                                    │  │
│ │     파일 변경은 working tree 에 그대로 두고, 사용자가 원할 때 터미널 또는 Git      │  │
│ │     자동화 패널 [커밋하기] 버튼으로 직접 커밋하세요.                               │  │
│ └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                    │
│ 💡 F4 읽기 전용 모드에서는 세 옵션 모두 "큐잉됨" 상태로 잠시 보류되며, 복귀 시 순차 실행됩니다. │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 라디오 타일 시각 규격

각 옵션은 **전체 카드가 클릭 가능** 한 타일이다. 작은 라디오 원만 클릭 가능한 구조는 모바일에서
실패하기 쉽다(Fitts' Law).

| 요소              | 규격                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| 타일 너비         | `--task-commit-tile-min-width` (288px) 이상, 컨테이너 100%                                             |
| 타일 높이         | 자동(내용 길이에 따라). 최소 `--task-commit-tile-min-height` (88px)                                     |
| 라디오 원         | `--task-commit-radio-size` (16px). 좌측 상단 정렬, 16px 위 12px 좌 패딩                                  |
| 아이콘            | 라디오 오른쪽 8px, size=14px. 색 `--task-commit-icon-fg` (cyan)                                        |
| 제목              | `13px font-bold`. 색 `--shared-goal-modal-header-fg` (white 100%)                                    |
| 설명              | `11px leading-relaxed`. 색 `--shared-goal-modal-subtle-fg` (white/65%). 최대 3줄                        |
| 타일 테두리(비선택) | `--task-commit-tile-border` = `--shared-goal-modal-field-border` (white/18%)                          |
| 타일 테두리(호버)   | `--task-commit-tile-border-hover` = `--shared-goal-modal-field-focus` (cyan)                          |
| 타일 테두리(선택)   | `--task-commit-tile-border-selected` = `--shared-goal-modal-field-focus` (cyan) + 2px box-shadow glow |
| 타일 배경(선택)     | `--task-commit-tile-bg-selected` = `rgba(127, 212, 255, 0.08)`                                        |
| 타일 배경(편집 중)  | `--task-commit-tile-bg-editing` = `rgba(251, 191, 36, 0.06)` — 변경 후 아직 미저장                      |
| 타일 간격          | `--task-commit-tile-gap` (8px) 세로 스택                                                              |
| 키보드              | `↑/↓` 방향키로 옵션 이동(ARIA `role="radiogroup"` 규약). Tab 은 그룹 진입/이탈에만 사용.                 |

### 1.2 카피 규약 (C-02 구조)

| 옵션                    | 언제                                                | 어디에/무엇을                                          | 추가 한 줄                                         |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| 🎯 태스크마다            | 각 태스크가 완료되는 순간 바로 커밋합니다.              | 현재 브랜치에 쌓이며, 메시지는 `[태스크 제목] 완료` 로 생성됩니다. | 되돌리기 쉽고 히스토리가 조밀해져요.                 |
| 🏁 공동 목표 완료 시     | 모든 태스크가 끝나고 공동 목표가 done 으로 바뀔 때 한 번에 커밋합니다. | squash 없이 모든 변경을 하나의 커밋으로 묶고, 메시지는 목표 제목 + 요약 5줄로 구성. | 리뷰어가 큰 단위로 보고 싶을 때 적합합니다. |
| ✋ 수동                  | 자동 커밋을 하지 않습니다.                            | 파일 변경은 working tree 에 그대로 두고, 사용자가 원할 때 터미널 또는 Git 자동화 패널 [커밋하기] 버튼으로 직접 커밋하세요. | (추가 한 줄 없음 — 수동은 가장 짧게 유지) |

**카피 규칙**:
1. 세 옵션 모두 **존댓말** 유지. "커밋합니다" · "적합합니다" 처럼 `-습니다` 어미.
2. **"자동" / "수동"** 을 옵션 내부 본문에서 반복하지 않는다(제목에 이미 있음). 대신 언제·어떻게를 설명.
3. **Git 전문 용어** (squash, working tree) 는 괄호 없이 그대로 사용하되, 처음 등장 시에만. 반복 시 한글로.
4. **위험 어휘 금지** — "되돌리기 어려워요", "실수하기 쉬워요" 같은 표현은 옵션을 피하게 만든다. 대신 "조밀해져요", "큰 단위로 보고 싶을 때 적합합니다" 등 긍정 장점만.

### 1.3 아이콘 — lucide-react 직접 매핑

본 프로젝트는 `lucide-react` 만 사용한다. 아래 매핑으로 확정:

| 옵션                    | lucide 컴포넌트        | 근거                                                                     |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------ |
| 🎯 태스크마다            | `Milestone`            | "이정표" — 작은 단위의 완료 시점 표현                                     |
| 🏁 공동 목표 완료 시     | `Flag`                 | "도착 지점" — 모든 태스크 끝나는 순간                                     |
| ✋ 수동                  | `Hand`                 | "사용자의 손" — 자율 조작. `MousePointer2` 와 혼동 없음                   |

(이모지 🎯·🏁·✋ 는 시안 ASCII 에서의 가독성을 위한 것이며, 실제 구현은 lucide 아이콘만 사용.)

### 1.4 저장 상태 3밴드 (idle / dirty / saved)

`SharedGoalModal` 의 `saveStatus` 패턴을 그대로 차용:

| 밴드    | 타일 배경                                     | 저장 버튼 상태                                  | 스크린리더                             |
| ------- | --------------------------------------------- | ----------------------------------------------- | -------------------------------------- |
| idle    | `--task-commit-tile-bg-selected` cyan 옅은 틴트 | "변경 없음" — disabled                           | 낭독 없음                              |
| dirty   | `--task-commit-tile-bg-editing` amber 옅은 틴트 | "저장" — `--shared-goal-modal-confirm-bg` emerald | 타일 aria-pressed 토글 시 1회 낭독     |
| saved   | `--task-commit-tile-bg-saved` emerald 옅은 틴트(160ms 플래시 후 idle 로 복귀) | "저장됨 ✓" — 160ms 후 disabled | `role="status"` 로 "커밋 전략이 태스크마다 로 저장되었습니다" 1회 낭독 |

---

## 2. CollabTimeline 의 task-commit 이벤트 배지

`CollabTimeline.tsx` 는 기존 handoff/report 2종 행을 렌더한다. 여기에 **task-commit** 과
**task-commit-queued** 두 새로운 행 종류를 추가한다. DOM 구조는 기존 `<li>` 와 동일하게 유지하되,
`data-event-kind` 속성으로 구분.

### 2.1 task-commit 행 레이아웃 (완료)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ◈ 14:23  Thanos → main                        COMMIT ● done                      │
│   ▸ a1b2c3d  [feat] 결제 토큰 검증 라우터 스켈레톤 추가 …                           │
│   ↳ 파일 6개 변경 · +247 / −12  [📋 해시 복사]  [🔗 diff 보기]                        │
└──────────────────────────────────────────────────────────────────────────────────┘
```

| 요소               | 규격                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------ |
| 글리프             | `◈` (커밋 — handoff/report 의 ○◔●⊘ 와 충돌 없음)                                       |
| 글리프 색         | `--task-commit-event-glyph-fg` (= `--shared-goal-modal-confirm-bg` emerald)           |
| 시각               | `HH:MM` 24시간제. 기존 handoff 행과 동일 포맷                                           |
| 작성자 → 브랜치     | `Thanos → main` (from = 에이전트 이름, to = 타깃 브랜치). 호버 시 `onHoverAgent(from)` |
| 단축 해시          | 앞 7자 `a1b2c3d`. 폰트 `monospace`. 색 `--task-commit-hash-fg` (cyan)                   |
| 메시지             | 72자 말줄임. 색 `--task-commit-message-fg` (white/85%)                                  |
| 보조 라인          | 파일 수·`+/-` 라인 수. 색 `--task-commit-meta-fg` (white/55%)                           |
| 복사 버튼          | `📋 해시 복사` — 클릭 시 전체 해시 클립보드 복사 + toast `info 2s "해시가 복사되었습니다"`  |
| diff 버튼          | `🔗 diff 보기` — 새 탭으로 원격 커밋 URL 오픈                                            |
| 전체 행 테두리     | `border-l-2` · 색 `--task-commit-row-border` (= emerald 35%)                         |

### 2.2 task-commit-queued 행 레이아웃 (F4 폴백 중 큐잉)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ◇ 14:23  Thanos → main                         COMMIT ○ queued                   │
│   ▸ (아직 해시 없음)  [feat] 결제 토큰 검증 라우터 스켈레톤 추가 …                   │
│   ↳ 읽기 전용 모드 해제 후 자동 기록 예정 · 큐 순번 3/5                                │
└──────────────────────────────────────────────────────────────────────────────────┘
```

| 요소               | 규격                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------ |
| 글리프             | `◇` (빈 다이아몬드 — "아직 실체가 없음")                                               |
| 글리프 색         | `--task-commit-queued-glyph-fg` (= readonly strip white/45%)                          |
| 라벨               | `queued` (소문자). handoff 행의 `open/wip/done/blocked` 와 나란히 배치해도 겹치지 않음 |
| 해시 자리          | `(아직 해시 없음)` — 이탤릭, 색 `--task-commit-meta-fg`                                 |
| 메시지             | 기존 task-commit 과 동일 포맷(서버에서 미리 계산된 임시 메시지)                         |
| 보조 라인          | `읽기 전용 모드 해제 후 자동 기록 예정 · 큐 순번 N/M`                                   |
| 전체 행 테두리     | `border-l-2` · 색 `--task-commit-queued-row-border` (readonly strip)                   |
| 복사/diff 버튼      | **숨김** — 아직 해시가 없으므로 존재하면 오작동 원인                                   |
| 애니메이션         | **없음** — pulse/shimmer 넣지 않는다. 큐잉됨은 "멈춰 있는 상태", 조바심 유도 금지(C-06). |

### 2.3 행 종류 판별 (CollabTimeline 확장 힌트)

기존 `buildTimelineRows(entries, filter)` 는 handoff/report 2종만 처리한다. 본 시안은 `LedgerEntry`
에 `kind` 필드를 추가하는 방향이 아니라 **별도의 CommitEntry 스트림** 을 parallel 로 받아 시간순
머지하는 것을 권장:

```ts
interface CommitTimelineEntry {
  kind: 'task-commit' | 'task-commit-queued';
  at: string;                  // ISO
  author: string;              // 에이전트 이름
  branch: string;              // 타깃 브랜치
  hash?: string;               // queued 시 undefined
  shortHash?: string;          // 7자. queued 시 undefined
  message: string;             // 72자 말줄임 전의 원문
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  queueOrder?: { position: number; total: number }; // queued 전용
  diffUrl?: string;            // 원격 커밋 URL
}
```

`CollabTimeline.tsx` 는 기존 `entries` prop 과 별도의 `commitEvents` prop 을 받고, 둘을 `at` 기준
병합 정렬해 한 `<ul>` 에 렌더한다. 필터 칩에는 기존 `all/open/wip/done/blocked` 에 더해 **`commit`**
칩 하나만 추가(`queued` 는 별도 필터 없이 commit 아래로 포함).

---

## 3. 클립보드 복사 버튼 인터랙션

C-04 의 "해시는 전체" 원칙을 UX 수준까지 보장한다.

### 3.1 기본 동작

1. 사용자가 `📋 해시 복사` 클릭 → `navigator.clipboard.writeText(entry.hash)` 호출.
2. 성공 시 버튼 텍스트가 120ms 동안 `✓ 복사됨` 으로 바뀌고 `role="status" aria-live="polite"`
   리전에 "해시가 복사되었습니다" 1회 낭독.
3. `useToast().push({ variant: 'info', title: '해시가 복사되었어요', duration: 2000 })` 로 통합 토스트
   띄우기는 **선택** — 시안에서는 끄고 버튼 자체의 피드백만 기본값으로 둔다(토스트 소음 방지).

### 3.2 실패 케이스

- `navigator.clipboard` 미지원 브라우저: execCommand copy 로 폴백 후 동일하게 성공 처리.
- 권한 거부: `useToast().push({ variant: 'warning', title: '클립보드 접근이 차단되었습니다',
  description: '브라우저 설정에서 권한을 허용하거나 해시를 직접 선택해 주세요.' })` 1회.
- 보안 문맥(HTTP) 에서 `clipboard.writeText` 가 throw: 성공 처리하지 않고 동일 warning 토스트.

### 3.3 접근성

| 속성                | 값                                                            |
| ------------------- | ------------------------------------------------------------- |
| `aria-label`        | `"커밋 해시 a1b2c3d… 전체를 클립보드에 복사"`                     |
| `aria-describedby`  | 복사 직후 `role="status"` 리전 연결(1회 낭독 후 요소는 유지)    |
| 키보드              | 포커스 후 `Enter`/`Space` 로 실행                                |
| data 속성           | `data-copy-target="commit-hash"` — QA 가 색·문구 변경 없이 훅  |

---

## 4. 커밋 메시지 미리보기 · 전체보기

### 4.1 한 줄 미리보기 (72자)

- 폰트 `var(--font-kr)` (Pretendard) · `word-break: keep-all` · `text-overflow: ellipsis`
- 72자 + `…` 으로 잘라낸다. 이모지·한자 1자를 2자로 계산(폰트 메트릭 기준).
- 행 호버 시 **아래쪽 툴팁** 이 아니라 **행 자체가 확장** (max-height 0 → 120px 트랜지션 220ms).
  이유: 위로 뜨는 툴팁은 스크롤 아래 행에서 잘릴 수 있고, 타임라인 목록 전체가 부드럽게 밀리는
  편이 리뷰어의 맥락을 덜 끊는다.
- `prefers-reduced-motion: reduce` 에서는 확장 없이 전체 메시지를 `<pre>` 로 즉시 표시.

### 4.2 전체 메시지 구조 (예)

```
[feat] 결제 토큰 검증 라우터 스켈레톤 추가

- POST /api/payments/validate 에 HMAC 헤더 확인 추가
- server.ts 의 라우트 등록 순서 정리
- tests/payments.regression.test.ts 1건 추가 통과

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

첫 줄(타이틀) 만 미리보기에 노출. 두 번째 줄부터는 확장 영역에서 `word-break: keep-all` 로
그대로 렌더한다. 서명 라인(`Co-Authored-By: …`) 은 `color: --task-commit-signature-fg` (white/45%)
로 한 단계 흐리게.

---

## 5. F4 폴백 동안 큐잉됨 상태 — 토스트 톤 일관화

### 5.1 상태 전이 타임라인

```
F1 active  (자동 커밋 정상)
   ↓  자동 개발 중 F4 진입(예: 구독 토큰 만료)
F4 readonly + commit queue 쌓임
   • task-commit 발생 시도마다 서버가 queue 에 보관
   • CollabTimeline 에는 task-commit-queued 행이 즉시 추가됨(queueOrder.position 자동 증가)
   ↓  사용자가 재충전·재인증 → F1 복귀
F1 active + queue 일괄 해소
   • 서버가 queue 순서대로 실제 커밋을 생성(atomic; 실패 시 해당 지점에서 중단)
   • 각 task-commit-queued 행이 task-commit 행으로 "전이 플래시" 와 함께 바뀜
   • 마지막에 `success` 토스트 1회(C-07)
```

### 5.2 Queued 행의 플래시 전이 (큐잉됨 → 완료)

- 각 행이 해소되는 순간: 좌측 테두리 색이 `readonly-strip` (회색) → `confirm-bg` (emerald) 로
  160ms 교차 페이드.
- 동시에 글리프 `◇` → `◈` 로 **DOM 교체**. 애니메이션이 아닌 즉시 스왑이어야 스크린리더가
  "완료로 바뀌었다" 를 정확히 포착.
- `aria-live="polite"` 로 행당 1회 "a1b2c3d… 커밋이 기록되었습니다" 가 낭독되지만, 다수 해소
  시 과도한 낭독을 막기 위해 §5.3 의 요약 토스트 1회가 대신.

### 5.3 토스트 톤 고정

| 상황                                           | variant | 제목                                              | duration | 조건                              |
| ---------------------------------------------- | ------- | ------------------------------------------------- | -------- | --------------------------------- |
| F4 진입 직후 첫 큐잉 발생                      | info    | 자동 커밋이 잠시 보류됩니다                        | 4000ms   | 큐 크기 1 → 2 로 전이 시 1회       |
| 큐 크기가 5 이상으로 누적                      | info    | 큐에 5건이 대기 중                                  | 4000ms   | 5·10·20 …에서 1회씩(지수 백오프)   |
| F1 복귀 직후 큐 일괄 해소 시작                  | info    | 대기 중이던 커밋을 기록 중입니다                    | 4000ms   | F4 → F1 전이 직후 1회              |
| 큐 전부 해소 완료                              | success | 📦 N건의 커밋이 순차 기록되었습니다                 | 3000ms   | C-07 — 행 단위 낭독 대체            |
| 큐 해소 중 일부 실패(충돌·네트워크)            | error   | 큐 일부 기록에 실패했습니다                         | 0(무기한) | 실패 지점 전까지만 기록, 실패 이후는 다시 queued 상태로 유지 |

**토스트 규약**:
- 모든 토스트의 action 버튼은 **`자세히 보기`** — `CollabTimeline` 으로 스크롤 + `filter=commit` 으로
  자동 설정.
- info/success 의 본문은 `--toast-subtle-fg`. error 본문은 `--toast-error-title-fg`.
- F4 영구 배너가 떠 있는 동안 info 토스트 가 새로 나올 수 있지만, 영구 배너의 높이(40px) 바로
  아래부터 쌓이도록 `--toast-safe-top` 을 동적으로 `72px + 40px = 112px` 로 조정(신규 토큰 §6.4).

### 5.4 CollabTimeline 배지의 "큐잉됨" 카피

- 행 본문: `읽기 전용 모드 해제 후 자동 기록 예정`
- 큐 순번: `큐 순번 3/5` (현재/총합) — 공백 2개 기준 정렬
- 행 호버 툴팁: `토큰이 복구되면 자동 실행됩니다. 수동 재시도는 [Git 자동화 패널 → 큐 관리]에서 가능합니다.`

**카피 금지**: "실패", "중단", "오류", "경고", "지연" 같은 단어. F4 폴백 본문에서 이미 "읽기
전용" 이라는 상황 어휘를 쓰고 있으므로, 큐잉됨 자체는 **정상 경로의 일시 보류** 로 표현.

---

## 6. index.css 토큰 추가안

### 6.1 라디오 타일

| 토큰                                              | 값                                              | 용도                                                  |
| ------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| `--task-commit-tile-min-width`                    | `288px`                                         | 세 옵션 타일의 최소 너비                                |
| `--task-commit-tile-min-height`                   | `88px`                                          | 설명 3줄이 들어갈 수 있는 최소 높이                     |
| `--task-commit-tile-gap`                          | `8px`                                           | 타일 사이 세로 간격                                    |
| `--task-commit-tile-padding`                      | `12px 16px`                                     |                                                       |
| `--task-commit-tile-radius`                       | `6px`                                           | `--shared-goal-modal-radius` 보다 작게(하위 요소 느낌)  |
| `--task-commit-tile-border`                       | `var(--shared-goal-modal-field-border)`         | 비선택 타일 테두리(white/18%)                           |
| `--task-commit-tile-border-hover`                 | `var(--shared-goal-modal-field-focus)`          | 호버 cyan                                              |
| `--task-commit-tile-border-selected`              | `var(--shared-goal-modal-field-focus)`          | 선택 cyan                                              |
| `--task-commit-tile-bg-selected`                  | `rgba(127, 212, 255, 0.08)`                     | 선택 배경(= banner-bg 와 같은 계열)                   |
| `--task-commit-tile-bg-editing`                   | `rgba(251, 191, 36, 0.06)`                      | 변경 후 미저장                                         |
| `--task-commit-tile-bg-saved`                     | `rgba(52, 211, 153, 0.08)`                      | 저장 직후 160ms 플래시 후 idle 로 복귀                  |
| `--task-commit-radio-size`                        | `16px`                                          | 라디오 원 지름                                         |
| `--task-commit-radio-border`                      | `rgba(255, 255, 255, 0.40)`                     | 라디오 원 비선택 테두리                                |
| `--task-commit-radio-dot-fg`                      | `var(--shared-goal-modal-field-focus)`          | 선택 라디오 점(cyan)                                   |
| `--task-commit-icon-fg`                           | `var(--shared-goal-modal-field-focus)`          | 옵션 아이콘 색 통일                                    |

### 6.2 타임라인 task-commit 행

| 토큰                                              | 값                                              | 용도                                                  |
| ------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| `--task-commit-event-glyph-fg`                    | `var(--shared-goal-modal-confirm-bg)`           | `◈` 글리프 emerald                                     |
| `--task-commit-row-border`                        | `rgba(52, 211, 153, 0.35)`                      | 좌측 2px 테두리                                         |
| `--task-commit-hash-fg`                           | `var(--token-usage-axis-input-fg)`              | 단축 해시 cyan(입력 축과 같은 hue — "원본" 은유)       |
| `--task-commit-message-fg`                        | `rgba(255, 255, 255, 0.85)`                     | 메시지 타이틀                                          |
| `--task-commit-meta-fg`                           | `rgba(255, 255, 255, 0.55)`                     | 파일 수·라인 수                                        |
| `--task-commit-signature-fg`                      | `rgba(255, 255, 255, 0.45)`                     | Co-Authored-By 서명 라인 한 단계 더 흐림                |
| `--task-commit-copy-btn-fg`                       | `rgba(255, 255, 255, 0.80)`                     | 복사 버튼 기본                                         |
| `--task-commit-copy-btn-hover-bg`                 | `rgba(255, 255, 255, 0.06)`                     | 복사 버튼 hover 배경                                  |
| `--task-commit-copy-btn-success-fg`               | `var(--shared-goal-modal-confirm-bg)`           | `✓ 복사됨` 120ms 플래시 색                             |
| `--task-commit-row-expand-duration`               | `220ms`                                         | 행 호버 확장 애니메이션                                |
| `--task-commit-row-expand-height-max`             | `120px`                                         | 확장 최대 높이(메시지 본문 + 메타)                     |

### 6.3 task-commit-queued 행

| 토큰                                              | 값                                              | 용도                                                  |
| ------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| `--task-commit-queued-glyph-fg`                   | `var(--token-fallback-readonly-strip)`          | `◇` 회색 다이아몬드(F4 동일 계열)                     |
| `--task-commit-queued-row-border`                 | `var(--token-fallback-readonly-strip)`          | 좌측 2px 테두리(F4 동일 계열)                         |
| `--task-commit-queued-label-fg`                   | `var(--token-fallback-readonly-fg)`             | `queued` 라벨 흰색/80%                                 |
| `--task-commit-queued-meta-fg`                    | `var(--token-fallback-readonly-fg)`             | "큐 순번 N/M" 카피                                     |
| `--task-commit-queued-resolve-flash-ms`           | `var(--token-fallback-recover-flash-ms)`        | 해소 시 emerald 플래시 160ms(=F4 복귀 플래시와 동일)   |

### 6.4 토스트 안전 영역 보강(F4 공존 시)

| 토큰                                              | 값                                              | 용도                                                  |
| ------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| `--toast-safe-top-with-fallback-banner`           | `calc(var(--toast-safe-top) + var(--token-fallback-banner-height))` | F4 영구 배너가 떠 있는 동안 토스트 최상단 오프셋 동적 덮어쓰기 |

구현 팁: `ToastProvider` 가 `document.documentElement.dataset.fallback === 'F4'` 을 관찰하고
`--toast-safe-top` 을 inline style 로 위 토큰 값으로 교체. 전역 선언 변경은 불필요.

---

## 7. 접근성 · 키보드

| 요소                    | 키 / 속성                                                   |
| ----------------------- | ----------------------------------------------------------- |
| 라디오 그룹             | `role="radiogroup" aria-labelledby="task-commit-strategy-heading"` |
| 라디오 타일             | `role="radio" aria-checked` · `↑/↓` 순환 · `Tab` 은 그룹 진입/이탈 |
| 선택 변경 낭독          | `role="status" aria-live="polite">커밋 전략이 ... 로 변경되었습니다` 1회 |
| 저장 버튼               | `data-focus-tone="success"` + `aria-keyshortcuts="Ctrl+S"` |
| 커밋 행 접근성          | 기존 CollabTimeline 의 `role="button"` 패턴 유지 · aria-label 에 "커밋 a1b2c3d, [메시지 타이틀], 파일 6개 변경" 한 번에 |
| 해시 복사 버튼          | `aria-label="커밋 해시 a1b2c3d 전체를 클립보드에 복사"`       |
| 큐잉됨 행               | `aria-label` 에 "큐잉됨, 큐 순번 3 중 5" 포함                  |
| 축소 모션               | 행 확장·저장 플래시 전부 120ms opacity 로 단축               |

---

## 8. 회귀 방지 체크리스트 (QA 복사용)

- [ ] 세 옵션이 세로로 쌓여 각 타일 전체가 클릭 가능하다(라디오 원 영역만 클릭 가능하면 결함).
- [ ] `↑/↓` 방향키로 옵션이 순환한다. `Tab` 은 그룹 하나로 취급.
- [ ] 선택 시 타일 테두리 cyan · 배경 옅은 cyan 틴트로 전환.
- [ ] 변경 후 미저장 상태에서 저장 버튼 활성화, amber 타일 배경.
- [ ] 저장 직후 emerald 플래시 160ms 후 idle cyan 으로 복귀.
- [ ] CollabTimeline 에 `◈` (완료) / `◇` (큐잉됨) 글리프가 기존 `○◔●⊘` 와 겹치지 않는다.
- [ ] 해시 복사 클릭 시 전체 해시가 클립보드로 들어가고 `✓ 복사됨` 120ms 플래시 표시.
- [ ] F4 진입 직후 첫 큐잉은 `info` 토스트 4s 1회 · 이후 같은 건별 반복 토스트 없음.
- [ ] F1 복귀 후 큐 일괄 해소 완료 시 `success` 3s 1회만 낭독 (행 단위 반복 낭독 없음).
- [ ] F4 배너가 떠 있는 동안 토스트가 배너 아래부터 쌓여 배너를 가리지 않는다.
- [ ] `prefers-reduced-motion: reduce` 경로에서 행 확장·emerald 플래시 모두 opacity 120ms 로만.
- [ ] 큐잉됨 행의 복사·diff 버튼은 **숨김**(해시가 없으므로 오작동 원인).

---

## 9. 구현 메모 (Kai 인계용)

1. **신규 컴포넌트**: `src/components/TaskCommitStrategyField.tsx`. props:
   ```ts
   interface Props {
     value: 'per-task' | 'on-goal-done' | 'manual';
     saveStatus: 'idle' | 'dirty' | 'saved';
     onChange(next: Props['value']): void;
     onSave(): void;
     readonlyMode?: boolean;  // F4 일 때 true → 편집 가능하되 저장 시 큐잉 안내 토스트
   }
   ```
2. **CollabTimeline 확장**: `commitEvents?: ReadonlyArray<CommitTimelineEntry>` 추가. 내부에서
   기존 entries 와 `at` 기준 병합 정렬. 필터 칩에 `commit` 추가.
3. **큐 관리 UI**: 본 시안에서는 상세 규격 생략. Git 자동화 패널에 "큐 N건" 탭 추가는 후속
   라운드.
4. **클립보드 폴리필**: `src/utils/copyToClipboard.ts` (신규) — `navigator.clipboard` → `execCommand`
   순 폴백 1함수.
5. **회귀 테스트**: `tests/taskCommitStrategyField.regression.test.ts` ·
   `tests/collabTimelineCommitRow.regression.test.tsx` 두 신규 파일로 "3옵션 변경·저장 · 행 렌더·
   복사 동작 · 큐잉 해소 전이 플래시" 를 잠근다.
6. **시각 연속성**: 본 시안의 모든 토큰은 `--shared-goal-modal-*`·`--token-fallback-*`·
   `--token-usage-*` 와 숫자 공유. 디자인 감사 시 "같은 색 = 같은 의미" 가 깨지지 않는지 grep
   1번으로 확인 가능.
