# UI 스모크 회귀 보고서

- 작성일: 2026-04-19
- 작성자: QA (`agentId=6940336c-c26d-46cb-9054-f4803030c898`)
- 범위: 정적 코드 감사 기반 전체 UI 동작 점검 — 메인 화면·설정·팀 관리·
  Git 자동화 설정(특히 2모드 시안(A안))·토큰 만료 배너·미디어 입력 파이프라인
- 방법: 브라우저 직접 클릭이 불가한 환경이라, 렌더링 경로·prop 전달·소켓
  이벤트·핸들러 연결을 원본 코드에서 추적해 "사용자가 클릭했을 때 실제로
  어떻게 동작하는가" 를 재구성했다. 각 항목은 재현 가능한 파일:라인 근거를
  포함한다. UI 자체를 띄워 확인할 수 없어 "동작 여부 최종 확인 불가" 인 항목은
  별도 표식(🟡) 으로 남긴다.

## 심각도 등급

- 🔴 **차단(Blocker)** — 사용자가 기능 자체를 쓸 수 없음. 즉시 수정 대상.
- 🟠 **중대(Major)** — 경로는 살아 있으나 중요한 피드백/전환이 누락돼 사용
  경험이 크게 훼손됨.
- 🟡 **경미(Minor)** — UX 저해 또는 접근성 저해. 기능은 동작.

---

## 1. 치명 결함(차단)

### 1.1 🔴 `MediaAttachmentPanel` 이 어떤 부모에서도 인스턴스화되지 않음

- **증상**: PDF/PPT/비디오/이미지 업로드 UI 자체가 화면에 나타나지 않는다.
- **근거**:
  - 정의: `src/components/MediaAttachmentPanel.tsx:44-239` (accept
    `.pdf,.pptx,.ppt,video/*,image/*` 포함, 업로드 입력·리스트·다운로드
    버튼까지 완성돼 있음).
  - 사용처 전수 조회: `src/components/*`, `src/App.tsx`, `src/pages/*` 어디에도
    `import { MediaAttachmentPanel }` 혹은 `<MediaAttachmentPanel` 렌더 호출이
    존재하지 않음. 파일 내부 자기 참조, `src/index.css` 스타일, 서버 쪽
    `src/server/mediaProcessor.ts` 가 전부.
- **재현**: 앱 실행 → 프로젝트 선택 → 미디어 업로드 진입 UI 를 찾으면 존재하지
  않음.
- **영향**: 공동 목표(#f6052a91) 가 요구하는 PDF/PPT/영상 입·출력 파이프라인의
  사용자 진입점이 비어 있어, 백엔드·타입·서버 라우트가 모두 준비돼 있음에도
  사용자가 기능을 전혀 쓸 수 없음.

### 1.2 🔴 `claude-session:status` 소켓 이벤트 수신 핸들러 누락

- **증상**: 서버가 토큰 소진/구독 만료를 방송해도 클라이언트 스토어가
  `sessionStatus` 를 갱신하지 못해 **"토큰 소진 — 읽기 전용" 배너가 뜨지 않고**
  DirectivePrompt/SharedGoalForm 의 제출 버튼이 계속 활성 상태로 남는다.
- **근거**:
  - 스토어 메서드는 존재: `src/utils/claudeTokenUsageStore.ts:677` —
    `// claude-session:status 이벤트 수신 시 호출한다` 주석과 `setSessionStatus`.
  - 타입에도 정의: `src/types.ts:410` `ClaudeSessionStatus` (`active|warning|exhausted`).
  - `src/App.tsx:583-598` 가 등록하는 소켓 이벤트는 `claude-usage:updated` 와
    `claude-usage:reset` 두 개뿐. `claude-session:status` 를 구독하는 `newSocket.on`
    호출 전무.
- **재현**: 서버가 `io.emit('claude-session:status', 'exhausted')` 를 발행 →
  클라이언트 콘솔에는 도달하지만 스토어 미갱신 → ClaudeTokenUsage 상단바의
  소진 배너 렌더 분기(ClaudeTokenUsage.tsx:350 조건) 를 절대 타지 않음.
- **영향**: `#cdaaabf3` 읽기 전용 모드 요구사항이 UI 에 연결돼 있지 않음.

### 1.3 🔴 `App.tsx` → `CollabTimeline` 에 `mediaEvents` prop 전달 누락

- **증상**: 서버 `agentWorker.ts:53,239` 가 `mediaAssetToTimelineEvent` 로 만든
  `MediaTimelineEvent` 를 방출해도, 타임라인이 해당 배열을 받지 못해 **PDF/PPT/
  비디오 생성 이벤트가 협업 타임라인에 한 줄도 찍히지 않는다**.
- **근거**:
  - `src/components/CollabTimeline.tsx:48` — `mediaEvents?: ReadonlyArray<MediaTimelineEvent>` prop 선언·소비 로직 완성.
  - `src/App.tsx:1911-1915` — `<CollabTimeline entries={collabEntries}
    onSelect={…} onHoverAgent={…} />` 만 전달, `mediaEvents` 미포함.
- **재현**: 에이전트가 `/api/media/generate` 경로를 돌려 `MediaAsset` 생성 →
  서버가 소켓으로 push → 클라이언트 타임라인에는 아무것도 표시되지 않음.
- **영향**: 미디어 생성 결과가 UI 어디에도 표시되지 않아 "에이전트가 PDF 를
  만들었습니다" 같은 피드백이 사라짐.

---

## 2. 중대 결함

### 2.1 🟠 토큰 리셋 이벤트 후 `sessionStatus` 가 `'active'` 로 복원되지 않음

- **증상**: 서버가 `claude-usage:reset` 을 방출해도 `claudeTokenUsageStore.hydrate`
  만 호출되고 `sessionStatus` 는 이전 `'exhausted'` 로 남아 배너가 사라지지 않음.
- **근거**:
  - `src/App.tsx:596` — `newSocket.on('claude-usage:reset', (totals) =>
    claudeTokenUsageStore.hydrate(totals))` 만 실행.
  - `src/utils/claudeTokenUsageStore.ts:341-344` — `hydrate` 는 누적을
    0 으로만 리셋하고 `sessionStatus` 필드는 건드리지 않음.
- **재현**: 소진 배너가 떠 있는 상태 → 서버 재기동(reset 발행) → 배너 잔존.
- **영향**: 사용자가 "리셋됐다고 들었는데 UI 는 여전히 막힌 상태" 로 혼란.

### 2.2 🟠 `DirectivePrompt` / `SharedGoalForm` 의 `readOnlyMode` prop 이 App 에서 전달되지 않음

- **증상**: 두 컴포넌트가 `readOnlyMode` prop 을 받아 제출을 잠그는 로직을
  갖추었으나 부모가 내려주지 않아 토큰 소진 시에도 입력/전송이 그대로 가능.
- **근거**:
  - `src/components/DirectivePrompt.tsx:78,84` — prop 문서화·사용.
  - `src/components/SharedGoalForm.tsx:30` — 동일.
  - `src/App.tsx` 에서 두 컴포넌트를 렌더할 때 `readOnlyMode` 를 전달하는 코드
    없음(스토어 구독 → prop 주입 체인이 끊겨 있음).
- **재현**: 소진 상태여도 지시 프롬프트 제출 버튼이 활성 → 제출 → 서버에서
  뒤늦게 400 반환.
- **영향**: 읽기 전용 계약이 UI 에서 느슨해져, 배너(1.2 해결 후) 와 버튼
  상태가 일관되지 않음.

### 2.3 🟠 임계값(caution/warning) 초기값이 비어 있어 배지 단계 전환이 발생하지 않음

- **증상**: 첫 방문 사용자는 `localStorage` 에 임계값이 없어
  `resolveUsageSeverity` 가 항상 `normal` 만 반환. "주의" 단계를 한 번도 못 봄.
- **근거**:
  - `src/components/ClaudeTokenUsage.tsx:94,137` — `EMPTY_THRESHOLDS = {}` 를
    기본값으로 사용.
  - `src/utils/claudeTokenUsageStore.ts:587-596` — 저장된 임계값이 없으면
    비교 대상이 없어 `normal` 반환.
- **재현**: 신규 사용자 → 임계값 미설정 → 토큰을 아무리 써도 배지가 파란색 유지.
- **영향**: 사용자가 임계값의 존재를 알기 전까지 누적 추적이 무감각해짐.
  의도상 "사용자가 설정할 때만 동작" 이면 TokenUsageSettingsPanel 입구가 주도적
  으로 보여야 하는데 그 유도가 약함.

### 2.4 🟠 "PR 대상 선택" 버튼이 연동 0건 상태에서도 활성

- **증상**: 관리 프로젝트(`managed.length === 0`) 일 때 버튼을 누르면 빈
  모달이 뜸.
- **근거**: `src/components/ProjectManagement.tsx:1263-1269` — `<button
  onClick={() => setShowPrTargetSelector(true)}>` 에 `disabled` 무 연결.
- **재현**: 연동 한 건도 없이 "PR 대상 선택" 클릭 → 내용 없는 모달.
- **영향**: 신규 사용자 혼란, UX 저해.

---

## 3. 2모드 시안(A안) UI 동작 — 화이트리스트 체크

| 축 | 라인 | 결과 |
|---|---|---|
| 로컬 상태 `branchModeSketch` / `branchNameSketch` 선언 | `GitAutomationPanel.tsx:439-440` | ✅ |
| `baseline` 변경 시 로컬 상태 리하이드레이션 | `GitAutomationPanel.tsx:467-472` | ✅ |
| dirty 감지에 두 필드 포함 | `GitAutomationPanel.tsx:493-494` | ✅ |
| 초기화(reset) 핸들러가 두 필드를 baseline 으로 복원 | `GitAutomationPanel.tsx:514-515` | ✅ |
| `onSave` 페이로드에 `branchMode` / `branchModeNewName` 포함 | `GitAutomationPanel.tsx:538,541` | ✅ |
| `toServerSettings` 가 `branchModeSketch` / `branchModeNewName` 을 전송 | `ProjectManagement.tsx:157-158` | ✅ |
| `fromServerSettings` 가 서버 row 를 읽고 기본값 폴백 | `ProjectManagement.tsx:195-213` | ✅ |
| 라디오가 현재 모드를 `data-mode` 로 노출 | `GitAutomationPanel.tsx:893` | ✅ |
| 선택된 옵션에 `isActive` 플래그 반영 | `GitAutomationPanel.tsx:907` | ✅ |
| 'new' / 'continue' 모드별 조건부 블록 | `GitAutomationPanel.tsx:953,991` | ✅ |

**결론**: A안의 저장·로드·dirty·초기화 경로는 모두 소스 레벨에서 정상 연결.
이번 감사 범위에서 별도 결함 없음. (회귀 테스트는
`tests/branchStrategySaveLoad.regression.test.ts` 24건, `tests/branchModeSketch.regression.test.ts` 다수가 잠금.)

---

## 4. UX 저해 요소(별도 섹션)

### 4.1 🟡 라디오 그룹에 `name` 속성 미지정

- `src/components/GitAutomationPanel.tsx:908-924` — 브랜치 모드 라디오 그룹이
  `name="branch-mode"` 같은 공통 name 을 갖지 않음. 스크린리더가 그룹 구조를
  인식하지 못함.

### 4.2 🟡 "검색 초기화" 버튼의 피드백이 `title` 속성에 의존

- `src/components/ProjectManagement.tsx:1284-1291` — `aria-label` 과 `title`
  이 중복·일부 불일치. 스크린리더 낭독 텍스트가 일관되지 않음.

### 4.3 🟡 "초기화" 버튼이 `needsNewBranchInput` 미충족 상태에서도 활성

- `src/components/GitAutomationPanel.tsx:1280-1281` — `disabled={!dirty}` 만
  검사. 사용자가 무효 입력 상태에서 "초기화" 를 누르면 잠재적으로 저장 불가
  로 빠지며 단서 없음. "초기화" 의 의도는 되돌리는 것이라 엄밀히는 버그는
  아니나, "저장과 초기화가 모두 막힌 구간" 이 보이면 혼란 유발.

### 4.4 🟡 프로젝트 목록 빈 상태 메시지 부재

- `src/components/ProjectManagement.tsx:1280 이후` — `projects.length === 0`
  이면 검색창과 정렬 드롭다운만 표시되고 "가져온 프로젝트가 없습니다 — 연동을
  먼저 추가하세요" 같은 빈 상태 문구가 없음. EmptyProjectPlaceholder 는 별도
  라 여기서는 참조하지 않음.

### 4.5 🟡 읽기 전용 모드의 사유 라벨 일관성 부족

- `src/components/DirectivePrompt.tsx:221-224` 와
  `src/components/SharedGoalForm.tsx:322-326` — 잠금 사유를 `title` / `aria-label`
  에 부분적으로만 노출. "왜 지금 비활성인지" 를 사용자가 즉시 알기 어려움.

### 4.6 🟡 `mediaAssetToTimelineEvent` 의 `queued-exhausted` 사유 시각화 부재

- `src/types.ts:556-593` 에 `reason: 'generated' | 'queued-exhausted'` 가
  정의되고 서버는 채우지만(`agentWorker.ts:239`), `CollabTimeline.tsx` 가
  이 값을 배지로 렌더하는 코드가 없음 — "세션 소진으로 큐잉된 매체" 구분이
  UI 상 드러나지 않음. (1.3 해결 이후에도 별도 분기 필요.)

---

## 5. 골든 패스 추적 요약

| 경로 | 렌더까지 도달? | 실제 동작? | 비고 |
|---|---|---|---|
| 로그인 → 메인 대시보드 | ✅ | 🟡 | 미확인(브라우저 미실행) — 후속 수동 스모크 필요 |
| 설정 → 프로젝트 관리 → Git 자동화 | ✅ | ✅ | A안 저장·로드 경로는 정상 |
| 설정 → 토큰 사용량 임계값 설정 | ✅ | 🟠 | §2.3 참조, 기본값 공백 |
| 팀 관리 → 에이전트 상태 표시 | 🟡 | 🟡 | AgentStatusPanel 등 별도 감사 범위 밖 |
| 지시 프롬프트 → 첨부 + 전송 | ✅ | 🔴 | MediaAttachmentPanel 미노출(§1.1) |
| 타임라인 → 생성 매체 열람 | ✅ | 🔴 | mediaEvents prop 누락(§1.3) |
| 토큰 소진 → 읽기 전용 전환 | 🟠 | 🔴 | 소켓 핸들 없음(§1.2) + readOnly prop 누락(§2.2) |

---

## 6. 후속 제안(우선순위 순)

1. **🔴 §1.1** — `MediaAttachmentPanel` 을 `DirectivePrompt` 내부 또는
   지시 패널 상단에 렌더하도록 `App.tsx` / `DirectivePrompt.tsx` 에 삽입.
2. **🔴 §1.2** — `App.tsx` 소켓 구독 블록에 `newSocket.on('claude-session:status',
   status => claudeTokenUsageStore.setSessionStatus(status))` 한 줄 추가.
3. **🔴 §1.3** — `App.tsx` 에 `mediaEvents` 상태를 두고 서버 소켓(예:
   `media-timeline:append`) 구독 → `<CollabTimeline mediaEvents={...} />`.
4. **🟠 §2.1** — `hydrate` 대신 `reset` 전용 헬퍼를 두어 `sessionStatus` 를
   `'active'` 로 함께 되돌리거나, 리셋 이벤트 핸들러가 명시적으로 호출.
5. **🟠 §2.2** — `App.tsx` 에서 `useClaudeSessionStatus` 훅을 통해 readOnlyMode
   를 계산 후 두 컴포넌트에 prop 주입.
6. **🟠 §2.3** — 첫 방문 시 "임계값을 설정하세요" 토스트·배지로 유도.
7. **🟠 §2.4** — `disabled={managed.length === 0}` 를 PR 대상 선택 버튼에 추가.
8. **🟡 §4.1–4.6** — 접근성·빈 상태·사유 라벨 일관성 일괄 정리.

## 7. 미확인 항목(후속 수동 확인 필요)

- 위 1.1–1.3 수정 후 실제 파일 업로드·타임라인 반영·배너 전환이 원자적으로
  동작하는지 브라우저에서 재검증.
- 모달 포커스 트랩·키보드 탐색(Tab/Shift+Tab) 순환. 정적 감사로는 확인 불가.
- 다크/라이트 테마 양쪽에서 배너 대비(contrast) 확인.

---

## 8. 회귀 테스트 잠금 레지스트리

> **2026-04-19 후속 재검증(#21931b23)**: 본 §1.1~§2.4 7건 결함은
> `docs/qa-ui-smoke-regression-2026-04-19-followup.md` 2회차 감사 시점에도
> **전부 미수정** 상태. 재검증 스위트 45 pass / 6 skip / 0 fail 로 계약 레지스트리
> 자체는 녹색이나 런타임 결함은 1회차와 동일하게 잔존한다.


본 보고서의 블로커·중대 결함은 `tests/uiSmokeReportBlockerContracts.regression.test.ts`
에 소스 레벨 정규식 계약으로 승격되었다(2026-04-19 추가, 13 테스트 중 7건 통과 / 6건
`test.skip`). 각 `CONTRACT §x.y` 테스트는 **현재 skip 상태**로, 해당 블로커가 수정
되는 즉시 `test.skip` → `test` 로 전환하면 정규식이 App.tsx / ProjectManagement.tsx
를 감사해 "와이어링 완료 여부" 를 자동 잠금한다.

| 보고서 섹션 | 잠금 테스트 | 상태 |
|---|---|---|
| §1.1 MediaAttachmentPanel 미렌더 | `CONTRACT §1.1` | skip(미수정) |
| §1.2 claude-session:status 미구독 | `CONTRACT §1.2` | skip(미수정) |
| §1.3 mediaEvents prop 미전달 | `CONTRACT §1.3` | skip(미수정) |
| §2.1 reset 이벤트에서 sessionStatus 미복원 | `CONTRACT §2.1` | skip(미수정) |
| §2.2 readOnlyMode prop 미전달 | `CONTRACT §2.2` | skip(미수정) |
| §2.4 PR 대상 선택 버튼 disabled 가드 부재 | `CONTRACT §2.4` | skip(미수정) |

BASE 블록(통과 7건) 은 "빌딩블록이 사라지면 수정 자체가 불가능" 인 계약
(예: DirectivePrompt 의 `readOnlyMode` prop 선언, MediaAttachmentPanel 정의) 을
상시 가드한다. 본 보고서의 섹션 번호가 바뀌면 `META` 테스트가 즉시 어긋나 동기화
누락을 잡는다.

---

부록: 본 보고서 작성 시 회귀 테스트 실행 결과 —
`tests/branchStrategySaveLoad.regression.test.ts` 24건, `src/utils/projectOptions.test.ts`
15건, `tests/claudeSubscriptionSession.regression.test.ts` 13건,
`tests/unit/media-loaders.spec.ts` 13건, `tests/uiSmokeReportBlockerContracts.regression.test.ts`
13건(7 pass / 6 skip) 모두 실행 성공(2026-04-19 세션).
