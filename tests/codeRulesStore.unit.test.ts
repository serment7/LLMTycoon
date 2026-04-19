// Run with: npx tsx --test tests/codeRulesStore.unit.test.ts
//
// 지시 #87cbd107 — 코드 컨벤션/룰 스토어 · agentDispatcher 연결점 · 프롬프트 빌더
// 의 계약을 잠근다. 축:
//   A. SaveLoad — 같은 (scope, projectId) 에 save 하면 단일 레코드가 덮어 쓰인다.
//   B. Scope 격리 — local 은 프로젝트 간 격리, global 은 공통.
//   C. loadForAgent — local 이 있으면 local, 없으면 global 로 폴백.
//   D. Validation — regex 파싱 실패·금지 패턴 상한·들여쓰기 범위를 거른다.
//   E. Import/Export — serialize → parse round-trip 이 원 값과 동치.
//   F. agentDispatcher — codeRulesProvider 주입 시 AgentDispatchContext 에 포함.
//   G. Prompt — renderCodeRulesBlock 은 scope 라벨·금지 패턴·추가 지시를 기록.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCodeRulesStore,
  createMemoryCodeRulesStorage,
  validateCodeRulesInput,
  serializeCodeRulesForFile,
  parseCodeRulesFromFile,
  MAX_FORBIDDEN_PATTERNS,
  type CodeRulesRecord,
} from '../src/stores/codeRulesStore.ts';
import {
  buildAgentDispatchContext,
  formatDispatchContextForPrompt,
  resetAgentDispatcherForTests,
  setCodeRulesProvider,
} from '../src/services/agentDispatcher.ts';
import { renderCodeRulesBlock } from '../src/server/prompts.ts';

// ────────────────────────────────────────────────────────────────────────────
// A · B · C. Store
// ────────────────────────────────────────────────────────────────────────────

test('A. 같은 (scope, projectId) 에 save 하면 단일 레코드가 덮어 쓰인다', async () => {
  const store = createCodeRulesStore({ adapter: createMemoryCodeRulesStorage() });
  await store.save({ scope: 'local', projectId: 'P1', quotes: 'single' });
  await store.save({ scope: 'local', projectId: 'P1', quotes: 'double' });
  const all = await store.listAll();
  const p1 = all.filter((r) => r.projectId === 'P1');
  assert.equal(p1.length, 1);
  assert.equal(p1[0].quotes, 'double');
});

test('B. 로컬은 프로젝트 간 격리, 전역은 공통', async () => {
  const store = createCodeRulesStore({ adapter: createMemoryCodeRulesStorage() });
  await store.save({ scope: 'local', projectId: 'P1', indentation: { style: 'space', size: 2 } });
  await store.save({ scope: 'local', projectId: 'P2', indentation: { style: 'tab', size: 4 } });
  await store.save({ scope: 'global', semicolons: 'omit' });

  const p1 = await store.load('local', 'P1');
  const p2 = await store.load('local', 'P2');
  const g = await store.load('global');
  assert.equal(p1?.indentation.size, 2);
  assert.equal(p2?.indentation.style, 'tab');
  assert.equal(g?.semicolons, 'omit');
});

test('C. loadForAgent — local 우선, 없으면 global 폴백', async () => {
  const store = createCodeRulesStore({ adapter: createMemoryCodeRulesStorage() });
  await store.save({ scope: 'global', quotes: 'double' });
  const onlyGlobal = await store.loadForAgent('P-new');
  assert.equal(onlyGlobal?.scope, 'global');

  await store.save({ scope: 'local', projectId: 'P-new', quotes: 'backtick' });
  const withLocal = await store.loadForAgent('P-new');
  assert.equal(withLocal?.scope, 'local');
  assert.equal(withLocal?.quotes, 'backtick');
});

// ────────────────────────────────────────────────────────────────────────────
// D. Validation
// ────────────────────────────────────────────────────────────────────────────

test('D. 검증기 — 잘못된 regex · 상한 초과 · 들여쓰기 범위 밖을 거른다', () => {
  const badRegex = validateCodeRulesInput({
    scope: 'local', projectId: 'P1',
    forbiddenPatterns: [{ name: 'broken', pattern: '(unclosed' }],
  });
  assert.ok(badRegex.some((e) => e.field === 'forbiddenPatterns'));

  const tooMany = validateCodeRulesInput({
    scope: 'global',
    forbiddenPatterns: Array.from({ length: MAX_FORBIDDEN_PATTERNS + 1 }, (_, i) => ({
      name: `p${i}`, pattern: 'x',
    })),
  });
  assert.ok(tooMany.some((e) => e.message.includes(`${MAX_FORBIDDEN_PATTERNS}`)));

  const badIndent = validateCodeRulesInput({
    scope: 'global',
    indentation: { style: 'space', size: 99 },
  });
  assert.ok(badIndent.some((e) => e.field === 'indentation'));

  const missingPid = validateCodeRulesInput({ scope: 'local' });
  assert.ok(missingPid.some((e) => e.field === 'projectId'));

  const ok = validateCodeRulesInput({
    scope: 'local', projectId: 'P1',
    indentation: { style: 'space', size: 2 },
    forbiddenPatterns: [{ name: 'no-console', pattern: 'console\\.log' }],
  });
  assert.equal(ok.length, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// E. Import/Export
// ────────────────────────────────────────────────────────────────────────────

test('E. serialize → parse round-trip 이 원 값과 동치', async () => {
  const store = createCodeRulesStore({ adapter: createMemoryCodeRulesStorage() });
  const saved = await store.save({
    scope: 'local',
    projectId: 'P1',
    indentation: { style: 'tab', size: 4 },
    quotes: 'backtick',
    semicolons: 'omit',
    filenameConvention: 'PascalCase',
    linterPreset: 'airbnb',
    forbiddenPatterns: [{ name: 'no-any', pattern: '\\bany\\b', message: 'any 타입 금지' }],
    extraInstructions: '테스트는 반드시 integration 경로로 작성.',
  });
  const text = serializeCodeRulesForFile(saved);
  const parsed = parseCodeRulesFromFile(text, { scope: 'local', projectId: 'P1' });
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.record.indentation?.style, 'tab');
  assert.equal(parsed.record.indentation?.size, 4);
  assert.equal(parsed.record.quotes, 'backtick');
  assert.equal(parsed.record.semicolons, 'omit');
  assert.equal(parsed.record.filenameConvention, 'PascalCase');
  assert.equal(parsed.record.linterPreset, 'airbnb');
  assert.equal(parsed.record.forbiddenPatterns?.[0]?.name, 'no-any');
  assert.equal(parsed.record.extraInstructions, '테스트는 반드시 integration 경로로 작성.');
});

test('E2. parseCodeRulesFromFile — 잘못된 JSON 은 에러만 돌려주고 크래시하지 않는다', () => {
  const parsed = parseCodeRulesFromFile('not json', { scope: 'global' });
  assert.ok(parsed.errors.length > 0);
});

// ────────────────────────────────────────────────────────────────────────────
// F. agentDispatcher 연결점
// ────────────────────────────────────────────────────────────────────────────

test('F. codeRulesProvider 주입 시 AgentDispatchContext 에 규칙이 포함된다', async () => {
  resetAgentDispatcherForTests();
  try {
    const store = createCodeRulesStore({ adapter: createMemoryCodeRulesStorage(), now: () => 1_700_000_000_000 });
    await store.save({
      scope: 'local', projectId: 'P1',
      quotes: 'single',
      forbiddenPatterns: [{ name: 'no-console', pattern: 'console\\.log' }],
    });
    setCodeRulesProvider((pid) => store.loadForAgent(pid));

    const ctx = await buildAgentDispatchContext('P1');
    assert.ok(ctx.codeRules);
    assert.equal(ctx.codeRules?.scope, 'local');
    assert.equal(ctx.codeRules?.quotes, 'single');
    assert.equal(ctx.codeRules?.forbiddenPatterns.length, 1);

    const prompt = formatDispatchContextForPrompt(ctx);
    assert.match(prompt, /코드 컨벤션/);
    assert.match(prompt, /no-console/);
    assert.match(prompt, /프로젝트 전용/);
  } finally {
    resetAgentDispatcherForTests();
  }
});

test('F2. provider 가 규칙을 못 찾으면 codeRules=null 이고 프롬프트 블록이 안 붙는다', async () => {
  resetAgentDispatcherForTests();
  try {
    setCodeRulesProvider(async () => null);
    const ctx = await buildAgentDispatchContext('P-absent');
    assert.equal(ctx.codeRules, null);
    const prompt = formatDispatchContextForPrompt(ctx);
    assert.ok(!prompt.includes('코드 컨벤션'));
  } finally {
    resetAgentDispatcherForTests();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// G. 프롬프트 빌더 블록
// ────────────────────────────────────────────────────────────────────────────

test('G. renderCodeRulesBlock — scope 라벨·금지 패턴·추가 지시 기록', () => {
  const lines = renderCodeRulesBlock({
    scope: 'global',
    indentation: { style: 'space', size: 4 },
    quotes: 'double',
    semicolons: 'required',
    filenameConvention: 'camelCase',
    linterPreset: 'prettier',
    forbiddenPatterns: [
      { name: 'no-todo', pattern: 'TODO', message: 'TODO 주석은 이슈로 승격하라.' },
    ],
    extraInstructions: '외부 API 호출은 반드시 retry 래퍼를 거친다.',
  });
  const joined = lines.join('\n');
  assert.match(joined, /\[코드 컨벤션/);
  assert.match(joined, /전역 공통/);
  assert.match(joined, /space × 4/);
  assert.match(joined, /no-todo/);
  assert.match(joined, /TODO 주석은 이슈로 승격하라\./);
  assert.match(joined, /외부 API 호출은 반드시 retry/);
});

test('G2. renderCodeRulesBlock — null 이면 빈 배열', () => {
  assert.deepEqual(renderCodeRulesBlock(null), []);
  assert.deepEqual(renderCodeRulesBlock(undefined), []);
});
