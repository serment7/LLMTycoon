// 대화 영역 검색 유틸(#832360c2) — 순수 함수 집합.
//
// 책임
//   1) 메시지 본문과 첨부 요약을 합쳐 검색어 매치를 찾고 위치(start/end)를 돌려준다.
//   2) 하이라이트 렌더용 세그먼트를 잘라 준다(UI 가 그대로 매핑).
//   3) 대소문자·한국어 공백 변형·공란 입력에 대한 폴백 계약을 잠근다.
//
// React/DOM 접근이 없으므로 Node 에서 직접 테스트된다.

/** 검색 대상이 되는 메시지 레코드의 최소 모양. 상위가 자유롭게 확장해 전달. */
export interface SearchableMessage {
  id: string;
  /** 본문 텍스트. 빈 문자열 허용. */
  text: string;
  /** 첨부 요약(파일명·추출 본문 스니펫 등) — 본문과 함께 매치 대상이 된다. */
  attachmentSummary?: string;
}

/** 한 메시지에서 발견된 매치 위치. start/end 는 결합 문자열의 인덱스. */
export interface MessageMatch {
  messageId: string;
  /** 본문+첨부 요약을 이어 붙인 검색 기준 문자열. UI 가 그대로 하이라이트에 쓴다. */
  haystack: string;
  /** [start, end) 범위 배열. start 오름차순 정렬. */
  ranges: ReadonlyArray<{ start: number; end: number }>;
}

/** 하이라이트 렌더를 위한 세그먼트. `kind='match'` 는 강조, `other` 는 일반. */
export interface HighlightSegment {
  kind: 'match' | 'other';
  text: string;
}

/** 검색어 정규화 — trim + 소문자. 빈 문자열이면 null. */
export function normalizeSearchQuery(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

/** 단일 문자열에서 query 가 발견된 모든 위치를 돌려준다. 대소문자 무시. */
export function findRangesIn(text: string, query: string): ReadonlyArray<{ start: number; end: number }> {
  if (!text || !query) return [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerQuery.length === 0) return [];
  const out: { start: number; end: number }[] = [];
  let idx = 0;
  while (idx < lowerText.length) {
    const found = lowerText.indexOf(lowerQuery, idx);
    if (found === -1) break;
    out.push({ start: found, end: found + lowerQuery.length });
    // 최소 전진 1 — 빈 query 재귀 회피. query.length 만큼 건너뛰어 겹치지 않게.
    idx = found + lowerQuery.length;
  }
  return out;
}

/**
 * 여러 메시지에서 검색어 매치를 찾는다. 매치가 없는 메시지는 결과에서 제외한다.
 * haystack 은 "본문 + '\n' + 첨부 요약(있으면)" 형태로 결합된다.
 */
export function findSearchMatches(
  messages: ReadonlyArray<SearchableMessage>,
  rawQuery: string | null | undefined,
): ReadonlyArray<MessageMatch> {
  const query = normalizeSearchQuery(rawQuery);
  if (!query) return [];
  const out: MessageMatch[] = [];
  for (const m of messages) {
    const haystack = m.attachmentSummary
      ? `${m.text}\n${m.attachmentSummary}`
      : m.text;
    const ranges = findRangesIn(haystack, query);
    if (ranges.length === 0) continue;
    out.push({ messageId: m.id, haystack, ranges });
  }
  return out;
}

/**
 * 단일 텍스트를 하이라이트 세그먼트로 분할한다. ranges 는 start 오름차순이며 서로
 * 겹치지 않는다고 가정한다. 빈 텍스트/빈 ranges 는 원본 한 덩어리로 돌려준다.
 */
export function splitHighlightSegments(
  text: string,
  ranges: ReadonlyArray<{ start: number; end: number }>,
): ReadonlyArray<HighlightSegment> {
  if (!text) return [];
  if (!ranges || ranges.length === 0) return [{ kind: 'other', text }];
  const out: HighlightSegment[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start < cursor || r.end < r.start || r.end > text.length) continue;
    if (r.start > cursor) out.push({ kind: 'other', text: text.slice(cursor, r.start) });
    if (r.end > r.start) out.push({ kind: 'match', text: text.slice(r.start, r.end) });
    cursor = r.end;
  }
  if (cursor < text.length) out.push({ kind: 'other', text: text.slice(cursor) });
  return out;
}

/**
 * 현재 매치 포커스 인덱스를 앞/뒤로 이동한다. 빈 결과면 -1, 끝에서 이동하면 래핑.
 *   direction='next' — 끝이면 0 으로 래핑
 *   direction='prev' — 처음이면 last 로 래핑
 */
export function moveMatchFocus(params: {
  current: number;
  total: number;
  direction: 'next' | 'prev';
}): number {
  if (params.total <= 0) return -1;
  const last = params.total - 1;
  const safe = Math.max(0, Math.min(last, Number.isFinite(params.current) ? params.current : 0));
  if (params.direction === 'next') return safe >= last ? 0 : safe + 1;
  return safe <= 0 ? last : safe - 1;
}
