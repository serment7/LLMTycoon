---
purpose: regression-run-log
scope: project-management-settings × save × reload × defaults × corruption-recovery
executor: 개발자 에이전트 (6940336c-c26d-46cb-9054-f4803030c898)
executed-at: 2026-04-19
trigger-directive: 지시 #1b5b300c (완료 보고 대상: 개발자 Thanos)
related-code:
  - src/server/taskRunner.ts (우선 검토 — 저장된 자동 개발/자동 커밋 옵션을 소비하는 태스크 디스패처)
  - src/utils/projectOptions.ts (서버 PATCH 검증 + projectOptionsView 기본값 채움, line 35~109)
  - src/utils/useProjectOptions.ts (DB 단일 소스 훅 — 새로고침 시 GET /api/projects/:id/options 재수화)
  - src/components/ProjectManagement.tsx (projectScopedKey·loadUserPreferences·saveUserPreferences·migrateUserPreferencesToProject·parseGitAutomation)
  - src/types.ts (PROJECT_OPTION_DEFAULTS, USER_PREFERENCES_KEY, BRANCH_STRATEGY_VALUES)
  - src/App.tsx (LOG_STORAGE_KEY · LOG_PANEL_KEY · LOG_PANEL_TAB_KEY · SELECTED_PROJECT_KEY 수화 구간, line 51·127·187·242·277·486)
related-tests:
  - tests/projectOptions.regression.test.ts (P1~P4 — DB 저장-조회-agentWorker 적용 라운드트립)
  - src/utils/projectOptions.test.ts (검증기 단위 15건)
  - src/components/ProjectMenuScope.test.ts (프로젝트 스코프 격리 133건)
---

# 프로젝트 관리 설정 저장/로드 회귀 (2026-04-19)

지시 #1b5b300c 의 5대 검증 항목을 현재 저장소에 존재하는 **두 층의 영속화 경로**
— (A) 서버 DB 저장( `useProjectOptions` → PATCH /api/projects/:id/options ) 와
(B) 브라우저 localStorage 저장( `llm-tycoon:project-settings:<projectId>` · 로그 ·
선택 프로젝트 ) — 양쪽에서 재현했다. 우선 검토 파일 `src/server/taskRunner.ts`
는 (A) 경로의 저장값을 직접 소비하는 **하류 컨슈머**이므로, 저장 누수는 곧
자동 개발 가드(`shouldAutoCommit`/`shouldAutoPush`)가 어긋나 태스크가 엉뚱한
브랜치로 커밋되는 회귀로 이어진다.

## 자동 테스트 실행 결과 요약

실행 환경: Windows 11, Node 기본, `npx tsx --test …` (2026-04-19 수행).

| 스위트                                        | 테스트 수 | 통과/실패      | 비고                                                                              |
| --------------------------------------------- | --------- | -------------- | --------------------------------------------------------------------------------- |
| tests/projectOptions.regression.test.ts       | 16        | ✅ 16 / 0      | P1(저장-새로고침 복원) · P2(타입 오류 거절) · P3(저장 → agentWorker 적용) · P4(동시 저장 last-write-wins) · POST/GET 라운드트립 |
| src/utils/projectOptions.test.ts              | 15        | ✅ 15 / 0      | updateProjectOptionsSchema·projectOptionsView 기본값 병합 계약                     |
| src/components/ProjectMenuScope.test.ts       | 133       | ⚠️ 77 / 56     | 본 지시 범위 밖의 스코프 격리 슈트. 실패 56건은 사전 존재로 판단(코드 미변경), 지시 #1b5b300c 의 5대 항목과 무관 — 후속 지시에서 별도 조치 권고 |

위 3개 스위트 합쳐 본 지시 범위(S1~S5)의 **직접 대상 31건은 전부 통과**. 격리
슈트 실패 56건은 참고용으로만 기록하고 본 문서의 Pass 판정에서 제외한다.

## 전제 조건

- `npm run dev` 로 프론트엔드 기동, MongoDB 연결 OK, 로그인·초기 `gameState` 수화 완료
- 프로젝트 ≥ 2개, 각 프로젝트마다 팀원 1인 이상 편성
- DevTools → Application 탭의 LocalStorage / IndexedDB 접근이 가능한 Chromium 계열
- 서버 측 `/api/projects/:id/options` `GET/PATCH`, `/api/projects/:id/git-automation`
  `GET/POST` 가 모두 200 으로 응답하는 정상 상태

## 관찰 포인트

| 층    | 키 / 엔드포인트                                           | 기대 계약                                                                              |
| ----- | --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| DB    | `GET /api/projects/:id/options` → `projectOptionsView`     | 누락 필드는 `PROJECT_OPTION_DEFAULTS` 로 채워 항상 동일한 모양 반환                       |
| 훅    | `useProjectOptions.update(patch)`                         | 낙관적 갱신 없음 — 서버 응답 후에만 `setData`. 네트워크 실패 시 UI 플리커 금지             |
| 브라우저 | `llm-tycoon:project-settings:<projectId>`                 | JSON 파싱 실패 시 `loadUserPreferences` 가 `{}` 반환(조용한 복구)                         |
| 브라우저 | `llm-tycoon:logs` · `…:log-panel-h` · `…:log-panel-tab` · `…:selected-project` | 개별 키가 깨져도 해당 키 한 건만 초기화 — 앱 전체가 흰 화면으로 빠지지 않는다              |
| 하류   | `src/server/taskRunner.ts` → `runGitAutomation` 가드       | 저장된 `flowLevel`·`enabled` 가 MCP 응답을 통해 `shouldAutoCommit/Push/OpenPR` 에 1:1 반영 |

## 시나리오 매트릭스

| 번호 | 축                            | 사전 상태                                                                          | 트리거                                                          | 기대 결과                                                                                                                                                              |
| ---- | ----------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | 개별 설정 저장 → 새로고침 복원 | 프로젝트 A, 모든 옵션 기본값                                                       | `autoDevEnabled` · `autoCommitEnabled` · `defaultBranch` · `branchStrategy` · `gitAutomation.flowLevel` 을 한 개씩 바꿔 저장 후 F5 | 새 세션의 GET 응답과 localStorage 재수화값이 방금 저장한 값과 완전히 일치, `taskRunner` 의 다음 실행이 저장값대로 분기                                                    |
| S2   | 재진입 플리커 방지             | S1 완료 상태                                                                       | 탭 닫고 다시 열기 → `useProjectOptions` 초기 마운트              | `loading=true` 프레임에서 체크박스가 기본값으로 번쩍이다 덮어써지는 현상 **없음**. `data===null` 상태는 스켈레톤/비활성으로 처리되어야 한다                              |
| S3   | 연속 변경 누적 보존            | 모든 옵션 기본값                                                                   | 5개 이상 필드를 연속 PATCH(autoDev → autoCommit → autoPush → branchStrategy → fixedBranchName) | 최종 GET 응답에 5건 변경이 모두 반영, P4 계약대로 **last-write-wins** 로 손실 없음. localStorage 영역(`gitAutomation` 서브필드)도 `parseGitAutomation` 통과 후 전부 복원 |
| S4   | 빈 저장소 최초 진입 기본값      | `projects` 컬렉션에 옵션 필드가 하나도 없는 레거시 문서 + localStorage 비어 있음 | 프로젝트 A 최초 오픈                                             | `projectOptionsView` 가 `PROJECT_OPTION_DEFAULTS` 를 그대로 채워 응답, 패널의 모든 토글/드롭다운이 기본값 표시. `ProjectManagement` 가 400 에러 없이 렌더              |
| S5   | 저장소 손상·용량 초과 복구      | localStorage 에 `llm-tycoon:project-settings:<id>` = `"{corrupt"` 저장, 또는 `setItem` 이 QuotaExceeded 던지는 상태 | 프로젝트 진입 → 패널 열기 → 설정 하나 변경                        | `loadUserPreferences` 가 `{}` 반환하고 화면은 기본값으로 부팅, `saveUserPreferences` 의 try/catch 가 예외를 흡수해 앱 크래시 없음. 콘솔은 경고 1건 이하                |

---

## S1 — 개별 설정 저장 → 새로고침 복원

**절차**
1. `ProjectManagement` 패널에서 아래 5개 필드를 **각각 1회씩 독립 변경** 후 저장 버튼:
   - `autoDevEnabled` OFF→ON, `autoCommitEnabled` OFF→ON, `defaultBranch` `main→develop`,
   - `branchStrategy` `new→current`, `gitAutomation.flowLevel` `commitOnly→commitPushPR`.
2. 매 변경 후 `PATCH /api/projects/:id/options` 응답 200 확인.
3. 브라우저 전체 새로고침(F5) → `useProjectOptions.load` 재호출 관찰.
4. 서버 측 `runGitAutomation` 이 저장된 `flowLevel` 대로 동작하는지 `agentWorker` 로그 1건 확인.

**기대 결과**: 각 필드가 새 탭/새로고침 이후에도 동일값으로 복원됨. `tests/projectOptions.regression.test.ts` 의 P1 · 라운드트립이 자동으로 이 계약을 잠그고 있음(이번 런 16/16 통과).

**관찰(2026-04-19 턴 내)**: 자동 테스트 계약 검증 통과. 수동 절차는 서버·DB 기동이 필요해 본 턴 범위 밖 — 다음 배포 스모크에서 브라우저 F5 단계 실측 권장.

---

## S2 — 재진입 플리커 방지

**절차**
1. S1 완료 상태에서 DevTools Network 탭 열고 "Slow 3G" 로 스로틀.
2. 탭 닫기 → 다시 열기.
3. 패널 렌더 첫 2 프레임(첫 paint, 첫 PATCH 응답 직후)을 스크린샷.

**기대 결과**: `data===null && loading===true` 구간에서 체크박스는 **disabled 스켈레톤**
또는 마지막 캐시값 유지. 기본값으로 튀었다가 저장값으로 돌아오는 플리커 금지.
낙관적 갱신을 쓰지 않는다는 `useProjectOptions.ts` 주석(line 12~13) 계약과 일치.

**리스크**: `useProjectOptions` 내부에 명시적인 스켈레톤 UI 계약이 없어,
`ProjectManagement` 쪽 렌더러가 `data===null` 을 기본값과 혼동하면 플리커가 재발할 수 있다.
S2 는 렌더 측 가드(`if (!options) return <Skeleton/>`) 존재 여부를 함께 확인할 것.

---

## S3 — 연속 변경 누적 보존

**절차**
1. DevTools Console 에서 5회 연속 PATCH 호출(각 다른 필드).
2. 마지막 200 응답 후 `GET /api/projects/:id/options` 재호출.
3. `gitAutomation` 서브 객체의 6개 키(`flowLevel`·`branchTemplate`·`commitConvention`·`commitScope`·`prTitleTemplate`·`reviewers`) 전부 기대값으로 복원 확인.

**기대 결과**: 5건 모두 보존. P4 "last-write-wins" 는 **같은 필드**에 대한 경합일 때만 적용되고, **서로 다른 필드** 5건은 병합 누적되어야 한다.

**관찰(2026-04-19)**: `tests/projectOptions.regression.test.ts` P4 + 라운드트립 16/16 통과로 서버측 계약 확인. 브라우저 측 `parseGitAutomation` 이 모든 서브필드 타입을 검사하므로, 하나라도 누락·손상되면 `undefined` 반환하여 저장본 전체가 무시됨을 주의(실전 회귀 리스크).

---

## S4 — 빈 저장소 최초 진입 기본값

**절차**
1. 신규 프로젝트 생성(또는 기존 프로젝트 문서에서 옵션 필드를 수동 삭제).
2. localStorage 의 `llm-tycoon:project-settings:<id>` 키가 부재한 상태 유지.
3. 해당 프로젝트 열고 `ProjectManagement` 패널 렌더.

**기대 결과**: `projectOptionsView` 의 기본값 병합으로
- `autoDevEnabled=false` · `autoCommitEnabled=false` · `autoPushEnabled=false`
- `defaultBranch=PROJECT_OPTION_DEFAULTS.defaultBranch`
- `branchStrategy=PROJECT_OPTION_DEFAULTS.branchStrategy`
- `settingsJson` 은 기본 객체의 **사본**(참조 공유 금지, line 155 의 `{...PROJECT_OPTION_DEFAULTS.settingsJson}`)

모든 토글·드롭다운이 초기 상태로 렌더되고 콘솔 에러 0건.

**관찰**: `src/utils/projectOptions.test.ts` 의 projectOptionsView 케이스가 누락 필드 기본값 채움을 검증(15/15 통과). 신규 프로젝트 실측은 다음 배포 스모크 대상.

---

## S5 — 저장소 손상·용량 초과 복구

**절차 A — 손상된 JSON**
1. DevTools 에서
   ```js
   localStorage.setItem('llm-tycoon:project-settings:<id>', '{corrupt');
   ```
2. 프로젝트 진입, 패널 열기.

**기대 A**: `loadUserPreferences` 가 JSON.parse 예외를 삼키고 `{}` 반환 → 패널은 기본값으로 부팅(line 59~63 의 catch 경로). 앱 전체 흰 화면·스택 트레이스 금지.

**절차 B — 용량 초과**
1. DevTools 에서 `Storage.prototype.setItem` 을 몽키패치:
   ```js
   const real = Storage.prototype.setItem;
   Storage.prototype.setItem = function () { throw new DOMException('QuotaExceededError', 'QuotaExceededError'); };
   ```
2. 설정 하나 변경하여 저장 시도.
3. 저장 실패 후 복원:`Storage.prototype.setItem = real;`

**기대 B**: `saveUserPreferences` try/catch 가 예외 삼킴(line 66~74). 세션 내 메모리 상태는 유지, 다음 PATCH 는 정상 진행(서버 DB 는 localStorage 와 독립이므로 영향 없음). 패널에 "저장 실패" 토스트가 뜨되 앱은 살아 있다.

**절차 C — parseGitAutomation 타입 붕괴**
1. 저장본 중 `gitAutomation.reviewers` 를 숫자 배열로 손상:
   ```js
   const raw = JSON.parse(localStorage.getItem('llm-tycoon:project-settings:<id>'));
   raw.gitAutomation.reviewers = [1,2,3];
   localStorage.setItem('llm-tycoon:project-settings:<id>', JSON.stringify(raw));
   ```
2. 새로고침.

**기대 C**: `parseGitAutomation` 이 `reviewers` 배열 요소 타입 검사(line 25)에서 `undefined` 반환 → `loadUserPreferences` 가 `gitAutomation` 필드 자체를 누락시킨 `UserPreferences{}` 반환. 패널은 `DEFAULT_AUTOMATION` 으로 재부팅.

---

## 실행 로그 — G/S1~S5 관찰 (2026-04-19)

| 번호 | 관찰자                          | 실행 경로          | 결과                 |
| ---- | ------------------------------- | ------------------ | -------------------- |
| S1   | 개발자 에이전트 (자동 테스트 P1 대리 검증) | 자동 테스트 16/16   | ✅ 통과(계약 유지)   |
| S2   | —                               | 수동(다음 스모크)   | ⏸ 미실행 — 렌더 가드 실존 여부 점검 필요 |
| S3   | 개발자 에이전트 (P4 + 라운드트립)          | 자동 테스트 16/16   | ✅ 통과(계약 유지)   |
| S4   | 개발자 에이전트 (projectOptionsView 케이스) | 자동 테스트 15/15   | ✅ 통과(기본값 병합) |
| S5   | —                               | 수동(DevTools 스크립트) | ⏸ 미실행 — try/catch 계약은 정적 코드에서 확인 |

자동 테스트 계약에서 커버되지 않는 S2/S5 의 수동 절차는 본 문서를 그대로
다음 QA 스모크 체크리스트로 들고 가면 즉시 재생 가능하도록 고정했다.

## 리스크 메모

- (A)-(B) 두 층의 동기화 부재: 같은 필드가 DB 와 localStorage 양쪽에 산재하는 새
  기능을 추가할 때 **단일 진실 소스 규칙**이 깨질 수 있다. `useProjectOptions.ts`
  주석이 "DB 단일 진실 소스" 를 명시하고 있으므로, 신규 필드는 DB 쪽에만 두는 것을
  기본으로 할 것.
- `taskRunner.ts` 는 `getGameState()` 를 통해 간접적으로 옵션을 읽는다. 저장 직후
  5초 내에 `runGitAutomation` 이 트리거되면 `getGameState` 캐시가 오래된 값을
  반환할 수 있는지 별도 확인이 필요하다(본 회귀 범위 밖, 후속 지시 후보).
- ProjectMenuScope 슈트 77/133 만 통과: 본 지시 범위와 직접 관계는 없지만 프로젝트
  설정 스코프 격리 계약이 일부 깨진 채 머물러 있음. S1·S3 이 "프로젝트 A 의 저장이
  프로젝트 B 로 번지지 않는다" 를 간접 가정하므로 후속 지시에서 정리 권고.
