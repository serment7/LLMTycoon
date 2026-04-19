// Run with: npx tsx --test tests/errorSurfaceInfrastructure.unit.test.ts
//
// 단위 테스트(#3773fc8d) — 전역 오류 표면화 인프라 3축.
//   1) errorMessages — MediaLoader/Exporter/Parse/미지 오류를 한국어 메시지로 매핑.
//   2) toastStackReducer — 토스트 스택의 PUSH(동일 id 병합)/DISMISS/CLEAR 불변 계약.
//   3) deriveErrorState(ErrorBoundary) — 렌더 오류 파생이 Error/string/객체에서 Error 로 수렴.
//
// 본 파일은 React DOM 없이 순수 함수/클래스 정적 메서드만 검증한다 — tsx --test 로 빠르게 돈다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapMediaExporterError,
  mapMediaLoaderError,
  mapMediaParseError,
  mapUnknownError,
  messageToToastInput,
  NETWORK_OFFLINE_MESSAGE,
  UNKNOWN_ERROR_MESSAGE,
} from '../src/utils/errorMessages.ts';
import {
  EMPTY_TOAST_STACK,
  toastStackReducer,
  type ToastItem,
  type ToastStackState,
} from '../src/components/ToastProvider.tsx';
import { deriveErrorState, ErrorBoundary } from '../src/components/ErrorBoundary.tsx';
import { sessionSignalToToast } from '../src/utils/claudeSubscriptionSession.ts';

// ---------------------------------------------------------------------------
// 1) errorMessages — 사용자 친화 메시지 매핑
// ---------------------------------------------------------------------------

test('errorMessages · 알려진 MediaLoader 코드는 한국어 제목+심각도로 매핑된다', () => {
  const unsupported = mapMediaLoaderError('UNSUPPORTED_KIND');
  assert.equal(unsupported.severity, 'warning');
  assert.match(unsupported.title, /지원하지 않는/);

  const exhausted = mapMediaLoaderError('SESSION_EXHAUSTED');
  assert.equal(exhausted.severity, 'warning');
  assert.equal(exhausted.action?.kind, 'open-settings', '세션 소진은 "설정 열기" 조치를 유도해야 한다');

  const aborted = mapMediaLoaderError('ABORTED');
  assert.equal(aborted.severity, 'info', '취소는 사용자 주도 행동이라 error 가 아니라 info');
});

test('errorMessages · MediaExporter 와 MediaParse 코드도 각각 독립 테이블로 매핑된다', () => {
  const validation = mapMediaExporterError('VALIDATION_FAILED');
  assert.equal(validation.severity, 'warning');

  const parseFailed = mapMediaParseError('MEDIA_PARSE_FAILED');
  assert.equal(parseFailed.severity, 'error');
  assert.match(parseFailed.title, /파일을 읽을 수 없어요/);

  // 미지 코드는 폴백 — 빈 화면이 아니라 명시적 "원인 미상" 메시지.
  const fallback = mapMediaLoaderError('ZERO_DAY_CODE' as unknown as string);
  assert.equal(fallback, UNKNOWN_ERROR_MESSAGE);
});

test('errorMessages · mapUnknownError 는 code/AbortError/네트워크 힌트를 해석한다', () => {
  // 1) code 속성이 MediaLoader 테이블에 있음 → 해당 메시지.
  const media = mapUnknownError({ code: 'FILE_TOO_LARGE', message: 'too big' });
  assert.equal(media.severity, 'warning');
  assert.match(media.title, /용량/);

  // 2) AbortError 는 "요청이 취소되었습니다" 로 수렴.
  const aborted = mapUnknownError({ name: 'AbortError' });
  assert.equal(aborted.severity, 'info');
  assert.match(aborted.title, /취소/);

  // 3) message 에 'network' 가 포함되면 네트워크 단절 안내.
  const offline = mapUnknownError(new Error('network unreachable'));
  assert.equal(offline.title, NETWORK_OFFLINE_MESSAGE.title);

  // 4) 완전 미지 → 폴백 + body 에 메시지.
  const unknown = mapUnknownError(new Error('뭔가 이상함'));
  assert.equal(unknown.severity, 'error');
  assert.equal(unknown.body, '뭔가 이상함');
});

test('errorMessages · messageToToastInput — severity=variant, action 핸들러 바인딩', () => {
  const retryCalls: number[] = [];
  const settingsCalls: number[] = [];
  const retry = mapMediaLoaderError('GENERATE_FAILED');
  const input = messageToToastInput(retry, {
    onRetryNow: () => retryCalls.push(Date.now()),
    onOpenSettings: () => settingsCalls.push(Date.now()),
  });
  assert.equal(input.variant, 'error');
  assert.equal(input.title, retry.title);
  assert.ok(input.action, '"다시 시도" 조치가 유지되어야 한다');
  input.action!.onClick();
  assert.equal(retryCalls.length, 1);
  assert.equal(settingsCalls.length, 0, 'retry-now 버튼은 onRetryNow 만 호출해야 한다');

  // action=없음 → ToastInput 에도 action 없음.
  const info = mapMediaLoaderError('ABORTED');
  const plain = messageToToastInput(info);
  assert.equal(plain.action, undefined);
});

// ---------------------------------------------------------------------------
// 2) toastStackReducer — 스택 불변 계약
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<ToastItem> = {}): ToastItem {
  return {
    id: 't1',
    variant: 'info',
    title: '알림',
    description: undefined,
    duration: 4000,
    action: undefined,
    createdAt: 1_000,
    ...overrides,
  };
}

test('toastStackReducer · PUSH 는 새 항목을 꼬리에 붙이고, 동일 id 는 병합(수명 리셋)', () => {
  const s0: ToastStackState = EMPTY_TOAST_STACK;
  const s1 = toastStackReducer(s0, { type: 'PUSH', item: makeItem({ id: 'a', createdAt: 1 }) });
  assert.equal(s1.items.length, 1);
  const s2 = toastStackReducer(s1, { type: 'PUSH', item: makeItem({ id: 'b', createdAt: 2 }) });
  assert.equal(s2.items.length, 2);
  assert.deepEqual(s2.items.map(i => i.id), ['a', 'b']);

  // 동일 id 재방출: 배열 길이는 그대로, 해당 위치의 createdAt 이 갱신된다.
  const s3 = toastStackReducer(s2, { type: 'PUSH', item: makeItem({ id: 'a', createdAt: 42, title: '재갱신' }) });
  assert.equal(s3.items.length, 2);
  const a = s3.items.find(i => i.id === 'a')!;
  assert.equal(a.createdAt, 42, '동일 id 는 수명/내용이 최신화되어야 한다');
  assert.equal(a.title, '재갱신');
});

test('toastStackReducer · DISMISS/CLEAR 는 불변이며 없는 id 재호출은 참조 동일성 유지', () => {
  const seed = toastStackReducer(EMPTY_TOAST_STACK, { type: 'PUSH', item: makeItem({ id: 'x' }) });
  const removed = toastStackReducer(seed, { type: 'DISMISS', id: 'x' });
  assert.equal(removed.items.length, 0);

  // 없는 id DISMISS → 참조 동일(리렌더 회피).
  const noop = toastStackReducer(seed, { type: 'DISMISS', id: 'missing' });
  assert.equal(noop, seed);

  // CLEAR 도 이미 빈 상태면 동일 참조.
  const noopClear = toastStackReducer(EMPTY_TOAST_STACK, { type: 'CLEAR' });
  assert.equal(noopClear, EMPTY_TOAST_STACK);

  const fullClear = toastStackReducer(seed, { type: 'CLEAR' });
  assert.equal(fullClear.items.length, 0);
});

// ---------------------------------------------------------------------------
// 3) ErrorBoundary.deriveErrorState + getDerivedStateFromError
// ---------------------------------------------------------------------------

test('ErrorBoundary · deriveErrorState 는 Error/string/객체를 모두 Error 로 수렴', () => {
  const fromError = deriveErrorState(new Error('터짐'));
  assert.ok(fromError.error instanceof Error);
  assert.equal(fromError.error!.message, '터짐');

  const fromString = deriveErrorState('문자열 예외');
  assert.ok(fromString.error instanceof Error);
  assert.equal(fromString.error!.message, '문자열 예외');

  const fromObject = deriveErrorState({ code: 'X', message: '객체 에러' });
  assert.ok(fromObject.error instanceof Error);
  assert.match(fromObject.error!.message, /X|객체 에러/);

  // React 가 부르는 정적 메서드도 동일 계약.
  const react = ErrorBoundary.getDerivedStateFromError(new Error('렌더 실패'));
  assert.ok(react.error instanceof Error);
  assert.equal(react.error!.message, '렌더 실패');
});

// ---------------------------------------------------------------------------
// 보너스 · sessionSignalToToast — 재시도 큐 길이에 따라 조치 버튼이 나타난다
// ---------------------------------------------------------------------------

test('sessionSignalToToast · 재시도 큐가 있으면 "N건 지금 재시도" 조치 버튼이 붙는다', () => {
  const withQueue = sessionSignalToToast({ signal: 'token_exhausted', queueLength: 3 });
  assert.equal(withQueue.action?.kind, 'retry-now');
  assert.match(withQueue.action!.label, /3건/);

  const empty = sessionSignalToToast({ signal: 'token_exhausted', queueLength: 0 });
  assert.equal(empty.action, undefined, '큐가 비면 조치 버튼을 감춰 조용한 배너로 수렴');

  const expired = sessionSignalToToast({ signal: 'subscription_expired', queueLength: 0 });
  assert.equal(expired.severity, 'error');
  assert.equal(expired.ariaLive, 'assertive', '구독 만료는 assertive 로 즉시 고지');
  assert.equal(expired.action?.kind, 'open-settings');
});
