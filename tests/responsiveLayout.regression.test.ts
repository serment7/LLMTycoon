// Run with: npx tsx --test tests/responsiveLayout.regression.test.ts
//
// 회귀 테스트: 반응형 레이아웃 안전망 (지시 #f4929720, 2026-04-19).
//
// 이번 턴의 명백한 수정은 두 방향이다:
//   1) SharedGoalModal FOOTER 를 flex-wrap 으로 바꿔 414/768px 좁은 뷰포트에서
//      도움말 문구와 취소/확정 버튼이 겹치지 않고 두 줄로 자연스럽게 쌓이게 한다.
//   2) src/index.css 에 @media (max-width: 414px) / (415~768px) 두 안전망 규칙을
//      추가해 (a) SharedGoalModal backdrop padding 축소, (b) ClaudeTokenUsage 배지
//      (role="button"+aria-haspopup="dialog"+aria-expanded 조합) 의 폭 제한을 건다.
//
// 본 파일이 잠그는 계약 4가지:
//   1. SharedGoalModal FOOTER 컨테이너에 `flex-wrap` 이 적용돼 있다.
//   2. SharedGoalModal FOOTER 의 도움말 p 가 `basis-full sm:basis-auto` 로 좁은
//      뷰포트에서 한 줄을 통째로 차지한다.
//   3. src/index.css 에 `@media (max-width: 414px)` 블록과 shared-goal-modal-backdrop
//      패딩 축소 규칙이 존재한다.
//   4. 같은 파일에 role="button"+aria-haspopup="dialog"+aria-expanded 기반 배지
//      max-width 규칙이 존재한다(Thanos 의 ClaudeTokenUsage 파일을 건드리지 않는
//      우회 경로가 실제로 꽂혀 있는지 확인).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODAL_PATH = resolve(__dirname, '..', 'src', 'components', 'SharedGoalModal.tsx');
const INDEX_CSS_PATH = resolve(__dirname, '..', 'src', 'index.css');

test('SharedGoalModal FOOTER 는 flex-wrap 으로 좁은 뷰포트에서 두 줄 쌓임을 허용한다', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  const idx = src.indexOf('data-testid="shared-goal-modal-footer"');
  assert.ok(idx > -1, '반응형 계약을 걸 수 있도록 FOOTER 에 testId 가 필요하다');
  const snippet = src.slice(Math.max(0, idx - 160), Math.min(src.length, idx + 200));
  assert.match(snippet, /flex-wrap/, 'FOOTER 는 flex-wrap 이어야 한다');
  assert.match(snippet, /justify-end\s+sm:justify-between/,
    '좁은 뷰포트에서 우측 정렬 · sm 이상에서 좌우 분산되어야 한다');
});

test('FOOTER 도움말 p 는 basis-full + sm:basis-auto 로 모바일에서 한 줄 전유', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  assert.match(src, /basis-full\s+sm:basis-auto/,
    '도움말 p 는 `basis-full sm:basis-auto` 로 좁은 폭에서 한 줄을 차지해야 한다');
});

test('index.css 에 @media (max-width: 414px) 반응형 안전망 블록이 있다', () => {
  const src = readFileSync(INDEX_CSS_PATH, 'utf8');
  assert.match(src, /@media\s*\(max-width:\s*414px\)/,
    '414px 브레이크포인트 안전망 미디어 쿼리가 필요하다');
  const blockMatch = src.match(/@media\s*\(max-width:\s*414px\)\s*\{[\s\S]*?\n\}/);
  assert.ok(blockMatch, '414px 블록 본문을 찾지 못했다');
  const block = blockMatch[0];
  assert.match(block, /\[data-testid="shared-goal-modal-backdrop"\]\s*\{[^}]*padding:\s*8px/,
    'backdrop 패딩 축소 규칙(8px)이 필요하다');
  assert.match(block, /\[role="button"\]\[aria-haspopup="dialog"\]\[aria-expanded\]/,
    'ClaudeTokenUsage 배지 타겟팅 셀렉터(role+aria-haspopup+aria-expanded)가 필요하다');
  assert.match(block, /max-width:\s*200px/,
    '414px 이하에서 배지 max-width 200px 축약이 필요하다');
});

test('index.css 에 (415~768px) 중간 브레이크포인트 규칙이 있다', () => {
  const src = readFileSync(INDEX_CSS_PATH, 'utf8');
  assert.match(
    src,
    /@media\s*\(min-width:\s*415px\)\s*and\s*\(max-width:\s*768px\)/,
    '415~768px 중간 브레이크포인트 미디어 쿼리가 필요하다',
  );
});
