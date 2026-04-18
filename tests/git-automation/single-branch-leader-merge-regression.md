---
purpose: regression-scenarios
scope: 4-agent concurrent edits × leader single-branch consolidation × commit/push × UI
ticket: 707420d5
owner: 개발자 에이전트 (6940336c-c26d-46cb-9054-f4803030c898)
written-at: 2026-04-18
report-to: 리더 Kai (7efcca3d-9d2e-4c46-9df0-c6b01352048c)
related-code:
  - src/components/AgentStatusPanel.tsx (GitAutomationStageRow, 단계 배지·실패 배너)
  - src/components/GitAutomationPanel.tsx (commitStatus/pushStatus, StepStatusBadge)
  - src/components/GitAutomationStageBadge.tsx (deriveBadgeStateFromLog, OUTCOME_TO_STATE)
  - src/server/taskRunner.ts (handleWorkerTaskComplete, firedTaskIds 디바운스)
  - src/server/completionWatcher.ts (rising-edge fire, ProjectCompletionTracker)
  - src/server/leaderDispatch.test.ts (allAgentsCompletedWatcher 계약)
  - src/utils/gitAutomation.ts (buildRunPlan, shouldAutoCommit/Push)
  - src/utils/gitAutomationPipeline.test.ts (F-시리즈 시나리오)
sibling-docs:
  - tests/manual-git-automation-regression.md (M1~M4, L1~L5, N1~N4)
  - tests/git-automation-failure-scenarios.md (F1~F8)
  - tests/git-automation-ui-regression-20260418.md (성공/실패 케이스 재현 로그)
---

# 단일 브랜치 통합 커밋·푸시 회귀 시나리오 (4인 동시 작업 → 리더 통합)

지시 #707420d5 의 요구대로 **팀원 4명이 동시에 서로 다른 파일을 편집한 뒤,
리더 단일 브랜치에 모든 변경이 통합되어 한 번의 커밋·푸시로 원격에 반영되는 경로**
를 회귀 케이스로 잠근다. 워커 단위 발사(`handleWorkerTaskComplete`) 와 리더 단위
rising-edge 발사(`completionWatcher.ts`) 가 동시에 살아 있는 환경에서 **단일 브랜치**
계약이 깨지는 모든 분기를 시나리오 S1~S6 으로 정리한다.

기존 시나리오와의 차이:
- `manual-git-automation-regression.md` 의 L1~L5 는 **fire 횟수** 만 다룬다.
- `git-automation-failure-scenarios.md` 의 F1~F8 은 **단일 단계 실패** 에 집중한다.
- 본 문서는 **"4인 동시 작업이 단일 브랜치로 합쳐지는 결합 동작"** 을 다룬다 —
  브랜치 분기/충돌 해소/UI stage 표기까지 한 번에 검증한다.

---

## 전제 조건 (S1~S6 공통)

- 리더 1명(Kai) + 팀원 4명(Developer×2, QA×1, Designer×1).
- 자동 개발 ON, Git 자동화 `enabled:true`, `flowLevel:'commitPush'`.
  - PR 축은 본 문서 범위 외(필요 시 S6 의 확장 노트 참고).
- `branchTemplate: '{type}/{ticket}-{slug}'` (현재 프로젝트 설정값과 동일).
- `firedTaskIds` 디바운스 세트는 서버 재기동 시점에 비어 있어야 한다.
- 워크스페이스 시작 시 `git status --short` 가 비어 있고 (또는 사전 커밋·stash
  로 격리), HEAD 가 `main` 의 최신 SHA 와 일치해야 한다.
- 4명의 합성 태스크는 **서로 다른 4개 파일** 을 각각 편집하도록 프롬프트를 분리.
  같은 파일을 편집하면 S5(충돌) 축으로 자동 분기.

---

## S1 — 4인 순차 완료 → 단일 브랜치에 누적 커밋

**목표**: 4명이 시간차를 두고 done 을 보고할 때, 모든 변경이 **같은 한 브랜치**
에 누적되어 마지막 한 번의 push 로 원격에 반영되는지 확인.

### 절차

1. ⬜ 4인에게 합성 태스크 dispatch. 의도적으로 한 번에 한 명씩 done 보고하도록
   프롬프트 분량을 다르게 조정.
2. ⬜ 첫 번째 done 시점 — 워커 단위 fire 1회 → `feature/chore/707420d5-<slug>`
   체크아웃 + 변경 파일 1개 add/commit + push.
3. ⬜ 두 번째 done — **새 브랜치 생성 없이** 같은 브랜치 유지, 변경 파일 1개
   추가 commit + push.
4. ⬜ 세 번째·네 번째 done 도 동일 패턴.
5. ⬜ 4명 모두 idle 로 수렴하는 첫 tick 에 rising-edge fire 가 1회 더 발사
   되지만, 작업 트리가 비어 있어 `nothing to commit` 으로 commit 단계 실패 →
   push 미실행 → 회귀 신호 아님(아래 "정상 실패 분리" 참조).

### 기대값

| 관측 축 | 기대                                                                      |
| ------- | ------------------------------------------------------------------------- |
| 브랜치 수 | 1개 (`feature/chore/707420d5-<slug>`) — 모든 done 이 같은 이름 재사용     |
| `git-automation:ran` | 4회 (워커 단위)                                              |
| 누적 커밋 SHA | 4개 — 원격 `git ls-remote` 결과와 로컬 `git log` 가 일치              |
| rising-edge fire | 1회 (전원 idle 수렴 tick) — `failedStep='commit'` + `nothing to commit` 로 종료 |
| `firedTaskIds` 등록 | 4건 (taskId 별 1건) + rising-edge 는 별도 축                         |

### UI 관측 — `AgentStatusPanel.tsx::GitAutomationStageRow`

각 done 직후 단계 행이 다음 전이를 따라야 한다:

| done 순번 | commit 배지 | push 배지 | pr 배지 | 배너                          |
| --------- | ----------- | --------- | ------- | ----------------------------- |
| 1번 직후  | success     | success   | idle    | "푸시 완료 — `<sha7>`"        |
| 2번 직후  | success     | success   | idle    | 동일 (새 sha 로 갱신)         |
| 3번 직후  | success     | success   | idle    | 동일                          |
| 4번 직후  | success     | success   | idle    | 동일                          |
| rising-edge 직후 | failed      | idle      | idle    | "커밋이 완료되지 않았습니다 — 커밋 단계에서 실패" + 사유 `nothing to commit` |

- `GitAutomationStageRow` 가 마지막 fire 의 `nothing to commit` 실패 배너를
  덮어씌우면 사용자가 4번의 성공 push 결과를 볼 수 없게 된다 → S1 의 핵심 회귀.
- 기대 동작: 마지막 rising-edge 실패는 **별도의 "후행 정리 fire"** 로 분리
  하여 직전 push 성공 배너를 덮지 않는다. 단계 배지는 마지막 성공 sha 를 유지.

### 정상 실패 분리 — `nothing to commit` 은 회귀가 아니다

- 4인 워커 fire 가 모든 변경을 이미 흡수한 뒤 rising-edge 가 1회 더 발사되면
  작업 트리는 비어 있고 commit 단계가 `nothing to commit` 으로 실패한다. 이는
  계약상 정상이며, 워커 로그에 `[commit] exit=1 — nothing to commit` 한 줄만
  남는다. push 단계는 미실행이므로 원격 상태는 변하지 않는다.
- 이 "후행 정리 fire" 가 **2회 이상** 보이면 R3 회귀(디바운스 누수). 1회는 정상.

### 회귀 시그널

| 코드 | 신호                                                                | 의심 위치                                       |
| ---- | ------------------------------------------------------------------- | ----------------------------------------------- |
| S1-a | 브랜치가 2개 이상 생성됨                                            | `branchTemplate` slug 가 매 fire 마다 새로 계산됨 — slug 결정 로직이 timestamp/random 을 포함하면 안 됨 |
| S1-b | rising-edge fire 가 0회 — 후행 정리 fire 자체가 없음                | `ProjectCompletionTracker.previousPhase` 가 첫 워커 fire 직후 `completed` 로 고착(N1) |
| S1-c | rising-edge fire 가 2회 이상                                        | `firedTaskIds` 가 워커 축과 리더 축을 공유 → R3 회귀 |
| S1-d | 마지막 rising-edge 실패 배너가 직전 push 성공 배너를 덮음           | `GitAutomationStageRow` 가 모든 fire 를 동일 슬롯에 직렬 렌더 — 분리 슬롯 필요 |
| S1-e | 누적 커밋 SHA 가 4개 미만                                           | 워커 단위 fire 가 commit 단계에서 조용히 실패 → 디바운스 충돌 또는 한국어 게이트 재시도 누수 |

---

## S2 — 4인 동시 완료 → 한 tick 안에 수렴

**목표**: 한 tick 안에 4명 모두 done 을 보고하는 극단 케이스에서, 워커 fire 4회와
rising-edge fire 1회가 충돌 없이 직렬화되어 단일 브랜치에 합쳐지는지 확인.

### 절차

1. ⬜ 4인 태스크 길이를 동일하게 맞춰 동시 dispatch.
2. ⬜ 한 tick 안에 모두 done 보고 → 상태 궤적 `[w,w,w,w] → [i,i,i,i]`.
3. ⬜ 워커 fire 가 직렬로 4회 발사되는지 서버 stdout 로 확인 (병렬 발사 금지 —
   동일 워크스페이스에 동시 `git checkout` 이 들어가면 잠금 충돌).
4. ⬜ 4회 fire 모두 같은 브랜치를 재사용하는지, 두 번째 이후 fire 가 `git checkout -b`
   대신 `git checkout` (기존 브랜치) 로 떨어지는지 확인.
5. ⬜ rising-edge fire 1회는 S1 과 동일하게 `nothing to commit` 으로 정리.

### 기대값

- 브랜치 1개, 누적 커밋 4개, push 4회 (각 워커 fire 마다 1회).
- 워커 fire 사이에 잠금 충돌 (`fatal: Unable to create '.git/index.lock': File exists`)
  발생 시 → 회귀(S2-a). 직렬화 큐가 누수된 것.
- `git-automation:ran` 4회 모두 `results.length == 4`.

### 회귀 시그널

| 코드 | 신호                                                            | 의심 위치                                                                |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| S2-a | `index.lock` 잠금 충돌                                          | `executeGitAutomation` 의 워크스페이스 mutex 누수 — 같은 projectId 직렬화 누락 |
| S2-b | 두 번째 워커 fire 가 새 브랜치를 만듦                           | `buildRunPlan` 의 brnach 결정이 "현재 HEAD 가 main 인가?" 만 보고 기존 feature 브랜치 무시 |
| S2-c | rising-edge fire 가 워커 fire **중간** 에 발사                  | `ProjectCompletionTracker` 가 `[i,i,w,w]` 같은 부분 idle 에서 false positive |
| S2-d | UI 단계 배지가 `running → success` 전이를 한 번도 안 보여줌      | 4회 fire 가 너무 빨라 React 렌더가 마지막 상태만 잡음 — 개입 불필요(시각적 한계), 단 버블 토스트는 4건 모두 떠야 함 |

---

## S3 — 부분 완료 후 1인이 working 재진입 (L3 변형)

**목표**: 4인 중 3명 완료 후 1명이 working 으로 재진입하는 패턴에서, 단일 브랜치
계약이 깨지지 않고 rising-edge fire 가 정확히 2회 발사되는지 확인.

### 절차

1. ⬜ 상태 궤적: `[w,w,w,w] → [i,i,i,w] → [i,i,i,i]` (1차 수렴) → `[i,i,i,w]` (재진입)
   → `[i,i,i,i]` (2차 수렴).
2. ⬜ 1차 수렴 시 rising-edge fire 1회. 작업 트리가 이미 비어 있다면 `nothing to commit`
   으로 종료(정상). 아니면 잔여 변경을 흡수해 commit/push.
3. ⬜ 재진입한 워커가 done 보고 → 워커 fire 1회 (5번째 워커 fire) → 같은 브랜치
   에 추가 커밋·push.
4. ⬜ 2차 수렴 시 rising-edge fire 1회 더 → `nothing to commit` 종료(정상).

### 기대값

- 브랜치 1개 유지.
- 누적 커밋: 4 (S1) + 1 (재진입) = 5개. 단 워커 fire 가 변경을 모두 흡수했다면
  rising-edge fire 의 `nothing to commit` 은 카운트에 포함하지 않음.
- rising-edge fire 정확히 2회 (L3 와 동일 — `manual-git-automation-regression.md` L3 참고).

### 회귀 시그널

- rising-edge fire 가 1회뿐 → tracker 가 1차 수렴 후 `previousPhase` 를 `busy`
  로 다시 올리지 못한 것 → "재가입 직후 재무장" 규약 회귀.
- 재진입 워커 fire 가 새 브랜치를 만듦 → S1-a 와 동일 분기, `branchTemplate` slug
  결정 로직이 시간 의존적임을 의미.
- 재진입 후 단계 배지가 commit=failed 인데 `errorMessage` 가 비어 있으면
  `GitAutomationStageRow::firstFailedStage.errorMessage` 폴백 분기 누수.

---

## S4 — 한국어 게이트 재시도 중복 (R10 결합)

**목표**: 4인 중 1명의 응답이 한국어 비율 게이트에서 거부되어 같은 taskId 로
완료 이벤트를 2~3회 재발행하는 상황에서, 단일 브랜치 계약과 디바운스가 모두
유지되는지 확인.

### 절차

1. ⬜ 1명의 응답에 영문 비율을 임계치 근처로 강제 (`koreanRatio.ts` 의 임계 = 0.7).
2. ⬜ 첫 turn 거부 → 재시도 → 통과. 그 사이 done 이벤트가 2~3번 발사될 수 있음.
3. ⬜ `firedTaskIds` 가 첫 발사만 통과시키고 나머지를 `skipped='debounced'` 로
   탈락시키는지 워커 로그로 확인.
4. ⬜ 나머지 3명은 정상 완료. 전원 idle 수렴 시 rising-edge fire 1회.

### 기대값

- 워커 fire 4회 (재시도 turn 의 중복 호출은 디바운스로 차단).
- 누적 커밋 4개, 브랜치 1개.
- rising-edge fire 1회 (`nothing to commit` 으로 정리).
- 워커 로그에 `skipped='debounced'` 라인이 1~2개 (재시도 횟수에 따라 다름).

### 회귀 시그널

- 워커 fire 가 5회 이상 → R3/R10 회귀, `firedTaskIds.has` 가드 파손.
- rising-edge fire 가 0회 → 리더 tracker 가 워커 디바운스 세트를 잘못 공유해
  본인 fire 도 차단된 상태.
- 같은 taskId 의 commit 이 2개 이상 누적 → 중복 실행이 실제 git 명령까지 침투.

---

## S5 — 같은 파일을 2명이 편집 → 충돌 해소 경로

**목표**: 4명 중 2명이 **같은 파일** 을 서로 다른 내용으로 편집한 경우, 두 번째
워커 fire 가 commit 단계에서 어떻게 동작하는지 확인. 단일 브랜치에 두 변경이
모두 들어가야 하므로, 두 번째 commit 은 첫 번째 commit 의 결과 위에서 다시
diff 를 계산해야 한다.

### 절차

1. ⬜ Developer A 와 Developer B 가 모두 `src/components/CollabTimeline.tsx`
   를 편집. A 는 라인 10 근처, B 는 라인 100 근처(겹치지 않는 영역).
2. ⬜ A 가 먼저 done → 워커 fire 1 → commit 1 + push 1 → 원격에 A 의 변경 반영.
3. ⬜ B 가 done → 워커 fire 2:
   - **B 의 워크스페이스가 A 의 commit 을 이미 반영** 하고 있어야 한다 (워커가
     편집할 때 본 base 가 최신 HEAD). 만약 워커가 stale snapshot 위에서 편집했다면
     git add 단계에서 단순 누적 commit 이 되거나, push 가 non-fast-forward 로 실패.
4. ⬜ B 가 같은 파일의 다른 영역을 편집했다면 commit 성공 → push 성공.
5. ⬜ B 가 같은 영역을 다른 내용으로 편집했다면 conflict 가 아닌 단순 덮어쓰기
   (워커가 파일을 통째로 Write 한 경우) — 회귀 신호. Edit 기반 변경은 충돌
   감지가 commit 시점이 아닌 add 시점에 일어나지 않음.

### 기대값

| 케이스                        | commit 결과          | push 결과     | UI 단계 배지       |
| ----------------------------- | -------------------- | ------------- | ------------------ |
| 비겹침 영역                   | success              | success       | success/success    |
| 같은 영역, Edit 기반          | success (덮어쓰기)   | success       | success/success    |
| 같은 영역, 워커 stale snapshot | success              | failed (NFF)  | success/failed + 배너 |

### 회귀 시그널

- 두 번째 워커 fire 가 새 브랜치를 만들어 B 의 변경만 푸시 → S1-a 분기.
- 두 번째 push 가 `--force` 로 떨어져 A 의 commit 이 사라짐 → **즉시 리더 보고**.
  자동화는 어떤 경로에서도 force push 를 사용하면 안 된다.
- `GitAutomationStageRow` 의 실패 배너가 push NFF 사유를 노출하지 않음 →
  `firstFailedStage.errorMessage` 가 stderr 400자 슬라이스를 받지 못함.

---

## S6 — push 실패 후 리더 단일 브랜치 복구

**목표**: 4인 중 마지막 워커 fire 의 push 가 NFF 로 실패한 상황에서, 리더가
단일 브랜치를 어떻게 복구하는지(또는 복구를 사용자에게 위임하는지) 확인.

### 절차

1. ⬜ S1 절차로 3명 완료 → 3개 커밋 누적 + push 성공.
2. ⬜ 외부에서 같은 원격 브랜치에 다른 커밋을 강제로 push (시뮬레이션:
   `git push origin <branch> --force-with-lease` 를 별도 셸에서 실행).
3. ⬜ 4번째 워커 fire 의 push 가 NFF 로 실패 → `git-automation:failed` + `failedStep='push'`.
4. ⬜ rising-edge fire 가 발사되어도 같은 push 실패가 반복.
5. ⬜ 스케줄러 `maxRetries` 가 켜져 있으면 `재시도 한도(N) 도달` 로그까지 진행
   후 조용히 스킵.

### 기대값

- 단일 브랜치 유지. 자동화는 절대 새 브랜치로 회피하지 않는다.
- push 실패 후 commit 은 로컬에 남아 있음 (`git log` 로 확인 가능).
- UI: `GitAutomationStageRow` 가 `commit=success`, `push=failed` 표시 + 빨간 배너
  + 재시도 버튼 노출. 사용자가 재시도 버튼을 누르면 같은 단계만 재실행.
- 재시도 버튼 클릭 시 `retryingStage='push'` 동안 버튼 disabled + `◔ 재시도 중…`
  라벨로 전환.

### 복구 절차 (사용자 개입)

1. 사용자가 워크스페이스에서 `git fetch origin` → `git rebase origin/<branch>`.
2. rebase 충돌 해소 후 `git push origin <branch>` 수동 실행.
3. 자동화 토글 OFF → ON 으로 cycle 한 뒤 새 태스크부터 정상 동작 확인.

### 회귀 시그널

| 코드 | 신호                                                              | 의심 위치                                                         |
| ---- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| S6-a | 자동화가 NFF 실패 시 새 브랜치를 만들어 회피                      | `branchTemplate` 의 slug 결정이 push 실패 시 fallback 분기를 가짐 (있으면 안 됨) |
| S6-b | 재시도 버튼이 push 실패 후에도 노출되지 않음                      | `GitAutomationStageRow::canRetry` 조건 회귀 — `state === 'failed' && Boolean(onRetryStage)` 검증 |
| S6-c | 재시도 중 버튼이 disabled 가 아님                                 | `isRetrying = retryingStage === key` 조건 누수 — 중복 클릭 방지 회귀 |
| S6-d | 재시도가 commit 부터 다시 실행                                    | 단일 단계 재시도 계약 회귀 — `runStep` 진입점이 stage 인자를 무시 |
| S6-e | UI 가 push 실패 후에도 "푸시 완료" 라벨 유지                      | `GitAutomationPanel.tsx::pushStatus` 가 stale 상태 — 소켓 이벤트 구독 누락 |

---

## 시나리오 매트릭스 요약

| 번호 | 축                          | 기대 브랜치 수 | 기대 워커 fire | 기대 rising-edge fire | 핵심 회귀 코드 |
| ---- | --------------------------- | -------------- | -------------- | --------------------- | -------------- |
| S1   | 4인 순차 완료                | 1              | 4              | 1 (정리용)            | S1-a~S1-e      |
| S2   | 4인 동시 완료                | 1              | 4 (직렬)       | 1 (정리용)            | S2-a~S2-d      |
| S3   | 부분 완료 + 재진입           | 1              | 5              | 2                     | (L3 결합)      |
| S4   | 한국어 게이트 재시도         | 1              | 4              | 1                     | R3/R10         |
| S5   | 같은 파일 동시 편집          | 1              | 4              | 1                     | force-push 금지 |
| S6   | push 실패 후 복구            | 1              | 4 (마지막 실패)| 0~N (재시도)          | S6-a~S6-e      |

---

## UI 검증 체크리스트 — `AgentStatusPanel.tsx::GitAutomationStageRow`

본 시나리오의 모든 케이스에서 다음 표시 계약이 유지되어야 한다 (소스 위치 주석은
`src/components/AgentStatusPanel.tsx:921` 의 `GitAutomationStageRow` 기준).

### 단계 배지 전이

| 이벤트                | commit  | push    | pr   | 글리프(commit/push/pr) |
| --------------------- | ------- | ------- | ---- | ---------------------- |
| 트리거 전              | idle    | idle    | idle | ○/○/○                  |
| commit 진행 중         | running | idle    | idle | ◔/○/○                  |
| commit 성공·push 진행  | success | running | idle | ◉/◔/○                  |
| 전체 성공 (commitPush) | success | success | idle | ◉/◉/○                  |
| commit 실패            | failed  | idle    | idle | ✕/○/○ + 배너           |
| push 실패              | success | failed  | idle | ◉/✕/○ + 배너 + 재시도 버튼 |

### 배너 분기 (`firstFailedStage` / `showNotTriggeredHint`)

- `hasAnyFailure && firstFailedLabel` → 빨간 alert 배너 (`사유: <errorMessage>`).
- `!hasAnyFailure && !hasAnyRunning && allIdle && !hasAnyArtifact` → 노란 status
  배너 ("자동화가 아직 트리거되지 않았습니다").
- 위 두 조건 모두 false → 배너 미표시.

### 재시도 버튼 (`canRetry` / `isRetrying`)

- `stage.state === 'failed' && Boolean(onRetryStage) && !isRetrying` → "↻ 재시도".
- `retryingStage === key` → "◔ 재시도 중…" + disabled.
- 재시도 성공 시 `state` 가 `success` 로 전이되며 버튼 사라짐.

### 푸터 (`branch` / `commitSha` / `prUrl`)

- 셋 중 하나라도 있으면 footer 노출. 시나리오 S1~S6 의 단일 브랜치 계약상
  `branch` 는 항상 같은 값을 유지해야 한다 — 매 fire 마다 footer 의 브랜치 값이
  바뀌면 S1-a 회귀.

---

## 자동화 가능 여부 — 후속 작업 메모

본 문서는 **수동 회귀** 를 전제로 작성됐다. S1~S6 중 일부는
`gitAutomationPipeline.test.ts` 의 F-시리즈를 확장해 자동화할 수 있다:

- S1, S2 — 실 bare 원격 + `spawnSync` 패턴으로 자동화 가능 (F-5 와 유사).
- S3 — `ProjectCompletionTracker` 단위 테스트로 fire 횟수만 검증하면 충분.
- S4 — `firedTaskIds` 디바운스 단위 테스트(`leaderDispatch.test.ts` 의 디바운스
  시나리오) 로 흡수 가능.
- S5, S6 — 실 워크스페이스 + 실 원격 동시성이 필요 → 수동 유지가 합리적.

자동화 우선순위: S1 → S2 → S4 → S3. S5/S6 은 수동 유지.

---

## 리더 보고 시 첨부 항목

S1~S6 검증 후 리더 Kai 에게 다음 5줄을 보고한다 (`결과 보고 템플릿`):

```
검증자: <에이전트 이름>
검증 시각: YYYY-MM-DD HH:MM KST
S1~S2 결과: [pass/fail] — 단일 브랜치 유지=<y/n>, 누적 커밋 수=<..>
S3~S4 결과: [pass/fail] — rising-edge fire 횟수=<..>, 디바운스 흡수=<..>
S5~S6 결과: [pass/fail] — force-push 미사용=<y/n>, 재시도 버튼 동작=<..>
```
