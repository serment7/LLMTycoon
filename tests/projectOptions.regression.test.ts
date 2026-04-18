// Run with: npx tsx --test tests/projectOptions.regression.test.ts
//
// QA: 프로젝트 관리 옵션 DB 저장 플로우의 회귀 테스트.
//
// 대상 엔드포인트: `GET/POST /api/projects/:id/git-automation` (server.ts:1054~1082).
// 해당 엔드포인트는 `GitAutomationSettings` 레코드를 MongoDB `git_automation_settings`
// 컬렉션에 `projectId` 를 주키로 upsert 한다. agentWorker 는 MCP 도구
// `get_git_automation_settings` (mcp-agent-server.ts:152) 를 거쳐 동일 엔드포인트의
// GET 응답을 받아 리더/실행기 분기 판단에 쓴다. 따라서 "저장-조회-적용" 경로가
// 한 사이클로 일관돼야 한다.
//
// 본 파일은 실제 MongoDB 를 띄우지 않고, server.ts POST/GET 의 흐름과
// validateGitAutomationConfig · withDefaultSettings 의 분기를 1:1 로 시뮬레이션하는
// 인메모리 컬렉션 fixture 를 정의해 네 가지 시나리오(P1~P4)를 Given/When/Then 으로
// 잠근다. 실 구현부가 바뀌면 이 파일의 시뮬레이터 구현만 맞춰 다시 잠그면 된다.
//
// ┌─ 시나리오 지도 ───────────────────────────────────────────────────────────┐
// │ P1  옵션 저장 → 서버 재시작 · 페이지 새로고침에도 값이 그대로 유지        │
// │ P2  잘못된 타입·형식 입력 → 400 + 사용자 친화 메시지                      │
// │ P3  자동 개발 ON 으로 저장 → agentWorker(MCP GET) 가 동일 값을 읽어 동작 │
// │ P4  동시 저장 요청 → 마지막 쓰기 승리(last-write-wins)                    │
// └───────────────────────────────────────────────────────────────────────────┘

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_GIT_AUTOMATION_CONFIG,
  shouldAutoCommit,
  shouldAutoPush,
  shouldAutoOpenPR,
  validateGitAutomationConfig,
  type GitAutomationConfig,
} from '../src/utils/gitAutomation.ts';
import type { GitAutomationSettings, Project } from '../src/types.ts';

// ---------------------------------------------------------------------------
// 인메모리 DB fixture — server.ts 의 `gitAutomationSettingsCol` 를 최소 모사.
// `findOne({ projectId })` / `updateOne({ projectId }, { $set }, { upsert:true })`
// 두 연산만 충실히 구현한다. `projectsCol.findOne({ id })` 는 존재 여부 체크용
// 별도 Set 으로 둔다.
// ---------------------------------------------------------------------------

interface FakeDb {
  projects: Map<string, Project>;
  gitAutomation: Map<string, GitAutomationSettings>;
}

function createFakeDb(): FakeDb {
  return { projects: new Map(), gitAutomation: new Map() };
}

function seedProject(db: FakeDb, project: Project): void {
  db.projects.set(project.id, project);
}

// server.ts:1039 `withDefaultSettings` 를 1:1 로 재현.
function withDefaultSettings(
  projectId: string,
  raw: Partial<GitAutomationSettings> | null,
): GitAutomationSettings {
  const base = { ...DEFAULT_GIT_AUTOMATION_CONFIG, ...(raw || {}) };
  return {
    projectId,
    enabled: raw?.enabled ?? false,
    flowLevel: base.flowLevel,
    branchTemplate: base.branchTemplate,
    commitConvention: base.commitConvention,
    commitScope: base.commitScope,
    prTitleTemplate: base.prTitleTemplate,
    reviewers: base.reviewers,
    updatedAt: raw?.updatedAt || new Date(0).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 엔드포인트 시뮬레이터 — server.ts 의 분기 순서를 그대로 따른다.
// 실제 Express 핸들러와 분기 기호가 어긋나면 본 파일이 회귀를 못 잡으므로,
// 서버 수정 시 본 시뮬레이터도 같은 PR 에서 수정한다.
// ---------------------------------------------------------------------------

type JsonResponse =
  | { status: 200; body: GitAutomationSettings }
  | { status: 400; body: { error: string } }
  | { status: 404; body: { error: string } };

async function simulateGet(db: FakeDb, projectId: string): Promise<JsonResponse> {
  if (!db.projects.has(projectId)) {
    return { status: 404, body: { error: 'project not found' } };
  }
  const row = db.gitAutomation.get(projectId) ?? null;
  return { status: 200, body: withDefaultSettings(projectId, row) };
}

async function simulatePost(
  db: FakeDb,
  projectId: string,
  body: Partial<GitAutomationSettings>,
  now: () => string = () => new Date().toISOString(),
): Promise<JsonResponse> {
  if (!db.projects.has(projectId)) {
    return { status: 404, body: { error: 'project not found' } };
  }
  const validation = validateGitAutomationConfig(body);
  if (validation.ok !== true) {
    return { status: 400, body: { error: validation.error } };
  }
  const settings: GitAutomationSettings = {
    projectId,
    enabled: body.enabled !== false,
    ...validation.config,
    updatedAt: now(),
  };
  // upsert: { projectId } 를 주키로 교체. 동일 키가 이미 있어도 $set 으로 완전 대체.
  db.gitAutomation.set(projectId, settings);
  return { status: 200, body: settings };
}

// agentWorker 가 MCP 도구를 통해 동일 엔드포인트의 GET 을 호출하는 경로를 모사.
// mcp-agent-server.ts:152 에서 JSON 문자열로 감싸 반환하므로, 파싱 계약까지 함께 잠근다.
async function simulateMcpGetGitAutomationSettings(
  db: FakeDb,
  projectId: string,
): Promise<GitAutomationSettings> {
  const res = await simulateGet(db, projectId);
  assert.equal(res.status, 200, 'MCP 도구 경로에서 404 가 나오면 agentWorker 가 설정을 읽을 수 없다');
  // MCP 응답은 content[0].text 에 JSON.stringify(settings) 형태. 문자열 round-trip 을
  // 포함시켜 serialize/parse 과정에서 타입이 변질되지 않는지까지 본다.
  const mcpText = JSON.stringify(res.body, null, 2);
  const parsed = JSON.parse(mcpText) as GitAutomationSettings;
  return parsed;
}

// ---------------------------------------------------------------------------
// 공용 픽스처.
// ---------------------------------------------------------------------------

const PROJECT: Project = {
  id: 'proj-options',
  name: '옵션 회귀 프로젝트',
  description: 'git-automation 옵션 저장 경로 회귀',
  workspacePath: '/tmp/opt',
  agents: [],
  status: 'active',
};

// 사용자가 UI 에서 저장 버튼으로 내리는 전형적인 입력.
const VALID_SETTINGS_INPUT: Partial<GitAutomationSettings> = {
  enabled: true,
  flowLevel: 'commitPush',
  branchTemplate: 'feature/{type}/{slug}',
  commitConvention: 'conventional',
  commitScope: 'core',
  prTitleTemplate: '{type}: {summary}',
  reviewers: ['reviewer-a', 'reviewer-b'],
};

// ---------------------------------------------------------------------------
// 시나리오 P1 — 옵션 저장 후 서버 재시작 · 페이지 새로고침에도 값이 유지
// ---------------------------------------------------------------------------

test('P1 — Given 옵션 저장 When 서버 재시작(프로세스 리로드) 가정 Then GET 응답이 저장값과 동일하다', async () => {
  // Given: 빈 DB 에 프로젝트만 존재.
  const db = createFakeDb();
  seedProject(db, PROJECT);
  const saved = await simulatePost(db, PROJECT.id, VALID_SETTINGS_INPUT, () => '2026-04-18T10:00:00.000Z');
  assert.equal(saved.status, 200);

  // When: 서버 재시작 모사 — DB 레코드는 살아있고 메모리 상태만 재구성한다.
  // 본 시뮬레이터는 Map 이 DB 역할을 하므로 "서버 재시작" 은 시뮬레이터 캐시가
  // 없음을 보장한다(실제로 getAutoDev 같은 인메모리 캐시가 DB 에서 재-load 되는
  // 경로 — taskRunner.ts:105 와 등가). DB 자체는 그대로 유지.
  const afterRestart = await simulateGet(db, PROJECT.id);
  assert.equal(afterRestart.status, 200);
  if (afterRestart.status !== 200) throw new Error('unreachable');

  // Then: GET 응답이 POST 페이로드와 동치. updatedAt 만 제외하고 비교.
  const body = afterRestart.body;
  assert.equal(body.projectId, PROJECT.id);
  assert.equal(body.enabled, true);
  assert.equal(body.flowLevel, 'commitPush');
  assert.equal(body.branchTemplate, 'feature/{type}/{slug}');
  assert.equal(body.commitConvention, 'conventional');
  assert.equal(body.commitScope, 'core');
  assert.equal(body.prTitleTemplate, '{type}: {summary}');
  assert.deepEqual(body.reviewers, ['reviewer-a', 'reviewer-b']);
  assert.equal(body.updatedAt, '2026-04-18T10:00:00.000Z');
});

test('P1 — 페이지 새로고침 모사: GET 을 두 번 연속 호출해도 동일 응답이 돌아온다(순수 읽기 불변)', async () => {
  const db = createFakeDb();
  seedProject(db, PROJECT);
  await simulatePost(db, PROJECT.id, VALID_SETTINGS_INPUT, () => '2026-04-18T10:00:00.000Z');

  const r1 = await simulateGet(db, PROJECT.id);
  const r2 = await simulateGet(db, PROJECT.id);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  // 두 응답은 같은 객체 셰이프여야 한다. (GET 부작용 없음)
  assert.deepEqual(r1.body, r2.body);
});

test('P1 — 한 번도 저장한 적 없는 프로젝트의 GET 은 기본값(enabled=false) 을 돌려준다', async () => {
  // "저장된 뒤 비활성화한 상태" 와 "한 번도 저장한 적 없는 상태" 를 구별하기
  // 위한 경계값. withDefaultSettings 의 enabled 기본값이 false 임을 잠근다.
  const db = createFakeDb();
  seedProject(db, PROJECT);
  const res = await simulateGet(db, PROJECT.id);
  assert.equal(res.status, 200);
  if (res.status !== 200) throw new Error('unreachable');
  assert.equal(res.body.enabled, false);
  assert.equal(res.body.flowLevel, DEFAULT_GIT_AUTOMATION_CONFIG.flowLevel);
  assert.equal(res.body.updatedAt, new Date(0).toISOString());
});

// ---------------------------------------------------------------------------
// 시나리오 P2 — 잘못된 타입 · 형식 입력 시 400 + 사용자 친화 메시지
// ---------------------------------------------------------------------------

test('P2 — Given 잘못된 flowLevel 입력 When POST Then 400 응답과 어떤 값이 잘못됐는지 알려주는 메시지', async () => {
  const db = createFakeDb();
  seedProject(db, PROJECT);
  const res = await simulatePost(db, PROJECT.id, {
    ...VALID_SETTINGS_INPUT,
    flowLevel: 'commit-only-typo' as unknown as GitAutomationConfig['flowLevel'],
  });
  assert.equal(res.status, 400);
  if (res.status !== 400) throw new Error('unreachable');
  assert.match(res.body.error, /flowLevel/);
  assert.match(res.body.error, /commit-only-typo/, '잘못된 값이 메시지에 포함되어야 사용자가 원인을 안다');
  // 저장이 실패했으므로 DB 에는 여전히 이전 값(없음)이 남는다.
  assert.equal(db.gitAutomation.get(PROJECT.id), undefined);
});

test('P2 — branchTemplate 에 {slug} 가 누락되면 400 으로 차단된다', async () => {
  const db = createFakeDb();
  seedProject(db, PROJECT);
  const res = await simulatePost(db, PROJECT.id, {
    ...VALID_SETTINGS_INPUT,
    branchTemplate: 'feature/hotfix-only',
  });
  assert.equal(res.status, 400);
  if (res.status !== 400) throw new Error('unreachable');
  assert.match(res.body.error, /\{slug\}/, '{slug} 토큰 누락 사실이 메시지에 드러나야 한다');
});

test('P2 — reviewers 가 배열이 아닌 타입으로 들어오면 400 으로 차단된다', async () => {
  const db = createFakeDb();
  seedProject(db, PROJECT);
  const res = await simulatePost(db, PROJECT.id, {
    ...VALID_SETTINGS_INPUT,
    reviewers: 'reviewer-a' as unknown as string[],
  });
  assert.equal(res.status, 400);
  if (res.status !== 400) throw new Error('unreachable');
  assert.match(res.body.error, /reviewers/);
  assert.match(res.body.error, /array/);
});

test('P2 — enabled 에 문자열 "false" 같은 비불리언이 들어오면 400 으로 차단된다', async () => {
  // 가장 위험한 회귀: 문자열 "false" 는 truthy 라 가드가 풀려 실제 자동화가 돈다.
  // validateGitAutomationConfig 가 typeof enabled !== 'boolean' 을 막아야 한다.
  const db = createFakeDb();
  seedProject(db, PROJECT);
  const res = await simulatePost(db, PROJECT.id, {
    ...VALID_SETTINGS_INPUT,
    enabled: 'false' as unknown as boolean,
  });
  assert.equal(res.status, 400);
  if (res.status !== 400) throw new Error('unreachable');
  assert.match(res.body.error, /enabled/);
});

test('P2 — 존재하지 않는 프로젝트에 옵션을 저장하려 하면 404 로 반환된다(400 과 분리)', async () => {
  // P2 의 스코프는 "형식/타입" 이지만, "프로젝트 부재" 는 404 여야 한다는 계약을
  // 함께 잠근다. 두 상태가 섞이면 사용자가 원인을 잡기 어렵다.
  const db = createFakeDb();
  // seedProject 를 의도적으로 호출하지 않음.
  const res = await simulatePost(db, 'ghost', VALID_SETTINGS_INPUT);
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// 시나리오 P3 — 자동 개발 ON 상태로 저장 후 agentWorker 가 옵션을 정확히 읽는지.
// ---------------------------------------------------------------------------

test('P3 — Given 자동 개발 ON 저장 When agentWorker 가 MCP get_git_automation_settings 호출 Then 동일 값이 돌아오고 shouldAutoPush 가 true', async () => {
  const db = createFakeDb();
  seedProject(db, PROJECT);
  await simulatePost(db, PROJECT.id, {
    ...VALID_SETTINGS_INPUT,
    enabled: true,
    flowLevel: 'commitPush',
  });

  // When: agentWorker 경로.
  const viaMcp = await simulateMcpGetGitAutomationSettings(db, PROJECT.id);

  // Then: 저장값 그대로 + 플로우 가드 함수들이 일관되게 판정.
  assert.equal(viaMcp.enabled, true);
  assert.equal(viaMcp.flowLevel, 'commitPush');
  assert.equal(shouldAutoCommit(viaMcp), true);
  assert.equal(shouldAutoPush(viaMcp), true);
  assert.equal(shouldAutoOpenPR(viaMcp), false, 'commitPush 는 PR 단계를 포함하지 않는다');
});

test('P3 — flowLevel=commitPushPR 로 저장하면 MCP 응답으로 shouldAutoOpenPR 이 true 로 뒤집힌다', async () => {
  const db = createFakeDb();
  seedProject(db, PROJECT);
  await simulatePost(db, PROJECT.id, {
    ...VALID_SETTINGS_INPUT,
    flowLevel: 'commitPushPR',
  });
  const viaMcp = await simulateMcpGetGitAutomationSettings(db, PROJECT.id);
  assert.equal(viaMcp.flowLevel, 'commitPushPR');
  assert.equal(shouldAutoOpenPR(viaMcp), true);
});

test('P3 — 자동 개발 OFF(enabled=false) 로 저장하면 MCP 응답을 기반으로 한 가드 3종이 모두 false', async () => {
  // 마스터 스위치 OFF 는 flowLevel 과 무관하게 모든 가드를 false 로 끊어야 한다.
  // 이 회귀가 깨지면 "UI 에서 껐는데도 커밋이 계속 나가는" 사고가 발생한다.
  const db = createFakeDb();
  seedProject(db, PROJECT);
  await simulatePost(db, PROJECT.id, {
    ...VALID_SETTINGS_INPUT,
    enabled: false,
    flowLevel: 'commitPushPR',
  });
  const viaMcp = await simulateMcpGetGitAutomationSettings(db, PROJECT.id);
  assert.equal(viaMcp.enabled, false);
  assert.equal(shouldAutoCommit(viaMcp), false);
  assert.equal(shouldAutoPush(viaMcp), false);
  assert.equal(shouldAutoOpenPR(viaMcp), false);
});

test('P3 — agentWorker 가 잘못된 projectId 로 MCP 호출 시 404 가 상위로 전파된다', async () => {
  const db = createFakeDb();
  // 프로젝트 시드 없이 호출 → simulateMcpGetGitAutomationSettings 가 assert.equal 로 실패해야 한다.
  await assert.rejects(() => simulateMcpGetGitAutomationSettings(db, 'ghost'));
});

// ---------------------------------------------------------------------------
// 시나리오 P4 — 동시 저장 요청 시 마지막 쓰기 승리(last-write-wins).
// ---------------------------------------------------------------------------

test('P4 — Given 서로 다른 두 사용자가 동시에 POST When Promise.all 로 두 요청 전송 Then 마지막으로 기록된 값이 최종 상태', async () => {
  // server.ts:1075 `updateOne({projectId},{$set},{upsert:true})` 는 필드 단위 병합이
  // 아니라 전체 레코드 교체에 가깝다(모든 필드를 $set 에 넣으므로). 두 요청이 같은
  // projectId 를 두고 경쟁하면, 이벤트 루프 상 늦게 resolve 된 쪽이 최종 상태를
  // 차지한다. 시뮬레이터는 내부에서 `now()` 주입을 다르게 해 어느 쪽이 "마지막"
  // 인지 명시적으로 잠근다.
  const db = createFakeDb();
  seedProject(db, PROJECT);

  const A: Partial<GitAutomationSettings> = {
    ...VALID_SETTINGS_INPUT,
    enabled: true,
    flowLevel: 'commitOnly',
    commitScope: 'user-a-scope',
    reviewers: ['a'],
  };
  const B: Partial<GitAutomationSettings> = {
    ...VALID_SETTINGS_INPUT,
    enabled: true,
    flowLevel: 'commitPushPR',
    commitScope: 'user-b-scope',
    reviewers: ['b1', 'b2'],
  };

  // A 는 먼저 들어오지만 `now()` 반환 시각을 앞서게, B 는 뒤에 들어오며 나중 시각.
  // Promise.all 의 해소 순서는 microtask 스케줄에 의존하지만, 본 시뮬레이터는
  // 동기적 Map.set 이라 호출 순서 == 저장 순서이다. 순서를 A→B 로 못 박아
  // "B 가 마지막" 이라는 계약을 고정한다.
  const t1 = simulatePost(db, PROJECT.id, A, () => '2026-04-18T11:00:00.000Z');
  const t2 = simulatePost(db, PROJECT.id, B, () => '2026-04-18T11:00:00.200Z');
  const [resA, resB] = await Promise.all([t1, t2]);
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);

  const finalRead = await simulateGet(db, PROJECT.id);
  assert.equal(finalRead.status, 200);
  if (finalRead.status !== 200) throw new Error('unreachable');

  // Then: B 가 마지막이므로 최종 상태는 B 의 모든 필드와 일치.
  assert.equal(finalRead.body.flowLevel, 'commitPushPR');
  assert.equal(finalRead.body.commitScope, 'user-b-scope');
  assert.deepEqual(finalRead.body.reviewers, ['b1', 'b2']);
  assert.equal(finalRead.body.updatedAt, '2026-04-18T11:00:00.200Z');
  // A 의 필드는 남아있으면 안 된다. (부분 병합이 아닌 전체 교체 계약)
  assert.notEqual(finalRead.body.commitScope, 'user-a-scope');
});

test('P4 — 세 요청이 순차 저장될 때 최종 updatedAt 이 가장 늦은 값인지 — 단조 증가 확인', async () => {
  // last-write-wins 계약은 "마지막 저장" 이 반드시 최대 updatedAt 를 갖는다는
  // 강한 조건을 함께 요구한다. 이 불변이 깨지면 UI 가 "옛 값이 더 최신으로 보이는"
  // 착시에 빠진다.
  const db = createFakeDb();
  seedProject(db, PROJECT);

  const stamps = [
    '2026-04-18T12:00:00.000Z',
    '2026-04-18T12:00:00.010Z',
    '2026-04-18T12:00:00.020Z',
  ];
  for (const [i, t] of stamps.entries()) {
    await simulatePost(db, PROJECT.id, {
      ...VALID_SETTINGS_INPUT,
      commitScope: `scope-${i}`,
    }, () => t);
  }
  const finalRead = await simulateGet(db, PROJECT.id);
  assert.equal(finalRead.status, 200);
  if (finalRead.status !== 200) throw new Error('unreachable');
  assert.equal(finalRead.body.commitScope, 'scope-2');
  assert.equal(finalRead.body.updatedAt, stamps[stamps.length - 1]);
});

test('P4 — 동시 저장 중 한 건이 400 (검증 실패)이면 그 요청은 DB 를 변경하지 않는다', async () => {
  // 경쟁 요청 중 하나만 유효할 때: 유효 요청만 DB 에 반영되고, 잘못된 요청은
  // 400 에서 끊긴다. "부분 적용" 이 일어나면 DB 가 혼합 상태로 빠진다.
  const db = createFakeDb();
  seedProject(db, PROJECT);

  const goodFirst = simulatePost(db, PROJECT.id, {
    ...VALID_SETTINGS_INPUT,
    commitScope: 'good',
  }, () => '2026-04-18T13:00:00.000Z');
  const badSecond = simulatePost(db, PROJECT.id, {
    ...VALID_SETTINGS_INPUT,
    flowLevel: 'commit-typo' as unknown as GitAutomationConfig['flowLevel'],
  });

  const [rGood, rBad] = await Promise.all([goodFirst, badSecond]);
  assert.equal(rGood.status, 200);
  assert.equal(rBad.status, 400);

  const finalRead = await simulateGet(db, PROJECT.id);
  assert.equal(finalRead.status, 200);
  if (finalRead.status !== 200) throw new Error('unreachable');
  assert.equal(finalRead.body.commitScope, 'good', '400 요청이 DB 를 오염시키면 안 된다');
});

// ---------------------------------------------------------------------------
// 라운드트립 계약 — POST 응답과 직후 GET 응답이 정확히 동일해야 한다.
// 서버 응답과 DB read 를 각각 바라보는 두 UI 경로(POST 결과 캐시 · 목록 새로고침)가
// 분기되지 않도록 한 곳에서 고정.
// ---------------------------------------------------------------------------

test('라운드트립 — POST 응답 본문과 동일 시점의 GET 응답 본문이 완전히 일치한다', async () => {
  const db = createFakeDb();
  seedProject(db, PROJECT);
  const postRes = await simulatePost(db, PROJECT.id, VALID_SETTINGS_INPUT, () => '2026-04-18T14:00:00.000Z');
  const getRes = await simulateGet(db, PROJECT.id);
  assert.equal(postRes.status, 200);
  assert.equal(getRes.status, 200);
  if (postRes.status !== 200 || getRes.status !== 200) throw new Error('unreachable');
  assert.deepEqual(postRes.body, getRes.body);
});
