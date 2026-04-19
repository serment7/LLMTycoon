// Run with: npx tsx --test tests/collabTimelineAriaLabel.regression.test.ts
//
// 회귀 테스트: CollabTimeline 의 행(`role="button"`) 이 스크린리더에 의미 있는
// `aria-label` 을 노출하는지 잠근다.
//
// 배경
// ─────────────────────────────────────────────────────────────────────────────
// 이전 구현은 행의 상태를 글리프(● ◔ ○ ⊘) 와 색으로만 전달했다. 스크린리더는
// 글리프를 그대로 문자로 읽거나(또는 건너뛰거나) 하여, 색각 이상 + 스크린리더
// 사용자 두 축이 동시에 결합되면 "누가 누구에게, 무엇을, 어떤 상태로 넘긴
// 핸드오프인지" 를 알기 어려웠다. 본 테스트는 다음을 잠근다:
//
//   1. 행 엘리먼트에 `aria-label={ariaLabel}` 속성이 존재한다.
//   2. ariaLabel 구성에 `from → to`, 슬러그(`row.slug`), 상태 레이블(`STATUS_LABEL`)
//      3가지가 반드시 포함된다.
//   3. `statusFallback` / `orphan` 이 있을 때 "알 수 없는 status" / "원본 지시 유실"
//      경고 카피가 aria-label 에 병기된다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = resolve(__dirname, '..', 'src', 'components', 'CollabTimeline.tsx');

test('행 엘리먼트에 aria-label 속성이 연결되어 있다', () => {
  const src = readFileSync(SRC_PATH, 'utf8');
  assert.match(
    src,
    /aria-label=\{ariaLabel\}/,
    '<li role="button"> 에 aria-label={ariaLabel} 이 있어야 한다',
  );
});

test('ariaLabel 구성에 from→to, slug, 상태 레이블이 모두 포함된다', () => {
  const src = readFileSync(SRC_PATH, 'utf8');
  assert.match(
    src,
    /`\$\{row\.from\}\s*→\s*\$\{row\.to\}`/,
    "ariaLabel 구성에 `${row.from} → ${row.to}` 문자열이 포함되어야 한다",
  );
  assert.match(
    src,
    /row\.slug\s*\|\|\s*'제목 없음'/,
    "slug 가 없을 때는 '제목 없음' 폴백 카피를 써야 한다",
  );
  assert.match(
    src,
    /STATUS_LABEL\[row\.status\]/,
    '상태 레이블을 STATUS_LABEL[row.status] 로 주입해야 한다',
  );
});

test('statusFallback / orphan 경고 카피가 aria-label 에 병기된다', () => {
  const src = readFileSync(SRC_PATH, 'utf8');
  assert.match(
    src,
    /row\.statusFallback\s*\?\s*'알 수 없는 status'/,
    'statusFallback 시 aria-label 에 `알 수 없는 status` 가 병기되어야 한다',
  );
  assert.match(
    src,
    /row\.orphan\s*\?\s*'원본 지시 유실'/,
    'orphan 시 aria-label 에 `원본 지시 유실` 이 병기되어야 한다',
  );
});
