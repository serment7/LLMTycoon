# 프로젝트 설정 패널: 저장값이 새로고침 뒤 초기화되는 회귀 (2026-04-19)

## 요약

`ProjectManagement.tsx` 의 Git 자동화 설정 패널(`GitAutomationPanel`)이 저장
직후에는 새 값을 그대로 화면에 유지하지만, 페이지 새로고침 또는 탭 재진입 후
패널이 다시 마운트될 때 **사용자가 저장한 값 대신 `DEFAULT_AUTOMATION` 이 잠깐
혹은 지속적으로 노출**되는 회귀가 있었다.

## 재현 절차

1. 임의의 관리 프로젝트를 선택한다.
2. Git 자동화 설정 패널에서 `enabled` 토글을 ON, `flow` 를 `full-pr`, `branchPattern`
   을 `hotfix/{branch}` 로 바꾸고 저장한다. → `/api/projects/:id/git-automation`
   POST 가 200 을 반환하는지 네트워크 탭에서 확인.
3. 브라우저를 새로고침(F5) 한다.
4. 같은 프로젝트를 다시 선택한다.

**기대:** 저장한 값(`full-pr`, `hotfix/{branch}`, enabled=true) 그대로 바인딩.

**실제(수정 전):** `commit`, `auto/{date}-{shortId}`, enabled=false (= DEFAULT_AUTOMATION)
로 보인다. 몇 백 ms 후 `initial` prop 이 서버 저장본으로 바뀌지만 UI 는 갱신되지
않는다.

## 원인

`GitAutomationPanel` 은 `initial` prop 을 `useMemo` → `useState(baseline.flow)`
형태로 소비한다(`src/components/GitAutomationPanel.tsx:387~394`). React 의
`useState` 는 **최초 마운트 시점의 인자만** 초기값으로 채택하기 때문에, 부모의
`initial` prop 이 나중에 교체돼도 내부 로컬 상태는 갱신되지 않는다.

부모 `ProjectManagement.tsx` 의 로드 흐름은 아래와 같이 두 단계다.

1. `useMemo` 로 `gitAutomationSettings = gitAutomationByProject[id] ?? DEFAULT_AUTOMATION`
   을 만들고 패널을 즉시 렌더한다. 이 시점에 `gitAutomationByProject[id]` 는 아직
   비어 있으므로 `initial === DEFAULT_AUTOMATION`.
2. `useEffect(() => loadGitAutomationSettings(id).then(…))` 가 비동기로 서버값을
   가져와 state 를 채운다. `initial` prop 은 교체되지만, 1) 단계에서 이미
   useState 가 DEFAULT 로 잠겨 있다.

사용자 입장에서는 "저장은 되지만 새로고침하면 DEFAULT 로 되돌아가는" 것처럼
보이고, 실제로 DB 에는 저장된 값이 남아 있는 상태가 된다.

## 수정

`ProjectManagement.tsx:1277~1314` 에서 다음 두 가지를 동시에 적용했다.

1. **하이드레이션 게이트.** `gitAutomationByProject[selectedProjectId] === undefined`
   동안에는 패널을 마운트하지 않고 "Git 자동화 설정을 불러오는 중…" 스켈레톤을
   보여 준다. 서버 응답이 state 에 반영된 뒤에야 `<GitAutomationPanel>` 이 처음
   마운트되므로 `useState(baseline.flow)` 가 항상 저장값으로 초기화된다.
2. **`key={selectedProjectId}` 부여.** 프로젝트 간 전환 시 이전 프로젝트의 내부
   상태가 남아 있는 것을 방지하기 위해 프로젝트 ID 를 key 로 준다. 새 프로젝트
   슬롯의 저장값이 도착한 뒤 재마운트되며 fresh 로 초기화된다.

## 회귀 확인 체크리스트

- [ ] 저장 → 새로고침 시 저장값이 그대로 보인다.
- [ ] 프로젝트 A → B 로 전환할 때 B 의 저장값이 도착하기 전에는 스켈레톤이
      보이고, 이후 B 저장값으로 바인딩된다.
- [ ] `useState` 로 초기화된 필드(`flow`, `branchPattern`, `commitTemplate`,
      `prTitleTemplate`, `enabled`, `branchStrategy`, `newBranchName`)가 모두
      서버 저장본과 일치한다.
- [ ] 스켈레톤이 마운트된 상태에서 저장 버튼을 누를 수 있는 경로가 없음(패널
      자체가 없으므로 불가)을 확인한다.
