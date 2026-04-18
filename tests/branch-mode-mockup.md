# BranchMode · Git 브랜치 전략 2모드 라디오 시안 (A안 · 2026-04-19)

대상 컴포넌트: `src/components/GitAutomationPanel.tsx`
통합 위치: 자동화 흐름 3단계(`commit`/`commit-push`/`full-pr`) `fieldset` 과
`src/components/GitAutomationPanel.tsx` 의 4전략 `fieldset` 사이
참조 토큰: `src/index.css` 의 `--branch-mode-*` 계열
관련 대안: `tests/branch-strategy-mockup.md` (B안 · 4전략 카드 UI)
인계 대상: 개발자 Joker

## 1. 재설계 배경

현재 `GitAutomationPanel` 은 4전략(per-commit / per-task / per-session / fixed-branch)
라디오를 이미 제공한다(관련 시안: `branch-strategy-mockup.md`). 그러나 실제 사용자
리서치에서 대다수 팀은 "이번 세션에서 새 브랜치를 팔까 / 지금 쓰던 브랜치에 이어
커밋할까" 라는 단 하나의 질문에만 답하면 충분하다는 피드백을 보였다.

이 A안은 4전략의 인지 부하를 줄이기 위한 **단순화 대안** 이다. 두 라디오만 남기고
세부 패턴은 상단 `branchPattern` 템플릿 필드로 일원화한다. 팀이 A안을 채택하면
4전략 블록은 철거 대상이 된다.

## 2. 2모드 정의

| 키(`branchMode`) | 이름 | 한 줄 설명 | 권장 상황 |
|------------------|------|------------|-----------|
| `new`            | 새 브랜치 생성 | 세션 시작 시 새 브랜치 1개를 만들고 세션 커밋을 모두 그 브랜치에 쌓음 | 일반적인 자동 PR 흐름 · 트렁크 기반 협업 |
| `continue`       | 현재 브랜치에서 계속 작업 | 활성 브랜치(직전 세션·수동 체크아웃 결과) 를 그대로 재사용 | 실험 브랜치 누적 · 장기 PR · 긴급 수정 이어받기 |

### 상호 배타 규칙

- 두 모드 중 정확히 하나만 선택 가능. 기본값은 `new`.
- 전환 시 즉시 UI 만 바뀌고, 실제 자동화는 다음 세션부터 반영된다(진행 중 세션 중단 금지).

## 3. 레이아웃

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 🌿 브랜치 전략 · 2모드 시안 (A안)             — 단순화 대안 · 아직 저장되지 않음│
├──────────────────────────────────────────────────────────────────────────┤
│  ◉ 새 브랜치 생성               ◯ 현재 브랜치에서 계속 작업                  │
│    세션 시작 시 한 번              활성 브랜치 재사용                         │
│    세션 시작 시점에 새 브랜치를     이미 활성화된 브랜치에 이어서 커밋합니다.   │
│    하나 만들고, 세션 동안의 모든                                             │
│    커밋을 그 브랜치에 쌓습니다.                                              │
├──────────────────────────────────────────────────────────────────────────┤
│  ── new 선택 시 ─────────────────────────────────────────────────────────  │
│  브랜치명  [ feature/session-a7b3c9                              ]         │
│  접두사:  [feature/] [fix/] [chore/] [docs/]                                │
│  ⓘ 접두사 규칙: feature/·fix/·chore/·docs/ 중 하나로 시작해 목적을 즉시 드러냅니다.│
│                                                                          │
│  ── continue 선택 시 ─────────────────────────────────────────────────── │
│  현재 브랜치 에 이어서 커밋합니다. 새 브랜치는 만들어지지 않으며 …           │
│  🌿 재사용할 브랜치   chore/-all-agents-completed                           │
└──────────────────────────────────────────────────────────────────────────┘
```

## 4. 접두사(prefix) 규칙

칩 클릭 시 `newBranchName` 의 기존 접두사만 교체하고 뒷부분(슬러그) 은 보존한다.
`replaceBranchPrefix(current, nextPrefix)` 순수 함수로 분리해 단위 테스트와
UI 양쪽에서 공유한다(구현: `GitAutomationPanel.tsx` 내 동일 파일).

| 접두사 | 용도 | 예시 |
|--------|------|------|
| `feature/` | 새 기능 · 사용자에게 보이는 가치 추가 | `feature/login-refresh` |
| `fix/`     | 버그 수정 · 회귀 또는 결함 복구       | `fix/payment-regression` |
| `chore/`   | 잡무 · 의존성·설정·리팩터            | `chore/bump-deps`        |
| `docs/`    | 문서 · 주석·README·시안 문서         | `docs/branch-mode-mockup` |

검증 규칙(`BRANCH_PREFIX_REGEX`): `^(feature|fix|chore|docs|hotfix|refactor)/`.
사용자가 이 외 접두사를 수동 입력하면 칩을 클릭해도 덮어쓰지 않고 **앞에 새
접두사를 붙이는** 편이 낫다고 판단한 경우도 있으나, 본 시안은 "입력값을 최대한
존중" 원칙으로 기존 접두사 교체만 수행한다.

## 5. 저장 스키마 변화

이번 시안은 `GitAutomationSettings` 를 변경하지 않는다(아직 local state 전용).
Joker 가 A안 채택을 결정하면 아래 마이그레이션을 수행한다.

```ts
// 제거
type BranchStrategy = 'per-commit' | 'per-task' | 'per-session' | 'fixed-branch';

// 신설
type BranchMode = 'new' | 'continue';
interface GitAutomationSettings {
  // ...
  branchMode: BranchMode;
  newBranchName: string; // branchMode === 'new' 일 때 사용, 'continue' 에서는 빈 문자열
}
```

서버 측 대응:
- `server.ts` 의 `executeGitAutomation` 가 `branchMode === 'continue'` 면
  현재 `HEAD` 를 그대로 사용. `'new'` 면 `newBranchName` 을 `git checkout -b` 로 생성.
- `src/utils/projectOptions.ts` 는 `branchMode` 열거형을 검증.

## 6. 시각적 위계

- 외곽 `fieldset`: `border-2 border-[var(--pixel-border)] bg-black/30 p-3` — 기존
  "브랜치 이름 패턴 / 커밋 메시지 템플릿 / PR 제목 템플릿" 필드 묶음과 동일 톤.
- 각 라디오 카드: `.branch-mode__card` — `--branch-mode-card-idle-border` 로 시작,
  선택 시 `--branch-mode-card-active-border` + `--branch-mode-card-active-bg`.
- `continue` 모드의 활성 브랜치 박스: `--branch-mode-continue-accent` (emerald)
  로 "안전하게 이어간다" 는 의미를 색으로 전달.
- 접두사 칩: `--branch-mode-prefix-chip-bg` / `--prefix-chip-border` — 4전략
  시안의 변수 칩(`--branch-strategy-chip-bg`) 보다 약간 높은 불투명도로 "힌트이되
  클릭 가능한 실체" 임을 시사.

## 7. 상호작용 상세

- 라디오 그룹: `role="radiogroup"` + `aria-labelledby="branch-mode-sketch-heading"`.
- 각 라디오: 시각적으로는 카드 전체가 클릭 대상이고 `<input type="radio">` 는
  `sr-only peer` 로 숨겨 키보드·스크린리더 접근성만 유지.
- 접두사 칩 버튼: 클릭 시 `replaceBranchPrefix()` 로 입력값 prefix 치환.
  현재 `newBranchName` 이 빈 값이면 prefix 만 삽입.
- `continue` 모드: 사용자가 수동으로 체크아웃한 브랜치를 `activeBranch` prop 으로
  읽어 그대로 표시. 브랜치가 비어 있으면 "아직 결정되지 않음" 이탤릭 fallback.

## 8. 접근성 (a11y)

- 라디오 카드 클릭 영역 전체가 `<label>` 이므로 포인터·키보드 모두 접근 가능.
- `peer:focus-visible` 와 `focusRing` 유틸로 포커스 링을 accent 로 표시.
- 접두사 칩 버튼: `aria-label="{prefix} 접두사로 교체"` 로 스크린리더에 동작을 전달.
- `continue` 모드의 재사용 브랜치 박스: 브랜치명을 `title` 로도 노출해 잘림 대비.
- 색각 이상 대응: `continue` emerald + `new` accent 는 색뿐 아니라 아이콘·라벨
  텍스트 3중 인코딩을 유지.

## 9. 디자인 토큰 (index.css)

| 토큰 | 값 | 용도 |
|------|----|------|
| `--branch-mode-card-idle-border`    | `rgba(255,255,255,0.18)` | 미선택 카드 테두리 |
| `--branch-mode-card-active-border`  | `#00d4ff`                | 선택 카드 accent 테두리 |
| `--branch-mode-card-active-bg`      | `rgba(0,210,255,0.08)`   | 선택 카드 배경 |
| `--branch-mode-prefix-chip-bg`      | `rgba(255,255,255,0.08)` | 접두사 칩 배경 |
| `--branch-mode-prefix-chip-fg`      | `#b6eaff`                | 접두사 칩 텍스트 |
| `--branch-mode-prefix-chip-border`  | `rgba(0,210,255,0.35)`   | 접두사 칩 테두리 |
| `--branch-mode-hint-fg`             | `rgba(255,255,255,0.55)` | 설명 줄 mute 톤 |
| `--branch-mode-continue-accent`     | `#34d399`                | `continue` 모드 emerald 강조 |

## 10. 후속 단계 (Joker 인계용)

1. A안/B안 중 하나 결정 — 팀 리뷰 미팅. A안 채택 시 4전략 fieldset 철거 + 본
   fieldset 의 `data-mockup="branch-mode-A"` 속성 제거 및 저장 페이로드 승격.
2. `src/utils/branchMode.ts` 신규 — `replaceBranchPrefix()` 를 본 파일에서 분리 +
   `ensurePrefix()`(빈 값 시 기본 `feature/` 삽입) 추가 · 단위 테스트 6 케이스.
3. `server.ts` `executeGitAutomation` 에 `branchMode === 'continue'` 경로 추가.
4. `src/utils/projectOptions.ts` 의 `settingsJson` 검증에 `branchMode` 열거형 반영.
5. 회귀 테스트: `tests/branch-mode.regression.test.ts` — 2모드 × 저장·전환·빈 입력.
