// Run with: npx tsx --test src/services/multimedia/adapters/__tests__/VideoAdapter.spec.ts
//
// 지시 #804155ce · VideoAdapter 실구현 단위 테스트.
// 공급자(Runway/Pika/Stability) 네트워크는 공급자 주입 훅으로 치환해 결정론적으로
// 검증한다. 잠금 축:
//   V1. 정상 — provider.createJob → pollJob 연속 → succeeded, VideoJob 반환.
//   V2. 진행률 — policy/queue/render/finalize 모두 발화.
//   V3. 큐잉 — concurrency=1 에서 두 호출이 순차 처리된다.
//   V4. 취소 — signal abort 시 ABORTED.
//   V5. 예산 초과 — BudgetLimiter.reserve() 실패 시 VIDEO_QUOTA_EXCEEDED.
//   V6. 정책 차단 — 기본 정책 점검기가 금지 키워드를 잡아 VIDEO_POLICY_BLOCKED.
//   V7. 공급자 429 → VIDEO_QUOTA_EXCEEDED, 500 → VIDEO_PROVIDER_ERROR.
//   V8. composeStoryboard — 긴 대본을 샷으로 쪼개고 합산 duration 을 보존한다.
//   V9. 레지스트리 통합 — createDefaultRegistry().resolveByKind('video') → 실구현.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MediaAdapterError,
  createDefaultRegistry,
} from '../../index.ts';
import {
  VideoAdapter,
  generateVideo,
  composeStoryboard,
  JobQueue,
  BudgetLimiter,
  VideoProviderHttpError,
  VIDEO_REAL_ADAPTER_ID,
  type VideoProvider,
  type VideoJob,
  type VideoSpec,
  type VideoProgress,
} from '../VideoAdapter.ts';

function baseSpec(overrides: Partial<VideoSpec> = {}): VideoSpec {
  return {
    prompt: '푸른 숲 속을 걷는 장면',
    durationSec: 4,
    aspectRatio: '16:9',
    fps: 24,
    ...overrides,
  };
}

function stubProvider(overrides: Partial<VideoProvider> & Pick<VideoProvider, 'id'>): VideoProvider {
  return {
    requiresCredentials: false,
    isEnabled: () => true,
    costPerSecond: () => 0.01,
    async createJob(spec) {
      return {
        id: `${overrides.id}-job-1`,
        status: 'queued',
        progress: 0,
        provider: overrides.id,
        costEstimate: spec.durationSec * 0.01,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: spec.prompt, durationSec: spec.durationSec,
          aspectRatio: spec.aspectRatio, fps: spec.fps, shotCount: 1, policyChecked: false,
        },
      };
    },
    async pollJob(id) {
      return {
        id,
        status: 'succeeded',
        progress: 1,
        provider: overrides.id,
        resultUrl: 'https://cdn.example/out.mp4',
        costEstimate: 0.04,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: '', durationSec: 4, aspectRatio: '16:9', fps: 24,
          shotCount: 1, policyChecked: false,
        },
      };
    },
    async cancelJob() { /* noop */ },
    ...overrides,
  };
}

// 테스트용 가짜 sleep — 실제 대기 없이 즉시 resolve.
const noSleep = async (_ms: number, signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new MediaAdapterError('ABORTED', 'abort', { adapterId: VIDEO_REAL_ADAPTER_ID });
  }
};

// ────────────────────────────────────────────────────────────────────────────
// V1. 정상 경로
// ────────────────────────────────────────────────────────────────────────────

test('V1. 정상 — createJob → pollJob succeeded → resultUrl 포함 VideoJob 반환', async () => {
  const provider = stubProvider({ id: 'runway-test' });
  const job = await generateVideo(baseSpec(), {}, { provider, sleep: noSleep });
  assert.equal(job.status, 'succeeded');
  assert.equal(job.resultUrl, 'https://cdn.example/out.mp4');
  assert.equal(job.provider, 'runway-test');
  assert.equal(job.metadata.policyChecked, true);
});

// ────────────────────────────────────────────────────────────────────────────
// V2. 진행률
// ────────────────────────────────────────────────────────────────────────────

test('V2. onProgress 는 policy/queue/render/finalize 를 모두 발화', async () => {
  const provider = stubProvider({
    id: 'runway',
    async createJob(spec) {
      return {
        id: 'j1', status: 'rendering', progress: 0.5, provider: 'runway',
        costEstimate: spec.durationSec * 0.01,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: spec.prompt, durationSec: spec.durationSec,
          aspectRatio: spec.aspectRatio, fps: spec.fps, shotCount: 1, policyChecked: false,
        },
      };
    },
  });
  const stages: VideoProgress['stage'][] = [];
  await generateVideo(baseSpec(), { onProgress: (p) => stages.push(p.stage) }, { provider, sleep: noSleep });
  for (const s of ['policy', 'queue', 'render', 'finalize'] as const) {
    assert.ok(stages.includes(s), `stage=${s} 가 발화되지 않음`);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// V3. 큐잉 — concurrency=1 에서 두 건은 순차 처리
// ────────────────────────────────────────────────────────────────────────────

test('V3. JobQueue concurrency=1 에서 두 건의 generateVideo 가 순차 처리된다', async () => {
  let currentlyRunning = 0;
  let maxConcurrent = 0;
  const provider = stubProvider({
    id: 'pika',
    async createJob(spec) {
      currentlyRunning += 1;
      maxConcurrent = Math.max(maxConcurrent, currentlyRunning);
      await new Promise((r) => setTimeout(r, 10));
      currentlyRunning -= 1;
      return {
        id: 'q1', status: 'succeeded', progress: 1, provider: 'pika',
        resultUrl: 'https://e.com/v.mp4',
        costEstimate: spec.durationSec * 0.01,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: spec.prompt, durationSec: spec.durationSec,
          aspectRatio: spec.aspectRatio, fps: spec.fps, shotCount: 1, policyChecked: false,
        },
      };
    },
  });
  const queue = new JobQueue({ concurrency: 1 });
  const results = await Promise.all([
    generateVideo(baseSpec({ prompt: 'A 장면' }), {}, { provider, jobQueue: queue, sleep: noSleep }),
    generateVideo(baseSpec({ prompt: 'B 장면' }), {}, { provider, jobQueue: queue, sleep: noSleep }),
  ]);
  assert.equal(results.length, 2);
  assert.equal(maxConcurrent, 1, '동시 실행이 1 을 넘지 않아야 함');
});

// ────────────────────────────────────────────────────────────────────────────
// V4. 취소
// ────────────────────────────────────────────────────────────────────────────

test('V4. 호출자 signal 이 abort 되면 ABORTED 로 종료', async () => {
  const ac = new AbortController();
  const provider = stubProvider({
    id: 'runway',
    async createJob(spec) {
      return {
        id: 'slow', status: 'rendering', progress: 0.1, provider: 'runway',
        costEstimate: spec.durationSec * 0.01,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: spec.prompt, durationSec: spec.durationSec,
          aspectRatio: spec.aspectRatio, fps: spec.fps, shotCount: 1, policyChecked: false,
        },
      };
    },
    async pollJob() {
      // 취소되기 전까지 계속 rendering 으로 머무른다.
      return {
        id: 'slow', status: 'rendering', progress: 0.5, provider: 'runway',
        costEstimate: 0,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: '', durationSec: 4, aspectRatio: '16:9', fps: 24,
          shotCount: 1, policyChecked: false,
        },
      };
    },
  });
  const p = generateVideo(
    baseSpec(),
    { signal: ac.signal, pollIntervalMs: 5, maxPollAttempts: 100 },
    { provider, sleep: noSleep },
  );
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
// V5. 예산 초과
// ────────────────────────────────────────────────────────────────────────────

test('V5. 예산 상한 초과 시 VIDEO_QUOTA_EXCEEDED', async () => {
  const provider = stubProvider({ id: 'runway', costPerSecond: () => 0.1 });
  const budget = new BudgetLimiter({ maxCost: 0.2 });
  await assert.rejects(
    async () => generateVideo(baseSpec({ durationSec: 30 }), {}, { provider, budgetLimiter: budget, sleep: noSleep }),
    (err: unknown) => {
      const e = err as MediaAdapterError;
      assert.equal(e.details?.videoCode, 'VIDEO_QUOTA_EXCEEDED');
      return true;
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// V6. 정책 차단
// ────────────────────────────────────────────────────────────────────────────

test('V6. 기본 정책 점검기가 금지 키워드를 잡아 VIDEO_POLICY_BLOCKED', async () => {
  const provider = stubProvider({ id: 'runway' });
  await assert.rejects(
    async () => generateVideo(
      baseSpec({ prompt: 'explicit sex scene with nude minor child' }),
      {},
      { provider, sleep: noSleep },
    ),
    (err: unknown) => {
      const e = err as MediaAdapterError;
      assert.equal(e.details?.videoCode, 'VIDEO_POLICY_BLOCKED');
      assert.ok(Array.isArray(e.details?.flags));
      return true;
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// V7. 공급자 HTTP 오류 매핑
// ────────────────────────────────────────────────────────────────────────────

test('V7a. 공급자 429 → VIDEO_QUOTA_EXCEEDED', async () => {
  const provider = stubProvider({
    id: 'pika',
    async createJob() { throw new VideoProviderHttpError('rate', 429); },
  });
  await assert.rejects(
    async () => generateVideo(baseSpec(), {}, { provider, sleep: noSleep }),
    (err: unknown) => {
      assert.equal((err as MediaAdapterError).details?.videoCode, 'VIDEO_QUOTA_EXCEEDED');
      return true;
    },
  );
});

test('V7b. 공급자 500 → VIDEO_PROVIDER_ERROR', async () => {
  const provider = stubProvider({
    id: 'pika',
    async createJob() { throw new VideoProviderHttpError('internal', 500); },
  });
  await assert.rejects(
    async () => generateVideo(baseSpec(), {}, { provider, sleep: noSleep }),
    (err: unknown) => {
      assert.equal((err as MediaAdapterError).details?.videoCode, 'VIDEO_PROVIDER_ERROR');
      return true;
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// V8. composeStoryboard
// ────────────────────────────────────────────────────────────────────────────

test('V8. composeStoryboard — 문장을 샷으로 쪼개고 durationSec 합이 총합과 일치', () => {
  const script = '첫 장면. 두 번째 장면! 세 번째 장면?';
  const shots = composeStoryboard(script, { totalDurationSec: 9, maxShots: 3 });
  assert.equal(shots.length, 3);
  const total = shots.reduce((acc, s) => acc + s.durationSec, 0);
  assert.equal(total, 9);
  assert.equal(shots[0].index, 1);
});

test('V8b. composeStoryboard — 빈 대본은 빈 배열', () => {
  assert.deepEqual(composeStoryboard('', { totalDurationSec: 5 }), []);
  assert.deepEqual(composeStoryboard('   ', { totalDurationSec: 5 }), []);
});

test('V8c. composeStoryboard — 문장 수가 maxShots 를 초과하면 합쳐 샷을 제한', () => {
  const script = '장면1. 장면2. 장면3. 장면4. 장면5.';
  const shots = composeStoryboard(script, { totalDurationSec: 10, maxShots: 2 });
  assert.equal(shots.length, 2);
  const total = shots.reduce((acc, s) => acc + s.durationSec, 0);
  assert.equal(total, 10);
});

// ────────────────────────────────────────────────────────────────────────────
// V9. 레지스트리 통합
// ────────────────────────────────────────────────────────────────────────────

test('V9. createDefaultRegistry().resolveByKind("video") 는 실구현(priority=-10) 을 반환', () => {
  const reg = createDefaultRegistry({ config: { timeoutMs: 1_000 } });
  const adapter = reg.resolveByKind('video');
  assert.equal(adapter.descriptor.id, VIDEO_REAL_ADAPTER_ID);
  assert.equal(adapter.descriptor.priority, -10);
  const found = reg.list().find((d) => d.id === VIDEO_REAL_ADAPTER_ID);
  assert.ok(found);
  assert.match(found!.displayName, /video\/generate/);
});

// ────────────────────────────────────────────────────────────────────────────
// VideoAdapter 클래스 경로
// ────────────────────────────────────────────────────────────────────────────

test('VideoAdapter.generateVideo() 는 주입된 runtime 의 공급자를 사용', async () => {
  const provider = stubProvider({ id: 'injected' });
  const adapter = new VideoAdapter({ maxBytes: 0, timeoutMs: 1_000 }, { runtime: { provider, sleep: noSleep } });
  const job = await adapter.generateVideo(baseSpec());
  assert.equal(job.status, 'succeeded');
  assert.equal(job.provider, 'injected');
});

test('VideoAdapter.invoke() 는 jobId/assetId 축약을 OutputMap 에 맞춰 반환', async () => {
  const provider = stubProvider({ id: 'invoke' });
  const adapter = new VideoAdapter({ maxBytes: 0, timeoutMs: 1_000 }, { runtime: { provider, sleep: noSleep } });
  const outcome: Awaited<ReturnType<VideoAdapter['invoke']>> = await adapter.invoke({
    input: { prompt: '테스트 영상', durationSeconds: 4 },
  });
  assert.equal(typeof outcome.result.jobId, 'string');
  assert.ok((outcome.result.jobId as string).length > 0);
});
