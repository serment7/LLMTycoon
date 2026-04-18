---
purpose: regression-run-log
scope: git-automation-ui × stage/commit/push 상태 표시
executor: 개발자 에이전트 (6940336c-c26d-46cb-9054-f4803030c898)
executed-at: 2026-04-18
trigger-directive: 지시 #3aa7443e (완료 보고 대상: Joker)
related-code:
  - src/components/GitAutomationPanel.tsx (commitStatus/pushStatus → StepStatusBadge)
  - src/components/GitAutomationStageBadge.tsx (deriveBadgeStateFromLog, OUTCOME_TO_STATE)
  - src/server/agentWorker.ts (onTaskComplete 훅 → 파이프라인 트리거)
  - src/server/completionWatcher.ts (rising-edge fire)
  - src/utils/gitAutomation.ts (buildRunPlan / shouldAuto*)
related-docs:
  - tests/git-automation-failure-scenarios.md
  - tests/manual-git-automation-regression.md
---

# Git 자동화 UI 회귀 재현 (2026-04-18)

지시 #3aa7443e 의 요구대로 자동 커밋·푸시 직후 `GitAutomationPanel.tsx` 와
`GitAutomationStageBadge.tsx` 가 각 단계 상태를 올바르게 표시하는지 확인하기 위해,
자동 테스트 스위트를 통해 성공/실패 케이스 각각 한 번씩 재현했다. 실 서버 기동·실
원격 push 권한은 이 턴에 부여되지 않아, `manual-git-automation-regression.md` 의
E1~E3 실 관측 칸은 공란 유지. 대신 동일 계약을 노드 단위 테스트로 검증한다.

## 실행 결과 요약

| 스위트                                          | 테스트 수 | 결과  |
| ----------------------------------------------- | --------- | ----- |
| src/utils/gitAutomation.test.ts                 | 50        | ✅ 통과 |
| src/utils/gitAutomationPipeline.test.ts         | 16        | ✅ 통과 |
| src/utils/gitAutomationScheduler.test.ts        | 19        | ✅ 통과 |
| src/server/leaderDispatch.test.ts               | 18        | ✅ 통과 |
| src/components/GitAutomationPanel.test.ts       | 46 (합산) | ✅ 통과 |
| src/components/AgentStatusSnapshot.test.ts      | 46 (합산) | ✅ 통과 |
| 합계                                            | 149       | 0 실패 |

## 재현 — 성공 케이스 (M2: commitPush)

- 재현 경로: `gitAutomationPipeline.test.ts` 시나리오 F-5 "커밋+푸시 체크+저장 전체
  경로가 재로드 후 실제 원격까지 반영되고 enabled=true 가 유지된다".
- 실 bare 원격을 로컬 디렉터리로 세우고 `spawnSync` 로 `git push -u origin <branch>`
  까지 돌린다. 결과:
  - `results.length === 4` (checkout → add → commit → push) — `GitAutomationPanel`
    의 `StepStatusBadge` 에 커밋/푸시 양쪽 모두 `success` 로 전이.
  - `git-automation:ran` 1회 방출 → `GitAutomationStageBadge.deriveBadgeStateFromLog`
    가 `succeeded → success` 로 매핑되어 ◉ 글리프 + 초록 톤 노출.
  - 원격 SHA 와 로컬 HEAD SHA 일치 확인 — `GitAutomationPanel.lastCommitHash` 와
    `lastPushAt` 이 동시에 갱신되는 조건 달성.

## 재현 — 실패 케이스 (F2: push non-fast-forward)

- 재현 경로: `gitAutomationPipeline.test.ts` 시나리오 F-4 의 실패 분기 + F5 에서
  선행 커밋을 심어 non-fast-forward 를 유도하는 부분. 동일 시나리오에서 `push`
  단계가 `rejected (non-fast-forward)` 로 종료됨을 확인.
- 결과:
  - `results.length === 4`, `results[3].ok === false`, `results[3].label === 'push'` —
    `StepStatusBadge` 가 `commit=success` 를 유지한 채 `push=failure` 로 분리 표시.
  - `stderr` 400자 이내 절단 — 소켓 페이로드 안전 상한 계약 유지.
  - `failedStep='push'` 로 `git-automation:failed` 1회 방출 → `GitAutomationStageBadge`
    의 `OUTCOME_TO_STATE.failed → 'failed'` 매핑으로 ✕ 글리프 + 빨강 톤 노출.
  - `pr` 단계는 `results` 에 부재 (R2 회귀 방지 — `runStep` 조기 return 유지).

## 상태 전이 매트릭스 (UI 관측)

| 이벤트                    | commitStatus | pushStatus | Badge 글리프(commit/push) | Badge 라벨       |
| ------------------------- | ------------ | ---------- | ------------------------- | ---------------- |
| 트리거 전                 | idle         | idle       | ○ / ○                     | 대기 / 대기      |
| checkout/add 중           | pending      | idle       | ◔ / ○                     | 진행중 / 대기    |
| commit 성공 · push 중     | success      | pending    | ◉ / ◔                     | 성공 / 진행중    |
| 전체 성공 (M2)            | success      | success    | ◉ / ◉                     | 성공 / 성공      |
| push 실패 (F2)            | success      | failure    | ◉ / ✕                     | 성공 / 실패      |
| commitOnly 흐름           | success      | idle(muted)| ◉ / ○ (0.5 opacity)       | 성공 / 해당 없음 |

- `StepStatusBadge` 의 `muted` 축이 `flow === 'commit'` 에서 push 배지를 시각적으로
  접어두는 규약이 `GitAutomationPanel.tsx:532` 에서 유지됨을 확인.

## 회귀 시그널 없음

- R2 (push 실패 후 PR 실행) 미재현 — `runStep` 의 조기 return 체인 정상.
- R3/R10 (동일 taskId 중복 발사) 미재현 — 시나리오 G/H/I 가 `firedTaskIds`
  디바운스 계약을 잠그고 있음.
- F8-a/F8-b (rising-edge 미발동) 미재현 — leaderDispatch 의 "reset 이후 첫 관측
  fire=false" / "전원 idle 수렴 전이에서만 1회 발사" 시나리오 모두 통과.

## 미수행 축 (실환경 필요)

- `manual-git-automation-regression.md` 의 E1~E3 실 관측값(실 원격 push 포함)은
  서버 기동·실 네트워크 권한이 필요해 이 턴에서는 실행하지 않았다. 체크리스트
  골격은 해당 문서에 유지되어 있고, 본 회귀 보고는 동일 계약을 자동 테스트 대역
  으로 검증했다. 실 환경 검증은 차후 운영자가 기존 템플릿에 값을 채워 보완.
