---
purpose: qa-prep
scope: 자동 개발 ON 상태의 '태스크 경계 커밋' 가드 · GitAutomationPanel 하이드레이션 레이스 · 한국어 커밋 템플릿
executor: QA 에이전트
prepared-at: 2026-04-19
trigger-directive: 지시 #a6604cb0 (완료 보고 대상: 리더 Kai)
style-reference: fdda31b(test: 상단바 Claude 토큰 사용량 위젯 회귀 테스트 U1~U4 + 진리표 + QA 준비 문서 추가)
related-code:
  - src/utils/gitAutomation.ts (shouldAutoCommit · shouldAutoPush · shouldAutoOpenPR · formatCommitMessage · formatPrTitle · commit)
  - src/components/GitAutomationPanel.tsx (DEFAULT_AUTOMATION · validateNewBranchName)
  - src/components/ProjectManagement.tsx (1587ea9 하이드레이션 레이스 수정)
  - src/server/agentWorker.ts (현재 onTaskBoundary 훅 부재)
  - src/utils/claudeTokenUsageStore.ts (ClaudeSessionStatus 타입)
related-tests:
  - tests/taskBoundaryCommit.regression.test.ts (7건)
  - tests/gitAutomationPanel.regression.test.tsx (7건)
  - tests/commitMessageTemplate.regression.test.ts (11건)
---

# 태스크 경계 커밋 QA 준비 문서 (2026-04-19)

## 0. 배경 · 문제 정의

지시 #a6604cb0 은 "자동 개발 ON 상태의 태스크 경계 커밋" 에 대한 1차 회귀 테스트를
세 파일로 분산 추가하도록 요구했다. 본 문서는 그 세 파일의 **범위 · 성공 기준 ·
지시 본문과 실 구현 간 용어 괴리** 를 기록하여, 이후 구현이 붙을 때 같은 잣대로
업데이트할 수 있게 한다.

## 1. 지시 ↔ 실 구현 용어 매핑

| 지시 본문 표현 | 실 구현 식별자 | 위치 |
| --- | --- | --- |
| `onTaskBoundary` 훅 | **부재**(도입 전) | 예상 위치 `src/server/agentWorker.ts` |
| `commitStrategy` 별 | **부재** — 실제는 `FlowLevel` + `enabled` 조합 가드 | `src/utils/gitAutomation.ts` |
| 수동 모드 | `enabled === false` (`AutoFlowGuardInput`) | `shouldAutoCommit` 등 |
| 폴백 모드 `sessionStatus='exhausted'` 큐잉 | **부재** — 타입만 존재(`ClaudeSessionStatus`) | `src/utils/claudeTokenUsageStore.ts` |
| 한국어 커밋 제목 템플릿 | `formatCommitMessage(config, ctx)` | `src/utils/gitAutomation.ts` line 172 |
| 최근 커밋 스타일(fdda31b · d0a2e68) | `"{type}: {summary}"` 포맷에 사용자 입력 요약 그대로 삽입 | 좌동 |

핵심 판단: 본 QA 사이클에서는 **부재를 부재로 명시적으로 잠그고**, 실제로 존재하는
`shouldAutoCommit`/`formatCommitMessage`/`DEFAULT_AUTOMATION` 의 계약을 촘촘히 고정한다.
이후 `onTaskBoundary` 훅이 도입되면 `taskBoundaryCommit.regression.test.ts` 의 부재
잠금 어설션을 **호출 규약 어설션** 으로 교체해 동일 파일 안에서 승격시킨다.

## 2. 파일 단위 범위 · 성공 기준

### 2.1 `tests/taskBoundaryCommit.regression.test.ts` (7건)

- 수동 모드(enabled=false) — 세 가드 모두 false (1건, 모든 FlowLevel 에 대해)
- FlowLevel 진리표 — commitOnly/commitPush/commitPushPR × {commit, push, pr} (1건)
- `enabled=undefined` 레거시 경로 — commit 허용, push/pr 차단 (1건)
- `commit(config, ctx)` — 차단 시 빈 배열 · 허용 시 checkout/add/commit 3단계 (2건)
- 부재 잠금 — `onTaskBoundary` · `commitStrategy` 심볼이 agentWorker.ts 에 없음 (1건)
- 부재 잠금 — `sessionStatus==="exhausted"` 큐잉 / `commitQueue` 자료구조 없음 (1건)

**성공 기준**: 7건 전부 통과하며, 위 세 부재 잠금 어설션이 미래 도입 시점에
유의미한 회귀 신호를 준다(도입 이후 테스트 업데이트 필요).

### 2.2 `tests/gitAutomationPanel.regression.test.tsx` (7건)

- 1587ea9 ① 로딩 박스는 공용 `EmptyState(variant="loading")` + `testId="git-automation-panel-loading"` 로 구성
- 1587ea9 ② 로드 판정은 `gitAutomationByProject[selectedProjectId] === undefined`
- 1587ea9 ③ 프로젝트 전환 시 `React.Fragment key={selectedProjectId || 'no-project'}` 로 재마운트
- 1587ea9 ④ onSave 는 `structuredClone` 후 slot 과 localStorage 를 동기 갱신
- `DEFAULT_AUTOMATION` 기본값 계약 (flow='commit' · enabled=true · branchStrategy='per-session' 등 7 필드)
- `validateNewBranchName` — 정상/공백/중복 특수문자/허용 외 문자 분기
- `validateNewBranchName` — 선·후행 `/`, `.`, `-` 거부(6 케이스)

**성공 기준**: ProjectManagement 의 래퍼 분기 4가지가 정규식 매칭으로 잠기고,
Panel 의 공개 상수/함수가 직접 호출 기반으로 회귀된다. 본 파일은 패널 전체 렌더를
시도하지 않는다(의존 훅 다수로 jsdom 불안정) — DOM 상호작용 회귀는 후속 별도
스위트로 확장한다(§5).

### 2.3 `tests/commitMessageTemplate.regression.test.ts` (11건)

- plain / conventional / conventional+scope 3종 포맷 (3건)
- 빈 summary → `'update'` 폴백 / 빈 type → `'chore'` 폴백 / type 소문자화 (3건)
- fdda31b · d0a2e68 실제 커밋 요약 보존 — 괄호·물결표·한국어 조사 무변형 (2건)
- 순수성 — 같은 입력은 같은 출력, 변경 파일 수를 함수가 모름(책임 분리) (1건)
- `formatPrTitle` — 한국어 summary/branch 토큰 삽입 · 빈 결과 시 summary/`'update'` 폴백 (2건)

**성공 기준**: 11건 전부 통과. 특히 "변경 파일 수 0건 스킵" 은 본 함수의 책임이
아니라 상위 `gitAutomationPipeline.test.ts` (scenario-e `empty commit should fail`)
가 잠근다는 **책임 분리 명시** 가 주석으로 유지된다.

## 3. 실행 · 재현

```
npx tsx --test tests/taskBoundaryCommit.regression.test.ts
npx tsx --test tests/gitAutomationPanel.regression.test.tsx
npx tsx --test tests/commitMessageTemplate.regression.test.ts
```

세 파일 합계 **25건**이 모두 `pass` 상태로 끝나야 커밋 가능. 인접 회귀(커밋
파이프라인 · 브랜치 전략 · SharedGoalForm) 스위트와 함께 돌려도 무회귀여야 한다.

## 4. 지시 본문과의 의도적 차이

지시는 다음을 요구했으나 **현재 구현에 심볼 자체가 없어** 실행 가능 회귀로
승격시키지 못한다. 본 사이클에서는 부재를 정적 잠금으로 대체했다.

1. `agentWorker.ts::onTaskBoundary` 훅 — 정의부 자체 없음.
2. `commitStrategy` 별 호출 분기 — 실제는 `FlowLevel` 열거형 + `enabled` 마스터.
3. `sessionStatus='exhausted'` 큐잉 — 타입은 있으나 커밋 경로와 결합된 로직 없음.

이 세 항목이 구현되면 `taskBoundaryCommit.regression.test.ts` 의 "부재 잠금"
두 어설션을 **긍정 계약 어설션** 으로 교체(훅 호출 횟수·큐잉 FIFO 순서·수동 모드
무호출)해 동일 파일의 범위를 그대로 확장한다.

## 5. 후속 인계 (우선순위 높음 → 낮음)

1. `agentWorker.ts` 에 `onTaskBoundary` 훅 도입 시 본 QA 문서 §2.1 을 호출 규약 표로
   확장하고, 해당 테스트 파일의 부재 잠금을 호출 카운터 기반 어설션으로 전환.
2. `ClaudeSessionStatus === 'exhausted'` 진입 시 커밋 큐잉 자료구조(이름 후보:
   `pendingCommitQueue`) 를 도입하고, FIFO 리플레이 순서를 회귀로 잠근다.
3. `GitAutomationPanel` 전체 렌더 E2E — jsdom 28 · React Testing Library 로 flow 라디오
   변경 → onSave 콜백 호출까지의 경로를 잠근다. 훅 의존성을 stub 으로 대체하는
   harness 가 선행 필요(`useReducedMotion` · `useProjectOptions`).
4. 커밋 메시지에 한국어 요약이 담긴 상태로 git push 시 깨짐 여부(서버 셸 인코딩)
   를 `gitAutomationPipelineSmoke.test.ts` 확장으로 검증.

## 6. 검증 한 줄

> 태스크 경계 커밋의 "가드 · 저장 레이스 · 템플릿 포맷" 축을 각각 7 · 7 · 11건으로
> 잠그고, 훅/큐잉의 **부재**는 정적으로 명시해 도입 시 동일 회귀 면적이 자동 승격
> 되도록 연결했다.
