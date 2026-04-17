/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * docs/inbox/*.md 의 지시(directive) 블록을 순수 데이터로 파싱하고
 * 위임/단독 비율 등 감사 지표를 계산한다. 파일 I/O 없음 — 호출 측이 md 본문을 주입한다.
 * 의존성 0 원칙: 정규식 기반.
 */

export type DirectiveStatus = 'open' | 'wip' | 'done' | 'blocked';

export interface DirectiveEntry {
  /** 블록 헤더의 `[...]` 안 원문 (예: "tick=now", "10:22 tick=3"). */
  tick: string;
  /** 블록 제목 (지시 요지). */
  digest: string;
  /** 큰따옴표 안 원문 프롬프트. 누락 시 빈 문자열. */
  originalPrompt: string;
  /** 위임 절에서 추출한 docs/handoffs/*.md 경로들. */
  handoffs: string[];
  /** "알파 자체 처리분" 본문. 없으면 "없음". 절 자체가 누락이면 빈 문자열. */
  alphaSolo: string;
  status: DirectiveStatus;
  /** 호출 측이 알려준 출처 파일 경로. */
  sourcePath: string;
}

const KNOWN_STATUSES: ReadonlyArray<DirectiveStatus> = ['open', 'wip', 'done', 'blocked'];

const HANDOFF_PATH_RE = /docs\/handoffs\/[A-Za-z0-9._/-]+\.md/g;

// `### [...] digest` 헤더로 분할. 분해/위임 본문에 ### 가 없는 점에 의존.
export function parseDirectiveBlocks(md: string, sourcePath: string): DirectiveEntry[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const entries: DirectiveEntry[] = [];
  let current: string[] | null = null;

  const flush = () => {
    if (!current || current.length === 0) return;
    const entry = parseSingleBlock(current, sourcePath);
    if (entry) entries.push(entry);
    current = null;
  };

  for (const line of lines) {
    if (/^###\s+\[/.test(line)) {
      flush();
      current = [line];
    } else if (current) {
      // 다음 ### (인박스 외 다른 H3) 가 나오면 블록 종료.
      if (/^###\s/.test(line)) {
        flush();
        continue;
      }
      current.push(line);
    }
  }
  flush();
  return entries;
}

function parseSingleBlock(lines: string[], sourcePath: string): DirectiveEntry | null {
  const header = lines[0];
  const headerMatch = header.match(/^###\s+\[([^\]]*)\]\s*(.*)$/);
  if (!headerMatch) return null;
  const tick = headerMatch[1].trim();
  const digest = headerMatch[2].trim();
  if (!digest) return null;

  const body = lines.slice(1).join('\n');

  return {
    tick,
    digest,
    originalPrompt: extractPrompt(body),
    handoffs: extractHandoffs(body),
    alphaSolo: extractField(body, '알파 자체 처리분'),
    status: normalizeStatus(extractField(body, '상태')),
    sourcePath,
  };
}

// `- **원문 프롬프트**: "..."` 의 큰따옴표 안 본문. 따옴표 누락 시 콜론 뒤 트림.
function extractPrompt(body: string): string {
  const line = findFieldLine(body, '원문 프롬프트');
  if (!line) return '';
  const quoted = line.match(/"([\s\S]*?)"/);
  if (quoted) return quoted[1];
  return line.replace(/^[^:]*:\s*/, '').trim();
}

// 위임 절(다음 `- **` 항목 전까지) 안의 모든 docs/handoffs/*.md 경로.
function extractHandoffs(body: string): string[] {
  const section = extractSection(body, '위임');
  if (!section) return [];
  const matches = section.match(HANDOFF_PATH_RE);
  if (!matches) return [];
  // 중복 제거 + 입력 순서 보존.
  return Array.from(new Set(matches));
}

// `- **<label>**: <value>` 단일 라인 값 (멀티라인 절은 alphaSolo 처럼 첫 줄 + 이어지는 비필드 라인).
function extractField(body: string, label: string): string {
  const section = extractSection(body, label);
  if (!section) return '';
  // 라벨 라인 뒤를 잘라낸 본문.
  const headLine = section.split('\n')[0] ?? '';
  const inline = headLine.replace(/^\s*-\s*\*\*[^*]+\*\*\s*:\s*/, '').trim();
  const rest = section.split('\n').slice(1).join('\n').trim();
  return rest ? (inline ? `${inline}\n${rest}` : rest) : inline;
}

function findFieldLine(body: string, label: string): string | null {
  const re = new RegExp(`^\\s*-\\s*\\*\\*${escapeRe(label)}\\*\\*\\s*:.*$`, 'm');
  const m = body.match(re);
  return m ? m[0] : null;
}

// 라벨 항목의 본문(다음 `- **` 라벨 또는 블록 끝까지)을 잘라 반환.
function extractSection(body: string, label: string): string | null {
  const lines = body.split('\n');
  const startRe = new RegExp(`^\\s*-\\s*\\*\\*${escapeRe(label)}\\*\\*\\s*:`);
  const nextLabelRe = /^\s*-\s*\*\*[^*]+\*\*\s*:/;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (nextLabelRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeStatus(raw: string): DirectiveStatus {
  if (!raw) return 'open';
  // "done (베타 회신 검수 대기)" 같은 꼬리표를 잘라낸다.
  const head = raw.toLowerCase().split(/[\s(（]/)[0]?.trim() ?? '';
  if ((KNOWN_STATUSES as ReadonlyArray<string>).includes(head)) {
    return head as DirectiveStatus;
  }
  return 'open';
}

export interface RoutingSummary {
  total: number;
  /** handoffs.length >= 1 인 블록 수. */
  delegated: number;
  /** handoffs.length === 0 인 블록 수 (단독 처리). */
  soloOnly: number;
  /** 단독 처리 중 `알파 자체 처리분`이 "없음"이 아닌 케이스 (예외 사유 명시). */
  soloWithException: number;
  /** delegated / total. total=0 이면 0. */
  delegationRate: number;
}

export function summarizeDirectiveRouting(
  entries: ReadonlyArray<DirectiveEntry>,
): RoutingSummary {
  const total = entries.length;
  let delegated = 0;
  let soloOnly = 0;
  let soloWithException = 0;
  for (const e of entries) {
    if (e.handoffs.length >= 1) {
      delegated += 1;
    } else {
      soloOnly += 1;
      if (e.alphaSolo && e.alphaSolo.trim() !== '없음') {
        soloWithException += 1;
      }
    }
  }
  return {
    total,
    delegated,
    soloOnly,
    soloWithException,
    delegationRate: total === 0 ? 0 : delegated / total,
  };
}

export interface SoloViolation {
  rate: number;
  violations: DirectiveEntry[];
  thresholdExceeded: boolean;
}

/**
 * 라우팅 매트릭스에서 'forbidden'(❌)으로 분류된 지시 중 단독 처리된 비율.
 * windowSize 만큼 최근 entries 만 검사한다 (호출 측이 정렬을 보장해야 한다).
 * 임계 0.2 초과 시 thresholdExceeded=true.
 */
export function computeSoloViolationRate(
  entries: ReadonlyArray<DirectiveEntry>,
  routingHits: ReadonlyMap<string, 'forbidden' | 'allowed'>,
  windowSize = 30,
): SoloViolation {
  const window = entries.slice(0, Math.max(0, windowSize));
  const forbidden = window.filter((e) => routingHits.get(e.digest) === 'forbidden');
  if (forbidden.length === 0) {
    return { rate: 0, violations: [], thresholdExceeded: false };
  }
  const violations = forbidden.filter((e) => e.handoffs.length === 0);
  const rate = violations.length / forbidden.length;
  return { rate, violations, thresholdExceeded: rate > 0.2 };
}

export interface DirectiveDigestPayload {
  today: string;
  total: number;
  delegated: number;
  soloWithException: number;
  inboxPath: string;
  latestEntries: ReadonlyArray<{ digest: string; status: DirectiveStatus }>;
  /** 위임률. summarizeDirectiveRouting 의 delegationRate 와 동일값. */
  delegationRate?: number;
  /** ❌ 단독 처리율. routingHits 가 제공된 경우에만 채워진다. */
  forbiddenSoloRate?: number;
  /** 단독 처리율 임계. 기본 0.2. */
  forbiddenSoloThreshold?: number;
  /** linked_directive 가 비어 있는 HANDOFF 수. 외부에서 카운트해 주입한다. */
  orphanHandoffCount?: number;
}

/**
 * AgentStatusPanel 의 `DirectiveDigest` 가 요구하는 얕은 요약 페이로드를 조립한다.
 * 라우팅 집계(summarizeDirectiveRouting)와 최근 N건 압축을 한 번에 처리해 호출 측이
 * 같은 조립 로직을 재구현하지 않게 한다. entries 는 신규 → 과거 순으로 들어온다고 가정.
 * routingHits·orphanHandoffCount 는 선택 인자 — AgentStatusPanel §④ 협업 지표 블록에
 * 필요하지만 외부 문서 의존성이라 생략 가능하게 열어 둔다.
 */
export function buildDirectiveDigest(
  entries: ReadonlyArray<DirectiveEntry>,
  opts: {
    today: string;
    inboxPath: string;
    limit?: number;
    routingHits?: ReadonlyMap<string, 'forbidden' | 'allowed'>;
    orphanHandoffCount?: number;
    forbiddenSoloThreshold?: number;
  },
): DirectiveDigestPayload {
  const { today, inboxPath } = opts;
  const limit = Math.max(0, opts.limit ?? 3);
  const summary = summarizeDirectiveRouting(entries);
  const latestEntries = entries
    .slice(0, limit)
    .map((e) => ({ digest: e.digest, status: e.status }));
  const soloViolation = opts.routingHits
    ? computeSoloViolationRate(entries, opts.routingHits)
    : null;
  return {
    today,
    total: summary.total,
    delegated: summary.delegated,
    soloWithException: summary.soloWithException,
    inboxPath,
    latestEntries,
    delegationRate: summary.delegationRate,
    forbiddenSoloRate: soloViolation ? soloViolation.rate : undefined,
    forbiddenSoloThreshold: opts.forbiddenSoloThreshold ?? 0.2,
    orphanHandoffCount: opts.orphanHandoffCount,
  };
}
