// Run with: npx tsx --test tests/projectSkillsMcpServers.unit.test.ts
//
// 지시 #6fd99c90 — 프로젝트 스킬 · MCP 서버 스토어 및 agentDispatcher 연결점
// 계약 잠금. 다음 축을 묶어 검증한다:
//   A. SkillsStore — 로컬 스킬은 프로젝트별로 격리, 전역 스킬은 전 프로젝트 공용.
//   B. SkillsStore — listForAgent 는 local(해당 프로젝트) + global 을 함께 돌려준다.
//   C. McpServersStore — name 중복 방지, 검증 실패 시 add 가 거부.
//   D. McpServersStore — 검증기는 쉘 메타/POSIX env 키/제어문자를 걸러낸다.
//   E. agentDispatcher — 두 스토어의 데이터를 AgentDispatchContext 로 모아 반환.
//                         formatDispatchContextForPrompt 는 scope/env 키 요약을 출력한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createProjectSkillsStore,
  createMemorySkillStorage,
  validateSkillInput,
  SKILL_NAME_MAX,
} from '../src/stores/projectSkillsStore.ts';
import {
  createProjectMcpServersStore,
  createMemoryMcpServerStorage,
  validateMcpServerInput,
  MCP_NAME_MAX,
} from '../src/stores/projectMcpServersStore.ts';
import {
  buildAgentDispatchContext,
  formatDispatchContextForPrompt,
  resetAgentDispatcherForTests,
  setSkillsProvider,
  setMcpServersProvider,
} from '../src/services/agentDispatcher.ts';

// ────────────────────────────────────────────────────────────────────────────
// A · B. SkillsStore
// ────────────────────────────────────────────────────────────────────────────

test('A. 로컬 스킬은 프로젝트 간 격리된다', async () => {
  const store = createProjectSkillsStore({ adapter: createMemorySkillStorage() });
  await store.add({ scope: 'local', projectId: 'P1', name: 'refactorer', prompt: 'do P1 refactor' });
  await store.add({ scope: 'local', projectId: 'P2', name: 'reviewer', prompt: 'do P2 review' });

  const p1 = await store.list('P1');
  const p2 = await store.list('P2');
  assert.equal(p1.length, 1);
  assert.equal(p2.length, 1);
  assert.equal(p1[0].name, 'refactorer');
  assert.equal(p2[0].name, 'reviewer');
});

test('B. listForAgent 는 global + local 을 합쳐 돌려준다', async () => {
  const store = createProjectSkillsStore({ adapter: createMemorySkillStorage() });
  await store.add({ scope: 'global', name: 'all-projects', prompt: 'every project' });
  await store.add({ scope: 'local', projectId: 'P1', name: 'p1-only', prompt: 'only P1' });
  await store.add({ scope: 'local', projectId: 'P2', name: 'p2-only', prompt: 'only P2' });

  const forP1 = await store.listForAgent('P1');
  const names = forP1.map((r) => r.name).sort();
  assert.deepEqual(names, ['all-projects', 'p1-only']);

  const globals = await store.listGlobal();
  assert.equal(globals.length, 1);
});

test('B2. 검증기는 빈 이름 · 장문 이름 · 누락 projectId 를 잡는다', () => {
  const tooLong = 'x'.repeat(SKILL_NAME_MAX + 1);
  const errors = validateSkillInput({ scope: 'local', name: '', prompt: '' });
  assert.ok(errors.some((e) => e.field === 'name'));
  assert.ok(errors.some((e) => e.field === 'prompt'));
  assert.ok(errors.some((e) => e.field === 'projectId'));

  const longErr = validateSkillInput({ scope: 'global', name: tooLong, prompt: 'ok' });
  assert.ok(longErr.some((e) => e.field === 'name'));
});

test('B3. subscribe 는 add/remove 양방향으로 통지한다', async () => {
  const store = createProjectSkillsStore({ adapter: createMemorySkillStorage() });
  let count = 0;
  const unsub = store.subscribe('P1', () => { count++; });
  const rec = await store.add({ scope: 'local', projectId: 'P1', name: 'a', prompt: 'p' });
  assert.equal(count, 1);
  await store.remove(rec.id);
  assert.equal(count, 2);
  unsub();
});

// ────────────────────────────────────────────────────────────────────────────
// C · D. McpServersStore
// ────────────────────────────────────────────────────────────────────────────

test('C. 같은 name 은 한 프로젝트 안에서 중복 저장되지 않는다', async () => {
  const store = createProjectMcpServersStore({ adapter: createMemoryMcpServerStorage() });
  await store.add({ projectId: 'P1', name: 'llm-tycoon', command: 'npx', args: [], env: {} });
  await assert.rejects(
    () => store.add({ projectId: 'P1', name: 'llm-tycoon', command: 'npx', args: [], env: {} }),
    /이미 존재/,
  );
  // 다른 프로젝트에서는 동일 이름 허용.
  await store.add({ projectId: 'P2', name: 'llm-tycoon', command: 'npx' });
  const p2 = await store.list('P2');
  assert.equal(p2.length, 1);
});

test('D. 검증기 — 쉘 메타 · 잘못된 env 키 · 제어문자 · 공백 이름을 거부', () => {
  // 쉘 메타 포함 command
  const meta = validateMcpServerInput({ projectId: 'P', name: 'ok', command: 'rm -rf /; echo hi' });
  assert.ok(meta.some((e) => e.field === 'command'));

  // env 키가 숫자로 시작
  const badEnv = validateMcpServerInput({
    projectId: 'P', name: 'ok', command: 'npx',
    env: { '1BAD': 'x' },
  });
  assert.ok(badEnv.some((e) => e.field === 'env'));

  // args 에 제어문자
  const badArg = validateMcpServerInput({
    projectId: 'P', name: 'ok', command: 'npx',
    args: ['\u0001'],
  });
  assert.ok(badArg.some((e) => e.field === 'args'));

  // 이름에 공백
  const badName = validateMcpServerInput({ projectId: 'P', name: 'has space', command: 'npx' });
  assert.ok(badName.some((e) => e.field === 'name'));

  // 너무 긴 이름
  const long = validateMcpServerInput({
    projectId: 'P', name: 'x'.repeat(MCP_NAME_MAX + 1), command: 'npx',
  });
  assert.ok(long.some((e) => e.field === 'name'));

  // 정상 입력은 에러가 없어야 한다.
  const ok = validateMcpServerInput({
    projectId: 'P', name: 'llm.tycoon-v1', command: 'npx',
    args: ['-y', '@modelcontextprotocol/server'],
    env: { API_URL: 'http://localhost:3000', AGENT_TOKEN: 'abc' },
  });
  assert.equal(ok.length, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// E. agentDispatcher
// ────────────────────────────────────────────────────────────────────────────

test('E. buildAgentDispatchContext 는 주입한 provider 결과를 모아서 반환한다', async () => {
  resetAgentDispatcherForTests();
  try {
    const now = () => 1_700_000_000_000;
    const skillsStore = createProjectSkillsStore({ adapter: createMemorySkillStorage(), now });
    const mcpStore = createProjectMcpServersStore({ adapter: createMemoryMcpServerStorage(), now });

    await skillsStore.add({ scope: 'global', name: 'reviewer', description: 'checks code', prompt: 'review rule' });
    await skillsStore.add({ scope: 'local', projectId: 'P1', name: 'p1-only', prompt: 'only p1' });
    await skillsStore.add({ scope: 'local', projectId: 'P2', name: 'p2-only', prompt: 'only p2' });
    await mcpStore.add({
      projectId: 'P1',
      name: 'llm-tycoon',
      command: 'npx',
      args: ['-y', 'mcp'],
      env: { API_URL: 'http://localhost:3000' },
    });

    setSkillsProvider((pid) => skillsStore.listForAgent(pid));
    setMcpServersProvider((pid) => mcpStore.list(pid));

    const ctx = await buildAgentDispatchContext('P1');
    assert.equal(ctx.projectId, 'P1');
    const skillNames = ctx.skills.map((s) => s.name).sort();
    assert.deepEqual(skillNames, ['p1-only', 'reviewer']);
    assert.equal(ctx.mcpServers.length, 1);
    assert.equal(ctx.mcpServers[0].command, 'npx');

    const prompt = formatDispatchContextForPrompt(ctx);
    assert.match(prompt, /에이전트 컨텍스트 주입/);
    assert.match(prompt, /reviewer/);
    assert.match(prompt, /p1-only/);
    assert.match(prompt, /llm-tycoon/);
    // env 키 요약이 포함되어야 한다(값은 노출되지 않음).
    assert.match(prompt, /env: API_URL/);
    assert.ok(!prompt.includes('http://localhost:3000'));
  } finally {
    resetAgentDispatcherForTests();
  }
});

test('E2. provider 미등록 상태에서는 빈 컨텍스트를 돌려준다', async () => {
  resetAgentDispatcherForTests();
  // 기본 경로는 브라우저 싱글턴에 연결되지만 Node 환경에는 indexedDB 가 없어 메모리
  // 폴백이 가동. 이전 테스트의 싱글턴 잔류 데이터는 없다고 가정하고 빈 결과를 기대.
  const ctx = await buildAgentDispatchContext('unknown-project');
  assert.equal(ctx.skills.length, 0);
  assert.equal(ctx.mcpServers.length, 0);
  const prompt = formatDispatchContextForPrompt(ctx);
  assert.equal(prompt, '');
});
