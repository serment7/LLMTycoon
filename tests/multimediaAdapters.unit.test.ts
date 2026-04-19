// Run with: npx tsx --test tests/multimediaAdapters.unit.test.ts
//
// 지시 #9c2ae902 — 멀티미디어 어댑터 계약·레지스트리 회귀.
//
// 본 파일은 실제 외부 호출(pdf-parse · Playwright · Sora) 을 검증하지 않는다. 그 대신
// 6종 어댑터의 "계약 표면" 이 깨지지 않았는지만 잠근다:
//   A. types.ts — 오류 클래스/기본 설정이 스펙대로 선언돼 있다.
//   B. 각 어댑터 descriptor 의 capability 플래그와 kind 매핑이 일치한다.
//   C. canHandle 이 잘못된 입력을 거절한다.
//   D. invoke 는 현재 ADAPTER_NOT_REGISTERED(또는 권한/크레덴셜 게이트) 로 수렴한다.
//   E. MultimediaRegistry 의 resolveByKind / resolveById / 순환 탐지 / 의존성 누락 판정.
//
// 실제 파싱·생성이 붙는 후속 PR 은 "invoke 가 ADAPTER_NOT_REGISTERED 를 던진다" 는
// 계약을 해제하고 결과 스키마 테스트를 추가하면 된다(현재 테스트는 그 경계점).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ADAPTER_CONFIG,
  MediaAdapterError,
  type MediaAdapterInput,
  MultimediaRegistry,
  createDefaultRegistry,
  createPdfAdapter,
  createPptAdapter,
  createVideoAdapter,
  createWebSearchAdapter,
  createResearchAdapter,
  createInputAutomationAdapter,
  PDF_ADAPTER_ID,
  PPT_ADAPTER_ID,
  VIDEO_ADAPTER_ID,
  WEB_SEARCH_ADAPTER_ID,
  RESEARCH_ADAPTER_ID,
  INPUT_AUTOMATION_ADAPTER_ID,
} from '../src/services/multimedia/index.ts';

// ────────────────────────────────────────────────────────────────────────────
// A. 기본 상수 / 오류 클래스
// ────────────────────────────────────────────────────────────────────────────

test('A1. DEFAULT_ADAPTER_CONFIG 는 동결 + 핵심 기본값 유지', () => {
  assert.ok(Object.isFrozen(DEFAULT_ADAPTER_CONFIG));
  assert.equal(DEFAULT_ADAPTER_CONFIG.maxBytes, 50 * 1024 * 1024);
  assert.equal(DEFAULT_ADAPTER_CONFIG.timeoutMs, 30_000);
  assert.equal(DEFAULT_ADAPTER_CONFIG.inputAutomationMaxPermission, 'display');
});

test('A2. MediaAdapterError 는 code/adapterId/details 를 보존하고 details 는 동결', () => {
  const err = new MediaAdapterError('PERMISSION_DENIED', '권한 거절', {
    adapterId: 'x',
    details: { reason: 'no-consent' },
  });
  assert.equal(err.code, 'PERMISSION_DENIED');
  assert.equal(err.adapterId, 'x');
  assert.deepEqual(err.details, { reason: 'no-consent' });
  assert.ok(Object.isFrozen(err.details));
  assert.equal(err.name, 'MediaAdapterError');
});

// ────────────────────────────────────────────────────────────────────────────
// B. 어댑터 descriptor 계약
// ────────────────────────────────────────────────────────────────────────────

test('B1. PdfAdapter — kind/id/capabilities 매핑', () => {
  const a = createPdfAdapter(DEFAULT_ADAPTER_CONFIG);
  assert.equal(a.descriptor.kind, 'pdf');
  assert.equal(a.descriptor.id, PDF_ADAPTER_ID);
  assert.deepEqual(a.descriptor.supportedInputMimes, ['application/pdf']);
  assert.equal(a.descriptor.capabilities.canParse, true);
  assert.equal(a.descriptor.capabilities.canGenerate, true);
  assert.equal(a.descriptor.capabilities.requiresUserConsent, false);
  assert.deepEqual(a.descriptor.dependsOn, []);
});

test('B2. PptAdapter — kind=pptx, openxml MIME', () => {
  const a = createPptAdapter(DEFAULT_ADAPTER_CONFIG);
  assert.equal(a.descriptor.kind, 'pptx');
  assert.equal(a.descriptor.id, PPT_ADAPTER_ID);
  assert.ok(
    a.descriptor.supportedInputMimes.includes(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ),
  );
});

test('B3. VideoAdapter — canGenerate=true · canParse=false · 오프라인 불가', () => {
  const a = createVideoAdapter(DEFAULT_ADAPTER_CONFIG);
  assert.equal(a.descriptor.id, VIDEO_ADAPTER_ID);
  assert.equal(a.descriptor.capabilities.canParse, false);
  assert.equal(a.descriptor.capabilities.canGenerate, true);
  assert.equal(a.descriptor.capabilities.worksOffline, false);
});

test('B4. WebSearchAdapter — 크레덴셜 없으면 PERMISSION_DENIED 로 실패', async () => {
  const a = createWebSearchAdapter({ ...DEFAULT_ADAPTER_CONFIG, hasWebSearchCredentials: false });
  assert.equal(a.descriptor.id, WEB_SEARCH_ADAPTER_ID);
  await assert.rejects(
    a.invoke({ input: { query: 'hello' } }),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'PERMISSION_DENIED',
  );
});

test('B5. ResearchAdapter — dependsOn 에 web-search 포함', () => {
  const a = createResearchAdapter(DEFAULT_ADAPTER_CONFIG);
  assert.equal(a.descriptor.id, RESEARCH_ADAPTER_ID);
  assert.deepEqual(a.descriptor.dependsOn, [WEB_SEARCH_ADAPTER_ID]);
});

test('B6. InputAutomationAdapter — requiresUserConsent=true 가 강제', () => {
  const a = createInputAutomationAdapter(DEFAULT_ADAPTER_CONFIG);
  assert.equal(a.descriptor.id, INPUT_AUTOMATION_ADAPTER_ID);
  assert.equal(a.descriptor.capabilities.requiresUserConsent, true);
});

// ────────────────────────────────────────────────────────────────────────────
// C. canHandle 입력 거절 규칙
// ────────────────────────────────────────────────────────────────────────────

test('C1. PdfAdapter.canHandle — MIME 불일치/크기 초과 거절', () => {
  const a = createPdfAdapter({ ...DEFAULT_ADAPTER_CONFIG, maxBytes: 1024 });
  assert.equal(a.canHandle({ source: '/x.pdf', mimeType: 'application/pdf', sizeBytes: 100 }), true);
  assert.equal(a.canHandle({ source: '/x.pdf', mimeType: 'image/png' }), false, 'MIME 불일치');
  assert.equal(
    a.canHandle({ source: '/x.pdf', mimeType: 'application/pdf', sizeBytes: 5000 }),
    false,
    'maxBytes 초과',
  );
});

test('C2. VideoAdapter.canHandle — 공백 prompt 거절', () => {
  const a = createVideoAdapter(DEFAULT_ADAPTER_CONFIG);
  assert.equal(a.canHandle({ prompt: '풍경' }), true);
  assert.equal(a.canHandle({ prompt: '   ' }), false);
  assert.equal(a.canHandle({ prompt: 'x', durationSeconds: 0 }), false);
});

test('C3. InputAutomationAdapter.canHandle — humanRationale 공란·권한 초과 모두 거절', () => {
  const a = createInputAutomationAdapter({
    ...DEFAULT_ADAPTER_CONFIG,
    inputAutomationMaxPermission: 'interact',
  });
  const validStep = [{ kind: 'click' as const, selector: '#btn' }];
  assert.equal(
    a.canHandle({ steps: validStep, requestedPermission: 'interact', humanRationale: '로그인 버튼 클릭' }),
    true,
  );
  assert.equal(
    a.canHandle({ steps: validStep, requestedPermission: 'interact', humanRationale: '   ' }),
    false,
    'rationale 공란',
  );
  assert.equal(
    a.canHandle({ steps: validStep, requestedPermission: 'system', humanRationale: 'x' }),
    false,
    '권한 초과',
  );
  assert.equal(
    a.canHandle({ steps: [], requestedPermission: 'display', humanRationale: 'x' }),
    false,
    '빈 steps',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// D. invoke 현재 경계 — 모두 ADAPTER_NOT_REGISTERED 로 수렴(권한 게이트 제외)
// ────────────────────────────────────────────────────────────────────────────

test('D1. 모든 어댑터의 invoke 는 현재 MediaAdapterError 를 던진다(실구현 전 경계)', async () => {
  const adapters = [
    createPdfAdapter(DEFAULT_ADAPTER_CONFIG),
    createPptAdapter(DEFAULT_ADAPTER_CONFIG),
    createVideoAdapter(DEFAULT_ADAPTER_CONFIG),
    createResearchAdapter(DEFAULT_ADAPTER_CONFIG),
  ];
  for (const a of adapters) {
    const kind = a.descriptor.kind as 'pdf' | 'pptx' | 'video' | 'research';
    const input = fakeInputFor(kind);
    await assert.rejects(
      (a as { invoke: (c: { input: unknown }) => Promise<unknown> }).invoke({ input }),
      (err: unknown) => err instanceof MediaAdapterError,
      `${a.descriptor.id} 는 MediaAdapterError 를 던져야 한다`,
    );
  }
});

test('D2. InputAutomationAdapter.invoke — 권한 초과면 PERMISSION_DENIED 로 즉시 실패', async () => {
  const a = createInputAutomationAdapter({
    ...DEFAULT_ADAPTER_CONFIG,
    inputAutomationMaxPermission: 'display',
  });
  await assert.rejects(
    a.invoke({
      input: {
        steps: [{ kind: 'click', selector: '#x' }],
        requestedPermission: 'system',
        humanRationale: '루트 작업',
      },
    }),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'PERMISSION_DENIED',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// E. MultimediaRegistry 동작
// ────────────────────────────────────────────────────────────────────────────

test('E1. createDefaultRegistry — 6종 descriptor 가 모두 등록된다', () => {
  const reg = createDefaultRegistry();
  const kinds = reg.list().map((d) => d.kind).sort();
  assert.deepEqual(kinds, ['input-automation', 'pdf', 'pptx', 'research', 'video', 'web-search']);
});

test('E2. resolveByKind — kind 별 인스턴스를 돌려주고 같은 id 는 캐시된다', () => {
  const reg = createDefaultRegistry();
  const pdf1 = reg.resolveByKind('pdf');
  const pdf2 = reg.resolveByKind('pdf');
  assert.equal(pdf1, pdf2, '같은 어댑터는 인스턴스 캐시되어야 한다');
  assert.equal(pdf1.descriptor.kind, 'pdf');
});

test('E3. resolveByKind — 미등록 kind 는 ADAPTER_NOT_REGISTERED', () => {
  const reg = new MultimediaRegistry();
  assert.throws(
    () => reg.resolveByKind('pdf'),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'ADAPTER_NOT_REGISTERED',
  );
});

test('E4. register — 동일 id 중복 등록은 INTERNAL 오류', () => {
  const reg = createDefaultRegistry();
  const pdf = createPdfAdapter(reg.getConfig());
  assert.throws(
    () => reg.register(createPdfAdapter, pdf.descriptor),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'INTERNAL',
  );
});

test('E5. 의존성 누락 — research 를 등록했지만 web-search 가 없으면 DEPENDENCY_MISSING', () => {
  const reg = new MultimediaRegistry();
  const research = createResearchAdapter(reg.getConfig());
  reg.register(createResearchAdapter, research.descriptor);
  assert.throws(
    () => reg.resolveByKind('research'),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'DEPENDENCY_MISSING',
  );
});

test('E6. 순환 의존성 — 인위적으로 만든 순환이 INTERNAL 로 차단된다', () => {
  const reg = new MultimediaRegistry();
  const a = createPdfAdapter(reg.getConfig());
  const b = createPptAdapter(reg.getConfig());
  reg.register(createPdfAdapter, { ...a.descriptor, dependsOn: [b.descriptor.id] });
  reg.register(createPptAdapter, { ...b.descriptor, dependsOn: [a.descriptor.id] });
  assert.throws(
    () => reg.resolveById(a.descriptor.id),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'INTERNAL',
  );
});

test('E7. unregister — 다시 resolve 하면 ADAPTER_NOT_REGISTERED', () => {
  const reg = createDefaultRegistry();
  assert.equal(reg.unregister(PDF_ADAPTER_ID), true);
  assert.throws(
    () => reg.resolveByKind('pdf'),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'ADAPTER_NOT_REGISTERED',
  );
});

test('E8. getConfig — 주입 설정이 동결되어 어댑터 팩토리에 그대로 전달된다', () => {
  const reg = new MultimediaRegistry({ config: { maxBytes: 1234 } });
  const cfg = reg.getConfig();
  assert.equal(cfg.maxBytes, 1234);
  assert.ok(Object.isFrozen(cfg));
});

// ────────────────────────────────────────────────────────────────────────────
// 유틸
// ────────────────────────────────────────────────────────────────────────────

function fakeInputFor<K extends 'pdf' | 'pptx' | 'video' | 'research'>(
  kind: K,
): MediaAdapterInput<K> {
  switch (kind) {
    case 'pdf':
    case 'pptx':
      return { source: 'x', fileName: `x.${kind === 'pdf' ? 'pdf' : 'pptx'}` } as MediaAdapterInput<K>;
    case 'video':
      return { prompt: '풍경' } as MediaAdapterInput<K>;
    case 'research':
      return { topic: '토픽' } as MediaAdapterInput<K>;
    default:
      throw new Error(`fakeInputFor: unsupported ${kind}`);
  }
}
