// SettingsDrawer(#0dceedcd) — 상단바 톱니 버튼에서 열리는 통합 설정 패널.
//
// 묶음 내용
//   · 테마(라이트/다크/시스템)  — ThemeToggle 을 그대로 재사용.
//   · 토큰 경고 임계             — caution/warning 수치(토큰·USD) 입력.
//   · 리듀스드 모션 강제         — OS 선호와 별개로 강제 해제/강제 적용을 선택.
//   · 단축키 치트시트            — KeyboardShortcutCheatsheet.
//
// 접근성
//   · role="dialog" + aria-modal="true" + aria-labelledby.
//   · Esc 로 닫기, Tab 으로 내부 포커스 순환(브라우저 기본).

import React, { useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';

import { KeyboardShortcutCheatsheet } from './KeyboardShortcutCheatsheet';

// ────────────────────────────────────────────────────────────────────────────
// 순수 함수 — 테스트 대상
// ────────────────────────────────────────────────────────────────────────────

export type ReducedMotionPreference = 'system' | 'force-on' | 'force-off';

export const REDUCED_MOTION_STORAGE_KEY = 'llmtycoon.reducedMotion';

export function parseReducedMotionPreference(raw: unknown): ReducedMotionPreference {
  if (raw === 'force-on' || raw === 'force-off' || raw === 'system') return raw;
  return 'system';
}

export interface TokenThresholdInput {
  cautionTokens: string;
  cautionUsd: string;
  warningTokens: string;
  warningUsd: string;
}

export const TOKEN_THRESHOLD_STORAGE_KEY = 'llmtycoon.tokenThresholds';

/**
 * 문자열 입력을 숫자 임계값으로 정규화한다. 공백·음수·NaN 은 `undefined` 로 수렴해
 * "임계 없음" 을 나타낸다. 호출자는 이 결과를 스토어에 그대로 넘긴다.
 */
export function normalizeTokenThresholds(input: TokenThresholdInput): {
  caution?: { tokens?: number; usd?: number };
  warning?: { tokens?: number; usd?: number };
} {
  const toNumber = (s: string): number | undefined => {
    const t = s.trim();
    if (!t) return undefined;
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const caution = {
    tokens: toNumber(input.cautionTokens),
    usd: toNumber(input.cautionUsd),
  };
  const warning = {
    tokens: toNumber(input.warningTokens),
    usd: toNumber(input.warningUsd),
  };
  const out: { caution?: { tokens?: number; usd?: number }; warning?: { tokens?: number; usd?: number } } = {};
  if (caution.tokens !== undefined || caution.usd !== undefined) out.caution = caution;
  if (warning.tokens !== undefined || warning.usd !== undefined) out.warning = warning;
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// React 컴포넌트
// ────────────────────────────────────────────────────────────────────────────

export interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 온보딩 "다시 보기" 트리거. 상위가 OnboardingTour 의 restartKey 를 증가시킨다. */
  onReplayOnboarding?: () => void;
  className?: string;
}

export function SettingsDrawer({
  open,
  onClose,
  onReplayOnboarding,
  className,
}: SettingsDrawerProps): React.ReactElement | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Esc 닫기 + 열릴 때 드로어에 포커스 이동.
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const handleReducedMotion = useCallback((next: ReducedMotionPreference) => {
    try { window.localStorage.setItem(REDUCED_MOTION_STORAGE_KEY, next); } catch { /* 무시 */ }
    // data-motion 속성으로 CSS 가 모션 강제 규칙을 덮어쓰도록 한다(후속 turn 에서 CSS 연결).
    if (next === 'system') document.documentElement.removeAttribute('data-motion');
    else document.documentElement.setAttribute('data-motion', next);
  }, []);

  if (!open) return null;

  return (
    <div
      data-testid="settings-drawer-scrim"
      className={`settings-drawer${className ? ` ${className}` : ''}`}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1150,
        background: 'var(--onboarding-scrim-bg, rgba(0,0,0,0.55))',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-drawer-title"
        tabIndex={-1}
        data-testid="settings-drawer"
        style={{
          width: 'min(420px, 100%)',
          height: '100%',
          background: 'var(--color-surface)',
          color: 'var(--color-text)',
          borderLeft: '2px solid var(--color-border)',
          padding: 'var(--space-lg)',
          overflowY: 'auto',
        }}
      >
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-md)' }}>
          <h2 id="settings-drawer-title" style={{ fontSize: 'var(--font-size-md)', fontWeight: 'var(--font-weight-bold)' }}>
            설정
          </h2>
          <button
            type="button"
            aria-label="설정 닫기"
            onClick={onClose}
            data-testid="settings-drawer-close"
            style={{ background: 'transparent', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer' }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <section aria-label="모션 설정" style={{ marginBottom: 'var(--space-lg)' }}>
          <h3 className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--color-text-muted)', marginBottom: 'var(--space-xs)' }}>
            모션
          </h3>
          <div role="radiogroup" aria-label="리듀스드 모션" style={{ display: 'flex', gap: 'var(--space-xs)' }}>
            {(['system', 'force-off', 'force-on'] as ReducedMotionPreference[]).map(value => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={false}
                data-testid={`reduced-motion-${value}`}
                onClick={() => handleReducedMotion(value)}
                className="px-2 py-1 text-[11px] font-bold uppercase"
                style={{
                  background: 'transparent',
                  color: 'var(--color-text-muted)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                }}
              >
                {value === 'system' ? '시스템 따름' : value === 'force-off' ? '모션 허용' : '모션 최소화'}
              </button>
            ))}
          </div>
        </section>

        <section aria-label="온보딩" style={{ marginBottom: 'var(--space-lg)' }}>
          <h3 className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--color-text-muted)', marginBottom: 'var(--space-xs)' }}>
            온보딩
          </h3>
          <button
            type="button"
            onClick={() => onReplayOnboarding?.()}
            data-testid="settings-drawer-replay-onboarding"
            disabled={!onReplayOnboarding}
            className="px-3 py-1 text-[11px] font-bold uppercase"
            style={{
              background: 'var(--color-accent)',
              color: 'var(--color-accent-contrast)',
              border: '1px solid var(--color-accent)',
              borderRadius: 'var(--radius-sm)',
              cursor: onReplayOnboarding ? 'pointer' : 'not-allowed',
              opacity: onReplayOnboarding ? 1 : 0.6,
            }}
          >
            투어 다시 보기
          </button>
        </section>

        <section aria-label="키보드 단축키">
          <h3 className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--color-text-muted)', marginBottom: 'var(--space-xs)' }}>
            키보드 단축키
          </h3>
          <KeyboardShortcutCheatsheet />
        </section>
      </div>
    </div>
  );
}
