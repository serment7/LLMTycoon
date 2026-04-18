---
purpose: manual-test
scope: auto-dev × 4-agent-sequential × commit-silent
owner: 베타(개발자 겸임)
reviewed-by: 디자이너 (6615fe14-393a-473d-bec8-f64dba43148d)
related-code:
  - src/server/taskRunner.ts (handleWorkerTaskComplete, firedTaskIds, autoDevTick)
  - server.ts (executeGitAutomation, POST /api/projects/:id/git-automation)
  - src/utils/gitAutomation.ts (shouldAutoCommit, buildRunPlan)
  - src/components/GitAutomationPanel.tsx (UI 토글·dispatchFromPanel 게이트)
  - src/components/GitAutomationPanel.test.ts (TC-GATE1~4, TC-GRAPH-SYNC-*)
sibling-docs:
  - tests/manual-git-automation-regression.md
  - tests/git-automation-failure-scenarios.md
---

# 재현 시나리오 — 에이전트 4명 순차 완료, 자동 커밋 침묵

자동 개발(auto-dev) 토글이 ON, Git 자동화 토글도 ON 인 상태에서 에이전트 A1→A2→A3→A4
가 `idle → working → done` 순서를 한 번씩 거치는 동안, 그럼에도 불구하고 워크스페이스에
아무 커밋도 생기지 않는 경우를 확정적으로 재현한다. 어느 에이전트에서 어느 단계가
스킵·실패하는지 한 표로 고정해, 이후 회귀가 발생해도 동일 표에 새 행을 추가하기만
하면 감사가 가능하게 한다.

## 사전 조건

- Node 서버 구동 + MongoDB 연결 정상 + Socket.IO 채널 구독 가능.
- 대상 프로젝트 `proj-repro`:
  - `workspacePath` 가 실제 `.git` 초기화된 디렉터리.
  - 원격(origin) 은 접근 가능하지만 이번 재현에서는 `commitOnly` 로 설정해 push 변수를 제거.
- 에이전트 4명:
  | alias | role       | persona 요지                        |
  | ----- | ---------- | ----------------------------------- |
  | A1    | Leader     | 분배 담당, 직접 구현 금지           |
  | A2    | Developer  | 파일 편집 권장, 이번엔 편집 없이 종료 |
  | A3    | QA         | 읽기/검토만 수행                    |
  | A4    | Designer   | UI 계획만 말로 보고                 |
- UI 상단 Git 자동화 패널:
  - `enabled=true`, `flow='commit'`(`flowLevel='commitOnly'`), `branchTemplate='feature/{type}/{slug}'`.
- `curl http://<host>/api/projects/proj-repro/git-automation` 로 `{ "enabled": true, "flowLevel": "commitOnly" }` 확인.

## 실행 절차

1. `POST /api/auto-dev`, body `{ "enabled": true, "projectId": "proj-repro" }`.
2. `AUTO_DEV_TICK_MS=12000` (12초) 마다 한 번씩 idle 에이전트 중 1명이 랜덤 선택되어
   합성 태스크가 생성된다. 실험의 결정성을 위해 **4명의 에이전트를 한 명씩만 idle 로 두고
   나머지는 임시 `thinking` 으로 격리**(직접 `update_status("thinking","")` 호출)해
   원하는 순서를 강제한다:
   - `t=0s` : A1 만 idle → 리더 태스크 1건 생성.
   - `t=30s`: A2 만 idle → 개발자 태스크 1건 생성.
   - `t=60s`: A3 만 idle → QA 태스크 1건 생성.
   - `t=90s`: A4 만 idle → 디자이너 태스크 1건 생성.
3. 각 구간 종료 직후 아래 세 스냅샷을 수집:
   - `git -C <workspace> status --porcelain -b` 한 줄 결과.
   - 서버 stdout 에서 해당 `taskId` 를 포함하는 전부의 로그 라인.
   - `git-automation:ran` / `git-automation:failed` 소켓 이벤트 페이로드(없으면 "없음").

## 기대 결과 표

| 순번 | 에이전트 | role      | 완료 후 커밋 | 파이프라인 중단 지점           | 근거 코드                                                 | git status(브랜치)            | 서버 로그 샘플                                                      |
| ---- | -------- | --------- | ------------ | ------------------------------ | --------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------- |
| 1    | A1       | Leader    | 없음         | `handleWorkerTaskComplete` 조기 return | taskRunner.ts:154 `if (agent.role === 'Leader') return;` | `## main`(변경 없음)          | 자동화 훅 미호출(이벤트 방출 없음), `[worker:A1] ok` 만 기록         |
| 2    | A2       | Developer | 없음         | `commit` 단계 실패             | server.ts `runStep('commit', …)` 이 exit 1                | `## main`(변경 없음)          | `[git-automation] step=commit failed … stderr=nothing to commit, working tree clean` + `git-automation:failed` 방출, `failedStep='commit'` |
| 3    | A3       | QA        | 없음         | `commit` 단계 실패             | 동일                                                      | `## main`(변경 없음)          | 동일 패턴, `task=<A3 taskId>` 만 바뀜                                |
| 4    | A4       | Designer  | 없음         | `commit` 단계 실패             | 동일                                                      | `## main`(변경 없음)          | 동일 패턴, `task=<A4 taskId>` 만 바뀜                                |

최종 상태: 워크스페이스 HEAD 는 재현 시작 시점 SHA 와 동일, 원격도 변화 없음.
`GitAutomationPanel` 의 "마지막 실행" 배지는 `formatRelativeTime`(GitAutomationPanel.test.ts:78~)
로 "방금 전 — 실패" 로 세 번 갱신된다(A2/A3/A4). A1 구간에서는 아예 업데이트되지 않는다
(훅이 돌지 않으므로 `git-automation:ran` 도 `git-automation:failed` 도 방출되지 않음).

## 관찰 포인트(디자이너 인수 대상)

- 상단 요약 바의 "자동 커밋" 체크는 `deriveAutomationOptions({flow:'commit', enabled:true})`
  결과로 ON 이지만(GitAutomationPanel.test.ts:125~), 실제 커밋은 0건이므로 체크 상태와
  커밋 결과가 괴리된다 — 사용자 문의 유입 포인트.
- "마지막 실행" 배지는 `formatRelativeTime` 의 미래 타임스탬프 클램프
  (GitAutomationPanel.test.ts:113) 덕분에 음수 라벨로 새는 사고는 없음. 다만 A1 구간에서는
  배지가 아예 갱신되지 않아 "자동화가 죽었나?" 오해가 생긴다 — 디자이너 검토:
  Leader 완료 시에도 "분배만 수행" 안내 마이크로카피를 배지에 노출할지.
- `TC-GATE1`(GitAutomationPanel.test.ts:209)는 `enabled=false` 의 체크 0건을 고정하지만,
  본 재현은 `enabled=true` 인데도 커밋이 없는 상황이라 UI 게이트만으로는 잡히지 않는 경로.
- `TC-GRAPH-SYNC-DISPATCH-PURE`(GitAutomationPanel.test.ts:648)는 dispatch 가 list_files
  스냅샷을 건드리지 않음을 고정. 본 재현에서 A2~A4 가 파일을 하나도 편집하지 않아
  list_files 가 0 인 상태에서도 체크 UI 가 "자동 커밋 ON" 으로 보이는 시각적 모순이 발생.

## 왜 이 네 경우가 각각 다른 이유로 침묵하는가

### A1 — Leader role 조기 return (의도된 스킵)

`TaskRunner.handleWorkerTaskComplete` 는 리더의 분배 결과를 커밋 대상에서 제외한다.
리더 턴은 JSON plan 생성이지 파일 변경이 아니므로, 매 리더 완료에 자동화가 돌면
빈 커밋·혹은 팀 파일 무작위 스테이지가 발생한다. 회귀 감지:
`handleWorkerTaskComplete` 안의 `if (agent.role === 'Leader') return;` 이 빠지면 A1
구간에서도 표 2~4 행과 동일한 로그 패턴이 나타난다(= 회귀).

### A2/A3/A4 — commit 단계 "nothing to commit" 실패

에이전트 워커는 `update_status("working", fileId)` 로 파일을 선점했어도 실제로 `Write`/`Edit`
를 단 한 번도 호출하지 않으면 워크스페이스는 변경이 없다. `executeGitAutomation` 은
`git -C <cwd> checkout -B <branch>` → `git add -A` → `git commit -m …` 순서로 진입하는데,
`add -A` 는 변경이 없으면 index 를 그대로 두고, `commit` 이 "nothing to commit, working
tree clean" 으로 exit 1 을 돌린다. 결과:

- `results[2].ok == false`, `results[2].label == 'commit'`, `results[2].stderr` 에 clean tree 메시지.
- `git-automation:failed` 1회 방출 + `failedStep='commit'`.
- `push`/`pr` 미실행(commitOnly 이므로 애초에 plan 에 없음, 풀 흐름일 때도 runStep 조기 return).

### 비 A1·commit 단계 실패 이외의 침묵 원인(본 재현에서는 의도적으로 배제한 변수)

재현 단순화를 위해 아래 축은 고정/제거했다. 별도 재현이 필요한 경우 각 시나리오 문서 참조:

| 추가 침묵 원인                                 | 본 재현에서 어떻게 배제했는지                             | 별도 문서                                              |
| ---------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| Git 자동화 `enabled=false`(전부 OFF)            | `POST /git-automation` 으로 `enabled:true` 확정           | `tests/manual-git-automation-regression.md` M4         |
| `skipped='no-project'`                         | `proj-repro` 가 존재하고 `_id` 가 유효함을 사전 확인      | 동일 문서 R5                                           |
| `firedTaskIds` 디바운스로 재시도 무시           | 각 에이전트의 taskId 는 `uuidv4` 이므로 충돌 확률 0        | R3, `git-automation-failure-scenarios.md` F5 주변      |
| push 단계 실패(네트워크/충돌/보호 브랜치)       | flowLevel 을 `commitOnly` 로 고정해 push 경로 자체 제거   | `git-automation-failure-scenarios.md` F2/F3            |
| `gh` 미설치·401                                | 마찬가지로 commitOnly 라 pr 경로 제거                     | 동일 문서 F4/F5                                        |
| 워크스페이스가 `.git` 아님                     | 사전 조건에서 `git init` 확인                             | —                                                      |

## 회귀가 의심될 때 체크리스트

1. 표 1행(A1) 에서 자동화 이벤트가 방출됐다면 → Leader 조기 return 이 훼손. taskRunner.ts:154 확인.
2. 표 2~4행의 `stderr` 가 "nothing to commit" 이 아니라면 → 에이전트가 의도치 않게 디스크를
   건드렸거나, 다른 세션이 동일 워크스페이스를 공유하고 있을 가능성. `ls -la <workspace>` 대조.
3. `commitOnly` 인데 `push`/`pr` 단계가 결과 배열에 나타나면 → `shouldAutoPush`/`shouldAutoOpenPR`
   의 flowLevel 분기가 훼손된 것. `gitAutomationPipeline.test.ts` 시나리오 D 로 단위 재현.
4. 같은 taskId 가 두 번 실패 로그에 찍히면 → `firedTaskIds` 디바운스가 깨짐. taskRunner.ts:159~165
   의 Set 크기 관리가 의심.
5. A1~A4 의 순서가 표와 어긋나면 → `autoDevTick` 의 `idleMembers.filter` 가 `thinking` 상태를
   포함하게 된 것. taskRunner.ts:255 `a.status === 'idle'` 비교를 확인.

## 복구 절차

- 자동 개발 OFF: `POST /api/auto-dev` body `{ "enabled": false }`.
- 에이전트 임시 격리 복구: `update_status("idle","")` 로 각자 재개.
- 실패 이벤트로 쌓인 UI 배지 초기화: GitAutomationPanel "최근 실행" 섹션의 지우기 버튼
  (현재 미구현 시 소켓 재연결로 리셋).
- DB 에 남은 재현용 태스크 제거: `db.tasks.deleteMany({ projectId: 'proj-repro' })`.

## 후속 자동화 제안(우선순위)

1. 서버 단위 테스트 — `handleWorkerTaskComplete` 를 타고 `executeGitAutomation` 까지 가는
   Leader-role 조기 return 을 자동 고정(현재 자동 테스트 부재; 본 재현 1행에 해당).
2. "nothing to commit" 실패 경로의 단위 고정 —
   `gitAutomationPipeline.test.ts` 실패 경로 3(커밋 실패 시 하위 스킵)은 flowLevel=commitPushPR
   기준으로 있으나, commitOnly + 에이전트 워커 시뮬레이션 조합은 비어 있음.
3. A1~A4 와 동일 순서의 통합 테스트 — `TaskRunner` 를 in-memory DB 로 기동해 4개의 taskId 가
   서로 독립적으로 파이프라인에 들어가고 1행만 조기 return, 2~4행만 `failedStep='commit'`
   로 방출되는 계약을 자동 회귀로 전환.

## 정상 경로 E2E — 개선 보고 → 리더 재분배 → 전원 완료 → 자동 커밋+푸시 발동

본 재현 문서는 "침묵" 을 고정하는 쪽이라, 반대 경로(= 체인이 끝에서 커밋을 실제로
쏘는 경로)는 `src/utils/gitAutomationPipeline.test.ts` 의 **시나리오 G** 로 자동
회귀화했다. A1~A4 와 같은 4명 구성을 두고 체인을 따라가며, 어떤 턴에서만 자동화가
발사되는지를 아래 표와 같이 고정한다.

| 턴 | 에이전트 | source     | 훅 결과                    | git 단계 실행          |
| -- | -------- | ---------- | -------------------------- | ---------------------- |
| 1  | Developer| auto-dev   | fired=true                 | checkout→add→commit→push |
| 2  | Leader   | auto-dev   | skipped='leader'           | (없음)                 |
| 3  | QA       | leader     | fired=true                 | checkout→add→commit→push |
| 4  | Designer | leader     | fired=true                 | checkout→add→commit→push |

추가 회귀 단언:
- 총 발사 3회, 리더 0회, 디바운스 0건.
- 각 턴의 브랜치 ref 가 로컬과 원격에서 동일 SHA 로 반영.
- 같은 taskId 를 한 번 더 흘리면 `skipped='debounced'` 로 전환돼 2회째는 실행되지 않음
  (`firedTaskIds` 규약).

실패 경로 쌍 시나리오는 `tests/git-automation-failure-scenarios.md` F6(에이전트 idle
미복귀 → 훅 미호출 → 자동화 0회)·F7(리더 재분배 무한 루프 방지 가드) 과 짝을 이뤄
단일 파일 `gitAutomationPipeline.test.ts` 안에서 G/H/I 세 시나리오로 동시에 고정된다.

## 저장 시점 vs 런타임 조회 시점 enabled 장부 — 지시 #dfdd0a99

"활성화 토글 + Commit+Push 체크 + 저장" 3단계를 수행한 **직후** 와 **새로고침 후**,
`mcp__llm-tycoon__get_git_automation_settings`(= 서버 GET `/api/projects/:id/git-automation`)
의 `enabled` 필드가 어떻게 찍히는지를 프로젝트 생성 이력별로 고정한다. 패널 UI 상의
체크·토글 상태와 서버 DB 상태는 별개 장부이므로, 두 장부의 어긋남을 이 표로 즉시 감식한다.

### 공통 재현 절차

각 케이스에서 아래 7단계를 그대로 밟는다. 단계 식별자는 `[S1]…[S7]`.

- [S1] Git 자동화 패널 진입 (빈 프로젝트면 직전 `프로젝트 관리 > 새 프로젝트` 직후).
- [S2] 활성화 토글 클릭 → 스위치가 "활성" 으로 전환되는 것을 확인 (기본값이 이미 활성인
  빌드에서는 클릭을 건너뛰지 말고 한 번 끄고 다시 켜 `dirty=true` 를 강제).
- [S3] 흐름 라디오에서 `Commit + Push` 를 선택 → 상단 요약 바의 "자동 푸시" 체크가 ON.
- [S4] 저장 버튼 클릭. "저장됨" 배지가 2.8초간 초록으로 뜨는지 확인.
- [S5] **즉시** 터미널에서 MCP `get_git_automation_settings` 호출 → `enabled`·`updatedAt` 캡처.
- [S6] 브라우저 탭 새로고침(F5) 또는 해당 프로젝트를 나갔다 재진입.
- [S7] MCP `get_git_automation_settings` 재호출 → `enabled`·`updatedAt` 캡처.

### 케이스 R-A — 빈 프로젝트(신규 생성 직후)

- 전제: 방금 만든 프로젝트로, `git_automation_settings` 컬렉션에 해당 `projectId` row 가
  한 번도 저장된 적이 없다.
- 기대(현재 빌드 / Thanos 수정 반영 상태):
  - [S5] 저장 직후 조회: `enabled=false`, `updatedAt="1970-01-01T00:00:00.000Z"`.
    근거: `ProjectManagement.tsx:1214~1223` 의 `onSave` 가 localStorage 만 기록하고
    `POST /api/projects/:id/git-automation` 을 호출하지 않으므로, 서버 row 는 부재 그대로.
    GET 측은 `server.ts:880~892`(`withDefaultSettings`)의 기본값 경로로 응답 → epoch 0.
  - [S7] 새로고침 후 조회: **S5 와 완전 동일**(enabled=false, updatedAt epoch 0).
    localStorage 는 `loadGitAutomationSettings` 로 복원돼 UI 는 enabled=true 로 보이지만
    서버 상태는 변하지 않았다.
  - UI 패널 체크: [S4] 후에도 상단 "자동 커밋"·"자동 푸시" 체크가 ON 으로 남아 있다.
    즉 **UI=ON / 서버=false** 불일치가 저장 직후부터 새로고침 후까지 지속.
- 실측 캡처(2026-04-18, 본 프로젝트 `4a9e2785-bc26-40b2-9f14-d114cef98361`):
  - 본 에이전트가 MCP 를 직접 호출한 결과: `enabled:false, updatedAt:"1970-01-01T00:00:00.000Z"`
    → 본 프로젝트의 S5/S7 은 케이스 R-A 기댓값과 완전히 일치.
- Thanos 수정 후 해소 여부:
  - `enabled=true` 로 유지되지 않는다. 커밋도 0건(`executeGitAutomation` 이 `skipped='disabled'` 로 조기 종결). **미해결**.

### 케이스 R-B — 기존 프로젝트(과거에 UI 저장 이력 있음, 서버 row 는 여전히 부재)

- 전제: 같은 프로젝트에 대해 이전 세션에서 [S4] 까지 이미 수행했던 기록이 있다.
  `llm-tycoon:git-automation-panel:<projectId>` localStorage 에는 `{flow:'commit-push',
  enabled:true, …}` 가 들어 있으나, `git_automation_settings` 컬렉션에는 여전히
  row 가 없다(= `onSave` 경로가 한 번도 서버 POST 를 호출한 적 없음).
- 기대:
  - [S1] 진입 시 패널은 localStorage 로부터 enabled=true, flow='commit-push' 로 복원.
  - [S2]~[S4] 는 dirty 가 false 일 수도 있으므로 한 번 토글을 끄고 다시 켜 [S4] 저장을 강제.
  - [S5] 저장 직후 조회: R-A 와 **동일**(`enabled:false, updatedAt:epoch 0`). localStorage 만 갱신되고 서버 row 는 생성되지 않는다.
  - [S7] 새로고침 후 조회: 동일.
- 실측 대체 증거: 본 턴의 MCP 조회 결과(`enabled:false, updatedAt:epoch 0`)는 현 프로젝트가
  과거에 패널 조작을 거쳤는지 여부와 무관하게 R-B 가 R-A 와 관측상 같은 값에 수렴함을
  뒷받침한다(서버 DB 키는 projectId 하나이므로 UI 저장 이력이 있었더라도 POST 가 없으면
  row 가 생기지 않는다).
- Thanos 수정 후 해소 여부: R-A 와 동일하게 **미해결**.

### 케이스 R-C — 기존 프로젝트(과거에 MCP / API 로 직접 POST 된 이력 있음)

- 전제: 다른 경로(예: `curl -X POST /api/projects/:id/git-automation`, 혹은 MCP
  `trigger_git_automation` 이 서버 내부에서 설정을 기록하는 분기)로 서버 row 가 이미
  실제 시각으로 저장돼 있다.
- 기대:
  - [S5] 저장 직후 조회: 과거 POST 된 설정이 그대로 나옴. `enabled=true`, `updatedAt` 은
    과거 POST 시각.
  - UI 에서 [S2]~[S4] 로 토글을 다시 만지고 저장해도 `onSave` 는 서버에 반영하지 않으므로
    `updatedAt` 은 전진하지 않는다. 즉 사용자는 "방금 저장했다" 고 믿지만 서버의 설정은
    마지막 실제 POST 시점에 고정.
  - [S7] 새로고침 후 조회: S5 와 동일(서버 상태 변화 없음).
- 실측 불가: 본 프로젝트는 POST 이력이 없어(epoch 0) R-C 로 분류되지 않는다. R-C 재현에는
  별도 `curl -X POST /api/projects/<id>/git-automation -d '{"enabled":true,"flowLevel":"commitPush",…}'`
  선행이 필요.
- Thanos 수정 후 해소 여부: **부분 해소** — `enabled=true` 는 유지되지만, 여전히 UI 저장으로는
  서버가 갱신되지 않아 **UI 가 바꾸는 값과 서버 값이 어긋나는 축** 은 남는다(UI flow 변경이
  서버에는 반영되지 않고, 커밋 플로우는 과거 POST 시점 값대로 발사).

### 장부 요약

| 케이스 | 사용자 저장 [S4] 직전 서버 row 상태 | [S5] 저장 직후 enabled | [S7] 새로고침 후 enabled | 커밋 실제 발사 여부 | Thanos 수정 후 |
| ------ | ------------------------------------ | ---------------------- | ------------------------- | ------------------- | -------------- |
| R-A    | 부재                                 | false (epoch 0)        | false (epoch 0)          | 0회(skipped=disabled) | 미해결         |
| R-B    | 부재(localStorage 만 있음)           | false (epoch 0)        | false (epoch 0)          | 0회                 | 미해결         |
| R-C    | 존재(과거 POST 됨, enabled=true)     | true (과거 시각)       | true (과거 시각)         | 서버 row 기준 발사  | 부분 해소      |

### 회귀 해소 조건(제안)

- `ProjectManagement.tsx` `onSave` 에 서버 POST 호출 추가:
  ```
  await fetch(`/api/projects/${selectedProjectId}/git-automation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: next.enabled,
      flowLevel: mapPanelFlowToServer(next.flow),
      branchTemplate: next.branchPattern,
      commitConvention: '…',
      commitScope: '',
      prTitleTemplate: next.prTitleTemplate,
      reviewers: [],
    }),
  });
  ```
  적용 후 R-A/R-B 에서 [S5]/[S7] 의 `enabled` 이 `true` 로 유지되고 `updatedAt` 이 실제
  저장 시각으로 전진해야 한다.
- 또는 `GitAutomationPanel` 마운트 시 서버 GET 을 한 번 호출해 `enabled:false` 이면 로컬
  state 도 강제로 내려 UI 와 서버를 역동기화. 이 경우 R-A/R-B 에서 UI 체크가 자동으로
  OFF 로 보여 사용자가 "저장이 먹지 않았다" 는 신호를 즉시 받는다.
- 위 두 보정 중 **한 가지만** 적용해도 본 장부의 R-A/R-B 는 해소된다. 두 보정을 동시에 적용하면
  UI 측 역동기화가 POST 성공 직후 과도 갱신을 일으킬 수 있어 POST 경로만 추가하는 쪽이 안전.
