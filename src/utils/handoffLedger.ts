/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * docs/handoffs/*.md · docs/reports/*.md의 frontmatter를 읽어 협업 타임라인용
 * pure 데이터 구조로 변환한다. UI는 이 결과만 받으며 파일 I/O를 직접 하지 않는다.
 * 의존성 0 원칙 — gray-matter 등 외부 라이브러리 대신 정규식 기반 파서를 사용한다.
 */

export type HandoffStatus = 'open' | 'wip' | 'done' | 'blocked';

export interface LedgerEntry {
  /** 파일 경로에서 파생된 고유 ID (슬러그). */
  id: string;
  kind: 'handoff' | 'report';
  status: HandoffStatus;
  /** 알 수 없는 status 값일 때 true (UI에서 경고 칩 표기용). */
  statusFallback?: boolean;
  from: string;
  to: string;
  /** YYYY-MM-DD. 파싱 실패 시 빈 문자열. */
  opened: string;
  /** REPORT의 경우 대응되는 handoff 파일 상대경로. */
  origin?: string;
  /** HANDOFF/REPORT 한 줄에서 추출한 짧은 설명(slug). */
  slug: string;
  path: string;
  /**
   * frontmatter `linked_directive:` 필드 원본 값. 인박스 지시 블록 경로(+앵커)를 가리킨다.
   * 필드가 없으면 undefined (해당 레코드는 orphan 으로 분류).
   */
  linkedDirective?: string;
  /** frontmatter `retroactive: true` 여부. v2 인박스 시행 이전 생성분을 표시하는 플래그. */
  retroactive?: boolean;
  /**
   * linked_directive 필드가 없으면 true. CollabTimeline·AgentStatusPanel 에서
   * "원본 지시 유실" 칩을 띄워 회수 대상을 가시화한다.
   * 근거: docs/handoffs/2026-04-17-alpha-to-beta-collab-audit.md §⑤.
   */
  orphan: boolean;
}

const KNOWN_STATUSES: ReadonlyArray<HandoffStatus> = ['open', 'wip', 'done', 'blocked'];

// YAML frontmatter를 단순 키:값 쌍으로 파싱. 중첩/배열/다중 행 값은 지원하지 않음.
// 협업 프로토콜 frontmatter는 스칼라 필드만 쓰므로 충분.
export function parseFrontmatter(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return out;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// HANDOFF 또는 REPORT 한 줄에서 slug(두 번째 `::` 세그먼트)를 뽑아온다.
// 실패 시 빈 문자열.
export function extractSlug(raw: string): string {
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('HANDOFF') || l.startsWith('REPORT'));
  if (!line) return '';
  const parts = line.split('::').map((p) => p.trim());
  return parts[1] ?? '';
}

function normalizeStatus(raw: string | undefined): { status: HandoffStatus; fallback: boolean } {
  if (!raw) return { status: 'open', fallback: true };
  const lower = raw.toLowerCase().trim();
  if ((KNOWN_STATUSES as ReadonlyArray<string>).includes(lower)) {
    return { status: lower as HandoffStatus, fallback: false };
  }
  // "In Progress", "WIP" 등 변형은 open으로 폴백하되 경고 플래그를 세운다 (§6.4).
  return { status: 'open', fallback: true };
}

export interface ParseInput {
  path: string;
  kind: 'handoff' | 'report';
  content: string;
}

// "true"/"false" 문자열을 boolean 으로. 그 외 값은 undefined(미지정).
function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const lower = raw.toLowerCase().trim();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  return undefined;
}

export function parseEntry(input: ParseInput): LedgerEntry {
  const fm = parseFrontmatter(input.content);
  const { status, fallback } = normalizeStatus(fm.status);
  const slug = extractSlug(input.content);
  const id = input.path.replace(/\\/g, '/').replace(/^.*\/([^/]+)\.md$/, '$1') || input.path;
  const linkedDirective = fm.linked_directive || undefined;
  const retroactive = parseBoolean(fm.retroactive);
  // report 는 상위 handoff 를 통해 이미 라우팅이 입증되므로 orphan 판정에서 제외한다.
  // handoff 중 linked_directive 가 비어 있는 경우만 "원본 유실" 로 본다.
  const orphan = input.kind === 'handoff' && !linkedDirective;
  return {
    id,
    kind: input.kind,
    status,
    statusFallback: fallback || undefined,
    from: fm.from || '(미배정)',
    to: fm.to || '(미배정)',
    opened: fm.opened || '',
    origin: fm.origin || undefined,
    slug,
    path: input.path,
    linkedDirective,
    retroactive: retroactive || undefined,
    orphan,
  };
}

export interface LedgerSummary {
  open: number;
  wip: number;
  done: number;
  blocked: number;
  total: number;
}

export function summarize(entries: ReadonlyArray<LedgerEntry>): LedgerSummary {
  const s: LedgerSummary = { open: 0, wip: 0, done: 0, blocked: 0, total: entries.length };
  for (const e of entries) s[e.status] += 1;
  return s;
}

// opened(YYYY-MM-DD) 내림차순. 같은 날짜면 report가 handoff보다 먼저(더 최신 이벤트로 간주).
export function sortByRecent(entries: ReadonlyArray<LedgerEntry>): LedgerEntry[] {
  return [...entries].sort((a, b) => {
    if (a.opened !== b.opened) return a.opened < b.opened ? 1 : -1;
    if (a.kind !== b.kind) return a.kind === 'report' ? -1 : 1;
    return a.id < b.id ? 1 : -1;
  });
}

// handoff id 기준으로 대응 report가 있는지 찾는다. report.origin 이
// `docs/handoffs/<id>.md` 또는 단순 파일명을 가리킬 때 모두 매칭한다.
export function findReportFor(
  handoff: LedgerEntry,
  entries: ReadonlyArray<LedgerEntry>,
): LedgerEntry | undefined {
  return entries.find((e) => {
    if (e.kind !== 'report' || !e.origin) return false;
    const norm = e.origin.replace(/\\/g, '/');
    return norm.endsWith(`/${handoff.id}.md`) || norm.endsWith(`${handoff.id}.md`);
  });
}

export type StatusFilter = HandoffStatus | 'all';

export interface TimelineFilter {
  status: StatusFilter;
  /** from 또는 to 에 일치해야 하는 역할 이름. 'all' 이면 제약 없음. */
  role: string;
}

/** 타임라인 행 하나. handoff 를 축으로 REPORT 는 effective status 에만 반영된다. */
export type TimelineRow = LedgerEntry & { report?: LedgerEntry };

// CollabTimeline 이 렌더에 쓰는 "handoff + 대응 REPORT" 병합 결과.
// effective status 는 REPORT 가 있으면 REPORT 상태, 없으면 HANDOFF 상태.
// 컴포넌트 내부에 있던 로직을 분리해 단위 테스트로 필터 조합을 검증할 수 있게 한다
// (§9.3 "필터 칩 조합 동작" 스모크를 유닛 레벨로 일부 회수).
export function buildTimelineRows(
  entries: ReadonlyArray<LedgerEntry>,
  filter: TimelineFilter,
): TimelineRow[] {
  const handoffs = entries.filter((e) => e.kind === 'handoff');
  const merged = handoffs.map((h) => {
    const report = findReportFor(h, entries);
    const effectiveStatus: HandoffStatus = report ? report.status : h.status;
    return { handoff: h, report, effectiveStatus };
  });
  const filtered = merged.filter((row) => {
    if (filter.status !== 'all' && row.effectiveStatus !== filter.status) return false;
    if (
      filter.role !== 'all' &&
      row.handoff.from !== filter.role &&
      row.handoff.to !== filter.role
    ) {
      return false;
    }
    return true;
  });
  const asEntries: TimelineRow[] = filtered.map((row) => ({
    ...row.handoff,
    status: row.effectiveStatus,
    report: row.report,
  }));
  return sortByRecent(asEntries) as TimelineRow[];
}

// entries 전체에서 등장하는 from/to 역할명의 정렬된 합집합. 역할 드롭다운 옵션용.
export function collectRoleOptions(entries: ReadonlyArray<LedgerEntry>): string[] {
  const set = new Set<string>();
  for (const e of entries) {
    if (e.from) set.add(e.from);
    if (e.to) set.add(e.to);
  }
  return Array.from(set).sort();
}
