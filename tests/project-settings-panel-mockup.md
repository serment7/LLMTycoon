# ProjectSettingsPanel · 프로젝트 관리 옵션 패널 UI 시안 (2026-04-18)

대상 컴포넌트(신규): `src/components/ProjectSettingsPanel.tsx`
편입 대상: `src/components/ProjectManagement.tsx` — 프로젝트 상세 페이지 우측 사이드바(`≥1280px`) 또는 탭(`<1280px`)
참조 타입: `src/types.ts` 의 `ManagedProject`(`defaultBranch`, `prBaseBranch`, `url`), `GitAutomationSettings`, `SharedGoal`
시안 이미지: `tests/project-settings-panel-mockup.svg` (5 영역 · 저장 상태 피드백 · 동선 플로우차트)
디자인 토큰: `src/index.css` 의 `--project-settings-*` 계열 (신규 추가)

## 1. 패널 목적

현재 프로젝트 설정은 `GitAutomationPanel`, `GitCredentialsSection`, `PushPRActionBar` 로 **분산**되어
사용자가 "이 프로젝트의 모든 옵션을 한눈에" 보기 어렵다. 신규 `ProjectSettingsPanel` 은
**단일 진원(single source of truth) 의 UI 허브** 로서 다음 책임만 가진다.

- 자동화 3-토글(자동 개발 · 자동 커밋 · 자동 푸시)의 켜고 끔 - 위험 계단식 의존을 시각화
- 저장소 연결 정보(기본 브랜치, 원격 저장소 URL) 편집
- 공동 목표 드롭다운 선택(= 이 프로젝트가 어떤 SharedGoal 에 묶이는지 결정)
- 고급 설정(JSON 뷰) — 템플릿·브랜치 패턴·커밋 메시지 템플릿 등 raw 편집
- 각 옵션의 실시간 저장 상태 피드백(저장됨 · 저장 중 · 오류) 표시

기존 `GitAutomationPanel` 은 "파이프라인 단계(flow) 선택·템플릿" 으로 역할 축소, 본 패널이 그 위에
"이 프로젝트 레벨의 토글/연결/목표" 를 얹는다.

## 2. 레이아웃 (5 섹션 수직 스택)

```
┌──────────────────────────────────────────────────────────────────────┐
│ 📁 PROJECT SETTINGS                          [● 저장됨 · 2분 전]       │ ← 헤더
├──────────────────────────────────────────────────────────────────────┤
│ ① AUTOMATION TOGGLES                                                  │
│   ⚡ 자동 개발     [●—]  "리더가 동료에게 작업을 분배"          ⓘ     │
│   📝 자동 커밋    [●—]  "에이전트 작업 완료 후 자동 커밋"       ⓘ     │
│   🚀 자동 푸시    [ —●] "커밋 후 원격 브랜치로 푸시"           ⓘ     │
│   (계단식 의존: 개발 OFF → 커밋·푸시도 자동 OFF / 커밋 OFF → 푸시 차단)│
├──────────────────────────────────────────────────────────────────────┤
│ ② REPOSITORY CONNECTION                                               │
│   기본 브랜치  [ main                         ]   기본값 ▼             │
│   원격 저장소  [ https://github.com/org/repo.git           🔗 ]        │
│   PR 대상      [ main ▼ ]  (선택 시 prBaseBranch 에 저장)             │
├──────────────────────────────────────────────────────────────────────┤
│ ③ SHARED GOAL BINDING                                                 │
│   [ 결제 모듈 보안 강화 · P1 · ~4/25 ▼ ] [🎯 연결됨]                  │
│   미선택 시 "자동 개발" 토글은 🔒 잠김(=SharedGoalForm 규칙 재사용)    │
├──────────────────────────────────────────────────────────────────────┤
│ ④ ADVANCED (JSON)                                                     │
│   ▾ JSON 뷰 펼치기                                                    │
│   ┌──────────────────────────────────────────────────────────────┐   │
│   │ {                                                            │   │
│   │   "branchPattern": "{type}/{ticket}-{branch}",              │   │
│   │   "commitTemplate": "{type}: {branch}",                     │   │
│   │   "prTitleTemplate": "[{ticket}] {type} — {branch}",        │   │
│   │   "flow": "commit-push"                                      │   │
│   │ }                                                            │   │
│   └──────────────────────────────────────────────────────────────┘   │
│   [검증] [원복] [💾 적용]                                             │
├──────────────────────────────────────────────────────────────────────┤
│ ⑤ 위험 영역                                                           │
│   [프로젝트 삭제] [관리 목록에서 제거]                                │
└──────────────────────────────────────────────────────────────────────┘
```

## 3. 자동화 3-토글 계단식 의존 규칙

| 변경 | 연쇄 효과 |
|------|----------|
| 자동 개발 OFF → 자동 커밋/자동 푸시 자동 OFF(보호)·diff 보존 |
| 자동 커밋 OFF → 자동 푸시 🔒 잠김(= "커밋 없이 푸시" 는 논리적으로 불가) |
| 자동 커밋 ON → 자동 푸시 조작 가능 |
| 공동 목표 미선택 → 자동 개발 🔒 잠김 (SharedGoalForm 시안과 통일) |

- 내부 상태: `settings.enabled` / `settings.autoCommit` / `settings.autoPush` 3개 불린.
- 계단식 차단은 순수 함수 `canEnable(kind, state)` 로 추출해 `src/utils/gitAutomation.ts` 와 공유.
- 잠김 토글은 SharedGoalForm 의 `shared-goal-toggle[data-shake]` 패턴을 재사용해 shake 200ms + focus 이동.

## 4. 저장 상태 피드백 (`saveStatus` 모델)

| 값 | 배지 | 색 | 발생 조건 |
|----|------|----|---------|
| `idle` | `● 저장됨 · N분 전` | emerald `#34d399` | 마지막 낙관적 PATCH 성공 후 안정 |
| `saving` | `◔ 저장 중…` | sky `#60a5fa` (pulse 1.2s) | PATCH 응답 대기 중 |
| `error` | `✕ 저장 실패 · 재시도` | red `#f87171` | 네트워크/서버 오류 · 재시도 버튼 제공 |
| `dirty` | `⚠ 저장되지 않음` | amber `#fbbf24` | JSON 뷰 편집 후 [적용] 전 |

- 위치: 패널 헤더 우측 상단. `role="status"` + `aria-live="polite"` 로 상태 전이 시 낭독.
- 필드별 마이크로 피드백: 각 `input` 의 오른쪽 끝에 4px 세로 스트립(emerald/sky/red/amber) 을
  depressurized 로 표시해 "어떤 필드가 저장 대기 중인지" 한눈에 구분.

## 5. 공동 목표 드롭다운 스펙

- 데이터 소스: `GET /api/projects/:id/shared-goals?status=saved|running` (2026-04-18 시안 이후 엔드포인트).
- 옵션 포맷: `{goal.title} · {priority 배지} · ~{dueDate 단축}`.
- 최대 표시: 5개 스크롤, 그 이상은 검색 input 표시 — 20자 이상 타이틀은 `…` 잘라냄.
- 선택 해제 옵션: 목록 맨 위에 "연결 없음(자동 개발 잠금)" row.
- 선택 시 즉시 PATCH `/api/projects/:id/shared-goal-binding` 호출, 낙관적 업데이트 + 롤백.

## 6. 고급 설정(JSON) 뷰

- 에디터: `<textarea>` 기반 + `monospace` + 12px + 4줄 ~ 12줄 auto-resize.
- 검증: [검증] 클릭 시 `JSON.parse` + zod 스키마(`gitAutomationSettingsSchema`) 로 검증.
  - 성공: 하단에 emerald "스키마 검증 통과" 줄.
  - 실패: red 줄 + 오류 경로(`branchPattern: 필수`) 표시, 해당 키를 에디터에서 노란 배경 하이라이트.
- [원복]: 마지막 서버 응답값으로 되돌림.
- [적용]: 서버 PATCH + 성공 시 `saveStatus='idle'`, 실패 시 `error`.
- 안전장치: JSON 뷰에서만 편집 가능한 필드(`branchPattern` 등) 를 상단 폼에서 직접 노출하지 않아
  "두 화면 사이 drift" 를 방지.

## 7. 툴팁 카피 스펙

| 필드 | 툴팁 |
|------|------|
| 자동 개발 | "리더 에이전트가 공동 목표를 근거로 동료에게 작업을 분배합니다. 공동 목표 선택이 전제조건입니다." |
| 자동 커밋 | "각 에이전트의 작업이 완료되면 자동으로 로컬 커밋을 만듭니다. 되돌리려면 amend/rebase 로 복구 가능." |
| 자동 푸시 | "커밋 후 원격 브랜치로 push 합니다. 자동 커밋이 켜져 있어야 활성화됩니다. 되돌리려면 force-push 필요." |
| 기본 브랜치 | "저장소의 기본 브랜치. 비어 있으면 서버가 원격의 HEAD 를 자동 감지합니다." |
| 원격 저장소 | "HTTPS 또는 SSH URL. 변경 시 기존 자격증명과의 호환성을 서버가 검증합니다." |
| PR 대상 | "Pull Request 의 base 브랜치. 기본 브랜치와 다른 릴리스 브랜치로 지정할 수 있습니다." |
| 공동 목표 | "이 프로젝트가 묶일 공동 목표(SharedGoal). 자동 개발 플로우의 분배 기준이 됩니다." |
| JSON 뷰 | "파워유저 전용. 잘못 입력 시 [검증] 이 막아줍니다. 스키마는 zod 로 서버와 공유됩니다." |

## 8. 동선 플로우차트 (편입 경로)

```
 [프로젝트 관리(ProjectManagement)]
            │
            ▼
 [프로젝트 카드 클릭]────▶ [상세 페이지]
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
         [개요 탭]        [에이전트 탭]       [⚙ 설정 탭]  ← ProjectSettingsPanel
                                                  │
              ≥1280px ─▶ 우측 고정 사이드바로 도킹 (탭 아님)
                                                  │
                                                  ▼
                         ┌─ ① Automation Toggles ─┐
                         ├─ ② Repository Connection ┤
                         ├─ ③ Shared Goal Binding   ┤
                         ├─ ④ Advanced (JSON)        ┤
                         └─ ⑤ Danger Zone            ┘
```

### 반응형 편입 규칙

| 뷰포트 | 편입 방식 |
|--------|----------|
| ≥1280px | 상세 페이지 우측에 360px 고정 사이드바, 스크롤 sync(`position: sticky; top: 72px`) |
| 768–1279px | 상세 페이지 상단 탭(`⚙ 설정`) · 전체 폭 사용 · 섹션은 아코디언 기본 접힘 |
| <768px | 탭 · 섹션 카드 세로 적층 · 고급(JSON) 은 모달로 분리 |

## 9. 접근성 (a11y)

- 패널 루트: `role="region"` + `aria-labelledby="project-settings-heading"`.
- 3-토글 그룹: `role="group"` + `aria-label="자동화 토글"` · 계단식 잠금은 `aria-disabled="true"` +
  `aria-describedby="auto-push-lock-hint"` 로 이유를 낭독.
- JSON 뷰: `textarea` 에 `aria-describedby="advanced-json-help"` + 오류 시 `aria-invalid="true"`.
- 드롭다운: `role="combobox"` + `aria-expanded` · 키보드 ↑↓ 순환 · Enter 선택 · Esc 닫기.
- 상태 배지: `role="status"` · `aria-live="polite"` · 저장 실패만 `aria-live="assertive"`.
- 색 대비: 모든 배지 텍스트 4.5:1 이상 (emerald/sky/red/amber 모두 패널 배경 `#0f3460` 대비 충족).
- 색각 이상 대응: 배지에 아이콘(● ◔ ✕ ⚠) + 텍스트 3중 인코딩.

## 10. 색상 토큰 (신규 `--project-settings-*` · index.css)

| 토큰 | 값 | 용도 |
|------|----|------|
| `--project-settings-panel-bg` | `#0f3460` | 패널 바탕 |
| `--project-settings-section-bg` | `rgba(0,0,0,0.30)` | 섹션 내부 블록 |
| `--project-settings-divider` | `rgba(255,255,255,0.10)` | 섹션 구분선 |
| `--project-settings-save-idle` | `#34d399` | 저장됨 배지·필드 스트립 |
| `--project-settings-save-saving` | `#60a5fa` | 저장 중 배지·pulse |
| `--project-settings-save-error` | `#f87171` | 오류 배지·재시도 |
| `--project-settings-save-dirty` | `#fbbf24` | 변경 있음 배지 |
| `--project-settings-lock-fg` | `rgba(255,255,255,0.45)` | 계단식 잠금 아이콘 |
| `--project-settings-toggle-chain` | `rgba(127,212,255,0.35)` | 3-토글 계단식 연결선 |

## 11. 구현 시 주의

- 모든 필드는 **낙관적 업데이트 + 디바운스 600ms PATCH** 를 기본으로 한다. 오류 시 이전 값 롤백.
- JSON 뷰의 schema 는 `src/utils/gitAutomation.ts` 의 기존 파서와 단일 진원을 공유 — 중복 검증 금지.
- 토글의 계단식 잠금 규칙은 `canEnable()` 순수 함수로 추출해 단위 테스트 작성(SharedGoal 잠금과 함께).
- 위험 영역([프로젝트 삭제])은 `GitCredentialsSection` 의 삭제 모달 패턴 재사용 — 라벨 타이핑 확인.
- `prefers-reduced-motion` 존중 — pulse/shake 비활성.

## 12. 후속 단계 (Kai 리뷰용)

1. `src/utils/gitAutomation.ts` 에 `canEnable(kind, state)` 추가 후 `GitAutomationPanel` / `ProjectSettingsPanel` 양쪽에서 import.
2. 서버 API `PATCH /api/managed-projects/:id` 에 `defaultBranch` · `url`(원격) · `sharedGoalId` 필드 허용.
3. 상세 페이지 라우트(현재 ProjectManagement 단일 그리드) 분해 — 탭 전환은 `useSearchParams('tab')` 권장.
4. JSON 뷰는 monaco-editor 도입 검토(번들 크기 이슈 — 현재는 textarea 유지).
5. 회귀 테스트 문서(후속): `tests/project-settings-panel-regression.md` — 계단식 잠금·저장 상태 전이 4 케이스.
