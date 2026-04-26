/**
 * 로그인 화면.
 * - ON_PREMISE=true: username/password 폼
 * - ON_PREMISE=false: GitHub/GitLab OAuth 버튼으로 리디렉트
 * - DEV_MODE=true: 상위 AuthGate 에서 자동 우회되므로 이 화면은 표시되지 않음.
 */

import React, { useState } from 'react';
import { useI18n } from '../i18n';
import { LanguageToggle } from '../ui/LanguageToggle';

export interface LoginFormProps {
  onPremise: boolean;
  provider: 'github' | 'gitlab';
  onSubmit: (username: string, password: string) => Promise<void>;
  onOAuth: () => void;
  onSwitchToSignup: () => void;
  error?: string | null;
}

export function LoginForm({ onPremise, provider, onSubmit, onOAuth, onSwitchToSignup, error }: LoginFormProps) {
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = username.trim();
    if (!trimmed || !password || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmed, password);
    } finally {
      setSubmitting(false);
    }
  };

  const detectCapsLock = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (typeof e.getModifierState === 'function') {
      setCapsLockOn(e.getModifierState('CapsLock'));
    }
  };

  const providerLabel = provider === 'gitlab' ? 'GitLab' : 'GitHub';
  const canSubmit = username.trim().length > 0 && password.length > 0 && !submitting;
  const errorId = 'login-error';
  const capsLockId = 'login-capslock';

  return (
    <div
      className="auth-card"
      style={{
        maxWidth: 360,
        margin: '64px auto',
        padding: '28px 24px',
        background: 'var(--pixel-card)',
        border: '2px solid var(--pixel-border)',
        borderRadius: 8,
        boxShadow: '0 0 0 4px rgba(0, 210, 255, 0.08)',
        fontFamily: 'var(--font-game)',
        color: 'var(--pixel-white)',
      }}
    >
      {/* 지시 #75cac73a — 로그인 전에도 언어를 전환할 수 있도록 토글을 카드 상단에 배치.
          토글 클릭 → setLocale(전역) → useI18n 구독자(현 컴포넌트 포함) 즉시 재렌더. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <LanguageToggle />
      </div>
      <header style={{ marginBottom: 20, textAlign: 'center' }}>
        <div style={{ fontSize: 12, letterSpacing: 2, color: 'var(--pixel-accent)' }}>{t('auth.brand')}</div>
        <h1 style={{ margin: '6px 0 0', fontSize: 22 }}>{t('auth.login.title')}</h1>
      </header>

      {error && (
        <div
          id={errorId}
          className="auth-error"
          role="alert"
          style={{
            marginBottom: 16,
            padding: '10px 12px',
            background: 'rgba(233, 69, 96, 0.15)',
            border: '1px solid var(--pixel-text)',
            color: 'var(--pixel-text)',
            borderRadius: 4,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {onPremise ? (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            <span style={{ color: 'var(--pixel-accent)' }}>{t('auth.login.username')}</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
              disabled={submitting}
              aria-describedby={error ? errorId : undefined}
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            <span style={{ color: 'var(--pixel-accent)' }}>{t('auth.login.password')}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={detectCapsLock}
              onKeyUp={detectCapsLock}
              onBlur={() => setCapsLockOn(false)}
              autoComplete="current-password"
              required
              disabled={submitting}
              aria-describedby={[error ? errorId : null, capsLockOn ? capsLockId : null].filter(Boolean).join(' ') || undefined}
              style={inputStyle}
            />
            {capsLockOn && (
              <span id={capsLockId} role="status" style={{ fontSize: 11, color: 'var(--pixel-text)' }}>
                {t('auth.login.capsLockWarning')}
              </span>
            )}
          </label>
          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              ...primaryButton,
              opacity: canSubmit ? 1 : 0.5,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            {submitting ? t('auth.login.submitting') : t('auth.login.submit')}
          </button>
          <button type="button" className="link" onClick={onSwitchToSignup} style={linkButton}>
            {t('auth.login.switchToSignup')}
          </button>
        </form>
      ) : (
        <div className="oauth-panel" style={{ display: 'flex', flexDirection: 'column', gap: 14, textAlign: 'center' }}>
          <p style={{ margin: 0, fontSize: 13, color: '#b8b8d1' }}>
            {t('auth.login.oauthIntro').replace('{provider}', providerLabel)}
          </p>
          <button type="button" onClick={onOAuth} style={primaryButton}>
            {t('auth.login.oauthCta').replace('{provider}', providerLabel)}
          </button>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 4,
  color: 'var(--pixel-white)',
  fontFamily: 'var(--font-game)',
  fontSize: 14,
  outline: 'none',
};

const primaryButton: React.CSSProperties = {
  padding: '10px 14px',
  background: 'var(--pixel-accent)',
  border: '2px solid var(--pixel-white)',
  borderRadius: 4,
  color: 'var(--pixel-bg)',
  fontFamily: 'var(--font-game)',
  fontSize: 14,
  fontWeight: 'bold',
  letterSpacing: 1,
  cursor: 'pointer',
};

const linkButton: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--pixel-accent)',
  fontFamily: 'var(--font-game)',
  fontSize: 12,
  textDecoration: 'underline',
  cursor: 'pointer',
  padding: 0,
};
