// Run with: npx tsx --test tests/multimediaTypes.unit.test.ts
//
// 지시 #967d596b (QA) · multimedia/types.ts 회귀 계약 고정.
//
// tests/multimediaAdapters.unit.test.ts A 섹션이 기본 상수/오류의 최소 계약만
// 잠그고 있어, 다음 네 축의 회귀가 드러나지 않았다:
//   1) MediaAdapterError.cause 전파 및 stack 보존
//   2) MediaAdapterError.details 방어 복사(원본 변경이 error 에 새지 않는다)
//   3) MediaAdapterError.adapterId/details 미지정 시 인스턴스 키 부재
//   4) MediaAdapterInputMap/OutputMap 이 MediaAdapterKind 6종과 일대일 매핑 유지
//   5) InputAutomationStep 디스크리미네이티드 유니온의 kind 값 세트
//   6) DEFAULT_ADAPTER_CONFIG 가 동결된 상태에서 strict 모드 쓰기가 실패한다

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ADAPTER_CONFIG,
  MediaAdapterError,
  type MediaAdapterKind,
  type MediaAdapterInputMap,
  type MediaAdapterOutputMap,
  type InputAutomationStep,
  type MediaAdapterPhase,
  type MediaAdapterErrorCode,
} from '../src/services/multimedia/types.ts';

// ────────────────────────────────────────────────────────────────────────────
// 1. MediaAdapterError — cause 전파
// ────────────────────────────────────────────────────────────────────────────

test('T1. MediaAdapterError — cause 옵션이 Error.cause 로 그대로 전파된다', () => {
  const root = new TypeError('root boom');
  const err = new MediaAdapterError('INTERNAL', '래핑', { cause: root });
  assert.equal((err as Error & { cause?: unknown }).cause, root);
});

test('T2. MediaAdapterError — cause 미지정 시 cause 키 자체가 설정되지 않는다', () => {
  const err = new MediaAdapterError('INTERNAL', 'no cause');
  assert.equal((err as Error & { cause?: unknown }).cause, undefined);
});

test('T3. MediaAdapterError — Error 서브타입이며 stack 을 보존한다', () => {
  const err = new MediaAdapterError('TIMEOUT', '시간 초과');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof MediaAdapterError);
  assert.ok(typeof err.stack === 'string' && err.stack.length > 0);
});

// ────────────────────────────────────────────────────────────────────────────
// 2. details 방어 복사
// ────────────────────────────────────────────────────────────────────────────

test('T4. details — 생성 후 원본 객체 변경이 err.details 에 새지 않는다', () => {
  const mutable: Record<string, unknown> = { reason: 'A' };
  const err = new MediaAdapterError('INPUT_INVALID', 'x', { details: mutable });
  mutable.reason = 'B';
  mutable.extra = 'added';
  assert.deepEqual(err.details, { reason: 'A' });
  assert.equal((err.details as { extra?: string }).extra, undefined);
});

test('T5. details — 프로즌이므로 재할당 시도가 strict 모드에서 throw', () => {
  'use strict';
  const err = new MediaAdapterError('NETWORK_ERROR', 'x', { details: { k: 1 } });
  assert.throws(() => {
    (err.details as Record<string, unknown>).k = 2;
  }, TypeError);
});

// ────────────────────────────────────────────────────────────────────────────
// 3. 옵션 미지정 시 속성 부재
// ────────────────────────────────────────────────────────────────────────────

test('T6. adapterId/details 미지정 시 인스턴스 자체 키에 undefined 가 아닌 부재', () => {
  const err = new MediaAdapterError('ABORTED', 'canceled');
  assert.equal(Object.prototype.hasOwnProperty.call(err, 'adapterId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(err, 'details'), false);
});

// ────────────────────────────────────────────────────────────────────────────
// 4. MediaAdapterKind ↔ I/O 매핑 완전성
// ────────────────────────────────────────────────────────────────────────────

test('T7. MediaAdapterInputMap/OutputMap 은 6종 kind 를 모두 커버한다 (컴파일+런타임 키)', () => {
  const kinds: MediaAdapterKind[] = [
    'pdf',
    'pptx',
    'video',
    'web-search',
    'research',
    'input-automation',
  ];
  // 타입 레벨 커버리지 — 누락 시 TS 가 이 위치에서 실패한다.
  const inputSample: { [K in MediaAdapterKind]: MediaAdapterInputMap[K] } = {
    'pdf': { source: 'x' },
    'pptx': { source: 'x' },
    'video': { prompt: 'x' },
    'web-search': { query: 'x' },
    'research': { topic: 'x' },
    'input-automation': {
      steps: [{ kind: 'click', selector: '#a' }],
      requestedPermission: 'display',
      humanRationale: 'x',
    },
  };
  const outputSample: { [K in MediaAdapterKind]: MediaAdapterOutputMap[K] } = {
    'pdf': { pageCount: 0, text: '' },
    'pptx': { slideCount: 0, text: '' },
    'video': { jobId: 'j' },
    'web-search': { items: [] },
    'research': { summary: '', citations: [] },
    'input-automation': { executedSteps: 0, skippedSteps: 0 },
  };
  // 런타임에서도 6종 모두 존재하는지 확인.
  for (const k of kinds) {
    assert.ok(k in inputSample, `input map missing ${k}`);
    assert.ok(k in outputSample, `output map missing ${k}`);
  }
  assert.equal(Object.keys(inputSample).length, 6);
  assert.equal(Object.keys(outputSample).length, 6);
});

// ────────────────────────────────────────────────────────────────────────────
// 5. InputAutomationStep 디스크리미네이티드 유니온
// ────────────────────────────────────────────────────────────────────────────

test('T8. InputAutomationStep — kind 값 5종이 전부 표현 가능하다', () => {
  const steps: InputAutomationStep[] = [
    { kind: 'click', selector: '#btn' },
    { kind: 'type', text: 'hi', selector: '#in' },
    { kind: 'key', key: 'Enter', modifiers: ['ctrl', 'shift'] },
    { kind: 'wait', ms: 100 },
    { kind: 'scroll', deltaY: -50 },
  ];
  const seen = new Set<InputAutomationStep['kind']>();
  for (const s of steps) {
    seen.add(s.kind);
    // 각 분기를 빠짐없이 다루는지 switch 로 확인 — 누락 시 tsc 가 never 경고.
    switch (s.kind) {
      case 'click':
        assert.equal(typeof s.selector, 'string');
        break;
      case 'type':
        assert.equal(typeof s.text, 'string');
        break;
      case 'key':
        assert.equal(typeof s.key, 'string');
        break;
      case 'wait':
        assert.equal(typeof s.ms, 'number');
        break;
      case 'scroll':
        assert.equal(typeof s.deltaY, 'number');
        break;
      default: {
        const _exhaustive: never = s;
        throw new Error(`unreachable: ${String(_exhaustive)}`);
      }
    }
  }
  assert.equal(seen.size, 5);
});

// ────────────────────────────────────────────────────────────────────────────
// 6. DEFAULT_ADAPTER_CONFIG 동결 — strict 모드 재할당 차단
// ────────────────────────────────────────────────────────────────────────────

test('T9. DEFAULT_ADAPTER_CONFIG 재할당은 strict 모드에서 TypeError', () => {
  'use strict';
  assert.throws(() => {
    (DEFAULT_ADAPTER_CONFIG as unknown as { maxBytes: number }).maxBytes = 1;
  }, TypeError);
});

// ────────────────────────────────────────────────────────────────────────────
// 7. MediaAdapterPhase / MediaAdapterErrorCode — 값 집합 고정
// ────────────────────────────────────────────────────────────────────────────

test('T10. MediaAdapterPhase 3종 · MediaAdapterErrorCode 11종 문자열 리터럴 커버', () => {
  const phases: MediaAdapterPhase[] = ['precheck', 'upload', 'finalize'];
  assert.equal(new Set(phases).size, 3);

  const codes: MediaAdapterErrorCode[] = [
    'UNSUPPORTED_MIME',
    'FILE_TOO_LARGE',
    'INPUT_INVALID',
    'NETWORK_ERROR',
    'PERMISSION_DENIED',
    'QUOTA_EXCEEDED',
    'ADAPTER_NOT_REGISTERED',
    'DEPENDENCY_MISSING',
    'TIMEOUT',
    'ABORTED',
    'INTERNAL',
  ];
  assert.equal(new Set(codes).size, 11);
});
