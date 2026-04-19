// 지시 #e407619a · 멀티미디어 허브의 '영상 생성' 세부 뷰.
//
// Thanos 가 직전 라운드에 완성한 VideoAdapter(공급자 3종 · JobQueue · BudgetLimiter ·
// 컨텐츠 정책 훅 · composeStoryboard) 와 디자이너가 확정한 시안
// (docs/designs/video-generation-ux.md) 을 결합해 사용자에게 "프롬프트 입력 → 샷
// 편집 → 제출 → 진행률 추적 → 결과 뷰" 의 완주 경로를 제공한다.
//
// 본 뷰는 Joker 가 만든 MultimediaAdapterShell 의 formSlot/previewSlot 을 채우고,
// 실제 어댑터 호출은 runtime(VideoRuntime) 주입으로 테스트 가능하게 열어 둔다.
// 운영 환경은 createDefaultRegistry().resolveByKind('video') 의 결과를 사용한다.
//
// 구성(시안 §4~§9)
//   1) 프롬프트 · 길이 · 화면비 · FPS · 스타일 · 시드 · 음성/자막 폼
//   2) 스토리보드 편집기(composeStoryboard 호출 → 샷 썸네일 · 재배치 · 개별 프롬프트 수정
//      · 개별 재생성 트리거). 드래그 재배치는 키보드(↑/↓) 와 마우스(드래그) 둘 다 지원.
//   3) 비용 미리보기 — 공급자 초당 단가 × durationSec + 예산 상한 amber 경고.
//   4) 작업 대기열 + 진행률 타임라인 — useMultimediaJobs 구독으로 전역 큐와 동기화.
//   5) 컨텐츠 정책 차단(VIDEO_POLICY_BLOCKED) → 안내 모달 + 재제출 플로우(수정 후 재시도).
//   6) 결과 뷰 — 다운로드 · 공유 · 워터마크 · 메타데이터 펼치기.
//   7) 공급자 전환 — Runway/Pika/StabilityVideo 단일 라디오, 현재 키 존재 여부 배지.
//   8) 오류 복구 — VIDEO_QUOTA_EXCEEDED(예산/쿼터), VIDEO_PROVIDER_ERROR(공급자 네트워크),
//      VIDEO_RENDER_ERROR(렌더 실패) 3종에 맞춘 복구 CTA 매핑.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Copy,
  Download,
  Film,
  FlaskConical,
  RefreshCw,
  Share2,
  Trash2,
  Wand2,
  Shield,
  GripVertical,
} from 'lucide-react';

import {
  composeStoryboard,
  generateVideo,
  BudgetLimiter,
  JobQueue,
  type AspectRatio,
  type PolicyChecker,
  type Shot,
  type VideoAudioMode,
  type VideoJob,
  type VideoProgress,
  type VideoProvider,
  type VideoRuntime,
  type VideoSpec,
  type VideoStyle,
  MediaAdapterError,
} from '../../services/multimedia';

import { MultimediaAdapterShell, type MultimediaAdapterPhase } from './MultimediaAdapterShell';
import { resolveCardByRoute } from './routes';
import { useMultimediaJobs } from './useMultimediaJobs';

// ────────────────────────────────────────────────────────────────────────────
// Props · 내부 상태 모델
// ────────────────────────────────────────────────────────────────────────────

export interface VideoGenerationProps {
  readonly onClose?: () => void;
  /** 테스트/스토리북용. 미지정 시 공급자 모킹 전까지는 provider 미주입 상태. */
  readonly runtime?: VideoRuntime;
  /** 예산 상한(USD). BudgetLimiter 를 자동 주입. */
  readonly budgetUsd?: number;
  /** 초기 공급자 선택. 미지정 시 runtime.providers[0] 또는 'runway'. */
  readonly initialProvider?: string;
  /** 테스트용 phase 강제. */
  readonly forcePhase?: MultimediaAdapterPhase;
}

export type ProviderId = 'runway' | 'pika' | 'stability';

interface FormState {
  prompt: string;
  durationSec: number;
  aspectRatio: AspectRatio;
  fps: number;
  style: VideoStyle;
  seed: string;
  audio: VideoAudioMode;
  subtitles: boolean;
  watermark: string;
  provider: ProviderId;
}

const DEFAULT_FORM: FormState = {
  prompt: '',
  durationSec: 6,
  aspectRatio: '16:9',
  fps: 24,
  style: 'cinematic',
  seed: '',
  audio: 'silent',
  subtitles: false,
  watermark: 'LLMTycoon',
  provider: 'runway',
};

const PROVIDER_COST_USD: Record<ProviderId, number> = {
  runway: 0.05,
  pika: 0.03,
  stability: 0.04,
};

const PROVIDER_LABEL: Record<ProviderId, string> = {
  runway: 'Runway',
  pika: 'Pika',
  stability: 'StabilityVideo',
};

// ────────────────────────────────────────────────────────────────────────────
// 뷰 본체
// ────────────────────────────────────────────────────────────────────────────

const focusRing = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pixel-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black';

export function VideoGeneration(props: VideoGenerationProps): React.ReactElement {
  const card = resolveCardByRoute('video');
  const jobs = useMultimediaJobs();
  const [form, setForm] = useState<FormState>(() => ({
    ...DEFAULT_FORM,
    provider: (props.initialProvider as ProviderId) ?? DEFAULT_FORM.provider,
  }));
  const [shots, setShots] = useState<Shot[]>([]);
  const [phase, setPhase] = useState<MultimediaAdapterPhase>(props.forcePhase ?? 'form');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJobSnapshot, setActiveJobSnapshot] = useState<VideoJob | null>(null);
  const [error, setError] = useState<{ code?: string; videoCode?: string; message?: string; flags?: readonly string[] } | null>(null);
  const [resultJob, setResultJob] = useState<VideoJob | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [policyModalOpen, setPolicyModalOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // runtime 이 바뀔 때마다 초기 공급자를 다시 계산한다(테스트 경로).
  useEffect(() => {
    if (!props.runtime?.providers || props.runtime.providers.length === 0) return;
    const available = props.runtime.providers.filter((p) => p.isEnabled());
    if (available.length === 0) return;
    const first = available[0].id as ProviderId;
    setForm((prev) => ({ ...prev, provider: (prev.provider in PROVIDER_COST_USD) ? prev.provider : first }));
  }, [props.runtime]);

  const estimatedCostUsd = useMemo(
    () => form.durationSec * PROVIDER_COST_USD[form.provider],
    [form.durationSec, form.provider],
  );
  const overBudget = typeof props.budgetUsd === 'number' && estimatedCostUsd > props.budgetUsd;

  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // 스토리보드 분해 — 프롬프트 변경 시 자동 재계산.
  const autoCompose = useCallback(() => {
    if (!form.prompt.trim()) { setShots([]); return; }
    const next = composeStoryboard(form.prompt, { totalDurationSec: form.durationSec, maxShots: 6 });
    setShots(next);
  }, [form.prompt, form.durationSec]);

  const moveShot = (index: number, direction: -1 | 1) => {
    setShots((prev) => {
      const next = [...prev];
      const swapIndex = index + direction;
      if (swapIndex < 0 || swapIndex >= next.length) return prev;
      const tmp = next[index];
      next[index] = next[swapIndex];
      next[swapIndex] = tmp;
      return next.map((s, i) => ({ ...s, index: i + 1 }));
    });
  };

  const editShotPrompt = (index: number, nextPrompt: string) => {
    setShots((prev) => prev.map((s, i) => i === index ? { ...s, prompt: nextPrompt } : s));
  };

  const regenerateShot = (index: number) => {
    // 개별 샷 재생성 트리거 — 전역 큐에 sub-job 을 추가한다.
    if (!card) return;
    const id = jobs.store.start({ kind: 'video', title: `샷 ${index + 1} 재생성` });
    jobs.store.update(id, { status: 'running', progress: 0.3, phase: 'render' });
    setTimeout(() => {
      jobs.store.complete(id, `샷 ${index + 1} 새 클립 준비 완료(모의)`);
    }, 50);
  };

  // ────────────────────────────────────────────────────────────────────────
  // 제출 경로 — runtime 이 주입돼 있으면 generateVideo 를 실제 호출.
  // 미주입 상태면 "runtime 미구성" 경고를 띄워 테스트·스토리북 환경 구분.
  // ────────────────────────────────────────────────────────────────────────

  const onSubmit = async () => {
    setError(null);
    setResultJob(null);
    if (!form.prompt.trim()) {
      setError({ code: 'EMPTY_PROMPT', message: '프롬프트를 입력하세요.' });
      return;
    }
    if (overBudget) {
      setError({
        code: 'BUDGET_GUARD',
        videoCode: 'VIDEO_QUOTA_EXCEEDED',
        message: `예상 비용 $${estimatedCostUsd.toFixed(3)} 가 설정한 예산 $${props.budgetUsd?.toFixed(3)} 을 초과합니다.`,
      });
      setPhase('error');
      return;
    }

    autoCompose();
    if (!card) return;

    const runtime = buildRuntime(props, form);
    if (!runtime.provider && (!runtime.providers || runtime.providers.length === 0)) {
      setError({
        code: 'PROVIDER_UNCONFIGURED',
        videoCode: 'VIDEO_PROVIDER_ERROR',
        message: '영상 생성 공급자가 구성되지 않았어요. 설정에서 API 키를 추가하세요.',
      });
      setPhase('error');
      return;
    }

    const abort = new AbortController();
    abortRef.current = abort;
    const spec: VideoSpec = {
      prompt: form.prompt,
      durationSec: form.durationSec,
      aspectRatio: form.aspectRatio,
      fps: form.fps,
      seed: form.seed.trim() ? Number(form.seed) : undefined,
      style: form.style,
      audio: form.audio,
      shotCount: shots.length || 1,
      watermark: form.watermark.trim() || undefined,
    };
    const jobId = jobs.store.start({ kind: 'video', title: form.prompt.slice(0, 60) });
    setActiveJobId(jobId);
    setPhase('loading');
    jobs.store.update(jobId, { status: 'running', progress: 0, phase: 'precheck' });
    try {
      const job = await generateVideo(
        spec,
        {
          signal: abort.signal,
          onProgress: (p: VideoProgress) => {
            setActiveJobSnapshot((prev) => prev ? { ...prev, status: 'rendering', progress: p.ratio } : prev);
            jobs.store.update(jobId, {
              status: p.stage === 'finalize' ? 'running' : 'running',
              progress: p.ratio,
              phase: p.stage,
            });
          },
        },
        runtime,
      );
      setActiveJobSnapshot(job);
      setResultJob(job);
      jobs.store.complete(jobId, job.resultUrl ? `영상 준비 완료 · ${form.provider}` : `작업 완료`);
      setPhase('success');
    } catch (err) {
      const msg = err instanceof MediaAdapterError ? err.message : String(err);
      const videoCode = (err instanceof MediaAdapterError && typeof err.details?.videoCode === 'string') ? err.details.videoCode as string : undefined;
      const flags = (err instanceof MediaAdapterError && Array.isArray(err.details?.flags))
        ? err.details!.flags as readonly string[]
        : undefined;
      setError({ code: err instanceof MediaAdapterError ? err.code : 'INTERNAL', videoCode, message: msg, flags });
      jobs.store.fail(jobId, msg);
      if (videoCode === 'VIDEO_POLICY_BLOCKED') {
        setPolicyModalOpen(true);
      }
      setPhase('error');
    } finally {
      abortRef.current = null;
    }
  };

  const onCancel = () => {
    abortRef.current?.abort();
    if (activeJobId) jobs.store.cancel(activeJobId);
    setPhase('form');
  };

  const onRetry = () => {
    setError(null);
    setPolicyModalOpen(false);
    setPhase('form');
  };

  const onPolicyFix = () => {
    // 사용자가 프롬프트를 고쳐 재제출하도록 포커스 이동. 모달만 닫고 폼 단계로 복귀.
    setPolicyModalOpen(false);
    setPhase('form');
    setError(null);
  };

  const shellPhase = props.forcePhase ?? phase;

  if (!card) {
    return (
      <section data-testid="video-generation-no-card" role="alert">
        /multimedia/video 카드 메타를 찾을 수 없습니다.
      </section>
    );
  }

  return (
    <MultimediaAdapterShell
      card={card}
      phase={shellPhase}
      onClose={props.onClose}
      errorCode={error?.videoCode ?? error?.code}
      errorMessage={error?.message}
      onRetry={shellPhase === 'error' ? onRetry : undefined}
      formSlot={
        <VideoForm
          form={form}
          shots={shots}
          estimatedCostUsd={estimatedCostUsd}
          budgetUsd={props.budgetUsd}
          overBudget={overBudget}
          runtime={props.runtime}
          onChange={updateForm}
          onCompose={autoCompose}
          onMoveShot={moveShot}
          onEditShotPrompt={editShotPrompt}
          onRegenerateShot={regenerateShot}
          onSubmit={onSubmit}
          onCancel={phase === 'loading' ? onCancel : undefined}
          busy={phase === 'loading'}
        />
      }
      previewSlot={resultJob ? (
        <VideoResult
          job={resultJob}
          watermark={form.watermark}
          metadataOpen={metadataOpen}
          onToggleMetadata={() => setMetadataOpen((v) => !v)}
        />
      ) : null}
      runningJob={activeJobId ? jobs.jobs.find((j) => j.id === activeJobId) : undefined}
    >
      <JobQueueTimeline jobs={jobs.jobs} />

      {policyModalOpen && error?.videoCode === 'VIDEO_POLICY_BLOCKED' ? (
        <PolicyBlockedModal
          flags={error.flags ?? []}
          message={error.message ?? '컨텐츠 정책 위반 소지가 있어요.'}
          onClose={() => setPolicyModalOpen(false)}
          onFix={onPolicyFix}
        />
      ) : null}

      {shellPhase === 'error' && error?.videoCode ? (
        <ErrorRecoveryPanel
          videoCode={error.videoCode}
          onFixPrompt={onPolicyFix}
          onLowerBudget={() => updateForm('durationSec', Math.max(2, form.durationSec - 2))}
          onSwitchProvider={() => {
            const next = form.provider === 'runway' ? 'pika' : form.provider === 'pika' ? 'stability' : 'runway';
            updateForm('provider', next as ProviderId);
            onRetry();
          }}
          onRetry={onRetry}
        />
      ) : null}
    </MultimediaAdapterShell>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Runtime 합성 — Props 의 runtime + form 의 공급자 선택을 병합.
// ────────────────────────────────────────────────────────────────────────────

function buildRuntime(props: VideoGenerationProps, form: FormState): VideoRuntime {
  const baseProviders = props.runtime?.providers ?? [];
  const selected = baseProviders.find((p) => p.id === form.provider);
  const policyChecker: PolicyChecker | undefined = props.runtime?.policyChecker;
  const budget = typeof props.budgetUsd === 'number'
    ? new BudgetLimiter({ maxCost: props.budgetUsd })
    : undefined;
  return {
    ...props.runtime,
    provider: selected ?? props.runtime?.provider,
    providers: baseProviders,
    policyChecker,
    budgetLimiter: props.runtime?.budgetLimiter ?? budget,
    jobQueue: props.runtime?.jobQueue ?? new JobQueue({ concurrency: 2 }),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// VideoForm — 입력 폼 + 스토리보드 편집기 + 비용 미리보기
// ────────────────────────────────────────────────────────────────────────────

interface VideoFormProps {
  readonly form: FormState;
  readonly shots: readonly Shot[];
  readonly estimatedCostUsd: number;
  readonly budgetUsd?: number;
  readonly overBudget: boolean;
  readonly runtime?: VideoRuntime;
  readonly onChange: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  readonly onCompose: () => void;
  readonly onMoveShot: (index: number, direction: -1 | 1) => void;
  readonly onEditShotPrompt: (index: number, next: string) => void;
  readonly onRegenerateShot: (index: number) => void;
  readonly onSubmit: () => void | Promise<void>;
  readonly onCancel?: () => void;
  readonly busy: boolean;
}

function VideoForm({
  form, shots, estimatedCostUsd, budgetUsd, overBudget, runtime,
  onChange, onCompose, onMoveShot, onEditShotPrompt, onRegenerateShot,
  onSubmit, onCancel, busy,
}: VideoFormProps): React.ReactElement {
  return (
    <div data-testid="video-generation-form" className="flex flex-col gap-4">
      <section aria-labelledby="video-gen-spec" className="flex flex-col gap-2">
        <h3 id="video-gen-spec" className="text-[11px] uppercase tracking-wider text-white/80">기본 입력</h3>
        <textarea
          aria-label="영상 프롬프트"
          placeholder="예: 푸른 숲 속을 걷는 여우의 시네마틱 숏."
          value={form.prompt}
          onChange={(e) => onChange('prompt', e.target.value)}
          onBlur={onCompose}
          rows={3}
          className={`w-full bg-black/30 border-2 border-[var(--pixel-border)] px-3 py-2 text-[12px] text-white font-mono ${focusRing}`}
        />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <label className="flex flex-col gap-1 text-[10px] uppercase text-white/70">
            길이(초)
            <input
              aria-label="길이"
              type="number"
              min={2}
              max={60}
              value={form.durationSec}
              onChange={(e) => onChange('durationSec', Math.max(2, Math.min(60, Number(e.target.value) || 2)))}
              className={`bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white ${focusRing}`}
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase text-white/70">
            화면비
            <select
              aria-label="화면비"
              value={form.aspectRatio}
              onChange={(e) => onChange('aspectRatio', e.target.value as AspectRatio)}
              className={`bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white ${focusRing}`}
            >
              <option value="16:9">16:9</option>
              <option value="9:16">9:16</option>
              <option value="1:1">1:1</option>
              <option value="4:3">4:3</option>
              <option value="21:9">21:9</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase text-white/70">
            FPS
            <input
              aria-label="FPS"
              type="number"
              min={8}
              max={60}
              value={form.fps}
              onChange={(e) => onChange('fps', Math.max(8, Math.min(60, Number(e.target.value) || 24)))}
              className={`bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white ${focusRing}`}
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase text-white/70">
            스타일
            <select
              aria-label="스타일"
              value={form.style}
              onChange={(e) => onChange('style', e.target.value as VideoStyle)}
              className={`bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white ${focusRing}`}
            >
              <option value="realistic">사실적</option>
              <option value="cinematic">시네마틱</option>
              <option value="animation">애니메이션</option>
              <option value="anime">아니메</option>
              <option value="vintage">빈티지</option>
              <option value="claymation">클레이</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase text-white/70">
            시드(선택)
            <input
              aria-label="시드"
              value={form.seed}
              onChange={(e) => onChange('seed', e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="예: 42"
              className={`bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white ${focusRing}`}
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase text-white/70">
            음성
            <select
              aria-label="음성"
              value={form.audio}
              onChange={(e) => onChange('audio', e.target.value as VideoAudioMode)}
              className={`bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white ${focusRing}`}
            >
              <option value="silent">무음</option>
              <option value="music">배경 음악</option>
              <option value="voiceover">보이스오버</option>
              <option value="sfx">효과음</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-[11px] text-white/80 col-span-2">
            <input
              aria-label="자막 포함"
              type="checkbox"
              checked={form.subtitles}
              onChange={(e) => onChange('subtitles', e.target.checked)}
            />
            자막 포함
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase text-white/70 col-span-2">
            워터마크
            <input
              aria-label="워터마크 텍스트"
              value={form.watermark}
              onChange={(e) => onChange('watermark', e.target.value)}
              placeholder="브랜드 문자열"
              className={`bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white ${focusRing}`}
            />
          </label>
        </div>
      </section>

      <ProviderSwitcher
        value={form.provider}
        runtime={runtime}
        onChange={(next) => onChange('provider', next)}
      />

      <CostPreview
        estimatedCostUsd={estimatedCostUsd}
        budgetUsd={budgetUsd}
        overBudget={overBudget}
      />

      <Storyboard
        shots={shots}
        onRecompose={onCompose}
        onMoveShot={onMoveShot}
        onEditShotPrompt={onEditShotPrompt}
        onRegenerateShot={onRegenerateShot}
      />

      <div className="flex gap-2 items-center">
        <button
          type="button"
          aria-label="영상 생성 시작"
          data-testid="video-generation-submit"
          onClick={onSubmit}
          disabled={busy}
          className={`px-3 py-2 bg-[var(--pixel-accent)] text-black text-[11px] font-bold uppercase border-b-2 border-[#0099cc] flex items-center gap-2 hover:brightness-110 active:translate-y-px transition disabled:opacity-40 ${focusRing}`}
        >
          <Film size={14} /> {busy ? '생성 중…' : '생성 시작'}
        </button>
        {onCancel ? (
          <button
            type="button"
            aria-label="생성 취소"
            data-testid="video-generation-cancel"
            onClick={onCancel}
            className={`px-3 py-2 bg-red-900/20 border-2 border-red-900/60 text-[11px] uppercase text-red-200 flex items-center gap-2 ${focusRing}`}
          >
            취소
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// ProviderSwitcher · CostPreview · Storyboard · Result · PolicyModal
// ────────────────────────────────────────────────────────────────────────────

function ProviderSwitcher({
  value,
  runtime,
  onChange,
}: {
  value: ProviderId;
  runtime?: VideoRuntime;
  onChange: (next: ProviderId) => void;
}): React.ReactElement {
  const providers: ProviderId[] = ['runway', 'pika', 'stability'];
  const enabledMap = new Map<string, boolean>();
  (runtime?.providers ?? []).forEach((p: VideoProvider) => enabledMap.set(p.id, p.isEnabled()));
  return (
    <fieldset
      aria-label="공급자 전환"
      data-testid="video-generation-provider-switcher"
      className="border-2 border-[var(--pixel-border)] bg-black/20 p-3"
    >
      <legend className="text-[10px] uppercase tracking-wider text-white/70 px-2">공급자</legend>
      <div role="radiogroup" aria-label="공급자 선택" className="flex flex-wrap gap-2">
        {providers.map((p) => {
          const enabled = enabledMap.get(p) ?? true;
          const selected = value === p;
          return (
            <label
              key={p}
              className={`flex items-center gap-2 px-3 py-1.5 border-2 text-[11px] uppercase cursor-pointer ${selected ? 'border-[var(--pixel-accent)] text-[var(--pixel-accent)]' : 'border-[var(--pixel-border)] text-white/70'} ${!enabled ? 'opacity-50' : ''}`}
            >
              <input
                type="radio"
                role="radio"
                name="video-provider"
                aria-checked={selected}
                checked={selected}
                onChange={() => onChange(p)}
                value={p}
              />
              {PROVIDER_LABEL[p]}
              <span className="text-white/50">${PROVIDER_COST_USD[p].toFixed(2)}/s</span>
              {!enabled ? <span className="text-amber-300">키 없음</span> : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function CostPreview({
  estimatedCostUsd,
  budgetUsd,
  overBudget,
}: {
  estimatedCostUsd: number;
  budgetUsd?: number;
  overBudget: boolean;
}): React.ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="video-generation-cost-preview"
      className={`border-2 px-3 py-2 text-[11px] flex items-center gap-2 ${overBudget ? 'border-amber-500/60 bg-amber-500/10 text-amber-200' : 'border-[var(--pixel-border)] bg-black/20 text-white/80'}`}
    >
      <Wand2 size={14} aria-hidden />
      <span>
        예상 비용 <strong>${estimatedCostUsd.toFixed(3)}</strong>
        {typeof budgetUsd === 'number' ? <> · 예산 한도 ${budgetUsd.toFixed(3)}</> : null}
      </span>
      {overBudget ? (
        <span aria-label="예산 초과 경고" className="ml-auto flex items-center gap-1">
          <AlertTriangle size={12} /> 예산 초과
        </span>
      ) : null}
    </div>
  );
}

function Storyboard({
  shots,
  onRecompose,
  onMoveShot,
  onEditShotPrompt,
  onRegenerateShot,
}: {
  shots: readonly Shot[];
  onRecompose: () => void;
  onMoveShot: (index: number, direction: -1 | 1) => void;
  onEditShotPrompt: (index: number, next: string) => void;
  onRegenerateShot: (index: number) => void;
}): React.ReactElement {
  return (
    <section aria-label="스토리보드 편집기" data-testid="video-generation-storyboard" className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] uppercase tracking-wider text-white/80">스토리보드</h3>
        <button
          type="button"
          aria-label="스토리보드 재생성"
          onClick={onRecompose}
          className={`px-2 py-1 bg-black/40 border-2 border-[var(--pixel-border)] text-[11px] uppercase text-white flex items-center gap-1 ${focusRing}`}
        >
          <RefreshCw size={12} /> 재분해
        </button>
      </header>
      {shots.length === 0 ? (
        <p className="text-[11px] text-white/50 italic">프롬프트를 입력하고 "재분해" 를 누르면 샷이 자동 생성됩니다.</p>
      ) : null}
      <ol className="flex flex-col gap-2" role="list">
        {shots.map((shot, i) => (
          <li
            key={shot.index}
            data-testid={`video-generation-shot-${i}`}
            className="border-2 border-[var(--pixel-border)] bg-black/20 p-3 flex items-start gap-2"
            draggable
            onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(i)); }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const from = Number(e.dataTransfer.getData('text/plain'));
              if (!Number.isInteger(from) || from === i) return;
              const direction: -1 | 1 = from < i ? 1 : -1;
              const steps = Math.abs(i - from);
              for (let s = 0; s < steps; s += 1) onMoveShot(from + s * direction, direction);
            }}
          >
            <GripVertical size={12} className="mt-1 text-white/40" aria-hidden />
            <div className="flex-1">
              <div className="flex items-center justify-between text-[10px] uppercase text-white/60 mb-1">
                <span>샷 {shot.index} · {shot.durationSec}초</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={`샷 ${shot.index} 위로`}
                    onClick={() => onMoveShot(i, -1)}
                    className={`px-1.5 py-0.5 text-[10px] bg-black/40 border border-[var(--pixel-border)] ${focusRing}`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`샷 ${shot.index} 아래로`}
                    onClick={() => onMoveShot(i, 1)}
                    className={`px-1.5 py-0.5 text-[10px] bg-black/40 border border-[var(--pixel-border)] ${focusRing}`}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`샷 ${shot.index} 재생성`}
                    onClick={() => onRegenerateShot(i)}
                    className={`px-1.5 py-0.5 text-[10px] bg-[var(--pixel-accent)] text-black border border-[#0099cc] ${focusRing}`}
                  >
                    재생성
                  </button>
                </div>
              </div>
              <textarea
                aria-label={`샷 ${shot.index} 프롬프트`}
                value={shot.prompt}
                onChange={(e) => onEditShotPrompt(i, e.target.value)}
                rows={2}
                className={`w-full bg-black/30 border border-[var(--pixel-border)] px-2 py-1 text-[11px] text-white font-mono ${focusRing}`}
              />
            </div>
            <div
              aria-hidden
              className="w-16 h-16 border border-white/20 bg-gradient-to-br from-cyan-900/30 to-purple-900/30 text-[9px] text-white/60 flex items-center justify-center"
              title={`샷 ${shot.index} 썸네일(placeholder)`}
            >
              썸네일
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function JobQueueTimeline({ jobs }: { jobs: readonly { id: string; kind: string; title: string; status: string; progress: number; phase?: string }[] }): React.ReactElement | null {
  const videoJobs = jobs.filter((j) => j.kind === 'video');
  if (videoJobs.length === 0) return null;
  return (
    <section aria-label="영상 작업 대기열" data-testid="video-generation-queue" className="border-2 border-[var(--pixel-border)] bg-black/20 p-3 mt-2">
      <h3 className="text-[11px] uppercase tracking-wider text-white/80 mb-2">작업 대기열 ({videoJobs.length})</h3>
      <ul className="flex flex-col gap-1" role="list">
        {videoJobs.slice(-6).map((j) => (
          <li key={j.id} className="flex items-center gap-2 text-[11px]" data-testid={`video-generation-queue-item-${j.id}`}>
            <span className="text-white/50 font-mono">{j.id.slice(-6)}</span>
            <span className="flex-1 truncate" title={j.title}>{j.title}</span>
            <span className="text-white/60">{j.phase ?? j.status}</span>
            <span className="text-white/80 font-mono w-12 text-right">{Math.round(j.progress * 100)}%</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function VideoResult({
  job,
  watermark,
  metadataOpen,
  onToggleMetadata,
}: {
  job: VideoJob;
  watermark: string;
  metadataOpen: boolean;
  onToggleMetadata: () => void;
}): React.ReactElement {
  const copyShareLink = async () => {
    if (!job.resultUrl) return;
    try { await navigator.clipboard?.writeText(job.resultUrl); } catch { /* ignore */ }
  };
  return (
    <section aria-label="영상 결과" data-testid="video-generation-result" className="flex flex-col gap-2">
      <div className="aspect-video w-full bg-black/60 border-2 border-[var(--pixel-border)] flex items-center justify-center relative">
        {job.resultUrl ? (
          <video controls src={job.resultUrl} className="w-full h-full" aria-label="생성된 영상" />
        ) : (
          <span className="text-white/50 text-[12px]">프리뷰 준비 중</span>
        )}
        {watermark.trim() ? (
          <span
            aria-hidden
            className="absolute bottom-2 right-2 text-[10px] font-mono text-white/70 bg-black/40 px-1 py-0.5"
          >
            {watermark}
          </span>
        ) : null}
      </div>
      <div className="flex gap-2">
        <a
          href={job.resultUrl}
          download
          aria-label="영상 다운로드"
          data-testid="video-generation-download"
          className={`px-3 py-1.5 bg-[var(--pixel-accent)] text-black text-[11px] font-bold uppercase border-b-2 border-[#0099cc] flex items-center gap-1 ${focusRing}`}
        >
          <Download size={12} /> 다운로드
        </a>
        <button
          type="button"
          aria-label="공유 링크 복사"
          onClick={copyShareLink}
          className={`px-3 py-1.5 bg-black/40 border-2 border-[var(--pixel-border)] text-[11px] uppercase text-white flex items-center gap-1 ${focusRing}`}
        >
          <Share2 size={12} /> 공유
        </button>
        <button
          type="button"
          aria-label="메타데이터 토글"
          aria-expanded={metadataOpen}
          onClick={onToggleMetadata}
          className={`px-3 py-1.5 bg-black/40 border-2 border-[var(--pixel-border)] text-[11px] uppercase text-white flex items-center gap-1 ml-auto ${focusRing}`}
        >
          <Copy size={12} /> 메타데이터
        </button>
      </div>
      {metadataOpen ? (
        <pre data-testid="video-generation-metadata" className="bg-black/40 border border-[var(--pixel-border)] p-2 text-[10px] text-white/80 font-mono whitespace-pre-wrap">
{JSON.stringify({
  id: job.id,
  provider: job.provider,
  status: job.status,
  costEstimate: job.costEstimate,
  metadata: job.metadata,
}, null, 2)}
        </pre>
      ) : null}
    </section>
  );
}

function PolicyBlockedModal({
  flags,
  message,
  onClose,
  onFix,
}: {
  flags: readonly string[];
  message: string;
  onClose: () => void;
  onFix: () => void;
}): React.ReactElement {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="video-policy-title"
      data-testid="video-generation-policy-modal"
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
    >
      <div className="max-w-md bg-[var(--pixel-card,#16213e)] border-2 border-amber-500/70 p-4 flex flex-col gap-3">
        <header className="flex items-center gap-2">
          <Shield size={16} className="text-amber-300" aria-hidden />
          <h3 id="video-policy-title" className="text-sm font-bold uppercase text-amber-200">컨텐츠 정책 차단</h3>
        </header>
        <p className="text-[12px] text-white/90">{message}</p>
        {flags.length > 0 ? (
          <ul className="text-[11px] text-amber-200 list-disc pl-4">
            {flags.map((f) => <li key={f}>{f}</li>)}
          </ul>
        ) : null}
        <p className="text-[11px] text-white/70">
          프롬프트를 수정해 제출하면 다시 시도할 수 있어요. 지속적으로 차단되면 팀 관리자에게 문의하세요.
        </p>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className={`px-3 py-1.5 bg-black/40 border-2 border-[var(--pixel-border)] text-[11px] uppercase text-white ${focusRing}`}
          >
            닫기
          </button>
          <button
            type="button"
            onClick={onFix}
            aria-label="프롬프트 수정"
            data-testid="video-generation-policy-fix"
            className={`px-3 py-1.5 bg-[var(--pixel-accent)] text-black text-[11px] font-bold uppercase border-b-2 border-[#0099cc] ${focusRing}`}
          >
            프롬프트 수정
          </button>
        </div>
      </div>
    </div>
  );
}

function ErrorRecoveryPanel({
  videoCode,
  onFixPrompt,
  onLowerBudget,
  onSwitchProvider,
  onRetry,
}: {
  videoCode: string;
  onFixPrompt: () => void;
  onLowerBudget: () => void;
  onSwitchProvider: () => void;
  onRetry: () => void;
}): React.ReactElement {
  return (
    <div
      role="alert"
      data-testid="video-generation-error-recovery"
      className="border-2 border-red-500/60 bg-red-900/20 text-red-100 p-3 text-[11px] mt-2 flex flex-col gap-2"
    >
      <header className="flex items-center gap-2 font-bold">
        <FlaskConical size={14} /> 복구 제안 — {videoCode}
      </header>
      {videoCode === 'VIDEO_QUOTA_EXCEEDED' ? (
        <p>예산 또는 공급자 쿼터를 초과했어요. 길이를 줄이거나 다른 공급자로 전환해 보세요.</p>
      ) : null}
      {videoCode === 'VIDEO_PROVIDER_ERROR' ? (
        <p>공급자 요청이 실패했어요. 다른 공급자로 전환 후 재시도하세요.</p>
      ) : null}
      {videoCode === 'VIDEO_RENDER_ERROR' ? (
        <p>렌더 단계에서 실패했어요. 프롬프트를 단순화하거나 잠시 후 다시 시도해 주세요.</p>
      ) : null}
      {videoCode === 'VIDEO_POLICY_BLOCKED' ? (
        <p>컨텐츠 정책 위반 소지가 감지됐어요. 프롬프트를 수정해 제출해 주세요.</p>
      ) : null}
      <div className="flex gap-2 flex-wrap">
        {videoCode === 'VIDEO_QUOTA_EXCEEDED' ? (
          <button type="button" onClick={onLowerBudget} className={`px-2 py-1 bg-black/40 border border-[var(--pixel-border)] text-[11px] ${focusRing}`}>
            길이 -2초
          </button>
        ) : null}
        {['VIDEO_QUOTA_EXCEEDED', 'VIDEO_PROVIDER_ERROR'].includes(videoCode) ? (
          <button type="button" onClick={onSwitchProvider} className={`px-2 py-1 bg-black/40 border border-[var(--pixel-border)] text-[11px] ${focusRing}`}>
            공급자 전환
          </button>
        ) : null}
        {videoCode === 'VIDEO_POLICY_BLOCKED' ? (
          <button type="button" onClick={onFixPrompt} className={`px-2 py-1 bg-black/40 border border-[var(--pixel-border)] text-[11px] ${focusRing}`}>
            프롬프트 수정
          </button>
        ) : null}
        <button type="button" onClick={onRetry} className={`px-2 py-1 bg-[var(--pixel-accent)] text-black text-[11px] ${focusRing}`}>
          <Trash2 size={10} className="inline-block mr-1" /> 오류 비우고 재시도
        </button>
      </div>
    </div>
  );
}
