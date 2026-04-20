// Run with: npx tsx --test tests/multimediaBarrel.regression.test.ts
//
// 지시 #23d282d2 (QA) — `src/services/multimedia/index.ts` 바렐 공용 표면 회귀.
//
// 현재 바렐은 스켈레톤(createXxxAdapter · XXX_ADAPTER_ID) 과 실구현(createRealXxxAdapter ·
// XXX_REAL_ADAPTER_ID · XXX_ALIAS · 파싱/생성 함수 · 어댑터 클래스) 을 나란히 재수출한다.
// UI(미디어 허브) · 레지스트리 · 테스트가 모두 바렐 단일 경로를 통해 기호를 끌어다 쓰므로,
// 어느 한 기호가 바렐에서 사라지거나 상수 값이 뒤바뀌면 광범위한 회귀를 일으킨다.
//
// 본 테스트는 "바렐이 노출하는 런타임 기호와 상수 값" 을 최소한으로 고정한다. 어댑터 내부
// 동작은 별도 spec 이 담당한다 — 여기서는 표면만 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as barrel from '../src/services/multimedia/index.ts';

test('Barrel-1. 스켈레톤 팩토리 6종이 런타임 함수로 노출된다', () => {
  for (const name of [
    'createPdfAdapter',
    'createPptAdapter',
    'createVideoAdapter',
    'createWebSearchAdapter',
    'createResearchAdapter',
    'createInputAutomationAdapter',
  ] as const) {
    assert.equal(
      typeof (barrel as Record<string, unknown>)[name],
      'function',
      `barrel.${name} 은 함수여야 한다`,
    );
  }
});

test('Barrel-2. 실구현 팩토리 6종이 런타임 함수로 노출된다', () => {
  for (const name of [
    'createRealPdfAdapter',
    'createRealPptAdapter',
    'createVideoRealAdapter',
    'createWebSearchRealAdapter',
    'createResearchRealAdapter',
    'createRealInputAutomationAdapter',
  ] as const) {
    assert.equal(
      typeof (barrel as Record<string, unknown>)[name],
      'function',
      `barrel.${name} 은 함수여야 한다`,
    );
  }
});

test('Barrel-3. 실구현 파싱/생성 헬퍼가 함수로 노출된다', () => {
  for (const name of [
    'parsePdf',
    'generatePdf',
    'parsePpt',
    'generatePpt',
    'generateVideo',
    'composeStoryboard',
    'webSearch',
    'deepResearch',
  ] as const) {
    assert.equal(
      typeof (barrel as Record<string, unknown>)[name],
      'function',
      `barrel.${name} 은 함수여야 한다`,
    );
  }
});

test('Barrel-4. 어댑터 클래스 6종이 클래스로 노출된다', () => {
  for (const name of [
    'PdfAdapter',
    'PptAdapter',
    'VideoAdapter',
    'WebSearchAdapter',
    'ResearchAdapter',
    'InputAutomationAdapter',
  ] as const) {
    const ctor = (barrel as Record<string, unknown>)[name];
    assert.equal(typeof ctor, 'function', `barrel.${name} 은 클래스(함수)여야 한다`);
  }
});

test('Barrel-5. 스켈레톤 어댑터 ID 상수 값이 고정', () => {
  assert.equal(barrel.PDF_ADAPTER_ID, 'builtin-pdf');
  assert.equal(barrel.PPT_ADAPTER_ID, 'builtin-pptx');
  assert.equal(barrel.VIDEO_ADAPTER_ID, 'builtin-video');
  assert.equal(barrel.WEB_SEARCH_ADAPTER_ID, 'builtin-web-search');
  assert.equal(barrel.RESEARCH_ADAPTER_ID, 'builtin-research');
  assert.equal(barrel.INPUT_AUTOMATION_ADAPTER_ID, 'builtin-input-automation');
});

test('Barrel-6. 실구현 어댑터 ID·별칭 상수 값이 고정', () => {
  assert.equal(barrel.VIDEO_REAL_ADAPTER_ID, 'video-v1');
  assert.equal(barrel.VIDEO_ALIAS, 'video/generate');
  assert.equal(barrel.WEB_SEARCH_REAL_ADAPTER_ID, 'webSearch-v1');
  assert.equal(barrel.WEB_SEARCH_ALIAS, 'search/web');
  assert.equal(barrel.RESEARCH_REAL_ADAPTER_ID, 'research-v1');
  assert.equal(barrel.RESEARCH_ALIAS, 'research/deep');
  assert.equal(barrel.INPUT_AUTOMATION_ALIAS, 'automation/input');
});

test('Barrel-7. types.ts 재수출 — 핵심 런타임 기호(동결 설정·오류 클래스·레지스트리)', () => {
  assert.ok(Object.isFrozen(barrel.DEFAULT_ADAPTER_CONFIG));
  assert.equal(barrel.DEFAULT_ADAPTER_CONFIG.maxBytes, 50 * 1024 * 1024);
  assert.equal(barrel.DEFAULT_ADAPTER_CONFIG.timeoutMs, 30_000);
  assert.equal(typeof barrel.MediaAdapterError, 'function');
  assert.equal(typeof barrel.MultimediaRegistry, 'function');
  assert.equal(typeof barrel.createDefaultRegistry, 'function');
});

test('Barrel-8. createDefaultRegistry — 6종 kind 가 전부 resolve 된다(실구현 채택)', () => {
  const reg = barrel.createDefaultRegistry();
  const kinds = [
    'pdf',
    'pptx',
    'video',
    'web-search',
    'research',
    'input-automation',
  ] as const;
  for (const kind of kinds) {
    const adapter = reg.resolveByKind(kind);
    assert.equal(adapter.descriptor.kind, kind);
  }
  const realIds = new Set([
    barrel.PDF_ADAPTER_ID,
    barrel.PPT_ADAPTER_ID,
    barrel.VIDEO_REAL_ADAPTER_ID,
    barrel.WEB_SEARCH_REAL_ADAPTER_ID,
    barrel.RESEARCH_REAL_ADAPTER_ID,
    barrel.INPUT_AUTOMATION_ADAPTER_ID,
  ]);
  // list() 가 6개 모두를 반환해야 한다(중복 등록이 생기면 개수가 어긋난다).
  assert.equal(reg.list().length, 6, 'createDefaultRegistry 는 6개 descriptor 를 갖는다');
  for (const desc of reg.list()) {
    // 각 descriptor 가 known id 집합과 일치하는지 느슨히 확인(화이트리스트 기준).
    // displayName 에 별칭이 붙어 있을 수 있으므로 id 만 검사.
    assert.ok(realIds.has(desc.id), `알 수 없는 어댑터 id: ${desc.id}`);
  }
});

test('Barrel-9. 스켈레톤 PDF_ADAPTER_ID 와 실구현 descriptor.id 가 동기화되어 있다', () => {
  // 스켈레톤 재수출 경로(createPdfAdapter) 와 실구현(createRealPdfAdapter) 모두
  // 동일한 PDF_ADAPTER_ID('builtin-pdf') 을 descriptor.id 로 보고한다. 어느 한쪽만
  // 값이 바뀌면 등록소의 중복 id 탐지 · UI 라우팅이 깨지므로 함께 잠근다.
  const skel = barrel.createPdfAdapter(barrel.DEFAULT_ADAPTER_CONFIG);
  const real = barrel.createRealPdfAdapter(barrel.DEFAULT_ADAPTER_CONFIG);
  assert.equal(skel.descriptor.id, barrel.PDF_ADAPTER_ID);
  assert.equal(real.descriptor.id, barrel.PDF_ADAPTER_ID);
});
