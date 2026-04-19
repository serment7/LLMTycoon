# GitAutomationPanel · 브랜치 전략 선택 UI 로딩/스켈레톤 시안 (2026-04-19)

대상 컴포넌트: `src/components/GitAutomationPanel.tsx`
참조 토큰: `src/index.css` 의 `--git-automation-loading-*` 계열 (신규 · 본 문서와 함께 선도입)
관련 회귀 잠금: `tests/gitAutomationPanel.regression.test.tsx` (후속 PR 에서 L1~L4 케이스 추가 예정)
우선 검토 기준: `tests/claudeTokenUsagePersistenceTruncate.regression.test.ts` 와 동일한
  "순수 상태 축을 먼저 고정하고, DOM 효과는 시안 문서로 분리한다" 패턴 준수
인계 대상: 개발자 Thanos

## 1. 재설계 배경

### 1.1 현재 증상

`GitAutomationPanel` 은 `initial` prop 이 비동기로 도착한다(프로젝트 관리 탭의
`loadGitAutomationSettings` → 서버 라운드트립, 평균 240–520ms). 그 사이 패널의
브랜치 전략 라디오(4전략 fieldset · 2모드 시안 A안) 는 **기본값(`per-session` / `new`)**
으로 먼저 렌더되어 아래 두 혼란을 유발한다.

1. **가짜 선택 상태** — 사용자가 직전 세션에서 `fixed-branch` 를 저장했더라도,
   첫 프레임에서는 `per-session` 라디오가 선택된 것처럼 보인다. 이 상태가
   240ms 이상 유지되면 사용자가 "설정이 날아갔나?" 하고 재선택하는 실수가 난다
   (1587ea9 이후 하이드레이션 레이스는 해소됐으나, **로드 중이라는 사실 자체가
   화면에 드러나지 않는** 문제는 남아 있다).
2. **포커스 빼앗김** — 로드가 끝나 `baseline` 이 갱신되면 `useEffect` 복원 훅이
   `setBranchStrategyChoice(baseline.branchStrategy)` 를 호출한다. 라디오 그룹 내부
   포커스가 첫 번째 입력으로 튕기는 케이스가 실측된다(키보드 사용자 4/5명 보고).

### 1.2 해결 방향

- "로드 중" 구간을 **명시적 스켈레톤 + 보조 문구** 로 가리고, 로드 완료 시에만
  실제 라디오가 페이드 인 되도록 한다.
- 라디오 그룹의 **포커스 링은 스켈레톤 ↔ 실제 UI 전환 과정에서도 시각적 연속성**
  을 유지한다(동일한 테두리 굵기·오프셋·색 토큰 사용).
- 모션은 `prefers-reduced-motion` 에서 즉시 정적 전환으로 대체.

본 시안은 위 3원칙을 고정하고, 실제 `isLoaded` 플래그를 `GitAutomationPanel` 에
심는 작업은 후속 PR 로 분리한다(렌더 회귀 방지 · 4전략 A/B 정리와 순서 충돌 방지).

## 2. 상태 축

| 상태        | 트리거                                              | 화면 | 보조 문구(aria-live=polite)           |
|-------------|------------------------------------------------------|------|----------------------------------------|
| `loading`   | `initial === undefined` 또는 `initial === null`      | 스켈레톤 4줄 + 라벨 자리 표시자          | "설정을 불러오는 중…"                 |
| `hydrated`  | `initial` 객체 수신 직후(baseline 재계산 tick)       | 실제 라디오 · 0.18s 페이드 인            | "설정을 불러왔습니다." (1회만 알림)   |
| `error`     | 로드 promise 가 reject (예: 401 · 500)              | 라디오는 기본값 유지 + 오류 배너         | "설정을 불러오지 못해 기본값을 사용합니다." |

`error` 는 본 시안의 주 범위가 아니나, `--git-automation-loading-error-*` 토큰
한 짝을 함께 잠가 뒤 PR 에서 추가 구현 시 토큰 중복 정의를 막는다.

## 3. 레이아웃

### 3.1 loading (스켈레톤)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 🌿 브랜치 전략                                 설정을 불러오는 중…   ⏳ │
├──────────────────────────────────────────────────────────────────────────┤
│  ░░░░░░░░░░░░░░░░░░░   ░░░░░░░░░░░░░░░░░░░   ░░░░░░░░░░░░░░░░░░░      │
│  ░░░░░░░░░░░░           ░░░░░░░░░░░░          ░░░░░░░░░░░░           │
│                                                                          │
│  브랜치 이름 패턴                                                        │
│  [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]                │
└──────────────────────────────────────────────────────────────────────────┘
```

- 스켈레톤 블록(`░`) 은 `--git-automation-loading-skeleton-bg` 와
  `--git-automation-loading-skeleton-highlight` 사이를 1.4s 동안 수평 이동하는
  shimmer 로 표현. 이동 방향은 왼→오른(문맥 읽는 방향과 동일).
- 오른쪽 상단 "설정을 불러오는 중…" 배지는 `aria-live=polite` 영역에 들어간다.
  시각적으로는 `--git-automation-loading-hint-fg` + 작은 `Loader2` 스피너(기존
  `lucide-react` 아이콘 재사용, `animate-spin`).
- 라디오 자리에는 **실제 라디오와 동일한 높이(44px)** 의 박스를 두어, 전환 시
  패널 전체 높이가 튀지 않도록 고정한다.

### 3.2 hydrated (로드 완료)

- `data-loading="0"` 으로 바뀌는 순간 `.git-automation__field` 전체에
  `--git-automation-loading-fade-duration` (0.18s) 동안 `opacity: 0 → 1`,
  `transform: translateY(2px) → 0` 페이드 인. 스켈레톤은 같은 프레임에서
  `display: none` 이 아니라 `opacity: 0` 으로 선-처리 후 언마운트 → 깜빡임 방지.
- 포커스 링 토큰(`--git-automation-loading-focus-ring`) 은 스켈레톤과 라디오
  양쪽 모두 동일 값을 참조. 라디오 그룹 내부에 포커스가 있었다면 그대로 유지된다
  (스켈레톤 측의 가상 포커스 타겟을 같은 `tabindex` 순서로 깔아 놓기 때문).

### 3.3 error (기본값 + 배너)

- 라디오는 `per-session` 기본값으로 즉시 표시(사용자가 막힘 없이 진행 가능).
- 상단 `.git-automation__load-error` 배너: `--git-automation-loading-error-*`
  토큰 사용. 문구는 §4 에 고정.

## 4. 마이크로카피(한국어 고정)

| 위치                | 문구                                           | 비고                          |
|---------------------|------------------------------------------------|-------------------------------|
| 로딩 배지           | `설정을 불러오는 중…`                          | 말줄임표 `…` 은 U+2026 고정    |
| 스크린리더 알림(1회) | `설정을 불러왔습니다.`                         | `aria-live=polite`, 중복 금지  |
| 오류 배너(짧은 형)  | `설정을 불러오지 못했습니다.`                  | 1행                           |
| 오류 배너(보조 설명)| `기본값으로 표시 중입니다. 잠시 후 다시 시도해 주세요.` | muted 톤               |
| 스켈레톤 `aria-label` | `브랜치 전략 설정을 불러오는 중`              | 전체 그룹 레벨                |

**왜 "설정을 불러오는 중" 인가** — 이 구간의 혼란은 *값이 비어 있다* 가 아니라
*어떤 값이 맞는지 아직 모르겠다* 이다. "로딩 중" 은 네트워크 관점, "불러오는 중"
은 사용자 관점. 사용자 관점 어휘를 고른다.

## 5. 신규 CSS 토큰(선도입 완료)

`src/index.css` 에 본 시안과 동시에 추가된 토큰 블록. 본 PR 에서는 컴포넌트에
연결하지 않고 정의만 선도입 — 후속 PR 에서 JSX 에 클래스·`data-loading` 속성만
달면 바로 시각 스펙이 적용된다.

- `--git-automation-loading-skeleton-bg`
- `--git-automation-loading-skeleton-highlight`
- `--git-automation-loading-skeleton-radius`
- `--git-automation-loading-shimmer-duration`
- `--git-automation-loading-hint-fg`
- `--git-automation-loading-hint-bg`
- `--git-automation-loading-fade-duration`
- `--git-automation-loading-focus-ring`
- `--git-automation-loading-focus-ring-offset`
- `--git-automation-loading-error-bg`
- `--git-automation-loading-error-border`
- `--git-automation-loading-error-fg`

색 선택 근거 — `--git-alert-not-triggered-*`(amber) 와 의도적으로 **다른** 채도의
slate-blue 를 썼다. "경고/주의" 가 아니라 "중립 · 준비중" 이라는 의미 차이를
색 단계에서 드러내기 위함. amber 를 재사용하면 로드 지연이 마치 경고처럼 보인다.

## 6. 상호작용 규칙

1. **로딩 → 하이드레이션** : 스켈레톤 페이드 아웃(0.12s) → 라디오 페이드 인
   (0.18s). 두 단계를 겹쳐 total 0.22s 이내로 맞춘다(사람 지각 한계 ≈ 250ms).
2. **포커스 보존** : 스켈레톤이 포커스를 가질 수 있도록 `tabindex="0"` 인 가상
   wrapper 를 두되, 로드 완료 시 `programmaticFocus` 를 실제 라디오 중 하나
   (마지막 저장 값에 해당하는 것) 로 이관. 이관 실패 시 첫 라디오 fallback.
3. **모션 감소** : `prefers-reduced-motion: reduce` 에서 shimmer / 페이드 모두
   중단. 스켈레톤은 정적 회색, 전환은 즉시 교체(`opacity` 전환 시간 0).
4. **지연 임계** : 2.5s 이상 로드가 지속되면 배너가 "네트워크가 느립니다.
   잠시만 기다려 주세요." 로 교체(후속 PR 범위).

## 7. QA 체크리스트(L1~L4 · 후속 회귀 테스트 예정)

| ID | 시나리오                                               | 기대 동작                                    |
|----|--------------------------------------------------------|----------------------------------------------|
| L1 | `initial === undefined` 로 렌더                        | 스켈레톤 + "설정을 불러오는 중…" 배지 노출  |
| L2 | `initial` 이 뒤늦게 도착(250ms 후)                     | 페이드 인 · 라디오 선택값이 저장값과 일치    |
| L3 | 로드 promise reject                                     | 기본값 라디오 + 오류 배너 표시                |
| L4 | `prefers-reduced-motion: reduce`                       | shimmer/페이드 없음, 정적 교체                |

본 케이스는 `tests/gitAutomationPanel.regression.test.tsx` 에 삽입 예정이며,
본 시안 PR 에서는 **회귀 테스트를 추가하지 않고** 시안 문서와 토큰만 선도입한다
(`claudeTokenUsagePersistenceTruncate.regression.test.ts` 가 순수 함수 축을
먼저 고정하고 DOM 부수 효과는 분리했던 리듬과 일치).

## 8. 롤백 경로

본 PR 은 문서 1개 + CSS 토큰 블록만 추가한다. 롤백은 두 변경만 되돌리면 되며,
`GitAutomationPanel.tsx` 와 기존 회귀 테스트는 손대지 않아 리스크가 낮다.
