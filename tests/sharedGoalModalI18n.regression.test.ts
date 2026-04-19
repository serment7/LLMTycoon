// Run with: npx tsx --test tests/sharedGoalModalI18n.regression.test.ts
//
// 회귀 테스트: SharedGoalModal 의 "카피 외재화(i18n) + §4.3 단축키 + §9 aria-busy"
// 계약을 잠근다. 기존 sharedGoalModalCopy.regression.test.ts 가 §2A/§2B 카피 · 토큰
// 적용을 JSX 리터럴 수준에서 확인했다면, 본 파일은 **카피가 별도 i18n 모듈로
// 외재화되었는지** 와 §4.3 / §9 a11y 두 가지를 상보적으로 잠근다.
//
// 시안 `tests/shared-goal-modal-mockup.md`
//   §2A.1 4: 카피 전량을 `src/i18n/sharedGoalModal.ko.ts` 키로 분리해 외주 번역이
//            힌트/플레이스홀더를 건드리지 않고도 레이블만 갱신하게 한다.
//   §4.3  : Ctrl/⌘ + Enter 로 primary 를 즉시 트리거.
//   §9    : 확정 버튼의 "저장 중…" 상태는 `aria-busy="true"` + `aria-live="polite"`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { sharedGoalModalKo as COPY } from '../src/i18n/sharedGoalModal.ko';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODAL_PATH = resolve(__dirname, '..', 'src', 'components', 'SharedGoalModal.tsx');
const I18N_PATH = resolve(__dirname, '..', 'src', 'i18n', 'sharedGoalModal.ko.ts');

test('src/i18n/sharedGoalModal.ko.ts 파일이 존재한다', () => {
  assert.ok(existsSync(I18N_PATH), 'i18n 카피 리소스 파일이 있어야 한다');
});

test('시안 §2A.1 4개 필드 카피(레이블/플레이스홀더/힌트)가 i18n 모듈에 고정되어 있다', () => {
  assert.equal(COPY.title.label, '목표 제목');
  assert.equal(COPY.title.placeholder, '예: 결제 모듈 보안 강화');
  assert.equal(COPY.title.hint, '리더가 동료들에게 1문장으로 분배할 핵심 제목');

  assert.equal(COPY.description.label, '상세 설명');
  assert.ok(
    COPY.description.placeholder.startsWith('예:'),
    '플레이스홀더는 "예:" 접두로 시작해 실제 값이 아님을 명시해야 한다',
  );
  assert.equal(
    COPY.description.hint(20, 500),
    "20–500자. 범위와 '완료 판단 기준' 을 함께 써주세요.",
  );

  assert.equal(COPY.priority.label, '우선순위');
  assert.equal(COPY.priority.options.high, 'P1-긴급');
  assert.equal(COPY.priority.options.normal, 'P2-중요');
  assert.equal(COPY.priority.options.low, 'P3-일반');

  assert.equal(COPY.deadline.label, '기한');
});

test('시안 §5 footer 카피와 primary "저장 후 시작" 약속이 고정되어 있다', () => {
  assert.equal(COPY.footer.cancel, '취소');
  assert.equal(
    COPY.footer.confirm,
    '목표 저장 후 시작',
    '시안 §5.3: 단순 "저장" 이 아니라 "시작" 을 약속하는 카피여야 한다',
  );
  assert.equal(COPY.footer.saving, '저장 중…');
  assert.match(
    COPY.footer.hint,
    /자동 개발이 ON/,
    'footer 힌트는 "저장 직후 자동 개발 ON 전환" 약속을 포함해야 한다',
  );
});

test('SharedGoalModal.tsx 는 i18n 리소스를 import 해 소비한다', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  assert.match(
    src,
    /from\s+['"]\.\.\/i18n\/sharedGoalModal\.ko['"]/,
    '`../i18n/sharedGoalModal.ko` 에서 카피를 import 해야 한다',
  );
});

test('SharedGoalModal.tsx 의 footer primary/cancel 카피가 JSX 리터럴로 남아 있지 않다', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  // 과거 회귀 방지: 리터럴을 그대로 남겨두면 i18n 이 반쪽짜리가 된다.
  assert.doesNotMatch(
    src,
    /'목표 저장 후 시작'|"목표 저장 후 시작"/,
    '`목표 저장 후 시작` 이 리터럴로 남아 있다 — i18n 으로 외재화되어야 한다',
  );
  // cancel 버튼 JSX 내부 한글 리터럴 ">취소<" 는 제거되어야 한다.
  assert.doesNotMatch(
    src,
    />\s*취소\s*</,
    'footer cancel 버튼의 `취소` 리터럴이 남아 있다 — i18n 으로 외재화되어야 한다',
  );
});

test('시안 §4.3: Ctrl/⌘ + Enter 단축키 핸들러가 존재한다', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  assert.match(
    src,
    /e\.ctrlKey\s*\|\|\s*e\.metaKey/,
    'Ctrl 또는 Meta 조합 키 검사 구문이 있어야 한다',
  );
  // Enter 키 가드는 `e.key === 'Enter' && (e.ctrl || e.meta)` 형태로
  // handleDialogKeyDown 안에 통합되어야 한다 (Tab 트랩과 한 핸들러에 공존).
  assert.match(
    src,
    /e\.key\s*===\s*'Enter'\s*&&\s*\(\s*e\.ctrlKey\s*\|\|\s*e\.metaKey\s*\)/,
    "`e.key === 'Enter' && (e.ctrlKey || e.metaKey)` 조합 가드가 있어야 한다",
  );
  assert.match(
    src,
    /requestSubmit\(\)/,
    '단축키가 form.requestSubmit() 을 호출해 primary 를 트리거해야 한다',
  );
});

test('시안 §9 a11y: primary 버튼은 saving 시 aria-busy 를 노출한다', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  assert.match(
    src,
    /aria-busy=\{saving[^}]*\}/,
    'primary 버튼에 `aria-busy={saving...}` 속성이 있어야 한다',
  );
});
