# GraphResetButton · '그래프 초기화' 버튼 비주얼 시안 (2026-04-19)

대상 위치: `src/App.tsx` L1353~L1367 의 좌측 사이드바 하단 `.mt-auto pt-4 space-y-3` 툴바.
형제 버튼: 위 '에이전트 고용'(accent=cyan / 긍정) · 아래 '긴급중단'(red / 위험).
시안 이미지: `tests/graph-reset-button-mockup.svg` (3버튼 툴바 레이아웃 + 상태 4종)
디자인 토큰: `src/index.css` 의 `--graph-reset-*` 계열 (신규 추가).
우선 검토 파일: `src/components/LogPanelTabs.tsx` — 본 버튼 클릭 시 `logs` 탭으로 강제 전환 후
사용자에게 "그래프 캔버스가 초기 상태로 복원됨" 로그 라인을 노출할 수 있게 탭 전환 훅을
열어 둔다(후속 구현).

## 1. 위치와 의미 계층

세 버튼은 "에이전트 플릿의 생애주기" 를 왼쪽 아래에 수직 나열한 단일 축이다.

| # | 라벨 | 의미 | 톤 | 색 계열 |
|---|------|------|----|--------|
| 1 | 에이전트 고용 | **플릿 확장** — 새 멤버 추가. | 긍정 | accent / cyan (`--pixel-accent`) |
| 2 | **그래프 초기화** | **캔버스 복구** — 위치/팬/줌만 초기화, 에이전트·작업은 보존. | 중립~경고 | secondary / amber (`--graph-reset-*`) |
| 3 | 긴급중단 | **전체 정지** — 모든 에이전트 작업을 즉시 멈춤. | 위험 | red (#c23b4a) |

중립~경고 톤을 선택한 이유:
- '에이전트 고용'(긍정) 과 '긴급중단'(위험) 사이에서 **눈이 미끄러지지 않게** 중간 채도를 준다.
  완전 중립(흰/회)은 두 형제 사이에 묻혀 "비활성처럼" 보이고, 반대로 빨강 계열은 '긴급중단' 과
  의미 충돌을 일으킨다.
- amber 는 기존 프로젝트의 "되돌림/경고·미저장" 맥락(`--shared-goal-border-editing`,
  `--git-alert-not-triggered-fg`) 과 이미 짝을 이루고 있어, 학습된 팔레트를 그대로 이어 쓴다.
- "파괴적이지만 되돌릴 수 있는 행동(Ctrl+Z 가능)" 에 어울리는 **반사적 경고** 색. 빨강은
  "되돌릴 수 없음" 의 최상위 위험에 예약해 둔다.

## 2. 버튼 단독 스펙

### 2.1 구조 (HTML)

```html
<button
  type="button"
  onClick={resetGraph}
  title="캔버스 위치·줌만 초기 상태로 되돌립니다. 에이전트·작업 이력은 보존됩니다."
  aria-label="그래프 초기화 — 캔버스 위치와 줌만 복원"
  className="graph-reset-btn"
>
  <span className="graph-reset-btn__icon" aria-hidden="true">↺</span>
  <span className="graph-reset-btn__label">그래프 초기화</span>
</button>
```

- 너비: `w-full` (형제 2개와 동일 flex 항목).
- 높이: 형제 `py-3` 와 동일한 44px 내부 클릭 영역(터치 타깃 ≥ 44×44).
- 글자: `font-bold uppercase` 그대로 (형제와 동일한 픽셀 톤 유지).
- 하단 2px 강조선(`border-b-2`) 은 형제 2개의 `border-b-4` 와 대비해 **한 단계 낮은 무게**
  를 준다 — 중간 위계를 두께로도 표현한다.

### 2.2 아이콘 배치

| 위치 | 값 | 근거 |
|------|----|------|
| 좌측 내부 여백 | `12px` | 형제 버튼의 텍스트 좌측 여백과 시각적으로 정렬 |
| 아이콘 글리프 | `↺` (U+21BA · ANTICLOCKWISE OPEN CIRCLE ARROW) | "되돌림" 을 가장 직관적으로 전달 |
| 대체(CC) | `RotateCcw` 14px (lucide-react) | 구현 시 SVG 로 승격 권장 — 글리프보다 테두리 정렬이 안정적 |
| 크기 | `14×14px` | 라벨 높이(11~12px)와 baseline 맞춤 |
| 라벨과의 간격 | `8px` | 아이콘·글자 묶음이 한 덩어리로 읽히도록 |

- 🗑 (휴지통) 계열은 **거부**. 에이전트·작업을 **지우지 않기** 때문에 휴지통은 오해를 만든다.
  이 버튼은 "위치·줌 초기화" 이므로 회귀(undo/reset) 글리프가 정확하다.
- 아이콘·라벨 묶음은 `justify-content: center` 로 중앙 정렬. 좌정렬을 취하지 않는 이유:
  형제 2개(`에이전트 고용` · `긴급중단`) 가 **텍스트 중앙정렬** 이라 축이 어긋난다.

### 2.3 상태 정의

```
┌─────────────────────────────────────────────────────────────┐
│  상태     │ 배경               │ 테두리 하단        │ 글자  │
├─────────────────────────────────────────────────────────────┤
│  default  │ #3a3150 (slate)    │ #e0a200 (amber)   │ amber │
│  hover    │ #4a3e6a            │ #fbbf24           │ #fff  │
│  active   │ #2a2540 (눌림)     │ #c48700 (어두움)  │ amber │
│  focus    │ default + 2px ring │ #00d2ff outline   │ amber │
│  disabled │ #2a2a3d 40%        │ rgba(255,255,255,.1) │ white/35% │
└─────────────────────────────────────────────────────────────┘
```

#### default (기본)

- 배경: `--graph-reset-bg` (`#3a3150`) — 형제 배경(cyan / red) 대비 **중간 명도** 의 차콜-보라.
  형제보다 채도를 낮춰 중립 축을 만든다.
- 테두리 하단: `--graph-reset-border` (`#e0a200`) — amber. 형제의 bottom-border 와 동일한 수법으로
  픽셀 스타일의 "버튼 누를 수 있음" 그림자 역할을 한다. 두께 2px (형제는 4px).
- 글자: `--graph-reset-fg` (`#fde68a`) — amber-200. 배경 4.8:1 대비, AA 본문 충족.
- 아이콘: `--graph-reset-icon` (`#fbbf24`) — amber-400. 글자보다 한 톤 진하게.

#### hover

- 배경: `--graph-reset-bg-hover` (`#4a3e6a`) — 10% 밝게.
- 테두리 하단: `--graph-reset-border-hover` (`#fbbf24`) — amber-400 으로 한 단계 상승.
- 글자: `#ffffff` — hover 시 글자는 순백으로 올려 "반응함" 을 시각 피드백.
- 트랜지션: 180ms ease-out (형제 `transition-all` 과 호환).
- 미세 번짐: `box-shadow: 0 0 0 2px rgba(251,191,36,0.18)` — 눈에 거슬리지 않는 얇은 amber halo.

#### active (눌림)

- 배경: `--graph-reset-bg-active` (`#2a2540`) — default 보다 12% 어둡게, "내려앉음" 을 표현.
- 테두리 하단: 2px → 0px + `translateY(2px)` 로 **버튼이 내려앉는 픽셀 감** 을 살린다.
- 글자: amber 유지 (`--graph-reset-fg`).
- 애니메이션: 60ms. 드래그 중 떨림을 피하기 위해 transform 전용.

#### focus (키보드)

- 기본값 위에 `outline: 2px solid var(--pixel-accent); outline-offset: 2px;` 를 얹는다.
- amber 테두리와 cyan outline 이 겹치지 않도록 offset=2px 으로 분리.
- 키보드-only 사용자를 위해 `:focus-visible` 로만 outline 을 노출(마우스 클릭 시 제거).

#### disabled

- 언제 disabled?
  1. 캔버스 pan=(0,0) & zoom=1.0 인 **이미 초기 상태**.
  2. 드래그 중(`data-dragging="true"` 동안 — 초기화 중 좌표 충돌 방지).
- 배경: `--graph-reset-bg-disabled` (`rgba(58,49,80,0.4)`).
- 테두리 하단: `rgba(255,255,255,0.1)` — 완전히 무채색.
- 글자/아이콘: `rgba(255,255,255,0.35)` — 3.0:1 AA large 수준까지 내림.
- `cursor: not-allowed;` + `pointer-events: none;`.
- 툴팁(`title`) 을 "이미 초기 상태입니다" 로 동적 교체.

## 3. 툴바 전체 레이아웃 (3버튼)

```
┌──────────────── aside.left-toolbar ────────────────┐
│                                                    │
│   … (위쪽: 네비게이션 목록 영역 · flex-1)           │
│                                                    │
│   ┌──────────────────────────────────────────────┐ │  ← .mt-auto pt-4 space-y-3
│   │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │ │
│   │  ▓▓      에이전트 고용 (cyan)           ▓▓  │ │  44px · border-b-4 #0099cc
│   │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │ │
│   └──────────────────────────────────────────────┘ │
│               ↕ 12px (space-y-3)                   │
│   ┌──────────────────────────────────────────────┐ │
│   │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │ │
│   │  ░░   ↺   그래프 초기화 (amber)         ░░  │ │  44px · border-b-2 amber
│   │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │ │
│   └──────────────────────────────────────────────┘ │
│               ↕ 12px (space-y-3)                   │
│   ┌──────────────────────────────────────────────┐ │
│   │  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  │ │
│   │  ▒▒         긴급중단 (red)              ▒▒  │ │  44px · border-b-4 #7a1a25
│   │  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  │ │
│   └──────────────────────────────────────────────┘ │
│                                                    │
└────────────────────────────────────────────────────┘
```

### 3.1 정렬·간격

- **세로 간격**: `space-y-3` = 12px. 기존 두 버튼 사이 간격과 동일하게 유지한다.
  신규 버튼 때문에 간격이 8px 로 좁아지면 "긴급중단" 버튼이 화면 하단으로 밀려
  실수 클릭 위험이 커진다.
- **수평 정렬**: 세 버튼 모두 `w-full` · 좌우 여백은 부모 `aside` 의 패딩이 책임진다.
  버튼 내부 패딩은 공통 `px-4` (16px).
- **세로 축 기준**: 아이콘·텍스트 묶음 모두 `justify-content: center` · `items-center`.
  세 버튼의 **글자 시작 x좌표** 는 의도적으로 맞추지 않는다 — 세 버튼 모두 중앙정렬이므로
  각 라벨 길이에 따라 시각 중심이 자연스럽게 맞춰진다.

### 3.2 높이 합계

세 버튼 × 44px + 간격 2 × 12px = **156px** (변화 없이 기존 120px → +36px 증가). 사이드바 하단이
36px 밀려 올라가므로, 네비게이션 목록 영역(`flex-1`) 이 그만큼 짧아진다. 목록은 스크롤 가능하므로
회귀 없음.

## 4. 인터랙션 세부

### 4.1 클릭 동작

- `resetGraph()` 내부 동작(구현 영역 — 후속 PR):
  - `pan` → `{ x: 0, y: 0 }`
  - `zoom` → `1.0`
  - **보존**: 에이전트 목록, 작업(task) 상태, 프로젝트 선택, 로그 이력.
- 실행 후 로그(`addLog`) 에 `캔버스 위치/줌 초기화 완료` 한 줄을 남긴다 — 사용자가 "무엇이
  사라진 게 아닌지" 로그 탭으로 확인할 수 있다(LogPanelTabs 의 `logs` 배지가 증가해
  자연스럽게 시선을 유도).
- 애니메이션 전이(300ms ease-in-out) 로 **pan/zoom 이 순간적으로 튀지 않게** 한다.
  `prefers-reduced-motion: reduce` 시 즉시 스냅.

### 4.2 확인 다이얼로그

- **기본적으로는 확인창을 두지 않는다.**
  `에이전트·작업은 보존` 이고 pan/zoom 은 Ctrl+Z 를 따로 걸지 않아도 다시 드래그/휠로 복구 가능.
  확인창을 두면 "매번 OK 를 누르는 피로" 가 쌓여 의미가 퇴색한다.
- 예외: 캔버스에 **배치되지 않은 에이전트** 가 있어 초기화 시 사용자가 수동 배치한 위치가
  리셋되는 경우에만 `window.confirm('배치한 에이전트 위치가 초기화됩니다. 계속할까요?')`.

### 4.3 키보드

- `Tab` 순서: 에이전트 고용 → 그래프 초기화 → 긴급중단.
- `Enter` / `Space` 로 클릭과 동일.
- 긴급 단축키 없음(의도). `긴급중단` 에만 추후 `Ctrl+.` 를 배정할 여지를 남긴다.

## 5. 디자인 토큰 (index.css 신규 `--graph-reset-*`)

| 토큰 | 값 | 용도 |
|------|----|------|
| `--graph-reset-bg` | `#3a3150` | default 배경 |
| `--graph-reset-bg-hover` | `#4a3e6a` | hover 배경 |
| `--graph-reset-bg-active` | `#2a2540` | 눌림 배경 |
| `--graph-reset-bg-disabled` | `rgba(58, 49, 80, 0.4)` | disabled 배경 |
| `--graph-reset-border` | `#e0a200` | default 하단 2px 강조선 |
| `--graph-reset-border-hover` | `#fbbf24` | hover 강조선 |
| `--graph-reset-border-active` | `#c48700` | 눌림 강조선 |
| `--graph-reset-fg` | `#fde68a` | 글자(default/active) |
| `--graph-reset-fg-hover` | `#ffffff` | 글자(hover) |
| `--graph-reset-fg-disabled` | `rgba(255, 255, 255, 0.35)` | 글자(disabled) |
| `--graph-reset-icon` | `#fbbf24` | 아이콘 기본 |
| `--graph-reset-halo` | `rgba(251, 191, 36, 0.18)` | hover 얇은 halo |

- 대비: 모든 값은 `--pixel-bg` (#1a1a2e) 기준이 아닌 **버튼 자체 배경** 기준으로 4.5:1 이상
  (default `#3a3150` ↔ `#fde68a` = 6.4:1, hover `#4a3e6a` ↔ `#ffffff` = 9.1:1).
- disabled 는 의도적으로 대비 3.0:1 수준으로 낮춘다(비활성 의미 전달 + AA large 충족).

## 6. 접근성 (a11y)

- `aria-label` 을 별도로 두어 스크린리더 사용자가 "무엇이 초기화되는지" 를 즉시 이해할 수
  있도록 한다 — "그래프 초기화 — 캔버스 위치와 줌만 복원".
- `title` 툴팁은 마우스 호버 시 한 문장 전체 설명 (1.2s 지연).
- disabled 시에는 `aria-disabled="true"` 를 **추가로** 건다 (`disabled` 만으로도 충분하지만
  screen reader 이중 확인 차원).
- `prefers-reduced-motion: reduce` → hover halo 애니메이션 제거, 버튼 내 transform 도 즉시.
- 색각 이상 대응: amber 단색에만 의존하지 않도록 아이콘(↺) + 라벨(한국어 "초기화") 을 **항상
  함께** 노출한다. 색만으로 의미를 전달하지 않는다.

## 7. 색상 비교 (형제 버튼과의 관계)

```
에이전트 고용   → bg #00d2ff (cyan-300)  · fg #000 (black)       · border-bottom #0099cc (cyan-600)
그래프 초기화   → bg #3a3150 (slate-v)   · fg #fde68a (amber-200) · border-bottom #e0a200 (amber-600)
긴급중단        → bg #c23b4a (red-500)   · fg #ffffff (white)     · border-bottom #7a1a25 (red-800)
```

- 세 버튼은 모두 "배경 + 하단 2~4px 진한 강조선" 규칙을 공유해 **픽셀 버튼 계열감** 을 유지.
- 신규 버튼의 배경만 유일하게 **낮은 채도/중간 명도** 로 설계되어, 위/아래 고채도 버튼 사이에서
  시각적 쉬어 가는 지점을 만든다.

## 8. 구현 시 주의

- 이번 시안은 **비주얼만**. `resetGraph()` 구현 자체는 후속 PR 에서 다룬다.
  토큰/클래스 추가와 버튼 JSX 만 먼저 반영해도 렌더링은 정상. 클릭은 `console.log` 스텁으로 남김.
- `disabled` 조건 "이미 초기 상태" 판정 로직은 pan.x=0 & pan.y=0 & zoom 가 **1.0 ± 0.001** 인지로
  판단(부동소수 오차 대응).
- 형제 버튼과 같은 `font-bold uppercase` 를 따라야 픽셀 톤이 맞는다 — 한글은 대소문자가 없지만
  `uppercase` 는 letter-spacing 상승 효과를 주므로 유지한다.
- Tailwind arbitrary value 와 섞지 말고 **index.css 의 `.graph-reset-btn*` 클래스** 에 고정시킨다.
  App.tsx 에서 `className="graph-reset-btn w-full py-3 font-bold uppercase"` 정도로만 노출.

## 9. 후속 단계 (QA 인계용)

1. 시안 검토 — SVG 4상태(default/hover/active/disabled) 와 3버튼 툴바 레이아웃 합동 리뷰.
2. `.graph-reset-btn*` 클래스 정의를 `src/index.css` 에 추가 (토큰은 본 PR 에서 선-반영).
3. `src/App.tsx` L1353~L1367 세 버튼 배치에 중간 버튼 삽입(초기 onClick 은 로그만).
4. `LogPanelTabs.tsx` 로그 탭 배지가 `캔버스 위치/줌 초기화 완료` 로그로 +1 증가 회귀 테스트.
5. 회귀 테스트 문서: `tests/graph-reset-button-regression.md` — 4상태 × 키보드/마우스/터치.
