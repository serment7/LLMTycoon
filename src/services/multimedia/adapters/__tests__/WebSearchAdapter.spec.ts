// Run with: npx tsx --test src/services/multimedia/adapters/__tests__/WebSearchAdapter.spec.ts
//
// 지시 #f64dc11e · WebSearchAdapter 실구현 단위 테스트.
//
// 실제 Bing/Brave/DuckDuckGo 네트워크 호출은 플랫폼 의존적이므로, 본 스펙은 fetch
// 주입 훅(settings.fetch) 으로 응답을 결정론적으로 고정한다. undici MockAgent 대신
// 가벼운 Response 스텁 함수를 사용해 테스트가 플랫폼과 패키지 관리자에 독립적으로
// 돌도록 만든다.
//
// 잠금 축
//   W1. 정상 결과 — Bing 응답이 SearchResult 로 정규화된다.
//   W2. 빈 결과 — WEB_SEARCH_EMPTY 오류 코드 + details.partial=[] 가 부여된다.
//   W3. 레이트 리밋 — RateLimiter 슬롯 초과 시 WEB_SEARCH_RATE_LIMIT 로 즉시 거절.
//   W4. 429 응답 — 재시도 없이 WEB_SEARCH_RATE_LIMIT 로 변환.
//   W5. 타임아웃 — 전역 timeoutMs 초과 시 AbortSignal 로 내부 fetch 취소 + provider_error.
//   W6. 취소 — 호출자가 signal 을 abort 하면 ABORTED 로 즉시 종료.
//   W7. 지수 백오프 — 5xx 는 재시도를 시도하고 성공 시 정상 결과를 돌려준다.
//   W8. 캐시 — 동일 key 재호출 시 fetch 가 1회만 발생한다.
//   W9. 레지스트리 등록 — createDefaultRegistry 가 실구현(priority=-10) 을 우선 선택.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MediaAdapterError,
  createDefaultRegistry,
} from '../../index.ts';
import {
  WebSearchAdapter,
  WEB_SEARCH_REAL_ADAPTER_ID,
  createBingProvider,
  createDuckDuckGoProvider,
  createBraveProvider,
  RateLimiter,
  TtlCache,
  search as webSearch,
  DEFAULT_RETRY_POLICY,
  type SearchProvider,
  type SearchResult,
  type WebSearchSettings,
} from '../WebSearchAdapter.ts';

// ────────────────────────────────────────────────────────────────────────────
// 공용 fetch 스텁
// ────────────────────────────────────────────────────────────────────────────

interface StubResponse {
  status: number;
  body: unknown;
}

function jsonFetch(map: (url: string, init?: RequestInit) => StubResponse | Promise<StubResponse>): typeof fetch {
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    // 호출자가 abort 한 signal 은 여기서 즉시 반영(fetch 의 실제 동작과 동일).
    const signal = init?.signal;
    if (signal?.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    const { status, body } = await map(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return stub as typeof fetch;
}

function bingBody(items: Array<{ name: string; url: string; snippet: string; date?: string }>): unknown {
  return { webPages: { value: items.map((it) => ({ name: it.name, url: it.url, snippet: it.snippet, dateLastCrawled: it.date })) } };
}

function makeSettings(overrides: Partial<WebSearchSettings> = {}): WebSearchSettings {
  return {
    bing: { apiKey: 'test-key' },
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// W1. 정상 결과
// ────────────────────────────────────────────────────────────────────────────

test('W1. Bing 응답이 SearchResult 로 정규화된다', async () => {
  let called = 0;
  const settings = makeSettings({
    fetch: jsonFetch((url) => {
      called += 1;
      assert.match(url, /api\.bing\.microsoft\.com/);
      assert.match(url, /count=5/);
      return { status: 200, body: bingBody([
        { name: '예제 1', url: 'https://example.com/1', snippet: '첫 결과', date: '2026-04-19T00:00:00Z' },
        { name: '예제 2', url: 'https://example.com/2', snippet: '둘째 결과' },
      ]) };
    }),
  });
  const adapter = new WebSearchAdapter(
    { maxBytes: 0, timeoutMs: 5_000 },
    { settings },
  );
  const results = await adapter.search('안녕 세계', { maxResults: 5 });
  assert.equal(called, 1);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, '예제 1');
  assert.equal(results[0].source, 'bing');
  assert.equal(results[0].publishedAt, '2026-04-19T00:00:00Z');
});

// ────────────────────────────────────────────────────────────────────────────
// W2. 빈 결과 — WEB_SEARCH_EMPTY
// ────────────────────────────────────────────────────────────────────────────

test('W2. 빈 결과 → WEB_SEARCH_EMPTY + details.partial=[]', async () => {
  const settings = makeSettings({
    fetch: jsonFetch(() => ({ status: 200, body: bingBody([]) })),
  });
  const adapter = new WebSearchAdapter({ maxBytes: 0, timeoutMs: 5_000 }, { settings });
  await assert.rejects(
    async () => adapter.search('없는 쿼리', { maxResults: 5 }),
    (err: unknown) => {
      assert.ok(err instanceof MediaAdapterError);
      const e = err as MediaAdapterError;
      assert.equal(e.details?.webSearchCode, 'WEB_SEARCH_EMPTY');
      assert.deepEqual(e.details?.partial, []);
      return true;
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// W3. 레이트 리밋(로컬 RateLimiter) — 즉시 거절
// ────────────────────────────────────────────────────────────────────────────

test('W3. 로컬 RateLimiter 슬롯 초과 → WEB_SEARCH_RATE_LIMIT 즉시 발화', async () => {
  const settings = makeSettings({
    fetch: jsonFetch(() => ({ status: 200, body: bingBody([{ name: 'x', url: 'https://e.com/x', snippet: '' }]) })),
  });
  const rl = new RateLimiter({ windowMs: 10_000, max: 1 });
  const adapter = new WebSearchAdapter(
    { maxBytes: 0, timeoutMs: 5_000 },
    { settings, rateLimiter: rl, cache: new TtlCache({ ttlMs: 0 }) },
  );
  await adapter.search('첫 호출', { maxResults: 1 });
  await assert.rejects(
    async () => adapter.search('둘째 호출', { maxResults: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof MediaAdapterError);
      assert.equal((err as MediaAdapterError).details?.webSearchCode, 'WEB_SEARCH_RATE_LIMIT');
      return true;
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// W4. 429 응답 — 재시도 없이 변환
// ────────────────────────────────────────────────────────────────────────────

test('W4. 공급자 429 응답 → WEB_SEARCH_RATE_LIMIT (재시도 없음)', async () => {
  let hits = 0;
  const settings = makeSettings({
    fetch: jsonFetch(() => { hits += 1; return { status: 429, body: {} }; }),
  });
  const adapter = new WebSearchAdapter({ maxBytes: 0, timeoutMs: 5_000 }, { settings });
  await assert.rejects(
    async () => adapter.search('rate limit', { maxResults: 1 }),
    (err: unknown) => {
      const e = err as MediaAdapterError;
      assert.equal(e.details?.webSearchCode, 'WEB_SEARCH_RATE_LIMIT');
      return true;
    },
  );
  assert.equal(hits, 1, '429 는 재시도 없이 즉시 변환되어야 한다');
});

// ────────────────────────────────────────────────────────────────────────────
// W5. 타임아웃 — 전역 timeoutMs
// ────────────────────────────────────────────────────────────────────────────

test('W5. 전역 timeoutMs 초과 시 공급자 요청이 abort 되어 provider_error 로 수렴', async () => {
  const settings = makeSettings({
    fetch: (async (_url: unknown, init?: RequestInit) => {
      // 긴 대기 흉내 — signal 이 abort 되면 즉시 reject.
      return await new Promise((_, reject) => {
        const onAbort = () => reject(Object.assign(new Error('abort'), { name: 'AbortError' }));
        init?.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }) as unknown as typeof fetch,
  });
  const adapter = new WebSearchAdapter(
    { maxBytes: 0, timeoutMs: 50 },
    { settings, retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 } },
  );
  await assert.rejects(
    async () => adapter.search('타임아웃', { maxResults: 1 }),
    (err: unknown) => {
      const e = err as MediaAdapterError;
      assert.equal(e.details?.webSearchCode, 'WEB_SEARCH_PROVIDER_ERROR');
      return true;
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// W6. 취소 — 호출자 AbortSignal
// ────────────────────────────────────────────────────────────────────────────

test('W6. 호출자 signal 이 abort 되면 ABORTED 즉시 종료', async () => {
  const ac = new AbortController();
  const settings = makeSettings({
    fetch: (async (_url: unknown, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { name: 'AbortError' })), { once: true });
    })) as unknown as typeof fetch,
  });
  const adapter = new WebSearchAdapter(
    { maxBytes: 0, timeoutMs: 5_000 },
    { settings, retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 } },
  );
  const p = adapter.search('취소', { signal: ac.signal, maxResults: 1 });
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
// W7. 지수 백오프 — 5xx 는 재시도 후 성공
// ────────────────────────────────────────────────────────────────────────────

test('W7. 5xx 는 지수 백오프로 재시도, 이후 정상 응답을 수신하면 성공', async () => {
  let hits = 0;
  const settings = makeSettings({
    fetch: jsonFetch(() => {
      hits += 1;
      if (hits < 2) return { status: 503, body: { error: 'temp' } };
      return { status: 200, body: bingBody([{ name: 'ok', url: 'https://e.com/ok', snippet: 'good' }]) };
    }),
  });
  const adapter = new WebSearchAdapter(
    { maxBytes: 0, timeoutMs: 5_000 },
    {
      settings,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitter: false },
    },
  );
  const results = await adapter.search('retry', { maxResults: 1 });
  assert.equal(results.length, 1);
  assert.equal(hits, 2, '첫 호출 실패 + 두 번째 호출 성공 = 총 2회');
});

// ────────────────────────────────────────────────────────────────────────────
// W8. 캐시 — 동일 입력 재호출 시 fetch 0회
// ────────────────────────────────────────────────────────────────────────────

test('W8. TTL 캐시 — 동일 쿼리 재호출 시 fetch 가 발생하지 않는다', async () => {
  let hits = 0;
  const settings = makeSettings({
    fetch: jsonFetch(() => {
      hits += 1;
      return { status: 200, body: bingBody([{ name: 'c', url: 'https://e.com/c', snippet: 'cache' }]) };
    }),
  });
  const cache = new TtlCache({ ttlMs: 60_000 });
  const adapter = new WebSearchAdapter(
    { maxBytes: 0, timeoutMs: 5_000 },
    { settings, cache },
  );
  await adapter.search('캐시', { maxResults: 1 });
  await adapter.search('캐시', { maxResults: 1 });
  assert.equal(hits, 1, '동일 조건 재호출은 캐시 적중');
});

// ────────────────────────────────────────────────────────────────────────────
// W9. 레지스트리 통합 — 실구현을 기본 어댑터로 승격
// ────────────────────────────────────────────────────────────────────────────

test('W9. createDefaultRegistry().resolveByKind("web-search") 는 실구현(priority=-10) 을 반환', () => {
  const reg = createDefaultRegistry({ config: { timeoutMs: 1_000 } });
  const adapter = reg.resolveByKind('web-search');
  assert.equal(adapter.descriptor.id, WEB_SEARCH_REAL_ADAPTER_ID);
  assert.equal(adapter.descriptor.priority, -10);
  // 별칭(search/web)은 레지스트리가 저장한 descriptor 에만 반영(instance 자체는 원본 이름).
  const found = reg.list().find((d) => d.id === WEB_SEARCH_REAL_ADAPTER_ID);
  assert.ok(found);
  assert.match(found!.displayName, /search\/web/);
});

// ────────────────────────────────────────────────────────────────────────────
// 공급자 직접 테스트 — DuckDuckGo 는 키 없이도 동작해야 한다
// ────────────────────────────────────────────────────────────────────────────

test('DuckDuckGo 공급자는 requiresCredentials=false 이며 isEnabled()=true', () => {
  const p = createDuckDuckGoProvider({});
  assert.equal(p.requiresCredentials, false);
  assert.equal(p.isEnabled(), true);
});

test('Brave 공급자는 API 키 없으면 isEnabled()=false', () => {
  const p = createBraveProvider({});
  assert.equal(p.isEnabled(), false);
});

test('Bing 공급자 + site 필터 → 쿼리에 site: 접두가 붙는다', async () => {
  let lastUrl = '';
  const p = createBingProvider({
    bing: { apiKey: 'k' },
    fetch: jsonFetch((url) => { lastUrl = url; return { status: 200, body: bingBody([]) }; }),
  });
  const out = await p.search('foo', { site: 'example.com' });
  assert.deepEqual(out, []);
  assert.match(decodeURIComponent(lastUrl), /site:example\.com/);
});

// ────────────────────────────────────────────────────────────────────────────
// webSearch() 최상위 함수 — RateLimiter 슬롯 남으면 provider 가 주입되어야 함
// ────────────────────────────────────────────────────────────────────────────

test('webSearch()는 provider 미지정 시 WEB_SEARCH_PROVIDER_ERROR', async () => {
  await assert.rejects(
    async () => webSearch('x', {}),
    (err: unknown) => {
      const e = err as MediaAdapterError;
      assert.equal(e.details?.webSearchCode, 'WEB_SEARCH_PROVIDER_ERROR');
      return true;
    },
  );
});

test('webSearch() + provider 주입 → 정상 반환', async () => {
  const results: SearchResult[] = [
    { title: 't', url: 'https://e.com/t', snippet: 's', source: 'fake' },
  ];
  const provider: SearchProvider = {
    id: 'fake',
    requiresCredentials: false,
    isEnabled: () => true,
    async search() { return results; },
  };
  const out = await webSearch('x', { maxResults: 5 }, { provider });
  assert.deepEqual(out, results);
});

// ────────────────────────────────────────────────────────────────────────────
// D1. Designer 규약 — invoke() progress 가 멀티미디어 허브 3단계 phase 로 번역되는지
//     `docs/design/multimedia-ui-spec.md §2` 의 precheck·upload·finalize 축을 잠금.
// ────────────────────────────────────────────────────────────────────────────

test('D1. invoke() progress 는 3단계 phase + 한국어 메시지로 UI 에 전달', async () => {
  const settings = makeSettings({
    fetch: jsonFetch(() => ({ status: 200, body: bingBody([{ name: 'ok', url: 'https://e.com/ok', snippet: 'ok' }]) })),
  });
  const adapter = new WebSearchAdapter({ maxBytes: 0, timeoutMs: 5_000 }, { settings });
  const events: Array<{ phase: string; ratio: number | null; message?: string }> = [];
  await adapter.invoke({
    input: { query: '디자인 phase 매핑', limit: 1 },
    onProgress: (p) => events.push({ phase: p.phase, ratio: p.ratio, message: p.message }),
  });
  const phases = events.map((e) => e.phase);
  assert.ok(phases.includes('precheck'), 'dispatch 는 precheck 로 번역되어야 한다');
  assert.ok(phases.includes('upload'), 'fetch 는 upload 로 번역되어야 한다');
  assert.ok(phases.includes('finalize'), 'normalize/done 은 finalize 로 번역되어야 한다');
  // 영어 stage 명이 메시지로 누출되지 않아야 함.
  for (const ev of events) {
    assert.ok(!/dispatch|normalize|fetch\b|done/i.test(ev.message ?? ''),
      `영어 stage 명이 메시지에 누출됨: "${ev.message}"`);
    assert.ok(/[가-힣]/.test(ev.message ?? ''), `한국어 메시지가 비어 있음: "${ev.message}"`);
  }
});

test('D2. displayName 에 개발자 언어("실구현") 가 누출되지 않는다', () => {
  const adapter = new WebSearchAdapter({ maxBytes: 0, timeoutMs: 0 });
  assert.ok(!/실구현/.test(adapter.descriptor.displayName),
    `displayName 에 내부 표식이 노출됨: ${adapter.descriptor.displayName}`);
});
