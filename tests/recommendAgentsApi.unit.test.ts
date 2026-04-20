// Run with: npx tsx --test tests/recommendAgentsApi.unit.test.ts
//
// 지시 #2dc45b6c — POST /api/recommendAgents 엔드포인트 계약 + skills 강화 잠금.
//
// 축:
//   Q. zod 스키마 — description 필수·길이, locale 허용값.
//   C. maybeShrinkDescription — 짧은 입력은 원문 유지, 긴 입력은 head + 메타 + tail.
//   E. ensureSkills — 누락 skills 를 DEFAULT_ROLE_SKILLS 로 보강.
//   H. 핸들러 — 401/400/200 경로 + skills 가 응답에 포함.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DESCRIPTION_COMPACT_THRESHOLD,
  RecommendAgentsRequestSchema,
  createRecommendAgentsHandler,
  ensureSkills,
  maybeShrinkDescription,
  type HandlerRequest,
  type HandlerResponse,
} from '../src/server/api/recommendAgents.ts';
import {
  DEFAULT_ROLE_SKILLS,
  type AgentRecommendation,
} from '../src/project/recommendAgentTeam.ts';

function recordingResponse(): { res: HandlerResponse; status: number; body: unknown } {
  const out: { res: HandlerResponse; status: number; body: unknown } = {
    res: null as unknown as HandlerResponse,
    status: 0,
    body: undefined,
  };
  const res: HandlerResponse = {
    status(code) {
      out.status = code;
      return res;
    },
    json(body) {
      out.body = body;
    },
  };
  out.res = res;
  return out;
}

// ─── Q: 요청 스키마 ────────────────────────────────────────────────────────

test('Q1. description 이 비어 있으면 실패', () => {
  assert.equal(RecommendAgentsRequestSchema.safeParse({ description: '' }).success, false);
});

test('Q2. description 4001자는 거절, 4000자는 허용', () => {
  const max = 'a'.repeat(4000);
  assert.equal(RecommendAgentsRequestSchema.safeParse({ description: max }).success, true);
  assert.equal(RecommendAgentsRequestSchema.safeParse({ description: max + 'a' }).success, false);
});

test('Q3. locale 은 en|ko 만 허용', () => {
  assert.equal(RecommendAgentsRequestSchema.safeParse({ description: 'x', locale: 'en' }).success, true);
  assert.equal(RecommendAgentsRequestSchema.safeParse({ description: 'x', locale: 'fr' }).success, false);
});

// ─── C: maybeShrinkDescription ─────────────────────────────────────────────

test('C1. 짧은 입력은 원문 그대로', () => {
  const short = 'payment hardening with PCI audit';
  assert.equal(maybeShrinkDescription(short), short);
});

test('C2. 임계치를 초과하는 긴 입력은 head + 요약 메타 + tail 로 축약', () => {
  // 임계치는 tokens 기준. content.length/4 가 tokens 로 추정되므로 threshold*4 이상 길이면 발동.
  const long = 'x'.repeat(DESCRIPTION_COMPACT_THRESHOLD * 4 + 50);
  const shrunk = maybeShrinkDescription(long);
  assert.ok(shrunk.length < long.length, '원본보다 짧아야 한다');
  assert.match(shrunk, /요약: 원본 \d+자, 추정 \d+토큰/);
});

// ─── E: ensureSkills ───────────────────────────────────────────────────────

test('E1. skills 가 없는 항목에는 DEFAULT_ROLE_SKILLS 가 주입된다', () => {
  const items: AgentRecommendation[] = [
    { role: 'Leader', name: 'Kai', rationale: 'r' },
    { role: 'Developer', name: 'Dev', rationale: 'r', skills: ['typescript'] },
  ];
  const out = ensureSkills(items);
  assert.deepEqual([...out[0].skills!], [...DEFAULT_ROLE_SKILLS.Leader]);
  assert.deepEqual([...out[1].skills!], ['typescript']);
});

// ─── H: 핸들러 ─────────────────────────────────────────────────────────────

test('H1. allowAnonymous=false + 사용자 미해결 → 401', async () => {
  const handler = createRecommendAgentsHandler({
    allowAnonymous: false,
    resolveUser: () => null,
  });
  const rec = recordingResponse();
  await handler({ body: { description: 'x' } } as HandlerRequest, rec.res);
  assert.equal(rec.status, 401);
});

test('H2. invalid body → 400', async () => {
  const handler = createRecommendAgentsHandler();
  const rec = recordingResponse();
  await handler({ body: {} } as HandlerRequest, rec.res);
  assert.equal(rec.status, 400);
});

test('H3. invoker 미주입 — 휴리스틱 폴백으로 200 + skills 가 응답에 실린다', async () => {
  const handler = createRecommendAgentsHandler();
  const rec = recordingResponse();
  await handler(
    { body: { description: 'payment hardening with UI rework', locale: 'en' } } as HandlerRequest,
    rec.res,
  );
  assert.equal(rec.status, 200);
  const body = rec.body as {
    ok: true;
    source: string;
    items: AgentRecommendation[];
  };
  assert.equal(body.source, 'heuristic');
  assert.ok(body.items.length >= 2);
  assert.equal(body.items[0].role, 'Leader');
  assert.ok(body.items[0].skills && body.items[0].skills.length > 0);
});

test('H4. invoker 가 유효 JSON 을 돌려주면 source=claude + skills 포함', async () => {
  const handler = createRecommendAgentsHandler({
    invoker: async () =>
      JSON.stringify({
        items: [
          { role: 'Leader', name: 'Kai', rationale: 'lead', skills: ['planning'] },
          { role: 'Developer', name: 'Dev', rationale: 'impl' }, // skills 누락
        ],
      }),
  });
  const rec = recordingResponse();
  await handler({ body: { description: 'demo' } } as HandlerRequest, rec.res);
  assert.equal(rec.status, 200);
  const body = rec.body as { source: string; items: AgentRecommendation[] };
  assert.equal(body.source, 'claude');
  assert.deepEqual([...body.items[0].skills!], ['planning']);
  // 누락된 항목은 ensureSkills 가 기본값을 주입.
  assert.ok((body.items[1].skills ?? []).length > 0);
});

test('H5. 응답 items 는 최대 5 개로 제한', async () => {
  const handler = createRecommendAgentsHandler({
    invoker: async () =>
      JSON.stringify({
        items: Array.from({ length: 10 }, (_, i) => ({
          role: i === 0 ? 'Leader' : 'Developer',
          name: `N${i}`,
          rationale: 'r',
        })),
      }),
  });
  const rec = recordingResponse();
  await handler({ body: { description: 'demo' } } as HandlerRequest, rec.res);
  const body = rec.body as { items: AgentRecommendation[] };
  assert.equal(body.items.length, 5);
});
