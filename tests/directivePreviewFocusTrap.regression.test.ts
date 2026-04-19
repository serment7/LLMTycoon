// Run with: npx tsx --test tests/directivePreviewFocusTrap.regression.test.ts
//
// 회귀 테스트: DirectivePrompt 의 AttachmentPreviewModal 이 공용
// `src/utils/focusTrap.ts` 를 사용해 Tab 순환·포커스 복원을 구현하는지 잠근다.
//
// 배경
// ─────────────────────────────────────────────────────────────────────────────
// 이전 구현은 Escape 만 처리하고 Tab 키에서는 포커스가 모달 바깥으로 빠져
// 배경 요소(지시 프롬프트·첨부 리스트 등) 로 들어갈 수 있었다. 이 상태로는
// `role="dialog" aria-modal="true"` 계약이 무너지고, 스크린리더·키보드 사용자가
// 모달 밖의 상호작용을 실수로 건드릴 수 있다. 본 테스트는 다음 5가지를 잠근다:
//
//   1. `../utils/focusTrap` 에서 `TABBABLE_SELECTORS`, `computeNextFocusIndex`,
//      `toQuerySelector` 3종을 import 한다.
//   2. AttachmentPreviewModal 의 onKey 핸들러가 'Tab' 키를 가로채 처리한다.
//   3. Shift 여부에 따라 `forward` / `backward` 두 방향으로 `computeNextFocusIndex`
//      를 호출한다.
//   4. 내부 카드 요소에 `data-testid="directive-preview-modal-card"` 와 `ref` 가
//      연결되어 JSDOM 도입 후에도 포커스 대상 컨테이너를 안정적으로 찾을 수 있다.
//   5. 모달이 언마운트될 때 `lastFocusRef` 를 이용해 이전 포커스 요소로 복원하는
//      useEffect 가 존재한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = resolve(__dirname, '..', 'src', 'components', 'DirectivePrompt.tsx');

test('AttachmentPreviewModal 은 공용 focusTrap 유틸 3종을 import 한다', () => {
  const src = readFileSync(SRC_PATH, 'utf8');
  assert.match(
    src,
    /import\s*\{[^}]*\bTABBABLE_SELECTORS\b[^}]*\bcomputeNextFocusIndex\b[^}]*\btoQuerySelector\b[^}]*\}\s*from\s*['"]\.\.\/utils\/focusTrap['"]/s,
    'focusTrap 유틸 3종(TABBABLE_SELECTORS, computeNextFocusIndex, toQuerySelector) 을 같은 import 선언에서 가져와야 한다',
  );
});

test('onKey 핸들러가 Tab 키를 가로채 computeNextFocusIndex 를 호출한다', () => {
  const src = readFileSync(SRC_PATH, 'utf8');
  assert.match(
    src,
    /e\.key\s*!==\s*'Tab'/,
    'Tab 이 아닐 때만 조기 return 하는 가드가 있어야 한다',
  );
  assert.match(
    src,
    /computeNextFocusIndex\(/,
    'computeNextFocusIndex 가 실제 호출되어야 한다',
  );
});

test('Shift 여부로 forward / backward 방향이 선택된다', () => {
  const src = readFileSync(SRC_PATH, 'utf8');
  assert.match(
    src,
    /e\.shiftKey\s*\?\s*'backward'\s*:\s*'forward'/,
    "e.shiftKey 삼항으로 'backward' / 'forward' 가 분기되어야 한다",
  );
});

test('내부 카드에 cardRef 와 data-testid 가 연결된다', () => {
  const src = readFileSync(SRC_PATH, 'utf8');
  assert.match(
    src,
    /data-testid="directive-preview-modal-card"/,
    'data-testid="directive-preview-modal-card" 가 카드 엘리먼트에 있어야 한다',
  );
  assert.match(
    src,
    /ref=\{cardRef\}/,
    '카드 엘리먼트에 ref={cardRef} 가 연결되어야 한다',
  );
});

test('언마운트 경로에서 lastFocusRef 를 이용해 포커스 복원 effect 가 존재한다', () => {
  const src = readFileSync(SRC_PATH, 'utf8');
  assert.match(
    src,
    /lastFocusRef\.current\?\.?\s*(?:\.focus\(\)|focus\(\))|lastFocusRef\.current\.focus\(\)/,
    'lastFocusRef.current.focus() 호출로 포커스 복원이 구현되어야 한다',
  );
});
