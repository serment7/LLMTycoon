// 지시 #95de334d · 전역 멀티미디어 작업(장시간 태스크) 큐 훅.
//
// 영상 생성·리서치처럼 분 단위로 이어지는 비동기 작업을 허브 바깥 어디에서든
// "진행 중 1건 · 44%" 식으로 추적할 수 있어야 한다. 본 훅은 모듈-싱글턴 스토어를
// 단일 진원으로 두고, 구독자(카드 메타·상단바 배지·결과 스트립)가 useSyncExternalStore
// 로 즉시 반응한다.
//
// 설계 원칙
//   1) 직렬화·영속화는 안 한다 — 새로고침 시 작업은 사라진다(서버가 권위값 보유).
//   2) onProgress · onComplete · onFail 가 등록된 소비자가 있어도, 스토어 자체는
//      순수 React 의존 없이 테스트 가능하도록 createMultimediaJobsStore() 로 분리.
//   3) start() 는 어댑터 호출을 하지 않고 "작업 등록" 만 한다. 실제 invoke 는 허브 쪽
//      상세 뷰가 수행하고, 진행률·완료·실패를 본 스토어에 다시 보고한다.

import { useSyncExternalStore } from 'react';

import type { MediaAdapterKind } from '../../services/multimedia';

export type MultimediaJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface MultimediaJob {
  readonly id: string;
  readonly kind: MediaAdapterKind;
  readonly title: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly status: MultimediaJobStatus;
  readonly progress: number;
  readonly phase?: string;
  readonly etaMs?: number;
  readonly errorMessage?: string;
  readonly resultSummary?: string;
}

export type MultimediaJobListener = (jobs: readonly MultimediaJob[]) => void;

export interface MultimediaJobsStore {
  getSnapshot(): readonly MultimediaJob[];
  subscribe(listener: MultimediaJobListener): () => void;
  start(input: { kind: MediaAdapterKind; title: string; jobId?: string }): string;
  update(jobId: string, patch: Partial<Omit<MultimediaJob, 'id' | 'kind' | 'createdAtMs'>>): void;
  complete(jobId: string, resultSummary?: string): void;
  fail(jobId: string, errorMessage: string): void;
  cancel(jobId: string): void;
  clear(jobId: string): void;
  clearAll(): void;
}

export function createMultimediaJobsStore(now: () => number = Date.now): MultimediaJobsStore {
  let jobs: readonly MultimediaJob[] = [];
  const listeners = new Set<MultimediaJobListener>();

  const emit = (): void => {
    for (const listener of listeners) {
      try { listener(jobs); } catch { /* 옵저버 실패는 스토어에 영향 없음 */ }
    }
  };

  const findIndex = (id: string): number => jobs.findIndex((j) => j.id === id);

  return {
    getSnapshot() { return jobs; },

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    start({ kind, title, jobId }) {
      const id = jobId ?? `mm-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const job: MultimediaJob = {
        id,
        kind,
        title,
        createdAtMs: now(),
        updatedAtMs: now(),
        status: 'queued',
        progress: 0,
      };
      jobs = [...jobs, job];
      emit();
      return id;
    },

    update(jobId, patch) {
      const idx = findIndex(jobId);
      if (idx < 0) return;
      const current = jobs[idx];
      const next: MultimediaJob = {
        ...current,
        ...patch,
        updatedAtMs: now(),
      };
      jobs = [...jobs.slice(0, idx), next, ...jobs.slice(idx + 1)];
      emit();
    },

    complete(jobId, resultSummary) {
      const idx = findIndex(jobId);
      if (idx < 0) return;
      const next: MultimediaJob = {
        ...jobs[idx],
        status: 'completed',
        progress: 1,
        updatedAtMs: now(),
        ...(resultSummary ? { resultSummary } : {}),
      };
      jobs = [...jobs.slice(0, idx), next, ...jobs.slice(idx + 1)];
      emit();
    },

    fail(jobId, errorMessage) {
      const idx = findIndex(jobId);
      if (idx < 0) return;
      const next: MultimediaJob = {
        ...jobs[idx],
        status: 'failed',
        updatedAtMs: now(),
        errorMessage,
      };
      jobs = [...jobs.slice(0, idx), next, ...jobs.slice(idx + 1)];
      emit();
    },

    cancel(jobId) {
      const idx = findIndex(jobId);
      if (idx < 0) return;
      const next: MultimediaJob = {
        ...jobs[idx],
        status: 'cancelled',
        updatedAtMs: now(),
      };
      jobs = [...jobs.slice(0, idx), next, ...jobs.slice(idx + 1)];
      emit();
    },

    clear(jobId) {
      const idx = findIndex(jobId);
      if (idx < 0) return;
      jobs = [...jobs.slice(0, idx), ...jobs.slice(idx + 1)];
      emit();
    },

    clearAll() {
      if (jobs.length === 0) return;
      jobs = [];
      emit();
    },
  };
}

// 모듈 싱글턴 — 한 브라우저 탭에서 공유된다. 테스트는 createMultimediaJobsStore 로
// 독립 인스턴스를 만들어 검증한다.
const globalStore: MultimediaJobsStore = createMultimediaJobsStore();

export function getMultimediaJobsStore(): MultimediaJobsStore {
  return globalStore;
}

export interface UseMultimediaJobsValue {
  readonly jobs: readonly MultimediaJob[];
  readonly running: readonly MultimediaJob[];
  readonly recent: readonly MultimediaJob[];
  /** 특정 kind 의 진행 중 작업만 필터링 — 카드 메타에서 사용. */
  byKind(kind: MediaAdapterKind): readonly MultimediaJob[];
  readonly store: MultimediaJobsStore;
}

export function useMultimediaJobs(store: MultimediaJobsStore = globalStore): UseMultimediaJobsValue {
  const jobs = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot, // SSR 스냅샷 — 서버에서는 빈 배열이 기본.
  );
  return {
    jobs,
    running: jobs.filter((j) => j.status === 'running' || j.status === 'queued'),
    recent: jobs
      .filter((j) => j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled')
      .slice()
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .slice(0, 12),
    byKind(kind: MediaAdapterKind) {
      return jobs.filter((j) => j.kind === kind);
    },
    store,
  };
}
