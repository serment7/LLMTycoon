// Run with: tsx --test src/utils/handoffLedger.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTimelineRows,
  collectRoleOptions,
  extractSlug,
  findReportFor,
  parseEntry,
  parseFrontmatter,
  sortByRecent,
  summarize,
} from './handoffLedger.ts';

const handoffRaw = `---
status: open
from: 알파
to: 베타
opened: 2026-04-17
---

## HANDOFF
HANDOFF 베타 :: 협업 UI 구현 :: docs/reports/foo.md :: 다음 틱
`;

const reportRaw = `---
status: done
from: 베타
to: 알파
opened: 2026-04-17
origin: docs/handoffs/alpha-to-beta-collab-ui.md
---

REPORT 베타→알파 :: done :: src/components/CollabTimeline.tsx :: 후속
`;

test('parses frontmatter scalar fields', () => {
  const fm = parseFrontmatter(handoffRaw);
  assert.equal(fm.status, 'open');
  assert.equal(fm.from, '알파');
  assert.equal(fm.to, '베타');
});

test('extracts slug from HANDOFF/REPORT line', () => {
  assert.equal(extractSlug(handoffRaw), '협업 UI 구현');
  assert.equal(extractSlug(reportRaw), 'done');
});

test('falls back to open on unknown status with a warning flag', () => {
  const entry = parseEntry({
    path: 'docs/handoffs/x.md',
    kind: 'handoff',
    content: '---\nstatus: In Progress\nfrom: 알파\nto: 베타\n---\n',
  });
  assert.equal(entry.status, 'open');
  assert.equal(entry.statusFallback, true);
});

test('summarize counts statuses', () => {
  const h = parseEntry({ path: 'docs/handoffs/a.md', kind: 'handoff', content: handoffRaw });
  const r = parseEntry({ path: 'docs/reports/b.md', kind: 'report', content: reportRaw });
  const s = summarize([h, r]);
  assert.equal(s.total, 2);
  assert.equal(s.open, 1);
  assert.equal(s.done, 1);
});

test('sorts entries by opened date descending, reports first on tie', () => {
  const older = parseEntry({
    path: 'docs/handoffs/older.md',
    kind: 'handoff',
    content: '---\nstatus: open\nfrom: 알파\nto: 베타\nopened: 2026-04-16\n---\n',
  });
  const h = parseEntry({ path: 'docs/handoffs/a.md', kind: 'handoff', content: handoffRaw });
  const r = parseEntry({ path: 'docs/reports/b.md', kind: 'report', content: reportRaw });
  const sorted = sortByRecent([older, h, r]);
  assert.equal(sorted[0].kind, 'report');
  assert.equal(sorted[sorted.length - 1].id, 'older');
});

test('findReportFor matches report origin by filename suffix', () => {
  const h = parseEntry({
    path: 'docs/handoffs/alpha-to-beta-collab-ui.md',
    kind: 'handoff',
    content: handoffRaw,
  });
  const r = parseEntry({
    path: 'docs/reports/alpha-to-beta-collab-ui.md',
    kind: 'report',
    content: reportRaw,
  });
  assert.equal(findReportFor(h, [h, r])?.id, 'alpha-to-beta-collab-ui');
});

// ── §6.4 감마 QA 확장 커버리지 ────────────────────────────────
// docs/reports/2026-04-17-collab-ui.md §6.4 에서 "§4 스냅샷 3종은 부족"으로
// 지적된 누락 케이스를 파서 레벨에서 검증한다.

test('parseFrontmatter: frontmatter 없으면 빈 객체', () => {
  assert.deepEqual(parseFrontmatter('그냥 본문만 있는 md'), {});
});

test('parseFrontmatter: 따옴표로 감싼 값은 제거', () => {
  const fm = parseFrontmatter(`---\nstatus: "wip"\nfrom: '알파'\n---\n`);
  assert.equal(fm.status, 'wip');
  assert.equal(fm.from, '알파');
});

test('extractSlug: HANDOFF/REPORT 라인이 없으면 빈 문자열', () => {
  assert.equal(extractSlug('아무 내용 없음'), '');
});

test('parseEntry: status 필드 자체가 누락돼도 open 폴백 + 경고', () => {
  const e = parseEntry({
    path: 'docs/handoffs/x.md',
    kind: 'handoff',
    content: `---\nfrom: 알파\nto: 베타\nopened: 2026-04-17\n---\n본문`,
  });
  assert.equal(e.status, 'open');
  assert.equal(e.statusFallback, true);
});

test('parseEntry: 알려진 status 는 대소문자 무관', () => {
  const e = parseEntry({
    path: 'x.md',
    kind: 'handoff',
    content: `---\nstatus: DONE\nfrom: a\nto: b\nopened: 2026-04-17\n---`,
  });
  assert.equal(e.status, 'done');
  assert.equal(e.statusFallback, undefined);
});

test('parseEntry: 알 수 없는 status 값은 모두 open 폴백', () => {
  // 대소문자는 허용하므로 'WIP' 은 여기 포함되지 않는다(case-insensitive 케이스는 별도 테스트).
  for (const bad of ['In Progress', 'doing', '진행중']) {
    const e = parseEntry({
      path: 'docs/handoffs/x.md',
      kind: 'handoff',
      content: `---\nstatus: ${bad}\nfrom: a\nto: b\nopened: 2026-04-17\n---`,
    });
    assert.equal(e.status, 'open', `status=${bad}`);
    assert.equal(e.statusFallback, true, `status=${bad} fallback flag`);
  }
});

test('parseEntry: from/to 누락 시 (미배정)으로 표시', () => {
  const e = parseEntry({
    path: 'x.md',
    kind: 'handoff',
    content: `---\nstatus: open\nopened: 2026-04-17\n---`,
  });
  assert.equal(e.from, '(미배정)');
  assert.equal(e.to, '(미배정)');
});

test('findReportFor: origin 없는 REPORT 는 orphan (매칭 안 됨)', () => {
  const h = parseEntry({
    path: 'docs/handoffs/solo.md',
    kind: 'handoff',
    content: handoffRaw,
  });
  const orphan = parseEntry({
    path: 'docs/reports/floating.md',
    kind: 'report',
    content: `---\nstatus: done\n---`,
  });
  assert.equal(findReportFor(h, [h, orphan]), undefined);
});

test('findReportFor: 같은 origin 2건이면 sortByRecent 후 최신 opened 우선', () => {
  // §6.4: 같은 slug로 REPORT 2회 올라왔을 때 최신이 선택되어야 한다.
  // findReportFor 는 배열 앞쪽 첫 매치를 반환하므로, 호출측이
  // sortByRecent 로 먼저 정렬하는 게 의도된 사용 패턴.
  const h = parseEntry({
    path: 'docs/handoffs/alpha-to-beta-collab-ui.md',
    kind: 'handoff',
    content: handoffRaw,
  });
  const older = parseEntry({
    path: 'docs/reports/old.md',
    kind: 'report',
    content: `---\nstatus: wip\nopened: 2026-04-16\norigin: docs/handoffs/alpha-to-beta-collab-ui.md\n---`,
  });
  const newer = parseEntry({
    path: 'docs/reports/new.md',
    kind: 'report',
    content: `---\nstatus: done\nopened: 2026-04-18\norigin: docs/handoffs/alpha-to-beta-collab-ui.md\n---`,
  });
  const picked = findReportFor(h, sortByRecent([h, older, newer]));
  assert.equal(picked?.id, 'new');
});

// ── 감마 QA 추가 커버리지 (2026-04-17) ──────────────────────────
// 기존 스윗에 누락된 경계 조건을 보강한다. 의도된 공개 API 계약은 동일하게 유지하되,
// Windows 경로·CRLF·blocked/wip 집계·빈 배열 경로를 실사용에 가깝게 검증한다.

test('parseFrontmatter: CRLF 줄바꿈도 정상 파싱', () => {
  // Windows 체크아웃(autocrlf=true)에서 들어온 문서가 깨지지 않아야 한다.
  const fm = parseFrontmatter('---\r\nstatus: wip\r\nfrom: 감마\r\n---\r\n본문');
  assert.equal(fm.status, 'wip');
  assert.equal(fm.from, '감마');
});

test('parseEntry: Windows 백슬래시 경로에서도 id 슬러그 추출', () => {
  const e = parseEntry({
    path: 'docs\\handoffs\\alpha-to-gamma.md',
    kind: 'handoff',
    content: handoffRaw,
  });
  assert.equal(e.id, 'alpha-to-gamma');
});

test('parseEntry: blocked status 는 그대로 보존 + fallback 플래그 없음', () => {
  const e = parseEntry({
    path: 'x.md',
    kind: 'handoff',
    content: `---\nstatus: blocked\nfrom: a\nto: b\nopened: 2026-04-17\n---`,
  });
  assert.equal(e.status, 'blocked');
  assert.equal(e.statusFallback, undefined);
});

test('summarize: wip/blocked 포함 4종 status 모두 집계', () => {
  const mk = (s: string) =>
    parseEntry({
      path: `${s}.md`,
      kind: 'handoff',
      content: `---\nstatus: ${s}\nfrom: a\nto: b\nopened: 2026-04-17\n---`,
    });
  const s = summarize([mk('open'), mk('wip'), mk('wip'), mk('done'), mk('blocked')]);
  assert.deepEqual(s, { open: 1, wip: 2, done: 1, blocked: 1, total: 5 });
});

test('summarize: 빈 배열은 total 0 + 전 상태 0', () => {
  assert.deepEqual(summarize([]), { open: 0, wip: 0, done: 0, blocked: 0, total: 0 });
});

test('sortByRecent: 빈 배열은 빈 배열 반환 + 원본 불변', () => {
  const src: ReturnType<typeof parseEntry>[] = [];
  const out = sortByRecent(src);
  assert.deepEqual(out, []);
  assert.notEqual(out, src, '새 배열이어야 한다 (copy-on-sort)');
});

test('extractSlug: 여러 HANDOFF 라인이 있으면 첫 번째만 사용', () => {
  const raw = [
    'HANDOFF 감마 :: 첫 번째 :: a.md :: tick',
    '본문',
    'HANDOFF 감마 :: 두 번째 :: b.md :: tick',
  ].join('\n');
  assert.equal(extractSlug(raw), '첫 번째');
});

// ── linked_directive / retroactive 인식 및 orphan 분류 ──────────────────
// 근거: docs/handoffs/2026-04-17-alpha-to-beta-collab-audit.md §⑤.

test('parseEntry: linked_directive 있으면 orphan=false + 필드 보존', () => {
  const e = parseEntry({
    path: 'docs/handoffs/linked.md',
    kind: 'handoff',
    content: `---\nstatus: open\nfrom: 알파\nto: 베타\nopened: 2026-04-17\nlinked_directive: docs/inbox/2026-04-17-user-directives.md\n---\n`,
  });
  assert.equal(e.orphan, false);
  assert.equal(e.linkedDirective, 'docs/inbox/2026-04-17-user-directives.md');
});

test('parseEntry: linked_directive 없는 handoff 는 orphan=true', () => {
  const e = parseEntry({
    path: 'docs/handoffs/orphan.md',
    kind: 'handoff',
    content: `---\nstatus: open\nfrom: 알파\nto: 베타\nopened: 2026-04-17\n---\n`,
  });
  assert.equal(e.orphan, true);
  assert.equal(e.linkedDirective, undefined);
});

test('parseEntry: report 는 linked_directive 없어도 orphan 아님', () => {
  // report 는 상위 handoff 를 통해 라우팅이 이미 입증됨 → §⑤에서 handoff 만 대상.
  const e = parseEntry({
    path: 'docs/reports/foo.md',
    kind: 'report',
    content: `---\nstatus: done\norigin: docs/handoffs/foo.md\n---\n`,
  });
  assert.equal(e.orphan, false);
});

test('parseEntry: retroactive: true 플래그 파싱', () => {
  const e = parseEntry({
    path: 'docs/handoffs/retro.md',
    kind: 'handoff',
    content: `---\nstatus: done\nretroactive: true\ndirective: 유실\n---\n`,
  });
  assert.equal(e.retroactive, true);
  assert.equal(e.orphan, true);
});

test('parseEntry: retroactive: false 는 undefined 처리 (falsy 값 제거)', () => {
  const e = parseEntry({
    path: 'docs/handoffs/x.md',
    kind: 'handoff',
    content: `---\nstatus: open\nretroactive: false\nlinked_directive: docs/inbox/a.md\n---\n`,
  });
  assert.equal(e.retroactive, undefined);
});

test('findReportFor: 백슬래시 origin 도 forward slash 로 정규화되어 매칭', () => {
  // 에이전트가 Windows 환경에서 작성한 문서가 origin: docs\handoffs\foo.md 로
  // 들어와도 타임라인 매칭이 깨지지 않아야 한다.
  const h = parseEntry({
    path: 'docs/handoffs/foo.md',
    kind: 'handoff',
    content: handoffRaw,
  });
  const r = parseEntry({
    path: 'docs/reports/foo-report.md',
    kind: 'report',
    content: `---\nstatus: done\norigin: docs\\handoffs\\foo.md\n---`,
  });
  assert.equal(findReportFor(h, [h, r])?.id, 'foo-report');
});

// ── buildTimelineRows / collectRoleOptions (§9.3 필터 스모크의 유닛 회수) ──
// CollabTimeline 내부 useMemo 로 있던 로직을 분리한 뒤 추가된 테스트.
// 런타임에만 확인 가능했던 "필터 칩 + 역할 드롭다운 조합 동작" 을 유닛 레벨에서
// 재현해 도구 없이도 회귀를 잡을 수 있게 한다.

const h1 = parseEntry({
  path: 'docs/handoffs/a.md',
  kind: 'handoff',
  content: `---\nstatus: wip\nfrom: 알파\nto: 베타\nopened: 2026-04-17\n---\nHANDOFF 베타 :: A :: x :: 1\n`,
});
const h2 = parseEntry({
  path: 'docs/handoffs/b.md',
  kind: 'handoff',
  content: `---\nstatus: open\nfrom: 알파\nto: 감마\nopened: 2026-04-16\n---\nHANDOFF 감마 :: B :: y :: 1\n`,
});
const r1 = parseEntry({
  path: 'docs/reports/a.md',
  kind: 'report',
  content: `---\nstatus: done\nfrom: 베타\nto: 알파\nopened: 2026-04-17\norigin: docs/handoffs/a.md\n---\nREPORT 베타→알파 :: done :: z :: 1\n`,
});

test('buildTimelineRows: handoff + 매칭 REPORT 는 effective status=report.status', () => {
  const rows = buildTimelineRows([h1, h2, r1], { status: 'all', role: 'all' });
  const ids = rows.map((r) => r.id);
  assert.deepEqual(ids.sort(), ['a', 'b']);
  const a = rows.find((r) => r.id === 'a')!;
  assert.equal(a.status, 'done', 'REPORT 가 있으면 그 status 로 덮어씀');
  assert.equal(a.report?.id, 'a', 'report 필드에 대응 REPORT 부착');
});

test('buildTimelineRows: status 필터는 effective status 기준', () => {
  // h1 자체 status 는 wip 이지만 r1 덕분에 effective=done → status=wip 필터에 걸리지 않아야 한다.
  const rows = buildTimelineRows([h1, h2, r1], { status: 'wip', role: 'all' });
  assert.equal(rows.length, 0);

  const doneRows = buildTimelineRows([h1, h2, r1], { status: 'done', role: 'all' });
  assert.deepEqual(
    doneRows.map((r) => r.id),
    ['a'],
  );
});

test('buildTimelineRows: 역할 필터는 from/to 중 하나만 일치해도 통과', () => {
  const asBeta = buildTimelineRows([h1, h2, r1], { status: 'all', role: '베타' });
  assert.deepEqual(
    asBeta.map((r) => r.id),
    ['a'],
  );
  const asAlpha = buildTimelineRows([h1, h2, r1], { status: 'all', role: '알파' });
  assert.deepEqual(asAlpha.map((r) => r.id).sort(), ['a', 'b']);
});

test('buildTimelineRows: status·role 조합 필터', () => {
  const rows = buildTimelineRows([h1, h2, r1], { status: 'open', role: '감마' });
  assert.deepEqual(
    rows.map((r) => r.id),
    ['b'],
  );
});

test('buildTimelineRows: REPORT 는 독립 행으로 나열되지 않음', () => {
  // 양쪽을 따로 렌더하면 "대기열 부풀림" 이 생긴다는 §6.1 지침. 행 수는 handoff 수와 같아야 한다.
  const rows = buildTimelineRows([h1, h2, r1], { status: 'all', role: 'all' });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.kind === 'handoff'));
});

test('collectRoleOptions: from/to 합집합을 오름차순 정렬', () => {
  assert.deepEqual(collectRoleOptions([h1, h2, r1]), ['감마', '베타', '알파']);
});

test('collectRoleOptions: 빈 배열은 빈 결과', () => {
  assert.deepEqual(collectRoleOptions([]), []);
});
