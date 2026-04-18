---
purpose: manual-test
scope: auto-dev × git-automation × failure-path × retry
owner: 베타(개발자 겸임)
reviewed-by: 디자이너 (6615fe14-393a-473d-bec8-f64dba43148d)
related-code:
  - src/utils/gitAutomation.ts (buildRunPlan, startGitAutomationScheduler)
  - src/utils/gitAutomationPipeline.test.ts (플로우 E2E)
  - src/utils/gitAutomationScheduler.test.ts (주기·재시도 상태기)
  - src/server/taskRunner.ts (handleWorkerTaskComplete, firedTaskIds)
  - server.ts (executeGitAutomation, io.emit)
  - src/components/GitAutomationPanel.tsx (실행 배너·재시도 표기)
sibling-doc: tests/manual-git-automation-regression.md
---

# 수동 회귀 — Git 자동화 실패 시나리오·재시도 흐름

자동 개발이 ON 인 상태에서 Git 자동화 파이프라인이 특정 단계에서 실패할 때
어떤 이벤트가 어떤 순서로 나가야 하고, 스케줄러 상태기가 재시도/포기/리셋을
어떻게 결정하는지 수동으로 확정한다. 또한 기존 자동 테스트
(`gitAutomationPipeline.test.ts`, `gitAutomationScheduler.test.ts`) 이 커버하지
못하는 공백을 목록화해 후속 자동화 범위를 고정한다.

## 스코프

| 단계   | 확인할 실패 원인(대표)                                | 이벤트 계약                                           |
| ------ | ----------------------------------------------------- | ----------------------------------------------------- |
| commit | 변경 없음, pre-commit hook 거부, 서명 키 부재         | `git-automation:failed` + `failedStep='commit'`       |
| push   | 네트워크 단절, non-fast-forward 충돌, 브랜치 보호     | `git-automation:failed` + `failedStep='push'`         |
| pr     | `gh` 미인증(403), `gh` 미설치(ENOENT), reviewers 실패 | `git-automation:failed` + `failedStep='pr'`           |

실패 시 공통 계약:
- 이전 성공 단계 결과(`checkout/add/commit/push`)는 `results[]` 에 남는다.
- 실패 직후 단계부터는 `results[]` 에 추가되지 않는다(`runStep` 이 `!ok` 로 조기 return).
- `stderr` 는 400자로 잘려 직렬화된다(소켓 페이로드 안전).
- `logFailure(task=… branch=… [step] exit=… — <stderr 400자>)` 한 줄이 워커 로그에 남는다.
- UI `GitAutomationPanel` 의 실행 배너가 해당 단계 이름으로 빨갛게 전환.

## 시나리오 F1 — commit 단계 실패 (pre-commit hook 거부)

- 선행:
  - 워크스페이스에 `pre-commit` 훅 설치. `.git/hooks/pre-commit` 에 `exit 1` 만 넣어 확정 실패.
  - 자동 개발 ON, Git 자동화 enabled=true, flowLevel=`commitPushPR`.
- 절차:
  1. 합성 태스크가 dispatch → 워커 완료.
  2. `executeGitAutomation` 이 `checkout` → `add` → `commit` 순으로 진입.
  3. `commit` 단계에서 hook exit 1 → 전체 실패.
- 기대:
  - `results.length == 3`, `results[2].ok == false`, `results[2].label == 'commit'`.
  - `results[2].stderr` 에 `pre-commit` 메시지 일부가 400자 내에 포함.
  - `push`/`pr` 단계는 `results` 에 부재.
  - `git-automation:failed` 1회 방출, `failedStep='commit'`.
  - 워커 로그에 `task=<id> branch=<name> [commit] exit=1 — <stderr>`.
  - 원격에 브랜치 미존재, 로컬 HEAD 는 이전 상태 유지.
- 재시도 흐름:
  - 스케줄러가 `maxRetries=N` 으로 켜져 있으면 같은 done 구간 내 `N` 회까지 재시도 로그 `트리거 실패 k/N` 이 쌓인다.
  - hook 이 여전히 실패하면 `재시도 한도(N) 도달` 로그 1회 + 이후 tick 은 조용히 스킵.
  - 사용자가 훅을 수정하고 에이전트가 done 을 재전이(working → idle) 하면 시도 카운터 리셋.

## 시나리오 F2 — push 단계 충돌 (non-fast-forward)

- 선행:
  - 원격 bare 저장소에 `feature/chore/<slug>` 브랜치가 "다른 커밋" 으로 선행 존재.
  - 로컬 워크스페이스에서는 같은 브랜치 이름으로 독립 커밋을 만든 상태.
- 절차:
  1. 자동 개발 태스크 완료 → commit 까지 성공.
  2. `git push -u origin <branch>` 가 `rejected (non-fast-forward)` 로 실패.
- 기대:
  - `results.length == 4`, `results[3].ok == false`, `results[3].label == 'push'`.
  - `pr` 단계 미실행(결과 배열에 부재).
  - 로컬 HEAD 는 원격 SHA 로 덮이지 않음(`localSha !== remoteSha`).
  - `git-automation:failed` 1회, `failedStep='push'`.
  - 워커 로그: `[push] exit=<1 혹은 128> — To <remote>  ! [rejected]  … (non-fast-forward)`.
- 재시도 흐름:
  - 단순 재시도로는 해결되지 않음. `maxRetries` 소진 후 `재시도 한도 도달` 로그 유지.
  - 복구는 수동 rebase/merge 가 필요. 사용자가 해결 후 에이전트 done 재전이 시 새 사이클.

## 시나리오 F3 — push 단계 권한 실패 (보호 브랜치)

- 선행:
  - 원격의 `main` 또는 대상 브랜치에 보호 규칙 설정(직접 push 금지).
  - `branchTemplate` 이 우연히 `main` 또는 보호 브랜치와 충돌하도록 조작(예: `{type}` 없이 `main`).
- 기대:
  - push 단계가 exit 1 + stderr `protected branch hook declined` 패턴.
  - `failedStep='push'`, PR 미시도.
- 재시도 흐름:
  - 재시도 무의미(정책 문제) — 템플릿 수정이 필수.
  - QA 체크: `validateGitAutomationConfig` 가 `main` 충돌을 거르는지, 현재는 `{slug}` 만 검사하고 보호 브랜치 충돌은 사람의 몫.
  - **커버리지 공백**: `src/utils/gitAutomation.test.ts` / `gitAutomationPipeline.test.ts` 어디에도
    보호 브랜치 rejection 재현이 없음. stderr 패턴이 동일한 `!rejected` 로 나오므로 F2 와
    이벤트 계약은 같지만, UI 문구(`GitAutomationPanel`)가 이를 분리 표기할 계획이면 시그널 분화가 필요.

## 시나리오 F4 — PR 생성 권한 오류 (`gh` 401/403)

- 선행:
  - `gh auth logout` 으로 인증 제거 또는 GITHUB_TOKEN 을 scope 없는 토큰으로 교체.
  - flowLevel=`commitPushPR`, push 까지 성공하도록 원격·브랜치는 정상.
- 기대:
  - `results.length == 5`, `results[4].ok == false`, `results[4].label == 'pr'`.
  - `results[4].stderr` 에 `HTTP 401`/`403`/`authentication` 키워드 중 하나 포함.
  - `push` 까지의 결과는 ok=true 로 남아 수동 PR 재시도 지점이 명확.
  - `git-automation:failed` 1회 + `failedStep='pr'`.
- 재시도 흐름:
  - push 는 이미 성공 → 단순 재시도 시 `push` 단계는 무변경 업데이트(exit 0) 또는 "Everything up-to-date" 로 통과.
  - PR 은 여전히 실패. maxRetries 소진 후 대기.
  - 사용자가 `gh auth login` 복구 → 에이전트 done 재전이 → 새 사이클에서 PR 만 성공하도록
    파이프라인이 이전 성공 단계를 건너뛰게 할지가 **설계 공백**.
    현재 구현은 매 사이클 checkout→add→commit→push→pr 을 재실행하므로 빈 commit 으로
    `nothing to commit` 실패(F5 와 동일 경로)로 귀결될 수 있다.

## 시나리오 F5 — PR 단계 ENOENT (`gh` 미설치)

- 선행: PATH 에서 `gh` 제거, 또는 서버 컨테이너 이미지가 `gh` 없음.
- 기대:
  - `spawnSync` 의 `r.error` 가 ENOENT 로 채워지고 `r.status == null`.
  - `runStep` 이 `ok=false`, `code=null`, `stderr` 에 `spawn error: spawn gh ENOENT` 라인이 병합.
  - `failedStep='pr'`, 소켓/로그 계약은 F4 와 동일.
- 재시도 흐름:
  - `gh` 가 설치될 때까지 모든 재시도가 같은 ENOENT 로 실패.
  - **커버리지 공백**: `gitAutomationPipeline.test.ts` 는 `gh` 가 없는 상황을 "PATH 에 스텁 없음"
    으로 흉내 내지 않는다(항상 스텁 설치). `executeGitAutomation` 의 `r.error.message` 합류
    로직은 서버측에서만 실행되므로 서버 단위 테스트가 별도 필요.

## 시나리오 F6 — 일부 에이전트가 idle 로 복귀하지 못한 turn (훅 미호출)

- 선행:
  - `TaskRunner.dispatchTask` 의 try 블록 안에서 네트워크·DB·워커 세션 문제로 throw 가
    발생한다(예: 워커 process 가 파이프 중단으로 사망, Mongo 쿼리 장애).
  - catch 분기가 태스크 상태를 `pending`/`completed(fail)` 로 되돌리고 에이전트 행을
    `status='idle', currentTask='', lastActiveTask=<task.id>` 로 복구한다.
  - Git 자동화 토글 `enabled=true`, `flowLevel='commitPush'` 이상.
- 절차:
  1. dispatch 중 임의 지점에서 throw (stub 워커가 `Promise.reject` 를 되돌리는 방식으로
     재현 가능).
  2. 같은 프로젝트의 다른 에이전트는 평상시처럼 dispatch → done 까지 정상 진행.
  3. 에러를 맞은 에이전트가 사용자 지시로 재 dispatch 되어 done 까지 통과.
- 기대:
  - 에러 맞은 첫 시도에서는 `handleWorkerTaskComplete` 가 **호출되지 않는다**(try 가 아래
    쪽까지 진입 못 함). 따라서 `firedTaskIds` 에 해당 `taskId` 가 기록되지 않는다.
  - Git 자동화 파이프라인은 0회 실행. `git-automation:ran` / `git-automation:failed` 둘 다
    방출되지 않음.
  - 재 dispatch 후 성공 턴에서는 새 `taskId` 로 정상 1회 발사.
  - **회귀 시그널**: 재 dispatch 에서도 "같은 taskId" 로 디바운스에 이미 걸려 발사가
    0회가 되면 회귀. (`firedTaskIds` 가 실패 경로에서 잘못 채워진 것)
- 자동 테스트: `src/utils/gitAutomationPipeline.test.ts` 시나리오 H.
  - 훅 미호출 상태에서 `firedTaskIds` 가 비어 있음을 단언.
  - 복구 후 같은 taskId 중복 호출에서는 1회만 발사, 2회째는 `skipped='debounced'` 로
    전환됨을 검증.
- 재시도 흐름:
  - `executeGitAutomation` 이 아예 돌지 않았으므로 스케줄러 상태기는 `idle` 유지.
  - 사용자 입장에서 UI 배지가 변하지 않는다는 점이 오히려 디버그 단서 — "자동화가
    죽었나" 오해가 `auto-commit-no-fire-repro.md` 의 A1 구간과 같은 문의로 수렴한다.

## 시나리오 F7 — 리더 재분배 무한 루프 방지 가드

- 선행:
  - 리더가 응답 JSON 의 `tasks[].assignedTo` 에 **자기 자신의 agentId** 를 포함시킨다.
  - 현재 `TaskRunner.dispatchTask` 의 child 생성 루프는 `project.agents?.includes(...)` 만
    검증하므로, 리더 id 가 프로젝트 멤버면 통과된다.
  - child 가 dispatch 되면 다시 리더 플래닝 프롬프트로 감 → 모델이 또 자기 자신을
    지명 → 무한 재귀.
- 기대 가드:
  - parent 턴의 `task.source === 'leader'` 일 때(= 이미 리더 재분배로 생성된 child 에서
    다시 리더 분배가 촉발되는 상황) 리더 자기 참조 child 를 드롭한다.
  - parent 가 `user` 또는 `auto-dev` 인 1차 리더 턴에서는 자기 참조를 허용한다 — 정상
    적인 "플랜을 한 번 더 수립해 달라" 요청을 막지 않기 위함.
  - dev/qa/designer 등 다른 역할 할당은 그대로 통과.
- 자동 테스트: `src/utils/gitAutomationPipeline.test.ts` 시나리오 I 의
  `filterLeaderSelfReferenceTasks` 순수 가드.
  - 1차(user) 턴에서 리더 자기 참조 2건이 그대로 통과.
  - 2차(leader-source) 턴에서는 리더 자기 참조 2건만 제거, dev 는 살아남음.
  - 3차(auto-dev) 경계 케이스에서는 과잉 차단이 발생하지 않음.
- 회귀가 의심될 때:
  1. 같은 리더 agentId 가 같은 sprint 안에서 2회 이상 연속으로 플래닝 태스크를 받으면
     체인이 재귀 중일 가능성 — 태스크 콜렉션에서 `source='leader' AND assignedTo=<leader>` 카운트 확인.
  2. Git 자동화 훅은 리더 조기 return 으로 방출되지 않으므로, 재귀 발생 시에도 "자동화는
     조용한데 워커 로그만 계속 늘어나는" 형태로 드러난다 — LogPanel 의 리더 라인 밀도가
     비정상적으로 높아지는지 확인.
  3. `filterLeaderSelfReferenceTasks` 가드가 taskRunner 본체에 아직 주입돼 있지 않다면,
     시나리오 I 는 "미래 가드의 계약" 으로만 기능한다. 본체 주입 시 이 가드 함수의
     계약이 그대로 재사용되어야 한다.

## 재시도 상태기 수기 체크리스트

`gitAutomationScheduler.test.ts` 가 결정적으로 고정한 상태 전이는 아래와 같다.
수동 테스트 시 동일한 전이 순서가 실 파이프라인에서도 유지되는지 시각적으로 확인.

| 전이                          | 기대 동작                                                   |
| ----------------------------- | ------------------------------------------------------------ |
| idle → attempting(rising)     | `run()` 1회 즉시 발사, `트리거 개시` 로그                    |
| attempting 성공               | satisfied 고정, `트리거 성공 (N회 시도)` 로그 1회           |
| attempting 실패               | `트리거 실패 k/N` 로그 + 카운터 증가                        |
| 실패 k==N                     | `재시도 한도(N) 도달` 로그 1회, 이후 tick 조용히 스킵       |
| satisfied 유지                | 이후 tick 에서 `run()` 미호출                                |
| done true→false→true          | idle 복귀 후 새 사이클 시작, 시도 카운터 리셋               |
| isEnabled false→true 재토글    | 상태기 idle 리셋, 다음 done 을 새 사이클로 잡음             |
| backcompat(isAgentDone 없음)  | 매 tick `run()` 호출(레거시 경로 유지)                      |

## 기존 자동 테스트 커버리지 공백(정리)

`gitAutomationPipeline.test.ts` 기준:

- [공백 G1] `commit` 단계 pre-commit hook 실패(현재 테스트는 "nothing to commit" 경로만).
- [공백 G2] `push` 단계 보호 브랜치 rejection(현재는 일반 non-fast-forward 만).
- [공백 G3] `pr` 단계 ENOENT/권한 오류 — 현재는 argv 레벨 검증만, spawn 결과 검증 없음.
- [공백 G4] `executeGitAutomation` 의 `skipped='disabled'`/`skipped='no-project'` 분기 — server.ts 가 비테스트.
- [공백 G5] `io.emit('git-automation:failed')` 페이로드 형태(failedStep/stderr 400자 상한) — 서버 테스트 부재.
- [공백 G6] stderr 400자 절단 규약 — 대용량 에러 메시지로 페이로드 폭증 방지 가드 없음.
- [공백 G7] `handleWorkerTaskComplete` 의 `firedTaskIds` 256개 FIFO 제거 동작 — 메모리 폭주 대비 자동 테스트 부재.
- [공백 G8] Leader role 조기 return — 리더 플래닝 완료 시 자동화가 돌지 않아야 하나, 회귀 방지 자동 테스트 없음.

`gitAutomationScheduler.test.ts` 기준:

- [공백 S1] 실패 원인별 분기 — 스케줄러는 `throw` 여부만 보고 원인(실제 단계 실패 vs 전역 오류)을 구분하지 않음.
  UI 쪽에서 "push 실패" 와 "PR 실패" 를 다르게 표기하려면 `onLog` 페이로드에 단계 정보가 필요.
- [공백 S2] 재시도 간격 — 현재는 `intervalMs` 그대로 반복. 지수 백오프 미구현.
- [공백 S3] 동시 스케줄러 인스턴스 충돌 — 같은 프로젝트에 두 번 `startGitAutomationScheduler`
  가 호출되는 경우(예: 탭 중복 오픈)의 방어 가드 없음. 실 환경에서 2배 발사 가능.
- [공백 S4] `onLog` 로그 버퍼 상한 — 수천 번 실패 시 메모리 누수 가능성.
- [공백 S5] `auto-dev tick` 과 `scheduler tick` 이 같은 done 에서 동시에 파이프라인을 쏘는 경로 —
  `firedTaskIds` 가 한쪽만 디바운스하므로 엣지 케이스에서 이중 발사 여지.

## 후속 자동화 제안(우선순위)

1. 서버 단위 테스트 신설 — `executeGitAutomation` 을 봉인된 `spawnSync` 스텁으로 구동해
   G4/G5/G6 을 한 번에 고정(우선 순위 최상, 소켓 계약 파손이 UI 로 바로 번진다).
2. `handleWorkerTaskComplete` 용 서비스 단위 테스트 — G7/G8 + Korean-gate 재시도 동일 taskId 케이스.
3. 보호 브랜치·`gh` ENOENT/401 재현 픽스처 — 파이프라인 테스트에 시나리오 F3/F4/F5 흡수.
4. 스케줄러 onLog 페이로드 구조화 — `{step, attempt, cause}` 형태로 바꿔 S1 해소.
5. 지수 백오프 + 상한(`maxBackoffMs`) 옵션화 — S2.

## UI 관찰 포인트(디자이너 인수 대상)

- `GitAutomationPanel.tsx` 실행 배너의 failedStep 문구가 F1/F2/F3/F4/F5 에서 각각 다른
  한국어로 노출되는지(예: "커밋 거부", "원격 충돌", "보호 브랜치", "PR 권한 오류", "gh 미설치").
- 재시도 로그 영역에서 `k/N` 표기가 단조 증가하고, 한도 도달 후 회색 처리되는지.
- `FileTooltip` 의 동시 작업자 칩(⚠)은 자동화 실패와 무관해야 한다(교차 오염 금지).
- `AgentStatusPanel` 의 개별 에이전트 행 배지는 `classifyLeaderMessage` 결과(`delegate/reply/plain`)
  만 반영하고, 자동화 실패로 바뀌지 않아야 함(관심사 분리).

## 시나리오 F8 — 리더 rising-edge 미발동 (모든 에이전트 완료 후 자동화 0회)

`src/server/completionWatcher.ts` 의 `ProjectCompletionTracker` 가 "busy → completed"
전이 순간에만 자동화를 1회 쏘도록 설계돼 있는데, 실제 운영에서 **전원 idle 인데도
fire 가 안 나가는** 증상이 간헐적으로 보고된다. F1~F5 는 단계 실패 경로이지만, F8 은
"파이프라인이 아예 트리거되지 않는" 경로라 증상이 조용하고 디버깅 비용이 크다. 아래
케이스를 수동으로 재현해 회귀 여부를 결정적으로 잡는다.

### F8-a — 초기 관측부터 전원 idle 로 떨어져 rising-edge 가 없음

- 선행:
  - 서버 재기동 직후, 아직 한 번도 태스크가 working 으로 올라간 적 없는 프로젝트.
  - `peek(projectId)` 는 `undefined`, 첫 관측에서 `evaluateAgentsCompletion(undefined, ['idle',...])`
    호출 → `{nextPhase:'completed', fire:false}` 가 정상(rising-edge 조건 불만족).
- 기대:
  - 사용자 지시 없이는 busy 로 내려갈 계기가 없으므로 fire 가 0회인 것이 정상.
  - 사용자가 한 번이라도 태스크를 투입하면 [w,i,...] → [i,i,...] 로 전이해 1회 fire.
- 회귀 시그널:
  - 투입 후 [i,i,...] 수렴이 이뤄졌는데도 fire=0 → `previousPhase='busy'` 가 기록되지 않은 것.
    `ProjectCompletionTracker.observe` 의 phase 저장 누락 의심.
  - 자동 테스트 `leaderDispatch.test.ts` 의
    "첫 관측부터 fire 하면 기동 직후마다 자동화가 돌아 사고 난다" 와 "busy → completed 첫 전이에서
    정확히 1회 발사되어야 한다" 두 줄이 모두 살아 있는지 먼저 확인.

### F8-b — reset 이 부당한 시점에 호출돼 phase 가 초기화

- 선행:
  - 팀 편성 변경(에이전트 합류/탈퇴) 이벤트 훅에서 `tracker.reset(projectId)` 를 호출.
  - 실제로는 busy 구간 중에 합류가 일어나는 일이 잦다.
- 기대:
  - reset 직후 첫 완료 수렴은 `previousPhase=undefined` 로 떨어져 `fire=false`.
  - 다음 busy 재진입 이후의 수렴부터 다시 rising-edge 성립.
- 회귀 시그널:
  - 에이전트 합류/탈퇴만으로 완성된 수렴 한 건을 먹어 치운다 — 즉 팀원 수에 따라 자동화가
    "가끔 한 번 빠진다" 는 사용자 관측과 일치.
  - `leaderDispatch.test.ts` 의 "reset 이후 첫 completed 관측은 fire 하지 않는다" 가 실제 설계지만,
    reset 호출 시점이 "필요할 때" 가 아니라 "팀 편성 변경" 같은 비관련 이벤트에 걸려 있으면
    계약과 운영의 접점이 어긋난 것이다.

### F8-c — 리더가 working 으로 고착되어 allIdle 판정이 영원히 false

- 선행:
  - 리더 응답 파싱 실패(비-JSON 자연어) → `simulateLeaderBranch` 의 fallback 경로.
  - 실제 taskRunner 에서 리더 status 를 idle 로 되돌리는 라인이 fallback 분기에서만 누락된 회귀.
- 기대:
  - `leaderDispatch.test.ts` "상태 복귀 불변 — 어떤 리더 응답이어도 … 리더는 idle 로 복귀한다"
    가 성립한다면, 리더 status=`idle` 이 보장되어 전원 수렴이 성립.
- 회귀 시그널:
  - 리더 status=`working` 고착 → `statuses.every(s => s === 'idle')` 가 false → phase 가 영원히 busy.
  - UI 에서 리더 행만 "사고 중" 스피너가 떠 있는 상태로 팀원 4명이 모두 idle 인데 자동화가 안 도는 모습.
  - 복구: 리더에게 수동으로 빈 지시를 넣어 다시 턴을 돌리면 idle 로 복귀 → 다음 수렴에서 fire.

### F8-d — 리더 자기 참조 재귀로 busy 가 끊기지 않음

- 시나리오 F7 과 동일 트리거이지만, F7 은 "가드가 터트려서 child 생성 0건" 을 보장하는 쪽의 관점,
  F8-d 는 "가드가 없어서 무한 재귀가 돌 때 자동화가 영영 안 울린다" 는 관찰자 쪽의 관점.
- 기대:
  - `filterLeaderSelfReferenceTasks` 가드가 source='leader' 턴에서 자기 참조를 드롭 → 리더가 idle 로
    내려와 수렴 가능.
- 회귀 시그널:
  - LogPanel 의 리더 라인이 계속 늘어나는데 GitAutomationPanel 배너는 조용 → F8-d 가 거의 확실.
  - 이 경우 `taskRunner.setAutoDev({enabled:false})` 로 자동 개발을 먼저 끊고,
    `tasks` 컬렉션에서 source='leader' AND assignedTo=<leader> 행을 수동 삭제해 재귀를 끊는다.

### F8 공통 이벤트 계약

- F8 은 실패가 아니라 **미발동** 이므로 `git-automation:ran` / `git-automation:failed` 중 **어떤 것도
  방출되지 않는다**. 워커 로그에도 실패 라인이 남지 않는다(`logFailure` 호출 없음).
- 따라서 F8 을 조기에 감지하려면 서버가 별도의 "completed 수렴 관찰 로그"(예: `completion:observed`)
  를 내보내거나, AgentStatusPanel 에서 "전원 idle 인데 최근 자동화 없음" 을 시각화해 줘야 한다.
  현재는 둘 다 미구현 — 이것이 F8 의 **설계 공백**.

## AgentStatusSnapshot 신호와 자동화 발동 상태 전이 기대값

`src/components/AgentStatusSnapshot.test.ts` 가 고정한 3-티어 신호(`ok`/`warn`/`alert`) 는
Pill/FreshnessDot 표시를 위한 것이지만, F8 같은 "조용한 미발동" 을 외부에서 추정하는 데도 쓰인다.
실제 수동 테스트 시 Pill 상태와 자동화 발동 기대값의 결합을 아래 표로 고정한다. 표에서 어긋나는
조합이 관측되면 해당 행의 "진단" 열이 1차 의심 지점이다.

| Snapshot 신호 (`assessRisk`)                        | 실제 팀 상태              | rising-edge 기대                   | 자동화 이벤트 기대                   | 진단                                            |
| --------------------------------------------------- | ------------------------- | ---------------------------------- | ------------------------------------ | ----------------------------------------------- |
| `ok` + 전원 idle                                     | [i,i,i,i]                 | 이미 completed 유지, fire=0        | 이벤트 없음                          | 정상. fire 가 울리면 L3/N1 의 상태 왕복 누수    |
| `warn` 쏠림 (0.75 ≤ c < 0.95)                        | [w,w,w,i]                 | 수렴하면 1회 fire                  | `git-automation:ran` 1회             | fire 없음 → F8-a/F8-b                            |
| `alert` 쏠림 (c ≥ 0.95)                              | [w,w,w,w] (1파일 집중)    | 수렴하면 1회 fire + 충돌 경보      | ran + Pill alert 톤                  | ran 은 났는데 Pill 이 warn → 임계치 드리프트     |
| `alert` 동기화 끊김 (staleSec ≥ `RISK_STALE_ALERT_SEC`) | 소켓 끊김 직후            | tracker 는 이전 phase 유지, fire 보류 | 이벤트 없음                          | ran 이 나가면 `computeStaleSec` 수렴 규약 파손   |
| `alert` 고립 (isolated/total ≥ 0.5)                  | 일부 인력이 isolated 파일 | 평상시 1회 fire(무관 축)           | ran 정상                             | fire 가 고립 경보로 막히면 관심사 분리 실패      |
| `warn` 쏠림 + 리더 working 고착                      | [w(리더),i,i,i,i]         | 영원히 busy, fire=0 **정상**       | 이벤트 없음                          | N2/F8-c 재현. 리더 idle 복귀 가드 확인            |

이 표의 좌·우가 한 번이라도 어긋나면 회귀이거나 설계 공백이다. 특히 마지막 행("warn 쏠림 + 리더 고착")
은 **정상 동작이 F8 처럼 보인다** — 즉 Pill 이 warn 이고 자동화가 0회라고 해서 곧바로 F8 버그라고
판정하면 안 된다. `handleWorkerTaskComplete` 로그에서 리더 태스크의 final status 가 `idle` 로 찍혔는지,
`extractLeaderPlan` 이 `null` 을 돌려준 턴이 있었는지를 먼저 확인한 뒤 F8-c / N2 로 분기한다.

### Snapshot ↔ leaderDispatch.test.ts 교차 대응

| AgentStatusSnapshot.test.ts 테스트                                                | leaderDispatch.test.ts 테스트                                                                  | 공동 계약                                                                 |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| "전원 한 파일 집중(1.0) 은 alert 로 승격되며 Pill 톤도 alert"                     | "전원 idle 로 수렴하는 첫 전이에서만 자동화가 1회 발사된다"                                    | 전원 상태 동시 판정이 UI 와 서버 양쪽에서 동일한 집합 기준을 쓴다          |
| "computeStaleSec: 미래 타임스탬프(now < lastSyncedAt) 는 Infinity 로 수렴"        | "팀원이 0명인 프로젝트는 자동화를 발사하지 않는다"                                             | "입력이 없는/미래의" 경계 상황을 양쪽 모두 '정상 Pill/정상 fire=0' 쪽으로 흡수 |
| "alert 쏠림은 다른 warn 신호보다 앞에 정렬된다"                                   | "working 과 thinking/meeting 이 섞여 있으면 busy 로 본다"                                      | 다중 신호가 섞일 때 "심각도 상위 신호" 가 먼저 반영되는 정렬 규칙         |
| "computeStaleSec 결과가 assessRisk 의 alert 임계치와 호환된다"                    | "reset 이후 첫 completed 관측은 fire 하지 않는다(재가입 직후 오발사 방지)"                    | 경계 조건(정확히 임계치/reset 직후)에서도 티어 경계가 정합적으로 유지된다 |

한 쪽 테스트가 깨지면 다른 쪽도 함께 점검해야 한다. 예를 들어 `computeStaleSec` 의 수렴 규약이
바뀌어 미래 타임스탬프가 `0` 으로 내려가기 시작하면, 리더 rising-edge 는 그 자체로 문제가 없어도
UI 가 "정상 Pill + 자동화 미발동" 조합으로 보이게 되어 F8 오진을 유발한다.
