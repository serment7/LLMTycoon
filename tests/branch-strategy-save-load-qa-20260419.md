# 브랜치 전략 설정 저장/로드 · 수동 QA 체크리스트 (2026-04-19)

- 대상 영역: `src/components/GitAutomationPanel.tsx` 의 4 전략 라디오(`per-commit` / `per-task` / `per-session` / `fixed-branch`) 저장·로드 왕복
- 연관 자동 테스트:
  - `tests/branchStrategySaveLoad.regression.test.ts` — **신규** 19 케이스(S1~S4 + 라운드트립)
  - `tests/gitAutomationPanelBranchStrategy.regression.test.ts` — 패널↔래퍼 하이드레이션 레이스(B1~B4)
  - `tests/branchStrategy.regression.test.ts` — 전략별 실제 git 저장소 행동(B1~B5)
  - `src/utils/projectOptions.test.ts` — 필드 검증/`projectOptionsView` 단위
- 코드 접촉면:
  - `src/utils/projectOptions.ts` — `projectOptionsView` 에 **로드 폴백 가드** 추가(신규 `coerceBranchStrategy`)
  - `server.ts:787` · `server.ts:831` — GET/PATCH 모두 `projectOptionsView` 경유
- QA 담당: 하네스 QA 에이전트 · 리뷰 요청 대상: 개발자 Joker

## 1. 사전 조건

1. 로컬 개발 서버 기동
   - `npm run dev` (vite + `server.ts`)
   - 서버가 `http://localhost:3000` 에서 열려 있고, MongoDB(기본 개발 인스턴스) 가 살아있음을 확인.
2. 테스트 프로젝트 2 건 이상 준비 (이후 탭 전환 시나리오에 사용).
3. 브라우저 개발자 도구 → Application → IndexedDB/Local Storage 에 캐시된 상태가 없도록 "새로고침(Shift+F5)" 한 번 수행.

## 2. 용어 매핑

본 문서의 "A안 / B안 / 단일모드" 는 브랜치 전략 라디오의 4 선택지를 시나리오 가독성을 위해 그룹화한 것이다.

| 축       | 매핑되는 라디오 키 | UI 라벨        |
|----------|--------------------|----------------|
| A안      | `per-task`         | 태스크별 브랜치 |
| B안      | `per-commit`       | 커밋별 브랜치   |
| 단일모드 | `fixed-branch`     | 고정 브랜치     |
| 기본값   | `per-session`      | 세션 브랜치    |

## 3. 시나리오 체크리스트

각 시나리오의 "자동 테스트" 컬럼은 실패 시 가장 먼저 의심할 회귀 테스트를 가리킨다. "수동 확인" 은 UI 에서 반드시 눈으로 봐야 하는 항목이다.

### S1 — A안 선택 후 저장 → 새로고침 → A안으로 복원

- [ ] 프로젝트 관리 탭 → GitAutomationPanel 열기
- [ ] 4 전략 라디오에서 **태스크별 브랜치(per-task)** 선택
- [ ] 저장 버튼 클릭 → 상단에 "저장됨" 녹색 배지 노출 확인(2.8초)
- [ ] 브라우저 전체 새로고침(F5)
- [ ] 프로젝트 관리 탭 다시 열기 → 라디오가 **태스크별 브랜치** 로 선택되어 있음
- 자동 테스트: `S1 — Given 빈 프로젝트 When A안(per-task) 저장 → GET(새로고침) Then 패널 로드값이 per-task` (`branchStrategySaveLoad.regression.test.ts:104`)

### S2 — B안/단일모드에서 A안으로 변경 → 저장·로드 왕복

#### S2-1 B → A (커밋별 → 태스크별)

- [ ] 라디오를 **커밋별 브랜치(per-commit)** 로 전환·저장
- [ ] 새로고침 → per-commit 이 복원됨을 확인
- [ ] 라디오를 **태스크별 브랜치(per-task)** 로 전환·저장
- [ ] 새로고침 → per-task 가 복원됨을 확인

#### S2-2 단일모드 → A (고정 → 태스크별)

- [ ] 라디오를 **고정 브랜치(fixed-branch)** 로 전환
- [ ] 하위 입력 필드 "브랜치명" 에 `release/alpha` 입력 · 저장
- [ ] 새로고침 → fixed-branch + `release/alpha` 복원 확인
- [ ] 라디오를 **태스크별 브랜치(per-task)** 로 전환·저장 (이 때 브랜치명 입력 필드는 숨겨짐)
- [ ] 새로고침 → per-task 가 복원됨
- [ ] 라디오를 다시 **고정 브랜치** 로 전환 → 브랜치명 입력란이 **`release/alpha` 로 복원** 되어야 함
  - ⚠ 이 마지막 항목은 "환승 시 fixedBranchName 을 잃지 않는다" 계약. 실패 시 `S2 — Given 단일모드(fixed-branch) + fixedBranchName When A안으로 변경 …` 테스트 참조.
- 자동 테스트:
  - `S2 — Given B안(per-commit) 저장 상태 When A안(per-task) 으로 변경 → GET Then 로드값이 per-task`
  - `S2 — Given 단일모드(fixed-branch) + fixedBranchName When A안으로 변경 Then 로드는 per-task, fixedBranchName 은 이전 값 보존`
  - `S2 — A안 → 단일모드 → A안 왕복에서 전략값이 유실되지 않는다`

### S3 — 기존 설정 파일에 값이 없는 경우 기본값 처리

- [ ] 레거시 프로젝트(`projects` 컬렉션에 `branchStrategy` 필드가 없는 문서) 를 **직접 Mongo 에서 한 건 만들거나**, 새 프로젝트를 만들고 GitAutomationPanel 을 한 번도 저장하지 않은 상태로 준비
- [ ] 해당 프로젝트 관리 탭 진입
- [ ] 라디오가 **세션 브랜치(per-session)** 로 선택되어 있고, 에러 없이 렌더링 됨
- [ ] `fixedBranchName` 입력란의 기본값이 `auto/dev`, 패턴 입력란 기본값이 `auto/{date}-{shortId}` 인지 확인
- [ ] 저장하지 않고 탭을 닫았다 다시 열어도 동일하게 세션 브랜치로 보임(= DB 에 아무 변화 없음)
- 자동 테스트: `S3 — Given branchStrategy 필드가 없는 레거시 프로젝트 When GET Then 기본값(per-session) 이 채워진다` 외 3건

### S4 — 잘못된 값이 들어있을 때의 폴백

#### S4-a 저장 차단 (쓰기 경로 400)

- [ ] 브라우저 콘솔에서 다음과 같이 손으로 잘못된 PATCH 를 쏴 본다
  ```bash
  curl -X PATCH http://localhost:3000/api/projects/<projectId>/options \
       -H 'Content-Type: application/json' \
       -d '{"branchStrategy":"legacy-v0"}'
  ```
- [ ] 응답이 **HTTP 400** 이고 에러 메시지에 `branchStrategy` 문자열이 포함되어 있음
- [ ] MongoDB 해당 문서에 `branchStrategy` 필드가 저장되지 않았음(기존 값이 있으면 그대로 유지)

#### S4-b 로드 폴백 (읽기 경로)

- [ ] `mongosh` 로 DB 에 직접 접속해 한 프로젝트의 `branchStrategy` 를 유효하지 않은 값으로 덮어쓴다
  ```js
  db.projects.updateOne({ id: "<projectId>" }, { $set: { branchStrategy: "legacy-v0" } })
  ```
- [ ] 해당 프로젝트 관리 탭 진입 / 새로고침
- [ ] 라디오가 **세션 브랜치(per-session) 기본값으로 폴백** 되어 있고, UI 어느 곳에도 `legacy-v0` 문자열이 노출되지 않음
- [ ] 사용자가 라디오를 **태스크별 브랜치** 로 전환·저장하면 DB 가 `per-task` 로 정상화됨
- [ ] 다시 새로고침하면 per-task 가 복원됨 (= 폴백 이후 재저장이 유효)
- 자동 테스트:
  - `S4-b — 로드 경로: DB 에 이미 들어있는 잘못된 값은 조용히 기본값으로 폴백된다`
  - `S4-b — 로드 경로: branchStrategy 가 null 이면 기본값으로 폴백`
  - `S4-b — 로드 경로: branchStrategy 가 빈 문자열/공백만 있으면 기본값으로 폴백`
  - `S4-b — 로드 경로: branchStrategy 가 숫자/객체/배열 등 비문자형이면 기본값으로 폴백`
  - `S4 — 로드 폴백 후 다시 PATCH 를 보내 값을 바로잡으면 이후 로드가 올바른 값으로 고정된다`

## 4. 회귀 판정 기준

- S1~S3 중 한 건이라도 실패하면 **저장/로드 왕복** 회귀로 릴리스 보류.
- S4-a 가 400 을 내지 않으면 **쓰기 경로 검증 누수**(saveValidationError) 로 즉시 롤백.
- S4-b 에서 UI 에 유효하지 않은 문자열이 노출되거나 라디오가 "선택 없음" 상태가 되면 **로드 가드 회귀** — `src/utils/projectOptions.ts::coerceBranchStrategy` 동작 재확인.

## 5. 최종 실행 결과 (2026-04-19)

| 축                                 | 실행                                                              | 결과            |
|------------------------------------|-------------------------------------------------------------------|-----------------|
| 신규 회귀 스위트(19 케이스)        | `npx tsx --test tests/branchStrategySaveLoad.regression.test.ts` | ✅ 19/19 통과    |
| 인접 브랜치 전략 스위트(80 케이스) | 위 + projectOptions + panel + strategy + new-or-current           | ✅ 80/80 통과    |
| 수동 QA                            | 본 문서 체크리스트 — 배포 스모크 직전 재검증 예정                 | ⏳ 배포 전 실시 |

## 6. 후속 작업 제안

- `coerceBranchStrategy` 의 가드가 생겼으므로, 같은 축의 다른 열거 필드(`autoDevEnabled`, `autoMergeToMain` 등) 에도 동일한 로드 폴백을 검토 — 현재는 `boolean` 이라 덜 위험하지만, 향후 새 열거 필드가 추가될 때 같은 패턴을 복제한다.
- `git_automation_settings.branchStrategy` ('new'|'current') 축은 server.ts:1465 에 이미 열거 검증 가드가 존재 — 본 문서 범위 밖이나, 회귀 스위트로 잠그려면 `tests/projectOptions.regression.test.ts::withDefaultSettings` 와 같은 패턴으로 확장 가능.
