---
date: 2026-04-21
owner: Designer (LLMTycoon)
trigger-directive: "지시 #300a492d — 추천 편집 플로우 · 근거 상세 드로어 · 최근 추천 템플릿 저장소"
prior-context:
  - src/components/ProjectSettings/CodeConventionPanel.tsx (우선 검토 파일 — 로컬/전역 탭 분리 편집 폼 선례)
  - src/project/recommendAgentTeam.ts (AgentRecommendation { role · name · rationale } 스키마 · ROLE_CATALOG)
  - src/project/recommendationClient.ts (RecommendationCache · sanitizeRationale · DebouncedRecommender)
  - src/ui/NewProjectWizard.tsx (status 기계 · 체크박스 카드 · applyTeam)
  - src/types.ts (AgentRole 5종)
  - src/i18n/index.ts (translate · 3단 폴백)
  - locales/{en,ko}.json (기존 project.newProjectWizard.* 네임스페이스)
  - docs/design/project-creation-agent-recommendation-2026-04-20.md (3단계 플로우 원 시안 — 본 시안이 확장)
  - docs/design/cross-feature-onboarding-and-state-audit-2026-04-21.md (상태 3종·접근성 공통 규약)
  - docs/design/error-recovery-ux-2026-04-21.md (empty/offlineFallback 상태 · RecentRecommendationsButton)
  - docs/design/session-history-page-2026-04-21.md (SessionHistoryRecord · participants 구조)
  - docs/design/mcp-transport-and-language-toggle-2026-04-20.md (SettingsDrawer 섹션 배치)
report-to: Thanos (ae61dfd9-ecc2-4f83-81cd-56d9675ecc2e)
scope:
  - "추천 카드 인라인 편집(역할/이름/프롬프트)·역할 제거/추가(드롭다운)·저장/취소·편집 모드 토글"
  - "추천 근거 상세 드로어: 설명 내 근거 문구 하이라이트 · 대안 역할 2건 · 신뢰도(높음/중간/낮음) 배지"
  - "최근 추천 템플릿 저장소: 저장·이름 지정·공개 여부·재사용(매칭 시 추천 상단 노출)·리스트/상세/삭제"
  - "recommend.* i18n 키 전량 · 저장되지 않은 변경사항 경고 · 단축키(Cmd/Ctrl+Enter) · 접근성(aria-expanded·aria-describedby)"
---

# 추천 편집 · 근거 상세 · 템플릿 저장소 — 심화 시안 (2026-04-21)

직전 `project-creation-agent-recommendation-2026-04-20.md` 가 **추천 → 바로 추가** 축을 고정했다면, 본 시안은 세 가지 심화 축을 얹는다:

1. **편집 후 추가** — 추천 카드를 인라인으로 수정하고 역할 슬롯을 제거/추가.
2. **근거 상세 드로어** — "왜 이 역할?" 에 대한 세 층 답변(하이라이트·대안·신뢰도).
3. **템플릿 저장소** — 사용자가 자주 쓰는 팀 구성을 저장·재사용.

원 시안의 "3단계 1화면 · 한 결정" (P-01, P-04) 을 지키되, 고급 사용자는 편집과 템플릿으로 **자기 작업 스타일을 고정** 할 수 있게 한다. 편집 모드 진입은 **기본 경로를 해치지 않는 opt-in** — `[바로 추가]` 는 언제든 1클릭으로 닫힌다.

우선 검토 파일 `CodeConventionPanel.tsx` 의 "탭 단위 폼 상태 분리 + 전역 폴백 표식"(L60–L80) 패턴은 본 시안 §3 템플릿 저장소의 **"로컬 템플릿 vs 공개 템플릿" 탭 분리** 에 그대로 이식한다. 같은 사용자가 두 스코프를 혼동 없이 편집할 수 있도록, 탭 간 폼 상태는 메모리상 분리되지만 저장은 동일 `templateStore` 로 수렴한다.

---

## 0. 설계 원칙 (Q-01 ~ Q-14)

### 0.1 편집 모드(Q-01 ~ Q-05)

| ID   | 원칙 |
| ---- | ---- |
| Q-01 | **편집 모드는 opt-in 토글 1개**: 헤더의 `[✎ 편집]` 토글이 켜지면 모든 카드가 편집 가능. 끄면 읽기 전용(기본). 카드별 편집 버튼 금지 — 전역 토글이 맥락을 명확히. |
| Q-02 | **인라인 필드 3축만 편집**: `역할`(드롭다운) · `이름`(≤12자 input) · `간단 프롬프트`(≤120자 textarea). 그 외(`rationale`, 근거 하이라이트, 신뢰도) 는 읽기 전용 — 사용자 편집이 추천 엔진 신뢰를 왜곡하지 않도록. |
| Q-03 | **역할 슬롯 제거/추가**: 카드 우상단 `✕` 로 제거, 카드 그리드 끝 `+ 역할 추가` 칩 버튼으로 추가. 추가 시 AgentRole 드롭다운 + `Leader 는 이미 있음` 자동 비활성(Leader 유일성 · `recommendAgentTeam.ts` L98 계승). |
| Q-04 | **저장되지 않은 변경 경고**: 편집 모드 진입 후 **dirty** 상태일 때 모달 닫기·탭 이동·언어 전환 시 확인 다이얼로그. `SharedGoalModal` 의 dirtyClose 규약 계승. |
| Q-05 | **Cmd/Ctrl+Enter = 저장**: 편집 모드에서 전역 단축키. 포커스가 어느 필드에 있어도 동작. `Esc` = 편집 취소(변경 버리기 확인 후). |

### 0.2 근거 상세 드로어(Q-06 ~ Q-09)

| ID   | 원칙 |
| ---- | ---- |
| Q-06 | **3 층 답변**: "왜 이 역할?" 에 대해 ① 설명 내 근거 문구 하이라이트(근거), ② 대안 역할 2건(선택지), ③ 신뢰도 배지(확신 정도) 세 층을 제공. 사용자가 추천을 "따를지·바꿀지·무시할지" 결정할 수 있는 최소 정보. |
| Q-07 | **하이라이트는 원문 그대로**: 프로젝트 설명 문장에서 매칭된 키워드를 `<mark>` 로 강조. 번역·요약 금지(사용자 콘텐츠 보존 규약 `project-creation-agent-recommendation-2026-04-20.md` §5 계승). |
| Q-08 | **대안은 "교체 버튼"**: 대안 역할 카드에 `[이 역할로 교체]` 버튼. 클릭 시 현재 카드의 role 만 바꾸고 name/프롬프트는 기본값으로 초기화. |
| Q-09 | **신뢰도 배지 3단**: 높음(emerald ✓✓) · 중간(amber ~) · 낮음(ghost ?). 수치 노출 금지 — "92%" 같은 숫자는 과신을 부른다. |

### 0.3 템플릿 저장소(Q-10 ~ Q-12)

| ID   | 원칙 |
| ---- | ---- |
| Q-10 | **2 스코프**: `로컬(내 템플릿)` · `공개(팀 공유)`. 기본 로컬. 공개 토글은 "이 템플릿을 팀과 공유" 체크박스로 명시. 공개 템플릿은 즉시 팀 전체가 읽기 전용으로 확인 가능. |
| Q-11 | **자동 매칭 노출**: 새 프로젝트 설명 입력 시 템플릿의 `descriptionKeywords` 와 매칭(tfidf · 단순 해시태그) → 추천 상단에 "저장된 템플릿 사용하시겠어요?" 배너 1장. 사용자가 선택하면 추천 카드 교체. |
| Q-12 | **삭제는 2단계 되돌리기**: 삭제 즉시 카드가 회색 처리 + 3초 `[되돌리기]` 토스트. 3초 후 영구 삭제. `SharedGoalModal` 의 "토스트 되돌리기 3초" 규약 계승. |

### 0.4 i18n · 접근성(Q-13 ~ Q-14)

| ID   | 원칙 |
| ---- | ---- |
| Q-13 | **`recommend.*` 네임스페이스로 통일**: 기존 `project.newProjectWizard.*` 는 유지하되, 신설 문구는 전부 `recommend.*` 로 분리. 이유: 템플릿·근거·편집은 위저드 외에도 여러 화면(프로젝트 설정, 세션 이력 "이어서 작업") 에서 재사용될 수 있다. |
| Q-14 | **편집 폼은 `aria-expanded`·`aria-describedby` 필수**: 편집 모드 토글 버튼 → `aria-expanded` · 각 편집 필드 → `aria-describedby="{field}-error-hint"` 로 검증 에러 즉시 연결. 근거 상세 드로어는 `role="dialog" aria-modal="false"` (모달 아님, 뒤 카드 읽기 가능). |

---

## 1. 편집 후 추가 플로우

### 1.1 편집 모드 진입 · 카드 레이아웃

```
┌ 추천 팀 (3명)                                  [👁 읽기] [✎ 편집]          ┐
│                                                                             │
│  (편집 모드 ON)                                                              │
│  ┌─ RoleCard (편집 상태) 260×180 ─────────────────────────────────────┐      │
│  │ 역할 [Leader ▾]        이름 [Kai________]                [✕ 제거]  │      │
│  │                                                                    │      │
│  │ 간단 프롬프트 (≤120자)                                                │      │
│  │ ┌──────────────────────────────────────────────────────────────┐    │      │
│  │ │ 팀 분배·진행 관리에 집중해 주세요. 매일 한 번 진척 보고.        │    │      │
│  │ └──────────────────────────────────────────────────────────────┘    │      │
│  │                                                    54/120           │      │
│  │                                                                    │      │
│  │ 근거: 기본 팀 구성 · 신뢰도 높음 ✓✓                   [근거 상세 →] │      │
│  └────────────────────────────────────────────────────────────────────┘      │
│                                                                             │
│  ┌─ RoleCard ─────────┐  ┌─ RoleCard ─────────┐                              │
│  │ 역할 [Developer ▾]  │  │ 역할 [Designer ▾]   │                              │
│  │ ...                │  │ ...                │                              │
│  └────────────────────┘  └────────────────────┘                              │
│                                                                             │
│  ┌── + 역할 추가 ──────┐                                                     │
│  │  [▾ 역할 선택]      │  ← 카드 대신 점선 테두리 · 클릭 시 확장              │
│  └────────────────────┘                                                     │
│                                                                             │
│  ⌨ Cmd/Ctrl+Enter 저장 · Esc 취소               [취소] [저장하고 팀 3명 추가] │
└─────────────────────────────────────────────────────────────────────────────┘
```

- 편집 모드 카드는 폭 260·높이 180(읽기 카드 192·120 대비 +). 필드 진입 후 키보드 탐색 시 카드 경계를 벗어나지 않도록 포커스 트랩은 아님(원래 Tab 순으로 다음 카드로 이동).
- `[✕ 제거]` 는 카드 우상단. Leader 카드는 `[✕]` 를 **disabled + 툴팁 "Leader 는 필수입니다"**(Q-03 Leader 유일성).

### 1.2 역할 드롭다운

- AgentRole 5종. 이미 팀에 있는 역할은 **상단 섹션 "대체"** 에 표시(클릭 시 현재 카드가 그 역할로 바뀌고 중복 역할 카드가 사라지면서 맞춤).
- Leader 는 이미 있는 카드에서만 선택 가능(다른 카드에서 Leader 로 바꾸려 하면 "Leader 는 카드당 1개만 가능" 툴팁).

### 1.3 저장 · 취소 · 버튼 레이블

| 상황                     | 버튼 레이블 · 상태                                                        |
| ------------------------ | ------------------------------------------------------------------------- |
| 편집 모드 off(기본)        | `[저장 안 함] [팀 3명 추가]` — 원 시안 유지                                 |
| 편집 모드 on, dirty=false | `[취소]`(회색) · `[저장 안 함]`(disabled) · `[팀 3명 추가]`                  |
| 편집 모드 on, dirty=true  | `[취소]` · `[변경 저장]`(ghost) · `[저장 후 팀 N명 추가]`(primary)            |
| 검증 에러 존재            | `[저장 후 팀 N명 추가]` disabled + `aria-describedby` 로 필드 에러 연결        |

### 1.4 검증 규칙

- 이름: 1~12자 · `^[A-Za-z가-힣0-9 ._-]+$` · 공백 trim. 빈 값이면 역할명으로 자동 복구.
- 간단 프롬프트: 0~120자(빈 값 허용 — 기본 rationale 사용). 제어문자 차단.
- 역할: ROLE_CATALOG 안 값. Leader 중복 금지. 최소 2명 · 최대 5명(`recommendAgentTeam.ts` 정책 계승).
- 에러는 필드 바로 아래 11px 빨간 문구 + `aria-describedby` 1:1.

### 1.5 dirty 가드 · 확인 다이얼로그

- 편집 모드 ON 이후 한 필드라도 바뀌면 `dirty=true`.
- 닫기(`Esc` · 모달 닫기 · 언어 전환 · 탭 이동) 시 `dirty=true` 이면 `window.confirm` 대신 **인라인 확인 배너**:

```
┌─ 저장되지 않은 변경이 있어요 ───────────────────────┐
│ 닫으면 변경이 사라집니다. 계속할까요?                │
│                          [변경 저장 후 닫기]  [취소] │
│                          [변경 버리기]              │
└─────────────────────────────────────────────────────┘
```

- 3단 선택: `[변경 저장 후 닫기]` primary · `[취소]` ghost · `[변경 버리기]` danger ghost.
- 포커스: 첫 진입 시 `[취소]` (안전 기본값).

### 1.6 단축키 (Q-05)

| 키                     | 동작                                                                 |
| ---------------------- | -------------------------------------------------------------------- |
| Cmd/Ctrl + Enter       | 저장 + 적용(저장 후 팀 N명 추가). 편집 필드 안에서도 동작              |
| Cmd/Ctrl + S           | 저장만(추가 안 함) · 읽기 모드로 전환하지 않음                         |
| Esc                    | 편집 취소(dirty 시 §1.5 배너) · 카드 포커스로 복귀                      |
| E (편집 모드 off)        | 편집 모드 토글 ON. 카드에 포커스가 있을 때만                              |
| Delete (카드 포커스)    | 현재 카드 제거(Leader 제외) + 3초 되돌리기 토스트                       |
| Cmd/Ctrl + /             | 단축키 치트시트 오버레이(읽기 전용)                                     |

---

## 2. 추천 근거 상세 드로어

### 2.1 배치 · 진입

```
┌ 추천 모달 ─────────────────────────────────┬─ RecommendationDetailDrawer (폭 420px) ─┐
│ (추천 카드들 — 드로어와 함께 부드럽게 좁아짐)  │ 🔍 왜 "Designer" 를 추천했나요?  [✕]     │
│                                             │─────────────────────────────────────────│
│                                             │                                         │
│                                             │ 📝 프로젝트 설명 내 근거                  │
│                                             │ ─────────────────────────                 │
│                                             │ "사내 일정 공유 웹앱을 만들고              │
│                                             │  [[접근성 감사]]까지 한 번에               │
│                                             │  끝내고 싶어요."                          │
│                                             │                                         │
│                                             │ 강조 문구 키워드: **접근성**               │
│                                             │                                         │
│                                             │ 🎯 신뢰도                                 │
│                                             │ ─────────────────────────                 │
│                                             │ ┌───────────────────┐                    │
│                                             │ │ ✓✓ 높음            │ ← emerald badge   │
│                                             │ └───────────────────┘                    │
│                                             │ "접근성" 키워드가 명시적으로 포함돼 있어요. │
│                                             │                                         │
│                                             │ 🔄 대안 역할                              │
│                                             │ ─────────────────────────                 │
│                                             │ ┌─ Researcher ────────────────────┐      │
│                                             │ │ 접근성 표준·논문 조사             │      │
│                                             │ │ 신뢰도 중간 ~                     │      │
│                                             │ │ [이 역할로 교체]                 │      │
│                                             │ └───────────────────────────────────┘      │
│                                             │ ┌─ QA ────────────────────────────┐      │
│                                             │ │ 접근성 회귀 테스트               │      │
│                                             │ │ 신뢰도 중간 ~                    │      │
│                                             │ │ [이 역할로 교체]                 │      │
│                                             │ └───────────────────────────────────┘      │
│                                             │                                         │
└─────────────────────────────────────────────┴─────────────────────────────────────────┘
```

- 드로어 폭 420px (세션 이력 드로어 520px 보다 좁음 — 정보량이 적음).
- `role="dialog"` + `aria-modal="false"` — 모달 아님. 뒤 카드와 상호작용 가능.
- 열기: 카드의 `[근거 상세 →]` 링크 · 키보드 `Shift+D` (카드 포커스 시).
- 닫기: Esc · `[✕]` · 뒤 카드 클릭.

### 2.2 하이라이트 구현

- 프로젝트 설명 원문을 그대로 표시(번역·요약 금지).
- 매칭 키워드 영역은 `<mark>` 태그 · 배경 `var(--color-info-surface)` · 글자 bold. 선행 시안 `session-history-page-2026-04-21.md` §3.1 검색 강조 규약 재사용.
- 매칭이 없는 기본 추천(Leader 등) 은 "**기본 팀 구성**으로 추천됐어요." 문구 + 하이라이트 영역 숨김.
- 하이라이트 후 아래 "강조 키워드: **{keyword}**" 줄에 실제 키워드 나열(다중 매칭 시 쉼표 구분).

### 2.3 신뢰도 배지 3단

| 단계    | 배지 시각                        | 팔레트                          | 본문 설명 예시                                       |
| ------- | -------------------------------- | ------------------------------- | ---------------------------------------------------- |
| 높음     | `✓✓ 높음` · emerald · rounded md | `--color-success` + surface     | 키워드 명시 매칭 · LLM 응답 confidence ≥ 0.85          |
| 중간     | `~ 중간` · amber                   | `--color-warning` + surface     | 부분 매칭 · confidence 0.6~0.85                         |
| 낮음     | `? 낮음` · ghost · 점선 테두리     | `--color-text-subtle`            | 기본 팀 폴백 · confidence < 0.6 또는 heuristic 전용    |

- 숫자 노출 금지(Q-09). 사용자는 확신 "정도" 만 본다.
- 색 + 아이콘 + 텍스트 3중 신호(선행 시안 O-14 계승).

### 2.4 대안 역할 2건

- 각 대안 카드: `역할명 · 한 줄 설명(≤40자) · 신뢰도 · [이 역할로 교체]`.
- 교체 동작: 현재 편집 중인 카드(드로어를 연 카드) 의 role 만 바뀌고, name 은 기본 alias, prompt 는 빈 값으로 리셋. `aria-live="polite"` 로 "{원래 역할} 에서 {새 역할} 로 교체했어요" 낭독.
- 대안이 2건 미만이면 "대안이 더 이상 없어요. 기본 추천을 사용하세요." 정적 문구.

### 2.5 근거 상세 드로어가 동시에 여러 카드에 열리지 않도록

- 한 번에 한 카드만 상세 가능. 다른 카드의 `[근거 상세 →]` 클릭 시 드로어가 **슬라이드 없이 내용만 교체** + 상단에 `"Developer → Designer"` breadcrumbs 1회 깜빡임.

---

## 3. 최근 추천 템플릿 저장소

### 3.1 데이터 모델(제안)

```ts
// src/utils/recommendationTemplates.ts (신규 제안 · Thanos 구현 참고)
export interface RecommendationTemplate {
  readonly id: string;
  readonly scope: 'local' | 'public';
  readonly ownerId: string;
  readonly name: string;                          // 사용자 지정 ≤ 24자
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly items: ReadonlyArray<AgentRecommendation>; // recommendAgentTeam.ts 스키마 재사용
  readonly descriptionKeywords: ReadonlyArray<string>; // 매칭 판정용 · 최대 10개
  readonly sampleDescription?: string;            // 저장 시점의 설명 원문(요약 표시용)
  readonly usageCount: number;                    // 재사용 횟수
  readonly lastUsedAtMs: number | null;
}
```

- 저장: IndexedDB(`llmtycoon-recommendation-templates-v1`). 로컬은 사용자 ID 키, 공개는 팀 전체 공유 키.
- 최대 50개 로컬 + 50개 공개 / 사용자(`usageCount` 낮은 순으로 초과분 파기 힌트).

### 3.2 저장 플로우 (추천 결과 → 템플릿)

```
추천 모달(편집 후) → [⋮ 더 보기] → [💾 템플릿으로 저장]
   │
   ▼
┌ TemplateSaveDialog ────────────────────────────────────┐
│ 템플릿 저장                                              │
│                                                         │
│ 이름 *                                                   │
│ [ 웹앱 · 접근성 감사 팀                    ]  (24/24)    │
│                                                         │
│ 이 설명을 함께 저장해 나중에 매칭에 씁니다:                 │
│  "사내 일정 공유 웹앱을 만들고 접근성 감사까지…"           │
│                                                         │
│ ☐ 팀과 공유(공개 템플릿)                                  │
│     공개하면 같은 프로젝트 팀원이 읽기 전용으로 씁니다.      │
│                                                         │
│ 매칭 키워드(자동 추출)                                    │
│ [웹앱] [접근성] [감사]  [+ 추가]  · 최대 10개              │
│                                                         │
│                                          [취소] [저장]   │
└─────────────────────────────────────────────────────────┘
```

- 이름 빈 값이면 "{첫 매칭 키워드} 팀" 자동 제안.
- 공개 토글 시 경고 배너: "공개하면 팀 전체가 템플릿과 포함된 프롬프트를 볼 수 있어요. 개인정보·토큰을 포함하지 마세요."
- 저장 후 성공 토스트 + `[템플릿 관리 열기]` 버튼.

### 3.3 템플릿 관리 화면 (리스트 + 상세)

설정 드로어의 새 섹션 `[💾 추천 템플릿]` (토큰 탭 다음, 단축키 치트시트 이전).

#### 3.3.1 리스트

```
┌ 추천 템플릿 관리 ────────────────────────────────────────┐
│                                                           │
│  [내 템플릿 (7)] [공개 템플릿 (2)]          [+ 현재 팀 저장]│
│                                                           │
│  검색: [_______________________]                          │
│                                                           │
│  ┌ TemplateCard ───────────────────────────────┐          │
│  │ 💾 웹앱 · 접근성 감사 팀                        │          │
│  │ 4명 · 👑🛠♿QA  · 매칭 키워드 3개                │          │
│  │ 최근 사용 2일 전 · 누적 7회                      │          │
│  │ "사내 일정 공유 웹앱을 만들고…"  (truncate)      │          │
│  │                   [자세히]  [삭제]               │          │
│  └──────────────────────────────────────────────┘          │
│                                                           │
│  ┌ TemplateCard ───────────────────────────────┐          │
│  │ 💾 결제 보안 강화 팀                             │          │
│  │ ...                                            │          │
│  └──────────────────────────────────────────────┘          │
│                                                           │
│  [보관함 비우기(오래된 10건)]                              │
└───────────────────────────────────────────────────────────┘
```

- 탭 2개: `내 템플릿 / 공개 템플릿`. `CodeConventionPanel` 의 로컬·전역 탭 패턴(우선 검토 파일) 을 그대로 이식 — 스코프 전환 시 폼 상태 분리.
- 카드 우측 `[자세히]` 는 상세 드로어 오픈, `[삭제]` 는 §3.5 2단계 토스트.
- 정렬: 기본 `usageCount` 내림차순 → `updatedAtMs` 내림차순.

#### 3.3.2 상세 드로어

`session-history-page-2026-04-21.md` §2 드로어 패턴 재사용(폭 480px).

```
┌ TemplateDetailDrawer ──────────────────────────────────┐
│ 💾 웹앱 · 접근성 감사 팀                          [✕]   │
│ 로컬 · 업데이트 2026-04-19 · 누적 7회 사용              │
│────────────────────────────────────────────────────────│
│                                                         │
│ 포함된 역할(4명)                                        │
│   👑 Kai · Leader  —  기본 팀 구성                        │
│   🛠 Dev · Developer  —  "웹앱" 키워드                    │
│   ♿ Ada · Designer  —  "접근성" 키워드                   │
│   🧪 QA  · QA  —  회귀 방지                               │
│                                                         │
│ 매칭 키워드: [웹앱] [접근성] [감사]                        │
│                                                         │
│ 저장 시점 설명                                           │
│ "사내 일정 공유 웹앱을 만들고 접근성 감사까지…"           │
│                                                         │
│ [🔁 이 템플릿으로 적용]  [✎ 편집]  [📤 공개 전환]  [🗑 삭제]│
└────────────────────────────────────────────────────────┘
```

- `[🔁 이 템플릿으로 적용]` : 현재 열려 있는 추천 모달의 카드를 이 템플릿으로 교체(현재 편집 내용은 dirty 가드 §1.5 재사용).
- `[✎ 편집]` : 템플릿 이름·설명·키워드 편집 모드.
- `[📤 공개 전환]` / `[📤 비공개 전환]` : 스코프 이동. 2단계 확인(공개 → 비공개는 원클릭).

### 3.4 자동 매칭 — 추천 상단 배너

새 프로젝트 설명 입력 중, 키워드 일치 템플릿이 있으면 **추천 카드 위** 에 배너 1장:

```
┌ 자동 매칭 템플릿 발견 ─────────────────────────────────┐
│ 💡 '웹앱 · 접근성 감사 팀' (누적 7회 사용) 과 설명이 일치해요. │
│ 이 템플릿으로 시작할까요?                                │
│                         [아니요] [이 템플릿으로 시작] │
└────────────────────────────────────────────────────────┘
```

- 매칭 판정: `descriptionKeywords ∩ tokens(description) ≥ 2` 이거나 최고 매칭 점수 ≥ 0.6. 여러 템플릿 일치 시 `usageCount` 상위 1건만 배너.
- `[아니요]` : 배너 숨김(세션 한정). 같은 세션에서 같은 템플릿은 다시 배너로 안 뜸.
- `[이 템플릿으로 시작]` : 추천 카드를 템플릿 items 로 즉시 교체. `source` 라벨에 `template` 추가(기존 `heuristic/claude/cache/translated` 4종 + 1).

### 3.5 삭제 — 2단계 되돌리기

```
 리스트 카드 [삭제] 클릭
   │  1) 카드가 회색 + 취소선
   ▼
 토스트: "'웹앱 · 접근성 감사 팀' 을 삭제했어요"  [되돌리기] 3초
   │
   │  되돌리기 클릭 → 복구
   │  3초 경과 → 영구 삭제(IndexedDB 레코드 지움)
```

- `ToastProvider` 표준 되돌리기 액션(선행 시안 `error-recovery-ux-2026-04-21.md` 참조).
- 공개 템플릿 삭제는 **"팀 전체에서 사라집니다" 1회 확인 다이얼로그** 후 동일 2단계.

### 3.6 공개 템플릿 보안

- 저장 전 프롬프트 스캔: `API_KEY` · `Bearer ` · 이메일 정규식 매칭 시 경고 + 블록.
- 공개 후에도 1회 자동 스캔(지연 검증) — 위험 패턴 감지 시 자동 비공개 전환 + 소유자에게 알림.
- 본 시안은 UX 면만 명세. 실구현 정책은 `Joker/Thanos` 협의.

---

## 4. 접근성 · 키보드 · 스크린리더

### 4.1 편집 모드

| 요소                      | 속성                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `[✎ 편집]` 토글            | `aria-pressed` · `aria-expanded` · `aria-controls="role-cards-grid"`                  |
| 역할 드롭다운              | `<select>` 또는 `role="combobox"` · `aria-haspopup="listbox"` · `aria-expanded`        |
| 이름 input                  | `aria-label="에이전트 이름"` · `aria-describedby="name-hint-{id}"`                     |
| 간단 프롬프트 textarea       | `aria-label="간단 프롬프트"` · `aria-describedby="prompt-hint-{id} prompt-error-{id}"` |
| 제거 버튼 ✕                 | `aria-label="{role} 카드 제거"` · Leader 카드는 `aria-disabled="true"` + 툴팁          |
| 검증 에러 문구              | `role="alert"` + `id="{field}-error-{cardId}"` · input 과 `aria-describedby` 로 1:1   |
| dirty 확인 배너             | `role="alertdialog"` + `aria-modal="false"` + `aria-labelledby`                       |

### 4.2 근거 상세 드로어

| 요소                   | 속성                                                                         |
| ---------------------- | ---------------------------------------------------------------------------- |
| 드로어 루트             | `role="dialog"` · `aria-modal="false"` · `aria-labelledby="rationale-title"`   |
| 하이라이트 `<mark>`     | 기본 속성 유지(AT 가 자동 강조 낭독)                                          |
| 신뢰도 배지             | `role="img"` + `aria-label="신뢰도 높음"` / `"신뢰도 중간"` / `"신뢰도 낮음"`    |
| 대안 카드 교체 버튼      | `aria-label="{current} 에서 {alternative} 로 교체"`                           |
| breadcrumbs(카드 전환)   | `aria-live="polite"` · 1회 "{prev} 에서 {next} 로 전환" 낭독                   |

### 4.3 템플릿 저장소

| 요소                 | 속성                                                                            |
| -------------------- | ------------------------------------------------------------------------------- |
| 탭 리스트             | `role="tablist"` + 각 탭 `role="tab"` · `aria-selected`                          |
| 템플릿 리스트          | `role="list"` · 각 카드 `role="listitem"`                                        |
| 자동 매칭 배너          | `role="status"` · `aria-live="polite"` · "템플릿 매칭됨: {name}, 적용하시겠어요?" |
| 삭제 토스트(되돌리기)   | `role="status"` · `aria-live="polite"` + `[되돌리기]` 버튼 포커스 가능           |
| 공개 전환 확인         | `role="alertdialog"` · "팀 전체가 볼 수 있습니다. 계속할까요?"                    |

### 4.4 키보드 치트시트 (드로어 내장)

| 키                    | 컨텍스트                   | 동작                                         |
| --------------------- | -------------------------- | -------------------------------------------- |
| `E`                    | 추천 카드 포커스            | 편집 모드 토글                               |
| `Cmd/Ctrl + Enter`     | 편집 모드 어디서든           | 저장 후 팀 추가                              |
| `Cmd/Ctrl + S`          | 편집 모드 어디서든           | 저장만                                        |
| `Esc`                   | 편집 모드                   | 취소(dirty 시 §1.5)                            |
| `Shift + D`              | 카드 포커스                  | 근거 상세 드로어 열기                          |
| `Delete`                 | 카드 포커스                  | 제거(Leader 제외) + 되돌리기 토스트            |
| `T`                       | 추천 결과 전체 포커스         | 템플릿으로 저장 다이얼로그 오픈                  |
| `Cmd/Ctrl + /`             | 어디서든                     | 치트시트 오버레이(읽기 전용)                    |

- 치트시트는 `KeyboardShortcutCheatsheet` 기존 패널에 "추천 · 템플릿" 섹션으로 합류(신규 컴포넌트 금지).

---

## 5. 상태 3종 (로딩 · 빈 · 오류)

선행 시안 `cross-feature-onboarding-and-state-audit-2026-04-21.md` §3.1 규약 재사용.

| 상태                           | 컴포넌트                        | 문구(키)                                               |
| ------------------------------ | ------------------------------- | ------------------------------------------------------ |
| 템플릿 목록 로딩                | `EmptyState variant="loading"`   | `recommend.template.loading`                            |
| 템플릿 0건(최초)                | `EmptyState variant="empty"`     | `recommend.template.empty.firstRun.*`                   |
| 검색 결과 0건                   | `EmptyState variant="empty"`     | `recommend.template.empty.noMatch.*`                    |
| 공개 템플릿 로드 실패(오프라인)  | `ErrorState tone="warning"`      | `recommend.template.error.offline.*` (선행 시안 §3.4)   |
| 자동 매칭 실패(LLM 호출 실패)    | 상단 배너 숨김(무반응)           | 빈 응답과 동일 취급 — 무음 스킵                        |

---

## 6. 토큰 · 타이포

신규 토큰 **0건**. 모두 재사용.

| 영역                        | 토큰                                           |
| --------------------------- | ---------------------------------------------- |
| 편집 카드 외곽 강조           | `--color-accent` (focus) / `--color-border`     |
| 검증 에러 텍스트              | `--color-danger`                                |
| 신뢰도 높음 배지              | `--color-success` / `--color-success-surface`   |
| 신뢰도 중간 배지              | `--color-warning` / `--color-warning-surface`   |
| 신뢰도 낮음 배지              | `--color-text-subtle` + 점선                    |
| 하이라이트 `<mark>`           | `--color-info-surface` + `--color-info`          |
| 템플릿 카드 hover 그림자      | `--media-preview-card-shadow`                   |
| 공개 템플릿 배지              | `--color-info-surface` + 자물쇠 열림 아이콘     |
| 숫자(사용 횟수)               | `.tok-num` + `--font-mono` (선행 시안 §5.3)      |
| 본문(한국어/영어)              | `--font-sans` · 라인하이트 1.35(ko) / 1.25(en)   |

---

## 7. i18n 키 후보 — `recommend.*`

> `locales/{en,ko}.json` 에 평면화해 이관. 기존 `project.newProjectWizard.*` 키는 건드리지 않는다(Q-13).

### 7.1 편집 모드

| 키                                           | 한국어                                              | English                                              |
| -------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| `recommend.edit.toggle.on`                    | ✎ 편집                                              | ✎ Edit                                                |
| `recommend.edit.toggle.off`                   | 👁 읽기                                              | 👁 Read                                                |
| `recommend.edit.role.label`                    | 역할                                                | Role                                                  |
| `recommend.edit.name.label`                    | 이름                                                | Name                                                   |
| `recommend.edit.name.placeholder`              | 예: Kai                                              | e.g., Kai                                              |
| `recommend.edit.name.counter`                   | {current}/{max}                                      | {current}/{max}                                        |
| `recommend.edit.prompt.label`                   | 간단 프롬프트                                         | Short prompt                                           |
| `recommend.edit.prompt.placeholder`              | 이 에이전트에게 전달할 추가 지시(선택)                  | Additional instruction for this agent (optional)        |
| `recommend.edit.prompt.counter`                  | {current}/{max}                                      | {current}/{max}                                        |
| `recommend.edit.removeCard.aria`                 | {role} 카드 제거                                      | Remove {role} card                                     |
| `recommend.edit.removeCard.leaderDisabled`        | Leader 는 필수입니다                                   | Leader is required                                     |
| `recommend.edit.addSlot.label`                     | + 역할 추가                                            | + Add role                                             |
| `recommend.edit.addSlot.picker`                    | 역할 선택                                               | Select role                                            |
| `recommend.edit.addSlot.leaderTaken`                | Leader 는 이미 있어요                                    | Leader already taken                                    |
| `recommend.edit.addSlot.max`                        | 최대 5명까지 추가할 수 있어요                            | Up to 5 agents                                          |
| `recommend.edit.validation.name.empty`              | 이름을 입력해 주세요                                      | Please enter a name                                    |
| `recommend.edit.validation.name.tooLong`            | 이름은 {max}자 이하여야 해요                              | Name must be {max} characters or fewer                 |
| `recommend.edit.validation.name.pattern`             | 이름은 영숫자·한글·._- 만 사용 가능해요                    | Name may contain letters, digits, Hangul, and ._-       |
| `recommend.edit.validation.prompt.tooLong`           | 프롬프트는 {max}자 이하여야 해요                           | Prompt must be {max} characters or fewer               |
| `recommend.edit.validation.prompt.control`            | 프롬프트에 제어문자가 포함돼 있어요                        | Prompt contains control characters                     |
| `recommend.edit.validation.minMembers`                | 최소 {min}명이 필요해요                                    | At least {min} members required                         |

### 7.2 저장 · 취소 · 단축키

| 키                                              | 한국어                                                   | English                                               |
| ----------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| `recommend.edit.action.cancel`                   | 취소                                                      | Cancel                                                 |
| `recommend.edit.action.saveOnly`                  | 변경 저장                                                  | Save changes                                           |
| `recommend.edit.action.saveAndApply`               | 저장 후 팀 {count}명 추가                                   | Save & add {count} agents                              |
| `recommend.edit.shortcut.hint`                     | ⌨ Cmd/Ctrl+Enter 저장 · Esc 취소                             | ⌨ Cmd/Ctrl+Enter save · Esc cancel                      |
| `recommend.edit.dirtyGuard.title`                   | 저장되지 않은 변경이 있어요                                   | You have unsaved changes                               |
| `recommend.edit.dirtyGuard.body`                    | 닫으면 변경이 사라집니다. 계속할까요?                         | If you close, changes will be lost. Continue?           |
| `recommend.edit.dirtyGuard.saveAndClose`              | 변경 저장 후 닫기                                            | Save & close                                           |
| `recommend.edit.dirtyGuard.keepEditing`               | 취소                                                        | Cancel                                                 |
| `recommend.edit.dirtyGuard.discard`                    | 변경 버리기                                                  | Discard changes                                        |

### 7.3 근거 상세 드로어

| 키                                                | 한국어                                                          | English                                                    |
| ------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------- |
| `recommend.rationale.drawer.title`                  | 왜 "{role}" 을 추천했나요?                                         | Why "{role}"?                                               |
| `recommend.rationale.drawer.closeAria`              | 근거 상세 닫기                                                    | Close rationale drawer                                     |
| `recommend.rationale.source.title`                    | 프로젝트 설명 내 근거                                              | Evidence in your description                                |
| `recommend.rationale.source.emptyDefault`              | **기본 팀 구성**으로 추천됐어요.                                     | Recommended as **default core team**.                        |
| `recommend.rationale.source.keywordsLabel`             | 강조 문구 키워드                                                    | Highlighted keywords                                        |
| `recommend.rationale.confidence.title`                  | 신뢰도                                                            | Confidence                                                 |
| `recommend.rationale.confidence.high`                    | ✓✓ 높음                                                           | ✓✓ High                                                     |
| `recommend.rationale.confidence.medium`                   | ~ 중간                                                             | ~ Medium                                                    |
| `recommend.rationale.confidence.low`                      | ? 낮음                                                             | ? Low                                                       |
| `recommend.rationale.confidence.high.body`                 | 설명에 이 역할과 직접 관련된 키워드가 있어요.                         | Your description contains keywords directly tied to this role. |
| `recommend.rationale.confidence.medium.body`               | 부분적 단서만 있어요 — 대안도 함께 고려하세요.                         | Only partial cues — consider the alternatives too.           |
| `recommend.rationale.confidence.low.body`                   | 기본 팀 폴백으로 추천됐어요. 설명을 보강해 주세요.                     | Default fallback — please enrich the description.            |
| `recommend.rationale.alternatives.title`                    | 대안 역할                                                          | Alternative roles                                           |
| `recommend.rationale.alternatives.empty`                     | 대안이 더 이상 없어요.                                               | No more alternatives.                                       |
| `recommend.rationale.alternatives.replace`                    | 이 역할로 교체                                                       | Replace with this role                                       |
| `recommend.rationale.alternatives.replacedLive`                | "{from}" 에서 "{to}" 로 교체했어요                                     | Replaced "{from}" with "{to}"                                |
| `recommend.rationale.breadcrumb`                              | "{prev}" 에서 "{next}" 로 전환                                          | Switched from "{prev}" to "{next}"                            |

### 7.4 템플릿 저장 · 관리

| 키                                                  | 한국어                                                            | English                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| `recommend.template.save.dialog.title`                | 템플릿 저장                                                         | Save as template                                            |
| `recommend.template.save.name.label`                   | 이름                                                               | Name                                                       |
| `recommend.template.save.name.placeholder`              | 예: 웹앱 · 접근성 감사 팀                                            | e.g., Web app · accessibility audit team                    |
| `recommend.template.save.description.label`              | 이 설명을 함께 저장해 매칭에 씁니다                                    | Also save this description for future matching              |
| `recommend.template.save.keywords.label`                 | 매칭 키워드(자동 추출)                                               | Matching keywords (auto-extracted)                           |
| `recommend.template.save.keywords.add`                    | + 추가                                                              | + Add                                                      |
| `recommend.template.save.keywords.maxHint`                 | 최대 {max}개                                                        | Up to {max}                                                  |
| `recommend.template.save.public.toggle`                     | 팀과 공유(공개 템플릿)                                                | Share with team (public template)                           |
| `recommend.template.save.public.warning`                     | 공개하면 팀 전체가 템플릿과 포함된 프롬프트를 볼 수 있어요. 개인정보·토큰을 포함하지 마세요. | Publishing makes the template and its prompts visible to the team. Don't include secrets. |
| `recommend.template.save.action.save`                        | 저장                                                                | Save                                                       |
| `recommend.template.save.action.cancel`                       | 취소                                                                | Cancel                                                     |
| `recommend.template.save.toast.saved`                          | 템플릿 '{name}' 을 저장했어요                                          | Saved template "{name}"                                     |
| `recommend.template.save.toast.openManager`                     | 템플릿 관리 열기                                                      | Open template manager                                      |
| `recommend.template.list.title`                                 | 추천 템플릿 관리                                                       | Recommendation templates                                   |
| `recommend.template.list.tab.mine`                              | 내 템플릿 ({count})                                                    | My templates ({count})                                      |
| `recommend.template.list.tab.public`                            | 공개 템플릿 ({count})                                                  | Public templates ({count})                                  |
| `recommend.template.list.searchPlaceholder`                      | 템플릿 검색                                                            | Search templates                                            |
| `recommend.template.list.saveCurrent`                            | + 현재 팀 저장                                                          | + Save current team                                         |
| `recommend.template.list.purgeOld`                                | 보관함 비우기(오래된 {n}건)                                              | Purge old ({n})                                              |
| `recommend.template.card.meta.members`                             | {count}명                                                               | {count} members                                              |
| `recommend.template.card.meta.keywords`                             | 매칭 키워드 {count}개                                                    | {count} matching keywords                                    |
| `recommend.template.card.meta.lastUsed`                              | 최근 사용 {relativeTime}                                                 | Last used {relativeTime}                                     |
| `recommend.template.card.meta.usageCount`                            | 누적 {count}회                                                          | Used {count} times                                           |
| `recommend.template.card.action.detail`                               | 자세히                                                                   | Details                                                     |
| `recommend.template.card.action.delete`                               | 삭제                                                                     | Delete                                                      |
| `recommend.template.detail.closeAria`                                  | 템플릿 상세 닫기                                                         | Close template details                                      |
| `recommend.template.detail.scope.local`                                 | 로컬                                                                     | Local                                                       |
| `recommend.template.detail.scope.public`                                | 공개                                                                     | Public                                                      |
| `recommend.template.detail.membersTitle`                                 | 포함된 역할({count}명)                                                    | Included roles ({count})                                     |
| `recommend.template.detail.keywordsTitle`                                 | 매칭 키워드                                                               | Matching keywords                                            |
| `recommend.template.detail.sampleTitle`                                    | 저장 시점 설명                                                             | Saved description                                           |
| `recommend.template.detail.action.apply`                                    | 🔁 이 템플릿으로 적용                                                       | 🔁 Apply this template                                        |
| `recommend.template.detail.action.edit`                                     | ✎ 편집                                                                    | ✎ Edit                                                      |
| `recommend.template.detail.action.makePublic`                                | 📤 공개 전환                                                                | 📤 Make public                                               |
| `recommend.template.detail.action.makePrivate`                                | 📥 비공개 전환                                                              | 📥 Make private                                              |
| `recommend.template.detail.action.delete`                                     | 🗑 삭제                                                                     | 🗑 Delete                                                     |
| `recommend.template.delete.toast.deleted`                                      | '{name}' 을 삭제했어요                                                       | Deleted "{name}"                                            |
| `recommend.template.delete.toast.undo`                                         | 되돌리기                                                                     | Undo                                                        |
| `recommend.template.publish.confirm.title`                                      | 공개로 전환할까요?                                                           | Publish this template?                                      |
| `recommend.template.publish.confirm.body`                                       | 팀 전체가 읽기 전용으로 볼 수 있어요.                                        | The team will see it (read-only).                           |
| `recommend.template.publish.scan.warning`                                        | 프롬프트에 민감 정보(API 키·이메일 등) 가 포함되어 있어요. 공개 불가.           | Sensitive info (API key, email, …) detected — cannot publish. |
| `recommend.template.match.banner`                                                 | 💡 '{name}' ({usageCount}회 사용) 과 설명이 일치해요. 이 템플릿으로 시작할까요? | 💡 Matches "{name}" (used {usageCount}×). Start with it?      |
| `recommend.template.match.useIt`                                                   | 이 템플릿으로 시작                                                            | Start with this template                                    |
| `recommend.template.match.dismiss`                                                  | 아니요                                                                         | No thanks                                                   |

### 7.5 상태 3종

| 키                                                     | 한국어                                                   | English                                             |
| ------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------- |
| `recommend.template.loading`                             | 템플릿을 불러오는 중…                                      | Loading templates…                                   |
| `recommend.template.empty.firstRun.title`                 | 저장된 템플릿이 없어요                                      | No saved templates yet                               |
| `recommend.template.empty.firstRun.body`                  | 추천 결과에서 [⋮]→[💾 템플릿으로 저장] 을 눌러 팀 구성을 보관해 두세요. | Save a team from the recommendation menu to reuse later. |
| `recommend.template.empty.noMatch.title`                   | 검색 결과가 없어요                                          | No matches                                           |
| `recommend.template.empty.noMatch.body`                    | 다른 이름·키워드로 검색해 보세요.                            | Try different names or keywords.                     |
| `recommend.template.error.offline.title`                   | 공개 템플릿을 불러오지 못했어요                               | Couldn't load public templates                        |
| `recommend.template.error.offline.body`                    | 오프라인 상태 · 로컬 템플릿만 표시합니다.                     | Offline — showing local templates only.               |

---

## 8. 결정 대기

| ID    | 질문                                                                        | 대상     |
| ----- | --------------------------------------------------------------------------- | -------- |
| R-Q1  | 편집 모드 ON 일 때 "바로 추가" 경로를 완전히 대체하는지, 함께 노출하는지          | Thanos   |
| R-Q2  | 간단 프롬프트 최대 120자가 에이전트 시스템 프롬프트 prefix 로 들어갈 때 토큰 영향 | Thanos   |
| R-Q3  | 근거 상세 드로어의 `<mark>` 하이라이트 영역이 여러 키워드 겹칠 때 시각 우선순위     | QA       |
| R-Q4  | 신뢰도 배지 판정 임계(0.6 / 0.85) 를 사용자가 조정하게 할지                       | Thanos   |
| R-Q5  | 자동 매칭 배너가 설명 입력 중 디바운스 간격(현재 wizard 400ms) 이상으로 더 늦춰야 하는지 | QA      |
| R-Q6  | 공개 템플릿의 민감 정보 스캔 규칙 — 정규식만 vs LLM 필터 추가                      | Thanos   |
| R-Q7  | 템플릿 최대 보관(50개/스코프) 이 충분한지 · 사용자 조정 허용 여부                  | Kai      |
| R-Q8  | 삭제 되돌리기 3초가 공개 템플릿에도 동일 적용되는지 vs 공개는 즉시 영구 삭제            | Kai      |
| R-Q9  | `E` 단축키가 대화 입력 중에도 편집 모드를 켤 위험(→ 카드 포커스 시만 동작 제한 확인) | QA       |
| R-Q10 | 자동 매칭 source 라벨을 기존 `heuristic/claude/cache/translated` 4종에 `template` 추가 시 UI 영향 | Thanos  |

---

## 9. 파일 배치(구현 지침)

```
src/ui/recommend/                               (신규 디렉터리 — 위저드에서 분리)
  RecommendationCard.tsx                         (읽기/편집 두 모드 · 단일 컴포넌트)
  RecommendationEditToggle.tsx                   (헤더 토글 + aria-pressed/expanded)
  AddRoleSlot.tsx                                (§1.1 + 역할 추가 칩)
  DirtyGuardBanner.tsx                            (§1.5 인라인 확인)
  RationaleDrawer.tsx                             (§2 근거 상세)
  ConfidenceBadge.tsx                              (§2.3 3단)
  TemplateSaveDialog.tsx                            (§3.2)
  TemplateListPanel.tsx                             (§3.3.1 — SettingsDrawer 섹션)
  TemplateDetailDrawer.tsx                          (§3.3.2)
  TemplateMatchBanner.tsx                            (§3.4)

src/utils/
  recommendationTemplates.ts                        (§3.1 스토어 · 순수)
  recommendationTemplateMatcher.ts                    (§3.4 키워드 매칭 순수)
  recommendationDirty.ts                               (§1.5 순수 diff 판정)
  sensitivePatternScanner.ts                            (§3.6 민감 정보 패턴)

src/ui/NewProjectWizard.tsx                          (기존 · 편집 토글 통합)
src/components/SettingsDrawer.tsx                    (기존 · "💾 추천 템플릿" 섹션 추가)
src/components/KeyboardShortcutCheatsheet.tsx         (기존 · "추천·템플릿" 그룹 추가)

locales/en.json · locales/ko.json                   (§7 recommend.* 전량)
```

- 모든 변경: 기존 토큰 재사용. 신규 CSS 변수 · 신규 토큰 **0건**.
- 순수 유틸 4개(Dirty diff · 키워드 매칭 · 템플릿 스토어 · 민감 패턴 스캔) 는 전부 `node:test` 단위 테스트로 회귀 잠금 권장.

---

## 10. 후속 · 범위 밖

- **팀 템플릿 다국어화**: 저장 시점 설명은 원문 유지. UI 카피만 locale 에 따라 번역.
- **AI 자동 네이밍**: 템플릿 이름 자동 제안을 LLM 으로 확장(현재 키워드 기반). 후속 PR.
- **공유 URL 링크**: 공개 템플릿을 URL 로 공유(예: `/t/abc123`). 본 시안 범위 밖.
- **사용 이력 그래프**: 템플릿 재사용 빈도 시각화 — 세션 이력 페이지에 합류할지 후속 검토.

---

끝.
