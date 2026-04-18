---
purpose: manual-test
scope: auto-dev × git-automation × task-complete
owner: 베타(개발자 겸임)
reviewed-by: Joker (dfce6d78-c2c8-4263-b189-6dfe1a3a1f23)
related-code:
  - src/server/taskRunner.ts (handleWorkerTaskComplete)
  - server.ts (executeGitAutomation)
  - src/utils/gitAutomation.ts (shouldAutoCommit/Push/OpenPR)
  - src/components/GitAutomationPanel.tsx (UI 토글)
---

# 수동 회귀 테스트 — 자동 개발 × Git 자동화 조합별 태스크 완료 동작

워커 태스크가 완료되는 순간 서버가 따라가야 할 결정 경로를 조합별로 고정한다.
자동 테스트(`gitAutomationPipeline.test.ts`, `gitAutomationScheduler.test.ts`)는
`buildRunPlan` 순수 함수와 스케줄러 반복만 다루므로, `handleWorkerTaskComplete`
→ `executeGitAutomation` 경로의 사이드 이펙트(실 커밋·푸시·PR·소켓 이벤트)는
본 문서를 기준으로 사람이 눈으로 확인한다.

## 전제 조건

- Node 서버 구동, MongoDB 연결 정상, Socket.IO 채널 구독.
- 테스트 프로젝트 워크스페이스에 `git init` + 원격 bare 저장소 연결, `gh` CLI 인증 완료.
- 팀원 1명 이상이 `role != 'Leader'`. 리더 태스크는 완료 훅이 조기 return 한다(의도).
- 동일 `taskId` 재호출은 `firedTaskIds` 로 1회 디바운스됨을 인지(한국어 게이트 재시도 시 중요).
- 시작 시 `update_status("working", "")` 로 태스크 상태가 워커에 올라와 있어야 한다.

## 시나리오 매트릭스

아래 4개 조합은 모두 "자동 개발 ON" 상태를 전제한다. Git 자동화 측의
`enabled=false` 가 "전부 OFF" 축에 해당한다.

| 번호 | Git 자동화 enabled | flowLevel      | 완료 직후 기대 단계             | 소켓 이벤트 페이로드                                  |
| ---- | ------------------ | -------------- | ------------------------------- | ------------------------------------------------------ |
| M1   | true               | `commitOnly`   | checkout → add → commit         | `git-automation:ran` (results 3개, branch 표기)       |
| M2   | true               | `commitPush`   | checkout → add → commit → push  | `git-automation:ran` (results 4개)                    |
| M3   | true               | `commitPushPR` | 위 + `gh pr create`             | `git-automation:ran` (results 5개, pr.stdout = URL)   |
| M4   | false              | — (무시)       | 즉시 `skipped='disabled'` 리턴  | 소켓 무방출(정상 경로), 워커 로그도 남기지 않음       |

flowLevel 축이 `commit*` 로 고정돼 있어도 `enabled=false` 면 파이프라인은
무조건 M4 로 퇴화한다. UI 토글을 OFF 로 돌리고 flowLevel 만 바꿔도 실 동작이
달라지지 않는지 반드시 교차 확인.

## 공통 실행 절차

1. 대상 프로젝트 Git 자동화 설정(`POST /api/projects/:id/git-automation`) 으로 시나리오별 값 저장.
2. 자동 개발 토글 ON (`POST /api/auto-dev`, `enabled:true`, `projectId:<대상>`).
3. 30초(`AUTO_DEV_TICK_MS`) 이내에 합성 태스크가 idle 에이전트에게 enqueue 되는지 `tasks:updated` 소켓으로 관찰.
4. 워커가 한국어 한 줄 완료 메시지를 출력 → `handleWorkerTaskComplete` 호출.
5. 예상 단계가 모두 수행되고 실 `.git` 상태가 바뀌었는지 확인.
6. 완료 후 자동 개발 OFF, 실험 브랜치 정리.

## M1 — 자동개발 ON + Git 자동화 ON(commitOnly)

- 선행: 작업 트리에 최소 1개의 trackable 변경.
- 기대:
  - 새 브랜치가 `feature/chore/<slug>` 형태로 체크아웃됨(템플릿 기본).
  - `commit` 단계까지 실행, 원격으로 푸시되지 않음.
  - `git-automation:ran` 이 results=[checkout,add,commit] 로 1회 방출.
  - PR 미생성, `gh` 호출 0회.
- 체크포인트(UI):
  - `GitAutomationPanel` 의 최근 실행 배너가 "commit ok" 라벨로 갱신.
  - `FileTooltip` 의 작업자 칩은 그대로 유지, 충돌 위험(⚠)은 새로 추가되지 않음.

## M2 — 자동개발 ON + Git 자동화 ON(commitPush)

- 선행: 원격이 접근 가능, 업스트림이 미설정 상태여도 무방(`-u` 로 설정).
- 기대:
  - commit 단계 성공 후 `git push -u origin <branch>` 가 한 번 수행.
  - 원격에 동일 SHA 가 반영되어 `git ls-remote` 로 확인 가능.
  - `git-automation:ran` results 길이 4, 마지막 label=`push`.
- 실패 시 기대:
  - push 단계가 non-zero 코드로 종료 → `git-automation:failed` 방출,
    `failedStep='push'`, PR 단계는 skip.
  - 워커 로그에 `task=<id> branch=<name> [push] exit=<code> — <stderr 400자>` 한 줄 추가.

## M3 — 자동개발 ON + Git 자동화 ON(commitPushPR)

- 선행: `gh auth status` 통과, reviewers 배열 유효(optional).
- 기대:
  - M2 성공 + `gh pr create --title … --body … --head <branch> [--base <base>] [--reviewer …]` 실행.
  - `results[4].stdout` 에 PR URL 포함.
  - UI 에 PR 링크가 노출되고, `AgentStatusPanel` 의 최근 자동화 요약에 "PR opened" 표기.
- 실패 시 기대:
  - gh 미인증/미설치 → spawn error, `failedStep='pr'`, 결과 배열 길이 5, 마지막 항목 ok=false.
  - 이전 단계(checkout/add/commit/push) 는 성공으로 남아 있어 수동 복구 시 재실행 지점이 명확해야 함.

## M4 — 자동개발 ON + Git 자동화 OFF(enabled=false)

- 선행: `POST /api/projects/:id/git-automation` 으로 `enabled:false` 저장.
- 기대:
  - 워커 완료 훅이 `executeGitAutomation` 호출 → 즉시 `{ok:false, skipped:'disabled', results:[]}` 반환.
  - 소켓 `git-automation:ran`/`git-automation:failed` 모두 미방출(정상 경로 소음 차단).
  - 워커 failure 로그 미기록(스킵 원인이 `disabled` 일 때만 조용히 처리).
  - 브랜치/커밋/푸시/PR 어떤 것도 생성되지 않음. `git status` / `git log` 기준 선행 상태 유지.
- 교차 검증:
  - flowLevel 을 `commitPushPR` 로 둔 채 enabled 만 false 로 돌려도 실 동작은 동일해야 함.
  - 자동 개발 루프 자체는 살아 있으므로 `tasks:updated` 는 계속 흐른다 — 자동화와 자동 개발은 별도 축.

## 회귀 시나리오(Regression)

| 코드 | 회귀 신호                                                                                     | 재현 시 확인할 소스                                               |
| ---- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| R1   | enabled=false 인데 커밋/푸시가 발생                                                           | `executeGitAutomation` 의 disabled 조기 return 분기 훼손         |
| R2   | commitPush 인데 push 실패 후 PR 단계가 실행                                                   | `runStep` 의 `if (!ok) return finalize(false)` 체인 파손          |
| R3   | 동일 taskId 에 대해 `git-automation:ran` 이 2회 이상 방출                                     | `firedTaskIds` 디바운스 세트 누락 또는 size>256 FIFO 제거 오류    |
| R4   | 리더 역할 에이전트의 태스크 완료로 자동화가 돌아감                                            | `handleWorkerTaskComplete` 의 `agent.role === 'Leader'` 가드       |
| R5   | skipped='no-project' 인데 워커 로그가 비어 있음                                               | `skipped !== 'disabled'` 분기의 `logFailure` 호출 누락            |
| R6   | 실패한 단계의 stderr 가 전체 출력으로 직렬화되어 소켓 페이로드가 수 MB                        | 400자 상한 슬라이스(`stderrRaw.slice(0, 400)`) 파손               |
| R7   | Git 자동화 OFF 인데 flowLevel 토글만 바꿔도 UI 가 "자동화 실행됨" 배지를 표시                 | `GitAutomationPanel` 의 `enabled` 게이팅 or 소켓 구독 회귀        |
| R8   | 자동 개발 OFF 후에도 `autoDevTimer` 가 계속 tick 을 돌림                                      | `setAutoDev({enabled:false})` 또는 `dispose` 의 `clearInterval`   |
| R9   | 긴급중단(`POST /api/emergency-stop`) 직후에도 자동화가 마지막 태스크로 발동                    | `taskRunner.setAutoDev({enabled:false})` + 워커 dispose 순서 회귀 |
| R10  | 한국어 게이트 재시도로 같은 taskId 가 여러 번 완료 이벤트를 쏘아도 자동화가 매번 실행         | `firedTaskIds.has` 가드 실패                                      |

## 관찰 포인트(UI 쪽 크로스 체크)

- `GitAutomationPanel.tsx` — `git-automation:ran` / `:failed` 수신 시 최근 실행
  타임라인에 1줄 추가, enabled=false 에서는 아예 항목이 쌓이지 않는지 확인.
- `FileTooltip.tsx` — 동시 작업자 칩(`workerNames`) 이 여러 명 잡혀도 자동화가
  상태 도트·⚠ 아이콘을 임의로 변경하지 않는지 확인(툴팁은 이벤트를 읽지 않으므로
  영향이 없어야 정상, 영향 있으면 의존성 역류).
- `AgentStatusPanel.tsx` — 워커 로그 패널에서 M2/M3 실패 시나리오의 1줄 실패
  메시지(`task=… branch=… [step] exit=… — stderr`) 가 남는지 확인.

## 복구 절차

- 브랜치 정리: `git branch -D feature/<type>/<slug>` 로 테스트 브랜치 제거,
  원격 푸시된 건은 `git push origin :feature/<type>/<slug>` 로 삭제.
- 자동 개발 OFF + 자동화 enabled=false 로 복귀한 뒤 MongoDB 의 `tasks` 컬렉션에서
  테스트 태스크(assignedTo 로 필터) 삭제. `firedTaskIds` 는 서버 재기동 시 초기화.

## 4인 팀 × 리더 rising-edge 발동 매트릭스

`handleWorkerTaskComplete` 경로와 별개로, 서버가 "프로젝트 전원 idle 로 수렴한 순간"
에 1회만 자동화를 쏘는 경로가 `ProjectCompletionTracker` 를 통해 존재한다
(`src/server/completionWatcher.ts`). 이 축은 워커 단위 완료와 **다른 축** 이므로,
4인 팀이 순차/병렬로 done 을 보고하는 동안 리더가 최종 한 번만 커밋·푸시·PR 을
발사하는지 수동으로 확정한다.

전제: 리더 1명 + 팀원 4명(Developer×2, QA×1, Designer×1), Git 자동화 enabled=true,
flowLevel=`commitPushPR`. 리더 역할 에이전트의 완료 훅은 조기 return 이므로
자동화 발사의 출처는 항상 "리더가 소유한 rising-edge 관찰자" 여야 한다.

| 번호 | 전이 시나리오                                 | 에이전트 상태 궤적                                                                 | rising-edge fire | git-automation:ran |
| ---- | --------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------- | ------------------ |
| L1   | 4인 순차 완료                                 | [w,w,w,w] → [i,w,w,w] → [i,i,w,w] → [i,i,i,w] → **[i,i,i,i]**                      | 마지막 1회       | 1회                |
| L2   | 4인 동시 완료                                 | [w,w,w,w] → **[i,i,i,i]** (한 tick 에 전원 수렴)                                   | 1회              | 1회                |
| L3   | 3인 완료 후 1명이 working 재진입              | [w,w,w,w] → [i,i,i,w] → [i,i,i,i] → [i,i,i,w] → [i,i,i,i]                          | **2회**          | 2회                |
| L4   | meeting/thinking 이 섞인 수렴                 | [w,w,m,t] → [i,i,m,t] → [i,i,i,t] → [i,i,i,i]                                      | 1회              | 1회                |
| L5   | 긴급중단 후 복구 1인 완료                     | [w,w,w,w] → (emergency-stop: tracker.reset) → [i,i,i,i]                            | **0회**          | 0회(reset 직후)    |

계약 출처:
- `evaluateAgentsCompletion(previousPhase='busy', ['idle',...])` → `{fire:true}`
  단 한 번. `leaderDispatch.test.ts` 의
  "allAgentsCompletedWatcher — 전원 idle 로 수렴하는 첫 전이에서만 자동화가 1회 발사된다" 와 동일.
- L4 의 thinking/meeting 가 busy 로 취급되는 불변은
  "working 과 thinking/meeting 이 섞여 있으면 busy 로 본다" 가 잠가둔다.
- L5 의 reset 직후 fire=false 규약은
  "reset 이후 첫 completed 관측은 fire 하지 않는다(재가입 직후 오발사 방지)" 에 기록.

## "완료 후 리더 미발동" 재현 체크리스트 (N1~N4)

리더가 최종 커밋·푸시·PR 을 **내야 할 상황에 내지 않는** 회귀를 수동으로 재현한다.
각 단계는 순서대로 밟으며, 중간에 기대값이 한 개라도 어긋나면 해당 번호가 회귀 원인이다.

### N1 — rising-edge 가 영영 안 오는 경우(phase 가 완성 전에 `completed` 로 찍힘)

1. 새 프로젝트를 만들고, 리더 1명 + 팀원 4명 편성. 자동 개발 ON, Git 자동화 enabled=true.
2. 팀원에게 어떤 태스크도 enqueue 하지 않은 상태에서 1 tick 기다린다.
3. `peek(projectId)` 값이 `undefined` → `completed` 로 초기화되는지 `ProjectCompletionTracker`
   로그로 확인(에이전트 편성 이전의 빈 statuses 는 `previousPhase` 유지 규약).
4. 한 명에게 태스크 투입 → [w,i,i,i,i] 로 전이 → phase='busy' 기록.
5. 완료되어 [i,i,i,i,i] 로 수렴 → **여기서 `fire=true` 가 떠야 한다**.
6. 만약 5 에서 fire=false 라면:
   - (a) 1~3 단계에서 초기 관측이 `busy` 로 찍히지 않았는지 확인(빈 statuses 처리 회귀).
   - (b) `reset(projectId)` 가 부당한 시점에 호출됐는지 확인(프로젝트 재생성 훅 회귀).
   - (c) `allIdle` 판정에서 `Leader` 상태가 포함됐는데 리더 본인이 `thinking` 으로 고착됐는지 확인
     — 리더 상태가 idle 로 복귀하지 않으면 전원 수렴이 영원히 성립하지 않는다. `leaderDispatch.test.ts`
     의 "상태 복귀 불변 — 어떤 리더 응답이어도 시뮬레이션 종료 시 리더는 idle 로 복귀한다" 를 참고.

### N2 — 4인 모두 완료했는데 리더만 working 고착

1. 팀원 4명이 모두 done 을 보고해 상태가 [i,i,i,i] 가 된 상태에서, 리더 태스크 하나를
   별도로 dispatch 해 리더만 `working` 으로 올린다.
2. 1 tick 관찰 → phase='busy' (리더 한 명 때문). `git-automation:ran` 미방출이 정상.
3. 리더 응답 완료 → `extractLeaderPlan` 이 `mode='reply'` 로 해석돼 자식 태스크 0 건.
4. 리더 status='idle' 로 복귀 → [i,i,i,i,i] 수렴 → **rising-edge fire 가 발생해야 한다**.
5. 4 에서 fire 가 안 나면:
   - (a) 리더의 `parseLeaderPlanMessage` 가 실패해 상태가 idle 로 내려오지 못하고 `working`
     이 고착된 것. 워커 로그에서 "리더 응답을 해석하지 못해" 폴백 문구가 떴는지 확인.
   - (b) reply 경로인데 리더 final status 가 working 으로 찍히면 leaderDispatch.test.ts 의
     시나리오 A 계약 훼손. 리더 idle 복귀 로직이 dispatch 분기와 reply 분기 양쪽에 모두 있는지 확인.

### N3 — 한국어 게이트 재시도로 같은 taskId 가 반복 완료 보고 → 디바운스 충돌

1. 팀원 1명의 응답이 한국어 비율 게이트에서 첫 턴 거부, 2~3 번째 재시도에서 통과하도록 유도
   (영문 단어 비율이 임계치 근처인 응답을 강제).
2. 첫 재시도 턴에서 `handleWorkerTaskComplete` 가 한 번 호출, `firedTaskIds` 에 taskId 기록.
3. 2~3번째 재시도 턴이 같은 taskId 로 완료 이벤트를 다시 쏘아도, 워커 단위 파이프라인은
   `skipped='debounced'` 로 즉시 탈출해야 한다(R3/R10 회귀 방지).
4. 그러나 **리더 rising-edge 축은 별도 tracker 이므로** `taskId` 디바운스와 무관하게
   [i,i,i,i,i] 수렴 tick 에서 정확히 1회만 발사되는지 확인.
5. 만약 4 에서 fire 가 0회로 죽거나 2회 이상 발사되면:
   - (a) 리더 tracker 가 워커 tracker 의 `firedTaskIds` 를 공유해 오염된 것 — 두 축을 분리했는지 확인.
   - (b) 재시도 루프 중 상태가 [i,w,i,i,i] → [i,i,i,i,i] 를 여러 번 왕복했다면 L3 사례가 되어 2회 발사가
     **정상** 이다. 실제 상태 궤적을 기록해 L3 와 N3 를 구분할 것.

### N4 — 리더가 자기 참조 child 를 뱉어 재귀에 빠지는 경우

1. 리더 응답이 `tasks[0].assignedTo = <리더 자신의 id>` 를 포함하도록 유도(예: "플랜을 한 번 더 세워 달라" 요청).
2. 1차(user/auto-dev) 턴에서는 `filterLeaderSelfReferenceTasks` 가 자기 참조를 허용해야 한다
   (git-automation-failure-scenarios.md 시나리오 I 참고).
3. 자식 턴에서 또 자기 참조 child 가 생성되면, **source='leader' 가드** 로 드롭되어야 한다.
4. 가드가 파손된 상태에서는 리더 working 이 연쇄로 이어져 [i,i,i,i,i] 가 결코 성립하지 않는다 — fire 0회.
5. 증상 구분:
   - `tasks` 컬렉션에서 `source='leader' AND assignedTo=<leader>` 카운트가 같은 sprint 내 2건 이상이면 이 경로.
   - LogPanel 의 리더 라인 밀도가 비정상적으로 높은데 GitAutomationPanel 배너는 조용하면
     N4 가 거의 확실하다.

## AgentStatusSnapshot 신호와 자동화 발동 상태 전이 기대표

`src/components/AgentStatusSnapshot.test.ts` 가 고정한 세 개의 신호 티어 — `ok` / `warn` /
`alert` — 는 Pill/FreshnessDot 표시뿐 아니라 "언제 리더 rising-edge 가 반드시 울려야 하는가"
에 대한 관찰 축으로도 활용된다. 수동 테스트 중 상태 패널의 Pill 과 Git 자동화 배너를 함께
관찰해 아래 표의 좌우가 어긋나지 않는지 교차 확인한다.

| AgentStatusSnapshot 신호                  | 트리거 조건                                     | rising-edge 기대 동작                      | 회귀 시그널                                       |
| ----------------------------------------- | ----------------------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| `ok` 유지 (쏠림 < 0.75, staleSec 정상)    | 전원 idle, 리소스 경쟁 없음                     | completed phase 고정, fire 없음           | ok 인데 fire 가 찍히면 L3 형태의 상태 왕복 누수   |
| `warn` 쏠림 0.75~0.95                     | 4인 중 3인이 같은 파일에 묶임                   | rising-edge 는 평소대로 1회 발사           | warn 인데 fire 가 나가지 않으면 N1/N2 재현        |
| `alert` 쏠림 ≥ 0.95                       | 사실상 전원이 한 파일에 고착                    | 커밋 충돌 위험 → fire 는 나가되 UI 가 경보 | fire 는 나왔는데 Pill 이 warn 이면 임계치 드리프트 |
| `alert` `동기화 끊김` (staleSec ≥ 임계)   | 소켓 끊김/서버 멈춤 직후                        | tracker 가 이전 phase 유지 → fire 보류     | fire 가 나가면 `computeStaleSec` 수렴 규약 파손   |
| `alert` 고립 비율 ≥ 0.5                   | 일부 에이전트가 연결되지 않은 파일에서만 작업   | rising-edge 자체와 무관(fire 동작 유지)    | fire 가 고립 경보로 인해 막히면 관심사 분리 실패  |

교차 확인 순서:
1. AgentStatusPanel 의 Pill 라벨과 FreshnessDot 색을 먼저 본다. (Pill 이 alert 인데 도트가 초록이면
   `computeStaleSec` / `assessRisk` 사이 드리프트 — AgentStatusSnapshot.test.ts 의
   "computeStaleSec 결과가 assessRisk 의 alert 임계치와 호환된다" 가 먼저 깨진다.)
2. GitAutomationPanel 의 최근 실행 배너에서 rising-edge fire 가 찍혔는지 확인.
3. 두 축이 위 표와 다른 결합(예: alert 쏠림 + fire 없음)을 보이면 N1~N4 체크리스트로 내려간다.
4. `alert 쏠림은 다른 warn 신호보다 앞에 정렬된다` 가 여전히 성립하는지, Pill 사유 문자열에서
   "쏠림" 이 "고립" 보다 앞에 있는지도 함께 기록한다 — 뒤집히면 신호 정렬 규칙이 회귀한 것.

## E2E 긴급 점검 체크리스트 — Thanos/Joker 수정 반영 직후(지시 #4de5629d, 2026-04-18)

두 개발자 에이전트(Thanos, Joker)의 수정이 반영된 직후 **"에이전트 태스크 완료 →
자동 커밋 → 자동 푸시"** 가 한 번의 흐름으로 이어지는지 E2E 로 확정한다. 단위
테스트(`gitAutomationPipeline.test.ts`, `leaderDispatch.test.ts`)는 순수 함수와
rising-edge 계약만 덮으므로, 실 `.git` 의 커밋 SHA 가 전진하고 `origin` 원격에
동일 SHA 가 반영되는 **실 환경 관측** 은 본 체크리스트를 통해서만 기록된다.

### 본 점검의 사전 조건(필수)

- 실 서버(`npm run server` + `npm run dev`) 기동 권한.
- `proj-e2e` 프로젝트의 `workspacePath` 가 실 `.git` 디렉터리, `origin` 이 접근
  가능(현재 리모트: `https://github.com/serment7/LLMTycoon.git`).
- Git 자동화 설정: `enabled:true`, `flowLevel:'commitPush'`(또는 `commitPushPR`) —
  본 점검은 **push 축까지** 확인이 목표이므로 `commitOnly` 는 **불가**.
- 테스트용 브랜치 네임스페이스: `feature/e2e/<slug>` — 실험 후 로컬·원격에서
  같은 이름으로 정리 가능해야 한다.
- `gh auth status` 통과(PR 축까지 확장할 경우).

### 현재 빌드 상태 — 본 문서 작성 시점 관측치

- `git log --all --author=Thanos` / `git log --all --author=Joker` 결과 **모두 공백**.
  두 이름은 게임 내 에이전트 식별자이며, 실 저장소의 Git 저자 기록에는 나타나지
  않는다(저자 = `serment7`). 즉 "Thanos/Joker 의 수정" 이 의미하는 바는 실행
  세션 중 에이전트가 **서버 자동화 경로를 통해** 생성한 커밋을 뜻한다.
- 본 문서 저장 순간 워킹 트리는 `git status --short` 기준 30개 이상의 변경을
  포함한 상태(대부분 문서 파일). E2E 실행 직전에 **현 변경을 stash 또는 별도
  브랜치로 격리** 하지 않으면 자동화가 엉뚱한 파일을 같이 스테이지해 버린다.
- 본 문서 작성 에이전트는 실 서버 기동·실 `git push` 실행 권한이 없어 아래
  E1~E3 시나리오의 "실 관측값" 칸은 **미실시(unknown)** 로 남긴다. 실행자는
  현장에서 같은 칸을 채워 넣는다.

### 시나리오 매트릭스(E1~E3)

| 번호 | 축                                 | 전제 구성                                                 | 기대 최종 상태                                            |
| ---- | ---------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| E1   | 단일 에이전트 완료                  | 팀원 1명(Developer), 리더 대기                            | 커밋 1건, 푸시 1건, 원격/로컬 동일 SHA                     |
| E2   | 동시 다중 에이전트 완료             | 팀원 3명(Dev×2, QA×1) 한 tick 안에 수렴                  | 워커 fire 최대 3회 + rising-edge fire 1회, 누적 커밋 ≤ 3+1 |
| E3   | push 실패 복구                      | 원격 브랜치 선행 또는 일시적 네트워크 차단                | `commit` 성공 · `push` 실패 · `pr` 미실행 · 재시도 경로     |

### E1 — 단일 에이전트 완료

- 실행 절차(체크리스트, ⬜ 로 수행 후 기록):
  1. ⬜ Git 자동화 `enabled:true, flowLevel:'commitPush'` 저장 확인.
  2. ⬜ 워킹 트리 변경이 **없는 상태** 로 정리(stash / 별도 브랜치).
  3. ⬜ 자동 개발 ON, `proj-e2e` 전용으로 dispatch.
  4. ⬜ Developer 에이전트 1명에게 합성 태스크 투입, 워커가 1개 파일을 `Write`/`Edit` 수정 후 done 보고.
  5. ⬜ 3~5초 내 `git-automation:ran` 이벤트 1회 수신.
  6. ⬜ `git -C <workspace> log -1 --format=%H` 로 새 커밋 SHA 기록.
  7. ⬜ `git -C <workspace> ls-remote origin feature/e2e/<slug>` 로 원격 SHA 기록 → 로컬과 일치 확인.
- 실 관측값(실행자가 채움):
  - `git-automation:ran.results.length`: _ (기대 4: checkout/add/commit/push)
  - 로컬 SHA: _ / 원격 SHA: _ / 일치 여부: _
  - `GitAutomationPanel` 배너: _ (기대 "push ok" 갱신)
  - 생성 브랜치: _ / 원격 생성 확인: _
- 실패 시 회귀 시그널:
  - 이벤트 미수신 → `handleWorkerTaskComplete` 진입 실패(taskRunner.ts:251 리더 가드 오작동 또는 `onTaskComplete` 바인딩 누락).
  - `failedStep='commit'` + stderr `nothing to commit` → 워커가 실제 파일을 건드리지 않은 것(본 점검 전제 위반, 재시행).
  - `failedStep='push'` → E3 축으로 분기, 본 시나리오는 실패로 마감하고 E3 진행.

### E2 — 동시 다중 에이전트 완료

- 실행 절차(체크리스트):
  1. ⬜ Developer×2 + QA×1 편성. 각자 **서로 다른 파일** 을 편집하도록 프롬프트 분리.
  2. ⬜ 자동 개발 ON 후 3명이 거의 동시에 dispatch 되도록 idle 상태 정렬.
  3. ⬜ done 보고가 한 tick 안에 수렴하는지 서버 stdout 로 확인.
  4. ⬜ `firedTaskIds` 기록 3건 확인(taskRunner.ts:273, 로그로 간접 관측).
  5. ⬜ `git-automation:ran` 이벤트 수 집계 — 워커 단위 ≤3 + rising-edge 1 = 최대 4.
  6. ⬜ 각 발사마다 로컬/원격 SHA 페어 기록.
- 실 관측값:
  - `git-automation:ran` 총 횟수: _ (기대 3~4, 환경에 따라 commit 중복 시 일부 실패 정상)
  - 생성 브랜치 수: _ (기대 1 — 동일 `feature/e2e/<slug>` 에 누적 커밋이 정상)
  - rising-edge fire 시점 로그: _
  - 동일 taskId 중복 호출 시 `skipped='debounced'` 기록: _
- 실패 시 회귀 시그널:
  - 이벤트가 3회 초과 → `firedTaskIds` 디바운스 누수(R3 회귀).
  - rising-edge fire 가 0회 → `ProjectCompletionTracker` 가 `previousPhase` 를 영영 `busy` 로 기록하지 못한 것(N1 재현).
  - 두 번째/세 번째 발사가 `nothing to commit` 으로 실패 → 정상 가능. 단 원격에 최초 커밋이 실제로 반영됐는지 먼저 확인.

### E3 — push 실패 복구

- 사전 세팅(체크리스트):
  1. ⬜ 원격 bare 저장소에 같은 `feature/e2e/<slug>` 브랜치를 **다른 커밋** 으로 선행 배치
     (non-fast-forward 유도). 또는 네트워크를 임시 차단.
  2. ⬜ 로컬에서 E1 과 동일하게 태스크 완료 → commit 성공 → push 실패 경로 유도.
- 실행 절차:
  1. ⬜ `git-automation:failed` 1회 수신, `failedStep='push'` 확인.
  2. ⬜ `results.length === 4`, `results[3].ok === false`, 마지막 stderr 400자 슬라이스 무결.
  3. ⬜ 로컬 HEAD 는 원격 SHA 로 덮이지 않음(`localSha !== remoteSha`).
  4. ⬜ 스케줄러 `maxRetries` 재시도 경로가 설정돼 있다면 `재시도 실패 k/N` 로그 관찰.
- 복구 절차:
  1. ⬜ 원격 선행 커밋을 로컬로 `git fetch` → 수동 rebase/merge → 원격에 정상 push.
  2. ⬜ 에이전트 done 을 재전이(working → idle) 시킨 뒤 자동화가 새 사이클을 시작하는지 확인.
- 실 관측값:
  - `failedStep`: _ (기대 'push')
  - `results[3].stderr` 발췌: _ (기대: `! [rejected]  … (non-fast-forward)` 또는 네트워크 오류 메시지)
  - 재시도 횟수 로그: _
  - 복구 후 최종 로컬 SHA: _ / 원격 SHA: _ / 일치 여부: _
- 실패 시 회귀 시그널:
  - 푸시 실패인데 `pr` 단계가 results 에 나타남 → F2 회귀(`git-automation-failure-scenarios.md`).
  - 로컬 HEAD 가 원격 SHA 로 강제 덮임 → 자동화가 `--force` 를 썼다는 뜻. 즉각 롤백·리더 보고.
  - 재시도가 같은 `taskId` 로 무한 반복 → `firedTaskIds` 디바운스와 스케줄러 재시도 정책 충돌.

### 결과 보고 템플릿

실 검증을 마친 뒤 아래 5줄을 본 문서 이 섹션 아래에 덧붙이고 리더에게 동일 내용을 전달한다.

```
검증자: <실행자 이름>
검증 시각: YYYY-MM-DD HH:MM KST
E1 결과: [pass/fail] — 로컬 SHA=<..>, 원격 SHA=<..>, 이벤트 수=<..>
E2 결과: [pass/fail] — 워커 fire=<..>, rising-edge fire=<..>, 총 커밋 수=<..>
E3 결과: [pass/fail] — failedStep=<..>, 복구 후 일치 여부=<..>
```

### 실 환경 검증 미수행 사유(2026-04-18 작성 시점)

- 본 문서 작성 에이전트는 실 서버 기동·실 `git push` 수행 권한을 부여받지 않았다.
  공유 상태 변경(원격 push)은 사전 승인이 필요하므로, 체크리스트 골격과 기대값,
  수집 필드만 확정해 두고 실 관측값은 `_` 로 공란 유지.
- 작성 시점 워킹 트리가 미커밋 변경 30건 이상을 포함한 상태라(대부분 문서)
  현상 그대로 E1~E3 를 실행하면 자동화가 문서 변경까지 같이 스테이지해 버린다.
  실행 전 반드시 ▸ `git stash -u` 또는 ▸ 문서 변경만 먼저 별도 커밋 분리 필요.
- `git log` 저자 이력에 `Thanos`/`Joker` 는 0건. 두 이름은 게임 내 에이전트
  식별자이므로, 저장소 기준 "수정 반영 여부" 는 **자동화 경로가 발사한 커밋의 SHA**
  를 직접 비교해서만 판정 가능하다.

### 리더 에스컬레이션 조건

아래 중 한 가지라도 관측되면 즉시 리더(Kai)에게 재현 절차·로그와 함께 보고한다.

- E1 에서 `git-automation:ran` 이 0회 — 자동화 훅 자체가 끊긴 상태.
- E2 에서 rising-edge fire 와 워커 fire 가 동시에 0회 — `ProjectCompletionTracker`/`handleWorkerTaskComplete` 양쪽 모두 침묵.
- E3 에서 로컬 HEAD 가 원격 SHA 로 강제 덮임 — 비가역 사고, 즉시 롤백 절차 발동.
- 어느 축이든 같은 taskId 로 `git-automation:ran` 이 2회 이상 방출 — `firedTaskIds` 파손(R3/R10).
