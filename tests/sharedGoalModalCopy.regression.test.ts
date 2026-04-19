// Run with: npx tsx --test tests/sharedGoalModalCopy.regression.test.ts
//
// QA: SharedGoalModal 의 시안 §2A.1(플레이스홀더/힌트 카피) · §2A.3(aria-describedby
// 접근성 연결) · §2B.3(📝 empty-create 빈 상태 배너) · §2B.1(BODY min-height)
// 설계 계약을 소스 수준에서 잠근다.
//
// 배경
// ─────────────────────────────────────────────────────────────────────────────
// tests/shared-goal-modal-mockup.md 의 §2A 는 필드별 카피(레이블·플레이스홀더·
// 보조 힌트) 를 토큰 수준으로 분리하라고 못박는다. 과거 회귀(=플레이스홀더를
// 실제 값으로 오해) 와 후속 회귀(="폼이 안 보인다") 를 카피 수준에서 차단하는
// 장치이므로, 구현이 시안과 어긋나면 사용자 피드백보다 본 테스트가 먼저 터져야
// 한다. 본 파일은 기존 sharedGoalModalAtomic.regression.test.ts (원자성 계약)
// 의 상보 테스트로 동작한다 — 원자성은 네트워크, 본 파일은 카피/접근성/상태.
//
// 잠그는 항목
//   1. 플레이스홀더 카피 규약: "예:" 접두사 (과거 "예)" 였던 부분 교정)
//      - 목표 제목   →  "예: 결제 모듈 보안 강화"
//      - 상세 설명   →  "예: 토큰 검증·AES 암호화·PCI 감사로그 추가. 범위·완료 기준을 적어주세요."
//   2. 보조 힌트가 영속 텍스트로 폼 안에 존재한다 (placeholder 가 사라진 뒤에도 보여야 함).
//   3. `aria-describedby` 로 힌트 id 가 input/textarea 와 연결된다 (§2A.3 접근성).
//   4. `empty-create` 빈 상태 배너가 `role="status"` + `aria-live="polite"` 로 렌더된다.
//   5. BODY min-height 가 `--shared-goal-modal-body-min-height` 토큰으로 고정된다
//      (§2B.1 layout shift 0 계약).
//   6. `--shared-goal-modal-placeholder-fg` 토큰이 실제로 placeholder 에 적용되는 CSS
//      규칙이 src/index.css 에 존재한다 (토큰이 "선언만 있고 미사용" 되는 회귀 방지).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// 2026-04-19: §2A.1 카피가 `src/i18n/sharedGoalModal.ko.ts` 로 외재화된 이후,
// 리터럴 문자열 존재 검사는 i18n 모듈에 대해 수행한다. JSX 쪽은 COPY.* 참조
// 형태만 유효하면 된다. 두 검사가 합쳐져 "카피가 실제 렌더 경로로 도달하는가"
// 를 잠근다.
import { sharedGoalModalKo as COPY } from '../src/i18n/sharedGoalModal.ko';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODAL_PATH = resolve(__dirname, '..', 'src', 'components', 'SharedGoalModal.tsx');
const CSS_PATH = resolve(__dirname, '..', 'src', 'index.css');

test('§2A.1 — 목표 제목 placeholder 는 "예:" 접두사 규약을 따른다', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  // 과거 "예)" 괄호 표기가 사용자 혼동을 일으킨 사례가 있어 시안이 ":" 으로 고정.
  assert.equal(COPY.title.placeholder, '예: 결제 모듈 보안 강화',
    '목표 제목 placeholder 는 `예: 결제 모듈 보안 강화` 여야 한다 (§2A.1 카피 고정)');
  assert.match(src, /placeholder=\{\s*COPY\.title\.placeholder\s*\}/,
    'JSX 쪽은 `placeholder={COPY.title.placeholder}` 로 i18n 참조되어야 한다');
});

test('§2A.1 — 상세 설명 placeholder 는 시안의 정규 카피를 따른다', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  assert.ok(COPY.description.placeholder.startsWith('예: 토큰 검증·AES 암호화·PCI 감사로그 추가.'),
    '상세 설명 placeholder 는 `예: 토큰 검증·AES 암호화·PCI 감사로그 추가. …` 로 시작해야 한다');
  assert.ok(COPY.description.placeholder.endsWith('범위·완료 기준을 적어주세요.'),
    '상세 설명 placeholder 끝은 `범위·완료 기준을 적어주세요.` 로 마무리되어야 한다');
  assert.match(src, /placeholder=\{\s*COPY\.description\.placeholder\s*\}/,
    'JSX 쪽은 `placeholder={COPY.description.placeholder}` 로 i18n 참조되어야 한다');
});

test('§2A.1 보조 힌트 — 제목·설명 힌트가 영속 텍스트로 폼에 존재한다', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  assert.equal(COPY.title.hint, '리더가 동료들에게 1문장으로 분배할 핵심 제목',
    '제목 힌트 카피가 i18n 에 고정되어 있어야 한다');
  assert.equal(COPY.description.hint(20, 500), "20–500자. 범위와 '완료 판단 기준' 을 함께 써주세요.",
    "상세 설명 힌트 포매터는 `범위와 '완료 판단 기준' 을 함께 써주세요` 를 포함해야 한다");
  assert.match(src, /\{\s*COPY\.title\.hint\s*\}/,
    'JSX 에 제목 힌트가 {COPY.title.hint} 로 렌더되어야 한다');
  assert.match(src, /\{\s*COPY\.description\.hint\([^)]*\)\s*\}/,
    'JSX 에 설명 힌트가 {COPY.description.hint(min, max)} 로 렌더되어야 한다');
});

test('§2A.3 접근성 — 힌트가 aria-describedby 로 input/textarea 와 연결된다', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  // 힌트 요소 자체에 testid 가 붙어 있는지 확인 (id 는 useId 로 생성되어 고정 매칭 어려움)
  assert.match(src, /data-testid="shared-goal-modal-title-hint"/,
    '제목 힌트에 data-testid="shared-goal-modal-title-hint" 가 있어야 한다');
  assert.match(src, /data-testid="shared-goal-modal-desc-hint"/,
    '설명 힌트에 data-testid="shared-goal-modal-desc-hint" 가 있어야 한다');
  // aria-describedby 가 테스트용 동일 id 패턴으로 두 필드에 걸려 있는지 확인
  assert.match(src, /aria-describedby=\{`\$\{dialogId\}-title-hint`\}/,
    '제목 input 에 aria-describedby={`${dialogId}-title-hint`} 가 걸려야 한다');
  assert.match(src, /aria-describedby=\{`\$\{dialogId\}-desc-hint`\}/,
    '설명 textarea 에 aria-describedby={`${dialogId}-desc-hint`} 가 걸려야 한다');
});

test('§2B.3 empty-create — 📝 빈 상태 배너가 role="status" + aria-live="polite" 로 렌더된다', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  assert.match(src, /data-testid="shared-goal-modal-empty-banner"/,
    'empty-create 배너 testid 가 있어야 한다');
  // 렌더 가드(emptyCreate && ...) 로 dirty=false 일 때만 보이게 한다
  assert.match(src, /\{\s*emptyCreate\s*&&\s*\(/,
    '배너 렌더는 emptyCreate 가드를 거쳐야 한다 (첫 입력 시 자연 소멸 계약)');
  assert.match(src, /role="status"/,
    '배너는 role="status" 로 스크린리더에 상태로 낭독되어야 한다');
  assert.match(src, /aria-live="polite"/,
    '배너는 aria-live="polite" 로 비방해형 낭독이어야 한다');
  // 카피는 i18n 모듈로 외재화됨 — 리터럴은 그곳에서 확인하고, JSX 는 참조만 검사.
  assert.equal(COPY.banner.title, '아직 공동 목표가 없습니다',
    '배너 타이틀 카피가 시안과 일치해야 한다');
  assert.equal(COPY.banner.body, '아래 4개 항목을 채우면 저장 + 자동 개발 시작 준비가 완료됩니다.',
    '배너 본문 카피가 시안과 일치해야 한다');
  assert.match(src, /\{\s*COPY\.banner\.title\s*\}/,
    '배너 타이틀은 {COPY.banner.title} 로 렌더되어야 한다');
  assert.match(src, /\{\s*COPY\.banner\.body\s*\}/,
    '배너 본문은 {COPY.banner.body} 로 렌더되어야 한다');
});

test('§2B.1 layout shift 0 — BODY 는 --shared-goal-modal-body-min-height 토큰을 사용한다', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  assert.match(src, /minHeight:\s*'var\(--shared-goal-modal-body-min-height\)'/,
    "BODY form 의 minHeight 는 `var(--shared-goal-modal-body-min-height)` 토큰으로 고정되어야 한다 " +
    '(empty-create ↔ editing 전이 시 layout shift 0 계약)');
});

test('§2B.3 배너 높이 — --shared-goal-modal-banner-height 토큰이 배너에 적용된다', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  assert.match(src, /height:\s*'var\(--shared-goal-modal-banner-height\)'/,
    '배너 height 는 --shared-goal-modal-banner-height 로 고정(72px)되어야 한다');
});

test('토큰 사용 — --shared-goal-modal-placeholder-fg 를 실제 ::placeholder 에 적용하는 CSS 규칙이 존재한다', () => {
  const css = readFileSync(CSS_PATH, 'utf8');
  // 토큰이 선언만 있고 소비되지 않는 "죽은 토큰" 회귀를 방지.
  assert.match(css,
    /\[data-testid="shared-goal-modal-title"\]::placeholder[\s\S]{0,200}var\(--shared-goal-modal-placeholder-fg\)/,
    '목표 제목 input 의 ::placeholder 에 --shared-goal-modal-placeholder-fg 가 적용되어야 한다');
  assert.match(css,
    /\[data-testid="shared-goal-modal-description"\]::placeholder[\s\S]{0,200}var\(--shared-goal-modal-placeholder-fg\)/,
    '상세 설명 textarea 의 ::placeholder 에 --shared-goal-modal-placeholder-fg 가 적용되어야 한다');
});
