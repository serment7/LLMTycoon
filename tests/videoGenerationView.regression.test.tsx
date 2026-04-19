// Run with: npx tsx --test tests/videoGenerationView.regression.test.tsx
//
// 지시 #e407619a · VideoGeneration 세부 뷰 회귀 잠금.
// 축:
//   G1. 초기 phase=form — 폼·공급자 전환·비용 미리보기·스토리보드 컨테이너가 렌더.
//   G2. 공급자 라디오가 Runway/Pika/Stability 3종을 노출하고 선택 전환 가능.
//   G3. 예산 상한 초과 시 CostPreview 에 "예산 초과" 배지가 보이고 제출 경로가 차단.
//   G4. 제출 → 성공 플로우: stub provider 가 succeeded 를 돌려주면 결과 뷰가 뜨고
//       다운로드 버튼 + 메타데이터 토글이 노출된다.
//   G5. 컨텐츠 정책 차단 — policyChecker stub 가 거부하면 모달 + 복구 패널이 뜬다.
//   G6. 공급자 429 (VIDEO_QUOTA_EXCEEDED) → 오류 복구 패널에 공급자 전환 CTA.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, render, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { VideoGeneration } from '../src/views/multimedia/VideoGeneration.tsx';
import {
  VideoProviderHttpError,
  type VideoJob,
  type VideoProvider,
  type VideoRuntime,
  type VideoSpec,
} from '../src/services/multimedia/index.ts';

function stubProvider(overrides: Partial<VideoProvider> & Pick<VideoProvider, 'id'>): VideoProvider {
  return {
    requiresCredentials: false,
    isEnabled: () => true,
    costPerSecond: () => 0.05,
    async createJob(spec) { return succeededJob(overrides.id, spec); },
    async pollJob(id) { return succeededJob(overrides.id, { prompt: '', durationSec: 4, aspectRatio: '16:9', fps: 24 }, id); },
    async cancelJob() { /* noop */ },
    ...overrides,
  };
}

function succeededJob(providerId: string, spec: VideoSpec, id = `${providerId}-job-1`): VideoJob {
  return {
    id,
    status: 'succeeded',
    progress: 1,
    provider: providerId,
    resultUrl: 'https://cdn.example/video.mp4',
    costEstimate: spec.durationSec * 0.05,
    metadata: {
      createdAtMs: 0,
      updatedAtMs: 0,
      prompt: spec.prompt,
      durationSec: spec.durationSec,
      aspectRatio: spec.aspectRatio,
      fps: spec.fps,
      shotCount: 1,
      policyChecked: true,
    },
  };
}

function mount(props: React.ComponentProps<typeof VideoGeneration> = {}) {
  return render(React.createElement(VideoGeneration, props));
}

// ────────────────────────────────────────────────────────────────────────────

test('G1. 초기 phase=form — 폼/공급자/비용/스토리보드 컨테이너 렌더', () => {
  const handle = mount();
  assert.ok(document.querySelector('[data-testid="video-generation-form"]'));
  assert.ok(document.querySelector('[data-testid="video-generation-provider-switcher"]'));
  assert.ok(document.querySelector('[data-testid="video-generation-cost-preview"]'));
  assert.ok(document.querySelector('[data-testid="video-generation-storyboard"]'));
  handle.unmount();
  cleanup();
});

test('G2. 공급자 라디오 3종 노출 · 선택 전환', () => {
  const handle = mount();
  const radios = document.querySelectorAll('[data-testid="video-generation-provider-switcher"] input[type="radio"]');
  assert.equal(radios.length, 3);
  const pika = Array.from(radios).find((r) => (r as HTMLInputElement).value === 'pika') as HTMLInputElement;
  act(() => { fireEvent.click(pika); });
  assert.equal(pika.checked, true);
  handle.unmount();
  cleanup();
});

test('G3. 예산 상한 초과 시 CostPreview 에 "예산 초과" 배지 노출', () => {
  const handle = mount({ budgetUsd: 0.1 });
  const preview = document.querySelector('[data-testid="video-generation-cost-preview"]');
  assert.ok(preview);
  // 기본 durationSec=6 × $0.05/s(runway) = $0.30 → 예산 $0.10 초과.
  assert.match(preview?.textContent ?? '', /예산 초과/);
  handle.unmount();
  cleanup();
});

test('G4. 제출 → 성공 플로우 → 결과 뷰 · 다운로드 · 메타데이터 토글', async () => {
  const runtime: VideoRuntime = {
    providers: [stubProvider({ id: 'runway' })],
    sleep: async () => { /* 즉시 resolve */ },
  };
  const handle = mount({ runtime });
  // 프롬프트 입력.
  const promptInput = document.querySelector('[aria-label="영상 프롬프트"]') as HTMLTextAreaElement;
  act(() => { fireEvent.change(promptInput, { target: { value: '숲 속을 달리는 여우' } }); });
  // 제출 클릭.
  const submitBtn = document.querySelector('[data-testid="video-generation-submit"]') as HTMLButtonElement;
  await act(async () => { fireEvent.click(submitBtn); });
  await waitFor(() => {
    assert.ok(document.querySelector('[data-testid="video-generation-result"]'), '결과 뷰 렌더');
  });
  const download = document.querySelector('[data-testid="video-generation-download"]') as HTMLAnchorElement;
  assert.equal(download.getAttribute('href'), 'https://cdn.example/video.mp4');
  // 메타데이터 토글.
  const metaBtn = document.querySelector('[aria-label="메타데이터 토글"]') as HTMLButtonElement;
  act(() => { fireEvent.click(metaBtn); });
  assert.ok(document.querySelector('[data-testid="video-generation-metadata"]'));
  handle.unmount();
  cleanup();
});

test('G5. 컨텐츠 정책 차단 → 모달 + 복구 패널 노출', async () => {
  const runtime: VideoRuntime = {
    providers: [stubProvider({ id: 'runway' })],
    policyChecker: async () => ({ ok: false, flags: ['explicit-sexual'], reason: '정책 위반' }),
    sleep: async () => { /* instant */ },
  };
  const handle = mount({ runtime });
  const promptInput = document.querySelector('[aria-label="영상 프롬프트"]') as HTMLTextAreaElement;
  act(() => { fireEvent.change(promptInput, { target: { value: '테스트 정책 차단 프롬프트' } }); });
  const submit = document.querySelector('[data-testid="video-generation-submit"]') as HTMLButtonElement;
  await act(async () => { fireEvent.click(submit); });
  await waitFor(() => {
    assert.ok(document.querySelector('[data-testid="video-generation-policy-modal"]'), '정책 모달 표시');
  });
  const recovery = document.querySelector('[data-testid="video-generation-error-recovery"]');
  assert.ok(recovery);
  assert.match(recovery?.textContent ?? '', /VIDEO_POLICY_BLOCKED/);
  handle.unmount();
  cleanup();
});

test('G6. 공급자 429 → VIDEO_QUOTA_EXCEEDED 복구 패널 + 공급자 전환 CTA', async () => {
  const runtime: VideoRuntime = {
    providers: [stubProvider({
      id: 'runway',
      async createJob() { throw new VideoProviderHttpError('rate', 429); },
    })],
    sleep: async () => { /* instant */ },
  };
  const handle = mount({ runtime });
  const promptInput = document.querySelector('[aria-label="영상 프롬프트"]') as HTMLTextAreaElement;
  act(() => { fireEvent.change(promptInput, { target: { value: '쿼터 초과 유도 프롬프트' } }); });
  const submit = document.querySelector('[data-testid="video-generation-submit"]') as HTMLButtonElement;
  await act(async () => { fireEvent.click(submit); });
  await waitFor(() => {
    const rec = document.querySelector('[data-testid="video-generation-error-recovery"]');
    assert.ok(rec);
    assert.match(rec?.textContent ?? '', /VIDEO_QUOTA_EXCEEDED/);
  });
  const btnText = (document.querySelector('[data-testid="video-generation-error-recovery"]')?.textContent ?? '');
  assert.match(btnText, /공급자 전환/);
  handle.unmount();
  cleanup();
});
