import React, { useEffect, useMemo, useRef, useState } from 'react';

// 개발자 노트: 쿼리 URL 공유.
// 팀원이 "이 조건에서 일치 없음"이라 리포트할 때 그대로 재현할 수 있도록
// 해시 프래그먼트에 인코딩한다. 해시는 서버 액세스 로그에 남지 않아 민감한 키워드가
// 트래픽 로그로 유출되지 않는다(쿼리스트링 대신 해시를 고른 이유).
const QUERY_HASH_KEY = 'logq';

export function encodeQueryToHash(query: string): string {
  if (!query) return '';
  return `#${QUERY_HASH_KEY}=${encodeURIComponent(query)}`;
}

export function decodeQueryFromHash(hash: string): string | undefined {
  if (!hash) return undefined;
  const clean = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const pair of clean.split('&')) {
    const [k, v] = pair.split('=');
    if (k === QUERY_HASH_KEY && v !== undefined) {
      try { return decodeURIComponent(v); } catch { return undefined; }
    }
  }
  return undefined;
}

// 개발자 노트: 쿼리 히스토리 링버퍼.
// 세션 간 유지(localStorage)하되 상한을 둬 스토리지 폭주를 막는다.
// SSR/권한 거부(Safari 프라이빗 모드) 대비로 모든 접근을 try/catch로 소프트 페일 처리.
const HISTORY_KEY = 'llmtycoon.logfilter.history.v1';
const HISTORY_LIMIT = 20;
// 외부 공개용 별칭 — 테스트/스토리북이 상한을 참조할 때 private 상수에 의존하지 않도록 한다.
export const QUERY_HISTORY_MAX = HISTORY_LIMIT;

export function loadQueryHistory(): string[] {
  try {
    if (typeof window === 'undefined') return [];
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((v): v is string => typeof v === 'string').slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function pushQueryHistory(prev: string[], next: string): string[] {
  const trimmed = next.trim();
  if (!trimmed) return prev;
  const deduped = [trimmed, ...prev.filter(q => q !== trimmed)].slice(0, HISTORY_LIMIT);
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(deduped));
    }
  } catch {
    // 스토리지 실패는 히스토리 기능의 소프트 페일 — 본 검색 흐름을 막지 않는다.
  }
  return deduped;
}

export type LogEntry = {
  id: string;
  from: string;
  to?: string;
  text: string;
  time: string;
};

export type LogFilterStats = {
  total: number;
  shown: number;
  uniqueSenders: number;
  topSender?: { name: string; count: number };
  windowMinutes?: number;
  // 연구원 확장: 분석용 파생 지표.
  avgTextLength?: number;
  senderDistribution?: Array<{ name: string; count: number; share: number }>;
  // 품질 관리 확장: 데이터 정합성 지표.
  invalidCount?: number;
  emptyTextCount?: number;
  // 품질 관리 v2: 상류 파이프라인 결함을 조기에 탐지하기 위한 보조 카운터.
  duplicateIdCount?: number;
  oversizedTextCount?: number;
  futureTimestampCount?: number;
};

// 품질 관리 노트: 단일 로그 본문이 이 길이를 넘기면 UI 렌더 비용·메모리 압박이 급증하고
// 보통은 상류 직렬화 버그(스택 트레이스 무한 루프 등)의 신호이므로 별도 카운트.
export const MAX_TEXT_LENGTH = 4096;

// 품질 관리 노트: 외부에서 유입된 로그는 신뢰할 수 없다.
// 런타임에서 최소 스키마를 검사해 파이프라인 하류의 NPE/오염을 선제적으로 차단한다.
export function validateLogEntry(entry: unknown): entry is LogEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Partial<LogEntry>;
  if (typeof e.id !== 'string' || e.id.length === 0) return false;
  if (typeof e.from !== 'string' || e.from.length === 0) return false;
  if (typeof e.text !== 'string') return false;
  if (typeof e.time !== 'string') return false;
  if (e.to !== undefined && typeof e.to !== 'string') return false;
  return true;
}

// 품질 관리 노트: "왜 탈락했는가"를 알려주는 상세 분류.
// validateLogEntry 는 boolean 만 돌려주어 디버깅 시 재현이 어렵다.
// 거부 이유를 열거해 상류 팀이 제보 없이도 원인을 좁힐 수 있게 한다.
// 정상 레코드는 { ok: true } 로 단일 형태를 유지해 호출 측 분기를 단순화한다.
export type LogEntryDiagnosis =
  | { ok: true }
  | { ok: false; reason: LogEntryRejectReason; field?: keyof LogEntry; detail?: string };

export type LogEntryRejectReason =
  | 'notObject'
  | 'missingId'
  | 'missingFrom'
  | 'textNotString'
  | 'timeNotString'
  | 'toWrongType';

export function classifyLogEntry(entry: unknown): LogEntryDiagnosis {
  if (!entry || typeof entry !== 'object') {
    return { ok: false, reason: 'notObject', detail: `typeof=${typeof entry}` };
  }
  const e = entry as Partial<LogEntry>;
  if (typeof e.id !== 'string' || e.id.length === 0) {
    return { ok: false, reason: 'missingId', field: 'id' };
  }
  if (typeof e.from !== 'string' || e.from.length === 0) {
    return { ok: false, reason: 'missingFrom', field: 'from' };
  }
  if (typeof e.text !== 'string') {
    return { ok: false, reason: 'textNotString', field: 'text', detail: `typeof=${typeof e.text}` };
  }
  if (typeof e.time !== 'string') {
    return { ok: false, reason: 'timeNotString', field: 'time', detail: `typeof=${typeof e.time}` };
  }
  if (e.to !== undefined && typeof e.to !== 'string') {
    return { ok: false, reason: 'toWrongType', field: 'to', detail: `typeof=${typeof e.to}` };
  }
  return { ok: true };
}

// 품질 관리 노트: 거절 사유별 빈도를 집계.
// computeIntegrity 가 "몇 건 깨졌나" 만 알려준다면, 이 함수는 "어떤 스키마 결함이 우세한가"를 드러낸다.
// 상류 팀에 구체적 수정 지점을 제공하기 위한 보조 도구.
export function rejectReasonHistogram(logs: unknown[]): Record<LogEntryRejectReason, number> {
  const out: Record<LogEntryRejectReason, number> = {
    notObject: 0,
    missingId: 0,
    missingFrom: 0,
    textNotString: 0,
    timeNotString: 0,
    toWrongType: 0,
  };
  for (const l of logs) {
    const d = classifyLogEntry(l);
    if (d.ok === false) out[d.reason]++;
  }
  return out;
}

// 디자이너 노트: 정보 밀도 프리셋.
//   compact  — 사이드바/좁은 레일에서 사용. 여백과 폰트를 최소화.
//   cozy     — 기본값. 일반 패널에서 가독성과 밀도의 균형.
//   spacious — 접근성 우선(큰 글자/넓은 히트 영역). 프레젠테이션 모드에도 적합.
export type LogFilterDensity = 'compact' | 'cozy' | 'spacious';

type Props = {
  logs: LogEntry[];
  query: string;
  onQueryChange: (q: string) => void;
  onStatsChange?: (stats: LogFilterStats) => void;
  density?: LogFilterDensity;
  // 디자이너 노트: 치트시트는 기본 숨김. 처음 사용자는 ?로 펼쳐볼 수 있게 한다.
  showCheatsheet?: boolean;
};

// 디자이너 노트: 빠른 적용 프리셋.
// 빈 입력 상태에서 가장 자주 쓰는 쿼리를 한 번의 클릭으로 적용하게 해
// 신규 사용자가 "무엇을 칠 수 있는지" 학습하는 진입 비용을 낮춘다.
// 치트시트가 "문법 학습"이라면, 프리셋은 "즉시 사용"의 역할.
export const QUERY_PRESETS: Array<{ label: string; query: string; hint: string }> = [
  { label: '최근 5분', query: 'since:5m', hint: '최근 5분 이내 로그' },
  { label: '오류만', query: '/error|에러|실패/', hint: '오류 키워드 정규식' },
  { label: '에러 제외', query: '-error -에러', hint: '소음 제거' },
  // 디자이너 노트: "오늘" 프리셋은 회고/스탠드업 맥락에서 가장 많이 찍히는 쿼리.
  { label: '오늘', query: 'since:1d', hint: '최근 24시간' },
];

// 디자이너 노트: 최근 사용 쿼리 상한.
// 3개면 스탠드업/회고 루틴을 돌아가며 쓰기에 충분하고,
// 프리셋(4개)과 한 줄에 놓여도 가로로 붐비지 않는다.
export const RECENT_QUERY_LIMIT = 3;

// 디자이너 노트: "커밋된 쿼리"로 간주할 타이핑 정지 시간.
// 너무 짧으면 오타까지 히스토리에 들어가고, 너무 길면 기억 가치가 희석된다.
// 결과를 눈으로 훑는 시간대에 맞춰 1.2초로 잡았다.
export const RECENT_COMMIT_DEBOUNCE_MS = 1200;

// 디자이너 노트: 플랫폼별 수정자 키 라벨.
// Mac은 ⌘, 그 외는 Ctrl. SSR/비브라우저 환경에서는 Ctrl로 안전 폴백.
// 다른 패널에서도 같은 표기를 공유하도록 헬퍼로 분리.
export function modKeyLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  const plat = (navigator.platform || '') + ' ' + (navigator.userAgent || '');
  return /Mac|iPhone|iPad/i.test(plat) ? '⌘' : 'Ctrl';
}

// 디자이너 노트: 최근 쿼리에 새 항목을 끼워 넣는 순수 함수.
// 이미 있는 쿼리는 맨 앞으로 끌어올리고(재사용 선호), 상한을 넘는 오래된 항목은 떨어진다.
// 컴포넌트 바깥에 두어 테스트/다른 패널에서 동일 규칙을 재사용한다.
export function pushRecentQuery(
  recent: string[],
  next: string,
  limit = RECENT_QUERY_LIMIT
): string[] {
  const trimmed = next.trim();
  if (!trimmed) return recent;
  const without = recent.filter(q => q !== trimmed);
  return [trimmed, ...without].slice(0, limit);
}

// 디자이너 노트: 밀도별 디자인 토큰.
// 한 곳에 모아두어 클래스 문자열이 JSX에서 흩어지는 걸 막고,
// 추후 다크/라이트 테마 분리 시 토큰 교체만으로 일괄 조정 가능하게 한다.
// kbd 토큰은 단축키 배지(⌘K 등)에 사용 — chip 대비 한 단계 작은 폰트로
// "보조 정보"라는 시각 위계를 부여한다.
const DENSITY_TOKENS: Record<
  LogFilterDensity,
  {
    input: string;
    chip: string;
    stats: string;
    gap: string;
    kbd: string;
  }
> = {
  compact: {
    input: 'px-1.5 py-0.5 pr-5 text-[10px]',
    chip: 'px-1.5 py-0 text-[9px]',
    stats: 'text-[9px] gap-x-1.5',
    gap: 'gap-1',
    kbd: 'px-1 py-0 text-[8px]',
  },
  cozy: {
    input: 'px-2 py-1 pr-6 text-[11px]',
    chip: 'px-2 py-0.5 text-[10px]',
    stats: 'text-[10px] gap-x-2',
    gap: 'gap-2',
    kbd: 'px-1 py-0 text-[9px]',
  },
  spacious: {
    input: 'px-3 py-1.5 pr-7 text-[12px]',
    chip: 'px-2.5 py-1 text-[11px]',
    stats: 'text-[11px] gap-x-3',
    gap: 'gap-3',
    kbd: 'px-1.5 py-0.5 text-[10px]',
  },
};

// 디자이너 노트: 밀도 라벨 맵.
// 설정 패널/툴팁/접근성 라벨에서 공유할 사람이 읽는 이름을 한 곳에 모은다.
// 짧은 라벨은 토글 칩에, 설명은 aria-label과 툴팁 본문에 쓰도록 분리.
export const DENSITY_LABELS: Record<
  LogFilterDensity,
  { short: string; description: string }
> = {
  compact: { short: '조밀', description: '좁은 패널용 — 여백과 폰트를 최소화' },
  cozy: { short: '기본', description: '기본값 — 가독성과 밀도의 균형' },
  spacious: { short: '여유', description: '접근성 우선 — 큰 글자와 넓은 히트 영역' },
};

// 디자이너 노트: 밀도 토큰 안전 접근자.
// 외부에서 전달한 density가 타입에서 벗어나도 UI가 빈 클래스로 무너지지 않도록
// cozy로 폴백한다. 테스트/스토리북이 private 상수에 의존하지 않게 하는 창구 역할.
export function getDensityTokens(
  density: LogFilterDensity | undefined
): (typeof DENSITY_TOKENS)[LogFilterDensity] {
  if (density && density in DENSITY_TOKENS) return DENSITY_TOKENS[density];
  return DENSITY_TOKENS.cozy;
}

// 디자이너 노트: 밀도 토글용 순환 함수.
// 단일 버튼으로 세 단계를 돌릴 때 사용. compact → cozy → spacious → compact 순.
// 순서는 "좁게 → 넓게" 방향으로 단조 증가시켜 사용자가 다음 상태를 예측하기 쉽게 한다.
export function nextDensity(current: LogFilterDensity): LogFilterDensity {
  if (current === 'compact') return 'cozy';
  if (current === 'cozy') return 'spacious';
  return 'compact';
}

export type ParsedQuery = {
  terms: string[];
  phrases: string[];
  excludeTerms: string[];
  regexes: RegExp[];
  excludeRegexes: RegExp[];
  from?: string;
  to?: string;
  excludeFrom?: string;
  excludeTo?: string;
  sinceMinutes?: number;
};

// 잘못된 정규식은 무음 폐기. 사용자가 타이핑 중일 수 있으므로 throw하지 않는다.
function safeCompileRegex(body: string): RegExp | undefined {
  try {
    return new RegExp(body, 'i');
  } catch {
    return undefined;
  }
}

// 연구원 노트: 쿼리 문법 v2.
//   "from:alpha 버그"      => from=alpha, terms=["버그"]
//   "to:researcher"        => to=researcher
//   "-from:noise"          => excludeFrom=noise
//   "-error"               => excludeTerms=["error"]
//   '"세션 종료"'           => phrases=["세션 종료"] (큰따옴표로 감싼 정확 일치)
//   "since:15m"            => 최근 15분 이내 로그만
// 모든 조건은 AND로 결합되며 텍스트 토큰은 from/to/text 중 하나에만 매치되어도 통과한다.
function tokenize(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== undefined) out.push(`"${m[1]}"`);
    else if (m[2] !== undefined) out.push(m[2]);
  }
  return out;
}

// 품질 관리 노트: 상한(7일)을 둬 악의적/실수 입력으로 메모리·렌더링이 폭주하지 않게 한다.
const MAX_SINCE_MINUTES = 7 * 24 * 60;

function parseSinceToMinutes(value: string): number | undefined {
  const m = /^(\d+)([smhd]?)$/.exec(value);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  let minutes: number;
  switch (m[2]) {
    case 's': minutes = n / 60; break;
    case 'h': minutes = n * 60; break;
    case 'd': minutes = n * 60 * 24; break;
    default: minutes = n; // 'm' or empty
  }
  return Math.min(minutes, MAX_SINCE_MINUTES);
}

export function parseQuery(raw: string): ParsedQuery {
  const tokens = tokenize(raw.trim());
  const result: ParsedQuery = {
    terms: [],
    phrases: [],
    excludeTerms: [],
    regexes: [],
    excludeRegexes: [],
  };
  for (const tokRaw of tokens) {
    const negated = tokRaw.startsWith('-');
    const tok = negated ? tokRaw.slice(1) : tokRaw;
    if (!tok) continue;
    const lower = tok.toLowerCase();
    if (lower.startsWith('from:') && lower.length > 5) {
      if (negated) result.excludeFrom = lower.slice(5);
      else result.from = lower.slice(5);
    } else if (lower.startsWith('to:') && lower.length > 3) {
      if (negated) result.excludeTo = lower.slice(3);
      else result.to = lower.slice(3);
    } else if (lower.startsWith('since:') && lower.length > 6) {
      const mins = parseSinceToMinutes(lower.slice(6));
      if (mins !== undefined) result.sinceMinutes = mins;
    } else if (tok.startsWith('/') && tok.endsWith('/') && tok.length >= 3) {
      const re = safeCompileRegex(tok.slice(1, -1));
      if (re) (negated ? result.excludeRegexes : result.regexes).push(re);
    } else if (tok.startsWith('"') && tok.endsWith('"') && tok.length >= 2) {
      const phrase = tok.slice(1, -1).toLowerCase();
      if (phrase) (negated ? result.excludeTerms : result.phrases).push(phrase);
    } else if (negated) {
      result.excludeTerms.push(lower);
    } else {
      result.terms.push(lower);
    }
  }
  return result;
}

// 연구원 노트: 시간 비교는 "HH:MM" 또는 ISO 문자열 모두 허용한다.
// 둘 다 같은 기준일에 정렬된 분 단위 값으로 환산해 비교한다.
function logMinuteOfDay(time: string): number | undefined {
  if (!time) return undefined;
  const hhmm = /^(\d{1,2}):(\d{2})/.exec(time);
  if (hhmm) return Number(hhmm[1]) * 60 + Number(hhmm[2]);
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.getHours() * 60 + d.getMinutes();
}

function nowMinuteOfDay(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

export function matches(log: LogEntry, parsed: ParsedQuery, nowMin = nowMinuteOfDay()): boolean {
  const fromLc = log.from.toLowerCase();
  const toLc = (log.to ?? '').toLowerCase();
  if (parsed.from && !fromLc.includes(parsed.from)) return false;
  if (parsed.to && !toLc.includes(parsed.to)) return false;
  if (parsed.excludeFrom && fromLc.includes(parsed.excludeFrom)) return false;
  if (parsed.excludeTo && toLc.includes(parsed.excludeTo)) return false;

  const haystack = `${log.from} ${log.to ?? ''} ${log.text}`.toLowerCase();

  for (const t of parsed.terms) if (!haystack.includes(t)) return false;
  for (const p of parsed.phrases) if (!haystack.includes(p)) return false;
  for (const ex of parsed.excludeTerms) if (haystack.includes(ex)) return false;
  for (const re of parsed.regexes) if (!re.test(haystack)) return false;
  for (const re of parsed.excludeRegexes) if (re.test(haystack)) return false;

  if (parsed.sinceMinutes !== undefined) {
    const lm = logMinuteOfDay(log.time);
    if (lm === undefined) return false;
    // 자정 경계를 단순 처리: 음수 차이는 24h 더해서 환산.
    let diff = nowMin - lm;
    if (diff < 0) diff += 24 * 60;
    if (diff > parsed.sinceMinutes) return false;
  }

  return true;
}

function computeTopSender(logs: LogEntry[]): { name: string; count: number } | undefined {
  if (logs.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const l of logs) counts.set(l.from, (counts.get(l.from) ?? 0) + 1);
  let best: { name: string; count: number } | undefined;
  for (const [name, count] of counts) {
    if (!best || count > best.count) best = { name, count };
  }
  return best;
}

// 연구원 노트: 발화량 분포를 점유율과 함께 반환. 상위 N명만 끊어 보고 싶을 때는 limit 지정.
export function computeSenderDistribution(
  logs: LogEntry[],
  limit = 5
): Array<{ name: string; count: number; share: number }> {
  if (logs.length === 0) return [];
  const counts = new Map<string, number>();
  for (const l of logs) counts.set(l.from, (counts.get(l.from) ?? 0) + 1);
  const total = logs.length;
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count, share: count / total }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// 연구원 노트: 평균 메시지 길이는 "요약 vs 상세" 같은 발화 스타일 분석에 유용.
export function computeAvgTextLength(logs: LogEntry[]): number | undefined {
  if (logs.length === 0) return undefined;
  let sum = 0;
  for (const l of logs) sum += l.text.length;
  return Math.round(sum / logs.length);
}

// 연구원 노트: 송-수신자 엣지 카운트.
// 누가 누구에게 얼마나 자주 말을 거는지 랭킹해, 협업 패턴·병목·고립된 에이전트를
// 한눈에 판별한다. to가 비어 있는 브로드캐스트는 "*" 버킷으로 수렴시켜 잃지 않는다.
export function computeInteractionPairs(
  logs: LogEntry[],
  limit = 5
): Array<{ from: string; to: string; count: number; share: number }> {
  if (logs.length === 0) return [];
  const counts = new Map<string, { from: string; to: string; count: number }>();
  for (const l of logs) {
    const to = l.to && l.to.length > 0 ? l.to : '*';
    const key = `${l.from}\u2192${to}`;
    const prev = counts.get(key);
    if (prev) prev.count++;
    else counts.set(key, { from: l.from, to, count: 1 });
  }
  const total = logs.length;
  return Array.from(counts.values())
    .map(p => ({ ...p, share: p.count / total }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// 연구원 노트: 시간 버킷 히스토그램.
// 쿼리 결과를 N분 단위 버킷으로 나누어 스파이크/침묵 구간을 탐지한다.
// bucketStart는 "현재로부터 몇 분 전"을 의미 — 0 버킷이 가장 최근.
// 기준 시각은 호출 측이 주입해 테스트에서 결정론적으로 재현 가능하게 한다.
export function computeTimeHistogram(
  logs: LogEntry[],
  bucketMinutes = 5,
  nowMin = nowMinuteOfDay()
): Array<{ bucketStart: number; count: number }> {
  if (logs.length === 0 || bucketMinutes <= 0) return [];
  const buckets = new Map<number, number>();
  for (const l of logs) {
    const lm = logMinuteOfDay(l.time);
    if (lm === undefined) continue;
    let diff = nowMin - lm;
    if (diff < 0) diff += 24 * 60;
    const bucket = Math.floor(diff / bucketMinutes) * bucketMinutes;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  return Array.from(buckets.entries())
    .map(([bucketStart, count]) => ({ bucketStart, count }))
    .sort((a, b) => a.bucketStart - b.bucketStart);
}

// 연구원 노트: 버스트니스 지수 = max(bucket) / avg(bucket).
// 1에 가까우면 고른 발화, 값이 크면 특정 시간대에 쏠림.
// 버킷이 1개 이하면 undefined — 단일 샘플에서는 지수가 의미 없다.
export function computeBurstiness(
  histogram: Array<{ bucketStart: number; count: number }>
): number | undefined {
  if (histogram.length < 2) return undefined;
  let sum = 0;
  let max = 0;
  for (const h of histogram) {
    sum += h.count;
    if (h.count > max) max = h.count;
  }
  if (sum === 0) return undefined;
  const avg = sum / histogram.length;
  return Number((max / avg).toFixed(2));
}

// 연구원 노트: 침묵 구간(silence gap) 분석.
// 버스트니스가 "쏠림의 강도"를 보여준다면, 이 함수는 "침묵의 모양"을 드러낸다.
// 연속된 로그 사이의 분 단위 간격을 뽑아 최장/중앙값/평균을 함께 반환한다.
//   - longest: 가장 길었던 공백 (응답 지연·세션 단절 후보)
//   - median:  정전 구간 대비 평소 호흡을 대표하는 중앙값(평균보다 이상치에 강건)
//   - mean:    비교 기준용 산술 평균
// 시간 비교는 logMinuteOfDay 로 환산하고, 자정 경계에서 음수가 되면 24h 더해 순환 처리.
// 유효한 시각이 2개 미만이면 undefined — 샘플이 부족한 상태에서 평균/중앙값은 오해를 부른다.
export function computeSilenceGaps(logs: LogEntry[]): {
  longest: number;
  median: number;
  mean: number;
  samples: number;
} | undefined {
  if (logs.length < 2) return undefined;
  const minutes: number[] = [];
  for (const l of logs) {
    const m = logMinuteOfDay(l.time);
    if (m !== undefined) minutes.push(m);
  }
  if (minutes.length < 2) return undefined;
  minutes.sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < minutes.length; i++) {
    let diff = minutes[i] - minutes[i - 1];
    if (diff < 0) diff += 24 * 60;
    gaps.push(diff);
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  return {
    longest: sorted[sorted.length - 1],
    median: Number(median.toFixed(2)),
    mean: Number(mean.toFixed(2)),
    samples: gaps.length,
  };
}

// 연구원 노트: 응답 지연(reply latency) 프로파일.
// computeSilenceGaps 가 "전체 정전 구간"을 본다면, 이 함수는 "지목받은 뒤 대꾸까지의 시간"에 집중한다.
// A→B 메시지 뒤 처음 나오는 B→* 메시지까지의 분 단위 간격을 에이전트별로 누적해
// 평균/중앙값/p90·샘플 수를 함께 돌려준다. 느린 응답자·체감 병목을 객관화하기 위한 지표.
//
// 설계 결정:
//  - 연속 동일 발화자(예: A의 멀티 라인 독백)는 한 번의 "지목"으로 취급해 이중 카운트를 피한다.
//  - 브로드캐스트(to 미지정)는 특정 응답자를 기대할 수 없으므로 지연 측정 대상에서 제외.
//  - 자정 경계는 gap 계산과 동일하게 음수면 24h 더해 순환 처리.
//  - 샘플이 1개뿐인 응답자도 그대로 노출 — 연구원이 "새로 합류한 에이전트"를 식별할 단서가 된다.
//  - p90 은 정렬 후 ceil(0.9 × n) - 1 위치(0-indexed)로, 샘플이 적어도 최댓값으로 자연 수렴한다.
export function computeReplyLatencies(
  logs: LogEntry[],
  limit = 5
): Array<{ responder: string; mean: number; median: number; p90: number; samples: number }> {
  if (logs.length < 2) return [];
  // 시간 정렬 사본을 만들어 원본 logs 순서에 의존하지 않는다.
  const ordered = logs
    .map(l => ({ log: l, minute: logMinuteOfDay(l.time) }))
    .filter((x): x is { log: LogEntry; minute: number } => x.minute !== undefined)
    .sort((a, b) => a.minute - b.minute);
  if (ordered.length < 2) return [];

  const latencies = new Map<string, number[]>();
  // pending[responder] = 그 사람이 마지막으로 "지목"받은 시각(분). 응답 시 소비하고 삭제.
  const pending = new Map<string, number>();
  let lastSpeaker: string | undefined;

  for (const { log, minute } of ordered) {
    // 이 사람이 지목받아 대기 중이었다면 지금이 응답 시점.
    const waitedSince = pending.get(log.from);
    if (waitedSince !== undefined) {
      let diff = minute - waitedSince;
      if (diff < 0) diff += 24 * 60;
      const bucket = latencies.get(log.from) ?? [];
      bucket.push(diff);
      latencies.set(log.from, bucket);
      pending.delete(log.from);
    }
    // 브로드캐스트가 아니고, 연속 동일 화자의 후속 발화가 아닌 경우에만 새 지목 등록.
    if (log.to && log.from !== lastSpeaker) {
      pending.set(log.to, minute);
    }
    lastSpeaker = log.from;
  }

  const out: Array<{ responder: string; mean: number; median: number; p90: number; samples: number }> = [];
  for (const [responder, vals] of latencies) {
    if (vals.length === 0) continue;
    const sorted = [...vals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    const p90Idx = Math.max(0, Math.ceil(sorted.length * 0.9) - 1);
    out.push({
      responder,
      mean: Number(mean.toFixed(2)),
      median: Number(median.toFixed(2)),
      p90: sorted[p90Idx],
      samples: sorted.length,
    });
  }
  // 샘플이 풍부한 쪽이 신뢰도가 높으므로 samples 내림차순, 동률이면 느린 응답자 우선 노출.
  out.sort((a, b) => b.samples - a.samples || b.mean - a.mean);
  return out.slice(0, limit);
}

// 품질 관리: 깨진/빈 로그 수를 집계해 UI에 경고로 노출할 수 있게 한다.
// v2 — 중복 ID, 과대 본문, 미래 시각 로그까지 한 번의 순회로 수집.
// 모든 카운터를 한 패스에 모아두어 list가 커져도 O(n)을 유지한다.
export function computeIntegrity(logs: unknown[]): {
  invalidCount: number;
  emptyTextCount: number;
  duplicateIdCount: number;
  oversizedTextCount: number;
  futureTimestampCount: number;
} {
  let invalidCount = 0;
  let emptyTextCount = 0;
  let duplicateIdCount = 0;
  let oversizedTextCount = 0;
  let futureTimestampCount = 0;
  const seenIds = new Set<string>();
  const nowMin = nowMinuteOfDay();
  for (const l of logs) {
    if (!validateLogEntry(l)) {
      invalidCount++;
      continue;
    }
    if (seenIds.has(l.id)) duplicateIdCount++;
    else seenIds.add(l.id);
    if (l.text.trim().length === 0) emptyTextCount++;
    if (l.text.length > MAX_TEXT_LENGTH) oversizedTextCount++;
    const lm = logMinuteOfDay(l.time);
    // 분 단위에서 미래로 5분 이상 벗어나면 동기화 오류로 간주. 동시 발화 지터는 허용.
    if (lm !== undefined) {
      const drift = lm - nowMin;
      if (drift > 5 && drift < 12 * 60) futureTimestampCount++;
    }
  }
  return {
    invalidCount,
    emptyTextCount,
    duplicateIdCount,
    oversizedTextCount,
    futureTimestampCount,
  };
}

// 품질 관리: UI/콘솔 어디서든 한 줄로 던질 수 있는 보건 요약.
// 카운터가 모두 0이면 undefined를 돌려 호출 측이 "정상" 시각 노이즈를 안 띄우게 한다.
export function summarizeIntegrity(
  integrity: ReturnType<typeof computeIntegrity>
): string | undefined {
  const parts: string[] = [];
  if (integrity.invalidCount > 0) parts.push(`손상 ${integrity.invalidCount}`);
  if (integrity.duplicateIdCount > 0) parts.push(`중복ID ${integrity.duplicateIdCount}`);
  if (integrity.oversizedTextCount > 0) parts.push(`과대 ${integrity.oversizedTextCount}`);
  if (integrity.futureTimestampCount > 0) parts.push(`미래시각 ${integrity.futureTimestampCount}`);
  if (integrity.emptyTextCount > 0) parts.push(`공백 ${integrity.emptyTextCount}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

// 디자이너 노트: 무결성 신호 심각도 매핑.
//   ok       — 표시 생략 (UI에 조용히)
//   notice   — 노랑. 알아두면 좋지만 대응 불요.
//   warn     — 주황. 사용자에게 인식 권장.
//   critical — 빨강. 상류 파이프라인 점검 즉시 필요.
// 다른 패널(AgentStatusPanel 등)이 동일 규약을 따르면 사용자는 색만으로 위험도를 학습한다.
// 색 결정 로직을 한 곳에 모아 JSX 여러 군데에 흩뿌린 삼항이 서로 어긋나지 않게 한다.
export type IntegritySeverity = 'ok' | 'notice' | 'warn' | 'critical';

export function integritySeverity(
  integrity: ReturnType<typeof computeIntegrity>
): { level: IntegritySeverity; colorClass: string; label?: string } {
  if (integrity.invalidCount > 0 || integrity.duplicateIdCount > 0) {
    return { level: 'critical', colorClass: 'text-red-300', label: '상류 점검 필요' };
  }
  if (integrity.oversizedTextCount > 0 || integrity.futureTimestampCount > 0) {
    return { level: 'warn', colorClass: 'text-orange-300', label: '이상 신호' };
  }
  if (integrity.emptyTextCount > 0) {
    return { level: 'notice', colorClass: 'text-yellow-300', label: '공백 로그' };
  }
  return { level: 'ok', colorClass: 'text-white/60' };
}

// 개발자 노트: 활성 쿼리에서 하이라이트 가능한 토큰을 길이순으로 추출.
// 더 긴 토큰을 먼저 매칭해야 부분문자열 충돌(예: "log" vs "logger")을 피한다.
// 호출 측은 이 토큰 배열로 결과 행에 mark 처리를 입힐 수 있다.
export function highlightTokens(parsed: ParsedQuery): string[] {
  const seen = new Set<string>();
  const push = (s: string) => {
    const v = s.trim();
    if (v.length > 0) seen.add(v);
  };
  parsed.terms.forEach(push);
  parsed.phrases.forEach(push);
  return Array.from(seen).sort((a, b) => b.length - a.length);
}

// 디자이너 노트: 하이라이트 렌더 헬퍼.
// 리스트 행 컴포넌트에서 원본 문자열과 토큰을 넘기면
// 매칭 구간을 {text, match} 쌍으로 분해해 돌려준다.
// 실제 <mark> 스타일링은 호출 측이 결정하도록 DOM을 만들지 않는다
// (테마 토큰이 다른 화면에서도 재사용할 수 있게 하기 위함).
export function splitByHighlight(
  source: string,
  tokens: string[]
): Array<{ text: string; match: boolean }> {
  if (!source) return [];
  if (tokens.length === 0) return [{ text: source, match: false }];
  const lower = source.toLowerCase();
  const out: Array<{ text: string; match: boolean }> = [];
  let i = 0;
  while (i < source.length) {
    let hit: { start: number; end: number } | null = null;
    for (const t of tokens) {
      if (!t) continue;
      const idx = lower.indexOf(t, i);
      if (idx === -1) continue;
      if (!hit || idx < hit.start) hit = { start: idx, end: idx + t.length };
    }
    if (!hit) {
      out.push({ text: source.slice(i), match: false });
      break;
    }
    if (hit.start > i) out.push({ text: source.slice(i, hit.start), match: false });
    out.push({ text: source.slice(hit.start, hit.end), match: true });
    i = hit.end;
  }
  return out;
}

// 개발자 노트: 쿼리 진단.
// 결과가 0건일 때 "어느 제약 조건이 가장 많이 쳐냈는가"를 알려주는 개발자 전용 헬퍼.
// 각 제약을 한 번씩 빼가며 재필터링해, 가장 드라마틱하게 결과를 늘리는 조건을 "주요 원인"으로 지목한다.
// UI가 아닌 로직 레이어에서 돌아가므로 테스트/디버깅 콘솔에서도 그대로 호출 가능.
// 품질 관리 노트: constraint 키는 유니온으로 좁혀 둔다.
// 호출 측이 switch 로 매핑할 때 exhaustiveness 검사를 받을 수 있고,
// 필드가 늘어날 때 UI 매핑 누락을 컴파일타임에 잡는다.
export type QueryDiagnosisConstraint =
  | 'terms'
  | 'phrases'
  | 'regexes'
  | 'excludeTerms'
  | 'excludeRegexes'
  | 'from'
  | 'to'
  | 'excludeFrom'
  | 'excludeTo'
  | 'sinceMinutes';

export type QueryDiagnosis = {
  originalShown: number;
  totalSafe: number;
  suspects: Array<{ constraint: QueryDiagnosisConstraint; droppedBy: number }>;
};

// 성능 노트: `active` 프레디킷으로 parsed 에 실재하지 않는 제약은 재필터 자체를 건너뛴다.
// N개 로그 × 10개 omitter = 10N 스캔이 대부분의 쿼리에서 2~3N 으로 줄어든다.
// (구버전의 `omit(parsed) === parsed` 조기 탈출은 항상 새 객체를 반환해 결코 참이 되지 않는
//  죽은 분기였다. 의도를 명시적 active 체크로 재작성.)
const CONSTRAINT_OMITTERS: Array<{
  key: QueryDiagnosisConstraint;
  active: (p: ParsedQuery) => boolean;
  omit: (p: ParsedQuery) => ParsedQuery;
}> = [
  { key: 'terms', active: p => p.terms.length > 0, omit: p => ({ ...p, terms: [] }) },
  { key: 'phrases', active: p => p.phrases.length > 0, omit: p => ({ ...p, phrases: [] }) },
  { key: 'regexes', active: p => p.regexes.length > 0, omit: p => ({ ...p, regexes: [] }) },
  { key: 'excludeTerms', active: p => p.excludeTerms.length > 0, omit: p => ({ ...p, excludeTerms: [] }) },
  { key: 'excludeRegexes', active: p => p.excludeRegexes.length > 0, omit: p => ({ ...p, excludeRegexes: [] }) },
  { key: 'from', active: p => p.from !== undefined, omit: p => ({ ...p, from: undefined }) },
  { key: 'to', active: p => p.to !== undefined, omit: p => ({ ...p, to: undefined }) },
  { key: 'excludeFrom', active: p => p.excludeFrom !== undefined, omit: p => ({ ...p, excludeFrom: undefined }) },
  { key: 'excludeTo', active: p => p.excludeTo !== undefined, omit: p => ({ ...p, excludeTo: undefined }) },
  { key: 'sinceMinutes', active: p => p.sinceMinutes !== undefined, omit: p => ({ ...p, sinceMinutes: undefined }) },
];

export function diagnoseQuery(
  logs: LogEntry[],
  parsed: ParsedQuery,
  // 호출 측이 이미 필터링 건수를 알고 있다면 baseline 재계산을 건너뛸 수 있다.
  precomputedShown?: number
): QueryDiagnosis {
  const safe = logs.filter(validateLogEntry);
  const nowMin = nowMinuteOfDay();
  const baseline =
    precomputedShown ?? safe.filter(l => matches(l, parsed, nowMin)).length;
  const suspects: QueryDiagnosis['suspects'] = [];
  for (const { key, active, omit } of CONSTRAINT_OMITTERS) {
    if (!active(parsed)) continue;
    const relaxed = omit(parsed);
    const withoutOne = safe.filter(l => matches(l, relaxed, nowMin)).length;
    const droppedBy = withoutOne - baseline;
    if (droppedBy > 0) suspects.push({ constraint: key, droppedBy });
  }
  suspects.sort((a, b) => b.droppedBy - a.droppedBy);
  return { originalShown: baseline, totalSafe: safe.length, suspects };
}

// 개발자 노트: 파싱된 쿼리를 사람이 읽을 수 있는 설명으로 풀어준다.
// 입력창 title 속성, 스크린리더 보조, 디버그 콘솔 출력 등 여러 접점에서 재사용하기 위해
// DOM이 아니라 순수 문자열을 반환한다. 활성 제약이 없으면 undefined.
export function explainQuery(parsed: ParsedQuery): string | undefined {
  const parts: string[] = [];
  if (parsed.terms.length > 0) parts.push(`포함: ${parsed.terms.join(', ')}`);
  if (parsed.phrases.length > 0)
    parts.push(`구문: ${parsed.phrases.map(p => `"${p}"`).join(', ')}`);
  if (parsed.regexes.length > 0)
    parts.push(`정규식: ${parsed.regexes.map(r => r.source).join(', ')}`);
  if (parsed.excludeTerms.length > 0)
    parts.push(`제외: ${parsed.excludeTerms.join(', ')}`);
  if (parsed.excludeRegexes.length > 0)
    parts.push(`제외 정규식: ${parsed.excludeRegexes.map(r => r.source).join(', ')}`);
  if (parsed.from) parts.push(`송신자=${parsed.from}`);
  if (parsed.to) parts.push(`수신자=${parsed.to}`);
  if (parsed.excludeFrom) parts.push(`송신자≠${parsed.excludeFrom}`);
  if (parsed.excludeTo) parts.push(`수신자≠${parsed.excludeTo}`);
  if (parsed.sinceMinutes !== undefined) parts.push(`최근 ${parsed.sinceMinutes}분`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function LogFilter({
  logs,
  query,
  onQueryChange,
  onStatsChange,
  density = 'cozy',
  showCheatsheet = false,
}: Props) {
  const [senderFilter, setSenderFilter] = useState<string | null>(null);
  // 디자이너 노트: 치트시트는 초기에 접혀 있고 사용자가 "?" 버튼으로만 펼친다.
  // 처음엔 눈에 띄지 않도록 보조 역할에 머물러야, 쿼리창 자체의 시선 집중을 방해하지 않는다.
  const [cheatOpen, setCheatOpen] = useState(showCheatsheet);
  // 개발자 노트: 진단 패널은 "일치 없음"일 때만 의미가 있어 기본 접힘.
  const [diagOpen, setDiagOpen] = useState(false);
  // 디자이너 노트: 최근 쿼리는 세션 지속 로컬 상태.
  // localStorage 영속까지는 의도적으로 두지 않았다 — 다른 프로젝트의 쿼리가
  // 의도치 않게 다음 세션에 되살아나면 오히려 혼란을 준다.
  const [recent, setRecent] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const tokens = DENSITY_TOKENS[density];
  const modKey = useMemo(() => modKeyLabel(), []);

  // 개발자 노트: Ctrl/Cmd+K — 어느 창에서든 로그 필터로 포커스 복귀.
  // 텍스트 영역/입력에서 타이핑 중이어도 가로채 개발자 플로우를 끊지 않는다.
  // "?" (Shift+/) — 입력 포커스 밖에서만 치트시트 토글. 입력 중일 땐 문법 충돌을 피해 무시.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        const typing =
          target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable);
        if (typing) return;
        e.preventDefault();
        setCheatOpen(v => !v);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const parsed = useMemo(() => parseQuery(query), [query]);

  // 디자이너 노트: 사용자가 타이핑을 멈추면 "의도가 굳었다"고 간주해 최근 목록에 커밋.
  // 키 입력마다 setRecent를 돌리면 오타까지 히스토리에 남으므로 디바운스가 필수.
  // 같은 쿼리가 반복되면 pushRecentQuery가 맨 앞으로 끌어올려 자연스러운 재방문 UX를 만든다.
  useEffect(() => {
    if (query.trim().length === 0) return;
    const handle = window.setTimeout(() => {
      setRecent(prev => pushRecentQuery(prev, query));
    }, RECENT_COMMIT_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query]);

  // 품질 관리: 상류 버그로 깨진 레코드가 섞여 들어와도 렌더링이 죽지 않도록 방어.
  const safeLogs = useMemo(() => logs.filter(validateLogEntry), [logs]);
  const integrity = useMemo(() => computeIntegrity(logs), [logs]);

  const filtered = useMemo(() => {
    const nowMin = nowMinuteOfDay();
    return safeLogs.filter(l => {
      if (senderFilter && l.from !== senderFilter) return false;
      return matches(l, parsed, nowMin);
    });
  }, [safeLogs, parsed, senderFilter]);

  const senders = useMemo(() => {
    const set = new Set<string>();
    for (const l of safeLogs) set.add(l.from);
    return Array.from(set).sort();
  }, [safeLogs]);

  const topSender = useMemo(() => computeTopSender(filtered), [filtered]);
  const senderDistribution = useMemo(() => computeSenderDistribution(filtered), [filtered]);
  const avgTextLength = useMemo(() => computeAvgTextLength(filtered), [filtered]);

  const stats: LogFilterStats = useMemo(
    () => ({
      total: logs.length,
      shown: filtered.length,
      uniqueSenders: senders.length,
      topSender,
      windowMinutes: parsed.sinceMinutes,
      avgTextLength,
      senderDistribution,
      invalidCount: integrity.invalidCount,
      emptyTextCount: integrity.emptyTextCount,
      duplicateIdCount: integrity.duplicateIdCount,
      oversizedTextCount: integrity.oversizedTextCount,
      futureTimestampCount: integrity.futureTimestampCount,
    }),
    [
      logs.length,
      filtered.length,
      senders.length,
      topSender,
      parsed.sinceMinutes,
      avgTextLength,
      senderDistribution,
      integrity.invalidCount,
      integrity.emptyTextCount,
      integrity.duplicateIdCount,
      integrity.oversizedTextCount,
      integrity.futureTimestampCount,
    ]
  );

  // 디자이너 노트: 색-의미 매핑을 한 곳에서 파생해 통계 줄 전체가 동일한 톤 규칙을 따르게 한다.
  const severity = useMemo(() => integritySeverity(integrity), [integrity]);

  // 품질 관리: 쿼리 자체의 정적 결함(닫히지 않은 따옴표, 모순 제약 등)을 실시간 감지.
  // 상류 데이터 결함(integrity) 과 달리 "사용자 입력" 결함이라 색 규약을 분리해 혼선을 피한다.
  const sanityWarnings = useMemo(() => detectQuerySanity(query), [query]);

  // 디자이너 노트: 자동 보정 프리뷰.
  //   suggestQueryFix 는 원문을 몰래 바꾸지 않는 규약이라 UI 가 "제안만" 해야 한다.
  //   사용자 타이핑 흐름을 깨지 않으려고 경고가 하나라도 있을 때만 계산하고,
  //   실제로 고친 점이 없으면(changes=[]) 버튼을 숨겨 노이즈를 만들지 않는다.
  //   query 가 바뀔 때마다 재계산되지만 길이 O(tokens) 라 메모이즈만으로 충분.
  const fixSuggestion = useMemo(
    () => (sanityWarnings.length > 0 ? suggestQueryFix(query) : undefined),
    [query, sanityWarnings.length]
  );
  const hasFixSuggestion =
    fixSuggestion !== undefined &&
    fixSuggestion.changes.length > 0 &&
    fixSuggestion.fixed !== query;

  React.useEffect(() => {
    onStatsChange?.(stats);
  }, [stats, onStatsChange]);

  const hasActiveQuery =
    parsed.terms.length > 0 ||
    parsed.phrases.length > 0 ||
    parsed.excludeTerms.length > 0 ||
    parsed.regexes.length > 0 ||
    parsed.excludeRegexes.length > 0 ||
    parsed.from !== undefined ||
    parsed.to !== undefined ||
    parsed.excludeFrom !== undefined ||
    parsed.excludeTo !== undefined ||
    parsed.sinceMinutes !== undefined;

  const showClear = query.length > 0;

  return (
    <div className={`flex flex-col ${tokens.gap}`}>
      <div className="relative flex items-center">
        <input
          ref={inputRef}
          value={query}
          onChange={e => onQueryChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape' && query.length > 0) {
              e.preventDefault();
              onQueryChange('');
              setSenderFilter(null);
            }
          }}
          placeholder='로그 필터 (Ctrl+K): 단어, "정확 일치", /정규식/, from:이름, -to:이름, since:15m'
          aria-label="로그 필터"
          // 개발자 노트: 타이핑한 쿼리가 어떻게 해석됐는지 호버로 즉시 확인.
          // 따옴표 짝·역슬래시 잘림·오타를 빨리 포착하기 위함.
          title={explainQuery(parsed) ?? '활성 제약 없음'}
          // 디자이너 노트: 포커스 시 테두리 색만 바꾸고 그림자는 쓰지 않는다.
          // 픽셀 UI 톤과 어긋나는 blur-shadow를 피하기 위함.
          className={`flex-1 bg-black/40 border-2 border-[var(--pixel-border)] text-white focus:outline-none focus:border-[var(--pixel-accent)] ${tokens.input}`}
        />
        {showClear && (
          <button
            type="button"
            onClick={() => {
              onQueryChange('');
              setSenderFilter(null);
            }}
            aria-label="필터 지우기"
            title="필터 지우기 (Esc)"
            className="absolute right-6 text-white/60 hover:text-[var(--pixel-accent)] text-[11px] px-1"
          >
            ×
          </button>
        )}
        <button
          type="button"
          onClick={() => setCheatOpen(v => !v)}
          aria-expanded={cheatOpen}
          aria-controls="logfilter-cheatsheet"
          aria-label={cheatOpen ? '문법 도움말 접기' : '문법 도움말 펼치기'}
          title="쿼리 문법 도움말"
          className="absolute right-1 text-white/60 hover:text-[var(--pixel-accent)] text-[11px] px-1"
        >
          ?
        </button>
      </div>

      {cheatOpen && (
        <div
          id="logfilter-cheatsheet"
          // 디자이너 노트: 어휘 설명은 모노스페이스로 고정폭 정렬해 예시와 의미가 시각적으로 매칭되도록.
          className="border border-[var(--pixel-border)] bg-black/30 p-2 text-[10px] leading-relaxed text-white/80 font-mono"
        >
          <div><span className="text-[var(--pixel-accent)]">버그</span> — 본문/송수신자에 포함</div>
          <div><span className="text-[var(--pixel-accent)]">"정확 일치"</span> — 큰따옴표는 구문 단위</div>
          <div><span className="text-[var(--pixel-accent)]">/정규식/</span> — 슬래시로 감싸면 RegExp</div>
          <div><span className="text-[var(--pixel-accent)]">from:alpha</span> / <span className="text-[var(--pixel-accent)]">to:beta</span> — 송·수신자</div>
          <div><span className="text-[var(--pixel-accent)]">-error</span> / <span className="text-[var(--pixel-accent)]">-from:noise</span> — 제외</div>
          <div><span className="text-[var(--pixel-accent)]">since:15m</span> — 최근 N (s/m/h/d)</div>
          {/*
            디자이너 노트: 자동 보정이 있다는 사실을 치트시트에 함께 노출해
            "경고가 뜨면 클릭 한 번으로 고칠 수 있다"는 규약을 학습시킨다.
            문법 설명만 나열하면 초급 사용자는 "고치는 법"을 유추하지 못한다.
          */}
          <div className="mt-1 text-white/50">
            경고가 뜨면 <span className="text-yellow-300">[보정 제안]</span> 행의 토큰을 눌러 한 번에 적용합니다.
          </div>
        </div>
      )}

      {query.length === 0 && (
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label="자주 쓰는 필터 프리셋"
        >
          {QUERY_PRESETS.map(p => (
            <button
              key={p.label}
              type="button"
              onClick={() => onQueryChange(p.query)}
              title={p.hint}
              className={`${tokens.chip} border border-dashed border-[var(--pixel-border)] text-white/60 hover:text-[var(--pixel-accent)] hover:border-[var(--pixel-accent)]`}
            >
              {p.label}
            </button>
          ))}
          {/*
            디자이너 노트: 단축키 배지.
            - 빈 입력 상태에서만 노출해 "처음 여는 사람"이 배우도록 유도.
            - 프리셋과 같은 줄에 붙여 배치하면 시선 이동 없이 인지 부담이 낮아진다.
            - 입력이 시작되면 시야에서 치워 방해하지 않는다 (placeholder에 이미 같은 정보가 살아 있음).
          */}
          <span
            className={`${tokens.kbd} ml-auto border border-[var(--pixel-border)] text-white/50 font-mono select-none`}
            aria-hidden="true"
            title="어디서든 이 키 조합으로 필터에 포커스합니다"
          >
            {modKey}+K
          </span>
        </div>
      )}

      {query.length === 0 && recent.length > 0 && (
        <div
          className="flex flex-wrap gap-1 items-center"
          role="group"
          aria-label="최근 사용한 쿼리"
        >
          {/*
            디자이너 노트: 최근 쿼리 라벨.
            - 프리셋과 시각적으로 분리해 "이건 당신이 직전에 쓴 것"이라는 의미를 전달.
            - 라벨 컬러는 opacity로만 눌러, 접근성(대비)이 극단적으로 나빠지지 않도록 한다.
          */}
          <span className={`${tokens.chip} text-white/40 select-none`}>최근</span>
          {recent.map(q => (
            <button
              key={q}
              type="button"
              onClick={() => onQueryChange(q)}
              title={q}
              className={`${tokens.chip} border border-[var(--pixel-border)] text-white/70 hover:text-[var(--pixel-accent)] hover:border-[var(--pixel-accent)] font-mono max-w-[16ch] truncate`}
            >
              {q}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setRecent([])}
            aria-label="최근 쿼리 비우기"
            title="최근 쿼리 비우기"
            className={`${tokens.chip} text-white/40 hover:text-red-300`}
          >
            ×
          </button>
        </div>
      )}

      {senders.length > 1 && (
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label="발신자 빠른 필터"
        >
          <button
            type="button"
            onClick={() => setSenderFilter(null)}
            aria-pressed={senderFilter === null}
            className={`${tokens.chip} border ${
              senderFilter === null
                ? 'border-[var(--pixel-accent)] text-[var(--pixel-accent)]'
                : 'border-[var(--pixel-border)] text-white/70'
            }`}
          >
            전체
          </button>
          {senders.map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setSenderFilter(s === senderFilter ? null : s)}
              aria-pressed={senderFilter === s}
              className={`${tokens.chip} border ${
                senderFilter === s
                  ? 'border-[var(--pixel-accent)] text-[var(--pixel-accent)]'
                  : 'border-[var(--pixel-border)] text-white/70'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/*
        디자이너 노트: 상태 요약 줄.
        - aria-live="polite"로 스크린리더가 쿼리 변경 결과를 방해 없이 읽도록 함.
        - 가운뎃점(·) 대신 세로 파이프(|) 계열을 검토했으나, 픽셀 폰트에서 시각 무게가 과해 중간점 유지.
        - 경고(손상/공백)는 항상 같은 컬러 토큰을 재사용해 사용자가 위험 신호를 학습하도록 한다.
      */}
      <div
        className={`${tokens.stats} text-[var(--pixel-accent)] opacity-80 flex flex-wrap`}
        aria-live="polite"
      >
        <span>{stats.shown}/{stats.total} 표시</span>
        <span>· 발신자 {stats.uniqueSenders}명</span>
        {topSender && <span>· 상위 {topSender.name} ({topSender.count})</span>}
        {avgTextLength !== undefined && <span>· 평균 {avgTextLength}자</span>}
        {parsed.sinceMinutes !== undefined && (
          <span>· 최근 {parsed.sinceMinutes}분</span>
        )}
        {hasActiveQuery && filtered.length === 0 && (
          <span className="text-red-300">· 일치 없음</span>
        )}
        {integrity.invalidCount > 0 && (
          <span
            className="text-red-300"
            title="스키마를 만족하지 못한 로그 수 — 상류 파이프라인 점검 필요"
          >
            · 손상 {integrity.invalidCount}건
          </span>
        )}
        {integrity.emptyTextCount > 0 && (
          <span className="text-yellow-300" title="본문이 비어 있는 로그">
            · 공백 {integrity.emptyTextCount}건
          </span>
        )}
        {integrity.duplicateIdCount > 0 && (
          <span
            className="text-red-300"
            title="동일 ID로 중복 유입된 로그 — 발신자 측 재시도/멱등성 점검 필요"
          >
            · 중복ID {integrity.duplicateIdCount}건
          </span>
        )}
        {integrity.oversizedTextCount > 0 && (
          <span
            className="text-yellow-300"
            title={`본문이 ${MAX_TEXT_LENGTH}자를 초과한 로그 — 직렬화/말림 버그 가능성`}
          >
            · 과대 {integrity.oversizedTextCount}건
          </span>
        )}
        {integrity.futureTimestampCount > 0 && (
          <span
            className="text-yellow-300"
            title="현재 시각보다 미래 타임스탬프 — 시계 동기화/타임존 점검 필요"
          >
            · 미래시각 {integrity.futureTimestampCount}건
          </span>
        )}
        {severity.level !== 'ok' && severity.label && (
          <span
            className={severity.colorClass}
            title="무결성 종합 판정 — 다른 패널(상태/워크스페이스)과 동일한 색 규약을 공유합니다."
          >
            · {severity.label}
          </span>
        )}
        {/*
          품질 관리 노트: 0~100 무결성 점수.
          - 만점일 땐 노이즈를 피해 숨긴다(색 규약이 severity 로 충분히 전달됨).
          - 임계값 대시보드·알림에서 재사용 가능한 정규화 지표라는 맥락을 title 로 전달.
        */}
        {logs.length > 0 && severity.level !== 'ok' && (
          <span
            className={severity.colorClass}
            title="무결성 점수(0~100). 대시보드/알림 임계값 비교용 정규화 지표."
          >
            · 점수 {computeIntegrityScore(integrity, logs.length)}
          </span>
        )}
        {/*
          품질 관리 노트: 쿼리 정적 경고.
          - redundantTerm 은 항상 0건 결과를 만들어 치명적이므로 빨강.
          - 그 외 경고는 "막진 않지만 알리고 싶다" 수준으로 노랑.
          - title 에 상세 사유를 모두 연결해 호버만으로 수정 힌트를 얻게 한다.
        */}
        {sanityWarnings.length > 0 && (
          <span
            className={
              sanityWarnings.some(w => w.kind === 'redundantTerm')
                ? 'text-red-300'
                : 'text-yellow-300'
            }
            title={sanityWarnings.map(w => w.detail).join('\n')}
          >
            · 쿼리 경고 {sanityWarnings.length}건
          </span>
        )}
        {hasActiveQuery && filtered.length === 0 && (
          <button
            type="button"
            onClick={() => setDiagOpen(v => !v)}
            aria-expanded={diagOpen}
            aria-controls="logfilter-diagnosis"
            className="underline decoration-dotted hover:text-white"
            title="어느 제약이 결과를 가장 많이 쳐냈는지 검사"
          >
            · 진단
          </button>
        )}
      </div>

      {hasFixSuggestion && fixSuggestion && (
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label="쿼리 자동 보정 제안"
        >
          {/*
            디자이너 노트: 자동 보정 행동은 "제안 → 사용자 승낙" 플로우를 그대로 UI로 번역.
            - 라벨 앞에 망치 문자(🛠)가 아닌 텍스트만 쓰는 건 픽셀 폰트 톤을 흐리지 않기 위함.
            - 변경 상세는 title 로만 노출해 첫인상이 한 줄에 머물게 한다(인지 부하 최소화).
            - 클릭 시 입력 포커스를 되돌려 사용자가 곧바로 수정 결과를 확인·이어 타이핑 가능.
          */}
          <span className={`${tokens.chip} text-yellow-300/80 select-none`}>보정 제안</span>
          <button
            type="button"
            onClick={() => {
              onQueryChange(fixSuggestion.fixed);
              inputRef.current?.focus();
            }}
            title={fixSuggestion.changes.join('\n')}
            aria-label={`쿼리 자동 보정 적용: ${fixSuggestion.changes.length}건`}
            className={`${tokens.chip} border border-yellow-300/60 text-yellow-200 hover:text-black hover:bg-yellow-300 font-mono max-w-[28ch] truncate`}
          >
            {fixSuggestion.fixed || '(빈 입력)'}
          </button>
          <span
            className={`${tokens.chip} text-white/40 select-none`}
            aria-hidden="true"
          >
            {fixSuggestion.changes.length}건 수정
          </span>
        </div>
      )}

      {diagOpen && hasActiveQuery && filtered.length === 0 && (
        <div
          id="logfilter-diagnosis"
          className="border border-[var(--pixel-border)] bg-black/30 p-2 text-[10px] leading-relaxed text-white/80 font-mono"
        >
          {(() => {
            // baseline(filtered.length)을 넘겨 진단 시 재필터링 1회를 절약.
            const diag = diagnoseQuery(safeLogs, parsed, filtered.length);
            if (diag.suspects.length === 0) {
              return <div className="text-white/60">제약을 하나씩 빼 봐도 결과가 늘지 않음. 원본 로그 자체를 확인하세요.</div>;
            }
            return (
              <>
                <div className="text-white/60 mb-1">제거 시 결과가 늘어나는 제약 (상위 3):</div>
                {diag.suspects.slice(0, 3).map(s => (
                  <div key={s.constraint}>
                    <span className="text-[var(--pixel-accent)]">{s.constraint}</span>
                    <span> 제거 시 +{s.droppedBy}건</span>
                  </div>
                ))}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// 품질 관리 노트: 쿼리 정적 점검.
// 파서는 부분/잘못된 입력에 대해 관대(실패 토큰을 조용히 버림) 하도록 설계됐다.
// 그 관대함 덕에 사용자는 "왜 결과가 이상한지"를 모르고 시간을 낭비할 수 있으므로,
// 원문 문자열 수준에서 흔한 실수를 탐지해 별도 경고로 노출한다.
// 반환된 경고는 UI 배지/테스트 셀프체크 모두에서 재사용한다.
export type QuerySanityWarning =
  | { kind: 'unclosedQuote'; detail: string }
  | { kind: 'unclosedRegex'; detail: string }
  | { kind: 'emptyRegex'; detail: string }
  | { kind: 'conflictFrom'; detail: string }
  | { kind: 'conflictTo'; detail: string }
  | { kind: 'redundantTerm'; detail: string }
  | { kind: 'overlyBroadTerm'; detail: string };

// 품질 관리 노트: "쳐내기만 하면 안 되는" 과도하게 넓은 단일 토큰 기준.
// 한 글자 영문/숫자는 거의 모든 로그에 매치돼 필터 의미가 무너진다.
// 유니코드(한글 등)는 한 글자도 의미가 있을 수 있어 제외.
const ASCII_WORD_CHAR = /^[A-Za-z0-9]$/;

export function detectQuerySanity(raw: string): QuerySanityWarning[] {
  const warnings: QuerySanityWarning[] = [];
  if (!raw) return warnings;

  // 따옴표 짝수 검사 — 홀수면 마지막 구문이 미완.
  const quoteCount = (raw.match(/"/g) ?? []).length;
  if (quoteCount % 2 === 1) {
    warnings.push({ kind: 'unclosedQuote', detail: '큰따옴표 짝이 맞지 않습니다' });
  }

  // 정규식 슬래시 짝 검사. 공백으로 분리된 각 토큰에 대해 확인해
  // 다른 URL-유사 토큰과 혼동하지 않는다.
  for (const tok of tokenize(raw)) {
    const bare = tok.startsWith('-') ? tok.slice(1) : tok;
    if (bare.startsWith('/')) {
      if (!bare.endsWith('/') || bare.length < 3) {
        warnings.push({ kind: 'unclosedRegex', detail: `정규식 토큰 "${tok}" 이 닫히지 않음` });
      } else if (bare.length === 2) {
        warnings.push({ kind: 'emptyRegex', detail: '빈 정규식 "//" 은 모든 로그와 매치됩니다' });
      }
    }
  }

  const parsed = parseQuery(raw);

  if (parsed.from && parsed.excludeFrom && parsed.from === parsed.excludeFrom) {
    warnings.push({
      kind: 'conflictFrom',
      detail: `from:${parsed.from} 과 -from:${parsed.excludeFrom} 가 서로 상쇄됩니다`,
    });
  }
  if (parsed.to && parsed.excludeTo && parsed.to === parsed.excludeTo) {
    warnings.push({
      kind: 'conflictTo',
      detail: `to:${parsed.to} 과 -to:${parsed.excludeTo} 가 서로 상쇄됩니다`,
    });
  }

  // 동일 토큰이 포함/제외에 모두 있으면 항상 0건 — 치명적 결함이므로 별도 분류.
  const excludeSet = new Set(parsed.excludeTerms);
  for (const t of parsed.terms) {
    if (excludeSet.has(t)) {
      warnings.push({
        kind: 'redundantTerm',
        detail: `"${t}" 가 포함/제외에 동시에 존재 — 결과는 항상 0건`,
      });
    }
  }

  // 단일 ASCII 한 글자 텀은 의미 있는 필터가 되기 어렵다. 경고만 남기고 막진 않는다.
  for (const t of parsed.terms) {
    if (t.length === 1 && ASCII_WORD_CHAR.test(t)) {
      warnings.push({
        kind: 'overlyBroadTerm',
        detail: `한 글자 토큰 "${t}" 는 거의 모든 로그와 매치됩니다`,
      });
    }
  }

  return warnings;
}

// 품질 관리 노트: 쿼리 경고 심각도 매핑.
// integritySeverity 와 같은 색 규약(critical/warn/notice/ok)을 재사용해, 사용자가 "빨강/주황/노랑"의
// 의미를 한 번 배우면 상류 데이터 결함이든 자기 입력 결함이든 동일하게 해석할 수 있게 한다.
//   redundantTerm / conflictFrom / conflictTo — 결과가 항상 0건이므로 critical.
//   emptyRegex                                  — 필터 자체를 무력화(모두 매치)하므로 warn.
//   unclosedQuote / unclosedRegex               — 타이핑 중 과도기 상태가 많지만, 커밋되면 토큰이
//                                                조용히 탈락하므로 warn 으로 둬 사용자 주의를 끈다.
//   overlyBroadTerm                             — 결과는 나오지만 변별력이 낮아 notice.
// 내부 규약이 분기 테이블 한 곳에 모여 있어야 UI/리포트/알림이 서로 어긋나지 않는다.
export function sanityWarningSeverity(
  kind: QuerySanityWarning['kind']
): Exclude<IntegritySeverity, 'ok'> {
  switch (kind) {
    case 'redundantTerm':
    case 'conflictFrom':
    case 'conflictTo':
      return 'critical';
    case 'emptyRegex':
    case 'unclosedQuote':
    case 'unclosedRegex':
      return 'warn';
    case 'overlyBroadTerm':
      return 'notice';
  }
}

// 품질 관리 노트: 경고 배열에서 "가장 심각한" 레벨만 뽑아 준다.
// UI 가 경고 묶음에 단일 색을 입힐 때(배지, 테두리 등) 반복되는 reduce 를 한 곳으로 모은다.
// 입력이 비면 'ok' — 호출 측이 조용히 숨기는 분기를 단순 비교로 처리할 수 있도록.
const SEVERITY_RANK: Record<IntegritySeverity, number> = {
  ok: 0,
  notice: 1,
  warn: 2,
  critical: 3,
};

export function worstSanitySeverity(
  warnings: QuerySanityWarning[]
): IntegritySeverity {
  let worst: IntegritySeverity = 'ok';
  for (const w of warnings) {
    const s = sanityWarningSeverity(w.kind);
    if (SEVERITY_RANK[s] > SEVERITY_RANK[worst]) worst = s;
  }
  return worst;
}

// 개발자 노트: 쿼리 경고 종류별 빈도.
// worstSanitySeverity 가 "단일 색" 을 위한 축약이라면, 이 함수는 대시보드 스택 차트·알림 임계값이
// 필요로 하는 종류별 카운트를 돌려준다. 같은 kind 가 여러 번 발견되는 redundantTerm 같은 경고를
// Set 으로 접으면 실제 입력 실수 빈도가 손실되므로 합산 카운터 형태로 보존한다.
// 모든 kind 키를 0 으로 초기화해 호출 측이 undefined 분기를 다루지 않게 한다(색 테이블 인덱싱 편의).
export function sanityWarningHistogram(
  warnings: QuerySanityWarning[]
): Record<QuerySanityWarning['kind'], number> {
  const out: Record<QuerySanityWarning['kind'], number> = {
    unclosedQuote: 0,
    unclosedRegex: 0,
    emptyRegex: 0,
    conflictFrom: 0,
    conflictTo: 0,
    redundantTerm: 0,
    overlyBroadTerm: 0,
  };
  for (const w of warnings) out[w.kind]++;
  return out;
}

// 품질 관리 노트: 상류 데이터(integrity) 와 사용자 입력(sanity) 을 한 번에 본 "전체 필터 건강".
// 두 축의 심각도 중 더 나쁜 쪽을 대표값으로 올려, 외곽 배지 한 개로 전체 상태를 대변한다.
// 호출 측이 "어느 축이 문제인가"까지 알아야 할 때는 integrity/sanity 를 따로 읽으면 된다.
export type FilterHealth = {
  level: IntegritySeverity;
  integrityLevel: IntegritySeverity;
  sanityLevel: IntegritySeverity;
  integrityScore: number;
};

export function computeFilterHealth(
  integrity: ReturnType<typeof computeIntegrity>,
  sanityWarnings: QuerySanityWarning[],
  total: number
): FilterHealth {
  const integrityLevel = integritySeverity(integrity).level;
  const sanityLevel = worstSanitySeverity(sanityWarnings);
  const level: IntegritySeverity =
    SEVERITY_RANK[integrityLevel] >= SEVERITY_RANK[sanityLevel]
      ? integrityLevel
      : sanityLevel;
  return {
    level,
    integrityLevel,
    sanityLevel,
    integrityScore: computeIntegrityScore(integrity, total),
  };
}

// 품질 관리 노트: 무결성 결과가 "완전 이상 없음"인지 한 번에 확인.
// UI에서 경고 줄을 그릴지 판단할 때 반복되는 삼항 조합을 한 곳으로 모은다.
export function isIntegrityHealthy(
  integrity: ReturnType<typeof computeIntegrity>
): boolean {
  return (
    integrity.invalidCount === 0 &&
    integrity.emptyTextCount === 0 &&
    integrity.duplicateIdCount === 0 &&
    integrity.oversizedTextCount === 0 &&
    integrity.futureTimestampCount === 0
  );
}

// 품질 관리 노트: 0~100 무결성 점수.
// severity 가 "색 규약" 이라면 점수는 "대시보드/알림 임계값" 용도.
// 가중치는 UI 색 규약(critical/warn/notice)과 일치시켜 규칙이 두 곳에서 어긋나지 않게 한다.
//   invalid / duplicateId  — critical, 각 건당 -8
//   oversized / future     — warn,     각 건당 -3
//   empty                  — notice,   각 건당 -1
// total 이 0이면 100(샘플 없음은 "이상 없음"으로 간주).
// 점수는 하한 0으로 클램프해 대량 오염 시에도 의미 있는 비교 지표를 유지.
export function computeIntegrityScore(
  integrity: ReturnType<typeof computeIntegrity>,
  total: number
): number {
  if (total <= 0) return 100;
  const penalty =
    integrity.invalidCount * 8 +
    integrity.duplicateIdCount * 8 +
    integrity.oversizedTextCount * 3 +
    integrity.futureTimestampCount * 3 +
    integrity.emptyTextCount * 1;
  const raw = 100 - Math.round((penalty / total) * 100);
  return Math.max(0, Math.min(100, raw));
}

// 품질 관리 노트: 여러 소스(윈도우/탭/워커)에서 집계된 integrity 스냅샷을 합산.
// 분산 집계 환경에서 각 소스가 각자 computeIntegrity 를 돌린 뒤 최종 대시보드로
// 모을 때 쓰인다. 카운터 의미가 모두 가법(additive)이라 단순 합이 올바르다.
export function mergeIntegrity(
  a: ReturnType<typeof computeIntegrity>,
  b: ReturnType<typeof computeIntegrity>
): ReturnType<typeof computeIntegrity> {
  return {
    invalidCount: a.invalidCount + b.invalidCount,
    emptyTextCount: a.emptyTextCount + b.emptyTextCount,
    duplicateIdCount: a.duplicateIdCount + b.duplicateIdCount,
    oversizedTextCount: a.oversizedTextCount + b.oversizedTextCount,
    futureTimestampCount: a.futureTimestampCount + b.futureTimestampCount,
  };
}

// 품질 관리 노트: 결함 카테고리 키 타입.
// 문자열 리터럴 유니언으로 고정해 UI 색/라벨 테이블 인덱싱 시 분기 누락을
// 컴파일 타임에 잡는다. computeIntegrity 반환 키와 1:1 대응.
export type IntegrityDefectKey =
  | 'invalidCount'
  | 'emptyTextCount'
  | 'duplicateIdCount'
  | 'oversizedTextCount'
  | 'futureTimestampCount';

const INTEGRITY_DEFECT_KEYS: IntegrityDefectKey[] = [
  'invalidCount',
  'emptyTextCount',
  'duplicateIdCount',
  'oversizedTextCount',
  'futureTimestampCount',
];

// 품질 관리 노트: 0보다 큰 결함 카테고리 키 목록.
// summarizeIntegrity 가 "사람이 읽는 한 줄" 이라면 이 함수는 "기계가 분기하는 키 배열".
// 알림·테스트·대시보드 위젯이 활성 카테고리별로 다른 처리를 할 때 재사용한다.
export function integrityDefectCategories(
  integrity: ReturnType<typeof computeIntegrity>
): IntegrityDefectKey[] {
  return INTEGRITY_DEFECT_KEYS.filter(k => integrity[k] > 0);
}

// 품질 관리 노트: 두 무결성 스냅샷 간 회귀 탐지.
// 절대 수치만으로는 트래픽 증가와 회귀를 구분하기 어렵다. 배포 전/후, 시간대 전/후
// 스냅샷을 비교해 "악화 방향" 변화만 추려야 유의미한 알람 신호가 된다.
// newlyIntroduced 는 "이전엔 0이었는데 이번에 나타난" 카테고리 — 가장 주목할 회귀 지표.
export type IntegrityDelta = {
  worsened: Array<{ key: IntegrityDefectKey; before: number; after: number; diff: number }>;
  improved: Array<{ key: IntegrityDefectKey; before: number; after: number; diff: number }>;
  newlyIntroduced: IntegrityDefectKey[];
};

export function computeIntegrityDelta(
  previous: ReturnType<typeof computeIntegrity>,
  current: ReturnType<typeof computeIntegrity>
): IntegrityDelta {
  const worsened: IntegrityDelta['worsened'] = [];
  const improved: IntegrityDelta['improved'] = [];
  const newlyIntroduced: IntegrityDefectKey[] = [];
  for (const key of INTEGRITY_DEFECT_KEYS) {
    const before = previous[key];
    const after = current[key];
    const diff = after - before;
    if (diff > 0) {
      worsened.push({ key, before, after, diff });
      if (before === 0) newlyIntroduced.push(key);
    } else if (diff < 0) {
      improved.push({ key, before, after, diff });
    }
  }
  return { worsened, improved, newlyIntroduced };
}

// 개발자 노트: 델타를 "릴리즈 노트/인시던트 채널" 한 줄로 포맷.
// 기계 친화 객체(IntegrityDelta)를 사람 친화 문자열로 축약해, 알림/요약 위젯이
// 각자 포맷팅 로직을 중복 구현하지 않게 한다.
// 변화가 없으면 undefined — 호출 측이 "변동 없음" 행을 조용히 숨기도록.
// newlyIntroduced 는 "처음 나타난 회귀"이므로 별표(*)로 눈에 띄게 표시.
export function formatIntegrityDelta(delta: IntegrityDelta): string | undefined {
  const parts: string[] = [];
  const novel = new Set<IntegrityDefectKey>(delta.newlyIntroduced);
  for (const w of delta.worsened) {
    const prefix = novel.has(w.key) ? '*' : '';
    parts.push(`${prefix}${w.key} ${w.before}→${w.after} (+${w.diff})`);
  }
  for (const i of delta.improved) {
    parts.push(`${i.key} ${i.before}→${i.after} (${i.diff})`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

// 품질 관리 노트(감마): 연속된 무결성 스냅샷에서 "추세" 를 뽑는다.
// computeIntegrityDelta 는 두 시점만 본다 — 세 시점 이상에서 나타나는 완만한 악화
// (예: 점수 95 → 92 → 88) 는 델타 셋으로 쪼개져 추세 신호가 흩어진다.
// 이 함수는 시간순 정렬된 스냅샷 배열을 받아 단조성(monotonic) 여부와 방향을 판정,
// 대시보드/알림이 "지속적으로 악화 중" 같은 맥락 한 줄을 표시할 수 있게 한다.
// volatile 은 "방향이 뒤섞여 회귀/개선이라 부르기 어려움" — 원인 조사 대상 신호.
export type IntegrityTrendDirection = 'improving' | 'degrading' | 'stable' | 'volatile';

export type IntegrityTrend = {
  direction: IntegrityTrendDirection;
  monotonic: boolean;
  firstScore: number;
  lastScore: number;
  worstScore: number;
  bestScore: number;
  sampleCount: number;
};

export function computeIntegrityTrend(
  snapshots: Array<{ integrity: ReturnType<typeof computeIntegrity>; total: number }>
): IntegrityTrend | undefined {
  if (snapshots.length === 0) return undefined;
  const scores = snapshots.map(s => computeIntegrityScore(s.integrity, s.total));
  const first = scores[0];
  const last = scores[scores.length - 1];
  let worst = scores[0];
  let best = scores[0];
  let monotonicDown = true;
  let monotonicUp = true;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] < worst) worst = scores[i];
    if (scores[i] > best) best = scores[i];
    if (scores[i] > scores[i - 1]) monotonicDown = false;
    if (scores[i] < scores[i - 1]) monotonicUp = false;
  }
  let direction: IntegrityTrendDirection;
  if (scores.length === 1 || first === last) {
    // 단일 스냅샷 또는 양끝 동일 — 내부 변동은 있어도 "결과적으로 제자리" 로 취급.
    direction = first === last && (monotonicDown || monotonicUp) ? 'stable' : 'volatile';
    if (scores.length === 1) direction = 'stable';
  } else if (monotonicDown && last < first) {
    direction = 'degrading';
  } else if (monotonicUp && last > first) {
    direction = 'improving';
  } else {
    direction = 'volatile';
  }
  return {
    direction,
    monotonic: monotonicDown || monotonicUp,
    firstScore: first,
    lastScore: last,
    worstScore: worst,
    bestScore: best,
    sampleCount: scores.length,
  };
}

// 품질 관리 노트(감마): 추세를 한 줄 알림 문구로 축약.
// 방향이 'stable' 이면 undefined — 대시보드가 조용히 숨기도록 한다. 그 외에는
// "점수 95→92→88 (degrading, 최저 88)" 꼴로 점수 이력과 워스트 케이스를 함께 전한다.
// 포맷팅 로직을 한 곳에 모아 알림/위젯이 각자 문자열 조립을 중복 구현하지 않게 한다.
export function formatIntegrityTrend(trend: IntegrityTrend): string | undefined {
  if (trend.direction === 'stable') return undefined;
  return `점수 ${trend.firstScore}→${trend.lastScore} (${trend.direction}, 최저 ${trend.worstScore})`;
}

// 품질 관리 노트(감마): CI/배포 파이프라인이 한 줄로 호출하는 품질 게이트.
// 점수 하한을 넘기면 true(통과), 아니면 false — 가드 절 형태로 쓰이도록 단순하게.
// 기본 하한 80 은 "결함 소량은 허용하지만 파이프라인 붕괴 수준은 막자" 경험칙.
// total=0 일 때는 computeIntegrityScore 가 100 을 돌려주므로 비어있는 배치가 게이트를
// 거짓으로 통과하는 현상은 호출 측에서 별도로 의미 있는 최소 샘플 수를 검사해야 한다.
export function passesQualityGate(
  integrity: ReturnType<typeof computeIntegrity>,
  total: number,
  minScore: number = 80
): boolean {
  return computeIntegrityScore(integrity, total) >= minScore;
}

// 개발자 노트: 버그 리포트 직렬화.
// 필터가 의도대로 동작하지 않을 때 이슈 트래커에 그대로 붙여 넣을 수 있는
// JSON 스냅샷을 생성한다. 로그 본문은 포함하지 않아 재현 컨텍스트 보존과
// 개인정보 최소화를 동시에 달성한다.
// 품질 관리 확장: severity 판정과 쿼리 정적 경고를 함께 실어, 트리아지 담당자가
// "사용자 입력 결함" vs "상류 데이터 결함" 을 한눈에 분리할 수 있게 한다.
export type LogFilterBugReport = {
  query: string;
  parsedSummary: {
    terms: string[];
    phrases: string[];
    excludeTerms: string[];
    regexes: string[];
    excludeRegexes: string[];
    from?: string;
    to?: string;
    excludeFrom?: string;
    excludeTo?: string;
    sinceMinutes?: number;
  };
  explanation?: string;
  diagnosis: QueryDiagnosis;
  integrity: ReturnType<typeof computeIntegrity>;
  integritySeverity: IntegritySeverity;
  // 품질 관리 확장: 정규화된 0~100 점수와 거절 사유 히스토그램을 동봉.
  // 트리아지 담당자가 "얼마나 심각한지(점수)"와 "무엇부터 고칠지(사유)"를 즉시 판별하도록.
  integrityScore: number;
  rejectReasons: Record<LogEntryRejectReason, number>;
  sanityWarnings: QuerySanityWarning[];
  sampledSenders: string[];
  logCount: number;
  generatedAt: string;
  // 개발자 노트: 재현용 URL 해시.
  // 트리아지 담당자가 이슈 첨부본을 눌러 동일한 쿼리 상태를 즉시 재현할 수 있도록
  // encodeQueryToHash 결과를 동봉한다. 본문 쿼리와 중복되지만, 해시 포맷이
  // 붙여넣기 스니펫에 더 편리하다(공백/특수문자 이스케이프가 이미 적용).
  shareableHash: string;
};

// 연구원 노트: 쿼리 히스토리 훅.
// - 영속성: loadQueryHistory/pushQueryHistory를 통해 localStorage와 소프트 동기화.
// - 커서 탐색: ↑(older) / ↓(newer)로 최근 쿼리를 거슬러 본다. newer가 맨 앞까지 올라오면 빈 문자열 반환.
// - commit(value): 현재 값을 히스토리에 기록하고 커서를 리셋. 빈 값/직전 항목과 동일하면 생략.
// - current를 비교해 사용자가 직접 타이핑하면 커서를 무효화 (탐색 중 수정하면 탐색 흐름 초기화).
export function useQueryHistory(current: string = ''): {
  history: string[];
  commit: (value: string) => void;
  older: () => string | undefined;
  newer: () => string | undefined;
  clear: () => void;
} {
  const [history, setHistory] = useState<string[]>(() => loadQueryHistory());
  const [cursor, setCursor] = useState<number>(-1);

  const commit = React.useCallback((value: string) => {
    const v = value.trim();
    if (!v) return;
    setHistory(prev => {
      if (prev[0] === v) return prev;
      return pushQueryHistory(prev, v);
    });
    setCursor(-1);
  }, []);

  useEffect(() => {
    if (cursor >= 0 && history[cursor] !== current) setCursor(-1);
  }, [current, cursor, history]);

  const older = React.useCallback((): string | undefined => {
    if (history.length === 0) return undefined;
    const next = Math.min(cursor + 1, history.length - 1);
    setCursor(next);
    return history[next];
  }, [cursor, history]);

  const newer = React.useCallback((): string | undefined => {
    if (cursor <= 0) {
      setCursor(-1);
      return '';
    }
    const n = cursor - 1;
    setCursor(n);
    return history[n];
  }, [cursor, history]);

  const clear = React.useCallback(() => {
    try {
      if (typeof window !== 'undefined') window.localStorage.removeItem(HISTORY_KEY);
    } catch {
      // 스토리지 실패는 소프트 페일.
    }
    setHistory([]);
    setCursor(-1);
  }, []);

  return { history, commit, older, newer, clear };
}

export function buildBugReport(logs: LogEntry[], query: string): LogFilterBugReport {
  const parsed = parseQuery(query);
  const diagnosis = diagnoseQuery(logs, parsed);
  // 품질 관리 노트: computeIntegrity는 O(n)이므로 대형 로그에서 결코 저렴하지 않다.
  // integrity 필드와 severity 판정이 같은 스냅샷을 공유하도록 한 번만 계산해 재사용한다.
  const integrity = computeIntegrity(logs);
  const senders = new Set<string>();
  for (const l of logs) if (validateLogEntry(l)) senders.add(l.from);
  return {
    query,
    parsedSummary: {
      terms: parsed.terms,
      phrases: parsed.phrases,
      excludeTerms: parsed.excludeTerms,
      regexes: parsed.regexes.map(r => r.source),
      excludeRegexes: parsed.excludeRegexes.map(r => r.source),
      from: parsed.from,
      to: parsed.to,
      excludeFrom: parsed.excludeFrom,
      excludeTo: parsed.excludeTo,
      sinceMinutes: parsed.sinceMinutes,
    },
    explanation: explainQuery(parsed),
    diagnosis,
    integrity,
    integritySeverity: integritySeverity(integrity).level,
    integrityScore: computeIntegrityScore(integrity, logs.length),
    rejectReasons: rejectReasonHistogram(logs),
    sanityWarnings: detectQuerySanity(query),
    sampledSenders: Array.from(senders).sort().slice(0, 20),
    logCount: logs.length,
    generatedAt: new Date().toISOString(),
    shareableHash: encodeQueryToHash(query),
  };
}

// 개발자 노트: 이슈 트래커/슬랙 스니펫용 단일 블록 직렬화.
// JSON 은 기계 친화적이지만 사람이 훑기엔 길다.
// 담당자가 한 번에 "쿼리/점수/상위 용의 제약/경고" 를 읽도록
// 가장 상단 3~5줄에 핵심 요약을 올리고 상세는 아래로 밀어 둔다.
// 본문 로그를 포함하지 않는 buildBugReport 의 개인정보 최소화 규약을 그대로 승계.
export function formatBugReport(report: LogFilterBugReport): string {
  const lines: string[] = [];
  lines.push(`쿼리: ${report.query || '(빈 입력)'}`);
  lines.push(`표시: ${report.diagnosis.originalShown}/${report.diagnosis.totalSafe} (원본 ${report.logCount}건)`);
  lines.push(`무결성: ${report.integrityScore}/100 · ${report.integritySeverity}`);
  if (report.explanation) lines.push(`해석: ${report.explanation}`);
  if (report.shareableHash) lines.push(`재현: ${report.shareableHash}`);

  if (report.sanityWarnings.length > 0) {
    lines.push('쿼리 경고:');
    for (const w of report.sanityWarnings) lines.push(`  - [${w.kind}] ${w.detail}`);
  }

  const topSuspects = report.diagnosis.suspects.slice(0, 3);
  if (topSuspects.length > 0) {
    lines.push('상위 용의 제약:');
    for (const s of topSuspects) lines.push(`  - ${s.constraint} 제거 시 +${s.droppedBy}건`);
  }

  // 0 인 카운터는 노이즈이므로 생략 — 담당자 스캔 부담을 줄인다.
  const integrityPairs: Array<[string, number]> = [
    ['invalid', report.integrity.invalidCount],
    ['duplicateId', report.integrity.duplicateIdCount],
    ['oversized', report.integrity.oversizedTextCount],
    ['future', report.integrity.futureTimestampCount],
    ['empty', report.integrity.emptyTextCount],
  ];
  const nonZero = integrityPairs.filter(([, n]) => n > 0);
  if (nonZero.length > 0) {
    lines.push('무결성 카운터:');
    for (const [k, n] of nonZero) lines.push(`  - ${k}: ${n}`);
  }

  lines.push(`생성 시각: ${report.generatedAt}`);
  return lines.join('\n');
}

// 개발자 노트: GitHub 이슈/PR 본문 붙여넣기용 마크다운 포맷.
// formatBugReport 가 Slack/채팅용 평문이라면, 이 함수는 이슈 트래커의 접기·표·코드블록을
// 활용해 담당자가 한눈에 훑을 수 있게 구조화한다. 쿼리·재현 해시는 코드블록으로 감싸
// 붙여넣기 시 마크다운 문자(*, _)가 의도치 않게 해석되는 사고를 막는다.
// 무결성 카운터는 0 인 행을 숨겨 시그널 대 노이즈 비를 유지하고, 긴 섹션(원인·경고)은
// <details> 로 접어 이슈 상단 요약을 짧게 지킨다.
export function formatBugReportMarkdown(report: LogFilterBugReport): string {
  const lines: string[] = [];
  lines.push(`### 로그 필터 리포트`);
  lines.push('');
  lines.push(`- **쿼리**: \`${report.query || '(빈 입력)'}\``);
  lines.push(
    `- **표시**: ${report.diagnosis.originalShown}/${report.diagnosis.totalSafe} (원본 ${report.logCount}건)`
  );
  lines.push(`- **무결성**: ${report.integrityScore}/100 · ${report.integritySeverity}`);
  if (report.explanation) lines.push(`- **해석**: ${report.explanation}`);
  if (report.shareableHash) lines.push(`- **재현**: \`${report.shareableHash}\``);
  lines.push(`- **생성 시각**: ${report.generatedAt}`);

  const topSuspects = report.diagnosis.suspects.slice(0, 3);
  if (topSuspects.length > 0) {
    lines.push('');
    lines.push('<details><summary>상위 용의 제약</summary>');
    lines.push('');
    for (const s of topSuspects) {
      lines.push(`- \`${s.constraint}\` 제거 시 +${s.droppedBy}건`);
    }
    lines.push('');
    lines.push('</details>');
  }

  if (report.sanityWarnings.length > 0) {
    lines.push('');
    lines.push('<details><summary>쿼리 경고</summary>');
    lines.push('');
    for (const w of report.sanityWarnings) {
      lines.push(`- \`${w.kind}\` — ${w.detail}`);
    }
    lines.push('');
    lines.push('</details>');
  }

  const integrityPairs: Array<[string, number]> = [
    ['invalid', report.integrity.invalidCount],
    ['duplicateId', report.integrity.duplicateIdCount],
    ['oversized', report.integrity.oversizedTextCount],
    ['future', report.integrity.futureTimestampCount],
    ['empty', report.integrity.emptyTextCount],
  ];
  const nonZero = integrityPairs.filter(([, n]) => n > 0);
  if (nonZero.length > 0) {
    lines.push('');
    lines.push('| 카테고리 | 건수 |');
    lines.push('| --- | ---: |');
    for (const [k, n] of nonZero) lines.push(`| ${k} | ${n} |`);
  }

  return lines.join('\n');
}

// 개발자 노트: 알림 채널 제목/PR 제목용 한 줄 헤드라인.
// formatBugReport / formatBugReportMarkdown 은 본문용 — 헤더/알림 미리보기는 첫 줄만 보이므로
// 핵심 지표 세 개(쿼리 · 표시 비 · 무결성 점수)를 한 줄에 압축한다. 본문이 없을 때 알림 자체의
// 요약으로도 충분히 트리아지 우선순위를 매길 수 있게 설계.
// 쿼리가 너무 길면 채널 미리보기에서 잘려 오히려 혼란을 주므로 앞 40자로 자른다.
const HEADLINE_QUERY_MAX = 40;

export function summarizeBugReportHeadline(report: LogFilterBugReport): string {
  const q = report.query || '(빈 입력)';
  const truncated = q.length > HEADLINE_QUERY_MAX ? `${q.slice(0, HEADLINE_QUERY_MAX)}…` : q;
  return `쿼리 "${truncated}" · 표시 ${report.diagnosis.originalShown}/${report.diagnosis.totalSafe} · 무결성 ${report.integrityScore}/100`;
}

// 개발자 노트: 외부 공유용 리포트 리댁션.
// buildBugReport 는 본문을 포함하지 않지만, 송신자 이름이나 from:/to: 제약 값에
// 내부 에이전트·사용자 식별자가 그대로 드러날 수 있다. 공개 이슈 트래커/외부 벤더에
// 첨부할 때는 이 함수로 한 번 더 익명화해 "구조적 결함"만 남긴다.
// 익명화 후에도 diagnosis/integrity 수치는 온전히 보존되어 문제 재현·트리아지엔
// 영향을 주지 않는다.
export function redactBugReport(report: LogFilterBugReport): LogFilterBugReport {
  const mask = (s: string | undefined): string | undefined =>
    s === undefined ? undefined : `<redacted:${s.length}>`;
  return {
    ...report,
    query: report.query ? `<redacted:${report.query.length}>` : '',
    parsedSummary: {
      ...report.parsedSummary,
      from: mask(report.parsedSummary.from),
      to: mask(report.parsedSummary.to),
      excludeFrom: mask(report.parsedSummary.excludeFrom),
      excludeTo: mask(report.parsedSummary.excludeTo),
      // terms/phrases 도 자유 입력이라 익명 길이로 대체. 개수와 길이 분포는 유지.
      terms: report.parsedSummary.terms.map(t => `<redacted:${t.length}>`),
      phrases: report.parsedSummary.phrases.map(t => `<redacted:${t.length}>`),
      excludeTerms: report.parsedSummary.excludeTerms.map(t => `<redacted:${t.length}>`),
    },
    // explanation 과 shareableHash 는 쿼리 원문을 재구성 가능한 경로라 전부 제거.
    explanation: undefined,
    shareableHash: '',
    // 송신자 이름은 에이전트 식별자에 가까워 번호로 치환. 집합 크기는 분포 분석용으로 보존.
    sampledSenders: report.sampledSenders.map((_, i) => `sender-${i + 1}`),
    // sanityWarnings 의 detail 엔 사용자 입력이 포함될 수 있어 kind 만 남긴다.
    sanityWarnings: report.sanityWarnings.map(w => ({
      kind: w.kind,
      detail: '<redacted>',
    } as QuerySanityWarning)),
  };
}

// 개발자 노트: 두 버그 리포트 간 회귀 판정.
// 릴리즈 전/후 동일 쿼리를 돌려 품질 회귀를 자동 감지하려는 CI/배포 후 스모크 체크용.
// "악화" 의 정의를 한 곳에 고정해, 개별 호출자가 임계값을 제각각 정의하는 drift 를 막는다.
//   shown 감소        — 필터 규칙이 뜻밖의 로그를 쳐냄(사용자 관점 회귀)
//   integrityScore 하락 — 상류 파이프라인 악화
//   sanity 경고 증가   — 쿼리 파서/문법 회귀
// 변동이 없으면 regressed=false, 호출 측이 스킵 처리하도록 구조를 단일화.
export type BugReportDiff = {
  regressed: boolean;
  shownDelta: number;
  integrityScoreDelta: number;
  newSanityKinds: QuerySanityWarning['kind'][];
  integrityDelta: IntegrityDelta;
};

export function diffBugReports(
  before: LogFilterBugReport,
  after: LogFilterBugReport
): BugReportDiff {
  const shownDelta = after.diagnosis.originalShown - before.diagnosis.originalShown;
  const integrityScoreDelta = after.integrityScore - before.integrityScore;
  const beforeKinds = new Set(before.sanityWarnings.map(w => w.kind));
  const newSanityKinds = Array.from(
    new Set(after.sanityWarnings.map(w => w.kind).filter(k => !beforeKinds.has(k)))
  );
  const integrityDelta = computeIntegrityDelta(before.integrity, after.integrity);
  const regressed =
    shownDelta < 0 ||
    integrityScoreDelta < 0 ||
    newSanityKinds.length > 0 ||
    integrityDelta.worsened.length > 0;
  return {
    regressed,
    shownDelta,
    integrityScoreDelta,
    newSanityKinds,
    integrityDelta,
  };
}

// 품질 관리 노트: 회귀 심각도 분류.
// diffBugReports 의 boolean 만으론 CI 게이트가 "얼마나 심각한가" 를 못 읽는다.
// 배포 차단/경고/무시를 분기하려면 단계적 등급이 필요해, 동일한 색 규약(ok/notice/warn/critical)을 재사용한다.
//
// 규칙 요약:
//   - critical : 치명적 사용자 입력 결함(redundantTerm 등) 신규 출현 OR invalid/duplicateId 신규 유입
//     OR integrityScore 가 tolerance 이상 급락 OR shown 이 tolerance 이상 급감
//   - warn     : 일반적 integrity 악화(worsened 가 있음) OR 비치명 sanity 경고 신규 출현
//     OR integrityScore 가 소폭(>0) 하락
//   - notice   : shown 만 미세 감소 (tolerance 이내) — 트래픽 변동 가능성
//   - ok       : 회귀 신호 없음
//
// tolerance 는 "트래픽 변동/측정 노이즈 허용폭". CI 팀이 임계값을 조정해 플랩핑을 줄일 수 있도록 주입.
// 기본값은 경험적 — integrity 점수는 1 포인트 하락까지, shown 은 절대 건수 1 건까지 관대.
export type RegressionSeverity = IntegritySeverity;

export type BugReportRegressionClassification = {
  severity: RegressionSeverity;
  reasons: string[];
};

const CRITICAL_INTEGRITY_KEYS: IntegrityDefectKey[] = ['invalidCount', 'duplicateIdCount'];

const CRITICAL_SANITY_KINDS: QuerySanityWarning['kind'][] = [
  'redundantTerm',
  'conflictFrom',
  'conflictTo',
];

export function classifyBugReportRegression(
  diff: BugReportDiff,
  tolerance: { integrityScore?: number; shown?: number } = {}
): BugReportRegressionClassification {
  const scoreTol = tolerance.integrityScore ?? 1;
  const shownTol = tolerance.shown ?? 1;
  const reasons: string[] = [];
  let worst: RegressionSeverity = 'ok';
  const promote = (lv: RegressionSeverity) => {
    if (SEVERITY_RANK[lv] > SEVERITY_RANK[worst]) worst = lv;
  };

  const criticalSanity = diff.newSanityKinds.filter(k => CRITICAL_SANITY_KINDS.includes(k));
  if (criticalSanity.length > 0) {
    reasons.push(`치명 쿼리 경고 신규: ${criticalSanity.join(', ')}`);
    promote('critical');
  }

  const criticalIntegrity = diff.integrityDelta.newlyIntroduced.filter(k =>
    CRITICAL_INTEGRITY_KEYS.includes(k)
  );
  if (criticalIntegrity.length > 0) {
    reasons.push(`치명 무결성 결함 신규: ${criticalIntegrity.join(', ')}`);
    promote('critical');
  }

  if (diff.integrityScoreDelta < -scoreTol) {
    reasons.push(`무결성 점수 급락 ${diff.integrityScoreDelta}`);
    promote('critical');
  } else if (diff.integrityScoreDelta < 0) {
    reasons.push(`무결성 점수 하락 ${diff.integrityScoreDelta}`);
    promote('warn');
  }

  if (diff.shownDelta < -shownTol) {
    reasons.push(`표시 건수 급감 ${diff.shownDelta}`);
    promote('critical');
  } else if (diff.shownDelta < 0) {
    reasons.push(`표시 건수 미세 감소 ${diff.shownDelta}`);
    promote('notice');
  }

  const nonCriticalNewSanity = diff.newSanityKinds.filter(k => !CRITICAL_SANITY_KINDS.includes(k));
  if (nonCriticalNewSanity.length > 0) {
    reasons.push(`쿼리 경고 신규: ${nonCriticalNewSanity.join(', ')}`);
    promote('warn');
  }

  if (diff.integrityDelta.worsened.length > 0) {
    const keys = diff.integrityDelta.worsened.map(w => w.key).join(', ');
    reasons.push(`무결성 악화: ${keys}`);
    promote('warn');
  }

  return { severity: worst, reasons };
}

// 개발자 노트: 쿼리 <-> URL 해시 양방향 동기화 훅.
// encodeQueryToHash/decodeQueryFromHash 는 순수 함수만 제공했지, 실제 브라우저 해시와
// 이어 붙여 주는 주체가 없어 "공유 URL" 기능이 반쪽이었다. 이 훅이 그 공백을 메운다.
//
// 동기화 규칙:
//   1) 최초 마운트 시 URL 해시에 쿼리가 있으면 호출 측 상태로 반영(setQuery).
//   2) 그 이후 query가 바뀌면 history.replaceState 로 해시만 갱신(스크롤/히스토리 폭주 방지).
//   3) 외부에서 뒤로가기/앞으로가기로 hash 가 변하면 setQuery 로 되돌려 동기화 유지.
//   4) SSR/비브라우저 환경에선 전부 no-op — typeof window 가드로 soft-fail.
//
// 왜 replaceState 인가: 사용자가 한 글자 칠 때마다 pushState 를 쓰면 뒤로가기가 한 글자씩
// 되돌아가는 끔찍한 UX가 된다. "쿼리는 현재 뷰의 파생 상태" 라는 의미에서 replace 가 적절.
export function useQueryHashSync(
  query: string,
  setQuery: (q: string) => void
): void {
  const appliedInitialRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (appliedInitialRef.current) return;
    appliedInitialRef.current = true;
    const initial = decodeQueryFromHash(window.location.hash);
    if (initial !== undefined && initial !== query) {
      setQuery(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!appliedInitialRef.current) return;
    const nextHash = encodeQueryToHash(query);
    const currentHash = window.location.hash || '';
    if (nextHash === currentHash) return;
    // 쿼리가 비면 URL 에 #logq= 꼬리만 남지 않도록 해시 자체를 제거.
    const url = nextHash
      ? `${window.location.pathname}${window.location.search}${nextHash}`
      : `${window.location.pathname}${window.location.search}`;
    try {
      window.history.replaceState(null, '', url);
    } catch {
      // SecurityError(파일 프로토콜 등) 시 조용히 폴백 — 메인 입력 흐름은 절대 막지 않는다.
    }
  }, [query]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHashChange = () => {
      const decoded = decodeQueryFromHash(window.location.hash);
      if (decoded !== undefined && decoded !== query) {
        setQuery(decoded);
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [query, setQuery]);
}

// 개발자 노트: 쿼리 자동 보정 제안.
// detectQuerySanity 가 "뭐가 틀렸나" 를 알려준다면, 이 함수는 "어떻게 고칠까" 를 제안한다.
// 원본을 직접 치환하는 대신 후보 문자열을 돌려주므로 UI 는 "이렇게 고칠까요?" 토스트로
// 제시하고 사용자가 승낙할 때만 onQueryChange 에 주입하면 된다 — 사용자 입력을 몰래
// 바꾸지 않는다는 쿼리창의 일관된 규약을 유지하기 위함.
//
// 적용 규칙:
//   1) 닫히지 않은 큰따옴표가 하나라면 문자열 끝에 "를 덧붙인다(짝 홀수 -> 짝수).
//   2) 슬래시로 시작했는데 닫히지 않은 정규식 토큰은 원본에서 제거한다(파서가 이미 조용히
//      버리는 토큰이지만, 눈에 보이는 원문에 남아 있으면 사용자가 "왜 무시되지?" 로 헤맨다).
//   3) 빈 정규식 "//" 토큰은 제거(모든 로그 매치는 필터 취지를 무너뜨린다).
//   4) 포함/제외에 동시에 나타난 토큰은 제외 쪽을 남기고 포함 쪽을 지운다
//      — 제외의 의도가 더 명확한 "배제" 신호라고 본다.
//   5) 서로 상쇄되는 from/to(- 쌍)는 제외 쪽을 유지하고 긍정 쪽을 지운다(규칙 4와 동일 논리).
//
// changes 는 사람이 읽을 로그 — 토스트/툴팁에 그대로 뿌릴 수 있도록 한국어 한 줄 문장.
export type QueryFixSuggestion = {
  fixed: string;
  changes: string[];
};

export function suggestQueryFix(raw: string): QueryFixSuggestion {
  const changes: string[] = [];
  if (!raw || raw.trim().length === 0) {
    return { fixed: raw, changes };
  }

  // 1) 닫히지 않은 따옴표: 끝에 덧붙여 한 번에 닫는다.
  let working = raw;
  const quoteCount = (working.match(/"/g) ?? []).length;
  if (quoteCount % 2 === 1) {
    working = `${working}"`;
    changes.push('닫히지 않은 큰따옴표를 끝에 자동으로 추가했습니다');
  }

  // 2·3) 토큰 단위 정리. 원문 공백 구분을 유지하기 위해 tokenize 결과를 기반으로 재조립.
  const keptTokens: string[] = [];
  for (const tok of tokenize(working)) {
    const negated = tok.startsWith('-');
    const bare = negated ? tok.slice(1) : tok;
    if (bare.startsWith('/')) {
      if (bare.length === 2) {
        changes.push('빈 정규식 "//" 토큰을 제거했습니다');
        continue;
      }
      if (!bare.endsWith('/') || bare.length < 3) {
        changes.push(`닫히지 않은 정규식 토큰 "${tok}" 을 제거했습니다`);
        continue;
      }
    }
    keptTokens.push(tok);
  }

  // 4·5) 파서 결과를 보며 상쇄 제약을 정리. 원문이 아닌 토큰 리스트 수준에서 제거해
  //      tokenize 가 남긴 인용부호/슬래시 등 원형을 그대로 보존한다.
  const parsed = parseQuery(keptTokens.join(' '));
  const redundantTerms = new Set(
    parsed.terms.filter(t => parsed.excludeTerms.includes(t))
  );
  const conflictingFrom =
    parsed.from && parsed.excludeFrom && parsed.from === parsed.excludeFrom
      ? parsed.from
      : undefined;
  const conflictingTo =
    parsed.to && parsed.excludeTo && parsed.to === parsed.excludeTo
      ? parsed.to
      : undefined;

  const finalTokens: string[] = [];
  for (const tok of keptTokens) {
    const negated = tok.startsWith('-');
    const bare = negated ? tok.slice(1) : tok;
    const lower = bare.toLowerCase();

    // 포함 쪽 중복 텀: 긍정형(negated=false)만 드랍.
    if (!negated && redundantTerms.has(lower)) {
      changes.push(`포함/제외에 동시 존재하던 "${lower}" 중 포함 쪽을 제거했습니다`);
      continue;
    }

    // 긍정 from:/to: 가 동일값의 -from:/-to: 와 충돌하면 긍정 쪽을 드랍.
    if (!negated && conflictingFrom && lower === `from:${conflictingFrom}`) {
      changes.push(`from:${conflictingFrom} 과 -from:${conflictingFrom} 충돌 — 긍정 쪽을 제거했습니다`);
      continue;
    }
    if (!negated && conflictingTo && lower === `to:${conflictingTo}`) {
      changes.push(`to:${conflictingTo} 과 -to:${conflictingTo} 충돌 — 긍정 쪽을 제거했습니다`);
      continue;
    }

    finalTokens.push(tok);
  }

  return { fixed: finalTokens.join(' '), changes };
}

// 개발자 노트(kai): 클립보드 쓰기를 한 곳으로 모은다.
// 버그 리포트 복사와 아래 공유 URL 복사가 동일한 폴백 로직을 복붙하고 있으면,
// 한 쪽만 손보고 다른 쪽을 잊는 사고가 언젠가 반드시 난다. "텍스트를 복사한다"는
// 단일 책임만 이 함수가 갖게 하고, 호출 측은 포맷 결정에만 집중한다.
async function writeTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // 폴백: execCommand 는 deprecated 지만 권한 체계가 없는 환경에서 유일한 대안.
  if (typeof document !== 'undefined') {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } finally {
      document.body.removeChild(ta);
    }
    return;
  }
  throw new Error('clipboard unavailable');
}

// 개발자 노트: 버그 리포트 원클릭 복사.
// 트리아지 채널에 붙여 넣기 좋은 포맷으로 생성한 뒤 navigator.clipboard 로 즉시 복사한다.
// 반환 Promise 는 성공 시 복사된 문자열을, 실패 시 reject — 호출 측이 토스트/알림을 결정.
export async function copyBugReportToClipboard(
  logs: LogEntry[],
  query: string
): Promise<string> {
  const text = formatBugReport(buildBugReport(logs, query));
  await writeTextToClipboard(text);
  return text;
}

// 개발자 노트(kai): 공유 URL 조립.
// encodeQueryToHash 는 "#logq=..." 프래그먼트만 만들 뿐, 공유 가능한 URL 전체를 조립해 주진
// 않았다. Slack 에 붙여 넣을 때마다 팀원이 수동으로 현재 URL 을 베껴 오는 실수를 봤다 —
// 해시는 같은데 경로가 틀려 재현이 안 되는 케이스. 이 함수가 그 공백을 메운다.
//
// 설계 규칙:
//   1) baseUrl 의 기존 해시는 버린다 — 동일 쿼리가 여러 해시로 공유되는 혼선 방지.
//   2) 쿼리가 비면 해시 자체를 떼어 "기본 뷰" URL 을 반환 (#logq= 꼬리 금지).
//   3) 순수 함수 — 브라우저 환경을 요구하지 않아 SSR/테스트에서 바로 호출 가능.
export function buildShareableQueryUrl(baseUrl: string, query: string): string {
  const hashIdx = baseUrl.indexOf('#');
  const root = hashIdx >= 0 ? baseUrl.slice(0, hashIdx) : baseUrl;
  const hash = encodeQueryToHash(query);
  return hash ? `${root}${hash}` : root;
}

// 개발자 노트: 현재 쿼리를 공유 URL 로 만들어 즉시 복사한다.
// 브라우저 외부 환경에선 throw — 조용한 실패는 금지, 호출 측이 토스트로 잡는다.
// 반환값은 복사된 URL 로, 성공 토스트에서 "복사됨: {url}" 표시에 활용할 수 있다.
export async function copyShareableQueryUrl(query: string): Promise<string> {
  if (typeof window === 'undefined') throw new Error('window unavailable');
  const base = `${window.location.origin}${window.location.pathname}${window.location.search}`;
  const url = buildShareableQueryUrl(base, query);
  await writeTextToClipboard(url);
  return url;
}

export const __test__ = {
  parseQuery,
  matches,
  tokenize,
  parseSinceToMinutes,
  logMinuteOfDay,
  safeCompileRegex,
  computeTopSender,
  computeSenderDistribution,
  computeAvgTextLength,
  computeInteractionPairs,
  computeTimeHistogram,
  computeBurstiness,
  computeSilenceGaps,
  validateLogEntry,
  computeIntegrity,
  summarizeIntegrity,
  MAX_TEXT_LENGTH,
  highlightTokens,
  splitByHighlight,
  diagnoseQuery,
  explainQuery,
  integritySeverity,
  buildBugReport,
  formatBugReport,
  formatBugReportMarkdown,
  summarizeBugReportHeadline,
  detectQuerySanity,
  sanityWarningSeverity,
  worstSanitySeverity,
  computeFilterHealth,
  isIntegrityHealthy,
  pushQueryHistory,
  QUERY_HISTORY_MAX,
  DENSITY_TOKENS,
  MAX_SINCE_MINUTES,
  QUERY_PRESETS,
  classifyLogEntry,
  rejectReasonHistogram,
  computeIntegrityScore,
  mergeIntegrity,
  integrityDefectCategories,
  computeIntegrityDelta,
  formatIntegrityDelta,
  encodeQueryToHash,
  decodeQueryFromHash,
  copyBugReportToClipboard,
  buildShareableQueryUrl,
  copyShareableQueryUrl,
  suggestQueryFix,
  sanityWarningHistogram,
  redactBugReport,
  diffBugReports,
  classifyBugReportRegression,
  computeIntegrityTrend,
  formatIntegrityTrend,
  passesQualityGate,
};
