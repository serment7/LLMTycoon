// Run with: npx tsx --test tests/projects/recommendAgentsFlow.spec.ts
//
// 지시 #3c77f2ed (QA) · 프로젝트 생성 "최적 팀 추천 → 바로 추가" 사용자 플로우.
//
// 기존 `recommendAgents.spec.ts` 가 서버 핸들러 · cache · applyRecommendedTeam 을
// 한 파일에서 엮었다면, 본 스펙은 그 흐름을 **사용자 관점** 6 단계 플로우로 재구성한다:
//   (1) 설명 입력(타이핑) → (2) 추천 호출(디바운스된 API) → (3) 카드 노출(화면 렌더)
//   → (4) 바로 추가 클릭(applyRecommendedTeam) → (5) 팀 목록 반영(hire/attach 기록 검증)
//   → (6) 엣지(추천 실패 · 빈 설명 · 중복 추가) 복구 경로.
//
// 주의: React 렌더링 없이 "추천 클라이언트 → 서버 핸들러 → 프로젝트 API" 3 계층의
// 실제 함수만 연결해 네트워크 왕복을 fetch stub 으로 대체한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRecommendAgentsClient,
  createRecommendAgentsHandler,
  type HandlerRequest,
  type HandlerResponse,
} from '../../src/server/api/recommendAgents.ts';
import { applyRecommendedTeam } from '../../src/project/api.ts';
import { DEFAULT_ROLE_SKILLS } from '../../src/project/recommendAgentTeam.ts';
import {
  createDebouncedRecommender,
  createRecommendationCache,
  sanitizeRationale,
} from '../../src/project/recommendationClient.ts';

// ────────────────────────────────────────────────────────────────────────────
// 유틸 — 가짜 fetch · 가짜 타이머 · 핸들러 응답 포집
// ────────────────────────────────────────────────────────────────────────────

interface FetchCall { readonly url: string; readonly init?: RequestInit }

interface HireBody { readonly name?: string; readonly role?: string; readonly persona?: string }

/**
 * 단일 fetch stub 이 세 엔드포인트(`/api/recommendAgents`·`/api/agents/hire`·
 * `/api/projects/:id/agents`) 를 동시에 처리하도록 경로를 서버 핸들러에 위임한다.
 * UI 에서 보이는 "네트워크 호출 하나하나" 를 calls 배열에 축적해 순서를 검증한다.
 */
function wireStudioFetch(opts: {
  handler: (req: HandlerRequest, res: HandlerResponse) => Promise<void>;
  hireFailOn?: readonly string[];
  projectNotFound?: readonly string[];
}): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let hireSeq = 0;
  const failOn = new Set(opts.hireFailOn ?? []);
  const missingProjects = new Set(opts.projectNotFound ?? []);

  const impl: typeof globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString();
    calls.push({ url, init });

    if (url.endsWith('/api/recommendAgents')) {
      const req: HandlerRequest = { body: JSON.parse(String(init?.body ?? '{}')) };
      let status = 0;
      let body: unknown;
      const res: HandlerResponse = {
        status(code) { status = code; return res; },
        json(b) { body = b; },
      };
      await opts.handler(req, res);
      return new Response(JSON.stringify(body), {
        status: status || 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.endsWith('/api/agents/hire')) {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as HireBody;
      if (parsed.name && failOn.has(parsed.name)) {
        return new Response('nope', { status: 500 });
      }
      hireSeq += 1;
      return new Response(JSON.stringify({ id: `agent-${hireSeq}` }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }

    const projectMatch = url.match(/\/api\/projects\/([^/]+)\/agents$/);
    if (projectMatch) {
      if (missingProjects.has(projectMatch[1])) {
        return new Response('not-found', { status: 404 });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }

    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch: impl, calls };
}

/** 테스트용 가짜 타이머 — 추천 디바운스를 결정론적으로 진행. */
function createFakeTimers() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { id: number; at: number; fn: () => void }>();
  const setTimeoutFn = ((fn: () => void, ms: number) => {
    const id = next++;
    timers.set(id, { id, at: now + ms, fn });
    return id;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  function advance(ms: number) {
    now += ms;
    const due = [...timers.values()].filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
    for (const t of due) { timers.delete(t.id); t.fn(); }
  }
  return { setTimeoutFn, clearTimeoutFn, advance };
}

// ────────────────────────────────────────────────────────────────────────────
// R1. 최적 팀 추천 → 바로 추가 → 팀 목록 반영 (기본 해피 패스)
// ────────────────────────────────────────────────────────────────────────────

test('R1. 설명 입력→추천 호출→카드 노출→바로 추가 클릭→팀 목록 반영', async () => {
  const handler = createRecommendAgentsHandler({
    invoker: async () =>
      JSON.stringify({
        items: [
          { role: 'Leader', name: 'Kai', rationale: '**범위**를 분해합니다.' },
          { role: 'Developer', name: 'Dev', rationale: '핵심 기능 구현.' },
          { role: 'QA', name: 'QA', rationale: '보안/회귀 테스트.' },
        ],
      }),
  });
  const studio = wireStudioFetch({ handler });

  // (1)(2) 디바운스된 추천 클라이언트 — 타이핑 → 400ms 후 API 호출 → 카드 수신.
  const client = createRecommendAgentsClient({ fetch: studio.fetch });
  const cache = createRecommendationCache();
  const { setTimeoutFn, clearTimeoutFn, advance } = createFakeTimers();
  const recommender = createDebouncedRecommender({
    fetcher: async ({ description }) => {
      const out = await client.fetch({ description, locale: 'ko' });
      return { items: out.items, source: out.source, locale: out.locale };
    },
    cache,
    debounceMs: 400,
    setTimeoutFn,
    clearTimeoutFn,
  });

  const pending = recommender.request('블로그 CMS — 인증·게시글·보안 QA');
  // 400ms 미만에는 호출 없음.
  assert.equal(studio.calls.length, 0);
  advance(400);
  const card = await pending;
  assert.ok(card);
  assert.equal(card!.items.length, 3);

  // (3) 카드 렌더 — sanitizeRationale 가 **범위** 를 strong 세그먼트로 분리.
  const segments = sanitizeRationale(card!.items[0].rationale);
  const strong = segments.find((s) => s.strong);
  assert.ok(strong);
  assert.equal(strong!.text, '범위');
  // skills 가 비어 있지 않아야(UI 칩).
  for (const it of card!.items) assert.ok(it.skills && it.skills.length > 0);

  // (4)(5) 바로 추가 클릭 — applyRecommendedTeam 이 각 추천마다 hire+attach.
  const applied = await applyRecommendedTeam('proj-42', card!.items, { fetch: studio.fetch });
  assert.equal(applied.appliedCount, 3);
  const hireCalls = studio.calls.filter((c) => c.url.endsWith('/api/agents/hire'));
  const attachCalls = studio.calls.filter((c) => /\/api\/projects\/proj-42\/agents$/.test(c.url));
  assert.equal(hireCalls.length, 3);
  assert.equal(attachCalls.length, 3);
  // 첫 hire 본문이 추천 카드와 일치하는지 — UI 가 사용자 편집 없이 그대로 제출하는 경로.
  const firstHire = JSON.parse(String(hireCalls[0].init!.body)) as HireBody;
  assert.equal(firstHire.name, 'Kai');
  assert.equal(firstHire.role, 'Leader');
  // persona 는 rationale 원문 — sanitize 는 UI 가 담당.
  assert.equal(firstHire.persona, '**범위**를 분해합니다.');
});

// ────────────────────────────────────────────────────────────────────────────
// R2. 추천 실패 — invoker throw 시 휴리스틱 폴백으로 UX 중단 없음
// ────────────────────────────────────────────────────────────────────────────

test('R2. 추천 실패(invoker throw) — heuristic 폴백 + 바로 추가 여전히 동작', async () => {
  const handler = createRecommendAgentsHandler({
    invoker: async () => { throw new Error('claude-timeout'); },
  });
  const studio = wireStudioFetch({ handler });
  const client = createRecommendAgentsClient({ fetch: studio.fetch });
  const out = await client.fetch({ description: 'UI 디자인 · 보안 감사', locale: 'ko' });
  assert.equal(out.source, 'heuristic', '폴백 경로에서도 응답이 200 + source=heuristic');
  assert.ok(out.items.length >= 2);
  assert.equal(out.items[0].role, 'Leader');
  // 휴리스틱 경로도 DEFAULT_ROLE_SKILLS 로 skills 가 채워져 있어야.
  assert.deepEqual([...out.items[0].skills!], [...DEFAULT_ROLE_SKILLS.Leader]);

  const applied = await applyRecommendedTeam('proj-fb', out.items, { fetch: studio.fetch });
  assert.equal(applied.appliedCount, out.items.length);
  assert.ok(applied.items.every((i) => i.ok));
});

// ────────────────────────────────────────────────────────────────────────────
// R3. 빈 설명 — 두 계층 모두에서 안전
// ────────────────────────────────────────────────────────────────────────────

test('R3-1. 클라이언트 레벨 빈 설명 — 디바운서는 fetcher 호출 없이 null', async () => {
  const { setTimeoutFn, clearTimeoutFn, advance } = createFakeTimers();
  let called = 0;
  const recommender = createDebouncedRecommender({
    fetcher: async () => {
      called += 1;
      return { items: [], source: 'heuristic', locale: 'en' };
    },
    debounceMs: 400,
    setTimeoutFn,
    clearTimeoutFn,
  });
  assert.equal(await recommender.request(''), null);
  assert.equal(await recommender.request('   '), null);
  advance(1_000);
  assert.equal(called, 0, '타이머 만료 이후에도 fetcher 미호출');
});

test('R3-2. 서버 레벨 빈 설명 — POST /api/recommendAgents 는 400', async () => {
  const handler = createRecommendAgentsHandler();
  const studio = wireStudioFetch({ handler });
  const client = createRecommendAgentsClient({ fetch: studio.fetch });
  await assert.rejects(
    () => client.fetch({ description: '', locale: 'en' }),
    /http-400/,
  );
});

test('R3-3. 공백만 있는 설명 — 서버가 trim 후 빈 값을 감지해 500 recommend-failed 로 방어', async () => {
  // zod min(1) 은 문자 수 기준이라 "    " (공백 4자) 는 통과하지만, 아래 파이프라인에서
  // recommendAgentTeam 이 trim 후 빈 문자열을 거절(500). UX 의 최종 방어선은 R3-1 의
  // 클라이언트 디바운서이고, 서버는 "호출이 새어 들어와도 앱이 크래시하지 않음" 만 보장.
  const handler = createRecommendAgentsHandler();
  const rec: { status: number; body: unknown } = { status: 0, body: undefined };
  const res: HandlerResponse = {
    status(c) { rec.status = c; return res; },
    json(b) { rec.body = b; },
  };
  await handler({ body: { description: '    ', locale: 'en' } } as HandlerRequest, res);
  assert.equal(rec.status, 500);
  const body = rec.body as { ok: false; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, 'recommend-failed');
});

// ────────────────────────────────────────────────────────────────────────────
// R4. 중복 추가 — 같은 추천을 두 번 클릭해도 앱이 깨지지 않는다
// ────────────────────────────────────────────────────────────────────────────

test('R4-1. 바로 추가 2회 연속 — 클라이언트 중복 방지는 UI 책임이지만 서버는 매번 독립 처리', async () => {
  const handler = createRecommendAgentsHandler({
    invoker: async () =>
      JSON.stringify({
        items: [
          { role: 'Leader', name: 'Kai', rationale: 'r' },
          { role: 'Developer', name: 'Dev', rationale: 'r' },
        ],
      }),
  });
  const studio = wireStudioFetch({ handler });
  const client = createRecommendAgentsClient({ fetch: studio.fetch });
  const recs = (await client.fetch({ description: '동일 설명', locale: 'en' })).items;

  // 첫 번째 클릭.
  const first = await applyRecommendedTeam('proj-X', recs, { fetch: studio.fetch });
  assert.equal(first.appliedCount, 2);

  // 두 번째 클릭 — 같은 카드 배열을 그대로 재적용. 서버는 매번 새 agentId 를 발급.
  const second = await applyRecommendedTeam('proj-X', recs, { fetch: studio.fetch });
  assert.equal(second.appliedCount, 2);
  // 두 차례 시도의 agentId 는 서로 달라야(중복 허용 · UI 는 이 차이를 인지해 dedup).
  const ids1 = first.items.map((i) => i.agentId!);
  const ids2 = second.items.map((i) => i.agentId!);
  assert.notDeepEqual(ids1, ids2, '서버는 매 호출마다 신규 agent 를 생성한다(중복 방어는 UI 층)');
});

test('R4-2. 동일 agentId 가 이미 프로젝트에 속한 경우 — attach 가 404 여도 부분 실패만', async () => {
  const handler = createRecommendAgentsHandler({
    invoker: async () =>
      JSON.stringify({
        items: [
          { role: 'Leader', name: 'Kai', rationale: 'r' },
          { role: 'Developer', name: 'Dev', rationale: 'r' },
        ],
      }),
  });
  const studio = wireStudioFetch({ handler, projectNotFound: ['proj-missing'] });
  const client = createRecommendAgentsClient({ fetch: studio.fetch });
  const recs = (await client.fetch({ description: 'x', locale: 'en' })).items;

  const applied = await applyRecommendedTeam('proj-missing', recs, { fetch: studio.fetch });
  // attach 가 404 라 hire 는 성공해도 applyRecommendedTeam 은 실패로 기록.
  assert.equal(applied.appliedCount, 0);
  assert.ok(applied.items.every((i) => i.ok === false));
  for (const item of applied.items) {
    // i18n 이관(지시 #bf8ed192) — ko/en 어느 쪽 메시지든 통과.
    assert.match(item.error!, /attach\s+(실패|failed)/i);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// R5. 부분 실패 — 한 명 실패해도 나머지는 반영 + 재시도로 누적 가능
// ────────────────────────────────────────────────────────────────────────────

test('R5. 부분 실패 후 재시도 — 재호출 시 실패했던 항목만 다시 시도하면 누적 반영', async () => {
  const handler = createRecommendAgentsHandler({
    invoker: async () =>
      JSON.stringify({
        items: [
          { role: 'Leader', name: 'Kai', rationale: 'r' },
          { role: 'Developer', name: 'Dev', rationale: 'r' },
          { role: 'QA', name: 'QA', rationale: 'r' },
        ],
      }),
  });
  // 1차: Dev 실패.
  const studio1 = wireStudioFetch({ handler, hireFailOn: ['Dev'] });
  const recs = (await createRecommendAgentsClient({ fetch: studio1.fetch })
    .fetch({ description: 'x', locale: 'en' })).items;
  const applied1 = await applyRecommendedTeam('proj-R5', recs, { fetch: studio1.fetch });
  assert.equal(applied1.appliedCount, 2);
  const failed1 = applied1.items.find((i) => !i.ok);
  assert.equal(failed1?.recommendation.name, 'Dev');

  // 2차: 실패한 Dev 만 재시도(이번엔 성공).
  const studio2 = wireStudioFetch({ handler });
  const retry = await applyRecommendedTeam('proj-R5', [failed1!.recommendation], { fetch: studio2.fetch });
  assert.equal(retry.appliedCount, 1);
  assert.equal(retry.items[0].ok, true);
});
