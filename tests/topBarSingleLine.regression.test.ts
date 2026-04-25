// Run with: npx tsx --test tests/topBarSingleLine.regression.test.ts
//
// 지시 #54a658ca — Thanos 가 수정한 상단 헤더의 "한 줄 유지" 동작 회귀 잠금.
//
// 배경
//   `src/ui/AppShell.tsx` 의 헤더는 `useOverflowMenu`(#0c066697) 로 컨테이너 폭을
//   추적하고, `src/index.css` 의 `.app-shell-header` 규칙으로 flex-wrap:nowrap +
//   text-overflow:ellipsis + white-space:nowrap 을 강제해 어떤 뷰포트 폭에서도
//   헤더가 두 줄로 무너지거나 텍스트가 잘려 겹치지 않도록 한다(docs/design/
//   top-bar-responsive.md 명세). Thanos 의 후속 리팩터가 이 두 축(계산/CSS) 중
//   한 쪽만 깨뜨려도 사용자가 보는 깨짐은 즉시 발생하므로, 양쪽을 한 spec 에서
//   잠근다.
//
//   본 spec 은 jsdom 없이 동작한다 — useOverflowMenu 의 순수 계산 함수를 직접
//   호출해 폭별 분기와 합계 budget 을 단언하고, CSS/AppShell 의 핵심 계약은
//   파일 텍스트 정규식으로 잠근다(테스트 환경에 layout engine 이 없어도 회귀가
//   드러난다). UI 자동화(Playwright)는 docs/qa/top-bar-responsive-checklist.md
//   의 수동 점검표로 보완한다.
//
// 검증 계약
//   (1) 1920/1440/1280/1024/768/480/360px 폭 — 헤더가 한 줄을 유지(트리거 포함
//       총 합 ≤ 컨테이너 폭). 폭이 줄어들수록 visible 항목 수는 단조 감소.
//   (2) 항목 텍스트가 잘리거나 겹치지 않음 — flex-wrap:nowrap + min-width:0 +
//       overflow:hidden + text-overflow:ellipsis 가 .app-shell-header 와 자식
//       클래스에 모두 존재한다.
//   (3) 축약 라벨 tooltip — 좁은 폭에서 노출되는 더보기/언어 토글이 aria-label
//       (또는 title) 을 보유해 잘린 라벨의 풀 문장이 접근성 트리에 남는다.
//   (4) 지표 값이 길어질 때(99.99%, 1,234,567) 도 줄바꿈 발생 없음 — 항목 폭이
//       극단적으로 커도 visible 합이 컨테이너 폭을 절대 초과하지 않으며, CSS
//       white-space:nowrap 가 .app-shell-header__primary 에 적용돼 있다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  computeOverflowMenu,
  resolveBreakpoint,
  type OverflowMenuItem,
} from '../src/hooks/useOverflowMenu.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_SHELL_PATH = resolve(__dirname, '..', 'src', 'ui', 'AppShell.tsx');
const INDEX_CSS_PATH = resolve(__dirname, '..', 'src', 'index.css');

// ────────────────────────────────────────────────────────────────────────────
// 표준 fixture — 헤더의 6개 액션을 모사. 폭은 docs/design/top-bar-responsive.md
// 의 칩 평균치를 따른다(라벨 길이 따라 소폭 차이는 ResizeObserver 가 흡수).
// ────────────────────────────────────────────────────────────────────────────
const ITEM_WIDTH = 160;
const GAP = 8;
const TRIGGER_WIDTH = 56;

const HEADER_ITEMS: readonly OverflowMenuItem[] = [
  { id: 'project',  label: '현재 프로젝트',     width: 200 },
  { id: 'token',    label: '토큰 사용량',       width: ITEM_WIDTH },
  { id: 'agents',   label: '에이전트 12',       width: ITEM_WIDTH },
  { id: 'coverage', label: '커버리지 74%',      width: ITEM_WIDTH },
  { id: 'language', label: '한국어',            width: 120, hideBelowPx: 720 },
  { id: 'settings', label: '설정',              width: 56  },
];

const VIEWPORTS = [1920, 1440, 1280, 1024, 768, 480, 360] as const;

function run(containerWidth: number, items: readonly OverflowMenuItem[] = HEADER_ITEMS) {
  return computeOverflowMenu({
    containerWidth,
    items,
    overflowTriggerWidth: TRIGGER_WIDTH,
    gap: GAP,
  });
}

// 가시 영역 합계가 컨테이너 폭을 절대 초과하지 않는다는 핵심 invariant.
// "한 줄 유지" 의 수학적 등가물 — 트리거가 떠야 하는 분기에서도 trigger+gap 을
// 같이 빼고 계산하므로, 어느 폭에서도 consumedWidth(+오버플로우 시 trigger+gap)
// 합은 컨테이너 폭 이하여야 한다.
function assertSingleLineFits(width: number, label: string): void {
  const r = run(width);
  const triggerCost = r.overflowItems.length > 0 ? TRIGGER_WIDTH + GAP : 0;
  const total = r.consumedWidth + triggerCost;
  assert.ok(
    total <= width,
    `[${label}] width=${width} 에서 한 줄 합계(${total}) 가 컨테이너 폭을 초과 — wrap 회귀`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// (1) 7개 폭 — 한 줄 유지 + 폭 단조 감소에 따른 visible 단조 감소
// ────────────────────────────────────────────────────────────────────────────

test('1. 1920/1440/1280/1024/768/480/360px — 모든 폭에서 한 줄 합계 ≤ 컨테이너 폭', () => {
  for (const w of VIEWPORTS) {
    assertSingleLineFits(w, `viewport ${w}px`);
  }
});

test('1-2. 폭이 줄어들수록 visible 항목 수는 단조 감소(역전 금지)', () => {
  const visibleCounts = VIEWPORTS.map(w => run(w).visibleItems.length);
  for (let i = 1; i < visibleCounts.length; i += 1) {
    assert.ok(
      visibleCounts[i] <= visibleCounts[i - 1],
      `width ${VIEWPORTS[i]} 의 visible(${visibleCounts[i]}) 이 이전(${VIEWPORTS[i - 1]}) 의 ${visibleCounts[i - 1]} 보다 크면 wrap 회귀`,
    );
  }
});

test('1-3. 1920/1440px — 풀 라벨 6개 모두 한 줄에 노출 + 더보기 비노출', () => {
  for (const w of [1920, 1440] as const) {
    const r = run(w);
    assert.equal(r.visibleItems.length, 6, `${w}px 에서 모든 항목 노출`);
    assert.equal(r.overflowItems.length, 0, `${w}px 에서 더보기 비노출`);
  }
});

test('1-4. 720px 미만 — language(hideBelowPx=720) 가 강제 더보기로, 트리거 항상 노출', () => {
  for (const w of [480, 360] as const) {
    const r = run(w);
    assert.ok(
      r.overflowItems.some(it => it.id === 'language'),
      `${w}px 에서 language 가 강제 더보기로 분류돼야 한다`,
    );
    assert.ok(r.overflowItems.length > 0, `${w}px 에서 더보기 트리거 노출 조건 충족`);
  }
});

test('1-5. resolveBreakpoint — 7개 폭이 모두 1280/960/720/0 축에 정확히 매핑', () => {
  assert.equal(resolveBreakpoint(1920), 1280);
  assert.equal(resolveBreakpoint(1440), 1280);
  assert.equal(resolveBreakpoint(1280), 1280);
  assert.equal(resolveBreakpoint(1024), 960);
  assert.equal(resolveBreakpoint(768),  720);
  assert.equal(resolveBreakpoint(480),  0);
  assert.equal(resolveBreakpoint(360),  0);
});

// ────────────────────────────────────────────────────────────────────────────
// (2) 텍스트가 잘리거나 겹치지 않음 — CSS 한 줄/말줄임 계약 잠금
// ────────────────────────────────────────────────────────────────────────────

test('2. .app-shell-header — flex-wrap:nowrap + min-width:0 으로 한 줄 강제', () => {
  const css = readFileSync(INDEX_CSS_PATH, 'utf8');
  const block = css.match(/\.app-shell-header\s*\{[\s\S]*?\n\}/);
  assert.ok(block, '.app-shell-header 블록을 찾지 못했다');
  assert.match(block![0], /flex-wrap:\s*nowrap/, '한 줄 유지: flex-wrap:nowrap 필수');
  assert.match(block![0], /min-width:\s*0/, '자식 폭이 부모를 늘리지 못하도록 min-width:0 필수');
  assert.match(block![0], /display:\s*flex/, 'flex 컨테이너여야 자식 분배가 가능');
});

test('2-2. .app-shell-header__primary — white-space:nowrap + overflow:hidden + text-overflow:ellipsis', () => {
  const css = readFileSync(INDEX_CSS_PATH, 'utf8');
  const block = css.match(/\.app-shell-header__primary\s*\{[\s\S]*?\n\}/);
  assert.ok(block, '.app-shell-header__primary 블록을 찾지 못했다');
  assert.match(block![0], /white-space:\s*nowrap/, '긴 지표 값에서도 줄바꿈 금지');
  assert.match(block![0], /overflow:\s*hidden/, '넘침은 잘려야 한다');
  assert.match(block![0], /text-overflow:\s*ellipsis/, '잘린 텍스트는 ... 로 마감');
});

test('2-3. .app-shell-header__action — flex-shrink:1 + ellipsis 로 항목 간 겹침 방지', () => {
  const css = readFileSync(INDEX_CSS_PATH, 'utf8');
  const block = css.match(/\.app-shell-header__action\s*\{[\s\S]*?\n\}/);
  assert.ok(block, '.app-shell-header__action 블록을 찾지 못했다');
  assert.match(block![0], /flex-shrink:\s*1/, '항목 자체가 줄어들 수 있어야 겹치지 않는다');
  assert.match(block![0], /min-width:\s*0/, '자식 텍스트가 항목 폭을 늘리지 못하도록 가드');
  assert.match(block![0], /white-space:\s*nowrap/);
  assert.match(block![0], /text-overflow:\s*ellipsis/);
});

test('2-4. 1280/960/720 미디어 쿼리에서도 헤더 자체에 wrap 을 풀지 않는다', () => {
  const css = readFileSync(INDEX_CSS_PATH, 'utf8');
  // gap 만 줄이고 flex-wrap 을 wrap 으로 푸는 회귀가 들어오면 한 줄이 깨진다.
  const mediaBlocks = [...css.matchAll(/@media\s*\(max-width:\s*(?:1279|959|719)px\)\s*\{([\s\S]*?)\n\}/g)];
  assert.ok(mediaBlocks.length >= 3, '1279/959/719 세 미디어 쿼리 블록이 모두 있어야 한다');
  for (const m of mediaBlocks) {
    assert.doesNotMatch(
      m[1],
      /\.app-shell-header\s*\{[^}]*flex-wrap:\s*wrap/,
      '미디어 쿼리에서 flex-wrap 을 wrap 으로 풀면 한 줄 계약이 깨진다',
    );
  }
});

// ────────────────────────────────────────────────────────────────────────────
// (3) 축약 라벨 tooltip — 더보기/언어 토글의 a11y 라벨 보존
// ────────────────────────────────────────────────────────────────────────────

test('3. 더보기 트리거 — aria-haspopup="menu" + 항목 수 포함 aria-label 유지', () => {
  const tsx = readFileSync(APP_SHELL_PATH, 'utf8');
  // 트리거가 오버플로우 항목 수를 포함한 풀 문장 aria-label 을 가진다 — 잘린 항목들의
  // 의미가 스크린리더로 전달돼야 "잘린 채 겹친" 회귀와 차별화된다.
  assert.match(tsx, /aria-haspopup="menu"/, '더보기 트리거는 aria-haspopup="menu" 를 가져야 한다');
  assert.match(
    tsx,
    /aria-label=\{t\('header\.actions\.moreAria'\)\.replace\('\{count\}',\s*String\(hiddenActions\.length\)\)\}/,
    '더보기 aria-label 은 hiddenActions.length 로 항목 수를 동적으로 채워야 한다',
  );
  assert.match(tsx, /data-testid="app-shell-header-more"/, '회귀 testid 보존');
});

test('3-2. LanguageToggle — title + aria-label 모두 보유해 축약 시에도 풀 문장 노출', () => {
  const path = resolve(__dirname, '..', 'src', 'ui', 'LanguageToggle.tsx');
  const tsx = readFileSync(path, 'utf8');
  // ko/en 옵션 버튼 각각이 title 속성을 가져 hover 시 풀 라벨이 뜬다.
  assert.match(tsx, /title=\{t\(LABEL_KEY\[code\]\)\}/, '언어 옵션 버튼에 title tooltip 필수');
  // 그룹 자체에도 aria-label 이 있어 스크린리더가 잘린 라벨을 보완한다.
  assert.match(tsx, /aria-label=\{t\('locale\.label'\)\}/, '언어 그룹 aria-label 필수');
});

test('3-3. TokenUsageIndicator — 지표 영역에 aria-label 이 적재돼 축약 시에도 의미 보존', () => {
  const path = resolve(__dirname, '..', 'src', 'ui', 'TokenUsageIndicator.tsx');
  const tsx = readFileSync(path, 'utf8');
  // 지표 컨테이너 + 입력/출력/캐시 셋 aria-label 이 모두 존재해야 한다.
  assert.match(tsx, /aria-label=\{t\('tokenUsage\.indicator\.label'\)\}/);
  assert.match(tsx, /aria-label=\{t\('tokenUsage\.indicator\.input'\)\}/);
  assert.match(tsx, /aria-label=\{t\('tokenUsage\.indicator\.output'\)\}/);
  assert.match(tsx, /aria-label=\{t\('tokenUsage\.indicator\.cacheHit'\)\}/);
});

// ────────────────────────────────────────────────────────────────────────────
// (4) 지표 값이 길어질 때(99.99%, 1,234,567) 도 줄바꿈 없음
// ────────────────────────────────────────────────────────────────────────────

test('4. 긴 지표 값(99.99% / 1,234,567) — 항목 폭이 부풀어도 한 줄 합계는 컨테이너 이내', () => {
  // 라벨 길이가 늘어나면 ResizeObserver 가 항목 폭을 더 크게 측정해 넘긴다고 가정.
  // 240px(99.99%·1,234,567 라벨에 한국어 캡션을 더한 보수적 추정값) 의 항목으로 교체해도
  // 분류 결과가 "한 줄 합계 ≤ 컨테이너 폭" 을 깨뜨리지 않아야 한다.
  const widened: OverflowMenuItem[] = HEADER_ITEMS.map(it =>
    it.id === 'token' || it.id === 'coverage' || it.id === 'agents'
      ? { ...it, width: 240 }
      : it,
  );
  for (const w of VIEWPORTS) {
    const r = computeOverflowMenu({
      containerWidth: w,
      items: widened,
      overflowTriggerWidth: TRIGGER_WIDTH,
      gap: GAP,
    });
    const triggerCost = r.overflowItems.length > 0 ? TRIGGER_WIDTH + GAP : 0;
    assert.ok(
      r.consumedWidth + triggerCost <= w,
      `[wide=${w}] 긴 지표 값에서 한 줄 합계(${r.consumedWidth + triggerCost}) > ${w} — wrap 회귀`,
    );
  }
});

test('4-2. 단일 지표 폭이 컨테이너를 넘어도 wrap 대신 overflow 분류로 흡수', () => {
  // 99.99%·1,234,567 라벨 + 풀 한국어 접두("입력 토큰: 1,234,567") 같은 극단 케이스.
  // 항목 하나 폭이 컨테이너 자체보다 커도, 빌더는 그것을 overflow 로 보내고 visible 은
  // 비워 둠으로써 결코 "두 줄에 걸쳐 그리지 않는다" 는 계약을 지킨다.
  const huge: OverflowMenuItem[] = [
    { id: 'token', label: '입력 토큰: 1,234,567', width: 600 },
  ];
  const r = computeOverflowMenu({
    containerWidth: 360,
    items: huge,
    overflowTriggerWidth: TRIGGER_WIDTH,
    gap: GAP,
  });
  assert.equal(r.visibleItems.length, 0, '컨테이너보다 큰 항목은 visible 에 넣지 않는다');
  assert.equal(r.overflowItems.length, 1, '대신 overflow 로 흡수해 한 줄을 보존');
  assert.ok(r.consumedWidth <= 360, 'consumedWidth 도 컨테이너 폭을 넘지 않는다');
});

test('4-3. .app-shell-header__more — white-space:nowrap 으로 더보기 라벨도 줄바꿈 금지', () => {
  // 더보기 버튼 자체가 두 줄로 깨지면 헤더 한 줄 계약이 무너진다.
  const css = readFileSync(INDEX_CSS_PATH, 'utf8');
  const block = css.match(/\.app-shell-header__more\s*\{[\s\S]*?\n\}/);
  assert.ok(block, '.app-shell-header__more 블록을 찾지 못했다');
  assert.match(block![0], /white-space:\s*nowrap/, '더보기 라벨도 한 줄 유지');
  assert.match(block![0], /flex:\s*0\s+0\s+auto/, '더보기 버튼은 절대 줄어들지 않아야 한다');
});
