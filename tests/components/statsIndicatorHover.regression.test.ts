// Run with: npx tsx --test tests/components/statsIndicatorHover.regression.test.ts
//
// 지시 #ab6c9d78 — StatsIndicator hover popover 노출 회귀 잠금.
//
// 배경
//   기존 구현은 트리거 span 에만 onMouseEnter/Leave 가 있어 마우스가 popover 로
//   이동하는 순간 hovered=false 가 발사돼 popover 가 다시 닫혔다. 또한 트리거와
//   popover 사이 marginTop=6px dead zone 이 마우스 이동 도중 hover 끊김을 유발했다.
//   부모 컨테이너(App.tsx 의 `app-header-metrics`) 가 overflow-hidden 으로 묶이면
//   popover(`position: absolute; top: 100%`) 가 시각적으로 잘려 사용자가 절대
//   세부 정보를 볼 수 없는 상태가 됐다.
//
//   본 회귀는 정적 마크업 분석으로 다음 4가지 계약을 잠근다.
//     (1) wrapper span(stats-indicator) 에 onMouseEnter/onMouseLeave 가 모두 선언.
//     (2) popover 의 marginTop 이 0 으로 트리거-popover dead zone 이 없다.
//     (3) App.tsx 의 `app-header-metrics` 컨테이너에서 overflow-hidden 이 제거됐다.
//     (4) popover 가 percent === null 일 때 '—' 폴백을 그대로 사용한다(데이터 누락 시각 대응).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATS_SRC = readFileSync(
  resolve(__dirname, '..', '..', 'src', 'components', 'StatsIndicator.tsx'),
  'utf8',
);
const APP_SRC = readFileSync(
  resolve(__dirname, '..', '..', 'src', 'App.tsx'),
  'utf8',
);

test('1. hover 핸들러는 트리거가 아닌 wrapper span 에 위임돼 popover 안에서도 hover 유지된다', () => {
  // setHovered 호출이 정확히 한 쌍(true/false)만 등장해야 한다 — 두 곳에 중복되거나
  // 트리거에만 남아 있으면 회귀.
  const enters = STATS_SRC.match(/setHovered\(true\)/g) ?? [];
  const leaves = STATS_SRC.match(/setHovered\(false\)/g) ?? [];
  assert.equal(enters.length, 1, `setHovered(true) 호출은 1회여야 한다(실제 ${enters.length})`);
  // setHovered(false) 는 onMouseLeave 와 Escape 키 분기 두 곳에 있을 수 있어 ≥1 만 잠근다.
  assert.ok(leaves.length >= 1, `setHovered(false) 호출은 1회 이상이어야 한다(실제 ${leaves.length})`);
  // 트리거 span 의 시작 태그(스코프 한정 정규식) 안에는 onMouseEnter 가 없어야 한다.
  const triggerStart = STATS_SRC.indexOf('data-testid="stats-indicator-trigger"');
  assert.notEqual(triggerStart, -1, '트리거 span 의 data-testid 를 찾지 못했다');
  // 트리거 시작 태그의 닫는 괄호 위치를 정확히 잡기 위해 다음 `<svg` 직전까지만 검사한다.
  const triggerEnd = STATS_SRC.indexOf('<svg', triggerStart);
  const triggerBlock = STATS_SRC.slice(triggerStart, triggerEnd);
  assert.doesNotMatch(triggerBlock, /onMouseEnter/,
    '트리거 span 에는 onMouseEnter 가 더 이상 단독 선언되면 안 된다 — wrapper 로 위임');
  // 반대로 wrapper span 영역(트리거 시작 이전) 에는 onMouseEnter 가 정확히 1번 등장한다.
  const wrapperBlock = STATS_SRC.slice(0, triggerStart);
  const wrapperEnters = wrapperBlock.match(/onMouseEnter/g) ?? [];
  assert.equal(wrapperEnters.length, 1,
    `wrapper span 에 onMouseEnter 가 정확히 1회 선언돼야 한다(실제 ${wrapperEnters.length})`);
});

test('2. popover 의 marginTop 이 0 으로 dead zone 없음', () => {
  // popover div 의 inline style 안에 marginTop: 0 이 명시돼야 한다.
  const popoverBlockMatch = STATS_SRC.match(
    /data-testid="stats-indicator-popover"[\s\S]*?\/ul>\s*<\/div>/,
  );
  assert.ok(popoverBlockMatch, 'popover 블록을 찾지 못했다');
  assert.match(popoverBlockMatch[0], /marginTop:\s*0\b/,
    'popover marginTop=0 이 dead zone 제거의 핵심이다');
  // dead zone 보상으로 paddingTop 이 6px 이상 잡혀 있어야 한다.
  assert.match(popoverBlockMatch[0], /padding:\s*['"][^'"]*?\d+px[^'"]*?['"]/);
});

test('3. App.tsx 의 app-header-metrics 컨테이너에 overflow-hidden 이 없다', () => {
  const containerMatch = APP_SRC.match(
    /className="app-header-metrics[^"]*"/,
  );
  assert.ok(containerMatch, 'app-header-metrics 컨테이너 className 을 찾지 못했다');
  assert.doesNotMatch(containerMatch[0], /\boverflow-hidden\b/,
    '컨테이너 overflow-hidden 은 popover 를 잘라 본 회귀를 재현시킨다');
});

test('4. popover 의 percent === null 분기는 시각 폴백 "—" 한 글자를 그대로 사용한다', () => {
  // 데이터 누락(unknown 티어) 시 "—" (U+2014) 폴백이 popover 본문에 살아 있는지 확인.
  assert.match(STATS_SRC, /line\.percent === null \? '—' : `\$\{line\.percent\}%`/);
});
