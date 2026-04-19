// 지시 #97bdee2b · multimedia-ui-spec.md §8.1 — 초안 복원 배지.
//
// 새로고침 직후 `draftStore.load(conversationId)` 에 값이 있으면, 본 배지가 입력 영역
// 상단에 한 번 노출된다. 스펙의 핵심 계약(M-07):
//   1) 자동 전송 금지 — 사용자가 [전송] 버튼을 명시적으로 눌러야 한다.
//   2) 3초 후 페이드 — 호버 중이면 타이머 일시정지.
//   3) `prefers-reduced-motion: reduce` 면 페이드 대신 즉시 소거.
//   4) `role="status" aria-live="polite"` — 한 번만 발화.
//
// 타이머/모션은 상태 4종(`visible` · `paused` · `fading` · `hidden`) 을 단일 `useEffect`
// 로 조율한다. DOM 에서 완전히 제거되기 전까지 이전 페이드 애니메이션이 끝나기를 기다려
// 포커스 흐름을 끊지 않는다.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, Send, Trash2 } from 'lucide-react';

export interface MediaDraftRestoreBadgeProps {
  /** 초안 요약 라벨. 예: "hero.mp4 · 12KB 텍스트". */
  label: string;
  /** [전송] — 사용자가 명시적으로 초안 전송을 확정한 순간만 호출(M-07). */
  onSend: () => void;
  /** [지우기] — draftStore.remove(conversationId) 트리거. */
  onDismiss: () => void;
  /** 기본 3000ms. 테스트에서 단축 주입 가능. */
  fadeOutDelayMs?: number;
  /** 기본 `window.matchMedia('(prefers-reduced-motion: reduce)')`. SSR/테스트 주입용. */
  prefersReducedMotion?: boolean;
}

type BadgeState = 'visible' | 'paused' | 'fading' | 'hidden';

const DEFAULT_FADE_DELAY_MS = 3000;
const FADE_DURATION_MS = 180;

function detectPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function MediaDraftRestoreBadge(props: MediaDraftRestoreBadgeProps): React.ReactElement | null {
  const {
    label,
    onSend,
    onDismiss,
    fadeOutDelayMs = DEFAULT_FADE_DELAY_MS,
    prefersReducedMotion,
  } = props;

  const reduce = prefersReducedMotion ?? detectPrefersReducedMotion();
  const [state, setState] = useState<BadgeState>('visible');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (state !== 'visible') return;
    if (reduce) {
      timerRef.current = setTimeout(() => setState('hidden'), fadeOutDelayMs);
    } else {
      timerRef.current = setTimeout(() => setState('fading'), fadeOutDelayMs);
    }
    return clearTimer;
  }, [state, fadeOutDelayMs, reduce, clearTimer]);

  useEffect(() => {
    if (state !== 'fading') return;
    timerRef.current = setTimeout(() => setState('hidden'), FADE_DURATION_MS);
    return clearTimer;
  }, [state, clearTimer]);

  const handleMouseEnter = useCallback(() => {
    if (state === 'visible' || state === 'fading') {
      clearTimer();
      setState('paused');
    }
  }, [state, clearTimer]);

  const handleMouseLeave = useCallback(() => {
    if (state === 'paused') setState('visible');
  }, [state]);

  const handleSend = useCallback(() => {
    clearTimer();
    setState('hidden');
    onSend();
  }, [clearTimer, onSend]);

  const handleDismiss = useCallback(() => {
    clearTimer();
    setState('hidden');
    onDismiss();
  }, [clearTimer, onDismiss]);

  if (state === 'hidden') return null;

  const isFading = state === 'fading';

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="media-draft-restore-badge"
      data-state={state}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleMouseEnter}
      onBlur={handleMouseLeave}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 8px',
        fontSize: 12,
        background: 'var(--media-draft-badge-bg)',
        color: 'var(--media-draft-badge-fg)',
        border: '1px solid var(--shared-goal-modal-confirm-bg)',
        borderRadius: 4,
        opacity: isFading ? 0 : 1,
        transition: reduce ? 'none' : `opacity ${FADE_DURATION_MS}ms ease`,
      }}
    >
      <Sparkles size={12} aria-hidden={true} />
      <span data-testid="media-draft-restore-badge-label">불러온 초안 · {label}</span>
      <button
        type="button"
        data-testid="media-draft-restore-badge-send"
        onClick={handleSend}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          background: 'var(--shared-goal-modal-confirm-bg)',
          color: 'var(--shared-goal-modal-confirm-fg)',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        <Send size={10} aria-hidden={true} /> 전송
      </button>
      <button
        type="button"
        data-testid="media-draft-restore-badge-dismiss"
        onClick={handleDismiss}
        aria-label="초안 지우기"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          fontSize: 11,
          background: 'transparent',
          color: 'var(--media-draft-badge-fg)',
          border: '1px solid var(--shared-goal-modal-confirm-bg)',
          cursor: 'pointer',
        }}
      >
        <Trash2 size={10} aria-hidden={true} /> 지우기
      </button>
    </div>
  );
}

export default MediaDraftRestoreBadge;
