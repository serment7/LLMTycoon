# SharedGoalForm · 공동 목표 입력 폼 UI 시안 (2026-04-18)

대상 컴포넌트(신규): `src/components/SharedGoalForm.tsx`
배치 위치: `src/components/GitAutomationPanel.tsx` — 헤더(자동 개발 ON 토글) 바로 **왼쪽 확장 영역**
시안 이미지: `tests/shared-goal-form-mockup.svg` (4 상태 · Storybook 대체 정적 미리보기)
디자인 토큰: `src/index.css` 의 `--shared-goal-*` 계열 (신규 추가)

## 1. 기능 목적

완전 자동화(자동 개발 ON) 플로우는 **리더 에이전트가 동료들에게 분배할 공동 목표**가 반드시
선입력되어야 의미 있게 동작한다. 목표가 비어 있는 상태에서 토글이 켜지면 리더가 "무엇을 할지"
를 추정하게 되어 오작동·잘못된 PR 이 양산된다. 따라서 **목표 입력이 토글의 전제조건**이며,
이 관계를 UI 가 시각적으로 강제해야 한다.

## 2. 레이아웃 (GitAutomationPanel 헤더 확장)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ GIT 자동화                                               [🎯 공동 목표] [⚡ 활성]│ ← 기존 헤더
├─────────────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────── 공동 목표 ────────────────────────────┐│
│ │  목표 제목    [ 결제 모듈 보안 강화                                 ] 36/80││
│ │  상세 설명    [ 토큰 검증·AES 암호화·PCI 감사로그 추가             ▼]     ││
│ │  우선순위     ◉ P1-긴급  ○ P2-중요  ○ P3-일반            기한 [2026-04-25]││
│ │  ┌─ 리더 미리보기 ───────────────────────────────────────────────────────┐││
│ │  │ 🤖 4명에게 "결제 모듈 보안 강화(P1, ~4/25)" 로 분배 예정              │││
│ │  └───────────────────────────────────────────────────────────────────────┘││
│ │                                              [초기화] [💾 목표 저장]       ││
│ └───────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│    ⚡ 자동 개발      [OFF ● ——— ]    ← (목표 미입력 시 잠김 아이콘 + 회색)    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 필드 규격

| 필드 | 타입 | 제약 | 비고 |
|------|------|------|------|
| 제목 (`title`) | `input[type=text]` | 필수 · 4~80자 | 실시간 카운터 `36/80` |
| 상세 설명 (`description`) | `textarea` | 필수 · 20~500자 | 4줄 기본, 확장 가능 |
| 우선순위 (`priority`) | radio group | `P1` `P2` `P3` | 색상 태그(red/amber/sky) |
| 기한 (`dueDate`) | `input[type=date]` | 선택, 오늘 이후 | 미지정 시 "기한 없음" |

## 3. 상태 머신 (4 상태)

| 상태 | 설명 | 토글 상태 | 시각 단서 |
|------|------|-----------|----------|
| **empty** (미입력) | 제목·설명 모두 공란 | 🔒 잠김·회색 | 점선 테두리 · "공동 목표를 먼저 입력해주세요" |
| **editing** (입력중) | 포커스 중·변경 존재 | 🔒 잠김·회색 (저장 전까지) | amber 펄스 "⚠ 미저장" 배지 |
| **saved** (저장됨) | 서버 DB 기록 완료 | ✅ 활성 가능 | emerald "✓ 저장됨" · 토글 풀림 |
| **running** (실행중) | 자동 개발 ON + 리더 분배 진행 | ● 활성 | sky 펄스 "◔ 분배 중" + 진행 링 |

### 상태 간 전이

```
empty ─(입력 시작)──▶ editing ─(저장 클릭)──▶ saved ─(토글 ON)──▶ running
  ▲                                                │
  └──────────── (목표 삭제 버튼) ──────────────────┘
```

## 4. 자동 개발 토글의 시각적 잠금

목표가 저장되지 않은 상태(`empty` / `editing`) 에서는 토글을 조작할 수 없다.

- **회색화**: 스위치 트랙 `rgba(255,255,255,0.10)` + 핸들 `rgba(255,255,255,0.30)`.
- **잠금 아이콘**: 라벨 좌측 `<Lock size={12}>` 아이콘을 토글 옆에 겹쳐 노출.
- **커서**: `cursor: not-allowed`.
- **툴팁** (hover · focus 양쪽): "공동 목표를 먼저 저장해야 자동 개발을 시작할 수 있어요"
- **스크린리더**: `aria-disabled="true"` + `aria-describedby="shared-goal-lock-hint"`.
- **시도 시 안내**: 비활성 상태에서 클릭하면 폼 상단에 amber shake 1회(200ms) + focus 이동.

## 5. 색상 토큰 (index.css · 신규 `--shared-goal-*`)

| 토큰 | 값 | 용도 |
|------|----|----|
| `--shared-goal-border-empty` | `rgba(255,255,255,0.25)` dashed 2px | 미입력 점선 테두리 |
| `--shared-goal-border-editing` | `#fbbf24` solid 2px | 입력 중 amber 강조 |
| `--shared-goal-border-saved` | `#34d399` solid 2px | 저장됨 emerald |
| `--shared-goal-border-running` | `#60a5fa` solid 2px (pulse) | 실행 중 sky |
| `--shared-goal-lock-fg` | `rgba(255,255,255,0.45)` | 잠금 아이콘 tint |
| `--shared-goal-priority-p1` | `#f87171` | P1 라디오/배지 |
| `--shared-goal-priority-p2` | `#fbbf24` | P2 |
| `--shared-goal-priority-p3` | `#7fd4ff` | P3 |

## 6. 상태 배지 매트릭스

| 상태 | 배지 | 토글 표시 |
|------|------|-----------|
| empty | `⓪ 목표 미입력` (white/40) | 🔒 잠김·회색 OFF |
| editing | `⚠ 미저장 변경` (amber pulse 1.4s) | 🔒 잠김·회색 OFF |
| saved | `✓ 목표 저장됨` (emerald) | ⚡ ON 가능 (사용자 조작 대기) |
| running | `◔ 리더 분배 중 · 4명` (sky pulse) | ● ON 활성 |

## 7. 접근성 (a11y)

- 폼은 `role="group"` + `aria-labelledby="shared-goal-heading"` 로 그룹 식별.
- 필수 필드는 `aria-required="true"` · 검증 에러는 `aria-describedby` 로 필드에 연결.
- 우선순위 라디오 그룹은 `role="radiogroup"` · 방향키로 순환.
- 토글 잠금 상태: `aria-disabled="true"` + hidden `<span id="shared-goal-lock-hint">` 안내.
- 상태 배지: `role="status"` + `aria-live="polite"` · empty→saved 전이 시 한 번 낭독.
- 목표 저장 성공 시 전체 폼에 emerald flash 1회(색각 이상 대응: 아이콘 `✓` 병기).
- 키보드 단축: `Ctrl+Enter` 로 "목표 저장" · `Esc` 로 편집 취소(=마지막 저장본 복원).

## 8. 리더 미리보기 박스

폼 하단에 "저장 시 리더가 어떻게 분배할지" 를 미리 보여주는 emerald 박스를 둔다.

- 형식: `🤖 {agentCount}명에게 "{title.substring(0,30)}…" ({priority}, {dueShort}) 로 분배 예정`
- 예시: `🤖 4명에게 "결제 모듈 보안 강화" (P1, ~4/25) 로 분배 예정`
- 기한 없음: `(P1, 기한 없음)`
- 제목 30자 초과 시 `…` 로 잘라냄.
- 저장 전에도 실시간 갱신(디바운스 250ms) → 사용자가 "무엇이 어떻게 전송될지" 를 입력 도중 확인.

## 9. 카피 스펙 (한국어 우선)

1. **섹션 부제**: "리더 에이전트가 동료들에게 분배할 공동 목표. 저장 후에만 자동 개발을 시작할 수 있습니다."
2. **빈 상태 안내** (점선 영역): "공동 목표를 먼저 입력해주세요. 목표 없이는 자동 개발이 시작되지 않습니다."
3. **저장 버튼**: `💾 목표 저장` (단순 "저장" 대신 대상을 명시).
4. **토글 잠금 툴팁**: "공동 목표를 먼저 저장해야 자동 개발을 시작할 수 있어요."
5. **삭제 확인**: "이 목표를 삭제하면 자동 개발이 즉시 정지되고 4명의 에이전트에게 WAIT 신호가 전송됩니다."

## 10. 구현 시 주의

- 저장은 `POST /api/projects/:id/shared-goal` (신규 엔드포인트 제안) 로 낙관적 업데이트.
- `running` 상태 중에는 목표 필드 전체를 `readOnly` 로 잠가 "진행 중 목표 변경" 사고를 차단.
  변경 필요 시 **먼저 토글 OFF** → editing → saved → 토글 ON 순서 강제.
- 토글 onChange 핸들러 진입 시점에서 `settings.sharedGoal?.status === 'saved'` 를 가드.
  그렇지 않으면 shake 애니메이션만 트리거하고 실제 상태는 변경하지 않는다.
- 폼 변경사항은 `leaderMessage.ts` 의 분배 메시지 생성기와 연결. 저장 완료 이벤트에서
  리더 에이전트의 첫 분배 문장에 `title`/`priority`/`dueDate` 가 자동 삽입되게 한다.

## 11. 후속 단계

1. Thanos 가 `SharedGoalForm.tsx` 를 구현 — `maskToken` 류 유틸이 없는 **평문 저장** 이므로
   XSS 방지를 위해 `title`/`description` 을 DB 저장 시 HTML 이스케이프.
2. 서버: `sharedGoals` 테이블 스키마(프로젝트당 1행, 이력은 `sharedGoalHistory` 로 분리).
3. 리더 프롬프트 조정(`src/server/prompts.ts`): 공동 목표 블록을 시스템 프롬프트 상단에 고정 주입.
4. 추후 "목표 진행률 게이지" (e.g. `3/7 subtasks done`) 배너를 `running` 상태 하단에 추가 검토.

---

## 12. 시안 ↔ 실 구현 매핑 (2026-04-19, Joker)

본 문서는 디자인 시안으로서 시점이 고정돼 있다. 이 섹션은 시안이 실 코드로
얼마나 이식됐는지를 추적해, 후속 개발자가 "어디가 이미 구현됐고 어디가 아직
시안 상태인지" 를 한 번에 파악할 수 있게 한다.

| 시안 항목 | 상태 | 실 구현 경로 |
| --- | --- | --- |
| §2 레이아웃 · 필드(title/description/priority/dueDate) | ✅ 구현 | `src/components/SharedGoalForm.tsx` |
| §3 4상태 머신(empty/editing/saved/running) | 🟡 부분 — empty·editing·saved 3상태만 | 같은 파일. `running` 은 자동 개발 토글 연동 후속 |
| §4 자동 개발 토글 시각 잠금 | ✅ 구현 | `src/App.tsx` 토글 pre-check + `SharedGoalModal` 모달 on-ramp |
| §5 `--shared-goal-*` 디자인 토큰 | ✅ 도입 | `src/index.css:54~91` |
| §6 상태 배지 매트릭스 | 🟡 부분 — `empty/editing/saved` 배지 | `SharedGoalForm.tsx::StatusBadge`. `running` 배지는 후속 |
| §7 접근성(role/aria-*) | ✅ 구현 | `SharedGoalForm.tsx` — `role="group"` · `aria-labelledby` · `aria-required` · 라디오그룹 |
| §8 리더 미리보기 박스 | 🔲 미구현 | 이관 — 후속 PR |
| §9 카피 스펙 | 🟡 부분 | 본 문서의 카피를 직접 문자열로 이식. 일부 문구(삭제 확인 등) 는 모달 부재로 이관 |
| §10 구현 시 주의 (POST 엔드포인트·리더 프롬프트 연결) | ✅ 구현 | `server.ts:985~1018` · `src/server/prompts.ts::renderSharedGoalBlock` |
| §11-1 SharedGoalForm.tsx 구현 | ✅ | 위와 동일 |
| §11-2 sharedGoals 테이블 스키마 | ✅ | `server.ts:241~246` — `shared_goals` 컬렉션 + `projectId` · `status` 인덱스 |
| §11-3 리더 프롬프트 블록 주입 | ✅ | `src/server/prompts.ts::buildLeaderPlanPrompt` + `renderSharedGoalBlock` |
| §11-4 목표 진행률 게이지 | 🔲 미구현 | 후속 마일스톤 검토 |

### 12.1 관련 회귀 테스트

시안 계약을 잠그는 회귀 테스트 현황(2026-04-19):

```bash
npx tsx --test tests/sharedGoalFormDisplay.regression.test.ts           # 17 / 17
npx tsx --test tests/projectManagementSharedGoalMount.regression.test.ts # 3 / 3
npx tsx --test tests/sharedGoalModalAtomic.regression.test.ts            # 5 / 5
npx tsx --test tests/projectManagementNoProjectPlaceholder.regression.test.ts  # 4 / 4
npx tsx --test tests/sharedGoal.regression.test.ts                       # 12 / 12 · 0 skip
```

### 12.2 시안 변경 정책

본 §12 는 "현재 어디까지 왔는가" 를 기록하는 **살아있는 테이블** 이다. 시안 본문
(§0~§11) 은 스냅샷이므로 변경 금지. 새로운 상태(예: `running` 배지 도입) 가 합류
하면 본 §12 표의 ✅/🟡/🔲 아이콘만 갱신한다.
