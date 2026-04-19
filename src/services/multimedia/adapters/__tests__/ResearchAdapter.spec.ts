// Run with: npx tsx --test src/services/multimedia/adapters/__tests__/ResearchAdapter.spec.ts
//
// 지시 #9afd4247 · ResearchAdapter 실구현 단위 테스트.
//
// 네트워크 계층(WebSearchAdapter) 를 SearchRunner 주입 훅으로 치환해 결정론적으로
// 검증한다. 디자이너 시안(§5.5) 의 ResearchReport 공개 계약(목차·각주 인용·한계점)
// 과 지시문이 명시한 표준 오류 코드 3종을 함께 잠근다.
//
// 잠금 축
//   R1. 정상 — 기본 휴리스틱 분해 + runner 주입 → 섹션·인용·목차가 모두 채워진다.
//   R2. 근거 부족 — runner 가 빈 배열을 돌려주면 RESEARCH_INSUFFICIENT_SOURCES + details.partial.
//   R3. 취소 — 호출자 signal 이 abort 되면 즉시 ABORTED 로 종료.
//   R4. 예산 초과 — 요청된 breadth 가 예산을 넘으면 RESEARCH_BUDGET_EXCEEDED.
//   R5. 중복 제거 + 신뢰도 점수 — 동일 URL 은 한 번만, trust 는 도메인 기반 0~5.
//   R6. 부분 보고서 정책 — 요약 단계 토큰 한계 초과 시 details.partial.sections 에 완료분이 담긴다.
//   R7. 진행률 스테이지 — decompose/gather/synthesize/done 이 모두 발화.
//   R8. 레지스트리 통합 — createDefaultRegistry().resolveByKind('research') 가 실구현을 반환.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MediaAdapterError,
  createDefaultRegistry,
} from '../../index.ts';
import {
  ResearchAdapter,
  research,
  RESEARCH_REAL_ADAPTER_ID,
  trustScoreForUrl,
  defaultBreadth,
  type ResearchRuntime,
  type SearchRunner,
  type ResearchProgress,
  type DecomposedSubQuery,
} from '../ResearchAdapter.ts';
import type { SearchResult } from '../WebSearchAdapter.ts';

function makeResult(partial: Partial<SearchResult> & { url: string }): SearchResult {
  return {
    title: partial.title ?? 'title',
    url: partial.url,
    snippet: partial.snippet ?? 'snippet',
    publishedAt: partial.publishedAt,
    source: partial.source ?? 'fake',
  };
}

function stubRunner(map: (sub: DecomposedSubQuery) => SearchResult[]): SearchRunner {
  return async ({ subQuery }) => map(subQuery);
}

// ────────────────────────────────────────────────────────────────────────────
// R1. 정상
// ────────────────────────────────────────────────────────────────────────────

test('R1. 기본 휴리스틱 + runner 주입 → 섹션·인용·목차가 모두 채워진다', async () => {
  const runtime: ResearchRuntime = {
    searchRunner: stubRunner((sub) => [
      makeResult({ url: `https://openai.com/${encodeURIComponent(sub.question)}`, title: 'OpenAI 문서', snippet: '공식 문서' }),
      makeResult({ url: `https://arxiv.org/abs/${encodeURIComponent(sub.question)}`, title: 'arXiv 논문', snippet: '학술 근거' }),
    ]),
    modelId: 'test-heuristic',
  };
  const report = await research('2026 생성형 AI 규제', { depth: 1 }, runtime);
  assert.equal(report.topic, '2026 생성형 AI 규제');
  assert.ok(report.sections.length >= 3);
  assert.ok(report.citations.length > 0);
  assert.equal(report.toc.length, report.sections.length);
  // 마크다운 출력에 제목 · 출처 블록이 포함돼야 한다.
  assert.match(report.markdown, /^# 2026 생성형 AI 규제/);
  assert.match(report.markdown, /## 출처/);
  assert.match(report.markdown, /신뢰도 \d\/5/);
});

// ────────────────────────────────────────────────────────────────────────────
// R2. 근거 부족 → RESEARCH_INSUFFICIENT_SOURCES
// ────────────────────────────────────────────────────────────────────────────

test('R2. runner 가 빈 결과만 돌려주면 INSUFFICIENT_SOURCES + details.partial', async () => {
  const runtime: ResearchRuntime = {
    searchRunner: stubRunner(() => []),
  };
  await assert.rejects(
    async () => research('없는 주제', { depth: 1 }, runtime),
    (err: unknown) => {
      assert.ok(err instanceof MediaAdapterError);
      const e = err as MediaAdapterError;
      assert.equal(e.details?.researchCode, 'RESEARCH_INSUFFICIENT_SOURCES');
      assert.ok(e.details?.partial, '부분 보고서가 details.partial 에 담겨야 한다');
      return true;
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// R3. 취소
// ────────────────────────────────────────────────────────────────────────────

test('R3. 호출자 signal 이 abort 되면 ABORTED 로 종료', async () => {
  const ac = new AbortController();
  const runtime: ResearchRuntime = {
    searchRunner: async ({ signal }) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => {
        reject(new MediaAdapterError('ABORTED', '취소', { adapterId: RESEARCH_REAL_ADAPTER_ID }));
      }, { once: true });
    }),
  };
  const p = research('취소 테스트', { depth: 1, signal: ac.signal }, runtime);
  queueMicrotask(() => ac.abort());
  await assert.rejects(
    p,
    (err: unknown) => {
      assert.ok(err instanceof MediaAdapterError);
      assert.equal((err as MediaAdapterError).code, 'ABORTED');
      return true;
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// R4. 예산 초과
// ────────────────────────────────────────────────────────────────────────────

test('R4. 요청 breadth 가 maxSearchCalls 예산을 초과하면 BUDGET_EXCEEDED', async () => {
  const runtime: ResearchRuntime = {
    budget: { maxTokens: 10_000, maxSearchCalls: 2 },
    searchRunner: stubRunner(() => [makeResult({ url: 'https://e.com/x' })]),
  };
  await assert.rejects(
    async () => research('예산', { depth: 2, breadth: 5 }, runtime),
    (err: unknown) => {
      const e = err as MediaAdapterError;
      assert.equal(e.details?.researchCode, 'RESEARCH_BUDGET_EXCEEDED');
      return true;
    },
  );
});

test('R4b. 토큰 예산 초과 시 details.partial.sections 에 완료분이 담긴다', async () => {
  // 섹션 요약을 매우 큰 본문으로 만들어 maxTokens 를 두 번째 섹션에서 넘게 한다.
  const bigText = 'x'.repeat(40_000);
  const runtime: ResearchRuntime = {
    budget: { maxTokens: 11_000, maxSearchCalls: 10 },
    searchRunner: stubRunner(() => [makeResult({ url: 'https://e.com/x', snippet: 's' })]),
    summarizer: async () => ({ body: bigText, citationNumbers: [] }),
  };
  await assert.rejects(
    async () => research('예산 본문', { depth: 2, breadth: 4 }, runtime),
    (err: unknown) => {
      const e = err as MediaAdapterError;
      assert.equal(e.details?.researchCode, 'RESEARCH_BUDGET_EXCEEDED');
      const partial = e.details?.partial as { sections?: unknown[] } | undefined;
      assert.ok(partial, 'details.partial 필요');
      assert.ok(Array.isArray(partial?.sections), 'partial.sections 가 배열이어야 함');
      assert.ok((partial?.sections ?? []).length >= 1, '중단 직전까지 완성된 섹션이 담긴다');
      return true;
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// R5. 중복 제거 + 신뢰도
// ────────────────────────────────────────────────────────────────────────────

test('R5. 동일 URL 은 1 건으로 중복 제거되고 trust 는 도메인 기반으로 0~5', async () => {
  const runtime: ResearchRuntime = {
    searchRunner: stubRunner(() => [
      makeResult({ url: 'https://openai.com/a?utm_source=test' }),
      makeResult({ url: 'https://openai.com/a' }),
      makeResult({ url: 'https://arxiv.org/abs/2401' }),
    ]),
  };
  const report = await research('중복', { depth: 1, breadth: 3 }, runtime);
  const urls = report.citations.map((c) => c.url);
  const uniq = new Set(urls);
  assert.equal(uniq.size, urls.length, 'citations 내 URL 은 유일해야 한다');
  // arxiv.org 는 학술 가중치(5), 기본 도메인(openai 계열) 은 3 이상.
  const arxiv = report.citations.find((c) => c.url.startsWith('https://arxiv.org'));
  assert.ok(arxiv);
  assert.equal(arxiv!.trust, 5);
  assert.ok(trustScoreForUrl('https://unknown.example') >= 0);
  assert.ok(trustScoreForUrl('https://unknown.example') <= 5);
});

// ────────────────────────────────────────────────────────────────────────────
// R7. 진행률 스테이지
// ────────────────────────────────────────────────────────────────────────────

test('R7. onProgress 는 decompose/gather/synthesize/done 을 모두 발화', async () => {
  const stages: ResearchProgress['stage'][] = [];
  const runtime: ResearchRuntime = {
    searchRunner: stubRunner(() => [makeResult({ url: 'https://e.com/p' })]),
  };
  await research('진행률', { depth: 1, onProgress: (p) => { stages.push(p.stage); } }, runtime);
  assert.ok(stages.includes('decompose'));
  assert.ok(stages.includes('gather'));
  assert.ok(stages.includes('synthesize'));
  assert.ok(stages.includes('done'));
});

// ────────────────────────────────────────────────────────────────────────────
// R8. 레지스트리 통합
// ────────────────────────────────────────────────────────────────────────────

test('R8. createDefaultRegistry().resolveByKind("research") 는 실구현(priority=-10) 을 반환', () => {
  const reg = createDefaultRegistry({ config: { timeoutMs: 1_000 } });
  const adapter = reg.resolveByKind('research');
  assert.equal(adapter.descriptor.id, RESEARCH_REAL_ADAPTER_ID);
  assert.equal(adapter.descriptor.priority, -10);
  const found = reg.list().find((d) => d.id === RESEARCH_REAL_ADAPTER_ID);
  assert.ok(found);
  assert.match(found!.displayName, /research\/deep/);
});

// ────────────────────────────────────────────────────────────────────────────
// ResearchAdapter 클래스 공개 API
// ────────────────────────────────────────────────────────────────────────────

test('ResearchAdapter.research() 는 runtime 을 통해 전달된 runner 를 사용', async () => {
  const adapter = new ResearchAdapter(
    { maxBytes: 0, timeoutMs: 1_000 },
    { runtime: { searchRunner: stubRunner(() => [makeResult({ url: 'https://e.com/ok' })]) } },
  );
  const report = await adapter.research('어댑터 경로', { depth: 1 });
  assert.ok(report.sections.length >= 1);
  assert.ok(report.citations.length >= 1);
});

test('ResearchAdapter.invoke() 는 OutputMap 에 맞춰 summary + citations 축약 반환', async () => {
  const adapter = new ResearchAdapter(
    { maxBytes: 0, timeoutMs: 1_000 },
    { runtime: { searchRunner: stubRunner(() => [makeResult({ url: 'https://e.com/ok' })]) } },
  );
  const outcome = await adapter.invoke({ input: { topic: '어댑터', depth: 1 } });
  assert.equal(typeof outcome.result.summary, 'string');
  assert.ok(outcome.result.summary.length > 0);
  assert.ok(Array.isArray(outcome.result.citations));
  assert.ok((outcome.result.citations as string[]).length >= 1);
});

// ────────────────────────────────────────────────────────────────────────────
// defaultBreadth 보조 확인
// ────────────────────────────────────────────────────────────────────────────

test('defaultBreadth — depth 1/2/3 → 3/5/8', () => {
  assert.equal(defaultBreadth(1), 3);
  assert.equal(defaultBreadth(2), 5);
  assert.equal(defaultBreadth(3), 8);
});
