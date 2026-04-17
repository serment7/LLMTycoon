/**
 * 회원가입 화면.
 * - ON_PREMISE=true: username/email/password 폼을 /api/auth/signup 으로 전송
 * - ON_PREMISE=false: OAuth 로 이동 (최초 로그인 시 자동 가입)
 */

import React, { useState } from 'react';

export interface SignupFormProps {
  onPremise: boolean;
  provider: 'github' | 'gitlab';
  onSubmit: (username: string, password: string, email: string) => Promise<void>;
  onOAuth: () => void;
  onSwitchToLogin: () => void;
  error?: string | null;
}

export function SignupForm({ onPremise, provider, onSubmit, onOAuth, onSwitchToLogin, error }: SignupFormProps) {
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

  const validate = (): string | null => {
    if (normalizedUsername.length < 3) return '아이디는 3자 이상이어야 합니다.';
    if (!/^[a-zA-Z0-9._-]+$/.test(normalizedUsername)) return '아이디는 영문/숫자/._- 만 사용할 수 있습니다.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return '이메일 형식이 올바르지 않습니다.';
    if (!pwHasLength) return '비밀번호는 8자 이상이어야 합니다.';
    if (!pwHasLetter || !pwHasDigit) return '비밀번호는 영문과 숫자를 모두 포함해야 합니다.';
    if (!pwMatches) return '비밀번호 확인이 일치하지 않습니다.';
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
      <h1>회원가입</h1>
      {(localError || error) && (
        <div className="auth-error" role="alert" aria-live="polite">
          {localError || error}
        </div>
      )}
      {onPremise ? (
        <form onSubmit={submit} noValidate aria-busy={submitting}>
          <label>
            아이디
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
            이메일
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
            비밀번호
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
              <li data-ok={pwHasLength}>8자 이상</li>
              <li data-ok={pwHasLetter && pwHasDigit}>영문과 숫자 포함</li>
            </ul>
          )}
          <label>
            비밀번호 확인
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
              {pwMatches ? '비밀번호가 일치합니다.' : '비밀번호가 일치하지 않습니다.'}
            </p>
          )}
          <button type="submit" disabled={submitting}>
            {submitting ? '가입 중…' : '계정 만들기'}
          </button>
          <button type="button" className="link" onClick={onSwitchToLogin} disabled={submitting}>
            이미 계정이 있어요
          </button>
        </form>
      ) : (
        <div className="oauth-panel">
          <p>{provider === 'gitlab' ? 'GitLab' : 'GitHub'} 계정으로 가입합니다. 최초 로그인 시 자동으로 계정이 만들어집니다.</p>
          <button type="button" onClick={onOAuth}>
            {provider === 'gitlab' ? 'GitLab' : 'GitHub'} 로 가입
          </button>
          <button type="button" className="link" onClick={onSwitchToLogin}>
            로그인으로 돌아가기
          </button>
        </div>
      )}
    </div>
  );
}
