// Run with: npx tsx --test tests/conversationSearchVirtualList.unit.test.ts
//
// 대화 검색 · 가상화 메시지 리스트 · 성능 회귀 단위 테스트(#832360c2).
//   1) 검색 매치 + 하이라이트 — 여러 메시지에서 대소문자 무시 매치 계약.
//   2) 매치 포커스 이동 + 단축키 판정 — 래핑 동작과 Ctrl/Cmd+F 판정.
//   3) 가상화 가시 범위 — 500+ 메시지에서도 렌더 노드 수가 일정 상한으로 고정.
//
// Node 환경 순수 함수만 검증한다. DOM 렌더 성능은 측정이 아니라 "가시 범위 크기" 로
// 상한을 잠가, long task 발생의 주요 원인(전체 렌더) 이 구조적으로 차단됨을 증명한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findRangesIn,
  findSearchMatches,
  moveMatchFocus,
  normalizeSearchQuery,
  splitHighlightSegments,
} from '../src/utils/conversationSearch.ts';
import {
  computeVisibleRange,
  indexOfMessage,
} from '../src/components/VirtualizedMessageList.tsx';
import { isOpenSearchShortcut } from '../src/components/ConversationSearch.tsx';

// ---------------------------------------------------------------------------
// 1) 검색 매치 + 하이라이트 세그먼트
// ---------------------------------------------------------------------------

test('findSearchMatches + splitHighlightSegments — 대소문자 무시 매치와 세그먼트 분할', () => {
  // 빈/공백 쿼리는 무시.
  assert.equal(normalizeSearchQuery('   '), null);
  assert.equal(normalizeSearchQuery(null), null);
  assert.deepEqual(findSearchMatches([{ id: 'a', text: '안녕하세요' }], ''), []);
  assert.deepEqual(findSearchMatches([{ id: 'a', text: '안녕' }], null), []);

  // 대소문자 무시 + 첨부 요약까지 검색 대상.
  const messages = [
    { id: 'm1', text: 'Hello world, Node 테스트 로그' },
    { id: 'm2', text: '다른 내용', attachmentSummary: 'report.pdf · 5페이지' },
    { id: 'm3', text: '매치 없음' },
  ];
  const results = findSearchMatches(messages, 'NODE');
  assert.equal(results.length, 1, 'NODE 는 m1 에서만 매치');
  assert.equal(results[0].messageId, 'm1');
  assert.equal(results[0].ranges.length, 1);

  const pdfResults = findSearchMatches(messages, 'report');
  assert.equal(pdfResults.length, 1);
  assert.equal(pdfResults[0].messageId, 'm2', '첨부 요약도 검색 대상이 되어야 한다');

  // findRangesIn 의 중첩 방지.
  assert.deepEqual(findRangesIn('aaaa', 'aa'), [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ]);

  // splitHighlightSegments — 매치 세그먼트 사이에 원본 텍스트가 유지.
  const segs = splitHighlightSegments('Hello hello HELLO', [
    { start: 0, end: 5 },
    { start: 6, end: 11 },
    { start: 12, end: 17 },
  ]);
  // 매치 3개 + 사이 공백 2개 = 5 세그먼트.
  assert.equal(segs.length, 5);
  assert.equal(segs.filter(s => s.kind === 'match').length, 3);
  assert.equal(segs[0].text, 'Hello');
  assert.equal(segs[1].text, ' ');
  assert.equal(segs[2].text, 'hello');

  // ranges 가 비어 있으면 원문 한 덩어리.
  assert.deepEqual(splitHighlightSegments('abc', []), [{ kind: 'other', text: 'abc' }]);
  // 빈 텍스트는 빈 배열.
  assert.deepEqual(splitHighlightSegments('', [{ start: 0, end: 0 }]), []);
});

// ---------------------------------------------------------------------------
// 2) 매치 이동 + Ctrl/Cmd+F 단축키
// ---------------------------------------------------------------------------

test('moveMatchFocus + isOpenSearchShortcut — 래핑 이동과 단축키 판정', () => {
  // 빈 결과 → -1.
  assert.equal(moveMatchFocus({ current: 0, total: 0, direction: 'next' }), -1);

  // next 끝에서는 0 으로 래핑, prev 처음에서는 last 로 래핑.
  assert.equal(moveMatchFocus({ current: 0, total: 3, direction: 'next' }), 1);
  assert.equal(moveMatchFocus({ current: 2, total: 3, direction: 'next' }), 0);
  assert.equal(moveMatchFocus({ current: 0, total: 3, direction: 'prev' }), 2);
  assert.equal(moveMatchFocus({ current: 1, total: 3, direction: 'prev' }), 0);

  // 비정상 current 는 안전화.
  assert.equal(moveMatchFocus({ current: -9, total: 3, direction: 'next' }), 1);
  assert.equal(moveMatchFocus({ current: Number.NaN, total: 3, direction: 'next' }), 1);

  // 단축키 — Ctrl+F 또는 Cmd+F 이면 열어야 한다.
  assert.equal(isOpenSearchShortcut({ key: 'f', ctrlKey: true, metaKey: false }), true);
  assert.equal(isOpenSearchShortcut({ key: 'F', ctrlKey: false, metaKey: true }), true);
  assert.equal(isOpenSearchShortcut({ key: 'f', ctrlKey: false, metaKey: false }), false,
    '메타/컨트롤 없이 f 는 본문 입력이라 열면 안 된다');
  assert.equal(isOpenSearchShortcut({ key: 'g', ctrlKey: true, metaKey: false }), false);
});

// ---------------------------------------------------------------------------
// 3) 가상화 — 500+ 메시지에서도 가시 범위가 상수 상한으로 고정
// ---------------------------------------------------------------------------

test('computeVisibleRange — 500개 메시지에서도 렌더 노드 수가 일정 상한 이하', () => {
  const total = 500;
  const itemHeight = 44;
  const viewportHeight = 600; // ~14 rows visible

  // 스크롤 위치 0: 처음부터 + overscan 만큼.
  const top = computeVisibleRange({ scrollTop: 0, viewportHeight, itemHeight, total, overscan: 6 });
  assert.equal(top.startIndex, 0);
  // 14 visible + 6 overscan 이하가 돼야 한다(대충 20 내외). 절대 500 전체를 렌더하지 않는다.
  const renderedTop = top.endIndex - top.startIndex + 1;
  assert.ok(renderedTop <= 30, `가시 범위가 ${renderedTop} — 30 이하로 상한돼야 long task 위험이 없다`);

  // 중간 스크롤.
  const mid = computeVisibleRange({ scrollTop: 220 * itemHeight, viewportHeight, itemHeight, total, overscan: 6 });
  const renderedMid = mid.endIndex - mid.startIndex + 1;
  assert.ok(renderedMid <= 30);
  assert.ok(mid.startIndex > 200 && mid.endIndex <= 240,
    `스크롤 중앙에서 startIndex/endIndex 가 기대 범위(200~240)에 있어야 한다 — 실제 ${mid.startIndex}/${mid.endIndex}`);

  // 끝.
  const bottom = computeVisibleRange({ scrollTop: total * itemHeight, viewportHeight, itemHeight, total, overscan: 6 });
  assert.equal(bottom.endIndex, total - 1);

  // 비정상 입력 — 안전 폴백.
  assert.deepEqual(
    computeVisibleRange({ scrollTop: 0, viewportHeight: 0, itemHeight: 40, total: 10 }),
    { startIndex: 0, endIndex: -1 },
    'viewportHeight=0 은 렌더 대상이 없음으로 수렴',
  );
  assert.deepEqual(
    computeVisibleRange({ scrollTop: 0, viewportHeight: 600, itemHeight: 0, total: 10 }),
    { startIndex: 0, endIndex: -1 },
  );

  // indexOfMessage — 검색 점프에 쓰이는 유틸.
  const items = Array.from({ length: 500 }, (_, i) => ({ id: `m-${i}` }));
  assert.equal(indexOfMessage(items, 'm-250'), 250);
  assert.equal(indexOfMessage(items, 'missing'), -1);
});
