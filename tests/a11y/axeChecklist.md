# axe-core 점검 체크리스트 — 언어 토글 · 추천 카드 리스트

작성: 2026-04-21 · 지시 #d345a120 (QA 사전 설계).

본 문서는 axe-core devDependency 도입 이후 `tests/a11y/` 에 활성 스펙으로
옮길 **기계적 점검 항목** 을 선정리한다. 지금은 체크리스트로 유지하고, axe 가
설치되면 각 항목을 `axeCore.run(node, { rules: {...} })` 호출로 감싸 실패 0건
임을 `node:test` 로 잠근다.

## 실행 계획(활성화 시)
- devDependency: `axe-core@^4.10` + jsdom 현재 버전.
- 런타임: `tests/a11y/axeLanguageToggle.spec.ts` · `tests/a11y/axeRecommendCards.spec.ts`
  두 파일로 분할 구현. 각 파일은 컴포넌트를 jsdom 에 마운트한 뒤 axe.run 을
  호출한다.
- 임계: WCAG 2.1 AA 위반 0건 · BestPractices 는 리포트만.

---

## 1. 언어 토글 (OnboardingTour locale 스텝)

DOM 타겟: `.onboarding-locale-picker` 및 그 하위.

### 1.1 룰별 기대
- `button-name` — 각 토글 버튼은 접근 가능한 이름(텍스트 `English` / `한국어`) 보유.
- `aria-allowed-attr` — `aria-pressed` 는 버튼 역할에서 허용.
- `aria-valid-attr-value` — `aria-pressed={true|false}` 만 사용.
- `nested-interactive` — 버튼 안에 다른 상호작용 요소가 중첩되지 않음.
- `role-img-alt` — 국기 아이콘을 넣을 경우 `aria-hidden` 또는 `alt`.
- `color-contrast` — 활성/비활성 상태 모두 AA 4.5:1 이상.
- `focus-visible` — Tab 으로 이동 시 포커스 링이 보이는지(CSS `:focus-visible`).

### 1.2 상태별 추가 검증
- en 선택 상태: Korean 버튼이 활성화, `aria-pressed="false"`.
- ko 선택 상태: English 버튼이 활성화, `aria-pressed="false"`.
- 전환 직후 role=group 라벨이 변경된 locale 로 즉시 교체(`aria-label={t('locale.label')}`).

### 1.3 수동 확인(axe 범위 밖)
- 키보드 ←/→ 로 라디오처럼 순회(선택 사항 — 현재는 Tab/Space 모델).
- VoiceOver/NVDA 로 "언어, 영어, 눌림 / 한국어" 순 읽기.

---

## 2. 추천 카드 리스트 (NewProjectWizard review 스텝)

DOM 타겟: `ul.npw-cards[role="listbox"]` + 자식 `label.npw-card[role="option"]`.

### 2.1 룰별 기대
- `listbox-name` — listbox 에 접근 가능한 이름(`aria-labelledby=h3#npw-review-title`
  또는 `aria-label`). 현재 `<h3>` 은 형제 — `aria-labelledby` 연결을 도입하는 편이 좋음.
- `aria-required-children` — listbox 안에 option 만 있도록 확인.
- `aria-required-parent` — option 의 부모가 listbox 인지 확인.
- `label` — 카드 내부 체크박스에 라벨이 연결(현 구조: `<label>` 이 체크박스를
  감쌈 → 암묵적 연결 성립).
- `duplicate-id-aria` — 카드별 key 가 중복 id 를 만들지 않는지.
- `button-name` — 선택 일괄 버튼(모두 선택/초기화/모두 추가) 모두 텍스트 보유.
- `color-contrast` — 카드 본문/rationale 4.5:1, 선택 강조 테두리 3:1(non-text).
- `focus-visible` — 카드 포커스 시 2px 링 가시.

### 2.2 상태별 추가 검증
- 0개 선택: "선택한 0명 추가" 버튼 `disabled={true}` + `title` 로 사유 노출.
- 부분 선택: 각 카드 `aria-selected` 값이 체크 상태와 1:1.
- 로딩 상태: `<p role="status" class="npw-loading">` 이 live region 으로 노출.
- 에러 상태: `<p role="alert" class="npw-error">` 이 즉시 읽힘.
- 빈 상태: `.npw-empty` 는 텍스트만(아이콘은 `aria-hidden`).

### 2.3 수동 확인(axe 범위 밖)
- 화면 크기 320px 에서 카드 리스트 세로 정렬 유지.
- 한국어 rationale 이 2줄 이상일 때 말줄임 처리 대신 자연 줄바꿈(가독성).

---

## 3. 공통 룰 세트(axe 설정 템플릿)

```ts
// tests/a11y/axeLanguageToggle.spec.ts 예시(활성화 시)
// import axe from 'axe-core';
// const results = await axe.run(document.body, {
//   runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
//   rules: {
//     'color-contrast': { enabled: true },
//     'button-name': { enabled: true },
//     'label': { enabled: true },
//     'aria-allowed-attr': { enabled: true },
//     'aria-valid-attr-value': { enabled: true },
//     'duplicate-id-aria': { enabled: true },
//     'nested-interactive': { enabled: true },
//   },
// });
// assert.equal(results.violations.length, 0, JSON.stringify(results.violations, null, 2));
```

## 4. 도입 순서 제안
1. `npm i -D axe-core@^4.10`.
2. `tests/a11y/axeLanguageToggle.spec.ts` — 위 1.1~1.2 자동화.
3. `tests/a11y/axeRecommendCards.spec.ts` — 위 2.1~2.2 자동화.
4. 기존 `contrast.spec.ts` 의 C4 자리에 axe 실행 블록을 교체(수동 계산은
   보조로 유지 — jsdom 렌더 실패 시 폴백).
5. CI 파이프라인에 `npx tsx --test tests/a11y/**/*.spec.ts` 를 추가.

## 5. 현재 알려진 pending
- 입력 필드 테두리 `border-white/30` ≈ 2.40:1 — `border-white/50` 이상 상향.
- 추천 리스트의 listbox 에 `aria-labelledby` 가 붙어 있지 않음(형제 h3 존재만).
- locale 토글에 국기 아이콘이 붙으면 `aria-hidden` 또는 `alt` 필수.
