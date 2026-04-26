/**
 * 회원가입 화면.
 * - ON_PREMISE=true: username/email/password 폼을 /api/auth/signup 으로 전송
 * - ON_PREMISE=false: OAuth 로 이동 (최초 로그인 시 자동 가입)
 */

import React, { useState } from 'react';
import { useI18n } from '../i18n';
import { LanguageToggle } from '../ui/LanguageToggle';

export interface SignupFormProps {
  onPremise: boolean;
  provider: 'github' | 'gitlab';
  onSubmit: (username: string, password: string, email: string) => Promise<void>;
  onOAuth: () => void;
  onSwitchToLogin: () => void;
  error?: string | null;
}

export function SignupForm({ onPremise, provider, onSubmit, onOAuth, onSwitchToLogin, error }: SignupFormProps) {
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const normalizedUsername = username.trim();
  const normalizedEmail = email.trim().toLowerCase();

  const pwHasLength = password.length >= 8;
  const pwHasLetter = /[A-Za-z]/.test(password);
  const pwHasDigit = /[0-9]/.test(password);
  const pwMatches = password.length > 0 && password === passwordConfirm;
  const providerLabel = provider === 'gitlab' ? 'GitLab' : 'GitHub';

  const validate = (): string | null => {
    if (normalizedUsername.length < 3) return t('auth.signup.errors.usernameTooShort');
    if (!/^[a-zA-Z0-9._-]+$/.test(normalizedUsername)) return t('auth.signup.errors.usernameCharset');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return t('auth.signup.errors.emailInvalid');
    if (!pwHasLength) return t('auth.signup.errors.passwordTooShort');
    if (!pwHasLetter || !pwHasDigit) return t('auth.signup.errors.passwordCharset');
    if (!pwMatches) return t('auth.signup.errors.passwordMismatch');
    return null;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const msg = validate();
    if (msg) {
      setLocalError(msg);
      return;
    }
    setLocalError(null);
    setSubmitting(true);
    try {
      await onSubmit(normalizedUsername, password, normalizedEmail);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-card">
      {/* 지시 #75cac73a — 회원가입 화면 자체에서도 언어 전환 가능하도록 토글 노출. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <LanguageToggle />
      </div>
      <h1>{t('auth.signup.title')}</h1>
      {(localError || error) && (
        <div className="auth-error" role="alert" aria-live="polite">
          {localError || error}
        </div>
      )}
      {onPremise ? (
        <form onSubmit={submit} noValidate aria-busy={submitting}>
          <label>
            {t('auth.signup.username')}
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              minLength={3}
              required
              disabled={submitting}
            />
          </label>
          <label>
            {t('auth.signup.email')}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              disabled={submitting}
            />
          </label>
          <label>
            {t('auth.signup.password')}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
              disabled={submitting}
              aria-describedby="signup-pw-hint"
            />
          </label>
          {password.length > 0 && (
            <ul id="signup-pw-hint" className="auth-hint" aria-live="polite">
              <li data-ok={pwHasLength}>{t('auth.signup.passwordHint.minLength')}</li>
              <li data-ok={pwHasLetter && pwHasDigit}>{t('auth.signup.passwordHint.letterAndDigit')}</li>
            </ul>
          )}
          <label>
            {t('auth.signup.passwordConfirm')}
            <input
              type="password"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
              disabled={submitting}
              aria-describedby="signup-pw-match"
            />
          </label>
          {passwordConfirm.length > 0 && (
            <p id="signup-pw-match" className="auth-hint" data-ok={pwMatches} aria-live="polite">
              {pwMatches ? t('auth.signup.passwordMatch') : t('auth.signup.passwordMismatch')}
            </p>
          )}
          <button type="submit" disabled={submitting}>
            {submitting ? t('auth.signup.submitting') : t('auth.signup.submit')}
          </button>
          <button type="button" className="link" onClick={onSwitchToLogin} disabled={submitting}>
            {t('auth.signup.switchToLogin')}
          </button>
        </form>
      ) : (
        <div className="oauth-panel">
          <p>{t('auth.signup.oauthIntro').replace('{provider}', providerLabel)}</p>
          <button type="button" onClick={onOAuth}>
            {t('auth.signup.oauthCta').replace('{provider}', providerLabel)}
          </button>
          <button type="button" className="link" onClick={onSwitchToLogin}>
            {t('auth.signup.backToLogin')}
          </button>
        </div>
      )}
    </div>
  );
}
