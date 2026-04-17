// Run with: tsx --test src/utils/directiveLog.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDirectiveDigest,
  computeSoloViolationRate,
  parseDirectiveBlocks,
  summarizeDirectiveRouting,
  type DirectiveEntry,
} from './directiveLog.ts';

const inboxRaw = `---
date: 2026-04-17
owner: 알파
---

# 2026-04-17 사용자 지시 로그

### [tick=now] 단독 작업 중단 및 지시 로깅 체계화
- **원문 프롬프트**: "왜 작업하는데 분업을 안시키고 있지?"
- **분해**:
  1. 인박스 신설
  2. 프로토콜 개정
- **위임**: \`docs/handoffs/2026-04-17-alpha-to-beta-directive-logging.md\` → REPORT \`docs/reports/2026-04-17-directive-logging.md\`
- **알파 자체 처리분**: 프로토콜·차터 문서 개정
- **상태**: done (베타 회신 검수 대기)

### [tick=now+1] 리더 분업 워크플로우 강제화
- **원문 프롬프트**: "리더 에이전트가 다른 에이전트들에게 분업시키는 형태로 워크플로우를 수정해줘"
- **분해**:
  1. 워크플로우 v2 추가
- **위임**:
  - \`docs/handoffs/2026-04-17-alpha-to-beta-delegation-workflow.md\`
  - \`docs/handoffs/2026-04-17-alpha-to-designer-slot-vacancy.md\`
- **알파 자체 처리분**: 협업 프로토콜 v2 섹션 신설
- **상태**: wip
`;

test('parseDirectiveBlocks: 인박스 두 블록을 모두 추출', () => {
  const entries = parseDirectiveBlocks(inboxRaw, 'docs/inbox/2026-04-17-user-directives.md');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].digest, '단독 작업 중단 및 지시 로깅 체계화');
  assert.equal(entries[0].tick, 'tick=now');
  assert.equal(entries[1].tick, 'tick=now+1');
});

test('parseDirectiveBlocks: 원문 프롬프트의 큰따옴표 안 본문 보존', () => {
  const [first] = parseDirectiveBlocks(inboxRaw, 'x.md');
  assert.equal(first.originalPrompt, '왜 작업하는데 분업을 안시키고 있지?');
});

test('parseDirectiveBlocks: 멀티라인 위임 절에서 핸드오프 경로 모두 추출', () => {
  const [, second] = parseDirectiveBlocks(inboxRaw, 'x.md');
  assert.deepEqual(second.handoffs, [
    'docs/handoffs/2026-04-17-alpha-to-beta-delegation-workflow.md',
    'docs/handoffs/2026-04-17-alpha-to-designer-slot-vacancy.md',
  ]);
});

test('parseDirectiveBlocks: status 의 꼬리 주석은 잘라내고 정규화', () => {
  const [first] = parseDirectiveBlocks(inboxRaw, 'x.md');
  assert.equal(first.status, 'done');
});

test('parseDirectiveBlocks: 알 수 없는 status 는 open 폴백', () => {
  const md = `### [tick=1] 테스트
- **원문 프롬프트**: "x"
- **상태**: 진행중
`;
  const [e] = parseDirectiveBlocks(md, 'x.md');
  assert.equal(e.status, 'open');
});

test('parseDirectiveBlocks: 빈 입력 → 빈 배열', () => {
  assert.deepEqual(parseDirectiveBlocks('', 'x.md'), []);
  assert.deepEqual(parseDirectiveBlocks('# 헤더만 있는 문서', 'x.md'), []);
});

test('parseDirectiveBlocks: 헤더에 digest 가 비면 블록 무시', () => {
  const md = `### [tick=1] \n- **상태**: open\n`;
  assert.deepEqual(parseDirectiveBlocks(md, 'x.md'), []);
});

test('parseDirectiveBlocks: 알파 자체 처리분 누락 시 빈 문자열', () => {
  const md = `### [tick=1] 테스트
- **원문 프롬프트**: "x"
- **상태**: open
`;
  const [e] = parseDirectiveBlocks(md, 'x.md');
  assert.equal(e.alphaSolo, '');
});

test('summarizeDirectiveRouting: 위임/단독/예외 카운트', () => {
  const entries = parseDirectiveBlocks(inboxRaw, 'x.md');
  const s = summarizeDirectiveRouting(entries);
  assert.equal(s.total, 2);
  assert.equal(s.delegated, 2);
  assert.equal(s.soloOnly, 0);
  assert.equal(s.delegationRate, 1);
});

test('summarizeDirectiveRouting: 단독 + "없음" 은 예외로 카운트하지 않음', () => {
  const entries: DirectiveEntry[] = [
    {
      tick: '1', digest: 'a', originalPrompt: '', handoffs: [],
      alphaSolo: '없음', status: 'done', sourcePath: 'x.md',
    },
    {
      tick: '2', digest: 'b', originalPrompt: '', handoffs: [],
      alphaSolo: '긴급 핫픽스 단독 처리', status: 'done', sourcePath: 'x.md',
    },
  ];
  const s = summarizeDirectiveRouting(entries);
  assert.equal(s.delegated, 0);
  assert.equal(s.soloOnly, 2);
  assert.equal(s.soloWithException, 1);
  assert.equal(s.delegationRate, 0);
});

test('summarizeDirectiveRouting: 빈 배열 → delegationRate 0 (NaN 아님)', () => {
  const s = summarizeDirectiveRouting([]);
  assert.equal(s.total, 0);
  assert.equal(s.delegationRate, 0);
});

test('computeSoloViolationRate: forbidden 분류된 지시 중 단독 비율', () => {
  const entries: DirectiveEntry[] = [
    { tick: '1', digest: 'A', originalPrompt: '', handoffs: [], alphaSolo: '', status: 'done', sourcePath: 'x' },
    { tick: '2', digest: 'B', originalPrompt: '', handoffs: ['h.md'], alphaSolo: '', status: 'done', sourcePath: 'x' },
    { tick: '3', digest: 'C', originalPrompt: '', handoffs: [], alphaSolo: '', status: 'done', sourcePath: 'x' },
    { tick: '4', digest: 'D', originalPrompt: '', handoffs: [], alphaSolo: '', status: 'done', sourcePath: 'x' },
  ];
  const hits = new Map<string, 'forbidden' | 'allowed'>([
    ['A', 'forbidden'],
    ['B', 'forbidden'],
    ['C', 'allowed'],
    ['D', 'forbidden'],
  ]);
  const r = computeSoloViolationRate(entries, hits);
  // forbidden 3건 중 단독(handoffs=0) = A, D → 2/3
  assert.equal(r.violations.length, 2);
  assert.ok(Math.abs(r.rate - 2 / 3) < 1e-9);
  assert.equal(r.thresholdExceeded, true);
});

test('computeSoloViolationRate: forbidden 0건이면 rate=0, threshold=false', () => {
  const r = computeSoloViolationRate(
    [{ tick: '1', digest: 'A', originalPrompt: '', handoffs: [], alphaSolo: '', status: 'done', sourcePath: 'x' }],
    new Map([['A', 'allowed']]),
  );
  assert.equal(r.rate, 0);
  assert.equal(r.thresholdExceeded, false);
});

test('computeSoloViolationRate: windowSize 만 검사 (앞에서 N개)', () => {
  const entries: DirectiveEntry[] = Array.from({ length: 5 }, (_, i) => ({
    tick: String(i), digest: `D${i}`, originalPrompt: '', handoffs: [],
    alphaSolo: '', status: 'done' as const, sourcePath: 'x',
  }));
  const hits = new Map<string, 'forbidden' | 'allowed'>(
    entries.map((e) => [e.digest, 'forbidden'] as const),
  );
  const r = computeSoloViolationRate(entries, hits, 2);
  // 앞 2건만 보고, 모두 단독이므로 2/2 = 1.0
  assert.equal(r.violations.length, 2);
  assert.equal(r.rate, 1);
});

test('computeSoloViolationRate: 임계 정확히 0.2 면 초과 아님', () => {
  // 5건 중 1건 단독 = 0.2 → 초과 아님
  const entries: DirectiveEntry[] = Array.from({ length: 5 }, (_, i) => ({
    tick: String(i), digest: `D${i}`, originalPrompt: '',
    handoffs: i === 0 ? [] : ['h.md'],
    alphaSolo: '', status: 'done' as const, sourcePath: 'x',
  }));
  const hits = new Map<string, 'forbidden' | 'allowed'>(
    entries.map((e) => [e.digest, 'forbidden'] as const),
  );
  const r = computeSoloViolationRate(entries, hits);
  assert.equal(r.rate, 0.2);
  assert.equal(r.thresholdExceeded, false);
});

test('parseDirectiveBlocks: CRLF 입력도 동일하게 파싱', () => {
  const crlf = inboxRaw.replace(/\n/g, '\r\n');
  const entries = parseDirectiveBlocks(crlf, 'x.md');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].digest, '단독 작업 중단 및 지시 로깅 체계화');
  assert.equal(entries[1].status, 'wip');
});

test('parseDirectiveBlocks: sourcePath 는 모든 엔트리에 동일하게 전파', () => {
  const entries = parseDirectiveBlocks(inboxRaw, 'docs/inbox/X.md');
  assert.equal(entries.length, 2);
  for (const e of entries) assert.equal(e.sourcePath, 'docs/inbox/X.md');
});

test('parseDirectiveBlocks: 따옴표 없는 원문 프롬프트는 콜론 뒤 트림 폴백', () => {
  const md = `### [tick=1] 제목
- **원문 프롬프트**: 따옴표 없이 그냥 쓴 지시
- **상태**: open
`;
  const [e] = parseDirectiveBlocks(md, 'x.md');
  assert.equal(e.originalPrompt, '따옴표 없이 그냥 쓴 지시');
});

test('parseDirectiveBlocks: 위임 절의 중복 핸드오프 경로는 제거되고 순서 보존', () => {
  const md = `### [tick=1] 제목
- **원문 프롬프트**: "x"
- **위임**:
  - \`docs/handoffs/a.md\`
  - \`docs/handoffs/b.md\`
  - \`docs/handoffs/a.md\`
- **상태**: open
`;
  const [e] = parseDirectiveBlocks(md, 'x.md');
  assert.deepEqual(e.handoffs, ['docs/handoffs/a.md', 'docs/handoffs/b.md']);
});

test('parseDirectiveBlocks: 인박스 외 H3(다른 섹션)가 나오면 블록 종료', () => {
  const md = `### [tick=1] 첫 지시
- **원문 프롬프트**: "a"
- **상태**: open

### 참고 노트
이 섹션은 지시가 아니므로 무시되어야 한다.

### [tick=2] 두 번째 지시
- **원문 프롬프트**: "b"
- **상태**: open
`;
  const entries = parseDirectiveBlocks(md, 'x.md');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].digest, '첫 지시');
  assert.equal(entries[1].digest, '두 번째 지시');
});

test('summarizeDirectiveRouting: 혼합 케이스 — 위임/단독/단독+예외', () => {
  const entries: DirectiveEntry[] = [
    { tick: '1', digest: 'a', originalPrompt: '', handoffs: ['h.md'],
      alphaSolo: '', status: 'done', sourcePath: 'x.md' },
    { tick: '2', digest: 'b', originalPrompt: '', handoffs: [],
      alphaSolo: '없음', status: 'done', sourcePath: 'x.md' },
    { tick: '3', digest: 'c', originalPrompt: '', handoffs: [],
      alphaSolo: '긴급 핫픽스', status: 'wip', sourcePath: 'x.md' },
    { tick: '4', digest: 'd', originalPrompt: '', handoffs: ['h2.md', 'h3.md'],
      alphaSolo: '', status: 'open', sourcePath: 'x.md' },
  ];
  const s = summarizeDirectiveRouting(entries);
  assert.equal(s.total, 4);
  assert.equal(s.delegated, 2);
  assert.equal(s.soloOnly, 2);
  assert.equal(s.soloWithException, 1);
  assert.equal(s.delegationRate, 0.5);
});

test('buildDirectiveDigest: summarize + 최근 N건 압축', () => {
  const entries = parseDirectiveBlocks(inboxRaw, 'docs/inbox/2026-04-17-user-directives.md');
  const d = buildDirectiveDigest(entries, {
    today: '2026-04-17',
    inboxPath: 'docs/inbox/2026-04-17-user-directives.md',
    limit: 3,
  });
  assert.equal(d.today, '2026-04-17');
  assert.equal(d.total, 2);
  assert.equal(d.delegated, 2);
  assert.equal(d.soloWithException, 0);
  assert.equal(d.latestEntries.length, 2);
  assert.equal(d.latestEntries[0].digest, '단독 작업 중단 및 지시 로깅 체계화');
  assert.equal(d.latestEntries[0].status, 'done');
  assert.equal(d.latestEntries[1].status, 'wip');
});

test('buildDirectiveDigest: limit 기본값 3, 초과분은 잘라냄', () => {
  const many: DirectiveEntry[] = Array.from({ length: 5 }, (_, i) => ({
    tick: String(i), digest: `d${i}`, originalPrompt: '',
    handoffs: ['h.md'], alphaSolo: '', status: 'open' as const, sourcePath: 'x.md',
  }));
  const d = buildDirectiveDigest(many, { today: '2026-04-18', inboxPath: 'x.md' });
  assert.equal(d.total, 5);
  assert.equal(d.latestEntries.length, 3);
  assert.deepEqual(d.latestEntries.map((e) => e.digest), ['d0', 'd1', 'd2']);
});

test('buildDirectiveDigest: 빈 배열이면 total=0, latestEntries=[]', () => {
  const d = buildDirectiveDigest([], { today: '2026-04-18', inboxPath: 'x.md' });
  assert.equal(d.total, 0);
  assert.equal(d.delegated, 0);
  assert.equal(d.soloWithException, 0);
  assert.deepEqual(d.latestEntries, []);
});

test('buildDirectiveDigest: limit=0 이면 latestEntries 비어있음', () => {
  const entries = parseDirectiveBlocks(inboxRaw, 'x.md');
  const d = buildDirectiveDigest(entries, { today: 't', inboxPath: 'x', limit: 0 });
  assert.equal(d.total, 2);
  assert.equal(d.latestEntries.length, 0);
});

// ── buildDirectiveDigest §④ 확장 (협업 지표 블록 입력) ──────────────────
// 근거: docs/handoffs/2026-04-17-alpha-to-beta-collab-audit.md §④.

test('buildDirectiveDigest: delegationRate 는 summarize 와 같은 값', () => {
  const entries = parseDirectiveBlocks(inboxRaw, 'x.md');
  const d = buildDirectiveDigest(entries, { today: 't', inboxPath: 'x' });
  assert.equal(d.delegationRate, 1);
  assert.equal(d.forbiddenSoloThreshold, 0.2);
  assert.equal(d.forbiddenSoloRate, undefined); // routingHits 미제공
  assert.equal(d.orphanHandoffCount, undefined);
});

test('buildDirectiveDigest: routingHits 주입 시 forbiddenSoloRate 계산', () => {
  const entries: DirectiveEntry[] = [
    { tick: '1', digest: 'A', originalPrompt: '', handoffs: [], alphaSolo: '', status: 'done', sourcePath: 'x' },
    { tick: '2', digest: 'B', originalPrompt: '', handoffs: ['h.md'], alphaSolo: '', status: 'done', sourcePath: 'x' },
  ];
  const hits = new Map<string, 'forbidden' | 'allowed'>([
    ['A', 'forbidden'],
    ['B', 'forbidden'],
  ]);
  const d = buildDirectiveDigest(entries, {
    today: 't', inboxPath: 'x',
    routingHits: hits,
    orphanHandoffCount: 3,
    forbiddenSoloThreshold: 0.25,
  });
  assert.equal(d.forbiddenSoloRate, 0.5);
  assert.equal(d.forbiddenSoloThreshold, 0.25);
  assert.equal(d.orphanHandoffCount, 3);
});

test('computeSoloViolationRate: windowSize=0 은 빈 검사 (rate=0, threshold=false)', () => {
  const entries: DirectiveEntry[] = [
    { tick: '1', digest: 'A', originalPrompt: '', handoffs: [], alphaSolo: '',
      status: 'done', sourcePath: 'x' },
  ];
  const hits = new Map<string, 'forbidden' | 'allowed'>([['A', 'forbidden']]);
  const r = computeSoloViolationRate(entries, hits, 0);
  assert.equal(r.rate, 0);
  assert.equal(r.violations.length, 0);
  assert.equal(r.thresholdExceeded, false);
});

// ── 추가 에지 케이스 ─────────────────────────────────────────────────────
// 근거: normalizeStatus 의 split 구분자에 전각 `（` 가 포함되어 있으나 테스트가 없었다.

test('parseDirectiveBlocks: status 전각 괄호 꼬리표도 잘라내고 정규화', () => {
  const md = `### [tick=1] 제목
- **원문 프롬프트**: "x"
- **상태**: blocked（의존성 대기）
`;
  const [e] = parseDirectiveBlocks(md, 'x.md');
  assert.equal(e.status, 'blocked');
});

test('parseDirectiveBlocks: 대문자 status 도 정규화되어 소문자로 수용', () => {
  const md = `### [tick=1] 제목
- **원문 프롬프트**: "x"
- **상태**: DONE
`;
  const [e] = parseDirectiveBlocks(md, 'x.md');
  assert.equal(e.status, 'done');
});

test('parseDirectiveBlocks: 위임 절 밖에 등장한 handoffs 경로는 무시', () => {
  // 원문 프롬프트 본문에 handoffs 경로가 우연히 언급돼도 handoffs 로 잡히면 안 된다.
  const md = `### [tick=1] 제목
- **원문 프롬프트**: "참고: docs/handoffs/ghost.md 를 읽어라"
- **위임**: 없음
- **상태**: open
`;
  const [e] = parseDirectiveBlocks(md, 'x.md');
  assert.deepEqual(e.handoffs, []);
});

test('parseDirectiveBlocks: 라우팅 불변식 — delegated + soloOnly === total', () => {
  const entries = parseDirectiveBlocks(inboxRaw, 'x.md');
  const s = summarizeDirectiveRouting(entries);
  assert.equal(s.delegated + s.soloOnly, s.total);
});

test('buildDirectiveDigest: 음수 limit 은 0 으로 클램프', () => {
  const entries = parseDirectiveBlocks(inboxRaw, 'x.md');
  const d = buildDirectiveDigest(entries, { today: 't', inboxPath: 'x', limit: -5 });
  assert.equal(d.total, 2);
  assert.deepEqual(d.latestEntries, []);
});

test('buildDirectiveDigest: forbiddenSoloThreshold 미지정 시 기본 0.2', () => {
  const d = buildDirectiveDigest([], { today: 't', inboxPath: 'x' });
  assert.equal(d.forbiddenSoloThreshold, 0.2);
});
