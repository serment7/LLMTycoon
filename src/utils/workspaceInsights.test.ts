// Run with: tsx --test src/utils/workspaceInsights.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeDesignerVacancy,
  computeForbiddenSoloRate,
  describeDirectiveRouting,
  describeForbiddenSoloRate,
  derivePipelineRole,
  parseDirectiveBlocks,
  summarizeDirectiveRouting,
  summarizePipelineRoles,
  DirectiveEntry,
  SoloHandlingRecord,
} from './workspaceInsights.ts';

const record = (overrides: Partial<SoloHandlingRecord> = {}): SoloHandlingRecord => ({
  directiveDigest: overrides.directiveDigest ?? 'dir',
  tick: overrides.tick ?? 'tick=now',
  verdict: overrides.verdict ?? 'forbidden',
  delegatedCount: overrides.delegatedCount ?? 1,
  alphaSoloNote: overrides.alphaSoloNote ?? '없음',
});

test('computeForbiddenSoloRate: 빈 배열은 0 비율·임계 미초과', () => {
  const result = computeForbiddenSoloRate([]);
  assert.equal(result.rate, 0);
  assert.equal(result.denominator, 0);
  assert.equal(result.numerator, 0);
  assert.equal(result.thresholdExceeded, false);
  assert.deepEqual(result.offendingDirectives, []);
});

test('computeForbiddenSoloRate: forbidden 3건 전부 위임되면 rate=0', () => {
  const records = [
    record({ directiveDigest: 'a', delegatedCount: 1 }),
    record({ directiveDigest: 'b', delegatedCount: 2 }),
    record({ directiveDigest: 'c', delegatedCount: 1 }),
  ];
  const result = computeForbiddenSoloRate(records);
  assert.equal(result.rate, 0);
  assert.equal(result.denominator, 3);
  assert.equal(result.numerator, 0);
  assert.equal(result.thresholdExceeded, false);
});

test('computeForbiddenSoloRate: forbidden 5건 중 2건 단독이면 임계 초과', () => {
  const records = [
    record({ directiveDigest: 'a', delegatedCount: 0, alphaSoloNote: '긴급' }),
    record({ directiveDigest: 'b', delegatedCount: 1 }),
    record({ directiveDigest: 'c', delegatedCount: 0, alphaSoloNote: '긴급' }),
    record({ directiveDigest: 'd', delegatedCount: 2 }),
    record({ directiveDigest: 'e', delegatedCount: 1 }),
  ];
  const result = computeForbiddenSoloRate(records);
  assert.equal(result.rate, 0.4);
  assert.equal(result.denominator, 5);
  assert.equal(result.numerator, 2);
  assert.equal(result.thresholdExceeded, true);
  assert.deepEqual(result.offendingDirectives, ['a', 'c']);
});

test('computeForbiddenSoloRate: allowed 레코드는 분모에서 제외', () => {
  const records = [
    record({ directiveDigest: 'a', verdict: 'allowed', delegatedCount: 0 }),
    record({ directiveDigest: 'b', verdict: 'forbidden', delegatedCount: 0 }),
  ];
  const result = computeForbiddenSoloRate(records);
  assert.equal(result.denominator, 1);
  assert.equal(result.numerator, 1);
  assert.equal(result.rate, 1);
  assert.equal(result.thresholdExceeded, true);
});

test('computeForbiddenSoloRate: windowSize는 배열 꼬리부터 잘라낸다', () => {
  // 앞쪽 오래된 위반, 꼬리 3개는 모두 위임됨 → 꼬리 3개만 보면 rate=0
  const records: SoloHandlingRecord[] = [
    record({ directiveDigest: 'old', delegatedCount: 0 }),
    record({ directiveDigest: 'old2', delegatedCount: 0 }),
    record({ directiveDigest: 'r1', delegatedCount: 1 }),
    record({ directiveDigest: 'r2', delegatedCount: 1 }),
    record({ directiveDigest: 'r3', delegatedCount: 1 }),
  ];
  const result = computeForbiddenSoloRate(records, 3);
  assert.equal(result.denominator, 3);
  assert.equal(result.numerator, 0);
  assert.equal(result.rate, 0);
});

test('computeForbiddenSoloRate: 비정상 windowSize는 기본값으로 대체', () => {
  const records = [record({ delegatedCount: 0 })];
  const result = computeForbiddenSoloRate(records, -1);
  assert.equal(result.denominator, 1);
});

test('describeForbiddenSoloRate: 표본 없음 문구', () => {
  const line = describeForbiddenSoloRate({
    rate: 0,
    denominator: 0,
    numerator: 0,
    thresholdExceeded: false,
    offendingDirectives: [],
  });
  assert.equal(line, '❌ 단독 처리율: 표본 없음');
});

test('describeForbiddenSoloRate: 임계 초과 플래그 부착', () => {
  const line = describeForbiddenSoloRate({
    rate: 0.4,
    denominator: 5,
    numerator: 2,
    thresholdExceeded: true,
    offendingDirectives: ['a', 'c'],
  });
  assert.equal(line, '❌ 단독 처리율 40.0% (2/5) · 임계 초과');
});

test('derivePipelineRole: 리더는 항상 router', () => {
  assert.equal(derivePipelineRole({ role: 'Leader', status: 'working' }), 'router');
  assert.equal(derivePipelineRole({ role: 'Leader', status: 'idle' }), 'router');
});

test('derivePipelineRole: Designer는 working이 아니면 vacant, working이면 executor', () => {
  assert.equal(derivePipelineRole({ role: 'Designer', status: 'idle' }), 'vacant');
  assert.equal(derivePipelineRole({ role: 'Designer', status: 'thinking' }), 'vacant');
  assert.equal(derivePipelineRole({ role: 'Designer', status: 'working' }), 'executor');
});

test('derivePipelineRole: 일반 역할은 working이면 executor, 아니면 standby', () => {
  assert.equal(derivePipelineRole({ role: 'Developer', status: 'working' }), 'executor');
  assert.equal(derivePipelineRole({ role: 'Developer', status: 'idle' }), 'standby');
  assert.equal(derivePipelineRole({ role: 'QA', status: 'meeting' }), 'standby');
  assert.equal(derivePipelineRole({ role: 'Researcher', status: 'working' }), 'executor');
});

test('summarizePipelineRoles: 역할별 카운트 집계', () => {
  const breakdown = summarizePipelineRoles([
    { role: 'Leader', status: 'working' },
    { role: 'Developer', status: 'working' },
    { role: 'Researcher', status: 'idle' },
    { role: 'Designer', status: 'idle' },
    { role: 'QA', status: 'working' },
  ]);
  assert.deepEqual(breakdown, {
    router: 1,
    executor: 2,
    verifier: 0,
    vacant: 1,
    standby: 1,
  });
});

test('summarizePipelineRoles: 빈 입력은 모두 0', () => {
  assert.deepEqual(summarizePipelineRoles([]), {
    router: 0,
    executor: 0,
    verifier: 0,
    vacant: 0,
    standby: 0,
  });
});

// ── DirectiveEntry 파서 + summarizeDirectiveRouting ───────────────

const inboxSample = `---
date: 2026-04-17
owner: 알파
---

### [tick=now] 단독 작업 중단 및 지시 로깅 체계화
- **원문 프롬프트**: "왜 분업 안시키고 있지?"
- **분해**:
  1. 인박스 신설
  2. 프로토콜 개정
- **위임**: \`docs/handoffs/2026-04-17-alpha-to-beta-directive-logging.md\` → REPORT
- **알파 자체 처리분**: 프로토콜 개정, 인박스 스캐폴딩
- **상태**: done

### [tick=now+1] 리더 분업 워크플로우 강제화
- **원문 프롬프트**: "리더가 분업시키게 수정해줘"
- **분해**:
  1. 프로토콜 v2
- **위임**:
  - \`docs/handoffs/2026-04-17-alpha-to-beta-delegation-workflow.md\`
  - \`docs/handoffs/2026-04-17-alpha-to-designer-slot-vacancy.md\`
- **알파 자체 처리분**: 없음
- **상태**: done
`;

test('parseDirectiveBlocks: 인박스 샘플에서 2개 블록을 추출', () => {
  const entries = parseDirectiveBlocks(inboxSample, 'docs/inbox/sample.md');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].tick, 'tick=now');
  assert.equal(entries[0].digest, '단독 작업 중단 및 지시 로깅 체계화');
  assert.equal(entries[0].originalPrompt, '왜 분업 안시키고 있지?');
  assert.deepEqual(entries[0].handoffs, [
    'docs/handoffs/2026-04-17-alpha-to-beta-directive-logging.md',
  ]);
  assert.equal(entries[0].alphaSolo, '프로토콜 개정, 인박스 스캐폴딩');
  assert.equal(entries[0].status, 'done');
  assert.equal(entries[0].sourcePath, 'docs/inbox/sample.md');
});

test('parseDirectiveBlocks: 여러 줄 위임 링크도 모두 수집', () => {
  const entries = parseDirectiveBlocks(inboxSample, 'docs/inbox/sample.md');
  assert.deepEqual(entries[1].handoffs, [
    'docs/handoffs/2026-04-17-alpha-to-beta-delegation-workflow.md',
    'docs/handoffs/2026-04-17-alpha-to-designer-slot-vacancy.md',
  ]);
  assert.equal(entries[1].alphaSolo, '없음');
});

test('parseDirectiveBlocks: 블록 헤더가 없으면 빈 배열', () => {
  assert.deepEqual(parseDirectiveBlocks('그냥 본문', 'x.md'), []);
});

test('parseDirectiveBlocks: 알 수 없는 상태는 open 폴백', () => {
  const md = `### [tick=1] 무엇
- **원문 프롬프트**: "x"
- **상태**: 진행중
`;
  const [e] = parseDirectiveBlocks(md, 'x.md');
  assert.equal(e.status, 'open');
});

test('parseDirectiveBlocks: 매트릭스 근거 ✅ 행은 verdict=allowed 로 추출', () => {
  const md = `### [tick=2] 무엇
- **원문 프롬프트**: "x"
- **알파 자체 처리분**: 문서만 수정
- **매트릭스 근거**: ✅행 "프로토콜/차터/규칙 문서"
- **상태**: done
`;
  const [e] = parseDirectiveBlocks(md, 'x.md');
  assert.equal(e.matrixBasis, '✅행 "프로토콜/차터/규칙 문서"');
  assert.equal(e.verdict, 'allowed');
});

test('parseDirectiveBlocks: 매트릭스 근거 ❌ 행은 verdict=forbidden 으로 추출', () => {
  const md = `### [tick=3] 무엇
- **원문 프롬프트**: "x"
- **매트릭스 근거**: ❌행 "컴포넌트/서비스/버그픽스" (긴급 핫픽스 예외)
- **상태**: done
`;
  const [e] = parseDirectiveBlocks(md, 'x.md');
  assert.equal(e.verdict, 'forbidden');
});

test('parseDirectiveBlocks: 매트릭스 근거 필드 누락 시 verdict undefined', () => {
  const md = `### [tick=4] 무엇
- **원문 프롬프트**: "x"
- **상태**: open
`;
  const [e] = parseDirectiveBlocks(md, 'x.md');
  assert.equal(e.verdict, undefined);
  assert.equal(e.matrixBasis, undefined);
});

test('parseDirectiveBlocks: ✅/❌ 둘 다 있으면 verdict undefined (모호)', () => {
  const md = `### [tick=5] 무엇
- **원문 프롬프트**: "x"
- **매트릭스 근거**: ✅행 + ❌행 혼합 잘못 기재
- **상태**: open
`;
  const [e] = parseDirectiveBlocks(md, 'x.md');
  assert.equal(e.verdict, undefined);
  assert.ok(e.matrixBasis, 'matrixBasis 는 원문 그대로 보관');
});

test('summarizeDirectiveRouting: 두 지시 모두 위임되면 rate=1', () => {
  const entries = parseDirectiveBlocks(inboxSample, 'docs/inbox/sample.md');
  const s = summarizeDirectiveRouting(entries);
  assert.equal(s.total, 2);
  assert.equal(s.delegated, 2);
  assert.equal(s.soloOnly, 0);
  assert.equal(s.soloWithException, 0);
  assert.equal(s.delegationRate, 1);
});

test('summarizeDirectiveRouting: 위임 없음 + 예외 사유 있으면 soloWithException 으로 카운트', () => {
  const entry: DirectiveEntry = {
    tick: 'tick=1',
    digest: 'x',
    originalPrompt: '',
    handoffs: [],
    alphaSolo: '긴급 핫픽스',
    status: 'done',
    sourcePath: 'x.md',
  };
  const s = summarizeDirectiveRouting([entry]);
  assert.equal(s.total, 1);
  assert.equal(s.delegated, 0);
  assert.equal(s.soloOnly, 1);
  assert.equal(s.soloWithException, 1);
  assert.equal(s.delegationRate, 0);
});

test('summarizeDirectiveRouting: total=0 이면 delegationRate=0', () => {
  const s = summarizeDirectiveRouting([]);
  assert.equal(s.total, 0);
  assert.equal(s.delegationRate, 0);
});

test('describeDirectiveRouting: 표본 없음 문구', () => {
  assert.equal(
    describeDirectiveRouting({
      total: 0,
      delegated: 0,
      soloOnly: 0,
      soloWithException: 0,
      delegationRate: 0,
    }),
    '오늘 지시: 없음',
  );
});

test('describeDirectiveRouting: 위임률 포함 한 줄 요약', () => {
  assert.equal(
    describeDirectiveRouting({
      total: 3,
      delegated: 2,
      soloOnly: 1,
      soloWithException: 1,
      delegationRate: 2 / 3,
    }),
    '오늘 지시 3건 · 위임 2건 · 단독(예외) 1건 · 위임률 66.7%',
  );
});

test('computeDesignerVacancy: Designer 슬롯 없으면 결원·기간 미상', () => {
  const v = computeDesignerVacancy([
    { role: 'Leader', status: 'idle' },
    { role: 'Developer', status: 'working' },
  ]);
  assert.equal(v.totalDesigners, 0);
  assert.equal(v.activeDesigners, 0);
  assert.equal(v.isVacant, true);
  assert.equal(v.vacancyDays, null);
  assert.equal(v.summary, '디자이너 슬롯: 결원 (기간 미상)');
});

test('computeDesignerVacancy: 결원 시작일 + 기준일로 일수 계산', () => {
  const v = computeDesignerVacancy(
    [{ role: 'Developer', status: 'working' }],
    { vacancyStartedOn: '2026-04-10', asOf: '2026-04-17' },
  );
  assert.equal(v.isVacant, true);
  assert.equal(v.vacancyDays, 7);
  assert.equal(v.summary, '디자이너 슬롯: 결원 7일째');
});

test('computeDesignerVacancy: Designer 1명이면 결원 아님·활동 수 분리 집계', () => {
  const v = computeDesignerVacancy(
    [
      { role: 'Designer', status: 'idle' },
      { role: 'Designer', status: 'working' },
      { role: 'Leader', status: 'working' },
    ],
    { vacancyStartedOn: '2026-04-10', asOf: '2026-04-17' },
  );
  assert.equal(v.totalDesigners, 2);
  assert.equal(v.activeDesigners, 1);
  assert.equal(v.isVacant, false);
  assert.equal(v.vacancyDays, 0);
  assert.equal(v.summary, '디자이너 슬롯: 2명 (활동 1명)');
});

test('computeDesignerVacancy: 잘못된 날짜 포맷은 null 유지', () => {
  const v = computeDesignerVacancy([], { vacancyStartedOn: '2026/04/10' });
  assert.equal(v.isVacant, true);
  assert.equal(v.vacancyDays, null);
});
