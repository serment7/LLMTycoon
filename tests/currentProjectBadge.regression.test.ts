// Run with: npx tsx --test tests/currentProjectBadge.regression.test.ts
//
// QA 회귀 · CurrentProjectBadge (지시 #846da814).
//
// 정적 계약 3가지를 잠근다:
//   1. 프로젝트 미선택(null/''/공백) 시 placeholder "프로젝트 미선택" 을 표시하고
//      data-has-project="false" 로 외부 관찰자에 명시한다.
//   2. 긴 프로젝트명이 들어와도 상단바 다른 칩을 밀어내지 않도록 max-w + truncate
//      클래스가 유지된다(ux-cleanup-visual §2 B-06 원칙).
//   3. 전체 이름은 aria-label 과 title 양쪽에 그대로 들어가 스크린리더·툴팁으로
//      정확 전달된다(시각 축약 ≠ 정보 손실).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  resolve(__dirname, '..', 'src', 'components', 'CurrentProjectBadge.tsx'),
  'utf8',
);

test('placeholder "프로젝트 미선택" 상수가 export 되어 있다', () => {
  assert.match(SRC, /export const CURRENT_PROJECT_PLACEHOLDER = '프로젝트 미선택'/);
});

test('data-has-project 속성이 hasProject boolean 을 DOM 에 반영한다', () => {
  assert.match(SRC, /data-has-project=\{hasProject \? 'true' : 'false'\}/,
    'data-has-project 속성으로 외부(E2E·감사) 가 boolean 을 읽을 수 있어야 한다');
});

test('긴 이름 축약을 위한 max-w + truncate 클래스가 유지된다', () => {
  // 상단바 다른 칩(토큰 사용량 배지 등) 을 밀어내지 않도록 클래스 제약이 필요.
  assert.match(SRC, /max-w-\[240px\]/, 'max-w-[240px] 상한이 필요하다');
  assert.match(SRC, /truncate/, 'truncate 클래스가 필요하다');
});

test('aria-label 과 title 에 동일한 전체 이름이 들어가 접근성 경로가 정보 손실 없이 유지된다', () => {
  // aria-label 은 스크린리더, title 은 호버 툴팁. 둘 다 `현재 프로젝트: ${display}`
  // 템플릿을 사용해야 진짜 이름을 잃지 않고 전달된다.
  const aria = SRC.match(/aria-label=\{hasProject \? `([^`]+)` : CURRENT_PROJECT_PLACEHOLDER\}/);
  const title = SRC.match(/title=\{hasProject \? `([^`]+)` : CURRENT_PROJECT_PLACEHOLDER\}/);
  assert.ok(aria, 'aria-label 표현식을 찾지 못했다');
  assert.ok(title, 'title 표현식을 찾지 못했다');
  assert.equal(aria![1], title![1], 'aria-label 과 title 은 동일한 문자열 템플릿을 사용해야 한다');
  assert.match(aria![1], /현재 프로젝트: \$\{display\}/);
});

test('시각 라벨도 "현재 프로젝트:" 로 정렬되어 aria 경로와 시각 경로가 동일한 문구를 사용한다', () => {
  // 지시 #ccb2d506 — 상단바 메트릭 칩 "프로젝트: N" 과 본 배지가 모두 "프로젝트:"
  // 접두어만 쓰면 사용자가 두 값을 혼동한다. 본 배지는 시각 라벨도 aria-label/title
  // 과 동일하게 "현재 프로젝트:" 로 써서 count 칩과 완전히 구분되어야 한다.
  assert.match(SRC, /현재 프로젝트: \{display\}/,
    '배지 본문이 "현재 프로젝트: {display}" 로 렌더되어야 한다');
  assert.doesNotMatch(SRC, />\s*프로젝트: \{display\}/,
    '구 라벨 "프로젝트: {display}" (접두어 "현재" 누락) 로 회귀해선 안 된다');
});
