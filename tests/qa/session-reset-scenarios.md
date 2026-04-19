# 세션 토큰 만료·리셋 회귀 시나리오

- 작성일: 2026-04-19
- 작성자: QA (`agentId=6940336c-c26d-46cb-9054-f4803030c898`)
- 범위: Claude 구독 5시간 롤링 윈도우의 **만료·리셋 사이클** 전용 — 5
  시나리오를 스텝바이스텝으로 기록하고, 현 프로젝트 러너(`node --test` +
  `@testing-library/react` + `jsdom`, Playwright 미도입) 로 자동화 가능한
  범위는 `tests/e2e/session-reset.spec.ts` 에 코드 초안을 제공한다.
- 중복 회피: 전반 UI 스모크는 `tests/qa/ui-smoke-report.md` 로 분리해 다룬다.
  본 문서는 그 문서의 §1.2(`claude-session:status` 소켓 핸들러 누락) 와
  §2.1(리셋 시 `sessionStatus` 미복원) 을 **연관 참조만** 하고, 본 문서 자체는
  "세션 창이 열리고 닫히는 동안 각 계층이 어떻게 반응해야 하는가" 의 단계별
  관찰 계약을 고정한다.

## 테스트 기반 구조

- 러너: `node --test`. 실행 예 —
  `npx tsx --test tests/e2e/session-reset.spec.ts`.
- 소켓 실제 연결은 하지 않는다. `claudeTokenUsageStore` 의 공개 API(`hydrate`,
  `reset`, `setSessionStatus`, `subscribe`, `__setForTest`) 와
  `claudeSubscriptionSession.ts` 의 순수 함수(`computeSubscriptionSessionSnapshot`)
  만 호출해 이벤트 효과를 흉내 낸다.
- 서버 큐 쪽은 `src/server/agentWorker.ts` 가 `setAgentWorkerSessionStatus`,
  `notifyTaskBoundary`, `flushQueuedTaskBoundaries`, `getQueuedTaskBoundaryCount`,
  `setTaskBoundaryHandler` 를 이미 노출 중이라 jsdom 없이도 단위 경계에서 검증
  가능하다. (참조: `tests/agentWorkerTaskBoundary.regression.test.ts`.)
- Playwright 가 필요한 "실제 브라우저 렌더 + 색상 대비 확인" 은 §수동 체크
  리스트로 분리한다.

## 공개 심볼 참조

| 심볼 | 위치 | 본 문서 활용 |
|---|---|---|
| `claudeTokenUsageStore.{hydrate,applyDelta,reset,setSessionStatus,subscribe,__setForTest}` | `src/utils/claudeTokenUsageStore.ts:624-690` | 시나리오 1·2·3·4 |
| `computeSubscriptionSessionSnapshot(...)` | `src/utils/claudeSubscriptionSession.ts:107` | 시나리오 1·3 |
| `severityFromRatio(ratio)` | `src/utils/claudeSubscriptionSession.ts:85` | 시나리오 1(잔량 5%↓ 색상) |
| `SUBSCRIPTION_SESSION_WINDOW_MS`, `DEFAULT_SUBSCRIPTION_TOKEN_LIMIT` | 같은 파일 25·33 | 시나리오 3 |
| `setAgentWorkerSessionStatus`, `notifyTaskBoundary`, `flushQueuedTaskBoundaries`, `getQueuedTaskBoundaryCount` | `src/server/agentWorker.ts:373,121,154,113` | 시나리오 2·3 |
| `GitAutomationSettings.branchMode/branchModeNewName`, `DEFAULT_AUTOMATION` | `src/components/GitAutomationPanel.tsx:67-84` | 시나리오 5 |
| `toServerSettings` / `fromServerSettings` 의 왕복 계약 | `tests/branchModeSketch.regression.test.ts` 및 `tests/branchStrategySaveLoad.regression.test.ts` | 시나리오 5 |

---

## 시나리오 1 — 토큰 소진 직전(잔량 ≤ 5%)에서 상단바 배지 전환

### 목적

누적 사용량이 세션 한도의 95% 를 넘어갈 때 상단바 배지(`TokenUsageIndicator`)
의 색상·툴팁이 **경고 단계** 로 전환되는지, 그리고 잔량 라벨이 사용자가 즉시
인지 가능한 수준으로 갱신되는지를 잠근다.

### 스텝바이스텝

1. **초기 상태**: `claudeTokenUsageStore.__setForTest(EMPTY state)` 로 0 토큰
   상태를 주입. `computeSubscriptionSessionSnapshot({prev:null, cumulativeTokens:0,
   nowMs:T0})` 의 스냅샷을 기록한다. 기대: `severity === 'ok'`, `used === 0`,
   `isReset === false` (최초 마운트는 리셋 아님 — `claudeSubscriptionSession.ts:125` 주석).
2. **서서히 사용**: 누적 토큰을 `limit * 0.49` 로 증가시킨 후 스냅샷. 기대:
   `severity === 'ok'`.
3. **주의 단계**: 누적을 `limit * 0.50` 로 올린 뒤 스냅샷. 기대: `severity === 'caution'`.
4. **임계 단계**: 누적을 `limit * 0.80` 로 올린 뒤 스냅샷. 기대: `severity === 'critical'`.
5. **잔량 5% 이하**: 누적을 `limit * 0.95`, `limit * 0.99`, `limit * 1.00`
   으로 올리며 각각 스냅샷. 기대: 모두 `severity === 'critical'`, `remaining` 이
   각각 5%, 1%, 0% 로 감소.

### 현재 구현 차이(🟠 UX 관찰)

- `severityFromRatio(ratio)` 은 0.5 / 0.8 두 임계만 쓰며, **"95% 이상"
  을 별도 단계로 분리하지 않는다**. 디자이너가 요구한 "잔량 5% 이하에서
  색상·툴팁이 경고 상태로 전환" 은 **0.8 이상인 `'critical'` 에 병합** 되어
  있어, 사용자는 "80%" 와 "99%" 를 시각적으로 구분하지 못한다.
- 개선 제안(본 문서 §제안 §1): `severityFromRatio` 에 0.95 임계를 추가하거나
  `remaining` 퍼센트를 툴팁 상단에 항상 굵게 표기.

### 자동화 가능 범위

- 순수 함수 `computeSubscriptionSessionSnapshot` 의 단계별 `severity`
  전환은 코드 초안 §1 에서 `node --test` 로 완전 자동화.

### 수동 확인 필요

- 실제 브라우저에서 배지 색상 대비(WCAG AA), 툴팁 애니메이션, 키보드 탐색.

---

## 시나리오 2 — 세션 만료 순간, 진행 중 작업이 재시도 큐로 이동

### 목적

Claude 호출이 `token_exhausted` 또는 `subscription_expired` 로 실패해 서버가
세션 상태를 `'exhausted'` 로 전환한 순간, 에이전트 작업 경계 이벤트가 **즉시
실행되지 않고 큐에 보관** 되는지 잠근다. `queueOnExhausted: true`(기본값,
`src/types.ts:305-312`) 계약의 관찰 증거를 얻는다.

### 스텝바이스텝

1. **상태 active**: `setAgentWorkerSessionStatus('active')`. 태스크 경계 핸들러
   하나를 `setTaskBoundaryHandler(handler)` 로 등록.
2. **정상 플러시 1회**: `notifyTaskBoundary({taskId:'t1', ...}, {...queueOnExhausted:true})`
   → 핸들러가 **즉시 호출** 되어야 함. `getQueuedTaskBoundaryCount() === 0`.
3. **세션 만료 전환**: `setAgentWorkerSessionStatus('exhausted')`.
4. **만료 중 경계**: `notifyTaskBoundary({taskId:'t2'}, {queueOnExhausted:true})`.
   기대:
   - 핸들러는 이 시점에 **호출되지 않음**.
   - `getQueuedTaskBoundaryCount() === 1`.
5. **추가 경계 누적**: `notifyTaskBoundary({taskId:'t3'}, {queueOnExhausted:true})`.
   기대: 큐 2건, 핸들러 호출 없음.
6. **옵트아웃 확인**: `notifyTaskBoundary({taskId:'t4'}, {queueOnExhausted:false})`.
   기대: 핸들러가 이 단 한 건만 즉시 호출(운영자가 소진 상태에서도 강제
   실행을 원한 경우 경로가 살아 있는지).

### 자동화 가능 범위

- `tests/agentWorkerTaskBoundary.regression.test.ts` 가 이미 유사 계약을 잠그고
  있다. 본 시나리오는 "active → exhausted 전환 직후 첫 경계가 큐잉" 이라는 축을
  추가로 커버. 코드 초안 §2.

### 수동 확인 필요

- 실제 Claude CLI `token_exhausted` 가 방출되면 서버가 정말 `'exhausted'`
  를 브로드캐스트하는지(서버 측 이벤트 버스 `onTokenExhausted` 구독자 확인).
- UI 스모크 보고서 §1.2(소켓 핸들러 누락) 해결 후에만 엔드투엔드 가능.

---

## 시나리오 3 — 5시간 경계 리셋, 큐 자동 재개

### 목적

5시간 윈도우를 지나 `computeSubscriptionSessionSnapshot` 이 `isReset=true`
를 돌려준 시점에, ① 카운터가 자동 초기화되고 ② 시나리오 2 에서 쌓인 큐가
`flushQueuedTaskBoundaries()` 로 자동 플러시되는지 잠근다.

### 스텝바이스텝

1. **초기 윈도우**: `nowMs = T0`, `cumulative = 500_000`, `prev = null` 로
   최초 스냅샷. `state.windowStartMs === T0`.
2. **4시간 59분 시점**: `nowMs = T0 + 5h - 60_000`, `cumulative = 950_000`
   로 두 번째 스냅샷. 기대: `isReset === false`, `used === 450_000`,
   `severity === 'critical'`(95% 소비).
3. **리셋 경계**: `nowMs = T0 + 5h + 1`, `cumulative = 950_000` 로 세 번째
   스냅샷. 기대:
   - `isReset === true`.
   - `state.windowStartMs === T0 + 5h + 1` (새 창 열림).
   - `used === 0` (새 창의 `tokensAtWindowStart` 이 현 누적으로 당겨짐).
   - `remaining === limit`.
4. **스토어 동기화**: 리셋 감지 직후 호출자(React `useEffect`) 가
   `claudeTokenUsageStore.reset()` → `claudeTokenUsageStore.setSessionStatus('active')`
   를 호출. 기대: 구독자 스냅샷의 `all.inputTokens + outputTokens === 0`,
   `sessionStatus === 'active'`.
5. **큐 플러시**: 리셋 트리거가 `flushQueuedTaskBoundaries()` 를 호출.
   기대: 시나리오 2 에서 쌓은 2건이 **FIFO 순서로** 핸들러 호출.
   `getQueuedTaskBoundaryCount() === 0`.

### 현재 구현 차이(🔴 결함 관찰)

- `claude-session:status` 소켓 핸들러 부재(UI 스모크 §1.2) 때문에, 실제 앱
  에서 단계 4·5 의 "자동 재개" 는 발생하지 않는다. 본 시나리오는 그 결함이
  해결된 뒤를 가정한 **계약 문서** 역할을 겸한다.
- `claudeTokenUsageStore.reset()` 은 누적만 0 으로 되돌리고 `sessionStatus`
  는 건드리지 않음(UI 스모크 §2.1). 본 시나리오는 두 경로가 **반드시 함께
  불려야 한다** 는 계약을 추가로 잠근다.

### 자동화 가능 범위

- 순수 함수 단계 1·2·3 은 완전 자동화. 단계 4·5 는 스토어·큐 모듈만 호출.

### 수동 확인 필요

- 실제 브라우저에서 배지가 `critical` → `ok` 로 즉시 전환되고, 잔량 표시가
  `100%` 로 복원되는지.

---

## 시나리오 4 — 리셋 감지 실패(네트워크 지연) 시 폴백 배지·수동 갱신 버튼

### 목적

서버 리셋 이벤트(또는 `GET /api/claude/token-usage`) 가 네트워크 지연·오류로
도달하지 못했을 때, UI 가 **폴백 배지** 로 전환되고 **수동 갱신** 경로가
노출되는지 잠근다.

### 스텝바이스텝

1. **정상 active**: 세션 active, 배지는 `"세션 토큰: 500K / 1M"` 형태.
2. **서버 응답 지연**: 모킹된 `fetch('/api/claude/token-usage')` 가 5초 이상
   지연 → `claudeTokenUsageStore.setError('네트워크가 지연되고 있습니다')`.
3. **스토어 관찰**: `subscribe` 로 받은 스냅샷의 `loadError` 가 채워져 있다.
4. **배지 렌더**: 상단바(`ClaudeTokenUsage.tsx` / `TokenUsageIndicator.tsx`)
   가 `loadError` 를 소비해 "세션 토큰: --" 폴백 배지를 표시.
5. **수동 갱신**: 사용자가 배지를 클릭하거나 "다시 불러오기" 버튼을 눌러
   `fetch('/api/claude/token-usage')` 가 재시도되어야 한다.

### 현재 구현 차이(🔴 결함 관찰)

- `ClaudeTokenUsage.tsx`, `TokenUsageIndicator.tsx`, 어디에도 **"수동 갱신"
  전용 버튼이 없다**. `setError` 경로는 존재하지만 버튼이 없어 사용자는
  새로고침 외에 회복 수단이 없다.
- 폴백 문구("세션 토큰: --") 는 확인되지 않은 장면(UI 스모크 범위에서 미확인).
  렌더 분기가 있어야 한다는 계약을 본 문서에서 정의.

### 제안

- 배지 클릭 → `fetch('/api/claude/token-usage')` 재발동 + 소켓 재연결 트리거.
- "마지막 갱신 N초 전" 라벨을 툴팁에 추가.

### 자동화 가능 범위

- 스토어 계층은 `setError` / 복구 후 `hydrate` 호출로 단위 테스트 가능.
- 실제 버튼 렌더·클릭은 RTL(react-testing-library) 로 jsdom 에서 가능하지만
  컴포넌트 자체가 버튼을 갖지 않아 **구현 후** 잠금 대상.

### 수동 확인 필요

- 네트워크 탭 throttling 으로 실제 지연 재현, 폴백 배지 노출 시각 확인.

---

## 시나리오 5 — 재개 후 Git 자동화 상태(branchMode 포함) 무손상 유지

### 목적

리셋 경계를 넘어 세션이 재개된 뒤에도, `GitAutomationSettings` 의
`branchMode` / `branchModeNewName` 이 포함된 자동화 설정이 **DB 저장값 그대로**
복원되는지 잠근다. 즉 세션 리셋은 토큰 카운터·큐에만 영향을 주고, 프로젝트
단위 저장 구성에는 손대지 않아야 한다.

### 스텝바이스텝

1. **사전 저장**: PATCH `/api/projects/:id/git-automation` 으로
   `{flowLevel:'commitPush', uiBranchStrategy:'per-task', branchMode:'continue',
   branchModeNewName:'feature/keep'}` 저장.
2. **세션 active 상태에서 확인**: GET 응답이 위 값과 동일. `GitAutomationPanel`
   이 라디오·입력을 그 값으로 렌더.
3. **세션 만료 → 큐잉**: 시나리오 2·3 동일한 조건으로 세션 `'exhausted'`
   전환 후 태스크 경계 2건 큐잉.
4. **리셋 경계 통과**: 5시간 윈도우 리셋 → `claudeTokenUsageStore.reset()`
   + `setSessionStatus('active')` + `flushQueuedTaskBoundaries()` 순으로 호출.
5. **Git 자동화 재조회**: GET 다시 호출. 기대:
   - `branchMode === 'continue'` 유지(시나리오 1·2 와 무관).
   - `branchModeNewName === 'feature/keep'` 유지.
   - `uiBranchStrategy === 'per-task'` 유지.
   - `flowLevel === 'commitPush'` 유지.
6. **패널 리하이드레이션**: `GitAutomationPanel` 의 `baseline` 변경
   `useEffect`(`GitAutomationPanel.tsx:467-472`) 가 로컬 라디오 상태를 새로
   반영. dirty 플래그는 false 로 복귀.

### 연관 회귀(이미 잠금됨)

- `tests/branchModeSketch.regression.test.ts` M1–M7 이 2모드 시안(A안) 의 저장·로드
  왕복을 이미 잠그고 있다. 본 시나리오는 그 왕복이 **세션 리셋 사이클을 관통해서도**
  깨지지 않음을 추가로 보증한다.
- `tests/branchStrategySaveLoad.regression.test.ts` S1–S6 + 로컬 보강 4건은 4전략
  축의 저장·로드 왕복 무손실을 잠금.

### 자동화 가능 범위

- 시나리오의 핵심 계약(저장값이 리셋 이벤트에 의해 오염되지 않음) 은 현재
  코드에서 자명하다(세션 관련 경로는 저장 DB 를 건드리지 않음). 그래도
  "세션 리셋 중 Git 자동화 저장 API 에 Writing 을 보내도 409/롤백 없이 성공"
  을 잠그는 회귀는 코드 초안 §5 에 추가. PATCH 를 모킹해 저장→리셋→재조회
  3 단계를 합성.

### 수동 확인 필요

- 실제 Mongo 인스턴스와 함께 실행. 5시간 대기 없이 `SUBSCRIPTION_SESSION_WINDOW_MS`
  를 테스트 전용 짧은 값(예: 5초) 로 오버라이드해 시간 이동 시뮬레이션 가능.

---

## 제안(디자이너·프론트엔드 합동 검토)

1. 🟠 **"잔량 ≤ 5%" 시각 단계 분리**: `severityFromRatio` 에 `0.95` 임계
   추가 또는 툴팁에 잔량 퍼센트 굵은 글씨 고정. 현재는 80% 와 99% 가 같은
   빨간색이라 "진짜 임박" 이 묻힌다. (시나리오 1 §UX 관찰)
2. 🔴 **리셋 이벤트 핸들러 결합**: `App.tsx` 의 `claude-usage:reset` 수신부
   가 `hydrate` 만 부르고 있어 `sessionStatus` 가 되돌아오지 않는다. UI
   스모크 §2.1 과 합쳐 한 줄 수정(`setSessionStatus('active')` 병행 호출)로
   시나리오 3·5 의 자동 재개가 살아난다.
3. 🔴 **수동 갱신 버튼 신설**: 배지 영역에 "다시 불러오기" 액션을 노출.
   네트워크 복구 경로가 사용자에게 보이지 않는 것이 시나리오 4 의 본질적
   회귀 위험원.
4. 🟡 **큐 카운트 배지**: 소진 상태에서 `getQueuedTaskBoundaryCount()` 를
   상단바 툴팁에 "대기 중인 작업 N건" 으로 노출하면, 리셋 직전 사용자가
   얼마나 기다려야 하는지 투명하게 인지.
5. 🟡 **테스트용 윈도우 오버라이드 문서화**: `SUBSCRIPTION_SESSION_WINDOW_MS`
   를 테스트 경로에서만 짧게 주입할 수 있는 훅(env 혹은 DI) 을 README/QA
   문서에 명시. 현재는 상수라 테스트가 `windowMs` 인자를 매번 넘겨야 한다.

---

## 수동 체크리스트(브라우저 실행 필수)

- [ ] 시나리오 1-5: 실제 브라우저에서 상단바 배지 색상이 녹 → 황 → 적 순서
      로 전환되는 것을 육안 확인. WCAG AA 대비 통과 확인.
- [ ] 시나리오 1: 잔량 5% 이하에서 툴팁이 "거의 소진" 수준의 문구로 전환
      되는지(현재 구현은 "critical" 한 단계만 있어 단계 차이 없음).
- [ ] 시나리오 2: 실제 Claude CLI 가 `token_exhausted` 를 반환하는 환경에서
      서버 로그의 `onTokenExhausted` 구독 경로가 발화하는지.
- [ ] 시나리오 3: 5시간 경계를 수동으로 기다리거나, 서버 `windowMs` 를
      환경변수로 단축한 뒤 상단바가 `ok` 로 돌아오고 큐가 풀리는지.
- [ ] 시나리오 4: DevTools Network 탭에서 `/api/claude/token-usage` 를 차단하고
      배지가 폴백 모드로 전환되는지.
- [ ] 시나리오 5: `branchMode='continue'` 저장 후 탭을 오래 열어 두어
      리셋을 지나게 한 뒤 새로고침해도 라디오가 그대로 `continue` 인지.
- [ ] 접근성: 폴백 배지·수동 갱신 버튼에 `aria-live="polite"` 와 포커스
      링이 적용되는지.
- [ ] 키보드 탐색: Tab 순서로 상단바 배지 → 툴팁 → (개선 후) 수동 갱신
      버튼이 도달 가능한지.

---

## 참조

- 사전 QA 보고서: `tests/qa/ui-smoke-report.md` (UI 스모크 감사, 차단 3건·중대 4건).
- 연관 회귀 테스트: `tests/branchModeSketch.regression.test.ts`,
  `tests/branchStrategySaveLoad.regression.test.ts`,
  `tests/agentWorkerTaskBoundary.regression.test.ts`.
- 테스트 코드 초안: `tests/e2e/session-reset.spec.ts`.
