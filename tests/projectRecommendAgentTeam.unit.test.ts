// Run with: npx tsx --test tests/projectRecommendAgentTeam.unit.test.ts
//
// 지시 #fa0621b3 — 프로젝트 신규 생성 시 팀 추천 + 바로 추가 로직 단위 계약.
//
// 본 스위트는 디자이너 3단계 화면(설명 입력 → 추천 카드 → 바로 추가) 이 의존하는
// 응답 스키마/프롬프트 캐싱/부분 실패 정책을 잠근다. 네트워크/LLM 은 invoker·fetch
// stub 으로 주입해 결정론적으로 검증한다.
//
// 축:
//   R1. 공개 스키마 — AgentRecommendation 필드·Role 카탈로그.
//   R2. buildRecommendationMessages — 시스템 프리픽스 정책/예시 2블록 + 마지막 블록에만
//       cache_control 이 붙는 buildCacheableMessages 계약 준수.
//   R3. validateRecommendations — 망가진 필드·초과 개수·중복 Leader 를 정제.
//   R4. heuristicTeam — 키워드 반응(Designer/QA/Researcher) + Leader 고정.
//   R5. recommendAgentTeam — invoker 주입/미주입/실패 경로 모두 UI 가 카드를 그릴 수 있는
//       상태로 수렴.
//   A1. applyRecommendedTeam — fetch 두 단계(hire → attach) 를 순차 호출.
//   A2. applyRecommendedTeam — 일부 실패 시 성공한 항목만 appliedCount 에 집계되고,
//       실패 항목은 error 필드를 포함해 반환된다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROLE_CATALOG,
  SYSTEM_ROLE_POLICY,
  SYSTEM_FEW_SHOT,
  buildRecommendationMessages,
  heuristicTeam,
  recommendAgentTeam,
  validateRecommendations,
  type AgentRecommendation,
} from '../src/project/recommendAgentTeam.ts';
import { applyRecommendedTeam } from '../src/project/api.ts';

// ─── R1 ─────────────────────────────────────────────────────────────────────

test('R1. ROLE_CATALOG 은 AgentRole 5종(Leader 포함)', () => {
  assert.deepEqual(
    [...ROLE_CATALOG].sort(),
    ['Designer', 'Developer', 'Leader', 'QA', 'Researcher'],
  );
});

// ─── R2 ─────────────────────────────────────────────────────────────────────

test('R2-a. buildRecommendationMessages — ko 프롬프트는 정책·예시 2블록 + 마지막만 cache_control=ephemeral', () => {
  const msg = buildRecommendationMessages('결제 모듈 보안 강화', 'ko');
  assert.equal(msg.system.length, 2, '정책·예시 두 블록이 유지돼야 한다');
  assert.equal(msg.system[0].cache_control, undefined, '첫 블록에는 캐시 마커 X');
  assert.deepEqual(msg.system[1].cache_control, { type: 'ephemeral' });
  assert.equal(msg.system[0].text, SYSTEM_ROLE_POLICY);
  assert.ok(msg.system[1].text.includes(SYSTEM_FEW_SHOT.slice(0, 20)));
});

test('R2-b. buildRecommendationMessages — user 턴은 휘발성(캐시 마커 없음)', () => {
  const msg = buildRecommendationMessages('설명', 'ko');
  assert.equal(msg.messages.length, 1);
  assert.equal(msg.messages[0].role, 'user');
  assert.equal(msg.messages[0].content[0].cache_control, undefined);
  assert.ok(msg.messages[0].content[0].text.includes('설명'));
});

test('R2-c. buildRecommendationMessages — locale=en 이면 영어 시스템 프롬프트', () => {
  const msg = buildRecommendationMessages('Payment hardening', 'en');
  assert.ok(msg.system[0].text.includes('HR/staffing lead'));
  assert.ok(msg.system[1].text.includes('Example input'));
  assert.ok(msg.messages[0].content[0].text.includes('Project description:'));
});

test('R2-d. buildRecommendationMessages — locale 미지정 시 기본 en', () => {
  const msg = buildRecommendationMessages('anything');
  assert.ok(msg.system[0].text.includes('HR/staffing lead'));
});

// ─── R3 ─────────────────────────────────────────────────────────────────────

test('R3-a. validateRecommendations — JSON 문자열/객체 둘 다 수용', () => {
  const json = JSON.stringify({
    items: [
      { role: 'Leader', name: 'Kai', rationale: '분배' },
      { role: 'Developer', name: 'Dev', rationale: '구현' },
    ],
  });
  const obj = JSON.parse(json);
  assert.equal(validateRecommendations(json).length, 2);
  assert.equal(validateRecommendations(obj).length, 2);
});

test('R3-b. validateRecommendations — 잘못된 role·빈 name·빈 rationale 은 드롭', () => {
  const out = validateRecommendations({
    items: [
      { role: 'Leader', name: 'Kai', rationale: '분배' },
      { role: 'ScrumMaster', name: 'Bad', rationale: 'x' }, // 허용 role 아님
      { role: 'Developer', name: '', rationale: '구현' }, // 이름 비었음
      { role: 'QA', name: 'QA', rationale: '' }, // rationale 비었음
      { role: 'Designer', name: 'Dex', rationale: '시안' },
    ],
  });
  assert.deepEqual(out.map((r) => r.role), ['Leader', 'Designer']);
});

test('R3-c. validateRecommendations — Leader 중복은 첫 번째만 유지', () => {
  const out = validateRecommendations({
    items: [
      { role: 'Leader', name: 'Kai', rationale: '분배' },
      { role: 'Leader', name: 'Kay', rationale: '다른 리더' },
      { role: 'Developer', name: 'Dev', rationale: '구현' },
    ],
  });
  assert.deepEqual(out.map((r) => r.name), ['Kai', 'Dev']);
});

test('R3-d. validateRecommendations — 최대 5명으로 절단', () => {
  const out = validateRecommendations({
    items: new Array(8).fill(0).map((_, i) => ({
      role: i === 0 ? 'Leader' : 'Developer',
      name: `N${i}`,
      rationale: 'r',
    })),
  });
  assert.equal(out.length, 5);
});

test('R3-e. validateRecommendations — 앞뒤 텍스트가 섞인 JSON 도 복구', () => {
  const raw = 'Here is the JSON: {"items":[{"role":"Leader","name":"Kai","rationale":"분배"}]} bye';
  const out = validateRecommendations(raw);
  assert.deepEqual(out, [{ role: 'Leader', name: 'Kai', rationale: '분배' }]);
});

test('R3-f. validateRecommendations — 같은 이름 두 카드는 두 번째에 숫자 접미사', () => {
  // 사용자 보고: "동일 이름의 에이전트가 한 팀에 섞여서 합류" — LLM 이 같은 별칭을
  // 재사용한 경우 검증기 단에서 dedupe 해 UI 카드·서버 hire 양쪽이 유일성을 본다.
  const out = validateRecommendations({
    items: [
      { role: 'Leader', name: 'Kai', rationale: '분배' },
      { role: 'Developer', name: 'Dev', rationale: '구현' },
      { role: 'Researcher', name: 'Dev', rationale: '조사' },
    ],
  });
  assert.deepEqual(out.map(r => r.name), ['Kai', 'Dev', 'Dev2']);
  // 역할은 보존
  assert.deepEqual(out.map(r => r.role), ['Leader', 'Developer', 'Researcher']);
});

// ─── R4 ─────────────────────────────────────────────────────────────────────

test('R4-a. heuristicTeam(count=2) — 최소 구성 Leader+Developer 만 (키워드 무관)', () => {
  const basic = heuristicTeam('간단한 CLI 유틸', 'en', 2);
  assert.deepEqual(basic.map((r) => r.role), ['Leader', 'Developer']);
});

test('R4-b. heuristicTeam — 키워드에 따라 Designer/QA/Researcher 우선 추가', () => {
  // 지시 #1d026b5b — 점수 기반 알고리즘에서는 디자인 강조 입력이면 Designer 가
  // Developer 보다 우선이 된다. count=3 의 두 번째 자리는 가장 강한 신호 역할이 차지.
  const design = heuristicTeam('UI 디자인 개편 + 화면 리워크', 'en', 3);
  const roles = design.map((r) => r.role);
  assert.equal(roles[0], 'Leader');
  assert.ok(roles.includes('Designer'), '디자인 신호가 강하면 Designer 가 반드시 포함');

  const full = heuristicTeam('보안 테스트 회귀 + 시장 조사 + UI 개편');
  const fullRoles = full.map((r) => r.role);
  assert.ok(fullRoles.includes('QA'));
  assert.ok(fullRoles.includes('Researcher'));
  assert.ok(fullRoles.includes('Designer'));
});

test('R4-c. heuristicTeam — 기본 인원수 5 는 키워드가 없어도 부족분을 보조 역할로 채운다', () => {
  const team = heuristicTeam('간단한 CLI 유틸');
  assert.equal(team.length, 5, '기본 DEFAULT_RECOMMENDATION_COUNT 만큼 채워야 한다');
  assert.deepEqual(
    [...team.map((r) => r.role)].sort(),
    ['Designer', 'Developer', 'Leader', 'QA', 'Researcher'],
    'count=5 기본값은 ROLE_CATALOG 5개를 1명씩 균형 배치',
  );
  // Leader 는 첫 슬롯 — 검증·서버 응답이 의존하는 계약.
  assert.equal(team[0].role, 'Leader');
});

test('R4-d. heuristicTeam — count 클램프: 6 → 5, 0 → 2, NaN → 5', () => {
  assert.equal(heuristicTeam('x', 'en', 6).length, 5);
  assert.equal(heuristicTeam('x', 'en', 0).length, 2);
  assert.equal(heuristicTeam('x', 'en', Number.NaN).length, 5);
});

// ─── R5 ─────────────────────────────────────────────────────────────────────

test('R5-a. recommendAgentTeam — 빈/공백 description 은 즉시 throw', async () => {
  await assert.rejects(() => recommendAgentTeam(''));
  await assert.rejects(() => recommendAgentTeam('   '));
});

test('R5-b. recommendAgentTeam — invoker 미주입 시 heuristic 으로 수렴', async () => {
  const res = await recommendAgentTeam('결제 모듈 보안 강화');
  assert.equal(res.source, 'heuristic');
  assert.ok(res.items.length >= 2);
  assert.equal(res.items[0].role, 'Leader');
});

test('R5-c. recommendAgentTeam — invoker 정상 + 유효 JSON → claude source', async () => {
  const res = await recommendAgentTeam('결제 보안', {
    count: 2,
    invoker: async () =>
      JSON.stringify({
        items: [
          { role: 'Leader', name: 'Kai', rationale: '분배' },
          { role: 'Developer', name: 'Dev', rationale: '구현' },
        ],
      }),
  });
  assert.equal(res.source, 'claude');
  assert.equal(res.items.length, 2);
});

test('R5-f. recommendAgentTeam — count 미지정 시 기본 5명 (Leader 포함 균형 배치)', async () => {
  const res = await recommendAgentTeam('결제 모듈 보안 강화');
  assert.equal(res.source, 'heuristic');
  assert.equal(res.items.length, 5);
  assert.equal(res.items[0].role, 'Leader');
});

test('R5-g. recommendAgentTeam — count=3 으로 좁히면 정확히 3명만 반환', async () => {
  const res = await recommendAgentTeam('결제 모듈 보안', { count: 3 });
  assert.equal(res.items.length, 3);
  assert.equal(res.items[0].role, 'Leader');
});

test('R5-d. recommendAgentTeam — invoker 가 스키마에 맞지 않는 응답 → heuristic 폴백', async () => {
  const res = await recommendAgentTeam('결제', {
    invoker: async () => '이건 JSON 이 아니에요',
  });
  assert.equal(res.source, 'heuristic');
});

test('R5-e. recommendAgentTeam — invoker 가 throw + fallbackOnError=false 면 전파', async () => {
  await assert.rejects(() =>
    recommendAgentTeam('결제', {
      invoker: async () => {
        throw new Error('5xx');
      },
      fallbackOnError: false,
    }),
  );
});

// ─── A: applyRecommendedTeam ────────────────────────────────────────────────

type FakeCall = { readonly url: string; readonly method: string; readonly body: unknown };

interface FakeResponse {
  readonly ok: boolean;
  readonly status?: number;
  readonly body?: unknown;
}

function createFakeFetch(
  handlers: Array<(call: FakeCall) => FakeResponse>,
): { fetch: typeof globalThis.fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let i = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const bodyStr = typeof init?.body === 'string' ? init.body : undefined;
    const body = bodyStr ? JSON.parse(bodyStr) : undefined;
    const call = { url, method, body };
    calls.push(call);
    const fallback: FakeResponse = { ok: true, body: {} };
    const handler = handlers[i++] ?? (() => fallback);
    const out = handler(call);
    return new Response(JSON.stringify(out.body ?? {}), {
      status: out.status ?? (out.ok ? 200 : 500),
    });
  };
  return { fetch, calls };
}

const SAMPLE_RECS: AgentRecommendation[] = [
  { role: 'Leader', name: 'Kai', rationale: '분배' },
  { role: 'Developer', name: 'Dev', rationale: '구현' },
];

test('A1. applyRecommendedTeam — 각 추천마다 hire + attach 를 순차 호출', async () => {
  let lastAgentId = 0;
  const { fetch, calls } = createFakeFetch([
    () => ({ ok: true, body: { id: `a${++lastAgentId}` } }),
    () => ({ ok: true, body: { success: true } }),
    () => ({ ok: true, body: { id: `a${++lastAgentId}` } }),
    () => ({ ok: true, body: { success: true } }),
  ]);
  const res = await applyRecommendedTeam('proj-1', SAMPLE_RECS, { fetch });
  assert.equal(res.appliedCount, 2);
  assert.equal(calls.length, 4);
  assert.match(calls[0].url, /\/api\/agents\/hire$/);
  assert.match(calls[1].url, /\/api\/projects\/proj-1\/agents$/);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(
    (calls[0].body as { name: string; role: string }).role,
    'Leader',
  );
  assert.deepEqual(
    (calls[1].body as { agentId: string }).agentId,
    'a1',
  );
  assert.ok(res.items.every((it) => it.ok));
});

test('A2. applyRecommendedTeam — hire 실패는 해당 항목만 실패로 기록', async () => {
  const { fetch } = createFakeFetch([
    () => ({ ok: false, status: 500 }), // 첫 hire 실패
    () => ({ ok: true, body: { id: 'a2' } }), // 두 번째 hire 성공
    () => ({ ok: true, body: { success: true } }), // attach 성공
  ]);
  const res = await applyRecommendedTeam('proj-1', SAMPLE_RECS, { fetch });
  assert.equal(res.appliedCount, 1);
  assert.equal(res.items[0].ok, false);
  assert.match(res.items[0].error ?? '', /hire/);
  assert.equal(res.items[1].ok, true);
  assert.equal(res.items[1].agentId, 'a2');
});

test('A3. applyRecommendedTeam — 빈 추천이면 네트워크 호출 없이 0명 반환', async () => {
  const { fetch, calls } = createFakeFetch([]);
  const res = await applyRecommendedTeam('proj-1', [], { fetch });
  assert.equal(res.appliedCount, 0);
  assert.equal(calls.length, 0);
});

test('A4. applyRecommendedTeam — projectId 공백이면 throw(서버 라우트 오염 차단)', async () => {
  await assert.rejects(() => applyRecommendedTeam('', SAMPLE_RECS, { fetch: async () => new Response('{}') }));
});
