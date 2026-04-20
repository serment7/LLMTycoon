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
// V7c. 실패 경로 예산 환불 — QA 잠금: pollJob 예외 / maxAttempts 초과 / 호출자
//      abort / 공급자 canceled 4경로 모두에서 BudgetLimiter 가 복구되어야 한다.
//      과거 구현은 `VIDEO_RENDER_ERROR` 를 던지기만 하고 예산을 남겨 두는 누수가
//      있었다. 환불 누락 회귀를 막기 위한 잠금.
// ────────────────────────────────────────────────────────────────────────────

test('V7c-1. pollJob 이 던지면 BudgetLimiter 가 환불된다', async () => {
  const provider = stubProvider({
    id: 'runway',
    costPerSecond: () => 0.1,
    async createJob(spec) {
      return {
        id: 'x', status: 'rendering', progress: 0.2, provider: 'runway',
        costEstimate: spec.durationSec * 0.1,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: spec.prompt, durationSec: spec.durationSec,
          aspectRatio: spec.aspectRatio, fps: spec.fps, shotCount: 1, policyChecked: false,
        },
      };
    },
    async pollJob() { throw new VideoProviderHttpError('boom', 500); },
  });
  const budget = new BudgetLimiter({ maxCost: 10 });
  await assert.rejects(
    () => generateVideo(baseSpec({ durationSec: 5 }), { pollIntervalMs: 1 }, {
      provider, budgetLimiter: budget, sleep: noSleep,
    }),
    (err: unknown) => {
      assert.equal((err as MediaAdapterError).details?.videoCode, 'VIDEO_PROVIDER_ERROR');
      return true;
    },
  );
  assert.equal(budget.getUsed(), 0, '실패 시 예산이 환불되어 used=0 이어야 함');
});

test('V7c-2. maxPollAttempts 초과 시에도 BudgetLimiter 가 환불된다', async () => {
  const provider = stubProvider({
    id: 'runway',
    costPerSecond: () => 0.2,
    async createJob(spec) {
      return {
        id: 'x', status: 'rendering', progress: 0.2, provider: 'runway',
        costEstimate: spec.durationSec * 0.2,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: spec.prompt, durationSec: spec.durationSec,
          aspectRatio: spec.aspectRatio, fps: spec.fps, shotCount: 1, policyChecked: false,
        },
      };
    },
    async pollJob(id) {
      return {
        id, status: 'rendering', progress: 0.3, provider: 'runway', costEstimate: 0,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: '', durationSec: 4, aspectRatio: '16:9', fps: 24,
          shotCount: 1, policyChecked: false,
        },
      };
    },
  });
  const budget = new BudgetLimiter({ maxCost: 10 });
  await assert.rejects(
    () => generateVideo(baseSpec({ durationSec: 4 }), { maxPollAttempts: 2, pollIntervalMs: 1 }, {
      provider, budgetLimiter: budget, sleep: noSleep,
    }),
    (err: unknown) => {
      assert.equal((err as MediaAdapterError).details?.videoCode, 'VIDEO_RENDER_ERROR');
      return true;
    },
  );
  assert.equal(budget.getUsed(), 0, 'maxAttempts 초과 시 환불되어 used=0');
});

test('V7c-3. 호출자 abort 시에도 BudgetLimiter 가 환불된다', async () => {
  const ac = new AbortController();
  const provider = stubProvider({
    id: 'pika',
    costPerSecond: () => 0.05,
    async createJob(spec) {
      return {
        id: 'c', status: 'rendering', progress: 0.1, provider: 'pika',
        costEstimate: spec.durationSec * 0.05,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: spec.prompt, durationSec: spec.durationSec,
          aspectRatio: spec.aspectRatio, fps: spec.fps, shotCount: 1, policyChecked: false,
        },
      };
    },
    async pollJob(id) {
      return {
        id, status: 'rendering', progress: 0.5, provider: 'pika', costEstimate: 0,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: '', durationSec: 4, aspectRatio: '16:9', fps: 24,
          shotCount: 1, policyChecked: false,
        },
      };
    },
  });
  const budget = new BudgetLimiter({ maxCost: 10 });
  const p = generateVideo(
    baseSpec({ durationSec: 4 }),
    { signal: ac.signal, pollIntervalMs: 5, maxPollAttempts: 100 },
    { provider, budgetLimiter: budget, sleep: noSleep },
  );
  queueMicrotask(() => ac.abort());
  await assert.rejects(p, (err: unknown) => {
    assert.equal((err as MediaAdapterError).code, 'ABORTED');
    return true;
  });
  assert.equal(budget.getUsed(), 0, 'abort 시 환불되어 used=0');
});

test('V7c-4. 공급자 canceled 응답은 ABORTED 로 표면화되고 예산 환불', async () => {
  const provider = stubProvider({
    id: 'runway',
    costPerSecond: () => 0.07,
    async createJob(spec) {
      return {
        id: 'x', status: 'rendering', progress: 0.1, provider: 'runway',
        costEstimate: spec.durationSec * 0.07,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: spec.prompt, durationSec: spec.durationSec,
          aspectRatio: spec.aspectRatio, fps: spec.fps, shotCount: 1, policyChecked: false,
        },
      };
    },
    async pollJob(id) {
      return {
        id, status: 'canceled', progress: 0, provider: 'runway', costEstimate: 0,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: '', durationSec: 4, aspectRatio: '16:9', fps: 24,
          shotCount: 1, policyChecked: false,
        },
      };
    },
  });
  const budget = new BudgetLimiter({ maxCost: 10 });
  await assert.rejects(
    () => generateVideo(baseSpec({ durationSec: 3 }), { pollIntervalMs: 1 }, {
      provider, budgetLimiter: budget, sleep: noSleep,
    }),
    (err: unknown) => {
      assert.equal((err as MediaAdapterError).code, 'ABORTED');
      return true;
    },
  );
  assert.equal(budget.getUsed(), 0, 'canceled 응답 시 환불되어 used=0');
});

test('V7c-5. 호출자 abort 시 공급자 cancelJob 이 전파되어 렌더 비용을 끊는다', async () => {
  // 과거 구현은 ABORTED 만 던지고 공급자 큐에 남은 렌더를 방치해 서버 측 비용이
  // 계속 발생했다. 취소 시 공급자에게도 cancelJob 을 쏴 이 누수를 막는 잠금.
  const ac = new AbortController();
  const canceledIds: string[] = [];
  const provider = stubProvider({
    id: 'pika',
    costPerSecond: () => 0.05,
    async createJob(spec) {
      return {
        id: 'abort-job', status: 'rendering', progress: 0.1, provider: 'pika',
        costEstimate: spec.durationSec * 0.05,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: spec.prompt, durationSec: spec.durationSec,
          aspectRatio: spec.aspectRatio, fps: spec.fps, shotCount: 1, policyChecked: false,
        },
      };
    },
    async pollJob(id) {
      return {
        id, status: 'rendering', progress: 0.5, provider: 'pika', costEstimate: 0,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: '', durationSec: 4, aspectRatio: '16:9', fps: 24,
          shotCount: 1, policyChecked: false,
        },
      };
    },
    async cancelJob(id) { canceledIds.push(id); },
  });
  const p = generateVideo(
    baseSpec({ durationSec: 4 }),
    { signal: ac.signal, pollIntervalMs: 5, maxPollAttempts: 100 },
    { provider, sleep: noSleep },
  );
  queueMicrotask(() => ac.abort());
  await assert.rejects(p, (err: unknown) => {
    assert.equal((err as MediaAdapterError).code, 'ABORTED');
    return true;
  });
  // fire-and-forget 로 쏜 cancelJob 이 microtask 큐에서 실행될 시간을 준다.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(canceledIds, ['abort-job'], 'abort 시 공급자 cancelJob 이 한 번 호출되어야 함');
});

test('V7c-6. 공급자가 먼저 canceled 를 반환하면 cancelJob 을 재호출하지 않는다', async () => {
  // 이미 공급자 쪽에서 취소 완료된 작업에 대해 cancelJob 을 또 쏘는 것은 불필요한
  // 왕복이므로, 상태가 canceled/failed/succeeded 일 때는 전파를 건너뛴다.
  const canceledIds: string[] = [];
  const provider = stubProvider({
    id: 'runway',
    costPerSecond: () => 0.07,
    async createJob(spec) {
      return {
        id: 'already-canceled', status: 'rendering', progress: 0.1, provider: 'runway',
        costEstimate: spec.durationSec * 0.07,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: spec.prompt, durationSec: spec.durationSec,
          aspectRatio: spec.aspectRatio, fps: spec.fps, shotCount: 1, policyChecked: false,
        },
      };
    },
    async pollJob(id) {
      return {
        id, status: 'canceled', progress: 0, provider: 'runway', costEstimate: 0,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: '', durationSec: 4, aspectRatio: '16:9', fps: 24,
          shotCount: 1, policyChecked: false,
        },
      };
    },
    async cancelJob(id) { canceledIds.push(id); },
  });
  await assert.rejects(
    () => generateVideo(baseSpec({ durationSec: 3 }), { pollIntervalMs: 1 }, {
      provider, sleep: noSleep,
    }),
    (err: unknown) => {
      assert.equal((err as MediaAdapterError).code, 'ABORTED');
      return true;
    },
  );
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(canceledIds, [], '공급자가 canceled 를 반환했으면 cancelJob 을 재호출하지 않음');
});

// ────────────────────────────────────────────────────────────────────────────
// V10. 입력 검증 — 빈 프롬프트·과도한 길이·지원하지 않는 해상도/화면 비율은
//      VIDEO_INVALID_INPUT(INPUT_INVALID) 로 즉시 거절된다. 공급자 호출 전에
//      터져야 하므로 createJob 이 호출되지 않았는지도 함께 확인.
// ────────────────────────────────────────────────────────────────────────────

test('V10a. 빈 프롬프트는 VIDEO_INVALID_INPUT 으로 즉시 거절', async () => {
  let created = 0;
  const provider = stubProvider({
    id: 'runway',
    async createJob(spec) {
      created += 1;
      return {
        id: 'x', status: 'queued', progress: 0, provider: 'runway',
        costEstimate: spec.durationSec * 0.01,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: spec.prompt, durationSec: spec.durationSec,
          aspectRatio: spec.aspectRatio, fps: spec.fps, shotCount: 1, policyChecked: false,
        },
      };
    },
  });
  await assert.rejects(
    () => generateVideo(baseSpec({ prompt: '   ' }), {}, { provider, sleep: noSleep }),
    (err: unknown) => {
      const e = err as MediaAdapterError;
      assert.equal(e.code, 'INPUT_INVALID');
      assert.equal(e.details?.videoCode, 'VIDEO_INVALID_INPUT');
      assert.equal(e.details?.field, 'prompt');
      return true;
    },
  );
  assert.equal(created, 0, '검증 실패 시 공급자 createJob 이 호출되면 안 됨');
});

test('V10b. 프롬프트 최대 길이(4000자)를 초과하면 VIDEO_INVALID_INPUT', async () => {
  const provider = stubProvider({ id: 'runway' });
  const tooLong = 'ㄱ'.repeat(4_001);
  await assert.rejects(
    () => generateVideo(baseSpec({ prompt: tooLong }), {}, { provider, sleep: noSleep }),
    (err: unknown) => {
      const e = err as MediaAdapterError;
      assert.equal(e.details?.videoCode, 'VIDEO_INVALID_INPUT');
      assert.equal(e.details?.field, 'prompt');
      assert.equal(e.details?.length, 4_001);
      return true;
    },
  );
});

test('V10c. durationSec 가 최대치(300초)를 넘으면 VIDEO_INVALID_INPUT', async () => {
  const provider = stubProvider({ id: 'runway' });
  await assert.rejects(
    () => generateVideo(baseSpec({ durationSec: 9_999 }), {}, { provider, sleep: noSleep }),
    (err: unknown) => {
      const e = err as MediaAdapterError;
      assert.equal(e.details?.videoCode, 'VIDEO_INVALID_INPUT');
      assert.equal(e.details?.field, 'durationSec');
      return true;
    },
  );
});

test('V10d. 지원하지 않는 aspectRatio 는 VIDEO_INVALID_INPUT', async () => {
  const provider = stubProvider({ id: 'runway' });
  await assert.rejects(
    // 타입 밖 값을 일부러 주입하는 시나리오(JS 호출, 잘못된 설정 등).
    () => generateVideo(
      baseSpec({ aspectRatio: '2:1' as unknown as '16:9' }),
      {},
      { provider, sleep: noSleep },
    ),
    (err: unknown) => {
      const e = err as MediaAdapterError;
      assert.equal(e.details?.videoCode, 'VIDEO_INVALID_INPUT');
      assert.equal(e.details?.field, 'aspectRatio');
      return true;
    },
  );
});

test('V10e. invoke() 가 지원 외 resolution 을 받으면 VIDEO_INVALID_INPUT', async () => {
  const provider = stubProvider({ id: 'invoke' });
  const adapter = new VideoAdapter(
    { maxBytes: 0, timeoutMs: 1_000 },
    { runtime: { provider, sleep: noSleep } },
  );
  await assert.rejects(
    () => adapter.invoke({
      input: {
        prompt: '정상 프롬프트',
        durationSeconds: 4,
        resolution: '8k' as unknown as '4k',
      },
    }),
    (err: unknown) => {
      const e = err as MediaAdapterError;
      assert.equal(e.code, 'INPUT_INVALID');
      assert.equal(e.details?.videoCode, 'VIDEO_INVALID_INPUT');
      assert.equal(e.details?.field, 'resolution');
      return true;
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// V11. 진행률 단조 증가 — policy → queue → render → finalize 구간에서
//      ratio 는 뒤로 가지 않아야 한다(UX 회귀 방지).
// ────────────────────────────────────────────────────────────────────────────

test('V11. onProgress 의 ratio 는 단조 증가한다', async () => {
  const provider = stubProvider({
    id: 'runway',
    async createJob(spec) {
      return {
        id: 'j', status: 'rendering', progress: 0.4, provider: 'runway',
        costEstimate: spec.durationSec * 0.01,
        metadata: {
          createdAtMs: 0, updatedAtMs: 0, prompt: spec.prompt, durationSec: spec.durationSec,
          aspectRatio: spec.aspectRatio, fps: spec.fps, shotCount: 1, policyChecked: false,
        },
      };
    },
  });
  const ratios: number[] = [];
  await generateVideo(
    baseSpec(),
    { onProgress: (p) => ratios.push(p.ratio), pollIntervalMs: 1 },
    { provider, sleep: noSleep },
  );
  for (let i = 1; i < ratios.length; i += 1) {
    assert.ok(
      ratios[i] >= ratios[i - 1] - 1e-9,
      `ratio 가 감소: [${i - 1}]=${ratios[i - 1]} → [${i}]=${ratios[i]}`,
    );
  }
  assert.equal(ratios[ratios.length - 1], 1, '마지막 ratio 는 1 이어야 함(finalize)');
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
