// Run with: tsx --test src/components/AgentStatusPanel.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Agent, CodeFile } from '../types.ts';
import {
  summarize,
  summarizeByRole,
  computeActiveRatio,
  computeRoleActivity,
  computeRoleImbalanceGap,
  computeContentionCounts,
  computeContendedFileIds,
  detectIssues,
  computeTotalSeverity,
  computeAgentSeverity,
  classifySeverity,
  hasCriticalContention,
  summarizeIssueCounts,
  getPrimaryIssue,
  getTopContendedFile,
  sortIssuesBySeverity,
  computeCollaborationEdges,
  computeIsolatedAgentIds,
  computeIsolationRatio,
  classifyIsolationBand,
  computeIncomingMessageCounts,
  getCommunicationHub,
  computeHubConcentration,
  classifyHubBand,
  getHubBandLabel,
  getHubBandGlyph,
  getHubBandTone,
  getSeverityBandLabel,
  getSeverityBandGlyph,
  getIsolationBandLabel,
  getIsolationBandGlyph,
  getStatusGlyph,
  resolveAvatarTint,
  isActiveAgent,
  shouldPulse,
  HUB_WATCH_THRESHOLD,
  HUB_SPOF_THRESHOLD,
  buildQualityReport,
  getDirectiveStatusGlyph,
  getDirectiveStatusLabel,
  getPipelineRoleLabel,
  QualityIssue,
  MAJOR_SEVERITY_THRESHOLD,
  ISOLATION_ALERT_THRESHOLD,
  QUALITY_SEVERITY_WEIGHTS,
  classifyForbiddenSoloBand,
  getForbiddenSoloBandTone,
  DEFAULT_FORBIDDEN_SOLO_THRESHOLD,
} from './AgentStatusPanel.tsx';

// 테스트 픽스처 빌더. 기본값은 "정상" 케이스로 잡고, 오버라이드로 특정 이슈만 주입하도록 한다.
const makeAgent = (overrides: Partial<Agent> = {}): Agent => ({
  id: overrides.id ?? 'a1',
  name: overrides.name ?? 'Kai',
  role: overrides.role ?? 'Developer',
  spriteTemplate: overrides.spriteTemplate ?? 'dev',
  x: overrides.x ?? 0,
  y: overrides.y ?? 0,
  status: overrides.status ?? 'idle',
  persona: overrides.persona,
  currentTask: overrides.currentTask,
  lastMessage: overrides.lastMessage,
  lastMessageTo: overrides.lastMessageTo,
  workingOnFileId: overrides.workingOnFileId,
});

const makeFile = (id: string, name = `${id}.tsx`): CodeFile => ({
  id,
  name,
  x: 0,
  y: 0,
  projectId: 'p1',
  type: 'component',
});

// ─── 기본 집계 ─────────────────────────────────────────────────────────

test('summarize: 상태별 인원 수를 누락 없이 집계', () => {
  const agents = [
    makeAgent({ id: '1', status: 'working' }),
    makeAgent({ id: '2', status: 'working' }),
    makeAgent({ id: '3', status: 'idle' }),
    makeAgent({ id: '4', status: 'meeting' }),
  ];
  const counts = summarize(agents);
  assert.equal(counts.working, 2);
  assert.equal(counts.idle, 1);
  assert.equal(counts.meeting, 1);
  assert.equal(counts.thinking, 0);
});

test('computeActiveRatio: 빈 배열은 0, 활성 상태만 분자로 집계', () => {
  assert.equal(computeActiveRatio([]), 0);
  const agents = [
    makeAgent({ id: '1', status: 'working' }),
    makeAgent({ id: '2', status: 'thinking' }),
    makeAgent({ id: '3', status: 'idle' }),
    makeAgent({ id: '4', status: 'idle' }),
  ];
  assert.equal(computeActiveRatio(agents), 0.5);
});

test('computeRoleActivity / computeRoleImbalanceGap: 역할 간 격차 추출', () => {
  const agents = [
    makeAgent({ id: '1', role: 'Developer', status: 'working' }),
    makeAgent({ id: '2', role: 'Developer', status: 'working' }),
    makeAgent({ id: '3', role: 'Designer', status: 'idle' }),
    makeAgent({ id: '4', role: 'Designer', status: 'idle' }),
  ];
  const activity = computeRoleActivity(agents);
  const byRole = new Map(activity.map(r => [r.role, r]));
  assert.equal(byRole.get('Developer')!.ratio, 1);
  assert.equal(byRole.get('Designer')!.ratio, 0);
  assert.equal(computeRoleImbalanceGap(activity), 1);
});

test('computeRoleImbalanceGap: 단일 역할이면 격차 0', () => {
  const activity = computeRoleActivity([
    makeAgent({ id: '1', role: 'Developer', status: 'working' }),
    makeAgent({ id: '2', role: 'Developer', status: 'idle' }),
  ]);
  assert.equal(computeRoleImbalanceGap(activity), 0);
});

// ─── 충돌 파일 감지 ────────────────────────────────────────────────────

test('computeContentionCounts: 2명 이상 working 점유 파일만 반환', () => {
  const agents = [
    makeAgent({ id: '1', status: 'working', workingOnFileId: 'f1' }),
    makeAgent({ id: '2', status: 'working', workingOnFileId: 'f1' }),
    makeAgent({ id: '3', status: 'working', workingOnFileId: 'f2' }),
    // idle은 점유자로 세지 않음
    makeAgent({ id: '4', status: 'idle', workingOnFileId: 'f1' }),
  ];
  const counts = computeContentionCounts(agents);
  assert.equal(counts.get('f1'), 2);
  assert.equal(counts.has('f2'), false);
  assert.deepEqual([...computeContendedFileIds(agents)], ['f1']);
});

test('hasCriticalContention: 3명 이상 점유 시 true', () => {
  assert.equal(hasCriticalContention(new Map([['f1', 2]])), false);
  assert.equal(hasCriticalContention(new Map([['f1', 3]])), true);
  assert.equal(hasCriticalContention(new Map()), false);
});

test('getTopContendedFile: 최대 점유 파일 반환, 비어있으면 null', () => {
  assert.equal(getTopContendedFile(new Map()), null);
  const top = getTopContendedFile(new Map([['a', 2], ['b', 4], ['c', 3]]));
  assert.deepEqual(top, { fileId: 'b', count: 4 });
});

// ─── 품질 이슈 감지 ────────────────────────────────────────────────────

test('detectIssues: 유효한 레코드는 이슈 없음', () => {
  const agent = makeAgent({
    id: 'a',
    status: 'working',
    workingOnFileId: 'f1',
    currentTask: 'task',
  });
  const issues = detectIssues(
    agent,
    new Set(['f1']),
    new Set(['a']),
    new Set(),
  );
  assert.deepEqual(issues, []);
});

test('detectIssues: stale-working · missing-file · idle-with-task 각각 감지', () => {
  const stale = detectIssues(
    makeAgent({ id: 'a', status: 'working' }),
    new Set(),
    new Set(['a']),
    new Set(),
  );
  assert.ok(stale.includes('stale-working'));

  const missingFile = detectIssues(
    makeAgent({ id: 'a', status: 'working', workingOnFileId: 'ghost', currentTask: 't' }),
    new Set(['f1']),
    new Set(['a']),
    new Set(),
  );
  assert.ok(missingFile.includes('missing-file'));

  const idleDirty = detectIssues(
    makeAgent({ id: 'a', status: 'idle', workingOnFileId: 'f1' }),
    new Set(['f1']),
    new Set(['a']),
    new Set(),
  );
  assert.ok(idleDirty.includes('idle-with-task'));
});

test('detectIssues: 메시지 관련 이슈(자기참조·수신자유실·고아) 감지', () => {
  const selfMsg = detectIssues(
    makeAgent({ id: 'a', lastMessage: 'hi', lastMessageTo: 'a' }),
    new Set(),
    new Set(['a']),
    new Set(),
  );
  assert.ok(selfMsg.includes('self-message'));

  const missingRecipient = detectIssues(
    makeAgent({ id: 'a', lastMessage: 'hi', lastMessageTo: 'ghost' }),
    new Set(),
    new Set(['a']),
    new Set(),
  );
  assert.ok(missingRecipient.includes('missing-recipient'));

  const orphan = detectIssues(
    makeAgent({ id: 'a', lastMessage: 'hi' }),
    new Set(),
    new Set(['a']),
    new Set(),
  );
  assert.ok(orphan.includes('orphan-message'));
});

test('detectIssues: 결과는 심각도 내림차순으로 정렬', () => {
  const issues = detectIssues(
    makeAgent({
      id: 'a',
      status: 'working',
      workingOnFileId: 'f1',
      lastMessage: 'hi',
    }),
    new Set(['f1']),
    new Set(['a']),
    new Set(['f1']),
  );
  // file-contention(4) > orphan-message(2). 순서가 뒤바뀌면 UI 정렬이 깨진다.
  assert.deepEqual(issues, ['file-contention', 'orphan-message']);
});

test('sortIssuesBySeverity: 중복 입력도 심각도 순 유지', () => {
  const sorted = sortIssuesBySeverity([
    'idle-with-task',
    'file-contention',
    'self-message',
  ]);
  assert.deepEqual(sorted, ['file-contention', 'self-message', 'idle-with-task']);
});

// ─── 심각도 밴드 ───────────────────────────────────────────────────────

test('classifySeverity: 충돌 없으면 점수 기반 밴드', () => {
  assert.equal(classifySeverity(0, false), 'clean');
  assert.equal(classifySeverity(1, false), 'minor');
  assert.equal(classifySeverity(MAJOR_SEVERITY_THRESHOLD, false), 'major');
  assert.equal(classifySeverity(MAJOR_SEVERITY_THRESHOLD - 1, false), 'minor');
});

test('classifySeverity: 3명 이상 충돌이면 점수 무관 critical', () => {
  assert.equal(classifySeverity(0, true), 'critical');
  assert.equal(classifySeverity(999, true), 'critical');
});

test('computeAgentSeverity / computeTotalSeverity: 이슈 가중치 합산', () => {
  const issues: QualityIssue[] = ['file-contention', 'idle-with-task'];
  const expected =
    QUALITY_SEVERITY_WEIGHTS['file-contention'] +
    QUALITY_SEVERITY_WEIGHTS['idle-with-task'];
  assert.equal(computeAgentSeverity(issues), expected);

  const map = new Map<string, QualityIssue[]>([
    ['a', ['file-contention']],
    ['b', ['idle-with-task', 'self-message']],
  ]);
  assert.equal(
    computeTotalSeverity(map),
    QUALITY_SEVERITY_WEIGHTS['file-contention'] +
      QUALITY_SEVERITY_WEIGHTS['idle-with-task'] +
      QUALITY_SEVERITY_WEIGHTS['self-message'],
  );
});

test('summarizeIssueCounts / getPrimaryIssue: 심각도 우선·건수 보조', () => {
  const map = new Map<string, QualityIssue[]>([
    ['a', ['idle-with-task', 'idle-with-task']],
    ['b', ['file-contention']],
  ]);
  const counts = summarizeIssueCounts(map);
  assert.equal(counts.get('idle-with-task'), 2);
  assert.equal(counts.get('file-contention'), 1);

  const primary = getPrimaryIssue(counts);
  // 건수는 idle이 많지만 심각도 더 높은 contention이 우선.
  assert.deepEqual(primary, { issue: 'file-contention', count: 1 });

  assert.equal(getPrimaryIssue(new Map()), null);
});

// ─── 협업 네트워크 ────────────────────────────────────────────────────

test('computeCollaborationEdges: 자기참조·유실 수신자는 제외', () => {
  const agents = [
    makeAgent({ id: 'a', lastMessageTo: 'b' }),
    makeAgent({ id: 'b', lastMessageTo: 'b' }), // self
    makeAgent({ id: 'c', lastMessageTo: 'ghost' }), // missing
    makeAgent({ id: 'd' }), // no message
  ];
  const edges = computeCollaborationEdges(agents, new Set(['a', 'b', 'c', 'd']));
  assert.deepEqual(edges, [{ from: 'a', to: 'b' }]);
});

test('computeIsolatedAgentIds / computeIsolationRatio: 엣지에 안 걸린 사람만 고립', () => {
  const agents = [
    makeAgent({ id: 'a', lastMessageTo: 'b' }),
    makeAgent({ id: 'b' }),
    makeAgent({ id: 'c' }),
  ];
  const edges = [{ from: 'a', to: 'b' }];
  const isolated = computeIsolatedAgentIds(agents, edges);
  assert.deepEqual([...isolated], ['c']);
  assert.equal(computeIsolationRatio(agents, isolated), 1 / 3);
  assert.equal(computeIsolationRatio([], new Set()), 0);
});

test('classifyIsolationBand: 경계값 기준 밴드 전환', () => {
  assert.equal(classifyIsolationBand(0), 'healthy');
  assert.equal(classifyIsolationBand(ISOLATION_ALERT_THRESHOLD - 0.01), 'watch');
  assert.equal(classifyIsolationBand(ISOLATION_ALERT_THRESHOLD), 'alert');
  assert.equal(classifyIsolationBand(1), 'alert');
});

test('computeIncomingMessageCounts / getCommunicationHub / computeHubConcentration', () => {
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'c', to: 'b' },
    { from: 'd', to: 'e' },
  ];
  const counts = computeIncomingMessageCounts(edges);
  assert.equal(counts.get('b'), 2);
  assert.equal(counts.get('e'), 1);

  const hub = getCommunicationHub(counts);
  assert.deepEqual(hub, { agentId: 'b', count: 2 });
  assert.equal(computeHubConcentration(edges, hub), 2 / 3);

  assert.equal(computeHubConcentration([], hub), 0);
  assert.equal(computeHubConcentration(edges, null), 0);
  assert.equal(getCommunicationHub(new Map()), null);
});

// ─── 파사드 ───────────────────────────────────────────────────────────

test('classifyHubBand: 임계값 기준 경계 동작', () => {
  assert.equal(classifyHubBand(0), 'balanced');
  assert.equal(classifyHubBand(HUB_WATCH_THRESHOLD - 0.01), 'balanced');
  assert.equal(classifyHubBand(HUB_WATCH_THRESHOLD), 'watch');
  assert.equal(classifyHubBand(HUB_SPOF_THRESHOLD - 0.01), 'watch');
  assert.equal(classifyHubBand(HUB_SPOF_THRESHOLD), 'spof');
  assert.equal(classifyHubBand(1), 'spof');
});

test('getHubBandLabel/Glyph/Tone: 3개 밴드가 서로 다른 표기를 갖는다', () => {
  const bands = ['balanced', 'watch', 'spof'] as const;
  const labels = bands.map(getHubBandLabel);
  const glyphs = bands.map(getHubBandGlyph);
  const tones = bands.map(getHubBandTone);
  assert.equal(new Set(labels).size, 3);
  assert.equal(new Set(glyphs).size, 3);
  assert.equal(new Set(tones).size, 3);
});

test('buildQualityReport: 흩어진 지표를 한 객체로 접는다', () => {
  const agents: Agent[] = [
    makeAgent({
      id: 'a',
      status: 'working',
      workingOnFileId: 'f1',
      lastMessage: 'hi',
      lastMessageTo: 'b',
    }),
    makeAgent({
      id: 'b',
      status: 'working',
      workingOnFileId: 'f1',
      lastMessageTo: 'a',
    }),
    makeAgent({ id: 'c', status: 'idle' }),
  ];
  const files = [makeFile('f1')];
  const report = buildQualityReport(agents, files);

  // f1을 두 명이 점유 → file-contention(2명)
  assert.equal(report.issueCounts.get('file-contention'), 2);
  assert.deepEqual(report.topContendedFile, { fileId: 'f1', count: 2 });
  assert.equal(report.severityBand, 'major');
  // c는 아무와도 대화하지 않아 고립
  assert.equal(report.isolationRatio, 1 / 3);
  assert.equal(report.isolationBand, 'watch');
  // 허브는 a↔b 왕복 중 동률이라 먼저 집계된 쪽이 허브.
  assert.ok(report.communicationHub);
  assert.equal(report.hubConcentration, 0.5);
  assert.equal(report.hubBand, 'spof');
});

// ─── 인박스 지시 요약 글리프 ───────────────────────────────────────────

test('getDirectiveStatusGlyph: 4개 상태 모두 유니크 글리프로 매핑', () => {
  const glyphs = [
    getDirectiveStatusGlyph('open'),
    getDirectiveStatusGlyph('wip'),
    getDirectiveStatusGlyph('done'),
    getDirectiveStatusGlyph('blocked'),
  ];
  // 같은 글리프가 두 상태에 배정되면 리더가 UI에서 상태를 구분할 수 없게 된다.
  assert.equal(new Set(glyphs).size, 4);
  // collab-ui 리포트 §3 에서 합의한 매핑 고정.
  assert.deepEqual(glyphs, ['○', '◔', '◉', '◆']);
});

// ─── 파이프라인 역할 라벨 ─────────────────────────────────────────────
//
// 배경: 파이프라인 배지는 색상에만 의존하지 않도록 한국어 라벨로 상태를 드러낸다.
// 라벨이 중복되거나 비어 버리면 색약 사용자와 스크린리더 사용자가 구분을 잃는다.

test('getPipelineRoleLabel: 5개 역할 모두 고유·비어있지 않은 한국어 라벨', () => {
  const roles = ['router', 'executor', 'verifier', 'standby', 'vacant'] as const;
  const labels = roles.map(getPipelineRoleLabel);
  assert.equal(new Set(labels).size, 5, '라벨이 겹치면 배지 의미 구분이 사라진다');
  for (const label of labels) {
    assert.ok(label.trim().length > 0, '빈 라벨은 접근성 라벨을 깨뜨린다');
  }
  // 디자이너 §7.1에서 합의한 매핑 고정 — UI 문구 회귀 방지.
  assert.equal(getPipelineRoleLabel('router'), '라우터');
  assert.equal(getPipelineRoleLabel('executor'), '실작업');
  assert.equal(getPipelineRoleLabel('verifier'), '검수');
  assert.equal(getPipelineRoleLabel('standby'), '대기');
  assert.equal(getPipelineRoleLabel('vacant'), '결원');
});

test('getDirectiveStatusLabel: 라벨도 상태마다 중복되지 않음', () => {
  const labels = [
    getDirectiveStatusLabel('open'),
    getDirectiveStatusLabel('wip'),
    getDirectiveStatusLabel('done'),
    getDirectiveStatusLabel('blocked'),
  ];
  assert.equal(new Set(labels).size, 4);
});

test('buildQualityReport: 정상 상태는 clean · healthy', () => {
  const agents: Agent[] = [
    makeAgent({ id: 'a', status: 'idle' }),
    makeAgent({ id: 'b', status: 'idle' }),
  ];
  const report = buildQualityReport(agents, []);
  assert.equal(report.totalIssues, 0);
  assert.equal(report.severityBand, 'clean');
  assert.equal(report.isolationBand, 'alert'); // 대화 없음 → 전원 고립
  assert.equal(report.communicationHub, null);
  assert.equal(report.hubConcentration, 0);
  assert.equal(report.hubBand, 'balanced');
});

// ─── 시각적 우선순위 · 버블/에이전트 노드 vs 파일 노드 ──────────────────
//
// 배경: 프로젝트에 코드 파일이 많아지면 캔버스에 파일 노드(작은 원)가 빽빽해지고,
// 에이전트 머리 위 AgentContextBubble(상시 노출)과 대화 말풍선이 그 아래에 깔려
// 가려지는 사고가 보고됐다. 시각 계층은 런타임 DOM 테스트 없이도 소스 수준의
// z-index 클래스 · DOM 순서 불변식으로 고정할 수 있으므로, 그래프 밀도가 아무리
// 커져도 핵심 HUD가 묻히지 않도록 이 구역에서 정적 검증한다.

const CONTEXT_BUBBLE_SRC = readFileSync(
  fileURLToPath(new URL('./AgentContextBubble.tsx', import.meta.url)),
  'utf8',
);
const APP_SRC = readFileSync(
  fileURLToPath(new URL('../App.tsx', import.meta.url)),
  'utf8',
);

function extractZIndex(src: string, anchor: RegExp): number {
  const snippet = src.match(anchor);
  if (!snippet) throw new Error(`anchor not found: ${anchor}`);
  const z = snippet[0].match(/z-(\d+)/);
  if (!z) throw new Error(`no z-index on anchor: ${anchor}`);
  return Number(z[1]);
}

test('AgentContextBubble: 상시 오버레이 속성(absolute · pointer-events-none)을 유지', () => {
  // absolute를 벗으면 sprite 위가 아니라 일반 흐름에 들어가 레이아웃을 밀어버린다.
  // pointer-events-none이 빠지면 겹친 파일 노드의 hover 툴팁을 빨아들여
  // 코드그래프 탐색이 막히는 회귀가 과거에 발생했다.
  assert.match(CONTEXT_BUBBLE_SRC, /absolute\s+bottom-\[68px\]/);
  assert.match(CONTEXT_BUBBLE_SRC, /pointer-events-none/);
});

test('AgentSprite 컨테이너가 파일 노드보다 높은 z-index로 쌓인다', () => {
  // 이 불변식이 깨지면 에이전트 아바타와 그 위의 컨텍스트 버블이 모두
  // 파일 노드 원에 가려진다. 파일 수가 많아질수록 가려질 확률이 선형 증가하므로
  // 숫자를 소스에서 직접 비교해 회귀를 차단한다.
  const fileZ = extractZIndex(
    APP_SRC,
    /absolute w-4 h-4 rounded-full border-2 border-black z-\d+/,
  );
  const spriteZ = extractZIndex(APP_SRC, /absolute cursor-pointer group z-\d+/);
  assert.ok(
    spriteZ > fileZ,
    `agent sprite(z-${spriteZ}) must outrank file node(z-${fileZ})`,
  );
});

test('대화 말풍선 z-index가 sprite 컨테이너 z-index 이상이어야 가려지지 않는다', () => {
  // 말풍선은 sprite 내부 stacking context 안에서 뜨므로 동률(>=)이면 충분하다.
  // sprite보다 낮아지면 같은 카드 안에서도 아바타 뒤로 깔린다.
  const dialogueZ = extractZIndex(
    APP_SRC,
    /text-\[11px\] leading-tight z-\d+/,
  );
  const spriteZ = extractZIndex(APP_SRC, /absolute cursor-pointer group z-\d+/);
  assert.ok(
    dialogueZ >= spriteZ,
    `dialogue bubble(z-${dialogueZ}) must not drop below sprite(z-${spriteZ})`,
  );
});

test('DOM 순서: 파일 노드 렌더 블록이 에이전트 sprite 렌더 블록보다 먼저 등장', () => {
  // z-index가 동률일 때의 최후 보루. 파일 노드를 나중에 그리면
  // 동률 상황에서 파일이 스프라이트를 덮는다. 순서는 "파일 → 에이전트"여야 한다.
  const fileAnchor = APP_SRC.indexOf(
    'absolute w-4 h-4 rounded-full border-2 border-black',
  );
  const agentAnchor = APP_SRC.indexOf('absolute cursor-pointer group');
  assert.ok(fileAnchor > 0 && agentAnchor > 0, 'both anchors must exist');
  assert.ok(
    fileAnchor < agentAnchor,
    'file nodes must be rendered before agents so equal-z stacking favors agents',
  );
});

test('회귀: 파일 노드 200개와 겹쳐도 에이전트 상태 집계는 파일 수에 독립적', () => {
  // 노이즈가 큰 그래프에서 summarize/buildQualityReport가 "보이는 것"에 휘둘리면
  // 대시보드 숫자가 파일 임포트 때마다 요동친다. 파일 목록과 완전히 독립이어야 한다.
  const agents: Agent[] = [
    makeAgent({ id: '1', status: 'working', workingOnFileId: 'f0', currentTask: 't' }),
    makeAgent({ id: '2', status: 'thinking' }),
    makeAgent({ id: '3', status: 'idle' }),
  ];
  const baseline = summarize(agents);
  const sparse = buildQualityReport(agents, [makeFile('f0')]);
  const dense = buildQualityReport(
    agents,
    Array.from({ length: 200 }, (_, i) => makeFile(`f${i}`)),
  );
  // 상태 카운트는 그래프 크기와 무관해야 한다.
  assert.deepEqual(summarize(agents), baseline);
  // 이슈 집계·고립률 같은 에이전트 축 지표도 파일 수에 흔들리지 않아야 한다.
  assert.equal(sparse.totalIssues, dense.totalIssues);
  assert.equal(sparse.isolationRatio, dense.isolationRatio);
  assert.equal(sparse.severityBand, dense.severityBand);
});

test('회귀: 밀집 그래프에서 한 파일에 다수가 겹쳐도 critical 경쟁을 놓치지 않는다', () => {
  // 파일 노드 수가 많아질수록 경쟁 파일을 찾는 로직이 다른 파일들 사이에
  // 묻힐 위험이 있다. 5명이 f0 한 곳에 몰려도 여전히 critical·top=f0로 집어내야 한다.
  const files = Array.from({ length: 300 }, (_, i) => makeFile(`f${i}`));
  const agents = Array.from({ length: 10 }, (_, i) =>
    makeAgent({
      id: `a${i}`,
      status: 'working',
      workingOnFileId: i < 5 ? 'f0' : `f${i + 10}`,
      currentTask: 'task',
    }),
  );
  const report = buildQualityReport(agents, files);
  assert.equal(report.severityBand, 'critical');
  assert.deepEqual(report.topContendedFile, { fileId: 'f0', count: 5 });
  // 경쟁 파일은 "f0" 하나뿐 — 나머지 295개 파일이 잡음으로 끼어들면 안 된다.
  assert.equal(report.issueCounts.get('file-contention'), 5);
});

test('AgentContextBubble 자체 z-index가 파일 노드 z-index 이상이어야 한다', () => {
  // sprite 컨테이너가 z-40을 유지해도, 버블 자체가 낮은 z를 들고 있으면
  // 다른 stacking context에 재배치될 때(예: React portal, transform 레이어)
  // 파일 노드 뒤로 깔린다. 버블 소스 자체에서 직접 z를 고정해 회귀를 차단한다.
  const bubbleZ = extractZIndex(
    CONTEXT_BUBBLE_SRC,
    /bg-black\/85[^"']*?z-\d+/,
  );
  const fileZ = extractZIndex(
    APP_SRC,
    /absolute w-4 h-4 rounded-full border-2 border-black z-\d+/,
  );
  assert.ok(
    bubbleZ >= fileZ,
    `context bubble(z-${bubbleZ}) must not drop below file node(z-${fileZ})`,
  );
});

test('AgentContextBubble 하이라이트 상태에서도 z·pointer-events 불변식이 유지된다', () => {
  // 하이라이트 분기에서 클래스 템플릿이 분할되면서 z-40이나 pointer-events-none이
  // 한쪽 분기에서만 빠지는 사고가 있었다. 소스 상수 하나에 두 속성이 함께
  // 박혀 있어야 분기 추가에도 양쪽이 같이 이동한다.
  const baseClassLine = CONTEXT_BUBBLE_SRC.match(
    /absolute\s+bottom-\[68px\][^`"']*/,
  );
  assert.ok(baseClassLine, '버블 기본 클래스 라인을 찾지 못함');
  const line = baseClassLine[0];
  assert.match(line, /z-\d+/, 'z-index가 기본 클래스에 고정되어야 한다');
  assert.match(
    line,
    /pointer-events-none/,
    'pointer-events-none이 기본 클래스에 고정되어야 한다',
  );
});

test('AgentContextBubble 폭이 고정되어 파일 노드를 과도하게 가리지 않는다', () => {
  // 버블 폭이 무제한이면 밀집 그래프에서 한 에이전트의 버블이 수십 개 파일 노드의
  // hover 영역을 덮는다. 포인터 이벤트는 none이라 기능은 안 막히지만, 시선 점유가
  // 과도해 탐색 피로가 커진다. w-[NNNpx] 형태의 고정 폭이 유지되는지 확인한다.
  const widthMatch = CONTEXT_BUBBLE_SRC.match(/w-\[(\d+)px\]/);
  assert.ok(widthMatch, '버블에 고정 폭 클래스가 있어야 한다');
  const width = Number(widthMatch[1]);
  // 의도된 범위. 너무 좁으면 로그가 잘리고, 너무 넓으면 캔버스를 가린다.
  assert.ok(
    width >= 120 && width <= 260,
    `bubble width ${width}px must stay within readable/compact range`,
  );
});

test('대화 말풍선 z-index 자체가 파일 노드 z-index 이상이어야 한다', () => {
  // sprite 컨테이너 하위라 상대적으로 비교해도 충분하지만, motion.div가 종종
  // transform 레이어로 승격되며 새로운 stacking context를 만든다. 말풍선 자체
  // z가 파일 노드 z보다 낮으면 승격 시 파일에 깔린다.
  const dialogueZ = extractZIndex(
    APP_SRC,
    /text-\[11px\] leading-tight z-\d+/,
  );
  const fileZ = extractZIndex(
    APP_SRC,
    /absolute w-4 h-4 rounded-full border-2 border-black z-\d+/,
  );
  assert.ok(
    dialogueZ >= fileZ,
    `dialogue bubble(z-${dialogueZ}) must not drop below file node(z-${fileZ})`,
  );
});

test('회귀: 파일 노드 1000개 규모에서도 품질 리포트가 파일 수에 독립적', () => {
  // 프로젝트가 성숙하면 코드 파일이 수백~수천 개로 늘어난다. 이 때 파일 축 크기가
  // 에이전트 축 지표를 흔들면 대시보드가 "노이즈로 붉어지는" 증상이 발생한다.
  // 파일이 10개일 때와 1000개일 때 리포트의 핵심 필드가 동일해야 한다.
  const agents: Agent[] = [
    makeAgent({ id: '1', status: 'working', workingOnFileId: 'f0', currentTask: 't', lastMessageTo: '2' }),
    makeAgent({ id: '2', status: 'working', workingOnFileId: 'f1', currentTask: 't', lastMessageTo: '1' }),
    makeAgent({ id: '3', status: 'idle' }),
  ];
  const small = buildQualityReport(
    agents,
    Array.from({ length: 10 }, (_, i) => makeFile(`f${i}`)),
  );
  const huge = buildQualityReport(
    agents,
    Array.from({ length: 1000 }, (_, i) => makeFile(`f${i}`)),
  );
  assert.equal(small.totalIssues, huge.totalIssues);
  assert.equal(small.totalSeverity, huge.totalSeverity);
  assert.equal(small.severityBand, huge.severityBand);
  assert.equal(small.isolationRatio, huge.isolationRatio);
  assert.equal(small.hubConcentration, huge.hubConcentration);
});

// ─── 표기 유틸 밴드 유일성 ────────────────────────────────────────────
//
// 배경: 심각도/고립 밴드 라벨·글리프가 두 밴드에 같은 표기를 배정하면
// 대시보드에서 상태 전환이 사용자 눈에 보이지 않아 "정상처럼 보이는 장애"가 된다.
// 테이블 매핑이므로 소스만 검사해도 회귀를 잡을 수 있고, 분기 추가 시 이 테스트가
// 즉시 실패하므로 새 밴드가 기존 표기와 겹치지 않도록 강제한다.

test('getSeverityBandLabel/Glyph: 4개 밴드가 서로 다른 표기를 갖는다', () => {
  const bands = ['clean', 'minor', 'major', 'critical'] as const;
  const labels = bands.map(getSeverityBandLabel);
  const glyphs = bands.map(getSeverityBandGlyph);
  assert.equal(new Set(labels).size, 4, '라벨이 중복되면 밴드 전환이 보이지 않는다');
  assert.equal(new Set(glyphs).size, 4, '글리프가 중복되면 색약 사용자가 톤 차이를 놓친다');
});

test('getIsolationBandLabel/Glyph: 3개 밴드가 서로 다른 표기를 갖는다', () => {
  const bands = ['healthy', 'watch', 'alert'] as const;
  const labels = bands.map(getIsolationBandLabel);
  const glyphs = bands.map(getIsolationBandGlyph);
  assert.equal(new Set(labels).size, 3);
  assert.equal(new Set(glyphs).size, 3);
});

// ─── 상태 글리프 폴백 ─────────────────────────────────────────────────

test('getStatusGlyph: 4개 상태 모두 고유 글리프, 미지 상태는 idle로 폴백', () => {
  const glyphs = [
    getStatusGlyph('idle'),
    getStatusGlyph('working'),
    getStatusGlyph('meeting'),
    getStatusGlyph('thinking'),
  ];
  assert.equal(new Set(glyphs).size, 4);
  // 런타임에서 미지의 status 문자열이 유입돼도 UI가 "빈칸"이 되지 않도록 idle로 폴백.
  assert.equal(getStatusGlyph('unknown-status'), getStatusGlyph('idle'));
  assert.equal(getStatusGlyph(''), getStatusGlyph('idle'));
});

// ─── 활성 상태 판정 ───────────────────────────────────────────────────

test('isActiveAgent: idle만 비활성, 나머지 3개 상태는 활성', () => {
  assert.equal(isActiveAgent(makeAgent({ status: 'idle' })), false);
  assert.equal(isActiveAgent(makeAgent({ status: 'working' })), true);
  assert.equal(isActiveAgent(makeAgent({ status: 'meeting' })), true);
  assert.equal(isActiveAgent(makeAgent({ status: 'thinking' })), true);
});

// ─── 모션 가드 ────────────────────────────────────────────────────────
//
// 배경: reducedMotion은 접근성 설정이다. 이 가드가 한쪽 분기에서라도 새면
// 전정기능 민감 사용자에게 구토·현기증을 유발한다. shouldPulse가
// "활성 상태 × 모션 허용"의 단일 교집합만 통과시키는지 모든 조합으로 고정한다.

test('shouldPulse: reducedMotion=true면 상태 무관하게 false', () => {
  // 접근성 우선 규칙 — 어떤 활성 상태도 reducedMotion을 이길 수 없다.
  assert.equal(shouldPulse('idle', true), false);
  assert.equal(shouldPulse('working', true), false);
  assert.equal(shouldPulse('meeting', true), false);
  assert.equal(shouldPulse('thinking', true), false);
});

test('shouldPulse: reducedMotion=false면 idle만 제외하고 모두 펄스', () => {
  // idle은 "움직임 없음"의 시각적 의미이므로 펄스 없이 고정.
  assert.equal(shouldPulse('idle', false), false);
  assert.equal(shouldPulse('working', false), true);
  assert.equal(shouldPulse('meeting', false), true);
  assert.equal(shouldPulse('thinking', false), true);
});

test('shouldPulse: isActiveAgent와 동일한 활성 정의를 공유해야 한다', () => {
  // 두 헬퍼가 "활성" 판정을 다르게 내리면 리스트 정렬과 펄스 애니메이션이
  // 엇박자가 난다. 동일 상태 축에서 결과 집합이 일치하는지 확인한다.
  const statuses = ['idle', 'working', 'meeting', 'thinking'] as const;
  for (const status of statuses) {
    const active = isActiveAgent(makeAgent({ status }));
    // reducedMotion=false일 때 shouldPulse는 활성 정의와 동치여야 한다.
    assert.equal(
      shouldPulse(status, false),
      active,
      `shouldPulse(${status}) must match isActiveAgent when reducedMotion=false`,
    );
  }
});

// ─── 아바타 팔레트 ────────────────────────────────────────────────────

test('resolveAvatarTint: 공식 역할은 고정 팔레트, 미지 역할은 이름 기반 결정론', () => {
  // 공식 역할은 한번 결정된 팔레트가 흔들리면 안 됨(사용자 인지 기억 붕괴).
  assert.equal(resolveAvatarTint('designer'), resolveAvatarTint('designer'));
  // 같은 "비공식" 역할 이름은 같은 색으로 재현되어야 대시보드 재로드 시 색이 바뀌지 않는다.
  assert.equal(resolveAvatarTint('ops'), resolveAvatarTint('ops'));
  // 빈 문자열은 중성 폴백 경로로 진입해야 함(해시 인덱스 예외 회피).
  assert.match(resolveAvatarTint(''), /text-white/);
});

// ─── 역할 분포 ────────────────────────────────────────────────────────

test('summarizeByRole: 역할별 인원수 집계, 인원 많은 순 정렬', () => {
  const agents = [
    makeAgent({ id: '1', role: 'Developer' }),
    makeAgent({ id: '2', role: 'Developer' }),
    makeAgent({ id: '3', role: 'Developer' }),
    makeAgent({ id: '4', role: 'Designer' }),
    makeAgent({ id: '5', role: 'QA' }),
    makeAgent({ id: '6', role: 'QA' }),
  ];
  const byRole = summarizeByRole(agents);
  assert.deepEqual(byRole[0], ['Developer', 3]);
  assert.deepEqual(byRole[1], ['QA', 2]);
  assert.deepEqual(byRole[2], ['Designer', 1]);
});

test('summarizeByRole: 빈 배열은 빈 결과', () => {
  assert.deepEqual(summarizeByRole([]), []);
});

test('회귀: 파일 노드와 에이전트 좌표가 겹치는 최악 케이스에서도 z 불변식이 성립', () => {
  // "파일 노드와 에이전트가 같은 픽셀에 놓인다"는 극단 상황은 숫자 비교만으로는
  // 충분하지 않다. (1) 파일 z < 스프라이트 z, (2) 스프라이트 z ≤ 대화 버블 z,
  // (3) 스프라이트 z ≤ 컨텍스트 버블 z — 세 조건을 한 번에 묶어 "겹쳐도 HUD가
  // 아래로 깔리지 않는다"는 계약을 명시적으로 기록한다.
  const fileZ = extractZIndex(
    APP_SRC,
    /absolute w-4 h-4 rounded-full border-2 border-black z-\d+/,
  );
  const spriteZ = extractZIndex(APP_SRC, /absolute cursor-pointer group z-\d+/);
  const dialogueZ = extractZIndex(APP_SRC, /text-\[11px\] leading-tight z-\d+/);
  const bubbleZ = extractZIndex(CONTEXT_BUBBLE_SRC, /bg-black\/85[^"']*?z-\d+/);
  assert.ok(spriteZ > fileZ, '스프라이트가 파일보다 위여야 한다');
  assert.ok(dialogueZ >= spriteZ, '대화 버블이 스프라이트 이상이어야 한다');
  assert.ok(bubbleZ >= spriteZ, '컨텍스트 버블이 스프라이트 이상이어야 한다');
});

// ── §④ 협업 지표 — forbiddenSoloRate 톤 밴드 ──────────────────────────
// 근거: docs/handoffs/2026-04-17-alpha-to-beta-collab-audit.md §④ 톤 매핑 표.

test('classifyForbiddenSoloBand: 0 이면 clear', () => {
  assert.equal(classifyForbiddenSoloBand(0), 'clear');
});

test('classifyForbiddenSoloBand: (0, threshold] 구간은 caution', () => {
  assert.equal(classifyForbiddenSoloBand(0.01), 'caution');
  assert.equal(classifyForbiddenSoloBand(0.2), 'caution');
  assert.equal(classifyForbiddenSoloBand(DEFAULT_FORBIDDEN_SOLO_THRESHOLD), 'caution');
});

test('classifyForbiddenSoloBand: threshold 초과는 exceeded', () => {
  assert.equal(classifyForbiddenSoloBand(0.21), 'exceeded');
  assert.equal(classifyForbiddenSoloBand(1), 'exceeded');
});

test('classifyForbiddenSoloBand: 커스텀 threshold 를 우선 적용', () => {
  assert.equal(classifyForbiddenSoloBand(0.3, 0.4), 'caution');
  assert.equal(classifyForbiddenSoloBand(0.41, 0.4), 'exceeded');
});

test('getForbiddenSoloBandTone: 각 밴드가 서로 다른 border/text 톤 반환', () => {
  const tones = new Set([
    getForbiddenSoloBandTone('clear'),
    getForbiddenSoloBandTone('caution'),
    getForbiddenSoloBandTone('exceeded'),
  ]);
  assert.equal(tones.size, 3, '세 밴드는 모두 고유한 톤을 가져야 한다');
  assert.ok(getForbiddenSoloBandTone('exceeded').includes('red'));
  assert.ok(getForbiddenSoloBandTone('caution').includes('yellow'));
  assert.ok(getForbiddenSoloBandTone('clear').includes('green'));
});
