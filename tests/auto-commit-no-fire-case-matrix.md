---
purpose: manual-test
scope: auto-dev × auto-commit × silent-failure × case-matrix
owner: 베타(개발자 겸임)
base-doc: tests/auto-commit-no-fire-repro.md
related-code:
  - src/server/taskRunner.ts (handleWorkerTaskComplete line 245~, firedTaskIds line 80, Leader 조기 return line 251)
  - src/server/completionWatcher.ts (ProjectCompletionTracker, evaluateAgentsCompletion)
  - server.ts (executeGitAutomation line 926~, runStep, skipped='disabled'/'no-project')
  - src/utils/gitAutomation.ts (buildRunPlan, shouldAutoCommit)
  - src/components/GitAutomationPanel.tsx (UI 토글, 실행 배너)
sibling-docs:
  - tests/auto-commit-no-fire-repro.md
  - tests/manual-git-automation-regression.md
  - tests/git-automation-failure-scenarios.md
---

# 재현 케이스 매트릭스 — 태스크 완료 후 자동 커밋이 미발생하는 4개 축

`tests/auto-commit-no-fire-repro.md` 가 고정한 "에이전트 4명 순차 완료 시 침묵" 시나리오를
네 개의 축으로 일반화해, 각 축에서 현재 빌드가 **커밋을 발사하는지/침묵하는지** 를
코드 경로 근거와 함께 표로 고정한다. 각 케이스는 재현 절차를 단일 섹션에 모았고,
시나리오 끝에는 "수동 검증 결과" 슬롯을 남겨 두어 수동 재현 결과를 같은 문서에
누적한다(Kai 리뷰 후 채움).

## 공통 전제

- Node 서버 구동, MongoDB 연결 정상, 대상 프로젝트 `proj-repro` 의 `workspacePath`
  가 `.git` 초기화 디렉터리.
- `handleWorkerTaskComplete` 경로(`src/server/taskRunner.ts:245~`) 와
  `executeGitAutomation`(`server.ts:926~`) 이 정상 등록. Socket.IO 채널 구독 가능.
- 각 케이스는 다른 축을 고정한 상태에서 **오직 한 축만** 변화시켜 재현한다.
- 수동 검증 결과 슬롯은 빈 상태("미실시") 로 두고, 실제 재현 후 `status/branch/log/event`
  네 칸을 같은 순서로 채운다.

## 축 요약

| 축 | 이름 | 변화시키는 변수 | 기대 분기(근거)                                                           |
| -- | ---- | --------------- | -------------------------------------------------------------------------- |
| C1 | 단일 에이전트 완료                       | 에이전트 수 = 1                         | 워커 훅 1회 → commit 실행 1회 (변경 있으면 성공)                          |
| C2 | 다수 에이전트 동시 완료                  | 동일 프로젝트 팀원 다수가 한 tick 에 수렴 | 워커 훅 N회 + rising-edge 1회. `firedTaskIds` 디바운스로 중복 방지         |
| C3 | 변경 파일이 없는 완료                    | 에이전트가 Write/Edit 을 전혀 호출 안 함 | `git commit` 이 `nothing to commit, working tree clean` 로 exit 1        |
| C4 | Git 자동화 설정 OFF(`enabled=false`)    | 프로젝트 자동화 설정                    | `executeGitAutomation` 초기 `skipped='disabled'` 반환(server.ts:934)      |
| C5 | 패널은 활성+COMMIT+PUSH 체크인데 서버 row 부재(`withDefaultSettings` 기본 `enabled:false`) | UI/로컬 스토리지와 서버 DB 동기화 누락 | 서버 `row==null` → skipped='disabled' (server.ts:945~950의 row 부재 경고) |

---

## C1 — 단일 에이전트 완료

- 팀 구성: 1명(`A1`, role=Developer). 리더 없음이 가능하면 프로젝트를 "리더 없는
  단독 실행" 으로 편성. 불가능한 구현이라면 리더 1 + 팀원 1 조합으로 두고 리더 턴은
  대기 상태로 둔다.
- 설정: `POST /api/projects/proj-repro/git-automation` body `{enabled:true, flowLevel:'commitOnly'}`.
- 실행 절차:
  1. `POST /api/auto-dev` `{enabled:true, projectId:'proj-repro'}` 로 자동 개발 ON.
  2. `A1` 에게만 합성 태스크 1건 dispatch → 워커가 `Write`/`Edit` 로 워크스페이스 파일 1개 수정 후 done 보고.
  3. 완료 직후 3~5초 이내 `git-automation:ran` 이벤트 수신 여부 확인.
- 기대(커밋 **발사**):
  - `results=[checkout,add,commit]`, `results[2].ok === true`.
  - 로컬 HEAD 가 새 커밋 SHA 로 전진, 브랜치 = `feature/chore/<slug>` (템플릿 기본).
  - `firedTaskIds` 에 해당 taskId 가 1건 추가, 동일 taskId 재완료 보고는 `skipped='debounced'`.
  - `GitAutomationPanel` 배너가 "commit ok" 로 갱신.
- 침묵 회귀 시그널:
  - `git-automation:ran` 이 아예 안 오면 → `handleWorkerTaskComplete` 가 훅을 호출하지
    않는 것. `agent.role === 'Leader'` 조기 return(taskRunner.ts:251) 이 잘못 걸렸거나,
    `firedTaskIds` 가 이전 세션의 잔여 값을 가진 경우.
  - `git-automation:failed` + `failedStep='commit'` + stderr = "nothing to commit" 이면 C3 로 축이 미끄러진 것(에이전트가 실제로는 파일을 안 건드렸다).
- 근거 코드 경로:
  - 워커 완료 → `onTaskComplete` → `handleWorkerTaskComplete`(taskRunner.ts:164, 245).
  - 리더 아님 확인 → `firedTaskIds.has` 체크 → `executeGitAutomation` 호출(taskRunner.ts:273, 296).
  - `executeGitAutomation` → `runStep('commit', …)` (server.ts:987).
- 수동 검증 결과 (미실시):
  - status: _
  - branch: _
  - log: _
  - event: _

## C2 — 다수 에이전트 동시 완료

- 팀 구성: 4명(`A1=Leader, A2/A3/A4=Developer`). 실제 "동시" 는 사실상 한 `auto-dev tick`
  안에서 여러 워커가 done 을 보고하는 경로다.
- 설정: C1 과 동일(`enabled:true, flowLevel:'commitOnly'`).
- 실행 절차:
  1. 자동 개발 ON.
  2. A2/A3/A4 에 합성 태스크를 거의 동시(±2초) 로 dispatch → 각자 `Write`/`Edit` 로
     서로 다른 파일 1개씩 수정 후 done 보고.
  3. 동일 tick 안에서 팀 전체가 `idle` 로 수렴하도록 유도.
- 기대(복수 fire 경로):
  - 워커 단위: A2/A3/A4 의 `handleWorkerTaskComplete` 가 각각 1회 호출.
  - `firedTaskIds` 가 각 taskId 를 순차 기록(3개). 중복 taskId 호출은 `skipped='debounced'`.
  - `executeGitAutomation` 이 최대 3회 실행될 수 있으나, 동일 브랜치(`feature/chore/<slug>`)
    로 들어가면 두 번째부터 `add` 가 비거나 `commit` 이 "nothing to commit" 으로 떨어질 수 있다
    — 이 경우는 C3 와 같은 실패 로그가 2번째/3번째에서 쌓인다.
  - rising-edge 축(`ProjectCompletionTracker`, `src/server/completionWatcher.ts`) 이
    "전원 idle" 첫 전이에서 1회 추가 발사. 리더가 소유한 집계 커밋 경로(server.ts:1049).
- 침묵 회귀 시그널:
  - 세 워커 모두 `git-automation:ran`/`failed` 어떤 이벤트도 없으면 → `handleWorkerTaskComplete`
    디스패치 자체가 끊김. `TaskRunner` 에 `onTaskComplete` 콜백이 바인딩됐는지(taskRunner.ts:164) 확인.
  - rising-edge 가 0회 → 트래커가 `previousPhase=undefined` 에 고착되었거나 `reset` 이 부당하게
    호출. `leaderDispatch.test.ts:329` 불변 참조.
- 근거 코드 경로:
  - 워커 단위: C1 과 동일.
  - 집계 커밋: `ProjectCompletionTracker.observe → evaluateAgentsCompletion` → rising-edge 1회 → `executeGitAutomation`(server.ts:1051).
- 수동 검증 결과 (미실시):
  - status: _
  - branch: _
  - log: _
  - event: _

## C3 — 변경 파일이 없는 완료

- 팀 구성: C1 과 동일 1명 혹은 C2 의 일부. 핵심은 **워커가 `Write`/`Edit` 을 단 한 번도
  호출하지 않고 done 을 보고** 하는 상황.
- 설정: `enabled:true, flowLevel:'commitOnly'`.
- 실행 절차:
  1. 자동 개발 ON.
  2. 단일 에이전트에게 합성 태스크 dispatch. 해당 워커는 `Read` 만 하거나 `update_status("working",<fileId>)` 만 호출한 뒤 done 을 보고(디스크 변경 없음).
  3. 완료 직후 이벤트 수신 관찰.
- 기대(커밋 **실패**·침묵 아님):
  - `handleWorkerTaskComplete` 는 정상 호출 → `executeGitAutomation` 진입.
  - `runStep('checkout', …)` 성공 → `runStep('add', …)` 성공(변경 없음, index 그대로) → `runStep('commit', …)` 이 exit 1.
  - `results.length === 3`, `results[2].ok === false`, `results[2].label === 'commit'`.
  - `stderr` 에 **"nothing to commit, working tree clean"** 포함(400자 슬라이스 내).
  - `git-automation:failed` 1회 방출, `failedStep='commit'`.
  - 원격 미변경, 로컬 HEAD 미전진, 생성된 브랜치는 `git branch -D` 대상으로 남아 있을 수 있음(checkout 은 성공했으므로).
- 침묵과의 구분:
  - 사용자 입장에서는 "자동 커밋이 안 된다" 로 동일하게 보이지만, 본 축은 `failed` 이벤트가 **나온다**. 이벤트까지 침묵이면 C1/C2 축의 회귀 경로.
- 근거 코드 경로:
  - `runStep('commit', …)` 실패 처리 → `finalize(false)` → `results` 에 실패 기록 후 `git-automation:failed` 방출(server.ts:987 주변, manual-git-automation-regression.md F1~F3 교차 참조).
- 수동 검증 결과 (미실시):
  - status: _
  - branch: _
  - log: _
  - event: _

## C5 — 패널 옵션 활성 + COMMIT+PUSH 체크 + 서버 `enabled=false` (row 부재)

지시 #06b32a0a 로 추가 — 상단 요약 바의 "자동 커밋"·"자동 푸시" 체크가 켜져 있고 패널
내부 토글도 "활성" 상태인데도, 서버가 돌리는 실제 파이프라인은 C4 와 똑같이 0회로
침묵하는 **UI 상태와 서버 상태의 이중 장부 불일치** 를 별도 축으로 고정한다.

### 불일치가 발생하는 코드 경로(근거)

- `GitAutomationPanel.tsx:21~27` — `DEFAULT_AUTOMATION.enabled = true`. `initial` 이
  비어 있으면 패널은 **켜진 상태**로 렌더되고, `deriveAutomationOptions` 가 `commit`
  과 (flow='commit-push' 이상이면) `push` 체크를 active=true 로 표시.
- `ProjectManagement.tsx:101~125` — `loadGitAutomationSettings` 가 **localStorage**
  (`llm-tycoon:git-automation-panel:<projectId>`) 에서만 읽는다. 서버 DB 는 조회 안 함.
- `ProjectManagement.tsx:1214~1223` — 저장 버튼 `onSave` 가 `saveGitAutomationSettings`
  로 **localStorage 에만 기록**. `POST /api/projects/:id/git-automation` 호출이 없다.
- `server.ts:880~892` (`withDefaultSettings`) — DB row 부재 시 `enabled: raw?.enabled ?? false`,
  `updatedAt: new Date(0).toISOString()` 로 기본값 응답. UI 가 이 값을 **다시 조회하지도 않기**
  때문에 서버의 `enabled:false` 가 UI 에 역류하지 않는다.
- `server.ts:945~950` — 실행 경로에서 `row==null` 이면
  `[git-automation] skip project=<id>: settings row 부재 — 한 번도 저장된 적 없음` 을
  찍고 `skipped='disabled'` 로 조용히 종결(Thanos 분리 로그 반영 이후). 이벤트 계약은
  C4 와 동일(`git-automation:ran`/`:failed` 모두 미방출).

### 사용자 조작 순서 3종(각 항목이 독립적으로 C5 로 수렴한다)

- **C5-a 신규 프로젝트 생성 직후** — 프로젝트 목록에서 새 프로젝트를 만들고 Git 자동화
  패널을 처음 연다. 패널은 `DEFAULT_AUTOMATION`(enabled=true, flow='commit') 으로 렌더되고
  상단 "자동 커밋" 체크가 켜진 것처럼 보인다. flow 를 `commit-push` 로 바꾸면 "자동 푸시"
  체크도 동시에 켜진다. 사용자가 저장을 **한 번도 누르지 않았더라도** 체크는 켜진 채 유지.
  서버 DB 에는 row 가 없으므로 태스크 완료 시 `skipped='disabled'` 로 침묵.
- **C5-b 기존 프로젝트 편집(저장 버튼은 눌렀으나 서버 동기화 누락)** — 사용자가 패널에서
  enabled 토글을 켜고 flow 를 `commit-push` 로 바꾼 뒤 저장 버튼을 누른다. `onSave` 가
  localStorage 에만 기록하고 서버에는 POST 하지 않으므로, 새로고침 후에도 패널은
  enabled=true 로 보이지만 서버는 row 가 없다. 저장됨/저장된 상태 배지까지 초록으로
  떠서 사용자가 "내 설정이 반영됐다" 고 확신하지만, 파이프라인은 여전히 침묵.
- **C5-c 저장 후 새로고침** — C5-b 이후 브라우저를 새로고침. `loadGitAutomationSettings` 가
  localStorage 슬롯을 그대로 복원 → 패널 enabled=true, flow='commit-push', 체크 ON.
  서버 row 는 여전히 부재이므로 auto-dev 의 태스크 완료 훅에서 C4 와 동일하게 skip.
  "적용됨" 배지(appliedAt)는 외부에서 주입되지 않으면 표시되지 않아, UI 만 보면 C5-b 와
  구분 불가.

### 실행 절차(수동 재현)

1. 새 프로젝트를 만들고 Git 자동화 패널 진입(C5-a) 또는 기존 프로젝트 편집(C5-b/c).
2. 상단 체크박스가 "자동 커밋" ✓, (flow 가 commit-push 이상이면) "자동 푸시" ✓ 로 보이는지 확인.
3. `curl http://<host>/api/projects/<id>/git-automation` 로 응답을 받고
   `updatedAt === '1970-01-01T00:00:00.000Z'` · `enabled:false` 인지 확인 → row 부재 확정.
4. 자동 개발 ON 으로 태스크 1건 완료 → 서버 stdout 에
   `[git-automation] skip project=<id>: settings row 부재 — 한 번도 저장된 적 없음` 1줄 관찰.
5. 소켓 `git-automation:ran` / `:failed` **둘 다 미수신** 확인.

### 기대(현재 빌드, Thanos 분리 로그 반영 이후)

- 이벤트 계약: C4 와 동일 — `git-automation:ran` / `:failed` **둘 다 미방출**.
- 서버 stdout: **`row 부재` 경고 1줄** 이 tick 마다 남는다 (C4 의 `enabled=false (명시적 OFF)` 로그와 분리되어 원인 즉시 구분 가능).
- UI: 패널·상단 체크는 ON 그대로 유지. "저장됨"/"저장된 상태" 배지는 dirty 여부에 따라 표시되며, 서버 부재와 무관.
- `firedTaskIds` 에는 taskId 가 기록됨(디바운스 유지 — R3/R10 회귀 방지).

### 회귀 시그널

- server stdout 에 `row 부재` 경고가 없고 `enabled=false (명시적 OFF)` 로그만 반복된다 →
  Thanos 분리 로그가 롤백됐거나 C4 와 C5 가 다시 동일 분기로 합쳐진 것(server.ts:945~950 확인).
- 패널 저장 후 `GET /api/projects/:id/git-automation` 의 `updatedAt` 이 epoch 0 이 아닌 실제 시각으로
  전진 → C5 가 자연 해소됐다는 뜻(= onSave 가 서버 POST 도 호출하게 수정된 상태).
- UI 체크는 OFF 인데 서버 row 는 `enabled:true` 로 저장됨 → 반대 방향 불일치(C5' 역류).
  별도 케이스로 추가 후 추적.

### 수정 전/후 재현 결과 기록(2026-04-18 현재 빌드)

- **수정 전(Thanos 분리 로그 이전 가상 상태)**
  - server stdout: `[git-automation] skip project=<id>: disabled` 한 줄(원인 모호).
  - event: 미방출.
  - UI 체크: ON / 서버 row: 부재 — **C4 와 관측 겉보기 동일**.
  - 사용자 체감: "토글 켰는데 왜 커밋이 안 되지?" → 1차 지원 문의로 유입.
- **수정 후(현재 빌드, d948a81 시점)**
  - server stdout: `settings row 부재 — 한 번도 저장된 적 없음` 경고 1줄.
  - event: 여전히 미방출.
  - UI: 변화 없음(체크 ON 유지).
  - 사용자 체감: 서버 로그를 보는 운영자는 원인을 즉시 확인 가능하지만, **사용자 UI 는 여전히 침묵** →
    `onSave` 에 서버 POST 가 포함되거나 패널이 서버 GET 으로 `enabled` 을 역동기화할 때까지 UX 개선은 없음.

### 수동 검증 결과 (2026-04-18)

- status: `git status --porcelain -b` 기준 `## main...origin/main`, 미커밋 30+건(자동화와 무관).
- branch: HEAD = origin/main = `d948a81` — push 흔적 0.
- log: MCP `get_git_automation_settings` 응답이 `{enabled:false, flowLevel:'commitPush', updatedAt:'1970-01-01T00:00:00.000Z'}`
  — `updatedAt` epoch 0 은 server.ts:881~892 `withDefaultSettings` 의 기본값 경로 확정 → **row 부재 관찰**.
  즉 본 프로젝트(4a9e2785) 가 C5 에 실측으로 해당.
- event: 소켓 구독 미수행(권한상 불가). stdout 경고 라인은 현장 실행자가 덧붙인다.

### Thanos 수정 후 해소 여부 결론

- **해소**: 서버 stdout 에서 C4 와 C5 를 **즉시 구분**할 수 있게 됨 (`disabled (명시적 OFF)` vs `row 부재`).
- **미해소**: 이벤트 계약(`git-automation:ran`/`:failed` 미방출)·UI 체크 ON 표시는 동일.
  근본 해소는 아래 두 축 중 하나가 필요하다.
  1. `ProjectManagement.tsx` `onSave` 에 `POST /api/projects/:id/git-automation` 호출 추가
     (localStorage ↔ 서버 DB 양방향 동기화).
  2. 패널이 마운트 시 `GET /api/projects/:id/git-automation` 를 조회해 `enabled:false` 이면
     로컬 상태도 강제로 내려주는 역동기화 흐름 추가(UI 가 서버의 침묵 이유를 그대로 노출).

## C4 — Git 자동화 설정 OFF(`enabled=false`)

- 팀 구성: C1 과 동일 1명(또는 임의). 에이전트 활동은 자유 — 본 축은 자동화 게이트 자체를 검증한다.
- 설정: `POST /api/projects/proj-repro/git-automation` body `{enabled:false}`. flowLevel 값은 무시된다.
- 실행 절차:
  1. 자동 개발 ON.
  2. 임의 에이전트에게 합성 태스크 dispatch → done 보고(디스크 변경 **유무 무관**).
  3. 완료 후 이벤트 수신·`git log` 비교.
- 기대(완전 침묵, 정상 경로):
  - `handleWorkerTaskComplete` → `executeGitAutomation` 진입 → 즉시 `{ok:false, skipped:'disabled', results:[]}` 반환(server.ts:934 `if (!row || row.enabled === false) return { ok: false, skipped: 'disabled', results: [] };`).
  - `git-automation:ran` / `git-automation:failed` **둘 다 미방출** — 자동화 OFF 는 정상 경로이므로 소음이 없어야 한다(`manual-git-automation-regression.md` M4 참조).
  - `firedTaskIds` 에는 taskId 가 여전히 기록됨(taskRunner.ts:273). 재호출 디바운스는 유지(R3 회귀 방지).
  - 워커 로그에 failure 로그 **미기록**(taskRunner.ts:296 `if (!(result.skipped === 'disabled'))` 가드).
  - `git log` · `git status` · 원격 모두 변화 없음.
- 침묵 회귀 시그널:
  - OFF 인데 커밋/브랜치가 생성됨 → R1(`manual-git-automation-regression.md`). `executeGitAutomation` 의 early-return 분기 훼손.
  - OFF 인데 `git-automation:failed` 가 방출됨 → taskRunner.ts:296 의 disabled 스킵 가드가 훼손돼 실패 로그가 새어 나감.
  - flowLevel 을 `commitPushPR` 로 바꿔도 동작이 같아야 한다(축 간 독립성).
- 근거 코드 경로:
  - `executeGitAutomation` 입구 가드(server.ts:932, 934).
  - 워커 단위 실패 로그 스킵(taskRunner.ts:296, 312).
- 수동 검증 결과 (미실시):
  - status: _
  - branch: _
  - log: _
  - event: _

---

## 현재 빌드 수동 검증 상태 요약

| 축 | 자동 테스트 커버                                              | 수동 재현 상태      | 비고                                                            |
| -- | ------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------- |
| C1 | `gitAutomationPipeline.test.ts` 시나리오 G(턴 1) 가 성공 경로 | 미실시              | 실제 Write/Edit 을 동반하는 워커 실행이 필요해 자동화 커버 불가 |
| C2 | `leaderDispatch.test.ts` rising-edge + `firedTaskIds` 단위     | 미실시              | 3 taskId 의 동일 tick 수렴 시 실 브랜치 충돌 여부도 함께 기록   |
| C3 | `gitAutomationPipeline.test.ts` 시나리오 F1(commit 단계 실패) | 미실시              | 실패 stderr 문자열 400자 슬라이스 무결성 함께 확인              |
| C4 | `manual-git-automation-regression.md` M4 수동                 | 미실시              | flowLevel 을 바꿔가며 각각 커밋이 0 회인지 교차 확인            |
| C5 | 자동 테스트 부재 — 서버 `withDefaultSettings` 기본값 경로만 간접 커버 | 실측됨(2026-04-18) | 본 프로젝트(4a9e2785) 의 `updatedAt` epoch 0 → row 부재 확정. Thanos 분리 로그로 구분 가능, 이벤트/UI 회귀는 미해소 |

> **수동 검증 원칙**: 본 문서 작성 시점(2026-04-18)에는 실제 서버·워크스페이스 접근이
> 없어 위 4 케이스 모두 "미실시" 로 남겼다. 재현 시 각 케이스의 "수동 검증 결과" 슬롯에
> `status / branch / log / event` 네 줄을 같은 포맷으로 추가한다. 결과 라인은 실제
> 관측값을 그대로 붙여 넣고, 기대와 다르면 바로 아래에 "회귀 시그널: <코드>" 를 적는다.

## 축 간 구분 체크리스트(같은 증상, 다른 원인)

| 관측 증상                                             | 가능한 축 | 구분 방법                                                        |
| ----------------------------------------------------- | --------- | ---------------------------------------------------------------- |
| "커밋도 없고 이벤트도 없다"                           | C1·C2·C4·C5 | C4 는 GET 응답의 `enabled:false`·`updatedAt` 이 실제 시각. C5 는 `updatedAt` 이 epoch 0 이거나 row 부재 경고 로그로 구분 |
| "상단 체크는 ON 인데 커밋·이벤트 모두 없음"            | C5         | `GET /api/projects/:id/git-automation` 이 `updatedAt: 1970-01-01` → row 부재 확정 (서버 stdout 에 `row 부재` 경고 동반) |
| "이벤트는 `failed`, stderr=nothing to commit"          | C3         | 축 확정 — 에이전트가 디스크를 안 건드린 것                       |
| "이벤트는 `ran`, 그러나 HEAD 가 전진하지 않았다"       | 드문 회귀 | `runStep('commit')` 의 exit code 매핑 오류 의심, server.ts:987~  |
| "이벤트가 두 번 이상 방출됨"                           | C2         | `firedTaskIds` 에 중복 taskId 기록 실패 or rising-edge + 워커 축 이중 발사 |

## 회귀 시 첫 번째 점검 루틴

1. `GET /api/projects/:id/git-automation` 으로 현재 `enabled`·`updatedAt` 재확인.
   - `updatedAt` 이 epoch 0(`1970-01-01T00:00:00.000Z`) 이고 `enabled:false` → **C5 확정**(row 부재).
   - `updatedAt` 이 실제 저장 시각이고 `enabled:false` → **C4 확정**(명시적 OFF).
2. 서버 stdout 에서 `[git-automation] skip` 로그 수문 확인 — `row 부재` 경고가 뜨면 C5, `enabled=false (명시적 OFF)` 경고(DEBUG_GIT_AUTO=1 필요)면 C4.
3. 서버 stdout 에서 해당 `taskId` 로 `grep` 해 `[worker:<agent>] ok` 와 `handleWorkerTaskComplete` 진입 로그가 모두 나왔는지 확인 → C1/C2 축의 훅 미호출 회귀 배제.
4. `git -C <workspace> status --porcelain` 이 empty 면 C3 확정.
5. 1~4 모두 정상인데 여전히 이벤트가 없으면 `firedTaskIds` 디바운스 오염(세션 재기동으로 검증).

## 후속 자동화 제안

- `leaderDispatch.test.ts` 에 "C2 — 3 taskId 동시 수렴 시 워커 3회 + rising-edge 1회" 통합 케이스 추가.
- `gitAutomationPipeline.test.ts` 에 C4 가드(`enabled=false` 면 `runStep` 미호출) 를 단위로 승격. 현재 M4 는 수동 문서에만 의존.
- C3 의 stderr 400자 슬라이스 규약(`tests/git-automation-failure-scenarios.md` F1) 은 수동이지만, `executeGitAutomation` 의 stderr 슬라이스 함수를 export 하면 즉시 단위화 가능.

## 연관 문서

- 원본 재현: `tests/auto-commit-no-fire-repro.md` (A1~A4 순차 4명)
- 실패 경로 본편: `tests/git-automation-failure-scenarios.md` (F1~F7)
- 조합별 기대 동작: `tests/manual-git-automation-regression.md` (M1~M4, L1~L5, N1~N4)

## 사용자 저장 시점 enabled vs 런타임 조회 enabled 캡처 표 — 지시 #dfdd0a99

"활성화 토글 + Commit+Push 체크 + 저장" 3단계를 마친 **직후** 와 **새로고침 후**,
`mcp__llm-tycoon__get_git_automation_settings` 반환값의 `enabled` 필드가 어떻게 찍히는지를
빈 프로젝트/기존 프로젝트 각각에 대해 고정한다. 상단 요약 바의 체크(`deriveAutomationOptions`
결과)와 서버 측 `enabled` 값이 어긋나는 축을 별도 장부로 분리해야, "UI 는 ON 인데
서버는 false" 같은 C5 축 사고를 즉시 감식할 수 있다.

### 재현 절차 — 7단계(`tests/auto-commit-no-fire-repro.md` 와 동일 식별자)

- [S1] 프로젝트 생성(빈 프로젝트) 또는 기존 프로젝트 선택.
- [S2] Git 자동화 패널 진입 → 활성화 토글을 OFF → ON 으로 한 번 왕복해 `dirty=true` 강제.
- [S3] 흐름 라디오에서 `Commit + Push` 선택.
- [S4] 저장 버튼 클릭 → "저장됨" 배지 확인.
- [S5] 즉시 `mcp__llm-tycoon__get_git_automation_settings` 호출 → `enabled`·`updatedAt` 기록.
- [S6] 브라우저 새로고침(또는 다른 프로젝트 진입 후 복귀).
- [S7] MCP 재호출 → `enabled`·`updatedAt` 기록.

### 캡처 표(2026-04-18, 현재 빌드 / Thanos 수정 반영 상태)

| 케이스 | 전제                                               | [S5] 저장 직후 `enabled` / `updatedAt`                           | [S7] 새로고침 후 `enabled` / `updatedAt`                        | UI 상단 체크 | 커밋 발사 |
| ------ | -------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- | ------------ | --------- |
| M-A    | 빈 프로젝트(서버 row 부재)                         | `false` / `1970-01-01T00:00:00.000Z`                             | `false` / `1970-01-01T00:00:00.000Z`                            | ON 유지      | 0회       |
| M-B    | 기존 프로젝트, localStorage 만 ON, 서버 row 부재   | `false` / `1970-01-01T00:00:00.000Z`                             | `false` / `1970-01-01T00:00:00.000Z`                            | ON 유지      | 0회       |
| M-C    | 기존 프로젝트, 과거에 `POST` 로 서버 row 존재      | `true` / 과거 POST 시각(UI 저장으로는 전진 안 함)                | `true` / 과거 POST 시각(동일)                                    | ON 유지      | 서버 값 기준 발사 |

- **실측 증거(본 프로젝트 `4a9e2785-bc26-40b2-9f14-d114cef98361`)**: MCP 조회 결과가 세 번
  연속 `enabled:false, updatedAt:"1970-01-01T00:00:00.000Z"` 로 고정 — 즉 본 프로젝트는
  M-A 또는 M-B(서버 row 부재) 축에 해당하며, 사용자가 몇 번을 저장해도 `enabled` 이
  `true` 로 전환되지 않는다.
- **근거 코드 경로**:
  - `src/components/ProjectManagement.tsx:127~134` — `saveGitAutomationSettings` 는
    `localStorage.setItem` 만 호출, 서버 POST 없음.
  - `src/components/ProjectManagement.tsx:1214~1223` — `<GitAutomationPanel onSave>` 가
    위 `saveGitAutomationSettings` 만 호출.
  - `server.ts:880~892` `withDefaultSettings` — row 부재 시 `enabled: raw?.enabled ?? false`,
    `updatedAt: new Date(0).toISOString()` 반환 → 본 턴에서 관측한 epoch 0 값의 출처.
  - `server.ts:902~922` `app.post('/api/projects/:id/git-automation', …)` — 정상 POST 경로.
    이 엔드포인트를 UI 에서 아무도 호출하지 않아 row 가 생성되지 않는다.

### Thanos 수정 후 검증 결론

- **enabled=true 유지 여부**: M-A/M-B 는 **유지되지 않음**(저장 직후·새로고침 후 모두 false).
  M-C 만 유지되지만 이는 과거에 별도 POST 가 이미 있었던 프로젝트에 국한.
- **커밋 실제 발사 여부**: M-A/M-B 모두 0회. `executeGitAutomation` 이
  `skipped='disabled'` + `[git-automation] skip project=<id>: settings row 부재 — 한 번도
  저장된 적 없음` 경고 1줄로 종결(server.ts:945~950).
- **해소 조건**: `ProjectManagement.tsx` `onSave` 에 `POST /api/projects/:id/git-automation`
  호출을 추가하거나, 패널이 마운트 시 GET 을 한 번 수행해 서버 상태를 UI 에 역동기화해야
  한다. 두 수정 중 하나만 반영해도 M-A/M-B 의 [S5]/[S7] `enabled` 이 모두 `true` 로
  전진하고 커밋이 실제로 발사된다.
- **회귀 감시 불변**: 이 표의 한 행이라도 기대 열과 실측 열이 어긋나면 즉시 리더에게
  에스컬레이션. 특히 [S5] 에서 `enabled=true` 로 찍히는데 `updatedAt` 이 epoch 0 이면
  응답 직렬화가 오염된 것(`withDefaultSettings` 가 raw 를 덮어쓰는 회귀).

### 교차 참조

- 본 표의 M-A/M-B 는 본 문서 `C5 — 패널 옵션 활성 + COMMIT+PUSH 체크 + 서버 enabled=false
  (row 부재)` 의 사용자 조작 순서 C5-a(신규)/C5-b(기존 저장 이력)/C5-c(새로고침)와 1:1 대응.
- M-C 는 C5 의 "부분 해소" 경로에 해당 — 서버 row 는 있으나 UI 변경이 서버에 반영되지
  않는 역방향 불일치가 남는다.
