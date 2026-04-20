# 에이전트 추천 UI(NewProjectWizard.tsx) 수용 기준 초안 — 2026-04-20

지시 #773b1718 (QA) 에 따라 Joker 가 배선 예정인 NewProjectWizard 의 에이전트
추천 단계(이하 "추천 스텝") 를 대상으로 **회귀에 바로 꽂을 수 있는** 수용 기준을
정의한다. 각 항목은 `tests/project/` 하위의 `.spec.ts` 또는 `.regression.test.tsx`
로 구현 대상이며, 네이밍은 `recommend.<주제>.spec.ts` 규약을 제안한다.

---

## 배경
- 진입점: "새 프로젝트" 플로우의 세 번째 스텝. 프로젝트 이름·공동 목표 입력 후
  `렌더된` 추천 결과 카드에서 팀원을 체크 선택한다.
- 데이터 경로: `recommendAgents({ goalText, catalog })` 는 카탈로그(에이전트 후보
  풀) 에서 최대 5명을 score 내림차순으로 돌려준다. UI 는 상위 3명을 자동 체크.
- 토큰 예산: 동일 `(goalText, catalogHash)` 는 5분 캐시(토큰 절약 AC-3.4 재사용).

---

## AC-R.1 기본 렌더
- Given 공동 목표에 "간단한 블로그 CMS 를 만들자" 가 입력되었을 때
- When NewProjectWizard 의 추천 스텝으로 진입하면
- Then 추천 카드가 3개 이상 렌더되며, 각 카드는 다음 요소를 포함한다.
  - 이름(한글) · 역할 배지(Leader/Developer/QA/Designer/Researcher)
  - score 0~1(소수점 둘째 자리까지) · reason 1~2문장
  - 체크박스(상위 3명은 기본 체크)
- **검증**: `recommend.renderBasic.spec.tsx`

## AC-R.2 빈 카탈로그 · 로딩 · 실패
- 카탈로그가 비었을 때: 빈 상태 메시지 `project.recommend.empty` 를 i18n 으로 표시.
- 로딩 500ms 이상 지연 시 스켈레톤 3장 + `common.loading`.
- `recommendAgents` 가 throw 하면 인라인 에러 배너(`project.recommend.error`).
  - 에러 배너에는 재시도 버튼(`common.retry`) 포함.
- **검증**: `recommend.loadingAndError.spec.tsx`

## AC-R.3 선택 상태 · 제출
- 체크 해제 → 하단 "계속" 버튼의 선택 수 배지가 실시간 갱신.
- 0명 선택 시 "계속" 버튼 비활성화(aria-disabled=true).
- 제출 페이로드는 `{ agentIds: string[], recommendationSnapshot: {...} }` 로, 서버가
  후속 분석을 위해 추천 스냅샷을 보존한다.
- **검증**: `recommend.selection.spec.tsx`

## AC-R.4 i18n · 언어 전환
- 언어 ko→en 전환 즉시 카드 내부 reason 문장은 **유지**(모델 응답이 ko 이면 ko
  그대로), 주변 UI 라벨(역할 배지·버튼) 은 500ms 이내 교체.
- reason 이 비어있을 때 `project.recommend.reasonPlaceholder` 로 폴백.
- **검증**: `recommend.i18nSwitch.spec.tsx`

## AC-R.5 캐시 히트(토큰 절약)
- 같은 목표·카탈로그로 재진입 시 `recommendAgents` 호출 횟수는 **1회로 제한**.
- 측정: 호출 모킹으로 `callCount === 1` 확인.
- 5분 경과 후에는 캐시 무효 → 1회 더 호출.
- **검증**: `recommend.cache.spec.ts` — tests/token-budget/redundantRequest.spec.ts
  의 `detectRedundantCalls` 판정식을 재사용.

## AC-R.6 접근성
- 카드 리스트는 `role="listbox"` + 각 카드 `role="option"`.
- 키보드 ↑/↓ 이동, Space 로 토글, Home/End 로 양끝 이동.
- 포커스 링은 디자인 토큰 `--focus-ring-accent` 를 사용해 2px 외곽선.
- **검증**: `recommend.a11y.regression.test.tsx`

## AC-R.7 분석 · 텔레메트리
- 스텝 진입 시 `analytics.track('project.recommend.shown', { count })` 1회 발송.
- 추천 수락 시 `project.recommend.accepted` 와 **선택 비율**(selected/total).
- 거절/이탈 시 `project.recommend.dismissed`.
- **검증**: `recommend.analytics.spec.ts`

---

## 공통 기준
- 테스트는 `node:test` + `tsx` 로 실행 가능해야 하며, jsdom 필요 시
  `tests/helpers/` 의 공용 셋업을 재사용한다.
- 실패 재현은 한국어 `[원인]` 라인을 포함해 로그에 남긴다.
- 신규 i18n 키(아래) 는 merge 전 en.json / ko.json 양쪽에 동시 추가.
  - `project.recommend.empty`
  - `project.recommend.error`
  - `project.recommend.reasonPlaceholder`
  - `project.recommend.acceptLabel`
  - `project.recommend.skipLabel`
- 추천 결과 카드 상한은 5장. 초과 시 UI 는 잘라내고 "전체 보기" 버튼 제공.

## 후속 연결
- AC-R.5 의 캐시 키는 `sha1(goalText) + catalogHash` 로 `mcp` 설정 변경 시
  무효화되지 않아야 한다(전송 방식은 추천 결과에 영향 없음).
- NewProjectWizard 가 도입되면 tests/project/ 하위에 본 문서의 ID(AC-R.x) 를 스펙
  주석에 명시해 역추적 가능하게 만든다.
