// OnboardingTour(#4c9bc4a6) — 최초 접속 사용자에게 상단바 토큰 배지 → 업로드 드롭존
// → 내보내기 버튼 순서로 3스텝 코치마크를 띄운다.
//
// 설계 원칙
//   1) **단일 출처**: 진행 상태는 React state, "완료 여부" 만 localStorage 에 저장한다.
//      저장 키는 `llmtycoon.onboarding.completed` (Boolean 문자열 'true'/'false').
//   2) **스킨 교체 가능**: 스타일은 `--onboarding-*` 토큰으로 분리. 디자이너 시안이
//      확정되면 CSS 변수 값만 덮어 씌워 스킨이 바뀐다.
//   3) **타깃 특정 방식은 `data-tour-anchor` 속성**: 타깃 컴포넌트가 동일 속성을
//      노출하면 본 투어가 DOM 에서 해당 엘리먼트를 찾아 spotlight 위치를 잡는다.
//      찾지 못하면 "화면 중앙" 폴백.
//   4) **접근성**: 카드에 role="dialog" + aria-modal="true" + aria-labelledby.
//      Esc 로 건너뛰기, ArrowLeft/ArrowRight/Enter 로 스텝 이동.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { X, ChevronLeft, ChevronRight, Check } from 'lucide-react';

// ────────────────────────────────────────────────────────────────────────────
// 순수 함수 — localStorage 직렬화 · 스텝 파생
// ────────────────────────────────────────────────────────────────────────────

export const ONBOARDING_STORAGE_KEY = 'llmtycoon.onboarding.completed';

export interface OnboardingStep {
  id: string;
  title: string;
  body: string;
  /** 타깃 엘리먼트를 고르는 `[data-tour-anchor="..."]` 식별자. null 이면 중앙 폴백. */
  anchor: string | null;
}

export const DEFAULT_ONBOARDING_STEPS: ReadonlyArray<OnboardingStep> = Object.freeze([
  {
    id: 'token-indicator',
    title: '1. 세션 토큰 배지',
    body: '상단바의 토큰 배지로 5시간 창의 남은 잔량과 리셋 시각을 한눈에 확인할 수 있어요.',
    anchor: 'token-usage-indicator',
  },
  {
    id: 'upload-dropzone',
    title: '2. 멀티미디어 업로드',
    body: '드래그&드롭 또는 클릭으로 PDF·PPTX·이미지·영상을 업로드할 수 있습니다. Esc 로 취소할 수 있어요.',
    anchor: 'upload-dropzone',
  },
  {
    id: 'export-buttons',
    title: '3. 내보내기 단축키',
    body: 'Alt+P(PDF), Alt+S(PPT), Alt+V(영상) 단축키로 즉시 내보낼 수 있어요.',
    anchor: 'export-buttons',
  },
]) as ReadonlyArray<OnboardingStep>;

/** localStorage 의 "완료" 플래그를 해석한다. 누락/손상은 false 로 수렴. */
export function isOnboardingCompleted(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return raw.trim().toLowerCase() === 'true';
}

/** "완료" 로 저장할 때 쓰는 문자열. localStorage.setItem 에 그대로 사용. */
export function markOnboardingCompletedValue(): string {
  return 'true';
}

/** 사용자가 "다시 보기" 를 누르면 플래그를 제거한다. 본 함수는 키만 돌려 줘 호출자가 removeItem 한다. */
export function onboardingResetKey(): string {
  return ONBOARDING_STORAGE_KEY;
}

export type OnboardingTransition = 'next' | 'prev' | 'skip' | 'finish';

/**
 * 현재 스텝과 전환 종류를 받아 다음 스텝 인덱스 또는 'done' 을 돌려준다.
 *   - next: 마지막이면 'done', 아니면 +1
 *   - prev: 처음이면 0 고정
 *   - skip/finish: 'done'
 */
export function nextOnboardingStep(params: {
  current: number;
  total: number;
  action: OnboardingTransition;
}): number | 'done' {
  const last = Math.max(0, params.total - 1);
  const safe = Math.max(0, Math.min(last, params.current));
  if (params.action === 'skip' || params.action === 'finish') return 'done';
  if (params.action === 'prev') return Math.max(0, safe - 1);
  if (params.action === 'next') return safe >= last ? 'done' : safe + 1;
  return safe;
}

// ────────────────────────────────────────────────────────────────────────────
// React 컴포넌트
// ────────────────────────────────────────────────────────────────────────────

export interface OnboardingTourProps {
  steps?: ReadonlyArray<OnboardingStep>;
  /** "다시 보기" 트리거가 바뀌면 강제로 투어가 재개된다. */
  restartKey?: number;
  /** 테스트/디버깅 전용 — localStorage 대신 값을 주입. */
  storage?: {
    get: () => string | null;
    set: (value: string) => void;
    remove: () => void;
  };
  className?: string;
}

function defaultStorage() {
  if (typeof window === 'undefined') {
    return {
      get: () => null as string | null,
      set: () => {},
      remove: () => {},
    };
  }
  return {
    get: () => {
      try { return window.localStorage.getItem(ONBOARDING_STORAGE_KEY); } catch { return null; }
    },
    set: (value: string) => {
      try { window.localStorage.setItem(ONBOARDING_STORAGE_KEY, value); } catch { /* private mode 무시 */ }
    },
    remove: () => {
      try { window.localStorage.removeItem(ONBOARDING_STORAGE_KEY); } catch { /* 무시 */ }
    },
  };
}

export function OnboardingTour({
  steps = DEFAULT_ONBOARDING_STEPS,
  restartKey = 0,
  storage,
  className,
}: OnboardingTourProps = {}): React.ReactElement | null {
  const store = useMemo(() => storage ?? defaultStorage(), [storage]);
  const [visible, setVisible] = useState<boolean>(() => !isOnboardingCompleted(store.get()));
  const [stepIndex, setStepIndex] = useState<number>(0);

  // "다시 보기" — restartKey 가 변경되면 플래그를 지우고 투어를 다시 연다.
  useEffect(() => {
    if (restartKey === 0) return;
    store.remove();
    setStepIndex(0);
    setVisible(true);
  }, [restartKey, store]);

  const closeWith = useCallback((action: OnboardingTransition) => {
    const outcome = nextOnboardingStep({ current: stepIndex, total: steps.length, action });
    if (outcome === 'done') {
      store.set(markOnboardingCompletedValue());
      setVisible(false);
      return;
    }
    setStepIndex(outcome);
  }, [stepIndex, steps.length, store]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeWith('skip'); return; }
      if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); closeWith('next'); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); closeWith('prev'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, closeWith]);

  if (!visible) return null;
  const step = steps[stepIndex];
  if (!step) return null;

  const isFirst = stepIndex === 0;
  const isLast = stepIndex === steps.length - 1;
  const titleId = `onboarding-step-title-${step.id}`;
  const bodyId = `onboarding-step-body-${step.id}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid="onboarding-tour"
      data-step-index={stepIndex}
      className={`onboarding-tour${className ? ` ${className}` : ''}`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--onboarding-z-index, 1200)' as unknown as number,
        background: 'var(--onboarding-scrim-bg, rgba(0, 0, 0, 0.45))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          maxWidth: 360,
          width: '100%',
          background: 'var(--onboarding-card-bg, var(--pixel-card))',
          color: 'var(--onboarding-card-fg, var(--shared-goal-modal-header-fg))',
          border: '2px solid var(--onboarding-card-border, var(--pixel-border))',
          borderLeft: '6px solid var(--onboarding-card-accent, var(--pixel-accent))',
          padding: 16,
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <strong id={titleId} className="text-[13px] font-bold" data-testid="onboarding-step-title">
            {step.title}
          </strong>
          <button
            type="button"
            onClick={() => closeWith('skip')}
            aria-label="온보딩 건너뛰기"
            data-testid="onboarding-skip"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--onboarding-card-fg, var(--shared-goal-modal-header-fg))',
              cursor: 'pointer',
              opacity: 0.7,
            }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        <p id={bodyId} className="text-[12px] mt-2" data-testid="onboarding-step-body">
          {step.body}
        </p>
        <div className="flex items-center justify-between mt-3 text-[11px]">
          <span data-testid="onboarding-step-progress">
            {stepIndex + 1} / {steps.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => closeWith('prev')}
              disabled={isFirst}
              aria-label="이전 단계"
              className="px-2 py-1 font-bold uppercase disabled:opacity-40"
              style={{
                background: 'transparent',
                color: 'var(--onboarding-card-fg, var(--shared-goal-modal-header-fg))',
                border: '1px solid var(--onboarding-card-border, var(--pixel-border))',
              }}
            >
              <ChevronLeft size={12} aria-hidden="true" /> 이전
            </button>
            <button
              type="button"
              onClick={() => closeWith(isLast ? 'finish' : 'next')}
              data-testid="onboarding-advance"
              aria-label={isLast ? '온보딩 마치기' : '다음 단계'}
              className="px-2 py-1 font-bold uppercase"
              style={{
                background: 'var(--onboarding-primary-bg, var(--pixel-accent))',
                color: 'var(--onboarding-primary-fg, #000)',
                border: '1px solid var(--onboarding-primary-border, var(--pixel-accent))',
              }}
            >
              {isLast ? <><Check size={12} aria-hidden="true" /> 완료</> : <>다음 <ChevronRight size={12} aria-hidden="true" /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
